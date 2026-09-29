use std::fmt::Display;
use std::path::PathBuf;

use agent_manager_core::{
    decode_percent_header, load_backend_service_settings, provider_session_app_url,
    save_backend_service_settings, save_linked_file_download, BackendServiceSettings,
    LinkedFileDownload, ProviderId,
};
use serde::Deserialize;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, State,
};
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

const MAX_NOTIFICATION_TITLE_CHARS: usize = 120;
const MAX_NOTIFICATION_BODY_CHARS: usize = 1_024;

use crate::{ActiveBackendServiceSettings, QuitGate, TrayMenuItems};

#[tauri::command]
pub fn get_backend_service_settings(app: AppHandle) -> Result<BackendServiceSettings, String> {
    let app_data_dir = app_data_dir(&app)?;
    load_backend_service_settings(app_data_dir).map_err(error_message)
}

/// Returns the endpoint frozen when this desktop process elected its backend.
/// Persisted settings may change for the next launch, but live HTTP/WebSocket
/// clients must keep using this value until the process exits.
#[tauri::command]
pub fn get_active_backend_service_settings(
    active: State<'_, ActiveBackendServiceSettings>,
) -> BackendServiceSettings {
    active.inner().get()
}

/// Stores the endpoint used on the next desktop start. The active backend is
/// deliberately not rebound underneath live chats or terminals.
#[tauri::command]
pub fn set_backend_service_settings(
    app: AppHandle,
    port: u16,
) -> Result<BackendServiceSettings, String> {
    let app_data_dir = app_data_dir(&app)?;
    save_backend_service_settings(app_data_dir, port).map_err(error_message)
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(error_message)
}

fn error_message(error: impl Display) -> String {
    error.to_string()
}

/// Relaunches the desktop shell so the next start binds the newly saved
/// service port. The piped stdin of the current backend child closes with this
/// process, so the child shuts down before the replacement spawns.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

/// 화면이 `quit-requested`에 답하는 창구. 셋 중 하나다.
///
/// - `prompting`: 끊길 작업이 있어 확인 창을 띄웠다. 폴백 종료를 멈춘다.
/// - `quit`: 사용자가 종료를 택했다(끊길 작업이 없어 바로 답한 경우 포함).
/// - `cancel`: 사용자가 종료를 물렸다.
///
/// 종료는 여기서만 `exit`를 호출해 프로그램 종료로 만든다. 그래야 `ExitRequested`
/// 훅이 같은 요청을 다시 확인 절차로 돌려보내지 않는다.
#[tauri::command]
pub fn respond_to_quit(
    app: AppHandle,
    gate: State<'_, QuitGate>,
    decision: String,
) -> Result<(), String> {
    match decision.as_str() {
        "prompting" => gate.acknowledge(),
        "quit" => app.exit(0),
        "cancel" => gate.cancel(),
        _ => return Err("알 수 없는 종료 응답입니다".to_owned()),
    }
    Ok(())
}

/// Displays an OS notification selected by frontend polling. This adapter owns
/// only the platform presentation; account, chat, and scheduler state remains
/// in the single backend.
#[tauri::command]
pub fn show_native_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let title = validate_notification_text(title, "알림 제목", MAX_NOTIFICATION_TITLE_CHARS)?;
    let body = validate_notification_text(body, "알림 내용", MAX_NOTIFICATION_BODY_CHARS)?;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(error_message)
}

/// Keeps native tray chrome in the same language as the frontend selection.
#[tauri::command]
pub fn set_tray_locale(items: State<'_, TrayMenuItems>, locale: String) -> Result<(), String> {
    if locale.trim().is_empty() || locale.len() > 32 {
        return Err("언어 코드가 올바르지 않습니다".to_owned());
    }
    items.set_locale(&locale).map_err(error_message)
}

fn validate_notification_text(
    value: String,
    label: &str,
    max_chars: usize,
) -> Result<String, String> {
    if value.trim().is_empty() {
        return Err(format!("{label}이 비어 있습니다"));
    }
    if value.chars().count() > max_chars {
        return Err(format!("{label}이 허용 길이를 초과했습니다"));
    }
    if value.contains('\0') {
        return Err(format!("{label}에 허용되지 않은 문자가 있습니다"));
    }
    Ok(value)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    source: ProviderId,
    id: String,
}

