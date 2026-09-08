//! 앱 소유 저장소(G7)를 파일 잠금으로 직렬화하기 위한 공통 가드.
//!
//! 저장소를 가진 모듈마다 "앱 데이터 폴더를 만들고 → 잠금 파일을 0600으로 열고 →
//! 배타 잠금을 잡고 → 작업하고 → 잠금을 푼다"라는 같은 순서를 각자 복사해 두고 있었다.
//! 손으로 푸는 방식은 중간에 `?`로 빠져나가는 경로가 하나만 생겨도 해제를 건너뛰므로,
//! 해제는 `Drop`에 맡기고 순서 자체는 이 모듈 한 곳에만 둔다.

use std::fs::{self, File};
use std::path::Path;

use fs4::FileExt;

use crate::app_data_file::open_private_file;
use crate::CoreError;

/// 살아 있는 동안 저장소 잠금을 쥐고, 떨어질 때 — 성공 경로든 `?`로 빠져나가는 실패
/// 경로든 — 해제한다. 해제 실패는 잠금 파일을 닫는 것만으로도 커널이 정리하므로 삼킨다.
pub(crate) struct StoreLock {
    file: File,
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}

/// `app_data_dir`을 만든 뒤 그 안의 `lock_file_name`에 배타 잠금을 잡는다. `label`은
/// 잠금을 얻지 못했을 때의 오류 문구("<label> 잠금을 얻지 못했습니다")에 그대로 들어간다.
pub(crate) fn acquire(
    app_data_dir: &Path,
    lock_file_name: &str,
    label: &str,
) -> Result<StoreLock, CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let file = open_private_file(&app_data_dir.join(lock_file_name), false)?;
    FileExt::lock(&file)
        .map_err(|error| CoreError::Runtime(format!("{label} 잠금을 얻지 못했습니다: {error}")))?;
    Ok(StoreLock { file })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acquire_creates_the_app_data_dir_and_blocks_a_contending_handle() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let app_data_dir = directory.path().join("nested");
        let guard = acquire(&app_data_dir, "store.lock", "테스트 저장소").expect("lock");

        let contender = open_private_file(&app_data_dir.join("store.lock"), false)
            .expect("contending lock handle");
        assert!(matches!(
            FileExt::try_lock(&contender),
            Err(fs4::TryLockError::WouldBlock)
        ));
        drop(guard);
        FileExt::try_lock(&contender).expect("lock is free once the guard drops");
        let _ = FileExt::unlock(&contender);
    }

    #[test]
    fn acquire_releases_when_the_guarded_work_returns_early() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let failed = (|| -> Result<(), CoreError> {
            let _guard = acquire(directory.path(), "store.lock", "테스트 저장소")?;
            Err(CoreError::Runtime("작업 실패".to_owned()))
        })();
        assert!(failed.is_err());

        let contender =
            open_private_file(&directory.path().join("store.lock"), false).expect("lock handle");
        FileExt::try_lock(&contender).expect("lock is free after the early return");
        let _ = FileExt::unlock(&contender);
    }
}
