//! 경로 경계 가드. G10에 따라 파일을 읽거나 쓰기 전에 대상 경로를 정규화해
//! 허용된 루트 안인지 확인한다.
//!
//! 아직 존재하지 않는 대상은 그대로 정규화할 수 없으므로, 존재하는 가장 가까운
//! 조상까지 정규화한 뒤 남은 이름을 다시 붙인다. 이 순서를 지켜야
//! `/safe/link -> /` 같은 심볼릭 링크 아래에 쓰기 전에 실제 대상을 알 수 있다.

use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::domain::wire_enum;
use crate::CoreError;

/// 경로에 상위 경로(`..`) 구성요소가 있는지.
///
/// 절대 경로를 받는 자리(`store`·`resource_repository`·`project_instructions`·`user_path`)가
/// 정규화 전에 `..`을 먼저 걷어내려고 같은 `matches!` 접기를 각자 적어 두었다. 판정만
/// 여기 모으고, 무엇을 받는 자리인지 아는 호출부가 거절 문구를 계속 정한다.
pub(crate) fn has_parent_dir(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

/// `.` 구성요소를 어떻게 볼지. 대부분은 정규 상대 경로만 받지만, 지침 구성 파일 경로는
/// 원본이 `./doc.md` 꼴로 적어 둔 것을 그대로 받아야 해서 통과시킨다.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum CurDirPolicy {
    #[default]
    Reject,
    Allow,
}

impl CurDirPolicy {
    #[cfg(test)]
    pub const ALL: [Self; 2] = [Self::Reject, Self::Allow];
}

wire_enum!(display_only CurDirPolicy, {
    Reject => "reject",
    Allow => "allow",
});

/// 상대 경로 구성요소에서 처음 만난 위반.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RelativePathIssue {
    /// 구성요소가 하나도 없다(빈 경로).
    Empty,
    /// `.`이 섞여 있다.
    CurDir,
    /// `..`로 기준 디렉터리를 벗어난다.
    ParentDir,
    /// 루트(`/`)나 접두사로 시작하는 절대 경로다.
    Absolute,
    /// 이름이 빈 구성요소.
    EmptyComponent,
}

impl RelativePathIssue {
    #[cfg(test)]
    pub const ALL: [Self; 5] = [
        Self::Empty,
        Self::CurDir,
        Self::ParentDir,
        Self::Absolute,
        Self::EmptyComponent,
    ];
}

wire_enum!(display_only RelativePathIssue, {
    Empty => "empty",
    CurDir => "curDir",
    ParentDir => "parentDir",
    Absolute => "absolute",
    EmptyComponent => "emptyComponent",
});

/// 상대 경로 구성요소를 앞에서부터 훑어 처음 만난 위반을 돌려준다. 위반이 없으면 `None`.
///
/// `skill_library`·`project_instructions`·`cypress_workspaces`·`resource_repository`·`store`가
/// "`..`·절대 경로·`.`을 거른다"를 각자 적어 두었고, 어떤 판은 `match`로 어떤 판은
/// `any(!matches!(..))`로 적혀 있어 무엇을 거르는지 읽어야만 알 수 있었다. 판정을 한 곳에
/// 모으되 문구는 돌려주지 않는다 — 같은 위반도 "스킬 구성 파일"과 "작업공간"에서 부르는
/// 이름이 다르고, 그 이름은 호출부만 안다.
pub(crate) fn classify_relative_path(
    relative: &Path,
    cur_dir: CurDirPolicy,
) -> Option<RelativePathIssue> {
    let mut seen = false;
    for component in relative.components() {
        seen = true;
        let issue = match component {
            Component::Normal(name) if name.is_empty() => RelativePathIssue::EmptyComponent,
            Component::Normal(_) => continue,
            Component::CurDir if cur_dir == CurDirPolicy::Allow => continue,
            Component::CurDir => RelativePathIssue::CurDir,
            Component::ParentDir => RelativePathIssue::ParentDir,
            Component::RootDir | Component::Prefix(_) => RelativePathIssue::Absolute,
        };
        return Some(issue);
    }
    (!seen).then_some(RelativePathIssue::Empty)
}

/// 끝부분을 정규화하지 못했을 때 상위로 올라갈 조건.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum MissingTail {
    /// 정규화 실패 원인을 가리지 않고 상위로 올라간다. 루트 안인지만 판정하는
    /// 호출부가 쓴다 — 읽을 수 없는 조상은 애초에 통과할 수 없다.
    #[default]
    SkipAnyError,
    /// 대상이 없을 때만 상위로 올라가고, 다른 입출력 오류는 그대로 올린다.
    /// 정규화 결과를 실제 쓰기 대상으로 쓰는 호출부가 쓴다.
    SkipNotFound,
}

impl MissingTail {
    #[cfg(test)]
    pub const ALL: [Self; 2] = [Self::SkipAnyError, Self::SkipNotFound];
}

wire_enum!(display_only MissingTail, {
    SkipAnyError => "skipAnyError",
    SkipNotFound => "skipNotFound",
});

/// 오류 문구에 쓰는 이름. 호출부마다 부르는 이름이 달라 문구를 통째로 받는다.
#[derive(Clone, Copy, Debug)]
pub(crate) struct RootLabels {
    /// 경로를 확인하지 못했을 때 쓰는 주어. 예: `"스킬 경로"`
    pub subject: &'static str,
    /// 루트를 벗어났을 때 쓰는 문장. 예: `"스킬 경로가 허용된 루트를 벗어납니다"`
    pub escaped: &'static str,
}

