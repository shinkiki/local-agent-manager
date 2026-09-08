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
        for flag in long_flags(help) {
            interface.flags.insert(flag);
        }
        for block in option_blocks(help) {
            let names = long_flags(block[0]);
            if names.is_empty() {
                continue;
            }
            let values = block_values(&block);
            for name in names {
                interface.flags.insert(name.clone());
                if let Some(values) = &values {
                    interface
                        .values
                        .entry(name)
                        .or_default()
                        .extend(values.iter().cloned());
                }
            }
        }
        interface
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
        match self.values.get(flag) {
            Some(values) if !values.is_empty() => values.contains(value),
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
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    for line in help.lines() {
        if is_option_header(line) {
            blocks.push(vec![line]);
        } else if let Some(block) = blocks.last_mut() {
            // 들여쓰기가 없는 줄은 새 섹션 제목이므로 블록을 닫는다.
            if !line.trim().is_empty() && !line.starts_with(char::is_whitespace) {
                blocks.push(Vec::new());
            } else {
                block.push(line);
            }
        }
    }
    blocks.retain(|block| !block.is_empty());
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

pub(crate) fn run_capped(
    executable: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<CommandOutcome, CoreError> {
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
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!(
            "{} 실행을 시작하지 못했습니다: {error}",
            executable.to_string_lossy()
        ))
    })?;
    let output_readers = CappedOutputReaders::spawn(child.stdout.take(), child.stderr.take());

    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break Some(status),
            None => {
                if started.elapsed() >= timeout {
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
}
