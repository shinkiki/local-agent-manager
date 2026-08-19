use serde::{Deserialize, Serialize};

use crate::chat::{ChatApprovalMode, ChatMode, ReasoningEffort};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    Claude,
    Codex,
    Antigravity,
}

impl ProviderId {
    /// 시스템 에이전트로 고를 수 있는 공급자인지. 시스템 에이전트는 AIA 런타임을 겸하고
    /// AIA는 aia_system MCP로만 시스템을 조작하는데, Antigravity CLI에는 실행 단위 MCP
    /// 설정 플래그가 없어 그 인터페이스를 붙일 수 없다. 그래서 선택 대상에서 제외한다.
    pub fn can_run_system_agent(self) -> bool {
        matches!(self, Self::Claude | Self::Codex)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Antigravity => "antigravity",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedResource {
    pub detected: bool,
    pub path: Option<String>,
}

impl DetectedResource {
    pub fn missing() -> Self {
        Self {
            detected: false,
            path: None,
        }
    }

    pub fn found(path: impl Into<String>) -> Self {
        Self {
            detected: true,
            path: Some(path.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: ProviderId,
    pub display_name: String,
    pub cli: DetectedResource,
    pub history: DetectedResource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub schema_version: u32,
    pub platform: String,
    pub architecture: String,
    pub providers: Vec<ProviderStatus>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl TokenUsage {
    pub fn total(self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub favorite: bool,
    pub hidden: bool,
    pub note: Option<String>,
    pub custom_title: Option<String>,
    #[serde(default)]
    pub folder_ids: Vec<String>,
    /// 이 세션이 마지막으로 실행된 추론 수준. 이어가기 때 기본값으로 쓴다.
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
    /// 이 세션이 마지막으로 실행된 요청 모드. 이어가기 때 기본값으로 쓴다.
    #[serde(default)]
    pub mode: Option<ChatMode>,
    /// 이 세션이 마지막으로 실행된 승인 처리. 이어가기 때 기본값으로 쓴다.
    #[serde(default)]
    pub approval_mode: Option<ChatApprovalMode>,
    /// Agent Manager에서 새 세션을 만들 때 사용한 계정. 이후 활성계정 전환과 무관하다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_account_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFolder {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub session_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub source: ProviderId,
    pub id: String,
    pub title: String,
    pub source_title: Option<String>,
    pub project: Option<String>,
    pub cwd: Option<String>,
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub message_count: Option<u64>,
    pub token_total: Option<u64>,
    pub token_usage: Option<TokenUsage>,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub is_subagent: bool,
    pub archived: bool,
    pub readable: bool,
    pub size_bytes: Option<u64>,
    pub file_path: String,
    pub meta: SessionMeta,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCounts {
    pub claude: usize,
    pub codex: usize,
    pub antigravity: usize,
}

impl SourceCounts {
    pub fn increment(&mut self, source: ProviderId) {
        match source {
            ProviderId::Claude => self.claude += 1,
            ProviderId::Codex => self.codex += 1,
            ProviderId::Antigravity => self.antigravity += 1,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTotals {
    pub claude: u64,
    pub codex: u64,
    pub antigravity: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCount {
    pub model: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCount {
    pub name: String,
    pub path: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyCount {
    pub week_start: i64,
    pub claude: usize,
    pub codex: usize,
    pub antigravity: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStats {
    pub session_count: usize,
    pub sessions_by_source: SourceCounts,
    pub tokens: SourceTotals,
    pub disk: SourceTotals,
    pub skill_count: usize,
    pub agent_count: usize,
    pub models: Vec<ModelCount>,
    pub top_projects: Vec<ProjectCount>,
    pub weekly: Vec<WeeklyCount>,
    pub recent: Vec<SessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub source: ProviderId,
    pub scope: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub directory: String,
    pub origin: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub is_directory: bool,
    pub children: Vec<FileNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub skill: SkillSummary,
    pub body: String,
    pub files: Vec<FileNode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub model: Option<String>,
    pub max_turns: Option<u64>,
    pub permission_mode: Option<String>,
    pub skills: Vec<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetail {
    pub definition: AgentDefinition,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSummary {
    pub conversation_id: String,
    pub root_name: String,
    pub name: String,
    pub artifact_type: Option<String>,
    pub summary: Option<String>,
    pub updated_at: Option<i64>,
    pub version: Option<u64>,
    pub versions: Vec<u64>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactGroup {
    pub conversation_id: String,
    pub root_name: String,
    pub title: Option<String>,
    pub readable: bool,
    pub artifacts: Vec<ArtifactSummary>,
    pub image_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDetail {
    pub artifact: ArtifactSummary,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ContentBlock {
    Text { text: String },
    Context { label: String, text: String },
    Thinking { text: String },
    ToolUse { name: String, input_json: String },
    ToolResult { text: String, is_error: bool },
    SessionInfo(Box<SessionInfoBlock>),
    Raw { json: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfoBlock {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub originator: Option<String>,
    pub cli_version: Option<String>,
    pub source: Option<String>,
    pub model_provider: Option<String>,
    pub thread_source: Option<String>,
    pub history_mode: Option<String>,
    pub context_window_id: Option<String>,
    pub tool_count: usize,
    pub raw_json: String,
    pub raw_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptItem {
    pub index: usize,
    pub role: String,
    pub timestamp: Option<i64>,
    pub model: Option<String>,
    pub type_label: Option<String>,
    pub blocks: Vec<ContentBlock>,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session: SessionSummary,
    pub transcript: Vec<TranscriptItem>,
    pub truncated: bool,
    pub skipped_lines: usize,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionTranscriptLimit {
    Latest100,
    #[default]
    Latest500,
    Latest1000,
    All,
}

impl SessionTranscriptLimit {
    pub fn max_items(self) -> Option<usize> {
        match self {
            Self::Latest100 => Some(100),
            Self::Latest500 => Some(500),
            Self::Latest1000 => Some(1_000),
            Self::All => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageItem {
    pub id: String,
    pub label: String,
    pub description: String,
    pub size_bytes: u64,
    pub file_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplementStorageStats {
    pub turn_count: usize,
    pub session_count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    pub source_total_bytes: u64,
    pub manager_total_bytes: u64,
    pub total_bytes: u64,
    pub source_items: Vec<StorageUsageItem>,
    pub manager_items: Vec<StorageUsageItem>,
    pub supplements: SupplementStorageStats,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerSnapshot {
    pub schema_version: u32,
    pub session_catalog_revision: u64,
    pub resource_catalog_revision: u64,
    pub status: AppStatus,
    pub dashboard: DashboardStats,
    pub sessions: Vec<SessionSummary>,
    pub folders: Vec<SessionFolder>,
    pub skills: Vec<SkillSummary>,
    pub agents: Vec<AgentDefinition>,
    pub artifacts: Vec<ArtifactGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationLanguage {
    pub code: String,
    pub name: String,
}

impl TranslationLanguage {
    pub fn korean() -> Self {
        Self {
            code: "ko".to_owned(),
            name: "Korean".to_owned(),
        }
    }

    pub fn english() -> Self {
        Self {
            code: "en".to_owned(),
            name: "English".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranslationMenu {
    Skills,
    Agents,
    Artifacts,
}

impl TranslationMenu {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::Agents => "agents",
            Self::Artifacts => "artifacts",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationMenuSettings {
    pub skills: bool,
    pub agents: bool,
    pub artifacts: bool,
}

impl TranslationMenuSettings {
    pub fn enabled(self, menu: TranslationMenu) -> bool {
        match menu {
            TranslationMenu::Skills => self.skills,
            TranslationMenu::Agents => self.agents,
            TranslationMenu::Artifacts => self.artifacts,
        }
    }

    pub fn any(self) -> bool {
        self.skills || self.agents || self.artifacts
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAutomationSettings {
    #[serde(default = "TranslationLanguage::korean")]
    pub language: TranslationLanguage,
    #[serde(default)]
    pub additional_translation_languages: Vec<TranslationLanguage>,
    pub system_provider: Option<ProviderId>,
    #[serde(default)]
    pub translations: TranslationMenuSettings,
}

impl SystemAutomationSettings {
    /// AIA 시스템 에이전트가 실행될 공급자. 시스템 에이전트를 고르지 않았거나 더 이상
    /// 쓸 수 없는 값이 저장돼 있으면 AIA 기능 자체를 쓸 수 없다(`None`). 고르지 않은
    /// 상태에서 임의의 공급자로 대신 실행하면, 사용자가 끄기로 한 시스템 에이전트가
    /// 조용히 도는 셈이 되므로 자동번역과 같은 규칙으로 비활성화한다.
    pub fn aia_provider(&self) -> Option<ProviderId> {
        self.system_provider
            .filter(|provider| provider.can_run_system_agent())
    }
}

impl Default for SystemAutomationSettings {
    fn default() -> Self {
        Self {
            language: TranslationLanguage::korean(),
            additional_translation_languages: Vec::new(),
            system_provider: None,
            translations: TranslationMenuSettings::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAutomationSettingsInput {
    #[serde(default = "TranslationLanguage::korean")]
    pub language: TranslationLanguage,
    #[serde(default)]
    pub additional_translation_languages: Vec<TranslationLanguage>,
    pub system_provider: Option<ProviderId>,
    pub translations: TranslationMenuSettings,
}

impl From<SystemAutomationSettingsInput> for SystemAutomationSettings {
    fn from(value: SystemAutomationSettingsInput) -> Self {
        Self {
            language: value.language,
            additional_translation_languages: value.additional_translation_languages,
            system_provider: value.system_provider,
            translations: value.translations,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTranslationCatalogInput {
    pub version: String,
    pub messages: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLanguageRequest {
    pub language: TranslationLanguage,
    pub catalog: UiTranslationCatalogInput,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationStatus {
    pub phase: String,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub pending: usize,
    /// 이번 실행에서 다시 번역하지 않고 캐시를 그대로 쓴 리소스 수. `completed`에도
    /// 포함되므로, 실제 실행 대상은 `total - cached`로 읽는다.
    #[serde(default)]
    pub cached: usize,
    pub segment_total: usize,
    pub segment_completed: usize,
    pub segment_failed: usize,
    /// `cached`의 요청(세그먼트) 단위 값. `segment_completed`에도 포함된다.
    #[serde(default)]
    pub segment_cached: usize,
    pub current_field: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAutomationSnapshot {
    pub revision: u64,
    pub resource_catalog_revision: u64,
    pub settings: SystemAutomationSettings,
    pub pending_language: Option<TranslationLanguage>,
    pub ui_translation: TranslationStatus,
    pub ui_messages: std::collections::BTreeMap<String, String>,
    pub providers: Vec<ProviderStatus>,
    pub skills: TranslationStatus,
    pub agents: TranslationStatus,
    pub artifacts: TranslationStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSummary {
    pub resource_id: String,
    pub fields: std::collections::BTreeMap<String, String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuTranslations {
    pub menu: TranslationMenu,
    pub language: TranslationLanguage,
    pub enabled: bool,
    pub status: TranslationStatus,
    pub records: Vec<TranslationSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatedDetail {
    pub menu: TranslationMenu,
    pub resource_id: String,
    pub fields: std::collections::BTreeMap<String, String>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCatalogUpdate {
    pub revision: u64,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRoot {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub agent_data: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRootStatus {
    #[serde(flatten)]
    pub root: DocRoot,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocFile {
    pub root_id: String,
    pub relative_path: String,
    pub content: String,
    pub modified_at: i64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetaPatch {
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    pub note: Option<Option<String>>,
    pub custom_title: Option<Option<String>>,
    pub folder_ids: Option<Vec<String>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_frontend_contract_in_camel_case() {
        let status = AppStatus {
            schema_version: 1,
            platform: "macos".to_owned(),
            architecture: "aarch64".to_owned(),
            providers: vec![ProviderStatus {
                provider: ProviderId::Codex,
                display_name: "OpenAI Codex".to_owned(),
                cli: DetectedResource::found("/usr/local/bin/codex"),
                history: DetectedResource::missing(),
            }],
        };

        let value = serde_json::to_value(status).expect("status must serialize");

        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["providers"][0]["provider"], "codex");
        assert_eq!(value["providers"][0]["displayName"], "OpenAI Codex");
        assert_eq!(
            value["providers"][0]["history"]["path"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn session_transcript_limit_uses_the_typed_ipc_values_and_latest_500_default() {
        assert_eq!(SessionTranscriptLimit::default().max_items(), Some(500));
        assert_eq!(
            serde_json::to_value(SessionTranscriptLimit::Latest1000)
                .expect("serialize transcript limit"),
            "latest1000"
        );
        assert_eq!(
            serde_json::from_str::<SessionTranscriptLimit>("\"all\"")
                .expect("deserialize transcript limit"),
            SessionTranscriptLimit::All
        );
    }
}
