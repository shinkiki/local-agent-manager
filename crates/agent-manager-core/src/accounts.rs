use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::collections::HashSet;
use std::env;
use std::fs::{self, File, OpenOptions};
#[cfg(target_os = "macos")]
use std::io::Read;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::Instant;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use fs4::FileExt;
#[cfg(not(target_os = "macos"))]
use keyring::Entry;
use reqwest::blocking::Client;
use reqwest::header::{
    HeaderMap, HeaderValue, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, RETRY_AFTER, USER_AGENT,
};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::external_processes::external_provider_process_running;
use crate::{CoreError, ProviderId};

const REGISTRY_FILE: &str = "provider-accounts-v1.json";
const JOURNAL_FILE_PREFIX: &str = "provider-account-switch-journal-v1";
const REFRESH_JOURNAL_FILE_PREFIX: &str = "provider-credential-refresh-journal-v1";
const AUTH_DIR: &str = "provider-account-login";
const VAULT_SERVICE: &str = "com.shinc.agentmanager.credential-vault";
#[cfg(target_os = "macos")]
const LEGACY_VAULT_ACCOUNT: &str = "vault-v2";
const VAULT_ACCOUNT: &str = "vault-v3-security";
const VAULT_LOCK_FILE: &str = "provider-credential-vault-v3-security.lock";
const CREDENTIAL_VAULT_VERSION: u32 = 3;
#[cfg(target_os = "macos")]
const LEGACY_SINGLE_VAULT_VERSION: u32 = 2;
const SCHEMA_VERSION: u32 = 1;
const USAGE_TIMEOUT: Duration = Duration::from_secs(15);
const CLAUDE_OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
/// 공식 Claude Code CLI가 사용하는 공개 OAuth 클라이언트 ID.
const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// 만료 직전 토큰으로 호출해 401을 받기 전에 미리 갱신하도록 여유를 둔다.
const CLAUDE_TOKEN_EXPIRY_MARGIN_MS: i64 = 5 * 60_000;
const USAGE_ERROR_RETRY_MS: i64 = 5 * 60_000;
const CLAUDE_RATE_LIMIT_MIN_RETRY_MS: i64 = 30_000;
const CLAUDE_RATE_LIMIT_DEFAULT_RETRY_MS: i64 = 15 * 60_000;
const USAGE_STALE_THRESHOLD_MS: i64 = 30 * 60_000;
const RATE_LIMITED_STALE_THRESHOLD_MS: i64 = 24 * 60 * 60_000;
/// 자동전환 직후 같은 공급자에서 연쇄 전환이 반복되지 않도록 두는 최소 간격.
const AUTO_SWITCH_COOLDOWN_MS: i64 = 60_000;
/// 에이전트 세션이 제한 응답을 보고한 계정을 자동전환 후보에서 제외해 두는 기간.
const AGENT_LIMIT_RETRY_MS: i64 = 15 * 60_000;
#[cfg(target_os = "macos")]
const MACOS_SECURITY_BIN: &str = "/usr/bin/security";
#[cfg(target_os = "macos")]
const KEYCHAIN_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(target_os = "macos")]
const KEYCHAIN_MIGRATION_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(target_os = "macos")]
const KEYCHAIN_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(target_os = "macos")]
const MAX_KEYCHAIN_COMMAND_OUTPUT_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountAuthStatus {
    Ready,
    Missing,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountUsageStatus {
    Idle,
    Ok,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageWindow {
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageView {
    pub status: AccountUsageStatus,
    pub windows: Vec<AccountUsageWindow>,
    pub updated_at: Option<i64>,
    pub error: Option<String>,
    #[serde(default)]
    pub retry_at: Option<i64>,
    #[serde(default)]
    pub rate_limited: bool,
}

impl Default for AccountUsageView {
    fn default() -> Self {
        Self {
            status: AccountUsageStatus::Idle,
            windows: Vec::new(),
            updated_at: None,
            error: None,
            retry_at: None,
            rate_limited: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountView {
    pub id: String,
    pub provider: ProviderId,
    pub display_name: String,
    pub email: Option<String>,
    pub organization: Option<String>,
    pub provider_account_id: String,
    pub is_active: bool,
    pub is_default: bool,
    pub is_pending_default: bool,
    pub disabled: bool,
    pub auto_switch: bool,
    pub auth_status: AccountAuthStatus,
    pub usage: AccountUsageView,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountStateView {
    pub provider: ProviderId,
    pub default_account_id: Option<String>,
    pub active_account_id: Option<String>,
    pub observed_active_account_id: Option<String>,
    pub pending_default_account_id: Option<String>,
    pub runtime_count: usize,
    pub transition_in_progress: bool,
    pub transition: Option<ProviderAccountTransitionView>,
    pub recovery_error: Option<String>,
    pub last_auto_switch: Option<AutoSwitchEventView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountTransitionView {
    pub provider: ProviderId,
    pub transition_id: String,
    pub previous_active_account_id: String,
    pub target_account_id: String,
    pub runtime_count: usize,
    pub phase: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountTransitionRecovery {
    pub provider: ProviderId,
    pub transition_id: String,
    pub previous_active_account_id: String,
    pub target_account_id: String,
    pub restored: bool,
    pub lease_cleared: bool,
    pub already_recovered: bool,
    pub recovery_error: Option<String>,
}

/// 자동전환 트리거 종류. 사용량 100% 도달 또는 에이전트 세션의 제한 응답.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoSwitchReason {
    UsageExhausted,
    AgentLimited,
}

/// 자동전환 실행기(spawn_auto_switch_loop)로 전달되는 트리거 신호.
#[derive(Debug, Clone)]
pub struct AutoSwitchSignal {
    pub provider: ProviderId,
    pub account_id: String,
    pub reason: AutoSwitchReason,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSwitchEventView {
    pub from_account_id: String,
    pub to_account_id: String,
    pub reason: AutoSwitchReason,
    pub at: i64,
    /// 전환 직후 resume으로 재시작한 채팅 세션 수.
    pub resumed_session_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    pub accounts: Vec<ProviderAccountView>,
    pub providers: Vec<ProviderAccountStateView>,
    /// 자동전환으로 종료된 실행 중 채팅을 새 계정에서 resume으로 재시작할지 여부.
    pub auto_switch_resume: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLoginSessionView {
    pub id: String,
    pub provider: ProviderId,
    pub account_id: Option<String>,
    pub environment_variable: String,
    pub profile_path: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountRecord {
    id: String,
    provider: ProviderId,
    display_name: String,
    email: Option<String>,
    organization: Option<String>,
    provider_account_id: String,
    disabled: bool,
    #[serde(default)]
    auto_switch: bool,
    auth_status: AccountAuthStatus,
    usage: AccountUsageView,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderAccountState {
    provider: ProviderId,
    default_account_id: Option<String>,
    active_account_id: Option<String>,
    pending_default_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountRegistry {
    schema_version: u32,
    #[serde(default = "legacy_credential_vault_version")]
    credential_vault_version: u32,
    #[serde(default = "default_auto_switch_resume")]
    auto_switch_resume: bool,
    accounts: Vec<AccountRecord>,
    providers: Vec<ProviderAccountState>,
}

impl AccountRegistry {
    fn empty() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            credential_vault_version: CREDENTIAL_VAULT_VERSION,
            auto_switch_resume: default_auto_switch_resume(),
            accounts: Vec::new(),
            providers: [ProviderId::Codex, ProviderId::Claude]
                .into_iter()
                .map(|provider| ProviderAccountState {
                    provider,
                    default_account_id: None,
                    active_account_id: None,
                    pending_default_account_id: None,
                })
                .collect(),
        }
    }

    fn provider(&self, provider: ProviderId) -> Result<&ProviderAccountState, CoreError> {
        self.providers
            .iter()
            .find(|state| state.provider == provider)
            .ok_or_else(|| CoreError::InvalidInput("지원하지 않는 계정 공급자입니다".to_owned()))
    }

    fn provider_mut(
        &mut self,
        provider: ProviderId,
    ) -> Result<&mut ProviderAccountState, CoreError> {
        self.providers
            .iter_mut()
            .find(|state| state.provider == provider)
            .ok_or_else(|| CoreError::InvalidInput("지원하지 않는 계정 공급자입니다".to_owned()))
    }
}

fn legacy_credential_vault_version() -> u32 {
    1
}

/// 자동전환 후 세션 복원 옵션의 기본값(on). 이전 버전 레지스트리에는 필드가 없다.
fn default_auto_switch_resume() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwitchJournal {
    provider: ProviderId,
    previous_active_account_id: String,
    target_account_id: String,
    transition_id: String,
    phase: SwitchPhase,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialRefreshJournal {
    provider: ProviderId,
    account_id: String,
    operation_id: String,
    started_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SwitchPhase {
    Switching,
    Running,
    Restoring,
}

#[derive(Debug, Clone)]
struct AccountLoginSession {
    id: String,
    provider: ProviderId,
    account_id: Option<String>,
    profile_path: PathBuf,
}

#[derive(Debug, Clone)]
struct ActiveTransition {
    id: String,
    provider: ProviderId,
    previous_active_account_id: String,
    target_account_id: String,
}

struct AccountState {
    registry: AccountRegistry,
    runtime_counts: HashMap<ProviderId, usize>,
    runtime_account_counts: HashMap<String, usize>,
    observed_active_account_ids: HashMap<ProviderId, Option<String>>,
    transitions: HashMap<ProviderId, ActiveTransition>,
    recovery_error: HashMap<ProviderId, String>,
    logins: HashMap<String, AccountLoginSession>,
    auto_switch_events: HashMap<ProviderId, AutoSwitchEventView>,
}

trait CredentialVault: Send + Sync {
    fn put(&self, key: &str, secret: &str) -> Result<(), CoreError>;
    fn get(&self, key: &str) -> Result<Zeroizing<String>, CoreError>;
    fn delete(&self, key: &str) -> Result<(), CoreError>;
}

trait VaultDocumentStore: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<String>>, CoreError>;
    fn write(&self, document: &str) -> Result<(), CoreError>;
}

struct OsVaultDocumentStore {
    account: &'static str,
    #[cfg(target_os = "macos")]
    read_timeout: Duration,
}

struct OsCredentialVault {
    store: Arc<dyn VaultDocumentStore>,
    lock_path: PathBuf,
    operation_lock: Mutex<()>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct CredentialVaultDocument {
    schema_version: u32,
    entries: HashMap<String, String>,
}

impl CredentialVaultDocument {
    fn empty() -> Self {
        Self::empty_for_version(CREDENTIAL_VAULT_VERSION)
    }

    fn empty_for_version(schema_version: u32) -> Self {
        Self {
            schema_version,
            entries: HashMap::new(),
        }
    }
}

impl Drop for CredentialVaultDocument {
    fn drop(&mut self) {
        for secret in self.entries.values_mut() {
            secret.zeroize();
        }
    }
}

#[cfg(test)]
#[derive(Default)]
struct TestCredentialVault(Mutex<HashMap<String, String>>);

#[cfg(test)]
impl CredentialVault for TestCredentialVault {
    fn put(&self, key: &str, secret: &str) -> Result<(), CoreError> {
        self.0
            .lock()
            .map_err(|_| CoreError::Runtime("test vault lock".to_owned()))?
            .insert(key.to_owned(), secret.to_owned());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Zeroizing<String>, CoreError> {
        self.0
            .lock()
            .map_err(|_| CoreError::Runtime("test vault lock".to_owned()))?
            .get(key)
            .cloned()
            .map(Zeroizing::new)
            .ok_or_else(|| CoreError::NotFound("missing test credential".to_owned()))
    }

    fn delete(&self, key: &str) -> Result<(), CoreError> {
        self.0
            .lock()
            .map_err(|_| CoreError::Runtime("test vault lock".to_owned()))?
            .remove(key);
        Ok(())
    }
}

impl OsVaultDocumentStore {
    fn current() -> Self {
        Self {
            account: VAULT_ACCOUNT,
            #[cfg(target_os = "macos")]
            read_timeout: KEYCHAIN_COMMAND_TIMEOUT,
        }
    }

    #[cfg(target_os = "macos")]
    fn legacy_for_migration() -> Self {
        Self {
            account: LEGACY_VAULT_ACCOUNT,
            read_timeout: KEYCHAIN_MIGRATION_TIMEOUT,
        }
    }
}

impl VaultDocumentStore for OsVaultDocumentStore {
    fn read(&self) -> Result<Option<Zeroizing<String>>, CoreError> {
        #[cfg(target_os = "macos")]
        let result =
            read_os_keychain_password_with_timeout(VAULT_SERVICE, self.account, self.read_timeout);
        #[cfg(not(target_os = "macos"))]
        let result = read_os_keychain_password(VAULT_SERVICE, self.account);
        result.map_err(|error| {
            CoreError::Runtime(format!(
                "보안 저장소에서 자격증명 Vault를 읽지 못했습니다: {error}"
            ))
        })
    }

    fn write(&self, document: &str) -> Result<(), CoreError> {
        write_os_keychain_password(VAULT_SERVICE, self.account, document).map_err(|error| {
            CoreError::Runtime(format!(
                "자격증명 Vault를 보안 저장소에 저장하지 못했습니다: {error}"
            ))
        })
    }
}

impl OsCredentialVault {
    fn open(app_data_dir: &Path) -> Result<Self, CoreError> {
        fs::create_dir_all(app_data_dir)?;
        Ok(Self {
            store: Arc::new(OsVaultDocumentStore::current()),
            lock_path: fs::canonicalize(app_data_dir)?.join(VAULT_LOCK_FILE),
            operation_lock: Mutex::new(()),
        })
    }

    #[cfg(test)]
    fn with_store(
        app_data_dir: &Path,
        store: Arc<dyn VaultDocumentStore>,
    ) -> Result<Self, CoreError> {
        fs::create_dir_all(app_data_dir)?;
        Ok(Self {
            store,
            lock_path: fs::canonicalize(app_data_dir)?.join(VAULT_LOCK_FILE),
            operation_lock: Mutex::new(()),
        })
    }

    #[cfg(target_os = "macos")]
    fn replace_from_legacy_store(
        &self,
        legacy_store: &dyn VaultDocumentStore,
    ) -> Result<HashSet<String>, CoreError> {
        let _operation = lock(&self.operation_lock, "자격증명 Vault 마이그레이션")?;
        let file = open_lock_file(&self.lock_path)?;
        FileExt::lock(&file)?;
        let result = (|| {
            let serialized = legacy_store.read()?.ok_or_else(|| {
                CoreError::NotFound("v2 자격증명 Vault를 찾을 수 없습니다".to_owned())
            })?;
            let mut document = parse_vault_document(&serialized, LEGACY_SINGLE_VAULT_VERSION)
                .map_err(|_| {
                    CoreError::Runtime("v2 자격증명 Vault JSON이 손상되었습니다".to_owned())
                })?;
            validate_legacy_vault_entries(&document)?;
            let entry_keys = document.entries.keys().cloned().collect::<HashSet<_>>();
            document.schema_version = CREDENTIAL_VAULT_VERSION;
            save_vault_document(self.store.as_ref(), &document)?;
            let verified = load_vault_document(self.store.as_ref())?;
            if verified != document {
                return Err(CoreError::Runtime(
                    "v3 자격증명 Vault 저장 검증에 실패했습니다".to_owned(),
                ));
            }
            Ok(entry_keys)
        })();
        let unlock = FileExt::unlock(&file).map_err(CoreError::from);
        match (result, unlock) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }

    fn with_document<T>(
        &self,
        mutate: bool,
        action: impl FnOnce(&mut CredentialVaultDocument) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let _operation = lock(&self.operation_lock, "자격증명 Vault 작업")?;
        let file = open_lock_file(&self.lock_path)?;
        FileExt::lock(&file)?;
        let result = (|| {
            let mut document = load_vault_document(self.store.as_ref())?;
            let result = action(&mut document)?;
            if mutate {
                save_vault_document(self.store.as_ref(), &document)?;
            }
            Ok(result)
        })();
        let unlock = FileExt::unlock(&file).map_err(CoreError::from);
        match (result, unlock) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
    }
}

impl CredentialVault for OsCredentialVault {
    fn put(&self, key: &str, secret: &str) -> Result<(), CoreError> {
        self.with_document(true, |document| {
            document.entries.insert(key.to_owned(), secret.to_owned());
            Ok(())
        })
    }

    fn get(&self, key: &str) -> Result<Zeroizing<String>, CoreError> {
        self.with_document(false, |document| {
            document
                .entries
                .get(key)
                .cloned()
                .map(Zeroizing::new)
                .ok_or_else(|| {
                    CoreError::NotFound("보안 저장소에서 자격증명을 찾을 수 없습니다".to_owned())
                })
        })
    }

    fn delete(&self, key: &str) -> Result<(), CoreError> {
        self.with_document(true, |document| {
            document.entries.remove(key);
            Ok(())
        })
    }
}

fn open_lock_file(path: &Path) -> Result<File, CoreError> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    options.mode(0o600);
    Ok(options.open(path)?)
}

fn load_vault_document(
    store: &dyn VaultDocumentStore,
) -> Result<CredentialVaultDocument, CoreError> {
    let Some(serialized) = store.read()? else {
        return Ok(CredentialVaultDocument::empty());
    };
    parse_vault_document(&serialized, CREDENTIAL_VAULT_VERSION)
}

fn parse_vault_document(
    serialized: &str,
    expected_version: u32,
) -> Result<CredentialVaultDocument, CoreError> {
    let document: CredentialVaultDocument = serde_json::from_str(serialized)?;
    if document.schema_version != expected_version {
        return Err(CoreError::InvalidInput(
            "지원하지 않는 자격증명 Vault 버전입니다".to_owned(),
        ));
    }
    Ok(document)
}

fn validate_legacy_vault_entries(document: &CredentialVaultDocument) -> Result<(), CoreError> {
    if document.entries.is_empty() {
        return Err(CoreError::InvalidInput(
            "v2 자격증명 Vault에 마이그레이션할 계정이 없습니다".to_owned(),
        ));
    }
    for (key, secret) in &document.entries {
        if key.len() > 1024
            || !(key.starts_with("codex:") || key.starts_with("claude:"))
            || key
                .bytes()
                .any(|byte| matches!(byte, b'\0' | b'\r' | b'\n'))
        {
            return Err(CoreError::InvalidInput(
                "v2 자격증명 Vault의 계정 키가 올바르지 않습니다".to_owned(),
            ));
        }
        let value: Value = serde_json::from_str(secret)
            .map_err(|_| CoreError::Runtime("v2 계정 자격증명 JSON이 손상되었습니다".to_owned()))?;
        if !value.is_object() {
            return Err(CoreError::Runtime(
                "v2 계정 자격증명 JSON 형식이 올바르지 않습니다".to_owned(),
            ));
        }
    }
    Ok(())
}

fn save_vault_document(
    store: &dyn VaultDocumentStore,
    document: &CredentialVaultDocument,
) -> Result<(), CoreError> {
    let serialized = Zeroizing::new(serde_json::to_string(document)?);
    store.write(&serialized)
}

#[cfg(not(target_os = "macos"))]
fn vault_error(prefix: &'static str) -> impl FnOnce(keyring::Error) -> CoreError {
    move |error| CoreError::Runtime(format!("{prefix}: {error}"))
}

#[cfg(target_os = "macos")]
struct MacosSecurityOutput {
    status: ExitStatus,
    stdout: Zeroizing<Vec<u8>>,
    stderr: Zeroizing<Vec<u8>>,
}

#[cfg(target_os = "macos")]
fn validate_keychain_field(value: &str, field: &str) -> Result<(), CoreError> {
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(format!(
            "Keychain {field} 값이 올바르지 않습니다"
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_security_executable() -> Result<PathBuf, CoreError> {
    let executable = fs::canonicalize(MACOS_SECURITY_BIN).map_err(|error| {
        CoreError::Runtime(format!(
            "macOS security 도구를 확인하지 못했습니다: {error}"
        ))
    })?;
    if !executable.is_file() {
        return Err(CoreError::Runtime(
            "macOS security 도구가 실행 파일이 아닙니다".to_owned(),
        ));
    }
    Ok(executable)
}

#[cfg(target_os = "macos")]
fn read_bounded_command_output(
    mut stream: impl Read + Send + 'static,
) -> thread::JoinHandle<Result<Vec<u8>, std::io::Error>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        stream
            .by_ref()
            .take(MAX_KEYCHAIN_COMMAND_OUTPUT_BYTES + 1)
            .read_to_end(&mut output)?;
        if output.len() as u64 > MAX_KEYCHAIN_COMMAND_OUTPUT_BYTES {
            output.zeroize();
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "security command output exceeded the limit",
            ));
        }
        Ok(output)
    })
}

#[cfg(target_os = "macos")]
fn run_macos_security_with_executable(
    executable: &Path,
    args: &[&str],
    secret_stdin: Option<&str>,
) -> Result<MacosSecurityOutput, CoreError> {
    run_macos_security_with_executable_and_timeout(
        executable,
        args,
        secret_stdin,
        KEYCHAIN_COMMAND_TIMEOUT,
    )
}

#[cfg(target_os = "macos")]
fn run_macos_security_with_executable_and_timeout(
    executable: &Path,
    args: &[&str],
    secret_stdin: Option<&str>,
    timeout: Duration,
) -> Result<MacosSecurityOutput, CoreError> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(if secret_stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: `setsid` is the only operation performed between fork and exec.
    // Detaching the controlling terminal makes `security ... -w` consume the
    // piped stdin instead of opening `/dev/tty` during `tauri dev`.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!(
            "macOS security 도구를 실행하지 못했습니다: {error}"
        ))
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CoreError::Runtime("security 표준 출력을 열지 못했습니다".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CoreError::Runtime("security 오류 출력을 열지 못했습니다".to_owned()))?;
    let stdout_reader = read_bounded_command_output(stdout);
    let stderr_reader = read_bounded_command_output(stderr);

    if let Some(secret) = secret_stdin {
        let input_result = child.stdin.take().ok_or(()).and_then(|mut stdin| {
            stdin.write_all(secret.as_bytes()).map_err(|_| ())?;
            stdin.write_all(b"\n").map_err(|_| ())?;
            stdin.flush().map_err(|_| ())
        });
        if input_result.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(CoreError::Runtime(
                "security 보안 입력을 전달하지 못했습니다".to_owned(),
            ));
        }
    }

    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            CoreError::Runtime(format!(
                "macOS security 상태를 확인하지 못했습니다: {error}"
            ))
        })? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(CoreError::Runtime(
                "macOS security 응답 시간이 초과되었습니다".to_owned(),
            ));
        }
        thread::sleep(KEYCHAIN_COMMAND_POLL_INTERVAL);
    };

    let stdout = stdout_reader
        .join()
        .map_err(|_| CoreError::Runtime("security 출력 처리가 중단되었습니다".to_owned()))?
        .map_err(|_| CoreError::Runtime("security 출력을 읽지 못했습니다".to_owned()))?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| CoreError::Runtime("security 오류 처리가 중단되었습니다".to_owned()))?
        .map_err(|_| CoreError::Runtime("security 오류를 읽지 못했습니다".to_owned()))?;
    Ok(MacosSecurityOutput {
        status,
        stdout: Zeroizing::new(stdout),
        stderr: Zeroizing::new(stderr),
    })
}

#[cfg(target_os = "macos")]
fn run_macos_security(
    args: &[&str],
    secret_stdin: Option<&str>,
) -> Result<MacosSecurityOutput, CoreError> {
    run_macos_security_with_executable(&macos_security_executable()?, args, secret_stdin)
}

#[cfg(target_os = "macos")]
fn run_macos_security_with_timeout(
    args: &[&str],
    secret_stdin: Option<&str>,
    timeout: Duration,
) -> Result<MacosSecurityOutput, CoreError> {
    run_macos_security_with_executable_and_timeout(
        &macos_security_executable()?,
        args,
        secret_stdin,
        timeout,
    )
}

#[cfg(target_os = "macos")]
fn macos_keychain_item_not_found(output: &MacosSecurityOutput) -> bool {
    if output.status.code() == Some(44) {
        return true;
    }
    let stderr = Zeroizing::new(String::from_utf8_lossy(&output.stderr).to_ascii_lowercase());
    stderr.contains("could not be found") || stderr.contains("not be found")
}

#[cfg(target_os = "macos")]
fn read_os_keychain_password(
    service: &str,
    account: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    read_os_keychain_password_with_timeout(service, account, KEYCHAIN_COMMAND_TIMEOUT)
}

#[cfg(target_os = "macos")]
fn read_os_keychain_password_with_timeout(
    service: &str,
    account: &str,
    timeout: Duration,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    validate_keychain_field(service, "service")?;
    validate_keychain_field(account, "account")?;
    let output = run_macos_security_with_timeout(
        &["find-generic-password", "-s", service, "-a", account, "-w"],
        None,
        timeout,
    )?;
    if !output.status.success() {
        if macos_keychain_item_not_found(&output) {
            return Ok(None);
        }
        return Err(CoreError::Runtime(format!(
            "macOS Keychain 읽기가 실패했습니다 (종료 코드 {})",
            output.status.code().unwrap_or(-1)
        )));
    }

    let mut stdout = output.stdout;
    if stdout.last() == Some(&b'\n') {
        stdout.pop();
    }
    let bytes = std::mem::take(stdout.as_mut());
    match String::from_utf8(bytes) {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(error) => {
            let mut bytes = error.into_bytes();
            bytes.zeroize();
            Err(CoreError::Runtime(
                "macOS Keychain 값이 UTF-8이 아닙니다".to_owned(),
            ))
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn read_os_keychain_password(
    service: &str,
    account: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    let entry =
        Entry::new(service, account).map_err(vault_error("OS 보안 저장소를 열지 못했습니다"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(CoreError::Runtime(format!(
            "OS 보안 저장소를 읽지 못했습니다: {error}"
        ))),
    }
}

#[cfg(target_os = "macos")]
fn write_os_keychain_password(service: &str, account: &str, secret: &str) -> Result<(), CoreError> {
    write_macos_keychain_password_with_executable(
        &macos_security_executable()?,
        service,
        account,
        secret,
    )
}

#[cfg(target_os = "macos")]
fn write_macos_keychain_password_with_executable(
    executable: &Path,
    service: &str,
    account: &str,
    secret: &str,
) -> Result<(), CoreError> {
    validate_keychain_field(service, "service")?;
    validate_keychain_field(account, "account")?;
    if secret
        .as_bytes()
        .iter()
        .any(|byte| matches!(byte, b'\r' | b'\n'))
    {
        return Err(CoreError::InvalidInput(
            "macOS Keychain에 저장할 값은 단일 행이어야 합니다".to_owned(),
        ));
    }
    let output = run_macos_security_with_executable(
        executable,
        &[
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            account,
            "-w",
            secret,
        ],
        None,
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(CoreError::Runtime(format!(
            "macOS Keychain 저장이 실패했습니다 (종료 코드 {})",
            output.status.code().unwrap_or(-1)
        )))
    }
}

#[cfg(not(target_os = "macos"))]
fn write_os_keychain_password(service: &str, account: &str, secret: &str) -> Result<(), CoreError> {
    Entry::new(service, account)
        .map_err(vault_error("OS 보안 저장소를 열지 못했습니다"))?
        .set_password(secret)
        .map_err(vault_error("OS 보안 저장소에 저장하지 못했습니다"))
}

#[cfg(target_os = "macos")]
fn delete_os_keychain_password(service: &str, account: &str) -> Result<(), CoreError> {
    validate_keychain_field(service, "service")?;
    validate_keychain_field(account, "account")?;
    let output = run_macos_security(
        &["delete-generic-password", "-s", service, "-a", account],
        None,
    )?;
    if output.status.success() || macos_keychain_item_not_found(&output) {
        Ok(())
    } else {
        Err(CoreError::Runtime(format!(
            "macOS Keychain 삭제가 실패했습니다 (종료 코드 {})",
            output.status.code().unwrap_or(-1)
        )))
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_os_keychain_password(service: &str, account: &str) -> Result<(), CoreError> {
    match Entry::new(service, account)
        .map_err(vault_error("OS 보안 저장소를 열지 못했습니다"))?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(CoreError::Runtime(format!(
            "OS 보안 저장소에서 삭제하지 못했습니다: {error}"
        ))),
    }
}

fn restore_vault_value(
    vault: &dyn CredentialVault,
    key: &str,
    previous: Option<&str>,
) -> Result<(), CoreError> {
    if let Some(previous) = previous {
        vault.put(key, previous)
    } else {
        vault.delete(key)
    }
}

#[derive(Clone)]
pub struct AccountSupervisor {
    inner: Arc<AccountInner>,
}

type ClaudeIdentityResolver =
    dyn Fn(&str) -> Result<AccountIdentity, CoreError> + Send + Sync + 'static;

struct AccountOpenConfig {
    codex_home_dir: PathBuf,
    claude_config_dir: PathBuf,
    claude_keychain_profile: Option<PathBuf>,
    inspect_external_processes: bool,
    claude_identity_resolver: Arc<ClaudeIdentityResolver>,
}

struct AccountInner {
    app_data_dir: PathBuf,
    home_dir: PathBuf,
    codex_home_dir: PathBuf,
    claude_config_dir: PathBuf,
    claude_keychain_profile: Option<PathBuf>,
    inspect_external_processes: bool,
    vault: Arc<dyn CredentialVault>,
    claude_identity_resolver: Arc<ClaudeIdentityResolver>,
    codex_switch_lock: Mutex<()>,
    claude_switch_lock: Mutex<()>,
    codex_usage_lock: Mutex<()>,
    claude_usage_lock: Mutex<()>,
    auto_switch_tx: Mutex<Option<Sender<AutoSwitchSignal>>>,
    // reconciled_snapshot 폴링이 마지막으로 활성 계정 검증을 수행한 시각.
    active_verification_at: Mutex<Option<Instant>>,
    state: Mutex<AccountState>,
}

pub struct AccountRuntimeLease {
    accounts: AccountSupervisor,
    provider: ProviderId,
    account_id: Option<String>,
    released: bool,
}

pub struct AccountTransitionGuard {
    accounts: AccountSupervisor,
    transition_id: String,
    restored: bool,
}

impl AccountSupervisor {
    pub fn open(app_data_dir: impl AsRef<Path>) -> Result<Self, CoreError> {
        let home_dir = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
            .ok_or(CoreError::HomeDirectoryUnavailable)?;
        let codex_home_dir = env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir.join(".codex"));
        let claude_keychain_profile = env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
        let claude_config_dir = claude_keychain_profile
            .clone()
            .unwrap_or_else(|| home_dir.join(".claude"));
        Self::open_resolved(
            app_data_dir.as_ref(),
            &home_dir,
            Arc::new(OsCredentialVault::open(app_data_dir.as_ref())?),
            AccountOpenConfig {
                codex_home_dir,
                claude_config_dir,
                claude_keychain_profile,
                inspect_external_processes: true,
                claude_identity_resolver: Arc::new(request_claude_profile_identity),
            },
        )
    }

    #[cfg(test)]
    fn open_with(
        app_data_dir: &Path,
        home_dir: &Path,
        vault: Arc<dyn CredentialVault>,
    ) -> Result<Self, CoreError> {
        Self::open_resolved(
            app_data_dir,
            home_dir,
            vault,
            AccountOpenConfig {
                codex_home_dir: home_dir.join(".codex"),
                claude_config_dir: home_dir.join(".claude"),
                claude_keychain_profile: None,
                inspect_external_processes: false,
                claude_identity_resolver: Arc::new(claude_identity_from_secret),
            },
        )
    }

    #[cfg(test)]
    fn open_with_claude_identity_resolver(
        app_data_dir: &Path,
        home_dir: &Path,
        vault: Arc<dyn CredentialVault>,
        claude_identity_resolver: Arc<ClaudeIdentityResolver>,
    ) -> Result<Self, CoreError> {
        Self::open_resolved(
            app_data_dir,
            home_dir,
            vault,
            AccountOpenConfig {
                codex_home_dir: home_dir.join(".codex"),
                claude_config_dir: home_dir.join(".claude"),
                claude_keychain_profile: None,
                inspect_external_processes: false,
                claude_identity_resolver,
            },
        )
    }

    #[cfg(test)]
    pub(crate) fn open_for_test(app_data_dir: &Path, home_dir: &Path) -> Result<Self, CoreError> {
        Self::open_with(
            app_data_dir,
            home_dir,
            Arc::new(TestCredentialVault::default()),
        )
    }

    fn open_resolved(
        app_data_dir: &Path,
        home_dir: &Path,
        vault: Arc<dyn CredentialVault>,
        config: AccountOpenConfig,
    ) -> Result<Self, CoreError> {
        fs::create_dir_all(app_data_dir)?;
        let app_data_dir = fs::canonicalize(app_data_dir)?;
        let home_dir = fs::canonicalize(home_dir)?;
        let mut registry = load_registry(&app_data_dir)?;
        validate_registry(&registry)?;
        migrate_registry_to_single_vault(&app_data_dir, &mut registry)?;
        let supervisor = Self {
            inner: Arc::new(AccountInner {
                app_data_dir,
                home_dir,
                codex_home_dir: config.codex_home_dir,
                claude_config_dir: config.claude_config_dir,
                claude_keychain_profile: config.claude_keychain_profile,
                inspect_external_processes: config.inspect_external_processes,
                vault,
                claude_identity_resolver: config.claude_identity_resolver,
                codex_switch_lock: Mutex::new(()),
                claude_switch_lock: Mutex::new(()),
                codex_usage_lock: Mutex::new(()),
                claude_usage_lock: Mutex::new(()),
                auto_switch_tx: Mutex::new(None),
                active_verification_at: Mutex::new(None),
                state: Mutex::new(AccountState {
                    registry,
                    runtime_counts: HashMap::new(),
                    runtime_account_counts: HashMap::new(),
                    observed_active_account_ids: HashMap::new(),
                    transitions: HashMap::new(),
                    recovery_error: HashMap::new(),
                    logins: HashMap::new(),
                    auto_switch_events: HashMap::new(),
                }),
            }),
        };
        supervisor.cleanup_orphan_login_profiles()?;
        supervisor.recover_interrupted_switch()?;
        supervisor.recover_interrupted_refresh()?;
        supervisor.verify_registered_active_accounts()?;
        Ok(supervisor)
    }

    pub fn snapshot(&self) -> Result<AccountSnapshot, CoreError> {
        self.apply_pending_defaults_if_idle();
        let mut journals = HashMap::new();
        for provider in [ProviderId::Codex, ProviderId::Claude] {
            if let Some(journal) = load_journal(&self.inner.app_data_dir, provider)? {
                journals.insert(provider, journal);
            }
        }
        let state = lock(&self.inner.state, "계정 상태")?;
        let mut accounts = state
            .registry
            .accounts
            .iter()
            .map(|account| {
                let provider = state.registry.provider(account.provider)?;
                Ok(ProviderAccountView {
                    id: account.id.clone(),
                    provider: account.provider,
                    display_name: account.display_name.clone(),
                    email: account.email.clone(),
                    organization: account.organization.clone(),
                    provider_account_id: account.provider_account_id.clone(),
                    is_active: provider.active_account_id.as_deref() == Some(&account.id),
                    is_default: provider.default_account_id.as_deref() == Some(&account.id),
                    is_pending_default: provider.pending_default_account_id.as_deref()
                        == Some(&account.id),
                    disabled: account.disabled,
                    auto_switch: account.auto_switch,
                    auth_status: account.auth_status,
                    usage: account.usage.clone(),
                })
            })
            .collect::<Result<Vec<_>, CoreError>>()?;
        accounts.sort_by(|left, right| {
            left.provider
                .as_str()
                .cmp(right.provider.as_str())
                .then_with(|| left.display_name.cmp(&right.display_name))
        });
        let providers = state
            .registry
            .providers
            .iter()
            .map(|provider| ProviderAccountStateView {
                provider: provider.provider,
                default_account_id: provider.default_account_id.clone(),
                active_account_id: provider.active_account_id.clone(),
                observed_active_account_id: state
                    .observed_active_account_ids
                    .get(&provider.provider)
                    .cloned()
                    .flatten(),
                pending_default_account_id: provider.pending_default_account_id.clone(),
                runtime_count: state
                    .runtime_counts
                    .get(&provider.provider)
                    .copied()
                    .unwrap_or(0),
                transition_in_progress: state.transitions.contains_key(&provider.provider)
                    || journals.contains_key(&provider.provider),
                transition: state
                    .transitions
                    .get(&provider.provider)
                    .map(|transition| ProviderAccountTransitionView {
                        provider: transition.provider,
                        transition_id: transition.id.clone(),
                        previous_active_account_id: transition.previous_active_account_id.clone(),
                        target_account_id: transition.target_account_id.clone(),
                        runtime_count: state
                            .runtime_counts
                            .get(&provider.provider)
                            .copied()
                            .unwrap_or(0),
                        phase: "running".to_owned(),
                    })
                    .or_else(|| {
                        journals.get(&provider.provider).map(|journal| {
                            ProviderAccountTransitionView {
                                provider: journal.provider,
                                transition_id: journal.transition_id.clone(),
                                previous_active_account_id: journal
                                    .previous_active_account_id
                                    .clone(),
                                target_account_id: journal.target_account_id.clone(),
                                runtime_count: state
                                    .runtime_counts
                                    .get(&provider.provider)
                                    .copied()
                                    .unwrap_or(0),
                                phase: match journal.phase {
                                    SwitchPhase::Switching => "switching",
                                    SwitchPhase::Running => "running",
                                    SwitchPhase::Restoring => "restoring",
                                }
                                .to_owned(),
                            }
                        })
                    }),
                recovery_error: state.recovery_error.get(&provider.provider).cloned(),
                last_auto_switch: state.auto_switch_events.get(&provider.provider).cloned(),
            })
            .collect();
        Ok(AccountSnapshot {
            accounts,
            providers,
            auto_switch_resume: state.registry.auto_switch_resume,
        })
    }

    /// 공유 CLI 홈을 다시 읽어 실제 활성 계정을 레지스트리에 반영한 최신 상태를 반환한다.
    /// 신원이 기존 계정과 일치하면 해당 계정을 선택하고, 처음 보는 계정이면 Vault와
    /// 비밀정보가 제거된 레지스트리에 새로 등록한다.
    pub fn reconciled_snapshot(&self) -> Result<AccountSnapshot, CoreError> {
        if self.should_reverify_active_accounts()? {
            self.verify_registered_active_accounts()?;
        }
        self.snapshot()
    }

    /// 활성 계정 검증은 계정마다 macOS Keychain(security) 하위 프로세스를 실행해
    /// 호출당 수백 ms가 걸리고 계정 전환 잠금도 점유한다. 주기 폴링이 매번 반복하지
    /// 않도록 최소 간격을 두고, 첫 호출은 항상 검증한다.
    fn should_reverify_active_accounts(&self) -> Result<bool, CoreError> {
        const ACTIVE_ACCOUNT_VERIFY_INTERVAL: Duration = Duration::from_secs(30);
        let mut verified_at = lock(&self.inner.active_verification_at, "계정 검증 시각")?;
        if verified_at.is_some_and(|at| at.elapsed() < ACTIVE_ACCOUNT_VERIFY_INTERVAL) {
            return Ok(false);
        }
        *verified_at = Some(Instant::now());
        Ok(true)
    }

    pub fn register_current(
        &self,
        provider: ProviderId,
        display_name: Option<String>,
    ) -> Result<AccountSnapshot, CoreError> {
        ensure_managed_provider(provider)?;
        let captured = self.capture_credentials(provider, None)?;
        self.upsert_captured_account(provider, None, display_name, captured, true)?;
        self.snapshot()
    }

    pub fn begin_login(
        &self,
        provider: ProviderId,
        account_id: Option<&str>,
    ) -> Result<AccountLoginSessionView, CoreError> {
        ensure_managed_provider(provider)?;
        if let Some(account_id) = account_id {
            let state = lock(&self.inner.state, "계정 상태")?;
            let account = account_by_id(&state.registry, account_id)?;
            if account.provider != provider {
                return Err(CoreError::InvalidInput(
                    "재인증 계정과 공급자가 일치하지 않습니다".to_owned(),
                ));
            }
        }
        let id = Uuid::new_v4().to_string();
        let auth_root = self.inner.app_data_dir.join(AUTH_DIR);
        fs::create_dir_all(&auth_root)?;
        let profile_path = auth_root.join(&id);
        fs::create_dir(&profile_path)?;
        let login = AccountLoginSession {
            id: id.clone(),
            provider,
            account_id: account_id.map(str::to_owned),
            profile_path: fs::canonicalize(profile_path)?,
        };
        let view = login_view(&login);
        lock(&self.inner.state, "계정 로그인 상태")?
            .logins
            .insert(id, login);
        Ok(view)
    }

    pub fn login_session(&self, id: &str) -> Result<AccountLoginSessionView, CoreError> {
        let state = lock(&self.inner.state, "계정 로그인 상태")?;
        state
            .logins
            .get(id)
            .map(login_view)
            .ok_or_else(|| CoreError::NotFound("계정 로그인 세션을 찾을 수 없습니다".to_owned()))
    }

    pub fn finish_login(
        &self,
        login_id: &str,
        display_name: Option<String>,
    ) -> Result<AccountSnapshot, CoreError> {
        let login = {
            let state = lock(&self.inner.state, "계정 로그인 상태")?;
            state.logins.get(login_id).cloned().ok_or_else(|| {
                CoreError::NotFound("계정 로그인 세션을 찾을 수 없습니다".to_owned())
            })?
        };
        let captured = self.capture_credentials(login.provider, Some(&login.profile_path))?;
        self.upsert_captured_account(
            login.provider,
            login.account_id.as_deref(),
            display_name,
            captured,
            false,
        )?;
        self.remove_login(login_id)?;
        self.snapshot()
    }

    pub fn cancel_login(&self, login_id: &str) -> Result<(), CoreError> {
        self.remove_login(login_id)
    }

    pub fn set_default(&self, account_id: &str) -> Result<AccountSnapshot, CoreError> {
        let provider = {
            let mut state = lock(&self.inner.state, "계정 상태")?;
            let account = account_by_id(&state.registry, account_id)?;
            if account.disabled {
                return Err(CoreError::Conflict(
                    "비활성화된 계정은 기본 계정으로 선택할 수 없습니다".to_owned(),
                ));
            }
            if account.auth_status != AccountAuthStatus::Ready {
                return Err(CoreError::Conflict(
                    "재인증이 필요한 계정은 기본 계정으로 선택할 수 없습니다".to_owned(),
                ));
            }
            let provider = account.provider;
            let provider_state = state.registry.provider_mut(provider)?;
            provider_state.default_account_id = Some(account_id.to_owned());
            provider_state.pending_default_account_id = Some(account_id.to_owned());
            save_registry(&self.inner.app_data_dir, &state.registry)?;
            provider
        };
        self.apply_pending_default(provider)?;
        self.snapshot()
    }

    pub fn set_active(&self, account_id: &str) -> Result<AccountSnapshot, CoreError> {
        let provider = {
            let state = lock(&self.inner.state, "계정 상태")?;
            let account = account_by_id(&state.registry, account_id)?;
            if account.disabled {
                return Err(CoreError::Conflict(
                    "비활성화된 계정으로 전환할 수 없습니다".to_owned(),
                ));
            }
            if account.auth_status != AccountAuthStatus::Ready {
                return Err(CoreError::Conflict(
                    "재인증이 필요한 계정으로 전환할 수 없습니다".to_owned(),
                ));
            }
            account.provider
        };
        self.activate_account_immediately(provider, account_id)?;
        self.snapshot()
    }

    /// 등록된 계정 ID의 소속 공급자를 조회한다.
    pub fn account_provider(&self, account_id: &str) -> Result<ProviderId, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        Ok(account_by_id(&state.registry, account_id)?.provider)
    }

    pub fn set_disabled(
        &self,
        account_id: &str,
        disabled: bool,
    ) -> Result<AccountSnapshot, CoreError> {
        let mut state = lock(&self.inner.state, "계정 상태")?;
        let (provider, is_active, is_observed_active) = {
            let account = account_by_id(&state.registry, account_id)?;
            let provider = account.provider;
            let is_active = state
                .registry
                .provider(provider)?
                .active_account_id
                .as_deref()
                == Some(account_id);
            let is_observed_active = state
                .observed_active_account_ids
                .get(&provider)
                .and_then(|account_id| account_id.as_deref())
                == Some(account_id);
            (provider, is_active, is_observed_active)
        };
        if disabled && (is_active || is_observed_active) {
            return Err(CoreError::Conflict(
                "Agent Manager 선택 또는 CLI 실제 활성 계정은 비활성화할 수 없습니다".to_owned(),
            ));
        }
        let account = account_by_id_mut(&mut state.registry, account_id)?;
        account.disabled = disabled;
        account.updated_at = now_ms();
        let provider_state = state.registry.provider_mut(provider)?;
        if disabled {
            if provider_state.default_account_id.as_deref() == Some(account_id) {
                provider_state.default_account_id = None;
            }
            if provider_state.pending_default_account_id.as_deref() == Some(account_id) {
                provider_state.pending_default_account_id = None;
            }
        }
        save_registry(&self.inner.app_data_dir, &state.registry)?;
        drop(state);
        self.snapshot()
    }

    pub fn set_auto_switch(
        &self,
        account_id: &str,
        auto_switch: bool,
    ) -> Result<AccountSnapshot, CoreError> {
        let mut state = lock(&self.inner.state, "계정 상태")?;
        let account = account_by_id_mut(&mut state.registry, account_id)?;
        account.auto_switch = auto_switch;
        account.updated_at = now_ms();
        save_registry(&self.inner.app_data_dir, &state.registry)?;
        drop(state);
        self.snapshot()
    }

    /// 자동전환 후 세션 복원 옵션 값. 자동전환 실행기가 전환 직전에 조회한다.
    pub fn auto_switch_resume_enabled(&self) -> Result<bool, CoreError> {
        Ok(lock(&self.inner.state, "계정 상태")?
            .registry
            .auto_switch_resume)
    }

    pub fn set_auto_switch_resume(&self, enabled: bool) -> Result<AccountSnapshot, CoreError> {
        let mut state = lock(&self.inner.state, "계정 상태")?;
        state.registry.auto_switch_resume = enabled;
        save_registry(&self.inner.app_data_dir, &state.registry)?;
        drop(state);
        self.snapshot()
    }

    /// 자동전환 실행기로 트리거 신호를 전달할 채널을 등록한다.
    pub fn set_auto_switch_signal_sender(&self, sender: Sender<AutoSwitchSignal>) {
        if let Ok(mut slot) = self.inner.auto_switch_tx.lock() {
            *slot = Some(sender);
        }
    }

    fn signal_auto_switch(&self, signal: AutoSwitchSignal) {
        let Ok(slot) = self.inner.auto_switch_tx.lock() else {
            return;
        };
        if let Some(sender) = slot.as_ref() {
            let _ = sender.send(signal);
        }
    }

    /// 에이전트 세션이 사용량 제한 응답을 받았을 때 호출된다. 해당 계정을 자동전환
    /// 후보에서 잠시 제외하도록 사용량 캐시에 표시하고 자동전환 트리거를 보낸다.
    pub fn report_agent_usage_limit(&self, account_id: &str) -> Result<(), CoreError> {
        let now = now_ms();
        let provider = {
            let mut state = lock(&self.inner.state, "계정 상태")?;
            let account = account_by_id_mut(&mut state.registry, account_id)?;
            let provider = account.provider;
            let already_marked = account.usage.rate_limited
                && account
                    .usage
                    .retry_at
                    .is_some_and(|retry_at| retry_at > now);
            if !already_marked {
                account.usage.rate_limited = true;
                account.usage.retry_at = Some(now + AGENT_LIMIT_RETRY_MS);
                account.usage.error =
                    Some("에이전트 세션이 사용량 제한 응답을 받았습니다".to_owned());
                account.updated_at = now;
                save_registry(&self.inner.app_data_dir, &state.registry)?;
            }
            provider
        };
        self.signal_auto_switch(AutoSwitchSignal {
            provider,
            account_id: account_id.to_owned(),
            reason: AutoSwitchReason::AgentLimited,
        });
        Ok(())
    }

    /// 자동전환 트리거를 검증하고 전환할 다음 후보 계정을 고른다. 전환하지 않아야
    /// 하면 None을 반환한다. 실제 전환(세션 정리·자격증명 교체)은 호출자가 수행한다.
    pub fn plan_auto_switch(&self, signal: &AutoSwitchSignal) -> Result<Option<String>, CoreError> {
        let now = now_ms();
        let state = lock(&self.inner.state, "계정 상태")?;
        if state.transitions.contains_key(&signal.provider) {
            return Ok(None);
        }
        if let Some(event) = state.auto_switch_events.get(&signal.provider) {
            if now - event.at < AUTO_SWITCH_COOLDOWN_MS {
                return Ok(None);
            }
        }
        let provider_state = state.registry.provider(signal.provider)?;
        if provider_state.active_account_id.as_deref() != Some(signal.account_id.as_str()) {
            return Ok(None);
        }
        let active = account_by_id(&state.registry, &signal.account_id)?;
        if !active.auto_switch {
            return Ok(None);
        }
        Ok(select_auto_switch_target(
            &state.registry.accounts,
            signal.provider,
            &signal.account_id,
            now,
        ))
    }

    /// 자동전환이 실행된 사실을 기록해 스냅샷(UI)과 쿨다운 판정에 노출한다.
    pub fn record_auto_switch(
        &self,
        provider: ProviderId,
        from_account_id: &str,
        to_account_id: &str,
        reason: AutoSwitchReason,
        resumed_session_count: usize,
    ) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.auto_switch_events.insert(
                provider,
                AutoSwitchEventView {
                    from_account_id: from_account_id.to_owned(),
                    to_account_id: to_account_id.to_owned(),
                    reason,
                    at: now_ms(),
                    resumed_session_count,
                },
            );
        }
    }

    pub fn delete_account(
        &self,
        account_id: &str,
        has_schedule_reference: bool,
    ) -> Result<AccountSnapshot, CoreError> {
        if has_schedule_reference {
            return Err(CoreError::Conflict(
                "연결된 반복 요청이 있어 계정을 삭제할 수 없습니다".to_owned(),
            ));
        }
        let mut state = lock(&self.inner.state, "계정 상태")?;
        let account = account_by_id(&state.registry, account_id)?.clone();
        let provider = state.registry.provider(account.provider)?;
        if provider.active_account_id.as_deref() == Some(account_id)
            || provider.default_account_id.as_deref() == Some(account_id)
            || provider.pending_default_account_id.as_deref() == Some(account_id)
            || state
                .observed_active_account_ids
                .get(&account.provider)
                .and_then(|account_id| account_id.as_deref())
                == Some(account_id)
        {
            return Err(CoreError::Conflict(
                "Agent Manager 선택·CLI 실제 활성·기본·전환 대기 계정은 삭제할 수 없습니다"
                    .to_owned(),
            ));
        }
        if state
            .runtime_counts
            .get(&account.provider)
            .copied()
            .unwrap_or(0)
            > 0
            || state.transitions.values().any(|transition| {
                transition.previous_active_account_id == account_id
                    || transition.target_account_id == account_id
            })
        {
            return Err(CoreError::Conflict(
                "연결된 런타임이나 계정 전환이 있어 삭제할 수 없습니다".to_owned(),
            ));
        }
        let key = vault_key(&account);
        let secret = self.inner.vault.get(&key)?;
        let registry_before = state.registry.clone();
        self.inner.vault.delete(&key)?;
        state.registry.accounts.retain(|item| item.id != account_id);
        if let Err(error) = save_registry(&self.inner.app_data_dir, &state.registry) {
            state.registry = registry_before;
            if let Err(rollback) = self.inner.vault.put(&key, &secret) {
                return Err(CoreError::Runtime(format!(
                    "계정 삭제 저장과 보안 저장소 롤백이 모두 실패했습니다: {error}; {rollback}"
                )));
            }
            return Err(error);
        }
        drop(state);
        self.snapshot()
    }

    pub fn refresh_usage(&self, account_id: &str) -> Result<AccountSnapshot, CoreError> {
        let (account, sync_active_credentials) = {
            let state = lock(&self.inner.state, "계정 상태")?;
            let account = account_by_id(&state.registry, account_id)?.clone();
            let provider = state.registry.provider(account.provider)?;
            let is_active = provider.active_account_id.as_deref() == Some(account_id);
            if !is_active {
                return Err(CoreError::Conflict(
                    "활성 계정만 사용량을 갱신할 수 있습니다. 계정을 활성화한 후 다시 시도하세요"
                        .to_owned(),
                ));
            }
            let has_pending_reauthentication =
                provider.pending_default_account_id.as_deref() == Some(account_id);
            (account, is_active && !has_pending_reauthentication)
        };
        // 공급자별 사용량 조회와 토큰 회전을 직렬화해 수동·자동 새로고침이 같은
        // 일회성 갱신 토큰을 동시에 소비하지 않도록 한다.
        let _usage_refresh = self.usage_refresh_guard(account.provider)?;
        let credential_sync = if sync_active_credentials {
            let _switch = self.credential_switch_guard(account.provider)?;
            if account.provider == ProviderId::Claude {
                self.recover_interrupted_refresh()?;
            }
            match self.inner.vault.get(&vault_key(&account)) {
                Ok(stored) => self.sync_registered_active_credential(&account, &stored),
                Err(CoreError::NotFound(_)) => self.recover_missing_active_credential(&account),
                Err(error) => Err(error),
            }
        } else {
            Ok(ActiveCredentialSync::Matched {
                credential_changed: false,
            })
        };
        let active_credential_validated = sync_active_credentials
            && matches!(&credential_sync, Ok(ActiveCredentialSync::Matched { .. }));
        let fresh_usage = match credential_sync {
            Ok(ActiveCredentialSync::Adopted) => return self.snapshot(),
            Ok(ActiveCredentialSync::Matched { .. }) => match account.provider {
                ProviderId::Codex => self
                    .inner
                    .vault
                    .get(&vault_key(&account))
                    .and_then(|secret| fetch_codex_usage(&secret)),
                ProviderId::Claude => {
                    self.fetch_claude_usage_with_refresh(&account, sync_active_credentials)
                }
                ProviderId::Antigravity => Err(CoreError::InvalidInput(
                    "Antigravity 계정 사용량은 지원하지 않습니다".to_owned(),
                )),
            }
            .unwrap_or_else(usage_error_result),
            Err(error) => usage_error_result(error),
        };
        // 조회 도중 외부 CLI 로그인이 바뀌어 실제 활성 계정을 채택했다면 이전 계정에
        // 새 결과나 오류를 기록하지 않는다.
        let is_still_active = {
            let state = lock(&self.inner.state, "계정 상태")?;
            state
                .registry
                .provider(account.provider)?
                .active_account_id
                .as_deref()
                == Some(account_id)
        };
        if !is_still_active {
            return self.snapshot();
        }
        let auth_status = reconciled_auth_status_after_usage(
            account.auth_status,
            active_credential_validated,
            fresh_usage.status,
        );
        let usage = apply_usage_stale_policy(fresh_usage, &account.usage, now_ms());
        let usage_exhausted = usage_indicates_exhaustion(&usage);
        let mut state = lock(&self.inner.state, "계정 상태")?;
        let (provider, auto_switch_enabled) = {
            let account = account_by_id_mut(&mut state.registry, account_id)?;
            account.auth_status = auth_status;
            account.usage = usage;
            account.updated_at = now_ms();
            (account.provider, account.auto_switch)
        };
        if active_credential_validated {
            state.recovery_error.remove(&provider);
        }
        save_registry(&self.inner.app_data_dir, &state.registry)?;
        drop(state);
        if usage_exhausted && auto_switch_enabled {
            self.signal_auto_switch(AutoSwitchSignal {
                provider,
                account_id: account_id.to_owned(),
                reason: AutoSwitchReason::UsageExhausted,
            });
        }
        self.snapshot()
    }

    /// Agent Manager Vault에 저장된 계정 자격증명을 공유 CLI 홈에 적용하지 않고
    /// 공급자 신원 API로 검증한다. 등록 신원과 일치할 때만 stale auth 오류를 Ready로
    /// 복구하며 활성 계정 선택과 공급자 소유 저장소는 변경하지 않는다.
    pub fn revalidate_saved_credential(
        &self,
        account_id: &str,
    ) -> Result<AccountSnapshot, CoreError> {
        let account = {
            let state = lock(&self.inner.state, "계정 상태")?;
            account_by_id(&state.registry, account_id)?.clone()
        };
        let _switch = self.credential_switch_guard(account.provider)?;
        let secret = match self.inner.vault.get(&vault_key(&account)) {
            Ok(secret) => secret,
            Err(CoreError::NotFound(_)) => {
                let mut state = lock(&self.inner.state, "계정 상태")?;
                let record = account_by_id_mut(&mut state.registry, account_id)?;
                record.auth_status = AccountAuthStatus::Missing;
                record.updated_at = now_ms();
                save_registry(&self.inner.app_data_dir, &state.registry)?;
                return self.snapshot();
            }
            Err(error) => return Err(error),
        };
        validate_captured_provider_credential(account.provider, &secret)?;
        let identity = match account.provider {
            ProviderId::Codex => codex_identity(&secret),
            ProviderId::Claude => (self.inner.claude_identity_resolver)(&secret),
            ProviderId::Antigravity => Err(CoreError::InvalidInput(
                "Antigravity 계정 자격증명은 지원하지 않습니다".to_owned(),
            )),
        }?;
        if !identity_matches_account(&identity, &account) {
            return Err(CoreError::Conflict(
                "저장된 자격증명의 신원이 등록된 계정과 일치하지 않습니다".to_owned(),
            ));
        }
        let mut state = lock(&self.inner.state, "계정 상태")?;
        let record = account_by_id_mut(&mut state.registry, account_id)?;
        record.email = identity.email;
        record.organization = identity.organization;
        record.auth_status = AccountAuthStatus::Ready;
        record.updated_at = now_ms();
        save_registry(&self.inner.app_data_dir, &state.registry)?;
        drop(state);
        self.snapshot()
    }

    /// Claude 사용량을 조회하되, 저장된 액세스 토큰이 만료됐거나 401이 반환되면
    /// 보관된 리프레시 토큰으로 자격증명을 갱신해 저장한 뒤 한 번 더 시도한다.
    /// 활성 계정은 공유 자격증명을 최신 상태로 맞춰 외부 Claude와 같은 토큰 체인을
    /// 사용한다. 비활성 계정은 해당 토큰을 가진 런타임이 있을 때만 갱신을 미룬다.
    fn fetch_claude_usage_with_refresh(
        &self,
        account: &AccountRecord,
        replaces_active_credentials: bool,
    ) -> Result<AccountUsageView, CoreError> {
        let key = vault_key(account);
        let secret = self.inner.vault.get(&key)?;
        if !claude_access_token_expired(&secret, now_ms()) {
            match request_claude_usage(&secret)? {
                ClaudeUsageResponse::Usage(usage) => return Ok(usage),
                ClaudeUsageResponse::Unauthorized => {}
                ClaudeUsageResponse::RateLimited { retry_at } => {
                    return Ok(rate_limited_usage_result(
                        "Claude 사용량 조회가 제한되었습니다 (HTTP 429)",
                        retry_at,
                    ));
                }
            }
        }
        let refreshed = {
            let _switch = self.credential_switch_guard(account.provider)?;
            let current =
                self.latest_claude_credential_for_refresh(account, replaces_active_credentials)?;
            if !same_secret(current.as_str(), secret.as_str()) {
                // 공식 Claude 프로세스나 다른 경로가 방금 자격증명을 교체했다. 그 최신
                // 자격증명으로 먼저 다시 시도하고 불필요한 이중 토큰 회전을 피한다.
                current
            } else if self.claude_refresh_deferred(&account.id, replaces_active_credentials)? {
                return Ok(usage_retry_result(
                    "실행 중인 Claude 세션이 비활성 계정 자격증명을 보유할 수 있어 토큰 갱신을 미룹니다",
                    now_ms().saturating_add(USAGE_ERROR_RETRY_MS),
                ));
            } else {
                let refreshed = match refresh_claude_oauth_secret(&current)? {
                    ClaudeTokenRefresh::Refreshed(refreshed) => refreshed,
                    ClaudeTokenRefresh::RateLimited { retry_at } => {
                        return Ok(rate_limited_usage_result(
                            "Claude 토큰 갱신이 제한되었습니다 (HTTP 429). 기존 자격증명을 유지합니다",
                            retry_at,
                        ));
                    }
                };
                if replaces_active_credentials {
                    save_refresh_journal(
                        &self.inner.app_data_dir,
                        &CredentialRefreshJournal {
                            provider: account.provider,
                            account_id: account.id.clone(),
                            operation_id: Uuid::new_v4().to_string(),
                            started_at: now_ms(),
                        },
                    )?;
                }
                let committed = self.commit_refreshed_claude_credential(
                    account,
                    &current,
                    refreshed,
                    replaces_active_credentials,
                )?;
                if replaces_active_credentials {
                    remove_refresh_journal(&self.inner.app_data_dir, account.provider)?;
                }
                committed
            }
        };
        match request_claude_usage(&refreshed)? {
            ClaudeUsageResponse::Usage(usage) => Ok(usage),
            ClaudeUsageResponse::Unauthorized => Err(CoreError::Conflict(
                "Claude 사용량 조회가 실패했습니다 (HTTP 401 Unauthorized). 토큰을 갱신해도 인증이 거부되어 계정을 다시 인증해야 합니다"
                    .to_owned(),
            )),
            ClaudeUsageResponse::RateLimited { retry_at } => Ok(rate_limited_usage_result(
                "Claude 사용량 조회가 제한되었습니다 (HTTP 429)",
                retry_at,
            )),
        }
    }

    /// 활성 Claude 계정은 공식 프로세스가 공유 Keychain을 먼저 회전했을 수 있으므로
    /// 갱신 직전에 되읽고, 계정 신원을 검증한 값만 Vault에 동기화한다.
    fn latest_claude_credential_for_refresh(
        &self,
        account: &AccountRecord,
        sync_active_credentials: bool,
    ) -> Result<Zeroizing<String>, CoreError> {
        let key = vault_key(account);
        let current = self.inner.vault.get(&key)?;
        if sync_active_credentials {
            if matches!(
                self.sync_registered_active_credential(account, &current)?,
                ActiveCredentialSync::Adopted
            ) {
                return Err(CoreError::Conflict(
                    "공유 CLI 홈의 실제 활성 계정이 변경되어 이전 계정의 사용량 갱신을 중단했습니다"
                        .to_owned(),
                ));
            }
            self.inner.vault.get(&key)
        } else {
            Ok(current)
        }
    }

    /// OAuth 응답을 저장하기 직전에 공유 자격증명을 다시 비교한다. 외부 Claude가 이미
    /// 갱신했다면 그 값을 채택하고 덮어쓰지 않는다. 직접 교체한 경우에도 되읽어 외부의
    /// 후속 갱신을 Vault에 반영한다.
    fn commit_refreshed_claude_credential(
        &self,
        account: &AccountRecord,
        expected_current: &str,
        refreshed: Zeroizing<String>,
        replaces_active_credentials: bool,
    ) -> Result<Zeroizing<String>, CoreError> {
        let key = vault_key(account);
        if !replaces_active_credentials {
            self.inner.vault.put(&key, &refreshed)?;
            return Ok(refreshed);
        }

        match self.sync_registered_active_credential(account, expected_current)? {
            ActiveCredentialSync::Matched {
                credential_changed: true,
            } => {
                // 외부 Claude가 먼저 같은 계정의 자격증명을 회전했다. 최신 공유 값을
                // 권위 있는 값으로 사용하고 방금 받은 응답으로 덮어쓰지 않는다.
                return self.inner.vault.get(&key);
            }
            ActiveCredentialSync::Adopted => {
                return Err(CoreError::Conflict(
                    "공유 CLI 홈의 실제 활성 계정이 변경되어 이전 계정의 토큰 갱신을 중단했습니다"
                        .to_owned(),
                ));
            }
            ActiveCredentialSync::Matched {
                credential_changed: false,
            } => {}
        }

        write_active_credentials(
            self.provider_root(account.provider)?,
            account.provider,
            self.inner.claude_keychain_profile.as_deref(),
            self.inner.inspect_external_processes,
            &refreshed,
        )?;
        verify_active_identity(
            &self.inner.home_dir,
            self.provider_root(account.provider)?,
            account.provider,
            self.inner.claude_keychain_profile.as_deref(),
            self.inner.inspect_external_processes,
            account,
            &refreshed,
        )?;
        self.inner.vault.put(&key, &refreshed)?;

        // 쓰기 직후 공식 Claude가 다시 회전했으면 그 값을 최종 상태로 채택한다.
        if matches!(
            self.sync_registered_active_credential(account, &refreshed)?,
            ActiveCredentialSync::Adopted
        ) {
            return Err(CoreError::Conflict(
                "공유 CLI 홈의 실제 활성 계정이 변경되어 이전 계정의 토큰 갱신을 중단했습니다"
                    .to_owned(),
            ));
        }
        self.inner.vault.get(&key)
    }

    pub fn acquire_runtime(
        &self,
        provider: ProviderId,
        requested_account_id: Option<&str>,
        transition_id: Option<&str>,
    ) -> Result<AccountRuntimeLease, CoreError> {
        if provider == ProviderId::Antigravity {
            return Ok(AccountRuntimeLease {
                accounts: self.clone(),
                provider,
                account_id: None,
                released: false,
            });
        }
        self.apply_pending_defaults_if_idle();
        let _switch = self.credential_switch_guard(provider)?;
        let mut state = lock(&self.inner.state, "계정 상태")?;
        if let Some(error) = state.recovery_error.get(&provider) {
            return Err(CoreError::Conflict(format!(
                "중단된 계정 전환 복구가 필요합니다: {error}"
            )));
        }
        if let Some(transition) = state.transitions.get(&provider) {
            if transition_id != Some(transition.id.as_str()) {
                return Err(CoreError::Conflict(
                    "이 공급자는 반복 요청의 계정 전환·복원이 끝날 때까지 대기합니다".to_owned(),
                ));
            }
        } else if transition_id.is_some() {
            return Err(CoreError::Conflict(
                "만료되었거나 소유권이 다른 계정 전환 토큰입니다".to_owned(),
            ));
        }
        let provider_state = state.registry.provider(provider)?;
        let mut runtime_account_id = None;
        if state
            .registry
            .accounts
            .iter()
            .all(|account| account.provider != provider)
        {
            if requested_account_id.is_some() {
                return Err(CoreError::NotFound(
                    "실행 계정을 찾을 수 없습니다".to_owned(),
                ));
            }
        } else {
            let account_id = requested_account_id
                .or(provider_state.active_account_id.as_deref())
                .ok_or_else(|| {
                    CoreError::Conflict("이 공급자의 활성 계정을 선택해야 합니다".to_owned())
                })?;
            let account = account_by_id(&state.registry, account_id)?;
            if account.provider != provider || account.disabled {
                return Err(CoreError::Conflict(
                    "선택한 실행 계정을 사용할 수 없습니다".to_owned(),
                ));
            }
            if provider_state.active_account_id.as_deref() != Some(account_id) {
                return Err(CoreError::Conflict(
                    "선택한 실행 계정으로 전환될 때까지 대기합니다".to_owned(),
                ));
            }
            runtime_account_id = Some(account_id.to_owned());
        }
        *state.runtime_counts.entry(provider).or_default() += 1;
        if let Some(account_id) = runtime_account_id.as_deref() {
            *state
                .runtime_account_counts
                .entry(account_id.to_owned())
                .or_default() += 1;
        }
        Ok(AccountRuntimeLease {
            accounts: self.clone(),
            provider,
            account_id: runtime_account_id,
            released: false,
        })
    }

    /// 활성 계정에 귀속되지 않는 관리 터미널도 자격증명 전환과 상호 배제하고
    /// provider runtimeCount에 포함한다. CLI 설정·격리 로그인 터미널은 계정이
    /// 아직 등록되지 않은 상태에서도 실행되어야 하므로 accountId 검증은 하지
    /// 않지만, 수동 전환과 같은 credential switch 잠금 및 전환 상태 검증은 공유한다.
    pub(crate) fn acquire_unscoped_runtime(
        &self,
        provider: ProviderId,
    ) -> Result<AccountRuntimeLease, CoreError> {
        let _switch = self.credential_switch_guard(provider)?;
        let mut state = lock(&self.inner.state, "계정 상태")?;
        if let Some(error) = state.recovery_error.get(&provider) {
            return Err(CoreError::Conflict(format!(
                "중단된 계정 전환 복구가 필요합니다: {error}"
            )));
        }
        if state.transitions.contains_key(&provider) {
            return Err(CoreError::Conflict(
                "이 공급자는 반복 요청의 계정 전환·복원이 끝날 때까지 대기합니다".to_owned(),
            ));
        }
        *state.runtime_counts.entry(provider).or_default() += 1;
        Ok(AccountRuntimeLease {
            accounts: self.clone(),
            provider,
            account_id: None,
            released: false,
        })
    }

    pub fn begin_temporary_switch(
        &self,
        provider: ProviderId,
        target_account_id: &str,
    ) -> Result<Option<AccountTransitionGuard>, CoreError> {
        ensure_managed_provider(provider)?;
        let _switch = self.credential_switch_guard(provider)?;
        self.ensure_provider_idle(provider)?;
        let (previous, target) = {
            let state = lock(&self.inner.state, "계정 상태")?;
            if state.transitions.contains_key(&provider) {
                return Err(CoreError::Conflict(
                    "다른 계정 전환이 진행 중입니다".to_owned(),
                ));
            }
            let provider_state = state.registry.provider(provider)?;
            let previous = provider_state.active_account_id.clone().ok_or_else(|| {
                CoreError::Conflict("복원할 이전 활성 계정이 없습니다".to_owned())
            })?;
            if previous == target_account_id {
                return Ok(None);
            }
            let target = account_by_id(&state.registry, target_account_id)?;
            if target.provider != provider || target.disabled {
                return Err(CoreError::Conflict(
                    "반복 요청의 실행 계정을 사용할 수 없습니다".to_owned(),
                ));
            }
            (previous, target.id.clone())
        };
        let transition_id = Uuid::new_v4().to_string();
        save_journal(
            &self.inner.app_data_dir,
            &SwitchJournal {
                provider,
                previous_active_account_id: previous.clone(),
                target_account_id: target.clone(),
                transition_id: transition_id.clone(),
                phase: SwitchPhase::Switching,
            },
        )?;
        {
            let mut state = lock(&self.inner.state, "계정 상태")?;
            state.transitions.insert(
                provider,
                ActiveTransition {
                    id: transition_id.clone(),
                    provider,
                    previous_active_account_id: previous.clone(),
                    target_account_id: target.clone(),
                },
            );
        }
        if let Err(error) = self
            .activate_account_locked(provider, &target)
            .and_then(|()| {
                update_journal_phase(&self.inner.app_data_dir, provider, SwitchPhase::Running)
            })
        {
            let restoration = self.activate_account_locked(provider, &previous);
            if restoration.is_ok() {
                let _ = remove_journal(&self.inner.app_data_dir, provider);
                if let Ok(mut state) = self.inner.state.lock() {
                    state.transitions.remove(&provider);
                }
            } else if let Ok(mut state) = self.inner.state.lock() {
                state.recovery_error.insert(
                    provider,
                    format!("임시 전환 실패 후 이전 계정 복원도 실패했습니다: {error}"),
                );
            }
            return Err(error);
        }
        Ok(Some(AccountTransitionGuard {
            accounts: self.clone(),
            transition_id,
            restored: false,
        }))
    }

    pub fn active_account_id(&self, provider: ProviderId) -> Result<Option<String>, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        Ok(state.registry.provider(provider)?.active_account_id.clone())
    }

    /// 정확한 provider/transition/account identity가 모두 일치하고 provider가 유휴일
    /// 때만 중단된 임시 전환을 복구한다. 전역 boolean을 임의로 지우지 않으며 journal과
    /// in-memory lease를 함께 검증한다.
    pub fn recover_provider_transition(
        &self,
        provider: ProviderId,
        transition_id: &str,
        previous_active_account_id: &str,
        target_account_id: &str,
    ) -> Result<ProviderAccountTransitionRecovery, CoreError> {
        ensure_managed_provider(provider)?;
        if self.provider_runtime_count(provider)? > 0 {
            return Err(CoreError::Conflict(
                "공급자 런타임이 남아 있어 계정 전환을 복구할 수 없습니다".to_owned(),
            ));
        }
        let journal = load_journal(&self.inner.app_data_dir, provider)?;
        let active = lock(&self.inner.state, "계정 상태")?
            .transitions
            .get(&provider)
            .cloned();
        let Some(identity) = active
            .as_ref()
            .map(|transition| SwitchJournal {
                provider: transition.provider,
                previous_active_account_id: transition.previous_active_account_id.clone(),
                target_account_id: transition.target_account_id.clone(),
                transition_id: transition.id.clone(),
                phase: SwitchPhase::Running,
            })
            .or(journal.clone())
        else {
            if self.active_account_id(provider)?.as_deref() != Some(previous_active_account_id) {
                return Err(CoreError::Conflict(
                    "전환 lease는 없지만 현재 활성 계정이 요청한 복원 계정과 일치하지 않습니다"
                        .to_owned(),
                ));
            }
            return Ok(ProviderAccountTransitionRecovery {
                provider,
                transition_id: transition_id.to_owned(),
                previous_active_account_id: previous_active_account_id.to_owned(),
                target_account_id: target_account_id.to_owned(),
                restored: false,
                lease_cleared: true,
                already_recovered: true,
                recovery_error: None,
            });
        };
        if identity.transition_id != transition_id
            || identity.provider != provider
            || identity.previous_active_account_id != previous_active_account_id
            || identity.target_account_id != target_account_id
        {
            return Err(CoreError::Conflict(
                "요청한 run과 현재 계정 전환 lease의 identity가 일치하지 않습니다".to_owned(),
            ));
        }
        let expected_active_after_recovery = if active.is_some() {
            lock(&self.inner.state, "계정 상태")?
                .registry
                .provider(provider)?
                .pending_default_account_id
                .clone()
                .unwrap_or_else(|| previous_active_account_id.to_owned())
        } else {
            previous_active_account_id.to_owned()
        };
        let recovery = if active.is_some() {
            self.restore_transition(transition_id)
        } else {
            let _switch = self.credential_switch_guard(provider)?;
            update_journal_phase(&self.inner.app_data_dir, provider, SwitchPhase::Restoring)?;
            self.activate_account_locked(provider, previous_active_account_id)
                .and_then(|()| remove_journal(&self.inner.app_data_dir, provider))
        };
        match recovery {
            Ok(()) => {
                let postcondition_ok = self.active_account_id(provider)?.as_deref()
                    == Some(expected_active_after_recovery.as_str())
                    && load_journal(&self.inner.app_data_dir, provider)?.is_none()
                    && !lock(&self.inner.state, "계정 상태")?
                        .transitions
                        .contains_key(&provider);
                if !postcondition_ok {
                    let message =
                        "계정 복원 후 활성 계정 또는 transition lease 사후조건이 충족되지 않았습니다"
                            .to_owned();
                    lock(&self.inner.state, "계정 상태")?
                        .recovery_error
                        .insert(provider, message.clone());
                    return Ok(ProviderAccountTransitionRecovery {
                        provider,
                        transition_id: transition_id.to_owned(),
                        previous_active_account_id: previous_active_account_id.to_owned(),
                        target_account_id: target_account_id.to_owned(),
                        restored: false,
                        lease_cleared: false,
                        already_recovered: false,
                        recovery_error: Some(message),
                    });
                }
                lock(&self.inner.state, "계정 상태")?
                    .recovery_error
                    .remove(&provider);
                Ok(ProviderAccountTransitionRecovery {
                    provider,
                    transition_id: transition_id.to_owned(),
                    previous_active_account_id: previous_active_account_id.to_owned(),
                    target_account_id: target_account_id.to_owned(),
                    restored: true,
                    lease_cleared: true,
                    already_recovered: false,
                    recovery_error: None,
                })
            }
            Err(error) => {
                let message = error.to_string();
                lock(&self.inner.state, "계정 상태")?
                    .recovery_error
                    .insert(provider, message.clone());
                Ok(ProviderAccountTransitionRecovery {
                    provider,
                    transition_id: transition_id.to_owned(),
                    previous_active_account_id: previous_active_account_id.to_owned(),
                    target_account_id: target_account_id.to_owned(),
                    restored: false,
                    lease_cleared: false,
                    already_recovered: false,
                    recovery_error: Some(message),
                })
            }
        }
    }

    pub fn account_is_enabled_for_provider(
        &self,
        provider: ProviderId,
        account_id: &str,
    ) -> Result<bool, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        let account = account_by_id(&state.registry, account_id)?;
        Ok(account.provider == provider
            && !account.disabled
            && account.auth_status == AccountAuthStatus::Ready)
    }

    pub fn provider_runtime_count(&self, provider: ProviderId) -> Result<usize, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        Ok(state.runtime_counts.get(&provider).copied().unwrap_or(0))
    }

    fn account_runtime_count(&self, account_id: &str) -> Result<usize, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        Ok(state
            .runtime_account_counts
            .get(account_id)
            .copied()
            .unwrap_or(0))
    }

    /// 활성 계정은 공유 Keychain과 Vault를 함께 갱신하므로 실행 중인 Claude가 있어도
    /// 허용한다. 비활성 계정은 공유 저장소로 조정할 수 없는 런타임이 토큰을 들고 있을 수
    /// 있으므로 같은 계정의 관리 런타임이나 귀속 불가능한 외부 프로세스가 있으면 미룬다.
    fn claude_refresh_deferred(
        &self,
        account_id: &str,
        replaces_active_credentials: bool,
    ) -> Result<bool, CoreError> {
        let account_runtime_running = self.account_runtime_count(account_id)? > 0;
        let external_process_running = self.inner.inspect_external_processes
            && external_provider_process_running(ProviderId::Claude);
        Ok(should_defer_claude_refresh(
            replaces_active_credentials,
            account_runtime_running,
            external_process_running,
        ))
    }

    fn upsert_captured_account(
        &self,
        provider: ProviderId,
        existing_account_id: Option<&str>,
        display_name: Option<String>,
        captured: CapturedCredentials,
        current_is_active: bool,
    ) -> Result<(), CoreError> {
        let _switch = self.credential_switch_guard(provider)?;
        let now = now_ms();
        let mut state = lock(&self.inner.state, "계정 상태")?;
        let (account_id, migrates_legacy_identity) = if let Some(existing_id) = existing_account_id
        {
            let existing = account_by_id(&state.registry, existing_id)?;
            if existing.provider != provider
                || !identity_matches_account(&captured.identity, existing)
            {
                return Err(CoreError::Conflict(
                    "재인증 결과가 기존 계정 신원과 일치하지 않습니다".to_owned(),
                ));
            }
            (
                existing_id.to_owned(),
                existing.provider_account_id != captured.identity.provider_account_id,
            )
        } else if let Some(existing) = state.registry.accounts.iter().find(|account| {
            account.provider == provider
                && account.provider_account_id == captured.identity.provider_account_id
        }) {
            (existing.id.clone(), false)
        } else if let Some(existing) = state.registry.accounts.iter().find(|account| {
            account.provider == provider && identity_matches_account(&captured.identity, account)
        }) {
            (existing.id.clone(), true)
        } else {
            let digest = Sha256::digest(
                format!(
                    "{}:{}",
                    provider.as_str(),
                    captured.identity.provider_account_id
                )
                .as_bytes(),
            );
            (
                format!("{}-{}", provider.as_str(), hex_prefix(&digest, 10)),
                false,
            )
        };
        let registry_before = state.registry.clone();
        let active_before = state.registry.provider(provider)?.active_account_id.clone();
        let updates_active_credentials =
            !current_is_active && active_before.as_deref() == Some(account_id.as_str());
        let vault_key = format!("{}:{account_id}", provider.as_str());
        let old_secret = self.inner.vault.get(&vault_key).ok();
        self.inner.vault.put(&vault_key, &captured.secret)?;
        if let Some(account) = state
            .registry
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
        {
            if migrates_legacy_identity {
                account.provider_account_id = captured.identity.provider_account_id.clone();
                account.usage = AccountUsageView::default();
            }
            account.display_name =
                normalized_display_name(display_name, &captured.identity, &account.display_name);
            account.email = captured.identity.email;
            account.organization = captured.identity.organization;
            account.auth_status = AccountAuthStatus::Ready;
            account.updated_at = now;
        } else {
            let name = normalized_display_name(display_name, &captured.identity, provider.as_str());
            state.registry.accounts.push(AccountRecord {
                id: account_id.clone(),
                provider,
                display_name: name,
                email: captured.identity.email,
                organization: captured.identity.organization,
                provider_account_id: captured.identity.provider_account_id,
                disabled: false,
                auto_switch: false,
                auth_status: AccountAuthStatus::Ready,
                usage: AccountUsageView::default(),
                created_at: now,
                updated_at: now,
            });
        }
        let provider_state = state.registry.provider_mut(provider)?;
        let is_first = provider_state.active_account_id.is_none();
        if current_is_active {
            provider_state.active_account_id = Some(account_id.clone());
        } else if is_first || updates_active_credentials {
            provider_state.pending_default_account_id = Some(account_id.clone());
        }
        if provider_state.default_account_id.is_none() {
            provider_state.default_account_id = Some(account_id.clone());
        }
        if current_is_active {
            state.recovery_error.remove(&provider);
        }
        if let Err(error) = save_registry(&self.inner.app_data_dir, &state.registry) {
            state.registry = registry_before;
            if let Err(rollback) = restore_vault_value(
                self.inner.vault.as_ref(),
                &vault_key,
                old_secret.as_ref().map(|secret| secret.as_str()),
            ) {
                return Err(CoreError::Runtime(format!(
                    "계정 등록 저장과 보안 저장소 롤백이 모두 실패했습니다: {error}; {rollback}"
                )));
            }
            return Err(error);
        }
        if current_is_active {
            state
                .observed_active_account_ids
                .insert(provider, Some(account_id.clone()));
        }
        drop(state);
        if updates_active_credentials && self.is_provider_idle(provider)? {
            if let Err(error) = self.activate_account_locked(provider, &account_id) {
                if let Err(rollback) = restore_vault_value(
                    self.inner.vault.as_ref(),
                    &vault_key,
                    old_secret.as_ref().map(|secret| secret.as_str()),
                ) {
                    return Err(CoreError::Runtime(format!(
                        "재인증 적용과 이전 보안 저장소 복원이 모두 실패했습니다: {error}; {rollback}"
                    )));
                }
                return Err(error);
            }
            let mut state = lock(&self.inner.state, "계정 상태")?;
            let provider_state = state.registry.provider_mut(provider)?;
            if provider_state.pending_default_account_id.as_deref() == Some(account_id.as_str()) {
                provider_state.pending_default_account_id = None;
            }
            save_registry(&self.inner.app_data_dir, &state.registry)?;
        } else if !current_is_active && is_first && self.is_provider_idle(provider)? {
            self.activate_account_locked(provider, &account_id)?;
            let mut state = lock(&self.inner.state, "계정 상태")?;
            let provider_state = state.registry.provider_mut(provider)?;
            if provider_state.pending_default_account_id.as_deref() == Some(account_id.as_str()) {
                provider_state.pending_default_account_id = None;
            }
            save_registry(&self.inner.app_data_dir, &state.registry)?;
        }
        Ok(())
    }

    fn activate_account(&self, provider: ProviderId, account_id: &str) -> Result<(), CoreError> {
        let _switch = self.credential_switch_guard(provider)?;
        self.activate_account_locked(provider, account_id)
    }

    fn activate_account_immediately(
        &self,
        provider: ProviderId,
        account_id: &str,
    ) -> Result<(), CoreError> {
        let _switch = self.credential_switch_guard(provider)?;
        let previous = {
            let state = lock(&self.inner.state, "계정 상태")?;
            if state.transitions.contains_key(&provider) {
                return Err(CoreError::Conflict(
                    "반복 실행의 임시 계정 전환·복원이 끝난 뒤 수동 전환할 수 있습니다".to_owned(),
                ));
            }
            state.registry.provider(provider)?.active_account_id.clone()
        };
        if previous.as_deref() == Some(account_id) {
            return Ok(());
        }
        // 수동 전환도 관리 런타임이 모두 종료된 뒤에만 자격증명을 교체한다.
        // 이 잠금은 acquire_runtime과 공유되므로 검증 후 교체 사이에 새 런타임이
        // 생성될 수 없다. 종료는 잠금 밖에서 stop_provider_chats로 수행해야 한다.
        let running = self.provider_runtime_count(provider)?;
        if running > 0 {
            return Err(CoreError::Conflict(format!(
                "실행 중인 관리 런타임 {running}개가 있어 계정을 전환할 수 없습니다. 먼저 해당 공급자의 채팅·터미널을 종료하세요"
            )));
        }

        if provider == ProviderId::Claude {
            if let Some(previous_account_id) = previous.as_deref() {
                if let Err(error) = self.read_back_active_claude_credentials(previous_account_id) {
                    // 전환 자체는 사용자가 명시적으로 요청했다. 신원을 입증하지 못한 런타임
                    // 자격증명은 저장하지 않되, 비밀값 없는 진단만 남기고 대상 계정 전환은 계속한다.
                    eprintln!(
                        "[account-manager] 활성 Claude 자격증명 되읽기를 건너뜁니다: {error}"
                    );
                }
            }
        }

        if let Some(previous) = previous.as_deref() {
            save_journal(
                &self.inner.app_data_dir,
                &SwitchJournal {
                    provider,
                    previous_active_account_id: previous.to_owned(),
                    target_account_id: account_id.to_owned(),
                    transition_id: Uuid::new_v4().to_string(),
                    phase: SwitchPhase::Switching,
                },
            )?;
        }

        if let Err(error) = self.replace_active_credentials_locked(provider, account_id) {
            if let Some(previous) = previous.as_deref() {
                match self.replace_active_credentials_locked(provider, previous) {
                    Ok(()) => remove_journal(&self.inner.app_data_dir, provider)?,
                    Err(rollback) => {
                        lock(&self.inner.state, "계정 상태")?
                            .recovery_error
                            .insert(provider, rollback.to_string());
                        return Err(CoreError::Runtime(format!(
                            "계정 전환과 이전 인증 복원이 모두 실패했습니다: {error}; {rollback}"
                        )));
                    }
                }
            }
            return Err(error);
        }

        if previous.is_some() {
            remove_journal(&self.inner.app_data_dir, provider)?;
        }
        let mut state = lock(&self.inner.state, "계정 상태")?;
        state
            .registry
            .provider_mut(provider)?
            .pending_default_account_id = None;
        save_registry(&self.inner.app_data_dir, &state.registry)
    }

    fn activate_account_locked(
        &self,
        provider: ProviderId,
        account_id: &str,
    ) -> Result<(), CoreError> {
        self.ensure_provider_idle(provider)?;
        self.replace_active_credentials_locked(provider, account_id)
    }

    fn replace_active_credentials_locked(
        &self,
        provider: ProviderId,
        account_id: &str,
    ) -> Result<(), CoreError> {
        let account = {
            let state = lock(&self.inner.state, "계정 상태")?;
            let account = account_by_id(&state.registry, account_id)?.clone();
            if account.provider != provider || account.disabled {
                return Err(CoreError::Conflict(
                    "전환할 계정을 사용할 수 없습니다".to_owned(),
                ));
            }
            account
        };
        let secret = self.inner.vault.get(&vault_key(&account))?;
        write_active_credentials(
            self.provider_root(provider)?,
            provider,
            self.inner.claude_keychain_profile.as_deref(),
            self.inner.inspect_external_processes,
            &secret,
        )?;
        verify_active_identity(
            &self.inner.home_dir,
            self.provider_root(provider)?,
            provider,
            self.inner.claude_keychain_profile.as_deref(),
            self.inner.inspect_external_processes,
            &account,
            &secret,
        )?;
        let mut state = lock(&self.inner.state, "계정 상태")?;
        state.registry.provider_mut(provider)?.active_account_id = Some(account_id.to_owned());
        state
            .observed_active_account_ids
            .insert(provider, Some(account_id.to_owned()));
        state.recovery_error.remove(&provider);
        save_registry(&self.inner.app_data_dir, &state.registry)
    }

    fn restore_transition(&self, transition_id: &str) -> Result<(), CoreError> {
        let provider = {
            let state = lock(&self.inner.state, "계정 상태")?;
            state
                .transitions
                .values()
                .find(|transition| transition.id == transition_id)
                .map(|transition| transition.provider)
                .ok_or_else(|| {
                    CoreError::NotFound("계정 전환 상태를 찾을 수 없습니다".to_owned())
                })?
        };
        let _switch = self.credential_switch_guard(provider)?;
        let transition = {
            let state = lock(&self.inner.state, "계정 상태")?;
            state
                .transitions
                .get(&provider)
                .filter(|transition| transition.id == transition_id)
                .cloned()
                .ok_or_else(|| {
                    CoreError::NotFound("계정 전환 상태를 찾을 수 없습니다".to_owned())
                })?
        };
        if self.provider_runtime_count(transition.provider)? > 0 {
            return Err(CoreError::Conflict(
                "반복 실행 런타임이 끝나기 전에는 이전 계정을 복원할 수 없습니다".to_owned(),
            ));
        }
        update_journal_phase(
            &self.inner.app_data_dir,
            transition.provider,
            SwitchPhase::Restoring,
        )?;
        self.activate_account_locked(transition.provider, &transition.previous_active_account_id)?;
        remove_journal(&self.inner.app_data_dir, transition.provider)?;
        {
            let mut state = lock(&self.inner.state, "계정 상태")?;
            state.transitions.remove(&transition.provider);
        }
        drop(_switch);
        self.apply_pending_default(transition.provider)
    }

    fn release_runtime(&self, provider: ProviderId, account_id: Option<&str>) {
        if let Ok(mut state) = self.inner.state.lock() {
            let count = state.runtime_counts.entry(provider).or_default();
            *count = count.saturating_sub(1);
            if let Some(account_id) = account_id {
                let account_count = state
                    .runtime_account_counts
                    .entry(account_id.to_owned())
                    .or_default();
                *account_count = account_count.saturating_sub(1);
                if *account_count == 0 {
                    state.runtime_account_counts.remove(account_id);
                }
            }
        }
        self.apply_pending_defaults_if_idle();
    }

    fn apply_pending_defaults_if_idle(&self) {
        for provider in [ProviderId::Codex, ProviderId::Claude] {
            let should_apply = self.inner.state.lock().ok().is_some_and(|state| {
                !state.transitions.contains_key(&provider)
                    && !state.recovery_error.contains_key(&provider)
                    && state.runtime_counts.get(&provider).copied().unwrap_or(0) == 0
                    && state
                        .registry
                        .provider(provider)
                        .ok()
                        .is_some_and(|provider| provider.pending_default_account_id.is_some())
            });
            if should_apply {
                let _ = self.apply_pending_default(provider);
            }
        }
    }

    fn apply_pending_default(&self, provider: ProviderId) -> Result<(), CoreError> {
        let _switch = self.credential_switch_guard(provider)?;
        let (pending, active) = {
            let state = lock(&self.inner.state, "계정 상태")?;
            if state.transitions.contains_key(&provider) {
                return Ok(());
            }
            let provider_state = state.registry.provider(provider)?;
            (
                provider_state.pending_default_account_id.clone(),
                provider_state.active_account_id.clone(),
            )
        };
        let Some(pending) = pending else {
            return Ok(());
        };
        if provider == ProviderId::Claude && active.as_deref() == Some(pending.as_str()) {
            // 대기 계정이 이미 활성 계정이면 계정 전환이 아니라 재인증 자격증명
            // 재적용만 남은 상태다. 활성 Claude 계정은 공유 Keychain과 Vault를
            // 같은 계정으로 갱신하므로 실행 중인 세션이 있어도 안전하게 적용한다.
            self.replace_active_credentials_locked(provider, &pending)?;
        } else {
            if !self.is_provider_idle(provider)? {
                return Ok(());
            }
            self.activate_account_locked(provider, &pending)?;
        }
        let mut state = lock(&self.inner.state, "계정 상태")?;
        let provider_state = state.registry.provider_mut(provider)?;
        if provider_state.pending_default_account_id.as_deref() == Some(&pending) {
            provider_state.pending_default_account_id = None;
        }
        save_registry(&self.inner.app_data_dir, &state.registry)
    }

    fn ensure_provider_idle(&self, provider: ProviderId) -> Result<(), CoreError> {
        if !self.is_provider_idle(provider)? {
            return Err(CoreError::Conflict(
                "실행 중·분리·승인 대기 또는 외부 공급자 프로세스가 있어 계정을 전환할 수 없습니다"
                    .to_owned(),
            ));
        }
        Ok(())
    }

    fn is_provider_idle(&self, provider: ProviderId) -> Result<bool, CoreError> {
        let internal = self.provider_runtime_count(provider)?;
        if internal > 0 {
            return Ok(false);
        }
        Ok(!self.inner.inspect_external_processes || !external_provider_process_running(provider))
    }

    fn capture_credentials(
        &self,
        provider: ProviderId,
        profile: Option<&Path>,
    ) -> Result<CapturedCredentials, CoreError> {
        let keychain_profile = profile.or(self.inner.claude_keychain_profile.as_deref());
        let secret = read_active_credentials(
            self.provider_root(provider)?,
            provider,
            profile,
            keychain_profile,
            self.inner.inspect_external_processes,
        )?;
        validate_captured_provider_credential(provider, &secret)?;
        let identity = read_identity(
            &self.inner.home_dir,
            self.provider_root(provider)?,
            provider,
            profile,
            &secret,
        )?;
        Ok(CapturedCredentials { secret, identity })
    }

    fn provider_root(&self, provider: ProviderId) -> Result<&Path, CoreError> {
        match provider {
            ProviderId::Codex => Ok(&self.inner.codex_home_dir),
            ProviderId::Claude => Ok(&self.inner.claude_config_dir),
            ProviderId::Antigravity => Err(CoreError::InvalidInput(
                "Antigravity 인증 경로는 지원하지 않습니다".to_owned(),
            )),
        }
    }

    fn credential_switch_guard(
        &self,
        provider: ProviderId,
    ) -> Result<MutexGuard<'_, ()>, CoreError> {
        let mutex = match provider {
            ProviderId::Codex => &self.inner.codex_switch_lock,
            ProviderId::Claude => &self.inner.claude_switch_lock,
            ProviderId::Antigravity => {
                return Err(CoreError::InvalidInput(
                    "Antigravity 계정 전환은 지원하지 않습니다".to_owned(),
                ));
            }
        };
        lock(mutex, "계정 전환")
    }

    fn usage_refresh_guard(&self, provider: ProviderId) -> Result<MutexGuard<'_, ()>, CoreError> {
        let mutex = match provider {
            ProviderId::Codex => &self.inner.codex_usage_lock,
            ProviderId::Claude => &self.inner.claude_usage_lock,
            ProviderId::Antigravity => {
                return Err(CoreError::InvalidInput(
                    "Antigravity 계정 사용량은 지원하지 않습니다".to_owned(),
                ));
            }
        };
        lock(mutex, "계정 사용량 갱신")
    }

    fn remove_login(&self, login_id: &str) -> Result<(), CoreError> {
        let login = lock(&self.inner.state, "계정 로그인 상태")?
            .logins
            .remove(login_id)
            .ok_or_else(|| CoreError::NotFound("계정 로그인 세션을 찾을 수 없습니다".to_owned()))?;
        if login.provider == ProviderId::Claude {
            delete_claude_keychain_credentials(Some(&login.profile_path))?;
        }
        if login.profile_path.exists() {
            fs::remove_dir_all(login.profile_path)?;
        }
        Ok(())
    }

    fn cleanup_orphan_login_profiles(&self) -> Result<(), CoreError> {
        let root = self.inner.app_data_dir.join(AUTH_DIR);
        if !root.exists() {
            return Ok(());
        }
        for entry in fs::read_dir(&root)? {
            let path = entry?.path();
            if path.is_dir() {
                let _ = delete_claude_keychain_credentials(Some(&path));
                fs::remove_dir_all(path)?;
            }
        }
        Ok(())
    }

    fn recover_interrupted_switch(&self) -> Result<(), CoreError> {
        for provider in [ProviderId::Codex, ProviderId::Claude] {
            let Some(journal) = load_journal(&self.inner.app_data_dir, provider)? else {
                continue;
            };
            match self.activate_account(provider, &journal.previous_active_account_id) {
                Ok(()) => remove_journal(&self.inner.app_data_dir, provider)?,
                Err(error) => {
                    lock(&self.inner.state, "계정 상태")?
                        .recovery_error
                        .insert(provider, error.to_string());
                }
            }
        }
        Ok(())
    }

    fn recover_interrupted_refresh(&self) -> Result<(), CoreError> {
        let provider = ProviderId::Claude;
        let Some(journal) = load_refresh_journal(&self.inner.app_data_dir, provider)? else {
            return Ok(());
        };
        let account = {
            let state = lock(&self.inner.state, "계정 상태")?;
            let is_still_active = state
                .registry
                .provider(provider)?
                .active_account_id
                .as_deref()
                == Some(journal.account_id.as_str());
            is_still_active
                .then(|| account_by_id(&state.registry, &journal.account_id).cloned())
                .transpose()?
        };
        let Some(account) = account else {
            remove_refresh_journal(&self.inner.app_data_dir, provider)?;
            return Ok(());
        };
        let recovery = self
            .inner
            .vault
            .get(&vault_key(&account))
            .and_then(|stored| self.sync_registered_active_credential(&account, &stored));
        match recovery {
            Ok(_) => remove_refresh_journal(&self.inner.app_data_dir, provider),
            Err(error) => {
                lock(&self.inner.state, "계정 상태")?
                    .recovery_error
                    .insert(provider, error.to_string());
                Ok(())
            }
        }
    }

    fn verify_registered_active_accounts(&self) -> Result<(), CoreError> {
        let active = {
            let state = lock(&self.inner.state, "계정 상태")?;
            state
                .registry
                .providers
                .iter()
                .filter_map(|provider| {
                    let account_id = provider.active_account_id.as_deref()?;
                    account_by_id(&state.registry, account_id)
                        .ok()
                        .cloned()
                        .map(|account| {
                            let pending_reauthentication =
                                provider.pending_default_account_id.as_deref() == Some(account_id);
                            (account, pending_reauthentication)
                        })
                })
                .collect::<Vec<_>>()
        };
        for (account, pending_reauthentication) in active {
            let _switch = self.credential_switch_guard(account.provider)?;
            let is_still_active = {
                let state = lock(&self.inner.state, "계정 상태")?;
                state
                    .registry
                    .provider(account.provider)?
                    .active_account_id
                    .as_deref()
                    == Some(account.id.as_str())
            };
            if !is_still_active {
                continue;
            }
            let result = match self.inner.vault.get(&vault_key(&account)) {
                Ok(secret) if pending_reauthentication => {
                    self.reconcile_pending_active_credential(&account, &secret)
                }
                Ok(secret) => self.sync_registered_active_credential(&account, &secret),
                Err(CoreError::NotFound(_)) => self.recover_missing_active_credential(&account),
                Err(error) => Err(error),
            };
            match result {
                Ok(ActiveCredentialSync::Matched { credential_changed }) => {
                    let mut state = lock(&self.inner.state, "계정 상태")?;
                    let recovery_removed = state.recovery_error.remove(&account.provider).is_some();
                    let record = account_by_id_mut(&mut state.registry, &account.id)?;
                    let auth_status_changed = record.auth_status != AccountAuthStatus::Ready;
                    record.auth_status = AccountAuthStatus::Ready;
                    if credential_changed {
                        record.usage = AccountUsageView::default();
                    }
                    if recovery_removed || auth_status_changed || credential_changed {
                        save_registry(&self.inner.app_data_dir, &state.registry)?;
                    }
                }
                Ok(ActiveCredentialSync::Adopted) => {
                    // adopt_captured_active_account가 Vault와 레지스트리를 함께 저장했다.
                }
                Err(error) => {
                    let mut state = lock(&self.inner.state, "계정 상태")?;
                    state
                        .recovery_error
                        .insert(account.provider, error.to_string());
                    if let Ok(record) = account_by_id_mut(&mut state.registry, &account.id) {
                        record.auth_status = AccountAuthStatus::Error;
                    }
                    save_registry(&self.inner.app_data_dir, &state.registry)?;
                }
            }
        }
        Ok(())
    }

    fn validate_registered_credential(
        &self,
        account: &AccountRecord,
        secret: &str,
    ) -> Result<(), CoreError> {
        validate_captured_provider_credential(account.provider, secret)?;
        // Claude 재인증 결과에는 계정 식별자가 없어 공유 `.claude.json`이 유일한 근거인데,
        // 이 파일은 계정 교체를 따라오지 않으므로 신원 판단에 쓰지 않는다.
        // 재인증 자격증명과 계정의 연결은 로그인 프로필에서 수집할 때 이미 확인한다.
        if account.provider == ProviderId::Claude && claude_identity_from_secret(secret).is_err() {
            return Ok(());
        }
        let identity = read_identity(
            &self.inner.home_dir,
            self.provider_root(account.provider)?,
            account.provider,
            None,
            secret,
        )?;
        if !identity_matches_account(&identity, account) {
            return Err(CoreError::Conflict(
                "저장된 재인증 결과가 등록된 계정 신원과 일치하지 않습니다".to_owned(),
            ));
        }
        Ok(())
    }

    fn sync_registered_active_credential(
        &self,
        account: &AccountRecord,
        stored_secret: &str,
    ) -> Result<ActiveCredentialSync, CoreError> {
        let mut captured = match self.capture_credentials(account.provider, None) {
            Ok(captured) => captured,
            Err(error) => {
                self.set_observed_active_account_id(account.provider, None)?;
                return Err(error);
            }
        };
        let changed = !same_secret(stored_secret, &captured.secret);
        // Claude의 공유 `.claude.json`은 마지막 공식 로그인 메타데이터라 자격증명
        // 교체·회전을 따라오지 않을 수 있다. 실제 자격증명이 Vault와 달라졌고 자격증명
        // 자체에 계정 ID가 없으면 현재 액세스 토큰으로 Claude 프로필을 조회해 신원을
        // 다시 확정한다. 이 결과만 다른 등록 계정의 자동 활성화 근거로 사용한다.
        let live_claude_identity = account.provider == ProviderId::Claude
            && changed
            && claude_identity_from_secret(&captured.secret).is_err();
        if live_claude_identity {
            captured.identity = match (self.inner.claude_identity_resolver)(&captured.secret) {
                Ok(identity) => identity,
                Err(error) => {
                    self.set_observed_active_account_id(account.provider, None)?;
                    return Err(CoreError::Runtime(format!(
                        "현재 Claude 자격증명의 계정 신원을 확인하지 못했습니다: {error}"
                    )));
                }
            };
        }
        if !identity_matches_account(&captured.identity, account) {
            if live_claude_identity
                || captured_identity_is_authoritative(account.provider, &captured.secret)
            {
                if live_claude_identity {
                    let matches_registered_account = lock(&self.inner.state, "계정 상태")?
                        .registry
                        .accounts
                        .iter()
                        .any(|candidate| {
                            candidate.provider == account.provider
                                && identity_matches_account(&captured.identity, candidate)
                        });
                    if !matches_registered_account {
                        self.set_observed_active_account_id(account.provider, None)?;
                        return Err(CoreError::Conflict(
                            "현재 Claude 자격증명의 신원이 등록된 계정과 일치하지 않습니다"
                                .to_owned(),
                        ));
                    }
                }
                self.adopt_captured_active_account(account.provider, captured)?;
                return Ok(ActiveCredentialSync::Adopted);
            }
            // 일부 Claude 자격증명에는 계정 ID가 없고, 공유 메타데이터는 직전 로그인
            // 계정을 계속 가리킬 수 있다. 자격증명이 Vault 값과 동일하면 메타데이터만으로
            // 실제 활성 계정을 바꾸지 않는다.
            if !changed {
                self.set_observed_active_account_id(account.provider, Some(account.id.clone()))?;
                verify_active_identity(
                    &self.inner.home_dir,
                    self.provider_root(account.provider)?,
                    account.provider,
                    self.inner.claude_keychain_profile.as_deref(),
                    self.inner.inspect_external_processes,
                    account,
                    &captured.secret,
                )?;
                return Ok(ActiveCredentialSync::Matched {
                    credential_changed: false,
                });
            }
            self.set_observed_active_account_id(account.provider, None)?;
            return Err(CoreError::Conflict(
                "공유 CLI 홈의 활성 인증 신원을 확정하지 못해 등록된 활성 계정과 자동 동기화할 수 없습니다"
                    .to_owned(),
            ));
        }
        self.set_observed_active_account_id(account.provider, Some(account.id.clone()))?;
        verify_active_identity(
            &self.inner.home_dir,
            self.provider_root(account.provider)?,
            account.provider,
            self.inner.claude_keychain_profile.as_deref(),
            self.inner.inspect_external_processes,
            account,
            &captured.secret,
        )?;
        if changed {
            self.inner
                .vault
                .put(&vault_key(account), &captured.secret)?;
        }
        Ok(ActiveCredentialSync::Matched {
            credential_changed: changed,
        })
    }

    fn read_back_active_claude_credentials(&self, account_id: &str) -> Result<(), CoreError> {
        let account = {
            let state = lock(&self.inner.state, "계정 상태")?;
            let account = account_by_id(&state.registry, account_id)?.clone();
            if account.provider != ProviderId::Claude {
                return Ok(());
            }
            account
        };
        let stored = self.inner.vault.get(&vault_key(&account))?;
        self.sync_registered_active_credential(&account, &stored)
            .map(|_| ())
    }

    fn reconcile_pending_active_credential(
        &self,
        account: &AccountRecord,
        stored_secret: &str,
    ) -> Result<ActiveCredentialSync, CoreError> {
        // 재인증 완료 후 적용 대기 중인 Vault 값은 공유 홈의 이전/불완전한 자격증명보다
        // 우선한다. 다만 공유 홈에서 다른 계정 신원이 확정되면 그 실제 계정을 채택한다.
        self.validate_registered_credential(account, stored_secret)?;
        let captured = match self.capture_credentials(account.provider, None) {
            Ok(captured) => captured,
            Err(_) => {
                self.set_observed_active_account_id(account.provider, None)?;
                return Ok(ActiveCredentialSync::Matched {
                    credential_changed: false,
                });
            }
        };
        if !identity_matches_account(&captured.identity, account) {
            if captured_identity_is_authoritative(account.provider, &captured.secret) {
                self.adopt_captured_active_account(account.provider, captured)?;
                return Ok(ActiveCredentialSync::Adopted);
            }
            self.set_observed_active_account_id(account.provider, None)?;
            return Ok(ActiveCredentialSync::Matched {
                credential_changed: false,
            });
        }
        self.set_observed_active_account_id(account.provider, Some(account.id.clone()))?;
        Ok(ActiveCredentialSync::Matched {
            credential_changed: false,
        })
    }

    fn recover_missing_active_credential(
        &self,
        account: &AccountRecord,
    ) -> Result<ActiveCredentialSync, CoreError> {
        let captured = match self.capture_credentials(account.provider, None) {
            Ok(captured) => captured,
            Err(error) => {
                self.set_observed_active_account_id(account.provider, None)?;
                return Err(error);
            }
        };
        if !identity_matches_account(&captured.identity, account) {
            if captured_identity_is_authoritative(account.provider, &captured.secret) {
                self.adopt_captured_active_account(account.provider, captured)?;
                return Ok(ActiveCredentialSync::Adopted);
            }
            self.set_observed_active_account_id(account.provider, None)?;
            return Err(CoreError::Conflict(
                "공유 CLI 홈의 활성 인증 신원을 확정하지 못해 등록된 활성 계정과 자동 동기화할 수 없습니다"
                    .to_owned(),
            ));
        }
        verify_active_identity(
            &self.inner.home_dir,
            self.provider_root(account.provider)?,
            account.provider,
            self.inner.claude_keychain_profile.as_deref(),
            self.inner.inspect_external_processes,
            account,
            &captured.secret,
        )?;
        self.inner
            .vault
            .put(&vault_key(account), &captured.secret)?;
        self.set_observed_active_account_id(account.provider, Some(account.id.clone()))?;
        Ok(ActiveCredentialSync::Matched {
            credential_changed: true,
        })
    }

    fn adopt_captured_active_account(
        &self,
        provider: ProviderId,
        captured: CapturedCredentials,
    ) -> Result<String, CoreError> {
        let now = now_ms();
        let mut state = lock(&self.inner.state, "계정 상태")?;
        let existing_index = state.registry.accounts.iter().position(|account| {
            account.provider == provider && identity_matches_account(&captured.identity, account)
        });
        let (account_id, record) = if let Some(index) = existing_index {
            let mut record = state.registry.accounts[index].clone();
            let identity_changed =
                record.provider_account_id != captured.identity.provider_account_id;
            record.provider_account_id = captured.identity.provider_account_id.clone();
            record.display_name =
                normalized_display_name(None, &captured.identity, record.display_name.as_str());
            record.email = captured.identity.email.clone();
            record.organization = captured.identity.organization.clone();
            record.disabled = false;
            record.auth_status = AccountAuthStatus::Ready;
            if identity_changed {
                record.usage = AccountUsageView::default();
            }
            record.updated_at = now;
            (record.id.clone(), record)
        } else {
            let digest = Sha256::digest(
                format!(
                    "{}:{}",
                    provider.as_str(),
                    captured.identity.provider_account_id
                )
                .as_bytes(),
            );
            let account_id = format!("{}-{}", provider.as_str(), hex_prefix(&digest, 10));
            if state
                .registry
                .accounts
                .iter()
                .any(|account| account.id == account_id)
            {
                return Err(CoreError::Conflict(
                    "확인된 CLI 계정의 내부 식별자가 기존 계정과 충돌합니다".to_owned(),
                ));
            }
            let display_name = normalized_display_name(
                None,
                &captured.identity,
                captured.identity.provider_account_id.as_str(),
            );
            let record = AccountRecord {
                id: account_id.clone(),
                provider,
                display_name,
                email: captured.identity.email.clone(),
                organization: captured.identity.organization.clone(),
                provider_account_id: captured.identity.provider_account_id.clone(),
                disabled: false,
                auto_switch: false,
                auth_status: AccountAuthStatus::Ready,
                usage: AccountUsageView::default(),
                created_at: now,
                updated_at: now,
            };
            (account_id, record)
        };
        verify_active_identity(
            &self.inner.home_dir,
            self.provider_root(provider)?,
            provider,
            self.inner.claude_keychain_profile.as_deref(),
            self.inner.inspect_external_processes,
            &record,
            &captured.secret,
        )?;

        let registry_before = state.registry.clone();
        let key = format!("{}:{account_id}", provider.as_str());
        let old_secret = self.inner.vault.get(&key).ok();
        self.inner.vault.put(&key, &captured.secret)?;
        if let Some(index) = existing_index {
            state.registry.accounts[index] = record;
        } else {
            state.registry.accounts.push(record);
        }
        let provider_state = state.registry.provider_mut(provider)?;
        provider_state.active_account_id = Some(account_id.clone());
        provider_state.pending_default_account_id = None;
        if provider_state.default_account_id.is_none() {
            provider_state.default_account_id = Some(account_id.clone());
        }
        if let Err(error) = save_registry(&self.inner.app_data_dir, &state.registry) {
            state.registry = registry_before;
            if let Err(rollback) = restore_vault_value(
                self.inner.vault.as_ref(),
                &key,
                old_secret.as_ref().map(|secret| secret.as_str()),
            ) {
                return Err(CoreError::Runtime(format!(
                    "CLI 활성 계정 반영과 보안 저장소 롤백이 모두 실패했습니다: {error}; {rollback}"
                )));
            }
            return Err(error);
        }
        state
            .observed_active_account_ids
            .insert(provider, Some(account_id.clone()));
        state.recovery_error.remove(&provider);
        Ok(account_id)
    }

    fn set_observed_active_account_id(
        &self,
        provider: ProviderId,
        account_id: Option<String>,
    ) -> Result<(), CoreError> {
        lock(&self.inner.state, "계정 상태")?
            .observed_active_account_ids
            .insert(provider, account_id);
        Ok(())
    }
}

