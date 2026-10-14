//! Antigravity CLI 전역 MCP 설정을 앱의 애드온 상태에 맞춘다(`AGENTS.md` P12).
//!
//! Antigravity는 실행 단위 MCP 플래그가 없어 앱이 채팅마다 서버를 붙여 주지 못한다. 설정
//! 층은 전역 `~/.gemini/config/mcp_config.json` 하나뿐이고, 계정별 프로필 HOME도
//! `.gemini/config`를 공용 홈으로 링크해 같은 파일을 본다(C12-4). 그래서 Claude·Codex·로컬이
//! 채팅마다 받는 것과 같은 목록 — 켜져 있고 자격증명이 준비된 외부 플러그인과, 켜져 있으면
//! 내장 Cypress — 을 그 파일에 등록해 둔다.
//!
//! - 쓰기는 공급자 공식 CLI(`agy mcp add|remove|disable`)만 한다(G3). 앱이 그 파일을 직접
//!   고치지 않는다(G2). 읽기는 등록 상태를 대조하는 데만 쓴다(G1).
//! - 소유는 장부(`antigravity-mcp-registrations.json`, G7)와 프록시 주소로만 정한다. 라우트
//!   키는 부팅 사이에 유지되는 무작위 값이라, 지금 프록시를 정확히 가리키는 주소는 이 앱이
//!   만든 것이다. 그 밖의 항목 — 사용자가 직접 넣은 서버 — 은 이름이 겹쳐도 건드리지 않고
//!   충돌로만 알린다(C5-10과 같은 원칙: 존재가 소유를 뜻하지 않는다).
//! - 사용자가 `agy mcp disable`로 꺼 둔 항목은 끈 채로 둔다. 주소를 고쳐야 할 때도 다시 끈다.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::domain::ProviderId;
use crate::CoreError;

const LEDGER_FILE: &str = "antigravity-mcp-registrations.json";
const LEDGER_SCHEMA_VERSION: u32 = 1;
/// 사용자 설정 파일이 이보다 크면 대조하지 않는다. 손으로 쓴 MCP 설정이 이만큼일 리 없다.
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const AGY_TIMEOUT: Duration = Duration::from_secs(20);
/// 채팅 시작이 다른 동기화(부팅 직후 포트가 바뀌어 여러 건을 고치는 중 등)를 기다리는 상한.
/// 넘기면 이번 채팅은 지금 등록된 그대로 시작한다 — 동기화는 시작을 막지 않는다(P12).
const START_LOCK_WAIT: Duration = Duration::from_secs(2);

/// 동기화는 한 번에 하나만 돈다. 채팅 시작과 애드온 변경이 겹쳐도 `agy`가 같은 파일을 두
/// 번 고쳐 쓰며 서로의 결과를 덮지 않게 한다.
static SYNC_LOCK: Mutex<()> = Mutex::new(());

/// `mcp_config.json`의 서버 하나. 앱이 대조하는 데 필요한 두 칸만 읽는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConfigEntry {
    pub(crate) url: Option<String>,
    pub(crate) disabled: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ledger {
    schema_version: u32,
    /// 이 앱이 등록한 서버 이름 → 등록한 주소.
    #[serde(default)]
    entries: BTreeMap<String, String>,
    /// 마지막 동기화에서 이름이 겹쳐 등록하지 못한 서버. 화면이 이유를 보일 수 있게 남긴다.
    #[serde(default)]
    conflicts: Vec<String>,
    /// 사용자가 `agy mcp disable`로 꺼 둔 이 앱의 항목. 플러그인이 잠시 붙을 수 없게 돼
    /// 항목이 빠졌다가 다시 등록될 때도 끈 채로 되살리려고 관찰한 값을 남긴다.
    #[serde(default)]
    disabled: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Action {
    /// 등록하거나 주소를 고친다. `keep_disabled`면 사용자가 꺼 둔 상태를 되살린다.
    Add {
        name: String,
        url: String,
        keep_disabled: bool,
    },
    Remove {
        name: String,
    },
    /// 설정은 이미 맞다. 장부에만 적는다.
    Adopt {
        name: String,
        url: String,
    },
    /// 설정에 없거나 사용자가 바꿨다. 장부에서만 지운다.
    Forget {
        name: String,
    },
    /// 사용자가 같은 이름으로 다른 서버를 등록해 두었다. 손대지 않는다.
    Conflict {
        name: String,
    },
}

/// 동기화 결과. 실패해도 채팅은 시작하므로 호출부는 기록만 한다.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct SyncReport {
    pub(crate) added: Vec<String>,
    pub(crate) removed: Vec<String>,
    pub(crate) conflicts: Vec<String>,
}

