use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::{Command, Stdio};
#[cfg(unix)]
use std::sync::{mpsc, OnceLock};
#[cfg(unix)]
use std::time::{Duration, Instant};

use crate::domain::{AppStatus, DetectedResource, ProviderId, ProviderStatus};
use crate::user_home;
use crate::CoreError;

const STATUS_SCHEMA_VERSION: u32 = 1;

struct ProviderSpec {
    id: ProviderId,
    display_name: &'static str,
    executable_names: &'static [&'static str],
    history_paths: &'static [&'static str],
}

/// 하네스 세션 DB의 홈 기준 경로. `catalog::opencode_session_db`와 같은 파일을 가리킨다.
pub(crate) const OPENCODE_SESSION_DB_RELATIVE: &str = ".local/share/opencode/opencode.db";

const PROVIDERS: &[ProviderSpec] = &[
    ProviderSpec {
        id: ProviderId::Claude,
        display_name: "Claude Code",
        executable_names: &["claude"],
        history_paths: &[".claude/projects"],
    },
    ProviderSpec {
        id: ProviderId::Codex,
        display_name: "OpenAI Codex",
        executable_names: &["codex"],
        history_paths: &[".codex/state_5.sqlite", ".codex/sessions"],
    },
    ProviderSpec {
        id: ProviderId::Antigravity,
        display_name: "Google Antigravity",
        // `antigravity` is the IDE launcher. Starting it for a headless chat
        // opens the desktop IDE instead of producing a CLI response.
        executable_names: &["agy", "antigravity-cli"],
        history_paths: &[
            ".gemini/antigravity-cli/conversation_summaries.db",
            ".gemini/antigravity-cli/conversations",
            ".gemini/antigravity/conversations",
        ],
    },
    ProviderSpec {
        id: ProviderId::Local,
        display_name: "Ollama",
        // 자기 CLI가 없다. ACP 하네스를 빌려 쓰므로 탐지 대상은 그 실행 파일이다.
        executable_names: &["opencode"],
        // 기록은 하네스의 세션 DB에 있다. 카탈로그가 `opencode_session_db`로 읽는
        // 바로 그 파일이라, 여기가 비어 있으면 대화가 목록에 있어도 카드는 "데이터 없음"이 된다.
        history_paths: &[OPENCODE_SESSION_DB_RELATIVE],
    },
];

fn provider_spec(provider: ProviderId) -> &'static ProviderSpec {
    PROVIDERS
        .iter()
        .find(|spec| spec.id == provider)
        .expect("모든 ProviderId는 탐지 정의를 가진다")
}

pub(crate) fn provider_display_name(provider: ProviderId) -> &'static str {
    provider_spec(provider).display_name
}

/// 공급자 CLI 실행 파일을 지금 다시 탐지한다. 업데이트 직후 교체된 실행 파일을
/// 다시 찾기 위해 매번 PATH를 새로 읽는다.
pub(crate) fn detect_provider_cli(provider: ProviderId) -> Result<Option<PathBuf>, CoreError> {
    let context = DetectionContext::from_environment()?;
    Ok(find_provider_executable(provider_spec(provider), &context)
        .map(|path| crate::path_guard::child_facing(&fs::canonicalize(&path).unwrap_or(path))))
}

#[derive(Debug, Clone)]
struct DetectionContext {
    home: PathBuf,
    search_dirs: Vec<PathBuf>,
    executable_extensions: Vec<OsString>,
}

impl DetectionContext {
    fn from_environment() -> Result<Self, CoreError> {
        let home = user_home::home_dir()?;

        // 우선순위: 물려받은 PATH → 로그인 셸이 만든 PATH → 설치 방식별 고정 폴백.
        // 앞의 것이 이미 찾는 도구는 뒤의 것이 바꾸지 못한다.
        let mut search_dirs = env::var_os("PATH")
            .map(|value| env::split_paths(&value).collect::<Vec<_>>())
            .unwrap_or_default();

        search_dirs.extend(supplemental_executable_dirs(&home));
        deduplicate_paths(&mut search_dirs);

        Ok(Self {
            home,
            search_dirs,
            executable_extensions: executable_extensions(),
        })
    }
}

pub fn inspect_local_environment() -> Result<AppStatus, CoreError> {
    let context = DetectionContext::from_environment()?;
    Ok(inspect_with_context(&context))
}

fn inspect_with_context(context: &DetectionContext) -> AppStatus {
    AppStatus {
        schema_version: STATUS_SCHEMA_VERSION,
        platform: env::consts::OS.to_owned(),
        architecture: env::consts::ARCH.to_owned(),
        providers: PROVIDERS
            .iter()
            .map(|spec| inspect_provider(spec, context))
            .collect(),
    }
}

fn inspect_provider(spec: &ProviderSpec, context: &DetectionContext) -> ProviderStatus {
    ProviderStatus {
        provider: spec.id,
        display_name: spec.display_name.to_owned(),
        cli: find_provider_executable(spec, context)
            .map(resource_from_path)
            .unwrap_or_else(DetectedResource::missing),
        history: spec
            .history_paths
            .iter()
            .map(|relative| context.home.join(relative))
            .find(|path| path.exists())
            .map(resource_from_path)
            .unwrap_or_else(DetectedResource::missing),
    }
}

