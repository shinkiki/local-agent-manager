mod commands;
mod file_download;

use std::ffi::OsString;
use std::path::Path;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use agent_manager_core::{BackendServiceSettings, TailscaleBackendLaunch};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};
use tauri_plugin_notification::NotificationExt;

/// 종료 요청을 화면에 넘긴 뒤 답을 기다리는 시간. 화면이 확인 창을 띄웠다고 답하면
/// 기다림은 끝나고 사용자가 원하는 만큼 결정을 미룰 수 있다. 여기서 재는 것은 사람의
/// 결정이 아니라 화면이 살아 있는지이며, 답이 없으면 끌 수 없는 앱이 되지 않도록
/// 그대로 종료한다.
const QUIT_PROMPT_ACK_TIMEOUT: Duration = Duration::from_secs(5);

struct BackendLifetime {
    _stdin: Mutex<Option<ChildStdin>>,
}

/// 사용자가 요청한 종료를 화면의 확인 절차에 한 번 맡기기 위한 관문.
///
/// 앱을 끄면 백엔드가 함께 내려가고 진행 중이던 모든 관리 런타임이 정리된다. 무인 회차가
/// 여러 개 도는 중에 실수로 Cmd+Q를 누르면 되돌릴 수 없으므로, 먼저 화면에 무엇이 끊기는지
/// 묻게 한다.
///
/// 두 수를 쓰는 이유는 늦게 도착한 폴백이 이미 취소된 종료를 되살리는 것을 막기 위해서다.
/// 종료 요청마다 `generation`이 오르고, 폴백 타이머는 자기가 태어난 세대가 아직 그대로일
/// 때만 종료한다. 취소도 세대를 올려 같은 방식으로 폴백을 무효로 만든다.
#[derive(Default)]
pub(crate) struct QuitGate {
    generation: AtomicU64,
    acknowledged: AtomicU64,
}

impl QuitGate {
    /// 화면이 확인 창을 띄웠다고 답했다. 이 세대의 폴백 종료를 멈춘다.
    pub(crate) fn acknowledge(&self) {
        self.acknowledged
            .store(self.generation.load(Ordering::Acquire), Ordering::Release);
    }

    /// 사용자가 종료를 물렸다. 세대를 올려 대기 중인 폴백을 무효로 만든다.
    pub(crate) fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    fn begin(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn is_unanswered(&self, generation: u64) -> bool {
        self.generation.load(Ordering::Acquire) == generation
            && self.acknowledged.load(Ordering::Acquire) != generation
    }
}

#[derive(Clone)]
pub(crate) struct ActiveBackendServiceSettings(BackendServiceSettings);

pub(crate) struct TrayMenuItems {
    show: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

/// 트레이 메뉴 세 칸의 문구. 메뉴를 처음 만들 때와 언어를 바꿀 때가 같은 표를 본다 —
/// 두 자리에 같은 한국어를 따로 적어 두면 한쪽만 고쳐도 아무도 눈치채지 못한다.
struct TrayLabels {
    show: &'static str,
    pause: &'static str,
    quit: &'static str,
}

const KOREAN_TRAY_LABELS: TrayLabels = TrayLabels {
    show: "Agent Manager 열기",
    pause: "반복 요청 일시정지/재개",
    quit: "종료",
};

const ENGLISH_TRAY_LABELS: TrayLabels = TrayLabels {
    show: "Open Agent Manager",
    pause: "Pause/resume recurring requests",
    quit: "Quit",
};

/// 화면이 언어를 알려 주기 전까지 쓰는 문구. 지금까지의 기동 동작과 같은 한국어다.
const DEFAULT_TRAY_LOCALE: &str = "ko";

fn tray_labels(locale: &str) -> &'static TrayLabels {
    if locale == "ko" {
        &KOREAN_TRAY_LABELS
    } else {
        &ENGLISH_TRAY_LABELS
    }
}

impl TrayMenuItems {
    pub(crate) fn set_locale(&self, locale: &str) -> tauri::Result<()> {
        let labels = tray_labels(locale);
        self.show.set_text(labels.show)?;
        self.pause.set_text(labels.pause)?;
        self.quit.set_text(labels.quit)
    }
}

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
            app.manage(QuitGate::default());
            install_tray(app)?;
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
            commands::set_tray_locale,
            commands::open_provider_session_app,
            commands::get_background_settings,
            commands::set_background_settings,
            commands::save_downloaded_linked_file,
            commands::respond_to_quit,
            file_download::save_document_file_to_path,
            file_download::cancel_document_file_download,
        ])
        .build(tauri::generate_context!())
        .expect("failed to run Agent Manager")
        .run(|app, event| {
            // `code`가 없는 종료만 사람이 지금 누른 것이다(Cmd+Q, Dock 종료). 화면의 확인을
            // 거친 종료와 재시작은 `app.exit`/`restart`가 코드를 싣고 오므로 막지 않는다.
            if let RunEvent::ExitRequested {
                api, code: None, ..
            } = event
            {
                api.prevent_exit();
                request_quit(app);
            }
        });
}

