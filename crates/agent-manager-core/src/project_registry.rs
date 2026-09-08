//! 세션 카탈로그에서 역산한 프로젝트 목록과 장치별 활성 정책.
//!
//! 프로젝트는 등록되는 것이 아니라 세션 `cwd`에서 나온다. 이 모듈은 그 세션 목록을
//! 정규 경로로 묶어 설정 화면용 레지스트리를 만들고, 설정에서 제외한 프로젝트의
//! 세션을 스냅샷 합성 단계에서 걸러내는 판정을 제공한다. 세션 수천 개가 같은 cwd를
//! 공유하므로 정규화(`fs::canonicalize`)는 cwd 문자열마다 한 번만 한다.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::domain::{ProjectRegistryEntry, ProviderId, SessionSummary};
use crate::skill_library::display_file_name;

/// 이 장치의 프로젝트 정책. `known`이 `None`이면 아직 시드 전이라 결정 대기 판정을 하지 않는다.
#[derive(Debug, Clone, Default)]
pub(crate) struct ProjectPolicy {
    pub(crate) excluded: BTreeSet<PathBuf>,
    pub(crate) known: Option<BTreeSet<PathBuf>>,
}

impl ProjectPolicy {
    fn is_excluded(&self, canonical: Option<&Path>, raw: &str) -> bool {
        canonical.is_some_and(|path| self.excluded.contains(path))
            || self.excluded.contains(Path::new(raw))
    }

    fn is_pending(&self, canonical: Option<&Path>, raw: &str) -> bool {
        let Some(known) = self.known.as_ref() else {
            return false;
        };
        if self.is_excluded(canonical, raw) {
            return false;
        }
        !(canonical.is_some_and(|path| known.contains(path)) || known.contains(Path::new(raw)))
    }
}

/// cwd 문자열별 정규화 결과 캐시. 같은 합성 안에서만 쓰고 버린다.
#[derive(Debug, Default)]
pub(crate) struct ProjectPathResolver {
    memo: HashMap<String, Option<PathBuf>>,
}

impl ProjectPathResolver {
    pub(crate) fn canonical(&mut self, cwd: &str) -> Option<PathBuf> {
        self.memo
            .entry(cwd.to_owned())
            .or_insert_with(|| fs::canonicalize(cwd).ok())
            .clone()
    }

    /// 제외 프로젝트의 세션인지. cwd가 없는 세션은 프로젝트에 속하지 않으므로 남긴다.
    pub(crate) fn is_excluded(&mut self, policy: &ProjectPolicy, session: &SessionSummary) -> bool {
        let Some(cwd) = session.cwd.as_deref() else {
            return false;
        };
        let canonical = self.canonical(cwd);
        policy.is_excluded(canonical.as_deref(), cwd)
    }
}

#[derive(Default)]
struct ProjectAccumulator {
    name: Option<String>,
    raw: String,
    session_count: usize,
    hidden_session_count: usize,
    updated_at: Option<i64>,
    providers: BTreeSet<ProviderId>,
}

impl ProjectAccumulator {
    /// 세션 정보를 읽어 프로젝트 집계 상태에 반영한다.
    fn record_session(&mut self, session: &SessionSummary, cwd: &str) {
        if self.raw.is_empty() {
            self.raw = cwd.to_owned();
        }
        if self.name.is_none() {
            self.name = session.project.clone().filter(|name| !name.is_empty());
        }
        if session.meta.hidden {
            self.hidden_session_count += 1;
        } else {
            self.session_count += 1;
        }
        if let Some(updated_at) = session.updated_at {
            self.updated_at = Some(
                self.updated_at
                    .map_or(updated_at, |known| known.max(updated_at)),
            );
        }
        self.providers.insert(session.source);
    }

    /// 집계된 상태와 정책 판정을 바탕으로 최종 등록부 항목을 만든다.
    fn into_entry(self, path: PathBuf, policy: &ProjectPolicy) -> ProjectRegistryEntry {
        let raw = if self.raw.is_empty() {
            path.to_string_lossy().into_owned()
        } else {
            self.raw
        };
        let name = self
            .name
            .or_else(|| display_file_name(&path))
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let active = !policy.is_excluded(Some(&path), &raw);
        let pending = policy.is_pending(Some(&path), &raw);
        ProjectRegistryEntry {
            exists: path.is_dir(),
            path: path.to_string_lossy().into_owned(),
            name,
            session_count: self.session_count,
            hidden_session_count: self.hidden_session_count,
            updated_at: self.updated_at,
            providers: self.providers.into_iter().collect(),
            active,
            pending,
        }
    }
}

