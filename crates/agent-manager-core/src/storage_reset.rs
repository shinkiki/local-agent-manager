use std::fs::{self, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use serde::Serialize;
use uuid::Uuid;

use crate::CoreError;

const RESET_MARKER: &str = "account-storage-reset-v1.json";
const LEGACY_FILES: [&str; 3] = [
    "scheduled-requests.json",
    "session-catalog-v1.json",
    "session-supplements.json",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResetMarker {
    schema_version: u32,
    completed_at: i64,
    removed: Vec<&'static str>,
}

/// Removes only the obsolete Agent Manager-owned stores once, before supervisors start.
/// Provider homes and the manager-state settings store are deliberately outside this allowlist.
pub fn prepare_account_management_storage(app_data_dir: &Path) -> Result<(), CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let marker_path = app_data_dir.join(RESET_MARKER);
    if marker_path.is_file() {
        return Ok(());
    }
    let mut removed = Vec::new();
    for file_name in LEGACY_FILES {
        let path = app_data_dir.join(file_name);
        if path.is_file() {
            fs::remove_file(path)?;
            removed.push(file_name);
        }
    }
    let marker = ResetMarker {
        schema_version: 1,
        completed_at: crate::storage_reset::now_ms(),
        removed,
    };
    let temporary = app_data_dir.join(format!(".{RESET_MARKER}.{}.tmp", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(&marker)?)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    fs::rename(temporary, marker_path)?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_only_allowlisted_agent_manager_data_once() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path().join("app-data");
        fs::create_dir(&app_data).unwrap();
        for name in LEGACY_FILES {
            fs::write(app_data.join(name), b"legacy").unwrap();
        }
        for preserved in [
            "manager-state.json",
            "remote-access.json",
            "system-automation.json",
        ] {
            fs::write(app_data.join(preserved), b"keep").unwrap();
        }
        for provider_home in [".codex", ".claude"] {
            let history = temp
                .path()
                .join(provider_home)
                .join("history/session.jsonl");
            fs::create_dir_all(history.parent().unwrap()).unwrap();
            fs::write(history, b"provider history").unwrap();
        }
        prepare_account_management_storage(&app_data).unwrap();
        for name in LEGACY_FILES {
            assert!(!app_data.join(name).exists());
        }
        for preserved in [
            "manager-state.json",
            "remote-access.json",
            "system-automation.json",
        ] {
            assert_eq!(fs::read(app_data.join(preserved)).unwrap(), b"keep");
        }
        for provider_home in [".codex", ".claude"] {
            assert_eq!(
                fs::read(
                    temp.path()
                        .join(provider_home)
                        .join("history/session.jsonl")
                )
                .unwrap(),
                b"provider history"
            );
        }
        fs::write(
            app_data.join("scheduled-requests.json"),
            b"new legacy-shaped file",
        )
        .unwrap();
        prepare_account_management_storage(&app_data).unwrap();
        assert!(app_data.join("scheduled-requests.json").is_file());
    }
}