/// 외부 플러그인을 Antigravity에 등록할 주소. Claude·Codex·로컬이 채팅마다 받는 주소와 같은
/// 함수가 만든다 — `<agent>` 조각이 `antigravity`라서 프록시는 승인 통로가 없는 쪽의 노출
/// 규칙을 적용한다(P12).
pub(crate) fn plugin_url(base: &str, id: &str) -> String {
    crate::external_plugins::plugin_proxy_url(base, ProviderId::Antigravity, id)
}

fn cypress_url(base: &str) -> String {
    format!("{base}{}", crate::system_mcp::CYPRESS_PATH)
}

/// 이 주소가 지금 프록시를 가리키는 이 앱의 등록인지. 장부가 첫 근거이고, 장부가 생기기
/// 전에 손으로 넣은 옛 한 조각 주소(`<base>/<id>`)도 같은 라우트 키라 이 앱의 것이다.
fn owned_by_app(name: &str, url: &str, base: &str, ledger: &BTreeMap<String, String>) -> bool {
    ledger.get(name).is_some_and(|recorded| recorded == url)
        || url == format!("{base}/{name}")
        || url == plugin_url(base, name)
        || (name == crate::chat::CYPRESS_MCP_SERVER_ID && url == cypress_url(base))
}

fn plan(
    current: &BTreeMap<String, ConfigEntry>,
    desired: &BTreeMap<String, String>,
    ledger: &BTreeMap<String, String>,
    user_disabled: &BTreeSet<String>,
    base: &str,
) -> Vec<Action> {
    let mut actions = Vec::new();
    for (name, url) in desired {
        match current.get(name) {
            None => actions.push(Action::Add {
                name: name.clone(),
                url: url.clone(),
                keep_disabled: user_disabled.contains(name),
            }),
            Some(entry) if entry.url.as_deref() == Some(url.as_str()) => {
                if ledger.get(name) != Some(url) {
                    actions.push(Action::Adopt {
                        name: name.clone(),
                        url: url.clone(),
                    });
                }
            }
            Some(entry)
                if entry
                    .url
                    .as_deref()
                    .is_some_and(|current| owned_by_app(name, current, base, ledger)) =>
            {
                actions.push(Action::Add {
                    name: name.clone(),
                    url: url.clone(),
                    keep_disabled: entry.disabled,
                })
            }
            Some(_) => actions.push(Action::Conflict { name: name.clone() }),
        }
    }
    for (name, entry) in current {
        if desired.contains_key(name) {
            continue;
        }
        if entry
            .url
            .as_deref()
            .is_some_and(|url| owned_by_app(name, url, base, ledger))
        {
            actions.push(Action::Remove { name: name.clone() });
        }
    }
    for name in ledger.keys() {
        let still_ours = current.get(name).is_some_and(|entry| {
            entry
                .url
                .as_deref()
                .is_some_and(|url| owned_by_app(name, url, base, ledger))
        });
        if !desired.contains_key(name) && !still_ours {
            actions.push(Action::Forget { name: name.clone() });
        }
    }
    actions
}

