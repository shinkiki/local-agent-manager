//! C20. 접근 채널 로그인 — ID/비밀번호와 OTP를 채널(데스크톱·로컬 브라우저·원격)별로 켠다.
//!
//! 이 모듈이 쓰는 자리는 셋뿐이다(C20-1): `login-settings-v1.json`(아이디, argon2id 해시,
//! 채널별 요구, 마지막 OTP 스텝), `login-sessions-v1.json`(세션의 SHA-256만), 그리고 OTP
//! 비밀 — OS 보안 저장소에 두되 저장소가 없는 헤드리스에서는 앱 데이터의 `login-otp-secret`
//! (0600) 파일로 내려간다(C20-8). 비밀번호 원문은 어디에도 남지 않는다.
//!
//! 판정은 한 프로세스의 `LoginAuth` 핸들이 메모리에서 하고, 파일은 그 뒤를 따른다. 백엔드는
//! 소유권 리스로 앱 데이터를 혼자 쓰므로 파일 잠금은 두지 않는다.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::app_data_file::{
    ensure_schema_version, read_private_json, write_private_bytes, write_private_json,
};
use crate::app_error::AppError;
use crate::login_sessions::{
    IssuedSession, LoginRateLimiter, LoginSessionStore, LoginSessionView, ResolvedSession,
};
use crate::login_totp;
use crate::CoreError;

pub const LOGIN_SETTINGS_FILE_NAME: &str = "login-settings-v1.json";
pub const LOGIN_OTP_SECRET_FILE_NAME: &str = "login-otp-secret";
const SETTINGS_SCHEMA_VERSION: u32 = 1;
const OTP_KEYCHAIN_SERVICE: &str = "Agent Manager Login";
const OTP_KEYCHAIN_ACCOUNT: &str = "totp";
/// OTP 등록을 시작하고 확인 코드를 넣기까지 기다리는 시간.
const OTP_SETUP_TTL_MS: i64 = 10 * 60 * 1000;
pub const MAX_USER_ID_CHARS: usize = 64;
pub const MIN_PASSWORD_CHARS: usize = 8;
pub const MAX_PASSWORD_CHARS: usize = 256;

/// 로그인을 요구할 수 있는 접근 채널. Origin 없는 loopback 호출(native)은 호스트 프로세스라
/// 여기 없다(C20-5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginChannel {
    Desktop,
    LocalBrowser,
    Remote,
}

impl LoginChannel {
    pub const ALL: [LoginChannel; 3] = [
        LoginChannel::Desktop,
        LoginChannel::LocalBrowser,
        LoginChannel::Remote,
    ];

    pub fn label(self) -> &'static str {
        match self {
            LoginChannel::Desktop => "데스크톱",
            LoginChannel::LocalBrowser => "로컬 브라우저",
            LoginChannel::Remote => "원격",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LoginMethod {
    Password,
    Otp,
}

impl LoginMethod {
    fn label(self) -> &'static str {
        match self {
            LoginMethod::Password => "ID/비밀번호",
            LoginMethod::Otp => "OTP",
        }
    }
}

/// 한 채널이 요구하는 수단. 둘 다 꺼져 있으면 로그인 없이 연다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequirement {
    pub password: bool,
    pub otp: bool,
}

impl LoginRequirement {
    pub fn any(self) -> bool {
        self.password || self.otp
    }

    /// 두 채널 중 약한 쪽 — 둘 다 요구할 때만 요구한다(C20-6).
    pub fn weaker(self, other: Self) -> Self {
        Self {
            password: self.password && other.password,
            otp: self.otp && other.otp,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRequirements {
    pub desktop: LoginRequirement,
    pub local_browser: LoginRequirement,
    pub remote: LoginRequirement,
}

impl ChannelRequirements {
    pub fn get(&self, channel: LoginChannel) -> LoginRequirement {
        match channel {
            LoginChannel::Desktop => self.desktop,
            LoginChannel::LocalBrowser => self.local_browser,
            LoginChannel::Remote => self.remote,
        }
    }

    fn get_mut(&mut self, channel: LoginChannel) -> &mut LoginRequirement {
        match channel {
            LoginChannel::Desktop => &mut self.desktop,
            LoginChannel::LocalBrowser => &mut self.local_browser,
            LoginChannel::Remote => &mut self.remote,
        }
    }

    fn uses(&self, method: LoginMethod) -> Vec<LoginChannel> {
        LoginChannel::ALL
            .into_iter()
            .filter(|channel| {
                let requirement = self.get(*channel);
                match method {
                    LoginMethod::Password => requirement.password,
                    LoginMethod::Otp => requirement.otp,
                }
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLoginSettings {
    schema_version: u32,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    password_hash: Option<String>,
    #[serde(default)]
    otp_configured: bool,
    #[serde(default)]
    last_otp_step: Option<u64>,
    #[serde(default)]
    channels: ChannelRequirements,
}

impl Default for StoredLoginSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            user_id: String::new(),
            password_hash: None,
            otp_configured: false,
            last_otp_step: None,
            channels: ChannelRequirements::default(),
        }
    }
}

/// OTP 비밀이 지금 어디에 있는지. 화면은 `file`이면 경고를 띄운다(C20-8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OtpSecretStorage {
    Keychain,
    File,
}

/// 설정 화면이 읽는 상태. 해시도 비밀도 싣지 않는다.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoginSettingsView {
    pub user_id: String,
    pub password_configured: bool,
    pub otp_configured: bool,
    pub otp_secret_storage: Option<OtpSecretStorage>,
    pub channels: ChannelRequirements,
}

/// OTP 등록을 시작하면 돌려주는 것. 확인 코드가 맞기 전에는 아무것도 저장되지 않는다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtpSetup {
    pub otpauth_url: String,
    pub secret_base32: String,
    pub qr_svg: String,
    pub expires_at: i64,
}

/// 설정을 바꾸는 명령이 함께 내는 재인증. 비밀번호가 있으면 비밀번호, 없고 OTP만 있으면
/// OTP, 둘 다 없으면 아무것도 요구하지 않는다(C20-4).
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reauth {
    #[serde(default)]
    pub current_password: Option<String>,
    #[serde(default)]
    pub current_otp: Option<String>,
}

impl std::fmt::Debug for Reauth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Reauth")
            .field(
                "current_password",
                &self.current_password.as_ref().map(|_| "***"),
            )
            .field("current_otp", &self.current_otp.as_ref().map(|_| "***"))
            .finish()
    }
}

