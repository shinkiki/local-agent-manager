//! 공급자 CLI 업데이트의 공통 추상화.
//!
//! 공급자별로 다른 것은 `ProviderCliAdapter`(버전 명령, 자체 업데이트 서브커맨드,
//! 공식 npm 패키지, 모델 카탈로그 캐시 allowlist)뿐이고, 설치 출처 판별, 최신 버전
//! 조회, 업데이트 실행과 검증, 실행 중 런타임 종료, 캐시 정리 흐름은 모든 공급자가
//! 같은 코드를 쓴다.
//!
//! 실행 규칙
//! - 셸 문자열을 만들지 않는다. 해석된 실행 파일 경로와 고정 argv만 사용한다.
//! - 사용자 입력은 명령에 들어가지 않는다. 패키지/토큰 이름은 실제 설치 경로에서
//!   구조적으로 유도한 뒤 형식을 검증하고, 패키지 관리자에게 설치 사실을 재확인한다.
//! - 모든 외부 실행은 제한시간과 출력 크기 상한을 가진다.

use std::cmp::Ordering;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat::{ChatPhase, ChatSupervisor};
use crate::cli_interface::{run_capped, CommandOutcome};
use crate::domain::ProviderId;
use crate::external_processes::{
    list_external_provider_processes, terminate_external_provider_processes,
};
use crate::providers::{detect_provider_cli, provider_display_name, resolve_named_executable};
use crate::terminal::TerminalSupervisor;
use crate::text_limit;
use crate::user_home;
use crate::CoreError;

const VERSION_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const METADATA_COMMAND_TIMEOUT: Duration = Duration::from_secs(180);
const UPDATE_COMMAND_TIMEOUT: Duration = Duration::from_secs(900);
const MAX_REPORTED_OUTPUT_CHARS: usize = 1_500;
const MAX_MODEL_CACHE_BYTES: u64 = 32 * 1024 * 1024;

/// 실행 파일을 못 찾았을 때의 미지원 사유. 상태 초기값·업데이트 계획·업데이트 실행이
/// 같은 문구를 사용자에게 보여야 하므로 한 곳에 둔다.
const NO_EXECUTABLE_REASON: &str = "CLI 실행 파일을 찾지 못했습니다";
/// 미지원 사유가 비어 있을 때 대신 쓰는 기본 문구.
const UNKNOWN_SOURCE_REASON: &str = "설치 출처를 확인하지 못했습니다";

// ---------------------------------------------------------------------------
// 공급자 어댑터
// ---------------------------------------------------------------------------

struct SelfUpdateSpec {
    /// 공급자 CLI가 공식 문서와 `--help`로 노출하는 업데이트 서브커맨드. 고정 argv다.
    args: &'static [&'static str],
}

/// 삭제를 허용하는 캐시 파일 allowlist 항목.
///
/// 버전에 종속된 "모델 카탈로그 캐시" 파일 하나만 등록한다. 인증(auth.json,
/// .credentials.json), 설정(config.toml, settings.json), 세션·대화 이력, 계정,
/// 플러그인, 스킬, 로그는 어떤 공급자에서도 등록하지 않는다.
struct ModelCacheSpec {
    id: &'static str,
    label: &'static str,
    /// 캐시 루트를 재지정하는 공급자 환경변수. 없으면 홈 상대 경로만 쓴다.
    home_env: Option<&'static str>,
    home_relative: &'static str,
    file_name: &'static str,
    /// 캐시를 기록한 클라이언트 버전이 들어 있는 최상위 JSON 필드.
    version_field: &'static str,
}

struct ProviderCliAdapter {
    provider: ProviderId,
    version_args: &'static [&'static str],
    self_update: Option<SelfUpdateSpec>,
    manual_update_hint: &'static str,
    model_caches: &'static [ModelCacheSpec],
    /// 등록된 캐시가 없을 때 UI에 그대로 노출하는 근거.
    no_model_cache_reason: &'static str,
}

const ADAPTERS: &[ProviderCliAdapter] = &[
    ProviderCliAdapter {
        provider: ProviderId::Claude,
        version_args: &["--version"],
        self_update: Some(SelfUpdateSpec {
            args: &["update"],
        }),
        manual_update_hint: "Claude Code는 설치 방식에 따라 `claude update`, `npm install -g @anthropic-ai/claude-code@latest`, 또는 공식 설치 스크립트로 업데이트합니다.",
        model_caches: &[],
        no_model_cache_reason: "Claude Code는 버전에 종속된 로컬 모델 카탈로그 캐시 파일을 두지 않아 정리 대상이 없습니다. ~/.claude 아래 인증·설정·세션·플러그인·스킬 파일은 정리 대상에서 제외합니다.",
    },
    ProviderCliAdapter {
        provider: ProviderId::Codex,
        version_args: &["--version"],
        self_update: Some(SelfUpdateSpec {
            args: &["update"],
        }),
        manual_update_hint: "Codex는 설치 방식에 따라 `brew upgrade --cask codex`, `npm install -g @openai/codex@latest`, 또는 `codex update`로 업데이트합니다.",
        model_caches: &[ModelCacheSpec {
            id: "codex-models-cache",
            label: "Codex 모델 카탈로그 캐시",
            home_env: Some("CODEX_HOME"),
            home_relative: ".codex",
            file_name: "models_cache.json",
            version_field: "client_version",
        }],
        no_model_cache_reason: "",
    },
    ProviderCliAdapter {
        provider: ProviderId::Antigravity,
        version_args: &["--version"],
        self_update: Some(SelfUpdateSpec {
            args: &["update"],
        }),
        manual_update_hint: "Antigravity CLI는 `agy update` 또는 공식 설치 방법으로 업데이트합니다.",
        model_caches: &[],
        no_model_cache_reason: "Antigravity CLI에서 버전에 종속된 모델 카탈로그 캐시 파일을 확인하지 못했습니다. ~/.gemini/antigravity-cli 아래 대화 이력·설정·로그는 정리 대상에서 제외합니다.",
    },
];

fn adapter(provider: ProviderId) -> &'static ProviderCliAdapter {
    ADAPTERS
        .iter()
        .find(|adapter| adapter.provider == provider)
        .expect("모든 ProviderId는 CLI 업데이트 어댑터를 가진다")
}

// ---------------------------------------------------------------------------
// 응답 타입
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CliInstallSource {
    HomebrewCask,
    HomebrewFormula,
    NpmGlobal,
    /// 패키지 관리자 밖에 놓인 공식 단독 설치본.
    Standalone,
    NotDetected,
}

impl CliInstallSource {
    pub const ALL: [Self; 5] = [
        Self::HomebrewCask,
        Self::HomebrewFormula,
        Self::NpmGlobal,
        Self::Standalone,
        Self::NotDetected,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::HomebrewCask => "homebrewCask",
            Self::HomebrewFormula => "homebrewFormula",
            Self::NpmGlobal => "npmGlobal",
            Self::Standalone => "standalone",
            Self::NotDetected => "notDetected",
        }
    }

    /// 설치 출처가 감지되었는지 여부.
    pub fn is_detected(self) -> bool {
        self != Self::NotDetected
    }
}

impl std::fmt::Display for CliInstallSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for CliInstallSource {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "homebrewCask" => Ok(Self::HomebrewCask),
            "homebrewFormula" => Ok(Self::HomebrewFormula),
            "npmGlobal" => Ok(Self::NpmGlobal),
            "standalone" => Ok(Self::Standalone),
            "notDetected" => Ok(Self::NotDetected),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 CLI 설치 출처입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CliUpdateMethod {
    HomebrewCask,
    HomebrewFormula,
    NpmGlobal,
    /// 공급자 CLI가 제공하는 공식 업데이트 서브커맨드.
    SelfUpdate,
    Unsupported,
}

impl CliUpdateMethod {
    pub const ALL: [Self; 5] = [
        Self::HomebrewCask,
        Self::HomebrewFormula,
        Self::NpmGlobal,
        Self::SelfUpdate,
        Self::Unsupported,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::HomebrewCask => "homebrewCask",
            Self::HomebrewFormula => "homebrewFormula",
            Self::NpmGlobal => "npmGlobal",
            Self::SelfUpdate => "selfUpdate",
            Self::Unsupported => "unsupported",
        }
    }

    /// 업데이트 실행을 지원하는지 여부.
    pub fn is_update_supported(self) -> bool {
        self != Self::Unsupported
    }

    /// 최신 버전 별도 조회를 지원하는지 여부.
    pub fn is_check_supported(self) -> bool {
        matches!(
            self,
            Self::HomebrewCask | Self::HomebrewFormula | Self::NpmGlobal
        )
    }
}

impl std::fmt::Display for CliUpdateMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for CliUpdateMethod {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "homebrewCask" => Ok(Self::HomebrewCask),
            "homebrewFormula" => Ok(Self::HomebrewFormula),
            "npmGlobal" => Ok(Self::NpmGlobal),
            "selfUpdate" => Ok(Self::SelfUpdate),
            "unsupported" => Ok(Self::Unsupported),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 CLI 업데이트 방식입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelCacheState {
    /// 캐시 파일이 없다. 다음 실행에서 CLI가 다시 만든다.
    Absent,
    /// 캐시를 기록한 클라이언트 버전과 실행 버전이 같다.
    Matched,
    /// 캐시를 기록한 클라이언트 버전이 실행 버전보다 높다. 실행 CLI가 모르는 스키마로
    /// 기록되었을 수 있으므로 정리 대상이다.
    Mismatched,
    /// 캐시를 기록한 클라이언트 버전이 실행 버전보다 낮다. 같은 홈을 쓰는 옛 클라이언트가
    /// 남긴 기록이며, 실행 CLI가 다음 카탈로그 조회에서 자기 버전으로 다시 기록한다.
    /// 지워도 곧 같은 상태로 돌아오므로 정리 대상이 아니다.
    Outdated,
    /// 파일을 읽거나 해석할 수 없어 버전을 확인하지 못했다.
    Unreadable,
    /// 실행 버전을 몰라 비교할 수 없다.
    Unknown,
}

impl ModelCacheState {
    pub const ALL: [Self; 6] = [
        Self::Absent,
        Self::Matched,
        Self::Mismatched,
        Self::Outdated,
        Self::Unreadable,
        Self::Unknown,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::Matched => "matched",
            Self::Mismatched => "mismatched",
            Self::Outdated => "outdated",
            Self::Unreadable => "unreadable",
            Self::Unknown => "unknown",
        }
    }

