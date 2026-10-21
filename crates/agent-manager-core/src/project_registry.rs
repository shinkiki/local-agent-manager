//! 세션 카탈로그에서 역산한 프로젝트 목록과 장치별 활성 정책.
//!
//! 프로젝트는 등록되는 것이 아니라 세션 `cwd`에서 나온다. 이 모듈은 그 세션 목록을
//! 정규 경로로 묶어 설정 화면용 레지스트리를 만들고, 설정에서 제외한 프로젝트의
//! 세션을 스냅샷 합성 단계에서 걸러내는 판정을 제공한다. 세션 수천 개가 같은 cwd를
//! 공유하므로 정규화(`fs::canonicalize`)는 cwd 문자열마다 한 번만 한다.

use std::cmp::Reverse;
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
    fn contains_path(paths: &BTreeSet<PathBuf>, canonical: Option<&Path>, raw: &str) -> bool {
        canonical.is_some_and(|path| paths.contains(path)) || paths.contains(Path::new(raw))
    }

    fn is_excluded(&self, canonical: Option<&Path>, raw: &str) -> bool {
        Self::contains_path(&self.excluded, canonical, raw)
    }

    /// 경로의 활성 여부(`active`)와 신규 감지 대기 여부(`pending`)를 판정한다.
    /// 제외된 프로젝트는 즉시 비활성이며 결정 대기가 될 수 없다.
    fn evaluate_status(&self, canonical: Option<&Path>, raw: &str) -> (bool, bool) {
        if self.is_excluded(canonical, raw) {
            return (false, false);
        }
        let pending = self
            .known
            .as_ref()
            .is_some_and(|known| !Self::contains_path(known, canonical, raw));
        (true, pending)
    }
}

/// cwd 문자열별 정규화 결과 캐시. 같은 합성 안에서만 쓰고 버린다.
#[derive(Debug, Default)]
pub(crate) struct ProjectPathResolver {
    memo: HashMap<String, Option<PathBuf>>,
}

impl ProjectPathResolver {
    /// 캐시에 정규화 결과를 한 번만 채우고 그 경로를 빌려준다. 호출할 때마다 cwd 키와
    /// 정규 경로를 다시 소유하게 하면 같은 cwd를 공유하는 세션 수만큼 복제가 생긴다.
    fn canonical(&mut self, cwd: &str) -> Option<&Path> {
        if !self.memo.contains_key(cwd) {
            self.memo.insert(cwd.to_owned(), fs::canonicalize(cwd).ok());
        }
        self.memo.get(cwd).and_then(Option::as_deref)
    }

