//! C9: bounded SSH public-key inventory, create-only Ed25519 generation, public-key
//! disclosure, trash-backed removal, and device-local key memos.
//!
//! The adapter never opens a private-key file. Generation delegates to the official
//! `ssh-keygen` executable in a private staging directory and publishes with no-clobber
//! hard links, so an existing identity can never be replaced. Removal only *renames* the
//! pair into an owner-only trash directory directly under `~/.ssh`, so the private key is
//! moved without ever being opened and the user can restore it by moving it back. Memos are
//! device-local metadata and live in the app data directory (G7), never in `~/.ssh`.

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use base64::Engine as _;
use same_file::Handle as FileIdentity;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::clock::now_ms;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::ssh_endpoints::{command_policy_defaults, SshCommandPolicyDefaults, SshEndpointView};
use crate::user_home::home_dir;
use crate::CoreError;

const MAX_PUBLIC_KEY_BYTES: u64 = 16 * 1024;
const MAX_PUBLIC_KEY_FILES: usize = 512;
const MAX_FILE_NAME_CHARS: usize = 64;
const MAX_COMMENT_CHARS: usize = 120;
const MAX_NOTE_CHARS: usize = 300;
const MAX_NOTES: usize = 512;
const MAX_FINGERPRINT_CHARS: usize = 80;
const KEYGEN_TIMEOUT: Duration = Duration::from_secs(30);
/// 지운 키 쌍을 옮겨 두는 `~/.ssh` 직접 하위 폴더. 앱 데이터로 옮기면 개인키가
/// 앱 소유 저장소에 남으므로(G4·G7) 같은 파일시스템 안에서만 이름을 바꾼다.
const TRASH_DIR_NAME: &str = ".agent-manager-trash";

const NOTES_VERSION: u32 = 1;
/// 메모는 키에서 파생되지 않는 기기 단위 메타데이터이므로 앱 데이터에만 둔다(G7).
const NOTES_STORE: JsonStore = JsonStore {
    file: "ssh-key-notes-v1.json",
    lock_file: "ssh-key-notes-v1.lock",
    label: "SSH 키 메모 저장소",
    version: NOTES_VERSION,
};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyView {
    pub file_name: String,
    pub path: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub comment: Option<String>,
    pub has_private_key: bool,
    /// 사용자가 이 기기에 적어 둔 메모. 공개키 파일이 아니라 앱 데이터에서 온다(G7).
    pub note: Option<String>,
    /// 이 키로 붙는 접속 지점과 에이전트 사용 여부. 메모와 같은 기기 단위 설정이다(C9-9).
    pub endpoint: Option<SshEndpointView>,
}

/// 공개키 본문까지 함께 보여 주는 조회 결과. 개인키는 여전히 열지 않는다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshPublicKeyView {
    pub file_name: String,
    pub path: String,
    pub algorithm: String,
    pub fingerprint: String,
    pub comment: Option<String>,
    /// `~/.ssh/<이름>.pub`의 검증된 한 줄. 공개키라 비밀값이 아니다.
    pub public_key: String,
}

