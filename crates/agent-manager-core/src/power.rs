//! 자동 절전 억제(G7 앱 소유 저장소 + 프로세스 수명 자원).
//!
//! 호스트가 잠들면 백엔드도 함께 멈춘다. 원격 UI에서는 그 상태가 백엔드 장애와 구분되지
//! 않고 "백엔드 서비스에 연결하지 못했습니다"로만 보인다. 그래서 사용자가 원격을 쓰는
//! 동안 호스트를 깨어 있게 하는 수단을 OS마다 하나씩 둔다.
//!
//! | OS | 수단 | 해제 |
//! | --- | --- | --- |
//! | macOS | `caffeinate` 자식 프로세스 | 프로세스 종료 |
//! | Linux | `systemd-inhibit`가 잡는 `idle:sleep` 락 | 자식 stdin EOF |
//! | Windows | `SetThreadExecutionState` | 건 스레드 종료 |
//!
//! 세 방식 모두 **자동 절전만** 막는다. 뚜껑을 닫거나 사용자가 직접 잠재우는 것은 막지
//! 못하며, 막아서도 안 된다. 사용자가 내린 명시적 결정을 앱이 되돌리는 셈이기 때문이다.
//!
//! 억제 자원은 프로세스에 하나만 있으면 되고 OS 자원 자체가 프로세스 단위라, 상태는
//! 이 모듈의 프로세스 전역 하나로 둔다.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::app_data_file::{ensure_schema_version, read_private_json, write_private_json};
use crate::CoreError;

const SETTINGS_SCHEMA_VERSION: u32 = 1;
const SETTINGS_FILE_NAME: &str = "power-settings.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepPreventionStatus {
    /// 이 호스트에서 억제 수단을 실제로 쓸 수 있는지. 도구가 없는 환경(예: systemd가
    /// 없는 Linux)에서는 설정을 켜도 걸리지 않으므로 화면이 그 사실을 말해야 한다.
    pub supported: bool,
    /// 사용자가 저장해 둔 설정값. 수단이 없어도 설정 자체는 그대로 보존한다.
    pub enabled: bool,
    /// 지금 이 프로세스가 억제를 잡고 있는지.
    pub active: bool,
    /// 쓰이는(또는 쓰였을) 수단의 이름. 사용자가 무엇이 도는지 확인할 수 있게 그대로 낸다.
    pub mechanism: Option<String>,
    /// 켜려다 실패한 이유.
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPowerSettings {
    schema_version: u32,
    prevent_sleep: bool,
}

struct Held {
    guard: Option<platform::Guard>,
    mechanism: Option<&'static str>,
    error: Option<String>,
}

static HELD: Mutex<Held> = Mutex::new(Held {
    guard: None,
    mechanism: None,
    error: None,
});

/// 저장된 설정과 지금 걸려 있는 상태를 함께 읽는다.
pub fn sleep_prevention_status(app_data_dir: &Path) -> Result<SleepPreventionStatus, CoreError> {
    let enabled = load_prevent_sleep(app_data_dir)?;
    Ok(with_held(|held| snapshot(held, enabled)))
}

/// 설정을 저장하고 즉시 적용한다. 저장이 실패하면 억제 상태는 건드리지 않는다 —
/// 다음 기동에서 되돌아올 설정과 지금 걸린 상태가 어긋나는 편이 더 헷갈린다.
pub fn set_sleep_prevention(
    app_data_dir: &Path,
    enabled: bool,
) -> Result<SleepPreventionStatus, CoreError> {
    save_prevent_sleep(app_data_dir, enabled)?;
    Ok(apply(enabled))
}

/// 백엔드 기동 시 저장된 설정을 적용한다. 설정을 읽지 못해도 기동을 막지 않는다 —
/// 절전이 걸리는 것과 앱이 뜨지 않는 것은 무게가 다르다.
pub fn apply_saved_sleep_prevention(app_data_dir: &Path) -> SleepPreventionStatus {
    match load_prevent_sleep(app_data_dir) {
        Ok(enabled) => apply(enabled),
        Err(error) => {
            let message = error.to_string();
            with_held(|held| {
                held.error = Some(message.clone());
                snapshot(held, false)
            })
        }
    }
}

/// 백엔드 종료 시 억제를 되돌린다. 저장된 설정은 그대로 두므로 다음 기동에서 다시 걸린다.
pub fn release_sleep_prevention() {
    with_held(|held| {
        release_held(held);
    });
}

