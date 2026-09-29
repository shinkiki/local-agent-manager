//! 선언형 온보딩 카드 팩 로더와 검증기(W6).
//!
//! 애드온 → 자동화 탭의 온보딩 카드는 예전에 화면 코드에 그대로 박혀 있었다. 다른
//! 시스템을 위한 온보딩을 하나 더 만들려면 React 컴포넌트를 또 쓰고 앱을 다시 배포해야
//! 했고, 사용자가 자기 절차에 맞춰 단계를 바꾸는 길은 아예 없었다.
//!
//! 카드를 데이터로 낸다. 앱에 포함된 기본 팩과 사용자가 선택한 공통 스킬 저장소만 읽고,
//! 팩은 **문구·필드 스키마·산출물 인자**만 표현한다(AIA 선제 제안 팩과 같은 경계다).
//! 코드·셸·URL·미등록 작업은 구조적으로 표현할 수 없고, 마지막에 무엇이 만들어지는지는
//! 팩이 아니라 앱이 정한다 — 팩은 워크플로 계약의 단계를 적지 못하고 지시문과 이름만
//! 제공하며, `start_chat` 한 단계짜리 회차 계약의 뼈대는 화면이 붙인다. 그래서 팩을
//! 새로 얻는 것이 새 권한을 얻는 일이 되지 않는다.
//!
//! AIA는 공통 스킬을 쓸 수 있으므로(C3) 팩 파일을 만들고 고치는 것으로 카드를 더하거나
//! 바꾼다. 지우는 것은 그 스킬을 휴지통으로 옮기는 화면 쪽 동작이고, 번들 기본 팩의
//! 카드는 지울 파일이 없어 설정의 끄기 목록(`hiddenOnboardingCards`)으로 감춘다.
//!
//! 제안 팩과 달리 마지막 정상본 캐시는 두지 않는다. 제안은 배경에서 스스로 뜨는 것이라
//! 조용히 사라지면 사용자가 알아채지 못하지만, 온보딩 카드는 사용자가 찾아 들어오는
//! 화면이고 깨진 팩은 `issues`로 그 자리에 사유가 보이기 때문이다.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::resource_repository::repository_skills_root;
use crate::skill_library::validate_skill_key;
use crate::CoreError;

const SCHEMA_VERSION: u32 = 1;
const MANIFEST_RELATIVE: &str = "references/aia-onboarding.json";
const MAX_PACK_BYTES: u64 = 64 * 1024;
const MAX_TOTAL_CARDS: usize = 16;
const MAX_STEPS_PER_CARD: usize = 8;
const MAX_FIELDS_PER_STEP: usize = 12;
const MAX_TEMPLATES_PER_CARD: usize = 4;
const MAX_TEMPLATE_STEPS: usize = 12;
const MAX_ACTIONS_PER_CARD: usize = 4;
const MAX_OPTIONS_PER_FIELD: usize = 16;
const MAX_REQUIRED_SKILLS: usize = 8;
const MAX_SHORT_CHARS: usize = 80;
const MAX_LINE_CHARS: usize = 200;
const MAX_PARAGRAPH_CHARS: usize = 600;
const MAX_MESSAGE_CHARS: usize = 4_000;

const BUNDLED_PACK: &str = include_str!("../assets/aia-onboarding/aia-onboarding.json");

/// 온보딩이 등록한 회차가 따르는 절차. 계약은 값만 싣고 절차는 이 스킬들이 들고 있으므로
/// (W6-9) 절차를 고치는 것이 이미 등록된 워크플로에도 다음 실행부터 반영된다. 팩과 달리
/// 앱이 읽지 않고 무인 런타임이 읽으므로, 카탈로그는 설치 여부와 원문만 낸다.
///
/// 계약의 `requiredSkills`에 적힌 키가 여기 있으면, 화면이 만들기 전에 설치를 함께 받는다.
pub const LANE_SKILL_KEY: &str = "parallel-round-lanes";

struct BundledSkill {
    key: &'static str,
    description: &'static str,
    body: &'static str,
}

const BUNDLED_SKILLS: &[BundledSkill] = &[
    BundledSkill {
        key: LANE_SKILL_KEY,
        description: "같은 저장소에서 여러 무인 회차가 동시에 도는 레인 점유·워크트리·착지 절차",
        body: include_str!("../assets/aia-onboarding/parallel-round-lanes/SKILL.md"),
    },
    BundledSkill {
        key: "qa-round",
        description: "회차당 신규 패턴 몇 건으로 QA를 수행하고 시나리오와 결함 티켓을 관리항목까지 채워 남기는 절차",
        body: include_str!("../assets/aia-onboarding/qa-round/SKILL.md"),
    },
    BundledSkill {
        key: "qa-ticket-round",
        description: "사용자가 상태를 바꿔 둔 QA 오류 티켓을 회차당 한 건 재현·수정·검증하고 상태를 갱신하는 절차",
        body: include_str!("../assets/aia-onboarding/qa-ticket-round/SKILL.md"),
    },
    BundledSkill {
        key: "delivery-round",
        description: "마일스톤을 읽어 한 회차에 항목 하나씩 구현·검증·커밋하고 그 항목 상태를 갱신하는 절차",
        body: include_str!("../assets/aia-onboarding/delivery-round/SKILL.md"),
    },
];

/// 앱이 병렬을 켠 카드에 덧붙이는 입력의 키(W6-8). 팩이 같은 키를 선언하면 같은 이름의
/// 칸이 둘 그려지고 값이 서로 덮는다. `src/lib/aiaOnboardingParallel.ts`의 `PARALLEL_FIELD_KEYS`와
/// 같아야 한다.
const RESERVED_FIELD_KEYS: &[&str] = &[
    "parallelEnabled",
    "parallelRuns",
    "lanePool",
    "laneDevLine",
    "laneLanding",
    "laneSplit",
];

/// 카드가 필드로 선언하지 않았는데도 치환되는 값. **지금은 없다.**
///
/// `workflowId`를 여기 두었었지만 치환하는 쪽이 그 값을 넣지 않아, 검증은 통과하고 실행은
/// 빈 문자열을 내는 자리가 됐다 — 이 목록이 막으려던 실패 그대로다. 회차는 앞서 등록한
/// 워크플로에 **순서로** 붙으므로 이름을 글로 적을 일이 없다. 파생 값을 더하려면 치환하는
/// 쪽(`fillTemplate`)이 그 값을 실제로 공급하는지부터 확인한다.
const DERIVED_TEMPLATE_VARIABLES: &[&str] = &[];

/// 카드 표식으로 쓸 수 있는 아이콘. 화면이 실제 아이콘으로 바꾸므로 목록 밖의 이름은
/// 로드에서 거절한다 — 팩이 화면에 임의의 그림을 들일 수 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiaOnboardingIcon {
    Building2,
    CalendarClock,
    FlaskConical,
    FolderTree,
    GitBranch,
    ListChecks,
    NotebookPen,
    Route,
    Sparkles,
    Target,
    Workflow,
}

/// 입력 한 칸의 종류. 앞 여섯 개는 값을 직접 받는 칸이고, 뒤 네 개는 앱이 이미 아는
/// 목록에서 고르는 칸이다. 팩이 요구할 수 있는 조회를 이 네 가지로 닫아, 임의의 앱
/// 데이터를 화면에 끌어오지 못하게 한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiaOnboardingFieldKind {
    Text,
    Textarea,
    Number,
    Select,
    MultiSelect,
    Toggle,
    /// 등록 프로젝트 목록(활성 프로젝트). 값은 절대경로다.
    ProjectPicker,
    /// 등록 폴더 목록. 값은 등록 폴더 id다.
    DocRootPicker,
    /// 붙어 있는 노션·지라 플러그인에 따라 늘어나는 기록 대상.
    RecordTargetPicker,
    /// 등록된 Cypress 작업공간.
    CypressWorkspacePicker,
    /// 고른 프로젝트의 로컬 브랜치. 현재 체크아웃된 브랜치를 기본으로 채운다 — 저장소를
    /// 열면 알 수 있는 값을 사용자가 외워 적게 하지 않는다.
    BranchPicker,
    /// 고른 Cypress 작업공간의 `cypress.env.json`에 있는 **키 이름**. 값은 가려진 채로
    /// 읽으므로 비밀번호·토큰이 화면에 오지 않는다. 계정 키를 손으로 옮겨 적게 하면
    /// 온보딩이 "적을 수 없는 값"을 묻는 자리가 된다.
    CypressEnvKeyPicker,
}

