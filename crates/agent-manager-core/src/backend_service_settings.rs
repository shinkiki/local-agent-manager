use std::fs;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::app_data_file::write_private_json;
use crate::store_lock;
use crate::CoreError;

const SETTINGS_SCHEMA_VERSION: u32 = 4;
/// `remoteWrite`를 들고 있던 스키마. C20 로그인 설정이 그 자리를 대신하므로 값은 읽지
/// 않고 버린다 — 원격의 권한은 더 이상 스위치가 아니라 인증이 정한다(G11).
const REMOTE_WRITE_SETTINGS_SCHEMA_VERSION: u32 = 3;
const IDENTITY_SETTINGS_SCHEMA_VERSION: u32 = 2;
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

/// v3 저장본. `remoteWrite` 필드가 있지만 읽지 않는다 — serde가 모르는 필드를 버린다.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteWriteStoredBackendServiceSettings {
    schema_version: u32,
    port: u16,
    store_id: String,
}

/// 원격 write 설정이 들어오기 전 스키마(v2). 식별자와 포트만 있다.
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

trait StoredSettings: DeserializeOwned {
    const SCHEMA_VERSION: u32;
    const NEEDS_SAVE: bool;

    fn schema_version(&self) -> u32;
    fn into_settings(self) -> Result<BackendServiceSettings, CoreError>;
}

impl StoredSettings for StoredBackendServiceSettings {
    const SCHEMA_VERSION: u32 = SETTINGS_SCHEMA_VERSION;
    const NEEDS_SAVE: bool = false;

    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn into_settings(self) -> Result<BackendServiceSettings, CoreError> {
        validated_settings(self.port, &self.store_id)
    }
}

impl StoredSettings for RemoteWriteStoredBackendServiceSettings {
    const SCHEMA_VERSION: u32 = REMOTE_WRITE_SETTINGS_SCHEMA_VERSION;
    const NEEDS_SAVE: bool = true;

    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn into_settings(self) -> Result<BackendServiceSettings, CoreError> {
        validated_settings(self.port, &self.store_id)
    }
}

impl StoredSettings for IdentityStoredBackendServiceSettings {
    const SCHEMA_VERSION: u32 = IDENTITY_SETTINGS_SCHEMA_VERSION;
    const NEEDS_SAVE: bool = true;

    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn into_settings(self) -> Result<BackendServiceSettings, CoreError> {
        validated_settings(self.port, &self.store_id)
    }
}

impl StoredSettings for LegacyStoredBackendServiceSettings {
    const SCHEMA_VERSION: u32 = LEGACY_SETTINGS_SCHEMA_VERSION;
    const NEEDS_SAVE: bool = true;

    fn schema_version(&self) -> u32 {
        self.schema_version
    }

    fn into_settings(self) -> Result<BackendServiceSettings, CoreError> {
        validate_port(self.port)?;
        Ok(new_settings(self.port))
    }
}

fn decode_settings<T: StoredSettings>(
    bytes: &[u8],
) -> Result<(BackendServiceSettings, bool), CoreError> {
    let stored: T = serde_json::from_slice(bytes)?;
    debug_assert_eq!(stored.schema_version(), T::SCHEMA_VERSION);
    Ok((stored.into_settings()?, T::NEEDS_SAVE))
}

fn validated_settings(port: u16, store_id: &str) -> Result<BackendServiceSettings, CoreError> {
    validate_port(port)?;
    Ok(BackendServiceSettings {
        port,
        store_id: validate_store_id(store_id)?,
    })
}

/// 저장본 바이트열을 스키마 버전에 맞게 역직렬화하고 검증한다.
/// 반환값의 둘째 요소는 최신 스키마로 이관 저장이 필요한지 여부다.
fn parse_stored_settings(bytes: &[u8]) -> Result<(BackendServiceSettings, bool), CoreError> {
    let envelope: SettingsEnvelope = serde_json::from_slice(bytes)?;
    match envelope.schema_version {
        SETTINGS_SCHEMA_VERSION => decode_settings::<StoredBackendServiceSettings>(bytes),
        REMOTE_WRITE_SETTINGS_SCHEMA_VERSION => {
            decode_settings::<RemoteWriteStoredBackendServiceSettings>(bytes)
        }
        IDENTITY_SETTINGS_SCHEMA_VERSION => {
            decode_settings::<IdentityStoredBackendServiceSettings>(bytes)
        }
        LEGACY_SETTINGS_SCHEMA_VERSION => {
            decode_settings::<LegacyStoredBackendServiceSettings>(bytes)
        }
        schema_version => Err(CoreError::Conflict(format!(
            "지원하지 않는 백엔드 서비스 설정 버전입니다: {schema_version}"
        ))),
    }
}

fn load_settings_unlocked(app_data_dir: &Path) -> Result<BackendServiceSettings, CoreError> {
    let path = app_data_dir.join(SETTINGS_FILE_NAME);
    let Some(bytes) = read_settings_bytes(&path)? else {
        let settings = new_settings(DEFAULT_BACKEND_SERVICE_PORT);
        save_settings_unlocked(app_data_dir, &settings)?;
        return Ok(settings);
    };
    let (settings, needs_save) = parse_stored_settings(&bytes)?;
    if needs_save {
        save_settings_unlocked(app_data_dir, &settings)?;
    }
    Ok(settings)
}

