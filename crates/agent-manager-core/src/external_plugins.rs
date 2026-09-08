//! 외부 플러그인: 일반 채팅에 직접 붙이고 AIA에는 typed proxy로 노출하는 외부 MCP 서버.
//!
//! Notion처럼 인증이 필요한 서비스를 CLI 채팅에서 도구로 쓰려면 세 가지가 필요하다.
//! 서버 주소와 인증 방식을 담은 **매니페스트**, 사용자가 한 번 승인해 둔 **자격증명**,
//! 그리고 CLI에게 자격증명을 노출하지 않고 요청을 대신 전달하는 **loopback 프록시**다.
//! 이 모듈은 앞의 둘과 프록시가 쓰는 인증 해석을 맡고, 프록시 HTTP 처리는
//! `system_mcp.rs`의 loopback 서버가 같은 프로세스에서 담당한다.
//!
//! 설계 결정(2026-08-30, 사용자):
//! - **기기 단위**다. 토큰은 공급자 계정과 무관하게 이 기기에서 하나만 갖는다.
//! - **원격 UI 인증은 지원하지 않는다.** OAuth 콜백은 호스트의 loopback으로만 돌아오고
//!   토큰 입력은 원격 경로로 받지 않는다. 사용 토글과 연결 확인만 원격에서 할 수 있다.
//! - Notion은 두 방식을 모두 지원한다. 호스팅 서버(`mcp.notion.com`)는 OAuth 전용이고
//!   내부 통합 토큰(`ntn_…`)을 받지 않으므로, 토큰 방식은 노션의 공식 오픈소스 서버
//!   `@notionhq/notion-mcp-server`를 이 백엔드가 loopback HTTP 모드로 띄워 연결한다.
//!
//! 설계 결정(2026-09-02, 사용자):
//! - **도구마다 허용·확인·제한**을 고른다. 제한은 프록시가 목록에서 감추고 호출을 막고,
//!   허용은 승인 카드를 띄우지 않는다. 저장하지 않은 도구는 확인이다.
//! - Jira(아틀라시안)는 Notion과 같은 동적 등록 서버라 OAuth 한 번으로 붙고, scope는
//!   사용자가 고른다. GitHub은 동적 등록이 없어 디바이스 인가로 붙인다.
//!
//! 비밀값은 OS 보안 저장소(macOS Keychain, 그 외 `keyring`)에만 두고, 저장 파일
//! `external-plugins.json`에는 존재 여부와 시각만 남긴다(G4). 프록시가 붙이는
//! `Authorization` 헤더 값과 내장 Notion 서버의 환경변수는 이 모듈 밖으로 나가지 않는다.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::blocking::Client;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, WWW_AUTHENTICATE,
};
use reqwest::redirect::Policy;
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::accounts::{
    delete_os_keychain_password, read_os_keychain_password, write_os_keychain_password,
};
use crate::clock::now_ms;
use crate::credential_profiles;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::mcp_registry::{parse_tools, McpHttpSession};
use crate::text_limit;
use crate::CoreError;

const STORE_VERSION: u32 = 1;
const STORE: JsonStore = JsonStore {
    file: "external-plugins.json",
    lock_file: "external-plugins.lock",
    label: "외부 플러그인 저장소",
    version: STORE_VERSION,
};
/// OS 보안 저장소 항목의 service. account는 플러그인 id다.
const KEYCHAIN_SERVICE: &str = "Agent Manager External Plugins";
pub const MAX_PLUGINS: usize = 16;
/// 프록시가 원격에서 받아 CLI로 넘기는 응답 본문 상한. Notion 페이지 본문은 수백 KB가
/// 흔해 AIA 인터페이스(512 KB)보다 넉넉히 잡는다.
pub const MAX_PROXY_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROXY_TIMEOUT: Duration = Duration::from_secs(120);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
/// 브라우저 승인을 기다리는 최대 시간.
const OAUTH_CALLBACK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// 만료 이 시간 전부터는 access token을 미리 갱신한다.
const ACCESS_TOKEN_REFRESH_MARGIN_MS: i64 = 60_000;
/// 내장 Notion 서버가 포트를 열기까지 기다리는 시간. 첫 실행은 npx가 패키지를 내려받는다.
const MANAGED_SERVER_READY_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_TOKEN_CHARS: usize = 4096;

pub const NOTION_HOSTED_MCP_URL: &str = "https://mcp.notion.com/mcp";
pub const NOTION_LOCAL_SERVER_PACKAGE: &str = "@notionhq/notion-mcp-server";
const OAUTH_CLIENT_NAME: &str = "Agent Manager";

/// 공급자 공식 원격 MCP 프리셋. URL·인증 방식·scope의 단일 원천으로, 화면 프리셋과
/// authorize scope 결정, 디스커버리 폴백이 모두 이 테이블을 본다.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedMcpPreset {
    pub id: &'static str,
    pub display_name: &'static str,
    pub url: &'static str,
    pub auth: PluginAuthKind,
    /// 화면이 아이콘과 안내 문구를 고르는 브랜드 키.
    pub brand: &'static str,
    /// authorize 요청에 쓰는 기본 scope. 화면은 등록 폼에 이 값을 미리 채운다.
    pub default_scope: &'static str,
    /// 화면에서 켜고 끌 수 있는 scope 목록. 비어 있으면 자유 입력만 받는다.
    pub available_scopes: &'static [&'static str],
    /// scope 결정 규칙. 화면에는 보내지 않는다.
    #[serde(skip)]
    scope_mode: ScopeMode,
}

/// 프리셋 기본 scope를 디스커버리 결과보다 앞세울지. 아틀라시안·GitHub은 보호 자원
/// 메타데이터에 삭제·관리 scope까지 전부 싣기 때문에, 그대로 요청하면 필요 없는 권한까지
/// 동의받게 된다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopeMode {
    /// 디스커버리가 scope를 주지 않을 때만 기본값을 쓴다(구글).
    Fallback,
    /// 디스커버리 scope가 있어도 기본값을 쓴다(아틀라시안·GitHub).
    Override,
}

/// 아틀라시안 원격 MCP가 광고하는 scope 가운데 화면에 내보내는 것들. 전체 목록에는
/// Loom·Talent 등 대부분의 사용자에게 없는 제품까지 들어 있어 골라 싣는다.
const ATLASSIAN_SCOPES: &[&str] = &[
    "read:me",
    "read:account",
    "offline_access",
    "read:jira:agent-interface",
    "write:jira:agent-interface",
    "search:jira:agent-interface",
    "delete:jira:agent-interface",
    "manage:jira:agent-interface",
    "read:confluence:agent-interface",
    "write:confluence:agent-interface",
    "search:confluence:agent-interface",
    "search:rovo:agent-interface",
    "read:projects:agent-interface",
    "write:projects:agent-interface",
    "read:goals:agent-interface",
    "write:goals:agent-interface",
    "read:bitbucket:agent-interface",
    "write:bitbucket:agent-interface",
];

/// GitHub 원격 MCP의 보호 자원 메타데이터가 광고하는 scope. `delete_repo`처럼 되돌릴 수
/// 없는 것도 있어 기본값에는 넣지 않는다.
const GITHUB_SCOPES: &[&str] = &[
    "repo",
    "read:org",
    "read:user",
    "user:email",
    "read:project",
    "project",
    "gist",
    "workflow",
    "notifications",
    "read:packages",
    "write:packages",
    "codespace",
    "delete_repo",
];

const GOOGLE_GMAIL_SCOPE: &str =
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose";
const GOOGLE_DRIVE_SCOPE: &str =
    "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file";
const GOOGLE_CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events.freebusy https://www.googleapis.com/auth/calendar.events.readonly";
const GOOGLE_DOCS_SCOPE: &str = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/documents.readonly https://www.googleapis.com/auth/documents";

pub const HOSTED_MCPS: [HostedMcpPreset; 7] = [
    // 아틀라시안은 Notion과 같이 동적 클라이언트 등록을 지원해 OAuth 한 번으로 붙는다.
    HostedMcpPreset {
        id: "jira",
        display_name: "Jira · Confluence",
        url: "https://mcp.atlassian.com/v2/mcp",
        auth: PluginAuthKind::OAuth,
        brand: "atlassian",
        default_scope: "read:me offline_access read:jira:agent-interface write:jira:agent-interface search:jira:agent-interface read:confluence:agent-interface search:confluence:agent-interface search:rovo:agent-interface",
        available_scopes: ATLASSIAN_SCOPES,
        scope_mode: ScopeMode::Override,
    },
    // GitHub 인증 서버는 동적 등록이 없다. 대신 device_code를 지원해 client_secret 없이
    // 사용자가 만든 OAuth 앱의 client_id만으로 인증할 수 있다.
    HostedMcpPreset {
        id: "github",
        display_name: "GitHub",
        url: "https://api.githubcopilot.com/mcp/",
        auth: PluginAuthKind::OAuthDevice,
        brand: "github",
        default_scope: "repo read:org read:user",
        available_scopes: GITHUB_SCOPES,
        scope_mode: ScopeMode::Override,
    },
    // Figma 원격 MCP는 카탈로그 등재 클라이언트만 받는다(등록 요청이 403). 데스크톱 앱이
    // Dev Mode에서 여는 로컬 서버는 인증 없이 loopback으로 붙는다.
    HostedMcpPreset {
        id: "figma",
        display_name: "Figma (Dev Mode)",
        url: "http://127.0.0.1:3845/mcp",
        auth: PluginAuthKind::None,
        brand: "figma",
        default_scope: "",
        available_scopes: &[],
        scope_mode: ScopeMode::Fallback,
    },
    HostedMcpPreset {
        id: "gmail",
        display_name: "Gmail",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        auth: PluginAuthKind::OAuth,
        brand: "google",
        default_scope: GOOGLE_GMAIL_SCOPE,
        available_scopes: &[],
        scope_mode: ScopeMode::Fallback,
    },
    HostedMcpPreset {
        id: "google-drive",
        display_name: "Google Drive",
        url: "https://drivemcp.googleapis.com/mcp/v1",
        auth: PluginAuthKind::OAuth,
        brand: "google",
        default_scope: GOOGLE_DRIVE_SCOPE,
        available_scopes: &[],
        scope_mode: ScopeMode::Fallback,
    },
    HostedMcpPreset {
        id: "google-calendar",
        display_name: "Google Calendar",
        url: "https://calendarmcp.googleapis.com/mcp/v1",
        auth: PluginAuthKind::OAuth,
        brand: "google",
        default_scope: GOOGLE_CALENDAR_SCOPE,
        available_scopes: &[],
        scope_mode: ScopeMode::Fallback,
    },
    HostedMcpPreset {
        id: "google-docs",
        display_name: "Google Docs",
        url: "https://docsmcp.googleapis.com/mcp/v1",
        auth: PluginAuthKind::OAuth,
        brand: "google",
        default_scope: GOOGLE_DOCS_SCOPE,
        available_scopes: &[],
        scope_mode: ScopeMode::Fallback,
    },
];

/// 구글 공식 MCP는 RFC 9728 메타데이터가 없어도 인증 서버가 구글 계정임이 알려져 있다.
const GOOGLE_AUTHORIZATION_SERVER: &str = "https://accounts.google.com";

// ---------------------------------------------------------------------------
// 저장 모델과 화면 모델
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginAuthKind {
    /// 인증 없는 서버(로컬 개발 서버 등).
    None,
    /// 고정 bearer 토큰. 사용자가 입력한 값을 그대로 `Authorization`에 붙인다.
    Bearer,
    /// MCP 인증 스펙(OAuth 2.1 공개 클라이언트). 브라우저 승인 한 번으로 refresh token을 받는다.
    #[serde(rename = "oauth")]
    OAuth,
    /// OAuth 2.0 디바이스 인가(RFC 8628). 동적 등록도 client_secret도 없는 서버(GitHub)를
    /// 위해 사용자가 만든 앱의 client_id만으로 사용자 코드를 받아 승인한다.
    #[serde(rename = "oauthDevice")]
    OAuthDevice,
    /// Notion 내부 통합 토큰. 이 백엔드가 공식 오픈소스 서버를 loopback으로 띄워 연결한다.
    NotionToken,
}

impl PluginAuthKind {
    pub const ALL: [Self; 5] = [
        Self::None,
        Self::Bearer,
        Self::OAuth,
        Self::OAuthDevice,
        Self::NotionToken,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Bearer => "bearer",
            Self::OAuth => "oauth",
            Self::OAuthDevice => "oauthDevice",
            Self::NotionToken => "notionToken",
        }
    }

    pub fn is_none(self) -> bool {
        matches!(self, Self::None)
    }

    pub fn is_bearer(self) -> bool {
        matches!(self, Self::Bearer)
    }

    pub fn is_oauth_standard(self) -> bool {
        matches!(self, Self::OAuth)
    }

    pub fn is_oauth_device(self) -> bool {
        matches!(self, Self::OAuthDevice)
    }

    pub fn is_notion_token(self) -> bool {
        matches!(self, Self::NotionToken)
    }

    pub fn needs_secret(self) -> bool {
        !self.is_none()
    }

    /// 브라우저 승인으로 토큰을 받는 방식인지. 두 방식은 같은 저장 구조와 갱신 경로를 쓴다.
    pub fn is_oauth(self) -> bool {
        matches!(self, Self::OAuth | Self::OAuthDevice)
    }
}

impl std::fmt::Display for PluginAuthKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for PluginAuthKind {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "none" => Ok(Self::None),
            "bearer" => Ok(Self::Bearer),
            "oauth" => Ok(Self::OAuth),
            "oauthDevice" | "oauth_device" => Ok(Self::OAuthDevice),
            "notionToken" | "notion_token" => Ok(Self::NotionToken),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 플러그인 인증 방식입니다: {s}. none|bearer|oauth|oauthDevice|notionToken 중 하나를 쓰세요"
            ))),
        }
    }
}

/// 플러그인 하나가 채팅에 들고 갈 것: 프록시 경로에 쓸 id와 도구별 결정.
pub type AttachablePlugin = (String, BTreeMap<String, PluginToolPolicy>);

/// 플러그인 도구 하나에 대한 사용자 결정. 저장하지 않은 도구는 `Ask`로 본다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginToolPolicy {
    /// 확인: 공급자 CLI의 승인 절차를 그대로 따른다(기본값).
    #[default]
    Ask,
    /// 허용: 승인 카드를 띄우지 않고 자동 승인한다.
    Allow,
    /// 제한: 도구 목록에서 감추고 호출을 프록시에서 거절한다.
    Deny,
}

impl PluginToolPolicy {
    pub const ALL: [Self; 3] = [Self::Ask, Self::Allow, Self::Deny];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Allow => "allow",
            Self::Deny => "deny",
        }
    }

    /// 확인 정책인지 여부 (기본값).
    pub fn is_ask(self) -> bool {
        matches!(self, Self::Ask)
    }

    /// 자동 승인 정책인지 여부.
    pub fn is_allow(self) -> bool {
        matches!(self, Self::Allow)
    }

    /// 호출 거절 및 숨김 정책인지 여부.
    pub fn is_deny(self) -> bool {
        matches!(self, Self::Deny)
    }
}

impl std::fmt::Display for PluginToolPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for PluginToolPolicy {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "ask" => Ok(Self::Ask),
            "allow" => Ok(Self::Allow),
            "deny" => Ok(Self::Deny),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 플러그인 도구 정책입니다: {s}. ask|allow|deny 중 하나를 쓰세요"
            ))),
        }
    }
}

