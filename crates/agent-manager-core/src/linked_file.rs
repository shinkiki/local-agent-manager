use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::CoreError;

const MAX_LINKED_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LINKED_FILE_DOWNLOAD_BYTES: u64 = 100 * 1024 * 1024;

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

struct ResolvedLinkedFile {
    path: PathBuf,
    relative_path: String,
    size_bytes: u64,
    target_line: Option<usize>,
}

pub(crate) fn read_linked_file(root: &Path, href: &str) -> Result<LinkedFile, CoreError> {
    read_linked_file_from(root, root, href)
}

pub(crate) fn read_linked_file_from(
    root: &Path,
    base: &Path,
    href: &str,
) -> Result<LinkedFile, CoreError> {
    let resolved = resolve_linked_file(root, base, href, MAX_LINKED_FILE_BYTES)?;
    let bytes = fs::read(&resolved.path)?;
    let content = String::from_utf8(bytes)
        .map_err(|_| CoreError::InvalidInput("미리보기를 지원하지 않는 파일입니다.".to_owned()))?;

    Ok(LinkedFile {
        relative_path: resolved.relative_path,
        content,
        size_bytes: resolved.size_bytes,
        target_line: resolved.target_line,
    })
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
    let resolved = resolve_linked_file(root, base, href, MAX_LINKED_FILE_DOWNLOAD_BYTES)?;
    Ok(LinkedFileDownload {
        bytes: fs::read(&resolved.path)?,
        relative_path: resolved.relative_path,
        size_bytes: resolved.size_bytes,
    })
}

pub fn save_linked_file_download(
    file: &LinkedFileDownload,
    destination: &Path,
) -> Result<(), CoreError> {
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
    fs::write(destination, &file.bytes)?;
    Ok(())
}

fn resolve_linked_file(
    root: &Path,
    base: &Path,
    href: &str,
    max_bytes: u64,
) -> Result<ResolvedLinkedFile, CoreError> {
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

    let (path_text, target_line) = parse_link_target(href)?;
    let requested = PathBuf::from(&path_text);
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

    if path == root || !path.starts_with(&root) {
        return Err(CoreError::InvalidInput(
            "작업 경로 밖의 파일은 열 수 없습니다".to_owned(),
        ));
    }

    let metadata = fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "링크 대상이 일반 파일이 아닙니다".to_owned(),
        ));
    }
    if metadata.len() > max_bytes {
        return Err(CoreError::TooLarge(max_bytes));
    }

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

    if let Some((path, line)) = split_hash_line(target)? {
        return Ok((path.to_owned(), Some(line)));
    }
    if let Some((path, suffix)) = target.rsplit_once(':') {
        if !path.is_empty()
            && !suffix.is_empty()
            && suffix.chars().all(|value| value.is_ascii_digit())
        {
            let line = parse_line_number(suffix)?;
            return Ok((path.to_owned(), Some(line)));
        }
    }
    Ok((target.to_owned(), None))
}

fn split_hash_line(target: &str) -> Result<Option<(&str, usize)>, CoreError> {
    let Some((path, fragment)) = target.rsplit_once('#') else {
        return Ok(None);
    };
    if path.is_empty() || fragment.len() < 2 || !fragment.starts_with(['L', 'l']) {
        return Ok(None);
    }
    let digits = &fragment[1..];
    if !digits.chars().all(|value| value.is_ascii_digit()) {
        return Ok(None);
    }
    parse_line_number(digits).map(|line| Some((path, line)))
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
