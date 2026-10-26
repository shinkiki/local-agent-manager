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
//! - 2026-09-30 결정으로 등록·편집·토큰 입력·삭제는 원격 write에서도 되고, 기기 코드
//!   흐름(`OAuthDevice`)은 loopback을 쓰지 않아 원격에서도 끝난다(H03).
//! - 2026-10-11 결정(사용자)으로 **콜백형 OAuth도 원격에서 끝난다.** 승인 뒤 브라우저가
//!   멈춘 `http://127.0.0.1:<포트>/callback?code=…&state=…` 주소를 사용자가 붙여 넣으면,
//!   진행 중인 흐름이 loopback 요청을 받은 것과 같은 자리에서 code를 교환한다
//!   ([`ExternalPluginRegistry::submit_oauth_callback`]). PKCE verifier·state는 처음부터
//!   백엔드에만 있으므로, 넘어오는 것은 일회용 code 하나뿐이다.
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
use crate::domain::ProviderId;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::loopback_host::{is_loopback_url_host, validate_mcp_endpoint};
use crate::mcp_registry::{parse_tools, McpHttpSession, McpRemoteTool};
use crate::text_limit;
use crate::CoreError;

const STORE_VERSION: u32 = 1;
/// 플러그인 하나가 가질 수 있는 다른 이름 수.
const MAX_PLUGIN_NAMES: usize = 8;
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
/// 흔해 AIA가 이 프록시를 거쳐 읽는 본문 상한(`mcp_registry::MAX_REMOTE_BODY_BYTES`,
/// 6.5 MiB)보다 넉넉히 잡는다. 길이 선언이 없는 본문도 읽는 동안 이 크기에서 끊는다.
pub const MAX_PROXY_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROXY_TIMEOUT: Duration = Duration::from_secs(120);
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
/// 브라우저 승인을 기다리는 최대 시간.
const OAUTH_CALLBACK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// 붙여 넣는 콜백 주소의 상한. 실제 주소는 수백 바이트이고, 그보다 큰 입력은 잘못 붙인 것이다.
const MAX_PASTED_CALLBACK_BYTES: usize = 8 * 1024;
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
    /// 등록 폼에 미리 채우는 다른 이름들. 사용자가 고쳐서 저장한다.
    pub names: &'static [&'static str],
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
        names: &["지라", "컨플루언스", "아틀라시안"],
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
        names: &["깃허브", "깃헙"],
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
        names: &["피그마"],
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
        names: &["지메일"],
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
        names: &["구글 드라이브", "드라이브"],
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
        names: &["구글 캘린더", "캘린더"],
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
        names: &["구글 독스", "구글 문서"],
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
    /// 인증 서버가 refresh token을 회복 불가능하게 거절한 시각(invalid_grant 등). 이 값이
    /// 있으면 저장된 토큰으로는 다시 붙을 수 없으므로 `credential_ready`가 내려가고 화면은
    /// "인증 필요"를 보인다. 다시 인증해 토큰을 저장하면 지운다.
    #[serde(default)]
    grant_lost_at: Option<i64>,
}

/// 인증 흐름마다 기록에 남는 두 값이 갈린다. 디바이스 인가에는 동적 등록도 콜백도 없어
/// 둘 다 비어 있고, 콜백 방식은 다음 인증도 같은 포트를 열어야 해서 redirect URI를 남긴다.
enum OAuthFlowBinding {
    Callback { redirect_uri: String },
    Device,
}

impl OAuthClientRecord {
    /// 인증을 다시 시작할 때 저장하는 기록. 엔드포인트와 client_id는 이번 탐색 결과로
    /// 새로 쓰고, 승인 시각 두 값은 아직 살아 있는 토큰을 가리키므로 이전 기록에서
    /// 이어받는다. 콜백 방식과 디바이스 인가가 이 아홉 칸을 각자 적고 있었다 —
    /// 한쪽만 손보면 다른 흐름의 기록이 조용히 달라진다.
    fn renewed(
        metadata: &OAuthServerMetadata,
        previous: Option<&OAuthClientRecord>,
        client_id: String,
        scope: Option<String>,
        binding: OAuthFlowBinding,
    ) -> Self {
        let (registration_endpoint, redirect_uri) = match binding {
            OAuthFlowBinding::Callback { redirect_uri } => {
                (metadata.registration_endpoint.clone(), redirect_uri)
            }
            OAuthFlowBinding::Device => (None, String::new()),
        };
        let (authorized_at, access_expires_at) = carried_grant(previous);
        Self {
            authorization_endpoint: metadata.authorization_endpoint.clone(),
            token_endpoint: metadata.token_endpoint.clone(),
            registration_endpoint,
            client_id,
            redirect_uri,
            resource: metadata.resource.clone(),
            scope,
            authorized_at,
            access_expires_at,
            grant_lost_at: previous.and_then(|record| record.grant_lost_at),
        }
    }
}

