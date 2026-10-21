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

use serde::Deserialize;

use crate::domain::{DocRoot, DocRootStatus};
use crate::store::{load_metadata, with_metadata};
use crate::user_home;
use crate::CoreError;

/// 홈 아래 이 이름의 폴더는 공급자 소유라 문서 루트로 등록하지 않는다(G7).
const AGENT_DATA_DIR_NAMES: [&str; 3] = [".claude", ".codex", ".gemini"];
const MAX_DOC_ROOT_NOTE_CHARS: usize = 500;

fn default_agent_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDocRootRequest {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default = "default_agent_enabled")]
    pub agent_enabled: bool,
    /// 경로가 없으면 그 칸을 만들고 변경한다. 화면이 "만들까요?"를 물어 사용자가
    /// 승인했을 때만 켠다(C6-4b).
    #[serde(default)]
    pub create_if_missing: bool,
}

/// 에이전트 접근이 허용된(`agent_enabled == true`) 등록 폴더의 경로만 돌려준다.
/// [`list_doc_roots`]와 달리 대상 폴더를 stat 하지 않는다.
pub fn doc_root_paths(app_data_dir: &Path) -> Result<Vec<PathBuf>, CoreError> {
    Ok(load_metadata(app_data_dir)?
        .doc_roots
        .into_iter()
        .filter(|root| root.agent_enabled)
        .map(|root| PathBuf::from(root.path))
        .collect())
}

/// AIA 시스템 MCP 등 에이전트 경로에서 특정 등록 폴더를 읽거나 쓸 때 에이전트 접근 허용
/// 여부를 확인한다.
pub fn ensure_doc_root_agent_enabled(app_data_dir: &Path, root_id: &str) -> Result<(), CoreError> {
    if let Some(root) = load_metadata(app_data_dir)?
        .doc_roots
        .into_iter()
        .find(|root| root.id == root_id)
    {
        if !root.agent_enabled {
            return Err(CoreError::InvalidInput(format!(
                "에이전트 접근이 비활성화된 등록 폴더입니다: {}",
                root.name
            )));
        }
    }
    Ok(())
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

fn resolve_and_validate_doc_root_path(
    app_data_dir: &Path,
    path: &str,
    create_if_missing: bool,
) -> Result<PathBuf, CoreError> {
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
    Ok(canonical)
}

fn normalize_doc_root_name(name: &str, canonical: &Path, canonical_text: &str) -> String {
    let display_name = name.trim();
    if display_name.is_empty() {
        canonical
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| canonical_text.to_owned())
    } else {
        display_name.chars().take(120).collect()
    }
}

fn normalize_doc_root_note(note: Option<&str>) -> Result<Option<String>, CoreError> {
    let Some(raw) = note.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if raw.chars().count() > MAX_DOC_ROOT_NOTE_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "등록 폴더 비고는 {MAX_DOC_ROOT_NOTE_CHARS}자 이하로 입력하세요"
        )));
    }
    Ok(Some(raw.to_owned()))
}

