//! 등록 폴더 안의 항목을 만들고·이름 바꾸고·옮기고·복제하고·지우는 한 곳.
//!
//! 파일 화면의 트리는 지금까지 Markdown 새 문서 만들기(`create_doc`)와 저장(`save_doc`)만
//! 할 수 있었다. 우클릭 메뉴가 일반 파일과 폴더까지 다루게 되면서, 경로 경계를 지키는
//! 규칙(G10)을 쓰기 갈래마다 다시 적지 않도록 이 다섯 입구를 한 모듈에 모은다.
//!
//! 모든 입구가 지키는 것:
//! - 등록 폴더 자체(빈 상대 경로)는 대상이 아니다. 등록 해제는 `delete_doc_root`의 일이고,
//!   그쪽은 원본을 지우지 않는다.
//! - 대상 항목은 **부모만** 정규화하고 마지막 이름은 그대로 붙인다. 끝이 심볼릭 링크면
//!   따라가지 않고 거절한다 — 트리가 링크를 보여 주지 않으므로(`is_hidden_document_child`)
//!   화면에서 고를 수 없는 항목이고, 따라가면 링크가 가리키는 곳을 지우거나 옮긴다.
//! - 새 이름은 경로 구분자 없는 한 칸이며, 이미 있는 항목을 덮어쓰지 않는다.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::document_tree::{document_entry, path_outside_root, resolve_doc_path, resolve_root};
use crate::domain::DocumentEntry;
use crate::path_guard::{self, CurDirPolicy};
use crate::CoreError;

/// 폴더 삭제 전에 세어 보는 하위 항목 수의 상한. 화면은 "N개 이상"으로만 보여 주면 되므로
/// 아주 큰 폴더를 끝까지 훑지 않는다.
const DELETE_COUNT_LIMIT: u64 = 10_000;
/// 복제본 이름을 고르는 시도 횟수. `이름 복사본`, `이름 복사본 2` … 순서다.
const DUPLICATE_NAME_ATTEMPTS: u32 = 100;
/// 파일 이름 한 칸의 바이트 상한. 흔한 파일 시스템(ext4·APFS·NTFS)의 한 칸 상한과 같다.
const MAX_ENTRY_NAME_BYTES: usize = 255;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentEntryKind {
    File,
    Directory,
}

/// 삭제 결과. 비어 있지 않은 폴더를 `recursive` 없이 지우라고 하면 아무것도 지우지 않고
/// 그 안의 수만 돌려준다 — 화면은 그 수를 보여 주며 한 번 더 확인받고 다시 부른다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDeleteResult {
    pub deleted: bool,
    /// 하위 파일 수(숨김 항목 포함). 다 세지 못했으면 `truncated`가 켜진다.
    pub files: u64,
    /// 하위 폴더 수(숨김 항목 포함).
    pub directories: u64,
    pub truncated: bool,
}

/// `parent_path` 폴더 안에 빈 파일이나 빈 폴더 하나를 만든다. 같은 이름이 있으면 `Conflict`.
pub fn create_document_entry(
    app_data_dir: &Path,
    root_id: &str,
    parent_path: &str,
    name: &str,
    kind: DocumentEntryKind,
) -> Result<DocumentEntry, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let parent = resolve_directory(&root, parent_path)?;
    let name = validate_entry_name(name)?;
    let path = parent.join(name);
    let created = match kind {
        // 있는지 먼저 보고 만들면 그 사이에 생긴 파일을 덮는다. `create_new`가 한 번에 판정한다.
        DocumentEntryKind::File => fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map(drop),
        DocumentEntryKind::Directory => fs::create_dir(&path),
    };
    created.map_err(already_exists_as_conflict)?;
    entry_at(&root, &path)
}

/// 항목 이름만 바꾼다. 폴더는 그대로다.
pub fn rename_document_entry(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
    new_name: &str,
) -> Result<DocumentEntry, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let (source, _) = resolve_existing_entry(&root, relative_path)?;
    let new_name = validate_entry_name(new_name)?;
    let parent = source.parent().ok_or_else(path_outside_root)?;
    let target = parent.join(new_name);
    if target == source {
        return entry_at(&root, &source);
    }
    rename_without_overwrite(&source, &target)?;
    entry_at(&root, &target)
}