impl AccountRuntimeLease {
    pub fn release(&mut self) {
        if !self.released {
            self.released = true;
            self.accounts
                .release_runtime(self.provider, self.account_id.as_deref());
        }
    }
}

impl Drop for AccountRuntimeLease {
    fn drop(&mut self) {
        self.release();
    }
}

impl AccountTransitionGuard {
    pub fn id(&self) -> &str {
        &self.transition_id
    }

    pub fn restore(mut self) -> Result<(), CoreError> {
        self.accounts.restore_transition(&self.transition_id)?;
        self.restored = true;
        Ok(())
    }
}

impl Drop for AccountTransitionGuard {
    fn drop(&mut self) {
        if !self.restored {
            let _ = self.accounts.restore_transition(&self.transition_id);
        }
    }
}

struct CapturedCredentials {
    secret: Zeroizing<String>,
    identity: AccountIdentity,
}

enum ActiveCredentialSync {
    Matched { credential_changed: bool },
    Adopted,
}

struct AccountIdentity {
    provider_account_id: String,
    legacy_provider_account_id: Option<String>,
    email: Option<String>,
    organization: Option<String>,
    display_name: Option<String>,
}

fn identity_matches_account(identity: &AccountIdentity, account: &AccountRecord) -> bool {
    identity.provider_account_id == account.provider_account_id
        || (identity.legacy_provider_account_id.as_deref()
            == Some(account.provider_account_id.as_str())
            && identity
                .email
                .as_deref()
                .zip(account.email.as_deref())
                .is_some_and(|(identity_email, account_email)| {
                    identity_email.eq_ignore_ascii_case(account_email)
                }))
}

