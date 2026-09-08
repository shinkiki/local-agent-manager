//! 계정별 자격증명 프로필. 공급자 홈(트랜스크립트·설정·스킬·MCP)은 공유한 채
//! 자격증명만 프로세스 단위로 갈라, 여러 계정이 같은 앱에서 동시에 요청을 보낼 수
//! 있게 한다. 한도는 계정 단위(서버 측)로 걸리므로 병렬 요청의 실효는 계정을 나눌
//! 때만 생기고, 홈 전체를 나누면 트랜스크립트와 스킬이 함께 갈라져 세션 색인이
//! 깨진다. 그래서 갈라내는 대상을 자격증명 하나로 좁힌다.
//!
//! - Claude: `CLAUDE_SECURESTORAGE_CONFIG_DIR`이 자격증명 파일 경로와 Keychain
//!   서비스명 해시를 단독으로 결정한다. `CLAUDE_CONFIG_DIR`은 건드리지 않는다.
//! - Codex: `CODEX_HOME`에 자격증명과 설정이 함께 있으므로 홈을 계정별로 만들되
//!   설정은 공유 홈으로 심링크하고, 대화 저장소는 `CODEX_SQLITE_HOME`으로 공유
//!   홈을 그대로 가리켜 세션 색인 경로를 유지한다.
//!
//! 두 환경변수는 공급자 CLI의 문서화된 계약이 아니므로, 프로필을 실제로 쓰기 전에
//! 해당 CLI로 인증 상태를 확인하는 프로브를 돌리고 실패하면 공유 홈 동작으로
//! 되돌린다([`probe_profile`]).
//!
//! 프로브가 답하는 것은 "CLI가 이 프로필 저장소를 읽는가" 하나다. "어느 계정인가"는
//! 프로필에 쓴 자격증명으로 따로 확인한다. Claude는 설정 디렉터리를 공유하므로
//! `auth status`가 돌려주는 계정 정보가 프로필이 아니라 공유 설정을 가리키고,
//! 그것을 계정 확인에 쓰면 공유 설정에 적힌 계정 하나만 격리를 통과한다.
//!
//! 프로브는 CLI가 어느 스트림에 답하는지도 계약으로 두지 않는다([`ProbeResponse`]).

use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::{self, sleep, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::{CoreError, ProviderId};

/// 앱 데이터 디렉터리 하위의 계정별 자격증명 프로필 루트.
pub(crate) const PROFILE_ROOT: &str = "credential-profiles";
/// 인증 상태 조회는 네트워크 호출이 아니라 로컬 자격증명 판독이라 즉시 끝난다.
/// 그래도 CLI가 멈추면 채팅 시작을 막으므로 마감 시한을 둔다.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// 프로브가 한 스트림에서 판정에 쓸 최대 크기. 인증 상태 응답은 JSON 한 덩이나 한
/// 줄이라 이 한도에 닿지 않는다. 넘는 만큼은 버리되 파이프는 계속 비운다.
const PROBE_MAX_STREAM_BYTES: usize = 64 * 1024;
/// Codex 프로필 홈에서 공유 홈을 그대로 가리킬 항목. 자격증명(auth.json)만 프로필
/// 소유로 두고 설정·훅·플러그인과 사용자가 쓴 정책 자산은 공유본 하나를 함께 쓴다.
///
/// Codex 격리는 `CODEX_HOME`을 통째로 바꾸는 방식이라, 여기 없는 항목은 격리 프로필로
/// 실행한 세션에서 보이지 않는다. `skills`·`rules`·`AGENTS.md`는 사용자가 공유 홈에
/// 작성하고 게시하는 자산인데 빠져 있어서, 게시한 스킬을 격리 세션이 찾지 못하고 명령
/// 허용 규칙도 계정마다 다르게 적용됐다. 세션·히스토리·상태 저장소는 계정별로 갈려야
/// 하므로 여기에 넣지 않는다(대화 저장소는 `CODEX_SQLITE_HOME`으로 따로 공유한다).
const CODEX_SHARED_ENTRIES: &[&str] = &[
    "config.toml",
    "hooks.json",
    "plugins",
    "skills",
    "rules",
    "AGENTS.md",
];

/// 프로필 격리 프로브 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProbeOutcome {
    /// 프로필 자격증명으로 해당 계정 인증이 확인됐다.
    Ready,
    /// CLI는 프로필을 읽었지만 인증이 없다. 자격증명 기록이 실패했거나 CLI가 이
    /// 환경변수를 무시한 경우이므로 공유 홈으로 되돌린다.
    NotAuthenticated(String),
    /// CLI를 실행하지 못했거나 응답이 없어 판정할 수 없다.
    Unavailable(String),
}

