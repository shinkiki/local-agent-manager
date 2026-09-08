//! 보관 스킬의 출처 메타. 보관 시점의 출처(에이전트·범위·프로젝트)와 스킬별
//! 자동 동기화 설정을 Agent Manager 소유 앱 데이터에 기록한다.
//!
//! 보관 저장소는 클라우드 드라이브와 공유될 수 있으므로 장치별 출처·자동 동기화
//! 설정은 저장소에 두지 않는다. 배포 상태도 여기 저장하지 않는다 — "지금 어디에 있나"는 파일시스템
//! 스캔이 진실이고, 이 메타는 "어디서 왔나"와 사용자 설정만 기억한다.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::app_data_file::write_private_json;
use crate::domain::ProviderId;
use crate::CoreError;

const META_FILE: &str = "skill-meta.json";
const META_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOriginMeta {
    /// 보관 당시 설치본이 있던 에이전트.
    pub provider: ProviderId,
    /// "personal" | "project"
    pub scope: String,
    /// scope가 project일 때 그 프로젝트 루트 경로.
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub archived_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMetaEntry {
    #[serde(default)]
    pub origin: Option<SkillOriginMeta>,
    /// 외부 수정 감지 시 자동으로 원본에 반영하고 전체 재배포할지. 기본은 수동.
    #[serde(default)]
    pub auto_sync: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMetaStore {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub skills: BTreeMap<String, SkillMetaEntry>,
}

pub(crate) fn load_skill_meta(app_data_dir: &Path) -> SkillMetaStore {
    let path = app_data_dir.join(META_FILE);
    let Ok(bytes) = fs::read(&path) else {
        return SkillMetaStore::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

fn save_skill_meta(app_data_dir: &Path, store: &SkillMetaStore) -> Result<(), CoreError> {
    let mut next = store.clone();
    next.version = META_VERSION;
    write_private_json(&app_data_dir.join(META_FILE), &next)
}

fn update_skill_meta<F>(app_data_dir: &Path, mutate: F) -> Result<bool, CoreError>
where
    F: FnOnce(&mut SkillMetaStore) -> bool,
{
    let mut store = load_skill_meta(app_data_dir);
    if mutate(&mut store) {
        save_skill_meta(app_data_dir, &store)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 보관 시 출처를 기록한다. 기존 자동 동기화 설정은 유지한다.
pub(crate) fn record_skill_origin(
    app_data_dir: &Path,
    key: &str,
    origin: SkillOriginMeta,
) -> Result<(), CoreError> {
    update_skill_meta(app_data_dir, |store| {
        store.skills.entry(key.to_owned()).or_default().origin = Some(origin);
        true
    })
    .map(|_| ())
}

pub fn set_skill_auto_sync(
    app_data_dir: &Path,
    key: &str,
    auto_sync: bool,
) -> Result<(), CoreError> {
    update_skill_meta(app_data_dir, |store| {
        store.skills.entry(key.to_owned()).or_default().auto_sync = auto_sync;
        true
    })
    .map(|_| ())
}

/// 보관 스킬 삭제 시 메타도 함께 정리한다.
pub(crate) fn remove_skill_meta(app_data_dir: &Path, key: &str) -> Result<(), CoreError> {
    update_skill_meta(app_data_dir, |store| store.skills.remove(key).is_some()).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_record_origin_and_set_auto_sync_and_remove() {
        let temp = tempdir().expect("tempdir");
        let path = temp.path();

        // 1. 초기 상태 확인
        let initial = load_skill_meta(path);
        assert!(initial.skills.is_empty());

        // 2. 출처 기록
        let origin = SkillOriginMeta {
            provider: ProviderId::Claude,
            scope: "personal".into(),
            project_path: None,
            archived_at_ms: Some(12345678),
        };
        record_skill_origin(path, "test-skill", origin.clone()).expect("record origin");

        let loaded = load_skill_meta(path);
        let entry = loaded.skills.get("test-skill").expect("entry exists");
        assert_eq!(entry.origin, Some(origin));
        assert!(!entry.auto_sync);

        // 3. 자동 동기화 설정 변경
        set_skill_auto_sync(path, "test-skill", true).expect("set auto sync");
        let loaded2 = load_skill_meta(path);
        let entry2 = loaded2.skills.get("test-skill").expect("entry exists");
        assert!(entry2.auto_sync);
        assert!(entry2.origin.is_some());

        // 4. 삭제 시 메타 정리
        remove_skill_meta(path, "test-skill").expect("remove skill meta");
        let loaded3 = load_skill_meta(path);
        assert!(!loaded3.skills.contains_key("test-skill"));

        // 5. 존재하지 않는 키 삭제 시 오류 없이 무변화
        remove_skill_meta(path, "nonexistent-skill").expect("remove nonexistent");
    }
}
