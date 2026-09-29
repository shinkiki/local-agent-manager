use serde::{Deserialize, Serialize};

use crate::chat::{ChatApprovalMode, ChatMode, ReasoningEffort};

/// 저장본·요청 본문에서 오가는 문자열 표현이 하나뿐인 enum의 `as_str`·`Display`·
/// `FromStr` 세 벌을 변이-문자열 표 하나에서 만든다. 세 벌이 각자 적혀 있으면 값을
/// 하나 늘릴 때 한 곳을 빠뜨려도 컴파일은 지나가고 해석만 조용히 어긋난다.
/// `trimmed`를 붙이면 해석 전에 앞뒤 공백을 버린다(붙이지 않으면 정확히 일치해야 한다).
/// `choices`는 `trimmed`에 더해 해석 실패 문구 뒤에 "a|b|c 중 하나를 쓰세요"를 붙인다 —
/// 그 목록을 같은 표에서 뽑으므로 값을 늘렸을 때 안내 문구만 낡는 일이 없다. 같은 목록을
/// `WIRE_CHOICES` 상수로도 내보내므로, 화면이 고를 수 있는 값을 나열해야 하는 자리도
/// 변이를 손으로 다시 적지 않는다.
/// 문자열을 되읽을 일이 없는 enum은 `display_only`를 붙여 `as_str`·`Display` 두 벌만 만든다.
///
/// 표의 오른쪽은 `"정규값"` 또는 `"정규값" | "별칭" | ...`이다. 별칭은 해석할 때만 받아
/// 주고 `as_str`과 선택지 안내에는 정규값만 나온다 — 같은 값을 snake_case로도 받던
/// 옛 요청 본문을 표 한 줄로 흡수하기 위한 자리다.
fn wire_exact(value: &str) -> &str {
    value
}

/// 표에 없는 문자열을 오류로 바꾼다. `raw`는 받은 그대로, `normalized`는 표와 맞춰 본
/// 값이다 — 어느 쪽을 문구에 싣는지는 각 만듦새가 정한다.
pub(crate) fn wire_unknown(
    message: &str,
    raw: &str,
    _normalized: &str,
    _choices: &[&str],
) -> crate::CoreError {
    crate::CoreError::InvalidInput(format!("{message}: {raw}"))
}

/// 선택지까지 알리는 만듦새. 공백을 버린 값을 되돌려 주는 편이 "무엇을 보냈길래
/// 거절됐는지"를 더 정확히 말해 준다.
pub(crate) fn wire_unknown_with_choices(
    message: &str,
    _raw: &str,
    normalized: &str,
    choices: &[&str],
) -> crate::CoreError {
    crate::CoreError::InvalidInput(format!(
        "{message}: {normalized}. {} 중 하나를 쓰세요",
        choices.join("|")
    ))
}

