use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static NEXT_SANDBOX: AtomicU64 = AtomicU64::new(0);

struct Sandbox(PathBuf);

impl Sandbox {
    fn new() -> Self {
        // V2/G7: every child gets its own working folder and explicit app-data path.
        // No invocation can fall through to the host's dist or app-data defaults.
        let root = std::env::temp_dir().join(format!(
            "agent-manager-cli-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT_SANDBOX.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn run(&self, args: &[&str]) -> Output {
        let mut child = Command::new(env!("CARGO_BIN_EXE_agent-manager-server"))
            .current_dir(&self.0)
            .arg("--app-data-dir")
            .arg(self.0.join("app-data"))
            .arg("--static-dir")
            .arg(self.0.join("missing-static"))
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!("V2: CLI did not exit for {args:?}: {output:?}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        assert_eq!(
            fs::read_dir(&self.0).unwrap().count(),
            0,
            "G7: CLI early exit created files for {args:?}",
        );
        output
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn v2_help_exits_successfully_before_static_path_validation() {
    for flag in ["--help", "-h"] {
        let output = Sandbox::new().run(&[flag]);
        assert!(output.status.success(), "{flag}: {output:?}");
        let stdout = String::from_utf8(output.stdout).unwrap();
        assert!(
            stdout.starts_with("Usage: agent-manager-server "),
            "{stdout}"
        );
        assert!(stdout.contains("--app-data-dir PATH"), "{stdout}");
        assert!(output.stderr.is_empty(), "{flag}: {:?}", output.stderr);
    }
}

#[test]
fn v2_invalid_arguments_exit_with_specific_diagnostics_before_startup() {
    let cases: &[(&[&str], &str)] = &[
        (&["--unknown-cli-option"], "--unknown-cli-option"),
        (&["--port", "0"], "--port"),
        (&["--port", "65536"], "--port"),
        (&["--port", "not-a-port"], "--port"),
        (&["--port"], "--port"),
        (&["--app-data-dir"], "--app-data-dir"),
    ];
    for (args, expected) in cases {
        let output = Sandbox::new().run(args);
        assert_eq!(output.status.code(), Some(1), "{args:?}: {output:?}");
        assert!(output.stdout.is_empty(), "{args:?}: {:?}", output.stdout);
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(stderr.contains(expected), "{args:?}: {stderr}");
        // A static-path error would mask the argument failure in this fixture.
        assert!(!stderr.contains("정적 파일 경로"), "{args:?}: {stderr}");
    }
}

#[test]
fn v2_missing_static_directory_is_reported_without_creating_app_data() {
    let output = Sandbox::new().run(&[]);
    assert_eq!(output.status.code(), Some(1), "{output:?}");
    assert!(output.stdout.is_empty(), "{:?}", output.stdout);
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(
        stderr.contains("정적 파일 경로를 열 수 없습니다"),
        "{stderr}"
    );
}
