// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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