struct PendingOtp {
    secret: Zeroizing<Vec<u8>>,
    expires_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeychainMode {
    /// 실제 OS 보안 저장소를 먼저 쓰고, 없을 때만 파일로 내려간다.
    Os,
    /// 시험용 — 저장소가 없는 헤드리스 호스트처럼 군다.
    #[cfg_attr(not(test), allow(dead_code))]
    Unavailable,
}

/// OTP 비밀의 자리. 키체인 → 파일 순서로 읽고, 키체인이 없을 때만 파일에 쓴다.
struct OtpSecretStore {
    file_path: PathBuf,
    keychain: KeychainMode,
}

impl OtpSecretStore {
    fn keychain_read(&self) -> Result<Option<Zeroizing<String>>, CoreError> {
        match self.keychain {
            KeychainMode::Os => crate::os_keychain::read_os_keychain_password(
                OTP_KEYCHAIN_SERVICE,
                OTP_KEYCHAIN_ACCOUNT,
            ),
            KeychainMode::Unavailable => Err(keychain_unavailable()),
        }
    }

    fn keychain_write(&self, secret: &str) -> Result<(), CoreError> {
        match self.keychain {
            KeychainMode::Os => crate::os_keychain::write_os_keychain_password(
                OTP_KEYCHAIN_SERVICE,
                OTP_KEYCHAIN_ACCOUNT,
                secret,
            ),
            KeychainMode::Unavailable => Err(keychain_unavailable()),
        }
    }

    fn keychain_delete(&self) -> Result<(), CoreError> {
        match self.keychain {
            KeychainMode::Os => crate::os_keychain::delete_os_keychain_password(
                OTP_KEYCHAIN_SERVICE,
                OTP_KEYCHAIN_ACCOUNT,
            ),
            KeychainMode::Unavailable => Err(keychain_unavailable()),
        }
    }

    /// (비밀, 자리). 둘 다 없으면 `None`.
    fn read(&self) -> Result<Option<(Zeroizing<String>, OtpSecretStorage)>, CoreError> {
        match self.keychain_read() {
            Ok(Some(secret)) => return Ok(Some((secret, OtpSecretStorage::Keychain))),
            Ok(None) => {}
            Err(error) if crate::os_keychain::is_keychain_unavailable(&error) => {}
            Err(error) => return Err(error),
        }
        if !self.file_path.is_file() {
            return Ok(None);
        }
        let bytes = Zeroizing::new(std::fs::read(&self.file_path)?);
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|_| CoreError::Runtime("OTP 비밀 파일을 읽지 못했습니다".to_owned()))?;
        Ok(Some((
            Zeroizing::new(text.trim().to_owned()),
            OtpSecretStorage::File,
        )))
    }

    fn write(&self, secret: &str) -> Result<OtpSecretStorage, CoreError> {
        match self.keychain_write(secret) {
            Ok(()) => {
                // 키체인에 들어갔으면 예전 폴백 파일은 남겨 둘 이유가 없다.
                if self.file_path.is_file() {
                    std::fs::remove_file(&self.file_path)?;
                }
                Ok(OtpSecretStorage::Keychain)
            }
            Err(error) if crate::os_keychain::is_keychain_unavailable(&error) => {
                write_private_bytes(&self.file_path, secret.as_bytes())?;
                Ok(OtpSecretStorage::File)
            }
            Err(error) => Err(error),
        }
    }

    fn delete(&self) -> Result<(), CoreError> {
        match self.keychain_delete() {
            Ok(()) => {}
            Err(error) if crate::os_keychain::is_keychain_unavailable(&error) => {}
            Err(error) => return Err(error),
        }
        if self.file_path.is_file() {
            std::fs::remove_file(&self.file_path)?;
        }
        Ok(())
    }
}

fn keychain_unavailable() -> CoreError {
    CoreError::Coded(AppError::conflict(
        crate::os_keychain::KEYCHAIN_UNAVAILABLE_CODE,
        "OS 보안 저장소에 닿을 수 없습니다",
    ))
}

struct Inner {
    app_data_dir: PathBuf,
    settings: StoredLoginSettings,
    sessions: LoginSessionStore,
    limiter: LoginRateLimiter,
    pending_otp: Option<PendingOtp>,
    otp_secret: OtpSecretStore,
}

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// 한 백엔드 프로세스가 공유하는 로그인 판정 핸들.
#[derive(Clone)]
pub struct LoginAuth {
    inner: Arc<Mutex<Inner>>,
    /// 시험이 시각을 쥐기 위한 자리. 운영에서는 벽시계다.
    clock: Clock,
}

impl std::fmt::Debug for LoginAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LoginAuth")
    }
}

impl LoginAuth {
    pub fn open(app_data_dir: &Path) -> Result<Self, CoreError> {
        Self::open_with(
            app_data_dir,
            KeychainMode::Os,
            Arc::new(crate::clock::now_ms),
        )
    }

