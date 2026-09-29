//! C9-14/C9-15/C9-17/C9-20: 원격 명령 한 줄이 실행 경로에 들어가도 되는지 판정한다.
//!
//! [`crate::ssh_exec`]에서 갈라져 나온 판정부다. 그쪽은 엔드포인트 해석·프로세스 실행·
//! 전송·영수증까지 함께 들고 있어, 목록 집행이라는 보안 경계가 `scp` 인자 조립이나 제한
//! 시간 계산과 같은 면에 놓여 있었다. 판정에 쓰이는 값(거부 앞머리·감싸는 앞머리·명령 길이
//! 상한)과 그 값을 읽는 함수만 여기로 모아, 경계가 무엇으로 이루어져 있는지 한 파일에서
//! 읽히게 한다.
//!
//! 판정은 네 자리로 갈린다. 문법 검사([`validate_remote_command`])가 먼저 오고, 승인으로도
//! 넘길 수 없는 거부([`enforce_hard_command_refusals`]), 파일을 만드는 리다이렉션
//! ([`enforce_redirect_policy`]), 마지막으로 승인이 대신할 수 있는 허용 목록 대조
//! ([`command_allowance`])가 온다. 순서는 실행 경로가 정하고, 여기서는 각 자리가 무엇을
//! 보는지만 정한다.

use crate::ssh_command_line::{parse_remote_command_line, parse_rule_words, RemoteCommandLine};
use crate::ssh_endpoints::SshEndpointView;
use crate::CoreError;

/// 원격 명령 한 줄의 상한. 규칙과 맞춰 보는 값이라 길 필요가 없다.
pub(crate) const MAX_REMOTE_COMMAND_CHARS: usize = 512;

/// 허용 목록에 적혀 있어도 이 인터페이스가 대신 실행하지 않는 앞머리.
///
/// 셸과 인터프리터는 이어지는 인자를 코드로 읽고, 네트워크 페치는 코드를 서버로 끌어온다.
/// 어느 쪽이든 목록에 한 줄만 들어가면 나머지 규칙 전부가 무의미해진다. `sudo`·`rm`은
/// 여기 없다 — 원격 설치를 아예 못 하게 되므로, 기본 차단 목록에 넣어 사용자가 그 서버에
/// 대해 명시적으로 열 때만 지나가게 한다(C9-15).
const REFUSED_COMMAND_HEADS: &[&str] = &[
    "sh", "bash", "zsh", "ksh", "dash", "csh", "tcsh", "fish", "ash", "busybox", "env", "eval",
    "exec", "source", "command", "builtin", "curl", "wget", "fetch", "nc", "ncat", "netcat",
    "socat", "telnet", "python", "python2", "python3", "perl", "ruby", "node", "php", "lua", "awk",
    "gawk", "mawk", "xargs", "ssh", "scp", "sftp", "chroot", "gdb", "screen", "tmux", "expect",
];

/// 뒤에 오는 토큰이 다시 명령이 되는 앞머리. 이 자리에서 멈추면 `sudo sh -c …`가 `sudo`
/// 규칙만으로 지나간다.
const WRAPPER_COMMAND_HEADS: &[&str] = &[
    "sudo",
    "doas",
    "su",
    "nohup",
    "setsid",
    "time",
    "nice",
    "ionice",
    "stdbuf",
    "timeout",
    "ssh-agent",
];

/// C9-20. 명령 한 줄을 앱이 이해하는 문법으로 읽는다. 돌려준 값은 그대로 다시 적어
/// 보낼 수 있고, 정책은 그 단계들에 걸린다.
///
/// 길이는 받은 줄과 다시 적은 줄 **둘 다** 본다. 인용이 붙으면 정본이 원문보다 길어질 수
/// 있는데, 원격에 나가는 것은 정본이므로 상한도 거기에 걸려야 한다.
pub(crate) fn validate_remote_command(value: &str) -> Result<RemoteCommandLine, CoreError> {
    if value.chars().count() > MAX_REMOTE_COMMAND_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "원격 명령은 {MAX_REMOTE_COMMAND_CHARS}자 이하여야 합니다"
        )));
    }
    let line = parse_remote_command_line(value)?;
    if line.render().chars().count() > MAX_REMOTE_COMMAND_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "원격 명령은 {MAX_REMOTE_COMMAND_CHARS}자 이하여야 합니다"
        )));
    }
    Ok(line)
}

