//! Antigravity 사용량 조회.
//!
//! Antigravity는 다중 계정을 관리하지 않아 계정 레지스트리에 없지만
//! `agy --print /usage --output-format json`이 모델군별 주간·5시간 쿼터를 구조화해 준다.
//! 공식 CLI를 고정 argv로 실행하므로 공급자 저장소를 직접 해석하지 않고(G6), 셸 문자열도
//! 만들지 않는다(G9). 구형 CLI 호환을 위해 기존 language server 조회는 화면 표시용
//! fallback으로만 남긴다. 페이싱은 모델군을 구분할 수 있는 공식 CLI 결과만 사용한다.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;

use crate::accounts::{
    AccountAuthStatus, AccountUsageStatus, AccountUsageView, AccountUsageWindow,
    ProviderAccountView,
};
use crate::clock::now_ms;
use crate::domain::ProviderId;
use crate::CoreError;

/// 프로세스 목록·포트 조회와 조회 요청에 두는 제한. language server는 같은 기기의
/// loopback이라 정상이면 즉시 답한다. 늦으면 그 회차 표본을 포기하는 편이 낫다.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// 포트 하나에 걸어 볼 시간. 듣고는 있지만 다른 용도인 포트가 섞여 있어 짧게 끊는다.
const PORT_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// `/usage`는 language server를 잠깐 띄울 수 있어 일반 `--help`보다 넉넉히 기다린다.
const CLI_USAGE_TIMEOUT: Duration = Duration::from_secs(30);
const CLI_USAGE_CACHE_MAX_AGE: Duration = Duration::from_secs(5 * 60);
const DISPLAY_USAGE_CACHE_MAX_AGE: Duration = Duration::from_secs(30);
/// 실패한 `/usage` 조회를 이 시간 안에는 다시 띄우지 않는다. 미설치·미로그인 환경에서
/// 화면이 다시 읽을 때마다 30초짜리 CLI를 새로 띄우지 않게 한다.
const CLI_USAGE_FAILURE_RETRY: Duration = Duration::from_secs(60);
const CLI_USAGE_PENDING_MESSAGE: &str = "Antigravity /usage 조회 중입니다";
/// 살아 있는지 확인하는 데 쓰는 메서드. 사용량과 무관하고 인자도 필요 없어 포트
/// 판별에만 쓴다.
const HEALTH_METHOD: &str = "/exa.language_server_pb.LanguageServerService/GetUnleashData";
/// 사용량이 담겨 오는 메서드.
const STATUS_METHOD: &str = "/exa.language_server_pb.LanguageServerService/GetUserStatus";

/// 모델별 창을 하나로 요약한 창의 라벨. 모델 창은 그 모델을 쓰는 실행에만 걸리므로
/// 계정 대표 소진율에서 빠진다(`governing_windows`). 대표할 창이 하나도 없으면 화면과
/// 페이싱이 이 공급자의 여유를 알 수 없어, 가장 빡빡한 모델을 대표 창으로 함께 낸다.
const SUMMARY_WINDOW_LABEL: &str = "모델 쿼터";

pub(crate) const ANTIGRAVITY_GEMINI_RESOURCE_ID: &str = "antigravity:gemini";
pub(crate) const ANTIGRAVITY_THIRD_PARTY_RESOURCE_ID: &str = "antigravity:third-party";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PacingResource {
    Gemini,
    ThirdParty,
}

impl PacingResource {
    fn id(self) -> &'static str {
        match self {
            Self::Gemini => ANTIGRAVITY_GEMINI_RESOURCE_ID,
            Self::ThirdParty => ANTIGRAVITY_THIRD_PARTY_RESOURCE_ID,
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::Gemini => "Antigravity · Gemini",
            Self::ThirdParty => "Antigravity · Claude/GPT",
        }
    }

    /// 사용량 자원을 페이싱 화면의 논리 계정으로 조립한다. 이 행은 인증 계정이
    /// 아니므로 실행 계정의 기본값과 섞이지 않게 자원 타입 가까이에서 고정한다.
    fn into_account(self, usage: AccountUsageView) -> ProviderAccountView {
        let id = self.id().to_owned();
        let display_name = self.display_name().to_owned();
        let auth_status = if usage.status == AccountUsageStatus::Ok {
            AccountAuthStatus::Ready
        } else {
            AccountAuthStatus::Error
        };
        ProviderAccountView {
            id: id.clone(),
            provider: ProviderId::Antigravity,
            display_name: display_name.clone(),
            email: None,
            organization: Some("Antigravity usage resource".to_owned()),
            provider_account_id: id,
            label: None,
            provider_display_name: display_name,
            is_active: false,
            disabled: false,
            auto_switch: false,
            auto_switch_priority: None,
            auth_status,
            usage,
            note: Some("인증 계정이 아니라 Antigravity 모델군의 페이싱 자원입니다".to_owned()),
            // 자격증명 격리 여부를 나타내는 행이 아니다. false로 두면 페이싱 후보에서
            // 인증 문제로 오인하므로 논리 자원이 독립됐다는 의미로 true를 쓴다.
            credential_isolated: true,
            credential_isolation_note: None,
            // 자기 자격증명이 없는 논리 자원이라 만료시킬 사슬도 없다.
            credential_expires_at: None,
            runtime_count: 0,
        }
    }

    /// 모델군을 가리키는 짧은 이름. 계정이 이 모델군 창을 보고하지 않을 때 "무슨 창을 못
    /// 찾았는지"를 말하는 데 쓴다.
    fn group_name(self) -> &'static str {
        match self {
            Self::Gemini => "Gemini",
            Self::ThirdParty => "Claude·GPT",
        }
    }
}

const PACING_RESOURCES: [PacingResource; 2] = [PacingResource::Gemini, PacingResource::ThirdParty];

static CLI_USAGE_CACHE: OnceLock<Mutex<Option<CliUsageCacheEntry>>> = OnceLock::new();

#[derive(Debug)]
struct CliUsageCacheEntry {
    saved_at: Instant,
    groups: Vec<CliUsageGroup>,
}

/// 비차단 읽기([`UsageFreshness::CachedFirst`])의 백그라운드 갱신 상태. 갱신 스레드가 이미
/// 돌고 있는지와 직전 실패 시각·사유를 들고 있어, 조회마다 CLI를 겹쳐 띄우지 않는다.
static CLI_USAGE_PROBE: OnceLock<Mutex<CliUsageProbeState>> = OnceLock::new();

/// 이 공급자의 CLI 호출을 한 번에 하나로 줄 세운다.
///
/// 액세스 토큰이 만료된 상태에서 계정 여럿을 동시에 조회하면 각 CLI가 동시에 토큰을 갱신하려
/// 든다. 그러면 CLI 자신의 10초 키체인 마감을 넘겨(`keyringAuth: timed out after 10s`)
/// "로그인되어 있지 않다"로 판단하고 **브라우저 OAuth 창을 띄운다** — 사용자는 아무것도 하지
/// 않았는데 구글 로그인 창이 계정 수만큼 뜬다(2026-09-18 실측). 늦게 끝난 갱신은 실제로
/// 성공해 다음 호출은 잘 되므로, 실패의 원인은 자격증명이 아니라 겹침이다.
///
/// 조회 하나가 5~10초라 줄을 세워도 배경 갱신에는 문제가 없다.
static CLI_GATE: OnceLock<Mutex<()>> = OnceLock::new();

/// 브라우저를 열지 못하게 만든 `open` 대체가 들어 있는 디렉터리.
///
/// 이 CLI는 인증이 안 되면 **무조건** `open`으로 구글 로그인 창을 띄운다. `BROWSER`
/// 환경변수는 보지 않는다(2026-09-22 실측). 배경 조회가 실패하는 사연은 많다 — 네트워크가
/// 끊겼거나, 토큰 갱신이 늦거나, 한도에 걸렸거나. 그때마다 사용자가 아무것도 하지 않았는데
/// 계정 수만큼 로그인 창이 뜬다. 조회·프로브는 사람의 로그인을 기다리는 자리가 아니므로
/// 자식의 `PATH` 앞에 아무 일도 하지 않는 `open`을 두어 그 창을 막는다.
///
/// 실체는 `/usr/bin/true`를 가리키는 심링크다. 스크립트를 쓰지 않으므로 실행할 셸 문자열이
/// 생기지 않는다(`G9`). 로그인 터미널은 브라우저가 열려야 하는 자리라 이 경로를 쓰지 않는다.
#[cfg(unix)]
fn no_browser_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let directory = std::env::temp_dir().join("agent-manager-agy-no-browser");
        std::fs::create_dir_all(&directory).ok()?;
        let link = directory.join("open");
        match std::fs::read_link(&link) {
            Ok(target) if target == Path::new(NO_BROWSER_TARGET) => return Some(directory),
            Ok(_) => {
                std::fs::remove_file(&link).ok()?;
            }
            Err(_) if link.exists() => {
                std::fs::remove_file(&link).ok()?;
            }
            Err(_) => {}
        }
        std::os::unix::fs::symlink(NO_BROWSER_TARGET, &link).ok()?;
        Some(directory)
    })
    .as_deref()
}