/// Claude 자격증명 저장소를 정하는 환경변수. 이 값이 자격증명 파일 경로와 Keychain
/// 서비스명 해시를 단독으로 결정하므로, 계정별 격리 프로필과 로그인 임시 프로필이
/// 같은 이름으로 같은 경로를 넘겨야 앱이 CLI가 쓴 자리를 그대로 읽는다.
pub(crate) const CLAUDE_SECURESTORAGE_CONFIG_DIR: &str = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
/// Codex 홈. 자격증명과 설정이 함께 있어 프로필 격리는 이 값을 통째로 옮긴다.
pub(crate) const CODEX_HOME: &str = "CODEX_HOME";
/// Codex 대화 저장소. 홈을 계정별로 갈라도 세션 색인 경로를 공유 홈에 붙들어 둔다.
pub(crate) const CODEX_SQLITE_HOME: &str = "CODEX_SQLITE_HOME";
/// Claude 설정 디렉터리. 프로필 격리는 이 값을 건드리지 않지만, 사용자가 직접 옮긴
/// 설치에서는 이 경로도 공급자 소유라 함께 다뤄야 한다.
pub(crate) const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";

/// 공급자 자격증명·홈 저장소의 위치를 환경변수로 바꾸는 값 전체.
///
/// 앱이 계정 격리를 주려고 CLI 자식에게 넣는 값이면서, 사용자가 설치를 옮길 때 쓰는
/// 값이기도 하다. 어느 쪽이든 "이 변수가 가리키는 곳은 공급자 소유"라는 뜻이 같아
/// 목록을 한 벌만 둔다. 곳곳에 흩어 두면 변수를 하나 늘렸을 때 일부만 갱신돼,
/// 자식에게 격리 값이 새거나 보호 경계가 뚫리는 쪽으로 어긋난다.
pub(crate) const CREDENTIAL_ENV_KEYS: [&str; 4] = [
    CLAUDE_SECURESTORAGE_CONFIG_DIR,
    CLAUDE_CONFIG_DIR,
    CODEX_HOME,
    CODEX_SQLITE_HOME,
];

/// 공급자와 무관한 자식 프로세스의 환경에서 격리 변수를 지운다. 백엔드가 에이전트
/// 세션 안에서 재기동돼 이 값을 물려받았을 수 있으므로, 자식이 남의 계정 저장소를
/// 보지 않도록 넘기기 전에 끊는다.
pub(crate) fn strip_inherited_credential_env(command: &mut Command) {
    for key in CREDENTIAL_ENV_KEYS {
        command.env_remove(key);
    }
}

/// 지금 프로세스가 물려받은 격리 변수가 가리키는 경로들. 빈 값은 설정하지 않은 것과
/// 같게 보고 뺀다. 실제 공급자 런타임 구성에 쓰는 경로만 읽는다(G8).
pub(crate) fn inherited_credential_dirs() -> Vec<PathBuf> {
    CREDENTIAL_ENV_KEYS
        .into_iter()
        .filter_map(std::env::var_os)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .collect()
}

pub(crate) fn provider_supports_isolation(provider: ProviderId) -> bool {
    matches!(provider, ProviderId::Claude | ProviderId::Codex)
}

/// 계정별 프로필 경로. 계정 id는 레지스트리가 만든 값이라 경로 구분자를 담지
/// 않지만, 앱 데이터 밖으로 새지 않도록 마지막 요소만 쓴다.
pub(crate) fn profile_dir(
    app_data_dir: &Path,
    provider: ProviderId,
    account_id: &str,
) -> Result<PathBuf, CoreError> {
    let account_id = account_id.trim();
    if account_id.is_empty()
        || account_id.contains('/')
        || account_id.contains('\\')
        || account_id.contains("..")
    {
        return Err(CoreError::InvalidInput(
            "자격증명 프로필을 만들 수 없는 계정 식별자입니다".to_owned(),
        ));
    }
    Ok(app_data_dir
        .join(PROFILE_ROOT)
        .join(provider.as_str())
        .join(account_id))
}

