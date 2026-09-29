//! 계정별 자격증명 프로필. 공급자 홈(트랜스크립트·설정·스킬·MCP)은 공유한 채
//! 자격증명만 프로세스 단위로 갈라, 여러 계정이 같은 앱에서 동시에 요청을 보낼 수
//! 있게 한다. 한도는 계정 단위(서버 측)로 걸리므로 병렬 요청의 실효는 계정을 나눌
//! 때만 생기고, 홈 전체를 나누면 트랜스크립트와 스킬이 함께 갈라져 세션 색인이
//! 깨진다. 그래서 갈라내는 대상을 자격증명 하나로 좁힌다.
//!
//! - Claude: `CLAUDE_SECURESTORAGE_CONFIG_DIR`이 자격증명 파일 경로와 Keychain
//!   서비스명 해시를 단독으로 결정한다. `CLAUDE_CONFIG_DIR`은 건드리지 않는다.
//! - Codex: `CODEX_HOME`에 자격증명과 설정이 함께 있으므로 홈을 계정별로 만들되
//!   설정은 공유 홈으로 심링크하고, 대화 저장소는 `CODEX_SQLITE_HOME`으로 공유
//!   홈을 그대로 가리켜 세션 색인 경로를 유지한다.
//! - Antigravity: 자격증명만 옮기는 변수도 실행 단위 플래그도 없다. 토큰·대화·설정의
//!   위치를 `HOME` 하나가 정하므로 홈 자체를 계정별로 만든다(`AGENTS.md` C12).
//!   되돌려 주는 공유 항목은 화이트리스트 두 벌뿐이고, 대화는 일부러 공유하지 않는다 —
//!   공유하면 격리 실행이 다른 계정의 대화 DB를 전부 열고 sqlite 사이드카를 쓰게 된다.
//!
//! 두 환경변수는 공급자 CLI의 문서화된 계약이 아니므로, 프로필을 실제로 쓰기 전에
//! 해당 CLI로 인증 상태를 확인하는 프로브를 돌리고 실패하면 공유 홈 동작으로
//! 되돌린다([`probe_profile`]).
//!
//! 프로브가 답하는 것은 "CLI가 이 프로필 저장소를 읽는가" 하나다. "어느 계정인가"는
//! 프로필에 쓴 자격증명으로 따로 확인한다. Claude는 설정 디렉터리를 공유하므로
//! `auth status`가 돌려주는 계정 정보가 프로필이 아니라 공유 설정을 가리키고,
//! 그것을 계정 확인에 쓰면 공유 설정에 적힌 계정 하나만 격리를 통과한다.
//!
//! 프로브는 CLI가 어느 스트림에 답하는지도 계약으로 두지 않는다([`ProbeResponse`]).

use std::fs;
use std::io::Read;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::{self, sleep, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::{CoreError, ProviderId};

/// 앱 데이터 디렉터리 하위의 계정별 자격증명 프로필 루트.
pub(crate) const PROFILE_ROOT: &str = "credential-profiles";
/// 인증 상태 조회는 네트워크 호출이 아니라 로컬 자격증명 판독이라 즉시 끝난다.
/// 그래도 CLI가 멈추면 채팅 시작을 막으므로 마감 시한을 둔다.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// Antigravity는 인증만 보는 명령이 없어 프로브가 `/usage` 한 번을 그대로 쓴다. 로컬
/// 판독이 아니라 서버 왕복이고 CLI 기동도 느려, 다른 공급자와 같은 시한으로는 격리가
/// 되는데도 판정 불가로 끝난다.
const ANTIGRAVITY_PROBE_TIMEOUT: Duration = Duration::from_secs(45);
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// 로컬 자격증명 판독형 프로브(Claude·Codex)가 공유하는 판정 문구. 응답 원문은 계정
/// 정보를 담을 수 있어 어느 쪽도 문구에 섞지 않으므로, 두 공급자가 같은 문장을 각자
/// 적어 두면 한쪽만 고쳐져 같은 뜻이 두 문장으로 갈린다.
const PROBE_NOT_AUTHENTICATED: &str = "프로필 자격증명으로 로그인 상태를 확인하지 못했습니다";
const PROBE_UNREADABLE: &str = "인증 상태 응답을 해석하지 못했습니다";
/// 프로브가 한 스트림에서 판정에 쓸 최대 크기. 인증 상태 응답은 JSON 한 덩이나 한
/// 줄이라 이 한도에 닿지 않는다. 넘는 만큼은 버리되 파이프는 계속 비운다.
const PROBE_MAX_STREAM_BYTES: usize = 64 * 1024;
/// Codex 프로필 홈에서 공유 홈을 그대로 가리킬 항목. 자격증명(auth.json)만 프로필
/// 소유로 두고 설정·훅·플러그인과 사용자가 쓴 정책 자산은 공유본 하나를 함께 쓴다.
///
/// Codex 격리는 `CODEX_HOME`을 통째로 바꾸는 방식이라, 여기 없는 항목은 격리 프로필로
/// 실행한 세션에서 보이지 않는다. `skills`·`rules`·`AGENTS.md`는 사용자가 공유 홈에
/// 작성하고 게시하는 자산인데 빠져 있어서, 게시한 스킬을 격리 세션이 찾지 못하고 명령
/// 허용 규칙도 계정마다 다르게 적용됐다. 세션·히스토리·상태 저장소는 계정별로 갈려야
/// 하므로 여기에 넣지 않는다(대화 저장소는 `CODEX_SQLITE_HOME`으로 따로 공유한다).
const CODEX_SHARED_ENTRIES: &[&str] = &[
    "config.toml",
    "hooks.json",
    "plugins",
    "skills",
    "rules",
    "AGENTS.md",
];

/// Antigravity 프로필 홈을 정하는 환경변수.
///
/// **이 값은 일부러 [`CREDENTIAL_ENV_KEYS`]에 넣지 않는다**(C12-6). 그 목록은 두 가지에
/// 쓰이는데 `HOME`에는 둘 다 해롭다. 하나는 [`strip_inherited_credential_env`]로, 넣으면
/// 공급자와 무관한 자식(Cypress 실행, 플러그인 프로세스)이 홈 없이 뜬다. 다른 하나는
/// [`inherited_credential_dirs`]가 계산하는 문서 금지 경계로, 넣으면 홈 전체가 금지 경계가
/// 되어 사용자의 문서 폴더 등록이 전부 거부된다.
///
/// 목록이 막으려던 구멍은 여기서는 열리지 않는다. 프로필 홈은 앱 데이터 디렉터리 아래에
/// 있고 그 경로는 이미 보호 경계이기 때문이다(`store::is_restricted_doc_root`).
pub(crate) const ANTIGRAVITY_HOME: &str = "HOME";

/// Windows에서 CLI가 홈으로 읽는 변수. Go의 `os.UserHomeDir()`는 Windows에서 `HOME`이 아니라
/// `USERPROFILE`을 보고, `agy`도 그렇다 — `HOME`만 바꾼 자식은 임시 디렉터리에 `.gemini`를
/// 만들지 않고 실제 홈의 `cli.log`에 그대로 썼다(2026-09-26 실측). 그래서 Windows에서는 두
/// 변수를 함께 준다. `HOME`은 그대로 둔다 — CLI가 띄우는 셸 명령과 MCP 서버 가운데 `HOME`을
/// 읽는 것들이 프로필과 다른 홈을 보면 안 된다. `CREDENTIAL_ENV_KEYS`에는 넣지 않는다(C12-6).
pub(crate) const ANTIGRAVITY_WINDOWS_HOME: &str = "USERPROFILE";

/// Antigravity 자식에게 프로필 홈을 알리는 환경변수 전부. 실행 프로필(`profile_env`)과 로그인
/// 터미널이 같은 목록을 써야 한다 — 한쪽만 `USERPROFILE`을 빼먹으면 그쪽 CLI는 실제 홈에서 돈다.
pub(crate) fn antigravity_home_env(profile: &str) -> Vec<(String, String)> {
    let mut env = vec![(ANTIGRAVITY_HOME.to_owned(), profile.to_owned())];
    if cfg!(target_os = "windows") {
        env.push((ANTIGRAVITY_WINDOWS_HOME.to_owned(), profile.to_owned()));
    }
    env
}

/// 공식 CLI가 로그인 토큰을 두는 자리. 홈 기준 상대 경로이며, 프로필 홈에서도 같은
/// 자리를 쓴다. 사용량 조회의 사전 점검과 프로필 조립이 같은 목록을 봐야 한쪽만
/// 파일명을 따라가는 어긋남이 생기지 않는다.
pub(crate) const ANTIGRAVITY_TOKEN_RELATIVE_PATHS: [&str; 2] = [
    ".gemini/antigravity-cli/antigravity-oauth-token",
    ".gemini/jetski-standalone-oauth-token",
];

/// 공식 CLI가 로그인 토큰을 두는 **또 하나의** 자리 — OS 보안 저장소. 키체인을 쓸 수 있으면
/// CLI는 파일을 남기지 않으므로(2026-09-17 실측), 파일만 보는 판정은 로그인된 기기를
/// 미로그인으로 읽는다. 홈을 가른 프로필에서는 그 프로필의 키체인에 들어간다(`C12-4a`).
pub(crate) const ANTIGRAVITY_KEYCHAIN_SERVICE: &str = "gemini";
pub(crate) const ANTIGRAVITY_KEYCHAIN_ACCOUNT: &str = "antigravity";

/// Windows 자격 증명 관리자에서 그 항목의 대상 이름. `agy`는 Go `go-keyring`을 쓰고 그쪽은
/// 대상을 `{service}:{account}`로 짓는데, 우리가 쓰는 `keyring` 크레이트의 기본 이름은
/// `{account}.{service}`다. 기본 이름으로 찾으면 있는 항목을 없다고 읽으므로 대상을 직접 준다.
pub(crate) const ANTIGRAVITY_WINDOWS_CREDENTIAL_TARGET: &str = "gemini:antigravity";

/// 공유 `~/.gemini`에서 프로필 홈의 `.gemini` 아래로 잇는 항목(C12-4).
/// `config`에는 MCP 등록·훅·스킬·프로젝트 매핑이 함께 들어 있다.
const ANTIGRAVITY_SHARED_GEMINI_ENTRIES: &[&str] = &["config"];

/// 사용자 홈에서 프로필 홈 바로 아래로 잇는 항목(C12-4). 홈을 가르면 CLI 자식의 git
/// 정체성과 push 자격이 함께 사라지므로 이 둘만 되돌려 준다.
const ANTIGRAVITY_SHARED_HOME_ENTRIES: &[&str] = &[".gitconfig", ".ssh"];

/// 프로필 격리 프로브 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProbeOutcome {
    /// 프로필 자격증명으로 해당 계정 인증이 확인됐다.
    Ready,
    /// CLI는 프로필을 읽었지만 인증이 없다. 자격증명 기록이 실패했거나 CLI가 이
    /// 환경변수를 무시한 경우이므로 공유 홈으로 되돌린다.
    NotAuthenticated(String),
    /// CLI를 실행하지 못했거나 응답이 없어 판정할 수 없다.
    Unavailable(String),
}

