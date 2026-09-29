// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // C12-11. Windows 브라우저 차단 셰임은 이 실행 파일의 하드링크다. 그 호출이면 창·단일
    // 인스턴스 잠금·백엔드 어느 것도 만들기 전에 조용히 끝난다.
    agent_manager_core::exit_if_invoked_as_browser_shim();
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--backend") {
        if let Err(error) = agent_manager_core::run_remote_server_from_args(args) {
            eprintln!("Agent Manager backend failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    agent_manager_tauri_lib::run()
}
