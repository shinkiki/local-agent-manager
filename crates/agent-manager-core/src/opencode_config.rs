//! ACP 하네스가 읽는 `opencode.json`에 우리 공급자 항만 심는다.
//!
//! 이 파일은 사용자도 쓴다. 에이전트 정의·권한·키바인딩이 같은 파일에 있고, 우리가 통째로
//! 덮으면 그것들이 사라진다. 그래서 우리 공급자 항 하나만 갈아 끼우고 나머지 키는 읽은
//! 그대로 돌려놓는다(계획서 2장의 소유권 단서).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::CoreError;

use crate::local_llm::{LocalLlmConnectionEntry, DEFAULT_CONNECTION_ID};

/// 우리가 관리하는 공급자 항의 이름. 사용자가 직접 만든 `ollama` 같은 이름과 겹치지 않도록
/// 접두사를 붙인다 — 겹치면 사용자가 손으로 맞춘 설정을 우리가 말없이 덮는다.
///
/// M7 7.2 부터 연결마다 항이 하나씩이다. 기본 연결(`default`)은 이 이름을 그대로 쓰고
/// 나머지는 `agent-manager-local-<연결 id>` 다 — 옛 세션 기록의 `providerID` 가 그대로
/// 읽히도록 기본 이름은 바꾸지 않는다.
pub const PROVIDER_ID: &str = "agent-manager-local";

/// 연결 하나의 공급자 항 이름.
pub fn provider_id_for(connection_id: &str) -> String {
    if connection_id == DEFAULT_CONNECTION_ID {
        PROVIDER_ID.to_owned()
    } else {
        format!("{PROVIDER_ID}-{connection_id}")
    }
}

/// 공급자 항 이름이 우리 것인지. 사용자가 손으로 쓴 `ollama` 같은 항은 건드리지 않는다.
fn owns_provider(name: &str) -> bool {
    name == PROVIDER_ID || name.starts_with(&format!("{PROVIDER_ID}-"))
}

/// 우리 공급자 항 이름에서 연결 id 를 되돌린다. 우리 것이 아니면 `None`.
fn connection_id_of_provider(name: &str) -> Option<String> {
    if name == PROVIDER_ID {
        Some(DEFAULT_CONNECTION_ID.to_owned())
    } else {
        name.strip_prefix(&format!("{PROVIDER_ID}-"))
            .map(ToOwned::to_owned)
    }
}

/// 사람이 적어 둔 컨텍스트 크기에서 하네스가 요구하는 `limit` 한 벌을 만든다.
///
/// 스키마가 `context`와 `output`을 **둘 다** 요구한다(`opencode.ai/config.json`,
/// `required: ["context", "output"]`). 그래서 응답 몫을 우리가 정해야 하는데, 두 방향 모두
/// 실패가 있다. 크게 잡으면 그만큼 입력 자리가 줄어 압축이 일찍 돌고, 작게 잡으면 답이
/// 중간에 잘린다. 창의 8분의 1을 주되 양끝을 묶는다 — 128k면 16k, 32k면 4k다.
/// `min(창/2)`는 창이 하한(1,024)에 가까울 때 응답 몫이 창 전체를 먹어 입력이 0이 되는 것을
/// 막는다.
fn limit_entry(context_window: u32) -> Value {
    let output = (context_window / 8)
        .clamp(512, 16_384)
        .min(context_window / 2);
    serde_json::json!({ "context": context_window, "output": output })
}

/// 공급자 항에 실을 모델 하나.
///
/// 창을 이름과 함께 든다. 연결 하나에 모델이 여럿이고 그 창이 서로 다르기 때문이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalModel {
    pub name: String,
    pub context_window: Option<u32>,
}

/// 연결 하나를 공급자 항으로 옮긴다. 모델 목록은 서버가 주는 이름을 그대로 키로 쓴다.
fn provider_entry(
    entry: &LocalLlmConnectionEntry,
    models: &[LocalModel],
    api_key: Option<&str>,
) -> Value {
    let connection = &entry.connection;
    let mut catalog = Map::new();
    for model in models {
        let mut model_entry = Map::new();
        model_entry.insert("name".to_owned(), Value::String(model.name.clone()));
        // 크기를 적지 않으면 하네스는 이 모델의 창을 모른다. 그러면 자동 압축이 걸리지
        // 않아, 창이 차는 순간부터 매 턴이 `finish: "length"`로 잘린다 — 도구 호출은 생성이
        // 끝까지 가야 나오므로 그 시점부터 대화가 한 걸음도 나아가지 못한다. 사람이 값을
        // 적지 않았으면 추측하지 않고 비워 둔다. 틀린 크기는 없는 것보다 나쁘다.
        //
        // **창은 모델마다 다르다.** 연결 값 하나를 모든 모델에 적으면, 같은 서버에 16k
        // 모델과 128k 모델이 함께 있을 때 한쪽에 반드시 거짓을 적게 된다(2026-09-26 실측:
        // gpt-oss-cpu-low 16,384 · qwen3.5-gpu-128k 131,072). 사람이 연결에 적어 둔 값이
        // 있으면 그것을 쓰고, 없을 때만 모델마다 알아낸 값을 쓴다.
        // M7 7.2: 연결에 모델별 값이 적혀 있으면 그것이 연결 값보다 먼저다.
        if let Some(window) = entry
            .context_window_for(&model.name)
            .or(model.context_window)
        {
            model_entry.insert("limit".to_owned(), limit_entry(window));
        }
        catalog.insert(model.name.clone(), Value::Object(model_entry));
    }
    let mut options = Map::new();
    options.insert(
        "baseURL".to_owned(),
        Value::String(connection.base_url.clone()),
    );
    // 키를 요구하는 서버가 있다. Codex 경로는 env_key 로 환경변수를 심었지만 이 하네스는
    // 공급자 항의 apiKey 를 본다 — 환경변수만 내보내면 그 서버는 늘 401 이다.
    if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        options.insert("apiKey".to_owned(), Value::String(key.to_owned()));
    }
    // 연결이 여럿이면 하네스 화면에서 어느 서버인지 이름으로 갈린다.
    let name = if entry.id == DEFAULT_CONNECTION_ID {
        "Agent Manager 로컬 LLM".to_owned()
    } else {
        format!("Agent Manager 로컬 LLM · {}", entry.label)
    };
    serde_json::json!({
        "npm": "@ai-sdk/openai-compatible",
        "name": name,
        "options": Value::Object(options),
        "models": Value::Object(catalog),
    })
}

/// 읽은 설정에 **이 연결의** 항을 심은 결과를 돌려준다. 원본은 건드리지 않는다.
///
/// 연결이 꺼져 있거나 주소가 비면 그 항을 **지운다**. 남겨 두면 하네스가 닿지 않는
/// 주소로 모델 목록을 물어보다 실패하고, 사용자는 끈 공급자가 왜 오류를 내는지 알 수 없다.
///
/// 다른 연결의 항은 손대지 않는다(M7 7.2). 채팅 둘이 서로 다른 연결로 잇달아 시작해도
/// 한쪽이 다른 쪽 항을 덮지 않는다 — 각자 자기 항만 갈아 끼운다. 지워진 연결의 항은
/// [`apply`]가 목록과 대조해 걷어낸다.
pub fn merged(
    existing: &Value,
    entry: &LocalLlmConnectionEntry,
    models: &[LocalModel],
    api_key: Option<&str>,
    plugin_shell: bool,
) -> Value {
    let connection = &entry.connection;
    let mut root = existing.as_object().cloned().unwrap_or_default();
    let mut providers = root
        .get("provider")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let provider_id = provider_id_for(&entry.id);
    if connection.enabled && !connection.base_url.trim().is_empty() {
        providers.insert(provider_id, provider_entry(entry, models, api_key));
    } else {
        providers.remove(&provider_id);
    }
    // 에이전트 항은 우리 공급자가 하나라도 남아 있을 때만 둔다. 이 연결을 껐어도 다른
    // 연결이 살아 있으면 그 채팅이 같은 에이전트를 쓴다.
    let ours_remain = providers.keys().any(|name| owns_provider(name));
    if providers.is_empty() {
        root.remove("provider");
    } else {
        root.insert("provider".to_owned(), Value::Object(providers));
    }

    // 에이전트도 같은 규칙으로 심는다. 공급자만 있고 에이전트가 없으면 하네스가 기본
    // 에이전트로 돌아 도구 10개를 그대로 준다 — 그 구간에서는 모델이 도구를 호출하지 않는다.
    let mut agents = root
        .get("agent")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    // 우리 것은 통째로 걷어내고 다시 심는다. 붙는 플러그인이 실행마다 달라서, 지난번에
    // 쓴 묶음이 남아 있으면 이제는 붙지 않는 서버의 도구를 여는 에이전트가 설정에 남는다.
    agents.retain(|name, _| !owns_agent(name));
    if ours_remain {
        agents.insert(AGENT_ID.to_owned(), agent_entry(plugin_shell));
        agents.insert(SYSTEM_AGENT_ID.to_owned(), system_agent_entry(plugin_shell));
        if plugin_shell {
            agents.insert(PLUGINS_AGENT_ID.to_owned(), plugins_agent_entry());
        }
        // 계획과 단계용 항. `mode`는 `availableModes`에 있는 것만 받고 그 목록은 세션이
        // 열릴 때 굳으므로, 쓸 수도 있는 항을 미리 다 심어 둔다 — 도중에 더해도 늦다.
        agents.insert(PLAN_AGENT_ID.to_owned(), plan_agent_entry(plugin_shell));
        agents.insert(DRAFT_AGENT_ID.to_owned(), draft_agent_entry(plugin_shell));
        agents.insert(
            SUMMARY_AGENT_ID.to_owned(),
            summary_agent_entry(plugin_shell),
        );
        for tool in KEPT_TOOLS {
            agents.insert(step_agent_id(tool), step_agent_entry(tool, plugin_shell));
        }
    }
    if agents.is_empty() {
        root.remove("agent");
    } else {
        root.insert("agent".to_owned(), Value::Object(agents));
    }
    Value::Object(root)
}

/// 세션 모델 설정에 넘길 이름. ACP는 `<공급자>/<모델>`로 한정된 이름을 쓴다. 같은 모델
/// 이름이 두 연결에 있어도 공급자 항이 다르므로 섞이지 않는다.
pub fn qualified_model(connection_id: &str, model: &str) -> String {
    format!("{}/{model}", provider_id_for(connection_id))
}

/// 목록에서 지워진 연결의 항을 걷어낸다. `keep` 은 지금 심는 연결이라 목록과 무관하게
/// 남긴다. 사용자가 손으로 쓴 항은 우리 접두가 아니므로 건드리지 않는다.
fn prune_removed_providers(root: &mut Value, known_ids: &[String], keep: &str) {
    let Some(providers) = root.get_mut("provider").and_then(Value::as_object_mut) else {
        return;
    };
    providers.retain(|name, _| match connection_id_of_provider(name) {
        Some(id) => id == keep || known_ids.contains(&id),
        None => true,
    });
    if providers.is_empty() {
        root.as_object_mut().map(|root| root.remove("provider"));
    }
}

/// 하네스가 읽는 설정 파일. 사용자 홈 아래 고정 경로다.
pub fn config_path(home: &Path) -> PathBuf {
    home.join(".config/opencode/opencode.json")
}

/// 연결 상태를 설정 파일에 반영한다. 파일이 없으면 만들고, 있으면 우리 항만 갈아 끼운다.
///
/// 읽기에 실패하면 빈 설정에서 시작하지 않고 오류로 올린다. 사용자가 손으로 쓴 내용이
/// 있는데 우리가 읽지 못한 채 새로 쓰면 그것을 지우는 셈이 된다.
pub fn apply(
    home: &Path,
    entry: &LocalLlmConnectionEntry,
    models: &[LocalModel],
    api_key: Option<&str>,
    known_ids: &[String],
    plugin_shell: bool,
) -> Result<PathBuf, CoreError> {
    let path = config_path(home);
    let existing = match fs::read_to_string(&path) {
        Ok(text) if text.trim().is_empty() => Value::Null,
        Ok(text) => serde_json::from_str(&text).map_err(|error| {
            CoreError::Runtime(format!(
                "{}를 읽지 못했습니다: {error}. 파일을 고치거나 옮긴 뒤 다시 시도하세요",
                path.display()
            ))
        })?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Null,
        Err(error) => {
            return Err(CoreError::Runtime(format!(
                "{}를 읽지 못했습니다: {error}",
                path.display()
            )))
        }
    };
    let mut merged = merged(&existing, entry, models, api_key, plugin_shell);
    prune_removed_providers(&mut merged, known_ids, &entry.id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            CoreError::Runtime(format!("{}를 만들지 못했습니다: {error}", parent.display()))
        })?;
    }
    let text = serde_json::to_string_pretty(&merged)
        .map_err(|error| CoreError::Runtime(format!("설정을 적지 못했습니다: {error}")))?;
    // 사용자 소유 파일이라 반쯤 쓰인 상태를 남기면 안 된다. 임시 파일에 쓰고 바꿔 끼운다 —
    // 채팅 둘이 동시에 시작해도 한쪽 내용이 잘리지 않는다.
    crate::app_data_file::write_private_bytes(
        &path,
        format!(
            "{text}
"
        )
        .as_bytes(),
    )?;
    Ok(path)
}