/// 전역 설정의 서버 목록. 파일이 없으면 빈 목록이고, 읽었는데 해석하지 못하면 오류다 —
/// 그 상태로 `agy`를 돌리면 사용자 파일을 무엇으로 덮을지 앱이 알 수 없다.
pub(crate) fn read_config(home: &Path) -> Result<BTreeMap<String, ConfigEntry>, CoreError> {
    let path = config_path(home);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
    };
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(CoreError::TooLarge(MAX_CONFIG_BYTES));
    }
    let config: Value = serde_json::from_slice(&std::fs::read(&path)?).map_err(|error| {
        CoreError::InvalidInput(format!(
            "Antigravity MCP 설정({})을 해석하지 못했습니다: {error}",
            path.display()
        ))
    })?;
    let Some(servers) = config.get("mcpServers") else {
        return Ok(BTreeMap::new());
    };
    let servers = servers.as_object().ok_or_else(|| {
        CoreError::InvalidInput("Antigravity MCP 설정의 mcpServers가 객체가 아닙니다".to_owned())
    })?;
    Ok(servers
        .iter()
        .map(|(name, server)| {
            let url = server
                .get("serverUrl")
                .or_else(|| server.get("url"))
                .and_then(Value::as_str)
                .map(|url| url.trim_end_matches('/').to_owned());
            let disabled = server
                .get("disabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            (name.clone(), ConfigEntry { url, disabled })
        })
        .collect())
}

fn config_path(home: &Path) -> PathBuf {
    home.join(".gemini/config/mcp_config.json")
}

/// 지금 Antigravity가 봐야 하는 서버 — 다른 공급자가 채팅마다 받는 목록과 같은 판정이다.
fn desired_servers(app_data_dir: &Path, base: &str) -> Result<BTreeMap<String, String>, CoreError> {
    let mut desired: BTreeMap<String, String> =
        crate::external_plugins::ExternalPluginRegistry::new(app_data_dir.to_path_buf())
            .attachable_plugins()?
            .into_iter()
            .map(|(id, _)| {
                let url = plugin_url(base, &id);
                (id, url)
            })
            .collect();
    if crate::cypress_workspaces::is_enabled(app_data_dir)? {
        desired.insert(
            crate::chat::CYPRESS_MCP_SERVER_ID.to_owned(),
            cypress_url(base),
        );
    }
    Ok(desired)
}

fn load_ledger(app_data_dir: &Path) -> Ledger {
    crate::app_data_file::read_private_json::<Ledger>(&app_data_dir.join(LEDGER_FILE))
        .ok()
        .flatten()
        .filter(|ledger| ledger.schema_version == LEDGER_SCHEMA_VERSION)
        .unwrap_or_default()
}

fn save_ledger(app_data_dir: &Path, ledger: &mut Ledger) -> Result<(), CoreError> {
    ledger.schema_version = LEDGER_SCHEMA_VERSION;
    crate::app_data_file::write_private_json(&app_data_dir.join(LEDGER_FILE), ledger)
}

/// 마지막 동기화에서 이름이 겹쳐 등록하지 못한 서버. 기본도구 카탈로그가 이유로 싣는다.
pub(crate) fn last_conflicts(app_data_dir: &Path) -> Vec<String> {
    load_ledger(app_data_dir).conflicts
}

fn run_agy(executable: &Path, args: &[&str]) -> Result<(), CoreError> {
    let outcome = crate::cli_interface::run_capped_with(
        executable,
        args,
        AGY_TIMEOUT,
        &crate::cli_interface::CappedOptions {
            strip_credential_env: true,
            ..crate::cli_interface::CappedOptions::default()
        },
    )?;
    if outcome.success {
        return Ok(());
    }
    let detail = if outcome.timed_out {
        "시간 초과".to_owned()
    } else {
        crate::text_limit::truncate_chars(outcome.stderr.trim(), 300)
    };
    Err(CoreError::Runtime(format!(
        "agy {} 실패: {detail}",
        args.join(" ")
    )))
}