/// OAuth 클라이언트 등록 결과와 엔드포인트. 비밀값(client_secret·토큰)은 들어가지 않는다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct OAuthClientRecord {
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    registration_endpoint: Option<String>,
    client_id: String,
    /// 등록 때 쓴 redirect URI. 노션은 포트까지 정확히 대조하므로 다음 인증도 같은 포트를 연다.
    redirect_uri: String,
    /// RFC 8707 resource. authorize·token 요청 양쪽에 그대로 싣는다.
    resource: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    authorized_at: Option<i64>,
    #[serde(default)]
    access_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPlugin {
    id: String,
    display_name: String,
    /// 원격 MCP 주소. `NotionToken`은 백엔드가 띄우는 서버라 비어 있다.
    #[serde(default)]
    url: Option<String>,
    auth: PluginAuthKind,
    enabled: bool,
    /// 사용자가 고른 OAuth scope. 비어 있으면 프리셋·디스커버리 값이 쓰인다.
    #[serde(default)]
    scope: Option<String>,
    /// 도구 이름별 허용/확인/제한. 기본값(`Ask`)인 도구는 넣지 않는다.
    #[serde(default)]
    tool_policies: BTreeMap<String, PluginToolPolicy>,
    created_at: i64,
    updated_at: i64,
    /// 보안 저장소에 비밀값을 마지막으로 쓴 시각. 값 자체는 여기 없다.
    #[serde(default)]
    secret_stored_at: Option<i64>,
    #[serde(default)]
    oauth: Option<OAuthClientRecord>,
    #[serde(default)]
    server_name: Option<String>,
    #[serde(default)]
    tools: Vec<String>,
    #[serde(default)]
    last_verified_at: Option<i64>,
    #[serde(default)]
    last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginStore {
    schema_version: u32,
    plugins: Vec<StoredPlugin>,
}

impl SchemaVersioned for PluginStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

impl Default for PluginStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            plugins: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginView {
    pub id: String,
    pub display_name: String,
    pub url: Option<String>,
    pub auth: PluginAuthKind,
    pub enabled: bool,
    /// 사용자가 고른 OAuth scope. 없으면 프리셋 기본값이 쓰인다.
    pub scope: Option<String>,
    /// 도구별 허용/확인/제한. 저장되지 않은 도구는 확인(Ask)이다.
    pub tool_policies: BTreeMap<String, PluginToolPolicy>,
    /// 비밀값이 보안 저장소에 있는지. 인증 없는 플러그인은 항상 true.
    pub credential_ready: bool,
    /// 브라우저 승인을 기다리는 OAuth 흐름이 살아 있는지.
    pub oauth_pending: bool,
    /// 새 채팅에 실제로 붙는지(사용 중이고 자격증명이 준비됨).
    pub attachable: bool,
    pub server_name: Option<String>,
    pub tools: Vec<String>,
    pub last_verified_at: Option<i64>,
    pub last_error: Option<String>,
    pub authorized_at: Option<i64>,
    pub access_expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginsSnapshot {
    pub plugins: Vec<ExternalPluginView>,
    /// loopback 프록시가 떠 있어 채팅에 붙일 수 있는지.
    pub proxy_ready: bool,
    /// 내장 Notion 서버를 띄울 `npx`를 찾았는지.
    pub node_available: bool,
    pub max_plugins: usize,
    pub notion_hosted_url: &'static str,
    pub notion_local_package: &'static str,
    pub hosted_presets: &'static [HostedMcpPreset],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterExternalPluginRequest {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub url: Option<String>,
    pub auth: PluginAuthKind,
    /// Bearer·NotionToken의 비밀값. 저장 뒤 응답에는 나가지 않는다.
    #[serde(default)]
    pub token: Option<String>,
    /// 동적 등록을 지원하지 않는 인증 서버용 수동 client_id.
    #[serde(default)]
    pub client_id: Option<String>,
    /// 수동 client_id에 딸린 client_secret(구글 등). 저장 뒤 응답에는 나가지 않는다.
    #[serde(default)]
    pub client_secret: Option<String>,
    /// authorize 요청에 실을 scope. 비우면 프리셋 기본값이나 디스커버리 결과를 쓴다.
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateExternalPluginRequest {
    /// MCP 서버 이름과 loopback 프록시 경로에 쓰이는 불변 식별자.
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub url: Option<String>,
    pub auth: PluginAuthKind,
    /// Bearer·NotionToken 설정이 바뀔 때만 필수다. 비어 있으면 호환되는 기존 토큰을 유지한다.
    #[serde(default)]
    pub token: Option<String>,
    /// 값이 전달되면 기존 OAuth 등록·자격증명을 초기화하고 이 client_id로 다시 인증한다.
    #[serde(default)]
    pub client_id: Option<String>,
    /// 수동 client_id에 딸린 client_secret. client_id와 함께 올 때만 유효하다.
    #[serde(default)]
    pub client_secret: Option<String>,
    /// authorize scope. 값이 바뀌면 기존 인증을 버리고 새 동의를 받는다.
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginIdRequest {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginToolCallRequest {
    pub id: String,
    pub tool: String,
    #[serde(default = "crate::mcp_registry::empty_object")]
    pub arguments: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExternalPluginEnabledRequest {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExternalPluginToolPolicyRequest {
    pub id: String,
    pub tool: String,
    pub policy: PluginToolPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExternalPluginToolPoliciesRequest {
    pub id: String,
    pub policy: PluginToolPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetExternalPluginTokenRequest {
    pub id: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginOAuthStart {
    pub id: String,
    /// 사용자 브라우저에서 열 승인 주소. 호스트 화면이 연다.
    pub authorization_url: String,
    pub expires_at: i64,
    /// 디바이스 인가에서 사용자가 승인 화면에 입력할 코드. 그 외에는 None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
}

/// 보안 저장소에 한 줄 JSON으로 두는 비밀 문서.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretDocument {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bearer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notion_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_secret: Option<String>,
}

// ---------------------------------------------------------------------------
// 프로세스 전역 상태: 진행 중 OAuth 흐름과 내장 Notion 서버
// ---------------------------------------------------------------------------

struct PendingOAuth {
    cancel: Arc<AtomicBool>,
    expires_at: i64,
}

fn pending_oauth() -> &'static Mutex<HashMap<String, PendingOAuth>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingOAuth>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

struct ManagedServer {
    child: Child,
    port: u16,
    /// 프록시만 아는 서버 쪽 bearer 토큰. 매 기동마다 새로 만든다.
    auth_token: String,
}

fn managed_servers() -> &'static Mutex<HashMap<String, ManagedServer>> {
    static SERVERS: OnceLock<Mutex<HashMap<String, ManagedServer>>> = OnceLock::new();
    SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 백엔드가 내려갈 때 내장 서버를 함께 끝낸다. `SystemMcpServer::drop`이 부른다.
pub(crate) fn shutdown_managed_servers() {
    if let Ok(mut servers) = managed_servers().lock() {
        for (_, mut server) in servers.drain() {
            let _ = server.child.kill();
            let _ = server.child.wait();
        }
    }
}

fn stop_managed_server(id: &str) {
    if let Ok(mut servers) = managed_servers().lock() {
        if let Some(mut server) = servers.remove(id) {
            let _ = server.child.kill();
            let _ = server.child.wait();
        }
    }
}

// ---------------------------------------------------------------------------
// 레지스트리
// ---------------------------------------------------------------------------

/// 프록시가 상류로 보낼 요청. 헤더는 MCP 전송에 필요한 것만 골라 넘긴다.
pub(crate) struct ProxyRequest {
    pub(crate) method: reqwest::Method,
    pub(crate) content_type: Option<String>,
    pub(crate) accept: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) protocol_version: Option<String>,
    pub(crate) body: Vec<u8>,
}

pub(crate) struct ProxyResponse {
    pub(crate) status: u16,
    pub(crate) content_type: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) body: Vec<u8>,
}

#[derive(Clone)]
pub struct ExternalPluginRegistry {
    app_data_dir: PathBuf,
}

impl ExternalPluginRegistry {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self { app_data_dir }
    }

    pub fn snapshot(&self, proxy_ready: bool) -> Result<ExternalPluginsSnapshot, CoreError> {
        let store = self.with_store_lock(|| self.load_store_unlocked())?;
        let pending = pending_oauth_ids();
        let plugins = store
            .plugins
            .iter()
            .map(|plugin| plugin_view(plugin, pending.contains(&plugin.id)))
            .collect();
        Ok(ExternalPluginsSnapshot {
            plugins,
            proxy_ready,
            node_available: crate::providers::resolve_named_executable(&["npx"]).is_ok(),
            max_plugins: MAX_PLUGINS,
            notion_hosted_url: NOTION_HOSTED_MCP_URL,
            notion_local_package: NOTION_LOCAL_SERVER_PACKAGE,
            hosted_presets: &HOSTED_MCPS,
        })
    }

    /// 새 일반 채팅에 붙일 플러그인 id. 사용 중이고 자격증명이 준비된 것만이다.
    pub fn attachable_plugin_ids(&self) -> Result<Vec<String>, CoreError> {
        Ok(self
            .attachable_plugins()?
            .into_iter()
            .map(|(id, _)| id)
            .collect())
    }

    /// 붙일 플러그인과 그 도구 정책. 채팅은 시작 시점의 정책을 그대로 들고 간다(P7).
    /// 제한(`Deny`)은 프록시가 매 요청마다 다시 확인하므로 이 값과 무관하게 즉시 듣는다.
    pub fn attachable_plugins(&self) -> Result<Vec<AttachablePlugin>, CoreError> {
        let store = self.with_store_lock(|| self.load_store_unlocked())?;
        Ok(store
            .plugins
            .iter()
            .filter(|plugin| plugin.enabled && credential_ready(plugin))
            .map(|plugin| (plugin.id.clone(), plugin.tool_policies.clone()))
            .collect())
    }

    /// AIA가 호출할 수 있는 플러그인의 현재 도구 계약을 프록시 경유로 읽는다. 플러그인이
    /// 꺼져 있거나 자격증명이 준비되지 않았으면 도구를 노출하지 않는다.
    pub fn aia_tool_catalog(&self, id: &str, proxy_base: &str) -> Result<Value, CoreError> {
        let plugin = self.require_aia_attachable_plugin(id)?;
        let (mut session, initialize) =
            McpHttpSession::connect_with_authorization(&format!("{proxy_base}/{id}"), None)?;
        let tools = parse_tools(&session.list_tools()?)?;
        let server_info = initialize.get("serverInfo").cloned().unwrap_or(Value::Null);
        Ok(json!({
            "pluginId": plugin.id,
            "displayName": plugin.display_name,
            "serverName": server_info
                .get("title")
                .or_else(|| server_info.get("name"))
                .and_then(Value::as_str),
            "tools": tools,
            "contentTrust": "untrusted"
        }))
    }

    /// AIA의 읽기·변경 경로를 분리한 뒤 활성 플러그인의 도구를 호출한다. 매 호출마다
    /// tools/list를 다시 읽어 상류가 보고한 readOnlyHint가 호출 경로와 같은지 확인한다.
    pub fn aia_call_tool(
        &self,
        request: ExternalPluginToolCallRequest,
        proxy_base: &str,
        require_read_only: bool,
    ) -> Result<Value, CoreError> {
        validate_plugin_id(&request.id)?;
        crate::mcp_registry::validate_tool_name(&request.tool)?;
        if !request.arguments.is_object() {
            return Err(CoreError::InvalidInput(
                "외부 플러그인 도구 arguments는 객체여야 합니다".to_owned(),
            ));
        }
        let plugin = self.require_aia_attachable_plugin(&request.id)?;
        let (mut session, _) = McpHttpSession::connect_with_authorization(
            &format!("{proxy_base}/{}", request.id),
            None,
        )?;
        let tools = parse_tools(&session.list_tools()?)?;
        let tool = tools
            .iter()
            .find(|tool| tool.name == request.tool)
            .ok_or_else(|| {
                CoreError::NotFound(
                    "요청한 도구가 현재 외부 플러그인 카탈로그에 없습니다".to_owned(),
                )
            })?;
        ensure_aia_tool_access(tool, require_read_only)?;
        let result = session.call_tool(&request.tool, request.arguments)?;
        Ok(json!({
            "pluginId": plugin.id,
            "tool": request.tool,
            "result": crate::mcp_registry::bounded_remote_result(result),
            "contentTrust": "untrusted"
        }))
    }

    pub fn register(
        &self,
        request: RegisterExternalPluginRequest,
    ) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(&request.id)?;
        let display_name = validate_display_name(&request.display_name)?;
        let url = validate_request_url(request.auth, request.url.as_deref())?;
        let token = validate_request_token(request.auth, request.token.as_deref(), true)?;
        let manual_client_id = request
            .client_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(validate_client_id)
            .transpose()?;
        if manual_client_id.is_some() && !request.auth.is_oauth() {
            return Err(CoreError::InvalidInput(
                "clientId는 OAuth 방식에서만 쓰입니다".to_owned(),
            ));
        }
        // 디바이스 인가에는 동적 등록이 없다. client_id 없이는 승인 화면을 열 수 없으므로
        // 등록 단계에서 막아, 인증을 눌러야 아는 실패를 만들지 않는다.
        if request.auth == PluginAuthKind::OAuthDevice && manual_client_id.is_none() {
            return Err(CoreError::InvalidInput(
                "디바이스 인가 방식은 서버에서 만든 앱의 clientId가 필요합니다".to_owned(),
            ));
        }
        let manual_client_secret =
            validate_manual_client_secret(request.client_secret.as_deref(), &manual_client_id)?;
        let scope = validate_scope(request.scope.as_deref(), request.auth)?;
        let now = now_ms();
        let mut plugin = StoredPlugin {
            id: request.id.clone(),
            display_name,
            url,
            auth: request.auth,
            enabled: true,
            scope,
            tool_policies: BTreeMap::new(),
            created_at: now,
            updated_at: now,
            secret_stored_at: None,
            oauth: None,
            server_name: None,
            tools: Vec::new(),
            last_verified_at: None,
            last_error: None,
        };
        plugin.oauth = manual_client_id.map(new_manual_oauth_record);
        self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            if store
                .plugins
                .iter()
                .any(|existing| existing.id == plugin.id)
            {
                return Err(CoreError::Conflict(
                    "같은 id의 플러그인이 이미 있습니다. 먼저 삭제해 주세요".to_owned(),
                ));
            }
            if store.plugins.len() >= MAX_PLUGINS {
                return Err(CoreError::Conflict(format!(
                    "외부 플러그인은 최대 {MAX_PLUGINS}개까지 등록할 수 있습니다"
                )));
            }
            if let Some(token) = &token {
                write_secret(&plugin.id, &token_secret_document(token, plugin.auth))?;
                plugin.secret_stored_at = Some(now);
            }
            if let Some(secret) = &manual_client_secret {
                // OAuth의 credential_ready는 authorized_at도 요구하므로 secret_stored_at만으로
                // 준비됨으로 오판되지 않는다. 토큰은 첫 인증(begin_oauth)이 같은 문서에 채운다.
                write_secret(
                    &plugin.id,
                    &SecretDocument {
                        client_secret: Some(secret.clone()),
                        ..SecretDocument::default()
                    },
                )?;
                plugin.secret_stored_at = Some(now);
            }
            store.plugins.push(plugin.clone());
            self.save_store_unlocked(&store)?;
            Ok(plugin_view(&plugin, false))
        })
    }

    pub fn remove(&self, id: &str) -> Result<(), CoreError> {
        validate_plugin_id(id)?;
        cancel_pending_oauth(id);
        stop_managed_server(id);
        self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            let before = store.plugins.len();
            store.plugins.retain(|plugin| plugin.id != id);
            if store.plugins.len() == before {
                return Err(CoreError::NotFound(
                    "등록된 외부 플러그인을 찾을 수 없습니다".to_owned(),
                ));
            }
            // 비밀값이 남는 쪽이 더 나쁘다. 저장 파일보다 보안 저장소를 먼저 지운다.
            delete_os_keychain_password(KEYCHAIN_SERVICE, id)?;
            self.save_store_unlocked(&store)
        })
    }

    /// 저장된 플러그인 매니페스트를 편집한다. `id`는 MCP 서버 이름·프록시 경로이므로
    /// 조회 키로만 받고 바꾸지 않는다. 표시 이름만 바뀌면 연결 상태를 보존하지만, URL·인증
    /// 방식·OAuth client_id가 바뀌면 예전 자격증명이 새 연결 지점으로 전달되지 않도록
    /// 보안 저장소와 확인 결과를 함께 초기화한다(P1·P2·P4·P5).
    pub fn update(
        &self,
        request: UpdateExternalPluginRequest,
    ) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(&request.id)?;
        let display_name = validate_display_name(&request.display_name)?;
        let url = validate_request_url(request.auth, request.url.as_deref())?;
        let token = validate_request_token(request.auth, request.token.as_deref(), false)?;
        let client_id_was_supplied = request.client_id.is_some();
        let manual_client_id = request
            .client_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(validate_client_id)
            .transpose()?;
        if client_id_was_supplied && !request.auth.is_oauth() {
            return Err(CoreError::InvalidInput(
                "clientId는 OAuth 방식에서만 쓰입니다".to_owned(),
            ));
        }
        let manual_client_secret =
            validate_manual_client_secret(request.client_secret.as_deref(), &manual_client_id)?;
        let scope = validate_scope(request.scope.as_deref(), request.auth)?;

        let id = request.id;
        let updated = self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            let index = store
                .plugins
                .iter()
                .position(|plugin| plugin.id == id)
                .ok_or_else(|| {
                    CoreError::NotFound("등록된 외부 플러그인을 찾을 수 없습니다".to_owned())
                })?;
            // scope가 바뀌면 이미 받은 동의 범위와 달라진다. 같은 등록을 계속 쓰면 예전
            // 범위의 refresh token이 남으므로 연결이 바뀐 것으로 보고 다시 인증하게 한다.
            let connection_changed = {
                let plugin = &store.plugins[index];
                plugin.url != url
                    || plugin.auth != request.auth
                    || (request.auth.is_oauth() && client_id_was_supplied)
                    || (request.auth.is_oauth() && plugin.scope != scope)
            };
            if request.auth == PluginAuthKind::OAuthDevice
                && manual_client_id.is_none()
                && store.plugins[index]
                    .oauth
                    .as_ref()
                    .is_none_or(|record| record.client_id.is_empty())
            {
                return Err(CoreError::InvalidInput(
                    "디바이스 인가 방식은 서버에서 만든 앱의 clientId가 필요합니다".to_owned(),
                ));
            }
            if connection_changed
                && matches!(request.auth, PluginAuthKind::Bearer | PluginAuthKind::NotionToken)
                && token.is_none()
            {
                return Err(CoreError::InvalidInput(
                    "서버 주소나 인증 방식을 바꿀 때는 새 토큰을 함께 입력해야 합니다"
                        .to_owned(),
                ));
            }
            // 연결 지점이나 자격증명이 바뀌면 이전 연결 확인 결과는 다른 서버의 것이다.
            let verification_stale = connection_changed || token.is_some();
            // 보안 저장소는 비밀이 얽힌 편집만 지난다. 새 토큰을 쓰거나, 연결이 바뀌어
            // 이전 설정이 남겼을 수 있는 비밀을 지워야 할 때다. 인증 없는 서버끼리의
            // 편집은 지울 것도 쓸 것도 없으므로 OS 보안 저장소를 건드리지 않는다.
            let plugin_may_hold_secret = {
                let plugin = &store.plugins[index];
                plugin.auth.needs_secret() || plugin.secret_stored_at.is_some()
            };
            let secret_store_touched = token.is_some()
                || manual_client_secret.is_some()
                || (connection_changed && plugin_may_hold_secret);
            let previous_secret = if secret_store_touched {
                Some(read_secret(&id)?)
            } else {
                None
            };

            if connection_changed {
                cancel_pending_oauth(&id);
                stop_managed_server(&id);
            } else if token.is_some() && request.auth == PluginAuthKind::NotionToken {
                // 내장 서버는 옛 토큰으로 떠 있다. 다음 요청이 새 토큰으로 다시 띄운다.
                stop_managed_server(&id);
            }
            if secret_store_touched {
                match (&token, request.auth) {
                    (Some(token), PluginAuthKind::Bearer | PluginAuthKind::NotionToken) => {
                        write_secret(&id, &token_secret_document(token, request.auth))?
                    }
                    (None, PluginAuthKind::OAuth | PluginAuthKind::OAuthDevice)
                        if manual_client_secret.is_some() =>
                    {
                        // 수동 client_id가 함께 오는 편집이라 connection_changed가 참이고,
                        // 이전 토큰은 새 문서로 폐기된다. 토큰은 첫 인증이 다시 채운다.
                        write_secret(
                            &id,
                            &SecretDocument {
                                client_secret: manual_client_secret.clone(),
                                ..SecretDocument::default()
                            },
                        )?
                    }
                    (
                        None,
                        PluginAuthKind::None | PluginAuthKind::OAuth | PluginAuthKind::OAuthDevice,
                    ) => delete_os_keychain_password(KEYCHAIN_SERVICE, &id)?,
                    _ => unreachable!("validated plugin edit credential state"),
                }
            }

            let now = now_ms();
            // 디바이스 인가는 client_id 없이 인증할 수 없다. 이번 편집이 새 값을 주지
            // 않았다면 기존 등록에서 client_id만 남겨 다시 인증할 수 있게 한다.
            let kept_device_client_id = (request.auth == PluginAuthKind::OAuthDevice
                && manual_client_id.is_none())
            .then(|| {
                store.plugins[index]
                    .oauth
                    .as_ref()
                    .map(|record| record.client_id.clone())
            })
            .flatten()
            .filter(|client_id| !client_id.is_empty());
            let plugin = &mut store.plugins[index];
            plugin.display_name = display_name.clone();
            plugin.url = url.clone();
            plugin.auth = request.auth;
            plugin.scope = scope.clone();
            if connection_changed {
                plugin.oauth = if request.auth.is_oauth() {
                    manual_client_id
                        .clone()
                        .or_else(|| kept_device_client_id.clone())
                        .map(new_manual_oauth_record)
                } else {
                    None
                };
            }
            if verification_stale {
                plugin.secret_stored_at = (token.is_some() || manual_client_secret.is_some())
                    .then_some(now);
                plugin.server_name = None;
                plugin.tools.clear();
                plugin.last_verified_at = None;
                plugin.last_error = None;
            }
            plugin.updated_at = now;
            let updated = plugin.clone();
            if let Err(error) = self.save_store_unlocked(&store) {
                if let Some(previous_secret) = previous_secret {
                    let restored = match previous_secret {
                        Some(document) => write_secret(&id, &document),
                        None => delete_os_keychain_password(KEYCHAIN_SERVICE, &id),
                    };
                    if let Err(restore_error) = restored {
                        return Err(CoreError::Runtime(format!(
                            "외부 플러그인 저장 실패 뒤 자격증명을 복원하지 못했습니다: {restore_error}"
                        )));
                    }
                }
                return Err(error);
            }
            Ok(updated)
        })?;
        let pending = pending_oauth_ids();
        Ok(plugin_view(&updated, pending.contains(&updated.id)))
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        if !enabled {
            stop_managed_server(id);
        }
        let pending = pending_oauth_ids();
        self.update_plugin(id, |plugin| {
            plugin.enabled = enabled;
            Ok(())
        })
        .map(|plugin| plugin_view(&plugin, pending.contains(&plugin.id)))
    }

    /// 도구 하나의 허용/확인/제한을 저장한다. 확인(기본값)은 항목을 지워 저장 파일이
    /// 사용자가 실제로 정한 것만 담게 한다. 제한은 프록시가 다음 요청부터 곧바로 막고,
    /// 허용은 새로 시작하는 채팅부터 승인 카드를 건너뛴다(P7).
    pub fn set_tool_policy(
        &self,
        id: &str,
        tool: &str,
        policy: PluginToolPolicy,
    ) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        let tool = tool.trim().to_owned();
        crate::mcp_registry::validate_tool_name(&tool)?;
        let pending = pending_oauth_ids();
        self.update_plugin(id, |plugin| {
            if policy == PluginToolPolicy::Ask {
                plugin.tool_policies.remove(&tool);
            } else {
                plugin.tool_policies.insert(tool.clone(), policy);
            }
            Ok(())
        })
        .map(|plugin| plugin_view(&plugin, pending.contains(&plugin.id)))
    }

    /// 현재 알려진 도구와 이미 정책이 남아 있는 도구를 한 번의 저장으로 같은 값에 맞춘다.
    /// 이후 새로 발견되는 도구는 안전한 기본값인 `Ask`를 그대로 쓴다(P7).
    pub fn set_all_tool_policies(
        &self,
        id: &str,
        policy: PluginToolPolicy,
    ) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        let pending = pending_oauth_ids();
        self.update_plugin(id, |plugin| {
            if policy == PluginToolPolicy::Ask {
                plugin.tool_policies.clear();
                return Ok(());
            }
            let tools = plugin
                .tools
                .iter()
                .chain(plugin.tool_policies.keys())
                .cloned()
                .collect::<BTreeSet<_>>();
            for tool in &tools {
                crate::mcp_registry::validate_tool_name(tool)?;
            }
            plugin.tool_policies = tools.into_iter().map(|tool| (tool, policy)).collect();
            Ok(())
        })
        .map(|plugin| plugin_view(&plugin, pending.contains(&plugin.id)))
    }

    pub fn set_token(&self, id: &str, token: &str) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        let pending = pending_oauth_ids();
        let updated = self.update_plugin(id, |plugin| {
            let token = validate_token(token, plugin.auth)?;
            let document = match plugin.auth {
                PluginAuthKind::Bearer => SecretDocument {
                    bearer: Some(token),
                    ..SecretDocument::default()
                },
                PluginAuthKind::NotionToken => SecretDocument {
                    notion_token: Some(token),
                    ..SecretDocument::default()
                },
                PluginAuthKind::None | PluginAuthKind::OAuth | PluginAuthKind::OAuthDevice => {
                    return Err(CoreError::InvalidInput(
                        "이 플러그인은 고정 토큰을 쓰지 않습니다".to_owned(),
                    ))
                }
            };
            write_secret(&plugin.id, &document)?;
            plugin.secret_stored_at = Some(now_ms());
            plugin.last_error = None;
            Ok(())
        })?;
        // 내장 서버는 옛 토큰으로 떠 있다. 다음 요청이 새 토큰으로 다시 띄운다.
        stop_managed_server(id);
        Ok(plugin_view(&updated, pending.contains(&updated.id)))
    }

    /// 프록시 주소로 initialize·tools/list를 실행해 연결과 인증을 확인하고 결과를 기록한다.
    /// CLI가 실제로 쓰는 경로(프록시)를 그대로 지나므로 여기서 성공하면 채팅에서도 붙는다.
    pub fn verify(&self, id: &str, proxy_base: &str) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        let pending = pending_oauth_ids();
        let outcome = (|| {
            let (mut session, initialize) =
                McpHttpSession::connect_with_authorization(&format!("{proxy_base}/{id}"), None)?;
            let tools = parse_tools(&session.list_tools()?)?;
            let server_info = initialize.get("serverInfo").cloned().unwrap_or(Value::Null);
            let server_name = server_info
                .get("title")
                .or_else(|| server_info.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            Ok::<_, CoreError>((
                server_name,
                tools.into_iter().map(|tool| tool.name).collect::<Vec<_>>(),
            ))
        })();
        let updated = self.update_plugin(id, |plugin| {
            match &outcome {
                Ok((server_name, tools)) => {
                    plugin.server_name = server_name.clone();
                    plugin.tools = tools.clone();
                    plugin.last_verified_at = Some(now_ms());
                    plugin.last_error = None;
                }
                Err(error) => {
                    plugin.last_error = Some(text_limit::truncate_chars(&error.to_string(), 300));
                }
            }
            Ok(())
        })?;
        Ok(plugin_view(&updated, pending.contains(&updated.id)))
    }

    // -- OAuth ---------------------------------------------------------------

    pub fn begin_oauth(&self, id: &str) -> Result<ExternalPluginOAuthStart, CoreError> {
        validate_plugin_id(id)?;
        cancel_pending_oauth(id);
        let plugin = self.find_plugin(id)?;
        if !plugin.auth.is_oauth() {
            return Err(CoreError::InvalidInput(
                "이 플러그인은 OAuth 방식이 아닙니다".to_owned(),
            ));
        }
        let url = plugin.url.clone().ok_or_else(|| {
            CoreError::InvalidInput("OAuth 플러그인에 서버 주소가 없습니다".to_owned())
        })?;
        let metadata = discover_oauth(&url)?;
        let scope = resolve_scope(
            plugin.scope.as_deref(),
            metadata.scope.as_deref(),
            hosted_preset_for(&url),
        );
        if plugin.auth == PluginAuthKind::OAuthDevice {
            return self.begin_device_oauth(&plugin, metadata, scope);
        }
        let stored = plugin.oauth.clone();
        let stored_port = stored
            .as_ref()
            .and_then(|record| Url::parse(&record.redirect_uri).ok())
            .and_then(|redirect| redirect.port());
        let listener = bind_callback_listener(stored_port)?;
        let port = listener.local_addr()?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");
        // 인증 서버·redirect가 그대로면 등록을 재사용한다. 세션마다 새로 등록하면 이전
        // refresh token이 고아가 되어 매번 다시 로그인하게 된다.
        let mut client_secret: Option<String> = None;
        let client_id = match stored.as_ref() {
            Some(record) if can_reuse_client_registration(record, &redirect_uri, &metadata) => {
                if let Some(document) = read_secret(id)? {
                    client_secret = document.client_secret.clone();
                }
                record.client_id.clone()
            }
            _ => {
                let registration_endpoint = metadata.registration_endpoint.clone().ok_or_else(|| {
                    CoreError::Conflict(
                        "인증 서버가 동적 클라이언트 등록을 지원하지 않습니다. 서버에서 발급한 client_id(필요하면 client_secret도)를 플러그인 등록 시 입력해 주세요"
                            .to_owned(),
                    )
                })?;
                let registered =
                    register_oauth_client(&registration_endpoint, &redirect_uri, scope.as_deref())?;
                client_secret = registered.client_secret;
                registered.client_id
            }
        };
        let verifier = random_urlsafe(32);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random_urlsafe(24);
        let mut authorization_url = Url::parse(&metadata.authorization_endpoint).map_err(|_| {
            CoreError::Runtime("인증 서버 authorization_endpoint가 올바르지 않습니다".to_owned())
        })?;
        {
            let mut query = authorization_url.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", &client_id)
                .append_pair("redirect_uri", &redirect_uri)
                .append_pair("code_challenge", &challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("state", &state)
                .append_pair("resource", &metadata.resource);
            if let Some(scope) = &scope {
                query.append_pair("scope", scope);
            }
            if is_google_authorization_endpoint(&metadata.authorization_endpoint) {
                // 구글은 access_type=offline 없이는 refresh token을 주지 않고,
                // 재동의에서 다시 받으려면 prompt=consent가 필요하다.
                query
                    .append_pair("access_type", "offline")
                    .append_pair("prompt", "consent");
            }
        }
        let record = OAuthClientRecord {
            authorization_endpoint: metadata.authorization_endpoint.clone(),
            token_endpoint: metadata.token_endpoint.clone(),
            registration_endpoint: metadata.registration_endpoint.clone(),
            client_id: client_id.clone(),
            redirect_uri: redirect_uri.clone(),
            resource: metadata.resource.clone(),
            scope: scope.clone(),
            authorized_at: stored.as_ref().and_then(|record| record.authorized_at),
            access_expires_at: stored.as_ref().and_then(|record| record.access_expires_at),
        };
        self.update_plugin(id, |plugin| {
            plugin.oauth = Some(record.clone());
            plugin.last_error = None;
            Ok(())
        })?;
        if let Some(secret) = &client_secret {
            // 등록 응답에 client_secret이 왔으면 토큰과 같은 문서에 보관한다.
            let mut document = read_secret(id)?.unwrap_or_default();
            document.client_secret = Some(secret.clone());
            write_secret(id, &document)?;
        }

        let cancel = Arc::new(AtomicBool::new(false));
        let expires_at = now_ms() + OAUTH_CALLBACK_TIMEOUT.as_millis() as i64;
        if let Ok(mut pending) = pending_oauth().lock() {
            pending.insert(
                id.to_owned(),
                PendingOAuth {
                    cancel: Arc::clone(&cancel),
                    expires_at,
                },
            );
        }
        let registry = self.clone();
        let plugin_id = id.to_owned();
        let exchange = OAuthExchange {
            token_endpoint: metadata.token_endpoint,
            client_id,
            client_secret,
            redirect_uri,
            resource: metadata.resource,
            code_verifier: verifier,
            state,
        };
        thread::Builder::new()
            .name(format!("agent-manager-plugin-oauth-{plugin_id}"))
            .spawn(move || {
                let outcome = wait_for_callback(&listener, &exchange.state, &cancel)
                    .and_then(|code| exchange_code(&exchange, &code));
                if let Ok(mut pending) = pending_oauth().lock() {
                    pending.remove(&plugin_id);
                }
                if cancel.load(Ordering::Acquire) {
                    return;
                }
                let result = match outcome {
                    Ok(tokens) => registry.store_oauth_tokens(&plugin_id, tokens),
                    Err(error) => registry
                        .update_plugin(&plugin_id, |plugin| {
                            plugin.last_error = Some(format!(
                                "OAuth 인증 실패: {}",
                                text_limit::truncate_chars(&error.to_string(), 300)
                            ));
                            Ok(())
                        })
                        .map(|_| ()),
                };
                if let Err(error) = result {
                    eprintln!(
                        "[external-plugins] {plugin_id} OAuth 결과를 기록하지 못했습니다: {error}"
                    );
                }
            })
            .map_err(|error| {
                CoreError::Runtime(format!("OAuth 콜백 스레드를 시작할 수 없습니다: {error}"))
            })?;
        Ok(ExternalPluginOAuthStart {
            id: id.to_owned(),
            authorization_url: authorization_url.to_string(),
            expires_at,
            user_code: None,
        })
    }

    /// RFC 8628 디바이스 인가. 동적 등록도 client_secret도 없는 인증 서버(GitHub)를 위한
    /// 경로다. 콜백 포트를 열지 않고, 사용자가 브라우저에 사용자 코드를 입력해 승인하면
    /// 백엔드가 토큰 endpoint를 서버가 알려 준 간격으로 물어본다.
    fn begin_device_oauth(
        &self,
        plugin: &StoredPlugin,
        metadata: OAuthServerMetadata,
        scope: Option<String>,
    ) -> Result<ExternalPluginOAuthStart, CoreError> {
        let client_id = plugin
            .oauth
            .as_ref()
            .map(|record| record.client_id.clone())
            .filter(|client_id| !client_id.is_empty())
            .ok_or_else(|| {
                CoreError::InvalidInput(
                    "디바이스 인가 방식은 서버에서 만든 앱의 clientId가 필요합니다".to_owned(),
                )
            })?;
        let device_endpoint = metadata
            .device_authorization_endpoint
            .clone()
            .ok_or_else(|| {
                CoreError::Conflict(
                    "인증 서버가 디바이스 인가를 광고하지 않습니다. 일반 OAuth 방식으로 등록해 주세요"
                        .to_owned(),
                )
            })?;
        let id = plugin.id.clone();
        let client_secret = read_secret(&id)?.and_then(|document| document.client_secret);
        let authorization = request_device_code(&device_endpoint, &client_id, scope.as_deref())?;
        let record = OAuthClientRecord {
            authorization_endpoint: metadata.authorization_endpoint.clone(),
            token_endpoint: metadata.token_endpoint.clone(),
            registration_endpoint: None,
            client_id: client_id.clone(),
            // 디바이스 인가에는 콜백이 없다. 다음 인증도 loopback 포트를 열지 않는다.
            redirect_uri: String::new(),
            resource: metadata.resource.clone(),
            scope: scope.clone(),
            authorized_at: plugin
                .oauth
                .as_ref()
                .and_then(|record| record.authorized_at),
            access_expires_at: plugin
                .oauth
                .as_ref()
                .and_then(|record| record.access_expires_at),
        };
        self.update_plugin(&id, |plugin| {
            plugin.oauth = Some(record.clone());
            plugin.last_error = None;
            Ok(())
        })?;

        let cancel = Arc::new(AtomicBool::new(false));
        // 승인 대기 상한은 콜백 방식과 같게 두되, 서버가 더 짧은 만료를 주면 그쪽을 따른다.
        let expires_at = now_ms()
            + (authorization.expires_in * 1000).min(OAUTH_CALLBACK_TIMEOUT.as_millis() as i64);
        if let Ok(mut pending) = pending_oauth().lock() {
            pending.insert(
                id.clone(),
                PendingOAuth {
                    cancel: Arc::clone(&cancel),
                    expires_at,
                },
            );
        }
        let registry = self.clone();
        let plugin_id = id.clone();
        let token_endpoint = metadata.token_endpoint.clone();
        let device_code = authorization.device_code.clone();
        let interval = authorization.interval;
        let user_code = authorization.user_code.clone();
        let verification_url = authorization.verification_url.clone();
        thread::Builder::new()
            .name(format!("agent-manager-plugin-device-{plugin_id}"))
            .spawn(move || {
                let outcome = wait_for_device_authorization(
                    &token_endpoint,
                    &client_id,
                    &device_code,
                    client_secret.as_deref(),
                    interval,
                    expires_at,
                    &cancel,
                );
                if let Ok(mut pending) = pending_oauth().lock() {
                    pending.remove(&plugin_id);
                }
                if cancel.load(Ordering::Acquire) {
                    return;
                }
                let result = match outcome {
                    Ok(tokens) => registry.store_oauth_tokens(&plugin_id, tokens),
                    Err(error) => registry
                        .update_plugin(&plugin_id, |plugin| {
                            plugin.last_error = Some(format!(
                                "디바이스 인가 실패: {}",
                                text_limit::truncate_chars(&error.to_string(), 300)
                            ));
                            Ok(())
                        })
                        .map(|_| ()),
                };
                if let Err(error) = result {
                    eprintln!(
                        "[external-plugins] {plugin_id} 디바이스 인가 결과를 기록하지 못했습니다: {error}"
                    );
                }
            })
            .map_err(|error| {
                CoreError::Runtime(format!("디바이스 인가 스레드를 시작할 수 없습니다: {error}"))
            })?;
        Ok(ExternalPluginOAuthStart {
            id,
            authorization_url: verification_url,
            expires_at,
            user_code: Some(user_code),
        })
    }

    pub fn cancel_oauth(&self, id: &str) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        cancel_pending_oauth(id);
        let plugin = self.find_plugin(id)?;
        Ok(plugin_view(&plugin, false))
    }

    fn store_oauth_tokens(&self, id: &str, tokens: TokenResponse) -> Result<(), CoreError> {
        self.with_store_lock(|| {
            let mut document = read_secret(id)?.unwrap_or_default();
            document.access_token = Some(tokens.access_token);
            if let Some(refresh) = tokens.refresh_token {
                document.refresh_token = Some(refresh);
            }
            document.expires_at = tokens.expires_at;
            write_secret(id, &document)?;
            let mut store = self.load_store_unlocked()?;
            let plugin = store
                .plugins
                .iter_mut()
                .find(|plugin| plugin.id == id)
                .ok_or_else(|| {
                    CoreError::NotFound("등록된 외부 플러그인을 찾을 수 없습니다".to_owned())
                })?;
            let now = now_ms();
            plugin.secret_stored_at = Some(now);
            plugin.updated_at = now;
            plugin.last_error = None;
            if let Some(record) = plugin.oauth.as_mut() {
                record.authorized_at = Some(now);
                record.access_expires_at = tokens.expires_at;
            }
            self.save_store_unlocked(&store)
        })
    }

    // -- 프록시 ---------------------------------------------------------------

    /// CLI가 보낸 MCP 요청을 인증을 붙여 상류로 전달한다. OAuth는 만료 전 갱신하고, 상류가
    /// 401을 돌려주면 한 번 갱신해 다시 시도한다. 반환 본문에는 인증정보가 없다.
    pub(crate) fn proxy(
        &self,
        id: &str,
        request: ProxyRequest,
    ) -> Result<ProxyResponse, CoreError> {
        validate_plugin_id(id)?;
        let plugin = self.find_plugin(id)?;
        // 제한한 도구는 상류에 닿기 전에 막는다. 목록에서도 지우므로 CLI는 그런 도구가
        // 있다는 사실조차 모르지만, 이전 턴의 목록을 들고 있는 실행이 뒤늦게 부를 수 있다.
        let intent = ProxyIntent::of(&request.body);
        if let ProxyIntent::CallTool(tool) = &intent {
            if plugin.tool_policies.get(tool) == Some(&PluginToolPolicy::Deny) {
                return Ok(denied_tool_response(&request.body, tool));
            }
        }
        let (upstream, authorization) = self.upstream_for(&plugin)?;
        let client = proxy_client()?;
        let response = send_proxy_request(
            &client,
            &upstream,
            authorization.as_ref().map(|value| value.as_str()),
            &request,
        )?;
        if response.status == StatusCode::UNAUTHORIZED.as_u16() && plugin.auth.is_oauth() {
            match self.refresh_oauth_access(&plugin, true) {
                Ok(Some(refreshed)) => {
                    let retried =
                        send_proxy_request(&client, &upstream, Some(&refreshed), &request)?;
                    return Ok(hide_denied_tools(retried, &intent, &plugin.tool_policies));
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = self.update_plugin(id, |plugin| {
                        plugin.last_error = Some(format!(
                            "인증이 만료되어 다시 인증해야 합니다: {}",
                            text_limit::truncate_chars(&error.to_string(), 200)
                        ));
                        Ok(())
                    });
                }
            }
        }
        Ok(hide_denied_tools(response, &intent, &plugin.tool_policies))
    }

    fn upstream_for(
        &self,
        plugin: &StoredPlugin,
    ) -> Result<(String, Option<Zeroizing<String>>), CoreError> {
        match plugin.auth {
            PluginAuthKind::None => Ok((required_url(plugin)?, None)),
            PluginAuthKind::Bearer => {
                let document = read_secret(&plugin.id)?.ok_or_else(missing_credential)?;
                let token = document.bearer.ok_or_else(missing_credential)?;
                Ok((
                    required_url(plugin)?,
                    Some(Zeroizing::new(format!("Bearer {token}"))),
                ))
            }
            PluginAuthKind::OAuth | PluginAuthKind::OAuthDevice => {
                let authorization = self
                    .refresh_oauth_access(plugin, false)?
                    .ok_or_else(missing_credential)?;
                Ok((required_url(plugin)?, Some(authorization)))
            }
            PluginAuthKind::NotionToken => {
                let document = read_secret(&plugin.id)?.ok_or_else(missing_credential)?;
                let token = document.notion_token.ok_or_else(missing_credential)?;
                let (port, auth_token) = ensure_notion_server(&plugin.id, &token)?;
                Ok((
                    format!("http://127.0.0.1:{port}/mcp"),
                    Some(Zeroizing::new(format!("Bearer {auth_token}"))),
                ))
            }
        }
    }

    /// 현재 access token, 필요하면 갱신한 값. `force`는 상류가 401을 돌려준 뒤의 재시도다.
    /// refresh token이 없으면 None — 사용자가 다시 인증해야 한다.
    fn refresh_oauth_access(
        &self,
        plugin: &StoredPlugin,
        force: bool,
    ) -> Result<Option<Zeroizing<String>>, CoreError> {
        let record = plugin.oauth.as_ref().ok_or_else(missing_credential)?;
        self.with_store_lock(|| {
            let mut document = read_secret(&plugin.id)?.ok_or_else(missing_credential)?;
            let expiring = document
                .expires_at
                .is_some_and(|expires| expires - ACCESS_TOKEN_REFRESH_MARGIN_MS <= now_ms());
            if !force && !expiring {
                return Ok(document
                    .access_token
                    .map(|token| Zeroizing::new(format!("Bearer {token}"))));
            }
            let Some(refresh_token) = document.refresh_token.clone() else {
                return Ok(if force {
                    None
                } else {
                    document
                        .access_token
                        .map(|token| Zeroizing::new(format!("Bearer {token}")))
                });
            };
            let tokens = refresh_tokens(record, &refresh_token, document.client_secret.as_deref())?;
            document.access_token = Some(tokens.access_token.clone());
            // OAuth 2.1은 공개 클라이언트의 refresh token을 회전시킨다. 새 값이 오면 즉시 바꾼다.
            if let Some(rotated) = tokens.refresh_token {
                document.refresh_token = Some(rotated);
            }
            document.expires_at = tokens.expires_at;
            write_secret(&plugin.id, &document)?;
            let mut store = self.load_store_unlocked()?;
            if let Some(stored) = store.plugins.iter_mut().find(|item| item.id == plugin.id) {
                if let Some(record) = stored.oauth.as_mut() {
                    record.access_expires_at = tokens.expires_at;
                }
                stored.updated_at = now_ms();
                self.save_store_unlocked(&store)?;
            }
            Ok(Some(Zeroizing::new(format!(
                "Bearer {}",
                tokens.access_token
            ))))
        })
    }

    // -- 저장소 -----------------------------------------------------------------

    fn find_plugin(&self, id: &str) -> Result<StoredPlugin, CoreError> {
        self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            store
                .plugins
                .into_iter()
                .find(|plugin| plugin.id == id)
                .ok_or_else(|| {
                    CoreError::NotFound("등록된 외부 플러그인을 찾을 수 없습니다".to_owned())
                })
        })
    }

    fn require_aia_attachable_plugin(&self, id: &str) -> Result<StoredPlugin, CoreError> {
        validate_plugin_id(id)?;
        let plugin = self.find_plugin(id)?;
        if !plugin.enabled {
            return Err(CoreError::Conflict(
                "외부 플러그인이 꺼져 있습니다. 먼저 사용 토글을 켜 주세요".to_owned(),
            ));
        }
        if !credential_ready(&plugin) {
            return Err(missing_credential());
        }
        Ok(plugin)
    }

    fn update_plugin(
        &self,
        id: &str,
        update: impl FnOnce(&mut StoredPlugin) -> Result<(), CoreError>,
    ) -> Result<StoredPlugin, CoreError> {
        self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            let plugin = store
                .plugins
                .iter_mut()
                .find(|plugin| plugin.id == id)
                .ok_or_else(|| {
                    CoreError::NotFound("등록된 외부 플러그인을 찾을 수 없습니다".to_owned())
                })?;
            update(plugin)?;
            plugin.updated_at = now_ms();
            let updated = plugin.clone();
            self.save_store_unlocked(&store)?;
            Ok(updated)
        })
    }

    fn with_store_lock<T>(
        &self,
        action: impl FnOnce() -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        STORE.with_lock(&self.app_data_dir, action)
    }

    fn load_store_unlocked(&self) -> Result<PluginStore, CoreError> {
        STORE.load_unlocked(&self.app_data_dir)
    }

    fn save_store_unlocked(&self, store: &PluginStore) -> Result<(), CoreError> {
        STORE.save_unlocked(&self.app_data_dir, store)
    }
}

