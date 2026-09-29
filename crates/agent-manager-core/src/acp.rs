//! ACP(Agent Client Protocol) 하네스의 말과 우리 말 사이의 번역.
//!
//! 이 모듈은 줄 단위 JSON-RPC 한 벌을 읽고 쓰는 규칙과, 하네스가 올린 승인 요청을 앱의
//! 승인 카드가 아는 모양으로 옮기는 규칙만 담는다. 프로세스를 띄우거나 소켓을 쥐는 일은
//! 하지 않는다 — 그쪽은 `chat.rs`의 자식 프로세스 배선이 이미 하고 있고, 여기까지 끌고
//! 오면 프로토콜 규칙만 따로 시험할 수가 없다.
//!
//! 실측 근거(2026-09-24, OpenCode 1.18.32)는 `docs/local-llm-acp.md`에 적어 두었다.

use serde::{Deserialize, Serialize};

use crate::chat::ChatApprovalDecision;

/// 세션에 붙일 MCP 서버 하나. 우리 시스템 MCP는 HTTP로 뜬다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpMcpServer {
    pub name: String,
    pub url: String,
}

/// 프롬프트에 실어 보내는 그림 한 장.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpImage {
    pub mime_type: String,
    pub base64: String,
}

/// 하네스가 승인을 물을 때 함께 주는 선택지 하나.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    /// `allow_once`·`allow_always`·`reject_once`. 이름(`name`)은 하네스가 영어로 주므로
    /// 화면 문구로 쓰지 않고, 우리가 가진 등급을 이 종류로 맞춘다.
    pub kind: String,
    #[serde(default)]
    pub name: String,
}

/// 승인을 물은 도구 호출.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpToolCall {
    pub tool_call_id: String,
    #[serde(default)]
    pub title: String,
    /// `execute`(셸)·`edit`(파일 쓰기) 등. 카드가 무엇을 묻는지 가르는 값이다.
    #[serde(default)]
    pub kind: String,
}

/// `session/request_permission` 요청의 본문.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionRequest {
    pub session_id: String,
    pub tool_call: AcpToolCall,
    #[serde(default)]
    pub options: Vec<AcpPermissionOption>,
}

/// 우리가 돌려주는 판정. 하네스는 고른 선택지의 id를 받거나 취소를 받는다.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "outcome")]
pub enum AcpPermissionOutcome {
    Selected {
        #[serde(rename = "optionId")]
        option_id: String,
    },
    Cancelled,
}

impl AcpPermissionRequest {
    /// 이 등급으로 답하려면 어느 선택지를 골라야 하는지. 하네스가 그 등급을 주지 않았으면
    /// `None`이고, 그때는 취소로 답해 권한이 넓어지지 않게 한다.
    ///
    /// `AcceptAll`을 `allow_always`로 펴지 않는 것은 Codex 경로와 같은 이유다. 그 값은
    /// 계획 검토 카드에서만 오고, 여기까지 오더라도 이번 한 번으로 접어야 권한이 사용자가
    /// 고른 것보다 넓어지지 않는다.
    pub fn option_for(&self, decision: ChatApprovalDecision) -> Option<&AcpPermissionOption> {
        let wanted = match decision {
            ChatApprovalDecision::Accept | ChatApprovalDecision::AcceptAll => "allow_once",
            ChatApprovalDecision::AcceptForSession => "allow_always",
            ChatApprovalDecision::Decline => "reject_once",
            ChatApprovalDecision::Cancel => return None,
        };
        self.options.iter().find(|option| option.kind == wanted)
    }

    /// 판정 하나를 하네스가 받는 모양으로 옮긴다.
    pub fn outcome_for(&self, decision: ChatApprovalDecision) -> AcpPermissionOutcome {
        match self.option_for(decision) {
            Some(option) => AcpPermissionOutcome::Selected {
                option_id: option.option_id.clone(),
            },
            None => AcpPermissionOutcome::Cancelled,
        }
    }
}

