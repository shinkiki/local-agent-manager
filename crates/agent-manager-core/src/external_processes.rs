//! 외부에서 독립 실행된 공급자 CLI 프로세스 탐지·종료.
//!
//! 계정 전환 시 공급자 세션을 완전히 정리하기 위해 Agent Manager가 직접
//! 관리하지 않는 공급자 CLI 프로세스(터미널·IDE 확장 등)도 종료 대상에
//! 포함한다. 현재 사용자 소유 프로세스만 대상으로 하며, Agent Manager
//! 자신과 그 자손(관리 런타임·로그인 세션 포함)·조상(앱을 실행한 셸 체인)은
//! 제외한다. 매칭된 프로세스의 자손(MCP 서버 등 세션이 띄운 보조 프로세스)은
//! 같은 세션 트리로 보고 함께 종료한다.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::domain::ProviderId;
use crate::CoreError;

const SIGTERM_GRACE: Duration = Duration::from_secs(3);
const SIGKILL_GRACE: Duration = Duration::from_secs(2);

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
    uid: u32,
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
        current_uid(),
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

/// 외부 공급자 CLI 프로세스가 하나라도 실행 중인지 판정한다. 프로세스 표
/// 조회가 실패하면 보수적으로 실행 중으로 간주한다.
#[cfg(unix)]
pub(crate) fn external_provider_process_running(provider: ProviderId) -> bool {
    list_external_provider_processes(provider)
        .map(|processes| !processes.is_empty())
        .unwrap_or(true)
}

/// Windows는 아직 프로세스 트리 스냅숏을 지원하지 않아 tasklist 이미지 이름
/// 휴리스틱으로만 판정한다.
#[cfg(not(unix))]
pub(crate) fn external_provider_process_running(provider: ProviderId) -> bool {
    let output = Command::new("tasklist")
        .args(["/FO", "CSV", "/NH"])
        .output();
    let Ok(output) = output else {
        return true;
    };
    let lower = String::from_utf8_lossy(&output.stdout).to_ascii_lowercase();
    match provider {
        ProviderId::Codex => lower.contains("codex.exe"),
        ProviderId::Claude => lower.contains("claude.exe"),
        ProviderId::Antigravity => false,
    }
}

#[cfg(unix)]
fn snapshot_process_table() -> Result<Vec<PsEntry>, CoreError> {
    let output = Command::new("/bin/ps")
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

#[cfg(not(unix))]
fn snapshot_process_table() -> Result<Vec<PsEntry>, CoreError> {
    Err(CoreError::Runtime(
        "이 플랫폼에서는 외부 프로세스 조회를 지원하지 않습니다".to_owned(),
    ))
}

fn parse_ps_line(line: &str) -> Option<PsEntry> {
    let mut tokens = line.split_whitespace();
    let pid = tokens.next()?.parse().ok()?;
    let ppid = tokens.next()?.parse().ok()?;
    let uid = tokens.next()?.parse().ok()?;
    // 연속 공백은 하나로 접힌다. 매칭·표시 용도로는 충분하다.
    let command = tokens.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        return None;
    }
    Some(PsEntry {
        pid,
        ppid,
        uid,
        command,
    })
}