    /// 정리(삭제)가 허용되는 상태인지 여부. 실행 버전보다 높게 기록된 캐시와 해석할 수 없는 캐시만 정리 대상이다.
    pub fn is_cleanup_available(self) -> bool {
        matches!(self, Self::Mismatched | Self::Unreadable)
    }
}

impl std::fmt::Display for ModelCacheState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ModelCacheState {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "absent" => Ok(Self::Absent),
            "matched" => Ok(Self::Matched),
            "mismatched" => Ok(Self::Mismatched),
            "outdated" => Ok(Self::Outdated),
            "unreadable" => Ok(Self::Unreadable),
            "unknown" => Ok(Self::Unknown),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 모델 캐시 상태입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCacheStatus {
    pub id: String,
    pub label: String,
    pub path: String,
    pub state: ModelCacheState,
    pub cache_client_version: Option<String>,
    pub cli_version: Option<String>,
    pub error: Option<String>,
    /// 정리(삭제)가 허용되는 상태인지. 기록 버전이 실행 버전보다 높거나(불일치) 캐시를
    /// 해석할 수 없을 때만 참이다.
    pub cleanup_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCliUpdateStatus {
    pub provider: ProviderId,
    pub display_name: String,
    pub detected: bool,
    pub executable_path: Option<String>,
    pub current_version: Option<String>,
    pub version_error: Option<String>,
    pub install_source: CliInstallSource,
    pub package_name: Option<String>,
    pub update_method: CliUpdateMethod,
    pub update_supported: bool,
    pub unsupported_reason: Option<String>,
    pub update_command_label: Option<String>,
    pub manual_update_hint: String,
    /// 최신 버전 조회를 지원하는 설치 방식인지.
    pub check_supported: bool,
    /// 최신 버전 조회를 지원하지 않는 이유.
    pub check_unsupported_reason: Option<String>,
    pub checked: bool,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub check_error: Option<String>,
    pub model_caches: Vec<ModelCacheStatus>,
    /// 등록된 모델 캐시가 없을 때의 근거. 있으면 UI가 "자동 캐시 정리 미지원"을 표시한다.
    pub model_cache_unsupported_reason: Option<String>,
    pub model_cache_mismatch: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CliUpdateOutcome {
    Updated,
    AlreadyLatest,
    /// 업데이트 명령은 성공했지만 목표 버전 적용을 확인하지 못했다.
    VerificationFailed,
    Failed,
}

impl CliUpdateOutcome {
    pub const ALL: [Self; 4] = [
        Self::Updated,
        Self::AlreadyLatest,
        Self::VerificationFailed,
        Self::Failed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Updated => "updated",
            Self::AlreadyLatest => "alreadyLatest",
            Self::VerificationFailed => "verificationFailed",
            Self::Failed => "failed",
        }
    }

    /// 업데이트 실패 상태(실행 실패 또는 검증 실패)인지 여부.
    pub fn is_failure(self) -> bool {
        matches!(self, Self::Failed | Self::VerificationFailed)
    }
}

impl std::fmt::Display for CliUpdateOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for CliUpdateOutcome {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "updated" => Ok(Self::Updated),
            "alreadyLatest" => Ok(Self::AlreadyLatest),
            "verificationFailed" => Ok(Self::VerificationFailed),
            "failed" => Ok(Self::Failed),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 CLI 업데이트 결과입니다: {s}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeStopSummary {
    pub chat_requested_count: usize,
    pub chat_stopped_count: usize,
    pub chat_forced_count: usize,
    pub terminal_requested_count: usize,
    pub terminal_stopped_count: usize,
    pub terminal_forced_count: usize,
    pub external_requested_count: usize,
    pub external_terminated_count: usize,
    pub external_forced_count: usize,
    pub external_failed_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeCounts {
    pub provider: ProviderId,
    pub chat_count: usize,
    pub terminal_count: usize,
    pub external_process_count: usize,
}

impl ProviderRuntimeCounts {
    pub fn total(self) -> usize {
        self.chat_count + self.terminal_count + self.external_process_count
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateReceipt {
    pub provider: ProviderId,
    pub outcome: CliUpdateOutcome,
    pub method: CliUpdateMethod,
    pub command_label: String,
    pub previous_version: Option<String>,
    pub current_version: Option<String>,
    pub target_version: Option<String>,
    /// 목표 버전과 일치를 확인했는지. 확인하지 못하면 성공으로 보고하지 않는다.
    pub verified: bool,
    pub message: String,
    pub failure_output: Option<String>,
    pub stopped: ProviderRuntimeStopSummary,
    pub status: ProviderCliUpdateStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCacheCleanupEntry {
    pub id: String,
    pub label: String,
    pub path: String,
    pub removed: bool,
    pub previous_cache_client_version: Option<String>,
    pub skipped_reason: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCacheCleanupReceipt {
    pub provider: ProviderId,
    pub removed_count: usize,
    pub failed_count: usize,
    pub entries: Vec<ModelCacheCleanupEntry>,
    pub stopped: ProviderRuntimeStopSummary,
    pub status: ProviderCliUpdateStatus,
}

// ---------------------------------------------------------------------------
// 상태 조회
// ---------------------------------------------------------------------------

/// 네트워크 없이 확인 가능한 상태(실행 경로, 실행 버전, 설치 출처, 캐시 상태)를 모은다.
pub fn list_provider_cli_update_status(chats: &ChatSupervisor) -> Vec<ProviderCliUpdateStatus> {
    ADAPTERS
        .iter()
        .map(|adapter| resolve_status_and_settings_schema(chats, adapter, false))
        .collect()
}

pub fn provider_cli_update_status(
    chats: &ChatSupervisor,
    provider: ProviderId,
) -> ProviderCliUpdateStatus {
    resolve_status_and_settings_schema(chats, adapter(provider), false)
}

/// 패키지 관리자에 최신 버전을 물어 상태를 갱신한다. 네트워크를 사용한다.
pub fn check_provider_cli_update(
    chats: &ChatSupervisor,
    provider: ProviderId,
) -> Result<ProviderCliUpdateStatus, CoreError> {
    let mut status = resolve_status_and_settings_schema(chats, adapter(provider), false);
    apply_latest_version(&mut status);
    Ok(status)
}

/// CLI 정보를 새로 읽을 때마다 실제 인터페이스를 다시 조사해 채팅 실행설정 스키마를
/// 맞춘다. 실행 버전과 실행 파일 경로가 저장된 조사 기록과 같으면 chat 쪽에서 조사를
/// 건너뛰므로, 설정 화면을 열 때마다 `--help`를 실행하지는 않는다.
///
/// 조사 실패는 상태 조회를 실패시키지 않는다. 실패하면 저장된 기록이 그대로 남고,
/// 기록이 없으면 내장 스키마가 쓰인다.
fn resolve_status_and_settings_schema(
    chats: &ChatSupervisor,
    adapter: &ProviderCliAdapter,
    force: bool,
) -> ProviderCliUpdateStatus {
    let status = resolve_status(adapter);
    let _ = chats.refresh_discovered_chat_settings_schema(
        adapter.provider,
        status.executable_path.as_deref().map(Path::new),
        status.current_version.as_deref(),
        force,
    );
    status
}

fn resolve_status(adapter: &ProviderCliAdapter) -> ProviderCliUpdateStatus {
    let detection = detect_provider_cli(adapter.provider);
    let mut status = ProviderCliUpdateStatus {
        provider: adapter.provider,
        display_name: provider_display_name(adapter.provider).to_owned(),
        detected: false,
        executable_path: None,
        current_version: None,
        version_error: None,
        install_source: CliInstallSource::NotDetected,
        package_name: None,
        update_method: CliUpdateMethod::Unsupported,
        update_supported: false,
        unsupported_reason: Some(NO_EXECUTABLE_REASON.to_owned()),
        update_command_label: None,
        manual_update_hint: adapter.manual_update_hint.to_owned(),
        check_supported: false,
        check_unsupported_reason: Some(NO_EXECUTABLE_REASON.to_owned()),
        checked: false,
        latest_version: None,
        update_available: false,
        check_error: None,
        model_caches: Vec::new(),
        model_cache_unsupported_reason: (!adapter.no_model_cache_reason.is_empty())
            .then(|| adapter.no_model_cache_reason.to_owned()),
        model_cache_mismatch: false,
    };

    let executable = match detection {
        Ok(Some(path)) => path,
        Ok(None) => {
            apply_model_caches(&mut status, adapter);
            return status;
        }
        Err(error) => {
            status.version_error = Some(error.to_string());
            status.unsupported_reason = Some(error.to_string());
            return status;
        }
    };

    status.detected = true;
    status.executable_path = Some(executable.to_string_lossy().into_owned());
    match probe_cli_version(&executable, adapter.version_args) {
        Ok(version) => status.current_version = Some(version),
        Err(error) => status.version_error = Some(error.to_string()),
    }

    let plan = plan_update(adapter, &executable);
    status.install_source = plan.source;
    status.package_name = plan.package_name.clone();
    status.update_method = plan.method;
    status.update_supported = plan.method.is_update_supported();
    status.unsupported_reason = plan.unsupported_reason.clone();
    status.update_command_label = plan.command_label.clone();
    status.check_supported = plan.method.is_check_supported();
    status.check_unsupported_reason = if status.check_supported {
        None
    } else {
        Some(match plan.method {
            // 공식 업데이트 서브커맨드는 확인과 설치를 함께 수행해 최신 버전만 따로
            // 물어볼 수 없다. 업데이트 실행 자체는 그대로 제공한다.
            CliUpdateMethod::SelfUpdate => {
                "공식 업데이트 명령이 확인과 설치를 함께 수행해 최신 버전만 따로 조회할 수 없습니다"
                    .to_owned()
            }
            _ => plan
                .unsupported_reason
                .clone()
                .unwrap_or_else(|| UNKNOWN_SOURCE_REASON.to_owned()),
        })
    };

    apply_model_caches(&mut status, adapter);
    status
}

/// allowlist에 등록된 캐시를 조사해 상태에 싣는다. 실행 파일을 찾지 못한 경우에도
/// 캐시만 남아 있을 수 있으므로 조사 자체는 버전 없이도 수행한다.
fn apply_model_caches(status: &mut ProviderCliUpdateStatus, adapter: &ProviderCliAdapter) {
    status.model_caches = inspect_model_caches(adapter, status.current_version.as_deref());
    status.model_cache_mismatch = status
        .model_caches
        .iter()
        .any(|cache| cache.cleanup_available);
}

fn apply_latest_version(status: &mut ProviderCliUpdateStatus) {
    if !status.check_supported {
        return;
    }
    let Some(package) = status.package_name.clone() else {
        status.check_error = Some("패키지 이름을 확인하지 못했습니다".to_owned());
        return;
    };
    let latest = match status.update_method {
        CliUpdateMethod::HomebrewCask => homebrew_latest_version(&package, true),
        CliUpdateMethod::HomebrewFormula => homebrew_latest_version(&package, false),
        CliUpdateMethod::NpmGlobal => npm_latest_version(&package),
        _ => return,
    };
    match latest {
        Ok(latest) => {
            status.checked = true;
            status.update_available = status
                .current_version
                .as_deref()
                .map(|current| compare_versions(&latest, current) == Ordering::Greater)
                .unwrap_or(false);
            status.latest_version = Some(latest);
        }
        Err(error) => status.check_error = Some(error.to_string()),
    }
}

// ---------------------------------------------------------------------------
// 설치 출처 판별과 업데이트 계획
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct UpdatePlan {
    source: CliInstallSource,
    method: CliUpdateMethod,
    package_name: Option<String>,
    command_label: Option<String>,
    unsupported_reason: Option<String>,
}

fn plan_update(adapter: &ProviderCliAdapter, executable: &Path) -> UpdatePlan {
    let (source, package_name) = classify_install_source(executable);
    match source {
        CliInstallSource::HomebrewCask | CliInstallSource::HomebrewFormula => {
            let package = match require_manager(
                source,
                package_name,
                "brew",
                "Homebrew 설치 이름을 확인하지 못했습니다",
            ) {
                Ok(package) => package,
                Err(plan) => return plan,
            };
            let cask = source == CliInstallSource::HomebrewCask;
            let label = format!(
                "brew upgrade {} {}",
                if cask { "--cask" } else { "--formula" },
                package
            );
            UpdatePlan {
                source,
                method: if cask {
                    CliUpdateMethod::HomebrewCask
                } else {
                    CliUpdateMethod::HomebrewFormula
                },
                package_name: Some(package),
                command_label: Some(label),
                unsupported_reason: None,
            }
        }
        CliInstallSource::NpmGlobal => {
            let package = match require_manager(
                source,
                package_name,
                "npm",
                "npm 전역 패키지 이름을 확인하지 못했습니다",
            ) {
                Ok(package) => package,
                Err(plan) => return plan,
            };
            UpdatePlan {
                source,
                method: CliUpdateMethod::NpmGlobal,
                command_label: Some(format!("npm install -g {package}@latest")),
                package_name: Some(package),
                unsupported_reason: None,
            }
        }
        CliInstallSource::Standalone => match &adapter.self_update {
            Some(spec) => {
                let executable_name = executable
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| adapter.provider.as_str().to_owned());
                UpdatePlan {
                    source,
                    method: CliUpdateMethod::SelfUpdate,
                    package_name: None,
                    command_label: Some(format!("{executable_name} {}", spec.args.join(" "))),
                    unsupported_reason: None,
                }
            }
            None => unsupported_plan(
                source,
                None,
                "설치 출처를 확인하지 못했고 공식 업데이트 명령도 없습니다".to_owned(),
            ),
        },
        CliInstallSource::NotDetected => {
            unsupported_plan(source, None, NO_EXECUTABLE_REASON.to_owned())
        }
    }
}

/// 패키지 관리자 갈래가 공통으로 요구하는 두 조건 — 경로에서 구조적으로 유도한 패키지
/// 이름과 관리자 실행 파일 — 을 확인한다. 어느 하나라도 없으면 그대로 돌려줄 미지원
/// 계획을 만들어 준다.
fn require_manager(
    source: CliInstallSource,
    package_name: Option<String>,
    tool: &str,
    missing_package_reason: &str,
) -> Result<String, UpdatePlan> {
    let Some(package) = package_name else {
        return Err(unsupported_plan(
            source,
            None,
            missing_package_reason.to_owned(),
        ));
    };
    if resolve_named_executable(&[tool]).is_err() {
        return Err(unsupported_plan(
            source,
            Some(package),
            format!("{tool} 실행 파일을 찾지 못했습니다"),
        ));
    }
    Ok(package)
}

fn unsupported_plan(
    source: CliInstallSource,
    package_name: Option<String>,
    reason: String,
) -> UpdatePlan {
    UpdatePlan {
        source,
        method: CliUpdateMethod::Unsupported,
        package_name,
        command_label: None,
        unsupported_reason: Some(reason),
    }
}

/// 정규화된 실행 파일 경로의 구조만으로 설치 출처를 판별한다. 경로 문자열을 명령에
/// 넣지 않고, 표식 디렉터리 바로 다음 세그먼트만 이름 후보로 삼는다.
fn classify_install_source(executable: &Path) -> (CliInstallSource, Option<String>) {
    let segments = executable
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>();

    for (index, segment) in segments.iter().enumerate() {
        match segment.as_str() {
            "Caskroom" => {
                return (
                    CliInstallSource::HomebrewCask,
                    segments
                        .get(index + 1)
                        .cloned()
                        .filter(|token| is_valid_homebrew_token(token)),
                );
            }
            "Cellar" => {
                return (
                    CliInstallSource::HomebrewFormula,
                    segments
                        .get(index + 1)
                        .cloned()
                        .filter(|token| is_valid_homebrew_token(token)),
                );
            }
            "node_modules" => {
                return (
                    CliInstallSource::NpmGlobal,
                    npm_package_from_segments(&segments[index + 1..]),
                );
            }
            _ => {}
        }
    }
    (CliInstallSource::Standalone, None)
}

fn npm_package_from_segments(segments: &[String]) -> Option<String> {
    let first = segments.first()?;
    let name = if first.starts_with('@') {
        format!("{first}/{}", segments.get(1)?)
    } else {
        first.clone()
    };
    is_valid_npm_package(&name).then_some(name)
}

fn is_valid_homebrew_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 128
        && token.starts_with(|character: char| character.is_ascii_alphanumeric())
        && token.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '+' | '@')
        })
}

fn is_valid_npm_package(name: &str) -> bool {
    if name.is_empty() || name.len() > 214 {
        return false;
    }
    let (scope, base) = match name.strip_prefix('@') {
        Some(rest) => match rest.split_once('/') {
            Some((scope, base)) => (Some(scope), base),
            None => return false,
        },
        None => (None, name),
    };
    let valid_part = |part: &str| {
        !part.is_empty()
            && part.starts_with(|character: char| {
                character.is_ascii_lowercase() || character.is_ascii_digit()
            })
            && part.chars().all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || matches!(character, '-' | '_' | '.')
            })
    };
    scope.map(valid_part).unwrap_or(true) && valid_part(base)
}

// ---------------------------------------------------------------------------
// 버전 파싱과 비교
// ---------------------------------------------------------------------------

fn probe_cli_version(executable: &Path, args: &[&str]) -> Result<String, CoreError> {
    let outcome = run_capped(executable, args, VERSION_COMMAND_TIMEOUT)?;
    if outcome.timed_out {
        return Err(CoreError::Runtime(
            "CLI 버전 확인 시간이 초과되었습니다".to_owned(),
        ));
    }
    let combined = format!("{}\n{}", outcome.stdout, outcome.stderr);
    parse_cli_version(&combined).ok_or_else(|| {
        CoreError::Runtime(format!(
            "CLI 버전 출력을 해석하지 못했습니다: {}",
            text_limit::truncate_chars(combined.trim(), 120)
        ))
    })
}

/// `--version` 출력에서 첫 semver 형태 토큰을 찾는다. `codex-cli 0.146.0`,
/// `2.1.233 (Claude Code)`, `v1.1.13` 같은 공급자별 형식을 모두 받아들인다.
fn parse_cli_version(output: &str) -> Option<String> {
    output
        .split(|character: char| {
            character.is_whitespace() || matches!(character, '(' | ')' | ',' | '[' | ']')
        })
        .find_map(normalize_version_token)
}

fn normalize_version_token(token: &str) -> Option<String> {
    let trimmed = token.trim().trim_end_matches(['.', ';', ':']);
    let value = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if !value.starts_with(|character: char| character.is_ascii_digit()) {
        return None;
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'))
    {
        return None;
    }
    let core = value.split(['-', '+']).next().unwrap_or(value);
    let parts = core.split('.').collect::<Vec<_>>();
    if parts.len() < 2
        || parts
            .iter()
            .any(|part| part.is_empty() || !part.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    Some(value.to_owned())
}

/// 숫자 파트를 왼쪽부터 수치 비교하고, 같으면 프리릴리스가 없는 쪽을 최신으로 본다.
fn compare_versions(left: &str, right: &str) -> Ordering {
    let (left_core, left_pre) = split_version(left);
    let (right_core, right_pre) = split_version(right);
    let length = left_core.len().max(right_core.len());
    for index in 0..length {
        let left_part = left_core.get(index).copied().unwrap_or(0);
        let right_part = right_core.get(index).copied().unwrap_or(0);
        match left_part.cmp(&right_part) {
            Ordering::Equal => {}
            other => return other,
        }
    }
    match (left_pre.is_empty(), right_pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => left_pre.cmp(&right_pre),
    }
}

fn split_version(version: &str) -> (Vec<u64>, String) {
    let value = version.trim().trim_start_matches(['v', 'V']);
    let mut parts = value.splitn(2, ['-', '+']);
    let core = parts.next().unwrap_or_default();
    let pre = parts.next().unwrap_or_default().to_owned();
    (
        core.split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect(),
        pre,
    )
}

// ---------------------------------------------------------------------------
// 패키지 관리자 조회
// ---------------------------------------------------------------------------

/// `brew info`·`brew upgrade`는 로컬 API 카탈로그를 스스로 갱신하지 않아 며칠
/// 지난 "최신" 버전을 돌려줄 수 있다. 실행 전에 카탈로그를 갱신하되, 오프라인
/// 등으로 실패하면 캐시된 카탈로그로 계속 진행한다.
fn refresh_homebrew_metadata(brew: &Path) {
    let _ = run_capped(brew, &["update", "--quiet"], METADATA_COMMAND_TIMEOUT);
}

fn homebrew_latest_version(token: &str, cask: bool) -> Result<String, CoreError> {
    let brew = resolve_named_executable(&["brew"])?;
    refresh_homebrew_metadata(&brew);
    let outcome = run_capped(
        &brew,
        &[
            "info",
            "--json=v2",
            if cask { "--cask" } else { "--formula" },
            token,
        ],
        METADATA_COMMAND_TIMEOUT,
    )?;
    if outcome.timed_out {
        return Err(CoreError::Runtime(
            "Homebrew 최신 버전 조회 시간이 초과되었습니다".to_owned(),
        ));
    }
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "Homebrew 최신 버전 조회에 실패했습니다: {}",
            text_limit::truncate_chars(outcome.stderr.trim(), 200)
        )));
    }
    parse_homebrew_latest_version(&outcome.stdout, cask).ok_or_else(|| {
        CoreError::Runtime("Homebrew 응답에서 최신 버전을 찾지 못했습니다".to_owned())
    })
}