/// 한 단계에서 실제로 실행될 앞머리들을 뽑는다. `sudo systemctl restart app`이면
/// `["sudo", "systemctl"]`이다. 감싸는 앞머리에서 멈추면 `sudo sh -c …`가 지나간다.
fn command_heads(argv: &[&str]) -> Vec<String> {
    let mut heads = Vec::new();
    for token in argv {
        if token.starts_with('-') {
            continue;
        }
        let head = token.rsplit('/').next().unwrap_or(token).to_owned();
        let wrapper = WRAPPER_COMMAND_HEADS.contains(&head.as_str());
        heads.push(head);
        if !wrapper {
            break;
        }
    }
    heads
}

/// C9-19. 이 줄에서 원격 `sudo`가 비밀번호를 물을 수 있는 자리들 — `(단계 번호, 그 단계의
/// `sudo` 토큰 번호)`. 비어 있으면 값을 받을 이유가 없는 줄이다.
///
/// 앞머리 판정은 허용·차단 대조와 **같은 규칙**(`command_heads`)을 쓴다. 감싸는 앞머리를
/// 따라가되 첫 실행 대상에서 멈추므로, 인자로 적힌 `sudo`(`grep sudo /var/log/auth.log`)는
/// 잡히지 않는다.
///
/// 비대화형을 스스로 적은 단계(`-n`·`--non-interactive`)는 제외한다 — 그렇게 적은 호출이
/// 읽으려는 것은 "비밀번호 없이 되는가"이고, 값을 밀어 넣으면 그 답이 바뀐다. 그 판정은
/// 단계 전체가 아니라 **sudo 자신의 옵션 구간**([`sudo_own_options`])에서만 본다 —
/// `sudo tail -n 50 …`의 `-n`은 `tail`의 것이라, 단계 전체를 훑으면 sudo가 비밀번호를
/// 물을 명령을 "비밀번호 없이 되는지 보려는 호출"로 읽고 값을 받지 않은 채 내보낸다.
/// `doas`는 stdin으로 비밀번호를 받는 길이 없어 여기 들지 않는다.
pub(crate) fn sudo_prompt_positions(line: &RemoteCommandLine) -> Vec<(usize, usize)> {
    let mut positions = Vec::new();
    for (stage_index, stage) in line.stages().iter().enumerate() {
        let argv = stage.argv();
        for (token_index, token) in argv.iter().enumerate() {
            if token.starts_with('-') {
                continue;
            }
            let head = token.rsplit('/').next().unwrap_or(token);
            if head == "sudo" {
                if !sudo_own_options(&argv, token_index)
                    .iter()
                    .any(|option| *option == "-n" || *option == "--non-interactive")
                {
                    positions.push((stage_index, token_index));
                }
                break;
            }
            if !WRAPPER_COMMAND_HEADS.contains(&head) {
                break;
            }
        }
    }
    positions
}

/// 값을 뒤 토큰으로 받는 `sudo` 옵션. 이 목록에 없는 옵션은 홀로 서므로 다음 토큰이
/// 곧 sudo가 실행할 명령이다. `--user=root`처럼 값을 붙여 적은 긴 옵션은 토큰 하나라
/// 여기 걸리지 않는다.
const SUDO_VALUE_OPTIONS: &[&str] = &[
    "-C",
    "-D",
    "-g",
    "-h",
    "-p",
    "-R",
    "-r",
    "-T",
    "-t",
    "-U",
    "-u",
    "--chdir",
    "--chroot",
    "--close-from",
    "--command-timeout",
    "--group",
    "--host",
    "--other-user",
    "--prompt",
    "--role",
    "--type",
    "--user",
];