/// 프로필 디렉터리를 만들고 소유자 전용 권한으로 맞춘 뒤 정규화한 경로를 준다.
/// Claude CLI가 Keychain 서비스명을 이 경로의 SHA-256으로 만들기 때문에, 앱이
/// 같은 항목을 찾으려면 양쪽이 반드시 같은 문자열을 써야 한다. 그래서 생성
/// 시점에 한 번 정규화하고 그 값만 환경변수와 해시에 함께 쓴다.
pub(crate) fn ensure_profile_dir(
    app_data_dir: &Path,
    provider: ProviderId,
    account_id: &str,
) -> Result<PathBuf, CoreError> {
    let dir = profile_dir(app_data_dir, provider, account_id)?;
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    Ok(fs::canonicalize(&dir)?)
}

/// 프로필을 쓰는 프로세스에 넣을 환경변수. 공유 홈 경로는 Codex 대화 저장소를
/// 공유하는 데 쓴다.
pub(crate) fn profile_env(
    provider: ProviderId,
    profile_dir: &Path,
    shared_home: &Path,
) -> Result<Vec<(String, String)>, CoreError> {
    let profile = profile_dir.to_string_lossy().into_owned();
    match provider {
        ProviderId::Claude => Ok(vec![(CLAUDE_SECURESTORAGE_CONFIG_DIR.to_owned(), profile)]),
        ProviderId::Codex => Ok(vec![
            (CODEX_HOME.to_owned(), profile),
            (
                CODEX_SQLITE_HOME.to_owned(),
                shared_home.to_string_lossy().into_owned(),
            ),
        ]),
        ProviderId::Antigravity => Err(CoreError::InvalidInput(
            "Antigravity는 계정별 자격증명 프로필을 지원하지 않습니다".to_owned(),
        )),
    }
}

/// Codex 프로필 홈에 공유 설정을 잇는다. 이미 올바른 심링크면 그대로 두고, 다른
/// 곳을 가리키거나 실체 파일이면 공유본을 가리키도록 다시 만든다. 공유 홈에 없는
/// 항목은 만들지 않는다(Codex가 없는 파일을 기본값으로 다룬다).
pub(crate) fn link_shared_codex_entries(
    profile_dir: &Path,
    shared_home: &Path,
) -> Result<(), CoreError> {
    for entry in CODEX_SHARED_ENTRIES {
        let source = shared_home.join(entry);
        if !source.exists() {
            continue;
        }
        let link = profile_dir.join(entry);
        match fs::read_link(&link) {
            Ok(current) if current == source => continue,
            Ok(_) => remove_profile_entry(&link)?,
            Err(_) if link.exists() => remove_profile_entry(&link)?,
            Err(_) => {}
        }
        symlink_entry(&source, &link)?;
    }
    Ok(())
}

fn remove_profile_entry(path: &Path) -> Result<(), CoreError> {
    // 심링크는 대상 종류와 무관하게 remove_file로 지워야 한다. 실체 디렉터리만
    // 재귀 삭제 대상이다.
    let is_symlink = fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false);
    if !is_symlink && path.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(unix)]
fn symlink_entry(source: &Path, link: &Path) -> Result<(), CoreError> {
    std::os::unix::fs::symlink(source, link)?;
    Ok(())
}

#[cfg(windows)]
fn symlink_entry(source: &Path, link: &Path) -> Result<(), CoreError> {
    if source.is_dir() {
        std::os::windows::fs::symlink_dir(source, link)?;
    } else {
        std::os::windows::fs::symlink_file(source, link)?;
    }
    Ok(())
}

/// 계정 등록을 지울 때 프로필 자격증명도 함께 지운다. 디렉터리를 남기면 지운
/// 계정의 토큰이 디스크에 남는다. Claude Keychain 항목 정리는 호출자가 한다.
pub(crate) fn remove_profile(
    app_data_dir: &Path,
    provider: ProviderId,
    account_id: &str,
) -> Result<(), CoreError> {
    let dir = profile_dir(app_data_dir, provider, account_id)?;
    if !dir.exists() {
        return Ok(());
    }
    // 공유 홈을 가리키는 심링크가 들어 있으므로, 링크 자체만 지우고 대상은 남긴다.
    for entry in fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        let is_symlink = fs::symlink_metadata(&path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);
        if is_symlink {
            fs::remove_file(&path)?;
        }
    }
    fs::remove_dir_all(&dir)?;
    Ok(())
}

