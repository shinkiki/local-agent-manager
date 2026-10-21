//! C17. 이름으로 되쓰는 **저장된 비밀값**. C15의 대화 비밀값이 한 대화·한 시간짜리라면,
//! 여기 있는 값은 기기에 남아 모든 대화가 같은 이름으로 쓴다.
//!
//! # 왜 따로 두는가
//!
//! C15는 값을 메모리에만 두고 대화가 끝나면 버린다. 그 성질이 곧 안전장치였지만, 같은 API
//! 키를 매일 다시 붙여 넣게 만드는 값이기도 하다(사용자 결정, 2026-09-29: 전역 저장, 자동
//! 사용). 그래서 "짧게 들고 있다 버린다"는 C15의 계약은 그대로 두고, 사용자가 **명시적으로
//! 저장을 고른** 값만 이 모듈로 옮긴다. 대화 비밀값이 자동으로 여기 들어오는 길은 없다.
//!
//! # 어디에 무엇이 남는가
//!
//! 값은 OS 보안 저장소에만 있다. DB 접속 비밀번호(C10-5)·외부 플러그인 토큰(P2)과 같은
//! 통로를 쓰되 서비스 이름공간을 나눈다. 앱 데이터에 남는 것은 이름·용도·시각뿐이며
//! (G5·G7), 값은 어떤 파일·로그·영수증·IPC 응답에도 실리지 않는다(G4). 값을 돌려주는
//! 함수는 [`reveal_for_user`] 하나이고, 저장소 화면의 눈 아이콘만 그리로 온다.
//!
//! # 자동 사용
//!
//! 에이전트가 `request_chat_secret`으로 이름을 대면, 그 이름의 저장된 값이 있고 **에이전트
//! 사용이 켜져 있을 때** 카드를 띄우지 않고 그 대화의 메모리로 실어 준다
//! ([`ChatSecretStore`](crate::chat_secrets)). 매번 같은 값을 묻지 않는 것이 저장의 목적이기
//! 때문이다. 대신 그렇게 실린 값은 대화 비밀값 목록에 `saved` 출처로 나타나므로, 사용자는
//! 어느 값이 자동으로 쓰였는지 화면에서 본다.
//!
//! 자동 사용은 값마다 끌 수 있다(`agentEnabled`, 새 값은 켜진 채로 만들어진다 — 사용자
//! 결정, 2026-09-29). 꺼 두면 그 값은 저장소 화면에서만 살아 있고 어떤 대화에도 실리지
//! 않으므로, 요청은 예전처럼 카드로 간다. 토글은 값을 지우지 않으므로, 잠시 닫아 두었다가
//! 다시 여는 데 값을 다시 붙여 넣을 필요가 없다.
//!
//! # git 원격용 토큰(C16-11)
//!
//! 프로젝트 git이 HTTPS 원격과 주고받을 때(가져오기·끌어오기·푸시) 쓰는 토큰도 여기 값으로
//! 둔다. 다만 **어느 프로젝트의 어느 호스트에 어떤 값을 쓸지는 이 모듈이 모른다** — 그 선택은
//! 형상관리 탭의 git 원격 인증(프로젝트 목록 옆 톱니바퀴)에서 프로젝트마다 하고 `project_git`의 저장본에 이름으로만 남는다. 값 하나가
//! 여러 프로젝트에 쓰일 수 있고, 같은 호스트라도 프로젝트마다 다른 값을 쓸 수 있기 때문이다.
//! 이 모듈은 이름을 받아 값을 꺼내 줄 뿐이다([`take_for_git_remote`]). 에이전트 자동 사용과는
//! 별개인 사용자 경로라 `agentEnabled`를 보지 않으며, 값은 대화 메모리로 실리지 않고 그 git
//! 자식 프로세스의 환경에만 들어간다.

use std::path::Path;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::chat_secrets::{validate_secret_name, validate_secret_purpose, validate_secret_value};
use crate::clock::now_ms;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::CoreError;

const STORE_VERSION: u32 = 1;

/// 이름·용도·시각만 담는다. 값은 여기 없다(G7).
const STORE: JsonStore = JsonStore {
    file: "saved-secrets-v1.json",
    lock_file: "saved-secrets-v1.lock",
    label: "저장된 비밀값 저장소",
    version: STORE_VERSION,
};

/// OS 보안 저장소의 서비스명. 계정 볼트·DB·플러그인과 같은 헬퍼를 쓰되 이름공간은 나눈다.
pub(crate) const SAVED_SECRET_KEYCHAIN_SERVICE: &str = "Agent Manager Saved Secrets";