/// Claude 자격증명 저장소를 정하는 환경변수. 이 값이 자격증명 파일 경로와 Keychain
/// 서비스명 해시를 단독으로 결정하므로, 계정별 격리 프로필과 로그인 임시 프로필이
/// 같은 이름으로 같은 경로를 넘겨야 앱이 CLI가 쓴 자리를 그대로 읽는다.
pub(crate) const CLAUDE_SECURESTORAGE_CONFIG_DIR: &str = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
/// Codex 홈. 자격증명과 설정이 함께 있어 프로필 격리는 이 값을 통째로 옮긴다.
pub(crate) const CODEX_HOME: &str = "CODEX_HOME";
/// Codex 대화 저장소. 홈을 계정별로 갈라도 세션 색인 경로를 공유 홈에 붙들어 둔다.
pub(crate) const CODEX_SQLITE_HOME: &str = "CODEX_SQLITE_HOME";
/// Claude 설정 디렉터리. 프로필 격리는 이 값을 건드리지 않지만, 사용자가 직접 옮긴
/// 설치에서는 이 경로도 공급자 소유라 함께 다뤄야 한다.
pub(crate) const CLAUDE_CONFIG_DIR: &str = "CLAUDE_CONFIG_DIR";

/// 공급자 자격증명·홈 저장소의 위치를 환경변수로 바꾸는 값 전체.
///
/// 앱이 계정 격리를 주려고 CLI 자식에게 넣는 값이면서, 사용자가 설치를 옮길 때 쓰는
/// 값이기도 하다. 어느 쪽이든 "이 변수가 가리키는 곳은 공급자 소유"라는 뜻이 같아
/// 목록을 한 벌만 둔다. 곳곳에 흩어 두면 변수를 하나 늘렸을 때 일부만 갱신돼,
/// 자식에게 격리 값이 새거나 보호 경계가 뚫리는 쪽으로 어긋난다.
pub(crate) const CREDENTIAL_ENV_KEYS: [&str; 4] = [
    CLAUDE_SECURESTORAGE_CONFIG_DIR,
    CLAUDE_CONFIG_DIR,
    CODEX_HOME,
    CODEX_SQLITE_HOME,
];

/// 공급자와 무관한 자식 프로세스의 환경에서 격리 변수를 지운다. 백엔드가 에이전트
/// 세션 안에서 재기동돼 이 값을 물려받았을 수 있으므로, 자식이 남의 계정 저장소를
/// 보지 않도록 넘기기 전에 끊는다.
pub(crate) fn strip_inherited_credential_env(command: &mut Command) {
    for key in CREDENTIAL_ENV_KEYS {
        command.env_remove(key);
    }
}