/// 삭제 결과. 되돌리려면 `trash_path`의 파일을 `~/.ssh`로 옮기면 된다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyDeletionReceipt {
    pub file_name: String,
    pub fingerprint: String,
    pub trash_path: String,
    pub private_key_moved: bool,
    pub note_removed: bool,
    pub endpoint_removed: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyIssue {
    pub path: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshKeysSnapshot {
    pub directory_path: String,
    pub directory_exists: bool,
    pub keygen_available: bool,
    pub keys: Vec<SshKeyView>,
    pub issues: Vec<SshKeyIssue>,
    /// 새 연결 서버에 채워 넣을 기본 명령 정책(C9-13). 화면과 스킬이 같은 목록을 보도록
    /// 백엔드가 소유한다.
    pub command_policy_defaults: SshCommandPolicyDefaults,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSshKeyRequest {
    pub file_name: String,
    #[serde(default)]
    pub comment: String,
}

/// 목록에서 고른 공개키 하나를 가리키는 요청. 지문을 함께 받아, 목록을 그린 뒤 파일이
/// 바뀌었으면 다른 키를 보여 주거나 지우는 일이 없게 한다(C9-6).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyRef {
    pub file_name: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSshKeyNoteRequest {
    pub fingerprint: String,
    #[serde(default)]
    pub note: String,
}

/// 앱 데이터에만 두는 지문별 메모 저장본(G7).
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SshKeyNoteStore {
    schema_version: u32,
    notes: BTreeMap<String, String>,
}

impl SchemaVersioned for SshKeyNoteStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

impl Default for SshKeyNoteStore {
    fn default() -> Self {
        Self {
            schema_version: NOTES_VERSION,
            notes: BTreeMap::new(),
        }
    }
}

pub fn get_ssh_keys(app_data_dir: &Path) -> Result<SshKeysSnapshot, CoreError> {
    get_ssh_keys_with(&home_dir()?, app_data_dir)
}

pub fn generate_ssh_key(request: GenerateSshKeyRequest) -> Result<SshKeyView, CoreError> {
    let executable = crate::providers::resolve_named_executable(&["ssh-keygen"])?;
    generate_ssh_key_with(&home_dir()?, &executable, request)
}

/// C9-6. 고른 공개키의 본문 한 줄을 그대로 보여 준다. 공개키만 열고 개인키는 존재
/// 여부조차 다시 보지 않는다.
pub fn read_ssh_public_key(request: SshKeyRef) -> Result<SshPublicKeyView, CoreError> {
    read_ssh_public_key_with_home(&home_dir()?, &request)
}

/// C9-7. 고른 키 쌍을 `~/.ssh/.agent-manager-trash/<삭제시각>-<uuid>/`로 옮긴다.
/// 개인키는 열지 않고 이름만 바꾸며, 사용자가 다시 옮기면 그대로 복구된다.
pub fn delete_ssh_key(
    app_data_dir: &Path,
    request: SshKeyRef,
) -> Result<SshKeyDeletionReceipt, CoreError> {
    delete_ssh_key_with_home(&home_dir()?, app_data_dir, &request)
}

/// C9-8. 지문에 묶인 기기 단위 메모를 저장한다. 빈 메모는 삭제다.
pub fn set_ssh_key_note(
    app_data_dir: &Path,
    request: SetSshKeyNoteRequest,
) -> Result<SshKeysSnapshot, CoreError> {
    set_ssh_key_note_with(&home_dir()?, app_data_dir, &request)
}

fn get_ssh_keys_with(home: &Path, app_data_dir: &Path) -> Result<SshKeysSnapshot, CoreError> {
    snapshot_with_metadata(home, app_data_dir)
}

/// 공개키 목록에 앱 데이터의 기기 단위 메타데이터(메모·엔드포인트)를 붙인 화면용 스냅샷.
pub(crate) fn snapshot_with_metadata(
    home: &Path,
    app_data_dir: &Path,
) -> Result<SshKeysSnapshot, CoreError> {
    let mut snapshot = get_ssh_keys_with_home(home)?;
    attach_notes(&mut snapshot, app_data_dir);
    crate::ssh_endpoints::attach_endpoints(&mut snapshot, app_data_dir);
    Ok(snapshot)
}

fn set_ssh_key_note_with(
    home: &Path,
    app_data_dir: &Path,
    request: &SetSshKeyNoteRequest,
) -> Result<SshKeysSnapshot, CoreError> {
    let fingerprint = validate_fingerprint(&request.fingerprint)?.to_owned();
    let note = validate_note(&request.note)?.to_owned();
    let mut snapshot = snapshot_with_metadata(home, app_data_dir)?;
    if !snapshot
        .keys
        .iter()
        .any(|key| key.fingerprint == fingerprint)
    {
        return Err(CoreError::NotFound(
            "메모를 붙일 공개키를 ~/.ssh에서 찾지 못했습니다".to_owned(),
        ));
    }
    NOTES_STORE.with_lock(app_data_dir, || {
        let mut store: SshKeyNoteStore = NOTES_STORE.load_unlocked(app_data_dir)?;
        if note.is_empty() {
            store.notes.remove(&fingerprint);
        } else {
            if !store.notes.contains_key(&fingerprint) && store.notes.len() >= MAX_NOTES {
                return Err(CoreError::TooLarge(MAX_NOTES as u64));
            }
            store.notes.insert(fingerprint.clone(), note.clone());
        }
        NOTES_STORE.save_unlocked(app_data_dir, &store)
    })?;
    attach_notes(&mut snapshot, app_data_dir);
    Ok(snapshot)
}

pub(crate) fn get_ssh_keys_with_home(home: &Path) -> Result<SshKeysSnapshot, CoreError> {
    let home = canonical_home(home)?;
    let requested_root = home.join(".ssh");
    let keygen_available = crate::providers::resolve_named_executable(&["ssh-keygen"]).is_ok();
    let Some(root) = existing_ssh_root(&home, &requested_root)? else {
        return Ok(SshKeysSnapshot {
            directory_path: requested_root.to_string_lossy().into_owned(),
            directory_exists: false,
            keygen_available,
            keys: Vec::new(),
            issues: Vec::new(),
            command_policy_defaults: command_policy_defaults(),
        });
    };

    let mut candidates = fs::read_dir(&root)?
        .take(MAX_PUBLIC_KEY_FILES + 1)
        .collect::<Result<Vec<_>, _>>()?;
    if candidates.len() > MAX_PUBLIC_KEY_FILES {
        return Err(CoreError::TooLarge(MAX_PUBLIC_KEY_FILES as u64));
    }
    candidates.sort_by_key(|entry| entry.file_name());

    let mut keys = Vec::new();
    let mut issues = Vec::new();
    for entry in candidates {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("pub") {
            continue;
        }
        match inspect_public_key(&root, &path) {
            Ok(key) => keys.push(key),
            Err(error) => issues.push(SshKeyIssue {
                path: path.to_string_lossy().into_owned(),
                message: error.to_string(),
            }),
        }
    }

    Ok(SshKeysSnapshot {
        directory_path: root.to_string_lossy().into_owned(),
        directory_exists: true,
        keygen_available,
        keys,
        issues,
        command_policy_defaults: command_policy_defaults(),
    })
}

/// 이미 확인한 메타데이터가 심볼릭 링크가 아닌 실제 디렉터리를 가리키는지 보고 정규화된
/// 경로를 돌려준다. 홈과 `~/.ssh` 양쪽이 안내 문구만 달리하고 같은 검사를 쓴다.
fn canonicalize_plain_directory(
    path: &Path,
    metadata: &fs::Metadata,
    symlink_message: &str,
    not_dir_message: &str,
) -> Result<PathBuf, CoreError> {
    if metadata.file_type().is_symlink() {
        return Err(CoreError::InvalidInput(symlink_message.to_owned()));
    }
    if !metadata.is_dir() {
        return Err(CoreError::InvalidInput(not_dir_message.to_owned()));
    }
    Ok(fs::canonicalize(path)?)
}

fn existing_ssh_root(home: &Path, requested: &Path) -> Result<Option<PathBuf>, CoreError> {
    let metadata = match fs::symlink_metadata(requested) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let root = canonicalize_plain_directory(
        requested,
        &metadata,
        "~/.ssh가 심볼릭 링크여서 사용할 수 없습니다 (C9-1)",
        "~/.ssh 경로가 디렉터리가 아닙니다",
    )?;
    if root.parent() != Some(home) {
        return Err(CoreError::InvalidInput(
            "SSH 키 폴더가 사용자 홈의 직접 하위가 아닙니다 (C9-1)".to_owned(),
        ));
    }
    Ok(Some(root))
}

fn ensure_ssh_root(home: &Path) -> Result<PathBuf, CoreError> {
    let home = canonical_home(home)?;
    let requested = home.join(".ssh");
    if let Some(root) = existing_ssh_root(&home, &requested)? {
        return Ok(root);
    }

    fs::create_dir(&requested)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&requested, fs::Permissions::from_mode(0o700))?;
    }
    existing_ssh_root(&home, &requested)?.ok_or_else(|| {
        CoreError::Runtime("SSH 키 폴더를 만든 뒤 다시 확인하지 못했습니다".to_owned())
    })
}

fn canonical_home(home: &Path) -> Result<PathBuf, CoreError> {
    let metadata = fs::symlink_metadata(home)?;
    canonicalize_plain_directory(
        home,
        &metadata,
        "사용자 홈 경로가 심볼릭 링크여서 SSH 키를 사용할 수 없습니다 (C9-4)",
        "사용자 홈 경로가 디렉터리가 아닙니다",
    )
}

