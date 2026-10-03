//! Homebrew cask로 설치한 공급자 CLI의 macOS 격리 속성 자동 해제 (AGENTS.md `C18`).
//!
//! Homebrew는 cask를 설치·업그레이드할 때마다 새 버전 폴더의 실행 파일에
//! `com.apple.quarantine`을 붙인다. Codex의 `codex-code-mode-host`는 이 속성이 남아 있으면
//! 실행될 때마다 Gatekeeper 평가에 걸려 응답하지 않고, code-mode 전용 모델(GPT-5.6·GPT-6
//! 계열)이 `timed out negotiating with the code-mode host`로 전부 멈춘다. 업데이트는 앱 밖
//! 터미널에서도 일어나므로 업데이트 시점이 아니라 **실행 파일을 해석하는 자리**에서 확인한다.
//!
//! 해제 범위는 좁게 둔다.
//! - 대상은 `Caskroom/<토큰>/<버전>/…` 아래 실행 파일과 **같은 폴더의 일반 파일**뿐이다.
//!   심링크·하위 폴더는 보지 않는다(`C18-1`).
//! - 토큰은 [`TRUSTED_CASK_SIGNERS`]에 등록된 cask만, 파일은 그 cask 개발사의 Developer ID
//!   팀으로 서명된 것만 해제한다. 서명 검증은 `/usr/bin/codesign`에 맡긴다(`C18-2`).
//! - 지우는 것은 `com.apple.quarantine` 속성 하나다. 파일 내용·권한·다른 속성은 건드리지
//!   않는다(`C18-3`).

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 격리 해제를 허용하는 cask 토큰과 그 개발사의 Developer ID 팀.
///
/// 팀 ID는 설치본의 `codesign -dv` 출력(`TeamIdentifier=`)으로 확인해 등록한다.
/// - `codex`: OpenAI OpCo, LLC
const TRUSTED_CASK_SIGNERS: &[(&str, &str)] = &[("codex", "2DC432GLL2")];

/// 한 폴더에서 살펴볼 파일 수 상한. cask의 `bin`은 실행 파일 몇 개뿐이다.
const MAX_CANDIDATES: usize = 32;

/// 이미 확인을 끝낸 버전 폴더. 업그레이드하면 버전 폴더 이름이 바뀌므로 새 폴더는 다시
/// 확인된다. 해제를 거절한 파일이 남은 폴더는 넣지 않아 다음 실행 때 다시 본다.
fn settled_dirs() -> &'static Mutex<HashSet<PathBuf>> {
    static SETTLED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    SETTLED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 실행 파일이 등록된 cask 설치본이면 같은 폴더 실행 파일들의 격리 속성을 해제한다.
///
/// 실패해도 호출자의 실행을 막지 않는다. 결과는 로그로만 남긴다.
pub(crate) fn release_cask_quarantine(executable: &Path) {
    let Some((dir, team)) = cask_target(executable) else {
        return;
    };
    if settled_dirs()
        .lock()
        .map(|settled| settled.contains(&dir))
        .unwrap_or(false)
    {
        return;
    }
    let outcome = release_in(
        &dir,
        team,
        platform::has_quarantine,
        platform::signed_by_team,
        platform::remove_quarantine,
    );
    for path in &outcome.released {
        eprintln!(
            "[cli-quarantine] 격리 속성을 해제했습니다: {}",
            path.display()
        );
    }
    for (path, reason) in &outcome.refused {
        eprintln!(
            "[cli-quarantine] 격리 속성을 그대로 둡니다: {} ({reason})",
            path.display()
        );
    }
    if outcome.refused.is_empty() {
        if let Ok(mut settled) = settled_dirs().lock() {
            settled.insert(dir);
        }
    }
}

/// `…/Caskroom/<토큰>/<버전>/…/<실행 파일>`이면 실행 파일의 폴더와 그 토큰의 서명 팀.
fn cask_target(executable: &Path) -> Option<(PathBuf, &'static str)> {
    let segments = executable
        .components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let index = segments.iter().position(|segment| segment == "Caskroom")?;
    // Caskroom, 토큰, 버전 폴더 아래에 실행 파일이 있어야 한다.
    if segments.len() < index + 4 {
        return None;
    }
    let token = segments.get(index + 1)?;
    let team = TRUSTED_CASK_SIGNERS
        .iter()
        .find(|(trusted, _)| trusted == token)
        .map(|(_, team)| *team)?;
    Some((executable.parent()?.to_path_buf(), team))
}