fn apply(enabled: bool) -> SleepPreventionStatus {
    with_held(|held| {
        if !enabled {
            release_held(held);
        } else if held.guard.is_none() {
            match platform::engage() {
                Ok(guard) => {
                    held.guard = Some(guard);
                    held.mechanism = Some(platform::MECHANISM);
                    held.error = None;
                }
                Err(error) => {
                    held.mechanism = None;
                    held.error = Some(error.to_string());
                }
            }
        }
        snapshot(held, enabled)
    })
}

fn release_held(held: &mut Held) {
    if let Some(guard) = held.guard.take() {
        platform::release(guard);
    }
    held.mechanism = None;
    held.error = None;
}

fn snapshot(held: &Held, enabled: bool) -> SleepPreventionStatus {
    SleepPreventionStatus {
        supported: platform::supported(),
        enabled,
        active: held.guard.is_some(),
        mechanism: held.mechanism.map(str::to_owned),
        error: held.error.clone(),
    }
}

/// 잠금이 poison돼도 절전 억제는 계속 다뤄야 한다. 여기 담긴 것은 OS 자원 손잡이뿐이라
/// 중간에 패닉이 나도 불변식이 깨지지 않는다.
fn with_held<T>(action: impl FnOnce(&mut Held) -> T) -> T {
    let mut held = HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    action(&mut held)
}

fn load_prevent_sleep(app_data_dir: &Path) -> Result<bool, CoreError> {
    let path = app_data_dir.join(SETTINGS_FILE_NAME);
    let Some(stored) = read_private_json::<StoredPowerSettings>(&path)? else {
        return Ok(false);
    };
    ensure_schema_version(stored.schema_version, SETTINGS_SCHEMA_VERSION, "절전 설정")?;
    Ok(stored.prevent_sleep)
}