/// 지금 프로세스가 물려받은 격리 변수가 가리키는 경로들. 빈 값은 설정하지 않은 것과
/// 같게 보고 뺀다. 실제 공급자 런타임 구성에 쓰는 경로만 읽는다(G8).
pub(crate) fn inherited_credential_dirs() -> Vec<PathBuf> {
    CREDENTIAL_ENV_KEYS
        .into_iter()
        .filter_map(std::env::var_os)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// 계정별 프로필 경로. 계정 id는 레지스트리가 만든 값이라 경로 구분자를 담지
/// 않지만, 앱 데이터 밖으로 새지 않도록 마지막 요소만 쓴다.
pub(crate) fn profile_dir(
    app_data_dir: &Path,
    provider: ProviderId,
    account_id: &str,
) -> Result<PathBuf, CoreError> {
    let account_id = account_id.trim();
    if account_id.is_empty()
        || account_id.contains('/')
        || account_id.contains('\\')
        || account_id.contains("..")
    {
        return Err(CoreError::InvalidInput(
            "자격증명 프로필을 만들 수 없는 계정 식별자입니다".to_owned(),
        ));
    }
    Ok(app_data_dir
        .join(PROFILE_ROOT)
        .join(provider.as_str())
        .join(account_id))
}

/// 프로필 디렉터리를 만들고 소유자 전용 권한으로 맞춘 뒤 정규화한 경로를 준다.
/// Claude CLI가 Keychain 서비스명을 이 경로의 SHA-256으로 만들기 때문에, 앱이
/// 같은 항목을 찾으려면 양쪽이 반드시 같은 문자열을 써야 한다. 그래서 생성
/// 시점에 한 번 정규화하고 그 값만 환경변수와 해시에 함께 쓴다.
pub(crate) fn ensure_profile_dir(
    app_data_dir: &Path,
    provider: ProviderId,
    account_id: &str,
) -> Result<PathBuf, CoreError> {
    let dir = profile_dir(app_data_dir, provider, account_id)?;
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    // 이 경로는 `profile_env`를 거쳐 자식의 `CODEX_HOME`·`CLAUDE_SECURESTORAGE_CONFIG_DIR`·
    // `HOME` 값이 된다. Keychain 항목 이름도 이 문자열에서 파생되지만(C4-3), 그 파생은
    // macOS 전용이고 macOS의 정규화는 접두어를 만들지 않으므로 항목 이름은 그대로다.
    crate::path_guard::canonical_child_facing(&dir)
}

/// 프로필을 쓰는 프로세스에 넣을 환경변수. 공유 홈 경로는 Codex 대화 저장소를
/// 공유하는 데 쓴다.
pub(crate) fn profile_env(
    provider: ProviderId,
    profile_dir: &Path,
    shared_home: &Path,
) -> Result<Vec<(String, String)>, CoreError> {
    let profile = profile_dir.to_string_lossy().into_owned();
    match provider {
        ProviderId::Claude => Ok(vec![(CLAUDE_SECURESTORAGE_CONFIG_DIR.to_owned(), profile)]),
        ProviderId::Codex => Ok(vec![
            (CODEX_HOME.to_owned(), profile),
            (
                CODEX_SQLITE_HOME.to_owned(),
                shared_home.to_string_lossy().into_owned(),
            ),
        ]),
        // 공유 홈 경로는 여기서 쓰지 않는다. Antigravity가 공유하는 것은 경로가 아니라
        // 프로필 홈 안에 걸린 심링크이고, 그 조립은 `prepare_antigravity_profile`이 한다.
        ProviderId::Antigravity => Ok(antigravity_home_env(&profile)),
        // 계정이 없는 공급자다. 격리할 자격증명도, 가둘 홈도 없다.
        ProviderId::Local => Err(CoreError::InvalidInput(
            "로컬 공급자는 계정별 자격증명 프로필을 쓰지 않습니다".to_owned(),
        )),
    }
}

/// 이 홈에 공식 CLI 로그인 토큰이 하나라도 있는지. 없으면 `agy`가 print 모드에서도
/// 브라우저 OAuth 창을 띄우고 60초를 기다리므로, 프로브를 돌리기 전에 여기서 거른다.
/// 토큰 형식은 읽지 않고 존재만 본다(G6).
pub(crate) fn antigravity_login_present(home: &Path) -> bool {
    ANTIGRAVITY_TOKEN_RELATIVE_PATHS
        .iter()
        .any(|relative| home.join(relative).is_file())
}

/// 이 기계의 OS 보안 저장소에 공식 CLI 로그인 항목이 있는지. 파일과 달리 홈으로 갈리지
/// 않는다 — Windows 자격 증명 관리자에는 홈이라는 개념이 없고, macOS도 기본 로그인 키체인은
/// 공유 홈 하나에 딸린다. 그래서 **공유 홈** 판정에만 쓰고, 프로필 홈 판정
/// ([`antigravity_login_present`]와 `accounts::antigravity_credentials_present`)에는 쓰지
/// 않는다. 프로필은 자기 키체인을 따로 가지므로(`C12-4a`) 그쪽은 홈을 따라가야 한다.
///
/// 읽지 못하면 없는 것으로 본다. 여기서 "아마 있을 것"으로 넘기면 미로그인 기기에서
/// `agy`가 브라우저 로그인 창을 열고 사람을 기다린다.
pub(crate) fn antigravity_os_store_login_present() -> bool {
    match crate::os_keychain::foreign_secret_present(
        ANTIGRAVITY_KEYCHAIN_SERVICE,
        ANTIGRAVITY_KEYCHAIN_ACCOUNT,
        ANTIGRAVITY_WINDOWS_CREDENTIAL_TARGET,
    ) {
        Ok(present) => present,
        Err(error) => {
            eprintln!("[antigravity] OS 보안 저장소의 로그인 항목을 확인하지 못했습니다: {error}");
            false
        }
    }
}

/// 이 플랫폼에서 공식 CLI의 로그인이 홈이 아니라 **기계 전역** 저장소 하나에 들어가는가.
/// Windows 자격 증명 관리자가 그렇다(C12-11). macOS는 프로필마다 키체인을 갖고(C12-4a),
/// Linux는 아직 재지 않았으므로(C12-12) 둘 다 `false`다 — 전역 항목을 건드리는 절차는
/// 그것이 정말 전역인 플랫폼에서만 돈다.
pub(crate) const fn antigravity_login_is_machine_global() -> bool {
    cfg!(target_os = "windows")
}

/// 기계 전역 로그인 항목의 값. `antigravity_login_is_machine_global()`이 거짓인 플랫폼에서는
/// 언제나 `None`이다 — 그곳의 같은 이름 항목은 사용자의 로그인 키체인이고 이 절차의
/// 대상이 아니다. 값은 `Zeroizing`으로만 들고, 로그인 회수(`accounts::capture_credentials`)
/// 한 자리만 부른다(G4).
pub(crate) fn read_antigravity_global_login(
) -> Result<Option<zeroize::Zeroizing<String>>, CoreError> {
    if !antigravity_login_is_machine_global() {
        return Ok(None);
    }
    crate::os_keychain::read_foreign_secret(
        ANTIGRAVITY_KEYCHAIN_SERVICE,
        ANTIGRAVITY_KEYCHAIN_ACCOUNT,
        ANTIGRAVITY_WINDOWS_CREDENTIAL_TARGET,
    )
}

/// 기계 전역 로그인 항목을 비운다(C12-11 1·2단계). 항목이 있는 동안 어느 HOME에서 뜬 CLI든
/// 그 계정 하나로 인증되므로, 로그인 터미널이 브라우저에 닿기 전과 계정별 실행이 뜨기 직전에
/// 비운다. 지웠으면 `true`. 전역 저장소가 아닌 플랫폼에서는 아무것도 하지 않는다.
pub(crate) fn clear_antigravity_global_login() -> Result<bool, CoreError> {
    if !antigravity_login_is_machine_global() {
        return Ok(false);
    }
    crate::os_keychain::delete_foreign_secret(
        ANTIGRAVITY_KEYCHAIN_SERVICE,
        ANTIGRAVITY_KEYCHAIN_ACCOUNT,
        ANTIGRAVITY_WINDOWS_CREDENTIAL_TARGET,
    )
}

/// 등록된 계정별 Antigravity 프로필 홈 목록. 아직 만들어지지 않은 계정은 자리가 없어
/// 빠진다. 카탈로그가 공유 홈과 함께 훑을 대상이다.
///
/// 이름 순으로 정렬해 돌려준다. 같은 대화 id가 두 홈에 있으면 먼저 나온 쪽이 이기는데,
/// 그 판정이 디렉터리 읽기 순서에 따라 흔들리면 목록이 갱신 때마다 달라진다.
pub(crate) fn antigravity_profile_homes(app_data_dir: &Path) -> Vec<PathBuf> {
    let root = app_data_dir
        .join(PROFILE_ROOT)
        .join(ProviderId::Antigravity.as_str());
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut homes = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    homes.sort();
    homes
}

/// 이 경로가 어느 계정의 Antigravity 프로필 홈 안에 있는지. 공유 홈에 있으면 `None`이다.
///
/// 세션이 어느 계정 것인지는 앱이 따로 적어 두지 않아도 파일이 놓인 자리가 답한다.
/// 앱 밖에서 돌린 CLI가 만든 대화도 같은 기준으로 귀속된다.
pub(crate) fn antigravity_account_for_path(app_data_dir: &Path, path: &Path) -> Option<String> {
    let root = app_data_dir
        .join(PROFILE_ROOT)
        .join(ProviderId::Antigravity.as_str());
    path.strip_prefix(&root)
        .ok()?
        .components()
        .next()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
}

/// 다른 홈에 있는 대화 하나를 이 프로필에서 이어갈 수 있게 잇는다.
///
/// Antigravity에는 공유 색인이 없어 대화 파일이 그것을 만든 홈에만 있다. 홈을 가르면 예전
/// 대화를 어느 계정으로도 이어갈 수 없게 되는데, 대화 디렉터리를 통째로 공유하면 격리 실행이
/// 남의 계정 대화를 전부 열어 색인을 만든다(C12-4). 그래서 **이어가기를 요청한 그 대화
/// 하나만** 잇는다.
///
/// 원본은 제자리에 남고 이어지는 턴도 거기 쌓인다. 파일에 쓰는 주체는 공급자 공식 CLI이므로
/// 허용되는 쓰기다(`G3`). 사본을 만들지 않으므로 목록에 같은 대화가 둘로 보이지도 않는다.
pub(crate) fn link_antigravity_conversation(
    profile_home: &Path,
    source: &Path,
) -> Result<(), CoreError> {
    let name = source
        .file_name()
        .ok_or_else(|| CoreError::InvalidInput("대화 파일 이름을 읽지 못했습니다".to_owned()))?;
    let directory = profile_home.join(".gemini/antigravity-cli/conversations");
    fs::create_dir_all(&directory)?;
    link_shared_entry(source, &directory.join(name))
}

/// 이 홈에서 그 대화를 이미 볼 수 있는가. 실파일이든 다른 홈을 가리키는 링크든 상관없다.
pub(crate) fn antigravity_conversation_in_home(home: &Path, id: &str) -> bool {
    let directory = home.join(".gemini/antigravity-cli/conversations");
    ["db", "pb"]
        .iter()
        .any(|extension| directory.join(format!("{id}.{extension}")).exists())
}

/// Antigravity 프로필 홈을 조립한다. 토큰이 들어갈 자리를 만들고 공유 항목을 심링크로
/// 잇는다. 토큰 자체는 계정 등록이 소유하므로 여기서 쓰지 않는다.
///
/// 공유 홈에 없는 항목은 만들지 않는다. `.gitconfig`가 없는 기계에서 빈 파일을 만들면
/// CLI 자식이 전역 설정이 있다고 믿는다.
pub(crate) fn prepare_antigravity_profile(
    profile_home: &Path,
    shared_gemini: &Path,
    shared_user_home: &Path,
) -> Result<(), CoreError> {
    let gemini = profile_home.join(".gemini");
    fs::create_dir_all(gemini.join("antigravity-cli"))?;
    #[cfg(unix)]
    {
        fs::set_permissions(&gemini, fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(
            gemini.join("antigravity-cli"),
            fs::Permissions::from_mode(0o700),
        )?;
    }
    for entry in ANTIGRAVITY_SHARED_GEMINI_ENTRIES {
        link_shared_entry(&shared_gemini.join(entry), &gemini.join(entry))?;
    }
    for entry in ANTIGRAVITY_SHARED_HOME_ENTRIES {
        link_shared_entry(&shared_user_home.join(entry), &profile_home.join(entry))?;
    }
    Ok(())
}

/// Codex 프로필 홈에 공유 설정을 잇는다. 이미 올바른 심링크면 그대로 두고, 다른
/// 곳을 가리키거나 실체 파일이면 공유본을 가리키도록 다시 만든다. 공유 홈에 없는
/// 항목은 만들지 않는다(Codex가 없는 파일을 기본값으로 다룬다).
pub(crate) fn link_shared_codex_entries(
    profile_dir: &Path,
    shared_home: &Path,
) -> Result<(), CoreError> {
    for entry in CODEX_SHARED_ENTRIES {
        link_shared_entry(&shared_home.join(entry), &profile_dir.join(entry))?;
    }
    Ok(())
}

/// 공유본 하나를 프로필 안에서 가리키게 한다. 이미 같은 실체를 가리키면 그대로 두고,
/// 다른 곳을 가리키거나 실체 파일이면 다시 만든다. 공유본이 없으면 아무것도 만들지 않는다.
fn link_shared_entry(source: &Path, link: &Path) -> Result<(), CoreError> {
    if !source.exists() {
        return Ok(());
    }
    if links_to_same_entry(source, link) {
        return Ok(());
    }
    // `exists()`는 링크를 따라가므로 끊어진 링크를 없는 것으로 봤고, 그러면 자리를 비우지
    // 않은 채 생성으로 넘어가 `AlreadyExists`로 떨어졌다. 링크 자체를 본다.
    if fs::symlink_metadata(link).is_ok() {
        remove_profile_entry(link)?;
    }
    symlink_entry(source, link)
}

/// 프로필의 그 자리가 이미 공유본과 같은 실체를 가리키는가.
///
/// 링크 종류로 묻지 않는 이유가 있다. [`symlink_entry`]가 심링크·정션·하드링크 중 그
/// 기계에서 만들 수 있는 것을 쓰므로, `read_link` 비교로는 갈래마다 답이 달라진다 —
/// 정션은 확장 경로(verbatim prefix)를 돌려주고 하드링크는 링크가 아니라 읽히지도 않아,
/// 멀쩡한 연결을 매번 헐고 다시 만들게 된다. 같은 파일인지로 물으면 세 갈래가 한 답을 준다.
///
/// 원본이 지워졌다 새로 쓰인 뒤라면(하드링크가 옛 실체에 남는 경우) 같은 파일이 아니므로
/// 여기서 걸러져 다시 이어진다.
fn links_to_same_entry(source: &Path, link: &Path) -> bool {
    same_file::is_same_file(source, link).unwrap_or(false)
}

fn remove_profile_entry(path: &Path) -> Result<(), CoreError> {
    let file_type = fs::symlink_metadata(path)?.file_type();
    if file_type.is_symlink() {
        // 링크는 대상을 따라가지 않고 링크만 지운다. Windows에서 디렉터리를 가리키는
        // 리파스 포인트(디렉터리 심링크·정션)는 `remove_file`이 아니라 `remove_dir`로만
        // 지워진다. `is_symlink`은 정션에도 참이라 이 갈래로 들어온다.
        #[cfg(windows)]
        if path.is_dir() {
            return fs::remove_dir(path).map_err(CoreError::Io);
        }
        return fs::remove_file(path).map_err(CoreError::Io);
    }
    // 실체 디렉터리만 재귀 삭제 대상이다.
    if file_type.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(unix)]
fn symlink_entry(source: &Path, link: &Path) -> Result<(), CoreError> {
    std::os::unix::fs::symlink(source, link)?;
    Ok(())
}

/// Windows에서 심볼릭 링크를 만들지 못했을 때 나는 오류. 심링크 생성은
/// `SeCreateSymbolicLinkPrivilege`를 요구해서 개발자 모드를 켜거나 관리자로 띄운
/// 프로세스에만 주어진다.
#[cfg(windows)]
const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;

/// 공유본을 프로필 자리에 잇는다. 심링크를 먼저 쓰고, 권한이 없으면 같은 권한을
/// 요구하지 않는 링크로 물러선다 — 디렉터리는 정션, 파일은 하드링크.
///
/// 기본 설치의 Windows는 심링크를 만들지 못한다(`ERROR_PRIVILEGE_NOT_HELD`). 그동안
/// Codex·Antigravity 계정 격리는 그 기계에서 통째로 막혀 있었고, 사용량 조회처럼 이
/// 오류를 그대로 올리는 경로에서는 원본 `os error 1314`이 화면까지 나왔다.
///
/// 사본으로 물러서지 않는다. 그 순간부터 격리 세션은 `skills`·`rules`의 낡은 스냅샷을
/// 읽고 세션이 쓴 내용은 공유 홈에 닿지 않는데, 둘 다 조용히 어긋나므로 지금의 시끄러운
/// 실패보다 나쁘다. 정션과 하드링크는 "공유본은 하나, 사본은 없다"는 C4-5의 전제를
/// 그대로 지킨다.
#[cfg(windows)]
fn symlink_entry(source: &Path, link: &Path) -> Result<(), CoreError> {
    let directory = source.is_dir();
    let refused = match if directory {
        std::os::windows::fs::symlink_dir(source, link)
    } else {
        std::os::windows::fs::symlink_file(source, link)
    } {
        Ok(()) => return Ok(()),
        Err(error) if error.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD) => error,
        Err(error) => return Err(CoreError::Io(error)),
    };
    let fallback = if directory {
        junction::create(source, link)
    } else {
        // 하드링크는 같은 볼륨 안에서만 걸린다. 프로필은 앱 데이터 아래에 있으므로
        // 공급자 홈을 다른 드라이브로 옮겨 둔 구성에서는 여기서 걸리고, 아래 문구가
        // 개발자 모드를 켜라고 안내한다.
        fs::hard_link(source, link)
    };
    fallback.map_err(|error| {
        CoreError::Conflict(format!(
            "{}을(를) 계정 프로필에 잇지 못했습니다. Windows 심볼릭 링크 생성 권한이 없고({refused}) {}(으)로도 실패했습니다: {error}. 설정 → 개인 정보 및 보안 → 개발자용에서 개발자 모드를 켜고 앱을 다시 시작해 주세요",
            link.display(),
            if directory { "정션" } else { "하드링크" },
        ))
    })
}

/// 계정 등록을 지울 때 프로필 자격증명도 함께 지운다. 디렉터리를 남기면 지운
/// 계정의 토큰이 디스크에 남는다. Claude Keychain 항목 정리는 호출자가 한다.
pub(crate) fn remove_profile(
    app_data_dir: &Path,
    provider: ProviderId,
    account_id: &str,
) -> Result<(), CoreError> {
    let dir = profile_dir(app_data_dir, provider, account_id)?;
    if !dir.exists() {
        return Ok(());
    }
    // 공유 홈을 가리키는 심링크가 들어 있으므로, 링크 자체만 지우고 대상은 남긴다.
    for entry in fs::read_dir(&dir)?.flatten() {
        let path = entry.path();
        let is_symlink = fs::symlink_metadata(&path)
            .map(|meta| meta.file_type().is_symlink())
            .unwrap_or(false);
        if is_symlink {
            fs::remove_file(&path)?;
        }
    }
    fs::remove_dir_all(&dir)?;
    Ok(())
}

/// 프로필 환경변수를 넣고 공급자 CLI에 인증 상태를 물어 격리가 실제로 먹는지
/// 확인한다. 모델 호출이 아니라 로컬 자격증명 판독이라 사용량을 쓰지 않는다.
///
/// 확인하는 것은 "CLI가 이 프로필 저장소를 읽는가" 하나다. 어느 계정인지는 이
/// 응답으로 판단할 수 없다([`claude_probe_outcome`] 참고). 프로필에 들어간 자격
/// 증명이 이 계정 것인지는 호출자가 자격증명 자체로 확인한다.
///
/// 응답 원문은 판정에만 쓰고 어디에도 남기지 않는다. `claude auth status --json`은
/// 이메일·조직을, 다른 버전은 더 많은 계정 정보를 담을 수 있으므로 결과 문구에도
/// 원문을 섞지 않는다.
pub(crate) fn probe_profile(
    provider: ProviderId,
    executable: &Path,
    env: &[(String, String)],
) -> ProbeOutcome {
    // Antigravity 프로브는 사용량 조회와 같은 명령이라 같은 줄에 선다. 토큰이 만료된 상태에서
    // 여러 계정을 동시에 준비하면 갱신이 겹쳐 CLI 자신의 키체인 마감을 넘기고, 그러면 CLI가
    // 브라우저 OAuth 창을 띄운다(`antigravity_usage::cli_turn`).
    let _turn = (provider == ProviderId::Antigravity).then(crate::antigravity_usage::cli_turn);
    let spec = probe_spec(provider);
    // 프로브도 사람을 기다리는 자리가 아니다. 인증이 안 되면 이 CLI는 이유를 가리지 않고
    // 브라우저 로그인 창을 띄우므로, 배경 조회와 같은 차단 경로를 자식에게 넘긴다.
    let mut env = env.to_vec();
    if provider == ProviderId::Antigravity {
        env.extend(crate::antigravity_usage::no_browser_path(executable));
        env.push(crate::antigravity_usage::no_auto_update_env());
    }
    let response = match run_probe_command(executable, spec.args, &env, spec.timeout) {
        Ok(response) => response,
        Err(failure) => return ProbeOutcome::Unavailable(failure),
    };
    (spec.outcome)(&response)
}

/// 공급자 하나의 프로브 규격 — 무엇을 묻고, 얼마나 기다리고, 응답을 누가 읽는가.
struct ProbeSpec {
    args: &'static [&'static str],
    timeout: Duration,
    outcome: fn(&ProbeResponse) -> ProbeOutcome,
}