fn parse_homebrew_latest_version(payload: &str, cask: bool) -> Option<String> {
    let value = serde_json::from_str::<Value>(payload).ok()?;
    if cask {
        value
            .get("casks")?
            .get(0)?
            .get("version")?
            .as_str()
            .map(str::to_owned)
    } else {
        value
            .get("formulae")?
            .get(0)?
            .get("versions")?
            .get("stable")?
            .as_str()
            .map(str::to_owned)
    }
}

fn npm_latest_version(package: &str) -> Result<String, CoreError> {
    let npm = resolve_named_executable(&["npm"])?;
    let outcome = run_capped(
        &npm,
        &["view", package, "version"],
        METADATA_COMMAND_TIMEOUT,
    )?;
    if outcome.timed_out {
        return Err(CoreError::Runtime(
            "npm 최신 버전 조회 시간이 초과되었습니다".to_owned(),
        ));
    }
    if !outcome.success {
        return Err(CoreError::Runtime(format!(
            "npm 최신 버전 조회에 실패했습니다: {}",
            text_limit::truncate_chars(outcome.stderr.trim(), 200)
        )));
    }
    outcome
        .stdout
        .lines()
        .rev()
        .find_map(|line| normalize_version_token(line.trim()))
        .ok_or_else(|| CoreError::Runtime("npm 응답에서 최신 버전을 찾지 못했습니다".to_owned()))
}

