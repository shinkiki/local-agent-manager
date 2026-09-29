# 로컬 LLM 공급자(local) — Codex CLI 수동 스모크 결과

작업 0.2. 서빙 머신은 개발 머신과 같은 Windows 11 호스트(B550M-CORSAIR)다.

## 환경

| 항목 | 값 |
| --- | --- |
| Ollama | 0.34.2 |
| 모델 | `qwen3.5:9b` (9.7B, Q4_K_M, 6.1GB, capabilities: completion·vision·tools·thinking, 선언 context 262144) |
| base URL | `http://127.0.0.1:11434/v1` |
| Codex CLI | 0.154.0 (`@openai/codex`, `codex.exe` x86_64-pc-windows-msvc) |
| 공유 홈 | `C:\Users\refre\.codex` (`auth.json` 존재) |

`GET /v1/models`와 `POST /v1/responses` 모두 정상 응답한다.

## 스모크 절차

앱의 `codex_app_server_args`·`codex_thread_params`와 같은 계약으로 `codex app-server --stdio`를
띄우고 `initialize` → `initialized` → `thread/start` → `turn/start`를 보냈다. 프롬프트는
"현재 디렉터리에 `smoke.txt`를 만들고 `OK-LOCAL-LLM`을 넣어라. 셸 도구를 써라"였다.

스폰 인자(계획서 2장 그대로):

```
app-server --stdio
-c model_provider="agent_manager_local"
-c model_providers.agent_manager_local.name="Local LLM"
-c model_providers.agent_manager_local.base_url="http://127.0.0.1:11434/v1"
-c model_providers.agent_manager_local.wire_api="responses"
-c model_providers.agent_manager_local.requires_openai_auth=false
-c model_context_window=65536
```

`thread/start` 파라미터는 `sandbox="workspace-write"`, `approvalPolicy="never"`,
`model="qwen3.5:9b"`, `ephemeral=true`.

## 확인된 것

1. **인증 없이 성립한다.** `requires_openai_auth=false`로 `thread/start`·`turn/start`가
   모두 통과했고, 공유 홈의 `auth.json`과 충돌하지 않았다. 계획서 1장의 "로그인 불필요"
   판단은 유효하다.
2. **모델명을 거부하지 않는다.** `model="qwen3.5:9b"`를 그대로 받고, 응답 스레드의
   `modelProvider`는 `agent_manager_local`, `model`은 `qwen3.5:9b`로 돌아온다.
   세션 귀속을 `session_meta.model_provider`로 판별하려는 계약(계획서 2장)이 성립한다.
3. **`model_context_window`는 클램프된다.** `65536`을 줬으나 `thread/tokenUsage/updated`의
   `modelContextWindow`는 **62259**로 보고됐다. 내장 `ollama` 공급자로 붙였을 때는
   **258400**(모델 선언 262144 기준). 즉 Codex가 예약분을 빼고 다시 계산하므로 앱이 준 값이
   그대로 쓰이지 않는다. UI에 컨텍스트 크기를 표시한다면 이 보고값을 써야 한다.
4. **Codex의 모델 목록 자동 갱신은 Ollama 응답을 거부한다.**
   `failed to refresh available models: ... missing field 'models'` — Ollama의
   `{"object":"list","data":[...]}`를 Codex가 파싱하지 못한다. 치명적이지 않은 ERROR 로그로
   끝나며, 앱이 `GET {baseUrl}/models`를 직접 읽어 목록을 만드는 계획서 설계가 맞다.

## 막힌 것 — 도구를 호출하지 않는다 (M0 차단)

턴은 매번 정상 완주(`turn/completed`)하지만, 모델이 **셸 도구를 호출하지 않고**
` ```bash echo "OK-LOCAL-LLM" > smoke.txt ``` ` 같은 **코드블록을 본문 텍스트로 출력**한다.
`smoke.txt`는 생성되지 않았다. 프롬프트를 "반드시 shell 함수 도구를 호출하라"로 강화해도 같다.
2회 재현.

턴 시작 직후 다음 경고가 뜬다:

```
Model metadata for `qwen3.5:9b` not found. Defaulting to fallback metadata;
this can degrade performance and cause issues.
```

### 모델 쪽 문제가 아니다

Ollama `/v1/responses`에 도구 정의를 직접 실어 보내면 모델은 **정상적으로 `function_call`을
생성한다**. 긴 `instructions`(약 2천 토큰)와 도구 3종(`shell`·`apply_patch`·`update_plan`)을
함께 줘도 마찬가지다.

```
output: ['reasoning', 'function_call']
function_call: shell {"command":["echo","OK-LOCAL-LLM","> smoke.txt"]}
```

즉 원인은 모델의 도구 호출 능력이 아니라 **Codex가 미등록 모델에 적용하는 fallback
메타데이터**다. 내장 카탈로그의 항목들은 `shell_type`(`unified_exec`·`shell_command`)과
`tool_mode`(`null`·`code_mode_only`)를 가지며, fallback이 이 중 어느 조합으로 떨어지느냐에
따라 셸 도구가 아예 실리지 않을 수 있다. 모델이 도구 대신 bash 코드블록을 뱉는 증상은
`code_mode_only`의 동작과 일치한다.

