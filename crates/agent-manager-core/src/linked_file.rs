use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::Serialize;

use crate::file_kind::{ensure_regular_file, ensure_within_limit};
use crate::path_guard::child_facing;
use crate::CoreError;

const MAX_LINKED_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// 이미지 미리보기 상한. 텍스트처럼 줄마다 하이라이팅하지 않고 `data:` URL 하나로 실어
/// 보내므로 텍스트보다 크게 잡는다. 두 상한은 [`ResolvedLinkedFile::into_preview`]가 건다.
const MAX_LINKED_IMAGE_BYTES: u64 = 30 * 1024 * 1024;
const MAX_LINKED_FILE_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;
/// 이어 복사할 때 한 번에 옮기는 양. 진행률을 알리는 간격이기도 하다. 파일 전체를
/// 메모리에 올리지 않는 것이 이 경로의 존재 이유이므로 상수는 파일 크기와 무관하다.
const COPY_CHUNK_BYTES: usize = 1024 * 1024;
const LINK_NOT_REGULAR_FILE: &str = "링크 대상이 일반 파일이 아닙니다";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFile {
    pub relative_path: String,
    pub content: String,
    pub size_bytes: u64,
    pub target_line: Option<usize>,
    /// 이미지 파일이면 화면이 그대로 그릴 `data:` URL. 이때 `content`는 비어 있다.
    pub image_data_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedFileDownload {
    pub relative_path: String,
    pub bytes: Vec<u8>,
    pub size_bytes: u64,
}

/// 내려받을 파일을 읽지 않고 자리만 확인한 결과. 바이트를 메모리에 올리는
/// [`LinkedFileDownload`]와 달리 원본 경로를 그대로 들고 있어, 호출부가 원본에서
/// 목적지로 곧장 이어 복사할 수 있다. 크기 상한이 메모리 때문에 존재하던 경로는
/// 이쪽으로 오면 상한 자체가 필요 없어진다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedFileSource {
    pub path: PathBuf,
    pub relative_path: String,
    pub size_bytes: u64,
}

/// 이어 복사가 끝난 뒤의 결말. 취소는 실패가 아니라 결말의 한 갈래다 — 사용자가
/// 멈춘 것을 오류로 올리면 화면이 실패 문구를 띄운다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkedFileCopy {
    pub copied_bytes: u64,
    pub cancelled: bool,
}

struct ResolvedLinkedFile {
    path: PathBuf,
    relative_path: String,
    size_bytes: u64,
    target_line: Option<usize>,
    /// 자리 확인 때 잰 상한. 실제로 읽을 때 같은 값을 다시 적용한다 — 재기와 읽기
    /// 사이에 파일이 바뀌어도 메모리에 올리는 양은 이 값을 넘지 않는다.
    max_bytes: u64,
}

impl ResolvedLinkedFile {
    /// 미리보기 상한은 종류마다 달라 자리 확인 뒤 여기서 고른다. 자리 확인은 상한 없이
    /// 하므로, 30MB를 넘는 텍스트도 텍스트 상한(5MB)으로 안내된다.
    fn into_preview(self) -> Result<LinkedFile, CoreError> {
        let image_mime = image_mime_type(&self.path);
        let limit = if image_mime.is_some() {
            MAX_LINKED_IMAGE_BYTES
        } else {
            MAX_LINKED_FILE_BYTES
        };
        let bytes = read_bounded(&self.path, limit.min(self.max_bytes))?;
        let size_bytes = bytes.len() as u64;
        let (content, image_data_url) = match image_mime {
            Some(mime) => (
                String::new(),
                Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes))),
            ),
            None => {
                let content = String::from_utf8(bytes).map_err(|_| {
                    CoreError::InvalidInput("미리보기를 지원하지 않는 파일입니다.".to_owned())
                })?;
                (content, None)
            }
        };
        Ok(LinkedFile {
            relative_path: self.relative_path,
            size_bytes,
            content,
            target_line: self.target_line,
            image_data_url,
        })
    }

    fn into_download(self) -> Result<LinkedFileDownload, CoreError> {
        let bytes = read_bounded(&self.path, self.max_bytes)?;
        Ok(LinkedFileDownload {
            size_bytes: bytes.len() as u64,
            bytes,
            relative_path: self.relative_path,
        })
    }

    fn into_source(self) -> LinkedFileSource {
        LinkedFileSource {
            path: self.path,
            relative_path: self.relative_path,
            size_bytes: self.size_bytes,
        }
    }
}

/// 크기를 잰 파일과 읽는 파일이 같은 핸들이 되게 읽는다. 경로로 재고 경로로 다시 열면
/// 그 사이에 파일이 커지거나 바뀐 경우 상한보다 큰 바이트가 통째로 메모리에 올라간다 —
/// 상한이 있는 이유가 메모리이므로, 읽는 쪽이 상한을 다시 지켜야 한다(G10).
/// `take(max + 1)` 로 한 바이트만 더 읽어, 잰 뒤에 자란 파일도 잘라 돌려주지 않고
/// 거절한다.
fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, CoreError> {
    let file = File::open(path)?;
    let metadata = file.metadata()?;
    ensure_regular_file(&metadata, LINK_NOT_REGULAR_FILE)?;
    ensure_within_limit(&metadata, max_bytes)?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    (&file)
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(CoreError::TooLarge(max_bytes));
    }
    Ok(bytes)
}

