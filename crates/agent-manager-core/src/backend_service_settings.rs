use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::app_data_file::write_private_json;
use crate::store_lock;
use crate::CoreError;

const SETTINGS_SCHEMA_VERSION: u32 = 3;
const IDENTITY_SETTINGS_SCHEMA_VERSION: u32 = 2;
const LEGACY_SETTINGS_SCHEMA_VERSION: u32 = 1;
const SETTINGS_FILE_NAME: &str = "backend-service-settings.json";
const SETTINGS_LOCK_FILE_NAME: &str = "backend-service-settings-v1.lock";

pub const DEFAULT_BACKEND_SERVICE_PORT: u16 = 54_178;
/// 원격 UI에 데스크톱과 같은 변경 권한을 주는 것이 기본값이다. 원격 경로 자체가
/// Tailscale 서비스를 켜야만 열리는 명시적 선택이고, 이 설정이 생기기 전의 데스크톱
/// 동작도 그러했다. 좁히려면 설정 → 백엔드 서비스에서 끈다.
pub const DEFAULT_BACKEND_REMOTE_WRITE: bool = true;
pub const MIN_BACKEND_SERVICE_PORT: u16 = 1024;
pub const MAX_BACKEND_SERVICE_PORT: u16 = u16::MAX;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendServiceSettings {
    pub port: u16,
    /// Stable, non-secret identity for the Agent Manager-owned app-data store.
    /// Clients compare this with `/api/access` before issuing domain requests so
    /// an unrelated backend on the same loopback port cannot be reused.
    pub store_id: String,
    /// 원격(Tailscale) UI에 데스크톱과 같은 변경 권한을 줄지. G11의 원격 write
    /// 모드를 켜고 끄는 단일 설정 지점이며, 실행 중인 백엔드에도 즉시 반영된다.
    pub remote_write: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBackendServiceSettings {
    schema_version: u32,
    port: u16,
    store_id: String,
    remote_write: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsEnvelope {
    schema_version: u32,
}

/// 원격 write 설정이 들어오기 전 스키마. 그때의 데스크톱은 Tailscale을 켜면 항상
/// 원격 write였으므로, 이관은 [`DEFAULT_BACKEND_REMOTE_WRITE`]로 그 동작을 유지한다.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityStoredBackendServiceSettings {
    schema_version: u32,
    port: u16,
    store_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyStoredBackendServiceSettings {
    schema_version: u32,
    port: u16,
}

/// Loads the backend endpoint selected for this Agent Manager app-data store.
///
/// This uses a short-lived settings lock, not [`crate::BackendOwnershipLease`],
/// so a desktop client can read the endpoint before electing or starting the
/// process that owns the domain backend.
pub fn load_backend_service_settings(
    app_data_dir: impl AsRef<Path>,
) -> Result<BackendServiceSettings, CoreError> {
    with_settings_lock(app_data_dir.as_ref(), |canonical_app_data_dir| {
        load_settings_unlocked(canonical_app_data_dir)
    })
}

/// Atomically stores the backend endpoint selected for this app-data store.
pub fn save_backend_service_settings(
    app_data_dir: impl AsRef<Path>,
    port: u16,
) -> Result<BackendServiceSettings, CoreError> {
    validate_port(port)?;
    mutate_backend_service_settings(app_data_dir, |settings| {
        settings.port = port;
    })
}

/// 원격 UI에 변경 권한을 줄지 저장한다. 화면 토글과 헤드리스 기동 인자가 함께
/// 쓰는 유일한 저장 지점이다.
pub fn save_backend_service_remote_write(
    app_data_dir: impl AsRef<Path>,
    remote_write: bool,
) -> Result<BackendServiceSettings, CoreError> {
    mutate_backend_service_settings(app_data_dir, |settings| {
        settings.remote_write = remote_write;
    })
}

/// 잠금 아래에서 기존 설정을 읽어 변경하고 다시 쓴 뒤 최신 설정을 돌려준다.
fn mutate_backend_service_settings(
    app_data_dir: impl AsRef<Path>,
    mutate: impl FnOnce(&mut BackendServiceSettings),
) -> Result<BackendServiceSettings, CoreError> {
    with_settings_lock(app_data_dir.as_ref(), |canonical_app_data_dir| {
        let mut settings = load_settings_unlocked(canonical_app_data_dir)?;
        mutate(&mut settings);
        save_settings_unlocked(canonical_app_data_dir, &settings)?;
        load_settings_unlocked(canonical_app_data_dir)
    })
}

fn validate_port(port: u16) -> Result<(), CoreError> {
    if (MIN_BACKEND_SERVICE_PORT..=MAX_BACKEND_SERVICE_PORT).contains(&port) {
        Ok(())
    } else {
        Err(CoreError::InvalidInput(format!(
            "백엔드 서비스 포트는 {MIN_BACKEND_SERVICE_PORT}~{MAX_BACKEND_SERVICE_PORT} 범위여야 합니다"
        )))
    }
}

fn with_settings_lock<T>(
    app_data_dir: &Path,
    action: impl FnOnce(&Path) -> Result<T, CoreError>,
) -> Result<T, CoreError> {
    fs::create_dir_all(app_data_dir)?;
    let canonical_app_data_dir = fs::canonicalize(app_data_dir)?;
    let _lock = store_lock::acquire(
        &canonical_app_data_dir,
        SETTINGS_LOCK_FILE_NAME,
        "백엔드 서비스 설정",
    )?;
    action(&canonical_app_data_dir)
}

fn load_settings_unlocked(app_data_dir: &Path) -> Result<BackendServiceSettings, CoreError> {
    let path = app_data_dir.join(SETTINGS_FILE_NAME);
    if !path.exists() {
        let settings = new_settings(DEFAULT_BACKEND_SERVICE_PORT);
        save_settings_unlocked(app_data_dir, &settings)?;
        return Ok(settings);
    }
    let bytes = fs::read(path)?;
    let envelope: SettingsEnvelope = serde_json::from_slice(&bytes)?;
    match envelope.schema_version {
        SETTINGS_SCHEMA_VERSION => {
            let stored: StoredBackendServiceSettings = serde_json::from_slice(&bytes)?;
            validate_port(stored.port)?;
            let store_id = validate_store_id(&stored.store_id)?;
            Ok(BackendServiceSettings {
                port: stored.port,
                store_id,
                remote_write: stored.remote_write,
            })
        }
        IDENTITY_SETTINGS_SCHEMA_VERSION => {
            let stored: IdentityStoredBackendServiceSettings = serde_json::from_slice(&bytes)?;
            debug_assert_eq!(stored.schema_version, IDENTITY_SETTINGS_SCHEMA_VERSION);
            validate_port(stored.port)?;
            let settings = BackendServiceSettings {
                port: stored.port,
                store_id: validate_store_id(&stored.store_id)?,
                remote_write: DEFAULT_BACKEND_REMOTE_WRITE,
            };
            save_settings_unlocked(app_data_dir, &settings)?;
            Ok(settings)
        }
        LEGACY_SETTINGS_SCHEMA_VERSION => {
            let stored: LegacyStoredBackendServiceSettings = serde_json::from_slice(&bytes)?;
            debug_assert_eq!(stored.schema_version, LEGACY_SETTINGS_SCHEMA_VERSION);
            validate_port(stored.port)?;
            let settings = new_settings(stored.port);
            save_settings_unlocked(app_data_dir, &settings)?;
            Ok(settings)
        }
        schema_version => Err(CoreError::Conflict(format!(
            "지원하지 않는 백엔드 서비스 설정 버전입니다: {schema_version}"
        ))),
    }
}

fn new_settings(port: u16) -> BackendServiceSettings {
    BackendServiceSettings {
        port,
        store_id: Uuid::new_v4().to_string(),
        remote_write: DEFAULT_BACKEND_REMOTE_WRITE,
    }
}

fn validate_store_id(store_id: &str) -> Result<String, CoreError> {
    let parsed = Uuid::parse_str(store_id).map_err(|_| {
        CoreError::InvalidInput("백엔드 서비스 저장소 식별자가 올바르지 않습니다".to_owned())
    })?;
    let canonical = parsed.to_string();
    if canonical != store_id {
        return Err(CoreError::InvalidInput(
            "백엔드 서비스 저장소 식별자가 올바르지 않습니다".to_owned(),
        ));
    }
    Ok(canonical)
}

impl From<&BackendServiceSettings> for StoredBackendServiceSettings {
    fn from(settings: &BackendServiceSettings) -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            port: settings.port,
            store_id: settings.store_id.clone(),
            remote_write: settings.remote_write,
        }
    }
}