/// 업데이트 직전에 설치 사실을 패키지 관리자에게 다시 확인한다. 경로 구조만 믿고
/// 패키지 관리자를 실행하지 않기 위한 단계다.
fn verify_install(status: &ProviderCliUpdateStatus) -> Result<(), CoreError> {
    let Some(package) = status.package_name.as_deref() else {
        return Ok(());
    };
    match status.update_method {
        CliUpdateMethod::HomebrewCask | CliUpdateMethod::HomebrewFormula => {
            let brew = resolve_named_executable(&["brew"])?;
            let cask = status.update_method == CliUpdateMethod::HomebrewCask;
            let outcome = run_capped(
                &brew,
                &[
                    "list",
                    if cask { "--cask" } else { "--formula" },
                    "--versions",
                    package,
                ],
                METADATA_COMMAND_TIMEOUT,
            )?;
            if !outcome.success
                || !outcome
                    .stdout
                    .split_whitespace()
                    .any(|word| word == package)
            {
                return Err(CoreError::Conflict(format!(
                    "Homebrew에 {package} 설치를 확인하지 못해 업데이트를 실행하지 않았습니다"
                )));
            }
            Ok(())
        }
        CliUpdateMethod::NpmGlobal => {
            let npm = resolve_named_executable(&["npm"])?;
            let outcome = run_capped(&npm, &["root", "-g"], METADATA_COMMAND_TIMEOUT)?;
            let root = outcome.stdout.trim();
            if !outcome.success || root.is_empty() {
                return Err(CoreError::Conflict(
                    "npm 전역 설치 경로를 확인하지 못해 업데이트를 실행하지 않았습니다".to_owned(),
                ));
            }
            let executable = status
                .executable_path
                .as_deref()
                .map(PathBuf::from)
                .ok_or_else(|| {
                    CoreError::Conflict("CLI 실행 경로를 확인하지 못했습니다".to_owned())
                })?;
            let root = fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
            if !executable.starts_with(&root) {
                return Err(CoreError::Conflict(format!(
                    "{package}가 npm 전역 경로에 설치되어 있지 않아 업데이트를 실행하지 않았습니다"
                )));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// 실행 중 런타임 정리 (공통 정책)
// ---------------------------------------------------------------------------

/// 확인창에 보여줄 종료 대상 수. 활성 계정 변경과 같은 대상 집합을 센다.
pub fn provider_runtime_counts(
    chats: &ChatSupervisor,
    terminals: &TerminalSupervisor,
    provider: ProviderId,
) -> Result<ProviderRuntimeCounts, CoreError> {
    let chat_count = chats
        .provider_chats(provider)?
        .into_iter()
        .filter(|chat| !matches!(chat.state, ChatPhase::Stopped | ChatPhase::Failed))
        .count();
    let external_process_count = list_external_provider_processes(provider)
        .map(|processes| processes.len())
        .unwrap_or(0);
    Ok(ProviderRuntimeCounts {
        provider,
        chat_count,
        terminal_count: terminals.provider_terminal_count(provider)?,
        external_process_count,
    })
}

/// 공급자 CLI 바이너리나 캐시를 바꾸기 전에 그 공급자의 관리 채팅·터미널을 모두
/// 종료하고 외부 CLI 프로세스를 정리한다. 활성 계정 변경과 같은 종료 정책이며,
/// 관리 런타임이 하나라도 남으면 호출자는 대상 파일을 건드리지 않고 중단한다.
fn stop_provider_runtimes(
    chats: &ChatSupervisor,
    terminals: &TerminalSupervisor,
    provider: ProviderId,
    aborted_operation: &str,
) -> Result<ProviderRuntimeStopSummary, CoreError> {
    let (chat_result, terminal_result) = (
        chats.stop_provider_chats(provider),
        terminals.stop_provider_terminals(provider),
    );
    let chat_report = chat_result?;
    let terminal_report = terminal_result?;
    let remaining_terminal_count = terminals.provider_terminal_count(provider)?;
    let remaining_runtime_count = match chats.accounts() {
        Some(accounts) => accounts.provider_runtime_count(provider)?,
        None => chat_report.remaining_runtime_count,
    };
    if !chat_report.failed.is_empty()
        || !terminal_report.failed.is_empty()
        || remaining_runtime_count > 0
        || remaining_terminal_count > 0
    {
        return Err(CoreError::Conflict(format!(
            "{} 관리 런타임을 완전히 종료하지 못해 {aborted_operation}. (채팅 요청 {}, 실패 {}; 터미널 요청 {}, 실패 {}; 잔존 런타임 {}, 잔존 터미널 {})",
            provider.as_str(),
            chat_report.requested_count,
            chat_report.failed.len(),
            terminal_report.requested_count,
            terminal_report.failed.len(),
            remaining_runtime_count,
            remaining_terminal_count,
        )));
    }

    // 관리 런타임을 모두 정리한 뒤 외부 독립 실행 CLI를 종료한다. 외부 종료 실패는
    // 보고만 하고 작업을 막지 않는다.
    let external = terminate_external_provider_processes(provider)?;
    Ok(ProviderRuntimeStopSummary {
        chat_requested_count: chat_report.requested_count,
        chat_stopped_count: chat_report.stopped_count,
        chat_forced_count: chat_report.forced_count,
        terminal_requested_count: terminal_report.requested_count,
        terminal_stopped_count: terminal_report.stopped_count,
        terminal_forced_count: terminal_report.forced_count,
        external_requested_count: external.requested_count,
        external_terminated_count: external.terminated_count,
        external_forced_count: external.forced_count,
        external_failed_count: external.failed.len(),
    })
}

// ---------------------------------------------------------------------------
// 업데이트 실행
// ---------------------------------------------------------------------------

pub fn update_provider_cli(
    chats: &ChatSupervisor,
    terminals: &TerminalSupervisor,
    provider: ProviderId,
) -> Result<CliUpdateReceipt, CoreError> {
    let adapter = adapter(provider);
    let mut status = resolve_status(adapter);
    if !status.update_supported {
        return Err(CoreError::InvalidInput(format!(
            "{}는 자동 업데이트를 지원하지 않습니다: {}",
            status.display_name,
            status
                .unsupported_reason
                .clone()
                .unwrap_or_else(|| UNKNOWN_SOURCE_REASON.to_owned())
        )));
    }
    let Some(executable) = status.executable_path.clone().map(PathBuf::from) else {
        return Err(CoreError::NotFound(NO_EXECUTABLE_REASON.to_owned()));
    };
    verify_install(&status)?;
    apply_latest_version(&mut status);

    let previous_version = status.current_version.clone();
    let target_version = status.latest_version.clone();
    let command_label = status
        .update_command_label
        .clone()
        .unwrap_or_else(|| "업데이트".to_owned());

    // 이미 최신이면 런타임을 종료하지 않고 그대로 알린다.
    if status.checked && !status.update_available && previous_version.is_some() {
        return Ok(CliUpdateReceipt {
            provider,
            outcome: CliUpdateOutcome::AlreadyLatest,
            method: status.update_method,
            command_label,
            previous_version: previous_version.clone(),
            current_version: previous_version,
            target_version,
            verified: true,
            message: "이미 최신 버전입니다".to_owned(),
            failure_output: None,
            stopped: ProviderRuntimeStopSummary::default(),
            status,
        });
    }

    let stopped = stop_provider_runtimes(
        chats,
        terminals,
        provider,
        "CLI 업데이트를 실행하지 않았습니다",
    )?;

    let outcome = run_update_command(adapter, &status, &executable)?;
    // 업데이트 직후에는 버전 문자열이 그대로여도(재설치·롤백) 인터페이스가 바뀔 수 있으므로
    // 강제로 다시 조사한다.
    let mut next_status = resolve_status_and_settings_schema(chats, adapter, true);
    next_status.latest_version = status.latest_version.clone();
    next_status.checked = status.checked;
    next_status.check_error = status.check_error.clone();
    if let (Some(latest), Some(current)) = (
        next_status.latest_version.clone(),
        next_status.current_version.clone(),
    ) {
        let order = compare_versions(&latest, &current);
        next_status.update_available = order == Ordering::Greater;
        // 확인 시점의 최신 기록이 낡아 그보다 높은 버전이 설치될 수 있다.
        // 그때는 설치 버전이 최신 하한이므로 기록을 끌어올린다.
        if order == Ordering::Less {
            next_status.latest_version = Some(current);
        }
    }

    let current_version = next_status.current_version.clone();
    let failure_output = combined_output_tail(&outcome);
    let (result, verified, message) = if outcome.timed_out {
        (
            CliUpdateOutcome::Failed,
            false,
            format!("{command_label} 실행 시간이 초과되었습니다. 기존 CLI는 그대로입니다."),
        )
    } else if !outcome.success {
        (
            CliUpdateOutcome::Failed,
            false,
            format!("{command_label} 실행이 실패했습니다. 기존 CLI는 그대로입니다."),
        )
    } else {
        classify_update_result(
            target_version.as_deref(),
            current_version.as_deref(),
            previous_version.as_deref(),
        )
    };

    Ok(CliUpdateReceipt {
        provider,
        outcome: result,
        method: status.update_method,
        command_label,
        previous_version,
        current_version,
        target_version,
        verified,
        message,
        failure_output: result.is_failure().then_some(failure_output).flatten(),
        stopped,
        status: next_status,
    })
}

/// 업데이트 명령이 성공 종료한 뒤 실제 실행 버전으로 결과를 판정한다.
///
/// 목표 버전은 업데이트 직전 "최신 버전 확인" 결과이므로, 확인과 실행 사이에
/// 공급자가 새 버전을 배포하면 설치 버전이 목표보다 높아진다. 목표를 넘어선
/// 설치는 성공이며, 목표에 못 미친 설치만 검증 실패다.
fn classify_update_result(
    target_version: Option<&str>,
    current_version: Option<&str>,
    previous_version: Option<&str>,
) -> (CliUpdateOutcome, bool, String) {
    match (target_version, current_version, previous_version) {
        (_, None, _) => (
            CliUpdateOutcome::VerificationFailed,
            false,
            "업데이트 후 CLI 버전을 확인하지 못했습니다".to_owned(),
        ),
        (Some(target), Some(current), _) if compare_versions(current, target) == Ordering::Equal => {
            (
                CliUpdateOutcome::Updated,
                true,
                format!("{current} 버전으로 업데이트했습니다"),
            )
        }
        (Some(target), Some(current), _)
            if compare_versions(current, target) == Ordering::Greater =>
        {
            (
                CliUpdateOutcome::Updated,
                true,
                format!(
                    "{current} 버전으로 업데이트했습니다. 확인 시점 최신 기록 {target}보다 높은 버전입니다"
                ),
            )
        }
        (Some(target), Some(current), _) => (
            CliUpdateOutcome::VerificationFailed,
            false,
            format!("업데이트 후 버전이 목표 {target}에 못 미치는 {current}입니다"),
        ),
        (None, Some(current), Some(previous)) if current != previous => (
            CliUpdateOutcome::Updated,
            true,
            format!("{previous} → {current} 버전으로 업데이트했습니다"),
        ),
        (None, Some(current), Some(_)) => (
            CliUpdateOutcome::AlreadyLatest,
            false,
            format!("CLI가 업데이트를 적용하지 않았습니다. 실행 버전은 {current}입니다"),
        ),
        (None, Some(current), None) => (
            CliUpdateOutcome::VerificationFailed,
            false,
            format!(
                "업데이트 전 버전을 몰라 적용 결과를 검증하지 못했습니다. 실행 버전은 {current}입니다"
            ),
        ),
    }
}

fn run_update_command(
    adapter: &ProviderCliAdapter,
    status: &ProviderCliUpdateStatus,
    executable: &Path,
) -> Result<CommandOutcome, CoreError> {
    match status.update_method {
        CliUpdateMethod::HomebrewCask | CliUpdateMethod::HomebrewFormula => {
            let brew = resolve_named_executable(&["brew"])?;
            let package = status
                .package_name
                .as_deref()
                .ok_or_else(|| CoreError::InvalidInput("Homebrew 이름이 없습니다".to_owned()))?;
            let cask = status.update_method == CliUpdateMethod::HomebrewCask;
            refresh_homebrew_metadata(&brew);
            run_capped(
                &brew,
                &[
                    "upgrade",
                    if cask { "--cask" } else { "--formula" },
                    package,
                ],
                UPDATE_COMMAND_TIMEOUT,
            )
        }
        CliUpdateMethod::NpmGlobal => {
            let npm = resolve_named_executable(&["npm"])?;
            let package = status
                .package_name
                .as_deref()
                .ok_or_else(|| CoreError::InvalidInput("npm 패키지 이름이 없습니다".to_owned()))?;
            run_capped(
                &npm,
                &["install", "-g", &format!("{package}@latest")],
                UPDATE_COMMAND_TIMEOUT,
            )
        }
        CliUpdateMethod::SelfUpdate => {
            let spec = adapter.self_update.as_ref().ok_or_else(|| {
                CoreError::InvalidInput("공식 업데이트 명령이 없습니다".to_owned())
            })?;
            run_capped(executable, spec.args, UPDATE_COMMAND_TIMEOUT)
        }
        CliUpdateMethod::Unsupported => Err(CoreError::InvalidInput(
            "자동 업데이트를 지원하지 않습니다".to_owned(),
        )),
    }
}

// ---------------------------------------------------------------------------
// 모델 카탈로그 캐시
// ---------------------------------------------------------------------------

fn cache_root(spec: &ModelCacheSpec) -> Result<PathBuf, CoreError> {
    if let Some(variable) = spec.home_env {
        if let Some(value) = env::var_os(variable).filter(|value| !value.is_empty()) {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(CoreError::InvalidInput(format!(
                    "{variable} 값은 절대 경로여야 합니다"
                )));
            }
            return Ok(path);
        }
    }
    let home = user_home::home_dir()?;
    Ok(home.join(spec.home_relative))
}

fn inspect_model_caches(
    adapter: &ProviderCliAdapter,
    cli_version: Option<&str>,
) -> Vec<ModelCacheStatus> {
    adapter
        .model_caches
        .iter()
        .map(|spec| match cache_root(spec) {
            Ok(root) => inspect_model_cache(spec, &root, cli_version),
            Err(error) => ModelCacheStatus {
                id: spec.id.to_owned(),
                label: spec.label.to_owned(),
                path: format!("<{}>", spec.home_relative),
                state: ModelCacheState::Unknown,
                cache_client_version: None,
                cli_version: cli_version.map(str::to_owned),
                error: Some(error.to_string()),
                cleanup_available: false,
            },
        })
        .collect()
}

fn inspect_model_cache(
    spec: &ModelCacheSpec,
    root: &Path,
    cli_version: Option<&str>,
) -> ModelCacheStatus {
    let path = root.join(spec.file_name);
    let mut status = ModelCacheStatus {
        id: spec.id.to_owned(),
        label: spec.label.to_owned(),
        path: path.to_string_lossy().into_owned(),
        state: ModelCacheState::Absent,
        cache_client_version: None,
        cli_version: cli_version.map(str::to_owned),
        error: None,
        cleanup_available: false,
    };
    match read_cache_client_version(&path, spec.version_field) {
        Ok(None) => return status,
        Ok(Some(version)) => {
            status.cache_client_version = Some(version.clone());
            // 방향을 구분한다. 캐시가 더 최신이면 실행 CLI가 읽지 못할 수 있어 정리 대상이지만,
            // 더 낮으면 같은 홈을 쓰는 옛 클라이언트가 남긴 기록일 뿐이고 실행 CLI가 다음
            // 조회에서 자기 버전으로 다시 기록하므로 손댈 것이 없다.
            status.state = match cli_version {
                None => ModelCacheState::Unknown,
                Some(current) => match compare_versions(&version, current) {
                    Ordering::Equal => ModelCacheState::Matched,
                    Ordering::Less => ModelCacheState::Outdated,
                    Ordering::Greater => ModelCacheState::Mismatched,
                },
            };
        }
        Err(error) => {
            status.state = ModelCacheState::Unreadable;
            status.error = Some(error.to_string());
        }
    }
    // 실행 버전보다 높게 기록된 캐시와 해석할 수 없는 캐시만 정리 대상이다.
    status.cleanup_available = status.state.is_cleanup_available();
    status
}

/// 캐시 파일에서 클라이언트 버전만 읽는다. 없는 파일은 `Ok(None)`이다.
fn read_cache_client_version(path: &Path, field: &str) -> Result<Option<String>, CoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Err(CoreError::InvalidInput(
            "캐시 경로가 심볼릭 링크입니다".to_owned(),
        ));
    }
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "캐시 경로가 일반 파일이 아닙니다".to_owned(),
        ));
    }
    if metadata.len() > MAX_MODEL_CACHE_BYTES {
        return Err(CoreError::TooLarge(MAX_MODEL_CACHE_BYTES));
    }
    let payload = fs::read_to_string(path)?;
    let value = serde_json::from_str::<Value>(&payload)
        .map_err(|error| CoreError::Runtime(format!("캐시 JSON을 해석하지 못했습니다: {error}")))?;
    value
        .get(field)
        .and_then(Value::as_str)
        .map(|version| Some(version.to_owned()))
        .ok_or_else(|| CoreError::Runtime(format!("캐시에 {field} 값이 없습니다")))
}