/// 프로필 환경변수를 넣고 공급자 CLI에 인증 상태를 물어 격리가 실제로 먹는지
/// 확인한다. 모델 호출이 아니라 로컬 자격증명 판독이라 사용량을 쓰지 않는다.
///
/// 확인하는 것은 "CLI가 이 프로필 저장소를 읽는가" 하나다. 어느 계정인지는 이
/// 응답으로 판단할 수 없다([`claude_probe_outcome`] 참고). 프로필에 들어간 자격
/// 증명이 이 계정 것인지는 호출자가 자격증명 자체로 확인한다.
///
/// 응답 원문은 판정에만 쓰고 어디에도 남기지 않는다. `claude auth status --json`은
/// 이메일·조직을, 다른 버전은 더 많은 계정 정보를 담을 수 있으므로 결과 문구에도
/// 원문을 섞지 않는다.
pub(crate) fn probe_profile(
    provider: ProviderId,
    executable: &Path,
    env: &[(String, String)],
) -> ProbeOutcome {
    let args: &[&str] = match provider {
        ProviderId::Claude => &["auth", "status", "--json"],
        ProviderId::Codex => &["login", "status"],
        ProviderId::Antigravity => {
            return ProbeOutcome::Unavailable(
                "Antigravity는 자격증명 프로필을 지원하지 않습니다".to_owned(),
            );
        }
    };
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    crate::chat::configure_no_window_command(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ProbeOutcome::Unavailable(format!("CLI를 실행하지 못했습니다: {error}"));
        }
    };
    // 두 파이프를 동시에 비운다. 한쪽만 읽으면 다른 쪽 버퍼가 차는 순간 CLI가 막혀
    // 종료하지 않고, 마감 시한까지 기다린 뒤 판정 불가로 끝난다.
    let stdout = drain_stream(child.stdout.take());
    let stderr = drain_stream(child.stderr.take());
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let failure = loop {
        match child.try_wait() {
            Ok(Some(_)) => break None,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Some("CLI 인증 상태 조회가 시간 안에 끝나지 않았습니다".to_owned());
                }
                sleep(PROBE_POLL_INTERVAL);
            }
            Err(error) => break Some(format!("CLI 종료를 확인하지 못했습니다: {error}")),
        }
    };
    // 자식이 끝나면 파이프가 닫히므로 읽기 스레드도 함께 끝난다.
    let response = ProbeResponse {
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    };
    if let Some(failure) = failure {
        return ProbeOutcome::Unavailable(failure);
    }
    match provider {
        ProviderId::Claude => claude_probe_outcome(&response),
        ProviderId::Codex => codex_probe_outcome(&response),
        ProviderId::Antigravity => unreachable!(),
    }
}

/// 프로브가 읽은 CLI 응답. 어느 스트림에 쓰는지는 공급자와 버전마다 달라서 두 쪽을
/// 모두 담는다. `claude auth status --json`(2.1.x)은 stdout에 JSON을 쓰지만
/// `codex login status`(0.149.0)는 로그인 여부를 stderr에 한 줄로 쓰고 stdout은
/// 비워 둔다. stdout만 읽으면 Codex 응답이 통째로 비어 격리를 판정할 수 없다.
struct ProbeResponse {
    stdout: String,
    stderr: String,
}

/// 파이프 하나를 끝까지 읽어 비우는 스레드. 판정에 쓸 앞부분만 남기고 나머지는
/// 버리되 읽기는 계속한다. 한도에서 읽기를 멈추면 CLI가 파이프에서 막혀 종료하지
/// 않고 마감 시한까지 기다리게 된다. 유효하지 않은 바이트는 대체 문자로 바꿔
/// 인코딩 문제로 응답을 잃지 않는다.
fn drain_stream(stream: Option<impl Read + Send + 'static>) -> JoinHandle<String> {
    thread::spawn(move || {
        let Some(mut stream) = stream else {
            return String::new();
        };
        let mut kept: Vec<u8> = Vec::new();
        let mut chunk = [0_u8; 8 * 1024];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let room = PROBE_MAX_STREAM_BYTES.saturating_sub(kept.len());
                    if room > 0 {
                        kept.extend_from_slice(&chunk[..read.min(room)]);
                    }
                }
            }
        }
        String::from_utf8_lossy(&kept).into_owned()
    })
}