fn captured_identity_is_authoritative(provider: ProviderId, secret: &str) -> bool {
    match provider {
        ProviderId::Codex => true,
        ProviderId::Claude => claude_identity_from_secret(secret).is_ok(),
        ProviderId::Antigravity => false,
    }
}

fn should_defer_claude_refresh(
    replaces_active_credentials: bool,
    account_runtime_running: bool,
    external_process_running: bool,
) -> bool {
    !replaces_active_credentials && (account_runtime_running || external_process_running)
}

fn ensure_managed_provider(provider: ProviderId) -> Result<(), CoreError> {
    if matches!(provider, ProviderId::Codex | ProviderId::Claude) {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "이 공급자는 다중 계정 관리를 지원하지 않습니다".to_owned(),
        ))
    }
}

fn login_view(login: &AccountLoginSession) -> AccountLoginSessionView {
    AccountLoginSessionView {
        id: login.id.clone(),
        provider: login.provider,
        account_id: login.account_id.clone(),
        environment_variable: match login.provider {
            ProviderId::Codex => "CODEX_HOME",
            ProviderId::Claude => "CLAUDE_CONFIG_DIR",
            ProviderId::Antigravity => "",
        }
        .to_owned(),
        profile_path: login.profile_path.to_string_lossy().into_owned(),
        command: match login.provider {
            ProviderId::Codex => "codex login",
            ProviderId::Claude => "claude auth login --claudeai",
            ProviderId::Antigravity => "",
        }
        .to_owned(),
    }
}

