//! 외부에서 독립 실행된 공급자 CLI 프로세스 탐지·종료.
//!
//! 계정 전환 시 공급자 세션을 완전히 정리하기 위해 Agent Manager가 직접
//! 관리하지 않는 공급자 CLI 프로세스(터미널·IDE 확장 등)도 종료 대상에
//! 포함한다. 현재 사용자 소유 프로세스만 대상으로 하며, Agent Manager
//! 자신과 그 자손(관리 런타임·로그인 세션 포함)·조상(앱을 실행한 셸 체인)은
//! 제외한다. 매칭된 프로세스의 자손(MCP 서버 등 세션이 띄운 보조 프로세스)은
//! 같은 세션 트리로 보고 함께 종료한다.
//!
//! 플랫폼마다 프로세스 표를 얻는 길이 다르다. 유닉스는 `ps`, 윈도우는 WMI
//! (`Win32_Process`)를 읽고, 그 뒤의 선별·종료 판단은 두 플랫폼이 같은 코드를 쓴다.
//! 윈도우에는 SIGTERM에 해당하는 것이 없어 종료 사다리가 한 단계뿐이다.

use std::collections::{HashMap, HashSet};
use std::path::Path;
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
use std::thread;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::domain::ProviderId;
#[cfg(unix)]
use crate::process_signal;
use crate::CoreError;

