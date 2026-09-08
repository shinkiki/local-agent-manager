//! Agent Manager 소유 저장 파일(G7)을 원자적으로 쓰기 위한 공통 원시 연산.
//!
//! 저장소를 가진 모듈마다 "임시 파일을 0600으로 새로 만들고 → 쓰고 → fsync 하고 →
//! 원자적으로 교체하고 → 상위 폴더를 fsync 하고 → 실패하면 임시 파일을 지운다"라는
//! 같은 순서를 각자 복사해 두고 있었다. 순서가 한 군데라도 어긋나면 크래시 뒤에
//! 반쪽짜리 저장 파일이 남으므로, 순서 자체는 이 모듈 한 곳에만 둔다.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;
use uuid::Uuid;

use crate::CoreError;

/// 앱 소유 파일에 공통으로 적용하는 읽기·쓰기 및 소유자 전용 생성 권한(G7).
fn private_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    options
}

/// 앱 소유 파일을 소유자 전용(0600)으로 연다. `create_new`가 참이면 새로 만들 때만
/// 성공하고, 거짓이면 기존 내용을 그대로 둔 채 읽고 쓸 수 있게 연다(잠금 파일 용도).
pub(crate) fn open_private_file(path: &Path, create_new: bool) -> Result<File, CoreError> {
    let mut options = private_open_options();
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(false);
    }
    Ok(options.open(path)?)
}

/// 추가 기록 전용으로 여는 앱 소유 파일(감사 로그).
pub(crate) fn open_private_append_file(path: &Path) -> Result<File, CoreError> {
    let mut options = private_open_options();
    options.create(true).append(true);
    Ok(options.open(path)?)
}

/// 임시 파일을 목적지 위로 원자적으로 옮긴다. Windows에서는 이미 있는 목적지를
/// 지웠다 다시 만드는 틈이 생기지 않도록 `MoveFileExW`로 한 번에 교체한다.
#[cfg(not(windows))]
pub(crate) fn replace_file(temporary: &Path, destination: &Path) -> Result<(), CoreError> {
    fs::rename(temporary, destination)?;
    Ok(())
}

