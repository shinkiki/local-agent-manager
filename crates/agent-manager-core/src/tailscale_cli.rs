//! Tailscale CLI 어댑터.
//!
//! 원격 접속 모듈(`remote.rs`)은 HTTP 전송·인가·서버 수명주기를 다루는데, 그 사이에
//! `tailscale` 실행 파일을 띄워 상태 JSON을 읽고 Serve 설정을 바꾸는 계층이 섞여 있었다.
//! 여기로 모아 두면 전송 흐름을 읽을 때 프로세스 호출 규칙(Windows 콘솔 숨김, 권한 상승,
//! 실패 메시지 다듬기)을 건너뛸 수 있고, 반대로 CLI 계약을 고칠 때도 이 파일만 보면 된다.
//! 동작은 옮기기 전과 같다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde::Deserialize;
use serde_json::Value;

use crate::CoreError;

/// 로그인된 온라인 tailnet 노드 한 대. `remote.rs`가 Serve를 걸고 백엔드 기동 정보를
/// 저장할 때 그대로 쓰므로 필드를 크레이트 안에 열어 둔다.
#[derive(Debug)]
pub(crate) struct TailscaleIdentity {
    pub(crate) executable: PathBuf,
    pub(crate) host: String,
    pub(crate) login: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleStatusDocument {
    backend_state: String,
    #[serde(rename = "Self")]
    self_node: TailscaleSelfNode,
    user: HashMap<String, TailscaleUser>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleSelfNode {
    #[serde(rename = "DNSName")]
    dns_name: String,
    #[serde(rename = "UserID")]
    user_id: u64,
    online: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct TailscaleUser {
    login_name: String,
}

pub(crate) fn serve_target(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub(crate) fn detect_tailscale_identity() -> Result<TailscaleIdentity, CoreError> {
    let executable = crate::providers::resolve_named_executable(&["tailscale"])?;
    let output = command_output(&executable, &["status", "--json"])?;
    parse_tailscale_identity(executable, &output.stdout)
}

fn parse_tailscale_identity(
    executable: PathBuf,
    json: &[u8],
) -> Result<TailscaleIdentity, CoreError> {
    let document: TailscaleStatusDocument = serde_json::from_slice(json)?;
    if document.backend_state != "Running" || !document.self_node.online {
        return Err(CoreError::Runtime(
            "Tailscale이 로그인된 온라인 상태가 아닙니다".to_owned(),
        ));
    }
    let host = document.self_node.dns_name.trim_end_matches('.').to_owned();
    validate_tailscale_host(&host).map_err(CoreError::InvalidInput)?;
    let login = document
        .user
        .get(&document.self_node.user_id.to_string())
        .map(|user| user.login_name.trim())
        .filter(|login| !login.is_empty())
        .ok_or_else(|| CoreError::Runtime("현재 Tailscale 로그인을 확인할 수 없습니다".to_owned()))?
        .to_owned();
    Ok(TailscaleIdentity {
        executable,
        host,
        login,
    })
}

pub(crate) fn read_serve_target(identity: &TailscaleIdentity) -> Result<Option<String>, CoreError> {
    let output = command_output(&identity.executable, &["serve", "status", "--json"])?;
    parse_serve_target(&identity.host, &output.stdout)
}

fn parse_serve_target(host: &str, json: &[u8]) -> Result<Option<String>, CoreError> {
    let value: Value = serde_json::from_slice(json)?;
    Ok(value
        .get("Web")
        .and_then(|web| web.get(format!("{host}:443")))
        .and_then(|entry| entry.get("Handlers"))
        .and_then(|handlers| handlers.get("/"))
        .and_then(|handler| handler.get("Proxy"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned))
}

pub(crate) fn configure_serve(
    identity: &TailscaleIdentity,
    target: &str,
    allow_elevation: bool,
) -> Result<(), CoreError> {
    let args = [
        "serve",
        "--bg",
        "--yes",
        "--https=443",
        "--set-path=/",
        target,
    ];
    run_serve_command(&identity.executable, &args, allow_elevation)
}

pub(crate) fn disable_serve(identity: &TailscaleIdentity) -> Result<(), CoreError> {
    let args = ["serve", "--https=443", "--set-path=/", "off"];
    run_serve_command(&identity.executable, &args, true)
}

pub(crate) fn rollback_serve(identity: &TailscaleIdentity, previous_target: Option<&str>) {
    let result = match previous_target {
        Some(target) => configure_serve(identity, target, true),
        None => disable_serve(identity),
    };
    if let Err(error) = result {
        eprintln!("Tailscale Serve rollback failed: {error}");
    }
}

pub(crate) fn validate_tailscale_host(host: &str) -> Result<(), String> {
    if host.ends_with(".ts.net")
        && host.len() <= 253
        && host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.'))
    {
        Ok(())
    } else {
        Err("--tailscale-host는 스킴과 경로가 없는 정확한 *.ts.net 호스트여야 합니다".to_owned())
    }
}

fn command_output(executable: &Path, args: &[&str]) -> Result<Output, CoreError> {
    let mut command = Command::new(executable);
    command.args(args);
    // Tailscale is a console-subsystem executable on Windows. The settings screen
    // invokes it several times while reading and changing Serve state, so launching
    // it from the GUI without this flag briefly creates a console for every probe.
    crate::chat::configure_no_window_command(&mut command);
    let output = command.output()?;
    if output.status.success() {
        return Ok(output);
    }
    Err(CoreError::Runtime(command_failure_message(&output)))
}

fn command_failure_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    if detail.is_empty() {
        format!(
            "Tailscale 명령이 종료 코드 {:?}로 실패했습니다",
            output.status.code()
        )
    } else {
        let detail = detail.chars().take(2_000).collect::<String>();
        format!("Tailscale 명령이 실패했습니다: {detail}")
    }
}

#[cfg(not(windows))]
fn run_serve_command(
    executable: &Path,
    args: &[&str],
    _allow_elevation: bool,
) -> Result<(), CoreError> {
    command_output(executable, args).map(|_| ())
}

#[cfg(windows)]
fn run_serve_command(
    executable: &Path,
    args: &[&str],
    allow_elevation: bool,
) -> Result<(), CoreError> {
    match command_output(executable, args) {
        Ok(_) => Ok(()),
        Err(_) if allow_elevation => run_elevated_windows(executable, args),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn run_elevated_windows(executable: &Path, args: &[&str]) -> Result<(), CoreError> {
    use std::ffi::OsStr;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, WaitForSingleObject, INFINITE,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };

    if args.iter().any(|arg| arg.chars().any(char::is_whitespace)) {
        return Err(CoreError::InvalidInput(
            "관리자 권한 Tailscale 인자에는 공백을 사용할 수 없습니다".to_owned(),
        ));
    }
    let verb = wide_string(OsStr::new("runas"));
    let file = wide_string(executable.as_os_str());
    let parameters = wide_string(OsStr::new(&args.join(" ")));
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: verb.as_ptr(),
        lpFile: file.as_ptr(),
        lpParameters: parameters.as_ptr(),
        nShow: 0,
        ..Default::default()
    };
    if unsafe { ShellExecuteExW(&mut info) } == 0 || info.hProcess.is_null() {
        return Err(CoreError::Runtime(
            "Windows 관리자 권한 요청이 취소되었거나 시작되지 않았습니다".to_owned(),
        ));
    }
    let wait = unsafe { WaitForSingleObject(info.hProcess, INFINITE) };
    if wait != WAIT_OBJECT_0 {
        unsafe { CloseHandle(info.hProcess) };
        return Err(CoreError::Runtime(
            "관리자 권한 Tailscale 명령 대기에 실패했습니다".to_owned(),
        ));
    }
    let mut exit_code = 1u32;
    let result = unsafe { GetExitCodeProcess(info.hProcess, &mut exit_code) };
    unsafe { CloseHandle(info.hProcess) };
    if result == 0 || exit_code != 0 {
        return Err(CoreError::Runtime(format!(
            "관리자 권한 Tailscale 명령이 종료 코드 {exit_code}로 실패했습니다"
        )));
    }
    Ok(())
}

#[cfg(windows)]
fn wide_string(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_exact_tailnet_host() {
        assert!(validate_tailscale_host("device.example.ts.net").is_ok());
        assert!(validate_tailscale_host("https://device.example.ts.net").is_err());
        assert!(validate_tailscale_host("example.com").is_err());
    }

    #[test]
    fn parses_current_tailscale_identity_and_trims_dns_dot() {
        let json = br#"{
            "BackendState":"Running",
            "Self":{"DNSName":"device.example.ts.net.","UserID":42,"Online":true},
            "User":{"42":{"LoginName":"user@example.com"}}
        }"#;
        let identity =
            parse_tailscale_identity(PathBuf::from("tailscale"), json).expect("tailscale identity");
        assert_eq!(identity.host, "device.example.ts.net");
        assert_eq!(identity.login, "user@example.com");
    }

    #[test]
    fn parses_matching_serve_proxy_without_touching_other_paths() {
        let json = br#"{
            "Web":{"device.example.ts.net:443":{"Handlers":{
                "/":{"Proxy":"http://127.0.0.1:5217"},
                "/other":{"Proxy":"http://127.0.0.1:9000"}
            }}}
        }"#;
        assert_eq!(
            parse_serve_target("device.example.ts.net", json).expect("serve target"),
            Some("http://127.0.0.1:5217".to_owned())
        );
    }
}