#[cfg(unix)]
fn current_uid() -> u32 {
    unsafe { libc::getuid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
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
    uid: u32,
) -> Vec<ExternalProviderProcess> {
    let parents: HashMap<u32, u32> = entries
        .iter()
        .map(|entry| (entry.pid, entry.ppid))
        .collect();
    // 조상은 해당 pid 자체만 제외한다. 조상의 자손까지 제외하면 launchd 같은
    // 공통 조상 때문에 시스템 전체가 제외되어 버린다. 자기 자신은 자손까지
    // 통째로 제외해 관리 런타임·로그인 세션을 보호한다.
    let self_ancestors: HashSet<u32> = ancestors_of(self_pid, &parents).into_iter().collect();
    let is_excluded = |pid: u32| -> bool {
        pid == self_pid
            || self_ancestors.contains(&pid)
            || ancestors_of(pid, &parents).contains(&self_pid)
    };

    let matched: HashSet<u32> = entries
        .iter()
        .filter(|entry| entry.uid == uid)
        .filter(|entry| matches_provider_command(provider, &entry.command))
        .filter(|entry| !is_excluded(entry.pid))
        .map(|entry| entry.pid)
        .collect();

    entries
        .iter()
        .filter(|entry| entry.uid == uid)
        .filter(|entry| !is_excluded(entry.pid))
        .filter(|entry| {
            matched.contains(&entry.pid)
                || ancestors_of(entry.pid, &parents)
                    .iter()
                    .any(|ancestor| matched.contains(ancestor))
        })
        .map(|entry| ExternalProviderProcess {
            pid: entry.pid,
            command: entry.command.clone(),
        })
        .collect()
}

/// pid의 조상 pid 목록. 순환·비정상 표에 대비해 깊이를 제한한다.
fn ancestors_of(pid: u32, parents: &HashMap<u32, u32>) -> Vec<u32> {
    let mut chain = Vec::new();
    let mut current = pid;
    for _ in 0..64 {
        let Some(&parent) = parents.get(&current) else {
            break;
        };
        if parent == 0 || parent == current {
            break;
        }
        chain.push(parent);
        current = parent;
    }
    chain
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
    let mut tokens = command.split_whitespace();
    let Some(first) = tokens.next() else {
        return false;
    };
    if token_matches(first, target) {
        return true;
    }
    if matches!(basename(first), Some("node" | "bun" | "deno")) {
        if let Some(script) = tokens.next() {
            return token_matches(script, target);
        }
    }
    false
}

fn token_matches(token: &str, target: &str) -> bool {
    // 데스크톱 앱 번들 내부 실행 파일은 CLI 공유 자격증명의 소비자가 아니다.
    if token.contains(".app/Contents/") {
        return false;
    }
    let path = Path::new(token);
    let name = path.file_name().and_then(|name| name.to_str());
    let stem = path.file_stem().and_then(|stem| stem.to_str());
    name == Some(target) || stem == Some(target)
}

fn basename(token: &str) -> Option<&str> {
    Path::new(token).file_name().and_then(|name| name.to_str())
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
    for process in &targets {
        send_signal(process.pid, libc::SIGTERM);
    }
    let survivors = wait_for_exit(&targets, SIGTERM_GRACE);
    let mut forced_count = 0usize;
    let mut failed = Vec::new();
    if !survivors.is_empty() {
        for process in &survivors {
            send_signal(process.pid, libc::SIGKILL);
        }
        let remaining = wait_for_exit(&survivors, SIGKILL_GRACE);
        forced_count = survivors.len() - remaining.len();
        failed = remaining
            .into_iter()
            .map(|process| ExternalProcessFailure {
                pid: process.pid,
                command: process.command,
                error: "SIGKILL 이후에도 종료되지 않았습니다".to_owned(),
            })
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

#[cfg(not(unix))]
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
            .map(|process| ExternalProcessFailure {
                pid: process.pid,
                command: process.command,
                error: "이 플랫폼에서는 외부 프로세스 종료를 지원하지 않습니다".to_owned(),
            })
            .collect(),
    }
}

#[cfg(unix)]
fn send_signal(pid: u32, signal: libc::c_int) {
    // 이미 사라진 프로세스(ESRCH)는 성공 경로이므로 결과는 확인하지 않는다.
    unsafe {
        libc::kill(pid as libc::pid_t, signal);
    }
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
    let pid = pid as libc::pid_t;
    // 자신의 자식이었던 프로세스가 좀비로 남지 않게 기회가 될 때마다 회수한다.
    let mut status: libc::c_int = 0;
    unsafe {
        libc::waitpid(pid, &mut status, libc::WNOHANG);
    }
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: u32, ppid: u32, uid: u32, command: &str) -> PsEntry {
        PsEntry {
            pid,
            ppid,
            uid,
            command: command.to_owned(),
        }
    }

    #[test]
    fn ps_lines_parse_into_entries() {
        let parsed = parse_ps_line("  123   1  501 /usr/local/bin/claude --resume abc")
            .expect("parsed entry");
        assert_eq!(parsed.pid, 123);
        assert_eq!(parsed.ppid, 1);
        assert_eq!(parsed.uid, 501);
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
