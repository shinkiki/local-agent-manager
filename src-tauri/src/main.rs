// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // C12-11. Windows 브라우저 차단 셰임은 이 실행 파일의 하드링크다. 그 호출이면 창·단일
    // 인스턴스 잠금·백엔드 어느 것도 만들기 전에 조용히 끝난다.
    agent_manager_core::exit_if_invoked_as_browser_shim();
    // C9-21. 백엔드가 띄운 `ssh`가 이 실행 파일을 askpass로 부른 경우 값 한 줄만 내고 끝난다.
    agent_manager_core::exit_if_invoked_as_ssh_askpass();
    let args: Vec<String> = std::env::args().skip(1).collect();
    // CLI calls must finish before Tauri creates windows or claims the desktop
    // instance. Agents may omit the pointer file's legacy --backend prefix.
    match args.first().map(String::as_str) {
        None => agent_manager_tauri_lib::run(),
        Some("--backend") => run_cli(args.into_iter().skip(1)),
        Some("db" | "ssh" | "sessions" | "secret" | "migrate-keychain-v2") => {
            run_cli(args.into_iter())
        }
        Some("-h" | "--help") if args.len() == 1 => println!("{USAGE}"),
        Some("-V" | "--version") if args.len() == 1 => {
            println!("Agent Manager {}", env!("CARGO_PKG_VERSION"));
        }
        Some(_) => {
            eprintln!("알 수 없는 명령 또는 인자입니다.\n\n{USAGE}");
            std::process::exit(2);
        }
    }
}

const USAGE: &str = "Usage: agent-manager [COMMAND]\n\
    인자 없이 실행하면 데스크톱 앱을 엽니다.\n\n\
    Commands:\n\
      db ...                  데이터베이스 목록·조회·변경\n\
      ssh ...                 SSH 연결 조회·실행\n\
      sessions ...            정책 범위 내 세션 조회\n\
      secret ...              비밀값 요청·대행 실행\n\
      migrate-keychain-v2 ...  기존 키체인 마이그레이션\n\
      --backend ...           백엔드 서버 또는 기존 CLI 호출\n\
      -h, --help              사용법\n\
      -V, --version           버전";

fn run_cli(args: impl Iterator<Item = String>) {
    if let Err(error) = agent_manager_core::run_remote_server_from_args(args) {
        eprintln!("Agent Manager CLI/backend failed: {error}");
        std::process::exit(1);
    }
}