/// 한국어를 기본으로, 영어가 있으면 함께 싣는 문구. 팩 JSON에는 `"제목"`처럼 문자열
/// 하나로 적어도 되고 `{"ko":"제목","en":"Title"}`로 적어도 된다 — AIA가 한국어로만
/// 쓴 팩과 번들 기본 팩이 같은 타입을 쓰게 하려는 것이다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalizedText {
    pub ko: String,
    pub en: Option<String>,
}

impl<'de> Deserialize<'de> for LocalizedText {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Plain(String),
            Pair {
                ko: String,
                #[serde(default)]
                en: Option<String>,
            },
        }
        Ok(match Raw::deserialize(deserializer)? {
            Raw::Plain(ko) => LocalizedText { ko, en: None },
            Raw::Pair { ko, en } => LocalizedText { ko, en },
        })
    }
}

impl LocalizedText {
    fn parts(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.ko.as_str()).chain(self.en.as_deref())
    }
}

/// 다른 칸의 값에 따라 보일지 말지. 워크플로 계약의 조건식과 같은 표현력(등가 비교)만
/// 둔다 — 화면 조건이 계약 조건보다 셀 이유가 없고, 셀수록 검증할 것이 는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaOnboardingCondition {
    pub field: String,
    pub equals: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaOnboardingOption {
    pub value: String,
    pub label: LocalizedText,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaOnboardingField {
    pub key: String,
    pub label: LocalizedText,
    pub kind: AiaOnboardingFieldKind,
    #[serde(default)]
    pub required: bool,
    /// 두 칸을 차지하는 넓은 입력.
    #[serde(default)]
    pub wide: bool,
    #[serde(default)]
    pub placeholder: Option<LocalizedText>,
    #[serde(default)]
    pub help: Option<LocalizedText>,
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub options: Vec<AiaOnboardingOption>,
    #[serde(default)]
    pub min: Option<i64>,
    #[serde(default)]
    pub max: Option<i64>,
    #[serde(default)]
    pub visible_when: Option<AiaOnboardingCondition>,
    /// 목록에 없는 값을 직접 적을 수 있게 할지. 고르는 칸은 어느 시스템에나 맞는 목록을
    /// 만들 수 없어, 목록에 없는 것을 적을 자리가 없으면 사용자가 온보딩을 끝내지 못한다.
    #[serde(default)]
    pub allow_other: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaOnboardingStep {
    pub id: String,
    pub title: LocalizedText,
    #[serde(default)]
    pub hint: Option<LocalizedText>,
    pub fields: Vec<AiaOnboardingField>,
}

/// 카드가 본뜨는 절차를 보여 주는 참고 상자. 값을 받지 않고 문구만 있다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaOnboardingTemplate {
    pub key: String,
    pub title: LocalizedText,
    #[serde(default)]
    pub meta: Option<LocalizedText>,
    #[serde(default)]
    pub steps: Vec<LocalizedText>,
}

/// 등록할 회차 워크플로. 팩이 적을 수 있는 것은 이름·설명·지시문·따를 스킬뿐이다.
/// 계약의 단계(`start_chat` 한 건과 `$run` 토큰)는 화면이 붙이므로, 팩은 워크플로가
/// 무엇을 하는지는 정해도 어떤 작업을 호출할지는 정하지 못한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaOnboardingWorkflowTemplate {
    /// 워크플로 id 템플릿. 소문자·숫자·하이픈으로 치환되도록 화면이 다듬는다.
    pub id: String,
    pub display_name: String,
    pub description: String,
    /// 무인 런타임에 보낼 지시문.
    pub message: String,
    /// 작업 경로로 쓸 필드 키. 회차 계약의 `projectPath` 입력이 된다.
    pub project_path_field: String,
    #[serde(default)]
    pub required_skills: Vec<String>,
    /// 이 회차가 따를 절차의 원본. 번들 절차 스킬의 키를 적으면, 만들기 때 그 본문을
    /// **이 워크플로 전용 공통 스킬**로 복사하고 계약이 그것을 `requiredSkills`로 건다
    /// (W6-9). 온보딩은 프로젝트마다 다시 도는 것이라 절차도 프로젝트마다 따로 있어야
    /// 한다 — 한 벌을 나눠 쓰면 한 프로젝트의 절차 수정이 다른 프로젝트 회차까지 바꾼다.
    #[serde(default)]
    pub procedure: Option<String>,
    /// 이 회차가 여러 건 동시에 돌 수 있는지(W6-8). 켜면 화면이 병렬 실행 입력 묶음을
    /// 카드 마지막 단계에 붙이고, 계약에 레인 서문과 `parallel-round-lanes` 의존을
    /// 얹는다. 팩은 이 한 줄만 적고 서문의 문구는 앱이 만든다 — 레인 절차가 바뀔 때
    /// 팩마다 고쳐 적을 자리가 생기면 절차와 팩이 어긋난다.
    #[serde(default)]
    pub parallel: bool,
}

/// 등록할 반복 요청(회차 트리거). 워크플로 id는 앞선 산출물에서 온다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaOnboardingScheduleTemplate {
    pub name: String,
    /// 만들어질 때 켜 둘지. 기본은 꺼짐 — 사용자가 페이싱 탭에서 확인하고 켠다.
    #[serde(default)]
    pub enabled: bool,
}

/// 마지막 단계에서 실제로 만들어지는 것. 종류는 닫힌 목록이고, 각 종류는 이미 등록된
/// 변경 작업 하나로 내려가 그 작업의 승인·원격 게이트를 그대로 받는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum AiaOnboardingAction {
    /// `create_directory` — 마일스톤 폴더처럼 프로젝트 안에 자리를 만든다.
    CreateDirectory {
        label: LocalizedText,
        /// 절대경로 템플릿. 이미 있는 폴더 아래 세 칸까지만 만들어진다(C6-4).
        path: String,
        #[serde(default)]
        when: Option<AiaOnboardingCondition>,
    },
    /// `propose_system_workflow_schema` → `register_system_workflow`.
    RegisterWorkflow {
        label: LocalizedText,
        workflow: AiaOnboardingWorkflowTemplate,
        #[serde(default)]
        when: Option<AiaOnboardingCondition>,
    },
    /// `create_scheduled_request` — 앞서 등록한 워크플로를 도는 회차.
    CreateScheduledRequest {
        label: LocalizedText,
        schedule: AiaOnboardingScheduleTemplate,
        #[serde(default)]
        when: Option<AiaOnboardingCondition>,
    },
}

impl AiaOnboardingAction {
    fn label(&self) -> &LocalizedText {
        match self {
            Self::CreateDirectory { label, .. }
            | Self::RegisterWorkflow { label, .. }
            | Self::CreateScheduledRequest { label, .. } => label,
        }
    }