fn find_provider_executable(spec: &ProviderSpec, context: &DetectionContext) -> Option<PathBuf> {
    let executable = find_executable(spec.executable_names, context)?;
    Some(native_npm_executable(&executable).unwrap_or(executable))
}

/// `.cmd` 셈 옆에 같은 패키지가 까는 네이티브 실행 파일. 셈 이름으로 고른다.
///
/// 공급자가 아니라 파일 이름으로 가르는 것은, 같은 CLI를 여러 공급자가 빌려 쓸 수 있고
/// (로컬 공급자가 하네스를 빌리는 것처럼) 셈이 어느 패키지 것인지는 이름이 말해 주기
/// 때문이다.
#[cfg(windows)]
const NATIVE_NPM_TARGETS: &[(&str, &str)] = &[
    (
        "claude",
        "node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    ),
    ("opencode", "node_modules/opencode-ai/bin/opencode.exe"),
];

/// Rust intentionally rejects batch-file arguments that cannot be escaped safely for `cmd.exe`.
/// These CLIs ship a `.cmd` shim next to `node_modules` while the package also ships a native
/// executable that accepts the original argument vector without shell reparsing. Prefer only that
/// fixed package-relative target when it exists; other launchers keep their detected path.
#[cfg(windows)]
fn native_npm_executable(executable: &Path) -> Option<PathBuf> {
    if !executable
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
    {
        return None;
    }
    let stem = executable.file_stem()?.to_str()?.to_ascii_lowercase();
    let relative = NATIVE_NPM_TARGETS
        .iter()
        .find_map(|(name, relative)| (*name == stem).then_some(*relative))?;
    let native = executable.parent()?.join(relative);
    is_executable_file(&native).then_some(native)
}

#[cfg(not(windows))]
fn native_npm_executable(_executable: &Path) -> Option<PathBuf> {
    None
}

fn resource_from_path(path: PathBuf) -> DetectedResource {
    // 이 문자열은 화면에 그대로 보이고 `cli.path`로 스냅숏에도 실려, 그대로 자식
    // 실행 파일 경로가 된다. 접두어를 달고 나가면 사용자가 복사해 쓸 수도 없다.
    let display_path = crate::path_guard::child_facing(&fs::canonicalize(&path).unwrap_or(path));
    DetectedResource::found(display_path.to_string_lossy().into_owned())
}

fn find_executable(names: &[&str], context: &DetectionContext) -> Option<PathBuf> {
    // Names are ordered by provider preference. Search every PATH directory for
    // the canonical binary before considering a legacy alias.
    for name in names {
        for directory in &context.search_dirs {
            for candidate in executable_candidates(directory, name, &context.executable_extensions)
            {
                if is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

pub(crate) fn resolve_named_executable(names: &[&str]) -> Result<PathBuf, CoreError> {
    let context = DetectionContext::from_environment()?;
    let path = find_executable(names, &context)
        .ok_or_else(|| CoreError::NotFound(format!("{} 실행 파일을 찾을 수 없습니다", names[0])))?;
    let path = crate::path_guard::canonical_child_facing(path)?;
    if !is_executable_file(&path) {
        return Err(CoreError::InvalidInput(format!(
            "{} 경로가 실행 파일이 아닙니다",
            names[0]
        )));
    }
    Ok(path)
}

/// 외부 명령을 실행할 때 자식에게 물려줄 `PATH`.
///
/// 탐색에 쓴 디렉터리 목록을 실행 환경에도 그대로 준다. 이 대칭이 필요한 이유는
/// npm이 네이티브 바이너리가 아니라 `#!/usr/bin/env node` 셔뱅 스크립트라서다.
/// Finder·launchd로 뜬 앱의 `PATH`는 `/usr/bin:/bin:/usr/sbin:/sbin`뿐이라,
/// 탐색으로 `/opt/homebrew/bin/npm`을 찾아 절대경로로 실행해도 셔뱅이 `node`를
/// 못 찾아 `env: node: No such file or directory`로 죽는다.
///
/// 탐색에 성공한 실행 파일의 디렉터리는 정의상 `search_dirs`에 들어 있고, node는
/// npm과 같은 `bin`에 있다. 그래서 목록을 그대로 넘기면 로그인 셸 PATH로 찾은
/// nvm·volta 설치도 런타임까지 함께 찾게 된다. 심링크를 푼 경로의
/// 디렉터리를 맨 앞에 덧붙여, 자기 옆 도구를 기대하는 CLI도 함께 만족시킨다.
pub(crate) fn command_search_path(executable: &Path) -> Option<OsString> {
    let context = DetectionContext::from_environment().ok()?;
    let mut directories = Vec::with_capacity(context.search_dirs.len() + 1);
    // 확장 경로 항목은 Windows 탐색이 쓰지 않는다. 접두어를 달고 넣으면 이 함수가
    // 있는 이유(셔뱅 인터프리터 해석)가 그 항목에서만 조용히 사라진다.
    if let Some(parent) = executable.parent() {
        directories.push(crate::path_guard::child_facing(parent));
    }
    directories.extend(context.search_dirs);
    deduplicate_paths(&mut directories);
    env::join_paths(directories).ok()
}

/// 오래 사는 자식(채팅 CLI·터미널)에 물려줄 `PATH`.
///
/// [`command_search_path`]와 목적은 같지만 훨씬 보수적이다. 이 자식들은 셸 명령·MCP
/// 서버·훅을 다시 띄우고, 그 손자들이 모두 이 `PATH`를 물려받는다. 순서를 바꾸면
/// 실행 중인 세션이 고르는 `git`·`python`·`node`가 조용히 달라질 수 있다.
///
/// 그래서 상속한 `PATH` 문자열은 한 글자도 바꾸지 않고, 거기에 **없던** 디렉터리만
/// 뒤에 덧붙인다. 로그인 셸 PATH가 먼저, 고정 폴백이 그 뒤다. 이미 찾히던 도구의
/// 우선순위는 그대로고, 못 찾던 도구만 찾히게 된다. 덧붙일 것이 없으면 `None`을
/// 돌려 `PATH`를 아예 손대지 않는다.
pub(crate) fn appended_search_path() -> Option<OsString> {
    let home = user_home::optional_home_dir()?;
    let inherited = env::var_os("PATH").unwrap_or_default();
    let known = env::split_paths(&inherited).collect::<HashSet<_>>();
    let missing = supplemental_executable_dirs(&home)
        .into_iter()
        .filter(|directory| !known.contains(directory))
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return None;
    }

    let appended = env::join_paths(missing).ok()?;
    let mut value = inherited;
    if !value.is_empty() {
        value.push(if cfg!(windows) { ";" } else { ":" });
    }
    value.push(appended);
    Some(value)
}

fn executable_candidates(directory: &Path, name: &str, extensions: &[OsString]) -> Vec<PathBuf> {
    let direct = directory.join(name);
    if Path::new(name).extension().is_some() || extensions.is_empty() {
        return vec![direct];
    }

    // Windows npm shims include both an extensionless POSIX shell script and a
    // `.cmd` launcher. Prefer PATHEXT candidates so the shell script is not
    // mistaken for a native Win32 executable (OS error 193).
    let mut candidates = extensions
        .iter()
        .map(|extension| {
            let mut file_name = OsString::from(name);
            file_name.push(extension);
            directory.join(file_name)
        })
        .collect::<Vec<_>>();
    candidates.push(direct);
    candidates
}

fn executable_extensions() -> Vec<OsString> {
    if cfg!(windows) {
        env::var_os("PATHEXT")
            .map(|value| {
                value
                    .to_string_lossy()
                    .split(';')
                    .filter(|item| !item.is_empty())
                    .map(OsString::from)
                    .collect()
            })
            .unwrap_or_else(|| {
                [".COM", ".EXE", ".BAT", ".CMD"]
                    .into_iter()
                    .map(OsString::from)
                    .collect()
            })
    } else {
        Vec::new()
    }
}

/// Finder·launchd로 뜬 앱의 `PATH`는 `/usr/bin:/bin:/usr/sbin:/sbin`뿐이다. 셸
/// 프로필(`.zprofile`·`.zshrc`)을 거치지 않으므로 사용자가 터미널에서 쓰는 `PATH`와
/// 다르다. nvm·fnm·mise·asdf 같은 노드 버전 관리자는 프로필 안에서 버전별 `bin`을
/// `PATH`에 끼워 넣기 때문에, 그 node로 `npm install -g`한 CLI는 고정 목록으로는
/// 위치를 알 수 없다. 새 기기에서 "설치했는데 탐지되지 않는다"의 원인이 바로 이것이다.
///
/// 그래서 사용자의 로그인 셸을 대화형·로그인 모드로 한 번 띄워 `PATH`를 받아 온다.
/// 프로필이 멈추거나 오류를 내도 앱이 함께 멈추면 안 되므로 시간 상한을 두고, 결과는
/// 프로세스 수명 동안 캐시한다. 앱을 다시 시작하면 다시 읽는다.
#[cfg(unix)]
fn login_shell_path_dirs() -> &'static [PathBuf] {
    static DIRS: OnceLock<Vec<PathBuf>> = OnceLock::new();
    DIRS.get_or_init(|| probe_login_shell_path().unwrap_or_default())
}

#[cfg(not(unix))]
fn login_shell_path_dirs() -> &'static [PathBuf] {
    &[]
}

#[cfg(unix)]
const LOGIN_SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(unix)]
const LOGIN_SHELL_PATH_MARKER: &str = "__AGENT_MANAGER_PATH_PROBE__";

#[cfg(unix)]
fn probe_login_shell_path() -> Option<Vec<PathBuf>> {
    let shell = login_shell_executable()?;
    // 프로필이 stdout에 무엇을 찍든(배너·fetch 출력) 표식 사이만 읽는다. 셸 변수
    // 확장은 셸마다 달라(fish의 `$PATH`는 목록) 값을 직접 찍지 않고 `env`로 받는다.
    let script = format!(
        "printf '\n{marker}\n'; /usr/bin/env; printf '\n{marker}\n'",
        marker = LOGIN_SHELL_PATH_MARKER
    );
    let mut child = Command::new(&shell)
        .args(["-i", "-l", "-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("TERM", "dumb")
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    // 프로필이 stdout을 물려받은 데몬을 남기면 파이프가 닫히지 않는다. 읽기 스레드를
    // join하지 않고 채널로 기다려, 그런 경우에도 상한 시간 뒤에는 포기한다.
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(crate::process_output::read_capped(stdout));
    });

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < LOGIN_SHELL_PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let remaining = LOGIN_SHELL_PROBE_TIMEOUT.saturating_sub(started.elapsed());
    let output = receiver.recv_timeout(remaining).ok()?;
    parse_login_shell_path(&String::from_utf8_lossy(&output))
}

#[cfg(unix)]
fn login_shell_executable() -> Option<PathBuf> {
    env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|shell| shell.is_absolute() && is_executable_file(shell))
        .or_else(|| {
            ["/bin/zsh", "/bin/bash", "/bin/sh"]
                .into_iter()
                .map(PathBuf::from)
                .find(|shell| is_executable_file(shell))
        })
}

