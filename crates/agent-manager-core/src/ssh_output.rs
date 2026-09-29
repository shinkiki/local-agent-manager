//! 원격 실행이 돌려준 텍스트를 응답에 싣기 전에 거르는 자리.
//!
//! `ssh_exec`는 접속·전송·승인 판정까지 한 파일에서 맡고 있었고, 그 끝자락에 "원격이
//! 돌려준 문구를 어떻게 걸러 싣는가"라는 전혀 다른 결의 규칙이 붙어 있었다. 이 규칙은
//! 접속 방식과 무관하게 G4 하나만 보고 판단하며(개인키 블록·토큰꼴 값은 어느 경로로도
//! 나가지 않는다), stderr 문구를 읽어 실패 원인을 가르는 판정도 여기에 함께 있다.
//! 실행 경로와 섞여 있으면 "무엇이 나가도 되는가"를 한눈에 볼 수 없으므로 갈라 둔다.

/// 실패 문구 한 문장에 실을 수 있는 길이 상한.
pub(crate) const MAX_MESSAGE_CHARS: usize = 400;
/// 표준 출력·오류를 응답에 실을 때의 상한. 원격 로그를 읽는 용도라 명령보다 넉넉하다.
pub(crate) const MAX_OUTPUT_CHARS: usize = 16_000;

fn mentions_host_key_failure(stderr: &str) -> bool {
    stderr.contains("Host key verification failed")
}

fn mentions_permission_denied(stderr: &str) -> bool {
    stderr.contains("Permission denied")
}

/// C9-19. 원격 `sudo`가 우리가 넘긴 비밀번호를 거절했는지. SSH 자체의 권한 거부
/// (`mentions_permission_denied`)와 구분해야 한다 — 이쪽만 들고 있던 값을 버리는 근거가
/// 되고, 저쪽은 키 문제라 값을 버려도 달라지지 않는다.
pub(crate) fn mentions_sudo_auth_failure(stderr: &str) -> bool {
    stderr.contains("Sorry, try again")
        || stderr.contains("incorrect password attempt")
        || stderr.contains("no password was provided")
        || stderr.contains("a password is required")
        || stderr.contains("authentication failure")
}

/// C9-19. `sudo -S`가 stderr에 남기는 비밀번호 프롬프트를 지운다.
///
/// 사용자가 입력한 값은 애초에 여기 실리지 않지만, `[sudo] password for ...:` 한 줄이
/// 그대로 올라오면 성공한 실행도 실패 진단처럼 읽힌다. 프롬프트는 **우리가 붙인 `-S`**
/// 때문에 생긴 것이라 사용자가 요청한 출력이 아니다. `-p ''`로 프롬프트를 끄는 길은
/// 인용을 쓰므로 원격 명령의 글자 집합 검사에 걸린다.
pub(crate) fn strip_sudo_prompt(stderr: &str) -> String {
    const MARKER: &str = "[sudo] password for ";
    let mut out = String::with_capacity(stderr.len());
    let mut rest = stderr;
    while let Some(start) = rest.find(MARKER) {
        out.push_str(&rest[..start]);
        let after = &rest[start + MARKER.len()..];
        let Some(colon) = after.find(':') else {
            // 프롬프트가 잘린 채 끝났다. 남은 조각도 프롬프트이므로 함께 버린다.
            return out;
        };
        let mut skip = colon + 1;
        if after[skip..].starts_with(' ') {
            skip += 1;
        }
        rest = &after[skip..];
    }
    out.push_str(rest);
    out
}

/// 원격에 그 지문 도구가 없는 경우인지. 파일이 없는 것과 구분해야 한다 — 구분하지 않으면
/// 없는 파일을 "원격에 도구가 없다"고 보고하게 된다. 셸마다 문구가 다르므로 둘 다 본다
/// (bash `command not found`, dash `sh: 1: sha256sum: not found`).
pub(crate) fn mentions_missing_command(stderr: &str) -> bool {
    stderr.contains("command not found")
        || stderr.contains("sha256sum: not found")
        || stderr.contains("shasum: not found")
}

/// 영수증이 `stderr` 한 벌에서 읽어 내는 값 전부. 실행·올리기·받기 세 영수증이 같은
/// 세 칸을 채우면서 각자 `stderr`를 다시 훑고 있었다. 세 자리가 따로 적혀 있으면 새
/// 실패 신호를 알아보게 고칠 때 한 자리를 빠뜨려 영수증마다 진단이 갈리므로, 읽어 내는
/// 일을 한 번으로 모은다.
pub(crate) struct OutcomeDiagnosis {
    /// 사용자와 에이전트가 다음 행동을 정하는 한 문장.
    pub(crate) message: String,
    /// known_hosts에 호스트 키가 없어 거절된 경우.
    pub(crate) host_key_rejected: bool,
    /// 서버가 이 키를 받아 주지 않은 경우.
    pub(crate) permission_denied: bool,
}