/// 시스템 묶음 에이전트. 작업 공간 도구를 끄고 MCP 도구만 남긴다. 둘을 함께 열면
/// 도구 수가 다시 불어나 모델이 호출을 못 한다.
fn system_agent_entry(plugin_shell: bool) -> Value {
    let mut tools = Map::new();
    for tool in KEPT_TOOLS.iter().chain(DROPPED_TOOLS.iter()) {
        tools.insert((*tool).to_owned(), Value::Bool(false));
    }
    // 기본값에 기대지 않고 켠다. 반대쪽이 명시로 끄므로 여기도 명시가 대칭이다.
    tools.insert(system_mcp_tool_glob(), Value::Bool(true));
    close_plugin_shell(&mut tools, plugin_shell);
    close_plan(&mut tools, true);
    serde_json::json!({
        "description": "Agent Manager 조작용. 시스템 MCP 도구만 연다.",
        "prompt": system_prompt(),
        "tools": Value::Object(tools),
    })
}

/// 시스템 MCP를 붙일 때 쓰는 이름. 하네스가 도구 이름 앞에 이 값을 붙인다.
pub const SYSTEM_MCP_NAME: &str = "agent-manager";

/// 시스템 MCP 도구를 한 줄로 가리키는 열쇠. 하네스는 `<서버>_<도구>`로 이름을 짓고
/// `tools` 항목에서 `*`를 와일드카드로 받는다. 도구가 늘어도 이 한 줄이 따라간다.
fn system_mcp_tool_glob() -> String {
    format!("{SYSTEM_MCP_NAME}_*")
}

/// 우리가 관리하는 에이전트 이름. 세션의 `mode` 설정으로 고른다.
pub const AGENT_ID: &str = "agent-manager-local";

/// 시스템 MCP를 함께 여는 에이전트. 작업 공간 도구는 빼고 MCP만 남겨, 한 번에 보이는
/// 도구 수가 다시 불어나지 않게 한다.
pub const SYSTEM_AGENT_ID: &str = "agent-manager-local-system";

/// 플러그인 껍데기만 여는 묶음의 에이전트 이름.
pub const PLUGINS_AGENT_ID: &str = "agent-manager-local-plugins";

/// 실행 중 재계획 에이전트 이름.
pub const PLAN_AGENT_ID: &str = "agent-manager-local-plan";

/// 초안 작성과 초안 되묻기에 쓰는 에이전트.
pub const DRAFT_AGENT_ID: &str = "agent-manager-local-draft";

pub(crate) fn planning_agent_id(slot: &crate::plan::PlanSlot) -> &'static str {
    if matches!(slot, crate::plan::PlanSlot::Drafting(_)) {
        DRAFT_AGENT_ID
    } else {
        PLAN_AGENT_ID
    }
}

/// 마무리 요약 에이전트 이름.
pub const SUMMARY_AGENT_ID: &str = "agent-manager-local-summary";

/// 단계 하나를 도는 에이전트 이름. 도구마다 하나씩이다.
pub fn step_agent_id(tool: &str) -> String {
    format!("{AGENT_ID}-step-{tool}")
}

/// 이 단계의 도구를 여는 에이전트.
///
/// 작업 공간 도구는 전용 항이 하나씩 있다. **플러그인 도구는 전부 껍데기 하나로 간다** —
/// 마흔다섯 개마다 항을 세우는 대신, 그 단계가 어느 플러그인 도구를 쓸 수 있는지는 껍데기가
/// 호출마다 물어 서버에서 집행한다. 곱이 더하기로 바뀌는 자리가 여기다.
pub fn step_agent_for(tool: &str) -> String {
    if KEPT_TOOLS.contains(&tool) {
        step_agent_id(tool)
    } else if is_system_mcp_tool(tool) {
        SYSTEM_AGENT_ID.to_owned()
    } else {
        PLUGINS_AGENT_ID.to_owned()
    }
}

/// 시스템 MCP 가 내보내는 이름인지. 하네스가 `<서버>_<도구>`로 짓는다.
fn is_system_mcp_tool(tool: &str) -> bool {
    tool.starts_with(&format!("{SYSTEM_MCP_NAME}_"))
}

/// 계획 색인에 싣는 시스템 MCP 도구.
///
/// **둘만 싣는다.** 시스템 작업은 백 개에 가깝지만 그 목록은 `system_catalog` 가 들고
/// 있고, 도구 자체는 `operation` 인자를 받는 껍데기 둘이다 — 노션 45개를 `find_tool`·
/// `call_tool` 로 접은 것과 같은 모양이라 색인이 두 줄만 늘어난다(2026-09-27).
///
/// 작업 이름을 여기 적지 않는 이유: 적는 순간 카탈로그와 두 벌이 되고, 작업이 늘거나
/// 이름이 바뀌면 이 글이 거짓이 된다. 어디서 찾는지만 알려 준다.
///
/// 읽기 전용이면 **바꾸는 도구는 싣지 않는다.** 파일 쓰기는 막으면서 Agent Manager 설정
/// 변경은 열어 두면 모드 이름이 거짓이 된다 — 리뷰에서 잡힌 자리다(2026-09-27).
pub(crate) fn system_tool_descriptions(read_only: bool) -> Vec<(String, &'static str)> {
    let mut tools = vec![
        (
            format!("{SYSTEM_MCP_NAME}_system_catalog"),
            "Returns the list of operations that manage Agent Manager and their argument shapes. Look here first to see what operations exist.",
        ),
        (
            format!("{SYSTEM_MCP_NAME}_system_read"),
            "Reads Agent Manager itself (sessions, folders, settings, skills, ...). Put the operation name in operation.",
        ),
    ];
    if !read_only {
        tools.push((
            format!("{SYSTEM_MCP_NAME}_system_execute"),
            "Changes Agent Manager itself (assigning session folders, ...). Put the operation name in operation.",
        ));
    }
    tools
}

/// 이 이름이 앱 소유인지(`C14-2`의 `agent.agent-manager-local*`).
fn owns_agent(name: &str) -> bool {
    name == AGENT_ID || name.starts_with(&format!("{AGENT_ID}-"))
}

/// 세션 표가 우리 대화를 고를 때 쓰는 LIKE 무늬. 묶음이 늘어도 따라간다 —
/// 예전에는 이름 둘을 박아 두어, 묶음을 하나 더하자 그 대화가 목록에서 사라졌다.
pub fn owned_agent_like_pattern() -> String {
    format!("{AGENT_ID}-%")
}

/// 껍데기 도구 전부를 가리키는 열쇠. 플러그인이 몇 개든 이 하나다.
fn plugin_shell_tool_glob() -> String {
    format!("{}_*", crate::system_mcp::PLUGIN_SHELL_SERVER_NAME)
}

/// 작업 공간 묶음의 시스템 프롬프트 — 웹 문장을 뺀 몸통.
///
/// 상수로 뽑아 둔 이유는 측정 때문이다. `local-llm-dev/tuning-eval` 의 탐침이 이 파일에서
/// 이름으로 찾아 읽어, 재는 문장과 배포되는 문장이 갈라지지 않게 한다. json! 안에 적혀
/// 있으면 탐침은 베낀 사본을 재고 프롬프트를 고쳐도 측정값은 옛 문장 그대로다.
const WORKSPACE_PROMPT_BASE: &str = "너는 셸과 파일을 다루는 에이전트다. 할 수 있는 일은 말로 설명하지 말고 주어진 도구를 호출해 실제로 실행해라. 주어진 도구로 못 하는 일이면 억지로 돌려 하지 말고 무엇이 없어서 못 하는지 답하고 끝내라. 도구 이름은 주어진 그대로 쓴다.";

/// 요청이 가리키는 **대상**이 없을 때의 출구.
///
/// [`WORKSPACE_PROMPT_BASE`] 의 출구는 "주어진 **도구**로 못 하는 일"만 연다. 없는 것이
/// 도구가 아니라 파일이면 모델에게는 쓸 문장이 없고, 2026-09-25 코드 리팩토링 회차의
/// 실측에서 두 레인이 그 빈자리를 서로 다른 방향으로 밟았다(과제 `refuse-absent-file`,
/// 없는 `payments/legacy.mjs` 를 리팩토링하라고 시킨다).
///
/// - CPU(gpt-oss-cpu-low): 없는 파일을 **새로 만들어** 리팩토링한 것처럼 끝냈다(1/3).
/// - GPU(qwen3.5-gpu-128k): 파일은 건드리지 않았으나 마지막 턴의 본문이 비었다(2/3).
///   화면에서는 "응답이 그냥 끊긴 것"으로 보인다.
///
/// 그래서 두 문장이다 — 없는 대상을 지어내지 말 것, 그리고 도구를 부르지 않고 끝내는
/// 턴에도 할 말을 본문에 남길 것. 뒤 문장이 없으면 앞 문장을 따라도 화면은 여전히 빈다.
const MISSING_TARGET_CLAUSE: &str = "요청이 가리키는 파일·폴더·대상이 실제로 없으면 비슷한 것을 대신 고치거나 새로 만들지 말고, 무엇이 없는지 답하고 끝내라. 도구를 부르지 않고 끝내는 턴에도 할 말은 반드시 본문에 적는다.";

/// 시스템 묶음의 시스템 프롬프트 — 웹 문장을 뺀 몸통.
const SYSTEM_PROMPT_BASE: &str = "너는 Agent Manager를 조작하는 에이전트다. 주어진 도구로 직접 실행하고, 사용자가 요청하지 않은 설정 변경은 하지 않는다.";

/// 계획 턴의 시스템 프롬프트. 쓸 수 있는 도구 목록은 여기 없고 턴 프롬프트에 실린다.
pub(crate) const PLAN_PROMPT: &str = "You are an agent that plans how to handle the request. In this turn you only write the plan; nothing is executed. The only tools you may call now are add_step, finish_plan, answer_now, and cannot_do. Every other tool name is written into add_step's tools and is called later, when that step runs; calling it now is an error. Call add_step once per step, one at a time, each following the previous step. When no more steps are needed, call finish_plan. If the request cannot be done with the listed tools, do not invent a plan; call cannot_do. One tool per step. Use only tool names from the given list.";

/// 단계 하나를 도는 에이전트의 시스템 프롬프트.
const STEP_PROMPT: &str = "너는 계획의 한 단계를 실행하는 에이전트다. 지금 열려 있는 도구 하나로 이 단계를 끝내라. 말로 설명하지 말고 실제로 호출해라. 그 도구로 이 단계를 할 수 없으면 억지로 돌려 하지 말고 무엇이 막는지 한두 문장으로 답하고 끝내라.";

/// 마무리 요약의 시스템 프롬프트.
const SUMMARY_PROMPT: &str = "너는 방금 끝난 일을 사용자에게 한 번에 정리해 주는 에이전트다. 지금은 도구가 없다 — 아래 기록만 보고 답한다. 무엇을 했고 무엇이 되었는지 사용자의 말로 적고, 실패하거나 건너뛴 것이 있으면 감추지 말고 그대로 적어라. 기록에 없는 것을 지어내지 마라. 단계 메모 앞의 도구 호출 통계(성공·실패 수)와 어긋나게 적지 마라 — 부르지 않았거나 실패한 항목은 성공이 아니다.";

/// 껍데기 묶음의 시스템 프롬프트.
const PLUGINS_PROMPT: &str = "너는 연결된 외부 서비스를 다루는 에이전트다. 먼저 find_tool 로 부를 도구와 인자를 확인하고 call_tool 로 실행한다. 할 수 있는 일은 말로 설명하지 말고 실제로 호출해라. 찾아봐도 그 일을 하는 도구가 없으면 억지로 다른 도구를 돌려 쓰지 말고, 무엇이 없어서 못 하는지 한두 문장으로 답하고 끝내라.";

/// 웹을 조회할 수 있는 도구 이름. 이 중 하나라도 [`KEPT_TOOLS`] 에 있으면 "웹을 조회하는
/// 도구는 없다"는 문장은 거짓이 된다.
const WEB_TOOLS: &[&str] = &["webfetch"];

/// 웹 도구가 닫혀 있는 묶음의 문장.
///
/// 한때 셸이 열린 묶음에는 "bash 로 curl·wget 을 써서 나가지도 마라"를 덧붙였다. `bash` 는
/// 그 자체로 웹 조회 수단이라 "웹 도구가 없다"만으로는 반만 참이었기 때문이다. 그 줄은
/// 뺐다 — **프롬프트로 건 금지는 규칙이지 강제가 아니다.** 모델이 따르기를 기대하는
/// 문장일 뿐이고 셸은 여전히 네트워크에 닿는다. 막아야 하는 것이면 도구 표면에서 막아야
/// 하고, 여기서는 막지 않기로 정했다(2026-09-25 사용자 결정 — webfetch 를 열면서 curl 도
/// 함께 허용). 그러니 있지도 않은 울타리를 문장으로 세우지 않는다.
const NO_WEB_CLAUSE: &str = "웹을 조회하는 도구는 없다. 인터넷에서 확인해야 답할 수 있는 요청은 지어내지 말고 조회할 수 없다고 답해라.";

/// 웹 도구가 열려 있을 때의 문장.
///
/// 도구 이름을 문장에 박지 않는다 — 열려 있는 이름은 도구 목록이 이미 말해 주고, 여기
/// 박으면 [`WEB_TOOLS`] 에 두 번째 이름이 생기는 순간 또 거짓이 된다.
const WEB_OPEN_CLAUSE: &str = "웹을 조회하는 도구가 열려 있다. 인터넷에서 확인해야 하는 요청은 그 도구를 불러 직접 가져와서 답해라. 가져오지 못했으면 지어내지 말고 못 가져왔다고 답해라.";

