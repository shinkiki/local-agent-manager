//! Agent Manager가 소유하는 시스템 스킬.
//!
//! # 왜 스킬인가
//!
//! MCP 도구는 목록이 CLI 프로세스 시작에 고정되고, 붙이는 순간 그 대화가 도구 정의 토큰을
//! 상시 지불한다. 조회 경로를 실행 파일로 내리고 스킬로 안내하면 상주 비용이 스킬 설명
//! 한 줄로 줄고, 공급자 CLI의 MCP 지원 여부와 무관해진다.
//!
//! # 경계
//!
//! 스킬 본문은 바이너리에 함께 들어간다(`include_str!`). 스킬이 설명하는 서브커맨드 계약과
//! 같은 바이너리에 묶여 있어야 버전이 어긋나지 않는다. 사용자 공통 스킬 저장소에 설치하되
//! 내용 해시가 같으면 다시 쓰지 않고, 사용자가 고친 사본은 덮어쓰지 않는다.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::app_data_file::write_private_json;
use crate::resource_repository::repository_skills_root;
use crate::CoreError;

/// 시스템 스킬 한 개. 본문은 바이너리에 함께 들어가고, 설명하는 서브커맨드와 같은
/// 버전으로 묶인다.
struct SystemSkill {
    key: &'static str,
    skill_md: &'static str,
}

const SYSTEM_SKILLS: &[SystemSkill] = &[
    SystemSkill {
        key: "session-context",
        skill_md: include_str!("../skills/session-context/SKILL.md"),
    },
    SystemSkill {
        key: "ssh-endpoints",
        skill_md: include_str!("../skills/ssh-endpoints/SKILL.md"),
    },
];

/// 앱이 이 사본을 소유한다는 표시. 사용자가 손댄 사본과 구분해 덮어쓸지를 정한다.
const OWNERSHIP_FILE: &str = ".agent-manager-system-skill";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemSkillOutcome {
    /// 새로 설치했다.
    Installed,
    /// 내용이 같아 그대로 두었다.
    UpToDate,
    /// 앱 사본을 최신 내용으로 갱신했다.
    Updated,
    /// 사용자가 고친 사본이라 손대지 않았다.
    UserModified,
}

impl SystemSkillOutcome {
    #[cfg(test)]
    pub const ALL: [Self; 4] = [
        Self::Installed,
        Self::UpToDate,
        Self::Updated,
        Self::UserModified,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::UpToDate => "upToDate",
            Self::Updated => "updated",
            Self::UserModified => "userModified",
        }
    }
}

