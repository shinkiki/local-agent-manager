//! 채팅 런타임 저장소(`chat-runtime-state-v1.json`). Agent Manager가 띄운 CLI 자식의
//! lease와 세션별 실행 실패 기록을 담으며, 메타데이터 저장소(`store`)와는 파일도 잠금도
//! 따로 쓴다. 공개 항목은 `store`가 그대로 다시 내보내므로 호출부 경로
//! (`store::persist_runtime_failure` 등)는 그대로다.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::app_data_file::{read_private_json_or_default, write_private_json};
use crate::domain::{ProviderId, SessionRuntimeFailure};
use crate::identifier::validate_identifier;
use crate::store::session_key;
use crate::store_lock;
use crate::CoreError;

const CHAT_RUNTIME_STORE_FILE_NAME: &str = "chat-runtime-state-v1.json";
const CHAT_RUNTIME_LOCK_FILE_NAME: &str = "chat-runtime-state-v1.lock";
const MAX_RUNTIME_FAILURES: usize = 2_000;
const MAX_RUNTIME_FAILURES_PER_SESSION: usize = 50;
const MAX_RUNTIME_FAILURE_MESSAGE_CHARS: usize = 2_000;

/// 비정상 백엔드 종료 뒤에도 이전 Agent Manager 관리 자식만 정확히 식별하기 위한
/// 비밀 없는 lease. 명령행은 저장하지 않고 정규화된 명령행 digest만 기록한다(G4, G7).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedChatRuntimeLease {
    pub chat_id: String,
    pub source: ProviderId,
    pub session_id: Option<String>,
    pub active_turn_id: Option<String>,
    pub pid: u32,
    pub process_started: String,
    pub command_digest: String,
    pub manager_instance_id: String,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFailureRecord {
    source: ProviderId,
    session_id: String,
    failure: SessionRuntimeFailure,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRuntimeStore {
    #[serde(default)]
    leases: Vec<ManagedChatRuntimeLease>,
    #[serde(default)]
    failures: Vec<RuntimeFailureRecord>,
}

pub(crate) fn managed_chat_runtime_leases(
    app_data_dir: &Path,
) -> Result<Vec<ManagedChatRuntimeLease>, CoreError> {
    Ok(load_chat_runtime_store(app_data_dir)?.leases)
}

pub(crate) fn upsert_managed_chat_runtime_lease(
    app_data_dir: &Path,
    lease: ManagedChatRuntimeLease,
) -> Result<(), CoreError> {
    validate_identifier(&lease.chat_id)?;
    if let Some(session_id) = lease.session_id.as_deref() {
        validate_identifier(session_id)?;
    }
    with_chat_runtime_store(app_data_dir, |store| {
        if let Some(existing) = store
            .leases
            .iter_mut()
            .find(|existing| existing.chat_id == lease.chat_id)
        {
            *existing = lease;
        } else {
            store.leases.push(lease);
        }
        Ok(())
    })
}

pub(crate) fn remove_managed_chat_runtime_lease(
    app_data_dir: &Path,
    chat_id: &str,
) -> Result<(), CoreError> {
    validate_identifier(chat_id)?;
    with_chat_runtime_store(app_data_dir, |store| {
        store.leases.retain(|lease| lease.chat_id != chat_id);
        Ok(())
    })
}

pub(crate) fn runtime_failures_for(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
) -> Result<Vec<SessionRuntimeFailure>, CoreError> {
    validate_identifier(session_id)?;
    let mut failures = load_chat_runtime_store(app_data_dir)?
        .failures
        .into_iter()
        .filter(|record| record.source == source && record.session_id == session_id)
        .map(|record| record.failure)
        .collect::<Vec<_>>();
    failures.sort_by_key(|failure| failure.occurred_at);
    Ok(failures)
}

/// 세션마다 가장 최근 실행 실패 하나. 키는 `<source>:<session id>`. 목록 태그가 세션 전체를
/// 한 번에 훑으므로 세션별 조회 대신 저장소를 한 번만 읽어 색인한다.
pub(crate) fn latest_runtime_failures(
    app_data_dir: &Path,
) -> Result<HashMap<String, SessionRuntimeFailure>, CoreError> {
    let mut latest = HashMap::<String, SessionRuntimeFailure>::new();
    for record in load_chat_runtime_store(app_data_dir)?.failures {
        let key = session_key(record.source, &record.session_id);
        match latest.get(&key) {
            Some(existing) if existing.occurred_at >= record.failure.occurred_at => {}
            _ => {
                latest.insert(key, record.failure);
            }
        }
    }
    Ok(latest)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_runtime_failure(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    chat_id: &str,
    turn_id: &str,
    status: &str,
    code: &str,
    message: &str,
    occurred_at: i64,
) -> Result<(), CoreError> {
    validate_identifier(session_id)?;
    validate_identifier(chat_id)?;
    validate_identifier(turn_id)?;
    let message = message
        .trim()
        .chars()
        .take(MAX_RUNTIME_FAILURE_MESSAGE_CHARS)
        .collect::<String>();
    let failure = SessionRuntimeFailure {
        id: format!("{chat_id}:{turn_id}:{occurred_at}"),
        turn_id: turn_id.to_owned(),
        status: status.to_owned(),
        code: code.to_owned(),
        message,
        occurred_at,
    };
    with_chat_runtime_store(app_data_dir, |store| {
        if let Some(existing) = store.failures.iter_mut().find(|record| {
            record.source == source
                && record.session_id == session_id
                && record.failure.turn_id == turn_id
        }) {
            existing.failure = failure;
        } else {
            store.failures.push(RuntimeFailureRecord {
                source,
                session_id: session_id.to_owned(),
                failure,
            });
        }
        trim_runtime_failures(store);
        Ok(())
    })
}

fn load_chat_runtime_store(app_data_dir: &Path) -> Result<ChatRuntimeStore, CoreError> {
    read_private_json_or_default(&app_data_dir.join(CHAT_RUNTIME_STORE_FILE_NAME))
}

fn with_chat_runtime_store<T>(
    app_data_dir: &Path,
    action: impl FnOnce(&mut ChatRuntimeStore) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let _lock = store_lock::acquire(
        app_data_dir,
        CHAT_RUNTIME_LOCK_FILE_NAME,
        "채팅 런타임 저장소",
    )?;
    let mut store = load_chat_runtime_store(app_data_dir)?;
    let value = action(&mut store)?;
    write_private_json(&app_data_dir.join(CHAT_RUNTIME_STORE_FILE_NAME), &store)?;
    Ok(value)
}

fn trim_runtime_failures(store: &mut ChatRuntimeStore) {
    let mut per_session = HashMap::<String, usize>::new();
    store
        .failures
        .sort_by_key(|record| std::cmp::Reverse(record.failure.occurred_at));
    store.failures.retain(|record| {
        let key = session_key(record.source, &record.session_id);
        let count = per_session.entry(key).or_default();
        *count += 1;
        *count <= MAX_RUNTIME_FAILURES_PER_SESSION
    });
    store.failures.truncate(MAX_RUNTIME_FAILURES);
    store
        .failures
        .sort_by_key(|record| record.failure.occurred_at);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_chat_runtime_lease_is_atomic_and_removable() {
        let temp = tempfile::tempdir().expect("temp directory");
        let mut lease = ManagedChatRuntimeLease {
            chat_id: "chat-12345678901".to_owned(),
            source: ProviderId::Claude,
            session_id: Some("session-1234567890".to_owned()),
            active_turn_id: Some("turn-12345678901".to_owned()),
            pid: 42,
            process_started: "501 Sun Aug 30 10:00:00 2026".to_owned(),
            command_digest: "digest-one".to_owned(),
            manager_instance_id: "manager-one".to_owned(),
            recorded_at: 1,
        };
        upsert_managed_chat_runtime_lease(temp.path(), lease.clone()).expect("first lease");
        lease.pid = 43;
        lease.command_digest = "digest-two".to_owned();
        upsert_managed_chat_runtime_lease(temp.path(), lease).expect("replace lease");

        let leases = managed_chat_runtime_leases(temp.path()).expect("leases");
        assert_eq!(leases.len(), 1);
        assert_eq!(leases[0].pid, 43);
        assert_eq!(leases[0].command_digest, "digest-two");

        remove_managed_chat_runtime_lease(temp.path(), "chat-12345678901").expect("remove lease");
        assert!(managed_chat_runtime_leases(temp.path())
            .expect("leases after removal")
            .is_empty());
    }

    #[test]
    fn latest_runtime_failures_keeps_the_newest_failure_per_session() {
        let temp = tempfile::tempdir().expect("temp directory");
        let record = |source: ProviderId, session: &str, turn: &str, status: &str, at: i64| {
            persist_runtime_failure(
                temp.path(),
                source,
                session,
                "chat-12345678901",
                turn,
                status,
                "runtimeFailed",
                "message",
                at,
            )
            .expect("failure");
        };
        record(
            ProviderId::Claude,
            "session-1234567890",
            "turn-12345678901",
            "failed",
            5,
        );
        record(
            ProviderId::Claude,
            "session-1234567890",
            "turn-12345678902",
            "interrupted",
            9,
        );
        record(
            ProviderId::Claude,
            "session-1234567890",
            "turn-12345678903",
            "failed",
            7,
        );
        record(
            ProviderId::Codex,
            "session-1234567890",
            "turn-12345678901",
            "failed",
            1,
        );

        let latest = latest_runtime_failures(temp.path()).expect("index");
        assert_eq!(latest.len(), 2);
        let claude = &latest["claude:session-1234567890"];
        assert_eq!(
            (claude.occurred_at, claude.status.as_str()),
            (9, "interrupted")
        );
        assert_eq!(latest["codex:session-1234567890"].occurred_at, 1);
        assert!(
            latest_runtime_failures(tempfile::tempdir().expect("empty").path())
                .expect("empty index")
                .is_empty()
        );
    }

    #[test]
    fn runtime_failure_replaces_the_same_turn_and_filters_by_session() {
        let temp = tempfile::tempdir().expect("temp directory");
        persist_runtime_failure(
            temp.path(),
            ProviderId::Claude,
            "session-1234567890",
            "chat-12345678901",
            "turn-12345678901",
            "failed",
            "responseTimeout",
            "first failure",
            1,
        )
        .expect("first failure");
        persist_runtime_failure(
            temp.path(),
            ProviderId::Claude,
            "session-1234567890",
            "chat-12345678901",
            "turn-12345678901",
            "interrupted",
            "backendRestarted",
            "final failure",
            2,
        )
        .expect("replacement failure");

        let failures = runtime_failures_for(temp.path(), ProviderId::Claude, "session-1234567890")
            .expect("runtime failures");
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].status, "interrupted");
        assert_eq!(failures[0].code, "backendRestarted");
        assert_eq!(failures[0].message, "final failure");
        assert!(
            runtime_failures_for(temp.path(), ProviderId::Codex, "session-1234567890")
                .expect("other provider")
                .is_empty()
        );
    }
}