/// codesign 요구 조건: Apple이 발급한 Developer ID Application 인증서이고 리프 인증서의
/// 조직 단위가 등록된 팀일 것. ad-hoc 서명이나 다른 팀 서명은 통과하지 못한다.
fn signer_requirement(team: &str) -> String {
    format!(
        "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists \
         and certificate leaf[field.1.2.840.113635.100.6.1.13] exists \
         and certificate leaf[subject.OU] = \"{team}\""
    )
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ReleaseOutcome {
    released: Vec<PathBuf>,
    refused: Vec<(PathBuf, String)>,
}

/// 폴더의 일반 파일 중 격리 속성이 있는 것을 서명 확인 뒤 해제한다. 속성 조회·서명 확인·
/// 해제를 인자로 받아 플랫폼 호출 없이 절차를 시험할 수 있게 한다.
fn release_in(
    dir: &Path,
    team: &str,
    has_quarantine: impl Fn(&Path) -> Result<bool, String>,
    signed_by_team: impl Fn(&Path, &str) -> Result<(), String>,
    remove_quarantine: impl Fn(&Path) -> Result<(), String>,
) -> ReleaseOutcome {
    let mut outcome = ReleaseOutcome::default();
    let Ok(entries) = fs::read_dir(dir) else {
        return outcome;
    };
    let mut candidates = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            fs::symlink_metadata(path)
                .map(|metadata| metadata.is_file())
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.truncate(MAX_CANDIDATES);

    for path in candidates {
        match has_quarantine(&path) {
            Ok(false) => continue,
            Ok(true) => {}
            Err(reason) => {
                outcome.refused.push((path, reason));
                continue;
            }
        }
        if let Err(reason) = signed_by_team(&path, team) {
            outcome.refused.push((path, reason));
            continue;
        }
        match remove_quarantine(&path) {
            Ok(()) => outcome.released.push(path),
            Err(reason) => outcome.refused.push((path, reason)),
        }
    }
    outcome
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;
    use std::time::Duration;

    use crate::cli_interface::run_capped;

    const QUARANTINE_ATTRIBUTE: &str = "com.apple.quarantine";
    const CODESIGN: &str = "/usr/bin/codesign";
    const CODESIGN_TIMEOUT: Duration = Duration::from_secs(20);

    fn c_path(path: &Path) -> Result<CString, String> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "경로에 NUL 문자가 있습니다".to_owned())
    }

    fn attribute_name() -> CString {
        CString::new(QUARANTINE_ATTRIBUTE).expect("속성 이름에 NUL이 없다")
    }

    pub(super) fn has_quarantine(path: &Path) -> Result<bool, String> {
        let path = c_path(path)?;
        let name = attribute_name();
        // SAFETY: 두 포인터는 호출 동안 살아 있는 NUL 종료 문자열이고, 값 버퍼 없이 크기만 묻는다.
        let size = unsafe {
            libc::getxattr(
                path.as_ptr(),
                name.as_ptr(),
                std::ptr::null_mut(),
                0,
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        if size >= 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOATTR) {
            Ok(false)
        } else {
            Err(format!("격리 속성을 읽지 못했습니다: {error}"))
        }
    }

    pub(super) fn signed_by_team(path: &Path, team: &str) -> Result<(), String> {
        let target = path
            .to_str()
            .ok_or_else(|| "경로가 UTF-8이 아닙니다".to_owned())?;
        let requirement = format!("-R={}", super::signer_requirement(team));
        let outcome = run_capped(
            Path::new(CODESIGN),
            &["--verify", "--strict", &requirement, target],
            CODESIGN_TIMEOUT,
        )
        .map_err(|error| format!("서명을 확인하지 못했습니다: {error}"))?;
        if outcome.success {
            Ok(())
        } else if outcome.timed_out {
            Err("서명 확인이 제한시간을 넘었습니다".to_owned())
        } else {
            Err(format!("등록된 개발사({team}) 서명이 아닙니다"))
        }
    }

    pub(super) fn remove_quarantine(path: &Path) -> Result<(), String> {
        let path = c_path(path)?;
        let name = attribute_name();
        // SAFETY: 두 포인터는 호출 동안 살아 있는 NUL 종료 문자열이다.
        let result =
            unsafe { libc::removexattr(path.as_ptr(), name.as_ptr(), libc::XATTR_NOFOLLOW) };
        if result == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ENOATTR) {
            Ok(())
        } else {
            Err(format!("격리 속성을 지우지 못했습니다: {error}"))
        }
    }
}

/// macOS가 아니면 격리 속성이 없다. 호출 자리를 플랫폼마다 가르지 않도록 빈 구현을 둔다.
#[cfg(not(target_os = "macos"))]
mod platform {
    use std::path::Path;

    pub(super) fn has_quarantine(_path: &Path) -> Result<bool, String> {
        Ok(false)
    }

    pub(super) fn signed_by_team(_path: &Path, _team: &str) -> Result<(), String> {
        Err("macOS가 아닙니다".to_owned())
    }