/// 저장할 수 있는 개수. 사람이 이름으로 관리할 수 있는 선이다.
const MAX_SAVED_SECRETS: usize = 64;

/// 값 없는 항목 하나. 화면이 보는 모양이자 저장 파일에 그대로 실리는 모양이다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSecretView {
    pub name: String,
    pub purpose: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// 마지막으로 어느 대화에 실려 나간 시각. 쓰지 않는 값을 골라 지우라고 두는 표시다.
    #[serde(default)]
    pub last_used_at: Option<i64>,
    /// C17-5. 에이전트 요청에 자동으로 실어 줄지. 새 값은 켜진 채로 만들어지고, 이 칸이
    /// 없는 옛 저장본도 켜진 것으로 읽는다 — 이 칸이 생기기 전에 저장된 값은 모두 자동
    /// 사용을 전제로 저장된 값이다.
    #[serde(default = "agent_enabled_default")]
    pub agent_enabled: bool,
}

/// 없는 칸의 기본값. 새 값과 옛 저장본이 같은 답을 갖도록 한 자리에 둔다.
fn agent_enabled_default() -> bool {
    true
}

/// 화면으로 나가는 목록.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSecretsSnapshot {
    pub secrets: Vec<SavedSecretView>,
}

/// 값 하나를 그대로 돌려주는 응답. 호스트 화면의 눈 아이콘 전용이다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSecretValueView {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedSecretStore {
    schema_version: u32,
    #[serde(default)]
    secrets: Vec<SavedSecretView>,
}

impl Default for SavedSecretStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            secrets: Vec::new(),
        }
    }
}

impl SchemaVersioned for SavedSecretStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

fn snapshot_from(store: SavedSecretStore) -> SavedSecretsSnapshot {
    let mut secrets = store.secrets;
    secrets.sort_by(|left, right| left.name.cmp(&right.name));
    SavedSecretsSnapshot { secrets }
}

fn not_found(name: &str) -> CoreError {
    CoreError::NotFound(format!("저장된 비밀값 {name}이(가) 없습니다"))
}

/// 저장된 값의 이름·용도·시각. 값은 어느 칸에도 없다.
pub fn list_saved_secrets(app_data_dir: &Path) -> Result<SavedSecretsSnapshot, CoreError> {
    Ok(snapshot_from(STORE.read(app_data_dir)?))
}

/// 값 하나를 저장한다. 같은 이름이 있으면 덮어쓴다 — 다시 입력했다는 것은 값이 바뀌었거나
/// 앞의 값이 틀렸다는 뜻이다. 메타데이터를 먼저 쓰고 키체인을 나중에 쓰면 값 없는 항목이
/// 남으므로, 키체인 쓰기가 성공한 뒤에만 저장본을 바꾼다.
pub fn save_secret(
    app_data_dir: &Path,
    name: &str,
    purpose: &str,
    value: &str,
) -> Result<SavedSecretsSnapshot, CoreError> {
    validate_secret_name(name)?;
    let purpose = validate_secret_purpose(purpose)?;
    validate_secret_value(value)?;
    let store = STORE.update(app_data_dir, |store: &mut SavedSecretStore| {
        let now = now_ms();
        let existing = store.secrets.iter().position(|entry| entry.name == name);
        if existing.is_none() && store.secrets.len() >= MAX_SAVED_SECRETS {
            return Err(CoreError::Conflict(format!(
                "저장된 비밀값은 {MAX_SAVED_SECRETS}개까지입니다. 쓰지 않는 값을 지운 뒤 다시 저장하세요"
            )));
        }
        crate::accounts::write_os_keychain_password(SAVED_SECRET_KEYCHAIN_SERVICE, name, value)?;
        match existing {
            Some(index) => {
                let entry = &mut store.secrets[index];
                entry.purpose = purpose.clone();
                entry.updated_at = now;
            }
            None => store.secrets.push(SavedSecretView {
                name: name.to_owned(),
                purpose: purpose.clone(),
                created_at: now,
                updated_at: now,
                last_used_at: None,
                agent_enabled: agent_enabled_default(),
            }),
        }
        Ok(true)
    })?;
    Ok(snapshot_from(store))
}

