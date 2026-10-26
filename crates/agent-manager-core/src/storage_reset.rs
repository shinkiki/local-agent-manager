use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::app_data_file::write_private_json;
use crate::clock::now_ms;
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
    // S1: 잘못 놓인 완료 표시나 조회 오류를 "아직 초기화하지 않음"으로 취급하면
    // 구형 파일을 지운 뒤 표시 기록에서 실패한다. 삭제 전에 표시 상태부터 확인한다.
    match fs::metadata(&marker_path) {
        Ok(metadata) if metadata.is_file() => return Ok(()),
        Ok(_) => {
            return Err(CoreError::InvalidInput(
                "저장소 초기화 완료 표시가 일반 파일이 아닙니다".to_owned(),
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
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
        completed_at: now_ms(),
        removed,
    };
    write_private_json(&marker_path, &marker)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s1_invalid_marker_preserves_legacy_files_and_allows_retry() {
        let temp = tempfile::tempdir().unwrap();
        let app_data = temp.path();
        let marker_path = app_data.join(RESET_MARKER);
        fs::create_dir(&marker_path).unwrap();
        for name in LEGACY_FILES {
            fs::write(app_data.join(name), b"legacy").unwrap();
        }

        assert!(matches!(
            prepare_account_management_storage(app_data),
            Err(CoreError::InvalidInput(_))
        ));
        for name in LEGACY_FILES {
            assert_eq!(fs::read(app_data.join(name)).unwrap(), b"legacy");
        }
        assert!(marker_path.is_dir());

        // 완료 표시 경로만 복구하면 같은 저장소로 안전하게 다시 시도할 수 있다.
        fs::remove_dir(&marker_path).unwrap();
        prepare_account_management_storage(app_data).unwrap();
        for name in LEGACY_FILES {
            assert!(!app_data.join(name).exists());
        }
        assert!(marker_path.is_file());
    }

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