/// 실행 결과 하나를 영수증이 쓰는 진단 한 벌로 옮긴다.
pub(crate) fn diagnose_outcome(outcome: &crate::cli_interface::CommandOutcome) -> OutcomeDiagnosis {
    OutcomeDiagnosis {
        message: outcome_message(outcome.success, outcome.timed_out, &outcome.stderr),
        host_key_rejected: mentions_host_key_failure(&outcome.stderr),
        permission_denied: mentions_permission_denied(&outcome.stderr),
    }
}

/// 실행 결과를 한 문장으로 만든다. 실패 이유는 사용자와 에이전트가 다음에 무엇을 할지
/// 정하는 근거라 지우지 않되, 비밀값으로 보이는 값은 지운 뒤 길이를 자른다.
fn outcome_message(success: bool, timed_out: bool, stderr: &str) -> String {
    if success {
        return "실행에 성공했습니다".to_owned();
    }
    if timed_out {
        return "정해진 시간 안에 끝나지 않아 중단했습니다".to_owned();
    }
    let detail = redact(stderr);
    if detail.is_empty() {
        return "실행하지 못했습니다".to_owned();
    }
    if mentions_host_key_failure(stderr) {
        return format!(
            "{detail} — 이 호스트의 키가 known_hosts에 없습니다. 터미널에서 한 번 접속해 호스트 키를 확인한 뒤 다시 시도하세요"
        );
    }
    if mentions_permission_denied(stderr) {
        return format!(
            "{detail} — 서버의 authorized_keys에 이 키가 없습니다. 다른 키로 바꿔 시도하지 말고 사용자에게 알리세요"
        );
    }
    detail
}

/// PEM 키 블록을 지운다. 출력 본문은 사용자가 요청한 값이라 줄 모양을 지켜야 하지만,
/// 개인키 본문만은 어느 경로로도 나가지 않는다(G4) — 사용자가 `cat`을 허용해 둔 서버에서
/// 원격 파일을 읽었을 때가 그런 경우다.
pub(crate) fn strip_key_blocks(text: &str) -> String {
    let mut cleaned = String::with_capacity(text.len());
    let mut filter = KeyBlockFilter::default();
    for line in text.lines() {
        if let Some(visible) = filter.filter_line(line) {
            cleaned.push_str(&visible);
            cleaned.push('\n');
        }
    }
    cleaned
}

/// 줄 단위 키 블록 필터. 모아서 지우는 [`strip_key_blocks`]와 실시간으로 흘리는 경로가
/// 같은 판정을 쓰도록 상태를 한 곳에 둔다 — BEGIN 줄은 안내문 한 줄로 바뀌고, END까지의
/// 줄은 나가지 않는다.
#[derive(Default)]
pub(crate) struct KeyBlockFilter {
    skipping: bool,
}

impl KeyBlockFilter {
    pub(crate) fn filter_line(&mut self, line: &str) -> Option<String> {
        if line.contains("-----BEGIN") {
            self.skipping = true;
            return Some("[생략된 키 블록]".to_owned());
        }
        if self.skipping {
            if line.contains("-----END") {
                self.skipping = false;
            }
            return None;
        }
        Some(line.to_owned())
    }
}

/// 진단 한 문장. 키 블록을 지운 뒤 줄을 합치고, 긴 토큰꼴 값까지 지운 다음 길이를 자른다.
/// 원격 로그가 무엇을 담고 있을지는 앱이 알 수 없으므로 본문보다 강하게 거른다(G4).
pub(crate) fn redact(text: &str) -> String {
    let mut cleaned = String::new();
    for line in strip_key_blocks(text).lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !cleaned.is_empty() {
            cleaned.push_str(" / ");
        }
        cleaned.push_str(&mask_long_tokens(trimmed));
    }
    cleaned.chars().take(MAX_MESSAGE_CHARS).collect()
}

