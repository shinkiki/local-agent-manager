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
            // macOS 알림 아이콘 귀속: 플러그인은 dev 실행에서 com.apple.Terminal로 고정하므로
            // 첫 알림 전에 설치된 앱 번들 ID로 선점한다. set_application은 프로세스당 1회만
            // 적용되며, 설치본이 없어 번들 조회가 실패하면 기존 동작으로 조용히 폴백된다.
            #[cfg(target_os = "macos")]
            let _ = notify_rust::set_application(&app.config().identifier);
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
            .unwrap_or_default();
    // 로그 파일을 못 열어도 백엔드 기동은 막지 않는다. 그 경우에만 출력을 버린다.
    let (child_stdout, child_stderr) = match open_backend_log(&app_data_dir)
        .and_then(|file| file.try_clone().map(|out| (out, file)))
    {
        Ok((out, err)) => (Stdio::from(out), Stdio::from(err)),
        Err(_) => (Stdio::null(), Stdio::null()),
    };
    let mut child = Command::new(executable)
        .args(backend_child_args(
            service_settings.port,
            &static_dir,
            &app_data_dir,
            tailscale.as_ref(),
        ))
        .stdin(Stdio::piped())
        .stdout(child_stdout)
        .stderr(child_stderr)
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

/// 백엔드 자식의 stdout/stderr를 받는 로그 파일을 연다. 포트 충돌·저장소 잠금·설정
/// 손상 같은 기동 실패는 자식의 stderr에만 남으므로, 버리면 화면에는 "연결이
/// 끊겼습니다"만 보이고 원인을 알 수 없다. 앱 기동마다 새로 써 크기가 계속 자라지
/// 않는다.
fn open_backend_log(app_data_dir: &Path) -> std::io::Result<std::fs::File> {
    std::fs::create_dir_all(app_data_dir)?;
    std::fs::File::create(app_data_dir.join("backend-service.log"))
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
    // 원격에 변경 권한을 줄지는 이 인자가 아니라 백엔드 서비스 설정의 `remoteWrite`가
    // 정한다. 셸이 한 번 더 정하면 설정 화면의 토글과 어긋난다.
    if let Some(tailscale) = tailscale {
        args.extend([
            "--tailscale-host".into(),
            tailscale.host.clone().into(),
            "--tailscale-user".into(),
            tailscale.login.clone().into(),
        ]);
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
    fn backend_log_is_rewritten_on_each_launch() {
        let dir = std::env::temp_dir().join(format!(
            "agent-manager-backend-log-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        {
            use std::io::Write;
            let mut first = open_backend_log(&dir).expect("first log file");
            writeln!(first, "이전 실행의 출력").expect("first write");
        }
        let _ = open_backend_log(&dir).expect("relaunch log file");
        let content = std::fs::read_to_string(dir.join("backend-service.log")).expect("read log");
        assert_eq!(content, "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_backend_child_has_no_tailscale_arguments() {
        let args = args_as_strings(None);
        assert!(!args.iter().any(|arg| arg == "--tailscale-host"));
        assert!(!args.iter().any(|arg| arg == "--tailscale-user"));
    }

    #[test]
    fn tailscale_backend_child_uses_structured_identity_arguments() {
        let launch = TailscaleBackendLaunch {
            host: "device.example.ts.net".to_owned(),
            login: "user@example.com".to_owned(),
        };
        let args = args_as_strings(Some(&launch));
        assert!(args
            .windows(2)
            .any(|pair| { pair == ["--tailscale-host", "device.example.ts.net"] }));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--tailscale-user", "user@example.com"]));
        // 원격 write는 백엔드가 저장된 설정에서 직접 읽는다(설정 지점 단일화).
        assert!(!args.iter().any(|arg| arg == "--remote-write"));
    }
}