/// `claude auth status --json`은 자격증명 저장소를 프로필로 갈라도 `email`은 공유
/// `~/.claude.json`의 `oauthAccount`에서 읽어 그대로 돌려준다. `CLAUDE_CONFIG_DIR`은
/// 일부러 공유하므로 이 값은 항상 공유 설정이 가리키는 계정 하나를 말하고, 계정별
/// 프로필을 구분하지 못한다. 이 값을 계정 확인에 쓰면 공유 설정에 적힌 계정만
/// 격리를 통과하고 나머지는 전부 공유 홈으로 되돌아간다.
///
/// 그래서 여기서는 로그인 여부만 본다. 빈 프로필을 가리키면 CLI가 공유 저장소로
/// 되돌아가지 않고 `loggedIn: false`를 주므로, 이 한 값으로 환경변수가 실제로
/// 먹었는지 판정할 수 있다. 자격증명이 어느 계정 것인지는 호출자가 프로필에 쓴
/// 자격증명 자체로 확인한다.
fn claude_probe_outcome(response: &ProbeResponse) -> ProbeOutcome {
    // JSON은 stdout 계약이지만, 버전에 따라 stderr로 나가도 판정은 같아야 한다.
    let Some(value) = [response.stdout.trim(), response.stderr.trim()]
        .into_iter()
        .filter(|stream| !stream.is_empty())
        .find_map(|stream| serde_json::from_str::<Value>(stream).ok())
    else {
        return ProbeOutcome::Unavailable("인증 상태 응답을 해석하지 못했습니다".to_owned());
    };
    if value.get("loggedIn").and_then(Value::as_bool) != Some(true) {
        return ProbeOutcome::NotAuthenticated(
            "프로필 자격증명으로 로그인 상태를 확인하지 못했습니다".to_owned(),
        );
    }
    ProbeOutcome::Ready
}