/// 동적 등록을 지원하지 않는 인증 서버용으로 client_id만 미리 기억하는 OAuth 레코드.
/// 엔드포인트와 redirect URI는 첫 인증 때 디스커버리로 채운다.
fn new_manual_oauth_record(client_id: String) -> OAuthClientRecord {
    OAuthClientRecord {
        authorization_endpoint: String::new(),
        token_endpoint: String::new(),
        registration_endpoint: None,
        client_id,
        redirect_uri: String::new(),
        resource: String::new(),
        scope: None,
        authorized_at: None,
        access_expires_at: None,
    }
}

/// 저장된 클라이언트 등록을 재사용할 수 있는지. 수동 입력 레코드(빈 endpoint·redirect)는
/// 항상 재사용하고, 등록을 마친 레코드는 인증 서버와 콜백 포트가 그대로일 때만 재사용한다.
fn can_reuse_client_registration(
    record: &OAuthClientRecord,
    redirect_uri: &str,
    metadata: &OAuthServerMetadata,
) -> bool {
    let same_server = record.token_endpoint == metadata.token_endpoint
        && record.authorization_endpoint == metadata.authorization_endpoint;
    !record.client_id.is_empty()
        && (record.redirect_uri == redirect_uri || record.redirect_uri.is_empty())
        && (same_server || record.token_endpoint.is_empty())
}

