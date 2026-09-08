//! 관리 프로세스에 신호를 보내고 살아 있는지 확인하는 유닉스 원시 연산.
//!
//! `chat`·`terminal`·`external_processes`·`cypress_runs`가 각자 `unsafe { libc::kill(..) }`을
//! 부르고 `ESRCH`·`EPERM` 판정을 따로 적어 두던 것을 한곳에 모았다. 신호를 보낼 대상과
//! 실패했을 때의 오류 문구·중단 여부는 모듈마다 다르므로, 여기서는 커널 호출과 errno 해석만
//! 담당하고 판단은 호출부에 남긴다.

/// 신호를 실제로 전달했는지, 대상이 이미 사라져 있었는지.
///
/// `Gone`은 `ESRCH`뿐이다. 권한이 없어 보내지 못한 `EPERM`은 대상이 살아 있다는 뜻이므로
/// 오류로 돌려주고, 그것을 종료로 볼지 실패로 볼지는 호출부가 정한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SignalDelivery {
    Delivered,
    Gone,
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
    // SAFETY: kill은 신호만 보낼 뿐 메모리를 건드리지 않는다.
    let result = unsafe { libc::kill(pid as libc::pid_t, signal) };
    delivery(result)
}

/// PID를 그룹 ID로 삼아 프로세스 그룹 전체에 신호를 보낸다.
pub(crate) fn signal_process_group(
    pid: u32,
    signal: libc::c_int,
) -> Result<SignalDelivery, std::io::Error> {
    // SAFETY: killpg도 신호만 보낸다. 자식을 process_group(0)으로 띄우면 그 PID가 곧 그룹 ID다.
    let result = unsafe { libc::killpg(pid as libc::pid_t, signal) };
    delivery(result)
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
        Ok(SignalDelivery::Delivered) => Ok(true),
        Ok(SignalDelivery::Gone) => Ok(false),
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

    fn pid_group_leader() -> u32 {
        // SAFETY: getpgrp는 인자 없이 현재 프로세스 그룹 ID만 돌려준다.
        (unsafe { libc::getpgrp() }) as u32
    }
}
