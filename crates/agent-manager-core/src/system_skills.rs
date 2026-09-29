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
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::app_data_file::write_private_json;
use crate::domain::wire_enum;
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
    SystemSkill {
        key: "db-connections",
        skill_md: include_str!("../skills/db-connections/SKILL.md"),
    },
    SystemSkill {
        key: "chat-secrets",
        skill_md: include_str!("../skills/chat-secrets/SKILL.md"),
    },
    SystemSkill {
        key: "cypress-automation",
        skill_md: include_str!("../skills/cypress-automation/SKILL.md"),
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

wire_enum!(trimmed SystemSkillOutcome, "알 수 없는 시스템 스킬 동기화 결과입니다. installed|upToDate|updated|userModified 중 하나를 쓰세요", {
    Installed => "installed",
    UpToDate => "upToDate",
    Updated => "updated",
    UserModified => "userModified",
});

impl SystemSkillOutcome {
    #[cfg(test)]
    pub const ALL: [Self; 4] = [
        Self::Installed,
        Self::UpToDate,
        Self::Updated,
        Self::UserModified,
    ];
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

/// 기존 스킬 사본의 상태를 점검해 수행할 동작을 정한다.
#[derive(Debug, PartialEq, Eq)]
enum CopyAction {
    /// 새 사본을 설치한다.
    Install,
    /// 기존 사본을 최신 내용으로 갱신한다.
    Update,
    /// 디스크를 변경하지 않고 기존 사본을 유지한다.
    Keep(SystemSkillOutcome),
}

impl CopyAction {
    /// 점검에서 정한 동작을 적용하고 외부에 보고할 결과로 바꾼다.
    fn apply(
        self,
        dir: &Path,
        skill: &SystemSkill,
        expected_digest: &str,
    ) -> Result<SystemSkillOutcome, CoreError> {
        let outcome = match self {
            Self::Keep(outcome) => return Ok(outcome),
            Self::Install => SystemSkillOutcome::Installed,
            Self::Update => SystemSkillOutcome::Updated,
        };
        write_skill(dir, skill, expected_digest)?;
        Ok(outcome)
    }
}

/// 기존 디렉터리의 SKILL.md 및 소유 표시 파일을 점검해 설치·갱신·유지 동작을 결정한다.
fn inspect_copy_action(dir: &Path, expected_digest: &str) -> CopyAction {
    let skill_md = dir.join("SKILL.md");
    let ownership = dir.join(OWNERSHIP_FILE);
    if !skill_md.exists() {
        return CopyAction::Install;
    }
    // 소유 표시가 없으면 사용자나 다른 도구가 만든 사본이다. 건드리지 않는다.
    if !ownership.exists() {
        return CopyAction::Keep(SystemSkillOutcome::UserModified);
    }
    let recorded = fs::read_to_string(&ownership).unwrap_or_default();
    let current = fs::read_to_string(&skill_md).unwrap_or_default();
    // 앱이 설치한 뒤 사용자가 본문을 고쳤다면 그 편집을 살린다.
    if recorded.trim() != digest(&current) {
        return CopyAction::Keep(SystemSkillOutcome::UserModified);
    }
    if recorded.trim() == expected_digest {
        return CopyAction::Keep(SystemSkillOutcome::UpToDate);
    }
    CopyAction::Update
}

fn ensure_one(dir: &Path, skill: &SystemSkill) -> Result<SystemSkillOutcome, CoreError> {
    let expected = digest(skill.skill_md);
    inspect_copy_action(dir, &expected).apply(dir, skill, &expected)
}

fn write_skill(dir: &Path, skill: &SystemSkill, expected: &str) -> Result<(), CoreError> {
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionReadCliPointer {
    pub(crate) schema_version: u32,
    pub(crate) executable: String,
    pub(crate) argv_prefix: Vec<String>,
    pub(crate) version: String,
    /// C9-18. `<CLI> ssh exec`가 실행을 맡길 loopback 백엔드 포트. 예전 백엔드가 남긴
    /// 파일에는 없으므로 읽는 쪽은 없는 경우를 재시작 안내로 처리한다.
    #[serde(default)]
    pub(crate) backend_port: Option<u16>,
}

impl SessionReadCliPointer {
    /// 프로세스에서 읽어 온 값으로 저장 가능한 포인터를 조립한다. 환경 조회와 값 조립을
    /// 갈라 두어 데스크톱의 `--backend` 접두사 계약을 파일 쓰기 없이 검증할 수 있게 한다.
    fn from_process(executable: &Path, args: &[String], backend_port: u16) -> Self {
        Self {
            schema_version: 1,
            executable: executable.to_string_lossy().into_owned(),
            argv_prefix: session_read_cli_argv_prefix(args),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            backend_port: Some(backend_port),
        }
    }
}

pub const SESSION_READ_CLI_POINTER_FILE: &str = "session-read-cli-v1.json";

/// 백엔드 위치 파일의 전체 경로를 반환한다.
pub fn session_read_cli_pointer_path(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join(SESSION_READ_CLI_POINTER_FILE)
}

/// 지금 프로세스가 `--backend`로 위임받아 돌고 있으면 스킬도 같은 접두사를 써야 한다.
fn session_read_cli_argv_prefix(args: &[String]) -> Vec<String> {
    if args.first().map(String::as_str) == Some("--backend") {
        vec!["--backend".to_owned()]
    } else {
        Vec::new()
    }
}

pub fn record_session_read_cli_path(
    app_data_dir: &Path,
    backend_port: u16,
) -> Result<(), CoreError> {
    let executable = std::env::current_exe()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pointer = SessionReadCliPointer::from_process(&executable, &args, backend_port);
    write_private_json(&session_read_cli_pointer_path(app_data_dir), &pointer)
}

/// 스킬 경로의 CLI가 자기를 띄운 백엔드를 찾을 때 읽는다. 파일이 없으면 백엔드가 한 번도
/// 뜨지 않은 것이라, 추측으로 다른 포트를 두드리지 않고 그 사실을 그대로 알린다.
pub(crate) fn read_session_read_cli_pointer(
    app_data_dir: &Path,
) -> Result<SessionReadCliPointer, CoreError> {
    let path = session_read_cli_pointer_path(app_data_dir);
    let raw = fs::read_to_string(&path).map_err(|error| {
        CoreError::Conflict(format!(
            "Agent Manager 백엔드 위치 파일({})을 읽지 못했습니다. 앱을 먼저 실행하세요: {error}",
            path.to_string_lossy()
        ))
    })?;
    serde_json::from_str(&raw).map_err(|error| {
        CoreError::Conflict(format!(
            "Agent Manager 백엔드 위치 파일을 해석하지 못했습니다: {error}"
        ))
    })
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
    fn pointer_fields_follow_how_the_backend_was_launched() {
        let executable = Path::new("/Applications/Agent Manager");
        let direct = SessionReadCliPointer::from_process(executable, &["--port".to_owned()], 4178);
        assert_eq!(direct.schema_version, 1);
        assert_eq!(direct.executable, "/Applications/Agent Manager");
        assert!(direct.argv_prefix.is_empty());
        assert_eq!(direct.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(direct.backend_port, Some(4178));

        let delegated = SessionReadCliPointer::from_process(
            executable,
            &["--backend".to_owned(), "--port".to_owned()],
            55002,
        );
        assert_eq!(delegated.argv_prefix, ["--backend"]);
        assert_eq!(delegated.backend_port, Some(55002));
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

    /// 백엔드 위치 파일 경로 결합을 검증한다.
    #[test]
    fn session_read_cli_pointer_path_joins_correct_filename() {
        let dir = Path::new("/tmp/test-app-data");
        assert_eq!(
            session_read_cli_pointer_path(dir),
            dir.join("session-read-cli-v1.json")
        );
    }

    /// 사본 상태 점검의 동작 분기를 검증한다.
    #[test]
    fn inspect_copy_action_classifies_each_state() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let dir = temporary.path();
        let expected = digest("content-v1");

        // 파일 부재 시 Install
        assert_eq!(inspect_copy_action(dir, &expected), CopyAction::Install);

        // 소유권 표시 파일 부재 시 UserModified
        fs::write(dir.join("SKILL.md"), "content-v1").expect("write");
        assert_eq!(
            inspect_copy_action(dir, &expected),
            CopyAction::Keep(SystemSkillOutcome::UserModified)
        );

        // 소유권 파일과 실제 내용 불일치 시 UserModified
        fs::write(dir.join(OWNERSHIP_FILE), digest("content-old")).expect("write");
        assert_eq!(
            inspect_copy_action(dir, &expected),
            CopyAction::Keep(SystemSkillOutcome::UserModified)
        );

        // 소유권 파일과 실제 내용 일치하며 expected와 같으면 UpToDate
        fs::write(dir.join(OWNERSHIP_FILE), &expected).expect("write");
        assert_eq!(
            inspect_copy_action(dir, &expected),
            CopyAction::Keep(SystemSkillOutcome::UpToDate)
        );

        // 소유권 파일과 실제 내용 일치하지만 expected와 다르면 Update
        let expected_v2 = digest("content-v2");
        assert_eq!(inspect_copy_action(dir, &expected_v2), CopyAction::Update);
    }
}
