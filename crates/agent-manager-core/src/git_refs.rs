//! git 저장소의 브랜치를 `git`을 실행하지 않고 파일에서 직접 읽는다.
//!
//! 브랜치 판정은 실행을 띄우는 길목마다 걸리므로 외부 프로세스를 띄울 수 없다. 대신
//! `.git`이 가리키는 자리에서 `HEAD`·`refs/heads`·`packed-refs`만 읽는다. 어느 한 곳도
//! 쓰지 않으며, 읽지 못하면 "브랜치를 모른다"로 떨어진다 — 여기서 실패해도 호출부가
//! 기존 동작 그대로 가게 하려는 것이다.
//!
//! 읽는 자리는 상한으로 막혀 있다: 위로 올라갈 깊이, `refs/heads` 아래로 내려갈 깊이,
//! 한 줄짜리 git 파일의 바이트, `packed-refs`의 바이트. 저장소가 아닌 폴더를 물었을 때
//! 파일시스템을 무한정 훑지 않게 하는 경계다.

use std::fs;
use std::path::{Path, PathBuf};

/// `.git/HEAD`와 `.git` 링크 파일에서 읽어 들일 최대 바이트. 둘 다 한 줄짜리다.
const MAX_GIT_FILE_BYTES: usize = 4096;
/// 작업 폴더에서 위로 올라가며 `.git`을 찾을 최대 깊이.
const MAX_GIT_WALK_DEPTH: usize = 64;
/// `packed-refs`는 한 줄짜리 git 파일들과 달리 브랜치 수만큼 길어진다.
const MAX_PACKED_REFS_BYTES: u64 = 2 * 1024 * 1024;
/// `refs/heads` 아래로 내려갈 최대 깊이. `a/b/c` 정도를 넉넉히 담는다.
const MAX_REFS_WALK_DEPTH: usize = 8;

/// 폴더에서 위로 올라가며 찾은 첫 git 저장소의 현재 브랜치. detached HEAD면 None이다.
pub(crate) fn head_branch(start: &Path) -> Option<String> {
    let mut current = Some(start);
    for _ in 0..MAX_GIT_WALK_DEPTH {
        let directory = current?;
        let git = directory.join(".git");
        if let Some(head) = read_head(&git) {
            return head;
        }
        current = directory.parent();
    }
    None
}

/// 폴더가 속한 저장소의 로컬 브랜치 이름(사전순, 중복 제거). `refs/heads`의 낱개 참조와
/// `packed-refs`를 둘 다 읽어 합친다 — 한쪽에만 있는 브랜치가 흔하다. 저장소가 아니거나
/// 읽지 못하면 빈 목록이다.
///
/// `accept`는 호출부가 쓸 수 없는 이름을 거르는 자리다. 목록에 올려 봐야 고르는 순간
/// 거절당할 이름을 미리 뺀다. `limit`은 읽어 들이는 동안과 마지막 정렬 뒤 두 번 걸린다 —
/// 참조가 수만 개인 저장소에서 목록을 다 모았다가 거르는 일이 없게 하려는 것이다.
pub(crate) fn local_branches(
    start: &Path,
    limit: usize,
    accept: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let mut current = Some(start);
    for _ in 0..MAX_GIT_WALK_DEPTH {
        let directory = match current {
            Some(directory) => directory,
            None => break,
        };
        if let Some(git_dir) = git_dir(&directory.join(".git")) {
            let common = common_git_dir(&git_dir);
            let mut names = Vec::new();
            collect_loose_branches(&common.join("refs/heads"), "", 0, limit, &mut names);
            collect_packed_branches(&common.join("packed-refs"), limit, &mut names);
            names.retain(|name| accept(name));
            names.sort();
            names.dedup();
            names.truncate(limit);
            return names;
        }
        current = directory.parent();
    }
    Vec::new()
}

/// `.git`이 폴더면 그 폴더가, 워크트리처럼 파일이면 `gitdir:`이 가리키는 폴더가 그 작업
/// 폴더의 git 디렉터리다. 둘 다 아니면 git 저장소가 아니다.
fn git_dir(git: &Path) -> Option<PathBuf> {
    if git.is_dir() {
        return Some(git.to_path_buf());
    }
    if !git.is_file() {
        return None;
    }
    let link = read_small(git)?;
    let target = PathBuf::from(link.trim().strip_prefix("gitdir:")?.trim());
    if target.is_absolute() {
        Some(target)
    } else {
        Some(git.parent()?.join(target))
    }
}

/// 워크트리의 git 디렉터리에는 `refs`가 없고 `commondir`이 본체를 가리킨다. 본체
/// 저장소면 자기 자신이다.
fn common_git_dir(git_dir: &Path) -> PathBuf {
    let Some(text) = read_small(&git_dir.join("commondir")) else {
        return git_dir.to_path_buf();
    };
    let target = PathBuf::from(text.trim());
    if target.is_absolute() {
        target
    } else {
        git_dir.join(target)
    }
}

/// `refs/heads` 아래 파일 하나가 브랜치 하나다. 하위 폴더는 이름의 `/` 앞자리가 된다.
fn collect_loose_branches(
    directory: &Path,
    prefix: &str,
    depth: usize,
    limit: usize,
    out: &mut Vec<String>,
) {
    if depth > MAX_REFS_WALK_DEPTH || out.len() >= limit {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let full = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => {
                collect_loose_branches(&entry.path(), &full, depth + 1, limit, out)
            }
            Ok(_) => out.push(full),
            Err(_) => continue,
        }
    }
}