/// 공급자별 프로브 규격. 명령·마감·판정이 각각 자기 `match`를 갖고 있으면 공급자를
/// 늘릴 때 세 자리를 따로 고쳐야 하고, 하나를 빠뜨려도 컴파일은 통과한다. 세 값을 한
/// 갈래에 세워 공급자 하나가 한 줄로 읽히게 한다.
fn probe_spec(provider: ProviderId) -> ProbeSpec {
    match provider {
        ProviderId::Claude => ProbeSpec {
            args: &["auth", "status", "--json"],
            timeout: PROBE_TIMEOUT,
            outcome: claude_probe_outcome,
        },
        ProviderId::Codex => ProbeSpec {
            args: &["login", "status"],
            timeout: PROBE_TIMEOUT,
            outcome: codex_probe_outcome,
        },
        ProviderId::Antigravity => ProbeSpec {
            // 인증 상태만 묻는 명령이 없다. `/usage`가 토큰으로 서버에 묻고 계정 잔량을
            // 돌려주므로, 이 한 번이 프로브이자 사용량 조회다(C12-7).
            args: &["--print", "/usage", "--output-format", "json"],
            timeout: ANTIGRAVITY_PROBE_TIMEOUT,
            outcome: antigravity_probe_outcome,
        },
        // 계정을 관리하지 않는 공급자는 프로필을 만들지 않아 프로브에 닿지 않는다.
        ProviderId::Local => unreachable!("로컬 공급자는 계정 프로필 프로브를 쓰지 않는다"),
    }
}

