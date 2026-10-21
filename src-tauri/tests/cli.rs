//! Exercise the packaged entry point, not just its argument classifier: a CLI
//! regression used to launch a second GUI and never return to the calling agent.
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn invoke(args: &[&str]) -> Output {
    let app_data = tempfile::tempdir().expect("isolated app data");
    let mut child = Command::new(env!("CARGO_BIN_EXE_agent-manager"))
        .args(args)
        .env("AGENT_MANAGER_APP_DATA_DIR", app_data.path())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start CLI");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if child.try_wait().expect("poll CLI").is_some() {
            return child.wait_with_output().expect("CLI output");
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().expect("timed out CLI output");
            panic!("CLI did not exit for {args:?}: {output:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn db_list_without_backend_prefix_returns_json_and_exits() {
    let direct = invoke(&["db", "list"]);
    let legacy = invoke(&["--backend", "db", "list"]);
    for output in [&direct, &legacy] {
        assert!(output.status.success(), "{output:?}");
        let json: serde_json::Value = serde_json::from_slice(&output.stdout).expect("DB list JSON");
        assert_eq!(json["connections"], serde_json::json!([]));
    }
    assert_eq!(direct.stdout, legacy.stdout);
}

#[test]
fn other_cli_commands_reject_missing_operation_without_opening_gui() {
    for command in ["db", "ssh", "sessions", "secret"] {
        let output = invoke(&[command]);
        assert_eq!(output.status.code(), Some(1), "{command}: {output:?}");
        assert!(!output.stderr.is_empty(), "{command}: {output:?}");
    }
}

#[test]
fn unknown_arguments_fail_with_usage_without_opening_gui() {
    for args in [
        vec!["dbb", "list"],
        vec!["--unknown"],
        vec!["--help", "unexpected"],
        vec!["--version", "unexpected"],
    ] {
        let output = invoke(&args);
        assert_eq!(output.status.code(), Some(2), "{args:?}: {output:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains("Usage:"));
    }
}

#[test]
fn help_and_version_exit_successfully_without_opening_gui() {
    for arg in ["-h", "--help", "-V", "--version"] {
        let output = invoke(&[arg]);
        assert!(output.status.success(), "{arg}: {output:?}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        if arg == "-h" || arg == "--help" {
            assert!(stdout.contains("Usage:"), "{stdout}");
        } else {
            assert!(stdout.contains(env!("CARGO_PKG_VERSION")), "{stdout}");
        }
    }
}