/// 표식 사이의 `env` 출력에서 `PATH=` 줄만 읽는다. 표식 앞의 프로필 잡음과 표식이
/// 하나뿐인 잘린 출력은 모두 무시한다.
#[cfg(unix)]
fn parse_login_shell_path(output: &str) -> Option<Vec<PathBuf>> {
    let begin = output.find(LOGIN_SHELL_PATH_MARKER)? + LOGIN_SHELL_PATH_MARKER.len();
    let end = begin + output[begin..].find(LOGIN_SHELL_PATH_MARKER)?;
    let environment = &output[begin..end];
    let value = environment
        .lines()
        .find_map(|line| line.strip_prefix("PATH="))?;
    // `.`이나 풀리지 않은 `~/...` 같은 상대 항목은 앱의 작업 디렉터리에 따라 다른 파일을
    // 가리키므로 버린다.
    let directories = env::split_paths(value)
        .filter(|directory| directory.is_absolute())
        .collect::<Vec<_>>();
    (!directories.is_empty()).then_some(directories)
}

/// 로그인 셸 PATH를 못 받았을 때(SHELL 없음·프로필 오류·시간 초과)를 위한 고정 폴백.
/// 설치 방식이 알려진 위치에 두는 디렉터리와, 노드 버전 관리자가 만드는 디렉터리 중
/// 실제로 존재하는 것을 합친다.
fn fallback_executable_dirs(home: &Path) -> Vec<PathBuf> {
    let mut directories = common_executable_dirs(home);
    directories.extend(node_version_manager_dirs(home));
    deduplicate_paths(&mut directories);
    directories
}

