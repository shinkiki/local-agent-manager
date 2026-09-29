//! 공급자가 소유한 설정 파일 하나를 안전하게 바꾸는 공통 골격(C8·C13).
//!
//! 규칙 예외로 열린 설정 어댑터는 모두 같은 순서를 밟는다 — 경로가 심볼릭 링크나 엉뚱한
//! 종류가 아닌지 보고, 상위 폴더를 한 단계까지만 만들고, 바꾸기 전 원본을 앱 데이터의
//! 백업 저장소에 남기고, 같은 폴더의 임시 파일에 쓴 뒤 원자적으로 갈아 끼운다. 어댑터마다
//! 이 순서를 각자 적으면 한쪽만 고쳤을 때 안전 판정이 조용히 갈라지므로, 판정과 순서는
//! 여기 한 곳에 두고 어댑터는 문구(어느 공급자의 설정인지)만 끼운다.

use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::app_data_file::{replace_file, sync_dir, write_private_bytes};
use crate::clock::now_ms;
use crate::CoreError;

/// 대상 하나가 남기는 백업 개수. 넘치면 오래된 것부터 지운다.
pub(crate) const BACKUP_LIMIT: usize = 5;

/// 설정 경로를 손대기 전에 거치는 안전 판정. 심볼릭 링크는 따라가지 않고, 기대한 종류가
/// 아닌 경로는 읽지도 쓰지도 않는다.
#[derive(Clone, Copy)]
pub(crate) struct SettingsPathRules {
    /// 심볼릭 링크일 때 낼 문구.
    pub(crate) symlink: &'static str,
    /// 기대한 종류가 아닐 때 낼 문구.
    pub(crate) wrong_kind: &'static str,
    /// 폴더를 기대하는지. false면 일반 파일을 기대한다.
    pub(crate) directory: bool,
}

impl SettingsPathRules {
    /// 이미 읽어 둔 메타데이터가 규칙에 맞는지. 어긋나면 낼 문구를 돌려준다.
    pub(crate) fn check(self, metadata: &fs::Metadata) -> Result<(), &'static str> {
        if metadata.file_type().is_symlink() {
            return Err(self.symlink);
        }
        let expected = if self.directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        };
        if !expected {
            return Err(self.wrong_kind);
        }
        Ok(())
    }

    /// 경로를 직접 읽어 판정한다. 경로가 없으면 `Ok(None)` — 없는 것은 거절 사유가
    /// 아니라 호출부가 만들거나 기본값을 쓸 자리다.
    pub(crate) fn inspect(self, path: &Path) -> Result<Option<fs::Metadata>, CoreError> {
        match fs::symlink_metadata(path) {
            Ok(metadata) => {
                self.check(&metadata)
                    .map_err(|message| CoreError::InvalidInput(message.to_owned()))?;
                Ok(Some(metadata))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(CoreError::Io(error)),
        }
    }
}

/// 한 어댑터가 쓰는 설정 파일 종류의 판정표. 읽기·쓰기·상위 폴더·그 위 폴더 네 자리의
/// 거절 문구를 한 벌로 들고 다닌다.
#[derive(Clone, Copy)]
pub(crate) struct SettingsFileGuard {
    pub(crate) read: SettingsPathRules,
    pub(crate) write: SettingsPathRules,
    pub(crate) parent: SettingsPathRules,
    pub(crate) grandparent: SettingsPathRules,
    /// 대상 경로에 상위가 없을 때(경로 끝이 루트) 낼 문구.
    pub(crate) missing_parent: &'static str,
    /// 만들어야 할 상위 폴더에 다시 상위가 없을 때 낼 문구.
    pub(crate) missing_grandparent: &'static str,
    /// 임시 파일 이름을 지을 때 쓸 기본 파일명.
    pub(crate) fallback_file_name: &'static str,
}

impl SettingsFileGuard {
    /// 쓰기 대상 파일이 들어갈 폴더. 경로 끝이 루트라 상위가 없으면 쓰기를 시작하지 않는다.
    pub(crate) fn parent_of<'a>(&self, target: &'a Path) -> Result<&'a Path, CoreError> {
        target
            .parent()
            .ok_or_else(|| CoreError::InvalidInput(self.missing_parent.to_owned()))
    }

    /// 대상이 들어갈 폴더를 확보한다. 없으면 한 단계만 만들되, 그 자리를 내주는 상위가
    /// 안전한지 먼저 본다.
    pub(crate) fn ensure_parent(&self, target: &Path) -> Result<(), CoreError> {
        let parent = self.parent_of(target)?;
        if self.parent.inspect(parent)?.is_some() {
            return Ok(());
        }
        let grandparent = parent
            .parent()
            .ok_or_else(|| CoreError::InvalidInput(self.missing_grandparent.to_owned()))?;
        self.grandparent
            .check(&fs::symlink_metadata(grandparent)?)
            .map_err(|message| CoreError::InvalidInput(message.to_owned()))?;
        fs::create_dir(parent)?;
        #[cfg(unix)]
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
        Ok(())
    }

    /// 같은 폴더의 임시 파일에 쓰고 fsync한 뒤 대상을 원자적으로 갈아 끼운다.
    pub(crate) fn atomic_write(&self, target: &Path, bytes: &[u8]) -> Result<(), CoreError> {
        let parent = self.parent_of(target)?;
        // 파일이 이미 있으면 그 권한을 그대로 물려 쓰고, 없으면 0o600으로 새로 만든다.
        #[cfg_attr(not(unix), allow(unused_variables))]
        let existing_mode = match self.write.inspect(target)? {
            Some(_metadata) => {
                #[cfg(unix)]
                {
                    _metadata.permissions().mode() & 0o777
                }
                #[cfg(not(unix))]
                {
                    0
                }
            }
            None => 0o600,
        };
        let file_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(self.fallback_file_name);
        let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
        let result = (|| -> Result<(), CoreError> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(existing_mode);
            let mut file = options.open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            replace_file(&temporary, target)?;
            sync_dir(parent)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

/// 바꾸기 전 원본을 앱 데이터의 `store` 저장소에 남긴다. 대상 경로마다 폴더를 나누고
/// 최신 `BACKUP_LIMIT`개만 남긴다. `extension`은 백업 파일이 갖는 확장자다.
pub(crate) fn save_backup(
    app_data_dir: &Path,
    store: &str,
    extension: &str,
    target: &Path,
    bytes: &[u8],
) -> Result<(), CoreError> {
    let key = stable_path_key(target);
    let directory = app_data_dir.join(store).join(key);
    fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let timestamp = now_ms();
    let path = directory.join(format!("{timestamp}-{}.{extension}", Uuid::new_v4()));
    write_private_bytes(&path, bytes)?;

    let mut backups = fs::read_dir(&directory)?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    for stale in backups.into_iter().skip(BACKUP_LIMIT) {
        let _ = fs::remove_file(stale);
    }
    Ok(())
}

/// 경로 문자열을 폴더 이름으로 쓸 수 있는 고정 길이 키로 접는다(FNV-1a).
pub(crate) fn stable_path_key(path: &Path) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// 공급자가 홈 위치를 바꿀 때 쓰는 환경변수만 읽는다(G8). 그 밖의 환경변수는 읽지 않는다.
pub(crate) fn redirected_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}
