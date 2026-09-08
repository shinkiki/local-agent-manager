//! 공급자 계정별 외부 MCP·커넥터·플러그인 요약.
//!
//! 목적은 "이 계정에서 어떤 외부 서비스를 쓸 수 있는가"를 아이콘 한 줄로 보여줄 만큼만
//! 모으는 것이다. 그래서 다음 규칙을 지킨다.
//!
//! - 도구를 실행하지 않는다. 공급자 홈에 이미 기록된 설정·카탈로그 메타데이터만 읽는다.
//! - 네트워크를 호출하지 않는다. `tools/list`를 새로 치지 않고, 공급자가 남긴 연결 기록만 본다.
//! - 비밀정보를 읽지 않는다. `auth.json`·`.credentials.json`·Keychain은 건드리지 않고,
//!   계정 귀속은 자격증명 어댑터가 이미 확인해 둔 결과(`observedActiveAccountId`)와
//!   설정 파일이 스스로 기록한 계정 식별자(`.claude.json`의 `oauthAccount`)로만 정한다.
//!
//! ## 계정 귀속
//!
//! Codex와 Claude는 계정을 바꿔도 공급자 홈(`~/.codex`, `~/.claude`) 하나를 공유한다.
//! 그래서 홈에 있는 설정을 그대로 모든 계정에 복제하면 계정 구분이 사라진다. 항목을
//! 두 부류로 나눠 이 문제를 피한다.
//!
//! - 기기 단위 항목(로컬 stdio MCP 서버, CLI에 동봉된 플러그인)은 어느 계정으로 실행해도
//!   똑같이 동작하므로 `Shared`로 모든 계정에 붙인다.
//! - 계정 단위 항목(공급자 계정에 연결된 커넥터, OAuth를 쓰는 원격 MCP 서버)은 지금
//!   홈을 점유한 계정에만 `Account`로 붙이고, 나머지 계정에는 `Unverified`로 남긴다.
//!   다른 계정에도 같은 커넥터가 있을 수 있지만 그 사실을 여기서 확인할 방법이 없다.
//!   없다고 단정하지 않고 미확정으로 둔다.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::accounts::{AccountSnapshot, HomeCredentialState};
use crate::domain::ProviderId;
use crate::user_home;

/// 설정 파일 하나에서 읽어들일 최대 바이트. `.claude.json`은 프로젝트 기록이 쌓이며
/// 커지므로 상한을 둔다.
const MAX_CONFIG_BYTES: u64 = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 응답 타입
// ---------------------------------------------------------------------------