    fn open_with(
        app_data_dir: &Path,
        keychain: KeychainMode,
        clock: Clock,
    ) -> Result<Self, CoreError> {
        std::fs::create_dir_all(app_data_dir)?;
        let path = app_data_dir.join(LOGIN_SETTINGS_FILE_NAME);
        let settings = match read_private_json::<StoredLoginSettings>(&path)? {
            Some(stored) => {
                ensure_schema_version(
                    stored.schema_version,
                    SETTINGS_SCHEMA_VERSION,
                    "로그인 설정",
                )?;
                stored
            }
            None => StoredLoginSettings::default(),
        };
        let sessions = LoginSessionStore::open(app_data_dir)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                app_data_dir: app_data_dir.to_path_buf(),
                settings,
                sessions,
                limiter: LoginRateLimiter::default(),
                pending_otp: None,
                otp_secret: OtpSecretStore {
                    file_path: app_data_dir.join(LOGIN_OTP_SECRET_FILE_NAME),
                    keychain,
                },
            })),
            clock,
        })
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // ---- 판정 ------------------------------------------------------------------------

    pub fn requirement(&self, channel: LoginChannel) -> LoginRequirement {
        self.lock().settings.channels.get(channel)
    }

    /// Origin 없는 loopback GET(이미지 등)에 적용하는 요구 — 두 루프백 채널 중 약한 쪽(C20-6).
    pub fn loopback_asset_requirement(&self) -> LoginRequirement {
        let channels = self.lock().settings.channels;
        channels.desktop.weaker(channels.local_browser)
    }

    pub fn resolve_session(&self, token: &str) -> Option<ResolvedSession> {
        self.lock().sessions.touch(token, self.now())
    }

    /// 채널이 요구하는 수단을 전부 확인하고 세션을 발급한다. 어느 수단이 틀렸는지는 말하지
    /// 않는다 — 아이디가 있는지조차 답이 되면 안 된다.
    pub fn authenticate(
        &self,
        channel: LoginChannel,
        user_id: Option<&str>,
        password: Option<&str>,
        otp: Option<&str>,
        label: &str,
    ) -> Result<IssuedSession, CoreError> {
        self.authenticate_at(channel, user_id, password, otp, label, self.now())
    }

    fn authenticate_at(
        &self,
        channel: LoginChannel,
        user_id: Option<&str>,
        password: Option<&str>,
        otp: Option<&str>,
        label: &str,
        now: i64,
    ) -> Result<IssuedSession, CoreError> {
        let mut inner = self.lock();
        if let Err(retry_after) = inner.limiter.check(channel, now) {
            return Err(login_locked(retry_after));
        }
        let requirement = inner.settings.channels.get(channel);
        if !requirement.any() {
            return Err(CoreError::Coded(AppError::invalid_input(
                "LOGIN_NOTHING_REQUIRED",
                format!("{} 채널은 로그인 없이 열립니다", channel.label()),
            )));
        }
        let mut ok = true;
        if requirement.password {
            ok &= inner.verify_password(user_id, password);
        }
        let mut accepted_step = None;
        if requirement.otp {
            match inner.verify_otp(otp, now) {
                Ok(step) => accepted_step = Some(step),
                Err(error) => {
                    if !matches!(error, CoreError::Coded(_)) {
                        return Err(error);
                    }
                    ok = false;
                }
            }
        }
        if !ok {
            inner.limiter.record_failure(channel, now);
            return Err(login_invalid());
        }
        inner.limiter.record_success(channel);
        if let Some(step) = accepted_step {
            inner.settings.last_otp_step = Some(step);
            inner.persist_settings()?;
        }
        inner.sessions.issue(channel, label, now)
    }

    pub fn logout(&self, token: &str) -> Result<bool, CoreError> {
        self.lock().sessions.revoke_by_token(token)
    }

    // ---- 설정 ------------------------------------------------------------------------

    pub fn settings_view(&self) -> Result<LoginSettingsView, CoreError> {
        let inner = self.lock();
        let otp_secret_storage = if inner.settings.otp_configured {
            inner.otp_secret.read()?.map(|(_, storage)| storage)
        } else {
            None
        };
        Ok(LoginSettingsView {
            user_id: inner.settings.user_id.clone(),
            password_configured: inner.settings.password_hash.is_some(),
            otp_configured: inner.settings.otp_configured,
            otp_secret_storage,
            channels: inner.settings.channels,
        })
    }

    pub fn set_user_id(
        &self,
        channel: LoginChannel,
        user_id: &str,
        reauth: &Reauth,
    ) -> Result<LoginSettingsView, CoreError> {
        let user_id = validate_user_id(user_id)?;
        {
            let mut inner = self.lock();
            inner.reauthenticate(channel, reauth, self.now())?;
            inner.settings.user_id = user_id;
            inner.persist_settings()?;
        }
        self.settings_view()
    }

    /// 비밀번호를 처음 두거나 바꾼다. `user_id`를 함께 주면 같은 재인증 아래 둘을 한 번에 둔다.
    pub fn set_password(
        &self,
        channel: LoginChannel,
        user_id: Option<&str>,
        next: &str,
        reauth: &Reauth,
    ) -> Result<LoginSettingsView, CoreError> {
        validate_password(next)?;
        let user_id = user_id.map(validate_user_id).transpose()?;
        {
            let mut inner = self.lock();
            inner.reauthenticate(channel, reauth, self.now())?;
            if let Some(user_id) = user_id {
                inner.settings.user_id = user_id;
            }
            if inner.settings.user_id.is_empty() {
                return Err(CoreError::Coded(AppError::invalid_input(
                    "LOGIN_USER_ID_REQUIRED",
                    "비밀번호를 두려면 먼저 아이디가 있어야 합니다",
                )));
            }
            inner.settings.password_hash = Some(hash_password(next)?);
            inner.persist_settings()?;
        }
        self.settings_view()
    }

    pub fn clear_password(
        &self,
        channel: LoginChannel,
        reauth: &Reauth,
    ) -> Result<LoginSettingsView, CoreError> {
        {
            let mut inner = self.lock();
            inner.reauthenticate(channel, reauth, self.now())?;
            inner.ensure_method_unused(LoginMethod::Password)?;
            inner.settings.password_hash = None;
            inner.persist_settings()?;
        }
        self.settings_view()
    }

    pub fn begin_otp_setup(
        &self,
        channel: LoginChannel,
        reauth: &Reauth,
    ) -> Result<OtpSetup, CoreError> {
        self.begin_otp_setup_at(channel, reauth, self.now())
    }

    fn begin_otp_setup_at(
        &self,
        channel: LoginChannel,
        reauth: &Reauth,
        now: i64,
    ) -> Result<OtpSetup, CoreError> {
        let mut inner = self.lock();
        inner.reauthenticate(channel, reauth, now)?;
        let account = if inner.settings.user_id.is_empty() {
            "agent-manager".to_owned()
        } else {
            inner.settings.user_id.clone()
        };
        let secret = login_totp::random_secret();
        let secret_base32 = login_totp::base32_encode(&secret);
        let otpauth_url = login_totp::otpauth_url(&account, &secret_base32);
        let qr_svg = login_totp::qr_svg(&otpauth_url)?;
        let expires_at = now + OTP_SETUP_TTL_MS;
        inner.pending_otp = Some(PendingOtp { secret, expires_at });
        Ok(OtpSetup {
            otpauth_url,
            secret_base32,
            qr_svg,
            expires_at,
        })
    }

    /// 인증 앱이 낸 첫 코드가 맞아야 비밀이 저장된다. 그 전에는 등록이 없던 일이다.
    pub fn confirm_otp_setup(&self, code: &str) -> Result<LoginSettingsView, CoreError> {
        self.confirm_otp_setup_at(code, self.now())?;
        self.settings_view()
    }

    fn confirm_otp_setup_at(&self, code: &str, now: i64) -> Result<(), CoreError> {
        let mut inner = self.lock();
        let Some(pending) = inner.pending_otp.as_ref() else {
            return Err(CoreError::Coded(AppError::conflict(
                "LOGIN_OTP_SETUP_MISSING",
                "진행 중인 OTP 등록이 없습니다. 등록을 다시 시작하세요",
            )));
        };
        if pending.expires_at <= now {
            inner.pending_otp = None;
            return Err(CoreError::Coded(AppError::conflict(
                "LOGIN_OTP_SETUP_EXPIRED",
                "OTP 등록 시간이 지났습니다. 등록을 다시 시작하세요",
            )));
        }
        let Some(step) = login_totp::verify_totp(&pending.secret, (now / 1000) as u64, None, code)
        else {
            return Err(CoreError::Coded(AppError::unauthorized(
                "LOGIN_OTP_CODE_INVALID",
                "OTP 코드가 맞지 않습니다. 인증 앱의 현재 코드를 넣으세요",
            )));
        };
        let secret_base32 = login_totp::base32_encode(&pending.secret);
        inner.otp_secret.write(&secret_base32)?;
        inner.settings.otp_configured = true;
        inner.settings.last_otp_step = Some(step);
        inner.pending_otp = None;
        inner.persist_settings()
    }

    pub fn disable_otp(
        &self,
        channel: LoginChannel,
        reauth: &Reauth,
    ) -> Result<LoginSettingsView, CoreError> {
        {
            let mut inner = self.lock();
            inner.reauthenticate(channel, reauth, self.now())?;
            inner.ensure_method_unused(LoginMethod::Otp)?;
            inner.otp_secret.delete()?;
            inner.settings.otp_configured = false;
            inner.settings.last_otp_step = None;
            inner.pending_otp = None;
            inner.persist_settings()?;
        }
        self.settings_view()
    }

    /// 채널 하나의 수단 하나를 켜거나 끈다. 켜려면 그 수단이 먼저 설정돼 있어야 한다.
    pub fn set_channel_requirement(
        &self,
        channel: LoginChannel,
        method: LoginMethod,
        enabled: bool,
    ) -> Result<LoginSettingsView, CoreError> {
        {
            let mut inner = self.lock();
            if enabled {
                let configured = match method {
                    LoginMethod::Password => inner.settings.password_hash.is_some(),
                    LoginMethod::Otp => inner.settings.otp_configured,
                };
                if !configured {
                    return Err(CoreError::Coded(
                        AppError::invalid_input(
                            "LOGIN_METHOD_NOT_CONFIGURED",
                            format!(
                                "{}을(를) 먼저 설정해야 채널에 켤 수 있습니다",
                                method.label()
                            ),
                        )
                        .with("method", method_key(method)),
                    ));
                }
            }
            let requirement = inner.settings.channels.get_mut(channel);
            match method {
                LoginMethod::Password => requirement.password = enabled,
                LoginMethod::Otp => requirement.otp = enabled,
            }
            inner.persist_settings()?;
        }
        self.settings_view()
    }

    // ---- 세션 ------------------------------------------------------------------------

    pub fn list_sessions(&self, current: Option<&str>) -> Vec<LoginSessionView> {
        self.lock().sessions.list(self.now(), current)
    }

    pub fn revoke_session(&self, id: &str) -> Result<bool, CoreError> {
        self.lock().sessions.revoke(id)
    }

    pub fn revoke_all_sessions(&self, keep: Option<&str>) -> Result<usize, CoreError> {
        self.lock().sessions.revoke_all(keep)
    }
}