    fn condition(&self) -> Option<&AiaOnboardingCondition> {
        match self {
            Self::CreateDirectory { when, .. }
            | Self::RegisterWorkflow { when, .. }
            | Self::CreateScheduledRequest { when, .. } => when.as_ref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaOnboardingCard {
    pub id: String,
    pub icon: AiaOnboardingIcon,
    /// 접힌 카드의 제목.
    pub title: LocalizedText,
    /// 접힌 카드에 보이는 한 줄 설명. 시작하기 전에는 이것만 보인다.
    pub summary: LocalizedText,
    /// 시작한 뒤에 보이는 문단.
    #[serde(default)]
    pub description: Option<LocalizedText>,
    /// "목업 · 준비 중" 같은 상태 표식.
    #[serde(default)]
    pub badge: Option<LocalizedText>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub templates: Vec<AiaOnboardingTemplate>,
    pub steps: Vec<AiaOnboardingStep>,
    #[serde(default)]
    pub actions: Vec<AiaOnboardingAction>,
    /// 만들기 버튼이 아직 열리지 않은 카드. 산출물 없이 화면만 보여 준다.
    #[serde(default)]
    pub preview_only: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaOnboardingPack {
    pub schema_version: u32,
    pub pack_id: String,
    pub version: String,
    pub display_name: String,
    pub cards: Vec<AiaOnboardingCard>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiaOnboardingPackSource {
    /// 앱에 포함된 기본 팩. 새로 설치한 장치에도 처음부터 있다.
    Bundled,
    /// 공통 스킬 저장소에 설치된 팩.
    CommonSkill,
}

/// 화면이 카드 하나를 그리고 지우기 위해 필요한 것 전부.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaOnboardingCardView {
    #[serde(flatten)]
    pub card: AiaOnboardingCard,
    pub source: AiaOnboardingPackSource,
    pub pack_id: String,
    /// 공통 스킬 팩이면 그 스킬 키. 삭제는 이 스킬을 휴지통으로 옮기는 것이다.
    pub skill_key: Option<String>,
    /// 같은 팩에 들어 있는 카드 수. 1보다 크면 삭제가 이웃 카드까지 가져간다.
    pub pack_card_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaOnboardingPackSummary {
    pub pack_id: String,
    pub version: String,
    pub display_name: String,
    pub source: AiaOnboardingPackSource,
    pub skill_key: Option<String>,
    pub card_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaOnboardingCatalogIssue {
    pub skill_key: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaOnboardingSkillTemplate {
    pub key: String,
    pub name: String,
    pub description: String,
    pub files: Vec<AiaOnboardingTemplateFile>,
    pub installed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaOnboardingTemplateFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaOnboardingCatalog {
    pub packs: Vec<AiaOnboardingPackSummary>,
    pub cards: Vec<AiaOnboardingCardView>,
    pub issues: Vec<AiaOnboardingCatalogIssue>,
    /// 회차 절차 스킬. 계약의 `requiredSkills`에 적힌 키가 여기 있고 `installed`가
    /// false면, 화면이 만들기 전에 설치를 함께 승인받는다.
    pub skills: Vec<AiaOnboardingSkillTemplate>,
    /// 팩을 새로 쓸 AIA가 따라야 할 파일 자리. 화면 안내와 AIA 설명이 어긋나지 않게
    /// 카탈로그가 직접 알려 준다.
    pub manifest_relative: String,
    /// 공통 스킬 저장소의 스킬 루트. 회차 지시문이 절차 스킬의 **절대 경로**를 함께
    /// 실어야 한다 — 공급자마다 스킬을 찾는 방식이 다르고, 만들어진 원본은 아직 어느
    /// 공급자에도 배포되지 않은 상태이기 때문이다.
    pub skills_root: String,
}

/// 번들 기본 팩과 공통 스킬 저장소의 팩을 합쳐 카드 목록을 만든다.
pub fn load_aia_onboarding_catalog(app_data_dir: &Path) -> Result<AiaOnboardingCatalog, CoreError> {
    load_aia_onboarding_catalog_from_root(&repository_skills_root(app_data_dir))
}

fn load_aia_onboarding_catalog_from_root(
    common_root: &Path,
) -> Result<AiaOnboardingCatalog, CoreError> {
    let bundled = parse_and_validate_pack(BUNDLED_PACK.as_bytes(), "번들 기본 팩")?;
    let mut packs = Vec::new();
    let mut cards = Vec::new();
    let mut issues = Vec::new();
    let mut pack_ids = BTreeSet::new();

    push_pack(
        &mut packs,
        &mut cards,
        &mut pack_ids,
        bundled,
        AiaOnboardingPackSource::Bundled,
        None,
    );

    if common_root.exists() {
        load_common_packs(
            common_root,
            &mut packs,
            &mut cards,
            &mut pack_ids,
            &mut issues,
        )?;
    }

    Ok(AiaOnboardingCatalog {
        packs,
        cards,
        issues,
        skills: BUNDLED_SKILLS
            .iter()
            .map(|skill| AiaOnboardingSkillTemplate {
                key: skill.key.to_owned(),
                name: skill.key.to_owned(),
                description: skill.description.to_owned(),
                files: vec![AiaOnboardingTemplateFile {
                    path: "SKILL.md".to_owned(),
                    content: skill.body.to_owned(),
                }],
                installed: fs::symlink_metadata(common_root.join(skill.key)).is_ok(),
            })
            .collect(),
        manifest_relative: MANIFEST_RELATIVE.to_owned(),
        skills_root: common_root.to_string_lossy().into_owned(),
    })
}

fn load_common_packs(
    common_root: &Path,
    packs: &mut Vec<AiaOnboardingPackSummary>,
    cards: &mut Vec<AiaOnboardingCardView>,
    pack_ids: &mut BTreeSet<String>,
    issues: &mut Vec<AiaOnboardingCatalogIssue>,
) -> Result<(), CoreError> {
    let canonical_root = fs::canonicalize(common_root)?;
    let mut entries = fs::read_dir(common_root)?.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let directory = entry.path();
        let key = entry.file_name().to_string_lossy().into_owned();
        if fs::symlink_metadata(directory.join(MANIFEST_RELATIVE)).is_err() {
            continue;
        }
        match load_common_pack(&canonical_root, &directory, &key) {
            Ok(pack) => {
                if pack_ids.contains(&pack.pack_id) {
                    issues.push(AiaOnboardingCatalogIssue {
                        skill_key: key,
                        message: format!("이미 있는 팩 id입니다: {}", pack.pack_id),
                    });
                    continue;
                }
                let remaining = MAX_TOTAL_CARDS.saturating_sub(cards.len());
                if pack.cards.len() > remaining {
                    issues.push(AiaOnboardingCatalogIssue {
                        skill_key: key,
                        message: format!("온보딩 카드는 전체 {MAX_TOTAL_CARDS}개까지입니다"),
                    });
                    continue;
                }
                push_pack(
                    packs,
                    cards,
                    pack_ids,
                    pack,
                    AiaOnboardingPackSource::CommonSkill,
                    Some(key),
                );
            }
            Err(error) => issues.push(AiaOnboardingCatalogIssue {
                skill_key: key,
                message: error.to_string(),
            }),
        }
    }
    Ok(())
}

fn push_pack(
    packs: &mut Vec<AiaOnboardingPackSummary>,
    cards: &mut Vec<AiaOnboardingCardView>,
    pack_ids: &mut BTreeSet<String>,
    pack: AiaOnboardingPack,
    source: AiaOnboardingPackSource,
    skill_key: Option<String>,
) {
    let card_count = pack.cards.len();
    pack_ids.insert(pack.pack_id.clone());
    packs.push(AiaOnboardingPackSummary {
        pack_id: pack.pack_id.clone(),
        version: pack.version.clone(),
        display_name: pack.display_name.clone(),
        source,
        skill_key: skill_key.clone(),
        card_count,
    });
    for card in pack.cards {
        if !card.enabled {
            continue;
        }
        cards.push(AiaOnboardingCardView {
            card,
            source,
            pack_id: pack.pack_id.clone(),
            skill_key: skill_key.clone(),
            pack_card_count: card_count,
        });
    }
}

fn load_common_pack(
    canonical_root: &Path,
    directory: &Path,
    key: &str,
) -> Result<AiaOnboardingPack, CoreError> {
    validate_skill_key(key)?;
    ensure_real_directory(directory, "온보딩 팩 스킬 디렉터리")?;
    let canonical_directory = fs::canonicalize(directory)?;
    if canonical_directory.parent() != Some(canonical_root) {
        return Err(CoreError::InvalidInput(
            "온보딩 팩 경로가 공통 스킬 루트를 벗어났습니다".to_owned(),
        ));
    }
    let references = directory.join("references");
    ensure_real_directory(&references, "온보딩 팩 references")?;
    let bytes = read_bounded_manifest(&directory.join(MANIFEST_RELATIVE), &canonical_directory)?;
    parse_and_validate_pack(&bytes, key)
}

fn ensure_real_directory(path: &Path, label: &str) -> Result<(), CoreError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CoreError::InvalidInput(format!(
            "{label}는 실제 디렉터리여야 합니다"
        )));
    }
    Ok(())
}

fn read_bounded_manifest(manifest: &Path, boundary_directory: &Path) -> Result<Vec<u8>, CoreError> {
    let metadata = fs::symlink_metadata(manifest)?;
    if metadata.file_type().is_symlink() {
        return Err(CoreError::InvalidInput(
            "온보딩 팩 manifest는 심볼릭 링크일 수 없습니다".to_owned(),
        ));
    }
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "온보딩 팩 manifest가 일반 파일이 아닙니다".to_owned(),
        ));
    }
    if metadata.len() > MAX_PACK_BYTES {
        return Err(CoreError::TooLarge(MAX_PACK_BYTES));
    }
    let canonical_manifest = fs::canonicalize(manifest)?;
    if !canonical_manifest.starts_with(boundary_directory) {
        return Err(CoreError::InvalidInput(
            "온보딩 팩 manifest 경로가 스킬 디렉터리를 벗어났습니다".to_owned(),
        ));
    }
    Ok(fs::read(canonical_manifest)?)
}

fn parse_and_validate_pack(bytes: &[u8], source: &str) -> Result<AiaOnboardingPack, CoreError> {
    if bytes.len() as u64 > MAX_PACK_BYTES {
        return Err(CoreError::TooLarge(MAX_PACK_BYTES));
    }
    let pack: AiaOnboardingPack = serde_json::from_slice(bytes).map_err(|error| {
        CoreError::InvalidInput(format!(
            "'{source}' 온보딩 팩 JSON이 올바르지 않습니다: {error}"
        ))
    })?;
    validate_pack(&pack, source)?;
    Ok(pack)
}

fn validate_pack(pack: &AiaOnboardingPack, source: &str) -> Result<(), CoreError> {
    if pack.schema_version != SCHEMA_VERSION {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 온보딩 팩 schemaVersion은 {SCHEMA_VERSION}이어야 합니다"
        )));
    }
    validate_identifier(&pack.pack_id, "packId", source)?;
    validate_text(&pack.version, "version", MAX_SHORT_CHARS, source)?;
    validate_text(&pack.display_name, "displayName", MAX_SHORT_CHARS, source)?;
    if pack.cards.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 온보딩 팩에 카드가 없습니다"
        )));
    }
    ensure_count(
        pack.cards.len(),
        MAX_TOTAL_CARDS,
        "온보딩 카드는 팩당",
        source,
    )?;

    let mut card_ids = BTreeSet::new();
    for card in &pack.cards {
        validate_identifier(&card.id, "card.id", source)?;
        ensure_unique(&mut card_ids, &card.id, "온보딩 카드 id가", source)?;
        validate_card(card, source)?;
    }
    Ok(())
}