/// 저장된 값을 지운다. 메타데이터와 키체인 항목이 함께 사라진다.
pub fn remove_saved_secret(
    app_data_dir: &Path,
    name: &str,
) -> Result<SavedSecretsSnapshot, CoreError> {
    let store = STORE.update(app_data_dir, |store: &mut SavedSecretStore| {
        let before = store.secrets.len();
        store.secrets.retain(|entry| entry.name != name);
        if store.secrets.len() == before {
            return Err(not_found(name));
        }
        crate::accounts::delete_os_keychain_password(SAVED_SECRET_KEYCHAIN_SERVICE, name)?;
        Ok(true)
    })?;
    Ok(snapshot_from(store))
}

/// C17-5. 값 하나의 자동 사용을 켜고 끈다. 값에는 손대지 않으므로, 껐다 켜는 데 값을 다시
/// 입력할 필요가 없다.
pub fn set_saved_secret_agent_enabled(
    app_data_dir: &Path,
    name: &str,
    enabled: bool,
) -> Result<SavedSecretsSnapshot, CoreError> {
    let store = STORE.update(app_data_dir, |store: &mut SavedSecretStore| {
        let entry = store
            .secrets
            .iter_mut()
            .find(|entry| entry.name == name)
            .ok_or_else(|| not_found(name))?;
        entry.agent_enabled = enabled;
        entry.updated_at = now_ms();
        Ok(true)
    })?;
    Ok(snapshot_from(store))
}

/// C17-4. 사용자가 저장소 화면의 눈 아이콘으로 자기 값을 다시 본다. 값이 응답에 실리는
/// 유일한 함수이며 호스트 화면 전용 명령 하나만 여기로 온다. 에이전트가 닿는 어떤 도구도
/// 이 함수에 이르지 않는다.
pub fn reveal_for_user(app_data_dir: &Path, name: &str) -> Result<SavedSecretValueView, CoreError> {
    let store: SavedSecretStore = STORE.read(app_data_dir)?;
    if !store.secrets.iter().any(|entry| entry.name == name) {
        return Err(not_found(name));
    }
    let value = crate::accounts::read_os_keychain_password(SAVED_SECRET_KEYCHAIN_SERVICE, name)?
        .ok_or_else(|| {
            CoreError::NotFound(format!(
                "저장된 비밀값 {name}의 값이 OS 보안 저장소에 없습니다. 값을 다시 저장하세요"
            ))
        })?;
    Ok(SavedSecretValueView {
        name: name.to_owned(),
        value: value.as_str().to_owned(),
    })
}

/// 자동 사용 경로. 그 이름의 저장된 값이 있으면 용도와 값을 함께 돌려주고 사용 시각을
/// 남긴다. 없으면 `Ok(None)`이다 — 저장해 두지 않은 이름은 오류가 아니라 "카드를 띄울
/// 차례"라는 뜻이다.
///
/// 메타데이터는 있는데 키체인 항목이 사라진 경우도 `Ok(None)`으로 답한다. 사용자가 OS
/// 쪽에서 항목을 지웠을 수 있고, 그때 해야 할 일은 실행을 세우는 것이 아니라 평소처럼
/// 값을 묻는 것이다.
pub(crate) fn take_for_use(
    app_data_dir: &Path,
    name: &str,
) -> Result<Option<(String, Zeroizing<String>)>, CoreError> {
    take_for_use_with(app_data_dir, name, || {
        crate::accounts::read_os_keychain_password(SAVED_SECRET_KEYCHAIN_SERVICE, name)
    })
}

fn take_for_use_with(
    app_data_dir: &Path,
    name: &str,
    read_value: impl FnOnce() -> Result<Option<Zeroizing<String>>, CoreError>,
) -> Result<Option<(String, Zeroizing<String>)>, CoreError> {
    // C17-5. 허용 여부 검사와 값 읽기를 토글·삭제와 같은 잠금 아래 묶는다. 메타데이터만
    // 읽고 잠금을 놓으면, 자동 사용을 끈 뒤에도 이전 true로 키체인을 읽을 수 있다.
    STORE.with_lock(app_data_dir, || {
        let mut store: SavedSecretStore = STORE.load_unlocked(app_data_dir)?;
        let Some(entry) = store.secrets.iter_mut().find(|entry| entry.name == name) else {
            return Ok(None);
        };
        if !entry.agent_enabled {
            return Ok(None);
        }
        let Some(value) = read_value()? else {
            return Ok(None);
        };
        let purpose = entry.purpose.clone();
        entry.last_used_at = Some(now_ms());
        // 사용 시각은 기록이 목적이라, 남기지 못해도 값은 그대로 내보낸다.
        let _ = STORE.save_unlocked(app_data_dir, &store);
        Ok(Some((purpose, value)))
    })
}

