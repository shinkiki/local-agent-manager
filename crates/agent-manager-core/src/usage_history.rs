//! 계정별 사용량 주기 이력.
//!
//! 공급자는 지금 진행 중인 창의 소진율만 알려 주고, 초기화가 지나면 그 주기의 값은
//! 사라진다. "한 달·분기 동안 공급자가 준 주기별 제공량을 얼마나 소비했는가"를 보려면
//! 주기가 끝나기 전에 그 주기의 최종 소진율을 어딘가에 남겨야 한다. 이 모듈은 사용량
//! 갱신마다 일 단위 창(7일 등)의 주기 하나당 레코드 하나를 유지한다 — 주기는 공급자가
//! 알려 준 초기화 시각으로 식별하고, 소진율은 그 주기에서 관측한 최대값이다(창 안에서
//! 소진율은 줄지 않으므로 최대값이 곧 초기화 직전 값이다).
//!
//! 5시간 창은 남기지 않는다. 하루 다섯 주기라 이력이 금세 커지고, 사용자가 보려는
//! 지표는 주 단위 예산의 소비율이다. `usage_pacing`의 표본은 최근 96개만 남아 며칠
//! 치밖에 보지 못하므로 별도 저장소를 둔다(G7: 앱 데이터 디렉터리의 파생 데이터).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::accounts::{AccountUsageStatus, AccountUsageView};
use crate::app_data_file::write_private_json;
use crate::clock::now_ms;
use crate::store_lock;
use crate::usage_budget_policy::window_label_length_ms;
use crate::CoreError;

const STORE_FILE: &str = "usage-history-v1.json";
const STORE_LOCK_FILE: &str = "usage-history-v1.lock";
const STORE_VERSION: u32 = 1;

/// 계정 하나가 보관하는 주기 레코드 수. 창 라벨이 둘(Claude `7일`·`Fable 7일`)인
/// 계정이 2년치를 넘게 남길 만큼만 둔다.
const MAX_RECORDS_PER_ACCOUNT: usize = 240;
/// 이력에 남기는 최소 주기 길이. 이보다 짧은 창(5시간)은 남기지 않는다.
const MIN_TRACKED_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// 초기화 시각이 이 안에서 흔들리면 같은 주기로 본다. 공급자 응답의 초기화 시각은 초
/// 단위로 어긋날 수 있지만 주기 길이(≥1일)에 비하면 훨씬 작다.
const SAME_CYCLE_TOLERANCE_MS: i64 = 12 * 60 * 60 * 1000;

/// 한 주기의 관측 결과.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCycleRecord {
    /// 창 라벨. 공급자가 준 것 그대로(`7일`, `Fable 7일`).
    pub window_label: String,
    /// 이 창의 주기 길이(ms). 라벨의 `N일`에서 유도한다.
    pub window_length_ms: i64,
    /// 주기의 끝 = 공급자가 알려 준 초기화 시각. 마지막 관측값을 유지한다.
    pub resets_at: i64,
    /// 이 주기에서 관측한 최대 소진율(%).
    pub peak_used_percent: f64,
    pub first_observed_at: i64,
    pub last_observed_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageHistory {
    pub account_id: String,
    /// 이 계정의 사용량을 처음 성공적으로 읽은 시각. 그 전 기간은 관측이 없어
    /// 소비가 없었다고 말할 수 없으므로 지표의 시작점은 여기로 당긴다.
    pub observed_since: i64,
    /// `resets_at` 오름차순.
    pub cycles: Vec<UsageCycleRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistorySnapshot {
    pub accounts: Vec<AccountUsageHistory>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryStore {
    #[serde(default = "store_version")]
    schema_version: u32,
    #[serde(default)]
    accounts: BTreeMap<String, AccountSeries>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountSeries {
    observed_since: i64,
    #[serde(default)]
    cycles: Vec<UsageCycleRecord>,
}

fn store_version() -> u32 {
    STORE_VERSION
}

impl Default for HistoryStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            accounts: BTreeMap::new(),
        }
    }
}