/// 로그인 셸과 설치 방식별 폴백에서 찾은 추가 실행 경로를 우선순위대로 합친다.
/// CLI 탐지와 장기 실행 자식의 PATH 보강이 같은 후보 집합을 보도록 한 자리에서
/// 중복을 제거한다.
fn supplemental_executable_dirs(home: &Path) -> Vec<PathBuf> {
    let mut directories = login_shell_path_dirs().to_vec();
    directories.extend(fallback_executable_dirs(home));
    deduplicate_paths(&mut directories);
    directories
}

fn common_executable_dirs(home: &Path) -> Vec<PathBuf> {
    let mut directories = vec![
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        home.join(".cargo/bin"),
    ];

    if cfg!(target_os = "macos") {
        directories.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/Applications/Tailscale.app/Contents/MacOS"),
        ]);
    }

    if cfg!(windows) {
        directories.extend(windows_system_dirs(env::var_os("SystemRoot")));
        if let Some(app_data) = env::var_os("APPDATA") {
            directories.push(PathBuf::from(app_data).join("npm"));
        }
        if let Some(program_files) = env::var_os("ProgramFiles") {
            directories.push(PathBuf::from(program_files).join("Tailscale"));
        }
    }

    directories
}

/// Windows 기본 명령이 놓인 디렉터리. 설치 드라이브를 가정하지 않고 관련 시스템 변수만
/// 읽으며, 상대 값은 PATH에 넣지 않는다(G8, G9).
///
/// System32만으로는 모자란다. 셸 내장처럼 보이는 `chcp`는 거기 있지만, Cypress가 Windows에서
/// 설치된 브라우저와 버전을 조회할 때 띄우는 `powershell.exe`는 System32가 아니라 그 아래
/// `WindowsPowerShell\v1.0`에 있다. GUI로 뜬 앱이 짧은 PATH를 물려받으면 그 조회가
/// `spawn powershell.exe ENOENT`로 죽어 Cypress가 기동조차 못 했다. 기본 명령이 놓이는
/// 네 곳을 모두, 물려받은 PATH 상태와 무관하게 넣는다. 순서는 Windows 기본 PATH와 같다.
fn windows_system_dirs(system_root: Option<OsString>) -> Vec<PathBuf> {
    let Some(root) = system_root
        .map(PathBuf::from)
        .filter(|root| root.is_absolute())
    else {
        return Vec::new();
    };
    let system32 = root.join("System32");
    vec![
        system32.clone(),
        root,
        system32.join("Wbem"),
        system32.join("WindowsPowerShell").join("v1.0"),
    ]
}