fn normalized_display_name(
    requested: Option<String>,
    identity: &AccountIdentity,
    fallback: &str,
) -> String {
    requested
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(|| identity.display_name.clone())
        .or_else(|| identity.email.clone())
        .unwrap_or_else(|| fallback.to_owned())
}

fn vault_key(account: &AccountRecord) -> String {
    format!("{}:{}", account.provider.as_str(), account.id)
}

fn account_by_id<'a>(
    registry: &'a AccountRegistry,
    id: &str,
) -> Result<&'a AccountRecord, CoreError> {
    registry
        .accounts
        .iter()
        .find(|account| account.id == id)
        .ok_or_else(|| CoreError::NotFound("계정을 찾을 수 없습니다".to_owned()))
}

fn account_by_id_mut<'a>(
    registry: &'a mut AccountRegistry,
    id: &str,
) -> Result<&'a mut AccountRecord, CoreError> {
    registry
        .accounts
        .iter_mut()
        .find(|account| account.id == id)
        .ok_or_else(|| CoreError::NotFound("계정을 찾을 수 없습니다".to_owned()))
}

fn validate_registry(registry: &AccountRegistry) -> Result<(), CoreError> {
    if registry.schema_version != SCHEMA_VERSION {
        return Err(CoreError::InvalidInput(
            "지원하지 않는 계정 저장소 버전입니다".to_owned(),
        ));
    }
    if !(legacy_credential_vault_version()..=CREDENTIAL_VAULT_VERSION)
        .contains(&registry.credential_vault_version)
    {
        return Err(CoreError::InvalidInput(
            "지원하지 않는 자격증명 저장소 버전입니다".to_owned(),
        ));
    }
    for provider in [ProviderId::Codex, ProviderId::Claude] {
        registry.provider(provider)?;
    }
    Ok(())
}