/// 공개키 파일 하나를 경계 안에서 읽어 검증된 한 줄로 돌려준다. 개인키는 열지 않는다.
fn read_public_key_line(root: &Path, path: &Path) -> Result<String, CoreError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "일반 공개키 파일이 아닙니다 (C9-1)".to_owned(),
        ));
    }
    if metadata.len() > MAX_PUBLIC_KEY_BYTES {
        return Err(CoreError::TooLarge(MAX_PUBLIC_KEY_BYTES));
    }
    if path.parent() != Some(root) {
        return Err(CoreError::InvalidInput(
            "공개키가 ~/.ssh 직접 하위가 아닙니다 (C9-1)".to_owned(),
        ));
    }

    let file = open_public_key_no_follow(path)?;
    let opened_metadata = file.metadata()?;
    if !opened_metadata.is_file() || opened_metadata.len() != metadata.len() {
        return Err(CoreError::InvalidInput(
            "검사 중 공개키 파일이 바뀌어 읽지 않았습니다 (C9-1)".to_owned(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PUBLIC_KEY_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PUBLIC_KEY_BYTES {
        return Err(CoreError::TooLarge(MAX_PUBLIC_KEY_BYTES));
    }
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| CoreError::InvalidInput("공개키가 UTF-8 텍스트가 아닙니다".to_owned()))?;
    Ok(text.trim().to_owned())
}

/// 같은 이름 개인키 자리의 상태. 일반 파일이 아니면 쌍으로 다루지 않는다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PrivateKeyState {
    Present,
    Absent,
    Unusable,
}

fn private_key_state(path: &Path) -> Result<PrivateKeyState, CoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Ok(PrivateKeyState::Unusable)
        }
        Ok(_) => Ok(PrivateKeyState::Present),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PrivateKeyState::Absent),
        Err(error) => Err(error.into()),
    }
}

/// 같은 이름 개인키가 쓸 수 있는 일반 파일로 있는지. 파일은 열지 않고 metadata만 본다.
pub(crate) fn private_key_present(path: &Path) -> Result<bool, CoreError> {
    Ok(private_key_state(path)? == PrivateKeyState::Present)
}

fn inspect_public_key(root: &Path, path: &Path) -> Result<SshKeyView, CoreError> {
    let text = read_public_key_line(root, path)?;
    let parsed = parse_public_key(&text)?;

    let private_path = path.with_extension("");
    let has_private_key = private_key_state(&private_path)? == PrivateKeyState::Present;

    Ok(SshKeyView {
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                CoreError::InvalidInput("공개키 파일 이름이 UTF-8이 아닙니다".to_owned())
            })?
            .to_owned(),
        path: path.to_string_lossy().into_owned(),
        algorithm: display_algorithm(&parsed.key_type),
        fingerprint: parsed.fingerprint,
        comment: parsed.comment,
        has_private_key,
        note: None,
        endpoint: None,
    })
}

#[cfg(unix)]
fn open_public_key_no_follow(path: &Path) -> Result<File, CoreError> {
    use std::os::unix::fs::OpenOptionsExt;

    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?)
}

#[cfg(windows)]
fn open_public_key_no_follow(path: &Path) -> Result<File, CoreError> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

    Ok(OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?)
}

#[cfg(not(any(unix, windows)))]
fn open_public_key_no_follow(path: &Path) -> Result<File, CoreError> {
    Ok(OpenOptions::new().read(true).open(path)?)
}

struct ParsedPublicKey {
    key_type: String,
    fingerprint: String,
    comment: Option<String>,
}

fn parse_public_key(text: &str) -> Result<ParsedPublicKey, CoreError> {
    let line = text.trim();
    if line.is_empty() || line.contains(['\n', '\r']) {
        return Err(CoreError::InvalidInput(
            "공개키는 비어 있지 않은 한 줄이어야 합니다".to_owned(),
        ));
    }
    let mut fields = line.split_whitespace();
    let key_type = fields
        .next()
        .ok_or_else(|| CoreError::InvalidInput("공개키 알고리즘이 없습니다".to_owned()))?;
    let encoded = fields
        .next()
        .ok_or_else(|| CoreError::InvalidInput("공개키 데이터가 없습니다".to_owned()))?;
    if !valid_key_type(key_type) {
        return Err(CoreError::InvalidInput(
            "지원하지 않는 OpenSSH 공개키 알고리즘입니다".to_owned(),
        ));
    }
    let blob = STANDARD.decode(encoded).map_err(|_| {
        CoreError::InvalidInput("공개키 base64 데이터가 올바르지 않습니다".to_owned())
    })?;
    validate_public_blob(&blob, key_type)?;
    let comment = fields.collect::<Vec<_>>().join(" ");
    let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&blob)));
    Ok(ParsedPublicKey {
        key_type: key_type.to_owned(),
        fingerprint,
        comment: (!comment.is_empty()).then_some(comment),
    })
}

fn validate_public_blob(blob: &[u8], expected: &str) -> Result<(), CoreError> {
    let mut reader = BlobReader::new(blob);
    let algorithm = reader.read_utf8("알고리즘")?;
    if algorithm != expected {
        return Err(CoreError::InvalidInput(
            "공개키 표기 알고리즘과 blob 알고리즘이 다릅니다".to_owned(),
        ));
    }
    match expected {
        "ssh-ed25519" => reader.read_exact_string(32, "Ed25519 키")?,
        "ssh-rsa" => {
            reader.read_non_empty_string("RSA 지수")?;
            reader.read_non_empty_string("RSA modulus")?;
        }
        "ssh-dss" => {
            for label in ["DSA p", "DSA q", "DSA g", "DSA y"] {
                reader.read_non_empty_string(label)?;
            }
        }
        "ecdsa-sha2-nistp256" => reader.read_ecdsa("nistp256", 65)?,
        "ecdsa-sha2-nistp384" => reader.read_ecdsa("nistp384", 97)?,
        "ecdsa-sha2-nistp521" => reader.read_ecdsa("nistp521", 133)?,
        "sk-ssh-ed25519@openssh.com" => {
            reader.read_exact_string(32, "FIDO Ed25519 키")?;
            reader.read_non_empty_string("FIDO application")?;
        }
        "sk-ecdsa-sha2-nistp256@openssh.com" => {
            reader.read_ecdsa("nistp256", 65)?;
            reader.read_non_empty_string("FIDO application")?;
        }
        _ => {
            return Err(CoreError::InvalidInput(
                "아직 검증할 수 없는 OpenSSH 공개키 알고리즘입니다".to_owned(),
            ))
        }
    }
    reader.finish()
}

fn valid_key_type(value: &str) -> bool {
    matches!(
        value,
        "ssh-ed25519"
            | "ssh-rsa"
            | "ssh-dss"
            | "ecdsa-sha2-nistp256"
            | "ecdsa-sha2-nistp384"
            | "ecdsa-sha2-nistp521"
            | "sk-ssh-ed25519@openssh.com"
            | "sk-ecdsa-sha2-nistp256@openssh.com"
    )
}