/// 이 주소가 프리셋 테이블에 있으면 그 항목을 돌려준다.
fn hosted_preset_for(url: &str) -> Option<&'static HostedMcpPreset> {
    let url = url.trim_end_matches('/');
    HOSTED_MCPS
        .iter()
        .find(|preset| preset.url.trim_end_matches('/') == url)
}

/// authorize 요청에 실을 scope를 고른다. 우선순위는 사용자가 저장한 값 → 프리셋
/// override → 디스커버리가 알려 준 값 → 프리셋 기본값이다. 아틀라시안·GitHub은 보호 자원
/// 메타데이터에 삭제·관리까지 모두 실어 보내므로 그대로 요청하지 않는다.
fn resolve_scope(
    stored: Option<&str>,
    discovered: Option<&str>,
    preset: Option<&HostedMcpPreset>,
) -> Option<String> {
    if let Some(scope) = stored.map(str::trim).filter(|scope| !scope.is_empty()) {
        return Some(scope.to_owned());
    }
    let preset_scope = preset
        .map(|preset| preset.default_scope)
        .filter(|scope| !scope.is_empty());
    if let Some(scope) = preset_scope {
        if preset.is_some_and(|preset| preset.scope_mode == ScopeMode::Override) {
            return Some(scope.to_owned());
        }
    }
    discovered
        .map(str::trim)
        .filter(|scope| !scope.is_empty())
        .map(str::to_owned)
        .or_else(|| preset_scope.map(str::to_owned))
}

fn is_google_authorization_endpoint(endpoint: &str) -> bool {
    Url::parse(endpoint)
        .ok()
        .is_some_and(|url| url.host_str() == Some("accounts.google.com"))
}

fn required_url(plugin: &StoredPlugin) -> Result<String, CoreError> {
    plugin
        .url
        .clone()
        .ok_or_else(|| CoreError::InvalidInput("플러그인에 서버 주소가 없습니다".to_owned()))
}

fn missing_credential() -> CoreError {
    CoreError::Conflict(
        "플러그인 자격증명이 없습니다. 설정에서 인증하거나 토큰을 등록해 주세요".to_owned(),
    )
}

fn credential_ready(plugin: &StoredPlugin) -> bool {
    if !plugin.auth.needs_secret() {
        return true;
    }
    if plugin.auth.is_oauth() {
        return plugin
            .oauth
            .as_ref()
            .is_some_and(|record| record.authorized_at.is_some())
            && plugin.secret_stored_at.is_some();
    }
    plugin.secret_stored_at.is_some()
}

fn ensure_aia_tool_access(
    tool: &crate::mcp_registry::McpRemoteTool,
    require_read_only: bool,
) -> Result<(), CoreError> {
    if tool.read_only == require_read_only {
        return Ok(());
    }
    Err(CoreError::InvalidInput(if require_read_only {
        "변경 가능 외부 플러그인 도구는 execute_external_plugin_tool로 호출해야 합니다".to_owned()
    } else {
        "읽기 전용 외부 플러그인 도구는 read_external_plugin_tool로 호출해야 합니다".to_owned()
    }))
}

fn plugin_view(plugin: &StoredPlugin, oauth_pending: bool) -> ExternalPluginView {
    let credential_ready = credential_ready(plugin);
    ExternalPluginView {
        id: plugin.id.clone(),
        display_name: plugin.display_name.clone(),
        url: plugin.url.clone(),
        auth: plugin.auth,
        enabled: plugin.enabled,
        scope: plugin.scope.clone(),
        tool_policies: plugin.tool_policies.clone(),
        credential_ready,
        oauth_pending,
        attachable: plugin.enabled && credential_ready,
        server_name: plugin.server_name.clone(),
        tools: plugin.tools.clone(),
        last_verified_at: plugin.last_verified_at,
        last_error: plugin.last_error.clone(),
        authorized_at: plugin
            .oauth
            .as_ref()
            .and_then(|record| record.authorized_at),
        access_expires_at: plugin
            .oauth
            .as_ref()
            .and_then(|record| record.access_expires_at),
        created_at: plugin.created_at,
        updated_at: plugin.updated_at,
    }
}

fn pending_oauth_ids() -> BTreeSet<String> {
    let now = now_ms();
    pending_oauth()
        .lock()
        .map(|mut pending| {
            pending.retain(|_, flow| flow.expires_at > now || !flow.cancel.load(Ordering::Acquire));
            pending.keys().cloned().collect()
        })
        .unwrap_or_default()
}

fn cancel_pending_oauth(id: &str) {
    if let Ok(mut pending) = pending_oauth().lock() {
        if let Some(flow) = pending.remove(id) {
            flow.cancel.store(true, Ordering::Release);
        }
    }
}

// ---------------------------------------------------------------------------
// 비밀값 저장
// ---------------------------------------------------------------------------

fn read_secret(id: &str) -> Result<Option<SecretDocument>, CoreError> {
    let Some(raw) = read_os_keychain_password(KEYCHAIN_SERVICE, id)? else {
        return Ok(None);
    };
    serde_json::from_str::<SecretDocument>(&raw)
        .map(Some)
        .map_err(|_| CoreError::Runtime("플러그인 비밀 문서를 해석하지 못했습니다".to_owned()))
}

fn write_secret(id: &str, document: &SecretDocument) -> Result<(), CoreError> {
    let serialized = Zeroizing::new(serde_json::to_string(document)?);
    write_os_keychain_password(KEYCHAIN_SERVICE, id, &serialized)
}

// ---------------------------------------------------------------------------
// 검증
// ---------------------------------------------------------------------------

/// 플러그인 id는 MCP 서버 이름으로 그대로 쓰인다. Claude는 `[a-zA-Z0-9_-]+`, Codex는
/// TOML bare key를 요구하므로 교집합인 소문자·숫자·`_`·`-`만 허용한다.
pub(crate) fn validate_plugin_id(value: &str) -> Result<(), CoreError> {
    if !crate::identifier::is_lowercase_slug(value, 32) {
        return Err(CoreError::InvalidInput(
            "플러그인 id는 영문 소문자나 숫자로 시작하는 32자 이하의 소문자·숫자·_·- 조합이어야 합니다".to_owned(),
        ));
    }
    Ok(())
}

/// 등록·편집이 같은 규칙으로 URL을 받는다. Notion 내부 통합 토큰 방식은 서버를 Agent
/// Manager가 직접 띄우므로 URL 자체를 거절한다.
fn validate_request_url(
    auth: PluginAuthKind,
    url: Option<&str>,
) -> Result<Option<String>, CoreError> {
    if auth == PluginAuthKind::NotionToken {
        if url.is_some_and(|url| !url.trim().is_empty()) {
            return Err(CoreError::InvalidInput(
                "Notion 내부 통합 토큰 방식은 서버를 Agent Manager가 직접 띄우므로 URL을 받지 않습니다"
                    .to_owned(),
            ));
        }
        return Ok(None);
    }
    Ok(Some(validate_endpoint(url.unwrap_or_default())?))
}