/// 문자열 값과 1:1로 대응하는 계정 도구 열거형에 `ALL`·`as_str`·`Display`·`FromStr`를
/// 한 벌로 붙인다. 세 열거형이 같은 네 덩어리를 각자 적고 있어, 값 하나를 늘릴 때 네 곳을
/// 맞춰 고쳐야 했고 한 곳을 빠뜨려도 컴파일은 지나가 해석만 조용히 어긋났다. 여기서는
/// 변이와 문자열 값의 대응표만 적고 `FromStr`가 그 표를 뒤집어 쓰므로 양방향이 어긋날 수
/// 없다. `$label`은 알 수 없는 값을 만났을 때의 오류 문구 앞머리다.
macro_rules! account_tool_string_enum {
    ($ty:ident, $label:literal, { $($variant:ident => $value:literal),+ $(,)? }) => {
        impl $ty {
            pub const ALL: [Self; [$(stringify!($variant)),+].len()] = [$(Self::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value,)+
                }
            }
        }

        impl std::fmt::Display for $ty {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl std::str::FromStr for $ty {
            type Err = crate::CoreError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                match s.trim() {
                    $($value => Ok(Self::$variant),)+
                    _ => Err(crate::CoreError::InvalidInput(format!(
                        concat!($label, ": {}"),
                        s
                    ))),
                }
            }
        }
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountToolKind {
    /// 공급자 계정에 연결된 커넥터. 로컬 설정 항목 없이 공급자 서버가 관리한다.
    Connector,
    /// 공급자 설정 파일에 등록된 MCP 서버.
    McpServer,
    /// 공급자 플러그인 카탈로그에서 설치·활성화된 플러그인.
    Plugin,
}

account_tool_string_enum!(AccountToolKind, "알 수 없는 계정 도구 종류입니다", {
    Connector => "connector",
    McpServer => "mcpServer",
    Plugin => "plugin",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountToolAttribution {
    /// 이 계정에 귀속된다고 확인했다.
    Account,
    /// 계정과 무관하게 이 기기에서 항상 쓸 수 있다.
    Shared,
    /// 이 계정에서 쓸 수 있는지 확인하지 못했다. 없다는 뜻이 아니다.
    Unverified,
}

account_tool_string_enum!(AccountToolAttribution, "알 수 없는 계정 도구 귀속 종류입니다", {
    Account => "account",
    Shared => "shared",
    Unverified => "unverified",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountToolAccess {
    /// 공급자가 연결 성공을 기록했고, 재인증 대기 목록에도 없다.
    Verified,
    /// 공급자가 재인증 필요로 표시했다.
    NeedsAuth,
    /// 도구를 실행하지 않고는 확인할 수 없어 검증하지 않았다.
    Unknown,
}

account_tool_string_enum!(AccountToolAccess, "알 수 없는 계정 도구 접근 상태입니다", {
    Verified => "verified",
    NeedsAuth => "needsAuth",
    Unknown => "unknown",
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountToolView {
    /// 계정 안에서 유일한 키.
    pub id: String,
    /// 아이콘 매핑에 쓰는 정규화된 서비스 슬러그.
    pub service: String,
    pub label: String,
    pub kind: AccountToolKind,
    pub attribution: AccountToolAttribution,
    /// 공급자 홈에 설정 항목이 존재한다. 커넥터는 로컬 설정이 없어 false다.
    pub configured: bool,
    /// 공급자가 런타임에 노출하는 상태다. 비활성 항목은 애초에 목록에 넣지 않는다.
    pub exposed: bool,
    pub access: AccountToolAccess,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountToolsView {
    pub account_id: String,
    pub provider: ProviderId,
    /// 이 공급자 홈을 점유한 계정을 확인했는지. false면 계정 단위 항목은 모두 미확정이다.
    pub attribution_resolved: bool,
    pub tools: Vec<AccountToolView>,
}

/// 공유 CLI 홈에 실제로 든 로그인(홈 계정)이 쓸 수 있는 도구. 여기서 읽는 설정
/// 자체가 그 홈의 것이라, 계정 단위 항목의 귀속은 등록 계정보다 이 자리가 확실하다 —
/// 커넥터를 붙인 주체가 곧 그때 홈에 들어 있던 로그인이다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHomeToolsView {
    pub provider: ProviderId,
    /// 홈에 든 로그인의 신원을 확인했는지. false면 계정 단위 항목은 미확정으로 남는다 —
    /// 설정은 남아 있어도 그것을 붙인 로그인이 아직 홈에 있는지 알 수 없다.
    pub identified: bool,
    pub tools: Vec<AccountToolView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountToolsSnapshot {
    pub accounts: Vec<AccountToolsView>,
    pub homes: Vec<ProviderHomeToolsView>,
}

// ---------------------------------------------------------------------------
// 수집 대상 경로
// ---------------------------------------------------------------------------

/// 읽을 공급자 홈. 환경변수 재지정은 이 구조체를 만들 때 한 번만 해석한다.
#[derive(Debug, Clone)]
struct ProviderRoots {
    home: PathBuf,
    claude_config_dir: PathBuf,
    codex_home: PathBuf,
}

impl ProviderRoots {
    fn resolve(home: PathBuf) -> Self {
        let claude_config_dir =
            redirected_dir("CLAUDE_CONFIG_DIR").unwrap_or_else(|| home.join(".claude"));
        let codex_home = redirected_dir("CODEX_HOME").unwrap_or_else(|| home.join(".codex"));
        Self {
            home,
            claude_config_dir,
            codex_home,
        }
    }
}

/// 공급자가 홈 위치를 바꿀 때 쓰는 환경변수만 읽는다. 그 밖의 환경변수는 읽지 않는다.
fn redirected_dir(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

// ---------------------------------------------------------------------------
// 수집
// ---------------------------------------------------------------------------

/// 공급자 홈 한 곳에서 읽어낸, 아직 계정에 배분되지 않은 항목.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderTool {
    id: String,
    service: String,
    label: String,
    kind: AccountToolKind,
    /// true면 공급자 계정에 묶인 항목이라 홈을 점유한 계정에만 귀속한다.
    account_scoped: bool,
    configured: bool,
    access: AccountToolAccess,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ProviderTools {
    tools: Vec<ProviderTool>,
    /// 이 홈의 설정이 스스로 기록한 공급자 계정 식별자.
    owner_provider_account_id: Option<String>,
}

/// 계정 스냅샷을 받아 계정별 도구 요약을 만든다. 설정 파일이 없거나 깨져 있으면 그
/// 소스만 건너뛰고, 전체 조회를 실패시키지 않는다.
pub fn list_account_tools(accounts: &AccountSnapshot) -> AccountToolsSnapshot {
    match user_home::optional_home_dir() {
        Some(home) => list_account_tools_in(accounts, &ProviderRoots::resolve(home)),
        // 홈을 못 찾으면 읽을 설정도 없다. 조회 자체를 실패시키지는 않는다.
        None => AccountToolsSnapshot {
            accounts: accounts
                .accounts
                .iter()
                .map(|account| AccountToolsView {
                    account_id: account.id.clone(),
                    provider: account.provider,
                    attribution_resolved: false,
                    tools: Vec::new(),
                })
                .collect(),
            homes: Vec::new(),
        },
    }
}

fn list_account_tools_in(
    accounts: &AccountSnapshot,
    roots: &ProviderRoots,
) -> AccountToolsSnapshot {
    let mut collected: HashMap<ProviderId, ProviderTools> = HashMap::new();
    let mut views = Vec::new();

    for account in &accounts.accounts {
        let provider = account.provider;
        let tools = collected
            .entry(provider)
            .or_insert_with(|| collect_provider_tools(provider, roots));

        // 홈을 점유한 계정: 설정 파일이 직접 기록한 계정 식별자를 먼저 믿고, 없으면
        // 자격증명 어댑터가 공유 홈을 검증해 얻은 실제 활성 계정을 쓴다.
        let observed = accounts
            .providers
            .iter()
            .find(|state| state.provider == provider)
            .and_then(|state| state.observed_active_account_id.clone());
        let owner_account_id = tools
            .owner_provider_account_id
            .as_ref()
            .and_then(|provider_account_id| {
                accounts
                    .accounts
                    .iter()
                    .find(|candidate| {
                        candidate.provider == provider
                            && &candidate.provider_account_id == provider_account_id
                    })
                    .map(|candidate| candidate.id.clone())
            })
            .or(observed);
        let owns_home = owner_account_id.as_deref() == Some(account.id.as_str());

        views.push(AccountToolsView {
            account_id: account.id.clone(),
            provider,
            attribution_resolved: owner_account_id.is_some(),
            tools: account_tool_views(&tools.tools, owns_home),
        });
    }

    // 홈 계정 몫. 등록 계정이 하나도 없는 공급자에도 홈 로그인은 있을 수 있으므로
    // 위 반복이 채워 둔 캐시에 기대지 않고 필요하면 여기서 읽는다.
    let homes = accounts
        .providers
        .iter()
        .filter(|state| state.provider.manages_accounts())
        .map(|state| {
            let provider = state.provider;
            let tools = collected
                .entry(provider)
                .or_insert_with(|| collect_provider_tools(provider, roots));
            let identified = state.home.state == HomeCredentialState::Verified;
            ProviderHomeToolsView {
                provider,
                identified,
                tools: account_tool_views(&tools.tools, identified),
            }
        })
        .collect();

    AccountToolsSnapshot {
        accounts: views,
        homes,
    }
}

/// 수집한 공급자 항목을 한 소유자(계정 하나 또는 공급자 홈) 몫의 표시 항목으로 옮긴다.
///
/// `owns_home`은 그 소유자가 지금 공급자 홈을 점유했다고 확인됐는지다. 계정 단위 항목의
/// 귀속과 접근 표시가 모두 이 한 값에 달려 있어, 계정 몫과 홈 몫이 각자 같은 판정을
/// 나열하면 한쪽만 고쳐 두 화면이 갈라지기 쉽다.
fn account_tool_views(tools: &[ProviderTool], owns_home: bool) -> Vec<AccountToolView> {
    tools
        .iter()
        .map(|tool| AccountToolView {
            id: tool.id.clone(),
            service: tool.service.clone(),
            label: tool.label.clone(),
            kind: tool.kind,
            attribution: if !tool.account_scoped {
                AccountToolAttribution::Shared
            } else if owns_home {
                AccountToolAttribution::Account
            } else {
                AccountToolAttribution::Unverified
            },
            configured: tool.configured,
            exposed: true,
            // 계정 귀속을 확인하지 못한 항목에 접근 검증 결과를 그대로 옮기면 다른
            // 계정의 연결 이력을 이 계정 것처럼 보여주게 된다.
            access: if tool.account_scoped && !owns_home {
                AccountToolAccess::Unknown
            } else {
                tool.access
            },
        })
        .collect()
}

fn collect_provider_tools(provider: ProviderId, roots: &ProviderRoots) -> ProviderTools {
    match provider {
        ProviderId::Claude => collect_claude_tools(roots),
        ProviderId::Codex => collect_codex_tools(roots),
        // Antigravity CLI는 계정 등록 대상이 아니고 MCP·커넥터 설정도 노출하지 않는다.
        ProviderId::Antigravity => ProviderTools::default(),
    }
}

/// 상한 안에서만 파일을 읽는다. 없거나 크거나 읽을 수 없으면 None.
fn read_bounded(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// 설정 항목 이름 하나에서 뽑아낸 식별자·서비스 슬러그·표시 이름.
///
/// 공급자별 수집 루프 다섯 벌이 모두 "슬러그를 만들고, 비면 건너뛰고, 슬러그로
/// 표시 이름을 뽑고, `공급자:종류:원래이름`으로 식별자를 만든다"를 되풀이했다.
/// 규칙이 한곳에만 있어야 공급자를 늘려도 식별자 모양이 갈라지지 않는다.
struct ToolIdentity {
    id: String,
    service: String,
    label: String,
}

impl ToolIdentity {
    /// `segment`는 식별자의 종류 자리다. `AccountToolKind::as_str`은 프런트 직렬화
    /// 표기(`mcpServer`)라 식별자 표기(`mcp-server`)와 다르므로 따로 받는다.
    fn new(provider: &str, segment: &str, name: &str) -> Option<Self> {
        let service = service_slug(name);
        if service.is_empty() {
            return None;
        }
        Some(Self {
            id: format!("{provider}:{segment}:{name}"),
            label: service_label(&service),
            service,
        })
    }

    fn into_tool(
        self,
        kind: AccountToolKind,
        account_scoped: bool,
        configured: bool,
        access: AccountToolAccess,
    ) -> ProviderTool {
        ProviderTool {
            id: self.id,
            label: self.label,
            service: self.service,
            kind,
            account_scoped,
            configured,
            access,
        }
    }
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeConfig {
    #[serde(default)]
    mcp_servers: BTreeMap<String, ClaudeMcpServer>,
    /// claude.ai 커넥터 중 한 번이라도 연결에 성공한 항목. 공급자 계정에 묶인다.
    #[serde(default)]
    claude_ai_mcp_ever_connected: Vec<String>,
    #[serde(default)]
    oauth_account: Option<ClaudeOauthAccount>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeMcpServer {
    #[serde(default, rename = "type")]
    transport: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    command: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeOauthAccount {
    #[serde(default, alias = "accountId")]
    account_uuid: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ClaudeInstalledPlugins {
    #[serde(default)]
    plugins: BTreeMap<String, Value>,
}

fn collect_claude_tools(roots: &ProviderRoots) -> ProviderTools {
    let config_dir = &roots.claude_config_dir;
    // 자격증명 어댑터의 신원 조회와 같은 후보 순서를 쓴다.
    let config = [
        config_dir.join(".claude.json"),
        config_dir.join(".config.json"),
        roots.home.join(".claude.json"),
    ]
    .iter()
    .filter_map(|path| read_bounded(path))
    .find_map(|raw| serde_json::from_str::<ClaudeConfig>(&raw).ok())
    .unwrap_or_default();

    let needs_auth = read_bounded(&config_dir.join("mcp-needs-auth-cache.json"))
        .and_then(|raw| serde_json::from_str::<BTreeMap<String, Value>>(&raw).ok())
        .map(|cache| cache.into_keys().collect::<BTreeSet<_>>())
        .unwrap_or_default();

    let mut tools = Vec::new();

    for (name, server) in &config.mcp_servers {
        // stdio 서버는 이 기기의 실행 파일을 그대로 띄우므로 계정과 무관하다. 원격
        // 전송(http/sse)은 공급자 계정 인증을 타므로 계정 단위로 본다.
        let remote = server.url.is_some()
            || matches!(server.transport.as_deref(), Some("http" | "sse"))
            || server.command.is_none();
        let Some(identity) = ToolIdentity::new("claude", "mcp-server", name) else {
            continue;
        };
        let access = if needs_auth.contains(name) {
            AccountToolAccess::NeedsAuth
        } else {
            AccountToolAccess::Unknown
        };
        tools.push(identity.into_tool(AccountToolKind::McpServer, remote, true, access));
    }

    for name in &config.claude_ai_mcp_ever_connected {
        let Some(identity) = ToolIdentity::new("claude", "connector", name) else {
            continue;
        };
        let needs_reauth = needs_auth.contains(name) || needs_auth.contains(&identity.service);
        let access = if needs_reauth {
            AccountToolAccess::NeedsAuth
        } else {
            // 연결 성공 기록이 있고 재인증 대기 목록에도 없다.
            AccountToolAccess::Verified
        };
        // claude.ai 커넥터는 공급자 서버가 보관한다. 로컬 설정 항목이 없다.
        tools.push(identity.into_tool(AccountToolKind::Connector, true, false, access));
    }

    let installed = read_bounded(&config_dir.join("plugins").join("installed_plugins.json"))
        .and_then(|raw| serde_json::from_str::<ClaudeInstalledPlugins>(&raw).ok())
        .unwrap_or_default();
    for name in installed.plugins.keys() {
        let Some(identity) = ToolIdentity::new("claude", "plugin", name) else {
            continue;
        };
        // 마켓플레이스 플러그인은 홈에 설치된 파일이라 계정과 무관하다.
        tools.push(identity.into_tool(
            AccountToolKind::Plugin,
            false,
            true,
            AccountToolAccess::Unknown,
        ));
    }

    ProviderTools {
        tools,
        owner_provider_account_id: config
            .oauth_account
            .and_then(|account| account.account_uuid)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty()),
    }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct CodexConfig {
    #[serde(default)]
    mcp_servers: BTreeMap<String, CodexMcpServer>,
    #[serde(default)]
    plugins: BTreeMap<String, CodexPlugin>,
}

#[derive(Debug, Default, Deserialize)]
struct CodexMcpServer {
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
struct CodexPlugin {
    #[serde(default)]
    enabled: Option<bool>,
}

/// CLI에 동봉되거나 런타임이 직접 제공하는 플러그인 출처. 계정 연결이 필요 없다.
const CODEX_BUNDLED_PLUGIN_SOURCES: &[&str] = &["openai-bundled", "openai-primary-runtime"];

fn collect_codex_tools(roots: &ProviderRoots) -> ProviderTools {
    let config = read_bounded(&roots.codex_home.join("config.toml"))
        .and_then(|raw| toml::from_str::<CodexConfig>(&raw).ok())
        .unwrap_or_default();

    let mut tools = Vec::new();

    for (name, server) in &config.mcp_servers {
        if server.enabled == Some(false) {
            continue;
        }
        let Some(identity) = ToolIdentity::new("codex", "mcp-server", name) else {
            continue;
        };
        let remote = server.url.is_some() || server.command.is_none();
        tools.push(identity.into_tool(
            AccountToolKind::McpServer,
            remote,
            true,
            AccountToolAccess::Unknown,
        ));
    }

    for (id, plugin) in &config.plugins {
        if plugin.enabled == Some(false) {
            continue;
        }
        let Some(identity) = ToolIdentity::new("codex", "plugin", id) else {
            continue;
        };
        // `name@source` 형식의 뒤쪽이 배포 출처다. 큐레이션 커넥터는 ChatGPT 계정
        // 연결을 거치고, 동봉 플러그인은 CLI와 함께 설치되어 계정과 무관하다.
        let source = id.split_once('@').map(|(_, source)| source).unwrap_or("");
        let bundled = CODEX_BUNDLED_PLUGIN_SOURCES.contains(&source);
        tools.push(identity.into_tool(
            AccountToolKind::Plugin,
            !bundled,
            true,
            AccountToolAccess::Unknown,
        ));
    }

    ProviderTools {
        tools,
        // Codex 설정에는 계정 식별자가 없다. 귀속은 자격증명 어댑터가 확인한 실제
        // 활성 계정에 맡긴다. auth.json은 비밀정보라 여기서 읽지 않는다.
        owner_provider_account_id: None,
    }
}

// ---------------------------------------------------------------------------
// 서비스 이름 정규화
// ---------------------------------------------------------------------------

const SERVICE_LABELS: &[(&str, &str)] = &[
    ("atlassian", "Atlassian"),
    ("browser", "Browser"),
    ("chrome", "Chrome"),
    ("claude-code-remote", "Claude Code Remote"),
    ("cloudflare", "Cloudflare"),
    ("codex", "Codex"),
    ("computer-use", "Computer Use"),
    ("documents", "Documents"),
    ("dropbox", "Dropbox"),
    ("fetch", "Fetch"),
    ("figma", "Figma"),
    ("filesystem", "Filesystem"),
    ("github", "GitHub"),
    ("gitlab", "GitLab"),
    ("gmail", "Gmail"),
    ("google-calendar", "Google Calendar"),
    ("google-drive", "Google Drive"),
    ("jira", "Jira"),
    ("linear", "Linear"),
    ("memory", "Memory"),
    ("node-repl", "Node REPL"),
    ("notion", "Notion"),
    ("openai-developer-docs", "OpenAI Developer Docs"),
    ("pdf", "PDF"),
    ("playwright", "Playwright"),
    ("postgres", "PostgreSQL"),
    ("presentations", "Presentations"),
    ("sentry", "Sentry"),
    ("sites", "Sites"),
    ("slack", "Slack"),
    ("spreadsheets", "Spreadsheets"),
    ("stripe", "Stripe"),
    ("supabase", "Supabase"),
    ("teams", "Microsoft Teams"),
    ("template-creator", "Template Creator"),
    ("vercel", "Vercel"),
    ("visualize", "Visualize"),
];

/// 공급자마다 다른 표기(`notion`, `claude.ai Notion`, `notion@openai-curated`,
/// `openaiDeveloperDocs`, `node_repl`)를 하나의 슬러그로 모은다.
fn service_slug(raw: &str) -> String {
    let mut value = raw.trim().to_owned();
    // claude.ai 커넥터는 공통 접두사를 달고 온다.
    for prefix in ["claude.ai ", "claude.ai-"] {
        if let Some(rest) = value.strip_prefix(prefix) {
            value = rest.to_owned();
            break;
        }
    }
    // `name@source` 형식은 앞쪽 이름만 서비스다.
    if let Some((name, _)) = value.split_once('@') {
        value = name.to_owned();
    }
    // camelCase 경계를 구분자로 바꾼 뒤 소문자로 모은다.
    let mut spaced = String::with_capacity(value.len() + 8);
    let mut previous_lower = false;
    for character in value.chars() {
        if previous_lower && character.is_uppercase() {
            spaced.push('-');
        }
        previous_lower = character.is_lowercase() || character.is_ascii_digit();
        spaced.push(character);
    }
    let normalized = spaced
        .to_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();

    let mut slug = String::with_capacity(normalized.len());
    for segment in normalized.split('-').filter(|segment| !segment.is_empty()) {
        if !slug.is_empty() {
            slug.push('-');
        }
        slug.push_str(segment);
    }
    // MCP 서버 이름에 흔한 장식은 서비스 구분에 쓸모가 없다.
    for prefix in ["mcp-server-", "mcp-", "server-"] {
        if let Some(rest) = slug.strip_prefix(prefix) {
            slug = rest.to_owned();
            break;
        }
    }
    for suffix in ["-mcp-server", "-mcp", "-server"] {
        if let Some(rest) = slug.strip_suffix(suffix) {
            slug = rest.to_owned();
            break;
        }
    }
    slug
}

fn service_label(slug: &str) -> String {
    if let Some((_, label)) = SERVICE_LABELS.iter().find(|(key, _)| *key == slug) {
        return (*label).to_owned();
    }
    let mut label = String::with_capacity(slug.len());
    for segment in slug.split('-').filter(|segment| !segment.is_empty()) {
        if !label.is_empty() {
            label.push(' ');
        }
        let mut characters = segment.chars();
        if let Some(first) = characters.next() {
            label.extend(first.to_uppercase());
            label.push_str(characters.as_str());
        }
    }
    label
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::accounts::{
        AccountAuthStatus, AccountUsageView, ProviderAccountStateView, ProviderAccountView,
    };

    fn roots(home: &Path) -> ProviderRoots {
        ProviderRoots {
            home: home.to_path_buf(),
            claude_config_dir: home.join(".claude"),
            codex_home: home.join(".codex"),
        }
    }

    fn account(id: &str, provider: ProviderId, provider_account_id: &str) -> ProviderAccountView {
        ProviderAccountView {
            id: id.to_owned(),
            provider,
            display_name: id.to_owned(),
            email: None,
            organization: None,
            provider_account_id: provider_account_id.to_owned(),
            label: None,
            provider_display_name: id.to_owned(),
            is_active: false,
            disabled: false,
            auto_switch: false,
            auto_switch_priority: None,
            auth_status: AccountAuthStatus::Ready,
            usage: AccountUsageView::default(),
            note: None,
            credential_isolated: false,
            credential_isolation_note: None,
            runtime_count: 0,
        }
    }

    fn snapshot(
        accounts: Vec<ProviderAccountView>,
        provider: ProviderId,
        observed_active_account_id: Option<&str>,
    ) -> AccountSnapshot {
        AccountSnapshot {
            accounts,
            providers: vec![ProviderAccountStateView {
                provider,
                active_account_id: None,
                observed_active_account_id: observed_active_account_id.map(str::to_owned),
                runtime_count: 0,
                last_auto_switch: None,
                home: crate::accounts::ProviderHomeView::default(),
            }],
            auto_switch_resume: true,
            auto_switch_policy: crate::AutoSwitchPolicy::default(),
            auto_switch_usage_gap_percent: None,
            resume_account_policy: crate::ResumeAccountPolicy::default(),
        }
    }

    fn snapshot_with_home(
        accounts: Vec<ProviderAccountView>,
        provider: ProviderId,
        state: HomeCredentialState,
    ) -> AccountSnapshot {
        let mut result = snapshot(accounts, provider, None);
        result.providers[0].home.state = state;
        result
    }

    fn home(result: &AccountToolsSnapshot, provider: ProviderId) -> &ProviderHomeToolsView {
        result
            .homes
            .iter()
            .find(|view| view.provider == provider)
            .expect("홈 계정 요약이 있어야 한다")
    }

    fn view<'a>(result: &'a AccountToolsSnapshot, account_id: &str) -> &'a AccountToolsView {
        result
            .accounts
            .iter()
            .find(|view| view.account_id == account_id)
            .expect("계정 요약이 있어야 한다")
    }

    fn find<'a>(view: &'a AccountToolsView, service: &str) -> &'a AccountToolView {
        find_tool(&view.tools, service)
    }

    fn find_tool<'a>(tools: &'a [AccountToolView], service: &str) -> &'a AccountToolView {
        tools
            .iter()
            .find(|tool| tool.service == service)
            .unwrap_or_else(|| panic!("{service} 항목이 있어야 한다"))
    }

    fn temporary_home() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("agent-manager-account-tools-")
            .tempdir()
            .expect("temporary home must be created")
    }

    #[test]
    fn normalizes_every_provider_naming_style_to_one_service_slug() {
        assert_eq!(service_slug("notion"), "notion");
        assert_eq!(service_slug("claude.ai Notion"), "notion");
        assert_eq!(service_slug("notion@openai-curated"), "notion");
        assert_eq!(service_slug("openaiDeveloperDocs"), "openai-developer-docs");
        assert_eq!(service_slug("node_repl"), "node-repl");
        assert_eq!(
            service_slug("google-calendar@openai-curated"),
            "google-calendar"
        );
        assert_eq!(service_slug("mcp-server-github"), "github");
        assert_eq!(
            service_slug("claude.ai Claude Code Remote"),
            "claude-code-remote"
        );
        assert_eq!(service_slug("  "), "");
    }

    #[test]
    fn labels_known_services_and_title_cases_the_rest() {
        assert_eq!(service_label("github"), "GitHub");
        assert_eq!(service_label("google-calendar"), "Google Calendar");
        assert_eq!(service_label("acme-internal"), "Acme Internal");
        assert_eq!(service_label(""), "");
    }

    #[test]
    fn claude_attributes_connectors_to_the_account_recorded_in_the_shared_config() {
        let home = temporary_home();
        let claude_dir = home.path().join(".claude");
        fs::create_dir_all(claude_dir.join("plugins")).expect("claude plugin directory");
        fs::write(
            home.path().join(".claude.json"),
            serde_json::json!({
                "oauthAccount": {"accountUuid": "uuid-b"},
                "claudeAiMcpEverConnected": ["claude.ai Notion", "claude.ai Figma"],
                "mcpServers": {
                    "notion": {"type": "http", "url": "https://mcp.notion.com/mcp"},
                    "node_repl": {"type": "stdio", "command": "node"}
                }
            })
            .to_string(),
        )
        .expect("claude config must be written");
        fs::write(
            claude_dir.join("mcp-needs-auth-cache.json"),
            r#"{"figma":{"timestamp":1}}"#,
        )
        .expect("needs auth cache must be written");
        fs::write(
            claude_dir.join("plugins").join("installed_plugins.json"),
            r#"{"version":2,"plugins":{"nights-watch@market":[]}}"#,
        )
        .expect("installed plugins must be written");

        // 관측된 활성 계정은 a지만, 설정 파일이 스스로 b를 기록했으므로 b가 소유자다.
        let result = list_account_tools_in(
            &snapshot(
                vec![
                    account("a", ProviderId::Claude, "uuid-a"),
                    account("b", ProviderId::Claude, "uuid-b"),
                ],
                ProviderId::Claude,
                Some("a"),
            ),
            &roots(home.path()),
        );
        let owner = view(&result, "b");
        let other = view(&result, "a");
        assert!(owner.attribution_resolved && other.attribution_resolved);

        // 계정에 묶인 커넥터와 원격 MCP는 홈을 점유한 계정에만 확정된다.
        assert_eq!(
            find(owner, "notion").attribution,
            AccountToolAttribution::Account
        );
        assert_eq!(
            find(other, "notion").attribution,
            AccountToolAttribution::Unverified
        );
        // 로컬 stdio 서버와 설치된 플러그인은 계정과 무관하게 쓸 수 있다.
        assert_eq!(
            find(other, "node-repl").attribution,
            AccountToolAttribution::Shared
        );
        assert_eq!(
            find(other, "nights-watch").attribution,
            AccountToolAttribution::Shared
        );
        // 재인증 대기 표시는 소유 계정에서만 그대로 노출한다.
        assert_eq!(find(owner, "figma").access, AccountToolAccess::NeedsAuth);
        assert_eq!(find(other, "figma").access, AccountToolAccess::Unknown);
        // 연결 성공 기록만 있는 커넥터는 로컬 설정 없이 검증됨으로 남는다.
        let connector = owner
            .tools
            .iter()
            .find(|tool| tool.kind == AccountToolKind::Connector && tool.service == "notion")
            .expect("notion 커넥터가 있어야 한다");
        assert_eq!(connector.access, AccountToolAccess::Verified);
        assert!(!connector.configured);
    }

    #[test]
    fn codex_curated_plugins_follow_the_observed_active_account() {
        let home = temporary_home();
        let codex_home = home.path().join(".codex");
        fs::create_dir_all(&codex_home).expect("codex home must be created");
        fs::write(
            codex_home.join("config.toml"),
            r#"
model = "gpt-5"

[features]
multi_agent = true

[mcp_servers.node_repl]
command = "node"

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"

[mcp_servers.retired]
command = "node"
enabled = false

[plugins."notion@openai-curated"]
enabled = true

[plugins."browser@openai-bundled"]
enabled = true

[plugins."gmail@openai-curated"]
enabled = false
"#,
        )
        .expect("codex config must be written");

        let result = list_account_tools_in(
            &snapshot(
                vec![
                    account("a", ProviderId::Codex, "user-a"),
                    account("b", ProviderId::Codex, "user-b"),
                ],
                ProviderId::Codex,
                Some("a"),
            ),
            &roots(home.path()),
        );
        let active = view(&result, "a");
        let other = view(&result, "b");

        assert_eq!(
            find(active, "notion").attribution,
            AccountToolAttribution::Account
        );
        assert_eq!(
            find(other, "notion").attribution,
            AccountToolAttribution::Unverified
        );
        assert_eq!(
            find(other, "browser").attribution,
            AccountToolAttribution::Shared
        );
        assert_eq!(
            find(other, "node-repl").attribution,
            AccountToolAttribution::Shared
        );
        assert_eq!(
            find(active, "openai-developer-docs").attribution,
            AccountToolAttribution::Account
        );
        // 비활성 항목은 노출 목록에 넣지 않는다.
        assert!(active.tools.iter().all(|tool| tool.service != "gmail"));
        assert!(active.tools.iter().all(|tool| tool.service != "retired"));
    }

    #[test]
    fn keeps_account_scoped_entries_unverified_when_the_home_owner_is_unknown() {
        let home = temporary_home();
        let codex_home = home.path().join(".codex");
        fs::create_dir_all(&codex_home).expect("codex home must be created");
        fs::write(
            codex_home.join("config.toml"),
            "[plugins.\"figma@openai-curated\"]\nenabled = true\n",
        )
        .expect("codex config must be written");

        let result = list_account_tools_in(
            &snapshot(
                vec![account("a", ProviderId::Codex, "user-a")],
                ProviderId::Codex,
                None,
            ),
            &roots(home.path()),
        );
        let only = view(&result, "a");
        assert!(!only.attribution_resolved);
        assert_eq!(
            find(only, "figma").attribution,
            AccountToolAttribution::Unverified
        );
    }

    #[test]
    fn missing_provider_configuration_yields_an_empty_list_instead_of_an_error() {
        let home = temporary_home();
        let roots = roots(home.path());
        assert!(collect_claude_tools(&roots).tools.is_empty());
        assert!(collect_codex_tools(&roots).tools.is_empty());
        assert!(collect_provider_tools(ProviderId::Antigravity, &roots)
            .tools
            .is_empty());
    }

    #[test]
    fn claude_uses_the_next_config_candidate_when_the_first_is_malformed() {
        let home = temporary_home();
        let claude_dir = home.path().join(".claude");
        fs::create_dir_all(&claude_dir).expect("claude config directory");
        fs::write(claude_dir.join(".claude.json"), "{").expect("malformed preferred config");
        fs::write(
            home.path().join(".claude.json"),
            r#"{"mcpServers":{"notion":{"type":"http","url":"https://mcp.notion.com/mcp"}}}"#,
        )
        .expect("valid fallback config");

        let tools = collect_claude_tools(&roots(home.path()));
        assert_eq!(tools.tools.len(), 1);
        assert_eq!(tools.tools[0].service, "notion");
    }

    /// 홈에 있는 설정을 붙인 주체가 곧 홈에 든 로그인이므로, 신원을 확인했으면
    /// 계정 단위 항목의 귀속은 등록 계정 쪽보다 여기가 확실하다.
    #[test]
    fn home_tools_attribute_account_scoped_items_to_the_verified_home_login() {
        let home_dir = temporary_home();
        fs::write(
            home_dir.path().join(".claude.json"),
            serde_json::json!({
                "claudeAiMcpEverConnected": ["claude.ai Notion"],
                "mcpServers": {
                    "notion": {"type": "http", "url": "https://mcp.notion.com/mcp"},
                    "node_repl": {"type": "stdio", "command": "node"}
                }
            })
            .to_string(),
        )
        .expect("claude config must be written");

        let verified = list_account_tools_in(
            &snapshot_with_home(
                Vec::new(),
                ProviderId::Claude,
                HomeCredentialState::Verified,
            ),
            &roots(home_dir.path()),
        );
        let view = home(&verified, ProviderId::Claude);
        assert!(view.identified);
        assert_eq!(
            find_tool(&view.tools, "notion").attribution,
            AccountToolAttribution::Account
        );
        assert_eq!(
            find_tool(&view.tools, "node-repl").attribution,
            AccountToolAttribution::Shared
        );

        // 신원을 확인하지 못했으면 설정이 남아 있어도 그것을 붙인 로그인이 아직
        // 홈에 있는지 알 수 없다. 없다고 단정하지 않고 미확정으로 둔다.
        let absent = list_account_tools_in(
            &snapshot_with_home(Vec::new(), ProviderId::Claude, HomeCredentialState::Absent),
            &roots(home_dir.path()),
        );
        let view = home(&absent, ProviderId::Claude);
        assert!(!view.identified);
        assert_eq!(
            find_tool(&view.tools, "notion").attribution,
            AccountToolAttribution::Unverified
        );
        assert_eq!(
            find_tool(&view.tools, "notion").access,
            AccountToolAccess::Unknown
        );
        assert_eq!(
            find_tool(&view.tools, "node-repl").attribution,
            AccountToolAttribution::Shared
        );
    }

    #[test]
    fn serializes_the_frontend_contract_in_camel_case() {
        let value = serde_json::to_value(AccountToolsSnapshot {
            accounts: vec![AccountToolsView {
                account_id: "a".to_owned(),
                provider: ProviderId::Claude,
                attribution_resolved: true,
                tools: vec![AccountToolView {
                    id: "claude:connector:claude.ai Notion".to_owned(),
                    service: "notion".to_owned(),
                    label: "Notion".to_owned(),
                    kind: AccountToolKind::Connector,
                    attribution: AccountToolAttribution::Unverified,
                    configured: false,
                    exposed: true,
                    access: AccountToolAccess::NeedsAuth,
                }],
            }],
            homes: vec![ProviderHomeToolsView {
                provider: ProviderId::Claude,
                identified: true,
                tools: vec![AccountToolView {
                    id: "claude:connector:claude.ai Notion".to_owned(),
                    service: "notion".to_owned(),
                    label: "Notion".to_owned(),
                    kind: AccountToolKind::Connector,
                    attribution: AccountToolAttribution::Account,
                    configured: false,
                    exposed: true,
                    access: AccountToolAccess::NeedsAuth,
                }],
            }],
        })
        .expect("snapshot must serialize");

        assert_eq!(value["homes"][0]["provider"], "claude");
        assert_eq!(value["homes"][0]["identified"], true);
        assert_eq!(value["homes"][0]["tools"][0]["attribution"], "account");
        assert_eq!(value["accounts"][0]["accountId"], "a");
        assert_eq!(value["accounts"][0]["attributionResolved"], true);
        assert_eq!(value["accounts"][0]["tools"][0]["kind"], "connector");
        assert_eq!(
            value["accounts"][0]["tools"][0]["attribution"],
            "unverified"
        );
        assert_eq!(value["accounts"][0]["tools"][0]["access"], "needsAuth");
    }

    #[test]
    fn account_tool_kind_display_and_from_str_round_trip() {
        assert_eq!(
            AccountToolKind::ALL,
            [
                AccountToolKind::Connector,
                AccountToolKind::McpServer,
                AccountToolKind::Plugin,
            ]
        );
        for kind in AccountToolKind::ALL {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(kind.as_str().parse::<AccountToolKind>().unwrap(), kind);
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
            let deserialized: AccountToolKind = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, kind);
        }
        assert!(matches!(
            "unknown".parse::<AccountToolKind>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn account_tool_attribution_display_and_from_str_round_trip() {
        assert_eq!(
            AccountToolAttribution::ALL,
            [
                AccountToolAttribution::Account,
                AccountToolAttribution::Shared,
                AccountToolAttribution::Unverified,
            ]
        );
        for attribution in AccountToolAttribution::ALL {
            assert_eq!(attribution.to_string(), attribution.as_str());
            assert_eq!(
                attribution
                    .as_str()
                    .parse::<AccountToolAttribution>()
                    .unwrap(),
                attribution
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&attribution).unwrap();
            assert_eq!(serialized, format!("\"{}\"", attribution.as_str()));
            let deserialized: AccountToolAttribution = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, attribution);
        }
        assert!(matches!(
            "unknown".parse::<AccountToolAttribution>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn account_tool_access_display_and_from_str_round_trip() {
        assert_eq!(
            AccountToolAccess::ALL,
            [
                AccountToolAccess::Verified,
                AccountToolAccess::NeedsAuth,
                AccountToolAccess::Unknown,
            ]
        );
        for access in AccountToolAccess::ALL {
            assert_eq!(access.to_string(), access.as_str());
            assert_eq!(
                access.as_str().parse::<AccountToolAccess>().unwrap(),
                access
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&access).unwrap();
            assert_eq!(serialized, format!("\"{}\"", access.as_str()));
            let deserialized: AccountToolAccess = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, access);
        }
        assert!(matches!(
            "invalid".parse::<AccountToolAccess>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }
}