pub(crate) fn read_linked_file(root: &Path, href: &str) -> Result<LinkedFile, CoreError> {
    read_linked_file_from(root, root, href)
}

/// 채팅 링크가 열어도 되는 자리. 문서·지침·과거 세션의 작업공간 제한은 별도로 유지한다.
///
/// `primary`(작업 폴더)가 상대 링크의 기준이고, `others`는 에이전트가 함께 다루는
/// 폴더(등록 폴더·Cypress 작업공간 등)다. 에이전트가 만든 파일을 링크로 보내 놓고
/// 사용자는 "작업 경로 밖"이라 못 여는 일이 없게, 루트 목록은 그 채팅이 실제로 다루는
/// 범위를 그대로 받는다. 전체 접근 채팅(`allow_external`)은 루트와 무관하게 연다.
///
/// `others`는 링크가 작업 폴더 밖일 때만 부른다. 등록 폴더 확인은 굳은 폴더를 기다리고
/// 세션 목록까지 훑으므로, 대부분인 작업 폴더 안 링크가 그 값을 치르지 않게 한다.
///
/// `denied`는 범위 안이어도 미리보기·다운로드로 내보내지 않는 파일을 고른다. 비밀이 든
/// `cypress.env.json`처럼 원문을 호스트 전용 명령으로만 여는 파일이 여기 걸린다.
pub(crate) struct LinkScope<'a> {
    pub primary: PathBuf,
    pub others: &'a dyn Fn() -> Vec<PathBuf>,
    pub denied: &'a dyn Fn(&Path) -> bool,
    pub allow_external: bool,
}

pub(crate) fn read_scoped_linked_file(
    scope: &LinkScope<'_>,
    href: &str,
) -> Result<LinkedFile, CoreError> {
    resolve_scoped_linked_file(scope, href, u64::MAX)?.into_preview()
}

pub(crate) fn read_scoped_linked_file_download(
    scope: &LinkScope<'_>,
    href: &str,
) -> Result<LinkedFileDownload, CoreError> {
    resolve_scoped_linked_file(scope, href, MAX_LINKED_FILE_DOWNLOAD_BYTES)?.into_download()
}

pub(crate) fn read_linked_file_from(
    root: &Path,
    base: &Path,
    href: &str,
) -> Result<LinkedFile, CoreError> {
    resolve_linked_file(root, base, href, u64::MAX)?.into_preview()
}

pub(crate) fn read_linked_file_download(
    root: &Path,
    href: &str,
) -> Result<LinkedFileDownload, CoreError> {
    read_linked_file_download_from(root, root, href)
}

pub(crate) fn read_linked_file_download_from(
    root: &Path,
    base: &Path,
    href: &str,
) -> Result<LinkedFileDownload, CoreError> {
    read_linked_file_download_within(root, base, href, MAX_LINKED_FILE_DOWNLOAD_BYTES)
}

/// 상한을 직접 정해 내려받는다. 지침 보관은 원본 한도(파일당 2MB)를 넘는 문서를
/// 애초에 읽지 않아야 하므로, 크기를 확인한 뒤에 읽는 이 경로를 쓴다.
pub(crate) fn read_linked_file_download_within(
    root: &Path,
    base: &Path,
    href: &str,
    max_bytes: u64,
) -> Result<LinkedFileDownload, CoreError> {
    resolve_linked_file(root, base, href, max_bytes)?.into_download()
}

/// 링크 대상의 자리만 확인한다. 상한은 여전히 받는다 — 지침 보관처럼 크기 제한이
/// 메모리가 아니라 업무 규칙인 곳이 있어 호출부가 계속 정한다. 메모리 때문에만
/// 상한을 두던 곳은 `u64::MAX`를 넘겨 제한을 없앤다.
pub(crate) fn read_linked_file_source_from(
    root: &Path,
    base: &Path,
    href: &str,
    max_bytes: u64,
) -> Result<LinkedFileSource, CoreError> {
    Ok(resolve_linked_file(root, base, href, max_bytes)?.into_source())
}