/// 지금 열린 도구 표면에 맞는 웹 문장을 고른다.
///
/// 왜 상수 한 줄이 아니라 고르는가: 예전에는 "웹을 조회하는 도구는 없다"가 두 프롬프트에
/// 그냥 박혀 있었다. 도구 표면에 대한 **사실**을 도구 표면과 무관하게 주장한 것이라, 양쪽
/// 방향으로 다 틀렸다(2026-09-25 LEG 회차 실측).
///
/// - 느슨한 쪽: 셸이 열려 있으니 웹은 사실 닿는다. GPU 레인이 `bash` 로 우회했다(환율 1/3).
/// - 빡빡한 쪽: 웹 도구를 실제로 열어 줘도 문장이 없다고 하니 모델이 문장을 믿고 거절했다.
///   CPU 레인(gpt-oss-cpu-low)은 `webfetch` 를 손에 쥔 채 "외부 URL 의 내용을 가져오는
///   기능을 제공하지 않는다"며 1/3 로 떨어졌다. 같은 표면에서 셸 과제는 3/3 이었으므로
///   도구 수가 깨뜨린 것이 아니라 우리 문장이 깨뜨린 것이다.
///
/// 인자가 전역 목록이 아니라 **그 묶음의** 웹 개방 여부인 이유: 묶음마다 표면이 다르다.
/// `webfetch` 가 [`KEPT_TOOLS`] 에 있어도 시스템 묶음은 그것을 닫으므로
/// ([`system_agent_entry`]), 전역 목록을 보면 웹이 없는 묶음에 "열려 있다"고 말하게 된다 —
/// 고치려던 거짓을 방향만 바꿔 되살리는 셈이다.
fn web_clause(web_open: bool) -> &'static str {
    if web_open {
        WEB_OPEN_CLAUSE
    } else {
        NO_WEB_CLAUSE
    }
}

/// 작업 공간 묶음에 웹 도구가 열려 있는지. 열린 목록에서 읽는다.
fn workspace_web_open() -> bool {
    KEPT_TOOLS.iter().any(|tool| WEB_TOOLS.contains(tool))
}

/// 작업 공간 묶음 프롬프트. 셸과 (열려 있다면) 웹 도구를 쥔다.
///
/// 순서는 몸통 · '없는 대상' 출구 · 웹 문장이다. 앞 둘은 표면과 무관하게 늘 나가고,
/// 마지막 한 조각만 열린 도구를 따라간다.
fn workspace_prompt() -> String {
    format!(
        "{WORKSPACE_PROMPT_BASE} {MISSING_TARGET_CLAUSE} {}",
        web_clause(workspace_web_open())
    )
}

/// 시스템 묶음 프롬프트. 작업 공간 도구가 전부 닫혀 있어 셸도 웹도 없다.
fn system_prompt() -> String {
    format!("{SYSTEM_PROMPT_BASE} {}", web_clause(false))
}

/// 로컬 모델에 남길 도구. 실측으로 정한 목록이다(2026-09-24, `webfetch` 는 2026-09-25).
///
/// 같은 모델·같은 과제에서 도구 수만 달리해 재 보았다. Codex 26개는 없는 이름을 지어냈고,
/// OpenCode 기본 10개는 도구 대신 코드블록을 뱉었으며, 2개로 줄이자 실제로 호출했다.
/// 기본값이 좋아서 OpenCode를 고른 것이 아니라, 줄일 수 있어서 고른 것이다.
///
/// `webfetch` 는 넷째 도구다. 도구를 하나 더 열면 호출이 깨지는지가 이 목록을 늘릴 때마다
/// 물어야 할 질문이고, LEG 튜닝 회차에서 그것부터 쟀다 — 넷으로 늘린 표면에서 웹 과제는
/// GPU 3/3 · CPU 6/6, 같은 표면의 셸 과제도 3/3 이었다. 재기 전에는 열지 않았다.
///
/// `edit` 는 **우리가 고른 것이 아니라 확인한 것**이다. 오래도록 [`DROPPED_TOOLS`] 에서
/// `false` 로 적어 두었는데, 2026-09-25 에 두 레인에게 "네게 주어진 도구를 전부 나열해라"
/// 라고 물으니 둘 다 `bash · edit · read · webfetch · write` 를 돌려주었다. 설정 파일에는
/// 분명히 `"edit": false` 가 적혀 있었다.
///
/// 설정이 통째로 무시되는 것은 아니다 — 같은 물음을 플러그인 묶음에 던지면
/// `plugins_find_tool · plugins_call_tool` 둘만 돌아온다. 그 묶음은 `write` 도 닫는다.
/// 두 관찰을 함께 놓으면 `edit` 는 `write` 를 따라다닌다. 파일을 쓸 수 있는 묶음에서는
/// 하네스가 부분 수정도 함께 열고, 우리 `false` 가 그것을 이기지 못한다.
///
/// 그래서 여기로 옮긴다. **닫지 못하는 것을 닫았다고 적어 두면 목록이 거짓말을 한다** —
/// 도구 수를 세는 모든 판단이 그 위에 서 있으므로 하나가 틀리면 전부 틀린다. 마침
/// 값어치도 있다: 부분 수정이 없으면 세 줄을 고치려고 파일을 통째로 다시 써야 한다.
const KEPT_TOOLS: &[&str] = &["bash", "read", "write", "edit", "webfetch"];

/// 작업 공간 도구의 한 줄 설명. 계획 턴 색인에 실린다.
///
/// 플러그인 도구는 상류가 설명을 주지만 이 넷은 하네스 것이라 우리가 적는다. [`KEPT_TOOLS`]
/// 와 나란히 두는 이유는 하나가 늘고 다른 하나가 안 늘면 색인에서 그 도구만 설명 없이
/// 나가기 때문이다 — 시험이 둘이 같은 이름을 들고 있는지 본다.
pub const KEPT_TOOL_DESCRIPTIONS: &[(&str, &str)] = &[
    (
        "bash",
        "Runs a shell command. Use it to find files or run commands.",
    ),
    ("read", "Reads one file."),
    (
        "write",
        "Writes content to one file. Overwrites the whole file.",
    ),
    (
        "edit",
        "Finds and replaces part of a file. Does not rewrite the whole file.",
    ),
    (
        "webfetch",
        "Fetches the content of a URL. Use it when you know the address.",
    ),
];

/// 파일을 바꿀 수 있는 작업 공간 도구.
///
/// `bash` 가 여기 있는 이유: 셸은 그 자체로 파일을 쓴다. 읽기 전용이라면서 셸을 열어 두면
/// 그 이름이 거짓이 된다 — 이름이 사실을 말해야 한다는 규칙은 프롬프트뿐 아니라 모드
/// 이름에도 걸린다.
const WRITING_TOOLS: &[&str] = &["write", "edit", "bash"];

/// 파일을 바꿀 수 있는 작업 공간 도구의 이름. 계획 가드가 "제목은 고친다는데 도구는 읽기만
/// 한다"를 되물을 때 **목록에서 읽어** 쓴다(`plan::writing_intent_mismatch`). 프롬프트가
/// 이름을 상수로 적으면 그 문장은 표면이 바뀌는 날 거짓이 된다.
pub(crate) fn writing_workspace_tools() -> &'static [&'static str] {
    WRITING_TOOLS
}

/// 파일을 바꿀 수 없는 작업 공간 도구의 이름(`read`·`webfetch`).
pub(crate) fn reading_workspace_tools() -> Vec<&'static str> {
    KEPT_TOOLS
        .iter()
        .copied()
        .filter(|name| !WRITING_TOOLS.contains(name))
        .collect()
}

/// 이 채팅의 계획이 고를 수 있는 작업 공간 도구와 설명.
///
/// **읽기 전용 모드에서 좁히는 자리는 여기 하나다.** 돌려주는 목록이 계획 턴의 색인
/// 글(사람이 읽는 것)과 `ToolCatalog`(서버가 집행하는 것)를 **둘 다** 만들기 때문에,
/// 여기서 빼면 모델에게 보이지도 않고 적어도 거절된다. 프롬프트로만 막으면 모델이
/// 넘어간다 — 오늘 여러 번 본 자리다.
///
/// 공유 설정 파일(`~/.config/opencode/opencode.json`)에서 거르지 않는 이유: 그 파일은
/// 채팅들이 나눠 쓰고 채팅 시작마다 덮어쓴다. 모드마다 내용이 달라지면 모드가 다른 채팅
/// 둘이 서로의 에이전트 항을 망가뜨린다. 카탈로그는 채팅마다 따로라 그 문제가 없다.
///
/// `webfetch` 는 읽기 전용에서도 연다. 유출을 막으려면 `bash` 도 닫아야 하는데 그건 이미
/// 닫혀 있고, 그래도 진짜 차단은 프로세스 수준이라 도구 하나를 닫아 흉내 내지 않는다
/// (2026-09-25 결정 — 없는 울타리를 세우지 않는다). 모드 이름은 쓰기 범위를 말한다.
/// 플러그인 카탈로그(JSON)에서 색인에 실을 (이름, 설명). 읽기 전용이면 상류가
/// `readOnly` 라고 밝힌 도구만 남긴다 — 이름이 "읽기 전용"인데 notion-create-pages 가
/// 색인에 있으면 계획이 그것을 고르고 그 단계는 서버에서 거절된다(9.14).
pub(crate) fn plugin_tools_from_catalog(catalog: &Value, read_only: bool) -> Vec<(String, String)> {
    catalog
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    if read_only && tool.get("readOnly").and_then(Value::as_bool) != Some(true) {
                        return None;
                    }
                    let name = tool.get("name")?.as_str()?.to_owned();
                    let description = tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    Some((name, description))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn workspace_tool_descriptions(read_only: bool) -> Vec<(&'static str, &'static str)> {
    KEPT_TOOL_DESCRIPTIONS
        .iter()
        .filter(|(name, _)| !read_only || !WRITING_TOOLS.contains(name))
        .copied()
        .collect()
}

/// 끌 도구. 켤 것만 적으면 하네스가 나중에 더한 도구가 기본 켜짐으로 새로 들어온다.
/// 아는 이름을 명시로 끄고, 목록이 어긋나면 이 상수를 고친다.
/// 이 목록은 **하네스가 실제로 여는 것 가운데** 우리가 닫는 것이다. 하네스 레지스트리에는
/// `apply_patch`·`batch`·`list`·`lsp`·`websearch` 도 있지만 기본 묶음에 실려 오지 않는다 —
/// 2026-09-25 실측에서 두 레인 다 그 이름들을 보고하지 않았다. 없는 것을 닫는 줄은 적지
/// 않는다. 나중에 실려 오기 시작하면 같은 물음으로 드러나므로 그때 더한다.
///
/// `websearch` 는 **켜려고 해도 켜지지 않는다.** `true` 로 적고 재봤지만 표면은 다섯
/// 그대로였다. 하네스의 실행부가 `{ exa: enableExa, parallel: enableParallel }` 로 갈라져
/// `web_search_exa` 를 부른다 — 외부 검색 공급자를 붙여야 등록되는 도구다. 여기서 다시
/// 시도하지 말고, 검색이 필요하면 검색 MCP 를 플러그인 껍데기 뒤에 붙인다(도구 수가
/// 늘지 않는 길이다).
const DROPPED_TOOLS: &[&str] = &["glob", "grep", "skill", "task", "todowrite"];

/// 도구를 줄인 에이전트 정의. 모델은 여기 박지 않는다 — 세션마다 다를 수 있어
/// `session/set_config_option`으로 따로 준다.
fn agent_entry(plugin_shell: bool) -> Value {
    let mut tools = Map::new();
    for tool in KEPT_TOOLS {
        tools.insert((*tool).to_owned(), Value::Bool(true));
    }
    for tool in DROPPED_TOOLS {
        tools.insert((*tool).to_owned(), Value::Bool(false));
    }
    close_plugin_shell(&mut tools, plugin_shell);
    close_plan(&mut tools, true);
    // 시스템 MCP는 세션에 붙은 채로 있다. 여기서 끄지 않으면 작업 공간 묶음이 도구 셋이
    // 아니라 셋 더하기 시스템 도구 전부가 되어, 줄여서 얻은 것을 그대로 잃는다.
    tools.insert(system_mcp_tool_glob(), Value::Bool(false));
    serde_json::json!({
        "description": "Agent Manager가 로컬 모델에 쓰는 에이전트. 도구를 셋으로 줄였다.",
        // 못 하는 일을 적는 줄이 왜 필요한가: `webfetch`를 끈 채 "인터넷에서 찾아줘"를
        // 받으면 두 모델 모두 도구를 부르지 않고 그럴듯한 답을 지어냈고, 앱은 그것을
        // 정상 완료로 끝냈다(2026-09-25 회차, 코어 C). 앱은 답이 지어낸 것인지 알 수
        // 없으므로 화면에서 걸러낼 수 없다 — 열어 준 도구의 경계를 모델에게 미리 말해
        // 주는 것이 앱이 할 수 있는 유일한 자리다.
        "prompt": workspace_prompt(),
        "tools": Value::Object(tools),
    })
}

/// 껍데기 도구를 닫는다. 붙지 않은 실행에서는 적지 않는다 — 없는 서버의 열쇠를 남겨
/// 두면 설정을 읽는 사람이 그 서버가 붙는 줄 안다.
fn close_plugin_shell(tools: &mut Map<String, Value>, plugin_shell: bool) {
    if plugin_shell {
        tools.insert(plugin_shell_tool_glob(), Value::Bool(false));
    }
}

/// 계획 도구를 붙일 때 쓰는 이름. 하네스가 도구 이름 앞에 이 값을 붙인다.
pub const PLAN_SERVER_NAME: &str = "plan";

/// 계획 도구를 한 줄로 가리키는 열쇠.
fn plan_tool_glob() -> String {
    format!("{PLAN_SERVER_NAME}_*")
}

/// 계획 도구가 다른 묶음에 새지 않게 닫는다.
///
/// 새면 매 턴에 add_step·finish_plan·cannot_do 셋이 더 보인다. 도구를 단계 단위로 줄인
/// 것이 아니라 셋을 얹은 것이 되고, 실행 중인 단계에서 모델이 계획을 다시 세우려 든다.
fn close_plan(tools: &mut Map<String, Value>, plan: bool) {
    if plan {
        tools.insert(plan_tool_glob(), Value::Bool(false));
    }
}

/// 아무것도 열지 않은 도구 맵. 여기서 필요한 것만 켠다.
///
/// 켤 것만 적고 나머지를 기본값에 맡기지 않는 이유는 하네스 기본이 **켜짐**이기 때문이다
/// (`e.user.tools?.[i] !== false`). 아는 이름을 전부 명시로 끄고 시작한다.
fn closed_tools(plugin_shell: bool, plan: bool) -> Map<String, Value> {
    let mut tools = Map::new();
    for tool in KEPT_TOOLS.iter().chain(DROPPED_TOOLS.iter()) {
        tools.insert((*tool).to_owned(), Value::Bool(false));
    }
    tools.insert(system_mcp_tool_glob(), Value::Bool(false));
    close_plugin_shell(&mut tools, plugin_shell);
    close_plan(&mut tools, plan);
    tools
}

/// 계획 턴 에이전트. 계획 도구 셋만 열고 나머지를 전부 닫는다.
///
/// 색인(어떤 도구가 있는지)은 여기 적지 않는다 — 붙은 플러그인에 따라 달라지고, 그것을
/// 알려면 카탈로그를 받아와야 한다. 설정 파일은 채팅 시작 때 한 번 쓰이므로 그 자리에
/// 네트워크를 끼워 넣지 않는다. 색인은 계획 턴의 프롬프트에 실린다(조각 D).
/// 이 채팅만 쓰는 설정 파일 경로.
///
/// 공유 설정(`~/.config/opencode/opencode.json`)에 채팅마다 다른 내용을 쓰면 안 된다 —
/// 채팅 시작마다 덮어쓰므로 A 가 읽기 전에 B 가 갈아치우는 창이 생긴다. OpenCode 는
/// `OPENCODE_CONFIG` 로 **프로세스마다** 설정을 하나 더 얹어 주고 그것이 마지막에 병합된다
/// (2026-09-27 실측: 에이전트 항이 15개 → 16개로 늘고 기존 것이 그대로 남았다).
pub fn chat_config_path(app_data_dir: &Path, chat_id: &str) -> PathBuf {
    app_data_dir.join(format!("opencode-chat-{chat_id}.json"))
}

/// 계획 턴의 도구 색인을 **에이전트 프롬프트에** 실어 이 채팅만의 설정으로 쓴다.
///
/// 색인이 사용자 턴에 섞여 있으면 하네스가 그것을 요약해 제목을 짓는다 — 2026-09-27
/// ses_f218c2b06 에서 사용자가 "살아있니"라고 적었는데 제목이 "Notion 도구 목록 공유 및
/// 상태 확인"이 됐다. 기록도 사용자가 도구 목록을 붙여넣은 것처럼 남는다. 색인은 시스템
/// 맥락이지 사용자의 말이 아니다.
pub fn write_chat_config(
    path: &Path,
    index: &str,
    plugin_shell: bool,
    read_only: bool,
) -> Result<(), CoreError> {
    let mut agents = Map::new();
    for (id, entry) in [
        (DRAFT_AGENT_ID, draft_agent_entry(plugin_shell)),
        (PLAN_AGENT_ID, plan_agent_entry(plugin_shell)),
    ] {
        let mut entry = entry.as_object().cloned().unwrap_or_default();
        // 제품과 탐침이 같은 글을 보게 한다 — 계약 시험이 같은 함수를 내보낸다.
        entry.insert(
            "prompt".to_owned(),
            Value::String(crate::plan::plan_system_prompt_for(index, read_only)),
        );
        agents.insert(id.to_owned(), Value::Object(entry));
    }
    let body = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "agent": Value::Object(agents),
    });
    let text = serde_json::to_string_pretty(&body)
        .map_err(|error| CoreError::Runtime(format!("채팅 설정을 적지 못했습니다: {error}")))?;
    crate::app_data_file::write_private_bytes(path, text.as_bytes())
}