fn with_store_lock<T>(
    app_data_dir: &Path,
    action: impl FnOnce() -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let _lock = store_lock::acquire(app_data_dir, STORE_LOCK_FILE, "사용량 이력 저장소")?;
    action()
}

/// 저장소를 읽는다. 파일이 없으면 페이싱 표본으로 첫 이력을 만든다 — 이 저장소가
/// 생기기 전에도 표본은 며칠치 남아 있어, 진행 중인 주기의 관측을 이어받을 수 있다.
/// 이력은 파생 데이터라 읽기 실패는 새 저장소로 대신하고 갱신을 막지 않는다.
fn load_store(app_data_dir: &Path) -> HistoryStore {
    let path = app_data_dir.join(STORE_FILE);
    if !path.is_file() {
        let mut store = HistoryStore::default();
        for sample in crate::usage_pacing::export_samples(app_data_dir) {
            let usage = AccountUsageView {
                status: AccountUsageStatus::Ok,
                windows: vec![crate::accounts::AccountUsageWindow {
                    label: sample.window_label,
                    used_percent: sample.used_percent,
                    resets_at: sample.resets_at,
                    ..Default::default()
                }],
                updated_at: Some(sample.at),
                error: None,
                retry_at: None,
                rate_limited: false,
                token_refresh_limited: false,
                token_refresh_throttle_streak: 0,
                reset_credits: None,
            };
            apply_usage(&mut store, &sample.account_id, &usage, sample.at);
        }
        return store;
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!("[usage-history] 이력 저장소를 읽지 못해 새로 시작합니다: {error}");
            return HistoryStore::default();
        }
    };
    match serde_json::from_slice::<HistoryStore>(&bytes) {
        Ok(store) if store.schema_version == STORE_VERSION => store,
        Ok(_) => HistoryStore::default(),
        Err(error) => {
            eprintln!("[usage-history] 이력 저장소를 해석하지 못해 새로 시작합니다: {error}");
            HistoryStore::default()
        }
    }
}

fn save_store(app_data_dir: &Path, store: &HistoryStore) -> Result<(), CoreError> {
    write_private_json(&app_data_dir.join(STORE_FILE), store)
}

/// 성공한 사용량 조회 하나를 이력에 반영한다. 순수 함수라 시험이 시각을 직접 준다.
fn apply_usage(store: &mut HistoryStore, account_id: &str, usage: &AccountUsageView, at: i64) {
    if usage.status != AccountUsageStatus::Ok {
        return;
    }
    let series = store
        .accounts
        .entry(account_id.to_owned())
        .or_insert_with(|| AccountSeries {
            observed_since: at,
            cycles: Vec::new(),
        });
    series.observed_since = series.observed_since.min(at);
    for window in &usage.windows {
        let Some(window_length_ms) = window_label_length_ms(&window.label) else {
            continue;
        };
        if window_length_ms < MIN_TRACKED_WINDOW_MS {
            continue;
        }
        // 초기화 시각이 없는 창은 아직 시작되지 않은 창이다(소비 0). 남길 주기가 없다.
        let Some(resets_at) = window.resets_at else {
            continue;
        };
        let tolerance = SAME_CYCLE_TOLERANCE_MS.min(window_length_ms / 4);
        if let Some(existing) = series.cycles.iter_mut().find(|cycle| {
            cycle.window_label == window.label && (cycle.resets_at - resets_at).abs() <= tolerance
        }) {
            existing.peak_used_percent = existing.peak_used_percent.max(window.used_percent);
            existing.resets_at = resets_at;
            existing.first_observed_at = existing.first_observed_at.min(at);
            existing.last_observed_at = existing.last_observed_at.max(at);
        } else {
            series.cycles.push(UsageCycleRecord {
                window_label: window.label.clone(),
                window_length_ms,
                resets_at,
                peak_used_percent: window.used_percent.clamp(0.0, 100.0),
                first_observed_at: at,
                last_observed_at: at,
            });
        }
    }
    series.cycles.sort_by_key(|cycle| cycle.resets_at);
    if series.cycles.len() > MAX_RECORDS_PER_ACCOUNT {
        let excess = series.cycles.len() - MAX_RECORDS_PER_ACCOUNT;
        series.cycles.drain(..excess);
    }
}

