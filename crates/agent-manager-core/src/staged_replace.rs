//! 스테이징 → 백업 → 원자 교체 → 롤백 순서를 한 곳에 모은 원시 연산.
//!
//! C3(스킬 라이브러리)·C5(프로젝트 정책)이 요구하는 "원자적 staged replace"가 게시·저장·
//! 변형 생성·채택·저장소 마이그레이션 경로마다 손으로 복사돼 있었다. 순서가 한 군데라도
//! 어긋나면 교체 실패 뒤 대상이 사라진 상태로 남으므로, 순서 자체는 이 모듈 한 곳에만 둔다.

use std::fs;
use std::path::Path;

use crate::domain::wire_enum;
use crate::CoreError;

/// 스테이징 결과물이 파일인지 디렉터리인지. 교체가 실패했을 때 스테이징을 어떻게
/// 걷어내는지가 갈린다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum StagedKind {
    #[default]
    File,
    Directory,
}

impl StagedKind {
    #[cfg(test)]
    pub const ALL: [Self; 2] = [Self::File, Self::Directory];

    /// 남은 스테이징을 걷어낸다. 정리 실패는 교체 결과를 바꾸지 않으므로 무시한다.
    fn discard(self, path: &Path) {
        match self {
            Self::File => {
                let _ = fs::remove_file(path);
            }
            Self::Directory => {
                let _ = fs::remove_dir_all(path);
            }
        }
    }
}

wire_enum!(display_only StagedKind, {
    File => "file",
    Directory => "directory",
});

/// 준비가 끝난 스테이징을 대상 자리로 밀어 넣는 한 번의 교체.
pub(crate) struct StagedReplace<'a> {
    pub kind: StagedKind,
    pub stage: &'a Path,
    pub target: &'a Path,
    /// `Some`이면 기존 대상을 이 경로로 옮겨 둔 뒤 교체하고, 교체가 실패하면 되돌린다.
    /// `None`은 대상이 비어 있다고 보고 그대로 밀어 넣는 경로(새 항목 생성, 또는 이전
    /// 대상을 이미 휴지통으로 옮긴 뒤)다.
    pub backup: Option<&'a Path>,
}

impl StagedReplace<'_> {
    /// 성공하면 대상은 스테이징 내용이고 스테이징 경로는 사라진다. 실패하면 대상은
    /// 교체 전 내용 그대로이고 스테이징도 남기지 않는다.
    ///
    /// `backup`이 `Some`이었고 성공한 경우 이전 내용은 백업 경로에 남는다. 걷어내는
    /// 방식(휴지통 이동·즉시 삭제·링크 처리)이 호출부마다 다르므로 백업 정리는
    /// 호출부 몫으로 남긴다.
    pub(crate) fn commit(self) -> Result<(), CoreError> {
        if let Some(backup) = self.backup {
            if let Err(error) = fs::rename(self.target, backup) {
                self.kind.discard(self.stage);
                return Err(CoreError::Io(error));
            }
        }
        if let Err(error) = fs::rename(self.stage, self.target) {
            if let Some(backup) = self.backup {
                let _ = fs::rename(backup, self.target);
            }
            self.kind.discard(self.stage);
            return Err(CoreError::Io(error));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_moves_the_previous_target_to_the_backup_path() {
        let root = tempfile::tempdir().expect("temporary directory");
        let target = root.path().join("doc.md");
        let stage = root.path().join(".stage");
        let backup = root.path().join(".backup");
        fs::write(&target, b"old").expect("target");
        fs::write(&stage, b"new").expect("stage");

        StagedReplace {
            kind: StagedKind::File,
            stage: &stage,
            target: &target,
            backup: Some(&backup),
        }
        .commit()
        .expect("commit");

        assert_eq!(fs::read(&target).expect("target"), b"new");
        assert_eq!(fs::read(&backup).expect("backup"), b"old");
        assert!(!stage.exists());
    }

    #[test]
    fn a_failed_swap_restores_the_target_and_leaves_no_stage() {
        let root = tempfile::tempdir().expect("temporary directory");
        let target = root.path().join("doc.md");
        let stage = root.path().join("missing-stage");
        let backup = root.path().join(".backup");
        fs::write(&target, b"old").expect("target");

        let error = StagedReplace {
            kind: StagedKind::File,
            stage: &stage,
            target: &target,
            backup: Some(&backup),
        }
        .commit()
        .expect_err("the stage does not exist");

        assert!(matches!(error, CoreError::Io(_)));
        assert_eq!(fs::read(&target).expect("target"), b"old");
        assert!(!backup.exists());
        assert!(!stage.exists());
    }

    #[test]
    fn a_backupless_commit_fills_an_empty_target() {
        let root = tempfile::tempdir().expect("temporary directory");
        let target = root.path().join("skill");
        let stage = root.path().join(".stage");
        fs::create_dir(&stage).expect("stage");
        fs::write(stage.join("SKILL.md"), b"body").expect("staged file");

        StagedReplace {
            kind: StagedKind::Directory,
            stage: &stage,
            target: &target,
            backup: None,
        }
        .commit()
        .expect("commit");

        assert_eq!(
            fs::read(target.join("SKILL.md")).expect("published file"),
            b"body"
        );
        assert!(!stage.exists());
    }

    #[test]
    fn staged_kind_constants_and_display() {
        assert_eq!(StagedKind::ALL, [StagedKind::File, StagedKind::Directory]);
        assert_eq!(StagedKind::default(), StagedKind::File);
        for kind in StagedKind::ALL {
            assert_eq!(kind.to_string(), kind.as_str());
        }
    }
}