/// C16-11. 저장된 값의 이름들. 프로젝트 설정이 git 원격용 토큰을 고를 목록이자, 지정된
/// 이름이 아직 살아 있는지 개요가 확인하는 자리다. 값은 읽지 않으므로 화면을 새로 고칠 때마다
/// 불러도 OS 보안 저장소를 깨우지 않는다.
pub(crate) fn saved_secret_names(app_data_dir: &Path) -> Result<Vec<String>, CoreError> {
    let store: SavedSecretStore = STORE.read(app_data_dir)?;
    Ok(store.secrets.into_iter().map(|entry| entry.name).collect())
}

/// C16-11. 프로젝트 설정이 그 프로젝트의 git 원격용으로 고른 값을 이름으로 꺼낸다. 프로젝트
/// git의 네트워크 작업 하나만 부르고, 꺼낸 값은 그 git 자식의 환경으로만 간다. 이름이 없거나
/// OS 보안 저장소에서 항목이 사라졌으면 `Ok(None)` — 인증을 더하지 못할 뿐 작업은 git
/// 기본값으로 그대로 간다.
///
/// 에이전트 자동 사용(`agentEnabled`)은 보지 않는다. 이 경로는 사용자 자신의 git이고, 그
/// 토글을 끈 것은 "대화에 싣지 말라"는 뜻이지 "내 git에도 쓰지 말라"는 뜻이 아니다.
pub(crate) fn take_for_git_remote(
    app_data_dir: &Path,
    name: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    take_for_git_remote_with(app_data_dir, name, || {
        crate::accounts::read_os_keychain_password(SAVED_SECRET_KEYCHAIN_SERVICE, name)
    })
}