impl std::fmt::Display for SystemSkillOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for SystemSkillOutcome {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim() {
            "installed" => Ok(Self::Installed),
            "upToDate" => Ok(Self::UpToDate),
            "updated" => Ok(Self::Updated),
            "userModified" => Ok(Self::UserModified),
            _ => Err(CoreError::InvalidInput(format!(
                "알 수 없는 시스템 스킬 동기화 결과입니다: {s}. installed|upToDate|updated|userModified 중 하나를 쓰세요"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillStatus {
    pub key: String,
    pub outcome: SystemSkillOutcome,
}

fn digest(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 백엔드가 시작할 때 한 번 부른다. 실패해도 앱 기동을 막지 않도록 호출부가 경고만 남긴다.
pub fn ensure_system_skills(app_data_dir: &Path) -> Result<Vec<SystemSkillStatus>, CoreError> {
    let root = repository_skills_root(app_data_dir);
    SYSTEM_SKILLS
        .iter()
        .map(|skill| {
            let outcome = ensure_one(&root.join(skill.key), skill)?;
            Ok(SystemSkillStatus {
                key: skill.key.to_owned(),
                outcome,
            })
        })
        .collect()
}

fn ensure_one(dir: &PathBuf, skill: &SystemSkill) -> Result<SystemSkillOutcome, CoreError> {
    let skill_md = dir.join("SKILL.md");
    let ownership = dir.join(OWNERSHIP_FILE);
    let expected = digest(skill.skill_md);
    if skill_md.exists() {
        // 소유 표시가 없으면 사용자나 다른 도구가 만든 사본이다. 건드리지 않는다.
        if !ownership.exists() {
            return Ok(SystemSkillOutcome::UserModified);
        }
        let recorded = fs::read_to_string(&ownership).unwrap_or_default();
        let current = fs::read_to_string(&skill_md).unwrap_or_default();
        // 앱이 설치한 뒤 사용자가 본문을 고쳤다면 그 편집을 살린다.
        if recorded.trim() != digest(&current) {
            return Ok(SystemSkillOutcome::UserModified);
        }
        if recorded.trim() == expected {
            return Ok(SystemSkillOutcome::UpToDate);
        }
        write_skill(dir, skill, &expected)?;
        return Ok(SystemSkillOutcome::Updated);
    }
    write_skill(dir, skill, &expected)?;
    Ok(SystemSkillOutcome::Installed)
}

fn write_skill(dir: &PathBuf, skill: &SystemSkill, expected: &str) -> Result<(), CoreError> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join("SKILL.md"), skill.skill_md)?;
    fs::write(dir.join(OWNERSHIP_FILE), expected)?;
    Ok(())
}

/// 스킬이 읽는 실행 파일 호출 규약. 백엔드가 시작할 때 자기 경로를 남겨, 스킬이 앱 설치
/// 위치를 추측하지 않게 한다.
///
/// `executable`만으로는 부족하다. 데스크톱 앱은 자기 바이너리를 `--backend`로 다시 띄워
/// 백엔드를 돌리므로, 그때 `current_exe`는 Tauri 바이너리이고 `sessions`를 바로 받지 않는다.
/// 그래서 앞에 붙일 인자까지 함께 남긴다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionReadCliPointer {
    schema_version: u32,
    executable: String,
    argv_prefix: Vec<String>,
    version: String,
}

pub const SESSION_READ_CLI_POINTER_FILE: &str = "session-read-cli-v1.json";

/// 지금 프로세스가 `--backend`로 위임받아 돌고 있으면 스킬도 같은 접두사를 써야 한다.
fn session_read_cli_argv_prefix(args: &[String]) -> Vec<String> {
    if args.first().map(String::as_str) == Some("--backend") {
        vec!["--backend".to_owned()]
    } else {
        Vec::new()
    }
}

pub fn record_session_read_cli_path(app_data_dir: &Path) -> Result<(), CoreError> {
    let executable = std::env::current_exe()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pointer = SessionReadCliPointer {
        schema_version: 1,
        executable: executable.to_string_lossy().into_owned(),
        argv_prefix: session_read_cli_argv_prefix(&args),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    write_private_json(&app_data_dir.join(SESSION_READ_CLI_POINTER_FILE), &pointer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn skill() -> &'static SystemSkill {
        &SYSTEM_SKILLS[0]
    }

    fn ssh_skill() -> &'static SystemSkill {
        &SYSTEM_SKILLS[1]
    }

    #[test]
    fn installs_then_reports_up_to_date() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let dir = temporary.path().join("session-context");
        assert_eq!(
            ensure_one(&dir, skill()).expect("install"),
            SystemSkillOutcome::Installed
        );
        assert!(dir.join("SKILL.md").exists());
        assert_eq!(
            ensure_one(&dir, skill()).expect("second"),
            SystemSkillOutcome::UpToDate
        );
    }

    #[test]
    fn refreshes_app_owned_copy_when_bundled_content_changes() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let dir = temporary.path().join("session-context");
        ensure_one(&dir, skill()).expect("install");
        // 예전 버전이 설치해 둔 사본을 흉내낸다. 본문과 기록된 해시가 서로 맞아야
        // 사용자 편집이 아니라 구버전으로 판정된다.
        let stale = "---\nname: session-context\ndescription: 구버전\n---\n";
        fs::write(dir.join("SKILL.md"), stale).expect("write");
        fs::write(dir.join(OWNERSHIP_FILE), digest(stale)).expect("write");
        assert_eq!(
            ensure_one(&dir, skill()).expect("update"),
            SystemSkillOutcome::Updated
        );
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).expect("read"),
            skill().skill_md
        );
    }

    #[test]
    fn never_overwrites_a_copy_the_user_edited() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let dir = temporary.path().join("session-context");
        ensure_one(&dir, skill()).expect("install");
        fs::write(dir.join("SKILL.md"), "사용자가 고친 본문").expect("write");
        assert_eq!(
            ensure_one(&dir, skill()).expect("keep"),
            SystemSkillOutcome::UserModified
        );
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).expect("read"),
            "사용자가 고친 본문"
        );
    }

    #[test]
    fn leaves_a_foreign_copy_alone() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let dir = temporary.path().join("session-context");
        fs::create_dir_all(&dir).expect("dir");
        fs::write(dir.join("SKILL.md"), "다른 도구가 만든 사본").expect("write");
        assert_eq!(
            ensure_one(&dir, skill()).expect("keep"),
            SystemSkillOutcome::UserModified
        );
    }

    #[test]
    fn argv_prefix_follows_how_the_backend_was_launched() {
        assert!(session_read_cli_argv_prefix(&[]).is_empty());
        assert!(session_read_cli_argv_prefix(&["--port".to_owned()]).is_empty());
        assert_eq!(
            session_read_cli_argv_prefix(&["--backend".to_owned(), "--port".to_owned()]),
            vec!["--backend".to_owned()]
        );
    }

    /// C9-12. 스킬이 안내하는 호출은 실제 CLI 계약과 같아야 한다.
    #[test]
    fn bundled_ssh_skill_points_at_the_endpoint_listing_contract() {
        let body = ssh_skill().skill_md;
        assert!(body.contains("\nname: ssh-endpoints\n"));
        assert!(body.contains("\ndescription: "));
        assert!(body.contains("ssh list"));
        // 목록이 지정한 키만 쓰게 하는 인자를 스킬이 그대로 안내해야 한다.
        assert!(body.contains("IdentitiesOnly=yes"));
        assert!(body.contains("BatchMode=yes"));
        // C9-13. 명령 정책 필드와 그 판정 방식이 계약과 같은 이름으로 안내돼야 한다.
        for field in [
            "commandPolicyMode",
            "allowedCommands",
            "deniedCommands",
            "denylistOnly",
        ] {
            assert!(body.contains(field), "{field} 안내가 없습니다");
        }
    }

    /// 설치 대상은 목록 전체다. 하나만 설치하고 지나가면 새 스킬이 조용히 빠진다.
    #[test]
    fn every_bundled_skill_has_its_own_key() {
        let mut keys = SYSTEM_SKILLS
            .iter()
            .map(|skill| skill.key)
            .collect::<Vec<_>>();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), SYSTEM_SKILLS.len());
    }

    #[test]
    fn bundled_skill_declares_a_name_and_description() {
        let body = skill().skill_md;
        assert!(body.starts_with("---\n"));
        assert!(body.contains("\nname: session-context\n"));
        assert!(body.contains("\ndescription: "));
        // 스킬이 설명하는 서브커맨드가 실제 계약과 같은 이름이어야 한다.
        for operation in ["statistics", "list", "detail", "linked-file"] {
            assert!(
                body.contains(&format!("sessions {operation}")),
                "{operation} 안내가 없습니다"
            );
        }
    }

    /// SystemSkillOutcome의 문자열 포맷팅, 파싱, 직렬화, 역직렬화를 검증한다.
    #[test]
    fn system_skill_outcome_contract_and_serde() {
        for outcome in SystemSkillOutcome::ALL {
            let s = outcome.as_str();
            assert_eq!(outcome.to_string(), s);
            assert_eq!(s.parse::<SystemSkillOutcome>().expect("parse"), outcome);

            let json = serde_json::to_string(&outcome).expect("serialize");
            assert_eq!(json, format!("\"{s}\""));
            let back: SystemSkillOutcome = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, outcome);
        }

        // 잘못된 문자열 파싱 실패 검증
        assert!("unknown".parse::<SystemSkillOutcome>().is_err());
        assert!("".parse::<SystemSkillOutcome>().is_err());
    }
}