/// 계획을 공식 CLI로 실행한다. 명령 하나가 성공할 때마다 장부를 고치므로, 중간에 실패해도
/// 장부는 실제 설정과 어긋나지 않는다.
fn apply(
    executable: &Path,
    actions: Vec<Action>,
    ledger: &mut Ledger,
) -> (SyncReport, Option<CoreError>) {
    let mut report = SyncReport::default();
    for action in actions {
        let result = match &action {
            Action::Add {
                name,
                url,
                keep_disabled,
            } => run_agy(executable, &["mcp", "add", "--type", "http", name, url]).and_then(|()| {
                ledger.entries.insert(name.clone(), url.clone());
                report.added.push(name.clone());
                if *keep_disabled {
                    run_agy(executable, &["mcp", "disable", name])
                } else {
                    Ok(())
                }
            }),
            Action::Remove { name } => run_agy(executable, &["mcp", "remove", name])
                .or_else(|error| {
                    // 그새 사용자가 지웠다면 목적은 이미 이뤄졌다.
                    if error.to_string().contains("not found") {
                        Ok(())
                    } else {
                        Err(error)
                    }
                })
                .map(|()| {
                    ledger.entries.remove(name);
                    report.removed.push(name.clone());
                }),
            Action::Adopt { name, url } => {
                ledger.entries.insert(name.clone(), url.clone());
                Ok(())
            }
            Action::Forget { name } => {
                ledger.entries.remove(name);
                Ok(())
            }
            Action::Conflict { name } => {
                report.conflicts.push(name.clone());
                Ok(())
            }
        };
        if let Err(error) = result {
            return (report, Some(error));
        }
    }
    (report, None)
}

/// 이 프로세스가 지금 여는 프록시 주소. 넘겨받지 못한 자리(OAuth 콜백)는 저장본을 쓴다 —
/// 같은 앱 데이터를 쓰는 다른 인스턴스가 저장본을 바꿨을 수 있어 살아 있는 값을 먼저 본다.
fn proxy_base(app_data_dir: &Path, live: Option<String>) -> Option<String> {
    live.or_else(|| crate::system_mcp::stored_plugin_proxy_base(app_data_dir))
}

/// 등록을 맞춘다. 프록시 주소가 아직 없거나(백엔드가 한 번도 뜨지 않음) `agy`가 없으면
/// 할 일이 없다.
pub(crate) fn sync(
    app_data_dir: &Path,
    live_base: Option<String>,
) -> Result<SyncReport, CoreError> {
    let Some(base) = proxy_base(app_data_dir, live_base) else {
        return Ok(SyncReport::default());
    };
    let Some(home) = crate::user_home::optional_home_dir() else {
        return Ok(SyncReport::default());
    };
    let Ok(executable) = crate::chat::resolve_executable(ProviderId::Antigravity) else {
        return Ok(SyncReport::default());
    };
    sync_with(app_data_dir, &home, &executable, &base, None)
}

/// `wait`가 있으면 그만큼만 기다리고 못 잡으면 None이다.
fn acquire_sync_lock(wait: Option<Duration>) -> Option<MutexGuard<'static, ()>> {
    let Some(wait) = wait else {
        return Some(
            SYNC_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        );
    };
    let deadline = Instant::now() + wait;
    loop {
        match SYNC_LOCK.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Some(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(TryLockError::WouldBlock) => return None,
        }
    }
}

fn sync_with(
    app_data_dir: &Path,
    home: &Path,
    executable: &Path,
    base: &str,
    wait: Option<Duration>,
) -> Result<SyncReport, CoreError> {
    let Some(_guard) = acquire_sync_lock(wait) else {
        return Err(CoreError::Runtime(
            "다른 동기화가 진행 중이라 이번 시작은 지금 등록된 그대로 진행합니다".to_owned(),
        ));
    };
    let desired = desired_servers(app_data_dir, base)?;
    let current = read_config(home)?;
    let mut ledger = load_ledger(app_data_dir);
    // 사용자가 끄고 켠 것은 설정이 진실이다. 이 앱의 항목만 관찰해 장부에 옮긴다.
    let disabled_before = ledger.disabled.clone();
    for (name, entry) in &current {
        let ours = entry
            .url
            .as_deref()
            .is_some_and(|url| owned_by_app(name, url, base, &ledger.entries));
        if ours && entry.disabled {
            ledger.disabled.insert(name.clone());
        } else if ours {
            ledger.disabled.remove(name);
        }
    }
    let actions = plan(&current, &desired, &ledger.entries, &ledger.disabled, base);
    if actions.is_empty() && ledger.conflicts.is_empty() && ledger.disabled == disabled_before {
        return Ok(SyncReport::default());
    }
    let (report, failure) = apply(executable, actions, &mut ledger);
    ledger.conflicts = report.conflicts.clone();
    save_ledger(app_data_dir, &mut ledger)?;
    match failure {
        Some(error) => Err(error),
        None => Ok(report),
    }
}