/// C9-19. `sudo` 토큰 뒤에서 **sudo 자신의** 옵션만 뽑는다. sudo는 첫 비옵션 토큰부터를
/// 실행할 명령으로 읽으므로, 그 자리에서 멈춘다(`--`도 같은 경계다).
///
/// 이 구간을 가리지 않고 단계 전체를 훑으면 감싸인 명령의 플래그가 sudo의 것으로 읽힌다.
/// 실제로 걸리는 값이 흔하다 — `-n`은 `tail`·`grep`·`sort`의 예사 플래그이고, `-S`는
/// `ls`·`sort`의 플래그다. 앞은 비밀번호를 받을 자리를 통째로 건너뛰게 하고, 뒤는 이미
/// `-S`가 있다고 보아 sudo에 `-S`를 붙이지 않은 채 비밀번호만 stdin으로 밀어 넣는다.
pub(crate) fn sudo_own_options<'a>(argv: &[&'a str], sudo_index: usize) -> Vec<&'a str> {
    let mut options = Vec::new();
    let mut index = sudo_index + 1;
    while let Some(token) = argv.get(index) {
        if *token == "--" || !token.starts_with('-') {
            break;
        }
        options.push(*token);
        if SUDO_VALUE_OPTIONS.contains(token) {
            // 값까지 건너뛴다. 값이 없이 끝나면 `get`이 None을 내 반복이 멈춘다.
            index += 1;
        }
        index += 1;
    }
    options
}

/// 규칙 한 줄을 명령과 **같은 방식으로** 단어로 가른다. 규칙에 따옴표가 있으면 그 경계를
/// 지키고, 옛 저장본처럼 이 문법으로 읽히지 않는 줄은 예전처럼 공백으로 가른다 — 저장돼
/// 있던 규칙이 파서 도입만으로 조용히 무효가 되지는 않게 한다.
fn rule_tokens(rule: &str) -> Vec<String> {
    parse_rule_words(rule).unwrap_or_else(|_| {
        rule.split_whitespace()
            .map(|token| token.to_owned())
            .collect()
    })
}

/// 규칙 하나가 이 단계를 잡는지. 허용은 토큰이 그대로 같아야 하고(`sh`가 `shutdown`을 잡지
/// 않게), 차단은 마지막 토큰을 앞머리로도 본다(`cat ~/.ssh/id_`가 `id_ed25519`까지 잡도록).
/// 차단이 넓은 쪽을 쓰는 것은 차단이 우선이기 때문이다.
fn matches_token_prefix(argv: &[&str], rule: &str) -> bool {
    let tokens = rule_tokens(rule);
    !tokens.is_empty()
        && argv.len() >= tokens.len()
        && tokens
            .iter()
            .zip(argv)
            .all(|(rule_token, word)| rule_token == word)
}

fn matches_denied_rule(argv: &[&str], rule: &str) -> bool {
    let tokens = rule_tokens(rule);
    let Some((last, leading)) = tokens.split_last() else {
        return false;
    };
    argv.len() > leading.len()
        && leading
            .iter()
            .zip(argv)
            .all(|(rule_token, word)| rule_token == word)
        && argv[leading.len()].starts_with(last.as_str())
}

/// C9-14/C9-17. 승인으로도 넘길 수 없는 거부. 셸·인터프리터·네트워크 페치 앞머리와 그
/// 서버의 차단 목록이 여기 든다.
///
/// 승인이 이 자리를 넘기지 않는 이유는 서로 다르다. 앞머리 거부는 **집행 자체가 성립하지
/// 않게** 만드는 한 줄이라, 사용자가 그 한 번을 허락했다는 사실이 `bash -c …` 뒤에 무엇이
/// 오는지를 앱이 알게 해 주지 않는다. 차단 목록은 사용자가 그 서버에 대해 "어떤 경우에도
/// 아니다"라고 이미 답해 둔 값이라, 카드 한 장이 그 답을 뒤집는다면 목록을 적은 의미가 없다.
pub(crate) fn enforce_hard_command_refusals(
    endpoint: &SshEndpointView,
    line: &RemoteCommandLine,
) -> Result<(), CoreError> {
    // C9-20. 파이프라인의 **모든 단계**를 본다. 앞머리 하나만 보면 `tail x | xargs rm`이
    // `tail` 규칙만으로 지나가, 파이프를 여는 순간 목록이 다시 장식이 된다.
    for stage in line.stages() {
        let argv = stage.argv();
        for head in command_heads(&argv) {
            if REFUSED_COMMAND_HEADS.contains(&head.as_str()) {
                return Err(CoreError::Conflict(format!(
                    "{head}은(는) 이 인터페이스가 대신 실행하지 않습니다. 셸·인터프리터·네트워크 내려받기 명령은 허용 목록에 적혀 있어도, 사용자가 1회 승인을 해 주어도, 파이프라인의 중간 단계여도 거절합니다 — 그 한 줄이 나머지 규칙 전부를 무의미하게 만들기 때문입니다. 필요한 작업을 그 도구 없이 표현하거나 사용자에게 직접 실행을 요청하세요"
                )));
            }
        }
        // 차단이 우선한다. 허용 목록에 걸리는 명령이어도, 사용자가 1회 승인을 해 주어도
        // 차단에 걸리면 실행하지 않는다.
        if let Some(rule) = endpoint
            .denied_commands
            .iter()
            .find(|rule| matches_denied_rule(&argv, rule))
        {
            return Err(CoreError::Conflict(format!(
                "이 서버의 차단 명령 \"{rule}\"에 \"{}\"이(가) 걸려 실행하지 않았습니다. 1회 승인으로도 우회할 수 없으며, 목록은 애드온 → SSH → 연결 서버 → 고급 설정에서 사용자가 정합니다",
                stage.render_command()
            )));
        }
    }
    Ok(())
}