/// 원본을 목적지로 이어 복사한다. 파일 전체를 메모리에 올리지 않으므로 크기와
/// 무관하게 상주 메모리는 [`COPY_CHUNK_BYTES`] 한 조각뿐이다.
///
/// 목적지에 바로 쓰지 않고 같은 폴더의 `.part` 임시 파일에 쓴 뒤 옮긴다. 도중에
/// 멈추거나 실패해도 이미 있던 파일이 반쪽짜리로 덮이지 않는다 — 다중 GB 복사는
/// 중단될 시간이 그만큼 길다.
pub fn copy_linked_file_source(
    source: &LinkedFileSource,
    destination: &Path,
    progress: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<LinkedFileCopy, CoreError> {
    let destination = validated_destination(destination)?;
    let staged = staging_path(&destination)?;
    let result = copy_into_staging(&source.path, &staged, progress, cancelled);
    match result {
        Ok(copy) if !copy.cancelled => {
            if let Err(error) = fs::rename(&staged, &destination) {
                let _ = fs::remove_file(&staged);
                return Err(CoreError::Io(error));
            }
            Ok(copy)
        }
        Ok(copy) => {
            let _ = fs::remove_file(&staged);
            Ok(copy)
        }
        Err(error) => {
            let _ = fs::remove_file(&staged);
            Err(error)
        }
    }
}

fn copy_into_staging(
    source: &Path,
    staged: &Path,
    progress: &mut dyn FnMut(u64),
    cancelled: &dyn Fn() -> bool,
) -> Result<LinkedFileCopy, CoreError> {
    let mut reader = File::open(source)?;
    let mut writer = File::create_new(staged)?;
    let mut buffer = vec![0_u8; COPY_CHUNK_BYTES];
    let mut copied_bytes = 0_u64;
    loop {
        if cancelled() {
            return Ok(LinkedFileCopy {
                copied_bytes,
                cancelled: true,
            });
        }
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
        copied_bytes += read as u64;
        progress(copied_bytes);
    }
    writer.flush()?;
    Ok(LinkedFileCopy {
        copied_bytes,
        cancelled: false,
    })
}

/// 목적지와 같은 폴더에, 아직 없는 이름으로 임시 파일 경로를 고른다. 같은 파일을
/// 두 번 동시에 내려받아도 서로의 중간 파일을 덮지 않아야 한다.
fn staging_path(destination: &Path) -> Result<PathBuf, CoreError> {
    let parent = destination
        .parent()
        .ok_or_else(|| CoreError::InvalidInput("저장할 폴더를 확인할 수 없습니다".to_owned()))?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            CoreError::InvalidInput("저장할 파일 이름을 확인할 수 없습니다".to_owned())
        })?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    for attempt in 0..32_u32 {
        let candidate = parent.join(format!(".{name}.{stamp}-{attempt}.part"));
        if candidate.symlink_metadata().is_err() {
            return Ok(candidate);
        }
    }
    Err(CoreError::InvalidInput(
        "임시 저장 파일 이름을 만들지 못했습니다".to_owned(),
    ))
}

pub fn save_linked_file_download(
    file: &LinkedFileDownload,
    destination: &Path,
) -> Result<(), CoreError> {
    // 이어 복사 경로와 같은 순서를 지킨다: 같은 폴더의 `.part`에 새로 쓰고 옮긴다.
    // 목적지에 바로 쓰면 검사 뒤 끼어든 심볼릭 링크를 따라가고, 쓰다 실패하면 기존
    // 파일이 반쪽으로 남고, 하드 링크된 목적지는 연결된 다른 파일까지 바뀐다(G10).
    let destination = validated_destination(destination)?;
    let staged = staging_path(&destination)?;
    let written = File::create_new(&staged).and_then(|mut writer| {
        writer.write_all(&file.bytes)?;
        writer.flush()
    });
    if let Err(error) = written.and_then(|()| fs::rename(&staged, &destination)) {
        let _ = fs::remove_file(&staged);
        return Err(CoreError::Io(error));
    }
    Ok(())
}

