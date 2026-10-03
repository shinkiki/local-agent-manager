use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::collections::HashSet;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::ops::ControlFlow;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use fs4::FileExt;
use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::header::{
    HeaderMap, HeaderValue, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE, RETRY_AFTER, USER_AGENT,
};
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

use crate::app_data_file::{open_private_file, replace_file, sync_dir, write_private_json};
use crate::clock::now_ms;
use crate::credential_profiles::{self, ProbeOutcome};
use crate::domain::wire_enum;
use crate::os_keychain::ensure_profile_keychain;
/// OS 보안 저장소 통로는 `os_keychain`이 쥔다. 외부 플러그인·DB 접속처럼 계정이 아닌
/// 비밀도 예전부터 이 이름으로 들어오므로, 호출부를 흔들지 않도록 여기서 다시 내보낸다.
pub(crate) use crate::os_keychain::{
    delete_os_keychain_password, read_os_keychain_password, write_os_keychain_password,
};
#[cfg(target_os = "macos")]
use crate::os_keychain::{
    macos_keychain_failure, macos_keychain_item_not_found, read_os_keychain_password_with_timeout,
    run_macos_security, KEYCHAIN_COMMAND_TIMEOUT,
};
use crate::user_home;
use crate::{CoreError, ProviderId};

const REGISTRY_FILE: &str = "provider-accounts-v1.json";
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
/// Codex app-server의 사용량 응답 한 줄 상한. 공급자 원문을 무제한으로 메모리에
/// 올리지 않으며, 정상 rate-limit 스냅샷보다 충분히 크게 둔다.
const CODEX_USAGE_RPC_LINE_LIMIT: usize = 512 * 1024;
const CLAUDE_OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
/// 공식 Claude Code CLI가 사용하는 공개 OAuth 클라이언트 ID.
const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// 만료 직전 토큰으로 호출해 401을 받기 전에 미리 갱신하도록 여유를 둔다.
const CLAUDE_TOKEN_EXPIRY_MARGIN_MS: i64 = 5 * 60_000;
const USAGE_ERROR_RETRY_MS: i64 = 5 * 60_000;
const CLAUDE_RATE_LIMIT_MIN_RETRY_MS: i64 = 30_000;
const CLAUDE_RATE_LIMIT_DEFAULT_RETRY_MS: i64 = 15 * 60_000;
/// 토큰 갱신 제한이 이어질 때 재시도 간격의 상한. 이보다 길게 미루면 제한이 풀린 뒤에도
/// 계정이 오래 낡은 채로 남는다.
const CLAUDE_REFRESH_BACKOFF_MAX_MS: i64 = 6 * 60 * 60_000;
const RATE_LIMITED_STALE_THRESHOLD_MS: i64 = 24 * 60 * 60_000;
/// 자동전환 직후 같은 공급자에서 연쇄 전환이 반복되지 않도록 두는 최소 간격.
const AUTO_SWITCH_COOLDOWN_MS: i64 = 60_000;
/// 활성 계정과 런타임이 붙은 계정의 사용량 갱신 주기. 이 계정들만 사용량이 실제로
/// 올라간다. 프론트 폴링(`src/App.tsx`의 `refreshStaleAccountUsage`)과 같은 값이다.
const BUSY_USAGE_REFRESH_INTERVAL_MS: i64 = 5 * 60_000;
/// 아무것도 돌지 않는 계정의 사용량 갱신 주기. 쓰이지 않는 계정의 사용량은 올라갈 수
/// 없고 리셋으로 내려갈 뿐이라, 창 리셋 시각이 지나면 주기와 무관하게 즉시 다시 읽는다
/// (`usage_reset_elapsed_since_update`). 그 사이에는 공급자 API를 덜 두드린다.
const IDLE_USAGE_REFRESH_INTERVAL_MS: i64 = 30 * 60_000;
/// 계정별 사용자 메모의 최대 길이(문자 수). 프론트 입력 제한(`src/lib/accountNote.ts`)과 같은 값이다.
pub const ACCOUNT_NOTE_MAX_CHARS: usize = 500;

/// 사용자가 붙이는 계정 표시 이름의 최대 길이(문자 수).
pub const ACCOUNT_LABEL_MAX_CHARS: usize = 60;
#[cfg(target_os = "macos")]
const KEYCHAIN_MIGRATION_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountAuthStatus {
    Ready,
    Missing,
    Error,
}

impl AccountAuthStatus {
    pub const ALL: [Self; 3] = [Self::Ready, Self::Missing, Self::Error];
}

wire_enum!(trimmed AccountAuthStatus, "알 수 없는 계정 인증 상태입니다", {
    Ready => "ready",
    Missing => "missing",
    Error => "error",
});

/// 이 계정으로 지금 런타임을 띄울 수 있는지. 못 띄우는 이유를 "사용자가 껐다"와
/// "인증이 잠깐 풀렸다"로 나눠, 호출자가 실패로 확정할지 기다릴지 고를 수 있게 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunReadiness {
    Ready,
    /// 계정이 없거나 공급자가 다르거나 사용자가 꺼 둔 상태. 저절로 돌아오지 않는다.
    Disabled,
    /// 자격증명 확인이 실패해 인증 상태를 잃었다. 재인증하거나 다음 조회가
    /// 성공하면 돌아온다.
    NeedsReauthentication,
    /// 인증이 거부된 것이 아니라 **확인하지 못한** 상태. 토큰 갱신이 제한돼 사용량
    /// 조회가 계속 실패하면 여기에 해당한다.
    ///
    /// 이걸 [`Self::NeedsReauthentication`]과 같이 다루면 교착에 빠진다. 갱신이 막힌
    /// 자격증명을 되살리는 확인된 방법은 그 계정으로 CLI를 띄우는 것뿐인데, 실행을
    /// 막으면 CLI가 뜨지 않아 토큰이 회전하지 않고, 그러면 조회가 영영 실패해 상태가
    /// 풀리지 않는다. 그래서 `retry_after`가 지나면 막지 않고 실제로 실행해 본다.
    AuthUnverified {
        retry_after: Option<i64>,
    },
    /// 사용량이 소진돼 지금 보내면 그대로 한도 오류를 받는다. 리셋 시각이 지나거나
    /// 다음 사용량 조회가 상태를 풀면 돌아오므로, 실패가 아니라 대기로 다뤄야 한다.
    /// `resume_at`은 다시 시도해 볼 만한 가장 이른 시각이며, 공급자가 리셋 시각을
    /// 알려주지 않았으면 `None`이다.
    UsageExhausted {
        resume_at: Option<i64>,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountUsageStatus {
    #[default]
    Idle,
    Ok,
    Unavailable,
    Error,
}

impl AccountUsageStatus {
    pub const ALL: [Self; 4] = [Self::Idle, Self::Ok, Self::Unavailable, Self::Error];
}

wire_enum!(trimmed AccountUsageStatus, "알 수 없는 계정 사용량 상태입니다", {
    Idle => "idle",
    Ok => "ok",
    Unavailable => "unavailable",
    Error => "error",
});

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageWindow {
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<i64>,
    /// 특정 모델에만 걸린 창(Claude의 `limits[]` weekly_scoped). 그 모델을 쓰지 않는 실행까지
    /// 막으면 안 되므로 표시에만 쓰고 계정 대표 소진율·자동전환 판정에서는 뺀다
    /// (`governing_windows`). 옛 저장본에는 없는 필드라 기본값 false로 읽는다.
    #[serde(default)]
    pub model_scoped: bool,
    /// 모델군 창들을 합쳐 만든 계정 대표 창(Antigravity의 `5시간`·`7일`). 가장 빡빡한
    /// 모델군을 복사한 것이라 소진 판정에 그대로 넣으면 한 모델군의 소진이 계정 전체를
    /// 막는다 — `model_scoped`를 판정에서 빼 둔 이유가 대표 창을 통해 되살아난다.
    /// 화면과 대표 소진율(`tightest_window_headroom`)에는 그대로 쓰고 실행 게이트·
    /// 자동전환 판정에서만 뺀다(`account_exhausted`). 옛 저장본에는 없다.
    #[serde(default)]
    pub aggregate: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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
    /// 429가 사용량 조회가 아니라 OAuth 토큰 갱신에서 나왔는지. 토큰 갱신 제한은
    /// 남은 사용량과 무관하므로 한도 페일오버 후보 제외 사유로 쓰지 않는다.
    #[serde(default)]
    pub token_refresh_limited: bool,
    /// 토큰 갱신이 연속으로 제한된 횟수. 재시도 간격을 넓히는 데만 쓴다. 같은 간격으로
    /// 계속 재제출하면 제한이 풀릴 근거를 서버에 주지 않는다. 갱신이 성공하거나
    /// 자격증명이 바뀌면 0으로 돌아간다. 화면에는 쓰지 않는 내부 값이다.
    #[serde(default)]
    pub token_refresh_throttle_streak: u32,
    /// 계정이 들고 있는 한도 리셋 크레딧. 공급자가 주지 않으면 `None`이다.
    #[serde(default)]
    pub reset_credits: Option<AccountResetCredits>,
}

/// 소진된 한도를 즉시 되돌리는 크레딧. Codex가 사용량 응답의 `rateLimitResetCredits`로 준다.
///
/// 장수가 한정돼 있고 만료도 있으므로 목록 전체가 아니라 판단에 필요한 것만 남긴다 —
/// 지금 쓸 수 있는 장수, 가장 먼저 만료되는 시각, 공급자가 준 표시 제목.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountResetCredits {
    /// `status`가 `available`인 장수. 사용 가능 여부는 이 값으로만 판단한다.
    pub available_count: u32,
    /// 사용 가능한 크레딧 중 가장 먼저 만료되는 시각(ms). 만료가 없으면 `None`.
    pub next_expires_at: Option<i64>,
    /// 가장 먼저 만료되는 크레딧의 id. 같은 크레딧으로 소진 마감을 두 번 알리지 않으려고
    /// 기록을 맞춰 볼 때 쓴다. 크레딧이 바뀌면 id가 달라 다시 알린다.
    pub next_credit_id: Option<String>,
    /// 공급자가 준 표시 제목(예: `Full reset (Weekly + 5 hr)`).
    pub title: Option<String>,
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
    /// 사용자가 직접 붙인 표시 이름. 붙이지 않았으면 None이고, 이때 `display_name`은
    /// 공급자가 알려 준 이름을 그대로 쓴다.
    pub label: Option<String>,
    /// 공급자가 알려 준 원래 이름. 같은 사람이 여러 계정을 가지면 이 값이 겹치므로
    /// 사용자가 `label`로 구분한다.
    pub provider_display_name: String,
    /// 기본 계정인지. 새 채팅·터미널의 기본 실행 계정이고 헤더의 사용량 표시 대상이다.
    /// 자격증명과는 무관하다 — 모든 계정은 자기 격리 프로필로 실행된다.
    pub is_active: bool,
    pub disabled: bool,
    pub auto_switch: bool,
    /// 페일오버 우선순위(작은 값 먼저). 우선순위 정책에서만 쓰인다.
    pub auto_switch_priority: Option<u32>,
    pub auth_status: AccountAuthStatus,
    pub usage: AccountUsageView,
    /// 계정 레지스트리에만 저장되는 사용자 메모. 비어 있으면 None.
    pub note: Option<String>,
    /// 이 계정이 계정별 자격증명 프로필로 실행되는지. false면 공유 CLI 홈으로
    /// 실행되어 다른 계정과 동시에 요청을 보낼 수 없다.
    pub credential_isolated: bool,
    /// 프로필 격리를 쓰지 못한 이유. 격리가 살아 있으면 None.
    pub credential_isolation_note: Option<String>,
    /// 이 계정의 자격증명 사슬이 절대 만료되는 시각(ms). 회전으로는 늘어나지 않으므로
    /// 이 시각이 지나면 재인증 외에 살릴 길이 없다. 화면은 이 값으로 만료를 미리
    /// 알린다. 공급자가 만료를 밝히지 않으면 None이고, 그때는 아무것도 알리지 않는다.
    pub credential_expires_at: Option<i64>,
    /// 이 계정에 묶인 관리 런타임 수. 0이면 이 계정으로는 아무것도 돌지 않으므로
    /// 사용량이 올라갈 수 없고, 사용량 갱신을 더 뜸하게 해도 된다.
    pub runtime_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAccountStateView {
    pub provider: ProviderId,
    /// 기본 계정 id. 이름은 이 계정이 공유 CLI 홈에 적용되던 시절의 것이다.
    pub active_account_id: Option<String>,
    /// 공유 CLI 홈의 자격증명이 등록 계정 중 하나로 확인되면 그 id(홈 관측에서 온다).
    pub observed_active_account_id: Option<String>,
    pub runtime_count: usize,
    pub last_auto_switch: Option<AutoSwitchEventView>,
    /// 공유 CLI 홈에 실제로 든 자격증명의 관측 결과(홈 계정).
    pub home: ProviderHomeView,
}

/// 공유 CLI 홈(`Claude Code-credentials` Keychain 항목 또는 `~/.claude/.credentials.json`,
/// `~/.codex/auth.json`)에 실제로 든 자격증명이 누구 것인지. 데스크탑 앱과 터미널 CLI가
/// 공유하는 저장소라 앱은 관측만 한다 — 여기에 쓰지 않고, 여기서 읽은 토큰을 갱신하지도
/// 않는다. 다른 로그인의 사슬일 수 있어 회전시키면 그쪽 세션이 죽는다.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHomeView {
    pub state: HomeCredentialState,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub provider_account_id: Option<String>,
    /// 신원이 등록 계정과 같으면 그 계정 id. 미등록이거나 신원을 모르면 `None`.
    pub account_id: Option<String>,
    /// 액세스 토큰 만료 시각(Claude). 지났어도 신원이 확인된 값이면 `Verified`로 남고,
    /// 화면이 만료 사실을 덧붙인다.
    pub access_token_expires_at: Option<i64>,
    pub checked_at: Option<i64>,
    /// 신원 조회 실패 뒤 다음 시도 시각.
    pub retry_at: Option<i64>,
    pub error: Option<String>,
    /// 홈 계정의 사용량. 읽기 전용 조회로만 채운다 — 이 저장소의 토큰을 갱신하지
    /// 않으므로 액세스 토큰이 살아 있는 동안에만 값이 있다. 신원이 등록 계정과 같으면
    /// 그 계정이 이미 조회한 값을 그대로 옮긴다([`AccountSupervisor::home_view`]).
    pub usage: AccountUsageView,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HomeCredentialState {
    /// 백엔드가 아직 저장소를 읽지 않았다.
    #[default]
    Unchecked,
    /// 저장소에 자격증명이 없다.
    Absent,
    /// 신원을 확인했다.
    Verified,
    /// 액세스 토큰이 만료돼 신원을 확인할 수 없다. 앱은 이 토큰을 갱신하지 않는다.
    Expired,
    /// 신원 조회가 실패했다(네트워크·거부). `retry_at` 뒤에 다시 시도한다.
    Error,
}

impl HomeCredentialState {
    pub const ALL: [Self; 5] = [
        Self::Unchecked,
        Self::Absent,
        Self::Verified,
        Self::Expired,
        Self::Error,
    ];
}

wire_enum!(trimmed HomeCredentialState, "알 수 없는 홈 자격증명 상태입니다", {
    Unchecked => "unchecked",
    Absent => "absent",
    Verified => "verified",
    Expired => "expired",
    Error => "error",
});

/// 홈 관측의 내부 캐시. 저장소 지문이 같으면 확인한 신원을 다시 묻지 않는다.
#[derive(Debug, Clone)]
struct HomeObservation {
    /// 저장소에 든 자격증명의 지문. 없으면 `None`.
    fingerprint: Option<String>,
    view: ProviderHomeView,
    /// 저장소를 다음에 읽을 시각. Keychain 조회는 `security` 하위 프로세스라 자주 읽지 않는다.
    next_read_at: i64,
    /// 같은 저장소 값으로 이어진 신원 조회 실패 횟수. 재시도 간격을 넓히는 근거.
    error_streak: u32,
}

/// 홈 관측 한 번이 지문과 무관하게 쓰는 값들. 재사용 판정·신원 해석·뷰 조립 세 단계가
/// 같은 시각과 같은 만료 계산을 보게 묶어 둔다.
#[derive(Debug, Clone, Copy)]
struct HomeObserveContext {
    /// 액세스 토큰 만료 시각(Claude만). 이어 쓰는 관측도 이 값만은 다시 계산한다.
    access_token_expires_at: Option<i64>,
    next_read_at: i64,
    now: i64,
}

/// 지문이 그대로인 관측을 신원을 다시 묻지 않고 이어 쓸 수 있는지. 이어 쓸 수 있으면
/// 시각만 갱신한 관측을 `Break`로, 다시 물어야 하면 넘겨받은 관측을 그대로 `Continue`로
/// 돌려준다 — 호출자가 실패 횟수를 잇는 데 그 관측이 필요하다.
fn reuse_home_observation(
    previous: HomeObservation,
    context: &HomeObserveContext,
) -> ControlFlow<HomeObservation, HomeObservation> {
    match previous.view.state {
        // 같은 값이면 신원도 같다. 만료 시각만 다시 계산해 둔다.
        HomeCredentialState::Verified | HomeCredentialState::Expired => {
            ControlFlow::Break(HomeObservation {
                view: ProviderHomeView {
                    access_token_expires_at: context.access_token_expires_at,
                    checked_at: Some(context.now),
                    ..previous.view
                },
                next_read_at: context.next_read_at,
                ..previous
            })
        }
        HomeCredentialState::Error
            if previous
                .view
                .retry_at
                .is_some_and(|retry_at| retry_at > context.now) =>
        {
            ControlFlow::Break(HomeObservation {
                next_read_at: context.next_read_at,
                ..previous
            })
        }
        _ => ControlFlow::Continue(previous),
    }
}

/// 한도 페일오버가 다음 계정을 고르는 방식. 세 방식 모두 자동전환이 켜져 있고
/// 사용 가능하며 한도에 걸리지 않은 계정만 후보로 본다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoSwitchPolicy {
    /// 사용자가 계정마다 지정한 우선순위(작은 값 먼저). 값이 없는 계정은 뒤로 밀고
    /// 같은 값끼리는 등록 순으로 본다.
    Priority,
    /// 사용량 여유가 가장 많은 계정 먼저. 아직 사용량을 읽지 못한 계정은 판단
    /// 근거가 없으므로 여유를 아는 계정 뒤에 둔다.
    #[default]
    MaxHeadroom,
    /// 등록 순 라운드로빈. 현재 계정 다음부터 순환한다.
    Registration,
}

impl AutoSwitchPolicy {
    pub const ALL: [Self; 3] = [Self::Priority, Self::MaxHeadroom, Self::Registration];
}

wire_enum!(trimmed AutoSwitchPolicy, "알 수 없는 자동전환 정책입니다", {
    Priority => "priority",
    MaxHeadroom => "maxHeadroom",
    Registration => "registration",
});

/// 세션을 이어갈 때 실행 계정을 고르는 방식. 어느 방식이든 세션에 고정된 계정
/// (`SessionMeta::pinned_account_id`)이 있으면 그 계정이 먼저다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResumeAccountPolicy {
    /// 현재 활성 계정으로 이어간다. 지난 실행 계정이 무엇이었든 지금 쓰는 계정을
    /// 쓰므로, 활성 계정을 바꾸면 이어가는 세션도 함께 옮겨진다.
    #[default]
    ActiveAccount,
    /// 그 세션이 마지막으로 실행된 계정으로 이어간다. 기록이 없으면 세션을 만든
    /// 계정, 그것도 없으면 활성 계정을 쓴다. 세션별 사용량 귀속이 어긋나지 않지만,
    /// 활성 계정을 바꿔도 기존 세션은 이전 계정 한도를 계속 쓴다.
    LastUsedAccount,
}

impl ResumeAccountPolicy {
    pub const ALL: [Self; 2] = [Self::ActiveAccount, Self::LastUsedAccount];
}

wire_enum!(trimmed ResumeAccountPolicy, "알 수 없는 세션 재개 계정 정책입니다", {
    ActiveAccount => "activeAccount",
    LastUsedAccount => "lastUsedAccount",
});

/// 자동전환 트리거 종류. 사용량 100% 도달, 계정 간 사용량 격차 도달, 또는 에이전트
/// 세션의 제한 응답.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoSwitchReason {
    UsageExhausted,
    /// 가장 덜 쓴 계정과의 사용량 격차가 설정 폭을 넘어 다음 계정으로 순환한다.
    /// 아직 쓸 수 있는 상태라 실행 중인 턴은 끊지 않고, 유휴 세션과 새 채팅 계정만
    /// 옮긴다.
    UsageSpread,
    AgentLimited,
}

impl AutoSwitchReason {
    pub const ALL: [Self; 3] = [Self::UsageExhausted, Self::UsageSpread, Self::AgentLimited];

    /// 알림 문구에 붙는 트리거 설명. 프런트 `autoSwitchReasonLabel`과 같은 낱말이어야
    /// 설정 화면의 전환 이력과 알림창이 같은 사건을 다르게 부르지 않는다.
    pub fn label(self) -> &'static str {
        match self {
            Self::UsageExhausted => "사용량 100% 도달",
            Self::UsageSpread => "사용량 격차 도달",
            Self::AgentLimited => "에이전트 제한 응답",
        }
    }
}

wire_enum!(trimmed AutoSwitchReason, "알 수 없는 자동전환 트리거 사유입니다", {
    UsageExhausted => "usageExhausted",
    UsageSpread => "usageSpread",
    AgentLimited => "agentLimited",
});

/// 자동전환 실행기(spawn_auto_switch_loop)로 전달되는 트리거 신호.
#[derive(Debug, Clone)]
pub struct AutoSwitchSignal {
    pub provider: ProviderId,
    pub account_id: String,
    pub reason: AutoSwitchReason,
    /// 한도 응답을 받은 채팅. 자격증명이 계정별로 갈려 있으면 이 채팅만 다른 계정에
    /// 다시 묶고 나머지 세션은 건드리지 않는다. 사용량 100% 트리거처럼 채팅을
    /// 특정할 수 없으면 None이며, 그때는 해당 계정에 묶인 세션 전체가 대상이다.
    pub chat_id: Option<String>,
    /// 이 전환이 살려야 하는 실행들의 모델. 모델군마다 쿼터가 따로인 공급자에서 **어느
    /// 모델군을 위한 전환인지**를 말해 준다([`model_scoped_windows`]).
    ///
    /// 한도 응답(`AgentLimited`)은 그 실행의 모델 하나를 싣는다 — 사용량에서 거꾸로 짚는
    /// 방법([`model_group_partition`])은 한 박자 늦어, 한도 응답 직후에는 아직 100%가 보이지
    /// 않는다. 사용량 조회에서 온 트리거는 계정 감독자가 채울 수 없고, 전환 루프가 그 계정에
    /// 묶인 살아 있는 세션들의 모델로 채운다(`session_management::handle_auto_switch_signal`).
    /// 비어 있으면 무엇을 하려던 참인지 모르는 전환이다.
    pub models: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSwitchEventView {
    pub from_account_id: String,
    /// 실제로 움직인 쪽의 목적지. 기본 계정이 옮겨졌으면 그곳이고, 기본 계정은 그대로인데
    /// 세션만 옮겨졌으면 세션이 간 곳이다 — 어느 쪽인지는 `default_rotated`가 말한다.
    pub to_account_id: String,
    pub reason: AutoSwitchReason,
    pub at: i64,
    /// 전환 직후 resume으로 재시작한 채팅 세션 수.
    pub resumed_session_count: usize,
    /// 기본 계정이 `to_account_id`로 바뀌었는지. 거짓이면 세션만 옮겨졌고 새 대화가 열리는
    /// 자리는 그대로다 — 계획이 본 기본 계정을 그 사이 사용자가 바꿨거나, 지정 계정이 기본
    /// 계정이 아니었거나, 회전 목적지가 없었다. 프런트는 값이 없는 옛 요약을 참으로 읽는다.
    pub default_rotated: bool,
    /// 세션들이 옮겨 간 계정이 `to_account_id`와 다를 때만 있다. 기본 계정은 열린 모델군을
    /// 잃지 않는 곳으로, 세션은 자기 모델군이 남은 곳으로 각각 가므로 둘이 갈릴 수 있다 —
    /// 화면이 "A → B · 세션 2개 복원"으로 세션까지 B로 갔다고 읽지 않게 한다. 이 규칙의 주인은
    /// [`AccountSupervisor::record_auto_switch`] 하나다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions_to_account_id: Option<String>,
}

/// 채팅 런타임에 주입할 계정별 자격증명 프로필. 공급자 홈은 공유한 채 자격증명만
/// 갈라내므로, 서로 다른 계정에 묶인 세션이 같은 트랜스크립트·스킬 위에서 동시에
/// 요청을 보낼 수 있다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeCredentialProfile {
    pub provider: ProviderId,
    pub account_id: String,
    pub dir: PathBuf,
    /// 프로세스에 그대로 넣을 환경변수 쌍.
    pub env: Vec<(String, String)>,
}

/// 계정별 프로필 준비 결과 캐시. 프로브는 계정마다 한 번만 돌리고, 실패하면 그
/// 이유를 남긴 채 공유 홈 동작으로 되돌린다.
enum CredentialProfileEntry {
    Ready {
        dir: PathBuf,
        env: Vec<(String, String)>,
        /// 이 시각이 지나면 성공 판정도 다시 확인한다. 프로브는 자격증명이 있는지만
        /// 답하고 그 토큰이 아직 살아 있는지는 답하지 않아서, 영구 캐시하면 사슬이
        /// 끊긴 뒤에도 실행 허가가 계속 나가고 반복 실행 회차가 인증 오류로 소진된다.
        verified_at: i64,
    },
    Unsupported {
        reason: String,
        /// 이 시각이 지나면 프로브를 다시 돌린다. 실패 사유는 CLI 경로 탐지
        /// 실패나 자격증명 저장소 접근 거부처럼 되돌아오는 것들이라, 계속
        /// 캐시하면 원인을 고쳐도 앱을 재시작할 때까지 격리로 못 돌아온다.
        retry_at: i64,
    },
}

/// 캐시가 답한 준비 결과. [`CredentialProfileEntry`]와 달리 시각 판정을 이미 끝낸
/// 값이라, 읽는 쪽은 "지금 쓸 수 있는가"만 보면 된다.
enum CachedCredentialProfile {
    Ready {
        dir: PathBuf,
        env: Vec<(String, String)>,
    },
    /// 격리 불가 판정이 아직 재시도 시각 전이다.
    Unsupported,
}

/// 격리 실패를 다시 확인하기까지 기다리는 시간. 실패 상태에서 매 요청마다 CLI를
/// 띄우지는 않으면서, 원인을 고친 뒤 다음 반복 실행이나 채팅 시작에서 회복된다.
const CREDENTIAL_PROFILE_RETRY_MS: i64 = 5 * 60 * 1_000;
/// 공유 CLI 홈 저장소를 다시 읽기까지의 최소 간격. Keychain 조회가 하위 프로세스라
/// 스냅샷 폴링마다 돌릴 수 없다.
const HOME_OBSERVE_INTERVAL_MS: i64 = 60_000;
/// 홈 신원 조회가 실패한 뒤 첫 재시도까지의 대기. 실패가 이어지면 두 배씩 늘어난다.
/// 만료 토큰이 401을 내는 상태를 5분마다 두드리던 옛 사용량 갱신의 실수를 반복하지 않는다.
const HOME_IDENTITY_RETRY_BASE_MS: i64 = 30 * 60_000;
const HOME_IDENTITY_RETRY_MAX_MS: i64 = 6 * 60 * 60_000;

/// 성공 판정을 다시 확인하기까지 기다리는 시간. 실패 재시도보다 길게 둬서 연달아
/// 시작하는 채팅마다 CLI를 띄우지는 않으면서, 사슬이 끊긴 프로필이 무기한 초록불을
/// 유지하지는 못하게 한다.
const CREDENTIAL_PROFILE_READY_TTL_MS: i64 = 30 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    pub accounts: Vec<ProviderAccountView>,
    pub providers: Vec<ProviderAccountStateView>,
    /// 자동전환으로 종료된 실행 중 채팅을 새 계정에서 resume으로 재시작할지 여부.
    pub auto_switch_resume: bool,
    /// 한도 페일오버가 다음 계정을 고르는 방식.
    pub auto_switch_policy: AutoSwitchPolicy,
    /// 활성 계정이 가장 덜 쓴 계정보다 이 폭(%p)만큼 앞서면 다음 계정으로 순환한다.
    /// None이면 지금까지처럼 100% 도달과 에이전트 제한 응답만 페일오버를 부른다.
    pub auto_switch_usage_gap_percent: Option<u8>,
    /// 세션을 이어갈 때 실행 계정을 고르는 방식.
    pub resume_account_policy: ResumeAccountPolicy,
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
    /// 페일오버 우선순위(작은 값 먼저). `AutoSwitchPolicy::Priority`에서만 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auto_switch_priority: Option<u32>,
    auth_status: AccountAuthStatus,
    usage: AccountUsageView,
    /// 사용자가 계정에 남긴 메모. 이전 버전 레지스트리에는 필드가 없다.
    #[serde(default)]
    note: Option<String>,
    /// 사용자가 붙인 표시 이름. 공급자 재조회로 `display_name`이 갱신돼도 이 값은
    /// 건드리지 않으므로, 같은 이름을 쓰는 계정을 사용자가 구분해 둘 수 있다.
    /// 이전 버전 레지스트리에는 필드가 없다.
    #[serde(default)]
    label: Option<String>,
    /// 자격증명 사슬의 절대 만료 시각(ms). 사용량을 조회할 때마다 저장된 자격증명에서
    /// 다시 읽는다. 값이 없으면 공급자가 만료를 밝히지 않았거나 아직 한 번도 조회하지
    /// 않은 것이다. 이전 버전 레지스트리에는 필드가 없다.
    #[serde(default)]
    credential_expires_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderAccountState {
    provider: ProviderId,
    /// 기본 계정. 이름은 이 계정이 공유 CLI 홈에 적용되던 시절의 것이다.
    active_account_id: Option<String>,
    /// 기본 계정과 활성 계정이 갈려 있던 이전 레지스트리의 값. 읽을 때 활성 계정이
    /// 비어 있으면 그 자리를 채우는 데만 쓰고 다시 저장하지 않는다.
    #[serde(default, rename = "defaultAccountId", skip_serializing)]
    legacy_default_account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountRegistry {
    schema_version: u32,
    #[serde(default = "legacy_credential_vault_version")]
    credential_vault_version: u32,
    #[serde(default = "default_auto_switch_resume")]
    auto_switch_resume: bool,
    /// 페일오버 후보 선택 방식. 이전 버전 레지스트리에는 필드가 없다.
    #[serde(default)]
    auto_switch_policy: AutoSwitchPolicy,
    /// 사용량 분산 교체 폭(%p). 이전 버전 레지스트리에는 필드가 없고, None이면 끈 것이다.
    /// alias는 이 설정이 절대 사용률 임계치이던 시절의 이름이다. 뜻이 "몇 %에 닿으면"에서
    /// "몇 %p 앞서면"으로 바뀌었지만 사용자가 고른 폭은 그대로 이어 준다.
    #[serde(
        default,
        alias = "autoSwitchUsageThresholdPercent",
        skip_serializing_if = "Option::is_none"
    )]
    auto_switch_usage_gap_percent: Option<u8>,
    /// 이어가기 계정 선택 방식. 이전 버전 레지스트리에는 필드가 없다.
    #[serde(default)]
    resume_account_policy: ResumeAccountPolicy,
    accounts: Vec<AccountRecord>,
    providers: Vec<ProviderAccountState>,
}

impl AccountRegistry {
    fn empty() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            credential_vault_version: CREDENTIAL_VAULT_VERSION,
            auto_switch_resume: default_auto_switch_resume(),
            auto_switch_policy: AutoSwitchPolicy::default(),
            auto_switch_usage_gap_percent: None,
            resume_account_policy: ResumeAccountPolicy::default(),
            accounts: Vec::new(),
            providers: managed_providers()
                .into_iter()
                .map(|provider| ProviderAccountState {
                    provider,
                    active_account_id: None,
                    legacy_default_account_id: None,
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

#[derive(Debug, Clone)]
struct AccountLoginSession {
    id: String,
    provider: ProviderId,
    account_id: Option<String>,
    profile_path: PathBuf,
}

struct AccountState {
    registry: AccountRegistry,
    runtime_counts: HashMap<ProviderId, usize>,
    runtime_account_counts: HashMap<String, usize>,
    observed_active_account_ids: HashMap<ProviderId, Option<String>>,
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
        with_vault_file_lock(&self.lock_path, || {
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
        })
    }

    fn with_document<T>(
        &self,
        mutate: bool,
        action: impl FnOnce(&mut CredentialVaultDocument) -> Result<T, CoreError>,
    ) -> Result<T, CoreError> {
        let _operation = lock(&self.operation_lock, "자격증명 Vault 작업")?;
        with_vault_file_lock(&self.lock_path, || {
            let mut document = load_vault_document(self.store.as_ref())?;
            let result = action(&mut document)?;
            if mutate {
                save_vault_document(self.store.as_ref(), &document)?;
            }
            Ok(result)
        })
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

/// 자격증명 Vault 잠금 파일에 배타 잠금을 잡고 `action`을 돌린 뒤 해제한다. 해제
/// 실패는 삼키지 않는다 — Vault는 다시 만들 수 없는 원본이라, 잠금이 남은 채 성공을
/// 보고하면 다음 작업이 영원히 기다리게 된다. 그래서 `Drop` 가드(`store_lock`) 대신
/// 작업 결과와 해제 결과를 합쳐 돌려주는 이 형태를 쓴다.
fn with_vault_file_lock<T>(
    lock_path: &Path,
    action: impl FnOnce() -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    let file = open_private_file(lock_path, false)?;
    FileExt::lock(&file)?;
    let result = action();
    let unlock = FileExt::unlock(&file).map_err(CoreError::from);
    match (result, unlock) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
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

// v2 Keychain Vault 마이그레이션에서만 부른다. 그 경로가 macOS 전용이라 함께 게이트한다.
#[cfg(target_os = "macos")]
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

/// 프로필 격리가 실제로 먹는지 공급자 CLI에 물어보는 프로브. 실행 경로 탐색까지
/// 포함하므로, 테스트는 CLI를 띄우지 않는 구현을 끼운다.
pub(crate) type CredentialProbe =
    dyn Fn(ProviderId, &[(String, String)]) -> ProbeOutcome + Send + Sync + 'static;

struct AccountOpenConfig {
    codex_home_dir: PathBuf,
    claude_config_dir: PathBuf,
    claude_keychain_profile: Option<PathBuf>,
    inspect_external_processes: bool,
    claude_identity_resolver: Arc<ClaudeIdentityResolver>,
    credential_probe: Arc<CredentialProbe>,
}

struct AccountInner {
    app_data_dir: PathBuf,
    home_dir: PathBuf,
    codex_home_dir: PathBuf,
    claude_config_dir: PathBuf,
    /// Antigravity 공유 홈. CLI가 홈 아래 `.gemini`만 보고 이 경로를 옮기는 문서화된
    /// 변수가 없어, 사용자 홈에서 그대로 유도한다(G8).
    antigravity_gemini_dir: PathBuf,
    claude_keychain_profile: Option<PathBuf>,
    inspect_external_processes: bool,
    vault: Arc<dyn CredentialVault>,
    claude_identity_resolver: Arc<ClaudeIdentityResolver>,
    credential_probe: Arc<CredentialProbe>,
    codex_switch_lock: Mutex<()>,
    claude_switch_lock: Mutex<()>,
    antigravity_switch_lock: Mutex<()>,
    /// 계정별 사용량 갱신 락. 같은 계정의 수동·자동 새로고침이 같은 일회성 갱신
    /// 토큰을 동시에 소비하지 않게 막되, 서로 다른 계정은 동시에 조회한다.
    usage_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    auto_switch_tx: Mutex<Option<Sender<AutoSwitchSignal>>>,
    /// 계정별 자격증명 프로필 준비 결과. 키는 계정 id다.
    credential_profiles: Mutex<HashMap<String, CredentialProfileEntry>>,
    /// 공급자별 공유 CLI 홈 관측 결과. 잠금 순서는 계정 상태 → 홈 관측이다.
    home_observations: Mutex<HashMap<ProviderId, HomeObservation>>,
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

/// 계정에 귀속되지 않는 관리 터미널의 실행 성격. 공유 CLI 홈에서 실행되는 설정
/// 터미널과, 임시 프로필로 격리되어 공유 자격증명을 읽지도 쓰지도 않는 계정 로그인
/// 터미널을 구분한다.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnscopedRuntimeKind {
    SharedHome,
    IsolatedLogin,
}

/// 공급자 CLI를 실제로 띄워 프로필 격리가 먹는지 확인한다.
fn os_credential_probe(provider: ProviderId, env: &[(String, String)]) -> ProbeOutcome {
    match probe_executable(provider) {
        Some(executable) => credential_profiles::probe_profile(provider, &executable, env),
        None => ProbeOutcome::Unavailable("공급자 CLI를 찾지 못했습니다".to_owned()),
    }
}

/// 테스트 기본 프로브. CLI를 띄우지 않으므로 격리는 항상 공유 홈으로 되돌아간다.
#[cfg(test)]
fn unavailable_credential_probe(_provider: ProviderId, _env: &[(String, String)]) -> ProbeOutcome {
    ProbeOutcome::Unavailable("테스트에서는 CLI 프로브를 실행하지 않습니다".to_owned())
}

/// 테스트 기본 프로브. 등록 계정은 격리 프로필로만 실행되므로, 격리가 준비된다고 답해야
/// 런타임을 시작하는 테스트가 돈다. 격리 실패를 보는 테스트는
/// [`unavailable_credential_probe`]를 직접 넘긴다.
#[cfg(test)]
fn ready_credential_probe(_provider: ProviderId, _env: &[(String, String)]) -> ProbeOutcome {
    ProbeOutcome::Ready
}

/// 프로브에 쓸 CLI 실행 파일. 탐지에 실패하면 프로필 격리를 쓰지 않는다.
fn probe_executable(provider: ProviderId) -> Option<PathBuf> {
    crate::inspect_local_environment()
        .ok()?
        .providers
        .into_iter()
        .find(|status| status.provider == provider)
        .and_then(|status| status.cli.path)
        .and_then(|path| crate::path_guard::canonical_child_facing(path).ok())
        .filter(|path| path.is_file())
}

impl AccountSupervisor {
    pub fn open(app_data_dir: impl AsRef<Path>) -> Result<Self, CoreError> {
        let home_dir = user_home::home_dir()?;
        // 이 변수들은 앱이 CLI 자식에게 계정 격리를 주려고 넣는 값이기도 하다. 백엔드가
        // 에이전트 세션(=이 앱이 띄운 채팅의 자식 셸)에서 재기동되면 그 값을 도로
        // 물려받아, 자신의 격리 프로필을 공유 홈으로 삼는 자기참조가 된다. 그러면 활성
        // 계정 동기화가 프로필 사본만 보고, 계정 전환이 남의 프로필을 오염시킨다
        // (2026-08-27 실측). 자기 프로필 루트 안을 가리키는 값은 버리고 기본 경로로
        // 돌아간다. 그 밖의 값은 정당한 커스텀일 수 있어 존중하되 아래에서 실효 경로를
        // 한 줄 남겨, 어긋난 홈을 로그 한 번으로 찾을 수 있게 한다.
        let profile_root = app_data_dir
            .as_ref()
            .join(credential_profiles::PROFILE_ROOT);
        let codex_home_dir =
            env_path_unless_self_referential(credential_profiles::CODEX_HOME, &profile_root)
                .unwrap_or_else(|| home_dir.join(".codex"));
        // 설정 경로와 자격증명 저장소는 서로 다른 환경변수가 정한다.
        // `CLAUDE_SECURESTORAGE_CONFIG_DIR`이 있으면 CLI는 그 경로로 Keychain 서비스명을
        // 만들므로, 앱도 같은 값을 봐야 CLI가 실제로 읽고 쓰는 항목을 찾는다. 그 값이
        // 없을 때만 `CLAUDE_CONFIG_DIR`이 저장소까지 함께 정한다.
        let claude_config_override =
            env_path_unless_self_referential(credential_profiles::CLAUDE_CONFIG_DIR, &profile_root);
        let claude_keychain_profile = env_path_unless_self_referential(
            credential_profiles::CLAUDE_SECURESTORAGE_CONFIG_DIR,
            &profile_root,
        )
        .or_else(|| claude_config_override.clone());
        let claude_config_dir = claude_config_override.unwrap_or_else(|| home_dir.join(".claude"));
        eprintln!(
            "[accounts] 공급자 홈: codex={} claude 설정={} claude 저장소 프로필={}",
            codex_home_dir.display(),
            claude_config_dir.display(),
            claude_keychain_profile
                .as_deref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "기본".to_owned()),
        );
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
                credential_probe: Arc::new(os_credential_probe),
            },
        )
    }

    #[cfg(test)]
    fn open_with(
        app_data_dir: &Path,
        home_dir: &Path,
        vault: Arc<dyn CredentialVault>,
    ) -> Result<Self, CoreError> {
        Self::open_with_credential_probe(
            app_data_dir,
            home_dir,
            vault,
            Arc::new(ready_credential_probe),
        )
    }

    /// 프로필 격리 프로브를 끼운 테스트 감독자. 프로브는 공급자 CLI를 실제로 띄우므로
    /// 기계 상태에 따라 결과가 달라진다. 격리가 되는·안 되는 두 경우를 모두 재현하려면
    /// 이 자리에서 결과를 정해야 한다.
    #[cfg(test)]
    fn open_with_credential_probe(
        app_data_dir: &Path,
        home_dir: &Path,
        vault: Arc<dyn CredentialVault>,
        credential_probe: Arc<CredentialProbe>,
    ) -> Result<Self, CoreError> {
        Self::open_with_probe_and_claude_identity_resolver(
            app_data_dir,
            home_dir,
            vault,
            credential_probe,
            Arc::new(claude_identity_from_secret),
        )
    }

    #[cfg(test)]
    fn open_with_claude_identity_resolver(
        app_data_dir: &Path,
        home_dir: &Path,
        vault: Arc<dyn CredentialVault>,
        claude_identity_resolver: Arc<ClaudeIdentityResolver>,
    ) -> Result<Self, CoreError> {
        Self::open_with_probe_and_claude_identity_resolver(
            app_data_dir,
            home_dir,
            vault,
            Arc::new(unavailable_credential_probe),
            claude_identity_resolver,
        )
    }

    /// 프로브와 신원 조회를 함께 끼운 테스트 감독자. 재시작 복구는 프로필 자격증명의
    /// 신원 증명과 격리 확인을 둘 다 거치므로, 두 자리를 한 구성에서 정해야 한다.
    ///
    /// 테스트 감독자의 구성은 이 한 자리에서만 조립한다. 홈 아래 기본 공급자 경로·저장소
    /// 프로필 없음·외부 프로세스 미조사는 네 생성자가 모두 같은 값을 쓰는데, 그 값을 각자
    /// 적어 두면 칸이 하나 늘 때 네 자리를 함께 고쳐야 하고 한 자리를 빠뜨려도 컴파일은
    /// 통과한다. 생성자마다 갈리는 것은 프로브와 신원 조회 둘뿐이라 그 둘만 인자로 받고,
    /// 나머지 생성자는 기본값을 이 자리에 맡긴 채 자기 인자만 채워 넘긴다.
    #[cfg(test)]
    fn open_with_probe_and_claude_identity_resolver(
        app_data_dir: &Path,
        home_dir: &Path,
        vault: Arc<dyn CredentialVault>,
        credential_probe: Arc<CredentialProbe>,
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
                credential_probe,
            },
        )
    }

    /// 프로필 격리 프로브를 끼운 테스트 감독자. 다른 모듈의 테스트가 격리된 계정과
    /// 격리되지 않은 계정을 모두 재현할 수 있게 crate 안에 열어 둔다.
    #[cfg(test)]
    pub(crate) fn open_for_test_with_credential_probe(
        app_data_dir: &Path,
        home_dir: &Path,
        credential_probe: Arc<CredentialProbe>,
    ) -> Result<Self, CoreError> {
        Self::open_with_credential_probe(
            app_data_dir,
            home_dir,
            Arc::new(TestCredentialVault::default()),
            credential_probe,
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
                antigravity_gemini_dir: home_dir.join(".gemini"),
                home_dir,
                codex_home_dir: config.codex_home_dir,
                claude_config_dir: config.claude_config_dir,
                claude_keychain_profile: config.claude_keychain_profile,
                inspect_external_processes: config.inspect_external_processes,
                vault,
                claude_identity_resolver: config.claude_identity_resolver,
                credential_probe: config.credential_probe,
                codex_switch_lock: Mutex::new(()),
                claude_switch_lock: Mutex::new(()),
                antigravity_switch_lock: Mutex::new(()),
                usage_locks: Mutex::new(HashMap::new()),
                auto_switch_tx: Mutex::new(None),
                credential_profiles: Mutex::new(HashMap::new()),
                home_observations: Mutex::new(HashMap::new()),
                active_verification_at: Mutex::new(None),
                state: Mutex::new(AccountState {
                    registry,
                    runtime_counts: HashMap::new(),
                    runtime_account_counts: HashMap::new(),
                    observed_active_account_ids: HashMap::new(),
                    logins: HashMap::new(),
                    auto_switch_events: HashMap::new(),
                }),
            }),
        };
        supervisor.cleanup_orphan_login_profiles()?;
        supervisor.verify_registered_active_accounts()?;
        Ok(supervisor)
    }

    pub fn snapshot(&self) -> Result<AccountSnapshot, CoreError> {
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
                    display_name: account
                        .label
                        .clone()
                        .unwrap_or_else(|| account.display_name.clone()),
                    email: account.email.clone(),
                    organization: account.organization.clone(),
                    provider_account_id: account.provider_account_id.clone(),
                    label: account.label.clone(),
                    provider_display_name: account.display_name.clone(),
                    is_active: provider.active_account_id.as_deref() == Some(&account.id),
                    disabled: account.disabled,
                    auto_switch: account.auto_switch,
                    auto_switch_priority: account.auto_switch_priority,
                    auth_status: account.auth_status,
                    usage: account.usage.clone(),
                    note: account.note.clone(),
                    credential_isolated: self
                        .credential_profile_isolated(account.provider, &account.id),
                    credential_isolation_note: self.credential_profile_fallback_reason(&account.id),
                    credential_expires_at: account.credential_expires_at,
                    runtime_count: state
                        .runtime_account_counts
                        .get(&account.id)
                        .copied()
                        .unwrap_or(0),
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
                active_account_id: provider.active_account_id.clone(),
                observed_active_account_id: state
                    .observed_active_account_ids
                    .get(&provider.provider)
                    .cloned()
                    .flatten(),
                runtime_count: state
                    .runtime_counts
                    .get(&provider.provider)
                    .copied()
                    .unwrap_or(0),
                last_auto_switch: state.auto_switch_events.get(&provider.provider).cloned(),
                home: self.home_view(provider.provider, &accounts),
            })
            .collect();
        Ok(AccountSnapshot {
            accounts,
            providers,
            auto_switch_resume: state.registry.auto_switch_resume,
            auto_switch_policy: state.registry.auto_switch_policy,
            auto_switch_usage_gap_percent: state.registry.auto_switch_usage_gap_percent,
            resume_account_policy: state.registry.resume_account_policy,
        })
    }

    /// 공유 CLI 홈을 다시 읽어 실제 활성 계정을 레지스트리에 반영한 최신 상태를 반환한다.
    /// 신원이 기존 계정과 일치하면 해당 계정을 선택하고, 처음 보는 계정이면 Vault와
    /// 비밀정보가 제거된 레지스트리에 새로 등록한다.
    pub fn reconciled_snapshot(&self) -> Result<AccountSnapshot, CoreError> {
        if self.should_reverify_active_accounts()? {
            self.verify_registered_active_accounts()?;
        }
        // 홈 관측은 표시용이라 실패해도 스냅샷을 막지 않는다. 주기는 관측 캐시가 지킨다.
        if let Err(error) = self.observe_home_credentials(false) {
            eprintln!("[accounts] 공유 CLI 홈 관측 실패: {error}");
        }
        self.snapshot()
    }

    /// 공유 CLI 홈에 실제로 든 자격증명을 읽어 홈 계정 뷰를 갱신한다. 저장소는
    /// [`HOME_OBSERVE_INTERVAL_MS`]보다 자주 읽지 않고(`force`면 지금 읽는다), 신원
    /// 조회는 저장소 값이 바뀌었을 때만 한다. 실패하면 저장소가 그대로인 동안 재시도
    /// 대기를 지킨다. 여기서 읽은 토큰은 절대 갱신하지 않는다.
    pub fn observe_home_credentials(&self, force: bool) -> Result<(), CoreError> {
        // 공급자 목록을 여기 적어 두면 계정 관리를 새로 지원하는 공급자의 홈 계정 카드가
        // "아직 읽지 않았습니다"에서 영영 멈춘다.
        for provider in managed_providers() {
            self.observe_home_credential(provider, force)?;
        }
        Ok(())
    }

    fn observe_home_credential(&self, provider: ProviderId, force: bool) -> Result<(), CoreError> {
        let now = now_ms();
        let previous = lock(&self.inner.home_observations, "홈 관측")?
            .get(&provider)
            .cloned();
        if !force
            && previous
                .as_ref()
                .is_some_and(|observation| observation.next_read_at > now)
        {
            return Ok(());
        }
        let secret = self.read_credentials(provider, None).ok();
        let observation = match secret {
            None => HomeObservation {
                fingerprint: None,
                view: ProviderHomeView {
                    state: HomeCredentialState::Absent,
                    checked_at: Some(now),
                    ..ProviderHomeView::default()
                },
                next_read_at: now.saturating_add(HOME_OBSERVE_INTERVAL_MS),
                error_streak: 0,
            },
            Some(secret) => self.observe_home_secret(provider, &secret, previous, now),
        };
        // 공유 홈의 실제 계정은 이 관측이 정한다. 신원을 확인하지 못했으면 모른다고 둔다.
        let observed = (observation.view.state == HomeCredentialState::Verified)
            .then(|| observation.view.account_id.clone())
            .flatten();
        self.set_observed_active_account_id(provider, observed)?;
        lock(&self.inner.home_observations, "홈 관측")?.insert(provider, observation);
        Ok(())
    }

    fn observe_home_secret(
        &self,
        provider: ProviderId,
        secret: &str,
        previous: Option<HomeObservation>,
        now: i64,
    ) -> HomeObservation {
        let fingerprint = credential_fingerprint(secret);
        // 사용량 캐시는 신원이 같을 때만 이어 쓴다. 토큰이 회전하면 지문이 바뀌지만
        // 홈에 든 계정은 그대로라, 여기서 버리면 회전할 때마다 다시 조회하게 된다.
        let previous_usage = previous.as_ref().map(|observation| {
            (
                observation.view.provider_account_id.clone(),
                observation.view.usage.clone(),
            )
        });
        let context = HomeObserveContext {
            access_token_expires_at: match provider {
                ProviderId::Claude => claude_access_token_expires_at(secret),
                _ => None,
            },
            next_read_at: now.saturating_add(HOME_OBSERVE_INTERVAL_MS),
            now,
        };
        let unchanged = previous.as_ref().is_some_and(|observation| {
            observation.fingerprint.as_deref() == Some(fingerprint.as_str())
        });
        let previous_streak = if unchanged {
            previous
                .as_ref()
                .map(|observation| observation.error_streak)
                .unwrap_or(0)
        } else {
            0
        };
        if unchanged {
            let previous = previous.expect("unchanged implies a previous observation");
            // 이어 쓸 수 없는 관측은 그대로 돌려받고, 아래에서 신원을 다시 묻는다.
            if let ControlFlow::Break(reused) = reuse_home_observation(previous, &context) {
                return reused;
            }
        }
        let identity = self.home_identity(provider, secret, now);
        let (view, error_streak) = self.home_view_from_identity(
            provider,
            identity,
            previous_usage,
            previous_streak,
            &context,
        );
        HomeObservation {
            fingerprint: Some(fingerprint),
            view,
            next_read_at: context.next_read_at,
            error_streak,
        }
    }

    /// 신원은 자격증명 안에서 먼저 찾고, Claude만 없을 때 프로필 API로 묻는다. 만료된
    /// Claude 토큰은 묻지 않는다 — 401이 뻔하고, 갱신은 다른 로그인의 사슬을 끊을 수 있다.
    fn home_identity(
        &self,
        provider: ProviderId,
        secret: &str,
        now: i64,
    ) -> Result<Option<AccountIdentity>, CoreError> {
        match provider {
            ProviderId::Codex => codex_identity(secret).map(Some),
            ProviderId::Claude => match claude_identity_from_secret(secret) {
                Ok(identity) => Ok(Some(identity)),
                Err(_) if claude_access_token_expired(secret, now) => Ok(None),
                Err(_) => (self.inner.claude_identity_resolver)(secret).map(Some),
            },
            // 공유 홈 자격증명이 키체인에만 있으면 토큰에 신원이 없다. 그때는 공식 CLI가
            // 자기 로그에 남긴 계정 이메일로 알아본다. 그것도 없으면 오류가 아니라 미상이다 —
            // 홈 관측은 "누가 로그인돼 있는지"를 알아보는 자리다.
            ProviderId::Antigravity => Ok(antigravity_identity(secret)
                .ok()
                .or_else(|| antigravity_identity_from_home(&self.inner.home_dir).ok())),
            ProviderId::Local => Err(unmanaged_provider_error(provider)),
        }
    }

    /// 신원 조회 결과를 관측 뷰와 이어진 실패 횟수로 옮긴다. 사용량은 신원이 그대로일
    /// 때만 넘겨받은 값을 이어 쓴다.
    fn home_view_from_identity(
        &self,
        provider: ProviderId,
        identity: Result<Option<AccountIdentity>, CoreError>,
        previous_usage: Option<(Option<String>, AccountUsageView)>,
        previous_streak: u32,
        context: &HomeObserveContext,
    ) -> (ProviderHomeView, u32) {
        let HomeObserveContext {
            access_token_expires_at,
            now,
            ..
        } = *context;
        match identity {
            Ok(Some(identity)) => {
                let usage = previous_usage
                    .filter(|(provider_account_id, _)| {
                        provider_account_id.as_deref()
                            == Some(identity.provider_account_id.as_str())
                    })
                    .map(|(_, usage)| usage)
                    .unwrap_or_default();
                (
                    ProviderHomeView {
                        state: HomeCredentialState::Verified,
                        account_id: self.registered_account_for_identity(provider, &identity),
                        email: identity.email,
                        display_name: identity.display_name,
                        provider_account_id: Some(identity.provider_account_id),
                        access_token_expires_at,
                        checked_at: Some(now),
                        retry_at: None,
                        error: None,
                        usage,
                    },
                    0,
                )
            }
            Ok(None) => (
                ProviderHomeView {
                    state: HomeCredentialState::Expired,
                    access_token_expires_at,
                    checked_at: Some(now),
                    ..ProviderHomeView::default()
                },
                0,
            ),
            Err(error) => {
                let streak = previous_streak.saturating_add(1);
                (
                    ProviderHomeView {
                        state: HomeCredentialState::Error,
                        access_token_expires_at,
                        checked_at: Some(now),
                        retry_at: Some(now.saturating_add(home_identity_retry_ms(streak))),
                        error: Some(error.to_string()),
                        ..ProviderHomeView::default()
                    },
                    streak,
                )
            }
        }
    }

    fn registered_account_for_identity(
        &self,
        provider: ProviderId,
        identity: &AccountIdentity,
    ) -> Option<String> {
        let state = lock(&self.inner.state, "계정 상태").ok()?;
        state
            .registry
            .accounts
            .iter()
            .find(|account| {
                account.provider == provider && identity_matches_account(identity, account)
            })
            .map(|account| account.id.clone())
    }

    /// 홈 계정 뷰. 신원이 등록 계정과 같으면 사용량은 그 계정이 이미 읽어 둔 값을
    /// 그대로 옮긴다 — 같은 공급자 계정을 두 번 조회하면 429 압력만 두 배가 된다.
    fn home_view(
        &self,
        provider: ProviderId,
        accounts: &[ProviderAccountView],
    ) -> ProviderHomeView {
        let mut view = lock(&self.inner.home_observations, "홈 관측")
            .ok()
            .and_then(|observations| {
                observations
                    .get(&provider)
                    .map(|observation| observation.view.clone())
            })
            .unwrap_or_default();
        if let Some(account_id) = view.account_id.as_deref() {
            view.usage = accounts
                .iter()
                .find(|account| account.id == account_id)
                .map(|account| account.usage.clone())
                .unwrap_or_default();
        }
        view
    }

    /// 홈 계정(공유 CLI 홈에 실제로 든 로그인)의 사용량을 읽기 전용으로 조회한다.
    /// 저장소에 쓰지 않고 토큰도 갱신하지 않는다 — 만료된 Claude 토큰을 갱신하면
    /// 데스크탑 앱·터미널이 이어 쓰는 로그인 사슬이 끊긴다. 그래서 액세스 토큰이
    /// 살아 있는 동안에만 값을 얻고, 만료됐으면 그 사실을 그대로 남긴다.
    ///
    /// 신원이 등록 계정과 같으면 조회하지 않는다. 그 계정이 자기 주기로 이미 같은
    /// 공급자 계정을 조회하고, 표시할 값은 [`Self::home_view`]가 거기서 가져온다.
    fn refresh_home_usage(&self, provider: ProviderId, force: bool) -> Result<(), CoreError> {
        let now = now_ms();
        let Some(observed) = lock(&self.inner.home_observations, "홈 관측")?
            .get(&provider)
            .cloned()
        else {
            return Ok(());
        };
        if observed.view.state != HomeCredentialState::Verified
            || observed.view.account_id.is_some()
        {
            return Ok(());
        }
        // 등록 계정과 같은 대기·주기 판정을 쓴다. 재시도 대기는 force여도 지킨다 —
        // 공급자가 기다리라고 한 시각이라 사용자가 무를 수 있는 것이 아니다.
        if usage_refresh_deferred(&observed.view.usage, now)
            || (!force && usage_refresh_fresh_for_interval(&observed.view.usage, now, false))
        {
            return Ok(());
        }
        let Ok(secret) = self.read_credentials(provider, None) else {
            return Ok(());
        };
        let fresh = fetch_home_usage(provider, &secret, now);
        let mut observations = lock(&self.inner.home_observations, "홈 관측")?;
        if let Some(current) = observations.get_mut(&provider) {
            // 조회하는 사이 홈의 로그인이 바뀌었으면 이 수치는 다른 계정의 것이다.
            if current.fingerprint == observed.fingerprint {
                current.view.usage = apply_usage_stale_policy(fresh, &current.view.usage);
            }
        }
        Ok(())
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

    /// 테스트 전용. 공유 CLI 홈에 든 로그인을 읽어 계정으로 등록한다. 실제 앱에는 이
    /// 경로가 없다 — 공유 홈 사슬을 복사하면 데스크탑 앱과 같은 사슬을 두 곳에서 회전시켜
    /// 어느 한쪽이 끊기므로, 계정은 격리 로그인으로만 등록한다.
    #[cfg(test)]
    pub(crate) fn register_current(
        &self,
        provider: ProviderId,
        display_name: Option<String>,
    ) -> Result<AccountSnapshot, CoreError> {
        ensure_managed_provider(provider)?;
        let captured = self.capture_credentials(provider, None)?;
        self.upsert_captured_account(provider, None, display_name, captured)?;
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
        // 홈을 가르는 공급자는 로그인도 그 홈 안에서 끝나야 한다. 키체인을 먼저 만들지
        // 않으면 공식 CLI가 토큰을 저장하는 순간 모달에 걸려 로그인이 멈춘다(`C12`).
        if provider == ProviderId::Antigravity {
            ensure_profile_keychain(&profile_path)?;
            // C12-11 1단계. 로그인이 기계 전역 항목에 들어가는 플랫폼에서는 그 항목이 있는 한
            // 로그인 터미널이 브라우저에 닿지 못한다 — CLI가 기존 항목을 찾아 그 계정의 잔량을
            // 찍고 성공으로 끝내서 다른 구글 계정을 고를 자리가 없다(계정 추가 화면에서 실측).
            // 항목을 비워야 CLI가 대화형 OAuth로 넘어간다. 등록된 계정의 토큰은 이미 볼트에
            // 있고 매 실행 시작마다 볼트에서 프로필로 다시 쓰이므로 여기서 잃는 것은 없다.
            self.clear_antigravity_global_login_for_start("로그인 시작")?;
        }
        let login = AccountLoginSession {
            id: id.clone(),
            provider,
            account_id: account_id.map(str::to_owned),
            // 이 경로는 로그인 CLI의 작업 경로이자 `CODEX_HOME`·`CLAUDE_CONFIG_DIR` 값이
            // 되므로 자식이 읽을 수 있는 모양이어야 한다.
            profile_path: crate::path_guard::canonical_child_facing(profile_path)?,
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
        let captured = self
            .capture_credentials(login.provider, Some(&login.profile_path))
            .map_err(|error| login_capture_error(login.provider, &login.profile_path, error))?;
        self.upsert_captured_account(
            login.provider,
            login.account_id.as_deref(),
            display_name,
            captured,
        )?;
        // C12-11 1단계. 방금 CLI가 전역 항목에 놓은 로그인은 볼트로 들어올렸다. 항목을 그대로
        // 두면 다음에 뜨는 어느 계정의 실행이든 이 계정으로 인증된다.
        if login.provider == ProviderId::Antigravity {
            self.clear_antigravity_global_login_for_start("로그인 회수")?;
        }
        self.remove_login(login_id)?;
        self.snapshot()
    }

    pub fn cancel_login(&self, login_id: &str) -> Result<(), CoreError> {
        self.remove_login(login_id)
    }

    /// [`Self::set_active`]의 이전 이름. 기본 계정과 활성 계정은 하나다.
    pub fn set_default(&self, account_id: &str) -> Result<AccountSnapshot, CoreError> {
        self.set_active(account_id)
    }

    /// 계정 레지스트리 한 자리를 바꾸고 새 스냅숏을 돌려준다. 설정 손잡이가 모두 같은
    /// 순서를 밟는다 — 상태 잠금, 값 변경, 바뀌었을 때만 저장, 잠금 해제 뒤 스냅숏.
    /// 마지막 두 단계의 순서가 중요해서 한곳에 모았다. `snapshot`이 같은 잠금을 다시
    /// 잡으므로 먼저 놓지 않으면 손잡이마다 교착이 된다.
    ///
    /// `change`가 `false`를 돌려주면 값이 그대로라는 뜻이라 저장을 건너뛴다.
    fn update_registry(
        &self,
        change: impl FnOnce(&mut AccountRegistry) -> Result<bool, CoreError>,
    ) -> Result<AccountSnapshot, CoreError> {
        self.update_registry_quiet(change)?;
        self.snapshot()
    }

    /// [`Self::update_registry`]에서 스냅숏을 뺀 것. 바꿨는지만 답한다 — 백그라운드 루프처럼
    /// 화면에 줄 것이 없고 거절로 끝나는 일이 잦은 자리가 쓴다. 잠금·변경·저장 순서는 하나다.
    ///
    /// 저장에 실패하면 메모리도 바꾸기 전으로 되돌린다. 메모리만 바뀐 채 `Err`를 돌려주면
    /// 호출자는 "안 바뀌었다"로 처리하는데 새 대화는 이미 바뀐 값으로 열리고, 재기동하면 옛
    /// 값으로 돌아간다 — 두 상태가 어긋난 채 실패가 조용히 묻힌다.
    fn update_registry_quiet(
        &self,
        change: impl FnOnce(&mut AccountRegistry) -> Result<bool, CoreError>,
    ) -> Result<bool, CoreError> {
        let mut state = lock(&self.inner.state, "계정 상태")?;
        let before = state.registry.clone();
        let changed = match change(&mut state.registry) {
            Ok(changed) => changed,
            Err(error) => {
                state.registry = before;
                return Err(error);
            }
        };
        if changed {
            if let Err(error) = save_registry(&self.inner.app_data_dir, &state.registry) {
                state.registry = before;
                return Err(error);
            }
        }
        Ok(changed)
    }

    /// 계정 id들의 표시 이름(사용자 라벨이 있으면 그것, 없으면 공급자가 준 이름). 스냅숏
    /// 전체를 만들지 않고 잠금 안에서 읽는다 — 이름 두어 개를 위해 계정마다 자격증명 프로필을
    /// 디스크에서 확인할 이유가 없다. 없는 id는 빠진다.
    pub fn display_names(
        &self,
        account_ids: &[&str],
    ) -> Result<HashMap<String, String>, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        Ok(state
            .registry
            .accounts
            .iter()
            .filter(|account| account_ids.contains(&account.id.as_str()))
            .map(|account| {
                (
                    account.id.clone(),
                    account
                        .label
                        .clone()
                        .unwrap_or_else(|| account.display_name.clone()),
                )
            })
            .collect())
    }

    /// [`Self::update_registry`]를 계정 레코드 하나로 좁힌 것. `change`가 바꿨다고
    /// 답하면 `updated_at`을 함께 올린다 — 계정 값을 고치면서 이 갱신 시각을 빠뜨리면
    /// 화면이 옛 시각을 계속 보여 준다.
    fn update_account(
        &self,
        account_id: &str,
        change: impl FnOnce(&mut AccountRecord) -> Result<bool, CoreError>,
    ) -> Result<AccountSnapshot, CoreError> {
        self.update_registry(|registry| {
            let account = account_by_id_mut(registry, account_id)?;
            if !change(account)? {
                return Ok(false);
            }
            account.updated_at = now_ms();
            Ok(true)
        })
    }

    /// 설정 손잡이 하나가 값을 갈아 끼우고 저장 여부를 답한다. [`Self::update_registry`]와
    /// [`Self::update_account`]의 `change`가 그대로 쓸 수 있는 모양이다.
    ///
    /// "같으면 `Ok(false)`, 다르면 대입하고 `Ok(true)`"를 손잡이마다 손으로 적으면 비교
    /// 대상과 대입 대상이 어긋나거나 비교를 통째로 빠뜨려도 컴파일은 통과한다. 빠뜨린
    /// 쪽은 값이 그대로인 저장을 계속 일으키고, 계정 손잡이에서는 [`Self::update_account`]가
    /// `updated_at`까지 올려 화면이 바뀌지 않은 계정을 방금 바뀐 것으로 보여 준다.
    fn replace_if_changed<T: PartialEq>(slot: &mut T, value: T) -> Result<bool, CoreError> {
        if *slot == value {
            return Ok(false);
        }
        *slot = value;
        Ok(true)
    }

    /// 기본 계정을 바꾼다. 새 채팅·터미널의 기본 실행 계정, 헤더의 사용량 표시, 이어가기
    /// 정책의 "활성 계정으로", 반복 요청의 "실행 시점 활성 계정"이 이 값을 따른다.
    /// 자격증명은 건드리지 않는다 — 모든 계정은 자기 격리 프로필로 실행되고 앱은 공유 CLI
    /// 홈에 쓰지 않으므로, 전환은 포인터 변경일 뿐이라 실행 중 런타임을 종료할 이유가 없다.
    pub fn set_active(&self, account_id: &str) -> Result<AccountSnapshot, CoreError> {
        self.update_registry(|registry| {
            let account = account_by_id(registry, account_id)?;
            if account.disabled {
                return Err(CoreError::Conflict(
                    "비활성화된 계정은 활성 계정으로 선택할 수 없습니다".to_owned(),
                ));
            }
            if account.auth_status != AccountAuthStatus::Ready {
                return Err(CoreError::Conflict(
                    "재인증이 필요한 계정은 활성 계정으로 선택할 수 없습니다".to_owned(),
                ));
            }
            let provider = account.provider;
            let provider_state = registry.provider_mut(provider)?;
            if provider_state.active_account_id.as_deref() == Some(account_id) {
                return Ok(false);
            }
            provider_state.active_account_id = Some(account_id.to_owned());
            Ok(true)
        })
    }

    /// 등록된 계정 ID의 소속 공급자를 조회한다.
    pub fn account_provider(&self, account_id: &str) -> Result<ProviderId, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        Ok(account_by_id(&state.registry, account_id)?.provider)
    }

    /// 인증 상태를 잃은 계정을 테스트에서 만든다. 실제로는 자격증명 확인 실패만
    /// 붙이는 값이라 밖에서 설정할 길이 없다.
    #[cfg(test)]
    pub(crate) fn force_auth_status_for_test(
        &self,
        account_id: &str,
        auth_status: AccountAuthStatus,
    ) -> Result<(), CoreError> {
        let mut state = lock(&self.inner.state, "계정 상태")?;
        account_by_id_mut(&mut state.registry, account_id)?.auth_status = auth_status;
        save_registry(&self.inner.app_data_dir, &state.registry)
    }

    pub fn set_disabled(
        &self,
        account_id: &str,
        disabled: bool,
    ) -> Result<AccountSnapshot, CoreError> {
        self.update_registry(|registry| {
            let account = account_by_id(registry, account_id)?;
            let is_active = registry
                .provider(account.provider)?
                .active_account_id
                .as_deref()
                == Some(account_id);
            if disabled && is_active {
                return Err(CoreError::Conflict(
                    "활성 계정은 비활성화할 수 없습니다. 먼저 다른 계정을 활성으로 선택하세요"
                        .to_owned(),
                ));
            }
            let account = account_by_id_mut(registry, account_id)?;
            account.disabled = disabled;
            account.updated_at = now_ms();
            Ok(true)
        })
    }

    pub fn set_auto_switch(
        &self,
        account_id: &str,
        auto_switch: bool,
    ) -> Result<AccountSnapshot, CoreError> {
        self.update_account(account_id, |account| {
            account.auto_switch = auto_switch;
            Ok(true)
        })
    }

    /// 계정별 사용자 메모를 계정 레지스트리에 저장한다. 앞뒤 공백을 정리한 뒤 빈
    /// 값은 메모 삭제로 처리한다. 메모는 비밀정보가 아니므로 자격증명 저장소에는
    /// 쓰지 않으며, 계정 등록이 삭제되면 레코드와 함께 사라진다.
    pub fn set_note(
        &self,
        account_id: &str,
        note: Option<&str>,
    ) -> Result<AccountSnapshot, CoreError> {
        let normalized = normalize_account_note(note)?;
        self.update_account(account_id, |account| {
            Self::replace_if_changed(&mut account.note, normalized)
        })
    }

    /// 계정 표시 이름을 사용자가 직접 정한 값으로 바꾼다. 앞뒤 공백을 정리한 뒤 빈
    /// 값은 사용자 지정 해제로 처리해, 다시 공급자가 알려 준 이름을 쓰게 한다.
    /// 공급자 재조회는 `display_name`만 갱신하므로 이 값은 덮이지 않는다.
    pub fn set_label(
        &self,
        account_id: &str,
        label: Option<&str>,
    ) -> Result<AccountSnapshot, CoreError> {
        let normalized = normalize_account_label(label)?;
        self.update_account(account_id, |account| {
            Self::replace_if_changed(&mut account.label, normalized)
        })
    }

    /// 자동전환 후 세션 복원 옵션 값. 자동전환 실행기가 전환 직전에 조회한다.
    pub fn auto_switch_resume_enabled(&self) -> Result<bool, CoreError> {
        Ok(lock(&self.inner.state, "계정 상태")?
            .registry
            .auto_switch_resume)
    }

    /// 이어가기 계정 선택 방식. 채팅·터미널이 세션을 열 때 조회한다.
    pub fn resume_account_policy(&self) -> Result<ResumeAccountPolicy, CoreError> {
        Ok(lock(&self.inner.state, "계정 상태")?
            .registry
            .resume_account_policy)
    }

    /// 이어가기 계정 선택 방식을 바꾼다. 이미 떠 있는 런타임은 시작 시점 계정을
    /// 유지하므로, 다음 이어가기부터 적용된다.
    pub fn set_resume_account_policy(
        &self,
        policy: ResumeAccountPolicy,
    ) -> Result<AccountSnapshot, CoreError> {
        self.update_registry(|registry| {
            Self::replace_if_changed(&mut registry.resume_account_policy, policy)
        })
    }

    /// 페일오버 후보 선택 방식을 바꾼다.
    pub fn set_auto_switch_policy(
        &self,
        policy: AutoSwitchPolicy,
    ) -> Result<AccountSnapshot, CoreError> {
        self.update_registry(|registry| {
            Self::replace_if_changed(&mut registry.auto_switch_policy, policy)
        })
    }

    /// 사용량 분산 교체 폭. 사용량을 보고한 계정이 가장 덜 쓴 후보보다 이 폭(%p)만큼
    /// 앞서면 그 후보로 순환한다. None이면 분산 교체를 끈다. 100은 어떤 두 계정도
    /// 만들 수 없는 격차라 받지 않는다.
    pub fn set_auto_switch_usage_gap(
        &self,
        percent: Option<u8>,
    ) -> Result<AccountSnapshot, CoreError> {
        if percent.is_some_and(|percent| !(1..=99).contains(&percent)) {
            return Err(CoreError::InvalidInput(
                "사용량 분산 교체 폭은 1~99 사이여야 합니다".to_owned(),
            ));
        }
        self.update_registry(|registry| {
            Self::replace_if_changed(&mut registry.auto_switch_usage_gap_percent, percent)
        })
    }

    /// 자동전환이 기본 계정을 `expected_from`에서 대상 계정으로 옮긴다. 대상이 이미 기본이거나
    /// 쓸 수 없는 계정이면 아무것도 하지 않고 `false`를 돌려준다.
    ///
    /// 지금 기본 계정이 `expected_from`이 아니면 옮기지 않고 로그를 남긴다. 계획이 "지정 계정이
    /// 기본 계정이다"라고 본 뒤 세션 복구와 격리 프로브(최대 20초)가 지나는 사이 사용자가
    /// 설정에서 기본 계정을 바꿨을 수 있다 — 그 선택을 자동전환이 덮어쓰면 안 된다. 확인과
    /// 교체를 한 잠금 안에서 하므로 그 사이에 끼어들 틈이 없다. 쓸 수 있는지는 실행 게이트와
    /// 같은 판정(`account_readiness`)이다.
    pub fn request_active_account_rotation(
        &self,
        expected_from: &str,
        account_id: &str,
    ) -> Result<bool, CoreError> {
        let now = now_ms();
        self.update_registry_quiet(|registry| {
            let account = account_by_id(registry, account_id)?;
            // 기본 계정을 옮기는 자리는 어떤 모델로 쓸지 모른다. 계정 전체 판정으로 본다.
            if account_readiness(account, account.provider, None, now) != RunReadiness::Ready {
                return Ok(false);
            }
            let provider_state = registry.provider_mut(account.provider)?;
            let active = provider_state.active_account_id.as_deref();
            if active != Some(expected_from) {
                eprintln!(
                    "[auto-switch] 기본 계정이 {expected_from}에서 {}로 바뀌어 {account_id}로의 회전을 건너뜁니다",
                    active.unwrap_or("(없음)")
                );
                return Ok(false);
            }
            if active == Some(account_id) {
                return Ok(false);
            }
            provider_state.active_account_id = Some(account_id.to_owned());
            Ok(true)
        })
    }

    /// 계정의 페일오버 우선순위를 저장한다. None이면 지정을 해제해 우선순위 정책에서
    /// 지정된 계정들 뒤로 밀린다.
    pub fn set_auto_switch_priority(
        &self,
        account_id: &str,
        priority: Option<u32>,
    ) -> Result<AccountSnapshot, CoreError> {
        self.update_account(account_id, |account| {
            Self::replace_if_changed(&mut account.auto_switch_priority, priority)
        })
    }

    pub fn set_auto_switch_resume(&self, enabled: bool) -> Result<AccountSnapshot, CoreError> {
        self.update_registry(|registry| {
            registry.auto_switch_resume = enabled;
            Ok(true)
        })
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
    /// 후보에서 제외하도록 사용량 캐시에 표시하고 자동전환 트리거를 보낸다.
    /// `chat_id`를 주면 그 채팅만 다른 계정으로 옮긴다.
    ///
    /// 표시는 하되 **재시도 대기(`retry_at`)는 걸지 않는다.** 그 값은 사용량 조회
    /// 자체를 미루는 신호인데, 추론 API가 한도라고 답한 것이 사용량 엔드포인트까지
    /// 막혔다는 뜻은 아니다. 전에는 15분 대기를 걸었고, 그 동안 화면은 마지막 조회
    /// 수치(예: 62%)를 그대로 보여 주면서 채팅은 한도 오류를 냈다. 사용자가 재시도할
    /// 때마다 대기가 다시 걸려 실제 수치(100%)는 몇 시간이 지나도 나타나지 않았다
    /// (2026-08-27 실측). 대신 곧바로 한 번 조회해 실제 잔량과 리셋 시각을 채운다 —
    /// 그 값이 페일오버·예약 대기·화면이 기다리던 정보다.
    pub fn report_agent_usage_limit(
        &self,
        account_id: &str,
        chat_id: Option<&str>,
        model: Option<&str>,
    ) -> Result<(), CoreError> {
        let now = now_ms();
        let (provider, first_signal) = {
            let mut state = lock(&self.inner.state, "계정 상태")?;
            let account = account_by_id_mut(&mut state.registry, account_id)?;
            let provider = account.provider;
            // 토큰 갱신 429로 잡힌 표시는 사용량 한도가 아니므로 이미 표시된 것으로
            // 보지 않는다. 그러지 않으면 실제 한도 보고가 그 표시에 묻힌다. 표시는
            // 다음 성공 조회가 지우므로, 그때까지는 같은 신호를 다시 기록하지 않는다.
            let already_marked = account.usage.rate_limited && !account.usage.token_refresh_limited;
            if !already_marked {
                account.usage.rate_limited = true;
                account.usage.token_refresh_limited = false;
                account.usage.retry_at = None;
                account.usage.error =
                    Some("에이전트 세션이 사용량 제한 응답을 받았습니다".to_owned());
                account.updated_at = now;
                save_registry(&self.inner.app_data_dir, &state.registry)?;
            }
            (provider, !already_marked)
        };
        self.signal_auto_switch(AutoSwitchSignal {
            provider,
            account_id: account_id.to_owned(),
            reason: AutoSwitchReason::AgentLimited,
            chat_id: chat_id.map(str::to_owned),
            models: model.map(str::to_owned).into_iter().collect(),
        });
        // 첫 신호에만 조회를 띄운다. 조회가 성공하면 표시가 지워져 다음 신호가 다시
        // 첫 신호가 되므로, 조회 횟수는 사용자의 재시도 횟수를 넘지 않는다. 이 함수는
        // 채팅 이벤트 처리 중에 불리므로 네트워크 조회는 별도 스레드로 보낸다.
        if first_signal {
            let supervisor = self.clone();
            let account_id = account_id.to_owned();
            std::thread::spawn(move || {
                if let Err(error) = supervisor.refresh_usage(&account_id) {
                    eprintln!("[usage] 한도 신호 뒤 계정 {account_id} 사용량 조회 실패: {error}");
                }
            });
        }
        Ok(())
    }

    /// 이 신호로 전환을 따져 볼 자격이 있는지 — 쿨다운 안이 아니고 지정 계정의 자동전환이
    /// 켜져 있어야 한다. 후보를 고르기 전에 이것만 먼저 보면, 전환 루프가 살아 있는 채팅을
    /// 훑고 고정 세션마다 로그를 남기는 일을 거절될 신호에는 하지 않게 된다.
    pub fn auto_switch_admissible(&self, signal: &AutoSwitchSignal) -> Result<bool, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        Self::auto_switch_admissible_in(&state, signal, now_ms())
    }

    fn auto_switch_admissible_in(
        state: &AccountState,
        signal: &AutoSwitchSignal,
        now: i64,
    ) -> Result<bool, CoreError> {
        if let Some(event) = state.auto_switch_events.get(&signal.provider) {
            if now - event.at < AUTO_SWITCH_COOLDOWN_MS {
                return Ok(false);
            }
        }
        let limited = account_by_id(&state.registry, &signal.account_id)?;
        Ok(limited.auto_switch)
    }

    /// 세션 재바인딩 목적으로 후보 하나를 고른다. 전환 루프는 두 질문을 함께 묻는
    /// [`Self::plan_auto_switches`]를 쓰고, 이것은 자격 규칙을 하나씩 확인하는 시험의 진입점이다.
    #[cfg(test)]
    pub fn plan_auto_switch(&self, signal: &AutoSwitchSignal) -> Result<Option<String>, CoreError> {
        let now = now_ms();
        let state = lock(&self.inner.state, "계정 상태")?;
        if !Self::auto_switch_admissible_in(&state, signal, now)? {
            return Ok(None);
        }
        Ok(Self::plan_switch_in(
            &state,
            signal,
            &signal.models,
            SwitchIntent::Rebind,
            now,
        ))
    }

    /// 두 질문을 한 잠금 안에서 함께 답한다. `rebind_models`가 `None`이면 옮길 세션이 없어
    /// 재바인딩은 묻지 않는다. 기본 계정 회전은 지정 계정이 지금 기본 계정일 때만 묻는다 —
    /// 실제 교체는 [`Self::request_active_account_rotation`]이 그 사실을 다시 확인한 뒤 한다.
    /// 입장 판정([`Self::auto_switch_admissible`])도 여기서 한 번 더 한다 — 전환 루프가 먼저
    /// 묻고 세션을 훑는 사이에 다른 전환이 기록됐으면 둘 다 비어 나온다.
    pub fn plan_auto_switches(
        &self,
        signal: &AutoSwitchSignal,
        rebind_models: Option<&[String]>,
    ) -> Result<AutoSwitchPlan, CoreError> {
        let now = now_ms();
        let state = lock(&self.inner.state, "계정 상태")?;
        let empty = AutoSwitchPlan {
            rebind_target: None,
            rotate_target: None,
        };
        if !Self::auto_switch_admissible_in(&state, signal, now)? {
            return Ok(empty);
        }
        let rebind_target = rebind_models.and_then(|models| {
            Self::plan_switch_in(&state, signal, models, SwitchIntent::Rebind, now)
        });
        let limited_is_active = state
            .registry
            .provider(signal.provider)?
            .active_account_id
            .as_deref()
            == Some(signal.account_id.as_str());
        let rotate_target = limited_is_active
            .then(|| {
                Self::plan_switch_in(
                    &state,
                    signal,
                    &signal.models,
                    SwitchIntent::DefaultRotation,
                    now,
                )
            })
            .flatten();
        Ok(AutoSwitchPlan {
            rebind_target,
            rotate_target,
        })
    }

    /// 한 의도로 후보 하나를 고른다. 입장 판정은 부르는 쪽이 이미 했다.
    fn plan_switch_in(
        state: &AccountState,
        signal: &AutoSwitchSignal,
        models: &[String],
        intent: SwitchIntent,
        now: i64,
    ) -> Option<String> {
        // 분산 교체는 이만큼 뒤처진 계정으로만 옮긴다. 아무도 그만큼 뒤처져 있지
        // 않으면 이미 균형이 맞은 것이므로 전환하지 않고, 계속 쓰다 보면 격차가
        // 벌어져 다음 갱신에서 다시 후보가 생긴다.
        let min_usage_gap_percent = match signal.reason {
            AutoSwitchReason::UsageSpread => {
                state.registry.auto_switch_usage_gap_percent.map(f64::from)
            }
            AutoSwitchReason::UsageExhausted | AutoSwitchReason::AgentLimited => None,
        };
        select_auto_switch_target(
            &state.registry.accounts,
            signal.provider,
            &signal.account_id,
            &SwitchPurpose {
                models,
                reason: signal.reason,
                intent,
            },
            now,
            state.registry.auto_switch_policy,
            min_usage_gap_percent,
        )
    }

    /// 자동전환이 실행된 사실을 기록해 스냅샷(UI)과 쿨다운 판정에 노출하고, 기록한 이벤트를
    /// 돌려준다 — 알림은 이 값 하나로 말한다. 기록하지 못하면(잠금 오염) 실패를 돌려주어
    /// 기록 없는 알림이 나가지 않게 한다.
    #[allow(clippy::too_many_arguments)]
    pub fn record_auto_switch(
        &self,
        provider: ProviderId,
        from_account_id: &str,
        to_account_id: &str,
        reason: AutoSwitchReason,
        resumed_session_count: usize,
        default_rotated: bool,
        sessions_to_account_id: Option<&str>,
    ) -> Result<AutoSwitchEventView, CoreError> {
        let event = AutoSwitchEventView {
            from_account_id: from_account_id.to_owned(),
            to_account_id: to_account_id.to_owned(),
            reason,
            at: now_ms(),
            resumed_session_count,
            default_rotated,
            // 옮긴 세션이 없거나 기본 계정과 같은 곳으로 갔으면 따로 말할 것이 없다.
            sessions_to_account_id: sessions_to_account_id
                .filter(|sessions_to| resumed_session_count > 0 && *sessions_to != to_account_id)
                .map(str::to_owned),
        };
        let mut state = lock(&self.inner.state, "계정 상태")?;
        state.auto_switch_events.insert(provider, event.clone());
        Ok(event)
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
        if provider.active_account_id.as_deref() == Some(account_id) {
            return Err(CoreError::Conflict(
                "활성 계정은 삭제할 수 없습니다. 먼저 다른 계정을 활성으로 선택하세요".to_owned(),
            ));
        }
        if state
            .runtime_account_counts
            .get(account_id)
            .copied()
            .unwrap_or(0)
            > 0
        {
            return Err(CoreError::Conflict(
                "이 계정으로 실행 중인 런타임이 있어 삭제할 수 없습니다".to_owned(),
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
        // 등록을 지운 뒤에는 계정별 프로필에 남은 자격증명도 함께 지운다. 실패는
        // 삭제 자체를 되돌릴 이유가 아니므로 진단만 남긴다.
        if account.provider == ProviderId::Claude {
            if let Ok(dir) = credential_profiles::profile_dir(
                &self.inner.app_data_dir,
                account.provider,
                account_id,
            ) {
                if let Err(error) = delete_claude_keychain_credentials(Some(&dir)) {
                    eprintln!(
                        "[credential-profile] 계정 {account_id} 프로필 Keychain 항목을 지우지 못했습니다: {error}"
                    );
                }
            }
        }
        if let Err(error) = credential_profiles::remove_profile(
            &self.inner.app_data_dir,
            account.provider,
            account_id,
        ) {
            eprintln!("[credential-profile] 계정 {account_id} 프로필을 지우지 못했습니다: {error}");
        }
        if let Ok(mut profiles) = self.inner.credential_profiles.lock() {
            profiles.remove(account_id);
        }
        crate::usage_history::remove_account(&self.inner.app_data_dir, account_id);
        self.snapshot()
    }

    /// 등록된 계정들의 사용량 주기 이력. 자격증명을 읽지 않는 순수 조회다.
    /// Antigravity 모델군은 계정 레지스트리에 없지만 자기 쿼터 주기를 따로 소비하므로
    /// 페이싱 자원 id를 함께 물어, 누적 소비율에서 이 공급자가 빠지지 않게 한다.
    pub fn usage_history(&self) -> Result<crate::usage_history::UsageHistorySnapshot, CoreError> {
        let mut account_ids = {
            let state = lock(&self.inner.state, "계정 상태")?;
            state
                .registry
                .accounts
                .iter()
                .map(|account| account.id.clone())
                .collect::<Vec<_>>()
        };
        account_ids.extend(crate::antigravity_usage::pacing_resource_ids());
        crate::usage_history::snapshot(&self.inner.app_data_dir, &account_ids)
    }

    /// "지금 소비가 바뀌었을 것"이라는 신호(무인 런타임의 턴 종료 등)로 사용량을 갱신한다.
    /// 공급자가 재시도를 미뤄 둔 계정(`retry_at`)은 건너뛰고, 직전 갱신이 `min_age_ms`
    /// 안이면 다시 조회하지 않는다 — 한 회차에 여러 런타임이 잇달아 끝나도 조회는 그
    /// 간격에 한 번이다. 건너뛰면 `None`.
    pub fn refresh_usage_if_due(
        &self,
        account_id: &str,
        min_age_ms: i64,
    ) -> Result<Option<AccountSnapshot>, CoreError> {
        let usage = {
            let state = lock(&self.inner.state, "계정 상태")?;
            account_by_id(&state.registry, account_id)?.usage.clone()
        };
        let now = now_ms();
        if usage_refresh_deferred(&usage, now) {
            return Ok(None);
        }
        if usage
            .updated_at
            .is_some_and(|updated_at| now - updated_at < min_age_ms)
        {
            return Ok(None);
        }
        self.refresh_usage(account_id).map(Some)
    }

    /// 한도 리셋 크레딧 한 장을 써서 이 계정의 소진된 창을 되돌린다.
    ///
    /// 크레딧은 장수가 한정돼 있고 되돌릴 수 없으므로 사용자가 명시적으로 요청했을
    /// 때만 부른다. 어떤 장을 쓸지는 공급자가 고른다(만료가 임박한 것부터).
    /// 한도를 충분히 쓰지 않았으면 공급자가 `NothingToReset`으로 물리고 크레딧은
    /// 그대로 남는다 — 여기서 미리 막지 않고 그 판정을 그대로 전한다.
    ///
    /// 성공 여부와 무관하게 사용량을 다시 읽는다. 성공했으면 초기화된 수치를, 실패했으면
    /// 크레딧 장수가 바뀌지 않았음을 화면이 곧바로 보게 된다.
    pub fn consume_reset_credit(
        &self,
        account_id: &str,
    ) -> Result<(ResetCreditOutcome, AccountSnapshot), CoreError> {
        let account = self.account_record(account_id)?;
        if account.provider != ProviderId::Codex {
            return Err(CoreError::InvalidInput(
                "한도 리셋 크레딧은 Codex 계정만 지원합니다".to_owned(),
            ));
        }
        let outcome = {
            // 사용량 조회와 같은 락을 잡는다. 조회가 도는 중에 초기화하면 조회가 옛 수치를
            // 늦게 덮어써, 초기화됐는데도 화면이 소진 상태로 남는다.
            let usage_lock = self.usage_refresh_lock(&account.id)?;
            let _usage_refresh = lock(&usage_lock, "계정 사용량 갱신")?;
            let executable = probe_executable(ProviderId::Codex).ok_or_else(|| {
                CoreError::InvalidInput(
                    "Codex CLI를 찾지 못해 한도를 초기화할 수 없습니다".to_owned(),
                )
            })?;
            let profile = self
                .runtime_credential_profile(ProviderId::Codex, &account.id)?
                .ok_or_else(|| {
                    CoreError::InvalidInput(
                        "Codex 자격증명 프로필이 없어 한도를 초기화할 수 없습니다".to_owned(),
                    )
                })?;
            let outcome = consume_codex_reset_credit_from_app_server(
                &executable,
                &profile.env,
                &Uuid::new_v4().to_string(),
            );
            // 조회와 같은 이유로, 성공·실패와 무관하게 회전됐을 수 있는 토큰을 맞춰 둔다.
            self.sync_profile_credential(&account, &profile.dir)?;
            outcome?
        };
        Ok((outcome, self.refresh_usage(account_id)?))
    }

    pub fn refresh_usage(&self, account_id: &str) -> Result<AccountSnapshot, CoreError> {
        let account = self.account_record(account_id)?;
        // 계정별로 사용량 조회와 토큰 회전을 직렬화해 수동·자동 새로고침이 같은
        // 일회성 갱신 토큰을 동시에 소비하지 않도록 한다. 계정이 다르면 서로 막지
        // 않으므로 여러 계정을 동시에 조회할 수 있다.
        let usage_lock = self.usage_refresh_lock(&account.id)?;
        let _usage_refresh = lock(&usage_lock, "계정 사용량 갱신")?;
        // CLI가 프로필에서 토큰을 회전했으면 볼트가 뒤처져 있다. 조회 전에 맞춰 두면
        // 만료된 토큰으로 401을 받고 재인증을 요구하는 일을 피한다. 공유 CLI 홈은 보지
        // 않는다 — 모든 계정의 정본은 자기 프로필과 볼트이고, 공유 홈에 든 값은 다른
        // 로그인의 것일 수 있다. 격리 판정은 갱신 미루기와 같은
        // [`Self::credential_profile_isolated`]를 쓴다.
        if self.credential_profile_isolated(account.provider, &account.id) {
            if let Ok(dir) = credential_profiles::profile_dir(
                &self.inner.app_data_dir,
                account.provider,
                &account.id,
            ) {
                if dir.is_dir() {
                    let _ = self.sync_profile_credential(&account, &dir);
                }
            }
        }
        let (fresh_usage, credential_rejected) = match account.provider {
            ProviderId::Codex => self.fetch_codex_usage_with_cli(&account),
            ProviderId::Claude => self.fetch_claude_usage_with_refresh(&account),
            ProviderId::Antigravity => self.fetch_antigravity_usage(&account),
            ProviderId::Local => Err(unmanaged_provider_error(account.provider)),
        }
        .unwrap_or_else(|error| (usage_error_result(error), false));
        let auth_status = reconciled_auth_status_after_usage(
            account.auth_status,
            fresh_usage.status,
            credential_rejected,
        );
        let usage = apply_usage_stale_policy(fresh_usage, &account.usage);
        // 사슬 만료 시각은 조회가 끝난 뒤에 읽는다. 이번 조회가 토큰을 회전시켰거나
        // 프로필의 새 사슬을 채택했으면 그 값이 저장된 뒤라야 지금 사슬의 만료가 잡힌다.
        // 볼트 읽기 한 번이 늘지만, 이 경로는 이미 공급자 API를 왕복한 뒤다.
        let credential_expires_at = self.stored_credential_expires_at(&account);
        let usage_exhausted = usage_indicates_exhaustion(&usage);
        let usage_sample = usage.clone();
        let mut state = lock(&self.inner.state, "계정 상태")?;
        // 분산 교체는 소진보다 약한 트리거라 소진이 있으면 그쪽이 이긴다. 격차 판정은
        // 다른 계정의 사용량을 함께 봐야 해서 여기서 끝낼 수 없다. 설정이 켜져 있고
        // 이번 조회가 성공했으면 신호만 보내고, 실제 격차는 후보를 고르는
        // `select_auto_switch_target`이 판정한다(후보가 없으면 `plan_auto_switches`가
        // 곧바로 None이라 부작용이 없다).
        let usage_spread_candidate = !usage_exhausted
            && state.registry.auto_switch_usage_gap_percent.is_some()
            && usage.status == AccountUsageStatus::Ok;
        let (provider, auto_switch_enabled) = {
            let account = account_by_id_mut(&mut state.registry, account_id)?;
            account.auth_status = auth_status;
            account.usage = usage;
            // 읽지 못했으면 기록을 지우지 않는다. 볼트 읽기 실패는 사슬이 사라졌다는
            // 뜻이 아니고, 지우면 남은 기간을 아는 계정의 만료 예고가 조용히 꺼진다.
            if credential_expires_at.is_some() {
                account.credential_expires_at = credential_expires_at;
            }
            account.updated_at = now_ms();
            (account.provider, account.auto_switch)
        };
        save_registry(&self.inner.app_data_dir, &state.registry)?;
        drop(state);
        // 페이싱 표본은 이 지점 하나에서만 남긴다. 사용량이 계정 레코드에 반영되는
        // 경로가 여기뿐이라, 수동 새로고침·주기 갱신·자동전환 판정이 모두 같은 표본을
        // 본다. 실패해도 갱신을 막지 않는다(파생 데이터).
        crate::usage_pacing::record_usage_sample(
            &self.inner.app_data_dir,
            account_id,
            &usage_sample,
        );
        // 주기 이력도 같은 지점에서 남긴다. 주기가 끝나면 공급자는 그 주기의 값을
        // 잊으므로, 기간별 소비율은 이 이력으로만 계산할 수 있다.
        crate::usage_history::record_usage(&self.inner.app_data_dir, account_id, &usage_sample);
        let reason = if usage_exhausted {
            Some(AutoSwitchReason::UsageExhausted)
        } else if usage_spread_candidate {
            Some(AutoSwitchReason::UsageSpread)
        } else {
            None
        };
        if let Some(reason) = reason.filter(|_| auto_switch_enabled) {
            self.signal_auto_switch(AutoSwitchSignal {
                provider,
                account_id: account_id.to_owned(),
                reason,
                // 사용량 조회에서 온 트리거는 채팅을 특정할 수 없으므로 이 계정에
                // 묶인 세션 전체가 대상이다. 모델은 여기서 모른다 — 전환 루프가 묶인
                // 세션들에서 채운다.
                chat_id: None,
                models: Vec::new(),
            });
        }
        self.snapshot()
    }

    /// 등록된 계정 사용량을 계정별로 동시에 다시 조회한다. 계정 하나의 실패가 나머지
    /// 갱신을 막지 않으며, 결과는 마지막에 한 번만 스냅샷으로 돌려준다(계정별 응답이
    /// 전체 스냅샷이라 순차 호출은 서로의 결과를 덮어쓴다).
    /// 재시도 대기(`retry_at`)가 남은 계정은 건너뛴다. 대기 중인 계정을 매 주기
    /// 다시 두드리면 429 응답이 그 대기 시각을 또 미뤄, 예정된 재시도 시점에
    /// 영구히 도달하지 못한다. 프론트엔드도 같은 판정으로 대상을 고르지만
    /// (`usageRefreshDeferred`), 이 호출은 대상 하나만 낡아도 등록된 계정 전체를
    /// 갱신하므로 여기서 다시 걸러야 한다.
    /// 아직 자기 주기가 돌아오지 않은 계정도 건너뛴다. 계정 하나가 낡았다고 나머지를
    /// 함께 다시 읽으면, 아무것도 돌지 않아 사용량이 올라갈 수 없는 계정까지 활성
    /// 계정과 같은 빈도로 공급자 API를 두드리게 된다.
    /// `force`는 사용자가 직접 새로고침을 눌렀을 때만 쓴다. 주기를 무시하고 대상
    /// 전체를 다시 읽어, 방금 조회한 계정이 섞여 있다고 해서 누른 버튼이 아무 일도
    /// 하지 않는 것처럼 보이지 않게 한다. 재시도 대기(`retry_at`)는 force여도 지킨다 —
    /// 그건 공급자가 기다리라고 한 시각이라 사용자가 무를 수 있는 것이 아니다.
    pub fn refresh_all_usage(
        &self,
        provider: Option<ProviderId>,
        force: bool,
    ) -> Result<AccountSnapshot, CoreError> {
        let now = now_ms();
        let (targets, deferred): (Vec<String>, Vec<String>) = {
            let state = lock(&self.inner.state, "계정 상태")?;
            let mut targets = Vec::new();
            let mut deferred = Vec::new();
            for account in state.registry.accounts.iter().filter(|account| {
                account.provider.manages_accounts()
                    && !account.disabled
                    && provider.is_none_or(|provider| account.provider == provider)
            }) {
                let busy = state
                    .registry
                    .provider(account.provider)
                    .is_ok_and(|provider| {
                        provider.active_account_id.as_deref() == Some(account.id.as_str())
                    })
                    || state
                        .runtime_account_counts
                        .get(&account.id)
                        .is_some_and(|count| *count > 0);
                if !force && usage_refresh_fresh_for_interval(&account.usage, now, busy) {
                    continue;
                }
                if usage_refresh_deferred(&account.usage, now) {
                    deferred.push(account.id.clone());
                } else {
                    targets.push(account.id.clone());
                }
            }
            (targets, deferred)
        };
        if !deferred.is_empty() {
            eprintln!(
                "[usage] 재시도 대기가 남은 계정 {}개의 사용량 갱신을 건너뜁니다: {}",
                deferred.len(),
                deferred.join(", ")
            );
        }
        let handles: Vec<_> = targets
            .into_iter()
            .map(|account_id| {
                let supervisor = self.clone();
                std::thread::spawn(move || {
                    if let Err(error) = supervisor.refresh_usage(&account_id) {
                        eprintln!("[usage] 계정 {account_id} 사용량 갱신 실패: {error}");
                    }
                })
            })
            .collect();
        for handle in handles {
            let _ = handle.join();
        }
        // 홈 계정도 같은 주기로 읽는다. 등록 계정과 신원이 겹치지 않는 홈 로그인만
        // 대상이고, 조회는 읽기 전용이라 공유 홈을 건드리지 않는다. 스냅샷 경로가
        // 아니라 여기에 두는 이유는 네트워크 호출이 계정 목록 폴링을 막지 않게 하기
        // 위해서다.
        for target in managed_providers() {
            if provider.is_some_and(|provider| provider != target) {
                continue;
            }
            if let Err(error) = self.refresh_home_usage(target, force) {
                eprintln!(
                    "[usage] {} 홈 계정 사용량 갱신 실패: {error}",
                    target.as_str()
                );
            }
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
        let account = self.account_record(account_id)?;
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
        // Antigravity 토큰에는 신원이 들어 있지 않고 계정을 묻는 명령도 없다. 자격증명이
        // 온전한지만 보고, 신원은 등록된 값을 그대로 확인값으로 쓴다 — 이 값은 그 계정의
        // 격리 프로필 로그인에서 온 것이라 자리 자체가 계정을 말한다(`C12-4a`).
        if account.provider == ProviderId::Antigravity
            && !credential_is_complete(account.provider, &secret)
        {
            return Err(CoreError::Conflict(
                "저장된 자격증명에 로그인 토큰이 없습니다. 이 계정을 재인증하세요".to_owned(),
            ));
        }
        let identity = match account.provider {
            ProviderId::Codex => codex_identity(&secret)?,
            ProviderId::Claude => (self.inner.claude_identity_resolver)(&secret)?,
            ProviderId::Antigravity => {
                antigravity_identity(&secret).unwrap_or_else(|_| AccountIdentity {
                    provider_account_id: account.provider_account_id.clone(),
                    legacy_provider_account_id: None,
                    email: account.email.clone(),
                    organization: account.organization.clone(),
                    display_name: None,
                })
            }
            ProviderId::Local => return Err(unmanaged_provider_error(account.provider)),
        };
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

    /// Codex 공식 app-server가 제공하는 `account/rateLimits/read`로 사용량을 읽는다.
    /// app-server가 액세스 토큰을 갱신하면 C4 프로필에 기록된 새 사슬을 Vault로 다시
    /// 채택한다. 공식 API가 없는 구버전 CLI에서만 기존 읽기 전용 HTTP 조회로 폴백한다.
    /// 이 계정의 홈으로 `/usage`를 묻는다. Antigravity에는 계정을 인자로 받는 조회가 없어
    /// 홈을 바꾸는 것이 곧 계정을 고르는 일이다(C12-7).
    ///
    /// 프로필을 준비하지 않는다. 준비 경로는 프로브로 CLI를 한 번 더 띄우는데, 그 프로브가
    /// 쓰는 명령이 바로 이 `/usage`라 조회 한 번이 두 번이 된다. 자리만 계산해 넘긴다.
    fn fetch_antigravity_usage(
        &self,
        account: &AccountRecord,
    ) -> Result<(AccountUsageView, bool), CoreError> {
        // 조회만 하러 와도 프로필을 먼저 세운다. 자리가 없으면 자격증명이 볼트에 멀쩡히
        // 있는데도 "토큰 없음"으로 판정돼 계정 카드가 재인증을 요구한다.
        let home = credential_profiles::ensure_profile_dir(
            &self.inner.app_data_dir,
            ProviderId::Antigravity,
            &account.id,
        )?;
        credential_profiles::prepare_antigravity_profile(
            &home,
            self.provider_root(ProviderId::Antigravity)?,
            &self.inner.home_dir,
        )?;
        ensure_profile_keychain(&home)?;
        self.sync_profile_credential(account, &home)?;
        // 토큰이 없으면 CLI가 브라우저 로그인 창을 띄우고 기다린다. 조회 실패가 아니라
        // 자격증명 문제로 알려, 계정 카드가 재인증을 안내하게 한다.
        if !antigravity_credentials_present(&home) {
            return Ok((
                usage_error_result(CoreError::Runtime(
                    "Antigravity 계정 홈에 로그인 토큰이 없습니다".to_owned(),
                )),
                true,
            ));
        }
        let env = credential_profiles::profile_env(
            ProviderId::Antigravity,
            &home,
            self.provider_root(ProviderId::Antigravity)?,
        )?;
        // C12-11 2단계. 사용량 조회도 프로필 HOME으로 뜨는 실행이다. 항목을 비우지 않으면 CLI가
        // 그 항목의 계정으로 답해 카드가 다른 로그인의 잔량을 보인다(C12-5가 기록한 증상).
        self.clear_antigravity_global_login_for_start("사용량 조회")?;
        Ok((crate::antigravity_usage::account_usage(&home, &env), false))
    }

    fn fetch_codex_usage_with_cli(
        &self,
        account: &AccountRecord,
    ) -> Result<(AccountUsageView, bool), CoreError> {
        let direct = || {
            self.inner
                .vault
                .get(&vault_key(account))
                .and_then(|secret| fetch_codex_usage(&secret))
        };
        let Some(executable) = probe_executable(ProviderId::Codex) else {
            return direct();
        };
        let Some(profile) = self.runtime_credential_profile(ProviderId::Codex, &account.id)? else {
            return direct();
        };

        let response = request_codex_usage_from_app_server(&executable, &profile.env);
        // 공식 CLI가 성공 응답 전 토큰을 회전했을 수도 있으므로 성공·실패와 무관하게
        // 프로필을 다시 읽는다. 값은 Rust Core 안에서만 다루고 프론트로 내보내지 않는다(G4).
        self.sync_profile_credential(account, &profile.dir)?;
        match response? {
            CodexCliUsageResponse::Usage(usage) => Ok((usage, false)),
            CodexCliUsageResponse::Unsupported => direct(),
            CodexCliUsageResponse::CredentialRejected => Ok((
                usage_retry_soon(
                    "Codex 공식 CLI가 자격증명을 갱신하지 못했습니다. 이 계정을 다시 인증해 주세요",
                ),
                true,
            )),
        }
    }

    /// Claude 사용량을 볼트 자격증명으로 조회한다. 액세스 토큰이 만료됐으면 리프레시
    /// 토큰으로 갱신하되, 이 계정으로 도는 런타임이 있으면 CLI가 회전 주인이라 미룬다.
    fn fetch_claude_usage_with_refresh(
        &self,
        account: &AccountRecord,
    ) -> Result<(AccountUsageView, bool), CoreError> {
        let key = vault_key(account);
        let secret = self.inner.vault.get(&key)?;
        if !claude_access_token_expired(&secret, now_ms()) {
            // 401만 여기서 흘려보낸다 — 아래 갱신 경로가 이어받는다.
            if let Some(usage) = request_claude_usage(&secret)?.into_usage_or_unauthorized() {
                return Ok((usage, false));
            }
        }
        if let Some(retry_at) = token_refresh_retry_pending(&account.usage, now_ms()) {
            // 갱신 엔드포인트의 429는 재시도 대기가 끝날 때까지 다시 보내지 않는다.
            // 대기 중에 또 보내면 서버가 같은 429로 대기 시각을 새로 잡아, 예정된
            // 재시도 시점이 시도할 때마다 뒤로 밀린다. 대기 시각은 그대로 돌려준다.
            return Ok((
                token_refresh_limited_usage_result(
                    "Claude 토큰 갱신 제한(HTTP 429)이 아직 풀리지 않아 갱신을 미룹니다",
                    retry_at,
                    // 이번엔 요청을 보내지 않았으므로 연속 횟수를 늘리지 않는다.
                    account.usage.token_refresh_throttle_streak,
                ),
                false,
            ));
        }
        if let Some(reason) = self.claude_refresh_deferred(&account.id)? {
            return Ok((usage_retry_soon(reason), false));
        }
        let refreshed = match refresh_claude_oauth_secret(
            &secret,
            account.usage.token_refresh_throttle_streak,
        )? {
            ClaudeTokenRefresh::Refreshed(refreshed) => refreshed,
            ClaudeTokenRefresh::RateLimited { retry_at, streak } => {
                return Ok((
                    token_refresh_limited_usage_result(
                        "Claude 토큰 갱신이 제한되었습니다 (HTTP 429). 기존 자격증명을 유지합니다",
                        retry_at,
                        streak,
                    ),
                    false,
                ));
            }
            ClaudeTokenRefresh::Rejected(message) => {
                return Ok((usage_retry_soon(message), true));
            }
        };
        let refreshed = self.commit_refreshed_claude_credential(account, refreshed)?;
        match request_claude_usage(&refreshed)?.into_usage_or_unauthorized() {
            Some(usage) => Ok((usage, false)),
            // 갱신까지 마친 토큰이 401이면 자격증명이 거부된 것이다. 오류로 올리면
            // 계정은 `ready`로 남으므로, 거부 신호를 붙여 재인증으로 내린다.
            None => Ok((
                usage_retry_soon(
                    "Claude 사용량 조회가 실패했습니다 (HTTP 401 Unauthorized). 토큰을 갱신해도 인증이 거부되어 계정을 다시 인증해야 합니다",
                ),
                true,
            )),
        }
    }

    /// 앱이 회전시킨 Claude 자격증명을 볼트와 격리 프로필에 함께 저장한다. CLI는 프로필만
    /// 읽으므로 새 토큰을 볼트에만 남기면 앱이 회전시킨 사슬을 CLI가 따라가지 못하고, 다음
    /// 실행이 이미 소비된 리프레시 토큰을 다시 제출해 갱신조차 못 하는 상태로 굳는다.
    fn commit_refreshed_claude_credential(
        &self,
        account: &AccountRecord,
        refreshed: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, CoreError> {
        self.inner.vault.put(&vault_key(account), &refreshed)?;
        self.mirror_credential_to_profile(account, &refreshed)?;
        Ok(refreshed)
    }

    /// 이 공급자로 런타임 하나를 시작할 권리. 등록 계정이 있으면 요청 계정(없으면 기본
    /// 계정)에 귀속되고, 그 계정의 격리 프로필이 준비되어야 한다 — 모든 계정은 자기
    /// 프로필로만 실행되며 공유 CLI 홈으로 폴백하지 않는다. 등록 계정이 하나도 없는
    /// 공급자는 계정에 귀속되지 않은 채 공유 홈으로 실행한다(첫 설정 경로).
    pub fn acquire_runtime(
        &self,
        provider: ProviderId,
        requested_account_id: Option<&str>,
    ) -> Result<AccountRuntimeLease, CoreError> {
        if !provider.manages_accounts() {
            return Ok(self.lease(provider, None));
        }
        // 귀속 계정을 먼저 정한다. 격리 준비는 공급자 CLI 프로브까지 돌리므로(최대 20초)
        // 잠금 밖에서 끝낸다. 전환 잠금이나 계정 상태 잠금을 쥔 채 프로브를 돌리면 그
        // 시간 동안 같은 공급자의 다른 채팅 시작이 전부 멈춘다.
        let account_id = self.runtime_account_id(provider, requested_account_id)?;
        if let Some(account_id) = account_id.as_deref() {
            self.prepare_runtime_isolation(provider, account_id);
        }
        let _switch = self.credential_switch_guard(provider)?;
        let mut state = lock(&self.inner.state, "계정 상태")?;
        if let Some(account_id) = account_id.as_deref() {
            // 계정 상태는 잠금 밖에서 프로브를 도는 사이에 바뀔 수 있으므로 다시 확인한다.
            ensure_account_runnable(&state.registry, account_id, provider)?;
            self.ensure_runtime_isolation_ready(account_id)?;
        }
        *state.runtime_counts.entry(provider).or_default() += 1;
        if let Some(account_id) = account_id.as_deref() {
            *state
                .runtime_account_counts
                .entry(account_id.to_owned())
                .or_default() += 1;
        }
        Ok(self.lease(provider, account_id))
    }

    /// 이 런타임이 귀속될 계정. 등록 계정이 없는 공급자는 `None`(공유 홈 실행)이고,
    /// 있으면 요청 계정이나 활성 계정이 실행 가능한지까지 확인해 돌려준다. 계정 상태
    /// 잠금은 이 판정 동안만 쥔다 — 이어지는 격리 준비가 공급자 CLI를 띄우기 때문이다.
    fn runtime_account_id(
        &self,
        provider: ProviderId,
        requested_account_id: Option<&str>,
    ) -> Result<Option<String>, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
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
            return Ok(None);
        }
        let account_id = requested_account_id
            .map(str::to_owned)
            .or_else(|| {
                state
                    .registry
                    .provider(provider)
                    .ok()
                    .and_then(|provider_state| provider_state.active_account_id.clone())
            })
            .ok_or_else(|| {
                CoreError::Conflict("이 공급자의 활성 계정을 선택해야 합니다".to_owned())
            })?;
        ensure_account_runnable(&state.registry, &account_id, provider)?;
        Ok(Some(account_id))
    }

    /// 격리 프로필이 준비됐는지. 판정은 [`Self::prepare_runtime_isolation`]이 캐시에 남긴
    /// 결과만 읽는다(잠금 순서: 계정 상태 → 프로필). 격리를 못 쓴 이유를 함께 알리되,
    /// 사유는 고정 문구라 자격증명을 담지 않는다.
    fn ensure_runtime_isolation_ready(&self, account_id: &str) -> Result<(), CoreError> {
        if self.credential_profile_active(account_id) {
            return Ok(());
        }
        Err(CoreError::Conflict(
            match self.credential_profile_fallback_reason(account_id) {
                Some(reason) => format!(
                    "자격증명 격리를 준비하지 못해 이 계정으로 실행할 수 없습니다: {reason}"
                ),
                None => "자격증명 격리를 준비하지 못해 이 계정으로 실행할 수 없습니다".to_owned(),
            },
        ))
    }

    /// 런타임 한 벌의 임대 발급. 실행 수 증가는 호출부가 이미 끝냈고, 반납은
    /// [`AccountRuntimeLease::release`]가 맡는다.
    fn lease(&self, provider: ProviderId, account_id: Option<String>) -> AccountRuntimeLease {
        AccountRuntimeLease {
            accounts: self.clone(),
            provider,
            account_id,
            released: false,
        }
    }

    /// 계정에 귀속되지 않는 관리 터미널(CLI 설정·격리 로그인)도 provider runtimeCount에
    /// 포함한다. 계정이 아직 등록되지 않은 상태에서도 실행되어야 하므로 accountId 검증은
    /// 하지 않는다. `kind`는 호출 지점이 어느 저장소로 뜨는지 밝히기 위한 표식이다.
    pub(crate) fn acquire_unscoped_runtime(
        &self,
        provider: ProviderId,
        _kind: UnscopedRuntimeKind,
    ) -> Result<AccountRuntimeLease, CoreError> {
        let _switch = self.credential_switch_guard(provider)?;
        let mut state = lock(&self.inner.state, "계정 상태")?;
        *state.runtime_counts.entry(provider).or_default() += 1;
        Ok(self.lease(provider, None))
    }

    pub fn active_account_id(&self, provider: ProviderId) -> Result<Option<String>, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        Ok(state.registry.provider(provider)?.active_account_id.clone())
    }

    pub fn account_is_enabled_for_provider(
        &self,
        provider: ProviderId,
        account_id: &str,
        model: Option<&str>,
    ) -> Result<bool, CoreError> {
        Ok(self.run_readiness(provider, account_id, model)? == RunReadiness::Ready)
    }

    /// 이 계정으로 지금 실행할 수 있는지, 못 한다면 그 이유가 되돌아올 수 있는
    /// 것인지 구분해서 준다.
    ///
    /// `account_is_enabled_for_provider`는 셋을 bool 하나로 뭉쳐서, 사용자가 끈
    /// 계정과 잠깐 인증 상태를 잃은 계정이 같은 취급을 받는다. `auth_status`는
    /// 공유 홈 자격증명 확인이 401이나 중간에 끊긴 기록을 만나면 `Error`가 됐다가
    /// 다음 사용량 조회가 성공하면 `Ready`로 돌아오는 일시 상태라
    /// ([`reconciled_auth_status_after_usage`]), 반복 실행이 이걸 실패로 확정하면
    /// 몇 분 뒤면 회복될 상태 때문에 예약된 회차가 통째로 날아간다.
    pub fn run_readiness(
        &self,
        provider: ProviderId,
        account_id: &str,
        model: Option<&str>,
    ) -> Result<RunReadiness, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        let account = account_by_id(&state.registry, account_id)?;
        Ok(account_readiness(account, provider, model, now_ms()))
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

    /// 이 계정의 토큰 갱신을 미뤄야 하는 이유. 판정 규칙은 [`claude_refresh_deferral`]에 있다.
    fn claude_refresh_deferred(&self, account_id: &str) -> Result<Option<&'static str>, CoreError> {
        Ok(claude_refresh_deferral(
            self.account_runtime_count(account_id)? > 0,
        ))
    }

    fn upsert_captured_account(
        &self,
        provider: ProviderId,
        existing_account_id: Option<&str>,
        display_name: Option<String>,
        captured: CapturedCredentials,
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
                format!("{provider}:{}", captured.identity.provider_account_id).as_bytes(),
            );
            (format!("{provider}-{}", hex_prefix(&digest, 10)), false)
        };
        let registry_before = state.registry.clone();
        let vault_key = provider_vault_key(provider, &account_id);
        let old_secret = self.inner.vault.get(&vault_key).ok();
        self.inner.vault.put(&vault_key, &captured.secret)?;
        let credential_changed = old_secret
            .as_ref()
            .is_none_or(|old| !same_secret(old.as_str(), captured.secret.as_str()));
        // 방금 받은 사슬의 만료를 그 자리에서 적는다. 사용량 조회를 기다리면 재인증
        // 직후의 계정만 만료를 모르는 상태로 남아, 정작 새로 인증한 계정에서 예고가
        // 늦게 켜진다.
        let credential_expires_at = credential_chain_expires_at(provider, &captured.secret);
        if let Some(account) = state
            .registry
            .accounts
            .iter_mut()
            .find(|account| account.id == account_id)
        {
            if migrates_legacy_identity {
                account.provider_account_id = captured.identity.provider_account_id.clone();
                account.usage = AccountUsageView::default();
            } else if credential_changed {
                // 자격증명을 새로 저장했으면 이전 자격증명이 남긴 조회 실패는 더 이상
                // 현재 상태가 아니다. 오류와 재시도 대기를 지우지 않으면 재인증 직후에도
                // 낡은 오류가 그대로 보이고, 남은 대기 때문에 다음 조회까지 미뤄진다.
                account.usage = usage_error_cleared(&account.usage);
            }
            account.display_name =
                normalized_display_name(display_name, &captured.identity, &account.display_name);
            account.email = captured.identity.email;
            account.organization = captured.identity.organization;
            account.auth_status = AccountAuthStatus::Ready;
            if credential_expires_at.is_some() {
                account.credential_expires_at = credential_expires_at;
            }
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
                auto_switch_priority: None,
                auth_status: AccountAuthStatus::Ready,
                usage: AccountUsageView::default(),
                note: None,
                label: None,
                credential_expires_at,
                created_at: now,
                updated_at: now,
            });
        }
        // 첫 계정은 기본 계정이 된다. 그 뒤로는 사용자가 고른 기본 계정을 바꾸지 않는다.
        // 재인증으로 자격증명이 바뀐 계정의 격리 프로필은 다음 실행 준비나 사용량 갱신의
        // 프로필 동기화가 볼트(더 새 사슬)로 맞춘다.
        let provider_state = state.registry.provider_mut(provider)?;
        if provider_state.active_account_id.is_none() {
            provider_state.active_account_id = Some(account_id.clone());
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
        Ok(())
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
    }

    fn capture_credentials(
        &self,
        provider: ProviderId,
        profile: Option<&Path>,
    ) -> Result<CapturedCredentials, CoreError> {
        let secret = match self.read_credentials(provider, profile) {
            Ok(secret) => secret,
            // C12-11 1단계. 로그인이 기계 전역 항목에 들어가는 플랫폼에서는 임시 프로필 HOME에
            // 토큰 파일이 남지 않는다 — CLI는 항목에 쓰고 파일 고리는 건너뛴다. 그 항목이
            // 곧 이 로그인이므로 거기서 회수한다. 항목의 값은 토큰 파일 하나의 내용과 같은
            // 모양이라 봉투의 파일 자리에 그대로 들어간다(두 파일 자리에 같은 값을 심어
            // 실행에 성공한 2026-09-24 실측).
            Err(error) if provider == ProviderId::Antigravity => {
                match credential_profiles::read_antigravity_global_login()? {
                    Some(login) => antigravity_envelope_from_global_login(&login)?,
                    None => return Err(error),
                }
            }
            Err(error) => return Err(error),
        };
        validate_captured_provider_credential(provider, &secret)?;
        let identity = match read_identity(
            &self.inner.home_dir,
            self.provider_root(provider)?,
            provider,
            profile,
            &secret,
        ) {
            Ok(identity) => identity,
            // G6: 최신 Claude CLI 자격증명에는 계정 UUID가 없고 격리 로그인
            // 프로필에도 oauthAccount 메타데이터가 남지 않을 수 있다. 이때 공유
            // ~/.claude.json을 추측 근거로 쓰지 않고, 방금 발급된 자격증명으로
            // 공식 프로필 API를 조회해 동일 계정 여부를 확정한다.
            Err(_) if provider == ProviderId::Claude => {
                (self.inner.claude_identity_resolver)(&secret).map_err(|error| {
                    CoreError::Runtime(format!(
                        "Claude 로그인 계정 신원을 확인하지 못했습니다: {error}"
                    ))
                })?
            }
            Err(error) => return Err(error),
        };
        Ok(CapturedCredentials { secret, identity })
    }

    /// 잠금 밖에서 쓸 계정 한 벌. 계정 상태 잠금은 이 호출 안에서만 잡았다 놓는다 —
    /// 잠금을 쥔 채 볼트·프로필·CLI를 건드리면 스냅샷 경로와 순서가 엇갈린다.
    fn account_record(&self, account_id: &str) -> Result<AccountRecord, CoreError> {
        let state = lock(&self.inner.state, "계정 상태")?;
        Ok(account_by_id(&state.registry, account_id)?.clone())
    }

    /// 이 계정으로 CLI를 띄울 때 넣을 자격증명 프로필. 격리를 지원하지 않는
    /// 공급자거나 프로브가 실패하면 `None`을 주고, 호출자는 지금까지처럼 공유 홈
    /// 자격증명으로 실행한다.
    ///
    /// 프로필은 이 호출에서 만들어지고 볼트와 동기화된다. CLI가 실행 중에 토큰을
    /// 회전하면 프로필 쪽이 더 새로우므로, 신원이 같은 값일 때만 볼트로 채택해
    /// 앱의 사용량 조회도 같은 토큰 사슬을 쓰게 한다.
    pub fn runtime_credential_profile(
        &self,
        provider: ProviderId,
        account_id: &str,
    ) -> Result<Option<RuntimeCredentialProfile>, CoreError> {
        match self.cached_credential_profile(account_id, now_ms())? {
            Some(CachedCredentialProfile::Unsupported) => return Ok(None),
            Some(CachedCredentialProfile::Ready { dir, env }) => {
                let account = self.account_record(account_id)?;
                self.sync_profile_credential(&account, &dir)?;
                if provider == ProviderId::Antigravity {
                    self.clear_antigravity_global_login_for_start("실행 시작")?;
                }
                return Ok(Some(RuntimeCredentialProfile {
                    provider,
                    account_id: account_id.to_owned(),
                    dir,
                    env,
                }));
            }
            None => {}
        }
        let account = self.account_record(account_id)?;
        if account.provider != provider {
            return Err(CoreError::InvalidInput(
                "계정과 공급자가 일치하지 않습니다".to_owned(),
            ));
        }
        let (dir, env) = self.prepare_credential_profile(provider, account_id)?;
        self.sync_profile_credential(&account, &dir)?;
        // C12-11 2단계. 프로브도 실행이다 — 항목이 남아 있으면 프로브가 그 계정으로 통과해
        // 격리가 된 것처럼 보인다. 프로브 자체가 갱신하면 항목을 되살리므로 반환 직전에 한 번
        // 더 비운다.
        if provider == ProviderId::Antigravity {
            self.clear_antigravity_global_login_for_start("격리 프로브")?;
        }
        let outcome = self.probe_prepared_profile(provider, &account, &dir, &env);
        let profile = self.record_credential_probe(provider, account_id, dir, env, outcome)?;
        if profile.is_some() && provider == ProviderId::Antigravity {
            self.clear_antigravity_global_login_for_start("실행 시작")?;
        }
        Ok(profile)
    }

    /// C12-11 1·2단계. 기계 전역 로그인 항목을 계정 전환 잠금 안에서 비운다. 그 항목이 있는
    /// 동안 어느 HOME에서 뜬 CLI든 그 계정 하나로 인증되므로, 로그인 터미널이 브라우저에 닿기
    /// 전과 계정별 실행이 뜨기 직전에 부른다. 잠금은 시작 구간만 줄 세운다 — 실행은 겹친다.
    /// 전역 저장소가 아닌 플랫폼에서는 아무것도 하지 않는다(`credential_profiles`가 판정).
    fn clear_antigravity_global_login_for_start(&self, stage: &str) -> Result<(), CoreError> {
        if !credential_profiles::antigravity_login_is_machine_global() {
            return Ok(());
        }
        let _switch = self.credential_switch_guard(ProviderId::Antigravity)?;
        if credential_profiles::clear_antigravity_global_login()? {
            eprintln!(
                "[credential-profile] antigravity {stage} 전에 기계 전역 로그인 항목을 비웠습니다(C12-11)"
            );
        }
        Ok(())
    }

    /// C12-11 3단계. 시작 직후 CLI가 자기 로그에 남긴 계정 이메일이 요청한 계정과 같은지.
    /// 전역 항목을 비운 뒤 이 프로세스가 인증을 읽기까지의 틈에 다른 실행의 갱신이 항목을
    /// 되살리면 CLI는 그 계정으로 조용히 성공한다(C12-8이 재개에서 겪은 것과 같은 모양).
    /// 공급자 자신의 신호로 확인해 그 실패를 검출되는 거부로 바꾼다. 전역 저장소가 아닌
    /// 플랫폼에서는 그 틈 자체가 없어 `NotApplicable`이다.
    pub fn antigravity_runtime_identity_check(&self, account_id: &str) -> AntigravityIdentityCheck {
        if !credential_profiles::antigravity_login_is_machine_global() {
            return AntigravityIdentityCheck::NotApplicable;
        }
        let Ok(account) = self.account_record(account_id) else {
            return AntigravityIdentityCheck::Pending;
        };
        let expected = account
            .email
            .as_deref()
            .unwrap_or(account.provider_account_id.as_str());
        let Some(dir) = self.validated_profile_dir(ProviderId::Antigravity, account_id) else {
            return AntigravityIdentityCheck::Pending;
        };
        match antigravity_authenticated_email_from_cli_log(&dir) {
            None => AntigravityIdentityCheck::Pending,
            Some(observed) => compare_antigravity_identity(expected, &observed),
        }
    }

    /// 캐시가 이미 답하는 준비 결과. 값만 꺼내고 프로필 잠금을 그 자리에서 놓는다.
    /// 프로필 잠금을 쥔 채 계정 상태 잠금을 잡으면 스냅샷 경로(계정 상태 → 프로필)와
    /// 순서가 엇갈려 교착에 빠지므로, 잠금 순서는 항상 계정 상태 → 프로필 하나로
    /// 유지한다. 실패 캐시는 재시도 시각까지만, 성공 캐시는 재확인 시한까지만
    /// 유효하다. 지난 항목은 없는 것처럼 둬 호출자가 프로필과 프로브를 다시 준비한다.
    fn cached_credential_profile(
        &self,
        account_id: &str,
        now: i64,
    ) -> Result<Option<CachedCredentialProfile>, CoreError> {
        Ok(lock(&self.inner.credential_profiles, "자격증명 프로필")?
            .get(account_id)
            .and_then(|entry| match entry {
                CredentialProfileEntry::Unsupported { retry_at, .. } => {
                    (*retry_at > now).then_some(CachedCredentialProfile::Unsupported)
                }
                CredentialProfileEntry::Ready {
                    dir,
                    env,
                    verified_at,
                } => {
                    (verified_at.saturating_add(CREDENTIAL_PROFILE_READY_TTL_MS) > now).then(|| {
                        CachedCredentialProfile::Ready {
                            dir: dir.clone(),
                            env: env.clone(),
                        }
                    })
                }
            }))
    }

    /// 프로필 자리와 환경변수를 만들고 공급자별 준비까지 끝낸다. 자격증명을 볼트와
    /// 맞추는 일은 호출자가 이어서 한다 — 여기는 "어떤 자리에 무엇을 걸어 두는가"만 안다.
    fn prepare_credential_profile(
        &self,
        provider: ProviderId,
        account_id: &str,
    ) -> Result<(PathBuf, Vec<(String, String)>), CoreError> {
        let dir = credential_profiles::ensure_profile_dir(
            &self.inner.app_data_dir,
            provider,
            account_id,
        )?;
        let env = credential_profiles::profile_env(provider, &dir, self.provider_root(provider)?)?;
        match provider {
            ProviderId::Codex => {
                credential_profiles::link_shared_codex_entries(
                    &dir,
                    self.provider_root(provider)?,
                )?;
            }
            ProviderId::Antigravity => {
                credential_profiles::prepare_antigravity_profile(
                    &dir,
                    self.provider_root(provider)?,
                    &self.inner.home_dir,
                )?;
                ensure_profile_keychain(&dir)?;
            }
            ProviderId::Claude => {}
            ProviderId::Local => return Err(unmanaged_provider_error(provider)),
        }
        Ok((dir, env))
    }

    /// 준비된 프로필이 실제로 쓸 수 있는지 판정한다. 계정 확인, 사용 가능 확인, 격리
    /// 확인을 나눈다. 어느 계정인지는 프로필에 쓴 자격증명으로 보고, 그 자격증명으로
    /// 요청을 보낼 수 있는지는 값 자체로 보며, CLI 프로브는 그 저장소를 실제로 읽는지만
    /// 본다.
    fn probe_prepared_profile(
        &self,
        provider: ProviderId,
        account: &AccountRecord,
        dir: &Path,
        env: &[(String, String)],
    ) -> ProbeOutcome {
        if provider == ProviderId::Antigravity {
            // 토큰이 없으면 CLI가 print 모드에서도 브라우저 로그인 창을 띄우고 기다리므로
            // 프로브를 돌리기 전에 거른다(C12-7).
            if !antigravity_credentials_present(dir) {
                return ProbeOutcome::NotAuthenticated(
                    "프로필 홈에 공식 CLI 로그인 토큰이 없습니다".to_owned(),
                );
            }
            return (self.inner.credential_probe)(provider, env);
        }
        if let Some(reason) = self
            .profile_credential_mismatch(account, dir)
            .or_else(|| self.profile_credential_unusable(account, dir))
        {
            return ProbeOutcome::NotAuthenticated(reason);
        }
        (self.inner.credential_probe)(provider, env)
    }

    /// 프로브 판정을 캐시에 남기고 런타임에 넘길 프로필을 정한다. 격리를 쓰지 못하는
    /// 판정은 오류가 아니다 — 호출자는 `None`을 받아 공유 홈 자격증명으로 실행한다.
    fn record_credential_probe(
        &self,
        provider: ProviderId,
        account_id: &str,
        dir: PathBuf,
        env: Vec<(String, String)>,
        outcome: ProbeOutcome,
    ) -> Result<Option<RuntimeCredentialProfile>, CoreError> {
        let mut profiles = lock(&self.inner.credential_profiles, "자격증명 프로필")?;
        match outcome {
            ProbeOutcome::Ready => {
                profiles.insert(
                    account_id.to_owned(),
                    CredentialProfileEntry::Ready {
                        dir: dir.clone(),
                        env: env.clone(),
                        verified_at: now_ms(),
                    },
                );
                Ok(Some(RuntimeCredentialProfile {
                    provider,
                    account_id: account_id.to_owned(),
                    dir,
                    env,
                }))
            }
            ProbeOutcome::NotAuthenticated(reason) | ProbeOutcome::Unavailable(reason) => {
                eprintln!(
                    "[credential-profile] {provider} 계정 {account_id} 자격증명 격리를 쓰지 못해 공유 홈으로 실행합니다: {reason}",
                );
                profiles.insert(
                    account_id.to_owned(),
                    CredentialProfileEntry::Unsupported {
                        reason,
                        retry_at: now_ms().saturating_add(CREDENTIAL_PROFILE_RETRY_MS),
                    },
                );
                Ok(None)
            }
        }
    }

    /// 이 계정으로 새 런타임을 띄울 수 있는지. 세션에 묶인 계정이 삭제·중지됐으면
    /// 호출자가 활성 계정으로 되돌아가도록 false를 준다.
    pub fn account_is_usable(&self, provider: ProviderId, account_id: &str) -> bool {
        lock(&self.inner.state, "계정 상태")
            .ok()
            .and_then(|state| {
                account_by_id(&state.registry, account_id)
                    .ok()
                    .map(|account| account.provider == provider && !account.disabled)
            })
            .unwrap_or(false)
    }

    /// 이 계정을 프로필 격리로 실행할 수 있는지 확인한다. 아직 프로필을 만들지
    /// 않았으면 이 호출에서 만들고 프로브까지 돌린다. 페일오버가 대상 계정으로
    /// 세션만 옮겨도 되는지 판단할 때 쓴다.
    pub fn ensure_credential_isolation(&self, provider: ProviderId, account_id: &str) -> bool {
        matches!(
            self.runtime_credential_profile(provider, account_id),
            Ok(Some(_))
        )
    }

    /// 런타임을 시작하기 전에 계정의 격리 프로필을 준비한다. 프로브는 공급자 CLI를 실제로
    /// 띄우므로(최대 20초) 잠금 밖에서 돌리고, [`Self::acquire_runtime`]은 캐시만 읽는다.
    /// 준비 실패는 여기서 오류로 올리지 않는다. 거부 문구는 `acquire_runtime` 한 곳에서 나온다.
    fn prepare_runtime_isolation(&self, provider: ProviderId, account_id: &str) {
        if let Err(error) = self.runtime_credential_profile(provider, account_id) {
            eprintln!(
                "[credential-profile] {provider} 계정 {account_id} 격리 준비에 실패했습니다: {error}",
            );
        }
    }

    /// 프로필 격리를 쓰지 못하는 이유. 사용 중인 계정에 한해 값이 있다.
    pub fn credential_profile_fallback_reason(&self, account_id: &str) -> Option<String> {
        match lock(&self.inner.credential_profiles, "자격증명 프로필")
            .ok()?
            .get(account_id)?
        {
            CredentialProfileEntry::Unsupported { reason, .. } => Some(reason.clone()),
            CredentialProfileEntry::Ready { .. } => None,
        }
    }

    /// 이 계정이 격리 저장소를 쓰는지 디스크로 확인한다.
    ///
    /// [`Self::credential_profile_active`]가 보는 캐시는 이 프로세스에서 그 계정으로
    /// 런타임을 한 번 띄운 뒤에야 채워진다. 백엔드를 다시 띄우면 같은 계정이 잠시
    /// "격리 아님"으로 보이고, 그 창에서 앱이 토큰 회전 소유권을 도로 가져가 CLI
    /// 저장소와 사슬이 갈린다. 프로필과 그 안의 자격증명이 실제로 있으면 회전 주인은
    /// 프로세스 수명과 무관하게 CLI다.
    ///
    /// 자리만 본다. 프로필 디렉터리는 런타임 준비([`Self::runtime_credential_profile`])
    /// 한 곳에서만 만들어지므로 그 자리가 있으면 앱이 이 계정을 격리로 다룬 것이다.
    /// 안에 자격증명이 채워져 있는지는 [`Self::sync_profile_credential`]이 볼트로
    /// 맞추는 동기화의 몫이라 여기서 묻지 않는다. Keychain 조회는 `security` 하위
    /// 프로세스라, 스냅샷마다 계정 수만큼 돌릴 수 없다는 이유도 있다 — 화면의
    /// `credentialIsolated`가 이 판정을 그대로 쓴다.
    fn credential_profile_on_disk(&self, provider: ProviderId, account_id: &str) -> bool {
        self.validated_profile_dir(provider, account_id).is_some()
    }

    /// 캐시가 격리 여부를 이미 답하는가. 프로브가 성공했으면 참, 실패가 아직 유효하면
    /// 거짓, 항목이 없거나 실패의 재시도 시한이 지났으면 `None`이라 디스크로 넘긴다.
    /// 시한이 지난 실패를 없는 것으로 보는 규칙은 [`Self::runtime_credential_profile`]과
    /// 같다.
    fn credential_profile_cached(&self, account_id: &str) -> Option<bool> {
        let profiles = lock(&self.inner.credential_profiles, "자격증명 프로필").ok()?;
        match profiles.get(account_id)? {
            CredentialProfileEntry::Ready { .. } => Some(true),
            CredentialProfileEntry::Unsupported { retry_at, .. } => {
                (*retry_at > now_ms()).then_some(false)
            }
        }
    }

    /// 이 계정이 프로필 격리로 실행되는지. 격리가 살아 있으면 계정 전환이 실행 중
    /// 런타임의 자격증명을 건드리지 않는다.
    ///
    /// 재확인 시한(`CREDENTIAL_PROFILE_READY_TTL_MS`)은 여기서 보지 않는다. 그건
    /// "프로브를 다시 돌릴 때가 됐는가"이지 "이 계정이 격리 저장소를 쓰는가"가
    /// 아니다. 시한이 지났다고 이 값을 거짓으로 돌리면 토큰 회전 소유권이 앱으로
    /// 되돌아가 CLI와 다시 경쟁한다([`claude_refresh_deferral`]).
    pub fn credential_profile_active(&self, account_id: &str) -> bool {
        matches!(
            lock(&self.inner.credential_profiles, "자격증명 프로필")
                .ok()
                .as_ref()
                .and_then(|profiles| profiles.get(account_id)),
            Some(CredentialProfileEntry::Ready { .. })
        )
    }

    /// 이 계정이 격리 저장소를 쓰는가. 캐시와 디스크를 함께 본다.
    ///
    /// [`Self::credential_profile_active`]의 캐시는 이 프로세스에서 그 계정으로
    /// 런타임을 한 번 띄운 뒤에야 찬다. 갱신 경로에서 이 둘을 다르게 판정하면
    /// 백엔드를 다시 띄운 직후 "CLI 토큰을 볼트로 끌어오지도 않고 앱이 갱신하지도
    /// 않는" 창이 생겨, 유휴 계정의 토큰이 만료된 채로 굳는다.
    ///
    /// 프로브가 실패해 공유 홈으로 실행 중인 계정(`Unsupported`)은 프로필 디렉터리가
    /// 남아 있어도 격리가 아니다. 그 계정의 자격증명은 공유 홈에 있고 회전 주인도
    /// 공유 홈을 읽는 프로세스다. 디스크만 보면 이 계정을 격리로 오판해 공유 홈
    /// 동기화를 끊어 버린다.
    fn credential_profile_isolated(&self, provider: ProviderId, account_id: &str) -> bool {
        self.credential_profile_cached(account_id)
            .unwrap_or_else(|| self.credential_profile_on_disk(provider, account_id))
    }

    /// 프로필에 들어간 자격증명이 이 계정 것인지 자격증명 자체로 확인한다.
    /// [`Self::sync_profile_credential`]이 볼트 값을 프로필에 맞춘 뒤라, 여기서
    /// 걸리는 건 볼트 항목이 다른 계정으로 등록된 경우다.
    ///
    /// 자격증명에 계정 식별자가 없어 신원을 뽑지 못하면 판정할 근거가 없으므로
    /// 막지 않는다. Claude OAuth 자격증명은 토큰만 담고 `accountUuid`가 없을 때가
    /// 있는데, 그 경우 남는 신원 출처는 공유 `~/.claude.json`뿐이라 계정별 프로필을
    /// 구분하지 못한다. 같은 이유로 CLI가 보고하는 이메일도 쓰지 않는다.
    fn profile_credential_mismatch(&self, account: &AccountRecord, dir: &Path) -> Option<String> {
        let secret = self.read_profile_credentials(account.provider, dir).ok()?;
        let identity = embedded_identity(account.provider, secret.as_str())?;
        if identity_matches_account(&identity, account) {
            return None;
        }
        let reported = identity
            .email
            .as_deref()
            .unwrap_or(identity.provider_account_id.as_str());
        Some(format!("프로필이 다른 계정({reported})으로 인증되었습니다"))
    }

    /// 프로필 자격증명으로 CLI가 요청을 보낼 수 없는 이유. 보낼 수 있으면 `None`.
    ///
    /// 공급자 CLI의 인증 상태 조회는 자격증명이 있는지만 답하고 그 토큰이 살아
    /// 있는지는 답하지 않는다. 이 검사가 없으면 갱신조차 불가능한 자격증명에도
    /// 격리 허가가 나가고, 반복 실행은 대기로 남는 대신 CLI의 인증 오류로 회차를
    /// 소진한다. 액세스 토큰이 만료됐어도 리프레시 토큰이 있으면 CLI가 스스로
    /// 갱신하므로 막지 않는다.
    ///
    /// 자격증명을 읽지 못하면 판정하지 않는다. 저장소 접근 실패는 프로브가 따로
    /// 걸러 내며, 여기서 막으면 원인이 다른 실패가 같은 문구로 뭉개진다.
    fn profile_credential_unusable(&self, account: &AccountRecord, dir: &Path) -> Option<String> {
        let secret = self.read_profile_credentials(account.provider, dir).ok()?;
        if credential_can_authenticate(account.provider, secret.as_str(), now_ms()) {
            return None;
        }
        Some(
            "프로필 자격증명이 만료되어 갱신할 수 없습니다. 이 계정을 다시 인증해 주세요"
                .to_owned(),
        )
    }

    /// 프로필 자격증명을 볼트와 맞춘다. 없으면 볼트 값을 기록하고, 다르면 온전하고
    /// 유효기간이 남아 있음이 확인되며 신원이 증명된 프로필 값을 볼트로 채택한다(CLI가
    /// 회전한 최신 토큰). 하나라도 확인되지 않으면 볼트 값으로 덮어쓴다.
    fn sync_profile_credential(
        &self,
        account: &AccountRecord,
        dir: &Path,
    ) -> Result<(), CoreError> {
        let key = vault_key(account);
        let vault_secret = self.inner.vault.get(&key)?;
        let use_keychain = self.inner.inspect_external_processes;
        let profile_secret = self.read_profile_credentials(account.provider, dir).ok();
        let write_from_vault = || -> Result<(), CoreError> {
            write_active_credentials(
                dir,
                account.provider,
                Some(dir),
                use_keychain,
                &vault_secret,
            )
        };
        let Some(profile_secret) = profile_secret else {
            return write_from_vault();
        };
        if same_secret(profile_secret.as_str(), vault_secret.as_str()) {
            return self.canonicalize_profile_store(account, dir, use_keychain, &profile_secret);
        }
        // 두 저장소가 갈렸다. 어느 쪽이 정본인지는 만료 여부가 아니라 발급 시점으로
        // 가른다. 액세스 토큰이 만료된 값이라도 리프레시 토큰이 함께 회전된 최신
        // 사슬이면 CLI가 스스로 갱신해 쓸 수 있다.
        let profile_is_complete = credential_is_complete(account.provider, profile_secret.as_str());
        let profile_is_newer = credential_chain_is_newer(
            account.provider,
            profile_secret.as_str(),
            vault_secret.as_str(),
        );
        // 라이브 신원 조회는 네트워크 호출이라 채팅·터미널 시작을 붙잡는다. 볼트로는
        // 요청을 보낼 수 없거나 프로필이 더 새 사슬이라 볼트를 갈아치워야 할 때에만
        // 조회를 허용한다.
        let vault_unusable = !credential_is_complete(account.provider, vault_secret.as_str())
            || self.credential_expired(account.provider, vault_secret.as_str());
        // 프로필이 더 새 사슬이라고 증명되거나, 발급 시점을 비교할 수 없을 때에 한해
        // 로컬에서 쓸 수 있어 보이면 정본으로 올린다. 비교가 가능한데 프로필이 더
        // 오래됐으면 절대 올리지 않는다 — 판정 근거는 [`profile_chain_current`].
        let profile_is_current = profile_chain_current(
            profile_is_newer,
            credential_chains_comparable(
                account.provider,
                profile_secret.as_str(),
                vault_secret.as_str(),
            ),
            self.credential_current_for_adoption(account.provider, profile_secret.as_str()),
        );
        let adoptable = profile_is_complete
            && profile_is_current
            && self.credential_proves_account(
                account,
                profile_secret.as_str(),
                vault_unusable || profile_is_newer,
            );
        if adoptable {
            self.inner.vault.put(&key, &profile_secret)?;
            return self.canonicalize_profile_store(account, dir, use_keychain, &profile_secret);
        }
        // 채택하지 못했다고 프로필을 볼트 값으로 되돌리면 안 된다. 프로필은 실행 중인
        // CLI가 토큰을 회전시키는 저장소라, 더 새 사슬을 오래된 볼트 값으로 덮어쓰면
        // 이미 소비된 리프레시 토큰이 다시 심겨 다음 실행이 갱신조차 못 하고 인증에
        // 실패한다. 신원을 증명하지 못해 볼트로 승격만 못 했을 뿐이므로 프로필은
        // 그대로 두고, 다음 회전에서 신원이 확인되면 그때 승격한다.
        if profile_is_newer && profile_is_complete {
            return self.canonicalize_profile_store(account, dir, use_keychain, &profile_secret);
        }
        write_from_vault()
    }

    /// 프로필에 남은 평문 자격증명을 Keychain으로 옮긴다. 볼트와 값이 같아 다시
    /// 쓸 일이 없는 프로필도 저장소는 옮겨야 해서, 값을 맞추는 일과 따로 둔다.
    ///
    /// 평문 파일이 없으면(Keychain만 쓰는 정상 상태) 아무것도 하지 않는다. 이
    /// 검사가 먼저라 대부분의 호출은 `security`를 부르지 않는다.
    fn canonicalize_profile_store(
        &self,
        account: &AccountRecord,
        dir: &Path,
        use_keychain: bool,
        secret: &str,
    ) -> Result<(), CoreError> {
        if account.provider != ProviderId::Claude || !claude_keychain_writable(use_keychain) {
            return Ok(());
        }
        let path = provider_auth_file(dir, account.provider, None)?;
        if !path.exists() {
            return Ok(());
        }
        // Keychain 항목이 이미 있으면 읽기가 그쪽을 먼저 보므로 파일은 읽히지 않는
        // 옛 토큰이다. 없으면 지금 값을 옮겨 담고 나서 지운다.
        if !claude_keychain_credentials_exist(Some(dir))? {
            write_claude_keychain_credentials(Some(dir), secret)?;
        }
        discard_profile_secret_file(&path);
        Ok(())
    }

    /// 앱이 소유한 프로필 자격증명을 복구 근거로 쓸 수 있는지 확인하고, 쓸 수 있을
    /// 때만 값을 준다. 없거나 불완전하거나 유효기간이 확인되지 않거나 읽을 수 없거나
    /// 다른 계정 것이면 `None`이고, 그때 볼트와 공유 자격증명은 그대로 남는다.
    ///
    /// 프로필은 이 앱만 쓰는 저장소지만, 그 사실만으로 신원을 믿지 않는다. 경로가
    /// 검증된 프로필 디렉터리인지, 값이 구조적으로 온전한지, 액세스 토큰이 아직
    /// 살아 있음이 증명되는지, 그리고 그 자격증명이 이 계정 것인지를 모두 따로
    /// 확인한다. 만료 시각이 없는 값은 "아직 유효하다"는 증거가 아니라 증거가 없는
    /// 것이므로 복구 근거로 쓰지 않는다.
    fn recoverable_profile_credential(&self, account: &AccountRecord) -> Option<Zeroizing<String>> {
        let dir = self.validated_profile_dir(account.provider, &account.id)?;
        let secret = self.read_profile_credentials(account.provider, &dir).ok()?;
        if !credential_is_complete(account.provider, &secret) {
            return None;
        }
        if !self.credential_current_for_adoption(account.provider, &secret) {
            return None;
        }
        if !self.credential_proves_account(account, &secret, true) {
            return None;
        }
        Some(secret)
    }

    /// 이미 있는 계정별 프로필 디렉터리. 없으면 만들지 않는다(복구는 앱이 이전에
    /// 만들어 둔 프로필만 근거로 쓴다). 정규화한 경로가 앱 데이터 하위의 기대 경로와
    /// 다르면, 심링크로 앱 데이터 밖을 가리키는 자리이므로 쓰지 않는다.
    fn validated_profile_dir(&self, provider: ProviderId, account_id: &str) -> Option<PathBuf> {
        let expected =
            credential_profiles::profile_dir(&self.inner.app_data_dir, provider, account_id)
                .ok()?;
        let canonical = fs::canonicalize(&expected).ok()?;
        (canonical == expected && canonical.is_dir()).then_some(canonical)
    }

    /// 앱이 회전시킨 자격증명을 계정별 격리 프로필에도 반영한다.
    ///
    /// 프로필이 아직 없으면 아무것도 하지 않는다. 프로필을 만드는 시점은 런타임 준비
    /// 한 곳으로 남겨 두어야, 격리를 쓰지 않는 계정에 빈 저장소가 생기지 않는다.
    fn mirror_credential_to_profile(
        &self,
        account: &AccountRecord,
        secret: &str,
    ) -> Result<(), CoreError> {
        let Some(dir) = self.validated_profile_dir(account.provider, &account.id) else {
            return Ok(());
        };
        write_active_credentials(
            &dir,
            account.provider,
            Some(&dir),
            self.inner.inspect_external_processes,
            secret,
        )
    }

    /// 저장된 자격증명이 밝힌 사슬 만료 시각. 읽지 못하면 `None`이고, 호출부는 그때
    /// 이전에 읽어 둔 값을 지우지 않는다.
    fn stored_credential_expires_at(&self, account: &AccountRecord) -> Option<i64> {
        let secret = self.inner.vault.get(&vault_key(account)).ok()?;
        credential_chain_expires_at(account.provider, &secret)
    }

    /// 자격증명의 액세스 토큰이 만료됐는지. 만료 판정이 있는 공급자는 Claude뿐이고,
    /// 만료 시각이 없으면 유효한 것으로 본다.
    fn credential_expired(&self, provider: ProviderId, secret: &str) -> bool {
        provider == ProviderId::Claude && claude_access_token_expired(secret, now_ms())
    }

    /// 자격증명을 볼트의 정본으로 승격해도 되는지, 유효기간 관점에서만 본다.
    /// `credential_expired`의 반대가 아니다. 저쪽은 만료 시각이 없으면 유효로 보지만
    /// 여기서는 유효 증거가 없는 것이므로 승격을 막는다. 만료 판정이 있는 공급자는
    /// Claude뿐이라 Codex는 지금까지처럼 항상 승격할 수 있다.
    fn credential_current_for_adoption(&self, provider: ProviderId, secret: &str) -> bool {
        provider != ProviderId::Claude || claude_access_token_current_for_adoption(secret, now_ms())
    }

    /// 자격증명이 이 계정 것임을 증명한다. 자격증명 안에 계정 식별자가 박혀 있으면
    /// 그것만으로 끝내고, 없을 때에만 기존 Claude 프로필 조회로 확정한다. 조회는
    /// 네트워크 호출이므로 신원이 이미 자격증명에 들어 있는 값에는 부르지 않고,
    /// `allow_live_lookup`이 꺼져 있으면 아예 묻지 않는다.
    ///
    /// 증명하지 못하면 거짓이다. 공유 `~/.claude.json`이나 CLI가 보고하는 이메일은
    /// 계정 교체를 따라오지 않아 근거로 쓰지 않는다.
    fn credential_proves_account(
        &self,
        account: &AccountRecord,
        secret: &str,
        allow_live_lookup: bool,
    ) -> bool {
        if let Some(identity) = embedded_identity(account.provider, secret) {
            return identity_matches_account(&identity, account);
        }
        // Antigravity 토큰에는 신원이 없다. 대신 이 자격증명을 읽은 자리가 그 계정 전용
        // 프로필이고 키체인도 그 안에 있으므로, 온전한 값이면 계정이 증명된 것으로 본다.
        // 공유 홈을 함께 쓰는 다른 두 공급자와 달리 섞일 자리가 없다(`C12`).
        if account.provider == ProviderId::Antigravity {
            return antigravity_has_keyring_token(secret);
        }
        if account.provider != ProviderId::Claude || !allow_live_lookup {
            return false;
        }
        (self.inner.claude_identity_resolver)(secret)
            .is_ok_and(|identity| identity_matches_account(&identity, account))
    }

    /// 공급자 루트(공유 홈)에서 자격증명을 읽는다. `profile`이 있으면 그 프로필의
    /// 자격증명 파일을 읽고 Keychain 서비스명도 그 프로필로 만든다.
    ///
    /// 감독자가 자격증명을 읽는 자리마다 공급자 루트·Keychain 프로필·Keychain 사용
    /// 여부 세 인자를 각자 조립하고 있었다. 세 값은 모두 감독자 상태에서 나오므로
    /// 호출부가 고를 것은 프로필 하나뿐인데, 조립을 베껴 두면 Keychain 프로필 기본값
    /// 규칙(프로필이 없을 때만 `claude_keychain_profile`)이 자리마다 따로 산다.
    fn read_credentials(
        &self,
        provider: ProviderId,
        profile: Option<&Path>,
    ) -> Result<Zeroizing<String>, CoreError> {
        read_active_credentials(
            self.provider_root(provider)?,
            provider,
            profile,
            profile.or(self.inner.claude_keychain_profile.as_deref()),
            self.inner.inspect_external_processes,
        )
    }

    /// 격리 프로필 디렉터리 하나를 그 자체의 공급자 루트로 삼아 자격증명을 읽는다.
    /// 프로필 점검·동기화·복구가 모두 같은 모양으로 읽으므로 한 자리에 둔다.
    fn read_profile_credentials(
        &self,
        provider: ProviderId,
        dir: &Path,
    ) -> Result<Zeroizing<String>, CoreError> {
        read_active_credentials(
            dir,
            provider,
            None,
            Some(dir),
            self.inner.inspect_external_processes,
        )
    }

    fn provider_root(&self, provider: ProviderId) -> Result<&Path, CoreError> {
        match provider {
            ProviderId::Codex => Ok(&self.inner.codex_home_dir),
            ProviderId::Claude => Ok(&self.inner.claude_config_dir),
            ProviderId::Antigravity => Ok(&self.inner.antigravity_gemini_dir),
            ProviderId::Local => Err(unmanaged_provider_error(provider)),
        }
    }

    fn credential_switch_guard(
        &self,
        provider: ProviderId,
    ) -> Result<MutexGuard<'_, ()>, CoreError> {
        let mutex = match provider {
            ProviderId::Codex => &self.inner.codex_switch_lock,
            ProviderId::Claude => &self.inner.claude_switch_lock,
            ProviderId::Antigravity => &self.inner.antigravity_switch_lock,
            ProviderId::Local => return Err(unmanaged_provider_error(provider)),
        };
        lock(mutex, "계정 전환")
    }

    /// 이 계정의 사용량 갱신 락. 호출자가 받은 Arc를 살려 둔 동안만 잠근다.
    fn usage_refresh_lock(&self, account_id: &str) -> Result<Arc<Mutex<()>>, CoreError> {
        let mut locks = lock(&self.inner.usage_locks, "계정 사용량 락")?;
        Ok(Arc::clone(
            locks
                .entry(account_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        ))
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

    /// 재인증 필요로 남은 기본 계정을 앱이 소유한 프로필로 되살린다. 프로필에 온전하고
    /// 유효기간이 남았으며 이 계정 것임이 증명된 자격증명이 있으면 그것으로 볼트를 맞추고
    /// 계정을 Ready로 올린다 — 백엔드 재시작 뒤 재인증 필요에 갇힌 계정의 회복 경로다.
    /// 증명되지 않으면 상태를 그대로 둔다. 공유 CLI 홈은 보지 않는다.
    fn verify_registered_active_accounts(&self) -> Result<(), CoreError> {
        let active = {
            let state = lock(&self.inner.state, "계정 상태")?;
            state
                .registry
                .providers
                .iter()
                .filter_map(|provider| {
                    let account_id = provider.active_account_id.as_deref()?;
                    account_by_id(&state.registry, account_id).ok().cloned()
                })
                .collect::<Vec<_>>()
        };
        for account in active {
            // 이미 Ready인 계정은 되살릴 것이 없다. 여기서도 프로필을 검사하면 계정 ID가
            // 없는 Claude 자격증명의 신원 증명이 30초마다 프로필 API를 두드린다. Ready
            // 계정의 볼트·프로필 동기화는 사용량 갱신과 실행 준비가 맡는다.
            if account.auth_status == AccountAuthStatus::Ready {
                continue;
            }
            let _switch = self.credential_switch_guard(account.provider)?;
            let Some(credential_changed) = self.recover_active_credential_from_profile(&account)
            else {
                continue;
            };
            let mut state = lock(&self.inner.state, "계정 상태")?;
            let record = account_by_id_mut(&mut state.registry, &account.id)?;
            let auth_status_changed = record.auth_status != AccountAuthStatus::Ready;
            record.auth_status = AccountAuthStatus::Ready;
            if credential_changed {
                record.usage = AccountUsageView::default();
            }
            if auth_status_changed || credential_changed {
                save_registry(&self.inner.app_data_dir, &state.registry)?;
            }
        }
        Ok(())
    }

    /// 앱이 소유한 프로필에 이 계정의 증명된 자격증명이 있으면 볼트를 그 값으로 맞추고
    /// 격리를 준비한다. 볼트 값이 바뀌었으면 `Some(true)`, 같으면 `Some(false)`, 프로필로
    /// 되살릴 수 없으면 `None`.
    fn recover_active_credential_from_profile(&self, account: &AccountRecord) -> Option<bool> {
        let secret = self.recoverable_profile_credential(account)?;
        let key = vault_key(account);
        let credential_changed = !self
            .inner
            .vault
            .get(&key)
            .is_ok_and(|stored| same_secret(&stored, &secret));
        if credential_changed {
            self.inner.vault.put(&key, &secret).ok()?;
        }
        self.ensure_credential_isolation(account.provider, &account.id)
            .then_some(credential_changed)
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

struct CapturedCredentials {
    secret: Zeroizing<String>,
    identity: AccountIdentity,
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

/// 이 계정으로 도는 런타임이 있으면 CLI가 회전 주인이라 앱은 갱신을 미룬다. 볼트와
/// 프로필은 같은 사슬이라 회전자가 둘이면 어느 쪽이 이겨도 피해다 — 앱이 먼저 회전하면
/// 떠 있는 CLI가 메모리의 옛 토큰으로 갱신하다 끊기고, CLI가 먼저 회전하면 앱이 죽은
/// 토큰을 제출해 멀쩡한 계정을 재인증 필요로 오판한다. 런타임이 없으면 경쟁자가 없으니
/// 앱이 회전한다. 외부 프로세스는 보지 않는다 — 공유 CLI 홈의 사슬은 이 계정의 프로필
/// 사슬과 다르다.
fn claude_refresh_deferral(account_runtime_running: bool) -> Option<&'static str> {
    account_runtime_running
        .then_some("실행 중인 Claude 세션이 이 계정 자격증명을 쥐고 있어 토큰 갱신을 미룹니다")
}

/// 계정을 관리하지 않는 공급자가 계정·자격증명 경로에 닿은 경우. 진입점의
/// [`ensure_managed_provider`]와 `manages_accounts()` 필터가 먼저 걸러 내므로 여기까지
/// 오면 배선 실수다. 조용히 빈 값을 돌려주면 그 실수가 "계정이 없다"로 위장되므로
/// 오류로 드러낸다.
fn unmanaged_provider_error(provider: ProviderId) -> CoreError {
    CoreError::InvalidInput(format!("{provider} 공급자는 계정 관리를 지원하지 않습니다"))
}

fn ensure_managed_provider(provider: ProviderId) -> Result<(), CoreError> {
    if provider.manages_accounts() {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(
            "이 공급자는 다중 계정 관리를 지원하지 않습니다".to_owned(),
        ))
    }
}

/// 로그인 임시 프로필에서 자격증명을 찾지 못했을 때 원인을 좁혀 준다.
///
/// Claude 자격증명 저장소는 `CLAUDE_SECURESTORAGE_CONFIG_DIR`이 단독으로 정한다. 이
/// 프로세스가 다른 계정의 격리 프로필을 가리키는 값을 물려받았고 로그인 터미널이 그
/// 값을 덮지 못했다면, 로그인 CLI는 그쪽에 토큰을 쓰고 임시 프로필은 비어 있다. 파일
/// 없음 오류만 올리면 "로그인은 성공했는데 저장만 실패한다"로 보여 원인에 닿지 못한다.
fn login_capture_error(provider: ProviderId, profile_path: &Path, error: CoreError) -> CoreError {
    if provider != ProviderId::Claude {
        return error;
    }
    let Some(inherited) = env::var_os(credential_profiles::CLAUDE_SECURESTORAGE_CONFIG_DIR) else {
        return error;
    };
    if Path::new(&inherited) == profile_path {
        return error;
    }
    CoreError::Runtime(format!(
        "로그인 자격증명을 임시 프로필에서 찾지 못했습니다. 이 프로세스가 물려받은 {}이(가) 다른 경로({})를 가리켜 로그인 CLI가 그쪽에 자격증명을 썼을 수 있습니다. 백엔드를 그 변수 없이 다시 띄운 뒤 재인증하세요: {error}",
        credential_profiles::CLAUDE_SECURESTORAGE_CONFIG_DIR,
        Path::new(&inherited).display()
    ))
}

fn login_view(login: &AccountLoginSession) -> AccountLoginSessionView {
    AccountLoginSessionView {
        id: login.id.clone(),
        provider: login.provider,
        account_id: login.account_id.clone(),
        environment_variable: match login.provider {
            ProviderId::Codex => "CODEX_HOME",
            ProviderId::Claude => "CLAUDE_CONFIG_DIR",
            // 자격증명만 옮기는 변수가 없어 홈 전체를 임시 프로필로 가둔다(C12).
            ProviderId::Antigravity => credential_profiles::ANTIGRAVITY_HOME,
            ProviderId::Local => "",
        }
        .to_owned(),
        profile_path: login.profile_path.to_string_lossy().into_owned(),
        // Codex 원격 로그인은 여기에 `--device-auth`가 붙지만, 그 판정은 요청 단위라
        // 로그인 세션을 만드는 시점에는 알 수 없다. 기본 명령만 남긴다.
        command: match login.provider {
            ProviderId::Codex => "codex login",
            ProviderId::Claude => "claude auth login --claudeai",
            ProviderId::Antigravity => "",
            ProviderId::Local => "",
        }
        .to_owned(),
    }
}

/// 앞뒤 공백을 버리고, 남은 것이 없으면 값이 없는 것으로 본다.
///
/// 공급자가 주는 계정 ID·이메일·조직 이름은 비어 있는 대신 공백 한 칸으로 오기도 한다.
/// 일곱 자리가 각자 `trim` 뒤에 `is_empty` 검사를 붙여 왔고, 어떤 자리는 `&str`로 어떤
/// 자리는 `String`으로 같은 규칙을 다시 적어 한쪽만 고치면 "값 없음" 판정이 갈라졌다.
/// JSON 칸을 읽는 [`json_field::trimmed_str`]도 이 규칙을 그대로 쓴다.
fn trimmed(value: &str) -> Option<&str> {
    Some(value.trim()).filter(|value| !value.is_empty())
}

fn normalized_display_name(
    requested: Option<String>,
    identity: &AccountIdentity,
    fallback: &str,
) -> String {
    requested
        .as_deref()
        .and_then(trimmed)
        .map(str::to_owned)
        .or_else(|| identity.display_name.clone())
        .or_else(|| identity.email.clone())
        .unwrap_or_else(|| fallback.to_owned())
}

/// 환경변수가 준 경로를 쓰되, 이 앱 자신의 자격증명 프로필 루트 안을 가리키면
/// 버린다. 그 변수들은 앱이 CLI 자식의 계정 격리를 위해 넣는 값이라, 백엔드
/// 자신에게 돌아오면 항상 상속 오염이다. 판정은 경로 문자열의 구성요소 접두로만
/// 한다 — 존재하지 않는 경로일 수 있어 canonicalize에 기대지 않는다.
fn env_path_unless_self_referential(var: &str, profile_root: &Path) -> Option<PathBuf> {
    path_unless_self_referential(var, env::var_os(var)?, profile_root)
}

/// 값을 받아 판단만 한다. 환경을 읽는 일과 가른 이유는 시험이다 — `env::set_var` 는 프로세스
/// 전역이라 다른 스레드가 환경을 읽는 동안 안전하지 않고(`tempfile` 도 TMPDIR 을 읽는다),
/// 이 판단을 보려고 환경을 바꾸던 동안 무관한 시험들이 간헐적으로 흔들렸다.
fn path_unless_self_referential(
    var: &str,
    raw: std::ffi::OsString,
    profile_root: &Path,
) -> Option<PathBuf> {
    let value = PathBuf::from(raw);
    if value.starts_with(profile_root) {
        eprintln!(
            "[accounts] {var}={}는 이 앱의 자격증명 프로필을 가리켜 무시합니다. 재기동 절차가 이 변수를 지우지 않고 백엔드를 띄운 것입니다",
            value.display()
        );
        return None;
    }
    Some(value)
}

fn provider_vault_key(provider: ProviderId, account_id: &str) -> String {
    format!("{provider}:{account_id}")
}

fn vault_key(account: &AccountRecord) -> String {
    provider_vault_key(account.provider, &account.id)
}

/// 이 계정으로 지금 이 공급자의 런타임을 띄울 수 있는가. 런타임 취득은 격리 프로브를
/// 잠금 밖에서 돌리느라 이 판정을 프로브 전후로 두 번 하는데, 두 자리가 각자 조건을
/// 적으면 한쪽만 고쳐져 "꺼 둔 계정이 실행된다"가 되기 쉽다.
fn ensure_account_runnable(
    registry: &AccountRegistry,
    account_id: &str,
    provider: ProviderId,
) -> Result<(), CoreError> {
    let account = account_by_id(registry, account_id)?;
    if account.provider != provider || account.disabled {
        return Err(CoreError::Conflict(
            "선택한 실행 계정을 사용할 수 없습니다".to_owned(),
        ));
    }
    Ok(())
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
    for provider in managed_providers() {
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
    let mut registry: AccountRegistry = serde_json::from_slice(&fs::read(path)?)?;
    migrate_default_account_into_active(&mut registry);
    ensure_provider_states(&mut registry);
    Ok(registry)
}

/// 기본 계정과 활성 계정이 하나로 합쳐졌다. 이전 레지스트리의 `defaultAccountId`는 활성
/// 계정이 비어 있을 때만 그 자리를 채우고, 어느 쪽이든 다시 저장하지 않는다.
/// 레지스트리가 담는 공급자. 계정 관리를 지원하는 공급자와 언제나 같아야 한다 —
/// 어긋나면 그 공급자의 활성 계정 조회가 "지원하지 않는 계정 공급자입니다"로 실패한다.
fn managed_providers() -> Vec<ProviderId> {
    ProviderId::ALL
        .into_iter()
        .filter(|provider| provider.manages_accounts())
        .collect()
}

/// 저장된 레지스트리에 없는 공급자 자리를 채운다. 공급자가 계정 관리를 새로 지원하게 되면
/// 이전 설치의 저장본에는 그 자리가 없어, 채우지 않으면 활성 계정 조회부터 실패한다.
fn ensure_provider_states(registry: &mut AccountRegistry) {
    for provider in managed_providers() {
        if registry
            .providers
            .iter()
            .any(|state| state.provider == provider)
        {
            continue;
        }
        registry.providers.push(ProviderAccountState {
            provider,
            active_account_id: None,
            legacy_default_account_id: None,
        });
    }
}

fn migrate_default_account_into_active(registry: &mut AccountRegistry) {
    for provider in &mut registry.providers {
        let legacy = provider.legacy_default_account_id.take();
        if provider.active_account_id.is_none() {
            provider.active_account_id = legacy;
        }
    }
}

fn save_registry(app_data_dir: &Path, registry: &AccountRegistry) -> Result<(), CoreError> {
    write_private_json(&app_data_dir.join(REGISTRY_FILE), registry)
}

/// Antigravity 자격증명이 놓이는 홈. 공급자 루트(`~/.gemini`)를 받으면 그 부모가 홈이고,
/// 프로필 디렉터리를 받으면 그 자리가 곧 홈이다 — 프로필은 홈 전체를 가르므로 `.gemini`가
/// 그 안에 생긴다(C12-2). 다른 두 공급자는 프로필이 곧 공급자 홈이라 이 구분이 없다.
fn antigravity_home_for(root_or_profile: &Path) -> &Path {
    if root_or_profile.file_name() == Some(std::ffi::OsStr::new(".gemini")) {
        root_or_profile.parent().unwrap_or(root_or_profile)
    } else {
        root_or_profile
    }
}

/// 볼트에 담는 Antigravity 자격증명 봉투의 키. CLI가 로그인 토큰을 두 파일로 나눠 두므로
/// 한 덩이로 묶어 다룬다. 순서는 [`credential_profiles::ANTIGRAVITY_TOKEN_RELATIVE_PATHS`]와
/// 짝이다.
const ANTIGRAVITY_SECRET_KEYS: [&str; 2] = ["antigravityOauthToken", "jetskiStandaloneOauthToken"];

/// 공식 CLI가 로그인 토큰을 두는 키체인 항목. 홈을 가른 프로필에서는 그 프로필의 키체인에
/// 들어간다(`C12-4a`). 키체인을 쓸 수 있으면 CLI는 **파일을 남기지 않으므로**, 봉투가 이
/// 값을 함께 담지 않으면 로그인 결과를 하나도 회수하지 못한다(2026-09-17 실측).
///
/// 이름은 토큰 파일 목록과 같은 자리(`credential_profiles`)에 둔다. 사용량 조회의 사전
/// 점검도 같은 항목을 보므로, 두 벌로 적어 두면 한쪽만 고쳐질 자리다.
#[cfg(target_os = "macos")]
use credential_profiles::{ANTIGRAVITY_KEYCHAIN_ACCOUNT, ANTIGRAVITY_KEYCHAIN_SERVICE};
/// 봉투에서 그 값을 담는 키.
const ANTIGRAVITY_KEYRING_KEY: &str = "keyringToken";

/// 이 홈에 공식 CLI 로그인 자격증명이 있는가. 토큰은 파일이나 키체인 중 한쪽에만 있을 수
/// 있다 — 키체인을 쓸 수 있는 설치에서는 CLI가 파일을 남기지 않는다(`C12-4a`). 한쪽만 보면
/// 로그인된 계정을 "자격증명 없음"으로 판정해 재인증을 요구하게 된다.
fn antigravity_credentials_present(home: &Path) -> bool {
    credential_profiles::antigravity_login_present(home)
        || read_antigravity_keyring_token(home)
            .ok()
            .flatten()
            .is_some()
}

/// 프로필 홈이 소유한 키체인 파일.
#[cfg(target_os = "macos")]
fn antigravity_profile_keychain(home: &Path) -> PathBuf {
    home.join("Library/Keychains/login.keychain-db")
}

/// 프로필 키체인에 든 로그인 토큰. 키체인이 없으면 이 설치는 파일만 쓴다는 뜻이다.
#[cfg(target_os = "macos")]
fn read_antigravity_keyring_token(home: &Path) -> Result<Option<Zeroizing<String>>, CoreError> {
    let keychain = antigravity_profile_keychain(home);
    if !keychain.exists() {
        return Ok(None);
    }
    let path = keychain.to_string_lossy().into_owned();
    let output = run_macos_security(
        &[
            "find-generic-password",
            "-s",
            ANTIGRAVITY_KEYCHAIN_SERVICE,
            "-a",
            ANTIGRAVITY_KEYCHAIN_ACCOUNT,
            "-w",
            &path,
        ],
        None,
        KEYCHAIN_COMMAND_TIMEOUT,
    )?;
    if !output.status.success() {
        if macos_keychain_item_not_found(&output) {
            return Ok(None);
        }
        return Err(macos_keychain_failure("읽기가", &output));
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
                "Antigravity Keychain 값이 UTF-8이 아닙니다".to_owned(),
            ))
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn read_antigravity_keyring_token(_home: &Path) -> Result<Option<Zeroizing<String>>, CoreError> {
    Ok(None)
}

/// 프로필 키체인에 로그인 토큰을 되돌려 놓는다. CLI가 키체인을 먼저 읽으므로, 볼트에서
/// 프로필을 복원할 때 이 값이 빠지면 CLI가 옛 값을 계속 쓴다.
#[cfg(target_os = "macos")]
fn write_antigravity_keyring_token(home: &Path, value: &str) -> Result<(), CoreError> {
    ensure_profile_keychain(home)?;
    let path = antigravity_profile_keychain(home)
        .to_string_lossy()
        .into_owned();
    let output = run_macos_security(
        &[
            "add-generic-password",
            "-U",
            "-s",
            ANTIGRAVITY_KEYCHAIN_SERVICE,
            "-a",
            ANTIGRAVITY_KEYCHAIN_ACCOUNT,
            "-w",
            value,
            &path,
        ],
        None,
        KEYCHAIN_COMMAND_TIMEOUT,
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(macos_keychain_failure("저장이", &output))
    }
}

#[cfg(not(target_os = "macos"))]
fn write_antigravity_keyring_token(_home: &Path, _value: &str) -> Result<(), CoreError> {
    Ok(())
}

/// 홈에 놓인 두 토큰 파일을 봉투 하나로 읽는다. 둘 다 없으면 로그인이 없는 것이다.
/// 한쪽만 있는 설치도 있어(구버전 CLI) 있는 것만 담는다.
fn read_antigravity_credentials(home: &Path) -> Result<Zeroizing<String>, CoreError> {
    let mut envelope = serde_json::Map::new();
    for (key, relative) in ANTIGRAVITY_SECRET_KEYS
        .iter()
        .zip(credential_profiles::ANTIGRAVITY_TOKEN_RELATIVE_PATHS)
    {
        let path = home.join(relative);
        if !path.is_file() {
            continue;
        }
        let raw = read_secret_file(&path)?;
        let value = serde_json::from_str::<Value>(&raw).map_err(|_| {
            CoreError::Runtime("Antigravity 인증 파일을 해석하지 못했습니다".to_owned())
        })?;
        envelope.insert((*key).to_owned(), value);
    }
    if let Some(token) = read_antigravity_keyring_token(home)? {
        envelope.insert(
            ANTIGRAVITY_KEYRING_KEY.to_owned(),
            Value::String(token.to_string()),
        );
    }
    if envelope.is_empty() {
        return Err(CoreError::NotFound(
            "Antigravity 로그인 토큰을 찾지 못했습니다".to_owned(),
        ));
    }
    Ok(Zeroizing::new(Value::Object(envelope).to_string()))
}

/// Antigravity 자격증명 봉투를 읽는 자리.
///
/// 봉투 안쪽 모양(OAuth 토큰이 `ANTIGRAVITY_SECRET_KEYS[0]` 아래 있고, 갱신·만료 값은 그
/// 안의 `token` 객체에 있다)을 호출부마다 `get("token")`으로 따라 내려가면, 키 하나가
/// 바뀔 때 일부만 고쳐져 어떤 값은 읽히고 어떤 값은 조용히 `None`이 된다. 경로를 아는
/// 자리를 여기 하나로 둔다. 값은 비밀정보라 이 타입은 밖으로 나가지 않는다(`G4`).
struct AntigravityEnvelope(Value);

impl AntigravityEnvelope {
    /// 해석하지 못하면 봉투가 아닌 것으로 본다. 판정만 하는 호출부가 쓴다.
    fn parse(secret: &str) -> Option<Self> {
        serde_json::from_str::<Value>(secret).ok().map(Self)
    }

    /// 해석 실패를 그대로 올린다. 봉투를 펼쳐 쓰는 호출부가 쓴다.
    fn parse_required(secret: &str) -> Result<Self, CoreError> {
        Ok(Self(serde_json::from_str::<Value>(secret)?))
    }

    /// 봉투에 담긴 토큰 파일 하나의 내용.
    fn token_file(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// OAuth 토큰 파일 안의 `token` 객체 필드. 갱신 토큰과 만료 시각이 여기 있다.
    fn oauth_token_field(&self, name: &str) -> Option<&str> {
        self.token_file(ANTIGRAVITY_SECRET_KEYS[0])?
            .get("token")?
            .get(name)?
            .as_str()
    }

    /// OAuth 토큰 파일에 실린 신원 토큰. 키체인에만 로그인이 있으면 없다.
    fn id_token(&self) -> Option<&str> {
        self.token_file(ANTIGRAVITY_SECRET_KEYS[0])?
            .get("id_token")?
            .as_str()
    }

    /// 키체인 항목에서 회수해 봉투에 함께 담은 토큰.
    fn keyring_token(&self) -> Option<&str> {
        self.0.get(ANTIGRAVITY_KEYRING_KEY)?.as_str()
    }
}

/// C12-11 3단계의 판정.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AntigravityIdentityCheck {
    /// 이 플랫폼에는 전역 항목 경합이 없다.
    NotApplicable,
    /// CLI가 아직 인증 결과를 로그에 남기지 않았다. 다음 신호에서 다시 본다.
    Pending,
    /// 요청한 계정으로 인증됐다.
    Matched,
    /// 다른 계정으로 인증됐다. `observed`는 계정 이메일이라 비밀이 아니다(G5).
    Mismatch { observed: String },
}

/// 기계 전역 로그인 항목의 값을 계정 봉투로 만든다. 항목의 값은 토큰 파일 하나의 내용과 같은
/// 모양(`{auth_method, id_token, token:{…}}`)이라 두 파일 자리에 같은 값을 둔다 — CLI는 두
/// 파일 어느 쪽이든 읽고, 신원은 `id_token`에서 나온다.
fn antigravity_envelope_from_global_login(login: &str) -> Result<Zeroizing<String>, CoreError> {
    let value = serde_json::from_str::<Value>(login).map_err(|_| {
        CoreError::Runtime("Antigravity 전역 로그인 항목을 해석하지 못했습니다".to_owned())
    })?;
    if !value.is_object() {
        return Err(CoreError::Runtime(
            "Antigravity 전역 로그인 항목이 토큰 객체가 아닙니다".to_owned(),
        ));
    }
    let mut envelope = serde_json::Map::new();
    for key in ANTIGRAVITY_SECRET_KEYS {
        envelope.insert(key.to_owned(), value.clone());
    }
    Ok(Zeroizing::new(Value::Object(envelope).to_string()))
}

/// 시작 직후 CLI가 `cli.log`에 남기는 인증 결과 줄의 표식. 대화형 로그인의
/// `authenticated as `(`antigravity_identity_from_home`)와 달리 키체인·파일 인증에도 찍힌다.
const ANTIGRAVITY_AUTH_RESULT_MARKER: &str = "applyAuthResult: email=";
/// `cli.log`에서 뒤에서부터 볼 최대 바이트. 프로필 하나에 로그가 계속 쌓이므로 상한을 둔다.
const ANTIGRAVITY_CLI_LOG_TAIL_BYTES: u64 = 256 * 1024;

/// 프로필 홈의 `cli.log`에서 **마지막** 인증 결과의 이메일. 프로브와 실행이 같은 프로필에
/// 잇달아 찍으므로 마지막 줄이 가장 최근 프로세스의 것이다. 공급자가 쓴 파일을 계정 파악
/// 목적으로 읽기만 한다(`G1`); 이메일은 비밀이 아니다(`G5`).
fn antigravity_authenticated_email_from_cli_log(home: &Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = home.join(".gemini/antigravity-cli/cli.log");
    let mut file = fs::File::open(&path).ok()?;
    let length = file.metadata().ok()?.len();
    if length > ANTIGRAVITY_CLI_LOG_TAIL_BYTES {
        file.seek(SeekFrom::Start(length - ANTIGRAVITY_CLI_LOG_TAIL_BYTES))
            .ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    antigravity_authenticated_email_from_log_text(&String::from_utf8_lossy(&bytes))
}

fn antigravity_authenticated_email_from_log_text(text: &str) -> Option<String> {
    text.rmatch_indices(ANTIGRAVITY_AUTH_RESULT_MARKER)
        .find_map(|(index, _)| {
            let rest = &text[index + ANTIGRAVITY_AUTH_RESULT_MARKER.len()..];
            let email = rest
                .split(|c: char| c == ',' || c.is_whitespace())
                .next()?
                .trim();
            email.contains('@').then(|| email.to_owned())
        })
}

/// 이메일 비교는 대소문자를 가리지 않는다 — 구글은 로컬 파트 대소문자를 구분하지 않고, 로그와
/// `id_token`이 같은 표기를 쓴다는 보장이 없다.
fn compare_antigravity_identity(expected: &str, observed: &str) -> AntigravityIdentityCheck {
    if expected.eq_ignore_ascii_case(observed) {
        AntigravityIdentityCheck::Matched
    } else {
        AntigravityIdentityCheck::Mismatch {
            observed: observed.to_owned(),
        }
    }
}

/// 봉투를 다시 두 파일로 펼친다. 프로필 홈은 이 호출에서 처음 만들어질 수 있으므로
/// 상위 디렉터리까지 연다.
fn write_antigravity_credentials(home: &Path, secret: &str) -> Result<(), CoreError> {
    let envelope = AntigravityEnvelope::parse_required(secret)?;
    let mut written = false;
    for (key, relative) in ANTIGRAVITY_SECRET_KEYS
        .iter()
        .zip(credential_profiles::ANTIGRAVITY_TOKEN_RELATIVE_PATHS)
    {
        let Some(value) = envelope.token_file(key) else {
            continue;
        };
        let path = home.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        atomic_write_secret(&path, &value.to_string())?;
        written = true;
    }
    if let Some(token) = envelope.keyring_token() {
        write_antigravity_keyring_token(home, token)?;
        written = true;
    }
    if !written {
        return Err(CoreError::Runtime(
            "Antigravity 인증 봉투에 토큰이 없습니다".to_owned(),
        ));
    }
    Ok(())
}

/// 봉투에 실린 `id_token`에서 계정 신원을 읽는다. Antigravity에는 계정을 묻는 공식
/// 명령이 없고(`/usage`는 잔량만 준다) 토큰 자체가 유일한 근거다. 구글 subject는 계정마다
/// 고정이라 그대로 공급자 계정 ID로 쓴다.
fn antigravity_identity(secret: &str) -> Result<AccountIdentity, CoreError> {
    let missing = || CoreError::Runtime("Antigravity 계정 ID를 확인하지 못했습니다".to_owned());
    let envelope = AntigravityEnvelope::parse_required(secret)?;
    let id_token = envelope.id_token().ok_or_else(missing)?;
    let claims = decode_jwt_claims(id_token)?;
    let email = string_field(&claims, &["email"]);
    // 계정 식별자는 이메일로 통일한다. 토큰이 키체인에만 있는 설치에서는 신원을 CLI 로그의
    // 이메일에서 읽으므로(`antigravity_identity_from_home`), 여기서 구글 subject를 쓰면 같은
    // 계정이 두 경로에서 다른 키를 얻어 공유 홈 관측이 등록 계정을 못 찾는다.
    let provider_account_id = email
        .clone()
        .or_else(|| string_field(&claims, &["sub"]))
        .ok_or_else(missing)?;
    Ok(AccountIdentity {
        provider_account_id,
        legacy_provider_account_id: string_field(&claims, &["sub"]),
        email,
        organization: None,
        display_name: None,
    })
}

/// 신원을 찾으려고 훑을 최근 로그 파일 수. 프로필 하나에 로그가 계속 쌓이므로 상한을 둔다.
const ANTIGRAVITY_IDENTITY_LOG_SCAN: usize = 5;

/// 공식 CLI가 로그인 직후 자기 로그에 남긴 계정 이메일. 토큰이 키체인에만 있는 설치에서는
/// 봉투에 `id_token`이 없고 계정을 묻는 명령도 없어(`/usage`는 잔량만 준다) 이것이 유일한
/// 근거다. 공급자가 쓴 파일을 계정 파악 목적으로 읽기만 한다(`G1`).
fn antigravity_identity_from_home(home: &Path) -> Result<AccountIdentity, CoreError> {
    const MARKER: &str = "authenticated as ";
    let missing = || CoreError::Runtime("Antigravity 계정 ID를 확인하지 못했습니다".to_owned());
    let mut logs = fs::read_dir(home.join(".gemini/antigravity-cli/log"))
        .map_err(|_| missing())?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let modified = entry.metadata().ok()?.modified().ok()?;
            path.is_file().then_some((modified, path))
        })
        .collect::<Vec<_>>();
    // 최근 로그부터 본다. 재인증하면 같은 프로필에 로그가 여럿 쌓이고, 마지막 로그인이
    // 지금 등록하려는 계정이다.
    logs.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, path) in logs.into_iter().take(ANTIGRAVITY_IDENTITY_LOG_SCAN) {
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let found = text.rmatch_indices(MARKER).find_map(|(index, _)| {
            text[index + MARKER.len()..]
                .lines()
                .next()
                .map(str::trim)
                .filter(|value| value.contains('@') && !value.contains(char::is_whitespace))
                .map(str::to_owned)
        });
        if let Some(email) = found {
            return Ok(AccountIdentity {
                provider_account_id: email.clone(),
                legacy_provider_account_id: None,
                email: Some(email),
                organization: None,
                display_name: None,
            });
        }
    }
    Err(missing())
}

/// 봉투가 키체인 토큰을 담고 있는가.
fn antigravity_has_keyring_token(secret: &str) -> bool {
    AntigravityEnvelope::parse(secret).is_some_and(|envelope| {
        envelope
            .keyring_token()
            .is_some_and(|token| !token.is_empty())
    })
}

/// 봉투의 리프레시 토큰. 이것이 있으면 액세스 토큰이 만료돼도 CLI가 스스로 사슬을 잇는다.
fn antigravity_refresh_token(secret: &str) -> Option<String> {
    let envelope = AntigravityEnvelope::parse(secret)?;
    envelope
        .oauth_token_field("refresh_token")
        .map(str::to_owned)
}

/// 액세스 토큰 만료 시각. 수명이 고정이라 늦을수록 나중에 발급된 사슬이다.
fn antigravity_access_token_expires_at(secret: &str) -> Option<i64> {
    let envelope = AntigravityEnvelope::parse(secret)?;
    let expiry = envelope.oauth_token_field("expiry")?;
    chrono::DateTime::parse_from_rfc3339(expiry)
        .ok()
        .map(|value| value.timestamp_millis())
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
        // 토큰이 두 파일로 나뉘어 있고 둘 다 홈 기준 상대 경로다. 프로필이 오면 그 자리가
        // 곧 홈이고, 공급자 루트가 오면 그 부모가 홈이다.
        ProviderId::Antigravity => {
            read_antigravity_credentials(antigravity_home_for(profile.unwrap_or(provider_root)))
        }
        ProviderId::Local => Err(unmanaged_provider_error(provider)),
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

/// 이 플랫폼에서 Claude 자격증명을 Keychain에 둘 수 있는지. macOS가 아니면
/// Keychain 경로 자체가 없어 `0600` 파일이 유일한 저장소다.
fn claude_keychain_writable(use_keychain: bool) -> bool {
    use_keychain && cfg!(target_os = "macos")
}

/// 앱이 만든 프로필에 남은 평문 자격증명 파일을 지운다. Keychain이 정본이 된
/// 뒤에는 읽히지 않는 옛 토큰일 뿐이라 남겨 둘 이유가 없다. 지우지 못해도 실행은
/// 계속되므로 오류로 올리지 않고, 경로에 계정 식별자가 들어가므로 흔적에도 담지
/// 않는다.
fn discard_profile_secret_file(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => eprintln!(
            "[credential-profile] 프로필에 남은 평문 자격증명 파일을 지우지 못했습니다: {error}"
        ),
    }
}

/// 계정별 격리 프로필에 자격증명을 쓴다. 앱이 만든 프로필은 이 앱이 유일한 생산자라
/// Keychain을 쓸 수 있으면 언제나 Keychain에 두고 평문 파일은 남기지 않는다. Keychain이
/// 없는 플랫폼에서는 `0600` 파일이 유일한 저장소다. 공유 CLI 홈에는 쓰지 않는다.
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
            let path = provider_auth_file(provider_root, provider, None)?;
            if claude_keychain_writable(use_keychain) {
                write_claude_keychain_credentials(keychain_profile, &compact_secret)?;
                discard_profile_secret_file(&path);
                Ok(())
            } else {
                atomic_write_secret(&path, &compact_secret)
            }
        }
        ProviderId::Antigravity => {
            write_antigravity_credentials(antigravity_home_for(provider_root), &compact_secret)
        }
        ProviderId::Local => Err(unmanaged_provider_error(provider)),
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
        // 폴더 fsync는 폴더를 파일로 열 수 있는 플랫폼에서만 뜻이 있다. Windows에서
        // `File::open`을 폴더에 걸면 `PermissionDenied`라, 자격증명은 이미 제자리에
        // 놓였는데 쓰기가 실패로 돌아왔다. 앱 소유 저장본과 공급자 설정 파일이 쓰는
        // 것과 같은 손잡이로 맞춘다 — 그쪽 `replace_file`은 Windows에서
        // `MOVEFILE_WRITE_THROUGH`로 이름 바꾸기를 이미 디스크까지 내린다.
        sync_dir(&trusted_parent)?;
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
        ProviderId::Antigravity | ProviderId::Local => unreachable!(),
    };
    Ok(root.join(file_name))
}

/// 자격증명 봉투가 스스로 말하는 신원만 읽는다. 공유 홈 설정도, CLI 로그도, 공급자
/// 서버도 보지 않는다 — 여기서 나온 값은 그 자격증명을 읽은 자리와 무관하게 참이라,
/// 계정 귀속을 증명하는 근거로 쓸 수 있다. 신원이 봉투에 없으면 `None`이고, 그건
/// "다른 계정"이 아니라 "모른다"는 뜻이다.
fn embedded_identity(provider: ProviderId, secret: &str) -> Option<AccountIdentity> {
    match provider {
        ProviderId::Codex => codex_identity(secret).ok(),
        ProviderId::Claude => claude_identity_from_secret(secret).ok(),
        ProviderId::Antigravity => antigravity_identity(secret).ok(),
        ProviderId::Local => None,
    }
}

/// 설정 파일 하나를 읽어 JSON으로 만든다. 없거나 깨졌으면 `None`이다 — 신원 후보를
/// 훑는 자리는 다음 후보로 넘어가면 되므로 오류를 구분하지 않는다.
fn read_json_file(path: &Path) -> Option<Value> {
    serde_json::from_slice::<Value>(&fs::read(path).ok()?).ok()
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
                // 계정별 설정 파일은 `oauthAccount`로 감싸기도 하고 그 내용만 담기도
                // 한다. 둘 다 같은 후보로 보고, 읽히지 않으면 다음 후보로 넘어간다.
                if let Some(value) = read_json_file(&path) {
                    let oauth = value.get("oauthAccount").unwrap_or(&value);
                    if let Ok(identity) = claude_identity(oauth) {
                        return Ok(identity);
                    }
                }
            }
            if profile.is_none() {
                // 공유 홈은 마지막 후보다. 여기에 `oauthAccount`가 있는데도 신원을
                // 못 뽑으면 그 실패 사유를 그대로 돌려준다 — 더 볼 자리가 없다.
                if let Some(value) = read_json_file(&home_dir.join(".claude.json")) {
                    if let Some(oauth) = value.get("oauthAccount") {
                        return claude_identity(oauth);
                    }
                }
            }
            Err(CoreError::Runtime(
                "Claude 로그인 계정 신원을 확인하지 못했습니다".to_owned(),
            ))
        }
        // 토큰이 키체인에만 있으면 봉투에 `id_token`이 없다. 그때는 CLI가 로그인 직후
        // 자기 로그에 남긴 계정 이메일로 확정한다.
        ProviderId::Antigravity => antigravity_identity(secret).or_else(|error| {
            antigravity_identity_from_home(antigravity_home_for(profile.unwrap_or(provider_root)))
                .map_err(|_| error)
        }),
        ProviderId::Local => Err(unmanaged_provider_error(provider)),
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
        .and_then(trimmed)
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
        .and_then(trimmed)
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

/// 응답 JSON에서 같은 뜻의 칸을 이름 후보 순서대로 읽는 도우미들. 공급자와 버전에 따라
/// 같은 값이 camelCase로도 snake_case로도 오기 때문에 어느 이름으로 왔든 같게 읽어야 한다.
///
/// 네 접근자가 각자 후보 목록을 훑고 있었고 그중 둘은 파일 반대편(사용량 응답 해석
/// 근처)에 떨어져 있어, 한쪽만 고치면 다른 쪽이 조용히 값을 놓쳤다. 후보 순회를
/// [`first`] 한 자리에만 적고 나머지는 "칸 하나를 어떻게 읽을지"만 정하게 한다.
mod json_field {
    use serde_json::Value;

    /// 이름 후보를 순서대로 훑어 `pick`이 값을 주는 첫 칸을 쓴다.
    fn first<'a, T>(
        value: &'a Value,
        keys: &[&str],
        pick: impl Fn(&'a Value) -> Option<T>,
    ) -> Option<T> {
        keys.iter().find_map(|key| pick(value.get(*key)?))
    }

    /// 이름만 맞으면 원시 값을 그대로 준다(값이 `null`이어도 "있는 칸"으로 본다).
    pub(super) fn field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Value> {
        first(value, keys, Some)
    }

    /// 문자열 값에서 앞뒤 공백을 버리고, 남은 것이 없으면 값이 없는 것으로 본다.
    pub(super) fn trimmed_str(value: &Value) -> Option<&str> {
        value.as_str().and_then(super::trimmed)
    }

    pub(super) fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
        first(value, keys, trimmed_str).map(str::to_owned)
    }

    /// Claude 사용량 응답은 리셋 시각을 ISO 8601 문자열로 반환하므로 숫자 파싱이
    /// 실패하면 RFC 3339로 해석한다.
    pub(super) fn timestamp_field(value: &Value, keys: &[&str]) -> Option<i64> {
        first(value, keys, |value| {
            chrono::DateTime::parse_from_rfc3339(value.as_str()?)
                .ok()
                .map(|date| date.timestamp_millis())
        })
    }

    pub(super) fn number_field(value: &Value, keys: &[&str]) -> Option<f64> {
        first(value, keys, |value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        })
    }
}

use json_field::{field, number_field, string_field, timestamp_field, trimmed_str};

/// Claude 자격증명이 Keychain에서 차지하는 자리 — 서비스 이름과 계정 이름 한 쌍.
///
/// 읽기·쓰기·삭제 세 자리가 각자 `claude_keychain_service`와 `keychain_account`를
/// 순서대로 불러 두 값을 맞춰 왔다. 한 자리에서 프로필을 넘기는 것을 빠뜨려도
/// 컴파일은 통과하고, 그때 그 자리만 다른 Keychain 항목을 보게 된다 — 쓰기는 격리
/// 프로필 항목에 넣었는데 삭제는 공유 항목을 지우는 식이라 증상이 값이 남는 쪽으로
/// 나타나 알아채기 어렵다. 자리를 정하는 규칙을 한 타입에 두어 세 자리가 같은 한
/// 쌍을 받게 한다.
#[cfg(target_os = "macos")]
struct ClaudeKeychainSlot {
    service: String,
    account: String,
}

#[cfg(target_os = "macos")]
impl ClaudeKeychainSlot {
    /// 프로필이 있으면 그 경로가, 없으면 `CLAUDE_CONFIG_DIR`이 항목을 가른다. 둘 다
    /// 없으면 CLI 기본 항목이다 — 어느 쪽이든 경로 하나를 지문으로 접는 규칙은 같으므로
    /// 접는 자리를 한 번만 적는다.
    fn for_profile(profile: Option<&Path>) -> Self {
        let scoped = profile
            .map(Path::to_path_buf)
            .or_else(|| env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from));
        let service = match scoped {
            Some(dir) => format!(
                "Claude Code-credentials-{}",
                hex_prefix(&Sha256::digest(dir.to_string_lossy().as_bytes()), 4)
            ),
            None => "Claude Code-credentials".to_owned(),
        };
        Self {
            service,
            account: env::var("USER")
                .or_else(|_| env::var("USERNAME"))
                .unwrap_or_else(|_| "user".to_owned()),
        }
    }
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
    let slot = ClaudeKeychainSlot::for_profile(profile);
    match read_os_keychain_password(&slot.service, &slot.account)? {
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
    let slot = ClaudeKeychainSlot::for_profile(profile);
    let compact_secret = compact_json_secret(secret)
        .map_err(|_| CoreError::Runtime("Claude 인증 JSON이 손상되었습니다".to_owned()))?;
    write_os_keychain_password(&slot.service, &slot.account, &compact_secret).map_err(|error| {
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
    let slot = ClaudeKeychainSlot::for_profile(profile);
    delete_os_keychain_password(&slot.service, &slot.account).map_err(|error| {
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

impl<'a> ClaudeUsageSecret<'a> {
    /// 자격증명 JSON에서 쓸 수 있는 OAuth 액세스 토큰. 새 형식(`claudeAiOauth`)을 먼저
    /// 보고 옛 최상위 키로 물러나며, 빈 문자열은 토큰이 없는 것과 같게 다룬다. 세 호출부가
    /// 각자 같은 우선순위를 펼치고 있어 한쪽만 고치면 "토큰 있음" 판정이 갈라졌다.
    fn oauth_access_token(&self) -> Option<&'a str> {
        self.oauth
            .as_ref()
            .map(|oauth| oauth.access_token)
            .or(self.access_token)
            .filter(|token| !token.is_empty())
    }
}

/// `Bearer <토큰>` 인증 헤더 값. 조립 문자열은 `Zeroizing`으로 감싸 헤더 값으로 옮긴
/// 직후 지운다(G6). `provider`는 실패 메시지에만 쓰이며 토큰은 담지 않는다.
fn bearer_header_value(token: &str, provider: &str) -> Result<HeaderValue, CoreError> {
    let value = Zeroizing::new(format!("Bearer {token}"));
    HeaderValue::from_str(&value)
        .map_err(|_| CoreError::Runtime(format!("{provider} 인증 헤더를 만들지 못했습니다")))
}

/// 공급자 OAuth 엔드포인트 호출 하나의 규격.
///
/// 네 호출부(Claude 신원 조회·Claude 토큰 갱신·Claude 사용량·Codex 사용량)가 클라이언트
/// 만들기와 "보내지 못했다 / 상태가 실패다 / 응답을 읽지 못했다" 네 문장을 각자 적고
/// 있었다. 같은 실패가 자리마다 다른 낱말로 보고돼, 엔드포인트를 하나 더 붙일 때마다
/// 문구를 베껴 쓰고 조사를 손으로 맞춰야 했다. 주어와 행동만 받아 문장을 한 벌로 세운다.
struct OauthCall {
    /// 실패 문구의 주어. "Claude 사용량", "Claude 계정 신원", "Claude 토큰".
    subject: &'static str,
    /// 주어 뒤에 붙는 행동. "조회"·"갱신".
    action: &'static str,
}

impl OauthCall {
    const fn new(subject: &'static str, action: &'static str) -> Self {
        Self { subject, action }
    }

    /// blocking 클라이언트. 제한 시간은 네 호출부가 모두 `USAGE_TIMEOUT`을 쓴다.
    fn client(&self, headers: HeaderMap) -> Result<Client, CoreError> {
        Client::builder()
            .timeout(USAGE_TIMEOUT)
            .default_headers(headers)
            .build()
            .map_err(|error| {
                CoreError::Runtime(format!(
                    "{} 클라이언트를 만들지 못했습니다: {error}",
                    self.subject
                ))
            })
    }

    fn send(&self, request: RequestBuilder) -> Result<Response, CoreError> {
        request.send().map_err(|error| {
            CoreError::Runtime(format!(
                "{}을 {}하지 못했습니다: {error}",
                self.subject, self.action
            ))
        })
    }

    /// 성공이 아닌 상태를 오류로 올린다. 인증 거부(401·403)는 기다려도 같은 결과라
    /// 문구를 갈라, 재시도할 일과 다시 인증할 일을 호출자가 로그에서 구분할 수 있게 한다.
    /// 응답 본문을 따로 읽어야 하는 상태(429, Codex의 401)는 호출부가 여기에 닿기 전에
    /// 처리한다.
    fn require_success(&self, response: Response) -> Result<Response, CoreError> {
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
            return Err(CoreError::Runtime(format!(
                "{} {} 인증이 거부되었습니다 (HTTP {status})",
                self.subject, self.action
            )));
        }
        Err(CoreError::Runtime(format!(
            "{} {}가 실패했습니다 (HTTP {status})",
            self.subject, self.action
        )))
    }

    fn read_json<T: DeserializeOwned>(&self, response: Response) -> Result<T, CoreError> {
        response.json::<T>().map_err(|error| {
            CoreError::Runtime(format!(
                "{} {} 응답을 읽지 못했습니다: {error}",
                self.subject, self.action
            ))
        })
    }
}

/// 저장된 Claude 자격증명에서 OAuth 액세스 토큰을 꺼내 인증 헤더로 만든다. 신원 조회와
/// 사용량 조회가 같은 세 줄을 각자 적고 있었다 — 토큰이 비어 있을 때의 문구까지 같다.
fn claude_bearer_header(secret: &str) -> Result<HeaderValue, CoreError> {
    let credentials: ClaudeUsageSecret<'_> = serde_json::from_str(secret)?;
    let token = credentials
        .oauth_access_token()
        .ok_or_else(|| CoreError::Runtime("Claude OAuth 토큰이 없습니다".to_owned()))?;
    bearer_header_value(token, "Claude")
}

fn claude_secret_has_oauth_access_token(secret: &str) -> bool {
    serde_json::from_str::<ClaudeUsageSecret<'_>>(secret)
        .ok()
        .and_then(|credentials| credentials.oauth_access_token())
        .is_some()
}

/// Claude 자격증명 JSON이 OAuth 항목을 담는 키. 여섯 자리가 각자 문자열 리터럴을 적고
/// 있어 한 곳만 고치면 나머지가 조용히 다른 칸을 보게 된다.
const CLAUDE_OAUTH_FIELD: &str = "claudeAiOauth";

/// Claude 자격증명 봉투를 읽는 자리.
///
/// 봉투 안쪽 모양(OAuth 항목이 `claudeAiOauth` 아래 있고, 갱신 토큰·만료 시각·스코프가
/// 모두 그 안에 있다)을 호출부마다 `serde_json::from_str`부터 다시 하고 각자 칸 이름을
/// 적어 내려가면, 키 하나가 바뀔 때 일부만 고쳐져 어떤 값은 읽히고 어떤 값은 조용히
/// `None`이 된다. 경로를 아는 자리를 여기 하나로 둔다 — 이미 같은 이유로 모아 둔
/// [`AntigravityEnvelope`]와 같은 방침이다. 값은 비밀정보라 이 타입은 밖으로 나가지
/// 않는다(G4).
///
/// 액세스 토큰만은 [`ClaudeUsageSecret`]이 계속 맡는다. 인증 헤더를 만드는 자리라 빌려
/// 쓰는 무복사 읽기가 필요하고(G6), 옛 최상위 형식으로 물러나는 폴백도 거기 한 벌뿐이다.
struct ClaudeOauthEnvelope(Value);

impl ClaudeOauthEnvelope {
    /// 해석하지 못하면 봉투가 아닌 것으로 본다. 판정만 하는 호출부가 쓴다.
    fn parse(secret: &str) -> Option<Self> {
        serde_json::from_str::<Value>(secret).ok().map(Self)
    }

    /// 해석 실패를 그대로 올린다. 봉투를 펼쳐 쓰는 호출부가 쓴다.
    fn parse_required(secret: &str) -> Result<Self, CoreError> {
        Ok(Self(serde_json::from_str::<Value>(secret)?))
    }

    /// 자격증명 JSON의 OAuth 항목. 항목 자체가 없으면(옛 최상위 형식) `None`이다.
    fn entry(&self) -> Option<&Value> {
        self.0.get(CLAUDE_OAUTH_FIELD)
    }

    /// 새 형식의 OAuth 항목을 달고 있는가. 로그인이 중간에 끊긴 값을 가려내는 데 쓴다.
    fn has_entry(&self) -> bool {
        self.entry().is_some()
    }

    /// OAuth 항목의 문자열 칸. 빈 문자열은 값이 없는 것과 같게 다룬다 — 로그인이 중간에
    /// 끊긴 자격증명은 칸을 비운 채로 저장되고, 그 값을 그대로 쓰면 토큰 없는 요청이 나간다.
    fn str_field(&self, field: &str) -> Option<&str> {
        self.entry()?
            .get(field)?
            .as_str()
            .filter(|text| !text.is_empty())
    }

    /// 저장된 리프레시 토큰. "있는지"만 보는 쪽과 실제로 갱신에 쓰는 쪽이 같은 판정을
    /// 쓰게 한다 — 갈라지면 토큰이 있다고 보고 갱신에 들어가 빈 토큰을 제출한다.
    fn refresh_token(&self) -> Option<&str> {
        self.str_field("refreshToken")
    }

    /// 액세스 토큰 만료 시각(epoch ms).
    fn access_token_expires_at(&self) -> Option<i64> {
        self.entry()?.get("expiresAt")?.as_i64()
    }

    /// 리프레시 토큰 만료 시각(epoch ms) — 이 사슬 전체의 절대 수명이다.
    ///
    /// 회전해도 늘어나지 않는다(2026-09-23 실측: 같은 날 회전된 자격증명이 보름 전
    /// 로그인 기준 값을 그대로 들고 있었다). 그래서 이 시각을 넘기면 갱신 요청이
    /// `HTTP 400`으로 거부되고, 어느 사본도 살아 있지 않아 재인증 외에는 길이 없다.
    fn refresh_token_expires_at(&self) -> Option<i64> {
        self.entry()?.get("refreshTokenExpiresAt")?.as_i64()
    }

    /// 저장된 자격증명이 들고 있는 스코프를 OAuth `scope` 파라미터 형태로 잇는다.
    /// 값이 없으면 파라미터를 빼고 보낸다 — 갱신은 스코프 없이도 받아들여진다.
    fn scope(&self) -> Option<String> {
        let joined = self
            .entry()?
            .get("scopes")?
            .as_array()?
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" ");
        (!joined.is_empty()).then_some(joined)
    }

    /// 갱신 응답을 합칠 수 있게 OAuth 항목을 고칠 자리로 연다.
    fn entry_object_mut(&mut self) -> Option<&mut serde_json::Map<String, Value>> {
        self.0.get_mut(CLAUDE_OAUTH_FIELD)?.as_object_mut()
    }

    /// 고친 봉투를 다시 자격증명 JSON으로. 비밀정보라 `Zeroizing`으로 감싸 돌려준다.
    fn into_secret(self) -> Result<Zeroizing<String>, CoreError> {
        serde_json::to_string(&self.0)
            .map(Zeroizing::new)
            .map_err(CoreError::from)
    }
}

/// 현재 Claude OAuth 자격증명으로 공식 Claude Code가 사용하는 프로필 API를 조회한다.
/// 응답에서는 비밀정보가 아닌 계정·조직 식별 정보만 추출하며 토큰이나 원문 응답은
/// 오류, 로그, 레지스트리 또는 IPC로 내보내지 않는다.
fn request_claude_profile_identity(secret: &str) -> Result<AccountIdentity, CoreError> {
    let call = OauthCall::new("Claude 계정 신원", "조회");
    let authorization = claude_bearer_header(secret)?;
    let response = call.send(
        call.client(HeaderMap::new())?
            .get(CLAUDE_OAUTH_PROFILE_URL)
            .header(AUTHORIZATION, authorization)
            .header(CONTENT_TYPE, HeaderValue::from_static("application/json"))
            .header(CACHE_CONTROL, HeaderValue::from_static("no-cache"))
            .header(USER_AGENT, HeaderValue::from_static("claude-code/2.1.0")),
    )?;
    let profile: ClaudeProfileResponse = call.read_json(call.require_success(response)?)?;
    claude_identity_from_profile(profile)
}

fn claude_identity_from_profile(
    profile: ClaudeProfileResponse,
) -> Result<AccountIdentity, CoreError> {
    let provider_account_id = trimmed(&profile.account.uuid)
        .ok_or_else(|| CoreError::Runtime("Claude 계정 신원 응답에 계정 ID가 없습니다".to_owned()))?
        .to_owned();
    Ok(AccountIdentity {
        provider_account_id,
        legacy_provider_account_id: None,
        email: profile
            .account
            .email
            .as_deref()
            .and_then(trimmed)
            .map(str::to_owned),
        organization: profile
            .organization
            .as_ref()
            .and_then(|organization| trimmed(&organization.uuid))
            .map(str::to_owned),
        display_name: profile
            .account
            .display_name
            .as_deref()
            .and_then(trimmed)
            .map(str::to_owned),
    })
}

fn validate_captured_provider_credential(
    provider: ProviderId,
    secret: &str,
) -> Result<(), CoreError> {
    if provider != ProviderId::Claude {
        return Ok(());
    }
    let envelope = ClaudeOauthEnvelope::parse_required(secret)?;
    if envelope.has_entry() && !claude_secret_has_oauth_access_token(secret) {
        return Err(CoreError::Conflict(
            "Claude 로그인이 아직 완료되지 않았습니다. 공식 Claude CLI로 다시 로그인하고, 브라우저 인증 후 표시된 코드를 로그인 터미널에 붙여넣어 전송한 다음 CLI가 정상 종료될 때까지 기다려 주세요"
                .to_owned(),
        ));
    }
    Ok(())
}

/// 자격증명이 구조적으로 온전한지. 로그인이 중간에 끊겨 토큰이 빠진 값을 정본으로
/// 올리면 지금의 오류를 다른 오류로 바꾸는 것뿐이라, 채택 전에 걸러낸다.
fn credential_is_complete(provider: ProviderId, secret: &str) -> bool {
    if validate_captured_provider_credential(provider, secret).is_err() {
        return false;
    }
    match provider {
        // Claude 자격증명은 액세스 토큰이 있어야 사용량 조회와 재발급 사슬이 이어진다.
        ProviderId::Claude => claude_secret_has_oauth_access_token(secret),
        // Codex 신원은 자격증명 안의 토큰에서만 나오므로 신원 확인이 온전성 확인을 겸한다.
        ProviderId::Codex => serde_json::from_str::<Value>(secret).is_ok(),
        // 리프레시 토큰이 있어야 CLI가 액세스 토큰을 스스로 다시 받는다. 이 값은 회전하지
        // 않으므로 프로필 사본이 여러 개여도 서로를 무효화하지 않는다.
        // 파일 사슬이 없으면 키체인 토큰이 그 자리를 대신한다.
        ProviderId::Antigravity => {
            antigravity_refresh_token(secret).is_some() || antigravity_has_keyring_token(secret)
        }
        // 자격증명 자체가 없는 공급자다. 온전한 값이 존재할 수 없다.
        ProviderId::Local => false,
    }
}

enum ClaudeUsageResponse {
    Usage(AccountUsageView),
    Unauthorized,
    RateLimited { retry_at: i64 },
}

/// 429 응답이 남기는 문구. 세 호출부가 같은 사건을 다르게 부르지 않도록 한곳에 둔다.
const CLAUDE_USAGE_RATE_LIMITED_MESSAGE: &str = "Claude 사용량 조회가 제한되었습니다 (HTTP 429)";

impl ClaudeUsageResponse {
    /// 성공과 429는 어느 호출부에서나 같은 뷰가 된다. 401만 부르는 쪽마다 다르게
    /// 다뤄야 하므로(갱신 재시도·재인증 요구·공유 홈 안내) 그 갈래만 `None`으로
    /// 남기고 나머지를 여기서 접는다.
    fn into_usage_or_unauthorized(self) -> Option<AccountUsageView> {
        match self {
            Self::Usage(usage) => Some(usage),
            Self::RateLimited { retry_at } => Some(rate_limited_usage_result(
                CLAUDE_USAGE_RATE_LIMITED_MESSAGE,
                retry_at,
            )),
            Self::Unauthorized => None,
        }
    }
}

enum ClaudeTokenRefresh {
    Refreshed(Zeroizing<String>),
    RateLimited {
        retry_at: i64,
        /// 이 429까지 포함한 연속 제한 횟수. 다음 429의 간격을 정하는 데 쓴다.
        streak: u32,
    },
    /// 갱신 엔드포인트가 이 자격증명 자체를 거부했다. 기다려도 회복되지 않으므로
    /// 재시도 대기가 아니라 재인증으로 올린다.
    Rejected(String),
}

/// 저장된 Claude 자격증명의 액세스 토큰이 만료됐는지 확인한다.
/// 만료 시각이 없으면 판단할 수 없으므로 일단 유효한 것으로 보고 호출 결과(401)로 가른다.
fn claude_access_token_expires_at(secret: &str) -> Option<i64> {
    ClaudeOauthEnvelope::parse(secret)?.access_token_expires_at()
}

/// 자격증명이 스스로 밝힌 사슬 만료 시각. 밝히지 않는 공급자·형식은 `None`이고, 그때
/// 화면은 만료 예고를 하지 않는다 — 모르는 것을 모른다고 두는 편이, 없는 값을 추정해
/// 잘못된 시각으로 재인증을 재촉하는 것보다 낫다.
fn credential_chain_expires_at(provider: ProviderId, secret: &str) -> Option<i64> {
    (provider == ProviderId::Claude)
        .then(|| ClaudeOauthEnvelope::parse(secret)?.refresh_token_expires_at())
        .flatten()
}

/// 자격증명 값을 로그에 남기지 않고도 같은 값인지 비교할 수 있게 하는 지문.
fn credential_fingerprint(secret: &str) -> String {
    hex_prefix(&Sha256::digest(secret.as_bytes()), 4)
}

/// 오류 응답이 스스로 밝힌 오류 종류. Anthropic은 `{"error":{"type":"..."}}`로,
/// OAuth 표준 오류는 `{"error":"invalid_grant"}`로 오므로 두 모양을 모두 받는다.
fn oauth_error_kind(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?;
    error
        .as_str()
        .map(str::to_owned)
        .or_else(|| Some(error.get("type")?.as_str()?.to_owned()))
}

/// 갱신 엔드포인트의 429가 서버 측 제한인지 가른다.
///
/// 본문이 종류를 밝히면 그 말을 따른다. Anthropic 갱신 엔드포인트는 실제 제한에도
/// `Retry-After`나 `ratelimit*` 헤더를 붙이지 않고 `rate_limit_error` 본문만 주므로,
/// 헤더만 보면 멀쩡한 토큰이 전부 "죽은 토큰"으로 분류돼 계정이 재인증 필요로 굳는다.
/// 반대로 회전돼 죽은 리프레시 토큰은 OAuth 표준대로 `invalid_grant` 계열로 답한다.
///
/// 본문이 아무 종류도 밝히지 않을 때만 헤더로 판정한다. 제한 창을 알려 주는 헤더가
/// 하나도 없으면 죽은 토큰으로 보는 쪽이 안전하다 — 오판이어도 손해는 대기뿐이고
/// 다음 성공 조회가 곧바로 `ready`로 되돌린다.
fn claude_refresh_429_is_throttle(
    retry_after: Option<&str>,
    limit_headers: &str,
    body: &str,
) -> bool {
    match oauth_error_kind(body).as_deref() {
        Some("rate_limit_error") => true,
        Some("invalid_grant" | "invalid_request" | "invalid_client" | "unauthorized_client") => {
            false
        }
        _ => retry_after.is_some() || limit_headers != "없음",
    }
}

/// 429 응답이 알려 주는 제한 창 정보만 골라 한 줄로 요약한다. 이름에 `ratelimit`을
/// 담은 헤더만 쓰므로 토큰이나 신원 값은 들어가지 않는다.
fn rate_limit_header_summary(headers: &HeaderMap) -> String {
    let summary = headers
        .iter()
        .filter(|(name, _)| name.as_str().contains("ratelimit"))
        .filter_map(|(name, value)| value.to_str().ok().map(|value| format!("{name}={value}")))
        .collect::<Vec<_>>();
    if summary.is_empty() {
        "없음".to_owned()
    } else {
        summary.join(" ")
    }
}

fn claude_access_token_expired(secret: &str, now_ms: i64) -> bool {
    claude_access_token_expires_at(secret).is_some_and(|expires_at| {
        expires_at <= now_ms.saturating_add(CLAUDE_TOKEN_EXPIRY_MARGIN_MS)
    })
}

/// 프로필 값을 볼트로 승격해도 될 만큼 Claude 액세스 토큰이 확실히 살아 있는지
/// 확인한다. `claude_access_token_expired`와 판정 기준(만료 여유)은 같지만 모르는
/// 값을 반대로 다룬다. 요청을 보내볼 때는 만료 시각이 없어도 일단 시도하는 편이
/// 낫지만, 정본을 갈아치울 때는 유효 증거가 없는 값을 근거로 삼으면 앱이 스스로
/// 쓸 수 없는 자격증명을 정본으로 만든다. 그래서 `expiresAt`이 정수로 읽히고 아직
/// 여유분 너머로 남아 있을 때에만 참이고, 없거나 숫자가 아니거나 깨졌거나 이미
/// 지난 값은 모두 거짓이다.
fn claude_access_token_current_for_adoption(secret: &str, now_ms: i64) -> bool {
    claude_access_token_expires_at(secret)
        .is_some_and(|expires_at| expires_at > now_ms.saturating_add(CLAUDE_TOKEN_EXPIRY_MARGIN_MS))
}

/// `candidate`가 `current`보다 나중에 발급된 자격증명 사슬인지.
///
/// 볼트와 계정별 프로필은 각각 토큰을 회전시킬 수 있어, 어느 쪽이 최신인지 값
/// 자체로 판정하지 않으면 오래된 사슬로 되돌아간다. 되돌아가는 순간 이미 소비되어
/// 무효가 된 리프레시 토큰이 다시 심기고, 다음 실행은 갱신조차 못 해 인증에
/// 실패한다.
///
/// "만료됐는가"와는 다른 질문이다. 액세스 토큰이 만료된 값이라도 함께 회전된
/// 리프레시 토큰이 들어 있으면 CLI가 스스로 갱신해 쓸 수 있는 최신 사슬이다.
/// 그래서 만료 여부가 아니라 발급 시점만 비교한다.
///
/// 발급 시점을 읽지 못하는 쪽은 최신으로 보지 않는다. 모르는 값을 최신으로 다루면
/// 깨진 자격증명이 정상 값을 밀어낸다.
/// 사슬 비교에 쓰는 발급 시점. 늦을수록 나중에 회전된 값이다.
fn credential_chain_issued_at(provider: ProviderId, secret: &str) -> Option<i64> {
    match provider {
        // 액세스 토큰 수명은 고정이라 만료 시각이 늦을수록 나중에 발급된 값이다.
        ProviderId::Claude => claude_access_token_expires_at(secret),
        ProviderId::Codex => codex_last_refresh_ms(secret),
        ProviderId::Antigravity => antigravity_access_token_expires_at(secret),
        ProviderId::Local => None,
    }
}

fn credential_chain_is_newer(provider: ProviderId, candidate: &str, current: &str) -> bool {
    match (
        credential_chain_issued_at(provider, candidate),
        credential_chain_issued_at(provider, current),
    ) {
        (Some(candidate), Some(current)) => candidate > current,
        _ => false,
    }
}

/// 두 사슬의 발급 시점을 모두 읽을 수 있어 선후를 가릴 수 있는지.
fn credential_chains_comparable(provider: ProviderId, left: &str, right: &str) -> bool {
    credential_chain_issued_at(provider, left).is_some()
        && credential_chain_issued_at(provider, right).is_some()
}

/// 갈라진 프로필 사슬을 볼트 정본으로 올릴 자격. 발급 시점을 비교할 수 있으면 그
/// 결과만 믿고, 비교할 수 없을 때에만 "로컬에서 아직 쓸 수 있어 보인다"는 근거를
/// 허용한다.
///
/// 로컬 판정을 무조건 허용하면 안 되는 이유(2026-08-27 실측): 리프레시 사슬이 다른
/// 곳에서 회전되면 옛 사본의 액세스 토큰은 만료 시각이 남았어도 서버에서 이미
/// 무효인데, 로컬에서는 그걸 알 수 없다. 그날 프로필의 폐기된 옛 사슬이 "액세스
/// 토큰이 살아 있다"는 이유로 8일 더 새 볼트 사슬을 덮어, 계정의 마지막 살아 있는
/// 사본이 사라졌다.
fn profile_chain_current(
    profile_is_newer: bool,
    chains_comparable: bool,
    locally_usable: bool,
) -> bool {
    profile_is_newer || (!chains_comparable && locally_usable)
}

/// Codex `auth.json`이 기록하는 마지막 갱신 시각(RFC 3339). 사슬 비교에만 쓰므로
/// 읽지 못하면 `None`으로 두고 호출자가 "최신이 아님"으로 다룬다.
fn codex_last_refresh_ms(secret: &str) -> Option<i64> {
    let value: Value = serde_json::from_str(secret).ok()?;
    let last_refresh = value.get("last_refresh")?.as_str()?;
    chrono::DateTime::parse_from_rfc3339(last_refresh)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

/// 이 자격증명으로 CLI가 요청을 보낼 수 있는지. 액세스 토큰이 아직 살아 있거나,
/// 만료됐더라도 리프레시 토큰이 있어 CLI가 스스로 갱신할 수 있으면 참이다.
///
/// 격리 프로필이 쓸모 있는지 판정하는 데 쓴다. 공급자 CLI의 인증 상태 조회는
/// 자격증명이 있는지만 답하고 그 토큰이 살아 있는지는 답하지 않아서, 이 검사가
/// 없으면 갱신조차 불가능한 자격증명에도 실행 허가가 난다.
fn credential_can_authenticate(provider: ProviderId, secret: &str, now_ms: i64) -> bool {
    if !credential_is_complete(provider, secret) {
        return false;
    }
    match provider {
        ProviderId::Claude => {
            !claude_access_token_expired(secret, now_ms)
                || claude_secret_has_oauth_refresh_token(secret)
        }
        // Codex 자격증명에는 만료 시각이 없어 온전성 확인이 곧 사용 가능 판정이다.
        ProviderId::Codex => true,
        // 액세스 토큰이 만료됐어도 리프레시 토큰이 있으면 CLI가 갱신해 쓴다.
        ProviderId::Antigravity => {
            antigravity_access_token_expires_at(secret).is_none_or(|expires_at| expires_at > now_ms)
                || antigravity_refresh_token(secret).is_some()
                || antigravity_has_keyring_token(secret)
        }
        ProviderId::Local => false,
    }
}

fn claude_secret_has_oauth_refresh_token(secret: &str) -> bool {
    ClaudeOauthEnvelope::parse(secret).is_some_and(|envelope| envelope.refresh_token().is_some())
}

/// 보관된 리프레시 토큰으로 Claude OAuth 토큰을 갱신한다. 429는 기존 자격증명을
/// 폐기하거나 재인증 오류로 바꾸지 않고 호출자가 재시도 시각을 보존하도록 돌려준다.
fn refresh_claude_oauth_secret(
    secret: &str,
    throttle_streak: u32,
) -> Result<ClaudeTokenRefresh, CoreError> {
    let envelope = ClaudeOauthEnvelope::parse_required(secret)?;
    let refresh_token = envelope
        .refresh_token()
        .ok_or_else(|| {
            CoreError::Conflict(
                "Claude 액세스 토큰이 만료됐지만 저장된 갱신 토큰이 없습니다. 계정을 다시 인증해 주세요"
                    .to_owned(),
            )
        })?;
    let refresh_fingerprint = credential_fingerprint(refresh_token);
    let expires_at = claude_access_token_expires_at(secret);
    // 토큰 엔드포인트는 `User-Agent`로 요청을 거른다. 2026-08-27 실측(같은 IP·같은
    // client_id·무효 토큰, 12회 비교): `claude-code/<semver>`와 `curl/<ver>`만 HTTP 429
    // `rate_limit_error`를 받고, 헤더를 붙이지 않거나 다른 값이면 400 `invalid_grant`로
    // 정상 처리됐다. 본문 형식(form/json)과 `scope` 유무는 결과를 바꾸지 않았다.
    //
    // 여기에 `claude-code/2.1.0`을 붙이고 있었다. 공식 CLI가 쓰는 값처럼 보이지만 앱이
    // 지어낸 값이고, 정작 CLI는 이 엔드포인트에 User-Agent를 설정하지 않는다. 그래서
    // 같은 리프레시 토큰으로 CLI는 갱신에 성공하고 앱만 429를 받아, 만료된 액세스
    // 토큰을 되살릴 길이 영구히 막혔다. 붙이지 않는 쪽이 실측에서 통과한 형태다.
    //
    // 본문과 `scope`는 CLI 갱신 호출과 같은 모양으로 맞춘다. 결과를 바꾸지는 않지만,
    // 서버가 나중에 형식을 좁힐 때 공식 클라이언트와 같이 움직이는 편이 안전하다.
    // 신원 조회·사용량 API의 User-Agent는 측정하지 않았으므로 그대로 둔다.
    let mut refresh_body = serde_json::json!({
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": CLAUDE_OAUTH_CLIENT_ID,
    });
    if let Some(scope) = envelope.scope() {
        refresh_body["scope"] = Value::String(scope);
    }
    let call = OauthCall::new("Claude 토큰", "갱신");
    let response = call.send(
        call.client(HeaderMap::new())?
            .post(CLAUDE_OAUTH_TOKEN_URL)
            .json(&refresh_body),
    )?;
    let status = response.status();
    if status == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response
            .headers()
            .get(RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let limit_headers = rate_limit_header_summary(response.headers());
        let now = now_ms();
        // 제한 창을 알려 주는 헤더가 있으면 서버 말이 우선이고, 없으면 연속 횟수에 맞춰
        // 간격을 넓힌다. 이 429가 이번 연속의 몇 번째인지는 호출자가 들고 온다.
        let streak = throttle_streak.saturating_add(1);
        let retry_at = retry_at_hint_from_headers(response.headers(), now)
            .unwrap_or_else(|| now.saturating_add(claude_refresh_backoff_ms(throttle_streak)));
        // 이 429가 실제 rate limit인지 이미 회전돼 죽은 리프레시 토큰인지는 상태
        // 코드만으로 갈리지 않는다. 갱신에 쓴 토큰의 지문과 만료 시각, Retry-After와
        // 제한 헤더, 오류 본문을 함께 남겨 둘을 구분한다. 지문이 시도마다 같으면 같은
        // 토큰을 계속 재제출하는 것이고, 지문이 바뀌는데도 429면 서버 측 제한이다.
        // 토큰은 성공 응답에만 담기므로 이 본문에는 들어 있지 않다.
        let body = response.text().unwrap_or_default();
        eprintln!(
            "[usage] Claude 토큰 갱신 429: 갱신토큰={refresh_fingerprint} 만료={} retry-after={} 제한헤더={limit_headers} 본문={}",
            expires_at
                .map(|expires_at| expires_at.to_string())
                .unwrap_or_else(|| "없음".to_owned()),
            retry_after.as_deref().unwrap_or("없음"),
            body.trim().chars().take(300).collect::<String>()
        );
        // 이 429가 서버 측 제한인지 이미 회전돼 죽은 리프레시 토큰인지 가른다. 죽은
        // 토큰을 재시도 대기로 다루면 같은 토큰을 영영 재제출하며 계정이 `ready`로 남아
        // 예약 실행이 매 회차를 인증 오류로 태우고, 반대로 제한을 죽은 토큰으로 다루면
        // 멀쩡한 계정이 재인증 필요로 굳어 실행이 막힌다.
        if !claude_refresh_429_is_throttle(retry_after.as_deref(), &limit_headers, &body) {
            return Ok(ClaudeTokenRefresh::Rejected(format!(
                "Claude 토큰 갱신이 HTTP 429로 거부되었습니다. 이미 회전된 리프레시 토큰(지문 {refresh_fingerprint})으로 보입니다. 계정을 다시 인증해 주세요"
            )));
        }
        return Ok(ClaudeTokenRefresh::RateLimited { retry_at, streak });
    }
    if !status.is_success() {
        if matches!(
            status,
            StatusCode::BAD_REQUEST | StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ) {
            return Ok(ClaudeTokenRefresh::Rejected(format!(
                "Claude 토큰 갱신 인증이 거부되었습니다 (HTTP {status}). 계정을 다시 인증해 주세요"
            )));
        }
        return Err(CoreError::Runtime(format!(
            "Claude 토큰 갱신이 일시적으로 실패했습니다 (HTTP {status}). 기존 자격증명을 유지합니다"
        )));
    }
    let granted: Value = call.read_json(response)?;
    // 회전이 실제로 일어났는지 지문으로 남긴다. 429가 이어질 때 같은 토큰을 계속
    // 재제출하는 상황인지 판별할 기준점이 된다.
    eprintln!(
        "[usage] Claude 토큰 갱신 성공: 갱신토큰={refresh_fingerprint} → {}",
        granted
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(credential_fingerprint)
            .unwrap_or_else(|| "변경없음".to_owned())
    );
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
    let mut envelope = ClaudeOauthEnvelope::parse_required(secret)?;
    let oauth = envelope.entry_object_mut().ok_or_else(|| {
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
    envelope.into_secret()
}

fn request_claude_usage(secret: &str) -> Result<ClaudeUsageResponse, CoreError> {
    let call = OauthCall::new("Claude 사용량", "조회");
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, claude_bearer_header(secret)?);
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("oauth-2025-04-20"),
    );
    headers.insert(USER_AGENT, HeaderValue::from_static("claude-code/2.1.0"));
    let response = call.send(
        call.client(headers)?
            .get("https://api.anthropic.com/api/oauth/usage"),
    )?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Ok(ClaudeUsageResponse::Unauthorized);
    }
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Ok(ClaudeUsageResponse::RateLimited {
            retry_at: retry_at_from_headers(response.headers(), now_ms()),
        });
    }
    let value: Value = call.read_json(call.require_success(response)?)?;
    Ok(ClaudeUsageResponse::Usage(usage_result(
        claude_usage_windows(&value),
    )))
}

/// 모델별 주간 창의 창 길이. `limits[]`의 `weekly_scoped` 항목은 길이를 따로 주지 않고
/// 종류 이름으로만 주 단위임을 알린다.
const CLAUDE_WEEKLY_SCOPED_LABEL_LENGTH: &str = "7일";

/// `GET /api/oauth/usage` 응답에서 창 목록을 만든다.
///
/// 계정 전체에 걸리는 창은 최상위 `five_hour`·`seven_day`로 오고, 모델별 주간 창은
/// `limits[]` 배열에 `kind: "weekly_scoped"` 항목으로 온다(예: Fable). 모델 이름은
/// 서버가 `scope.model.display_name`으로 주므로 특정 모델을 코드에 박지 않는다 —
/// 새 모델 버킷이 생겨도 그대로 따라온다. 최상위에 `seven_day_fable` 같은 모델별 키는
/// 없다.
fn claude_usage_windows(value: &Value) -> Vec<AccountUsageWindow> {
    let mut windows = [
        ("5시간", value.get("five_hour")),
        ("7일", value.get("seven_day")),
    ]
    .into_iter()
    .filter_map(|(label, value)| value.and_then(|value| usage_window(label, value)))
    .collect::<Vec<_>>();
    let scoped = value
        .get("limits")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|entry| entry.get("kind").and_then(Value::as_str) == Some("weekly_scoped"))
        .filter_map(|entry| {
            let model = trimmed_str(entry.get("scope")?.get("model")?.get("display_name")?)?;
            Some(AccountUsageWindow {
                model_scoped: true,
                ..usage_window(
                    &scoped_window_label(model, CLAUDE_WEEKLY_SCOPED_LABEL_LENGTH),
                    entry,
                )?
            })
        })
        .collect::<Vec<_>>();
    for window in scoped {
        // 최상위 창과 라벨이 겹치면 계정 전체 창을 남긴다 — 판정에 쓰이는 쪽이다.
        if !windows.iter().any(|kept| kept.label == window.label) {
            windows.push(window);
        }
    }
    windows
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

enum CodexCliUsageResponse {
    Usage(AccountUsageView),
    /// `account/rateLimits/read`가 아직 없는 구버전 CLI. 이때만 직접 조회를 유지한다.
    Unsupported,
    /// 공식 CLI가 자체 갱신까지 시도한 뒤 인증 거부를 확정했다.
    CredentialRejected,
}

#[derive(Debug)]
struct CodexRpcError {
    code: i64,
    message: String,
}

/// app-server를 띄워 요청 하나를 주고받는다.
///
/// 공급자 공식 프로세스에 고정된 argv와 구조화 JSON-RPC만 전달한다(G9). 자격증명은
/// C4 프로필에서 Codex가 직접 읽고 회전하며, Core는 stdout의 결과만 받는다.
/// 초기화 왕복·타임아웃·자식 정리는 어느 메서드든 같으므로 여기서만 다루고, 결과 해석은
/// 호출부가 한다 — 메서드마다 오류 코드를 다르게 읽어야 하므로 RPC 오류를 그대로 넘긴다.
fn codex_app_server_request(
    executable: &Path,
    env: &[(String, String)],
    what: &str,
    method: &str,
    params: Value,
) -> Result<Result<Value, CodexRpcError>, CoreError> {
    let mut command = Command::new(executable);
    command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // 공급자 로그에는 인증 실패 원문이 섞일 수 있으므로 보관하거나 노출하지 않는다.
        .stderr(Stdio::null());
    for (key, value) in env {
        command.env(key, value);
    }
    // 사용량 조회는 채팅 회차 전후의 백그라운드 작업이다. GUI 백엔드에서 Windows
    // 콘솔 CLI를 그대로 띄우면 조회할 때마다 cmd 창이 잠깐 나타날 수 있다.
    crate::chat::configure_no_window_command(&mut command);
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!(
            "Codex 공식 {what}을(를) 시작하지 못했습니다: {error}"
        ))
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| CoreError::Runtime(format!("Codex 공식 {what} stdin을 열지 못했습니다")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CoreError::Runtime(format!("Codex 공식 {what} stdout을 열지 못했습니다")))?;
    let method = method.to_owned();
    let (sender, receiver) = mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let result = (|| {
            write_codex_rpc_line(
                &mut stdin,
                &serde_json::json!({
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "clientInfo": {
                            "name": "agent-manager",
                            "title": "Agent Manager",
                            "version": env!("CARGO_PKG_VERSION")
                        },
                        "capabilities": {"experimentalApi": true}
                    }
                }),
            )?;
            read_codex_rpc_result(&mut reader, 1).map_err(codex_rpc_core_error)?;
            write_codex_rpc_line(&mut stdin, &serde_json::json!({"method": "initialized"}))?;
            write_codex_rpc_line(
                &mut stdin,
                &serde_json::json!({"id": 2, "method": method, "params": params}),
            )?;
            Ok(read_codex_rpc_result(&mut reader, 2))
        })();
        let _ = sender.send(result);
    });

    let result = match receiver.recv_timeout(USAGE_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(CoreError::Runtime(format!(
            "Codex 공식 {what}이(가) {}초를 초과했습니다",
            USAGE_TIMEOUT.as_secs()
        ))),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(CoreError::Runtime(format!(
            "Codex 공식 {what} 작업이 예기치 않게 종료되었습니다"
        ))),
    };
    let _ = child.kill();
    let _ = child.wait();
    let _ = worker.join();
    result
}

fn request_codex_usage_from_app_server(
    executable: &Path,
    env: &[(String, String)],
) -> Result<CodexCliUsageResponse, CoreError> {
    match codex_app_server_request(
        executable,
        env,
        "사용량 조회",
        "account/rateLimits/read",
        Value::Null,
    )? {
        Ok(result) => {
            let limits = result.get("rateLimits").ok_or_else(|| {
                CoreError::Runtime("Codex 공식 사용량 응답에 한도 정보가 없습니다".to_owned())
            })?;
            Ok(CodexCliUsageResponse::Usage(codex_usage_result(
                limits, &result,
            )))
        }
        Err(error) if error.code == -32601 => Ok(CodexCliUsageResponse::Unsupported),
        Err(error) if codex_rpc_rejects_credential(&error) => {
            Ok(CodexCliUsageResponse::CredentialRejected)
        }
        Err(error) => Err(codex_rpc_core_error(error)),
    }
}

/// 리셋 크레딧 한 장을 쓴 결과. 공급자 계약(`ConsumeAccountRateLimitResetCreditOutcome`)
/// 그대로다 — 크레딧이 실제로 줄어드는 것은 `Reset`뿐이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetCreditOutcome {
    /// 크레딧을 쓰고 해당 창이 초기화됐다.
    Reset,
    /// 지금 초기화할 수 있는 창이 없다. 한도를 충분히 쓰지 않았을 때 온다 —
    /// 크레딧은 그대로 남는다.
    NothingToReset,
    /// 쓸 수 있는 크레딧이 없다.
    NoCredit,
    /// 같은 멱등키로 이미 초기화가 끝났다.
    AlreadyRedeemed,
}

impl ResetCreditOutcome {
    fn parse(outcome: &str) -> Option<Self> {
        match outcome {
            "reset" => Some(Self::Reset),
            "nothingToReset" => Some(Self::NothingToReset),
            "noCredit" => Some(Self::NoCredit),
            "alreadyRedeemed" => Some(Self::AlreadyRedeemed),
            _ => None,
        }
    }
}

/// 한도 리셋 크레딧 한 장을 쓴다.
///
/// `creditId`는 넘기지 않는다 — 공급자가 다음 순번을 고르므로 만료가 임박한 것부터
/// 소진된다. `idempotencyKey`는 재시도 때 같은 값을 다시 보내야 두 장이 나가지 않는데,
/// 지금은 재시도를 하지 않으므로 호출마다 새로 만든다.
fn consume_codex_reset_credit_from_app_server(
    executable: &Path,
    env: &[(String, String)],
    idempotency_key: &str,
) -> Result<ResetCreditOutcome, CoreError> {
    let result = codex_app_server_request(
        executable,
        env,
        "한도 리셋",
        "account/rateLimitResetCredit/consume",
        serde_json::json!({"idempotencyKey": idempotency_key}),
    )?
    .map_err(codex_rpc_core_error)?;
    result
        .get("outcome")
        .and_then(Value::as_str)
        .and_then(ResetCreditOutcome::parse)
        .ok_or_else(|| CoreError::Runtime("Codex 한도 리셋 응답을 해석하지 못했습니다".to_owned()))
}

fn write_codex_rpc_line(stdin: &mut impl Write, value: &Value) -> Result<(), CoreError> {
    serde_json::to_writer(&mut *stdin, value)?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    Ok(())
}

fn read_codex_rpc_result(
    reader: &mut impl BufRead,
    expected_id: u64,
) -> Result<Value, CodexRpcError> {
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).map_err(|error| CodexRpcError {
            code: -1,
            message: format!("응답을 읽지 못했습니다: {error}"),
        })?;
        if read == 0 {
            return Err(CodexRpcError {
                code: -1,
                message: "응답 전에 프로세스가 종료되었습니다".to_owned(),
            });
        }
        if line.len() > CODEX_USAGE_RPC_LINE_LIMIT {
            return Err(CodexRpcError {
                code: -1,
                message: "응답이 허용 크기를 초과했습니다".to_owned(),
            });
        }
        let value: Value = serde_json::from_str(&line).map_err(|_| CodexRpcError {
            code: -1,
            message: "응답 JSON을 해석하지 못했습니다".to_owned(),
        })?;
        if value.get("id").and_then(Value::as_u64) != Some(expected_id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(CodexRpcError {
                code: error.get("code").and_then(Value::as_i64).unwrap_or(-1),
                message: error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("알 수 없는 오류")
                    .to_owned(),
            });
        }
        return value.get("result").cloned().ok_or_else(|| CodexRpcError {
            code: -1,
            message: "JSON-RPC 결과가 없습니다".to_owned(),
        });
    }
}

fn codex_rpc_rejects_credential(error: &CodexRpcError) -> bool {
    let message = error.message.to_ascii_lowercase();
    message.contains("401 unauthorized")
        || message.contains("token_expired")
        || message.contains("refresh token")
        || message.contains("not logged in")
}

fn codex_rpc_core_error(error: CodexRpcError) -> CoreError {
    // 공급자 오류 원문은 자격증명이나 원격 본문을 포함할 수 있어 IPC 오류에 싣지 않는다(G4).
    CoreError::Runtime(format!(
        "Codex 공식 사용량 조회가 실패했습니다 (RPC {})",
        error.code
    ))
}

/// Codex 사용량 401 본문이 "회복 불가"를 밝혔을 때만 그 사유를 준다.
///
/// 서버는 401을 코드로 구분해 준다(2026-08-27 실측). `token_expired`는 비활성 계정의
/// 보관 사본이 낡았을 뿐이라 그 계정으로 CLI를 띄우면 풀리지만, `token_invalidated`
/// 계열은 리프레시 사슬이 다른 곳에서 회전·폐기된 것이라 기다려도 영영 돌아오지
/// 않는다. 이를 낙관 문구로 뭉치면 사용자는 재로그인해야 한다는 것을 알 수 없고,
/// 예약 실행이 죽은 계정으로 계속 시도된다. 코드를 읽지 못하면 낙관 쪽으로 둔다 —
/// 오판의 손해가 "문구가 부정확함"에 그치는 방향이다.
fn codex_usage_401_rejection(body: &str) -> Option<String> {
    let code = serde_json::from_str::<Value>(body)
        .ok()?
        .get("error")?
        .get("code")?
        .as_str()?
        .to_owned();
    matches!(
        code.as_str(),
        "token_invalidated" | "refresh_token_invalidated" | "refresh_token_already_used"
    )
    .then(|| {
        format!(
            "Codex 자격증명이 공급자에서 무효화되었습니다 ({code}). 다른 곳에서 로그인해 토큰이 회전된 것으로 보입니다. 이 계정을 다시 인증해 주세요"
        )
    })
}

/// 사용량과 함께 자격증명 거부 여부를 준다. 거부는 401 본문이 회복 불가를 밝힌
/// 경우뿐이며, 그때 호출자는 인증 상태를 내려 재인증을 요구한다.
fn fetch_codex_usage(secret: &str) -> Result<(AccountUsageView, bool), CoreError> {
    let call = OauthCall::new("Codex 사용량", "조회");
    let credentials: CodexUsageSecret<'_> = serde_json::from_str(secret)?;
    if credentials.tokens.access_token.is_empty() {
        return Err(CoreError::Runtime("Codex OAuth 토큰이 없습니다".to_owned()));
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        AUTHORIZATION,
        bearer_header_value(credentials.tokens.access_token, "Codex")?,
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
    let response = call.send(
        call.client(headers)?
            .get("https://chatgpt.com/backend-api/wham/usage"),
    )?;
    if response.status() == StatusCode::UNAUTHORIZED {
        // Codex는 조회용 액세스 토큰을 앱이 갱신하지 않는다. 갱신 주체가 CLI라서,
        // 활성 계정이 아닌 계정의 보관 사본은 만료되면 그대로 401이 된다(`token_expired`).
        // 그 경우 계정 자격증명이 죽은 것이 아니고 그 계정으로 CLI를 한 번 띄우면
        // 풀리며, 남은 사용량과도 무관하므로 마지막 성공 수치를 그대로 쓰면 된다.
        // 반면 본문이 무효화를 밝히면 기다려도 돌아오지 않으므로 거부로 올린다.
        let body = response.text().unwrap_or_default();
        if let Some(reason) = codex_usage_401_rejection(&body) {
            return Ok((usage_retry_soon(reason), true));
        }
        return Err(CoreError::Runtime(
            "Codex 사용량 조회 토큰이 만료되었습니다 (HTTP 401). 계정 인증은 유효하며 이 계정으로 CLI를 실행하면 갱신됩니다".to_owned(),
        ));
    }
    let response: Value = call.read_json(call.require_success(response)?)?;
    let limits = response
        .get("rate_limit")
        .ok_or_else(|| CoreError::Runtime("Codex 사용량 응답에 한도 정보가 없습니다".to_owned()))?;
    Ok((codex_usage_result(limits, &response), false))
}

/// 한도 항목 하나(`rateLimits` 또는 `rateLimitsByLimitId`의 값)에서 창을 읽는다.
///
/// 직접 wham 응답과 공식 app-server 응답의 필드 이름 차이를 한곳에서 흡수한다.
/// `scope`가 있으면 그 범위에만 걸리는 창이므로 라벨에 범위 이름을 붙이고
/// `model_scoped`로 표시한다.
fn codex_limit_windows(limits: &Value, scope: Option<&str>) -> Vec<AccountUsageWindow> {
    [
        ("5시간", field(limits, &["primary", "primary_window"])),
        ("7일", field(limits, &["secondary", "secondary_window"])),
    ]
    .into_iter()
    .filter_map(|(fallback_label, value)| {
        value.and_then(|value| {
            let length = window_duration_label(value).unwrap_or_else(|| fallback_label.to_owned());
            let label = match scope {
                Some(scope) => scoped_window_label(scope, &length),
                None => length,
            };
            usage_window(&label, value)
                .map(without_unstarted_reset)
                .map(|window| AccountUsageWindow {
                    model_scoped: scope.is_some(),
                    ..window
                })
        })
    })
    .collect()
}

/// 계정 전체가 아닌 범위 하나에만 걸리는 창의 라벨(`Fable 7일`, `GPT-6 7일`). 범위
/// 이름은 모델 표시명이든 한도 이름이든 서버가 주는 문자열이라 길이를 보장하지 않으므로,
/// 예산 정책이 저장할 수 있는 라벨 길이([`crate::usage_budget_policy::MAX_LABEL_CHARS`])
/// 안에 들어오도록 자른다 — 잘림 표시와 뒤에 붙는 창 길이까지 셈에 넣는다. Claude와
/// Codex가 각자 같은 셈을 하던 것을 한 자리로 모았다: 라벨이 한도를 넘으면 그 창을
/// 예산 가드로 지정할 수 없게 되므로 두 공급자가 어긋나면 한쪽만 조용히 지정 불가가 된다.
fn scoped_window_label(scope: &str, length: &str) -> String {
    let budget = crate::usage_budget_policy::MAX_LABEL_CHARS
        .saturating_sub(length.chars().count() + 1 + crate::text_limit::ELLIPSIS.chars().count());
    format!(
        "{} {length}",
        crate::text_limit::truncate_chars(scope, budget)
    )
}

/// 계정 전체가 아니라 특정 범위에만 걸리는 한도의 창.
///
/// Codex는 범위별 한도를 `rateLimitsByLimitId` 맵에 limitId를 키로 준다(2026-09-07 실측:
/// 지금은 대표 한도 `codex` 하나뿐이고 각 항목에 `limitId`·`limitName`·`primary`·
/// `secondary`가 들어 있다). 대표 한도(`rateLimits`)와 같은 항목은 이미 최상위에서 읽었으므로
/// 건너뛴다 — limitId가 같거나 내용이 같으면 같은 항목이다. limitId를 코드에 박지 않으므로
/// 모델 전용 버킷이 새로 생겨도 그대로 따라온다. Claude가 `limits[]`의 `weekly_scoped`를
/// 다루는 방식([`claude_usage_windows`])과 같은 방침이다.
fn codex_scoped_windows(envelope: &Value, limits: &Value) -> Vec<AccountUsageWindow> {
    let primary_limit_id = codex_limit_id(limits);
    field(
        envelope,
        &["rateLimitsByLimitId", "rate_limits_by_limit_id"],
    )
    .and_then(Value::as_object)
    .map(|entries| {
        entries
            .iter()
            .filter(|(key, entry)| {
                let id = codex_limit_id(entry).unwrap_or(key.as_str());
                primary_limit_id != Some(id) && *entry != limits
            })
            .flat_map(|(key, entry)| {
                let id = codex_limit_id(entry).unwrap_or(key.as_str());
                let scope = field(entry, &["limitName", "limit_name"])
                    .and_then(trimmed_str)
                    .unwrap_or(id)
                    .to_owned();
                codex_limit_windows(entry, Some(&scope))
            })
            .collect()
    })
    .unwrap_or_default()
}

fn codex_limit_id(limits: &Value) -> Option<&str> {
    field(limits, &["limitId", "limit_id"]).and_then(trimmed_str)
}

/// 크레딧 한 장의 만료 시각(초). 크레딧을 고르고 정렬하고 내보내는 세 자리가 같은
/// 이름 후보를 각자 적고 있어 한곳만 고치면 순번과 표시가 서로 다른 장을 가리킨다.
fn credit_expires_at(credit: &Value) -> Option<f64> {
    number_field(credit, &["expiresAt", "expires_at"])
}

/// 사용량 응답의 `rateLimitResetCredits`에서 쓸 수 있는 크레딧만 추린다.
///
/// `status`는 `available`·`redeeming`·`redeemed`·`unknown`인데, 실제로 지금 쓸 수 있는 것은
/// `available`뿐이다. 사용 중(`redeeming`)이나 이미 쓴 것(`redeemed`)을 장수에 넣으면 화면이
/// 쓸 수 있다고 알리고 소비는 `noCredit`으로 실패한다. 공급자가 주는 `availableCount`는
/// 참고만 하고, 목록을 직접 세어 상태와 어긋나지 않게 한다.
fn codex_reset_credits(envelope: &Value) -> Option<AccountResetCredits> {
    let credits = field(
        envelope,
        &["rateLimitResetCredits", "rate_limit_reset_credits"],
    )?;
    let available = credits
        .get("credits")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|credit| credit.get("status").and_then(Value::as_str) == Some("available"))
        .collect::<Vec<_>>();
    // 목록을 주지 않고 장수만 주는 응답도 받아들인다.
    let available_count = if available.is_empty() {
        number_field(credits, &["availableCount", "available_count"]).unwrap_or(0.0) as u32
    } else {
        available.len() as u32
    };
    // 가장 먼저 만료되는 크레딧. 공급자가 다음 순번으로 고르는 장이기도 하다.
    let earliest = available
        .iter()
        .filter(|credit| credit_expires_at(credit).is_some())
        .min_by(|a, b| {
            credit_expires_at(a)
                .unwrap_or(f64::MAX)
                .total_cmp(&credit_expires_at(b).unwrap_or(f64::MAX))
        })
        .or(available.first())
        .copied();
    Some(AccountResetCredits {
        available_count,
        next_expires_at: earliest
            .and_then(credit_expires_at)
            .map(|seconds| (seconds as i64).saturating_mul(1000)),
        next_credit_id: earliest
            .and_then(|credit| credit.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        title: available
            .first()
            .and_then(|credit| string_field(credit, &["title"])),
    })
}

/// `envelope`은 `limits`를 담은 응답 전체다. 범위별 한도와 리셋 크레딧이 그 옆에 오기
/// 때문에 같이 받는다.
fn codex_usage_result(limits: &Value, envelope: &Value) -> AccountUsageView {
    let mut windows = codex_limit_windows(limits, None);
    for window in codex_scoped_windows(envelope, limits) {
        // 대표 창과 라벨이 겹치면 계정 전체 창을 남긴다 — 판정에 쓰이는 쪽이다.
        if !windows.iter().any(|kept| kept.label == window.label) {
            windows.push(window);
        }
    }
    AccountUsageView {
        reset_credits: codex_reset_credits(envelope),
        ..usage_result(windows)
    }
}

/// Codex와 Antigravity는 아직 소비가 없는 창에도 초기화 시각을 준다 — 값이
/// `조회 시각 + 창 길이`라 조회할 때마다 폴링 주기만큼 뒤로 밀린다(2026-08-29 Codex 실측:
/// 0% 창의 `resets_at`이 `updated_at`과 초 단위까지 정확히 5시간·7일 차이. 2026-09-04
/// Antigravity 실측: `remaining_fraction`이 1인 버킷의 `reset_time`이 조회마다 밀림).
/// 시작되지 않은 창에 초기화란 없으므로 Claude가 같은 상황에서 주는 값(`None`)으로
/// 맞춘다. 그래야 설정 화면과 사이드바의 "초기화" 표시가 실제 소비 중인 창만 따라가고,
/// 페이싱이 밀리는 값을 창 리셋으로 오인해 예약과 회당 소비 실측을 버리지 않는다.
pub(crate) fn without_unstarted_reset(window: AccountUsageWindow) -> AccountUsageWindow {
    if window.used_percent <= 0.0 {
        AccountUsageWindow {
            resets_at: None,
            ..window
        }
    } else {
        window
    }
}

/// Codex 창 길이는 플랜에 따라 다르므로(예: Team은 primary가 7일) 응답의
/// 창 길이 필드가 있으면 그것으로 라벨을 만든다.
fn window_duration_label(value: &Value) -> Option<String> {
    let seconds = number_field(value, &["limit_window_seconds", "window_seconds"])
        .or_else(|| {
            number_field(
                value,
                &[
                    "windowDurationMins",
                    "window_minutes",
                    "limit_window_minutes",
                ],
            )
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
    let used_percent = number_field(
        value,
        &["usedPercent", "used_percent", "utilization", "percent"],
    )?;
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
        ..Default::default()
    })
}

/// 연속 제한 횟수에 맞춘 재시도 간격. 15분에서 시작해 두 배씩 늘리고 6시간에서 멈춘다.
///
/// 같은 간격으로 계속 재제출하면 서버에는 제한을 풀 근거가 생기지 않는다. 2026-08-27
/// 사건에서 앱은 13시간 동안 15분 간격으로 약 52회를 보냈다. 이 수열이면 8회다.
/// 홈 신원 조회 실패 뒤 재시도까지의 대기. 30분에서 시작해 실패마다 두 배, 6시간 상한.
fn home_identity_retry_ms(streak: u32) -> i64 {
    let doublings = streak.saturating_sub(1).min(8);
    HOME_IDENTITY_RETRY_BASE_MS
        .saturating_mul(1_i64 << doublings)
        .min(HOME_IDENTITY_RETRY_MAX_MS)
}

fn claude_refresh_backoff_ms(streak: u32) -> i64 {
    CLAUDE_RATE_LIMIT_DEFAULT_RETRY_MS
        .saturating_mul(1i64 << streak.min(8))
        .min(CLAUDE_REFRESH_BACKOFF_MAX_MS)
}

/// 서버가 제한 창을 실제로 알려 줬을 때만 그 시각을 준다. 알려 주지 않으면 `None`이라
/// 호출자가 백오프 수열로 정한다. [`retry_at_from_headers`]는 기본값까지 채워 돌려주므로
/// "서버가 말했는가"를 구분하지 못한다.
fn retry_at_hint_from_headers(headers: &HeaderMap, now: i64) -> Option<i64> {
    headers.get(RETRY_AFTER)?;
    Some(retry_at_from_headers(headers, now))
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

/// 사용량 값 없이 상태와 사유만 돌려주는 결과의 공통 바탕. 재시도 가능한 오류와
/// 조회 불가 상태는 `status`·`retry_at`만 다르고 나머지 초기화 규칙은 같다.
fn usage_problem_result(
    status: AccountUsageStatus,
    message: impl Into<String>,
    retry_at: Option<i64>,
) -> AccountUsageView {
    AccountUsageView {
        status,
        updated_at: Some(now_ms()),
        error: Some(message.into()),
        retry_at,
        ..Default::default()
    }
}

fn usage_retry_result(message: impl Into<String>, retry_at: i64) -> AccountUsageView {
    usage_problem_result(AccountUsageStatus::Error, message, Some(retry_at))
}

/// 조회가 실패했지만 사정이 바뀔 수 있는 상태. 재시도 시각은 어느 갈래나 같은 표준
/// 대기라, 호출부마다 `now_ms()`에 상수를 더하던 여섯 벌을 여기로 모았다.
fn usage_retry_soon(message: impl Into<String>) -> AccountUsageView {
    usage_retry_result(message, now_ms().saturating_add(USAGE_ERROR_RETRY_MS))
}

fn rate_limited_usage_result(message: impl Into<String>, retry_at: i64) -> AccountUsageView {
    AccountUsageView {
        rate_limited: true,
        ..usage_retry_result(message, retry_at)
    }
}

/// OAuth 토큰 갱신 엔드포인트가 돌려준 429. 남은 사용량과 무관하므로 한도
/// 페일오버 후보 제외 사유로 쓰지 않는다.
fn token_refresh_limited_usage_result(
    message: impl Into<String>,
    retry_at: i64,
    streak: u32,
) -> AccountUsageView {
    AccountUsageView {
        token_refresh_limited: true,
        token_refresh_throttle_streak: streak,
        ..rate_limited_usage_result(message, retry_at)
    }
}

/// 조회를 시도조차 할 수 없어 값이 없는 상태. 재시도 대기가 아니므로 `retry_at`을
/// 두지 않는다 — 사정이 바뀌면(공유 홈에서 CLI가 토큰을 갱신하면) 다음 주기에 그냥 된다.
fn usage_unavailable_result(message: impl Into<String>) -> AccountUsageView {
    usage_problem_result(AccountUsageStatus::Unavailable, message, None)
}

/// 공유 CLI 홈의 자격증명으로 사용량을 조회한다. 읽기 전용 HTTP 요청만 보내고
/// 토큰을 갱신하지 않으며, 공식 CLI도 띄우지 않는다(CLI는 홈에 토큰을 회전시켜 쓴다).
fn fetch_home_usage(provider: ProviderId, secret: &str, now: i64) -> AccountUsageView {
    let fetched = match provider {
        ProviderId::Codex => fetch_codex_usage(secret).map(|(usage, _)| usage),
        ProviderId::Claude => {
            if claude_access_token_expired(secret, now) {
                return usage_unavailable_result(
                    "공유 홈의 액세스 토큰이 만료돼 조회할 수 없습니다. Agent Manager는 이 토큰을 갱신하지 않습니다 — 데스크탑 앱이나 터미널에서 이 로그인을 쓰면 CLI가 갱신하고, 그 뒤에 조회됩니다",
                );
            }
            match request_claude_usage(secret).map(ClaudeUsageResponse::into_usage_or_unauthorized)
            {
                Ok(Some(usage)) => Ok(usage),
                Ok(None) => {
                    return usage_unavailable_result(
                        "공유 홈의 자격증명이 거부됐습니다 (HTTP 401). 데스크탑 앱이나 터미널에서 다시 로그인하면 조회됩니다",
                    );
                }
                Err(error) => Err(error),
            }
        }
        // 공유 홈의 로그인은 그 홈에서 묻는다. 계정을 인자로 받는 조회가 없어 홈이 곧 계정이다.
        ProviderId::Antigravity => {
            let Some(home) = crate::user_home::optional_home_dir() else {
                return usage_unavailable_result(
                    "사용자 홈을 확인하지 못해 공유 홈 사용량을 조회할 수 없습니다",
                );
            };
            return crate::antigravity_usage::account_usage(&home, &[]);
        }
        ProviderId::Local => {
            return usage_unavailable_result("로컬 LLM은 사용량 한도가 없어 조회하지 않습니다")
        }
    };
    fetched.unwrap_or_else(usage_error_result)
}

fn usage_error_result(error: CoreError) -> AccountUsageView {
    usage_retry_soon(error.to_string())
}

/// 계정 메모 입력을 저장 형태로 정리한다. 앞뒤 공백을 제거하고 빈 값은 삭제로
/// 보며, 길이 제한을 넘으면 저장하지 않고 입력 오류로 돌려준다.
fn normalize_account_note(note: Option<&str>) -> Result<Option<String>, CoreError> {
    let Some(note) = note else {
        return Ok(None);
    };
    let normalized = note.replace("\r\n", "\n");
    let Some(note) = trimmed(&normalized) else {
        return Ok(None);
    };
    if note.chars().count() > ACCOUNT_NOTE_MAX_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "계정 메모는 {ACCOUNT_NOTE_MAX_CHARS}자까지 저장할 수 있습니다"
        )));
    }
    Ok(Some(note.to_owned()))
}

/// 사용자가 붙인 계정 표시 이름을 정리한다. 목록 한 줄에 들어가야 하므로 줄바꿈은
/// 공백으로 접고, 빈 값은 사용자 지정 해제(None)로 본다.
fn normalize_account_label(label: Option<&str>) -> Result<Option<String>, CoreError> {
    let Some(label) = label else {
        return Ok(None);
    };
    let collapsed = label.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return Ok(None);
    }
    if collapsed.chars().count() > ACCOUNT_LABEL_MAX_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "계정 표시 이름은 {ACCOUNT_LABEL_MAX_CHARS}자까지 저장할 수 있습니다"
        )));
    }
    Ok(Some(collapsed))
}

/// 방금 저장한 사용량이 100% 도달(=자동전환 트리거)인지 판정한다.
///
/// "전환을 고려할 만한가"는 "계정이 통째로 막혔는가"([`account_exhausted`])와 다른 질문이라
/// 대표 창 하나로 느슨하게 본다. 모델군 쿼터를 가진 계정에서 대표 창은 빡빡한 모델군의
/// 복사본이므로, 한 모델군만 차도 신호가 뜬다 — 그 모델군 실행은 여기서 더 못 돌고,
/// 게이트가 모델군을 알아본 뒤로는 한도 오류(`AgentLimited`)조차 나지 않아 이 신호가
/// 아니면 활성 계정이 리셋까지 그대로 앉아 있게 된다. 실제로 옮길지는 후보가 정한다.
fn usage_indicates_exhaustion(usage: &AccountUsageView) -> bool {
    governing_windows(&usage.windows).any(|window| window.used_percent >= 100.0)
}

/// 창 라벨에서 모델군 이름을 뗀다(`Claude and GPT models · 7일` → `Claude and GPT models`).
/// 라벨은 `{그룹 이름} · {창}`으로 만들어지므로([`crate::antigravity_usage`]) 이 한 규칙으로
/// 모든 모델군 창이 갈린다. 구분자가 없는 모델 한정 창(Claude의 `Fable 7일`)은 라벨 전체가
/// 그룹이 되어 저 혼자 한 그룹을 이룬다.
fn model_group_of(label: &str) -> &str {
    label.split_once(" · ").map_or(label, |(group, _)| group)
}

/// 이 계정을 **통째로** 막는 소진인지. `full`은 창 하나가 다 찼는지 보는 규칙이며, 부르는
/// 쪽이 리셋 시각까지 볼지 정한다.
///
/// 대표 창을 모델군에서 합쳐 내는 공급자(Antigravity)만 모델군 규칙을 쓴다. 그때는
/// **모든 모델군이 찼을 때만** 계정이 막힌 것이다 — 한 모델군이 소진됐다고 계정을 빼면
/// 다른 모델군의 쿼터를 통째로 버리게 되고, 페이싱은 그 창으로 계정을 뽑는데 실행 게이트가
/// 거부해 예약만 쌓인다.
///
/// 그 밖의 공급자는 종전 그대로 [`governing_windows`] 하나로 판정한다. 갈래를 "대표 창이
/// 남았는가"로 가르면, 대표 한도 없이 모델 한정 창만 오는 응답(Claude `limits[]`)이 모델군
/// 규칙으로 넘어가 한 모델의 소진이 계정 전체를 막는다 — `model_scoped`가 막으려던 바로
/// 그 구멍이다.
fn account_exhausted(
    windows: &[AccountUsageWindow],
    full: impl Fn(&AccountUsageWindow) -> bool,
) -> bool {
    if !windows.iter().any(|window| window.aggregate) {
        return governing_windows(windows).any(&full);
    }
    let mut groups: BTreeMap<&str, bool> = BTreeMap::new();
    for window in windows.iter().filter(|window| window.model_scoped) {
        let exhausted = groups.entry(model_group_of(&window.label)).or_insert(false);
        *exhausted |= full(window);
    }
    // 창을 하나도 읽지 못한 계정은 소진이 아니다 — 모르는 것과 다 쓴 것은 다르다.
    !groups.is_empty() && groups.into_values().all(|exhausted| exhausted)
}

/// 이 창들이 **모두** 풀리는 시각. 리셋 시각을 알려 주지 않은 창은 셈에서 빠지고, 찬 창이
/// 없으면 기다릴 것도 없다.
fn windows_clear_at<'a>(
    windows: impl Iterator<Item = &'a AccountUsageWindow>,
    full: impl Fn(&AccountUsageWindow) -> bool,
) -> Option<i64> {
    windows
        .filter(|window| full(window))
        .filter_map(|window| window.resets_at)
        .max()
}

/// 계정이 다시 열리는 시각. 모델군 규칙을 쓰는 계정은 **가장 먼저 풀리는 모델군**이 계정을
/// 여는 시각이다 — 그룹 안에서는 찬 창이 모두 풀려야 하므로 `max`, 그룹 사이에서는 하나만
/// 풀려도 쓸 수 있으므로 `min`이다. 여기서 늦은 쪽을 말하면 이미 받아들여질 회차를 몇십
/// 시간 더 기다리라고 안내하게 된다.
fn account_clear_at(windows: &[AccountUsageWindow], now: i64) -> Option<i64> {
    let full = |window: &AccountUsageWindow| {
        window.used_percent >= 100.0 && window.resets_at.is_none_or(|resets_at| resets_at > now)
    };
    if !windows.iter().any(|window| window.aggregate) {
        return windows_clear_at(governing_windows(windows), full);
    }
    let mut groups: BTreeMap<&str, Vec<&AccountUsageWindow>> = BTreeMap::new();
    for window in windows.iter().filter(|window| window.model_scoped) {
        groups
            .entry(model_group_of(&window.label))
            .or_default()
            .push(window);
    }
    groups
        .into_values()
        .filter_map(|group| windows_clear_at(group.into_iter(), full))
        .min()
}

/// 계정 전체의 가용성을 대표하는 창만 남긴다.
///
/// 모델별 주간 창(`model_scoped`)은 그 모델을 쓰는 실행에만 걸린다. Fable 주간 한도가
/// 다 찼다고 해서 Opus로 도는 회차까지 막거나, 그 계정을 소진으로 보고 페일오버 후보에서
/// 빼면 실제로 남은 한도를 버리게 된다. 그래서 화면에는 보여 주되 소진·여유·재개 시각
/// 판정에서는 뺀다. 특정 모델 창을 게이트로 쓰고 싶으면 페이싱 탭에서 그 라벨을 직접
/// 지정한다(`usage_pacing`은 라벨로 창을 찾는다).
fn governing_windows(windows: &[AccountUsageWindow]) -> impl Iterator<Item = &AccountUsageWindow> {
    windows.iter().filter(|window| !window.model_scoped)
}

/// 토큰 갱신 엔드포인트 429로 잡힌 대기가 아직 남아 있으면 그 시각. 사용량 조회의
/// 429(`rate_limited`)와 달리 이 대기는 갱신 요청만 막는다. 액세스 토큰이 아직 살아
/// 있으면 조회는 그대로 보낸다.
fn token_refresh_retry_pending(usage: &AccountUsageView, now: i64) -> Option<i64> {
    usage
        .retry_at
        .filter(|_| usage.token_refresh_limited)
        .filter(|retry_at| *retry_at > now)
}

/// 새 자격증명을 저장한 계정의 사용량 표시에서 이전 자격증명이 남긴 실패만 지운다.
/// 마지막 성공 수치와 그 시각은 보관 값으로 남기고 오류·재시도 대기·제한 표시만
/// 비워, 재인증 직후 폴링이 미뤄지지 않고 곧바로 실제 값을 다시 채우게 한다.
fn usage_error_cleared(usage: &AccountUsageView) -> AccountUsageView {
    AccountUsageView {
        status: if usage.windows.is_empty() {
            AccountUsageStatus::Idle
        } else {
            AccountUsageStatus::Ok
        },
        windows: usage.windows.clone(),
        updated_at: usage.updated_at,
        // 마지막으로 읽은 크레딧도 보관 값이다. 재인증 직후 지우면 화면에서 잠깐 사라진다.
        reset_credits: usage.reset_credits.clone(),
        // 오류·재시도 대기·제한 표시는 기본값(비움)으로 되돌린다.
        ..Default::default()
    }
}

/// 창 초기화 시각이 마지막 조회 뒤에 지났는지. 지났으면 저장된 수치가 실제보다
/// 높으므로 주기와 무관하게 곧바로 다시 읽는다. 프론트엔드의
/// `usageResetElapsedSinceUpdate`(`src/lib/accountUsage.ts`)와 같은 판정이다.
fn usage_reset_elapsed_since_update(usage: &AccountUsageView, now: i64) -> bool {
    let Some(updated_at) = usage.updated_at else {
        return false;
    };
    usage.windows.iter().any(|window| {
        window
            .resets_at
            .is_some_and(|resets_at| resets_at > updated_at && resets_at <= now)
    })
}

/// 이 계정의 사용량 갱신 주기가 아직 돌아오지 않았는지. 활성 계정과 런타임이 붙은
/// 계정만 사용량이 올라갈 수 있으므로 짧은 주기로 보고, 나머지는 길게 본다.
/// 조회한 적이 없거나 창 초기화 시각이 지났으면 주기와 무관하게 갱신 대상이다.
/// 프론트엔드의 `usageRefreshInterval`(`src/lib/accountUsage.ts`)과 같은 판정이다.
fn usage_refresh_fresh_for_interval(usage: &AccountUsageView, now: i64, busy: bool) -> bool {
    let Some(updated_at) = usage.updated_at else {
        return false;
    };
    if usage_reset_elapsed_since_update(usage, now) {
        return false;
    }
    let interval = if busy {
        BUSY_USAGE_REFRESH_INTERVAL_MS
    } else {
        IDLE_USAGE_REFRESH_INTERVAL_MS
    };
    now - updated_at < interval
}

/// 재시도 대기 시각이 아직 남았는지. 프론트엔드의 `usageRefreshDeferred`
/// (`src/lib/accountUsage.ts`)와 같은 판정이다.
fn usage_refresh_deferred(usage: &AccountUsageView, now: i64) -> bool {
    usage.retry_at.is_some_and(|retry_at| retry_at > now)
}

/// 캐시된 사용량 기준으로 계정이 아직 제한 상태로 보여 자동전환 후보에서
/// 제외해야 하는지 판정한다. 리셋 시각이 지났으면 다시 후보가 된다.
fn usage_blocks_auto_switch(usage: &AccountUsageView, now: i64) -> bool {
    usage_blocks_run(usage, &[], now)
}

/// 이 사용량이 지금 실행을 막는지. `model_windows`가 비어 있지 않으면 이번 실행이 쓸
/// 모델군 창이며, 그 창만 본다 — 계정의 다른 모델군이 소진됐어도 이 모델군의 쿼터는
/// 그대로 남아 있다([`model_scoped_windows`]). 비어 있으면 계정 전체 판정이다.
fn usage_blocks_run(
    usage: &AccountUsageView,
    model_windows: &[&AccountUsageWindow],
    now: i64,
) -> bool {
    // 토큰 갱신 엔드포인트의 429는 남은 사용량을 말해 주지 않는다. 이걸 한도로
    // 취급하면 갱신이 막힌 계정이 페일오버 후보에서 영구 제외된다.
    if usage.rate_limited
        && !usage.token_refresh_limited
        && usage.retry_at.is_none_or(|retry_at| retry_at > now)
    {
        return true;
    }
    let full = |window: &AccountUsageWindow| {
        window.used_percent >= 100.0 && window.resets_at.is_none_or(|resets_at| resets_at > now)
    };
    if !model_windows.is_empty() {
        return model_windows.iter().copied().any(full);
    }
    account_exhausted(&usage.windows, full)
}

/// 이번 실행이 소비할 모델군 창. 공급자가 모델군마다 쿼터를 따로 들고 있고 이번 실행의
/// 모델을 알 때만 값이 있다. 모델군이 없는 공급자에서는 비어 있어, 판정이 종전 그대로
/// 계정 전체 창을 본다.
fn model_scoped_windows<'a>(
    provider: ProviderId,
    model: Option<&str>,
    windows: &'a [AccountUsageWindow],
) -> Vec<&'a AccountUsageWindow> {
    let (ProviderId::Antigravity, Some(model)) = (provider, model) else {
        return Vec::new();
    };
    // 모델군을 가릴 수 없는 이름은 계정 전체 판정에 맡긴다. `model_consumes_window`는
    // 모르는 모델을 모든 창에 걸리게 하는데(점유를 셀 때는 그래야 겹쳐 띄우지 않는다),
    // 게이트에서 그대로 쓰면 한 모델군만 차도 막혀 모델을 아예 밝히지 않은 실행보다
    // 엄격해진다 — 모델을 적었다고 더 막히는 것은 뒤집힌 결과다.
    if crate::antigravity_usage::pacing_resource_id_for_model(model).is_err() {
        return Vec::new();
    }
    windows
        .iter()
        .filter(|window| {
            window.model_scoped
                && crate::antigravity_usage::model_consumes_window(model, &window.label)
        })
        .collect()
}

/// 한도에 걸린 계정을 다시 시도해 볼 만한 가장 이른 시각. 캐시된 백오프와 소진된
/// 사용량 창의 리셋 시각 중 늦은 쪽을 쓴다 — 둘 중 이른 쪽을 고르면 아직 리셋되지
/// 않은 창을 두고 다시 CLI를 띄우게 된다. 공급자가 시각을 알려주지 않았으면 `None`이고,
/// 그때는 다음 사용량 조회가 상태를 풀 때까지 기다린다.
fn usage_resume_at(
    usage: &AccountUsageView,
    model_windows: &[&AccountUsageWindow],
    now: i64,
) -> Option<i64> {
    let backoff = usage
        .retry_at
        .filter(|_| usage.rate_limited && !usage.token_refresh_limited);
    // 이번 실행이 기다리는 창만 본다. 모델군을 아는 실행에서 계정의 다른 모델군 리셋을
    // 함께 세면, 이 모델군이 먼저 풀려도 그때까지 기다리라고 말하게 된다. 그 모델군이
    // 열리려면 그 안에서 찬 창이 모두 풀려야 하므로 그룹 안에서는 늦은 쪽이다.
    let exhausted_window = if model_windows.is_empty() {
        account_clear_at(&usage.windows, now)
    } else {
        windows_clear_at(model_windows.iter().copied(), |window| {
            window.used_percent >= 100.0 && window.resets_at.is_none_or(|resets_at| resets_at > now)
        })
    };
    [backoff, exhausted_window]
        .into_iter()
        .flatten()
        .filter(|resume_at| *resume_at > now)
        .max()
}

/// 페일오버 후보를 정책에 따라 고른다. 세 정책 모두 같은 자격 조건(자동전환 켜짐,
/// 사용 가능, 인증 정상, 한도에 걸리지 않음)을 통과한 계정만 본다.
/// `min_usage_gap_percent`를 주면 `active_account_id`보다 그 폭(%p) 이상 덜 쓴 계정만
/// 본다(분산 교체 트리거). 사용량을 모르는 계정은 이때 후보에서 뺀다 — 얼마나
/// 뒤처졌는지 모르는 계정으로 옮기면 오히려 더 많이 쓴 계정으로 갈 수 있다. 첫 조회는
/// 곧 들어오고, 격차 조건이 없는 소진 트리거는 그 계정을 계속 후보로 보므로 새로 등록한
/// 계정이 영영 굶지는 않는다.
fn select_auto_switch_target(
    accounts: &[AccountRecord],
    provider: ProviderId,
    active_account_id: &str,
    purpose: &SwitchPurpose<'_>,
    now: i64,
    policy: AutoSwitchPolicy,
    min_usage_gap_percent: Option<f64>,
) -> Option<String> {
    let limited = accounts
        .iter()
        .find(|account| account.id == active_account_id);
    let groups = PurposeGroups::of(provider, purpose.models, limited);
    let pick = |relax_open: bool| {
        let eligibility = AutoSwitchEligibility::new(
            limited,
            provider,
            active_account_id,
            purpose,
            &groups,
            relax_open,
            now,
            min_usage_gap_percent,
        )?;
        match policy {
            AutoSwitchPolicy::Registration => {
                select_next_in_registration_order(accounts, &eligibility)
            }
            AutoSwitchPolicy::Priority => select_by_auto_switch_priority(accounts, &eligibility),
            AutoSwitchPolicy::MaxHeadroom => select_by_max_headroom(accounts, &eligibility),
        }
    };
    // 한도 응답인데 모델군을 가릴 수 없으면 먼저 열린 모델군을 잃지 않는 자리를 찾고, 그런
    // 자리가 없을 때만 어디든 살아 있는 곳으로 간다 — 한 번에 풀어 버리면 막힌 실행이 쓸
    // 모델군까지 찬 계정을 등록 순으로 집어 쿨다운 안에 다시 막힌다. 모델군을 가렸으면
    // 두 번째 시도는 같은 답을 낼 뿐이라 하지 않는다.
    pick(false).or_else(|| {
        (purpose.intent == SwitchIntent::Rebind
            && purpose.reason == AutoSwitchReason::AgentLimited
            && groups.wanted.is_empty())
        .then(|| pick(true))
        .flatten()
    })
}

/// 전환 목적을 모델군으로 옮긴 것. 지정 계정이 보고한 창에서 그 모델의 창을 찾아 그룹
/// 이름을 얻고, 창을 아직 보고하지 않은 계정에서는 모델 자체를 들고 간다 — 후보 쪽 창은
/// 모델로도 가릴 수 있다([`model_scoped_windows`]).
struct PurposeGroups {
    /// 실행들이 쓰는 모델군 이름(지정 계정의 창 라벨 기준).
    wanted: BTreeSet<String>,
    /// 모델군을 가릴 수 있는 모델들. 후보에서 이 모델의 창이 막혀 있으면 그 후보는 그 실행을
    /// 못 받는다. 창 라벨 없이도 판정할 수 있어, 새로 등록해 창이 없는 계정의 한도 응답도
    /// 목적을 잃지 않는다.
    classified_models: Vec<String>,
}

impl PurposeGroups {
    fn of(provider: ProviderId, models: &[String], limited: Option<&AccountRecord>) -> Self {
        let mut wanted = BTreeSet::new();
        let mut classified_models = Vec::new();
        for model in models {
            if provider != ProviderId::Antigravity
                || crate::antigravity_usage::pacing_resource_id_for_model(model).is_err()
            {
                continue;
            }
            classified_models.push(model.clone());
            if let Some(limited) = limited {
                for window in model_scoped_windows(provider, Some(model), &limited.usage.windows) {
                    wanted.insert(model_group_of(&window.label).to_owned());
                }
            }
        }
        Self {
            wanted,
            classified_models,
        }
    }
}

/// 이 계정의 모델군을 **막힌 것 / 열린 것**으로 가른다.
///
/// 모델군마다 쿼터가 따로인 계정에서 전환이 필요해진 까닭은 어느 한 모델군이 찼기 때문이다.
/// 어느 모델군인지는 신호가 모델을 실어 오면 그것으로, 아니면 사용량으로 짚는다 — 한도
/// 응답을 받은 계정은 곧바로 조회가 따라붙어 그 모델군이 100%로 채워진다
/// ([`AccountSupervisor::report_agent_usage_limit`]). 다만 그 조회는 별도 스레드라 한도 응답
/// **직후**의 신호는 아직 갱신 전 수치를 읽는다. 그래서 한도 응답은 실행의 모델을 신호에
/// 싣고, 이 함수는 모델을 모를 때의 폴백이다.
///
/// 모델군 쿼터를 쓰지 않는 공급자는 두 집합이 모두 비어 있고, 그때 후보 자격은 종전 그대로
/// 계정 전체 판정이다.
fn model_group_partition(
    usage: &AccountUsageView,
    now: i64,
) -> (BTreeSet<String>, BTreeSet<String>) {
    if !usage.windows.iter().any(|window| window.aggregate) {
        return (BTreeSet::new(), BTreeSet::new());
    }
    let mut blocked = BTreeSet::new();
    let mut all = BTreeSet::new();
    for window in usage.windows.iter().filter(|window| window.model_scoped) {
        let group = model_group_of(&window.label).to_owned();
        if window.used_percent >= 100.0 && window.resets_at.is_none_or(|resets_at| resets_at > now)
        {
            blocked.insert(group.clone());
        }
        all.insert(group);
    }
    let open = all.difference(&blocked).cloned().collect();
    (blocked, open)
}

/// 이 계정에서 그 모델군이 막혀 있는지. 그 모델군 창을 아예 보고하지 않는 계정은 막힌
/// 것으로 보지 않는다 — 없는 창을 소진으로 읽으면 멀쩡한 후보를 버린다.
fn model_group_blocked(usage: &AccountUsageView, group: &str, now: i64) -> bool {
    usage.windows.iter().any(|window| {
        window.model_scoped
            && model_group_of(&window.label) == group
            && window.used_percent >= 100.0
            && window.resets_at.is_none_or(|resets_at| resets_at > now)
    })
}

/// 이번 전환이 무엇을 살리려는 것인지. 후보 자격은 여기서 갈린다.
struct SwitchPurpose<'a> {
    /// 살려야 하는 실행들의 모델([`AutoSwitchSignal::models`]).
    models: &'a [String],
    reason: AutoSwitchReason,
    intent: SwitchIntent,
}

/// 한 신호가 답해야 하는 두 질문. 후보 자격이 여기서 갈린다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SwitchIntent {
    /// 이 계정에 묶인 세션들을 어디로 옮기나. 그 세션들이 쓰는 모델군만 보고, 한도 응답인데
    /// 모델군을 가릴 수 없으면 "어디든 살아 있는 곳으로" 완화할 수 있다.
    Rebind,
    /// 기본 계정을 어디로 옮기나. 앞으로 열릴 **모든** 대화의 자리라 계정 전체 목적으로 —
    /// 지정 계정에서 열려 있던 모델군을 잃지 않는 곳만 — 고르고 완화하지 않는다. 한도에 걸린
    /// 실행의 모델은 안전망으로만 든다: 그 모델의 창이 막힌 계정을 기본으로 앉히지 않는다.
    DefaultRotation,
}

/// 두 질문의 답과, 두 번째 질문을 물을 조건이었던 사실. 한 잠금 안에서 함께 정해
/// 사용자가 그 사이 기본 계정을 바꾼 것을 덮어쓰지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoSwitchPlan {
    /// 묶인 세션들을 옮길 계정. 옮길 세션이 없어 묻지 않았으면 None.
    pub rebind_target: Option<String>,
    /// 기본 계정을 옮길 계정. 지정 계정이 기본 계정이 아니면 묻지 않는다.
    pub rotate_target: Option<String>,
}

/// 세 정책이 공유하는 후보 자격 조건. 격차 기준값은 만들 때 한 번만 정해진다.
struct AutoSwitchEligibility<'a> {
    provider: ProviderId,
    active_account_id: &'a str,
    now: i64,
    /// 분산 교체일 때만 있는 (요구 격차 %p, 지정 계정의 사용률).
    usage_gap: Option<(f64, f64)>,
    /// 옮겨 가는 실행들이 쓰는 모델군 중 지정 계정에서 **막힌** 것. 후보는 이 중 하나라도
    /// 남아 있어야 하고, 여유도 이 모델군 기준으로 잰다. 모델을 모르면 사용량으로 짚은
    /// 값이다. 비어 있으면 계정 전체를 본다.
    blocked_groups: BTreeSet<String>,
    /// 옮겨 가는 실행들이 쓰는 모델군 중 지정 계정에서 **아직 열려 있는** 것. 후보가 이
    /// 모델군을 막고 있으면 옮겨서 잃는 쪽이 있으므로 고르지 않는다([`Self::permits`]).
    /// 모델을 모르는 사용량 트리거는 계정의 열린 모델군 전부를 여기 둔다 — 그 계정이
    /// 무엇을 하려던 참인지 모르니 어느 쪽도 잃지 않는 자리만 고른다. 모델을 모르는 한도
    /// 응답도 먼저 그렇게 찾고, 그런 자리가 없을 때만 비운다(`relax_open`).
    open_groups: BTreeSet<String>,
    /// 한도에 걸린 실행의 모델. 후보에서 이 모델의 창이 막혀 있으면 그 후보는 뺀다 — 지정
    /// 계정이 창을 보고하지 않아 모델군 이름을 못 얻었을 때의 안전망이다.
    must_serve_models: &'a [String],
}

impl<'a> AutoSwitchEligibility<'a> {
    /// 격차를 재려면 기준이 되는 계정의 사용량을 알아야 한다. 모르면 분산 교체는
    /// 판단 근거가 없으므로 아무 후보도 세우지 않는다(`None`).
    #[allow(clippy::too_many_arguments)]
    fn new(
        limited: Option<&AccountRecord>,
        provider: ProviderId,
        active_account_id: &'a str,
        purpose: &SwitchPurpose<'_>,
        groups: &'a PurposeGroups,
        relax_open: bool,
        now: i64,
        min_usage_gap_percent: Option<f64>,
    ) -> Option<Self> {
        let usage_gap = match min_usage_gap_percent {
            Some(gap) => Some((
                gap,
                limited.and_then(|account| usage_used_percent(&account.usage))?,
            )),
            None => None,
        };
        let wanted = &groups.wanted;
        let (blocked_groups, open_groups) = match limited {
            None => (BTreeSet::new(), BTreeSet::new()),
            Some(limited) => {
                let (blocked, open) = model_group_partition(&limited.usage, now);
                if purpose.intent == SwitchIntent::DefaultRotation {
                    // 기본 계정은 세션이 아니라 앞으로의 모든 대화를 위한 자리다. 세션들의
                    // 모델군으로 좁히지도, 한도 응답이라고 완화하지도 않는다 — 열린 모델군을
                    // 잃지 않는 곳만 고르고, 한도에 걸린 모델의 창은 아래 `must_serve_models`가
                    // 안전망으로 본다.
                    (blocked, open)
                } else {
                    match purpose.reason {
                        AutoSwitchReason::AgentLimited if !wanted.is_empty() => {
                            // 한도 응답이 그 모델군이 막혔다는 증거다. 사용량은 뒤따르는 조회가
                            // 끝나기 전이라 아직 100%가 아닐 수 있으므로 창 수치로 판정하지 않는다.
                            // 그 실행 하나를 살리는 전환이라 다른 모델군은 상관없다.
                            (wanted.clone(), BTreeSet::new())
                        }
                        AutoSwitchReason::UsageSpread if !wanted.is_empty() => {
                            // 분산 교체는 소진이 아니라 균형이 목적이다. 막힌 것은 없고, 유휴
                            // 세션들이 쓰는 모델군을 잃지 않는 자리로만 간다. 격차 조건은 아래
                            // `usage_gap`이 본다.
                            (
                                BTreeSet::new(),
                                open.intersection(wanted).cloned().collect(),
                            )
                        }
                        AutoSwitchReason::UsageExhausted if !wanted.is_empty() => {
                            // 묶인 세션들의 모델군 중 실제로 막힌 것이 있어야 옮길 이유가 있다 —
                            // 전부 열려 있으면 그 세션들은 이 계정에서 멀쩡히 돌고 있으니 옮기지
                            // 않는다(도중인 턴을 끊어 다른 계정에 다시 묶는 것은 비용이다). 기본
                            // 계정 회전은 다른 질문이라 전환 루프가 계정 전체 목적으로 따로 묻는다.
                            let blocked: BTreeSet<String> =
                                blocked.intersection(wanted).cloned().collect();
                            if blocked.is_empty() {
                                return None;
                            }
                            (blocked, open.intersection(wanted).cloned().collect())
                        }
                        AutoSwitchReason::AgentLimited if relax_open => {
                            // 막힌 실행이 확실히 있는데 모델군을 가릴 수 없고, 열린 모델군을 지키는
                            // 자리도 없었다. 어디든 아직 살아 있는 곳으로 옮기는 편이 리셋까지
                            // 세우는 것보다 낫다.
                            (blocked, BTreeSet::new())
                        }
                        _ => {
                            // 무엇을 하려던 참인지 모르는 전환. 상보적으로 소진된 두 계정이 서로를
                            // 고르지 않게, 열린 모델군을 잃는 자리는 뺀다. 정말로 다 막힌 계정은
                            // 열린 것이 없어 멀쩡한 계정으로 그대로 회전한다.
                            (blocked, open)
                        }
                    }
                }
            }
        };
        let must_serve_models: &[String] = if purpose.reason == AutoSwitchReason::AgentLimited {
            &groups.classified_models
        } else {
            &[]
        };
        Some(Self {
            provider,
            active_account_id,
            now,
            usage_gap,
            blocked_groups,
            open_groups,
            must_serve_models,
        })
    }

    fn permits(&self, account: &AccountRecord) -> bool {
        account.provider == self.provider
            && account.id != self.active_account_id
            && account.auto_switch
            && !account.disabled
            && account.auth_status == AccountAuthStatus::Ready
            && !usage_blocks_auto_switch(&account.usage, self.now)
            && self.serves_blocked_groups(&account.usage)
            && self.keeps_open_groups(&account.usage)
            && self.serves_models(&account.usage)
            && self.usage_gap.is_none_or(|(gap, limited)| {
                usage_used_percent(&account.usage)
                    .is_some_and(|candidate| limited - candidate >= gap)
            })
    }

    /// 옮겨 가는 실행들이 쓰는 모델군 중 지정 계정에서 열려 있던 것이 후보에서도 열려
    /// 있는지.
    ///
    /// 이 조건이 없으면 상보적으로 소진된 두 계정이 서로를 계속 고른다 — A는 Gemini가
    /// 막히고 C는 Claude·GPT가 막혔을 때, A에서 보면 C가 Gemini에서 낫고 C에서 보면 A가
    /// Claude·GPT에서 나으므로 사용량 폴링마다(활성 계정 5분) 상대에게 넘기고 되받으며
    /// 세션을 다시 묶는다. 쿨다운 60초는 그 주기를 막지 못한다.
    ///
    /// 지정 계정이 정말로 다 막혔으면 열린 모델군이 없어 이 조건은 비고, 멀쩡한 계정으로의
    /// 회전은 그대로 일어난다 — 기본 계정이 소진된 채 묶이지 않는다.
    fn keeps_open_groups(&self, usage: &AccountUsageView) -> bool {
        self.open_groups
            .iter()
            .all(|group| !model_group_blocked(usage, group, self.now))
    }

    /// 한도에 걸린 실행의 모델 창이 후보에서 열려 있는지. 모델군 이름을 못 얻어 위 두 판정이
    /// 비었을 때도 이것은 남는다.
    fn serves_models(&self, usage: &AccountUsageView) -> bool {
        self.must_serve_models.iter().all(|model| {
            model_scoped_windows(self.provider, Some(model), &usage.windows)
                .iter()
                .all(|window| {
                    !(window.used_percent >= 100.0
                        && window
                            .resets_at
                            .is_none_or(|resets_at| resets_at > self.now))
                })
        })
    }

    /// 옮겨 갈 계정에서 막힌 모델군이 **하나라도** 남아 있는지.
    ///
    /// 계정 전체 판정만 보면 Gemini가 찬 계정에서 Gemini가 똑같이 찬 계정으로 옮기게 된다.
    /// 옮긴 실행은 모델군을 아는 게이트가 다시 거부하고([`AccountSupervisor::run_readiness`]),
    /// `AUTO_SWITCH_COOLDOWN_MS`가 두 번째 전환을 막아 한 회차가 통째로 갇힌다.
    ///
    /// 반대로 막힌 모델군을 **전부** 요구하면 너무 좁다. 지정 계정의 모델군이 둘 다 찼을 때
    /// 이번 전환이 어느 쪽을 위한 것인지는 알 수 없는데, 그때 한 모델군만 비어 있는 계정을
    /// 빼면 그 계정에서 돌 수 있었을 회차까지 버린다. 막힌 모델군이 하나뿐이면 두 규칙이
    /// 같으므로, 단일 모델군 동작은 그대로다.
    fn serves_blocked_groups(&self, usage: &AccountUsageView) -> bool {
        self.blocked_groups.is_empty()
            || self
                .blocked_groups
                .iter()
                .any(|group| !model_group_blocked(usage, group, self.now))
    }
}

/// 등록 순: 지정된 계정 바로 다음부터 한 바퀴 돌아 처음 만나는 후보.
fn select_next_in_registration_order(
    accounts: &[AccountRecord],
    eligibility: &AutoSwitchEligibility,
) -> Option<String> {
    if accounts.is_empty() {
        return None;
    }
    let start = accounts
        .iter()
        .position(|account| account.id == eligibility.active_account_id)
        .map(|index| index + 1)
        .unwrap_or(0);
    (0..accounts.len())
        .map(|offset| &accounts[(start + offset) % accounts.len()])
        .find(|account| eligibility.permits(account))
        .map(|account| account.id.clone())
}

/// 우선순위 순. 우선순위가 없는 계정은 지정된 계정 뒤로 밀고, 같은 순위끼리는 등록 순.
fn select_by_auto_switch_priority(
    accounts: &[AccountRecord],
    eligibility: &AutoSwitchEligibility,
) -> Option<String> {
    accounts
        .iter()
        .enumerate()
        .filter(|(_, account)| eligibility.permits(account))
        .min_by_key(|(index, account)| {
            (
                account.auto_switch_priority.is_none(),
                account.auto_switch_priority.unwrap_or(u32::MAX),
                *index,
            )
        })
        .map(|(_, account)| account.id.clone())
}

/// 남은 여유가 가장 많은 계정.
fn select_by_max_headroom(
    accounts: &[AccountRecord],
    eligibility: &AutoSwitchEligibility,
) -> Option<String> {
    accounts
        .iter()
        .enumerate()
        .filter(|(_, account)| eligibility.permits(account))
        .min_by(|(left_index, left), (right_index, right)| {
            let left = max_headroom_rank(left, *left_index, &eligibility.blocked_groups);
            let right = max_headroom_rank(right, *right_index, &eligibility.blocked_groups);
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
                .then_with(|| left.2.total_cmp(&right.2))
                .then_with(|| left.3.cmp(&right.3))
        })
        .map(|(_, account)| account.id.clone())
}

/// 여유가 많을수록 앞서는 정렬 키(작은 쪽이 먼저). 사용량을 아직 읽지 못한 계정은 여유를
/// 알 수 없으므로 여유를 아는 계정 다음 순서로 밀고 그 안에서는 등록 순으로 본다.
/// 보존된 수치만 있는 계정은 그 사이에 둔다.
///
/// 막힌 모델군이 있으면 그 모델군의 여유로 줄을 세운다. 계정 대표 여유는 가장 빡빡한
/// 모델군의 것이라, Gemini가 90%고 Claude/GPT가 비어 있는 계정은 Claude/GPT 회차를 옮길
/// 자리인데도 여유 10%로 읽혀 뒤로 밀린다.
fn max_headroom_rank(
    account: &AccountRecord,
    index: usize,
    blocked_groups: &BTreeSet<String>,
) -> (bool, bool, f64, usize) {
    let headroom = usage_headroom_for_selection(&account.usage, blocked_groups);
    (
        headroom.is_none(),
        headroom.is_none_or(|(stale, _)| stale),
        -headroom.map_or(0.0, |(_, value)| value),
        index,
    )
}

/// 페일오버 대상을 고를 때 쓸 여유(%)와, 그 값이 마지막 성공 조회에서 보존된
/// 것인지.
///
/// 조회가 실패해도 `apply_usage_stale_policy`가 마지막 성공 수치를 남긴다. 화면은
/// 그 값을 기준 시각과 함께 보여 주는데 대상 선택만 버리고 "여유 미상"으로 다뤘다.
/// 그래서 조회가 막힌 계정은 남은 한도가 아무리 커도 등록 순 꼴찌로 밀렸다.
///
/// 격차 기반 교체(`usage_used_percent`)와 달리 여기서는 보존값을 쓴다. 격차 교체는
/// 옮길지 말지를 정하는 능동적 판단이라 낡은 수치로 하면 안 되지만, 이 자리는 이미
/// 한도에 걸려 어디로든 옮겨야 하는 상황에서 목적지를 고르는 문제다. 그때는 낡은
/// 정보가 무정보보다 낫다. 다만 신선한 값을 아는 계정을 항상 앞에 둔다.
fn usage_headroom_for_selection(
    usage: &AccountUsageView,
    blocked_groups: &BTreeSet<String>,
) -> Option<(bool, f64)> {
    let headroom = |usage: &AccountUsageView| {
        if blocked_groups.is_empty() {
            tightest_window_headroom(&usage.windows)
        } else {
            model_group_headroom(&usage.windows, blocked_groups)
        }
    };
    if usage.status == AccountUsageStatus::Ok {
        if let Some(value) = headroom(usage) {
            return Some((false, value));
        }
    }
    Some((true, headroom(usage)?))
}

/// 이 모델군들에 남은 여유(%). 그 모델군 창을 하나도 보고하지 않는 계정은 여유를 알 수
/// 없다(None).
///
/// 한 모델군 안에서는 창이 **모두** 여유가 있어야 돌므로 가장 빡빡한 창이 그 모델군의
/// 여유다. 모델군 사이에서는 하나만 돌아도 옮길 값어치가 있으므로([`AutoSwitchEligibility::
/// serves_blocked_groups`]) 가장 여유 있는 모델군이 이 계정의 값이다. 반대로 잡으면 막힌
/// 모델군 중 하나가 소진된 계정이 곧바로 여유 0으로 읽혀, 실제로 돌 수 있는 목적지가 줄 맨
/// 뒤로 밀린다.
fn model_group_headroom(
    windows: &[AccountUsageWindow],
    blocked_groups: &BTreeSet<String>,
) -> Option<f64> {
    let mut groups: BTreeMap<&str, f64> = BTreeMap::new();
    for window in windows.iter().filter(|window| {
        window.model_scoped && blocked_groups.contains(model_group_of(&window.label))
    }) {
        let used = groups.entry(model_group_of(&window.label)).or_insert(0.0);
        *used = used.max(window.used_percent);
    }
    let loosest = groups.into_values().reduce(f64::min)?;
    Some((100.0 - loosest).clamp(0.0, 100.0))
}

/// 이 계정이 쓴 사용량(%). 창이 여러 개면 가장 빡빡한 창을 기준으로 본다 — 실제로
/// 한도를 거는 것이 그 창이고, 그 창을 고르게 맞추는 것이 총 가용량을 가장 크게
/// 만든다. 여유와 같은 판정을 공유해 앱 안에서 "사용량"의 정의를 하나로 유지한다.
fn usage_used_percent(usage: &AccountUsageView) -> Option<f64> {
    usage_headroom_percent(usage).map(|headroom| 100.0 - headroom)
}

/// 이 계정에 남은 사용량 여유(%). 창이 여러 개면 가장 빡빡한 창을 기준으로 본다.
/// 사용량을 아직 읽지 못했거나 조회가 실패했으면 None.
fn usage_headroom_percent(usage: &AccountUsageView) -> Option<f64> {
    if usage.status != AccountUsageStatus::Ok {
        return None;
    }
    tightest_window_headroom(&usage.windows)
}

/// 가장 빡빡한 창 기준으로 남은 여유(%). 대표할 창이 하나도 없으면 None —
/// 모델별 창만 있는 계정을 여유 100%로 오해하면 안 된다.
fn tightest_window_headroom(windows: &[AccountUsageWindow]) -> Option<f64> {
    let tightest = governing_windows(windows)
        .map(|window| window.used_percent)
        .reduce(f64::max)?;
    Some((100.0 - tightest).clamp(0.0, 100.0))
}

/// 이 계정으로 지금 실행할 수 있는지의 순수 판정. [`AccountSupervisor::run_readiness`]와
/// 자동전환의 기본 계정 회전([`AccountSupervisor::request_active_account_rotation`])이 같은
/// 규칙을 쓴다 — 한쪽에만 조건을 더하면 실행은 막히는데 기본 계정으로는 앉히는 어긋남이 생긴다.
///
/// 한도에 걸린 계정으로 실행을 시작하면 CLI를 띄워 놓고 곧바로 한도 오류를 받으므로 미리
/// 걸러 리셋될 때까지 대기시킨다. 이번 실행의 모델을 알면 그 모델군 창만 본다 — 다른 모델군의
/// 소진은 이 실행과 상관이 없고, 계정 전체로 막으면 페이싱이 뽑은 계정을 여기서 거부하게 된다.
fn account_readiness(
    account: &AccountRecord,
    provider: ProviderId,
    model: Option<&str>,
    now: i64,
) -> RunReadiness {
    if account.provider != provider || account.disabled {
        return RunReadiness::Disabled;
    }
    if let Some(readiness) = auth_readiness(account.auth_status, &account.usage) {
        return readiness;
    }
    let model_windows = model_scoped_windows(provider, model, &account.usage.windows);
    if usage_blocks_run(&account.usage, &model_windows, now) {
        return RunReadiness::UsageExhausted {
            resume_at: usage_resume_at(&account.usage, &model_windows, now),
        };
    }
    RunReadiness::Ready
}

/// 인증 상태가 실행을 막는지, 막는다면 어떤 이유인지. `Ready`면 `None`을 준다.
///
/// 거부가 확인된 것과 확인하지 못한 것을 나눈다. 마지막 실패가 토큰 갱신 제한이면
/// 공급자는 자격증명을 판정한 적이 없다 — 갱신 요청 자체가 처리되지 않았기 때문이다.
/// 이걸 재인증 필요로 다루면 실행이 막히고, 실행이 막히면 CLI가 뜨지 않아 토큰이
/// 회전하지 않으며, 그러면 조회가 계속 실패해 상태가 영영 풀리지 않는다.
fn auth_readiness(
    auth_status: AccountAuthStatus,
    usage: &AccountUsageView,
) -> Option<RunReadiness> {
    if auth_status == AccountAuthStatus::Ready {
        return None;
    }
    if usage.token_refresh_limited {
        return Some(RunReadiness::AuthUnverified {
            retry_after: usage.retry_at,
        });
    }
    Some(RunReadiness::NeedsReauthentication)
}

/// 사용량 조회 결과로 인증 상태를 맞춘다. 공급자가 자격증명 자체를 거부했으면 기다려도
/// 회복되지 않으므로 `Error`로 내린다 — 실행 게이트(`run_readiness`)는 이 값이 `Ready`인지만
/// 보므로, 그래야 예약 실행이 회차를 인증 오류로 태우는 대신 대기한다. 조회가 성공하거나
/// 확인 불가로 끝났으면 자격증명이 살아 있는 것이라 `Ready`로 올리고, 그 밖의 실패는 판정
/// 근거가 없어 현재 상태를 둔다.
fn reconciled_auth_status_after_usage(
    current: AccountAuthStatus,
    fresh_usage_status: AccountUsageStatus,
    credential_rejected: bool,
) -> AccountAuthStatus {
    if credential_rejected {
        return AccountAuthStatus::Error;
    }
    if matches!(
        fresh_usage_status,
        AccountUsageStatus::Ok | AccountUsageStatus::Unavailable
    ) {
        AccountAuthStatus::Ready
    } else {
        current
    }
}

/// 조회에 실패해도 마지막으로 성공한 수치와 그 시각을 그대로 보관한다. 화면은
/// 오류 문구 대신 이 값을 "언제 기준"인지와 함께 보여준다(`accountUsageDisplayState`).
/// 얼마나 오래됐든 지우지 않는다 — 수치가 사라지면 조회가 막힌 동안 남은 한도를
/// 전혀 알 수 없고, 낡음 여부는 함께 표시하는 기준 시각으로 판단할 수 있다.
fn apply_usage_stale_policy(
    fresh: AccountUsageView,
    previous: &AccountUsageView,
) -> AccountUsageView {
    if fresh.status != AccountUsageStatus::Error || previous.windows.is_empty() {
        return fresh;
    }
    AccountUsageView {
        windows: previous.windows.clone(),
        updated_at: previous.updated_at,
        reset_credits: previous.reset_credits.clone(),
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
            ..Default::default()
        }
    } else {
        AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows,
            updated_at: Some(now_ms()),
            ..Default::default()
        }
    }
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

    /// 모델별 주간 창은 최상위 키가 아니라 `limits[]`의 `weekly_scoped` 항목으로 온다.
    /// 최상위 `seven_day_fable` 같은 키는 서버 계약에 없다.
    #[test]
    fn claude_model_scoped_windows_come_from_the_limits_array() {
        let windows = claude_usage_windows(&json!({
            "five_hour": {"utilization": 12.0, "resets_at": "2026-08-15T12:00:00+00:00"},
            "seven_day": {"utilization": 40.0, "resets_at": "2026-08-20T12:00:00+00:00"},
            "limits": [
                {
                    "kind": "weekly_scoped",
                    "group": "model",
                    "percent": 73.5,
                    "resets_at": "2026-08-20T12:00:00+00:00",
                    "scope": {"model": {"display_name": "Fable"}}
                },
                // 모델 범위가 없는 주간 창은 어떤 모델의 창인지 알 수 없어 버린다.
                {"kind": "weekly_scoped", "percent": 50.0, "scope": {"surface": {"display_name": "Cowork"}}},
                // 다른 종류는 계정 전체 창과 중복이거나 의미가 달라 읽지 않는다.
                {"kind": "weekly", "percent": 90.0, "scope": {"model": {"display_name": "Opus"}}}
            ]
        }));
        let labels = windows
            .iter()
            .map(|window| window.label.as_str())
            .collect::<Vec<_>>();
        assert_eq!(labels, ["5시간", "7일", "Fable 7일"]);
        let fable = windows.last().unwrap();
        assert!(fable.model_scoped);
        assert_eq!(fable.used_percent, 73.5);
        assert_eq!(fable.resets_at, Some(1_787_227_200_000));
        assert!(windows[..2].iter().all(|window| !window.model_scoped));
    }

    /// 모델 이름은 서버 문자열이라 길이를 보장하지 않는다. 라벨이 예산 정책 한도를 넘으면
    /// 그 창을 가드로 지정할 수 없게 되므로 만들 때 자른다.
    #[test]
    fn long_model_names_stay_within_the_policy_label_limit() {
        let label = scoped_window_label(&"가".repeat(200), CLAUDE_WEEKLY_SCOPED_LABEL_LENGTH);
        assert!(label.chars().count() <= crate::usage_budget_policy::MAX_LABEL_CHARS);
        assert!(label.ends_with(" 7일"));
        assert_eq!(
            scoped_window_label("Fable", CLAUDE_WEEKLY_SCOPED_LABEL_LENGTH),
            "Fable 7일"
        );
    }

    /// 모델별 창이 하나도 없는 응답(그 버킷을 받지 않는 플랜)에서도 계정 전체 창은
    /// 그대로 나온다.
    #[test]
    fn claude_windows_without_model_buckets_stay_unchanged() {
        let windows = claude_usage_windows(&json!({
            "five_hour": {"utilization": 12.0},
            "seven_day": {"utilization": 40.0}
        }));
        assert_eq!(windows.len(), 2);
        assert!(windows.iter().all(|window| !window.model_scoped));
    }

    /// 모델별 창은 그 모델을 쓰지 않는 실행까지 막으면 안 되므로 소진·여유·재개 시각
    /// 판정에서 빠진다. 화면 표시용으로 목록에는 남는다.
    #[test]
    fn model_scoped_windows_do_not_decide_account_exhaustion() {
        let usage = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![
                AccountUsageWindow {
                    label: "7일".to_owned(),
                    used_percent: 20.0,
                    ..Default::default()
                },
                AccountUsageWindow {
                    label: "Fable 7일".to_owned(),
                    used_percent: 100.0,
                    resets_at: Some(9_000),
                    model_scoped: true,
                    aggregate: false,
                },
            ],
            updated_at: Some(0),
            ..AccountUsageView::default()
        };
        assert!(!usage_indicates_exhaustion(&usage));
        assert!(!usage_blocks_auto_switch(&usage, 1_000));
        assert_eq!(usage_resume_at(&usage, &[], 1_000), None);
        assert_eq!(usage_used_percent(&usage), Some(20.0));
    }

    /// 대표할 창이 모델별 창뿐이면 여유를 알 수 없다. 100%로 오해하면 소진된 계정에
    /// 계속 회차를 보낸다.
    #[test]
    fn only_model_scoped_windows_leave_the_headroom_unknown() {
        let usage = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "Fable 7일".to_owned(),
                used_percent: 100.0,
                model_scoped: true,
                ..Default::default()
            }],
            updated_at: Some(0),
            ..AccountUsageView::default()
        };
        assert_eq!(usage_used_percent(&usage), None);
        assert_eq!(usage_headroom_for_selection(&usage, &BTreeSet::new()), None);
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
        assert_eq!(
            window_duration_label(&json!({"windowDurationMins": 300})).as_deref(),
            Some("5시간")
        );
        assert_eq!(window_duration_label(&json!({"used_percent": 62})), None);
    }

    #[test]
    fn codex_official_rate_limit_snapshot_maps_to_usage_windows() {
        let envelope = json!({
            "rateLimits": {
                "primary": {
                    "usedPercent": 64,
                    "resetsAt": 1_787_315_278_i64,
                    "windowDurationMins": 300
                },
                "secondary": {
                    "usedPercent": 27,
                    "resetsAt": 1_787_747_392_i64,
                    "windowDurationMins": 10_080
                }
            }
        });
        let usage = codex_usage_result(&envelope["rateLimits"], &envelope);

        assert_eq!(usage.status, AccountUsageStatus::Ok);
        assert_eq!(usage.windows.len(), 2);
        assert_eq!(usage.windows[0].label, "5시간");
        assert_eq!(usage.windows[0].used_percent, 64.0);
        assert_eq!(usage.windows[0].resets_at, Some(1_787_315_278_000));
        assert_eq!(usage.windows[1].label, "7일");
    }

    #[test]
    fn codex_unstarted_window_drops_the_sliding_reset_time() {
        // 0% 창의 resetsAt은 "지금 + 창 길이"라 조회마다 밀린다. 소비가 있는 창만 유지한다.
        let envelope = json!({
            "rateLimits": {
                "primary": {
                    "usedPercent": 0,
                    "resetsAt": 1_787_315_278_i64,
                    "windowDurationMins": 300
                },
                "secondary": {
                    "usedPercent": 23,
                    "resetsAt": 1_787_747_392_i64,
                    "windowDurationMins": 10_080
                }
            }
        });
        let usage = codex_usage_result(&envelope["rateLimits"], &envelope);

        assert_eq!(usage.windows[0].used_percent, 0.0);
        assert_eq!(usage.windows[0].resets_at, None);
        assert_eq!(usage.windows[1].resets_at, Some(1_787_747_392_000));
    }

    #[test]
    /// 대표 한도가 `rateLimitsByLimitId`에도 그대로 들어 있다(2026-09-07 실측 모양).
    /// 같은 항목을 범위별 창으로 한 번 더 만들면 안 된다.
    fn codex_representative_limit_is_not_duplicated_from_the_limit_id_map() {
        let limits = json!({
            "limitId": "codex",
            "limitName": null,
            "primary": {"usedPercent": 23, "resetsAt": 1_788_748_925_i64, "windowDurationMins": 300},
            "secondary": {"usedPercent": 90, "resetsAt": 1_788_826_236_i64, "windowDurationMins": 10_080}
        });
        let envelope = json!({
            "rateLimits": limits,
            "rateLimitsByLimitId": {"codex": limits}
        });

        let usage = codex_usage_result(&envelope["rateLimits"], &envelope);

        let labels = usage
            .windows
            .iter()
            .map(|window| window.label.as_str())
            .collect::<Vec<_>>();
        assert_eq!(labels, ["5시간", "7일"]);
        assert!(usage.windows.iter().all(|window| !window.model_scoped));
    }

    #[test]
    /// 모델 전용 한도가 새 limitId로 붙으면 limitId를 코드에 박지 않고 따라온다.
    fn codex_model_scoped_windows_come_from_the_limit_id_map() {
        let primary = json!({
            "limitId": "codex",
            "primary": {"usedPercent": 23, "resetsAt": 1_788_748_925_i64, "windowDurationMins": 300},
            "secondary": {"usedPercent": 90, "resetsAt": 1_788_826_236_i64, "windowDurationMins": 10_080}
        });
        let envelope = json!({
            "rateLimits": primary,
            "rateLimitsByLimitId": {
                "codex": primary,
                "gpt-6": {
                    "limitId": "gpt-6",
                    "limitName": "GPT-6",
                    "secondary": {
                        "usedPercent": 41,
                        "resetsAt": 1_788_826_236_i64,
                        "windowDurationMins": 10_080
                    }
                }
            }
        });

        let usage = codex_usage_result(&envelope["rateLimits"], &envelope);

        let scoped = usage
            .windows
            .iter()
            .find(|window| window.model_scoped)
            .expect("모델 전용 창이 있어야 한다");
        assert_eq!(scoped.label, "GPT-6 7일");
        assert_eq!(scoped.used_percent, 41.0);
        // 계정 대표 창은 그대로고, 모델 창은 소진 판정에 끼어들지 않는다.
        assert_eq!(
            usage.windows[..2]
                .iter()
                .filter(|window| !window.model_scoped)
                .count(),
            2
        );
        assert!(!governing_windows(&usage.windows).any(|window| window.model_scoped));
    }

    #[test]
    /// 표시명이 없으면 limitId를 라벨로 쓴다 — 이름 없이도 창이 사라지면 안 된다.
    fn codex_scoped_window_falls_back_to_the_limit_id_for_its_label() {
        let envelope = json!({
            "rateLimits": {"limitId": "codex", "primary": {"usedPercent": 5, "windowDurationMins": 300}},
            "rateLimitsByLimitId": {
                "some-bucket": {
                    "secondary": {"usedPercent": 12, "windowDurationMins": 10_080}
                }
            }
        });

        let usage = codex_usage_result(&envelope["rateLimits"], &envelope);

        assert!(usage
            .windows
            .iter()
            .any(|window| window.model_scoped && window.label == "some-bucket 7일"));
    }

    #[test]
    /// 크레딧은 `status`가 `available`인 것만 센다. 사용 중·사용 완료를 장수에 넣으면
    /// 화면이 쓸 수 있다고 알리고 소비는 noCredit으로 물린다.
    fn codex_reset_credits_count_only_available_ones() {
        let envelope = json!({
            "rateLimits": {"primary": {"usedPercent": 90, "windowDurationMins": 300}},
            "rateLimitResetCredits": {
                "availableCount": 3,
                "credits": [
                    {"id": "a", "status": "available", "grantedAt": 1, "expiresAt": 1_789_948_788_i64,
                     "title": "Full reset (Weekly + 5 hr)"},
                    {"id": "b", "status": "redeemed", "grantedAt": 1, "expiresAt": 1_700_000_000_i64},
                    {"id": "c", "status": "available", "grantedAt": 1, "expiresAt": 1_791_079_683_i64}
                ]
            }
        });

        let usage = codex_usage_result(&envelope["rateLimits"], &envelope);

        let credits = usage.reset_credits.expect("크레딧이 있어야 한다");
        assert_eq!(credits.available_count, 2);
        // 이미 쓴 크레딧의 이른 만료를 집어오면 안 된다.
        assert_eq!(credits.next_expires_at, Some(1_789_948_788_000));
        assert_eq!(credits.title.as_deref(), Some("Full reset (Weekly + 5 hr)"));
    }

    #[test]
    /// 목록 없이 장수만 주는 응답도 받아들인다.
    fn codex_reset_credits_fall_back_to_the_reported_count() {
        let envelope = json!({
            "rateLimits": {"primary": {"usedPercent": 90, "windowDurationMins": 300}},
            "rateLimitResetCredits": {"availableCount": 2}
        });

        let credits = codex_usage_result(&envelope["rateLimits"], &envelope)
            .reset_credits
            .expect("크레딧이 있어야 한다");
        assert_eq!(credits.available_count, 2);
        assert_eq!(credits.next_expires_at, None);
    }

    #[test]
    /// 크레딧을 주지 않는 공급자·응답에서는 아무것도 만들지 않는다.
    fn codex_usage_without_reset_credits_reports_none() {
        let envelope =
            json!({"rateLimits": {"primary": {"usedPercent": 5, "windowDurationMins": 300}}});
        assert!(codex_usage_result(&envelope["rateLimits"], &envelope)
            .reset_credits
            .is_none());
    }

    #[test]
    fn reset_credit_outcome_parses_the_provider_contract() {
        assert_eq!(
            ResetCreditOutcome::parse("reset"),
            Some(ResetCreditOutcome::Reset)
        );
        assert_eq!(
            ResetCreditOutcome::parse("nothingToReset"),
            Some(ResetCreditOutcome::NothingToReset)
        );
        assert_eq!(
            ResetCreditOutcome::parse("noCredit"),
            Some(ResetCreditOutcome::NoCredit)
        );
        assert_eq!(
            ResetCreditOutcome::parse("alreadyRedeemed"),
            Some(ResetCreditOutcome::AlreadyRedeemed)
        );
        assert_eq!(ResetCreditOutcome::parse("나중에 생긴 값"), None);
    }

    #[test]
    /// 조회에 실패해 마지막 성공 수치를 보관할 때 크레딧도 같이 남는다.
    fn stale_usage_keeps_the_previously_read_reset_credits() {
        let previous = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "7일".to_owned(),
                used_percent: 90.0,
                ..Default::default()
            }],
            reset_credits: Some(AccountResetCredits {
                available_count: 2,
                next_expires_at: None,
                next_credit_id: None,
                title: None,
            }),
            ..Default::default()
        };

        let kept = apply_usage_stale_policy(usage_retry_result("조회 실패", 0), &previous);

        assert_eq!(kept.reset_credits, previous.reset_credits);
    }

    #[test]
    fn codex_official_auth_failure_requires_reauthentication() {
        let rejected = CodexRpcError {
            code: -32603,
            message: "failed to fetch rate limits: 401 Unauthorized; code=token_expired".to_owned(),
        };
        assert!(codex_rpc_rejects_credential(&rejected));
        assert!(!codex_rpc_rejects_credential(&CodexRpcError {
            code: -32603,
            message: "network unavailable".to_owned(),
        }));
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
                auto_switch_priority: None,
                auth_status: AccountAuthStatus::Ready,
                usage: AccountUsageView {
                    status: AccountUsageStatus::Ok,
                    windows: vec![AccountUsageWindow {
                        label: "5시간".to_owned(),
                        used_percent: 43.0,
                        resets_at: None,
                        ..Default::default()
                    }],
                    updated_at: Some(now_ms()),
                    ..Default::default()
                },
                note: None,
                label: None,
                credential_expires_at: None,
                created_at: now_ms(),
                updated_at: now_ms(),
            });
            let mut serialized = serde_json::to_value(&registry).unwrap();
            // 기본 계정과 활성 계정이 갈려 있던 시절의 레지스트리. 활성 계정이 비어 있으면
            // 옛 기본 계정이 그 자리를 채운다.
            serialized["providers"][0]["defaultAccountId"] = json!("codex-legacy");
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
                snapshot.providers[0].active_account_id.as_deref(),
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

    #[test]
    fn compact_json_secret_removes_physical_line_breaks() {
        let compact = compact_json_secret("{\n  \"token\": \"line\\nvalue\"\n}\n").unwrap();
        assert_eq!(&*compact, r#"{"token":"line\nvalue"}"#);
        assert!(!compact.as_bytes().contains(&b'\n'));
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
            auto_switch_priority: None,
            auth_status: AccountAuthStatus::Ready,
            usage: AccountUsageView::default(),
            note: None,
            label: None,
            credential_expires_at: None,
            created_at: now_ms(),
            updated_at: now_ms(),
        }
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

    /// 채택 판정은 요청 시도 판정을 뒤집은 값이 아니다. 만료 시각을 읽지 못하면
    /// 요청은 해 보되 정본 승격은 막아야, 유효 증거가 없는 값이 볼트를 차지하지
    /// 않는다. 경계 값은 두 판정이 같은 여유분을 쓴다.
    #[test]
    fn adoption_currentness_requires_a_readable_future_expiry() {
        let now = 1_000_000;
        assert!(claude_access_token_current_for_adoption(
            &claude_secret_with_expiry(
                Some("account-a"),
                "live",
                now + CLAUDE_TOKEN_EXPIRY_MARGIN_MS + 1
            ),
            now
        ));
        assert!(!claude_access_token_current_for_adoption(
            &claude_secret_with_expiry(
                Some("account-a"),
                "live",
                now + CLAUDE_TOKEN_EXPIRY_MARGIN_MS
            ),
            now
        ));

        for secret in [
            // 만료 시각이 없는 값.
            claude_secret("account-a"),
            // 숫자로 읽히지 않는 만료 시각.
            r#"{"claudeAiOauth":{"accessToken":"live","expiresAt":"9999999999999"}}"#.to_owned(),
            r#"{"claudeAiOauth":{"accessToken":"live","expiresAt":null}}"#.to_owned(),
            // 해석할 수 없는 값.
            "not json".to_owned(),
        ] {
            assert!(
                !claude_access_token_current_for_adoption(&secret, now),
                "유효 증거가 없는 값을 채택 가능으로 봤습니다: {secret}"
            );
            // 같은 값에 대한 요청 시도 판정은 지금까지처럼 "만료 아님"으로 남는다.
            assert!(!claude_access_token_expired(&secret, now));
        }
    }

    /// 사슬 만료는 액세스 토큰 만료와 다른 칸에서 읽는다. 둘을 섞으면 몇 시간짜리
    /// 액세스 만료를 재인증 예고로 띄워 매일 재인증을 재촉하게 된다.
    #[test]
    fn credential_chain_expiry_reads_the_refresh_token_field_for_claude_only() {
        let secret = r#"{"claudeAiOauth":{"accessToken":"live","expiresAt":111,"refreshToken":"r","refreshTokenExpiresAt":999}}"#;
        assert_eq!(
            credential_chain_expires_at(ProviderId::Claude, secret),
            Some(999)
        );
        // 만료를 밝히지 않는 공급자·형식은 값이 없다 — 추정하지 않는다.
        assert_eq!(credential_chain_expires_at(ProviderId::Codex, secret), None);
        for secret in [
            r#"{"claudeAiOauth":{"accessToken":"live","expiresAt":111}}"#,
            r#"{"claudeAiOauth":{"refreshTokenExpiresAt":"999"}}"#,
            r#"{"tokens":{"refresh_token":"r"}}"#,
            "not json",
        ] {
            assert_eq!(
                credential_chain_expires_at(ProviderId::Claude, secret),
                None,
                "만료를 밝히지 않은 값에서 시각을 지어냈습니다: {secret}"
            );
        }
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
                ..Default::default()
            }],
            updated_at: Some(updated_at),
            ..Default::default()
        };
        let retry_at = now + CLAUDE_RATE_LIMIT_DEFAULT_RETRY_MS;

        let result =
            apply_usage_stale_policy(rate_limited_usage_result("HTTP 429", retry_at), &previous);

        assert_eq!(result.status, AccountUsageStatus::Error);
        assert_eq!(result.windows, previous.windows);
        assert_eq!(result.updated_at, Some(updated_at));
        assert_eq!(result.retry_at, Some(retry_at));
        assert!(result.rate_limited);
    }

    #[test]
    fn token_refresh_limit_blocks_only_its_own_retry_window() {
        let now = 2_000_000_000;
        let limited = token_refresh_limited_usage_result("HTTP 429", now + 60_000, 1);

        assert_eq!(
            token_refresh_retry_pending(&limited, now),
            Some(now + 60_000)
        );
        assert_eq!(token_refresh_retry_pending(&limited, now + 60_000), None);
        // 사용량 조회 429는 갱신 엔드포인트 제한이 아니므로 갱신 요청을 막지 않는다.
        assert_eq!(
            token_refresh_retry_pending(&rate_limited_usage_result("HTTP 429", now + 60_000), now),
            None
        );
        assert_eq!(
            token_refresh_retry_pending(&usage_retry_result("조회 실패", now + 60_000), now),
            None
        );
    }

    #[test]
    fn a_new_credential_clears_the_previous_failure_and_keeps_the_last_usage() {
        let now = 2_000_000_000;
        let windows = vec![AccountUsageWindow {
            label: "7일".to_owned(),
            used_percent: 16.0,
            resets_at: Some(now + 60_000),
            ..Default::default()
        }];
        let failed = AccountUsageView {
            windows: windows.clone(),
            updated_at: Some(now - 60_000),
            ..token_refresh_limited_usage_result("HTTP 429", now + 60_000, 1)
        };

        let cleared = usage_error_cleared(&failed);

        assert_eq!(cleared.status, AccountUsageStatus::Ok);
        assert_eq!(cleared.windows, windows);
        assert_eq!(cleared.updated_at, Some(now - 60_000));
        assert_eq!(cleared.error, None);
        assert_eq!(cleared.retry_at, None);
        assert!(!cleared.rate_limited);
        assert!(!cleared.token_refresh_limited);
        // 보관할 수치가 없으면 조회 전 상태로 되돌린다.
        assert_eq!(
            usage_error_cleared(&token_refresh_limited_usage_result("HTTP 429", now, 1)).status,
            AccountUsageStatus::Idle
        );
    }

    #[test]
    fn successful_usage_reconciles_stale_auth_status_without_trusting_failures() {
        assert_eq!(
            reconciled_auth_status_after_usage(
                AccountAuthStatus::Error,
                AccountUsageStatus::Ok,
                false,
            ),
            AccountAuthStatus::Ready
        );
        assert_eq!(
            reconciled_auth_status_after_usage(
                AccountAuthStatus::Missing,
                AccountUsageStatus::Unavailable,
                false,
            ),
            AccountAuthStatus::Ready
        );
        assert_eq!(
            reconciled_auth_status_after_usage(
                AccountAuthStatus::Error,
                AccountUsageStatus::Error,
                false,
            ),
            AccountAuthStatus::Error
        );
    }

    /// 갈라진 프로필 사슬의 승격 자격. 발급 시점 비교가 가능하면 그 결과만 믿는다 —
    /// 옛 사슬의 액세스 토큰은 서버에서 무효화됐어도 로컬에선 살아 보이므로, 로컬
    /// 판정을 무조건 허용하면 더 새 볼트 사슬이 폐기본으로 덮인다(2026-08-27 실측).
    #[test]
    fn an_older_profile_chain_never_outranks_a_newer_vault_chain() {
        // 비교 가능 + 프로필이 옛 사슬: 로컬에서 살아 보여도 승격 불가.
        assert!(!profile_chain_current(false, true, true));
        // 비교 가능 + 프로필이 새 사슬: 승격.
        assert!(profile_chain_current(true, true, false));
        // 비교 불가일 때만 로컬 판정을 허용한다.
        assert!(profile_chain_current(false, false, true));
        assert!(!profile_chain_current(false, false, false));

        // Codex 사슬은 last_refresh로 비교 가능하다 — 그날의 실제 값 모양.
        let old = r#"{"tokens":{"access_token":"a","refresh_token":"r1","account_id":"w"},"last_refresh":"2026-08-20T07:50:31.531416Z"}"#;
        let new = r#"{"tokens":{"access_token":"b","refresh_token":"r2","account_id":"w"},"last_refresh":"2026-08-26T07:58:28.153558Z"}"#;
        assert!(credential_chains_comparable(ProviderId::Codex, old, new));
        assert!(credential_chain_is_newer(ProviderId::Codex, new, old));
        assert!(!credential_chain_is_newer(ProviderId::Codex, old, new));
        // last_refresh가 없으면 비교 불가로 떨어져 기존 로컬 판정 경로가 남는다.
        let legacy = r#"{"tokens":{"access_token":"c","refresh_token":"r3"}}"#;
        assert!(!credential_chains_comparable(
            ProviderId::Codex,
            legacy,
            new
        ));
    }

    /// Codex 401은 코드로 회복 가능 여부가 갈린다. `token_expired`는 CLI를 띄우면
    /// 풀리는 낡은 사본이고, 무효화 계열은 재로그인만이 답이다. 뭉치면 죽은 계정에
    /// "CLI를 실행하면 갱신됩니다"라는 거짓 안내가 영원히 남는다.
    #[test]
    fn a_codex_401_is_rejected_only_when_the_body_says_invalidated() {
        assert!(codex_usage_401_rejection(
            r#"{"error":{"message":"…","type":"invalid_request_error","code":"token_invalidated","param":null},"status":401}"#
        )
        .is_some());
        assert!(
            codex_usage_401_rejection(r#"{"error":{"code":"refresh_token_already_used"}}"#)
                .is_some()
        );
        // 만료는 낙관 경로 그대로 — 그 계정으로 CLI를 띄우면 회복된다.
        assert!(codex_usage_401_rejection(
            r#"{"error":{"message":"…","code":"token_expired","param":null},"status":401}"#
        )
        .is_none());
        // 코드를 읽지 못하면 낙관 쪽으로 둔다. 오판의 손해가 문구 부정확에 그친다.
        assert!(codex_usage_401_rejection("").is_none());
        assert!(codex_usage_401_rejection("not json").is_none());
        assert!(codex_usage_401_rejection(r#"{"error":"plain"}"#).is_none());
    }

    /// 계정 격리용 환경변수가 백엔드 자신에게 상속되면 자기 프로필이 공유 홈이 된다.
    /// 자기 프로필 루트 안을 가리키는 값만 버리고, 그 밖의 커스텀 경로는 존중한다.
    #[test]
    fn inherited_isolation_paths_pointing_at_our_own_profiles_are_dropped() {
        let root = Path::new("/data/credential-profiles");
        let var = "AM_TEST_ENV_PATH_SELF_REFERENTIAL";
        let judge = |value: &str| {
            super::path_unless_self_referential(var, std::ffi::OsString::from(value), root)
        };
        assert_eq!(judge("/data/credential-profiles/claude/claude-1234"), None);
        assert_eq!(
            judge("/Users/someone/.codex-custom"),
            Some(PathBuf::from("/Users/someone/.codex-custom"))
        );
        // 접두 문자열이 아니라 경로 구성요소로 비교한다.
        assert_eq!(
            judge("/data/credential-profiles-backup/x"),
            Some(PathBuf::from("/data/credential-profiles-backup/x"))
        );
    }

    /// 토큰 엔드포인트에 `User-Agent`가 붙으면 갱신이 429로 막힌다(2026-08-27 실측:
    /// `claude-code/<semver>`와 `curl/<ver>`은 429, 헤더가 없으면 400 invalid_grant).
    /// HTTP 클라이언트가 기본 UA를 붙이기 시작하거나 누가 헤더를 되살리면 그때부터
    /// 만료된 액세스 토큰을 되살릴 수 없게 되므로, 나가는 요청으로 직접 확인한다.
    #[test]
    fn the_token_refresh_request_carries_no_user_agent() {
        let request = Client::builder()
            .timeout(USAGE_TIMEOUT)
            .build()
            .unwrap()
            .post(CLAUDE_OAUTH_TOKEN_URL)
            .json(&serde_json::json!({"grant_type": "refresh_token"}))
            .build()
            .unwrap();
        assert!(request.headers().get(USER_AGENT).is_none());
        assert_eq!(
            request.headers().get(CONTENT_TYPE).unwrap(),
            "application/json"
        );
    }

    /// 토큰 엔드포인트는 `User-Agent`로 요청을 거른다(2026-08-27 실측). 그래서 앱은
    /// UA를 붙이지 않고 CLI와 같은 json 본문으로 보낸다. 여기서는 본문에 실리는
    /// `scope`가 저장된 자격증명에서 그대로 오는지만 본다.
    #[test]
    fn refresh_scope_comes_from_the_stored_credential() {
        let secret = serde_json::json!({
            "claudeAiOauth": {
                "refreshToken": "r",
                "scopes": ["user:inference", "user:profile"],
            }
        });
        assert_eq!(
            ClaudeOauthEnvelope(secret).scope().as_deref(),
            Some("user:inference user:profile")
        );
        // 스코프가 없으면 파라미터를 아예 빼야 한다. 빈 문자열을 보내면 스코프를
        // 지우라는 요청으로 읽힐 수 있다.
        assert_eq!(
            ClaudeOauthEnvelope(serde_json::json!({"claudeAiOauth": {"scopes": []}})).scope(),
            None
        );
        assert_eq!(
            ClaudeOauthEnvelope(serde_json::json!({"claudeAiOauth": {}})).scope(),
            None
        );
    }

    /// 같은 간격으로 계속 재제출하면 제한이 풀릴 근거가 생기지 않는다. 2026-08-27
    /// 사건에서 13시간을 15분 간격으로 약 52회 보냈고, 이 수열이면 8회다.
    #[test]
    fn repeated_refresh_throttles_widen_the_retry_gap() {
        let minutes = |ms: i64| ms / 60_000;
        assert_eq!(minutes(claude_refresh_backoff_ms(0)), 15);
        assert_eq!(minutes(claude_refresh_backoff_ms(1)), 30);
        assert_eq!(minutes(claude_refresh_backoff_ms(2)), 60);
        assert_eq!(minutes(claude_refresh_backoff_ms(3)), 120);
        assert_eq!(minutes(claude_refresh_backoff_ms(4)), 240);
        // 상한을 넘지 않고, 아무리 오래 막혀도 6시간에서 멈춘다.
        assert_eq!(minutes(claude_refresh_backoff_ms(5)), 360);
        assert_eq!(minutes(claude_refresh_backoff_ms(50)), 360);
    }

    /// 서버가 제한 창을 알려 줬을 때만 그 값을 쓴다. 알려 주지 않았는데 기본값을
    /// "서버가 말한 값"으로 착각하면 백오프 수열이 영영 적용되지 않는다.
    #[test]
    fn only_a_retry_after_header_counts_as_a_server_hint() {
        let now = 1_000_000;
        let mut headers = HeaderMap::new();
        assert_eq!(retry_at_hint_from_headers(&headers, now), None);
        headers.insert(RETRY_AFTER, HeaderValue::from_static("60"));
        assert_eq!(
            retry_at_hint_from_headers(&headers, now),
            Some(now + 60_000)
        );
    }

    /// 갱신이 제한된 계정을 재인증 필요로 다루면 교착에 빠진다. 실행을 막으면 CLI가
    /// 뜨지 않아 토큰이 회전하지 않고, 회전하지 않으면 조회가 계속 실패해 상태가
    /// 풀리지 않는다. 그래서 이 경우는 재인증이 아니라 "확인하지 못함"이다.
    #[test]
    fn a_throttled_refresh_is_unverified_not_rejected() {
        let throttled = AccountUsageView {
            token_refresh_limited: true,
            retry_at: Some(4_242),
            ..AccountUsageView::default()
        };
        assert_eq!(
            auth_readiness(AccountAuthStatus::Error, &throttled),
            Some(RunReadiness::AuthUnverified {
                retry_after: Some(4_242)
            })
        );
        // 갱신 제한이 아닌 실패는 그대로 재인증이다.
        assert_eq!(
            auth_readiness(AccountAuthStatus::Error, &AccountUsageView::default()),
            Some(RunReadiness::NeedsReauthentication)
        );
        assert_eq!(
            auth_readiness(AccountAuthStatus::Missing, &throttled),
            Some(RunReadiness::AuthUnverified {
                retry_after: Some(4_242)
            })
        );
        // 정상 계정은 이 갈래에서 아무것도 막지 않는다.
        assert_eq!(auth_readiness(AccountAuthStatus::Ready, &throttled), None);
    }

    /// 갱신 엔드포인트는 실제 제한에도 제한 헤더를 붙이지 않고 `rate_limit_error`
    /// 본문만 준다. 본문을 보지 않으면 멀쩡한 토큰이 죽은 토큰으로 분류돼 계정이
    /// 재인증 필요로 굳고, `run_readiness`가 실행까지 막는다.
    #[test]
    fn a_429_that_says_rate_limit_error_is_a_throttle_even_without_limit_headers() {
        let rate_limited = r#"{"error":{"type":"rate_limit_error","message":"Rate limited. Please try again later."}}"#;
        assert!(claude_refresh_429_is_throttle(None, "없음", rate_limited));
        // 회전돼 죽은 리프레시 토큰은 OAuth 표준 오류로 답한다. 제한 헤더가 붙어
        // 있어도 기다려서 회복되지 않으므로 재인증으로 올린다.
        assert!(!claude_refresh_429_is_throttle(
            Some("30"),
            "anthropic-ratelimit-unified-reset=1787563156",
            r#"{"error":"invalid_grant","error_description":"Refresh token not found"}"#
        ));
    }

    /// 본문이 종류를 밝히지 않으면 헤더로 판정하던 기존 규칙이 그대로 남는다.
    #[test]
    fn a_429_with_no_error_kind_in_the_body_still_falls_back_to_the_headers() {
        assert!(claude_refresh_429_is_throttle(Some("30"), "없음", ""));
        assert!(claude_refresh_429_is_throttle(
            None,
            "anthropic-ratelimit-unified-reset=1787563156",
            "not json"
        ));
        assert!(!claude_refresh_429_is_throttle(None, "없음", ""));
        assert!(!claude_refresh_429_is_throttle(
            None,
            "없음",
            r#"{"detail":"nope"}"#
        ));
    }

    /// 갱신 엔드포인트가 자격증명을 거부하면 기다려도 회복되지 않는다. 이 값이 `Ready`로
    /// 남으면 예약 실행이 매 회차를 인증 오류로 태우므로 재인증이 필요한 상태로 내린다.
    #[test]
    fn rejected_credentials_drop_the_account_out_of_ready() {
        assert_eq!(
            reconciled_auth_status_after_usage(
                AccountAuthStatus::Ready,
                AccountUsageStatus::Error,
                true,
            ),
            AccountAuthStatus::Error
        );
        // 공유 홈 자격증명 검증이 성공했더라도 거부 신호가 먼저다.
        assert_eq!(
            reconciled_auth_status_after_usage(
                AccountAuthStatus::Ready,
                AccountUsageStatus::Error,
                true,
            ),
            AccountAuthStatus::Error
        );
    }

    #[test]
    fn old_usage_survives_a_failed_refresh_with_its_original_timestamp() {
        let now = 2_000_000_000;
        let updated_at = now - 7 * RATE_LIMITED_STALE_THRESHOLD_MS;
        let previous = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "7일".to_owned(),
                used_percent: 73.0,
                resets_at: None,
                ..Default::default()
            }],
            updated_at: Some(updated_at),
            ..Default::default()
        };

        // 아무리 오래된 값이어도 지우지 않는다. 화면은 이 수치를 마지막 성공
        // 조회 시각과 함께 보여주므로 낡음이 현재 값으로 오인되지 않는다.
        let rate_limited = apply_usage_stale_policy(
            rate_limited_usage_result("HTTP 429", now + 60_000),
            &previous,
        );
        assert_eq!(rate_limited.windows, previous.windows);
        assert_eq!(rate_limited.updated_at, Some(updated_at));

        let network_error = apply_usage_stale_policy(
            usage_error_result(CoreError::Runtime("error sending request".to_owned())),
            &previous,
        );
        assert_eq!(network_error.windows, previous.windows);
        assert_eq!(network_error.updated_at, Some(updated_at));
        assert_eq!(network_error.status, AccountUsageStatus::Error);
        assert!(network_error.error.is_some());

        // 성공 응답은 그대로 최신 값이 된다.
        let fresh = usage_result(vec![AccountUsageWindow {
            label: "7일".to_owned(),
            used_percent: 12.0,
            resets_at: None,
            ..Default::default()
        }]);
        let applied = apply_usage_stale_policy(fresh.clone(), &previous);
        assert_eq!(applied.windows, fresh.windows);
        assert_eq!(applied.status, AccountUsageStatus::Ok);
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
        assert!(!usage.token_refresh_limited);
    }

    #[test]
    fn token_refresh_rate_limit_does_not_disqualify_an_account_from_failover() {
        let now = 1_000_000;
        let token_refresh = AccountUsageView {
            rate_limited: true,
            token_refresh_limited: true,
            retry_at: Some(now + 15 * 60_000),
            ..AccountUsageView::default()
        };
        // 토큰 갱신 엔드포인트의 429는 남은 사용량을 말해 주지 않으므로 페일오버
        // 후보에서 빼지 않는다.
        assert!(!usage_blocks_auto_switch(&token_refresh, now));
        let usage_limit = AccountUsageView {
            token_refresh_limited: false,
            token_refresh_throttle_streak: 0,
            reset_credits: None,
            ..token_refresh
        };
        // 사용량 조회 자체가 제한된 경우는 그대로 한도로 취급한다.
        assert!(usage_blocks_auto_switch(&usage_limit, now));
    }

    const HOUR_MS: i64 = 60 * 60_000;

    /// 모델군마다 쿼터가 따로인 공급자의 사용량. 계정 대표 창은 빡빡한 쪽의 복사본이다
    /// (`antigravity_usage::combined_usage`와 같은 모양).
    fn model_group_usage(gemini: f64, third_party: f64, resets_at: i64) -> AccountUsageView {
        let window = |label: &str, used: f64, scoped: bool, aggregate: bool| AccountUsageWindow {
            label: label.to_owned(),
            used_percent: used,
            resets_at: (used > 0.0).then_some(resets_at),
            model_scoped: scoped,
            aggregate,
        };
        AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![
                window("7일", gemini.max(third_party), false, true),
                window("Gemini Models · 7일", gemini, true, false),
                window("Claude and GPT models · 7일", third_party, true, false),
            ],
            updated_at: Some(0),
            ..Default::default()
        }
    }

    /// 한 모델군이 다 찼다고 계정을 통째로 빼면 다른 모델군의 쿼터를 버리게 된다. 계정
    /// 대표 창은 빡빡한 모델군의 복사본이라, 그 창을 소진 판정에 세면 `model_scoped`를
    /// 빼 둔 방어가 대표 창을 통해 되살아난다.
    #[test]
    fn one_exhausted_model_group_does_not_exhaust_the_account() {
        let now = 1_000_000;
        let resets_at = now + HOUR_MS;
        let gemini_gone = model_group_usage(100.0, 0.0, resets_at);
        assert!(!usage_blocks_auto_switch(&gemini_gone, now));
        // 다만 자동전환을 **고려할** 값어치는 있다. 그 모델군 실행은 이 계정에서 더 돌지
        // 못하고, 게이트가 모델군을 알아본 뒤로는 한도 오류조차 나지 않아 이 신호가
        // 아니면 활성 계정이 리셋까지 그대로 앉아 있는다.
        assert!(usage_indicates_exhaustion(&gemini_gone));

        // 모든 모델군이 차야 계정이 막힌 것이다.
        let both_gone = model_group_usage(100.0, 100.0, resets_at);
        assert!(usage_blocks_auto_switch(&both_gone, now));
        assert!(usage_indicates_exhaustion(&both_gone));

        // 창을 하나도 읽지 못한 계정은 소진이 아니다 — 모르는 것과 다 쓴 것은 다르다.
        assert!(!usage_blocks_auto_switch(&AccountUsageView::default(), now));

        // 자기 대표 창을 가진 공급자는 종전 그대로 그 창 하나로 판정한다.
        let plain = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "7일".to_owned(),
                used_percent: 100.0,
                resets_at: Some(resets_at),
                ..Default::default()
            }],
            updated_at: Some(0),
            ..Default::default()
        };
        assert!(usage_blocks_auto_switch(&plain, now));

        // 대표 한도 없이 모델 한정 창만 오는 응답(Claude `limits[]`)은 모델군 규칙으로
        // 넘어가지 않는다. 넘어가면 모델 하나의 소진이 계정 전체를 막아, `model_scoped`가
        // 막으려던 구멍이 그대로 다시 열린다.
        let model_only = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "Fable 7일".to_owned(),
                used_percent: 100.0,
                resets_at: Some(resets_at),
                model_scoped: true,
                aggregate: false,
            }],
            updated_at: Some(0),
            ..Default::default()
        };
        assert!(!usage_blocks_auto_switch(&model_only, now));
        assert!(!usage_indicates_exhaustion(&model_only));
    }

    /// 계정이 다시 열리는 시각은 **가장 먼저 풀리는 모델군**이다. 그룹 안에서는 찬 창이
    /// 모두 풀려야 하므로 늦은 쪽을 본다. 뭉뚱그려 가장 이른 시각을 말하면 아직 거부되는
    /// 시각을, 가장 늦은 시각을 말하면 이미 받아들여질 회차를 더 기다리라고 안내한다.
    #[test]
    fn an_exhausted_account_reopens_when_its_first_model_group_clears() {
        let now = 1_000_000;
        let gemini_five_hour = now + HOUR_MS;
        let gemini_weekly = now + 100 * HOUR_MS;
        let third_party_weekly = now + 50 * HOUR_MS;
        let window =
            |label: &str, resets_at: i64, scoped: bool, aggregate: bool| AccountUsageWindow {
                label: label.to_owned(),
                used_percent: 100.0,
                resets_at: Some(resets_at),
                model_scoped: scoped,
                aggregate,
            };
        let usage = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![
                window("5시간", gemini_five_hour, false, true),
                window("7일", gemini_weekly, false, true),
                window("Gemini Models · 5시간", gemini_five_hour, true, false),
                window("Gemini Models · 7일", gemini_weekly, true, false),
                window(
                    "Claude and GPT models · 7일",
                    third_party_weekly,
                    true,
                    false,
                ),
            ],
            updated_at: Some(0),
            ..Default::default()
        };
        assert!(usage_blocks_run(&usage, &[], now));
        // Gemini는 100시간 뒤에야 다 풀리고 Claude/GPT는 50시간 뒤다 — 계정은 그때 열린다.
        assert_eq!(
            usage_resume_at(&usage, &[], now),
            Some(third_party_weekly),
            "먼저 풀리는 모델군이 계정을 연다"
        );
        // 모델을 밝힌 실행은 그 모델군만 기다린다.
        let gemini = model_scoped_windows(
            ProviderId::Antigravity,
            Some("gemini-3.8-flash-high"),
            &usage.windows,
        );
        assert_eq!(usage_resume_at(&usage, &gemini, now), Some(gemini_weekly));
    }

    /// 이번 실행의 모델을 알면 그 모델군 창만 본다. 재개 시각도 그 창의 리셋이어야 한다 —
    /// 다른 모델군이 더 늦게 풀린다고 이 실행까지 그때까지 기다릴 이유가 없다.
    #[test]
    fn a_declared_model_is_gated_by_its_own_group_window() {
        let now = 1_000_000;
        let gemini_reset = now + HOUR_MS;
        let mut usage = model_group_usage(100.0, 0.0, gemini_reset);
        let third_party_reset = now + 50 * HOUR_MS;
        usage.windows.push(AccountUsageWindow {
            label: "Claude and GPT models · 5시간".to_owned(),
            used_percent: 100.0,
            resets_at: Some(third_party_reset),
            model_scoped: true,
            aggregate: false,
        });

        let windows_for =
            |model| model_scoped_windows(ProviderId::Antigravity, model, &usage.windows);
        let claude = windows_for(Some("claude-opus-4-6-thinking"));
        assert!(usage_blocks_run(&usage, &claude, now));
        assert_eq!(
            usage_resume_at(&usage, &claude, now),
            Some(third_party_reset)
        );

        let gemini = windows_for(Some("gemini-3.8-flash-high"));
        assert!(usage_blocks_run(&usage, &gemini, now));
        assert_eq!(usage_resume_at(&usage, &gemini, now), Some(gemini_reset));

        // 판정을 가르는 자리: Gemini만 소진된 계정이다. 계정은 쓸 수 있지만(Claude/GPT가
        // 비어 있다) Gemini 모델로는 띄울 수 없다 — 계정 전체 판정만으로는 CLI를 띄워
        // 놓고 곧바로 한도 오류를 받는다.
        let one_group_gone = model_group_usage(100.0, 0.0, gemini_reset);
        let of =
            |model| model_scoped_windows(ProviderId::Antigravity, model, &one_group_gone.windows);
        assert!(!usage_blocks_run(&one_group_gone, &[], now));
        assert!(!usage_blocks_run(
            &one_group_gone,
            &of(Some("claude-opus-4-6-thinking")),
            now
        ));
        assert!(usage_blocks_run(
            &one_group_gone,
            &of(Some("gemini-3.8-flash-high")),
            now
        ));

        // 모델군을 가릴 수 없는 이름은 계정 전체 판정으로 둔다. 모델을 적었다고 밝히지
        // 않은 실행보다 더 막히면 뒤집힌 결과다.
        assert!(
            model_scoped_windows(ProviderId::Antigravity, Some("auto"), &usage.windows).is_empty()
        );

        // 모델군이 없는 공급자와 모델을 밝히지 않은 실행은 계정 전체 판정 그대로다.
        assert!(
            model_scoped_windows(ProviderId::Claude, Some("claude-opus-5"), &usage.windows)
                .is_empty()
        );
        assert!(model_scoped_windows(ProviderId::Antigravity, None, &usage.windows).is_empty());
    }

    #[test]
    fn bulk_usage_refresh_skips_accounts_whose_retry_window_has_not_arrived() {
        let now = 1_000_000;
        let waiting = AccountUsageView {
            rate_limited: true,
            retry_at: Some(now + 1),
            ..AccountUsageView::default()
        };
        assert!(usage_refresh_deferred(&waiting, now));
        // 대기 시각이 지나면 다시 대상이 된다. 대기 중에도 계속 두드리면 429가 그
        // 시각을 또 미뤄 예정된 재시도 시점에 영구히 도달하지 못한다.
        assert!(!usage_refresh_deferred(&waiting, now + 1));
        assert!(!usage_refresh_deferred(&AccountUsageView::default(), now));
    }

    #[test]
    fn refresh_usage_if_due_respects_retry_at_and_debounce() {
        let (_data, _home, supervisor, a, _b) = two_account_supervisor();
        let set_usage = |usage: AccountUsageView| {
            let mut state = supervisor.inner.state.lock().unwrap();
            account_by_id_mut(&mut state.registry, &a).unwrap().usage = usage;
        };
        // 공급자가 재시도를 미뤄 둔 계정은 신호가 와도 두드리지 않는다.
        set_usage(AccountUsageView {
            rate_limited: true,
            retry_at: Some(now_ms() + 15 * 60_000),
            ..AccountUsageView::default()
        });
        assert!(supervisor
            .refresh_usage_if_due(&a, 60_000)
            .unwrap()
            .is_none());
        // 직전 갱신이 최소 간격 안이면 건너뛴다 — 한 회차에 런타임이 잇달아 끝나도 한 번.
        set_usage(AccountUsageView {
            updated_at: Some(now_ms() - 10_000),
            ..AccountUsageView::default()
        });
        assert!(supervisor
            .refresh_usage_if_due(&a, 60_000)
            .unwrap()
            .is_none());
        // 간격이 지났으면 실제로 갱신한다(조회 실패도 갱신 결과로 기록된다).
        set_usage(AccountUsageView {
            updated_at: Some(now_ms() - 120_000),
            ..AccountUsageView::default()
        });
        assert!(supervisor
            .refresh_usage_if_due(&a, 60_000)
            .unwrap()
            .is_some());
    }

    #[test]
    fn agent_usage_limit_is_recorded_even_while_a_token_refresh_backoff_is_pending() {
        let (_data, _home, supervisor, a, _b) = two_account_supervisor();
        {
            let mut state = supervisor.inner.state.lock().unwrap();
            let account = account_by_id_mut(&mut state.registry, &a).unwrap();
            account.usage = AccountUsageView {
                rate_limited: true,
                token_refresh_limited: true,
                retry_at: Some(now_ms() + 15 * 60_000),
                ..AccountUsageView::default()
            };
        }
        supervisor.report_agent_usage_limit(&a, None, None).unwrap();
        let state = supervisor.inner.state.lock().unwrap();
        let usage = &account_by_id(&state.registry, &a).unwrap().usage;
        assert!(usage.rate_limited);
        // 실제 한도 보고가 토큰 갱신 대기에 묻히지 않고 기록된다.
        assert!(!usage.token_refresh_limited);
        assert_eq!(
            usage.error.as_deref(),
            Some("에이전트 세션이 사용량 제한 응답을 받았습니다")
        );
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
        two_account_supervisor_with_probe(Arc::new(unavailable_credential_probe))
    }

    /// [`two_account_supervisor`]와 같은 구성에 프로필 격리 프로브를 끼운다.
    /// 격리가 되는 경우와 안 되는 경우를 같은 계정 구성에서 나란히 확인한다.
    fn two_account_supervisor_with_probe(
        credential_probe: Arc<CredentialProbe>,
    ) -> (
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
        let supervisor = AccountSupervisor::open_with_credential_probe(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
            credential_probe,
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
        // 공유 홈은 마지막 로그인(B)을 담고 있다. 기본 계정 변경은 여기에 쓰지 않으므로,
        // "앱이 공유 홈을 건드리지 않는다"를 보는 테스트가 기준값을 갖도록 외부 로그인이
        // A로 돌아온 상태를 만든다.
        fs::write(codex_home.join("auth.json"), codex_secret("account-a")).unwrap();
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
            )
            .unwrap();
        supervisor
            .upsert_captured_account(
                ProviderId::Claude,
                None,
                Some("B".to_owned()),
                captured_claude("account-b"),
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

    /// 이 계정으로 런타임이 돌면 CLI가 회전 주인이라 앱은 갱신을 미루고, 런타임이 끝나면
    /// 다시 앱이 회전한다. 다른 계정의 런타임은 영향이 없다.
    #[test]
    fn a_claude_refresh_is_deferred_only_while_the_same_account_runtime_is_alive() {
        let (_data, _home, _vault, supervisor, a, b) = two_claude_account_supervisor();
        let lease = supervisor
            .acquire_runtime(ProviderId::Claude, Some(&a))
            .unwrap();

        assert_eq!(supervisor.account_runtime_count(&a).unwrap(), 1);
        assert_eq!(supervisor.account_runtime_count(&b).unwrap(), 0);
        assert!(supervisor.claude_refresh_deferred(&a).unwrap().is_some());
        assert!(supervisor.claude_refresh_deferred(&b).unwrap().is_none());

        drop(lease);
        assert_eq!(supervisor.account_runtime_count(&a).unwrap(), 0);
        assert!(supervisor.claude_refresh_deferred(&a).unwrap().is_none());
    }

    /// 미루기 규칙은 "지금 그 계정으로 도는 런타임이 있는가" 하나다. 없으면 회전시켜 줄
    /// CLI가 애초에 없으니 앱이 한다. 외부 Claude 프로세스는 보지 않는다 — 공유 CLI 홈의
    /// 사슬은 이 계정의 프로필 사슬과 다르다.
    #[test]
    fn an_idle_isolated_account_is_not_deferred_to_a_cli_that_never_runs() {
        assert_eq!(claude_refresh_deferral(false), None);
        assert!(claude_refresh_deferral(true).is_some());
    }

    /// 백엔드를 다시 띄운 직후처럼 프로필 캐시가 비어 있어도 격리 판정이 흔들리면
    /// 안 된다. 캐시만 보는 자리와 디스크까지 보는 자리가 갈리면, 그 창에서 앱은
    /// CLI가 회전시킨 토큰을 볼트로 끌어오지도 않고 스스로 갱신하지도 않는다.
    #[test]
    fn a_restarted_backend_sees_the_profile_on_disk_and_still_refreshes_an_idle_account() {
        let (data, _home, _vault, supervisor, account_id) = canonical_claude_supervisor();
        let account = {
            let state = supervisor.inner.state.lock().unwrap();
            account_by_id(&state.registry, &account_id).unwrap().clone()
        };
        let dir =
            credential_profiles::ensure_profile_dir(data.path(), ProviderId::Claude, &account_id)
                .unwrap();
        // 프로필에 자격증명을 채워 "이 계정은 격리 저장소를 쓴다"를 디스크에 남긴다.
        supervisor.sync_profile_credential(&account, &dir).unwrap();

        // 이 프로세스에서 이 계정으로 런타임을 띄운 적이 없어 캐시는 비어 있다.
        assert!(!supervisor.credential_profile_active(&account_id));
        // 그래도 디스크로는 격리가 보여야 한다.
        assert!(supervisor.credential_profile_isolated(ProviderId::Claude, &account_id));

        // 그리고 그 판정이 갱신을 막아서는 안 된다. 도는 런타임이 없으니 앱이 회전시킨다.
        assert_eq!(supervisor.account_runtime_count(&account_id).unwrap(), 0);
        assert!(supervisor
            .claude_refresh_deferred(&account_id)
            .unwrap()
            .is_none());
    }

    /// 프로브가 실패해 공유 홈으로 실행되는 계정은 프로필 디렉터리가 남아 있어도
    /// 격리가 아니다. 재시도 시한이 지나면 캐시는 없는 것으로 보고 디스크로 돌아간다.
    /// 화면의 `credentialIsolated`는 내부 판정과 같은 값이어야 한다 — 둘이 갈리면
    /// 운영자가 화면을 보고 내린 판단이 앱의 실제 동작과 어긋난다.
    #[test]
    fn a_failed_isolation_probe_overrides_the_profile_dir_until_its_retry_passes() {
        let (data, _home, _vault, supervisor, account_id) = canonical_claude_supervisor();
        let isolated_view = |supervisor: &AccountSupervisor| {
            supervisor
                .snapshot()
                .unwrap()
                .accounts
                .into_iter()
                .find(|account| account.id == account_id)
                .unwrap()
                .credential_isolated
        };
        assert!(!supervisor.credential_profile_isolated(ProviderId::Claude, &account_id));
        assert!(!isolated_view(&supervisor));

        credential_profiles::ensure_profile_dir(data.path(), ProviderId::Claude, &account_id)
            .unwrap();
        assert!(!supervisor.credential_profile_active(&account_id));
        assert!(supervisor.credential_profile_isolated(ProviderId::Claude, &account_id));
        assert!(isolated_view(&supervisor));

        supervisor.inner.credential_profiles.lock().unwrap().insert(
            account_id.clone(),
            CredentialProfileEntry::Unsupported {
                reason: "프로브 실패".to_owned(),
                retry_at: now_ms().saturating_add(CREDENTIAL_PROFILE_RETRY_MS),
            },
        );
        assert!(!supervisor.credential_profile_isolated(ProviderId::Claude, &account_id));
        assert!(!isolated_view(&supervisor));

        supervisor.inner.credential_profiles.lock().unwrap().insert(
            account_id.clone(),
            CredentialProfileEntry::Unsupported {
                reason: "프로브 실패".to_owned(),
                retry_at: now_ms() - 1,
            },
        );
        assert!(supervisor.credential_profile_isolated(ProviderId::Claude, &account_id));
        assert!(isolated_view(&supervisor));
    }

    /// 격리 프로필로 실행되는 활성 Claude 계정과, 다른 로그인의 옛 세대가 남은 공유
    /// 홈(2026-08-30 관측 상태). 공유 홈 값은 계정 ID가 없고 만료돼 있어 주인을
    /// 알려면 그 토큰으로 신원을 조회해야 하고, 조회하면 401이 난다. 볼트 토큰도
    /// 만료시켜 조회가 갱신 경로로 가게 하되, 런타임 수를 하나 잡아 앱이 회전을 미루게
    /// 한다 — 그래야 네트워크 없이 결정적으로 끝난다. 프로필 캐시는 비워 두어 백엔드
    /// 재시작 직후 상태를 재현한다.
    fn isolated_active_claude_with_stale_shared_home() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<MemoryVault>,
        AccountSupervisor,
        String,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let data_dir = fs::canonicalize(data.path()).unwrap();
        let home_dir = fs::canonicalize(home.path()).unwrap();
        let claude_home = home_dir.join(".claude");
        fs::create_dir(&claude_home).unwrap();
        fs::write(
            claude_home.join(".credentials.json"),
            claude_secret("account-a"),
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let identity_calls = Arc::new(AtomicUsize::new(0));
        let counted = identity_calls.clone();
        let supervisor = AccountSupervisor::open_with_probe_and_claude_identity_resolver(
            &data_dir,
            &home_dir,
            vault.clone(),
            ready_probe(),
            Arc::new(move |_secret: &str| {
                counted.fetch_add(1, Ordering::SeqCst);
                Err(CoreError::Runtime(
                    "Claude 계정 신원 조회 인증이 거부되었습니다 (HTTP 401 Unauthorized)"
                        .to_owned(),
                ))
            }),
        )
        .unwrap();
        supervisor
            .upsert_captured_account(
                ProviderId::Claude,
                None,
                Some("A".to_owned()),
                captured_claude("account-a"),
            )
            .unwrap();
        let account_id = supervisor.snapshot().unwrap().accounts[0].id.clone();
        let account = {
            let state = supervisor.inner.state.lock().unwrap();
            account_by_id(&state.registry, &account_id).unwrap().clone()
        };
        vault
            .put(
                &vault_key(&account),
                &claude_secret_with_expiry(
                    Some("account-a"),
                    "vault-token",
                    now_ms() - 60 * 60_000,
                ),
            )
            .unwrap();
        let dir =
            credential_profiles::ensure_profile_dir(&data_dir, ProviderId::Claude, &account_id)
                .unwrap();
        supervisor.sync_profile_credential(&account, &dir).unwrap();
        fs::write(
            claude_home.join(".credentials.json"),
            claude_secret_with_expiry(None, "stale-shared-token", now_ms() - 60 * 60_000),
        )
        .unwrap();
        supervisor
            .inner
            .state
            .lock()
            .unwrap()
            .runtime_account_counts
            .insert(account_id.clone(), 1);
        (data, home, vault, supervisor, account_id, identity_calls)
    }

    /// 격리 프로필로 실행되는 활성 계정의 사용량 조회는 공유 홈을 읽지 않는다. 공유
    /// 홈에 계정 ID 없는 만료 토큰이 남아 있어도 신원 조회로 넘어가 401을 반복하지
    /// 않고, 자기 볼트·프로필 사슬로 갱신 경로에 든다(여기서는 런타임이 있어 미룬다).
    #[test]
    fn an_isolated_active_account_refreshes_usage_without_reading_the_shared_home() {
        use std::sync::atomic::Ordering;
        let (_data, _home, _vault, supervisor, account_id, identity_calls) =
            isolated_active_claude_with_stale_shared_home();

        let snapshot = supervisor.refresh_usage(&account_id).unwrap();

        assert_eq!(
            identity_calls.load(Ordering::SeqCst),
            0,
            "공유 홈 토큰으로 신원을 조회했습니다"
        );
        let account = snapshot
            .accounts
            .iter()
            .find(|account| account.id == account_id)
            .unwrap();
        assert_eq!(account.auth_status, AccountAuthStatus::Ready);
        let error = account.usage.error.as_deref().unwrap_or_default();
        assert!(error.contains("미룹니다"), "예상과 다른 조회 결과: {error}");
        assert!(
            !error.contains("401"),
            "공유 홈 401이 계정에 기록됐습니다: {error}"
        );
    }

    /// 주기 검증도 같다. 격리 기본 계정은 공유 홈으로 검증하지 않고 프로필로만 본다.
    #[test]
    fn verifying_default_accounts_never_consults_the_shared_home() {
        use std::sync::atomic::Ordering;
        let (_data, _home, _vault, supervisor, account_id, identity_calls) =
            isolated_active_claude_with_stale_shared_home();

        supervisor.verify_registered_active_accounts().unwrap();

        assert_eq!(identity_calls.load(Ordering::SeqCst), 0);
        let account = supervisor
            .snapshot()
            .unwrap()
            .accounts
            .into_iter()
            .find(|account| account.id == account_id)
            .unwrap();
        assert_eq!(account.auth_status, AccountAuthStatus::Ready);
    }

    /// 공유 CLI 홈 관측. 첫 관측 전에는 미확인이고, 신원이 자격증명에 박혀 있으면
    /// 네트워크 없이 확인해 등록 계정과 잇고, 저장소가 없으면 없음으로 보고한다.
    /// 등록되지 않은 로그인은 확인은 되되 계정과 이어지지 않는다.
    #[test]
    fn home_observation_reads_embedded_identities_and_reports_a_missing_store() {
        let (_data, home, _vault, supervisor, a, _b) = two_claude_account_supervisor();
        let provider_view = |supervisor: &AccountSupervisor, provider: ProviderId| {
            supervisor
                .snapshot()
                .unwrap()
                .providers
                .into_iter()
                .find(|state| state.provider == provider)
                .unwrap()
        };
        assert_eq!(
            provider_view(&supervisor, ProviderId::Claude).home.state,
            HomeCredentialState::Unchecked
        );

        supervisor.observe_home_credentials(true).unwrap();
        let claude = provider_view(&supervisor, ProviderId::Claude);
        assert_eq!(claude.home.state, HomeCredentialState::Verified);
        assert_eq!(claude.home.account_id.as_deref(), Some(a.as_str()));
        assert_eq!(
            claude.observed_active_account_id.as_deref(),
            Some(a.as_str())
        );
        let codex = provider_view(&supervisor, ProviderId::Codex);
        assert_eq!(codex.home.state, HomeCredentialState::Absent);
        assert!(codex.home.account_id.is_none());

        let codex_home = home.path().join(".codex");
        fs::create_dir_all(&codex_home).unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("codex-x")).unwrap();
        supervisor.observe_home_credentials(true).unwrap();
        let codex = provider_view(&supervisor, ProviderId::Codex);
        assert_eq!(codex.home.state, HomeCredentialState::Verified);
        assert_eq!(codex.home.provider_account_id.as_deref(), Some("codex-x"));
        assert!(codex.home.account_id.is_none());
        assert!(codex.observed_active_account_id.is_none());
    }

    /// 만료된 Claude 토큰은 신원을 조회하지 않는다. 다른 로그인의 사슬일 수 있어 갱신도
    /// 하지 않으므로 "만료 · 신원 미확인"으로만 보고하고, 공유 홈의 실제 계정은 모른다고 둔다.
    #[test]
    fn home_observation_never_resolves_an_expired_anonymous_claude_token() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_home = home.path().join(".claude");
        fs::create_dir(&claude_home).unwrap();
        fs::write(
            claude_home.join(".credentials.json"),
            claude_secret_with_expiry(None, "stale-shared-token", now_ms() - 60_000),
        )
        .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let supervisor = AccountSupervisor::open_with_claude_identity_resolver(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
            Arc::new(move |_secret: &str| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(claude_identity_of("account-a", "a@example.com"))
            }),
        )
        .unwrap();

        supervisor.observe_home_credentials(true).unwrap();

        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "만료 토큰으로 신원을 조회했습니다"
        );
        let claude = supervisor
            .snapshot()
            .unwrap()
            .providers
            .into_iter()
            .find(|state| state.provider == ProviderId::Claude)
            .unwrap();
        assert_eq!(claude.home.state, HomeCredentialState::Expired);
        assert!(claude.home.access_token_expires_at.is_some());
        assert!(claude.home.account_id.is_none());
        assert!(claude.observed_active_account_id.is_none());
    }

    /// 홈 계정이 등록 계정과 같으면 사용량을 따로 조회하지 않고 그 계정이 이미 읽어 둔
    /// 값을 그대로 옮긴다. 같은 공급자 계정을 두 번 두드리면 429 압력만 두 배가 된다.
    #[test]
    fn a_matching_home_account_borrows_the_registered_accounts_usage() {
        let (_data, _home, _vault, supervisor, a, _b) = two_claude_account_supervisor();
        {
            let mut state = supervisor.inner.state.lock().unwrap();
            account_by_id_mut(&mut state.registry, &a).unwrap().usage =
                usage_result(vec![AccountUsageWindow {
                    label: "5시간".to_owned(),
                    used_percent: 42.0,
                    resets_at: None,
                    ..Default::default()
                }]);
        }
        supervisor.observe_home_credentials(true).unwrap();

        let snapshot = supervisor.snapshot().unwrap();
        let claude = snapshot
            .providers
            .iter()
            .find(|state| state.provider == ProviderId::Claude)
            .unwrap();
        assert_eq!(claude.home.account_id.as_deref(), Some(a.as_str()));
        assert_eq!(claude.home.usage.status, AccountUsageStatus::Ok);
        assert_eq!(claude.home.usage.windows[0].used_percent, 42.0);

        // 겹치는 홈은 조회 대상이 아니다. 관측 캐시에는 아무것도 쌓이지 않는다.
        supervisor
            .refresh_home_usage(ProviderId::Claude, true)
            .unwrap();
        let cached = supervisor
            .inner
            .home_observations
            .lock()
            .unwrap()
            .get(&ProviderId::Claude)
            .unwrap()
            .view
            .usage
            .clone();
        assert_eq!(cached.status, AccountUsageStatus::Idle);
        assert!(cached.updated_at.is_none());
    }

    /// 공유 홈의 만료된 Claude 토큰은 갱신하지 않는다 — 갱신하면 데스크탑 앱·터미널이
    /// 이어 쓰는 로그인 사슬이 끊긴다. 조회 불가라는 사실만 남기고, 사정이 바뀌면
    /// (CLI가 갱신하면) 다음 주기에 그냥 되므로 재시도 대기도 두지 않는다.
    #[test]
    fn home_usage_reports_an_expired_shared_token_instead_of_refreshing_it() {
        let secret =
            claude_secret_with_expiry(Some("account-a"), "stale-shared-token", now_ms() - 60_000);

        let usage = fetch_home_usage(ProviderId::Claude, &secret, now_ms());

        assert_eq!(usage.status, AccountUsageStatus::Unavailable);
        assert!(usage.windows.is_empty());
        assert!(usage.retry_at.is_none());
        let error = usage.error.unwrap_or_default();
        assert!(error.contains("갱신하지 않습니다"), "예상과 다름: {error}");
    }

    /// 확인된 신원은 저장소 값이 같은 동안 다시 묻지 않고, 조회 실패는 저장소가 그대로인
    /// 동안 재시도 대기를 지킨다. 저장소가 바뀌면 대기와 무관하게 곧바로 다시 조회한다.
    #[test]
    fn home_observation_caches_identity_by_store_fingerprint_and_backs_off_on_errors() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_home = home.path().join(".claude");
        fs::create_dir(&claude_home).unwrap();
        let credential_file = claude_home.join(".credentials.json");
        fs::write(
            &credential_file,
            claude_secret_with_expiry(None, "token-1", now_ms() + 60 * 60_000),
        )
        .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let failing = Arc::new(AtomicBool::new(true));
        let (counted, gate) = (calls.clone(), failing.clone());
        let supervisor = AccountSupervisor::open_with_claude_identity_resolver(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
            Arc::new(move |_secret: &str| {
                counted.fetch_add(1, Ordering::SeqCst);
                if gate.load(Ordering::SeqCst) {
                    Err(CoreError::Runtime(
                        "Claude 계정 신원 조회 인증이 거부되었습니다 (HTTP 401 Unauthorized)"
                            .to_owned(),
                    ))
                } else {
                    Ok(claude_identity_of("account-a", "a@example.com"))
                }
            }),
        )
        .unwrap();
        let home_view = |supervisor: &AccountSupervisor| {
            supervisor
                .snapshot()
                .unwrap()
                .providers
                .into_iter()
                .find(|state| state.provider == ProviderId::Claude)
                .unwrap()
                .home
        };

        supervisor.observe_home_credentials(true).unwrap();
        let first = home_view(&supervisor);
        assert_eq!(first.state, HomeCredentialState::Error);
        assert!(first.retry_at.is_some_and(|retry_at| retry_at > now_ms()));
        assert!(first.error.as_deref().unwrap_or_default().contains("401"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        // 저장소가 그대로면 재시도 대기를 지킨다 — 조회가 성공할 상태가 됐더라도.
        failing.store(false, Ordering::SeqCst);
        supervisor.observe_home_credentials(true).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(home_view(&supervisor).state, HomeCredentialState::Error);

        // 저장소가 바뀌면 곧바로 다시 묻는다.
        fs::write(
            &credential_file,
            claude_secret_with_expiry(None, "token-2", now_ms() + 60 * 60_000),
        )
        .unwrap();
        supervisor.observe_home_credentials(true).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let verified = home_view(&supervisor);
        assert_eq!(verified.state, HomeCredentialState::Verified);
        assert_eq!(verified.email.as_deref(), Some("a@example.com"));
        assert!(
            verified.account_id.is_none(),
            "미등록 계정이 등록 계정과 이어졌습니다"
        );

        // 확인된 신원은 저장소가 같은 동안 다시 묻지 않는다.
        supervisor.observe_home_credentials(true).unwrap();
        supervisor.observe_home_credentials(true).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert_eq!(home_view(&supervisor).state, HomeCredentialState::Verified);
    }

    #[test]
    fn home_identity_retry_doubles_from_thirty_minutes_up_to_six_hours() {
        assert_eq!(home_identity_retry_ms(1), 30 * 60_000);
        assert_eq!(home_identity_retry_ms(2), 60 * 60_000);
        assert_eq!(home_identity_retry_ms(3), 120 * 60_000);
        assert_eq!(home_identity_retry_ms(5), 6 * 60 * 60_000);
        assert_eq!(home_identity_retry_ms(40), 6 * 60 * 60_000);
    }

    /// 실제 백엔드처럼 정규화된 경로로 연 감독자와, 비활성 Claude 계정 하나.
    ///
    /// `validated_profile_dir`가 `fs::canonicalize` 결과와 기대 경로가 같기를 요구해서,
    /// macOS 임시 디렉터리(`/var/folders` → `/private/var/folders`)를 그대로 넘기면
    /// 프로필을 찾지 못한다. 디스크 격리 판정을 보려면 여기서 미리 정규화해야 한다.
    fn canonical_claude_supervisor() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<MemoryVault>,
        AccountSupervisor,
        String,
    ) {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let data_dir = fs::canonicalize(data.path()).unwrap();
        let home_dir = fs::canonicalize(home.path()).unwrap();
        let claude_home = home_dir.join(".claude");
        fs::create_dir(&claude_home).unwrap();
        fs::write(
            claude_home.join(".credentials.json"),
            claude_secret("account-a"),
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let supervisor = AccountSupervisor::open_with(&data_dir, &home_dir, vault.clone()).unwrap();
        supervisor
            .upsert_captured_account(
                ProviderId::Claude,
                None,
                Some("A".to_owned()),
                captured_claude("account-a"),
            )
            .unwrap();
        supervisor
            .upsert_captured_account(
                ProviderId::Claude,
                None,
                Some("B".to_owned()),
                captured_claude("account-b"),
            )
            .unwrap();
        let inactive = supervisor
            .snapshot()
            .unwrap()
            .accounts
            .iter()
            .find(|account| account.provider_account_id == "account-b")
            .unwrap()
            .id
            .clone();
        (data, home, vault, supervisor, inactive)
    }

    #[test]
    fn profile_credential_is_written_from_the_vault_and_adopts_cli_rotated_tokens() {
        let (data, _home, vault, supervisor, a, _b) = two_claude_account_supervisor();
        let account = {
            let state = supervisor.inner.state.lock().unwrap();
            account_by_id(&state.registry, &a).unwrap().clone()
        };
        let dir =
            credential_profiles::ensure_profile_dir(data.path(), ProviderId::Claude, &a).unwrap();
        let credential_file = dir.join(".credentials.json");

        // 프로필이 비어 있으면 볼트 값을 기록한다.
        supervisor.sync_profile_credential(&account, &dir).unwrap();
        let written = fs::read_to_string(&credential_file).unwrap();
        assert!(same_secret(
            &written,
            vault.get(&vault_key(&account)).unwrap().as_str()
        ));

        // CLI가 같은 계정으로 토큰을 회전하면 그 값이 최신이므로 볼트가 채택한다.
        let rotated = json!({
            "claudeAiOauth": {
                "accountUuid": "account-a",
                "accessToken": "rotated-token",
                "expiresAt": now_ms() + 60 * 60_000,
            }
        })
        .to_string();
        fs::write(&credential_file, &rotated).unwrap();
        supervisor.sync_profile_credential(&account, &dir).unwrap();
        assert!(same_secret(
            vault.get(&vault_key(&account)).unwrap().as_str(),
            &rotated
        ));

        // 다른 계정의 자격증명이 들어와 있으면 채택하지 않고 볼트 값으로 덮어쓴다.
        fs::write(&credential_file, claude_secret("account-b")).unwrap();
        supervisor.sync_profile_credential(&account, &dir).unwrap();
        let repaired = fs::read_to_string(&credential_file).unwrap();
        assert!(same_secret(&repaired, &rotated));
        assert!(same_secret(
            vault.get(&vault_key(&account)).unwrap().as_str(),
            &rotated
        ));
    }

    /// 볼트 값으로 아직 요청을 보낼 수 있으면, 계정 식별자가 없는 프로필 값을
    /// 채택하려고 라이브 신원 조회까지 하지 않는다. 이 동기화는 채팅·터미널 시작
    /// 경로에 있어 네트워크 대기가 그대로 실행 지연이 된다. 볼트 값이 만료돼 쓸 수
    /// 없을 때에만 묻고, 그때는 프로필의 최신 토큰을 정본으로 올려야 한다.
    #[test]
    fn profile_sync_asks_the_live_identity_only_when_the_vault_credential_is_unusable() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        fs::write(
            claude_root.join(".credentials.json"),
            claude_secret("account-a"),
        )
        .unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let supervisor = AccountSupervisor::open_with_probe_and_claude_identity_resolver(
            data.path(),
            home.path(),
            vault.clone(),
            ready_probe(),
            Arc::new(move |_secret: &str| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(claude_identity_of("account-a", "a@example.com"))
            }),
        )
        .unwrap();
        let account_id = supervisor
            .register_current(ProviderId::Claude, Some("A".to_owned()))
            .unwrap()
            .accounts[0]
            .id
            .clone();
        let account = {
            let state = supervisor.inner.state.lock().unwrap();
            account_by_id(&state.registry, &account_id).unwrap().clone()
        };
        let key = vault_key(&account);
        let dir =
            credential_profiles::ensure_profile_dir(data.path(), ProviderId::Claude, &account_id)
                .unwrap();
        let credential_file = dir.join(".credentials.json");
        // CLI가 회전한 값에 계정 식별자가 없어 자격증명만으로는 신원을 알 수 없다.
        let rotated = claude_secret_with_expiry(None, "rotated-token", now_ms() + 60 * 60_000);

        let usable_vault =
            claude_secret_with_expiry(Some("account-a"), "vault-token", now_ms() + 60 * 60_000);
        vault.put(&key, &usable_vault).unwrap();
        fs::write(&credential_file, &rotated).unwrap();
        supervisor.sync_profile_credential(&account, &dir).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(same_secret(&vault.get(&key).unwrap(), &usable_vault));

        vault
            .put(
                &key,
                &claude_secret_with_expiry(
                    Some("account-a"),
                    "expired-token",
                    now_ms() - 60 * 60_000,
                ),
            )
            .unwrap();
        fs::write(&credential_file, &rotated).unwrap();
        supervisor.sync_profile_credential(&account, &dir).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(same_secret(&vault.get(&key).unwrap(), &rotated));
    }

    /// 관찰된 결함의 회귀 방지. 프로필은 실행 중인 CLI가 토큰을 회전시키는
    /// 저장소라, 액세스 토큰이 만료됐다는 이유로 더 오래된 볼트 값을 덮어쓰면 이미
    /// 소비되어 무효가 된 리프레시 토큰이 다시 심긴다. 그러면 다음 반복 실행이
    /// 갱신조차 못 하고 "OAuth session expired and could not be refreshed"로 죽는다.
    ///
    /// 신원을 증명하지 못해 볼트로 승격만 못 했을 뿐이므로 프로필은 그대로 둔다.
    #[test]
    fn an_expired_vault_credential_never_overwrites_a_newer_profile_chain() {
        let (data, home, vault, account_id) = claude_supervisor_with_failing_identity_lookup();
        let (supervisor, account) = (data.0, data.1);
        let key = vault_key(&account);
        let dir =
            credential_profiles::ensure_profile_dir(home.path(), ProviderId::Claude, &account_id)
                .unwrap();
        let credential_file = dir.join(".credentials.json");

        // 볼트는 어제 발급돼 만료됐고, CLI가 프로필에서 회전시킨 값이 더 새롭다.
        // 프로필 값에는 계정 식별자가 없어 자격증명만으로는 신원을 알 수 없다.
        let stale_vault =
            claude_secret_with_expiry(Some("account-a"), "stale-token", now_ms() - 2 * 60 * 60_000);
        let newer_profile =
            claude_secret_with_expiry(None, "cli-rotated-token", now_ms() - 30 * 60_000);
        vault.put(&key, &stale_vault).unwrap();
        fs::write(&credential_file, &newer_profile).unwrap();

        supervisor.sync_profile_credential(&account, &dir).unwrap();

        assert!(same_secret(
            &fs::read_to_string(&credential_file).unwrap(),
            &newer_profile
        ));
        assert!(same_secret(&vault.get(&key).unwrap(), &stale_vault));
    }

    /// 액세스 토큰이 만료됐어도 함께 회전된 리프레시 토큰이 들어 있으면 CLI가 스스로
    /// 갱신해 쓸 수 있는 최신 사슬이다. 신원이 증명되면 볼트도 그 값을 정본으로
    /// 삼아야, 앱의 사용량 조회가 CLI와 같은 사슬을 따라간다.
    #[test]
    fn a_newer_profile_chain_is_adopted_even_after_its_access_token_expired() {
        let (_data, _home, vault, supervisor, a, _b) = two_claude_account_supervisor();
        let account = {
            let state = supervisor.inner.state.lock().unwrap();
            account_by_id(&state.registry, &a).unwrap().clone()
        };
        let key = vault_key(&account);
        let dir = credential_profiles::ensure_profile_dir(
            supervisor.inner.app_data_dir.as_path(),
            ProviderId::Claude,
            &a,
        )
        .unwrap();
        let credential_file = dir.join(".credentials.json");

        let stale_vault =
            claude_secret_with_expiry(Some("account-a"), "stale-token", now_ms() - 2 * 60 * 60_000);
        let newer_profile =
            claude_secret_with_expiry(Some("account-a"), "rotated-token", now_ms() - 30 * 60_000);
        vault.put(&key, &stale_vault).unwrap();
        fs::write(&credential_file, &newer_profile).unwrap();

        supervisor.sync_profile_credential(&account, &dir).unwrap();

        assert!(same_secret(&vault.get(&key).unwrap(), &newer_profile));
    }

    /// 공급자 CLI의 인증 상태 조회는 자격증명이 있는지만 답한다. 갱신조차 못 하는
    /// 자격증명에 격리 허가가 나가면 반복 실행이 대기로 남는 대신 CLI의 인증 오류로
    /// 회차를 소진한다.
    #[test]
    fn a_profile_that_can_no_longer_refresh_is_not_offered_for_isolation() {
        let (data, home, vault, account_id) = claude_supervisor_with_failing_identity_lookup();
        let (supervisor, account) = (data.0, data.1);
        let dir =
            credential_profiles::ensure_profile_dir(home.path(), ProviderId::Claude, &account_id)
                .unwrap();
        // 액세스 토큰은 만료됐고 리프레시 토큰도 없어 CLI가 되살릴 수 없다.
        let dead =
            claude_secret_with_expiry(Some("account-a"), "dead-token", now_ms() - 60 * 60_000);
        vault.put(&vault_key(&account), &dead).unwrap();
        fs::write(dir.join(".credentials.json"), &dead).unwrap();

        assert!(supervisor
            .runtime_credential_profile(ProviderId::Claude, &account_id)
            .unwrap()
            .is_none());
        assert!(supervisor
            .credential_profile_fallback_reason(&account_id)
            .is_some_and(|reason| reason.contains("갱신할 수 없습니다")));

        // 리프레시 토큰이 있으면 CLI가 스스로 갱신하므로 막지 않는다.
        let refreshable = json!({
            "claudeAiOauth": {
                "accountUuid": "account-a",
                "accessToken": "expired-token",
                "refreshToken": "still-good",
                "expiresAt": now_ms() - 60 * 60_000,
            }
        })
        .to_string();
        vault.put(&vault_key(&account), &refreshable).unwrap();
        fs::write(dir.join(".credentials.json"), &refreshable).unwrap();
        supervisor
            .inner
            .credential_profiles
            .lock()
            .unwrap()
            .remove(&account_id);

        assert!(supervisor
            .runtime_credential_profile(ProviderId::Claude, &account_id)
            .unwrap()
            .is_some());
    }

    /// 성공 판정을 영구 캐시하면 사슬이 끊긴 뒤에도 실행 허가가 계속 나간다.
    /// 재확인 시한이 지나면 프로브를 다시 돌려야 한다.
    #[test]
    fn a_ready_profile_is_reverified_after_its_ttl() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        fs::write(
            claude_root.join(".credentials.json"),
            claude_secret_with_expiry(Some("account-a"), "token-a", now_ms() + 60 * 60_000),
        )
        .unwrap();
        let probes = Arc::new(AtomicUsize::new(0));
        let counted = probes.clone();
        let supervisor = AccountSupervisor::open_with_credential_probe(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
            Arc::new(move |_provider, _env: &[(String, String)]| {
                counted.fetch_add(1, Ordering::SeqCst);
                ProbeOutcome::Ready
            }),
        )
        .unwrap();
        let account_id = supervisor
            .register_current(ProviderId::Claude, Some("A".to_owned()))
            .unwrap()
            .accounts[0]
            .id
            .clone();

        assert!(supervisor
            .runtime_credential_profile(ProviderId::Claude, &account_id)
            .unwrap()
            .is_some());
        assert_eq!(probes.load(Ordering::SeqCst), 1);

        // 시한 안에서는 캐시만 읽는다.
        assert!(supervisor
            .runtime_credential_profile(ProviderId::Claude, &account_id)
            .unwrap()
            .is_some());
        assert_eq!(probes.load(Ordering::SeqCst), 1);

        // 시한이 지난 판정은 없는 것처럼 다뤄 다시 확인한다.
        if let Some(CredentialProfileEntry::Ready { verified_at, .. }) = supervisor
            .inner
            .credential_profiles
            .lock()
            .unwrap()
            .get_mut(&account_id)
        {
            *verified_at = now_ms() - CREDENTIAL_PROFILE_READY_TTL_MS - 1;
        }
        assert!(supervisor
            .runtime_credential_profile(ProviderId::Claude, &account_id)
            .unwrap()
            .is_some());
        assert_eq!(probes.load(Ordering::SeqCst), 2);
    }

    /// 등록된 Claude 계정 하나와, 라이브 신원 조회가 항상 실패하는 감독자.
    /// 만료된 토큰으로 프로필 API를 부르면 401이 오는 실제 상황을 흉내낸다.
    fn claude_supervisor_with_failing_identity_lookup() -> (
        (AccountSupervisor, AccountRecord),
        tempfile::TempDir,
        Arc<MemoryVault>,
        String,
    ) {
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        fs::write(
            claude_root.join(".credentials.json"),
            claude_secret("account-a"),
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let supervisor = AccountSupervisor::open_with_probe_and_claude_identity_resolver(
            home.path(),
            home.path(),
            vault.clone(),
            ready_probe(),
            Arc::new(|_secret: &str| {
                Err(CoreError::Conflict(
                    "Claude 계정 신원 조회 인증이 거부되었습니다 (HTTP 401 Unauthorized)"
                        .to_owned(),
                ))
            }),
        )
        .unwrap();
        let account_id = supervisor
            .register_current(ProviderId::Claude, Some("A".to_owned()))
            .unwrap()
            .accounts[0]
            .id
            .clone();
        let account = {
            let state = supervisor.inner.state.lock().unwrap();
            account_by_id(&state.registry, &account_id).unwrap().clone()
        };
        ((supervisor, account), home, vault, account_id)
    }

    /// Keychain이 없는 플랫폼에서는 프로필 자격증명도 파일로 남아야 한다. 여기서
    /// 오류를 내면 그 플랫폼에서는 비활성 계정을 아예 실행하지 못한다.
    #[test]
    fn a_profile_credential_falls_back_to_a_file_where_the_keychain_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let secret = claude_secret("account-a");

        write_active_credentials(
            dir.path(),
            ProviderId::Claude,
            Some(dir.path()),
            false,
            &secret,
        )
        .unwrap();

        let written = fs::read_to_string(dir.path().join(".credentials.json")).unwrap();
        assert!(same_secret(&written, &secret));
    }

    /// Keychain이 정본이 된 뒤 남은 평문 파일은 읽히지 않는 옛 토큰이라 지운다.
    /// 이미 없으면 조용히 넘어가야 한다.
    #[test]
    fn discarding_the_plaintext_profile_credential_tolerates_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".credentials.json");
        fs::write(&path, claude_secret("account-a")).unwrap();

        discard_profile_secret_file(&path);
        assert!(!path.exists());

        discard_profile_secret_file(&path);
        assert!(!path.exists());
    }

    /// 파일 저장소를 쓰는 프로필은 값이 이미 볼트와 같아도 파일을 그대로 둔다.
    /// 저장소를 옮기는 정리가 여기까지 오면 Keychain이 없는 플랫폼에서 자격증명이
    /// 사라진다.
    #[test]
    fn syncing_a_file_backed_profile_keeps_its_credential_file() {
        let (data, _home, _vault, supervisor, a, _b) = two_claude_account_supervisor();
        let account = {
            let state = supervisor.inner.state.lock().unwrap();
            account_by_id(&state.registry, &a).unwrap().clone()
        };
        let dir =
            credential_profiles::ensure_profile_dir(data.path(), ProviderId::Claude, &a).unwrap();
        let credential_file = dir.join(".credentials.json");

        supervisor.sync_profile_credential(&account, &dir).unwrap();
        assert!(credential_file.exists());

        // 값이 볼트와 같아 다시 쓰지 않는 두 번째 호출에서도 남아 있어야 한다.
        supervisor.sync_profile_credential(&account, &dir).unwrap();
        assert!(credential_file.exists());
    }

    /// 만료 시각을 담은 Claude 자격증명. 계정 식별자가 없는 값도 만들 수 있어야
    /// 라이브 신원 조회가 필요한 경우를 재현할 수 있다.
    fn claude_secret_with_expiry(
        account_id: Option<&str>,
        access_token: &str,
        expires_at: i64,
    ) -> String {
        let mut oauth = json!({
            "accessToken": access_token,
            "expiresAt": expires_at,
        });
        if let Some(account_id) = account_id {
            oauth["accountUuid"] = json!(account_id);
        }
        json!({ "claudeAiOauth": oauth }).to_string()
    }

    /// 관찰된 결함 상태를 그대로 만든다. 등록된 활성 Claude 계정 하나가 있고,
    /// OAuth 세션이 만료돼 볼트 값으로는 갱신할 수 없고, 공급자 공유 저장소는
    /// 로그인이 끊겨 있고(`loggedIn: false`), 앱이 이전 실행에서 만들어 둔 C4
    /// 프로필에만 이 계정의 유효한 자격증명이 남아 있다. 재시작이므로 프로필 캐시는
    /// 비어 있고 계정은 재인증 필요로 저장돼 있다.
    fn stranded_claude_profile_fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Arc<MemoryVault>,
        String,
        String,
    ) {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let claude_root = home.path().join(".claude");
        fs::create_dir(&claude_root).unwrap();
        fs::write(
            claude_root.join(".credentials.json"),
            claude_secret("account-a"),
        )
        .unwrap();
        fs::write(
            claude_root.join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"account-a","emailAddress":"a@example.com"}}"#,
        )
        .unwrap();
        let vault = Arc::new(MemoryVault::default());
        let first = AccountSupervisor::open_with(data.path(), home.path(), vault.clone()).unwrap();
        let account_id = first
            .register_current(ProviderId::Claude, Some("A".to_owned()))
            .unwrap()
            .accounts[0]
            .id
            .clone();

        let dir =
            credential_profiles::ensure_profile_dir(data.path(), ProviderId::Claude, &account_id)
                .unwrap();
        let profile_secret =
            claude_secret_with_expiry(Some("account-a"), "profile-token", now_ms() + 60 * 60_000);
        fs::write(dir.join(".credentials.json"), &profile_secret).unwrap();
        vault
            .put(
                &format!("claude:{account_id}"),
                &claude_secret_with_expiry(
                    Some("account-a"),
                    "stale-token",
                    now_ms() - 60 * 60_000,
                ),
            )
            .unwrap();
        fs::write(
            claude_root.join(".credentials.json"),
            SIGNED_OUT_CLAUDE_SECRET,
        )
        .unwrap();
        let mut registry = load_registry(data.path()).unwrap();
        account_by_id_mut(&mut registry, &account_id)
            .unwrap()
            .auth_status = AccountAuthStatus::Error;
        save_registry(data.path(), &registry).unwrap();
        drop(first);
        (data, home, vault, account_id, profile_secret)
    }

    /// 공급자 공유 저장소에 남은, 로그인이 끊긴 자격증명. 액세스 토큰이 비어 있어
    /// 구조적으로 불완전하다.
    const SIGNED_OUT_CLAUDE_SECRET: &str = r#"{"claudeAiOauth":{"accessToken":""}}"#;

    fn claude_identity_of(account_id: &str, email: &str) -> AccountIdentity {
        AccountIdentity {
            provider_account_id: account_id.to_owned(),
            legacy_provider_account_id: None,
            email: Some(email.to_owned()),
            organization: None,
            display_name: None,
        }
    }

    /// 재시작 뒤에는 프로필 캐시가 비어 있어 "격리로 실행 중"이라는 근거가 없다.
    /// 그래도 앱이 소유한 프로필에 이 계정의 유효한 자격증명이 남아 있으면 계정을
    /// 되살려야 한다. 여기서 막히면 유효한 프로필을 손에 쥔 채로 계정이 재인증
    /// 필요에 갇히고, 스케줄러가 계정을 거부한다.
    #[test]
    fn startup_recovers_the_active_claude_account_from_its_app_owned_profile() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let (data, home, vault, account_id, profile_secret) = stranded_claude_profile_fixture();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let reopened = AccountSupervisor::open_with_probe_and_claude_identity_resolver(
            data.path(),
            home.path(),
            vault.clone(),
            ready_probe(),
            Arc::new(move |secret: &str| {
                counted.fetch_add(1, Ordering::SeqCst);
                claude_identity_from_secret(secret)
            }),
        )
        .unwrap();

        // 자격증명에 계정 식별자가 박혀 있으므로 라이브 신원 조회는 부르지 않는다.
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let snapshot = reopened.snapshot().unwrap();
        let account = snapshot
            .accounts
            .iter()
            .find(|account| account.id == account_id)
            .unwrap();
        assert_eq!(account.auth_status, AccountAuthStatus::Ready);
        assert!(account.credential_isolated);
        assert!(same_secret(
            &vault.get(&format!("claude:{account_id}")).unwrap(),
            &profile_secret
        ));
        // 되살린 볼트로 격리를 준비해 이 계정으로 실행을 시작할 수 있다.
        assert!(reopened.ensure_credential_isolation(ProviderId::Claude, &account_id));
        drop(
            reopened
                .acquire_runtime(ProviderId::Claude, Some(&account_id))
                .unwrap(),
        );

        // 공급자가 소유한 공유 자격증명은 복구가 건드리지 않는다. 이 저장소를 여기서
        // 고치려면 런타임 유휴 확인과 전환 저널을 갖춘 전환 경로가 필요하다.
        assert_eq!(
            fs::read_to_string(home.path().join(".claude").join(".credentials.json")).unwrap(),
            SIGNED_OUT_CLAUDE_SECRET
        );
    }

    /// 없거나 불완전하거나 만료됐거나 읽을 수 없거나 다른 계정인 프로필은 복구
    /// 근거가 아니다. 이런 값이 볼트를 덮으면 앱이 스스로 쓸 수 없는 자격증명을
    /// 정본으로 승격한다.
    #[test]
    fn an_unproven_profile_credential_never_replaces_the_vault() {
        let (data, home, vault, account_id, _profile_secret) = stranded_claude_profile_fixture();
        let key = format!("claude:{account_id}");
        let stale = vault.get(&key).unwrap().to_string();
        let dir =
            credential_profiles::profile_dir(data.path(), ProviderId::Claude, &account_id).unwrap();
        let credential_file = dir.join(".credentials.json");
        let rejected = [
            // 액세스 토큰이 빠져 로그인이 끝나지 않은 값.
            Some(r#"{"claudeAiOauth":{"accountUuid":"account-a","accessToken":""}}"#.to_owned()),
            // 만료된 값.
            Some(claude_secret_with_expiry(
                Some("account-a"),
                "expired-token",
                now_ms() - 60 * 60_000,
            )),
            // 다른 계정의 값.
            Some(claude_secret_with_expiry(
                Some("account-b"),
                "other-token",
                now_ms() + 60 * 60_000,
            )),
            // 읽어도 해석할 수 없는 값.
            Some("not json".to_owned()),
            // 프로필 자체가 없는 경우. 디렉터리를 지우므로 마지막에 확인한다.
            None,
        ];
        for candidate in rejected {
            match &candidate {
                Some(secret) => fs::write(&credential_file, secret).unwrap(),
                None => fs::remove_dir_all(&dir).unwrap(),
            }
            let reopened = AccountSupervisor::open_with_probe_and_claude_identity_resolver(
                data.path(),
                home.path(),
                vault.clone(),
                ready_probe(),
                Arc::new(claude_identity_from_secret),
            )
            .unwrap();

            assert_eq!(
                vault.get(&key).unwrap().as_str(),
                stale.as_str(),
                "증명되지 않은 프로필이 볼트를 덮었습니다"
            );
            let snapshot = reopened.snapshot().unwrap();
            assert_eq!(
                snapshot
                    .accounts
                    .iter()
                    .find(|account| account.id == account_id)
                    .unwrap()
                    .auth_status,
                AccountAuthStatus::Error
            );
        }
    }

    /// 프로필 값이 온전하고 이 계정 것임이 자격증명 안에서 증명되더라도, 유효기간
    /// 증거가 없으면 볼트의 정본을 갈아치울 수 없다. 만료 시각이 없거나 숫자로 읽히지
    /// 않는 값을 "아직 유효하다"로 세면, 앱이 스스로 쓸 수 없는 토큰을 정본으로
    /// 올리고 복구는 성공했다고 보고한다.
    #[test]
    fn a_profile_credential_without_proven_expiry_never_recovers_the_account() {
        let (data, home, vault, account_id, _profile_secret) = stranded_claude_profile_fixture();
        let key = format!("claude:{account_id}");
        let stale = vault.get(&key).unwrap().to_string();
        let dir =
            credential_profiles::profile_dir(data.path(), ProviderId::Claude, &account_id).unwrap();
        let credential_file = dir.join(".credentials.json");
        let rejected = [
            // 만료 시각이 아예 없는 값.
            json!({"accountUuid": "account-a", "accessToken": "profile-token"}),
            // 숫자로 읽히지 않는 만료 시각.
            json!({
                "accountUuid": "account-a",
                "accessToken": "profile-token",
                "expiresAt": "9999999999999",
            }),
            json!({
                "accountUuid": "account-a",
                "accessToken": "profile-token",
                "expiresAt": null,
            }),
            json!({
                "accountUuid": "account-a",
                "accessToken": "profile-token",
                "expiresAt": {"ms": 9_999_999_999_999i64},
            }),
        ];
        for oauth in rejected {
            fs::write(
                &credential_file,
                json!({ "claudeAiOauth": oauth }).to_string(),
            )
            .unwrap();
            let reopened = AccountSupervisor::open_with_probe_and_claude_identity_resolver(
                data.path(),
                home.path(),
                vault.clone(),
                ready_probe(),
                Arc::new(claude_identity_from_secret),
            )
            .unwrap();

            assert_eq!(
                vault.get(&key).unwrap().as_str(),
                stale.as_str(),
                "유효기간이 증명되지 않은 프로필이 볼트를 덮었습니다"
            );
            assert_eq!(
                reopened
                    .snapshot()
                    .unwrap()
                    .accounts
                    .iter()
                    .find(|account| account.id == account_id)
                    .unwrap()
                    .auth_status,
                AccountAuthStatus::Error
            );
        }

        // 복구를 막았다고 공급자가 소유한 공유 자격증명을 대신 건드리지는 않는다.
        assert_eq!(
            fs::read_to_string(home.path().join(".claude").join(".credentials.json")).unwrap(),
            SIGNED_OUT_CLAUDE_SECRET
        );
    }

    /// 같은 기준을 채팅·터미널 시작 경로의 볼트 동기화에서도 지킨다. CLI가 회전한
    /// 값처럼 보여도 유효기간 증거가 없으면 정본이 되지 못하고 프로필은 볼트 값으로
    /// 되돌아간다. 볼트 값이 이미 만료돼 쓸 수 없을 때에도 마찬가지다. 증거 없는
    /// 값으로 갈아타 봐야 쓸 수 없는 자격증명 하나만 남는다.
    #[test]
    fn profile_sync_refuses_to_adopt_a_credential_without_proven_expiry() {
        let (data, _home, vault, supervisor, a, _b) = two_claude_account_supervisor();
        let account = {
            let state = supervisor.inner.state.lock().unwrap();
            account_by_id(&state.registry, &a).unwrap().clone()
        };
        let key = vault_key(&account);
        let dir =
            credential_profiles::ensure_profile_dir(data.path(), ProviderId::Claude, &a).unwrap();
        let credential_file = dir.join(".credentials.json");
        // 온전하고 계정 식별자까지 박혀 있지만 만료 시각이 없는 값.
        let unproven = claude_secret("account-a");

        for vault_secret in [
            claude_secret_with_expiry(Some("account-a"), "vault-token", now_ms() + 60 * 60_000),
            claude_secret_with_expiry(Some("account-a"), "expired-token", now_ms() - 60 * 60_000),
        ] {
            vault.put(&key, &vault_secret).unwrap();
            fs::write(&credential_file, &unproven).unwrap();
            supervisor.sync_profile_credential(&account, &dir).unwrap();

            assert!(
                same_secret(&vault.get(&key).unwrap(), &vault_secret),
                "유효기간이 증명되지 않은 프로필이 볼트를 덮었습니다"
            );
            assert!(same_secret(
                &fs::read_to_string(&credential_file).unwrap(),
                &vault_secret
            ));
        }

        // 만료 시각이 숫자로 남아 있는 회전 토큰은 지금까지처럼 채택한다.
        let rotated =
            claude_secret_with_expiry(Some("account-a"), "rotated-token", now_ms() + 60 * 60_000);
        fs::write(&credential_file, &rotated).unwrap();
        supervisor.sync_profile_credential(&account, &dir).unwrap();
        assert!(same_secret(&vault.get(&key).unwrap(), &rotated));
    }

    /// 최신 Claude 자격증명에는 계정 식별자가 없을 수 있고, 그때 남는 증명 수단은
    /// 기존 라이브 신원 조회뿐이다. 조회가 다른 계정을 돌려주면 복구하지 않고,
    /// 등록된 계정을 돌려줄 때만 그 값을 정본으로 채택한다.
    #[test]
    fn profile_recovery_asks_the_live_claude_identity_only_without_an_embedded_one() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let (data, home, vault, account_id, _profile_secret) = stranded_claude_profile_fixture();
        let key = format!("claude:{account_id}");
        let stale = vault.get(&key).unwrap().to_string();
        let dir =
            credential_profiles::profile_dir(data.path(), ProviderId::Claude, &account_id).unwrap();
        let anonymous = claude_secret_with_expiry(None, "profile-token", now_ms() + 60 * 60_000);
        fs::write(dir.join(".credentials.json"), &anonymous).unwrap();

        let other = AccountSupervisor::open_with_probe_and_claude_identity_resolver(
            data.path(),
            home.path(),
            vault.clone(),
            ready_probe(),
            Arc::new(|_secret: &str| Ok(claude_identity_of("account-b", "b@example.com"))),
        )
        .unwrap();
        assert_eq!(vault.get(&key).unwrap().as_str(), stale.as_str());
        assert_eq!(
            other.snapshot().unwrap().accounts[0].auth_status,
            AccountAuthStatus::Error
        );
        drop(other);

        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let reopened = AccountSupervisor::open_with_probe_and_claude_identity_resolver(
            data.path(),
            home.path(),
            vault.clone(),
            ready_probe(),
            Arc::new(move |_secret: &str| {
                counted.fetch_add(1, Ordering::SeqCst);
                Ok(claude_identity_of("account-a", "a@example.com"))
            }),
        )
        .unwrap();

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(same_secret(&vault.get(&key).unwrap(), &anonymous));
        assert_eq!(
            reopened.snapshot().unwrap().accounts[0].auth_status,
            AccountAuthStatus::Ready
        );
    }

    /// 격리가 확인되는 프로브. 실제 CLI를 띄우지 않고, 프로필 환경변수가 채워진
    /// 상태로 불렸는지만 확인한다.
    fn ready_probe() -> Arc<CredentialProbe> {
        Arc::new(|_provider, env: &[(String, String)]| {
            assert!(
                env.iter()
                    .any(|(key, value)| !key.is_empty() && !value.is_empty()),
                "프로필 환경변수 없이 프로브가 불렸습니다"
            );
            ProbeOutcome::Ready
        })
    }

    /// 활성 계정 A가 돌고 있는 동안 격리된 비활성 계정 B도 실행을 시작한다. 한도는
    /// 계정 단위로 걸리므로 계정을 갈라야 요청이 동시에 나가고, 여기서 막히면
    /// 자격증명을 계정별로 갈라 둔 의미가 없다.
    #[test]
    fn an_isolated_inactive_account_starts_a_runtime_beside_the_active_one() {
        let (_data, home, supervisor, a, b) = two_account_supervisor_with_probe(ready_probe());

        let active = supervisor
            .acquire_runtime(ProviderId::Codex, Some(&a))
            .unwrap();
        let isolated = supervisor
            .acquire_runtime(ProviderId::Codex, Some(&b))
            .unwrap();

        // 두 런타임은 서로 다른 계정에 귀속된다.
        assert_eq!(active.account_id.as_deref(), Some(a.as_str()));
        assert_eq!(isolated.account_id.as_deref(), Some(b.as_str()));
        assert_eq!(supervisor.account_runtime_count(&a).unwrap(), 1);
        assert_eq!(supervisor.account_runtime_count(&b).unwrap(), 1);

        // 공유 활성 계정은 그대로다. 비활성 계정 실행이 공유 홈을 건드리면 A의
        // 런타임이 남의 자격증명으로 요청을 보내게 된다.
        assert_eq!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(a.clone())
        );
        let shared: Value =
            serde_json::from_slice(&fs::read(home.path().join(".codex/auth.json")).unwrap())
                .unwrap();
        assert_eq!(
            shared.pointer("/tokens/account_id").and_then(Value::as_str),
            Some("account-a")
        );

        // 두 계정의 프로필 경로와 환경변수가 갈려 있고, 프로필에는 그 계정의
        // 자격증명만 들어간다.
        let a_profile = supervisor
            .runtime_credential_profile(ProviderId::Codex, &a)
            .unwrap()
            .expect("활성 계정 프로필");
        let b_profile = supervisor
            .runtime_credential_profile(ProviderId::Codex, &b)
            .unwrap()
            .expect("격리된 비활성 계정 프로필");
        assert_ne!(a_profile.dir, b_profile.dir);
        assert_ne!(a_profile.env, b_profile.env);
        let isolated_secret: Value =
            serde_json::from_slice(&fs::read(b_profile.dir.join("auth.json")).unwrap()).unwrap();
        assert_eq!(
            isolated_secret
                .pointer("/tokens/account_id")
                .and_then(Value::as_str),
            Some("account-b")
        );

        drop(active);
        drop(isolated);
        assert_eq!(supervisor.account_runtime_count(&b).unwrap(), 0);
    }

    /// 캐시된 격리 실패의 재시도 시각을 지난 것으로 만든다.
    fn expire_isolation_retry(supervisor: &AccountSupervisor, account_id: &str) {
        let mut profiles = supervisor.inner.credential_profiles.lock().unwrap();
        match profiles.get_mut(account_id) {
            Some(CredentialProfileEntry::Unsupported { retry_at, .. }) => *retry_at = 0,
            _ => panic!("격리 실패가 캐시되어 있어야 합니다"),
        }
    }

    /// 격리 실패는 재시도 시각까지만 캐시한다. CLI 경로나 저장소 권한을 고친 뒤
    /// 앱을 재시작해야만 격리로 돌아올 수 있으면, 반복 실행은 그때까지 계정 준비
    /// 대기에 머문다.
    #[test]
    fn an_expired_isolation_failure_is_probed_again() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let attempts = Arc::new(AtomicUsize::new(0));
        let probe_attempts = Arc::clone(&attempts);
        let (_data, _home, supervisor, _a, b) =
            two_account_supervisor_with_probe(Arc::new(move |_provider, _env| {
                if probe_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    ProbeOutcome::Unavailable("공급자 CLI를 찾지 못했습니다".to_owned())
                } else {
                    ProbeOutcome::Ready
                }
            }));

        assert!(!supervisor.ensure_credential_isolation(ProviderId::Codex, &b));
        // 재시도 시각 전에는 캐시된 실패를 그대로 쓴다. CLI를 매번 띄우지 않는다.
        assert!(!supervisor.ensure_credential_isolation(ProviderId::Codex, &b));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);

        expire_isolation_retry(&supervisor, &b);

        assert!(supervisor.ensure_credential_isolation(ProviderId::Codex, &b));
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert!(supervisor.credential_profile_active(&b));
        assert!(supervisor.credential_profile_fallback_reason(&b).is_none());
    }

    /// 프로브가 격리를 확인하지 못하면 어느 계정도 실행하지 않는다. 공유 홈으로 폴백하면
    /// 그 저장소에 든 다른 로그인의 한도를 쓰고 사용량 집계도 어긋난다.
    #[test]
    fn an_account_is_rejected_when_the_isolation_probe_fails() {
        let (_data, _home, supervisor, a, b) =
            two_account_supervisor_with_probe(Arc::new(|_provider, _env| {
                ProbeOutcome::Unavailable("프로브 실패".to_owned())
            }));
        for account in [&a, &b] {
            let rejected = match supervisor.acquire_runtime(ProviderId::Codex, Some(account)) {
                Ok(_) => panic!("격리를 확인하지 못한 계정이 실행됐습니다"),
                Err(error) => error,
            };
            assert!(
                matches!(&rejected, CoreError::Conflict(message) if message.contains("격리")),
                "예상과 다른 거부입니다: {rejected:?}"
            );
            assert!(!supervisor.credential_profile_active(account));
            assert!(supervisor
                .credential_profile_fallback_reason(account)
                .is_some());
            assert_eq!(supervisor.account_runtime_count(account).unwrap(), 0);
        }
        assert_eq!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(a.clone())
        );
    }

    /// 격리는 활성 계정 검사만 면제한다. 계정·공급자·중지 검증은 그대로 남는다.
    #[test]
    fn isolation_does_not_bypass_account_or_disabled_checks() {
        let (_data, _home, supervisor, _a, b) = two_account_supervisor_with_probe(ready_probe());
        assert!(supervisor.ensure_credential_isolation(ProviderId::Codex, &b));

        supervisor.set_disabled(&b, true).unwrap();
        assert!(supervisor
            .acquire_runtime(ProviderId::Codex, Some(&b))
            .is_err());
        supervisor.set_disabled(&b, false).unwrap();

        // 없는 계정과 다른 공급자 요청도 그대로 막는다.
        assert!(supervisor
            .acquire_runtime(ProviderId::Codex, Some("codex-missing"))
            .is_err());
        assert!(supervisor
            .acquire_runtime(ProviderId::Claude, Some(&b))
            .is_err());
    }

    /// 등록 계정은 격리 프로필로만 실행된다. 격리를 준비할 수 없으면 기본 계정이어도 공유
    /// CLI 홈으로 폴백하지 않는다 — 그 저장소에는 다른 로그인이 들어 있을 수 있다. 계정을
    /// 관리하지 않는 공급자는 계정 없이 뜬다.
    #[test]
    fn no_registered_account_falls_back_to_the_shared_home() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let codex_home = home.path().join(".codex");
        fs::create_dir(&codex_home).unwrap();
        fs::write(codex_home.join("auth.json"), codex_secret("account-a")).unwrap();
        let supervisor = AccountSupervisor::open_with_credential_probe(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
            Arc::new(unavailable_credential_probe),
        )
        .unwrap();
        let a = supervisor
            .register_current(ProviderId::Codex, Some("A".to_owned()))
            .unwrap()
            .accounts[0]
            .id
            .clone();
        assert_eq!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(a.clone())
        );

        let rejected = supervisor
            .acquire_runtime(ProviderId::Codex, Some(&a))
            .err()
            .expect("격리 없는 계정으로 런타임이 확보됐습니다");
        assert!(matches!(rejected, CoreError::Conflict(_)));
        assert!(rejected.to_string().contains("격리"), "{rejected}");
        // 계정 미지정도 기본 계정으로 귀속되므로 같은 이유로 거부된다.
        assert!(supervisor.acquire_runtime(ProviderId::Codex, None).is_err());
        assert!(supervisor
            .acquire_runtime(ProviderId::Antigravity, None)
            .is_ok());
    }

    #[test]
    fn deleting_an_account_removes_its_credential_profile() {
        let (data, _home, _vault, supervisor, a, b) = two_claude_account_supervisor();
        let dir =
            credential_profiles::ensure_profile_dir(data.path(), ProviderId::Claude, &b).unwrap();
        fs::write(dir.join(".credentials.json"), claude_secret("account-b")).unwrap();
        assert!(dir.join(".credentials.json").is_file());

        // 활성 계정(a)이 남아 있어야 비활성 계정(b)을 지울 수 있다.
        assert_ne!(a, b);
        supervisor.delete_account(&b, false).unwrap();

        assert!(!dir.exists(), "삭제한 계정의 자격증명이 남아 있습니다");
    }

    #[test]
    fn inactive_account_usage_refresh_is_no_longer_rejected() {
        let (_data, _home, _vault, supervisor, _active, inactive) = two_claude_account_supervisor();
        // 조회 자체는 네트워크 결과에 따라 성공·오류 어느 쪽도 될 수 있다. 여기서
        // 고정하는 계약은 "활성 계정만" 거부가 사라졌다는 것이다.
        if let Err(error) = supervisor.refresh_usage(&inactive) {
            assert!(
                !error.to_string().contains("활성 계정만"),
                "비활성 계정 조회가 활성 계정 제약으로 막혔습니다: {error}"
            );
        }
    }

    #[test]
    fn auto_switch_priority_policy_prefers_the_lowest_assigned_priority() {
        let now = 1_000_000;
        let mut low = auto_switch_record("low", true, AccountUsageView::default());
        low.auto_switch_priority = Some(1);
        let mut high = auto_switch_record("high", true, AccountUsageView::default());
        high.auto_switch_priority = Some(9);
        let unset = auto_switch_record("unset", true, AccountUsageView::default());
        // 등록 순서는 unset → high → low로 두어, 우선순위가 순서를 이기는지 본다.
        let accounts = vec![
            auto_switch_record("active", true, AccountUsageView::default()),
            unset,
            high,
            low,
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Priority,
                None,
            ),
            Some("low".to_owned())
        );
        // 지정된 계정이 모두 빠지면 미지정 계정이 등록 순으로 후보가 된다.
        let accounts = vec![
            auto_switch_record("active", true, AccountUsageView::default()),
            auto_switch_record("unset-a", true, AccountUsageView::default()),
            auto_switch_record("unset-b", true, AccountUsageView::default()),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Priority,
                None,
            ),
            Some("unset-a".to_owned())
        );
    }

    #[test]
    fn auto_switch_headroom_policy_prefers_the_account_with_the_most_room_left() {
        let now = 1_000_000;
        let usage = |percent: f64| AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "5h".to_owned(),
                used_percent: percent,
                resets_at: None,
                ..Default::default()
            }],
            updated_at: Some(now),
            ..AccountUsageView::default()
        };
        let accounts = vec![
            auto_switch_record("active", true, usage(99.0)),
            auto_switch_record("busy", true, usage(80.0)),
            auto_switch_record("free", true, usage(10.0)),
            // 사용량을 아직 읽지 못한 계정은 여유를 아는 계정 뒤로 밀린다.
            auto_switch_record("unknown", true, AccountUsageView::default()),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::MaxHeadroom,
                None,
            ),
            Some("free".to_owned())
        );
        // 여유를 아는 계정이 모두 한도에 걸리면 미조회 계정이 후보가 된다.
        let accounts = vec![
            auto_switch_record("active", true, usage(99.0)),
            auto_switch_record("full", true, usage(100.0)),
            auto_switch_record("unknown", true, AccountUsageView::default()),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::MaxHeadroom,
                None,
            ),
            Some("unknown".to_owned())
        );
        // 가장 빡빡한 창을 기준으로 여유를 본다.
        let tight = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![
                AccountUsageWindow {
                    label: "5h".to_owned(),
                    used_percent: 5.0,
                    resets_at: None,
                    ..Default::default()
                },
                AccountUsageWindow {
                    label: "week".to_owned(),
                    used_percent: 95.0,
                    resets_at: None,
                    ..Default::default()
                },
            ],
            updated_at: Some(now),
            ..AccountUsageView::default()
        };
        assert_eq!(usage_headroom_percent(&tight), Some(5.0));
        assert_eq!(usage_headroom_percent(&AccountUsageView::default()), None);
    }

    /// 격리 프로필을 쓰는 비활성 계정은 CLI가 그 저장소에서 토큰을 회전시킨다. 앱이
    /// 같은 사슬을 함께 돌리면 한쪽이 회전시킨 순간 다른 쪽 리프레시 토큰이 무효가
    /// 되고 갱신 엔드포인트가 429로 잠긴다. **단, 그 CLI가 실제로 돌고 있을 때만
    /// 그렇다.**
    ///
    /// 이 규칙은 한때 "격리 계정이면 언제나 CLI에 맡긴다"였는데, 그러면 그 계정으로
    /// 아무것도 돌지 않을 때 회전 주인이 아무도 없게 된다. 액세스 토큰이 만료된 뒤로
    /// 사용량이 영영 갱신되지 않고, 조회가 한 번도 성공하지 못해
    /// [`reconciled_auth_status_after_usage`]가 인증 상태를 `Ready`로 되돌릴 기회까지
    /// 사라진다. 실제로 계정 두 개가 그렇게 `error`로 굳었다.
    ///
    /// 실행 중이 아닐 때 앱이 회전시켜도 사슬은 갈리지 않는다.
    /// [`AccountSupervisor::commit_refreshed_claude_credential`]이 새 토큰을 프로필에도
    /// 미러링하고, 반대 방향은 조회 직전
    /// [`AccountSupervisor::sync_profile_credential`]이 볼트로 끌어온다.
    #[test]
    fn an_isolated_account_leaves_rotation_to_the_cli_while_its_runtime_runs() {
        // 그 계정으로 런타임이 도는 동안에는 CLI가 회전 주인이다.
        assert!(claude_refresh_deferral(true).is_some());
        // 도는 런타임이 없으면 맡길 CLI가 없으므로 앱이 회전시킨다.
        assert!(claude_refresh_deferral(false).is_none());
        // 활성 계정은 공유 저장소를 함께 갱신하므로 지금까지처럼 앱이 회전시킨다.
        assert!(claude_refresh_deferral(false).is_none());
    }

    /// 기본 계정 변경은 포인터 변경이다. 런타임이 돌고 있어도 기다리지 않고, 공유 CLI
    /// 홈에는 아무것도 쓰지 않는다 — 모든 계정은 자기 격리 프로필로 실행된다.
    #[test]
    fn a_default_account_change_does_not_wait_for_runtimes_or_touch_the_shared_home() {
        let (_data, home, supervisor, a, b) = two_account_supervisor_with_probe(ready_probe());
        let _lease = supervisor
            .acquire_runtime(ProviderId::Codex, Some(&a))
            .unwrap();

        let switched = supervisor.set_active(&b).unwrap();
        let provider = switched
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .unwrap();
        assert_eq!(provider.active_account_id.as_deref(), Some(b.as_str()));
        assert_eq!(provider.runtime_count, 1);
        let shared: Value =
            serde_json::from_slice(&fs::read(home.path().join(".codex/auth.json")).unwrap())
                .unwrap();
        assert_eq!(
            shared.pointer("/tokens/account_id").and_then(Value::as_str),
            Some("account-a")
        );
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
        assert!(snapshot.accounts[0].is_active);
        assert_eq!(snapshot.accounts[0].display_name, "추가 계정");
    }

    /// 로그인 프로필 경로는 로그인 CLI의 작업 경로이자 `CODEX_HOME` 값이 된다.
    /// Windows 확장 경로(`\\?\C:\…`)를 그대로 주면 npm 배치 셈(`codex.cmd`)을
    /// 도는 `cmd.exe`가 `UNC 경로는 지원되지 않습니다`로 물러난 뒤 `지정된 경로를 찾을
    /// 수 없습니다`로 끝나, 계정 추가가 `CLI 종료: 1`로 돌아왔다.
    #[test]
    fn login_profile_path_is_shaped_for_the_provider_cli() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let supervisor = AccountSupervisor::open_with(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();
        let login = supervisor.begin_login(ProviderId::Codex, None).unwrap();
        assert!(
            !login.profile_path.starts_with(r"\\?\"),
            "로그인 프로필 경로에 확장 경로 접두어가 남았습니다: {}",
            login.profile_path
        );
        assert!(PathBuf::from(&login.profile_path).is_dir());
        supervisor.cancel_login(&login.id).unwrap();
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
    fn g6_claude_reauthentication_uses_official_profile_when_local_identity_is_missing() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let vault = Arc::new(MemoryVault::default());
        let supervisor = AccountSupervisor::open_with_claude_identity_resolver(
            data.path(),
            home.path(),
            vault.clone(),
            Arc::new(|_| {
                Ok(AccountIdentity {
                    provider_account_id: "account-a".to_owned(),
                    legacy_provider_account_id: None,
                    email: Some("a@example.com".to_owned()),
                    organization: Some("organization-a".to_owned()),
                    display_name: Some("Account A".to_owned()),
                })
            }),
        )
        .unwrap();
        supervisor
            .upsert_captured_account(
                ProviderId::Claude,
                None,
                Some("Account A".to_owned()),
                captured_claude("account-a"),
            )
            .unwrap();
        let account_id = supervisor.snapshot().unwrap().accounts[0].id.clone();
        let login = supervisor
            .begin_login(ProviderId::Claude, Some(&account_id))
            .unwrap();
        let profile = PathBuf::from(&login.profile_path);
        let renewed = json!({
            "claudeAiOauth": {
                "accessToken": "renewed-access-token"
            }
        })
        .to_string();
        fs::write(profile.join(".credentials.json"), &renewed).unwrap();

        let snapshot = supervisor
            .finish_login(&login.id, Some("Account A 재인증".to_owned()))
            .unwrap();

        assert!(!profile.exists());
        assert_eq!(snapshot.accounts[0].auth_status, AccountAuthStatus::Ready);
        assert_eq!(snapshot.accounts[0].email.as_deref(), Some("a@example.com"));
        let saved = vault.get(&format!("claude:{account_id}")).unwrap();
        assert!(same_secret(&saved, &renewed));
    }

    #[test]
    fn claude_reauthentication_still_rejects_a_different_official_profile_identity() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let vault = Arc::new(MemoryVault::default());
        let supervisor = AccountSupervisor::open_with_claude_identity_resolver(
            data.path(),
            home.path(),
            vault.clone(),
            Arc::new(|_| {
                Ok(AccountIdentity {
                    provider_account_id: "account-b".to_owned(),
                    legacy_provider_account_id: None,
                    email: Some("b@example.com".to_owned()),
                    organization: None,
                    display_name: Some("Account B".to_owned()),
                })
            }),
        )
        .unwrap();
        supervisor
            .upsert_captured_account(
                ProviderId::Claude,
                None,
                Some("Account A".to_owned()),
                captured_claude("account-a"),
            )
            .unwrap();
        let account_id = supervisor.snapshot().unwrap().accounts[0].id.clone();
        let login = supervisor
            .begin_login(ProviderId::Claude, Some(&account_id))
            .unwrap();
        let profile = PathBuf::from(&login.profile_path);
        let renewed = json!({
            "claudeAiOauth": {
                "accessToken": "other-account-access-token"
            }
        })
        .to_string();
        fs::write(profile.join(".credentials.json"), renewed).unwrap();

        let error = supervisor.finish_login(&login.id, None).unwrap_err();

        assert_eq!(
            error.to_string(),
            "재인증 결과가 기존 계정 신원과 일치하지 않습니다"
        );
        assert!(profile.exists());
        let saved = vault.get(&format!("claude:{account_id}")).unwrap();
        assert!(same_secret(&saved, &claude_secret("account-a")));
        supervisor.cancel_login(&login.id).unwrap();
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
            .upsert_captured_account(ProviderId::Codex, None, None, legacy)
            .unwrap();
        {
            let mut state = supervisor.inner.state.lock().unwrap();
            state.registry.accounts[0].usage = AccountUsageView {
                status: AccountUsageStatus::Ok,
                windows: vec![AccountUsageWindow {
                    label: "5시간".to_owned(),
                    used_percent: 43.0,
                    resets_at: None,
                    ..Default::default()
                }],
                updated_at: Some(now_ms()),
                ..Default::default()
            };
        }

        supervisor
            .upsert_captured_account(
                ProviderId::Codex,
                None,
                None,
                captured_codex_user("shared-workspace", "user-reviewer", "reviewer@example.com"),
            )
            .unwrap();

        let snapshot = supervisor.snapshot().unwrap();
        assert_eq!(snapshot.accounts.len(), 1);
        assert_ne!(snapshot.accounts[0].provider_account_id, "shared-workspace");
        assert_eq!(snapshot.accounts[0].usage, AccountUsageView::default());
    }

    #[test]
    fn account_lifecycle_enforces_reauth_disable_delete_and_runtime_guards() {
        let (_data, _home, supervisor, a, b) = two_account_supervisor_with_probe(ready_probe());
        assert!(supervisor
            .upsert_captured_account(
                ProviderId::Codex,
                Some(&b),
                None,
                captured_codex("different-account")
            )
            .is_err());
        supervisor
            .upsert_captured_account(
                ProviderId::Codex,
                Some(&b),
                Some("B 재인증".to_owned()),
                captured_codex("account-b"),
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
            .acquire_runtime(ProviderId::Codex, Some(&b))
            .is_err());
        supervisor.set_disabled(&b, false).unwrap();
        assert!(supervisor.delete_account(&b, true).is_err());
        // 기본 계정은 삭제할 수 없고, 런타임이 붙은 계정도 삭제할 수 없다. 다른 계정의
        // 런타임은 삭제를 막지 않는다 — 자격증명이 계정별로 갈려 있다.
        assert!(supervisor.delete_account(&a, false).is_err());
        let lease = supervisor
            .acquire_runtime(ProviderId::Codex, Some(&b))
            .unwrap();
        assert!(supervisor.delete_account(&b, false).is_err());
        supervisor
            .upsert_captured_account(
                ProviderId::Codex,
                Some(&a),
                None,
                captured_codex("account-a"),
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
                .active_account_id
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

    fn account_view<'a>(
        snapshot: &'a AccountSnapshot,
        account_id: &str,
    ) -> &'a ProviderAccountView {
        snapshot
            .accounts
            .iter()
            .find(|account| account.id == account_id)
            .unwrap()
    }

    #[test]
    fn account_label_overrides_the_display_name_without_losing_the_provider_name() {
        let (data, _home, supervisor, a, b) = two_account_supervisor();
        let before = supervisor.snapshot().unwrap();
        let provider_name = account_view(&before, &b).provider_display_name.clone();
        assert_eq!(account_view(&before, &b).label, None);
        assert_eq!(account_view(&before, &b).display_name, provider_name);

        // 줄바꿈과 연속 공백은 한 줄로 접어 저장하고, 다른 계정은 건드리지 않는다.
        let saved = supervisor.set_label(&b, Some("  결제\n 담당  ")).unwrap();
        assert_eq!(account_view(&saved, &b).label.as_deref(), Some("결제 담당"));
        assert_eq!(account_view(&saved, &b).display_name, "결제 담당");
        // 공급자가 알려 준 이름은 그대로 남아 무엇을 덮어썼는지 알 수 있다.
        assert_eq!(
            account_view(&saved, &b).provider_display_name,
            provider_name
        );
        assert_eq!(account_view(&saved, &a).label, None);

        let reloaded = load_registry(data.path()).unwrap();
        assert_eq!(
            reloaded
                .accounts
                .iter()
                .find(|account| account.id == b)
                .unwrap()
                .label
                .as_deref(),
            Some("결제 담당")
        );
    }

    #[test]
    fn empty_account_label_restores_the_provider_name() {
        let (_data, _home, supervisor, _a, b) = two_account_supervisor();
        let provider_name = account_view(&supervisor.snapshot().unwrap(), &b)
            .provider_display_name
            .clone();
        supervisor.set_label(&b, Some("임시 이름")).unwrap();
        for cleared in [None, Some(""), Some("   ")] {
            let snapshot = supervisor.set_label(&b, cleared).unwrap();
            assert_eq!(account_view(&snapshot, &b).label, None, "{cleared:?}");
            assert_eq!(
                account_view(&snapshot, &b).display_name,
                provider_name,
                "{cleared:?}"
            );
            supervisor.set_label(&b, Some("임시 이름")).unwrap();
        }
    }

    #[test]
    fn account_label_length_is_capped_and_over_length_input_is_rejected() {
        let (_data, _home, supervisor, _a, b) = two_account_supervisor();
        let longest = "가".repeat(ACCOUNT_LABEL_MAX_CHARS);
        supervisor.set_label(&b, Some(&longest)).unwrap();
        assert_eq!(
            account_view(&supervisor.snapshot().unwrap(), &b)
                .label
                .as_deref(),
            Some(longest.as_str())
        );

        let too_long = "가".repeat(ACCOUNT_LABEL_MAX_CHARS + 1);
        assert!(matches!(
            supervisor.set_label(&b, Some(&too_long)),
            Err(CoreError::InvalidInput(_))
        ));
        // 거절된 입력은 저장된 값을 바꾸지 않는다.
        assert_eq!(
            account_view(&supervisor.snapshot().unwrap(), &b)
                .label
                .as_deref(),
            Some(longest.as_str())
        );
    }

    #[test]
    fn account_record_without_label_field_deserializes_to_none() {
        let record: AccountRecord = serde_json::from_value(serde_json::json!({
            "id": "claude-legacy",
            "provider": "claude",
            "displayName": "테스트 사용자",
            "email": "user@example.com",
            "organization": null,
            "providerAccountId": "acct-legacy",
            "disabled": false,
            "authStatus": "ready",
            "usage": AccountUsageView::default(),
            "createdAt": 0,
            "updatedAt": 0,
        }))
        .unwrap();
        assert_eq!(record.label, None);
    }

    fn account_note(snapshot: &AccountSnapshot, account_id: &str) -> Option<String> {
        snapshot
            .accounts
            .iter()
            .find(|account| account.id == account_id)
            .unwrap()
            .note
            .clone()
    }

    #[test]
    fn account_note_is_saved_per_account_and_survives_a_registry_reload() {
        let (data, _home, supervisor, a, b) = two_account_supervisor();
        assert_eq!(account_note(&supervisor.snapshot().unwrap(), &a), None);

        let saved = supervisor.set_note(&b, Some("  결제 담당 계정  ")).unwrap();
        // 앞뒤 공백은 정리해 저장하고 다른 계정에는 영향을 주지 않는다.
        assert_eq!(account_note(&saved, &b).as_deref(), Some("결제 담당 계정"));
        assert_eq!(account_note(&saved, &a), None);

        let reloaded = load_registry(data.path()).unwrap();
        assert_eq!(
            reloaded
                .accounts
                .iter()
                .find(|account| account.id == b)
                .unwrap()
                .note
                .as_deref(),
            Some("결제 담당 계정")
        );

        // 기본 계정 전환처럼 다른 레지스트리 변경을 거쳐도 메모는 계정 ID에 남는다.
        supervisor.set_default(&b).unwrap();
        assert_eq!(
            account_note(&supervisor.snapshot().unwrap(), &b).as_deref(),
            Some("결제 담당 계정")
        );
    }

    #[test]
    fn empty_account_note_clears_the_stored_value() {
        let (data, _home, supervisor, _a, b) = two_account_supervisor();
        supervisor.set_note(&b, Some("임시 메모")).unwrap();

        for cleared in [Some("   "), Some(""), None] {
            supervisor.set_note(&b, cleared).unwrap();
            assert_eq!(account_note(&supervisor.snapshot().unwrap(), &b), None);
            assert_eq!(
                load_registry(data.path())
                    .unwrap()
                    .accounts
                    .iter()
                    .find(|account| account.id == b)
                    .unwrap()
                    .note,
                None
            );
            supervisor.set_note(&b, Some("임시 메모")).unwrap();
        }
    }

    #[test]
    fn account_note_length_is_capped_and_over_length_input_is_rejected() {
        let (_data, _home, supervisor, _a, b) = two_account_supervisor();
        let longest = "가".repeat(ACCOUNT_NOTE_MAX_CHARS);
        supervisor.set_note(&b, Some(&longest)).unwrap();
        assert_eq!(
            account_note(&supervisor.snapshot().unwrap(), &b).as_deref(),
            Some(longest.as_str())
        );

        let too_long = "가".repeat(ACCOUNT_NOTE_MAX_CHARS + 1);
        assert!(matches!(
            supervisor.set_note(&b, Some(&too_long)),
            Err(CoreError::InvalidInput(_))
        ));
        // 거부된 저장은 기존 메모를 바꾸지 않는다.
        assert_eq!(
            account_note(&supervisor.snapshot().unwrap(), &b).as_deref(),
            Some(longest.as_str())
        );
        assert!(supervisor.set_note("codex-unknown", Some("메모")).is_err());
    }

    #[test]
    fn deleting_an_account_removes_its_note() {
        let (data, _home, supervisor, _a, b) = two_account_supervisor();
        supervisor.set_note(&b, Some("삭제될 메모")).unwrap();
        supervisor.delete_account(&b, false).unwrap();
        let reloaded = load_registry(data.path()).unwrap();
        assert!(reloaded.accounts.iter().all(|account| account.id != b));
        assert!(!serde_json::to_string(&reloaded)
            .unwrap()
            .contains("삭제될 메모"));
    }

    #[test]
    fn account_record_without_note_field_deserializes_to_none() {
        let json = r#"{"id":"acc","provider":"codex","displayName":"A","email":null,"organization":null,"providerAccountId":"account-a","disabled":false,"authStatus":"ready","usage":{"status":"idle","windows":[],"updatedAt":null,"error":null},"createdAt":0,"updatedAt":0}"#;
        let record: AccountRecord = serde_json::from_str(json).unwrap();
        assert_eq!(record.note, None);
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
            auto_switch_priority: None,
            auth_status: AccountAuthStatus::Ready,
            usage,
            note: None,
            label: None,
            credential_expires_at: None,
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
                ..Default::default()
            }],
            updated_at: Some(0),
            ..Default::default()
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
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "a",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("f".to_owned())
        );
        // 마지막 계정이 활성이면 처음으로 감아 순환한다.
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "f",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("a".to_owned())
        );
        // 리셋 시각이 지난 한도 도달 계정은 다시 후보가 된다.
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "a",
                &no_purpose(),
                now + 120_000,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("b".to_owned())
        );
        let only_active = vec![auto_switch_record("a", true, AccountUsageView::default())];
        assert_eq!(
            select_auto_switch_target(
                &only_active,
                ProviderId::Codex,
                "a",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            None
        );
    }

    /// 무엇을 하려던 참인지 모르는 사용량 트리거의 전환 목적.
    fn no_purpose() -> SwitchPurpose<'static> {
        SwitchPurpose {
            models: &[],
            reason: AutoSwitchReason::UsageExhausted,
            intent: SwitchIntent::Rebind,
        }
    }

    /// 모델군마다 쿼터가 따로인 계정. 대표 창은 빡빡한 모델군의 복사본이다.
    fn model_group_account(id: &str, gemini: f64, third_party: f64) -> AccountRecord {
        let window = |label: &str, used: f64, scoped: bool, aggregate: bool| AccountUsageWindow {
            label: label.to_owned(),
            used_percent: used,
            resets_at: (used >= 100.0).then_some(i64::MAX),
            model_scoped: scoped,
            aggregate,
        };
        let usage = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![
                window("7일", gemini.max(third_party), false, true),
                window("Gemini Models · 7일", gemini, true, false),
                window("Claude and GPT models · 7일", third_party, true, false),
            ],
            updated_at: Some(0),
            ..Default::default()
        };
        AccountRecord {
            provider: ProviderId::Antigravity,
            ..auto_switch_record(id, true, usage)
        }
    }

    /// 전환은 막힌 **모델군**을 쓸 수 있는 계정으로 가야 한다. 계정 전체 판정만 보면 같은
    /// 모델군이 똑같이 찬 계정으로 옮기고, 옮긴 실행은 모델군을 아는 게이트가 다시 거부하며
    /// 쿨다운이 두 번째 전환을 막아 한 회차가 통째로 갇힌다.
    #[test]
    fn auto_switch_target_serves_the_model_group_that_was_blocked() {
        let now = 1_000_000;
        let accounts = vec![
            // 활성 계정: Gemini가 찼다.
            model_group_account("a", 100.0, 10.0),
            // Gemini가 똑같이 찬 계정 — 옮겨 봐야 같은 자리다.
            model_group_account("b", 100.0, 0.0),
            // Gemini가 남아 있는 계정.
            model_group_account("c", 20.0, 90.0),
        ];
        for policy in [
            AutoSwitchPolicy::Registration,
            AutoSwitchPolicy::Priority,
            AutoSwitchPolicy::MaxHeadroom,
        ] {
            assert_eq!(
                select_auto_switch_target(
                    &accounts,
                    ProviderId::Antigravity,
                    "a",
                    &no_purpose(),
                    now,
                    policy,
                    None
                ),
                Some("c".to_owned()),
                "{policy:?}"
            );
        }

        // 여유 정책은 막힌 모델군의 여유로 줄을 세운다. 계정 대표 여유로 보면 Claude/GPT가
        // 90%인 c(대표 여유 10%)가 Gemini 80%인 d(대표 여유 20%)에 밀리지만, 이번에 옮겨야
        // 하는 것은 Gemini 회차다.
        let mut with_d = accounts.clone();
        with_d.push(model_group_account("d", 80.0, 0.0));
        assert_eq!(
            select_auto_switch_target(
                &with_d,
                ProviderId::Antigravity,
                "a",
                &no_purpose(),
                now,
                AutoSwitchPolicy::MaxHeadroom,
                None,
            ),
            Some("c".to_owned())
        );

        // 막힌 모델군을 가릴 수 없으면(모델군 쿼터가 아닌 공급자) 종전 그대로 계정 전체
        // 판정으로 고른다.
        let codex = vec![
            auto_switch_record("a", true, exhausted_usage(Some(now + 60_000))),
            auto_switch_record("b", true, AccountUsageView::default()),
        ];
        assert_eq!(
            select_auto_switch_target(
                &codex,
                ProviderId::Codex,
                "a",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("b".to_owned())
        );
    }

    /// 상보적으로 소진된 두 계정은 서로를 고르지 않는다. 모델을 모르는 전환에서 한쪽만
    /// 나아지고 다른 쪽이 나빠지는 자리로 옮기면, 사용량 폴링마다 상대에게 넘기고 되받으며
    /// 세션을 다시 묶는다(쿨다운 60초는 5분 폴링 주기를 막지 못한다).
    #[test]
    fn complementary_exhaustion_does_not_hand_the_account_back_and_forth() {
        let now = 1_000_000;
        // A는 Gemini가 막혔고 C는 Claude·GPT가 막혔다.
        let swap = vec![
            model_group_account("a", 100.0, 30.0),
            model_group_account("c", 20.0, 100.0),
        ];
        for (from, to) in [("a", "c"), ("c", "a")] {
            assert_eq!(
                select_auto_switch_target(
                    &swap,
                    ProviderId::Antigravity,
                    from,
                    &no_purpose(),
                    now,
                    AutoSwitchPolicy::Registration,
                    None,
                ),
                None,
                "{from} → {to}는 한쪽을 잃는 자리다"
            );
        }

        // 기본 계정 회전은 그대로 일어난다 — 멀쩡한 계정이 놀고 있는데 소진된 계정에
        // 묶여 있으면 그 계정을 쓰는 회차가 통째로 멈춘다.
        let healthy = vec![
            model_group_account("a", 100.0, 100.0),
            model_group_account("c", 10.0, 10.0),
        ];
        assert_eq!(
            select_auto_switch_target(
                &healthy,
                ProviderId::Antigravity,
                "a",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("c".to_owned())
        );

        // 모델이 실려 오면 목적이 분명하므로 그 모델군만 본다 — 다른 모델군을 잃더라도
        // 지금 막힌 쪽을 쓸 수 있는 계정으로 간다.
        assert_eq!(
            select_auto_switch_target(
                &swap,
                ProviderId::Antigravity,
                "a",
                &SwitchPurpose {
                    models: &["gemini-3.8-flash-high".to_owned()],
                    reason: AutoSwitchReason::AgentLimited,
                    intent: SwitchIntent::Rebind,
                },
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("c".to_owned())
        );
    }

    /// 옮겨 갈 실행들의 모델이 후보 자격을 정한다. 같은 사용량이라도 붙은 세션이 Gemini면
    /// Gemini가 남은 계정으로 가고, Claude·GPT면 아직 멀쩡한 자리라 옮기지 않는다.
    #[test]
    fn bound_session_models_decide_which_group_must_survive() {
        let now = 1_000_000;
        // a는 Gemini가 막혔고 c는 Claude·GPT가 막혔다.
        let accounts = vec![
            model_group_account("a", 100.0, 30.0),
            model_group_account("c", 20.0, 100.0),
        ];
        let pick = |models: &[String]| {
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &SwitchPurpose {
                    models,
                    reason: AutoSwitchReason::UsageExhausted,
                    intent: SwitchIntent::Rebind,
                },
                now,
                AutoSwitchPolicy::Registration,
                None,
            )
        };
        // Gemini 세션이 묶여 있다 — 막힌 쪽이 필요하니 Gemini가 남은 c로 간다. c의 Claude·GPT가
        // 막힌 것은 이 세션들과 상관없다.
        assert_eq!(
            pick(&["gemini-3.8-flash-high".to_owned()]),
            Some("c".to_owned())
        );
        // Claude 세션만 묶여 있다 — a에서 아직 멀쩡히 돌고 있고 c로 가면 막히므로 옮기지 않는다.
        assert_eq!(pick(&["claude-opus-4-6-thinking".to_owned()]), None);
        // 둘 다 묶여 있다 — Gemini는 살려야 하고 Claude·GPT는 잃으면 안 되는데 c는 둘을 다
        // 못 채운다.
        assert_eq!(
            pick(&[
                "gemini-3.8-flash-high".to_owned(),
                "claude-opus-4-6-thinking".to_owned(),
            ]),
            None
        );
    }

    /// 한도 응답인데 모델군을 가릴 수 없으면(모델 미상·카탈로그에 없는 이름) 막힌 실행이
    /// 확실히 있는 쪽을 택한다 — 열린 모델군을 지키느라 유일한 목적지를 버리면 그 세션은
    /// 주간 리셋까지 선다.
    #[test]
    fn an_agent_limit_with_an_unknown_model_still_moves_somewhere_alive() {
        let now = 1_000_000;
        let accounts = vec![
            model_group_account("a", 10.0, 90.0),
            model_group_account("b", 100.0, 20.0),
        ];
        for models in [Vec::new(), vec!["auto".to_owned()]] {
            assert_eq!(
                select_auto_switch_target(
                    &accounts,
                    ProviderId::Antigravity,
                    "a",
                    &SwitchPurpose {
                        models: &models,
                        reason: AutoSwitchReason::AgentLimited,
                        intent: SwitchIntent::Rebind,
                    },
                    now,
                    AutoSwitchPolicy::Registration,
                    None,
                ),
                Some("b".to_owned()),
                "{models:?}"
            );
        }
    }

    /// 상보적인 후보를 건너뛰고 뒤에 있는 멀쩡한 계정을 고른다. 첫 후보에서 멈추거나 막힌
    /// 모델군만 보고 줄을 세우면 b를 고르거나 아무도 못 고른다.
    #[test]
    fn a_complementary_candidate_is_skipped_for_a_healthy_one_behind_it() {
        let now = 1_000_000;
        let accounts = vec![
            model_group_account("a", 100.0, 30.0),
            model_group_account("b", 20.0, 100.0),
            model_group_account("c", 10.0, 10.0),
        ];
        for policy in [
            AutoSwitchPolicy::Registration,
            AutoSwitchPolicy::Priority,
            AutoSwitchPolicy::MaxHeadroom,
        ] {
            assert_eq!(
                select_auto_switch_target(
                    &accounts,
                    ProviderId::Antigravity,
                    "a",
                    &no_purpose(),
                    now,
                    policy,
                    None,
                ),
                Some("c".to_owned()),
                "{policy:?}"
            );
        }
    }

    /// 신호가 모델을 싣고 오면 그 모델군이 이번 전환의 이유다. 사용량에서 거꾸로 짚는 것은
    /// 한 박자 늦다 — 한도 응답 직후에는 그 모델군이 아직 100%로 보이지 않아, 사용량만 보면
    /// 막힌 모델군을 못 가리고 계정 전체 판정으로 떨어진다.
    #[test]
    fn a_signalled_model_picks_the_group_before_the_usage_catches_up() {
        let now = 1_000_000;
        let accounts = vec![
            // 활성 계정: Claude/GPT로 한도를 받았지만 조회가 아직 그 값을 채우지 못했다.
            model_group_account("a", 10.0, 90.0),
            // Claude/GPT는 넉넉하지만 Gemini가 다 찬 계정.
            model_group_account("b", 100.0, 20.0),
        ];
        // 사용량만 보면 막힌 모델군이 없다(100%인 창이 없다). 그러면 두 모델군을 다 지키려
        // 들고, Gemini를 잃는 b는 후보가 되지 못해 아무 데도 가지 못한다.
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            None
        );
        // 신호가 모델을 실으면 목적이 분명해진다 — 지금 막힌 Claude/GPT를 쓸 수 있는 곳으로
        // 가고, 그 대가로 Gemini를 잃는 것은 감수한다.
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &SwitchPurpose {
                    models: &["claude-opus-4-6-thinking".to_owned()],
                    reason: AutoSwitchReason::AgentLimited,
                    intent: SwitchIntent::Rebind,
                },
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("b".to_owned())
        );
        // 모델군 쿼터를 쓰지 않는 공급자에서는 모델이 실려도 판정이 바뀌지 않는다.
        let codex = vec![
            auto_switch_record("a", true, usage_at(90.0)),
            auto_switch_record("b", true, usage_at(10.0)),
        ];
        assert_eq!(
            select_auto_switch_target(
                &codex,
                ProviderId::Codex,
                "a",
                &SwitchPurpose {
                    models: &["gpt-5.6-sol".to_owned()],
                    reason: AutoSwitchReason::AgentLimited,
                    intent: SwitchIntent::Rebind,
                },
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("b".to_owned())
        );
    }

    /// 한도 응답은 그 모델군이 막혔다는 증거다. 뒤따르는 사용량 조회가 끝나기 전이라 창은
    /// 아직 90%를 가리키지만, 여유 순위는 그 모델군으로 매겨야 한다 — 계정 대표 창으로
    /// 매기면 막힌 실행을 그 모델군이 20% 남은 계정에 앉힌다.
    #[test]
    fn a_limit_response_ranks_candidates_by_the_limited_group_before_usage_catches_up() {
        let now = 1_000_000;
        let accounts = vec![
            model_group_account("a", 10.0, 90.0),
            // Claude·GPT가 비어 있지만 Gemini가 90%라 대표 여유는 10%.
            model_group_account("b", 90.0, 0.0),
            // Claude·GPT가 80%지만 대표 여유는 20%.
            model_group_account("c", 10.0, 80.0),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &SwitchPurpose {
                    models: &["claude-opus-4-6-thinking".to_owned()],
                    reason: AutoSwitchReason::AgentLimited,
                    intent: SwitchIntent::Rebind,
                },
                now,
                AutoSwitchPolicy::MaxHeadroom,
                None,
            ),
            Some("b".to_owned())
        );
    }

    /// 묶인 세션들이 쓰는 모델군이 하나도 막히지 않았으면 옮길 이유가 없다. 멀쩡한 계정이
    /// 있어도 도중인 턴을 끊어 다시 묶지 않는다.
    #[test]
    fn sessions_whose_groups_are_all_open_are_not_moved_even_to_a_healthy_account() {
        let now = 1_000_000;
        let accounts = vec![
            // Gemini는 막혔지만 묶인 세션은 Claude·GPT만 쓴다.
            model_group_account("a", 100.0, 30.0),
            model_group_account("d", 10.0, 10.0),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &SwitchPurpose {
                    models: &["claude-opus-4-6-thinking".to_owned()],
                    reason: AutoSwitchReason::UsageExhausted,
                    intent: SwitchIntent::Rebind,
                },
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            None
        );
    }

    /// 모델군을 가릴 수 없는 한도 응답은 먼저 열린 모델군을 잃지 않는 자리를 찾고, 그런 자리가
    /// 없을 때만 어디든 살아 있는 곳으로 간다. 한 번에 풀면 등록 순 첫 후보가 막힌 실행이 쓸
    /// 모델군까지 찬 계정일 수 있다.
    #[test]
    fn an_unknown_model_limit_prefers_a_candidate_that_keeps_every_open_group() {
        let now = 1_000_000;
        let accounts = vec![
            model_group_account("a", 10.0, 90.0),
            model_group_account("b", 100.0, 20.0),
            model_group_account("d", 40.0, 60.0),
        ];
        let purpose = SwitchPurpose {
            models: &["auto".to_owned()],
            reason: AutoSwitchReason::AgentLimited,
            intent: SwitchIntent::Rebind,
        };
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &purpose,
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("d".to_owned()),
            "b는 Gemini를 잃는 자리라 d를 먼저 본다"
        );
        // d가 없으면 그때 b로 간다 — 세워 두는 것보다 낫다.
        assert_eq!(
            select_auto_switch_target(
                &accounts[..2],
                ProviderId::Antigravity,
                "a",
                &purpose,
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("b".to_owned())
        );
    }

    /// 분산 교체는 소진이 아니라 균형이 목적이다. 유휴 세션들의 모델을 알아도 "막힌 것이
    /// 없으니 옮기지 않는다"로 떨어지면 안 되고, 그 모델군을 잃지 않는 자리 중 격차 조건을
    /// 만족하는 계정으로 간다.
    #[test]
    fn usage_spread_still_rebalances_when_the_idle_sessions_name_their_model() {
        let now = 1_000_000;
        let accounts = vec![
            model_group_account("a", 50.0, 10.0),
            model_group_account("b", 10.0, 10.0),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &SwitchPurpose {
                    models: &["gemini-3.8-flash-high".to_owned()],
                    reason: AutoSwitchReason::UsageSpread,
                    intent: SwitchIntent::Rebind,
                },
                now,
                AutoSwitchPolicy::Registration,
                Some(20.0),
            ),
            Some("b".to_owned())
        );
    }

    /// 지정 계정이 창을 아직 보고하지 않았어도(새로 등록한 계정) 한도 응답의 모델은 목적을
    /// 잃지 않는다 — 후보 쪽 창을 모델로 가려, 그 모델군이 다 찬 계정은 뺀다.
    #[test]
    fn a_limit_response_keeps_its_model_when_the_limited_account_has_no_windows() {
        let now = 1_000_000;
        let mut fresh = auto_switch_record("a", true, AccountUsageView::default());
        fresh.provider = ProviderId::Antigravity;
        let accounts = vec![
            fresh,
            // 등록 순 첫 후보인데 Claude·GPT가 다 찼다.
            model_group_account("b", 20.0, 100.0),
            model_group_account("c", 20.0, 20.0),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &SwitchPurpose {
                    models: &["claude-opus-4-6-thinking".to_owned()],
                    reason: AutoSwitchReason::AgentLimited,
                    intent: SwitchIntent::Rebind,
                },
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("c".to_owned())
        );
    }

    /// 기본 계정 회전은 세션 재바인딩과 다른 질문이다. 한도 응답이 모델군을 못 가려도 회전은
    /// "어디든 살아 있는 곳으로" 완화하지 않는다 — Gemini 실행을 살리려는 신호가 Claude·GPT가
    /// 다 찬 계정을 기본으로 앉히면 그 뒤의 Claude 대화가 전부 막힌 계정에서 열린다.
    #[test]
    fn default_rotation_never_relaxes_the_open_group_guard() {
        let now = 1_000_000;
        let accounts = vec![
            model_group_account("a", 100.0, 30.0),
            model_group_account("c", 20.0, 100.0),
        ];
        let rebind = SwitchPurpose {
            models: &[],
            reason: AutoSwitchReason::AgentLimited,
            intent: SwitchIntent::Rebind,
        };
        let rotation = SwitchPurpose {
            intent: SwitchIntent::DefaultRotation,
            ..rebind
        };
        // 재바인딩 목적(완화 허용): 막힌 실행이 있으니 c로라도 간다.
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &rebind,
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("c".to_owned())
        );
        // 회전 목적(완화 없음): c는 Claude·GPT를 잃는 자리라 기본 계정은 a에 남는다.
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &rotation,
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            None
        );
    }

    /// 기본 계정 회전도 한도에 걸린 실행의 모델은 안전망으로 든다. 지정 계정이 창을 보고한 적
    /// 없어 모델군을 못 가려도, 그 모델의 창이 막힌 계정을 기본으로 앉히지 않는다 — 앉히면
    /// 그 모델의 새 대화가 전부 막힌 계정에서 열리고 쿨다운이 되돌리기를 막는다.
    #[test]
    fn default_rotation_keeps_the_limited_model_as_a_safety_net() {
        let now = 1_000_000;
        let mut fresh = auto_switch_record("a", true, AccountUsageView::default());
        fresh.provider = ProviderId::Antigravity;
        let accounts = vec![
            fresh,
            // 등록 순 첫 후보인데 Gemini가 다 찼다(대표 창은 100%가 아니다).
            model_group_account("b", 100.0, 20.0),
            model_group_account("c", 20.0, 20.0),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &SwitchPurpose {
                    models: &["gemini-3.8-flash-high".to_owned()],
                    reason: AutoSwitchReason::AgentLimited,
                    intent: SwitchIntent::DefaultRotation,
                },
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("c".to_owned())
        );
    }

    /// 두 질문은 한 번에, 한 잠금 안에서 답한다. 옮길 세션이 없으면 재바인딩은 묻지 않고,
    /// 지정 계정이 기본 계정이 아니면 회전은 묻지 않는다.
    #[test]
    fn both_switch_questions_are_answered_together() {
        let (_data, _home, supervisor, a, b) = two_account_supervisor();
        supervisor.set_auto_switch(&a, true).unwrap();
        supervisor.set_auto_switch(&b, true).unwrap();
        let active = supervisor
            .active_account_id(ProviderId::Codex)
            .unwrap()
            .expect("기본 계정");
        let other = if active == a { b.clone() } else { a.clone() };
        let signal = |account: &str| AutoSwitchSignal {
            provider: ProviderId::Codex,
            account_id: account.to_owned(),
            reason: AutoSwitchReason::AgentLimited,
            chat_id: None,
            models: Vec::new(),
        };
        // 기본 계정의 신호: 세션이 없으면 회전만.
        let plan = supervisor
            .plan_auto_switches(&signal(&active), None)
            .unwrap();
        assert_eq!(plan.rebind_target, None);
        assert_eq!(plan.rotate_target, Some(other.clone()));
        // 세션이 있으면 둘 다.
        let plan = supervisor
            .plan_auto_switches(&signal(&active), Some(&[]))
            .unwrap();
        assert_eq!(plan.rebind_target, Some(other.clone()));
        assert_eq!(plan.rotate_target, Some(other.clone()));
        // 기본 계정이 아닌 계정의 신호는 회전을 묻지 않는다.
        let plan = supervisor
            .plan_auto_switches(&signal(&other), Some(&[]))
            .unwrap();
        assert_eq!(plan.rebind_target, Some(active.clone()));
        assert_eq!(plan.rotate_target, None);
    }

    /// 지정 계정의 모델군이 둘 다 찼으면 이번 전환이 어느 쪽을 위한 것인지 알 수 없다.
    /// 그때 막힌 모델군을 전부 요구하면 한쪽만 비어 있는 계정을 버리게 된다 — 그 계정에서
    /// 비어 있는 모델군 회차는 실제로 돈다.
    #[test]
    fn a_candidate_serving_one_of_several_blocked_groups_is_still_a_target() {
        let now = 1_000_000;
        let accounts = vec![
            // 활성 계정: 두 모델군이 모두 찼다.
            model_group_account("a", 100.0, 100.0),
            // Gemini만 남은 계정. 옮기면 Gemini 회차는 돈다.
            model_group_account("b", 30.0, 100.0),
            // Claude/GPT가 더 많이 남은 계정.
            model_group_account("c", 100.0, 10.0),
        ];
        for policy in [AutoSwitchPolicy::Registration, AutoSwitchPolicy::Priority] {
            assert_eq!(
                select_auto_switch_target(
                    &accounts,
                    ProviderId::Antigravity,
                    "a",
                    &no_purpose(),
                    now,
                    policy,
                    None
                ),
                Some("b".to_owned()),
                "{policy:?}"
            );
        }
        // 여유 정책은 살아 있는 모델군의 여유로 고른다 — c의 Claude/GPT 90%p가 b의 Gemini
        // 70%p보다 넉넉하다. 막힌 모델군 중 빡빡한 쪽을 값으로 삼으면 둘 다 여유 0이 되어
        // 등록 순으로 떨어졌다.
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Antigravity,
                "a",
                &no_purpose(),
                now,
                AutoSwitchPolicy::MaxHeadroom,
                None,
            ),
            Some("c".to_owned())
        );
        // 두 모델군이 모두 찬 계정은 여전히 후보가 아니다.
        let all_gone = vec![
            model_group_account("a", 100.0, 100.0),
            model_group_account("b", 100.0, 100.0),
        ];
        assert_eq!(
            select_auto_switch_target(
                &all_gone,
                ProviderId::Antigravity,
                "a",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            None
        );
    }

    fn usage_at(percent: f64) -> AccountUsageView {
        AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "5h".to_owned(),
                used_percent: percent,
                resets_at: None,
                ..Default::default()
            }],
            updated_at: Some(0),
            ..AccountUsageView::default()
        }
    }

    #[test]
    fn preserved_usage_picks_a_failover_target_when_a_fresh_reading_is_missing() {
        let now = 1_000_000;
        let window = |percent: f64| AccountUsageWindow {
            label: "7일".to_owned(),
            used_percent: percent,
            resets_at: None,
            ..Default::default()
        };
        let fresh = |percent: f64| AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![window(percent)],
            updated_at: Some(now),
            ..AccountUsageView::default()
        };
        // 조회는 실패했지만 `apply_usage_stale_policy`가 마지막 수치를 남긴 상태.
        let preserved = |percent: f64| AccountUsageView {
            status: AccountUsageStatus::Error,
            windows: vec![window(percent)],
            updated_at: Some(now),
            error: Some("조회 토큰 만료".to_owned()),
            ..AccountUsageView::default()
        };

        // 신선한 값을 아는 계정이 먼저다. 보존값이 더 좋아 보여도 앞서지 않는다.
        let accounts = vec![
            auto_switch_record("active", true, fresh(99.0)),
            auto_switch_record("preserved-roomy", true, preserved(5.0)),
            auto_switch_record("fresh-tight", true, fresh(70.0)),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::MaxHeadroom,
                None,
            )
            .as_deref(),
            Some("fresh-tight")
        );

        // 신선한 값이 아무 데도 없으면 보존값으로 고른다. 예전에는 전부 "여유 미상"이
        // 되어 등록 순 첫 계정이 뽑혔다.
        let accounts = vec![
            auto_switch_record("active", true, fresh(99.0)),
            auto_switch_record("preserved-tight", true, preserved(80.0)),
            auto_switch_record("preserved-roomy", true, preserved(5.0)),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::MaxHeadroom,
                None,
            )
            .as_deref(),
            Some("preserved-roomy")
        );

        // 수치가 아예 없는 계정은 보존값을 가진 계정보다 뒤다.
        let accounts = vec![
            auto_switch_record("active", true, fresh(99.0)),
            auto_switch_record("unknown", true, AccountUsageView::default()),
            auto_switch_record("preserved", true, preserved(60.0)),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::MaxHeadroom,
                None,
            )
            .as_deref(),
            Some("preserved")
        );
    }

    #[test]
    fn usage_used_percent_uses_the_tightest_window_and_ignores_failed_readings() {
        let usage = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![
                AccountUsageWindow {
                    label: "weekly".to_owned(),
                    used_percent: 5.0,
                    resets_at: None,
                    ..Default::default()
                },
                AccountUsageWindow {
                    label: "5h".to_owned(),
                    used_percent: 35.0,
                    resets_at: None,
                    ..Default::default()
                },
            ],
            updated_at: Some(0),
            ..AccountUsageView::default()
        };
        assert_eq!(usage_used_percent(&usage), Some(35.0));
        // 조회에 실패해 이전 창이 보존된 수치로는 격차를 재지 않는다.
        // `apply_usage_stale_policy`가 붙여 둔 값이라 지금 사용량이라고 볼 수 없다.
        let stale = AccountUsageView {
            status: AccountUsageStatus::Error,
            ..usage
        };
        assert_eq!(usage_used_percent(&stale), None);
        assert_eq!(usage_used_percent(&AccountUsageView::default()), None);
    }

    #[test]
    fn registry_reads_the_usage_gap_saved_under_the_old_threshold_name() {
        // 이 설정은 절대 사용률 임계치로 먼저 나갔다가 계정 간 격차로 뜻이 바뀌었다.
        // 뜻은 달라졌어도 사용자가 고른 폭은 그대로 이어야 한다.
        let legacy = serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "autoSwitchUsageThresholdPercent": 30,
            "accounts": [],
            "providers": [],
        });
        let registry: AccountRegistry = serde_json::from_value(legacy).expect("이전 레지스트리");
        assert_eq!(registry.auto_switch_usage_gap_percent, Some(30));

        // 다시 저장할 때는 새 이름으로만 나간다.
        let saved = serde_json::to_value(&registry).expect("직렬화");
        assert_eq!(saved["autoSwitchUsageGapPercent"], serde_json::json!(30));
        assert!(saved.get("autoSwitchUsageThresholdPercent").is_none());

        // 두 이름 모두 없는 더 오래된 레지스트리는 꺼진 상태로 읽힌다.
        let older = serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "accounts": [],
            "providers": [],
        });
        let registry: AccountRegistry =
            serde_json::from_value(older).expect("더 오래된 레지스트리");
        assert_eq!(registry.auto_switch_usage_gap_percent, None);
    }

    #[test]
    fn usage_refresh_interval_is_longer_for_accounts_with_nothing_running() {
        let now = 1_000_000_000;
        let usage = |updated_at: i64| AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "5h".to_owned(),
                used_percent: 10.0,
                resets_at: None,
                ..Default::default()
            }],
            updated_at: Some(updated_at),
            ..AccountUsageView::default()
        };
        let ten_minutes_ago = usage(now - 10 * 60_000);
        // 활성이거나 런타임이 붙은 계정은 5분마다 다시 읽는다.
        assert!(!usage_refresh_fresh_for_interval(
            &ten_minutes_ago,
            now,
            true
        ));
        // 아무것도 돌지 않는 계정은 사용량이 올라갈 수 없으므로 30분까지 그대로 둔다.
        assert!(usage_refresh_fresh_for_interval(
            &ten_minutes_ago,
            now,
            false
        ));
        let forty_minutes_ago = usage(now - 40 * 60_000);
        assert!(!usage_refresh_fresh_for_interval(
            &forty_minutes_ago,
            now,
            false
        ));
        // 한 번도 조회하지 못한 계정은 주기와 무관하게 대상이다.
        assert!(!usage_refresh_fresh_for_interval(
            &AccountUsageView::default(),
            now,
            false
        ));
    }

    #[test]
    fn usage_refresh_interval_yields_to_an_elapsed_window_reset() {
        let now = 1_000_000_000;
        let updated_at = now - 10 * 60_000;
        // 초기화 시각이 마지막 조회 뒤에 지났으면 저장된 수치가 실제보다 높다.
        // 유휴 계정이라도 주기를 기다리지 않고 곧바로 다시 읽는다.
        let reset_passed = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "5h".to_owned(),
                used_percent: 80.0,
                resets_at: Some(now - 60_000),
                ..Default::default()
            }],
            updated_at: Some(updated_at),
            ..AccountUsageView::default()
        };
        assert!(usage_reset_elapsed_since_update(&reset_passed, now));
        assert!(!usage_refresh_fresh_for_interval(&reset_passed, now, false));
        // 아직 오지 않은 초기화는 갱신을 앞당기지 않는다.
        let reset_ahead = AccountUsageView {
            windows: vec![AccountUsageWindow {
                label: "5h".to_owned(),
                used_percent: 80.0,
                resets_at: Some(now + 60_000),
                ..Default::default()
            }],
            ..reset_passed
        };
        assert!(!usage_reset_elapsed_since_update(&reset_ahead, now));
        assert!(usage_refresh_fresh_for_interval(&reset_ahead, now, false));
    }

    #[test]
    fn auto_switch_gap_moves_to_an_account_that_is_far_enough_behind() {
        let now = 1_000_000;
        let accounts = vec![
            auto_switch_record("active", true, usage_at(30.0)),
            // 격차 5%p — 아직 비슷하게 쓰고 있어 옮길 이유가 없다.
            auto_switch_record("close", true, usage_at(25.0)),
            // 격차 11%p — 설정 폭을 넘어 후보가 된다.
            auto_switch_record("behind", true, usage_at(19.0)),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                Some(10.0),
            ),
            Some("behind".to_owned())
        );
    }

    #[test]
    fn auto_switch_gap_holds_while_accounts_stay_close_and_resumes_as_it_widens() {
        let now = 1_000_000;
        // 전원이 같은 사용량이면 이미 균형이 맞은 것이므로 옮기지 않는다.
        let balanced = vec![
            auto_switch_record("active", true, usage_at(50.0)),
            auto_switch_record("b", true, usage_at(50.0)),
            auto_switch_record("c", true, usage_at(50.0)),
        ];
        assert_eq!(
            select_auto_switch_target(
                &balanced,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::MaxHeadroom,
                Some(10.0),
            ),
            None
        );
        // 활성 계정이 계속 쓰여 격차가 벌어지면 다시 후보가 생긴다. 절대 사용률
        // 기준에서 순환이 영구히 멈추던 자리다.
        let widened = vec![
            auto_switch_record("active", true, usage_at(60.0)),
            auto_switch_record("b", true, usage_at(50.0)),
            auto_switch_record("c", true, usage_at(50.0)),
        ];
        assert_eq!(
            select_auto_switch_target(
                &widened,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::MaxHeadroom,
                Some(10.0),
            ),
            Some("b".to_owned())
        );
    }

    #[test]
    fn auto_switch_gap_never_moves_to_a_more_used_account() {
        let now = 1_000_000;
        // 활성 계정이 뒤처져 있으면 먼저 따라잡아야 한다. 절대 사용률 기준은 여기서
        // 더 많이 쓴 계정으로 옮겨 균형을 오히려 깼다.
        let accounts = vec![
            auto_switch_record("active", true, usage_at(10.0)),
            auto_switch_record("b", true, usage_at(50.0)),
            auto_switch_record("c", true, usage_at(50.0)),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::MaxHeadroom,
                Some(10.0),
            ),
            None
        );
    }

    #[test]
    fn auto_switch_gap_skips_candidates_without_usage_readings() {
        let now = 1_000_000;
        let accounts = vec![
            auto_switch_record("active", true, usage_at(50.0)),
            auto_switch_record("unknown", true, AccountUsageView::default()),
        ];
        // 얼마나 뒤처졌는지 모르는 계정으로 옮기면 더 많이 쓴 계정으로 갈 수 있다.
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                Some(10.0),
            ),
            None
        );
        // 격차 조건이 없는 소진 트리거에서는 그대로 후보로 남아, 새로 등록한 계정이
        // 영영 굶지는 않는다.
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            Some("unknown".to_owned())
        );
    }

    #[test]
    fn auto_switch_gap_holds_when_the_limited_account_usage_is_unknown() {
        let now = 1_000_000;
        // 기준이 되는 계정의 사용량을 모르면 격차를 잴 수 없다.
        let accounts = vec![
            auto_switch_record("active", true, AccountUsageView::default()),
            auto_switch_record("b", true, usage_at(0.0)),
        ];
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "active",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                Some(10.0),
            ),
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
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "a",
                &no_purpose(),
                now,
                AutoSwitchPolicy::Registration,
                None,
            ),
            None
        );
        assert_eq!(
            select_auto_switch_target(
                &accounts,
                ProviderId::Codex,
                "a",
                &no_purpose(),
                now + 60_000,
                AutoSwitchPolicy::Registration,
                None,
            ),
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
            chat_id: None,
            models: Vec::new(),
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
        // 기본 계정이 아닌 계정의 신호도 그 계정에 묶인 세션을 옮길 후보를 고른다 — 모든
        // 계정은 자기 격리 프로필로 실행되므로 기본 계정 여부는 후보 선택과 무관하다.
        let other_limited = AutoSwitchSignal {
            provider: ProviderId::Codex,
            account_id: other.clone(),
            reason: AutoSwitchReason::AgentLimited,
            chat_id: None,
            models: Vec::new(),
        };
        assert_eq!(
            supervisor.plan_auto_switch(&other_limited).unwrap(),
            Some(active.clone())
        );
        // 직전 자동전환 기록이 있으면 쿨다운 동안 전환하지 않고 스냅샷에 노출된다.
        supervisor
            .record_auto_switch(
                ProviderId::Codex,
                &active,
                &other,
                AutoSwitchReason::UsageExhausted,
                2,
                true,
                None,
            )
            .expect("기록");
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

    /// 한도 응답은 런타임이 남아 있지 않아도 기본 계정을 옮긴다. 회차의 채팅들이 리스를
    /// 놓은 뒤에 도착한 신호로도 소진된 기본 계정을 멀쩡한 계정으로 바꿔야, 활성 계정을 쓰는
    /// 다음 회차가 창 리셋까지 서 있지 않는다.
    #[test]
    fn an_agent_limit_rotates_even_without_a_leased_runtime() {
        let (_data, _home, supervisor, a, b) = two_account_supervisor();
        supervisor.set_auto_switch(&a, true).unwrap();
        supervisor.set_auto_switch(&b, true).unwrap();
        let signal = AutoSwitchSignal {
            provider: ProviderId::Codex,
            account_id: a.clone(),
            reason: AutoSwitchReason::AgentLimited,
            chat_id: None,
            models: Vec::new(),
        };
        assert_eq!(supervisor.plan_auto_switch(&signal).unwrap(), Some(b));
    }

    /// 입장 판정은 후보를 고르기 전에 따로 물을 수 있다. 쿨다운 안이거나 자동전환이 꺼진
    /// 계정의 신호는 거절되고, 그 뒤에야 전환 루프가 살아 있는 채팅을 훑는다.
    #[test]
    fn admissibility_is_decided_before_candidates_are_looked_at() {
        let (_data, _home, supervisor, a, b) = two_account_supervisor();
        let signal = AutoSwitchSignal {
            provider: ProviderId::Codex,
            account_id: a.clone(),
            reason: AutoSwitchReason::AgentLimited,
            chat_id: None,
            models: Vec::new(),
        };
        assert!(
            !supervisor.auto_switch_admissible(&signal).unwrap(),
            "자동전환이 꺼진 계정"
        );
        supervisor.set_auto_switch(&a, true).unwrap();
        assert!(supervisor.auto_switch_admissible(&signal).unwrap());
        supervisor
            .record_auto_switch(
                ProviderId::Codex,
                &a,
                &b,
                AutoSwitchReason::AgentLimited,
                1,
                true,
                None,
            )
            .expect("기록");
        assert!(
            !supervisor.auto_switch_admissible(&signal).unwrap(),
            "쿨다운 안"
        );
    }

    /// 저장에 실패한 갱신은 메모리에도 남지 않는다. 메모리만 바뀐 채 실패를 돌려주면 새 대화는
    /// 바뀐 기본 계정으로 열리고 재기동하면 옛 값으로 돌아가 두 상태가 어긋난다.
    #[test]
    fn a_registry_update_that_cannot_be_saved_is_rolled_back() {
        let (data, _home, supervisor, a, b) = two_account_supervisor();
        let active = supervisor
            .active_account_id(ProviderId::Codex)
            .unwrap()
            .expect("기본 계정");
        let other = if active == a { b.clone() } else { a.clone() };
        // 저장 파일 자리에 비어 있지 않은 폴더를 두면 원자적 교체(rename)가 실패한다.
        let registry_path = data.path().join(REGISTRY_FILE);
        std::fs::remove_file(&registry_path).unwrap();
        std::fs::create_dir(&registry_path).unwrap();
        std::fs::write(registry_path.join("occupied"), b"x").unwrap();
        assert!(
            supervisor.set_active(&other).is_err(),
            "저장 실패는 오류로 드러난다"
        );
        assert_eq!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(active),
            "저장하지 못한 변경은 메모리에서도 되돌린다"
        );
    }

    /// 회전은 계획이 본 기본 계정이 아직 그대로일 때만 한다. 그 사이 사용자가 기본 계정을
    /// 바꿨으면 자동전환이 그 선택을 덮어쓰지 않는다.
    #[test]
    fn a_rotation_only_moves_the_default_it_was_planned_from() {
        let (_data, _home, supervisor, a, b) =
            two_account_supervisor_with_probe(Arc::new(ready_credential_probe));
        supervisor.set_auto_switch(&a, true).unwrap();
        supervisor.set_auto_switch(&b, true).unwrap();
        let active = supervisor
            .active_account_id(ProviderId::Codex)
            .unwrap()
            .expect("기본 계정");
        let other = if active == a { b.clone() } else { a.clone() };
        // 계획은 `active`에서 `other`로 옮기려 했는데, 그 사이 기본 계정이 이미 `other`다.
        supervisor.set_active(&other).unwrap();
        assert!(!supervisor
            .request_active_account_rotation(&active, &other)
            .unwrap());
        // 이미 기본인 계정으로의 회전은 출발점이 맞아도 아무 일도 하지 않는다.
        assert!(!supervisor
            .request_active_account_rotation(&other, &other)
            .unwrap());
        // 기대한 출발점이 맞으면 옮긴다.
        assert!(supervisor
            .request_active_account_rotation(&other, &active)
            .unwrap());
        assert_eq!(
            supervisor.active_account_id(ProviderId::Codex).unwrap(),
            Some(active)
        );
    }

    /// 기록은 저장한 이벤트를 그대로 돌려준다 — 알림이 스냅숏과 다른 말을 할 수 없다. 옮긴
    /// 세션이 없으면 행방도 비고, 기본 계정이 그대로였다는 사실도 그대로 실린다.
    #[test]
    fn record_returns_the_stored_event_and_blanks_sessions_to_without_resumed_sessions() {
        let (_data, _home, supervisor, a, b) = two_account_supervisor();
        let recorded = supervisor
            .record_auto_switch(
                ProviderId::Codex,
                &a,
                &b,
                AutoSwitchReason::AgentLimited,
                0,
                false,
                Some("x"),
            )
            .expect("기록");
        assert_eq!(
            recorded.sessions_to_account_id, None,
            "옮긴 세션이 없으면 행방도 없다"
        );
        assert!(!recorded.default_rotated);
        let snapshot_event = supervisor
            .snapshot()
            .unwrap()
            .providers
            .iter()
            .find(|p| p.provider == ProviderId::Codex)
            .unwrap()
            .last_auto_switch
            .clone()
            .unwrap();
        assert_eq!(
            snapshot_event, recorded,
            "돌려준 이벤트와 스냅숏의 이벤트가 같다"
        );
    }

    /// 세션과 기본 계정이 다른 곳으로 갔으면 이벤트가 세션의 행방을 따로 담는다. 같은 곳이면
    /// 비워 둔다 — 화면이 두 번 말할 필요가 없다. 이 규칙의 주인은 기록 하나다.
    #[test]
    fn the_event_names_where_sessions_went_only_when_it_differs() {
        let (_data, _home, supervisor, a, b) = two_account_supervisor();
        supervisor
            .record_auto_switch(
                ProviderId::Codex,
                &a,
                &b,
                AutoSwitchReason::AgentLimited,
                2,
                true,
                Some("x"),
            )
            .expect("기록");
        let event = supervisor
            .snapshot()
            .unwrap()
            .providers
            .iter()
            .find(|p| p.provider == ProviderId::Codex)
            .unwrap()
            .last_auto_switch
            .clone()
            .unwrap();
        assert_eq!(event.sessions_to_account_id.as_deref(), Some("x"));
        supervisor
            .record_auto_switch(
                ProviderId::Codex,
                &a,
                &b,
                AutoSwitchReason::AgentLimited,
                2,
                true,
                Some(&b),
            )
            .expect("기록");
        let event = supervisor
            .snapshot()
            .unwrap()
            .providers
            .iter()
            .find(|p| p.provider == ProviderId::Codex)
            .unwrap()
            .last_auto_switch
            .clone()
            .unwrap();
        assert_eq!(event.sessions_to_account_id, None);
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

    /// 한도 신호는 계정을 페일오버 후보에서 빼되 사용량 조회를 미루지는 않는다.
    /// 조회를 미루면 화면이 마지막 수치를 그대로 보여 주는 채로 채팅만 한도 오류를
    /// 내고, 재시도마다 대기가 다시 걸려 실제 수치가 영영 나타나지 않는다.
    #[test]
    fn report_agent_usage_limit_marks_account_without_deferring_the_usage_fetch() {
        let (_data, _home, supervisor, a, _b) = two_account_supervisor();
        supervisor.report_agent_usage_limit(&a, None, None).unwrap();
        let snapshot = supervisor.snapshot().unwrap();
        let usage = &snapshot
            .accounts
            .iter()
            .find(|account| account.id == a)
            .unwrap()
            .usage;
        let now = now_ms();
        assert!(usage.rate_limited);
        assert_eq!(usage.retry_at, None);
        // 페일오버 후보에서는 빠지지만, 조회는 미뤄지지 않는다.
        assert!(usage_blocks_auto_switch(usage, now));
        assert!(!usage_refresh_deferred(usage, now));
    }

    /// Antigravity가 계정 공급자가 되면서 레지스트리에 자리가 생겼다. 등록된 계정이
    /// 없어도 조회는 성공해야 하고(없음을 답한다), 계정을 고르지 않은 일반 채팅은
    /// 그대로 계정 귀속 없이 런타임을 확보할 수 있어야 한다.
    #[test]
    fn antigravity_runtime_lease_works_without_a_registered_account() {
        let (_data, _home, supervisor, _a, _b) = two_account_supervisor();

        assert_eq!(
            supervisor
                .active_account_id(ProviderId::Antigravity)
                .expect("공급자 자리가 있어야 조회가 성공한다"),
            None
        );

        let lease = supervisor
            .acquire_runtime(ProviderId::Antigravity, None)
            .expect("Antigravity 런타임은 계정 없이 확보되어야 한다");
        assert!(lease.account_id.is_none());
        drop(lease);

        assert!(supervisor.set_active("any-account").is_err());
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
            .acquire_unscoped_runtime(ProviderId::Codex, UnscopedRuntimeKind::SharedHome)
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

    /// 계정을 두지 않는 공급자에는 임차가 없다. 자격증명 전환 락 자체가 없어
    /// `credential_switch_guard`가 거절하므로, 호출자(설정 터미널)는 임차를 청하기 전에
    /// 걸러야 한다. 이 확인이 없어 로컬 공급자 연결 드로워의 설정 터미널이
    /// "계정 관리를 지원하지 않습니다"로 열리지 않았다.
    #[test]
    fn unscoped_runtime_is_refused_for_a_provider_without_accounts() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let supervisor = AccountSupervisor::open_with(
            data.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();

        assert!(!ProviderId::Local.manages_accounts());
        assert!(supervisor
            .acquire_unscoped_runtime(ProviderId::Local, UnscopedRuntimeKind::SharedHome)
            .is_err());
    }

    #[test]
    fn provider_vault_key_formats_expected_prefix() {
        assert_eq!(
            provider_vault_key(ProviderId::Claude, "acc-1"),
            "claude:acc-1"
        );
        assert_eq!(
            provider_vault_key(ProviderId::Codex, "acc-2"),
            "codex:acc-2"
        );
        assert_eq!(
            provider_vault_key(ProviderId::Antigravity, "acc-3"),
            "antigravity:acc-3"
        );
    }

    #[test]
    fn account_auth_status_display_and_from_str_round_trip() {
        assert_eq!(
            AccountAuthStatus::ALL,
            [
                AccountAuthStatus::Ready,
                AccountAuthStatus::Missing,
                AccountAuthStatus::Error,
            ]
        );
        for status in AccountAuthStatus::ALL {
            assert_eq!(status.to_string(), status.as_str());
            assert_eq!(
                status.as_str().parse::<AccountAuthStatus>().unwrap(),
                status
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&status).unwrap();
            assert_eq!(serialized, format!("\"{}\"", status.as_str()));
            let deserialized: AccountAuthStatus = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, status);
        }
        assert_eq!(
            "  ready  ".parse::<AccountAuthStatus>().unwrap(),
            AccountAuthStatus::Ready
        );
        assert!(matches!(
            "invalid".parse::<AccountAuthStatus>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn account_usage_status_display_and_from_str_round_trip() {
        assert_eq!(
            AccountUsageStatus::ALL,
            [
                AccountUsageStatus::Idle,
                AccountUsageStatus::Ok,
                AccountUsageStatus::Unavailable,
                AccountUsageStatus::Error,
            ]
        );
        for status in AccountUsageStatus::ALL {
            assert_eq!(status.to_string(), status.as_str());
            assert_eq!(
                status.as_str().parse::<AccountUsageStatus>().unwrap(),
                status
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&status).unwrap();
            assert_eq!(serialized, format!("\"{}\"", status.as_str()));
            let deserialized: AccountUsageStatus = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, status);
        }
        assert_eq!(
            "  unavailable  ".parse::<AccountUsageStatus>().unwrap(),
            AccountUsageStatus::Unavailable
        );
        assert!(matches!(
            "invalid".parse::<AccountUsageStatus>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn auto_switch_policy_display_and_from_str_round_trip() {
        assert_eq!(
            AutoSwitchPolicy::ALL,
            [
                AutoSwitchPolicy::Priority,
                AutoSwitchPolicy::MaxHeadroom,
                AutoSwitchPolicy::Registration,
            ]
        );
        for policy in AutoSwitchPolicy::ALL {
            assert_eq!(policy.to_string(), policy.as_str());
            assert_eq!(policy.as_str().parse::<AutoSwitchPolicy>().unwrap(), policy);
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&policy).unwrap();
            assert_eq!(serialized, format!("\"{}\"", policy.as_str()));
            let deserialized: AutoSwitchPolicy = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, policy);
        }
        assert_eq!(
            "  maxHeadroom  ".parse::<AutoSwitchPolicy>().unwrap(),
            AutoSwitchPolicy::MaxHeadroom
        );
        assert!(matches!(
            "invalid".parse::<AutoSwitchPolicy>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn resume_account_policy_display_and_from_str_round_trip() {
        assert_eq!(
            ResumeAccountPolicy::ALL,
            [
                ResumeAccountPolicy::ActiveAccount,
                ResumeAccountPolicy::LastUsedAccount,
            ]
        );
        for policy in ResumeAccountPolicy::ALL {
            assert_eq!(policy.to_string(), policy.as_str());
            assert_eq!(
                policy.as_str().parse::<ResumeAccountPolicy>().unwrap(),
                policy
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&policy).unwrap();
            assert_eq!(serialized, format!("\"{}\"", policy.as_str()));
            let deserialized: ResumeAccountPolicy = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, policy);
        }
        assert_eq!(
            "  lastUsedAccount  "
                .parse::<ResumeAccountPolicy>()
                .unwrap(),
            ResumeAccountPolicy::LastUsedAccount
        );
        assert!(matches!(
            "invalid".parse::<ResumeAccountPolicy>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn home_credential_state_display_and_from_str_round_trip() {
        assert_eq!(
            HomeCredentialState::ALL,
            [
                HomeCredentialState::Unchecked,
                HomeCredentialState::Absent,
                HomeCredentialState::Verified,
                HomeCredentialState::Expired,
                HomeCredentialState::Error,
            ]
        );
        for state in HomeCredentialState::ALL {
            assert_eq!(state.to_string(), state.as_str());
            assert_eq!(
                state.as_str().parse::<HomeCredentialState>().unwrap(),
                state
            );
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&state).unwrap();
            assert_eq!(serialized, format!("\"{}\"", state.as_str()));
            let deserialized: HomeCredentialState = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, state);
        }
        assert_eq!(
            "  verified  ".parse::<HomeCredentialState>().unwrap(),
            HomeCredentialState::Verified
        );
        assert!(matches!(
            "invalid".parse::<HomeCredentialState>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn auto_switch_reason_display_and_from_str_round_trip() {
        assert_eq!(
            AutoSwitchReason::ALL,
            [
                AutoSwitchReason::UsageExhausted,
                AutoSwitchReason::UsageSpread,
                AutoSwitchReason::AgentLimited,
            ]
        );
        for reason in AutoSwitchReason::ALL {
            assert_eq!(reason.to_string(), reason.as_str());
            assert_eq!(reason.as_str().parse::<AutoSwitchReason>().unwrap(), reason);
            // serde_json 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&reason).unwrap();
            assert_eq!(serialized, format!("\"{}\"", reason.as_str()));
            let deserialized: AutoSwitchReason = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, reason);
        }
        assert_eq!(
            "  usageSpread  ".parse::<AutoSwitchReason>().unwrap(),
            AutoSwitchReason::UsageSpread
        );
        assert!(matches!(
            "invalid".parse::<AutoSwitchReason>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    /// Antigravity 공유 홈은 사용자 홈에서 유도한다. 이 값이 없으면 프로필 조립이
    /// 공유 설정(MCP·훅·스킬)을 어디에 이어야 할지 모른다.
    #[test]
    fn antigravity_provider_root_is_the_gemini_home() {
        let temp = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let supervisor = AccountSupervisor::open_with(
            temp.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();
        assert_eq!(
            supervisor.provider_root(ProviderId::Antigravity).unwrap(),
            fs::canonicalize(home.path()).unwrap().join(".gemini")
        );
    }

    /// 등록된 계정은 활성 계정이라도 자기 프로필로 돈다. 활성 계정만 공유 CLI 홈을 쓰게
    /// 두면, 그 홈의 로그인은 앱이 바꾸지 않으므로(`set_active`는 레지스트리만 고친다)
    /// 계정 카드가 남의 잔량을 보여 주고 실행도 남의 쿼터를 쓴다(2026-09-18 실측).
    #[test]
    fn every_registered_account_runs_in_its_own_profile() {
        let temp = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let supervisor = AccountSupervisor::open_with(
            temp.path(),
            home.path(),
            Arc::new(MemoryVault::default()),
        )
        .unwrap();
        // 계정을 관리하는 공급자마다 프로필을 가리키는 환경변수가 있어야 등록 계정이 자기
        // 저장소로 돈다. 한 공급자라도 빈 벌이면 그 계정은 조용히 공유 홈으로 되돌아간다.
        // 계정을 두지 않는 공급자는 프로필 자체를 만들지 않으므로 대상이 아니다.
        for provider in ProviderId::ALL
            .into_iter()
            .filter(|provider| provider.manages_accounts())
        {
            let dir = credential_profiles::profile_dir(temp.path(), provider, "acct").unwrap();
            assert!(
                !credential_profiles::profile_env(provider, &dir, home.path())
                    .unwrap()
                    .is_empty(),
                "{provider}"
            );
        }
        // 활성 계정이 없어도 공급자 자리는 있어 조회가 성공한다.
        assert_eq!(
            supervisor
                .active_account_id(ProviderId::Antigravity)
                .expect("공급자 자리"),
            None
        );
    }

    /// 토큰이 없는 프로필 홈으로 실행하면 CLI가 print 모드에서도 브라우저 로그인 창을
    /// 띄우고 기다린다. 프로브를 돌리기 전에 걸러야 한다(C12-7).
    #[test]
    fn antigravity_profile_without_a_login_token_is_refused_before_the_probe() {
        let temp = tempfile::tempdir().unwrap();
        let dir = credential_profiles::ensure_profile_dir(
            temp.path(),
            ProviderId::Antigravity,
            "antigravity-1",
        )
        .unwrap();
        assert!(!credential_profiles::antigravity_login_present(&dir));
        let token = dir.join(credential_profiles::ANTIGRAVITY_TOKEN_RELATIVE_PATHS[0]);
        fs::create_dir_all(token.parent().unwrap()).unwrap();
        fs::write(&token, "token").unwrap();
        assert!(credential_profiles::antigravity_login_present(&dir));
    }

    /// C12-11 1단계. 전역 항목의 값은 토큰 파일 하나의 모양이라 두 파일 자리에 그대로 들어가고,
    /// 신원은 그 안의 `id_token`에서 나온다.
    #[test]
    fn c12_11_global_login_envelope_fills_both_token_files_and_carries_identity() {
        let blob = serde_json::json!({
            "auth_method": "consumer",
            "id_token": antigravity_id_token("sub-1", "person@example.com"),
            "token": {"access_token": "a", "refresh_token": "r", "expiry": "2030-01-01T00:00:00Z", "token_type": "Bearer"},
        })
        .to_string();
        let envelope = antigravity_envelope_from_global_login(&blob).expect("envelope");
        let parsed = AntigravityEnvelope::parse_required(&envelope).expect("parse");
        for key in ANTIGRAVITY_SECRET_KEYS {
            assert_eq!(
                parsed
                    .token_file(key)
                    .and_then(|v| v.get("auth_method"))
                    .and_then(Value::as_str),
                Some("consumer"),
                "{key}"
            );
        }
        let identity = antigravity_identity(&envelope).expect("identity");
        assert_eq!(identity.email.as_deref(), Some("person@example.com"));
        assert!(antigravity_envelope_from_global_login("[1,2]").is_err());
        assert!(antigravity_envelope_from_global_login("not json").is_err());
    }

    /// C12-11 3단계. 프로브와 실행이 같은 프로필에 잇달아 찍으므로 마지막 줄이 이 프로세스의 것.
    #[test]
    fn c12_11_cli_log_yields_the_last_auth_result_email() {
        let text = "I0924 13:19:23 server_oauth.go:196] applyAuthResult: email=first@example.com, authMethod=consumer, quotaProject=\n\
                    I0924 13:19:24 cache.go:135] Cache(userInfo): refresh\n\
                    I0924 13:20:01 server_oauth.go:196] applyAuthResult: email=second@example.com, authMethod=consumer, quotaProject=\n";
        assert_eq!(
            antigravity_authenticated_email_from_log_text(text).as_deref(),
            Some("second@example.com")
        );
        assert_eq!(
            antigravity_authenticated_email_from_log_text("no auth here"),
            None
        );
        assert_eq!(
            antigravity_authenticated_email_from_log_text(
                "applyAuthResult: email=, authMethod=consumer"
            ),
            None
        );
    }

    /// C12-11 3단계. 구글 이메일은 대소문자를 가리지 않고, 다른 계정은 관측값을 그대로 보고한다.
    #[test]
    fn c12_11_identity_compare_ignores_case_and_reports_the_observed_account() {
        assert_eq!(
            compare_antigravity_identity("Person@Example.com", "person@example.com"),
            AntigravityIdentityCheck::Matched
        );
        assert_eq!(
            compare_antigravity_identity("a@example.com", "b@example.com"),
            AntigravityIdentityCheck::Mismatch {
                observed: "b@example.com".to_owned()
            }
        );
    }

    /// C12-11. 전역 저장소가 아닌 플랫폼에서는 비우기가 아무것도 하지 않고, 검사는 적용 대상이 아니다.
    #[cfg(not(target_os = "windows"))]
    #[test]
    fn c12_11_global_login_protocol_is_inert_off_windows() {
        assert!(!credential_profiles::antigravity_login_is_machine_global());
        assert!(!credential_profiles::clear_antigravity_global_login().expect("clear"));
        assert!(credential_profiles::read_antigravity_global_login()
            .expect("read")
            .is_none());
    }

    fn antigravity_id_token(subject: &str, email: &str) -> String {
        let claims = serde_json::json!({"sub": subject, "email": email});
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).expect("claims"));
        format!("header.{payload}.signature")
    }

    fn antigravity_secret(subject: &str, email: &str, expiry: &str) -> String {
        serde_json::json!({
            "antigravityOauthToken": {
                "auth_method": "consumer",
                "id_token": antigravity_id_token(subject, email),
                "token": {
                    "access_token": "access",
                    "refresh_token": "refresh",
                    "expiry": expiry,
                    "token_type": "Bearer",
                },
            },
            "jetskiStandaloneOauthToken": {"auth_method": "consumer", "token": "jetski"},
        })
        .to_string()
    }

    /// 프로필은 홈 전체를 가르므로 그 자리가 곧 홈이고, 공급자 루트를 받으면 `.gemini`의
    /// 부모가 홈이다. 이 구분이 틀어지면 토큰이 `.gemini/.gemini` 아래로 들어간다.
    #[test]
    fn antigravity_home_is_resolved_from_either_shape() {
        assert_eq!(
            antigravity_home_for(Path::new("/Users/x/.gemini")),
            Path::new("/Users/x")
        );
        assert_eq!(
            antigravity_home_for(Path::new("/data/credential-profiles/antigravity/acct-b")),
            Path::new("/data/credential-profiles/antigravity/acct-b")
        );
    }

    /// CLI는 로그인 토큰을 두 파일로 나눠 둔다. 볼트에는 한 덩이로 담고 홈에는 다시
    /// 두 파일로 펼쳐야 CLI가 그대로 읽는다.
    #[test]
    fn antigravity_credentials_round_trip_through_the_two_token_files() {
        let home = tempfile::tempdir().expect("home");
        let secret =
            antigravity_secret("sub-b", "b@example.com", "2026-09-17T13:19:23.742496+09:00");
        write_antigravity_credentials(home.path(), &secret).expect("write");

        for relative in credential_profiles::ANTIGRAVITY_TOKEN_RELATIVE_PATHS {
            let path = home.path().join(relative);
            assert!(path.is_file(), "{relative}");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(&path).expect("metadata").permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "{relative}");
            }
        }
        let read = read_antigravity_credentials(home.path()).expect("read");
        assert!(same_secret(read.as_str(), &secret));
    }

    #[test]
    fn antigravity_credentials_are_missing_when_no_token_file_exists() {
        let home = tempfile::tempdir().expect("home");
        assert!(matches!(
            read_antigravity_credentials(home.path()),
            Err(CoreError::NotFound(_))
        ));
    }

    /// 계정을 묻는 공식 명령이 없어 토큰 안의 id_token이 유일한 근거다. 식별자는 이메일로
    /// 통일한다 — 토큰이 키체인에만 있는 설치에서는 신원을 CLI 로그의 이메일에서 읽으므로,
    /// 여기서 구글 subject를 쓰면 같은 계정이 두 경로에서 다른 키를 얻는다.
    #[test]
    fn antigravity_identity_comes_from_the_id_token() {
        let secret = antigravity_secret("sub-b", "b@example.com", "2026-09-17T13:19:23+09:00");
        let identity = antigravity_identity(&secret).expect("identity");
        assert_eq!(identity.provider_account_id, "b@example.com");
        assert_eq!(
            identity.legacy_provider_account_id.as_deref(),
            Some("sub-b")
        );
        assert_eq!(identity.email.as_deref(), Some("b@example.com"));

        let without_token = serde_json::json!({"antigravityOauthToken": {"token": {}}}).to_string();
        assert!(antigravity_identity(&without_token).is_err());
    }

    /// 리프레시 토큰이 사슬을 잇는다. 액세스 토큰이 만료돼도 실행은 가능해야 하고,
    /// 리프레시 토큰이 없으면 온전하지 않은 값이다.
    #[test]
    fn antigravity_credential_health_follows_the_refresh_token() {
        let secret = antigravity_secret("sub-b", "b@example.com", "2020-01-01T00:00:00+00:00");
        assert!(credential_is_complete(ProviderId::Antigravity, &secret));
        assert!(credential_can_authenticate(
            ProviderId::Antigravity,
            &secret,
            now_ms()
        ));

        let no_refresh = serde_json::json!({
            "antigravityOauthToken": {
                "id_token": antigravity_id_token("sub-b", "b@example.com"),
                "token": {"access_token": "access", "expiry": "2020-01-01T00:00:00+00:00"},
            }
        })
        .to_string();
        assert!(!credential_is_complete(
            ProviderId::Antigravity,
            &no_refresh
        ));
    }

    /// 두 사슬의 선후는 액세스 토큰 만료 시각으로 가린다. 읽지 못하면 프로필 사본이
    /// 볼트 정본을 덮어쓸 자격을 얻는다.
    #[test]
    fn antigravity_chain_order_uses_the_access_token_expiry() {
        let older = antigravity_secret("sub-b", "b@example.com", "2026-09-17T13:00:00+09:00");
        let newer = antigravity_secret("sub-b", "b@example.com", "2026-09-17T14:00:00+09:00");
        assert!(credential_chain_is_newer(
            ProviderId::Antigravity,
            &newer,
            &older
        ));
        assert!(!credential_chain_is_newer(
            ProviderId::Antigravity,
            &older,
            &newer
        ));
    }

    /// 공식 CLI는 키체인을 쓸 수 있으면 로그인 토큰을 **파일로 남기지 않는다**. 봉투가
    /// 키체인 값을 함께 담지 않으면 로그인 결과를 하나도 회수하지 못한다(`C12-4a`).
    #[cfg(target_os = "macos")]
    #[test]
    fn an_antigravity_envelope_carries_the_profile_keychain_token() {
        let home = tempfile::tempdir().expect("home");
        // 파일은 하나도 없고 키체인에만 토큰이 있는, 방금 로그인한 프로필과 같은 배치다.
        write_antigravity_keyring_token(home.path(), "keychain-only-token").expect("키체인 저장");
        let secret = read_antigravity_credentials(home.path()).expect("봉투 읽기");
        assert!(antigravity_has_keyring_token(&secret));
        // 파일 사슬이 없어도 등록과 실행이 막히지 않아야 한다.
        assert!(credential_is_complete(ProviderId::Antigravity, &secret));
        assert!(credential_can_authenticate(
            ProviderId::Antigravity,
            &secret,
            now_ms()
        ));

        // 볼트에서 프로필로 되돌릴 때도 키체인으로 들어가야 CLI가 그 값을 읽는다.
        let restored = tempfile::tempdir().expect("restored");
        write_antigravity_credentials(restored.path(), &secret).expect("복원");
        let again = read_antigravity_credentials(restored.path()).expect("복원본 읽기");
        assert!(same_secret(&again, &secret));
    }

    /// 키체인 값은 해석할 수 없는 덩어리라 신원이 들어 있지 않고, 계정을 묻는 명령도 없다.
    /// 공식 CLI가 로그인 직후 자기 로그에 남긴 이메일이 유일한 근거다.
    #[test]
    fn antigravity_identity_falls_back_to_the_login_log() {
        let home = tempfile::tempdir().expect("home");
        let logs = home.path().join(".gemini/antigravity-cli/log");
        fs::create_dir_all(&logs).expect("log dir");
        fs::write(
            logs.join("cli-20260917_000000.log"),
            "I0917 00:00:00.0 browser.go:167] consumerOAuth: authenticated as old@example.com\n",
        )
        .expect("old log");
        let identity = antigravity_identity_from_home(home.path()).expect("신원");
        assert_eq!(identity.provider_account_id, "old@example.com");
        assert_eq!(identity.email.as_deref(), Some("old@example.com"));

        // 로그가 없으면 신원을 지어내지 않는다.
        let empty = tempfile::tempdir().expect("empty");
        assert!(antigravity_identity_from_home(empty.path()).is_err());
    }
}