fn validate_card(card: &AiaOnboardingCard, source: &str) -> Result<(), CoreError> {
    validate_localized(&card.title, "card.title", MAX_SHORT_CHARS, source)?;
    validate_localized(&card.summary, "card.summary", MAX_LINE_CHARS, source)?;
    if let Some(description) = &card.description {
        validate_localized(description, "card.description", MAX_PARAGRAPH_CHARS, source)?;
    }
    if let Some(badge) = &card.badge {
        validate_localized(badge, "card.badge", MAX_SHORT_CHARS, source)?;
    }

    ensure_count(
        card.templates.len(),
        MAX_TEMPLATES_PER_CARD,
        "참고 절차는 카드당",
        source,
    )?;
    for template in &card.templates {
        validate_text(&template.key, "template.key", MAX_SHORT_CHARS, source)?;
        validate_localized(&template.title, "template.title", MAX_SHORT_CHARS, source)?;
        if let Some(meta) = &template.meta {
            validate_localized(meta, "template.meta", MAX_LINE_CHARS, source)?;
        }
        ensure_count(
            template.steps.len(),
            MAX_TEMPLATE_STEPS,
            "참고 절차 단계는",
            source,
        )?;
        for step in &template.steps {
            validate_localized(step, "template.steps[]", MAX_SHORT_CHARS, source)?;
        }
    }

    if card.steps.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 온보딩 카드에 단계가 없습니다"
        )));
    }
    ensure_count(
        card.steps.len(),
        MAX_STEPS_PER_CARD,
        "온보딩 단계는 카드당",
        source,
    )?;

    let mut field_keys = BTreeSet::new();
    let mut step_ids = BTreeSet::new();
    for step in &card.steps {
        validate_identifier(&step.id, "step.id", source)?;
        ensure_unique(&mut step_ids, &step.id, "온보딩 단계 id가", source)?;
        validate_localized(&step.title, "step.title", MAX_SHORT_CHARS, source)?;
        if let Some(hint) = &step.hint {
            validate_localized(hint, "step.hint", MAX_LINE_CHARS, source)?;
        }
        ensure_count(
            step.fields.len(),
            MAX_FIELDS_PER_STEP,
            "입력은 단계당",
            source,
        )?;
        for field in &step.fields {
            validate_key(&field.key, source)?;
            ensure_unique(
                &mut field_keys,
                &field.key,
                "입력 key가 카드 안에서",
                source,
            )?;
            validate_field(field, source)?;
        }
    }

    // 조건과 템플릿 변수는 이 카드가 선언한 입력만 가리킬 수 있다. 없는 키를 가리키면
    // 화면에서 조용히 빈 값으로 치환되어, 사용자가 채운 줄 아는 값이 빠진 채 만들어진다.
    for step in &card.steps {
        for field in &step.fields {
            if let Some(condition) = &field.visible_when {
                validate_condition(condition, &field_keys, source)?;
            }
        }
    }

    ensure_count(
        card.actions.len(),
        MAX_ACTIONS_PER_CARD,
        "산출물은 카드당",
        source,
    )?;
    if card.actions.is_empty() && !card.preview_only {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 온보딩 카드에 산출물이 없습니다. 화면만 보여 주려면 previewOnly를 켜세요"
        )));
    }

    let mut registered_workflow = false;
    for action in &card.actions {
        validate_localized(action.label(), "action.label", MAX_LINE_CHARS, source)?;
        if let Some(condition) = action.condition() {
            validate_condition(condition, &field_keys, source)?;
        }
        match action {
            AiaOnboardingAction::CreateDirectory { path, .. } => {
                validate_template_text(path, "action.path", MAX_LINE_CHARS, &field_keys, source)?;
            }
            AiaOnboardingAction::RegisterWorkflow { workflow, .. } => {
                validate_workflow_template(workflow, &field_keys, source)?;
                registered_workflow = true;
            }
            AiaOnboardingAction::CreateScheduledRequest { schedule, .. } => {
                if !registered_workflow {
                    return Err(CoreError::InvalidInput(format!(
                        "'{source}' 회차는 같은 카드에서 먼저 등록한 워크플로에만 붙일 수 있습니다"
                    )));
                }
                validate_template_text(
                    &schedule.name,
                    "schedule.name",
                    MAX_LINE_CHARS,
                    &field_keys,
                    source,
                )?;
            }
        }
    }
    Ok(())
}

fn validate_field(field: &AiaOnboardingField, source: &str) -> Result<(), CoreError> {
    validate_localized(&field.label, "field.label", MAX_SHORT_CHARS, source)?;
    if let Some(placeholder) = &field.placeholder {
        validate_localized(placeholder, "field.placeholder", MAX_LINE_CHARS, source)?;
    }
    if let Some(help) = &field.help {
        validate_localized(help, "field.help", MAX_LINE_CHARS, source)?;
    }
    if let Some(default_value) = &field.default_value {
        validate_text(default_value, "field.defaultValue", MAX_LINE_CHARS, source)?;
    }
    ensure_count(
        field.options.len(),
        MAX_OPTIONS_PER_FIELD,
        "선택지는 입력당",
        source,
    )?;
    for option in &field.options {
        validate_text(&option.value, "option.value", MAX_SHORT_CHARS, source)?;
        validate_localized(&option.label, "option.label", MAX_SHORT_CHARS, source)?;
    }

    let needs_options = matches!(
        field.kind,
        AiaOnboardingFieldKind::Select | AiaOnboardingFieldKind::MultiSelect
    );
    if needs_options && field.options.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 고르는 입력에는 선택지가 필요합니다: {}",
            field.key
        )));
    }
    // 목록을 앱이 채우는 칸에 팩이 선택지를 적으면, 화면이 무엇을 보여 줄지가 팩과
    // 앱 양쪽에 생겨 어긋난다.
    let app_provided = matches!(
        field.kind,
        AiaOnboardingFieldKind::ProjectPicker
            | AiaOnboardingFieldKind::DocRootPicker
            | AiaOnboardingFieldKind::RecordTargetPicker
            | AiaOnboardingFieldKind::CypressWorkspacePicker
            | AiaOnboardingFieldKind::CypressEnvKeyPicker
            | AiaOnboardingFieldKind::BranchPicker
    );
    // 직접 적기는 고르는 칸에서만 뜻이 있다. 글자 칸에 켜면 화면에 그릴 것이 없다.
    let choosable = needs_options || app_provided;
    if field.allow_other && !choosable {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' allowOther는 고르는 입력에만 쓸 수 있습니다: {}",
            field.key
        )));
    }
    if app_provided && !field.options.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 앱이 채우는 입력에는 선택지를 적을 수 없습니다: {}",
            field.key
        )));
    }
    Ok(())
}

