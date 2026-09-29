//! OS 보안 저장소(Keychain) 접근. 자격증명 Vault·외부 플러그인 토큰·DB 접속 비밀번호가
//! 모두 이 한 통로로 OS 저장소를 읽고 쓴다.
//!
//! macOS는 `keyring` 크레이트 대신 `/usr/bin/security`를 직접 띄운다. 크레이트가 쓰는
//! 시스템 API는 앱이 서명을 바꾸면 기존 항목을 못 읽고, 응답이 늦을 때 마감 시한도 걸 수
//! 없다. 그 대가로 자식 프로세스의 마감·파이프·비밀 소거를 이 모듈이 직접 다뤄야 해서,
//! 분량이 계정 관리(`accounts`)의 본래 관심사를 덮고 있었다. 여기로 갈라 두면 계정 쪽은
//! "어느 계정의 무엇을 저장하는가"만 보고, 이 모듈이 "OS에 어떻게 닿는가"만 본다.
//!
//! 비밀은 `Zeroizing`으로만 들고 다니며, 실패 문구에 인자나 응답 본문을 싣지 않는다(`C4-8`).

#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::io::{Read, Write};
#[cfg(target_os = "macos")]
use std::os::unix::process::CommandExt;
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(target_os = "macos")]
use std::process::{Child, Command, ExitStatus, Stdio};
#[cfg(target_os = "macos")]
use std::thread;
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

#[cfg(not(target_os = "macos"))]
use keyring::Entry;
#[cfg(target_os = "macos")]
use zeroize::Zeroize;
use zeroize::Zeroizing;

#[cfg(target_os = "macos")]
use crate::credential_profiles;
use crate::CoreError;

#[cfg(target_os = "macos")]
const MACOS_SECURITY_BIN: &str = "/usr/bin/security";
#[cfg(target_os = "macos")]
// 유휴 시 security 호출은 0.4초 안팎이지만, 빌드·인덱싱 등 부하가 걸리면 수 초까지
// 늘어난다. 3초에서는 계정 전환·복구가 부하 시점에 실패해 recovery 오류가 남았다.
pub(crate) const KEYCHAIN_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
#[cfg(target_os = "macos")]
const KEYCHAIN_COMMAND_POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(target_os = "macos")]
const MAX_KEYCHAIN_COMMAND_OUTPUT_BYTES: u64 = 1024 * 1024;

#[cfg(not(target_os = "macos"))]
fn vault_error(prefix: &'static str) -> impl FnOnce(keyring::Error) -> CoreError {
    move |error| CoreError::Runtime(format!("{prefix}: {error}"))
}

#[cfg(target_os = "macos")]
pub(crate) struct MacosSecurityOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Zeroizing<Vec<u8>>,
    stderr: Zeroizing<Vec<u8>>,
}

#[cfg(target_os = "macos")]
fn validate_keychain_target(service: &str, account: &str) -> Result<(), CoreError> {
    validate_keychain_field(service, "service")?;
    validate_keychain_field(account, "account")
}

#[cfg(target_os = "macos")]
fn validate_keychain_field(value: &str, field: &str) -> Result<(), CoreError> {
    if value.is_empty() || value.len() > 1024 || value.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(format!(
            "Keychain {field} 값이 올바르지 않습니다"
        )));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_security_executable() -> Result<PathBuf, CoreError> {
    let executable = fs::canonicalize(MACOS_SECURITY_BIN).map_err(|error| {
        CoreError::Runtime(format!(
            "macOS security 도구를 확인하지 못했습니다: {error}"
        ))
    })?;
    if !executable.is_file() {
        return Err(CoreError::Runtime(
            "macOS security 도구가 실행 파일이 아닙니다".to_owned(),
        ));
    }
    Ok(executable)
}

/// 홈을 가른 프로필에 그 계정 전용 키체인을 만든다(`C12`).
///
/// macOS 키체인은 검색 목록을 `$HOME/Library/Keychains`에서 얻는다. 홈을 가르면 그 자리가
/// 비어 있어, Antigravity CLI가 로그인 토큰을 키체인에 저장하려는 순간 "저장할 키체인을
/// 찾을 수 없습니다" 모달이 떠 로그인이 통째로 멈춘다. 이 CLI는 키체인을 1순위로 쓰고 파일
/// 저장은 키체인 호출이 **시간 초과**로 끝날 때만 쓰는 폴백이라, 사람이 답해 버리는 모달은
/// 폴백을 부르지도 않는다 — 토큰이 어디에도 남지 않는다(2026-09-17 실측).
///
/// 공유 홈의 키체인을 링크하면 모달은 사라지지만 계정들이 같은 항목 하나를 두고 다투므로
/// 격리가 되레 깨진다. 그래서 프로필마다 자기 키체인을 만든다. 사용자의 로그인 키체인에는
/// 아무것도 들어가지 않는다.
#[cfg(target_os = "macos")]
pub(crate) fn ensure_profile_keychain(profile_home: &Path) -> Result<(), CoreError> {
    let keychain = profile_home.join("Library/Keychains/login.keychain-db");
    if keychain.exists() {
        return Ok(());
    }
    let directory = keychain
        .parent()
        .ok_or_else(|| CoreError::Runtime("프로필 키체인 경로가 올바르지 않습니다".to_owned()))?;
    fs::create_dir_all(directory)?;
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    }
    let security = macos_security_executable()?;
    let path = keychain.to_string_lossy().into_owned();
    // 빈 암호로 만든다. 이 값은 비밀이 아니므로 인자에 실려도 노출이 아니고, 암호를 두면
    // CLI가 접근할 때마다 잠금 해제 창이 떠 로그인이 다시 멈춘다.
    run_profile_security(
        &security,
        profile_home,
        &["create-keychain", "-p", "", &path],
    )?;
    // 자동 잠금을 끈다. 기본값(5분·절전 시 잠금)으로 두면 잠긴 뒤 접근할 때 암호 창이 뜬다.
    run_profile_security(&security, profile_home, &["set-keychain-settings", &path])?;
    Ok(())
}

