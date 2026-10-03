//! 한도로 끊긴 턴을 다른 계정에서 이어 보낼 때의 문구와 그 기록.
//!
//! 자동전환은 끊긴 요청을 새 계정의 같은 세션에 다시 보낸다. 원문을 그대로 보내면 공급자
//! 기록에 이미 남은 단계 위에 같은 요청이 한 번 더 쌓이고, Codex·Antigravity는 끝낸 단계를
//! 처음부터 다시 했다(2026-09-29 실측: 파일 6개 순차 읽기를 3개째에서 끊으면 원문 재전송은
//! 6개 전부, 이 문구는 남은 3개만). 파일 쓰기나 명령이면 같은 부작용이 두 번 일어난다.
//!
//! 문구는 "기록에 결과가 있는 단계만 끝난 것"으로 못 박는다. 이어가기가 새로 만드는 위험은
//! 반대 방향 — 끝나지 않은 단계를 끝났다고 믿는 것 — 이라서, 끝남의 근거를 기록으로 한정하고
//! 상태를 바꾸는 단계는 확인한 뒤에만 되풀이하게 한다.
//!
//! 이어가기는 모두 앱 데이터의 `turn-continuations-v1.jsonl`에 남는다(G7). 요청 본문은 남기지
//! 않고 어느 세션이 언제 어느 계정으로 이어졌는지만 적어, 나중에 그 턴의 공급자 기록을 찾아
//! 할루시네이션 여부를 검토할 수 있게 한다.

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::app_data_file::open_private_append_file;
use crate::clock::now_ms;
use crate::{CoreError, ProviderId};

/// 이어가기 문구. 평가 스크립트(`scripts/turn-continuation-eval.mjs`)도 이 파일을 그대로 읽어
/// 같은 문구로 측정한다.
const PROMPT_TEMPLATE: &str = include_str!("turn_continuation_prompt.md");
const REQUESTS_PLACEHOLDER: &str = "{requests}";
const RECORD_FILE: &str = "turn-continuations-v1.jsonl";
const PREVIOUS_RECORD_FILE: &str = "turn-continuations-v1.previous.jsonl";
const MAX_RECORD_FILE_BYTES: u64 = 1024 * 1024;

/// 끊긴 요청들을 이어가기 메시지 하나로 감싼다. 끊긴 요청이 없으면 `None`.
///
/// 여럿이면 하나로 묶는다. 따로 보내면 두 번째 메시지가 첫 번째 이어가기의 결과를 끊긴
/// 상태로 오해하게 만든다.
pub(crate) fn continuation_message(interrupted: &[String]) -> Option<String> {
    let requests: Vec<&str> = interrupted
        .iter()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
        .collect();
    let body = match requests.as_slice() {
        [] => return None,
        [only] => quote(only),
        many => many
            .iter()
            .enumerate()
            .map(|(index, text)| format!("{}.\n{}", index + 1, quote(text)))
            .collect::<Vec<_>>()
            .join("\n\n"),
    };
    Some(
        PROMPT_TEMPLATE
            .trim_end()
            .replace(REQUESTS_PLACEHOLDER, &body),
    )
}

/// 인용 경계. 요청 본문이 문구의 지시와 섞여 읽히지 않게 구분선으로 감싼다.
fn quote(text: &str) -> String {
    format!("<<<\n{text}\n>>>")
}

/// 문구가 바뀌면 기록의 버전도 바뀐다. 평가 결과와 운영 기록을 같은 문구끼리 비교하려고 둔다.
pub(crate) fn prompt_version() -> String {
    let digest = Sha256::digest(PROMPT_TEMPLATE.as_bytes());
    digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContinuationRecord<'a> {
    pub at: i64,
    pub provider: ProviderId,
    pub provider_session_id: Option<&'a str>,
    pub previous_chat_id: &'a str,
    pub chat_id: &'a str,
    pub from_account_id: Option<&'a str>,
    pub to_account_id: Option<&'a str>,
    /// 이어가기 문구로 감싼 끊긴 요청 수.
    pub interrupted_count: usize,
    /// 시작하지 않아 원문 그대로 보낸 요청 수.
    pub queued_count: usize,
    pub prompt_version: String,
}