/// 설정 파일을 읽는다. 없으면 `None`.
///
/// G10: 마지막 경로 성분이 심볼릭 링크면 따라가지 않고 거절한다. 링크를 따라가면 앱 데이터
/// 밖 JSON의 `storeId`를 이 저장소의 식별자로 받아들여, 클라이언트가 `/api/access`로
/// 확인하는 저장소 동일성이 남의 파일에 묶인다. 판정과 열기 사이의 틈은 유닉스에서
/// `O_NOFOLLOW`로 닫는다.
fn read_settings_bytes(path: &Path) -> Result<Option<Vec<u8>>, CoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(CoreError::InvalidInput(
                "백엔드 서비스 설정 파일 자리에 심볼릭 링크가 있어 읽지 않습니다".to_owned(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut options.open(path)?, &mut bytes)?;
    Ok(Some(bytes))
}

fn new_settings(port: u16) -> BackendServiceSettings {
    BackendServiceSettings {
        port,
        store_id: Uuid::new_v4().to_string(),
    }
}

fn validate_store_id(store_id: &str) -> Result<String, CoreError> {
    let invalid_id =
        || CoreError::InvalidInput("백엔드 서비스 저장소 식별자가 올바르지 않습니다".to_owned());
    let parsed = Uuid::parse_str(store_id).map_err(|_| invalid_id())?;
    let canonical = parsed.to_string();
    if canonical != store_id {
        return Err(invalid_id());
    }
    Ok(canonical)
}

impl From<&BackendServiceSettings> for StoredBackendServiceSettings {
    fn from(settings: &BackendServiceSettings) -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            port: settings.port,
            store_id: settings.store_id.clone(),
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
        assert!(value.get("remoteWrite").is_none());
    }

    /// v3 저장본의 `remoteWrite`는 값과 상관없이 버린다. 원격 권한은 이제 C20 로그인
    /// 설정이 정하므로, `false`로 운영하던 사용자도 이관 뒤 그 설정을 켜는 쪽으로 안내된다.
    #[test]
    fn schema_v3_drops_remote_write_and_migrates_to_v4() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let store_id = "7cb5018a-4a90-438a-a2c4-d1fd5c660cec";
        fs::write(
            directory.path().join(SETTINGS_FILE_NAME),
            format!(
                r#"{{"schemaVersion":3,"port":5217,"storeId":"{store_id}","remoteWrite":false}}"#
            ),
        )
        .expect("v3 settings");

        let migrated = load_backend_service_settings(directory.path()).expect("migrated settings");

        assert_eq!(migrated.port, 5217);
        assert_eq!(migrated.store_id, store_id);
        let value: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.path().join(SETTINGS_FILE_NAME)).expect("migrated file"),
        )
        .expect("migrated JSON");
        assert_eq!(value["schemaVersion"], SETTINGS_SCHEMA_VERSION);
        assert!(value.get("remoteWrite").is_none());
    }

    #[test]
    fn schema_v2_is_migrated_keeping_port_and_identity() {
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
        let value: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.path().join(SETTINGS_FILE_NAME)).expect("migrated file"),
        )
        .expect("migrated JSON");
        assert_eq!(value["schemaVersion"], SETTINGS_SCHEMA_VERSION);
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
            r#"{"schemaVersion":5,"port":4178,"storeId":"7cb5018a-4a90-438a-a2c4-d1fd5c660cec"}"#,
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
            br#"{"schemaVersion":4,"port":4178,"storeId":"not-a-uuid"}"#.as_slice(),
            br#"{"schemaVersion":4,"port":4178,"storeId":"7CB5018A-4A90-438A-A2C4-D1FD5C660CEC"}"#
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
    fn settings_file_symlink_is_refused_not_followed_g10() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let outside = tempfile::tempdir().expect("outside directory");
        let foreign = outside.path().join("foreign.json");
        fs::write(
            &foreign,
            br#"{"schemaVersion":4,"port":5188,"storeId":"00000000-0000-4000-8000-000000000000"}"#,
        )
        .expect("foreign settings");
        let link = directory.path().join(SETTINGS_FILE_NAME);
        std::os::unix::fs::symlink(&foreign, &link).expect("settings symlink");
        let before = fs::read(&foreign).expect("foreign bytes");
        assert!(matches!(
            load_backend_service_settings(directory.path()),
            Err(CoreError::InvalidInput(_))
        ));
        assert_eq!(fs::read(&foreign).expect("foreign bytes"), before);

        fs::remove_file(&link).expect("remove link");
        std::os::unix::fs::symlink(outside.path().join("missing.json"), &link)
            .expect("dangling symlink");
        assert!(matches!(
            load_backend_service_settings(directory.path()),
            Err(CoreError::InvalidInput(_))
        ));
        assert!(!outside.path().join("missing.json").exists());
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