### 시도한 우회 — `model_catalog_json`

Codex 0.154.0에는 설정 키 `model_catalog_json`(모델 메타데이터 JSON 경로)이 있다.
문서에 없어 바이너리에서 스키마를 확인했다. 최상위는 `{"models": [...]}`이고 항목은
`slug`·`priority`·`shell_type`·`apply_patch_tool_type`·`web_search_tool_type`(`text` 또는
`text_and_image`만 허용)·`context_window`·`tool_mode`·`supports_parallel_tool_calls` 등을
요구하며, **`base_instructions` 또는 `model_messages.instructions_template` 중 하나가
필수**다(없으면 설정 로딩 자체가 실패).

`shell_type="shell_command"`, `tool_mode=null`, 임시 `base_instructions`로 항목을 만들어
재시험한 결과 — 설정은 통과했으나 Ollama 스트림이 계속 끊기고
(`stream disconnected before completion: ... see the ollama server logs`, `Reconnecting 1/5`~`5/5`)
모델이 요청과 무관한 응답을 내놓았다. 도구 호출은 여전히 없었다. 임시로 지어낸
`base_instructions`가 원인일 가능성이 크지만 이 회차에서는 규명하지 못했다.

### 남은 실마리 — Codex 내장 OSS 경로

Codex에는 `--oss` / `--local-provider <lmstudio|ollama>` 플래그와 설정 키 `oss_provider`가
이미 있고, 내장 `ollama` 공급자로 `-c model_provider="ollama"`가 그대로 동작한다
(연결·턴 완주까지 확인). 다만 이 경로에서도 fallback 메타데이터 경고와 도구 미호출 증상은
동일했다. 내장 경로가 모델 메타데이터를 어떻게 채우는지가 다음 조사 대상이다.

## 결론

계획서 2장의 연결 계약(인증 없음·모델명·세션 귀속)은 실측으로 성립한다. 그러나 **현재
구성으로는 에이전트로 동작하지 않는다** — 도구 호출이 실리지 않아 파일 편집이 불가능하다.
계획서 7장 위험 목록의 첫 항목(커스텀 공급자에서의 모델 취급)이 현실화된 것으로, M1 이후
코드 작업에 들어가기 전에 이 경로를 먼저 뚫어야 한다.

다음 조사 후보(사용자 결정 사항):

- `model_catalog_json`에 제대로 된 `base_instructions`를 채워 재시험
- Codex 내장 `--oss`/`oss_provider` 경로가 메타데이터를 채우는 방식 추적
- 더 큰 모델(`qwen3.6:27b` 등)로 재시험해 모델 크기 의존성 배제
- 계획서 1장에서 2차 하네스로 남겨 둔 Qwen Code CLI로 전환

---

# 후속 조사 — 도구 표면 축소 (2026-09-23)

앞 절의 "도구를 호출하지 않는다"를 끝까지 추적해 원인을 특정하고 해소했다.
**결론: 로컬 모델은 충분히 쓸 수 있다. Codex가 싣는 도구 목록만 줄이면 된다.**

## 1. 모델 카탈로그 등록은 성공, 그래도 도구 호출은 없었다

Codex 바이너리에 내장된 모델 카탈로그(`{"models": [...]}`, 11개 항목)를 통째로 추출했다.
각 항목은 `base_instructions`(11,097~21,544자)와 `shell_type`·`tool_mode`를 들고 있다.
`gpt-5.4-mini`(`tool_mode: null`, 11,097자)를 틀로 `slug`만 `qwen3.5:9b`로 바꿔
`-c model_catalog_json=<경로>`로 넘기면:

- `Model metadata for ... not found` 경고가 사라진다 — Codex가 정식 등록 모델로 취급한다
- 턴은 오류 없이 완주한다
- 그러나 도구는 여전히 호출되지 않았다

## 2. Codex는 도구를 정상적으로 보내고 있었다

Ollama 앞에 기록용 HTTP 프록시를 두고 실제 요청을 캡처했다.

- 본문 45KB, `instructions` 12,950자, **도구 24개**
- `exec_command`·`write_stdin`·`apply_patch`·`view_image`·`web_search`·`update_plan`·
  `request_user_input`·`request_plugin_install`·`multi_agent_v1`·
  `list_mcp_resources`·`list_mcp_resource_templates`·`read_mcp_resource`·
  `mcp__cua_repl`·`mcp__node_repl`·`mcp__codex_apps__*`(11종)

## 3. 범인은 도구 목록 자체다 (프롬프트 길이가 아니다)

캡처한 실제 페이로드를 그대로 Ollama에 재생하면서 `tools` 배열만 바꿔 측정했다
(각 3회 반복, 결과는 전부 일관).

