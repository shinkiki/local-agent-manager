//! 문서 루트(등록 폴더)의 목록·등록·해제와 보호 경계 판정.
//!
//! 저장 자리는 메타데이터 저장소(`manager-state.json`)의 `doc_roots` 한 칸이라
//! [`crate::store`]의 잠금·적재를 그대로 쓴다. 다만 루트를 "등록해도 되는 폴더인지"
//! 가리는 규칙(앱 데이터·공급자 홈·환경변수로 옮긴 공급자 홈)은 세션 메타나 프로젝트
//! 설정과 아무 관계가 없는데도 같은 파일에 섞여 있었다. 세션 메타를 고치러 온 사람이
//! 보호 경계 목록을 함께 읽어야 할 이유가 없으므로 이쪽으로 가른다.
//!
//! 호출부가 쓰던 `store::add_doc_root` 같은 경로는 [`crate::store`]의 재내보내기가
//! 그대로 유지한다.

use std::fs;
use std::path::{Path, PathBuf};

use crate::domain::{DocRoot, DocRootStatus};
use crate::store::{load_metadata, with_metadata};
use crate::user_home;
use crate::CoreError;

/// 홈 아래 이 이름의 폴더는 공급자 소유라 문서 루트로 등록하지 않는다(G7).
const AGENT_DATA_DIR_NAMES: [&str; 3] = [".claude", ".codex", ".gemini"];

/// 등록된 폴더의 경로만 돌려준다. [`list_doc_roots`]와 달리 대상 폴더를 stat 하지
/// 않는다.
pub fn doc_root_paths(app_data_dir: &Path) -> Result<Vec<PathBuf>, CoreError> {
    Ok(load_metadata(app_data_dir)?
        .doc_roots
        .into_iter()
        .map(|root| PathBuf::from(root.path))
        .collect())
}

pub fn list_doc_roots(app_data_dir: &Path) -> Result<Vec<DocRootStatus>, CoreError> {
    Ok(load_metadata(app_data_dir)?
        .doc_roots
        .into_iter()
        .map(|root| {
            let path = Path::new(&root.path);
            DocRootStatus {
                exists: path.is_dir(),
                restricted: is_restricted_doc_root(app_data_dir, path),
                root,
            }
        })
        .collect())
}

/// 문서 루트를 등록한다.
///
/// `create_if_missing`은 화면이 "만들까요?"를 물어 사용자가 승인했을 때만 켠다. 폴더
/// 생성 자체(`create_directory`)는 임의 위치를 대상으로 해서 호스트 전용으로 남겨 두고,
/// 문서 루트 등록이라는 이 한 자리에서만 원격에도 열어 준다 — 원격에서 폴더를 못 만들어
/// 등록이 막히던 흐름은 여기뿐이었다. 만드는 규칙은 `create_user_directory`와 같아서
/// 이미 있는 상위 폴더 바로 아래 마지막 한 칸만 생기고, 앱 데이터·공급자 홈은 막힌다.
pub fn add_doc_root(
    app_data_dir: &Path,
    name: &str,
    path: &str,
    create_if_missing: bool,
) -> Result<DocRootStatus, CoreError> {
    // 입력 해석은 채팅 작업 경로와 같은 규칙을 쓴다(`user_path`). 없는 폴더는 화면이
    // "만들까요?"를 물을 수 있도록 고정 문구의 NotFound로 올라간다.
    let canonical = match crate::user_path::resolve_existing_directory(path) {
        // 만들지 못하면 그 이유를 그대로 올린다. 상위가 없어 거절됐을 때의 "찾을 수
        // 없습니다: <상위>"가 사용자에게 어디가 잘못됐는지 더 정확히 말해 준다.
        Err(CoreError::NotFound(_)) if create_if_missing => {
            crate::user_path::create_user_directory(app_data_dir, path)?
        }
        other => other?,
    };
    if is_restricted_doc_root(app_data_dir, &canonical) {
        return Err(CoreError::InvalidInput(
            "공급자 인증 저장소 또는 Agent Manager 앱 데이터와 겹치는 폴더는 등록할 수 없습니다"
                .to_owned(),
        ));
    }
    let canonical_text = canonical.to_string_lossy().into_owned();
    with_metadata(app_data_dir, |metadata| {
        if metadata
            .doc_roots
            .iter()
            .any(|root| root.path == canonical_text)
        {
            return Err(CoreError::Conflict("이미 등록된 폴더입니다".to_owned()));
        }
        let display_name = name.trim();
        let display_name = if display_name.is_empty() {
            canonical
                .file_name()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| canonical_text.clone())
        } else {
            display_name.chars().take(120).collect()
        };
        let root = DocRoot {
            id: stable_id(&canonical_text),
            name: display_name,
            path: canonical_text,
            agent_data: is_agent_data_path(&canonical),
        };
        metadata.doc_roots.push(root.clone());
        Ok(DocRootStatus {
            root,
            exists: true,
            restricted: false,
        })
    })
}

