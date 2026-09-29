//! 세션 보완 저장소 — 공급자 기록에 남지 않은 응답 원문을 장치 안에 따로 모은다.
//!
//! 세션 메타(`manager-state.json`)와 다른 파일·다른 잠금을 쓰고, 상한도 따로 둔다.
//! [`crate::store`]에 함께 있던 동안에는 두 저장소의 상수·잠금·정리 규칙이 한 파일에서
//! 섞여 있었다. 호출부가 쓰던 `store::` 경로는 그쪽의 재내보내기가 그대로 유지한다.

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::app_data_file::read_private_json_or_default;
use crate::domain::{wire_enum, ProviderId, SupplementStorageStats};
use crate::identifier::validate_identifier;
use crate::json_store;
use crate::store::session_key;
use crate::store_lock;
use crate::CoreError;

const SUPPLEMENT_STORE_FILE_NAME: &str = "session-supplements-v2.json";
const SUPPLEMENT_LOCK_FILE_NAME: &str = "session-supplements-v2.lock";
const MAX_SUPPLEMENT_TEXT_BYTES: usize = 256 * 1024;
const MAX_SUPPLEMENT_TURNS: usize = 4_000;
const MAX_SUPPLEMENT_TURNS_PER_SESSION: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SupplementOrigin {
    Chat,
    Scheduled,
    /// 런타임이 만들어 보낸 지시(단계 지시·종합 요청·되묻기). 전사를 합칠 때 같은 글의
    /// 사용자 항목을 system 으로 바꾸는 표식이지, 전사에 더하는 출력이 아니다(9.17).
    SystemPrompt,
}

impl SupplementOrigin {
    #[cfg(test)]
    pub const ALL: [Self; 3] = [Self::Chat, Self::Scheduled, Self::SystemPrompt];
}

wire_enum!(trimmed SupplementOrigin, "알 수 없는 보완 저장 출처입니다", {
    Chat => "chat",
    Scheduled => "scheduled",
    SystemPrompt => "systemPrompt",
});

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CapturedTranscriptTurn {
    pub source: ProviderId,
    pub session_id: String,
    pub turn_id: String,
    pub completed_at: i64,
    pub text: String,
    pub origin: SupplementOrigin,
    /// `SystemPrompt` 가 전사에서 달 라벨("단계 지시" 등). 다른 출처는 비어 있다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SupplementStore {
    #[serde(default)]
    turns: Vec<CapturedTranscriptTurn>,
}

pub(crate) fn captured_turns_for(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
) -> Result<Vec<CapturedTranscriptTurn>, CoreError> {
    let store = load_supplement_store(app_data_dir)?;
    let mut turns = store
        .turns
        .into_iter()
        .filter(|turn| turn.source == source && turn.session_id == session_id)
        .collect::<Vec<_>>();
    turns.sort_by_key(|turn| turn.completed_at);
    Ok(turns)
}

pub(crate) fn supplement_storage_stats(
    app_data_dir: &Path,
) -> Result<SupplementStorageStats, CoreError> {
    let store = load_supplement_store(app_data_dir)?;
    let session_count = store
        .turns
        .iter()
        .map(|turn| session_key(turn.source, &turn.session_id))
        .collect::<HashSet<_>>()
        .len();
    let size_bytes = supplement_store_size(app_data_dir);
    Ok(SupplementStorageStats {
        turn_count: store.turns.len(),
        session_count,
        size_bytes,
    })
}

pub(crate) fn persist_captured_turn(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    turn_id: &str,
    completed_at: i64,
    text: String,
    origin: SupplementOrigin,
) -> Result<(), CoreError> {
    persist_captured_turn_inner(
        app_data_dir,
        captured_turn(source, session_id, turn_id, completed_at, text, origin)?,
        true,
    )
}

pub(crate) fn persist_captured_turn_if_absent(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    turn_id: &str,
    completed_at: i64,
    text: String,
    origin: SupplementOrigin,
) -> Result<(), CoreError> {
    persist_captured_turn_inner(
        app_data_dir,
        captured_turn(source, session_id, turn_id, completed_at, text, origin)?,
        false,
    )
}