/// Opens a provider-owned deep link. This is an OS-shell operation and does
/// not access Agent Manager's domain state.
#[tauri::command]
pub fn open_provider_session_app(app: AppHandle, request: SessionRequest) -> Result<(), String> {
    let url = provider_session_app_url(request.source, &request.id).map_err(error_message)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(error_message)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSettings {
    login_start: bool,
}

/// Controls only the desktop client login item. The configured backend is managed
/// independently as a service and is never started from this command.
#[tauri::command]
pub fn get_background_settings(app: AppHandle) -> Result<BackgroundSettings, String> {
    Ok(BackgroundSettings {
        login_start: app.autolaunch().is_enabled().map_err(error_message)?,
    })
}

#[tauri::command]
pub fn set_background_settings(
    app: AppHandle,
    login_start: bool,
) -> Result<BackgroundSettings, String> {
    if login_start {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(error_message)?;
    Ok(BackgroundSettings { login_start })
}

/// Persists bytes fetched from the configured backend after the user selected a
/// destination in the native save dialog. Path and symlink validation stays
/// in Rust Core; this adapter does not re-read any provider-owned file.
#[tauri::command]
pub fn save_downloaded_linked_file(request: Request<'_>) -> Result<(), String> {
    let (download, destination) = linked_file_download_request(&request)?;
    save_linked_file_download(&download, &destination).map_err(error_message)
}

fn linked_file_download_request(
    request: &Request<'_>,
) -> Result<(LinkedFileDownload, PathBuf), String> {
    let destination = PathBuf::from(decode_header_component(&request_header(
        request,
        "x-destination",
    )?)?);
    if !destination.is_absolute() {
        return Err("링크 파일 저장 경로는 절대 경로여야 합니다".to_owned());
    }
    let relative_path = decode_header_component(&request_header(request, "x-relative-path")?)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("다운로드한 파일 본문은 바이너리여야 합니다".to_owned()),
    };
    if bytes.len() > 100 * 1024 * 1024 {
        return Err("다운로드한 파일이 허용 크기를 초과했습니다".to_owned());
    }
    let size_bytes = u64::try_from(bytes.len())
        .map_err(|_| "다운로드한 파일 크기가 올바르지 않습니다".to_owned())?;
    Ok((
        LinkedFileDownload {
            relative_path,
            bytes,
            size_bytes,
        },
        destination,
    ))
}

fn request_header(request: &Request<'_>, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("{name} 헤더가 없습니다"))?
        .to_str()
        .map(str::to_owned)
        .map_err(|_| format!("{name} 헤더가 올바르지 않습니다"))
}

fn decode_header_component(value: &str) -> Result<String, String> {
    decode_percent_header(value, "링크 파일")
}

#[cfg(test)]
mod tests {
    use super::{decode_header_component, validate_notification_text};

    #[test]
    fn decodes_native_save_header_without_treating_plus_as_space() {
        assert_eq!(
            decode_header_component("%2Ftmp%2Freport%20%2B%20final.xlsx").expect("decode"),
            "/tmp/report + final.xlsx"
        );
    }

    #[test]
    fn rejects_invalid_native_save_header_encoding() {
        assert!(decode_header_component("%2").is_err());
        assert!(decode_header_component("%ZZ").is_err());
    }

    #[test]
    fn native_notification_text_is_bounded_and_non_empty() {
        assert_eq!(
            validate_notification_text("작업 완료".to_owned(), "제목", 16).expect("valid text"),
            "작업 완료"
        );
        assert!(validate_notification_text("  ".to_owned(), "제목", 16).is_err());
        assert!(validate_notification_text("너무 긴 제목".to_owned(), "제목", 3).is_err());
        assert!(validate_notification_text("잘못\0된 값".to_owned(), "제목", 16).is_err());
    }
}