#[cfg(unix)]
const SIGTERM_GRACE: Duration = Duration::from_secs(3);
const SIGKILL_GRACE: Duration = Duration::from_secs(2);
/// 부모를 따라 올라가는 걸음 수 상한. 프로세스 표가 순환하거나 망가져도 멈추게 한다.
const MAX_ANCESTRY_DEPTH: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProviderProcess {
    pub pid: u32,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalProcessFailure {
    pub pid: u32,
    pub command: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminateExternalProcessesReport {
    pub provider: ProviderId,
    pub requested_count: usize,
    pub terminated_count: usize,
    /// SIGTERM 정상 종료가 실패해 SIGKILL 강제 종료로 승격된 프로세스 수.
    /// `terminated_count`에 포함된다.
    pub forced_count: usize,
    pub failed: Vec<ExternalProcessFailure>,
}

impl TerminateExternalProcessesReport {
    pub fn empty(provider: ProviderId) -> Self {
        Self {
            provider,
            requested_count: 0,
            terminated_count: 0,
            forced_count: 0,
            failed: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PsEntry {
    pid: u32,
    ppid: u32,
    /// 프로세스를 누가 돌리는지 가리는 값. 유닉스에서는 uid, 윈도우에서는 터미널 서비스
    /// 세션 id다. 두 플랫폼 모두 "현재 사용자와 같은 값인가"만 묻고 값 자체는 해석하지
    /// 않는다.
    owner: u32,
    /// 프로세스가 생긴 시각. 크기만 비교하는 불투명한 정수이고, 플랫폼이 주지 않으면
    /// `None`이다. 부모-자식 관계가 PID 재사용으로 뒤집히지 않았는지 보는 데만 쓴다.
    started: Option<u64>,
    command: String,
}

/// 현재 사용자 소유의 외부 공급자 CLI 프로세스를 나열한다.
pub fn list_external_provider_processes(
    provider: ProviderId,
) -> Result<Vec<ExternalProviderProcess>, CoreError> {
    let entries = snapshot_process_table()?;
    Ok(select_external_processes(
        provider,
        &entries,
        std::process::id(),
        current_owner(),
    ))
}

/// 외부 공급자 CLI 프로세스를 SIGTERM으로 정상 종료 요청하고, 유예 시간 안에
/// 끝나지 않으면 SIGKILL 강제 종료로 승격한다. 강제 종료까지 실패한
/// 프로세스만 `failed`로 보고한다.
pub fn terminate_external_provider_processes(
    provider: ProviderId,
) -> Result<TerminateExternalProcessesReport, CoreError> {
    let targets = list_external_provider_processes(provider)?;
    Ok(terminate_processes(provider, targets))
}

#[cfg(unix)]
fn snapshot_process_table() -> Result<Vec<PsEntry>, CoreError> {
    let ps = crate::process_signal::ps_executable().map_err(|error| {
        CoreError::Runtime(format!("프로세스 목록을 조회하지 못했습니다: {error}"))
    })?;
    let output = Command::new(ps)
        .args(["-axo", "pid=,ppid=,uid=,args="])
        .output()
        .map_err(|error| {
            CoreError::Runtime(format!("프로세스 목록을 조회하지 못했습니다: {error}"))
        })?;
    if !output.status.success() {
        return Err(CoreError::Runtime(format!(
            "프로세스 목록 조회가 실패했습니다: {}",
            output.status
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_ps_line)
        .collect())
}

#[cfg(not(any(unix, windows)))]
fn snapshot_process_table() -> Result<Vec<PsEntry>, CoreError> {
    Err(CoreError::Runtime(
        "이 플랫폼에서는 외부 프로세스 조회를 지원하지 않습니다".to_owned(),
    ))
}

#[cfg(unix)]
fn parse_ps_line(line: &str) -> Option<PsEntry> {
    let mut tokens = line.split_whitespace();
    let pid = tokens.next()?.parse().ok()?;
    let ppid = tokens.next()?.parse().ok()?;
    let owner = tokens.next()?.parse().ok()?;
    // 연속 공백은 하나로 접힌다. 매칭·표시 용도로는 충분하다.
    let command = tokens.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        return None;
    }
    Some(PsEntry {
        pid,
        ppid,
        owner,
        // `ps -axo`에는 정렬 가능한 생성 시각 열을 함께 요구하지 않는다. 유닉스에서
        // 부모-자식 관계는 예전부터 이 값 없이 판정해 왔다.
        started: None,
        command,
    })
}

#[cfg(unix)]
fn current_owner() -> u32 {
    unsafe { libc::getuid() }
}

#[cfg(not(any(unix, windows)))]
fn current_owner() -> u32 {
    0
}

// ---------------------------------------------------------------------------
// 윈도우: WMI로 프로세스 표를 읽고 TerminateProcess로 종료한다
// ---------------------------------------------------------------------------

/// 프로세스 표 조회 제한 시간. WMI는 첫 조회에서 서비스가 깨어나느라 몇 초가 걸린다.
#[cfg(windows)]
const WINDOWS_PROCESS_QUERY_TIMEOUT: Duration = Duration::from_secs(30);

/// 한 프로세스에서 보관할 명령줄 최대 글자 수. 매칭은 앞쪽 토큰만 보고 표시에도 이
/// 정도면 족한데, 브라우저처럼 수 KB짜리 명령줄을 가진 프로세스가 수백 개 있는 기기에서
/// 자르지 않으면 조회 출력이 캡처 상한에 걸려 표 전체를 잃는다.
#[cfg(windows)]
const WINDOWS_MAX_COMMAND_CHARS: usize = 1024;

/// 공급자 CLI 스크립트를 대신 실행하는 런타임의 실행 파일 이름.
/// [`RuntimeWrapper::from_executable`]이 인식하는 이름과 같아야 한다(아래 테스트가 본다).
#[cfg(any(windows, test))]
const RUNTIME_EXECUTABLE_NAMES: &[&str] = &["node", "bun", "deno"];

/// `Win32_Process`를 한 줄씩 `pid ppid session created command` 형식으로 뱉는 스크립트.
///
/// 조회에 셸을 쓰는 것은 유닉스에서 `ps`를 쓰는 것과 같은 성격이고, 문자열은 이 상수와
/// 닫힌 열거형에서만 만들어진다. 사용자 입력은 한 글자도 들어오지 않으며, 끼워 넣는
/// 이름조차 ASCII 소문자로 한 번 더 거른다(G9).
#[cfg(windows)]
const WINDOWS_PROCESS_QUERY_TEMPLATE: &str = concat!(
    "$ErrorActionPreference='Stop';",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
    "$wanted=@(__NAMES__);",
    "Get-CimInstance -ClassName Win32_Process",
    " -Property ProcessId,ParentProcessId,SessionId,CreationDate,Name,CommandLine",
    " | ForEach-Object {",
    "$text=[string]$_.Name;",
    "if (($wanted -contains [IO.Path]::GetFileNameWithoutExtension($text).ToLowerInvariant())",
    " -and $_.CommandLine) { $text=[string]$_.CommandLine };",
    "$text=($text -replace '\\s+',' ').Trim();",
    "if ($text.Length -gt __MAX__) { $text=$text.Substring(0,__MAX__) };",
    "$created=0; if ($_.CreationDate) { $created=$_.CreationDate.ToFileTimeUtc() };",
    "'{0} {1} {2} {3} {4}' -f $_.ProcessId,$_.ParentProcessId,$_.SessionId,$created,$text",
    "}",
);

/// 명령줄까지 읽을 실행 파일 이름 목록. 공급자 CLI 이름과 그것을 실행하는 런타임
/// 래퍼뿐이다 — 나머지 프로세스는 이름만 담는다. 계층 판정에는 PID와 부모 PID면 되고
/// 매칭은 이 이름들에서만 일어나므로, 명령줄을 더 읽어 봐야 출력만 커진다.
#[cfg(any(windows, test))]
fn command_line_executable_names() -> Vec<String> {
    ProviderId::ALL
        .iter()
        .map(|provider| provider.as_str().to_owned())
        .chain(
            RUNTIME_EXECUTABLE_NAMES
                .iter()
                .map(|name| (*name).to_owned()),
        )
        .filter(|name| !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_lowercase()))
        .collect()
}

#[cfg(windows)]
fn windows_process_query_script() -> String {
    let names = command_line_executable_names()
        .iter()
        .map(|name| format!("'{name}'"))
        .collect::<Vec<_>>()
        .join(",");
    WINDOWS_PROCESS_QUERY_TEMPLATE
        .replace("__NAMES__", &names)
        .replace("__MAX__", &WINDOWS_MAX_COMMAND_CHARS.to_string())
}

/// `powershell.exe`는 `%SystemRoot%` 아래 고정 위치에서만 찾는다. PATH에서 찾은 것을
/// 믿으면 "이 프로세스가 누구인지" 확인하는 조회 자체가 의미를 잃는다 —
/// [`crate::process_signal::ps_executable`]이 유닉스에서 같은 이유로 PATH를 보지 않는다.
#[cfg(windows)]
fn windows_powershell_executable() -> Result<std::path::PathBuf, CoreError> {
    let root = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .filter(|root| root.is_absolute())
        .ok_or_else(|| {
            CoreError::Runtime(
                "프로세스 목록을 조회하지 못했습니다: SystemRoot를 읽지 못했습니다".to_owned(),
            )
        })?;
    let executable = root
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !executable.is_file() {
        return Err(CoreError::Runtime(format!(
            "프로세스 목록을 조회하지 못했습니다: {}를 찾지 못했습니다",
            executable.display()
        )));
    }
    Ok(executable)
}

/// 스크립트를 `-EncodedCommand`(UTF-16LE + base64)로 넘긴다. 따옴표·공백·비ASCII가
/// 명령줄 파서를 거치지 않으므로, 인용 규칙이 계층마다 달라 생기는 해석 차이가 없다.
#[cfg(windows)]
fn windows_encoded_command(script: &str) -> String {
    use base64::Engine;

    let utf16: Vec<u8> = script
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

#[cfg(windows)]
fn snapshot_process_table() -> Result<Vec<PsEntry>, CoreError> {
    let powershell = windows_powershell_executable()?;
    let encoded = windows_encoded_command(&windows_process_query_script());
    let outcome = crate::cli_interface::run_capped(
        &powershell,
        &["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded],
        WINDOWS_PROCESS_QUERY_TIMEOUT,
    )?;
    if !outcome.success {
        let reason = if outcome.timed_out {
            "제한 시간을 넘겼습니다"
        } else {
            outcome.stderr.trim()
        };
        return Err(CoreError::Runtime(format!(
            "프로세스 목록 조회가 실패했습니다: {}",
            crate::text_limit::truncate_chars(reason, 300)
        )));
    }
    let entries: Vec<PsEntry> = outcome
        .stdout
        .lines()
        .filter_map(parse_windows_process_line)
        .collect();
    if entries.is_empty() {
        return Err(CoreError::Runtime(
            "프로세스 목록 조회가 빈 결과를 돌려주었습니다".to_owned(),
        ));
    }
    Ok(entries)
}

/// `pid ppid session created command` 한 줄을 읽는다. 앞의 네 칸은 모두 정수이고
/// 나머지 전부가 명령이다.
#[cfg(windows)]
fn parse_windows_process_line(line: &str) -> Option<PsEntry> {
    let mut tokens = line.split_whitespace();
    let pid = tokens.next()?.parse().ok()?;
    let ppid = tokens.next()?.parse().ok()?;
    let owner = tokens.next()?.parse().ok()?;
    let started: u64 = tokens.next()?.parse().ok()?;
    let command = tokens.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        return None;
    }
    Some(PsEntry {
        pid,
        ppid,
        owner,
        // 0은 WMI가 생성 시각을 주지 않았다는 뜻이다. 그때는 순서를 따지지 않는다.
        started: (started > 0).then_some(started),
        command,
    })
}

/// 현재 프로세스의 터미널 서비스 세션 id. 같은 세션의 프로세스만 대상으로 삼는다.
///
/// 다른 사용자의 로그온은 다른 세션을, 서비스는 세션 0을 쓰므로 유닉스의 uid 비교와
/// 같은 자리를 맡는다. 프로세스마다 소유자 SID를 읽는 편이 더 정확하지만 그러려면
/// 프로세스를 하나씩 열어야 하고, 열지 못하는 프로세스는 어차피 종료도 하지 못한다.
#[cfg(windows)]
fn current_owner() -> u32 {
    use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;

    let mut session = 0u32;
    // SAFETY: 자기 자신의 PID로 부르고, 출력은 지역 변수 하나다.
    if unsafe { ProcessIdToSessionId(std::process::id(), &mut session) } == 0 {
        // 세션을 모르면 어떤 프로세스와도 맞지 않는 값을 돌려준다. 확신 없는 상태에서
        // 남의 프로세스를 대상으로 삼느니 하나도 고르지 않는 편이 낫다.
        return u32::MAX;
    }
    session
}

/// 윈도우에는 SIGTERM에 해당하는 것이 없다. 콘솔 제어 이벤트는 대상 콘솔에 붙어야
/// 보낼 수 있고 그러면 앱 자신의 콘솔까지 끊기므로, 여기서는 `TerminateProcess` 한
/// 단계만 쓴다. 그래서 실제로 종료시킨 프로세스는 모두 `forced_count`로 보고한다.
#[cfg(windows)]
fn terminate_processes(
    provider: ProviderId,
    targets: Vec<ExternalProviderProcess>,
) -> TerminateExternalProcessesReport {
    let requested_count = targets.len();
    if requested_count == 0 {
        return TerminateExternalProcessesReport::empty(provider);
    }
    let mut forced_count = 0usize;
    let mut failed = Vec::new();
    for process in targets {
        match terminate_windows_process(process.pid) {
            Ok(true) => forced_count += 1,
            Ok(false) => {}
            Err(reason) => failed.push(termination_failure(process, &reason)),
        }
    }
    TerminateExternalProcessesReport {
        provider,
        requested_count,
        terminated_count: requested_count - failed.len(),
        forced_count,
        failed,
    }
}

/// 한 프로세스를 강제 종료한다. 이미 사라져 있었으면 `Ok(false)`, 이번에 종료시켰으면
/// `Ok(true)`다.
#[cfg(windows)]
fn terminate_windows_process(pid: u32) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0};
    // windows-sys는 모든 커널 객체가 공유하는 SYNCHRONIZE를 파일 모듈에 두었다. 값은
    // 같은 u32라 프로세스 핸들에도 그대로 쓴다.
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_TERMINATE,
    };

    // SAFETY: 아래 호출은 이 함수가 연 핸들 하나만 다루고, 어느 갈래로 나가든 닫는다.
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        let error = std::io::Error::last_os_error();
        // 없는 PID는 ERROR_INVALID_PARAMETER로 돌아온다. 이미 끝난 프로세스는 성공 경로다.
        if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            return Ok(false);
        }
        return Err(format!("프로세스를 열지 못했습니다: {error}"));
    }
    let sent = unsafe { TerminateProcess(handle, 1) };
    let send_error = std::io::Error::last_os_error();
    let wait = unsafe { WaitForSingleObject(handle, SIGKILL_GRACE.as_millis() as u32) };
    unsafe { CloseHandle(handle) };
    if wait == WAIT_OBJECT_0 {
        return Ok(true);
    }
    if sent == 0 {
        return Err(format!("종료 신호를 보내지 못했습니다: {send_error}"));
    }
    Err("강제 종료 뒤에도 종료되지 않았습니다".to_owned())
}

/// 프로세스 표의 한 칸. 부모와 생성 시각만 있으면 계층 판정에 충분하다.
#[derive(Debug, Clone, Copy)]
struct ProcessLink {
    ppid: u32,
    started: Option<u64>,
}

/// 프로세스 계층 구조를 보관하고 조상·자손 관계를 판정한다.
struct ProcessTree {
    links: HashMap<u32, ProcessLink>,
}

impl ProcessTree {
    fn from_entries(entries: &[PsEntry]) -> Self {
        let links = entries
            .iter()
            .map(|entry| {
                (
                    entry.pid,
                    ProcessLink {
                        ppid: entry.ppid,
                        started: entry.started,
                    },
                )
            })
            .collect();
        Self { links }
    }

    /// pid에서 위로 올라가며 조상 pid를 하나씩 내놓는다. 표가 끊기거나 자기 자신·0을
    /// 부모로 가리키면 거기서 멈추고, 순환·비정상 표에 대비해 깊이도 제한한다.
    /// 아래 세 판정이 이 걸음을 각자 베껴 적고 있었다.
    ///
    /// 부모가 자식보다 **나중에** 생겼으면 거기서도 멈춘다. 그 부모 PID는 진짜 부모가
    /// 죽은 뒤 재사용된 번호다. 윈도우는 PID를 빠르게 돌려 쓰고 부모가 사라져도
    /// `ParentProcessId`를 지우지 않으므로, 이 확인이 없으면 남의 프로세스가 매칭된
    /// 공급자 프로세스의 "자손"으로 끌려 들어와 함께 종료된다.
    fn ancestry(&self, pid: u32) -> impl Iterator<Item = u32> + '_ {
        let mut current = pid;
        std::iter::from_fn(move || {
            let &ProcessLink { ppid, started } = self.links.get(&current)?;
            if ppid == 0 || ppid == current {
                return None;
            }
            // 표에 부모가 없으면(이미 끝난 프로세스) 예전처럼 그 PID까지는 조상으로 본다.
            // 시각을 둘 다 아는 경우에만 순서를 따진다.
            let parent_started = self.links.get(&ppid).and_then(|link| link.started);
            if let (Some(child_started), Some(parent_started)) = (started, parent_started) {
                if parent_started > child_started {
                    return None;
                }
            }
            current = ppid;
            Some(ppid)
        })
        .take(MAX_ANCESTRY_DEPTH)
    }

    /// pid의 조상 pid 목록. 가까운 조상부터 순서대로 담긴다.
    fn ancestors_of(&self, pid: u32) -> Vec<u32> {
        self.ancestry(pid).collect()
    }

    /// target_pid가 pid의 조상인지(즉 pid가 target_pid의 자손인지) 여부.
    fn has_ancestor(&self, pid: u32, target_pid: u32) -> bool {
        self.ancestry(pid).any(|parent| parent == target_pid)
    }

    /// pid가 주어진 조상 집합 중 하나를 조상으로 갖는지 여부.
    fn has_any_ancestor_in(&self, pid: u32, targets: &HashSet<u32>) -> bool {
        self.ancestry(pid).any(|parent| targets.contains(&parent))
    }
}