/// 노드 버전 관리자·대안 패키지 관리자가 전역 CLI를 두는 디렉터리 중 존재하는 것.
/// volta·bun·pnpm·yarn·asdf·mise·fnm은 위치가 고정이고, nvm은 버전별 디렉터리라
/// 설치된 버전을 훑어 최신부터 넣는다. 존재하지 않는 후보는 PATH를 어지럽히지 않게 뺀다.
fn node_version_manager_dirs(home: &Path) -> Vec<PathBuf> {
    let mut directories = vec![
        home.join(".volta/bin"),
        home.join(".bun/bin"),
        home.join(".yarn/bin"),
        home.join(".asdf/shims"),
        home.join(".local/share/mise/shims"),
        home.join(".local/share/fnm/aliases/default/bin"),
    ];
    if cfg!(target_os = "macos") {
        directories.extend([
            home.join("Library/pnpm"),
            home.join("Library/Application Support/fnm/aliases/default/bin"),
        ]);
    }
    if let Some(data_home) = env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        let data_home = PathBuf::from(data_home);
        directories.push(data_home.join("mise/shims"));
        directories.push(data_home.join("fnm/aliases/default/bin"));
    }
    directories.retain(|directory| directory.is_dir());
    let nvm_dir = env::var_os("NVM_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".nvm"));
    directories.extend(nvm_version_bin_dirs(&nvm_dir));
    directories
}

/// `~/.nvm/versions/node/v<major>.<minor>.<patch>/bin`을 버전 내림차순으로 나열한다.
/// nvm은 프로필 없이 알 수 있는 "기본 버전" 심링크를 두지 않으므로 최신부터 모두 넣는다.
fn nvm_version_bin_dirs(nvm_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(nvm_dir.join("versions/node")) else {
        return Vec::new();
    };
    let mut versions = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let version = parse_node_version(&name.to_string_lossy())?;
            let bin = entry.path().join("bin");
            bin.is_dir().then_some((version, bin))
        })
        .collect::<Vec<_>>();
    versions.sort_by_key(|(version, _)| std::cmp::Reverse(*version));
    versions.into_iter().map(|(_, bin)| bin).collect()
}

fn parse_node_version(name: &str) -> Option<(u64, u64, u64)> {
    let mut parts = name.strip_prefix('v')?.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((major, minor, patch))
}

