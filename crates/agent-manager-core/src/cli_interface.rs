//! 설치된 공급자 CLI의 실제 인터페이스 조사.
//!
//! 고정 argv `--help`만 실행하고, 출력에서 롱 플래그 이름과 열거형 허용값을 뽑는다.
//! 셸 문자열을 만들지 않고, 사용자 입력은 명령에 들어가지 않으며, 실행은 제한시간과
//! 출력 크기 상한을 가진다. `--version` 조회와 같은 등급의 읽기 작업이다.
//!
//! 판정은 한 방향으로만 강하다.
//! - 어떤 플래그의 **허용값 목록을 읽어냈을 때만** "그 값은 지원하지 않는다"고 결론
//!   내린다. 목록을 읽지 못하면 판단을 보류한다.
//! - 플래그가 도움말에 없다는 사실은 미지원 근거가 못 된다. Claude Code의
//!   `--permission-prompt-tool`처럼 실제로 동작하지만 도움말에 나오지 않는 플래그가
//!   있다. 그래서 플래그 존재는 "지원한다"는 긍정 근거로만 쓴다.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use crate::process_output::CappedOutputReaders;
use crate::CoreError;

/// 도움말은 즉시 출력된다. 여기서 막히면 조사를 포기하고 내장 스키마를 쓴다.
const HELP_COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// 모든 공급자 CLI가 최상위 `--help`에 실행 관련 옵션 전체를 노출한다. Codex는
/// 대화형 도움말에 `--sandbox`와 `--ask-for-approval`이 함께 들어 있어 한 번으로 족하다.
const HELP_ARGS: &[&str] = &["--help"];

/// 도움말에서 플래그를 이만큼도 못 읽었으면 형식이 바뀐 것으로 보고 조사를 실패로 둔다.
const MIN_RELIABLE_FLAG_COUNT: usize = 4;

/// 조사된 CLI 인터페이스. 플래그 집합과 플래그별 허용값 목록만 담는다.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CliInterface {
    flags: BTreeSet<String>,
    values: BTreeMap<String, BTreeSet<String>>,
}

impl CliInterface {
    /// 도움말 텍스트를 옵션 블록으로 나눠 플래그와 허용값을 모은다.
    pub(crate) fn parse(help: &str) -> Self {
        let mut interface = Self::default();
        // 블록 밖 산문에 언급된 플래그도 존재 근거로 담는다. 존재는 긍정 근거로만
        // 쓰이므로 과다 수집이 선택지를 잘못 지우는 방향으로 작동하지 않는다.
        interface.record_flags(long_flags(help), None);
        for block in option_blocks(help) {
            let names = long_flags(block[0]);
            if names.is_empty() {
                continue;
            }
            let values = block_values(&block);
            interface.record_flags(names, values.as_ref());
        }
        interface
    }

    fn record_flags(
        &mut self,
        flags: impl IntoIterator<Item = String>,
        values: Option<&BTreeSet<String>>,
    ) {
        for flag in flags {
            self.flags.insert(flag.clone());
            if let Some(values) = values {
                self.values
                    .entry(flag)
                    .or_default()
                    .extend(values.iter().cloned());
            }
        }
    }

    pub(crate) fn has_flag(&self, flag: &str) -> bool {
        self.flags.contains(flag)
    }

    /// 읽어낸 허용값 목록. 목록을 못 뽑았으면 None이며, 그때는 판단을 보류해야 한다.
    pub(crate) fn values_for(&self, flag: &str) -> Option<&BTreeSet<String>> {
        self.values.get(flag).filter(|values| !values.is_empty())
    }

    /// 허용값 목록을 읽어냈다면 그 목록에 값이 있는지, 못 읽었으면 판단을 보류하고 true.
    pub(crate) fn accepts_value(&self, flag: &str, value: &str) -> bool {
        match self.values_for(flag) {
            Some(values) => values.contains(value),
            _ => true,
        }
    }

    /// 도움말을 실제로 읽어낸 것으로 볼 수 있는지. 형식이 바뀌어 거의 아무것도 못
    /// 뽑았다면 조사 결과로 내장 스키마를 덮지 않는다.
    pub(crate) fn is_reliable(&self) -> bool {
        self.flags.len() >= MIN_RELIABLE_FLAG_COUNT
    }
}

