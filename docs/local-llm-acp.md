# ACP 하네스 실측 (2026-09-24)

OpenCode 1.18.32 / Windows 11 / `opencode acp` (stdio, 줄 단위 JSON-RPC 2.0).

Codex `app-server --stdio`와 같은 자리라 기존 자식 프로세스 배선에 그대로 얹힌다.
아래는 `opencode acp`를 직접 띄워 주고받은 실제 메시지다.

## 기동 주의 (Windows)

`opencode`는 `.cmd` 래퍼다. `spawn("opencode", ...)`는 ENOENT로 죽는다.
`opencode.cmd`를 셸 경유로 띄워야 한다.

## 핸드셰이크

요청 `initialize { protocolVersion: 1, clientCapabilities: { fs: { readTextFile, writeTextFile } } }`

응답에서 우리가 쓰는 것:

```
agentCapabilities.loadSession            = true
agentCapabilities.sessionCapabilities    = { close, fork, list, resume }
agentInfo                                = { name: "OpenCode", version: "1.18.32" }
```

재개가 프로토콜 1급 기능이다. Codex 경로에서 rollout을 뒤져 재개하던 일이 없어진다.

## 세션

요청 `session/new { cwd, mcpServers: [] }`

응답 `{ sessionId, configOptions: [...] }`. 모델은 CLI 인자가 아니라 **세션 설정 항목**이다.

```
{ id: "model", type: "select", currentValue: "opencode/big-pickle",
  options: [ { value: "ollama/qwen3.5-gpu", name: "Ollama (local)/qwen3.5:9b (GPU)" }, ... ] }
```

바꿀 때는 `session/set_config_option { sessionId, configId: "model", value }`.
인자 이름이 `configId`다 — `optionId`로 보내면 `Invalid params`로 거절한다.

공급자·모델 목록은 `opencode.json`의 `provider.*`가 정한다. 앱이 그 항을 써 주어야
여기 선택지로 올라온다.

## 프롬프트와 스트리밍

요청 `session/prompt { sessionId, prompt: [{ type: "text", text }] }`
응답 `{ stopReason: "end_turn", usage: { inputTokens, outputTokens, totalTokens, cachedReadTokens } }`

진행 중에는 하네스가 `session/update`를 **요청으로** 밀어 올린다(알림이 아니라 요청 모양).

| `sessionUpdate` | 내용 |
| --- | --- |
| `agent_thought_chunk` | 추론 조각 |
| `agent_message_chunk` | 답변 조각 |
| `tool_call` | 도구 호출 시작. `toolCallId`, `title`, `kind`, `status: pending` |
| `tool_call_update` | `in_progress` → `completed`. `locations`, `rawInput`, `rawOutput` |
| `usage_update` | `{ used, size, cost }` |
| `available_commands_update` | 쓸 수 있는 명령 목록 |

## 승인

요청 `session/request_permission`:

```json
{
  "sessionId": "ses_…",
  "toolCall": { "toolCallId": "call_…", "title": "ls", "kind": "execute",
                "status": "pending", "locations": [], "rawInput": { "command": "ls" } },
  "options": [
    { "optionId": "once",   "kind": "allow_once",   "name": "Allow once" },
    { "optionId": "always", "kind": "allow_always", "name": "Always allow" },
    { "optionId": "reject", "kind": "reject_once",  "name": "Reject" }
  ]
}
```

응답 `{ outcome: { outcome: "selected", optionId } }` 또는 `{ outcome: { outcome: "cancelled" } }`.

앱 등급과의 대응은 1:1이다(`acp.rs`의 `option_for`).

| `ChatApprovalDecision` | ACP `kind` |
| --- | --- |
| `Accept` | `allow_once` |
| `AcceptForSession` | `allow_always` |
| `AcceptAll` | `allow_once` — 접는다. 넓히지 않는다 |
| `Decline` | `reject_once` |
| `Cancel` | 선택지 없이 `cancelled` |

`kind`로 고르고 `optionId`로 답한다. 이름(`name`)은 하네스가 영어로 주므로 화면 문구로
쓰지 않는다. 하네스가 그 등급을 주지 않으면 다른 등급으로 슬쩍 바꾸지 않고 취소로 답한다.

## 파일 쓰기는 클라이언트가 한다

승인이 떨어지면 하네스가 직접 쓰지 않고 우리에게 넘긴다.

```
fs/write_text_file { sessionId, path, content }   → 우리가 쓰고 {} 로 답한다
```

샌드박스 판정이 우리 손에 남는다는 뜻이다. 자체 하네스(C안)의 가장 큰 비용으로 꼽았던
부분을 ACP가 이미 이 모양으로 나눠 두었다.

## 권한 기본값

`opencode.json`의 `permission`이 정한다. 기본은 넓으므로 카드를 띄우려면 적어야 한다.

```json
{ "permission": { "edit": "ask", "bash": "ask", "webfetch": "ask" } }
```