/// 프로세스 표에서 종료 대상 외부 공급자 프로세스를 고른다.
///
/// - 현재 사용자 소유가 아니면 제외
/// - 자기 자신과 그 자손(관리 런타임·로그인 세션), 조상(앱을 실행한 셸)은 제외
/// - 공급자 CLI 명령으로 매칭된 프로세스와 그 자손을 포함
fn select_external_processes(
    provider: ProviderId,
    entries: &[PsEntry],
    self_pid: u32,
    owner: u32,
) -> Vec<ExternalProviderProcess> {
    let tree = ProcessTree::from_entries(entries);
    // 조상은 해당 pid 자체만 제외한다. 조상의 자손까지 제외하면 launchd 같은
    // 공통 조상 때문에 시스템 전체가 제외되어 버린다. 자기 자신은 자손까지
    // 통째로 제외해 관리 런타임·로그인 세션을 보호한다.
    let self_ancestors: HashSet<u32> = tree.ancestors_of(self_pid).into_iter().collect();
    let is_excluded = |pid: u32| -> bool {
        pid == self_pid || self_ancestors.contains(&pid) || tree.has_ancestor(pid, self_pid)
    };

    // 현재 사용자 소유이고 제외 대상(자신, 자신의 조상·자손)이 아닌 1차 후보군을 모은다.
    let candidates: Vec<&PsEntry> = entries
        .iter()
        .filter(|entry| entry.owner == owner && !is_excluded(entry.pid))
        .collect();

    let matched: HashSet<u32> = candidates
        .iter()
        .filter(|entry| matches_provider_command(provider, &entry.command))
        .map(|entry| entry.pid)
        .collect();

    candidates
        .into_iter()
        .filter(|entry| {
            matched.contains(&entry.pid) || tree.has_any_ancestor_in(entry.pid, &matched)
        })
        .map(|entry| ExternalProviderProcess {
            pid: entry.pid,
            command: entry.command.clone(),
        })
        .collect()
}

