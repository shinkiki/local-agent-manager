//! 관리 프로세스에 신호를 보내고 살아 있는지 확인하는 유닉스 원시 연산.
//!
//! `chat`·`terminal`·`external_processes`·`cypress_runs`가 각자 `unsafe { libc::kill(..) }`을
//! 부르고 `ESRCH`·`EPERM` 판정을 따로 적어 두던 것을 한곳에 모았다. 신호를 보낼 대상과
//! 실패했을 때의 오류 문구·중단 여부는 모듈마다 다르므로, 여기서는 커널 호출과 errno 해석만
//! 담당하고 판단은 호출부에 남긴다.

use std::time::Duration;

/// 신호를 실제로 전달했는지, 대상이 이미 사라져 있었는지.
///
/// `Gone`은 `ESRCH`뿐이다. 권한이 없어 보내지 못한 `EPERM`은 대상이 살아 있다는 뜻이므로
/// 오류로 돌려주고, 그것을 종료로 볼지 실패로 볼지는 호출부가 정한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignalDelivery {
    Delivered,
    Gone,
}

impl SignalDelivery {
    pub(crate) fn was_delivered(self) -> bool {
        self == Self::Delivered
    }
}

/// 종료 사다리가 어디까지 올라가 끝났는지.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopEscalation {
    /// 첫 신호를 보내려 할 때 대상이 이미 사라져 있었다.
    AlreadyGone,
    /// 정상 종료 신호만으로 시한 안에 끝났다.
    Graceful,
    /// 강제 종료까지 올린 뒤 끝났다.
    Forced,
    /// 강제 종료 신호를 보낸 뒤에도 종료를 확인하지 못했다.
    Stuck,
}

/// 정상 종료를 먼저 청하고, 시한 안에 끝나지 않으면 강제 종료로 올리는 종료 사다리.
///
/// 채팅 런타임(`chat`)과 터미널 런타임(`terminal`)이 "보내고 기다리고, 안 죽으면 올려
/// 보내고 다시 기다린다"는 같은 순서를 각자 펼쳐 두고 있었다. 단계마다 어떤 신호를 어떻게
/// 보내는지(그룹이냐 단일 PID냐, 보내기 실패를 실패로 볼 것이냐)와 종료를 무엇으로
/// 확인하는지는 호출부마다 다르므로 그 셋만 받는다. 결말을 오류 문구로 옮기는 것도
/// 호출부 몫이다 — 여기서는 어디까지 올라갔는지만 돌려준다.
pub(crate) fn escalate_stop<E>(
    graceful: (impl FnOnce() -> Result<SignalDelivery, E>, Duration),
    forced: (impl FnOnce() -> Result<SignalDelivery, E>, Duration),
    mut exited_within: impl FnMut(Duration) -> Result<bool, E>,
) -> Result<StopEscalation, E> {
    let (send_graceful, graceful_timeout) = graceful;
    let (send_forced, forced_timeout) = forced;
    if send_graceful()? == SignalDelivery::Gone {
        return Ok(StopEscalation::AlreadyGone);
    }
    if exited_within(graceful_timeout)? {
        return Ok(StopEscalation::Graceful);
    }
    send_forced()?;
    if exited_within(forced_timeout)? {
        Ok(StopEscalation::Forced)
    } else {
        Ok(StopEscalation::Stuck)
    }
}

#[derive(Clone, Copy)]
enum SignalTarget {
    Process(u32),
    ProcessGroup(u32),
}

/// `ps` 실행 파일 경로. macOS는 `/bin/ps`, 데비안 계열은 `/usr/bin/ps`에 둔다.
///
/// PATH나 사용자 디렉터리는 후보로 삼지 않는다. 이 조회는 관리 프로세스의 신원을 확인해
/// 신호를 보낼지 정하는 데 쓰이므로, 사용자가 바꿔 넣을 수 있는 자리에서 찾은 `ps`를
/// 믿으면 확인 자체가 의미를 잃는다.
pub(crate) fn ps_executable() -> Result<&'static std::path::Path, std::io::Error> {
    ["/bin/ps", "/usr/bin/ps"]
        .into_iter()
        .map(std::path::Path::new)
        .find(|path| path.is_file())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "ps 실행 파일을 찾을 수 없습니다",
            )
        })
}

/// 단일 PID에 신호를 보낸다. `signal`이 0이면 전달 없이 존재 여부만 확인한다.
pub(crate) fn signal_pid(pid: u32, signal: libc::c_int) -> Result<SignalDelivery, std::io::Error> {
    signal_target(SignalTarget::Process(pid), signal)
}

/// PID를 그룹 ID로 삼아 프로세스 그룹 전체에 신호를 보낸다.
pub(crate) fn signal_process_group(
    pid: u32,
    signal: libc::c_int,
) -> Result<SignalDelivery, std::io::Error> {
    signal_target(SignalTarget::ProcessGroup(pid), signal)
}

/// PID가 아직 존재하는지 확인한다. 신호 권한이 없어도(`EPERM`) 프로세스 자체는 존재한다.
pub(crate) fn pid_exists(pid: u32) -> Result<bool, std::io::Error> {
    existence(signal_pid(pid, 0))
}