/// 사용자가 저장 대화상자에서 고른 경로를 쓰기 전에 확인하는 한 벌. 바이트를 모아
/// 한 번에 쓰는 경로와 이어 복사하는 경로가 같은 규칙을 봐야, 한쪽만 심볼릭 링크를
/// 허용하는 자리가 생기지 않는다.
fn validated_destination(destination: &Path) -> Result<PathBuf, CoreError> {
    let file_name = destination.file_name().ok_or_else(|| {
        CoreError::InvalidInput("저장할 파일 이름을 확인할 수 없습니다".to_owned())
    })?;
    if file_name.is_empty() || matches!(file_name.to_str(), Some(".") | Some("..")) {
        return Err(CoreError::InvalidInput(
            "저장할 파일 이름이 올바르지 않습니다".to_owned(),
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| CoreError::InvalidInput("저장할 폴더를 확인할 수 없습니다".to_owned()))?;
    let parent = fs::canonicalize(parent)?;
    if !parent.is_dir() {
        return Err(CoreError::InvalidInput(
            "저장할 경로의 상위 항목이 폴더가 아닙니다".to_owned(),
        ));
    }
    let destination = parent.join(file_name);
    if destination
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(CoreError::InvalidInput(
            "심볼릭 링크 위치에는 파일을 저장할 수 없습니다".to_owned(),
        ));
    }
    Ok(destination)
}

fn resolve_linked_file(
    root: &Path,
    base: &Path,
    href: &str,
    max_bytes: u64,
) -> Result<ResolvedLinkedFile, CoreError> {
    let (root, base) = resolve_link_workspace(root, base)?;
    let (path_text, target_line) = parse_link_target(href)?;
    let path = resolve_link_target(&root, &base, &path_text, false)?;
    resolved_file(path, &root, target_line, max_bytes)
}

/// [`resolve_linked_file`]의 채팅 판. 상대 링크는 작업 폴더에 붙이고, 결과가 [`LinkScope`]
/// 범위 안이면 연다.
fn resolve_scoped_linked_file(
    scope: &LinkScope<'_>,
    href: &str,
    max_bytes: u64,
) -> Result<ResolvedLinkedFile, CoreError> {
    let (primary, _) = resolve_link_workspace(&scope.primary, &scope.primary)?;
    let (path_text, target_line) = parse_link_target(href)?;
    // 경계는 아래에서 범위 전체로 따로 본다.
    let path = resolve_link_target(&primary, &primary, &path_text, true)?;
    if (scope.denied)(&path) {
        return Err(CoreError::InvalidInput(
            "이 파일은 링크로 열 수 없습니다".to_owned(),
        ));
    }
    // 함께 다루는 폴더는 지금 열리지 않으면 건너뛴다. 하나가 사라졌다고 다른 폴더의
    // 링크까지 못 열면 안 된다.
    let in_scope = scope.allow_external
        || is_inside(&path, &primary)
        || (scope.others)()
            .iter()
            .filter_map(|root| fs::canonicalize(root).ok())
            .any(|root| root.is_dir() && is_inside(&path, &root));
    if !in_scope {
        return Err(CoreError::InvalidInput(
            "작업 경로 밖의 파일은 열 수 없습니다".to_owned(),
        ));
    }
    resolved_file(path, &primary, target_line, max_bytes)
}

/// 확인을 마친 경로에 크기와 표시 이름을 붙인다. 작업 폴더 안이면 그 기준 상대 경로로,
/// 밖이면 다른 프로젝트의 동명 파일과 구분되게 전체 경로로 표시한다.
fn resolved_file(
    path: PathBuf,
    root: &Path,
    target_line: Option<usize>,
    max_bytes: u64,
) -> Result<ResolvedLinkedFile, CoreError> {
    let metadata = fs::metadata(&path)?;
    ensure_regular_file(&metadata, LINK_NOT_REGULAR_FILE)?;
    ensure_within_limit(&metadata, max_bytes)?;
    let relative_path = match path.strip_prefix(root) {
        Ok(relative) => relative.to_path_buf(),
        Err(_) => child_facing(&path),
    }
    .to_string_lossy()
    .replace('\\', "/");

    Ok(ResolvedLinkedFile {
        path,
        relative_path,
        size_bytes: metadata.len(),
        target_line,
        max_bytes,
    })
}

/// 링크 해석의 두 기준 경로를 먼저 정규화하고, 기준 폴더가 작업공간 안에 있는지 확인한다.
fn resolve_link_workspace(root: &Path, base: &Path) -> Result<(PathBuf, PathBuf), CoreError> {
    let root = fs::canonicalize(root)?;
    if !root.is_dir() {
        return Err(CoreError::InvalidInput(
            "작업 경로가 디렉터리가 아닙니다".to_owned(),
        ));
    }
    let base = fs::canonicalize(base)?;
    if !base.is_dir() || (base != root && !base.starts_with(&root)) {
        return Err(CoreError::InvalidInput(
            "링크 기준 경로가 작업 경로 밖에 있습니다".to_owned(),
        ));
    }
    Ok((root, base))
}

/// 전체 접근 채팅만 작업공간 밖의 정규화된 파일 경로를 허용한다.
fn resolve_link_target(
    root: &Path,
    base: &Path,
    path_text: &str,
    allow_external: bool,
) -> Result<PathBuf, CoreError> {
    let requested = PathBuf::from(path_text);
    let joined = if requested.is_absolute() {
        requested
    } else {
        base.join(requested)
    };
    let path = fs::canonicalize(&joined).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            CoreError::NotFound(format!("링크 파일을 찾을 수 없습니다: {path_text}"))
        } else {
            CoreError::Io(error)
        }
    })?;

    if !allow_external && (path == root || !path.starts_with(root)) {
        return Err(CoreError::InvalidInput(
            "작업 경로 밖의 파일은 열 수 없습니다".to_owned(),
        ));
    }
    Ok(path)
}

/// 루트 자신은 파일이 아니므로 안쪽으로 치지 않는다.
fn is_inside(path: &Path, root: &Path) -> bool {
    path != root && path.starts_with(root)
}

/// 미리보기를 그림으로 그릴 파일인지 확장자로 판정한다. 화면은 `<img>`로 그리기만 하므로
/// 내용이 확장자와 달라도 깨진 그림이 될 뿐 다른 해석으로 번지지 않는다. SVG는 텍스트라
/// 지금처럼 원문 미리보기로 둔다.
fn image_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => return None,
    })
}