impl<'a> ContinuationRecord<'a> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        provider: ProviderId,
        provider_session_id: Option<&'a str>,
        previous_chat_id: &'a str,
        chat_id: &'a str,
        from_account_id: Option<&'a str>,
        to_account_id: Option<&'a str>,
        interrupted_count: usize,
        queued_count: usize,
    ) -> Self {
        Self {
            at: now_ms(),
            provider,
            provider_session_id,
            previous_chat_id,
            chat_id,
            from_account_id,
            to_account_id,
            interrupted_count,
            queued_count,
            prompt_version: prompt_version(),
        }
    }
}

/// 이어가기 한 건을 남긴다. 1MB를 넘으면 직전 파일 하나만 남기고 돌린다.
pub(crate) fn record(
    app_data_dir: &Path,
    record: &ContinuationRecord<'_>,
) -> Result<(), CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let path = app_data_dir.join(RECORD_FILE);
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() >= MAX_RECORD_FILE_BYTES) {
        let previous = app_data_dir.join(PREVIOUS_RECORD_FILE);
        if previous.exists() {
            fs::remove_file(&previous)?;
        }
        fs::rename(&path, previous)?;
    }
    let mut file = open_private_append_file(&path)?;
    file.write_all(&serde_json::to_vec(record)?)?;
    file.write_all(b"\n")?;
    file.sync_data()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_interrupted_request_means_no_continuation() {
        assert_eq!(continuation_message(&[]), None);
        assert_eq!(continuation_message(&["  ".to_owned()]), None);
    }

    /// 문구는 `include_str!`로 실행 파일에 박힌다. `.gitattributes`에서 빠지면 Windows
    /// 작업 트리가 CRLF로 받아 와 공급자에게 가는 문장도, 그 해시인 `prompt_version`도
    /// 기계마다 달라진다 — 같은 문구끼리 비교하려고 둔 버전이 제 구실을 못 한다.
    /// 실제로 이 파일이 목록에서 빠진 채 올라가 시험 하나가 깨져 있었다(2026-09-30).
    #[test]
    fn the_embedded_prompt_keeps_repository_line_endings() {
        assert!(
            !PROMPT_TEMPLATE.contains('\r'),
            ".gitattributes 에 이 문구 파일의 eol=lf 가 빠졌습니다"
        );
    }

    #[test]
    fn single_request_is_quoted_whole_after_the_rules() {
        let message = continuation_message(&["f1부터 f6까지 읽어라".to_owned()]).unwrap();
        assert!(message.starts_with("[Agent Manager 자동 이어가기]"));
        assert!(message.contains("기록에 결과가 없는 단계는 끝났다고 가정하지 말고"));
        assert!(message.ends_with("끊긴 요청:\n<<<\nf1부터 f6까지 읽어라\n>>>"));
        assert!(!message.contains(REQUESTS_PLACEHOLDER));
    }

    #[test]
    fn several_requests_become_one_numbered_message() {
        let message =
            continuation_message(&["첫 요청".to_owned(), "두 번째 요청".to_owned()]).unwrap();
        assert!(message.ends_with("1.\n<<<\n첫 요청\n>>>\n\n2.\n<<<\n두 번째 요청\n>>>"));
    }

    #[test]
    fn records_append_without_request_text() {
        let dir = tempfile::tempdir().unwrap();
        let entry = ContinuationRecord::new(
            ProviderId::Codex,
            Some("thread-1"),
            "chat-old",
            "chat-new",
            Some("codex-a"),
            Some("codex-b"),
            1,
            2,
        );
        record(dir.path(), &entry).unwrap();
        record(dir.path(), &entry).unwrap();
        let text = fs::read_to_string(dir.path().join(RECORD_FILE)).unwrap();
        let lines: Vec<serde_json::Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["provider"], "codex");
        assert_eq!(lines[0]["interruptedCount"], 1);
        assert_eq!(lines[0]["promptVersion"], prompt_version());
    }
}