/// 하네스가 진행 중에 밀어 올리는 `session/update`의 갈래. 알림이 아니라 요청 모양으로
/// 오지만 우리가 답할 것은 없고, 화면에 무엇으로 옮길지만 가른다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcpSessionUpdate {
    /// 답변 조각.
    MessageChunk(String),
    /// 추론 조각. 화면에서 답변과 다른 자리에 쌓인다.
    ThoughtChunk(String),
    /// 도구 호출의 시작과 진행. `status`는 `pending`·`in_progress`·`completed`.
    ToolCall {
        tool_call_id: String,
        title: String,
        kind: String,
        status: String,
        /// 무엇을 실행하는지. 하네스가 `rawInput`으로 준다(셸이면 명령, 편집이면 경로).
        detail: Option<String>,
        /// 끝난 도구가 돌려준 것. `content` 배열의 글만 모은다.
        output: Option<String>,
    },
    /// 창 소비. 로컬은 한도가 없어 쓰지 않지만 하네스가 보내므로 삼키지 않고 가른다.
    Usage { used: u64, size: u64 },
    /// 우리가 아직 다루지 않는 갈래. 이름만 남겨 로그로 확인할 수 있게 한다.
    Other(String),
}

/// 한 줄을 읽었을 때 그것이 무엇인지. 하네스는 응답과 요청을 같은 관에 섞어 보낸다.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpIncoming {
    /// 우리가 건 요청의 답.
    Response { id: i64, result: serde_json::Value },
    /// 우리가 건 요청이 실패했다.
    Error { id: i64, message: String },
    /// 하네스가 우리에게 거는 요청. `id`가 있으면 답해야 한다.
    Request {
        id: Option<i64>,
        method: String,
        params: serde_json::Value,
    },
}

/// 줄 하나를 갈라 읽는다. 빈 줄과 JSON이 아닌 줄은 `None`이다 — 하네스가 진단 문구를
/// 같은 관으로 흘리는 일이 있어, 그것 때문에 읽기를 멈추면 안 된다.
pub fn parse_incoming(line: &str) -> Option<AcpIncoming> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    let id = value.get("id").and_then(serde_json::Value::as_i64);
    if let Some(method) = value.get("method").and_then(serde_json::Value::as_str) {
        return Some(AcpIncoming::Request {
            id,
            method: method.to_owned(),
            params: value
                .get("params")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        });
    }
    let id = id?;
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("알 수 없는 오류")
            .to_owned();
        return Some(AcpIncoming::Error { id, message });
    }
    Some(AcpIncoming::Response {
        id,
        result: value
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    })
}

/// 무엇을 실행하는지 한 줄로. 셸이면 명령, 편집이면 경로가 눈에 먼저 들어와야 한다.
fn tool_call_detail(update: &serde_json::Value) -> Option<String> {
    let raw = update.get("rawInput")?;
    for key in ["command", "filePath", "filepath", "path", "pattern"] {
        if let Some(text) = raw.get(key).and_then(serde_json::Value::as_str) {
            if !text.trim().is_empty() {
                return Some(text.to_owned());
            }
        }
    }
    // 아는 키가 없으면 통째로 보인다. 빈 객체는 보여 줄 것이 없다.
    raw.as_object()
        .filter(|fields| !fields.is_empty())
        .map(|_| raw.to_string())
}

/// 끝난 도구가 돌려준 글. `content` 배열에 글 아닌 조각이 섞여 와도 글만 모은다.
fn tool_call_output(update: &serde_json::Value) -> Option<String> {
    let items = update.get("content")?.as_array()?;
    let text = items
        .iter()
        .filter_map(|item| {
            item.pointer("/content/text")
                .or_else(|| item.get("text"))?
                .as_str()
        })
        .collect::<Vec<_>>()
        .join(
            "
",
        );
    (!text.trim().is_empty()).then_some(text)
}