| 도구 구성 | 개수 | 결과 |
| --- | --- | --- |
| `exec_command`+`write_stdin`+`apply_patch` (이하 core) | 3 | function_call |
| core + `view_image` | 4 | function_call |
| core + `web_search` | 4 | function_call |
| core + `view_image` + `web_search` | 5 | 텍스트만 |
| core + `multi_agent_v1` | 4 | 텍스트만 |
| core + `request_user_input` | 4 | 텍스트만 |
| core + `request_plugin_install` | 4 | 텍스트만 |
| core + `list_mcp_resources` | 4 | 텍스트만 |
| core + `mcp__cua_repl` | 4 | 텍스트만 |
| 전체 | 24 | 텍스트만 |

`instructions`는 12,950자 그대로 둬도 도구가 3개면 호출하고, 108자로 줄여도 도구가 24개면
호출하지 않는다. **프롬프트 길이는 무관하고 도구 표면이 전부다.** qwen3.5:9b의 한계는
대략 **도구 4개**이며, MCP 계열과 `multi_agent_v1`·`request_*` 계열은 한 개만 들어와도
모델이 도구 선택을 놓치고 `[shell(...)]` 같은 가짜 호출 문법을 지어낸다.

## 4. 설정으로 24개 → 6개까지 줄였다

| 설정 | 효과 |
| --- | --- |
| `-c mcp_servers.{cua_repl,node_repl,codex_apps}.enabled=false` + 같은 이름에 `.command="cmd"` | `mcp__*` 11종과 `list/read_mcp_resource` 3종 제거 (24→8) |
| `-c tools.experimental_request_user_input.enabled=false` | `request_user_input` 제거 (8→7) |
| `-c agents.max_depth=0` | `multi_agent_v1` 제거 (7→6) |

`enabled=false`만 주면 `invalid transport`로 설정 로딩이 실패하므로 더미 `command`를 함께
줘야 한다. 남은 6개는 `exec_command`·`write_stdin`·`request_plugin_install`·`apply_patch`·
`view_image`·`web_search`이고, 이 상태에서도 모델은 도구를 호출하지 않는다(6 > 4).

효과가 없던 것: 카탈로그의 `experimental_supported_tools`(화이트리스트가 아니다)·
`input_modalities=["text"]`·`multi_agent_version=null`·`supports_search_tool=false`,
`-c tools.web_search=false`, `-c computer_use.default_app_access="deny"`,
`model_providers.*.supports_standalone_web_search=false`,
`thread/start`의 `multiAgentMode: "none"`.
타입 오류로 쓸 수 없던 것: `computer_use=false`·`browser_use=false`·`apps.enabled=false`·
`plugins.enabled=false`(`plugins`는 플러그인 이름 맵이다)·`tools.web_search="disabled"`.

마지막 3개(`request_plugin_install`·`view_image`·`web_search`)를 끄는 설정은 찾지 못했다.

## 5. 필터 프록시로 M0를 통과했다

앱이 `base_url`을 자기 로컬 프록시로 주고, 그 프록시가 `/v1/responses` 요청 본문의 `tools`
배열에서 허용 목록 밖 항목을 걷어낸 뒤 Ollama로 넘기는 방식으로 시험했다.
허용 목록은 `exec_command`·`write_stdin`·`apply_patch` 3종.

```
{"before":6,"after":3,"dropped":["request_plugin_install","view_image","web_search"]}
```

결과 — **한 턴에서 도구 호출 → 실제 셸 실행 → 파일 생성까지 완주했다.**

```
cmd=  "…\powershell.exe" -Command 'powershell -Command "Set-Content -Path smoke.txt …"'  exit=0
MSG:  DONE
$ cat smoke.txt
OK-LOCAL-LLM
```

즉 M0의 완료 기준(손으로 띄운 codex app-server 한 턴에서 파일 편집 성공)은 프록시를 끼운
구성에서 충족된다. 스트리밍(SSE)은 응답을 그대로 흘려보내면 되고, 요청 본문을 고쳐 쓰므로
`content-length`만 다시 계산하면 된다.

## 6. 계획서에 반영이 필요한 사항 (사용자 결정)

계획서 2장의 스폰 argv 계약이 다음만큼 늘어난다.

1. `-c model_catalog_json=<앱이 생성한 경로>` — 항목에 `base_instructions`가 필수이므로
   앱이 그 텍스트를 들고 있어야 한다(유지보수·출처 판단 필요).
2. 도구 축소 `-c` 3종(`mcp_servers.*.enabled=false`+더미 `command`,
   `tools.experimental_request_user_input.enabled=false`, `agents.max_depth=0`).
3. **도구 필터 프록시** — 앱이 루프백 프록시를 하나 띄우고 `base_url`을 그쪽으로 준다.
   연결 설정의 `baseUrl`은 사용자가 입력한 서빙 주소로 두고, 프록시가 그 앞에 선다.

3번은 계획서에 없던 계층이다. 대안은 Codex가 남은 3개 도구를 끄는 설정을 제공할 때까지
기다리거나, 도구를 더 많이 감당하는 큰 모델을 쓰는 것이다(이 머신에서는 속도가 나오지 않음 —
RTX 3080 Ti 12GB에 `qwen3.6:27b`는 17.8GB로 들어가지 않는다).