fn log_outcome(result: Result<SyncReport, CoreError>) {
    match result {
        Ok(report) => {
            if !report.added.is_empty() || !report.removed.is_empty() {
                eprintln!(
                    "[antigravity-mcp] 전역 MCP 등록을 맞췄습니다: 추가·갱신 {:?}, 제거 {:?}",
                    report.added, report.removed
                );
            }
            if !report.conflicts.is_empty() {
                eprintln!(
                    "[antigravity-mcp] 같은 이름의 사용자 서버가 있어 등록하지 않았습니다: {:?}",
                    report.conflicts
                );
            }
        }
        Err(error) => eprintln!("[antigravity-mcp] 전역 MCP 등록을 맞추지 못했습니다: {error}"),
    }
}

/// Antigravity 채팅을 띄우기 직전. CLI는 시작할 때 MCP 목록을 고정하므로 이 자리가 그 채팅이
/// 보는 목록을 정한다. 실패해도 채팅은 시작한다 — 플러그인 없이 도는 것이 못 도는 것보다 낫다.
/// 다른 동기화가 오래 걸리면 `START_LOCK_WAIT`만 기다리고 지금 등록된 그대로 시작한다.
pub(crate) fn sync_before_start(app_data_dir: &Path, executable: &Path, live_base: Option<String>) {
    if cfg!(test) {
        return;
    }
    let Some(base) = proxy_base(app_data_dir, live_base) else {
        return;
    };
    let Some(home) = crate::user_home::optional_home_dir() else {
        return;
    };
    log_outcome(sync_with(
        app_data_dir,
        &home,
        executable,
        &base,
        Some(START_LOCK_WAIT),
    ));
}