fn migrate_registry_to_single_vault(
    app_data_dir: &Path,
    registry: &mut AccountRegistry,
) -> Result<(), CoreError> {
    if registry.credential_vault_version == CREDENTIAL_VAULT_VERSION {
        return Ok(());
    }
    for account in &mut registry.accounts {
        account.auth_status = AccountAuthStatus::Missing;
        account.usage = AccountUsageView::default();
        account.updated_at = now_ms();
    }
    registry.credential_vault_version = CREDENTIAL_VAULT_VERSION;
    save_registry(app_data_dir, registry)
}

#[cfg(target_os = "macos")]
pub(crate) fn migrate_legacy_macos_credential_vault(
    app_data_dir: &Path,
) -> Result<usize, CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let app_data_dir = fs::canonicalize(app_data_dir)?;
    let vault = OsCredentialVault::open(&app_data_dir)?;
    let legacy_store = OsVaultDocumentStore::legacy_for_migration();
    let entry_keys = vault.replace_from_legacy_store(&legacy_store)?;

    let mut registry = load_registry(&app_data_dir)?;
    validate_registry(&registry)?;
    for account in &mut registry.accounts {
        account.auth_status = if entry_keys.contains(&vault_key(account)) {
            AccountAuthStatus::Ready
        } else {
            AccountAuthStatus::Missing
        };
        account.usage = AccountUsageView::default();
        account.updated_at = now_ms();
    }
    registry.credential_vault_version = CREDENTIAL_VAULT_VERSION;
    save_registry(&app_data_dir, &registry)?;
    Ok(entry_keys.len())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn migrate_legacy_macos_credential_vault(
    _app_data_dir: &Path,
) -> Result<usize, CoreError> {
    Err(CoreError::InvalidInput(
        "v2 Keychain Vault 마이그레이션은 macOS에서만 지원합니다".to_owned(),
    ))
}

fn load_registry(app_data_dir: &Path) -> Result<AccountRegistry, CoreError> {
    let path = app_data_dir.join(REGISTRY_FILE);
    if !path.exists() {
        let registry = AccountRegistry::empty();
        save_registry(app_data_dir, &registry)?;
        return Ok(registry);
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn save_registry(app_data_dir: &Path, registry: &AccountRegistry) -> Result<(), CoreError> {
    atomic_write_json(&app_data_dir.join(REGISTRY_FILE), registry)
}

fn save_journal(app_data_dir: &Path, journal: &SwitchJournal) -> Result<(), CoreError> {
    atomic_write_json(&journal_path(app_data_dir, journal.provider), journal)
}

fn load_journal(
    app_data_dir: &Path,
    provider: ProviderId,
) -> Result<Option<SwitchJournal>, CoreError> {
    let path = journal_path(app_data_dir, provider);
    if !path.exists() {
        return Ok(None);
    }
    let journal: SwitchJournal = serde_json::from_slice(&fs::read(path)?)?;
    if journal.provider != provider {
        return Err(CoreError::Runtime(
            "계정 전환 journal 공급자가 파일명과 일치하지 않습니다".to_owned(),
        ));
    }
    Ok(Some(journal))
}

fn update_journal_phase(
    app_data_dir: &Path,
    provider: ProviderId,
    phase: SwitchPhase,
) -> Result<(), CoreError> {
    let mut journal = load_journal(app_data_dir, provider)?
        .ok_or_else(|| CoreError::Runtime("계정 전환 journal이 없습니다".to_owned()))?;
    journal.phase = phase;
    save_journal(app_data_dir, &journal)
}

fn remove_journal(app_data_dir: &Path, provider: ProviderId) -> Result<(), CoreError> {
    let path = journal_path(app_data_dir, provider);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn journal_path(app_data_dir: &Path, provider: ProviderId) -> PathBuf {
    app_data_dir.join(format!("{JOURNAL_FILE_PREFIX}-{}.json", provider.as_str()))
}

fn save_refresh_journal(
    app_data_dir: &Path,
    journal: &CredentialRefreshJournal,
) -> Result<(), CoreError> {
    atomic_write_json(
        &refresh_journal_path(app_data_dir, journal.provider),
        journal,
    )
}

fn load_refresh_journal(
    app_data_dir: &Path,
    provider: ProviderId,
) -> Result<Option<CredentialRefreshJournal>, CoreError> {
    let path = refresh_journal_path(app_data_dir, provider);
    if !path.exists() {
        return Ok(None);
    }
    let journal: CredentialRefreshJournal = serde_json::from_slice(&fs::read(path)?)?;
    if journal.provider != provider {
        return Err(CoreError::Runtime(
            "자격증명 갱신 journal 공급자가 파일명과 일치하지 않습니다".to_owned(),
        ));
    }
    Ok(Some(journal))
}

fn remove_refresh_journal(app_data_dir: &Path, provider: ProviderId) -> Result<(), CoreError> {
    let path = refresh_journal_path(app_data_dir, provider);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn refresh_journal_path(app_data_dir: &Path, provider: ProviderId) -> PathBuf {
    app_data_dir.join(format!(
        "{REFRESH_JOURNAL_FILE_PREFIX}-{}.json",
        provider.as_str()
    ))
}

fn atomic_write_json(path: &Path, value: &impl Serialize) -> Result<(), CoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| CoreError::InvalidInput("저장 경로의 상위 폴더가 없습니다".to_owned()))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("data"),
        Uuid::new_v4()
    ));
    let bytes = serde_json::to_vec_pretty(value)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let result = (|| -> Result<(), CoreError> {
        let mut file = options.open(&temporary)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn read_active_credentials(
    provider_root: &Path,
    provider: ProviderId,
    profile: Option<&Path>,
    keychain_profile: Option<&Path>,
    use_keychain: bool,
) -> Result<Zeroizing<String>, CoreError> {
    match provider {
        ProviderId::Codex => {
            let path = provider_auth_file(provider_root, provider, profile)?;
            read_secret_file(&path)
        }
        ProviderId::Claude => {
            if use_keychain {
                if let Some(credentials) = read_claude_keychain_credentials(keychain_profile)? {
                    return Ok(credentials);
                }
            }
            let path = provider_auth_file(provider_root, provider, profile)?;
            read_secret_file(&path)
        }
        ProviderId::Antigravity => Err(CoreError::InvalidInput(
            "Antigravity 자격증명은 지원하지 않습니다".to_owned(),
        )),
    }
}

fn read_secret_file(path: &Path) -> Result<Zeroizing<String>, CoreError> {
    let bytes = fs::read(path).map_err(|error| {
        CoreError::Runtime(format!("공급자 인증 파일을 읽지 못했습니다: {error}"))
    })?;
    match String::from_utf8(bytes) {
        Ok(secret) => Ok(Zeroizing::new(secret)),
        Err(error) => {
            let mut bytes = error.into_bytes();
            bytes.zeroize();
            Err(CoreError::Runtime(
                "공급자 인증 파일이 UTF-8 JSON이 아닙니다".to_owned(),
            ))
        }
    }
}

fn write_active_credentials(
    provider_root: &Path,
    provider: ProviderId,
    keychain_profile: Option<&Path>,
    use_keychain: bool,
    secret: &str,
) -> Result<(), CoreError> {
    let compact_secret = compact_json_secret(secret)
        .map_err(|_| CoreError::Runtime("보안 저장소의 인증 JSON이 손상되었습니다".to_owned()))?;
    match provider {
        ProviderId::Codex => {
            let path = provider_auth_file(provider_root, provider, None)?;
            atomic_write_secret(&path, &compact_secret)
        }
        ProviderId::Claude => {
            if use_keychain && claude_keychain_credentials_exist(keychain_profile)? {
                write_claude_keychain_credentials(keychain_profile, &compact_secret)
            } else {
                let path = provider_auth_file(provider_root, provider, None)?;
                atomic_write_secret(&path, &compact_secret)
            }
        }
        ProviderId::Antigravity => Err(CoreError::InvalidInput(
            "Antigravity 자격증명은 지원하지 않습니다".to_owned(),
        )),
    }
}

fn compact_json_secret(secret: &str) -> Result<Zeroizing<String>, serde_json::Error> {
    let value: Value = serde_json::from_str(secret)?;
    serde_json::to_string(&value).map(Zeroizing::new)
}

/// 인증을 기록할 때 JSON을 압축해 쓰므로, 같은 자격증명인지는 압축한 형태로 비교한다.
fn same_secret(left: &str, right: &str) -> bool {
    let digest = |secret: &str| {
        compact_json_secret(secret)
            .map(|compact| Sha256::digest(compact.as_bytes()))
            .unwrap_or_else(|_| Sha256::digest(secret.as_bytes()))
    };
    digest(left) == digest(right)
}

fn atomic_write_secret(path: &Path, secret: &str) -> Result<(), CoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| CoreError::InvalidInput("인증 경로의 상위 폴더가 없습니다".to_owned()))?;
    fs::create_dir_all(parent)?;
    let trusted_parent = fs::canonicalize(parent)?;
    let expected = trusted_parent.join(
        path.file_name()
            .ok_or_else(|| CoreError::InvalidInput("인증 파일명이 없습니다".to_owned()))?,
    );
    let temporary = trusted_parent.join(format!(".agent-manager-auth-{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let result = (|| -> Result<(), CoreError> {
        let mut file = options.open(&temporary)?;
        file.write_all(secret.as_bytes())?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, &expected)?;
        File::open(&trusted_parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn provider_auth_file(
    provider_root: &Path,
    provider: ProviderId,
    profile: Option<&Path>,
) -> Result<PathBuf, CoreError> {
    let root = if let Some(profile) = profile {
        fs::canonicalize(profile)?
    } else {
        provider_root.to_path_buf()
    };
    let file_name = match provider {
        ProviderId::Codex => "auth.json",
        ProviderId::Claude => ".credentials.json",
        ProviderId::Antigravity => unreachable!(),
    };
    Ok(root.join(file_name))
}

fn read_identity(
    home_dir: &Path,
    provider_root: &Path,
    provider: ProviderId,
    profile: Option<&Path>,
    secret: &str,
) -> Result<AccountIdentity, CoreError> {
    match provider {
        ProviderId::Codex => codex_identity(secret),
        ProviderId::Claude => {
            if let Ok(identity) = claude_identity_from_secret(secret) {
                return Ok(identity);
            }
            let config = profile
                .map(Path::to_path_buf)
                .unwrap_or_else(|| provider_root.to_path_buf());
            let candidates = [config.join(".claude.json"), config.join(".config.json")];
            for path in candidates {
                if let Ok(value) = fs::read(&path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .ok_or(())
                {
                    if let Some(oauth) = value.get("oauthAccount").or(Some(&value)) {
                        if let Ok(identity) = claude_identity(oauth) {
                            return Ok(identity);
                        }
                    }
                }
            }
            if profile.is_none() {
                let path = home_dir.join(".claude.json");
                if let Ok(value) = fs::read(&path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                    .ok_or(())
                {
                    if let Some(oauth) = value.get("oauthAccount") {
                        return claude_identity(oauth);
                    }
                }
            }
            Err(CoreError::Runtime(
                "Claude 로그인 계정 신원을 확인하지 못했습니다".to_owned(),
            ))
        }
        ProviderId::Antigravity => Err(CoreError::InvalidInput(
            "Antigravity 계정 신원은 지원하지 않습니다".to_owned(),
        )),
    }
}

#[derive(Deserialize)]
struct CodexIdentitySecret<'a> {
    #[serde(borrow)]
    tokens: Option<CodexIdentityFields<'a>>,
    #[serde(borrow, alias = "accountId")]
    account_id: Option<&'a str>,
    #[serde(borrow, alias = "idToken")]
    id_token: Option<&'a str>,
}

#[derive(Deserialize)]
struct CodexIdentityFields<'a> {
    #[serde(borrow, alias = "accountId")]
    account_id: Option<&'a str>,
    #[serde(borrow, alias = "idToken")]
    id_token: Option<&'a str>,
}

fn codex_identity(secret: &str) -> Result<AccountIdentity, CoreError> {
    let value: CodexIdentitySecret<'_> = serde_json::from_str(secret)?;
    let account_id = value
        .tokens
        .as_ref()
        .and_then(|tokens| tokens.account_id)
        .or(value.account_id)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let id_token = value
        .tokens
        .as_ref()
        .and_then(|tokens| tokens.id_token)
        .or(value.id_token);
    let claims = id_token.and_then(|token| decode_jwt_claims(token).ok());
    let chatgpt_account_id = account_id.or_else(|| {
        claims.as_ref().and_then(|value| {
            string_field(
                value,
                &[
                    "https://api.openai.com/auth.chatgpt_account_id",
                    "account_id",
                ],
            )
        })
    });
    let subject = claims
        .as_ref()
        .and_then(|value| string_field(value, &["sub"]));
    let provider_account_id = match (&subject, &chatgpt_account_id) {
        (Some(subject), Some(account_id)) => {
            let digest =
                Sha256::digest(format!("codex-user-v1\0{subject}\0{account_id}").as_bytes());
            format!("user-{}", hex_prefix(&digest, 16))
        }
        (Some(subject), None) => subject.clone(),
        (None, Some(account_id)) => account_id.clone(),
        (None, None) => String::new(),
    };
    let provider_account_id = (!provider_account_id.is_empty())
        .then_some(provider_account_id)
        .ok_or_else(|| CoreError::Runtime("Codex 계정 ID를 확인하지 못했습니다".to_owned()))?;
    let legacy_provider_account_id =
        chatgpt_account_id.filter(|account_id| account_id != &provider_account_id);
    let email = claims
        .as_ref()
        .and_then(|value| string_field(value, &["email"]));
    let organization = claims.as_ref().and_then(|value| {
        string_field(
            value,
            &[
                "https://api.openai.com/auth.organization_id",
                "organization_id",
            ],
        )
    });
    Ok(AccountIdentity {
        provider_account_id,
        legacy_provider_account_id,
        display_name: email.clone(),
        email,
        organization,
    })
}

fn claude_identity(value: &Value) -> Result<AccountIdentity, CoreError> {
    let provider_account_id = string_field(value, &["accountUuid", "accountId"])
        .ok_or_else(|| CoreError::Runtime("Claude 계정 ID를 확인하지 못했습니다".to_owned()))?;
    Ok(AccountIdentity {
        provider_account_id,
        legacy_provider_account_id: None,
        email: string_field(value, &["emailAddress", "email"]),
        organization: string_field(value, &["organizationName", "organizationUuid"]),
        display_name: string_field(value, &["displayName"]),
    })
}

#[derive(Deserialize)]
struct ClaudeIdentitySecret<'a> {
    #[serde(borrow, rename = "claudeAiOauth")]
    oauth: Option<ClaudeIdentityFields<'a>>,
    #[serde(flatten, borrow)]
    root: ClaudeIdentityFields<'a>,
}

#[derive(Default, Deserialize)]
struct ClaudeIdentityFields<'a> {
    #[serde(borrow, rename = "accountUuid", alias = "accountId")]
    account_id: Option<&'a str>,
    #[serde(borrow, rename = "emailAddress", alias = "email")]
    email: Option<&'a str>,
    #[serde(
        borrow,
        rename = "organizationName",
        alias = "organizationUuid",
        alias = "organizationId"
    )]
    organization: Option<&'a str>,
    #[serde(borrow, rename = "displayName")]
    display_name: Option<&'a str>,
}

fn claude_identity_from_secret(secret: &str) -> Result<AccountIdentity, CoreError> {
    let credentials: ClaudeIdentitySecret<'_> = serde_json::from_str(secret)?;
    let fields = credentials.oauth.as_ref().unwrap_or(&credentials.root);
    let provider_account_id = fields
        .account_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| CoreError::Runtime("Claude 계정 ID를 확인하지 못했습니다".to_owned()))?;
    Ok(AccountIdentity {
        provider_account_id: provider_account_id.to_owned(),
        legacy_provider_account_id: None,
        email: fields.email.map(str::to_owned),
        organization: fields.organization.map(str::to_owned),
        display_name: fields.display_name.map(str::to_owned),
    })
}

fn decode_jwt_claims(token: &str) -> Result<Value, CoreError> {
    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| CoreError::Runtime("ID 토큰 형식이 잘못되었습니다".to_owned()))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| CoreError::Runtime("ID 토큰을 해석하지 못했습니다".to_owned()))?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn verify_active_identity(
    home_dir: &Path,
    provider_root: &Path,
    provider: ProviderId,
    keychain_profile: Option<&Path>,
    use_keychain: bool,
    expected_account: &AccountRecord,
    expected_secret: &str,
) -> Result<(), CoreError> {
    let secret = read_active_credentials(
        provider_root,
        provider,
        None,
        keychain_profile,
        use_keychain,
    )?;
    let identity = read_identity(home_dir, provider_root, provider, None, &secret);
    if identity
        .as_ref()
        .is_ok_and(|identity| identity_matches_account(identity, expected_account))
    {
        return Ok(());
    }
    // Claude 인증 파일에는 계정 식별자가 없어 신원을 공유 `.claude.json`에서만 읽을 수 있는데,
    // 이 파일은 교체 대상이 아니라 CLI가 마지막으로 로그인한 계정을 계속 가리킨다.
    // 그래서 자격증명만으로 신원을 확인할 수 없으면 교체한 인증이 그대로 남아 있는지로 검증한다.
    if provider == ProviderId::Claude
        && claude_identity_from_secret(&secret).is_err()
        && same_secret(&secret, expected_secret)
    {
        return Ok(());
    }
    match identity {
        Ok(_) => Err(CoreError::Conflict(
            "교체 후 공급자 계정 신원이 예상 계정과 일치하지 않습니다".to_owned(),
        )),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "macos")]
fn claude_keychain_service(profile: Option<&Path>) -> String {
    if let Some(profile) = profile {
        let digest = Sha256::digest(profile.to_string_lossy().as_bytes());
        format!("Claude Code-credentials-{}", hex_prefix(&digest, 4))
    } else if let Some(config) = env::var_os("CLAUDE_CONFIG_DIR") {
        let digest = Sha256::digest(PathBuf::from(config).to_string_lossy().as_bytes());
        format!("Claude Code-credentials-{}", hex_prefix(&digest, 4))
    } else {
        "Claude Code-credentials".to_owned()
    }
}

#[cfg(target_os = "macos")]
fn keychain_account() -> String {
    env::var("USER")
        .or_else(|_| env::var("USERNAME"))
        .unwrap_or_else(|_| "user".to_owned())
}

#[cfg(not(target_os = "macos"))]
fn read_claude_keychain_credentials(
    _profile: Option<&Path>,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn read_claude_keychain_credentials(
    profile: Option<&Path>,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    let service = claude_keychain_service(profile);
    let account = keychain_account();
    match read_os_keychain_password(&service, &account)? {
        Some(secret) => compact_json_secret(&secret).map(Some).map_err(|_| {
            CoreError::Runtime("Claude Keychain 인증 JSON이 손상되었습니다".to_owned())
        }),
        None => Ok(None),
    }
}

fn claude_keychain_credentials_exist(profile: Option<&Path>) -> Result<bool, CoreError> {
    Ok(read_claude_keychain_credentials(profile)?.is_some())
}

#[cfg(not(target_os = "macos"))]
fn write_claude_keychain_credentials(
    _profile: Option<&Path>,
    _secret: &str,
) -> Result<(), CoreError> {
    Err(CoreError::Runtime(
        "이 플랫폼에서는 Claude Keychain을 사용할 수 없습니다".to_owned(),
    ))
}

#[cfg(target_os = "macos")]
fn write_claude_keychain_credentials(
    profile: Option<&Path>,
    secret: &str,
) -> Result<(), CoreError> {
    let service = claude_keychain_service(profile);
    let account = keychain_account();
    let compact_secret = compact_json_secret(secret)
        .map_err(|_| CoreError::Runtime("Claude 인증 JSON이 손상되었습니다".to_owned()))?;
    write_os_keychain_password(&service, &account, &compact_secret).map_err(|error| {
        CoreError::Runtime(format!(
            "Claude Keychain 자격증명을 교체하지 못했습니다: {error}"
        ))
    })
}

#[cfg(not(target_os = "macos"))]
fn delete_claude_keychain_credentials(_profile: Option<&Path>) -> Result<(), CoreError> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn delete_claude_keychain_credentials(profile: Option<&Path>) -> Result<(), CoreError> {
    let service = claude_keychain_service(profile);
    let account = keychain_account();
    delete_os_keychain_password(&service, &account).map_err(|error| {
        CoreError::Runtime(format!(
            "Claude 임시 Keychain 자격증명을 제거하지 못했습니다: {error}"
        ))
    })
}

#[derive(Deserialize)]
struct ClaudeUsageSecret<'a> {
    #[serde(borrow, rename = "claudeAiOauth")]
    oauth: Option<ClaudeUsageOauth<'a>>,
    #[serde(borrow, rename = "accessToken")]
    access_token: Option<&'a str>,
}

#[derive(Deserialize)]
struct ClaudeUsageOauth<'a> {
    #[serde(borrow, rename = "accessToken", alias = "access_token")]
    access_token: &'a str,
}

#[derive(Deserialize)]
struct ClaudeProfileResponse {
    account: ClaudeProfileAccount,
    organization: Option<ClaudeProfileOrganization>,
}

#[derive(Deserialize)]
struct ClaudeProfileAccount {
    uuid: String,
    email: Option<String>,
    display_name: Option<String>,
}

#[derive(Deserialize)]
struct ClaudeProfileOrganization {
    uuid: String,
}

fn claude_secret_has_oauth_access_token(secret: &str) -> bool {
    serde_json::from_str::<ClaudeUsageSecret<'_>>(secret)
        .ok()
        .and_then(|credentials| {
            credentials
                .oauth
                .map(|oauth| oauth.access_token)
                .or(credentials.access_token)
        })
        .is_some_and(|token| !token.is_empty())
}

/// 현재 Claude OAuth 자격증명으로 공식 Claude Code가 사용하는 프로필 API를 조회한다.
/// 응답에서는 비밀정보가 아닌 계정·조직 식별 정보만 추출하며 토큰이나 원문 응답은
/// 오류, 로그, 레지스트리 또는 IPC로 내보내지 않는다.
fn request_claude_profile_identity(secret: &str) -> Result<AccountIdentity, CoreError> {
    let credentials: ClaudeUsageSecret<'_> = serde_json::from_str(secret)?;
    let token = credentials
        .oauth
        .as_ref()
        .map(|oauth| oauth.access_token)
        .or(credentials.access_token)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| CoreError::Runtime("Claude OAuth 토큰이 없습니다".to_owned()))?;
    let authorization_value = Zeroizing::new(format!("Bearer {token}"));
    let authorization = HeaderValue::from_str(&authorization_value)
        .map_err(|_| CoreError::Runtime("Claude 인증 헤더를 만들지 못했습니다".to_owned()))?;
    let response = Client::builder()
        .timeout(USAGE_TIMEOUT)
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!(
                "Claude 신원 조회 클라이언트를 만들지 못했습니다: {error}"
            ))
        })?
        .get(CLAUDE_OAUTH_PROFILE_URL)
        .header(AUTHORIZATION, authorization)
        .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
        .header(CACHE_CONTROL, HeaderValue::from_static("no-cache"))
        .header(USER_AGENT, HeaderValue::from_static("claude-code/2.1.0"))
        .send()
        .map_err(|error| {
            CoreError::Runtime(format!("Claude 계정 신원을 조회하지 못했습니다: {error}"))
        })?;
    let status = response.status();
    if !status.is_success() {
        let message = if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            format!("Claude 계정 신원 조회 인증이 거부되었습니다 (HTTP {status})")
        } else {
            format!("Claude 계정 신원 조회가 실패했습니다 (HTTP {status})")
        };
        return Err(CoreError::Runtime(message));
    }
    let profile: ClaudeProfileResponse = response.json().map_err(|error| {
        CoreError::Runtime(format!("Claude 계정 신원 응답을 읽지 못했습니다: {error}"))
    })?;
    claude_identity_from_profile(profile)
}

fn claude_identity_from_profile(
    profile: ClaudeProfileResponse,
) -> Result<AccountIdentity, CoreError> {
    let provider_account_id = profile.account.uuid.trim().to_owned();
    if provider_account_id.is_empty() {
        return Err(CoreError::Runtime(
            "Claude 계정 신원 응답에 계정 ID가 없습니다".to_owned(),
        ));
    }
    Ok(AccountIdentity {
        provider_account_id,
        legacy_provider_account_id: None,
        email: profile
            .account
            .email
            .map(|email| email.trim().to_owned())
            .filter(|email| !email.is_empty()),
        organization: profile
            .organization
            .map(|organization| organization.uuid.trim().to_owned())
            .filter(|organization| !organization.is_empty()),
        display_name: profile
            .account
            .display_name
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty()),
    })
}

fn validate_captured_provider_credential(
    provider: ProviderId,
    secret: &str,
) -> Result<(), CoreError> {
    if provider != ProviderId::Claude {
        return Ok(());
    }
    let value: Value = serde_json::from_str(secret)?;
    if value.get("claudeAiOauth").is_some() && !claude_secret_has_oauth_access_token(secret) {
        return Err(CoreError::Conflict(
            "Claude 로그인이 아직 완료되지 않았습니다. 공식 Claude CLI로 다시 로그인하고, 브라우저 인증 후 표시된 코드를 로그인 터미널에 붙여넣어 전송한 다음 CLI가 정상 종료될 때까지 기다려 주세요"
                .to_owned(),
        ));
    }
    Ok(())
}

enum ClaudeUsageResponse {
    Usage(AccountUsageView),
    Unauthorized,
    RateLimited { retry_at: i64 },
}

enum ClaudeTokenRefresh {
    Refreshed(Zeroizing<String>),
    RateLimited { retry_at: i64 },
}

/// 저장된 Claude 자격증명의 액세스 토큰이 만료됐는지 확인한다.
/// 만료 시각이 없으면 판단할 수 없으므로 일단 유효한 것으로 보고 호출 결과(401)로 가른다.
fn claude_access_token_expired(secret: &str, now_ms: i64) -> bool {
    serde_json::from_str::<Value>(secret)
        .ok()
        .and_then(|value| value.get("claudeAiOauth")?.get("expiresAt")?.as_i64())
        .is_some_and(|expires_at| {
            expires_at <= now_ms.saturating_add(CLAUDE_TOKEN_EXPIRY_MARGIN_MS)
        })
}

/// 보관된 리프레시 토큰으로 Claude OAuth 토큰을 갱신한다. 429는 기존 자격증명을
/// 폐기하거나 재인증 오류로 바꾸지 않고 호출자가 재시도 시각을 보존하도록 돌려준다.
fn refresh_claude_oauth_secret(secret: &str) -> Result<ClaudeTokenRefresh, CoreError> {
    let value: Value = serde_json::from_str(secret)?;
    let refresh_token = value
        .get("claudeAiOauth")
        .and_then(|oauth| oauth.get("refreshToken"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            CoreError::Conflict(
                "Claude 액세스 토큰이 만료됐지만 저장된 갱신 토큰이 없습니다. 계정을 다시 인증해 주세요"
                    .to_owned(),
            )
        })?;
    let response = Client::builder()
        .timeout(USAGE_TIMEOUT)
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!("토큰 갱신 클라이언트를 만들지 못했습니다: {error}"))
        })?
        .post(CLAUDE_OAUTH_TOKEN_URL)
        .header(USER_AGENT, HeaderValue::from_static("claude-code/2.1.0"))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CLAUDE_OAUTH_CLIENT_ID),
        ])
        .send()
        .map_err(|error| {
            CoreError::Runtime(format!("Claude 토큰을 갱신하지 못했습니다: {error}"))
        })?;
    let status = response.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        return Ok(ClaudeTokenRefresh::RateLimited {
            retry_at: retry_at_from_headers(response.headers(), now_ms()),
        });
    }
    if !status.is_success() {
        if matches!(
            status,
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Err(CoreError::Conflict(format!(
                "Claude 토큰 갱신 인증이 거부되었습니다 (HTTP {status}). 계정을 다시 인증해 주세요"
            )));
        }
        return Err(CoreError::Runtime(format!(
            "Claude 토큰 갱신이 일시적으로 실패했습니다 (HTTP {status}). 기존 자격증명을 유지합니다"
        )));
    }
    let granted: Value = response.json().map_err(|error| {
        CoreError::Runtime(format!("Claude 토큰 갱신 응답을 읽지 못했습니다: {error}"))
    })?;
    merge_refreshed_claude_oauth(secret, &granted, now_ms()).map(ClaudeTokenRefresh::Refreshed)
}

/// 토큰 갱신 응답을 기존 자격증명 JSON에 합친다. 액세스·갱신 토큰과 만료 시각만 바꾸고
/// 나머지 필드(구독 종류, 범위 등)는 그대로 유지한다.
fn merge_refreshed_claude_oauth(
    secret: &str,
    granted: &Value,
    now_ms: i64,
) -> Result<Zeroizing<String>, CoreError> {
    let access_token = granted
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| {
            CoreError::Runtime("Claude 토큰 갱신 응답에 액세스 토큰이 없습니다".to_owned())
        })?;
    let mut value: Value = serde_json::from_str(secret)?;
    let oauth = value
        .get_mut("claudeAiOauth")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| {
            CoreError::Runtime("Claude 자격증명에 claudeAiOauth 항목이 없습니다".to_owned())
        })?;
    oauth.insert("accessToken".to_owned(), Value::from(access_token));
    if let Some(refresh_token) = granted
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
    {
        oauth.insert("refreshToken".to_owned(), Value::from(refresh_token));
    }
    if let Some(expires_in) = granted.get("expires_in").and_then(Value::as_i64) {
        oauth.insert(
            "expiresAt".to_owned(),
            Value::from(now_ms.saturating_add(expires_in.saturating_mul(1000))),
        );
    }
    serde_json::to_string(&value)
        .map(Zeroizing::new)
        .map_err(CoreError::from)
}