/// Windows에서 CLI는 `rundll32 url.dll,FileProtocolHandler <url>`로 브라우저를 열고, 그
/// `rundll32`를 `PATH`에서 찾는다(`exec.LookPath`). 그래서 `PATH` 앞 디렉터리의 `rundll32.exe`가
/// macOS의 `open`처럼 가로챈다 — 항목을 비운 빈 프로필로 실측(2026-09-26): 셰임이 불렸고
/// 브라우저는 뜨지 않았으며 CLI는 코드 입력을 기다렸다.
///
/// 셰임의 실체는 **이 실행 파일 자신의 하드링크**다. Windows에는 `/usr/bin/true`가 없고,
/// `.cmd` 스크립트는 cmd.exe가 인자로 받은 OAuth URL의 `&`를 명령 구분자로 읽어 외부 문자열을
/// 셸이 실행하는 꼴이 되므로 쓸 수 없다(`G9`). 앱의 두 실행 파일(GUI, 헤드리스 백엔드)은
/// `main` 첫 줄에서 [`exit_if_invoked_as_browser_shim`]으로 그 호출을 알아보고 아무 일 없이
/// 0으로 끝난다. 하드링크는 권한 없이 만들 수 있고(C4-5), 설치 경로와 임시 디렉터리가 다른
/// 볼륨이면 복사로 되돌린다. 시험 바이너리에는 그 분기가 없으므로 시험에서는 만들지 않는다.
#[cfg(windows)]
fn no_browser_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        if cfg!(test) {
            return None;
        }
        let executable = std::env::current_exe().ok()?;
        let directory = std::env::temp_dir().join("agent-manager-agy-no-browser");
        match prepare_windows_no_browser_dir(&directory, &executable) {
            Ok(()) => Some(directory),
            Err(error) => {
                eprintln!("[antigravity] 브라우저 차단 셰임을 만들지 못했습니다: {error}");
                None
            }
        }
    })
    .as_deref()
}

/// CLI가 `PATH`에서 찾는 이름. 확장자까지 적어 `PATHEXT` 순서와 무관하게 이 파일이 잡힌다.
#[cfg(windows)]
const NO_BROWSER_SHIM_NAME: &str = "rundll32.exe";

/// `directory/rundll32.exe`를 `executable`의 하드링크로 둔다. 이미 같은 파일을 가리키면 그대로
/// 두고, 다른 파일(앱이 갱신됨)이면 갈아 끼운다. 하드링크가 안 되는 볼륨 경계에서는 복사하되,
/// 복사본은 크기가 같고 원본보다 새로우면 같은 것으로 본다 — 부팅마다 42MB를 다시 쓰지 않도록.
#[cfg(windows)]
fn prepare_windows_no_browser_dir(directory: &Path, executable: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let shim = directory.join(NO_BROWSER_SHIM_NAME);
    if shim.exists() {
        if windows_no_browser_shim_is_current(&shim, executable) {
            return Ok(());
        }
        std::fs::remove_file(&shim)?;
    }
    if std::fs::hard_link(executable, &shim).is_err() {
        std::fs::copy(executable, &shim)?;
    }
    Ok(())
}

#[cfg(windows)]
fn windows_no_browser_shim_is_current(shim: &Path, executable: &Path) -> bool {
    if same_file::is_same_file(shim, executable).unwrap_or(false) {
        return true;
    }
    let (Ok(shim_meta), Ok(exe_meta)) = (shim.metadata(), executable.metadata()) else {
        return false;
    };
    shim_meta.len() == exe_meta.len()
        && match (shim_meta.modified(), exe_meta.modified()) {
            (Ok(shim_time), Ok(exe_time)) => shim_time >= exe_time,
            _ => false,
        }
}

/// 브라우저 차단이 없는 나머지 플랫폼. `open`도 `rundll32`도 아닌 방식으로 여는지 확인된 바가
/// 없어 `PATH`를 바꾸지 않는다.
#[cfg(all(not(unix), not(windows)))]
fn no_browser_dir() -> Option<&'static Path> {
    None
}

/// CLI가 브라우저를 열려고 `rundll32 url.dll,FileProtocolHandler <url>`을 부를 때 넘기는 첫
/// 인자. 앱 실행 파일이 이 인자로 불렸다면 그것은 [`no_browser_dir`]의 셰임 호출이다.
pub const BROWSER_SHIM_FIRST_ARG: &str = "url.dll,FileProtocolHandler";

/// 첫 인자가 셰임 호출의 것인가. 두 실행 파일의 `main`이 다른 어떤 일보다 먼저 묻는다.
pub fn is_browser_shim_invocation<I>(args: I) -> bool
where
    I: IntoIterator,
    I::Item: AsRef<str>,
{
    args.into_iter()
        .next()
        .is_some_and(|first| first.as_ref() == BROWSER_SHIM_FIRST_ARG)
}

/// 셰임으로 불렸으면 아무 일 없이 0으로 끝난다. 브라우저를 여는 대신 조용히 성공한 것으로
/// 보이게 하는 것이 목적이라 종료 코드는 0이다 — macOS의 `/usr/bin/true`와 같다. 이 검사는
/// 프로세스가 창·서버·잠금 파일 어느 것도 만들기 전에 와야 한다.
pub fn exit_if_invoked_as_browser_shim() {
    if is_browser_shim_invocation(std::env::args().skip(1)) {
        std::process::exit(0);
    }
}

/// 아무 인자나 받고 조용히 성공하는 시스템 실행 파일.
#[cfg(unix)]
const NO_BROWSER_TARGET: &str = "/usr/bin/true";

/// 자식에게 넘길 `PATH`. 브라우저 차단 디렉터리를 앞에 세우고, 그 뒤는 이 실행 파일을 찾을 때
/// 쓰는 탐색 경로를 그대로 잇는다 — 셔뱅 인터프리터가 PATH에서 사라지면 CLI가 죽는다.
pub(crate) fn no_browser_path(executable: &Path) -> Option<(String, String)> {
    let directory = no_browser_dir()?;
    let inherited = crate::providers::command_search_path(executable)
        .unwrap_or_else(|| std::env::var_os("PATH").unwrap_or_default());
    let joined = std::env::join_paths(
        std::iter::once(directory.to_path_buf())
            .chain(std::env::split_paths(&inherited))
            .collect::<Vec<_>>(),
    )
    .ok()?;
    Some(("PATH".to_owned(), joined.to_string_lossy().into_owned()))
}

/// 배경 조회가 CLI 자동 업데이트까지 겸하지 않게 한다. `agy`는 주기마다 자기 자식으로
/// `agy --bg-updater`를 띄우는데, 부모에게 준 `CREATE_NO_WINDOW`는 손자에게 상속되지 않아
/// Windows에서는 손자가 새 콘솔을 할당받아 창이 잠깐 나타난다(실측 2026-09-24, 채팅 회차마다).
/// CLI 업데이트는 사람이 요청할 때 `cli_updates.rs`가 따로 맡으므로, 화면 뒤에서 도는 조회가
/// 겸할 이유도 없다.
pub(crate) fn no_auto_update_env() -> (String, String) {
    ("AGY_CLI_DISABLE_AUTO_UPDATE".to_owned(), "1".to_owned())
}

/// CLI 호출 차례. 잠금이 오염됐으면 그대로 이어 쓴다 — 줄 세우기는 최선 노력이고, 여기서
/// 실패를 올리면 사용량 조회 전체가 멈춘다.
pub(crate) fn cli_turn() -> MutexGuard<'static, ()> {
    let gate = CLI_GATE.get_or_init(|| Mutex::new(()));
    gate.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Default)]
struct CliUsageProbeState {
    /// 지금 CLI를 실행하고 있는 조회 수(Fresh 조회와 백그라운드 갱신 모두).
    in_flight: usize,
    last_failure: Option<(Instant, String)>,
}

/// 페이싱 자원 사용량을 어떻게 읽을지. 회차 계획과 AIA 조회는 정확한 값이 필요해 CLI
/// 응답을 기다리고, 화면 스냅샷은 캐시를 먼저 쓰고 뒤에서 갱신한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UsageFreshness {
    /// 캐시가 만료됐으면 공식 CLI 응답을 기다린다(최대 [`CLI_USAGE_TIMEOUT`]).
    Fresh,
    /// 캐시가 있으면 나이와 무관하게 바로 쓰고, 만료·부재는 백그라운드 갱신으로 채운다.
    CachedFirst,
}

#[derive(Debug, Deserialize)]
struct CliEnvelope {
    status: String,
    command: Option<CliCommand>,
}

#[derive(Debug, Deserialize)]
struct CliCommand {
    name: String,
    data: Option<CliUsageData>,
}

#[derive(Debug, Deserialize)]
struct CliUsageData {
    #[serde(default)]
    groups: Vec<CliUsageGroup>,
}

