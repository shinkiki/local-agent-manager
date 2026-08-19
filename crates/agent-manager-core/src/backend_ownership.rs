use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use fs4::FileExt;

use crate::CoreError;

const BACKEND_OWNERSHIP_LOCK_FILE: &str = "backend-owner-v1.lock";
const OWNERSHIP_RETRY_INTERVAL: Duration = Duration::from_millis(150);

/// Process-wide ownership of an Agent Manager app-data store.
///
/// The lock file is deliberately persistent. Exclusivity comes from the OS file
/// lock held by `BackendOwnershipInner`, so a crashed process cannot leave a
/// stale ownership claim and the path must never be unlinked while contenders
/// may still have it open.
#[derive(Clone)]
#[must_use = "백엔드가 실행되는 동안 소유권 lease를 유지해야 합니다"]
pub struct BackendOwnershipLease {
    inner: Arc<BackendOwnershipInner>,
}

struct BackendOwnershipInner {
    app_data_dir: PathBuf,
    _lock: File,
}

impl BackendOwnershipLease {
    pub fn acquire(app_data_dir: impl AsRef<Path>) -> Result<Self, CoreError> {
        fs::create_dir_all(app_data_dir.as_ref())?;
        let app_data_dir = fs::canonicalize(app_data_dir.as_ref())?;
        let lock = open_lock_file(&app_data_dir.join(BACKEND_OWNERSHIP_LOCK_FILE))?;
        FileExt::try_lock(&lock).map_err(|error| {
            if matches!(error, fs4::TryLockError::WouldBlock) {
                CoreError::Conflict(
                    "동일한 앱 데이터 저장소를 사용하는 Agent Manager 백엔드가 이미 실행 중입니다. 기존 백엔드를 종료한 뒤 다시 시도하세요"
                        .to_owned(),
                )
            } else {
                CoreError::Runtime(format!(
                    "Agent Manager 백엔드 소유권 잠금을 얻지 못했습니다: {error}"
                ))
            }
        })?;
        Ok(Self {
            inner: Arc::new(BackendOwnershipInner {
                app_data_dir,
                _lock: lock,
            }),
        })
    }

    /// Waits for a predecessor backend to release the store before giving up.
    /// A desktop restart spawns the replacement backend while the previous one
    /// is still shutting down, so a bare [`Self::acquire`] would lose that race
    /// and leave the app with no backend at all.
    pub fn acquire_with_retry(
        app_data_dir: impl AsRef<Path>,
        wait: Duration,
    ) -> Result<Self, CoreError> {
        let app_data_dir = app_data_dir.as_ref();
        let deadline = Instant::now() + wait;
        loop {
            match Self::acquire(app_data_dir) {
                Err(CoreError::Conflict(_)) if Instant::now() < deadline => {
                    thread::sleep(OWNERSHIP_RETRY_INTERVAL);
                }
                result => return result,
            }
        }
    }

    pub fn app_data_dir(&self) -> &Path {
        &self.inner.app_data_dir
    }
}

fn open_lock_file(path: &Path) -> Result<File, CoreError> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ownership_is_exclusive_until_the_last_clone_is_dropped() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let first = BackendOwnershipLease::acquire(directory.path()).expect("first owner");
        let retained = first.clone();

        assert!(matches!(
            BackendOwnershipLease::acquire(directory.path()),
            Err(CoreError::Conflict(_))
        ));
        drop(first);
        assert!(matches!(
            BackendOwnershipLease::acquire(directory.path()),
            Err(CoreError::Conflict(_))
        ));

        drop(retained);
        let _replacement =
            BackendOwnershipLease::acquire(directory.path()).expect("replacement owner");
    }

    #[test]
    fn persistent_lock_file_does_not_become_a_stale_claim() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let lock_path = directory.path().join(BACKEND_OWNERSHIP_LOCK_FILE);
        {
            let lease = BackendOwnershipLease::acquire(directory.path()).expect("owner");
            assert_eq!(
                lease.app_data_dir(),
                fs::canonicalize(directory.path())
                    .expect("canonical directory")
                    .as_path()
            );
            assert!(lock_path.is_file());
        }
        assert!(lock_path.is_file());
        let _owner_after_release =
            BackendOwnershipLease::acquire(directory.path()).expect("owner after release");
    }

    #[test]
    fn retrying_acquire_waits_for_the_previous_owner_and_then_gives_up() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let held = BackendOwnershipLease::acquire(directory.path()).expect("first owner");
        assert!(matches!(
            BackendOwnershipLease::acquire_with_retry(directory.path(), Duration::from_millis(300)),
            Err(CoreError::Conflict(_))
        ));

        drop(held);
        let _replacement =
            BackendOwnershipLease::acquire_with_retry(directory.path(), Duration::from_millis(300))
                .expect("replacement owner");
    }

    #[cfg(unix)]
    #[test]
    fn ownership_lock_is_private() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let lock_path = directory.path().join(BACKEND_OWNERSHIP_LOCK_FILE);
        fs::write(&lock_path, []).expect("pre-existing lock file");
        fs::set_permissions(&lock_path, fs::Permissions::from_mode(0o644))
            .expect("broad test permissions");
        let _lease = BackendOwnershipLease::acquire(directory.path()).expect("owner");
        let mode = fs::metadata(lock_path)
            .expect("lock metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