/// `session/update` 요청의 본문을 갈래로 옮긴다.
pub fn parse_session_update(params: &serde_json::Value) -> Option<AcpSessionUpdate> {
    let update = params.get("update")?;
    let kind = update.get("sessionUpdate")?.as_str()?;
    let text = || {
        update
            .pointer("/content/text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let field = |name: &str| {
        update
            .get(name)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    Some(match kind {
        "agent_message_chunk" => AcpSessionUpdate::MessageChunk(text()),
        "agent_thought_chunk" => AcpSessionUpdate::ThoughtChunk(text()),
        "tool_call" | "tool_call_update" => AcpSessionUpdate::ToolCall {
            tool_call_id: field("toolCallId"),
            title: field("title"),
            kind: field("kind"),
            status: field("status"),
            detail: tool_call_detail(update),
            output: tool_call_output(update),
        },
        "usage_update" => AcpSessionUpdate::Usage {
            used: update
                .get("used")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            size: update
                .get("size")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        },
        other => AcpSessionUpdate::Other(other.to_owned()),
    })
}

/// 우리가 하네스에 거는 요청을 조립한다. id를 세는 일 말고는 상태가 없다 — 파이프를 쥐는
/// 쪽과 갈라 두어야 봉투 모양만 따로 시험할 수 있다.
#[derive(Debug, Default)]
pub struct AcpRequests {
    next_id: i64,
}

/// 보낼 요청 하나. `id`는 응답을 맞춰 보는 데 쓴다.
#[derive(Debug, Clone, PartialEq)]
pub struct AcpRequest {
    pub id: i64,
    pub body: serde_json::Value,
}

impl AcpRequests {
    /// 이미 쓴 번호 다음부터 센다. 핸드셰이크가 몇 개를 쓰고 넘겨주므로, 이후 요청이
    /// 1부터 다시 세면 그 답과 구분되지 않는다.
    pub fn starting_at(next_id: i64) -> Self {
        Self { next_id }
    }

    /// 지금까지 쓴 마지막 번호. 다른 쪽이 이어 세려면 이 값이 필요하다.
    pub fn last_id(&self) -> i64 {
        self.next_id
    }

    fn build(&mut self, method: &str, params: serde_json::Value) -> AcpRequest {
        self.next_id += 1;
        AcpRequest {
            id: self.next_id,
            body: serde_json::json!({
                "jsonrpc": "2.0",
                "id": self.next_id,
                "method": method,
                "params": params,
            }),
        }
    }

    /// 핸드셰이크. 파일 읽기·쓰기를 우리가 맡겠다고 알린다 — 승인이 떨어진 뒤 실제 쓰기는
    /// 하네스가 아니라 우리에게 `fs/write_text_file`로 온다.
    pub fn initialize(&mut self) -> AcpRequest {
        self.build(
            "initialize",
            serde_json::json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true } },
            }),
        )
    }

    pub fn session_new(&mut self, cwd: &str, servers: &[AcpMcpServer]) -> AcpRequest {
        self.build(
            "session/new",
            serde_json::json!({ "cwd": cwd, "mcpServers": mcp_servers_json(servers) }),
        )
    }

    /// 모델은 CLI 인자가 아니라 세션 설정 항목이다. 인자 이름이 `configId`다 —
    /// `optionId`로 보내면 하네스가 `Invalid params`로 거절한다(2026-09-24 실측).
    pub fn set_model(&mut self, session_id: &str, model: &str) -> AcpRequest {
        self.build(
            "session/set_config_option",
            serde_json::json!({
                "sessionId": session_id,
                "configId": "model",
                "value": model,
            }),
        )
    }

    /// 에이전트 선택. 하네스는 이것을 `mode`라 부른다 — 도구 목록과 지침이 여기서 갈린다.
    /// 로컬 모델은 기본 에이전트의 도구 열 개를 감당하지 못해 반드시 지정해야 한다.
    pub fn set_agent(&mut self, session_id: &str, agent: &str) -> AcpRequest {
        self.build(
            "session/set_config_option",
            serde_json::json!({
                "sessionId": session_id,
                "configId": "mode",
                "value": agent,
            }),
        )
    }

    /// 글 한 덩이와 이미지 몇 장. 이미지는 base64로 실어 보낸다 — 경로만 적어 보내면
    /// 모델이 도구로 읽어야 하고, 그것은 그림을 보는 것과 다르다.
    ///
    /// 비전 없는 모델에 이미지를 보내면 서빙 서버가 거절한다. 거르는 일은 부르는 쪽 몫이다.
    pub fn prompt(&mut self, session_id: &str, text: &str, images: &[AcpImage]) -> AcpRequest {
        let mut parts = Vec::new();
        if !text.trim().is_empty() {
            parts.push(serde_json::json!({ "type": "text", "text": text }));
        }
        for image in images {
            parts.push(serde_json::json!({
                "type": "image",
                "mimeType": image.mime_type,
                "data": image.base64,
            }));
        }
        self.build(
            "session/prompt",
            serde_json::json!({ "sessionId": session_id, "prompt": parts }),
        )
    }

    /// 이미 있는 세션을 이어 연다. 하네스가 기록을 돌려주므로 우리가 다시 심지 않는다.
    ///
    /// `session/resume`이 아니다 — 그 이름은 인자가 달라 거절당한다(2026-09-24 실측).
    pub fn load_session(
        &mut self,
        session_id: &str,
        cwd: &str,
        servers: &[AcpMcpServer],
    ) -> AcpRequest {
        self.build(
            "session/load",
            serde_json::json!({
                "sessionId": session_id,
                "cwd": cwd,
                "mcpServers": mcp_servers_json(servers),
            }),
        )
    }

    /// 진행 중인 턴 접기. **알림이다** — id를 붙이면 하네스가 요청 라우터에서 찾지 못해
    /// `Method not found: session/cancel`로 거절한다(2026-09-24 실측). 알림으로 보내면
    /// 진행 중이던 프롬프트가 `stopReason: "cancelled"`로 돌아온다.
    pub fn cancel(session_id: &str) -> serde_json::Value {
        serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": { "sessionId": session_id },
        })
    }
}