#[derive(Debug, Clone, Deserialize)]
struct CliUsageGroup {
    name: String,
    #[serde(default)]
    buckets: Vec<CliUsageBucket>,
    /// 공식 CLI를 실제로 호출한 시각. 캐시를 다시 읽을 때 바꾸지 않아 동일 표본이
    /// 화면 조회 횟수만큼 쌓이지 않게 한다.
    #[serde(skip)]
    updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct CliUsageBucket {
    id: String,
    window: String,
    remaining_fraction: f64,
    reset_time: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserStatusResponse {
    user_status: Option<UserStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserStatus {
    cascade_model_config_data: Option<CascadeModelConfigData>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CascadeModelConfigData {
    #[serde(default)]
    client_model_configs: Vec<ClientModelConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientModelConfig {
    label: Option<String>,
    quota_info: Option<QuotaInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaInfo {
    /// 남은 비율(0~1). 1이면 아직 쓰지 않았다.
    remaining_fraction: Option<f64>,
    /// ISO8601 리셋 시각.
    reset_time: Option<String>,
}

/// 실행 중인 language server의 접속 정보.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ServerEndpoint {
    port: u16,
    csrf_token: String,
}

/// 모델이 소비하는 Antigravity 페이싱 자원. 알 수 없는 모델을 제멋대로 한쪽 쿼터에
/// 귀속하면 다른 모델군의 여유를 잘못 쓰므로 거절한다.
fn resource_for_model(model: &str) -> Result<PacingResource, CoreError> {
    let model = model.trim().to_ascii_lowercase();
    if model.starts_with("gemini") {
        return Ok(PacingResource::Gemini);
    }
    if model.starts_with("claude") || model.starts_with("gpt") {
        return Ok(PacingResource::ThirdParty);
    }
    Err(CoreError::InvalidInput(format!(
        "Antigravity 모델 {model}의 사용량 그룹을 알 수 없습니다. gemini-, claude-, gpt- 모델을 지정하세요"
    )))
}

pub(crate) fn pacing_resource_id_for_model(model: &str) -> Result<&'static str, CoreError> {
    Ok(resource_for_model(model)?.id())
}

/// 이번 회차의 모델이 소비하는 **모델군 창**의 라벨(`Claude and GPT models · 7일` 꼴).
///
/// 계정 하나가 모델군 두 개의 쿼터를 따로 들고 있고, 계정 대표 창은 그중 **빡빡한 쪽**이다
/// ([`combined_usage`]). 대표 창을 계획 창으로 쓰면 한 모델군이 소진된 계정에서 다른
/// 모델군의 여유를 영영 쓰지 못하므로, 페이싱은 이 라벨로 계획한다.
///
/// 계정이 그 모델군 창을 보고하지 않으면 모델군 이름으로 만든 라벨을 돌려준다 — 계정
/// 대표 창으로 되돌아가면 다른 모델군의 소진을 이 모델군의 것으로 읽으므로, 찾지 못했다는
/// 사실이 계획의 제외 사유에 그대로 드러나는 편이 낫다.
///
/// 가리는 근거는 그룹 **이름**뿐이다. 창 라벨은 `{그룹 이름} · {창}`으로 만들어지므로
/// 버킷 id(`3p-`·`gemini-`)는 라벨에 남지 않는다([`combined_usage`]). 공급자가 키워드 없는
/// 이름으로 그룹을 바꾸면 이 조회가 비고, 그 회차는 "창을 찾을 수 없음"으로 쉰다 — 엉뚱한
/// 모델군의 쿼터를 쓰는 것보다 낫고, 이름이 바뀌면 [`resource_for_group_name`] 한 곳만 고친다.
pub(crate) fn model_window_label(
    usage: &AccountUsageView,
    model: &str,
    base_label: &str,
) -> Result<String, CoreError> {
    let resource = resource_for_model(model)?;
    let suffix = format!(" · {base_label}");
    Ok(usage
        .windows
        .iter()
        .filter(|window| window.model_scoped && window.label.ends_with(&suffix))
        .find(|window| resource_for_group_name(&window.label) == Some(resource))
        .map(|window| window.label.clone())
        .unwrap_or_else(|| format!("{} · {base_label}", resource.group_name())))
}

/// 이 모델의 실행이 그 창의 쿼터를 소비하는지.
///
/// 계정 하나가 모델군 두 개의 쿼터를 따로 들고 있으므로, 모델군 창(`Claude and GPT models ·
/// 7일`)을 채우는 것은 같은 모델군의 실행뿐이다. Gemini 회차가 도는 동안 Claude/GPT 창은
/// 손대지 않은 채로 있고, 그 반대도 같다.
///
/// 모델군 창이 아닌 라벨(계정 대표 창)은 어느 모델군이 돌든 그 소진을 싣고 있으므로 참이다.
/// 모델을 알 수 없으면(모델군을 가릴 수 없는 이름) 참 — 소비 여부를 모르는 실행을 "이 창과
/// 무관"으로 읽으면 같은 쿼터에 겹쳐 띄운다.
pub(crate) fn model_consumes_window(model: &str, window_label: &str) -> bool {
    let Some(group) = resource_for_group_name(window_label) else {
        return true;
    };
    resource_for_model(model).map_or(true, |resource| resource == group)
}

pub(crate) fn is_pacing_resource_id(value: &str) -> bool {
    PACING_RESOURCES
        .iter()
        .any(|resource| resource.id() == value)
}

/// 페이싱 화면과 계산에 넣을 모델군별 가상 계정. 인증 계정이 아니라 사용량 자원이며,
/// 실제 채팅 시작에서는 accountId로 사용하지 않는다. 조회가 실패해도 두 행을 돌려줘
/// 사용자가 풀 참여를 미리 설정할 수 있게 한다.
pub(crate) fn antigravity_pacing_accounts(freshness: UsageFreshness) -> Vec<ProviderAccountView> {
    let groups = match freshness {
        UsageFreshness::Fresh => cli_usage_groups_cached(CLI_USAGE_CACHE_MAX_AGE),
        UsageFreshness::CachedFirst => cli_usage_groups_stale_ok(CLI_USAGE_CACHE_MAX_AGE),
    };
    PACING_RESOURCES
        .into_iter()
        .map(|resource| {
            let usage = usage_for_resource(&groups, resource);
            resource.into_account(usage)
        })
        .collect()
}

/// 페이싱 자원 id 전부. 주기 이력 조회처럼 계정 목록만으로는 이 자원을 찾을 수 없는
/// 쪽이 함께 물어볼 때 쓴다.
pub(crate) fn pacing_resource_ids() -> Vec<String> {
    PACING_RESOURCES
        .iter()
        .map(|resource| resource.id().to_owned())
        .collect()
}

/// 페이싱 자원 하나의 사용량을 표본과 주기 이력에 남긴다. Antigravity 자원은 계정
/// 레지스트리에 없어 `AccountsService::refresh_usage`의 기록 지점을 지나지 않으므로,
/// 자원 사용량을 읽는 쪽이 모두 이 함수를 거쳐 계정과 같은 두 저장소를 채운다. 실패는
/// 각 저장소가 경고만 남긴다 — 둘 다 파생 데이터다.
pub(crate) fn record_pacing_usage(
    app_data_dir: &Path,
    resource_id: &str,
    usage: &AccountUsageView,
) {
    crate::usage_pacing::record_usage_sample(app_data_dir, resource_id, usage);
    crate::usage_history::record_usage(app_data_dir, resource_id, usage);
}

/// [`antigravity_pacing_accounts`]에 기록을 붙인 것. 조회한 값을 그 자리에서 표본·주기
/// 이력에 남겨, 자원 행을 쓰는 화면이 늘어도 기록 지점이 갈라지지 않게 한다.
pub(crate) fn pacing_accounts_recorded(
    app_data_dir: &Path,
    freshness: UsageFreshness,
) -> Vec<ProviderAccountView> {
    let accounts = antigravity_pacing_accounts(freshness);
    for resource in &accounts {
        record_pacing_usage(app_data_dir, &resource.id, &resource.usage);
    }
    accounts
}

/// 한 페이싱 자원의 최신 창. 턴 종료 훅이 선택한 모델군만 다시 표본으로 남길 때 쓴다.
pub(crate) fn antigravity_pacing_usage(resource_id: &str) -> AccountUsageView {
    let Some(resource) = PACING_RESOURCES
        .iter()
        .copied()
        .find(|resource| resource.id() == resource_id)
    else {
        return error_usage("알 수 없는 Antigravity 페이싱 자원입니다");
    };
    probe_started();
    usage_for_resource(&run_cli_usage_probe(), resource)
}

/// 조회 결과에서 한 페이싱 자원의 사용량을 뽑는다. 조회 실패와 "그룹이 응답에 없음"은
/// 자원 행 하나가 값을 못 받았다는 같은 뜻이라, 어느 쪽이든 사유를 담은 오류 뷰로 낸다 —
/// 자원 행 자체는 남아야 사용자가 풀 참여를 미리 설정할 수 있다.
fn usage_for_resource(
    groups: &Result<Vec<CliUsageGroup>, CoreError>,
    resource: PacingResource,
) -> AccountUsageView {
    match groups {
        Ok(groups) => groups
            .iter()
            .find(|group| resource_for_group(group) == Some(resource))
            .map(usage_from_group)
            .unwrap_or_else(|| {
                error_usage("Antigravity /usage 응답에서 모델 그룹을 찾지 못했습니다")
            }),
        Err(error) => error_usage(&error.to_string()),
    }
}

/// 지금 조회할 수 있는 Antigravity 사용량. 새 CLI에서는 `/usage`의 두 모델군을 합쳐
/// 화면 대표값을 만들고, 구형 CLI에서 명령이 없을 때만 language server 모델 쿼터로
/// 되돌아간다.
pub fn antigravity_usage() -> AccountUsageView {
    display_usage(cli_usage_groups_cached(DISPLAY_USAGE_CACHE_MAX_AGE))
}

/// 사이드바처럼 주기적으로 읽는 화면용 Antigravity 사용량. 캐시가 있으면 나이와 무관하게
/// 바로 돌려주고, 만료·부재는 백그라운드 갱신으로 채운다. [`antigravity_usage`]는 표시
/// 캐시(30초)가 지나면 CLI 응답을 기다리므로, 그보다 긴 주기로 폴링하는 화면이 그 길을
/// 쓰면 폴링마다 CLI를 새로 띄운다. 첫 조회는 캐시가 비어 "조회 중" 오류로 끝나고 다음
/// 폴링부터 값이 온다.
pub fn antigravity_usage_cached_first() -> AccountUsageView {
    display_usage(cli_usage_groups_stale_ok(CLI_USAGE_CACHE_MAX_AGE))
}

/// CLI 조회 결과를 화면 대표값으로 바꾼다. CLI가 실패하면 구형 CLI 호환용 language server
/// 조회로 되돌아가고, 그것도 없으면 CLI 오류를 그대로 낸다.
fn display_usage(groups: Result<Vec<CliUsageGroup>, CoreError>) -> AccountUsageView {
    match groups {
        Ok(groups) => combined_usage(&groups),
        Err(cli_error) => {
            let fallback = language_server_usage();
            if fallback.status == AccountUsageStatus::Ok {
                fallback
            } else {
                error_usage(&cli_error.to_string())
            }
        }
    }
}

/// 공유 홈에 공식 CLI 로그인 자격증명이 있는지. 홈을 모르면 판단을 유보하고 통과시켜,
/// 로그인돼 있는데도 사용량이 빠지는 쪽으로는 틀리지 않게 한다.
///
/// `agy`는 print 모드에서도 자격증명이 없으면 "silent auth failed" 뒤에 대화형 OAuth로 넘어가
/// 시스템 브라우저에 구글 로그인 창을 띄우고 60초를 기다린다(printmode.go). 그 전에 여기서
/// 걸러 CLI를 아예 띄우지 않는다. 토큰 파일 자리는 계정 프로필 조립과 같은 목록을 본다 —
/// 한쪽만 파일명을 따라가면 사용량은 빠지는데 프로필은 통과하는 식으로 어긋난다.
///
/// 파일만 보면 안 된다. CLI는 OS 보안 저장소를 쓸 수 있으면 **파일을 남기지 않으므로**,
/// Windows 자격 증명 관리자나 macOS 로그인 키체인에 토큰을 둔 정상 로그인이 여기서
/// "미로그인"으로 판정돼 사용량 조회가 통째로 막혔다(2026-09-24 Windows 실측:
/// `~/.gemini`에 토큰 파일이 하나도 없는데 `agy --print /usage`는 즉시 성공한다).
fn cli_login_present(home: Option<&Path>) -> bool {
    login_present(home, || {
        crate::credential_profiles::antigravity_os_store_login_present()
    })
}

/// [`cli_login_present`]의 판정부. OS 보안 저장소 조회는 기계 상태에 달려 있어 시험에서
/// 고정할 수 없으므로 인자로 받는다 — 개발자 기기에 실제 로그인 항목이 있으면 "빈 홈은
/// 막힌다"는 시험이 기계에 따라 뒤집힌다.
fn login_present(home: Option<&Path>, os_store_present: impl FnOnce() -> bool) -> bool {
    let Some(home) = home else {
        return true;
    };
    crate::credential_profiles::antigravity_login_present(home) || os_store_present()
}

/// 계정 하나의 사용량. 홈을 그 계정 것으로 바꿔 `/usage`를 묻는다 — Antigravity에는 계정을
/// 인자로 받는 조회가 없어 홈이 곧 계정이다.
///
/// 실패해도 language server 조회로 되돌아가지 않는다. 그 경로는 기계 전역 값이라, 계정별
/// 조회에서 쓰면 다른 계정의 잔량을 그 계정 것으로 보여 준다.
pub(crate) fn account_usage(home: &Path, env: &[(String, String)]) -> AccountUsageView {
    // 로그인 여부는 호출자가 먼저 본다. 여기서 파일만 다시 확인하면, 토큰을 키체인에만 두는
    // 설치에서 로그인된 계정을 미로그인으로 판정한다(`C12-4a`).
    let _ = home;
    match cli_usage_groups_with_env(env) {
        Ok(groups) => combined_usage(&groups),
        Err(error) => error_usage(&error.to_string()),
    }
}

fn cli_usage_groups() -> Result<Vec<CliUsageGroup>, CoreError> {
    let executable = antigravity_cli()?;
    if !cli_login_present(crate::user_home::optional_home_dir().as_deref()) {
        return Err(CoreError::Runtime(
            "Antigravity CLI가 로그인되어 있지 않습니다".to_owned(),
        ));
    }
    cli_usage_outcome(&executable, &[])
}

/// 홈을 바꿔 묻는 갈래. 공유 홈 조회와 계정별 조회가 같은 인자·시한·판정을 쓰도록 모았다.
fn cli_usage_groups_with_env(env: &[(String, String)]) -> Result<Vec<CliUsageGroup>, CoreError> {
    let executable = antigravity_cli()?;
    cli_usage_outcome(&executable, env)
}

fn antigravity_cli() -> Result<PathBuf, CoreError> {
    crate::providers::detect_provider_cli(ProviderId::Antigravity)?
        .ok_or_else(|| CoreError::NotFound("Antigravity CLI가 설치되어 있지 않습니다".to_owned()))
}

fn cli_usage_outcome(
    executable: &Path,
    env: &[(String, String)],
) -> Result<Vec<CliUsageGroup>, CoreError> {
    let _turn = cli_turn();
    // 배경 조회는 사람의 로그인을 기다리는 자리가 아니다. 인증이 안 되면 창을 띄우는 대신
    // 그대로 실패하게 둔다.
    let mut env = env.to_vec();
    env.extend(no_browser_path(executable));
    env.push(no_auto_update_env());
    let outcome = crate::cli_interface::run_capped_with_env(
        executable,
        &["--print", "/usage", "--output-format", "json"],
        CLI_USAGE_TIMEOUT,
        &env,
    )?;
    if outcome.timed_out {
        return Err(CoreError::Runtime(
            "Antigravity /usage 조회 시간이 초과되었습니다".to_owned(),
        ));
    }
    if !outcome.success {
        return Err(CoreError::Runtime(
            "Antigravity /usage 조회가 실패했습니다".to_owned(),
        ));
    }
    parse_cli_usage_groups(&outcome.stdout)
}

fn cli_usage_groups_cached(max_age: Duration) -> Result<Vec<CliUsageGroup>, CoreError> {
    if let Some(groups) = cached_cli_usage_groups(max_age)? {
        return Ok(groups);
    }
    // 캐시 잠금을 쥔 채 CLI 응답을 기다리지 않는다. 비차단 읽기(`CachedFirst`)가 같은 잠금을
    // 읽으므로, 대시보드의 Fresh 조회가 미로그인 환경에서 30초를 기다리는 동안 예산 스냅샷도
    // 같은 시간을 멈춰 있었다.
    probe_started();
    run_cli_usage_probe()
}

/// 캐시에 `max_age` 안의 값이 있으면 돌려준다. 잠금은 읽는 동안만 쥔다.
fn cached_cli_usage_groups(max_age: Duration) -> Result<Option<Vec<CliUsageGroup>>, CoreError> {
    let guard = lock_cache()?;
    Ok(guard
        .as_ref()
        .filter(|entry| entry.saved_at.elapsed() <= max_age)
        .map(|entry| entry.groups.clone()))
}

fn cache_state() -> &'static Mutex<Option<CliUsageCacheEntry>> {
    CLI_USAGE_CACHE.get_or_init(|| Mutex::new(None))
}

fn probe_state() -> &'static Mutex<CliUsageProbeState> {
    CLI_USAGE_PROBE.get_or_init(|| Mutex::new(CliUsageProbeState::default()))
}

/// 전역 상태 잠금은 이 두 함수로만 잡는다. 손상 메시지를 호출부마다 적어 두면 같은
/// 사고가 문구만 다르게 보고되고, 잠금 순서(캐시 → 진행 상태)도 호출부에 흩어진다.
fn lock_cache() -> Result<MutexGuard<'static, Option<CliUsageCacheEntry>>, CoreError> {
    cache_state()
        .lock()
        .map_err(|_| CoreError::Runtime("Antigravity 사용량 캐시 잠금이 손상되었습니다".to_owned()))
}

fn lock_probe() -> Result<MutexGuard<'static, CliUsageProbeState>, CoreError> {
    probe_state().lock().map_err(|_| {
        CoreError::Runtime("Antigravity 사용량 갱신 상태 잠금이 손상되었습니다".to_owned())
    })
}