fn parse_link_target(href: &str) -> Result<(String, Option<usize>), CoreError> {
    let mut target = href.trim();
    if target.starts_with('<') && target.ends_with('>') && target.len() > 2 {
        target = &target[1..target.len() - 1];
    }
    if target.is_empty()
        || target.starts_with('#')
        || has_external_scheme(target)
        || target.starts_with("//")
    {
        return Err(CoreError::InvalidInput(
            "로컬 파일 링크가 아닙니다".to_owned(),
        ));
    }

    if let Some((path, digits)) = split_line_suffix(target) {
        return Ok((path.to_owned(), Some(parse_line_number(digits)?)));
    }
    Ok((target.to_owned(), None))
}

/// 마크다운의 `#L12`와 편집기식 `:12` 표기에서 경로와 숫자 부분만 가른다.
/// 양의 정수 판정은 두 표기가 [`parse_line_number`] 한 벌을 공유한다.
fn split_line_suffix(target: &str) -> Option<(&str, &str)> {
    if let Some((path, fragment)) = target.rsplit_once('#') {
        if let Some(digits) = fragment.strip_prefix(['L', 'l']) {
            if is_line_suffix(path, digits) {
                return Some((path, digits));
            }
        }
    }

    if let Some((path, digits)) = target.rsplit_once(':') {
        if is_line_suffix(path, digits) {
            return Some((path, digits));
        }
    }
    None
}

fn is_line_suffix(path: &str, digits: &str) -> bool {
    !path.is_empty() && !digits.is_empty() && digits.bytes().all(|value| value.is_ascii_digit())
}

fn parse_line_number(value: &str) -> Result<usize, CoreError> {
    value
        .parse::<usize>()
        .ok()
        .filter(|line| *line > 0)
        .ok_or_else(|| CoreError::InvalidInput("줄 번호는 1 이상이어야 합니다".to_owned()))
}