fn take_for_git_remote_with(
    app_data_dir: &Path,
    name: &str,
    read_value: impl FnOnce() -> Result<Option<Zeroizing<String>>, CoreError>,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    STORE.with_lock(app_data_dir, || {
        let mut store: SavedSecretStore = STORE.load_unlocked(app_data_dir)?;
        let Some(entry) = store.secrets.iter_mut().find(|entry| entry.name == name) else {
            return Ok(None);
        };
        let Some(value) = read_value()? else {
            return Ok(None);
        };
        entry.last_used_at = Some(now_ms());
        let _ = STORE.save_unlocked(app_data_dir, &store);
        Ok(Some(value))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// OS 키체인은 호출하지 않는다. 자동 사용 경로에는 메모리 안의 시험 값을 주입한다.
    fn stored_secret() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("temporary app data");
        STORE
            .save_unlocked(
                directory.path(),
                &SavedSecretStore {
                    schema_version: STORE_VERSION,
                    secrets: vec![SavedSecretView {
                        name: "API_KEY".to_owned(),
                        purpose: "시험".to_owned(),
                        created_at: 1,
                        updated_at: 1,
                        last_used_at: None,
                        agent_enabled: true,
                    }],
                },
            )
            .expect("synthetic metadata");
        directory
    }

    #[test]
    fn c17_5_auto_use_holds_the_toggle_lock_while_reading_the_value() {
        let directory = stored_secret();
        let result = take_for_use_with(directory.path(), "API_KEY", || {
            let contender = crate::app_data_file::open_private_file(
                &directory.path().join(STORE.lock_file),
                false,
            )?;
            assert!(matches!(
                fs4::FileExt::try_lock(&contender),
                Err(fs4::TryLockError::WouldBlock)
            ));
            Ok(Some(Zeroizing::new("test-value".to_owned())))
        })
        .expect("auto use")
        .expect("enabled value");
        assert_eq!(result.0, "시험");
        assert_eq!(result.1.as_str(), "test-value");
        let store: SavedSecretStore = STORE.read(directory.path()).expect("metadata");
        assert!(store.secrets[0].last_used_at.is_some());
    }

    #[test]
    fn c17_5_disabled_or_missing_entries_never_read_the_keychain() {
        let directory = stored_secret();
        set_saved_secret_agent_enabled(directory.path(), "API_KEY", false).expect("disable");
        for name in ["API_KEY", "MISSING"] {
            assert!(take_for_use_with(directory.path(), name, || {
                panic!("disabled or absent metadata must not read a value")
            })
            .expect("no auto use")
            .is_none());
        }
        let store: SavedSecretStore = STORE.read(directory.path()).expect("metadata");
        assert_eq!(store.secrets[0].last_used_at, None);
    }

    #[test]
    fn c17_6_missing_value_or_keychain_error_does_not_record_usage() {
        let directory = stored_secret();
        assert!(take_for_use_with(directory.path(), "API_KEY", || Ok(None))
            .expect("missing keychain item")
            .is_none());
        assert!(matches!(
            take_for_use_with(directory.path(), "API_KEY", || {
                Err(CoreError::Runtime("keychain unavailable".to_owned()))
            }),
            Err(CoreError::Runtime(_))
        ));
        let store: SavedSecretStore = STORE.read(directory.path()).expect("metadata");
        assert_eq!(store.secrets[0].last_used_at, None);
    }

    #[test]
    fn c17_3_usage_timestamp_write_failure_does_not_discard_the_value() {
        let directory = stored_secret();
        let result = take_for_use_with(directory.path(), "API_KEY", || {
            // 저장 대상만 시험용 디렉터리로 바꿔 timestamp 쓰기 실패를 만든다.
            std::fs::remove_file(STORE.path(directory.path()))?;
            std::fs::create_dir(STORE.path(directory.path()))?;
            Ok(Some(Zeroizing::new("test-value".to_owned())))
        })
        .expect("timestamp failure is non-fatal")
        .expect("enabled value");
        assert_eq!(result.1.as_str(), "test-value");
    }

    #[test]
    fn saved_secret_store_defaults_to_current_schema() {
        let store = SavedSecretStore::default();
        assert_eq!(store.schema_version(), STORE_VERSION);
        assert!(store.secrets.is_empty());
    }

    #[test]
    fn snapshot_sorts_by_name() {
        let store = SavedSecretStore {
            schema_version: STORE_VERSION,
            secrets: vec![
                SavedSecretView {
                    name: "ZED".to_owned(),
                    purpose: "뒤".to_owned(),
                    created_at: 1,
                    updated_at: 1,
                    last_used_at: None,
                    agent_enabled: true,
                },
                SavedSecretView {
                    name: "ALPHA".to_owned(),
                    purpose: "앞".to_owned(),
                    created_at: 2,
                    updated_at: 2,
                    last_used_at: None,
                    agent_enabled: false,
                },
            ],
        };
        let names: Vec<String> = snapshot_from(store)
            .secrets
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, vec!["ALPHA".to_owned(), "ZED".to_owned()]);
    }

    /// C17-5. 이 칸이 생기기 전에 저장된 값은 모두 자동 사용을 전제로 저장됐다. 없는 칸을
    /// `false`로 읽으면 업데이트 한 번에 저장해 둔 값이 조용히 전부 잠긴다.
    #[test]
    fn older_store_without_the_flag_reads_as_enabled() {
        let store: SavedSecretStore = serde_json::from_str(
            r#"{"schemaVersion":1,"secrets":[{"name":"API_KEY","purpose":"쓰임","createdAt":1,"updatedAt":1}]}"#,
        )
        .expect("옛 저장본은 새 칸 없이도 읽혀야 한다");
        assert!(store.secrets[0].agent_enabled);
        assert_eq!(store.secrets[0].last_used_at, None);
    }

    /// C16-11. git 경로는 에이전트 자동 사용과 별개다. 토글을 꺼도 사용자 자신의 git은 값을
    /// 쓰고, 없는 이름은 키체인을 읽지 않는다.
    #[test]
    fn c16_11_git_token_ignores_agent_use_and_reads_only_the_named_value() {
        let directory = stored_secret();
        set_saved_secret_agent_enabled(directory.path(), "API_KEY", false).expect("disable");
        assert!(take_for_git_remote_with(directory.path(), "MISSING", || {
            panic!("an unknown name must not read a value")
        })
        .expect("unknown")
        .is_none());
        let value = take_for_git_remote_with(directory.path(), "API_KEY", || {
            Ok(Some(Zeroizing::new("ghp_test".to_owned())))
        })
        .expect("named")
        .expect("value");
        assert_eq!(value.as_str(), "ghp_test");
        let store: SavedSecretStore = STORE.read(directory.path()).expect("metadata");
        assert!(store.secrets[0].last_used_at.is_some());
        assert_eq!(
            saved_secret_names(directory.path()).expect("names"),
            vec!["API_KEY".to_owned()]
        );
    }

    #[test]
    fn missing_name_reads_as_not_found() {
        let error = not_found("API_KEY");
        assert!(matches!(error, CoreError::NotFound(_)));
    }
}
