//! Agent Manager가 제공하는 기본 도구의 공급자별 발견 카탈로그.
//!
//! 실행 경로는 AIA MCP·직접 MCP·시스템 스킬로 서로 다르지만, 어느 에이전트가 현재
//! 무엇을 쓸 수 있는지는 한 표에서 만든다. 자격증명이나 SSH 접속 정보는 싣지 않는다.

use std::path::Path;

use serde::Serialize;

use crate::domain::ProviderId;
use crate::CoreError;

const CYPRESS_OPERATIONS: &[&str] = &[
    "list_cypress_workspaces",
    "list_cypress_workspace_files",
    "read_cypress_workspace_file",
    "write_cypress_workspace_file",
    "delete_cypress_workspace_file",
    "run_cypress_spec",
    "get_cypress_run_status",
    "list_cypress_runs",
    "add_cypress_workspace",
    "install_cypress_module",
];

const DB_OPERATIONS: &[&str] = &[
    "list_agent_db_connections",
    "get_db_connections",
    "check_db_connection",
    "run_db_query",
    "run_db_statement",
];

const SSH_OPERATIONS: &[&str] = &[
    "list_agent_ssh_endpoints",
    "check_ssh_endpoint",
    "execute_ssh_command",
    "allow_ssh_command_permanently",
    "upload_ssh_file",
    "download_ssh_file",
];

/// 앱이 그려 주는 다이어그램 종류. 도구 호출이 아니라 답변에 적을 수 있는 표기라, 에이전트가
/// 무엇을 적으면 그림이 되는지 알 수 있게 종류를 그대로 싣는다.
const MERMAID_OPERATIONS: &[&str] = &[
    "flowchart",
    "sequenceDiagram",
    "classDiagram",
    "stateDiagram-v2",
    "erDiagram",
    "journey",
    "gantt",
    "pie",
    "quadrantChart",
    "mindmap",
    "timeline",
    "gitGraph",
    "architecture-beta",
];

/// AIA는 외부 MCP를 직접 붙이지 않고 시스템 MCP의 프록시 작업으로 호출한다.
const MCP_AIA_OPERATIONS: &[&str] = &[
    "get_external_plugins",
    "get_external_plugin_tools",
    "read_external_plugin_tool",
    "execute_external_plugin_tool",
    "set_external_plugin_enabled",
];

/// 일반 채팅은 플러그인 서버가 그대로 붙으므로 도구 이름이 고정 목록이 아니다. 이름 규칙만 싣는다.
const MCP_DIRECT_OPERATIONS: &[&str] = &["mcp__<플러그인id>__<서버가 알려 주는 도구>"];