/// C9-20. 파일을 만드는 리다이렉션(`>`·`>>`)은 명령 목록이 판정할 수 없는 자리다. 규칙은
/// 명령 앞머리와 맞춰 보는데 리다이렉션 대상은 명령이 아니어서, `ls > /etc/cron.d/x`는
/// `ls`만 허용된 서버에서도 목록을 통과한다. 그래서 무제한 명령 허용을 켠 서버에서만 연다 —
/// 그 서버에서는 사용자가 이미 같은 답을 해 두었다. 읽기(`<`)와 파이프 합치기(`2>&1`)는
/// 원격에 아무것도 남기지 않으므로 어느 서버에서나 쓸 수 있다.
pub(crate) fn enforce_redirect_policy(
    endpoint: &SshEndpointView,
    line: &RemoteCommandLine,
) -> Result<(), CoreError> {
    if endpoint.command_policy_mode().is_unrestricted() {
        return Ok(());
    }
    for stage in line.stages() {
        if stage.redirects().iter().any(|value| value.writes_file()) {
            return Err(CoreError::Conflict(
                "파일로 내보내는 리다이렉션(>, >>)은 이 서버에서 쓸 수 없습니다. 대상이 명령이 아니라 허용·차단 목록이 판정할 수 없는 자리이기 때문입니다. 무제한 명령 허용을 켠 서버에서만 열리며, 결과 파일이 필요하면 사용자에게 그 토글이나 파일 전송을 요청하세요".to_owned(),
            ));
        }
    }
    Ok(())
}

/// 허용 목록 대조 결과. 승인이 대신할 수 있는 자리는 정확히 이 하나다.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CommandAllowance {
    /// 사용자가 그 서버에 대해 이미 적어 둔 명령이다. 승인이 필요 없다.
    Allowed,
    /// 목록 밖이다. 사용자가 이 한 번을 승인하면 실행할 수 있다.
    NeedsApproval { reason: String },
}

/// C9-14/C9-17. 그 서버에 대해 사용자가 정한 허용 목록과 맞춰 본다. 하드 거부는 이 앞에서
/// 이미 걸러졌다고 본다([`enforce_hard_command_refusals`]).
pub(crate) fn command_allowance(
    endpoint: &SshEndpointView,
    line: &RemoteCommandLine,
) -> CommandAllowance {
    // 무제한 명령 허용을 켠 서버에서는 허용 목록을 보지 않는다. 사용자가 그 서버에 대해
    // "무엇이든 해도 된다"고 미리 답해 두었으므로 물을 것이 없고, 물어 봐야 할 자리가
    // 하나도 남지 않으므로 승인 카드도 뜨지 않는다. 차단 목록과 하드 거부는 이 함수
    // 앞에서 이미 지나왔고, 그 둘은 이 토글로도 열리지 않는다.
    if endpoint.command_policy_mode().is_unrestricted() {
        return CommandAllowance::Allowed;
    }
    // 허용 목록이 비어 있으면 사용자가 명시한 명령이 없는 것이다. 스킬 경로는 그때
    // 차단 목록만 적용하지만, 앱이 대신 실행하는 이 경로는 열지 않는다(C9-14) — 다만
    // 그 상태에서도 사용자는 이 한 번을 승인할 수 있다(C9-17).
    if endpoint.command_policy_mode().is_denylist_only() {
        return CommandAllowance::NeedsApproval {
            reason: "이 서버에는 허용 명령이 비어 있어 승인 없이 실행할 수 있는 명령이 없습니다."
                .to_owned(),
        };
    }
    // C9-20. 단계마다 대조하고, 하나라도 목록 밖이면 그 단계를 이름으로 말한다. 승인은
    // 줄 하나에 한 번이므로(사용자가 읽는 것도 줄 하나다) 여기서 멈추면 충분하다.
    for stage in line.stages() {
        let argv = stage.argv();
        if !endpoint
            .allowed_commands
            .iter()
            .any(|rule| matches_token_prefix(&argv, rule))
        {
            return CommandAllowance::NeedsApproval {
                reason: format!(
                    "\"{}\"은(는) 이 서버의 허용 명령 목록에 없습니다.",
                    stage.render_command()
                ),
            };
        }
    }
    CommandAllowance::Allowed
}
#[cfg(test)]
mod tests {