impl Inner {
    fn persist_settings(&self) -> Result<(), CoreError> {
        write_private_json(
            &self.app_data_dir.join(LOGIN_SETTINGS_FILE_NAME),
            &self.settings,
        )
    }

    /// 아이디와 비밀번호를 **둘 다** 확인한다. 아이디가 틀려도 해시 검증을 건너뛰지 않아
    /// 응답 시간이 아이디의 존재를 말하지 않는다.
    fn verify_password(&self, user_id: Option<&str>, password: Option<&str>) -> bool {
        let user_id = user_id.unwrap_or_default().trim();
        let user_matches: bool = user_id
            .as_bytes()
            .ct_eq(self.settings.user_id.as_bytes())
            .into();
        let password_matches = match (&self.settings.password_hash, password) {
            (Some(hash), Some(password)) => verify_password_hash(hash, password),
            (Some(hash), None) => {
                let _ = verify_password_hash(hash, "");
                false
            }
            (None, _) => false,
        };
        user_matches & password_matches & !self.settings.user_id.is_empty()
    }

    /// 코드가 맞으면 받아들인 스텝. 틀리면 코드화된 오류, 비밀을 읽지 못하면 그 오류.
    fn verify_otp(&self, otp: Option<&str>, now: i64) -> Result<u64, CoreError> {
        if !self.settings.otp_configured {
            return Err(login_invalid());
        }
        let Some((secret_base32, _)) = self.otp_secret.read()? else {
            // 설정은 켜져 있는데 비밀이 사라졌다. 사용자가 OTP를 다시 등록해야 한다.
            return Err(CoreError::Runtime(
                "OTP 비밀을 찾을 수 없습니다. 설정 → 시스템에서 OTP를 다시 등록하세요".to_owned(),
            ));
        };
        let secret = login_totp::base32_decode(&secret_base32)
            .ok_or_else(|| CoreError::Runtime("저장된 OTP 비밀을 읽지 못했습니다".to_owned()))?;
        login_totp::verify_totp(
            &secret,
            (now / 1000) as u64,
            self.settings.last_otp_step,
            otp.unwrap_or_default(),
        )
        .ok_or_else(login_invalid)
    }