/// 프로브 명령을 띄우고 두 스트림을 모두 회수한다. 실행·마감 실패는 사용자에게 보일
/// 한 줄로 돌려주고, 응답 원문은 판정하는 쪽으로만 넘긴다.
///
/// 실행 절차와 판정 규칙을 한 함수에 두면 공급자를 늘릴 때마다 마감·파이프 처리를
/// 다시 읽어야 한다. 여기는 "어떻게 받아 오는가"만 알고 공급자를 모른다.
fn run_probe_command(
    executable: &Path,
    args: &[&str],
    env: &[(String, String)],
    timeout: Duration,
) -> Result<ProbeResponse, String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    crate::chat::configure_no_window_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("CLI를 실행하지 못했습니다: {error}"))?;
    // 두 파이프를 동시에 비운다. 한쪽만 읽으면 다른 쪽 버퍼가 차는 순간 CLI가 막혀
    // 종료하지 않고, 마감 시한까지 기다린 뒤 판정 불가로 끝난다.
    let stdout = drain_stream(child.stdout.take());
    let stderr = drain_stream(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let failure = loop {
        match child.try_wait() {
            Ok(Some(_)) => break None,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Some("CLI 인증 상태 조회가 시간 안에 끝나지 않았습니다".to_owned());
                }
                sleep(PROBE_POLL_INTERVAL);
            }
            Err(error) => break Some(format!("CLI 종료를 확인하지 못했습니다: {error}")),
        }
    };
    // 자식이 끝나면 파이프가 닫히므로 읽기 스레드도 함께 끝난다. 마감으로 끊은 뒤에도
    // 스레드는 거두어야 하므로 실패 판정보다 먼저 합류한다.
    let response = ProbeResponse {
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    };
    match failure {
        Some(failure) => Err(failure),
        None => Ok(response),
    }
}

/// 프로브가 읽은 CLI 응답. 어느 스트림에 쓰는지는 공급자와 버전마다 달라서 두 쪽을
/// 모두 담는다. `claude auth status --json`(2.1.x)은 stdout에 JSON을 쓰지만
/// `codex login status`(0.149.0)는 로그인 여부를 stderr에 한 줄로 쓰고 stdout은
/// 비워 둔다. stdout만 읽으면 Codex 응답이 통째로 비어 격리를 판정할 수 없다.
struct ProbeResponse {
    stdout: String,
    stderr: String,
}

impl ProbeResponse {
    /// 공급자마다 응답 스트림이 달라도 같은 순서로 두 쪽을 살핀다.
    fn streams(&self) -> [&str; 2] {
        [&self.stdout, &self.stderr]
    }

    /// 두 스트림의 경계를 보존해 문구 판정용 텍스트로 합친다.
    fn normalized_text(&self) -> String {
        self.streams().join("\n").to_ascii_lowercase()
    }