    /// C9-19. 어떤 명령이 sudo 비밀번호를 물을지 가린다. 감싸는 앞머리는 따라가되,
    /// 비대화형을 스스로 적은 명령은 건드리지 않는다.
    #[test]
    fn c9_19_finds_the_sudo_call_that_will_ask_for_a_password() {
        let positions =
            |command: &str| sudo_prompt_positions(&validate_remote_command(command).expect("문법"));
        assert_eq!(
            positions("sudo synopkg install_from_server Tailscale"),
            vec![(0, 0)]
        );
        assert_eq!(
            positions("/usr/bin/sudo systemctl restart app"),
            vec![(0, 0)]
        );
        // 감싸는 앞머리 뒤에 와도 찾는다.
        assert_eq!(positions("nohup sudo systemctl restart app"), vec![(0, 1)]);
        // 비대화형을 스스로 적었으면 그 뜻을 지킨다 — 값을 밀어 넣으면 호출한 쪽이
        // 읽으려던 결과(비밀번호 없이 되는가)가 바뀐다.
        assert!(positions("sudo -n whoami").is_empty());
        assert!(positions("sudo --non-interactive whoami").is_empty());
        // sudo가 없는 명령과 `doas`는 이 자리가 아니다.
        assert!(positions("systemctl status app").is_empty());
        assert!(positions("doas systemctl restart app").is_empty());
        // 앞머리로만 본다 — 인자에 든 낱말이 걸리면 안 된다.
        assert!(positions("grep sudo /etc/group").is_empty());
    }

    /// C9-19. 비대화형 판정은 **sudo 자신의 옵션 구간**만 본다. 감싸인 명령의 `-n`은
    /// 그 명령의 플래그이고, 그것을 sudo의 것으로 읽으면 비밀번호를 받을 자리를 통째로
    /// 건너뛰어 원격 sudo가 tty 없는 프롬프트에서 멈춘다.
    #[test]
    fn c9_19_reads_only_sudos_own_flags_when_deciding_non_interactive() {
        let positions =
            |command: &str| sudo_prompt_positions(&validate_remote_command(command).expect("문법"));
        // `-n`은 흔한 플래그다 — 줄 수(`tail`·`head`), 줄 번호(`grep`), 숫자 정렬(`sort`).
        assert_eq!(positions("sudo tail -n 50 /var/log/syslog"), vec![(0, 0)]);
        assert_eq!(
            positions("sudo grep -n error /var/log/syslog"),
            vec![(0, 0)]
        );
        // sudo 자신이 적은 것은 값을 받는 옵션 뒤에 와도 그대로 지킨다.
        assert!(positions("sudo -u app -n whoami").is_empty());
        assert!(positions("sudo --user=app --non-interactive whoami").is_empty());
        // `--` 뒤는 다시 명령이다.
        assert_eq!(
            positions("sudo -- tail -n 50 /var/log/syslog"),
            vec![(0, 0)]
        );
    }