/// 탐지된 실행 파일에 `--help`를 실행해 인터페이스를 조사한다.
pub(crate) fn probe_cli_interface(executable: &Path) -> Result<CliInterface, CoreError> {
    let outcome = run_capped(executable, HELP_ARGS, HELP_COMMAND_TIMEOUT)?;
    if outcome.timed_out {
        return Err(CoreError::Runtime(format!(
            "{} --help 실행 시간이 초과되었습니다",
            executable.to_string_lossy()
        )));
    }
    // Antigravity CLI(Go flag)는 도움말을 stderr로 내보내므로 두 스트림을 합쳐 읽는다.
    let help = format!("{}\n{}", outcome.stdout, outcome.stderr);
    let interface = CliInterface::parse(&help);
    if !interface.is_reliable() {
        return Err(CoreError::Runtime(format!(
            "{} --help 출력에서 옵션을 읽지 못했습니다",
            executable.to_string_lossy()
        )));
    }
    Ok(interface)
}

/// 옵션 선언 줄과 그에 딸린 설명 줄을 한 블록으로 묶는다. 블록 경계는 "들여쓴 줄이
/// `-`로 시작한다"는, commander·clap·Go flag 도움말이 공통으로 지키는 규칙으로 잡는다.
fn option_blocks(help: &str) -> Vec<Vec<&str>> {
    let mut blocks = Vec::new();
    let mut current = None;
    for line in help.lines() {
        if is_option_header(line) {
            if let Some(block) = current.replace(vec![line]) {
                blocks.push(block);
            }
        } else if !line.trim().is_empty() && !line.starts_with(char::is_whitespace) {
            // 들여쓰기가 없는 줄은 새 섹션 제목이므로 블록을 닫는다.
            blocks.extend(current.take());
        } else if let Some(block) = current.as_mut() {
            block.push(line);
        }
    }
    blocks.extend(current);
    blocks
}

fn is_option_header(line: &str) -> bool {
    let trimmed = line.trim_start();
    line.starts_with(char::is_whitespace)
        && trimmed.starts_with('-')
        && !trimmed.starts_with("- ")
        && trimmed.contains("--")
}

/// 텍스트에 등장하는 롱 플래그 이름을 모은다.
fn long_flags(text: &str) -> Vec<String> {
    let mut flags = Vec::new();
    let bytes = text.as_bytes();
    let mut index = 0;
    while let Some(offset) = text[index..].find("--") {
        let start = index + offset;
        // `--` 앞이 단어 문자면 플래그 선언이 아니다(예: `foo--bar`).
        let boundary = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let mut end = start + 2;
        while end < bytes.len()
            && (bytes[end].is_ascii_alphanumeric() || matches!(bytes[end], b'-' | b'_'))
        {
            end += 1;
        }
        let name = &text[start..end];
        if boundary && name.len() > 3 && name[2..].starts_with(|c: char| c.is_ascii_alphanumeric())
        {
            flags.push(name.trim_end_matches('-').to_owned());
        }
        index = end.max(start + 2);
    }
    flags
}

/// 블록에서 허용값 목록을 뽑는다. 확실한 형식부터 차례로 시도하고, 어느 것도
/// 맞지 않으면 None을 돌려 판단을 보류한다.
fn block_values(block: &[&str]) -> Option<BTreeSet<String>> {
    let joined = collapse_whitespace(&block.join(" "));
    possible_values_inline(&joined)
        .or_else(|| possible_values_bullets(block))
        .or_else(|| commander_choices(&joined))
        .or_else(|| parenthesized_values(&joined))
}

/// clap 축약 형식: `[possible values: read-only, workspace-write, danger-full-access]`
fn possible_values_inline(joined: &str) -> Option<BTreeSet<String>> {
    let rest = &joined[position_after_ignore_case(joined, "possible values:")?..];
    let end = rest.find(']')?;
    identifier_set(rest[..end].split(','))
}

/// clap 상세 형식: `Possible values:` 아래에 `- untrusted: 설명` 목록이 붙는다.
fn possible_values_bullets(block: &[&str]) -> Option<BTreeSet<String>> {
    let start = block
        .iter()
        .position(|line| position_after_ignore_case(line, "possible values:").is_some())?;
    let names = block[start + 1..].iter().filter_map(|line| {
        let trimmed = line.trim_start();
        trimmed
            .strip_prefix("- ")
            .map(|rest| rest.split(':').next().unwrap_or(rest))
    });
    identifier_set(names)
}

/// commander 형식: `(choices: "acceptEdits", "auto", "bypassPermissions")`
fn commander_choices(joined: &str) -> Option<BTreeSet<String>> {
    let rest = &joined[position_after_ignore_case(joined, "choices:")?..];
    let end = rest.find(')').unwrap_or(rest.len());
    identifier_set(rest[..end].split('"').skip(1).step_by(2))
}