/// 프로세스 그룹이 아직 존재하는지 확인한다.
pub(crate) fn process_group_exists(pid: u32) -> Result<bool, std::io::Error> {
    existence(signal_process_group(pid, 0))
}

/// 자신의 자식이었던 프로세스가 좀비로 남지 않게 회수한다. 자식이 아니면 아무 일도 없다.
pub(crate) fn reap_zombie_child(pid: u32) {
    let mut status: libc::c_int = 0;
    // SAFETY: WNOHANG이라 회수할 것이 없으면 곧바로 돌아온다. status는 지역 변수다.
    unsafe {
        libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG);
    }
}

fn signal_target(
    target: SignalTarget,
    signal: libc::c_int,
) -> Result<SignalDelivery, std::io::Error> {
    // SAFETY: kill과 killpg는 신호만 보낼 뿐 메모리를 건드리지 않는다. 자식을
    // process_group(0)으로 띄우면 그 PID가 곧 그룹 ID다.
    let result = unsafe {
        match target {
            SignalTarget::Process(pid) => libc::kill(pid as libc::pid_t, signal),
            SignalTarget::ProcessGroup(pid) => libc::killpg(pid as libc::pid_t, signal),
        }
    };
    delivery(result)
}

fn delivery(result: libc::c_int) -> Result<SignalDelivery, std::io::Error> {
    if result == 0 {
        return Ok(SignalDelivery::Delivered);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(SignalDelivery::Gone)
    } else {
        Err(error)
    }
}

fn existence(probe: Result<SignalDelivery, std::io::Error>) -> Result<bool, std::io::Error> {
    match probe {
        Ok(delivery) => Ok(delivery.was_delivered()),
        Err(error) if error.raw_os_error() == Some(libc::EPERM) => Ok(true),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probing_self_reports_alive() {
        let pid = std::process::id();
        assert!(matches!(signal_pid(pid, 0), Ok(SignalDelivery::Delivered)));
        assert!(pid_exists(pid).expect("자기 PID 조회"));
        assert!(process_group_exists(pid_group_leader()).expect("자기 그룹 조회"));
    }

    #[test]
    fn probing_reaped_child_reports_gone() {
        let mut child = std::process::Command::new("/usr/bin/true")
            .spawn()
            .expect("자식 프로세스 시작");
        let pid = child.id();
        child.wait().expect("자식 종료 대기");
        assert!(matches!(
            signal_pid(pid, libc::SIGTERM),
            Ok(SignalDelivery::Gone)
        ));
        assert!(!pid_exists(pid).expect("종료된 PID 조회"));
    }

    #[test]
    fn ps_executable_resolves_to_a_system_path() {
        let path = ps_executable().expect("ps 실행 파일");
        assert!(
            path.starts_with("/bin") || path.starts_with("/usr/bin"),
            "시스템 경로여야 한다: {}",
            path.display()
        );
    }

    /// 사다리의 네 결말을 신호·확인을 흉내 낸 닫힘으로 돌려본다. 실제 신호를 쓰면
    /// 강제 종료 단계까지 버티는 프로세스를 만들어야 해서 확인할 수 없는 분기다.
    #[test]
    fn escalation_reports_how_far_the_ladder_had_to_climb() {
        let ladder = |graceful_delivery, exits_after: usize| {
            let mut waits = 0usize;
            escalate_stop::<()>(
                (|| Ok(graceful_delivery), Duration::ZERO),
                (|| Ok(SignalDelivery::Delivered), Duration::ZERO),
                |_| {
                    waits += 1;
                    Ok(waits >= exits_after)
                },
            )
        };
        assert_eq!(
            ladder(SignalDelivery::Gone, 1),
            Ok(StopEscalation::AlreadyGone)
        );
        assert_eq!(
            ladder(SignalDelivery::Delivered, 1),
            Ok(StopEscalation::Graceful)
        );
        assert_eq!(
            ladder(SignalDelivery::Delivered, 2),
            Ok(StopEscalation::Forced)
        );
        assert_eq!(
            ladder(SignalDelivery::Delivered, 3),
            Ok(StopEscalation::Stuck)
        );
    }

    /// 강제 종료 신호를 보내지 못하면 그 오류가 그대로 올라온다 — 더 올릴 단계가 없어
    /// 호출부가 실패로 다뤄야 하는 자리다.
    #[test]
    fn escalation_surfaces_a_failed_forced_signal() {
        let outcome = escalate_stop(
            (|| Ok(SignalDelivery::Delivered), Duration::ZERO),
            (|| Err("강제 종료 실패"), Duration::ZERO),
            |_| Ok(false),
        );
        assert_eq!(outcome, Err("강제 종료 실패"));
    }

    fn pid_group_leader() -> u32 {
        // SAFETY: getpgrp는 인자 없이 현재 프로세스 그룹 ID만 돌려준다.
        (unsafe { libc::getpgrp() }) as u32
    }
}