/// 존재하는 가장 가까운 조상을 정규화한 뒤 남은 이름을 다시 붙여 돌려준다.
pub(crate) fn resolve_existing_ancestor(
    path: &Path,
    missing: MissingTail,
    subject: &str,
) -> Result<PathBuf, CoreError> {
    let unresolvable = || CoreError::InvalidInput(format!("{subject}를 확인할 수 없습니다"));
    let mut probe = path.to_path_buf();
    let mut tail: Vec<OsString> = Vec::new();
    let mut resolved = loop {
        match fs::canonicalize(&probe) {
            Ok(value) => break value,
            Err(error) => {
                if missing == MissingTail::SkipNotFound
                    && error.kind() != std::io::ErrorKind::NotFound
                {
                    return Err(CoreError::Io(error));
                }
                let Some(name) = probe.file_name().map(|name| name.to_owned()) else {
                    return Err(unresolvable());
                };
                tail.push(name);
                if !probe.pop() {
                    return Err(unresolvable());
                }
            }
        }
    };
    for name in tail.into_iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

/// 해석한 경로가 기대한 루트 안에 있는지 확인한다. 심볼릭 링크로 루트 밖을
/// 가리키는 경우까지 잡기 위해 정규화한 경로로 비교한다.
pub(crate) fn assert_within_root(
    root: &Path,
    candidate: &Path,
    labels: RootLabels,
) -> Result<(), CoreError> {
    let canonical_root = fs::canonicalize(root)?;
    let resolved = resolve_existing_ancestor(candidate, MissingTail::SkipAnyError, labels.subject)?;
    if !resolved.starts_with(&canonical_root) {
        return Err(CoreError::InvalidInput(format!(
            "{}: {}",
            labels.escaped,
            candidate.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LABELS: RootLabels = RootLabels {
        subject: "시험 경로",
        escaped: "시험 경로가 허용된 루트를 벗어납니다",
    };

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("agent-manager-path-guard-{name}"));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("temp root");
        fs::canonicalize(&root).expect("canonical temp root")
    }

    #[test]
    fn parent_dir_is_detected_anywhere_in_the_path() {
        assert!(has_parent_dir(Path::new("/a/../b")));
        assert!(has_parent_dir(Path::new("..")));
        assert!(!has_parent_dir(Path::new("/a/b")));
    }

    #[test]
    fn relative_path_reports_the_first_violating_component() {
        let reject = |value: &str| classify_relative_path(Path::new(value), CurDirPolicy::Reject);
        assert_eq!(reject("a/b.md"), None);
        assert_eq!(reject(""), Some(RelativePathIssue::Empty));
        assert_eq!(reject("./a"), Some(RelativePathIssue::CurDir));
        assert_eq!(reject("a/../b"), Some(RelativePathIssue::ParentDir));
        assert_eq!(reject("/a"), Some(RelativePathIssue::Absolute));
        // 앞선 구성요소가 이긴다. `..`이 뒤에 있어도 먼저 만난 `.`을 보고한다.
        assert_eq!(reject("./.."), Some(RelativePathIssue::CurDir));
    }

    #[test]
    fn allowing_cur_dir_still_reports_later_violations() {
        let allow = |value: &str| classify_relative_path(Path::new(value), CurDirPolicy::Allow);
        assert_eq!(allow("./a"), None);
        assert_eq!(allow("."), None);
        assert_eq!(allow(""), Some(RelativePathIssue::Empty));
        assert_eq!(allow("./.."), Some(RelativePathIssue::ParentDir));
    }

    #[test]
    fn missing_tail_is_resolved_against_the_nearest_existing_ancestor() {
        let root = temp_root("missing-tail");
        let resolved = resolve_existing_ancestor(
            &root.join("absent/child.md"),
            MissingTail::SkipAnyError,
            "시험 경로",
        )
        .expect("resolved");
        assert_eq!(resolved, root.join("absent/child.md"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_symlink_escaping_the_root_is_rejected() {
        let root = temp_root("escaping-symlink");
        let inside = root.join("inside");
        let outside = root.join("outside");
        fs::create_dir_all(&inside).expect("inside");
        fs::create_dir_all(&outside).expect("outside");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, inside.join("link")).expect("symlink");
        #[cfg(unix)]
        {
            let error = assert_within_root(&inside, &inside.join("link/file.md"), LABELS)
                .expect_err("escape rejected");
            assert!(matches!(error, CoreError::InvalidInput(message) if message
                .starts_with("시험 경로가 허용된 루트를 벗어납니다")));
        }
        assert_within_root(&inside, &inside.join("file.md"), LABELS).expect("inside root");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cur_dir_policy_constants_and_display() {
        assert_eq!(
            CurDirPolicy::ALL,
            [CurDirPolicy::Reject, CurDirPolicy::Allow]
        );
        assert_eq!(CurDirPolicy::default(), CurDirPolicy::Reject);
        for policy in CurDirPolicy::ALL {
            assert_eq!(policy.to_string(), policy.as_str());
        }
    }

    #[test]
    fn relative_path_issue_constants_and_display() {
        assert_eq!(
            RelativePathIssue::ALL,
            [
                RelativePathIssue::Empty,
                RelativePathIssue::CurDir,
                RelativePathIssue::ParentDir,
                RelativePathIssue::Absolute,
                RelativePathIssue::EmptyComponent,
            ]
        );
        for issue in RelativePathIssue::ALL {
            assert_eq!(issue.to_string(), issue.as_str());
        }
    }

    #[test]
    fn missing_tail_constants_and_display() {
        assert_eq!(
            MissingTail::ALL,
            [MissingTail::SkipAnyError, MissingTail::SkipNotFound]
        );
        assert_eq!(MissingTail::default(), MissingTail::SkipAnyError);
        for missing in MissingTail::ALL {
            assert_eq!(missing.to_string(), missing.as_str());
        }
    }
}