/// 이미 받아 둔 승인 시각과 접근 토큰 만료. 기록을 다시 쓰는 자리와 화면용 보기가
/// 같은 두 값을 각자 더듬고 있어 한 이름으로 모은다.
fn carried_grant(record: Option<&OAuthClientRecord>) -> (Option<i64>, Option<i64>) {
    (
        record.and_then(|record| record.authorized_at),
        record.and_then(|record| record.access_expires_at),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPlugin {
    id: String,
    display_name: String,
    /// 이 플러그인을 부르는 다른 말들(9.12). 계획 색인의 플러그인 칸과 라우터 힌트가
    /// 여기서 나온다 — "노션에 정리해줘"의 "노션"이 notion-* 도구에 닿는 길이다.
    /// `None`은 아직 한 번도 정해지지 않은 옛 레코드라 읽을 때 씨앗으로 한 번 채우고,
    /// `Some(vec![])`은 사용자가 비운 것이라 그대로 둔다.
    #[serde(default)]
    names: Option<Vec<String>>,
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
    /// 이 플러그인을 부르는 다른 말들. 계획 색인과 라우터 힌트에 실린다.
    pub names: Vec<String>,
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

/// 등록된 외부 MCP의 이름만 간추린 것. 기본도구 카탈로그가 어떤 서비스가 붙는지 보일 때 쓴다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExternalPluginSummary {
    /// 사용 중이고 자격증명이 준비돼 실제로 붙는 플러그인의 (id, 표시 이름).
    /// id는 프록시 주소의 마지막 조각이라, 자기 설정에 주소를 적어 두는 공급자가
    /// 그 플러그인을 실제로 등록해 뒀는지 대조하는 데 쓴다.
    pub attachable: Vec<(String, String)>,
    /// 사용 중이지만 인증·토큰이 아직 없어 붙지 않는 플러그인 수.
    pub pending: usize,
}

/// 등록과 편집이 함께 받는 플러그인 매니페스트. 두 입구는 받는 칸이 같고 칸마다
/// 읽는 규칙만 갈리므로(그 갈림은 `ManifestIntent`가 쥔다) 한 구조체로 받는다.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginManifestRequest {
    /// MCP 서버 이름과 loopback 프록시 경로에 쓰이는 불변 식별자. 편집은 조회 키로만
    /// 받고 바꾸지 않는다.
    pub id: String,
    pub display_name: String,
    /// 이 플러그인을 부르는 다른 말들. 등록에서 비우면 프리셋 씨앗으로 채우고, 편집에서
    /// 값이 오지 않으면(None) 기존 목록을 지킨다.
    #[serde(default)]
    pub names: Option<Vec<String>>,
    #[serde(default)]
    pub url: Option<String>,
    pub auth: PluginAuthKind,
    /// Bearer·NotionToken의 비밀값. 저장 뒤 응답에는 나가지 않는다. 편집에서는 인증
    /// 설정이 바뀔 때만 필수고, 비어 있으면 호환되는 기존 토큰을 유지한다.
    #[serde(default)]
    pub token: Option<String>,
    /// 동적 등록을 지원하지 않는 인증 서버용 수동 client_id. 편집에서 값이 전달되면
    /// 기존 OAuth 등록·자격증명을 초기화하고 이 client_id로 다시 인증한다.
    #[serde(default)]
    pub client_id: Option<String>,
    /// 수동 client_id에 딸린 client_secret(구글 등). 저장 뒤 응답에는 나가지 않고,
    /// client_id와 함께 올 때만 유효하다.
    #[serde(default)]
    pub client_secret: Option<String>,
    /// authorize 요청에 실을 scope. 비우면 프리셋 기본값이나 디스커버리 결과를 쓰고,
    /// 편집에서 값이 바뀌면 기존 인증을 버리고 새 동의를 받는다.
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginIdRequest {
    pub id: String,
}

/// 승인 뒤 브라우저 주소창에 남은 콜백 주소를 진행 중인 흐름에 넘기는 요청.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitExternalPluginOAuthCallbackRequest {
    pub id: String,
    pub callback_url: String,
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
    /// 승인 뒤 브라우저가 멈춘 콜백 주소를 붙여 넣어 끝낼 수 있는지. 콜백형이면 참이다 —
    /// 브라우저가 이 백엔드와 다른 기기(원격 화면·NAS)에 있으면 이것이 유일한 길이다.
    pub accepts_callback_paste: bool,
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
    /// 콜백형 흐름의 붙여넣기 자리. 기기 코드 흐름은 받을 콜백이 없어 None이다.
    paste: Option<Arc<CallbackPaste>>,
}

/// 붙여 넣은 콜백이 대기 스레드로 건너가는 자리. 대조에 쓰는 redirect 주소와 state는
/// 흐름을 시작할 때 고정되고, `code`는 한 번만 채워진다.
struct CallbackPaste {
    redirect_uri: String,
    state: String,
    code: Mutex<Option<String>>,
}

fn pending_oauth() -> &'static Mutex<HashMap<String, PendingOAuth>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingOAuth>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

struct ManagedServer {
    child: Child,
    group: Option<crate::cli_interface::ProcessGroup>,
    port: u16,
    /// 프록시만 아는 서버 쪽 bearer 토큰. 매 기동마다 새로 만든다.
    auth_token: String,
}

fn managed_servers() -> &'static Mutex<HashMap<String, ManagedServer>> {
    static SERVERS: OnceLock<Mutex<HashMap<String, ManagedServer>>> = OnceLock::new();
    SERVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn terminate_managed_server(server: &mut ManagedServer) {
    if let Some(group) = &server.group {
        group.kill();
    }
    let _ = server.child.kill();
    let _ = server.child.wait();
}

/// 백엔드가 내려갈 때 내장 서버를 함께 끝낸다. `SystemMcpServer::drop`이 부른다.
pub(crate) fn shutdown_managed_servers() {
    if let Ok(mut servers) = managed_servers().lock() {
        for (_, mut server) in servers.drain() {
            terminate_managed_server(&mut server);
        }
    }
}

fn stop_managed_server(id: &str) {
    if let Ok(mut servers) = managed_servers().lock() {
        if let Some(mut server) = servers.remove(id) {
            terminate_managed_server(&mut server);
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

/// 플러그인 프록시를 부른 쪽 — 주소의 `<agent>` 조각(P12).
///
/// 인증이 아니라 노출 규칙을 고르는 값이다. 경계는 여전히 라우트 키이고, 라우트 키를 아는
/// 로컬 프로세스는 어떤 조각이든 적을 수 있다(C20-5의 native와 같은 신뢰 수준). 그래서 이
/// 값은 좁히는 쪽으로만 쓰고, 조각 없는 옛 주소가 지금까지 하던 것보다 넓히는 일은 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProxyCaller {
    /// 앱 자신(AIA 프록시 작업·로컬 껍데기·연결 확인)과 조각 없는 옛 주소. 앞의 셋은 각자의
    /// 승인 절차(P10)를 지난다.
    Internal,
    /// 그 공급자의 CLI에 건넨 주소.
    Agent(ProviderId),
}

impl ProxyCaller {
    /// `ask` 도구를 사용자에게 물을 수 있는 쪽인지.
    fn confirms_tools(self) -> bool {
        match self {
            Self::Internal => true,
            Self::Agent(provider) => provider.confirms_plugin_tools(),
        }
    }
}

/// CLI에 건네는 플러그인 주소 `<base>/<agent>/<id>`. 채팅마다 붙이는 공급자와 Antigravity
/// 전역 등록이 이 함수 하나로 주소를 만든다.
pub(crate) fn plugin_proxy_url(base: &str, agent: ProviderId, id: &str) -> String {
    format!("{base}/{}/{id}", agent.as_str())
}

/// `tools/call` 전에 상류의 `readOnlyHint`를 읽을 때 따라가는 목록 쪽수 상한.
const MAX_TOOL_LIST_PAGES: usize = 20;

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
    /// 사용 토글·자격증명과 제한(`Deny`)은 프록시가 매 요청마다 다시 확인하므로 이 값과
    /// 무관하게 즉시 듣는다.
    pub fn attachable_plugins(&self) -> Result<Vec<AttachablePlugin>, CoreError> {
        let store = self.with_store_lock(|| self.load_store_unlocked())?;
        Ok(store
            .plugins
            .iter()
            .filter(|plugin| plugin.enabled && credential_ready(plugin))
            .map(|plugin| (plugin.id.clone(), plugin.tool_policies.clone()))
            .collect())
    }

    /// 붙는 플러그인의 (id, 다른 이름들). 계획 색인의 플러그인 칸과 라우터 힌트가 쓴다.
    pub fn attachable_names(&self) -> Result<Vec<(String, Vec<String>)>, CoreError> {
        let store = self.with_store_lock(|| self.load_store_unlocked())?;
        Ok(store
            .plugins
            .iter()
            .filter(|plugin| plugin.enabled && credential_ready(plugin))
            .map(|plugin| (plugin.id.clone(), plugin.names.clone().unwrap_or_default()))
            .collect())
    }

    /// 기본도구 카탈로그가 쓰는 요약. 채팅 시작마다 읽으므로 `snapshot`과 달리 npx 탐색·
    /// OAuth 대기 조회 같은 부수 작업을 하지 않고, 주소·자격증명도 싣지 않는다.
    pub fn summary(&self) -> Result<ExternalPluginSummary, CoreError> {
        let store = self.with_store_lock(|| self.load_store_unlocked())?;
        let enabled = store.plugins.iter().filter(|plugin| plugin.enabled);
        let mut summary = ExternalPluginSummary::default();
        for plugin in enabled {
            if credential_ready(plugin) {
                summary
                    .attachable
                    .push((plugin.id.clone(), plugin.display_name.clone()));
            } else {
                summary.pending += 1;
            }
        }
        Ok(summary)
    }

    /// AIA가 호출할 수 있는 플러그인의 현재 도구 계약을 프록시 경유로 읽는다. 플러그인이
    /// 꺼져 있거나 자격증명이 준비되지 않았으면 도구를 노출하지 않는다.
    pub fn aia_tool_catalog(&self, id: &str, proxy_base: &str) -> Result<Value, CoreError> {
        let plugin = self.require_attachable_plugin(id)?;
        let (_session, initialize, tools) = connect_through_proxy(proxy_base, id)?;
        Ok(json!({
            "pluginId": plugin.id,
            "displayName": plugin.display_name,
            "serverName": crate::mcp_registry::server_name(&initialize),
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
        let plugin = self.require_attachable_plugin(&request.id)?;
        let (mut session, _, tools) = connect_through_proxy(proxy_base, &request.id)?;
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
        Ok(plugin_tool_envelope(&plugin.id, &request.tool, result))
    }

    pub fn register(
        &self,
        request: ExternalPluginManifestRequest,
    ) -> Result<ExternalPluginView, CoreError> {
        let ValidatedManifest {
            display_name,
            names,
            url,
            token,
            manual_client_id,
            manual_client_secret,
            scope,
            ..
        } = validate_manifest(ManifestIntent::Register, &request)?;
        let now = now_ms();
        // 화면은 프리셋 씨앗을 채워 보낸다. 안 보낸 등록(원격 API·옛 화면)은 여기서 채운다.
        let names =
            names.unwrap_or_else(|| crate::opencode_config::seed_names(&request.id, &display_name));
        let mut plugin = StoredPlugin {
            id: request.id.clone(),
            display_name,
            names: Some(names),
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
                return Err(plugin_not_found());
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
        request: ExternalPluginManifestRequest,
    ) -> Result<ExternalPluginView, CoreError> {
        let ValidatedManifest {
            display_name,
            names,
            url,
            token,
            manual_client_id,
            client_id_was_supplied,
            manual_client_secret,
            scope,
        } = validate_manifest(ManifestIntent::Update, &request)?;

        let id = request.id;
        let updated = self.with_store_lock(|| {
            let mut store = self.load_store_unlocked()?;
            let index = store
                .plugins
                .iter()
                .position(|plugin| plugin.id == id)
                .ok_or_else(plugin_not_found)?;
            let edit = PluginEdit {
                auth: request.auth,
                url: &url,
                scope: &scope,
                token: token.as_deref(),
                manual_client_id: manual_client_id.as_deref(),
                manual_client_secret: manual_client_secret.as_deref(),
                client_id_was_supplied,
            };
            let plan = PluginEditPlan::decide(&store.plugins[index], &edit)?;
            let previous_secret = if plan.secret_store_touched {
                Some(read_secret(&id)?)
            } else {
                None
            };

            if plan.connection_changed {
                cancel_pending_oauth(&id);
                stop_managed_server(&id);
            } else if token.is_some() && request.auth == PluginAuthKind::NotionToken {
                // 내장 서버는 옛 토큰으로 떠 있다. 다음 요청이 새 토큰으로 다시 띄운다.
                stop_managed_server(&id);
            }
            if plan.secret_store_touched {
                write_edited_secret(&id, &edit)?;
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
            if let Some(names) = names.clone() {
                plugin.names = Some(names);
            }
            plugin.url = url.clone();
            plugin.auth = request.auth;
            plugin.scope = scope.clone();
            if plan.connection_changed {
                plugin.oauth = if request.auth.is_oauth() {
                    manual_client_id
                        .clone()
                        .or_else(|| kept_device_client_id.clone())
                        .map(new_manual_oauth_record)
                } else {
                    None
                };
            }
            if plan.verification_stale {
                plugin.secret_stored_at =
                    (token.is_some() || manual_client_secret.is_some()).then_some(now);
                plugin.server_name = None;
                plugin.tools.clear();
                plugin.last_verified_at = None;
                plugin.last_error = None;
            }
            plugin.updated_at = now;
            let updated = plugin.clone();
            if let Err(error) = self.save_store_unlocked(&store) {
                if let Some(previous_secret) = previous_secret {
                    restore_edited_secret(&id, previous_secret)?;
                }
                return Err(error);
            }
            Ok(updated)
        })?;
        Ok(plugin_view_with_pending(&updated))
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        if !enabled {
            stop_managed_server(id);
        }
        self.update_plugin_view(id, |plugin| {
            plugin.enabled = enabled;
            Ok(())
        })
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
        self.update_plugin_view(id, |plugin| {
            if policy == PluginToolPolicy::Ask {
                plugin.tool_policies.remove(&tool);
            } else {
                plugin.tool_policies.insert(tool.clone(), policy);
            }
            Ok(())
        })
    }

    /// 현재 알려진 도구와 이미 정책이 남아 있는 도구를 한 번의 저장으로 같은 값에 맞춘다.
    /// 이후 새로 발견되는 도구는 안전한 기본값인 `Ask`를 그대로 쓴다(P7).
    pub fn set_all_tool_policies(
        &self,
        id: &str,
        policy: PluginToolPolicy,
    ) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        self.update_plugin_view(id, |plugin| {
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
    }

    pub fn set_token(&self, id: &str, token: &str) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        let view = self.update_plugin_view(id, |plugin| {
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
        Ok(view)
    }

    /// 프록시 주소로 initialize·tools/list를 실행해 연결과 인증을 확인하고 결과를 기록한다.
    /// CLI가 실제로 쓰는 경로(프록시)를 그대로 지나므로 여기서 성공하면 채팅에서도 붙는다.
    pub fn verify(&self, id: &str, proxy_base: &str) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        let outcome = (|| {
            let (_session, initialize, tools) = connect_through_proxy(proxy_base, id)?;
            Ok::<_, CoreError>((
                crate::mcp_registry::server_name(&initialize),
                tools.into_iter().map(|tool| tool.name).collect::<Vec<_>>(),
            ))
        })();
        self.update_plugin_view(id, |plugin| {
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
        })
    }

    // -- OAuth ---------------------------------------------------------------

    /// 두 OAuth 갈래가 공통으로 거치는 앞자락 — 진행 중인 인가를 끊고, 플러그인이 OAuth
    /// 방식인지와 서버 주소를 확인하고, 인증 서버 메타데이터와 scope를 확정한다. 갈래별
    /// 몸통은 [`Self::begin_device_oauth`]와 [`Self::begin_callback_oauth`]에 있다.
    ///
    /// 어느 채널에서 불렀는지는 묻지 않는다. 기기 코드 흐름(RFC 8628)은 loopback을 쓰지
    /// 않고(H03), 콜백형은 승인 결과가 백엔드 loopback에 닿지 못하는 화면이라도 사용자가
    /// 그 주소를 붙여 넣어 끝낸다([`Self::submit_oauth_callback`], 2026-10-11).
    pub fn begin_oauth(&self, id: &str) -> Result<ExternalPluginOAuthStart, CoreError> {
        validate_plugin_id(id)?;
        let plugin = self.find_plugin(id)?;
        if !plugin.auth.is_oauth() {
            return Err(CoreError::InvalidInput(
                "이 플러그인은 OAuth 방식이 아닙니다".to_owned(),
            ));
        }
        cancel_pending_oauth(id);
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
        self.begin_callback_oauth(&plugin, metadata, scope)
    }

    /// 콜백 방식(RFC 7636 PKCE). 루프백 포트를 열어 인증 서버가 코드를 돌려줄 자리를
    /// 만들고, 사용자가 브라우저에서 승인하면 그 코드를 토큰으로 바꾼다.
    fn begin_callback_oauth(
        &self,
        plugin: &StoredPlugin,
        metadata: OAuthServerMetadata,
        scope: Option<String>,
    ) -> Result<ExternalPluginOAuthStart, CoreError> {
        let id = plugin.id.as_str();
        let stored = plugin.oauth.clone();
        let stored_port = stored
            .as_ref()
            .and_then(|record| Url::parse(&record.redirect_uri).ok())
            .and_then(|redirect| redirect.port());
        let listener = bind_callback_listener(stored_port)?;
        let port = listener.local_addr()?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}/callback");
        let (client_id, client_secret) = self.resolve_oauth_client(
            id,
            stored.as_ref(),
            &redirect_uri,
            &metadata,
            scope.as_deref(),
        )?;
        let verifier = random_urlsafe(32);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = random_urlsafe(24);
        let authorization_url = build_authorization_url(
            &metadata,
            &client_id,
            &redirect_uri,
            &challenge,
            &state,
            scope.as_deref(),
        )?;
        let record = OAuthClientRecord::renewed(
            &metadata,
            stored.as_ref(),
            client_id.clone(),
            scope.clone(),
            OAuthFlowBinding::Callback {
                redirect_uri: redirect_uri.clone(),
            },
        );
        self.save_oauth_record(id, record)?;
        if let Some(secret) = &client_secret {
            // 등록 응답에 client_secret이 왔으면 토큰과 같은 문서에 보관한다.
            let mut document = read_secret(id)?.unwrap_or_default();
            document.client_secret = Some(secret.clone());
            write_secret(id, &document)?;
        }

        let expires_at = now_ms() + OAUTH_CALLBACK_TIMEOUT.as_millis() as i64;
        let paste = Arc::new(CallbackPaste {
            redirect_uri: redirect_uri.clone(),
            state: state.clone(),
            code: Mutex::new(None),
        });
        let cancel = register_pending_oauth(id, expires_at, Some(Arc::clone(&paste)));
        let exchange = OAuthExchange {
            token_endpoint: metadata.token_endpoint,
            client_id,
            client_secret,
            redirect_uri,
            resource: metadata.resource,
            code_verifier: verifier,
            state,
        };
        self.spawn_oauth_worker(
            format!("agent-manager-plugin-oauth-{id}"),
            id.to_owned(),
            cancel,
            CALLBACK_OAUTH_LABELS,
            move |cancel| {
                wait_for_callback(&listener, &exchange.state, &paste, cancel)
                    .and_then(|code| exchange_code(&exchange, &code))
            },
        )?;
        Ok(ExternalPluginOAuthStart {
            id: id.to_owned(),
            authorization_url: authorization_url.to_string(),
            expires_at,
            user_code: None,
            accepts_callback_paste: true,
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
        let record = OAuthClientRecord::renewed(
            &metadata,
            plugin.oauth.as_ref(),
            client_id.clone(),
            scope.clone(),
            OAuthFlowBinding::Device,
        );
        self.save_oauth_record(&id, record)?;

        // 승인 대기 상한은 콜백 방식과 같게 두되, 서버가 더 짧은 만료를 주면 그쪽을 따른다.
        let expires_at = now_ms()
            + (authorization.expires_in * 1000).min(OAUTH_CALLBACK_TIMEOUT.as_millis() as i64);
        let cancel = register_pending_oauth(&id, expires_at, None);
        let token_endpoint = metadata.token_endpoint.clone();
        let device_code = authorization.device_code.clone();
        let interval = authorization.interval;
        let user_code = authorization.user_code.clone();
        let verification_url = authorization.verification_url.clone();
        self.spawn_oauth_worker(
            format!("agent-manager-plugin-device-{id}"),
            id.clone(),
            cancel,
            DEVICE_OAUTH_LABELS,
            move |cancel| {
                wait_for_device_authorization(
                    &token_endpoint,
                    &client_id,
                    &device_code,
                    client_secret.as_deref(),
                    interval,
                    expires_at,
                    cancel,
                )
            },
        )?;
        Ok(ExternalPluginOAuthStart {
            id,
            authorization_url: verification_url,
            expires_at,
            user_code: Some(user_code),
            accepts_callback_paste: false,
        })
    }

    /// 승인 뒤 브라우저가 멈춘 콜백 주소를 진행 중인 콜백형 흐름에 넘긴다. loopback 요청을
    /// 받은 것과 똑같이 대기 스레드가 code를 교환해 토큰을 저장하므로, 이 호출은 대조만 하고
    /// 돌아온다 — 교환 결과는 목록의 대기·실패 상태로 드러난다.
    ///
    /// 받는 것은 그 흐름이 등록한 redirect 주소(scheme·host·port·path)와 같은 주소이고 state가
    /// 일치하는 것뿐이다. 다른 흐름의 주소나 엉뚱한 붙여넣기는 흐름을 건드리지 않고 거절해
    /// 사용자가 다시 붙여 넣을 수 있게 한다.
    pub fn submit_oauth_callback(
        &self,
        id: &str,
        callback_url: &str,
    ) -> Result<ExternalPluginView, CoreError> {
        validate_plugin_id(id)?;
        let paste = pending_callback_paste(id).ok_or_else(|| {
            CoreError::Conflict(
                "진행 중인 브라우저 승인이 없습니다. [인증]을 다시 눌러 주세요".to_owned(),
            )
        })?;
        let code = parse_pasted_callback(callback_url, &paste.redirect_uri, &paste.state)?;
        {
            let mut slot = paste
                .code
                .lock()
                .map_err(|_| CoreError::Runtime("OAuth 대기 상태를 읽을 수 없습니다".to_owned()))?;
            if slot.is_some() {
                return Err(CoreError::Conflict(
                    "이미 받은 승인을 처리하는 중입니다".to_owned(),
                ));
            }
            *slot = Some(code);
        }
        let plugin = self.find_plugin(id)?;
        Ok(plugin_view_with_pending(&plugin))
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
            let expires_at = tokens.expires_at;
            let now = now_ms();
            self.edit_plugin_unlocked(id, |plugin| {
                plugin.secret_stored_at = Some(now);
                plugin.last_error = None;
                if let Some(record) = plugin.oauth.as_mut() {
                    record.authorized_at = Some(now);
                    record.access_expires_at = expires_at;
                    record.grant_lost_at = None;
                }
                Ok(())
            })?
            .ok_or_else(plugin_not_found)?;
            Ok(())
        })?;
        // P12. 인증이 끝나 붙을 수 있게 됐다. 화면에서 시작한 명령이 아니라 콜백·폴링이 끝낸
        // 자리라 명령 뒤의 동기화가 닿지 않으므로 여기서 Antigravity 등록을 맞춘다.
        crate::antigravity_mcp_sync::sync_in_background(self.app_data_dir.clone(), None);
        Ok(())
    }

    // -- 프록시 ---------------------------------------------------------------

    /// CLI가 보낸 MCP 요청을 인증을 붙여 상류로 전달한다. OAuth는 만료 전 갱신하고, 상류가
    /// 401을 돌려주면 한 번 갱신해 다시 시도한다. 반환 본문에는 인증정보가 없다.
    pub(crate) fn proxy(
        &self,
        id: &str,
        caller: ProxyCaller,
        request: ProxyRequest,
    ) -> Result<ProxyResponse, CoreError> {
        validate_plugin_id(id)?;
        // 프록시 주소는 이제 부팅 사이에 유지되고, 실행 단위 주입 없이 자기 설정에 주소를
        // 적어 둔 CLI도 직접 들어온다. 시작 시점의 주입 목록만으로는 "꺼진 플러그인은
        // 붙지 않는다"를 더 이상 보장하지 못하므로 매 요청마다 다시 확인한다.
        let plugin = self.require_attachable_plugin(id)?;
        // 제한한 도구는 상류에 닿기 전에 막는다. 목록에서도 지우므로 CLI는 그런 도구가
        // 있다는 사실조차 모르지만, 이전 턴의 목록을 들고 있는 실행이 뒤늦게 부를 수 있다.
        let intent = ProxyIntent::of(&request.body);
        // P12. 승인 통로가 없는 쪽은 읽지 못한 본문을 넘기지 않는다. 판정은 본문을 JSON으로
        // 읽어야 할 수 있는데, 이 프록시가 못 읽는 본문을 상류가 관대하게 읽으면(BOM 등) 판정을
        // 건너뛴 호출이 된다.
        if !caller.confirms_tools() && request.method == reqwest::Method::POST && !intent.parsed {
            return Ok(ProxyResponse {
                status: 400,
                content_type: Some("application/json".to_owned()),
                session_id: None,
                body: json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": {"code": -32700, "message": "JSON-RPC 본문을 읽지 못했습니다"},
                })
                .to_string()
                .into_bytes(),
            });
        }
        if let Some(tool) = intent
            .calls
            .iter()
            .find(|tool| plugin.tool_policies.get(tool.as_str()) == Some(&PluginToolPolicy::Deny))
        {
            return Ok(denied_tool_response(&request.body, tool));
        }
        let (upstream, authorization) = self.upstream_for(&plugin)?;
        let client = proxy_client()?;
        // P12. 승인 통로가 없는 쪽은 `allow`가 아닌 도구를 상류의 현재 `readOnlyHint`가 읽기
        // 전용이라고 할 때만 넘긴다. 목록에서 감춘 것과 같은 판정이지만, 이전 목록을 들고
        // 있는 실행이나 이름을 짐작한 호출을 막으려면 호출 자리에서 다시 봐야 한다.
        if !caller.confirms_tools() {
            let unconfirmed: Vec<&str> = intent
                .calls
                .iter()
                .map(String::as_str)
                .filter(|tool| {
                    plugin.tool_policies.get(*tool).copied().unwrap_or_default()
                        != PluginToolPolicy::Allow
                })
                .collect();
            if !unconfirmed.is_empty() {
                let read_only = upstream_read_only_tools(
                    &client,
                    &upstream,
                    authorization.as_ref().map(|value| value.as_str()),
                    &request,
                );
                match &read_only {
                    Ok(read_only) => {
                        if let Some(tool) =
                            unconfirmed.iter().find(|tool| !read_only.contains(**tool))
                        {
                            return Ok(unconfirmable_tool_response(&request.body, tool));
                        }
                    }
                    // 판정할 수 없으면 막는다. 쓰기일 수도 있는 도구를 묻지 않고 넘기지 않는다.
                    Err(error) => {
                        return Ok(tool_error_response(
                            &request.body,
                            &format!(
                                "도구('{}')가 읽기 전용인지 플러그인 서버에서 확인하지 못해 호출하지 않았습니다. 잠시 뒤 다시 시도하세요: {}",
                                unconfirmed[0],
                                text_limit::truncate_chars(&error.to_string(), 200)
                            ),
                        ));
                    }
                }
            }
        }
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
                    return Ok(hide_unexposed_tools(
                        retried,
                        &intent,
                        &plugin.tool_policies,
                        caller,
                    ));
                }
                Ok(None) => {}
                // 실패 사유는 refresh_oauth_access가 이미 last_error에 남겼다. 상류 401 응답을
                // 그대로 돌려주면 CLI는 인증 문제로 읽는다.
                Err(_) => {}
            }
        }
        Ok(hide_unexposed_tools(
            response,
            &intent,
            &plugin.tool_policies,
            caller,
        ))
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
    ///
    /// 갱신 실패는 여기서 `last_error`에 남긴다. 예전엔 일반 요청 경로의 실패가 502 본문으로만
    /// 나가고 저장소에는 아무 흔적이 없어, 토큰이 죽은 뒤에도 화면은 정상처럼 보였다.
    /// 인증 서버가 grant 자체를 거절하면(`invalid_grant` 등) 다음 요청마다 죽은 토큰으로
    /// 되풀이해도 소용없으므로 `grant_lost_at`을 찍어 "인증 필요"로 내린다.
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
            let tokens =
                match refresh_tokens(record, &refresh_token, document.client_secret.as_deref()) {
                    Ok(tokens) => tokens,
                    Err(failure) => {
                        let message = if failure.unrecoverable {
                            format!("인증 서버가 저장된 refresh token을 거절했습니다. 다시 인증해야 합니다: {}", failure.message)
                        } else {
                            format!("접근 토큰 갱신에 실패했습니다(다음 요청에서 다시 시도): {}", failure.message)
                        };
                        self.record_refresh_failure_unlocked(&plugin.id, &message, failure.unrecoverable)?;
                        return Err(CoreError::Runtime(message));
                    }
                };
            document.access_token = Some(tokens.access_token.clone());
            // OAuth 2.1은 공개 클라이언트의 refresh token을 회전시킨다. 새 값이 오면 즉시 바꾼다.
            let rotated = tokens.refresh_token.is_some();
            if let Some(next) = tokens.refresh_token {
                document.refresh_token = Some(next);
            }
            document.expires_at = tokens.expires_at;
            if let Err(error) = write_secret(&plugin.id, &document) {
                // 서버는 이미 새 토큰을 발급했고(회전이면 옛 refresh token은 죽었다) 우리는 그 값을
                // 잃었다. 회전됐다면 저장된 토큰으로는 다시 갱신할 수 없으니 재인증으로 보낸다.
                let message = format!(
                    "갱신된 토큰을 보안 저장소에 쓰지 못했습니다{}: {}",
                    if rotated { "(회전된 refresh token 유실, 다시 인증해야 합니다)" } else { "" },
                    text_limit::truncate_chars(&error.to_string(), 200)
                );
                self.record_refresh_failure_unlocked(&plugin.id, &message, rotated)?;
                return Err(CoreError::Runtime(message));
            }
            let expires_at = tokens.expires_at;
            self.edit_plugin_unlocked(&plugin.id, |stored| {
                if let Some(record) = stored.oauth.as_mut() {
                    record.access_expires_at = expires_at;
                    record.grant_lost_at = None;
                }
                stored.last_error = None;
                Ok(())
            })?;
            Ok(Some(Zeroizing::new(format!(
                "Bearer {}",
                tokens.access_token
            ))))
        })
    }

    /// 갱신 실패를 저장소와 stderr에 남긴다. 저장소 잠금을 이미 잡은 자리에서만 부른다.
    fn record_refresh_failure_unlocked(
        &self,
        id: &str,
        message: &str,
        grant_lost: bool,
    ) -> Result<(), CoreError> {
        eprintln!("[external-plugins] {id}: {message}");
        self.edit_plugin_unlocked(id, |plugin| {
            plugin.last_error = Some(text_limit::truncate_chars(message, 300));
            if grant_lost {
                if let Some(record) = plugin.oauth.as_mut() {
                    record.grant_lost_at = Some(now_ms());
                }
            }
            Ok(())
        })?;
        Ok(())
    }

    // -- 저장소 -----------------------------------------------------------------

    fn find_plugin(&self, id: &str) -> Result<StoredPlugin, CoreError> {
        self.with_store_lock(|| {
            let store = self.load_store_unlocked()?;
            store
                .plugins
                .into_iter()
                .find(|plugin| plugin.id == id)
                .ok_or_else(plugin_not_found)
        })
    }

    fn require_attachable_plugin(&self, id: &str) -> Result<StoredPlugin, CoreError> {
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

    /// 인증 서버가 그대로면 지난 등록을 재사용한다. 세션마다 새로 등록하면 이전 refresh
    /// token이 고아가 되어 매번 다시 로그인하게 된다. 돌려주는 값은 (client_id, client_secret).
    fn resolve_oauth_client(
        &self,
        id: &str,
        stored: Option<&OAuthClientRecord>,
        redirect_uri: &str,
        metadata: &OAuthServerMetadata,
        scope: Option<&str>,
    ) -> Result<(String, Option<String>), CoreError> {
        if let Some(record) = stored {
            if can_reuse_client_registration(record, redirect_uri, metadata) {
                let client_secret = read_secret(id)?.and_then(|document| document.client_secret);
                return Ok((record.client_id.clone(), client_secret));
            }
        }
        let registration_endpoint = metadata.registration_endpoint.clone().ok_or_else(|| {
            CoreError::Conflict(
                "인증 서버가 동적 클라이언트 등록을 지원하지 않습니다. 서버에서 발급한 client_id(필요하면 client_secret도)를 플러그인 등록 시 입력해 주세요"
                    .to_owned(),
            )
        })?;
        let registered = register_oauth_client(&registration_endpoint, redirect_uri, scope)?;
        Ok((registered.client_id, registered.client_secret))
    }

    /// 인증을 시작하며 확정한 OAuth 레코드를 저장하고 지난 실패 문구를 지운다.
    fn save_oauth_record(&self, id: &str, record: OAuthClientRecord) -> Result<(), CoreError> {
        self.update_plugin(id, |plugin| {
            plugin.oauth = Some(record);
            plugin.last_error = None;
            Ok(())
        })
        .map(|_| ())
    }

    /// 승인을 기다리는 스레드 하나. 콜백 방식과 디바이스 인가는 기다리는 방법만 다르고,
    /// 결과를 받은 뒤 하는 일(대기 목록 정리·취소 확인·토큰 저장·실패 문구 기록)은 같다.
    fn spawn_oauth_worker<F>(
        &self,
        thread_name: String,
        plugin_id: String,
        cancel: Arc<AtomicBool>,
        labels: OAuthFlowLabels,
        wait: F,
    ) -> Result<(), CoreError>
    where
        F: FnOnce(&AtomicBool) -> Result<TokenResponse, CoreError> + Send + 'static,
    {
        let registry = self.clone();
        thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                let outcome = wait(&cancel);
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
                                "{} 실패: {}",
                                labels.failure,
                                text_limit::truncate_chars(&error.to_string(), 300)
                            ));
                            Ok(())
                        })
                        .map(|_| ()),
                };
                if let Err(error) = result {
                    let outcome_label = labels.outcome;
                    eprintln!(
                        "[external-plugins] {plugin_id} {outcome_label} 결과를 기록하지 못했습니다: {error}"
                    );
                }
            })
            .map(|_| ())
            .map_err(|error| {
                CoreError::Runtime(format!(
                    "{} 스레드를 시작할 수 없습니다: {error}",
                    labels.thread
                ))
            })
    }

    fn update_plugin(
        &self,
        id: &str,
        update: impl FnOnce(&mut StoredPlugin) -> Result<(), CoreError>,
    ) -> Result<StoredPlugin, CoreError> {
        self.with_store_lock(|| {
            self.edit_plugin_unlocked(id, update)?
                .ok_or_else(plugin_not_found)
        })
    }

    /// 저장소 잠금을 이미 잡은 자리에서 플러그인 하나를 고쳐 쓴다. "읽고 · id로 찾고 ·
    /// 고치고 · `updated_at`을 찍고 · 저장한다"를 자리마다 손으로 되풀이하던 것을 모았다.
    /// 없는 id는 오류가 아니라 `None`이다 — 토큰 갱신 결과를 남기는 자리는 그 사이 삭제된
    /// 플러그인을 조용히 넘겨야 하고, 있어야만 하는 자리는 `None`을 제 오류로 올린다.
    fn edit_plugin_unlocked(
        &self,
        id: &str,
        edit: impl FnOnce(&mut StoredPlugin) -> Result<(), CoreError>,
    ) -> Result<Option<StoredPlugin>, CoreError> {
        let mut store = self.load_store_unlocked()?;
        let Some(plugin) = store.plugins.iter_mut().find(|item| item.id == id) else {
            return Ok(None);
        };
        edit(plugin)?;
        plugin.updated_at = now_ms();
        let updated = plugin.clone();
        self.save_store_unlocked(&store)?;
        Ok(Some(updated))
    }

    /// `update_plugin`에 이어 화면용 보기까지 만든다. 설정 하나를 고치고 그 결과를
    /// 그대로 돌려주는 명령들이 같은 세 줄을 되풀이하지 않게 한다.
    fn update_plugin_view(
        &self,
        id: &str,
        update: impl FnOnce(&mut StoredPlugin) -> Result<(), CoreError>,
    ) -> Result<ExternalPluginView, CoreError> {
        self.update_plugin(id, update)
            .map(|plugin| plugin_view_with_pending(&plugin))
    }

    fn with_store_lock<T>(
        &self,
        action: impl FnOnce() -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        STORE.with_lock(&self.app_data_dir, action)
    }

    fn load_store_unlocked(&self) -> Result<PluginStore, CoreError> {
        let mut store = STORE.load_unlocked(&self.app_data_dir)?;
        // 9.12 이전 레코드는 다른 이름이 없다. 한 번만 씨앗으로 채워 저장한다.
        if seed_missing_names(&mut store) {
            // 읽기 경로다 — 저장이 막혀도(읽기 전용 폴더) 읽기는 살린다. 다음 읽기가 다시 심는다.
            if let Err(error) = self.save_store_unlocked(&store) {
                eprintln!("[plugins] 다른 이름 씨앗을 저장하지 못했습니다: {error}");
            }
        }
        Ok(store)
    }

    fn save_store_unlocked(&self, store: &PluginStore) -> Result<(), CoreError> {
        STORE.save_unlocked(&self.app_data_dir, store)
    }
}