/// Go flag 형식: 설명 안의 `(accept-edits, plan)` 또는 `(low|medium|high)`.
/// 값이 2개 이상이고 모두 식별자일 때만 인정한다.
fn parenthesized_values(joined: &str) -> Option<BTreeSet<String>> {
    let mut rest = joined;
    while let Some(open) = rest.find('(') {
        let after = &rest[open + 1..];
        let close = after.find(')')?;
        let group = &after[..close];
        let separator = if group.contains('|') { '|' } else { ',' };
        if let Some(values) = identifier_set(group.split(separator)) {
            if values.len() > 1 {
                return Some(values);
            }
        }
        rest = &after[close..];
    }
    None
}

/// 모든 항목이 열거형 값처럼 생겼을 때만 집합을 만든다. 하나라도 산문이면 포기한다.
fn identifier_set<'a>(items: impl Iterator<Item = &'a str>) -> Option<BTreeSet<String>> {
    let mut values = BTreeSet::new();
    for item in items {
        let item = item.trim();
        if item.is_empty() || !is_enum_identifier(item) {
            return None;
        }
        values.insert(item.to_owned());
    }
    (!values.is_empty()).then_some(values)
}

fn is_enum_identifier(value: &str) -> bool {
    value.len() <= 64
        && value.starts_with(|c: char| c.is_ascii_alphabetic())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// 대소문자를 무시하고 needle을 찾아, 그 **뒤** 위치를 돌려준다. ASCII 소문자 변환은
/// 바이트 길이를 바꾸지 않으므로 원문 슬라이스 인덱스로 그대로 쓸 수 있다.
fn position_after_ignore_case(haystack: &str, needle: &str) -> Option<usize> {
    haystack
        .to_ascii_lowercase()
        .find(needle)
        .map(|index| index + needle.len())
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------
// 외부 명령 실행
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandOutcome {
    pub(crate) success: bool,
    pub(crate) timed_out: bool,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
}

/// 출력을 파이프로 받는 외부 명령의 공통 준비. 종료까지 모아 받는 [`run_capped`]와 줄
/// 단위로 흘리는 호출자가 같은 환경으로 자식을 띄우도록 한 곳에 둔다.
pub(crate) fn capped_command(executable: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 색상 escape와 힌트 배너는 파싱만 어렵게 하므로 이 실행에서만 끈다.
        .env("NO_COLOR", "1")
        .env("HOMEBREW_NO_ENV_HINTS", "1");
    // 절대경로로 실행해도 셔뱅 인터프리터(npm의 `env node`)는 자식 PATH에서 찾는다.
    // 탐색에 쓴 디렉터리를 실행 환경에도 넘겨야 GUI 실행 시의 빈약한 PATH에서 죽지 않는다.
    if let Some(path) = crate::providers::command_search_path(executable) {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

pub(crate) fn run_capped(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<CommandOutcome, CoreError> {
    run_capped_with(executable, args, timeout, &CappedOptions::default())
}

/// [`run_capped_with`]가 받는 선택지. 환경변수·stdin·작업 폴더·자격증명 변수 제거·
/// 프로세스 그룹은 서로를 모르는 갈래라 한 벌로 묶어 받되, 자식을 띄우고 제한 시간까지
/// 지켜보는 절차는 한 자리만 둔다. 세 기존 래퍼는 이 구조체의 한 칸만 채운다.
#[derive(Default)]
pub(crate) struct CappedOptions<'a> {
    pub(crate) env: &'a [(String, String)],
    /// 자식에게 물려주지 않을 변수. 상속된 리디렉션(`GIT_DIR` 등)이 사용자가 고른 대상을
    /// 다른 곳으로 옮기지 못하게 하는 자리다.
    pub(crate) env_remove: &'a [&'a str],
    /// stdin으로 한 번 써 넣고 닫을 바이트. 개행을 붙이지 않는다 — 붙일지는 호출부가 정한다.
    pub(crate) input: Option<&'a [u8]>,
    pub(crate) current_dir: Option<&'a Path>,
    /// `strip_inherited_credential_env`를 적용할지. 공급자 CLI가 아닌 자식(git 등)이
    /// 계정별 자격증명 경로를 물려받을 이유가 없다.
    pub(crate) strip_credential_env: bool,
    /// 자식을 자기 프로세스 그룹에 두고 제한 시간에 그룹째 죽일지. 자식이 다시 자식을
    /// 띄우는 명령(`git fetch` → `ssh`·자격증명 도우미)에서만 의미가 있다.
    pub(crate) own_process_group: bool,
}

/// 프로세스 그룹 전체에 강제 종료를 보낸다. 실행 시간을 넘긴 자식을 정리하는 마지막
/// 수단이라, 이미 사라졌거나 신호를 보내지 못해도 더 할 일이 없다.
///
/// 유닉스 전용이다. 윈도우에는 그룹 신호가 없으므로 호출자는 이 함수 대신
/// [`ProcessGroup`]을 쓴다 — 예전의 빈 윈도우 본문은 부르는 쪽이 아무 일도 안 일어났다는
/// 것을 모르게 만들었다(cypress 실행기가 그 함정에 걸려 있었다).
#[cfg(unix)]
fn kill_process_group(pid: u32) {
    let _ = crate::process_signal::signal_process_group(pid, libc::SIGKILL);
}

/// 제한 시간에 자식 **하나가 아니라 그 자손까지** 함께 끝내기 위한 손잡이.
///
/// 왜 이것이 따로 필요한가. `Child::kill`은 어느 플랫폼에서도 그 프로세스 하나만 끝낸다.
/// 그런데 이 모듈이 띄우는 명령 가운데 `git fetch`·`git pull`·`git push`는 다시 자식을
/// 띄우고(`ssh`, 자격증명 도우미), 그 손자는 부모가 사라져도 살아남는다. C16-3이
/// "제한 시간은 프로세스 그룹을 죽여 `ssh`와 자격증명 도우미가 함께 죽게 한다"고 적어 둔
/// 자리가 여기다.
///
/// **2026-10-05까지 그 약속은 유닉스에서만 지켜지고 있었다.** `own_process_group`가 거는
/// 두 장치가 모두 `#[cfg(unix)]`였다 — `Command::process_group(0)`도, `kill_process_group`도
/// (후자는 `#[cfg(not(unix))]`에서 본문이 빈 함수였다). 그래서 윈도우에서 이 선택지는
/// **아무 일도 하지 않았고**, 결과는 떠도는 `ssh.exe` 하나로 끝나지 않는다. 손자가 자식의
/// stdout·stderr 쓰기 핸들을 물려받은 채 살아 있으면 파이프에 EOF가 오지 않고,
/// 출력을 끝까지 읽는 `CappedOutputReaders::finish`가 **영원히 막힌다** — 제한 시간이
/// 도는 대신 `run_capped_with` 자체가 돌아오지 않는다. 비대화 실행이 "멈추지 않고 빨리
/// 실패한다"(C16-3)는 약속이 그 자리에서 뒤집힌다.
///
/// 윈도우에는 프로세스 그룹에 보내는 신호가 없으므로 job 객체를 쓴다. 자식을 이름 없는
/// job 하나에 넣어 두면 그 자식이 띄우는 프로세스도 같은 job에 딸려 들어가고,
/// `TerminateJobObject` 한 번이 그 전부를 끝낸다.
///
/// 정상 경로는 건드리지 않는다. job은 만들어 두기만 하고, 제한 시간을 넘겼을 때만
/// 종료를 보낸다(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`를 걸지 않는 이유다 — 걸면 손잡이가
/// 떨어지는 순간이 곧 종료라, 제때 끝난 자식의 뒷정리까지 이 구조체의 수명에 묶인다).
pub(crate) struct ProcessGroup {
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

// SAFETY: job 핸들은 커널 객체 핸들이라 스레드를 가리지 않는다. 이 구조체는 자기 핸들
// 하나만 소유하고 `Drop`에서 한 번 닫는다.
#[cfg(windows)]
unsafe impl Send for ProcessGroup {}

impl ProcessGroup {
    /// 방금 띄운 자식을 그룹에 묶는다. 묶지 못하면 `None`이고, 그때는 예전처럼 자식
    /// 하나만 끝낸다 — 손자를 놓치는 것이 실행 자체를 거절할 이유는 아니다.
    #[cfg(unix)]
    pub(crate) fn attach(child: &std::process::Child) -> Option<Self> {
        // 유닉스에서는 `Command::process_group(0)`이 spawn 시점에 이미 걸려 있다.
        Some(Self { pid: child.id() })
    }

    #[cfg(windows)]
    pub(crate) fn attach(child: &std::process::Child) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};

        // SAFETY: 이름도 보안 서술자도 없는 job을 하나 만든다. 실패는 널 핸들이다.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return None;
        }
        let handle = child.as_raw_handle().cast();
        // SAFETY: 방금 만든 job과, 아직 기다리지 않아 살아 있는 자식 핸들 하나만 다룬다.
        if unsafe { AssignProcessToJobObject(job, handle) } == 0 {
            // SAFETY: 이 함수가 만든 핸들을 그대로 닫는다.
            unsafe { CloseHandle(job) };
            return None;
        }
        Some(Self { job })
    }

    #[cfg(not(any(unix, windows)))]
    pub(crate) fn attach(_child: &std::process::Child) -> Option<Self> {
        None
    }

    #[cfg(unix)]
    pub(crate) fn kill(&self) {
        kill_process_group(self.pid);
    }

    #[cfg(windows)]
    pub(crate) fn kill(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: 이 구조체가 소유한 job 핸들 하나에만 보낸다. 이미 비어 있어도 성공이다.
        unsafe { TerminateJobObject(self.job, 1) };
    }

    #[cfg(not(any(unix, windows)))]
    pub(crate) fn kill(&self) {}
}

#[cfg(windows)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        // SAFETY: `attach`가 만든 핸들을 한 번만 닫는다.
        unsafe { CloseHandle(self.job) };
    }
}