    pub(super) fn remove_quarantine(_path: &Path) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn cask_bin(root: &Path, token: &str) -> PathBuf {
        let bin = root.join("Caskroom").join(token).join("1.2.3").join("bin");
        fs::create_dir_all(&bin).unwrap();
        bin
    }

    #[test]
    fn c18_1_only_a_registered_cask_version_folder_is_a_target() {
        let root = Path::new("/opt/homebrew");
        let codex = root.join("Caskroom/codex/0.159.2/bin/codex");
        assert_eq!(
            cask_target(&codex),
            Some((root.join("Caskroom/codex/0.159.2/bin"), "2DC432GLL2"))
        );
        // 등록되지 않은 cask, cask 밖 경로, 버전 폴더가 빠진 경로는 대상이 아니다.
        assert_eq!(
            cask_target(&root.join("Caskroom/other/1.0/bin/other")),
            None
        );
        assert_eq!(cask_target(&root.join("bin/codex")), None);
        assert_eq!(cask_target(&root.join("Caskroom/codex/codex")), None);
        assert_eq!(cask_target(&root.join("Cellar/codex/1.0/bin/codex")), None);
    }

    #[test]
    fn c18_2_requirement_pins_developer_id_and_team() {
        let requirement = signer_requirement("2DC432GLL2");
        assert!(requirement.starts_with("anchor apple generic"));
        assert!(requirement.contains("1.2.840.113635.100.6.1.13"));
        assert!(requirement.ends_with("certificate leaf[subject.OU] = \"2DC432GLL2\""));
    }

    #[test]
    fn c18_2_quarantined_files_are_released_only_after_the_signature_passes() {
        let temp = tempfile::tempdir().unwrap();
        let bin = cask_bin(temp.path(), "codex");
        for name in ["codex", "codex-code-mode-host", "clean", "unsigned"] {
            fs::write(bin.join(name), b"x").unwrap();
        }
        let removed = RefCell::new(Vec::new());
        let outcome = release_in(
            &bin,
            "2DC432GLL2",
            |path| Ok(!path.ends_with("clean")),
            |path, team| {
                assert_eq!(team, "2DC432GLL2");
                if path.ends_with("unsigned") {
                    Err("등록된 개발사(2DC432GLL2) 서명이 아닙니다".to_owned())
                } else {
                    Ok(())
                }
            },
            |path| {
                removed.borrow_mut().push(path.to_path_buf());
                Ok(())
            },
        );
        assert_eq!(
            outcome.released,
            vec![bin.join("codex"), bin.join("codex-code-mode-host")]
        );
        assert_eq!(outcome.refused.len(), 1);
        assert_eq!(outcome.refused[0].0, bin.join("unsigned"));
        assert_eq!(removed.into_inner(), outcome.released);
    }

    #[cfg(unix)]
    #[test]
    fn c18_1_symlinks_and_subfolders_are_never_touched() {
        let temp = tempfile::tempdir().unwrap();
        let bin = cask_bin(temp.path(), "codex");
        let outside = temp.path().join("outside");
        fs::write(&outside, b"x").unwrap();
        std::os::unix::fs::symlink(&outside, bin.join("link")).unwrap();
        fs::create_dir(bin.join("nested")).unwrap();
        fs::write(bin.join("nested").join("inner"), b"x").unwrap();

        let seen = RefCell::new(Vec::new());
        let outcome = release_in(
            &bin,
            "2DC432GLL2",
            |path| {
                seen.borrow_mut().push(path.to_path_buf());
                Ok(true)
            },
            |_, _| Ok(()),
            |_| Ok(()),
        );
        assert!(seen.into_inner().is_empty());
        assert_eq!(outcome, ReleaseOutcome::default());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn c18_3_an_unsigned_quarantined_file_keeps_its_attribute() {
        let temp = tempfile::tempdir().unwrap();
        let bin = cask_bin(temp.path(), "codex");
        let file = bin.join("codex");
        fs::write(&file, b"#!/bin/sh\n").unwrap();
        let c_path = std::ffi::CString::new(file.to_str().unwrap()).unwrap();
        let name = std::ffi::CString::new("com.apple.quarantine").unwrap();
        let value = b"0381;00000000;;";
        // SAFETY: 포인터는 호출 동안 유효하고 값 길이를 함께 넘긴다.
        let set = unsafe {
            libc::setxattr(
                c_path.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert_eq!(set, 0);
        assert_eq!(platform::has_quarantine(&file), Ok(true));

        let outcome = release_in(
            &bin,
            "2DC432GLL2",
            platform::has_quarantine,
            platform::signed_by_team,
            platform::remove_quarantine,
        );
        assert!(outcome.released.is_empty());
        assert_eq!(outcome.refused.len(), 1);
        assert_eq!(platform::has_quarantine(&file), Ok(true));

        platform::remove_quarantine(&file).unwrap();
        assert_eq!(platform::has_quarantine(&file), Ok(false));
    }
}