/// 명령줄이 공급자 CLI 실행으로 보이는지 판정한다. 실행 파일 이름이 공급자
/// CLI 이름과 정확히 일치하거나(claude.exe·codex.js처럼 확장자만 붙은 경우
/// 포함), node·bun 래퍼가 그런 스크립트를 실행하는 경우만 매칭한다.
/// `Claude.app` 같은 데스크톱 앱(대문자)이나 `codex-code-mode-host` 같은
/// 파생 이름은 매칭하지 않는다. ChatGPT.app 내장 `codex`처럼 이름이 CLI와
/// 같아도 데스크톱 앱 번들 안의 실행 파일은 앱 자체 세션으로 인증하므로
/// 제외한다.
fn matches_provider_command(provider: ProviderId, command: &str) -> bool {
    let target = provider.as_str();
    let mut tokens = command_tokens(command).into_iter();
    let Some(first) = tokens.next() else {
        return false;
    };
    if token_matches(&first, target) {
        return true;
    }
    if let Some(runtime) = RuntimeWrapper::from_executable(&first) {
        while let Some(token) = tokens.next() {
            if runtime.consumes_next_argument(&token) {
                let _ = tokens.next();
                continue;
            }
            if token.starts_with('-') {
                continue;
            }
            return token_matches(&token, target);
        }
    }
    false
}