/// 사용량 갱신이 계정 레코드에 반영된 직후 호출한다. 실패는 갱신을 실패시키지 않고
/// 경고만 남긴다 — 이력은 파생 데이터다.
pub(crate) fn record_usage(app_data_dir: &Path, account_id: &str, usage: &AccountUsageView) {
    if usage.status != AccountUsageStatus::Ok || usage.windows.is_empty() {
        return;
    }
    let at = usage.updated_at.unwrap_or_else(now_ms);
    let result = with_store_lock(app_data_dir, || {
        let mut store = load_store(app_data_dir);
        apply_usage(&mut store, account_id, usage, at);
        save_store(app_data_dir, &store)
    });
    if let Err(error) = result {
        eprintln!("[usage-history] 계정 {account_id} 사용량 이력을 남기지 못했습니다: {error}");
    }
}

/// 계정 등록을 지울 때 그 계정의 이력도 함께 지운다.
pub(crate) fn remove_account(app_data_dir: &Path, account_id: &str) {
    let result = with_store_lock(app_data_dir, || {
        let mut store = load_store(app_data_dir);
        if store.accounts.remove(account_id).is_none() {
            return Ok(());
        }
        save_store(app_data_dir, &store)
    });
    if let Err(error) = result {
        eprintln!("[usage-history] 계정 {account_id} 사용량 이력을 지우지 못했습니다: {error}");
    }
}