/// allowlist에 등록된 캐시 파일 하나만 지운다. 루트는 정규화한 뒤 고정 파일명을
/// 붙이므로 루트를 벗어날 수 없고, 심볼릭 링크와 일반 파일이 아닌 항목은 거부한다.
fn remove_cache_file(root: &Path, file_name: &str) -> Result<bool, CoreError> {
    let canonical_root = match fs::canonicalize(root) {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !canonical_root.is_dir() {
        return Err(CoreError::InvalidInput(
            "캐시 루트가 디렉터리가 아닙니다".to_owned(),
        ));
    }
    let target = canonical_root.join(file_name);
    if target.parent() != Some(canonical_root.as_path())
        || target.file_name().and_then(|name| name.to_str()) != Some(file_name)
    {
        return Err(CoreError::InvalidInput(
            "캐시 경로가 허용된 위치를 벗어났습니다".to_owned(),
        ));
    }
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() {
        return Err(CoreError::InvalidInput(
            "캐시가 심볼릭 링크여서 삭제하지 않았습니다".to_owned(),
        ));
    }
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "캐시 경로가 일반 파일이 아니어서 삭제하지 않았습니다".to_owned(),
        ));
    }
    match fs::remove_file(&target) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

/// 실행 버전과 다르게 기록된(또는 해석할 수 없는) 모델 카탈로그 캐시만 지운다.
/// 캐시를 다시 쓰는 공급자 런타임과의 경쟁을 피하려고, 지우기 전에 그 공급자의
/// 관리 런타임과 외부 CLI 프로세스를 먼저 종료한다.
// 정리 결과 한 줄은 캐시 상태에서 식별 세 칸(id·label·path)과 이전 캐시 버전을 그대로
// 옮기고, 갈래마다 다른 것은 제거 여부·건너뛴 사유·오류뿐이다. 네 자리에서 같은 네 칸을
// 되풀이해 옮기다 한 칸을 빠뜨리면 화면에서만 드러나므로 옮기는 일은 여기 한 벌로 둔다.
fn cleanup_entry(
    cache: &ModelCacheStatus,
    removed: bool,
    skipped_reason: Option<String>,
    error: Option<String>,
) -> ModelCacheCleanupEntry {
    ModelCacheCleanupEntry {
        id: cache.id.clone(),
        label: cache.label.clone(),
        path: cache.path.clone(),
        removed,
        previous_cache_client_version: cache.cache_client_version.clone(),
        skipped_reason,
        error,
    }
}