/// 동적 등록을 지원하지 않는 인증 서버용으로 client_id만 미리 기억하는 OAuth 레코드.
/// 엔드포인트와 redirect URI는 첫 인증 때 디스커버리로 채운다.
/// 인가 흐름마다 다른 것은 사용자에게 보일 문구뿐이다.
#[derive(Clone, Copy)]
struct OAuthFlowLabels {
    /// 플러그인 카드에 남길 실패 문구의 앞부분.
    failure: &'static str,
    /// 결과 기록 자체가 실패했을 때 콘솔에 적을 흐름 이름.
    outcome: &'static str,
    /// 스레드를 띄우지 못했을 때 사용자에게 돌려줄 흐름 이름.
    thread: &'static str,
}

const CALLBACK_OAUTH_LABELS: OAuthFlowLabels = OAuthFlowLabels {
    failure: "OAuth 인증",
    outcome: "OAuth",
    thread: "OAuth 콜백",
};

const DEVICE_OAUTH_LABELS: OAuthFlowLabels = OAuthFlowLabels {
    failure: "디바이스 인가",
    outcome: "디바이스 인가",
    thread: "디바이스 인가",
};

/// 저장된 플러그인 한 건에 대한 편집 요청. 검증을 지난 매니페스트 값만 담는다.
struct PluginEdit<'a> {
    auth: PluginAuthKind,
    url: &'a Option<String>,
    scope: &'a Option<String>,
    token: Option<&'a str>,
    manual_client_id: Option<&'a str>,
    manual_client_secret: Option<&'a str>,
    client_id_was_supplied: bool,
}