macro_rules! wire_enum {
    (display_only $name:ident, { $($variant:ident => $wire:literal,)+ }) => {
        wire_enum!(@names $name, { $($variant => $wire,)+ });
    };
    (choices $name:ident, $message:literal, { $($variant:ident => $wire:literal $(| $alias:literal)*,)+ }) => {
        wire_enum!(
            @build $name, $message, str::trim, crate::domain::wire_unknown_with_choices,
            { $($variant => $wire $(| $alias)*,)+ }
        );

        impl $name {
            /// 이 enum이 받아들이는 정규값 전부. 해석 실패 안내가 쓰는 목록과 같은 표에서
            /// 나오므로, 화면 선택지를 이 값으로 채우면 변이를 늘렸을 때 목록만 낡는 일이
            /// 없다. 별칭은 들어가지 않는다 — 새로 고를 수 있는 값은 정규값뿐이다.
            pub(crate) const WIRE_CHOICES: &'static [&'static str] = &[$($wire),+];
        }
    };
    (trimmed $name:ident, $message:literal, { $($variant:ident => $wire:literal $(| $alias:literal)*,)+ }) => {
        wire_enum!(
            @build $name, $message, str::trim, crate::domain::wire_unknown,
            { $($variant => $wire $(| $alias)*,)+ }
        );
    };
    ($name:ident, $message:literal, { $($variant:ident => $wire:literal $(| $alias:literal)*,)+ }) => {
        wire_enum!(
            @build $name, $message, crate::domain::wire_exact, crate::domain::wire_unknown,
            { $($variant => $wire $(| $alias)*,)+ }
        );
    };
    (@build $name:ident, $message:literal, $normalize:path, $fail:path, { $($variant:ident => $wire:literal $(| $alias:literal)*,)+ }) => {
        wire_enum!(@names $name, { $($variant => $wire,)+ });

        impl std::str::FromStr for $name {
            type Err = crate::CoreError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                let normalize: fn(&str) -> &str = $normalize;
                let fail: fn(&str, &str, &str, &[&str]) -> crate::CoreError = $fail;
                let normalized = normalize(s);
                match normalized {
                    $($wire $(| $alias)* => Ok(Self::$variant),)+
                    _ => Err(fail($message, s, normalized, &[$($wire),+])),
                }
            }
        }
    };
    (@names $name:ident, { $($variant:ident => $wire:literal,)+ }) => {
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

/// 같은 크레이트의 다른 모듈도 이 표 한 벌을 쓰도록 내보낸다.
pub(crate) use wire_enum;

/// 공급자를 실제로 실행하는 하네스. 공급자 하나가 곧 실행 방식 하나였던 동안에는
/// 실행 배선이 `ProviderId`를 그대로 보고 갈라도 뜻이 같았다. 한 하네스를 여러 공급자가
/// 나눠 쓰기 시작하면 그 둘이 갈라지므로, "누구의 사용량으로 어느 계정에 붙는가"(공급자)와
/// "어떤 프로세스 규약으로 말하는가"(하네스)를 분리해 둔다.
///
/// 실행 규약(기동·턴 전송·중간 전달·승인·중단)을 가르는 자리는 `ProviderId`가 아니라
/// 이 값을 봐야 한다. 계정·사용량·표시 이름처럼 공급자 정체성에 속하는 자리는 그대로
/// `ProviderId`를 본다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Harness {
    Claude,
    Codex,
    Antigravity,
    /// ACP(Agent Client Protocol)를 말하는 하네스. 지금은 OpenCode가 그 구현이다.
    /// 규격이 공개돼 있어 다른 구현으로 갈아끼울 자리가 여기다.
    OpenCode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderId {
    Claude,
    Codex,
    Antigravity,
    /// 사용자가 직접 띄운 OpenAI 호환 서버의 로컬 모델. 계정도 사용량 한도도 없고,
    /// 실행은 Codex 하네스를 그대로 빌려 쓴다.
    Local,
}

impl ProviderId {
    pub const ALL: [Self; 4] = [Self::Claude, Self::Codex, Self::Antigravity, Self::Local];

    /// 시스템 에이전트로 고를 수 있는 공급자인지. 시스템 에이전트는 AIA 런타임을 겸하고
    /// AIA는 aia_system MCP로만 시스템을 조작하는데, Antigravity CLI에는 실행 단위 MCP
    /// 설정 플래그가 없어 그 인터페이스를 붙일 수 없다. 그래서 선택 대상에서 제외한다.
    pub fn can_run_system_agent(self) -> bool {
        matches!(self, Self::Claude | Self::Codex)
    }

    /// 앱이 실행마다 MCP 서버를 붙여 줄 수 있는 공급자인지.
    ///
    /// 시스템 에이전트로 돌 수 있느냐와는 다른 물음이다. 로컬은 시스템 에이전트가 아니지만
    /// ACP `session/new`에 서버를 실어 보낼 수 있고, Antigravity는 그 자리가 없어 사용자가
    /// CLI 전역 설정에 한 번 등록해 두는 길(`externalMcpConfig`)을 쓴다. 전자를 그대로
    /// 후자의 답으로 쓰던 탓에 로컬 채팅에는 외부 플러그인이 한 번도 붙지 않았다.
    pub fn supports_run_scoped_mcp(self) -> bool {
        matches!(self, Self::Claude | Self::Codex | Self::Local)
    }

    /// 계정 레지스트리가 이 공급자의 계정을 관리하는지. Antigravity는 레지스트리에
    /// 공급자 항목이 없어 계정 조회·전환 경로가 이 공급자를 거부하고, 실행은 계정
    /// 미귀속으로 진행한다.
    ///
    /// 자격증명을 가를 수 없어서가 아니다. `HOME`을 계정별로 주면 격리가 되고 그 길은
    /// `credential_profiles`에 있다(`AGENTS.md` C12). 남은 것은 계정 등록·로그인·사용량
    /// 귀속이며, 이 값은 그것이 갖춰질 때 함께 참이 된다.
    pub fn manages_accounts(self) -> bool {
        matches!(self, Self::Claude | Self::Codex | Self::Antigravity)
    }

    /// 이 공급자의 사용량에 공급자 쪽 한도가 걸리는지. 구독 창·리셋 시각·퍼센트가 있는
    /// 공급자만 참이다. 거짓인 공급자는 사용량 창 자체가 없어 페이싱·예산·상태바 계산에서
    /// 빼야 하며, 0%로 취급해 "여유가 가장 많은 계정"으로 뽑히게 두면 안 된다.
    pub fn has_usage_quota(self) -> bool {
        matches!(self, Self::Claude | Self::Codex | Self::Antigravity)
    }

    /// 이 공급자를 실행하는 하네스. 실행 규약을 가르는 자리는 공급자가 아니라 이 값을 본다.
    pub fn harness(self) -> Harness {
        match self {
            Self::Claude => Harness::Claude,
            Self::Codex => Harness::Codex,
            Self::Antigravity => Harness::Antigravity,
            // 로컬 모델은 ACP 하네스로 돈다. Codex를 쓰지 않는 이유는 도구를 줄일 수
            // 없어서다 — 26개를 그대로 받은 로컬 모델은 없는 도구 이름을 지어낸다.
            Self::Local => Harness::OpenCode,
        }
    }

    /// 이 공급자의 일반 채팅이 단계 계획 고리(`plan.rs`)로 도는가.
    ///
    /// 고리로 도는 공급자는 갈림길을 도구로 받는다(9.7). 그래서 결정정책은 AIA 프로필만의
    /// 값이 아니라 그 일반 채팅에도 있어야 하는 값이 된다 — 정책이 없으면 갈림길에서
    /// 멈출지 스스로 고를지가 정해지지 않는다. 하네스로 판단하는 것은 고리가 하네스의
    /// 성질이기 때문이다: ACP 하네스를 다른 구현으로 갈아끼워도 고리는 그대로다.
    pub fn plans_in_steps(self) -> bool {
        matches!(self.harness(), Harness::OpenCode)
    }
}

wire_enum!(ProviderId, "알 수 없는 공급자입니다", {
    Claude => "claude",
    Codex => "codex",
    Antigravity => "antigravity",
    Local => "local",
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedResource {
    pub detected: bool,
    pub path: Option<String>,
}

impl DetectedResource {
    pub fn missing() -> Self {
        Self {
            detected: false,
            path: None,
        }
    }

    pub fn found(path: impl Into<String>) -> Self {
        Self {
            detected: true,
            path: Some(path.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: ProviderId,
    pub display_name: String,
    pub cli: DetectedResource,
    pub history: DetectedResource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub schema_version: u32,
    pub platform: String,
    pub architecture: String,
    pub providers: Vec<ProviderStatus>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl TokenUsage {
    pub fn total(self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLink {
    pub source: ProviderId,
    pub id: String,
}

/// 채팅을 누가 시작했는지.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatOriginKind {
    /// 시스템 워크플로 단계(`start_chat`)가 띄웠다. 반복 요청이 트리거면 `schedule_id`가 있다.
    Workflow,
    /// 반복 요청의 일반 채팅 회차.
    Schedule,
    /// AIA 대화가 시스템 인터페이스로 띄웠다.
    Aia,
    /// 사용자가 화면에서 직접 시작했다.
    User,
}

wire_enum!(trimmed ChatOriginKind, "알 수 없는 채팅 출처 종류입니다", {
    Workflow => "workflow",
    Schedule => "schedule",
    Aia => "aia",
    User => "user",
});

/// 채팅의 출처. 클라이언트가 보낼 수 없고(`ChatStartRequest.origin`은 역직렬화하지 않음)
/// 워크플로 실행기·스케줄러·디스패처가 실행 컨텍스트에서 채운다. 사용량 페이싱이 어느
/// 소비자(반복 요청)의 런타임인지 알아 회차별 소비를 귀속하고 지난 회차 정리 대상을 고른다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatOrigin {
    pub kind: ChatOriginKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// 사용량 페이싱 소비자 id. 반복 요청이 있으면 그 id, 없으면 워크플로 id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consumer_id: Option<String>,
}

impl ChatOrigin {
    /// 워크플로·반복 요청 없이 직접 시작된 채팅의 출처.
    pub fn direct(kind: ChatOriginKind) -> Self {
        Self {
            kind,
            workflow_id: None,
            execution_id: None,
            schedule_id: None,
            run_id: None,
            consumer_id: None,
        }
    }
}

/// 긴 답변 본문 안의 한 지점. 스크롤 픽셀이 아니라 "어느 메시지의 어느 원문 줄"로
/// 적는다 — 창 폭이 바뀌어도, 같은 대화를 라이브 채팅이 아니라 세션 원문으로 다시
/// 읽어도 본문이 같으면 같은 문단에 선다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingAnchor {
    /// 어느 메시지인가. 라이브 채팅은 `live:<엔트리 id>:<kind>`, 세션 원문은 `item:<index>`.
    pub message_key: String,
    /// 그 메시지 본문 안 마크다운 블록의 원문 줄 번호. 블록을 짚지 못했으면 `None`.
    pub markdown_line: Option<u32>,
}

/// 사용자가 남긴 읽던 자리 하나. 열쇠가 세션이므로 같은 대화를 채팅·세션 상세·AIA
/// 어디서 열어도 같은 목록이 나온다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionBookmark {
    pub id: String,
    /// 사용자가 붙인 이름. 비어 있으면 화면이 `snippet`을 대신 보여준다.
    pub label: String,
    /// 앵커 블록 앞머리. 이름이 없을 때의 표시이자, 메시지 열쇠가 달라진 뒤
    /// (라이브에서 남기고 원문에서 다시 여는 경우) 같은 자리를 되찾는 마지막 단서다.
    pub snippet: String,
    pub anchor: ReadingAnchor,
    pub created_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub favorite: bool,
    pub hidden: bool,
    pub note: Option<String>,
    pub custom_title: Option<String>,
    #[serde(default)]
    pub folder_ids: Vec<String>,
    /// 이 세션이 마지막으로 실행된 추론 수준. 이어가기 때 기본값으로 쓴다.
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
    /// 이 세션이 마지막으로 실행된 요청 모드. 이어가기 때 기본값으로 쓴다.
    #[serde(default)]
    pub mode: Option<ChatMode>,
    /// 이 세션이 마지막으로 실행된 승인 처리. 이어가기 때 기본값으로 쓴다.
    #[serde(default)]
    pub approval_mode: Option<ChatApprovalMode>,
    /// Agent Manager에서 새 세션을 만들 때 사용한 계정. 이후 활성계정 전환과 무관하다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_account_id: Option<String>,
    /// 이 세션이 마지막으로 실행된 계정. 실행마다 갱신되며 표시와 사용량 추적에
    /// 쓴다. 이어가기 기준은 아니다 — 이어가기는 `pinned_account_id`가 있으면 그
    /// 계정, 없으면 현재 활성 계정을 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_account_id: Option<String>,
    /// 사용자가 이 세션의 실행 계정으로 고정한 값. 설정되어 있으면 활성 계정보다
    /// 우선해 이 계정으로 이어가고, 한도 페일오버도 이 세션을 다른 계정으로 옮기지
    /// 않는다. 실행으로 자동 채워지지 않는 점이 `bound_account_id`와 다르다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_account_id: Option<String>,
    /// 이 세션이 마지막으로 쓴 로컬 LLM 연결 id(M7 7.3). 로컬 공급자 세션에만 있고,
    /// 값이 없는 옛 저장물은 기본 연결로 읽는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_connection_id: Option<String>,
    /// 다른 공급자에서 이 세션으로 인계한 원본. 공급자 세션 자체를 바꾸지 않고
    /// Agent Manager 메타데이터에서만 관계를 보존한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_origin: Option<SessionLink>,
    /// 이 세션에서 다른 공급자로 인계해 만든 세션들. 한 원본에서 여러 번 인계할 수 있다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub handoff_targets: Vec<SessionLink>,
    /// 이 세션을 시작한 출처(워크플로 실행·반복 요청 등). 최초 한 번만 기록한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ChatOrigin>,
    /// 이 대화에 남긴 읽던 자리. 만든 순서를 그대로 둔다 — 목록에서 시간순으로 읽힌다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bookmarks: Vec<SessionBookmark>,
}

/// 세션 정리폴더. `parent_id`로 상하위 트리를 이루며, 목록은 항상 트리 순서(부모 →
/// 자식)로 나간다. `depth`·`session_count`·`total_session_count`는 저장본이 아니라
/// 조회 시점에 계산한 값이다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFolder {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// 숨긴 폴더. 이 폴더와 하위 폴더에만 담긴 세션은 전체 목록과 상위 폴더 집계에서
    /// 빠지고, 이 폴더를 직접 골랐을 때만 보인다. 폴더 자체는 목록에 남아 있으므로
    /// 세션을 지우거나 배정을 푸는 것과 다르다.
    #[serde(default)]
    pub hidden: bool,
    /// 최상위는 0, 자식은 부모+1. 트리 들여쓰기 기준이다.
    #[serde(default)]
    pub depth: usize,
    /// 이 폴더에 직접 담긴 세션 수.
    #[serde(default)]
    pub session_count: usize,
    /// 이 폴더와 숨기지 않은 하위 폴더에 담긴 세션 수(같은 세션은 한 번만 센다).
    /// 숨긴 하위 폴더는 그 하위 트리째 빠진다.
    #[serde(default)]
    pub total_session_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub source: ProviderId,
    pub id: String,
    pub title: String,
    pub source_title: Option<String>,
    pub project: Option<String>,
    pub cwd: Option<String>,
    pub started_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub message_count: Option<u64>,
    pub token_total: Option<u64>,
    pub token_usage: Option<TokenUsage>,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub is_subagent: bool,
    /// AIA 전용 작업공간(`<app data>/aia-workspace`)에서 오간 대화. 카탈로그 저장본이
    /// 아니라 스냅샷을 만들 때 앱 데이터 경로로 다시 판정하므로, 저장본에 남은 값은 읽지 않는다.
    #[serde(default)]
    pub aia_workspace: bool,
    /// 작업 경로 없이 시작해 앱이 마련한 기본 작업공간(`<app data>/default-workspace`)에서
    /// 오간 대화. `aia_workspace`처럼 스냅샷마다 앱 데이터 경로로 다시 판정한다. 목록에는
    /// 남기되 새 채팅의 프로젝트 후보에서는 뺀다 — 사용자가 고른 경로가 아니다.
    #[serde(default)]
    pub default_workspace: bool,
    pub archived: bool,
    pub readable: bool,
    pub size_bytes: Option<u64>,
    pub file_path: String,
    pub meta: SessionMeta,
    /// 마지막 요청이 한도 초과나 오류로 끝났으면 그 실패. 뒤에 새 요청이 오가면 사라지고,
    /// 사용자 중단은 실패로 치지 않는다. 공급자 원문(Claude 합성 오류 응답, Codex
    /// `task_complete.error`)과 Agent Manager가 따로 남긴 실행 실패를 함께 본다.
    #[serde(default)]
    pub last_failure: Option<SessionLastFailure>,
}

/// 세션 마지막 실패의 갈래. 목록 태그의 설명과 색을 가른다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionFailureKind {
    /// 사용량·레이트 한도에 걸려 응답을 받지 못했다.
    UsageLimit,
    /// 인증 만료·서버 과부하·거절 등 그 밖의 오류로 응답이 끝나지 못했다.
    Error,
}

impl SessionFailureKind {
    /// 실패 문구가 한도 안내인지로 갈래를 정한다.
    pub fn classify(message: &str) -> Self {
        if crate::chat::is_usage_limit_message(message) {
            Self::UsageLimit
        } else {
            Self::Error
        }
    }
}

wire_enum!(trimmed SessionFailureKind, "알 수 없는 세션 실패 갈래입니다", {
    UsageLimit => "usageLimit",
    Error => "error",
});

/// 세션의 마지막 요청이 남긴 실패. 목록 태그에 쓰이므로 문구는 짧게 잘라 담는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLastFailure {
    pub kind: SessionFailureKind,
    pub occurred_at: Option<i64>,
    pub message: String,
}

impl SessionLastFailure {
    /// 태그 설명에 담을 최대 글자 수. 한도 안내 한 문장이 들어가는 정도다.
    pub const MAX_MESSAGE_CHARS: usize = 240;

    pub fn new(message: &str, occurred_at: Option<i64>) -> Self {
        let message = message.trim();
        let mut capped = message
            .chars()
            .take(Self::MAX_MESSAGE_CHARS)
            .collect::<String>();
        if capped.chars().count() < message.chars().count() {
            capped.push('…');
        }
        Self {
            kind: SessionFailureKind::classify(message),
            occurred_at,
            message: capped,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCounts {
    pub claude: usize,
    pub codex: usize,
    pub antigravity: usize,
    pub local: usize,
}

impl SourceCounts {
    pub fn increment(&mut self, source: ProviderId) {
        match source {
            ProviderId::Claude => self.claude += 1,
            ProviderId::Codex => self.codex += 1,
            ProviderId::Antigravity => self.antigravity += 1,
            ProviderId::Local => self.local += 1,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTotals {
    pub claude: u64,
    pub codex: u64,
    pub antigravity: u64,
    pub local: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCount {
    pub model: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCount {
    pub name: String,
    pub path: String,
    pub count: usize,
}

/// 세션 카탈로그에서 확인한 프로젝트 하나와 이 장치의 활성 여부.
///
/// 프로젝트는 등록 목록이 아니라 세션 `cwd`에서 역산되므로, 설정 화면은 이 항목으로
/// 목록을 그리고 `set_project_active`로 제외/복귀를 결정한다. 세션이 모두 사라진
/// 제외 프로젝트도 `session_count: 0`으로 남겨 다시 켤 수 있게 한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRegistryEntry {
    /// 정규 절대경로. 디렉터리가 사라져 정규화할 수 없으면 세션에 남은 원문.
    pub path: String,
    pub name: String,
    /// 보관함(hidden)이 아닌 세션 수.
    pub session_count: usize,
    pub hidden_session_count: usize,
    pub updated_at: Option<i64>,
    pub providers: Vec<ProviderId>,
    /// 설정에서 제외하지 않은 프로젝트. 제외 프로젝트의 세션은 스냅샷에서 빠진다.
    pub active: bool,
    /// 처음 감지된 뒤 아직 활성 유지/제외를 결정하지 않은 프로젝트.
    pub pending: bool,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyCount {
    pub week_start: i64,
    pub claude: usize,
    pub codex: usize,
    pub antigravity: usize,
    pub local: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardStats {
    pub session_count: usize,
    pub sessions_by_source: SourceCounts,
    pub tokens: SourceTotals,
    pub disk: SourceTotals,
    pub skill_count: usize,
    pub agent_count: usize,
    pub models: Vec<ModelCount>,
    pub top_projects: Vec<ProjectCount>,
    pub weekly: Vec<WeeklyCount>,
    pub recent: Vec<SessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub source: ProviderId,
    pub scope: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub directory: String,
    pub origin: Option<String>,
    /// 설정된 리소스 저장소의 `skills/<키>`에 원본이 있는 설치본인지. 보관 원본에서
    /// 배포된 스킬을 공급자별 스킬과 따로 묶어 보여줄 때 쓴다.
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub is_directory: bool,
    pub children: Vec<FileNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub skill: SkillSummary,
    pub body: String,
    pub files: Vec<FileNode>,
}

/// 공급자와 무관한 공통 스킬 원본 하나. `<resource repository>/skills/<디렉터리>/SKILL.md`가
/// 원본이고, 공급자 스킬 루트는 이 원본을 링크하거나 복사해 노출한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonSkillSource {
    pub id: String,
    pub key: String,
    pub name: String,
    pub description: String,
    pub path: String,
    pub directory: String,
    /// 스킬 디렉터리 전체 내용을 요약한 지문. 공급자 사본이 갈라졌는지 판정하는
    /// 기준이며, 상대 경로와 실행 권한까지 포함해 계산한다.
    pub content_digest: String,
    pub file_count: usize,
    pub total_bytes: u64,
    /// 원본 내용을 마지막으로 고친 시각(밀리초). 갈라진 설치본이 원본보다 앞선
    /// 수정인지 뒤처진 사본인지 가르는 기준이다.
    pub modified_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonSkillDetail {
    pub source: CommonSkillSource,
    pub body: String,
    pub files: Vec<FileNode>,
}

/// 공통 원본 하나의 변경 감지용 최소 요약. AIA 즉시 트리거가 짧은 주기로 읽으므로
/// 공급자 설치본 정보 없이 키·표시 이름·내용 지문만 담는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonSkillDigest {
    pub key: String,
    pub name: String,
    pub content_digest: String,
}

/// 공통 원본이 한 공급자에서 어떻게 노출되고 있는지.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillProviderStatus {
    /// 공급자 스킬 디렉터리가 공통 원본으로 해석된다(심볼릭 링크·하드 링크·동일 경로).
    Linked,
    /// 공급자가 독립 사본을 가지고 있다. 공통 원본과 내용이 갈릴 수 있다.
    Copy,
    /// 공급자가 사용자 스킬 루트를 가지고 있으나 이 스킬이 없다.
    Missing,
    /// 공급자가 사용자 스킬 루트를 제공하지 않아 공통 원본을 노출할 수 없다.
    Unsupported,
}

wire_enum!(trimmed SkillProviderStatus, "알 수 없는 스킬 공급자 상태입니다", {
    Linked => "linked",
    Copy => "copy",
    Missing => "missing",
    Unsupported => "unsupported",
});

/// 갈라진 설치본이 원본의 어느 쪽에 있는지. 지문 비교는 "다르다"까지만 말해 주고,
/// 뒤처진 사본과 손으로 고친 사본을 한 이름으로 부르면 사용자가 방향을 반대로 읽는다 —
/// 뒤처진 쪽에 "외부 수정"이라 써 두면 그 사본을 원본으로 채택해 최신 내용을 덮는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillDivergence {
    /// 설치본이 원본보다 오래됐다. 원본을 다시 배포하면 맞는다.
    Behind,
    /// 설치본이 원본보다 나중에 고쳐졌다. 채택할지 버릴지 사용자가 정해야 한다.
    Edited,
    /// 어느 한쪽의 수정 시각을 읽지 못해 방향을 가릴 수 없다.
    Unknown,
}

/// 한 에이전트의 위치별 설치본. 개인 루트와 각 프로젝트를 구분한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallView {
    /// "personal" | "project" | "plugin" | "system" | "builtin"
    pub scope: String,
    /// 프로젝트 설치본이면 그 프로젝트 루트 경로.
    pub project_path: Option<String>,
    /// 표시용 프로젝트 이름.
    pub project_name: Option<String>,
    pub skill_id: String,
    pub directory: String,
    pub content_digest: Option<String>,
    /// 보관 원본과 내용이 다른 상태.
    pub divergent: bool,
    /// 갈라졌다면 어느 방향인지. 원본과 같으면 없다.
    pub divergence: Option<SkillDivergence>,
    /// 설치본 내용을 마지막으로 고친 시각(밀리초).
    pub modified_at_ms: Option<i64>,
    pub read_only: bool,
}

/// 보관 시점에 기록한 출처.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOriginView {
    pub provider: ProviderId,
    /// "personal" | "project"
    pub scope: String,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
    pub archived_at_ms: Option<i64>,
}

/// 배포 가능한 위치 하나. 개인 루트 또는 등록된 프로젝트.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProjectView {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProviderState {
    pub provider: ProviderId,
    pub status: SkillProviderStatus,
    pub scope: Option<String>,
    pub origin: Option<String>,
    /// 설치본의 `SkillSummary.id`. 상세 조회와 번역 레코드가 이 값을 쓴다.
    pub skill_id: Option<String>,
    pub path: Option<String>,
    pub directory: Option<String>,
    /// 아직 노출되지 않은 경우 공통 원본을 놓을 공급자 디렉터리.
    pub target_directory: Option<String>,
    pub read_only: bool,
    /// 설치본 내용 지문. 심볼릭 링크로 공통 원본을 그대로 보는 경우 원본과 같은 값이다.
    pub content_digest: Option<String>,
    /// 공통 원본과 내용 지문이 달라 사본이 갈라진 상태. 게시본이 원본보다 오래되었거나
    /// 공급자 쪽에서 직접 편집된 경우를 모두 포함한다.
    pub divergent: bool,
    /// 갈라졌다면 어느 방향인지. 두 경우는 조치가 반대라 화면·AIA가 구분해야 한다.
    pub divergence: Option<SkillDivergence>,
    /// 설치본 내용을 마지막으로 고친 시각(밀리초).
    pub modified_at_ms: Option<i64>,
    pub note: Option<String>,
    /// 이 에이전트의 위치별 설치본 전체. 개인 루트와 프로젝트를 모두 담는다.
    pub installs: Vec<SkillInstallView>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillOriginKind {
    /// 공통 루트에 원본이 있다.
    Common,
    /// 공통 루트에는 없고 공급자 설치본만 있다.
    Provider,
}

wire_enum!(trimmed SkillOriginKind, "알 수 없는 스킬 원본 종류입니다", {
    Common => "common",
    Provider => "provider",
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLibraryEntry {
    pub key: String,
    /// 생성 시각(밀리초). 보관 원본 디렉터리 생성 시각을 우선하고, 없으면
    /// 설치본 중 가장 이른 생성 시각이다. 파일시스템이 지원하지 않으면 없다.
    pub created_at_ms: Option<i64>,
    pub name: String,
    pub description: String,
    pub origin_kind: SkillOriginKind,
    pub common: Option<CommonSkillSource>,
    /// 공통 원본으로 관리할 수 있는 사용자 스킬인지. 공급자 내장·플러그인 전용
    /// 스킬은 읽기 전용이라 전파 대상이 아니다.
    pub managed: bool,
    /// 전파할 때 쓸 디렉터리 이름. 공통 원본 디렉터리 이름을 그대로 유지한다.
    pub directory_name: String,
    /// 보관 시 기록한 출처. 미보관이거나 메타가 없으면 없다(개인 취급).
    pub origin: Option<SkillOriginView>,
    /// 외부 수정 감지 시 자동 동기화 여부.
    pub auto_sync: bool,
    /// 메타에 선언된 base 지원 OS. 비어 있으면 모든 OS에서 portable로 본다.
    pub platforms: Vec<crate::HostPlatform>,
    /// 현재 장치에서 base 또는 OS overlay를 활성화할 수 있는지.
    pub active: bool,
    /// 현재 OS용 base/overlay가 없어 AIA 마이그레이션이 필요한지.
    pub migration_required: bool,
    /// 현재 OS에 적용되는 overlay 상대 경로.
    pub active_variant: Option<String>,
    pub providers: Vec<SkillProviderState>,
    pub linked_count: usize,
    pub installed_count: usize,
    pub missing_count: usize,
}

/// 한 루트를 읽지 못한 사실만 남기는 격리된 오류. 한 공급자의 실패가 다른
/// 공급자 스킬 관리를 막지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLibraryIssue {
    pub provider: Option<ProviderId>,
    pub path: String,
    pub message: String,
}

/// 공급자 어댑터 계약을 사용자에게 그대로 보여주기 위한 요약.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAdapterView {
    pub provider: ProviderId,
    pub display_name: String,
    /// 공통 원본을 노출할 수 있는 사용자 스킬 루트. 없으면 노출 미지원.
    pub installable_root: Option<String>,
    pub roots: Vec<SkillAdapterRootView>,
    pub supports_common_source: bool,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAdapterRootView {
    pub scope: String,
    pub path: String,
    pub present: bool,
    pub read_only: bool,
    pub installable: bool,
}

/// 공통 원본과 공급자 노출 상태를 한 번에 담은 스킬 라이브러리.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLibrary {
    pub schema_version: u32,
    pub common_root: String,
    pub common_root_present: bool,
    pub current_platform: crate::HostPlatform,
    pub entries: Vec<SkillLibraryEntry>,
    pub adapters: Vec<SkillAdapterView>,
    /// 배포 위치로 선택할 수 있는 등록된 프로젝트 목록.
    pub projects: Vec<SkillProjectView>,
    pub issues: Vec<SkillLibraryIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,
    pub model: Option<String>,
    pub max_turns: Option<u64>,
    pub permission_mode: Option<String>,
    pub skills: Vec<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetail {
    pub definition: AgentDefinition,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSummary {
    pub conversation_id: String,
    pub root_name: String,
    pub name: String,
    pub artifact_type: Option<String>,
    pub summary: Option<String>,
    pub updated_at: Option<i64>,
    pub version: Option<u64>,
    pub versions: Vec<u64>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactGroup {
    pub conversation_id: String,
    pub root_name: String,
    pub title: Option<String>,
    pub readable: bool,
    pub artifacts: Vec<ArtifactSummary>,
    pub image_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDetail {
    pub artifact: ArtifactSummary,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Context {
        label: String,
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolUse {
        name: String,
        input_json: String,
    },
    ToolResult {
        text: String,
        is_error: bool,
    },
    /// 응답이 끝나지 못한 지점. 공급자 원문이 남긴 오류 응답과, 원문에 답이 남지 않아
    /// Agent Manager가 따로 기록한 실행 실패가 같은 모양으로 대화 흐름에 들어간다.
    RuntimeFailure {
        status: String,
        code: String,
        text: String,
    },
    /// 대화 기록에 base64로 박혀 있는 이미지. 목록 응답에는 위치와 크기만 담고
    /// 실제 바이트는 필요할 때 해당 줄에서 다시 읽는다.
    Image(Box<TranscriptImageBlock>),
    SessionInfo(Box<SessionInfoBlock>),
    Raw {
        json: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptImageBlock {
    pub media_type: String,
    pub byte_size: usize,
    /// 이미지를 담은 기록 줄의 파일 시작 바이트.
    pub source_offset: usize,
    /// 그 줄 JSON 안에서 이미지 조각을 가리키는 JSON 포인터.
    pub source_pointer: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfoBlock {
    pub id: Option<String>,
    pub cwd: Option<String>,
    pub originator: Option<String>,
    pub cli_version: Option<String>,
    pub source: Option<String>,
    pub model_provider: Option<String>,
    pub thread_source: Option<String>,
    pub history_mode: Option<String>,
    pub context_window_id: Option<String>,
    pub tool_count: usize,
    pub raw_json: String,
    pub raw_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptItem {
    pub index: usize,
    pub role: String,
    pub timestamp: Option<i64>,
    pub model: Option<String>,
    pub type_label: Option<String>,
    pub blocks: Vec<ContentBlock>,
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session: SessionSummary,
    /// 공급자 원문에 답이 남지 않은 Agent Manager 관리 실행 실패도 여기에 함께 들어간다.
    /// 공급자 파일은 수정하지 않고 앱 소유 저장소의 기록을 일어난 시각 위치에 끼운다(G1, G2, G7).
    pub transcript: Vec<TranscriptItem>,
    pub truncated: bool,
    pub skipped_lines: usize,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRuntimeFailure {
    pub id: String,
    pub turn_id: String,
    pub status: String,
    pub code: String,
    pub message: String,
    pub occurred_at: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionTranscriptLimit {
    Latest100,
    #[default]
    Latest500,
    Latest1000,
    All,
}

impl SessionTranscriptLimit {
    pub fn max_items(self) -> Option<usize> {
        match self {
            Self::Latest100 => Some(100),
            Self::Latest500 => Some(500),
            Self::Latest1000 => Some(1_000),
            Self::All => None,
        }
    }
}

wire_enum!(trimmed SessionTranscriptLimit, "알 수 없는 전사 행수 상한입니다", {
    Latest100 => "latest100",
    Latest500 => "latest500",
    Latest1000 => "latest1000",
    All => "all",
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageItem {
    pub id: String,
    pub label: String,
    pub description: String,
    pub size_bytes: u64,
    pub file_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupplementStorageStats {
    pub turn_count: usize,
    pub session_count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    pub source_total_bytes: u64,
    pub manager_total_bytes: u64,
    pub total_bytes: u64,
    pub source_items: Vec<StorageUsageItem>,
    pub manager_items: Vec<StorageUsageItem>,
    pub supplements: SupplementStorageStats,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerSnapshot {
    pub schema_version: u32,
    pub session_catalog_revision: u64,
    pub resource_catalog_revision: u64,
    pub status: AppStatus,
    pub dashboard: DashboardStats,
    pub sessions: Vec<SessionSummary>,
    pub folders: Vec<SessionFolder>,
    pub skills: Vec<SkillSummary>,
    pub agents: Vec<AgentDefinition>,
    pub artifacts: Vec<ArtifactGroup>,
    /// 처음 감지돼 활성 유지/제외 결정을 기다리는 프로젝트. 화면이 알림으로 띄운다.
    /// 전체 프로젝트 목록은 폴링 응답을 키우지 않도록 `get_project_registry`로만 준다.
    pub pending_projects: Vec<ProjectRegistryEntry>,
}

/// 세션 하나를 가리키는 키. 델타가 "이 세션은 목록에서 빠졌다"를 알릴 때 쓴다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub source: ProviderId,
    pub id: String,
}

/// 관리 스냅숏의 변경분. 세션 목록만 바뀐 것으로 줄이고 나머지는 그대로 싣는다.
///
/// 세션 2,500건 규모에서 전체 스냅숏은 3.4MB이고 그중 3.1MB가 세션 목록인데, 조정 한 회차에서
/// 실제로 달라지는 세션은 대개 한두 건이다. 화면이 개정 번호를 따라잡으려고 전부 다시 받으면
/// 그 한 건 때문에 3.4MB를 다시 파싱하고 목록 전체를 다시 그린다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerSnapshotDelta {
    pub schema_version: u32,
    pub session_catalog_revision: u64,
    pub resource_catalog_revision: u64,
    pub status: AppStatus,
    pub dashboard: DashboardStats,
    pub folders: Vec<SessionFolder>,
    pub skills: Vec<SkillSummary>,
    pub agents: Vec<AgentDefinition>,
    pub artifacts: Vec<ArtifactGroup>,
    pub pending_projects: Vec<ProjectRegistryEntry>,
    /// 요청한 개정 이후 새로 생기거나 내용이 달라진 세션.
    pub changed_sessions: Vec<SessionSummary>,
    /// 요청한 개정 이후 목록에서 사라진 세션.
    pub removed_sessions: Vec<SessionRef>,
}

/// 화면이 스냅숏을 따라잡는 두 가지 방법. 변경 이력이 요청한 개정을 덮지 못하면
/// (첫 기동, 오래 끊겼던 창) 델타 대신 전체를 준다.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ManagerSnapshotSync {
    Full(ManagerSnapshot),
    Delta(ManagerSnapshotDelta),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationLanguage {
    pub code: String,
    pub name: String,
}

impl TranslationLanguage {
    pub fn korean() -> Self {
        Self {
            code: "ko".to_owned(),
            name: "Korean".to_owned(),
        }
    }

    pub fn english() -> Self {
        Self {
            code: "en".to_owned(),
            name: "English".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TranslationMenu {
    Skills,
    Agents,
    Artifacts,
    Instructions,
}

impl TranslationMenu {
    pub const ALL: [Self; 4] = [
        Self::Skills,
        Self::Agents,
        Self::Artifacts,
        Self::Instructions,
    ];
}

wire_enum!(trimmed TranslationMenu, "알 수 없는 번역 대상 메뉴입니다", {
    Skills => "skills",
    Agents => "agents",
    Artifacts => "artifacts",
    Instructions => "instructions",
});

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationMenuSettings {
    pub skills: bool,
    pub agents: bool,
    pub artifacts: bool,
    /// 이전 버전 설정 파일에는 없는 항목이라 기본 false로 읽는다.
    #[serde(default)]
    pub instructions: bool,
}

impl TranslationMenuSettings {
    pub fn enabled(self, menu: TranslationMenu) -> bool {
        match menu {
            TranslationMenu::Skills => self.skills,
            TranslationMenu::Agents => self.agents,
            TranslationMenu::Artifacts => self.artifacts,
            TranslationMenu::Instructions => self.instructions,
        }
    }

    pub fn any(self) -> bool {
        self.skills || self.agents || self.artifacts || self.instructions
    }
}

/// 시스템 에이전트(AIA)를 시작할 때 쓸 공급자별 실행설정. 공급자를 바꿔도 각 공급자의
/// 선택이 남아야 하므로 공급자별로 따로 저장하고, 항목은 모두 선택 사항으로 둔다.
/// `None`/빈 값은 "공급자 기본값"이라는 뜻이고, 저장되지 않은 공급자는 기존 AIA 기본값으로
/// 실행된다. `settings`는 실행설정 스키마의 동적 항목(예: Claude `fallbackModel`)이며
/// 공급자 화이트리스트를 통과한 항목만 저장·전달된다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAgentRuntime {
    #[serde(default)]
    pub model: Option<String>,
    /// 로컬 공급자일 때 쓸 서빙 연결 id(M7). 비어 있으면 기본 연결. 옛 저장본에는 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_connection_id: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    pub mode: Option<ChatMode>,
    #[serde(default)]
    pub approval_mode: Option<ChatApprovalMode>,
    /// 권한 승인 밖의 선택을 만났을 때의 처리 방식. 이전 버전 설정 파일에는 없으므로
    /// 비어 있으면 기존 동작(사용자에게 확인)으로 실행한다.
    #[serde(default)]
    pub decision_policy: Option<AiaDecisionPolicy>,
    /// AIA 커서가 승인 없이 누를 수 있는 범위. 비어 있으면 여는 동작만 누른다.
    #[serde(default)]
    pub ui_click_policy: Option<AiaUiClickPolicy>,
    #[serde(default)]
    pub settings: std::collections::BTreeMap<String, String>,
}

/// AIA 커서 클릭(open_ui_element)이 승인 없이 누를 수 있는 범위. `Openers`는 탭·주 메뉴·
/// 드로워/패널 여닫기처럼 화면을 여는 버튼만, `All`은 확인 모달 안을 뺀 어떤 버튼이든 누른다.
/// 프런트엔드 `AiaUiClickPolicy`와 같은 값이어야 한다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiaUiClickPolicy {
    #[default]
    Openers,
    All,
}

impl AiaUiClickPolicy {
    pub const ALL: [Self; 2] = [Self::Openers, Self::All];
}

wire_enum!(trimmed AiaUiClickPolicy, "알 수 없는 AIA UI 클릭 정책입니다", {
    Openers => "openers",
    All => "all",
});

/// 권한 승인 밖의 선택(정책·방향·개선안 등)을 AIA가 어떻게 처리할지. 승인 절차를
/// 생략해도 "무엇을 할지"를 정하는 판단은 남으므로, 승인 모드와 별개로 정한다.
/// CLI 플래그가 아니라 AIA 개발자 지침으로 전달되는 값이다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiaDecisionPolicy {
    /// 선택지와 추천안을 제시하고 사용자의 결정을 기다린다.
    #[default]
    Ask,
    /// 추천안을 스스로 골라 계속 진행하고, 무엇을 골랐는지 결과에 남긴다.
    Recommended,
}

impl AiaDecisionPolicy {
    pub const ALL: [Self; 2] = [Self::Ask, Self::Recommended];
}

wire_enum!(trimmed AiaDecisionPolicy, "알 수 없는 AIA 결정 정책입니다", {
    Ask => "ask",
    Recommended => "recommended",
});

/// 시스템 에이전트 실행설정이 없던 때부터 AIA가 써 온 기본값. 저장된 실행설정이 없는
/// 공급자는 이 값으로 실행해야 기존 AIA 동작이 그대로 유지된다.
/// 프런트엔드 `src/lib/aiaRuntime.ts`의 `AIA_RUNTIME_DEFAULTS`와 같은 값이어야 한다.
pub const DEFAULT_AIA_MODE: ChatMode = ChatMode::Workspace;
pub const DEFAULT_AIA_APPROVAL_MODE: ChatApprovalMode = ChatApprovalMode::Manual;
pub const DEFAULT_AIA_DECISION_POLICY: AiaDecisionPolicy = AiaDecisionPolicy::Ask;
pub const DEFAULT_AIA_UI_CLICK_POLICY: AiaUiClickPolicy = AiaUiClickPolicy::Openers;
pub const DEFAULT_AIA_REASONING_EFFORT: ReasoningEffort = ReasoningEffort::Medium;

/// AIA 시작 요청에 실제로 넣는 실행설정. 저장된 항목이 비어 있는 자리는 AIA 기본값으로
/// 채우고, `model`/`reasoning_effort`의 `None`은 "공급자 기본값"이라는 뜻이다.
///
/// 실행 중인 AIA가 무엇으로 시작했는지 화면이 알아야(저장본이 바뀌면 다시 시작해야) 하므로
/// 채팅 세션 정보에 그대로 실려 나간다. 프런트엔드 `AiaRuntimeSettings`와 같은 모양이다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaRuntimeSettings {
    pub model: Option<String>,
    /// 로컬 공급자일 때 쓸 서빙 연결 id(M7). 비어 있으면 기본 연결.
    #[serde(default)]
    pub local_connection_id: Option<String>,
    pub reasoning_effort: Option<ReasoningEffort>,
    pub mode: ChatMode,
    pub approval_mode: ChatApprovalMode,
    pub decision_policy: AiaDecisionPolicy,
    pub ui_click_policy: AiaUiClickPolicy,
    pub settings: std::collections::BTreeMap<String, String>,
}

impl SystemAgentRuntime {
    /// 저장할 내용이 없는 실행설정. 이런 항목은 저장하지 않고 지운다.
    pub fn is_empty(&self) -> bool {
        self.model.is_none()
            && self.reasoning_effort.is_none()
            && self.mode.is_none()
            && self.approval_mode.is_none()
            && self.decision_policy.is_none()
            && self.ui_click_policy.is_none()
            && self.settings.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAutomationSettings {
    #[serde(default = "TranslationLanguage::korean")]
    pub language: TranslationLanguage,
    #[serde(default)]
    pub additional_translation_languages: Vec<TranslationLanguage>,
    pub system_provider: Option<ProviderId>,
    #[serde(default)]
    pub translations: TranslationMenuSettings,
    /// 시스템 에이전트로 고를 수 있는 공급자별 실행설정. 이전 버전 설정 파일에는 없으므로
    /// 비어 있으면 기존 AIA 기본값으로 실행한다.
    #[serde(default)]
    pub system_agent_runtimes: std::collections::BTreeMap<ProviderId, SystemAgentRuntime>,
    /// CLI가 업데이트되어 모델·추론 카탈로그가 오래됐을 때 AIA에게 재조사를 자동으로
    /// 요청할지. 켜 두면 앱을 새로 배포하지 않고도 최신 모델·추론 수준이 따라온다.
    /// 이전 버전 설정 파일에는 없으므로 기본값은 켜진 상태다.
    #[serde(default = "default_catalog_auto_discovery")]
    pub catalog_auto_discovery: bool,
    /// AIA와 나눈 대화를 공급자 기록으로 남길지. 끄면 Codex AIA 세션을 ephemeral로 띄워
    /// rollout도 세션 색인도 남기지 않으므로 세션 목록에 나타나지 않는다. 켜면 일반 채팅과
    /// 같이 기록되어 "AIA 대화 포함" 필터로 목록에서 볼 수 있다. 이전 버전 설정 파일에는
    /// 없으므로 기본값은 켜진 상태이고, 정해지는 시점이 CLI 실행이라 새 대화부터 적용된다.
    #[serde(default = "default_aia_session_recording")]
    pub aia_session_recording: bool,
    /// AIA 선제 제안 팩을 쓸지. 끄면 제안 팩이 만들어 내는 선제 제안 카드와 트리거 말풍선이
    /// 뜨지 않는다(공통 스킬에 설치된 팩 자체와 그 관리 화면은 그대로 남는다). 이전 버전
    /// 설정 파일에는 없으므로 기본값은 켜진 상태다.
    #[serde(default = "default_aia_suggestions")]
    pub aia_suggestions: bool,
    /// 자동화 탭에서 사용자가 끈 온보딩 카드의 id. 번들 기본 팩의 카드는 파일이 앱 안에
    /// 있어 삭제할 수 없으므로 끄기로 감춘다(공통 스킬로 설치한 팩은 그 스킬을 휴지통으로
    /// 옮겨 지운다). 이전 버전 설정 파일에는 없으므로 기본값은 빈 목록이다.
    #[serde(default)]
    pub hidden_onboarding_cards: Vec<String>,
}

fn default_catalog_auto_discovery() -> bool {
    true
}

fn default_aia_session_recording() -> bool {
    true
}

fn default_aia_suggestions() -> bool {
    true
}

impl SystemAutomationSettings {
    /// AIA 시스템 에이전트가 실행될 공급자. 시스템 에이전트를 고르지 않았거나 더 이상
    /// 쓸 수 없는 값이 저장돼 있으면 AIA 기능 자체를 쓸 수 없다(`None`). 고르지 않은
    /// 상태에서 임의의 공급자로 대신 실행하면, 사용자가 끄기로 한 시스템 에이전트가
    /// 조용히 도는 셈이 되므로 자동번역과 같은 규칙으로 비활성화한다.
    pub fn aia_provider(&self) -> Option<ProviderId> {
        self.system_provider
            .filter(|provider| provider.can_run_system_agent())
    }

    /// 해당 공급자로 AIA를 시작할 때 쓸 실행설정. 저장된 항목이 아예 없으면 실행설정
    /// 기능이 없던 때와 같은 기본값으로 실행하고, 저장돼 있으면 저장된 선택을 그대로 쓴다.
    pub fn aia_runtime_settings(&self, provider: ProviderId) -> AiaRuntimeSettings {
        let stored = self.system_agent_runtimes.get(&provider);
        AiaRuntimeSettings {
            model: stored.and_then(|runtime| runtime.model.clone()),
            local_connection_id: stored.and_then(|runtime| runtime.local_connection_id.clone()),
            reasoning_effort: match stored {
                Some(runtime) => runtime.reasoning_effort.clone(),
                None => Some(DEFAULT_AIA_REASONING_EFFORT),
            },
            mode: stored
                .and_then(|runtime| runtime.mode)
                .unwrap_or(DEFAULT_AIA_MODE),
            approval_mode: stored
                .and_then(|runtime| runtime.approval_mode)
                .unwrap_or(DEFAULT_AIA_APPROVAL_MODE),
            decision_policy: stored
                .and_then(|runtime| runtime.decision_policy)
                .unwrap_or(DEFAULT_AIA_DECISION_POLICY),
            ui_click_policy: stored
                .and_then(|runtime| runtime.ui_click_policy)
                .unwrap_or(DEFAULT_AIA_UI_CLICK_POLICY),
            settings: stored
                .map(|runtime| runtime.settings.clone())
                .unwrap_or_default(),
        }
    }
}

impl Default for SystemAutomationSettings {
    fn default() -> Self {
        Self {
            language: TranslationLanguage::korean(),
            additional_translation_languages: Vec::new(),
            system_provider: None,
            translations: TranslationMenuSettings::default(),
            system_agent_runtimes: std::collections::BTreeMap::new(),
            catalog_auto_discovery: default_catalog_auto_discovery(),
            aia_session_recording: default_aia_session_recording(),
            aia_suggestions: default_aia_suggestions(),
            hidden_onboarding_cards: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAutomationSettingsInput {
    #[serde(default = "TranslationLanguage::korean")]
    pub language: TranslationLanguage,
    #[serde(default)]
    pub additional_translation_languages: Vec<TranslationLanguage>,
    pub system_provider: Option<ProviderId>,
    pub translations: TranslationMenuSettings,
    #[serde(default)]
    pub system_agent_runtimes: std::collections::BTreeMap<ProviderId, SystemAgentRuntime>,
    #[serde(default = "default_catalog_auto_discovery")]
    pub catalog_auto_discovery: bool,
    #[serde(default = "default_aia_session_recording")]
    pub aia_session_recording: bool,
    #[serde(default = "default_aia_suggestions")]
    pub aia_suggestions: bool,
    #[serde(default)]
    pub hidden_onboarding_cards: Vec<String>,
}

impl From<SystemAutomationSettingsInput> for SystemAutomationSettings {
    fn from(value: SystemAutomationSettingsInput) -> Self {
        Self {
            language: value.language,
            additional_translation_languages: value.additional_translation_languages,
            system_provider: value.system_provider,
            translations: value.translations,
            system_agent_runtimes: value.system_agent_runtimes,
            catalog_auto_discovery: value.catalog_auto_discovery,
            aia_session_recording: value.aia_session_recording,
            aia_suggestions: value.aia_suggestions,
            hidden_onboarding_cards: value.hidden_onboarding_cards,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiTranslationCatalogInput {
    pub version: String,
    pub messages: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemLanguageRequest {
    pub language: TranslationLanguage,
    pub catalog: UiTranslationCatalogInput,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationStatus {
    pub phase: String,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub pending: usize,
    /// 이번 실행에서 다시 번역하지 않고 캐시를 그대로 쓴 리소스 수. `completed`에도
    /// 포함되므로, 실제 실행 대상은 `total - cached`로 읽는다.
    #[serde(default)]
    pub cached: usize,
    pub segment_total: usize,
    pub segment_completed: usize,
    pub segment_failed: usize,
    /// `cached`의 요청(세그먼트) 단위 값. `segment_completed`에도 포함된다.
    #[serde(default)]
    pub segment_cached: usize,
    pub current_field: Option<String>,
    pub last_error: Option<String>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAutomationSnapshot {
    pub revision: u64,
    pub resource_catalog_revision: u64,
    pub settings: SystemAutomationSettings,
    pub pending_language: Option<TranslationLanguage>,
    pub ui_translation: TranslationStatus,
    pub ui_messages: std::collections::BTreeMap<String, String>,
    pub providers: Vec<ProviderStatus>,
    pub skills: TranslationStatus,
    pub agents: TranslationStatus,
    pub artifacts: TranslationStatus,
    pub instructions: TranslationStatus,
    /// 사용자가 상세 화면에서 직접 요청한 리소스 단위 번역의 진행 상태. 메뉴 자동번역
    /// 토글과 무관하게 동작하며, 성공한 작업은 목록에서 사라진다.
    pub resource_translations: Vec<ResourceTranslationJob>,
}

/// 리소스 하나(=그 리소스의 모든 필드)를 대상으로 하는 수동 번역 작업. `phase`는
/// `queued`·`running`·`error` 중 하나이고, 완료된 작업은 스냅샷에 남기지 않는다.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTranslationJob {
    pub menu: TranslationMenu,
    pub resource_id: String,
    pub phase: String,
    pub segment_total: usize,
    pub segment_completed: usize,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationSummary {
    pub resource_id: String,
    pub fields: std::collections::BTreeMap<String, String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuTranslations {
    pub menu: TranslationMenu,
    pub language: TranslationLanguage,
    pub enabled: bool,
    pub status: TranslationStatus,
    pub records: Vec<TranslationSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatedDetail {
    pub menu: TranslationMenu,
    pub resource_id: String,
    pub fields: std::collections::BTreeMap<String, String>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCatalogUpdate {
    pub revision: u64,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRoot {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub agent_data: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocRootStatus {
    #[serde(flatten)]
    pub root: DocRoot,
    pub exists: bool,
    /// 공급자 인증 저장소나 Agent Manager 앱 데이터와 겹쳐 AIA·감시·내용 조회에서
    /// 제외해야 하는 기존 등록 경로.
    pub restricted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocFile {
    pub root_id: String,
    pub relative_path: String,
    pub content: String,
    pub modified_at: i64,
    pub size_bytes: u64,
}

/// 문서 메뉴에서 직접 열었을 때 Core가 판별한 파일 표시 방식. 확장자만으로
/// 신뢰하지 않고 크기와 UTF-8 여부를 함께 확인한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentPreviewKind {
    Markdown,
    Text,
    Binary,
    TooLarge,
}

wire_enum!(trimmed DocumentPreviewKind, "알 수 없는 파일 미리보기 방식입니다", {
    Markdown => "markdown",
    Text => "text",
    Binary => "binary",
    TooLarge => "tooLarge",
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentEntry {
    pub name: String,
    pub relative_path: String,
    pub parent_path: String,
    pub size_bytes: u64,
    pub modified_at: i64,
    pub is_directory: bool,
    pub preview_kind: Option<DocumentPreviewKind>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentEntryPage {
    pub entries: Vec<DocumentEntry>,
    pub next_cursor: Option<String>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentFile {
    pub root_id: String,
    pub relative_path: String,
    pub kind: DocumentPreviewKind,
    pub content: Option<String>,
    pub modified_at: i64,
    pub size_bytes: u64,
    pub downloadable: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetaPatch {
    pub favorite: Option<bool>,
    pub hidden: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_nullable_field")]
    pub note: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_nullable_field")]
    pub custom_title: Option<Option<String>>,
    pub folder_ids: Option<Vec<String>>,
    /// 실행 계정 고정. `Some(None)`이면 고정을 해제해 활성 계정을 따르게 한다.
    #[serde(default, deserialize_with = "deserialize_nullable_field")]
    pub pinned_account_id: Option<Option<String>>,
    /// 읽던 자리 목록. `folder_ids`와 같은 통째 교체다 — 추가·이름변경·삭제가 모두
    /// 목록 하나를 다시 보내는 일이라, 낱개 명령을 셋 두는 대신 이 한 자리로 모은다.
    pub bookmarks: Option<Vec<SessionBookmark>>,
}

/// `Option<Option<T>>`는 기본 역직렬화로는 `null`과 미지정을 구분할 수 없어 둘 다
/// `None`이 된다. 값이 실제로 실려 온 경우만 `Some`으로 감싸, `null`을 "지우기"로
/// 전달받는 패치 필드가 조용히 무시되지 않게 한다.
pub(crate) fn deserialize_nullable_field<'de, D, T>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_meta_patch_tells_null_apart_from_an_absent_field() {
        let cleared: SessionMetaPatch = serde_json::from_value(serde_json::json!({
            "pinnedAccountId": null,
            "note": null,
            "customTitle": null,
        }))
        .expect("patch must deserialize");
        // `null`은 "지우기"다. 여기서 `None`이 되면 고정 해제가 조용히 무시된다.
        assert_eq!(cleared.pinned_account_id, Some(None));
        assert_eq!(cleared.note, Some(None));
        assert_eq!(cleared.custom_title, Some(None));

        let untouched: SessionMetaPatch =
            serde_json::from_value(serde_json::json!({ "favorite": true }))
                .expect("patch must deserialize");
        assert_eq!(untouched.pinned_account_id, None);
        assert_eq!(untouched.note, None);
        assert_eq!(untouched.custom_title, None);
        assert_eq!(untouched.favorite, Some(true));

        let pinned: SessionMetaPatch =
            serde_json::from_value(serde_json::json!({ "pinnedAccountId": "claude-account-01" }))
                .expect("patch must deserialize");
        assert_eq!(
            pinned.pinned_account_id,
            Some(Some("claude-account-01".to_owned()))
        );
    }

    #[test]
    fn serializes_the_frontend_contract_in_camel_case() {
        let status = AppStatus {
            schema_version: 1,
            platform: "macos".to_owned(),
            architecture: "aarch64".to_owned(),
            providers: vec![ProviderStatus {
                provider: ProviderId::Codex,
                display_name: "OpenAI Codex".to_owned(),
                cli: DetectedResource::found("/usr/local/bin/codex"),
                history: DetectedResource::missing(),
            }],
        };

        let value = serde_json::to_value(status).expect("status must serialize");

        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["providers"][0]["provider"], "codex");
        assert_eq!(value["providers"][0]["displayName"], "OpenAI Codex");
        assert_eq!(
            value["providers"][0]["history"]["path"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn an_unconfigured_provider_keeps_the_previous_aia_run_settings() {
        let settings = SystemAutomationSettings {
            system_provider: Some(ProviderId::Claude),
            ..SystemAutomationSettings::default()
        };

        let runtime = settings.aia_runtime_settings(ProviderId::Claude);

        assert_eq!(runtime.model, None);
        assert_eq!(runtime.mode, ChatMode::Workspace);
        assert_eq!(runtime.approval_mode, ChatApprovalMode::Manual);
        assert_eq!(runtime.decision_policy, AiaDecisionPolicy::Ask);
        assert_eq!(runtime.reasoning_effort, Some(ReasoningEffort::Medium));
        assert!(runtime.settings.is_empty());
    }

    #[test]
    fn stored_run_settings_are_used_per_provider_and_allow_provider_defaults() {
        let mut settings = SystemAutomationSettings {
            system_provider: Some(ProviderId::Claude),
            ..SystemAutomationSettings::default()
        };
        settings.system_agent_runtimes.insert(
            ProviderId::Claude,
            SystemAgentRuntime {
                model: Some("claude-opus-5".to_owned()),
                local_connection_id: None,
                // 저장된 항목이 있으면 추론 강도를 비워 공급자 기본값을 고를 수 있다.
                reasoning_effort: None,
                mode: Some(ChatMode::Plan),
                approval_mode: Some(ChatApprovalMode::Never),
                decision_policy: Some(AiaDecisionPolicy::Recommended),
                ui_click_policy: None,
                settings: std::collections::BTreeMap::from([(
                    "fallbackModel".to_owned(),
                    "claude-sonnet-5".to_owned(),
                )]),
            },
        );

        let claude = settings.aia_runtime_settings(ProviderId::Claude);
        assert_eq!(claude.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(claude.reasoning_effort, None);
        assert_eq!(claude.mode, ChatMode::Plan);
        assert_eq!(claude.approval_mode, ChatApprovalMode::Never);
        assert_eq!(claude.decision_policy, AiaDecisionPolicy::Recommended);
        assert_eq!(claude.settings["fallbackModel"], "claude-sonnet-5");

        // 다른 공급자는 자기 실행설정만 본다. Claude 전용 동적 설정이 새지 않아야 한다.
        let codex = settings.aia_runtime_settings(ProviderId::Codex);
        assert_eq!(codex.model, None);
        assert_eq!(codex.mode, ChatMode::Workspace);
        assert_eq!(codex.approval_mode, ChatApprovalMode::Manual);
        assert_eq!(codex.decision_policy, AiaDecisionPolicy::Ask);
        assert_eq!(codex.reasoning_effort, Some(ReasoningEffort::Medium));
        assert!(codex.settings.is_empty());
    }

    #[test]
    fn session_transcript_limit_uses_the_typed_ipc_values_and_latest_500_default() {
        assert_eq!(SessionTranscriptLimit::default().max_items(), Some(500));
        assert_eq!(
            serde_json::to_value(SessionTranscriptLimit::Latest1000)
                .expect("serialize transcript limit"),
            "latest1000"
        );
        assert_eq!(
            serde_json::from_str::<SessionTranscriptLimit>("\"all\"")
                .expect("deserialize transcript limit"),
            SessionTranscriptLimit::All
        );
    }

    #[test]
    fn session_transcript_limit_display_and_from_str_round_trip() {
        let cases = [
            SessionTranscriptLimit::Latest100,
            SessionTranscriptLimit::Latest500,
            SessionTranscriptLimit::Latest1000,
            SessionTranscriptLimit::All,
        ];
        for limit in cases {
            assert_eq!(limit.to_string(), limit.as_str());
            assert_eq!(
                limit.as_str().parse::<SessionTranscriptLimit>().unwrap(),
                limit
            );
        }
        assert!(matches!(
            "unknown".parse::<SessionTranscriptLimit>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn provider_id_display_and_from_str_round_trip() {
        for provider in ProviderId::ALL {
            assert_eq!(provider.to_string(), provider.as_str());
            assert_eq!(provider.as_str().parse::<ProviderId>().unwrap(), provider);
        }
        assert!(matches!(
            "unknown".parse::<ProviderId>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn provider_id_all_contains_exact_variants() {
        assert_eq!(
            ProviderId::ALL,
            [
                ProviderId::Claude,
                ProviderId::Codex,
                ProviderId::Antigravity,
                ProviderId::Local,
            ]
        );
    }

    /// 와이어 문자열은 저장된 세션·설정·IPC가 함께 쓰는 값이라 이름을 바꾸면 기존
    /// 데이터가 읽히지 않는다. 표를 못으로 박아 둔다.
    #[test]
    fn provider_id_wire_strings_are_pinned() {
        assert_eq!(ProviderId::Claude.as_str(), "claude");
        assert_eq!(ProviderId::Codex.as_str(), "codex");
        assert_eq!(ProviderId::Antigravity.as_str(), "antigravity");
        assert_eq!(ProviderId::Local.as_str(), "local");
        assert_eq!("local".parse::<ProviderId>().unwrap(), ProviderId::Local);
    }

    /// 능력 술어는 공급자를 늘릴 때 한 자리만 고치고 나머지를 잊기 쉬운 표다. 네 술어를
    /// 한 줄로 세워, 새 공급자가 어느 칸을 물려받는지 이 테스트에서 먼저 결정하게 한다.
    #[test]
    fn provider_capability_table_is_pinned() {
        // (공급자, 시스템 에이전트, 계정 관리, 사용량 한도, 하네스)
        let table = [
            (ProviderId::Claude, true, true, true, Harness::Claude),
            (ProviderId::Codex, true, true, true, Harness::Codex),
            (
                ProviderId::Antigravity,
                false,
                true,
                true,
                Harness::Antigravity,
            ),
            // 로컬 모델은 계정도 사용량 한도도 없고 실행은 ACP 하네스로 돈다.
            (ProviderId::Local, false, false, false, Harness::OpenCode),
        ];
        assert_eq!(table.len(), ProviderId::ALL.len());
        for (provider, system_agent, accounts, quota, harness) in table {
            assert_eq!(provider.can_run_system_agent(), system_agent, "{provider}");
            assert_eq!(provider.manages_accounts(), accounts, "{provider}");
            assert_eq!(provider.has_usage_quota(), quota, "{provider}");
            assert_eq!(provider.harness(), harness, "{provider}");
        }
    }

    #[test]
    fn source_counts_increments_per_provider() {
        let mut counts = SourceCounts::default();
        assert_eq!(counts.claude, 0);
        assert_eq!(counts.codex, 0);
        assert_eq!(counts.antigravity, 0);

        counts.increment(ProviderId::Claude);
        counts.increment(ProviderId::Claude);
        counts.increment(ProviderId::Codex);
        counts.increment(ProviderId::Antigravity);

        assert_eq!(counts.claude, 2);
        assert_eq!(counts.codex, 1);
        assert_eq!(counts.antigravity, 1);
    }

    #[test]
    fn translation_menu_display_and_from_str_round_trip() {
        assert_eq!(
            TranslationMenu::ALL,
            [
                TranslationMenu::Skills,
                TranslationMenu::Agents,
                TranslationMenu::Artifacts,
                TranslationMenu::Instructions,
            ]
        );
        for menu in TranslationMenu::ALL {
            assert_eq!(menu.to_string(), menu.as_str());
            assert_eq!(menu.as_str().parse::<TranslationMenu>().unwrap(), menu);
        }
        assert!(matches!(
            "unknown".parse::<TranslationMenu>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn aia_decision_policy_display_and_from_str_round_trip() {
        assert_eq!(
            AiaDecisionPolicy::ALL,
            [AiaDecisionPolicy::Ask, AiaDecisionPolicy::Recommended]
        );
        for policy in AiaDecisionPolicy::ALL {
            assert_eq!(policy.to_string(), policy.as_str());
            assert_eq!(
                policy.as_str().parse::<AiaDecisionPolicy>().unwrap(),
                policy
            );
        }
        assert!(matches!(
            "unknown".parse::<AiaDecisionPolicy>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn aia_ui_click_policy_display_and_from_str_round_trip() {
        assert_eq!(
            AiaUiClickPolicy::ALL,
            [AiaUiClickPolicy::Openers, AiaUiClickPolicy::All]
        );
        for policy in AiaUiClickPolicy::ALL {
            assert_eq!(policy.to_string(), policy.as_str());
            assert_eq!(policy.as_str().parse::<AiaUiClickPolicy>().unwrap(), policy);
        }
        assert!(matches!(
            "unknown".parse::<AiaUiClickPolicy>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn session_failure_kind_display_and_from_str_round_trip() {
        let cases = [SessionFailureKind::UsageLimit, SessionFailureKind::Error];
        for kind in cases {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(kind.as_str().parse::<SessionFailureKind>().unwrap(), kind);
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
            assert_eq!(
                serde_json::from_str::<SessionFailureKind>(&serialized).unwrap(),
                kind
            );
        }
        assert!(" error ".parse::<SessionFailureKind>().is_ok());
        assert!("limit".parse::<SessionFailureKind>().is_err());
    }

    #[test]
    fn session_last_failure_classifies_and_caps_the_message() {
        let limit =
            SessionLastFailure::new("  You've hit your usage limit. Try again at 3pm. ", Some(7));
        assert_eq!(limit.kind, SessionFailureKind::UsageLimit);
        assert_eq!(limit.occurred_at, Some(7));
        assert_eq!(
            limit.message,
            "You've hit your usage limit. Try again at 3pm."
        );

        let error = SessionLastFailure::new("Failed to authenticate: OAuth session expired", None);
        assert_eq!(error.kind, SessionFailureKind::Error);

        let long = "가".repeat(SessionLastFailure::MAX_MESSAGE_CHARS + 20);
        let capped = SessionLastFailure::new(&long, None);
        assert_eq!(
            capped.message.chars().count(),
            SessionLastFailure::MAX_MESSAGE_CHARS + 1
        );
        assert!(capped.message.ends_with('…'));

        let serialized = serde_json::to_value(&limit).unwrap();
        assert_eq!(serialized["kind"], "usageLimit");
        assert_eq!(serialized["occurredAt"], 7);
    }

    #[test]
    fn chat_origin_kind_display_and_from_str_round_trip() {
        let cases = [
            ChatOriginKind::Workflow,
            ChatOriginKind::Schedule,
            ChatOriginKind::Aia,
            ChatOriginKind::User,
        ];
        for kind in cases {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(kind.as_str().parse::<ChatOriginKind>().unwrap(), kind);
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
        }
        assert!(matches!(
            "unknown".parse::<ChatOriginKind>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn skill_origin_kind_display_and_from_str_round_trip() {
        let cases = [SkillOriginKind::Common, SkillOriginKind::Provider];
        for kind in cases {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(kind.as_str().parse::<SkillOriginKind>().unwrap(), kind);
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
            let deserialized: SkillOriginKind = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, kind);
        }
        assert!(matches!(
            "unknown".parse::<SkillOriginKind>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn skill_provider_status_display_and_from_str_round_trip() {
        let cases = [
            SkillProviderStatus::Linked,
            SkillProviderStatus::Copy,
            SkillProviderStatus::Missing,
            SkillProviderStatus::Unsupported,
        ];
        for status in cases {
            assert_eq!(status.to_string(), status.as_str());
            assert_eq!(
                status.as_str().parse::<SkillProviderStatus>().unwrap(),
                status
            );
            let serialized = serde_json::to_string(&status).unwrap();
            assert_eq!(serialized, format!("\"{}\"", status.as_str()));
            let deserialized: SkillProviderStatus = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, status);
        }
        assert!(matches!(
            "unknown".parse::<SkillProviderStatus>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn document_preview_kind_display_and_from_str_round_trip() {
        let cases = [
            DocumentPreviewKind::Markdown,
            DocumentPreviewKind::Text,
            DocumentPreviewKind::Binary,
            DocumentPreviewKind::TooLarge,
        ];
        for kind in cases {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(kind.as_str().parse::<DocumentPreviewKind>().unwrap(), kind);
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
            let deserialized: DocumentPreviewKind = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, kind);
        }
        assert!(matches!(
            "unknown".parse::<DocumentPreviewKind>(),
            Err(crate::CoreError::InvalidInput(_))
        ));
    }
}