/// 프로필 홈을 `HOME`으로 둔 `security` 실행 한 번. 키체인 준비 전용이라 비밀을 주고받지
/// 않으며, 실패 문구에도 인자를 싣지 않는다(`C4-8`).
#[cfg(target_os = "macos")]
fn run_profile_security(
    security: &Path,
    profile_home: &Path,
    args: &[&str],
) -> Result<(), CoreError> {
    let mut command = Command::new(security);
    command.args(args).env("HOME", profile_home);
    credential_profiles::strip_inherited_credential_env(&mut command);
    crate::chat::configure_no_window_command(&mut command);
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            CoreError::Runtime(format!("프로필 키체인을 준비하지 못했습니다: {error}"))
        })?;
    if !status.success() {
        return Err(CoreError::Runtime(
            "프로필 키체인을 준비하지 못했습니다".to_owned(),
        ));
    }
    Ok(())
}

/// 키체인이 없는 플랫폼에서는 준비할 것이 없다.
#[cfg(not(target_os = "macos"))]
pub(crate) fn ensure_profile_keychain(_profile_home: &Path) -> Result<(), CoreError> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn read_bounded_command_output(
    mut stream: impl Read + Send + 'static,
) -> thread::JoinHandle<Result<Vec<u8>, std::io::Error>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        stream
            .by_ref()
            .take(MAX_KEYCHAIN_COMMAND_OUTPUT_BYTES + 1)
            .read_to_end(&mut output)?;
        if output.len() as u64 > MAX_KEYCHAIN_COMMAND_OUTPUT_BYTES {
            output.zeroize();
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "security command output exceeded the limit",
            ));
        }
        Ok(output)
    })
}

#[cfg(target_os = "macos")]
struct MacosSecurityReaders {
    stdout: thread::JoinHandle<Result<Vec<u8>, std::io::Error>>,
    stderr: thread::JoinHandle<Result<Vec<u8>, std::io::Error>>,
}

#[cfg(target_os = "macos")]
impl MacosSecurityReaders {
    /// 자식이 정상 종료하지 못한 모든 경로가 공유하는 정리 절차. 프로세스를 죽이고
    /// 두 읽기 스레드를 회수해야 파이프가 닫히고 스레드가 남지 않는다.
    fn abort(self, child: &mut Child, message: &str) -> CoreError {
        let _ = child.kill();
        let _ = child.wait();
        let _ = self.stdout.join();
        let _ = self.stderr.join();
        CoreError::Runtime(message.to_owned())
    }

    fn finish(self, status: ExitStatus) -> Result<MacosSecurityOutput, CoreError> {
        let stdout = join_bounded_command_output(self.stdout, "출력")?;
        let stderr = join_bounded_command_output(self.stderr, "오류")?;
        Ok(MacosSecurityOutput {
            status,
            stdout,
            stderr,
        })
    }
}

#[cfg(target_os = "macos")]
fn join_bounded_command_output(
    reader: thread::JoinHandle<Result<Vec<u8>, std::io::Error>>,
    label: &str,
) -> Result<Zeroizing<Vec<u8>>, CoreError> {
    let bytes = reader
        .join()
        .map_err(|_| CoreError::Runtime(format!("security {label} 처리가 중단되었습니다")))?
        .map_err(|_| CoreError::Runtime(format!("security {label}을 읽지 못했습니다")))?;
    Ok(Zeroizing::new(bytes))
}

#[cfg(target_os = "macos")]
fn spawn_macos_security(
    executable: &Path,
    args: &[&str],
    secret_stdin: Option<&str>,
) -> Result<(Child, MacosSecurityReaders), CoreError> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(if secret_stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // SAFETY: `setsid` is the only operation performed between fork and exec.
    // Detaching the controlling terminal makes `security ... -w` consume the
    // piped stdin instead of opening `/dev/tty` during `tauri dev`.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!(
            "macOS security 도구를 실행하지 못했습니다: {error}"
        ))
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| CoreError::Runtime("security 표준 출력을 열지 못했습니다".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| CoreError::Runtime("security 오류 출력을 열지 못했습니다".to_owned()))?;
    let readers = MacosSecurityReaders {
        stdout: read_bounded_command_output(stdout),
        stderr: read_bounded_command_output(stderr),
    };
    Ok((child, readers))
}

/// 실패 이유를 구분하지 않는다. 호출부는 어느 단계에서 막혔든 같은 정리와 같은
/// 메시지로 끝내므로, 비밀을 오류 문자열에 실어 나르지 않는다.
#[cfg(target_os = "macos")]
fn send_macos_security_stdin(child: &mut Child, secret: &str) -> Result<(), ()> {
    let mut stdin = child.stdin.take().ok_or(())?;
    stdin.write_all(secret.as_bytes()).map_err(|_| ())?;
    stdin.write_all(b"\n").map_err(|_| ())?;
    stdin.flush().map_err(|_| ())
}

/// 시한 안에 끝나면 `Some(상태)`, 시한을 넘기면 `Some` 없이 돌아온다. 정리는
/// 호출부가 `MacosSecurityReaders::abort`로 한다.
#[cfg(target_os = "macos")]
fn await_macos_security_exit(
    child: &mut Child,
    timeout: Duration,
) -> Result<Option<ExitStatus>, CoreError> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().map_err(|error| {
            CoreError::Runtime(format!(
                "macOS security 상태를 확인하지 못했습니다: {error}"
            ))
        })? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        thread::sleep(KEYCHAIN_COMMAND_POLL_INTERVAL);
    }
}