/// 편집 한 건이 무엇을 무효로 만드는지에 대한 판정. 저장 파일·보안 저장소·확인 결과를
/// 건드리는 세 갈래가 같은 조건에서 갈라지므로 한자리에서 결정한다.
struct PluginEditPlan {
    connection_changed: bool,
    verification_stale: bool,
    secret_store_touched: bool,
}

impl PluginEditPlan {
    fn decide(existing: &StoredPlugin, edit: &PluginEdit<'_>) -> Result<Self, CoreError> {
        // scope가 바뀌면 이미 받은 동의 범위와 달라진다. 같은 등록을 계속 쓰면 예전
        // 범위의 refresh token이 남으므로 연결이 바뀐 것으로 보고 다시 인증하게 한다.
        let connection_changed = existing.url != *edit.url
            || existing.auth != edit.auth
            || (edit.auth.is_oauth() && edit.client_id_was_supplied)
            || (edit.auth.is_oauth() && existing.scope != *edit.scope);
        if edit.auth == PluginAuthKind::OAuthDevice
            && edit.manual_client_id.is_none()
            && existing
                .oauth
                .as_ref()
                .is_none_or(|record| record.client_id.is_empty())
        {
            return Err(CoreError::InvalidInput(
                "디바이스 인가 방식은 서버에서 만든 앱의 clientId가 필요합니다".to_owned(),
            ));
        }
        if connection_changed
            && matches!(
                edit.auth,
                PluginAuthKind::Bearer | PluginAuthKind::NotionToken
            )
            && edit.token.is_none()
        {
            return Err(CoreError::InvalidInput(
                "서버 주소나 인증 방식을 바꿀 때는 새 토큰을 함께 입력해야 합니다".to_owned(),
            ));
        }
        // 보안 저장소는 비밀이 얽힌 편집만 지난다. 새 토큰을 쓰거나, 연결이 바뀌어
        // 이전 설정이 남겼을 수 있는 비밀을 지워야 할 때다. 인증 없는 서버끼리의
        // 편집은 지울 것도 쓸 것도 없으므로 OS 보안 저장소를 건드리지 않는다.
        let plugin_may_hold_secret =
            existing.auth.needs_secret() || existing.secret_stored_at.is_some();
        Ok(Self {
            connection_changed,
            // 연결 지점이나 자격증명이 바뀌면 이전 연결 확인 결과는 다른 서버의 것이다.
            verification_stale: connection_changed || edit.token.is_some(),
            secret_store_touched: edit.token.is_some()
                || edit.manual_client_secret.is_some()
                || (connection_changed && plugin_may_hold_secret),
        })
    }
}

/// 편집이 자격증명을 건드릴 때 보안 저장소에 그 결과를 남긴다.
fn write_edited_secret(id: &str, edit: &PluginEdit<'_>) -> Result<(), CoreError> {
    match (edit.token, edit.auth) {
        (Some(token), PluginAuthKind::Bearer | PluginAuthKind::NotionToken) => {
            write_secret(id, &token_secret_document(token, edit.auth))
        }
        (None, PluginAuthKind::OAuth | PluginAuthKind::OAuthDevice)
            if edit.manual_client_secret.is_some() =>
        {
            // 수동 client_id가 함께 오는 편집이라 connection_changed가 참이고,
            // 이전 토큰은 새 문서로 폐기된다. 토큰은 첫 인증이 다시 채운다.
            write_secret(
                id,
                &SecretDocument {
                    client_secret: edit.manual_client_secret.map(str::to_owned),
                    ..SecretDocument::default()
                },
            )
        }
        (None, PluginAuthKind::None | PluginAuthKind::OAuth | PluginAuthKind::OAuthDevice) => {
            delete_os_keychain_password(KEYCHAIN_SERVICE, id)
        }
        _ => unreachable!("validated plugin edit credential state"),
    }
}

/// 저장에 실패했을 때 보안 저장소를 편집 전 상태로 되돌린다.
fn restore_edited_secret(id: &str, previous: Option<SecretDocument>) -> Result<(), CoreError> {
    let restored = match previous {
        Some(document) => write_secret(id, &document),
        None => delete_os_keychain_password(KEYCHAIN_SERVICE, id),
    };
    restored.map_err(|error| {
        CoreError::Runtime(format!(
            "외부 플러그인 저장 실패 뒤 자격증명을 복원하지 못했습니다: {error}"
        ))
    })
}

/// 인가 대기 목록에 이 플러그인을 올리고 취소 신호를 돌려준다.
fn register_pending_oauth(
    id: &str,
    expires_at: i64,
    paste: Option<Arc<CallbackPaste>>,
) -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut pending) = pending_oauth().lock() {
        pending.insert(
            id.to_owned(),
            PendingOAuth {
                cancel: Arc::clone(&cancel),
                expires_at,
                paste,
            },
        );
    }
    cancel
}

/// 이 플러그인의 살아 있는 콜백형 흐름이 가진 붙여넣기 자리. 만료·취소된 흐름은 없는 것으로 본다.
fn pending_callback_paste(id: &str) -> Option<Arc<CallbackPaste>> {
    let now = now_ms();
    let pending = pending_oauth().lock().ok()?;
    let flow = pending.get(id)?;
    if flow.expires_at <= now || flow.cancel.load(Ordering::Acquire) {
        return None;
    }
    flow.paste.clone()
}