/// 하네스가 받는 MCP 서버 목록. `headers`가 없으면 `Invalid params`로 거절한다 —
/// 비어 있어도 배열이 있어야 한다(2026-09-24 실측).
fn mcp_servers_json(servers: &[AcpMcpServer]) -> Vec<serde_json::Value> {
    servers
        .iter()
        .map(|server| {
            serde_json::json!({
                "name": server.name,
                "type": "http",
                "url": server.url,
                "headers": [],
            })
        })
        .collect()
}

/// 우리가 하네스의 요청에 돌려주는 답.
pub fn response_body(id: i64, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// 요청을 수행하지 못했을 때. JSON-RPC는 실패를 `result`가 아니라 `error`로 알린다.
///
/// 실패를 `result` 안에 담으면 하네스는 성공으로 읽는다. 실제로 그랬다 — 읽기 전용
/// 채팅에서 쓰기를 막았는데 모델이 "파일을 생성했습니다"라고 답했다(2026-09-24).
/// 도구가 실패한 사실이 모델에게 닿아야 모델이 사용자에게 바로 말한다.
pub fn error_body(id: i64, message: impl std::fmt::Display) -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32000, "message": message.to_string() },
    })
}

/// 턴이 어떻게 끝났는지를 앱 어휘로 옮긴다.
///
/// 하네스는 `end_turn`·`cancelled`·`refusal`처럼 자기 말로 알려 주는데, 앱은 `completed`로
/// 시작하는 것만 성공으로 읽고 나머지는 실패로 본다. 그대로 넘기면 멀쩡히 답한 턴이
/// 실패 알림으로 뜬다(2026-09-24 실기기에서 그랬다).
pub fn turn_status(stop_reason: &str) -> &'static str {
    match stop_reason {
        // 할 말을 다 하고 끝났다. 도구 한도에 걸려 멈춘 것도 답은 돌아온 것이라 성공으로 본다.
        "end_turn" | "max_tokens" | "max_turn_requests" => "completed",
        "cancelled" => "interrupted",
        // 거절·오류는 실패다. 모르는 값도 실패로 둔다 — 성공으로 접으면 조용히 넘어간다.
        _ => "failed",
    }
}

/// `session/new` 응답에서 세션 id를 꺼낸다.
pub fn session_id_from(result: &serde_json::Value) -> Option<String> {
    result
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
}