#[cfg(target_os = "macos")]
fn run_macos_security_with_executable(
    executable: &Path,
    args: &[&str],
    secret_stdin: Option<&str>,
    timeout: Duration,
) -> Result<MacosSecurityOutput, CoreError> {
    let (mut child, readers) = spawn_macos_security(executable, args, secret_stdin)?;
    if let Some(secret) = secret_stdin {
        if send_macos_security_stdin(&mut child, secret).is_err() {
            return Err(readers.abort(&mut child, "security 보안 입력을 전달하지 못했습니다"));
        }
    }
    let status = match await_macos_security_exit(&mut child, timeout)? {
        Some(status) => status,
        None => return Err(readers.abort(&mut child, "macOS security 응답 시간이 초과되었습니다")),
    };
    readers.finish(status)
}

#[cfg(target_os = "macos")]
pub(crate) fn run_macos_security(
    args: &[&str],
    secret_stdin: Option<&str>,
    timeout: Duration,
) -> Result<MacosSecurityOutput, CoreError> {
    run_macos_security_with_executable(&macos_security_executable()?, args, secret_stdin, timeout)
}

/// 세 Keychain 명령이 같은 모양으로 적던 실패 메시지. `subject`는 조사까지 포함한다.
#[cfg(target_os = "macos")]
pub(crate) fn macos_keychain_failure(subject: &str, output: &MacosSecurityOutput) -> CoreError {
    CoreError::Runtime(format!(
        "macOS Keychain {subject} 실패했습니다 (종료 코드 {})",
        output.status.code().unwrap_or(-1)
    ))
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_keychain_item_not_found(output: &MacosSecurityOutput) -> bool {
    if output.status.code() == Some(44) {
        return true;
    }
    let stderr = Zeroizing::new(String::from_utf8_lossy(&output.stderr).to_ascii_lowercase());
    stderr.contains("could not be found") || stderr.contains("not be found")
}

#[cfg(target_os = "macos")]
pub(crate) fn read_os_keychain_password(
    service: &str,
    account: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    read_os_keychain_password_with_timeout(service, account, KEYCHAIN_COMMAND_TIMEOUT)
}

#[cfg(target_os = "macos")]
pub(crate) fn read_os_keychain_password_with_timeout(
    service: &str,
    account: &str,
    timeout: Duration,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    validate_keychain_target(service, account)?;
    let output = run_macos_security(
        &["find-generic-password", "-s", service, "-a", account, "-w"],
        None,
        timeout,
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
                "macOS Keychain 값이 UTF-8이 아닙니다".to_owned(),
            ))
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn read_keyring_entry(
    service: &str,
    account: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    let entry =
        Entry::new(service, account).map_err(vault_error("OS 보안 저장소를 열지 못했습니다"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(Zeroizing::new(value))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(CoreError::Runtime(format!(
            "OS 보안 저장소를 읽지 못했습니다: {error}"
        ))),
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn write_os_keychain_password(
    service: &str,
    account: &str,
    secret: &str,
) -> Result<(), CoreError> {
    write_macos_keychain_password_with_executable(
        &macos_security_executable()?,
        service,
        account,
        secret,
    )
}

#[cfg(target_os = "macos")]
fn write_macos_keychain_password_with_executable(
    executable: &Path,
    service: &str,
    account: &str,
    secret: &str,
) -> Result<(), CoreError> {
    validate_keychain_target(service, account)?;
    if secret
        .as_bytes()
        .iter()
        .any(|byte| matches!(byte, b'\r' | b'\n'))
    {
        return Err(CoreError::InvalidInput(
            "macOS Keychain에 저장할 값은 단일 행이어야 합니다".to_owned(),
        ));
    }
    let output = run_macos_security_with_executable(
        executable,
        &[
            "add-generic-password",
            "-U",
            "-s",
            service,
            "-a",
            account,
            "-w",
            secret,
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
fn write_keyring_entry(service: &str, account: &str, secret: &str) -> Result<(), CoreError> {
    Entry::new(service, account)
        .map_err(vault_error("OS 보안 저장소를 열지 못했습니다"))?
        .set_password(secret)
        .map_err(vault_error("OS 보안 저장소에 저장하지 못했습니다"))
}

#[cfg(target_os = "macos")]
pub(crate) fn delete_os_keychain_password(service: &str, account: &str) -> Result<(), CoreError> {
    validate_keychain_target(service, account)?;
    let output = run_macos_security(
        &["delete-generic-password", "-s", service, "-a", account],
        None,
        KEYCHAIN_COMMAND_TIMEOUT,
    )?;
    if output.status.success() || macos_keychain_item_not_found(&output) {
        Ok(())
    } else {
        Err(macos_keychain_failure("삭제가", &output))
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_keyring_entry(service: &str, account: &str) -> Result<(), CoreError> {
    match Entry::new(service, account)
        .map_err(vault_error("OS 보안 저장소를 열지 못했습니다"))?
        .delete_credential()
    {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(CoreError::Runtime(format!(
            "OS 보안 저장소에서 삭제하지 못했습니다: {error}"
        ))),
    }
}

/// 다른 프로그램이 OS 보안 저장소에 남긴 항목이 **있는지만** 본다. 값은 이 함수 밖으로
/// 나가지 않는다 — 부르는 쪽에 필요한 것은 "로그인이 있는가"뿐이고, 내용은 판정에 쓰이지
/// 않는다(`G4`).
///
/// 항목 이름 규칙이 우리 것과 다르다. macOS(`security`)와 Secret Service는 service/account
/// 짝으로 찾으므로 그 두 인자가 곧 규칙이지만, Windows 자격 증명 관리자는 대상 이름 하나가
/// 유일한 열쇠라 `keyring`의 기본 이름(`{account}.{service}`)으로는 다른 규칙으로 만들어진
/// 항목을 찾지 못한다. 그래서 대상 이름을 따로 받는다.
///
/// 저장소를 읽지 못한 것과 항목이 없는 것은 다르다. 앞쪽은 오류로 올려, 부르는 쪽이
/// "없음"으로 단정하지 않게 한다.
#[cfg(target_os = "macos")]
pub(crate) fn foreign_secret_present(
    service: &str,
    account: &str,
    _windows_target: &str,
) -> Result<bool, CoreError> {
    Ok(read_os_keychain_password(service, account)?.is_some())
}

/// 같은 항목의 값. 존재 확인과 한 통로를 쓰되, 값이 필요한 자리만 이쪽을 부른다.
#[cfg(target_os = "macos")]
pub(crate) fn read_foreign_secret(
    service: &str,
    account: &str,
    _windows_target: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    read_os_keychain_password(service, account)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_foreign_secret(
    service: &str,
    account: &str,
    windows_target: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    let entry = foreign_keyring_entry(service, account, windows_target)
        .map_err(vault_error("OS 보안 저장소를 열지 못했습니다"))?;
    match entry.get_secret() {
        Ok(bytes) => {
            let bytes = Zeroizing::new(bytes);
            match std::str::from_utf8(&bytes) {
                Ok(text) => Ok(Some(Zeroizing::new(text.to_owned()))),
                Err(_) => Err(CoreError::Runtime(
                    "OS 보안 저장소 값이 UTF-8이 아닙니다".to_owned(),
                )),
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(CoreError::Runtime(format!(
            "OS 보안 저장소를 읽지 못했습니다: {error}"
        ))),
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn foreign_secret_present(
    service: &str,
    account: &str,
    windows_target: &str,
) -> Result<bool, CoreError> {
    let entry = foreign_keyring_entry(service, account, windows_target)
        .map_err(vault_error("OS 보안 저장소를 열지 못했습니다"))?;
    // 바이트로 받는다. `get_password`는 값을 그 플랫폼의 문자열 규약으로 풀어 보는데, 남이
    // 만든 항목은 그 규약을 따를 이유가 없다 — Windows 자격 증명 관리자에서 `keyring`은
    // blob을 UTF-16으로 읽지만 `agy`(Go `go-keyring`)는 UTF-8 바이트를 그대로 넣어서,
    // 항목을 찾고도 `Data is not UTF-8 encoded`로 실패했다(2026-09-24 실측). 존재만 보는
    // 자리에서 값을 해석할 까닭이 없다.
    match entry.get_secret() {
        // 값은 여기서 지워진다. 조각난 문서(`KEYCHAIN_CHUNK_MARKER`)인지도 따지지 않는다 —
        // 조각내 쓰는 것은 우리 Vault뿐이고, 여기서 보는 항목은 남의 것이다.
        Ok(value) => {
            drop(Zeroizing::new(value));
            Ok(true)
        }
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(CoreError::Runtime(format!(
            "OS 보안 저장소를 읽지 못했습니다: {error}"
        ))),
    }
}

/// 다른 프로그램이 남긴 항목을 지운다. 없으면 `Ok(false)`, 지웠으면 `Ok(true)`. 값은 읽지
/// 않는다 — 지우기 전에 볼트로 들어올리는 일은 부르는 쪽(`accounts`)이 따로 끝낸다(C12-11).
#[cfg(target_os = "macos")]
pub(crate) fn delete_foreign_secret(
    service: &str,
    account: &str,
    _windows_target: &str,
) -> Result<bool, CoreError> {
    let present = read_os_keychain_password(service, account)?.is_some();
    if present {
        delete_os_keychain_password(service, account)?;
    }
    Ok(present)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn delete_foreign_secret(
    service: &str,
    account: &str,
    windows_target: &str,
) -> Result<bool, CoreError> {
    let entry = foreign_keyring_entry(service, account, windows_target)
        .map_err(vault_error("OS 보안 저장소를 열지 못했습니다"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(CoreError::Runtime(format!(
            "OS 보안 저장소에서 삭제하지 못했습니다: {error}"
        ))),
    }
}

#[cfg(target_os = "windows")]
fn foreign_keyring_entry(
    service: &str,
    account: &str,
    windows_target: &str,
) -> Result<Entry, keyring::Error> {
    Entry::new_with_target(windows_target, service, account)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn foreign_keyring_entry(
    service: &str,
    account: &str,
    _windows_target: &str,
) -> Result<Entry, keyring::Error> {
    Entry::new(service, account)
}

/// 한 항목에 담을 UTF-16 코드 단위 상한. Windows 자격 증명 관리자는 값 하나를
/// `CRED_MAX_CREDENTIAL_BLOB_SIZE`(2,560바이트)까지만 받고, `keyring`은 그 한도를 저장 형식인
/// UTF-16으로 환산해 코드 단위 1,280개로 검사한다. 자격증명 Vault는 등록된 계정 전부의 공급자
/// 토큰을 담는 **문서 하나**라 계정이 한둘만 늘어도 이 한도를 넘어서고, 그 순간 저장이 통째로
/// 막힌다(`Attribute 'password encoded as UTF-16' is longer than platform limit of 2560 chars`).
/// 값을 줄일 수는 없다 — 토큰 길이는 공급자가 정한다 — 그래서 Windows에서만 문서를 조각내 여러
/// 항목에 나눠 쓴다. 비밀은 여전히 OS 보안 저장소 밖으로 나가지 않는다(`G4`).
///
/// 한도가 없는 다른 keyring 플랫폼(Linux Secret Service)은 `None`으로 두어 지금까지처럼 한
/// 항목에 통째로 쓴다. 조각내 봐야 항목만 늘고 얻는 것이 없다.
#[cfg(target_os = "windows")]
const KEYCHAIN_ENTRY_UTF16_LIMIT: Option<usize> = Some(1_000);
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const KEYCHAIN_ENTRY_UTF16_LIMIT: Option<usize> = None;

/// 머리 항목이 조각난 문서임을 알리는 표식. 뒤에 `<세대>:<조각 수>`가 붙는다. 이 자리에 오던
/// 비밀은 모두 JSON 문서라 `{`로 시작하므로, 표식과 겹쳐 평범한 값이 안내로 읽힐 일은 없다.
#[cfg(not(target_os = "macos"))]
const KEYCHAIN_CHUNK_MARKER: &str = "agent-manager-keychain-chunks-v1:";
/// 조각 수 상한. 1,000 코드 단위 × 512 = 512,000자로, 계정을 아무리 늘려도 닿지 않는다.
#[cfg(not(target_os = "macos"))]
const MAX_KEYCHAIN_CHUNKS: usize = 512;

/// 조각 읽기·쓰기·삭제가 실제 OS 저장소에 닿는 자리. 조각을 놓는 순서 자체는 OS 없이 검증할
/// 수 있어야 해서 한 겹 가른다 — 순서를 틀리면 반쯤 쓰인 문서가 읽히는데, 그건 실기기에서
/// 가장 늦게 드러나는 종류의 오류다.
#[cfg(not(target_os = "macos"))]
trait KeychainEntries {
    fn read(&self, service: &str, account: &str) -> Result<Option<Zeroizing<String>>, CoreError>;
    fn write(&self, service: &str, account: &str, secret: &str) -> Result<(), CoreError>;
    fn delete(&self, service: &str, account: &str) -> Result<(), CoreError>;
}

#[cfg(not(target_os = "macos"))]
struct OsKeyringEntries;

#[cfg(not(target_os = "macos"))]
impl KeychainEntries for OsKeyringEntries {
    fn read(&self, service: &str, account: &str) -> Result<Option<Zeroizing<String>>, CoreError> {
        read_keyring_entry(service, account)
    }

    fn write(&self, service: &str, account: &str, secret: &str) -> Result<(), CoreError> {
        write_keyring_entry(service, account, secret)
    }

    fn delete(&self, service: &str, account: &str) -> Result<(), CoreError> {
        delete_keyring_entry(service, account)
    }
}

/// 조각이 들어가는 항목 이름. `#`은 Vault 계정명에도, 플러그인 id에도, DB 접속 id에도 쓰이지
/// 않으므로 원래 항목 이름과 부딪히지 않는다.
#[cfg(not(target_os = "macos"))]
fn keychain_chunk_account(account: &str, generation: u64, index: usize) -> String {
    format!("{account}#chunk-{generation}-{index}")
}

#[cfg(not(target_os = "macos"))]
fn keychain_chunk_header(generation: u64, count: usize) -> String {
    format!("{KEYCHAIN_CHUNK_MARKER}{generation}:{count}")
}

/// 머리 항목이 조각 안내면 `(세대, 조각 수)`를, 평범한 값이면 `None`을 준다. 표식으로
/// 시작하는데 뒤를 읽지 못하면 값을 비밀로 돌려주지 않고 실패한다 — 그 자리는 비밀이 아니라
/// 안내였고, 안내를 비밀로 착각하면 깨진 토큰이 공급자에게 그대로 건네진다.
#[cfg(not(target_os = "macos"))]
fn parse_keychain_chunk_header(value: &str) -> Result<Option<(u64, usize)>, CoreError> {
    let Some(rest) = value.strip_prefix(KEYCHAIN_CHUNK_MARKER) else {
        return Ok(None);
    };
    let parsed = rest.split_once(':').and_then(|(generation, count)| {
        let generation = generation.parse::<u64>().ok()?;
        let count = count.parse::<usize>().ok()?;
        (1..=MAX_KEYCHAIN_CHUNKS)
            .contains(&count)
            .then_some((generation, count))
    });
    parsed.map(Some).ok_or_else(|| {
        CoreError::Runtime("OS 보안 저장소의 자격증명 조각 안내를 읽지 못했습니다".to_owned())
    })
}

/// UTF-16 코드 단위로 세어 `limit`을 넘지 않게 자른다. 문자 경계에서만 자르므로 순서대로 이어
/// 붙이면 원문과 같고, 코드 단위 두 개짜리 문자가 조각 경계에서 쪼개지지 않는다.
#[cfg(not(target_os = "macos"))]
fn split_keychain_secret(secret: &str, limit: usize) -> Vec<&str> {
    debug_assert!(
        limit >= 2,
        "코드 단위 두 개짜리 문자가 들어갈 자리는 있어야 한다"
    );
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut units = 0usize;
    for (offset, character) in secret.char_indices() {
        let width = character.len_utf16();
        if units + width > limit && offset > start {
            parts.push(&secret[start..offset]);
            start = offset;
            units = 0;
        }
        units += width;
    }
    parts.push(&secret[start..]);
    parts
}

/// `generation` 세대의 조각을 `from` 번째부터 지운다. `known_count`까지는 있는 것이 확실한
/// 대상이고, 그 뒤는 앞선 시도가 남겨 둔 찌꺼기일 수 있어 없는 항목을 만날 때까지만 더 훑는다.
/// 비밀 조각을 저장소에 남겨 두지 않기 위한 정리다.
#[cfg(not(target_os = "macos"))]
fn prune_keychain_chunks(
    entries: &dyn KeychainEntries,
    service: &str,
    account: &str,
    generation: u64,
    from: usize,
    known_count: usize,
) -> Result<(), CoreError> {
    for index in from..MAX_KEYCHAIN_CHUNKS {
        let chunk = keychain_chunk_account(account, generation, index);
        if index >= known_count && entries.read(service, &chunk)?.is_none() {
            break;
        }
        entries.delete(service, &chunk)?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn read_chunked_secret(
    entries: &dyn KeychainEntries,
    service: &str,
    account: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    let Some(head) = entries.read(service, account)? else {
        return Ok(None);
    };
    let Some((generation, count)) = parse_keychain_chunk_header(&head)? else {
        return Ok(Some(head));
    };
    let mut parts = Vec::with_capacity(count);
    for index in 0..count {
        let chunk = keychain_chunk_account(account, generation, index);
        let part = entries.read(service, &chunk)?.ok_or_else(|| {
            CoreError::Runtime("OS 보안 저장소의 자격증명 조각이 없습니다".to_owned())
        })?;
        parts.push(part);
    }
    // 전체 길이를 미리 잡아 두어, 이어 붙이는 동안의 재할당이 비밀 사본을 힙에 흘리지 않게
    // 한다. 조각들은 `Zeroizing`이라 이 함수를 벗어날 때 지워진다.
    let total = parts.iter().map(|part| part.len()).sum();
    let mut joined = Zeroizing::new(String::with_capacity(total));
    for part in &parts {
        joined.push_str(part);
    }
    Ok(Some(joined))
}

/// 조각을 먼저 **새 세대**에 모두 쓰고, 머리 항목을 마지막에 바꾼다. 도중에 멈춰도 머리 항목은
/// 아직 이전 세대를 가리키므로 읽는 쪽은 반쯤 쓰인 문서 대신 직전 문서를 본다. 세대를 나누지
/// 않고 같은 이름을 덮어쓰면, 조각 수가 줄어드는 저장에서 중단이 곧 앞부분만 새 값인 잘린
/// 문서가 된다 — Vault에서 그것은 계정 토큰이 통째로 깨지는 일이다.
#[cfg(not(target_os = "macos"))]
fn write_chunked_secret(
    entries: &dyn KeychainEntries,
    limit: Option<usize>,
    service: &str,
    account: &str,
    secret: &str,
) -> Result<(), CoreError> {
    let Some(limit) = limit else {
        return entries.write(service, account, secret);
    };
    let previous = match entries.read(service, account)? {
        Some(head) => parse_keychain_chunk_header(&head)?,
        None => None,
    };
    let generation = previous.map_or(1, |(generation, _)| generation.wrapping_add(1));
    if secret.encode_utf16().count() <= limit {
        entries.write(service, account, secret)?;
    } else {
        let parts = split_keychain_secret(secret, limit);
        if parts.len() > MAX_KEYCHAIN_CHUNKS {
            return Err(CoreError::InvalidInput(
                "OS 보안 저장소에 담기에 자격증명이 너무 깁니다".to_owned(),
            ));
        }
        for (index, part) in parts.iter().enumerate() {
            let chunk = keychain_chunk_account(account, generation, index);
            entries.write(service, &chunk, part)?;
        }
        let header = keychain_chunk_header(generation, parts.len());
        entries.write(service, account, &header)?;
        // 같은 세대에 앞선 시도가 더 많은 조각을 남겼을 수 있다.
        prune_keychain_chunks(
            entries,
            service,
            account,
            generation,
            parts.len(),
            parts.len(),
        )?;
    }
    if let Some((previous_generation, previous_count)) = previous {
        prune_keychain_chunks(
            entries,
            service,
            account,
            previous_generation,
            0,
            previous_count,
        )?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn delete_chunked_secret(
    entries: &dyn KeychainEntries,
    service: &str,
    account: &str,
) -> Result<(), CoreError> {
    // 안내를 읽지 못해도 삭제는 계속한다. 지우려는 참에 되살릴 것은 없고, 머리 항목을 남겨
    // 두면 다음 읽기가 같은 자리에서 다시 막힌다.
    let chunks = match entries.read(service, account) {
        Ok(Some(head)) => parse_keychain_chunk_header(&head).unwrap_or(None),
        Ok(None) => None,
        Err(error) => return Err(error),
    };
    entries.delete(service, account)?;
    if let Some((generation, count)) = chunks {
        prune_keychain_chunks(entries, service, account, generation, 0, count)?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn read_os_keychain_password(
    service: &str,
    account: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    read_chunked_secret(&OsKeyringEntries, service, account)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn write_os_keychain_password(
    service: &str,
    account: &str,
    secret: &str,
) -> Result<(), CoreError> {
    write_chunked_secret(
        &OsKeyringEntries,
        KEYCHAIN_ENTRY_UTF16_LIMIT,
        service,
        account,
        secret,
    )
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn delete_os_keychain_password(service: &str, account: &str) -> Result<(), CoreError> {
    delete_chunked_secret(&OsKeyringEntries, service, account)
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::*;
    #[cfg(target_os = "macos")]
    use std::fs;
    #[cfg(target_os = "macos")]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keychain_fields_allow_official_claude_service_names() {
        assert!(validate_keychain_field("Claude Code-credentials", "service").is_ok());
        assert!(validate_keychain_field("Claude Code-credentials-15fa340b", "service").is_ok());
        assert!(validate_keychain_field("Claude\nCode-credentials", "service").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_security_writer_supports_large_structured_arguments() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("security-stub");
        fs::write(
            &executable,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"${0}.args\"\ncat > \"${0}.stdin\"\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        let secret = format!(r#"{{"token":"{}"}}"#, "x".repeat(16 * 1024));

        write_macos_keychain_password_with_executable(
            &executable,
            "com.shinc.agentmanager.test",
            "test-account",
            &secret,
        )
        .unwrap();

        let arguments = fs::read_to_string(format!("{}.args", executable.display())).unwrap();
        let lines = arguments.lines().collect::<Vec<_>>();
        assert_eq!(
            &lines[..7],
            [
                "add-generic-password",
                "-U",
                "-s",
                "com.shinc.agentmanager.test",
                "-a",
                "test-account",
                "-w"
            ]
        );
        assert_eq!(lines[7], secret);
        assert!(
            fs::read_to_string(format!("{}.stdin", executable.display()))
                .unwrap()
                .is_empty()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_security_failure_does_not_expose_secret_in_error() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("security-stub");
        fs::write(&executable, "#!/bin/sh\ncat >&2\nexit 9\n").unwrap();
        let mut permissions = fs::metadata(&executable).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&executable, permissions).unwrap();
        let secret = r#"{"token":"must-not-leak"}"#;

        let error = write_macos_keychain_password_with_executable(
            &executable,
            "com.shinc.agentmanager.test",
            "test-account",
            secret,
        )
        .unwrap_err()
        .to_string();

        assert!(!error.contains(secret));
        assert!(error.contains("종료 코드 9"));
    }

    /// 홈을 가른 프로필에 키체인이 없으면, 공식 CLI가 로그인 토큰을 저장하는 순간 macOS가
    /// "저장할 키체인을 찾을 수 없습니다" 모달을 띄우고 로그인이 통째로 멈춘다. 그 CLI는
    /// 키체인을 1순위로 쓰고 파일은 호출이 시간 초과일 때만 쓰는 폴백이라, 사람이 답해
    /// 버리는 모달에서는 토큰이 어디에도 남지 않는다(`C12-4a`).
    #[cfg(target_os = "macos")]
    #[test]
    fn a_split_home_profile_gets_its_own_keychain() {
        let profile = tempfile::tempdir().expect("profile");
        ensure_profile_keychain(profile.path()).expect("키체인 준비");
        let keychain = profile.path().join("Library/Keychains/login.keychain-db");
        assert!(keychain.is_file(), "프로필 안에 키체인이 있어야 한다");
        // 이미 있으면 다시 만들지 않는다. 다시 만들면 그 계정이 저장해 둔 항목이 사라진다.
        let before = fs::metadata(&keychain).expect("metadata").len();
        ensure_profile_keychain(profile.path()).expect("두 번째 호출");
        assert_eq!(
            fs::metadata(&keychain).expect("metadata").len(),
            before,
            "이미 있는 키체인을 다시 만들지 않는다"
        );
    }

    /// Windows 자격 증명 관리자의 2,560바이트 한도를 조각내 넘기는 층. 실제 저장소를 건드리지
    /// 않고 배치와 순서를 확인한다.
    #[cfg(not(target_os = "macos"))]
    mod chunked {
        use super::super::*;
        use std::collections::BTreeMap;
        use std::sync::Mutex;

        #[derive(Default)]
        struct FakeState {
            entries: BTreeMap<(String, String), String>,
            /// 남은 쓰기 횟수. 0이 되면 그다음 쓰기가 실패한다 — 저장이 중간에 멈춘 상황을
            /// 만든다.
            writes_left: Option<usize>,
        }

        #[derive(Default)]
        struct FakeKeychain {
            state: Mutex<FakeState>,
        }

        impl FakeKeychain {
            fn fail_after(&self, writes: usize) {
                self.state.lock().expect("lock").writes_left = Some(writes);
            }

            fn allow_writes(&self) {
                self.state.lock().expect("lock").writes_left = None;
            }

            fn accounts(&self, service: &str) -> Vec<String> {
                self.state
                    .lock()
                    .expect("lock")
                    .entries
                    .keys()
                    .filter(|(entry_service, _)| entry_service == service)
                    .map(|(_, account)| account.clone())
                    .collect()
            }
        }

        impl KeychainEntries for FakeKeychain {
            fn read(
                &self,
                service: &str,
                account: &str,
            ) -> Result<Option<Zeroizing<String>>, CoreError> {
                Ok(self
                    .state
                    .lock()
                    .expect("lock")
                    .entries
                    .get(&(service.to_owned(), account.to_owned()))
                    .cloned()
                    .map(Zeroizing::new))
            }

            fn write(&self, service: &str, account: &str, secret: &str) -> Result<(), CoreError> {
                let mut state = self.state.lock().expect("lock");
                if let Some(left) = state.writes_left {
                    if left == 0 {
                        return Err(CoreError::Runtime("저장 실패".to_owned()));
                    }
                    state.writes_left = Some(left - 1);
                }
                state
                    .entries
                    .insert((service.to_owned(), account.to_owned()), secret.to_owned());
                Ok(())
            }

            fn delete(&self, service: &str, account: &str) -> Result<(), CoreError> {
                self.state
                    .lock()
                    .expect("lock")
                    .entries
                    .remove(&(service.to_owned(), account.to_owned()));
                Ok(())
            }
        }

        const SERVICE: &str = "com.shinc.agentmanager.test-vault";
        const ACCOUNT: &str = "vault-test";

        fn long_document(chars: usize) -> String {
            format!(
                "{{\"schemaVersion\":3,\"entries\":{{\"claude:acct\":\"{}\"}}}}",
                "t".repeat(chars)
            )
        }

        fn read(keychain: &FakeKeychain) -> Option<String> {
            read_chunked_secret(keychain, SERVICE, ACCOUNT)
                .expect("읽기")
                .map(|secret| secret.to_string())
        }

        fn write(keychain: &FakeKeychain, secret: &str) -> Result<(), CoreError> {
            write_chunked_secret(keychain, Some(64), SERVICE, ACCOUNT, secret)
        }

        #[test]
        fn splitting_keeps_every_part_under_the_limit_and_rejoins_to_the_original() {
            let long = long_document(500);
            let surrogates = "가나다🙂".repeat(90);
            let exactly_one_part = "a".repeat(8);
            for secret in [
                "짧다",
                long.as_str(),
                surrogates.as_str(),
                exactly_one_part.as_str(),
            ] {
                let parts = split_keychain_secret(secret, 8);
                for part in &parts {
                    assert!(
                        part.encode_utf16().count() <= 8,
                        "조각이 한도를 넘었다: {part}"
                    );
                    assert!(!part.is_empty(), "빈 조각을 만들지 않는다");
                }
                assert_eq!(parts.concat(), secret, "이어 붙이면 원문과 같아야 한다");
            }
        }

        #[test]
        fn a_plain_value_is_not_read_as_a_chunk_header() {
            assert_eq!(
                parse_keychain_chunk_header(r#"{"schemaVersion":3}"#).expect("파싱"),
                None
            );
            assert_eq!(
                parse_keychain_chunk_header(&keychain_chunk_header(7, 3)).expect("파싱"),
                Some((7, 3))
            );
        }

        /// 표식으로 시작하는데 뒤가 깨졌다면 그 자리는 안내지 비밀이 아니다. 값을 그대로
        /// 돌려주면 깨진 문자열이 공급자 자격증명으로 쓰인다.
        #[test]
        fn a_damaged_chunk_header_fails_instead_of_returning_the_marker() {
            for damaged in ["", "1", "1:0", "x:2", "1:513"] {
                let value = format!("{KEYCHAIN_CHUNK_MARKER}{damaged}");
                assert!(
                    parse_keychain_chunk_header(&value).is_err(),
                    "깨진 안내를 통과시켰다: {value}"
                );
            }
        }

        #[test]
        fn a_document_over_the_limit_round_trips_through_several_entries() {
            let keychain = FakeKeychain::default();
            let document = long_document(500);
            write(&keychain, &document).expect("저장");

            assert!(
                keychain.accounts(SERVICE).len() > 2,
                "한도를 넘는 문서는 여러 항목에 나뉘어야 한다"
            );
            assert_eq!(read(&keychain).as_deref(), Some(document.as_str()));
        }

        /// 한도 안에 들어오는 값은 지금까지처럼 항목 하나로 저장한다. 다른 플랫폼이나 이전
        /// 판이 남긴 값도 그대로 읽힌다.
        #[test]
        fn a_short_document_stays_a_single_entry() {
            let keychain = FakeKeychain::default();
            write(&keychain, r#"{"schemaVersion":3,"entries":{}}"#).expect("저장");

            assert_eq!(keychain.accounts(SERVICE), vec![ACCOUNT.to_owned()]);
            assert_eq!(
                read(&keychain).as_deref(),
                Some(r#"{"schemaVersion":3,"entries":{}}"#)
            );
        }

        /// 계정을 지워 문서가 줄면 남은 조각도 사라져야 한다. 비밀 조각이 저장소에 남으면
        /// 지웠다고 보고한 계정의 토큰이 OS에 계속 남는다.
        #[test]
        fn shrinking_a_document_removes_the_chunks_it_no_longer_needs() {
            let keychain = FakeKeychain::default();
            write(&keychain, &long_document(500)).expect("긴 문서");
            write(&keychain, &long_document(100)).expect("짧아진 문서");
            let after_shrink = keychain.accounts(SERVICE).len();
            assert_eq!(
                read(&keychain).as_deref(),
                Some(long_document(100).as_str())
            );

            write(&keychain, r#"{"schemaVersion":3,"entries":{}}"#).expect("빈 문서");
            assert!(after_shrink > 1, "중간 문서도 조각나 있어야 한다");
            assert_eq!(
                keychain.accounts(SERVICE),
                vec![ACCOUNT.to_owned()],
                "조각이 남지 않아야 한다"
            );
        }

        /// 저장이 중간에 멈춰도 머리 항목은 아직 직전 세대를 가리킨다. 세대를 나누지 않고
        /// 같은 이름을 덮어썼다면 여기서 앞부분만 새 값인 잘린 문서가 읽힌다.
        #[test]
        fn an_interrupted_write_leaves_the_previous_document_readable() {
            let keychain = FakeKeychain::default();
            let first = long_document(500);
            write(&keychain, &first).expect("첫 저장");

            keychain.fail_after(2);
            let second = long_document(120);
            write(&keychain, &second).expect_err("중간에 멈춘 저장");

            assert_eq!(read(&keychain).as_deref(), Some(first.as_str()));

            // 멈춘 시도가 남긴 조각은 다음 저장이 정리한다.
            keychain.allow_writes();
            write(&keychain, &second).expect("다시 저장");
            assert_eq!(read(&keychain).as_deref(), Some(second.as_str()));
            assert_eq!(
                keychain.accounts(SERVICE).len(),
                split_keychain_secret(&second, 64).len() + 1,
                "머리 항목과 이번 세대 조각만 남아야 한다"
            );
        }

        #[test]
        fn deleting_removes_the_header_and_every_chunk() {
            let keychain = FakeKeychain::default();
            write(&keychain, &long_document(500)).expect("저장");
            delete_chunked_secret(&keychain, SERVICE, ACCOUNT).expect("삭제");

            assert!(keychain.accounts(SERVICE).is_empty());
            assert_eq!(read(&keychain), None);
        }

        /// 한도가 없는 플랫폼은 조각내지 않는다.
        #[test]
        fn no_limit_means_no_chunking() {
            let keychain = FakeKeychain::default();
            let document = long_document(5_000);
            write_chunked_secret(&keychain, None, SERVICE, ACCOUNT, &document).expect("저장");

            assert_eq!(keychain.accounts(SERVICE), vec![ACCOUNT.to_owned()]);
            assert_eq!(read(&keychain).as_deref(), Some(document.as_str()));
        }
    }
}