/// 토큰을 받는 방식이면 검사해서 돌려주고, 받지 않는 방식이면 값이 온 것 자체를 거절한다.
/// `required`는 등록(항상 있어야 한다)과 편집(생략하면 기존 토큰을 유지한다)을 가른다.
fn validate_request_token(
    auth: PluginAuthKind,
    token: Option<&str>,
    required: bool,
) -> Result<Option<String>, CoreError> {
    if matches!(auth, PluginAuthKind::Bearer | PluginAuthKind::NotionToken) {
        if required {
            return Ok(Some(validate_token(token.unwrap_or_default(), auth)?));
        }
        return token.map(|token| validate_token(token, auth)).transpose();
    }
    if token.is_some_and(|token| !token.is_empty()) {
        return Err(CoreError::InvalidInput(
            "이 인증 방식은 토큰을 받지 않습니다".to_owned(),
        ));
    }
    Ok(None)
}

/// 토큰 하나만 담은 보안 저장소 문서를 만든다. 방식에 따라 담기는 칸이 다르고, 나머지
/// 칸을 비워 두는 것이 이전 자격증명을 폐기하는 수단이다.
fn token_secret_document(token: &str, auth: PluginAuthKind) -> SecretDocument {
    match auth {
        PluginAuthKind::Bearer => SecretDocument {
            bearer: Some(token.to_owned()),
            ..SecretDocument::default()
        },
        _ => SecretDocument {
            notion_token: Some(token.to_owned()),
            ..SecretDocument::default()
        },
    }
}

fn validate_display_name(value: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 || value.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(
            "플러그인 표시 이름은 제어문자 없는 1~80자여야 합니다".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn validate_client_id(value: &str) -> Result<String, CoreError> {
    if value.is_empty()
        || value.len() > 256
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(CoreError::InvalidInput(
            "clientId 형식이 올바르지 않습니다".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

/// 수동 client_secret은 수동 client_id에 딸린 값으로만 받는다. 단독이면 어느 클라이언트의
/// 것인지 알 수 없고, update의 자격증명 초기화 판정도 client_id 공급 여부 하나로 수렴시킨다.
fn validate_manual_client_secret(
    value: Option<&str>,
    manual_client_id: &Option<String>,
) -> Result<Option<String>, CoreError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if manual_client_id.is_none() {
        return Err(CoreError::InvalidInput(
            "clientSecret은 clientId와 함께 입력해야 합니다".to_owned(),
        ));
    }
    if value.len() > 512 || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(CoreError::InvalidInput(
            "clientSecret 형식이 올바르지 않습니다".to_owned(),
        ));
    }
    Ok(Some(value.to_owned()))
}

/// authorize 요청에 실을 scope. 공백으로 나뉜 토큰 목록(RFC 6749 3.3)이라 공백을 정리하고
/// 중복을 지운 표준형으로 저장한다. 빈 값은 "고르지 않음"이라 프리셋 기본값이 쓰인다.
fn validate_scope(value: Option<&str>, auth: PluginAuthKind) -> Result<Option<String>, CoreError> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if !auth.is_oauth() {
        return Err(CoreError::InvalidInput(
            "scope는 OAuth 방식에서만 쓰입니다".to_owned(),
        ));
    }
    if value.len() > 1024 || value.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(
            "scope는 제어문자 없는 1024자 이하여야 합니다".to_owned(),
        ));
    }
    let mut seen = BTreeSet::new();
    let scopes = value
        .split_whitespace()
        .filter(|scope| seen.insert(*scope))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(Some(scopes))
}

fn validate_token(value: &str, auth: PluginAuthKind) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > MAX_TOKEN_CHARS
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(CoreError::InvalidInput(
            "토큰은 공백·제어문자 없는 1~4096자여야 합니다".to_owned(),
        ));
    }
    if auth == PluginAuthKind::NotionToken
        && !(value.starts_with("ntn_") || value.starts_with("secret_"))
    {
        return Err(CoreError::InvalidInput(
            "Notion 내부 통합 토큰은 ntn_ 또는 secret_으로 시작합니다".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

/// 원격은 HTTPS, 로컬은 loopback HTTP도 허용한다. URL에 인증정보·query·fragment는 거절한다(E2·E3).
pub(crate) fn validate_endpoint(input: &str) -> Result<String, CoreError> {
    let url = Url::parse(input.trim())
        .map_err(|_| CoreError::InvalidInput("올바른 MCP HTTP URL이 아닙니다".to_owned()))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CoreError::InvalidInput(
            "MCP URL에는 사용자정보, 비밀번호, query 또는 fragment를 넣을 수 없습니다".to_owned(),
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::InvalidInput("MCP URL에 호스트가 없습니다".to_owned()))?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => {
            return Err(CoreError::InvalidInput(
                "원격 MCP는 HTTPS만, 로컬 MCP는 loopback HTTP 또는 HTTPS만 허용됩니다".to_owned(),
            ))
        }
    }
    Ok(url.to_string())
}

fn validate_https_or_loopback(url: &str, what: &str) -> Result<Url, CoreError> {
    let parsed = Url::parse(url)
        .map_err(|_| CoreError::Runtime(format!("{what} 주소가 올바르지 않습니다")))?;
    let loopback = matches!(
        parsed.host_str(),
        Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
    );
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err(CoreError::Runtime(format!(
            "{what} 주소는 HTTPS여야 합니다"
        )));
    }
    Ok(parsed)
}

// ---------------------------------------------------------------------------
// OAuth: 디스커버리·등록·교환·갱신
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
struct OAuthServerMetadata {
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    /// RFC 8628 디바이스 인가 endpoint. 광고하지 않는 서버는 None이다.
    device_authorization_endpoint: Option<String>,
    resource: String,
    scope: Option<String>,
}

fn discovery_client() -> Result<Client, CoreError> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(DISCOVERY_TIMEOUT)
        .redirect(Policy::none())
        .user_agent("agent-manager-plugins/1")
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!("HTTP 클라이언트를 만들지 못했습니다: {error}"))
        })
}

fn proxy_client() -> Result<Client, CoreError> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(PROXY_TIMEOUT)
        .redirect(Policy::none())
        .user_agent("agent-manager-plugins/1")
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!("HTTP 클라이언트를 만들지 못했습니다: {error}"))
        })
}

/// MCP 인증 스펙 순서대로 인증 서버를 찾는다: 401의 `WWW-Authenticate` →
/// protected resource metadata(RFC 9728) → authorization server metadata(RFC 8414).
/// 메타데이터가 없는 서버는 자기 origin을 인증 서버로 보는 2025-03-26 규칙으로 물러난다.
fn discover_oauth(mcp_url: &str) -> Result<OAuthServerMetadata, CoreError> {
    let client = discovery_client()?;
    let mcp = validate_https_or_loopback(mcp_url, "MCP 서버")?;
    let canonical_resource = canonical_resource(&mcp);

    let mut resource_metadata_url: Option<String> = None;
    if let Ok(response) = client
        .post(mcp_url)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json, text/event-stream")
        .body(json!({"jsonrpc":"2.0","id":0,"method":"ping"}).to_string())
        .send()
    {
        if response.status() == StatusCode::UNAUTHORIZED {
            resource_metadata_url = response
                .headers()
                .get(WWW_AUTHENTICATE)
                .and_then(|value| value.to_str().ok())
                .and_then(parse_resource_metadata_url);
        }
    }
    let mut candidates = Vec::new();
    if let Some(url) = resource_metadata_url {
        candidates.push(url);
    }
    let origin = url_origin(&mcp);
    let path = mcp.path().trim_end_matches('/');
    if !path.is_empty() {
        candidates.push(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ));
    }
    candidates.push(format!("{origin}/.well-known/oauth-protected-resource"));

    let mut authorization_server = origin.clone();
    let mut resource = canonical_resource.clone();
    let mut scope: Option<String> = None;
    let mut found_resource_metadata = false;
    for candidate in candidates {
        if let Some(document) = fetch_json(&client, &candidate) {
            if let Some(server) = document
                .get("authorization_servers")
                .and_then(Value::as_array)
                .and_then(|servers| servers.first())
                .and_then(Value::as_str)
            {
                found_resource_metadata = true;
                authorization_server = server.trim_end_matches('/').to_owned();
                if let Some(declared) = document.get("resource").and_then(Value::as_str) {
                    resource = declared.to_owned();
                }
                scope = document
                    .get("scopes_supported")
                    .and_then(Value::as_array)
                    .map(|scopes| {
                        scopes
                            .iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .filter(|value| !value.is_empty());
                break;
            }
        }
    }
    // RFC 9728 메타데이터가 없으면 origin을 인증 서버로 보는 폴백이 구글 공식 MCP에서는
    // 존재하지 않는 endpoint(`{origin}/authorize`)로 낙착한다. 알려진 구글 MCP는 인증
    // 서버가 구글 계정임이 확실하므로 그쪽 well-known 조회로 바로 간다.
    if !found_resource_metadata
        && hosted_preset_for(mcp_url).is_some_and(|preset| preset.brand == "google")
    {
        authorization_server = GOOGLE_AUTHORIZATION_SERVER.to_owned();
    }

    let as_url = validate_https_or_loopback(&authorization_server, "인증 서버")?;
    let as_origin = url_origin(&as_url);
    let as_path = as_url.path().trim_end_matches('/');
    let mut metadata_candidates = Vec::new();
    if !as_path.is_empty() {
        metadata_candidates.push(format!(
            "{as_origin}/.well-known/oauth-authorization-server{as_path}"
        ));
        metadata_candidates.push(format!(
            "{as_origin}/.well-known/openid-configuration{as_path}"
        ));
        metadata_candidates.push(format!(
            "{as_origin}{as_path}/.well-known/openid-configuration"
        ));
    }
    metadata_candidates.push(format!(
        "{as_origin}/.well-known/oauth-authorization-server"
    ));
    metadata_candidates.push(format!("{as_origin}/.well-known/openid-configuration"));

    let mut metadata: Option<OAuthServerMetadata> = None;
    for candidate in metadata_candidates {
        if let Some(document) = fetch_json(&client, &candidate) {
            let (Some(authorize), Some(token)) = (
                document
                    .get("authorization_endpoint")
                    .and_then(Value::as_str),
                document.get("token_endpoint").and_then(Value::as_str),
            ) else {
                continue;
            };
            if let Some(methods) = document
                .get("code_challenge_methods_supported")
                .and_then(Value::as_array)
            {
                if !methods.iter().any(|method| method.as_str() == Some("S256")) {
                    return Err(CoreError::Conflict(
                        "인증 서버가 PKCE S256을 지원하지 않아 연결할 수 없습니다".to_owned(),
                    ));
                }
            }
            metadata = Some(OAuthServerMetadata {
                authorization_endpoint: authorize.to_owned(),
                token_endpoint: token.to_owned(),
                registration_endpoint: document
                    .get("registration_endpoint")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                device_authorization_endpoint: document
                    .get("device_authorization_endpoint")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                resource: resource.clone(),
                scope: scope.clone(),
            });
            break;
        }
    }
    let metadata = metadata.unwrap_or(OAuthServerMetadata {
        authorization_endpoint: format!("{as_origin}/authorize"),
        token_endpoint: format!("{as_origin}/token"),
        registration_endpoint: Some(format!("{as_origin}/register")),
        device_authorization_endpoint: None,
        resource,
        scope,
    });
    validate_https_or_loopback(&metadata.authorization_endpoint, "authorization_endpoint")?;
    validate_https_or_loopback(&metadata.token_endpoint, "token_endpoint")?;
    if let Some(registration) = &metadata.registration_endpoint {
        validate_https_or_loopback(registration, "registration_endpoint")?;
    }
    if let Some(device) = &metadata.device_authorization_endpoint {
        validate_https_or_loopback(device, "device_authorization_endpoint")?;
    }
    Ok(metadata)
}

/// RFC 8707 canonical URI: 소문자 scheme·host, 끝 슬래시 없음, query·fragment 없음.
fn canonical_resource(url: &Url) -> String {
    let mut canonical = url.clone();
    canonical.set_query(None);
    canonical.set_fragment(None);
    let text = canonical.to_string();
    if canonical.path() == "/" {
        text.trim_end_matches('/').to_owned()
    } else {
        text
    }
}

/// URL의 scheme·host·port만 RFC 3986 표기 그대로 직렬화한다.
/// 특히 IPv6 host에는 대괄호를 보존해야 well-known 메타데이터 URL을 다시 해석할 수 있다.
fn url_origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// `WWW-Authenticate: Bearer resource_metadata="https://…"`에서 주소를 뽑는다.
fn parse_resource_metadata_url(header: &str) -> Option<String> {
    let start = header.find("resource_metadata")?;
    let rest = &header[start + "resource_metadata".len()..];
    let rest = rest.trim_start().strip_prefix('=')?.trim_start();
    let value = if let Some(quoted) = rest.strip_prefix('"') {
        quoted.split('"').next()?
    } else {
        rest.split([',', ' ']).next()?
    };
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn fetch_json(client: &Client, url: &str) -> Option<Value> {
    if validate_https_or_loopback(url, "메타데이터").is_err() {
        return None;
    }
    let response = client
        .get(url)
        .header(ACCEPT, "application/json")
        .header("mcp-protocol-version", "2025-06-18")
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.bytes().ok()?;
    if body.len() > 256 * 1024 {
        return None;
    }
    serde_json::from_slice::<Value>(&body)
        .ok()
        .filter(Value::is_object)
}

struct RegisteredClient {
    client_id: String,
    client_secret: Option<String>,
}

/// RFC 7591 동적 클라이언트 등록. 공개 클라이언트로 등록해 client_secret 없이 PKCE로 교환한다.
fn register_oauth_client(
    registration_endpoint: &str,
    redirect_uri: &str,
    scope: Option<&str>,
) -> Result<RegisteredClient, CoreError> {
    let client = discovery_client()?;
    let mut payload = json!({
        "client_name": OAUTH_CLIENT_NAME,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none"
    });
    if let Some(scope) = scope {
        payload["scope"] = Value::String(scope.to_owned());
    }
    let response = client
        .post(registration_endpoint)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json")
        .body(payload.to_string())
        .send()
        .map_err(|error| {
            CoreError::Runtime(format!("클라이언트 등록 요청이 실패했습니다: {error}"))
        })?;
    let status = response.status();
    let body: Value = response
        .json()
        .map_err(|_| CoreError::Runtime("클라이언트 등록 응답을 해석하지 못했습니다".to_owned()))?;
    if !status.is_success() {
        return Err(CoreError::Runtime(format!(
            "클라이언트 등록이 거절되었습니다 (HTTP {}): {}",
            status.as_u16(),
            body.get("error_description")
                .or_else(|| body.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("이유 없음")
        )));
    }
    let client_id = body
        .get("client_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CoreError::Runtime("클라이언트 등록 응답에 client_id가 없습니다".to_owned())
        })?;
    Ok(RegisteredClient {
        client_id: client_id.to_owned(),
        client_secret: body
            .get("client_secret")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
    })
}

struct OAuthExchange {
    token_endpoint: String,
    client_id: String,
    client_secret: Option<String>,
    redirect_uri: String,
    resource: String,
    code_verifier: String,
    state: String,
}

struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: Option<i64>,
}

fn exchange_code(exchange: &OAuthExchange, code: &str) -> Result<TokenResponse, CoreError> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_owned()),
        ("code", code.to_owned()),
        ("redirect_uri", exchange.redirect_uri.clone()),
        ("client_id", exchange.client_id.clone()),
        ("code_verifier", exchange.code_verifier.clone()),
        ("resource", exchange.resource.clone()),
    ];
    if let Some(secret) = &exchange.client_secret {
        form.push(("client_secret", secret.clone()));
    }
    request_tokens(&exchange.token_endpoint, &form)
}

fn refresh_tokens(
    record: &OAuthClientRecord,
    refresh_token: &str,
    client_secret: Option<&str>,
) -> Result<TokenResponse, CoreError> {
    let mut form = vec![
        ("grant_type", "refresh_token".to_owned()),
        ("refresh_token", refresh_token.to_owned()),
        ("client_id", record.client_id.clone()),
        ("resource", record.resource.clone()),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret.to_owned()));
    }
    request_tokens(&record.token_endpoint, &form)
}

fn request_tokens(
    token_endpoint: &str,
    form: &[(&str, String)],
) -> Result<TokenResponse, CoreError> {
    validate_https_or_loopback(token_endpoint, "token_endpoint")?;
    let client = discovery_client()?;
    let response = client
        .post(token_endpoint)
        .header(ACCEPT, "application/json")
        .form(form)
        .send()
        .map_err(|error| CoreError::Runtime(format!("토큰 요청이 실패했습니다: {error}")))?;
    let status = response.status();
    let body: Value = response
        .json()
        .map_err(|_| CoreError::Runtime("토큰 응답을 해석하지 못했습니다".to_owned()))?;
    if !status.is_success() {
        return Err(CoreError::Runtime(format!(
            "인증 서버가 토큰 발급을 거절했습니다 (HTTP {}): {}",
            status.as_u16(),
            body.get("error_description")
                .or_else(|| body.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("이유 없음")
        )));
    }
    parse_token_response(&body)
}

fn parse_token_response(body: &Value) -> Result<TokenResponse, CoreError> {
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CoreError::Runtime("토큰 응답에 access_token이 없습니다".to_owned()))?
        .to_owned();
    let expires_at = body
        .get("expires_in")
        .and_then(Value::as_i64)
        .filter(|seconds| *seconds > 0)
        .map(|seconds| now_ms() + seconds * 1000);
    Ok(TokenResponse {
        access_token,
        refresh_token: body
            .get("refresh_token")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        expires_at,
    })
}

// ---------------------------------------------------------------------------
// OAuth: 디바이스 인가(RFC 8628)
// ---------------------------------------------------------------------------

const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// 서버가 간격을 알려 주지 않을 때 쓰는 폴링 간격(RFC 8628 3.5 기본값).
const DEVICE_POLL_DEFAULT_INTERVAL: u64 = 5;
/// 서버가 터무니없이 긴 간격을 알려 줘도 승인 대기 상한 안에서 몇 번은 물어본다.
const DEVICE_POLL_MAX_INTERVAL: u64 = 60;