fn has_external_scheme(target: &str) -> bool {
    let Some((scheme, _)) = target.split_once(':') else {
        return false;
    };
    if scheme.len() == 1 && scheme.as_bytes()[0].is_ascii_alphabetic() {
        return false;
    }
    !scheme.is_empty()
        && scheme
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '+' | '-' | '.'))
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};

    use tempfile::tempdir;

    use super::*;

    /// 작업 폴더 하나만 있는 채팅 범위. 권한별 경계 시험이 루트 목록과 무관하게 쓴다.
    fn with_workspace_scope<T>(
        root: &Path,
        allow_external: bool,
        read: impl FnOnce(&LinkScope<'_>) -> T,
    ) -> T {
        read(&LinkScope {
            primary: root.to_path_buf(),
            others: &Vec::new,
            denied: &|_| false,
            allow_external,
        })
    }

    fn read_chat_linked_file(
        root: &Path,
        href: &str,
        allow_external: bool,
    ) -> Result<LinkedFile, CoreError> {
        with_workspace_scope(root, allow_external, |scope| {
            read_scoped_linked_file(scope, href)
        })
    }

    fn read_chat_linked_file_download(
        root: &Path,
        href: &str,
        allow_external: bool,
    ) -> Result<LinkedFileDownload, CoreError> {
        with_workspace_scope(root, allow_external, |scope| {
            read_scoped_linked_file_download(scope, href)
        })
    }

    #[test]
    fn reads_relative_and_absolute_utf8_files_with_line_targets() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(root.join("src")).expect("workspace directories");
        let file = root.join("src/example.rs");
        fs::write(&file, "첫째 줄\nsecond line\nthird line\n").expect("source file");

        let relative = read_linked_file(&root, "src/example.rs#L2").expect("relative file");
        assert_eq!(relative.relative_path, "src/example.rs");
        assert_eq!(relative.target_line, Some(2));
        assert!(relative.content.contains("첫째 줄"));

        let absolute =
            read_linked_file(&root, &format!("{}:3", file.display())).expect("absolute file");
        assert_eq!(absolute.relative_path, "src/example.rs");
        assert_eq!(absolute.target_line, Some(3));
    }

    #[test]
    fn rejects_paths_outside_workspace_and_directories() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(root.join("src")).expect("workspace directories");
        fs::write(temp.path().join("outside.txt"), "secret").expect("outside file");

        assert!(matches!(
            read_linked_file(&root, "../outside.txt"),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            read_linked_file(
                &root,
                temp.path().join("outside.txt").to_string_lossy().as_ref()
            ),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            read_linked_file(&root, "src"),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            read_linked_file(&root, "missing.txt"),
            Err(CoreError::NotFound(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_workspace() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(&root).expect("workspace directory");
        let outside = temp.path().join("outside.txt");
        fs::write(&outside, "secret").expect("outside file");
        symlink(&outside, root.join("linked.txt")).expect("symlink");

        assert!(matches!(
            read_linked_file(&root, "linked.txt"),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(read_chat_linked_file(&root, "linked.txt", false).is_err());
        assert!(read_chat_linked_file_download(&root, "linked.txt", false).is_err());
        assert_eq!(
            read_chat_linked_file(&root, "linked.txt", true)
                .expect("full access symlink")
                .content,
            "secret"
        );
        assert_eq!(
            read_chat_linked_file_download(&root, "linked.txt", true)
                .expect("full access download")
                .bytes,
            b"secret"
        );
    }

    #[test]
    fn g10_bounded_read_measures_and_reads_through_one_handle() {
        let temp = tempdir().expect("temp directory");
        let path = temp.path().join("grown.txt");
        fs::write(&path, b"0123456789").expect("source file");

        // 자리 확인이 끝난 뒤 파일이 상한을 넘게 자란 상황: 경로로 다시 열어 통째로 읽는
        // 구현은 10바이트를 돌려주고, 핸들에서 상한을 다시 지키는 구현은 거절한다.
        assert!(matches!(
            read_bounded(&path, 9),
            Err(CoreError::TooLarge(9))
        ));
        assert_eq!(
            read_bounded(&path, 10).expect("within limit"),
            b"0123456789"
        );
        assert!(matches!(
            read_bounded(temp.path(), 10),
            Err(CoreError::InvalidInput(_))
        ));
    }

    /// 잰 크기보다 실제 바이트가 많은 파일 — 리눅스 `/proc` 항목은 stat 길이가 0 이다.
    /// 경로 stat 상한만 보는 구현은 통째로 읽어 돌려주고, 핸들에서 상한을 다시 지키는
    /// 구현만 거절한다. 그래서 이 시험이 `take(max + 1)` 가드를 고정한다.
    #[cfg(target_os = "linux")]
    #[test]
    fn g10_bounded_read_rejects_bytes_beyond_the_limit_even_when_stat_understates() {
        let status = Path::new("/proc/self/status");
        let stat_len = fs::metadata(status).expect("proc metadata").len();
        assert_eq!(
            stat_len, 0,
            "/proc 항목은 길이를 0 으로 보고해야 전제가 성립한다"
        );
        assert!(matches!(
            read_bounded(status, 8),
            Err(CoreError::TooLarge(8))
        ));
        let whole = read_bounded(status, MAX_LINKED_FILE_BYTES).expect("within limit");
        assert!(whole.len() > 8);
    }

    #[test]
    fn rejects_binary_and_oversized_files() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(&root).expect("workspace directory");
        fs::write(root.join("binary.bin"), [0xff, 0xfe, 0xfd]).expect("binary file");
        let large = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(root.join("large.txt"))
            .expect("large file");
        large
            .set_len(MAX_LINKED_FILE_BYTES + 1)
            .expect("large file length");

        assert!(matches!(
            read_linked_file(&root, "binary.bin"),
            Err(CoreError::InvalidInput(message))
                if message == "미리보기를 지원하지 않는 파일입니다."
        ));
        assert!(matches!(
            read_linked_file(&root, "large.txt"),
            Err(CoreError::TooLarge(MAX_LINKED_FILE_BYTES))
        ));
    }

    #[test]
    fn full_access_keeps_file_type_size_and_link_validation() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("workspace");
        fs::write(temp.path().join("binary.bin"), [0xff, 0xfe]).expect("binary");
        let large = File::create(temp.path().join("large.txt")).expect("large");
        large
            .set_len(MAX_LINKED_FILE_BYTES + 1)
            .expect("preview size");
        assert!(matches!(
            read_chat_linked_file(&root, "../binary.bin", true),
            Err(CoreError::InvalidInput(_))
        ));
        assert_eq!(
            read_chat_linked_file_download(&root, "../binary.bin", true)
                .expect("binary download")
                .bytes,
            [0xff, 0xfe]
        );
        assert!(matches!(
            read_chat_linked_file(&root, "../large.txt", true),
            Err(CoreError::TooLarge(MAX_LINKED_FILE_BYTES))
        ));
        large
            .set_len(MAX_LINKED_FILE_DOWNLOAD_BYTES + 1)
            .expect("download size");
        assert!(matches!(
            read_chat_linked_file_download(&root, "../large.txt", true),
            Err(CoreError::TooLarge(MAX_LINKED_FILE_DOWNLOAD_BYTES))
        ));
        for href in ["..", "https://example.com/file", "file:///etc/passwd"] {
            assert!(read_chat_linked_file(&root, href, true).is_err(), "{href}");
            assert!(
                read_chat_linked_file_download(&root, href, true).is_err(),
                "{href}"
            );
        }
        assert!(matches!(
            read_chat_linked_file(&root, "../missing.txt", true),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn downloads_binary_files_without_weakening_preview_validation() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(&root).expect("workspace directory");
        let bytes = [0x50, 0x4b, 0x03, 0x04, 0xff, 0x00];
        fs::write(root.join("sample.xlsx"), bytes).expect("binary file");

        assert!(matches!(
            read_linked_file(&root, "sample.xlsx"),
            Err(CoreError::InvalidInput(_))
        ));
        let download =
            read_linked_file_download(&root, "sample.xlsx").expect("download binary file");
        assert_eq!(download.relative_path, "sample.xlsx");
        assert_eq!(download.bytes, bytes);
        assert_eq!(download.size_bytes, bytes.len() as u64);
    }

    #[test]
    fn saves_download_to_a_validated_destination() {
        let temp = tempdir().expect("temp directory");
        let destination = temp.path().join("saved.xlsx");
        let download = LinkedFileDownload {
            relative_path: "context/db/source.xlsx".to_owned(),
            bytes: vec![0x50, 0x4b, 0x03, 0x04],
            size_bytes: 4,
        };

        save_linked_file_download(&download, &destination).expect("save download");
        assert_eq!(fs::read(destination).expect("saved bytes"), download.bytes);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_download_destinations() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().expect("temp directory");
        let target = temp.path().join("target.xlsx");
        fs::write(&target, b"original").expect("target file");
        let destination = temp.path().join("linked.xlsx");
        symlink(&target, &destination).expect("destination symlink");
        let download = LinkedFileDownload {
            relative_path: "source.xlsx".to_owned(),
            bytes: b"replacement".to_vec(),
            size_bytes: 11,
        };

        assert!(matches!(
            save_linked_file_download(&download, &destination),
            Err(CoreError::InvalidInput(_))
        ));
        assert_eq!(fs::read(target).expect("target bytes"), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn saving_over_a_hard_linked_destination_leaves_the_other_link_untouched() {
        let temp = tempdir().expect("temp directory");
        let other = temp.path().join("other.xlsx");
        fs::write(&other, b"original").expect("other file");
        let destination = temp.path().join("saved.xlsx");
        fs::hard_link(&other, &destination).expect("destination hard link");
        let download = LinkedFileDownload {
            relative_path: "source.xlsx".to_owned(),
            bytes: b"replacement".to_vec(),
            size_bytes: 11,
        };

        save_linked_file_download(&download, &destination).expect("save download");
        assert_eq!(fs::read(&destination).expect("saved bytes"), b"replacement");
        assert_eq!(fs::read(&other).expect("other bytes"), b"original");
        assert_eq!(staging_leftovers(temp.path()), 0);
    }

    #[test]
    fn copies_a_large_source_to_the_destination_without_reading_it_whole() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(&root).expect("workspace directory");
        // 한 조각보다 큰 파일이어야 진행 보고가 여러 번 일어나는 갈래를 지난다.
        let bytes = vec![7_u8; COPY_CHUNK_BYTES * 2 + 5];
        fs::write(root.join("big.bin"), &bytes).expect("source file");
        let source = read_linked_file_source_from(&root, &root, "big.bin", u64::MAX)
            .expect("resolve source");
        assert_eq!(source.size_bytes, bytes.len() as u64);

        let destination = temp.path().join("saved.bin");
        let mut reported = Vec::new();
        let copy = copy_linked_file_source(
            &source,
            &destination,
            &mut |copied| reported.push(copied),
            &|| false,
        )
        .expect("copy source");

        assert!(!copy.cancelled);
        assert_eq!(copy.copied_bytes, bytes.len() as u64);
        assert_eq!(reported.last().copied(), Some(bytes.len() as u64));
        assert!(reported.len() > 1, "조각마다 진행을 알려야 한다");
        assert_eq!(fs::read(&destination).expect("saved bytes"), bytes);
        assert_eq!(staging_leftovers(temp.path()), 0);
    }

    #[test]
    fn a_cancelled_copy_leaves_the_previous_destination_file_in_place() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(&root).expect("workspace directory");
        fs::write(root.join("big.bin"), vec![1_u8; COPY_CHUNK_BYTES * 2]).expect("source file");
        let destination = temp.path().join("saved.bin");
        fs::write(&destination, b"previous").expect("existing destination");
        let source = read_linked_file_source_from(&root, &root, "big.bin", u64::MAX)
            .expect("resolve source");

        let copy = copy_linked_file_source(&source, &destination, &mut |_| {}, &|| true)
            .expect("cancelled copy is not a failure");

        assert!(copy.cancelled);
        assert_eq!(copy.copied_bytes, 0);
        assert_eq!(
            fs::read(&destination).expect("destination bytes"),
            b"previous"
        );
        assert_eq!(staging_leftovers(temp.path()), 0);
    }

    #[test]
    fn source_resolution_keeps_the_workspace_boundary_and_its_own_limit() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(&root).expect("workspace directory");
        fs::write(temp.path().join("outside.txt"), "secret").expect("outside file");
        fs::write(root.join("inside.txt"), "hello").expect("inside file");

        assert!(matches!(
            read_linked_file_source_from(&root, &root, "../outside.txt", u64::MAX),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            read_linked_file_source_from(&root, &root, "inside.txt", 2),
            Err(CoreError::TooLarge(2))
        ));
    }

    /// 중간 파일이 남았는지 센다. 실패·취소 갈래가 목적지 폴더를 더럽히지 않아야 한다.
    fn staging_leftovers(directory: &Path) -> usize {
        fs::read_dir(directory)
            .expect("destination directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".part"))
            .count()
    }

    #[test]
    fn rejects_non_file_links_and_invalid_line_numbers() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(&root).expect("workspace directory");

        for href in [
            "https://example.com/file",
            "mailto:test@example.com",
            "#section",
            "//example.com/file",
        ] {
            assert!(matches!(
                read_linked_file(&root, href),
                Err(CoreError::InvalidInput(_))
            ));
        }
        assert!(matches!(
            parse_link_target("src/main.rs:0"),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(matches!(
            parse_link_target("src/main.rs#L0"),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn previews_images_as_data_urls_within_their_own_limit() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(&root).expect("workspace directory");
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        fs::write(root.join("shot.PNG"), png).expect("image file");

        let preview = read_linked_file(&root, "shot.PNG").expect("image preview");
        assert_eq!(preview.content, "");
        assert_eq!(
            preview.image_data_url.as_deref(),
            Some(format!("data:image/png;base64,{}", STANDARD.encode(png)).as_str())
        );
        assert_eq!(preview.size_bytes, png.len() as u64);

        // 텍스트 상한(5MB)을 넘어도 이미지 상한(30MB) 안이면 열린다.
        let big = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(root.join("big.jpg"))
            .expect("big image");
        big.set_len(MAX_LINKED_FILE_BYTES + 1)
            .expect("big image length");
        assert!(read_linked_file(&root, "big.jpg")
            .expect("image over text limit")
            .image_data_url
            .is_some_and(|url| url.starts_with("data:image/jpeg;base64,")));

        big.set_len(MAX_LINKED_IMAGE_BYTES + 1)
            .expect("huge image length");
        assert!(matches!(
            read_linked_file(&root, "big.jpg"),
            Err(CoreError::TooLarge(MAX_LINKED_IMAGE_BYTES))
        ));
    }

    #[test]
    fn text_over_every_limit_reports_the_text_limit() {
        let temp = tempdir().expect("temp directory");
        let root = temp.path().join("workspace");
        fs::create_dir_all(&root).expect("workspace directory");
        let huge = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(root.join("huge.log"))
            .expect("huge log");
        huge.set_len(MAX_LINKED_IMAGE_BYTES + 1)
            .expect("huge log length");

        assert!(matches!(
            read_linked_file(&root, "huge.log"),
            Err(CoreError::TooLarge(MAX_LINKED_FILE_BYTES))
        ));
    }

    #[test]
    fn scoped_links_open_files_in_every_root_but_not_denied_or_outside() {
        let temp = tempdir().expect("temp directory");
        let primary = temp.path().join("project");
        let cypress = temp.path().join("project-cypress");
        let outside = temp.path().join("other");
        for dir in [&primary, &cypress, &outside] {
            fs::create_dir_all(dir.join("sub")).expect("directories");
        }
        fs::write(primary.join("sub/notes.md"), "# 메모\n").expect("primary file");
        fs::write(cypress.join("sub/result.json"), "{}\n").expect("cypress file");
        fs::write(cypress.join("cypress.env.json"), "{\"password\":\"x\"}").expect("env file");
        fs::write(outside.join("secret.txt"), "no").expect("outside file");
        let other_calls = std::cell::Cell::new(0);
        let others = || {
            other_calls.set(other_calls.get() + 1);
            vec![cypress.clone(), temp.path().join("missing")]
        };
        let denied = |path: &Path| path.ends_with("cypress.env.json");
        let scope = LinkScope {
            primary: primary.clone(),
            others: &others,
            denied: &denied,
            allow_external: false,
        };

        let relative = read_scoped_linked_file(&scope, "sub/notes.md").expect("primary link");
        assert_eq!(relative.relative_path, "sub/notes.md");
        // 작업 폴더 안 링크는 나머지 루트를 확인하지 않는다.
        assert_eq!(other_calls.get(), 0);

        let absolute = cypress.join("sub/result.json");
        let other_root = read_scoped_linked_file(&scope, absolute.to_string_lossy().as_ref())
            .expect("absolute link into another root");
        let expected = child_facing(&fs::canonicalize(&absolute).expect("canonical"))
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(other_root.relative_path, expected);
        assert_eq!(other_root.content, "{}\n");
        // 상대 링크로 옆 루트에 닿아도 그 루트 안이면 열린다.
        assert!(read_scoped_linked_file(&scope, "../project-cypress/sub/result.json").is_ok());
        assert!(
            read_scoped_linked_file_download(&scope, absolute.to_string_lossy().as_ref()).is_ok()
        );

        for href in [
            cypress
                .join("cypress.env.json")
                .to_string_lossy()
                .into_owned(),
            "../project-cypress/cypress.env.json".to_owned(),
        ] {
            assert!(matches!(
                read_scoped_linked_file(&scope, &href),
                Err(CoreError::InvalidInput(message)) if message == "이 파일은 링크로 열 수 없습니다"
            ));
            assert!(read_scoped_linked_file_download(&scope, &href).is_err());
        }
        for href in [
            outside.join("secret.txt").to_string_lossy().into_owned(),
            "../other/secret.txt".to_owned(),
        ] {
            assert!(matches!(
                read_scoped_linked_file(&scope, &href),
                Err(CoreError::InvalidInput(message)) if message == "작업 경로 밖의 파일은 열 수 없습니다"
            ));
        }
    }
}