fn probe_started() {
    if let Ok(mut probe) = probe_state().lock() {
        probe.in_flight += 1;
    }
}

fn probe_finished(failure: Option<String>) {
    if let Ok(mut probe) = probe_state().lock() {
        probe.in_flight = probe.in_flight.saturating_sub(1);
        probe.last_failure = failure.map(|error| (Instant::now(), error));
    }
}

/// 공식 CLI를 한 번 호출해 캐시를 채우고 진행 중 표시를 내린다. Fresh 조회·턴 종료 훅·
/// 백그라운드 갱신이 모두 이 길을 지나므로 실패 기록과 진행 중 개수가 한곳에서 맞는다.
/// 호출 전에 [`probe_started`]로 진행 중 표시를 올려 둔다.
fn run_cli_usage_probe() -> Result<Vec<CliUsageGroup>, CoreError> {
    let result = refresh_cli_usage_groups();
    probe_finished(result.as_ref().err().map(|error| error.to_string()));
    result
}

fn refresh_cli_usage_groups() -> Result<Vec<CliUsageGroup>, CoreError> {
    let groups = cli_usage_groups()?;
    let mut guard = lock_cache()?;
    *guard = Some(CliUsageCacheEntry {
        saved_at: Instant::now(),
        groups: groups.clone(),
    });
    Ok(groups)
}