struct BlobReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> BlobReader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn read_string(&mut self, label: &str) -> Result<&'a [u8], CoreError> {
        let header_end = self.position.checked_add(4).ok_or_else(blob_error)?;
        let length = self
            .bytes
            .get(self.position..header_end)
            .and_then(|bytes| <[u8; 4]>::try_from(bytes).ok())
            .map(u32::from_be_bytes)
            .ok_or_else(blob_error)? as usize;
        let end = header_end.checked_add(length).ok_or_else(blob_error)?;
        let value = self.bytes.get(header_end..end).ok_or_else(|| {
            CoreError::InvalidInput(format!("OpenSSH 공개키의 {label} 영역이 잘렸습니다"))
        })?;
        self.position = end;
        Ok(value)
    }

    fn read_utf8(&mut self, label: &str) -> Result<&'a str, CoreError> {
        std::str::from_utf8(self.read_string(label)?).map_err(|_| {
            CoreError::InvalidInput(format!("OpenSSH 공개키의 {label}이 UTF-8이 아닙니다"))
        })
    }

    fn read_non_empty_string(&mut self, label: &str) -> Result<&'a [u8], CoreError> {
        let value = self.read_string(label)?;
        if value.is_empty() {
            return Err(CoreError::InvalidInput(format!(
                "OpenSSH 공개키의 {label}이 비어 있습니다"
            )));
        }
        Ok(value)
    }

    fn read_exact_string(&mut self, expected: usize, label: &str) -> Result<(), CoreError> {
        if self.read_string(label)?.len() != expected {
            return Err(CoreError::InvalidInput(format!(
                "OpenSSH 공개키의 {label} 길이가 올바르지 않습니다"
            )));
        }
        Ok(())
    }

    fn read_ecdsa(&mut self, curve: &str, point_size: usize) -> Result<(), CoreError> {
        if self.read_utf8("ECDSA curve")? != curve {
            return Err(CoreError::InvalidInput(
                "OpenSSH ECDSA curve가 알고리즘과 다릅니다".to_owned(),
            ));
        }
        let point = self.read_string("ECDSA point")?;
        if point.len() != point_size || point.first() != Some(&4) {
            return Err(CoreError::InvalidInput(
                "OpenSSH ECDSA point가 올바르지 않습니다".to_owned(),
            ));
        }
        Ok(())
    }

    fn finish(self) -> Result<(), CoreError> {
        if self.position != self.bytes.len() {
            return Err(CoreError::InvalidInput(
                "OpenSSH 공개키 blob 뒤에 예상하지 않은 데이터가 있습니다".to_owned(),
            ));
        }
        Ok(())
    }
}

fn blob_error() -> CoreError {
    CoreError::InvalidInput("OpenSSH 공개키 blob이 손상되었습니다".to_owned())
}

fn display_algorithm(value: &str) -> String {
    match value {
        "ssh-ed25519" => "ED25519".to_owned(),
        "ssh-rsa" => "RSA".to_owned(),
        value if value.starts_with("ecdsa-") => "ECDSA".to_owned(),
        value if value.starts_with("sk-") => format!("FIDO {value}"),
        value => value.to_owned(),
    }
}

fn generate_ssh_key_with(
    home: &Path,
    executable: &Path,
    request: GenerateSshKeyRequest,
) -> Result<SshKeyView, CoreError> {
    let file_name = validate_file_name(&request.file_name)?;
    let comment = validate_comment(&request.comment)?;
    let root = ensure_ssh_root(home)?;
    let private_target = root.join(file_name);
    let public_target = root.join(format!("{file_name}.pub"));
    ensure_absent(&private_target)?;
    ensure_absent(&public_target)?;

    let requested_stage_dir = root.join(format!(".agent-manager-key-{}", Uuid::new_v4()));
    fs::create_dir(&requested_stage_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) =
            fs::set_permissions(&requested_stage_dir, fs::Permissions::from_mode(0o700))
        {
            let _ = fs::remove_dir(&requested_stage_dir);
            return Err(error.into());
        }
    }
    let stage_dir = match fs::canonicalize(&requested_stage_dir) {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir(&requested_stage_dir);
            return Err(error.into());
        }
    };
    if stage_dir.parent() != Some(root.as_path()) {
        let _ = fs::remove_dir(&stage_dir);
        return Err(CoreError::InvalidInput(
            "SSH 키 staging 폴더가 ~/.ssh를 벗어났습니다 (C9-4)".to_owned(),
        ));
    }
    let stage_private = stage_dir.join("key");
    let stage_public = stage_dir.join("key.pub");
    let mut published_public_identity = None;

    let result = (|| {
        let mut child = Command::new(executable)
            .args(["-q", "-t", "ed25519", "-a", "64", "-N", "", "-C"])
            .arg(comment)
            .arg("-f")
            .arg(&stage_private)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| CoreError::Runtime("ssh-keygen을 시작하지 못했습니다".to_owned()))?;
        let status = wait_for_child(&mut child, KEYGEN_TIMEOUT)?;
        if !status.success() {
            return Err(CoreError::Runtime(
                "ssh-keygen이 새 Ed25519 키를 만들지 못했습니다".to_owned(),
            ));
        }

        validate_generated_file(&stage_private)?;
        validate_generated_file(&stage_public)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&stage_private, fs::Permissions::from_mode(0o600))?;
        }
        let parsed = inspect_public_key(&stage_dir, &stage_public)?;
        let public_identity = FileIdentity::from_path(&stage_public)?;

        ensure_absent(&public_target)?;
        ensure_absent(&private_target)?;
        fs::hard_link(&stage_public, &public_target).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                CoreError::Conflict("같은 이름의 SSH 공개키가 이미 있습니다".to_owned())
            } else {
                error.into()
            }
        })?;
        published_public_identity = Some(public_identity);
        if let Err(error) = fs::hard_link(&stage_private, &private_target) {
            rollback_public_link(&public_target, published_public_identity.as_ref())?;
            return Err(if error.kind() == std::io::ErrorKind::AlreadyExists {
                CoreError::Conflict("같은 이름의 SSH 개인키가 이미 있습니다".to_owned())
            } else {
                error.into()
            });
        }

        Ok(SshKeyView {
            file_name: format!("{file_name}.pub"),
            path: public_target.to_string_lossy().into_owned(),
            algorithm: parsed.algorithm,
            fingerprint: parsed.fingerprint,
            comment: parsed.comment,
            has_private_key: true,
            note: None,
            endpoint: None,
        })
    })();

    let cleanup = cleanup_stage(&stage_private, &stage_public, &stage_dir);
    match (result, cleanup) {
        (Ok(view), Ok(())) => Ok(view),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(_)) => Err(CoreError::Runtime(
            "SSH 키 쌍은 생성했지만 비공개 staging 파일을 정리하지 못했습니다. ~/.ssh의 .agent-manager-key-* 항목을 확인해 주세요".to_owned(),
        )),
        (Err(_), Err(_)) => Err(CoreError::Runtime(
            "SSH 키 생성 실패 후 비공개 staging 파일도 정리하지 못했습니다. ~/.ssh의 .agent-manager-key-* 항목을 확인해 주세요".to_owned(),
        )),
    }
}