pub fn remove_doc_root(app_data_dir: &Path, id: &str) -> Result<(), CoreError> {
    with_metadata(app_data_dir, |metadata| {
        let previous = metadata.doc_roots.len();
        metadata.doc_roots.retain(|root| root.id != id);
        if metadata.doc_roots.len() == previous {
            return Err(CoreError::NotFound(
                "등록 폴더를 찾을 수 없습니다".to_owned(),
            ));
        }
        Ok(())
    })
}

pub(crate) fn is_restricted_doc_root(app_data_dir: &Path, path: &Path) -> bool {
    let redirected_provider_dirs = crate::credential_profiles::inherited_credential_dirs();
    is_restricted_doc_root_with_provider_dirs(app_data_dir, path, &redirected_provider_dirs)
}

fn is_restricted_doc_root_with_provider_dirs(
    app_data_dir: &Path,
    path: &Path,
    redirected_provider_dirs: &[PathBuf],
) -> bool {
    let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let app_data = fs::canonicalize(app_data_dir).unwrap_or_else(|_| app_data_dir.to_path_buf());
    let mut protected = vec![app_data];
    if let Some(home) = user_home::optional_home_dir() {
        protected.extend(AGENT_DATA_DIR_NAMES.into_iter().map(|name| home.join(name)));
    }
    // 공급자 홈을 환경변수로 옮긴 설치도 기본 홈과 똑같은 읽기·쓰기 금지 경계다.
    // 이 변수들은 Agent Manager가 실제 공급자 런타임 구성에 사용하는 경로만 읽는다(G8).
    protected.extend(redirected_provider_dirs.iter().cloned());
    protected.into_iter().any(|item| {
        let item = fs::canonicalize(&item).unwrap_or(item);
        path.starts_with(&item) || item.starts_with(&path)
    })
}

fn stable_id(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("root-{hash:016x}")
}

fn is_agent_data_path(path: &Path) -> bool {
    user_home::optional_home_dir().is_some_and(|home| {
        AGENT_DATA_DIR_NAMES
            .iter()
            .any(|name| path.starts_with(home.join(name)))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirected_provider_homes_are_restricted_document_roots() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        let redirected = temp.path().join("provider-state");
        let nested = redirected.join("sessions");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&nested).expect("provider state");

        assert!(is_restricted_doc_root_with_provider_dirs(
            &app_data,
            &redirected,
            std::slice::from_ref(&redirected),
        ));
        assert!(is_restricted_doc_root_with_provider_dirs(
            &app_data,
            &nested,
            std::slice::from_ref(&redirected),
        ));
        assert!(is_restricted_doc_root_with_provider_dirs(
            &app_data,
            temp.path(),
            std::slice::from_ref(&redirected),
        ));
    }

    #[test]
    fn doc_root_registration_can_create_the_missing_segments() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        fs::create_dir_all(&app_data).expect("app data must exist");
        let parent = temp.path().join("Documents");
        fs::create_dir_all(&parent).expect("parent must exist");
        let target = parent.join("agentManagerQA");

        // 기본값은 지금까지와 같다. 없는 폴더는 화면이 "만들까요?"를 물을 수 있도록
        // 고정 문구의 NotFound로 올라간다.
        let error = add_doc_root(&app_data, "QA", target.to_string_lossy().as_ref(), false)
            .expect_err("없는 폴더는 거절한다");
        assert!(matches!(error, CoreError::NotFound(_)));
        assert!(!target.exists());

        // 승인했을 때만 그 한 칸을 만들고 등록한다.
        let root = add_doc_root(&app_data, "QA", target.to_string_lossy().as_ref(), true)
            .expect("만들고 등록한다");
        assert!(target.is_dir());
        assert_eq!(root.root.name, "QA");
        assert!(root.exists);

        // C6-4: 없는 칸이 둘이어도 세 칸까지는 함께 만든다. 오타로 줄줄이 생기는 것은
        // 이제 확인 대화가 만들 칸을 모두 나열해 막는다(C6-4b).
        let deep = temp.path().join("Documentz").join("agentManagerQA");
        let root = add_doc_root(&app_data, "QA", deep.to_string_lossy().as_ref(), true)
            .expect("없는 두 칸을 함께 만든다");
        assert!(deep.is_dir());
        assert!(root.exists);

        // 네 칸부터는 만들지 않는다.
        let too_deep = temp.path().join("a").join("b").join("c").join("d");
        let error = add_doc_root(&app_data, "QA", too_deep.to_string_lossy().as_ref(), true)
            .expect_err("네 칸은 거절한다");
        assert!(matches!(error, CoreError::InvalidInput(_)), "{error}");
        assert!(!temp.path().join("a").exists());

        // 앱 데이터 안은 만들지도 등록하지도 않는다.
        let inside = app_data.join("sneaky");
        let error = add_doc_root(&app_data, "QA", inside.to_string_lossy().as_ref(), true)
            .expect_err("앱 데이터 안은 거절한다");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        assert!(!inside.exists());
    }
}