#[cfg(windows)]
pub(crate) fn replace_file(temporary: &Path, destination: &Path) -> Result<(), CoreError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(CoreError::Io(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

/// 교체된 이름이 디스크에 남도록 상위 폴더를 fsync 한다. 폴더를 파일로 열 수 없는
/// 플랫폼에서는 건너뛴다.
#[cfg(unix)]
pub(crate) fn sync_dir(directory: &Path) -> Result<(), CoreError> {
    File::open(directory)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn sync_dir(_directory: &Path) -> Result<(), CoreError> {
    Ok(())
}

/// 앱 소유 저장 파일이 있으면 JSON으로 해석해 돌려주고, 아직 없으면 `None`.
///
/// 저장소를 가진 모듈마다 "`is_file()`로 없으면 기본값 → 있으면 읽어서 해석"이라는 같은
/// 세 줄을 각자 복사해 두고 있었다. 없는 파일과 못 읽는 파일을 가르는 기준이 모듈마다
/// 갈리면 첫 실행이 기본값 대신 오류로 죽으므로, 기준은 이 함수 한 곳에만 둔다.
/// 경로에 폴더가 놓여 있는 경우도 "저장본 없음"으로 본다 — 기존 호출부의 `is_file()`
/// 판정을 그대로 옮긴 것이다.
pub(crate) fn read_private_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, CoreError> {
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}

/// 저장본이 아직 없으면 기본값을 쓰는 [`read_private_json`].
pub(crate) fn read_private_json_or_default<T: DeserializeOwned + Default>(
    path: &Path,
) -> Result<T, CoreError> {
    Ok(read_private_json(path)?.unwrap_or_default())
}

/// 읽어 온 저장본의 스키마 버전이 기대한 값인지 확인한다.
///
/// 저장소를 가진 모듈마다 "버전이 다르면 `Conflict`로 거절한다"라는 같은 네 줄을 각자
/// 복사해 두었고, 문구도 주어만 다른 같은 문장이었다. 알 수 없는 버전을 만났을 때
/// 기본값으로 덮어쓰는 대신 거절해야 하는 판단은 한 곳에만 둔다 — 한 모듈만 슬쩍
/// 관대해지면 앞선 버전이 쓴 저장본을 지우게 된다.
///
/// 버전이 달라도 기본값으로 되돌리거나(`usage_pacing`·`catalog`) 버전을 문구에 담지
/// 않는(`accounts`·`remote`) 호출부는 각자의 판단을 그대로 유지한다.
pub(crate) fn ensure_schema_version(
    actual: u32,
    expected: u32,
    subject: &str,
) -> Result<(), CoreError> {
    if actual == expected {
        Ok(())
    } else {
        Err(CoreError::Conflict(format!(
            "지원하지 않는 {subject} 버전입니다: {actual}"
        )))
    }
}

/// 앱 소유 저장 파일을 보기 좋은 JSON + 개행으로 원자적으로 덮어쓴다.
pub(crate) fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), CoreError> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_private_bytes(path, &bytes)
}

/// 앱 소유 저장 파일을 원자적으로 덮어쓴다. 실패하면 임시 파일을 남기지 않고,
/// 목적지는 이전 내용 그대로 유지된다.
pub(crate) fn write_private_bytes(path: &Path, bytes: &[u8]) -> Result<(), CoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| CoreError::InvalidInput("저장 경로의 상위 폴더가 없습니다".to_owned()))?;
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data");
    let temporary = parent.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<(), CoreError> {
        let mut file = open_private_file(&temporary, true)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, path)?;
        sync_dir(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn private_open_helpers_create_owner_only_files_g7() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary directory");
        let regular_path = directory.path().join("regular");
        let append_path = directory.path().join("append");
        drop(open_private_file(&regular_path, false).expect("regular file"));
        drop(open_private_append_file(&append_path).expect("append file"));

        for path in [regular_path, append_path] {
            let mode = fs::metadata(path).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn write_private_json_replaces_atomically_and_leaves_no_temporary() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("store.json");
        write_private_json(&path, &serde_json::json!({ "value": 1 })).expect("first write");
        write_private_json(&path, &serde_json::json!({ "value": 2 })).expect("second write");

        let stored = fs::read_to_string(&path).expect("stored file");
        assert!(stored.ends_with("\n"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&stored).expect("parsed"),
            serde_json::json!({ "value": 2 })
        );
        let leftovers = fs::read_dir(directory.path())
            .expect("directory listing")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn read_private_json_reports_a_missing_store_instead_of_failing() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let missing = directory.path().join("absent.json");
        assert_eq!(
            read_private_json::<serde_json::Value>(&missing).expect("missing store"),
            None
        );
        assert_eq!(
            read_private_json_or_default::<serde_json::Value>(&missing).expect("missing store"),
            serde_json::Value::Null
        );

        let occupied = directory.path().join("occupied");
        fs::create_dir(&occupied).expect("occupying directory");
        assert_eq!(
            read_private_json::<serde_json::Value>(&occupied).expect("directory in the way"),
            None
        );
    }

    #[test]
    fn schema_version_mismatch_reports_the_stored_version() {
        ensure_schema_version(1, 1, "시험 저장소").expect("matching version");
        let error = ensure_schema_version(2, 1, "시험 저장소").expect_err("mismatch rejected");
        assert!(matches!(error, CoreError::Conflict(message)
            if message == "지원하지 않는 시험 저장소 버전입니다: 2"));
    }

    #[test]
    fn read_private_json_round_trips_what_write_private_json_stored() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("store.json");
        write_private_json(&path, &serde_json::json!({ "value": 7 })).expect("write");
        assert_eq!(
            read_private_json::<serde_json::Value>(&path).expect("stored store"),
            Some(serde_json::json!({ "value": 7 }))
        );

        fs::write(&path, b"{ not json").expect("corrupting the store");
        assert!(matches!(
            read_private_json::<serde_json::Value>(&path),
            Err(CoreError::Json(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn write_private_json_keeps_the_store_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("nested").join("store.json");
        write_private_json(&path, &serde_json::json!({ "value": 1 })).expect("write");
        let mode = fs::metadata(&path).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn write_private_bytes_keeps_the_previous_content_when_the_target_is_a_directory() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("occupied");
        fs::create_dir(&path).expect("occupying directory");
        assert!(write_private_bytes(&path, b"payload").is_err());
        assert!(path.is_dir());
        let leftovers = fs::read_dir(directory.path())
            .expect("directory listing")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }
}