/// 트레이 아이콘과 그 메뉴를 세우고, 언어 전환이 나중에 문구를 고칠 수 있도록 세 칸을
/// 앱 상태로 맡긴다. 기동 절차(`setup`)에서 떼어 둔 것은 백엔드 기동·알림 권한과 달리
/// 이 덩어리만 메뉴 구성·아이콘 폴백·두 이벤트 처리를 함께 들고 있기 때문이다.
fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let labels = tray_labels(DEFAULT_TRAY_LOCALE);
    let show_item = MenuItem::with_id(app, "show", labels.show, true, None::<&str>)?;
    let pause_item = MenuItem::with_id(app, "pause", labels.pause, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &pause_item, &quit_item])?;
    app.manage(TrayMenuItems {
        show: show_item,
        pause: pause_item,
        quit: quit_item,
    });
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
            "quit" => request_quit(app),
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
    Ok(())
}

/// 종료 의사를 화면에 넘겨 무엇이 끊기는지 먼저 묻게 한다. 창이 트레이에 숨어 있으면
/// 확인 창을 볼 수 없으므로 먼저 띄운다.
///
/// 화면에 물을 수 없는 상태(이벤트 전달 실패, 정해진 시간 안에 응답 없음)라면 묻기를
/// 포기하고 종료한다 — 확인 절차 때문에 앱이 꺼지지 않는 쪽이 더 나쁘다.
fn request_quit(app: &AppHandle) {
    let generation = app.state::<QuitGate>().begin();
    show_main_window(app);
    if app.emit("quit-requested", ()).is_err() {
        app.exit(0);
        return;
    }
    let app = app.clone();
    let watchdog = std::thread::Builder::new()
        .name("agent-manager-quit-prompt".to_owned())
        .spawn(move || {
            std::thread::sleep(QUIT_PROMPT_ACK_TIMEOUT);
            if app.state::<QuitGate>().is_unanswered(generation) {
                app.exit(0);
            }
        });
    if let Err(error) = watchdog {
        eprintln!("종료 확인 감시를 시작하지 못했습니다: {error}");
    }
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
    let static_dir =
        backend_static_dir(&resource_dir).ok_or("백엔드용 정적 UI를 찾을 수 없습니다")?;
    let executable = std::fs::canonicalize(std::env::current_exe()?)?;
    // A missing, corrupt, or stale record must never prevent local startup or
    // cause the shell to trust unvalidated frontend input.
    let tailscale =
        agent_manager_core::load_tailscale_backend_launch(&app_data_dir, service_settings.port)
            .unwrap_or_default();
    let (child_stdout, child_stderr) = backend_log_stdio(&app_data_dir);
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

fn backend_static_dir(resource_dir: &Path) -> Option<std::path::PathBuf> {
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
    static_dir
}

fn backend_log_stdio(app_data_dir: &Path) -> (Stdio, Stdio) {
    // 로그 파일을 못 열어도 백엔드 기동은 막지 않는다. 그 경우에만 출력을 버린다.
    match open_backend_log(app_data_dir).and_then(|file| file.try_clone().map(|out| (out, file))) {
        Ok((out, err)) => (Stdio::from(out), Stdio::from(err)),
        Err(_) => (Stdio::null(), Stdio::null()),
    }
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

    /// 화면이 답하지 않으면 폴백이 앱을 끈다. 확인 절차가 종료를 영구히 막으면
    /// 사용자는 앱을 강제 종료하는 수밖에 없다.
    #[test]
    fn an_unanswered_quit_prompt_still_lets_the_app_exit() {
        let gate = QuitGate::default();
        let generation = gate.begin();
        assert!(gate.is_unanswered(generation));
    }

    /// 확인 창을 띄웠다고 답했으면 사용자가 결정을 얼마나 미루든 폴백은 끼어들지 않는다.
    #[test]
    fn an_acknowledged_quit_prompt_suppresses_the_fallback_exit() {
        let gate = QuitGate::default();
        let generation = gate.begin();
        gate.acknowledge();
        assert!(!gate.is_unanswered(generation));
    }

    /// 취소한 종료를, 그 전에 태어난 폴백이 되살리면 안 된다. 물린 종료가 몇 초 뒤
    /// 그대로 실행되는 것이야말로 이 확인 절차가 막으려는 사고다.
    #[test]
    fn a_cancelled_quit_is_not_revived_by_its_own_fallback() {
        let gate = QuitGate::default();
        let generation = gate.begin();
        gate.cancel();
        assert!(!gate.is_unanswered(generation));

        // 취소 뒤 다시 종료를 누르면 새 세대가 열리고, 그 세대는 다시 폴백 대상이다.
        let next = gate.begin();
        assert_ne!(next, generation);
        assert!(gate.is_unanswered(next));
    }

    /// 처음 만드는 메뉴와 한국어로 되돌린 메뉴가 같은 문구여야 한다. 기동 시점의 문구를
    /// 따로 적어 두면 언어를 한 번 바꿨다 되돌린 것만으로 글자가 달라진다.
    #[test]
    fn the_startup_tray_locale_is_the_korean_label_table() {
        let startup = tray_labels(DEFAULT_TRAY_LOCALE);
        assert_eq!(startup.show, KOREAN_TRAY_LABELS.show);
        assert_eq!(startup.pause, KOREAN_TRAY_LABELS.pause);
        assert_eq!(startup.quit, KOREAN_TRAY_LABELS.quit);
    }

    /// 한국어가 아닌 모든 언어는 영어 문구로 떨어진다(기존 `locale != "ko"` 판정).
    #[test]
    fn a_non_korean_locale_falls_back_to_the_english_labels() {
        for locale in ["en", "ja", "ko-KR", ""] {
            assert_eq!(
                tray_labels(locale).quit,
                ENGLISH_TRAY_LABELS.quit,
                "{locale}"
            );
        }
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