/// 40자 이상 이어지는 base64·hex꼴 토큰을 지운다. 토큰·서명·키 본문이 이 모양으로 온다.
fn mask_long_tokens(line: &str) -> String {
    line.split(' ')
        .map(|token| {
            let body = token.trim_matches(|value: char| !value.is_ascii_alphanumeric());
            let secretish = body.chars().count() >= 40
                && body
                    .chars()
                    .all(|value| value.is_ascii_alphanumeric() || matches!(value, '+' | '/' | '='));
            if secretish {
                "[생략된 값]".to_owned()
            } else {
                token.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 출력을 상한까지 자르고 잘렸는지 함께 돌려준다.
pub(crate) fn cap_output(text: &str) -> (String, bool) {
    if text.chars().count() <= MAX_OUTPUT_CHARS {
        return (text.to_owned(), false);
    }
    (text.chars().take(MAX_OUTPUT_CHARS).collect(), true)
}

#[cfg(test)]
mod tests {

    /// C9-19. 우리가 붙인 `-S` 때문에 생긴 프롬프트는 사용자가 요청한 출력이 아니다.
    /// 남겨 두면 성공한 실행도 실패 진단처럼 읽힌다.
    #[test]
    fn c9_19_strips_the_sudo_prompt_from_stderr() {
        assert_eq!(
            strip_sudo_prompt("[sudo] password for manualsAdmin: done\n"),
            "done\n"
        );
        // 프롬프트만 있던 stderr는 비워진다 — 그래야 성공이 성공으로 읽힌다.
        assert_eq!(strip_sudo_prompt("[sudo] password for root: "), "");
        // 진짜 진단은 남는다.
        assert_eq!(
            strip_sudo_prompt("[sudo] password for root: Sorry, try again.\n"),
            "Sorry, try again.\n"
        );
        // 프롬프트가 없으면 그대로 둔다.
        assert_eq!(strip_sudo_prompt("boom\n"), "boom\n");
    }

    /// C9-19. 값을 버릴 근거는 sudo가 거절한 경우로 좁힌다. SSH 자체의 권한 거부는 키
    /// 문제라 들고 있던 비밀번호를 버려도 달라지지 않는다.
    #[test]
    fn c9_19_tells_a_rejected_password_apart_from_an_ssh_permission_failure() {
        assert!(mentions_sudo_auth_failure("Sorry, try again.\n"));
        assert!(mentions_sudo_auth_failure("sudo: a password is required\n"));
        assert!(mentions_sudo_auth_failure(
            "sudo: 1 incorrect password attempt\n"
        ));
        assert!(!mentions_sudo_auth_failure(
            "Permission denied (publickey).\n"
        ));
        assert!(!mentions_sudo_auth_failure("boom\n"));
    }
    use super::*;

    /// C9-16. 원격이 돌려준 문구는 PEM 블록과 긴 토큰꼴 값을 지운 뒤 길이를 잘라 싣는다.
    #[test]
    fn c9_remote_output_never_carries_key_material() {
        let noisy = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\ntoken=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK\nreal error";
        let cleaned = redact(noisy);
        assert!(!cleaned.contains("BEGIN OPENSSH"));
        assert!(!cleaned.contains("b3BlbnNzaC1rZXktdjEAAAAA"));
        assert!(!cleaned.contains("AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK"));
        assert!(cleaned.contains("[생략된 키 블록]"));
        assert!(cleaned.contains("[생략된 값]"));
        assert!(cleaned.contains("real error"));
        assert!(redact(&"x".repeat(MAX_MESSAGE_CHARS * 2)).chars().count() <= MAX_MESSAGE_CHARS);

        // 출력 본문은 줄 모양을 지키되 키 블록만은 빼낸다. 사용자가 요청한 값을 토큰처럼
        // 보인다는 이유로 지우면 정상 출력이 망가진다.
        let body = strip_key_blocks(noisy);
        assert!(!body.contains("b3BlbnNzaC1rZXktdjEAAAAA"));
        assert!(body.contains("[생략된 키 블록]"));
        assert!(body.contains("token=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK"));
        assert_eq!(strip_key_blocks("a\nb\n"), "a\nb\n");

        // 없는 파일과 없는 도구를 구분한다. 구분하지 않으면 없는 파일이 "도구 없음"으로
        // 보고돼 사용자가 원격에 도구를 깔러 간다.
        assert!(mentions_missing_command("sh: sha256sum: command not found"));
        assert!(mentions_missing_command("sh: 1: sha256sum: not found"));
        assert!(!mentions_missing_command(
            "sha256sum: /srv/x: No such file or directory"
        ));

        let (capped, truncated) = cap_output(&"y".repeat(MAX_OUTPUT_CHARS + 10));
        assert!(truncated);
        assert_eq!(capped.chars().count(), MAX_OUTPUT_CHARS);
        assert_eq!(cap_output("short"), ("short".to_owned(), false));
    }

    /// 실패 문구는 stderr가 가리키는 원인에 따라 다음 행동까지 알려 준다.
    #[test]
    fn outcome_message_names_the_next_step_for_known_failures() {
        assert_eq!(
            outcome_message(true, false, "ignored"),
            "실행에 성공했습니다"
        );
        assert_eq!(
            outcome_message(false, true, "ignored"),
            "정해진 시간 안에 끝나지 않아 중단했습니다"
        );
        assert_eq!(outcome_message(false, false, "   "), "실행하지 못했습니다");
        assert!(
            outcome_message(false, false, "Host key verification failed").contains("known_hosts")
        );
        assert!(
            outcome_message(false, false, "Permission denied (publickey).")
                .contains("authorized_keys")
        );
    }
}