/// 항목을 다른 폴더로 옮긴다. `target_parent_path`가 비어 있으면 등록 폴더 맨 위다.
pub fn move_document_entry(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
    target_parent_path: &str,
) -> Result<DocumentEntry, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let (source, metadata) = resolve_existing_entry(&root, relative_path)?;
    let target_parent = resolve_directory(&root, target_parent_path)?;
    if source.parent() == Some(target_parent.as_path()) {
        return entry_at(&root, &source);
    }
    // 폴더를 자기 안으로 옮기면 rename이 실패하기는 하지만, 그 문구(EINVAL)는 사용자가
    // 읽을 수 없으므로 먼저 거른다.
    if metadata.is_dir() && target_parent.starts_with(&source) {
        return Err(CoreError::InvalidInput(
            "폴더를 자기 자신이나 그 하위 폴더로 옮길 수 없습니다".to_owned(),
        ));
    }
    let name = source.file_name().ok_or_else(path_outside_root)?;
    let target = target_parent.join(name);
    rename_without_overwrite(&source, &target)?;
    entry_at(&root, &target)
}

/// 파일 하나를 같은 폴더에 `이름 복사본.확장자`로 복제한다. 폴더 복제는 제공하지 않는다.
pub fn duplicate_document_file(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
) -> Result<DocumentEntry, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let (source, metadata) = resolve_existing_entry(&root, relative_path)?;
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "파일만 복제할 수 있습니다".to_owned(),
        ));
    }
    let parent = source.parent().ok_or_else(path_outside_root)?;
    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(path_outside_root)?;
    let mut reader = File::open(&source)?;
    for attempt in 1..=DUPLICATE_NAME_ATTEMPTS {
        let target = parent.join(duplicate_name(&file_name, attempt));
        let mut writer = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        };
        // 복사 도중 실패하면 반쪽 파일을 남기지 않는다. 이 호출이 만든 파일이라 지워도 된다.
        if let Err(error) = io::copy(&mut reader, &mut writer) {
            drop(writer);
            let _ = fs::remove_file(&target);
            return Err(error.into());
        }
        drop(writer);
        let _ = fs::set_permissions(&target, metadata.permissions());
        return entry_at(&root, &target);
    }
    Err(CoreError::Conflict(
        "복제본 이름을 정하지 못했습니다. 같은 이름의 복사본을 정리한 뒤 다시 시도하세요."
            .to_owned(),
    ))
}

/// 항목을 지운다. **휴지통을 거치지 않으므로 되돌릴 수 없다** — 화면이 먼저 확인받는다.
///
/// 폴더는 비어 있을 때만 바로 지운다. 무언가 들어 있으면 `recursive`가 켜져 있을 때만
/// 통째로 지우고, 아니면 지우지 않고 그 안의 수를 돌려준다. 화면에 보이지 않는 숨김
/// 항목도 센다 — 화면이 "빈 폴더"라고 믿고 지웠는데 `.env` 같은 파일이 함께 사라지면 안 된다.
pub fn delete_document_entry(
    app_data_dir: &Path,
    root_id: &str,
    relative_path: &str,
    recursive: bool,
) -> Result<DocumentDeleteResult, CoreError> {
    let root = resolve_root(app_data_dir, root_id)?;
    let (path, metadata) = resolve_existing_entry(&root, relative_path)?;
    if !metadata.is_dir() {
        fs::remove_file(&path)?;
        return Ok(DocumentDeleteResult {
            deleted: true,
            files: 0,
            directories: 0,
            truncated: false,
        });
    }
    if recursive {
        // 표준 remove_dir_all은 하위의 심볼릭 링크를 따라가지 않고 링크만 지운다.
        fs::remove_dir_all(&path)?;
        return Ok(DocumentDeleteResult {
            deleted: true,
            files: 0,
            directories: 0,
            truncated: false,
        });
    }
    let mut counts = DocumentDeleteResult {
        deleted: false,
        files: 0,
        directories: 0,
        truncated: false,
    };
    count_children(&path, &mut counts)?;
    if counts.files == 0 && counts.directories == 0 {
        fs::remove_dir(&path)?;
        counts.deleted = true;
    }
    Ok(counts)
}

