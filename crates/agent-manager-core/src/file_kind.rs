//! 읽기·해싱·교체 앞에 붙는 "심볼릭 링크가 아닌가, 기대한 종류인가, 상한 이하인가" 검사.
//!
//! `project_instructions`·`skill_library`·`linked_file`·`resource_repository`·
//! `document_automation`이 같은 골격을 각자 적어 두었다. `fs::symlink_metadata`로
//! 링크를 따라가지 않고 종류를 본 뒤 거부하는 순서가 핵심이다 — `is_file()`만 보면
//! 링크가 가리키는 실제 파일의 종류를 보게 되어, C3·C5가 검증한 루트 안이라고 판단한
//! 경로가 루트 밖의 파일을 열거나 교체한다.
//!
//! 검사 순서만 여기 모으고, 무엇을 거부했는지 알리는 문구와 크기 상한값은 그 의미를
//! 아는 호출부가 계속 정한다. 메타데이터는 호출부가 이미 읽어 둔 것을 그대로 받는다 —
//! 없는 파일을 `NotFound`로 바꿔 부르는 곳이 있어 조회 자체는 옮기지 않는다.

use std::fs::Metadata;
use std::path::Path;

use crate::CoreError;

/// 심볼릭 링크가 아닌 일반 파일인지 본다.
pub(crate) fn ensure_regular_file(metadata: &Metadata, rejection: &str) -> Result<(), CoreError> {
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CoreError::InvalidInput(rejection.to_owned()));
    }
    Ok(())
}

/// 심볼릭 링크가 아닌 디렉터리인지 본다.
pub(crate) fn ensure_directory(metadata: &Metadata, rejection: &str) -> Result<(), CoreError> {
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CoreError::InvalidInput(rejection.to_owned()));
    }
    Ok(())
}

/// 심볼릭 링크만 거부한다. 파일이든 디렉터리든 뒤에서 갈라 보는 호출부가 쓴다.
pub(crate) fn ensure_not_symlink(metadata: &Metadata, rejection: &str) -> Result<(), CoreError> {
    if metadata.file_type().is_symlink() {
        return Err(CoreError::InvalidInput(rejection.to_owned()));
    }
    Ok(())
}

/// 크기 상한을 넘지 않는지 본다. 넘으면 상한값을 담아 `TooLarge`로 돌려준다.
pub(crate) fn ensure_within_limit(metadata: &Metadata, max_bytes: u64) -> Result<(), CoreError> {
    if metadata.len() > max_bytes {
        return Err(CoreError::TooLarge(max_bytes));
    }
    Ok(())
}

/// 조회부터 종류 확인까지 한 번에. 없는 대상을 그대로 입출력 오류로 올려도 되는
/// 호출부가 쓴다.
pub(crate) fn regular_file_metadata(path: &Path, rejection: &str) -> Result<Metadata, CoreError> {
    let metadata = std::fs::symlink_metadata(path)?;
    ensure_regular_file(&metadata, rejection)?;
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::fs;

    #[test]
    fn accepts_regular_file_and_rejects_directory() {
        let dir = tempfile::tempdir().expect("임시 디렉터리");
        let file = dir.path().join("a.md");
        fs::write(&file, "x").expect("파일 생성");

        let file_meta = fs::symlink_metadata(&file).expect("메타데이터");
        assert!(ensure_regular_file(&file_meta, "거부").is_ok());
        assert!(ensure_directory(&file_meta, "거부").is_err());
        assert!(regular_file_metadata(&file, "거부").is_ok());

        let dir_meta = fs::symlink_metadata(dir.path()).expect("메타데이터");
        assert!(ensure_directory(&dir_meta, "거부").is_ok());
        assert!(ensure_regular_file(&dir_meta, "거부").is_err());
        assert!(regular_file_metadata(dir.path(), "거부").is_err());
    }

    /// 링크가 가리키는 대상이 일반 파일이어도 링크 자체는 거부해야 한다(C3·C5 루트 이탈 방지).
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_to_regular_file() {
        let dir = tempfile::tempdir().expect("임시 디렉터리");
        let target = dir.path().join("target.md");
        fs::write(&target, "x").expect("파일 생성");
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&target, &link).expect("링크 생성");

        let metadata = fs::symlink_metadata(&link).expect("메타데이터");
        assert!(ensure_regular_file(&metadata, "거부").is_err());
        assert!(ensure_not_symlink(&metadata, "거부").is_err());
        assert!(regular_file_metadata(&link, "거부").is_err());
    }

    #[test]
    fn reports_limit_value_when_exceeded() {
        let dir = tempfile::tempdir().expect("임시 디렉터리");
        let file = dir.path().join("a.md");
        fs::write(&file, "0123456789").expect("파일 생성");
        let metadata = fs::symlink_metadata(&file).expect("메타데이터");

        assert!(ensure_within_limit(&metadata, 10).is_ok());
        match ensure_within_limit(&metadata, 9) {
            Err(CoreError::TooLarge(limit)) => assert_eq!(limit, 9),
            other => panic!("상한 초과를 TooLarge로 돌려주지 않았습니다: {other:?}"),
        }
    }
}