/// 필터 **전** 세션에서 프로젝트 레지스트리를 만든다. AIA 작업공간과 cwd 없는 세션은
/// 프로젝트가 아니다. 보관함(hidden) 세션은 포함하되 수를 따로 센다. 세션이 모두 사라진
/// 제외 프로젝트도 `session_count: 0`으로 남겨 다시 켤 수 있게 한다.
pub(crate) fn build_project_registry(
    sessions: &[SessionSummary],
    policy: &ProjectPolicy,
    resolver: &mut ProjectPathResolver,
) -> Vec<ProjectRegistryEntry> {
    let mut projects: BTreeMap<PathBuf, ProjectAccumulator> = BTreeMap::new();
    for session in sessions {
        if session.aia_workspace {
            continue;
        }
        let Some(cwd) = session.cwd.as_deref() else {
            continue;
        };
        let key = resolver
            .canonical(cwd)
            .unwrap_or_else(|| PathBuf::from(cwd));
        projects
            .entry(key)
            .or_default()
            .record_session(session, cwd);
    }
    for excluded in &policy.excluded {
        projects.entry(excluded.clone()).or_default();
    }

    let mut entries = projects
        .into_iter()
        .map(|(path, project)| project.into_entry(path, policy))
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.path.cmp(&right.path))
    });
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SessionMeta;

    fn session(
        id: &str,
        source: ProviderId,
        cwd: Option<&Path>,
        hidden: bool,
        updated_at: Option<i64>,
    ) -> SessionSummary {
        SessionSummary {
            source,
            id: id.to_owned(),
            title: id.to_owned(),
            source_title: None,
            project: cwd
                .and_then(|cwd| cwd.file_name())
                .map(|name| name.to_string_lossy().into_owned()),
            cwd: cwd.map(|cwd| cwd.to_string_lossy().into_owned()),
            started_at: None,
            updated_at,
            message_count: None,
            token_total: None,
            token_usage: None,
            model: None,
            git_branch: None,
            is_subagent: false,
            aia_workspace: false,
            archived: false,
            readable: true,
            size_bytes: None,
            file_path: String::new(),
            meta: SessionMeta {
                hidden,
                ..SessionMeta::default()
            },
            last_failure: None,
        }
    }

    fn policy(excluded: &[&Path], known: Option<&[&Path]>) -> ProjectPolicy {
        ProjectPolicy {
            excluded: excluded.iter().map(|path| path.to_path_buf()).collect(),
            known: known.map(|known| known.iter().map(|path| path.to_path_buf()).collect()),
        }
    }

    #[test]
    fn registry_groups_sessions_by_canonical_path_and_keeps_inactive_paths() {
        let root = tempfile::tempdir().expect("temp");
        let alpha = root.path().join("alpha");
        let beta = root.path().join("beta");
        fs::create_dir_all(&alpha).expect("alpha");
        fs::create_dir_all(&beta).expect("beta");
        let alpha_canonical = fs::canonicalize(&alpha).expect("canonical alpha");
        let beta_canonical = fs::canonicalize(&beta).expect("canonical beta");
        // beta는 세션이 없지만 제외 목록에 남아 있어 레지스트리에 보여야 한다.
        let vanished = root.path().join("gone");
        let policy = policy(&[&beta_canonical, &vanished], Some(&[&alpha_canonical]));
        let sessions = vec![
            session("a1", ProviderId::Codex, Some(&alpha), false, Some(10)),
            session("a2", ProviderId::Claude, Some(&alpha), true, Some(30)),
            session("none", ProviderId::Codex, None, false, Some(99)),
        ];
        let mut resolver = ProjectPathResolver::default();
        let registry = build_project_registry(&sessions, &policy, &mut resolver);
        assert_eq!(registry.len(), 3);
        let alpha_entry = registry
            .iter()
            .find(|entry| entry.path == alpha_canonical.to_string_lossy())
            .expect("alpha");
        assert_eq!(alpha_entry.session_count, 1);
        assert_eq!(alpha_entry.hidden_session_count, 1);
        assert_eq!(alpha_entry.updated_at, Some(30));
        assert_eq!(
            alpha_entry.providers,
            vec![ProviderId::Claude, ProviderId::Codex]
        );
        assert!(alpha_entry.active);
        assert!(!alpha_entry.pending);
        assert!(alpha_entry.exists);
        let beta_entry = registry
            .iter()
            .find(|entry| entry.path == beta_canonical.to_string_lossy())
            .expect("beta");
        assert_eq!(beta_entry.session_count, 0);
        assert!(!beta_entry.active);
        assert!(!beta_entry.pending);
        assert_eq!(beta_entry.name, "beta");
        let gone = registry
            .iter()
            .find(|entry| entry.path == vanished.to_string_lossy())
            .expect("vanished");
        assert!(!gone.exists);
        assert!(!gone.active);
        // 최근 활동이 있는 alpha가 먼저, 세션 없는 항목은 이름순.
        assert_eq!(registry[0].path, alpha_canonical.to_string_lossy());
    }

    #[test]
    fn exclusion_matches_canonical_and_raw_paths() {
        let root = tempfile::tempdir().expect("temp");
        let project = root.path().join("proj");
        fs::create_dir_all(&project).expect("proj");
        let canonical = fs::canonicalize(&project).expect("canonical");
        let vanished = root.path().join("vanished");
        let policy = policy(&[&canonical, &vanished], None);
        let mut resolver = ProjectPathResolver::default();
        // 원문이 정규 경로와 다르더라도(임시 디렉터리의 심볼릭 링크 등) 정규화해 잡는다.
        assert!(resolver.is_excluded(
            &policy,
            &session("p", ProviderId::Codex, Some(&project), false, None)
        ));
        // 디렉터리가 사라진 제외 경로는 원문 문자열로 잡는다.
        assert!(resolver.is_excluded(
            &policy,
            &session("v", ProviderId::Codex, Some(&vanished), false, None)
        ));
        assert!(!resolver.is_excluded(
            &policy,
            &session("other", ProviderId::Codex, Some(root.path()), false, None)
        ));
        assert!(!resolver.is_excluded(
            &policy,
            &session("none", ProviderId::Codex, None, false, None)
        ));
    }

    #[test]
    fn registry_skips_aia_workspace_and_cwdless_sessions() {
        let root = tempfile::tempdir().expect("temp");
        let workspace = root.path().join("aia-workspace");
        fs::create_dir_all(&workspace).expect("workspace");
        let mut aia = session("aia", ProviderId::Codex, Some(&workspace), false, Some(5));
        aia.aia_workspace = true;
        let sessions = vec![
            aia,
            session("none", ProviderId::Codex, None, false, Some(7)),
        ];
        let mut resolver = ProjectPathResolver::default();
        let registry = build_project_registry(&sessions, &ProjectPolicy::default(), &mut resolver);
        assert!(registry.is_empty());
    }

    #[test]
    fn pending_requires_seeded_known_set() {
        let root = tempfile::tempdir().expect("temp");
        let known_dir = root.path().join("known");
        let fresh_dir = root.path().join("fresh");
        fs::create_dir_all(&known_dir).expect("known");
        fs::create_dir_all(&fresh_dir).expect("fresh");
        let known_canonical = fs::canonicalize(&known_dir).expect("canonical known");
        let sessions = vec![
            session("k", ProviderId::Codex, Some(&known_dir), false, Some(1)),
            session("f", ProviderId::Codex, Some(&fresh_dir), false, Some(2)),
        ];
        let mut resolver = ProjectPathResolver::default();
        // 시드 전에는 아무것도 결정 대기가 아니다.
        let unseeded = build_project_registry(&sessions, &policy(&[], None), &mut resolver);
        assert!(unseeded.iter().all(|entry| !entry.pending));
        // 시드 후 새로 나타난 프로젝트만 결정 대기다.
        let seeded = build_project_registry(
            &sessions,
            &policy(&[], Some(&[&known_canonical])),
            &mut resolver,
        );
        let fresh = seeded
            .iter()
            .find(|entry| entry.name == "fresh")
            .expect("fresh");
        assert!(fresh.pending);
        assert!(fresh.active);
        let known = seeded
            .iter()
            .find(|entry| entry.name == "known")
            .expect("known");
        assert!(!known.pending);
        // 제외로 결정한 프로젝트는 결정 대기가 아니다.
        let fresh_canonical = fs::canonicalize(&fresh_dir).expect("canonical fresh");
        let decided = build_project_registry(
            &sessions,
            &policy(&[&fresh_canonical], Some(&[&known_canonical])),
            &mut resolver,
        );
        let fresh = decided
            .iter()
            .find(|entry| entry.name == "fresh")
            .expect("fresh");
        assert!(!fresh.pending);
        assert!(!fresh.active);
    }
}