/// 등록된 계정들의 이력. `account_ids`에 없는 계정(지워졌거나 아직 정리되지 않은
/// 잔재)은 돌려주지 않는다.
pub(crate) fn snapshot(
    app_data_dir: &Path,
    account_ids: &[String],
) -> Result<UsageHistorySnapshot, CoreError> {
    let store = with_store_lock(app_data_dir, || Ok(load_store(app_data_dir)))?;
    Ok(UsageHistorySnapshot {
        accounts: account_ids
            .iter()
            .filter_map(|account_id| {
                store
                    .accounts
                    .get(account_id)
                    .map(|series| AccountUsageHistory {
                        account_id: account_id.clone(),
                        observed_since: series.observed_since,
                        cycles: series.cycles.clone(),
                    })
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::AccountUsageWindow;

    const DAY: i64 = 24 * 60 * 60 * 1000;

    fn usage(windows: Vec<(&str, f64, Option<i64>)>, at: i64) -> AccountUsageView {
        AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: windows
                .into_iter()
                .map(|(label, used_percent, resets_at)| AccountUsageWindow {
                    label: label.to_owned(),
                    used_percent,
                    resets_at,
                    ..Default::default()
                })
                .collect(),
            updated_at: Some(at),
            error: None,
            retry_at: None,
            rate_limited: false,
            token_refresh_limited: false,
            token_refresh_throttle_streak: 0,
            reset_credits: None,
        }
    }

    /// 시험용: 조회 시각은 usage.updated_at으로 준다.
    fn apply(store: &mut HistoryStore, account_id: &str, usage: &AccountUsageView) {
        apply_usage(
            store,
            account_id,
            usage,
            usage.updated_at.unwrap_or_default(),
        );
    }

    #[test]
    fn one_record_per_cycle_keeps_the_peak_and_skips_short_windows() {
        let mut store = HistoryStore::default();
        let reset = 100 * DAY;
        apply(
            &mut store,
            "acct",
            &usage(
                vec![("5시간", 90.0, Some(reset)), ("7일", 20.0, Some(reset))],
                reset - 6 * DAY,
            ),
        );
        // 같은 주기: 초기화 시각이 몇 초 흔들려도 한 레코드로 합치고 최대값을 남긴다.
        apply(
            &mut store,
            "acct",
            &usage(vec![("7일", 65.0, Some(reset + 3_000))], reset - 2 * DAY),
        );
        // 다음 주기: 새 레코드.
        apply(
            &mut store,
            "acct",
            &usage(vec![("7일", 10.0, Some(reset + 7 * DAY))], reset + DAY),
        );
        let series = &store.accounts["acct"];
        assert_eq!(series.observed_since, reset - 6 * DAY);
        assert_eq!(series.cycles.len(), 2, "5시간 창은 남기지 않는다");
        assert_eq!(series.cycles[0].window_label, "7일");
        assert_eq!(series.cycles[0].peak_used_percent, 65.0);
        assert_eq!(series.cycles[0].resets_at, reset + 3_000);
        assert_eq!(series.cycles[0].window_length_ms, 7 * DAY);
        assert_eq!(series.cycles[0].first_observed_at, reset - 6 * DAY);
        assert_eq!(series.cycles[0].last_observed_at, reset - 2 * DAY);
        assert_eq!(series.cycles[1].peak_used_percent, 10.0);
    }

    #[test]
    fn unstarted_windows_and_failed_reads_leave_no_cycle() {
        let mut store = HistoryStore::default();
        apply(&mut store, "acct", &usage(vec![("7일", 0.0, None)], DAY));
        assert!(store.accounts["acct"].cycles.is_empty());
        assert_eq!(store.accounts["acct"].observed_since, DAY);
        let mut failed = usage(vec![("7일", 50.0, Some(8 * DAY))], 2 * DAY);
        failed.status = AccountUsageStatus::Error;
        apply(&mut store, "acct", &failed);
        assert!(store.accounts["acct"].cycles.is_empty());
    }

    #[test]
    fn record_persists_and_removal_drops_the_account() {
        let dir = tempfile::tempdir().expect("tempdir");
        let reset = 50 * DAY;
        record_usage(
            dir.path(),
            "a",
            &usage(vec![("7일", 40.0, Some(reset))], reset - DAY),
        );
        record_usage(
            dir.path(),
            "b",
            &usage(vec![("7일", 70.0, Some(reset))], reset - DAY),
        );
        let history = super::snapshot(
            dir.path(),
            &["a".to_owned(), "b".to_owned(), "ghost".to_owned()],
        )
        .expect("snapshot");
        assert_eq!(
            history.accounts.len(),
            2,
            "등록되지 않은 계정은 돌려주지 않는다"
        );
        assert_eq!(history.accounts[1].cycles[0].peak_used_percent, 70.0);
        remove_account(dir.path(), "a");
        let history =
            super::snapshot(dir.path(), &["a".to_owned(), "b".to_owned()]).expect("snapshot");
        assert_eq!(history.accounts.len(), 1);
        assert_eq!(history.accounts[0].account_id, "b");
    }

    #[test]
    fn first_load_seeds_from_pacing_samples() {
        let dir = tempfile::tempdir().expect("tempdir");
        let reset = 30 * DAY;
        crate::usage_pacing::record_usage_sample(
            dir.path(),
            "seeded",
            &usage(
                vec![("7일", 35.0, Some(reset)), ("5시간", 80.0, Some(reset))],
                reset - 3 * DAY,
            ),
        );
        crate::usage_pacing::record_usage_sample(
            dir.path(),
            "seeded",
            &usage(vec![("7일", 55.0, Some(reset))], reset - 2 * DAY),
        );
        let history = super::snapshot(dir.path(), &["seeded".to_owned()]).expect("snapshot");
        assert_eq!(history.accounts.len(), 1);
        assert_eq!(history.accounts[0].observed_since, reset - 3 * DAY);
        assert_eq!(history.accounts[0].cycles.len(), 1);
        assert_eq!(history.accounts[0].cycles[0].peak_used_percent, 55.0);
    }
}