    /// C9-19. `-S`는 `sudo` 바로 뒤에 들어가야 한다. 뒤에 오는 토큰은 다시 명령이라,
    /// 자리를 놓치면 플래그가 엉뚱한 프로그램에 붙는다. 영수증에 남는 원본은 그대로다.
    #[test]
    fn c9_19_inserts_the_stdin_password_flag_right_after_sudo() {
        let rewritten = |command: &str| {
            let line = validate_remote_command(command).expect("문법");
            line.with_stdin_password_flag(&sudo_prompt_positions(&line))
                .render()
        };
        assert_eq!(
            rewritten("sudo synopkg install_from_server Tailscale"),
            "sudo -S synopkg install_from_server Tailscale"
        );
        assert_eq!(
            rewritten("/usr/bin/sudo systemctl restart app"),
            "/usr/bin/sudo -S systemctl restart app"
        );
        // 이미 적혀 있으면 그대로 둔다.
        assert_eq!(
            rewritten("sudo -S systemctl restart app"),
            "sudo -S systemctl restart app"
        );
        // 파이프라인은 단계마다 본다.
        assert_eq!(
            rewritten("sudo journalctl -u app | grep error"),
            "sudo -S journalctl -u app | grep error"
        );
        // 감싸인 명령의 `-S`는 sudo의 것이 아니다. 그것을 이미 적힌 것으로 읽으면 sudo에
        // `-S`가 붙지 않은 채 비밀번호만 stdin으로 나간다.
        assert_eq!(rewritten("sudo ls -S /var"), "sudo -S ls -S /var");
        assert_eq!(
            rewritten("sudo sort -S 1G /var/log/syslog"),
            "sudo -S sort -S 1G /var/log/syslog"
        );
        // sudo 자신이 적은 `-S`는 값을 받는 옵션 뒤에 와도 그대로 둔다.
        assert_eq!(
            rewritten("sudo -u app -S systemctl restart app"),
            "sudo -u app -S systemctl restart app"
        );
    }
    use super::*;

    fn view(allowed: &[&str], denied: &[&str]) -> SshEndpointView {
        SshEndpointView {
            host: "build.example.com".to_owned(),
            port: 22,
            user: "deploy".to_owned(),
            agent_enabled: true,
            allowed_commands: allowed.iter().map(|value| (*value).to_owned()).collect(),
            denied_commands: denied.iter().map(|value| (*value).to_owned()).collect(),
            file_transfer_enabled: false,
            transfer_root: String::new(),
            terminal_enabled: false,
            unrestricted_commands: false,
            updated_at: 0,
        }
    }

    /// 승인 흐름이 둘로 나눈 판정을 한 줄로 다시 묶는다. 목록 집행 자체를 보는 C9-14
    /// 조건은 승인 자리가 생겨도 그대로여야 하므로, 그 조건은 이 합성으로 계속 확인한다.
    fn enforce_command_policy(endpoint: &SshEndpointView, command: &str) -> Result<(), CoreError> {
        let line = validate_remote_command(command)?;
        enforce_hard_command_refusals(endpoint, &line)?;
        enforce_redirect_policy(endpoint, &line)?;
        match command_allowance(endpoint, &line) {
            CommandAllowance::Allowed => Ok(()),
            CommandAllowance::NeedsApproval { reason } => Err(CoreError::Conflict(reason)),
        }
    }

    /// C9-14. 허용 목록은 지시문이 아니라 집행 지점이다. 앞머리로 대조하고, 차단이 이긴다.
    #[test]
    fn c9_command_policy_is_enforced_by_prefix_with_deny_winning() {
        let endpoint = view(&["systemctl status", "tail", "cat"], &["cat /etc/shadow"]);
        for command in [
            "systemctl status app --no-pager",
            "tail -n 200 /var/log/app.log",
            "cat /var/log/app.log",
        ] {
            enforce_command_policy(&endpoint, command).expect(command);
        }
        // 허용 목록에 없는 앞머리는 거절된다.
        assert!(enforce_command_policy(&endpoint, "systemctl restart app").is_err());
        assert!(enforce_command_policy(&endpoint, "docker ps").is_err());
        // 차단이 허용보다 우선한다. 토큰 중간에서 끊는 규칙까지 걸린다.
        assert!(enforce_command_policy(&endpoint, "cat /etc/shadow").is_err());
        let narrow = view(&["cat"], &["cat ~/.ssh/id_"]);
        assert!(enforce_command_policy(&narrow, "cat ~/.ssh/id_ed25519").is_err());
        assert!(enforce_command_policy(&narrow, "cat /etc/hostname").is_ok());
        // 허용 규칙은 토큰 앞머리로만 본다 — `sh`가 `shutdown`을 잡으면 안 된다.
        assert!(!matches_token_prefix(&["shutdown", "now"], "sh"));
        assert!(matches_token_prefix(&["sh", "-c", "x"], "sh"));
    }