/// 세션이 고를 수 있는 모델 값 목록. 연결 카드가 저장한 이름이 여기 있는지 견주어,
/// 없는 이름을 그대로 보내 하네스가 거절하는 일을 막는다.
pub fn model_values_from(result: &serde_json::Value) -> Vec<String> {
    result
        .get("configOptions")
        .and_then(serde_json::Value::as_array)
        .map(|options| {
            options
                .iter()
                .filter(|option| {
                    option.get("id").and_then(serde_json::Value::as_str) == Some("model")
                })
                .filter_map(|option| option.get("options")?.as_array())
                .flatten()
                .filter_map(|choice| choice.get("value")?.as_str())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_response_and_an_error_are_told_apart() {
        let ok = parse_incoming(r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#);
        assert!(matches!(ok, Some(AcpIncoming::Response { id: 3, .. })));
        let bad = parse_incoming(
            r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32602,"message":"Invalid params"}}"#,
        );
        match bad {
            Some(AcpIncoming::Error { id, message }) => {
                assert_eq!(id, 3);
                assert_eq!(message, "Invalid params");
            }
            other => panic!("오류로 읽지 못했다: {other:?}"),
        }
    }

    #[test]
    fn a_harness_request_keeps_its_id_so_we_can_answer() {
        // 승인 요청은 id가 있다. 답하지 않으면 턴이 멈춘다.
        let incoming = parse_incoming(
            r#"{"jsonrpc":"2.0","id":7,"method":"session/request_permission","params":{"sessionId":"s"}}"#,
        );
        match incoming {
            Some(AcpIncoming::Request { id, method, .. }) => {
                assert_eq!(id, Some(7));
                assert_eq!(method, "session/request_permission");
            }
            other => panic!("요청으로 읽지 못했다: {other:?}"),
        }
    }

    #[test]
    fn a_non_json_line_is_skipped_instead_of_stopping_the_read() {
        // 하네스가 진단 문구를 같은 관으로 흘리는 일이 있다. 그것 때문에 멈추면 안 된다.
        assert!(parse_incoming("").is_none());
        assert!(parse_incoming("Error handling request {").is_none());
    }

    #[test]
    fn session_updates_split_into_the_lanes_the_screen_needs() {
        let update = |value: serde_json::Value| parse_session_update(&value).expect("update");
        assert_eq!(
            update(serde_json::json!({ "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "안녕" }
            }})),
            AcpSessionUpdate::MessageChunk("안녕".to_owned()),
        );
        assert_eq!(
            update(serde_json::json!({ "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": { "type": "text", "text": "생각" }
            }})),
            AcpSessionUpdate::ThoughtChunk("생각".to_owned()),
        );
        assert_eq!(
            update(serde_json::json!({ "update": {
                "sessionUpdate": "usage_update", "used": 10232, "size": 200000
            }})),
            AcpSessionUpdate::Usage {
                used: 10232,
                size: 200000
            },
        );
    }

    #[test]
    fn a_tool_call_carries_what_the_card_shows() {
        // 2026-09-24 실측 모양. 편집은 경로가, 셸은 명령이 눈에 먼저 들어와야 한다.
        let value = serde_json::json!({ "update": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call_fcd9",
            "status": "in_progress",
            "kind": "edit",
            "title": "write",
            "rawInput": { "filePath": "F:/tmp/probe.txt", "content": "hello" }
        }});
        assert_eq!(
            parse_session_update(&value).expect("update"),
            AcpSessionUpdate::ToolCall {
                tool_call_id: "call_fcd9".to_owned(),
                title: "write".to_owned(),
                kind: "edit".to_owned(),
                status: "in_progress".to_owned(),
                detail: Some("F:/tmp/probe.txt".to_owned()),
                output: None,
            },
        );
    }

    #[test]
    fn a_finished_tool_call_carries_the_text_it_returned() {
        let value = serde_json::json!({ "update": {
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call_1",
            "status": "completed",
            "kind": "execute",
            "title": "bash",
            "rawInput": { "command": "ls" },
            "content": [
                { "type": "content", "content": { "type": "text", "text": "a.txt" } },
                { "type": "content", "content": { "type": "text", "text": "b.txt" } }
            ]
        }});
        match parse_session_update(&value).expect("update") {
            AcpSessionUpdate::ToolCall { detail, output, .. } => {
                assert_eq!(detail.as_deref(), Some("ls"));
                assert_eq!(
                    output.as_deref(),
                    Some(
                        "a.txt
b.txt"
                    )
                );
            }
            other => panic!("도구 호출로 읽지 못했다: {other:?}"),
        }
    }

    #[test]
    fn a_tool_call_without_a_known_input_key_still_shows_something() {
        // 아는 키가 없다고 빈칸으로 두면 무엇을 실행했는지 화면에서 사라진다.
        let value = serde_json::json!({ "update": {
            "sessionUpdate": "tool_call",
            "toolCallId": "call_2",
            "status": "pending",
            "kind": "other",
            "title": "무엇",
            "rawInput": { "낯선키": 1 }
        }});
        match parse_session_update(&value).expect("update") {
            AcpSessionUpdate::ToolCall { detail, .. } => {
                assert!(detail.is_some_and(|text| text.contains("낯선키")));
            }
            other => panic!("도구 호출로 읽지 못했다: {other:?}"),
        }
    }

    #[test]
    fn an_unknown_update_keeps_its_name_instead_of_being_swallowed() {
        // 모르는 갈래를 조용히 버리면 하네스가 새 소식을 보내기 시작해도 알아채지 못한다.
        let value =
            serde_json::json!({ "update": { "sessionUpdate": "available_commands_update" }});
        assert_eq!(
            parse_session_update(&value).expect("update"),
            AcpSessionUpdate::Other("available_commands_update".to_owned()),
        );
    }

    #[test]
    fn requests_number_themselves_so_answers_can_be_matched() {
        let mut requests = AcpRequests::default();
        assert_eq!(requests.initialize().id, 1);
        assert_eq!(requests.session_new("F:/tmp", &[]).id, 2);
        assert_eq!(requests.prompt("ses_1", "안녕", &[]).id, 3);
    }

    #[test]
    fn initialize_claims_the_file_capabilities_we_actually_serve() {
        // 승인이 떨어진 뒤 실제 쓰기는 하네스가 아니라 우리에게 온다. 못 한다고 알리면
        // 하네스가 파일 도구를 아예 내리거나 자기가 쓴다.
        let body = AcpRequests::default().initialize().body;
        assert_eq!(body["method"], "initialize");
        assert_eq!(
            body["params"]["clientCapabilities"]["fs"]["writeTextFile"],
            true
        );
        assert_eq!(
            body["params"]["clientCapabilities"]["fs"]["readTextFile"],
            true
        );
    }

    #[test]
    fn setting_the_model_uses_config_id_not_option_id() {
        // 2026-09-24 실측: optionId 로 보내면 Invalid params 로 거절한다.
        let body = AcpRequests::default()
            .set_model("ses_1", "ollama/qwen3.5-gpu")
            .body;
        assert_eq!(body["method"], "session/set_config_option");
        assert_eq!(body["params"]["configId"], "model");
        assert_eq!(body["params"]["value"], "ollama/qwen3.5-gpu");
        assert!(body["params"].get("optionId").is_none());
    }

    #[test]
    fn the_agent_is_chosen_through_the_mode_option() {
        // 하네스는 에이전트를 mode 라 부른다. 도구 목록과 지침이 여기서 갈리므로,
        // 로컬 모델은 이것을 지정하지 않으면 기본 에이전트의 도구 열 개를 받는다.
        let body = AcpRequests::default()
            .set_agent("ses_1", "agent-manager-local")
            .body;
        assert_eq!(body["method"], "session/set_config_option");
        assert_eq!(body["params"]["configId"], "mode");
        assert_eq!(body["params"]["value"], "agent-manager-local");
    }

    #[test]
    fn cancel_is_a_notification_without_an_id() {
        // id를 붙이면 하네스가 요청 라우터에서 찾지 못해 Method not found로 거절한다.
        // 알림으로 보내야 진행 중이던 프롬프트가 cancelled로 돌아온다(2026-09-24 실측).
        let body = AcpRequests::cancel("ses_1");
        assert_eq!(body["method"], "session/cancel");
        assert_eq!(body["params"]["sessionId"], "ses_1");
        assert!(body.get("id").is_none());
    }

    #[test]
    fn a_prompt_is_a_list_of_typed_parts() {
        let body = AcpRequests::default().prompt("ses_1", "안녕", &[]).body;
        assert_eq!(body["params"]["prompt"][0]["type"], "text");
        assert_eq!(body["params"]["prompt"][0]["text"], "안녕");
    }

    #[test]
    fn a_failure_is_reported_as_an_error_member_not_inside_result() {
        // result 안에 담으면 하네스가 성공으로 읽는다. 실제로 그래서 모델이 쓰지 못한
        // 파일을 "생성했습니다"라고 답했다.
        let body = error_body(9, "읽기 전용 채팅이라 파일을 쓰지 않았습니다");
        assert_eq!(body["id"], 9);
        assert_eq!(body["error"]["code"], -32000);
        assert_eq!(
            body["error"]["message"],
            "읽기 전용 채팅이라 파일을 쓰지 않았습니다",
        );
        assert!(body.get("result").is_none());
    }

    #[test]
    fn a_prompt_carries_images_beside_the_text() {
        // 경로만 적어 보내면 모델이 도구로 읽어야 하고, 그것은 그림을 보는 것과 다르다.
        let images = vec![AcpImage {
            mime_type: "image/png".to_owned(),
            base64: "AAA".to_owned(),
        }];
        let body = AcpRequests::default()
            .prompt("ses_1", "이 그림", &images)
            .body;
        let parts = body["params"]["prompt"].as_array().expect("배열");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], "text");
        assert_eq!(parts[1]["type"], "image");
        assert_eq!(parts[1]["mimeType"], "image/png");
        assert_eq!(parts[1]["data"], "AAA");
    }

    #[test]
    fn an_image_only_prompt_drops_the_empty_text_part() {
        // 빈 글 조각을 함께 보내면 하네스가 빈 발화로 읽는다.
        let images = vec![AcpImage {
            mime_type: "image/png".to_owned(),
            base64: "AAA".to_owned(),
        }];
        let body = AcpRequests::default().prompt("ses_1", "   ", &images).body;
        let parts = body["params"]["prompt"].as_array().expect("배열");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0]["type"], "image");
    }

    #[test]
    fn loading_a_session_uses_load_not_resume() {
        // session/resume 은 인자가 달라 거절당한다(2026-09-24 실측).
        let body = AcpRequests::default()
            .load_session("ses_1", "F:/work", &[])
            .body;
        assert_eq!(body["method"], "session/load");
        assert_eq!(body["params"]["sessionId"], "ses_1");
        assert_eq!(body["params"]["cwd"], "F:/work");
    }

    #[test]
    fn an_mcp_server_carries_an_empty_header_array() {
        // headers 가 없으면 하네스가 Invalid params 로 거절한다(2026-09-24 실측).
        let servers = vec![AcpMcpServer {
            name: "agent-manager".to_owned(),
            url: "http://127.0.0.1:1/mcp".to_owned(),
        }];
        let body = AcpRequests::default().session_new("F:/work", &servers).body;
        let listed = &body["params"]["mcpServers"][0];
        assert_eq!(listed["name"], "agent-manager");
        assert_eq!(listed["type"], "http");
        assert_eq!(listed["url"], "http://127.0.0.1:1/mcp");
        assert!(listed["headers"].is_array());
    }

    #[test]
    fn a_session_without_servers_still_sends_an_array() {
        let body = AcpRequests::default().session_new("F:/work", &[]).body;
        assert!(body["params"]["mcpServers"].is_array());
    }

    #[test]
    fn a_finished_turn_is_reported_as_completed() {
        // 앱은 completed 로 시작하는 것만 성공으로 읽는다. 하네스 말을 그대로 넘기면
        // 멀쩡히 답한 턴이 실패 알림으로 뜬다.
        assert_eq!(turn_status("end_turn"), "completed");
        assert_eq!(turn_status("max_tokens"), "completed");
    }

    #[test]
    fn a_cancelled_turn_is_not_a_failure() {
        assert_eq!(turn_status("cancelled"), "interrupted");
    }

    #[test]
    fn an_unknown_stop_reason_is_treated_as_failure() {
        // 성공으로 접으면 조용히 넘어간다. 모르는 값은 눈에 띄는 쪽으로 둔다.
        assert_eq!(turn_status("refusal"), "failed");
        assert_eq!(turn_status("낯선값"), "failed");
    }

    #[test]
    fn a_new_session_result_yields_its_id_and_model_choices() {
        let result = serde_json::json!({
            "sessionId": "ses_f2f2d29",
            "configOptions": [
                { "id": "model", "type": "select", "currentValue": "opencode/big-pickle",
                  "options": [
                    { "value": "ollama/qwen3.5-gpu", "name": "Ollama (local)/qwen3.5:9b (GPU)" },
                    { "value": "ollama/gpt-oss-cpu-low", "name": "Ollama (local)/gpt-oss:20b" }
                  ] },
                { "id": "other", "options": [{ "value": "무시" }] }
            ]
        });
        assert_eq!(session_id_from(&result).as_deref(), Some("ses_f2f2d29"));
        assert_eq!(
            model_values_from(&result),
            vec!["ollama/qwen3.5-gpu", "ollama/gpt-oss-cpu-low"],
        );
    }

    #[test]
    fn a_result_without_choices_yields_an_empty_list_rather_than_failing() {
        assert!(model_values_from(&serde_json::json!({ "sessionId": "s" })).is_empty());
        assert!(session_id_from(&serde_json::json!({})).is_none());
    }

    /// 2026-09-24 OpenCode 1.18.32가 실제로 올린 요청. 필드 이름이 바뀌면 여기서 걸린다.
    fn captured_request() -> AcpPermissionRequest {
        serde_json::from_value(serde_json::json!({
            "sessionId": "ses_f2f2cac73ffeFZrKhxCD645gmi",
            "toolCall": {
                "toolCallId": "call_84cd7cec83424a3ea3f733cd",
                "title": "ls",
                "kind": "execute",
                "status": "pending",
                "locations": [],
                "rawInput": { "command": "ls" }
            },
            "options": [
                { "optionId": "once", "kind": "allow_once", "name": "Allow once" },
                { "optionId": "always", "kind": "allow_always", "name": "Always allow" },
                { "optionId": "reject", "kind": "reject_once", "name": "Reject" }
            ]
        }))
        .expect("captured request")
    }

    #[test]
    fn a_captured_request_parses_into_the_fields_the_card_needs() {
        let request = captured_request();
        assert_eq!(request.tool_call.kind, "execute");
        assert_eq!(request.tool_call.title, "ls");
        assert_eq!(request.options.len(), 3);
    }

    #[test]
    fn each_decision_picks_the_matching_option_kind() {
        let request = captured_request();
        let pick = |decision| {
            request
                .option_for(decision)
                .map(|option| option.option_id.as_str())
        };
        assert_eq!(pick(ChatApprovalDecision::Accept), Some("once"));
        assert_eq!(pick(ChatApprovalDecision::AcceptForSession), Some("always"));
        assert_eq!(pick(ChatApprovalDecision::Decline), Some("reject"));
    }

    #[test]
    fn accept_all_folds_to_one_time_instead_of_widening() {
        // 계획 검토 카드에서만 오는 값이다. 여기까지 오더라도 사용자가 고른 것보다 권한이
        // 넓어지면 안 된다 — Codex 경로도 같은 이유로 1회 허용으로 접는다.
        let request = captured_request();
        assert_eq!(
            request
                .option_for(ChatApprovalDecision::AcceptAll)
                .map(|o| o.option_id.as_str()),
            Some("once"),
        );
    }

    #[test]
    fn cancel_answers_with_cancelled_rather_than_an_option() {
        let request = captured_request();
        assert!(request.option_for(ChatApprovalDecision::Cancel).is_none());
        assert_eq!(
            request.outcome_for(ChatApprovalDecision::Cancel),
            AcpPermissionOutcome::Cancelled,
        );
    }

    #[test]
    fn a_missing_grade_falls_back_to_cancel_instead_of_a_wider_one() {
        // 하네스가 always 를 주지 않는 상황에서 세션 허용을 고르면, 1회 허용으로 슬쩍
        // 바꾸지 않고 취소로 답한다. 조용히 다른 등급으로 실행하는 것이 더 나쁘다.
        let mut request = captured_request();
        request
            .options
            .retain(|option| option.kind != "allow_always");
        assert_eq!(
            request.outcome_for(ChatApprovalDecision::AcceptForSession),
            AcpPermissionOutcome::Cancelled,
        );
    }

    #[test]
    fn the_outcome_serializes_the_way_the_harness_reads_it() {
        let request = captured_request();
        assert_eq!(
            serde_json::to_value(request.outcome_for(ChatApprovalDecision::Accept)).expect("json"),
            serde_json::json!({ "outcome": "selected", "optionId": "once" }),
        );
        assert_eq!(
            serde_json::to_value(AcpPermissionOutcome::Cancelled).expect("json"),
            serde_json::json!({ "outcome": "cancelled" }),
        );
    }
}