/// `codex login status`(0.149.0)는 로그인 여부를 stderr에 쓰고 stdout은 비워 둔다.
/// 어느 스트림에 쓰는지는 계약이 아니므로 두 쪽을 함께 본다. 판정은 문구로만 하고
/// 종료 코드로 로그인을 단정하지 않는다. 문구를 못 찾으면 판정 불가로 두어 공유
/// 홈으로 되돌아가고, 없는 격리를 있다고 믿어 자격증명이 섞이는 쪽을 막는다.
fn codex_probe_outcome(response: &ProbeResponse) -> ProbeOutcome {
    let normalized = format!("{}\n{}", response.stdout, response.stderr).to_ascii_lowercase();
    // "Not logged in"이 "logged in"을 품고 있으므로 부정형을 먼저 걸러낸다.
    if normalized.contains("not logged in") || normalized.contains("no codex credentials") {
        ProbeOutcome::NotAuthenticated(
            "프로필 자격증명으로 로그인 상태를 확인하지 못했습니다".to_owned(),
        )
    } else if normalized.contains("logged in") {
        ProbeOutcome::Ready
    } else {
        ProbeOutcome::Unavailable("인증 상태 응답을 해석하지 못했습니다".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_dir_rejects_identifiers_that_escape_the_root() {
        let root = Path::new("/tmp/app-data");
        assert!(profile_dir(root, ProviderId::Claude, "../secret").is_err());
        assert!(profile_dir(root, ProviderId::Claude, "a/b").is_err());
        assert!(profile_dir(root, ProviderId::Claude, "  ").is_err());
        assert_eq!(
            profile_dir(root, ProviderId::Claude, "claude-1234").unwrap(),
            root.join(PROFILE_ROOT).join("claude").join("claude-1234")
        );
    }

    #[test]
    fn claude_env_isolates_only_the_credential_store() {
        let env = profile_env(
            ProviderId::Claude,
            Path::new("/tmp/profile"),
            Path::new("/tmp/home/.claude"),
        )
        .unwrap();
        assert_eq!(
            env,
            vec![(
                "CLAUDE_SECURESTORAGE_CONFIG_DIR".to_owned(),
                "/tmp/profile".to_owned()
            )]
        );
        // CLAUDE_CONFIG_DIR을 건드리면 트랜스크립트와 스킬까지 갈라진다.
        assert!(!env.iter().any(|(key, _)| key == "CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn codex_env_keeps_the_shared_thread_database() {
        let env = profile_env(
            ProviderId::Codex,
            Path::new("/tmp/profile"),
            Path::new("/tmp/home/.codex"),
        )
        .unwrap();
        assert_eq!(
            env,
            vec![
                ("CODEX_HOME".to_owned(), "/tmp/profile".to_owned()),
                (
                    "CODEX_SQLITE_HOME".to_owned(),
                    "/tmp/home/.codex".to_owned()
                ),
            ]
        );
    }

    /// 격리 변수를 하나 늘리고 목록만 잊으면, 자식 프로세스에 남의 계정 저장소가
    /// 그대로 새고 문서 폴더 보호 경계에도 같은 크기의 구멍이 난다. 변수를 실제로
    /// 넣는 쪽([`profile_env`])과 목록을 묶어, 한쪽만 바뀌면 여기서 걸리게 한다.
    #[test]
    fn credential_env_keys_cover_every_variable_profile_env_sets() {
        for provider in [ProviderId::Claude, ProviderId::Codex] {
            let env = profile_env(
                provider,
                Path::new("/tmp/profile"),
                Path::new("/tmp/shared"),
            )
            .unwrap();
            for (key, _) in env {
                assert!(
                    CREDENTIAL_ENV_KEYS.contains(&key.as_str()),
                    "{key}가 CREDENTIAL_ENV_KEYS에 없습니다"
                );
            }
        }
    }

    #[test]
    fn shared_codex_entries_are_linked_and_repaired() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("shared");
        let profile = temp.path().join("profile");
        fs::create_dir_all(shared.join("plugins")).unwrap();
        fs::create_dir_all(&profile).unwrap();
        fs::write(shared.join("config.toml"), "model = \"gpt-5\"").unwrap();
        // 이전에 실체 파일이 들어가 있었다면 공유본 심링크로 바꾼다.
        fs::write(profile.join("config.toml"), "stale").unwrap();

        link_shared_codex_entries(&profile, &shared).unwrap();

        assert_eq!(
            fs::read_link(profile.join("config.toml")).unwrap(),
            shared.join("config.toml")
        );
        assert_eq!(
            fs::read_link(profile.join("plugins")).unwrap(),
            shared.join("plugins")
        );
        // 공유 홈에 없는 항목은 만들지 않는다.
        assert!(!profile.join("hooks.json").exists());
        // 두 번 돌려도 그대로 유지된다.
        link_shared_codex_entries(&profile, &shared).unwrap();
        assert_eq!(
            fs::read_link(profile.join("config.toml")).unwrap(),
            shared.join("config.toml")
        );
    }

    #[test]
    fn user_authored_assets_are_shared_with_the_isolated_profile() {
        // Codex 격리는 CODEX_HOME을 통째로 바꾸므로, 링크하지 않은 항목은 격리 세션에서
        // 보이지 않는다. 게시한 스킬을 못 찾거나 명령 허용 규칙이 계정마다 달라지면
        // 무인 회차의 동작이 회차마다 갈린다.
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("shared");
        let profile = temp.path().join("profile");
        fs::create_dir_all(shared.join("skills/kbfps-dynamic-form-qa")).unwrap();
        fs::create_dir_all(shared.join("rules")).unwrap();
        fs::create_dir_all(&profile).unwrap();
        fs::write(
            shared.join("skills/kbfps-dynamic-form-qa/SKILL.md"),
            "---\n",
        )
        .unwrap();
        fs::write(shared.join("rules/default.rules"), "prefix_rule()").unwrap();
        // 전역 지침은 비어 있어도 링크한다. 나중에 채웠을 때 격리 세션만 못 읽으면
        // 같은 문제가 조용히 돌아온다.
        fs::write(shared.join("AGENTS.md"), "").unwrap();

        link_shared_codex_entries(&profile, &shared).unwrap();

        for entry in ["skills", "rules", "AGENTS.md"] {
            assert_eq!(
                fs::read_link(profile.join(entry)).unwrap(),
                shared.join(entry),
                "{entry}이(가) 공유 홈을 가리켜야 한다"
            );
        }
        assert!(profile
            .join("skills/kbfps-dynamic-form-qa/SKILL.md")
            .exists());
    }

    fn on_stdout(output: &str) -> ProbeResponse {
        ProbeResponse {
            stdout: output.to_owned(),
            stderr: String::new(),
        }
    }

    fn on_stderr(output: &str) -> ProbeResponse {
        ProbeResponse {
            stdout: String::new(),
            stderr: output.to_owned(),
        }
    }

    #[test]
    fn claude_probe_reads_login_state() {
        assert_eq!(
            claude_probe_outcome(&on_stdout(r#"{"loggedIn": true, "email": "a@b.com"}"#)),
            ProbeOutcome::Ready
        );
        assert!(matches!(
            claude_probe_outcome(&on_stdout(r#"{"loggedIn": false}"#)),
            ProbeOutcome::NotAuthenticated(_)
        ));
        assert!(matches!(
            claude_probe_outcome(&on_stdout("Not logged in · Please run /login")),
            ProbeOutcome::Unavailable(_)
        ));
    }

    /// `email`은 공유 `~/.claude.json`에서 오므로 프로필 계정과 다른 값이 와도
    /// 격리를 막으면 안 된다. 이 값을 보고 판정하면 공유 설정에 적힌 계정 하나만
    /// 격리되고 나머지 계정은 전부 공유 홈으로 되돌아간다.
    #[test]
    fn claude_probe_ignores_the_shared_config_email() {
        assert_eq!(
            claude_probe_outcome(&on_stdout(r#"{"loggedIn": true, "email": "other@b.com"}"#)),
            ProbeOutcome::Ready
        );
    }

    /// stdout이 계약이지만 stderr로 나가도 같은 판정을 내려야 한다. 스트림이 바뀌는
    /// 것만으로 격리가 꺼지면 CLI 업데이트마다 병렬 실행이 사라진다.
    #[test]
    fn claude_probe_accepts_the_json_from_either_stream() {
        assert_eq!(
            claude_probe_outcome(&on_stderr(r#"{"loggedIn": true}"#)),
            ProbeOutcome::Ready
        );
    }

    #[test]
    fn codex_probe_reads_login_state() {
        assert_eq!(
            codex_probe_outcome(&on_stdout("Logged in using ChatGPT\n")),
            ProbeOutcome::Ready
        );
        assert!(matches!(
            codex_probe_outcome(&on_stdout("Not logged in\n")),
            ProbeOutcome::NotAuthenticated(_)
        ));
        assert!(matches!(
            codex_probe_outcome(&on_stdout("")),
            ProbeOutcome::Unavailable(_)
        ));
    }

    /// Codex CLI 0.149.0의 실제 계약. `codex login status`는 stdout을 비워 두고
    /// 로그인 여부를 stderr에 쓴다. stdout만 읽으면 응답이 빈 문자열이 되어 모든
    /// Codex 계정이 "인증 상태 응답을 해석하지 못했습니다"로 공유 홈에 묶인다.
    #[test]
    fn codex_probe_reads_the_status_line_from_stderr() {
        assert_eq!(
            codex_probe_outcome(&on_stderr("Logged in using ChatGPT\n")),
            ProbeOutcome::Ready
        );
        assert!(matches!(
            codex_probe_outcome(&on_stderr("Not logged in\n")),
            ProbeOutcome::NotAuthenticated(_)
        ));
    }

    /// 프로세스 경계까지 확인한다. 판정 함수만 고쳐도 프로브가 stderr를 버리면
    /// 아무것도 달라지지 않으므로, 실제 자식 프로세스의 stderr를 읽어 오는지 본다.
    /// stdout을 함께 쏟아내도 파이프에서 막히지 않아야 한다.
    #[cfg(unix)]
    #[test]
    fn probe_reads_a_status_line_written_to_stderr_by_a_real_process() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("codex");
        // 상태 한 줄은 stderr로, 잡음은 stdout으로 흘리는 CLI를 흉내낸다.
        fs::write(
            &script,
            "#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' 'x'\necho 'Logged in using ChatGPT' >&2\nexit 0\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            probe_profile(ProviderId::Codex, &script, &[]),
            ProbeOutcome::Ready
        );
    }

    /// 두 스트림을 이어 붙일 때 한쪽 끝과 다른 쪽 시작이 붙어 없던 문구가 생기면
    /// 안 된다. stdout `...not`과 stderr `logged in`이 "not logged in"으로 읽히면
    /// 로그인 상태를 잘못 판정한다.
    #[test]
    fn codex_probe_does_not_splice_words_across_streams() {
        assert_eq!(
            codex_probe_outcome(&ProbeResponse {
                stdout: "checking if not".to_owned(),
                stderr: "logged in using ChatGPT".to_owned(),
            }),
            ProbeOutcome::Ready
        );
    }
}