fn count_children(directory: &Path, counts: &mut DocumentDeleteResult) -> Result<(), CoreError> {
    for item in fs::read_dir(directory)? {
        if counts.files + counts.directories >= DELETE_COUNT_LIMIT {
            counts.truncated = true;
            return Ok(());
        }
        let item = item?;
        let file_type = item.file_type()?;
        if file_type.is_dir() {
            counts.directories += 1;
            count_children(&item.path(), counts)?;
        } else {
            counts.files += 1;
        }
    }
    Ok(())
}

/// `이름.확장자` → `이름 복사본.확장자`, 두 번째부터 `이름 복사본 2.확장자`.
/// 확장자가 없거나 이름이 점으로 시작하면 이름 전체 뒤에 붙인다.
fn duplicate_name(file_name: &str, attempt: u32) -> String {
    let suffix = if attempt <= 1 {
        " 복사본".to_owned()
    } else {
        format!(" 복사본 {attempt}")
    };
    match file_name.rfind('.') {
        Some(dot) if dot > 0 => format!("{}{suffix}{}", &file_name[..dot], &file_name[dot..]),
        _ => format!("{file_name}{suffix}"),
    }
}

/// 이미 있는 대상을 덮지 않는 이름 바꾸기. 대상이 있는지 보고 나서 rename하므로 그 사이에
/// 다른 프로그램이 같은 이름을 만들면 덮일 수 있다 — 플랫폼마다 다른 "덮지 않는 rename"
/// 호출을 들이는 대신, 사람이 메뉴로 부르는 한 번의 작업이라는 점에서 이 틈을 받아들인다.
///
/// 대소문자만 바꾸는 이름 변경(`note.md` → `Note.md`)은 대소문자를 가리지 않는 파일
/// 시스템에서 "대상이 이미 있음"으로 보이므로, 이름이 대소문자만 다르고 같은 파일을
/// 가리킬 때는 막지 않는다. 이름 비교를 함께 하는 것은 정규화가 링크를 따라가기 때문이다 —
/// `a.md`를 가리키는 링크 `link.md`가 있을 때 `a.md`를 `link.md`로 바꾸면 그 링크가 덮인다.
fn rename_without_overwrite(source: &Path, target: &Path) -> Result<(), CoreError> {
    // G10: canonicalize가 같은 곳을 가리켜도 기존 링크는 별개의 항목이므로 덮지 않는다.
    if fs::symlink_metadata(target)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !same_entry(source, target))
    {
        return Err(name_taken());
    }
    fs::rename(source, target)?;
    Ok(())
}

fn same_entry(left: &Path, right: &Path) -> bool {
    let case_only = match (left.file_name(), right.file_name()) {
        (Some(left), Some(right)) => {
            left.to_string_lossy().to_lowercase() == right.to_string_lossy().to_lowercase()
        }
        _ => false,
    };
    if !case_only || left.parent() != right.parent() {
        return false;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn name_taken() -> CoreError {
    CoreError::Conflict("같은 이름의 항목이 이미 있습니다. 다른 이름을 쓰세요.".to_owned())
}

fn already_exists_as_conflict(error: io::Error) -> CoreError {
    if error.kind() == io::ErrorKind::AlreadyExists {
        name_taken()
    } else {
        error.into()
    }
}

/// 새 이름 한 칸을 검사한다. 경로 구분자·`.`·`..`를 막아 한 칸이 루트 밖이나 다른 폴더를
/// 가리킬 길을 없애고, 점으로 시작하는 이름은 목록에서 숨겨져 만든 직후 사라져 보이므로 막는다.
fn validate_entry_name(name: &str) -> Result<&str, CoreError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CoreError::InvalidInput("이름을 입력하세요".to_owned()));
    }
    if name.len() > MAX_ENTRY_NAME_BYTES {
        return Err(CoreError::InvalidInput("이름이 너무 깁니다".to_owned()));
    }
    if name.starts_with('.') {
        return Err(CoreError::InvalidInput(
            "점(.)으로 시작하는 이름은 쓸 수 없습니다".to_owned(),
        ));
    }
    let forbidden: &[char] = if cfg!(windows) {
        &['/', '\\', '\0', '<', '>', ':', '"', '|', '?', '*']
    } else {
        &['/', '\\', '\0']
    };
    if name.contains(forbidden) {
        return Err(CoreError::InvalidInput(
            "이름에 쓸 수 없는 문자가 있습니다".to_owned(),
        ));
    }
    Ok(name)
}