/// 환경변수를 얹어 실행한다. 계정별 홈으로 공급자 CLI에 묻는 조회가 쓴다 — 계정을 인자로
/// 받는 명령이 없는 공급자에서는 홈을 바꾸는 것이 곧 계정을 고르는 일이다.
pub(crate) fn run_capped_with_env(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
    env: &[(String, String)],
) -> Result<CommandOutcome, CoreError> {
    run_capped_with(
        executable,
        args,
        timeout,
        &CappedOptions {
            env,
            ..CappedOptions::default()
        },
    )
}

/// C9-19. 자식 stdin으로 한 번 써 넣고 닫는 변형. sudo 비밀번호처럼 **명령줄에 실을 수
/// 없는** 입력이 지나는 유일한 통로다 — 인자·환경변수는 같은 호스트의 다른 프로세스가
/// `ps`로 읽을 수 있고 명령 문자열은 승인 카드·영수증·감사 기록에 그대로 남지만, 이
/// 통로의 값은 부모와 자식 사이에서만 오간다.
///
/// `input`이 `None`이면 stdin은 기존대로 닫힌 채(`Stdio::null()`) 돌아간다. 입력을 주는
/// 쪽은 자식이 그것을 읽지 않을 수 있다는 것을 전제해야 한다 — 읽지 않아도 쓰기는
/// 실패하지 않고, 파이프가 먼저 닫히면 `BrokenPipe`가 나지만 그것은 실행 실패가 아니다.
pub(crate) fn run_capped_with_input(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
    input: Option<&str>,
) -> Result<CommandOutcome, CoreError> {
    // `sudo -S`는 개행까지 읽어야 한 줄로 판단하므로 개행을 함께 보낸다.
    let line = input.map(|value| format!("{value}\n"));
    run_capped_with(
        executable,
        args,
        timeout,
        &CappedOptions {
            input: line.as_deref().map(str::as_bytes),
            ..CappedOptions::default()
        },
    )
}