fn deduplicate_paths(paths: &mut Vec<PathBuf>) {
    let mut seen = HashSet::new();
    paths.retain(|path| !path.as_os_str().is_empty() && seen.insert(path.clone()));
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    mod native_npm {
        use super::super::*;

        /// 셈과 네이티브 실행 파일을 함께 깐 npm 설치를 흉내낸다.
        fn install(dir: &std::path::Path, shim: &str, relative: &str) -> PathBuf {
            let native = dir.join(relative);
            fs::create_dir_all(native.parent().expect("부모")).expect("네이티브 디렉터리");
            fs::write(&native, b"MZ").expect("네이티브 파일");
            let shim = dir.join(shim);
            fs::write(&shim, b"@ECHO off").expect("셈 파일");
            shim
        }

        #[test]
        fn a_cmd_shim_resolves_to_the_native_executable_beside_it() {
            let dir = tempfile::tempdir().expect("임시 디렉터리");
            for (shim, relative) in NATIVE_NPM_TARGETS {
                let shim_path = install(dir.path(), &format!("{shim}.cmd"), relative);
                assert_eq!(
                    native_npm_executable(&shim_path),
                    Some(dir.path().join(relative)),
                    "{shim}",
                );
            }
        }

        #[test]
        fn a_shim_without_its_native_file_keeps_the_detected_path() {
            // 패키지가 네이티브를 깔지 않은 설치도 있다. 없는 경로를 돌려주면 기동이 죽는다.
            let dir = tempfile::tempdir().expect("임시 디렉터리");
            let shim = dir.path().join("opencode.cmd");
            fs::write(&shim, b"@ECHO off").expect("셈 파일");
            assert_eq!(native_npm_executable(&shim), None);
        }

        #[test]
        fn only_cmd_shims_are_redirected() {
            // 네이티브 실행 파일을 직접 찾은 경우까지 다시 옮기면 엉뚱한 곳을 가리킨다.
            let dir = tempfile::tempdir().expect("임시 디렉터리");
            let exe = dir.path().join("opencode.exe");
            fs::write(&exe, b"MZ").expect("실행 파일");
            assert_eq!(native_npm_executable(&exe), None);
        }

        #[test]
        fn an_unknown_shim_is_left_alone() {
            let dir = tempfile::tempdir().expect("임시 디렉터리");
            let shim = dir.path().join("codex.cmd");
            fs::write(&shim, b"@ECHO off").expect("셈 파일");
            assert_eq!(native_npm_executable(&shim), None);
        }
    }

    use super::*;
    fn temporary_directory() -> PathBuf {
        tempfile::Builder::new()
            .prefix("agent-manager-core-")
            .tempdir()
            .expect("temporary directory must be created")
            .keep()
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        fs::write(path, "#!/bin/sh\n").expect("fixture must be written");
        let mut permissions = fs::metadata(path)
            .expect("fixture metadata must exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).expect("fixture permissions must be set");
    }

    /// `provider_spec`은 표에서 찾지 못하면 panic한다. 공급자를 늘리고 이 표에 행을
    /// 빠뜨리면 컴파일은 통과한 채 실행 중에 죽으므로, 전수 순회로 그 구멍을 막는다.
    #[test]
    fn every_provider_has_a_detection_spec() {
        for provider in ProviderId::ALL {
            let spec = provider_spec(provider);
            assert_eq!(spec.id, provider);
            assert!(
                !provider_display_name(provider).is_empty(),
                "{provider} 표시명"
            );
            assert!(
                !spec.executable_names.is_empty(),
                "{provider} 실행 파일 이름"
            );
        }
    }

    /// 로컬 공급자는 자기 CLI 없이 ACP 하네스를 빌려 쓴다. 기록 경로는 하네스의 세션 DB
    /// 하나뿐이고, 카탈로그가 읽는 파일과 같아야 카드의 "채팅 탐지"와 목록이 어긋나지 않는다.
    #[test]
    fn the_local_provider_borrows_the_acp_harness_and_its_session_db() {
        let local = provider_spec(ProviderId::Local);
        assert_eq!(local.executable_names, &["opencode"]);
        assert_eq!(local.history_paths, &[OPENCODE_SESSION_DB_RELATIVE]);
        // Codex 것을 빌리던 시절의 흔적이 남아 있으면 두 공급자가 같은 rollout을 훑는다.
        assert_ne!(
            local.executable_names,
            provider_spec(ProviderId::Codex).executable_names,
        );
    }

    #[test]
    #[cfg(unix)]
    fn detects_cli_and_history_as_separate_resources() {
        let root = temporary_directory();
        let bin = root.join("bin");
        let home = root.join("home");
        fs::create_dir_all(&bin).expect("bin directory must be created");
        fs::create_dir_all(home.join(".codex/sessions"))
            .expect("history directory must be created");
        make_executable(&bin.join("codex"));

        let context = DetectionContext {
            home,
            search_dirs: vec![bin],
            executable_extensions: Vec::new(),
        };
        let status = inspect_with_context(&context);
        let codex = status
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Codex)
            .expect("Codex status must exist");

        assert!(codex.cli.detected);
        assert!(codex.history.detected);
        assert_ne!(codex.cli.path, codex.history.path);

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    #[test]
    #[cfg(unix)]
    fn detects_antigravity_cli_using_the_agy_binary_name() {
        let root = temporary_directory();
        let bin = root.join("bin");
        let home = root.join("home");
        fs::create_dir_all(&bin).expect("bin directory must be created");
        fs::create_dir_all(&home).expect("home directory must be created");
        make_executable(&bin.join("agy"));

        let context = DetectionContext {
            home,
            search_dirs: vec![bin],
            executable_extensions: Vec::new(),
        };
        let status = inspect_with_context(&context);
        let antigravity = status
            .providers
            .iter()
            .find(|provider| provider.provider == ProviderId::Antigravity)
            .expect("Antigravity status must exist");

        assert!(antigravity.cli.detected);
        assert!(antigravity
            .cli
            .path
            .as_deref()
            .is_some_and(|path| path.ends_with("/agy")));

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    #[test]
    fn reports_missing_resources_without_inventing_paths() {
        let root = temporary_directory();
        let context = DetectionContext {
            home: root.clone(),
            search_dirs: Vec::new(),
            executable_extensions: Vec::new(),
        };

        let status = inspect_with_context(&context);

        assert!(status.providers.iter().all(|provider| {
            !provider.cli.detected
                && provider.cli.path.is_none()
                && !provider.history.detected
                && provider.history.path.is_none()
        }));

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    #[test]
    #[cfg(windows)]
    fn detects_pathext_launcher_before_extensionless_npm_script() {
        let root = temporary_directory();
        let shell_script = root.join("agy");
        let cmd_launcher = root.join("agy.CMD");
        fs::write(&shell_script, "#!/bin/sh\n").expect("shell script fixture");
        fs::write(&cmd_launcher, "@echo off\r\n").expect("cmd launcher fixture");
        let context = DetectionContext {
            home: root.clone(),
            search_dirs: vec![root.clone()],
            executable_extensions: vec![OsString::from(".EXE"), OsString::from(".CMD")],
        };

        assert_eq!(find_executable(&["agy"], &context), Some(cmd_launcher));

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    #[test]
    #[cfg(windows)]
    fn claude_npm_shim_resolves_to_the_package_native_executable() {
        let root = temporary_directory();
        let cmd_launcher = root.join("claude.CMD");
        let native = root.join("node_modules/@anthropic-ai/claude-code/bin/claude.exe");
        fs::create_dir_all(native.parent().expect("native parent")).expect("native directory");
        fs::write(&cmd_launcher, "@echo off\r\n").expect("cmd launcher fixture");
        fs::write(&native, "fixture").expect("native executable fixture");
        let context = DetectionContext {
            home: root.clone(),
            search_dirs: vec![root.clone()],
            executable_extensions: vec![OsString::from(".EXE"), OsString::from(".CMD")],
        };

        assert_eq!(
            find_provider_executable(provider_spec(ProviderId::Claude), &context),
            Some(native)
        );

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    #[test]
    #[cfg(windows)]
    fn claude_npm_shim_remains_the_fallback_without_a_native_executable() {
        let root = temporary_directory();
        let cmd_launcher = root.join("claude.CMD");
        fs::write(&cmd_launcher, "@echo off\r\n").expect("cmd launcher fixture");
        let context = DetectionContext {
            home: root.clone(),
            search_dirs: vec![root.clone()],
            executable_extensions: vec![OsString::from(".EXE"), OsString::from(".CMD")],
        };

        assert_eq!(
            find_provider_executable(provider_spec(ProviderId::Claude), &context),
            Some(cmd_launcher)
        );

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    #[test]
    #[cfg(windows)]
    fn antigravity_ide_launcher_is_not_detected_as_the_cli() {
        let root = temporary_directory();
        let ide_bin = root.join("ide");
        let cli_bin = root.join("cli");
        fs::create_dir_all(&ide_bin).expect("IDE bin directory");
        fs::create_dir_all(&cli_bin).expect("CLI bin directory");
        fs::write(ide_bin.join("antigravity.CMD"), "@echo off\r\n").expect("IDE launcher");
        fs::write(cli_bin.join("agy.EXE"), "fixture").expect("CLI fixture");
        let context = DetectionContext {
            home: root.clone(),
            search_dirs: vec![ide_bin, cli_bin.clone()],
            executable_extensions: vec![OsString::from(".EXE"), OsString::from(".CMD")],
        };

        let antigravity = inspect_with_context(&context)
            .providers
            .into_iter()
            .find(|provider| provider.provider == ProviderId::Antigravity)
            .expect("Antigravity status");
        // 탐지 결과는 그대로 자식 실행 파일 경로가 되므로 접두어를 달고 나오지 않는다.
        let expected_cli = crate::path_guard::canonical_child_facing(cli_bin.join("agy.EXE"))
            .expect("canonical CLI path");
        assert_eq!(
            antigravity.cli.path,
            Some(expected_cli.to_string_lossy().into_owned())
        );

        fs::remove_dir_all(root).expect("temporary directory must be removed");
    }

    /// 셔뱅 스크립트(npm)의 인터프리터를 찾게 하려면 탐색 디렉터리가 실행 환경의
    /// PATH에도 있어야 한다. 실행 파일 자신의 디렉터리가 맨 앞이고, 탐색에 쓰는
    /// 공통 디렉터리가 빠지지 않는지 확인한다.
    #[test]
    #[cfg(unix)]
    fn command_search_path_carries_search_dirs_into_the_child() {
        let path = command_search_path(Path::new("/opt/example/bin/npm"))
            .expect("HOME이 있으면 PATH를 만든다");
        let directories = env::split_paths(&path).collect::<Vec<_>>();

        assert_eq!(
            directories.first().map(PathBuf::as_path),
            Some(Path::new("/opt/example/bin"))
        );
        let home = env::var_os("HOME").map(PathBuf::from).expect("HOME");
        for expected in common_executable_dirs(&home) {
            assert!(
                directories.contains(&expected),
                "{} 가 실행 PATH에 없다",
                expected.display()
            );
        }
        let unique = directories.iter().collect::<HashSet<_>>();
        assert_eq!(unique.len(), directories.len(), "PATH에 중복 항목이 있다");
    }

    /// Windows 기본 명령은 System32 한 곳에만 있지 않다. `SystemRoot` 하나에서 네 곳을
    /// 모두 만들고, 상대 경로는 앱의 작업 디렉터리에 따라 다른 파일을 가리키므로 버린다.
    #[test]
    fn windows_system_dirs_are_the_four_default_command_locations() {
        assert!(windows_system_dirs(Some(OsString::from("Windows"))).is_empty());
        assert!(windows_system_dirs(None).is_empty());

        let root = if cfg!(windows) {
            r"C:\Windows"
        } else {
            "/Windows"
        };
        let dirs = windows_system_dirs(Some(OsString::from(root)));
        let root = PathBuf::from(root);
        let system32 = root.join("System32");
        assert_eq!(
            dirs,
            vec![
                system32.clone(),
                root,
                system32.join("Wbem"),
                // Cypress의 브라우저 탐지가 띄우는 `powershell.exe`는 System32가 아니라 여기 있다.
                system32.join("WindowsPowerShell").join("v1.0"),
            ]
        );
    }

    /// Windows 자식은 사용자 PATH 순서를 그대로 둔 채 실제 SystemRoot의 기본 명령 디렉터리를
    /// 폴백으로 받는다. 그래야 `chcp`·`powershell.exe` 같은 시스템 실행 파일을 설치 드라이브와
    /// 물려받은 PATH 상태에 무관하게 찾는다.
    #[test]
    #[cfg(windows)]
    fn command_search_path_appends_the_actual_windows_system_dirs() {
        // 같은 디렉터리가 PATH에 두 번 적혀 있으면 자식에는 한 번만 남는다. 중복을 먼저
        // 걷어내지 않으면 "첫 위치"가 되감겨 순서가 깨진 것처럼 보인다.
        let mut inherited = env::var_os("PATH")
            .map(|value| env::split_paths(&value).collect::<Vec<_>>())
            .unwrap_or_default();
        deduplicate_paths(&mut inherited);
        let path = command_search_path(Path::new(r"C:\tools\node.exe")).expect("child PATH");
        let directories = env::split_paths(&path).collect::<Vec<_>>();
        let system_dirs = windows_system_dirs(env::var_os("SystemRoot"));
        assert!(!system_dirs.is_empty(), "SystemRoot");

        let home = env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .expect("USERPROFILE");
        let common = common_executable_dirs(&home);
        for expected in &system_dirs {
            assert!(directories.contains(expected), "{}", expected.display());
            assert!(common.contains(expected), "{}", expected.display());
        }
        assert!(
            system_dirs
                .iter()
                .any(|dir| dir.join("powershell.exe").is_file()),
            "자식 PATH에서 powershell.exe를 찾을 수 있어야 한다"
        );
        let inherited_positions = inherited
            .iter()
            .filter_map(|entry| directories.iter().position(|candidate| candidate == entry))
            .collect::<Vec<_>>();
        assert!(inherited_positions
            .windows(2)
            .all(|pair| pair[0] <= pair[1]));
    }

    /// 오래 사는 자식은 손자까지 PATH를 물려주므로 우선순위가 바뀌면 안 된다.
    /// 상속한 문자열이 접두사로 그대로 남고, 뒤에 덧붙은 것만 새 디렉터리인지 확인한다.
    #[test]
    #[cfg(unix)]
    fn appended_search_path_only_grows_the_tail() {
        let Some(path) = appended_search_path() else {
            // 이미 공통 디렉터리가 모두 PATH에 있는 환경이면 손댈 일이 없다.
            return;
        };
        let inherited = env::var("PATH").expect("PATH");
        let extended = path.to_string_lossy().into_owned();

        assert!(
            extended.starts_with(&inherited),
            "상속한 PATH가 접두사로 남아야 한다"
        );
        // 상속 PATH에 같은 디렉터리가 중복으로 들어 있어도(셸 프로필이 흔히 만든다)
        // 건너뛸 개수는 집합 크기가 아니라 항목 수여야 상속 구간을 정확히 지난다.
        let inherited_count = env::split_paths(&inherited).count();
        let inherited_dirs = env::split_paths(&inherited).collect::<HashSet<_>>();
        for added in env::split_paths(&extended).skip(inherited_count) {
            assert!(
                !inherited_dirs.contains(&added),
                "{} 는 이미 PATH에 있던 디렉터리다",
                added.display()
            );
        }
    }

    /// 로그인 셸 출력에서 표식 사이의 `PATH=` 줄만 읽는다. 프로필이 표식 앞에 찍는
    /// 배너와, 표식이 하나뿐인 잘린 출력, 상대 경로 항목은 무시해야 한다.
    #[test]
    #[cfg(unix)]
    fn login_shell_path_is_read_between_markers_only() {
        let output = format!(
            "Welcome back!\nPATH=/from/banner\n{m}\nHOME=/Users/me\nPATH=/Users/me/.nvm/versions/node/v22.1.0/bin:/opt/homebrew/bin::.:~/.dotnet/tools:/usr/bin\nSHELL=/bin/zsh\n{m}\n",
            m = LOGIN_SHELL_PATH_MARKER
        );
        assert_eq!(
            parse_login_shell_path(&output),
            Some(vec![
                PathBuf::from("/Users/me/.nvm/versions/node/v22.1.0/bin"),
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/bin"),
            ])
        );

        let truncated = format!("{m}\nPATH=/usr/bin\n", m = LOGIN_SHELL_PATH_MARKER);
        assert_eq!(parse_login_shell_path(&truncated), None);
        assert_eq!(parse_login_shell_path("PATH=/usr/bin\n"), None);
    }

    /// nvm은 버전별 디렉터리만 두므로 설치된 버전을 최신부터 모두 넣고, 버전 이름이
    /// 아닌 항목과 `bin`이 없는 항목은 건너뛴다.
    #[test]
    fn nvm_version_bins_are_listed_newest_first() {
        let nvm_dir = temporary_directory().join(".nvm");
        let versions = nvm_dir.join("versions/node");
        for version in ["v18.20.4", "v22.1.0", "v20.11.1"] {
            fs::create_dir_all(versions.join(version).join("bin")).unwrap();
        }
        fs::create_dir_all(versions.join("v9.9.9")).unwrap(); // bin 없음
        fs::create_dir_all(versions.join("latest")).unwrap(); // 버전 이름 아님

        assert_eq!(
            nvm_version_bin_dirs(&nvm_dir),
            vec![
                versions.join("v22.1.0/bin"),
                versions.join("v20.11.1/bin"),
                versions.join("v18.20.4/bin"),
            ]
        );
    }

    /// 버전 관리자 폴백은 실제로 있는 디렉터리만 넣어 PATH를 어지럽히지 않는다.
    #[test]
    fn version_manager_fallback_keeps_only_existing_directories() {
        let home = temporary_directory();
        fs::create_dir_all(home.join(".volta/bin")).unwrap();
        fs::create_dir_all(home.join(".bun/bin")).unwrap();

        let dirs = node_version_manager_dirs(&home);
        assert!(dirs.contains(&home.join(".volta/bin")));
        assert!(dirs.contains(&home.join(".bun/bin")));
        assert!(!dirs.contains(&home.join(".yarn/bin")));
        assert!(!dirs.contains(&home.join(".asdf/shims")));
    }

    /// 새 기기에서 탐지가 안 될 때 로그인 셸 PATH가 실제로 무엇을 돌려주는지 보는 진단용.
    /// `cargo test -q -p agent-manager-core --lib providers::tests::print_login_shell_path -- --ignored --nocapture`
    #[test]
    #[ignore]
    #[cfg(unix)]
    fn print_login_shell_path_for_diagnosis() {
        for directory in login_shell_path_dirs() {
            println!("{}", directory.display());
        }
    }

    #[test]
    fn node_version_names_require_three_numeric_parts() {
        assert_eq!(parse_node_version("v22.1.0"), Some((22, 1, 0)));
        assert_eq!(parse_node_version("22.1.0"), None);
        assert_eq!(parse_node_version("v22.1"), None);
        assert_eq!(parse_node_version("v22.1.0.1"), None);
        assert_eq!(parse_node_version("latest"), None);
    }
}