/// 캐시가 있으면 오래됐어도 바로 돌려주고, 만료됐으면 뒤에서 한 번 갱신한다. 캐시가 없으면
/// 갱신만 띄우고 "조회 중"으로 답한다. 예산 스냅샷 같은 화면 조회가 공식 CLI의 응답을
/// 기다리며 서버 요청을 붙잡지 않게 한다 — 미로그인·격리 환경에서는 `/usage`가 매번
/// [`CLI_USAGE_TIMEOUT`]까지 걸려 페이싱 탭이 열리지 않았다. 실패는
/// [`CLI_USAGE_FAILURE_RETRY`] 동안 다시 띄우지 않는다.
fn cli_usage_groups_stale_ok(max_age: Duration) -> Result<Vec<CliUsageGroup>, CoreError> {
    let (outcome, spawn_refresh) = {
        let cache_guard = lock_cache()?;
        let mut probe_guard = lock_probe()?;
        let plan = stale_read_plan(cache_guard.as_ref(), &probe_guard, Instant::now(), max_age);
        if plan.1 {
            probe_guard.in_flight += 1;
        }
        plan
    };
    if spawn_refresh {
        spawn_cli_usage_refresh();
    }
    outcome.map_err(CoreError::Runtime)
}

/// 비차단 읽기의 판정. 돌려줄 값과 갱신 스레드를 띄울지를 정하며, 잠금·스레드 없이
/// 검증할 수 있게 순수 함수로 둔다.
fn stale_read_plan(
    cache: Option<&CliUsageCacheEntry>,
    probe: &CliUsageProbeState,
    now: Instant,
    max_age: Duration,
) -> (Result<Vec<CliUsageGroup>, String>, bool) {
    let recent_failure = probe
        .last_failure
        .as_ref()
        .filter(|(at, _)| now.saturating_duration_since(*at) < CLI_USAGE_FAILURE_RETRY);
    match cache {
        Some(entry) => {
            let expired = now.saturating_duration_since(entry.saved_at) > max_age;
            let spawn = expired && probe.in_flight == 0 && recent_failure.is_none();
            (Ok(entry.groups.clone()), spawn)
        }
        None => match recent_failure {
            Some((_, error)) => (Err(error.clone()), false),
            None => (
                Err(CLI_USAGE_PENDING_MESSAGE.to_owned()),
                probe.in_flight == 0,
            ),
        },
    }
}

/// 공식 CLI를 별도 스레드에서 한 번 호출해 캐시를 채운다. 진행 중 표시는 호출 쪽이 이미
/// 올렸고, 끝나면 [`run_cli_usage_probe`]가 내린다.
fn spawn_cli_usage_refresh() {
    let spawned = std::thread::Builder::new()
        .name("antigravity-usage-refresh".to_owned())
        .spawn(|| {
            let _ = run_cli_usage_probe();
        });
    if let Err(error) = spawned {
        // 스레드를 못 띄우면 다음 조회가 다시 시도할 수 있게 표시를 되돌린다.
        probe_finished(Some(format!(
            "Antigravity 사용량 갱신 스레드를 시작하지 못했습니다: {error}"
        )));
    }
}

fn parse_cli_usage_groups(stdout: &str) -> Result<Vec<CliUsageGroup>, CoreError> {
    let envelope: CliEnvelope = serde_json::from_str(stdout).map_err(|error| {
        CoreError::Runtime(format!(
            "Antigravity /usage JSON을 해석하지 못했습니다: {error}"
        ))
    })?;
    let command = envelope.command.ok_or_else(|| {
        CoreError::Runtime("Antigravity /usage 응답에 command가 없습니다".to_owned())
    })?;
    if envelope.status != "SUCCESS" || command.name != "usage" {
        return Err(CoreError::Runtime(
            "Antigravity /usage 응답이 성공 상태가 아닙니다".to_owned(),
        ));
    }
    let mut groups = command.data.map(|data| data.groups).unwrap_or_default();
    if groups.is_empty() {
        return Err(CoreError::Runtime(
            "Antigravity /usage 응답에 모델 그룹이 없습니다".to_owned(),
        ));
    }
    let updated_at = now_ms();
    for group in &mut groups {
        group.updated_at = updated_at;
    }
    Ok(groups)
}

fn resource_for_group(group: &CliUsageGroup) -> Option<PacingResource> {
    if group
        .buckets
        .iter()
        .any(|bucket| bucket.id.starts_with("gemini-"))
    {
        return Some(PacingResource::Gemini);
    }
    if group
        .buckets
        .iter()
        .any(|bucket| bucket.id.starts_with("3p-"))
    {
        return Some(PacingResource::ThirdParty);
    }
    resource_for_group_name(&group.name)
}

/// 모델군 이름만 보고 가린다. 창 라벨은 이 이름을 그대로 앞에 달고 있어(`{그룹} · {창}`)
/// 그룹 응답과 라벨이 같은 판정을 쓴다.
fn resource_for_group_name(name: &str) -> Option<PacingResource> {
    let name = name.to_ascii_lowercase();
    if name.contains("gemini") {
        return Some(PacingResource::Gemini);
    }
    if name.contains("claude") || name.contains("gpt") {
        return Some(PacingResource::ThirdParty);
    }
    None
}

fn normalized_window_label(bucket: &CliUsageBucket) -> Option<&'static str> {
    match bucket.window.as_str() {
        "weekly" => Some("7일"),
        "5h" => Some("5시간"),
        _ => None,
    }
}

fn usage_from_group(group: &CliUsageGroup) -> AccountUsageView {
    let mut windows: Vec<AccountUsageWindow> = group
        .buckets
        .iter()
        .filter_map(|bucket| {
            // 아직 소비가 없는 버킷의 `reset_time`은 조회 시각 + 창 길이라 조회마다
            // 밀린다. Codex와 같은 값이므로 같은 규칙으로 지운다 — 그대로 두면 페이싱이
            // 밀리는 값을 창 리셋으로 읽어 예약과 첫 회차의 소비 실측을 버린다.
            Some(crate::accounts::without_unstarted_reset(
                AccountUsageWindow {
                    label: normalized_window_label(bucket)?.to_owned(),
                    used_percent: used_percent_from_remaining(bucket.remaining_fraction),
                    resets_at: bucket.reset_time.as_deref().and_then(parse_reset_time),
                    model_scoped: false,
                    aggregate: false,
                },
            ))
        })
        .collect();
    windows.sort_by_key(|window| match window.label.as_str() {
        "5시간" => 0,
        "7일" => 1,
        _ => 2,
    });
    usage_from_windows(windows, group.updated_at)
}

/// 남은 비율을 소진율(%)로. CLI와 language server가 모두 남은 비율로 주므로 환산과
/// 범위 정리를 한 곳에서 한다 — 응답이 범위를 살짝 벗어나도 화면과 페이싱은 0~100만 본다.
fn used_percent_from_remaining(remaining_fraction: f64) -> f64 {
    ((1.0 - remaining_fraction) * 100.0).clamp(0.0, 100.0)
}

/// 가장 많이 쓴 창. 다음 실행을 실제로 막는 것이 이 창이라 대표값은 언제나 여기서 온다.
fn tightest_window<'a>(
    windows: impl Iterator<Item = &'a AccountUsageWindow>,
) -> Option<&'a AccountUsageWindow> {
    windows.max_by(|left, right| left.used_percent.total_cmp(&right.used_percent))
}

/// 소진율과 리셋 시각은 그대로 두고 라벨과 모델 한정 여부만 바꿔 창을 복제한다.
fn relabeled_window(
    window: &AccountUsageWindow,
    label: String,
    model_scoped: bool,
) -> AccountUsageWindow {
    AccountUsageWindow {
        label,
        used_percent: window.used_percent,
        resets_at: window.resets_at,
        model_scoped,
        aggregate: false,
    }
}

/// 창 목록으로 사용량 뷰를 만든다. 창이 하나도 없으면 조회는 됐지만 쓸 값이 없는
/// 것이므로 정상으로 두지 않는다 — 페이싱이 빈 창을 여유로 읽지 않게 한다.
fn usage_from_windows(windows: Vec<AccountUsageWindow>, updated_at: i64) -> AccountUsageView {
    AccountUsageView {
        status: if windows.is_empty() {
            AccountUsageStatus::Unavailable
        } else {
            AccountUsageStatus::Ok
        },
        windows,
        updated_at: Some(updated_at),
        ..Default::default()
    }
}

