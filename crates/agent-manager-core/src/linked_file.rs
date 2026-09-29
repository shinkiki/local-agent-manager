use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::file_kind::ensure_within_limit;
use crate::CoreError;

const MAX_LINKED_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LINKED_FILE_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;
/// 이어 복사할 때 한 번에 옮기는 양. 진행률을 알리는 간격이기도 하다. 파일 전체를
/// 메모리에 올리지 않는 것이 이 경로의 존재 이유이므로 상수는 파일 크기와 무관하다.
const COPY_CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedFile {
    pub relative_path: String,
    pub content: String,
    pub size_bytes: u64,
    pub target_line: Option<usize>,
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
}

impl ResolvedLinkedFile {
    fn into_preview(self) -> Result<LinkedFile, CoreError> {
        let bytes = fs::read(self.path)?;
        let content = String::from_utf8(bytes).map_err(|_| {
            CoreError::InvalidInput("미리보기를 지원하지 않는 파일입니다.".to_owned())
        })?;
        Ok(LinkedFile {
            relative_path: self.relative_path,
            content,
            size_bytes: self.size_bytes,
            target_line: self.target_line,
        })
    }

    fn into_download(self) -> Result<LinkedFileDownload, CoreError> {
        Ok(LinkedFileDownload {
            bytes: fs::read(self.path)?,
            relative_path: self.relative_path,
            size_bytes: self.size_bytes,
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

pub(crate) fn read_linked_file(root: &Path, href: &str) -> Result<LinkedFile, CoreError> {
    read_linked_file_from(root, root, href)
}

pub(crate) fn read_linked_file_from(
    root: &Path,
    base: &Path,
    href: &str,
) -> Result<LinkedFile, CoreError> {
    resolve_linked_file(root, base, href, MAX_LINKED_FILE_BYTES)?.into_preview()
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
    let destination = validated_destination(destination)?;
    fs::write(destination, &file.bytes)?;
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
    let path = resolve_link_target(&root, &base, &path_text)?;
    let metadata = fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "링크 대상이 일반 파일이 아닙니다".to_owned(),
        ));
    }
    ensure_within_limit(&metadata, max_bytes)?;

    let relative_path = path
        .strip_prefix(&root)
        .map_err(|_| CoreError::InvalidInput("작업 경로 밖의 파일은 열 수 없습니다".to_owned()))?
        .to_string_lossy()
        .replace('\\', "/");

    Ok(ResolvedLinkedFile {
        path,
        relative_path,
        size_bytes: metadata.len(),
        target_line,
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

/// 링크 문자열에서 얻은 경로를 기준 폴더에 붙여 정규화하고 작업공간 안으로 제한한다.
fn resolve_link_target(root: &Path, base: &Path, path_text: &str) -> Result<PathBuf, CoreError> {
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

    if path == root || !path.starts_with(root) {
        return Err(CoreError::InvalidInput(
            "작업 경로 밖의 파일은 열 수 없습니다".to_owned(),
        ));
    }
    Ok(path)
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
}