/// `packed-refs`는 `<sha> refs/heads/<이름>` 줄의 모음이다. 주석(`#`)과 태그 역참조(`^`)는
/// 건너뛰고 로컬 브랜치만 고른다.
fn collect_packed_branches(path: &Path, limit: usize, out: &mut Vec<String>) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if !metadata.is_file() || metadata.len() > MAX_PACKED_REFS_BYTES {
        return;
    }
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    for line in text.lines() {
        if out.len() >= limit {
            return;
        }
        if line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        let Some((_, reference)) = line.split_once(' ') else {
            continue;
        };
        if let Some(branch) = reference.trim().strip_prefix("refs/heads/") {
            if !branch.is_empty() {
                out.push(branch.to_owned());
            }
        }
    }
}

/// `.git`이 가리키는 git 디렉터리의 HEAD를 읽는다. git 저장소가 아니면 None, 저장소인데
/// 브랜치가 없으면(detached HEAD) `Some(None)`이다.
fn read_head(git: &Path) -> Option<Option<String>> {
    let head = git_dir(git)?.join("HEAD");
    let text = read_small(&head)?;
    Some(
        text.trim()
            .strip_prefix("ref:")
            .map(str::trim)
            .and_then(|reference| reference.strip_prefix("refs/heads/"))
            .filter(|branch| !branch.is_empty())
            .map(str::to_owned),
    )
}

/// git 디렉터리 안의 작은 상태 파일(`HEAD`, `commondir`, `rebase-merge/onto` 등)을
/// 크기 상한 아래에서만 읽는다. 형상관리 화면의 진행 중 작업 판정도 같은 파일을 본다.
pub(crate) fn read_small(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_GIT_FILE_BYTES as u64 {
        return None;
    }
    fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn all_branches(start: &Path) -> Vec<String> {
        local_branches(start, 500, &|_| true)
    }

    #[test]
    fn head_reads_branch_from_directory_and_worktree_link() {
        let root = tempdir().expect("temp");
        let repo = root.path().join("repo");
        fs::create_dir_all(repo.join(".git")).expect("git dir");
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/dev-history\n").expect("head");
        assert_eq!(
            head_branch(&repo),
            Some("dev-history".to_owned()),
            "폴더 .git에서 브랜치를 읽는다"
        );

        let worktree = root.path().join("lane");
        let gitdir = repo.join(".git/worktrees/lane");
        fs::create_dir_all(&gitdir).expect("worktree git dir");
        fs::create_dir_all(&worktree).expect("worktree");
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .expect("git link");
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/lane-3\n").expect("worktree head");
        assert_eq!(head_branch(&worktree), Some("lane-3".to_owned()));

        fs::write(repo.join(".git/HEAD"), "9f0b2c1d\n").expect("detached head");
        assert_eq!(head_branch(&repo), None, "detached HEAD는 브랜치가 없다");
    }

    #[test]
    fn local_branches_merge_loose_refs_packed_refs_and_worktrees() {
        let root = tempdir().expect("temp");
        let repo = root.path().join("repo");
        let heads = repo.join(".git/refs/heads");
        fs::create_dir_all(heads.join("feature")).expect("heads");
        fs::write(repo.join(".git/HEAD"), "ref: refs/heads/main\n").expect("head");
        fs::write(heads.join("main"), "9f0b2c1d\n").expect("main ref");
        fs::write(heads.join("feature/login"), "9f0b2c1d\n").expect("nested ref");
        fs::write(
            repo.join(".git/packed-refs"),
            "# pack-refs with: peeled fully-peeled sorted\n\
             9f0b2c1d refs/heads/release/3\n\
             9f0b2c1d refs/tags/v1\n\
             ^0a1b2c3d\n\
             9f0b2c1d refs/heads/main\n",
        )
        .expect("packed refs");
        assert_eq!(
            all_branches(&repo),
            vec![
                "feature/login".to_owned(),
                "main".to_owned(),
                "release/3".to_owned(),
            ],
            "낱개 참조와 packed-refs를 합치고 태그는 빼며 중복은 한 번만 싣는다"
        );
        // 하위 폴더에서 물어도 저장소를 찾아 올라간다.
        let nested = repo.join("src/lib");
        fs::create_dir_all(&nested).expect("nested folder");
        assert_eq!(all_branches(&nested).len(), 3);

        let worktree = root.path().join("lane");
        let gitdir = repo.join(".git/worktrees/lane");
        fs::create_dir_all(&gitdir).expect("worktree git dir");
        fs::create_dir_all(&worktree).expect("worktree");
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .expect("git link");
        fs::write(gitdir.join("HEAD"), "ref: refs/heads/feature/login\n").expect("worktree head");
        fs::write(gitdir.join("commondir"), "../..\n").expect("commondir");
        assert_eq!(
            all_branches(&worktree).len(),
            3,
            "워크트리는 commondir이 가리키는 본체에서 브랜치를 읽는다"
        );

        assert!(
            all_branches(root.path()).is_empty(),
            "git 저장소가 아니면 빈 목록이다"
        );
    }

    #[test]
    fn a_rejected_name_never_reaches_the_listing() {
        let root = tempdir().expect("temp");
        let heads = root.path().join(".git/refs/heads");
        fs::create_dir_all(&heads).expect("heads");
        for name in ["keep-1", "drop-1", "keep-2"] {
            fs::write(heads.join(name), "9f0b2c1d\n").expect("ref");
        }
        assert_eq!(
            local_branches(root.path(), 500, &|name| name.starts_with("keep-")),
            vec!["keep-1".to_owned(), "keep-2".to_owned()],
            "호출부가 거절할 이름은 목록에 오르지 않는다"
        );
    }
}