    /// 두 스트림 중 JSON으로 읽히는 첫 덩이. JSON을 stdout에 쓰는 것은 계약이지만
    /// 버전에 따라 stderr로 나가기도 하므로 같은 순서로 두 쪽을 살핀다.
    fn first_json(&self) -> Option<Value> {
        self.streams()
            .into_iter()
            .map(str::trim)
            .filter(|stream| !stream.is_empty())
            .find_map(|stream| serde_json::from_str::<Value>(stream).ok())
    }
}

/// 파이프 하나를 끝까지 읽어 비우는 스레드. 판정에 쓸 앞부분만 남기고 나머지는
/// 버리되 읽기는 계속한다. 한도에서 읽기를 멈추면 CLI가 파이프에서 막혀 종료하지
/// 않고 마감 시한까지 기다리게 된다. 유효하지 않은 바이트는 대체 문자로 바꿔
/// 인코딩 문제로 응답을 잃지 않는다.
fn drain_stream(stream: Option<impl Read + Send + 'static>) -> JoinHandle<String> {
    thread::spawn(move || {
        let Some(mut stream) = stream else {
            return String::new();
        };
        let mut kept: Vec<u8> = Vec::new();
        let mut chunk = [0_u8; 8 * 1024];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let room = PROBE_MAX_STREAM_BYTES.saturating_sub(kept.len());
                    if room > 0 {
                        kept.extend_from_slice(&chunk[..read.min(room)]);
                    }
                }
            }
        }
        String::from_utf8_lossy(&kept).into_owned()
    })
}

/// `claude auth status --json`은 자격증명 저장소를 프로필로 갈라도 `email`은 공유
/// `~/.claude.json`의 `oauthAccount`에서 읽어 그대로 돌려준다. `CLAUDE_CONFIG_DIR`은
/// 일부러 공유하므로 이 값은 항상 공유 설정이 가리키는 계정 하나를 말하고, 계정별
/// 프로필을 구분하지 못한다. 이 값을 계정 확인에 쓰면 공유 설정에 적힌 계정만
/// 격리를 통과하고 나머지는 전부 공유 홈으로 되돌아간다.
///
/// 그래서 여기서는 로그인 여부만 본다. 빈 프로필을 가리키면 CLI가 공유 저장소로
/// 되돌아가지 않고 `loggedIn: false`를 주므로, 이 한 값으로 환경변수가 실제로
/// 먹었는지 판정할 수 있다. 자격증명이 어느 계정 것인지는 호출자가 프로필에 쓴
/// 자격증명 자체로 확인한다.
fn claude_probe_outcome(response: &ProbeResponse) -> ProbeOutcome {
    let Some(value) = response.first_json() else {
        return ProbeOutcome::Unavailable(PROBE_UNREADABLE.to_owned());
    };
    if value.get("loggedIn").and_then(Value::as_bool) != Some(true) {
        return ProbeOutcome::NotAuthenticated(PROBE_NOT_AUTHENTICATED.to_owned());
    }
    ProbeOutcome::Ready
}

/// `codex login status`(0.149.0)는 로그인 여부를 stderr에 쓰고 stdout은 비워 둔다.
/// 어느 스트림에 쓰는지는 계약이 아니므로 두 쪽을 함께 본다. 판정은 문구로만 하고
/// 종료 코드로 로그인을 단정하지 않는다. 문구를 못 찾으면 판정 불가로 두어 공유
/// 홈으로 되돌아가고, 없는 격리를 있다고 믿어 자격증명이 섞이는 쪽을 막는다.
fn codex_probe_outcome(response: &ProbeResponse) -> ProbeOutcome {
    let normalized = response.normalized_text();
    // "Not logged in"이 "logged in"을 품고 있으므로 부정형을 먼저 걸러낸다.
    if normalized.contains("not logged in") || normalized.contains("no codex credentials") {
        ProbeOutcome::NotAuthenticated(PROBE_NOT_AUTHENTICATED.to_owned())
    } else if normalized.contains("logged in") {
        ProbeOutcome::Ready
    } else {
        ProbeOutcome::Unavailable(PROBE_UNREADABLE.to_owned())
    }
}

