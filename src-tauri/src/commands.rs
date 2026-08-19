use std::path::PathBuf;

use agent_manager_core::{
    load_backend_service_settings, provider_session_app_url, save_backend_service_settings,
    save_linked_file_download, BackendServiceSettings, LinkedFileDownload, ProviderId,
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

use crate::ActiveBackendServiceSettings;

#[tauri::command]
pub fn get_backend_service_settings(app: AppHandle) -> Result<BackendServiceSettings, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    load_backend_service_settings(app_data_dir).map_err(|error| error.to_string())
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
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    save_backend_service_settings(app_data_dir, port).map_err(|error| error.to_string())
}

/// Relaunches the desktop shell so the next start binds the newly saved
/// service port. The piped stdin of the current backend child closes with this
/// process, so the child shuts down before the replacement spawns.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
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
        .map_err(|error| error.to_string())
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
    let url =
        provider_session_app_url(request.source, &request.id).map_err(|error| error.to_string())?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
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
        login_start: app
            .autolaunch()
            .is_enabled()
            .map_err(|error| error.to_string())?,
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
    .map_err(|error| error.to_string())?;
    Ok(BackgroundSettings { login_start })
}

/// Persists bytes fetched from the configured backend after the user selected a
/// destination in the native save dialog. Path and symlink validation stays
/// in Rust Core; this adapter does not re-read any provider-owned file.
#[tauri::command]
pub fn save_downloaded_linked_file(request: Request<'_>) -> Result<(), String> {
    let destination = PathBuf::from(decode_header_component(&request_header(
        &request,
        "x-destination",
    )?)?);
    if !destination.is_absolute() {
        return Err("링크 파일 저장 경로는 절대 경로여야 합니다".to_owned());
    }
    let relative_path = decode_header_component(&request_header(&request, "x-relative-path")?)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("다운로드한 파일 본문은 바이너리여야 합니다".to_owned()),
    };
    if bytes.len() > 100 * 1024 * 1024 {
        return Err("다운로드한 파일이 허용 크기를 초과했습니다".to_owned());
    }
    let size_bytes = u64::try_from(bytes.len())
        .map_err(|_| "다운로드한 파일 크기가 올바르지 않습니다".to_owned())?;
    save_linked_file_download(
        &LinkedFileDownload {
            relative_path,
            bytes,
            size_bytes,
        },
        &destination,
    )
    .map_err(|error| error.to_string())
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
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("링크 파일 헤더 인코딩이 올바르지 않습니다".to_owned());
            }
            let high = decode_hex(bytes[index + 1])?;
            let low = decode_hex(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| "링크 파일 헤더가 UTF-8 문자열이 아닙니다".to_owned())
}

fn decode_hex(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("링크 파일 헤더 인코딩이 올바르지 않습니다".to_owned()),
    }
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
