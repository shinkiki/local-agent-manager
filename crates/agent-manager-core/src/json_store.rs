//! 앱 소유 JSON 저장소(G7) 한 벌을 이루는 잠금·읽기·쓰기 세 가지를 한 서술자로 묶는다.
//!
//! 저장소를 가진 모듈마다 "잠금 파일 상수 → `store_lock::acquire` → 저장 파일 상수 →
//! `read_private_json_or_default` → `ensure_schema_version` → `write_private_json`"이라는
//! 같은 배선을 세 개의 작은 함수에 나눠 복사해 두고 있었다. 배선이 나뉘어 있으면 한
//! 모듈만 잠금 파일 이름이나 기대 버전을 어긋나게 고쳐도 컴파일은 통과하므로, 저장소
//! 한 벌을 이루는 이름들은 이 서술자 한 자리에 모아 둔다.
//!
//! 읽기 실패를 오류로 올리지 않고 기본값으로 되돌리는 저장소(`usage_pacing`·
//! `usage_history`)와 스키마 버전을 두지 않는 저장소(`scheduler`)는 각자의 판단이
//! 다르므로 그대로 둔다.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::app_data_file::{
    ensure_schema_version, read_private_json_or_default, write_private_json,
};
use crate::store_lock;
use crate::CoreError;

/// 저장본이 자기 스키마 버전을 어디에 담고 있는지 알려 준다. 필드 이름이 아니라
/// 이 트레이트를 통해 읽어야 `#[serde(default)]`로 버전이 빠진 저장본도 같은 경로로
/// 검사된다.
pub(crate) trait SchemaVersioned {
    fn schema_version(&self) -> u32;
}

/// 앱 데이터 폴더 안의 저장소 한 벌. 저장 파일·잠금 파일·오류 문구에 쓰는 이름·기대
/// 스키마 버전이 한 자리에 모인다.
pub(crate) struct JsonStore {
    /// 앱 데이터 폴더 기준 저장 파일 이름.
    pub file: &'static str,
    /// 같은 폴더에 두는 잠금 파일 이름.
    pub lock_file: &'static str,
    /// 잠금 실패와 버전 불일치 문구에 함께 쓰는 주어. 예: `"워크플로 저장소"`
    pub label: &'static str,
    /// 이 저장소가 읽을 수 있는 스키마 버전.
    pub version: u32,
}

impl JsonStore {
    /// 저장 파일의 전체 경로.
    pub(crate) fn path(&self, app_data_dir: &Path) -> PathBuf {
        app_data_dir.join(self.file)
    }

    /// 저장소 잠금을 쥔 채 `action`을 실행한다. 잠금은 성공 경로든 `?`로 빠져나가는
    /// 실패 경로든 [`store_lock`]의 가드가 떨어지면서 풀린다.
    pub(crate) fn with_lock<T>(
        &self,
        app_data_dir: &Path,
        action: impl FnOnce() -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let _lock = store_lock::acquire(app_data_dir, self.lock_file, self.label)?;
        action()
    }

    /// 저장본을 읽고 스키마 버전을 확인한다. 아직 파일이 없으면 기본값이다.
    /// 잠금은 잡지 않으므로 [`JsonStore::with_lock`] 안에서 부른다.
    pub(crate) fn load_unlocked<T>(&self, app_data_dir: &Path) -> Result<T, CoreError>
    where
        T: DeserializeOwned + Default + SchemaVersioned,
    {
        let store: T = read_private_json_or_default(&self.path(app_data_dir))?;
        ensure_schema_version(store.schema_version(), self.version, self.label)?;
        Ok(store)
    }

    /// 저장본을 원자적으로 덮어쓴다. 잠금은 잡지 않으므로
    /// [`JsonStore::with_lock`] 안에서 부른다.
    pub(crate) fn save_unlocked<T: Serialize>(
        &self,
        app_data_dir: &Path,
        store: &T,
    ) -> Result<(), CoreError> {
        write_private_json(&self.path(app_data_dir), store)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_VERSION: u32 = 3;

    #[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
    struct Sample {
        schema_version: u32,
        value: u32,
    }

    /// 실제 저장소들과 같은 계약: 기본값은 현재 스키마 버전을 달고 나온다.
    impl Default for Sample {
        fn default() -> Self {
            Self {
                schema_version: SAMPLE_VERSION,
                value: 0,
            }
        }
    }

    impl SchemaVersioned for Sample {
        fn schema_version(&self) -> u32 {
            self.schema_version
        }
    }

    const STORE: JsonStore = JsonStore {
        file: "sample.json",
        lock_file: "sample.lock",
        label: "시험 저장소",
        version: SAMPLE_VERSION,
    };

    #[test]
    fn a_missing_store_loads_as_the_default_value() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let loaded: Sample = STORE
            .load_unlocked(directory.path())
            .expect("missing store loads");
        assert_eq!(loaded, Sample::default());
    }

    #[test]
    fn a_saved_store_round_trips_under_the_lock() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let written = Sample {
            schema_version: SAMPLE_VERSION,
            value: 7,
        };
        STORE
            .with_lock(directory.path(), || {
                STORE.save_unlocked(directory.path(), &written)
            })
            .expect("save");
        let loaded: Sample = STORE
            .with_lock(directory.path(), || STORE.load_unlocked(directory.path()))
            .expect("load");
        assert_eq!(loaded, written);
        assert!(STORE.path(directory.path()).is_file());
    }

    #[test]
    fn an_unknown_schema_version_is_rejected_instead_of_overwritten() {
        let directory = tempfile::tempdir().expect("temporary directory");
        STORE
            .save_unlocked(
                directory.path(),
                &Sample {
                    schema_version: 99,
                    value: 1,
                },
            )
            .expect("save");
        let failure = STORE
            .load_unlocked::<Sample>(directory.path())
            .expect_err("unknown version");
        assert!(matches!(failure, CoreError::Conflict(_)));
    }
}