/// 채팅이 끝나면 그 설정 파일을 지운다. 없어도 조용히 지나간다.
pub fn remove_chat_config(path: &Path) {
    let _ = fs::remove_file(path);
}

/// 앱을 띄울 때 남아 있는 채팅별 설정 파일을 전부 지운다. 지운 수를 돌려준다.
///
/// 채팅이 끝날 때 지우지만(`remove_chat_config`) 앱이 강제 종료되면 그 자리를 지나지
/// 못해 파일이 남는다. 시작 시점에는 살아 있는 채팅이 없고, 이어받는 채팅도 스폰할 때
/// 제 파일을 새로 쓰므로 여기서 다 지워도 잃는 것이 없다(9.15 후속).
pub fn sweep_stale_chat_configs(app_data_dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(app_data_dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("opencode-chat-")
            && name.ends_with(".json")
            && fs::remove_file(entry.path()).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

fn draft_agent_entry(plugin_shell: bool) -> Value {
    let mut tools = closed_tools(plugin_shell, true);
    for schema in crate::plan::draft_planning_tool_schemas() {
        tools.insert(
            format!("plan_{}", schema["name"].as_str().expect("계획 도구 이름")),
            Value::Bool(true),
        );
    }
    serde_json::json!({ "description": "초안 작성용.", "prompt": PLAN_PROMPT, "tools": tools })
}

fn plan_agent_entry(plugin_shell: bool) -> Value {
    let mut tools = closed_tools(plugin_shell, true);
    tools.insert(plan_tool_glob(), Value::Bool(true));
    serde_json::json!({
        "description": "계획 턴용. 계획 도구 셋만 연다.",
        "prompt": PLAN_PROMPT,
        "tools": Value::Object(tools),
    })
}

/// 단계 하나를 도는 에이전트. 그 단계의 도구 **하나만** 연다.
///
/// 하네스에 턴별 도구 지정 수단이 없어서 이렇게 한다 — `setSessionConfigOption` 이 받는
/// `configId` 는 model·effort·mode 셋뿐이고, `mode` 는 `availableModes` 에 있는 것만
/// 받는다(2026-09-26 바이너리 확인). 그래서 쓸 항을 채팅 시작 때 미리 심어 두고 고른다.
///
/// 플러그인 도구는 여기로 가르지 않는다. 마흔다섯 개마다 항을 세우는 대신 껍데기 하나로
/// 보내고, 그 단계가 어느 플러그인 도구를 쓸 수 있는지는 껍데기가 호출마다 물어 서버에서
/// 집행한다(조각 E).
///
/// **`write` 단계만은 정확히 하나가 아니다.** 설정에 `write` 하나만 켜도 하네스가 `edit` 를
/// 함께 연다 — `edit` 는 `write` 를 따라다니고 우리 `false` 가 그것을 이기지 못한다
/// ([`KEPT_TOOLS`] 주석). 2026-09-26 실기기에서 `write` 단계의 도구 목록이
/// `edit, invalid, write` 로 나왔다. 해롭지는 않다(둘 다 파일을 고치는 일이다) —
/// 다만 "한 단계에 도구 하나"를 셀 때 이 자리를 빼고 세지 않는다.
fn step_agent_entry(tool: &str, plugin_shell: bool) -> Value {
    let mut tools = closed_tools(plugin_shell, true);
    tools.insert(tool.to_owned(), Value::Bool(true));
    serde_json::json!({
        "description": format!("계획 단계용. {tool} 하나만 연다."),
        "prompt": STEP_PROMPT,
        "tools": Value::Object(tools),
    })
}

/// 마무리 요약 에이전트. **도구를 하나도 열지 않는다.**
///
/// 요약은 글을 쓰는 일이지 무엇을 하는 일이 아니다. 도구가 하나라도 열려 있으면 모델이
/// 요약 대신 일을 더 하려 든다 — 계획 도구가 열려 있으면 단계를 더 세우고, 작업 공간
/// 도구가 열려 있으면 파일을 다시 읽는다.
fn summary_agent_entry(plugin_shell: bool) -> Value {
    serde_json::json!({
        "description": "마무리 요약용. 도구를 열지 않는다.",
        "prompt": SUMMARY_PROMPT,
        "tools": Value::Object(closed_tools(plugin_shell, true)),
    })
}

/// 껍데기만 여는 에이전트.
///
/// 플러그인이 몇 개든 도구는 `find_tool`·`call_tool` 둘이다. 원본 서버를 붙이던 때는
/// 플러그인마다 에이전트를 세우고 정책이 제한한 도구를 이름으로 꺼야 했는데, 껍데기는
/// 그 정책을 호출 시점에 프록시가 보므로 여기서 도구를 고를 일이 없다.
fn plugins_agent_entry() -> Value {
    let mut tools = Map::new();
    for tool in KEPT_TOOLS.iter().chain(DROPPED_TOOLS.iter()) {
        tools.insert((*tool).to_owned(), Value::Bool(false));
    }
    tools.insert(system_mcp_tool_glob(), Value::Bool(false));
    tools.insert(plugin_shell_tool_glob(), Value::Bool(true));
    close_plan(&mut tools, true);
    serde_json::json!({
        "description": "외부 플러그인 조작용. 껍데기 도구만 연다.",
        "prompt": PLUGINS_PROMPT,
        "tools": Value::Object(tools),
    })
}

/// 이 실행에 열어 둘 도구 묶음.
///
/// 로컬 모델은 도구가 많으면 호출 자체를 못 한다. 같은 모델·같은 과제에서 26개는 없는
/// 이름을 지어냈고, 10개는 코드블록을 뱉었고, 3개로 줄이자 실제로 호출했다(2026-09-24).
/// 그래서 시스템 MCP를 붙이더라도 한 번에 다 열지 않고 필요한 묶음만 연다.
///
/// 고르는 일은 모델에게 묻지 않고 우리가 한다. 물으면 왕복이 한 번 더 늘고(CPU 레인은 한
/// 턴이 분 단위다), 그 판단을 또 틀릴 여지가 생긴다. 사용자 발화에 드러난 낱말로 가른다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolGroup {
    /// 셸과 파일. 기본값이다.
    Workspace,
    /// Agent Manager 조작. 시스템 MCP가 붙었을 때만 고를 수 있다.
    System,
    /// 외부 플러그인. 껍데기가 이 실행에 붙었을 때만 고를 수 있다.
    Plugins,
}

/// 시스템 묶음을 고르게 하는 낱말. 사용자가 앱 자체를 다루려 할 때 쓰는 말들이다.
const SYSTEM_HINTS: &[&str] = &[
    "agent manager",
    "에이전트 매니저",
    "에이전트매니저",
    "설정",
    "스킬",
    "워크플로",
    "반복 요청",
    "페이싱",
    "공급자",
    "계정",
    "사용량",
    "세션 목록",
    "알림",
    "애드온",
    "ssh",
    "데이터베이스",
    "cypress",
    "mcp",
    "플러그인",
];

/// 브랜드별 한글 표기 씨앗. 등록 때 플러그인의 다른 이름 목록을 미리 채우는 데만 쓰고
/// (`seed_names`), 계획 색인·라우터 힌트는 저장된 목록을 읽는다(9.12). 사용자는 "Notion"
/// 이라 적기도 하고 "노션"이라 적기도 하는데, 뒤쪽은 플러그인 id 어디에도 없다.
const PLUGIN_ALIASES: &[(&str, &[&str])] = &[
    ("notion", &["노션"]),
    ("github", &["깃허브", "깃헙"]),
    ("figma", &["피그마"]),
    ("gmail", &["지메일"]),
    ("google", &["구글"]),
    ("drive", &["드라이브"]),
    ("calendar", &["캘린더"]),
    ("atlassian", &["아틀라시안"]),
    ("jira", &["지라"]),
    ("confluence", &["컨플루언스"]),
    ("slack", &["슬랙"]),
    ("vercel", &["버셀"]),
];

/// 계획 색인의 플러그인 칸 라벨. `id · 이름 · 이름` 꼴이고 id 와 같은 이름은 적지 않는다.
///
/// 이름은 플러그인마다 등록 데이터로 둔 목록이다(9.12) — 사람은 "노션에 정리해줘"라고
/// 적는데 도구 이름은 notion-create-pages 라, 영문 id 만 있으면 계획이 "정리해서 저장"을
/// write(파일)로 읽는다. 어떤 말이 이 플러그인을 가리키는지는 코드가 아니라 사용자가
/// 정한다. 목록이 비면 id 만 적힌다.
pub fn plugin_label(id: &str, names: &[String]) -> String {
    let mut parts: Vec<&str> = vec![id];
    for name in names {
        let name = name.trim();
        if name.is_empty() || parts.iter().any(|part| part.eq_ignore_ascii_case(name)) {
            continue;
        }
        parts.push(name);
    }
    parts.join(" · ")
}

/// 등록 때 다른 이름을 미리 채워 주는 씨앗. 프리셋 밖에서 등록해도 id 나 표시 이름에
/// 브랜드가 드러나면 한글 표기를 붙여 준다. 계획·힌트 경로는 이것을 보지 않고 저장된
/// 이름 목록만 본다 — 사용자가 고친 결과가 곧 어휘다.
pub fn seed_names(id: &str, display_name: &str) -> Vec<String> {
    let haystack = format!("{id} {display_name}").to_lowercase();
    let mut names: Vec<String> = Vec::new();
    for (latin, aliases) in PLUGIN_ALIASES {
        if !haystack.contains(latin) {
            continue;
        }
        for alias in *aliases {
            if !names.iter().any(|known| known == alias) {
                names.push((*alias).to_owned());
            }
        }
    }
    names
}

/// 낱말로 쓰기에 너무 흔한 조각. 플러그인 이름을 쪼개면 이런 것들이 섞여 나오는데,
/// 힌트로 두면 앱과 무관한 발화까지 시스템 묶음으로 끌고 간다.
const TOO_GENERIC: &[&str] = &[
    "mcp",
    "server",
    "servers",
    "tool",
    "tools",
    "api",
    "app",
    "local",
    "remote",
    "plugin",
    "hosted",
    "official",
    "workspace",
];

/// 지금 등록된 외부 플러그인에서 뽑은 힌트 낱말.
///
/// [`SYSTEM_HINTS`]는 사람이 적는 목록이라 플러그인이 늘 때마다 뒤처진다. 플러그인 id와
/// 다른 이름들을 쪼개 실행 시점에 더하면 그 뒤처짐이 없어진다 — "notion-team"은 notion과
/// team을 내놓고, 이름 목록의 "노션"은 그대로 힌트가 된다(9.12).
pub fn plugin_hints<'a>(names: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut hints: Vec<String> = Vec::new();
    for name in names {
        for token in name.split(|c: char| !c.is_alphanumeric()) {
            let token = token.to_lowercase();
            if token.len() < 3 || TOO_GENERIC.contains(&token.as_str()) {
                continue;
            }
            hints.push(token);
        }
    }
    hints.sort();
    hints.dedup();
    hints
}