/// 요청이 가리키는 공개키를 `~/.ssh` 안에서만 찾아 검증한다. 지문이 어긋나면 목록을
/// 그린 뒤 파일이 바뀐 것이므로 아무것도 하지 않는다(C9-6).
pub(crate) fn resolve_public_key(
    home: &Path,
    request: &SshKeyRef,
) -> Result<(PathBuf, PathBuf, SshKeyView), CoreError> {
    let home = canonical_home(home)?;
    let requested_root = home.join(".ssh");
    let root = existing_ssh_root(&home, &requested_root)?
        .ok_or_else(|| CoreError::NotFound("~/.ssh 폴더가 없습니다".to_owned()))?;
    let file_name = validate_public_file_name(&request.file_name)?;
    let fingerprint = validate_fingerprint(&request.fingerprint)?;
    let path = root.join(file_name);
    let view = inspect_public_key(&root, &path)?;
    if view.fingerprint != fingerprint {
        return Err(CoreError::Conflict(
            "화면에 보이던 공개키와 지문이 달라 그대로 두었습니다. 목록을 새로 고친 뒤 다시 시도하세요".to_owned(),
        ));
    }
    Ok((root, path, view))
}

fn read_ssh_public_key_with_home(
    home: &Path,
    request: &SshKeyRef,
) -> Result<SshPublicKeyView, CoreError> {
    let (root, path, view) = resolve_public_key(home, request)?;
    let public_key = read_public_key_line(&root, &path)?;
    let parsed = parse_public_key(&public_key)?;
    if parsed.fingerprint != view.fingerprint {
        return Err(CoreError::Conflict(
            "읽는 사이 공개키 파일이 바뀌어 내용을 보여 주지 않았습니다".to_owned(),
        ));
    }
    Ok(SshPublicKeyView {
        file_name: view.file_name,
        path: view.path,
        algorithm: view.algorithm,
        fingerprint: view.fingerprint,
        comment: view.comment,
        public_key,
    })
}

fn delete_ssh_key_with_home(
    home: &Path,
    app_data_dir: &Path,
    request: &SshKeyRef,
) -> Result<SshKeyDeletionReceipt, CoreError> {
    let (root, public_path, view) = resolve_public_key(home, request)?;
    let public_name = view.file_name.clone();
    let private_path = public_path.with_extension("");
    let private_name = private_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            CoreError::InvalidInput("개인키 파일 이름을 확인하지 못했습니다".to_owned())
        })?
        .to_owned();
    let private_state = private_key_state(&private_path)?;
    if private_state == PrivateKeyState::Unusable {
        return Err(CoreError::Conflict(
            "같은 이름의 개인키 자리가 일반 파일이 아니어서 지우지 않았습니다 (C9-7)".to_owned(),
        ));
    }

    let entry = create_trash_entry(&root)?;
    let public_target = entry.join(&public_name);
    if let Err(error) = fs::rename(&public_path, &public_target) {
        let _ = fs::remove_dir(&entry);
        return Err(error.into());
    }
    if private_state == PrivateKeyState::Present {
        let private_target = entry.join(&private_name);
        if let Err(error) = fs::rename(&private_path, &private_target) {
            // 반쪽만 옮긴 상태로 두지 않는다. 공개키를 제자리로 되돌리고 접는다.
            let _ = fs::rename(&public_target, &public_path);
            let _ = fs::remove_dir(&entry);
            return Err(error.into());
        }
    }

    // 키가 사라진 뒤의 메모는 가리킬 대상이 없다. 이미 파일은 옮겨졌으므로 메모를
    // 지우지 못한 것으로 삭제 자체를 실패로 만들지는 않는다.
    let note_removed = remove_note(app_data_dir, &view.fingerprint).unwrap_or(false);
    let endpoint_removed =
        crate::ssh_endpoints::remove_endpoint(app_data_dir, &view.fingerprint).unwrap_or(false);

    Ok(SshKeyDeletionReceipt {
        file_name: public_name,
        fingerprint: view.fingerprint,
        trash_path: entry.to_string_lossy().into_owned(),
        private_key_moved: private_state == PrivateKeyState::Present,
        note_removed,
        endpoint_removed,
    })
}

/// `~/.ssh/.agent-manager-trash/<삭제시각>-<uuid>/`를 소유자 전용으로 만든다.
fn create_trash_entry(root: &Path) -> Result<PathBuf, CoreError> {
    let trash_root = ensure_trash_root(root)?;
    let requested = trash_root.join(format!("{}-{}", now_ms(), Uuid::new_v4().simple()));
    fs::create_dir(&requested)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = fs::set_permissions(&requested, fs::Permissions::from_mode(0o700)) {
            let _ = fs::remove_dir(&requested);
            return Err(error.into());
        }
    }
    let entry = match fs::canonicalize(&requested) {
        Ok(path) => path,
        Err(error) => {
            let _ = fs::remove_dir(&requested);
            return Err(error.into());
        }
    };
    if entry.parent() != Some(trash_root.as_path()) {
        let _ = fs::remove_dir(&entry);
        return Err(CoreError::InvalidInput(
            "SSH 휴지통 항목이 휴지통 폴더를 벗어났습니다 (C9-7)".to_owned(),
        ));
    }
    Ok(entry)
}

fn ensure_trash_root(root: &Path) -> Result<PathBuf, CoreError> {
    let requested = root.join(TRASH_DIR_NAME);
    match fs::symlink_metadata(&requested) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(CoreError::InvalidInput(
                    "SSH 휴지통 경로가 일반 디렉터리가 아닙니다 (C9-7)".to_owned(),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&requested)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&requested, fs::Permissions::from_mode(0o700))?;
            }
        }
        Err(error) => return Err(error.into()),
    }
    let trash_root = fs::canonicalize(&requested)?;
    if trash_root.parent() != Some(root) {
        return Err(CoreError::InvalidInput(
            "SSH 휴지통이 ~/.ssh 직접 하위가 아닙니다 (C9-7)".to_owned(),
        ));
    }
    Ok(trash_root)
}