fn combined_usage(groups: &[CliUsageGroup]) -> AccountUsageView {
    let group_usages: Vec<(&CliUsageGroup, AccountUsageView)> = groups
        .iter()
        .filter(|group| resource_for_group(group).is_some())
        .map(|group| (group, usage_from_group(group)))
        .collect();
    let mut windows = Vec::new();
    for label in ["5시간", "7일"] {
        if let Some(tightest) = tightest_window(
            group_usages
                .iter()
                .filter_map(|(_, usage)| window_by_label(usage, label)),
        ) {
            // 모델군 창의 복사본이라는 사실을 실어 보낸다. 소진 판정이 이 창을 세면 한
            // 모델군이 찬 계정이 다른 모델군의 여유를 두고도 통째로 막힌다.
            windows.push(AccountUsageWindow {
                aggregate: true,
                ..tightest.clone()
            });
        }
    }
    for (group, usage) in &group_usages {
        windows.extend(usage.windows.iter().map(|window| {
            relabeled_window(window, format!("{} · {}", group.name, window.label), true)
        }));
    }
    if windows.is_empty() {
        return error_usage("Antigravity /usage 응답에 지원하는 모델 그룹 창이 없습니다");
    }
    // 창이 남았다는 것은 그룹이 하나 이상 있었다는 뜻이라 `max()`는 항상 값을 준다.
    let updated_at = groups
        .iter()
        .map(|group| group.updated_at)
        .max()
        .unwrap_or_else(now_ms);
    usage_from_windows(windows, updated_at)
}

fn window_by_label<'a>(usage: &'a AccountUsageView, label: &str) -> Option<&'a AccountUsageWindow> {
    usage.windows.iter().find(|window| window.label == label)
}

fn error_usage(message: &str) -> AccountUsageView {
    AccountUsageView {
        status: AccountUsageStatus::Error,
        error: Some(message.to_owned()),
        updated_at: Some(now_ms()),
        ..Default::default()
    }
}

fn language_server_usage() -> AccountUsageView {
    match find_endpoint() {
        None => AccountUsageView {
            status: AccountUsageStatus::Idle,
            error: Some(
                "Antigravity language server가 실행 중이 아니어서 사용량을 읽을 수 없습니다"
                    .to_owned(),
            ),
            ..Default::default()
        },
        Some(endpoint) => match fetch_windows(&endpoint) {
            Ok(windows) => usage_from_windows(windows, now_ms()),
            Err(error) => error_usage(&error.to_string()),
        },
    }
}

/// 응답에서 창 목록을 만든다. 모델별 창은 표시용이라 라벨 순으로 고정하고, 가장 빡빡한
/// 모델을 대표 창으로 앞에 둔다.
fn windows_from_response(response: &UserStatusResponse) -> Vec<AccountUsageWindow> {
    let configs = response
        .user_status
        .as_ref()
        .and_then(|status| status.cascade_model_config_data.as_ref())
        .map(|data| data.client_model_configs.as_slice())
        .unwrap_or_default();
    let mut windows: Vec<AccountUsageWindow> = configs
        .iter()
        .filter_map(|config| {
            let quota = config.quota_info.as_ref()?;
            let remaining = quota.remaining_fraction?;
            Some(AccountUsageWindow {
                label: config.label.clone().unwrap_or_else(|| "모델".to_owned()),
                used_percent: used_percent_from_remaining(remaining),
                resets_at: quota.reset_time.as_deref().and_then(parse_reset_time),
                model_scoped: true,
                aggregate: false,
            })
        })
        .collect();
    // language server가 주는 모델 순서는 조회마다 뒤바뀐다. 그대로 두면 같은 값인데도
    // 목록이 흔들려 어느 줄이 어느 모델인지 눈으로 좇을 수 없으므로 라벨로 고정한다.
    windows.sort_by(|left, right| left.label.cmp(&right.label));
    // 가장 많이 쓴 모델이 실제로 다음 실행을 막는다. 대표 창은 그 값을 쓴다.
    if let Some(summary) = tightest_window(windows.iter())
        .map(|tightest| relabeled_window(tightest, SUMMARY_WINDOW_LABEL.to_owned(), false))
    {
        windows.insert(0, summary);
    }
    windows
}

/// ISO8601 리셋 시각을 epoch ms로. 형식이 예상과 다르면 창은 남기고 시각만 버린다 —
/// 리셋 시각을 몰라도 소진율은 쓸 수 있다.
fn parse_reset_time(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|value| value.timestamp_millis())
}

fn fetch_windows(endpoint: &ServerEndpoint) -> Result<Vec<AccountUsageWindow>, CoreError> {
    let body = post(endpoint, STATUS_METHOD, PROBE_TIMEOUT)?;
    let response: UserStatusResponse = serde_json::from_str(&body).map_err(|error| {
        CoreError::Runtime(format!(
            "Antigravity 사용량 응답을 해석하지 못했습니다: {error}"
        ))
    })?;
    let windows = windows_from_response(&response);
    if windows.is_empty() {
        return Err(CoreError::Runtime(
            "Antigravity 사용량 응답에 모델 쿼터가 없습니다".to_owned(),
        ));
    }
    Ok(windows)
}

/// loopback 자기서명 인증서라 검증을 끈다. 호스트가 `127.0.0.1`로 고정되어 있어 이
/// 예외가 다른 대상에 쓰이지 않는다.
fn post(endpoint: &ServerEndpoint, method: &str, timeout: Duration) -> Result<String, CoreError> {
    let client = reqwest::blocking::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(timeout)
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!("HTTP 클라이언트를 만들지 못했습니다: {error}"))
        })?;
    let response = client
        .post(format!("https://127.0.0.1:{}{method}", endpoint.port))
        .header("Content-Type", "application/json")
        .header("X-Codeium-Csrf-Token", &endpoint.csrf_token)
        .header("Connect-Protocol-Version", "1")
        .json(&json!({"wrapper_data": {}}))
        .send()
        .map_err(|error| {
            CoreError::Runtime(format!(
                "Antigravity language server 요청이 실패했습니다: {error}"
            ))
        })?;
    if !response.status().is_success() {
        return Err(CoreError::Runtime(format!(
            "Antigravity language server가 {}로 응답했습니다",
            response.status()
        )));
    }
    response.text().map_err(|error| {
        CoreError::Runtime(format!("Antigravity 응답 본문을 읽지 못했습니다: {error}"))
    })
}