/// `agy --print /usage --output-format json`은 결과를 stdout에 JSON 한 덩이로 쓴다.
/// 토큰이 없거나 만료된 사슬이면 같은 모양으로 `status`가 `ERROR`가 되고, 그 판정은
/// 이 프로필 홈으로 실제 요청을 보낸 결과다 — 다른 공급자처럼 로컬 판독이 아니다.
///
/// 문구 대신 `status`만 본다. 응답 본문에는 계정의 잔량과 초기화 시각이 들어 있어
/// 결과 문구로 새어 나가면 안 된다(C4-8).
fn antigravity_probe_outcome(response: &ProbeResponse) -> ProbeOutcome {
    let Some(status) = response.first_json().and_then(|value| {
        value
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_ascii_uppercase)
    }) else {
        return ProbeOutcome::Unavailable("사용량 조회 응답을 해석하지 못했습니다".to_owned());
    };
    if status == "SUCCESS" {
        ProbeOutcome::Ready
    } else {
        ProbeOutcome::NotAuthenticated(
            "프로필 홈의 로그인 토큰으로 사용량을 조회하지 못했습니다".to_owned(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_dir_rejects_identifiers_that_escape_the_root() {
        let root = Path::new("/tmp/app-data");
        assert!(profile_dir(root, ProviderId::Claude, "../secret").is_err());
        assert!(profile_dir(root, ProviderId::Claude, "a/b").is_err());
        assert!(profile_dir(root, ProviderId::Claude, "  ").is_err());
        assert_eq!(
            profile_dir(root, ProviderId::Claude, "claude-1234").unwrap(),
            root.join(PROFILE_ROOT).join("claude").join("claude-1234")
        );
    }

    #[test]
    fn claude_env_isolates_only_the_credential_store() {
        let env = profile_env(
            ProviderId::Claude,
            Path::new("/tmp/profile"),
            Path::new("/tmp/home/.claude"),
        )
        .unwrap();
        assert_eq!(
            env,
            vec![(
                "CLAUDE_SECURESTORAGE_CONFIG_DIR".to_owned(),
                "/tmp/profile".to_owned()
            )]
        );
        // CLAUDE_CONFIG_DIR을 건드리면 트랜스크립트와 스킬까지 갈라진다.
        assert!(!env.iter().any(|(key, _)| key == "CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn codex_env_keeps_the_shared_thread_database() {
        let env = profile_env(
            ProviderId::Codex,
            Path::new("/tmp/profile"),
            Path::new("/tmp/home/.codex"),
        )
        .unwrap();
        assert_eq!(
            env,
            vec![
                ("CODEX_HOME".to_owned(), "/tmp/profile".to_owned()),
                (
                    "CODEX_SQLITE_HOME".to_owned(),
                    "/tmp/home/.codex".to_owned()
                ),
            ]
        );
    }

    /// 격리 변수를 하나 늘리고 목록만 잊으면, 자식 프로세스에 남의 계정 저장소가
    /// 그대로 새고 문서 폴더 보호 경계에도 같은 크기의 구멍이 난다. 변수를 실제로
    /// 넣는 쪽([`profile_env`])과 목록을 묶어, 한쪽만 바뀌면 여기서 걸리게 한다.
    ///
    /// Antigravity는 이 규칙에서 **일부러** 빠진다([`antigravity_home_is_never_a_credential_env_key`]).
    #[test]
    fn credential_env_keys_cover_every_variable_profile_env_sets() {
        for provider in [ProviderId::Claude, ProviderId::Codex] {
            let env = profile_env(
                provider,
                Path::new("/tmp/profile"),
                Path::new("/tmp/shared"),
            )
            .unwrap();
            for (key, _) in env {
                assert!(
                    CREDENTIAL_ENV_KEYS.contains(&key.as_str()),
                    "{key}가 CREDENTIAL_ENV_KEYS에 없습니다"
                );
            }
        }
    }

    /// 프로필의 그 자리가 공유본과 **같은 실체**를 가리키는지 본다.
    ///
    /// 어떤 링크로 이어졌는지(심링크·정션·하드링크)는 그 기계가 가진 권한에 달려 있어,
    /// 링크 종류로 물으면 같은 코드가 기계마다 다른 답을 받는다. 확인할 것은 하나다 —
    /// 사본이 아니라 공유본 하나를 함께 쓰는가.
    fn assert_shares_entry(link: &Path, source: &Path) {
        assert!(
            same_file::is_same_file(link, source).unwrap_or(false),
            "{}이(가) {}과(와) 같은 실체를 가리켜야 한다",
            link.display(),
            source.display()
        );
    }

    /// 심링크를 만들 수 없는 Windows에서는 하드링크·정션으로 이어진다. 그 자리를 "링크가
    /// 아니다"라고 읽고 매번 헐어 다시 만들면, 프로필 준비가 돌 때마다 멀쩡한 연결을
    /// 갈아 끼운다(`links_to_same_entry`).
    #[test]
    fn an_entry_already_sharing_the_source_is_left_in_place() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("shared");
        let profile = temp.path().join("profile");
        fs::create_dir_all(&shared).unwrap();
        fs::create_dir_all(&profile).unwrap();
        fs::write(shared.join("config.toml"), "model = \"gpt-5\"").unwrap();
        // 심링크 권한이 없는 기계가 쓰는 갈래를 손으로 만들어 둔다.
        fs::hard_link(shared.join("config.toml"), profile.join("config.toml")).unwrap();

        link_shared_entry(&shared.join("config.toml"), &profile.join("config.toml")).unwrap();

        assert_shares_entry(&profile.join("config.toml"), &shared.join("config.toml"));
        assert!(
            !fs::symlink_metadata(profile.join("config.toml"))
                .unwrap()
                .file_type()
                .is_symlink(),
            "이미 공유본을 가리키는 항목은 심링크로 다시 만들지 않는다"
        );
    }

    #[test]
    fn shared_codex_entries_are_linked_and_repaired() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("shared");
        let profile = temp.path().join("profile");
        fs::create_dir_all(shared.join("plugins")).unwrap();
        fs::create_dir_all(&profile).unwrap();
        fs::write(shared.join("config.toml"), "model = \"gpt-5\"").unwrap();
        // 이전에 실체 파일이 들어가 있었다면 공유본 심링크로 바꾼다.
        fs::write(profile.join("config.toml"), "stale").unwrap();

        link_shared_codex_entries(&profile, &shared).unwrap();

        assert_shares_entry(&profile.join("config.toml"), &shared.join("config.toml"));
        assert_shares_entry(&profile.join("plugins"), &shared.join("plugins"));
        // 공유 홈에 없는 항목은 만들지 않는다.
        assert!(!profile.join("hooks.json").exists());
        // 두 번 돌려도 그대로 유지된다.
        link_shared_codex_entries(&profile, &shared).unwrap();
        assert_shares_entry(&profile.join("config.toml"), &shared.join("config.toml"));
    }

    #[test]
    fn user_authored_assets_are_shared_with_the_isolated_profile() {
        // Codex 격리는 CODEX_HOME을 통째로 바꾸므로, 링크하지 않은 항목은 격리 세션에서
        // 보이지 않는다. 게시한 스킬을 못 찾거나 명령 허용 규칙이 계정마다 달라지면
        // 무인 회차의 동작이 회차마다 갈린다.
        let temp = tempfile::tempdir().unwrap();
        let shared = temp.path().join("shared");
        let profile = temp.path().join("profile");
        fs::create_dir_all(shared.join("skills/kbfps-dynamic-form-qa")).unwrap();
        fs::create_dir_all(shared.join("rules")).unwrap();
        fs::create_dir_all(&profile).unwrap();
        fs::write(
            shared.join("skills/kbfps-dynamic-form-qa/SKILL.md"),
            "---\n",
        )
        .unwrap();
        fs::write(shared.join("rules/default.rules"), "prefix_rule()").unwrap();
        // 전역 지침은 비어 있어도 링크한다. 나중에 채웠을 때 격리 세션만 못 읽으면
        // 같은 문제가 조용히 돌아온다.
        fs::write(shared.join("AGENTS.md"), "").unwrap();

        link_shared_codex_entries(&profile, &shared).unwrap();

        for entry in ["skills", "rules", "AGENTS.md"] {
            assert_shares_entry(&profile.join(entry), &shared.join(entry));
        }
        assert!(profile
            .join("skills/kbfps-dynamic-form-qa/SKILL.md")
            .exists());
    }

    fn on_stdout(output: &str) -> ProbeResponse {
        ProbeResponse {
            stdout: output.to_owned(),
            stderr: String::new(),
        }
    }

    fn on_stderr(output: &str) -> ProbeResponse {
        ProbeResponse {
            stdout: String::new(),
            stderr: output.to_owned(),
        }
    }

    #[test]
    fn claude_probe_reads_login_state() {
        assert_eq!(
            claude_probe_outcome(&on_stdout(r#"{"loggedIn": true, "email": "a@b.com"}"#)),
            ProbeOutcome::Ready
        );
        assert!(matches!(
            claude_probe_outcome(&on_stdout(r#"{"loggedIn": false}"#)),
            ProbeOutcome::NotAuthenticated(_)
        ));
        assert!(matches!(
            claude_probe_outcome(&on_stdout("Not logged in · Please run /login")),
            ProbeOutcome::Unavailable(_)
        ));
    }

    /// `email`은 공유 `~/.claude.json`에서 오므로 프로필 계정과 다른 값이 와도
    /// 격리를 막으면 안 된다. 이 값을 보고 판정하면 공유 설정에 적힌 계정 하나만
    /// 격리되고 나머지 계정은 전부 공유 홈으로 되돌아간다.
    #[test]
    fn claude_probe_ignores_the_shared_config_email() {
        assert_eq!(
            claude_probe_outcome(&on_stdout(r#"{"loggedIn": true, "email": "other@b.com"}"#)),
            ProbeOutcome::Ready
        );
    }

    /// stdout이 계약이지만 stderr로 나가도 같은 판정을 내려야 한다. 스트림이 바뀌는
    /// 것만으로 격리가 꺼지면 CLI 업데이트마다 병렬 실행이 사라진다.
    #[test]
    fn claude_probe_accepts_the_json_from_either_stream() {
        assert_eq!(
            claude_probe_outcome(&on_stderr(r#"{"loggedIn": true}"#)),
            ProbeOutcome::Ready
        );
    }

    #[test]
    fn codex_probe_reads_login_state() {
        assert_eq!(
            codex_probe_outcome(&on_stdout("Logged in using ChatGPT\n")),
            ProbeOutcome::Ready
        );
        assert!(matches!(
            codex_probe_outcome(&on_stdout("Not logged in\n")),
            ProbeOutcome::NotAuthenticated(_)
        ));
        assert!(matches!(
            codex_probe_outcome(&on_stdout("")),
            ProbeOutcome::Unavailable(_)
        ));
    }

    /// Codex CLI 0.149.0의 실제 계약. `codex login status`는 stdout을 비워 두고
    /// 로그인 여부를 stderr에 쓴다. stdout만 읽으면 응답이 빈 문자열이 되어 모든
    /// Codex 계정이 "인증 상태 응답을 해석하지 못했습니다"로 공유 홈에 묶인다.
    #[test]
    fn codex_probe_reads_the_status_line_from_stderr() {
        assert_eq!(
            codex_probe_outcome(&on_stderr("Logged in using ChatGPT\n")),
            ProbeOutcome::Ready
        );
        assert!(matches!(
            codex_probe_outcome(&on_stderr("Not logged in\n")),
            ProbeOutcome::NotAuthenticated(_)
        ));
    }

    /// 프로세스 경계까지 확인한다. 판정 함수만 고쳐도 프로브가 stderr를 버리면
    /// 아무것도 달라지지 않으므로, 실제 자식 프로세스의 stderr를 읽어 오는지 본다.
    /// stdout을 함께 쏟아내도 파이프에서 막히지 않아야 한다.
    #[cfg(unix)]
    #[test]
    fn probe_reads_a_status_line_written_to_stderr_by_a_real_process() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("codex");
        // 상태 한 줄은 stderr로, 잡음은 stdout으로 흘리는 CLI를 흉내낸다.
        fs::write(
            &script,
            "#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' 'x'\necho 'Logged in using ChatGPT' >&2\nexit 0\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            probe_profile(ProviderId::Codex, &script, &[]),
            ProbeOutcome::Ready
        );
    }

    /// 두 스트림을 이어 붙일 때 한쪽 끝과 다른 쪽 시작이 붙어 없던 문구가 생기면
    /// 안 된다. stdout `...not`과 stderr `logged in`이 "not logged in"으로 읽히면
    /// 로그인 상태를 잘못 판정한다.
    #[test]
    fn codex_probe_does_not_splice_words_across_streams() {
        assert_eq!(
            codex_probe_outcome(&ProbeResponse {
                stdout: "checking if not".to_owned(),
                stderr: "logged in using ChatGPT".to_owned(),
            }),
            ProbeOutcome::Ready
        );
    }

    #[test]
    fn antigravity_env_moves_only_the_home() {
        let env = profile_env(
            ProviderId::Antigravity,
            Path::new("/tmp/profile"),
            Path::new("/tmp/home/.gemini"),
        )
        .unwrap();
        // 홈을 알리는 변수만 있고 그 밖의 것은 없다. Windows에서는 CLI가 `USERPROFILE`로 홈을
        // 잡으므로 그 변수가 하나 더 붙는다(같은 값).
        assert_eq!(env[0], ("HOME".to_owned(), "/tmp/profile".to_owned()));
        assert_eq!(env, antigravity_home_env("/tmp/profile"));
        if cfg!(target_os = "windows") {
            assert_eq!(env.len(), 2);
            assert_eq!(
                env[1],
                ("USERPROFILE".to_owned(), "/tmp/profile".to_owned())
            );
        } else {
            assert_eq!(env.len(), 1);
        }
    }

    /// `HOME`을 목록에 넣으면 두 곳이 즉시 깨진다. 공급자와 무관한 자식이 홈 없이 뜨고
    /// (`strip_inherited_credential_env`), 홈 전체가 문서 금지 경계가 된다
    /// (`inherited_credential_dirs`). 프로필 홈은 앱 데이터 아래라 이미 보호 경계이므로
    /// 목록이 막으려던 구멍은 여기서 열리지 않는다(C12-6).
    #[test]
    fn antigravity_home_is_never_a_credential_env_key() {
        assert!(!CREDENTIAL_ENV_KEYS.contains(&ANTIGRAVITY_HOME));
        assert!(!CREDENTIAL_ENV_KEYS.contains(&ANTIGRAVITY_WINDOWS_HOME));
    }

    #[test]
    fn antigravity_profile_links_shared_entries_and_keeps_conversations_private() {
        let temp = tempfile::tempdir().unwrap();
        let user_home = temp.path().join("home");
        let gemini = user_home.join(".gemini");
        let profile = temp.path().join("profile");
        fs::create_dir_all(gemini.join("config")).unwrap();
        fs::create_dir_all(gemini.join("antigravity-cli/conversations")).unwrap();
        fs::write(user_home.join(".gitconfig"), "[user]").unwrap();
        fs::create_dir_all(user_home.join(".ssh")).unwrap();

        prepare_antigravity_profile(&profile, &gemini, &user_home).unwrap();

        assert_shares_entry(&profile.join(".gemini/config"), &gemini.join("config"));
        assert_shares_entry(&profile.join(".gitconfig"), &user_home.join(".gitconfig"));
        assert_shares_entry(&profile.join(".ssh"), &user_home.join(".ssh"));
        // 대화를 공유하면 격리 실행이 남의 계정 대화 DB를 열고 사이드카를 쓴다(C12-4).
        assert!(
            !same_file::is_same_file(
                profile.join(".gemini/antigravity-cli/conversations"),
                gemini.join("antigravity-cli/conversations"),
            )
            .unwrap_or(false),
            "대화 디렉터리는 공유하지 않는다"
        );
        assert!(profile.join(".gemini/antigravity-cli").is_dir());
    }

    /// 공유본이 없는 기계에서 빈 파일을 만들면 CLI 자식이 전역 설정이 있다고 믿는다.
    #[test]
    fn antigravity_profile_skips_entries_the_shared_home_does_not_have() {
        let temp = tempfile::tempdir().unwrap();
        let user_home = temp.path().join("home");
        let gemini = user_home.join(".gemini");
        let profile = temp.path().join("profile");
        fs::create_dir_all(&gemini).unwrap();

        prepare_antigravity_profile(&profile, &gemini, &user_home).unwrap();

        assert!(!profile.join(".gemini/config").exists());
        assert!(!profile.join(".gitconfig").exists());
    }

    #[test]
    fn antigravity_login_presence_looks_at_both_token_paths() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        assert!(!antigravity_login_present(home));
        for relative in ANTIGRAVITY_TOKEN_RELATIVE_PATHS {
            let path = home.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "token").unwrap();
            assert!(antigravity_login_present(home));
            fs::remove_file(&path).unwrap();
        }
    }

    #[test]
    fn antigravity_probe_reads_the_usage_status() {
        let ready = ProbeResponse {
            stdout: r#"{"conversation_id":"","status":"SUCCESS","response":"weekly 90%"}"#
                .to_owned(),
            stderr: String::new(),
        };
        assert_eq!(antigravity_probe_outcome(&ready), ProbeOutcome::Ready);

        let failed = ProbeResponse {
            stdout: r#"{"status":"ERROR","error":"authentication failed or timed out"}"#.to_owned(),
            stderr: String::new(),
        };
        assert!(matches!(
            antigravity_probe_outcome(&failed),
            ProbeOutcome::NotAuthenticated(_)
        ));

        let silent = ProbeResponse {
            stdout: String::new(),
            stderr: "command not found".to_owned(),
        };
        assert!(matches!(
            antigravity_probe_outcome(&silent),
            ProbeOutcome::Unavailable(_)
        ));
    }

    /// 판정에 쓴 응답에는 계정 잔량이 들어 있다. 실패 문구로 새어 나가면 안 된다(C4-8).
    #[test]
    fn antigravity_probe_failure_never_quotes_the_response() {
        let failed = ProbeResponse {
            stdout: r#"{"status":"ERROR","error":"weekly limit remaining 12% for acct"}"#
                .to_owned(),
            stderr: String::new(),
        };
        let ProbeOutcome::NotAuthenticated(reason) = antigravity_probe_outcome(&failed) else {
            panic!("인증 실패로 판정해야 한다");
        };
        assert!(!reason.contains("12%"));
        assert!(!reason.contains("acct"));
    }

    #[test]
    fn antigravity_probe_gets_a_longer_deadline_than_the_local_readers() {
        assert!(
            probe_spec(ProviderId::Antigravity).timeout > probe_spec(ProviderId::Codex).timeout
        );
        assert_eq!(probe_spec(ProviderId::Claude).timeout, PROBE_TIMEOUT);
    }

    /// 다른 홈의 대화는 **요청한 하나만** 잇는다. 디렉터리를 통째로 공유하면 격리 실행이
    /// 남의 계정 대화를 전부 열어 자기 색인을 만든다(`C12-4`).
    #[test]
    fn only_the_requested_conversation_is_linked_into_the_profile() {
        let temp = tempfile::tempdir().unwrap();
        let shared = temp
            .path()
            .join("shared/.gemini/antigravity-cli/conversations");
        fs::create_dir_all(&shared).unwrap();
        fs::write(shared.join("wanted.db"), b"w").unwrap();
        fs::write(shared.join("other.db"), b"o").unwrap();
        let profile = temp.path().join("profile");

        link_antigravity_conversation(&profile, &shared.join("wanted.db")).unwrap();

        assert!(antigravity_conversation_in_home(&profile, "wanted"));
        assert!(!antigravity_conversation_in_home(&profile, "other"));
        // 사본이 아니라 링크여야 이어지는 턴이 원본에 쌓이고 목록이 둘로 갈리지 않는다.
        assert_shares_entry(
            &profile.join(".gemini/antigravity-cli/conversations/wanted.db"),
            &shared.join("wanted.db"),
        );
        // 다시 이어가도 같은 자리를 그대로 쓴다.
        link_antigravity_conversation(&profile, &shared.join("wanted.db")).unwrap();
        assert!(antigravity_conversation_in_home(&profile, "wanted"));
    }
}