/// 앱 데이터의 메모를 지문으로 이어 붙인다. 메모를 읽지 못해도 키 목록 자체는
/// 보여 줘야 하므로 실패는 issues로만 알린다.
fn attach_notes(snapshot: &mut SshKeysSnapshot, app_data_dir: &Path) {
    match load_notes(app_data_dir) {
        Ok(mut notes) => {
            for key in &mut snapshot.keys {
                key.note = notes.remove(&key.fingerprint);
            }
        }
        Err(error) => snapshot.issues.push(SshKeyIssue {
            path: NOTES_STORE
                .path(app_data_dir)
                .to_string_lossy()
                .into_owned(),
            message: format!("SSH 키 메모를 읽지 못해 메모 없이 표시합니다: {error}"),
        }),
    }
}

fn load_notes(app_data_dir: &Path) -> Result<BTreeMap<String, String>, CoreError> {
    NOTES_STORE.with_lock(app_data_dir, || {
        let store: SshKeyNoteStore = NOTES_STORE.load_unlocked(app_data_dir)?;
        Ok(store.notes)
    })
}

fn remove_note(app_data_dir: &Path, fingerprint: &str) -> Result<bool, CoreError> {
    NOTES_STORE.with_lock(app_data_dir, || {
        let mut store: SshKeyNoteStore = NOTES_STORE.load_unlocked(app_data_dir)?;
        if store.notes.remove(fingerprint).is_none() {
            return Ok(false);
        }
        NOTES_STORE.save_unlocked(app_data_dir, &store)?;
        Ok(true)
    })
}

/// 키 파일 이름 본체(확장자를 뗀 부분)가 `~/.ssh` 직접 하위에서 허용된 모양인지 본다.
/// 영문·숫자로 시작하는 64자 이하의 영문·숫자·점·밑줄·하이픈만 통과하므로 경로
/// 구분자와 `..`는 여기서 걸린다.
fn is_allowed_key_file_stem(stem: &str) -> bool {
    let mut rest = stem.chars();
    rest.next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && stem.chars().count() <= MAX_FILE_NAME_CHARS
        && rest.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
}

/// 제어문자 없는 한 줄 텍스트인지 본다. 메모와 설명이 길이 상한과 안내 문구만 달리하고
/// 같은 검사를 쓴다.
fn validate_single_line<'a>(
    value: &'a str,
    max_chars: usize,
    message: &str,
) -> Result<&'a str, CoreError> {
    let value = value.trim();
    if value.chars().count() > max_chars || value.chars().any(|character| character.is_control()) {
        return Err(CoreError::InvalidInput(message.to_owned()));
    }
    Ok(value)
}

/// 목록이 돌려준 `*.pub` 이름만 받는다.
fn validate_public_file_name(value: &str) -> Result<&str, CoreError> {
    let stem = value.strip_suffix(".pub").ok_or_else(|| {
        CoreError::InvalidInput("공개키 파일 이름은 .pub으로 끝나야 합니다".to_owned())
    })?;
    if !is_allowed_key_file_stem(stem) {
        return Err(CoreError::InvalidInput(
            "SSH 공개키 파일 이름이 ~/.ssh 직접 하위의 허용된 이름이 아닙니다".to_owned(),
        ));
    }
    Ok(value)
}

pub(crate) fn validate_fingerprint(value: &str) -> Result<&str, CoreError> {
    let value = value.trim();
    let body = value
        .strip_prefix("SHA256:")
        .filter(|body| !body.is_empty())
        .ok_or_else(|| {
            CoreError::InvalidInput("SSH 키 지문은 SHA256:으로 시작해야 합니다".to_owned())
        })?;
    if value.chars().count() > MAX_FINGERPRINT_CHARS
        || !body
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '/'))
    {
        return Err(CoreError::InvalidInput(
            "SSH 키 지문 형식이 올바르지 않습니다".to_owned(),
        ));
    }
    Ok(value)
}

fn validate_note(value: &str) -> Result<&str, CoreError> {
    validate_single_line(
        value,
        MAX_NOTE_CHARS,
        "SSH 키 메모는 제어문자 없이 300자 이하여야 합니다",
    )
}

fn validate_file_name(value: &str) -> Result<&str, CoreError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(CoreError::InvalidInput(
            "SSH 키 파일 이름을 입력해야 합니다".to_owned(),
        ));
    }
    let valid = is_allowed_key_file_stem(value);
    let lower = value.to_ascii_lowercase();
    let reserved = matches!(
        lower.as_str(),
        "authorized_keys" | "authorized_keys2" | "known_hosts" | "config" | "environment"
    );
    if !valid || reserved || lower.ends_with(".pub") {
        return Err(CoreError::InvalidInput(
            "SSH 키 파일 이름은 영문·숫자로 시작하는 64자 이하의 영문·숫자·점·밑줄·하이픈이어야 하며 .pub 또는 SSH 설정 파일 이름은 사용할 수 없습니다".to_owned(),
        ));
    }
    Ok(value)
}

fn validate_comment(value: &str) -> Result<&str, CoreError> {
    validate_single_line(
        value,
        MAX_COMMENT_CHARS,
        "SSH 키 설명은 제어문자 없이 120자 이하여야 합니다",
    )
}

fn ensure_absent(path: &Path) -> Result<(), CoreError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(CoreError::Conflict(format!(
            "기존 SSH 파일은 덮어쓸 수 없습니다: {}",
            path.display()
        ))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn validate_generated_file(path: &Path) -> Result<(), CoreError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CoreError::Runtime(
            "ssh-keygen이 일반 키 파일을 만들지 않았습니다".to_owned(),
        ));
    }
    Ok(())
}

fn wait_for_child(child: &mut Child, timeout: Duration) -> Result<ExitStatus, CoreError> {
    let started = Instant::now();
    loop {
        match child.try_wait()? {
            Some(status) => return Ok(status),
            None if started.elapsed() < timeout => thread::sleep(Duration::from_millis(50)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CoreError::Runtime(
                    "ssh-keygen 실행이 30초를 넘어 중단했습니다".to_owned(),
                ));
            }
        }
    }
}

fn rollback_public_link(target: &Path, expected: Option<&FileIdentity>) -> Result<(), CoreError> {
    let Some(expected) = expected else {
        return Err(CoreError::Runtime(
            "생성한 SSH 공개키 링크의 식별자가 없습니다".to_owned(),
        ));
    };
    let current = FileIdentity::from_path(target).map_err(|_| {
        CoreError::Runtime("생성한 SSH 공개키 링크를 다시 확인하지 못했습니다".to_owned())
    })?;
    if &current != expected {
        return Err(CoreError::Conflict(
            "SSH 공개키 링크가 생성 도중 다른 파일로 바뀌어 삭제하지 않았습니다".to_owned(),
        ));
    }
    fs::remove_file(target)?;
    Ok(())
}