/// 애드온 상태가 바뀐 자리(플러그인 등록·토글·인증, Cypress 토글, 백엔드 시작). 바뀐 것이
/// 없으면 파일 두 개를 읽고 끝난다.
pub(crate) fn sync_in_background(app_data_dir: PathBuf, live_base: Option<String>) {
    if cfg!(test) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("antigravity-mcp-sync".to_owned())
        .spawn(move || log_outcome(sync(&app_data_dir, live_base)));
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "http://127.0.0.1:4179/plugins/0123456789abcdef0123456789abcdef";

    fn entry(url: &str) -> ConfigEntry {
        ConfigEntry {
            url: Some(url.to_owned()),
            disabled: false,
        }
    }

    fn map<V: Clone>(pairs: &[(&str, V)]) -> BTreeMap<String, V> {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), value.clone()))
            .collect()
    }

    #[test]
    fn p12_registers_missing_plugins_with_the_antigravity_route() {
        let desired = map(&[("github", plugin_url(BASE, "github"))]);
        let actions = plan(
            &BTreeMap::new(),
            &desired,
            &BTreeMap::new(),
            &BTreeSet::new(),
            BASE,
        );
        assert_eq!(
            actions,
            vec![Action::Add {
                name: "github".to_owned(),
                url: format!("{BASE}/antigravity/github"),
                keep_disabled: false,
            }]
        );
    }

    #[test]
    fn p12_migrates_a_hand_registered_legacy_address() {
        let current = map(&[("notion-bizple", entry(&format!("{BASE}/notion-bizple")))]);
        let desired = map(&[("notion-bizple", plugin_url(BASE, "notion-bizple"))]);
        let actions = plan(&current, &desired, &BTreeMap::new(), &BTreeSet::new(), BASE);
        assert_eq!(
            actions,
            vec![Action::Add {
                name: "notion-bizple".to_owned(),
                url: plugin_url(BASE, "notion-bizple"),
                keep_disabled: false,
            }]
        );
    }

    #[test]
    fn p12_never_touches_a_user_server_with_the_same_name() {
        let current = map(&[("github", entry("https://api.githubcopilot.com/mcp"))]);
        let desired = map(&[("github", plugin_url(BASE, "github"))]);
        assert_eq!(
            plan(&current, &desired, &BTreeMap::new(), &BTreeSet::new(), BASE),
            vec![Action::Conflict {
                name: "github".to_owned()
            }]
        );
        // 원하지 않게 된 뒤에도 사용자 서버는 지우지 않는다.
        assert!(plan(
            &current,
            &BTreeMap::new(),
            &BTreeMap::new(),
            &BTreeSet::new(),
            BASE
        )
        .is_empty());
    }

    #[test]
    fn p12_removes_only_entries_the_app_owns() {
        let old_base = "http://127.0.0.1:5000/plugins/ffffffffffffffffffffffffffffffff";
        let current = map(&[
            ("jira", entry(&plugin_url(BASE, "jira"))),
            ("moved", entry(&plugin_url(old_base, "moved"))),
            ("mine", entry("http://localhost:9000/mcp")),
        ]);
        let ledger = map(&[("moved", plugin_url(old_base, "moved"))]);
        let actions = plan(&current, &BTreeMap::new(), &ledger, &BTreeSet::new(), BASE);
        assert_eq!(
            actions,
            vec![
                Action::Remove {
                    name: "jira".to_owned()
                },
                Action::Remove {
                    name: "moved".to_owned()
                },
            ]
        );
    }

    #[test]
    fn p12_follows_a_port_change_through_the_ledger() {
        let old_base = "http://127.0.0.1:5000/plugins/ffffffffffffffffffffffffffffffff";
        let current = map(&[("notion", entry(&plugin_url(old_base, "notion")))]);
        let desired = map(&[("notion", plugin_url(BASE, "notion"))]);
        // 장부가 없으면 옛 주소가 이 앱의 것인지 알 수 없다 — 충돌로 남긴다.
        assert_eq!(
            plan(&current, &desired, &BTreeMap::new(), &BTreeSet::new(), BASE),
            vec![Action::Conflict {
                name: "notion".to_owned()
            }]
        );
        let ledger = map(&[("notion", plugin_url(old_base, "notion"))]);
        assert_eq!(
            plan(&current, &desired, &ledger, &BTreeSet::new(), BASE),
            vec![Action::Add {
                name: "notion".to_owned(),
                url: plugin_url(BASE, "notion"),
                keep_disabled: false,
            }]
        );
    }

    #[test]
    fn p12_keeps_a_user_disabled_entry_disabled() {
        let current = map(&[(
            "notion",
            ConfigEntry {
                url: Some(format!("{BASE}/notion")),
                disabled: true,
            },
        )]);
        let desired = map(&[("notion", plugin_url(BASE, "notion"))]);
        assert_eq!(
            plan(&current, &desired, &BTreeMap::new(), &BTreeSet::new(), BASE),
            vec![Action::Add {
                name: "notion".to_owned(),
                url: plugin_url(BASE, "notion"),
                keep_disabled: true,
            }]
        );
        // 주소가 이미 맞으면 꺼 둔 그대로 장부에만 적는다.
        let current = map(&[(
            "notion",
            ConfigEntry {
                url: Some(plugin_url(BASE, "notion")),
                disabled: true,
            },
        )]);
        assert_eq!(
            plan(&current, &desired, &BTreeMap::new(), &BTreeSet::new(), BASE),
            vec![Action::Adopt {
                name: "notion".to_owned(),
                url: plugin_url(BASE, "notion"),
            }]
        );
    }

    #[test]
    fn p12_forgets_ledger_entries_the_user_changed_or_removed() {
        let current = map(&[("notion", entry("https://mcp.notion.com/mcp"))]);
        let ledger = map(&[
            ("notion", plugin_url(BASE, "notion")),
            ("gone", plugin_url(BASE, "gone")),
        ]);
        assert_eq!(
            plan(&current, &BTreeMap::new(), &ledger, &BTreeSet::new(), BASE),
            vec![
                Action::Forget {
                    name: "gone".to_owned()
                },
                Action::Forget {
                    name: "notion".to_owned()
                },
            ]
        );
    }

    #[test]
    fn p12_registers_cypress_on_its_builtin_route() {
        let name = crate::chat::CYPRESS_MCP_SERVER_ID;
        let current = map(&[(name, entry(&cypress_url(BASE)))]);
        assert_eq!(
            plan(
                &current,
                &BTreeMap::new(),
                &BTreeMap::new(),
                &BTreeSet::new(),
                BASE
            ),
            vec![Action::Remove {
                name: name.to_owned()
            }]
        );
    }

    #[test]
    fn p12_reads_server_url_and_disabled_from_the_config() {
        let home = tempfile::tempdir().expect("home");
        std::fs::create_dir_all(home.path().join(".gemini/config")).expect("dir");
        std::fs::write(
            config_path(home.path()),
            r#"{"mcpServers":{"a":{"serverUrl":"http://x/","disabled":true},"b":{"command":"npx"}}}"#,
        )
        .expect("write");
        let config = read_config(home.path()).expect("config");
        assert_eq!(
            config.get("a"),
            Some(&ConfigEntry {
                url: Some("http://x".to_owned()),
                disabled: true
            })
        );
        assert_eq!(
            config.get("b"),
            Some(&ConfigEntry {
                url: None,
                disabled: false
            })
        );
        std::fs::write(config_path(home.path()), "{not json").expect("write");
        assert!(read_config(home.path()).is_err());
    }

    #[test]
    fn p12_re_registers_a_user_disabled_entry_disabled() {
        let desired = map(&[("notion", plugin_url(BASE, "notion"))]);
        let disabled = BTreeSet::from(["notion".to_owned()]);
        assert_eq!(
            plan(
                &BTreeMap::new(),
                &desired,
                &BTreeMap::new(),
                &disabled,
                BASE
            ),
            vec![Action::Add {
                name: "notion".to_owned(),
                url: plugin_url(BASE, "notion"),
                keep_disabled: true,
            }]
        );
    }

    /// 동기화 한 번을 끝까지 돈다. 사용자 서버는 그대로, 이 앱의 옛 항목은 지우고, 새 플러그인은
    /// 등록한다. 중간 명령이 실패하면 그때까지 한 일만 장부에 남는다.
    #[cfg(unix)]
    #[test]
    fn p12_sync_registers_removes_and_records_partial_progress() {
        use std::os::unix::fs::PermissionsExt;
        let app_data = tempfile::tempdir().expect("app data");
        let home = tempfile::tempdir().expect("home");
        crate::external_plugins::ExternalPluginRegistry::new(app_data.path().to_path_buf())
            .register(crate::ExternalPluginManifestRequest {
                id: "mock".to_owned(),
                display_name: "Mock".to_owned(),
                names: None,
                url: Some("http://127.0.0.1:3000/mcp".to_owned()),
                auth: crate::external_plugins::PluginAuthKind::None,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect("register");
        std::fs::create_dir_all(home.path().join(".gemini/config")).expect("config dir");
        std::fs::write(
            config_path(home.path()),
            serde_json::json!({"mcpServers": {
                "old": {"serverUrl": plugin_url(BASE, "old")},
                "mine": {"serverUrl": "http://localhost:1/mcp"}
            }})
            .to_string(),
        )
        .expect("config");
        let bin = tempfile::tempdir().expect("bin");
        let log = bin.path().join("argv.log");
        let fail_remove = bin.path().join("fail-remove");
        let fake = bin.path().join("agy");
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{log}'\nif [ \"$2\" = remove ] && [ -e '{fail}' ]; then echo boom >&2; exit 1; fi\n",
                log = log.display(),
                fail = fail_remove.display()
            ),
        )
        .expect("script");
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        std::fs::write(&fail_remove, "").expect("flag");
        assert!(sync_with(app_data.path(), home.path(), &fake, BASE, None).is_err());
        let ledger = load_ledger(app_data.path());
        assert_eq!(ledger.entries.get("mock"), Some(&plugin_url(BASE, "mock")));

        std::fs::remove_file(&fail_remove).expect("flag");
        let report = sync_with(app_data.path(), home.path(), &fake, BASE, None).expect("sync");
        // 가짜 CLI는 설정을 고치지 않으므로 둘째 실행도 등록을 다시 시도한다.
        assert_eq!(report.removed, vec!["old".to_owned()]);
        let argv = std::fs::read_to_string(&log).expect("log");
        assert!(argv.contains(&format!(
            "mcp add --type http mock {}",
            plugin_url(BASE, "mock")
        )));
        assert!(argv.contains("mcp remove old"));
        assert!(
            !argv.contains("mine"),
            "사용자 서버에는 손대지 않는다: {argv}"
        );
    }

    /// 공식 CLI에 넘기는 argv를 실제 자식이 받은 그대로 확인한다. 이름이 플래그보다 뒤에
    /// 와야 한다(`agy mcp add --help`: "Flags must come before <name>").
    #[cfg(unix)]
    #[test]
    fn p12_drives_the_official_cli_with_structured_arguments() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let log = dir.path().join("argv.log");
        let fake = dir.path().join("agy");
        std::fs::write(
            &fake,
            format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\n", log.display()),
        )
        .expect("script");
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let mut ledger = Ledger::default();
        let (report, failure) = apply(
            &fake,
            vec![
                Action::Add {
                    name: "notion".to_owned(),
                    url: plugin_url(BASE, "notion"),
                    keep_disabled: true,
                },
                Action::Remove {
                    name: "jira".to_owned(),
                },
            ],
            &mut ledger,
        );
        assert!(failure.is_none());
        assert_eq!(report.added, vec!["notion".to_owned()]);
        assert_eq!(report.removed, vec!["jira".to_owned()]);
        assert_eq!(
            std::fs::read_to_string(&log).expect("log"),
            format!(
                "mcp add --type http notion {}\nmcp disable notion\nmcp remove jira\n",
                plugin_url(BASE, "notion")
            )
        );
        assert_eq!(
            ledger.entries.get("notion"),
            Some(&plugin_url(BASE, "notion"))
        );
    }

    /// 그새 사용자가 지운 항목의 제거는 성공으로 친다(목적이 이미 이뤄졌다). 다른 실패는
    /// 그대로 올리고 장부를 남겨, 다음 동기화가 같은 제거를 다시 시도하게 한다.
    #[cfg(unix)]
    #[test]
    fn p12_remove_treats_not_found_as_done_and_keeps_other_failures() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("dir");
        let fake = dir.path().join("agy");
        std::fs::write(
            &fake,
            "#!/bin/sh\nif [ \"$3\" = gone ]; then echo 'server gone not found' >&2; else echo boom >&2; fi\nexit 1\n",
        )
        .expect("script");
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let mut ledger = Ledger::default();
        ledger
            .entries
            .insert("gone".to_owned(), plugin_url(BASE, "gone"));
        ledger
            .entries
            .insert("stuck".to_owned(), plugin_url(BASE, "stuck"));

        let (report, failure) = apply(
            &fake,
            vec![Action::Remove {
                name: "gone".to_owned(),
            }],
            &mut ledger,
        );
        assert!(failure.is_none(), "not found는 실패가 아니다: {failure:?}");
        assert_eq!(report.removed, vec!["gone".to_owned()]);
        assert!(!ledger.entries.contains_key("gone"));

        let (report, failure) = apply(
            &fake,
            vec![Action::Remove {
                name: "stuck".to_owned(),
            }],
            &mut ledger,
        );
        assert!(failure.is_some(), "다른 실패는 올려야 한다");
        assert!(report.removed.is_empty());
        assert!(
            ledger.entries.contains_key("stuck"),
            "실패한 제거는 장부에 남는다"
        );
    }
}