    /// C9-20. 파이프라인은 **단계마다** 같은 목록을 지난다. 모든 단계가 허용 목록에 걸리면
    /// 승인 없이 지나가고, 한 단계라도 밖이면 그 줄이 통째로 멈춘다.
    #[test]
    fn c9_20_every_pipeline_stage_meets_the_same_policy() {
        let endpoint = view(
            &["journalctl", "grep", "head", "tail"],
            &["rm", "cat /etc/shadow"],
        );
        enforce_command_policy(
            &endpoint,
            "journalctl -u app -n 200 | grep -i error | head -n 20",
        )
        .expect("모든 단계가 허용 목록에 있다");
        // 마지막 단계만 목록 밖이어도 줄 전체가 멈추고, 이유는 그 단계를 이름으로 말한다.
        let error = enforce_command_policy(&endpoint, "journalctl -u app | wc -l")
            .expect_err("목록 밖 단계");
        assert!(error.to_string().contains("wc -l"), "{error}");
        // 차단은 어느 단계에서든 이긴다. 앞머리만 보면 이 줄이 `tail` 규칙으로 지나간다.
        assert!(
            enforce_command_policy(&endpoint, "tail -n 5 /var/log/app.log | rm -rf /srv").is_err()
        );
        // 하드 거부도 중간 단계에서 그대로 걸린다.
        assert!(enforce_command_policy(&endpoint, "grep -rn x /var/log | xargs rm").is_err());
        // 인용된 인자는 한 단어로 대조된다 — 규칙과 명령이 같은 경계를 읽는다.
        let quoted = view(&["grep -i"], &[]);
        enforce_command_policy(&quoted, "grep -i 'foo bar' /var/log/app.log").expect("인용 인자");
    }

    /// C9-20. 파일을 만드는 리다이렉션은 무제한 명령 허용을 켠 서버에서만 열린다. 읽기와
    /// 파이프 합치기는 원격에 아무것도 남기지 않으므로 어느 서버에서나 쓸 수 있다.
    #[test]
    fn c9_20_file_writing_redirection_needs_the_unrestricted_toggle() {
        let endpoint = view(&["app", "sort", "ls"], &[]);
        let error = enforce_command_policy(&endpoint, "ls > /etc/cron.d/x").expect_err("쓰기");
        assert!(error.to_string().contains("리다이렉션"), "{error}");
        assert!(enforce_command_policy(&endpoint, "app >> /tmp/out.log").is_err());
        enforce_command_policy(&endpoint, "sort < /srv/in.txt").expect("읽기");
        enforce_command_policy(&endpoint, "app --check 2>&1").expect("파이프 합치기");

        let mut open = endpoint.clone();
        open.unrestricted_commands = true;
        enforce_command_policy(&open, "ls > /tmp/out").expect("무제한이면 열린다");
    }

    /// 무제한 명령 허용을 켜면 허용 목록 대조와 승인 자리가 통째로 빠지고, 차단 목록과
    /// 셸·인터프리터·네트워크 페치 앞머리 거부만 남는다.
    #[test]
    fn unrestricted_endpoint_skips_the_allow_list_but_keeps_deny_and_hard_refusals() {
        let mut endpoint = view(&["ls"], &["rm -rf", "cat /etc/shadow"]);
        endpoint.unrestricted_commands = true;

        // 목록에 한 줄도 없는 명령이 승인 없이 지나간다.
        for command in ["systemctl restart app", "docker ps", "tar -xzf app.tgz"] {
            enforce_command_policy(&endpoint, command).expect(command);
        }
        // 차단 목록은 그대로다.
        assert!(enforce_command_policy(&endpoint, "rm -rf /srv/app").is_err());
        assert!(enforce_command_policy(&endpoint, "cat /etc/shadow").is_err());
        // 셸·인터프리터·네트워크 페치 앞머리도 그대로 거절된다.
        for command in ["bash -lc x", "curl example.com", "sudo bash"] {
            assert!(
                enforce_command_policy(&endpoint, command).is_err(),
                "{command}"
            );
        }
        // 허용 목록이 비어 있어도 무제한이면 실행한다 — 승인 자리가 아예 없다.
        let mut empty = view(&[], &["rm -rf"]);
        empty.unrestricted_commands = true;
        assert_eq!(
            command_allowance(
                &empty,
                &validate_remote_command("systemctl restart app").expect("parse")
            ),
            CommandAllowance::Allowed
        );
    }

