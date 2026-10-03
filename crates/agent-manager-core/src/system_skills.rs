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

use crate::app_data_file::{read_private_json, write_private_json};
use crate::domain::wire_enum;
use crate::resource_repository::repository_skills_root;
use crate::{CoreError, ProviderId};

/// 시스템 스킬 한 개. 본문은 바이너리에 함께 들어가고, 설명하는 서브커맨드와 같은
/// 버전으로 묶인다.
struct SystemSkill {
    key: &'static str,
    skill_md: &'static str,
    /// SKILL.md 옆에 함께 깔리는 참고 파일. 절차형 스킬은 본문을 짧게 두고 표와 해석을
    /// `references/`로 내리므로, 본문만 설치하면 스킬이 없는 파일을 가리킨다.
    extras: &'static [SystemSkillFile],
}

/// 참고 파일 한 개. 경로는 스킬 디렉터리 기준 상대 경로다.
struct SystemSkillFile {
    path: &'static str,
    content: &'static str,
}

const SYSTEM_SKILLS: &[SystemSkill] = &[
    SystemSkill {
        key: "session-context",
        skill_md: include_str!("../skills/session-context/SKILL.md"),
        extras: &[],
    },
    SystemSkill {
        key: "ssh-endpoints",
        skill_md: include_str!("../skills/ssh-endpoints/SKILL.md"),
        extras: &[],
    },
    SystemSkill {
        key: "db-connections",
        skill_md: include_str!("../skills/db-connections/SKILL.md"),
        extras: &[],
    },
    SystemSkill {
        key: "chat-secrets",
        skill_md: include_str!("../skills/chat-secrets/SKILL.md"),
        extras: &[],
    },
    SystemSkill {
        key: "cypress-automation",
        skill_md: include_str!("../skills/cypress-automation/SKILL.md"),
        extras: &[],
    },
    // 서브커맨드가 아니라 절차를 담은 첫 시스템 스킬. 회차 목표 패널의 "설계 시작"이
    // `src/lib/roundDesign.ts`에서 이 키를 이름으로 지목하므로, 카드나 워크플로보다 먼저
    // 공통 저장소에 있어야 한다. 온보딩 절차본(aia_onboarding.rs의 BUNDLED_SKILLS)은
    // 카드가 워크플로를 만들 때 비로소 복사되므로 그 자리에 둘 수 없다.
    SystemSkill {
        key: "round-designer",
        skill_md: include_str!("../skills/round-designer/SKILL.md"),
        extras: &[],
    },
    // round-designer 가 설계 전에 따르는 문진. 번들에서 빠지면 설치 직후의 round-designer 가
    // 없는 스킬을 가리키고, 설계는 병렬 건수·품질 관문·반영 정책을 묻지 않은 채 시작한다.
    SystemSkill {
        key: "round-intake",
        skill_md: include_str!("../skills/round-intake/SKILL.md"),
        extras: &[
            SystemSkillFile {
                path: "references/questions.md",
                content: include_str!("../skills/round-intake/references/questions.md"),
            },
            SystemSkillFile {
                path: "references/capacity.md",
                content: include_str!("../skills/round-intake/references/capacity.md"),
            },
        ],
    },
];

/// 앱이 이 사본을 소유한다는 표시. 사용자가 손댄 사본과 구분해 덮어쓸지를 정한다.
const OWNERSHIP_FILE: &str = ".agent-manager-system-skill";

/// 참고 파일까지 포함한 번들 전체의 해시를 적어 두는 자리. 소유 표시(SKILL.md 해시)와
/// 따로 두는 이유는 둘이 답하는 질문이 다르기 때문이다 — 소유 표시는 "사용자가 본문을
/// 고쳤는가"를, 이 값은 "앱이 들고 온 번들이 바뀌었는가"를 가린다. 한 값으로 합치면
/// 참고 파일이 바뀐 판에서 모든 사본이 사용자 편집으로 오판된다.
const BUNDLE_FILE: &str = ".agent-manager-system-skill-bundle";

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