/// 실행 단위 MCP 주입이 없는 공급자는 자기 전역 설정에 적어 둔 서버만 본다. 도구 이름 규칙은
/// 그 설정에 사용자가 붙인 서버 이름이 정하므로 앱이 알 수 없다.
const MCP_EXTERNAL_CONFIG_OPERATIONS: &[&str] =
    &["<CLI 전역 설정에 등록한 서버 이름>__<서버가 알려 주는 도구>"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBuiltinToolsCatalog {
    pub schema_version: u32,
    pub tools: Vec<AgentBuiltinToolDefinition>,
    pub agents: Vec<AgentBuiltinToolsView>,
    pub issues: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBuiltinToolDefinition {
    pub id: String,
    pub display_name: String,
    pub routes: Vec<AgentBuiltinToolRoute>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBuiltinToolRoute {
    pub access_method: String,
    pub operations: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBuiltinToolsView {
    /// `aia` 또는 일반 채팅 공급자 id.
    pub agent: String,
    pub tools: Vec<AgentBuiltinToolView>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBuiltinToolView {
    pub id: String,
    pub enabled: bool,
    pub available: bool,
    /// `aiaSystem` · `directMcp` · `externalMcpConfig` · `systemSkillCli` · `systemSkillHttp`.
    pub access_method: String,
    /// 꺼진 상태에서 켠 뒤 이미 실행 중인 채팅에 연결하려면 새 채팅이 필요한지.
    pub enablement_requires_new_chat: bool,
    /// 화면이 제 언어로 조립하는 상태 설명. QA #69 — 여기서 한국어 문장을 만들어 내리면
    /// 영어 UI의 접근 상세만 한국어로 남는다. 종류와 수치만 싣고 문구는 화면이 맡는다.
    pub note: AgentBuiltinToolNote,
}

/// 도구 상태 한 줄의 뜻. 문구가 아니라 갈래와 수치라서 ko·en 어느 쪽으로도 조립된다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentBuiltinToolNote {
    /// 쓸 수 있는 SSH 서버와, 켜져 있지만 쓸 수 없는 서버의 수.
    #[serde(rename_all = "camelCase")]
    SshEndpoints {
        available: usize,
        unusable: usize,
    },
    /// 쓸 수 있는 DB 연결과, 켜져 있지만 쓸 수 없는 연결의 수.
    #[serde(rename_all = "camelCase")]
    DbConnections {
        available: usize,
        unusable: usize,
    },
    CypressEnabled,
    CypressDisabled,
    /// 앱이 붙여 주지 못해 CLI 전역 설정에 사용자가 직접 등록해야 하는 공급자의 상태.
    /// `registered`는 그 설정이 지금 프록시 주소를 가리키는 플러그인, `missing`은 앱에서는
    /// 쓸 수 있지만 아직 등록되지 않은 플러그인이다.
    #[serde(rename_all = "camelCase")]
    McpExternalConfig {
        registered: Vec<String>,
        missing: Vec<String>,
        pending: usize,
    },
    #[serde(rename_all = "camelCase")]
    McpNone {
        pending: usize,
    },
    #[serde(rename_all = "camelCase")]
    McpAttached {
        names: Vec<String>,
        pending: usize,
    },
    Mermaid,
}

/// 등록 목록 하나로 상태가 정해지는 도구. SSH 엔드포인트와 DB 연결이 같은 규칙을 쓴다 —
/// 등록된 것이 하나라도 있으면 "사용 중"이고, 지금 바로 쓸 수 있는 것이 있어야 "사용 가능"이다.
/// 두 도구가 각자 켜짐·쓸 수 있음·개수·건너뛴 개수 네 칸을 따로 들고 다니면, 규칙이 한쪽에서만
/// 바뀌어도 화면은 그 차이를 설명하지 못한다.
#[derive(Clone, Copy, Default)]
struct RegisteredTargets {
    /// 지금 바로 쓸 수 있는 대상 수.
    usable: usize,
    /// 등록은 돼 있지만 이번에는 쓸 수 없는 대상 수.
    unusable: usize,
}

impl RegisteredTargets {
    fn new(usable: usize, unusable: usize) -> Self {
        Self { usable, unusable }
    }

    /// 등록된 것이 하나라도 있는지. 쓸 수 없는 것만 남아 있어도 참이다.
    fn enabled(self) -> bool {
        self.usable > 0 || self.unusable > 0
    }

    fn available(self) -> bool {
        self.usable > 0
    }
}

#[derive(Clone, Default)]
struct BuiltinToolState {
    cypress_enabled: bool,
    db: RegisteredTargets,
    ssh: RegisteredTargets,
    /// 사용 중이고 자격증명이 준비돼 실제로 붙는 외부 MCP의 (id, 표시 이름).
    mcp_attachable: Vec<(String, String)>,
    /// 사용 중이지만 인증이 아직 없어 붙지 않는 외부 MCP 수.
    mcp_pending: usize,
    /// 그중 Antigravity CLI의 전역 설정이 지금 프록시 주소로 가리키고 있는 플러그인 id.
    mcp_registered_in_antigravity: Vec<String>,
}

/// 현재 호스트 설정을 읽되, 한 도구의 상태 조회 실패가 다른 도구의 발견까지 막지 않는다.
pub fn load_agent_builtin_tools(app_data_dir: &Path) -> AgentBuiltinToolsCatalog {
    let mut issues = Vec::new();
    let cypress_enabled = or_note(
        crate::cypress_workspaces::is_enabled(app_data_dir),
        "Cypress 활성 상태",
        &mut issues,
    );
    let ssh = or_note(
        crate::list_agent_ssh_endpoints(app_data_dir)
            .map(|view| RegisteredTargets::new(view.endpoints.len(), view.skipped.len())),
        "SSH 활성 상태",
        &mut issues,
    );
    let db = or_note(
        crate::list_agent_db_connections(app_data_dir)
            .map(|view| RegisteredTargets::new(view.connections.len(), view.skipped.len())),
        "데이터베이스 활성 상태",
        &mut issues,
    );
    let (mcp_attachable, mcp_pending) = or_note(
        crate::external_plugins::ExternalPluginRegistry::new(app_data_dir.to_path_buf())
            .summary()
            .map(|summary| (summary.attachable, summary.pending)),
        "외부 MCP 상태",
        &mut issues,
    );
    let mcp_registered_in_antigravity =
        antigravity_registered_plugins(app_data_dir, &mcp_attachable);
    catalog_from_state(
        BuiltinToolState {
            cypress_enabled,
            db,
            ssh,
            mcp_attachable,
            mcp_pending,
            mcp_registered_in_antigravity,
        },
        issues,
    )
}

/// 한 도구의 상태 조회 결과를 받아, 실패하면 이유를 목록에 적고 "아무것도 없음"으로 물러선다.
/// 네 갈래가 저마다 같은 모양의 `match`를 펼쳐 두던 자리다 — 갈래마다 다른 것은 조회하는
/// 대상과 실패 문구뿐이다.
fn or_note<T: Default>(result: Result<T, CoreError>, subject: &str, issues: &mut Vec<String>) -> T {
    result.unwrap_or_else(|error| {
        issues.push(format!("{subject}를 읽지 못했습니다: {error}"));
        T::default()
    })
}

/// Antigravity CLI 전역 설정(`~/.gemini/config/mcp_config.json`)이 **지금** 프록시 주소로
/// 가리키고 있는 플러그인 id.
///
/// 이 공급자는 실행 단위 MCP 플래그가 없어 앱이 채팅마다 서버를 붙이지 못한다. 대신 프록시
/// 주소가 부팅 사이에 유지되므로 사용자가 `agy mcp add`로 한 번 등록해 둘 수 있고, 여기서는
/// 그 등록이 살아 있는지만 확인한다. 주소를 통째로 대조하는 것이 핵심이다 — 포트나 라우트
/// 키가 바뀐 뒤 남은 옛 등록은 닿지 않으므로 "등록됨"으로 세면 안 된다.
///
/// 설정을 읽지 못하면 빈 결과다. 이 조회는 안내 문구를 만들 뿐이라, 못 읽었다고 카탈로그
/// 전체를 실패로 만들지 않는다.
fn antigravity_registered_plugins(
    app_data_dir: &Path,
    attachable: &[(String, String)],
) -> Vec<String> {
    let Some(base) = crate::system_mcp::stored_plugin_proxy_base(app_data_dir) else {
        return Vec::new();
    };
    let Some(home) = crate::user_home::optional_home_dir() else {
        return Vec::new();
    };
    let path = home.join(".gemini/config/mcp_config.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    let Ok(config) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Vec::new();
    };
    let Some(servers) = config.get("mcpServers").and_then(|value| value.as_object()) else {
        return Vec::new();
    };
    let urls: Vec<&str> = servers
        .values()
        .filter(|server| {
            !server
                .get("disabled")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|server| {
            server
                .get("serverUrl")
                .or_else(|| server.get("url"))
                .and_then(serde_json::Value::as_str)
        })
        .collect();
    attachable
        .iter()
        .filter(|(id, _)| {
            let expected = format!("{base}/{id}");
            urls.iter().any(|url| url.trim_end_matches('/') == expected)
        })
        .map(|(id, _)| id.clone())
        .collect()
}

fn catalog_from_state(state: BuiltinToolState, issues: Vec<String>) -> AgentBuiltinToolsCatalog {
    let mut agents = vec![agent_view("aia", None, &state)];
    agents.extend(
        ProviderId::ALL
            .into_iter()
            .map(|provider| agent_view(provider.as_str(), Some(provider), &state)),
    );
    AgentBuiltinToolsCatalog {
        schema_version: 1,
        tools: vec![
            AgentBuiltinToolDefinition {
                id: "ssh".to_owned(),
                display_name: "SSH".to_owned(),
                routes: vec![
                    route("aiaSystem", SSH_OPERATIONS),
                    route("systemSkillCli", &["ssh list", "ssh exec", "ssh", "scp"]),
                ],
            },
            AgentBuiltinToolDefinition {
                id: "db".to_owned(),
                display_name: "데이터베이스".to_owned(),
                routes: vec![
                    route("aiaSystem", DB_OPERATIONS),
                    route("systemSkillCli", &["db list", "db query", "db exec"]),
                ],
            },
            AgentBuiltinToolDefinition {
                id: "cypress".to_owned(),
                display_name: "Cypress".to_owned(),
                routes: vec![
                    route("aiaSystem", CYPRESS_OPERATIONS),
                    route("directMcp", CYPRESS_OPERATIONS),
                    route("systemSkillHttp", CYPRESS_OPERATIONS),
                ],
            },
            AgentBuiltinToolDefinition {
                id: "mcp".to_owned(),
                display_name: "외부 MCP".to_owned(),
                routes: vec![
                    route("aiaSystem", MCP_AIA_OPERATIONS),
                    route("directMcp", MCP_DIRECT_OPERATIONS),
                    route("externalMcpConfig", MCP_EXTERNAL_CONFIG_OPERATIONS),
                ],
            },
            AgentBuiltinToolDefinition {
                id: "mermaid".to_owned(),
                display_name: "Mermaid".to_owned(),
                routes: vec![route("appRender", MERMAID_OPERATIONS)],
            },
        ],
        agents,
        issues,
    }
}

fn route(access_method: &str, operations: &[&str]) -> AgentBuiltinToolRoute {
    AgentBuiltinToolRoute {
        access_method: access_method.to_owned(),
        operations: operations.iter().map(|value| (*value).to_owned()).collect(),
    }
}

fn agent_view(
    agent: &str,
    provider: Option<ProviderId>,
    state: &BuiltinToolState,
) -> AgentBuiltinToolsView {
    let (ssh_access, cypress_access, cypress_new_chat) = match provider {
        None => ("aiaSystem", "aiaSystem", false),
        Some(ProviderId::Claude | ProviderId::Codex | ProviderId::Local) => {
            ("systemSkillCli", "directMcp", true)
        }
        Some(ProviderId::Antigravity) => ("systemSkillCli", "systemSkillHttp", true),
    };
    let antigravity = provider == Some(ProviderId::Antigravity);
    let mcp_access = if provider.is_none() {
        "aiaSystem"
    } else {
        "directMcp"
    };
    AgentBuiltinToolsView {
        agent: agent.to_owned(),
        tools: vec![
            AgentBuiltinToolView {
                id: "ssh".to_owned(),
                enabled: state.ssh.enabled(),
                available: state.ssh.available(),
                access_method: ssh_access.to_owned(),
                enablement_requires_new_chat: false,
                note: AgentBuiltinToolNote::SshEndpoints {
                    available: state.ssh.usable,
                    unusable: state.ssh.unusable,
                },
            },
            AgentBuiltinToolView {
                id: "db".to_owned(),
                enabled: state.db.enabled(),
                available: state.db.available(),
                // SSH와 달리 접근 경로가 공급자에 따라 갈리지 않는다. 자기 셸이 있는
                // 에이전트도 비밀번호를 받지 못하므로 실행은 언제나 앱을 거친다.
                access_method: if provider.is_none() {
                    "aiaSystem"
                } else {
                    "systemSkillCli"
                }
                .to_owned(),
                enablement_requires_new_chat: false,
                note: AgentBuiltinToolNote::DbConnections {
                    available: state.db.usable,
                    unusable: state.db.unusable,
                },
            },
            AgentBuiltinToolView {
                id: "cypress".to_owned(),
                enabled: state.cypress_enabled,
                available: state.cypress_enabled,
                access_method: cypress_access.to_owned(),
                enablement_requires_new_chat: cypress_new_chat,
                note: if state.cypress_enabled {
                    AgentBuiltinToolNote::CypressEnabled
                } else {
                    AgentBuiltinToolNote::CypressDisabled
                },
            },
            AgentBuiltinToolView {
                id: "mcp".to_owned(),
                enabled: !state.mcp_attachable.is_empty() || state.mcp_pending > 0,
                // Antigravity는 앱이 붙여 주는 것이 아니라 CLI 전역 설정에 등록된 것만
                // 본다. 앱에서 켜 두었다는 사실만으로는 그 채팅에서 쓸 수 없다.
                available: if antigravity {
                    !state.mcp_registered_in_antigravity.is_empty()
                } else {
                    !state.mcp_attachable.is_empty()
                },
                access_method: if antigravity {
                    "externalMcpConfig"
                } else {
                    mcp_access
                }
                .to_owned(),
                // AIA는 프록시 호출이라 토글이 즉시 듣지만, 일반 채팅에 붙는 서버 목록은
                // CLI가 시작할 때 고정된다. 전역 설정을 읽는 공급자도 마찬가지다.
                enablement_requires_new_chat: provider.is_some(),
                note: mcp_note(state, antigravity),
            },
            AgentBuiltinToolView {
                id: "mermaid".to_owned(),
                // 앱 화면이 그리는 것이라 공급자·설정과 무관하게 언제나 쓸 수 있다.
                enabled: true,
                available: true,
                access_method: "appRender".to_owned(),
                enablement_requires_new_chat: false,
                note: AgentBuiltinToolNote::Mermaid,
            },
        ],
    }
}

/// 어떤 서비스가 실제로 붙는지 이름까지 보인다 — 도구 이름만으로는 에이전트도 사용자도
/// 무엇에 연결됐는지 알 수 없다. 주소·자격증명은 싣지 않는다.
fn mcp_note(state: &BuiltinToolState, antigravity: bool) -> AgentBuiltinToolNote {
    if antigravity {
        // 앱에서 쓸 수 있는 것과 이 CLI가 실제로 보는 것이 갈리므로 둘 다 이름으로 싣는다.
        // 한쪽만 보이면 "앱에서 켰는데 왜 없나"를 화면도 에이전트도 설명하지 못한다.
        let (registered, missing) = state.mcp_attachable.iter().fold(
            (Vec::new(), Vec::new()),
            |(mut registered, mut missing), (id, name)| {
                if state.mcp_registered_in_antigravity.contains(id) {
                    registered.push(name.clone());
                } else {
                    missing.push(name.clone());
                }
                (registered, missing)
            },
        );
        return AgentBuiltinToolNote::McpExternalConfig {
            registered,
            missing,
            pending: state.mcp_pending,
        };
    }
    if state.mcp_attachable.is_empty() {
        return AgentBuiltinToolNote::McpNone {
            pending: state.mcp_pending,
        };
    }
    AgentBuiltinToolNote::McpAttached {
        names: state
            .mcp_attachable
            .iter()
            .map(|(_, name)| name.clone())
            .collect(),
        pending: state.mcp_pending,
    }
}

/// 채팅 시작 지침에 넣는 현재 에이전트 한 행. 실행 계약은 각 시스템 스킬/MCP가 맡는다.
pub fn instruction_for_agent(catalog: &AgentBuiltinToolsCatalog, agent: &str) -> Option<String> {
    let view = catalog.agents.iter().find(|view| view.agent == agent)?;
    let rows = view
        .tools
        .iter()
        .map(|tool| {
            format!(
                "{}={} (사용가능={}, 접근={}, 활성화 후 새 채팅 필요={})",
                tool.id,
                if tool.enabled { "활성" } else { "비활성" },
                if tool.available { "예" } else { "아니오" },
                tool.access_method,
                if tool.enablement_requires_new_chat {
                    "예"
                } else {
                    "아니오"
                },
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "\nAgent Manager 기본도구 카탈로그(이 채팅 시작 시점): {rows}. 활성·사용가능한 도구만 해당 접근 경로로 사용하고, 현재 상태가 필요하면 실행 직전에 다시 조회하세요.\n"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool<'a>(
        catalog: &'a AgentBuiltinToolsCatalog,
        agent: &str,
        id: &str,
    ) -> &'a AgentBuiltinToolView {
        catalog
            .agents
            .iter()
            .find(|view| view.agent == agent)
            .unwrap()
            .tools
            .iter()
            .find(|tool| tool.id == id)
            .unwrap()
    }

    #[test]
    fn catalog_exposes_the_same_tools_with_provider_specific_access() {
        let catalog = catalog_from_state(
            BuiltinToolState {
                cypress_enabled: true,
                db: RegisteredTargets::new(1, 0),
                ssh: RegisteredTargets::new(2, 1),
                mcp_attachable: vec![("notion".to_owned(), "Notion".to_owned())],
                mcp_pending: 0,
                mcp_registered_in_antigravity: Vec::new(),
            },
            Vec::new(),
        );
        assert_eq!(catalog.agents.len(), 5);
        for agent in &catalog.agents {
            assert_eq!(
                agent
                    .tools
                    .iter()
                    .map(|tool| tool.id.as_str())
                    .collect::<Vec<_>>(),
                vec!["ssh", "db", "cypress", "mcp", "mermaid"]
            );
        }
        let aia = &catalog.agents[0];
        assert!(aia
            .tools
            .iter()
            .filter(|tool| tool.id != "mermaid")
            .all(|tool| tool.access_method == "aiaSystem"));
        // 자리가 아니라 id로 찾는다. 도구가 하나 늘 때마다 인덱스가 밀리면, 이 단언은
        // 무엇을 확인하는지와 무관하게 깨진다.
        let cypress = tool(&catalog, "antigravity", "cypress");
        assert_eq!(cypress.access_method, "systemSkillHttp");
        assert!(cypress.enablement_requires_new_chat);
        // C10. 데이터베이스는 공급자에 따라 경로가 갈리지 않는다 — 자기 셸이 있는
        // 에이전트도 비밀번호를 받지 못하므로 실행은 언제나 앱을 거친다.
        assert_eq!(
            tool(&catalog, "antigravity", "db").access_method,
            "systemSkillCli"
        );
        assert_eq!(
            tool(&catalog, "claude", "db").access_method,
            "systemSkillCli"
        );
        assert_eq!(tool(&catalog, "aia", "db").access_method, "aiaSystem");
    }

    #[test]
    fn enabled_but_unusable_ssh_is_reported_separately() {
        let catalog = catalog_from_state(
            BuiltinToolState {
                ssh: RegisteredTargets::new(0, 1),
                ..BuiltinToolState::default()
            },
            Vec::new(),
        );
        let ssh = &catalog.agents[0].tools[0];
        assert!(ssh.enabled);
        assert!(!ssh.available);
        assert_eq!(
            ssh.note,
            AgentBuiltinToolNote::SshEndpoints {
                available: 0,
                unusable: 1
            }
        );
    }

    /// 붙는 서비스 이름이 보여야 어떤 플러그인이 연결됐는지 알 수 있다. Antigravity는
    /// 앱이 붙여 주지 못하므로, 앱에서 쓸 수 있는 것과 그 CLI 전역 설정에 실제로 등록된
    /// 것을 갈라 보인다.
    #[test]
    fn external_mcp_is_listed_by_name_and_split_by_registration_on_antigravity() {
        let catalog = catalog_from_state(
            BuiltinToolState {
                mcp_attachable: vec![
                    ("notion".to_owned(), "Notion".to_owned()),
                    ("jira".to_owned(), "Jira · Confluence".to_owned()),
                ],
                mcp_pending: 1,
                mcp_registered_in_antigravity: vec!["notion".to_owned()],
                ..BuiltinToolState::default()
            },
            Vec::new(),
        );
        let aia = tool(&catalog, "aia", "mcp");
        assert!(aia.enabled && aia.available);
        assert_eq!(aia.access_method, "aiaSystem");
        assert!(
            !aia.enablement_requires_new_chat,
            "AIA 프록시 호출은 토글이 즉시 듣는다"
        );
        assert_eq!(
            aia.note,
            AgentBuiltinToolNote::McpAttached {
                names: vec!["Notion".to_owned(), "Jira · Confluence".to_owned()],
                pending: 1
            }
        );

        let claude = tool(&catalog, "claude", "mcp");
        assert_eq!(claude.access_method, "directMcp");
        assert!(
            claude.enablement_requires_new_chat,
            "직접 붙는 서버는 CLI 시작에 고정된다"
        );

        let antigravity = tool(&catalog, "antigravity", "mcp");
        assert!(antigravity.enabled, "등록 자체는 같다");
        assert!(
            antigravity.available,
            "전역 설정에 등록된 플러그인이 하나라도 있으면 쓸 수 있다"
        );
        assert_eq!(antigravity.access_method, "externalMcpConfig");
        assert!(
            antigravity.enablement_requires_new_chat,
            "전역 설정을 읽는 공급자도 CLI 시작에 목록이 고정된다"
        );
        assert_eq!(
            antigravity.note,
            AgentBuiltinToolNote::McpExternalConfig {
                registered: vec!["Notion".to_owned()],
                missing: vec!["Jira · Confluence".to_owned()],
                pending: 1
            }
        );

        // 앱에서 켜 두었더라도 그 CLI 설정에 없으면 그 채팅에서는 쓸 수 없다.
        let unregistered = catalog_from_state(
            BuiltinToolState {
                mcp_attachable: vec![("notion".to_owned(), "Notion".to_owned())],
                ..BuiltinToolState::default()
            },
            Vec::new(),
        );
        let antigravity = tool(&unregistered, "antigravity", "mcp");
        assert!(antigravity.enabled && !antigravity.available);
        assert_eq!(
            antigravity.note,
            AgentBuiltinToolNote::McpExternalConfig {
                registered: Vec::new(),
                missing: vec!["Notion".to_owned()],
                pending: 0
            }
        );
    }

    #[test]
    fn external_mcp_without_registrations_points_at_the_settings_screen() {
        let catalog = catalog_from_state(BuiltinToolState::default(), Vec::new());
        let mcp = tool(&catalog, "codex", "mcp");
        assert!(!mcp.enabled && !mcp.available);
        assert_eq!(mcp.note, AgentBuiltinToolNote::McpNone { pending: 0 });
    }

    /// 그림은 앱 화면이 그리므로 공급자·설정과 무관하게 언제나 같은 값이다.
    #[test]
    fn mermaid_is_available_to_every_agent() {
        let catalog = catalog_from_state(BuiltinToolState::default(), Vec::new());
        for agent in &catalog.agents {
            let mermaid = tool(&catalog, &agent.agent, "mermaid");
            assert!(mermaid.enabled && mermaid.available);
            assert_eq!(mermaid.access_method, "appRender");
            assert!(!mermaid.enablement_requires_new_chat);
        }
        let definition = catalog
            .tools
            .iter()
            .find(|definition| definition.id == "mermaid")
            .unwrap();
        assert!(definition.routes[0]
            .operations
            .contains(&"flowchart".to_owned()));
    }

    #[test]
    fn the_instruction_row_carries_every_tool() {
        let catalog = catalog_from_state(BuiltinToolState::default(), Vec::new());
        let instruction = instruction_for_agent(&catalog, "claude").unwrap();
        assert!(instruction.contains("mcp=비활성"));
        assert!(instruction.contains("mermaid=활성 (사용가능=예, 접근=appRender"));
    }
}