pub fn clear_provider_model_caches(
    chats: &ChatSupervisor,
    terminals: &TerminalSupervisor,
    provider: ProviderId,
) -> Result<ModelCacheCleanupReceipt, CoreError> {
    let adapter = adapter(provider);
    if adapter.model_caches.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "{}는 자동 캐시 정리를 지원하지 않습니다: {}",
            provider_display_name(provider),
            adapter.no_model_cache_reason
        )));
    }
    let status = resolve_status(adapter);
    let targets = status
        .model_caches
        .iter()
        .filter(|cache| cache.cleanup_available)
        .map(|cache| cache.id.clone())
        .collect::<Vec<_>>();

    let mut entries = Vec::new();
    let mut stopped = ProviderRuntimeStopSummary::default();
    if targets.is_empty() {
        for cache in &status.model_caches {
            let reason = match cache.state {
                ModelCacheState::Absent => "캐시 파일이 없습니다",
                ModelCacheState::Matched => "캐시 버전이 실행 버전과 같아 정리하지 않았습니다",
                _ => "실행 버전을 확인하지 못해 정리하지 않았습니다",
            };
            entries.push(cleanup_entry(cache, false, Some(reason.to_owned()), None));
        }
        return Ok(ModelCacheCleanupReceipt {
            provider,
            removed_count: 0,
            failed_count: 0,
            entries,
            stopped,
            status,
        });
    }

    stopped = stop_provider_runtimes(
        chats,
        terminals,
        provider,
        "모델 캐시를 정리하지 않았습니다",
    )?;

    let mut removed_count = 0usize;
    let mut failed_count = 0usize;
    for spec in adapter.model_caches {
        let cache = status
            .model_caches
            .iter()
            .find(|cache| cache.id == spec.id)
            .expect("캐시 상태는 allowlist와 1:1이다");
        if !targets.contains(&cache.id) {
            entries.push(cleanup_entry(
                cache,
                false,
                Some("정리 대상이 아닙니다".to_owned()),
                None,
            ));
            continue;
        }
        let outcome = cache_root(spec).and_then(|root| remove_cache_file(&root, spec.file_name));
        match outcome {
            Ok(removed) => {
                if removed {
                    removed_count += 1;
                }
                entries.push(cleanup_entry(
                    cache,
                    removed,
                    (!removed).then(|| "캐시 파일이 이미 없습니다".to_owned()),
                    None,
                ));
            }
            Err(error) => {
                failed_count += 1;
                entries.push(cleanup_entry(cache, false, None, Some(error.to_string())));
            }
        }
    }

    Ok(ModelCacheCleanupReceipt {
        provider,
        removed_count,
        failed_count,
        entries,
        stopped,
        status: resolve_status(adapter),
    })
}

// ---------------------------------------------------------------------------
// 외부 명령 실행
// ---------------------------------------------------------------------------
//
// 제한시간·출력 상한이 붙은 실행기는 `cli_interface`가 소유한다. 인터페이스 조사와
// 업데이트가 같은 실행 규칙을 쓰도록 여기서는 그것을 그대로 가져다 쓴다.

fn combined_output_tail(outcome: &CommandOutcome) -> Option<String> {
    let combined = format!("{}\n{}", outcome.stdout.trim(), outcome.stderr.trim());
    let trimmed = combined.trim();
    (!trimmed.is_empty()).then(|| tail(trimmed, MAX_REPORTED_OUTPUT_CHARS))
}

