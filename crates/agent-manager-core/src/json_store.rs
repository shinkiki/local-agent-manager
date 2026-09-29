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
//!
//! 기록이 계속 쌓이는 저장소가 저장 직전에 거치는 보관 정리도 같은 이유로 여기 모은다
//! ([`trim_to_retention`]).

use std::collections::HashMap;
use std::hash::Hash;
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

    /// 잠금을 쥔 채 저장본 한 벌을 읽어 온다. 읽기만 하는 경로가
    /// `with_lock(|| load_unlocked(..))` 두 겹을 저마다 펼쳐 두던 것을 한 번으로 줄인다.
    pub(crate) fn read<T>(&self, app_data_dir: &Path) -> Result<T, CoreError>
    where
        T: DeserializeOwned + Default + SchemaVersioned,
    {
        self.with_lock(app_data_dir, || self.load_unlocked(app_data_dir))
    }

    /// 잠금을 쥔 채 저장본을 읽어 `edit`에 넘기고, `edit`가 `true`를 돌려주면 그 자리에서
    /// 저장한 뒤 바뀐 저장본을 돌려준다. `false`면 파일을 다시 쓰지 않는다.
    ///
    /// 저장소를 가진 모듈마다 "잠금 → 적재 → 수정 → 저장"을 손으로 다시 엮고 있었다.
    /// 네 단계가 흩어져 있으면 한 자리에서 저장을 빠뜨리거나 잠금 밖에서 저장해도
    /// 컴파일은 그대로 지나가고 저장본만 어긋나므로, 순서를 여기 한 벌로 묶어 둔다.
    pub(crate) fn update<T>(
        &self,
        app_data_dir: &Path,
        edit: impl FnOnce(&mut T) -> Result<bool, CoreError>,
    ) -> Result<T, CoreError>
    where
        T: DeserializeOwned + Default + SchemaVersioned + Serialize,
    {
        self.with_lock(app_data_dir, || {
            let mut store: T = self.load_unlocked(app_data_dir)?;
            if edit(&mut store)? {
                self.save_unlocked(app_data_dir, &store)?;
            }
            Ok(store)
        })
    }
}

/// 기록이 계속 쌓이는 저장소가 공유하는 보관 정리. 세션별 상한과 전체 상한을 함께
/// 지키면서, 상한에 걸리면 **오래된 것부터** 버린다.
///
/// 보완 저장소(`supplement_store`)와 채팅 런타임 실패 기록(`chat_runtime_store`)이
/// 각자 같은 네 단계를 적어 두고 있었다 — 최신순 정렬 → 키별 상한으로 걸러내기 →
/// 전체 상한으로 자르기 → 다시 오래된 순 정렬. 네 단계 중 하나만 어긋나도(예: 마지막
/// 정렬을 빠뜨리면 저장본의 순서가 뒤집힌다) 컴파일은 지나가고 저장본만 달라지므로
/// 한 벌로 모은다.
///
/// 정렬은 모두 안정 정렬이라 같은 시각의 항목끼리는 원래 순서를 지킨다.
pub(crate) fn trim_to_retention<T, K: Eq + Hash>(
    items: &mut Vec<T>,
    max_total: usize,
    max_per_key: usize,
    recorded_at: impl Fn(&T) -> i64,
    key: impl Fn(&T) -> K,
) {
    items.sort_by_key(|item| std::cmp::Reverse(recorded_at(item)));
    let mut per_key: HashMap<K, usize> = HashMap::new();
    items.retain(|item| {
        let count = per_key.entry(key(item)).or_default();
        *count += 1;
        *count <= max_per_key
    });
    items.truncate(max_total);
    items.sort_by_key(|item| recorded_at(item));
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

    /// 수정이 참을 돌려주면 저장본이 바뀌고, 돌려받는 값도 바뀐 쪽이다.
    #[test]
    fn an_update_that_reports_a_change_is_written_and_returned() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let returned = STORE
            .update(directory.path(), |store: &mut Sample| {
                store.value = 5;
                Ok(true)
            })
            .expect("update");
        assert_eq!(returned.value, 5);
        let reloaded: Sample = STORE.read(directory.path()).expect("read");
        assert_eq!(reloaded.value, 5);
    }

    /// 바뀐 것이 없다고 보고하면 파일을 만들지도 다시 쓰지도 않는다.
    #[test]
    fn an_update_that_reports_no_change_leaves_the_file_alone() {
        let directory = tempfile::tempdir().expect("temporary directory");
        STORE
            .update(directory.path(), |store: &mut Sample| {
                store.value = 5;
                Ok(false)
            })
            .expect("update");
        assert!(!STORE.path(directory.path()).exists());
    }

    /// 수정이 실패하면 그 자리에서 멈추고 저장본을 건드리지 않는다.
    #[test]
    fn a_failing_update_does_not_write() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let failure = STORE
            .update(directory.path(), |_: &mut Sample| {
                Err(CoreError::InvalidInput("거절".to_owned()))
            })
            .expect_err("rejected");
        assert!(matches!(failure, CoreError::InvalidInput(_)));
        assert!(!STORE.path(directory.path()).exists());
    }

    /// 키별 상한이 먼저 걸러내고, 남은 것에 전체 상한이 걸린다. 두 상한 모두 오래된
    /// 쪽을 버리고, 정리가 끝난 목록은 다시 오래된 순으로 저장된다.
    #[test]
    fn retention_drops_the_oldest_per_key_then_overall_and_keeps_ascending_order() {
        let mut items: Vec<(&str, i64)> =
            vec![("a", 1), ("a", 2), ("a", 3), ("b", 4), ("b", 5), ("c", 6)];
        trim_to_retention(&mut items, 4, 2, |item| item.1, |item| item.0);
        assert_eq!(items, vec![("a", 3), ("b", 4), ("b", 5), ("c", 6)]);
    }

    /// 상한에 닿지 않으면 버리는 것 없이 오래된 순 정렬만 남는다.
    #[test]
    fn retention_only_reorders_when_both_limits_have_room() {
        let mut items: Vec<(&str, i64)> = vec![("b", 5), ("a", 1), ("a", 3)];
        trim_to_retention(&mut items, 10, 10, |item| item.1, |item| item.0);
        assert_eq!(items, vec![("a", 1), ("a", 3), ("b", 5)]);
    }
}