/// 위 셋과 git 실행기가 공유하는 본체. 자식을 띄우고 제한 시간까지 지켜보는 절차는 한 벌만 둔다.
pub(crate) fn run_capped_with(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
    options: &CappedOptions<'_>,
) -> Result<CommandOutcome, CoreError> {
    let mut command = capped_command(executable, args);
    for key in options.env_remove {
        command.env_remove(key);
    }
    for (key, value) in options.env {
        command.env(key, value);
    }
    if let Some(dir) = options.current_dir {
        command.current_dir(dir);
    }
    if options.strip_credential_env {
        crate::credential_profiles::strip_inherited_credential_env(&mut command);
    }
    if options.input.is_some() {
        command.stdin(Stdio::piped());
    }
    #[cfg(unix)]
    if options.own_process_group {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!(
            "{} 실행을 시작하지 못했습니다: {error}",
            executable.to_string_lossy()
        ))
    })?;
    // 출력 파이프를 읽기 **전에** 묶는다. 손자가 먼저 태어나면 그 손자는 job 밖에 남고,
    // 제한 시간에 살아남아 파이프를 쥔 채 `finish`를 막는 바로 그 경우가 된다.
    let group = options
        .own_process_group
        .then(|| ProcessGroup::attach(&child))
        .flatten();
    // 출력 회수를 먼저 띄운 뒤 stdin을 별도 스레드에서 쓴다. 자식이 stdin을 읽기 전에
    // 파이프 한 통 넘게 출력하면(커밋 훅의 lint 출력) 이 스레드가 쓰기에서 막힌 채 제한
    // 시간조차 시작되지 않는다. 쓰기 스레드는 다 쓰면 곧바로 닫고, 자식이 죽으면 파이프가
    // 끊겨 스스로 끝난다.
    let output_readers = CappedOutputReaders::spawn(child.stdout.take(), child.stderr.take());
    let stdin_writer = options.input.map(|input| {
        let payload = input.to_vec();
        let stdin = child.stdin.take();
        thread::spawn(move || {
            if let Some(mut stdin) = stdin {
                use std::io::Write;
                let _ = stdin.write_all(&payload);
                let _ = stdin.flush();
            }
        })
    });

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break Some(status),
            None => {
                if started.elapsed() >= timeout {
                    // 그룹을 먼저 끝낸다. 자식만 먼저 죽이면 손자가 파이프를 쥔 채 남고
                    // 아래 `finish`가 EOF를 기다리며 막힌다.
                    if let Some(group) = group.as_ref() {
                        group.kill();
                    }
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    };
    let (stdout, stderr) = output_readers.finish();
    // 자식이 끝났으니 파이프는 닫혔고, 쓰기 스레드는 다 썼거나 끊겨 곧 돌아온다.
    if let Some(writer) = stdin_writer {
        let _ = writer.join();
    }
    Ok(CommandOutcome {
        success: status.map(|status| status.success()).unwrap_or(false),
        timed_out,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Claude Code 2.1.233 `--help`의 실제 형식(commander, 줄바꿈 래핑).
    const CLAUDE_HELP: &str = r#"Usage: claude [options] [command] [prompt]

Options:
  --add-dir <directories...>            Additional directories to allow tool
                                        access to
  --dangerously-skip-permissions        Bypass all permission checks.
  --fallback-model <model>              Enable automatic fallback to specified
                                        model(s) when the default model is
                                        overloaded or not available. (only works
                                        with --print)
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  -v, --version                         Output the version number
"#;

    /// Codex 0.146.0 `--help`의 실제 형식(clap, 축약형과 상세형이 함께 나온다).
    const CODEX_HELP: &str = r#"Codex CLI

Options:
  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands

          [possible values: read-only, workspace-write, danger-full-access]

      --dangerously-bypass-approvals-and-sandbox
          Skip all confirmation prompts and execute commands without sandboxing

  -a, --ask-for-approval <APPROVAL_POLICY>
          Configure when the model requires human approval before executing a command

          Possible values:
          - untrusted:  Only run "trusted" commands without asking for user approval
          - on-request: The model decides when to ask the user for approval
          - never:      Never ask for user approval

  -h, --help
          Print help
"#;

    /// Antigravity CLI 1.1.15 `--help`의 실제 형식(Go flag, stderr 출력).
    const ANTIGRAVITY_HELP: &str = r#"Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --dangerously-skip-permissions  Auto-approve all tool permission requests without prompting
  --effort                        Reasoning effort for the current CLI session (low|medium|high)
  --mode                          Set the agent execution mode for this session (accept-edits, plan)
  --output-format                 Output format for print mode (text, json, stream-json) (default text)
"#;

    #[test]
    fn commander_help_yields_permission_mode_choices() {
        let interface = CliInterface::parse(CLAUDE_HELP);
        assert!(interface.is_reliable());
        assert!(interface.has_flag("--permission-mode"));
        assert!(interface.has_flag("--fallback-model"));
        for value in ["plan", "acceptEdits", "bypassPermissions"] {
            assert!(interface.accepts_value("--permission-mode", value));
        }
        assert!(!interface.accepts_value("--permission-mode", "workspaceWrite"));
        // 값 목록이 없는 플래그는 판단을 보류한다.
        assert!(interface.accepts_value("--fallback-model", "sonnet"));
    }

    #[test]
    fn clap_help_yields_sandbox_and_approval_values() {
        let interface = CliInterface::parse(CODEX_HELP);
        assert!(interface.is_reliable());
        for value in ["read-only", "workspace-write", "danger-full-access"] {
            assert!(interface.accepts_value("--sandbox", value));
        }
        assert!(!interface.accepts_value("--sandbox", "full-access"));
        for value in ["untrusted", "on-request", "never"] {
            assert!(interface.accepts_value("--ask-for-approval", value));
        }
        assert!(!interface.accepts_value("--ask-for-approval", "on-failure"));
    }

    #[test]
    fn go_flag_help_yields_mode_values() {
        let interface = CliInterface::parse(ANTIGRAVITY_HELP);
        assert!(interface.is_reliable());
        assert!(interface.has_flag("--dangerously-skip-permissions"));
        assert!(interface.accepts_value("--mode", "plan"));
        assert!(interface.accepts_value("--mode", "accept-edits"));
        assert!(!interface.accepts_value("--mode", "full-access"));
        // `(repeatable) (default [])`처럼 값 목록이 아닌 괄호는 열거형으로 읽지 않는다.
        assert!(interface.accepts_value("--add-dir", "/tmp"));
    }

    #[test]
    fn unparsable_help_is_reported_as_unreliable() {
        assert!(!CliInterface::parse("").is_reliable());
        assert!(!CliInterface::parse("완전히 다른 형식의 출력입니다").is_reliable());
    }

    // -----------------------------------------------------------------------
    // C16-3 / C7-5 — 제한 시간은 자식 **하나가 아니라 그 자손까지** 끝낸다
    // -----------------------------------------------------------------------

    /// 아래 두 보조 시험을 깨우는 환경변수. 값은 표식과 심박을 적을 폴더다.
    const SPAWNER_ENV: &str = "AGENT_MANAGER_PG_TEST_SPAWNER_DIR";
    const BEAT_ENV: &str = "AGENT_MANAGER_PG_TEST_BEAT_DIR";

    /// 자식이 끝까지 가서 손자를 띄웠다는 표식. `--exact`가 아무 시험도 고르지 못하면
    /// 시험 바이너리는 "0 passed"로 **성공 종료**하므로, 종료 코드만 보는 부모는 아무것도
    /// 돌지 않은 것을 통과로 읽는다. 그 구멍을 이 표식이 막는다.
    const SPAWNED_MARK: &str = "spawned";
    /// 손자가 살아 있는 동안 계속 길어지는 파일. 이 길이가 **더 자라지 않는 것**이
    /// "손자가 죽었다"의 증거다.
    const HEARTBEAT: &str = "heartbeat";

    /// 가운데 자식 노릇. `run_capped_with`가 띄우는 쪽이고, 손자를 하나 띄운 뒤 스스로는
    /// 제한 시간을 넘기도록 그냥 잔다. 환경변수가 없으면 평소 시험 실행에서는 아무 일도
    /// 하지 않고 지나간다.
    #[test]
    fn process_group_spawner_helper() {
        let Ok(dir) = std::env::var(SPAWNER_ENV) else {
            return;
        };
        let dir = PathBuf::from(dir);
        let exe = std::env::current_exe().expect("시험 바이너리 경로");
        let mut grandchild = Command::new(exe);
        grandchild
            .args(["--exact", "cli_interface::tests::process_group_beat_helper"])
            .env(BEAT_ENV, &dir)
            .env_remove(SPAWNER_ENV)
            // 손자의 출력은 버린다. 물려받게 두면 손자가 살아남았을 때 파이프에 EOF가
            // 오지 않아 `finish`가 막히고, 이 시험은 **실패가 아니라 멈춤**이 된다.
            // 멈추는 시험은 무인 실행에서 아무것도 알려 주지 않으므로 그 길을 닫는다.
            // 파이프가 막히는 것 자체는 `ProcessGroup` 문서주석에 결과로 적어 두었다.
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // 기다리지 않는 것이 이 시험의 전제다 — 손자는 부모보다 오래 살아남아야 하고,
        // 부모가 `wait()`로 막히면 그룹 종료를 재는 자리 자체가 사라진다. 좀비는 이
        // 보조 프로세스가 곧 끝나면서 init이 거둔다.
        #[allow(
            clippy::zombie_processes,
            reason = "손자는 부모보다 오래 살아남아야 한다"
        )]
        let _grandchild = grandchild.spawn().expect("손자를 띄우지 못했습니다");
        std::fs::write(dir.join(SPAWNED_MARK), b"1").expect("표식을 쓰지 못했습니다");
        // 부모의 제한 시간보다 한참 길게 잔다. 스스로 끝나면 이 시험은 "제한 시간이
        // 걸렸다"가 아니라 "자식이 알아서 끝났다"를 재게 된다.
        thread::sleep(Duration::from_secs(120));
    }

    /// 손자 노릇. 부모가 사라져도 계속 심박을 적는다 — 윈도우에서 `TerminateProcess`는
    /// 그 프로세스 하나만 끝내므로, 그룹 종료가 없으면 이 반복은 멈추지 않는다.
    #[test]
    fn process_group_beat_helper() {
        let Ok(dir) = std::env::var(BEAT_ENV) else {
            return;
        };
        let path = PathBuf::from(dir).join(HEARTBEAT);
        for _ in 0..1_200 {
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
            {
                let _ = file.write_all(b".");
                let _ = file.flush();
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn heartbeat_len(dir: &Path) -> u64 {
        std::fs::metadata(dir.join(HEARTBEAT))
            .map(|meta| meta.len())
            .unwrap_or(0)
    }

    /// C16-3은 "제한 시간은 프로세스 그룹을 죽여 `ssh`와 자격증명 도우미가 함께 죽게
    /// 한다"고 적어 두었고, C7-5도 같은 말을 Cypress 런너에 적어 두었다.
    ///
    /// **2026-10-05까지 그 약속은 유닉스에서만 지켜졌다.** `own_process_group`가 거는
    /// 장치 둘이 모두 `#[cfg(unix)]`였다 — spawn 시점의 `Command::process_group(0)`과
    /// 제한 시간의 `kill_process_group`(윈도우 본문은 빈 함수였다). 어떤 시험도
    /// "손자가 죽었는가"를 묻지 않았으므로 그 빈 함수는 조용히 통과했다. 이 회차가
    /// 그 본문을 job 객체로 채우고, 이 시험이 그것을 지킨다.
    ///
    /// **판정은 영수증이 아니라 디스크다.** 손자는 50ms마다 파일 하나를 길게 만들고,
    /// 시험은 제한 시간 뒤에 그 길이가 **더 자라지 않는지**를 본다. `timed_out`만 보면
    /// 손자가 멀쩡히 돌고 있어도 통과한다.
    ///
    /// 짝으로 세 가지를 더 본다. (1) 자식이 끝까지 가서 손자를 실제로 띄웠다는 표식 —
    /// 없으면 아무것도 재지 않은 것이다. (2) 심박이 한 번이라도 찍혔다 — 손자가 애초에
    /// 돌지 않았으면 "멈췄다"는 저절로 참이다. (3) `timed_out`이 참이고 실행이 제한
    /// 시간 근처에서 돌아왔다 — 막히지 않았다는 뜻이다.
    ///
    /// **검출력(2026-10-05, 윈도우 11).** `ProcessGroup::attach`가 `None`을 돌려주게
    /// 되돌리면(= 고치기 전 상태) 이 시험이 FAILED 한다. 그 상태의 제품은 `git fetch`가
    /// 120초 제한에 걸렸을 때 `ssh.exe`를 호스트에 남기고, 그 `ssh.exe`가 물려받은
    /// 출력 파이프를 쥐고 있으면 `CappedOutputReaders::finish`에 EOF가 오지 않아
    /// `run_capped_with`가 **돌아오지 않는다** — 제한 시간이 있는데도 프로젝트 git
    /// 화면이 멈춘다.
    #[test]
    fn c16_3_a_timeout_kills_the_child_and_its_grandchild() {
        let dir = tempfile::tempdir().expect("임시 폴더");
        let exe = std::env::current_exe().expect("시험 바이너리 경로");
        let path = dir.path().to_path_buf();
        let env = [(SPAWNER_ENV.to_owned(), path.display().to_string())];
        let timeout = Duration::from_secs(3);

        let started = Instant::now();
        let outcome = run_capped_with(
            &exe,
            &[
                "--exact",
                "cli_interface::tests::process_group_spawner_helper",
            ],
            timeout,
            &CappedOptions {
                env: &env,
                own_process_group: true,
                ..CappedOptions::default()
            },
        )
        .expect("자식을 띄우지 못했습니다");
        let elapsed = started.elapsed();

        assert!(
            outcome.timed_out,
            "제한 시간이 걸리지 않았습니다: {outcome:?}"
        );
        assert!(
            elapsed < timeout + Duration::from_secs(20),
            "제한 시간 뒤에도 돌아오지 못했습니다({elapsed:?}) — 손자가 출력 파이프를 쥐고 있습니다"
        );
        assert!(
            path.join(SPAWNED_MARK).exists(),
            "자식이 손자를 띄운 표식이 없습니다 — 이 시험은 아무것도 재지 않았습니다"
        );
        let at_kill = heartbeat_len(&path);
        assert!(at_kill > 0, "손자가 한 번도 심박을 찍지 않았습니다");

        // 손자가 살아 있다면 이 사이에 수십 번 더 찍는다(50ms 주기).
        thread::sleep(Duration::from_secs(2));
        let later = heartbeat_len(&path);
        assert_eq!(
            later, at_kill,
            "제한 시간 뒤에도 손자가 살아 있습니다 — 그룹 종료가 듣지 않았습니다"
        );
    }
}