    fn reauthenticate(
        &mut self,
        channel: LoginChannel,
        reauth: &Reauth,
        now: i64,
    ) -> Result<(), CoreError> {
        if let Err(retry_after) = self.limiter.check(channel, now) {
            return Err(login_locked(retry_after));
        }
        let verified = if self.settings.password_hash.is_some() {
            match reauth.current_password.as_deref() {
                Some(password) => {
                    self.verify_password(Some(&self.settings.user_id), Some(password))
                }
                None => return Err(reauth_required()),
            }
        } else if self.settings.otp_configured {
            match reauth.current_otp.as_deref() {
                Some(code) => match self.verify_otp(Some(code), now) {
                    Ok(step) => {
                        // 받아들인 스텝은 그 자리에서 디스크에 남긴다(C20-2). 뒤따르는 변경이
                        // 실패하거나(`LOGIN_METHOD_IN_USE`) 아예 저장하지 않는 호출
                        // (`begin_otp_setup`)이면 메모리에만 남아, 재시작 뒤 같은 코드가 다시 통했다.
                        self.settings.last_otp_step = Some(step);
                        self.persist_settings()?;
                        true
                    }
                    Err(CoreError::Coded(_)) => false,
                    Err(error) => return Err(error),
                },
                None => return Err(reauth_required()),
            }
        } else {
            true
        };
        if !verified {
            self.limiter.record_failure(channel, now);
            return Err(CoreError::Coded(AppError::unauthorized(
                "LOGIN_REAUTH_INVALID",
                "현재 비밀번호 또는 OTP가 맞지 않습니다",
            )));
        }
        self.limiter.record_success(channel);
        Ok(())
    }

    fn ensure_method_unused(&self, method: LoginMethod) -> Result<(), CoreError> {
        let users = self.settings.channels.uses(method);
        if users.is_empty() {
            return Ok(());
        }
        let names: Vec<_> = users.iter().map(|channel| channel.label()).collect();
        Err(CoreError::Coded(
            AppError::conflict(
                "LOGIN_METHOD_IN_USE",
                format!(
                    "{}은(는) {} 채널에서 쓰고 있어 해제할 수 없습니다. 채널에서 먼저 끄세요",
                    method.label(),
                    names.join("·")
                ),
            )
            .with("method", method_key(method))
            .with("channels", names.join(", ")),
        ))
    }
}

fn method_key(method: LoginMethod) -> &'static str {
    match method {
        LoginMethod::Password => "password",
        LoginMethod::Otp => "otp",
    }
}

fn login_invalid() -> CoreError {
    CoreError::Coded(AppError::unauthorized(
        "LOGIN_INVALID",
        "아이디·비밀번호 또는 OTP가 맞지 않습니다",
    ))
}

fn login_locked(retry_after: u64) -> CoreError {
    CoreError::Coded(
        AppError::rate_limited(
            "LOGIN_LOCKED",
            format!("로그인 시도가 너무 많습니다. {retry_after}초 뒤에 다시 시도하세요"),
        )
        .with("retryAfterSeconds", retry_after),
    )
}

fn reauth_required() -> CoreError {
    CoreError::Coded(AppError::unauthorized(
        "LOGIN_REAUTH_REQUIRED",
        "로그인 설정을 바꾸려면 현재 비밀번호(또는 OTP)를 함께 넣어야 합니다",
    ))
}

/// 이 채널이 로그인을 요구하는데 세션이 없을 때 전송 계층이 내는 오류.
pub fn login_required(requirement: LoginRequirement) -> CoreError {
    CoreError::Coded(
        AppError::unauthorized("LOGIN_REQUIRED", "로그인이 필요합니다")
            .with("password", requirement.password)
            .with("otp", requirement.otp),
    )
}