/// SKILL.md와 참고 파일 전체를 한 값으로 묶는다. 경로도 함께 넣어, 내용이 같은 파일의
/// 이름만 바뀐 판도 갱신으로 잡힌다.
fn bundle_digest(skill: &SystemSkill) -> String {
    let mut hasher = Sha256::new();
    hasher.update(skill.skill_md.as_bytes());
    for extra in skill.extras {
        hasher.update(extra.path.as_bytes());
        hasher.update(extra.content.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

/// 공급자 설치본에 새로 깔리거나 갱신된 스킬 한 줄. 사용자에게 "무엇이 더 깔렸는지"를
/// 보여 주려고 남긴다 — 설치는 조용히 되지만, 공급자 전역 스킬 루트에 파일이 생기는 일이라
/// 모르고 지나가지는 않아야 한다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillNoticeEntry {
    pub provider: ProviderId,
    pub key: String,
    pub outcome: SystemSkillOutcome,
}

/// 아직 사용자가 확인하지 않은 설치 안내. 확인하면 지운다.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemSkillNotice {
    pub recorded_at: i64,
    pub entries: Vec<SystemSkillNoticeEntry>,
}

const NOTICE_FILE: &str = "system-skill-notice-v1.json";

fn notice_path(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join(NOTICE_FILE)
}

/// 확인 대기 중인 안내. 없으면 `None`.
pub fn get_system_skill_notice(
    app_data_dir: &Path,
) -> Result<Option<SystemSkillNotice>, CoreError> {
    let notice = read_private_json::<SystemSkillNotice>(&notice_path(app_data_dir))?
        .filter(|notice| !notice.entries.is_empty());
    Ok(notice)
}

/// 사용자가 확인했다. 다음 기동에서 다시 뜨지 않게 지운다.
pub fn acknowledge_system_skill_notice(app_data_dir: &Path) -> Result<(), CoreError> {
    let path = notice_path(app_data_dir);
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// 이번 기동에서 바뀐 것만 남긴다. 아무것도 바뀌지 않았으면 지난 안내를 덮어쓰지 않는다 —
/// 사용자가 아직 못 본 안내를 조용히 지우게 되기 때문이다.
fn record_notice(app_data_dir: &Path, entries: Vec<SystemSkillNoticeEntry>) {
    if entries.is_empty() {
        return;
    }
    let notice = SystemSkillNotice {
        recorded_at: crate::clock::now_ms(),
        entries,
    };
    if let Err(error) = write_private_json(&notice_path(app_data_dir), &notice) {
        eprintln!("시스템 스킬 설치 안내를 남기지 못했습니다: {error}");
    }
}

/// 백엔드가 시작할 때 한 번 부른다. 실패해도 앱 기동을 막지 않도록 호출부가 경고만 남긴다.
pub fn ensure_system_skills(app_data_dir: &Path) -> Result<Vec<SystemSkillStatus>, CoreError> {
    let (statuses, changed) = ensure_system_skills_into(
        &repository_skills_root(app_data_dir),
        &crate::user_home::optional_home_dir()
            .map(|home| crate::skill_library::existing_personal_skill_roots(&home))
            .unwrap_or_default(),
    )?;
    record_notice(app_data_dir, changed);
    Ok(statuses)
}

/// 깔 자리를 인자로 받는 본체. 시험이 진짜 공급자 홈에 쓰지 않도록 갈라 둔다 — 설치
/// 대상을 함수가 스스로 정하면 시험이 그 결정을 피할 길이 없다.
fn ensure_system_skills_into(
    repository_root: &Path,
    provider_roots: &[(ProviderId, std::path::PathBuf)],
) -> Result<(Vec<SystemSkillStatus>, Vec<SystemSkillNoticeEntry>), CoreError> {
    let root = repository_root;
    let mut changed: Vec<SystemSkillNoticeEntry> = Vec::new();
    // 공통 저장소는 원본 자리다. 공급자 설치본까지 깔지 않으면 일반 채팅은 이 스킬들이
    // 있다는 것조차 모른다 — SSH·DB·비밀값·세션조회는 MCP 가 아니라 이 스킬들이 안내하는
    // 백엔드 CLI 로 닿는 길이라, 설치본이 없으면 "그런 도구는 없다"가 된다. 실제로 다섯 개
    // 전부 공통 저장소에만 있고 세 공급자 어디에도 깔려 있지 않았다(2026-10-03 실측).
    let statuses = SYSTEM_SKILLS
        .iter()
        .map(|skill| {
            let outcome = ensure_one(&root.join(skill.key), skill)?;
            // 설치본은 원본을 따라가되 사용자가 고친 사본은 그대로 둔다(`inspect_copy_action`).
            // 한 공급자에서 실패해도 나머지는 깐다 — 하나 때문에 전부 없는 쪽이 더 나쁘다.
            for (provider, provider_root) in provider_roots {
                match ensure_one(&provider_root.join(skill.key), skill) {
                    // 바뀐 것만 안내에 싣는다. 그대로이거나 사용자가 고친 사본은 알릴 것이 없다.
                    Ok(outcome @ (SystemSkillOutcome::Installed | SystemSkillOutcome::Updated)) => {
                        changed.push(SystemSkillNoticeEntry {
                            provider: *provider,
                            key: skill.key.to_owned(),
                            outcome,
                        });
                    }
                    Ok(_) => {}
                    Err(error) => eprintln!(
                        "시스템 스킬 {}을(를) {provider} 설치본에 깔지 못했습니다: {error}",
                        skill.key
                    ),
                }
            }
            Ok(SystemSkillStatus {
                key: skill.key.to_owned(),
                outcome,
            })
        })
        .collect::<Result<Vec<_>, CoreError>>()?;
    Ok((statuses, changed))
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
fn inspect_copy_action(dir: &Path, expected_digest: &str, expected_bundle: &str) -> CopyAction {
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
    // 참고 파일만 바뀐 판도 갱신해야 한다. 번들 표시가 없는 사본은 참고 파일을 깔지 않던
    // 옛 판이 설치한 것이므로 한 번 다시 쓴다.
    let bundle = fs::read_to_string(dir.join(BUNDLE_FILE)).unwrap_or_default();
    if recorded.trim() == expected_digest && bundle.trim() == expected_bundle {
        return CopyAction::Keep(SystemSkillOutcome::UpToDate);
    }
    CopyAction::Update
}

fn ensure_one(dir: &Path, skill: &SystemSkill) -> Result<SystemSkillOutcome, CoreError> {
    let expected = digest(skill.skill_md);
    let bundle = bundle_digest(skill);
    inspect_copy_action(dir, &expected, &bundle).apply(dir, skill, &expected)
}

fn write_skill(dir: &Path, skill: &SystemSkill, expected: &str) -> Result<(), CoreError> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join("SKILL.md"), skill.skill_md)?;
    for extra in skill.extras {
        let path = dir.join(extra.path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, extra.content)?;
    }
    fs::write(dir.join(OWNERSHIP_FILE), expected)?;
    fs::write(dir.join(BUNDLE_FILE), bundle_digest(skill))?;
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

    /// 회차 목표 패널이 이 키를 이름으로 지목한다(`src/lib/roundDesign.ts`). 번들에서 빠지면
    /// "설계 시작"이 없는 스킬을 가리키고, 에이전트는 절차 없이 설계를 시작한다.
    #[test]
    fn bundled_round_designer_skill_points_at_the_round_goal_catalog() {
        let skill = SYSTEM_SKILLS
            .iter()
            .find(|skill| skill.key == "round-designer")
            .expect("round-designer 가 번들 목록에 없습니다");
        let body = skill.skill_md;
        assert!(body.starts_with("---\n"));
        assert!(body.contains("\nname: round-designer\n"));
        assert!(body.contains("\ndescription: "));
        // 스킬이 안내하는 작업은 실제 카탈로그 이름과 같아야 한다.
        for operation in [
            "get_round_goals",
            "record_round_report",
            "list_round_reports",
            "update_round_goal",
        ] {
            assert!(body.contains(operation), "{operation} 안내가 없습니다");
        }
    }

    /// 문진 스킬은 질문표와 용량 해석을 `references/`에 두고 본문이 그 경로를 가리킨다.
    /// 본문만 깔리면 설치 직후의 스킬이 없는 파일을 가리킨다.
    #[test]
    fn bundled_round_intake_skill_carries_its_reference_files() {
        let skill = SYSTEM_SKILLS
            .iter()
            .find(|skill| skill.key == "round-intake")
            .expect("round-intake 가 번들 목록에 없습니다");
        let mut paths = skill
            .extras
            .iter()
            .map(|extra| extra.path)
            .collect::<Vec<_>>();
        paths.sort_unstable();
        assert_eq!(paths, ["references/capacity.md", "references/questions.md"]);
        // 본문이 가리키는 경로와 실제로 들고 가는 경로가 같아야 한다.
        for path in paths {
            assert!(skill.skill_md.contains(path), "{path} 안내가 없습니다");
        }

        let temporary = tempfile::tempdir().expect("tempdir");
        let dir = temporary.path().join("round-intake");
        ensure_one(&dir, skill).expect("install");
        assert!(dir.join("references/questions.md").exists());
        assert!(dir.join("references/capacity.md").exists());
    }

    /// 설계 진입점이 문진을 이름으로 지목한다. 둘 중 하나만 번들에 있으면 설치 직후의
    /// 설계가 없는 스킬을 따라간다.
    #[test]
    fn bundled_round_designer_points_at_the_bundled_intake_skill() {
        let designer = SYSTEM_SKILLS
            .iter()
            .find(|skill| skill.key == "round-designer")
            .expect("round-designer 가 번들 목록에 없습니다");
        assert!(designer.skill_md.contains("round-intake"));
        assert!(SYSTEM_SKILLS
            .iter()
            .any(|skill| skill.key == "round-intake"));
    }

    /// 참고 파일만 바뀐 판에서도 기존 사본이 갱신돼야 한다. 소유 표시는 SKILL.md 해시라
    /// 본문이 그대로면 움직이지 않으므로, 번들 표시가 그 차이를 든다.
    #[test]
    fn refreshes_copy_when_only_a_reference_file_changes() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let dir = temporary.path().join("round-intake");
        let before = SystemSkill {
            key: "round-intake",
            skill_md: "---
name: round-intake
---
본문
",
            extras: &[SystemSkillFile {
                path: "references/questions.md",
                content: "옛 질문표
",
            }],
        };
        ensure_one(&dir, &before).expect("install");
        let after = SystemSkill {
            extras: &[SystemSkillFile {
                path: "references/questions.md",
                content: "새 질문표
",
            }],
            ..before
        };
        assert_eq!(
            ensure_one(&dir, &after).expect("update"),
            SystemSkillOutcome::Updated
        );
        assert_eq!(
            fs::read_to_string(dir.join("references/questions.md")).expect("read"),
            "새 질문표
"
        );
    }

    /// 공통 저장소에만 깔면 일반 채팅은 이 스킬들이 있다는 것조차 모른다. SSH·DB·비밀값은
    /// MCP 가 아니라 이 스킬들이 안내하는 백엔드 CLI 로 닿는 길이라, 설치본이 없으면
    /// 에이전트에게는 "그런 도구가 없다"가 된다 — 실제로 다섯 개 전부 공통 저장소에만 있고
    /// 세 공급자 어디에도 없었다(2026-10-03 실측).
    #[test]
    fn ensure_reaches_provider_installs_not_only_the_repository() {
        let temporary = tempfile::tempdir().expect("tempdir");
        let repository = temporary.path().join("repository");
        let claude = temporary.path().join("claude-home/skills");
        let codex = temporary.path().join("codex-home/skills");
        let roots = vec![
            (crate::ProviderId::Claude, claude.clone()),
            (crate::ProviderId::Codex, codex.clone()),
        ];
        let (statuses, changed) = ensure_system_skills_into(&repository, &roots).expect("ensure");
        assert_eq!(statuses.len(), SYSTEM_SKILLS.len());
        // 처음 깔렸으니 공급자 둘 × 스킬 전부가 안내에 실린다 — 사용자는 공급자 전역 스킬
        // 루트에 무엇이 생겼는지 알아야 한다.
        assert_eq!(changed.len(), SYSTEM_SKILLS.len() * roots.len());
        assert!(changed
            .iter()
            .all(|entry| entry.outcome == SystemSkillOutcome::Installed));

        // 두 번째 기동은 바뀐 것이 없으므로 안내도 비어 있다.
        let (_, again) = ensure_system_skills_into(&repository, &roots).expect("second");
        assert!(again.is_empty(), "{again:?}");

        for skill in SYSTEM_SKILLS {
            assert!(
                repository.join(skill.key).join("SKILL.md").exists(),
                "{} 가 공통 저장소에 없다",
                skill.key
            );
            for root in [&claude, &codex] {
                assert!(
                    root.join(skill.key).join("SKILL.md").exists(),
                    "{} 가 {} 에 깔리지 않았다",
                    skill.key,
                    root.display()
                );
            }
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
        let bundle = digest("bundle-v1");

        // 파일 부재 시 Install
        assert_eq!(
            inspect_copy_action(dir, &expected, &bundle),
            CopyAction::Install
        );

        // 소유권 표시 파일 부재 시 UserModified
        fs::write(dir.join("SKILL.md"), "content-v1").expect("write");
        assert_eq!(
            inspect_copy_action(dir, &expected, &bundle),
            CopyAction::Keep(SystemSkillOutcome::UserModified)
        );

        // 소유권 파일과 실제 내용 불일치 시 UserModified
        fs::write(dir.join(OWNERSHIP_FILE), digest("content-old")).expect("write");
        assert_eq!(
            inspect_copy_action(dir, &expected, &bundle),
            CopyAction::Keep(SystemSkillOutcome::UserModified)
        );

        // 본문은 그대로지만 번들 표시가 없으면 참고 파일을 깔지 않던 옛 사본이라 Update
        fs::write(dir.join(OWNERSHIP_FILE), &expected).expect("write");
        assert_eq!(
            inspect_copy_action(dir, &expected, &bundle),
            CopyAction::Update
        );

        // 소유권 파일과 실제 내용 일치하며 expected·번들이 모두 같으면 UpToDate
        fs::write(dir.join(BUNDLE_FILE), &bundle).expect("write");
        assert_eq!(
            inspect_copy_action(dir, &expected, &bundle),
            CopyAction::Keep(SystemSkillOutcome::UpToDate)
        );

        // 본문이 같아도 번들만 바뀌면 Update
        assert_eq!(
            inspect_copy_action(dir, &expected, &digest("bundle-v2")),
            CopyAction::Update
        );

        // 소유권 파일과 실제 내용 일치하지만 expected와 다르면 Update
        let expected_v2 = digest("content-v2");
        assert_eq!(
            inspect_copy_action(dir, &expected_v2, &bundle),
            CopyAction::Update
        );
    }
}