/// 이미 있는 항목 하나. 부모만 정규화해 등록 폴더 안인지 보고, 마지막 이름은 따라가지 않는다.
fn resolve_existing_entry(
    root: &Path,
    relative: &str,
) -> Result<(PathBuf, fs::Metadata), CoreError> {
    let relative_path = Path::new(relative);
    match path_guard::classify_relative_path(relative_path, CurDirPolicy::Reject) {
        None => {}
        Some(path_guard::RelativePathIssue::Empty) => {
            return Err(CoreError::InvalidInput(
                "등록 폴더 자체는 바꾸거나 지울 수 없습니다".to_owned(),
            ));
        }
        Some(_) => return Err(path_outside_root()),
    }
    let joined = root.join(relative_path);
    let name = joined.file_name().ok_or_else(path_outside_root)?;
    let parent = joined.parent().ok_or_else(path_outside_root)?;
    let parent = fs::canonicalize(parent).map_err(missing_entry)?;
    if !parent.starts_with(root) {
        return Err(path_outside_root());
    }
    let path = parent.join(name);
    let metadata = fs::symlink_metadata(&path).map_err(missing_entry)?;
    if metadata.file_type().is_symlink() || !(metadata.is_dir() || metadata.is_file()) {
        return Err(CoreError::InvalidInput(
            "링크나 특수 파일은 이 메뉴로 다룰 수 없습니다".to_owned(),
        ));
    }
    Ok((path, metadata))
}

/// 이미 있는 폴더 하나. 빈 경로는 등록 폴더 자신이다.
fn resolve_directory(root: &Path, relative: &str) -> Result<PathBuf, CoreError> {
    let path = if relative.trim().is_empty() {
        root.to_path_buf()
    } else {
        resolve_doc_path(root, relative, true).map_err(|error| match error {
            CoreError::Io(io) => missing_entry(io),
            other => other,
        })?
    };
    if !path.is_dir() {
        return Err(CoreError::InvalidInput(
            "대상 폴더가 폴더가 아닙니다".to_owned(),
        ));
    }
    Ok(path)
}

fn missing_entry(error: io::Error) -> CoreError {
    if error.kind() == io::ErrorKind::NotFound {
        CoreError::NotFound(
            "항목을 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 시도하세요.".to_owned(),
        )
    } else {
        error.into()
    }
}