fn cleanup_stage(private: &Path, public: &Path, directory: &Path) -> Result<(), CoreError> {
    let mut first_error = None;
    for path in [public, private] {
        if let Err(error) = fs::remove_file(path) {
            if error.kind() != std::io::ErrorKind::NotFound && first_error.is_none() {
                first_error = Some(error);
            }
        }
    }
    if let Err(error) = fs::remove_dir(directory) {
        if error.kind() != std::io::ErrorKind::NotFound && first_error.is_none() {
            first_error = Some(error);
        }
    }
    match first_error {
        Some(error) => Err(error.into()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public_key_line(key_type: &str, comment: &str) -> String {
        let mut blob = Vec::new();
        blob.extend_from_slice(&(key_type.len() as u32).to_be_bytes());
        blob.extend_from_slice(key_type.as_bytes());
        blob.extend_from_slice(&32u32.to_be_bytes());
        blob.extend_from_slice(&[7; 32]);
        format!("{key_type} {} {comment}\n", STANDARD.encode(blob))
    }

    #[test]
    fn c9_inventory_derives_public_metadata_without_opening_private_key() {
        let home = tempfile::tempdir().expect("home");
        let root = home.path().join(".ssh");
        fs::create_dir(&root).expect("ssh root");
        fs::write(
            root.join("id_example.pub"),
            public_key_line("ssh-ed25519", "developer@example"),
        )
        .expect("public");
        fs::write(
            root.join("id_example"),
            b"private material must stay unread",
        )
        .expect("private");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.join("id_example"), fs::Permissions::from_mode(0o000))
                .expect("permissions");
        }

        let snapshot = get_ssh_keys_with_home(home.path()).expect("inventory");
        assert_eq!(snapshot.keys.len(), 1);
        let key = &snapshot.keys[0];
        assert_eq!(key.file_name, "id_example.pub");
        assert_eq!(key.algorithm, "ED25519");
        assert!(key.fingerprint.starts_with("SHA256:"));
        assert_eq!(key.comment.as_deref(), Some("developer@example"));
        assert!(key.has_private_key);
    }

    #[test]
    fn c9_public_text_algorithm_must_match_the_blob() {
        let line = public_key_line("ssh-ed25519", "example").replacen("ssh-ed25519", "ssh-rsa", 1);
        assert!(parse_public_key(&line).is_err());
    }

    #[test]
    fn c9_public_blob_rejects_truncated_and_trailing_key_bodies() {
        let valid = public_key_line("ssh-ed25519", "example");
        let encoded = valid.split_whitespace().nth(1).unwrap();
        let mut blob = STANDARD.decode(encoded).unwrap();
        blob.pop();
        assert!(parse_public_key(&format!("ssh-ed25519 {}", STANDARD.encode(&blob))).is_err());

        let mut blob = STANDARD.decode(encoded).unwrap();
        blob.push(99);
        assert!(parse_public_key(&format!("ssh-ed25519 {}", STANDARD.encode(&blob))).is_err());
    }

    #[test]
    fn c9_generation_names_refuse_traversal_reserved_and_public_suffixes() {
        for invalid in [
            "../id",
            ".hidden",
            "authorized_keys",
            "known_hosts",
            "id.pub",
            "한글",
        ] {
            assert!(validate_file_name(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            validate_file_name("id_agent-manager.1").unwrap(),
            "id_agent-manager.1"
        );
    }

    #[cfg(unix)]
    #[test]
    fn c9_inventory_refuses_symlinked_public_keys() {
        use std::os::unix::fs::symlink;

        let home = tempfile::tempdir().expect("home");
        let root = home.path().join(".ssh");
        fs::create_dir(&root).expect("ssh root");
        let outside = home.path().join("outside.pub");
        fs::write(&outside, public_key_line("ssh-ed25519", "outside")).expect("outside");
        symlink(&outside, root.join("linked.pub")).expect("symlink");

        let snapshot = get_ssh_keys_with_home(home.path()).expect("inventory");
        assert!(snapshot.keys.is_empty());
        assert_eq!(snapshot.issues.len(), 1);
        assert!(snapshot.issues[0].message.contains("C9-1"));
    }

    #[cfg(unix)]
    #[test]
    fn c9_inventory_refuses_a_symlinked_home_root() {
        use std::os::unix::fs::symlink;

        let actual = tempfile::tempdir().expect("actual home");
        let parent = tempfile::tempdir().expect("parent");
        let linked = parent.path().join("linked-home");
        symlink(actual.path(), &linked).expect("home symlink");
        assert!(get_ssh_keys_with_home(&linked).is_err());
    }

    #[test]
    fn c9_rollback_removes_only_the_public_link_created_by_this_request() {
        let root = tempfile::tempdir().expect("root");
        let stage = root.path().join("stage.pub");
        let target = root.path().join("target.pub");
        fs::write(&stage, public_key_line("ssh-ed25519", "stage")).expect("stage");
        let identity = FileIdentity::from_path(&stage).expect("identity");
        fs::hard_link(&stage, &target).expect("publish");
        rollback_public_link(&target, Some(&identity)).expect("rollback");
        assert!(!target.exists());

        fs::write(&target, public_key_line("ssh-ed25519", "replacement")).expect("replacement");
        assert!(rollback_public_link(&target, Some(&identity)).is_err());
        assert!(target.exists(), "a replacement must never be deleted");
    }

    #[test]
    fn c9_cleanup_reports_an_incomplete_staging_directory() {
        let root = tempfile::tempdir().expect("root");
        let stage = root.path().join("stage");
        fs::create_dir(&stage).expect("stage");
        fs::write(stage.join("unexpected"), b"keep").expect("unexpected");
        assert!(cleanup_stage(&stage.join("key"), &stage.join("key.pub"), &stage).is_err());
        assert!(stage.exists());
    }

    #[cfg(unix)]
    #[test]
    fn c9_generation_publishes_both_files_and_never_overwrites() {
        use std::os::unix::fs::PermissionsExt;

        let home = tempfile::tempdir().expect("home");
        let fake = home.path().join("ssh-keygen");
        let encoded = public_key_line("ssh-ed25519", "fixture")
            .split_whitespace()
            .nth(1)
            .unwrap()
            .to_owned();
        fs::write(
            &fake,
            format!(
                "#!/bin/sh\ntarget=''\ncomment=''\nwhile [ \"$#\" -gt 0 ]; do\n  case \"$1\" in\n    -f) shift; target=$1 ;;\n    -C) shift; comment=$1 ;;\n  esac\n  shift\ndone\nprintf 'PRIVATE\\n' > \"$target\"\nprintf 'ssh-ed25519 {encoded} %s\\n' \"$comment\" > \"$target.pub\"\n"
            ),
        )
        .expect("fake executable");
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o700)).expect("executable");

        let request = GenerateSshKeyRequest {
            file_name: "id_created".to_owned(),
            comment: "created@example".to_owned(),
        };
        let created = generate_ssh_key_with(home.path(), &fake, request.clone()).expect("create");
        assert_eq!(created.file_name, "id_created.pub");
        assert!(created.has_private_key);
        assert!(home.path().join(".ssh/id_created").is_file());
        assert!(home.path().join(".ssh/id_created.pub").is_file());
        assert!(generate_ssh_key_with(home.path(), &fake, request).is_err());
        assert_eq!(
            fs::read(home.path().join(".ssh/id_created")).unwrap(),
            b"PRIVATE\n"
        );
        assert!(fs::read_dir(home.path().join(".ssh"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".agent-manager-key-")));
    }

    /// C9-6. 본문 공개는 목록이 보여 준 그 키에만 해당한다. 지문이 어긋나면 아무것도
    /// 돌려주지 않아, 목록을 그린 뒤 바뀐 파일을 대신 보여 주는 일이 없다.
    #[test]
    fn c9_public_body_is_disclosed_only_for_the_matching_fingerprint() {
        let home = tempfile::tempdir().expect("home");
        let root = home.path().join(".ssh");
        fs::create_dir(&root).expect("ssh root");
        let line = public_key_line("ssh-ed25519", "developer@example");
        fs::write(root.join("id_example.pub"), &line).expect("public");

        let snapshot = get_ssh_keys_with_home(home.path()).expect("inventory");
        let fingerprint = snapshot.keys[0].fingerprint.clone();
        let view = read_ssh_public_key_with_home(
            home.path(),
            &SshKeyRef {
                file_name: "id_example.pub".to_owned(),
                fingerprint: fingerprint.clone(),
            },
        )
        .expect("disclosure");
        assert_eq!(view.public_key, line.trim());
        assert_eq!(view.fingerprint, fingerprint);

        assert!(read_ssh_public_key_with_home(
            home.path(),
            &SshKeyRef {
                file_name: "id_example.pub".to_owned(),
                fingerprint: "SHA256:AAAA".to_owned(),
            },
        )
        .is_err());
        assert!(read_ssh_public_key_with_home(
            home.path(),
            &SshKeyRef {
                file_name: "../outside/id_example.pub".to_owned(),
                fingerprint,
            },
        )
        .is_err());
    }

    /// C9-7. 삭제는 지우는 것이 아니라 옮기는 것이다. 개인키는 열지 않은 채 이름만
    /// 바뀌므로 내용이 그대로 남아 사용자가 되돌릴 수 있다.
    #[test]
    fn c9_deletion_moves_the_pair_into_the_ssh_trash_intact() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let root = home.path().join(".ssh");
        fs::create_dir(&root).expect("ssh root");
        fs::write(
            root.join("id_example.pub"),
            public_key_line("ssh-ed25519", "developer@example"),
        )
        .expect("public");
        fs::write(root.join("id_example"), b"private material").expect("private");

        let fingerprint = get_ssh_keys_with_home(home.path()).expect("inventory").keys[0]
            .fingerprint
            .clone();
        let receipt = delete_ssh_key_with_home(
            home.path(),
            app_data.path(),
            &SshKeyRef {
                file_name: "id_example.pub".to_owned(),
                fingerprint: fingerprint.clone(),
            },
        )
        .expect("delete");

        assert!(receipt.private_key_moved);
        assert!(!root.join("id_example.pub").exists());
        assert!(!root.join("id_example").exists());
        let entry = PathBuf::from(&receipt.trash_path);
        assert_eq!(entry.parent().unwrap().file_name().unwrap(), TRASH_DIR_NAME);
        assert_eq!(
            fs::read(entry.join("id_example")).expect("moved private"),
            b"private material"
        );
        assert!(entry.join("id_example.pub").is_file());

        // 휴지통은 목록에 다시 나타나지 않는다.
        let snapshot = get_ssh_keys_with_home(home.path()).expect("inventory");
        assert!(snapshot.keys.is_empty());
        assert!(snapshot.issues.is_empty());
        // 사라진 키를 다시 지우려는 요청은 아무것도 옮기지 않는다.
        assert!(delete_ssh_key_with_home(
            home.path(),
            app_data.path(),
            &SshKeyRef {
                file_name: "id_example.pub".to_owned(),
                fingerprint,
            },
        )
        .is_err());
    }

    /// C9-8. 메모는 공개키 파일이 아니라 앱 데이터에 남고, 키가 사라지면 함께 사라진다.
    #[test]
    fn c9_notes_live_in_app_data_and_go_away_with_the_key() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let root = home.path().join(".ssh");
        fs::create_dir(&root).expect("ssh root");
        let line = public_key_line("ssh-ed25519", "developer@example");
        fs::write(root.join("id_example.pub"), &line).expect("public");

        let fingerprint = get_ssh_keys_with_home(home.path()).expect("inventory").keys[0]
            .fingerprint
            .clone();
        let snapshot = set_ssh_key_note_with(
            home.path(),
            app_data.path(),
            &SetSshKeyNoteRequest {
                fingerprint: fingerprint.clone(),
                note: "  회사 GitHub 배포키  ".to_owned(),
            },
        )
        .expect("note");
        assert_eq!(snapshot.keys[0].note.as_deref(), Some("회사 GitHub 배포키"));
        // 공개키 파일 자체는 손대지 않는다.
        assert_eq!(
            fs::read_to_string(root.join("id_example.pub")).unwrap(),
            line
        );
        assert!(get_ssh_keys_with(home.path(), app_data.path())
            .expect("inventory")
            .keys[0]
            .note
            .is_some());

        // 등록되지 않은 지문과 제어문자가 섞인 메모는 저장하지 않는다.
        assert!(set_ssh_key_note_with(
            home.path(),
            app_data.path(),
            &SetSshKeyNoteRequest {
                fingerprint: "SHA256:ZZZZ".to_owned(),
                note: "다른 키".to_owned(),
            },
        )
        .is_err());
        assert!(set_ssh_key_note_with(
            home.path(),
            app_data.path(),
            &SetSshKeyNoteRequest {
                fingerprint: fingerprint.clone(),
                note: "줄\n바꿈".to_owned(),
            },
        )
        .is_err());

        let receipt = delete_ssh_key_with_home(
            home.path(),
            app_data.path(),
            &SshKeyRef {
                file_name: "id_example.pub".to_owned(),
                fingerprint,
            },
        )
        .expect("delete");
        assert!(receipt.note_removed);
        assert!(load_notes(app_data.path()).expect("notes").is_empty());
    }
}
