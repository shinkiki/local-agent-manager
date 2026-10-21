fn main() -> Result<(), Box<dyn std::error::Error>> {
    // C12-11. Windows 브라우저 차단 셰임은 이 실행 파일의 하드링크다. 그 호출이면 서버를
    // 띄우기 전에 조용히 끝난다.
    agent_manager_core::exit_if_invoked_as_browser_shim();
    // C9-21. 백엔드가 띄운 `ssh`가 이 실행 파일을 askpass로 부른 경우 값 한 줄만 내고 끝난다.
    agent_manager_core::exit_if_invoked_as_ssh_askpass();
    agent_manager_core::run_remote_server_from_args(std::env::args().skip(1))
}