/// 발화에 드러난 낱말로 묶음을 고른다.
///
/// 애매하면 작업 공간이다. 시스템 묶음은 앱 설정을 바꾸는 도구를 들고 있어, 잘못 열면
/// 사용자가 시키지 않은 변경이 승인 카드로 쏟아진다. 덜 여는 쪽이 안전하다.
pub fn tool_group_for(prompt: &str, system_available: bool, plugin_hints: &[String]) -> ToolGroup {
    if !system_available {
        return ToolGroup::Workspace;
    }
    let lowered = prompt.to_lowercase();
    let hit = SYSTEM_HINTS.iter().any(|hint| lowered.contains(hint))
        || plugin_hints
            .iter()
            .any(|hint| lowered.contains(hint.as_str()));
    if hit {
        ToolGroup::System
    } else {
        ToolGroup::Workspace
    }
}

/// 묶음에 해당하는 에이전트 이름.
pub fn agent_for(group: &ToolGroup) -> String {
    match group {
        ToolGroup::Workspace => AGENT_ID.to_owned(),
        ToolGroup::System => SYSTEM_AGENT_ID.to_owned(),
        ToolGroup::Plugins => PLUGINS_AGENT_ID.to_owned(),
    }
}

/// 발화가 등록된 플러그인을 가리키는가.
///
/// 어느 플러그인인지는 묻지 않는다 — 껍데기가 붙은 플러그인 전부를 한 자리에서 들고
/// 있으므로, 고를 것은 "플러그인 일인가 아닌가" 하나뿐이다.
pub fn names_a_plugin(prompt: &str, plugin_hints: &[String]) -> bool {
    let lowered = prompt.to_lowercase();
    plugin_hints
        .iter()
        .any(|hint| lowered.contains(hint.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 설명표와 도구 목록이 같은 이름을 들고 있다.
    ///
    /// 하나가 늘고 다른 하나가 안 늘면 색인에서 그 도구만 설명 없이 나간다 — 설명 없는
    /// 이름만 보고는 계획이 무엇을 고르는지 알 수 없다(2026-09-26 실측에서 실제로 그렇게
    /// 빈 자리가 나왔다).
    // 9.14: 읽기 전용 채팅의 설정 파일은 두 계획 에이전트 항 모두에 출구 문장을 싣는다.
    #[test]
    fn read_only_chat_config_puts_the_exit_clause_in_both_plan_agents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("opencode-chat-ro.json");
        write_chat_config(&path, "- read: Reads one file.", true, true).expect("쓰기");
        let body: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        for id in [DRAFT_AGENT_ID, PLAN_AGENT_ID] {
            let prompt = body["agent"][id]["prompt"].as_str().expect("prompt");
            assert!(
                prompt.contains(crate::plan::READ_ONLY_CLAUSE),
                "{id}: {prompt}"
            );
            assert!(prompt.ends_with("- read: Reads one file."), "{id}");
        }
        write_chat_config(&path, "- read: Reads one file.", true, false).expect("쓰기");
        let body: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(!body["agent"][PLAN_AGENT_ID]["prompt"]
            .as_str()
            .unwrap()
            .contains(crate::plan::READ_ONLY_CLAUSE));
    }

    #[test]
    fn startup_sweep_removes_only_per_chat_config_files() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join("opencode-chat-abc.json");
        let other = dir.path().join("opencode-chat-def.json");
        let keep = dir.path().join("settings.json");
        for path in [&stale, &other, &keep] {
            fs::write(path, b"{}").unwrap();
        }
        assert_eq!(sweep_stale_chat_configs(dir.path()), 2);
        assert!(!stale.exists() && !other.exists());
        assert!(keep.exists());
        assert_eq!(sweep_stale_chat_configs(dir.path()), 0);
        assert_eq!(sweep_stale_chat_configs(&dir.path().join("missing")), 0);
    }

    #[test]
    fn every_open_tool_has_a_line_for_the_index() {
        let described: Vec<&str> = KEPT_TOOL_DESCRIPTIONS
            .iter()
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(described, KEPT_TOOLS.to_vec());
        for (name, description) in KEPT_TOOL_DESCRIPTIONS {
            assert!(!description.trim().is_empty(), "{name} 설명이 비었다");
        }
    }

    /// 단계의 도구가 어느 에이전트로 가는지.
    ///
    /// 플러그인 도구가 전부 껍데기 하나로 가는 것이 이 설계의 요점이다. 도구 하나당 항을
    /// 세우면 노션만 마흔다섯이라 설정이 그만큼 불어난다.
    /// 시스템 도구도 계획이 고를 수 있어야 한다. 색인에 싣는 이름과 그 이름이 가는
    /// 에이전트가 **같은 자리에서** 맞아야, 계획이 고른 도구가 실제로 열린다.
    ///
    /// 2026-09-27: 반복 실행에 시스템 도구를 열었는데(82a4944e) 로컬은 계획 경로의 네
    /// 에이전트가 전부 닫아 모델이 그 도구를 한 번도 보지 못했다.
    #[test]
    fn a_system_tool_goes_to_the_system_entry_and_is_in_the_index() {
        for (name, description) in system_tool_descriptions(false) {
            assert_eq!(step_agent_for(&name), SYSTEM_AGENT_ID, "{name}");
            assert!(!description.trim().is_empty(), "{name}");
        }
        // 작업 이름을 색인에 적지 않는다 — 카탈로그와 두 벌이 되면 언젠가 거짓이 된다.
        let names: Vec<String> = system_tool_descriptions(false)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names.len(), 3, "{names:?}");
        // 읽기 전용이면 바꾸는 도구가 빠진다 — 파일 쓰기만 막고 설정 변경을 열어 두면
        // 모드 이름이 거짓이 된다.
        let read_only: Vec<String> = system_tool_descriptions(true)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(read_only.len(), 2, "{read_only:?}");
        assert!(
            read_only
                .iter()
                .all(|name| !name.ends_with("system_execute")),
            "{read_only:?}"
        );
        assert!(
            names.iter().all(|name| is_system_mcp_tool(name)),
            "{names:?}"
        );

        // 그 에이전트가 실제로 그 도구를 연다. 색인만 늘리고 열지 않으면 계획이 고른
        // 단계가 아무것도 못 하고 실패한다.
        let entry = system_agent_entry(false);
        assert_eq!(entry["tools"][system_mcp_tool_glob()], true, "{entry}");
    }

    #[test]
    fn a_plugin_tool_goes_to_the_shell_and_a_workspace_tool_to_its_own_entry() {
        assert_eq!(step_agent_for("bash"), step_agent_id("bash"));
        assert_eq!(step_agent_for("webfetch"), step_agent_id("webfetch"));
        assert_eq!(step_agent_for("notion-create-pages"), PLUGINS_AGENT_ID);
        // 모르는 이름도 껍데기로 보낸다 — 거기서 "그런 도구 없다"가 나오는 편이,
        // 없는 에이전트 이름으로 set_agent 해 세션이 거절당하는 것보다 고치기 쉽다.
        assert_eq!(step_agent_for("무엇이든"), PLUGINS_AGENT_ID);
    }

    /// 플러그인 id 에서 한글 표기를 찾아낸다. 색인에 함께 적어 "노션"이 도구에 닿게 한다.
    /// 계획·단계 항이 다 심기고, 각 묶음이 자기 것만 연다.
    ///
    /// `mode`는 `availableModes`에 있는 것만 받고 그 목록은 세션이 열릴 때 굳는다
    /// (2026-09-26 하네스 확인) — 그래서 쓸 수도 있는 항을 채팅 시작 때 다 심어야 한다.
    /// 도중에 더해도 늦다.
    #[test]
    fn every_group_gets_its_own_entry_and_opens_only_its_own_tools() {
        let merged = merged(
            &Value::Null,
            &connection("http://x/v1", true),
            &[],
            None,
            true,
        );
        let agents = merged["agent"].as_object().expect("에이전트 맵");

        let mut names: Vec<&str> = agents.keys().map(String::as_str).collect();
        names.sort_unstable();
        let mut expected = vec![
            AGENT_ID,
            SYSTEM_AGENT_ID,
            PLUGINS_AGENT_ID,
            PLAN_AGENT_ID,
            DRAFT_AGENT_ID,
            SUMMARY_AGENT_ID,
        ];
        let step_ids: Vec<String> = KEPT_TOOLS.iter().map(|tool| step_agent_id(tool)).collect();
        expected.extend(step_ids.iter().map(String::as_str));
        expected.sort_unstable();
        assert_eq!(names, expected);

        // 계획 묶음은 계획 도구만. 작업 공간 도구도 껍데기도 닫혀 있다.
        let plan = &agents[PLAN_AGENT_ID]["tools"];
        assert_eq!(plan["plan_*"], true);
        assert_eq!(plan["bash"], false);
        assert_eq!(plan["plugins_*"], false);
        assert_eq!(plan["agent-manager_*"], false);

        // 요약 묶음은 아무것도 열지 않는다. 하나라도 열려 있으면 요약 대신 일을 더 한다.
        let summary = agents[SUMMARY_AGENT_ID]["tools"]
            .as_object()
            .expect("도구 맵");
        assert!(
            summary.values().all(|open| open == &Value::Bool(false)),
            "{summary:?}"
        );

        // 단계 묶음은 그 도구 하나만.
        for tool in KEPT_TOOLS {
            let entry = &agents[&step_agent_id(tool)]["tools"];
            assert_eq!(entry[*tool], true, "{tool}");
            assert_eq!(entry["plan_*"], false, "{tool}");
            for other in KEPT_TOOLS.iter().filter(|other| *other != tool) {
                assert_eq!(entry[*other], false, "{tool} 묶음에 {other} 가 열려 있다");
            }
        }
    }

    // 2026-09-26 ses_f23842cd6, round4 GPU with-insert 16회차: 거절된 삽입 뒤 노션 누락.
    #[test]
    fn draft_surface_excludes_insert_but_running_replan_keeps_it() {
        use crate::plan::{PlanDraft, PlanSlot, ToolCatalog};
        for plugin_shell in [false, true] {
            let draft = draft_agent_entry(plugin_shell);
            let tools = draft["tools"].as_object().unwrap();
            let open: Vec<_> = tools
                .iter()
                .filter(|(_, value)| **value == Value::Bool(true))
                .map(|(name, _)| name.as_str())
                .collect();
            assert_eq!(
                open,
                [
                    "plan_add_step",
                    "plan_answer_now",
                    "plan_cannot_do",
                    "plan_finish_plan"
                ]
            );
            assert_eq!(tools["plan_*"], false);
            assert_eq!(plan_agent_entry(plugin_shell)["tools"]["plan_*"], true);
        }
        let mut slot = PlanSlot::Drafting(PlanDraft::new(ToolCatalog::new([
            "webfetch",
            "notion-create-pages",
        ])));
        assert_eq!(planning_agent_id(&slot), DRAFT_AGENT_ID);
        slot.drafting()
            .unwrap()
            .add_step(
                "React 공식 사이트에서 최신 안정 버전 정보 검색하기",
                &["webfetch".into()],
                &[],
            )
            .unwrap();
        assert!(slot
            .insert_step(
                Some(1),
                "검색한 React 버전 정보를 정리하여 노션 페이지에 저장하기",
                &["notion-create-pages".into()]
            )
            .is_err());
        // 되묻기에서도 초안 표면을 유지하고, 확정 뒤에는 기존 삽입 동작이 열린다.
        assert_eq!(planning_agent_id(&slot), DRAFT_AGENT_ID);
        slot.finish().unwrap();
        assert_eq!(planning_agent_id(&slot), PLAN_AGENT_ID);
        slot.insert_step(
            Some(1),
            "검색한 React 버전 정보를 정리하여 노션 페이지에 저장하기",
            &["notion-create-pages".into()],
        )
        .unwrap();
    }

    /// 계획 도구가 다른 묶음에 새지 않는다.
    ///
    /// 새면 매 턴에 셋이 더 보인다 — 도구를 단계 단위로 줄인 것이 아니라 셋을 얹은 것이
    /// 되고, 실행 중인 단계에서 모델이 계획을 다시 세우려 든다. 오늘 이미 같은 모양의
    /// 누수를 한 번 찾았다(edit).
    #[test]
    fn the_planning_tools_do_not_leak_into_the_working_groups() {
        for entry in [
            agent_entry(true),
            system_agent_entry(true),
            plugins_agent_entry(),
        ] {
            assert_eq!(entry["tools"]["plan_*"], false, "{entry}");
        }
    }

    /// 창은 모델마다 적힌다. 연결 값 하나를 모두에게 적으면 한쪽에 거짓이 된다.
    ///
    /// 2026-09-26 실측: 같은 서버에 gpt-oss-cpu-low(16,384)와 qwen3.5-gpu-128k(131,072)가
    /// 함께 있다. 큰 쪽을 작은 모델에 적으면 하네스가 영영 압축하지 않아 값을 비워 두는
    /// 것보다 나쁘다 — 실제로 한 번 그렇게 적혔다.
    #[test]
    fn each_model_carries_its_own_window() {
        let merged = merged(
            &Value::Null,
            &connection("http://x/v1", true),
            &[
                LocalModel {
                    name: "small".to_owned(),
                    context_window: Some(16_384),
                },
                LocalModel {
                    name: "big".to_owned(),
                    context_window: Some(131_072),
                },
                model("unknown"),
            ],
            None,
            false,
        );
        let models = &merged["provider"][PROVIDER_ID]["models"];
        assert_eq!(models["small"]["limit"]["context"], 16_384);
        assert_eq!(models["big"]["limit"]["context"], 131_072);
        // 알아내지 못한 모델은 비워 둔다. 추측한 크기는 없는 것보다 나쁘다.
        assert!(models["unknown"].get("limit").is_none(), "{models}");
    }

    /// 사람이 연결에 적어 둔 값은 모든 모델에 쓰고 알아낸 값을 덮는다.
    ///
    /// 연결 설정에 적는 것은 "이 서버는 이만큼이다"라는 사람의 말이다. 우리가 알아낸
    /// 값으로 그것을 뒤집지 않는다.
    #[test]
    fn a_window_written_by_hand_wins_over_the_probed_one() {
        let mut connection = connection("http://x/v1", true);
        connection.connection.context_window = Some(32_768);
        let merged = merged(
            &Value::Null,
            &connection,
            &[LocalModel {
                name: "small".to_owned(),
                context_window: Some(16_384),
            }],
            None,
            false,
        );
        assert_eq!(
            merged["provider"][PROVIDER_ID]["models"]["small"]["limit"]["context"],
            32_768
        );
    }

    /// 목록은 실기기에서 확인한 표면과 같아야 한다.
    ///
    /// 2026-09-25 두 레인에게 "네게 주어진 도구를 전부 나열해라"라고 물어 받은 답이
    /// 읽기 전용 모드는 **색인과 카탈로그를 같은 목록에서** 좁힌다. 프롬프트로만 막으면
    /// 모델이 넘어가므로(2026-09-26 에 여러 번 확인), 돌려주는 이 목록이 사람이 읽는 글과
    /// 서버가 집행하는 목록을 둘 다 만드는 것이 이 함수의 요점이다.
    /// 채팅별 설정 파일에는 계획·초안 항만 들어가고, 색인이 그 프롬프트에 실린다.
    /// OpenCode 가 마지막에 깊게 병합하므로(2026-09-27 실측) 이 둘만 적어도 공유 설정의
    /// 나머지 항은 그대로 남는다.
    #[test]
    fn the_per_chat_config_carries_the_index_in_the_plan_prompts() {
        let dir = tempfile::tempdir().expect("임시 폴더");
        let path = chat_config_path(dir.path(), "chat-1");
        write_chat_config(&path, "- webfetch: URL 을 가져온다.", true, false).expect("쓰기");

        let text = fs::read_to_string(&path).expect("읽기");
        let body: Value = serde_json::from_str(&text).expect("JSON");
        let agents = body["agent"].as_object().expect("agent 항");
        assert_eq!(agents.len(), 2, "{text}");
        for id in [DRAFT_AGENT_ID, PLAN_AGENT_ID] {
            let prompt = agents[id]["prompt"].as_str().expect("prompt");
            assert!(prompt.starts_with(PLAN_PROMPT), "{id}: {prompt}");
            assert!(
                prompt.contains("- webfetch: URL 을 가져온다."),
                "{id}: {prompt}"
            );
        }
        // 계획 도구는 열려 있고 작업 공간 도구는 닫혀 있다 — 색인만 옮겼지 표면은 그대로다.
        assert_eq!(agents[PLAN_AGENT_ID]["tools"][plan_tool_glob()], true);
        assert_eq!(agents[PLAN_AGENT_ID]["tools"]["bash"], false);

        remove_chat_config(&path);
        assert!(!path.exists(), "지운 뒤에도 남았다");
        // 없는 파일을 지워도 조용하다.
        remove_chat_config(&path);
    }

    // 9.14: 읽기 전용 모드의 플러그인 칸은 상류 readOnly 주석으로 거른다.
    // 9.12: 라벨은 id 와 저장된 이름 목록에서만 나온다. 사전은 등록 때 씨앗일 뿐이다.
    #[test]
    fn plugin_label_joins_id_and_names_without_repeats() {
        let names = |list: &[&str]| list.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            plugin_label("notion-team", &names(&["노션"])),
            "notion-team · 노션"
        );
        assert_eq!(plugin_label("notion-team", &names(&[])), "notion-team");
        assert_eq!(
            plugin_label(
                "linear-main",
                &names(&["리니어", " Linear ", "linear-main", ""])
            ),
            "linear-main · 리니어 · Linear"
        );
    }

    #[test]
    fn seed_names_come_from_the_brand_in_the_id_or_display_name() {
        assert_eq!(seed_names("notion-team", "notion-team"), vec!["노션"]);
        assert_eq!(
            seed_names("team-wiki", "Confluence wiki"),
            vec!["컨플루언스"]
        );
        assert_eq!(seed_names("github", "GitHub"), vec!["깃허브", "깃헙"]);
        assert!(seed_names("brave-search", "brave-search").is_empty());
    }

    #[test]
    fn read_only_mode_keeps_only_plugin_tools_marked_read_only() {
        let catalog = serde_json::json!({"tools": [
            {"name": "notion-search", "description": "Search.", "readOnly": true},
            {"name": "notion-create-pages", "description": "Create.", "readOnly": false},
            {"name": "notion-fetch", "description": "Fetch."}
        ]});
        let all: Vec<String> = plugin_tools_from_catalog(&catalog, false)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(
            all,
            ["notion-search", "notion-create-pages", "notion-fetch"]
        );
        let read_only: Vec<String> = plugin_tools_from_catalog(&catalog, true)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(read_only, ["notion-search"], "주석 없는 도구도 쓰기로 본다");
        assert!(plugin_tools_from_catalog(&serde_json::json!({}), true).is_empty());
    }

    #[test]
    fn read_only_mode_hides_every_tool_that_can_write() {
        let open: Vec<&str> = workspace_tool_descriptions(true)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(open, vec!["read", "webfetch"]);
        for tool in WRITING_TOOLS {
            assert!(!open.contains(tool), "{tool} 가 읽기 전용에 남았다");
        }

        // 읽기 전용이 아니면 예전 그대로다 — 이 변경으로 다른 모드가 좁아지지 않는다.
        let all: Vec<&str> = workspace_tool_descriptions(false)
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        let kept: Vec<&str> = KEPT_TOOL_DESCRIPTIONS
            .iter()
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(all, kept);
    }

    /// 좁힌 목록이 KEPT_TOOLS 밖으로 나가지 않는다. 설명만 있고 하네스가 모르는 이름을
    /// 색인에 실으면 계획이 부를 수 없는 도구를 고른다.
    #[test]
    fn the_narrowed_list_stays_inside_the_kept_tools() {
        for read_only in [true, false] {
            for (name, _) in workspace_tool_descriptions(read_only) {
                assert!(KEPT_TOOLS.contains(&name), "{name} 이 KEPT_TOOLS 에 없다");
            }
        }
    }

    /// `bash · edit · read · webfetch · write` 였다(GPU qwen3.5-gpu-128k, CPU
    /// gpt-oss-cpu-low, 둘이 일치). 그때 설정에는 `"edit": false` 가 적혀 있었다 —
    /// 우리가 닫았다고 믿던 것이 열려 있었다.
    ///
    /// 대조군이 설정 자체는 먹는다는 것을 말해 준다. 같은 물음을 플러그인 묶음에 던지면
    /// `plugins_find_tool · plugins_call_tool` 둘뿐이고, 그 묶음은 `write` 도 닫는다.
    /// 그래서 `edit` 는 `write` 를 따라다닌다고 읽었다.
    ///
    /// 이 시험은 그 읽기를 고정한다. `write` 를 여는 한 `edit` 도 열린 것으로 적어야
    /// 한다 — 닫지 못하는 것을 닫았다고 적으면 도구 수를 세는 모든 판단이 틀어진다.
    #[test]
    fn edit_is_listed_as_open_wherever_write_is() {
        assert!(
            !KEPT_TOOLS.contains(&"write") || KEPT_TOOLS.contains(&"edit"),
            "write 를 열면서 edit 를 닫았다고 적었다: {KEPT_TOOLS:?}"
        );
        // 반대쪽도 고정한다. `write` 를 닫는 묶음에서는 실제로 `edit` 가 사라졌다.
        let plugins = plugins_agent_entry();
        for tool in ["write", "edit", "bash", "read", "webfetch"] {
            assert_eq!(plugins["tools"][tool], false, "{tool}");
        }
    }

    /// 실기기가 보고한 이름과 우리 목록이 정확히 같은지.
    ///
    /// 하네스 레지스트리에는 `apply_patch`·`batch`·`list`·`lsp`·`websearch` 도 있지만
    /// 기본 묶음에 실려 오지 않는다 — 같은 실측에서 두 레인 다 그 이름을 보고하지 않았다.
    /// 없는 것을 닫는 줄은 적지 않되, 실려 오기 시작하면 이 시험의 기대값이 먼저 어긋난다.
    #[test]
    fn the_workspace_surface_matches_what_the_models_reported() {
        // 기대 이름만 훑으면 **더한 것**을 못 잡는다. 실제로 websearch 를 더해 재보는
        // 동안 이 시험이 조용히 통과했다(코드 리뷰에서 잡음). 그래서 켜진 것 전부를
        // 세어 목록과 맞춘다 — MCP 묶음 열쇠(`서버_*`)는 도구 하나가 아니라 묶음이라 뺀다.
        let entry = agent_entry(false);
        let tools = entry["tools"].as_object().expect("도구 맵");
        let mut open: Vec<&str> = tools
            .iter()
            .filter(|(name, value)| **value == Value::Bool(true) && !name.ends_with('*'))
            .map(|(name, _)| name.as_str())
            .collect();
        open.sort_unstable();
        assert_eq!(
            open,
            vec!["bash", "edit", "read", "webfetch", "write"],
            "실기기가 보고한 표면과 다르다. 도구를 더했으면 두 레인에서 먼저 재고 이 줄을 같이 고친다"
        );
    }

    /// 웹이 닫힌 묶음은 경계를 먼저 말한다.
    ///
    /// 웹 도구 없이 인터넷이 필요한 요청을 받으면 로컬 모델은 도구를 부르지 않고 답을
    /// 지어내고, 앱은 그것이 지어낸 것인지 알 수 없어 정상 완료로 끝낸다(2026-09-25 로컬
    /// LLM QA 회차 코어 C). 경계를 미리 말해 주는 이 줄이 앱이 쥔 유일한 손잡이다.
    ///
    /// 이제 그 줄은 시스템 묶음의 것이다 — 작업 공간 묶음은 `webfetch` 를 쥐었으므로
    /// 같은 줄이 거기서는 거짓이 된다.
    #[test]
    fn a_group_without_a_web_tool_says_so_first() {
        let entry = system_agent_entry(false);
        let prompt = entry["prompt"].as_str().expect("프롬프트 문자열");
        assert_eq!(entry["tools"]["webfetch"], false, "{entry}");
        assert!(
            prompt.contains("웹을 조회하는 도구는 없다"),
            "프롬프트: {prompt}"
        );
        assert!(
            prompt.contains("조회할 수 없다고 답해라"),
            "프롬프트: {prompt}"
        );
    }

    /// 시험용 모델 하나. 창은 연결 값이나 여기서 준다.
    fn model(name: &str) -> LocalModel {
        LocalModel {
            name: name.to_owned(),
            context_window: None,
        }
    }

    fn connection(base_url: &str, enabled: bool) -> LocalLlmConnectionEntry {
        connection_with_id(DEFAULT_CONNECTION_ID, "기본 연결", base_url, enabled)
    }

    fn connection_with_id(
        id: &str,
        label: &str,
        base_url: &str,
        enabled: bool,
    ) -> LocalLlmConnectionEntry {
        LocalLlmConnectionEntry {
            id: id.to_owned(),
            label: label.to_owned(),
            connection: crate::local_llm::LocalLlmConnection {
                base_url: base_url.to_owned(),
                default_model: "qwen3.5-gpu".to_owned(),
                context_window: None,
                api_key_configured: false,
                enabled,
                plan_steps: true,
            },
            model_windows: Default::default(),
        }
    }

    // M7 7.2: 연결마다 항이 하나씩이고, 서로의 항을 덮지 않는다.
    #[test]
    fn two_connections_keep_separate_entries_and_neither_overwrites_the_other() {
        let local = connection("http://127.0.0.1:11434/v1", true);
        let remote =
            connection_with_id("macbook", "맥북 ollama", "http://100.64.0.2:11434/v1", true);
        let after_local = merged(&Value::Null, &local, &[model("a")], None, false);
        let both = merged(&after_local, &remote, &[model("a")], Some("키"), false);
        assert_eq!(
            both["provider"][PROVIDER_ID]["options"]["baseURL"],
            "http://127.0.0.1:11434/v1"
        );
        assert_eq!(
            both["provider"]["agent-manager-local-macbook"]["options"]["baseURL"],
            "http://100.64.0.2:11434/v1"
        );
        assert_eq!(
            both["provider"]["agent-manager-local-macbook"]["options"]["apiKey"],
            "키"
        );
        assert!(both["provider"][PROVIDER_ID]["options"]
            .get("apiKey")
            .is_none());
        assert_eq!(
            both["provider"]["agent-manager-local-macbook"]["name"],
            "Agent Manager 로컬 LLM · 맥북 ollama"
        );
        // 같은 모델 이름이라도 공급자가 달라 한정 이름이 다르다.
        assert_ne!(
            qualified_model("default", "a"),
            qualified_model("macbook", "a")
        );
        assert_eq!(
            qualified_model("macbook", "a"),
            "agent-manager-local-macbook/a"
        );
        // 한쪽을 다시 심어도 다른 쪽은 그대로다. 한쪽을 꺼도 에이전트 항은 남는다.
        let again = merged(&both, &local, &[model("b")], None, false);
        assert!(again["provider"]["agent-manager-local-macbook"]["models"]["a"].is_object());
        assert!(again["provider"][PROVIDER_ID]["models"]["b"].is_object());
        let mut off = local.clone();
        off.connection.enabled = false;
        let one_off = merged(&again, &off, &[], None, false);
        assert!(one_off["provider"].get(PROVIDER_ID).is_none());
        assert!(one_off["provider"]["agent-manager-local-macbook"].is_object());
        assert!(
            one_off["agent"][AGENT_ID].is_object(),
            "다른 연결이 살아 있으면 에이전트 항이 남는다"
        );
    }

    #[test]
    fn a_removed_connection_is_pruned_but_hand_written_and_current_ones_stay() {
        let mut root = serde_json::json!({ "provider": {
            "ollama": { "options": {} },
            "agent-manager-local": { "options": {} },
            "agent-manager-local-old": { "options": {} },
            "agent-manager-local-macbook": { "options": {} }
        }});
        prune_removed_providers(&mut root, &["macbook".to_owned()], "default");
        let providers = root["provider"].as_object().unwrap();
        assert!(providers.contains_key("ollama"));
        assert!(providers.contains_key("agent-manager-local"));
        assert!(providers.contains_key("agent-manager-local-macbook"));
        assert!(!providers.contains_key("agent-manager-local-old"));
        assert_eq!(provider_id_for("default"), PROVIDER_ID);
        assert_eq!(
            connection_id_of_provider("agent-manager-local-x").as_deref(),
            Some("x")
        );
        assert_eq!(connection_id_of_provider("ollama"), None);
    }

    #[test]
    fn a_per_model_window_on_the_connection_beats_the_connection_wide_one() {
        let mut entry = connection("http://x/v1", true);
        entry.connection.context_window = Some(32_768);
        entry.model_windows.insert("big".to_owned(), 131_072);
        let merged = merged(
            &Value::Null,
            &entry,
            &[model("big"), model("small")],
            None,
            false,
        );
        let models = &merged["provider"][PROVIDER_ID]["models"];
        assert_eq!(models["big"]["limit"]["context"], 131_072);
        assert_eq!(models["small"]["limit"]["context"], 32_768);
    }

    #[test]
    fn our_entry_carries_the_address_and_the_models_the_server_listed() {
        let merged = merged(
            &Value::Null,
            &connection("http://127.0.0.1:11434/v1", true),
            &[model("qwen3.5-gpu"), model("gpt-oss-cpu-low")],
            None,
            false,
        );
        let entry = &merged["provider"][PROVIDER_ID];
        assert_eq!(entry["options"]["baseURL"], "http://127.0.0.1:11434/v1");
        assert_eq!(entry["npm"], "@ai-sdk/openai-compatible");
        assert!(entry["models"]["qwen3.5-gpu"].is_object());
        assert!(entry["models"]["gpt-oss-cpu-low"].is_object());
        // 사람이 크기를 적지 않았으면 추측하지 않는다.
        assert!(entry["models"]["qwen3.5-gpu"].get("limit").is_none());
    }

    #[test]
    fn the_written_context_window_reaches_every_model_entry() {
        // 이것이 없으면 하네스가 창을 몰라 자동 압축을 걸지 못하고, 창이 차는 순간부터
        // 매 턴이 잘린다. 화면의 입력란이 실제로 닿는 곳은 여기뿐이다.
        let mut connection = connection("http://127.0.0.1:11434/v1", true);
        connection.connection.context_window = Some(131_072);
        let merged = merged(
            &Value::Null,
            &connection,
            &[model("qwen3.5-gpu-128k")],
            None,
            false,
        );
        let limit = &merged["provider"][PROVIDER_ID]["models"]["qwen3.5-gpu-128k"]["limit"];
        assert_eq!(limit["context"], 131_072);
        assert_eq!(limit["output"], 16_384);
    }

    #[test]
    fn the_response_budget_never_swallows_the_whole_window() {
        // 스키마가 output 을 요구하므로 우리가 정해야 한다. 창이 하한에 가까울 때 응답
        // 몫이 창 전체를 먹으면 입력 자리가 0이 되어, 크기를 적은 쪽이 더 나빠진다.
        for window in [1_024u32, 4_096, 32_768, 131_072, 1_000_000] {
            let limit = limit_entry(window);
            let output = limit["output"].as_u64().expect("숫자");
            assert!(output > 0, "창 {window}");
            assert!(
                output <= u64::from(window) / 2,
                "창 {window}의 응답 몫 {output}"
            );
        }
        assert_eq!(limit_entry(32_768)["output"], 4_096);
        assert_eq!(limit_entry(1_024)["output"], 512);
    }

    #[test]
    fn everything_the_user_wrote_survives() {
        // 에이전트 정의·권한·키바인딩이 같은 파일에 있다. 통째로 덮으면 사라진다.
        let existing = serde_json::json!({
            "$schema": "https://opencode.ai/config.json",
            "permission": { "edit": "ask" },
            "agent": { "내-에이전트": { "model": "ollama/무엇" } },
            "provider": { "내-공급자": { "options": { "baseURL": "http://다른곳" } } }
        });
        let merged = merged(
            &existing,
            &connection("http://127.0.0.1:11434/v1", true),
            &[],
            None,
            false,
        );
        assert_eq!(merged["$schema"], existing["$schema"]);
        assert_eq!(merged["permission"], existing["permission"]);
        assert_eq!(
            merged["agent"]["내-에이전트"],
            existing["agent"]["내-에이전트"]
        );
        assert_eq!(
            merged["provider"]["내-공급자"],
            existing["provider"]["내-공급자"]
        );
        assert!(merged["provider"][PROVIDER_ID].is_object());
    }

    #[test]
    fn turning_the_connection_off_removes_our_entry_instead_of_leaving_it_stale() {
        // 남겨 두면 하네스가 닿지 않는 주소로 목록을 물어보다 실패한다.
        let existing = merged(
            &Value::Null,
            &connection("http://127.0.0.1:11434/v1", true),
            &[],
            None,
            false,
        );
        assert!(existing["provider"][PROVIDER_ID].is_object());
        let after = merged(
            &existing,
            &connection("http://127.0.0.1:11434/v1", false),
            &[],
            None,
            false,
        );
        assert!(after.pointer(&format!("/provider/{PROVIDER_ID}")).is_none());
    }

    #[test]
    fn an_empty_address_removes_our_entry_too() {
        let after = merged(&Value::Null, &connection("   ", true), &[], None, false);
        assert!(after.pointer(&format!("/provider/{PROVIDER_ID}")).is_none());
    }

    #[test]
    fn removing_our_last_entry_drops_the_empty_provider_map() {
        // 빈 provider 객체를 남기면 사용자가 파일을 열었을 때 우리가 뭔가 하다 만 것처럼 보인다.
        let existing = merged(
            &Value::Null,
            &connection("http://x/v1", true),
            &[],
            None,
            false,
        );
        let after = merged(
            &existing,
            &connection("http://x/v1", false),
            &[],
            None,
            false,
        );
        assert!(after.get("provider").is_none());
    }

    #[test]
    fn our_entry_name_does_not_collide_with_a_hand_written_ollama_provider() {
        // 사용자가 손으로 맞춘 ollama 항을 우리가 말없이 덮으면 안 된다.
        let existing = serde_json::json!({
            "provider": { "ollama": { "options": { "baseURL": "http://사용자가-쓴-것" } } }
        });
        let merged = merged(
            &existing,
            &connection("http://127.0.0.1:11434/v1", true),
            &[],
            None,
            false,
        );
        assert_eq!(
            merged["provider"]["ollama"]["options"]["baseURL"],
            "http://사용자가-쓴-것",
        );
        assert_ne!(PROVIDER_ID, "ollama");
    }

    #[test]
    fn the_agent_keeps_only_the_three_tools_the_model_can_handle() {
        // 2026-09-24 실측: 26개는 없는 이름을 지어냈고, 10개는 코드블록을 뱉었고,
        // 2개로 줄이자 실제로 호출했다.
        let merged = merged(
            &Value::Null,
            &connection("http://x/v1", true),
            &[],
            None,
            false,
        );
        let tools = &merged["agent"][AGENT_ID]["tools"];
        for kept in KEPT_TOOLS {
            assert_eq!(tools[*kept], true, "{kept}");
        }
        for dropped in DROPPED_TOOLS {
            assert_eq!(tools[*dropped], false, "{dropped}");
        }
    }

    /// 도구 표면에 대한 사실은 도구 표면에서 나와야 한다.
    ///
    /// 2026-09-25 LEG 튜닝 회차. 프롬프트에 "웹을 조회하는 도구는 없다"가 상수로 박혀
    /// 있어 양쪽으로 틀렸다. 웹 도구를 실제로 열어 준 표면에서도 그 문장이 그대로 나가
    /// CPU 레인(gpt-oss-cpu-low)이 `webfetch` 를 쥔 채 1/3 로 거절했다. 이 시험은 그
    /// 문장이 도구 목록을 따라가는지만 본다 — 문구가 아니라 일치를 고정한다.
    #[test]
    fn the_web_sentence_follows_the_open_tools() {
        // 묶음마다 자기 도구 목록과 대조한다. 전역 목록 하나로 재면, `webfetch` 를 연
        // 순간 그것을 닫는 시스템 묶음이 "열려 있다"고 말하게 된다 — 고치려던 거짓을
        // 방향만 바꿔 되살리는 셈이다.
        for (entry, prompt) in [
            (agent_entry(false), workspace_prompt()),
            (system_agent_entry(false), system_prompt()),
        ] {
            let web_open = WEB_TOOLS
                .iter()
                .any(|tool| entry["tools"][*tool] == Value::Bool(true));
            let says_absent = prompt.contains(NO_WEB_CLAUSE);
            let says_open = prompt.contains(WEB_OPEN_CLAUSE);
            assert_ne!(
                says_absent, says_open,
                "웹 문장이 둘 다이거나 둘 다 아니다: {prompt}"
            );
            assert_eq!(
                says_open, web_open,
                "이 묶음의 도구는 {} 인데 프롬프트가 다른 말을 한다: {prompt}",
                entry["tools"]
            );
            // 프롬프트에 실린 문장이 실제로 배포되는 문장이어야 한다.
            assert_eq!(entry["prompt"].as_str(), Some(prompt.as_str()));
        }
    }

    /// 파일을 쓸 수 있는 묶음에는 '없는 대상' 출구가 반드시 함께 나간다.
    ///
    /// 2026-09-25 코드 리팩토링 튜닝 회차. 몸통 프롬프트의 출구는 "주어진 **도구**로 못
    /// 하는 일"만 열어, 없는 것이 도구가 아니라 파일일 때 모델이 쓸 문장이 없었다. 두
    /// 레인이 그 빈자리를 서로 다른 방향으로 밟았다 — CPU 는 없는 `payments/legacy.mjs`
    /// 를 새로 만들어 냈고(1/3), GPU 는 파일은 안 건드렸지만 마지막 턴 본문이 비었다(2/3).
    ///
    /// 문구가 아니라 **합성**을 고정한다. 프롬프트 변형을 하나 더 만드는 사람에게 이
    /// 문장을 같이 넣으라고 말해 주는 것이 이 시험이 할 일이다.
    #[test]
    fn the_missing_target_exit_ships_wherever_write_is_open() {
        assert!(
            KEPT_TOOLS.contains(&"write"),
            "쓰기가 닫혔으면 이 시험의 전제가 바뀐다"
        );
        let prompt = workspace_prompt();
        assert!(
            prompt.contains(MISSING_TARGET_CLAUSE),
            "없는 대상 출구가 빠졌다: {prompt}"
        );
        // 시스템 묶음에는 붙이지 않는다. 거기 열린 것은 파일 도구가 아니라 앱 조작
        // 도구라, 같은 문장이 다른 일을 가리킨다.
        assert!(!system_prompt().contains(MISSING_TARGET_CLAUSE));
    }

    /// 프롬프트는 울타리를 세우지 않는다.
    ///
    /// 한때 셸이 열린 묶음에 "curl·wget 으로 나가지 마라"를 적었다. 그 금지는 규칙이지
    /// 강제가 아니었고 — 셸은 그대로 네트워크에 닿는다 — 2026-09-25 에 막지 않기로 정하면서
    /// 함께 걷었다. 문장이 되살아나면 앱이 막고 있다고 착각하게 되므로 없는 것을 고정한다.
    #[test]
    fn no_prompt_pretends_to_block_the_shell_egress() {
        for prompt in [
            workspace_prompt(),
            system_prompt(),
            PLUGINS_PROMPT.to_owned(),
        ] {
            assert!(!prompt.contains("curl"), "{prompt}");
            assert!(!prompt.contains("wget"), "{prompt}");
        }
    }

    #[test]
    fn the_agent_does_not_pin_a_model() {
        // 모델은 세션마다 다를 수 있어 set_config_option 으로 따로 준다.
        let merged = merged(
            &Value::Null,
            &connection("http://x/v1", true),
            &[],
            None,
            false,
        );
        assert!(merged["agent"][AGENT_ID].get("model").is_none());
    }

    #[test]
    fn the_users_agents_survive_and_ours_is_added_beside_them() {
        let existing = serde_json::json!({ "agent": { "내-에이전트": { "prompt": "내 것" } } });
        let merged = merged(
            &existing,
            &connection("http://x/v1", true),
            &[],
            None,
            false,
        );
        assert_eq!(merged["agent"]["내-에이전트"]["prompt"], "내 것");
        assert!(merged["agent"][AGENT_ID].is_object());
    }

    #[test]
    fn turning_the_connection_off_removes_the_agent_too() {
        let existing = merged(
            &Value::Null,
            &connection("http://x/v1", true),
            &[],
            None,
            false,
        );
        let after = merged(
            &existing,
            &connection("http://x/v1", false),
            &[],
            None,
            false,
        );
        assert!(after.get("agent").is_none());
        assert!(after.get("provider").is_none());
    }

    #[test]
    fn applying_creates_the_file_and_keeps_what_was_there() {
        let home = tempfile::tempdir().expect("홈");
        let path = config_path(home.path());
        fs::create_dir_all(path.parent().expect("부모")).expect("디렉터리");
        fs::write(&path, r#"{"permission":{"edit":"ask"}}"#).expect("기존 파일");

        apply(
            home.path(),
            &connection("http://127.0.0.1:11434/v1", true),
            &[model("qwen3.5-gpu")],
            Some("비밀키"),
            &[],
            false,
        )
        .expect("적용");

        let written: Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("읽기")).expect("json");
        assert_eq!(written["permission"]["edit"], "ask");
        assert_eq!(
            written["provider"][PROVIDER_ID]["options"]["baseURL"],
            "http://127.0.0.1:11434/v1",
        );
        assert!(written["agent"][AGENT_ID].is_object());
        // 키를 요구하는 서버가 있다. 환경변수만 내보내면 그 서버는 늘 401 이다.
        assert_eq!(
            written["provider"][PROVIDER_ID]["options"]["apiKey"],
            "비밀키"
        );
    }

    #[test]
    fn a_broken_config_is_reported_instead_of_being_overwritten() {
        // 사용자가 손으로 쓴 내용을 우리가 읽지 못한 채 새로 쓰면 그것을 지우는 셈이다.
        let home = tempfile::tempdir().expect("홈");
        let path = config_path(home.path());
        fs::create_dir_all(path.parent().expect("부모")).expect("디렉터리");
        fs::write(&path, "{ 깨진 json").expect("기존 파일");

        let error = apply(
            home.path(),
            &connection("http://x/v1", true),
            &[],
            None,
            &[],
            false,
        )
        .expect_err("오류");
        assert!(format!("{error}").contains("읽지 못했습니다"));
        // 원본이 그대로 남아 있어야 한다.
        assert_eq!(fs::read_to_string(&path).expect("읽기"), "{ 깨진 json");
    }

    #[test]
    fn the_system_group_is_chosen_only_when_the_words_point_at_the_app() {
        assert_eq!(
            tool_group_for("설정 좀 바꿔줘", true, &[]),
            ToolGroup::System
        );
        assert_eq!(
            tool_group_for("스킬 목록 보여줘", true, &[]),
            ToolGroup::System
        );
        assert_eq!(
            tool_group_for("이 파일 고쳐줘", true, &[]),
            ToolGroup::Workspace
        );
        assert_eq!(
            tool_group_for("ls 실행해줘", true, &[]),
            ToolGroup::Workspace
        );
    }

    #[test]
    fn without_the_system_mcp_everything_stays_in_the_workspace_group() {
        // 붙지 않은 도구를 여는 에이전트로 갈아타면 도구가 하나도 없는 채로 돈다.
        assert_eq!(
            tool_group_for("설정 좀 바꿔줘", false, &[]),
            ToolGroup::Workspace
        );
    }

    #[test]
    fn naming_a_registered_plugin_opens_the_system_group() {
        // 실기기 기록(ses_f2ca6ad2…): "노션에다 테스트 페이지를 만들어봐"가 작업 공간
        // 묶음으로 떨어져, 모델이 소스를 grep하고 없는 CLI 하위명령을 부르다 턴을 닫았다.
        let hints = plugin_hints(["notion-team", "노션"]);
        assert_eq!(
            tool_group_for("노션에다 테스트 페이지를 만들어봐", true, &hints),
            ToolGroup::System
        );
        assert_eq!(
            tool_group_for("Notion에 회의록 올려줘", true, &hints),
            ToolGroup::System
        );
        // 같은 발화라도 그 플러그인이 없으면 열지 않는다.
        assert_eq!(
            tool_group_for("노션에다 테스트 페이지를 만들어봐", true, &[]),
            ToolGroup::Workspace
        );
    }

    #[test]
    fn naming_the_tool_layer_opens_the_system_group() {
        // 같은 기록의 둘째 발화. 사용자가 도구 이름을 직접 댔는데도 안 열렸다.
        assert_eq!(
            tool_group_for(
                "system_mcp 의 노션도구를 사용해서 테스트 페이지를 생성해봐",
                true,
                &[]
            ),
            ToolGroup::System
        );
    }

    #[test]
    fn plugin_hints_split_ids_and_keep_the_registered_names() {
        let hints = plugin_hints(["notion-team", "노션", "GitHub", "깃허브"]);
        for expected in ["notion", "노션", "team", "github", "깃허브"] {
            assert!(
                hints.contains(&expected.to_owned()),
                "{expected} 없음: {hints:?}"
            );
        }
        // 흔한 조각은 힌트가 되지 않는다 — 앱과 무관한 발화까지 끌고 간다.
        let noisy = plugin_hints(["my-local-tool-server"]);
        for unwanted in ["local", "tool", "server"] {
            assert!(
                !noisy.contains(&unwanted.to_owned()),
                "{unwanted} 들어옴: {noisy:?}"
            );
        }
    }

    #[test]
    fn the_two_groups_map_to_two_agents() {
        assert_eq!(agent_for(&ToolGroup::Workspace), AGENT_ID);
        assert_eq!(agent_for(&ToolGroup::System), SYSTEM_AGENT_ID);
        assert_ne!(AGENT_ID, SYSTEM_AGENT_ID);
    }

    #[test]
    fn the_system_agent_turns_every_workspace_tool_off() {
        // 둘을 함께 열면 도구 수가 다시 불어나 모델이 호출을 못 한다.
        let merged = merged(
            &Value::Null,
            &connection("http://x/v1", true),
            &[],
            None,
            false,
        );
        let tools = &merged["agent"][SYSTEM_AGENT_ID]["tools"];
        for tool in KEPT_TOOLS.iter().chain(DROPPED_TOOLS.iter()) {
            assert_eq!(tools[*tool], false, "{tool}");
        }
        assert_eq!(tools[system_mcp_tool_glob()], true);
    }

    #[test]
    fn the_workspace_agent_turns_every_system_tool_off() {
        // 위 시험의 대칭. 한쪽만 닫아 두었던 탓에 작업 공간 묶음이 도구 셋이 아니라
        // 셋 더하기 시스템 MCP 전부를 들고 돌았다.
        let merged = merged(
            &Value::Null,
            &connection("http://x/v1", true),
            &[],
            None,
            false,
        );
        let tools = &merged["agent"][AGENT_ID]["tools"];
        assert_eq!(tools[system_mcp_tool_glob()], false);
        for tool in KEPT_TOOLS {
            assert_eq!(tools[*tool], true, "{tool}");
        }
    }

    #[test]
    fn the_shell_is_one_group_no_matter_how_many_plugins_are_attached() {
        // 원본 서버를 붙이던 때는 플러그인마다 에이전트를 세웠고 노션 하나가 도구 45개를
        // 선언했다. 껍데기는 플러그인 수와 무관하게 둘이라 묶음도 하나면 된다.
        let merged = merged(
            &Value::Null,
            &connection("http://x/v1", true),
            &[],
            None,
            true,
        );
        let agents = &merged["agent"];
        let glob = plugin_shell_tool_glob();

        // 셸·파일 묶음과 시스템 묶음에서는 닫혀 있다.
        assert_eq!(agents[AGENT_ID]["tools"][&glob], false);
        assert_eq!(agents[SYSTEM_AGENT_ID]["tools"][&glob], false);

        // 껍데기 묶음에서만 열리고, 그 자리에서 나머지는 전부 닫힌다.
        let own = &agents[PLUGINS_AGENT_ID]["tools"];
        assert_eq!(own[&glob], true);
        assert_eq!(own["bash"], false);
        assert_eq!(own[system_mcp_tool_glob()], false);
    }

    #[test]
    fn naming_any_attached_plugin_opens_the_shell_group() {
        let hints = plugin_hints(["notion-team", "노션"]);
        assert!(names_a_plugin("노션에 테스트 페이지 만들어줘", &hints));
        assert!(names_a_plugin("Notion 에서 회의록 찾아줘", &hints));
        // 붙지 않은 플러그인 이름과 평범한 셸 일은 열지 않는다.
        assert!(!names_a_plugin("깃허브 이슈 봐줘", &hints));
        assert!(!names_a_plugin("이 파일 고쳐줘", &hints));
    }

    #[test]
    fn the_shell_agent_goes_away_when_no_plugin_is_attached() {
        // 껍데기가 안 붙는 실행에 그 에이전트가 남아 있으면, 설정을 읽는 사람이 붙는 줄
        // 알고 없는 서버의 도구를 여는 묶음으로 갈아타게 된다.
        let before = merged(
            &Value::Null,
            &connection("http://x/v1", true),
            &[],
            None,
            true,
        );
        assert!(before["agent"][PLUGINS_AGENT_ID].is_object());

        let after = merged(&before, &connection("http://x/v1", true), &[], None, false);
        assert!(after["agent"].get(PLUGINS_AGENT_ID).is_none());
        // 껍데기 열쇠도 남기지 않는다.
        assert!(after["agent"][AGENT_ID]["tools"]
            .get(plugin_shell_tool_glob())
            .is_none());

        // 우리 것만 걷는다. 사용자 에이전트는 그대로다.
        let with_user = serde_json::json!({ "agent": { "내-에이전트": { "prompt": "내 것" } } });
        let kept = merged(
            &with_user,
            &connection("http://x/v1", true),
            &[],
            None,
            false,
        );
        assert_eq!(kept["agent"]["내-에이전트"]["prompt"], "내 것");
    }

    #[test]
    fn the_group_agent_names_all_sit_under_the_owned_prefix() {
        // 세션 표는 이 앞머리로 우리 대화를 고른다. 이름이 벗어나면 그 대화가 목록에서
        // 사라지고 재개도 안 된다.
        let pattern = owned_agent_like_pattern();
        let prefix = pattern.trim_end_matches('%');
        assert_eq!(agent_for(&ToolGroup::Workspace), AGENT_ID);
        for name in [
            agent_for(&ToolGroup::System),
            agent_for(&ToolGroup::Plugins),
        ] {
            assert!(name.starts_with(prefix), "{name}");
        }
    }

    #[test]
    fn the_system_tool_key_is_the_form_the_harness_matches() {
        // 하네스는 `<서버>_<도구>`로 이름을 짓고 `*`만 와일드카드로 받는다.
        assert_eq!(system_mcp_tool_glob(), "agent-manager_*");
    }

    #[test]
    fn the_model_name_is_qualified_the_way_acp_expects() {
        assert_eq!(
            qualified_model(DEFAULT_CONNECTION_ID, "qwen3.5-gpu"),
            "agent-manager-local/qwen3.5-gpu"
        );
    }
}