struct DeviceAuthorization {
    device_code: String,
    user_code: String,
    /// 사용자가 열 승인 주소. `verification_uri_complete`가 오면 코드가 이미 채워진 그 주소다.
    verification_url: String,
    expires_in: i64,
    interval: u64,
}

enum DevicePoll {
    Pending,
    SlowDown,
    Tokens(Box<TokenResponse>),
}

/// 디바이스 코드를 받아 사용자에게 보여 줄 코드와 승인 주소를 돌려준다. 공개 클라이언트라
/// client_secret은 싣지 않는다.
fn request_device_code(
    device_endpoint: &str,
    client_id: &str,
    scope: Option<&str>,
) -> Result<DeviceAuthorization, CoreError> {
    validate_https_or_loopback(device_endpoint, "device_authorization_endpoint")?;
    let client = discovery_client()?;
    let mut form = vec![("client_id", client_id.to_owned())];
    if let Some(scope) = scope {
        form.push(("scope", scope.to_owned()));
    }
    let response = client
        .post(device_endpoint)
        .header(ACCEPT, "application/json")
        .form(&form)
        .send()
        .map_err(|error| {
            CoreError::Runtime(format!("디바이스 코드 요청이 실패했습니다: {error}"))
        })?;
    let status = response.status();
    let body: Value = response
        .json()
        .map_err(|_| CoreError::Runtime("디바이스 코드 응답을 해석하지 못했습니다".to_owned()))?;
    if !status.is_success() || body.get("error").is_some() {
        return Err(CoreError::Runtime(format!(
            "인증 서버가 디바이스 코드 발급을 거절했습니다 (HTTP {}): {}",
            status.as_u16(),
            body.get("error_description")
                .or_else(|| body.get("error"))
                .and_then(Value::as_str)
                .unwrap_or("이유 없음")
        )));
    }
    let field = |name: &str| {
        body.get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let device_code = field("device_code").ok_or_else(|| {
        CoreError::Runtime("디바이스 코드 응답에 device_code가 없습니다".to_owned())
    })?;
    let user_code = field("user_code").ok_or_else(|| {
        CoreError::Runtime("디바이스 코드 응답에 user_code가 없습니다".to_owned())
    })?;
    let verification_uri = field("verification_uri")
        .or_else(|| field("verification_url"))
        .ok_or_else(|| {
            CoreError::Runtime("디바이스 코드 응답에 verification_uri가 없습니다".to_owned())
        })?;
    // 코드가 채워진 주소를 주면 그쪽을 연다. 사용자가 코드를 손으로 옮겨 적지 않아도 된다.
    let verification_url = field("verification_uri_complete").unwrap_or(verification_uri);
    validate_https_or_loopback(&verification_url, "verification_uri")?;
    Ok(DeviceAuthorization {
        device_code,
        user_code,
        verification_url,
        expires_in: body
            .get("expires_in")
            .and_then(Value::as_i64)
            .filter(|seconds| *seconds > 0)
            .unwrap_or(600),
        interval: body
            .get("interval")
            .and_then(Value::as_u64)
            .filter(|interval| *interval > 0)
            .unwrap_or(DEVICE_POLL_DEFAULT_INTERVAL)
            .min(DEVICE_POLL_MAX_INTERVAL),
    })
}

/// 토큰 endpoint를 한 번 물어본다. GitHub은 아직 승인 전이어도 HTTP 200에 `error`를 실어
/// 보내므로 상태 코드가 아니라 본문의 `error`로 갈라야 한다.
fn poll_device_token(
    token_endpoint: &str,
    client_id: &str,
    device_code: &str,
    client_secret: Option<&str>,
) -> Result<DevicePoll, CoreError> {
    validate_https_or_loopback(token_endpoint, "token_endpoint")?;
    let client = discovery_client()?;
    let mut form = vec![
        ("grant_type", DEVICE_CODE_GRANT.to_owned()),
        ("device_code", device_code.to_owned()),
        ("client_id", client_id.to_owned()),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret.to_owned()));
    }
    let response = client
        .post(token_endpoint)
        .header(ACCEPT, "application/json")
        .form(&form)
        .send()
        .map_err(|error| CoreError::Runtime(format!("토큰 요청이 실패했습니다: {error}")))?;
    let status = response.status();
    let body: Value = response
        .json()
        .map_err(|_| CoreError::Runtime("토큰 응답을 해석하지 못했습니다".to_owned()))?;
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        let description = body
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or(error);
        return match error {
            "authorization_pending" => Ok(DevicePoll::Pending),
            "slow_down" => Ok(DevicePoll::SlowDown),
            "expired_token" => Err(CoreError::Conflict(
                "사용자 코드가 만료되었습니다. 다시 인증을 시작해 주세요".to_owned(),
            )),
            "access_denied" => Err(CoreError::Conflict(
                "브라우저에서 승인이 거부되었습니다".to_owned(),
            )),
            _ => Err(CoreError::Runtime(format!(
                "인증 서버가 토큰 발급을 거절했습니다: {description}"
            ))),
        };
    }
    if !status.is_success() {
        return Err(CoreError::Runtime(format!(
            "인증 서버가 토큰 발급을 거절했습니다 (HTTP {})",
            status.as_u16()
        )));
    }
    parse_token_response(&body).map(|tokens| DevicePoll::Tokens(Box::new(tokens)))
}

/// 승인이 끝날 때까지 토큰 endpoint를 물어본다. `slow_down`을 받으면 RFC 8628 3.5대로
/// 간격을 5초 늘린다. 취소와 만료는 콜백 방식과 같은 규칙이다.
#[allow(clippy::too_many_arguments)]
fn wait_for_device_authorization(
    token_endpoint: &str,
    client_id: &str,
    device_code: &str,
    client_secret: Option<&str>,
    interval: u64,
    expires_at: i64,
    cancel: &AtomicBool,
) -> Result<TokenResponse, CoreError> {
    let mut interval = interval.max(1);
    loop {
        // 폴링 간격은 초 단위지만 취소는 바로 들어야 하므로 잘게 나눠 잔다.
        for _ in 0..(interval * 4) {
            if cancel.load(Ordering::Acquire) {
                return Err(CoreError::Conflict(
                    "OAuth 인증이 취소되었습니다".to_owned(),
                ));
            }
            thread::sleep(Duration::from_millis(250));
        }
        if now_ms() >= expires_at {
            return Err(CoreError::Conflict(
                "브라우저 승인을 기다리는 시간이 지났습니다. 다시 인증을 시작해 주세요".to_owned(),
            ));
        }
        match poll_device_token(token_endpoint, client_id, device_code, client_secret)? {
            DevicePoll::Tokens(tokens) => return Ok(*tokens),
            DevicePoll::Pending => {}
            DevicePoll::SlowDown => {
                interval = (interval + 5).min(DEVICE_POLL_MAX_INTERVAL);
            }
        }
    }
}

fn random_urlsafe(bytes: usize) -> String {
    let mut buffer = Vec::with_capacity(bytes);
    while buffer.len() < bytes {
        buffer.extend_from_slice(Uuid::new_v4().as_bytes());
    }
    buffer.truncate(bytes);
    URL_SAFE_NO_PAD.encode(buffer)
}

// ---------------------------------------------------------------------------
// OAuth 콜백 수신
// ---------------------------------------------------------------------------

/// 저장된 포트가 있으면 그 포트를, 없거나 실패하면 임시 포트를 loopback에 연다.
fn bind_callback_listener(preferred_port: Option<u16>) -> Result<TcpListener, CoreError> {
    if let Some(port) = preferred_port.filter(|port| *port != 0) {
        if let Ok(listener) = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))) {
            return Ok(listener);
        }
    }
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|error| CoreError::Runtime(format!("OAuth 콜백 포트를 열 수 없습니다: {error}")))
}

/// 브라우저가 돌려주는 `GET /callback?code=…&state=…` 한 건을 기다린다. state가 다르거나
/// 오류 응답이면 실패로 끝내고, 그 외 경로(favicon 등)는 404로 흘려보낸다.
fn wait_for_callback(
    listener: &TcpListener,
    expected_state: &str,
    cancel: &AtomicBool,
) -> Result<String, CoreError> {
    listener.set_nonblocking(true)?;
    let deadline = Instant::now() + OAUTH_CALLBACK_TIMEOUT;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(CoreError::Conflict(
                "OAuth 인증이 취소되었습니다".to_owned(),
            ));
        }
        if Instant::now() >= deadline {
            return Err(CoreError::Conflict(
                "브라우저 승인을 기다리는 시간이 지났습니다. 다시 인증을 시작해 주세요".to_owned(),
            ));
        }
        let (mut stream, peer) = match listener.accept() {
            Ok(accepted) => accepted,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(150));
                continue;
            }
            Err(error) => return Err(CoreError::Io(error)),
        };
        if !peer.ip().is_loopback() {
            continue;
        }
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_nonblocking(false);
        let request_line = match read_request_line(&mut stream) {
            Some(line) => line,
            None => continue,
        };
        let Some(target) = request_line.split_whitespace().nth(1) else {
            continue;
        };
        let Some(query) = parse_callback_target(target) else {
            let _ = respond_html(&mut stream, 404, "Not found");
            continue;
        };
        if let Some(error) = query.error {
            let _ = respond_html(
                &mut stream,
                400,
                "Agent Manager: 인증 서버가 요청을 거절했습니다. 앱으로 돌아가 다시 시도하세요.",
            );
            return Err(CoreError::Conflict(format!(
                "인증 서버가 거절했습니다: {error}"
            )));
        }
        if query.state.as_deref() != Some(expected_state) {
            let _ = respond_html(
                &mut stream,
                400,
                "Agent Manager: 인증 상태 값이 일치하지 않습니다.",
            );
            return Err(CoreError::Conflict(
                "OAuth state가 일치하지 않아 응답을 버렸습니다".to_owned(),
            ));
        }
        let Some(code) = query.code else {
            let _ = respond_html(&mut stream, 400, "Agent Manager: 인증 코드가 없습니다.");
            return Err(CoreError::Conflict(
                "콜백에 인증 코드가 없습니다".to_owned(),
            ));
        };
        let _ = respond_html(
            &mut stream,
            200,
            "Agent Manager: 인증이 완료되었습니다. 이 창을 닫고 앱으로 돌아가세요.",
        );
        return Ok(code);
    }
}

fn read_request_line(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 512];
    while buffer.len() < 16 * 1024 {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8_lossy(&buffer);
    text.lines().next().map(str::to_owned)
}

#[derive(Debug, Default, PartialEq)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

fn parse_callback_target(target: &str) -> Option<CallbackQuery> {
    let url = Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    let mut query = CallbackQuery::default();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => query.code = Some(value.into_owned()),
            "state" => query.state = Some(value.into_owned()),
            "error" => {
                query.error = Some(value.into_owned());
            }
            "error_description" => {
                query.error = Some(match query.error.take() {
                    Some(error) => format!("{error}: {value}"),
                    None => value.into_owned(),
                });
            }
            _ => {}
        }
    }
    Some(query)
}

fn respond_html(stream: &mut TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Not Found",
    };
    let body = format!(
        "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>Agent Manager</title></head><body style=\"font-family:system-ui;padding:40px;text-align:center\"><p>{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

// ---------------------------------------------------------------------------
// 프록시 전달
// ---------------------------------------------------------------------------

/// 프록시가 알아봐야 하는 요청 종류. 도구 정책은 이 둘에만 관여한다.
#[derive(Debug, PartialEq)]
enum ProxyIntent {
    ListTools,
    CallTool(String),
    Other,
}

impl ProxyIntent {
    /// CLI가 보낸 JSON-RPC 본문에서 의도를 읽는다. 배치(JSON 배열)는 요소를 모두 훑어
    /// 하나라도 도구 호출이면 그 이름을 돌려준다 — 배치에 섞어 제한을 피하지 못하게 한다.
    fn of(body: &[u8]) -> Self {
        let Ok(payload) = serde_json::from_slice::<Value>(body) else {
            return ProxyIntent::Other;
        };
        let entries: Vec<&Value> = match &payload {
            Value::Array(items) => items.iter().collect(),
            value => vec![value],
        };
        let mut list = false;
        for entry in entries {
            match entry.get("method").and_then(Value::as_str) {
                Some("tools/call") => {
                    if let Some(name) = entry
                        .get("params")
                        .and_then(|params| params.get("name"))
                        .and_then(Value::as_str)
                    {
                        return ProxyIntent::CallTool(name.to_owned());
                    }
                }
                Some("tools/list") => list = true,
                _ => {}
            }
        }
        if list {
            ProxyIntent::ListTools
        } else {
            ProxyIntent::Other
        }
    }
}

/// 제한한 도구 호출에 상류 대신 돌려주는 응답. 프로토콜 오류가 아니라 도구 오류로 주어야
/// CLI가 대화를 끊지 않고 모델에게 거절 사유를 전달한다.
fn denied_tool_response(body: &[u8], tool: &str) -> ProxyResponse {
    let id = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|payload| payload.get("id").cloned())
        .unwrap_or(Value::Null);
    let payload = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "isError": true,
            "content": [{
                "type": "text",
                "text": format!(
                    "Agent Manager 설정에서 이 도구('{tool}')를 제한했습니다. 사용자가 설정에서 허용하거나 확인으로 바꾸기 전에는 호출할 수 없습니다."
                ),
            }],
        }
    });
    ProxyResponse {
        status: 200,
        content_type: Some("application/json".to_owned()),
        session_id: None,
        body: payload.to_string().into_bytes(),
    }
}

/// `tools/list` 응답에서 제한한 도구를 지운다. 스트리밍 응답(`text/event-stream`)은
/// `data:` 줄마다 JSON이 실려 오므로 줄 단위로 다시 쓴다.
fn hide_denied_tools(
    response: ProxyResponse,
    intent: &ProxyIntent,
    policies: &BTreeMap<String, PluginToolPolicy>,
) -> ProxyResponse {
    if *intent != ProxyIntent::ListTools {
        return response;
    }
    let denied: BTreeSet<&str> = policies
        .iter()
        .filter(|(_, policy)| **policy == PluginToolPolicy::Deny)
        .map(|(tool, _)| tool.as_str())
        .collect();
    if denied.is_empty() {
        return response;
    }
    let Ok(text) = std::str::from_utf8(&response.body) else {
        return response;
    };
    let is_event_stream = response
        .content_type
        .as_deref()
        .is_some_and(|value| value.contains("text/event-stream"));
    let rewritten = if is_event_stream {
        let mut lines = Vec::new();
        for line in text.split_inclusive('\n') {
            let (line, ending) = match line.strip_suffix('\n') {
                Some(stripped) => (stripped.strip_suffix('\r').unwrap_or(stripped), "\n"),
                None => (line, ""),
            };
            match line
                .strip_prefix("data:")
                .and_then(|payload| serde_json::from_str::<Value>(payload.trim()).ok())
                .map(|payload| without_denied_tools(payload, &denied))
            {
                Some(payload) => lines.push(format!("data: {payload}{ending}")),
                None => lines.push(format!("{line}{ending}")),
            }
        }
        lines.concat()
    } else {
        match serde_json::from_str::<Value>(text) {
            Ok(payload) => without_denied_tools(payload, &denied).to_string(),
            Err(_) => return response,
        }
    };
    ProxyResponse {
        body: rewritten.into_bytes(),
        ..response
    }
}

fn without_denied_tools(mut payload: Value, denied: &BTreeSet<&str>) -> Value {
    let entries: Vec<&mut Value> = match &mut payload {
        Value::Array(items) => items.iter_mut().collect(),
        value => vec![value],
    };
    for entry in entries {
        if let Some(tools) = entry
            .get_mut("result")
            .and_then(|result| result.get_mut("tools"))
            .and_then(Value::as_array_mut)
        {
            tools.retain(|tool| {
                tool.get("name")
                    .and_then(Value::as_str)
                    .is_none_or(|name| !denied.contains(name))
            });
        }
    }
    payload
}