fn save_settings_unlocked(
    app_data_dir: &Path,
    settings: &BackendServiceSettings,
) -> Result<(), CoreError> {
    let stored = StoredBackendServiceSettings::from(settings);
    write_private_json(&app_data_dir.join(SETTINGS_FILE_NAME), &stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_settings_create_a_stable_store_identity_with_the_default_port() {
        let directory = tempfile::tempdir().expect("temporary directory");

        let first = load_backend_service_settings(directory.path()).expect("load defaults");
        let second = load_backend_service_settings(directory.path()).expect("reload defaults");

        assert_eq!(first.port, DEFAULT_BACKEND_SERVICE_PORT);
        assert_eq!(first, second);
        assert_eq!(
            Uuid::parse_str(&first.store_id)
                .expect("store UUID")
                .to_string(),
            first.store_id
        );
        assert!(directory.path().join(SETTINGS_FILE_NAME).is_file());
    }

    #[test]
    fn settings_round_trip_as_versioned_json() {
        let directory = tempfile::tempdir().expect("temporary directory");

        let saved = save_backend_service_settings(directory.path(), 5188).expect("save settings");

        assert_eq!(saved.port, 5188);
        assert!(Uuid::parse_str(&saved.store_id).is_ok());
        assert_eq!(
            load_backend_service_settings(directory.path()).expect("load settings"),
            saved
        );
        let value: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.path().join(SETTINGS_FILE_NAME)).expect("settings file"),
        )
        .expect("settings JSON");
        assert_eq!(value["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        assert_eq!(value["port"], 5188);
        assert_eq!(value["storeId"], saved.store_id);
        assert_eq!(value["remoteWrite"], DEFAULT_BACKEND_REMOTE_WRITE);
    }

    #[test]
    fn remote_write_is_stored_beside_the_port_and_keeps_the_identity() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let initial = load_backend_service_settings(directory.path()).expect("initial settings");
        assert_eq!(initial.remote_write, DEFAULT_BACKEND_REMOTE_WRITE);

        let disabled = save_backend_service_remote_write(directory.path(), false)
            .expect("disable remote write");

        assert!(!disabled.remote_write);
        assert_eq!(disabled.store_id, initial.store_id);
        assert_eq!(disabled.port, initial.port);
        // 포트 저장은 원격 write 설정을 건드리지 않는다.
        assert!(
            !save_backend_service_settings(directory.path(), 5188)
                .expect("save port")
                .remote_write
        );
        assert!(
            save_backend_service_remote_write(directory.path(), true)
                .expect("enable remote write")
                .remote_write
        );
    }

    /// 원격 write 설정이 없던 저장본은 그때의 동작(Tailscale을 켜면 원격도 변경 가능)을
    /// 그대로 유지한 채 이관돼야 한다. 갱신 뒤 폰에서 갑자기 읽기 전용이 되면 안 된다.
    #[test]
    fn schema_v2_is_migrated_with_remote_write_left_on() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store_id = "7cb5018a-4a90-438a-a2c4-d1fd5c660cec";
        fs::write(
            directory.path().join(SETTINGS_FILE_NAME),
            format!(r#"{{"schemaVersion":2,"port":5217,"storeId":"{store_id}"}}"#),
        )
        .expect("identity settings");

        let migrated = load_backend_service_settings(directory.path()).expect("migrated settings");

        assert_eq!(migrated.port, 5217);
        assert_eq!(migrated.store_id, store_id);
        assert!(migrated.remote_write);
        let value: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.path().join(SETTINGS_FILE_NAME)).expect("migrated file"),
        )
        .expect("migrated JSON");
        assert_eq!(value["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        assert_eq!(value["remoteWrite"], true);
    }

    #[test]
    fn saving_a_new_port_preserves_the_store_identity() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let initial = load_backend_service_settings(directory.path()).expect("initial settings");

        let saved = save_backend_service_settings(directory.path(), 5188).expect("save settings");

        assert_eq!(saved.port, 5188);
        assert_eq!(saved.store_id, initial.store_id);
    }

    #[test]
    fn schema_v1_is_migrated_atomically_without_changing_the_port() {
        let directory = tempfile::tempdir().expect("temporary directory");
        fs::write(
            directory.path().join(SETTINGS_FILE_NAME),
            r#"{"schemaVersion":1,"port":5217}"#,
        )
        .expect("legacy settings");

        let migrated = load_backend_service_settings(directory.path()).expect("migrated settings");

        assert_eq!(migrated.port, 5217);
        assert!(Uuid::parse_str(&migrated.store_id).is_ok());
        let value: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.path().join(SETTINGS_FILE_NAME)).expect("migrated file"),
        )
        .expect("migrated JSON");
        assert_eq!(value["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        assert_eq!(value["port"], 5217);
        assert_eq!(value["storeId"], migrated.store_id);
    }

    #[test]
    fn validates_the_supported_port_range_on_save_and_load() {
        let directory = tempfile::tempdir().expect("temporary directory");

        assert!(matches!(
            save_backend_service_settings(directory.path(), MIN_BACKEND_SERVICE_PORT - 1),
            Err(CoreError::InvalidInput(_))
        ));
        assert_eq!(
            save_backend_service_settings(directory.path(), MIN_BACKEND_SERVICE_PORT)
                .expect("minimum port")
                .port,
            MIN_BACKEND_SERVICE_PORT
        );
        assert_eq!(
            save_backend_service_settings(directory.path(), MAX_BACKEND_SERVICE_PORT)
                .expect("maximum port")
                .port,
            MAX_BACKEND_SERVICE_PORT
        );

        fs::write(
            directory.path().join(SETTINGS_FILE_NAME),
            format!(
                "{{\"schemaVersion\":{SETTINGS_SCHEMA_VERSION},\"port\":{},\"storeId\":\"{}\",\"remoteWrite\":true}}",
                MIN_BACKEND_SERVICE_PORT - 1,
                Uuid::new_v4()
            ),
        )
        .expect("invalid settings");
        assert!(matches!(
            load_backend_service_settings(directory.path()),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn rejects_unknown_schema_versions_instead_of_falling_back() {
        let directory = tempfile::tempdir().expect("temporary directory");
        fs::write(
            directory.path().join(SETTINGS_FILE_NAME),
            r#"{"schemaVersion":4,"port":4178,"storeId":"7cb5018a-4a90-438a-a2c4-d1fd5c660cec"}"#,
        )
        .expect("future settings");

        assert!(matches!(
            load_backend_service_settings(directory.path()),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn corrupt_or_invalid_identity_settings_fail_without_being_overwritten() {
        for contents in [
            b"not JSON".as_slice(),
            br#"{"schemaVersion":3,"port":4178,"storeId":"not-a-uuid","remoteWrite":true}"#
                .as_slice(),
            br#"{"schemaVersion":3,"port":4178,"storeId":"7CB5018A-4A90-438A-A2C4-D1FD5C660CEC","remoteWrite":true}"#
                .as_slice(),
        ] {
            let directory = tempfile::tempdir().expect("temporary directory");
            let path = directory.path().join(SETTINGS_FILE_NAME);
            fs::write(&path, contents).expect("invalid settings");

            assert!(load_backend_service_settings(directory.path()).is_err());
            assert_eq!(fs::read(path).expect("unchanged settings"), contents);
        }
    }

    #[test]
    fn settings_lock_is_distinct_from_backend_ownership() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let _ownership = crate::BackendOwnershipLease::acquire(directory.path()).expect("owner");

        save_backend_service_settings(directory.path(), 5188)
            .expect("save while backend owns data");
        assert_eq!(
            load_backend_service_settings(directory.path())
                .expect("load while backend owns data")
                .port,
            5188
        );
    }

    #[cfg(unix)]
    #[test]
    fn settings_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().expect("temporary directory");
        save_backend_service_settings(directory.path(), 5188).expect("save settings");

        for name in [SETTINGS_FILE_NAME, SETTINGS_LOCK_FILE_NAME] {
            let mode = fs::metadata(directory.path().join(name))
                .expect("file metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "unexpected permissions for {name}");
        }
    }
}