fn captured_turn(
    source: ProviderId,
    session_id: &str,
    turn_id: &str,
    completed_at: i64,
    text: String,
    origin: SupplementOrigin,
) -> Result<CapturedTranscriptTurn, CoreError> {
    validate_identifier(session_id)?;
    validate_identifier(turn_id)?;
    Ok(CapturedTranscriptTurn {
        source,
        session_id: session_id.to_owned(),
        turn_id: turn_id.to_owned(),
        completed_at,
        text: cap_supplement_text(text),
        origin,
        label: None,
    })
}

/// 런타임이 보낸 지시를 적어 둔다. 같은 turn_id 면 덮어쓴다.
pub(crate) fn persist_system_prompt(
    app_data_dir: &Path,
    source: ProviderId,
    session_id: &str,
    turn_id: &str,
    sent_at: i64,
    text: String,
    label: &str,
) -> Result<(), CoreError> {
    let mut turn = captured_turn(
        source,
        session_id,
        turn_id,
        sent_at,
        text,
        SupplementOrigin::SystemPrompt,
    )?;
    turn.label = Some(label.to_owned());
    persist_captured_turn_inner(app_data_dir, turn, true)
}

fn persist_captured_turn_inner(
    app_data_dir: &Path,
    next: CapturedTranscriptTurn,
    replace_existing: bool,
) -> Result<(), CoreError> {
    if next.text.is_empty() {
        return Ok(());
    }
    with_supplement_store(app_data_dir, |store| {
        if let Some(existing) = store.turns.iter_mut().find(|turn| {
            turn.source == next.source
                && turn.session_id == next.session_id
                && turn.turn_id == next.turn_id
        }) {
            if replace_existing {
                *existing = next;
            }
        } else {
            store.turns.push(next);
        }
        trim_supplements(store);
        Ok(())
    })
}

fn load_supplement_store(app_data_dir: &Path) -> Result<SupplementStore, CoreError> {
    read_private_json_or_default(&app_data_dir.join(SUPPLEMENT_STORE_FILE_NAME))
}