fn validate_condition(
    condition: &AiaOnboardingCondition,
    field_keys: &BTreeSet<String>,
    source: &str,
) -> Result<(), CoreError> {
    if !field_keys.contains(&condition.field) {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 조건이 없는 입력을 가리킵니다: {}",
            condition.field
        )));
    }
    validate_text(
        &condition.equals,
        "condition.equals",
        MAX_SHORT_CHARS,
        source,
    )
}

fn validate_workflow_template(
    workflow: &AiaOnboardingWorkflowTemplate,
    field_keys: &BTreeSet<String>,
    source: &str,
) -> Result<(), CoreError> {
    validate_template_text(
        &workflow.id,
        "workflow.id",
        MAX_SHORT_CHARS,
        field_keys,
        source,
    )?;
    validate_template_text(
        &workflow.display_name,
        "workflow.displayName",
        MAX_LINE_CHARS,
        field_keys,
        source,
    )?;
    validate_template_text(
        &workflow.description,
        "workflow.description",
        MAX_PARAGRAPH_CHARS,
        field_keys,
        source,
    )?;
    validate_template_text(
        &workflow.message,
        "workflow.message",
        MAX_MESSAGE_CHARS,
        field_keys,
        source,
    )?;
    if !field_keys.contains(&workflow.project_path_field) {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' workflow.projectPathField가 없는 입력을 가리킵니다: {}",
            workflow.project_path_field
        )));
    }
    if let Some(procedure) = &workflow.procedure {
        // 원본은 앱이 들고 있는 절차뿐이다. 레인 절차는 기계장치라 프로젝트를 가리지 않고
        // 병렬을 켰을 때 앱이 따로 얹으므로 여기서 고르지 않는다.
        let known = BUNDLED_SKILLS
            .iter()
            .any(|skill| skill.key != LANE_SKILL_KEY && skill.key == procedure);
        if !known {
            return Err(CoreError::InvalidInput(format!(
                "'{source}' workflow.procedure가 앱이 들고 있는 절차가 아닙니다: {procedure}"
            )));
        }
    }
    ensure_count(
        workflow.required_skills.len(),
        MAX_REQUIRED_SKILLS,
        "requiredSkills는",
        source,
    )?;
    for key in &workflow.required_skills {
        validate_skill_key(key)?;
    }
    Ok(())
}

/// 템플릿 문자열 하나. `{{key}}` 자리는 이 카드가 선언한 입력이나 앞선 산출물이 만든
/// 값만 가리킬 수 있다.
fn validate_template_text(
    value: &str,
    field: &str,
    max_chars: usize,
    field_keys: &BTreeSet<String>,
    source: &str,
) -> Result<(), CoreError> {
    validate_text(value, field, max_chars, source)?;
    for name in template_variables(value) {
        let known = field_keys.contains(name.as_str())
            || DERIVED_TEMPLATE_VARIABLES.contains(&name.as_str());
        if !known {
            return Err(CoreError::InvalidInput(format!(
                "'{source}' {field}의 {{{{{name}}}}}가 이 카드에 없는 값입니다"
            )));
        }
    }
    Ok(())
}

/// `{{ key }}` 꼴에서 이름만 뽑는다. 닫히지 않은 괄호는 치환되지 않으므로 무시한다.
fn template_variables(value: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        names.push(after[..end].trim().to_owned());
        rest = &after[end + 2..];
    }
    names
}

fn validate_localized(
    value: &LocalizedText,
    field: &str,
    max_chars: usize,
    source: &str,
) -> Result<(), CoreError> {
    for part in value.parts() {
        validate_text(part, field, max_chars, source)?;
    }
    Ok(())
}

fn validate_text(
    value: &str,
    field: &str,
    max_chars: usize,
    source: &str,
) -> Result<(), CoreError> {
    if value.trim().is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 온보딩 팩의 {field}가 비어 있습니다"
        )));
    }
    if value.chars().count() > max_chars {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 온보딩 팩의 {field}는 {max_chars}자까지입니다"
        )));
    }
    // 화면은 팩 문구를 평문으로만 그린다. 제어문자는 줄바꿈·탭만 남겨, 눈에 보이지 않는
    // 글자로 문구를 위장하는 길을 막는다.
    if value
        .chars()
        .any(|ch| ch.is_control() && ch != '\n' && ch != '\t')
    {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 온보딩 팩의 {field}에 쓸 수 없는 제어문자가 있습니다"
        )));
    }
    Ok(())
}

/// 팩이 선언한 목록 하나가 개수 상한 안인지 본다.
///
/// 카드·단계·입력·선택지·참고 절차·산출물·requiredSkills가 저마다 상한을 갖는데, 검사와
/// 문구 조립을 자리마다 펼쳐 두면 새 상한을 더할 때 `'{source}'` 접두사나 조사 하나를
/// 빠뜨려도 드러나지 않는다. `subject`는 조사까지 붙은 주어라 문구는 여기서 완성된다.
fn ensure_count(count: usize, limit: usize, subject: &str, source: &str) -> Result<(), CoreError> {
    if count > limit {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' {subject} {limit}개까지입니다"
        )));
    }
    Ok(())
}

/// 같은 묶음 안에서 식별자가 겹치지 않는지 본다. 겹치면 뒤엣것이 앞엣것을 가려 카드가
/// 통째로 사라지거나 값이 엉뚱한 자리로 들어가므로, 로드에서 끊는다.
fn ensure_unique(
    seen: &mut BTreeSet<String>,
    value: &str,
    subject: &str,
    source: &str,
) -> Result<(), CoreError> {
    if !seen.insert(value.to_owned()) {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' {subject} 중복됩니다: {value}"
        )));
    }
    Ok(())
}

/// 입력 키. 템플릿에서 `{{projectPath}}`처럼 그대로 쓰이므로 카드 id(케밥)와 달리
/// 낱말 사이를 대문자로 잇는다. 치환 자리와 헷갈릴 글자는 받지 않는다.
fn validate_key(value: &str, source: &str) -> Result<(), CoreError> {
    if RESERVED_FIELD_KEYS.contains(&value) {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' {value}는 앱이 병렬 실행에 쓰는 이름이라 입력 key로 쓸 수 없습니다"
        )));
    }
    let valid = !value.is_empty()
        && value.len() <= 48
        && value.starts_with(|ch: char| ch.is_ascii_alphabetic())
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_');
    if !valid {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 온보딩 팩의 field.key는 영문으로 시작하는 영숫자·밑줄 48자 이내여야 합니다: {value}"
        )));
    }
    Ok(())
}