fn tail(value: &str, max_chars: usize) -> String {
    let characters = value.chars().collect::<Vec<_>>();
    if characters.len() <= max_chars {
        return value.to_owned();
    }
    characters[characters.len() - max_chars..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory() -> PathBuf {
        tempfile::Builder::new()
            .prefix("agent-manager-cli-updates-")
            .tempdir()
            .expect("임시 디렉터리")
            .keep()
    }

    #[test]
    fn parses_every_provider_version_output_format() {
        assert_eq!(
            parse_cli_version("codex-cli 0.146.0").as_deref(),
            Some("0.146.0")
        );
        assert_eq!(
            parse_cli_version("2.1.233 (Claude Code)").as_deref(),
            Some("2.1.233")
        );
        assert_eq!(parse_cli_version("1.1.13\n").as_deref(), Some("1.1.13"));
        assert_eq!(
            parse_cli_version("agy version v1.2.3").as_deref(),
            Some("1.2.3")
        );
        assert_eq!(
            parse_cli_version("claude 2.0.0-beta.4 (Claude Code)").as_deref(),
            Some("2.0.0-beta.4")
        );
    }

    #[test]
    fn rejects_outputs_without_a_version_token() {
        assert_eq!(parse_cli_version(""), None);
        assert_eq!(parse_cli_version("command not found"), None);
        assert_eq!(
            parse_cli_version("build 2026"),
            None,
            "단일 숫자는 버전이 아니다"
        );
    }

    #[test]
    fn compares_versions_numerically_and_demotes_prereleases() {
        assert_eq!(compare_versions("0.147.0", "0.146.0"), Ordering::Greater);
        assert_eq!(compare_versions("0.9.0", "0.10.0"), Ordering::Less);
        assert_eq!(compare_versions("2.1.233", "2.1.233"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.0", "1.2"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.0", "1.2.0-beta.1"), Ordering::Greater);
        assert_eq!(
            compare_versions("1.2.0-beta.1", "1.2.0-beta.2"),
            Ordering::Less
        );
    }

    #[test]
    fn treats_install_above_recorded_target_as_updated() {
        let (outcome, verified, message) =
            classify_update_result(Some("0.147.0"), Some("0.148.0"), Some("0.146.0"));
        assert_eq!(outcome, CliUpdateOutcome::Updated);
        assert!(verified);
        assert!(
            message.contains("0.148.0"),
            "실행 버전을 알려야 한다: {message}"
        );

        assert_eq!(
            classify_update_result(Some("0.147.0"), Some("0.147.0"), Some("0.146.0")).0,
            CliUpdateOutcome::Updated
        );
        assert_eq!(
            classify_update_result(Some("0.147.0"), Some("0.146.0"), Some("0.146.0")).0,
            CliUpdateOutcome::VerificationFailed,
            "목표에 못 미친 설치는 검증 실패다"
        );
        assert_eq!(
            classify_update_result(Some("0.147.0"), None, Some("0.146.0")).0,
            CliUpdateOutcome::VerificationFailed
        );
        assert_eq!(
            classify_update_result(None, Some("0.146.0"), Some("0.146.0")).0,
            CliUpdateOutcome::AlreadyLatest
        );
    }

    #[test]
    fn classifies_homebrew_cask_npm_and_standalone_installs() {
        assert_eq!(
            classify_install_source(Path::new("/opt/homebrew/Caskroom/codex/0.146.0/bin/codex")),
            (CliInstallSource::HomebrewCask, Some("codex".to_owned()))
        );
        assert_eq!(
            classify_install_source(Path::new(
                "/opt/homebrew/Cellar/claude-code/2.1.0/bin/claude"
            )),
            (
                CliInstallSource::HomebrewFormula,
                Some("claude-code".to_owned())
            )
        );
        assert_eq!(
            classify_install_source(Path::new(
                "/Users/x/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
            )),
            (
                CliInstallSource::NpmGlobal,
                Some("@anthropic-ai/claude-code".to_owned())
            )
        );
        assert_eq!(
            classify_install_source(Path::new("/usr/local/lib/node_modules/codex/bin/codex")),
            (CliInstallSource::NpmGlobal, Some("codex".to_owned()))
        );
        assert_eq!(
            classify_install_source(Path::new("/Users/x/.local/bin/agy")),
            (CliInstallSource::Standalone, None)
        );
    }

    #[test]
    fn rejects_package_names_that_are_not_plain_identifiers() {
        assert!(!is_valid_npm_package("../evil"));
        assert!(!is_valid_npm_package("@scope"));
        assert!(!is_valid_npm_package("Codex; rm -rf /"));
        assert!(is_valid_npm_package("@openai/codex"));
        assert!(!is_valid_homebrew_token("-rf"));
        assert!(!is_valid_homebrew_token("codex/../evil"));
        assert!(is_valid_homebrew_token("codex"));
    }

    #[test]
    fn every_provider_plans_a_fixed_argv_update_for_a_known_install_source() {
        for adapter in ADAPTERS {
            let plan = plan_update(
                adapter,
                Path::new("/Users/x/.local/lib/node_modules/@vendor/tool/bin/tool"),
            );
            assert_eq!(plan.source, CliInstallSource::NpmGlobal);
            assert_eq!(plan.package_name.as_deref(), Some("@vendor/tool"));
            if plan.method.is_update_supported() {
                assert_eq!(
                    plan.command_label.as_deref(),
                    Some("npm install -g @vendor/tool@latest")
                );
            } else {
                assert!(
                    plan.unsupported_reason.is_some(),
                    "미지원이면 사유가 있어야 한다"
                );
            }
        }
    }

    #[test]
    fn standalone_installs_use_the_official_update_subcommand_for_every_provider() {
        for adapter in ADAPTERS {
            let plan = plan_update(adapter, Path::new("/Users/x/.local/bin/tool"));
            assert_eq!(plan.source, CliInstallSource::Standalone);
            assert_eq!(plan.method, CliUpdateMethod::SelfUpdate);
            assert_eq!(plan.command_label.as_deref(), Some("tool update"));
            assert!(
                plan.package_name.is_none(),
                "자체 업데이트는 패키지 이름을 쓰지 않는다"
            );
        }
    }

    #[test]
    fn a_provider_without_a_self_update_command_is_reported_unsupported() {
        let adapter = ProviderCliAdapter {
            provider: ProviderId::Antigravity,
            version_args: &["--version"],
            self_update: None,
            manual_update_hint: "수동",
            model_caches: &[],
            no_model_cache_reason: "없음",
        };
        let plan = plan_update(&adapter, Path::new("/opt/tools/agy"));
        assert_eq!(plan.method, CliUpdateMethod::Unsupported);
        assert!(plan
            .unsupported_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("공식 업데이트 명령")));
    }

    #[test]
    fn parses_homebrew_metadata_for_casks_and_formulae() {
        let cask = r#"{"casks":[{"token":"codex","version":"0.147.0","installed":"0.146.0"}]}"#;
        assert_eq!(
            parse_homebrew_latest_version(cask, true).as_deref(),
            Some("0.147.0")
        );
        let formula = r#"{"formulae":[{"name":"tool","versions":{"stable":"3.2.1"}}]}"#;
        assert_eq!(
            parse_homebrew_latest_version(formula, false).as_deref(),
            Some("3.2.1")
        );
        assert_eq!(parse_homebrew_latest_version("{}", true), None);
        assert_eq!(parse_homebrew_latest_version("not json", false), None);
    }

    fn codex_cache_spec() -> &'static ModelCacheSpec {
        &ADAPTERS[1].model_caches[0]
    }

    fn write_cache(root: &Path, client_version: &str) {
        fs::write(
            root.join("models_cache.json"),
            format!(r#"{{"client_version":"{client_version}","models":[]}}"#),
        )
        .expect("캐시 fixture");
    }

    /// 회귀 사례: 실행 파일 0.146.0, 캐시 client_version 0.148.0.
    #[test]
    fn detects_the_reported_codex_cache_schema_mismatch() {
        let root = temporary_directory();
        write_cache(&root, "0.148.0");
        let status = inspect_model_cache(codex_cache_spec(), &root, Some("0.146.0"));
        assert_eq!(status.state, ModelCacheState::Mismatched);
        assert_eq!(status.cache_client_version.as_deref(), Some("0.148.0"));
        assert!(status.cleanup_available);
        fs::remove_dir_all(root).expect("정리");
    }

    /// 회귀 사례: CLI를 0.152.0으로 올린 뒤에도 같은 홈을 쓰는 데스크톱 앱(0.151.0)이 캐시를
    /// 되쓴다. 실행 CLI가 더 최신이므로 경고할 것도 지울 것도 없다.
    #[test]
    fn a_cache_written_by_an_older_client_is_not_a_cleanup_target() {
        let root = temporary_directory();
        write_cache(&root, "0.151.0");
        let status = inspect_model_cache(codex_cache_spec(), &root, Some("0.152.0"));
        assert_eq!(status.state, ModelCacheState::Outdated);
        assert_eq!(status.cache_client_version.as_deref(), Some("0.151.0"));
        assert!(
            !status.cleanup_available,
            "실행 CLI가 다음 조회에서 다시 기록하므로 정리 대상이 아니다"
        );
        fs::remove_dir_all(root).expect("정리");
    }

    /// 코어 버전이 같고 프리릴리스만 붙은 기록도 낮은 쪽으로 본다. 데스크톱 앱의
    /// `0.151.0-alpha.7.2`처럼 정식 배포보다 앞선 빌드가 남긴 기록이 여기 해당한다.
    #[test]
    fn a_prerelease_cache_record_is_outdated_against_the_matching_release() {
        let root = temporary_directory();
        write_cache(&root, "0.151.0-alpha.7.2");
        let status = inspect_model_cache(codex_cache_spec(), &root, Some("0.151.0"));
        assert_eq!(status.state, ModelCacheState::Outdated);
        assert!(!status.cleanup_available);
        fs::remove_dir_all(root).expect("정리");
    }

    #[test]
    fn matching_absent_and_corrupt_caches_are_classified_separately() {
        let root = temporary_directory();
        let absent = inspect_model_cache(codex_cache_spec(), &root, Some("0.146.0"));
        assert_eq!(absent.state, ModelCacheState::Absent);
        assert!(!absent.cleanup_available);

        write_cache(&root, "0.146.0");
        let matched = inspect_model_cache(codex_cache_spec(), &root, Some("0.146.0"));
        assert_eq!(matched.state, ModelCacheState::Matched);
        assert!(!matched.cleanup_available);

        let unknown = inspect_model_cache(codex_cache_spec(), &root, None);
        assert_eq!(unknown.state, ModelCacheState::Unknown);
        assert!(
            !unknown.cleanup_available,
            "실행 버전을 모르면 지우지 않는다"
        );

        fs::write(root.join("models_cache.json"), "{ broken").expect("손상 fixture");
        let corrupt = inspect_model_cache(codex_cache_spec(), &root, Some("0.146.0"));
        assert_eq!(corrupt.state, ModelCacheState::Unreadable);
        assert!(corrupt.cleanup_available);
        assert!(corrupt.error.is_some());

        fs::remove_dir_all(root).expect("정리");
    }

    #[test]
    fn removes_only_the_allowlisted_cache_file() {
        let root = temporary_directory();
        write_cache(&root, "0.148.0");
        let preserved = [
            "auth.json",
            "config.toml",
            "state_5.sqlite",
            ".codex-global-state.json",
        ];
        for name in preserved {
            fs::write(root.join(name), "keep").expect("보존 fixture");
        }
        for directory in ["sessions", "logs", "skills", "plugins", "archived_sessions"] {
            fs::create_dir_all(root.join(directory)).expect("보존 디렉터리");
            fs::write(root.join(directory).join("item"), "keep").expect("보존 항목");
        }

        assert!(remove_cache_file(&root, "models_cache.json").expect("삭제"));
        assert!(!root.join("models_cache.json").exists());
        for name in preserved {
            assert!(root.join(name).exists(), "{name}은 보존되어야 한다");
        }
        for directory in ["sessions", "logs", "skills", "plugins", "archived_sessions"] {
            assert!(
                root.join(directory).join("item").exists(),
                "{directory} 보존"
            );
        }

        // 없는 파일 삭제는 멱등 성공이다.
        assert!(!remove_cache_file(&root, "models_cache.json").expect("멱등 삭제"));
        fs::remove_dir_all(root).expect("정리");
    }

    #[test]
    #[cfg(unix)]
    fn refuses_to_delete_a_symlinked_cache_and_keeps_the_target() {
        let root = temporary_directory();
        let outside = root.join("outside.json");
        fs::write(&outside, "keep").expect("외부 파일");
        let cache_root = root.join("home");
        fs::create_dir_all(&cache_root).expect("캐시 루트");
        std::os::unix::fs::symlink(&outside, cache_root.join("models_cache.json"))
            .expect("심볼릭 링크");

        let error = remove_cache_file(&cache_root, "models_cache.json")
            .expect_err("심볼릭 링크는 거부해야 한다");
        assert!(error.to_string().contains("심볼릭 링크"));
        assert!(outside.exists(), "링크 대상은 보존되어야 한다");
        assert!(cache_root.join("models_cache.json").exists());

        let status = inspect_model_cache(codex_cache_spec(), &cache_root, Some("0.146.0"));
        assert_eq!(status.state, ModelCacheState::Unreadable);
        fs::remove_dir_all(root).expect("정리");
    }

    #[test]
    fn refuses_a_cache_path_that_is_a_directory() {
        let root = temporary_directory();
        fs::create_dir_all(root.join("models_cache.json")).expect("디렉터리 fixture");
        let error =
            remove_cache_file(&root, "models_cache.json").expect_err("디렉터리는 거부해야 한다");
        assert!(error.to_string().contains("일반 파일"));
        assert!(root.join("models_cache.json").is_dir());
        fs::remove_dir_all(root).expect("정리");
    }

    #[test]
    fn refuses_cache_names_that_escape_the_root() {
        let root = temporary_directory();
        fs::write(root.join("victim.json"), "keep").expect("피해 파일");
        for name in ["../victim.json", "nested/models_cache.json", ".."] {
            let error = remove_cache_file(&root, name).expect_err("루트 이탈은 거부해야 한다");
            assert!(error.to_string().contains("허용된 위치"), "{name}: {error}");
        }
        assert!(root.join("victim.json").exists());
        fs::remove_dir_all(root).expect("정리");
    }

    #[test]
    fn only_verified_model_catalog_caches_are_allowlisted() {
        for adapter in ADAPTERS {
            for spec in adapter.model_caches {
                assert!(
                    spec.file_name.ends_with(".json"),
                    "{}: 캐시는 단일 파일이어야 한다",
                    spec.id
                );
                assert!(
                    !spec.file_name.contains('/') && !spec.file_name.contains(".."),
                    "{}: 캐시 파일명에 경로가 들어갈 수 없다",
                    spec.id
                );
                assert!(
                    !matches!(
                        spec.file_name,
                        "auth.json"
                            | "config.toml"
                            | "settings.json"
                            | ".credentials.json"
                            | "history.jsonl"
                    ),
                    "{}: 인증·설정·이력 파일은 등록할 수 없다",
                    spec.id
                );
            }
            if adapter.model_caches.is_empty() {
                assert!(
                    !adapter.no_model_cache_reason.is_empty(),
                    "{:?}: 캐시가 없으면 미지원 사유를 표시해야 한다",
                    adapter.provider
                );
            }
        }
        assert_eq!(
            ADAPTERS
                .iter()
                .flat_map(|adapter| adapter.model_caches)
                .count(),
            1,
            "확인된 캐시만 등록한다"
        );
    }

    #[test]
    fn every_provider_reports_a_manual_update_hint() {
        for adapter in ADAPTERS {
            assert!(!adapter.manual_update_hint.is_empty());
        }
    }

    #[test]
    fn command_output_is_reported_as_a_tail() {
        assert_eq!(tail("abcdef", 3), "def");
        assert_eq!(tail("abc", 10), "abc");
    }

    #[test]
    #[cfg(unix)]
    fn a_failing_update_command_is_reported_without_touching_the_binary() {
        let outcome = run_capped(
            Path::new("/bin/sh"),
            &["-c", "exit 3"],
            Duration::from_secs(5),
        )
        .expect("실행");
        assert!(!outcome.success);
        assert!(!outcome.timed_out);
    }

    #[test]
    #[cfg(unix)]
    fn a_hanging_command_is_killed_at_the_timeout() {
        let outcome =
            run_capped(Path::new("/bin/sleep"), &["30"], Duration::from_millis(300)).expect("실행");
        assert!(outcome.timed_out);
        assert!(!outcome.success);
    }

    #[test]
    #[cfg(unix)]
    fn reads_the_cli_version_from_a_fixture_executable() {
        use std::os::unix::fs::PermissionsExt;

        let root = temporary_directory();
        let script = root.join("fake-cli");
        fs::write(&script, "#!/bin/sh\necho 'codex-cli 0.146.0'\n").expect("fixture");
        let mut permissions = fs::metadata(&script).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("권한");

        assert_eq!(
            probe_cli_version(&script, &["--version"]).expect("버전"),
            "0.146.0"
        );
        fs::remove_dir_all(root).expect("정리");
    }

    #[test]
    fn cli_install_source_display_and_from_str_round_trip() {
        assert_eq!(
            CliInstallSource::ALL,
            [
                CliInstallSource::HomebrewCask,
                CliInstallSource::HomebrewFormula,
                CliInstallSource::NpmGlobal,
                CliInstallSource::Standalone,
                CliInstallSource::NotDetected,
            ]
        );
        for source in CliInstallSource::ALL {
            assert_eq!(source.to_string(), source.as_str());
            assert_eq!(source.as_str().parse::<CliInstallSource>().unwrap(), source);
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&source).unwrap();
            assert_eq!(serialized, format!("\"{}\"", source.as_str()));
            let deserialized: CliInstallSource = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, source);
        }
        assert_eq!(
            "  homebrewCask  ".parse::<CliInstallSource>().unwrap(),
            CliInstallSource::HomebrewCask
        );
        assert!(matches!(
            "invalid".parse::<CliInstallSource>(),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(CliInstallSource::HomebrewCask.is_detected());
        assert!(CliInstallSource::HomebrewFormula.is_detected());
        assert!(CliInstallSource::NpmGlobal.is_detected());
        assert!(CliInstallSource::Standalone.is_detected());
        assert!(!CliInstallSource::NotDetected.is_detected());
    }

    #[test]
    fn cli_update_method_display_and_from_str_round_trip() {
        assert_eq!(
            CliUpdateMethod::ALL,
            [
                CliUpdateMethod::HomebrewCask,
                CliUpdateMethod::HomebrewFormula,
                CliUpdateMethod::NpmGlobal,
                CliUpdateMethod::SelfUpdate,
                CliUpdateMethod::Unsupported,
            ]
        );
        for method in CliUpdateMethod::ALL {
            assert_eq!(method.to_string(), method.as_str());
            assert_eq!(method.as_str().parse::<CliUpdateMethod>().unwrap(), method);
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&method).unwrap();
            assert_eq!(serialized, format!("\"{}\"", method.as_str()));
            let deserialized: CliUpdateMethod = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, method);
        }
        assert_eq!(
            "  selfUpdate  ".parse::<CliUpdateMethod>().unwrap(),
            CliUpdateMethod::SelfUpdate
        );
        assert!(matches!(
            "invalid".parse::<CliUpdateMethod>(),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(CliUpdateMethod::HomebrewCask.is_update_supported());
        assert!(CliUpdateMethod::SelfUpdate.is_update_supported());
        assert!(!CliUpdateMethod::Unsupported.is_update_supported());
        assert!(CliUpdateMethod::HomebrewCask.is_check_supported());
        assert!(CliUpdateMethod::HomebrewFormula.is_check_supported());
        assert!(CliUpdateMethod::NpmGlobal.is_check_supported());
        assert!(!CliUpdateMethod::SelfUpdate.is_check_supported());
        assert!(!CliUpdateMethod::Unsupported.is_check_supported());
    }

    #[test]
    fn model_cache_state_display_and_from_str_round_trip() {
        assert_eq!(
            ModelCacheState::ALL,
            [
                ModelCacheState::Absent,
                ModelCacheState::Matched,
                ModelCacheState::Mismatched,
                ModelCacheState::Outdated,
                ModelCacheState::Unreadable,
                ModelCacheState::Unknown,
            ]
        );
        for state in ModelCacheState::ALL {
            assert_eq!(state.to_string(), state.as_str());
            assert_eq!(state.as_str().parse::<ModelCacheState>().unwrap(), state);
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&state).unwrap();
            assert_eq!(serialized, format!("\"{}\"", state.as_str()));
            let deserialized: ModelCacheState = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, state);
        }
        assert_eq!(
            "  mismatched  ".parse::<ModelCacheState>().unwrap(),
            ModelCacheState::Mismatched
        );
        assert!(matches!(
            "invalid".parse::<ModelCacheState>(),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(!ModelCacheState::Absent.is_cleanup_available());
        assert!(!ModelCacheState::Matched.is_cleanup_available());
        assert!(ModelCacheState::Mismatched.is_cleanup_available());
        assert!(!ModelCacheState::Outdated.is_cleanup_available());
        assert!(ModelCacheState::Unreadable.is_cleanup_available());
        assert!(!ModelCacheState::Unknown.is_cleanup_available());
    }

    #[test]
    fn cli_update_outcome_display_and_from_str_round_trip() {
        assert_eq!(
            CliUpdateOutcome::ALL,
            [
                CliUpdateOutcome::Updated,
                CliUpdateOutcome::AlreadyLatest,
                CliUpdateOutcome::VerificationFailed,
                CliUpdateOutcome::Failed,
            ]
        );
        for outcome in CliUpdateOutcome::ALL {
            assert_eq!(outcome.to_string(), outcome.as_str());
            assert_eq!(
                outcome.as_str().parse::<CliUpdateOutcome>().unwrap(),
                outcome
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&outcome).unwrap();
            assert_eq!(serialized, format!("\"{}\"", outcome.as_str()));
            let deserialized: CliUpdateOutcome = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, outcome);
        }
        assert_eq!(
            "  alreadyLatest  ".parse::<CliUpdateOutcome>().unwrap(),
            CliUpdateOutcome::AlreadyLatest
        );
        assert!(matches!(
            "invalid".parse::<CliUpdateOutcome>(),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(!CliUpdateOutcome::Updated.is_failure());
        assert!(!CliUpdateOutcome::AlreadyLatest.is_failure());
        assert!(CliUpdateOutcome::VerificationFailed.is_failure());
        assert!(CliUpdateOutcome::Failed.is_failure());
    }
}