fn supplement_store_size(app_data_dir: &Path) -> u64 {
    fs::metadata(app_data_dir.join(SUPPLEMENT_STORE_FILE_NAME))
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn with_supplement_store<T>(
    app_data_dir: &Path,
    action: impl FnOnce(&mut SupplementStore) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let _lock = store_lock::acquire(app_data_dir, SUPPLEMENT_LOCK_FILE_NAME, "보완 저장소")?;
    let mut store = load_supplement_store(app_data_dir)?;
    let value = action(&mut store)?;
    let text = serde_json::to_string_pretty(&store)?;
    fs::write(app_data_dir.join(SUPPLEMENT_STORE_FILE_NAME), text)?;
    Ok(value)
}

fn cap_supplement_text(text: String) -> String {
    let text = text.trim().to_owned();
    if text.len() <= MAX_SUPPLEMENT_TEXT_BYTES {
        return text;
    }
    let end = text.floor_char_boundary(MAX_SUPPLEMENT_TEXT_BYTES);
    format!(
        "{}\n\n[Agent Manager 보관 한도에 따라 일부 생략됨]",
        &text[..end]
    )
}

fn trim_supplements(store: &mut SupplementStore) {
    json_store::trim_to_retention(
        &mut store.turns,
        MAX_SUPPLEMENT_TURNS,
        MAX_SUPPLEMENT_TURNS_PER_SESSION,
        |turn| turn.completed_at,
        |turn| session_key(turn.source, &turn.session_id),
    );
}

/// 정리된 세션이 남긴 보완 저장 응답을 지운다. 보완 저장소는 세션 메타와 다른 파일이라
/// 잠금도 따로 잡는다. 돌려주는 값은 줄어든 파일 크기(바이트)다.
pub(crate) fn prune_supplements_for(
    app_data_dir: &Path,
    keys: &BTreeSet<String>,
) -> Result<u64, CoreError> {
    if keys.is_empty() {
        return Ok(0);
    }
    let before = supplement_store_size(app_data_dir);
    let removed = with_supplement_store(app_data_dir, |store| {
        let mut removed = 0usize;
        store.turns.retain(|turn| {
            let keep = !keys.contains(&session_key(turn.source, &turn.session_id));
            if !keep {
                removed += 1;
            }
            keep
        });
        Ok(removed)
    })?;
    if removed == 0 {
        return Ok(0);
    }
    let after = supplement_store_size(app_data_dir);
    Ok(before.saturating_sub(after))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pruning_supplements_drops_only_the_cleaned_sessions_turns() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        for (session_id, turn_id) in [
            ("1234567890abcdef", "turn-000000000001"),
            ("fedcba0987654321", "turn-000000000002"),
        ] {
            persist_captured_turn(
                temp.path(),
                ProviderId::Claude,
                session_id,
                turn_id,
                1,
                "응답".to_owned(),
                SupplementOrigin::Chat,
            )
            .expect("turn must save");
        }
        prune_supplements_for(
            temp.path(),
            &BTreeSet::from(["claude:1234567890abcdef".to_owned()]),
        )
        .expect("prune must run");
        assert!(
            captured_turns_for(temp.path(), ProviderId::Claude, "1234567890abcdef")
                .expect("load")
                .is_empty()
        );
        assert_eq!(
            captured_turns_for(temp.path(), ProviderId::Claude, "fedcba0987654321")
                .expect("load")
                .len(),
            1
        );
    }

    #[test]
    fn captured_turn_replaces_the_same_turn_and_reports_storage_stats() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        persist_captured_turn(
            temp.path(),
            ProviderId::Claude,
            "session-1234567890",
            "turn-1234567890abcd",
            1,
            "first response".to_owned(),
            SupplementOrigin::Chat,
        )
        .expect("first captured turn");
        persist_captured_turn(
            temp.path(),
            ProviderId::Claude,
            "session-1234567890",
            "turn-1234567890abcd",
            2,
            "final response".to_owned(),
            SupplementOrigin::Chat,
        )
        .expect("replacement captured turn");

        let turns = captured_turns_for(temp.path(), ProviderId::Claude, "session-1234567890")
            .expect("captured turns");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].text, "final response");
        let stats = supplement_storage_stats(temp.path()).expect("supplement stats");
        assert_eq!(stats.turn_count, 1);
        assert_eq!(stats.session_count, 1);
        assert!(stats.size_bytes > 0);
    }

    #[test]
    fn supplement_origin_contract_and_serde() {
        use std::str::FromStr;

        assert_eq!(SupplementOrigin::ALL.len(), 3);
        assert_eq!(
            SupplementOrigin::ALL,
            [
                SupplementOrigin::Chat,
                SupplementOrigin::Scheduled,
                SupplementOrigin::SystemPrompt
            ]
        );

        for origin in SupplementOrigin::ALL {
            let s = origin.as_str();
            assert_eq!(origin.to_string(), s);
            assert_eq!(SupplementOrigin::from_str(s).expect("parse"), origin);

            let json = serde_json::to_string(&origin).expect("serialize");
            assert_eq!(json, format!("\"{s}\""));
            let deserialized: SupplementOrigin = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(deserialized, origin);
        }

        assert!(" chat ".parse::<SupplementOrigin>().is_ok());
        assert!("scheduled".parse::<SupplementOrigin>().is_ok());
        assert!(matches!(
            "unknown".parse::<SupplementOrigin>(),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn trim_supplements_enforces_per_session_and_global_limits() {
        let mut store = SupplementStore::default();
        for i in 0..210 {
            store.turns.push(CapturedTranscriptTurn {
                source: ProviderId::Claude,
                session_id: "session-1".to_owned(),
                turn_id: format!("turn-{i}"),
                completed_at: i as i64,
                text: "sample".to_owned(),
                origin: SupplementOrigin::Chat,
                label: None,
            });
        }
        trim_supplements(&mut store);
        assert_eq!(store.turns.len(), MAX_SUPPLEMENT_TURNS_PER_SESSION);
        assert_eq!(store.turns.first().unwrap().completed_at, 10);
        assert_eq!(store.turns.last().unwrap().completed_at, 209);
    }

    #[test]
    fn cap_supplement_text_respects_char_boundary_and_limit() {
        let short = "짧은 텍스트".to_owned();
        assert_eq!(cap_supplement_text(short.clone()), short);

        let long = "한글".repeat(MAX_SUPPLEMENT_TEXT_BYTES / 6 + 10);
        let capped = cap_supplement_text(long);
        assert!(capped.contains("[Agent Manager 보관 한도에 따라 일부 생략됨]"));
    }
}