    /// 정규화 성공 시 정규 경로를, 실패 시 원문 경로를 키로 돌려준다.
    pub(crate) fn resolve_key(&mut self, cwd: &str) -> PathBuf {
        self.canonical(cwd)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(cwd))
    }

    /// 제외 프로젝트의 세션인지. cwd가 없는 세션은 프로젝트에 속하지 않으므로 남긴다.
    pub(crate) fn is_excluded(&mut self, policy: &ProjectPolicy, session: &SessionSummary) -> bool {
        let Some(cwd) = session.cwd.as_deref() else {
            return false;
        };
        policy.is_excluded(self.canonical(cwd), cwd)
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
        self.record_identity(session, cwd);
        self.record_activity(session);
    }

    /// 첫 세션에서 표시용 원문 경로와 프로젝트 이름을 채운다.
    fn record_identity(&mut self, session: &SessionSummary, cwd: &str) {
        if self.raw.is_empty() {
            self.raw = cwd.to_owned();
        }
        if self.name.is_none() {
            self.name = session.project.clone().filter(|name| !name.is_empty());
        }
    }

    /// 세션 가시성·최근 시각·공급자를 프로젝트 활동 집계에 반영한다.
    fn record_activity(&mut self, session: &SessionSummary) {
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
        let path_str = path.to_string_lossy().into_owned();
        let raw = if self.raw.is_empty() {
            path_str.clone()
        } else {
            self.raw
        };
        let name = self
            .name
            .or_else(|| display_file_name(&path))
            .unwrap_or_else(|| path_str.clone());
        let (active, pending) = policy.evaluate_status(Some(&path), &raw);
        ProjectRegistryEntry {
            exists: path.is_dir(),
            path: path_str,
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
        let key = resolver.resolve_key(cwd);
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

/// 세션마다 작업 경로 밖에서 손댄 등록 프로젝트를 찾아 `related_projects`에 싣는다.
///
/// 프로젝트 필터는 `cwd` 하나로 세션을 가르는데, AIA는 늘 자기 작업공간에서 돌며 다른
/// 프로젝트를 쓰기 루트로만 붙여 고친다. 그래서 AIA에게 맡긴 프로젝트 작업이 그 프로젝트
/// 필터에 잡히지 않았다. 재료는 둘이다.
/// - 원문에서 파일 수정 도구가 쓴 폴더(`written_dirs`). 자기 작업 경로 안쪽이거나 작업
///   경로를 품은 상위 프로젝트(홈 폴더에서 연 세션 등)는 관련 프로젝트로 치지 않는다.
/// - 사용자·AIA가 직접 이어 둔 경로(`meta.linked_project_paths`). 사람이 고른 것이라 자기
///   작업 경로와 같은 프로젝트만 뺀다.
///
/// 두 재료 모두 가장 깊은 활성 등록 프로젝트에 맞추고, 그 프로젝트 세션들이 쓰는 `cwd`
/// 문자열을 그대로 싣는다 — 화면 필터가 원문 `cwd`로 고르기 때문이다. AIA·기본 작업공간과
/// 사용자 홈 폴더, 홈 아래 숨김 폴더(`~/.claude` 같은 공급자 설정)는 프로젝트로 맞추지
/// 않는다. 설정·메모리 파일 수정만으로 모든 AIA 세션이 그 프로젝트에 묶이면 필터가
/// 쓸모없어진다.
///
/// 스냅샷을 다시 짤 때마다 돈다. 후보는 먼저 프로젝트 경로 문자열과 견주고, 문자열로 맞는
/// 프로젝트가 없을 때만 정규화(파일시스템 조회)한다.
pub(crate) fn apply_related_projects(
    sessions: &mut [SessionSummary],
    registry: &[ProjectRegistryEntry],
    resolver: &mut ProjectPathResolver,
    home: Option<&Path>,
) {
    let home = home.map(|home| resolver.resolve_key(&home.to_string_lossy()));
    let mut aliases: BTreeMap<PathBuf, Vec<String>> = BTreeMap::new();
    for session in sessions.iter() {
        if session.aia_workspace || session.default_workspace {
            continue;
        }
        let Some(cwd) = session.cwd.as_deref() else {
            continue;
        };
        let raw = aliases.entry(resolver.resolve_key(cwd)).or_default();
        if !raw.iter().any(|known| known == cwd) {
            raw.push(cwd.to_owned());
        }
    }
    let mut roots = registry
        .iter()
        .filter(|entry| entry.active)
        .map(|entry| PathBuf::from(&entry.path))
        .filter(|path| {
            aliases.contains_key(path) && !is_home_or_hidden_under(path, home.as_deref())
        })
        .collect::<Vec<_>>();
    if roots.is_empty() {
        return;
    }
    // 가장 깊은 프로젝트가 먼저 맞도록 경로 조각이 많은 순으로 둔다.
    roots.sort_by_key(|root| Reverse(root.components().count()));
    // 안쪽에 다른 프로젝트를 품은 프로젝트. 원문 별칭(심볼릭 링크 경로)으로 문자열이 맞아도
    // 실제로는 안쪽 프로젝트일 수 있어, 이런 프로젝트는 문자열 일치를 믿지 않고 정규화한다.
    let nests: BTreeSet<PathBuf> = roots
        .iter()
        .filter(|root| {
            roots
                .iter()
                .any(|other| other != *root && other.starts_with(root))
        })
        .cloned()
        .collect();

    // 작업 경로가 워크트리면 그 본 체크아웃. 같은 작업 경로를 쓰는 세션이 많아 경로마다 한 번만 묻는다.
    let mut worktree_mains: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
    for session in sessions.iter_mut() {
        session.related_projects.clear();
        if session.written_dirs.is_empty() && session.meta.linked_project_paths.is_empty() {
            continue;
        }
        let own_raw = session.cwd.clone();
        let own = own_raw.as_deref().map(|cwd| resolver.resolve_key(cwd));
        // 저장소 안에 만든 워크트리(`/repo/.claude/worktrees/x`)에서 연 세션은 작업 경로가 본
        // 저장소 아래라 상위 프로젝트 규칙에 걸리지만, 본 저장소 작업이다.
        let own_main = own.as_ref().and_then(|own| {
            worktree_mains
                .entry(own.clone())
                .or_insert_with(|| {
                    crate::catalog::worktree_main_checkout_path(own, own)
                        .map(|main| resolver.resolve_key(&main.to_string_lossy()))
                })
                .clone()
        });
        let mut related: Vec<&PathBuf> = Vec::new();
        let linked = session
            .meta
            .linked_project_paths
            .iter()
            .map(|path| (path, true));
        let written = session.written_dirs.iter().map(|path| (path, false));
        for (candidate, explicit) in linked.chain(written) {
            // 자기 작업 경로 안쪽 수정이 대부분이다. 정규화 전에 문자열로 걸러 파일시스템
            // 조회를 아낀다. 작업 경로 안에 따로 등록된 하위 프로젝트는 이 때문에 놓친다.
            if !explicit
                && own_raw
                    .as_deref()
                    .is_some_and(|cwd| path_is_within(candidate, cwd))
            {
                continue;
            }
            let by_text = roots
                .iter()
                .find(|root| {
                    Path::new(candidate).starts_with(root)
                        || aliases[*root]
                            .iter()
                            .any(|alias| path_is_within(candidate, alias))
                })
                .filter(|root| !nests.contains(*root));
            let root = match by_text {
                Some(root) => root,
                None => {
                    let key = resolver.resolve_key(candidate);
                    let Some(root) = roots.iter().find(|root| key.starts_with(root)) else {
                        continue;
                    };
                    root
                }
            };
            let unrelated = match own.as_deref() {
                Some(own) if explicit => own == root.as_path(),
                Some(own) => own.starts_with(root) && own_main.as_ref() != Some(root),
                None => false,
            };
            if !unrelated && !related.contains(&root) {
                related.push(root);
            }
        }
        session.related_projects = related
            .into_iter()
            .filter_map(|root| aliases.get(root))
            .flatten()
            .cloned()
            .collect();
    }
}

/// 홈 폴더 자신이거나 홈 바로 아래 숨김 폴더(`~/.claude`, `~/.codex` …) 안쪽인가.
fn is_home_or_hidden_under(path: &Path, home: Option<&Path>) -> bool {
    let Some(home) = home else {
        return false;
    };
    match path.strip_prefix(home) {
        Ok(rest) => rest
            .components()
            .next()
            .is_none_or(|first| first.as_os_str().to_string_lossy().starts_with('.')),
        Err(_) => false,
    }
}

/// `path`가 `base`와 같거나 그 아래인지 문자열 경로 조각으로 묻는다(`/a/bc`는 `/a/b` 아래가 아니다).
fn path_is_within(path: &str, base: &str) -> bool {
    Path::new(path).starts_with(base)
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
            parent_session_id: None,
            aia_workspace: false,
            aia_chat: false,
            aia_chat_opens_as_standard: false,
            default_workspace: false,
            archived: false,
            readable: true,
            size_bytes: None,
            file_path: String::new(),
            meta: SessionMeta {
                hidden,
                ..SessionMeta::default()
            },
            last_failure: None,
            related_projects: Vec::new(),
            written_dirs: Vec::new(),
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

    /// 관련 프로젝트 시험용 작업 트리: 홈 아래 프로젝트 둘, AIA 작업공간, 제외 프로젝트 하나.
    struct RelatedFixture {
        _root: tempfile::TempDir,
        home: PathBuf,
        app: PathBuf,
        tools: PathBuf,
        aia: PathBuf,
        off: PathBuf,
    }

    fn related_fixture() -> RelatedFixture {
        let root = tempfile::tempdir().expect("temp");
        let canonical_root = fs::canonicalize(root.path()).expect("canonical root");
        let home = canonical_root.join("home");
        let app = home.join("repos/app");
        let tools = home.join("repos/tools");
        let aia = canonical_root.join("data/aia-workspace");
        let off = home.join("repos/off");
        for dir in [
            &app.join("src"),
            &tools,
            &aia,
            &off,
            &home.join(".claude/projects/m"),
        ] {
            fs::create_dir_all(dir).expect("dir");
        }
        RelatedFixture {
            _root: root,
            home,
            app,
            tools,
            aia,
            off,
        }
    }

    fn relate(sessions: &mut [SessionSummary], excluded: &[&Path], home: &Path) {
        let policy = policy(excluded, None);
        let mut resolver = ProjectPathResolver::default();
        let registry = build_project_registry(sessions, &policy, &mut resolver);
        apply_related_projects(sessions, &registry, &mut resolver, Some(home));
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn written_dirs_outside_the_working_path_relate_the_deepest_active_project() {
        let fx = related_fixture();
        let mut aia = session("aia", ProviderId::Claude, Some(&fx.aia), false, None);
        aia.aia_workspace = true;
        aia.written_dirs = vec![
            text(&fx.app.join("src")),
            text(&fx.app.join("src")),
            text(&fx.aia),
            text(&fx.off),
            text(&fx.home.join(".claude/memory")),
            text(&fx.home.join(".claude/projects/m")),
            "/nowhere/at/all".to_owned(),
        ];
        let mut sessions = vec![
            aia,
            session("app", ProviderId::Claude, Some(&fx.app), false, None),
            session("off", ProviderId::Claude, Some(&fx.off), false, None),
            // 홈과 홈 아래 숨김 폴더에서 연 세션이 있어도 그 폴더는 프로젝트로 맞추지 않는다.
            session("home", ProviderId::Claude, Some(&fx.home), false, None),
            session(
                "dot",
                ProviderId::Claude,
                Some(&fx.home.join(".claude")),
                false,
                None,
            ),
        ];
        relate(&mut sessions, &[&fx.off], &fx.home);
        assert_eq!(sessions[0].related_projects, vec![text(&fx.app)]);
    }

    #[test]
    fn writes_inside_or_above_the_own_project_are_not_related() {
        let fx = related_fixture();
        let mut app = session("app", ProviderId::Claude, Some(&fx.app), false, None);
        app.written_dirs = vec![text(&fx.app.join("src")), text(&fx.app)];
        let mut nested = session(
            "nested",
            ProviderId::Codex,
            Some(&fx.app.join("src")),
            false,
            None,
        );
        // 작업 경로를 품은 상위 프로젝트(app) 안의 수정은 자기 일이다.
        nested.written_dirs = vec![text(&fx.app)];
        let mut sessions = vec![app, nested];
        relate(&mut sessions, &[], &fx.home);
        assert!(sessions[0].related_projects.is_empty());
        assert!(sessions[1].related_projects.is_empty());
    }

    #[test]
    fn linked_paths_resolve_to_their_project_and_keep_raw_cwd_aliases() {
        let fx = related_fixture();
        let mut aia = session("aia", ProviderId::Claude, Some(&fx.aia), false, None);
        aia.aia_workspace = true;
        aia.meta.linked_project_paths =
            vec![text(&fx.app.join("src")), text(&fx.tools), text(&fx.aia)];
        // 같은 프로젝트를 다른 문자열(끝 슬래시)로 연 세션이 있으면 두 문자열 모두 싣는다 —
        // 화면 필터는 원문 cwd 로 고른다.
        let tools_alias = format!("{}/", text(&fx.tools));
        let mut tools_alias_session = session("tools-2", ProviderId::Codex, None, false, None);
        tools_alias_session.cwd = Some(tools_alias.clone());
        let mut sessions = vec![
            aia,
            session("app", ProviderId::Claude, Some(&fx.app), false, None),
            session("tools", ProviderId::Claude, Some(&fx.tools), false, None),
            tools_alias_session,
        ];
        relate(&mut sessions, &[], &fx.home);
        assert_eq!(
            sessions[0].related_projects,
            vec![text(&fx.app), text(&fx.tools), tools_alias]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_alias_does_not_hide_a_nested_project() {
        // 바깥 프로젝트를 심볼릭 링크 경로로 연 세션이 있어도, 그 경로 아래 수정이 실제로는
        // 안쪽 프로젝트 것이면 안쪽 프로젝트에 맞춘다(시놀로지 /var/services/homes 같은 경우).
        let fx = related_fixture();
        let sub = fx.app.join("src");
        let link = fx.home.join("link-to-app");
        std::os::unix::fs::symlink(&fx.app, &link).expect("symlink");
        let mut aia = session("aia", ProviderId::Claude, Some(&fx.aia), false, None);
        aia.aia_workspace = true;
        aia.written_dirs = vec![text(&link.join("src"))];
        let mut sessions = vec![
            aia,
            session("outer", ProviderId::Claude, Some(&link), false, None),
            session("inner", ProviderId::Claude, Some(&sub), false, None),
        ];
        relate(&mut sessions, &[], &fx.home);
        assert_eq!(sessions[0].related_projects, vec![text(&sub)]);
    }

    #[test]
    fn a_worktree_inside_its_own_repository_relates_to_that_repository() {
        // Claude Code 워크트리(`/repo/.claude/worktrees/x`)는 본 저장소 아래에 있다. 스캔이
        // 본 저장소 경로로 옮겨 둔 수정은 상위 프로젝트 규칙에 걸리지 않고 본 저장소에 맞는다.
        let fx = related_fixture();
        let worktree = fx.app.join(".claude/worktrees/x");
        fs::create_dir_all(&worktree).expect("worktree");
        fs::create_dir_all(fx.app.join(".git/worktrees/x")).expect("git worktrees");
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", fx.app.join(".git/worktrees/x").display()),
        )
        .expect("marker");
        let mut inside = session("wt", ProviderId::Claude, Some(&worktree), false, None);
        // 워크트리 맨 위 파일을 고친 수정은 본 저장소 자신으로 옮겨져 있다. (`app/src`는 아래
        // 세션이 따로 연 프로젝트라, 그 폴더 수정이면 더 깊은 그 프로젝트에 맞는다.)
        inside.written_dirs = vec![text(&fx.app)];
        // 일반 하위 폴더에서 연 세션은 그대로 상위 프로젝트 규칙을 따른다.
        let mut plain = session(
            "sub",
            ProviderId::Claude,
            Some(&fx.app.join("src")),
            false,
            None,
        );
        plain.written_dirs = vec![text(&fx.app)];
        let mut sessions = vec![
            inside,
            plain,
            session("app", ProviderId::Claude, Some(&fx.app), false, None),
        ];
        relate(&mut sessions, &[], &fx.home);
        assert_eq!(sessions[0].related_projects, vec![text(&fx.app)]);
        assert!(sessions[1].related_projects.is_empty());
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

    #[test]
    fn registry_orders_by_recent_activity_then_name_then_path() {
        // 항목은 경로 키 BTreeMap 순서로 들어오고 정렬은 안정적이므로, 각 단계의 기대 순서가
        // 그 경로 순서와 어긋나게 골라야 그 단계를 지웠을 때 시험이 깨진다.
        let root = tempfile::tempdir().expect("temp");
        let dirs = ["p1", "p2", "p3", "p4"].map(|name| {
            let dir = root.path().join(name);
            fs::create_dir_all(&dir).expect("dir");
            dir
        });
        let named = |id: &str, dir: &Path, name: &str, updated_at: Option<i64>| {
            let mut summary = session(id, ProviderId::Codex, Some(dir), false, updated_at);
            summary.project = Some(name.to_owned());
            summary
        };
        // 경로 순서 p1 < p2 이지만 이름 순서는 alpha(p2) < zeta(p1).
        // 시각 없는 p3 는 경로상 앞서지만 맨 뒤로, 가장 최근인 p4 는 맨 앞으로 가야 한다.
        let sessions = vec![
            named("z", &dirs[0], "zeta", Some(5)),
            named("a", &dirs[1], "alpha", Some(5)),
            named("n", &dirs[2], "none", None),
            named("m", &dirs[3], "mid", Some(9)),
        ];
        // 이름이 같은 세션 없는 제외 항목: 성분 비교(BTreeMap)로는 a/twin < a-x/twin 이지만
        // 문자열 비교로는 '-'가 구분자보다 작아 a-x/twin 이 앞선다(유닉스·윈도 모두).
        let twin_plain = root.path().join("a").join("twin");
        let twin_dash = root.path().join("a-x").join("twin");
        let mut resolver = ProjectPathResolver::default();
        let registry = build_project_registry(
            &sessions,
            &policy(&[&twin_plain, &twin_dash], None),
            &mut resolver,
        );
        assert_eq!(
            registry
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["mid", "alpha", "zeta", "none", "twin", "twin"]
        );
        assert_eq!(registry[4].path, twin_dash.to_string_lossy());
        assert_eq!(registry[5].path, twin_plain.to_string_lossy());
    }

    #[test]
    fn evaluate_status_and_resolve_key() {
        let root = tempfile::tempdir().expect("temp");
        let proj = root.path().join("proj");
        fs::create_dir_all(&proj).expect("proj");
        let canonical = fs::canonicalize(&proj).expect("canonical");
        let raw_str = proj.to_string_lossy();

        // 1. 시드 전 정책: 활성이며 결정 대기 아님
        let unseeded = policy(&[], None);
        assert_eq!(
            unseeded.evaluate_status(Some(&canonical), &raw_str),
            (true, false)
        );

        // 2. 이미 알려진 프로젝트: 활성이며 결정 대기 아님
        let seeded = policy(&[], Some(&[&canonical]));
        assert_eq!(
            seeded.evaluate_status(Some(&canonical), &raw_str),
            (true, false)
        );

        // 3. 새로 발견된 프로젝트: 활성이며 결정 대기
        let other = root.path().join("other");
        assert_eq!(seeded.evaluate_status(Some(&other), "other"), (true, true));

        // 4. 제외된 프로젝트: 비활성이며 결정 대기 아님
        let excluded = policy(&[&canonical], Some(&[&canonical]));
        assert_eq!(
            excluded.evaluate_status(Some(&canonical), &raw_str),
            (false, false)
        );

        // 5. resolver resolve_key: 존재하는 디렉터리는 정규 경로, 존재하지 않으면 원문 경로
        let mut resolver = ProjectPathResolver::default();
        assert_eq!(resolver.resolve_key(&raw_str), canonical);
        let nonexistent = root.path().join("nonexistent");
        let non_str = nonexistent.to_string_lossy();
        assert_eq!(
            resolver.resolve_key(&non_str),
            PathBuf::from(non_str.as_ref())
        );
    }
}
