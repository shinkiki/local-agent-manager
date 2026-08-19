mod commands;

use std::ffi::OsString;
use std::path::Path;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::Mutex;

use agent_manager_core::{BackendServiceSettings, TailscaleBackendLaunch};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_notification::NotificationExt;

struct BackendLifetime {
    _stdin: Mutex<Option<ChildStdin>>,
}

#[derive(Clone)]
pub(crate) struct ActiveBackendServiceSettings(BackendServiceSettings);

impl ActiveBackendServiceSettings {
    pub(crate) fn get(&self) -> BackendServiceSettings {
        self.0.clone()
    }
}

/// The desktop process is a native shell only. All domain state and provider
/// credentials are owned by the standalone backend listening on the configured
/// loopback service port.
/// Keeping Core supervisors out of this process prevents two in-memory
/// registries from writing the same app-data and provider credential stores.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            spawn_single_backend(app)?;

            let show_item =
                MenuItem::with_id(app, "show", "Agent Manager 열기", true, None::<&str>)?;
            let pause_item =
                MenuItem::with_id(app, "pause", "반복 요청 일시정지/재개", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &pause_item, &quit_item])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Agent Manager")
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    // The frontend forwards this intent to the single configured
                    // backend. The native shell never opens a SchedulerSupervisor.
                    "pause" => {
                        let _ = app.emit("toggle-scheduler-pause", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                });
            // macOS 메뉴바는 모노크롬 템플릿 글리프를 사용해 시스템 아이콘과 톤을 맞춘다.
            #[cfg(target_os = "macos")]
            {
                match tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
                    Ok(icon) => tray = tray.icon(icon).icon_as_template(true),
                    Err(_) => {
                        if let Some(icon) = app.default_window_icon().cloned() {
                            tray = tray.icon(icon);
                        }
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon().cloned() {
                tray = tray.icon(icon);
            }
            tray.build(app)?;
            // Core notifications are detected by frontend polling. The shell
            // requests only the OS presentation permission here.
            let _ = app.notification().request_permission();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_backend_service_settings,
            commands::get_active_backend_service_settings,
            commands::set_backend_service_settings,
            commands::restart_app,
            commands::show_native_notification,
            commands::open_provider_session_app,
            commands::get_background_settings,
            commands::set_background_settings,
            commands::save_downloaded_linked_file,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Agent Manager");
}

/// Starts the single backend on the configured loopback port. When the user
/// enabled Tailscale from this app, Core supplies a validated, non-secret
/// launch record so the replacement child accepts only that Tailnet identity.
/// The child binds the configured service port
/// before opening app-data or provider state; if another compatible backend is
/// already serving the port, this contender exits without opening Core. The
/// child remains alive while the desktop process (including its tray mode) is
/// alive. Closing its piped stdin on a real app exit shuts the backend down
/// cleanly; a separately managed backend is unaffected.
fn spawn_single_backend(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_dir = app.path().app_data_dir()?;
    let service_settings = agent_manager_core::load_backend_service_settings(&app_data_dir)?;
    let resource_dir = app.path().resource_dir()?;
    let static_dir = [
        resource_dir.join("remote-ui"),
        resource_dir.join("backend-fallback-ui"),
    ]
    .into_iter()
    .find(|candidate| candidate.join("index.html").is_file());
    #[cfg(debug_assertions)]
    let static_dir = static_dir.or_else(|| {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        [
            manifest_dir.join("../dist"),
            manifest_dir.join("backend-fallback-ui"),
        ]
        .into_iter()
        .find(|candidate| candidate.join("index.html").is_file())
    });
    let static_dir = static_dir.ok_or("백엔드용 정적 UI를 찾을 수 없습니다")?;
    let executable = std::fs::canonicalize(std::env::current_exe()?)?;
    // A missing, corrupt, or stale record must never prevent local startup or
    // cause the shell to trust unvalidated frontend input.
    let tailscale =
        agent_manager_core::load_tailscale_backend_launch(&app_data_dir, service_settings.port)
            .unwrap_or(None);
    let mut child = Command::new(executable)
        .args(backend_child_args(
            service_settings.port,
            &static_dir,
            &app_data_dir,
            tailscale.as_ref(),
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    app.manage(BackendLifetime {
        _stdin: Mutex::new(child.stdin.take()),
    });
    app.manage(ActiveBackendServiceSettings(service_settings));
    std::thread::Builder::new()
        .name("agent-manager-backend-reaper".to_owned())
        .spawn(move || {
            let _ = child.wait();
        })?;
    Ok(())
}

fn backend_child_args(
    port: u16,
    static_dir: &Path,
    app_data_dir: &Path,
    tailscale: Option<&TailscaleBackendLaunch>,
) -> Vec<OsString> {
    let mut args = vec![
        "--backend".into(),
        "--port".into(),
        port.to_string().into(),
        "--static-dir".into(),
        static_dir.as_os_str().to_owned(),
        "--app-data-dir".into(),
        app_data_dir.as_os_str().to_owned(),
    ];
    if let Some(tailscale) = tailscale {
        args.extend([
            "--tailscale-host".into(),
            tailscale.host.clone().into(),
            "--tailscale-user".into(),
            tailscale.login.clone().into(),
        ]);
        if tailscale.remote_write {
            args.push("--remote-write".into());
        }
    }
    args.extend([
        "--shutdown-on-stdin-eof".into(),
        // A restart spawns this child while the predecessor backend is still
        // shutting down, so let it wait for the app-data store handover.
        "--await-store-handover".into(),
    ]);
    args
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_as_strings(tailscale: Option<&TailscaleBackendLaunch>) -> Vec<String> {
        backend_child_args(
            54178,
            Path::new("/tmp/static ui"),
            Path::new("/tmp/app data"),
            tailscale,
        )
        .into_iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
    }

    #[test]
    fn local_backend_child_has_no_tailscale_arguments() {
        let args = args_as_strings(None);
        assert!(!args.iter().any(|arg| arg == "--tailscale-host"));
        assert!(!args.iter().any(|arg| arg == "--tailscale-user"));
        assert!(!args.iter().any(|arg| arg == "--remote-write"));
    }

    #[test]
    fn tailscale_backend_child_uses_structured_identity_arguments() {
        let launch = TailscaleBackendLaunch {
            host: "device.example.ts.net".to_owned(),
            login: "user@example.com".to_owned(),
            remote_write: true,
        };
        let args = args_as_strings(Some(&launch));
        assert!(args
            .windows(2)
            .any(|pair| { pair == ["--tailscale-host", "device.example.ts.net"] }));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--tailscale-user", "user@example.com"]));
        assert!(args.iter().any(|arg| arg == "--remote-write"));
    }
}