/// 사용자를 보낼 authorize 주소를 만든다.
fn build_authorization_url(
    metadata: &OAuthServerMetadata,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
    scope: Option<&str>,
) -> Result<Url, CoreError> {
    let mut authorization_url = Url::parse(&metadata.authorization_endpoint).map_err(|_| {
        CoreError::Runtime("인증 서버 authorization_endpoint가 올바르지 않습니다".to_owned())
    })?;
    {
        let mut query = authorization_url.query_pairs_mut();
        query
            .append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            .append_pair("resource", &metadata.resource);
        if let Some(scope) = scope {
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
    Ok(authorization_url)
}

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
        grant_lost_at: None,
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
        return plugin.oauth.as_ref().is_some_and(|record| {
            record.authorized_at.is_some() && record.grant_lost_at.is_none()
        }) && plugin.secret_stored_at.is_some();
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

/// AIA에 돌려주는 외부 플러그인 도구 결과의 봉투. 결과는 노출 상한으로 묶고, 받는 쪽이
/// 지시로 읽지 않도록 신뢰하지 않는 데이터라고 표시한다.
pub(crate) fn plugin_tool_envelope(plugin_id: &str, tool: &str, result: Value) -> Value {
    json!({
        "pluginId": plugin_id,
        "tool": tool,
        "result": crate::mcp_registry::bounded_remote_result(result),
        "contentTrust": "untrusted"
    })
}

/// 프록시 주소를 지나 이 플러그인의 상류 MCP에 붙고 도구 목록까지 읽는다. AIA 도구
/// 카탈로그·도구 호출·연결 확인이 같은 세 걸음을 각자 적고 있었다. 프록시를 그대로
/// 지나는 것이 요점이라(여기서 성공하면 채팅에서도 붙는다) 주소 조립도 함께 둔다.
fn connect_through_proxy(
    proxy_base: &str,
    id: &str,
) -> Result<(McpHttpSession, Value, Vec<McpRemoteTool>), CoreError> {
    let (mut session, initialize) =
        McpHttpSession::connect_with_authorization(&format!("{proxy_base}/{id}"), None)?;
    let tools = parse_tools(&session.list_tools()?)?;
    Ok((session, initialize, tools))
}

/// 저장소에 없는 id로 들어온 요청의 공통 오류. 조회·수정 경로가 같은 문구를 쓰게 한다.
fn plugin_not_found() -> CoreError {
    CoreError::NotFound("등록된 외부 플러그인을 찾을 수 없습니다".to_owned())
}

fn plugin_view(plugin: &StoredPlugin, oauth_pending: bool) -> ExternalPluginView {
    let credential_ready = credential_ready(plugin);
    let (authorized_at, access_expires_at) = carried_grant(plugin.oauth.as_ref());
    ExternalPluginView {
        id: plugin.id.clone(),
        display_name: plugin.display_name.clone(),
        names: plugin.names.clone().unwrap_or_default(),
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
        authorized_at,
        access_expires_at,
        created_at: plugin.created_at,
        updated_at: plugin.updated_at,
    }
}

/// 방금 저장한 플러그인을 화면용 보기로 바꾼다. 대기 중인 OAuth 표시는 이 시점에 읽는다.
fn plugin_view_with_pending(plugin: &StoredPlugin) -> ExternalPluginView {
    plugin_view(plugin, pending_oauth_ids().contains(&plugin.id))
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

/// 앞단 검증이 갈리는 두 지점. 등록은 토큰을 반드시 받고 디바이스 인가의 client_id를
/// 그 자리에서 요구하지만, 편집은 생략된 토큰을 "기존 유지"로 읽고 client_id는 값이
/// 전달됐는지 자체를 연결 변경 신호로 쓴다.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ManifestIntent {
    Register,
    Update,
}

struct ValidatedManifest {
    display_name: String,
    names: Option<Vec<String>>,
    url: Option<String>,
    token: Option<String>,
    manual_client_id: Option<String>,
    /// 값이 실려 왔는지 자체. 빈 문자열이어도 참이라 편집은 이것으로 연결 변경을 읽는다.
    client_id_was_supplied: bool,
    manual_client_secret: Option<String>,
    scope: Option<String>,
}

/// 등록·편집이 저장소 잠금 밖에서 똑같이 거치던 매니페스트 검증. 검사 순서가 곧
/// 사용자가 처음 보는 오류라서 원래 순서를 그대로 지킨다.
fn validate_manifest(
    intent: ManifestIntent,
    input: &ExternalPluginManifestRequest,
) -> Result<ValidatedManifest, CoreError> {
    validate_plugin_id(&input.id)?;
    let display_name = validate_display_name(&input.display_name)?;
    let names = input.names.as_deref().map(validate_names).transpose()?;
    let url = validate_request_url(input.auth, input.url.as_deref())?;
    let token = validate_request_token(
        input.auth,
        input.token.as_deref(),
        intent == ManifestIntent::Register,
    )?;
    let client_id_was_supplied = input.client_id.is_some();
    let manual_client_id = input
        .client_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(validate_client_id)
        .transpose()?;
    let client_id_in_play = match intent {
        ManifestIntent::Register => manual_client_id.is_some(),
        ManifestIntent::Update => client_id_was_supplied,
    };
    if client_id_in_play && !input.auth.is_oauth() {
        return Err(CoreError::InvalidInput(
            "clientId는 OAuth 방식에서만 쓰입니다".to_owned(),
        ));
    }
    // 디바이스 인가에는 동적 등록이 없다. client_id 없이는 승인 화면을 열 수 없으므로
    // 등록 단계에서 막아, 인증을 눌러야 아는 실패를 만들지 않는다. 편집은 기존 등록에
    // 남은 client_id를 이어 쓸 수 있어 저장소를 읽는 자리에서 따로 본다.
    if intent == ManifestIntent::Register
        && input.auth == PluginAuthKind::OAuthDevice
        && manual_client_id.is_none()
    {
        return Err(CoreError::InvalidInput(
            "디바이스 인가 방식은 서버에서 만든 앱의 clientId가 필요합니다".to_owned(),
        ));
    }
    let manual_client_secret =
        validate_manual_client_secret(input.client_secret.as_deref(), &manual_client_id)?;
    let scope = validate_scope(input.scope.as_deref(), input.auth)?;
    Ok(ValidatedManifest {
        display_name,
        names,
        url,
        token,
        manual_client_id,
        client_id_was_supplied,
        manual_client_secret,
        scope,
    })
}

/// 다른 이름 목록을 다듬는다 — 앞뒤 공백을 떼고, 빈 것과 겹치는 것을 빼고, 표시 이름과
/// 같은 규칙(제어문자 없는 1~80자)으로 검사한다. 여덟 개면 충분하다.
fn validate_names(values: &[String]) -> Result<Vec<String>, CoreError> {
    let mut names: Vec<String> = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() || names.iter().any(|known| known == value) {
            continue;
        }
        if !TextShape::DISPLAY_NAME.accepts(value) {
            return Err(CoreError::InvalidInput(
                "플러그인 다른 이름은 제어문자 없는 1~80자여야 합니다".to_owned(),
            ));
        }
        names.push(value.to_owned());
    }
    if names.len() > MAX_PLUGIN_NAMES {
        return Err(CoreError::InvalidInput(format!(
            "플러그인 다른 이름은 {MAX_PLUGIN_NAMES}개까지만 둘 수 있습니다"
        )));
    }
    Ok(names)
}

/// 옛 레코드(`names: None`)에 씨앗을 한 번 채운다. 바뀐 것이 있으면 true.
fn seed_missing_names(store: &mut PluginStore) -> bool {
    let mut changed = false;
    for plugin in &mut store.plugins {
        if plugin.names.is_none() {
            plugin.names = Some(crate::opencode_config::seed_names(
                &plugin.id,
                &plugin.display_name,
            ));
            changed = true;
        }
    }
    changed
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
    Ok(Some(validate_mcp_endpoint(url.unwrap_or_default())?))
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

/// 한 줄 입력값이 지켜야 하는 모양. 검사 다섯 벌이 "길이 상한"과 "못 들어갈 글자 종류"를
/// 각자 손으로 적고 있어서, 값마다 다른 것만 여기 두고 판정은 한 자리로 모은다. 빈 값의
/// 의미는 칸마다 다르므로(어떤 칸은 오류, 어떤 칸은 "고르지 않음") 여기서 보지 않는다.
#[derive(Clone, Copy)]
struct TextShape {
    /// 길이 상한. 사람이 읽는 이름만 글자 수로 세고, 나머지는 바이트로 센다.
    limit: usize,
    count_chars: bool,
    /// 공백까지 막을지. 식별자·비밀값류는 막고, 사람이 읽는 이름과 공백으로 나뉜
    /// scope 목록은 허용한다.
    deny_whitespace: bool,
}

impl TextShape {
    const DISPLAY_NAME: Self = Self {
        limit: 80,
        count_chars: true,
        deny_whitespace: false,
    };
    const CLIENT_ID: Self = Self {
        limit: 256,
        count_chars: false,
        deny_whitespace: true,
    };
    const CLIENT_SECRET: Self = Self {
        limit: 512,
        count_chars: false,
        deny_whitespace: true,
    };
    const SCOPE: Self = Self {
        limit: 1024,
        count_chars: false,
        deny_whitespace: false,
    };
    const TOKEN: Self = Self {
        limit: MAX_TOKEN_CHARS,
        count_chars: false,
        deny_whitespace: true,
    };

    fn accepts(self, value: &str) -> bool {
        let length = if self.count_chars {
            value.chars().count()
        } else {
            value.len()
        };
        length <= self.limit
            && !value
                .chars()
                .any(|c| c.is_control() || (self.deny_whitespace && c.is_whitespace()))
    }
}

fn validate_display_name(value: &str) -> Result<String, CoreError> {
    let value = value.trim();
    if value.is_empty() || !TextShape::DISPLAY_NAME.accepts(value) {
        return Err(CoreError::InvalidInput(
            "플러그인 표시 이름은 제어문자 없는 1~80자여야 합니다".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn validate_client_id(value: &str) -> Result<String, CoreError> {
    if value.is_empty() || !TextShape::CLIENT_ID.accepts(value) {
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
    if !TextShape::CLIENT_SECRET.accepts(value) {
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
    if !TextShape::SCOPE.accepts(value) {
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
    if value.is_empty() || !TextShape::TOKEN.accepts(value) {
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

fn validate_https_or_loopback(url: &str, what: &str) -> Result<Url, CoreError> {
    let parsed = Url::parse(url)
        .map_err(|_| CoreError::Runtime(format!("{what} 주소가 올바르지 않습니다")))?;
    let loopback = parsed.host_str().is_some_and(is_loopback_url_host);
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
    let resource = discover_protected_resource(&client, mcp_url, &mcp);

    let as_url = validate_https_or_loopback(&resource.authorization_server, "인증 서버")?;
    let as_origin = url_origin(&as_url);
    let as_path = as_url.path().trim_end_matches('/');

    let mut metadata: Option<OAuthServerMetadata> = None;
    for candidate in authorization_server_candidates(&as_origin, as_path) {
        let Some(document) = fetch_json(&client, &candidate) else {
            continue;
        };
        if let Some(found) = parse_authorization_server_metadata(&document, &resource)? {
            metadata = Some(found);
            break;
        }
    }
    let metadata = metadata.unwrap_or(OAuthServerMetadata {
        authorization_endpoint: format!("{as_origin}/authorize"),
        token_endpoint: format!("{as_origin}/token"),
        registration_endpoint: Some(format!("{as_origin}/register")),
        device_authorization_endpoint: None,
        resource: resource.resource,
        scope: resource.scope,
    });
    ensure_metadata_endpoints_allowed(&metadata)?;
    Ok(metadata)
}

/// protected resource metadata(RFC 9728)에서 읽어낸 인증 서버와 자원 식별자.
/// 문서를 못 찾으면 MCP 서버 자신의 origin이 그대로 남는다.
struct ProtectedResource {
    authorization_server: String,
    resource: String,
    scope: Option<String>,
}

/// 401이 가리킨 문서와 규격이 정한 well-known 위치를 순서대로 뒤져 인증 서버를 정한다.
fn discover_protected_resource(client: &Client, mcp_url: &str, mcp: &Url) -> ProtectedResource {
    let origin = url_origin(mcp);
    let mut discovered = ProtectedResource {
        authorization_server: origin.clone(),
        resource: canonical_resource(mcp),
        scope: None,
    };
    let mut found_resource_metadata = false;
    for candidate in protected_resource_candidates(client, mcp_url, mcp, &origin) {
        let Some(document) = fetch_json(client, &candidate) else {
            continue;
        };
        let Some(server) = document
            .get("authorization_servers")
            .and_then(Value::as_array)
            .and_then(|servers| servers.first())
            .and_then(Value::as_str)
        else {
            continue;
        };
        found_resource_metadata = true;
        discovered.authorization_server = server.trim_end_matches('/').to_owned();
        if let Some(declared) = document.get("resource").and_then(Value::as_str) {
            discovered.resource = declared.to_owned();
        }
        discovered.scope = document
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
    // RFC 9728 메타데이터가 없으면 origin을 인증 서버로 보는 폴백이 구글 공식 MCP에서는
    // 존재하지 않는 endpoint(`{origin}/authorize`)로 낙착한다. 알려진 구글 MCP는 인증
    // 서버가 구글 계정임이 확실하므로 그쪽 well-known 조회로 바로 간다.
    if !found_resource_metadata
        && hosted_preset_for(mcp_url).is_some_and(|preset| preset.brand == "google")
    {
        discovered.authorization_server = GOOGLE_AUTHORIZATION_SERVER.to_owned();
    }
    discovered
}

/// 뒤져 볼 protected resource metadata 주소를 우선순위대로 모은다. 맨 앞은 MCP 서버가
/// 401의 `WWW-Authenticate`로 직접 알려 준 주소다.
fn protected_resource_candidates(
    client: &Client,
    mcp_url: &str,
    mcp: &Url,
    origin: &str,
) -> Vec<String> {
    let mut candidates = Vec::new();
    if let Ok(response) = client
        .post(mcp_url)
        .header(CONTENT_TYPE, "application/json")
        .header(ACCEPT, "application/json, text/event-stream")
        .body(json!({"jsonrpc":"2.0","id":0,"method":"ping"}).to_string())
        .send()
    {
        if response.status() == StatusCode::UNAUTHORIZED {
            candidates.extend(
                response
                    .headers()
                    .get(WWW_AUTHENTICATE)
                    .and_then(|value| value.to_str().ok())
                    .and_then(parse_resource_metadata_url),
            );
        }
    }
    let path = mcp.path().trim_end_matches('/');
    if !path.is_empty() {
        candidates.push(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ));
    }
    candidates.push(format!("{origin}/.well-known/oauth-protected-resource"));
    candidates
}

/// 인증 서버 메타데이터(RFC 8414·OpenID Discovery)를 뒤져 볼 주소를 우선순위대로 모은다.
fn authorization_server_candidates(as_origin: &str, as_path: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    if !as_path.is_empty() {
        candidates.push(format!(
            "{as_origin}/.well-known/oauth-authorization-server{as_path}"
        ));
        candidates.push(format!(
            "{as_origin}/.well-known/openid-configuration{as_path}"
        ));
        candidates.push(format!(
            "{as_origin}{as_path}/.well-known/openid-configuration"
        ));
    }
    candidates.push(format!(
        "{as_origin}/.well-known/oauth-authorization-server"
    ));
    candidates.push(format!("{as_origin}/.well-known/openid-configuration"));
    candidates
}

/// 인증 서버 메타데이터 문서를 읽는다. 두 필수 endpoint가 없는 문서는 다음 후보로
/// 넘기려고 `None`이 되고, PKCE S256을 광고하지 않는 서버는 후보를 더 보지 않고 거절한다.
fn parse_authorization_server_metadata(
    document: &Value,
    resource: &ProtectedResource,
) -> Result<Option<OAuthServerMetadata>, CoreError> {
    let (Some(authorize), Some(token)) = (
        document
            .get("authorization_endpoint")
            .and_then(Value::as_str),
        document.get("token_endpoint").and_then(Value::as_str),
    ) else {
        return Ok(None);
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
    Ok(Some(OAuthServerMetadata {
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
        resource: resource.resource.clone(),
        scope: resource.scope.clone(),
    }))
}

/// 메타데이터가 알려 준 endpoint도 등록 URL과 같은 관문(HTTPS 또는 loopback)을 지나야 한다.
fn ensure_metadata_endpoints_allowed(metadata: &OAuthServerMetadata) -> Result<(), CoreError> {
    validate_https_or_loopback(&metadata.authorization_endpoint, "authorization_endpoint")?;
    validate_https_or_loopback(&metadata.token_endpoint, "token_endpoint")?;
    if let Some(registration) = &metadata.registration_endpoint {
        validate_https_or_loopback(registration, "registration_endpoint")?;
    }
    if let Some(device) = &metadata.device_authorization_endpoint {
        validate_https_or_loopback(device, "device_authorization_endpoint")?;
    }
    Ok(())
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
    push_client_secret(&mut form, exchange.client_secret.as_deref());
    request_tokens(&exchange.token_endpoint, &form)
}

/// 접근 토큰 갱신 실패. `unrecoverable`은 인증 서버가 grant 자체를 거절한 경우다 —
/// 같은 refresh token으로 다시 시도해도 결과가 같으므로 사용자가 다시 인증해야 한다.
/// 네트워크·5xx·해석 실패는 다음 요청에서 다시 시도할 수 있다.
struct TokenRefreshFailure {
    unrecoverable: bool,
    message: String,
}

/// RFC 6749 5.2에서 refresh token으로는 회복할 수 없는 거절 코드들. `invalid_grant`가
/// 만료·회수·회전 유실이고, 나머지 둘은 클라이언트 등록이 무효해진 경우다.
const UNRECOVERABLE_TOKEN_ERRORS: [&str; 3] =
    ["invalid_grant", "invalid_client", "unauthorized_client"];

fn classify_token_rejection(status: StatusCode, body: &Value) -> TokenRefreshFailure {
    let code = body.get("error").and_then(Value::as_str).unwrap_or("");
    TokenRefreshFailure {
        unrecoverable: status.is_client_error() && UNRECOVERABLE_TOKEN_ERRORS.contains(&code),
        message: issuance_rejected("토큰", status, body),
    }
}

fn refresh_tokens(
    record: &OAuthClientRecord,
    refresh_token: &str,
    client_secret: Option<&str>,
) -> Result<TokenResponse, TokenRefreshFailure> {
    let mut form = vec![
        ("grant_type", "refresh_token".to_owned()),
        ("refresh_token", refresh_token.to_owned()),
        ("client_id", record.client_id.clone()),
        ("resource", record.resource.clone()),
    ];
    push_client_secret(&mut form, client_secret);
    let transient = |error: CoreError| TokenRefreshFailure {
        unrecoverable: false,
        message: error.to_string(),
    };
    let (status, body) = post_form_json(&record.token_endpoint, "token_endpoint", "토큰", &form)
        .map_err(transient)?;
    if !status.is_success() {
        return Err(classify_token_rejection(status, &body));
    }
    parse_token_response(&body).map_err(transient)
}

/// OAuth endpoint에 form을 싣고 상태 코드와 JSON 본문을 받아 온다. 토큰 교환·갱신,
/// 디바이스 코드 발급, 디바이스 토큰 폴링이 같은 전처리(주소 검증 → 클라이언트 → form
/// POST → JSON 해석)를 각자 적고 있었다. `endpoint_label`은 주소 검증 메시지에,
/// `subject`는 요청·해석 실패 메시지에 쓰인다.
fn post_form_json(
    endpoint: &str,
    endpoint_label: &str,
    subject: &str,
    form: &[(&str, String)],
) -> Result<(StatusCode, Value), CoreError> {
    validate_https_or_loopback(endpoint, endpoint_label)?;
    let client = discovery_client()?;
    let response = client
        .post(endpoint)
        .header(ACCEPT, "application/json")
        .form(form)
        .send()
        .map_err(|error| CoreError::Runtime(format!("{subject} 요청이 실패했습니다: {error}")))?;
    let status = response.status();
    let body: Value = response
        .json()
        .map_err(|_| CoreError::Runtime(format!("{subject} 응답을 해석하지 못했습니다")))?;
    Ok((status, body))
}

/// 인증 서버가 거절 이유로 싣는 칸을 순서대로 본다(RFC 6749 5.2).
fn oauth_error_reason(body: &Value) -> &str {
    body.get("error_description")
        .or_else(|| body.get("error"))
        .and_then(Value::as_str)
        .unwrap_or("이유 없음")
}

/// 인증 서버가 발급을 거절했을 때의 문구. 토큰 교환·갱신과 디바이스 코드 발급이 같은 틀을
/// 각자 적고 있었다 — 다른 것은 `subject`(무엇의 발급인지)뿐이다. 디바이스 폴링의 두 갈래는
/// 상태 코드나 이유 중 한쪽이 없는 별개의 문구라 여기에 묶지 않는다.
fn issuance_rejected(subject: &str, status: StatusCode, body: &Value) -> String {
    format!(
        "인증 서버가 {subject} 발급을 거절했습니다 (HTTP {}): {}",
        status.as_u16(),
        oauth_error_reason(body)
    )
}

/// 응답 본문에서 비어 있지 않은 문자열 칸만 값으로 본다. 토큰 응답과 디바이스 코드 응답이
/// "칸은 있는데 빈 문자열이면 없는 것"이라는 같은 규칙을 각자 적고 있었다.
fn non_empty_field(body: &Value, name: &str) -> Option<String> {
    body.get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// 공개 클라이언트가 아니면 form에 client_secret을 싣는다. 토큰 교환·갱신·디바이스 폴링이
/// 같은 조건부 한 줄을 각자 적고 있었다.
fn push_client_secret(form: &mut Vec<(&'static str, String)>, client_secret: Option<&str>) {
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret.to_owned()));
    }
}

fn request_tokens(
    token_endpoint: &str,
    form: &[(&str, String)],
) -> Result<TokenResponse, CoreError> {
    let (status, body) = post_form_json(token_endpoint, "token_endpoint", "토큰", form)?;
    if !status.is_success() {
        return Err(CoreError::Runtime(issuance_rejected("토큰", status, &body)));
    }
    parse_token_response(&body)
}

fn parse_token_response(body: &Value) -> Result<TokenResponse, CoreError> {
    let access_token = non_empty_field(body, "access_token")
        .ok_or_else(|| CoreError::Runtime("토큰 응답에 access_token이 없습니다".to_owned()))?;
    let expires_at = body
        .get("expires_in")
        .and_then(Value::as_i64)
        .filter(|seconds| *seconds > 0)
        .map(|seconds| now_ms() + seconds * 1000);
    Ok(TokenResponse {
        access_token,
        refresh_token: non_empty_field(body, "refresh_token"),
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
    let mut form = vec![("client_id", client_id.to_owned())];
    if let Some(scope) = scope {
        form.push(("scope", scope.to_owned()));
    }
    let (status, body) = post_form_json(
        device_endpoint,
        "device_authorization_endpoint",
        "디바이스 코드",
        &form,
    )?;
    if !status.is_success() || body.get("error").is_some() {
        return Err(CoreError::Runtime(issuance_rejected(
            "디바이스 코드",
            status,
            &body,
        )));
    }
    let device_code = non_empty_field(&body, "device_code").ok_or_else(|| {
        CoreError::Runtime("디바이스 코드 응답에 device_code가 없습니다".to_owned())
    })?;
    let user_code = non_empty_field(&body, "user_code").ok_or_else(|| {
        CoreError::Runtime("디바이스 코드 응답에 user_code가 없습니다".to_owned())
    })?;
    let verification_uri = non_empty_field(&body, "verification_uri")
        .or_else(|| non_empty_field(&body, "verification_url"))
        .ok_or_else(|| {
            CoreError::Runtime("디바이스 코드 응답에 verification_uri가 없습니다".to_owned())
        })?;
    // 코드가 채워진 주소를 주면 그쪽을 연다. 사용자가 코드를 손으로 옮겨 적지 않아도 된다.
    let verification_url =
        non_empty_field(&body, "verification_uri_complete").unwrap_or(verification_uri);
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
    let mut form = vec![
        ("grant_type", DEVICE_CODE_GRANT.to_owned()),
        ("device_code", device_code.to_owned()),
        ("client_id", client_id.to_owned()),
    ];
    push_client_secret(&mut form, client_secret);
    let (status, body) = post_form_json(token_endpoint, "token_endpoint", "토큰", &form)?;
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
/// 오류 응답이면 실패로 끝내고, 그 외 경로(favicon 등)는 404로 흘려보낸다. 같은 대기 중에
/// 사용자가 콜백 주소를 붙여 넣으면(`paste`, 이미 대조를 마친 code) 그 code로 끝낸다.
fn wait_for_callback(
    listener: &TcpListener,
    expected_state: &str,
    paste: &CallbackPaste,
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
        if let Some(code) = paste.code.lock().ok().and_then(|slot| slot.clone()) {
            return Ok(code);
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
    Some(callback_query(&url))
}

/// 사용자가 붙여 넣은 콜백 주소에서 code를 꺼낸다. 흐름이 등록한 redirect 주소와
/// scheme·port·path가 같고 host가 loopback이어야 하며(브라우저는 `localhost`로 보여 주기도
/// 한다), state가 일치해야 한다. 인증 서버의 거절(`error`)은 그 사유를 그대로 돌려준다.
fn parse_pasted_callback(
    pasted: &str,
    redirect_uri: &str,
    expected_state: &str,
) -> Result<String, CoreError> {
    let pasted = pasted.trim();
    if pasted.is_empty() {
        return Err(CoreError::InvalidInput(
            "승인 뒤 브라우저 주소창의 주소를 붙여 넣어 주세요".to_owned(),
        ));
    }
    if pasted.len() > MAX_PASTED_CALLBACK_BYTES {
        return Err(CoreError::InvalidInput(
            "붙여 넣은 내용이 너무 깁니다. 주소창의 주소 한 줄만 붙여 넣어 주세요".to_owned(),
        ));
    }
    let expected = Url::parse(redirect_uri)
        .map_err(|_| CoreError::Runtime("등록된 redirect 주소를 읽을 수 없습니다".to_owned()))?;
    let url = Url::parse(pasted).map_err(|_| {
        CoreError::InvalidInput(format!(
            "주소로 읽을 수 없습니다. {}로 시작하는 주소창 전체를 붙여 넣어 주세요",
            expected.as_str()
        ))
    })?;
    let same_target = url.scheme() == expected.scheme()
        && url.host_str().is_some_and(is_loopback_url_host)
        && url.port_or_known_default() == expected.port_or_known_default()
        && url.path() == expected.path();
    if !same_target {
        return Err(CoreError::InvalidInput(format!(
            "이 인증의 콜백 주소가 아닙니다. {}로 시작하는 주소를 붙여 넣어 주세요",
            expected.as_str()
        )));
    }
    let query = callback_query(&url);
    if let Some(error) = query.error {
        return Err(CoreError::Conflict(format!(
            "인증 서버가 거절했습니다: {error}"
        )));
    }
    if query.state.as_deref() != Some(expected_state) {
        return Err(CoreError::Conflict(
            "state가 이 인증과 맞지 않습니다. 가장 최근에 연 승인 화면의 주소를 붙여 넣어 주세요"
                .to_owned(),
        ));
    }
    query
        .code
        .filter(|code| !code.is_empty())
        .ok_or_else(|| CoreError::InvalidInput("주소에 인증 코드(code)가 없습니다".to_owned()))
}

fn callback_query(url: &Url) -> CallbackQuery {
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
    query
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
#[derive(Debug, Default, PartialEq, Eq)]
struct ProxyIntent {
    /// 본문이 JSON으로 읽혔는지.
    parsed: bool,
    /// 본문에 `tools/list`가 있는지. 응답의 도구 목록을 거를지 정한다.
    lists_tools: bool,
    /// 본문이 부르는 도구 이름 전부.
    calls: Vec<String>,
}

impl ProxyIntent {
    /// CLI가 보낸 JSON-RPC 본문에서 의도를 읽는다. 배치(JSON 배열)는 요소를 모두 훑어 부르는
    /// 도구를 **전부** 모은다 — 첫 이름만 보면 허용된 호출 뒤에 제한한 호출을 붙여 피할 수 있다.
    fn of(body: &[u8]) -> Self {
        let Ok(payload) = serde_json::from_slice::<Value>(body) else {
            return ProxyIntent::default();
        };
        let entries: Vec<&Value> = match &payload {
            Value::Array(items) => items.iter().collect(),
            value => vec![value],
        };
        let mut intent = ProxyIntent {
            parsed: true,
            ..ProxyIntent::default()
        };
        for entry in entries {
            match entry.get("method").and_then(Value::as_str) {
                Some("tools/call") => {
                    if let Some(name) = entry
                        .get("params")
                        .and_then(|params| params.get("name"))
                        .and_then(Value::as_str)
                    {
                        intent.calls.push(name.to_owned());
                    }
                }
                Some("tools/list") => intent.lists_tools = true,
                _ => {}
            }
        }
        intent
    }
}

/// 제한한 도구 호출에 상류 대신 돌려주는 응답. 프로토콜 오류가 아니라 도구 오류로 주어야
/// CLI가 대화를 끊지 않고 모델에게 거절 사유를 전달한다.
fn denied_tool_response(body: &[u8], tool: &str) -> ProxyResponse {
    tool_error_response(
        body,
        &format!(
            "Agent Manager 설정에서 이 도구('{tool}')를 제한했습니다. 사용자가 설정에서 허용하거나 확인으로 바꾸기 전에는 호출할 수 없습니다."
        ),
    )
}

fn tool_error_response(body: &[u8], text: &str) -> ProxyResponse {
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
                "text": text,
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

/// 승인 통로가 없는 에이전트가 확인이 필요한 쓰기 도구를 부를 때 상류 대신 돌려주는 응답(P12).
/// 제한(`deny`)과 문구를 가른다 — 사용자가 막은 것이 아니라, 물을 길이 없어 열지 않은 것이다.
fn unconfirmable_tool_response(body: &[u8], tool: &str) -> ProxyResponse {
    tool_error_response(
        body,
        &format!(
            "이 에이전트는 실행 전에 사용자 확인을 받을 수 없어, 확인이 필요한 쓰기 도구('{tool}')를 열지 않습니다. 사용자가 Agent Manager 애드온 → 외부 MCP에서 이 도구를 '허용'으로 바꾸면 쓸 수 있습니다."
        ),
    )
}

/// 도구 하나가 이 호출자에게 보이는지(P11·P12). 제한은 누구에게도 보이지 않고 허용은 누구에게나
/// 보인다. 확인(기본값)은 물을 수 있는 쪽에는 그대로, 물을 수 없는 쪽에는 상류가 읽기 전용이라고
/// 밝힌 도구만 보인다.
fn tool_is_exposed(
    tool: &Value,
    policies: &BTreeMap<String, PluginToolPolicy>,
    caller: ProxyCaller,
) -> bool {
    let Some(name) = tool.get("name").and_then(Value::as_str) else {
        return true;
    };
    match policies.get(name).copied().unwrap_or_default() {
        PluginToolPolicy::Deny => false,
        PluginToolPolicy::Allow => true,
        PluginToolPolicy::Ask => caller.confirms_tools() || tool_is_read_only(tool),
    }
}

fn tool_is_read_only(tool: &Value) -> bool {
    tool.get("annotations")
        .and_then(|annotations| annotations.get("readOnlyHint"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// `tools/list` 응답에서 이 호출자에게 보이지 않는 도구를 지운다. 스트리밍 응답
/// (`text/event-stream`)은 `data:` 줄마다 JSON이 실려 오므로 줄 단위로 다시 쓴다.
fn hide_unexposed_tools(
    response: ProxyResponse,
    intent: &ProxyIntent,
    policies: &BTreeMap<String, PluginToolPolicy>,
    caller: ProxyCaller,
) -> ProxyResponse {
    if !intent.lists_tools {
        return response;
    }
    let has_denied = policies
        .values()
        .any(|policy| *policy == PluginToolPolicy::Deny);
    if !has_denied && caller.confirms_tools() {
        return response;
    }
    let Ok(text) = std::str::from_utf8(&response.body) else {
        return response;
    };
    let is_event_stream = response
        .content_type
        .as_deref()
        .is_some_and(|value| value.contains("text/event-stream"));
    let keep = |tool: &Value| tool_is_exposed(tool, policies, caller);
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
                .map(|payload| retain_listed_tools(payload, &keep))
            {
                Some(payload) => lines.push(format!("data: {payload}{ending}")),
                None => lines.push(format!("{line}{ending}")),
            }
        }
        lines.concat()
    } else {
        match serde_json::from_str::<Value>(text) {
            Ok(payload) => retain_listed_tools(payload, &keep).to_string(),
            Err(_) => return response,
        }
    };
    ProxyResponse {
        body: rewritten.into_bytes(),
        ..response
    }
}

fn retain_listed_tools(mut payload: Value, keep: &dyn Fn(&Value) -> bool) -> Value {
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
            tools.retain(|tool| keep(tool));
        }
    }
    payload
}

/// 응답 본문(JSON 또는 `text/event-stream`)에서 JSON-RPC `result`를 꺼낸다.
fn rpc_result(response: &ProxyResponse) -> Option<Value> {
    let text = std::str::from_utf8(&response.body).ok()?;
    let result_of = |payload: Value| -> Option<Value> {
        match payload {
            Value::Array(items) => items
                .into_iter()
                .find_map(|item| item.get("result").cloned()),
            value => value.get("result").cloned(),
        }
    };
    if let Ok(payload) = serde_json::from_str::<Value>(text) {
        return result_of(payload);
    }
    text.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|payload| serde_json::from_str::<Value>(payload.trim()).ok())
        .find_map(result_of)
}

/// `tools/call`을 넘기기 전에 상류의 현재 `readOnlyHint`를 읽는다(P12). CLI가 맺은 세션
/// 그대로 `tools/list`를 한 번 더 보낸다 — 목록이 지날 때 기억해 둔 값에 기대면 상류가 주석을
/// 바꾼 뒤에도 옛 판정으로 통과시킨다.
fn upstream_read_only_tools(
    client: &Client,
    upstream: &str,
    authorization: Option<&str>,
    request: &ProxyRequest,
) -> Result<BTreeSet<String>, CoreError> {
    let mut read_only = BTreeSet::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_TOOL_LIST_PAGES {
        let mut params = json!({});
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        let list = ProxyRequest {
            method: reqwest::Method::POST,
            content_type: Some("application/json".to_owned()),
            accept: None,
            session_id: request.session_id.clone(),
            protocol_version: request.protocol_version.clone(),
            body: json!({
                "jsonrpc": "2.0",
                // 세션 안에서 요청 id를 다시 쓰지 않는다(MCP). 병렬 호출 둘이 같은 id로 판정을
                // 물으면 응답을 id로 잇는 서버가 한쪽을 잃는다.
                "id": format!("agent-manager-tool-policy-{}", Uuid::new_v4().simple()),
                "method": "tools/list",
                "params": params,
            })
            .to_string()
            .into_bytes(),
        };
        let response = send_proxy_request(client, upstream, authorization, &list)?;
        let result = (response.status < 300)
            .then(|| rpc_result(&response))
            .flatten()
            .ok_or_else(|| CoreError::Runtime("플러그인 도구 목록을 읽지 못했습니다".to_owned()))?;
        for tool in result
            .get("tools")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(name) = tool.get("name").and_then(Value::as_str) {
                if tool_is_read_only(tool) {
                    read_only.insert(name.to_owned());
                }
            }
        }
        cursor = result
            .get("nextCursor")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    Ok(read_only)
}

fn send_proxy_request(
    client: &Client,
    upstream: &str,
    authorization: Option<&str>,
    request: &ProxyRequest,
) -> Result<ProxyResponse, CoreError> {
    let mut headers = HeaderMap::new();
    insert_valid_header(&mut headers, CONTENT_TYPE, request.content_type.as_deref());
    headers.insert(
        ACCEPT,
        request
            .accept
            .as_deref()
            .and_then(|value| HeaderValue::from_str(value).ok())
            .unwrap_or_else(|| HeaderValue::from_static("application/json, text/event-stream")),
    );
    insert_valid_header(
        &mut headers,
        "mcp-session-id",
        request.session_id.as_deref(),
    );
    insert_valid_header(
        &mut headers,
        "mcp-protocol-version",
        request.protocol_version.as_deref(),
    );
    insert_valid_header(&mut headers, AUTHORIZATION, authorization);
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
    let body = crate::mcp_registry::read_capped_body(
        response,
        MAX_PROXY_RESPONSE_BYTES,
        "플러그인 서버 응답을 읽지 못했습니다",
    )?;
    Ok(ProxyResponse {
        status,
        content_type,
        session_id,
        body,
    })
}

fn insert_valid_header(
    headers: &mut HeaderMap,
    name: impl reqwest::header::IntoHeaderName,
    value: Option<&str>,
) {
    if let Some(value) = value.and_then(|value| HeaderValue::from_str(value).ok()) {
        headers.insert(name, value);
    }
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
                if let Some(mut old) = servers.remove(id) {
                    terminate_managed_server(&mut old);
                }
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
    let group = crate::cli_interface::ProcessGroup::attach(&child);
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
            if let Some(group) = &group {
                group.kill();
            }
            return Err(CoreError::Runtime(format!(
                "Notion MCP 서버가 바로 종료되었습니다 (종료 코드 {}). 토큰과 Node.js 설치를 확인해 주세요",
                status.code().unwrap_or(-1)
            )));
        }
        if Instant::now() >= deadline {
            if let Some(group) = &group {
                group.kill();
            }
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
            group,
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
    fn proxy_headers_insert_only_valid_values() {
        let mut headers = HeaderMap::new();

        insert_valid_header(&mut headers, CONTENT_TYPE, Some("application/json"));
        insert_valid_header(&mut headers, AUTHORIZATION, Some("invalid\nvalue"));
        insert_valid_header(&mut headers, "mcp-session-id", None);

        assert_eq!(headers.get(CONTENT_TYPE).unwrap(), "application/json");
        assert!(!headers.contains_key(AUTHORIZATION));
        assert!(!headers.contains_key("mcp-session-id"));
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
            .register(ExternalPluginManifestRequest {
                id: "notion".to_owned(),
                display_name: "Notion".to_owned(),
                names: None,
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

    fn manifest(id: &str, names: Option<Vec<&str>>) -> ExternalPluginManifestRequest {
        ExternalPluginManifestRequest {
            id: id.to_owned(),
            display_name: id.to_owned(),
            names: names.map(|list| list.iter().map(|n| (*n).to_owned()).collect()),
            url: Some("http://127.0.0.1:1/mcp".to_owned()),
            auth: PluginAuthKind::None,
            token: None,
            client_id: None,
            client_secret: None,
            scope: None,
        }
    }

    // 9.12: 어떤 말이 플러그인을 가리키는지는 플러그인마다 저장된 이름 목록이 말한다.
    #[test]
    fn plugin_names_are_seeded_on_register_kept_on_silent_edit_and_replaced_when_sent() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        // 이름 없이 등록하면 id 의 브랜드로 씨앗이 채워진다.
        let view = registry
            .register(manifest("notion-team", None))
            .expect("register");
        assert_eq!(view.names, vec!["노션"]);
        // 편집에서 목록을 안 보내면 그대로다.
        let mut silent = manifest("notion-team", None);
        silent.display_name = "Notion (team)".to_owned();
        let view = registry.update(silent).expect("update");
        assert_eq!(view.names, vec!["노션"]);
        // 보내면 그것으로 바뀐다 — 공백·중복은 다듬고, 비우면 비운 대로 남는다.
        let view = registry
            .update(manifest(
                "notion-team",
                Some(vec![" 노션 ", "Notion", "노션", ""]),
            ))
            .expect("update names");
        assert_eq!(view.names, vec!["노션", "Notion"]);
        let view = registry
            .update(manifest("notion-team", Some(vec![])))
            .expect("clear");
        assert!(
            view.names.is_empty(),
            "사용자가 비운 목록은 다시 채우지 않는다"
        );
        assert_eq!(
            registry.attachable_names().expect("names"),
            vec![("notion-team".to_owned(), Vec::<String>::new())]
        );
        // 아홉 개는 거절한다.
        let too_many: Vec<String> = (0..9).map(|i| format!("x{i}")).collect();
        let error = registry
            .update(manifest(
                "notion-team",
                Some(too_many.iter().map(String::as_str).collect()),
            ))
            .expect_err("too many names");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    #[test]
    fn plugin_names_reject_control_characters_and_overlong_entries() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        let control = "노\u{7}션".to_owned();
        let error = registry
            .register(manifest("notion-a", Some(vec![control.as_str()])))
            .expect_err("control char");
        assert!(matches!(error, CoreError::InvalidInput(_)), "{error}");
        let long = "가".repeat(81);
        let error = registry
            .register(manifest("notion-b", Some(vec![long.as_str()])))
            .expect_err("too long");
        assert!(matches!(error, CoreError::InvalidInput(_)), "{error}");
        // 거절된 등록은 아무것도 남기지 않는다.
        assert!(registry.attachable_names().expect("names").is_empty());
        // 80자는 받는다.
        let ok = "가".repeat(80);
        let view = registry
            .register(manifest("notion-c", Some(vec![ok.as_str()])))
            .expect("80 chars");
        assert_eq!(view.names, vec![ok]);
    }

    #[test]
    fn plugin_records_without_names_get_seeded_once_when_the_store_is_read() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        registry
            .register(manifest("github-main", None))
            .expect("register");
        // 9.12 이전 파일처럼 names 를 지운다.
        let path = directory.path().join("external-plugins.json");
        let text = std::fs::read_to_string(&path).expect("store");
        let mut store: serde_json::Value = serde_json::from_str(&text).expect("json");
        store["plugins"][0]
            .as_object_mut()
            .expect("plugin")
            .remove("names");
        std::fs::write(&path, serde_json::to_string(&store).expect("json")).expect("write");
        let names = registry.attachable_names().expect("names");
        assert_eq!(
            names,
            vec![(
                "github-main".to_owned(),
                vec!["깃허브".to_owned(), "깃헙".to_owned()]
            )]
        );
        // 저장까지 됐으므로 다시 읽어도 씨앗을 또 심지 않는다.
        let text = std::fs::read_to_string(&path).expect("store");
        assert!(text.contains("\"names\""), "{text}");
    }

    fn metadata(authorization_endpoint: &str) -> OAuthServerMetadata {
        OAuthServerMetadata {
            authorization_endpoint: authorization_endpoint.to_owned(),
            token_endpoint: "https://example.com/token".to_owned(),
            registration_endpoint: None,
            device_authorization_endpoint: None,
            resource: "https://example.com/mcp".to_owned(),
            scope: None,
        }
    }

    #[test]
    fn authorization_url_asks_google_for_a_refresh_token() {
        let common = build_authorization_url(
            &metadata("https://example.com/authorize"),
            "client",
            "http://127.0.0.1:1/callback",
            "challenge",
            "state",
            None,
        )
        .expect("authorize 주소");
        let query = common.query().unwrap_or_default();
        assert!(!query.contains("access_type"), "{query}");
        assert!(!query.contains("scope="), "{query}");

        let google = build_authorization_url(
            &metadata("https://accounts.google.com/o/oauth2/v2/auth"),
            "client",
            "http://127.0.0.1:1/callback",
            "challenge",
            "state",
            Some("openid email"),
        )
        .expect("authorize 주소");
        let query = google.query().unwrap_or_default();
        assert!(query.contains("access_type=offline"), "{query}");
        assert!(query.contains("prompt=consent"), "{query}");
        assert!(query.contains("scope=openid+email"), "{query}");
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
            names: None,
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
                grant_lost_at: None,
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
            names: None,
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
            .register(ExternalPluginManifestRequest {
                id: "notion".to_owned(),
                display_name: "Notion".to_owned(),
                names: None,
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
            .register(ExternalPluginManifestRequest {
                id: "notion".to_owned(),
                display_name: "Notion".to_owned(),
                names: None,
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
            .register(ExternalPluginManifestRequest {
                id: "open".to_owned(),
                display_name: "Open".to_owned(),
                names: None,
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
            names: None,
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
                grant_lost_at: None,
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
            .update(ExternalPluginManifestRequest {
                id: "notion".to_owned(),
                display_name: "Notion 팀".to_owned(),
                names: None,
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
            .register(ExternalPluginManifestRequest {
                id: "local".to_owned(),
                display_name: "Local dev".to_owned(),
                names: None,
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
            .update(ExternalPluginManifestRequest {
                id: "local".to_owned(),
                display_name: "Local dev".to_owned(),
                names: None,
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
            names: None,
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
            .update(ExternalPluginManifestRequest {
                id: "api".to_owned(),
                display_name: "API".to_owned(),
                names: None,
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
        let missing = registry.update(ExternalPluginManifestRequest {
            id: "ghost".to_owned(),
            display_name: "Ghost".to_owned(),
            names: None,
            url: Some("http://127.0.0.1:3000/mcp".to_owned()),
            auth: PluginAuthKind::None,
            token: None,
            client_id: None,
            client_secret: None,
            scope: None,
        });
        assert!(matches!(missing, Err(CoreError::NotFound(_))));
        // 등록과 같은 규칙: 인증 방식에 맞지 않는 필드는 저장소를 건드리기 전에 거절된다.
        let token_refused = registry.update(ExternalPluginManifestRequest {
            id: "ghost".to_owned(),
            display_name: "Ghost".to_owned(),
            names: None,
            url: Some("http://127.0.0.1:3000/mcp".to_owned()),
            auth: PluginAuthKind::OAuth,
            token: Some("x".to_owned()),
            client_id: None,
            client_secret: None,
            scope: None,
        });
        assert!(matches!(token_refused, Err(CoreError::InvalidInput(_))));
        let url_refused = registry.update(ExternalPluginManifestRequest {
            id: "ghost".to_owned(),
            display_name: "Ghost".to_owned(),
            names: None,
            url: Some("https://example.com".to_owned()),
            auth: PluginAuthKind::NotionToken,
            token: Some("ntn_x".to_owned()),
            client_id: None,
            client_secret: None,
            scope: None,
        });
        assert!(matches!(url_refused, Err(CoreError::InvalidInput(_))));
        let client_id_refused = registry.update(ExternalPluginManifestRequest {
            id: "ghost".to_owned(),
            display_name: "Ghost".to_owned(),
            names: None,
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
            .register(ExternalPluginManifestRequest {
                id: "local".to_owned(),
                display_name: " Local dev ".to_owned(),
                names: None,
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
        let duplicate = registry.register(ExternalPluginManifestRequest {
            id: "local".to_owned(),
            display_name: "Again".to_owned(),
            names: None,
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
            .register(ExternalPluginManifestRequest {
                id: "google-drive".to_owned(),
                display_name: "Google Drive".to_owned(),
                names: None,
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
            validate_mcp_endpoint(preset.url).expect("preset url");
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
            .register(ExternalPluginManifestRequest {
                id: "github".to_owned(),
                display_name: "GitHub".to_owned(),
                names: None,
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
            .register(ExternalPluginManifestRequest {
                id: "github".to_owned(),
                display_name: "GitHub".to_owned(),
                names: None,
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

    /// 2026-10-11. 콜백형 OAuth는 승인 뒤 브라우저가 멈춘 콜백 주소를 붙여 넣어 끝낸다.
    /// 대조에 실패한 붙여넣기는 흐름을 건드리지 않아 다시 붙여 넣을 수 있고, 그 흐름이
    /// 등록한 redirect 주소·state와 맞는 code만 대기 스레드로 건너간다.
    #[test]
    fn pasted_callback_reaches_only_the_matching_pending_flow() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        registry
            .register(ExternalPluginManifestRequest {
                id: "pasted".to_owned(),
                display_name: "Pasted callback".to_owned(),
                names: None,
                url: Some("http://127.0.0.1:1/mcp".to_owned()),
                auth: PluginAuthKind::OAuth,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect("callback plugin");
        let matching = "http://127.0.0.1:43123/callback?code=the-code&state=s1";

        let idle = registry
            .submit_oauth_callback("pasted", matching)
            .expect_err("진행 중인 흐름이 없으면 받을 자리가 없다");
        assert!(matches!(idle, CoreError::Conflict(_)), "{idle:?}");

        let paste = Arc::new(CallbackPaste {
            redirect_uri: "http://127.0.0.1:43123/callback".to_owned(),
            state: "s1".to_owned(),
            code: Mutex::new(None),
        });
        let cancel = register_pending_oauth("pasted", now_ms() + 60_000, Some(Arc::clone(&paste)));

        for wrong in [
            "",
            "code=the-code&state=s1",
            "http://127.0.0.1:43124/callback?code=the-code&state=s1",
            "http://127.0.0.1:43123/other?code=the-code&state=s1",
            "http://example.com:43123/callback?code=the-code&state=s1",
            "https://127.0.0.1:43123/callback?code=the-code&state=s1",
            "http://127.0.0.1:43123/callback?code=the-code&state=other",
            "http://127.0.0.1:43123/callback?code=the-code",
            "http://127.0.0.1:43123/callback?state=s1",
            "http://127.0.0.1:43123/callback?error=access_denied&state=s1",
        ] {
            registry
                .submit_oauth_callback("pasted", wrong)
                .expect_err(wrong);
        }
        assert!(paste.code.lock().expect("slot").is_none());
        assert!(!cancel.load(std::sync::atomic::Ordering::SeqCst));

        // 브라우저는 127.0.0.1을 localhost로 보여 주기도 하고, 복사하면 공백이 묻는다.
        let view = registry
            .submit_oauth_callback(
                "pasted",
                "  http://localhost:43123/callback?code=the-code&state=s1\n",
            )
            .expect("맞는 주소는 받는다");
        assert!(view.oauth_pending);
        assert_eq!(
            paste.code.lock().expect("slot").as_deref(),
            Some("the-code")
        );
        registry
            .submit_oauth_callback("pasted", matching)
            .expect_err("한 흐름의 code는 한 번만 받는다");

        cancel_pending_oauth("pasted");
        registry
            .submit_oauth_callback("pasted", matching)
            .expect_err("취소된 흐름에는 넘기지 않는다");
    }

    /// 붙여 넣은 code는 loopback 요청이 오지 않아도 대기 루프를 끝낸다.
    #[test]
    fn callback_wait_ends_with_a_pasted_code() {
        let listener =
            TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).expect("listener");
        let paste = CallbackPaste {
            redirect_uri: "http://127.0.0.1:1/callback".to_owned(),
            state: "s1".to_owned(),
            code: Mutex::new(Some("pasted-code".to_owned())),
        };
        let cancel = AtomicBool::new(false);
        let code = wait_for_callback(&listener, "s1", &paste, &cancel).expect("pasted code");
        assert_eq!(code, "pasted-code");
    }

    #[test]
    fn denied_tools_are_hidden_from_the_list_and_refused_on_call() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        registry
            .register(ExternalPluginManifestRequest {
                id: "notion".to_owned(),
                display_name: "Notion".to_owned(),
                names: None,
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
        assert!(ProxyIntent::of(&list_body).lists_tools);
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
        let filtered = hide_unexposed_tools(
            upstream,
            &ProxyIntent::of(&list_body),
            &policies,
            ProxyCaller::Agent(ProviderId::Claude),
        );
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
            ProxyIntent::of(&call_body).calls,
            vec!["notion-create-pages".to_owned()]
        );
        let refusal = denied_tool_response(&call_body, "notion-create-pages");
        let payload: Value = serde_json::from_slice(&refusal.body).expect("json");
        assert_eq!(payload["id"], json!(3));
        assert_eq!(payload["result"]["isError"], json!(true));
    }

    /// 배치 안의 호출은 첫 이름만이 아니라 전부 모은다. 허용된 호출 뒤에 제한한 호출을 붙여
    /// 제한을 피하지 못하게 한다.
    #[test]
    fn proxy_intent_collects_every_call_in_a_batch() {
        let body = json!([
            {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "notion-search"}},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "notion-create-pages"}},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/list"}
        ])
        .to_string()
        .into_bytes();
        let intent = ProxyIntent::of(&body);
        assert!(intent.lists_tools);
        assert_eq!(
            intent.calls,
            vec!["notion-search".to_owned(), "notion-create-pages".to_owned()]
        );
    }

    /// P12. 승인 통로가 없는 Antigravity 경로에는 확인(기본값) 도구 중 상류가 읽기 전용이라고
    /// 밝힌 것만 보이고, 허용한 쓰기 도구는 보이며, 제한은 누구에게도 보이지 않는다. 승인할 수
    /// 있는 쪽과 앱 내부 경로는 지금까지와 같다.
    #[test]
    fn p12_unconfirmable_callers_see_only_read_only_or_allowed_tools() {
        let policies = BTreeMap::from([
            ("notion-update-page".to_owned(), PluginToolPolicy::Allow),
            ("notion-move-pages".to_owned(), PluginToolPolicy::Deny),
        ]);
        let list_body = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
            .to_string()
            .into_bytes();
        let upstream = || ProxyResponse {
            status: 200,
            content_type: Some("application/json".to_owned()),
            session_id: None,
            body: json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {"tools": [
                    {"name": "notion-search", "annotations": {"readOnlyHint": true}},
                    {"name": "notion-create-pages", "annotations": {"readOnlyHint": false}},
                    {"name": "notion-fetch"},
                    {"name": "notion-update-page"},
                    {"name": "notion-move-pages", "annotations": {"readOnlyHint": true}}
                ]}
            })
            .to_string()
            .into_bytes(),
        };
        let names = |caller| -> Vec<String> {
            let filtered =
                hide_unexposed_tools(upstream(), &ProxyIntent::of(&list_body), &policies, caller);
            let payload: Value = serde_json::from_slice(&filtered.body).expect("json");
            payload["result"]["tools"]
                .as_array()
                .expect("tools")
                .iter()
                .map(|tool| tool["name"].as_str().expect("name").to_owned())
                .collect()
        };
        assert_eq!(
            names(ProxyCaller::Agent(ProviderId::Antigravity)),
            vec!["notion-search".to_owned(), "notion-update-page".to_owned()]
        );
        let full = vec![
            "notion-search".to_owned(),
            "notion-create-pages".to_owned(),
            "notion-fetch".to_owned(),
            "notion-update-page".to_owned(),
        ];
        for caller in [
            ProxyCaller::Internal,
            ProxyCaller::Agent(ProviderId::Claude),
            ProxyCaller::Agent(ProviderId::Codex),
            ProxyCaller::Agent(ProviderId::Local),
        ] {
            assert_eq!(names(caller), full, "{caller:?}");
        }
    }

    /// P12. 호출 자리에서도 같은 판정이다. 승인 통로가 없는 쪽의 쓰기 호출은 상류의 현재
    /// `tools/list`만 읽고 넘기지 않으며, 읽기 전용 호출은 넘긴다. 승인할 수 있는 쪽은 미리
    /// 읽지 않고 그대로 넘긴다.
    #[test]
    fn p12_unconfirmable_callers_cannot_call_ask_write_tools() {
        use std::net::TcpListener as MockListener;
        let listener = MockListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let recorder = Arc::clone(&seen);
        let server = thread::spawn(move || {
            for _ in 0..5 {
                let (mut stream, _) = listener.accept().expect("accept");
                let body = read_mock_body(&mut stream);
                let payload: Value = serde_json::from_slice(&body).expect("json");
                let method = payload["method"].as_str().expect("method").to_owned();
                let result = match method.as_str() {
                    "tools/list" => json!({"tools": [
                        {"name": "search", "annotations": {"readOnlyHint": true}},
                        {"name": "create", "annotations": {"readOnlyHint": false}}
                    ]}),
                    _ => json!({"content": [{"type": "text", "text": "done"}], "isError": false}),
                };
                recorder.lock().expect("seen").push(method);
                let response =
                    json!({"jsonrpc": "2.0", "id": payload["id"], "result": result}).to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                )
                .expect("write");
            }
        });
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        registry
            .register(ExternalPluginManifestRequest {
                id: "mock".to_owned(),
                display_name: "Mock".to_owned(),
                names: None,
                url: Some(format!("http://{address}/mcp")),
                auth: PluginAuthKind::None,
                token: None,
                client_id: None,
                client_secret: None,
                scope: None,
            })
            .expect("register");
        let call = |tool: &str| {
            ProxyRequest {
            method: reqwest::Method::POST,
            content_type: Some("application/json".to_owned()),
            accept: None,
            session_id: Some("session-1".to_owned()),
            protocol_version: None,
            body: json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": tool, "arguments": {}}})
                .to_string()
                .into_bytes(),
        }
        };
        let is_error = |response: ProxyResponse| -> bool {
            let payload: Value = serde_json::from_slice(&response.body).expect("json");
            payload["result"]["isError"].as_bool().unwrap_or(false)
        };
        let antigravity = ProxyCaller::Agent(ProviderId::Antigravity);
        let refused = registry
            .proxy("mock", antigravity, call("create"))
            .expect("refused");
        assert!(is_error(refused));
        assert_eq!(*seen.lock().expect("seen"), vec!["tools/list".to_owned()]);
        let allowed = registry
            .proxy("mock", antigravity, call("search"))
            .expect("search");
        assert!(!is_error(allowed));
        // 배치에 읽기 호출을 앞세워도 뒤의 쓰기 호출이 막힌다.
        let batch = ProxyRequest {
            body: json!([
                {"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "search", "arguments": {}}},
                {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "create", "arguments": {}}}
            ])
            .to_string()
            .into_bytes(),
            ..call("search")
        };
        let refused = registry.proxy("mock", antigravity, batch).expect("batch");
        assert!(String::from_utf8_lossy(&refused.body).contains("'create'"));
        // 읽지 못한 본문은 상류에 닿기 전에 막힌다.
        let garbled = ProxyRequest {
            body: b"\xef\xbb\xbf{}".to_vec(),
            ..call("search")
        };
        assert_eq!(
            registry
                .proxy("mock", antigravity, garbled)
                .expect("garbled")
                .status,
            400
        );
        let claude = registry
            .proxy(
                "mock",
                ProxyCaller::Agent(ProviderId::Claude),
                call("create"),
            )
            .expect("claude");
        assert!(!is_error(claude));
        server.join().expect("server");
        assert_eq!(
            *seen.lock().expect("seen"),
            vec![
                "tools/list".to_owned(),
                "tools/list".to_owned(),
                "tools/call".to_owned(),
                "tools/list".to_owned(),
                "tools/call".to_owned(),
            ]
        );
    }

    fn read_mock_body(stream: &mut TcpStream) -> Vec<u8> {
        let mut bytes = Vec::new();
        let header_end = loop {
            let mut chunk = [0_u8; 1024];
            let read = stream.read(&mut chunk).expect("read");
            assert!(read > 0, "request ended before headers");
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = String::from_utf8_lossy(&bytes[..header_end]).to_ascii_lowercase();
        let length = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .map(|value| value.trim().parse::<usize>().expect("length"))
            .unwrap_or(0);
        while bytes.len() < header_end + length {
            let mut chunk = [0_u8; 1024];
            let read = stream.read(&mut chunk).expect("read");
            assert!(read > 0, "request ended before body");
            bytes.extend_from_slice(&chunk[..read]);
        }
        bytes[header_end..header_end + length].to_vec()
    }

    #[test]
    fn p12_plugin_proxy_url_carries_the_agent_segment() {
        assert_eq!(
            plugin_proxy_url(
                "http://127.0.0.1:4179/plugins/key",
                ProviderId::Antigravity,
                "github"
            ),
            "http://127.0.0.1:4179/plugins/key/antigravity/github"
        );
    }

    #[test]
    fn p12_reads_the_rpc_result_from_json_and_event_streams() {
        let tools = json!({"tools": [{"name": "a"}]});
        let json_body = ProxyResponse {
            status: 200,
            content_type: Some("application/json".to_owned()),
            session_id: None,
            body: json!({"jsonrpc": "2.0", "id": 1, "result": tools})
                .to_string()
                .into_bytes(),
        };
        assert_eq!(rpc_result(&json_body), Some(tools.clone()));
        let stream_body = ProxyResponse {
            content_type: Some("text/event-stream".to_owned()),
            body: format!(
                "event: message\ndata: {}\n\n",
                json!({"jsonrpc": "2.0", "id": 1, "result": tools})
            )
            .into_bytes(),
            ..json_body
        };
        assert_eq!(rpc_result(&stream_body), Some(tools));
    }

    #[test]
    fn all_tool_policies_change_in_one_store_update() {
        let directory = tempfile::tempdir().expect("tempdir");
        let registry = ExternalPluginRegistry::new(directory.path().to_path_buf());
        registry
            .register(ExternalPluginManifestRequest {
                id: "notion".to_owned(),
                display_name: "Notion".to_owned(),
                names: None,
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
    fn lost_grant_turns_credential_ready_off_until_reauthorized() {
        let mut record = new_manual_oauth_record("client".to_owned());
        record.authorized_at = Some(3);
        let mut plugin = StoredPlugin {
            id: "notion".to_owned(),
            display_name: "Notion".to_owned(),
            names: None,
            url: Some(NOTION_HOSTED_MCP_URL.to_owned()),
            auth: PluginAuthKind::OAuth,
            enabled: true,
            scope: None,
            tool_policies: BTreeMap::new(),
            created_at: 1,
            updated_at: 1,
            secret_stored_at: Some(2),
            oauth: Some(record),
            server_name: None,
            tools: Vec::new(),
            last_verified_at: None,
            last_error: None,
        };
        assert!(credential_ready(&plugin));
        plugin.oauth.as_mut().unwrap().grant_lost_at = Some(5);
        assert!(
            !credential_ready(&plugin),
            "거절된 grant로는 새 채팅에 붙지 않는다"
        );
        assert!(!plugin_view(&plugin, false).attachable);
        // 재인증 기록은 인증 서버 메타데이터를 새로 받아 쓰되 grant 유실 표시는 이어받는다.
        // 토큰 저장(store_oauth_tokens)만이 이 표시를 지운다.
        plugin.oauth.as_mut().unwrap().grant_lost_at = None;
        assert!(credential_ready(&plugin));
    }

    #[test]
    fn token_rejection_is_unrecoverable_only_for_grant_errors() {
        let invalid_grant = json!({"error": "invalid_grant", "error_description": "revoked"});
        let rejected = classify_token_rejection(StatusCode::BAD_REQUEST, &invalid_grant);
        assert!(rejected.unrecoverable);
        assert!(rejected.message.contains("HTTP 400"));
        assert!(rejected.message.contains("revoked"));

        let server_error = json!({"error": "server_error"});
        assert!(!classify_token_rejection(StatusCode::BAD_GATEWAY, &server_error).unrecoverable);

        // 같은 코드라도 5xx는 서버 쪽 문제로 보고 다음 요청에서 다시 시도한다.
        assert!(
            !classify_token_rejection(StatusCode::INTERNAL_SERVER_ERROR, &invalid_grant)
                .unrecoverable
        );

        let rate_limited = json!({"error": "temporarily_unavailable"});
        assert!(
            !classify_token_rejection(StatusCode::TOO_MANY_REQUESTS, &rate_limited).unrecoverable
        );
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

    #[test]
    fn managed_server_termination_kills_process_group_descendants() {
        let directory = tempfile::tempdir().expect("tempdir");
        let pid_file = directory.path().join("grandchild.pid");
        #[cfg(unix)]
        let mut command = {
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new("sh");
            cmd.args([
                "-c",
                &format!("sleep 30 & echo $! > '{}'; wait", pid_file.display()),
            ]);
            cmd.process_group(0);
            cmd
        };
        #[cfg(windows)]
        let mut command = {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "timeout /T 30"]);
            cmd
        };
        #[cfg(not(any(unix, windows)))]
        let mut command = Command::new("sleep");

        let child = command.spawn().expect("spawn test process");
        let group = crate::cli_interface::ProcessGroup::attach(&child);

        #[cfg(unix)]
        let grandchild: u32 = {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut pid = None;
            while Instant::now() < deadline {
                if let Ok(content) = std::fs::read_to_string(&pid_file) {
                    if let Ok(parsed) = content.trim().parse::<u32>() {
                        pid = Some(parsed);
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            pid.expect("grandchild pid must be written")
        };

        let mut server = ManagedServer {
            child,
            group,
            port: 0,
            auth_token: "test".to_owned(),
        };

        terminate_managed_server(&mut server);
        assert!(server.child.try_wait().expect("try_wait").is_some());

        #[cfg(unix)]
        {
            let deadline = Instant::now() + Duration::from_secs(5);
            while is_process_running(grandchild) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            assert!(
                !is_process_running(grandchild),
                "손자 프로세스(PID {grandchild})가 그룹 종료로 함께 정리되어야 한다"
            );
        }
    }

    #[cfg(unix)]
    fn is_process_running(pid: u32) -> bool {
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            return stat
                .rsplit_once(')')
                .map(|(_, after)| !after.trim_start().starts_with('Z'))
                .unwrap_or(true);
        }
        crate::process_signal::pid_exists(pid).unwrap_or(false)
    }

    #[test]
    fn stop_managed_server_removes_and_terminates() {
        #[cfg(unix)]
        let mut command = {
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new("sh");
            cmd.args(["-c", "sleep 30"]);
            cmd.process_group(0);
            cmd
        };
        #[cfg(windows)]
        let mut command = {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "timeout /T 30"]);
            cmd
        };
        #[cfg(not(any(unix, windows)))]
        let mut command = Command::new("sleep");

        let child = command.spawn().expect("spawn test process");
        let group = crate::cli_interface::ProcessGroup::attach(&child);
        let id = "test_managed_server_cleanup";
        {
            let mut servers = managed_servers().lock().expect("lock");
            servers.insert(
                id.to_owned(),
                ManagedServer {
                    child,
                    group,
                    port: 0,
                    auth_token: "test".to_owned(),
                },
            );
        }
        stop_managed_server(id);
        {
            let servers = managed_servers().lock().expect("lock");
            assert!(!servers.contains_key(id));
        }
    }
}
