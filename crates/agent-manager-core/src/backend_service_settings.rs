use std::fs::{self, File, OpenOptions};
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use fs4::FileExt;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::CoreError;

const SETTINGS_SCHEMA_VERSION: u32 = 2;
const LEGACY_SETTINGS_SCHEMA_VERSION: u32 = 1;
const SETTINGS_FILE_NAME: &str = "backend-service-settings.json";
const SETTINGS_LOCK_FILE_NAME: &str = "backend-service-settings-v1.lock";

pub const DEFAULT_BACKEND_SERVICE_PORT: u16 = 54_178;
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
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBackendServiceSettings {
    schema_version: u32,
    port: u16,
    store_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsEnvelope {
    schema_version: u32,
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
    with_settings_lock(app_data_dir.as_ref(), |canonical_app_data_dir| {
        let mut settings = load_settings_unlocked(canonical_app_data_dir)?;
        settings.port = port;
        save_settings_unlocked(canonical_app_data_dir, settings)?;
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
    let lock = open_private_file(&canonical_app_data_dir.join(SETTINGS_LOCK_FILE_NAME), false)?;
    FileExt::lock(&lock).map_err(|error| {
        CoreError::Runtime(format!(
            "백엔드 서비스 설정 잠금을 얻지 못했습니다: {error}"
        ))
    })?;
    let result = action(&canonical_app_data_dir);
    let unlock = FileExt::unlock(&lock).map_err(|error| {
        CoreError::Runtime(format!(
            "백엔드 서비스 설정 잠금을 해제하지 못했습니다: {error}"
        ))
    });
    match (result, unlock) {
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

fn load_settings_unlocked(app_data_dir: &Path) -> Result<BackendServiceSettings, CoreError> {
    let path = app_data_dir.join(SETTINGS_FILE_NAME);
    if !path.exists() {
        let settings = new_settings(DEFAULT_BACKEND_SERVICE_PORT);
        save_settings_unlocked(app_data_dir, settings.clone())?;
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
            })
        }
        LEGACY_SETTINGS_SCHEMA_VERSION => {
            let stored: LegacyStoredBackendServiceSettings = serde_json::from_slice(&bytes)?;
            debug_assert_eq!(stored.schema_version, LEGACY_SETTINGS_SCHEMA_VERSION);
            validate_port(stored.port)?;
            let settings = new_settings(stored.port);
            save_settings_unlocked(app_data_dir, settings.clone())?;
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

fn save_settings_unlocked(
    app_data_dir: &Path,
    settings: BackendServiceSettings,
) -> Result<(), CoreError> {
    let destination = app_data_dir.join(SETTINGS_FILE_NAME);
    let temporary = app_data_dir.join(format!(".{SETTINGS_FILE_NAME}.{}.tmp", Uuid::new_v4()));
    let stored = StoredBackendServiceSettings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        port: settings.port,
        store_id: settings.store_id,
    };
    let bytes = serde_json::to_vec_pretty(&stored)?;
    let result = (|| -> Result<(), CoreError> {
        let mut file = open_private_file(&temporary, true)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        drop(file);
        replace_file(&temporary, &destination)?;
        sync_app_data_dir(app_data_dir)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn open_private_file(path: &Path, create_new: bool) -> Result<File, CoreError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(false);
    }
    #[cfg(unix)]
    options.mode(0o600);
    Ok(options.open(path)?)
}

#[cfg(not(windows))]
fn replace_file(temporary: &Path, destination: &Path) -> Result<(), CoreError> {
    fs::rename(temporary, destination)?;
    Ok(())
}

#[cfg(windows)]
fn replace_file(temporary: &Path, destination: &Path) -> Result<(), CoreError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = temporary
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(CoreError::Io(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_app_data_dir(app_data_dir: &Path) -> Result<(), CoreError> {
    File::open(app_data_dir)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_app_data_dir(_app_data_dir: &Path) -> Result<(), CoreError> {
    Ok(())
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
                "{{\"schemaVersion\":{SETTINGS_SCHEMA_VERSION},\"port\":{},\"storeId\":\"{}\"}}",
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
            r#"{"schemaVersion":3,"port":4178,"storeId":"7cb5018a-4a90-438a-a2c4-d1fd5c660cec"}"#,
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
            br#"{"schemaVersion":2,"port":4178,"storeId":"not-a-uuid"}"#.as_slice(),
            br#"{"schemaVersion":2,"port":4178,"storeId":"7CB5018A-4A90-438A-A2C4-D1FD5C660CEC"}"#
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

    #[test]
    fn settings_lock_is_exclusive_between_file_handles() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let lock_path = directory.path().join(SETTINGS_LOCK_FILE_NAME);
        let first = open_private_file(&lock_path, false).expect("first lock handle");
        FileExt::lock(&first).expect("first lock");
        let contender = open_private_file(&lock_path, false).expect("contending lock handle");

        assert!(matches!(
            FileExt::try_lock(&contender),
            Err(fs4::TryLockError::WouldBlock)
        ));
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