fn request_claude_usage(secret: &str) -> Result<ClaudeUsageResponse, CoreError> {
    let credentials: ClaudeUsageSecret<'_> = serde_json::from_str(secret)?;
    let token = credentials
        .oauth
        .as_ref()
        .map(|oauth| oauth.access_token)
        .or(credentials.access_token)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| CoreError::Runtime("Claude OAuth 토큰이 없습니다".to_owned()))?;
    let mut headers = HeaderMap::new();
    let authorization_value = Zeroizing::new(format!("Bearer {token}"));
    let authorization = HeaderValue::from_str(&authorization_value)
        .map_err(|_| CoreError::Runtime("Claude 인증 헤더를 만들지 못했습니다".to_owned()))?;
    headers.insert(AUTHORIZATION, authorization);
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("oauth-2025-04-20"),
    );
    headers.insert(USER_AGENT, HeaderValue::from_static("claude-code/2.1.0"));
    let response = Client::builder()
        .timeout(USAGE_TIMEOUT)
        .default_headers(headers)
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!("사용량 클라이언트를 만들지 못했습니다: {error}"))
        })?
        .get("https://api.anthropic.com/api/oauth/usage")
        .send()
        .map_err(|error| {
            CoreError::Runtime(format!("Claude 사용량을 조회하지 못했습니다: {error}"))
        })?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Ok(ClaudeUsageResponse::Unauthorized);
    }
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Ok(ClaudeUsageResponse::RateLimited {
            retry_at: retry_at_from_headers(response.headers(), now_ms()),
        });
    }
    if !response.status().is_success() {
        return Err(CoreError::Runtime(format!(
            "Claude 사용량 조회가 실패했습니다 (HTTP {})",
            response.status()
        )));
    }
    let value: Value = response.json().map_err(|error| {
        CoreError::Runtime(format!("Claude 사용량 응답을 읽지 못했습니다: {error}"))
    })?;
    let windows = [
        ("5시간", value.get("five_hour")),
        ("7일", value.get("seven_day")),
        (
            "Fable 7일",
            value
                .get("seven_day_fable")
                .or_else(|| value.get("fable_weekly")),
        ),
    ]
    .into_iter()
    .filter_map(|(label, value)| value.and_then(|value| usage_window(label, value)))
    .collect::<Vec<_>>();
    Ok(ClaudeUsageResponse::Usage(usage_result(windows)))
}

#[derive(Deserialize)]
struct CodexUsageSecret<'a> {
    #[serde(borrow)]
    tokens: CodexUsageTokens<'a>,
}

#[derive(Deserialize)]
struct CodexUsageTokens<'a> {
    #[serde(borrow)]
    access_token: &'a str,
    #[serde(borrow)]
    account_id: Option<&'a str>,
}

fn fetch_codex_usage(secret: &str) -> Result<AccountUsageView, CoreError> {
    let credentials: CodexUsageSecret<'_> = serde_json::from_str(secret)?;
    if credentials.tokens.access_token.is_empty() {
        return Err(CoreError::Runtime("Codex OAuth 토큰이 없습니다".to_owned()));
    }
    let mut headers = HeaderMap::new();
    let authorization_value = Zeroizing::new(format!("Bearer {}", credentials.tokens.access_token));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&authorization_value)
            .map_err(|_| CoreError::Runtime("Codex 인증 헤더를 만들지 못했습니다".to_owned()))?,
    );
    headers.insert(USER_AGENT, HeaderValue::from_static("codex-cli"));
    headers.insert("openai-beta", HeaderValue::from_static("codex-1"));
    headers.insert("originator", HeaderValue::from_static("Codex Desktop"));
    if let Some(account_id) = credentials
        .tokens
        .account_id
        .filter(|value| !value.is_empty())
    {
        headers.insert(
            "chatgpt-account-id",
            HeaderValue::from_str(account_id).map_err(|_| {
                CoreError::Runtime("Codex 계정 헤더를 만들지 못했습니다".to_owned())
            })?,
        );
    }
    let response = Client::builder()
        .timeout(USAGE_TIMEOUT)
        .default_headers(headers)
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!("사용량 클라이언트를 만들지 못했습니다: {error}"))
        })?
        .get("https://chatgpt.com/backend-api/wham/usage")
        .send()
        .map_err(|error| {
            CoreError::Runtime(format!("Codex 사용량을 조회하지 못했습니다: {error}"))
        })?;
    if !response.status().is_success() {
        return Err(CoreError::Runtime(format!(
            "Codex 사용량 조회가 실패했습니다 (HTTP {})",
            response.status()
        )));
    }
    let response: Value = response.json().map_err(|error| {
        CoreError::Runtime(format!("Codex 사용량 응답을 읽지 못했습니다: {error}"))
    })?;
    let limits = response
        .get("rate_limit")
        .ok_or_else(|| CoreError::Runtime("Codex 사용량 응답에 한도 정보가 없습니다".to_owned()))?;
    let windows = [
        ("5시간", limits.get("primary_window")),
        ("7일", limits.get("secondary_window")),
    ]
    .into_iter()
    .filter_map(|(fallback_label, value)| {
        value.and_then(|value| {
            let label = window_duration_label(value).unwrap_or_else(|| fallback_label.to_owned());
            usage_window(&label, value)
        })
    })
    .collect::<Vec<_>>();
    Ok(usage_result(windows))
}

/// Codex 창 길이는 플랜에 따라 다르므로(예: Team은 primary가 7일) 응답의
/// 창 길이 필드가 있으면 그것으로 라벨을 만든다.
fn window_duration_label(value: &Value) -> Option<String> {
    let seconds = number_field(value, &["limit_window_seconds", "window_seconds"])
        .or_else(|| {
            number_field(value, &["window_minutes", "limit_window_minutes"])
                .map(|minutes| minutes * 60.0)
        })
        .filter(|seconds| *seconds > 0.0)? as i64;
    if seconds % 86_400 == 0 {
        Some(format!("{}일", seconds / 86_400))
    } else if seconds % 3_600 == 0 {
        Some(format!("{}시간", seconds / 3_600))
    } else {
        Some(format!("{}분", seconds / 60))
    }
}

fn usage_window(label: &str, value: &Value) -> Option<AccountUsageWindow> {
    let used_percent = number_field(value, &["usedPercent", "used_percent", "utilization"])?;
    const RESET_KEYS: [&str; 4] = ["resetsAt", "resets_at", "resetAt", "reset_at"];
    let resets_at = number_field(value, &RESET_KEYS)
        .map(|value| {
            let raw = value as i64;
            if raw < 10_000_000_000 {
                raw.saturating_mul(1000)
            } else {
                raw
            }
        })
        .or_else(|| timestamp_field(value, &RESET_KEYS));
    Some(AccountUsageWindow {
        label: label.to_owned(),
        used_percent: used_percent.clamp(0.0, 100.0),
        resets_at,
    })
}

/// Claude 사용량 응답은 리셋 시각을 ISO 8601 문자열로 반환하므로 숫자 파싱이
/// 실패하면 RFC 3339로 해석한다.
fn timestamp_field(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(Value::as_str).and_then(|text| {
            chrono::DateTime::parse_from_rfc3339(text)
                .ok()
                .map(|date| date.timestamp_millis())
        })
    })
}

fn number_field(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        value.get(*key).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        })
    })
}

fn retry_at_from_headers(headers: &HeaderMap, now: i64) -> i64 {
    let parsed = headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .parse::<i64>()
                .ok()
                .map(|seconds| now.saturating_add(seconds.saturating_mul(1000)))
                .or_else(|| {
                    chrono::DateTime::parse_from_rfc2822(value)
                        .ok()
                        .map(|date| date.timestamp_millis())
                })
        });
    parsed
        .unwrap_or_else(|| now.saturating_add(CLAUDE_RATE_LIMIT_DEFAULT_RETRY_MS))
        .clamp(
            now.saturating_add(CLAUDE_RATE_LIMIT_MIN_RETRY_MS),
            now.saturating_add(RATE_LIMITED_STALE_THRESHOLD_MS),
        )
}

fn usage_retry_result(message: impl Into<String>, retry_at: i64) -> AccountUsageView {
    AccountUsageView {
        status: AccountUsageStatus::Error,
        windows: Vec::new(),
        updated_at: Some(now_ms()),
        error: Some(message.into()),
        retry_at: Some(retry_at),
        rate_limited: false,
    }
}

fn rate_limited_usage_result(message: impl Into<String>, retry_at: i64) -> AccountUsageView {
    AccountUsageView {
        rate_limited: true,
        ..usage_retry_result(message, retry_at)
    }
}

fn usage_error_result(error: CoreError) -> AccountUsageView {
    let now = now_ms();
    usage_retry_result(error.to_string(), now.saturating_add(USAGE_ERROR_RETRY_MS))
}

/// 방금 저장한 사용량이 100% 도달(=자동전환 트리거)인지 판정한다.
fn usage_indicates_exhaustion(usage: &AccountUsageView) -> bool {
    usage
        .windows
        .iter()
        .any(|window| window.used_percent >= 100.0)
}

/// 캐시된 사용량 기준으로 계정이 아직 제한 상태로 보여 자동전환 후보에서
/// 제외해야 하는지 판정한다. 리셋 시각이 지났으면 다시 후보가 된다.
fn usage_blocks_auto_switch(usage: &AccountUsageView, now: i64) -> bool {
    if usage.rate_limited && usage.retry_at.is_none_or(|retry_at| retry_at > now) {
        return true;
    }
    usage.windows.iter().any(|window| {
        window.used_percent >= 100.0 && window.resets_at.is_none_or(|resets_at| resets_at > now)
    })
}

/// 레지스트리 등록 순서 기준으로 현재 활성 계정 다음부터 순환하며 자동전환이
/// 켜진 사용 가능한 계정을 고른다.
fn select_auto_switch_target(
    accounts: &[AccountRecord],
    provider: ProviderId,
    active_account_id: &str,
    now: i64,
) -> Option<String> {
    if accounts.is_empty() {
        return None;
    }
    let start = accounts
        .iter()
        .position(|account| account.id == active_account_id)
        .map(|index| index + 1)
        .unwrap_or(0);
    (0..accounts.len())
        .map(|offset| &accounts[(start + offset) % accounts.len()])
        .find(|account| {
            account.provider == provider
                && account.id != active_account_id
                && account.auto_switch
                && !account.disabled
                && account.auth_status == AccountAuthStatus::Ready
                && !usage_blocks_auto_switch(&account.usage, now)
        })
        .map(|account| account.id.clone())
}

fn reconciled_auth_status_after_usage(
    current: AccountAuthStatus,
    active_credential_validated: bool,
    fresh_usage_status: AccountUsageStatus,
) -> AccountAuthStatus {
    if active_credential_validated
        || matches!(
            fresh_usage_status,
            AccountUsageStatus::Ok | AccountUsageStatus::Unavailable
        )
    {
        AccountAuthStatus::Ready
    } else {
        current
    }
}

fn apply_usage_stale_policy(
    fresh: AccountUsageView,
    previous: &AccountUsageView,
    now: i64,
) -> AccountUsageView {
    if fresh.status != AccountUsageStatus::Error || previous.windows.is_empty() {
        return fresh;
    }
    let threshold = if fresh.rate_limited {
        RATE_LIMITED_STALE_THRESHOLD_MS
    } else {
        USAGE_STALE_THRESHOLD_MS
    };
    if previous
        .updated_at
        .is_none_or(|updated_at| now.saturating_sub(updated_at) > threshold)
    {
        return fresh;
    }
    AccountUsageView {
        windows: previous.windows.clone(),
        updated_at: previous.updated_at,
        ..fresh
    }
}