    /// C9-14. 허용 목록이 비어 있으면 사용자가 명시한 명령이 없는 것이라 실행하지 않는다.
    /// 스킬 경로의 denylistOnly와 달리 앱이 대신 실행하는 경로는 열지 않는다.
    #[test]
    fn c9_execution_requires_a_non_empty_allow_list() {
        let open_policy = view(&[], &["rm -rf"]);
        assert!(open_policy.command_policy_mode().is_denylist_only());
        let error = enforce_command_policy(&open_policy, "ls /srv").expect_err("거절");
        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(error.to_string().contains("허용 명령"));
    }

    /// C9-15. 셸·인터프리터·네트워크 내려받기 앞머리는 허용 목록에 적혀 있어도 거절된다.
    /// 감싸는 앞머리 뒤의 실제 명령까지 본다 — 여기서 멈추면 `sudo sh -c`가 지나간다.
    #[test]
    fn c9_shell_and_fetch_heads_are_refused_even_when_the_user_allows_them() {
        let permissive = view(
            &[
                "sh", "bash", "curl", "wget", "python3", "sudo", "env", "xargs",
            ],
            &[],
        );
        for command in [
            "sh -c whoami",
            "bash /tmp/install.sh",
            "/bin/sh -c whoami",
            "curl https://example.com/install",
            "wget https://example.com/x.tgz",
            "python3 /tmp/x.py",
            "sudo sh -c whoami",
            "sudo env sh",
            "env PATH=/tmp sh",
            "xargs rm",
        ] {
            let error = enforce_command_policy(&permissive, command).expect_err(command);
            assert!(matches!(error, CoreError::Conflict(_)), "{command}");
        }
        // 권한 상승 자체는 사용자가 명시하면 지나간다 — 원격 설치를 막지 않기 위해서다.
        let installer = view(&["sudo systemctl restart", "sudo apt-get install"], &[]);
        enforce_command_policy(&installer, "sudo systemctl restart app").expect("설치 실행");
        // 기본 차단 목록에는 sudo가 있으므로 새 서버는 옵트인 전까지 지나가지 않는다.
        let defaults = crate::ssh_endpoints::command_policy_defaults();
        assert!(defaults.denied.contains(&"sudo".to_owned()));
        assert!(defaults.denied.contains(&"rm".to_owned()));
        for head in ["sudo", "bash", "sh", "curl", "wget", "rm"] {
            assert!(
                !defaults.allowed.iter().any(|rule| rule == head),
                "{head}은 기본 허용이면 안 됩니다"
            );
        }
        // 단위 이름에 우연히 겹치는 토큰은 앞머리가 아니라 거절 대상이 아니다.
        let reader = view(&["journalctl"], &[]);
        enforce_command_policy(&reader, "journalctl -u ssh -n 50").expect("단위 이름");
    }

    /// C9-14/C9-20. 명령을 잇거나 새로 만드는 문법은 실행 전에 거절한다. 이 검사가 없으면
    /// `ls; rm -rf /`가 `ls` 규칙으로 지나간다. 파이프·인용·글롭은 파서가 이해하므로 여기서
    /// 걸리지 않고, 그 줄들은 단계마다 정책 대조를 지난다.
    #[test]
    fn c9_command_joining_never_reaches_the_remote_shell() {
        for command in [
            "ls; rm -rf /",
            "ls && rm -rf /",
            "echo $(whoami)",
            "cat `id`",
            "ls\nrm -rf /",
            "ls {a,b}",
            "ls #x",
            "ls \\; rm",
        ] {
            assert!(
                validate_remote_command(command).is_err(),
                "{command} 는 거절돼야 합니다"
            );
        }
        assert!(validate_remote_command("   ").is_err());
        assert!(validate_remote_command(&"a".repeat(MAX_REMOTE_COMMAND_CHARS + 1)).is_err());
        // 파이프·인용·글롭은 이해하는 문법이라 여기서는 지나가고, 정본으로 다시 적힌다.
        for command in ["ls | wc -l", "ls 'a b'", "ls \"a\"", "ls *"] {
            validate_remote_command(command).unwrap_or_else(|error| panic!("{command}: {error:?}"));
        }
        // 공백은 하나로 접혀 규칙과 같은 모양으로 대조된다.
        assert_eq!(
            validate_remote_command("  systemctl   status   app  ")
                .expect("정규화")
                .render(),
            "systemctl status app"
        );
    }
}