fn validate_user_id(user_id: &str) -> Result<String, CoreError> {
    let trimmed = user_id.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_USER_ID_CHARS
        || trimmed.chars().any(char::is_control)
    {
        return Err(CoreError::Coded(
            AppError::invalid_input(
                "LOGIN_USER_ID_INVALID",
                format!("아이디는 1~{MAX_USER_ID_CHARS}자이고 제어 문자를 넣을 수 없습니다"),
            )
            .with("max", MAX_USER_ID_CHARS),
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_password(password: &str) -> Result<(), CoreError> {
    let length = password.chars().count();
    if !(MIN_PASSWORD_CHARS..=MAX_PASSWORD_CHARS).contains(&length)
        || password.chars().any(char::is_control)
    {
        return Err(CoreError::Coded(
            AppError::invalid_input(
                "LOGIN_PASSWORD_INVALID",
                format!("비밀번호는 {MIN_PASSWORD_CHARS}~{MAX_PASSWORD_CHARS}자여야 합니다"),
            )
            .with("min", MIN_PASSWORD_CHARS)
            .with("max", MAX_PASSWORD_CHARS),
        ));
    }
    Ok(())
}

fn hash_password(password: &str) -> Result<String, CoreError> {
    use rand_core::OsRng;
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| CoreError::Runtime(format!("비밀번호를 해시하지 못했습니다: {error}")))
}

fn verify_password_hash(hash: &str, password: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| {
            Argon2::default()
                .verify_password(password.as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false)
}

/// `--reset-login`과 데스크톱 복구가 지우는 것. 로그인 설정·세션·OTP 비밀만이다(C20-7).
pub fn reset_login_files(app_data_dir: &Path) -> Result<Vec<String>, CoreError> {
    let mut removed = Vec::new();
    for name in [
        LOGIN_SETTINGS_FILE_NAME,
        crate::login_sessions::LOGIN_SESSIONS_FILE_NAME,
        LOGIN_OTP_SECRET_FILE_NAME,
    ] {
        let path = app_data_dir.join(name);
        if path.is_file() {
            std::fs::remove_file(&path)?;
            removed.push(name.to_owned());
        }
    }
    match crate::os_keychain::delete_os_keychain_password(
        OTP_KEYCHAIN_SERVICE,
        OTP_KEYCHAIN_ACCOUNT,
    ) {
        Ok(()) => {}
        Err(error) if crate::os_keychain::is_keychain_unavailable(&error) => {}
        Err(error) => return Err(error),
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use std::sync::atomic::{AtomicI64, Ordering};

    const NOW: i64 = 1_700_000_000_000;

    fn open(directory: &Path) -> LoginAuth {
        open_with_clock(directory, Arc::new(AtomicI64::new(NOW)))
    }

    fn open_with_clock(directory: &Path, clock: Arc<AtomicI64>) -> LoginAuth {
        LoginAuth::open_with(
            directory,
            KeychainMode::Unavailable,
            Arc::new(move || clock.load(Ordering::SeqCst)),
        )
        .expect("open")
    }

    fn password_reauth(password: &str) -> Reauth {
        Reauth {
            current_password: Some(password.to_owned()),
            current_otp: None,
        }
    }

    fn code(error: &CoreError) -> &str {
        match error {
            CoreError::Coded(coded) => coded.code(),
            other => panic!("코드화된 오류가 아니다: {other}"),
        }
    }

    /// 등록 → 확인까지 돌려 OTP를 켜고 비밀을 돌려준다.
    fn enroll_otp(auth: &LoginAuth, reauth: &Reauth) -> Zeroizing<Vec<u8>> {
        let setup = auth
            .begin_otp_setup_at(LoginChannel::Desktop, reauth, NOW)
            .expect("begin otp");
        let secret = login_totp::base32_decode(&setup.secret_base32).expect("secret");
        let step = login_totp::current_step((NOW / 1000) as u64);
        let code = format!("{:06}", login_totp::totp_code(&secret, step));
        auth.confirm_otp_setup_at(&code, NOW).expect("confirm otp");
        secret
    }

    #[test]
    fn defaults_require_nothing_and_write_no_file() {
        let directory = tempfile::tempdir().expect("tempdir");
        let auth = open(directory.path());
        for channel in LoginChannel::ALL {
            assert!(!auth.requirement(channel).any());
        }
        assert!(!directory.path().join(LOGIN_SETTINGS_FILE_NAME).exists());
        let view = auth.settings_view().expect("view");
        assert!(!view.password_configured && !view.otp_configured);
    }

    #[test]
    fn password_round_trips_through_argon2id_and_never_lands_in_the_file() {
        let directory = tempfile::tempdir().expect("tempdir");
        let auth = open(directory.path());
        let view = auth
            .set_password(
                LoginChannel::Desktop,
                Some("  shin  "),
                "correct horse battery",
                &Reauth::default(),
            )
            .expect("set password");
        assert_eq!(view.user_id, "shin");
        assert!(view.password_configured);
        let raw =
            fs::read_to_string(directory.path().join(LOGIN_SETTINGS_FILE_NAME)).expect("file");
        assert!(raw.contains("$argon2id$"));
        assert!(!raw.contains("correct horse battery"));

        auth.set_channel_requirement(LoginChannel::Remote, LoginMethod::Password, true)
            .expect("require password on remote");
        let issued = auth
            .authenticate_at(
                LoginChannel::Remote,
                Some("shin"),
                Some("correct horse battery"),
                None,
                "phone",
                NOW,
            )
            .expect("login");
        assert!(auth.resolve_session(&issued.token).is_some());
        for (user, password) in [
            (Some("shin"), Some("wrong password")),
            (Some("other"), Some("correct horse battery")),
            (None, Some("correct horse battery")),
            (Some("shin"), None),
        ] {
            let error = auth
                .authenticate_at(LoginChannel::Remote, user, password, None, "", NOW)
                .expect_err("rejected");
            assert_eq!(code(&error), "LOGIN_INVALID");
        }
        // 요구가 없는 채널에는 로그인 자체가 없다.
        assert_eq!(
            code(
                &auth
                    .authenticate_at(
                        LoginChannel::Desktop,
                        Some("shin"),
                        Some("correct horse battery"),
                        None,
                        "",
                        NOW
                    )
                    .expect_err("nothing required")
            ),
            "LOGIN_NOTHING_REQUIRED"
        );
    }

    #[test]
    fn a_method_cannot_be_required_before_it_is_configured_or_cleared_while_in_use() {
        let directory = tempfile::tempdir().expect("tempdir");
        let auth = open(directory.path());
        let error = auth
            .set_channel_requirement(LoginChannel::Desktop, LoginMethod::Password, true)
            .expect_err("not configured");
        assert_eq!(code(&error), "LOGIN_METHOD_NOT_CONFIGURED");
        let error = auth
            .set_channel_requirement(LoginChannel::Remote, LoginMethod::Otp, true)
            .expect_err("not configured");
        assert_eq!(code(&error), "LOGIN_METHOD_NOT_CONFIGURED");

        auth.set_password(
            LoginChannel::Desktop,
            Some("shin"),
            "password-123",
            &Reauth::default(),
        )
        .expect("set password");
        auth.set_channel_requirement(LoginChannel::LocalBrowser, LoginMethod::Password, true)
            .expect("require");
        let error = auth
            .clear_password(LoginChannel::Desktop, &password_reauth("password-123"))
            .expect_err("in use");
        assert_eq!(code(&error), "LOGIN_METHOD_IN_USE");
        auth.set_channel_requirement(LoginChannel::LocalBrowser, LoginMethod::Password, false)
            .expect("stop requiring");
        let view = auth
            .clear_password(LoginChannel::Desktop, &password_reauth("password-123"))
            .expect("clear");
        assert!(!view.password_configured);
    }

    #[test]
    fn changing_settings_needs_the_current_password_once_one_exists() {
        let directory = tempfile::tempdir().expect("tempdir");
        let auth = open(directory.path());
        auth.set_password(
            LoginChannel::Desktop,
            Some("shin"),
            "password-123",
            &Reauth::default(),
        )
        .expect("first password needs no reauth");
        let error = auth
            .set_password(
                LoginChannel::Desktop,
                None,
                "password-456",
                &Reauth::default(),
            )
            .expect_err("missing reauth");
        assert_eq!(code(&error), "LOGIN_REAUTH_REQUIRED");
        let error = auth
            .set_password(
                LoginChannel::Desktop,
                None,
                "password-456",
                &password_reauth("nope-nope"),
            )
            .expect_err("wrong reauth");
        assert_eq!(code(&error), "LOGIN_REAUTH_INVALID");
        auth.set_password(
            LoginChannel::Desktop,
            None,
            "password-456",
            &password_reauth("password-123"),
        )
        .expect("changed");
        let error = auth
            .set_user_id(LoginChannel::Desktop, "other", &Reauth::default())
            .expect_err("user id change needs reauth");
        assert_eq!(code(&error), "LOGIN_REAUTH_REQUIRED");
        assert!(auth
            .set_user_id(
                LoginChannel::Desktop,
                "other",
                &password_reauth("password-456")
            )
            .is_ok());
        // 길이·제어 문자 규칙.
        assert_eq!(
            code(
                &auth
                    .set_password(
                        LoginChannel::Desktop,
                        None,
                        "short",
                        &password_reauth("password-456")
                    )
                    .expect_err("too short")
            ),
            "LOGIN_PASSWORD_INVALID"
        );
        assert_eq!(
            code(
                &auth
                    .set_user_id(
                        LoginChannel::Desktop,
                        "a\tb",
                        &password_reauth("password-456")
                    )
                    .expect_err("control char")
            ),
            "LOGIN_USER_ID_INVALID"
        );
    }

    #[test]
    fn otp_enrolls_only_after_a_valid_code_and_falls_back_to_a_private_file() {
        let directory = tempfile::tempdir().expect("tempdir");
        let clock = Arc::new(AtomicI64::new(NOW));
        let auth = open_with_clock(directory.path(), clock.clone());
        let setup = auth
            .begin_otp_setup_at(LoginChannel::Desktop, &Reauth::default(), NOW)
            .expect("begin");
        assert!(setup
            .otpauth_url
            .starts_with("otpauth://totp/Agent%20Manager:"));
        assert!(setup.qr_svg.contains("</svg>"));
        assert!(!auth.settings_view().expect("view").otp_configured);
        assert!(!directory.path().join(LOGIN_OTP_SECRET_FILE_NAME).exists());

        let error = auth
            .confirm_otp_setup_at("000000", NOW)
            .expect_err("wrong code");
        assert!(matches!(
            code(&error),
            "LOGIN_OTP_CODE_INVALID" | "LOGIN_OTP_SETUP_EXPIRED"
        ));
        let error = auth
            .confirm_otp_setup_at("000000", NOW + OTP_SETUP_TTL_MS + 1)
            .expect_err("expired");
        assert_eq!(code(&error), "LOGIN_OTP_SETUP_EXPIRED");
        assert_eq!(
            code(&auth.confirm_otp_setup_at("000000", NOW).expect_err("gone")),
            "LOGIN_OTP_SETUP_MISSING"
        );

        let secret = enroll_otp(&auth, &Reauth::default());
        let view = auth.settings_view().expect("view");
        assert!(view.otp_configured);
        assert_eq!(view.otp_secret_storage, Some(OtpSecretStorage::File));
        let file = directory.path().join(LOGIN_OTP_SECRET_FILE_NAME);
        assert_eq!(
            fs::read_to_string(&file).expect("secret file").trim(),
            login_totp::base32_encode(&secret)
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&file).expect("meta").permissions().mode() & 0o777,
                0o600
            );
        }

        // OTP 단독 로그인. 같은 코드는 두 번 쓰이지 않는다.
        auth.set_channel_requirement(LoginChannel::Remote, LoginMethod::Otp, true)
            .expect("require otp");
        let later = NOW + 2 * 60 * 1000;
        let step = login_totp::current_step((later / 1000) as u64);
        let code_now = format!("{:06}", login_totp::totp_code(&secret, step));
        assert!(auth
            .authenticate_at(LoginChannel::Remote, None, None, Some(&code_now), "", later)
            .is_ok());
        assert_eq!(
            code(
                &auth
                    .authenticate_at(LoginChannel::Remote, None, None, Some(&code_now), "", later)
                    .expect_err("replay")
            ),
            "LOGIN_INVALID"
        );

        // 해제는 채널에서 먼저 꺼야 하고, 재인증은 OTP로 한다(비밀번호가 없으므로).
        // 재인증도 스텝을 소비하므로 시계를 한 창씩 민다.
        clock.store(later + 30_000, Ordering::SeqCst);
        let reauth = Reauth {
            current_password: None,
            current_otp: Some(format!("{:06}", login_totp::totp_code(&secret, step + 1))),
        };
        assert_eq!(
            code(
                &auth
                    .disable_otp(LoginChannel::Desktop, &reauth)
                    .expect_err("in use")
            ),
            "LOGIN_METHOD_IN_USE"
        );
        auth.set_channel_requirement(LoginChannel::Remote, LoginMethod::Otp, false)
            .expect("stop requiring");
        clock.store(later + 60_000, Ordering::SeqCst);
        let reauth = Reauth {
            current_password: None,
            current_otp: Some(format!("{:06}", login_totp::totp_code(&secret, step + 2))),
        };
        auth.disable_otp(LoginChannel::Desktop, &reauth)
            .expect("disable");
        assert!(!file.exists());
        assert!(!auth.settings_view().expect("view").otp_configured);
    }

    #[test]
    fn c20_2_an_otp_code_consumed_by_reauthentication_stays_consumed_after_a_restart() {
        let directory = tempfile::tempdir().expect("tempdir");
        let auth = open(directory.path());
        let secret = enroll_otp(&auth, &Reauth::default());
        let later = NOW + 2 * 60 * 1000;
        let step = login_totp::current_step((later / 1000) as u64);
        let reauth = Reauth {
            current_password: None,
            current_otp: Some(format!("{:06}", login_totp::totp_code(&secret, step))),
        };
        // 재인증만 하고 아무것도 저장하지 않는 호출.
        auth.begin_otp_setup_at(LoginChannel::Desktop, &reauth, later)
            .expect("reauth with otp");
        drop(auth);

        let reopened = open(directory.path());
        let error = reopened
            .begin_otp_setup_at(LoginChannel::Desktop, &reauth, later)
            .expect_err("replayed code after restart");
        assert_eq!(code(&error), "LOGIN_REAUTH_INVALID");
    }

    #[test]
    fn repeated_failures_lock_the_channel_and_reset_clears_everything() {
        let directory = tempfile::tempdir().expect("tempdir");
        let auth = open(directory.path());
        auth.set_password(
            LoginChannel::Desktop,
            Some("shin"),
            "password-123",
            &Reauth::default(),
        )
        .expect("set password");
        auth.set_channel_requirement(LoginChannel::Remote, LoginMethod::Password, true)
            .expect("require");
        for _ in 0..5 {
            let _ = auth.authenticate_at(
                LoginChannel::Remote,
                Some("shin"),
                Some("bad-bad-bad"),
                None,
                "",
                NOW,
            );
        }
        let error = auth
            .authenticate_at(
                LoginChannel::Remote,
                Some("shin"),
                Some("password-123"),
                None,
                "",
                NOW,
            )
            .expect_err("locked");
        assert_eq!(code(&error), "LOGIN_LOCKED");
        assert!(auth
            .authenticate_at(
                LoginChannel::Remote,
                Some("shin"),
                Some("password-123"),
                None,
                "",
                NOW + 31_000
            )
            .is_ok());

        let removed = reset_login_files(directory.path()).expect("reset");
        assert!(removed.contains(&LOGIN_SETTINGS_FILE_NAME.to_owned()));
        assert!(removed.contains(&crate::login_sessions::LOGIN_SESSIONS_FILE_NAME.to_owned()));
        let reopened = open(directory.path());
        assert!(!reopened.requirement(LoginChannel::Remote).any());
        assert!(!reopened.settings_view().expect("view").password_configured);
    }

    #[test]
    fn loopback_asset_requirement_is_the_weaker_of_the_two_loopback_channels() {
        let directory = tempfile::tempdir().expect("tempdir");
        let auth = open(directory.path());
        auth.set_password(
            LoginChannel::Desktop,
            Some("shin"),
            "password-123",
            &Reauth::default(),
        )
        .expect("set password");
        auth.set_channel_requirement(LoginChannel::Desktop, LoginMethod::Password, true)
            .expect("desktop");
        assert!(!auth.loopback_asset_requirement().any());
        auth.set_channel_requirement(LoginChannel::LocalBrowser, LoginMethod::Password, true)
            .expect("local browser");
        assert!(auth.loopback_asset_requirement().password);
    }

    #[test]
    fn settings_survive_a_reopen_and_unknown_versions_are_refused() {
        let directory = tempfile::tempdir().expect("tempdir");
        {
            let auth = open(directory.path());
            auth.set_password(
                LoginChannel::Desktop,
                Some("shin"),
                "password-123",
                &Reauth::default(),
            )
            .expect("set password");
            auth.set_channel_requirement(LoginChannel::LocalBrowser, LoginMethod::Password, true)
                .expect("require");
        }
        let auth = open(directory.path());
        assert!(auth.requirement(LoginChannel::LocalBrowser).password);
        assert_eq!(auth.settings_view().expect("view").user_id, "shin");

        fs::write(
            directory.path().join(LOGIN_SETTINGS_FILE_NAME),
            r#"{"schemaVersion":7}"#,
        )
        .expect("write");
        assert!(matches!(
            LoginAuth::open_with(
                directory.path(),
                KeychainMode::Unavailable,
                Arc::new(|| NOW)
            ),
            Err(CoreError::Conflict(_))
        ));
    }
}