/// 문서 루트를 등록한다.
///
/// `create_if_missing`은 화면이 "만들까요?"를 물어 사용자가 만들 칸을 모두 확인하고
/// 승인했을 때만 켠다(C6-4b). 만드는 일은 `create_user_directory`에 그대로 맡기므로
/// 규칙도 같다 — 이미 있는 상위 폴더 아래로 없는 칸을 세 칸까지 한 칸씩 만들고(C6-4),
/// 앱 데이터·공급자 홈은 막힌다(C6-5). 폴더 생성의 원격 허용 여부는 이 함수가 따로
/// 정하지 않고 접속 채널 로그인(G11)을 따른다.
pub fn add_doc_root(
    app_data_dir: &Path,
    name: &str,
    path: &str,
    create_if_missing: bool,
) -> Result<DocRootStatus, CoreError> {
    let canonical = resolve_and_validate_doc_root_path(app_data_dir, path, create_if_missing)?;
    let canonical_text = canonical.to_string_lossy().into_owned();
    with_metadata(app_data_dir, |metadata| {
        if metadata
            .doc_roots
            .iter()
            .any(|root| root.path == canonical_text)
        {
            return Err(CoreError::Conflict("이미 등록된 폴더입니다".to_owned()));
        }
        let display_name = normalize_doc_root_name(name, &canonical, &canonical_text);
        let root = DocRoot {
            id: unique_root_id(&metadata.doc_roots, &canonical_text),
            name: display_name,
            path: canonical_text,
            note: None,
            agent_enabled: true,
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

/// 등록 폴더의 설정(제목, 경로, 비고, 에이전트 접근가능 여부)을 변경한다.
/// 기존 ID를 유지하므로 선택 상태나 파일 변경 트리거 연결이 끊기지 않는다.
pub fn update_doc_root(
    app_data_dir: &Path,
    request: UpdateDocRootRequest,
) -> Result<DocRootStatus, CoreError> {
    let id = request.id.trim();
    if id.is_empty() {
        return Err(CoreError::InvalidInput(
            "등록 폴더 ID가 필요합니다".to_owned(),
        ));
    }
    let note = normalize_doc_root_note(request.note.as_deref())?;
    let canonical =
        resolve_and_validate_doc_root_path(app_data_dir, &request.path, request.create_if_missing)?;
    let canonical_text = canonical.to_string_lossy().into_owned();
    let display_name = normalize_doc_root_name(&request.name, &canonical, &canonical_text);
    let agent_data = is_agent_data_path(&canonical);

    with_metadata(app_data_dir, |metadata| {
        if metadata
            .doc_roots
            .iter()
            .any(|root| root.id != id && root.path == canonical_text)
        {
            return Err(CoreError::Conflict("이미 등록된 폴더입니다".to_owned()));
        }
        let Some(root) = metadata.doc_roots.iter_mut().find(|root| root.id == id) else {
            return Err(CoreError::NotFound(
                "등록 폴더를 찾을 수 없습니다".to_owned(),
            ));
        };
        root.name = display_name;
        root.path = canonical_text;
        root.note = note;
        root.agent_enabled = request.agent_enabled;
        root.agent_data = agent_data;
        Ok(DocRootStatus {
            root: root.clone(),
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

/// 경로로 만든 ID가 이미 쓰이고 있으면 번호를 붙여 다시 만든다. 설정에서 경로를 바꾼
/// 폴더는 처음 등록한 경로로 만든 ID를 그대로 들고 있어서, 그 옛 경로를 다시 등록하면
/// 같은 ID가 나온다.
fn unique_root_id(roots: &[DocRoot], path: &str) -> String {
    let taken = |id: &str| roots.iter().any(|root| root.id == id);
    let mut id = stable_id(path);
    let mut suffix = 2_u32;
    while taken(&id) {
        id = stable_id(&format!("{path}#{suffix}"));
        suffix += 1;
    }
    id
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
        assert!(root.root.agent_enabled);
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

    #[test]
    fn update_doc_root_updates_title_path_note_and_agent_access() {
        let temp = tempfile::tempdir().expect("temp directory must exist");
        let app_data = temp.path().join("app-data");
        let folder_a = temp.path().join("docs-a");
        let folder_b = temp.path().join("docs-b");
        let folder_c = temp.path().join("docs-c");
        fs::create_dir_all(&app_data).expect("app data");
        fs::create_dir_all(&folder_a).expect("folder a");
        fs::create_dir_all(&folder_b).expect("folder b");
        fs::create_dir_all(&folder_c).expect("folder c");

        let created = add_doc_root(
            &app_data,
            "초기 제목",
            folder_a.to_string_lossy().as_ref(),
            false,
        )
        .expect("register folder a");
        let other = add_doc_root(
            &app_data,
            "다른 폴더",
            folder_c.to_string_lossy().as_ref(),
            false,
        )
        .expect("register folder c");

        let updated = update_doc_root(
            &app_data,
            UpdateDocRootRequest {
                id: created.root.id.clone(),
                name: "변경된 제목".to_owned(),
                path: folder_b.to_string_lossy().into_owned(),
                note: Some("  팀 공유 문서 보관함  ".to_owned()),
                agent_enabled: false,
                create_if_missing: false,
            },
        )
        .expect("update folder settings");

        assert_eq!(updated.root.id, created.root.id);
        assert_eq!(updated.root.name, "변경된 제목");
        assert_eq!(
            updated.root.path,
            fs::canonicalize(&folder_b)
                .expect("canonical folder b")
                .to_string_lossy()
        );
        assert_eq!(updated.root.note.as_deref(), Some("팀 공유 문서 보관함"));
        assert!(!updated.root.agent_enabled);

        // 에이전트 접근이 꺼진 폴더는 에이전트 작업공간 경로 목록과 AIA 접근 검사에서 제외된다.
        let agent_paths = doc_root_paths(&app_data).expect("agent doc root paths");
        assert_eq!(agent_paths.len(), 1);
        assert_eq!(agent_paths[0], PathBuf::from(&other.root.path));
        assert!(ensure_doc_root_agent_enabled(&app_data, &created.root.id).is_err());
        assert!(ensure_doc_root_agent_enabled(&app_data, &other.root.id).is_ok());

        // 다른 등록 폴더와 같은 경로로 바꾸려는 요청은 충돌로 거절한다.
        let conflict = update_doc_root(
            &app_data,
            UpdateDocRootRequest {
                id: created.root.id.clone(),
                name: "충돌".to_owned(),
                path: folder_c.to_string_lossy().into_owned(),
                note: None,
                agent_enabled: true,
                create_if_missing: false,
            },
        )
        .expect_err("duplicate path must fail");
        assert!(matches!(conflict, CoreError::Conflict(_)));

        // 경로를 옮긴 폴더는 옛 경로로 만든 ID를 그대로 갖고 있다. 옛 경로를 다시 등록해도
        // ID가 겹치지 않아야 선택·삭제·트리거가 다른 폴더에 붙지 않는다.
        let reregistered = add_doc_root(
            &app_data,
            "옛 경로",
            folder_a.to_string_lossy().as_ref(),
            false,
        )
        .expect("re-register old path");
        assert_ne!(reregistered.root.id, created.root.id);
        let ids = list_doc_roots(&app_data)
            .expect("list roots")
            .into_iter()
            .map(|root| root.root.id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 3);
    }
}