fn save_prevent_sleep(app_data_dir: &Path, prevent_sleep: bool) -> Result<(), CoreError> {
    write_private_json(
        &app_data_dir.join(SETTINGS_FILE_NAME),
        &StoredPowerSettings {
            schema_version: SETTINGS_SCHEMA_VERSION,
            prevent_sleep,
        },
    )
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};

    use crate::CoreError;

    pub(super) const MECHANISM: &str = "caffeinate";

    pub(super) struct Guard(Child);

    pub(super) fn supported() -> bool {
        locate().is_ok()
    }

    fn locate() -> Result<PathBuf, CoreError> {
        crate::providers::resolve_named_executable(&["caffeinate"])
    }

    /// `-i` 유휴 절전, `-m` 디스크 절전, `-s` 시스템 절전을 막는다. 화면 절전(`-d`)은
    /// 막지 않는다 — 화면이 켜져 있어야 도달되는 것이 아니고 배터리만 축낸다.
    ///
    /// `-w`로 이 프로세스를 지켜보게 해, 백엔드가 SIGKILL로 죽어도 caffeinate가 남아
    /// 아무도 쓰지 않는 절전 억제를 계속 잡고 있는 일이 없게 한다.
    pub(super) fn engage() -> Result<Guard, CoreError> {
        let child = Command::new(locate()?)
            .args(["-i", "-m", "-s", "-w"])
            .arg(std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(Guard(child))
    }

    pub(super) fn release(mut guard: Guard) {
        let _ = guard.0.kill();
        let _ = guard.0.wait();
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};

    use crate::CoreError;

    pub(super) const MECHANISM: &str = "systemd-inhibit";

    pub(super) struct Guard(Child);

    pub(super) fn supported() -> bool {
        locate().is_ok()
    }

    fn locate() -> Result<PathBuf, CoreError> {
        crate::providers::resolve_named_executable(&["systemd-inhibit"])
    }

    /// `systemd-inhibit`는 자기가 실행한 명령이 사는 동안만 락을 잡는다. 그 명령으로
    /// `cat`을 쓰고 stdin을 파이프로 잡아 두면, 우리가 파이프를 닫는 것만으로 `cat`이
    /// EOF로 끝나고 `systemd-inhibit`도 따라 끝난다. 부모를 SIGKILL해도 파이프가 닫히므로
    /// 손자 프로세스가 락 없이 남지 않는다.
    pub(super) fn engage() -> Result<Guard, CoreError> {
        let child = Command::new(locate()?)
            .args([
                "--what=idle:sleep",
                "--mode=block",
                "--who=Agent Manager",
                "--why=원격 접속을 유지하기 위해 자동 절전을 막습니다",
                "cat",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(Guard(child))
    }

    pub(super) fn release(mut guard: Guard) {
        // stdin을 먼저 닫아 정상 종료를 시키고, 그래도 남으면 강제로 끝낸다.
        drop(guard.0.stdin.take());
        let _ = guard.0.kill();
        let _ = guard.0.wait();
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::mpsc::{self, Sender};
    use std::thread::JoinHandle;

    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_AWAYMODE_REQUIRED, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    use crate::CoreError;

    pub(super) const MECHANISM: &str = "SetThreadExecutionState";

    pub(super) struct Guard {
        /// 이 손잡이를 떨어뜨리는 것이 해제 신호다. 스레드의 `recv`가 끊긴 채널을 보고
        /// 깨어나 실행 상태를 원래대로 돌린다.
        _release: Sender<()>,
        thread: JoinHandle<()>,
    }

    pub(super) fn supported() -> bool {
        true
    }

    /// `SetThreadExecutionState`는 **호출한 스레드**의 상태를 바꾸고 그 스레드가 끝나면
    /// 함께 풀린다. 그래서 억제가 필요한 동안만 사는 전용 스레드에서 건다.
    pub(super) fn engage() -> Result<Guard, CoreError> {
        let (release, releases) = mpsc::channel::<()>();
        let (ready, readies) = mpsc::channel::<bool>();
        let thread = std::thread::Builder::new()
            .name("agent-manager-sleep-prevention".to_owned())
            .spawn(move || {
                // Away mode는 지원하지 않는 시스템에서 0을 돌려준다. 그때는 시스템 절전만
                // 막는 조합으로 한 번 더 시도한다.
                let mut engaged = unsafe {
                    SetThreadExecutionState(
                        ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED,
                    )
                };
                if engaged == 0 {
                    engaged =
                        unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
                }
                let _ = ready.send(engaged != 0);
                if engaged == 0 {
                    return;
                }
                let _ = releases.recv();
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            })
            .map_err(|error| {
                CoreError::Runtime(format!("절전 억제 스레드를 시작하지 못했습니다: {error}"))
            })?;
        match readies.recv() {
            Ok(true) => Ok(Guard {
                _release: release,
                thread,
            }),
            _ => {
                let _ = thread.join();
                Err(CoreError::Runtime(
                    "Windows가 절전 억제 요청을 받아들이지 않았습니다".to_owned(),
                ))
            }
        }
    }

    pub(super) fn release(guard: Guard) {
        let Guard { _release, thread } = guard;
        drop(_release);
        let _ = thread.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `HELD` is process-wide, so tests which observe or replace its guard must not run together.
    static HELD_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn missing_settings_default_to_not_preventing_sleep() {
        let _guard = HELD_TEST_LOCK.lock().expect("test lock");
        let directory = tempfile::tempdir().expect("temporary directory");

        let status = sleep_prevention_status(directory.path()).expect("status");

        assert!(!status.enabled);
        assert!(!status.active);
        assert!(!directory.path().join(SETTINGS_FILE_NAME).exists());
    }

    #[test]
    fn the_setting_round_trips_as_versioned_json() {
        let directory = tempfile::tempdir().expect("temporary directory");

        save_prevent_sleep(directory.path(), true).expect("save");

        let value: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.path().join(SETTINGS_FILE_NAME)).expect("settings file"),
        )
        .expect("settings JSON");
        assert_eq!(value["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        assert_eq!(value["preventSleep"], true);
        assert!(load_prevent_sleep(directory.path()).expect("load"));
    }

    #[test]
    fn unknown_schema_versions_are_rejected_instead_of_being_overwritten() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join(SETTINGS_FILE_NAME);
        std::fs::write(&path, br#"{"schemaVersion":2,"preventSleep":true}"#).expect("future file");

        assert!(matches!(
            load_prevent_sleep(directory.path()),
            Err(CoreError::Conflict(_))
        ));
        assert_eq!(
            std::fs::read(&path).expect("unchanged"),
            br#"{"schemaVersion":2,"preventSleep":true}"#
        );
    }

    /// 억제를 걸고 푸는 왕복이 상태를 남기지 않는지 본다. 실제로 걸 수 없는 호스트에서는
    /// 실패 이유가 남고 `active`는 그대로 거짓이어야 한다.
    #[test]
    fn engaging_and_releasing_leaves_no_residual_state() {
        let _guard = HELD_TEST_LOCK.lock().expect("test lock");
        let directory = tempfile::tempdir().expect("temporary directory");

        let engaged = set_sleep_prevention(directory.path(), true).expect("engage");
        assert!(engaged.enabled);
        assert_eq!(engaged.active, engaged.supported);
        assert_eq!(engaged.error.is_none(), engaged.supported);

        let released = set_sleep_prevention(directory.path(), false).expect("release");
        assert!(!released.enabled);
        assert!(!released.active);
        assert!(released.error.is_none());
        assert!(released.mechanism.is_none());
    }
}