fn validate_identifier(value: &str, field: &str, source: &str) -> Result<(), CoreError> {
    let valid = !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-');
    if !valid {
        return Err(CoreError::InvalidInput(format!(
            "'{source}' 온보딩 팩의 {field}는 영소문자·숫자·하이픈 64자 이내여야 합니다: {value}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn bundled() -> AiaOnboardingPack {
        parse_and_validate_pack(BUNDLED_PACK.as_bytes(), "번들 기본 팩").expect("번들 팩")
    }

    /// 새로 설치한 장치에도 카드가 있어야 한다. 번들 팩이 깨지면 자동화 탭이 빈다.
    #[test]
    fn the_bundled_pack_is_valid_and_ships_both_cards() {
        let pack = bundled();
        assert_eq!(pack.schema_version, SCHEMA_VERSION);
        let ids: Vec<_> = pack.cards.iter().map(|card| card.id.as_str()).collect();
        assert!(ids.contains(&"project-milestones"), "{ids:?}");
        assert!(ids.contains(&"qa-workflow"), "{ids:?}");
    }

    /// 회차 절차는 앱이 들고 있다가 공통 스킬로 설치된다. 배포 frontmatter의
    /// description은 한 줄이어야 한다 — 블록 스칼라로 적으면 빈 값으로 파싱돼 설치가
    /// 실패한다.
    #[test]
    fn the_round_skills_ship_with_the_app_and_have_single_line_frontmatter() {
        let temp = tempfile::tempdir().expect("temp");
        let catalog =
            load_aia_onboarding_catalog_from_root(&temp.path().join("absent")).expect("catalog");
        let keys: Vec<_> = catalog.skills.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(
            keys,
            vec![
                LANE_SKILL_KEY,
                "qa-round",
                "qa-ticket-round",
                "delivery-round"
            ]
        );

        for skill in &catalog.skills {
            assert!(!skill.installed, "없는 저장소에는 설치돼 있지 않다");
            let file = skill
                .files
                .iter()
                .find(|file| file.path == "SKILL.md")
                .expect("SKILL.md");
            let mut lines = file.content.lines();
            assert_eq!(lines.next(), Some("---"), "{}", skill.key);
            assert_eq!(lines.next(), Some(format!("name: {}", skill.key).as_str()));
            let description = lines.next().expect("description");
            assert!(description.starts_with("description: "), "{description}");
            assert!(
                !description.trim_end().ends_with('>') && !description.trim_end().ends_with('|'),
                "description은 한 줄이어야 한다: {description}"
            );
            assert_eq!(lines.next(), Some("---"), "{}", skill.key);
        }

        // 레인 절차의 뼈대가 들어 있는지. 문구가 아니라 장치를 확인한다.
        let lane = &catalog.skills[0].files[0].content;
        for needle in [".lease", "worktree add", "push", "REBASE-CONFLICT"] {
            assert!(lane.contains(needle), "{needle}");
        }
    }

    /// 절차는 스킬이 들고 지시문은 값만 싣는다(W6-9). 절차 원본은 앱이 들고 있고,
    /// 만들기 때 워크플로 전용 공통 스킬로 복사된다 — 프로젝트마다 제 절차를 갖는다.
    #[test]
    fn every_bundled_workflow_declares_a_procedure_instead_of_inlining_it() {
        let temp = tempfile::tempdir().expect("temp");
        let catalog =
            load_aia_onboarding_catalog_from_root(&temp.path().join("absent")).expect("catalog");
        let shipped: BTreeSet<_> = catalog.skills.iter().map(|s| s.key.as_str()).collect();

        for card in bundled().cards {
            for action in &card.actions {
                let AiaOnboardingAction::RegisterWorkflow { workflow, .. } = action else {
                    continue;
                };
                let procedure = workflow
                    .procedure
                    .as_deref()
                    .unwrap_or_else(|| panic!("{} 계약이 절차를 선언하지 않았다", workflow.id));
                assert!(shipped.contains(procedure), "{procedure}");
                // 계약이 걸 스킬은 만들기 때 워크플로 id로 만들어지므로 팩에 적지 않는다.
                assert!(workflow.required_skills.is_empty(), "{}", workflow.id);
                // 절차 스킬을 가리키는 문장은 앱이 붙인다. 팩이 적으면 치환 전 값이라
                // 실제 스킬 키(slugify 결과)와 어긋난다.
                assert!(
                    !workflow.message.contains("스킬을 따른다"),
                    "{} 지시문이 절차 스킬 이름을 직접 적었다",
                    workflow.id
                );
                // 번호를 매겨 단계를 적는 지시문은 절차를 베낀 것이다.
                assert!(
                    !workflow.message.contains("\n1. "),
                    "{} 지시문에 절차가 베껴져 있다",
                    workflow.id
                );
            }
        }
    }

    /// 두 번들 카드 모두 병렬로 돌 수 있다고 선언한다(W6-8). 화면은 이 선언을 보고
    /// 병렬 실행 입력 묶음을 붙인다.
    #[test]
    fn both_bundled_cards_declare_parallel_support() {
        for card in bundled().cards {
            let declared = card.actions.iter().any(|action| match action {
                AiaOnboardingAction::RegisterWorkflow { workflow, .. } => workflow.parallel,
                _ => false,
            });
            assert!(declared, "{} 카드가 병렬을 선언하지 않았다", card.id);
        }
    }

    /// QA 카드는 워크플로를 둘 등록한다 — QA를 수행해 티켓을 남기는 회차와, 사용자가
    /// 상태를 바꿔 둔 티켓을 가져가 고치는 회차. 티켓 처리는 같은 티켓을 두 회차가 잡지
    /// 않도록 병렬을 선언하지 않는다.
    #[test]
    fn the_qa_card_registers_a_qa_round_and_a_ticket_round() {
        let qa = bundled()
            .cards
            .into_iter()
            .find(|card| card.id == "qa-workflow")
            .expect("QA 카드");
        let workflows: Vec<_> = qa
            .actions
            .iter()
            .filter_map(|action| match action {
                AiaOnboardingAction::RegisterWorkflow { workflow, .. } => Some(workflow),
                _ => None,
            })
            .collect();
        assert_eq!(workflows.len(), 2, "QA 회차와 티켓 처리 회차");
        assert!(workflows[0].id.ends_with("-qa"), "{}", workflows[0].id);
        assert!(
            workflows[1].id.ends_with("-qa-tickets"),
            "{}",
            workflows[1].id
        );
        assert!(workflows[0].parallel, "QA 회차는 병렬을 지원한다");
        assert!(!workflows[1].parallel, "티켓 처리는 한 건씩 돈다");
        // 티켓 처리는 사용자가 정한 상태만 읽는다.
        assert!(workflows[1].message.contains("{{ticketStates}}"));
        assert!(workflows[1].message.contains("상태는 사용자가 정한다"));
    }

    /// 고르는 칸은 어느 시스템에나 맞는 목록을 만들 수 없다. 목록에 없는 것을 적을 자리가
    /// 없으면 사용자가 거기서 멈추므로, 번들 카드의 고르는 칸은 직접 적기를 열어 둔다.
    #[test]
    fn bundled_choice_fields_let_the_user_type_what_is_missing() {
        for card in bundled().cards {
            for step in &card.steps {
                for field in &step.fields {
                    let choosable = matches!(
                        field.kind,
                        AiaOnboardingFieldKind::Select
                            | AiaOnboardingFieldKind::MultiSelect
                            | AiaOnboardingFieldKind::CypressEnvKeyPicker
                            | AiaOnboardingFieldKind::BranchPicker
                    );
                    // 앱과 절차가 **그 값으로 분기하는** 칸은 예외다. 목록 밖의 값을
                    // 받으면 분기가 어디에도 걸리지 않아 조용히 기본 갈래로 떨어진다.
                    // (기록 대상처럼 플러그인이 채우는 칸도 같은 이유로 여기 오지 않는다.)
                    const BRANCHING: &[&str] = &["execution", "ticketHandling"];
                    if choosable && !BRANCHING.contains(&field.key.as_str()) {
                        assert!(
                            field.allow_other,
                            "{} 카드의 {} 칸에 직접 적을 자리가 없습니다",
                            card.id, field.key
                        );
                    }
                }
            }
        }
    }

    /// 브랜치도 저장소를 열면 알 수 있는 값이다. 사용자가 외워 적게 하지 않는다.
    #[test]
    fn the_delivery_card_reads_branches_instead_of_asking_for_them() {
        let card = bundled()
            .cards
            .into_iter()
            .find(|card| card.id == "project-milestones")
            .expect("진행 카드");
        let branch = card
            .steps
            .iter()
            .flat_map(|step| &step.fields)
            .find(|field| field.key == "branch")
            .expect("브랜치 칸");
        assert_eq!(branch.kind, AiaOnboardingFieldKind::BranchPicker);
        // 리모트를 붙인 이름(private/dev-history)은 로컬 목록에 없으므로 직접 적을 수 있어야 한다.
        assert!(branch.allow_other);
        // 비워 두는 것이 "커밋하지 않는다"는 뜻이므로 필수가 아니다.
        assert!(!branch.required);
    }

    /// 마일스톤 위치를 고르면 **어디인지**까지 받아야 한다. 상세 칸이 선택이면 노션·지라를
    /// 고른 사용자가 주소를 비운 채 만들기를 눌러, 위치가 빈 채로 치환된 지시문이 등록된다.
    /// 그 칸은 그 위치를 골랐을 때만 보이므로 필수로 두어도 다른 갈래를 막지 않는다.
    #[test]
    fn the_delivery_card_asks_where_the_milestones_actually_are() {
        let card = bundled()
            .cards
            .into_iter()
            .find(|card| card.id == "project-milestones")
            .expect("진행 카드");
        let details: Vec<_> = card
            .steps
            .iter()
            .flat_map(|step| &step.fields)
            .filter(|field| {
                // 켜짐/꺼짐은 언제나 값이 있어 필수 판정의 대상이 아니다. 적어 넣는 칸만 본다.
                field.kind == AiaOnboardingFieldKind::Text
                    && field
                        .visible_when
                        .as_ref()
                        .is_some_and(|condition| condition.field == "milestoneSource")
            })
            .collect();
        assert!(!details.is_empty(), "마일스톤 상세 칸");
        for field in details {
            assert!(
                field.required,
                "{} 칸이 비어도 만들기가 통과합니다",
                field.key
            );
        }
    }

    /// 계정 키는 손으로 옮겨 적는 값이 아니다. 고른 작업공간에서 키 이름을 읽어 온다.
    #[test]
    fn the_qa_card_reads_account_keys_instead_of_asking_for_them() {
        let qa = bundled()
            .cards
            .into_iter()
            .find(|card| card.id == "qa-workflow")
            .expect("QA 카드");
        let keys = qa
            .steps
            .iter()
            .flat_map(|step| &step.fields)
            .find(|field| field.key == "accountKeys")
            .expect("계정 키 칸");
        assert_eq!(keys.kind, AiaOnboardingFieldKind::CypressEnvKeyPicker);
        assert!(keys.allow_other, "파일이 없으면 직접 적을 수 있어야 한다");
    }

    /// 단계마다 무엇을 묻는지 한 줄로 보인다. 온보딩은 처음 보는 사람이 지나가는 화면이다.
    #[test]
    fn every_bundled_step_explains_itself() {
        for card in bundled().cards {
            for step in &card.steps {
                assert!(
                    step.hint.is_some(),
                    "{} 카드의 {} 단계에 설명이 없습니다",
                    card.id,
                    step.id
                );
            }
        }
    }

    /// 관리항목 체크리스트는 노션 QA Sheets·Test Scenario 컬럼에서 뽑고 **기본은 전체
    /// 선택**이다. 기본이 일부면 사용자가 켜지 않은 항목이 조용히 빠진 채 티켓이 쌓인다.
    #[test]
    fn the_qa_checklist_defaults_to_every_item() {
        let qa = bundled()
            .cards
            .into_iter()
            .find(|card| card.id == "qa-workflow")
            .expect("QA 카드");
        let checklist = qa
            .steps
            .iter()
            .flat_map(|step| &step.fields)
            .find(|field| field.key == "qaChecklist")
            .expect("관리항목 칸");

        assert_eq!(checklist.kind, AiaOnboardingFieldKind::MultiSelect);
        let selected: Vec<_> = checklist
            .default_value
            .as_deref()
            .expect("기본값")
            .split(',')
            .collect();
        let options: Vec<_> = checklist
            .options
            .iter()
            .map(|option| option.value.as_str())
            .collect();
        assert_eq!(selected, options, "기본은 전체 선택이다");
        // 사용자가 짚은 항목이 실제로 들어 있는지.
        // 디바이스·OS·브라우저·네트워크는 QA 시트에서 각각 다른 컬럼이라 항목도 나눈다.
        for needle in [
            "디바이스(단말 모델)",
            "OS·버전",
            "브라우저·버전",
            "네트워크",
            "접근 경로(출처)",
            "검토결과",
        ] {
            assert!(options.contains(&needle), "{needle} — {options:?}");
        }
    }

    /// 공통 저장소가 없는 장치에서도 번들 카드만으로 카탈로그가 선다.
    #[test]
    fn the_catalog_stands_on_the_bundled_pack_alone() {
        let temp = tempfile::tempdir().expect("temp");
        let catalog =
            load_aia_onboarding_catalog_from_root(&temp.path().join("absent")).expect("catalog");
        assert_eq!(catalog.packs.len(), 1);
        assert_eq!(catalog.packs[0].source, AiaOnboardingPackSource::Bundled);
        assert!(catalog.cards.iter().all(|card| card.skill_key.is_none()));
        assert!(catalog.issues.is_empty());
    }

    fn minimal_pack(pack_id: &str, card_id: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "packId": pack_id,
            "version": "1.0.0",
            "displayName": "테스트 팩",
            "cards": [{
                "id": card_id,
                "icon": "target",
                "title": "테스트",
                "summary": "한 줄 설명",
                "steps": [{
                    "id": "basics",
                    "title": "기본",
                    "fields": [{ "key": "repo", "label": "저장소", "kind": "projectPicker" }]
                }],
                "actions": [{
                    "kind": "createDirectory",
                    "label": "마일스톤 폴더",
                    "path": "{{repo}}/docs/milestones"
                }]
            }]
        })
    }

    fn write_pack(root: &Path, key: &str, pack: &Value) {
        let references = root.join(key).join("references");
        fs::create_dir_all(&references).expect("references");
        fs::write(
            references.join("aia-onboarding.json"),
            serde_json::to_vec(pack).expect("json"),
        )
        .expect("manifest");
    }

    #[test]
    fn a_common_skill_pack_adds_its_cards_and_names_the_skill_to_delete() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).expect("root");
        write_pack(
            &root,
            "team-onboarding",
            &minimal_pack("team", "team-start"),
        );

        let catalog = load_aia_onboarding_catalog_from_root(&root).expect("catalog");
        let card = catalog
            .cards
            .iter()
            .find(|card| card.card.id == "team-start")
            .expect("추가된 카드");
        assert_eq!(card.source, AiaOnboardingPackSource::CommonSkill);
        // 삭제는 이 스킬을 휴지통으로 옮기는 것이다. 화면이 그 대상을 알아야 한다.
        assert_eq!(card.skill_key.as_deref(), Some("team-onboarding"));
        assert_eq!(card.pack_card_count, 1);
        assert!(catalog.issues.is_empty(), "{:?}", catalog.issues);
    }

    /// 깨진 팩은 카탈로그를 무너뜨리지 않고 그 자리에 사유만 남긴다.
    #[test]
    fn a_broken_pack_is_reported_and_skipped() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("skills");
        let references = root.join("broken").join("references");
        fs::create_dir_all(&references).expect("references");
        fs::write(references.join("aia-onboarding.json"), b"{ not json").expect("manifest");

        let catalog = load_aia_onboarding_catalog_from_root(&root).expect("catalog");
        assert_eq!(catalog.issues.len(), 1);
        assert_eq!(catalog.issues[0].skill_key, "broken");
        // 번들 카드는 그대로 선다.
        assert!(!catalog.cards.is_empty());
    }

    /// W6: 템플릿은 그 카드가 선언한 입력만 가리킬 수 있다. 없는 키를 조용히 빈 값으로
    /// 치환하면 사용자가 채운 줄 아는 값이 빠진 채 워크플로가 등록된다.
    #[test]
    fn a_template_variable_outside_the_card_is_refused() {
        let mut pack = minimal_pack("team", "team-start");
        pack["cards"][0]["actions"][0]["path"] = json!("{{unknownField}}/docs");
        let error = parse_and_validate_pack(&serde_json::to_vec(&pack).unwrap(), "테스트")
            .expect_err("없는 변수");
        assert!(error.to_string().contains("unknownField"), "{error}");
    }

    /// 회차는 같은 카드에서 등록한 워크플로에만 붙는다. 순서가 뒤집히면 붙일 워크플로가
    /// 없는 회차가 만들어진다.
    #[test]
    fn a_schedule_without_a_registered_workflow_is_refused() {
        let mut pack = minimal_pack("team", "team-start");
        pack["cards"][0]["actions"] = json!([{
            "kind": "createScheduledRequest",
            "label": "회차",
            "schedule": { "name": "{{repo}} 회차" }
        }]);
        let error = parse_and_validate_pack(&serde_json::to_vec(&pack).unwrap(), "테스트")
            .expect_err("워크플로 없는 회차");
        assert!(error.to_string().contains("워크플로"), "{error}");
    }

    /// 팩은 워크플로의 단계를 적지 못한다 — 계약의 뼈대는 앱이 붙인다. 단계를 적어 보내도
    /// 스키마에 그 자리가 없어 무시되는 것이 아니라, 알 수 없는 필드로 거절돼야 한다.
    #[test]
    fn a_pack_cannot_describe_workflow_steps() {
        let mut pack = minimal_pack("team", "team-start");
        pack["cards"][0]["actions"] = json!([{
            "kind": "registerWorkflow",
            "label": "워크플로",
            "workflow": {
                "id": "team-round",
                "displayName": "팀 회차",
                "description": "설명",
                "message": "지시문",
                "projectPathField": "repo",
                "steps": [{ "id": "x", "operation": "run_db_statement", "arguments": {} }]
            }
        }]);
        let error = parse_and_validate_pack(&serde_json::to_vec(&pack).unwrap(), "테스트")
            .expect_err("단계를 적은 팩");
        assert!(
            error.to_string().contains("JSON이 올바르지 않습니다"),
            "{error}"
        );
    }

    /// 아이콘·입력 종류는 닫힌 목록이다.
    #[test]
    fn an_unknown_icon_or_field_kind_is_refused() {
        let mut pack = minimal_pack("team", "team-start");
        pack["cards"][0]["icon"] = json!("skull");
        assert!(parse_and_validate_pack(&serde_json::to_vec(&pack).unwrap(), "테스트").is_err());

        let mut pack = minimal_pack("team", "team-start");
        pack["cards"][0]["steps"][0]["fields"][0]["kind"] = json!("shellCommand");
        assert!(parse_and_validate_pack(&serde_json::to_vec(&pack).unwrap(), "테스트").is_err());
    }

    /// 산출물이 없는 카드는 previewOnly로 선언해야 한다. 만들기 버튼이 아무것도 하지
    /// 않는 카드를 사용자가 끝까지 채우게 두지 않는다.
    #[test]
    fn a_card_without_actions_must_declare_preview_only() {
        let mut pack = minimal_pack("team", "team-start");
        pack["cards"][0]["actions"] = json!([]);
        assert!(parse_and_validate_pack(&serde_json::to_vec(&pack).unwrap(), "테스트").is_err());

        pack["cards"][0]["previewOnly"] = json!(true);
        assert!(parse_and_validate_pack(&serde_json::to_vec(&pack).unwrap(), "테스트").is_ok());
    }

    #[test]
    fn a_pack_id_already_in_use_is_reported_not_merged() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).expect("root");
        // 번들 팩과 같은 id를 들고 오는 팩.
        write_pack(
            &root,
            "shadow-pack",
            &minimal_pack("agent-manager", "team-start"),
        );

        let catalog = load_aia_onboarding_catalog_from_root(&root).expect("catalog");
        assert_eq!(catalog.issues.len(), 1);
        assert!(
            catalog.issues[0].message.contains("팩 id"),
            "{:?}",
            catalog.issues
        );
        assert!(catalog
            .cards
            .iter()
            .all(|card| card.card.id != "team-start"));
    }

    /// 앱이 덧붙이는 병렬 입력과 같은 키를 팩이 선언하면 같은 이름의 칸이 둘 그려지고
    /// 값이 서로 덮는다.
    #[test]
    fn a_pack_cannot_take_the_keys_the_app_adds_for_parallel_runs() {
        let mut pack = minimal_pack("team", "team-start");
        pack["cards"][0]["steps"][0]["fields"][0]["key"] = json!("lanePool");
        let error = parse_and_validate_pack(&serde_json::to_vec(&pack).unwrap(), "테스트")
            .expect_err("예약 키");
        assert!(error.to_string().contains("병렬 실행"), "{error}");

        // 예약 목록이 화면 쪽과 어긋나면 막는 의미가 없다. **양쪽 방향으로** 본다 —
        // 화면에 키를 하나 더하고 여기 적지 않으면 그 키가 다시 팩에 열린다.
        let filler = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/lib/aiaOnboardingParallel.ts"),
        );
        if let Ok(filler) = filler {
            let block = filler
                .split_once("PARALLEL_FIELD_KEYS = {")
                .and_then(|(_, rest)| rest.split_once("} as const;"))
                .map(|(block, _)| block.to_owned())
                .expect("화면 쪽 예약 키 표를 찾을 수 있어야 한다");
            let screen: BTreeSet<String> = block
                .lines()
                .filter_map(|line| line.split_once(": \""))
                .filter_map(|(_, rest)| rest.split_once('"'))
                .map(|(key, _)| key.to_owned())
                .collect();
            let reserved: BTreeSet<String> = RESERVED_FIELD_KEYS
                .iter()
                .map(|key| (*key).to_owned())
                .collect();
            assert_eq!(
                screen, reserved,
                "화면이 덧붙이는 키와 예약 목록이 다릅니다"
            );
        }
    }

    /// 파생 값 목록은 치환하는 쪽이 실제로 공급하는 이름만 담아야 한다. 담기만 하고
    /// 공급하지 않으면 검증은 통과하고 실행이 빈 문자열을 내는, 이 목록이 막으려던 실패가
    /// 그대로 난다. 지금 공급하는 값이 없으므로 목록도 비어 있다 — 이름을 더하려면 먼저
    /// `src/lib/aiaOnboarding.ts`의 `fillTemplate`이 그 값을 넣게 하고 이 단언을 고친다.
    #[test]
    fn nothing_is_derived_until_the_renderer_supplies_it() {
        assert!(
            DERIVED_TEMPLATE_VARIABLES.is_empty(),
            "치환하는 쪽이 공급하지 않는 이름이 목록에 있습니다: {DERIVED_TEMPLATE_VARIABLES:?}"
        );
    }

    /// 카드가 받은 값은 어딘가에 쓰여야 한다. 쓰이지 않는 칸은 사용자가 고른 것이 조용히
    /// 사라지는 자리다 — 등록 폴더를 고르게 해 놓고 지시문에 싣지 않은 적이 있다.
    #[test]
    fn every_bundled_field_is_used_somewhere() {
        for card in bundled().cards {
            let mut used: BTreeSet<String> = BTreeSet::new();
            let mut texts: Vec<&str> = Vec::new();
            for action in &card.actions {
                if let Some(condition) = action.condition() {
                    used.insert(condition.field.clone());
                }
                match action {
                    AiaOnboardingAction::CreateDirectory { path, .. } => texts.push(path),
                    AiaOnboardingAction::CreateScheduledRequest { schedule, .. } => {
                        texts.push(&schedule.name)
                    }
                    AiaOnboardingAction::RegisterWorkflow { workflow, .. } => {
                        texts.extend([
                            workflow.id.as_str(),
                            workflow.display_name.as_str(),
                            workflow.description.as_str(),
                            workflow.message.as_str(),
                        ]);
                        used.insert(workflow.project_path_field.clone());
                    }
                }
            }
            used.extend(texts.into_iter().flat_map(template_variables));
            for step in &card.steps {
                for field in &step.fields {
                    if let Some(condition) = &field.visible_when {
                        used.insert(condition.field.clone());
                    }
                }
            }
            for step in &card.steps {
                for field in &step.fields {
                    assert!(
                        used.contains(&field.key),
                        "{} 카드의 {} 칸이 어디에도 쓰이지 않습니다",
                        card.id,
                        field.key
                    );
                }
            }
        }
    }

    /// 문구는 한국어 한 줄로 적어도 되고 ko/en 쌍으로 적어도 된다.
    #[test]
    fn localized_text_accepts_a_bare_string_and_a_pair() {
        let plain: LocalizedText = serde_json::from_value(json!("제목")).expect("plain");
        assert_eq!(plain.ko, "제목");
        assert_eq!(plain.en, None);

        let pair: LocalizedText =
            serde_json::from_value(json!({ "ko": "제목", "en": "Title" })).expect("pair");
        assert_eq!(pair.en.as_deref(), Some("Title"));
    }
}