fn send_proxy_request(
    client: &Client,
    upstream: &str,
    authorization: Option<&str>,
    request: &ProxyRequest,
) -> Result<ProxyResponse, CoreError> {
    let mut headers = HeaderMap::new();
    if let Some(value) = request
        .content_type
        .as_deref()
        .and_then(|value| HeaderValue::from_str(value).ok())
    {
        headers.insert(CONTENT_TYPE, value);
    }
    headers.insert(
        ACCEPT,
        request
            .accept
            .as_deref()
            .and_then(|value| HeaderValue::from_str(value).ok())
            .unwrap_or_else(|| HeaderValue::from_static("application/json, text/event-stream")),
    );
    if let Some(value) = request
        .session_id
        .as_deref()
        .and_then(|value| HeaderValue::from_str(value).ok())
    {
        headers.insert("mcp-session-id", value);
    }
    if let Some(value) = request
        .protocol_version
        .as_deref()
        .and_then(|value| HeaderValue::from_str(value).ok())
    {
        headers.insert("mcp-protocol-version", value);
    }
    if let Some(authorization) = authorization.and_then(|value| HeaderValue::from_str(value).ok()) {
        headers.insert(AUTHORIZATION, authorization);
    }
    let response = client
        .request(request.method.clone(), upstream)
        .headers(headers)
        .body(request.body.clone())
        .send()
        .map_err(|error| {
            CoreError::Runtime(format!("플러그인 서버에 연결하지 못했습니다: {error}"))
        })?;
    if response.status().is_redirection() {
        return Err(CoreError::Conflict(
            "플러그인 서버가 리디렉션을 돌려주었습니다. 최종 주소를 등록해 주세요".to_owned(),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROXY_RESPONSE_BYTES as u64)
    {
        return Err(CoreError::TooLarge(MAX_PROXY_RESPONSE_BYTES as u64));
    }
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body = response.bytes().map_err(|error| {
        CoreError::Runtime(format!("플러그인 서버 응답을 읽지 못했습니다: {error}"))
    })?;
    if body.len() > MAX_PROXY_RESPONSE_BYTES {
        return Err(CoreError::TooLarge(MAX_PROXY_RESPONSE_BYTES as u64));
    }
    Ok(ProxyResponse {
        status,
        content_type,
        session_id,
        body: body.to_vec(),
    })
}

// ---------------------------------------------------------------------------
// 내장 Notion 서버(내부 통합 토큰)
// ---------------------------------------------------------------------------

/// 노션 공식 서버를 loopback HTTP 모드로 띄우거나, 이미 떠 있으면 그 포트를 돌려준다.
/// 내부 통합 토큰은 자식 환경변수 `NOTION_TOKEN`으로만 건네고 argv에는 넣지 않는다.
/// 프록시 쪽 bearer는 기동마다 새로 만드는 무작위 값이라 다른 로컬 프로세스가 포트를
/// 알아도 노션 토큰을 쓸 수 없다.
fn ensure_notion_server(id: &str, notion_token: &str) -> Result<(u16, String), CoreError> {
    let mut servers = managed_servers()
        .lock()
        .map_err(|_| CoreError::Runtime("내장 서버 목록 잠금을 얻지 못했습니다".to_owned()))?;
    if let Some(server) = servers.get_mut(id) {
        match server.child.try_wait() {
            Ok(None) => return Ok((server.port, server.auth_token.clone())),
            _ => {
                servers.remove(id);
            }
        }
    }
    let npx = crate::providers::resolve_named_executable(&["npx"]).map_err(|_| {
        CoreError::Conflict(
            "Notion 내부 통합 토큰 방식은 Node.js(npx)가 필요합니다. Node.js를 설치한 뒤 다시 시도해 주세요"
                .to_owned(),
        )
    })?;
    let port = {
        let probe = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        probe.local_addr()?.port()
    };
    let auth_token = random_urlsafe(32);
    let mut command = Command::new(npx);
    command
        .args(notion_server_args(port, &auth_token))
        .env("NOTION_TOKEN", notion_token)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .current_dir(std::env::temp_dir());
    credential_profiles::strip_inherited_credential_env(&mut command);
    if let Some(path) = crate::providers::appended_search_path() {
        command.env("PATH", path);
    }
    crate::chat::configure_no_window_command(&mut command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!("Notion MCP 서버를 시작하지 못했습니다: {error}"))
    })?;
    let deadline = Instant::now() + MANAGED_SERVER_READY_TIMEOUT;
    loop {
        if TcpStream::connect_timeout(
            &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
            Duration::from_millis(300),
        )
        .is_ok()
        {
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(CoreError::Runtime(format!(
                "Notion MCP 서버가 바로 종료되었습니다 (종료 코드 {}). 토큰과 Node.js 설치를 확인해 주세요",
                status.code().unwrap_or(-1)
            )));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CoreError::Runtime(
                "Notion MCP 서버가 시간 안에 포트를 열지 않았습니다. 네트워크(npm 패키지 다운로드)를 확인해 주세요"
                    .to_owned(),
            ));
        }
        thread::sleep(Duration::from_millis(250));
    }
    servers.insert(
        id.to_owned(),
        ManagedServer {
            child,
            port,
            auth_token: auth_token.clone(),
        },
    );
    Ok((port, auth_token))
}