fn entry_at(root: &Path, path: &Path) -> Result<DocumentEntry, CoreError> {
    let metadata = fs::symlink_metadata(path)?;
    document_entry(root, path, &metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::add_doc_root;

    struct Fixture {
        _temp: tempfile::TempDir,
        app_data: PathBuf,
        docs: PathBuf,
        root_id: String,
    }

    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().expect("temp");
        let app_data = temp.path().join("app");
        let docs = temp.path().join("docs");
        fs::create_dir_all(&app_data).unwrap();
        fs::create_dir_all(&docs).unwrap();
        let root =
            add_doc_root(&app_data, "docs", docs.to_string_lossy().as_ref(), false).expect("root");
        let docs = fs::canonicalize(&docs).unwrap();
        Fixture {
            _temp: temp,
            app_data,
            docs,
            root_id: root.root.id,
        }
    }

    #[test]
    fn creates_file_and_folder_without_overwriting() {
        let f = fixture();
        let folder = create_document_entry(
            &f.app_data,
            &f.root_id,
            "",
            "notes",
            DocumentEntryKind::Directory,
        )
        .expect("folder");
        assert!(folder.is_directory);
        let file = create_document_entry(
            &f.app_data,
            &f.root_id,
            "notes",
            "a.txt",
            DocumentEntryKind::File,
        )
        .expect("file");
        assert_eq!(file.relative_path, "notes/a.txt");
        fs::write(f.docs.join("notes/a.txt"), "keep").unwrap();
        let again = create_document_entry(
            &f.app_data,
            &f.root_id,
            "notes",
            "a.txt",
            DocumentEntryKind::File,
        );
        assert!(matches!(again, Err(CoreError::Conflict(_))));
        assert_eq!(
            fs::read_to_string(f.docs.join("notes/a.txt")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn refuses_names_that_escape_or_hide() {
        let f = fixture();
        for name in ["", "  ", "../x", "a/b", ".env", "..", "."] {
            let result =
                create_document_entry(&f.app_data, &f.root_id, "", name, DocumentEntryKind::File);
            assert!(
                matches!(result, Err(CoreError::InvalidInput(_))),
                "{name:?} 이 통과했습니다"
            );
        }
        assert!(matches!(
            create_document_entry(&f.app_data, &f.root_id, "../", "x", DocumentEntryKind::File),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn renames_without_overwriting_existing_entry() {
        let f = fixture();
        fs::write(f.docs.join("a.md"), "a").unwrap();
        fs::write(f.docs.join("b.md"), "b").unwrap();
        assert!(matches!(
            rename_document_entry(&f.app_data, &f.root_id, "a.md", "b.md"),
            Err(CoreError::Conflict(_))
        ));
        assert_eq!(fs::read_to_string(f.docs.join("b.md")).unwrap(), "b");
        let renamed =
            rename_document_entry(&f.app_data, &f.root_id, "a.md", "c.md").expect("rename");
        assert_eq!(renamed.relative_path, "c.md");
        assert!(!f.docs.join("a.md").exists());
        assert!(matches!(
            rename_document_entry(&f.app_data, &f.root_id, "", "x"),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn g10_allows_case_only_rename_of_regular_entry() {
        let f = fixture();
        fs::write(f.docs.join("note.md"), "keep").unwrap();

        let renamed = rename_document_entry(&f.app_data, &f.root_id, "note.md", "Note.md")
            .expect("case-only rename");

        assert_eq!(renamed.relative_path, "Note.md");
        assert_eq!(fs::read_to_string(f.docs.join("Note.md")).unwrap(), "keep");
        assert_eq!(fs::read_dir(&f.docs).unwrap().count(), 1);
    }

    // 대소문자를 구분하는 Linux 파일 시스템에서 별도 링크가 덮이는 경계를 재현한다.
    #[cfg(target_os = "linux")]
    #[test]
    fn g10_case_only_rename_preserves_existing_symlink() {
        let f = fixture();
        let source = f.docs.join("note.md");
        let link = f.docs.join("Note.md");
        fs::write(&source, "keep").unwrap();
        std::os::unix::fs::symlink(&source, &link).unwrap();

        assert!(matches!(
            rename_document_entry(&f.app_data, &f.root_id, "note.md", "Note.md"),
            Err(CoreError::Conflict(_))
        ));
        assert_eq!(fs::read_link(&link).unwrap(), source);
        assert_eq!(fs::read_to_string(&source).unwrap(), "keep");
    }

    #[test]
    fn moves_entry_and_refuses_moving_folder_into_itself() {
        let f = fixture();
        fs::create_dir_all(f.docs.join("a/b")).unwrap();
        fs::create_dir_all(f.docs.join("dest")).unwrap();
        fs::write(f.docs.join("a/note.md"), "n").unwrap();
        let moved =
            move_document_entry(&f.app_data, &f.root_id, "a/note.md", "dest").expect("move");
        assert_eq!(moved.relative_path, "dest/note.md");
        let up = move_document_entry(&f.app_data, &f.root_id, "dest/note.md", "").expect("to root");
        assert_eq!(up.relative_path, "note.md");
        assert!(matches!(
            move_document_entry(&f.app_data, &f.root_id, "a", "a/b"),
            Err(CoreError::InvalidInput(_))
        ));
        fs::write(f.docs.join("dest/note.md"), "other").unwrap();
        assert!(matches!(
            move_document_entry(&f.app_data, &f.root_id, "note.md", "dest"),
            Err(CoreError::Conflict(_))
        ));
        assert_eq!(
            fs::read_to_string(f.docs.join("dest/note.md")).unwrap(),
            "other"
        );
    }

    #[test]
    fn duplicates_file_with_next_free_name() {
        let f = fixture();
        fs::write(f.docs.join("plan.md"), "body").unwrap();
        let first = duplicate_document_file(&f.app_data, &f.root_id, "plan.md").expect("first");
        assert_eq!(first.relative_path, "plan 복사본.md");
        let second = duplicate_document_file(&f.app_data, &f.root_id, "plan.md").expect("second");
        assert_eq!(second.relative_path, "plan 복사본 2.md");
        assert_eq!(
            fs::read_to_string(f.docs.join("plan 복사본 2.md")).unwrap(),
            "body"
        );
        assert_eq!(duplicate_name("Makefile", 1), "Makefile 복사본");
        fs::create_dir_all(f.docs.join("dir")).unwrap();
        assert!(duplicate_document_file(&f.app_data, &f.root_id, "dir").is_err());
    }

    #[test]
    fn deletes_empty_folder_but_reports_contents_until_recursive() {
        let f = fixture();
        fs::create_dir_all(f.docs.join("empty")).unwrap();
        let empty = delete_document_entry(&f.app_data, &f.root_id, "empty", false).expect("empty");
        assert!(empty.deleted);
        assert!(!f.docs.join("empty").exists());

        fs::create_dir_all(f.docs.join("full/sub")).unwrap();
        fs::write(f.docs.join("full/.hidden"), "h").unwrap();
        fs::write(f.docs.join("full/sub/a.md"), "a").unwrap();
        let held = delete_document_entry(&f.app_data, &f.root_id, "full", false).expect("held");
        assert!(!held.deleted);
        assert_eq!((held.files, held.directories), (2, 1));
        assert!(f.docs.join("full/sub/a.md").exists());
        let gone = delete_document_entry(&f.app_data, &f.root_id, "full", true).expect("gone");
        assert!(gone.deleted);
        assert!(!f.docs.join("full").exists());

        fs::write(f.docs.join("x.md"), "x").unwrap();
        assert!(
            delete_document_entry(&f.app_data, &f.root_id, "x.md", false)
                .unwrap()
                .deleted
        );
        assert!(matches!(
            delete_document_entry(&f.app_data, &f.root_id, "", true),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_symlinked_entries() {
        let f = fixture();
        let outside = f._temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.md"), "keep").unwrap();
        std::os::unix::fs::symlink(&outside, f.docs.join("link")).unwrap();
        assert!(delete_document_entry(&f.app_data, &f.root_id, "link", true).is_err());
        assert!(delete_document_entry(&f.app_data, &f.root_id, "link/keep.md", true).is_err());
        assert!(rename_document_entry(&f.app_data, &f.root_id, "link/keep.md", "x.md").is_err());
        assert!(move_document_entry(&f.app_data, &f.root_id, "link", "").is_err());
        assert!(create_document_entry(
            &f.app_data,
            &f.root_id,
            "link",
            "x.md",
            DocumentEntryKind::File
        )
        .is_err());
        assert!(outside.join("keep.md").exists());
        assert!(!outside.join("x.md").exists());
        // 같은 폴더 안 링크가 가리키는 파일의 이름을 그 링크 이름으로 바꾸면 링크를 덮는다.
        fs::write(f.docs.join("a.md"), "a").unwrap();
        std::os::unix::fs::symlink(f.docs.join("a.md"), f.docs.join("alias.md")).unwrap();
        assert!(matches!(
            rename_document_entry(&f.app_data, &f.root_id, "a.md", "alias.md"),
            Err(CoreError::Conflict(_))
        ));
        assert!(fs::symlink_metadata(f.docs.join("alias.md"))
            .unwrap()
            .file_type()
            .is_symlink());
    }
}