/// 응답하는 language server 하나를 찾는다. 여러 개가 떠 있으면(IDE와 CLI가 각자 띄운
/// 경우) 먼저 응답한 것을 쓴다 — 같은 계정의 같은 쿼터를 보므로 어느 쪽이든 같다.
fn find_endpoint() -> Option<ServerEndpoint> {
    for (pid, csrf_token) in language_server_processes() {
        for port in listening_ports(pid) {
            let candidate = ServerEndpoint {
                port,
                csrf_token: csrf_token.clone(),
            };
            if post(&candidate, HEALTH_METHOD, PORT_PROBE_TIMEOUT).is_ok() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 실행 중인 language server의 (PID, CSRF 토큰). 토큰은 프로세스 인자에 그대로 있어
/// 별도 자격증명 저장이 필요 없다.
fn language_server_processes() -> Vec<(u32, String)> {
    let Some(output) = run(Command::new("ps").args(["-Ao", "pid=,args="])) else {
        return Vec::new();
    };
    output
        .lines()
        .filter(|line| line.contains("language_server"))
        .filter_map(parse_process_line)
        .collect()
}

fn parse_process_line(line: &str) -> Option<(u32, String)> {
    let mut fields = line.split_whitespace();
    let pid = fields.next()?.parse::<u32>().ok()?;
    let mut rest = fields;
    while let Some(field) = rest.next() {
        if field == "--csrf_token" {
            return rest.next().map(|token| (pid, token.to_owned()));
        }
        if let Some(token) = field.strip_prefix("--csrf_token=") {
            return Some((pid, token.to_owned()));
        }
    }
    None
}

/// 그 PID가 듣고 있는 loopback TCP 포트. 서버는 포트를 매번 새로 받으므로 고정 값을
/// 쓸 수 없다.
fn listening_ports(pid: u32) -> Vec<u16> {
    let Some(output) = run(Command::new("lsof").args([
        "-nP",
        "-iTCP",
        "-sTCP:LISTEN",
        "-a",
        "-p",
        &pid.to_string(),
    ])) else {
        return Vec::new();
    };
    let mut ports: Vec<u16> = output.lines().filter_map(parse_listen_port).collect();
    ports.dedup();
    ports
}

fn parse_listen_port(line: &str) -> Option<u16> {
    let address = line.split_whitespace().find(|field| field.contains(':'))?;
    address.rsplit(':').next()?.parse().ok()
}

fn run(command: &mut Command) -> Option<String> {
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_shim_invocation_is_recognised_by_its_first_argument_only() {
        assert!(is_browser_shim_invocation([
            "url.dll,FileProtocolHandler",
            "https://accounts.google.com/o/oauth2/v2/auth?a=1&state=2",
        ]));
        assert!(!is_browser_shim_invocation(["--backend"]));
        assert!(!is_browser_shim_invocation([
            "--port",
            "url.dll,FileProtocolHandler"
        ]));
        assert!(!is_browser_shim_invocation(Vec::<String>::new()));
    }

    /// 셰임은 실행 파일의 하드링크여야 하고, 실행 파일이 바뀌면 따라 바뀌어야 한다.
    #[cfg(windows)]
    #[test]
    fn windows_no_browser_shim_links_the_current_executable_and_follows_updates() {
        let root = tempfile::tempdir().expect("tempdir");
        let exe = root.path().join("app.exe");
        std::fs::write(&exe, b"first build").expect("exe");
        let directory = root.path().join("shim");
        prepare_windows_no_browser_dir(&directory, &exe).expect("prepare");
        let shim = directory.join(NO_BROWSER_SHIM_NAME);
        assert!(same_file::is_same_file(&shim, &exe).expect("same file"));
        // 다시 불러도 그대로다.
        prepare_windows_no_browser_dir(&directory, &exe).expect("prepare again");
        assert!(same_file::is_same_file(&shim, &exe).expect("still same"));
        // 앱이 갱신되면(다른 파일) 셰임도 새 파일을 가리킨다.
        std::fs::remove_file(&exe).expect("remove old");
        std::fs::write(&exe, b"second build, longer").expect("new exe");
        prepare_windows_no_browser_dir(&directory, &exe).expect("prepare after update");
        assert!(same_file::is_same_file(&shim, &exe).expect("follows update"));
    }

    #[test]
    fn login_check_blocks_cli_spawn_when_home_has_no_token() {
        // 격리 E2E 백엔드는 빈 임시 HOME으로 뜬다. 여기서 CLI를 띄우면 agy가 구글 로그인
        // 창을 브라우저에 연다.
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(!login_present(Some(dir.path()), || false));
    }

    #[test]
    fn login_check_accepts_either_token_location() {
        for relative in crate::credential_profiles::ANTIGRAVITY_TOKEN_RELATIVE_PATHS {
            let dir = tempfile::tempdir().expect("tempdir");
            let token = dir.path().join(relative);
            std::fs::create_dir_all(token.parent().expect("parent")).expect("mkdir");
            std::fs::write(&token, "{}").expect("write");
            assert!(login_present(Some(dir.path()), || false), "{relative}");
        }
    }

    #[test]
    fn login_check_accepts_os_store_without_token_files() {
        // CLI가 OS 보안 저장소를 쓰면 토큰 파일을 남기지 않는다. 파일만 보고 막으면
        // 로그인된 기기에서 사용량이 통째로 빠진다.
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(login_present(Some(dir.path()), || true));
    }

    #[test]
    fn login_check_passes_when_home_is_unknown() {
        // 홈을 모르면 미로그인으로 단정하지 않는다. 로그인된 기기에서 사용량이 통째로
        // 빠지는 쪽보다 CLI에 판단을 맡기는 쪽이 낫다.
        assert!(login_present(None, || false));
    }

    fn cli_usage_fixture() -> Vec<CliUsageGroup> {
        parse_cli_usage_groups(
            r#"{
                "status":"SUCCESS",
                "command":{"name":"usage","data":{"groups":[
                    {"name":"Gemini Models","buckets":[
                        {"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.75,"reset_time":"2026-09-08T00:00:00Z"},
                        {"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.5,"reset_time":"2026-09-04T15:00:00Z"}
                    ]},
                    {"name":"Claude and GPT models","buckets":[
                        {"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.4,"reset_time":"2026-09-08T00:00:00Z"},
                        {"id":"3p-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.2,"reset_time":"2026-09-04T15:00:00Z"}
                    ]}
                ]}}
            }"#,
        )
        .expect("CLI fixture")
    }

    fn cache_entry(saved_at: Instant) -> CliUsageCacheEntry {
        CliUsageCacheEntry {
            saved_at,
            groups: cli_usage_fixture(),
        }
    }

    #[test]
    fn stale_read_without_cache_reports_pending_and_starts_one_refresh() {
        let now = Instant::now();
        let idle = CliUsageProbeState::default();
        let (outcome, spawn) = stale_read_plan(None, &idle, now, CLI_USAGE_CACHE_MAX_AGE);
        assert_eq!(outcome.unwrap_err(), CLI_USAGE_PENDING_MESSAGE);
        assert!(spawn, "캐시가 없으면 갱신을 시작해야 한다");

        let busy = CliUsageProbeState {
            in_flight: 1,
            last_failure: None,
        };
        let (outcome, spawn) = stale_read_plan(None, &busy, now, CLI_USAGE_CACHE_MAX_AGE);
        assert_eq!(outcome.unwrap_err(), CLI_USAGE_PENDING_MESSAGE);
        assert!(!spawn, "갱신이 돌고 있으면 겹쳐 띄우지 않는다");
    }

    #[test]
    fn stale_read_serves_an_expired_cache_and_refreshes_in_the_background() {
        let saved_at = Instant::now();
        let entry = cache_entry(saved_at);
        let idle = CliUsageProbeState::default();

        let fresh_now = saved_at + Duration::from_secs(1);
        let (outcome, spawn) =
            stale_read_plan(Some(&entry), &idle, fresh_now, CLI_USAGE_CACHE_MAX_AGE);
        assert_eq!(outcome.expect("cached groups").len(), 2);
        assert!(!spawn, "살아 있는 캐시는 갱신하지 않는다");

        let stale_now = saved_at + CLI_USAGE_CACHE_MAX_AGE + Duration::from_secs(1);
        let (outcome, spawn) =
            stale_read_plan(Some(&entry), &idle, stale_now, CLI_USAGE_CACHE_MAX_AGE);
        assert_eq!(
            outcome.expect("stale groups are still served").len(),
            2,
            "만료된 캐시도 기다리지 않고 그대로 준다"
        );
        assert!(spawn, "만료됐으면 뒤에서 갱신을 시작한다");
    }

    #[test]
    fn stale_read_backs_off_after_a_recent_failure() {
        let failed_at = Instant::now();
        let probe = CliUsageProbeState {
            in_flight: 0,
            last_failure: Some((
                failed_at,
                "Antigravity /usage 조회 시간이 초과되었습니다".to_owned(),
            )),
        };
        let soon = failed_at + Duration::from_secs(1);
        let (outcome, spawn) = stale_read_plan(None, &probe, soon, CLI_USAGE_CACHE_MAX_AGE);
        assert_eq!(
            outcome.unwrap_err(),
            "Antigravity /usage 조회 시간이 초과되었습니다",
            "재시도 간격 안에서는 직전 실패 사유를 그대로 알린다"
        );
        assert!(!spawn);

        let later = failed_at + CLI_USAGE_FAILURE_RETRY + Duration::from_secs(1);
        let (outcome, spawn) = stale_read_plan(None, &probe, later, CLI_USAGE_CACHE_MAX_AGE);
        assert_eq!(outcome.unwrap_err(), CLI_USAGE_PENDING_MESSAGE);
        assert!(spawn, "재시도 간격이 지나면 다시 조회를 띄운다");

        // 캐시가 있으면 실패 직후에도 캐시를 주되, 갱신은 간격이 지날 때까지 미룬다.
        let entry = cache_entry(failed_at);
        let stale_now = failed_at + CLI_USAGE_CACHE_MAX_AGE + Duration::from_secs(1);
        let probe_recent = CliUsageProbeState {
            in_flight: 0,
            last_failure: Some((stale_now, "실패".to_owned())),
        };
        let (outcome, spawn) = stale_read_plan(
            Some(&entry),
            &probe_recent,
            stale_now,
            CLI_USAGE_CACHE_MAX_AGE,
        );
        assert!(outcome.is_ok());
        assert!(!spawn);
    }

    #[test]
    fn structured_usage_groups_become_stable_pacing_windows() {
        let groups = cli_usage_fixture();
        assert_eq!(resource_for_group(&groups[0]), Some(PacingResource::Gemini));
        assert_eq!(
            resource_for_group(&groups[1]),
            Some(PacingResource::ThirdParty)
        );

        let gemini = usage_from_group(&groups[0]);
        assert_eq!(gemini.status, AccountUsageStatus::Ok);
        assert_eq!(
            gemini
                .windows
                .iter()
                .map(|window| window.label.as_str())
                .collect::<Vec<_>>(),
            ["5시간", "7일"]
        );
        assert!((gemini.windows[0].used_percent - 50.0).abs() < 1e-9);
        assert!((gemini.windows[1].used_percent - 25.0).abs() < 1e-9);

        let combined = combined_usage(&groups);
        assert_eq!(combined.status, AccountUsageStatus::Ok);
        assert!((combined.windows[0].used_percent - 80.0).abs() < 1e-9);
        assert!((combined.windows[1].used_percent - 60.0).abs() < 1e-9);
        assert!(combined.windows[..2]
            .iter()
            .all(|window| !window.model_scoped));
        // 대표 창은 빡빡한 모델군의 복사본이다. 그 사실을 실어 보내야 소진 판정이 같은
        // 소진을 두 번 세지 않는다(`accounts::account_exhausted`).
        assert!(combined.windows[..2].iter().all(|window| window.aggregate));
        assert!(combined.windows[2..].iter().all(|window| !window.aggregate));
    }

    #[test]
    fn an_unstarted_bucket_reports_no_reset_time() {
        // 소비가 없는 버킷의 reset_time은 조회 시각 + 창 길이라 조회마다 밀린다. 그 값을
        // 그대로 남기면 페이싱이 표본마다 창이 리셋된 줄 알고 예약과 실측을 버린다.
        let groups = parse_cli_usage_groups(
            r#"{
                "status":"SUCCESS",
                "command":{"name":"usage","data":{"groups":[
                    {"name":"Claude and GPT models","buckets":[
                        {"id":"3p-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":1,"reset_time":"2026-09-11T11:38:49Z"},
                        {"id":"3p-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":0.9,"reset_time":"2026-09-04T16:38:49Z"}
                    ]}
                ]}}
            }"#,
        )
        .expect("CLI fixture");
        let usage = usage_from_group(&groups[0]);
        let weekly = window_by_label(&usage, "7일").expect("주간 창");
        assert!((weekly.used_percent - 0.0).abs() < 1e-9);
        assert_eq!(weekly.resets_at, None, "시작되지 않은 창에 초기화는 없다");
        let five_hour = window_by_label(&usage, "5시간").expect("5시간 창");
        assert!(
            five_hour.resets_at.is_some(),
            "소비가 시작된 창의 초기화 시각은 그대로 쓴다"
        );
    }

    #[test]
    fn pacing_resource_usage_lands_in_both_the_sample_and_the_cycle_history() {
        // 이 자원은 계정 레지스트리에 없어 accounts의 기록 지점을 지나지 않는다. 표본만
        // 남기면 누적 소비율에서 Antigravity가 통째로 빠진다.
        let dir = tempfile::tempdir().expect("tempdir");
        let resets_at = now_ms() + 3 * 24 * 60 * 60 * 1000;
        let usage = AccountUsageView {
            status: AccountUsageStatus::Ok,
            windows: vec![AccountUsageWindow {
                label: "7일".to_owned(),
                used_percent: 13.6,
                resets_at: Some(resets_at),
                model_scoped: false,
                aggregate: false,
            }],
            updated_at: Some(now_ms()),
            ..Default::default()
        };
        record_pacing_usage(dir.path(), ANTIGRAVITY_GEMINI_RESOURCE_ID, &usage);

        let samples = crate::usage_pacing::export_samples(dir.path());
        assert!(samples
            .iter()
            .any(|sample| sample.account_id == ANTIGRAVITY_GEMINI_RESOURCE_ID
                && sample.window_label == "7일"));
        let history =
            crate::usage_history::snapshot(dir.path(), &pacing_resource_ids()).expect("주기 이력");
        let series = history
            .accounts
            .iter()
            .find(|entry| entry.account_id == ANTIGRAVITY_GEMINI_RESOURCE_ID)
            .expect("Gemini 자원 이력");
        assert_eq!(series.cycles.len(), 1);
        assert!((series.cycles[0].peak_used_percent - 13.6).abs() < 1e-9);
    }

    #[test]
    fn model_names_choose_the_matching_pacing_resource() {
        assert_eq!(
            pacing_resource_id_for_model("gemini-3.1-pro").expect("Gemini resource"),
            ANTIGRAVITY_GEMINI_RESOURCE_ID
        );
        assert_eq!(
            pacing_resource_id_for_model("claude-sonnet-4.6").expect("Claude resource"),
            ANTIGRAVITY_THIRD_PARTY_RESOURCE_ID
        );
        assert_eq!(
            pacing_resource_id_for_model("gpt-oss-120b-medium").expect("GPT resource"),
            ANTIGRAVITY_THIRD_PARTY_RESOURCE_ID
        );
        assert!(pacing_resource_id_for_model("auto").is_err());
    }

    #[test]
    fn a_model_consumes_only_its_own_group_window() {
        assert!(model_consumes_window(
            "claude-opus-4-6-thinking",
            "Claude and GPT models · 7일"
        ));
        assert!(!model_consumes_window(
            "gemini-3.8-flash-high",
            "Claude and GPT models · 5시간"
        ));
        assert!(model_consumes_window(
            "gemini-3.8-flash-high",
            "Gemini Models · 7일"
        ));
        // 계정 대표 창은 어느 모델군이 돌든 그 소진을 싣는다.
        assert!(model_consumes_window("gemini-3.8-flash-high", "7일"));
        // 모델군을 가릴 수 없는 이름은 창과 무관하다고 읽지 않는다.
        assert!(model_consumes_window("auto", "Claude and GPT models · 7일"));
    }

    #[test]
    fn csrf_token_is_read_from_the_process_arguments() {
        let line = "11680 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --https_server_port 0 --csrf_token 762681c9-7ea0 --app_data_dir antigravity";
        assert_eq!(
            parse_process_line(line),
            Some((11680, "762681c9-7ea0".to_owned()))
        );
        // `=`로 붙여 넘기는 형태도 같은 값으로 읽는다.
        assert_eq!(
            parse_process_line("42 language_server --csrf_token=abc"),
            Some((42, "abc".to_owned()))
        );
        // 토큰이 없는 프로세스는 조회할 수 없으므로 후보에서 뺀다.
        assert_eq!(parse_process_line("42 language_server --standalone"), None);
        assert_eq!(parse_process_line(""), None);
    }

    #[test]
    fn listening_ports_are_read_from_the_address_column() {
        assert_eq!(
            parse_listen_port("language_ 11680 user 7u IPv4 0x1 0t0 TCP 127.0.0.1:54269 (LISTEN)"),
            Some(54269)
        );
        assert_eq!(parse_listen_port("COMMAND PID USER FD TYPE"), None);
    }

    #[test]
    fn model_quotas_become_windows_with_a_representative_summary() {
        let response: UserStatusResponse = serde_json::from_value(json!({
            "userStatus": {
                "cascadeModelConfigData": {
                    "clientModelConfigs": [
                        {"label": "Gemini 3.1 Pro (High)", "quotaInfo": {"remainingFraction": 1, "resetTime": "2026-09-01T19:33:08Z"}},
                        {"label": "Claude Opus 4.6 (Thinking)", "quotaInfo": {"remainingFraction": 0.25, "resetTime": "2026-09-01T19:33:08Z"}},
                        {"label": "쿼터 없는 모델"}
                    ]
                }
            }
        }))
        .expect("응답 해석");

        let windows = windows_from_response(&response);

        // 대표 창 + 쿼터가 있는 모델 둘. 쿼터가 없는 항목은 창을 만들지 않는다.
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].label, SUMMARY_WINDOW_LABEL);
        assert!(!windows[0].model_scoped, "대표 창은 계정 소진율에 들어간다");
        // 가장 많이 쓴 모델(75%)이 대표값이다.
        assert!((windows[0].used_percent - 75.0).abs() < 1e-9);
        assert!(windows[1..].iter().all(|window| window.model_scoped));
        // 응답 순서와 무관하게 모델 창은 라벨 순으로 나온다.
        assert_eq!(
            windows[1..]
                .iter()
                .map(|window| window.label.as_str())
                .collect::<Vec<_>>(),
            ["Claude Opus 4.6 (Thinking)", "Gemini 3.1 Pro (High)"]
        );
        assert!((windows[2].used_percent - 0.0).abs() < 1e-9);
        // 2026-09-01T19:33:08Z
        assert_eq!(windows[2].resets_at, Some(1788291188000));
    }

    #[test]
    fn model_window_order_does_not_follow_the_response_order() {
        let ordered = |labels: [&str; 3]| {
            let response: UserStatusResponse = serde_json::from_value(json!({
                "userStatus": {
                    "cascadeModelConfigData": {
                        "clientModelConfigs": labels
                            .iter()
                            .map(|label| json!({
                                "label": label,
                                "quotaInfo": {"remainingFraction": 1, "resetTime": "2026-09-01T19:33:08Z"}
                            }))
                            .collect::<Vec<_>>()
                    }
                }
            }))
            .expect("응답 해석");
            windows_from_response(&response)
                .into_iter()
                .map(|window| window.label)
                .collect::<Vec<_>>()
        };

        // 같은 모델 집합이면 응답이 어떤 순서로 와도 화면에 같은 순서로 놓인다.
        assert_eq!(
            ordered([
                "Gemini 3.8 Flash (Low)",
                "Gemini 3.8 Pro",
                "Gemini 3.8 Flash (High)"
            ]),
            ordered([
                "Gemini 3.8 Pro",
                "Gemini 3.8 Flash (High)",
                "Gemini 3.8 Flash (Low)"
            ])
        );
    }

    /// 실제 language server에 붙는 확인. 서버가 떠 있어야만 통과하므로 기본 실행에서는
    /// 빼고, 조회 경로를 손볼 때 `--ignored`로 직접 돌린다.
    #[test]
    #[ignore = "실행 중인 Antigravity language server가 필요하다"]
    fn live_lookup_reads_model_quotas() {
        let usage = antigravity_usage();
        assert_eq!(usage.status, AccountUsageStatus::Ok, "{:?}", usage.error);
        assert!(
            usage.windows.iter().any(|window| !window.model_scoped),
            "대표 창이 있어야 한다"
        );
        for window in &usage.windows {
            println!(
                "{:<30} used={:>6.2}%  model_scoped={}  resets_at={:?}",
                window.label, window.used_percent, window.model_scoped, window.resets_at
            );
        }
    }

    #[test]
    fn a_response_without_model_quotas_is_not_usable() {
        let response: UserStatusResponse =
            serde_json::from_value(json!({"userStatus": {}})).expect("응답 해석");
        assert!(windows_from_response(&response).is_empty());
    }
}