fn notion_server_args(port: u16, auth_token: &str) -> Vec<String> {
    vec![
        "-y".to_owned(),
        NOTION_LOCAL_SERVER_PACKAGE.to_owned(),
        "--transport".to_owned(),
        "http".to_owned(),
        "--host".to_owned(),
        "127.0.0.1".to_owned(),
        "--port".to_owned(),
        port.to_string(),
        "--auth-token".to_owned(),
        auth_token.to_owned(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote_tool(name: &str, read_only: bool) -> crate::mcp_registry::McpRemoteTool {
        crate::mcp_registry::McpRemoteTool {
            name: name.to_owned(),
            title: None,
            description: None,
            input_schema: json!({"type": "object"}),
            read_only,
            destructive: !read_only,
        }
    }

    #[test]
    fn plugin_ids_match_provider_server_name_rules() {
        assert!(validate_plugin_id("notion").is_ok());
        assert!(validate_plugin_id("my-tools_2").is_ok());
        assert!(validate_plugin_id("Notion").is_err());
        assert!(validate_plugin_id("-lead").is_err());
        assert!(validate_plugin_id("has space").is_err());
        assert!(validate_plugin_id(&"a".repeat(33)).is_err());
    }

    #[test]
    fn endpoint_validation_rejects_credentials_and_plain_http_remote() {
        assert_eq!(
            validate_endpoint(" https://mcp.notion.com/mcp ").expect("hosted url"),
            "https://mcp.notion.com/mcp"
        );
        assert!(validate_endpoint("http://127.0.0.1:3000/mcp").is_ok());
        assert!(validate_endpoint("http://mcp.example.com/mcp").is_err());
        assert!(validate_endpoint("https://user:pw@mcp.example.com/mcp").is_err());
        assert!(validate_endpoint("https://mcp.example.com/mcp?token=x").is_err());
    }

    #[test]
    fn notion_tokens_must_carry_the_integration_prefix() {
        assert!(validate_token("ntn_abc", PluginAuthKind::NotionToken).is_ok());
        assert!(validate_token("secret_abc", PluginAuthKind::NotionToken).is_ok());
        assert!(validate_token("abc", PluginAuthKind::NotionToken).is_err());
        assert!(validate_token("abc", PluginAuthKind::Bearer).is_ok());
        assert!(validate_token("has space", PluginAuthKind::Bearer).is_err());
    }

    #[test]
    fn aia_plugin_calls_use_the_live_read_write_classification() {
        let read = remote_tool("search", true);
        let write = remote_tool("create-page", false);
        assert!(ensure_aia_tool_access(&read, true).is_ok());
        assert!(ensure_aia_tool_access(&write, false).is_ok());
        assert!(ensure_aia_tool_access(&write, true)
            .expect_err("write through read path")
            .to_string()
            .contains("execute_external_plugin_tool"));
        assert!(ensure_aia_tool_access(&read, false)
            .expect_err("read through write path")
            .to_string()
            .contains("read_external_plugin_tool"));
    }

    #[test]
    fn aia_plugin_catalog_refuses_a_disabled_plugin_before_network_access() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        registry
            .register(RegisterExternalPluginRequest {
                id: "notion".to_owned(),
                display_name: "Notion".to_owned(),
                url: Some("http://127.0.0.1:1/mcp".to_owned()),
                auth: PluginAuthKind::None,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect("register");
        registry.set_enabled("notion", false).expect("disable");
        let error = registry
            .aia_tool_catalog("notion", "http://127.0.0.1:1/plugins/key")
            .expect_err("disabled plugin must stop before connecting");
        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(error.to_string().contains("꺼져"));
    }

    #[test]
    fn pkce_challenge_is_base64url_sha256_of_the_verifier() {
        // RFC 7636 부록 B의 예시 값.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let random = random_urlsafe(32);
        assert_eq!(random.len(), 43);
        assert!(random
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn www_authenticate_resource_metadata_is_extracted() {
        assert_eq!(
            parse_resource_metadata_url(
                "Bearer realm=\"mcp\", resource_metadata=\"https://mcp.notion.com/.well-known/oauth-protected-resource\""
            )
            .as_deref(),
            Some("https://mcp.notion.com/.well-known/oauth-protected-resource")
        );
        assert_eq!(
            parse_resource_metadata_url(
                "Bearer resource_metadata=https://a.example/.well-known/x, scope=\"x\""
            )
            .as_deref(),
            Some("https://a.example/.well-known/x")
        );
        assert_eq!(parse_resource_metadata_url("Bearer realm=\"mcp\""), None);
    }

    #[test]
    fn canonical_resource_drops_trailing_slash_and_query() {
        let url = Url::parse("https://MCP.Example.com/").expect("url");
        assert_eq!(canonical_resource(&url), "https://mcp.example.com");
        let url = Url::parse("https://mcp.notion.com/mcp?x=1#f").expect("url");
        assert_eq!(canonical_resource(&url), "https://mcp.notion.com/mcp");
    }

    #[test]
    fn url_origin_preserves_ipv6_brackets_and_port() {
        let ipv6 = Url::parse("http://[::1]:4312/mcp").expect("IPv6 URL");
        assert_eq!(url_origin(&ipv6), "http://[::1]:4312");

        let remote = Url::parse("https://mcp.example.com/mcp").expect("remote URL");
        assert_eq!(url_origin(&remote), "https://mcp.example.com");
    }

    #[test]
    fn callback_target_parsing_reads_code_state_and_errors() {
        assert_eq!(
            parse_callback_target("/callback?code=abc&state=xyz"),
            Some(CallbackQuery {
                code: Some("abc".to_owned()),
                state: Some("xyz".to_owned()),
                error: None
            })
        );
        assert_eq!(
            parse_callback_target(
                "/callback?error=access_denied&error_description=User%20said%20no"
            )
            .and_then(|query| query.error),
            Some("access_denied: User said no".to_owned())
        );
        assert_eq!(parse_callback_target("/favicon.ico"), None);
    }

    #[test]
    fn notion_server_is_started_on_loopback_with_a_random_bearer() {
        let args = notion_server_args(4321, "tok");
        assert_eq!(args[0], "-y");
        assert_eq!(args[1], NOTION_LOCAL_SERVER_PACKAGE);
        assert!(args.windows(2).any(|pair| pair == ["--host", "127.0.0.1"]));
        assert!(args.windows(2).any(|pair| pair == ["--port", "4321"]));
        assert!(args.windows(2).any(|pair| pair == ["--auth-token", "tok"]));
        // 노션 토큰 자체는 argv에 없다 — 환경변수로만 건넨다.
        assert!(!args.iter().any(|arg| arg.starts_with("ntn_")));
    }

    #[test]
    fn store_round_trips_without_secrets() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        let stored = StoredPlugin {
            id: "notion".to_owned(),
            display_name: "Notion".to_owned(),
            url: Some(NOTION_HOSTED_MCP_URL.to_owned()),
            auth: PluginAuthKind::OAuth,
            enabled: true,
            scope: None,
            tool_policies: BTreeMap::new(),
            created_at: 1,
            updated_at: 1,
            secret_stored_at: Some(2),
            oauth: Some(OAuthClientRecord {
                authorization_endpoint: "https://mcp.notion.com/authorize".to_owned(),
                token_endpoint: "https://mcp.notion.com/token".to_owned(),
                registration_endpoint: Some("https://mcp.notion.com/register".to_owned()),
                client_id: "client".to_owned(),
                redirect_uri: "http://127.0.0.1:55564/callback".to_owned(),
                resource: NOTION_HOSTED_MCP_URL.to_owned(),
                scope: None,
                authorized_at: Some(3),
                access_expires_at: Some(4),
            }),
            server_name: None,
            tools: Vec::new(),
            last_verified_at: None,
            last_error: None,
        };
        registry
            .with_store_lock(|| {
                registry.save_store_unlocked(&PluginStore {
                    schema_version: STORE_VERSION,
                    plugins: vec![stored.clone()],
                })
            })
            .expect("save");
        let raw = std::fs::read_to_string(STORE.path(directory.path())).expect("store file");
        assert!(!raw.contains("accessToken") && !raw.contains("refreshToken"));
        let snapshot = registry.snapshot(true).expect("snapshot");
        assert_eq!(snapshot.plugins.len(), 1);
        let view = &snapshot.plugins[0];
        assert!(view.credential_ready);
        assert!(view.attachable);
        assert_eq!(view.authorized_at, Some(3));
        assert_eq!(
            registry.attachable_plugin_ids().expect("ids"),
            vec!["notion".to_owned()]
        );

        let disabled = registry.set_enabled("notion", false).expect("disable");
        assert!(!disabled.attachable);
        assert!(registry.attachable_plugin_ids().expect("ids").is_empty());
    }

    #[test]
    fn oauth_plugin_without_authorization_is_not_attachable() {
        let plugin = StoredPlugin {
            id: "notion".to_owned(),
            display_name: "Notion".to_owned(),
            url: Some(NOTION_HOSTED_MCP_URL.to_owned()),
            auth: PluginAuthKind::OAuth,
            enabled: true,
            scope: None,
            tool_policies: BTreeMap::new(),
            created_at: 0,
            updated_at: 0,
            secret_stored_at: None,
            oauth: None,
            server_name: None,
            tools: Vec::new(),
            last_verified_at: None,
            last_error: None,
        };
        let view = plugin_view(&plugin, true);
        assert!(!view.credential_ready);
        assert!(view.oauth_pending);
        assert!(!view.attachable);
        let open = StoredPlugin {
            auth: PluginAuthKind::None,
            ..plugin
        };
        assert!(plugin_view(&open, false).attachable);
    }

    #[test]
    fn register_rejects_url_for_notion_token_and_requires_a_token() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        let error = registry
            .register(RegisterExternalPluginRequest {
                id: "notion".to_owned(),
                display_name: "Notion".to_owned(),
                url: Some("https://example.com".to_owned()),
                auth: PluginAuthKind::NotionToken,
                token: Some("ntn_x".to_owned()),
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect_err("url must be refused");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        let error = registry
            .register(RegisterExternalPluginRequest {
                id: "notion".to_owned(),
                display_name: "Notion".to_owned(),
                url: None,
                auth: PluginAuthKind::NotionToken,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect_err("token required");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        let error = registry
            .register(RegisterExternalPluginRequest {
                id: "open".to_owned(),
                display_name: "Open".to_owned(),
                url: Some("https://mcp.example.com/mcp".to_owned()),
                auth: PluginAuthKind::None,
                token: Some("x".to_owned()),
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect_err("token must be refused");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    #[test]
    fn update_renames_without_resetting_connection_state() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        let stored = StoredPlugin {
            id: "notion".to_owned(),
            display_name: "Notion".to_owned(),
            url: Some(NOTION_HOSTED_MCP_URL.to_owned()),
            auth: PluginAuthKind::OAuth,
            enabled: true,
            scope: None,
            tool_policies: BTreeMap::new(),
            created_at: 1,
            updated_at: 1,
            secret_stored_at: Some(2),
            oauth: Some(OAuthClientRecord {
                authorization_endpoint: "https://mcp.notion.com/authorize".to_owned(),
                token_endpoint: "https://mcp.notion.com/token".to_owned(),
                registration_endpoint: None,
                client_id: "client".to_owned(),
                redirect_uri: "http://127.0.0.1:55564/callback".to_owned(),
                resource: NOTION_HOSTED_MCP_URL.to_owned(),
                scope: None,
                authorized_at: Some(3),
                access_expires_at: Some(4),
            }),
            server_name: Some("Notion".to_owned()),
            tools: vec!["search".to_owned()],
            last_verified_at: Some(5),
            last_error: None,
        };
        registry
            .with_store_lock(|| {
                registry.save_store_unlocked(&PluginStore {
                    schema_version: STORE_VERSION,
                    plugins: vec![stored],
                })
            })
            .expect("save");
        // 표시 이름만 바뀌면 자격증명·연결 확인 결과가 그대로라 보안 저장소도 지나지 않는다.
        let view = registry
            .update(UpdateExternalPluginRequest {
                id: "notion".to_owned(),
                display_name: "Notion 팀".to_owned(),
                url: Some(NOTION_HOSTED_MCP_URL.to_owned()),
                auth: PluginAuthKind::OAuth,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect("rename");
        assert_eq!(view.display_name, "Notion 팀");
        assert!(view.credential_ready);
        assert!(view.attachable);
        assert_eq!(view.authorized_at, Some(3));
        assert_eq!(view.last_verified_at, Some(5));
        assert_eq!(view.tools, vec!["search".to_owned()]);
        assert_eq!(view.created_at, 1);
        assert!(view.updated_at > 1);
    }

    #[test]
    fn update_resets_verification_when_the_connection_changes() {
        // 인증 없는 서버끼리의 편집이라 이 테스트는 OS 보안 저장소를 건드리지 않는다.
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        registry
            .register(RegisterExternalPluginRequest {
                id: "local".to_owned(),
                display_name: "Local dev".to_owned(),
                url: Some("http://127.0.0.1:3000/mcp".to_owned()),
                auth: PluginAuthKind::None,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect("register");
        registry
            .update_plugin("local", |plugin| {
                plugin.server_name = Some("Dev".to_owned());
                plugin.tools = vec!["echo".to_owned()];
                plugin.last_verified_at = Some(9);
                plugin.last_error = Some("stale".to_owned());
                Ok(())
            })
            .expect("seed verification state");
        let view = registry
            .update(UpdateExternalPluginRequest {
                id: "local".to_owned(),
                display_name: "Local dev".to_owned(),
                url: Some("http://127.0.0.1:4000/mcp".to_owned()),
                auth: PluginAuthKind::None,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect("move endpoint");
        // 다른 서버의 확인 결과를 새 주소에 이어 붙이지 않는다.
        assert_eq!(view.url.as_deref(), Some("http://127.0.0.1:4000/mcp"));
        assert_eq!(view.server_name, None);
        assert!(view.tools.is_empty());
        assert_eq!(view.last_verified_at, None);
        assert_eq!(view.last_error, None);
        assert!(view.attachable);
    }

    #[test]
    fn update_requires_a_new_token_when_the_connection_changes() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        let stored = StoredPlugin {
            id: "api".to_owned(),
            display_name: "API".to_owned(),
            url: Some("https://mcp.example.com/mcp".to_owned()),
            auth: PluginAuthKind::Bearer,
            enabled: true,
            scope: None,
            tool_policies: BTreeMap::new(),
            created_at: 1,
            updated_at: 1,
            secret_stored_at: Some(2),
            oauth: None,
            server_name: None,
            tools: Vec::new(),
            last_verified_at: None,
            last_error: None,
        };
        registry
            .with_store_lock(|| {
                registry.save_store_unlocked(&PluginStore {
                    schema_version: STORE_VERSION,
                    plugins: vec![stored],
                })
            })
            .expect("save");
        // 옛 토큰이 새 서버로 전달되면 안 되므로, 주소를 바꾸는 편집은 새 토큰 없이는 거절된다.
        // 이 검증은 보안 저장소 접근 전에 끝난다.
        let error = registry
            .update(UpdateExternalPluginRequest {
                id: "api".to_owned(),
                display_name: "API".to_owned(),
                url: Some("https://mcp.other.example/mcp".to_owned()),
                auth: PluginAuthKind::Bearer,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect_err("token required");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    #[test]
    fn update_rejects_unknown_plugins_and_mismatched_auth_fields() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        let missing = registry.update(UpdateExternalPluginRequest {
            id: "ghost".to_owned(),
            display_name: "Ghost".to_owned(),
            url: Some("http://127.0.0.1:3000/mcp".to_owned()),
            auth: PluginAuthKind::None,
            token: None,
            client_id: None,
            client_secret: None,
            scope: None,
        });
        assert!(matches!(missing, Err(CoreError::NotFound(_))));
        // 등록과 같은 규칙: 인증 방식에 맞지 않는 필드는 저장소를 건드리기 전에 거절된다.
        let token_refused = registry.update(UpdateExternalPluginRequest {
            id: "ghost".to_owned(),
            display_name: "Ghost".to_owned(),
            url: Some("http://127.0.0.1:3000/mcp".to_owned()),
            auth: PluginAuthKind::OAuth,
            token: Some("x".to_owned()),
            client_id: None,
            client_secret: None,
            scope: None,
        });
        assert!(matches!(token_refused, Err(CoreError::InvalidInput(_))));
        let url_refused = registry.update(UpdateExternalPluginRequest {
            id: "ghost".to_owned(),
            display_name: "Ghost".to_owned(),
            url: Some("https://example.com".to_owned()),
            auth: PluginAuthKind::NotionToken,
            token: Some("ntn_x".to_owned()),
            client_id: None,
            client_secret: None,
            scope: None,
        });
        assert!(matches!(url_refused, Err(CoreError::InvalidInput(_))));
        let client_id_refused = registry.update(UpdateExternalPluginRequest {
            id: "ghost".to_owned(),
            display_name: "Ghost".to_owned(),
            url: Some("http://127.0.0.1:3000/mcp".to_owned()),
            auth: PluginAuthKind::None,
            token: None,
            client_id: Some("manual".to_owned()),
            client_secret: None,
            scope: None,
        });
        assert!(matches!(client_id_refused, Err(CoreError::InvalidInput(_))));
    }

    #[test]
    fn registering_an_open_plugin_needs_no_secure_store() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        let view = registry
            .register(RegisterExternalPluginRequest {
                id: "local".to_owned(),
                display_name: " Local dev ".to_owned(),
                url: Some("http://127.0.0.1:3000/mcp".to_owned()),
                auth: PluginAuthKind::None,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect("register");
        assert_eq!(view.display_name, "Local dev");
        assert!(view.attachable);
        let duplicate = registry.register(RegisterExternalPluginRequest {
            id: "local".to_owned(),
            display_name: "Again".to_owned(),
            url: Some("http://127.0.0.1:3000/mcp".to_owned()),
            auth: PluginAuthKind::None,
            token: None,
            client_id: None,
            client_secret: None,
            scope: None,
        });
        assert!(matches!(duplicate, Err(CoreError::Conflict(_))));
    }

    #[test]
    fn client_secret_requires_a_manual_client_id() {
        let client_id = Some("client".to_owned());
        assert_eq!(
            validate_manual_client_secret(Some(" s3cret "), &client_id).expect("secret"),
            Some("s3cret".to_owned())
        );
        assert_eq!(
            validate_manual_client_secret(Some("  "), &client_id).expect("blank is absent"),
            None
        );
        assert!(validate_manual_client_secret(Some("s3cret"), &None).is_err());
        assert!(validate_manual_client_secret(Some("has space"), &client_id).is_err());
        assert!(validate_manual_client_secret(Some(&"a".repeat(513)), &client_id).is_err());

        // 등록 요청에서도 clientId 없는 clientSecret은 보안 저장소 접근 전에 거절된다.
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        let error = registry
            .register(RegisterExternalPluginRequest {
                id: "google-drive".to_owned(),
                display_name: "Google Drive".to_owned(),
                url: Some("https://drivemcp.googleapis.com/mcp/v1".to_owned()),
                auth: PluginAuthKind::OAuth,
                token: None,
                client_id: None,
                client_secret: Some("s3cret".to_owned()),
                scope: None,
            })
            .expect_err("secret without client id");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    #[test]
    fn manual_client_registration_is_reused_by_begin_oauth() {
        let metadata = OAuthServerMetadata {
            authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth".to_owned(),
            token_endpoint: "https://oauth2.googleapis.com/token".to_owned(),
            registration_endpoint: None,
            device_authorization_endpoint: None,
            resource: "https://drivemcp.googleapis.com/mcp/v1".to_owned(),
            scope: None,
        };
        // 수동 입력 레코드는 endpoint·redirect가 비어 있어 어느 포트로든 재사용된다.
        let manual = new_manual_oauth_record("client".to_owned());
        assert!(can_reuse_client_registration(
            &manual,
            "http://127.0.0.1:49152/callback",
            &metadata
        ));
        // 등록을 마친 레코드는 인증 서버와 콜백 포트가 그대로일 때만 재사용된다.
        let mut registered = manual.clone();
        registered.authorization_endpoint = metadata.authorization_endpoint.clone();
        registered.token_endpoint = metadata.token_endpoint.clone();
        registered.redirect_uri = "http://127.0.0.1:49152/callback".to_owned();
        assert!(can_reuse_client_registration(
            &registered,
            "http://127.0.0.1:49152/callback",
            &metadata
        ));
        assert!(!can_reuse_client_registration(
            &registered,
            "http://127.0.0.1:49153/callback",
            &metadata
        ));
        let mut other_server = registered.clone();
        other_server.token_endpoint = "https://mcp.notion.com/token".to_owned();
        assert!(!can_reuse_client_registration(
            &other_server,
            "http://127.0.0.1:49152/callback",
            &metadata
        ));
    }

    #[test]
    fn hosted_presets_carry_valid_urls_and_scope_rules() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        let snapshot = registry.snapshot(false).expect("snapshot");
        assert_eq!(snapshot.hosted_presets.len(), HOSTED_MCPS.len());
        for preset in snapshot.hosted_presets {
            validate_plugin_id(preset.id).expect("preset id");
            validate_endpoint(preset.url).expect("preset url");
            assert_eq!(
                hosted_preset_for(&format!("{}/", preset.url.trim_end_matches('/')))
                    .map(|found| found.id),
                Some(preset.id),
            );
            // 고를 수 있게 내보내는 scope는 기본값과 같은 형식이어야 한다.
            for scope in preset.available_scopes {
                assert!(!scope.contains(' '));
            }
            if preset.auth.is_oauth() {
                assert!(!preset.default_scope.is_empty());
            }
        }
        assert_eq!(hosted_preset_for(NOTION_HOSTED_MCP_URL).map(|p| p.id), None);
    }

    #[test]
    fn scope_choice_prefers_user_value_then_override_then_discovery() {
        let google = hosted_preset_for("https://drivemcp.googleapis.com/mcp/v1").expect("google");
        let jira = hosted_preset_for("https://mcp.atlassian.com/v2/mcp").expect("jira");
        // 사용자가 고른 값이 언제나 앞선다.
        assert_eq!(
            resolve_scope(Some("read:me"), Some("a b"), Some(jira)),
            Some("read:me".to_owned())
        );
        // 구글은 폴백이라 discovery가 준 scope를 그대로 쓴다.
        assert_eq!(
            resolve_scope(None, Some("https://example/scope"), Some(google)),
            Some("https://example/scope".to_owned())
        );
        assert_eq!(
            resolve_scope(None, None, Some(google)),
            Some(google.default_scope.to_owned())
        );
        // 아틀라시안·GitHub은 override라 보호 자원 메타데이터의 전체 목록을 쓰지 않는다.
        assert_eq!(
            resolve_scope(None, Some("delete:jira:agent-interface"), Some(jira)),
            Some(jira.default_scope.to_owned())
        );
        assert_eq!(resolve_scope(None, None, None), None);
    }

    #[test]
    fn scope_input_is_normalized_and_limited_to_oauth() {
        assert_eq!(
            validate_scope(
                Some("  read:me   offline_access read:me "),
                PluginAuthKind::OAuth
            )
            .expect("scope"),
            Some("read:me offline_access".to_owned())
        );
        assert_eq!(
            validate_scope(Some("   "), PluginAuthKind::OAuth).expect("blank"),
            None
        );
        assert!(validate_scope(Some("repo"), PluginAuthKind::Bearer).is_err());
        assert!(validate_scope(Some(&"a".repeat(1025)), PluginAuthKind::OAuthDevice).is_err());
    }

    #[test]
    fn device_authorization_needs_a_client_id() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        let error = registry
            .register(RegisterExternalPluginRequest {
                id: "github".to_owned(),
                display_name: "GitHub".to_owned(),
                url: Some("https://api.githubcopilot.com/mcp/".to_owned()),
                auth: PluginAuthKind::OAuthDevice,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect_err("device flow without a client id");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        let view = registry
            .register(RegisterExternalPluginRequest {
                id: "github".to_owned(),
                display_name: "GitHub".to_owned(),
                url: Some("https://api.githubcopilot.com/mcp/".to_owned()),
                auth: PluginAuthKind::OAuthDevice,
                token: None,
                client_id: Some("Iv1.0123456789abcdef".to_owned()),
                client_secret: None,
                scope: Some("repo read:org".to_owned()),
            })
            .expect("register");
        assert_eq!(view.scope.as_deref(), Some("repo read:org"));
        // 승인 전에는 자격증명이 준비되지 않아 채팅에 붙지 않는다.
        assert!(!view.credential_ready && !view.attachable);
    }

    #[test]
    fn denied_tools_are_hidden_from_the_list_and_refused_on_call() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        registry
            .register(RegisterExternalPluginRequest {
                id: "notion".to_owned(),
                display_name: "Notion".to_owned(),
                url: Some("http://127.0.0.1:1/mcp".to_owned()),
                auth: PluginAuthKind::None,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect("register");
        let view = registry
            .set_tool_policy("notion", "notion-create-pages", PluginToolPolicy::Deny)
            .expect("deny");
        assert_eq!(
            view.tool_policies.get("notion-create-pages"),
            Some(&PluginToolPolicy::Deny)
        );
        // 확인(기본값)으로 되돌리면 저장 파일에서 사라진다.
        let view = registry
            .set_tool_policy("notion", "notion-create-pages", PluginToolPolicy::Ask)
            .expect("ask");
        assert!(view.tool_policies.is_empty());
        registry
            .set_tool_policy("notion", "notion-create-pages", PluginToolPolicy::Deny)
            .expect("deny again");

        let policies = registry
            .attachable_plugins()
            .expect("attachable")
            .into_iter()
            .find(|(id, _)| id == "notion")
            .map(|(_, policies)| policies)
            .expect("plugin");
        assert_eq!(
            policies.get("notion-create-pages"),
            Some(&PluginToolPolicy::Deny)
        );

        let list_body = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})
            .to_string()
            .into_bytes();
        assert_eq!(ProxyIntent::of(&list_body), ProxyIntent::ListTools);
        let upstream = ProxyResponse {
            status: 200,
            content_type: Some("text/event-stream".to_owned()),
            session_id: None,
            body: format!(
                "event: message\ndata: {}\n\n",
                json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "result": {"tools": [
                        {"name": "notion-search"},
                        {"name": "notion-create-pages"}
                    ]}
                })
            )
            .into_bytes(),
        };
        let filtered = hide_denied_tools(upstream, &ProxyIntent::ListTools, &policies);
        let text = String::from_utf8(filtered.body).expect("utf8");
        assert!(text.contains("notion-search"));
        assert!(!text.contains("notion-create-pages"));
        assert!(text.starts_with("event: message\n"));

        let call_body = json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "notion-create-pages", "arguments": {}}
        })
        .to_string()
        .into_bytes();
        assert_eq!(
            ProxyIntent::of(&call_body),
            ProxyIntent::CallTool("notion-create-pages".to_owned())
        );
        let refusal = denied_tool_response(&call_body, "notion-create-pages");
        let payload: Value = serde_json::from_slice(&refusal.body).expect("json");
        assert_eq!(payload["id"], json!(3));
        assert_eq!(payload["result"]["isError"], json!(true));
    }

    #[test]
    fn all_tool_policies_change_in_one_store_update() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        registry
            .register(RegisterExternalPluginRequest {
                id: "notion".to_owned(),
                display_name: "Notion".to_owned(),
                url: Some("http://127.0.0.1:1/mcp".to_owned()),
                auth: PluginAuthKind::None,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect("register");
        registry
            .update_plugin("notion", |plugin| {
                plugin.tools = vec!["notion-search".to_owned(), "notion-fetch".to_owned()];
                plugin
                    .tool_policies
                    .insert("notion-legacy".to_owned(), PluginToolPolicy::Deny);
                Ok(())
            })
            .expect("seed tools");

        let allowed = registry
            .set_all_tool_policies("notion", PluginToolPolicy::Allow)
            .expect("allow all");
        assert_eq!(allowed.tool_policies.len(), 3);
        assert!(allowed
            .tool_policies
            .values()
            .all(|policy| *policy == PluginToolPolicy::Allow));

        let asked = registry
            .set_all_tool_policies("notion", PluginToolPolicy::Ask)
            .expect("ask all");
        assert!(asked.tool_policies.is_empty());
    }

    #[test]
    fn google_authorization_endpoint_gets_offline_access_params() {
        assert!(is_google_authorization_endpoint(
            "https://accounts.google.com/o/oauth2/v2/auth"
        ));
        assert!(!is_google_authorization_endpoint(
            "https://mcp.notion.com/authorize"
        ));
        assert!(!is_google_authorization_endpoint("not a url"));
    }

    #[test]
    fn plugin_auth_kind_roundtrip_and_helpers() {
        assert_eq!(
            PluginAuthKind::ALL,
            [
                PluginAuthKind::None,
                PluginAuthKind::Bearer,
                PluginAuthKind::OAuth,
                PluginAuthKind::OAuthDevice,
                PluginAuthKind::NotionToken,
            ]
        );

        for auth in PluginAuthKind::ALL {
            let s = auth.as_str();
            assert_eq!(auth.to_string(), s);
            assert_eq!(s.parse::<PluginAuthKind>().expect("parse"), auth);

            let json = serde_json::to_string(&auth).expect("serialize");
            assert_eq!(json, format!("\"{s}\""));
            let back: PluginAuthKind = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, auth);
        }

        // snake_case 파싱 호환성 검증
        assert_eq!(
            "oauth_device"
                .parse::<PluginAuthKind>()
                .expect("snake parse"),
            PluginAuthKind::OAuthDevice
        );
        assert_eq!(
            "notion_token"
                .parse::<PluginAuthKind>()
                .expect("snake parse"),
            PluginAuthKind::NotionToken
        );

        // 상태 판별 헬퍼 검증
        assert!(PluginAuthKind::None.is_none());
        assert!(!PluginAuthKind::None.needs_secret());
        assert!(!PluginAuthKind::None.is_oauth());

        assert!(PluginAuthKind::Bearer.is_bearer());
        assert!(PluginAuthKind::Bearer.needs_secret());
        assert!(!PluginAuthKind::Bearer.is_oauth());

        assert!(PluginAuthKind::OAuth.is_oauth_standard());
        assert!(PluginAuthKind::OAuth.is_oauth());
        assert!(PluginAuthKind::OAuth.needs_secret());

        assert!(PluginAuthKind::OAuthDevice.is_oauth_device());
        assert!(PluginAuthKind::OAuthDevice.is_oauth());
        assert!(PluginAuthKind::OAuthDevice.needs_secret());

        assert!(PluginAuthKind::NotionToken.is_notion_token());
        assert!(PluginAuthKind::NotionToken.needs_secret());
        assert!(!PluginAuthKind::NotionToken.is_oauth());

        // 알 수 없는 값에 대한 파싱 거절 검증
        let error = "unknown".parse::<PluginAuthKind>().expect_err("unknown");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    #[test]
    fn plugin_tool_policy_roundtrip_and_helpers() {
        assert_eq!(
            PluginToolPolicy::ALL,
            [
                PluginToolPolicy::Ask,
                PluginToolPolicy::Allow,
                PluginToolPolicy::Deny,
            ]
        );

        for policy in PluginToolPolicy::ALL {
            let s = policy.as_str();
            assert_eq!(policy.to_string(), s);
            assert_eq!(s.parse::<PluginToolPolicy>().expect("parse"), policy);

            let json = serde_json::to_string(&policy).expect("serialize");
            assert_eq!(json, format!("\"{s}\""));
            let back: PluginToolPolicy = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, policy);
        }

        // 상태 판별 헬퍼 검증
        assert!(PluginToolPolicy::Ask.is_ask());
        assert!(!PluginToolPolicy::Ask.is_allow());
        assert!(!PluginToolPolicy::Ask.is_deny());

        assert!(PluginToolPolicy::Allow.is_allow());
        assert!(!PluginToolPolicy::Allow.is_ask());
        assert!(!PluginToolPolicy::Allow.is_deny());

        assert!(PluginToolPolicy::Deny.is_deny());
        assert!(!PluginToolPolicy::Deny.is_ask());
        assert!(!PluginToolPolicy::Deny.is_allow());

        // 기본값 검증
        assert_eq!(PluginToolPolicy::default(), PluginToolPolicy::Ask);

        // 알 수 없는 값에 대한 파싱 거절 검증
        let error = "unknown".parse::<PluginToolPolicy>().expect_err("unknown");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }
}