/// 명령줄을 토큰으로 나눈다. 큰따옴표로 묶인 구간은 공백이 있어도 한 토큰이고, 따옴표
/// 자체는 토큰에 남지 않는다.
///
/// 공백으로만 자르면 윈도우에서 실행 파일을 놓친다. 그쪽 명령줄은 공백이 든 경로를
/// `"C:\Program Files\nodejs\node.exe"`처럼 싣기 때문에, 따옴표를 모르면 첫 토큰이
/// `"C:\Program`이 되어 어떤 이름과도 맞지 않는다. 따옴표가 없는 `ps` 출력에서는 공백
/// 분할과 결과가 같다.
fn command_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for character in command.chars() {
        match character {
            '"' => quoted = !quoted,
            _ if character.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[derive(Clone, Copy)]
enum RuntimeWrapper {
    Node,
    Bun,
    Deno,
}

impl RuntimeWrapper {
    fn from_executable(executable: &str) -> Option<Self> {
        if executable_name_is(executable, "node") {
            Some(Self::Node)
        } else if executable_name_is(executable, "bun") {
            Some(Self::Bun)
        } else if executable_name_is(executable, "deno") {
            Some(Self::Deno)
        } else {
            None
        }
    }

    /// 런타임 옵션 중 다음 토큰을 값으로 소비하는, 명시적으로 알고 있는 옵션만
    /// 건너뛴다. 알 수 없는 옵션은 소비하지 않아 실제 스크립트를 놓치지 않는다.
    fn consumes_next_argument(self, option: &str) -> bool {
        match self {
            Self::Node => matches!(
                option,
                "-e" | "--eval"
                    | "-p"
                    | "--print"
                    | "-r"
                    | "--require"
                    | "--import"
                    | "--loader"
                    | "--experimental-loader"
                    | "--conditions"
            ),
            Self::Bun => matches!(
                option,
                "-r" | "--require" | "--import" | "--preload" | "--conditions"
            ),
            Self::Deno => matches!(
                option,
                "--import-map"
                    | "--config"
                    | "--lock"
                    | "--cert"
                    | "--location"
                    | "--seed"
                    | "--v8-flags"
                    | "--inspect"
                    | "--inspect-brk"
                    | "--inspect-wait"
            ),
        }
    }
}

/// 데스크톱 앱이 제 안에 품고 있는 실행 파일을 가려내는 경로 표식(소문자, `/` 기준).
///
/// 이름이 CLI와 같아도 데스크톱 앱은 자기 세션으로 인증하므로 공유 자격증명의 소비자가
/// 아니다. macOS는 앱 번들 구조 자체가 표식이지만 윈도우에는 그런 구조가 없어, 앱이
/// 자기 실행 파일을 두는 폴더를 그대로 적는다. 가려내지 않으면 CLI를 업데이트할 때
/// 사용자가 보고 있던 데스크톱 앱이 함께 종료된다.
///
/// - `%LOCALAPPDATA%\AnthropicClaudepp-<버전>\claude.exe` — Claude 데스크톱 앱.
///   실행 파일 이름이 CLI와 글자 하나 다르지 않다.
/// - `%LOCALAPPDATA%\OpenAI\Codexin\<해시>\codex.exe` — ChatGPT/Codex 데스크톱 앱이
///   띄우는 app-server. macOS의 `ChatGPT.app/Contents/Resources/codex`와 같은 것이고,
///   자손으로 `node_repl.exe`·`cmd.exe` 수십 개를 거느려 함께 끌려 들어간다.
const DESKTOP_APP_PATH_MARKERS: &[&str] =
    &[".app/contents/", "/anthropicclaude/", "/openai/codex/bin/"];

fn token_matches(token: &str, target: &str) -> bool {
    let normalized = token.replace('\\', "/").to_ascii_lowercase();
    if DESKTOP_APP_PATH_MARKERS
        .iter()
        .any(|marker| normalized.contains(marker))
    {
        return false;
    }
    executable_name_is(token, target)
}

/// 토큰의 실행 파일 이름이 주어진 이름인지. 확장자만 붙은 경우(`claude.exe`·`codex.js`)도
/// 같은 이름으로 본다.
///
/// 윈도우에서는 대소문자를 가리지 않는다 — 파일 시스템이 가리지 않으므로 `Claude.exe`와
/// `claude.exe`는 같은 파일이다. 유닉스에서는 `Claude`(데스크톱 앱)와 `claude`(CLI)가
/// 서로 다른 파일이라 예전처럼 정확히 비교한다.
fn executable_name_is(token: &str, name: &str) -> bool {
    let path = Path::new(token);
    let candidates = [
        path.file_name().and_then(|value| value.to_str()),
        path.file_stem().and_then(|value| value.to_str()),
    ];
    candidates.into_iter().flatten().any(|candidate| {
        if cfg!(windows) {
            candidate.eq_ignore_ascii_case(name)
        } else {
            candidate == name
        }
    })
}

#[cfg(unix)]
fn terminate_processes(
    provider: ProviderId,
    targets: Vec<ExternalProviderProcess>,
) -> TerminateExternalProcessesReport {
    let requested_count = targets.len();
    if requested_count == 0 {
        return TerminateExternalProcessesReport::empty(provider);
    }
    let survivors = signal_and_wait(&targets, libc::SIGTERM, SIGTERM_GRACE);
    let mut forced_count = 0usize;
    let mut failed = Vec::new();
    if !survivors.is_empty() {
        let remaining = signal_and_wait(&survivors, libc::SIGKILL, SIGKILL_GRACE);
        forced_count = survivors.len() - remaining.len();
        failed = remaining
            .into_iter()
            .map(|process| termination_failure(process, "SIGKILL 이후에도 종료되지 않았습니다"))
            .collect();
    }
    TerminateExternalProcessesReport {
        provider,
        requested_count,
        terminated_count: requested_count - failed.len(),
        forced_count,
        failed,
    }
}

#[cfg(unix)]
/// 대상 프로세스들에 시그널을 일괄 전송하고 유예 시간 동안 종료를 대기한다.
fn signal_and_wait(
    targets: &[ExternalProviderProcess],
    signal: libc::c_int,
    grace: Duration,
) -> Vec<ExternalProviderProcess> {
    for process in targets {
        send_signal(process.pid, signal);
    }
    wait_for_exit(targets, grace)
}

#[cfg(not(any(unix, windows)))]
fn terminate_processes(
    provider: ProviderId,
    targets: Vec<ExternalProviderProcess>,
) -> TerminateExternalProcessesReport {
    let requested_count = targets.len();
    TerminateExternalProcessesReport {
        provider,
        requested_count,
        terminated_count: 0,
        forced_count: 0,
        failed: targets
            .into_iter()
            .map(|process| {
                termination_failure(
                    process,
                    "이 플랫폼에서는 외부 프로세스 종료를 지원하지 않습니다",
                )
            })
            .collect(),
    }
}

fn termination_failure(process: ExternalProviderProcess, error: &str) -> ExternalProcessFailure {
    ExternalProcessFailure {
        pid: process.pid,
        command: process.command,
        error: error.to_owned(),
    }
}

#[cfg(unix)]
fn send_signal(pid: u32, signal: libc::c_int) {
    // 이미 사라진 프로세스는 성공 경로이고, 남은 프로세스는 어차피 유예 시간 뒤에 다시
    // 확인하므로 전달 결과는 보지 않는다.
    let _ = process_signal::signal_pid(pid, signal);
}

#[cfg(unix)]
fn wait_for_exit(
    targets: &[ExternalProviderProcess],
    grace: Duration,
) -> Vec<ExternalProviderProcess> {
    let deadline = Instant::now() + grace;
    let mut remaining: Vec<ExternalProviderProcess> = targets.to_vec();
    loop {
        remaining.retain(|process| pid_alive(process.pid));
        if remaining.is_empty() || Instant::now() >= deadline {
            return remaining;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // 자신의 자식이었던 프로세스가 좀비로 남지 않게 기회가 될 때마다 회수한다.
    process_signal::reap_zombie_child(pid);
    // 신호를 보낼 권한이 없는 프로세스는 종료를 확인할 수단도 없으므로 종료로 본다.
    matches!(
        process_signal::signal_pid(pid, 0),
        Ok(process_signal::SignalDelivery::Delivered)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: u32, ppid: u32, owner: u32, command: &str) -> PsEntry {
        PsEntry {
            pid,
            ppid,
            owner,
            started: None,
            command: command.to_owned(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn ps_lines_parse_into_entries() {
        let parsed = parse_ps_line("  123   1  501 /usr/local/bin/claude --resume abc")
            .expect("parsed entry");
        assert_eq!(parsed.pid, 123);
        assert_eq!(parsed.ppid, 1);
        assert_eq!(parsed.owner, 501);
        assert_eq!(parsed.command, "/usr/local/bin/claude --resume abc");
        assert!(parse_ps_line("").is_none());
        assert!(parse_ps_line("abc def ghi command").is_none());
    }

    #[test]
    fn provider_command_matching_covers_wrappers_and_rejects_lookalikes() {
        let claude = ProviderId::Claude;
        let codex = ProviderId::Codex;
        assert!(matches_provider_command(claude, "claude"));
        assert!(matches_provider_command(
            claude,
            "/Users/x/.local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe --print"
        ));
        assert!(matches_provider_command(
            claude,
            "node /opt/tools/claude --ide"
        ));
        assert!(matches_provider_command(
            claude,
            "node --max-old-space-size=4096 /opt/tools/claude --ide"
        ));
        assert!(matches_provider_command(
            claude,
            "node -r preload /opt/tools/claude --ide"
        ));
        assert!(matches_provider_command(
            claude,
            "node --require preload --import bootstrap.mjs --experimental-loader loader.mjs --conditions development /opt/tools/claude --ide"
        ));
        assert!(matches_provider_command(
            claude,
            "bun --preload bootstrap.ts /opt/tools/claude --ide"
        ));
        assert!(matches_provider_command(
            claude,
            "deno --config deno.json /opt/tools/claude --ide"
        ));
        assert!(matches_provider_command(
            codex,
            "/opt/homebrew/Caskroom/codex/0.146.0/bin/codex app-server --stdio"
        ));
        assert!(matches_provider_command(
            codex,
            "node /x/node_modules/@openai/codex/bin/codex.js app-server"
        ));
        // 데스크톱 앱·파생 이름·다른 공급자는 매칭하지 않는다.
        assert!(!matches_provider_command(
            claude,
            "/Applications/Claude.app/Contents/MacOS/Claude"
        ));
        // 이름이 CLI와 같아도 앱 번들 내장 실행 파일은 제외한다.
        assert!(!matches_provider_command(
            codex,
            "/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server"
        ));
        assert!(!matches_provider_command(codex, "codex-code-mode-host"));
        assert!(!matches_provider_command(codex, "npm exec codex-acp"));
        assert!(!matches_provider_command(claude, "codex app-server"));
        assert!(!matches_provider_command(claude, "grep claude"));
    }

    /// 윈도우 조회 스크립트가 명령줄까지 읽을 이름 목록과, 매칭이 실제로 인식하는
    /// 이름이 갈라지면 그 설치 형태만 조용히 보이지 않게 된다. 한쪽만 고치지 못하게 묶는다.
    #[test]
    fn command_line_name_list_covers_every_matchable_executable() {
        let names = command_line_executable_names();
        for provider in ProviderId::ALL {
            assert!(
                names.iter().any(|name| name == provider.as_str()),
                "{} 이름이 조회 목록에 없다",
                provider.as_str()
            );
        }
        for runtime in RUNTIME_EXECUTABLE_NAMES {
            assert!(
                RuntimeWrapper::from_executable(runtime).is_some(),
                "{runtime}은 런타임 래퍼로 인식되어야 한다"
            );
            assert!(names.iter().any(|name| name == runtime));
        }
    }

    /// 윈도우 설치 형태. 확장자가 붙고 경로 구분자가 `\\`이며, 데스크톱 앱은 CLI와
    /// 이름이 완전히 같아 설치 폴더로만 갈린다.
    #[cfg(windows)]
    #[test]
    fn windows_command_shapes_match_the_cli_but_not_the_desktop_app() {
        let claude = ProviderId::Claude;
        assert!(matches_provider_command(
            claude,
            r"C:\Users\me\.local\bin\claude.exe --print"
        ));
        // 공백이 든 경로는 큰따옴표로 묶여 온다. 따옴표를 모르면 첫 토큰이
        // `"C:\Program`이 되어 실행 파일을 통째로 놓친다.
        assert!(matches_provider_command(
            claude,
            r#""C:\Program Files\nodejs\node.exe" "C:\tools\claude" --ide"#
        ));
        // 설치 폴더가 데스크톱 앱이면 이름이 같아도 대상이 아니다.
        assert!(!matches_provider_command(
            claude,
            r"C:\Users\me\AppData\Local\AnthropicClaude\app-1.2.3\claude.exe"
        ));
    }

    /// 조회 경로가 실제로 도는지 본다. 스크립트 한 글자가 어긋나도 여기서 걸린다 —
    /// 이 경로가 조용히 실패하면 윈도우에서 외부 프로세스는 다시 보이지 않게 된다.
    #[cfg(windows)]
    #[test]
    fn windows_snapshot_sees_this_process() {
        let entries = snapshot_process_table().expect("프로세스 표를 읽어야 한다");
        let own = entries
            .iter()
            .find(|entry| entry.pid == std::process::id())
            .expect("자기 자신이 표에 있어야 한다");
        assert_eq!(own.owner, current_owner());
        assert!(own.started.is_some(), "생성 시각이 있어야 한다");
        assert!(!own.command.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn windows_process_lines_parse_with_their_creation_stamp() {
        let parsed =
            parse_windows_process_line(r"4321 900 1 133700000000000000 C:\bin\claude.exe --print")
                .expect("parsed entry");
        assert_eq!(parsed.pid, 4321);
        assert_eq!(parsed.ppid, 900);
        assert_eq!(parsed.owner, 1);
        assert_eq!(parsed.started, Some(133_700_000_000_000_000));
        assert_eq!(parsed.command, r"C:\bin\claude.exe --print");
        // 생성 시각 0은 "모른다"이고, 칸이 모자라거나 숫자가 아니면 줄을 버린다.
        assert_eq!(
            parse_windows_process_line("10 1 1 0 claude").and_then(|entry| entry.started),
            None
        );
        assert!(parse_windows_process_line("10 1 1 0").is_none());
        assert!(parse_windows_process_line("a b c d claude").is_none());
    }

    /// PID 재사용으로 부모가 자식보다 나중에 생긴 것처럼 보이면 그 고리에서 멈춘다.
    /// 윈도우는 번호를 빠르게 돌려 쓰고 부모가 죽어도 `ParentProcessId`를 지우지 않는다.
    #[test]
    fn ancestry_stops_at_a_parent_younger_than_its_child() {
        let stamped = |pid: u32, ppid: u32, started: u64| PsEntry {
            pid,
            ppid,
            owner: 1,
            started: Some(started),
            command: "x".to_owned(),
        };
        let entries = vec![
            stamped(10, 0, 100),
            // 20의 부모 자리에 있는 10은 20보다 나중에 생겼다 → 재사용된 번호다.
            stamped(20, 10, 50),
            stamped(30, 10, 200),
        ];
        let tree = ProcessTree::from_entries(&entries);
        assert!(tree.ancestors_of(20).is_empty());
        assert_eq!(tree.ancestors_of(30), vec![10]);
    }

    #[test]
    fn selection_excludes_own_tree_and_includes_matched_descendants() {
        let app = 100u32; // Agent Manager 자신
        let entries = vec![
            entry(1, 0, 0, "/sbin/launchd"),
            entry(90, 1, 501, "/bin/zsh"), // 앱을 실행한 셸(조상)
            entry(100, 90, 501, "agent-manager"), // 자기 자신
            entry(110, 100, 501, "claude --print --session-id abc"), // 관리 런타임(자손)
            entry(111, 110, 501, "codex mcp-server"), // 관리 런타임의 보조 프로세스
            entry(200, 1, 501, "/usr/local/bin/claude"), // 외부 세션 → 대상
            entry(201, 200, 501, "/bin/bash -c ls"), // 외부 세션의 자손 → 대상
            entry(300, 1, 501, "node /x/claude --ide"), // IDE 확장 세션 → 대상
            entry(400, 1, 502, "claude"),  // 다른 사용자 → 제외
            entry(
                500,
                1,
                501,
                "/Applications/Claude.app/Contents/MacOS/Claude",
            ), // 데스크톱 앱 → 제외
        ];
        let selected = select_external_processes(ProviderId::Claude, &entries, app, 501);
        let pids: Vec<u32> = selected.iter().map(|process| process.pid).collect();
        assert_eq!(pids, vec![200, 201, 300]);
    }

    #[test]
    fn selection_excludes_ancestor_provider_sessions() {
        // 앱이 claude 세션 안에서 실행된 경우(개발 환경) 조상 세션은 죽이지 않는다.
        let entries = vec![
            entry(1, 0, 0, "/sbin/launchd"),
            entry(50, 1, 501, "claude"), // 앱을 실행한 claude 세션(조상)
            entry(60, 50, 501, "/bin/zsh"),
            entry(100, 60, 501, "agent-manager"),
        ];
        let selected = select_external_processes(ProviderId::Claude, &entries, 100, 501);
        assert!(selected.is_empty());
    }

    #[test]
    fn process_tree_traversal_and_ancestor_checks() {
        let entries = vec![
            entry(1, 0, 0, "/sbin/launchd"),
            entry(10, 1, 501, "parent"),
            entry(20, 10, 501, "child"),
            entry(30, 20, 501, "grandchild"),
        ];
        let tree = ProcessTree::from_entries(&entries);
        assert_eq!(tree.ancestors_of(30), vec![20, 10, 1]);
        assert!(tree.has_ancestor(30, 10));
        assert!(tree.has_ancestor(30, 1));
        assert!(!tree.has_ancestor(30, 999));
        assert!(!tree.has_ancestor(1, 10));

        let targets: HashSet<u32> = [10, 99].into_iter().collect();
        assert!(tree.has_any_ancestor_in(30, &targets));
        assert!(tree.has_any_ancestor_in(20, &targets));
        assert!(!tree.has_any_ancestor_in(10, &targets));
    }

    #[cfg(unix)]
    #[test]
    fn terminate_processes_stops_a_live_target_gracefully() {
        let child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        let report = terminate_processes(
            ProviderId::Claude,
            vec![ExternalProviderProcess {
                pid,
                command: "/bin/sleep 30".to_owned(),
            }],
        );
        assert_eq!(report.requested_count, 1);
        assert_eq!(report.terminated_count, 1);
        assert_eq!(report.forced_count, 0, "SIGTERM으로 종료되면 승격 없음");
        assert!(report.failed.is_empty());
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, -1);
        drop(child);
    }
}