fn usage_result(windows: Vec<AccountUsageWindow>) -> AccountUsageView {
    if windows.is_empty() {
        AccountUsageView {
            status: AccountUsageStatus::Unavailable,
            windows,
            updated_at: Some(now_ms()),
            error: Some("계정 한도 정보를 제공하지 않았습니다".to_owned()),
            retry_at: None,
            rate_limited: false,
        }
    } else {
        AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows,
            updated_at: Some(now_ms()),
            error: None,
            retry_at: None,
            rate_limited: false,
        }
    }
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, destination: &Path) -> Result<(), CoreError> {
    fs::rename(temporary, destination)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(temporary: &Path, destination: &Path) -> Result<(), CoreError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(CoreError::Io(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

fn hex_prefix(bytes: &[u8], length: usize) -> String {
    bytes
        .iter()
        .take(length)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn lock<'a, T>(mutex: &'a Mutex<T>, label: &str) -> Result<MutexGuard<'a, T>, CoreError> {
    mutex
        .lock()
        .map_err(|_| CoreError::Runtime(format!("{label} 잠금이 손상되었습니다")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    use std::os::unix::fs::PermissionsExt;

    #[derive(Default)]
    struct MemoryVault(Mutex<HashMap<String, String>>);

    impl CredentialVault for MemoryVault {
        fn put(&self, key: &str, secret: &str) -> Result<(), CoreError> {
            self.0
                .lock()
                .unwrap()
                .insert(key.to_owned(), secret.to_owned());
            Ok(())
        }

        fn get(&self, key: &str) -> Result<Zeroizing<String>, CoreError> {
            self.0
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .map(Zeroizing::new)
                .ok_or_else(|| CoreError::NotFound("missing credential".to_owned()))
        }

        fn delete(&self, key: &str) -> Result<(), CoreError> {
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
    }

    struct FailingVault;

    impl CredentialVault for FailingVault {
        fn put(&self, _key: &str, _secret: &str) -> Result<(), CoreError> {
            Err(CoreError::Runtime("secure store unavailable".to_owned()))
        }

        fn get(&self, _key: &str) -> Result<Zeroizing<String>, CoreError> {
            Err(CoreError::Runtime("secure store unavailable".to_owned()))
        }

        fn delete(&self, _key: &str) -> Result<(), CoreError> {
            Err(CoreError::Runtime("secure store unavailable".to_owned()))
        }
    }

    #[derive(Default)]
    struct MemoryVaultDocumentState {
        document: Option<String>,
        write_count: usize,
        fail_next_write: bool,
    }

    #[derive(Default)]
    struct MemoryVaultDocumentStore(Mutex<MemoryVaultDocumentState>);

    impl MemoryVaultDocumentStore {
        fn document(&self) -> Option<String> {
            self.0.lock().unwrap().document.clone()
        }

        fn write_count(&self) -> usize {
            self.0.lock().unwrap().write_count
        }

        fn replace_document(&self, document: &str) {
            self.0.lock().unwrap().document = Some(document.to_owned());
        }

        fn fail_next_write(&self) {
            self.0.lock().unwrap().fail_next_write = true;
        }
    }

    impl VaultDocumentStore for MemoryVaultDocumentStore {
        fn read(&self) -> Result<Option<Zeroizing<String>>, CoreError> {
            Ok(self.0.lock().unwrap().document.clone().map(Zeroizing::new))
        }

        fn write(&self, document: &str) -> Result<(), CoreError> {
            let mut state = self.0.lock().unwrap();
            if state.fail_next_write {
                state.fail_next_write = false;
                return Err(CoreError::Runtime("vault document write failed".to_owned()));
            }
            state.document = Some(document.to_owned());
            state.write_count += 1;
            Ok(())
        }
    }

    fn test_document_vault(
        app_data_dir: &Path,
        store: Arc<MemoryVaultDocumentStore>,
    ) -> Arc<OsCredentialVault> {
        Arc::new(OsCredentialVault::with_store(app_data_dir, store).unwrap())
    }

    #[test]
    fn single_vault_document_keeps_multiple_credentials_in_one_store_item() {
        let data = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryVaultDocumentStore::default());
        let vault = test_document_vault(data.path(), store.clone());

        vault.put("codex:account-a", "codex-secret").unwrap();
        vault.put("claude:account-b", "claude-secret").unwrap();

        assert_eq!(&*vault.get("codex:account-a").unwrap(), "codex-secret");
        assert_eq!(&*vault.get("claude:account-b").unwrap(), "claude-secret");
        let document: Value = serde_json::from_str(&store.document().unwrap()).unwrap();
        assert_eq!(document["schemaVersion"], CREDENTIAL_VAULT_VERSION);
        assert_eq!(document["entries"].as_object().unwrap().len(), 2);
        assert_eq!(store.write_count(), 2);

        vault.delete("codex:account-a").unwrap();
        assert!(vault.get("codex:account-a").is_err());
        assert_eq!(&*vault.get("claude:account-b").unwrap(), "claude-secret");
        let document: Value = serde_json::from_str(&store.document().unwrap()).unwrap();
        assert_eq!(document["entries"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn malformed_or_unsupported_vault_document_is_never_overwritten() {
        let data = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryVaultDocumentStore::default());
        let vault = test_document_vault(data.path(), store.clone());

        for invalid in ["{not-json", r#"{"schemaVersion":99,"entries":{}}"#] {
            store.replace_document(invalid);
            assert!(vault.put("codex:account-a", "secret").is_err());
            assert_eq!(store.document().as_deref(), Some(invalid));
        }
    }

    #[test]
    fn failed_single_vault_write_preserves_the_previous_document() {
        let data = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryVaultDocumentStore::default());
        let vault = test_document_vault(data.path(), store.clone());
        vault.put("codex:account-a", "secret-a").unwrap();
        let before = store.document().unwrap();

        store.fail_next_write();
        assert!(vault.put("codex:account-b", "secret-b").is_err());
        assert_eq!(store.document().as_deref(), Some(before.as_str()));
        assert_eq!(&*vault.get("codex:account-a").unwrap(), "secret-a");
        assert!(vault.get("codex:account-b").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn legacy_v2_document_replaces_a_corrupted_v3_and_is_verified() {
        let data = tempfile::tempdir().unwrap();
        let current_store = Arc::new(MemoryVaultDocumentStore::default());
        current_store.replace_document(r#"{"schemaVersion":3,"entries":{"cut":"#);
        let legacy_store = Arc::new(MemoryVaultDocumentStore::default());
        let mut legacy = CredentialVaultDocument::empty_for_version(LEGACY_SINGLE_VAULT_VERSION);
        legacy.entries.insert(
            "codex:account-a".to_owned(),
            r#"{"accessToken":"codex-secret"}"#.to_owned(),
        );
        legacy.entries.insert(
            "claude:account-b".to_owned(),
            r#"{"claudeAiOauth":{"accessToken":"claude-secret"}}"#.to_owned(),
        );
        legacy_store.replace_document(&serde_json::to_string(&legacy).unwrap());
        let vault = test_document_vault(data.path(), current_store.clone());

        let migrated = vault
            .replace_from_legacy_store(legacy_store.as_ref())
            .unwrap();

        assert_eq!(migrated.len(), 2);
        assert!(migrated.contains("codex:account-a"));
        assert!(migrated.contains("claude:account-b"));
        let current: CredentialVaultDocument =
            serde_json::from_str(&current_store.document().unwrap()).unwrap();
        assert_eq!(current.schema_version, CREDENTIAL_VAULT_VERSION);
        assert_eq!(current.entries, legacy.entries);
        let original: CredentialVaultDocument =
            serde_json::from_str(&legacy_store.document().unwrap()).unwrap();
        assert_eq!(original.schema_version, LEGACY_SINGLE_VAULT_VERSION);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn invalid_legacy_v2_document_preserves_the_current_v3() {
        let data = tempfile::tempdir().unwrap();
        let current_store = Arc::new(MemoryVaultDocumentStore::default());
        current_store.replace_document(r#"{"schemaVersion":3,"entries":{}}"#);
        let legacy_store = Arc::new(MemoryVaultDocumentStore::default());
        legacy_store
            .replace_document(r#"{"schemaVersion":2,"entries":{"codex:account-a":"{broken"}}"#);
        let vault = test_document_vault(data.path(), current_store.clone());
        let before = current_store.document().unwrap();

        assert!(vault
            .replace_from_legacy_store(legacy_store.as_ref())
            .is_err());
        assert_eq!(current_store.document().as_deref(), Some(before.as_str()));
    }

    #[test]
    fn concurrent_single_vault_updates_keep_every_credential() {
        let data = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryVaultDocumentStore::default());
        let vault = test_document_vault(data.path(), store.clone());
        let mut workers = Vec::new();
        for index in 0..8 {
            let vault = vault.clone();
            workers.push(std::thread::spawn(move || {
                vault
                    .put(
                        &format!("codex:account-{index}"),
                        &format!("secret-{index}"),
                    )
                    .unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }

        let document: Value = serde_json::from_str(&store.document().unwrap()).unwrap();
        assert_eq!(document["entries"].as_object().unwrap().len(), 8);
    }

    #[test]
    fn codex_identity_uses_account_id_without_exposing_tokens() {
        let identity =
            codex_identity(r#"{"tokens":{"account_id":"acct-1","access_token":"secret"}}"#)
                .unwrap();
        assert_eq!(identity.provider_account_id, "acct-1");
        assert!(identity.legacy_provider_account_id.is_none());
    }

    #[test]
    fn claude_profile_identity_keeps_only_non_secret_account_metadata() {
        let profile: ClaudeProfileResponse = serde_json::from_value(json!({
            "account": {
                "uuid": " account-a ",
                "email": " a@example.com ",
                "display_name": " Account A ",
                "unrelated": "ignored"
            },
            "organization": {
                "uuid": " organization-a ",
                "rate_limit_tier": "ignored"
            }
        }))
        .unwrap();

        let identity = claude_identity_from_profile(profile).unwrap();

        assert_eq!(identity.provider_account_id, "account-a");
        assert_eq!(identity.email.as_deref(), Some("a@example.com"));
        assert_eq!(identity.organization.as_deref(), Some("organization-a"));
        assert_eq!(identity.display_name.as_deref(), Some("Account A"));
    }

    #[test]
    fn codex_identity_distinguishes_users_in_the_same_chatgpt_account() {
        let first = codex_identity(&codex_user_secret(
            "shared-workspace",
            "user-owner",
            "owner@example.com",
        ))
        .unwrap();
        let second = codex_identity(&codex_user_secret(
            "shared-workspace",
            "user-reviewer",
            "reviewer@example.com",
        ))
        .unwrap();

        assert_ne!(first.provider_account_id, second.provider_account_id);
        assert_eq!(
            first.legacy_provider_account_id.as_deref(),
            Some("shared-workspace")
        );
        assert_eq!(
            second.legacy_provider_account_id.as_deref(),
            Some("shared-workspace")
        );
    }

    #[test]
    fn usage_window_parses_iso_reset_timestamps() {
        let iso = usage_window(
            "5시간",
            &json!({"utilization": 10.0, "resets_at": "2026-08-15T12:00:00+00:00"}),
        )
        .unwrap();
        assert_eq!(iso.resets_at, Some(1_786_795_200_000));
        let numeric = usage_window(
            "5시간",
            &json!({"utilization": 10.0, "resets_at": 1_787_315_278_i64}),
        )
        .unwrap();
        assert_eq!(numeric.resets_at, Some(1_787_315_278_000));
    }

    #[test]
    fn codex_window_label_follows_actual_window_length() {
        assert_eq!(
            window_duration_label(&json!({"limit_window_seconds": 604_800})).as_deref(),
            Some("7일")
        );
        assert_eq!(
            window_duration_label(&json!({"limit_window_seconds": 18_000})).as_deref(),
            Some("5시간")
        );
        assert_eq!(
            window_duration_label(&json!({"window_minutes": 10_080})).as_deref(),
            Some("7일")
        );
        assert_eq!(window_duration_label(&json!({"used_percent": 62})), None);
    }

    #[test]
    fn registry_has_no_credential_fields() {
        let registry = AccountRegistry::empty();
        let serialized = serde_json::to_string(&registry).unwrap();
        assert!(!serialized.contains("accessToken"));
        assert!(!serialized.contains("refreshToken"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn opening_creates_only_new_registry() {
        let temp = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let supervisor = AccountSupervisor::open_with(
            temp.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();
        assert!(temp.path().join(REGISTRY_FILE).is_file());
        assert!(supervisor.snapshot().unwrap().accounts.is_empty());
    }

    #[test]
    fn older_registries_require_reauthentication_without_reading_previous_vaults() {
        for previous_version in [legacy_credential_vault_version(), 2] {
            let data = tempfile::tempdir().unwrap();
            let home = tempfile::tempdir().unwrap();
            let mut registry = AccountRegistry::empty();
            registry.credential_vault_version = previous_version;
            registry.accounts.push(AccountRecord {
                id: "codex-legacy".to_owned(),
                provider: ProviderId::Codex,
                display_name: "기존 계정".to_owned(),
                email: Some("legacy@example.com".to_owned()),
                organization: None,
                provider_account_id: "legacy-provider-account".to_owned(),
                disabled: false,
                auto_switch: false,
                auth_status: AccountAuthStatus::Ready,
                usage: AccountUsageView {
                    status: AccountUsageStatus::Ok,
                    windows: vec![AccountUsageWindow {
                        label: "5시간".to_owned(),
                        used_percent: 43.0,
                        resets_at: None,
                    }],
                    updated_at: Some(now_ms()),
                    error: None,
                    retry_at: None,
                    rate_limited: false,
                },
                created_at: now_ms(),
                updated_at: now_ms(),
            });
            registry.providers[0].default_account_id = Some("codex-legacy".to_owned());
            let mut serialized = serde_json::to_value(&registry).unwrap();
            if previous_version == legacy_credential_vault_version() {
                serialized
                    .as_object_mut()
                    .unwrap()
                    .remove("credentialVaultVersion");
            }
            fs::write(
                data.path().join(REGISTRY_FILE),
                serde_json::to_vec_pretty(&serialized).unwrap(),
            )
            .unwrap();
            let scheduled = data.path().join("scheduled-requests-v2.json");
            fs::write(&scheduled, b"scheduled-reference").unwrap();

            let supervisor = AccountSupervisor::open_with(
                data.path(),
                home.path(),
                Arc::new(MemoryVault::default()),
            )
            .unwrap();
            let snapshot = supervisor.snapshot().unwrap();
            assert_eq!(snapshot.accounts.len(), 1);
            assert_eq!(snapshot.accounts[0].display_name, "기존 계정");
            assert_eq!(snapshot.accounts[0].auth_status, AccountAuthStatus::Missing);
            assert_eq!(snapshot.accounts[0].usage, AccountUsageView::default());
            assert_eq!(
                snapshot.providers[0].default_account_id.as_deref(),
                Some("codex-legacy")
            );
            assert_eq!(fs::read(&scheduled).unwrap(), b"scheduled-reference");
            let migrated: Value =
                serde_json::from_slice(&fs::read(data.path().join(REGISTRY_FILE)).unwrap())
                    .unwrap();
            assert_eq!(migrated["credentialVaultVersion"], CREDENTIAL_VAULT_VERSION);
        }
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn production_keyring_backend_persists_until_deleted() {
        assert!(matches!(
            keyring::default::default_credential_builder().persistence(),
            keyring::credential::CredentialPersistence::UntilDelete
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keychain_fields_allow_official_claude_service_names() {
        assert!(validate_keychain_field("Claude Code-credentials", "service").is_ok());
        assert!(validate_keychain_field("Claude Code-credentials-15fa340b", "service").is_ok());
        assert!(validate_keychain_field("Claude\nCode-credentials", "service").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_security_writer_supports_large_structured_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("security-stub");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"${0}.args\"\ncat > \"${0}.stdin\"\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        let secret = format!(r#"{{"token":"{}"}}"#, "x".repeat(16 * 1024));

        write_macos_keychain_password_with_executable(
            &executable,
            "com.shinc.agentmanager.test",
            "test-account",
            &secret,
        )
        .unwrap();

        let arguments = fs::read_to_string(format!("{}.args", executable.display())).unwrap();
        let lines = arguments.lines().collect::<Vec<_>>();
        assert_eq!(
            &lines[..7],
            [
                "add-generic-password",
                "-U",
                "-s",
                "com.shinc.agentmanager.test",
                "-a",
                "test-account",
                "-w"
            ]
        );
        assert_eq!(lines[7], secret);
        assert!(
            fs::read_to_string(format!("{}.stdin", executable.display()))
                .unwrap()
                .is_empty()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_security_failure_does_not_expose_secret_in_error() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("security-stub");
        fs::write(&executable, "#!/bin/sh\ncat >&2\nexit 9\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        let secret = r#"{"token":"must-not-leak"}"#;

        let error = write_macos_keychain_password_with_executable(
            &executable,
            "com.shinc.agentmanager.test",
            "test-account",
            secret,
        )
        .unwrap_err()
        .to_string();

        assert!(!error.contains(secret));
        assert!(error.contains("종료 코드 9"));
    }

    #[test]
    fn compact_json_secret_removes_physical_line_breaks() {
        let compact = compact_json_secret("{\n  \"token\": \"line\\nvalue\"\n}\n").unwrap();
        assert_eq!(&*compact, r#"{"token":"line\nvalue"}"#);
        assert!(!compact.as_bytes().contains(&b'\n'));
    }

    #[test]
    fn startup_recovers_a_missing_vault_entry_from_the_matching_active_credentials() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let codex_home = home.path().join(".codex");
        fs::create_dir(&codex_home).unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("account-a")).unwrap();
        let first_vault = Arc::new(MemoryVault::default());
        let first = AccountSupervisor::open_with(data.path(), home.path(), first_vault).unwrap();
        let registered = first
            .register_current(ProviderId::Codex, Some("A".to_owned()))
            .unwrap();
        let account_id = registered.accounts[0].id.clone();
        drop(first);

        let replacement_vault = Arc::new(MemoryVault::default());
        let reopened =
            AccountSupervisor::open_with(data.path(), home.path(), replacement_vault.clone())
                .unwrap();
        let recovered = reopened.snapshot().unwrap();
        assert_eq!(recovered.accounts[0].auth_status, AccountAuthStatus::Ready);
        assert!(recovered.providers[0].recovery_error.is_none());
        assert!(replacement_vault
            .get(&format!("codex:{account_id}"))
            .is_ok());
    }

    #[test]
    fn secure_store_failure_does_not_register_account_or_persist_secret() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        fs::create_dir(home.path().join(".codex")).unwrap();
        fs::write(
            home.path().join(".codex/auth.json"),
            r#"{"tokens":{"account_id":"account-a","access_token":"must-not-persist"}}"#,
        )
        .unwrap();
        let supervisor =
            AccountSupervisor::open_with(data.path(), home.path(), Arc::new(FailingVault)).unwrap();
        assert!(supervisor
            .register_current(ProviderId::Codex, None)
            .is_err());
        assert!(supervisor.snapshot().unwrap().accounts.is_empty());
        let registry = fs::read_to_string(data.path().join(REGISTRY_FILE)).unwrap();
        assert!(!registry.contains("must-not-persist"));
    }

    fn codex_secret(account_id: &str) -> String {
        codex_secret_with_token(account_id, &format!("secret-{account_id}"))
    }

    fn codex_secret_with_token(account_id: &str, access_token: &str) -> String {
        json!({
            "tokens": {
                "account_id": account_id,
                "access_token": access_token
            }
        })
        .to_string()
    }

    fn codex_user_secret(account_id: &str, subject: &str, email: &str) -> String {
        let claims = json!({
            "sub": subject,
            "email": email,
            "https://api.openai.com/auth.chatgpt_account_id": account_id,
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        json!({
            "tokens": {
                "account_id": account_id,
                "id_token": format!("header.{payload}.signature"),
                "access_token": format!("secret-{subject}"),
            }
        })
        .to_string()
    }

    fn claude_secret(account_id: &str) -> String {
        json!({
            "claudeAiOauth": {
                "accountUuid": account_id,
                "accessToken": format!("secret-{account_id}")
            }
        })
        .to_string()
    }

    fn claude_account_record(account_id: &str, email: &str) -> AccountRecord {
        AccountRecord {
            id: format!("claude-{account_id}"),
            provider: ProviderId::Claude,
            display_name: account_id.to_owned(),
            email: Some(email.to_owned()),
            organization: None,
            provider_account_id: account_id.to_owned(),
            disabled: false,
            auto_switch: false,
            auth_status: AccountAuthStatus::Ready,
            usage: AccountUsageView::default(),
            created_at: now_ms(),
            updated_at: now_ms(),
        }
    }

    #[test]
    fn claude_switch_verifies_credentials_when_shared_metadata_points_at_another_account() {
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        let switched_secret = r#"{"claudeAiOauth":{"accessToken":"token-b"}}"#;
        fs::write(claude_root.join(".credentials.json"), switched_secret).unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();

        verify_active_identity(
            home.path(),
            &claude_root,
            ProviderId::Claude,
            None,
            false,
            &claude_account_record("account-b", "b@example.com"),
            switched_secret,
        )
        .unwrap();
    }

    #[test]
    fn claude_switch_fails_when_active_credentials_are_not_the_switched_account() {
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        fs::write(
            claude_root.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"token-a"}}"#,
        )
        .unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();

        assert!(matches!(
            verify_active_identity(
                home.path(),
                &claude_root,
                ProviderId::Claude,
                None,
                false,
                &claude_account_record("account-b", "b@example.com"),
                r#"{"claudeAiOauth":{"accessToken":"token-b"}}"#,
            ),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn startup_keeps_a_switched_claude_account_while_shared_metadata_is_stale() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        let switched_secret = r#"{"claudeAiOauth":{"accessToken":"token-b"}}"#;
        fs::write(
            claude_root.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"token-a"}}"#,
        )
        .unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let first = AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        first
            .register_current(ProviderId::Claude, Some("A".to_owned()))
            .unwrap();
        drop(first);

        // account-b로 전환한 상태. 공유 `.claude.json`은 교체 대상이 아니라 여전히 account-a를 가리킨다.
        let account_b = claude_account_record("account-b", "b@example.com");
        fs::write(claude_root.join(".credentials.json"), switched_secret).unwrap();
        vault
            .put(&format!("claude:{}", account_b.id), switched_secret)
            .unwrap();
        let mut registry = load_registry(data.path()).unwrap();
        registry
            .provider_mut(ProviderId::Claude)
            .unwrap()
            .active_account_id = Some(account_b.id.clone());
        registry.accounts.push(account_b.clone());
        save_registry(data.path(), &registry).unwrap();

        let reopened = AccountSupervisor::open_with(data.path(), home.path(), vault).unwrap();
        let snapshot = reopened.snapshot().unwrap();
        assert!(snapshot
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Claude)
            .unwrap()
            .recovery_error
            .is_none());
        assert_eq!(
            snapshot
                .accounts
                .iter()
                .find(|account| account.id == account_b.id)
                .unwrap()
                .auth_status,
            AccountAuthStatus::Ready
        );
    }

    #[test]
    fn claude_active_identity_uses_provider_metadata_after_token_rotation() {
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        fs::write(
            claude_root.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"current-token"}}"#,
        )
        .unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        let account = AccountRecord {
            id: "claude-account-a".to_owned(),
            provider: ProviderId::Claude,
            display_name: "A".to_owned(),
            email: Some("a@example.com".to_owned()),
            organization: None,
            provider_account_id: "account-a".to_owned(),
            disabled: false,
            auto_switch: false,
            auth_status: AccountAuthStatus::Ready,
            usage: AccountUsageView::default(),
            created_at: now_ms(),
            updated_at: now_ms(),
        };

        verify_active_identity(
            home.path(),
            &claude_root,
            ProviderId::Claude,
            None,
            false,
            &account,
            r#"{"claudeAiOauth":{"accessToken":"previous-token"}}"#,
        )
        .unwrap();
    }

    #[test]
    fn startup_syncs_a_rotated_active_claude_token_into_the_vault() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        let current_secret = r#"{"claudeAiOauth":{"accessToken":"current-token"}}"#;
        fs::write(claude_root.join(".credentials.json"), current_secret).unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let first = AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        let registered = first
            .register_current(ProviderId::Claude, Some("A".to_owned()))
            .unwrap();
        let account_id = registered.accounts[0].id.clone();
        let key = format!("claude:{account_id}");
        vault
            .put(
                &key,
                r#"{"claudeAiOauth":{"accessToken":"previous-token"}}"#,
            )
            .unwrap();
        drop(first);

        let reopened = AccountSupervisor::open_with_claude_identity_resolver(
            data.path(),
            home.path(),
            vault.clone(),
            Arc::new(|_secret: &str| {
                Ok(AccountIdentity {
                    provider_account_id: "account-a".to_owned(),
                    legacy_provider_account_id: None,
                    email: Some("a@example.com".to_owned()),
                    organization: None,
                    display_name: Some("A".to_owned()),
                })
            }),
        )
        .unwrap();

        assert_eq!(&*vault.get(&key).unwrap(), current_secret);
        assert_eq!(
            reopened.snapshot().unwrap().accounts[0].auth_status,
            AccountAuthStatus::Ready
        );
    }

    #[test]
    fn startup_activates_the_registered_claude_account_matching_the_live_profile() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        let secret_a = r#"{"claudeAiOauth":{"accessToken":"token-a"}}"#;
        let secret_b = r#"{"claudeAiOauth":{"accessToken":"token-b"}}"#;
        let rotated_secret_b = r#"{"claudeAiOauth":{"accessToken":"token-b-rotated"}}"#;
        fs::write(claude_root.join(".credentials.json"), secret_a).unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let first = AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        let registered_a = first
            .register_current(ProviderId::Claude, Some("A".to_owned()))
            .unwrap();
        let account_a = registered_a
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-a")
            .unwrap()
            .id
            .clone();

        fs::write(claude_root.join(".credentials.json"), secret_b).unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-b","emailAddress":"b@example.com"}}"#,
        )
        .unwrap();
        let registered_b = first
            .register_current(ProviderId::Claude, Some("B".to_owned()))
            .unwrap();
        let account_b = registered_b
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-b")
            .unwrap()
            .id
            .clone();
        let mut registry = load_registry(data.path()).unwrap();
        registry
            .provider_mut(ProviderId::Claude)
            .unwrap()
            .active_account_id = Some(account_a.clone());
        save_registry(data.path(), &registry).unwrap();
        drop(first);

        // 공유 메타데이터는 A에 머물러 있지만 현재 자격증명은 B가 회전한 값이다.
        fs::write(claude_root.join(".credentials.json"), rotated_secret_b).unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        let resolver_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls = resolver_calls.clone();
        let reopened = AccountSupervisor::open_with_claude_identity_resolver(
            data.path(),
            home.path(),
            vault.clone(),
            Arc::new(move |_secret: &str| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(AccountIdentity {
                    provider_account_id: "account-b".to_owned(),
                    legacy_provider_account_id: None,
                    email: Some("b@example.com".to_owned()),
                    organization: Some("organization-b".to_owned()),
                    display_name: Some("B live".to_owned()),
                })
            }),
        )
        .unwrap();

        let snapshot = reopened.snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Claude)
            .unwrap();
        assert_eq!(resolver_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            provider.active_account_id.as_deref(),
            Some(account_b.as_str())
        );
        assert_eq!(
            provider.observed_active_account_id.as_deref(),
            Some(account_b.as_str())
        );
        assert!(
            snapshot
                .accounts
                .iter()
                .find(|account| account.id == account_b)
                .unwrap()
                .is_active
        );
        assert!(same_secret(
            &vault.get(&format!("claude:{account_b}")).unwrap(),
            rotated_secret_b
        ));
    }

    #[test]
    fn revalidating_an_inactive_claude_credential_restores_ready_without_activating_it() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        let secret_a = r#"{"claudeAiOauth":{"accessToken":"token-a"}}"#;
        fs::write(claude_root.join(".credentials.json"), secret_a).unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let supervisor = AccountSupervisor::open_with_claude_identity_resolver(
            data.path(),
            home.path(),
            vault,
            Arc::new(|_secret: &str| {
                Ok(AccountIdentity {
                    provider_account_id: "account-a".to_owned(),
                    legacy_provider_account_id: None,
                    email: Some("a@example.com".to_owned()),
                    organization: Some("organization-a".to_owned()),
                    display_name: Some("A live".to_owned()),
                })
            }),
        )
        .unwrap();
        let registered = supervisor
            .register_current(ProviderId::Claude, Some("A".to_owned()))
            .unwrap();
        let account_a = registered.accounts[0].id.clone();
        let account_b = claude_account_record("account-b", "b@example.com");
        {
            let mut state = lock(&supervisor.inner.state, "계정 상태").unwrap();
            let record = account_by_id_mut(&mut state.registry, &account_a).unwrap();
            record.auth_status = AccountAuthStatus::Error;
            state.registry.accounts.push(account_b.clone());
            state
                .registry
                .provider_mut(ProviderId::Claude)
                .unwrap()
                .active_account_id = Some(account_b.id.clone());
            save_registry(data.path(), &state.registry).unwrap();
        }

        let snapshot = supervisor.revalidate_saved_credential(&account_a).unwrap();
        let recovered = snapshot
            .accounts
            .iter()
            .find(|account| account.id == account_a)
            .unwrap();

        assert_eq!(recovered.auth_status, AccountAuthStatus::Ready);
        assert!(!recovered.is_active);
        assert_eq!(recovered.organization.as_deref(), Some("organization-a"));
        assert_eq!(
            snapshot
                .providers
                .iter()
                .find(|provider| provider.provider == ProviderId::Claude)
                .unwrap()
                .active_account_id
                .as_deref(),
            Some(account_b.id.as_str())
        );
    }

    #[test]
    fn startup_preserves_a_pending_claude_reauthentication_over_the_old_active_capture() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        let stored_secret = r#"{"claudeAiOauth":{"accessToken":"last-known-good-token"}}"#;
        fs::write(claude_root.join(".credentials.json"), stored_secret).unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let first = AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        let registered = first
            .register_current(ProviderId::Claude, Some("A".to_owned()))
            .unwrap();
        let account_id = registered.accounts[0].id.clone();
        let key = format!("claude:{account_id}");
        let mut registry = load_registry(data.path()).unwrap();
        registry
            .provider_mut(ProviderId::Claude)
            .unwrap()
            .pending_default_account_id = Some(account_id.clone());
        save_registry(data.path(), &registry).unwrap();
        drop(first);
        fs::write(
            claude_root.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"","expiresAt":1234}}"#,
        )
        .unwrap();

        let reopened =
            AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();

        assert_eq!(&*vault.get(&key).unwrap(), stored_secret);
        let reopened_registry = load_registry(data.path()).unwrap();
        assert_eq!(
            reopened_registry.accounts[0].auth_status,
            AccountAuthStatus::Ready
        );
        assert_eq!(
            reopened_registry
                .provider(ProviderId::Claude)
                .unwrap()
                .pending_default_account_id
                .as_deref(),
            Some(account_id.as_str())
        );
        assert!(!lock(&reopened.inner.state, "계정 상태")
            .unwrap()
            .recovery_error
            .contains_key(&ProviderId::Claude));
    }

    #[test]
    fn pending_reauthentication_of_the_active_claude_account_applies_while_sessions_run() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        fs::write(
            claude_root.join(".credentials.json"),
            r#"{"claudeAiOauth":{"accessToken":"old-token"}}"#,
        )
        .unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let supervisor =
            AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        let registered = supervisor
            .register_current(ProviderId::Claude, Some("A".to_owned()))
            .unwrap();
        let account_id = registered.accounts[0].id.clone();
        let lease = supervisor
            .acquire_runtime(ProviderId::Claude, Some(&account_id), None)
            .unwrap();

        // 실행 중 재인증이 미뤄진 상태를 재현한다: 갱신된 자격증명은 Vault에만 있다.
        let renewed_secret = r#"{"claudeAiOauth":{"accessToken":"renewed-token"}}"#;
        vault
            .put(&format!("claude:{account_id}"), renewed_secret)
            .unwrap();
        lock(&supervisor.inner.state, "계정 상태")
            .unwrap()
            .registry
            .provider_mut(ProviderId::Claude)
            .unwrap()
            .pending_default_account_id = Some(account_id.clone());

        let snapshot = supervisor.set_default(&account_id).unwrap();

        assert!(snapshot
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Claude)
            .unwrap()
            .pending_default_account_id
            .is_none());
        let active: Value =
            serde_json::from_slice(&fs::read(claude_root.join(".credentials.json")).unwrap())
                .unwrap();
        assert_eq!(
            active
                .pointer("/claudeAiOauth/accessToken")
                .and_then(Value::as_str),
            Some("renewed-token")
        );
        drop(lease);
    }

    #[test]
    fn claude_access_token_expiry_is_checked_with_margin() {
        let secret =
            r#"{"claudeAiOauth":{"accessToken":"live","refreshToken":"r","expiresAt":1000000}}"#;
        assert!(claude_access_token_expired(secret, 1_000_000));
        assert!(claude_access_token_expired(
            secret,
            1_000_000 - CLAUDE_TOKEN_EXPIRY_MARGIN_MS
        ));
        assert!(!claude_access_token_expired(
            secret,
            1_000_000 - CLAUDE_TOKEN_EXPIRY_MARGIN_MS - 1
        ));
        // 만료 시각이 없으면 호출 결과(401)로 가르도록 만료로 취급하지 않는다.
        assert!(!claude_access_token_expired(
            r#"{"claudeAiOauth":{"accessToken":"live"}}"#,
            i64::MAX
        ));
    }

    #[test]
    fn merge_refreshed_claude_oauth_updates_tokens_and_keeps_other_fields() {
        let secret = r#"{"claudeAiOauth":{"accessToken":"old-access","refreshToken":"old-refresh","expiresAt":1,"subscriptionType":"max","scopes":["user:inference"]},"mcpOAuth":{"x":1}}"#;
        let granted = json!({
            "token_type": "Bearer",
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 3600,
        });
        let merged = merge_refreshed_claude_oauth(secret, &granted, 10_000).unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();
        let oauth = value.get("claudeAiOauth").unwrap();
        assert_eq!(oauth["accessToken"], "new-access");
        assert_eq!(oauth["refreshToken"], "new-refresh");
        assert_eq!(oauth["expiresAt"], 3_610_000);
        assert_eq!(oauth["subscriptionType"], "max");
        assert_eq!(oauth["scopes"], json!(["user:inference"]));
        assert_eq!(value["mcpOAuth"]["x"], 1);
    }

    #[test]
    fn merge_refreshed_claude_oauth_keeps_previous_refresh_token_when_missing() {
        let secret = r#"{"claudeAiOauth":{"accessToken":"old-access","refreshToken":"old-refresh","expiresAt":1}}"#;
        let granted = json!({"access_token": "new-access"});
        let merged = merge_refreshed_claude_oauth(secret, &granted, 10_000).unwrap();
        let value: Value = serde_json::from_str(&merged).unwrap();
        let oauth = value.get("claudeAiOauth").unwrap();
        assert_eq!(oauth["accessToken"], "new-access");
        assert_eq!(oauth["refreshToken"], "old-refresh");
        assert_eq!(oauth["expiresAt"], 1);
    }

    #[test]
    fn merge_refreshed_claude_oauth_requires_access_token() {
        let secret = r#"{"claudeAiOauth":{"accessToken":"old-access"}}"#;
        assert!(merge_refreshed_claude_oauth(secret, &json!({}), 10_000).is_err());
        assert!(
            merge_refreshed_claude_oauth(secret, &json!({"access_token": ""}), 10_000).is_err()
        );
    }

    #[test]
    fn retry_after_seconds_are_bounded_and_converted_to_an_absolute_time() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("120"));
        assert_eq!(retry_at_from_headers(&headers, 1_000), 121_000);

        headers.insert(RETRY_AFTER, HeaderValue::from_static("0"));
        assert_eq!(
            retry_at_from_headers(&headers, 1_000),
            1_000 + CLAUDE_RATE_LIMIT_MIN_RETRY_MS
        );

        headers.remove(RETRY_AFTER);
        assert_eq!(
            retry_at_from_headers(&headers, 1_000),
            1_000 + CLAUDE_RATE_LIMIT_DEFAULT_RETRY_MS
        );
    }

    #[test]
    fn rate_limit_keeps_recent_usage_without_changing_last_success_time() {
        let now = 2_000_000_000;
        let updated_at = now - 23 * 60 * 60_000;
        let previous = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "5시간".to_owned(),
                used_percent: 42.0,
                resets_at: None,
            }],
            updated_at: Some(updated_at),
            error: None,
            retry_at: None,
            rate_limited: false,
        };
        let retry_at = now + CLAUDE_RATE_LIMIT_DEFAULT_RETRY_MS;

        let result = apply_usage_stale_policy(
            rate_limited_usage_result("HTTP 429", retry_at),
            &previous,
            now,
        );

        assert_eq!(result.status, AccountUsageStatus::Error);
        assert_eq!(result.windows, previous.windows);
        assert_eq!(result.updated_at, Some(updated_at));
        assert_eq!(result.retry_at, Some(retry_at));
        assert!(result.rate_limited);
    }

    #[test]
    fn successful_usage_reconciles_stale_auth_status_without_trusting_failures() {
        assert_eq!(
            reconciled_auth_status_after_usage(
                AccountAuthStatus::Error,
                false,
                AccountUsageStatus::Ok,
            ),
            AccountAuthStatus::Ready
        );
        assert_eq!(
            reconciled_auth_status_after_usage(
                AccountAuthStatus::Missing,
                false,
                AccountUsageStatus::Unavailable,
            ),
            AccountAuthStatus::Ready
        );
        assert_eq!(
            reconciled_auth_status_after_usage(
                AccountAuthStatus::Error,
                false,
                AccountUsageStatus::Error,
            ),
            AccountAuthStatus::Error
        );
        assert_eq!(
            reconciled_auth_status_after_usage(
                AccountAuthStatus::Error,
                true,
                AccountUsageStatus::Error,
            ),
            AccountAuthStatus::Ready
        );
    }

    #[test]
    fn stale_usage_ages_out_so_old_values_are_not_presented_as_current() {
        let now = 2_000_000_000;
        let previous = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "7일".to_owned(),
                used_percent: 73.0,
                resets_at: None,
            }],
            updated_at: Some(now - RATE_LIMITED_STALE_THRESHOLD_MS - 1),
            error: None,
            retry_at: None,
            rate_limited: false,
        };

        let result = apply_usage_stale_policy(
            rate_limited_usage_result("HTTP 429", now + 60_000),
            &previous,
            now,
        );

        assert!(result.windows.is_empty());
        assert_ne!(result.updated_at, previous.updated_at);
    }

    #[test]
    fn legacy_usage_json_defaults_retry_metadata() {
        let usage: AccountUsageView = serde_json::from_value(json!({
            "status": "ok",
            "windows": [],
            "updatedAt": 123,
            "error": null
        }))
        .unwrap();
        assert_eq!(usage.retry_at, None);
        assert!(!usage.rate_limited);
    }

    fn captured_codex(account_id: &str) -> CapturedCredentials {
        CapturedCredentials {
            secret: Zeroizing::new(codex_secret(account_id)),
            identity: AccountIdentity {
                provider_account_id: account_id.to_owned(),
                legacy_provider_account_id: None,
                email: None,
                organization: None,
                display_name: None,
            },
        }
    }

    fn captured_claude(account_id: &str) -> CapturedCredentials {
        let secret = claude_secret(account_id);
        let identity = claude_identity_from_secret(&secret).unwrap();
        CapturedCredentials {
            secret: Zeroizing::new(secret),
            identity,
        }
    }

    fn captured_codex_user(account_id: &str, subject: &str, email: &str) -> CapturedCredentials {
        let secret = codex_user_secret(account_id, subject, email);
        let identity = codex_identity(&secret).unwrap();
        CapturedCredentials {
            secret: Zeroizing::new(secret),
            identity,
        }
    }

    fn two_account_supervisor() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        AccountSupervisor,
        String,
        String,
    ) {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let codex_home = home.path().join(".codex");
        fs::create_dir(&codex_home).unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("account-a")).unwrap();
        let supervisor = AccountSupervisor::open_with(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();
        supervisor
            .register_current(ProviderId::Codex, Some("A".to_owned()))
            .unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("account-b")).unwrap();
        supervisor
            .register_current(ProviderId::Codex, Some("B".to_owned()))
            .unwrap();
        let snapshot = supervisor.snapshot().unwrap();
        let a = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-a")
            .unwrap()
            .id
            .clone();
        let b = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-b")
            .unwrap()
            .id
            .clone();
        supervisor.set_default(&a).unwrap();
        (data, home, supervisor, a, b)
    }

    fn two_claude_account_supervisor() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<MemoryVault>,
        AccountSupervisor,
        String,
        String,
    ) {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_home = home.path().join(".claude");
        fs::create_dir(&claude_home).unwrap();
        fs::write(
            claude_home.join(".credentials.json"),
            claude_secret("account-a"),
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let supervisor =
            AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        supervisor
            .upsert_captured_account(
                ProviderId::Claude,
                None,
                Some("A".to_owned()),
                captured_claude("account-a"),
                true,
            )
            .unwrap();
        supervisor
            .upsert_captured_account(
                ProviderId::Claude,
                None,
                Some("B".to_owned()),
                captured_claude("account-b"),
                false,
            )
            .unwrap();
        let snapshot = supervisor.snapshot().unwrap();
        let a = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-a")
            .unwrap()
            .id
            .clone();
        let b = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-b")
            .unwrap()
            .id
            .clone();
        (data, home, vault, supervisor, a, b)
    }

    #[test]
    fn active_claude_refresh_is_allowed_while_same_account_runtime_is_alive() {
        let (_data, _home, _vault, supervisor, a, b) = two_claude_account_supervisor();
        let lease = supervisor
            .acquire_runtime(ProviderId::Claude, Some(&a), None)
            .unwrap();

        assert_eq!(supervisor.account_runtime_count(&a).unwrap(), 1);
        assert_eq!(supervisor.account_runtime_count(&b).unwrap(), 0);
        assert!(!supervisor.claude_refresh_deferred(&a, true).unwrap());
        assert!(supervisor.claude_refresh_deferred(&a, false).unwrap());
        assert!(!supervisor.claude_refresh_deferred(&b, false).unwrap());

        drop(lease);
        assert_eq!(supervisor.account_runtime_count(&a).unwrap(), 0);
        assert!(!supervisor.claude_refresh_deferred(&a, false).unwrap());
    }

    #[test]
    fn inactive_account_usage_refresh_is_rejected_without_changing_cached_usage() {
        let (_data, _home, _vault, supervisor, _active, inactive) = two_claude_account_supervisor();
        let before = supervisor
            .snapshot()
            .unwrap()
            .accounts
            .into_iter()
            .find(|account| account.id == inactive)
            .unwrap()
            .usage;

        let error = supervisor.refresh_usage(&inactive).unwrap_err();

        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(error.to_string().contains("활성 계정만"));
        let after = supervisor
            .snapshot()
            .unwrap()
            .accounts
            .into_iter()
            .find(|account| account.id == inactive)
            .unwrap()
            .usage;
        assert_eq!(after, before);
    }

    #[test]
    fn startup_selects_the_existing_account_observed_in_the_shared_codex_home() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let codex_home = home.path().join(".codex");
        fs::create_dir(&codex_home).unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("account-a")).unwrap();
        let vault = Arc::new(MemoryVault::default());
        let first = AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        let registered_a = first
            .register_current(ProviderId::Codex, Some("A".to_owned()))
            .unwrap();
        let account_a = registered_a.accounts[0].id.clone();
        fs::write(codex_home.join("auth.json"), codex_secret("account-b")).unwrap();
        let registered_b = first
            .register_current(ProviderId::Codex, Some("B".to_owned()))
            .unwrap();
        let account_b = registered_b
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-b")
            .unwrap()
            .id
            .clone();
        let mut registry = load_registry(data.path()).unwrap();
        registry
            .provider_mut(ProviderId::Codex)
            .unwrap()
            .active_account_id = Some(account_a.clone());
        save_registry(data.path(), &registry).unwrap();
        drop(first);

        let reopened = AccountSupervisor::open_with(data.path(), home.path(), vault).unwrap();
        let snapshot = reopened.snapshot().unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .unwrap();

        assert_eq!(
            provider.active_account_id.as_deref(),
            Some(account_b.as_str())
        );
        assert_eq!(
            provider.observed_active_account_id.as_deref(),
            Some(account_b.as_str())
        );
        assert!(provider.recovery_error.is_none());
        assert!(
            snapshot
                .accounts
                .iter()
                .find(|account| account.id == account_b)
                .unwrap()
                .is_active
        );
        assert_eq!(
            snapshot
                .accounts
                .iter()
                .find(|account| account.id == account_a)
                .unwrap()
                .auth_status,
            AccountAuthStatus::Ready
        );
    }

    #[test]
    fn startup_registers_a_new_account_observed_in_the_shared_codex_home() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let codex_home = home.path().join(".codex");
        fs::create_dir(&codex_home).unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("account-a")).unwrap();
        let vault = Arc::new(MemoryVault::default());
        let first = AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        let registered = first
            .register_current(ProviderId::Codex, Some("A".to_owned()))
            .unwrap();
        let account_a = registered.accounts[0].id.clone();
        let new_secret = codex_secret("account-new");
        fs::write(codex_home.join("auth.json"), &new_secret).unwrap();
        drop(first);

        let reopened =
            AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        let snapshot = reopened.snapshot().unwrap();
        let new_account = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-new")
            .unwrap();
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .unwrap();

        assert_ne!(new_account.id, account_a);
        assert!(new_account.is_active);
        assert_eq!(new_account.auth_status, AccountAuthStatus::Ready);
        assert_eq!(
            provider.active_account_id.as_deref(),
            Some(new_account.id.as_str())
        );
        assert_eq!(
            provider.observed_active_account_id.as_deref(),
            Some(new_account.id.as_str())
        );
        assert!(provider.recovery_error.is_none());
        assert!(same_secret(
            &vault.get(&format!("codex:{}", new_account.id)).unwrap(),
            &new_secret
        ));
        let persisted = fs::read_to_string(data.path().join(REGISTRY_FILE)).unwrap();
        assert!(!persisted.contains(&new_secret));
    }

    #[test]
    fn reconciled_snapshot_adopts_a_new_shared_codex_account_for_display() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let codex_home = home.path().join(".codex");
        fs::create_dir(&codex_home).unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("account-a")).unwrap();
        let supervisor = AccountSupervisor::open_with(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();
        supervisor
            .register_current(ProviderId::Codex, Some("A".to_owned()))
            .unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("account-live")).unwrap();

        let refreshed = supervisor.reconciled_snapshot().unwrap();
        let live = refreshed
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-live")
            .unwrap();
        let provider = refreshed
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .unwrap();

        assert!(live.is_active);
        assert_eq!(live.usage.status, AccountUsageStatus::Idle);
        assert_eq!(
            provider.active_account_id.as_deref(),
            Some(live.id.as_str())
        );
        assert_eq!(
            provider.observed_active_account_id.as_deref(),
            Some(live.id.as_str())
        );
    }

    #[test]
    fn external_claude_only_defers_an_inactive_account_refresh() {
        assert!(!should_defer_claude_refresh(true, false, true));
        assert!(!should_defer_claude_refresh(true, true, true));
        assert!(should_defer_claude_refresh(false, false, true));
        assert!(should_defer_claude_refresh(false, true, false));
        assert!(!should_defer_claude_refresh(false, false, false));
    }

    #[test]
    fn active_claude_refresh_adopts_an_external_rotation_before_writing() {
        let (_data, home, vault, supervisor, a, _b) = two_claude_account_supervisor();
        let account = {
            let state = lock(&supervisor.inner.state, "계정 상태").unwrap();
            account_by_id(&state.registry, &a).unwrap().clone()
        };
        let expected = vault.get(&format!("claude:{a}")).unwrap();
        let external = json!({
            "claudeAiOauth": {
                "accountUuid": "account-a",
                "accessToken": "external-access-a",
                "refreshToken": "external-refresh-a"
            }
        })
        .to_string();
        let ours = Zeroizing::new(
            json!({
                "claudeAiOauth": {
                    "accountUuid": "account-a",
                    "accessToken": "our-access-a",
                    "refreshToken": "our-refresh-a"
                }
            })
            .to_string(),
        );
        fs::write(home.path().join(".claude/.credentials.json"), &external).unwrap();

        let committed = supervisor
            .commit_refreshed_claude_credential(&account, &expected, ours, true)
            .unwrap();

        assert!(same_secret(&committed, &external));
        assert!(same_secret(
            &vault.get(&format!("claude:{a}")).unwrap(),
            &external
        ));
        assert!(same_secret(
            &fs::read_to_string(home.path().join(".claude/.credentials.json")).unwrap(),
            &external
        ));
    }

    #[test]
    fn active_claude_refresh_updates_shared_and_vault_credentials_together() {
        let (_data, home, vault, supervisor, a, _b) = two_claude_account_supervisor();
        let account = {
            let state = lock(&supervisor.inner.state, "계정 상태").unwrap();
            account_by_id(&state.registry, &a).unwrap().clone()
        };
        let expected = vault.get(&format!("claude:{a}")).unwrap();
        let refreshed = Zeroizing::new(
            json!({
                "claudeAiOauth": {
                    "accountUuid": "account-a",
                    "accessToken": "refreshed-access-a",
                    "refreshToken": "refreshed-refresh-a"
                }
            })
            .to_string(),
        );

        let committed = supervisor
            .commit_refreshed_claude_credential(&account, &expected, refreshed, true)
            .unwrap();

        let shared = fs::read_to_string(home.path().join(".claude/.credentials.json")).unwrap();
        assert!(same_secret(&committed, &shared));
        assert!(same_secret(
            &vault.get(&format!("claude:{a}")).unwrap(),
            &shared
        ));
    }

    #[test]
    fn startup_recovers_an_interrupted_active_claude_refresh() {
        let (data, home, vault, supervisor, a, _b) = two_claude_account_supervisor();
        let rotated = json!({
            "claudeAiOauth": {
                "accountUuid": "account-a",
                "accessToken": "rotated-access-a",
                "refreshToken": "rotated-refresh-a"
            }
        })
        .to_string();
        fs::write(home.path().join(".claude/.credentials.json"), &rotated).unwrap();
        save_refresh_journal(
            data.path(),
            &CredentialRefreshJournal {
                provider: ProviderId::Claude,
                account_id: a.clone(),
                operation_id: "refresh-test".to_owned(),
                started_at: 123,
            },
        )
        .unwrap();
        drop(supervisor);

        AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();

        assert!(same_secret(
            &vault.get(&format!("claude:{a}")).unwrap(),
            &rotated
        ));
        assert!(!refresh_journal_path(data.path(), ProviderId::Claude).exists());
    }

    #[test]
    fn claude_switch_reads_back_verified_rotated_credentials_before_replacement() {
        let (_data, home, vault, supervisor, a, b) = two_claude_account_supervisor();
        let rotated = json!({
            "claudeAiOauth": {
                "accountUuid": "account-a",
                "accessToken": "rotated-access-a",
                "refreshToken": "rotated-refresh-a"
            }
        })
        .to_string();
        fs::write(home.path().join(".claude/.credentials.json"), &rotated).unwrap();

        supervisor.set_active(&b).unwrap();

        assert_eq!(&*vault.get(&format!("claude:{a}")).unwrap(), &rotated);
        let active = fs::read_to_string(home.path().join(".claude/.credentials.json")).unwrap();
        assert!(same_secret(&active, &claude_secret("account-b")));
    }

    #[test]
    fn temporary_switch_restores_the_previous_active_account() {
        let (_data, home, supervisor, a, b) = two_account_supervisor();
        let history_path = home.path().join(".codex/sessions/session-1.jsonl");
        fs::create_dir_all(history_path.parent().unwrap()).unwrap();
        fs::write(&history_path, b"shared provider session\n").unwrap();
        let transition = supervisor
            .begin_temporary_switch(ProviderId::Codex, &b)
            .unwrap()
            .unwrap();
        assert_eq!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(b.clone())
        );
        assert!(supervisor
            .acquire_runtime(ProviderId::Codex, Some(&b), None)
            .is_err());
        {
            let _lease = supervisor
                .acquire_runtime(ProviderId::Codex, Some(&b), Some(transition.id()))
                .unwrap();
        }
        transition.restore().unwrap();
        assert!(supervisor
            .acquire_runtime(ProviderId::Codex, Some(&a), Some("stale-transition-token"))
            .is_err());
        assert_eq!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(a)
        );
        let active: Value =
            serde_json::from_slice(&fs::read(home.path().join(".codex/auth.json")).unwrap())
                .unwrap();
        assert_eq!(
            active.pointer("/tokens/account_id").and_then(Value::as_str),
            Some("account-a")
        );
        assert_eq!(
            fs::read(history_path).unwrap(),
            b"shared provider session\n"
        );
    }

    #[test]
    fn explicit_transition_recovery_returns_partial_failure_and_recovery_error() {
        let (_data, _home, supervisor, a, b) = two_account_supervisor();
        let transition = supervisor
            .begin_temporary_switch(ProviderId::Codex, &b)
            .unwrap()
            .unwrap();
        let transition_id = transition.id().to_owned();
        let previous = {
            let state = lock(&supervisor.inner.state, "계정 상태").unwrap();
            account_by_id(&state.registry, &a).unwrap().clone()
        };
        supervisor
            .inner
            .vault
            .delete(&vault_key(&previous))
            .unwrap();

        let receipt = supervisor
            .recover_provider_transition(ProviderId::Codex, &transition_id, &a, &b)
            .unwrap();

        assert!(!receipt.restored);
        assert!(!receipt.lease_cleared);
        assert!(receipt.recovery_error.is_some());
        assert!(supervisor
            .snapshot()
            .unwrap()
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .unwrap()
            .recovery_error
            .is_some());
        std::mem::forget(transition);
    }

    #[test]
    fn manual_active_switch_preserves_the_default_account() {
        let (_data, home, supervisor, a, b) = two_account_supervisor();

        let switched = supervisor.set_active(&b).unwrap();
        let provider = switched
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .unwrap();
        assert_eq!(provider.active_account_id.as_deref(), Some(b.as_str()));
        assert_eq!(provider.default_account_id.as_deref(), Some(a.as_str()));

        let active: Value =
            serde_json::from_slice(&fs::read(home.path().join(".codex/auth.json")).unwrap())
                .unwrap();
        assert_eq!(
            active.pointer("/tokens/account_id").and_then(Value::as_str),
            Some("account-b")
        );
    }

    #[test]
    fn manual_active_switch_is_rejected_while_a_runtime_is_running() {
        let (_data, home, supervisor, a, b) = two_account_supervisor();
        let lease = supervisor
            .acquire_runtime(ProviderId::Codex, Some(&a), None)
            .unwrap();

        let rejected = supervisor.set_active(&b).unwrap_err();
        assert!(matches!(rejected, CoreError::Conflict(_)));
        assert_eq!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(a.clone())
        );
        let active: Value =
            serde_json::from_slice(&fs::read(home.path().join(".codex/auth.json")).unwrap())
                .unwrap();
        assert_eq!(
            active.pointer("/tokens/account_id").and_then(Value::as_str),
            Some("account-a")
        );

        drop(lease);
        let switched = supervisor.set_active(&b).unwrap();
        let provider = switched
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .unwrap();
        assert_eq!(provider.active_account_id.as_deref(), Some(b.as_str()));
        assert_eq!(provider.runtime_count, 0);
        assert_eq!(provider.pending_default_account_id, None);
        let active: Value =
            serde_json::from_slice(&fs::read(home.path().join(".codex/auth.json")).unwrap())
                .unwrap();
        assert_eq!(
            active.pointer("/tokens/account_id").and_then(Value::as_str),
            Some("account-b")
        );
    }

    #[test]
    fn failed_manual_active_switch_restores_the_previous_credential() {
        let (data, home, supervisor, a, b) = two_account_supervisor();
        let target = {
            let state = lock(&supervisor.inner.state, "계정 상태").unwrap();
            account_by_id(&state.registry, &b).unwrap().clone()
        };
        supervisor
            .inner
            .vault
            .put(&vault_key(&target), &codex_secret("unexpected-account"))
            .unwrap();

        assert!(supervisor.set_active(&b).is_err());

        assert_eq!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(a)
        );
        let active: Value =
            serde_json::from_slice(&fs::read(home.path().join(".codex/auth.json")).unwrap())
                .unwrap();
        assert_eq!(
            active.pointer("/tokens/account_id").and_then(Value::as_str),
            Some("account-a")
        );
        assert!(!journal_path(data.path(), ProviderId::Codex).exists());
    }

    #[test]
    fn isolated_login_adds_an_account_and_removes_the_temporary_profile() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let supervisor = AccountSupervisor::open_with(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();
        let login = supervisor.begin_login(ProviderId::Codex, None).unwrap();
        let profile = PathBuf::from(&login.profile_path);
        fs::write(profile.join("auth.json"), codex_secret("account-added")).unwrap();
        let snapshot = supervisor
            .finish_login(&login.id, Some("추가 계정".to_owned()))
            .unwrap();
        assert!(!profile.exists());
        assert_eq!(snapshot.accounts.len(), 1);
        assert!(snapshot.accounts[0].is_active);
        assert!(snapshot.accounts[0].is_default);
        assert_eq!(snapshot.accounts[0].display_name, "추가 계정");
    }

    #[test]
    fn isolated_login_keeps_two_users_from_the_same_chatgpt_account() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let supervisor = AccountSupervisor::open_with(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();

        for (subject, email) in [
            ("user-owner", "owner@example.com"),
            ("user-reviewer", "reviewer@example.com"),
        ] {
            let login = supervisor.begin_login(ProviderId::Codex, None).unwrap();
            fs::write(
                PathBuf::from(&login.profile_path).join("auth.json"),
                codex_user_secret("shared-workspace", subject, email),
            )
            .unwrap();
            supervisor.finish_login(&login.id, None).unwrap();
        }

        let snapshot = supervisor.snapshot().unwrap();
        assert_eq!(snapshot.accounts.len(), 2);
        assert!(snapshot
            .accounts
            .iter()
            .any(|account| account.email.as_deref() == Some("owner@example.com")));
        assert!(snapshot
            .accounts
            .iter()
            .any(|account| account.email.as_deref() == Some("reviewer@example.com")));
        assert_ne!(
            snapshot.accounts[0].provider_account_id,
            snapshot.accounts[1].provider_account_id
        );
    }

    #[test]
    fn legacy_codex_identity_migrates_only_for_the_same_email_and_clears_usage() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let supervisor = AccountSupervisor::open_with(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();
        let legacy = CapturedCredentials {
            secret: Zeroizing::new(codex_secret("shared-workspace")),
            identity: AccountIdentity {
                provider_account_id: "shared-workspace".to_owned(),
                legacy_provider_account_id: None,
                email: Some("reviewer@example.com".to_owned()),
                organization: None,
                display_name: Some("reviewer@example.com".to_owned()),
            },
        };
        supervisor
            .upsert_captured_account(ProviderId::Codex, None, None, legacy, true)
            .unwrap();
        {
            let mut state = supervisor.inner.state.lock().unwrap();
            state.registry.accounts[0].usage = AccountUsageView {
                status: AccountUsageStatus::Ok,
                windows: vec![AccountUsageWindow {
                    label: "5시간".to_owned(),
                    used_percent: 43.0,
                    resets_at: None,
                }],
                updated_at: Some(now_ms()),
                error: None,
                retry_at: None,
                rate_limited: false,
            };
        }

        supervisor
            .upsert_captured_account(
                ProviderId::Codex,
                None,
                None,
                captured_codex_user("shared-workspace", "user-reviewer", "reviewer@example.com"),
                false,
            )
            .unwrap();

        let snapshot = supervisor.snapshot().unwrap();
        assert_eq!(snapshot.accounts.len(), 1);
        assert_ne!(snapshot.accounts[0].provider_account_id, "shared-workspace");
        assert_eq!(snapshot.accounts[0].usage, AccountUsageView::default());
    }

    #[test]
    fn active_account_reauthentication_is_saved_and_applied_after_runtime_stops() {
        let (_data, home, supervisor, a, _b) = two_account_supervisor();
        let lease = supervisor
            .acquire_runtime(ProviderId::Codex, Some(&a), None)
            .unwrap();
        let login = supervisor.begin_login(ProviderId::Codex, Some(&a)).unwrap();
        let profile = PathBuf::from(&login.profile_path);
        fs::write(
            profile.join("auth.json"),
            codex_secret_with_token("account-a", "renewed-access-token"),
        )
        .unwrap();

        let pending = supervisor
            .finish_login(&login.id, Some("A 재인증".to_owned()))
            .unwrap();
        assert!(!profile.exists());
        assert_eq!(
            pending
                .providers
                .iter()
                .find(|provider| provider.provider == ProviderId::Codex)
                .unwrap()
                .pending_default_account_id
                .as_deref(),
            Some(a.as_str())
        );
        let active_before_stop: Value =
            serde_json::from_slice(&fs::read(home.path().join(".codex/auth.json")).unwrap())
                .unwrap();
        assert_eq!(
            active_before_stop
                .pointer("/tokens/access_token")
                .and_then(Value::as_str),
            Some("secret-account-a")
        );

        drop(lease);

        let applied = supervisor.snapshot().unwrap();
        assert!(applied
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .unwrap()
            .pending_default_account_id
            .is_none());
        let active_after_stop: Value =
            serde_json::from_slice(&fs::read(home.path().join(".codex/auth.json")).unwrap())
                .unwrap();
        assert_eq!(
            active_after_stop
                .pointer("/tokens/access_token")
                .and_then(Value::as_str),
            Some("renewed-access-token")
        );
    }

    #[test]
    fn account_lifecycle_enforces_reauth_disable_delete_and_runtime_guards() {
        let (_data, _home, supervisor, a, b) = two_account_supervisor();
        assert!(supervisor
            .upsert_captured_account(
                ProviderId::Codex,
                Some(&b),
                None,
                captured_codex("different-account"),
                false,
            )
            .is_err());
        supervisor
            .upsert_captured_account(
                ProviderId::Codex,
                Some(&b),
                Some("B 재인증".to_owned()),
                captured_codex("account-b"),
                false,
            )
            .unwrap();
        let disabled = supervisor.set_disabled(&b, true).unwrap();
        assert!(
            disabled
                .accounts
                .iter()
                .find(|account| account.id == b)
                .unwrap()
                .disabled
        );
        assert!(supervisor
            .acquire_runtime(ProviderId::Codex, Some(&b), None)
            .is_err());
        supervisor.set_disabled(&b, false).unwrap();
        assert!(supervisor.delete_account(&b, true).is_err());
        let lease = supervisor
            .acquire_runtime(ProviderId::Codex, Some(&a), None)
            .unwrap();
        assert!(supervisor.delete_account(&b, false).is_err());
        supervisor
            .upsert_captured_account(
                ProviderId::Codex,
                Some(&a),
                None,
                captured_codex("account-a"),
                false,
            )
            .unwrap();
        assert_eq!(
            supervisor
                .snapshot()
                .unwrap()
                .providers
                .iter()
                .find(|provider| provider.provider == ProviderId::Codex)
                .unwrap()
                .pending_default_account_id
                .as_deref(),
            Some(a.as_str())
        );
        drop(lease);
        let deleted = supervisor.delete_account(&b, false).unwrap();
        assert!(deleted.accounts.iter().all(|account| account.id != b));
    }

    #[test]
    fn set_auto_switch_defaults_to_off_and_persists() {
        let (data, _home, supervisor, a, b) = two_account_supervisor();
        let snapshot = supervisor.snapshot().unwrap();
        assert!(snapshot.accounts.iter().all(|account| !account.auto_switch));
        let updated = supervisor.set_auto_switch(&b, true).unwrap();
        assert!(
            updated
                .accounts
                .iter()
                .find(|account| account.id == b)
                .unwrap()
                .auto_switch
        );
        assert!(
            !updated
                .accounts
                .iter()
                .find(|account| account.id == a)
                .unwrap()
                .auto_switch
        );
        let reloaded = load_registry(data.path()).unwrap();
        assert!(
            reloaded
                .accounts
                .iter()
                .find(|account| account.id == b)
                .unwrap()
                .auto_switch
        );
        let cleared = supervisor.set_auto_switch(&b, false).unwrap();
        assert!(
            !cleared
                .accounts
                .iter()
                .find(|account| account.id == b)
                .unwrap()
                .auto_switch
        );
    }

    #[test]
    fn account_record_without_auto_switch_field_deserializes_to_off() {
        let json = r#"{"id":"acc","provider":"codex","displayName":"A","email":null,"organization":null,"providerAccountId":"account-a","disabled":false,"authStatus":"ready","usage":{"status":"idle","windows":[],"updatedAt":null,"error":null},"createdAt":0,"updatedAt":0}"#;
        let record: AccountRecord = serde_json::from_str(json).unwrap();
        assert!(!record.auto_switch);
    }

    fn auto_switch_record(id: &str, auto_switch: bool, usage: AccountUsageView) -> AccountRecord {
        AccountRecord {
            id: id.to_owned(),
            provider: ProviderId::Codex,
            display_name: id.to_owned(),
            email: None,
            organization: None,
            provider_account_id: id.to_owned(),
            disabled: false,
            auto_switch,
            auth_status: AccountAuthStatus::Ready,
            usage,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn exhausted_usage(resets_at: Option<i64>) -> AccountUsageView {
        AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "5h".to_owned(),
                used_percent: 100.0,
                resets_at,
            }],
            updated_at: Some(0),
            error: None,
            retry_at: None,
            rate_limited: false,
        }
    }

    #[test]
    fn auto_switch_target_rotates_in_registry_order_and_skips_unavailable_accounts() {
        let now = 1_000_000;
        let mut c_disabled = auto_switch_record("c", true, AccountUsageView::default());
        c_disabled.disabled = true;
        let mut e_auth = auto_switch_record("e", true, AccountUsageView::default());
        e_auth.auth_status = AccountAuthStatus::Missing;
        let accounts = vec![
            auto_switch_record("a", true, AccountUsageView::default()),
            auto_switch_record("b", true, exhausted_usage(Some(now + 60_000))),
            c_disabled,
            auto_switch_record("d", false, AccountUsageView::default()),
            e_auth,
            auto_switch_record("f", true, AccountUsageView::default()),
        ];
        // 활성 계정 a 다음부터 순환: 한도 도달(b)·비활성(c)·자동전환 꺼짐(d)·
        // 재인증 필요(e)는 제외되고 f가 선택된다.
        assert_eq!(
            select_auto_switch_target(&accounts, ProviderId::Codex, "a", now),
            Some("f".to_owned())
        );
        // 마지막 계정이 활성이면 처음으로 감아 순환한다.
        assert_eq!(
            select_auto_switch_target(&accounts, ProviderId::Codex, "f", now),
            Some("a".to_owned())
        );
        // 리셋 시각이 지난 한도 도달 계정은 다시 후보가 된다.
        assert_eq!(
            select_auto_switch_target(&accounts, ProviderId::Codex, "a", now + 120_000),
            Some("b".to_owned())
        );
        let only_active = vec![auto_switch_record("a", true, AccountUsageView::default())];
        assert_eq!(
            select_auto_switch_target(&only_active, ProviderId::Codex, "a", now),
            None
        );
    }

    #[test]
    fn auto_switch_skips_rate_limited_candidates_until_retry_time_passes() {
        let now = 1_000_000;
        let rate_limited = AccountUsageView {
            rate_limited: true,
            retry_at: Some(now + 30_000),
            ..AccountUsageView::default()
        };
        let accounts = vec![
            auto_switch_record("a", true, AccountUsageView::default()),
            auto_switch_record("b", true, rate_limited),
        ];
        assert_eq!(
            select_auto_switch_target(&accounts, ProviderId::Codex, "a", now),
            None
        );
        assert_eq!(
            select_auto_switch_target(&accounts, ProviderId::Codex, "a", now + 60_000),
            Some("b".to_owned())
        );
        assert!(usage_indicates_exhaustion(&exhausted_usage(None)));
        assert!(!usage_indicates_exhaustion(&AccountUsageView::default()));
    }

    #[test]
    fn plan_auto_switch_requires_auto_switch_accounts_and_honors_cooldown() {
        let (_data, _home, supervisor, a, b) = two_account_supervisor();
        let snapshot = supervisor.snapshot().unwrap();
        let active = snapshot
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .unwrap()
            .active_account_id
            .clone()
            .unwrap();
        let other = if active == a { b.clone() } else { a.clone() };
        let signal = AutoSwitchSignal {
            provider: ProviderId::Codex,
            account_id: active.clone(),
            reason: AutoSwitchReason::UsageExhausted,
        };
        // 활성 계정의 자동전환이 꺼져 있으면 전환하지 않는다.
        assert_eq!(supervisor.plan_auto_switch(&signal).unwrap(), None);
        supervisor.set_auto_switch(&active, true).unwrap();
        // 후보 계정도 자동전환이 켜져 있어야 순환 대상이 된다.
        assert_eq!(supervisor.plan_auto_switch(&signal).unwrap(), None);
        supervisor.set_auto_switch(&other, true).unwrap();
        assert_eq!(
            supervisor.plan_auto_switch(&signal).unwrap(),
            Some(other.clone())
        );
        // 신호의 계정이 더 이상 활성이 아니면 무시한다.
        let stale = AutoSwitchSignal {
            provider: ProviderId::Codex,
            account_id: other.clone(),
            reason: AutoSwitchReason::AgentLimited,
        };
        assert_eq!(supervisor.plan_auto_switch(&stale).unwrap(), None);
        // 직전 자동전환 기록이 있으면 쿨다운 동안 전환하지 않고 스냅샷에 노출된다.
        supervisor.record_auto_switch(
            ProviderId::Codex,
            &active,
            &other,
            AutoSwitchReason::UsageExhausted,
            2,
        );
        assert_eq!(supervisor.plan_auto_switch(&signal).unwrap(), None);
        let recorded = supervisor.snapshot().unwrap();
        let event = recorded
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .unwrap()
            .last_auto_switch
            .clone()
            .unwrap();
        assert_eq!(event.from_account_id, active);
        assert_eq!(event.to_account_id, other);
        assert_eq!(event.reason, AutoSwitchReason::UsageExhausted);
        assert_eq!(event.resumed_session_count, 2);
    }

    #[test]
    fn auto_switch_resume_defaults_on_and_persists() {
        let (data, _home, supervisor, _a, _b) = two_account_supervisor();
        assert!(supervisor.snapshot().unwrap().auto_switch_resume);
        assert!(supervisor.auto_switch_resume_enabled().unwrap());
        let off = supervisor.set_auto_switch_resume(false).unwrap();
        assert!(!off.auto_switch_resume);
        assert!(!supervisor.auto_switch_resume_enabled().unwrap());
        assert!(!load_registry(data.path()).unwrap().auto_switch_resume);
        // 이전 버전 레지스트리(필드 없음)는 기본값 on으로 읽힌다.
        let json = r#"{"schemaVersion":1,"credentialVaultVersion":3,"accounts":[],"providers":[]}"#;
        let registry: AccountRegistry = serde_json::from_str(json).unwrap();
        assert!(registry.auto_switch_resume);
    }

    #[test]
    fn report_agent_usage_limit_marks_account_rate_limited() {
        let (_data, _home, supervisor, a, _b) = two_account_supervisor();
        supervisor.report_agent_usage_limit(&a).unwrap();
        let snapshot = supervisor.snapshot().unwrap();
        let usage = &snapshot
            .accounts
            .iter()
            .find(|account| account.id == a)
            .unwrap()
            .usage;
        assert!(usage.rate_limited);
        assert!(usage.retry_at.unwrap() > now_ms());
    }

    #[test]
    fn claude_switch_keeps_shared_session_history_unchanged() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_home = home.path().join(".claude");
        fs::create_dir_all(&claude_home).unwrap();
        fs::write(
            claude_home.join(".credentials.json"),
            claude_secret("claude-a"),
        )
        .unwrap();
        let supervisor = AccountSupervisor::open_with(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();
        supervisor
            .register_current(ProviderId::Claude, Some("Claude A".to_owned()))
            .unwrap();
        fs::write(
            claude_home.join(".credentials.json"),
            claude_secret("claude-b"),
        )
        .unwrap();
        supervisor
            .register_current(ProviderId::Claude, Some("Claude B".to_owned()))
            .unwrap();
        let snapshot = supervisor.snapshot().unwrap();
        let a = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "claude-a")
            .unwrap()
            .id
            .clone();
        let b = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "claude-b")
            .unwrap()
            .id
            .clone();
        supervisor.set_default(&a).unwrap();
        let history = claude_home.join("projects/project/session-id.jsonl");
        fs::create_dir_all(history.parent().unwrap()).unwrap();
        fs::write(&history, b"same claude session id\n").unwrap();
        let transition = supervisor
            .begin_temporary_switch(ProviderId::Claude, &b)
            .unwrap()
            .unwrap();
        transition.restore().unwrap();
        assert_eq!(fs::read(history).unwrap(), b"same claude session id\n");
        assert_eq!(
            supervisor.active_account_id(ProviderId::Claude).unwrap(),
            Some(a)
        );
    }

    #[test]
    fn startup_recovers_an_interrupted_switch_before_new_runtime() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let vault = Arc::new(MemoryVault::default());
        let codex_home = home.path().join(".codex");
        fs::create_dir_all(&codex_home).unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("account-a")).unwrap();
        let supervisor =
            AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        supervisor
            .register_current(ProviderId::Codex, Some("A".to_owned()))
            .unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("account-b")).unwrap();
        supervisor
            .register_current(ProviderId::Codex, Some("B".to_owned()))
            .unwrap();
        let snapshot = supervisor.snapshot().unwrap();
        let a = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-a")
            .unwrap()
            .id
            .clone();
        let b = snapshot
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-b")
            .unwrap()
            .id
            .clone();
        supervisor.set_default(&a).unwrap();
        let transition = supervisor
            .begin_temporary_switch(ProviderId::Codex, &b)
            .unwrap()
            .unwrap();
        std::mem::forget(transition);
        drop(supervisor);

        let recovered = AccountSupervisor::open_with(data.path(), home.path(), vault).unwrap();
        assert_eq!(
            recovered.active_account_id(ProviderId::Codex).unwrap(),
            Some(a)
        );
        assert!(!journal_path(data.path(), ProviderId::Codex).exists());
        let _lease = recovered
            .acquire_runtime(ProviderId::Codex, None, None)
            .unwrap();
    }

    #[test]
    fn unscoped_managed_runtime_participates_in_provider_runtime_count() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let supervisor = AccountSupervisor::open_with(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();

        let lease = supervisor
            .acquire_unscoped_runtime(ProviderId::Codex)
            .unwrap();
        assert_eq!(
            supervisor
                .provider_runtime_count(ProviderId::Codex)
                .unwrap(),
            1
        );
        drop(lease);
        assert_eq!(
            supervisor
                .provider_runtime_count(ProviderId::Codex)
                .unwrap(),
            0
        );
    }

    #[test]
    fn pending_default_applies_only_after_previous_account_restoration() {
        let (_data, _home, supervisor, a, b) = two_account_supervisor();
        let transition = supervisor
            .begin_temporary_switch(ProviderId::Codex, &b)
            .unwrap()
            .unwrap();
        let lease = supervisor
            .acquire_runtime(ProviderId::Codex, Some(&b), Some(transition.id()))
            .unwrap();
        let pending = supervisor.set_default(&b).unwrap();
        assert_eq!(
            pending
                .providers
                .iter()
                .find(|provider| provider.provider == ProviderId::Codex)
                .unwrap()
                .pending_default_account_id
                .as_deref(),
            Some(b.as_str())
        );
        drop(lease);
        transition.restore().unwrap();
        assert_eq!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(b)
        );
        assert_ne!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(a)
        );
    }
}
