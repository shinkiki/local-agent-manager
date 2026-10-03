//! 로컬 공급자의 계획 수립 상태와 그 검증.
//!
//! 도구 묶음 전환으로 "노션이냐 셸이냐"는 갈렸지만 한 묶음 안이 여전히 45개다. 모델이 한
//! 턴에 45개를 받으면 이름을 지어내기 시작한다(C14-1의 26개 측정과 같은 자리다). 그래서
//! 도구 수를 **턴이 아니라 단계 단위로** 줄인다 — 첫 턴에는 이름 목록만 주고 계획을 받고,
//! 실행할 때는 그 단계가 선언한 도구의 스키마만 싣는다.
//!
//! 이 파일은 그 계획을 들고 있는 순수 로직이다. 프로세스도, 스트림도, 프롬프트도 모른다 —
//! 배선은 [`crate::chat`]이 한다(9.3~9.7). 여기서 정하는 것은 두 가지뿐이다.
//!
//! **번호는 우리가 매긴다.** 모델은 순서만 준다. 모델에게 번호를 맡기면 중복·건너뜀·
//! "200과 300 사이" 같은 산수가 들어오고, 그것을 되돌리는 코드가 계획 상태보다 커진다.
//! [`PlanDraft::add_step`]이 부른 차례대로 1부터 매기고, [`Plan::insert_after`]는 끼운 뒤
//! 전부 다시 매긴다.
//!
//! **어긋나면 실재하는 이름을 함께 돌려준다.** 없는 도구를 "없습니다"로만 되돌리면 모델은
//! 같은 이름을 다시 쓴다. 틀린 이름 옆에 실제 목록을 붙여야 고칠 거리가 생긴다.

#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::chat::ChatApprovalMode;
use crate::domain::AiaDecisionPolicy;
use std::collections::BTreeMap;

use crate::CoreError;

/// 계획 한 건의 단계 수 상한.
///
/// 단계가 많아질수록 계획 자체가 모델이 다루지 못하는 크기가 된다. 열둘을 넘겨야 하는 일은
/// 계획을 쪼갤 일이지 상한을 올릴 일이 아니다.
pub(crate) const MAX_PLAN_STEPS: usize = 12;

/// 한 단계가 선언할 수 있는 도구 수 상한.
///
/// 실행기는 첫 도구로 단계 agent를 고른다. 두 도구를 수락하면 뒤 도구의 작업이
/// 실행 표면에서 사라질 수 있으므로, 계획 스키마와 정규화도 같은 한 도구 계약을 쓴다.
pub(crate) const MAX_TOOLS_PER_STEP: usize = 1;

/// 단계 제목의 글자 수 상한. 제목은 다음 단계에 실리는 한 줄이라 길 필요가 없다.
pub(crate) const MAX_STEP_TITLE_CHARS: usize = 120;

/// 단계 결과 메모의 글자 수 상한.
///
/// 결과 본문은 맥락 밖에 쌓아 두고 이 메모만 다음 단계에 싣는다(9.4). 상한이 없으면
/// 단계가 진행될수록 맥락이 도로 불어나 계획으로 얻은 것을 그대로 잃는다.
pub(crate) const MAX_STEP_NOTE_CHARS: usize = 200;

/// 맥락 밖에 쌓아 두는 단계 결과 본문의 글자 수 상한.
///
/// 메모(`MAX_STEP_NOTE_CHARS`)와 달리 이 본문은 다음 단계에 실리지 않는다. 실리지 않으니
/// 넉넉해도 되지만, 무한이면 한 단계의 출력이 마무리 요약을 통째로 밀어낸다. 본문은
/// 도구 호출마다 입력·결과를 한 기록으로 싣는데(`chat::tool_call_record`, 호출당 최대
/// 800자 남짓), 4,000자면 열 번 부른 단계의 뒤쪽 호출이 잘려 종합이 그 세션들을 보지
/// 못했다(2026-09-28 ses_f1c87561, patch 11회). 요약 전체는 `MAX_SUMMARY_CHARS` 가 따로
/// 단계 수로 나눠 자른다.
pub(crate) const MAX_STEP_BODY_CHARS: usize = 8_000;

/// 마무리 요약에 싣는 전체 글자 수 상한.
///
/// 계획이 도구 수를 단계 단위로 줄인 것은 맥락을 아끼기 위해서고, **여기가 그 아낀 것을
/// 쓰는 유일한 자리다**(9.5). 쓰는 자리를 한 곳으로 몰아 두면 얼마나 쓰는지가 이 상수
/// 하나로 보인다.
pub(crate) const MAX_SUMMARY_CHARS: usize = 12_000;

/// 거절 사유의 글자 수 상한. 사용자에게 그대로 보이는 한두 문장이다.
pub(crate) const MAX_REFUSAL_REASON_CHARS: usize = 400;

/// 한 단계를 다시 돌릴 수 있는 횟수의 상한.
///
/// `resolve`의 네 갈래 중 `retry`만이 계획을 앞으로 보내지 않는다. 무인 실행에는 "또 같은
/// 실패네"라고 말해 줄 사람이 없으므로, 멈추는 자리를 모델의 판단이 아니라 이 상수가
/// 정한다. 두 번까지 다시 돌리고 그 뒤로는 남은 세 갈래만 남는다.
pub(crate) const MAX_STEP_RETRIES: usize = 2;

/// 갈림길 질문의 글자 수 상한. 사용자에게 그대로 보이는 한두 문장이다.
pub(crate) const MAX_DECISION_QUESTION_CHARS: usize = 300;

/// 선택지 하나의 글자 수 상한.
pub(crate) const MAX_DECISION_OPTION_CHARS: usize = 200;

/// 한 갈림길이 내놓을 수 있는 선택지 수 상한.
///
/// 고르라고 내민 것이 열 개면 고르는 일 자체가 다시 일이 된다. 후보가 그보다 많으면
/// 추려서 내미는 것이 단계가 할 일이다.
pub(crate) const MAX_DECISION_OPTIONS: usize = 5;

/// 오류 문구에 함께 적는 도구 이름의 최대 개수.
///
/// 마흔 개를 다 적으면 고칠 거리를 주려던 문장이 도로 그 마흔 개가 된다.
const MAX_LISTED_TOOL_NAMES: usize = 20;

/// 계획이 고를 수 있는 도구 이름의 전부.
///
/// 이름만 들고 스키마는 들지 않는다 — 첫 턴에 싣는 것이 이름뿐이기 때문이다. 스키마는
/// 그 단계를 실행할 때 실행기가 따로 싣는다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ToolCatalog {
    names: Vec<String>,
    /// 플러그인마다 "사람이 부르는 이름들"과 그 도구들. 제목이 어떤 플러그인을 말하는데
    /// 도구는 다른 것을 골랐을 때 되물을 근거다(아래 `plugin_mismatch`).
    #[serde(default)]
    groups: Vec<ToolGroup>,
}

/// 플러그인 하나의 이름 목록(등록한 "다른 이름"·id)과 도구 이름들.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ToolGroup {
    pub(crate) aliases: Vec<String>,
    pub(crate) tools: Vec<String>,
}

/// 실재하는 이름을 오류에 붙일 형태로 적는다. 너무 많으면 앞에서 잘라 남은 수를 밝힌다.
fn listed_names(names: &[String]) -> String {
    if names.is_empty() {
        return "(none)".to_string();
    }
    let shown = names.len().min(MAX_LISTED_TOOL_NAMES);
    let mut text = names[..shown].join(", ");
    if names.len() > shown {
        text.push_str(&format!(" and {} more", names.len() - shown));
    }
    text
}

/// 제목이 플러그인을 말하는데 그 플러그인 도구가 없는 단계를 되돌리는 문구.
///
/// 2026-09-26·27 측정: GPU 레인이 "노션에 정리" 단계의 도구로 `write`(로컬 파일)를 고른
/// 것이 web-to-notion 실패의 대부분(5건 중 3건, 다시 재니 2건 중 2건)이었다. 프롬프트에
/// "노션은 write 가 아니다"라고 적는 대신, 등록된 이름 목록(9.12)이 말하는 사실로 되묻는다
/// — 그 플러그인의 도구를 나열해 다시 물을 거리를 준다.
fn plugin_mismatch_message(alias: &str, tools: &str) -> String {
    format!(
        "The step title mentions '{alias}' but none of its tools belong to that plugin. That plugin's tools: {tools}. Pick one of them, or reword the title if this step does not use that plugin"
    )
}

/// 제목이 "파일을 고친다"고 말할 때 쓰이는 말들.
///
/// 뜻이 하나뿐인 것만 둔다. `추출`·`작성`·`적용` 은 "추출할 자리를 찾는다"처럼 읽기 단계의
/// 제목에도 그대로 쓰여서, 넣으면 멀쩡한 조회 단계를 되묻게 된다. 가드가 아니라 울타리가
/// 되는 자리다.
const WRITE_INTENT_WORDS: &[&str] = &[
    "수정",
    "고치",
    "고쳐",
    "바꾸",
    "바꿔",
    "변경",
    "덮어",
    "리팩터",
    "리팩토링",
    "refactor",
    "rewrite",
    "replace",
    "modify",
];

/// 제목은 파일을 고친다는데 도구는 읽기만 하는 단계를 되돌리는 문구.
///
/// 2026-10-02 코드 리팩토링 11회차 실측(GPU `local-refactor` n=20): 실패 2건이 둘 다 이
/// 모양이었다 — 마지막 단계 제목이 "…확인하고 동일한 패턴을 찾기 위해 수정하기"인데 도구는
/// `read` 였다. 계획은 확정되고 고쳐진 것은 없다. 플러그인 되묻기(`plugin_mismatch`)와 같은
/// 모양으로, 고칠 수 있는 도구 이름을 함께 주어 다시 물을 거리를 남긴다.
fn writing_intent_message(tools: &str, writers: &str) -> String {
    format!(
        "The step title says the file changes but '{tools}' only reads. Tools that change a file: {writers}. Pick one of them, or reword the title if this step only reads"
    )
}

/// 요청은 파일을 고치라는데 계획의 모든 단계가 읽기만 하는 것을 되돌리는 문구.
///
/// 2026-10-03 코드 리팩토링 12회차 실측(GPU `local-refactor` n=20 끼워넣기, 40시행):
/// 실패 13건 가운데 3건이 이 모양이었다 — 요청은 "함수 하나로 뽑아내서 … 고쳐줘"인데
/// 계획은 `read: report.mjs 파일 읽어서 내용 확인` 한 단계로 확정됐다(trim-write 10·19).
/// 단계 되묻기(`writing_intent_mismatch`)는 제목에 고친다는 말이 없어 발동하지 못한다.
/// 고칠 수 있는 도구 이름과 거절이라는 출구를 함께 준다 — 막는 것이 아니라 되묻는 것이다.
fn read_only_plan_message(writers: &str) -> String {
    format!(
        "The request asks for a file to change, but every step of this plan only reads. Add the step that changes it with one of: {writers}, or call cannot_do with the reason if it cannot be done"
    )
}

impl ToolCatalog {
    /// 요청이 파일을 고치라고 말하는데 계획의 **모든** 단계가 읽기 전용 작업 공간 도구만
    /// 쓰면 고칠 수 있는 도구 이름을 돌려준다.
    ///
    /// 단계 하나라도 `bash`·`edit`·`write` 나 플러그인 도구를 쓰면 발동하지 않는다 —
    /// 셸은 파일을 쓰고("노션 페이지 수정"처럼) 플러그인 자리는 `plugin_mismatch` 가 본다.
    /// 읽기 전용 모드에는 고칠 수 있는 도구가 카탈로그에 없으므로 역시 발동하지 않는다.
    /// 낱말·도구 이름은 둘 다 목록에서 읽는다.
    fn read_only_plan(
        &self,
        request: &str,
        steps: &[(String, Vec<String>, Vec<usize>)],
    ) -> Option<String> {
        let lowered = request.to_lowercase();
        if !WRITE_INTENT_WORDS.iter().any(|word| lowered.contains(word)) {
            return None;
        }
        let readers = crate::opencode_config::reading_workspace_tools();
        if steps.is_empty()
            || !steps.iter().all(|(_, tools, _)| {
                !tools.is_empty() && tools.iter().all(|t| readers.contains(&t.as_str()))
            })
        {
            return None;
        }
        let writers: Vec<String> = crate::opencode_config::writing_workspace_tools()
            .iter()
            .filter(|name| self.contains(name))
            .map(|name| (*name).to_owned())
            .collect();
        (!writers.is_empty()).then(|| listed_names(&writers))
    }

    /// 제목이 파일을 고친다고 말하는데 고른 도구가 **전부** 읽기 전용 작업 공간 도구이면
    /// 고칠 수 있는 도구 이름을 돌려준다.
    ///
    /// 플러그인 도구가 하나라도 섞이면 발동하지 않는다 — "노션 페이지 수정"은 파일을 고치는
    /// 말이 아니고, 그 자리는 이미 `plugin_mismatch` 가 본다. 읽기 전용 모드에서는 고칠 수
    /// 있는 도구가 카탈로그에 없으므로 역시 발동하지 않는다. 둘 다 목록에서 읽어 정한다.
    fn writing_intent_mismatch(&self, title: &str, tools: &[String]) -> Option<String> {
        let lowered = title.to_lowercase();
        if !WRITE_INTENT_WORDS.iter().any(|word| lowered.contains(word)) {
            return None;
        }
        let readers = crate::opencode_config::reading_workspace_tools();
        if tools.is_empty() || !tools.iter().all(|t| readers.contains(&t.as_str())) {
            return None;
        }
        let writers: Vec<String> = crate::opencode_config::writing_workspace_tools()
            .iter()
            .filter(|name| self.contains(name))
            .map(|name| (*name).to_owned())
            .collect();
        (!writers.is_empty()).then(|| listed_names(&writers))
    }

    /// 이름들을 받아 정렬·중복 제거한 목록을 만든다.
    ///
    /// 정렬해 두면 오류 문구에 적히는 순서가 호출마다 흔들리지 않는다. 같은 실수에 같은
    /// 문장이 돌아와야 모델도, 이 코드를 읽는 사람도 그것을 같은 실수로 읽는다.
    pub(crate) fn new<I, S>(names: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut names: Vec<String> = names.into_iter().map(Into::into).collect();
        names.sort();
        names.dedup();
        Self {
            names,
            groups: Vec::new(),
        }
    }

    /// 색인을 만든 카탈로그 그대로에서 세운다. 라벨("notion-team · 노션 | notion-personal · 노션")의
    /// 낱말이 그 플러그인의 이름 목록이 된다. 라벨이 빈 묶음(작업 공간 도구)은 이름이 없다.
    pub(crate) fn from_catalogs(catalogs: &[(String, Vec<(String, String)>)]) -> Self {
        let mut catalog = Self::new(
            catalogs
                .iter()
                .flat_map(|(_, tools)| tools.iter().map(|(name, _)| name.clone())),
        );
        for (label, tools) in catalogs {
            // 라벨의 각 조각은 "id · 이름 · 이름…"이다. id 는 뺀다 — `github` 같은 id 가
            // "GitHub 릴리스 페이지를 webfetch 로 읽는" 단계를 되돌리면 안 된다. 사람이
            // 등록한 이름(노션 등)만 "이 플러그인을 말한다"의 근거다.
            let mut aliases: Vec<String> = label
                .split('|')
                .flat_map(|part| part.split('·').skip(1))
                .map(str::trim)
                .filter(|alias| alias.chars().count() >= 2)
                .map(str::to_owned)
                .collect();
            aliases.sort();
            aliases.dedup();
            if aliases.is_empty() || tools.is_empty() {
                continue;
            }
            let mut tools: Vec<String> = tools.iter().map(|(name, _)| name.clone()).collect();
            tools.sort();
            tools.dedup();
            catalog.groups.push(ToolGroup { aliases, tools });
        }
        catalog
    }

    pub(crate) fn groups(&self) -> &[ToolGroup] {
        &self.groups
    }

    /// 제목이 어떤 플러그인의 이름을 말하는데 도구가 그 플러그인 것이 아니면 그 이름과
    /// 묶음을 돌려준다. 이름 비교는 대소문자를 가리지 않는다.
    fn plugin_mismatch(&self, title: &str, tools: &[String]) -> Option<(String, &ToolGroup)> {
        let lowered = title.to_lowercase();
        self.groups.iter().find_map(|group| {
            let alias = group
                .aliases
                .iter()
                .find(|alias| lowered.contains(&alias.to_lowercase()))?;
            let owns = tools.iter().any(|tool| group.tools.contains(tool));
            (!owns).then(|| (alias.clone(), group))
        })
    }

    pub(crate) fn contains(&self, name: &str) -> bool {
        self.names.iter().any(|known| known == name)
    }

    pub(crate) fn names(&self) -> &[String] {
        &self.names
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    /// 실재하는 이름을 오류에 붙일 형태로 적는다. 너무 많으면 앞에서 잘라 남은 수를 밝힌다.
    fn listed(&self) -> String {
        listed_names(&self.names)
    }
}

/// 한 단계가 끝난 뒤의 결말.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum StepOutcome {
    /// 성공. 다음 단계에 실리는 것은 본문이 아니라 이 한 줄 메모다.
    Done { note: String },
    /// 실패. 처리 방법(재시도·건너뜀·재계획·중단)은 9.6이 정하고, 여기서는 사실만 남긴다.
    Failed { reason: String },
    /// 사람이나 모델이 건너뛴 단계.
    Skipped { reason: String },
}

impl StepOutcome {
    fn is_failure(&self) -> bool {
        matches!(self, StepOutcome::Failed { .. })
    }

    /// 마무리 요약의 머리줄에 적히는 한 줄. 결말 종류와 그 한 줄 메모를 붙여 놓는다.
    fn headline(&self) -> String {
        match self {
            StepOutcome::Done { note } => format!("완료: {note}"),
            StepOutcome::Failed { reason } => format!("실패: {reason}"),
            StepOutcome::Skipped { reason } => format!("건너뜀: {reason}"),
        }
    }

    /// 본문 옆에 놓일 머리줄. 메모가 본문의 앞부분과 같으면 결말 종류만 적는다.
    ///
    /// 메모는 본문에서 나온 200자이기 쉽다(글 없이 끝난 턴은 도구 결과가 메모다). 그때
    /// 머리줄에 메모를 그대로 두면 요약이 같은 글을 "잘린 것 + 전문"으로 두 번 읽는다
    /// (2026-09-27 ses_f1dd9ce45). 비교는 메모를 만들 때와 같은 꼴 — 줄바꿈을 공백으로
    /// 편 본문 — 에 대고 한다.
    fn headline_beside(&self, body: &str) -> String {
        let note = match self {
            StepOutcome::Done { note } => note,
            StepOutcome::Failed { reason } => reason,
            StepOutcome::Skipped { reason } => reason,
        };
        let flat = body.trim().replace(['\r', '\n'], " ");
        if !note.is_empty() && flat.starts_with(note.as_str()) {
            return match self {
                StepOutcome::Done { .. } => "완료".to_owned(),
                StepOutcome::Failed { .. } => "실패".to_owned(),
                StepOutcome::Skipped { .. } => "건너뜀".to_owned(),
            };
        }
        self.headline()
    }
}

/// 실패한 단계를 어떻게 할지 — `resolve` 한 호출이 받는 네 갈래.
///
/// 도구를 넷으로 늘리지 않는 이유는 도구 수다. 이 모듈이 존재하는 이유가 "한 턴에 보이는
/// 도구를 줄인다"인데, 실패 처리를 도구 넷으로 펼치면 실행 중에 늘 열려 있는 도구가 넷
/// 늘어난다. 갈래는 도구가 아니라 인자로 받는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StepResolution {
    /// 같은 단계를 다시 돌린다. [`MAX_STEP_RETRIES`]까지만.
    Retry,
    /// 이 단계를 포기하고 다음 단계로 간다. 실패는 실패대로 남는다.
    Skip { reason: String },
    /// 다음 단계로 가기 전에 계획을 고친다. 실행기는 `insert_step`을 연다.
    Replan { reason: String },
    /// 남은 단계를 전부 접고 계획을 끝낸다.
    Abort { reason: String },
}

/// [`Plan::resolve`]가 계획 상태에 실제로 한 일. 실행기는 이것만 보고 다음 행동을 고른다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResolutionEffect {
    /// 그 단계가 다시 진행 지점이 됐다. 남은 재시도 횟수를 함께 준다.
    Retried { remaining: usize },
    /// 계획 상태는 그대로고 다음 단계로 간다.
    Continued,
    /// 다음 단계로 가기 전에 `insert_step`을 열어야 한다.
    Replan,
    /// 남은 단계가 전부 접혔고 계획이 끝났다.
    Aborted { skipped: usize },
}

/// 실패를 어떻게 할지 **사용자에게 물어야 하는지**.
///
/// 로컬 공급자에게 열려 있는 승인 모드는 `Manual`과 `Never` 둘뿐이고
/// ([`ChatApprovalMode::is_supported_by`]), 나머지는 실행 시 `Manual`로 접힌다. `Manual`은
/// 묻고 `Never`는 모델 판단대로 간다.
///
/// `attended`가 따로 있는 것은 무인 실행 때문이다. 예약 실행·회차처럼 화면 앞에 사람이
/// 없는 실행에서 승인 카드를 띄우면, 답할 사람이 없는 채로 턴이 서 있다가 시간만 쓴다.
/// 그래서 무인이면 모드와 무관하게 묻지 않고 `Never`와 같은 길로 간다 — 물을 수 없는
/// 자리에서 묻는 것은 안전한 쪽이 아니라 멈추는 쪽이다.
pub(crate) fn resolution_needs_user(mode: ChatApprovalMode, attended: bool) -> bool {
    attended && matches!(mode, ChatApprovalMode::Manual)
}

/// 실행이 끝난 단계 하나가 남긴 것 전부 — 맥락 밖에 쌓이는 쪽이다.
///
/// [`PlanStep`]과 따로 두는 이유는 번호다. 실행 도중 [`Plan::insert_after`]가 단계를 끼우면
/// 살아 있는 단계의 번호는 전부 다시 매겨지는데, 이미 돌아간 일의 번호까지 따라 움직이면
/// 요약이 "3단계에서 실패"라고 적어 놓고 그 자리에 다른 단계가 서 있게 된다. 그래서 이쪽은
/// **돌아간 차례**를 제 위치로 갖는다 — 쌓인 순서가 곧 일어난 순서다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StepRecord {
    /// 그 단계가 돌 때의 번호. 참조(`uses`)가 이것으로 본문을 찾는다. 쌓인 차례로 세면
    /// 건너뛴 단계가 하나만 생겨도 어긋난다.
    pub(crate) number: usize,
    pub(crate) title: String,
    pub(crate) outcome: StepOutcome,
    /// 실패를 어떻게 하기로 했는지. 실패하지 않았거나 재시도로 끝난 단계에는 없다.
    pub(crate) resolution: Option<String>,
    /// 결과 본문. 다음 단계에는 실리지 않고 마무리 요약에서만 꺼낸다.
    pub(crate) body: String,
}

/// 번호가 매겨진 계획 한 단계.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PlanStep {
    /// 1부터 빈틈없이 이어지는 번호. 이 모듈만 매긴다.
    pub(crate) number: usize,
    pub(crate) title: String,
    /// 이 단계를 실행할 때 스키마를 실을 도구. 실행기의 허용목록이기도 하다(9.4).
    pub(crate) tools: Vec<String>,
    /// 이 단계가 **본문째** 가져다 쓰는 앞 단계 번호(9.10 조각 G).
    ///
    /// 보통은 한 줄 메모면 된다 — "검색 → 그 페이지를 고쳐라"는 다음 단계가 식별자만
    /// 있으면 되는 일이다. 그러나 "자료조사 → 노션에 작성"은 앞 단계의 본문 자체가 재료라
    /// 200자 메모로는 2차가 쓸 내용이 없어 지어내거나 빈 페이지를 만든다. 맥락이 부는 것을
    /// **모델이 필요하다고 말한 자리로 한정**하려고 선언으로 받는다.
    pub(crate) uses: Vec<usize>,
    pub(crate) outcome: Option<StepOutcome>,
    /// 실패를 어떻게 하기로 했는지 한 줄. 결말(`outcome`)과 따로 두는 것은 실패를 덮지
    /// 않기 위해서다 — 요약은 "실패했고, 그래서 이렇게 했다"를 둘 다 말해야 한다.
    pub(crate) resolution: Option<String>,
    /// 지금까지 다시 돌린 횟수. 끼우기로 번호가 바뀌어도 이 값은 단계를 따라간다.
    pub(crate) retries: usize,
}

/// 아직 번호가 없는, 모델이 쌓는 중인 계획.
///
/// 검사를 `finish` 한 번에 몰지 않고 [`PlanDraft::add_step`]마다 한다. 모델은 한 응답에
/// 호출 하나만 보내므로(9.3), 틀린 단계는 그 호출의 답으로 되돌려야 다음 호출에서 고친다.
#[derive(Debug, Clone)]
pub(crate) struct PlanDraft {
    catalog: ToolCatalog,
    steps: Vec<(String, Vec<String>, Vec<usize>)>,
    /// 이 계획 턴에서 색인에 있는 도구를 **곧바로 부른** 이름. 있으면 한 번만 든다.
    ///
    /// 계획 턴에는 조종 도구만 열려 있어서 색인 이름을 직접 부르면 하네스가
    /// `Model tried to call unavailable tool 'webfetch'` 로 되돌린다. 모델은 그 문장을
    /// **그 도구가 없다**는 뜻으로 읽고 곧장 cannot_do 로 간다(2026-09-26 실기기
    /// ses_f2251f5ec: webfetch 를 직접 부른 뒤 "사용 불가하여 조사할 수 없습니다"로 거절).
    /// 사실은 그 도구가 그 단계를 돌릴 때 열린다 — 거절이 틀린 것이다.
    direct_index_call: Option<String>,
    /// 초안이 있는데 거절해서 한 번 되돌렸는지. 두 번째는 그대로 받는다.
    refusal_bounced: bool,
    /// 이 계획 턴이 받은 요청 글. 확정할 때 "요청은 고치라는데 계획이 읽기만 한다"를
    /// 보는 자리가 이것뿐이다 — 단계 제목만으로는 알 수 없다(2026-10-03 12회차).
    request: String,
    /// 읽기만 하는 계획을 확정하려다 한 번 되돌렸는지. 두 번째는 그대로 받는다.
    read_only_plan_bounced: bool,
}

impl PlanDraft {
    pub(crate) fn new(catalog: ToolCatalog) -> Self {
        Self {
            catalog,
            steps: Vec::new(),
            direct_index_call: None,
            refusal_bounced: false,
            request: String::new(),
            read_only_plan_bounced: false,
        }
    }

    /// 이 초안이 답할 요청 글을 실어 둔다.
    ///
    /// 되묻기 하나를 위해서만 쓴다. 요청 글 자체는 계획 상태에 남지 않아도 되지만,
    /// `finish` 가 "요청은 고치라는데 모든 단계가 읽기 전용"을 보려면 여기가 유일한
    /// 자리다.
    pub(crate) fn with_request(mut self, request: &str) -> Self {
        self.request = request.to_owned();
        self
    }

    /// 색인 도구를 곧바로 부른 것을 적어 둔다. 먼저 부른 이름만 든다.
    pub(crate) fn note_direct_index_call(&mut self, name: &str) {
        if self.direct_index_call.is_none() {
            self.direct_index_call = Some(name.to_owned());
        }
    }

    /// 적어 둔 것을 꺼내며 **지운다.** 한 번만 되돌려 주고, 같은 턴에서 다시 거절하면
    /// 그때는 그대로 받는다 — 진짜로 못 하는 일까지 영영 막으면 안 된다.
    fn take_direct_index_call(&mut self) -> Option<String> {
        self.direct_index_call.take()
    }

    /// 초안이 있는데 거절해서 한 번 되돌린 적이 있는지. 꺼내며 세운다 — 두 번째 거절은
    /// 그대로 받는다.
    fn take_refusal_bounced(&mut self) -> bool {
        std::mem::replace(&mut self.refusal_bounced, true)
    }

    /// 요청은 고치라는데 모든 단계가 읽기만 하면 **한 번** 되돌린다.
    ///
    /// 두 번째 `finish_plan` 은 그대로 받는다. 거절과 같은 규율이다 — 되묻기가 영영
    /// 막으면 진짜로 읽기만 하면 되는 요청이 갇힌다.
    fn bounce_read_only_plan(&mut self) -> Result<(), CoreError> {
        if self.read_only_plan_bounced {
            return Ok(());
        }
        let Some(writers) = self.catalog.read_only_plan(&self.request, &self.steps) else {
            return Ok(());
        };
        self.read_only_plan_bounced = true;
        Err(CoreError::InvalidInput(read_only_plan_message(&writers)))
    }

    /// 모델에 되돌려주는 기존 계획 응답. 탐침도 이 계약을 읽어 같은 고리를 돈다.
    pub(crate) fn receipt(&self) -> Value {
        json!({"step": self.len(), "next": "Call finish_plan only when every step of the plan is written. Otherwise, write the next step with add_step"})
    }

    pub(crate) fn nudge_text(&self) -> String {
        let steps = self.len();
        if steps == 0 {
            "No plan has been made yet. Write the steps one at a time with add_step, then call finish_plan when done. If the request needs no tools, answer directly with answer_now; if it cannot be done with the given tools, call cannot_do.".to_owned()
        } else {
            format!("{steps} step(s) have been written so far, but the plan is not confirmed yet. Call finish_plan only when every step of the plan is written. Otherwise, write the next step with add_step.")
        }
    }

    pub(crate) fn catalog(&self) -> &ToolCatalog {
        &self.catalog
    }

    pub(crate) fn len(&self) -> usize {
        self.steps.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }

    /// 단계 하나를 뒤에 붙이고 그 단계에 매겨진 번호를 돌려준다.
    ///
    /// 번호는 인자로 받지 않는다 — 모델이 주는 것은 순서뿐이다.
    pub(crate) fn add_step(
        &mut self,
        title: &str,
        tools: &[String],
        uses: &[usize],
    ) -> Result<usize, CoreError> {
        if self.steps.len() >= MAX_PLAN_STEPS {
            return Err(CoreError::InvalidInput(format!(
                "A plan may have at most {MAX_PLAN_STEPS} steps. Merge steps or split the work"
            )));
        }
        let title = normalize_title(title)?;
        let tools = normalize_tools(&self.catalog, tools)?;
        if let Some((alias, group)) = self.catalog.plugin_mismatch(&title, &tools) {
            return Err(CoreError::InvalidInput(plugin_mismatch_message(
                &alias,
                &listed_names(&group.tools),
            )));
        }
        if let Some(writers) = self.catalog.writing_intent_mismatch(&title, &tools) {
            return Err(CoreError::InvalidInput(writing_intent_message(
                &listed_names(&tools),
                &writers,
            )));
        }
        let uses = normalize_uses(uses, self.steps.len())?;
        self.steps.push((title, tools, uses));
        Ok(self.steps.len())
    }

    /// 주어진 도구로는 할 수 없다고 끝낸다(`cannot_do`).
    ///
    /// 계획 고리에 이 출구가 없으면 모델은 할 수 없는 일에도 그럴듯한 단계를 세운다
    /// (2026-09-25 실측: 거절 도구를 빼자 불가능한 과제 6건이 전부 계획으로 돌아왔다).
    /// 단계가 다 "성공"하고 아무것도 되지 않은 채 끝나는 것이 실사용에서 제일 아픈
    /// 실패라, 거절은 계획 상태가 표현할 수 있어야 하는 결말이지 배선의 예외가 아니다.
    ///
    /// 여기까지 쌓인 단계는 할 수 없는 일에 붙은 것이므로 함께 버린다 — `self`를 가져가는
    /// 것이 그 뜻이다.
    pub(crate) fn refuse(self, reason: &str) -> Result<PlanRefusal, CoreError> {
        let reason = reason.trim();
        if reason.is_empty() {
            return Err(CoreError::InvalidInput(
                "You must state why it cannot be done".to_string(),
            ));
        }
        if reason.chars().count() > MAX_REFUSAL_REASON_CHARS {
            return Err(CoreError::InvalidInput(format!(
                "The refusal reason must be at most {MAX_REFUSAL_REASON_CHARS} characters"
            )));
        }
        Ok(PlanRefusal {
            reason: reason.to_string(),
        })
    }

    /// 쌓은 단계에 번호를 매겨 계획으로 만든다.
    pub(crate) fn finish(self) -> Result<Plan, CoreError> {
        if self.steps.is_empty() {
            return Err(CoreError::InvalidInput(
                "A plan needs at least one step".to_string(),
            ));
        }
        let steps = self
            .steps
            .into_iter()
            .enumerate()
            .map(|(index, (title, tools, uses))| PlanStep {
                number: index + 1,
                title,
                tools,
                uses,
                outcome: None,
                resolution: None,
                retries: 0,
            })
            .collect();
        Ok(Plan {
            catalog: self.catalog,
            steps,
            archive: Vec::new(),
            pending: None,
            decisions: Vec::new(),
        })
    }
}

/// 번호가 매겨진 계획과 그 진행 상태.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Plan {
    catalog: ToolCatalog,
    steps: Vec<PlanStep>,
    /// 끝난 단계가 남긴 것이 돌아간 차례대로 쌓인다. 맥락에는 실리지 않는다.
    archive: Vec<StepRecord>,
    /// 사용자의 답을 기다리는 갈림길. 있으면 계획은 멈춰 있다(9.7).
    pending: Option<PendingDecision>,
    /// 지나온 갈림길과 거기서 고른 것. 누가 골랐는지까지 남긴다.
    decisions: Vec<DecisionRecord>,
}

impl Plan {
    pub(crate) fn steps(&self) -> &[PlanStep] {
        &self.steps
    }

    pub(crate) fn catalog(&self) -> &ToolCatalog {
        &self.catalog
    }

    /// 아직 결말이 없는 첫 단계. 없으면 계획이 끝난 것이다.
    pub(crate) fn current(&self) -> Option<&PlanStep> {
        self.steps.iter().find(|step| step.outcome.is_none())
    }

    pub(crate) fn is_complete(&self) -> bool {
        self.current().is_none()
    }

    pub(crate) fn has_failure(&self) -> bool {
        self.steps
            .iter()
            .any(|step| step.outcome.as_ref().is_some_and(StepOutcome::is_failure))
    }

    /// 앞선 단계들이 남긴 한 줄 메모. 다음 단계의 맥락에 실리는 것은 이것뿐이다(9.4).
    pub(crate) fn notes(&self) -> Vec<(usize, &str)> {
        self.steps
            .iter()
            .filter_map(|step| match step.outcome.as_ref() {
                Some(StepOutcome::Done { note }) => Some((step.number, note.as_str())),
                _ => None,
            })
            .collect()
    }

    /// 단계의 결말을 적는다. 이미 끝난 단계는 다시 적지 않는다 — 실행기가 같은 단계를 두 번
    /// 돌렸다는 뜻이라, 조용히 덮으면 그 사실이 사라진다.
    ///
    /// `body`는 그 단계가 실제로 받아 온 것 전부다. 결말에 딸린 한 줄 메모만 다음 단계에
    /// 실리고(`notes`), 본문은 [`Plan::archive`]에 쌓여 마무리 요약에서만 나온다 — 본문을
    /// 맥락에 두면 단계가 진행될수록 계획으로 아낀 것을 그대로 잃는다. 남길 것이 없으면
    /// 빈 문자열을 준다. 결말과 본문을 한 호출로 받는 것은 둘이 갈라지지 않게 하기
    /// 위해서다: 본문만 따로 적는 길을 두면 결말은 적혔는데 본문은 빠진 단계가 생긴다.
    pub(crate) fn record(
        &mut self,
        number: usize,
        outcome: StepOutcome,
        body: &str,
    ) -> Result<(), CoreError> {
        let outcome = match outcome {
            StepOutcome::Done { note } => StepOutcome::Done {
                note: clamp_note(&note),
            },
            StepOutcome::Failed { reason } => StepOutcome::Failed {
                reason: clamp_note(&reason),
            },
            StepOutcome::Skipped { reason } => StepOutcome::Skipped {
                reason: clamp_note(&reason),
            },
        };
        let step = self
            .steps
            .iter_mut()
            .find(|step| step.number == number)
            .ok_or_else(|| CoreError::NotFound(format!("{number}단계가 계획에 없습니다")))?;
        if step.outcome.is_some() {
            return Err(CoreError::Conflict(format!(
                "{number}단계는 이미 끝났습니다"
            )));
        }
        step.outcome = Some(outcome.clone());
        let title = step.title.clone();
        self.archive.push(StepRecord {
            number,
            title,
            outcome,
            resolution: None,
            body: clamp_body(body),
        });
        Ok(())
    }

    /// 쌓아 둔 결과 전부를 돌아간 차례대로 돌려준다.
    pub(crate) fn records(&self) -> &[StepRecord] {
        &self.archive
    }

    /// 도구를 부르지 않고 끝난 단계를 실행기가 스스로 다시 보낸다.
    ///
    /// 2026-09-27 실기기 ses_f1d138d25ffeoAu3sP0ofQteTy: 2단계에서 모델이 "지금 호출하겠다"는
    /// 글만 쓰고 턴을 끝냈다. 실패로 닫고 종합으로 넘어가자 종합 턴에서 뒤늦게 도구를
    /// 불러 `invalid` 로 되돌아왔고, 분류는 맞았는데 아무것도 적히지 않았다. 아무것도
    /// 시도하지 않은 단계는 판단할 실패가 아니라 아직 돌지 않은 단계다 — 같은 단계를 더
    /// 강한 지시로 한 번 더 보낸다. 상한은 [`MAX_STEP_RETRIES`] 를 그대로 쓴다.
    ///
    /// 실패했던 기록은 지운다. 다시 돌 단계이므로 마무리 요약에 "실패 뒤 완료"가 두 줄로
    /// 남을 이유가 없다.
    pub(crate) fn retry_unstarted(&mut self, number: usize) -> bool {
        if self.resolve(number, StepResolution::Retry).is_err() {
            return false;
        }
        self.archive.retain(|record| record.number != number);
        true
    }

    /// 실패한 단계를 어떻게 할지 정한 것을 계획 상태에 적용한다(9.6).
    ///
    /// **실패한 단계에만 부를 수 있다.** 성공한 단계에 `retry`가 들어오면 이미 쌓인 결과가
    /// 있는 자리를 다시 돌리게 되고, 아직 돌지 않은 단계에 `skip`이 들어오면 일어나지 않은
    /// 일이 처리된 것으로 남는다. 둘 다 조용히 받아 주면 나중에 요약이 거짓말을 한다.
    ///
    /// `skip`과 `replan`이 계획 상태를 똑같이 두는 것은 의도다. 실패한 단계는 이미 결말이
    /// 적혀 있어 [`Plan::current`]가 다음 단계를 가리키고 있으므로, 둘의 차이는 계획이
    /// 아니라 **실행기가 다음에 무엇을 여는가**에 있다 — `replan`만 `insert_step`을 연다.
    /// 실패를 `Skipped`로 고쳐 쓰지 않는 것도 같은 이유다: 넘어가기로 한 것이 실패였다는
    /// 사실은 마무리 요약이 그대로 말해야 한다.
    pub(crate) fn resolve(
        &mut self,
        number: usize,
        resolution: StepResolution,
    ) -> Result<ResolutionEffect, CoreError> {
        let step = self
            .steps
            .iter_mut()
            .find(|step| step.number == number)
            .ok_or_else(|| CoreError::NotFound(format!("{number}단계가 계획에 없습니다")))?;
        let title = step.title.clone();
        if !step.outcome.as_ref().is_some_and(StepOutcome::is_failure) {
            return Err(CoreError::Conflict(format!(
                "{number}단계는 실패한 단계가 아닙니다. 실패한 단계에만 쓸 수 있습니다"
            )));
        }
        match resolution {
            StepResolution::Retry => {
                if step.retries >= MAX_STEP_RETRIES {
                    return Err(CoreError::Conflict(format!(
                        "{number}단계는 이미 {MAX_STEP_RETRIES}번 다시 돌렸습니다. skip·replan·abort 중에서 고르세요"
                    )));
                }
                step.retries += 1;
                step.outcome = None;
                Ok(ResolutionEffect::Retried {
                    remaining: MAX_STEP_RETRIES - step.retries,
                })
            }
            // 결말은 실패로 그대로 두고 판단만 덧붙인다. 요약이 "실패했고, 그래서 이렇게
            // 했다"를 다 말해야 한다 — 사유를 받아 놓고 버리면 받은 이유가 없다.
            StepResolution::Skip { reason } => {
                let note = format!("건너뜀: {}", clamp_note(&reason));
                step.resolution = Some(note.clone());
                self.note_resolution(&title, note);
                Ok(ResolutionEffect::Continued)
            }
            StepResolution::Replan { reason } => {
                let note = format!("재계획: {}", clamp_note(&reason));
                step.resolution = Some(note.clone());
                self.note_resolution(&title, note);
                Ok(ResolutionEffect::Replan)
            }
            StepResolution::Abort { reason } => {
                let reason = clamp_note(&reason);
                let note = format!("중단: {reason}");
                step.resolution = Some(note.clone());
                self.note_resolution(&title, note);
                let mut skipped = 0;
                for step in self.steps.iter_mut() {
                    if step.outcome.is_none() {
                        step.outcome = Some(StepOutcome::Skipped {
                            reason: reason.clone(),
                        });
                        skipped += 1;
                    }
                }
                Ok(ResolutionEffect::Aborted { skipped })
            }
        }
    }

    /// 방금 실패한 그 기록에 판단을 붙인다.
    ///
    /// 기록은 [`Plan::finish_step`]이 결말을 적는 순간 쌓이고 판단은 그 뒤에 온다. 같은
    /// 단계가 재시도로 여러 번 실패했을 수 있으므로 뒤에서부터 첫 실패를 찾는다 — 지금
    /// 처리하는 것이 마지막 실패다.
    fn note_resolution(&mut self, title: &str, note: String) {
        if let Some(record) = self
            .archive
            .iter_mut()
            .rev()
            .find(|record| record.title == title && record.outcome.is_failure())
        {
            record.resolution = Some(note);
        }
    }

    /// 마무리 요약에 실을 글을 만든다 — 쌓아 둔 본문을 꺼내 쓰는 유일한 자리다(9.5).
    ///
    /// 단계마다 머리줄(돌아간 차례·제목·결말 한 줄)과 본문을 붙인다. 전체가
    /// [`MAX_SUMMARY_CHARS`]를 넘지 않도록 **단계 수로 나눈 몫을 본문마다 똑같이** 준다.
    /// 앞에서부터 채우고 넘치면 자르는 방식을 쓰지 않는 것은, 그러면 맨 뒤 단계 — 대개
    /// 결론이 있는 쪽 — 의 본문이 통째로 사라지기 때문이다. 잘린 본문은 몇 자를 줄였는지
    /// 함께 적는다. 요약이 무엇을 보지 못했는지는 요약을 읽는 쪽이 알아야 한다.
    pub(crate) fn summary_input(&self) -> String {
        if self.archive.is_empty() {
            return String::new();
        }
        let budget = (MAX_SUMMARY_CHARS / self.archive.len()).max(1);
        let mut text = String::new();
        for (index, record) in self.archive.iter().enumerate() {
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(&format!(
                "{}. {} — {}",
                index + 1,
                record.title,
                record.outcome.headline_beside(&record.body)
            ));
            // 실패를 어떻게 하기로 했는지도 머리줄에 붙인다. 결말만 적으면 요약이 "실패"
            // 까지만 말하고 그래서 무엇을 했는지는 말하지 않는다.
            if let Some(resolution) = &record.resolution {
                text.push_str(&format!(" ({resolution})"));
            }
            if record.body.is_empty() {
                continue;
            }
            text.push('\n');
            let length = record.body.chars().count();
            if length <= budget {
                text.push_str(&record.body);
            } else {
                text.extend(record.body.chars().take(budget));
                text.push_str(&format!("\n…({}자 줄임)", length - budget));
            }
        }
        text
    }

    /// 실행 도중에 단계를 끼운다. 모델은 "무엇 다음"만 말하고 번호는 여기서 다시 매긴다.
    ///
    /// `after`가 `None`이면 맨 앞에 끼운다. 이미 끝난 단계 뒤라도 끼울 수 있다 — 3단계를
    /// 하고 나서야 그 사이에 할 일이 보이는 것이 재계획의 정상적인 모습이다. 끼운 단계는
    /// 결말 없이 들어가므로, 끝난 단계 사이에 끼우면 그 자리가 다시 진행 지점이 된다.
    pub(crate) fn insert_after(
        &mut self,
        after: Option<usize>,
        title: &str,
        tools: &[String],
    ) -> Result<usize, CoreError> {
        if self.steps.len() >= MAX_PLAN_STEPS {
            return Err(CoreError::InvalidInput(format!(
                "계획은 {MAX_PLAN_STEPS}단계까지만 세울 수 있습니다. 단계를 합치거나 일을 나누세요"
            )));
        }
        let title = normalize_title(title)?;
        let tools = normalize_tools(&self.catalog, tools)?;
        let index = match after {
            None => 0,
            Some(number) => {
                self.steps
                    .iter()
                    .position(|step| step.number == number)
                    .ok_or_else(|| CoreError::NotFound(format!("{number}단계가 계획에 없습니다")))?
                    + 1
            }
        };
        self.steps.insert(
            index,
            PlanStep {
                number: 0,
                title,
                tools,
                // 끼운 단계는 참조를 갖지 않는다. 실행 중에 번호가 다시 매겨지는 자리라,
                // 여기서 받은 번호가 무엇을 가리키는지 확정할 수 없다.
                uses: Vec::new(),
                outcome: None,
                resolution: None,
                retries: 0,
            },
        );
        self.renumber();
        Ok(index + 1)
    }

    /// 지금 돌아야 할 단계로 실행 상태를 만든다. 계획이 끝났으면 `None`이다.
    ///
    /// 한 단계는 추론 한 번이 아니라 작은 고리다 — 한 응답에 호출이 하나만 오기 때문에,
    /// 실행기는 이 상태를 들고 그 단계가 끝날 때까지 여러 번 돈다. 그래서 만들어 두고
    /// 재사용하는 값이지 호출마다 다시 만드는 값이 아니다.
    pub(crate) fn begin_step(&self) -> Option<StepExecution> {
        let step = self.current()?;
        Some(StepExecution {
            number: step.number,
            title: step.title.clone(),
            allowed: step.tools.clone(),
            attempt: step.retries,
            notes: self
                .notes()
                .into_iter()
                .map(|(number, note)| (number, note.to_string()))
                .collect(),
            inputs: step
                .uses
                .iter()
                .filter_map(|number| {
                    self.archive
                        .iter()
                        .find(|record| record.number == *number)
                        .map(|record| (*number, record.body.clone()))
                })
                .collect(),
        })
    }

    /// 갈림길을 연다 — 단계가 **성공했는데** 골라야 할 때다(9.7).
    ///
    /// 실패([`Plan::resolve`], 9.6)와 다른 설정을 본다. 실패는 "이 단계를 어떻게 할
    /// 것인가"라 계획 자체가 흔들린 자리지만, 여기는 단계가 제 일을 해냈고 그 결과가 둘
    /// 이상이어서 하나를 골라야 하는 자리다 — 검색에 페이지가 셋 나왔거나 같은 이름이 이미
    /// 있을 때. 그래서 처리 방식도 승인 모드([`resolution_needs_user`])가 아니라
    /// **결정정책**이 정한다.
    ///
    /// - [`AiaDecisionPolicy::Recommended`]: 추천안을 그 자리에서 고르고 무엇을 골랐는지
    ///   남긴다([`Plan::decisions`]). 계획은 멈추지 않는다.
    /// - [`AiaDecisionPolicy::Ask`]: 선택지와 추천안을 들고 멈춘다. 계획은 이때부터
    ///   [`Plan::is_awaiting_decision`]이고, [`Plan::answer_decision`]이 오기 전에는
    ///   아무 단계도 돌리지 않는다.
    ///
    /// 멈춘 상태가 값으로 남는 것이 중요하다. 계획이 통째로 직렬화되므로(`Serialize`),
    /// 대기 중인 갈림길은 앱이 내려갔다 올라와도 같은 자리에서 이어진다 — 중단·재개는
    /// 나중에 얹을 수 있는 것이 아니라 상태가 그 모양이어야 가능한 일이다.
    pub(crate) fn decide(
        &mut self,
        question: &str,
        options: &[String],
        recommended: &str,
        policy: AiaDecisionPolicy,
    ) -> Result<DecisionOutcome, CoreError> {
        if self.pending.is_some() {
            return Err(CoreError::Conflict(
                "이미 사용자의 답을 기다리는 갈림길이 있습니다".to_string(),
            ));
        }
        let step = self
            .current()
            .map(|step| step.number)
            .ok_or_else(|| CoreError::Conflict("끝난 계획에는 갈림길이 없습니다".to_string()))?;
        let question = normalize_decision_text(question)?;
        let options = normalize_options(options)?;
        let recommended = parse_choice(&options, recommended)?;
        match policy {
            AiaDecisionPolicy::Recommended => {
                let chosen = options[recommended].clone();
                self.decisions.push(DecisionRecord {
                    step,
                    question,
                    chosen: chosen.clone(),
                    by: DecidedBy::Model,
                });
                Ok(DecisionOutcome::Chosen(chosen))
            }
            AiaDecisionPolicy::Ask => {
                self.pending = Some(PendingDecision {
                    step,
                    question,
                    options,
                    recommended,
                });
                Ok(DecisionOutcome::Awaiting)
            }
        }
    }

    /// 답을 기다리는 갈림길. 화면에 그대로 내보내는 값이다.
    pub(crate) fn pending_decision(&self) -> Option<&PendingDecision> {
        self.pending.as_ref()
    }

    /// 멈춰 있는가. 실행기는 이것이 참인 동안 [`Plan::begin_step`]을 돌리지 않는다.
    pub(crate) fn is_awaiting_decision(&self) -> bool {
        self.pending.is_some()
    }

    /// 사용자의 답을 받아 갈림길을 닫고 고른 것을 돌려준다.
    ///
    /// `choice`는 선택지의 글 그대로거나 1부터 세는 번호다. 둘 다 받는 이유는
    /// [`parse_insert_after`]와 같다 — 어느 쪽으로 올지 정해 놓고 기다리면 다른 쪽으로
    /// 왔을 때 답이 버려진다. 없는 답이 오면 선택지를 함께 돌려주고 갈림길은 열어 둔다.
    pub(crate) fn answer_decision(&mut self, choice: &str) -> Result<String, CoreError> {
        let pending = self
            .pending
            .as_ref()
            .ok_or_else(|| CoreError::Conflict("기다리는 갈림길이 없습니다".to_string()))?;
        let index = parse_choice(&pending.options, choice)?;
        let chosen = pending.options[index].clone();
        let record = DecisionRecord {
            step: pending.step,
            question: pending.question.clone(),
            chosen: chosen.clone(),
            by: DecidedBy::User,
        };
        self.pending = None;
        self.decisions.push(record);
        Ok(chosen)
    }

    /// 지나온 갈림길 전부. 추천안을 스스로 고른 경우에도 남으므로, "무엇을 어떻게 골랐는지"는
    /// 결정정책과 무관하게 이 목록 하나로 읽는다.
    pub(crate) fn decisions(&self) -> &[DecisionRecord] {
        &self.decisions
    }

    /// 번호를 1부터 빈틈없이 다시 매긴다. 끼우기 뒤에 반드시 부른다.
    fn renumber(&mut self) {
        for (index, step) in self.steps.iter_mut().enumerate() {
            step.number = index + 1;
        }
    }
}

/// 제목을 다듬고 상한에 걸리는지 본다.
fn normalize_title(title: &str) -> Result<String, CoreError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CoreError::InvalidInput(
            "The step title is empty".to_string(),
        ));
    }
    if title.chars().any(|ch| ch.is_control()) {
        return Err(CoreError::InvalidInput(
            "The step title may not contain control characters".to_string(),
        ));
    }
    // 긴 제목은 잘라 받는다. 거절하면 모델이 제목을 줄이는 데 턴을 쓰고, 그 사이 다른
    // 단계가 먼저 수락돼 순서가 뒤집힌다(2026-09-27 ses_f1eb2aa91: 세 번 거절되는 동안
    // 실행 단계가 1단계가 됐다). 제목은 다음 단계에 실리는 한 줄 라벨이라 잘려도 잃는
    // 것이 없다.
    Ok(title.chars().take(MAX_STEP_TITLE_CHARS).collect())
}

/// 단계가 선언한 도구를 다듬고, 실재하는 이름인지·상한 안인지 본다.
///
/// 없는 이름을 만나면 실재하는 목록을 문구에 함께 실어 돌려준다. 그것이 모델이 다음
/// 호출에서 고칠 수 있는 유일한 단서다.
/// 한 단계가 본문째 가져다 쓸 수 있는 앞 단계 수.
///
/// 본문은 4,000자까지라 둘만 실어도 8,000자다. 계획으로 아낀 맥락을 여기서 다 쓰지 않도록
/// 묶어 둔다 — 더 필요하면 단계를 쪼갤 일이지 상한을 올릴 일이 아니다.
pub(crate) const MAX_USES_PER_STEP: usize = 2;

/// 참조가 **앞 단계**를 가리키는지 본다. 아직 없는 단계나 자기 자신은 받지 않는다.
fn normalize_uses(uses: &[usize], added_so_far: usize) -> Result<Vec<usize>, CoreError> {
    if uses.len() > MAX_USES_PER_STEP {
        return Err(CoreError::InvalidInput(format!(
            "A step may take the full result of at most {MAX_USES_PER_STEP} earlier step(s)"
        )));
    }
    let mut normalized: Vec<usize> = Vec::new();
    for number in uses {
        if *number == 0 || *number > added_so_far {
            return Err(CoreError::InvalidInput(format!(
                "Step {number} does not exist yet. Only numbers of steps already written may be used"
            )));
        }
        if !normalized.contains(number) {
            normalized.push(*number);
        }
    }
    Ok(normalized)
}

fn normalize_tools(catalog: &ToolCatalog, tools: &[String]) -> Result<Vec<String>, CoreError> {
    let mut normalized: Vec<String> = Vec::new();
    for tool in tools {
        let tool = tool.trim();
        if tool.is_empty() {
            continue;
        }
        if !catalog.contains(tool) {
            return Err(CoreError::InvalidInput(format!(
                "There is no tool named '{tool}'. Available tools: {}",
                catalog.listed()
            )));
        }
        if !normalized.iter().any(|kept| kept == tool) {
            normalized.push(tool.to_string());
        }
    }
    if normalized.is_empty() {
        return Err(CoreError::InvalidInput(format!(
            "Each step must name at least one tool. Available tools: {}",
            catalog.listed()
        )));
    }
    if normalized.len() > MAX_TOOLS_PER_STEP {
        return Err(CoreError::InvalidInput(format!(
            "A step may use at most {MAX_TOOLS_PER_STEP} tool(s). Split the step"
        )));
    }
    Ok(normalized)
}

/// 한 단계를 도는 동안 실행기가 들고 있는 것 — 9.4가 세우는 자리다.
///
/// [`Plan`]에서 떼어 두는 이유는 **집행 지점**이다. 허용목록을 계획 안에만 두면 그것을
/// 읽는 곳은 프롬프트를 만드는 쪽뿐이고, 프롬프트로만 정해 둔 목록은 모델이 넘어간다
/// (완료 기준). 껍데기가 도구 호출마다 물어볼 수 있는 값으로 떼어 놓아야 집행이 서버에서
/// 일어난다. 그래서 이것은 계획을 빌려 보는 참조가 아니라 그 단계의 사실을 복사해 든다 —
/// 실행 중에 [`Plan::insert_after`]가 번호를 다시 매겨도, 지금 돌고 있는 단계의 허용목록이
/// 그 때문에 바뀌지는 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StepExecution {
    number: usize,
    title: String,
    allowed: Vec<String>,
    /// 몇 번째 시도인지. 0 이 첫 시도다. 도구를 부르지 않고 끝난 단계를 다시 보낼 때 오른다.
    attempt: usize,
    /// 앞선 단계들이 남긴 한 줄 메모. 기본으로 맥락에 실리는 것은 이것뿐이다.
    notes: Vec<(usize, String)>,
    /// 이 단계가 **본문째** 달라고 선언한 앞 단계(9.10 조각 G). 선언한 자리에서만 붙는다.
    inputs: Vec<(usize, String)>,
}

impl StepExecution {
    pub(crate) fn number(&self) -> usize {
        self.number
    }

    pub(crate) fn title(&self) -> &str {
        &self.title
    }

    /// 이 단계가 부를 수 있는 일하는 도구. 계획을 움직이는 도구는 여기 없다 —
    /// [`StepExecution::authorize`]가 따로 통과시킨다.
    pub(crate) fn allowed_tools(&self) -> &[String] {
        &self.allowed
    }

    /// 이 단계에 실을 도구 스키마. 전체 목록에서 이 단계가 선언한 것만 고르고, 계획을
    /// 움직이는 도구를 그 옆에 붙인다.
    ///
    /// 선언한 도구의 스키마가 전체 목록에 없으면 **거절한다.** 조용히 빼면 모델은 그 도구를
    /// 부르라는 말만 듣고 스키마는 못 받은 채로 단계를 시작하고, 그러면 이름을 지어낸다 —
    /// 이 모듈이 막으려는 바로 그 자리다. 계획을 세울 때 이름을 맞춰 봤어도(`ToolCatalog`)
    /// 실행 시점의 서버 목록은 그 사이에 달라질 수 있으므로 여기서 다시 본다.
    /// 이 단계를 돌릴 때 보내는 글.
    ///
    /// 앞 단계의 **한 줄 메모**만 싣는다. 본문은 맥락 밖에 쌓여 있고 마무리 요약에서만
    /// 나온다 — 단계마다 본문을 실으면 계획으로 아낀 맥락을 그대로 잃는다. 그래서 지금
    /// 모양으로는 "앞 단계의 본문 자체가 재료"인 일을 못 한다(작업 9.10 조각 G가 그 자리다).
    ///
    /// 무엇을 하라는지를 **맨 끝에** 둔다. 메모가 길어져도 지시가 마지막에 오게 한다.
    /// `via_shell` 은 이 단계의 도구가 **플러그인 도구**인지다.
    ///
    /// 껍데기 묶음에서는 그 이름을 직접 부를 수 없고 `call_tool` 을 거쳐야 하는데, 단계
    /// 지시에 이름만 적어 두면 모델이 그것을 직접 부르고 하네스가 `invalid` 로 되돌린다 —
    /// 2026-09-26 실기기에서 실제로 한 턴을 그렇게 썼다(스스로 고쳐 도착하기는 했다).
    /// 부르는 법을 아는 쪽은 우리이므로 우리가 적어 준다.
    pub(crate) fn turn_prompt(&self, via_shell: bool) -> String {
        let mut text = String::new();
        if !self.notes.is_empty() {
            text.push_str(
                "앞 단계에서 이렇게 됐다.
",
            );
            for (number, note) in &self.notes {
                text.push_str(&format!(
                    "{number}. {note}
"
                ));
            }
            text.push('\n');
        }
        for (number, body) in &self.inputs {
            text.push_str(&format!(
                "{number}단계가 받아 온 것:
{body}

"
            ));
        }
        text.push_str(&format!(
            "이제 {}단계다: {}
",
            self.number, self.title
        ));
        if via_shell {
            text.push_str(&format!(
                "이 단계의 도구는 플러그인 도구라 직접 부를 수 없다. **먼저** find_tool 로 \"{}\" 의 인자 모양을 확인하고, 그 다음 call_tool 의 tool 에 그 이름을 적어 부른다. 인자를 짐작해서 부르지 마라 — 틀린 모양으로 여러 번 부르는 것보다 한 번 확인하는 편이 싸다.
",
                self.allowed.join(", ")
            ));
        } else {
            text.push_str(
                "열려 있는 도구로 이 단계를 끝내라.
",
            );
        }
        // 2026-09-27 ses_f1eb2aa91: 호출문을 JSON 코드 블록으로 적고 끝낸 단계가 있었다.
        text.push_str(
            "도구는 실제로 호출한다. 호출문을 글이나 코드 블록으로 적는 것은 실행이 아니다.\n",
        );
        if self.attempt > 0 {
            // 다시 보내는 단계. 앞 턴이 무엇을 빠뜨렸는지 말하고 설명을 금한다 — 설명이 길면
            // 그 끝에서 턴이 끝난다(ses_f1d138d25: "Let me execute the first 5 calls now:" 뒤 종료).
            text.push_str(&format!(
                "앞 턴에서 이 단계의 도구를 부르지 않고 글만 쓰고 끝냈다. 이번에는 설명을 적지 말고 {} 을(를) 바로 호출하라. 호출할 것이 여럿이면 하나 부르고 결과를 본 뒤 다음을 부른다.\n",
                if via_shell { "call_tool".to_owned() } else { self.allowed.join(", ") }
            ));
        }
        text.push_str("이 단계만 하고 멈춰라. 다음 단계는 다음에 한다.");
        text
    }

    pub(crate) fn tool_schemas(&self, catalog: &[Value]) -> Result<Vec<Value>, CoreError> {
        let mut schemas = Vec::with_capacity(self.allowed.len() + 1);
        for name in &self.allowed {
            let schema = catalog
                .iter()
                .find(|schema| schema.get("name").and_then(Value::as_str) == Some(name.as_str()))
                .ok_or_else(|| {
                    CoreError::NotFound(format!(
                        "{}단계가 선언한 '{name}' 도구의 스키마가 지금 서버에 없습니다",
                        self.number
                    ))
                })?;
            schemas.push(schema.clone());
        }
        schemas.extend(step_control_tool_schemas());
        Ok(schemas)
    }

    /// 도구 호출 하나를 통과시킬지 정한다 — 껍데기가 호출마다 부르는 자리다.
    ///
    /// 통과하는 것은 이 단계가 선언한 도구와 실행 중에 늘 열려 있는 도구
    /// ([`step_control_tool_schemas`])뿐이다. 막을 때는 이 단계에서 쓸 수 있는 이름을 함께
    /// 돌려준다 — 계획 검사와 같은 이유다. "안 됩니다"로만 답하면 같은 이름을 다시 부른다.
    pub(crate) fn authorize(&self, tool: &str) -> Result<(), CoreError> {
        let tool = tool.trim();
        if self.allowed.iter().any(|allowed| allowed == tool) {
            return Ok(());
        }
        if step_control_tool_names().iter().any(|name| name == tool) {
            return Ok(());
        }
        Err(CoreError::InvalidInput(format!(
            "'{tool}'는 {}단계에서 쓸 수 없는 도구입니다. 이 단계에서 쓸 수 있는 도구: {}",
            self.number,
            if self.allowed.is_empty() {
                "(없음)".to_string()
            } else {
                self.allowed.join(", ")
            }
        )))
    }

    /// 이 단계의 맥락에 실을 글. 앞 단계의 한 줄 메모뿐이고 본문은 들어가지 않는다.
    ///
    /// 본문은 [`Plan::records`]에 쌓여 마무리 요약에서만 나온다(9.5). 여기에 본문을 실으면
    /// 단계가 진행될수록 맥락이 도로 불어나, 도구 수를 단계 단위로 줄여 아낀 것을 그대로
    /// 잃는다.
    pub(crate) fn context(&self) -> String {
        self.notes
            .iter()
            .map(|(number, note)| format!("{number}. {note}"))
            .collect::<Vec<_>>()
            .join(
                "
",
            )
    }
}

/// 실행 중에 늘 열려 있는 도구의 이름. 스키마 목록에서 뽑으므로 둘이 갈라지지 않는다.
fn step_control_tool_names() -> Vec<String> {
    step_control_tool_schemas()
        .iter()
        .filter_map(|schema| {
            schema
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

/// 계획 대신 돌아온 거절. [`Plan`]과 나란히 놓이는 결말이라 단계를 들지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlanRefusal {
    reason: String,
}

impl PlanRefusal {
    pub(crate) fn reason(&self) -> &str {
        &self.reason
    }
}

/// 답을 기다리는 갈림길. 계획에 하나만 열린다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PendingDecision {
    /// 이 갈림길이 열렸을 때의 단계 번호.
    pub(crate) step: usize,
    pub(crate) question: String,
    pub(crate) options: Vec<String>,
    /// [`PendingDecision::options`]에서 추천안의 자리.
    pub(crate) recommended: usize,
}

impl PendingDecision {
    pub(crate) fn recommended_option(&self) -> &str {
        &self.options[self.recommended]
    }
}

/// 갈림길을 누가 닫았는지.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum DecidedBy {
    /// 결정정책이 `Recommended`라 모델이 추천안을 그대로 골랐다.
    Model,
    /// 사용자가 골랐다.
    User,
}

/// 지나온 갈림길 하나.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct DecisionRecord {
    pub(crate) step: usize,
    pub(crate) question: String,
    pub(crate) chosen: String,
    pub(crate) by: DecidedBy,
}

/// [`Plan::decide`]의 결말. 고른 것이 있거나, 사용자를 기다린다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DecisionOutcome {
    Chosen(String),
    Awaiting,
}

/// 갈림길 질문을 다듬는다.
fn normalize_decision_text(question: &str) -> Result<String, CoreError> {
    let question = question.trim();
    if question.is_empty() {
        return Err(CoreError::InvalidInput(
            "무엇을 골라야 하는지 적어야 합니다".to_string(),
        ));
    }
    if question.chars().count() > MAX_DECISION_QUESTION_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "갈림길 질문은 {MAX_DECISION_QUESTION_CHARS}자 이하여야 합니다"
        )));
    }
    if question.chars().any(|ch| ch.is_control()) {
        return Err(CoreError::InvalidInput(
            "갈림길 질문에 제어 문자를 쓸 수 없습니다".to_string(),
        ));
    }
    Ok(question.to_string())
}

/// 선택지를 다듬는다. 하나뿐인 갈림길은 갈림길이 아니므로 둘부터 받는다.
fn normalize_options(options: &[String]) -> Result<Vec<String>, CoreError> {
    let mut normalized: Vec<String> = Vec::new();
    for option in options {
        let option = option.trim();
        if option.is_empty() {
            continue;
        }
        if option.chars().count() > MAX_DECISION_OPTION_CHARS {
            return Err(CoreError::InvalidInput(format!(
                "선택지는 {MAX_DECISION_OPTION_CHARS}자 이하여야 합니다"
            )));
        }
        if option.chars().any(|ch| ch.is_control()) {
            return Err(CoreError::InvalidInput(
                "선택지에 제어 문자를 쓸 수 없습니다".to_string(),
            ));
        }
        if !normalized.iter().any(|kept| kept == option) {
            normalized.push(option.to_string());
        }
    }
    if normalized.len() < 2 {
        return Err(CoreError::InvalidInput(
            "선택지는 둘 이상이어야 합니다. 고를 것이 하나뿐이면 그냥 진행하세요".to_string(),
        ));
    }
    if normalized.len() > MAX_DECISION_OPTIONS {
        return Err(CoreError::InvalidInput(format!(
            "선택지는 {MAX_DECISION_OPTIONS}개까지만 내밀 수 있습니다. 후보를 추려서 물으세요"
        )));
    }
    Ok(normalized)
}

/// 추천안(그리고 사용자의 답)을 선택지의 자리로 읽는다.
///
/// 선택지의 글 그대로거나 1부터 세는 번호를 받는다. 어긋나면 선택지를 통째로 되돌린다 —
/// [`normalize_tools`]가 없는 도구에 실재하는 이름을 붙이는 것과 같은 이유로, 없는 답에
/// "없습니다"만 주면 같은 답이 다시 온다.
fn parse_choice(options: &[String], value: &str) -> Result<usize, CoreError> {
    let value = value.trim();
    if let Some(index) = options.iter().position(|option| option == value) {
        return Ok(index);
    }
    if let Ok(number) = value.parse::<usize>() {
        if number >= 1 && number <= options.len() {
            return Ok(number - 1);
        }
    }
    Err(CoreError::InvalidInput(format!(
        "'{value}'는 선택지에 없습니다. 고를 수 있는 것: {}",
        options.join(", ")
    )))
}

/// 계획 턴에 여는 도구 셋. 이름과 인자 모양이 여기 한 곳에만 있어, 배선(9.3)과 이 모듈의
/// 검사가 서로 다른 계약을 보지 않는다.
///
/// **평평하다.** `properties` 밑은 문자열이거나 문자열 배열뿐이고, 배열 안에 객체를 두지
/// 않는다. 2026-09-25 실측에서 중첩한 모양은 CPU 레인 0/6이었고, 깨질 때 `tools`가 통째로
/// 문자열로 무너져 사라졌다 — 어느 도구를 열지가 이 설계의 전부인데 그것이 날아간다.
/// [`tests::planning_tool_schemas_stay_flat`]이 그 평평함을 지킨다.
/// 제 이름을 한 글자 틀린 조종 도구를 되돌린다. 그보다 멀면 되돌리지 않는다.
///
/// 실측에서 GPU 가 `finiish_plan` 을 불렀다(2026-09-26). 조종 도구 넷은 뜻이 분명하므로
/// 한 글자 차이는 받아 준다 — **색인 도구 이름은 되돌리지 않는다.** 그쪽은 틀리면 다른
/// 일을 하게 되고, `notion-update-page` 와 `notion-update-view` 처럼 한 글자 차이로 뜻이
/// 갈리는 이름이 실제로 있다. 하네스도 같은 자리에 고침을 둔다(experimental_repairToolCall).
pub(crate) fn nearest_planning_tool(name: &str) -> Option<&'static str> {
    const CONTROLS: &[&str] = &["add_step", "finish_plan", "answer_now", "cannot_do"];
    let lowered = name.trim().to_lowercase();
    for control in CONTROLS {
        if lowered == *control {
            return Some(control);
        }
        if lowered.len().abs_diff(control.len()) <= 1 && edit_distance(&lowered, control) <= 1 {
            return Some(control);
        }
    }
    None
}

/// 레벤슈타인 거리. 한 글자 차이만 보면 되므로 표 두 줄로 충분하다.
fn edit_distance(left: &str, right: &str) -> usize {
    let right: Vec<char> = right.chars().collect();
    let mut row: Vec<usize> = (0..=right.len()).collect();
    for (i, a) in left.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, b) in right.iter().enumerate() {
            let next = (row[j + 1] + 1)
                .min(row[j] + 1)
                .min(prev + usize::from(a != *b));
            prev = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[right.len()]
}

/// 초안 agent가 여는 스키마. 실행 중 삽입은 재계획 agent에 남긴다.
pub(crate) fn draft_planning_tool_schemas() -> Vec<Value> {
    planning_tool_schemas()
        .into_iter()
        .filter(|schema| schema["name"] != "insert_step")
        .collect()
}

pub(crate) fn planning_tool_schemas() -> Vec<Value> {
    // insert_step 이 여기 함께 있는 이유: MCP 도구 목록은 세션이 열릴 때 한 번 읽힌다.
    // 계획을 세우는 동안과 도는 동안 목록을 갈아 끼울 수 없으므로 다 내보내고, 지금 쓸 수
    // 없는 것은 agent의 도구 허용 목록에서 가른다.
    let mut schemas = vec![
        json!({
            "name": "add_step",
            "description": "Adds one step to the plan. The order of calls is the order of steps.",
            "parameters": {
                "type": "object",
                "required": ["title", "tools"],
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "One sentence on what this step does",
                    },
                    "tools": {
                        "type": "array",
                        "maxItems": MAX_TOOLS_PER_STEP,
                        "items": { "type": "string" },
                        "description": "The tool name this step will call. Only names from the given list.",
                    },
                    "uses": {
                        "type": "array",
                        "maxItems": MAX_USES_PER_STEP,
                        "items": { "type": "string" },
                        "description": "Number of an earlier step whose full result this step needs. Leave empty if a one-line summary is enough.",
                    },
                },
            },
        }),
        json!({
            "name": "finish_plan",
            "description": "Call when no more steps are needed. The plan is confirmed here.",
            "parameters": { "type": "object", "properties": {} },
        }),
        json!({
            "name": "answer_now",
            "description": "Call when the request needs no tools - greetings, small talk, questions you already know the answer to. No plan is made; the text written here is the answer.",
            "parameters": {
                "type": "object",
                "required": ["answer"],
                "properties": {
                    "answer": { "type": "string", "description": "The answer shown to the user as is" },
                },
            },
        }),
        json!({
            "name": "cannot_do",
            "description": "Call when the request cannot be done with the given tools. Do not invent a plan.",
            "parameters": {
                "type": "object",
                "required": ["reason"],
                "properties": {
                    "reason": { "type": "string", "description": "One or two sentences on why it cannot be done" },
                },
            },
        }),
    ];
    schemas.extend(step_control_tool_schemas().into_iter().filter(|schema| {
        // 갈림길(decide)은 단계를 도는 중의 것이라 계획 묶음에 두지 않는다.
        schema["name"] == "insert_step"
    }));
    schemas
}

/// 단계를 도는 동안 그 단계의 도구 옆에 함께 가는 것.
///
/// **`resolve`는 여기 없다.** 실패한 단계에만 쓸 수 있는 도구라([`Plan::resolve`]가 아닌
/// 단계에는 오류를 낸다) 성공 경로에서는 부를 수 없는 것을 매 단계 열어 두는 셈이 된다.
/// 이 모듈이 있는 이유가 한 턴에 보이는 도구를 줄이는 것이므로, 실패를 처리하는 턴에서만
/// [`failure_tool_schemas`]로 연다.
///
/// **`decide`는 여기 있다.** 같은 잣대를 대면 자리가 갈린다 — 갈림길은 단계가 **해낸**
/// 자리에서 드러난다. 검색이 페이지를 셋 돌려준 것은 실패가 아니고, 그것을 알아차리는
/// 것도 그 단계를 도는 중이다. 실패처럼 뒤따르는 턴으로 미루면 성공한 단계를 일부러
/// 실패시켜야 물어볼 수 있게 된다.
///
/// [`planning_tool_schemas`]와 같은 평평함 규칙을 따른다. `after`가 숫자가 아니라 문자열인
/// 것이 그 규칙이다: 2026-09-25 실측에서 무너진 것은 중첩이었지만, 타입을 문자열과 문자열
/// 배열 둘로만 묶어 두는 편이 모양이 다시 벌어질 자리를 남기지 않는다. 숫자로 읽는 일은
/// [`parse_insert_after`]가 한다.
pub(crate) fn step_control_tool_schemas() -> Vec<Value> {
    vec![
        json!({
            "name": "insert_step",
            "description": "Inserts one step into the remaining plan. Say which step it follows; numbers are reassigned.",
            "parameters": {
                "type": "object",
                "required": ["title", "tools"],
                "properties": {
                    "after": {
                        "type": "string",
                        "description": "Insert after this step. Write the step number as currently shown; leave empty for the very front.",
                    },
                    "title": {
                        "type": "string",
                        "description": "One sentence on what this step does",
                    },
                    "tools": {
                        "type": "array",
                        "maxItems": MAX_TOOLS_PER_STEP,
                        "items": { "type": "string" },
                        "description": "The tool name this step will call. Only names from the given list.",
                    },
                },
            },
        }),
        json!({
            "name": "decide",
            "description": "단계는 해냈는데 둘 이상 가운데 하나를 골라야 할 때 부른다. 실패가 아니다 — 실패는 resolve 다.",
            "parameters": {
                "type": "object",
                "required": ["question", "options", "recommended"],
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "무엇을 골라야 하는지 한두 문장",
                    },
                    "options": {
                        "type": "array",
                        "maxItems": MAX_DECISION_OPTIONS,
                        "items": { "type": "string" },
                        "description": "고를 수 있는 것. 둘 이상 적는다.",
                    },
                    "recommended": {
                        "type": "string",
                        "description": "그 가운데 추천하는 것. 선택지의 글 그대로 적거나 1부터 세는 번호를 적는다.",
                    },
                },
            },
        }),
    ]
}

/// 단계가 실패한 뒤 그 처리를 묻는 턴에만 여는 것.
///
/// 이 턴은 일을 하지 않는다 — 무엇을 할지만 정한다. 그래서 단계 도구도 `insert_step`도
/// 싣지 않고 이것 하나만 연다. 고를 갈래가 넷이라도 도구는 하나다([`StepResolution`]).
pub(crate) fn failure_tool_schemas() -> Vec<Value> {
    vec![json!({
        "name": "resolve",
        "description": "단계가 실패했을 때 어떻게 할지 고른다. 이 도구 하나로 네 갈래를 다 고른다.",
        "parameters": {
            "type": "object",
            "required": ["action"],
            "properties": {
                "action": {
                    "type": "string",
                    "description": "retry(같은 단계를 다시), skip(포기하고 다음), replan(계획을 고치고 다음), abort(여기서 끝냄) 중 하나",
                },
                "reason": {
                    "type": "string",
                    "description": "왜 그렇게 정했는지 한 문장. retry 에는 없어도 된다.",
                },
            },
        },
    })]
}

/// `resolve`의 `action`·`reason`을 [`Plan::resolve`]가 받는 모양으로 읽는다.
///
/// 모르는 갈래에는 네 이름을 그대로 붙여 돌려준다 — [`normalize_tools`]가 없는 도구에
/// 실재하는 이름을 붙이는 것과 같은 이유다. `retry`를 뺀 세 갈래는 사유를 받는다: 셋 다
/// 일을 덜 하고 끝내는 쪽이라, 왜 그랬는지가 없으면 마무리 요약에 "건너뜀"만 남는다.
pub(crate) fn parse_resolution(
    action: &str,
    reason: Option<&str>,
) -> Result<StepResolution, CoreError> {
    let reason = reason.unwrap_or("").trim();
    let with_reason = |kind: &str| -> Result<String, CoreError> {
        if reason.is_empty() {
            return Err(CoreError::InvalidInput(format!(
                "'{kind}'에는 왜 그렇게 정했는지 한 문장이 필요합니다"
            )));
        }
        Ok(clamp_note(reason))
    };
    match action.trim().to_ascii_lowercase().as_str() {
        "retry" => Ok(StepResolution::Retry),
        "skip" => Ok(StepResolution::Skip {
            reason: with_reason("skip")?,
        }),
        "replan" => Ok(StepResolution::Replan {
            reason: with_reason("replan")?,
        }),
        "abort" => Ok(StepResolution::Abort {
            reason: with_reason("abort")?,
        }),
        other => Err(CoreError::InvalidInput(format!(
            "'{other}'는 쓸 수 있는 갈래가 아닙니다. retry, skip, replan, abort 중에서 고르세요"
        ))),
    }
}

/// `insert_step`의 `after`를 [`Plan::insert_after`]가 받는 모양으로 읽는다.
///
/// 비어 있거나 `0`이면 맨 앞이다. 숫자가 아닌 말이 오면 그것을 되돌려 준다 — 모델이 번호
/// 대신 제목을 적어 보내는 일이 잦고, "없습니다"로만 답하면 같은 제목을 다시 적는다.
pub(crate) fn parse_insert_after(after: Option<&str>) -> Result<Option<usize>, CoreError> {
    let after = after.unwrap_or("").trim();
    if after.is_empty() || after == "0" {
        return Ok(None);
    }
    after.parse::<usize>().map(Some).map_err(|_| {
        CoreError::InvalidInput(format!(
            "'{after}'는 단계 번호가 아닙니다. 지금 보이는 번호를 적거나, 맨 앞이면 비워 두세요"
        ))
    })
}

/// 메모를 상한까지 자른다. 거절하지 않는 것은 메모가 모델이 아니라 실행 결과에서 오기
/// 때문이다 — 길다는 이유로 끝난 단계 하나를 통째로 실패로 만들 일이 아니다.
/// 결과 본문을 상한까지 자른다.
///
/// 메모와 달리 줄바꿈을 지우지 않는다 — 본문은 사람이 읽거나 요약에 그대로 실리는 글이라
/// 한 줄로 눌러 놓으면 읽을 수 없게 된다.
/// 계획 턴에 보내는 글. 도구 색인과 요청을 한 덩이로 묶는다.
///
/// 규칙은 에이전트 프롬프트(`PLAN_PROMPT`)가 들고, 여기서는 **이번 채팅에 무엇이 붙어
/// 있는지**만 싣는다 — 붙은 플러그인이 채팅마다 다르므로 설정 파일에 적을 수 없다.
///
/// 색인을 요청보다 **먼저** 둔다. 뒤에 두면 긴 목록이 요청과 모델 사이를 갈라놓아, 실측에서
/// 모델이 목록 끝의 도구로 쏠렸다. 그리고 목록이 무엇인지 한 줄로 말해 준다 — 그냥 이름을
/// 쏟아 두면 모델이 그것을 지금 부를 수 있는 도구로 읽고 곧바로 호출한다(2026-09-26 실측:
/// `read` 를 계획 대신 바로 불러 CPU 가 0/4).
pub(crate) fn plan_system_prompt(index: &str) -> String {
    plan_system_prompt_for(index, false)
}

/// 읽기 전용 모드가 색인에서 쓰기 도구를 뺀 자리에 두는 출구 문장.
///
/// 색인만 좁히면 모델은 빈자리를 읽기 도구로 메운다 — 2026-09-27 GPU 20회 중 19회가
/// "노션에 정리해줘"를 notion-search·notion-fetch 로 계획했다(9.14). 못 하는 일을
/// 못 한다고 말할 자리가 없으면 지어낸다는 5절의 그 자리다.
pub(crate) const READ_ONLY_CLAUSE: &str = "This session is READ-ONLY. First decide what the request asks for. If it only asks you to read, look up, fetch, search, count, or report something, plan it normally with the listed tools. If it asks to create, write, save, update, post, or organize something (a file, a page, a comment, a record), that part cannot be done here: call cannot_do saying the session is read-only, and do not plan a partial version with only read or search tools.";

pub(crate) fn plan_system_prompt_for(index: &str, read_only: bool) -> String {
    let exit = if read_only {
        format!(
            "

{READ_ONLY_CLAUSE}"
        )
    } else {
        String::new()
    };
    format!(
        "{}{exit}

The tools a step can use are listed below. While planning, only pick names from this list and write them into add_step's tools — the actual call happens when that step runs.

{index}",
        crate::opencode_config::PLAN_PROMPT
    )
}

/// 계획이 도는 중에 사용자가 말했을 때 보내는 글.
///
/// 새 계획을 열지 않는다 — 이미 끝낸 단계를 버리게 되어 조사를 다시 한다. 아무것도 하지
/// 않는 쪽도 안 된다. 그 말이 대기열을 거쳐 다음 **단계** 턴의 프롬프트로 들어가, 단계
/// 지시와 사용자 정정이 한 덩이로 섞인다(2026-09-26 사용자 지적).
///
/// 그래서 지금 계획을 펼쳐 보여 주고 `insert_step` 으로 고치게 한다. 끝낸 단계는 그대로
/// 둔다.
pub(crate) fn replan_turn_prompt(plan: &Plan, said: &str) -> String {
    let mut text = String::from(
        "사용자가 일이 도는 중에 이렇게 말했다.

",
    );
    text.push_str(said.trim());
    text.push_str(
        "

지금 계획은 이렇다.
",
    );
    for step in plan.steps() {
        let mark = match &step.outcome {
            Some(StepOutcome::Done { .. }) => "끝남",
            Some(StepOutcome::Failed { .. }) => "실패",
            Some(StepOutcome::Skipped { .. }) => "건너뜀",
            None => "남음",
        };
        text.push_str(&format!(
            "{}. [{mark}] {} — {}
",
            step.number,
            step.title,
            step.tools.join(", ")
        ));
    }
    text.push_str(
        "
끝난 단계는 되돌리지 않는다. 남은 단계로 그 말을 담을 수 없으면 insert_step 으로 단계를 끼워라. 고칠 것이 없으면 아무 도구도 부르지 말고 그렇다고 한 줄로 답해라.",
    );
    text
}

/// 채팅 하나가 계획에서 어디까지 와 있는지.
///
/// 계획 MCP 엔드포인트와 실행기가 **같은 자리**를 본다. 엔드포인트가 상태를 따로 들면
/// 주인이 둘이 되고, 둘이 어긋나는 순간 어느 쪽이 맞는지 판정할 방법이 없다.
#[derive(Debug, Clone)]
pub(crate) enum PlanSlot {
    /// 아직 계획을 세우지 않았다. 일반 채팅은 계속 여기 머문다.
    Idle,
    /// 계획 턴이 돌고 있다. `add_step`이 여기에 쌓인다.
    Drafting(PlanDraft),
    /// 계획이 확정됐다. 이제 단계를 순서대로 돈다.
    Running(Plan),
    /// 주어진 도구로는 할 수 없다고 끝냈다.
    Refused(PlanRefusal),
    /// 도구가 필요 없는 요청이라 그 자리에서 답했다.
    ///
    /// 이 출구가 없으면 인사말에도 계획을 세워야 한다. `finish_plan`은 단계를 요구하고
    /// `cannot_do`는 "못 한다"라서 둘 다 거짓이 되는데, 출구가 없는 자리에서 모델이
    /// 무엇을 하는지는 오늘 여러 번 봤다 — 지어내거나 맴돈다.
    Answered(String),
}

impl PlanSlot {
    /// 계획을 쌓는 중인 초안. 아니면 무엇을 하고 있는지 말해 준다 — 모델에게 돌아가는
    /// 문구라, "잘못된 상태"가 아니라 다음에 무엇을 할 수 있는지가 보여야 한다.
    pub(crate) fn drafting(&mut self) -> Result<&mut PlanDraft, CoreError> {
        match self {
            PlanSlot::Drafting(draft) => Ok(draft),
            PlanSlot::Idle => Err(CoreError::InvalidInput(
                "지금은 계획을 세우는 중이 아닙니다".to_owned(),
            )),
            PlanSlot::Running(_) => Err(CoreError::InvalidInput(
                "계획은 이미 확정됐습니다. 단계를 더하려면 insert_step 을 쓰세요".to_owned(),
            )),
            PlanSlot::Refused(_) => Err(CoreError::InvalidInput(
                "할 수 없다고 끝낸 요청입니다".to_owned(),
            )),
            PlanSlot::Answered(_) => {
                Err(CoreError::InvalidInput("이미 답한 요청입니다".to_owned()))
            }
        }
    }

    /// 초안을 확정하거나 거절로 닫는다. 둘 다 초안을 소비하므로 한자리에 둔다.
    fn take_draft(&mut self) -> Result<PlanDraft, CoreError> {
        // 자리를 비워 두고 꺼낸다. 실패하면 되돌려 넣는다 — 오류 한 번에 계획이
        // 사라지면 모델은 고칠 거리도 없이 처음부터 다시 세워야 한다.
        match std::mem::replace(self, PlanSlot::Idle) {
            PlanSlot::Drafting(draft) => Ok(draft),
            other => {
                *self = other;
                self.drafting().map(|_| unreachable!())
            }
        }
    }

    pub(crate) fn finish(&mut self) -> Result<usize, CoreError> {
        let mut draft = self.take_draft()?;
        // 되묻기는 `PlanDraft::finish` 가 아니라 여기 있다 — 거기서 세운 표시는 초안을
        // 되돌려 넣을 때 사라져 같은 되묻기가 영영 돈다.
        if let Err(error) = draft.bounce_read_only_plan() {
            *self = PlanSlot::Drafting(draft);
            return Err(error);
        }
        match draft.clone().finish() {
            Ok(plan) => {
                let steps = plan.steps().len();
                *self = PlanSlot::Running(plan);
                Ok(steps)
            }
            Err(error) => {
                *self = PlanSlot::Drafting(draft);
                Err(error)
            }
        }
    }

    /// 도는 계획에 단계를 끼운다. 재계획 턴과, 단계가 스스로 더 필요하다고 할 때 쓴다.
    pub(crate) fn insert_step(
        &mut self,
        after: Option<usize>,
        title: &str,
        tools: &[String],
    ) -> Result<usize, CoreError> {
        match self {
            PlanSlot::Running(plan) => plan.insert_after(after, title, tools),
            PlanSlot::Drafting(_) => Err(CoreError::InvalidInput(
                "아직 계획을 세우는 중입니다. 단계를 더하려면 add_step 을 쓰세요".to_owned(),
            )),
            _ => Err(CoreError::InvalidInput("도는 계획이 없습니다".to_owned())),
        }
    }

    /// 색인에 있는 이름인지. 계획 턴이 그 이름을 곧바로 부를 때 알아보려고 쓴다.
    pub(crate) fn indexes_tool(&self, name: &str) -> bool {
        match self {
            PlanSlot::Drafting(draft) => draft.catalog().contains(name),
            _ => false,
        }
    }

    /// 지금 돌고 있는 단계가 쓸 수 있는 도구. 계획이 돌고 있지 않으면 `None`이다.
    ///
    /// 껍데기가 호출마다 묻는 값이다. 허용목록을 계획 안에만 두면 그것을 읽는 곳은
    /// 프롬프트를 만드는 쪽뿐이고, 프롬프트로만 정해 둔 목록은 모델이 넘어간다.
    pub(crate) fn current_step_tools(&self) -> Option<Vec<String>> {
        match self {
            PlanSlot::Running(plan) => plan.current().map(|step| step.tools.clone()),
            _ => None,
        }
    }

    /// 도구 없이 바로 답하고 끝낸다. 이미 기록한 도구 단계를 이 출구로 버리지 않는다.
    pub(crate) fn answer(&mut self, answer: &str) -> Result<(), CoreError> {
        let answer = answer.trim();
        if answer.is_empty() {
            return Err(CoreError::InvalidInput(
                "You must write the answer text".to_owned(),
            ));
        }
        if !self.drafting()?.is_empty() {
            return Err(CoreError::InvalidInput("Steps that use tools have already been recorded. Add the remaining steps with add_step and confirm with finish_plan. If the request cannot be carried out, give the reason with cannot_do".to_owned()));
        }
        let _ = self.take_draft()?;
        *self = PlanSlot::Answered(answer.to_owned());
        Ok(())
    }

    /// 색인 도구를 곧바로 부른 것을 지금 초안에 적어 둔다. 계획 중이 아니면 아무것도 안 한다.
    pub(crate) fn note_direct_index_call(&mut self, name: &str) {
        if let PlanSlot::Drafting(draft) = self {
            draft.note_direct_index_call(name);
        }
    }

    /// 주어진 도구로는 할 수 없다고 끝낸다.
    ///
    /// **직접 호출 직후의 거절은 한 번 되돌려 준다.** 계획 턴에 색인 이름을 곧바로 부르면
    /// 하네스가 "그런 도구 없다"로 답하고, 모델은 그 문장을 믿고 거절한다. 그 거절은 도구
    /// 표면에 대한 거짓에서 나온 것이라 받아 주면 안 된다 — [`PlanDraft::direct_index_call`]
    /// 에 그 실측이 적혀 있다. 되돌릴 때 표식을 지우므로 같은 턴의 두 번째 거절은 그대로
    /// 받는다. 이 자리는 `answer_now` 보호(비어 있지 않은 초안)와 같은 규칙이다.
    pub(crate) fn refuse(&mut self, reason: &str) -> Result<(), CoreError> {
        if let PlanSlot::Drafting(draft) = self {
            if let Some(tool) = draft.take_direct_index_call() {
                return Err(CoreError::InvalidInput(format!(
                    "You just called '{tool}' directly and it was rejected, but that does not mean the tool is missing. While planning, only the control tools are open; '{tool}' opens when that step runs. To do that work, write \"{tool}\" into add_step's tools. If it still cannot be done, call cannot_do once more and it will be accepted"
                )));
            }
        }
        // 이미 단계를 적어 놓고 못 하겠다는 것은 앞뒤가 맞지 않는다. 2026-09-26 GPU 탐침
        // web-to-notion 8회차가 webfetch·read·notion-create-pages 세 단계를 적은 **뒤에**
        // cannot_do 를 불렀다 — 요청을 덮는 계획을 손에 쥐고 거절한 것이다. answer_now 가
        // 같은 자리에서 막히는 것(a991df40)과 같은 규칙을 여기에도 둔다. 한 번 되돌리고
        // 표식을 지우므로, 정말 못 하는 일이면 한 번 더 불러 그대로 끝낼 수 있다.
        if let PlanSlot::Drafting(draft) = self {
            if !draft.is_empty() && !draft.take_refusal_bounced() {
                return Err(CoreError::InvalidInput(format!(
                    "{} step(s) are already written. If those steps cover the request, call finish_plan; if part of it is not covered, add the rest with add_step. If it still cannot be done, call cannot_do once more and it will be accepted",
                    draft.len()
                )));
            }
        }
        let draft = self.take_draft()?;
        match draft.clone().refuse(reason) {
            Ok(refusal) => {
                *self = PlanSlot::Refused(refusal);
                Ok(())
            }
            Err(error) => {
                *self = PlanSlot::Drafting(draft);
                Err(error)
            }
        }
    }
}

/// 계획 턴 프롬프트에 싣는 도구 색인 한 덩이.
///
/// `id + 한 줄 설명` 목록이 전부다. 스키마는 싣지 않는다 — 계획 턴이 부를 수 있는 도구는
/// [`planning_tool_schemas`]의 셋뿐이고, 이 색인은 프롬프트 안의 글이다. 도구 수
/// 민감도(26개면 이름을 지어낸다)는 호출 가능한 스키마 수에 걸리는 압력이지 이 목록에
/// 걸리는 것이 아니다 — 2026-09-26 실측에서 49개 색인으로도 두 레인이 맞는 도구를 골랐다.
/// 대신 여기 드는 비용은 맥락이다(49개 6,104자, 약 2천 토큰).
///
/// 기준선은 탐침 `local-llm-dev/plan-eval/tool-index.mjs`가 같은 규칙으로 쟀다. 사본이 둘인
/// 것은 마음에 걸리지만 — 탐침은 Ollama 에 바로 붙어야 하고 이쪽은 배포본이다 — 갈라지는
/// 자리는 규칙 둘뿐이라(헤딩 건너뛰기, 같은 도구 접기) 아래 시험이 그 둘을 고정한다.
/// 나중에 배선이 서면 탐침이 배포본을 통해 재게 만들어 사본을 없앤다.
pub(crate) fn tool_index(catalogs: &[(String, Vec<(String, String)>)]) -> String {
    // 도구 집합이 같은 플러그인은 설명을 한 벌만 적는다. notion-team 과 notion-personal 는
    // 같은 Notion MCP 를 계정만 달리 붙인 것이라 45개가 정확히 겹친다 — 두 번 적으면
    // 9,005자, 접으면 6,104자다.
    let mut order: Vec<String> = Vec::new();
    let mut entries: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    for (plugin, tools) in catalogs {
        for (name, description) in tools {
            let entry = entries
                .entry(name.clone())
                .or_insert_with(|| (first_line(description), Vec::new()));
            // 플러그인이 아닌 도구는 소유자 칸을 비운 채로 온다. 빈 이름을 담아 두면
            // 괄호만 남은 `- webfetch (): …` 가 나가 읽는 쪽이 헷갈린다.
            if !plugin.trim().is_empty() && !entry.1.iter().any(|owner| owner == plugin) {
                entry.1.push(plugin.clone());
            }
            if !order.iter().any(|kept| kept == name) {
                order.push(name.clone());
            }
        }
    }
    let mut lines = Vec::with_capacity(order.len());
    for name in order {
        let Some((description, plugins)) = entries.get(&name) else {
            continue;
        };
        if plugins.is_empty() {
            lines.push(format!("- {name}: {description}"));
        } else {
            lines.push(format!("- {name} ({}): {description}", plugins.join(" | ")));
        }
    }
    lines.join(
        "
",
    )
}

/// 색인 한 줄에 실을 설명의 길이 상한.
///
/// 잘라야 하는 것은 **긴 설명**이지 두 번째 문장이 아니다. 경계를 문장에만 두면, 상류가
/// 긴 산문을 주는 플러그인과 우리가 색인용으로 한 줄씩 적은 작업 공간 도구가 같은 칼을
/// 맞는다 — 120자는 플러그인 설명 45개 가운데 하나만 더 통과시키면서(실측 +62자) 우리가
/// 적은 다섯 줄은 전부 통째로 지나가게 하는 자리다.
const MAX_INDEX_DESCRIPTION_CHARS: usize = 120;

/// 설명에서 첫 산문 줄만 뽑는다.
///
/// **마크다운 헤딩을 건너뛴다.** 그냥 첫 줄을 잡으면 설명이 `## Overview` 로 시작하는
/// `notion-create-pages` 와 `notion-update-page` 가 빈칸으로 나온다 — 하필 가장 많이 쓰는
/// 둘이다(2026-09-26 실측에서 실제로 그렇게 비었다). 설명 없는 이름만 남으면 계획이
/// 무엇을 고르는지 알 수 없다.
///
/// **짧은 줄은 문장에서 자르지 않는다.** 예전에는 길이와 상관없이 첫 `". "` 에서 끊었다.
/// 그래서 [`crate::opencode_config::KEPT_TOOL_DESCRIPTIONS`] 의 두 번째 문장이 색인에 한
/// 번도 실린 적이 없다 — 하필 그 문장들이 도구를 **가르는** 말이다(`write`: "Overwrites
/// the whole file.", `edit`: "Does not rewrite the whole file.", `bash`: "Use it to find
/// files or run commands."). 계획 턴이 본 것은 "Writes content to one file." 과 "Finds and
/// replaces part of a file." 뿐이었고, 우리가 둘을 가르려고 적어 둔 말은 조용히 버려졌다
/// (2026-10-02 코드 리팩토링 10회차). 우리 쪽 어휘가 모델에 닿지 않는 자리라, 길이 상한을
/// 넘을 때만 문장에서 끊는다.
fn first_line(description: &str) -> String {
    for line in description.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.chars().count() <= MAX_INDEX_DESCRIPTION_CHARS {
            return line.to_owned();
        }
        // 긴 설명만 첫 문장까지 줄인다. 마침표 뒤 공백을 경계로 본다.
        return match line.find(". ") {
            Some(at) => line[..=at].trim_end().to_owned(),
            None => line.to_owned(),
        };
    }
    String::new()
}

fn clamp_body(body: &str) -> String {
    let body = body.trim();
    if body.chars().count() <= MAX_STEP_BODY_CHARS {
        return body.to_string();
    }
    body.chars().take(MAX_STEP_BODY_CHARS).collect()
}

fn clamp_note(note: &str) -> String {
    let note = note.trim().replace(['\r', '\n'], " ");
    if note.chars().count() <= MAX_STEP_NOTE_CHARS {
        return note;
    }
    note.chars().take(MAX_STEP_NOTE_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 단계 글은 앞 단계 메모를 먼저, 지시를 맨 끝에 둔다.
    #[test]
    fn a_step_prompt_ends_with_what_to_do_now() {
        let mut plan = two_step_plan();
        plan.record(
            1,
            StepOutcome::Done {
                note: "페이지 id 는 p1".to_owned(),
            },
            "본문",
        )
        .expect("기록");
        let execution = plan.begin_step().expect("두 번째 단계");
        let prompt = execution.turn_prompt(false);

        let note_at = prompt.find("페이지 id 는 p1").expect("앞 단계 메모");
        let now_at = prompt.find("2단계").expect("지시");
        assert!(note_at < now_at, "{prompt}");
        assert!(
            prompt.trim_end().ends_with("다음 단계는 다음에 한다."),
            "{prompt}"
        );
        // 본문은 싣지 않는다. 맥락 밖에 두는 것이 이 모듈의 요점이다.
        assert!(!prompt.contains("본문"), "{prompt}");
    }

    /// 플러그인 단계에는 껍데기로 부르는 법을 적어 준다.
    ///
    /// 2026-09-26 실기기: 단계 지시에 이름만 적었더니 모델이 `notion-create-pages` 를 직접
    /// 불렀고 하네스가 `invalid` 로 되돌렸다("Available tools: invalid, plugins_call_tool …").
    /// 스스로 find_tool 로 고쳐 도착하기는 했지만 한 턴을 그렇게 썼다. 부르는 법을 아는
    /// 쪽은 우리다.
    ///
    /// 확인을 **조건부로 적지 않는다.** 처음에 "모르면 find_tool 로 확인해라"라고 적었더니
    /// 같은 회차 3단계가 안다고 여기고 `notion-update-page` 인자를 네 번 짐작하다 전부
    /// 실패하고 포기했다. find_tool 자신의 설명도 "call_tool 전에 반드시"라고 말한다 —
    /// 우리 지시가 그것과 어긋나 있었다.
    #[test]
    fn a_plugin_step_is_told_to_go_through_the_shell() {
        let mut draft = PlanDraft::new(ToolCatalog::new(["notion-create-pages", "write"]));
        draft
            .add_step("노션에 만든다", &tools(&["notion-create-pages"]), &[])
            .expect("단계");
        let plan = draft.finish().expect("확정");
        let execution = plan.begin_step().expect("1단계");

        let shell = execution.turn_prompt(true);
        assert!(shell.contains("call_tool"), "{shell}");
        assert!(shell.contains("notion-create-pages"), "{shell}");
        assert!(shell.contains("find_tool"), "{shell}");
        // 조건부가 아니라 먼저 하라고 적는다. "모르면 확인해라"로는 모델이 안다고 여긴다.
        assert!(shell.contains("먼저"), "{shell}");
        assert!(!shell.contains("모르면"), "{shell}");

        // 작업 공간 도구에는 그 안내를 붙이지 않는다 — 거기서는 그냥 부르면 된다.
        let direct = execution.turn_prompt(false);
        assert!(!direct.contains("call_tool"), "{direct}");
    }

    /// 본문째 달라고 선언한 단계에만 앞 단계의 본문이 붙는다.
    ///
    /// 기본은 한 줄 메모다 — "검색 → 그 페이지를 고쳐라"는 다음 단계가 식별자만 있으면
    /// 되는 일이라 본문을 실으면 계획으로 아낀 맥락을 그대로 잃는다. 그러나 "자료조사 →
    /// 노션에 작성"은 앞 단계의 본문 자체가 재료다. 맥락이 부는 것을 **모델이 필요하다고
    /// 말한 자리로 한정**하려고 선언으로 받는다.
    #[test]
    fn a_step_that_asks_for_it_gets_the_earlier_body() {
        let mut draft = PlanDraft::new(catalog());
        draft
            .add_step("조사한다", &tools(&["bash"]), &[])
            .expect("1");
        draft
            .add_step("적는다", &tools(&["write"]), &[1])
            .expect("2");
        let mut plan = draft.finish().expect("확정");
        plan.record(
            1,
            StepOutcome::Done {
                note: "환율 찾음".to_owned(),
            },
            "1달러 = 1380원, 출처 …",
        )
        .expect("기록");

        let prompt = plan.begin_step().expect("2단계").turn_prompt(false);
        assert!(prompt.contains("1달러 = 1380원"), "{prompt}");
        // 한 줄 메모도 그대로 있다. 둘은 서로를 대신하지 않는다.
        assert!(prompt.contains("환율 찾음"), "{prompt}");
    }

    /// 선언하지 않은 단계에는 본문이 붙지 않는다. 그게 기본이다.
    #[test]
    fn a_step_without_a_reference_only_sees_the_one_line_note() {
        let mut draft = PlanDraft::new(catalog());
        draft
            .add_step("조사한다", &tools(&["bash"]), &[])
            .expect("1");
        draft
            .add_step("적는다", &tools(&["write"]), &[])
            .expect("2");
        let mut plan = draft.finish().expect("확정");
        plan.record(
            1,
            StepOutcome::Done {
                note: "환율 찾음".to_owned(),
            },
            "1달러 = 1380원, 출처 …",
        )
        .expect("기록");

        let prompt = plan.begin_step().expect("2단계").turn_prompt(false);
        assert!(!prompt.contains("1달러"), "{prompt}");
        assert!(prompt.contains("환율 찾음"), "{prompt}");
    }

    /// 참조는 앞 단계만, 그리고 몇 개까지만.
    #[test]
    fn a_reference_must_point_backwards_and_stay_within_the_cap() {
        let mut draft = PlanDraft::new(catalog());
        // 아직 아무 단계도 없는데 1번을 가리킬 수 없다.
        assert!(draft.add_step("적는다", &tools(&["write"]), &[1]).is_err());
        draft
            .add_step("조사한다", &tools(&["bash"]), &[])
            .expect("1");
        assert!(draft.add_step("적는다", &tools(&["write"]), &[2]).is_err());
        assert!(draft.add_step("적는다", &tools(&["write"]), &[0]).is_err());

        let many: Vec<usize> = (0..MAX_USES_PER_STEP + 1).map(|_| 1).collect();
        assert!(draft.add_step("적는다", &tools(&["write"]), &many).is_err());
    }

    /// 첫 단계에는 앞 메모가 없으므로 그 머리말도 없다.    /// 첫 단계에는 앞 메모가 없으므로 그 머리말도 없다.
    #[test]
    fn the_first_step_prompt_has_no_earlier_notes() {
        let plan = two_step_plan();
        let prompt = plan.begin_step().expect("첫 단계").turn_prompt(false);
        assert!(!prompt.contains("앞 단계에서"), "{prompt}");
        assert!(prompt.starts_with("이제 1단계다"), "{prompt}");
    }

    /// 재계획 글은 사용자 말과 지금 계획을 함께 펼치고, 끝난 단계를 표시한다.
    #[test]
    fn a_replan_prompt_shows_what_is_done_and_what_is_left() {
        let mut plan = two_step_plan();
        plan.record(
            1,
            StepOutcome::Done {
                note: "찾음".to_owned(),
            },
            "본문",
        )
        .expect("기록");

        let prompt = replan_turn_prompt(&plan, "  아, 노션 말고 파일로 저장해줘  ");
        assert!(prompt.contains("아, 노션 말고 파일로 저장해줘"), "{prompt}");
        assert!(prompt.contains("1. [끝남]"), "{prompt}");
        assert!(prompt.contains("2. [남음]"), "{prompt}");
        assert!(prompt.contains("끝난 단계는 되돌리지 않는다"), "{prompt}");
        assert!(prompt.contains("insert_step"), "{prompt}");
    }

    /// 색인은 **시스템 글**에 들어간다. 사용자 턴에 섞으면 하네스가 그것을 요약해 제목을
    /// 짓고(2026-09-27 ses_f218c2b06: "살아있니" → "Notion 도구 목록 공유 및 상태 확인"),
    /// 기록도 사용자가 도구 목록을 붙여넣은 것처럼 남는다.
    ///
    /// 목록이 무엇인지 한 줄로 말해 주는 것은 그대로 둔다 — 그 줄이 없으면 모델이 목록을
    /// 지금 부를 수 있는 도구로 읽는다(2026-09-26 실측에서 `read` 를 곧바로 불러 CPU 0/4).
    // 9.14: 읽기 전용은 색인만 좁히는 것이 아니라 거절할 자리도 준다.
    #[test]
    fn read_only_prompt_carries_the_exit_and_normal_prompt_does_not() {
        let normal = plan_system_prompt_for("- read: Reads one file.", false);
        let read_only = plan_system_prompt_for("- read: Reads one file.", true);
        assert!(!normal.contains(READ_ONLY_CLAUSE));
        assert!(read_only.contains(READ_ONLY_CLAUSE));
        assert!(
            read_only.ends_with("- read: Reads one file."),
            "색인은 끝에 그대로"
        );
        assert_eq!(normal, plan_system_prompt("- read: Reads one file."));
    }

    #[test]
    fn the_index_rides_in_the_system_prompt_not_the_user_turn() {
        let prompt = plan_system_prompt("- webfetch: URL 을 가져온다.");
        // 역할을 먼저 말하고 목록을 뒤에 둔다.
        let role_at = prompt
            .find("plans how to handle the request")
            .expect("역할");
        let index_at = prompt.find("- webfetch").expect("색인");
        assert!(role_at < index_at, "{prompt}");
        assert!(
            prompt.contains("write them into add_step's tools"),
            "{prompt}"
        );
        // 사용자의 말은 여기 없다 — 그것은 턴으로 따로 간다.
        assert!(!prompt.contains("---"), "{prompt}");
    }

    /// 계획 자리는 Idle → Drafting → Running(또는 Refused) 으로만 간다.
    #[test]
    fn the_plan_slot_walks_from_drafting_to_running() {
        let mut slot = PlanSlot::Idle;
        // 초안이 아닐 때 단계를 더하려 하면 무엇을 하고 있는지 말해 준다.
        assert!(slot.drafting().is_err());

        slot = PlanSlot::Drafting(PlanDraft::new(catalog()));
        slot.drafting()
            .expect("초안")
            .add_step("노션에서 찾는다", &["notion_search".to_owned()], &[])
            .expect("단계");
        assert_eq!(slot.finish().expect("확정"), 1);

        let PlanSlot::Running(plan) = &slot else {
            panic!("확정 뒤에는 Running 이어야 한다: {slot:?}");
        };
        assert_eq!(plan.steps().len(), 1);
        assert_eq!(plan.steps()[0].title, "노션에서 찾는다");
        // 확정된 계획에 add_step 을 또 부르면 insert_step 을 가리킨다.
        assert!(slot.drafting().is_err());
    }

    /// 조종 도구 이름을 한 글자 틀려도 되돌린다. 색인 도구 이름은 되돌리지 않는다.
    #[test]
    fn a_control_name_off_by_one_letter_is_repaired_but_a_tool_name_is_not() {
        assert_eq!(nearest_planning_tool("finiish_plan"), Some("finish_plan"));
        assert_eq!(nearest_planning_tool("add_step"), Some("add_step"));
        assert_eq!(nearest_planning_tool("Cannot_Do"), Some("cannot_do"));
        // 두 글자 이상 멀면 되돌리지 않는다.
        assert_eq!(nearest_planning_tool("finish"), None);
        // 색인 도구 이름은 여기 걸리지 않는다 — 한 글자로 뜻이 갈리는 이름이 실제로 있다.
        assert_eq!(nearest_planning_tool("notion-update-page"), None);
    }

    /// 껍데기가 호출마다 물을 값. 계획이 돌 때만 나온다.
    ///
    /// 계획이 없으면 제한이 없어야 한다 — 이 관문은 계획이 정한 것을 지키는 자리이지
    /// 새 정책이 아니다. 일반 채팅의 플러그인 호출까지 막으면 없던 규칙이 생긴다.
    #[test]
    fn the_shell_only_gets_an_allowlist_while_a_plan_is_running() {
        let mut slot = PlanSlot::Idle;
        assert_eq!(slot.current_step_tools(), None);

        slot = PlanSlot::Drafting(PlanDraft::new(catalog()));
        assert_eq!(
            slot.current_step_tools(),
            None,
            "계획을 세우는 중에는 단계가 없다"
        );

        slot.drafting()
            .expect("초안")
            .add_step("찾는다", &["notion_search".to_owned()], &[])
            .expect("단계");
        slot.finish().expect("확정");
        assert_eq!(
            slot.current_step_tools(),
            Some(vec!["notion_search".to_owned()])
        );

        // 바로 답하고 끝낸 계획에도 단계가 없다.
        let mut answered = PlanSlot::Drafting(PlanDraft::new(catalog()));
        answered.answer("바로 답함").expect("답");
        assert_eq!(answered.current_step_tools(), None);
    }

    /// 도구가 필요 없는 요청에는 넷째 출구가 있어야 한다.
    ///
    /// (가) 결정으로 모든 로컬 채팅이 계획 턴을 지난다 — 그러면 "안녕"도 여기로 온다.
    /// `finish_plan` 은 단계를 요구하고 `cannot_do` 는 "못 한다"라서 둘 다 거짓이 된다.
    /// 출구가 없는 자리에서 모델이 무엇을 하는지는 오늘 여러 번 봤다(지어내거나 맴돈다).
    #[test]
    fn a_request_that_needs_no_tool_can_be_answered_on_the_spot() {
        let mut slot = PlanSlot::Drafting(PlanDraft::new(catalog()));
        assert!(slot.answer("  ").is_err(), "빈 답은 거절한다");
        assert!(matches!(slot, PlanSlot::Drafting(_)), "{slot:?}");

        slot.answer("  안녕하세요. 무엇을 도와드릴까요?  ")
            .expect("답");
        let PlanSlot::Answered(answer) = &slot else {
            panic!("답한 뒤에는 Answered 여야 한다: {slot:?}");
        };
        assert_eq!(answer, "안녕하세요. 무엇을 도와드릴까요?");
        // 이미 답한 자리에 단계를 더하려 하면 그렇다고 말해 준다.
        assert!(slot.drafting().is_err());
    }

    /// 거절도 계획 자리가 표현하는 결말이다. 그리고 **실패한 확정이 계획을 지우지 않는다** —
    /// 오류 한 번에 초안이 사라지면 모델은 고칠 거리도 없이 처음부터 다시 세워야 한다.
    #[test]
    fn a_rejected_finish_keeps_the_draft_and_a_refusal_closes_it() {
        let mut slot = PlanSlot::Drafting(PlanDraft::new(catalog()));
        // 단계가 하나도 없으면 확정되지 않는다. 그래도 초안은 남아야 한다.
        assert!(slot.finish().is_err());
        assert!(matches!(slot, PlanSlot::Drafting(_)), "{slot:?}");

        assert!(slot.refuse("   ").is_err(), "빈 사유는 거절한다");
        assert!(matches!(slot, PlanSlot::Drafting(_)), "{slot:?}");

        slot.refuse("웹을 볼 도구가 없다").expect("거절");
        let PlanSlot::Refused(refusal) = &slot else {
            panic!("거절 뒤에는 Refused 여야 한다: {slot:?}");
        };
        assert_eq!(refusal.reason(), "웹을 볼 도구가 없다");
    }

    /// 색인은 `id + 한 줄 설명`이고, 같은 도구를 여러 플러그인이 들고 있으면 한 줄로 접는다.
    ///
    /// 2026-09-26 실측: notion-team 과 notion-personal 는 45개가 정확히 겹쳐, 두 번 적으면
    /// 9,005자인 것이 접으면 6,104자가 된다. 계획 턴 프롬프트에 싣는 글이라 그 차이가 그대로
    /// 맥락 값이다.
    ///
    /// 줄 이음(`\` + 줄바꿈)을 쓰지 않는다 — 이 저장소는 작업 사본을 CRLF 로 두어 앞 공백이
    /// 걷히지 않고 기대값에 섞여 들어간다(실제로 한 번 당했다).
    #[test]
    fn the_index_folds_tools_that_several_plugins_share() {
        let tools = vec![
            ("notion-fetch".to_owned(), "Fetch a page by id.".to_owned()),
            ("notion-search".to_owned(), "Search pages.".to_owned()),
        ];
        let catalogs = vec![
            ("notion-team".to_owned(), tools.clone()),
            ("notion-personal".to_owned(), tools),
        ];
        let index = tool_index(&catalogs);
        assert_eq!(
            index.lines().collect::<Vec<_>>(),
            vec![
                "- notion-fetch (notion-team | notion-personal): Fetch a page by id.",
                "- notion-search (notion-team | notion-personal): Search pages.",
            ]
        );
    }

    /// 마크다운 헤딩으로 시작하는 설명에서 첫 **산문** 줄을 잡는다.
    ///
    /// 그냥 첫 줄을 잡으면 하필 가장 많이 쓰는 둘이 빈칸으로 나온다 — 노션의
    /// `create-pages`·`update-page` 설명이 `## Overview` 로 시작한다(2026-09-26 실측에서
    /// 실제로 비었다). 설명 없는 이름만 남으면 계획이 무엇을 고르는지 알 수 없다.
    #[test]
    fn the_index_skips_markdown_headings_to_find_the_description() {
        let description = "## Overview

Creates one or more Notion pages."
            .to_owned();
        let catalogs = vec![(
            "notion-team".to_owned(),
            vec![("notion-create-pages".to_owned(), description)],
        )];
        assert_eq!(
            tool_index(&catalogs),
            "- notion-create-pages (notion-team): Creates one or more Notion pages."
        );
    }

    /// 색인은 **긴** 설명만 첫 문장에서 끊는다.
    ///
    /// 길이와 상관없이 첫 `". "` 에서 끊던 동안, 우리가 색인용으로 적은 작업 공간 설명의
    /// 두 번째 문장이 한 번도 모델에 닿지 않았다(아래 시험이 그 자리다). 상류 플러그인
    /// 설명은 첫 줄만 501자까지 오므로 자르는 일 자체는 남아야 한다 — 가르는 것은 길이다.
    #[test]
    fn the_index_cuts_at_a_sentence_only_when_the_line_is_long() {
        let short = "Writes content to one file. Overwrites the whole file.";
        let long = format!(
            "{}. {}",
            "A".repeat(MAX_INDEX_DESCRIPTION_CHARS),
            "Tail follows."
        );
        let catalogs = vec![(
            String::new(),
            vec![
                ("write".to_owned(), short.to_owned()),
                ("long".to_owned(), long.clone()),
            ],
        )];
        let index = tool_index(&catalogs);
        assert_eq!(
            index.lines().next(),
            Some(format!("- write: {short}").as_str())
        );
        assert_eq!(
            index.lines().nth(1),
            Some(format!("- long: {}.", "A".repeat(MAX_INDEX_DESCRIPTION_CHARS)).as_str())
        );
    }

    /// 계획 턴 색인은 우리가 적은 작업 공간 설명을 **통째로** 싣는다.
    ///
    /// 문구 하나를 훑는 대신 켜진 것 전부를 센다. 2026-10-02 코드 리팩토링 10회차에서
    /// 드러난 자리라서다: `write`/`edit`/`bash`/`webfetch` 의 두 번째 문장 — 둘을 **가르는**
    /// 말 — 이 `first_line` 의 문장 경계에 걸려 색인에 한 번도 실리지 않았다. 설명을
    /// 늘리거나 줄이는 사람에게 색인도 같이 보라고 말해 주는 것이 이 시험의 일이다.
    #[test]
    fn the_index_carries_every_workspace_tool_description_whole() {
        for read_only in [false, true] {
            let described = crate::opencode_config::workspace_tool_descriptions(read_only);
            let catalogs = vec![(
                String::new(),
                described
                    .iter()
                    .map(|(name, text)| ((*name).to_owned(), (*text).to_owned()))
                    .collect::<Vec<_>>(),
            )];
            let index = tool_index(&catalogs);
            assert_eq!(
                index.lines().count(),
                described.len(),
                "색인 줄 수가 켜진 작업 공간 도구 수와 다르다 (read_only={read_only})"
            );
            for (name, text) in &described {
                assert!(
                    index
                        .lines()
                        .any(|line| line == format!("- {name}: {text}")),
                    "'{name}' 설명이 색인에 통째로 실리지 않았다: {index}"
                );
            }
        }
    }

    /// 플러그인이 아닌 도구는 소유자를 적지 않는다. 괄호가 비면 읽는 쪽이 헷갈린다.
    #[test]
    fn a_tool_without_a_plugin_is_listed_bare() {
        let catalogs = vec![(
            String::new(),
            vec![("webfetch".to_owned(), "URL 의 내용을 가져온다.".to_owned())],
        )];
        assert_eq!(tool_index(&catalogs), "- webfetch: URL 의 내용을 가져온다.");
    }

    fn catalog() -> ToolCatalog {
        ToolCatalog::new(["notion_search", "notion_fetch", "bash", "read", "write"])
    }

    fn tools(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    fn two_step_plan() -> Plan {
        let mut draft = PlanDraft::new(catalog());
        draft
            .add_step("검색한다", &tools(&["notion_search"]), &[])
            .unwrap();
        draft
            .add_step("읽는다", &tools(&["notion_fetch"]), &[])
            .unwrap();
        draft.finish().unwrap()
    }

    fn failed_first_step() -> Plan {
        let mut plan = two_step_plan();
        plan.record(
            1,
            StepOutcome::Failed {
                reason: "검색이 비었다".to_string(),
            },
            "본문",
        )
        .unwrap();
        plan
    }

    #[test]
    fn retry_reopens_the_step_until_the_cap() {
        let mut plan = failed_first_step();
        assert_eq!(
            plan.resolve(1, StepResolution::Retry).unwrap(),
            ResolutionEffect::Retried { remaining: 1 }
        );
        assert_eq!(plan.current().unwrap().number, 1);

        plan.record(
            1,
            StepOutcome::Failed {
                reason: "또 비었다".to_string(),
            },
            "",
        )
        .unwrap();
        assert_eq!(
            plan.resolve(1, StepResolution::Retry).unwrap(),
            ResolutionEffect::Retried { remaining: 0 }
        );

        plan.record(
            1,
            StepOutcome::Failed {
                reason: "세 번째".to_string(),
            },
            "",
        )
        .unwrap();
        let message = plan
            .resolve(1, StepResolution::Retry)
            .unwrap_err()
            .to_string();
        assert!(message.contains("skip"), "{message}");
        // 막다른 길로 끝나지 않는다 — 남은 갈래는 그대로 열려 있다.
        assert_eq!(
            plan.resolve(
                1,
                StepResolution::Skip {
                    reason: "포기".to_string()
                }
            )
            .unwrap(),
            ResolutionEffect::Continued
        );
    }

    #[test]
    fn skip_and_replan_keep_the_failure_visible() {
        let mut plan = failed_first_step();
        assert_eq!(
            plan.resolve(
                1,
                StepResolution::Replan {
                    reason: "다른 길로".to_string()
                }
            )
            .unwrap(),
            ResolutionEffect::Replan
        );
        // 계획 상태는 그대로고 진행 지점만 다음 단계다.
        assert!(plan.has_failure());
        assert_eq!(plan.current().unwrap().number, 2);
        assert_eq!(plan.records().len(), 1);
    }

    #[test]
    fn abort_folds_every_remaining_step() {
        let mut plan = failed_first_step();
        assert_eq!(
            plan.resolve(
                1,
                StepResolution::Abort {
                    reason: "더 할 수 없다".to_string()
                }
            )
            .unwrap(),
            ResolutionEffect::Aborted { skipped: 1 }
        );
        assert!(plan.is_complete());
        assert!(plan.has_failure());
        // 돌지 않은 단계는 쌓인 결과에 들어가지 않는다 — 일어나지 않은 일이다.
        assert_eq!(plan.records().len(), 1);
    }

    #[test]
    fn resolving_a_step_that_did_not_fail_is_refused() {
        let mut plan = two_step_plan();
        let message = plan
            .resolve(1, StepResolution::Retry)
            .unwrap_err()
            .to_string();
        assert!(message.contains("실패한 단계"), "{message}");

        plan.record(
            1,
            StepOutcome::Done {
                note: "됐다".to_string(),
            },
            "",
        )
        .unwrap();
        assert!(plan.resolve(1, StepResolution::Retry).is_err());
        assert!(plan.resolve(9, StepResolution::Retry).is_err());
    }

    #[test]
    fn resolution_is_parsed_with_the_real_branch_names() {
        assert_eq!(
            parse_resolution("retry", None).unwrap(),
            StepResolution::Retry
        );
        assert_eq!(
            parse_resolution(" ABORT ", Some(" 끝 ")).unwrap(),
            StepResolution::Abort {
                reason: "끝".to_string()
            }
        );
        let message = parse_resolution("giveup", None).unwrap_err().to_string();
        for branch in ["retry", "skip", "replan", "abort"] {
            assert!(message.contains(branch), "{message}");
        }
        assert!(parse_resolution("skip", None).is_err());
        assert!(parse_resolution("replan", Some("  ")).is_err());
    }

    #[test]
    fn unattended_runs_never_wait_for_an_answer() {
        assert!(resolution_needs_user(ChatApprovalMode::Manual, true));
        assert!(!resolution_needs_user(ChatApprovalMode::Never, true));
        // 물을 사람이 없는 실행에서는 모드와 무관하게 묻지 않는다.
        assert!(!resolution_needs_user(ChatApprovalMode::Manual, false));
    }

    #[test]
    fn catalog_is_sorted_and_deduped() {
        let catalog = ToolCatalog::new(["read", "bash", "read"]);
        assert_eq!(catalog.names(), ["bash", "read"]);
        assert!(!catalog.is_empty());
    }

    #[test]
    fn numbers_are_assigned_in_call_order() {
        let mut draft = PlanDraft::new(catalog());
        assert!(draft.is_empty());
        assert_eq!(
            draft
                .add_step("검색한다", &tools(&["notion_search"]), &[])
                .unwrap(),
            1
        );
        assert_eq!(
            draft
                .add_step("읽는다", &tools(&["notion_fetch"]), &[])
                .unwrap(),
            2
        );
        assert_eq!(draft.len(), 2);
        let plan = draft.finish().unwrap();
        assert_eq!(
            plan.steps()
                .iter()
                .map(|step| step.number)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        assert_eq!(plan.catalog().names().len(), 5);
    }

    // 2026-09-27 측정(m2-w2n-gpu 11·14, en-gpu4 9·11·16): "노션에 정리" 단계에 write 를 골랐다.
    // 등록된 이름 목록이 말하는 사실로 되물어, 그 플러그인의 도구를 다시 고르게 한다.
    #[test]
    fn a_step_that_names_a_plugin_must_use_one_of_its_tools() {
        let catalogs = vec![
            (
                String::new(),
                vec![
                    ("write".to_owned(), "Writes content to one file.".to_owned()),
                    (
                        "webfetch".to_owned(),
                        "Fetches the content of a URL.".to_owned(),
                    ),
                ],
            ),
            (
                "notion-team · 노션 · Notion | notion-personal · 노션".to_owned(),
                vec![
                    (
                        "notion-create-pages".to_owned(),
                        "Creates pages.".to_owned(),
                    ),
                    ("notion-search".to_owned(), "Searches.".to_owned()),
                ],
            ),
            // 이름을 등록하지 않은 플러그인은 묶음이 없다 — id 로는 되묻지 않는다.
            (
                "github".to_owned(),
                vec![("github-search".to_owned(), "Searches GitHub.".to_owned())],
            ),
        ];
        let catalog = ToolCatalog::from_catalogs(&catalogs);
        assert_eq!(catalog.groups().len(), 1);
        assert_eq!(catalog.groups()[0].aliases, vec!["Notion", "노션"]);
        let mut draft = PlanDraft::new(catalog);
        let error = draft
            .add_step(
                "조사한 React 버전 정보를 노션에 정리",
                &["write".into()],
                &[],
            )
            .expect_err("노션을 말하는데 write");
        let text = error.to_string();
        assert!(text.contains("mentions '노션'"), "{text}");
        assert!(
            text.contains("notion-create-pages, notion-search"),
            "{text}"
        );
        // 그 플러그인 도구를 고르면 통과하고, 플러그인을 말하지 않는 write 도 통과한다.
        draft
            .add_step(
                "조사한 React 버전 정보를 노션에 정리",
                &["notion-create-pages".into()],
                &[],
            )
            .unwrap();
        draft
            .add_step("조사 결과를 파일로 저장", &["write".into()], &[])
            .unwrap();
        // 대소문자를 가리지 않는다.
        assert!(draft
            .add_step("Save to NOTION", &["webfetch".into()], &[])
            .is_err());
        // id 만 겹치는 제목은 되묻지 않는다.
        draft
            .add_step(
                "GitHub 릴리스 페이지에서 최신 버전 읽기",
                &["webfetch".into()],
                &[],
            )
            .unwrap();
    }

    /// 제목이 "고친다"고 말하는데 도구가 읽기만 하는 단계는 되묻는다.
    ///
    /// 2026-10-02 코드 리팩토링 11회차, GPU `local-refactor` n=20 의 실패 2건 가운데 1건이
    /// 그대로 이 모양이었다 — 아래 제목과 도구는 그 시행이 실제로 보낸 값이다. 계획은
    /// `확정` 으로 끝나고 파일은 그대로였다.
    #[test]
    fn a_step_that_says_it_changes_the_file_must_use_a_writing_tool() {
        let catalogs = vec![(
            String::new(),
            crate::opencode_config::workspace_tool_descriptions(false)
                .into_iter()
                .map(|(name, text)| (name.to_owned(), text.to_owned()))
                .collect::<Vec<_>>(),
        )];
        let mut draft = PlanDraft::new(ToolCatalog::from_catalogs(&catalogs));
        let text = draft
            .add_step(
                "report.mjs 에서 두 번 반복되는 서식 코드를 확인하고 동일한 패턴을 찾기 위해 수정하기",
                &["read".into()],
                &[],
            )
            .expect_err("고친다는 제목에 read")
            .to_string();
        assert!(text.contains("'read' only reads"), "{text}");
        // 고칠 수 있는 도구 이름은 목록에서 읽는다 — 상수로 적힌 문장이 아니다.
        for writer in crate::opencode_config::writing_workspace_tools() {
            assert!(text.contains(writer), "{writer} 가 빠졌다: {text}");
        }
        // 같은 제목에 쓰기 도구를 고르면 통과한다.
        draft
            .add_step("중복 서식 코드를 함수로 묶어 수정", &["edit".into()], &[])
            .unwrap();
        // 읽기만 한다고 말하는 제목은 건드리지 않는다 — 울타리가 아니라 되묻기다.
        draft
            .add_step("report.mjs 를 읽어 중복 구간을 확인", &["read".into()], &[])
            .unwrap();
        // 읽기 전용 모드에는 고칠 수 있는 도구가 없으므로 발동하지 않는다.
        let read_only = vec![(
            String::new(),
            crate::opencode_config::workspace_tool_descriptions(true)
                .into_iter()
                .map(|(name, text)| (name.to_owned(), text.to_owned()))
                .collect::<Vec<_>>(),
        )];
        PlanDraft::new(ToolCatalog::from_catalogs(&read_only))
            .add_step("파일을 수정한다", &["read".into()], &[])
            .unwrap();
    }

    /// 요청은 고치라는데 계획이 읽기만 하면 확정을 한 번 되돌린다.
    ///
    /// 2026-10-03 코드 리팩토링 12회차, GPU `local-refactor` 끼워넣기 40시행의 실패 13건
    /// 가운데 3건이 이 모양이었다. 아래 요청과 단계는 trim-write 19 시행이 실제로 보낸
    /// 값이다 — 한 단계, 제목에 고친다는 말이 없어 단계 되묻기가 발동하지 못했고, 계획은
    /// `확정` 으로 끝나고 파일은 그대로였다.
    #[test]
    fn a_read_only_plan_for_a_request_that_asks_for_a_change_is_bounced_once() {
        let catalogs = vec![(
            String::new(),
            crate::opencode_config::workspace_tool_descriptions(false)
                .into_iter()
                .map(|(name, text)| (name.to_owned(), text.to_owned()))
                .collect::<Vec<_>>(),
        )];
        let request = "report.mjs 안에 같은 서식 코드가 두 번 반복돼. 그 부분을 함수 하나로 뽑아내서 양쪽이 같이 쓰게 고쳐줘.";
        let draft = || {
            let mut draft =
                PlanDraft::new(ToolCatalog::from_catalogs(&catalogs)).with_request(request);
            draft
                .add_step("report.mjs 파일 읽어서 내용 확인", &["read".into()], &[])
                .unwrap();
            PlanSlot::Drafting(draft)
        };

        let mut slot = draft();
        let text = slot.finish().expect_err("읽기만 하는 계획").to_string();
        // 고칠 수 있는 도구 이름은 목록에서 읽는다 — 상수로 적힌 문장이 아니다.
        for writer in crate::opencode_config::writing_workspace_tools() {
            assert!(text.contains(writer), "{writer} 가 빠졌다: {text}");
        }
        // 출구를 함께 준다. 막는 것이 아니라 되묻는 것이다.
        assert!(text.contains("cannot_do"), "{text}");
        // 되돌린 뒤에도 초안은 남아 있어야 한다 — 다시 세우게 만들면 되묻기가 손해다.
        assert!(matches!(slot, PlanSlot::Drafting(_)), "초안이 사라졌다");
        // 두 번째 확정은 그대로 받는다. 되묻기가 영영 막으면 진짜 읽기 계획이 갇힌다.
        assert_eq!(slot.finish().unwrap(), 1);

        // 고치는 단계가 하나라도 있으면 발동하지 않는다. `bash` 도 파일을 쓴다.
        for writer in crate::opencode_config::writing_workspace_tools() {
            let mut slot = draft();
            let PlanSlot::Drafting(d) = &mut slot else {
                unreachable!()
            };
            d.add_step("중복 코드를 함수로 묶는다", &[(*writer).into()], &[])
                .unwrap();
            assert_eq!(slot.finish().unwrap(), 2, "{writer}");
        }

        // 고치라는 말이 없는 요청은 건드리지 않는다.
        let mut slot = {
            let mut d = PlanDraft::new(ToolCatalog::from_catalogs(&catalogs))
                .with_request("이 폴더 package.json 의 name 필드가 무엇인지 읽어서 알려줘.");
            d.add_step("package.json 을 읽는다", &["read".into()], &[])
                .unwrap();
            PlanSlot::Drafting(d)
        };
        assert_eq!(slot.finish().unwrap(), 1);

        // 읽기 전용 모드에는 고칠 수 있는 도구가 없으므로 발동하지 않는다.
        let read_only = vec![(
            String::new(),
            crate::opencode_config::workspace_tool_descriptions(true)
                .into_iter()
                .map(|(name, text)| (name.to_owned(), text.to_owned()))
                .collect::<Vec<_>>(),
        )];
        let mut slot = {
            let mut d =
                PlanDraft::new(ToolCatalog::from_catalogs(&read_only)).with_request(request);
            d.add_step("report.mjs 파일 읽어서 내용 확인", &["read".into()], &[])
                .unwrap();
            PlanSlot::Drafting(d)
        };
        assert_eq!(slot.finish().unwrap(), 1);
    }

    #[test]
    fn unknown_tool_is_refused_with_the_real_names() {
        let mut draft = PlanDraft::new(catalog());
        let message = draft
            .add_step("검색한다", &tools(&["notion_serch"]), &[])
            .unwrap_err()
            .to_string();
        assert!(message.contains("notion_serch"), "{message}");
        assert!(message.contains("notion_search"), "{message}");
        assert!(message.contains("bash"), "{message}");
    }

    // 2026-09-27 ses_f1d138d25: 도구를 부르지 않고 끝난 단계는 같은 단계를 더 강한 지시로 다시 보낸다.
    #[test]
    fn an_unstarted_step_is_sent_again_with_a_sharper_instruction_up_to_the_retry_limit() {
        let mut draft = PlanDraft::new(ToolCatalog::new(["agent-manager_system_execute", "read"]));
        draft
            .add_step(
                "세션마다 폴더 적기",
                &tools(&["agent-manager_system_execute"]),
                &[],
            )
            .unwrap();
        let mut plan = draft.finish().unwrap();
        let first = plan.begin_step().expect("첫 시도");
        assert!(!first.turn_prompt(false).contains("부르지 않고 글만"));
        plan.record(
            1,
            StepOutcome::Failed {
                reason: "도구를 부르지 않고 끝냈다".to_owned(),
            },
            "",
        )
        .unwrap();
        assert!(plan.retry_unstarted(1));
        assert!(plan.records().is_empty(), "실패 기록은 지운다");
        let again = plan.begin_step().expect("다시 보낼 단계");
        assert_eq!(again.number(), 1);
        let prompt = again.turn_prompt(false);
        assert!(prompt.contains("부르지 않고 글만 쓰고 끝냈다"), "{prompt}");
        assert!(
            prompt.contains("agent-manager_system_execute 을(를) 바로 호출하라"),
            "{prompt}"
        );
        assert!(again
            .turn_prompt(true)
            .contains("call_tool 을(를) 바로 호출하라"));
        // 상한까지만 다시 보낸다. 그 뒤는 실패로 남아 종합으로 간다.
        plan.record(
            1,
            StepOutcome::Failed {
                reason: "도구를 부르지 않고 끝냈다".to_owned(),
            },
            "",
        )
        .unwrap();
        assert!(plan.retry_unstarted(1));
        plan.record(
            1,
            StepOutcome::Failed {
                reason: "도구를 부르지 않고 끝냈다".to_owned(),
            },
            "",
        )
        .unwrap();
        assert!(!plan.retry_unstarted(1));
        assert_eq!(plan.records().len(), 1);
        assert!(plan.begin_step().is_none());
        // 성공한 단계는 다시 보내지 않는다.
        let mut draft = PlanDraft::new(ToolCatalog::new(["read"]));
        draft.add_step("읽기", &tools(&["read"]), &[]).unwrap();
        let mut done = draft.finish().unwrap();
        done.record(
            1,
            StepOutcome::Done {
                note: "됐다".to_owned(),
            },
            "",
        )
        .unwrap();
        assert!(!done.retry_unstarted(1));
    }

    // 2026-09-27 ses_f1eb2aa91: 제목이 길다고 거절하는 동안 단계 순서가 뒤집혔다. 잘라 받는다.
    #[test]
    fn an_overlong_step_title_is_cut_instead_of_rejected() {
        let long = "가".repeat(MAX_STEP_TITLE_CHARS + 30);
        let cut = normalize_title(&long).expect("잘라 받는다");
        assert_eq!(cut.chars().count(), MAX_STEP_TITLE_CHARS);
        assert_eq!(normalize_title("  짧다  ").unwrap(), "짧다");
        assert!(normalize_title("   ").is_err());
        assert!(normalize_title("줄\u{7}바꿈").is_err());
    }

    #[test]
    fn a_long_name_list_is_cut_and_says_how_many_are_left() {
        let catalog = ToolCatalog::new((0..30).map(|index| format!("tool_{index:02}")));
        let mut draft = PlanDraft::new(catalog);
        let message = draft
            .add_step("한다", &tools(&["없는것"]), &[])
            .unwrap_err()
            .to_string();
        assert!(message.contains("and 10 more"), "{message}");
    }

    #[test]
    fn step_count_and_tool_count_hit_their_caps() {
        let mut draft = PlanDraft::new(catalog());
        for index in 0..MAX_PLAN_STEPS {
            draft
                .add_step(&format!("{index}단계"), &tools(&["bash"]), &[])
                .unwrap();
        }
        assert!(draft.add_step("하나 더", &tools(&["bash"]), &[]).is_err());

        let mut draft = PlanDraft::new(ToolCatalog::new(
            (0..6).map(|index| format!("tool_{index}")),
        ));
        let many: Vec<String> = (0..MAX_TOOLS_PER_STEP + 1)
            .map(|index| format!("tool_{index}"))
            .collect();
        assert!(draft.add_step("한다", &many, &[]).is_err());
    }

    #[test]
    fn a_step_without_tools_and_an_empty_plan_are_refused() {
        let mut draft = PlanDraft::new(catalog());
        assert!(draft.add_step("한다", &[], &[]).is_err());
        assert!(draft.add_step("", &tools(&["bash"]), &[]).is_err());
        assert!(draft.add_step("줄\n바꿈", &tools(&["bash"]), &[]).is_err());
        assert!(PlanDraft::new(catalog()).finish().is_err());
    }

    #[test]
    fn the_same_tool_twice_counts_once() {
        let mut draft = PlanDraft::new(catalog());
        draft
            .add_step("한다", &tools(&["bash", "bash"]), &[])
            .unwrap();
        let plan = draft.finish().unwrap();
        assert_eq!(plan.steps()[0].tools, ["bash"]);
    }

    #[test]
    fn progress_points_at_the_first_step_without_an_outcome() {
        let mut plan = two_step_plan();
        assert_eq!(plan.current().unwrap().number, 1);
        plan.record(
            1,
            StepOutcome::Done {
                note: "페이지 3건".to_string(),
            },
            "",
        )
        .unwrap();
        assert_eq!(plan.current().unwrap().number, 2);
        assert_eq!(plan.notes(), [(1, "페이지 3건")]);
        assert!(!plan.is_complete());
        assert!(!plan.has_failure());
        plan.record(
            2,
            StepOutcome::Failed {
                reason: "404".to_string(),
            },
            "",
        )
        .unwrap();
        assert!(plan.is_complete());
        assert!(plan.has_failure());
        assert_eq!(plan.notes(), [(1, "페이지 3건")]);
    }

    #[test]
    fn a_skipped_step_is_neither_a_note_nor_a_failure() {
        let mut plan = two_step_plan();
        plan.record(
            1,
            StepOutcome::Skipped {
                reason: "이미 있다".to_string(),
            },
            "",
        )
        .unwrap();
        assert!(plan.notes().is_empty());
        assert!(!plan.has_failure());
        assert_eq!(plan.current().unwrap().number, 2);
    }

    #[test]
    fn a_finished_step_is_not_written_twice() {
        let mut plan = two_step_plan();
        plan.record(1, StepOutcome::Done { note: "ok".into() }, "")
            .unwrap();
        assert!(plan
            .record(1, StepOutcome::Done { note: "ok".into() }, "")
            .is_err());
        assert!(plan
            .record(9, StepOutcome::Done { note: "ok".into() }, "")
            .is_err());
    }

    #[test]
    fn a_note_is_clamped_and_loses_its_line_breaks() {
        let mut plan = two_step_plan();
        let long = "가".repeat(MAX_STEP_NOTE_CHARS + 50);
        plan.record(1, StepOutcome::Done { note: long }, "")
            .unwrap();
        assert_eq!(plan.notes()[0].1.chars().count(), MAX_STEP_NOTE_CHARS);

        let mut plan = two_step_plan();
        plan.record(
            1,
            StepOutcome::Done {
                note: " 앞\n뒤 ".to_string(),
            },
            "",
        )
        .unwrap();
        assert_eq!(plan.notes()[0].1, "앞 뒤");
    }

    #[test]
    fn an_inserted_step_renumbers_the_plan() {
        let mut plan = two_step_plan();
        plan.record(1, StepOutcome::Done { note: "ok".into() }, "")
            .unwrap();
        let number = plan
            .insert_after(Some(1), "사이에 한다", &tools(&["read"]))
            .unwrap();
        assert_eq!(number, 2);
        assert_eq!(
            plan.steps()
                .iter()
                .map(|step| step.title.as_str())
                .collect::<Vec<_>>(),
            ["검색한다", "사이에 한다", "읽는다"]
        );
        assert_eq!(
            plan.steps()
                .iter()
                .map(|step| step.number)
                .collect::<Vec<_>>(),
            [1, 2, 3]
        );
        // 끝난 단계의 결말은 번호를 다시 매겨도 그대로 남는다.
        assert_eq!(plan.notes(), [(1, "ok")]);
        assert_eq!(plan.current().unwrap().number, 2);
    }

    #[test]
    fn the_front_is_insertable_and_an_unknown_step_is_not() {
        let mut plan = two_step_plan();
        plan.insert_after(None, "먼저 한다", &tools(&["read"]))
            .unwrap();
        assert_eq!(plan.steps()[0].title, "먼저 한다");
        assert!(plan
            .insert_after(Some(9), "한다", &tools(&["read"]))
            .is_err());
    }

    #[test]
    fn insertion_takes_the_same_caps_and_tool_checks() {
        let mut plan = two_step_plan();
        assert!(plan
            .insert_after(Some(1), "한다", &tools(&["없는것"]))
            .is_err());
        while plan.steps().len() < MAX_PLAN_STEPS {
            plan.insert_after(Some(1), "채운다", &tools(&["read"]))
                .unwrap();
        }
        assert!(plan
            .insert_after(Some(1), "하나 더", &tools(&["read"]))
            .is_err());
    }

    #[test]
    fn a_refusal_drops_the_steps_it_had_invented() {
        let mut draft = PlanDraft::new(catalog());
        draft
            .add_step("그럴듯한 단계", &tools(&["read"]), &[])
            .unwrap();
        let refusal = draft.refuse("요금제 변경은 이 도구로 할 수 없다").unwrap();
        assert_eq!(refusal.reason(), "요금제 변경은 이 도구로 할 수 없다");
    }

    /// 2026-09-26 실기기 ses_f2251f5ec: 계획 턴이 `webfetch` 를 곧바로 불렀고, 하네스가
    /// `Model tried to call unavailable tool 'webfetch'` 로 되돌리자 모델이 그 문장을 믿고
    /// "webfetch 도구가 사용 불가하여 인터넷에서 조사할 수 없습니다"로 거절했다. 그 도구는
    /// 그 단계를 돌릴 때 열리므로 거절이 틀렸다. 한 번 되돌려 준다.
    #[test]
    fn a_refusal_right_after_a_direct_index_call_is_sent_back() {
        let mut slot = PlanSlot::Drafting(PlanDraft::new(catalog()));
        slot.note_direct_index_call("read");

        let error = slot
            .refuse("read 도구가 없어 파일을 볼 수 없습니다")
            .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("read"), "{message}");
        assert!(message.contains("add_step"), "{message}");
        // 계획은 살아 있어야 모델이 이어서 고친다.
        assert!(matches!(slot, PlanSlot::Drafting(_)));

        // 두 번째는 그대로 받는다 — 진짜로 못 하는 일까지 막으면 안 된다.
        slot.refuse("read 도구가 없어 파일을 볼 수 없습니다")
            .unwrap();
        assert!(matches!(slot, PlanSlot::Refused(_)));
    }

    /// 2026-09-26 GPU 탐침 web-to-notion 8회차: webfetch·read·notion-create-pages 세
    /// 단계를 적은 **뒤에** cannot_do 를 불렀다. 요청을 덮는 계획을 쥐고 거절한 것이라
    /// 받아 주면 안 된다. answer_now 가 같은 자리에서 막히는 것과 같은 규칙이다.
    #[test]
    fn a_refusal_with_steps_already_recorded_is_sent_back() {
        let mut slot = PlanSlot::Drafting(PlanDraft::new(catalog()));
        slot.drafting()
            .unwrap()
            .add_step("노션에서 찾는다", &tools(&["notion_search"]), &[])
            .unwrap();

        let error = slot.refuse("이 도구로는 못 합니다").unwrap_err();
        let message = error.to_string();
        assert!(message.contains("1 step"), "{message}");
        assert!(message.contains("finish_plan"), "{message}");
        assert!(matches!(slot, PlanSlot::Drafting(_)));

        // 두 번째는 그대로 받는다.
        slot.refuse("이 도구로는 못 합니다").unwrap();
        assert!(matches!(slot, PlanSlot::Refused(_)));
    }

    /// 초안이 비어 있으면 곧바로 거절할 수 있다 — 되돌릴 근거가 없다.
    #[test]
    fn a_refusal_from_an_empty_draft_is_honoured_at_once() {
        let mut slot = PlanSlot::Drafting(PlanDraft::new(catalog()));
        slot.refuse("지메일은 이 도구로 못 읽는다").unwrap();
        assert!(matches!(slot, PlanSlot::Refused(_)));
    }

    /// 색인에 없는 이름을 부른 뒤의 거절은 건드리지 않는다. 되돌릴 근거가 없다.
    #[test]
    fn a_refusal_without_a_direct_index_call_is_honoured() {
        let mut slot = PlanSlot::Drafting(PlanDraft::new(catalog()));
        slot.refuse("지메일은 이 도구로 못 읽는다").unwrap();
        assert!(matches!(slot, PlanSlot::Refused(_)));
    }

    /// 표식은 색인에 **있는** 이름일 때만 붙는다 — 그 판단은 부르는 쪽(chat.rs)이 하고,
    /// 계획 중이 아닐 때는 적어 둘 자리도 없다.
    #[test]
    fn a_direct_call_note_needs_a_running_draft() {
        let mut slot = PlanSlot::Idle;
        slot.note_direct_index_call("read");
        assert!(matches!(slot, PlanSlot::Idle));
        assert!(!slot.indexes_tool("read"));
    }

    #[test]
    fn a_refusal_without_a_reason_is_not_a_refusal() {
        let draft = PlanDraft::new(catalog());
        assert!(draft.clone().refuse("  ").is_err());
        let long = "가".repeat(MAX_REFUSAL_REASON_CHARS + 1);
        assert!(draft.refuse(&long).is_err());
    }

    /// 2026-09-25 실측: 배열 안에 객체를 둔 모양은 CPU 레인 0/6이었고, 깨질 때 `tools`가
    /// 통째로 사라졌다. 스키마가 다시 중첩되면 M9 의 뒤가 전부 따라 틀어지므로 박아 둔다.
    fn schema(name: &str) -> Value {
        json!({
            "name": name,
            "parameters": { "type": "object", "properties": {} },
        })
    }

    fn server_catalog() -> Vec<Value> {
        catalog().names().iter().map(|name| schema(name)).collect()
    }

    #[test]
    fn a_step_carries_only_its_own_tool_schemas() {
        let plan = two_step_plan();
        let step = plan.begin_step().expect("첫 단계");
        assert_eq!(step.number(), 1);
        assert_eq!(step.allowed_tools(), ["notion_search"]);

        let loaded = step.tool_schemas(&server_catalog()).unwrap();
        let names: Vec<String> = loaded
            .iter()
            .filter_map(|schema| schema.get("name").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        // 이 단계가 선언한 하나 + 실행 중에 늘 열려 있는 도구. 나머지 넷은 실리지 않는다.
        // 늘 열린 도구의 목록을 여기 적어 두지 않는 것은 그것이 늘어나기 때문이다
        // (9.6의 resolve, 9.7의 decide). 지켜야 할 것은 그 목록이 아니라 "선언한 것 외에
        // 일하는 도구가 실리지 않는다"이다.
        let mut expected = vec!["notion_search".to_string()];
        expected.extend(step_control_tool_names());
        assert_eq!(names, expected);
        assert!(
            !names.iter().any(|name| name == "notion_fetch"),
            "{names:?}"
        );
    }

    #[test]
    fn a_declared_tool_missing_from_the_server_is_refused() {
        let plan = two_step_plan();
        let step = plan.begin_step().unwrap();
        let thinned: Vec<Value> = server_catalog()
            .into_iter()
            .filter(|schema| schema["name"] != "notion_search")
            .collect();
        let message = step.tool_schemas(&thinned).unwrap_err().to_string();
        assert!(message.contains("notion_search"), "{message}");
    }

    #[test]
    fn the_allowlist_is_enforced_per_step() {
        let plan = two_step_plan();
        let step = plan.begin_step().unwrap();
        step.authorize("notion_search").unwrap();
        // 계획을 움직이는 도구는 선언하지 않아도 늘 열려 있다.
        step.authorize("insert_step").unwrap();
        // 카탈로그에는 있지만 이 단계가 선언하지 않은 도구는 막힌다 — 다음 단계 것이라도.
        let message = step.authorize("notion_fetch").unwrap_err().to_string();
        assert!(message.contains("notion_fetch"), "{message}");
        assert!(message.contains("notion_search"), "{message}");
    }

    #[test]
    fn step_context_carries_notes_and_never_bodies() {
        let mut plan = two_step_plan();
        plan.record(
            1,
            StepOutcome::Done {
                note: "페이지 셋을 찾았다".to_string(),
            },
            "본문은 맥락에 실리지 않는다",
        )
        .unwrap();

        let step = plan.begin_step().expect("둘째 단계");
        assert_eq!(step.number(), 2);
        assert_eq!(step.title(), "읽는다");
        let context = step.context();
        assert_eq!(context, "1. 페이지 셋을 찾았다");
        assert!(!context.contains("본문은"), "{context}");
    }

    #[test]
    fn a_finished_plan_begins_no_step() {
        let mut plan = two_step_plan();
        for number in [1, 2] {
            plan.record(
                number,
                StepOutcome::Done {
                    note: "했다".to_string(),
                },
                "",
            )
            .unwrap();
        }
        assert!(plan.is_complete());
        assert!(plan.begin_step().is_none());
    }

    fn decision_options(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn recommended_policy_picks_and_leaves_a_record_without_stopping() {
        let mut plan = two_step_plan();
        let outcome = plan
            .decide(
                "같은 이름의 페이지가 둘 있습니다. 어느 쪽에 쓸까요?",
                &decision_options(&["회의록 2026-09", "회의록(보관)"]),
                "2",
                AiaDecisionPolicy::Recommended,
            )
            .unwrap();
        assert_eq!(outcome, DecisionOutcome::Chosen("회의록(보관)".to_string()));
        assert!(!plan.is_awaiting_decision());
        assert_eq!(plan.decisions().len(), 1);
        assert_eq!(plan.decisions()[0].by, DecidedBy::Model);
        assert_eq!(plan.decisions()[0].chosen, "회의록(보관)");
        assert_eq!(plan.decisions()[0].step, 1);
    }

    #[test]
    fn ask_policy_stops_until_the_user_answers() {
        let mut plan = two_step_plan();
        let outcome = plan
            .decide(
                "어느 페이지에 쓸까요?",
                &decision_options(&["A", "B", "C"]),
                "A",
                AiaDecisionPolicy::Ask,
            )
            .unwrap();
        assert_eq!(outcome, DecisionOutcome::Awaiting);
        assert!(plan.is_awaiting_decision());
        let pending = plan.pending_decision().expect("기다리는 갈림길");
        assert_eq!(pending.recommended_option(), "A");
        assert_eq!(pending.options.len(), 3);

        // 답을 기다리는 동안 두 번째 갈림길은 열리지 않는다.
        assert!(plan
            .decide(
                "또?",
                &decision_options(&["A", "B"]),
                "A",
                AiaDecisionPolicy::Ask
            )
            .is_err());

        assert_eq!(plan.answer_decision("C").unwrap(), "C");
        assert!(!plan.is_awaiting_decision());
        assert_eq!(plan.decisions()[0].by, DecidedBy::User);
        assert!(plan.answer_decision("C").is_err());
    }

    #[test]
    fn a_waiting_plan_survives_serialization() {
        let mut plan = two_step_plan();
        plan.record(
            1,
            StepOutcome::Done {
                note: "세 건 찾음".to_string(),
            },
            "본문",
        )
        .unwrap();
        plan.decide(
            "어느 것을 열까요?",
            &decision_options(&["첫째", "둘째"]),
            "첫째",
            AiaDecisionPolicy::Ask,
        )
        .unwrap();

        let wire = serde_json::to_string(&plan).unwrap();
        let mut restored: Plan = serde_json::from_str(&wire).unwrap();
        assert!(restored.is_awaiting_decision());
        assert_eq!(
            restored.pending_decision().unwrap().question,
            "어느 것을 열까요?"
        );
        assert_eq!(restored.current().map(|step| step.number), Some(2));
        assert_eq!(restored.records().len(), 1);
        assert_eq!(restored.answer_decision("둘째").unwrap(), "둘째");
    }

    #[test]
    fn an_answer_outside_the_options_keeps_the_fork_open_and_lists_them() {
        let mut plan = two_step_plan();
        plan.decide(
            "어느 쪽?",
            &decision_options(&["왼쪽", "오른쪽"]),
            "왼쪽",
            AiaDecisionPolicy::Ask,
        )
        .unwrap();
        let message = plan.answer_decision("가운데").unwrap_err().to_string();
        assert!(message.contains("가운데"), "{message}");
        assert!(message.contains("왼쪽, 오른쪽"), "{message}");
        assert!(plan.is_awaiting_decision());
    }

    #[test]
    fn one_option_is_not_a_fork_and_caps_are_enforced() {
        let mut plan = two_step_plan();
        assert!(plan
            .decide(
                "?",
                &decision_options(&["하나"]),
                "하나",
                AiaDecisionPolicy::Ask
            )
            .is_err());
        assert!(plan
            .decide(
                "?",
                &decision_options(&["같음", " 같음 "]),
                "같음",
                AiaDecisionPolicy::Ask
            )
            .is_err());
        let many: Vec<String> = (0..MAX_DECISION_OPTIONS + 1)
            .map(|index| format!("후보{index}"))
            .collect();
        assert!(plan
            .decide("?", &many, "후보0", AiaDecisionPolicy::Ask)
            .is_err());
        assert!(plan
            .decide(
                "?",
                &decision_options(&["A", "B"]),
                "없는추천",
                AiaDecisionPolicy::Ask
            )
            .is_err());
        assert!(!plan.is_awaiting_decision());
    }

    #[test]
    fn planning_tool_schemas_stay_flat() {
        let schemas = planning_tool_schemas()
            .into_iter()
            .chain(step_control_tool_schemas());
        for schema in schemas {
            let name = schema["name"].as_str().expect("이름이 있다").to_string();
            let parameters = &schema["parameters"];
            assert_eq!(parameters["type"], "object", "{name}");
            let properties = parameters["properties"]
                .as_object()
                .unwrap_or_else(|| panic!("{name} 의 properties 는 객체다"));
            for (field, spec) in properties {
                match spec["type"].as_str() {
                    Some("string") => {}
                    Some("array") => assert_eq!(
                        spec["items"]["type"], "string",
                        "{name}.{field} 의 배열 원소는 문자열이어야 한다"
                    ),
                    other => panic!("{name}.{field} 의 타입 {other:?} 는 평평하지 않다"),
                }
                assert!(
                    spec.get("properties").is_none(),
                    "{name}.{field} 안에 또 객체를 두지 않는다"
                );
            }
        }
    }

    /// 계획 묶음이 내보내는 도구 다섯.
    ///
    /// 출구가 넷인 것이 먼저다. 셋이던 때 "안녕"이 갈 곳이 없었다 — `finish_plan` 은 단계를
    /// 요구하고 `cannot_do` 는 "못 한다"라서 인사말에는 둘 다 거짓이다.
    ///
    /// `insert_step` 이 함께 있는 것은 MCP 도구 목록이 세션이 열릴 때 한 번 읽히기
    /// 때문이다. 계획을 세우는 동안과 도는 동안 목록을 갈아 끼울 수 없으므로 다 내보내고,
    /// 지금 쓸 수 없는 것은 부를 때 무엇을 대신 쓰라고 답한다. 갈림길(`decide`)은 단계를
    /// 도는 중의 것이라 여기 두지 않는다.
    #[test]
    fn the_plan_group_offers_four_exits_and_the_inserter() {
        let names: Vec<String> = planning_tool_schemas()
            .iter()
            .map(|schema| schema["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            names,
            vec![
                "add_step",
                "finish_plan",
                "answer_now",
                "cannot_do",
                "insert_step"
            ]
        );
        assert!(!names.contains(&"decide".to_owned()));
    }

    /// 지금 쓸 수 없는 도구는 거절하되 무엇을 대신 쓰라고 말해 준다.
    #[test]
    fn inserting_while_still_drafting_points_at_add_step() {
        let mut slot = PlanSlot::Drafting(PlanDraft::new(catalog()));
        let error = slot
            .insert_step(None, "끼운다", &tools(&["bash"]))
            .expect_err("초안 중에는 못 끼운다");
        assert!(error.to_string().contains("add_step"), "{error}");

        slot.drafting()
            .expect("초안")
            .add_step("찾는다", &tools(&["notion_search"]), &[])
            .expect("단계");
        slot.finish().expect("확정");
        assert_eq!(
            slot.insert_step(Some(1), "적는다", &tools(&["write"]))
                .expect("끼우기"),
            2
        );
    }

    /// 사유를 받아 놓고 버리면 받은 이유가 없다. 요약은 "실패했고, 그래서 이렇게 했다"를
    /// 둘 다 말해야 한다 — 실패를 건너뜀으로 고쳐 쓰지 않는 것과 같은 이유다.
    #[test]
    fn why_a_failure_was_skipped_reaches_the_summary() {
        let mut plan = failed_first_step();
        plan.resolve(
            1,
            StepResolution::Skip {
                reason: "그 페이지는 없어도 된다".to_owned(),
            },
        )
        .expect("처리");

        let summary = plan.summary_input();
        // 실패는 실패대로 남고, 그 위에 판단이 붙는다.
        assert!(summary.contains("실패: 검색이 비었다"), "{summary}");
        assert!(
            summary.contains("건너뜀: 그 페이지는 없어도 된다"),
            "{summary}"
        );
    }

    /// 실행 중에 열려 있는 것과 실패 처리 턴에만 열리는 것이 갈린다. 가르는 잣대는
    /// "그 자리에서 부를 수 있는가"다 — 갈림길(`decide`)은 단계가 해낸 자리에서 드러나고,
    /// 실패 처리(`resolve`)는 실패한 뒤에만 부를 수 있다.
    #[test]
    fn decide_runs_with_the_steps_and_resolve_waits_for_a_failure() {
        let standing: Vec<String> = step_control_tool_schemas()
            .iter()
            .map(|schema| schema["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(standing, vec!["insert_step", "decide"]);
        let required = step_control_tool_schemas()[0]["parameters"]["required"].clone();
        assert_eq!(required, json!(["title", "tools"]));
        let required = step_control_tool_schemas()[1]["parameters"]["required"].clone();
        assert_eq!(required, json!(["question", "options", "recommended"]));

        // 실패를 처리하는 턴에서만 열리고, 그때는 이것 하나만 연다.
        let on_failure: Vec<String> = failure_tool_schemas()
            .iter()
            .map(|schema| schema["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(on_failure, vec!["resolve"]);
        // 갈래가 넷이어도 도구는 하나다 — action 인자로 가른다.
        let required = failure_tool_schemas()[0]["parameters"]["required"].clone();
        assert_eq!(required, json!(["action"]));
    }

    #[test]
    fn what_comes_after_is_read_from_the_model_s_word() {
        assert_eq!(parse_insert_after(None).unwrap(), None);
        assert_eq!(parse_insert_after(Some("  ")).unwrap(), None);
        assert_eq!(parse_insert_after(Some("0")).unwrap(), None);
        assert_eq!(parse_insert_after(Some(" 3 ")).unwrap(), Some(3));
        let message = parse_insert_after(Some("검색한다 다음"))
            .unwrap_err()
            .to_string();
        assert!(message.contains("검색한다 다음"), "{message}");
    }

    #[test]
    fn a_body_stays_out_of_the_notes_and_is_clamped() {
        let mut plan = two_step_plan();
        plan.record(
            1,
            StepOutcome::Done {
                note: "페이지 3건".to_string(),
            },
            "제목\n본문 여러 줄",
        )
        .unwrap();
        assert_eq!(plan.notes(), [(1, "페이지 3건")]);
        assert_eq!(plan.records().len(), 1);
        assert_eq!(plan.records()[0].title, "검색한다");
        assert_eq!(plan.records()[0].body, "제목\n본문 여러 줄");

        let mut plan = two_step_plan();
        let long = "가".repeat(MAX_STEP_BODY_CHARS + 500);
        plan.record(1, StepOutcome::Done { note: "ok".into() }, &long)
            .unwrap();
        assert_eq!(plan.records()[0].body.chars().count(), MAX_STEP_BODY_CHARS);
    }

    #[test]
    fn the_summary_pulls_the_bodies_in_the_order_they_ran() {
        let mut plan = two_step_plan();
        assert_eq!(plan.summary_input(), "");
        plan.record(
            1,
            StepOutcome::Done {
                note: "3건".into()
            },
            "검색 결과 본문",
        )
        .unwrap();
        plan.record(
            2,
            StepOutcome::Failed {
                reason: "404".into(),
            },
            "응답 본문",
        )
        .unwrap();
        let summary = plan.summary_input();
        assert_eq!(
            summary,
            "1. 검색한다 — 완료: 3건\n검색 결과 본문\n\n2. 읽는다 — 실패: 404\n응답 본문"
        );
    }

    /// 2026-09-27 ses_f1dd9ce45. 메모가 본문의 앞 200자면 머리줄은 결말 종류만 적는다 —
    /// 그러지 않으면 요약이 같은 글을 "잘린 것 + 전문"으로 두 번 읽는다.
    #[test]
    fn a_note_cut_from_the_body_is_not_repeated_above_it() {
        let mut plan = two_step_plan();
        let body = "(도구 호출 1회: 성공 1회, 실패 0회) ".to_owned() + &"가".repeat(400);
        let note: String = body.chars().take(MAX_STEP_NOTE_CHARS).collect();
        plan.record(1, StepOutcome::Done { note }, &body).unwrap();
        plan.record(
            2,
            StepOutcome::Failed {
                reason: "404".into(),
            },
            "응답 본문",
        )
        .unwrap();
        let summary = plan.summary_input();
        assert!(
            summary.starts_with("1. 검색한다 — 완료\n(도구 호출 1회"),
            "{summary}"
        );
        assert_eq!(summary.matches("(도구 호출 1회").count(), 1);
        // 메모가 본문과 다른 단계는 그대로 둘 다 싣는다.
        assert!(summary.ends_with("2. 읽는다 — 실패: 404\n응답 본문"));
    }

    /// 끼우기는 살아 있는 단계의 번호만 다시 매긴다. 이미 돌아간 일까지 따라 움직이면
    /// 요약이 "2단계에서 실패"라고 적어 놓고 그 자리에 다른 단계가 서 있게 된다.
    #[test]
    fn an_insertion_does_not_move_what_already_ran() {
        let mut plan = two_step_plan();
        plan.record(
            1,
            StepOutcome::Done {
                note: "3건".into()
            },
            "본문",
        )
        .unwrap();
        plan.insert_after(None, "먼저 한다", &tools(&["bash"]))
            .unwrap();
        assert_eq!(plan.current().unwrap().title, "먼저 한다");
        assert_eq!(plan.steps()[1].title, "검색한다");
        assert_eq!(plan.records().len(), 1);
        assert!(plan.summary_input().starts_with("1. 검색한다 — 완료: 3건"));
    }

    #[test]
    fn a_long_summary_shares_its_budget_and_says_what_it_cut() {
        let mut draft = PlanDraft::new(catalog());
        for index in 0..4 {
            draft
                .add_step(&format!("{index}단계"), &tools(&["bash"]), &[])
                .unwrap();
        }
        let mut plan = draft.finish().unwrap();
        for number in 1..=4 {
            plan.record(
                number,
                StepOutcome::Done { note: "ok".into() },
                &"가".repeat(MAX_STEP_BODY_CHARS),
            )
            .unwrap();
        }
        let summary = plan.summary_input();
        let budget = MAX_SUMMARY_CHARS / 4;
        assert!(budget < MAX_STEP_BODY_CHARS, "이 시험은 잘리는 경우를 본다");
        assert_eq!(summary.matches("자 줄임").count(), 4);
        assert!(
            summary
                .matches(&format!("({}자 줄임)", MAX_STEP_BODY_CHARS - budget))
                .count()
                == 4,
            "줄인 글자 수를 그대로 적는다"
        );
        // 머리줄과 "줄임" 안내를 뺀 본문 총량이 상한 안이다.
        assert!(
            summary.chars().count() < MAX_SUMMARY_CHARS + 400,
            "{}",
            summary.chars().count()
        );
    }

    /// 2026-09-26 ses_f23842cd6 / ses_f23700d3f / ses_f236b4a12.
    /// 탐침에 edit·insert_step·되묻기가 빠지고 상한·도구 응답까지 달랐다.
    /// 제품의 실제 스키마·색인·응답을 내보내고, 사본이 바뀌면 시험이 실패한다.
    #[test]
    fn planning_probe_contract_matches_product() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../local-llm-dev/plan-eval/fixtures/plugin-catalogs.json"
        ))
        .unwrap();
        // 읽기 전용(plan 모드) 색인도 같이 낸다 — 작업 공간은 쓰기 도구를 빼고, 플러그인은
        // 상류 readOnly 주석이 있는 도구만(9.14). 탐침은 READ_ONLY=1 로 이쪽을 읽는다.
        let build = |read_only: bool| {
            let workspace: Vec<(String, String)> =
                crate::opencode_config::workspace_tool_descriptions(read_only)
                    .into_iter()
                    .map(|(n, d)| (n.to_string(), d.to_string()))
                    .collect();
            let mut catalogs = vec![(String::new(), workspace)];
            for plugin in fixture.as_array().unwrap() {
                let id = plugin["plugin"].as_str().unwrap();
                let names: Vec<String> = plugin["names"]
                    .as_array()
                    .map(|names| {
                        names
                            .iter()
                            .filter_map(|n| n.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default();
                let label = crate::opencode_config::plugin_label(id, &names);
                let tools = crate::opencode_config::plugin_tools_from_catalog(plugin, read_only);
                if !tools.is_empty() {
                    catalogs.push((label, tools));
                }
            }
            catalogs
        };
        let catalogs = build(false);
        let index_read_only = tool_index(&build(true));
        let names = ToolCatalog::from_catalogs(&catalogs);
        let mut draft = PlanDraft::new(names.clone());
        let mut continuations = vec![json!({"receipt":draft.receipt(),"nudge":draft.nudge_text()})];
        for _ in 0..MAX_PLAN_STEPS {
            draft.add_step("조회", &["read".into()], &[]).unwrap();
            continuations.push(json!({"receipt":draft.receipt(),"nudge":draft.nudge_text()}));
        }
        let errors: Vec<Value> = [Vec::<String>::new(), vec!["notion-create-page".into()], vec!["read".into(),"write".into(),"edit".into(),"webfetch".into(),"bash".into()]].into_iter()
            .map(|tools| json!({"tools":tools,"error":normalize_tools(&names,&tools).unwrap_err().to_string()})).collect();
        let mut answer_slot = PlanSlot::Drafting(PlanDraft::new(names.clone()));
        answer_slot
            .drafting()
            .unwrap()
            .add_step("조회", &["read".into()], &[])
            .unwrap();
        let answer_error = answer_slot
            .answer("정보 수집 중입니다")
            .unwrap_err()
            .to_string();
        // 2026-09-26 e6afe8bb / ses_f2251f5ec: 병행 반영된 거절 보호도 탐침과 맞춘다.
        let mut direct_slot = PlanSlot::Drafting(PlanDraft::new(names.clone()));
        direct_slot.note_direct_index_call("webfetch");
        let direct_error = direct_slot
            .refuse("도구가 없습니다")
            .unwrap_err()
            .to_string()
            .replace("webfetch", "<TOOL>");
        // 적어 둔 단계를 쥐고 거절하는 길도 막혀 있다. 탐침이 이 보호를 모르면 제품이
        // 되돌려 주는 자리를 실패로 세게 된다.
        let mut refusal_slot = PlanSlot::Drafting(PlanDraft::new(names.clone()));
        refusal_slot
            .drafting()
            .unwrap()
            .add_step("조회", &["read".into()], &[])
            .unwrap();
        let refusal_error = refusal_slot
            .refuse("이 도구로는 못 합니다")
            .unwrap_err()
            .to_string()
            .replace("1단계", "<STEPS>단계");
        let contract = json!({
            "schemas": planning_tool_schemas(), "draftSchemas": draft_planning_tool_schemas(), "index": tool_index(&catalogs),
            "indexReadOnly": index_read_only,
            // 계약도 제품과 같은 자리를 쓴다. 색인은 시스템 글, 사용자 턴은 요청뿐이다 —
            // 탐침이 옛 모양으로 재면 제품이 아닌 것을 재게 된다.
            "systemPrompt": plan_system_prompt("<INDEX>"), "systemPromptReadOnly": plan_system_prompt_for("<INDEX>", true), "prompt": "<REQUEST>",
            "maxSteps": MAX_PLAN_STEPS, "maxTools": MAX_TOOLS_PER_STEP,
            "maxUses": MAX_USES_PER_STEP, "maxTitle": MAX_STEP_TITLE_CHARS,
            "maxRefusal": MAX_REFUSAL_REASON_CHARS, "maxNudges": crate::chat::MAX_PLAN_NUDGES,
            "continuations": continuations, "toolErrors": errors, "answerDraftError": answer_error,
            "directIndexCallError": direct_error, "refusalDraftError": refusal_error,
            // 제목이 플러그인을 말하는데 도구가 아닌 단계를 되돌리는 가드(2026-09-27).
            "pluginGroups": names.groups(), "pluginMismatchError": plugin_mismatch_message("<ALIAS>", "<TOOLS>"),
            // 제목은 고친다는데 도구는 읽기만 하는 단계를 되돌리는 가드(2026-10-02, 11회차).
            "writeIntentWords": WRITE_INTENT_WORDS,
            "readingTools": crate::opencode_config::reading_workspace_tools(),
            "writingTools": crate::opencode_config::writing_workspace_tools(),
            "writingIntentError": writing_intent_message("<TOOLS>", "<WRITERS>"),
            // 요청은 고치라는데 모든 단계가 읽기 전용인 계획을 되돌리는 가드(2026-10-03, 12회차).
            "readOnlyPlanError": read_only_plan_message("<WRITERS>"),
        });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../local-llm-dev/plan-eval/fixtures/planning-contract.json");
        if std::env::var_os("UPDATE_PLAN_CONTRACT").is_some() {
            std::fs::write(
                &path,
                serde_json::to_string_pretty(&contract).unwrap() + "\n",
            )
            .unwrap();
        }
        let recorded: Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            contract, recorded,
            "제품 계획 표면이 바뀌면 UPDATE_PLAN_CONTRACT=1 로 탐침 계약도 갱신한다"
        );
    }

    /// 2026-09-26 ses_f23295181ffe7RCLdD2uLHxCIF. add_step 다음의 answer_now가
    /// 초안을 버리고 "정보 수집 중"이라는 약속만으로 채팅을 완료 처리했다.
    #[test]
    fn answer_now_cannot_discard_recorded_tool_steps() {
        let mut slot = PlanSlot::Drafting(PlanDraft::new(ToolCatalog::new([
            "webfetch",
            "notion-create-pages",
        ])));
        slot.drafting()
            .unwrap()
            .add_step(
                "React 공식 웹사이트로부터 최신 버전 정보 검색",
                &["webfetch".into()],
                &[],
            )
            .unwrap();
        assert!(slot
            .answer("현재 단계: React 공식 웹사이트에서 최신 안정 버전 정보 수집 중입니다.")
            .is_err());
        assert!(matches!(slot, PlanSlot::Drafting(_)));
        assert_eq!(slot.drafting().unwrap().len(), 1);
        slot.drafting()
            .unwrap()
            .add_step("노션에 정리", &["notion-create-pages".into()], &[1])
            .unwrap();
        assert_eq!(slot.finish().unwrap(), 2);
        let PlanSlot::Running(plan) = slot else {
            panic!("계획이 유지되어야 한다")
        };
        assert_eq!(plan.steps()[0].tools, vec!["webfetch"]);
        assert_eq!(plan.steps()[1].uses, vec![1]);
    }
    /// 2026-09-26 ses_f23842cd6와 같은 요청의 round2 GPU guard 7회차 실제 인자.
    /// write agent만 열리는데 노션 도구까지 수락하면 계획에만 존재하는 작업이 된다.
    #[test]
    fn a_mixed_workspace_and_plugin_step_is_rejected_without_losing_the_draft() {
        let mut draft = PlanDraft::new(ToolCatalog::new([
            "webfetch",
            "write",
            "notion-create-pages",
        ]));
        draft
            .add_step(
                "React 공식 문서를 참고하여 최신 안정 버전을 확인한다",
                &tools(&["webfetch"]),
                &[],
            )
            .unwrap();
        let title = "확인한 React 최신 버전 정보를 노션 페이지에 정리한다";
        let error = draft
            .add_step(title, &tools(&["write", "notion-create-pages"]), &[])
            .unwrap_err();
        assert!(error.to_string().contains("Split the step"));
        assert_eq!(draft.len(), 1);
        draft
            .add_step(title, &tools(&["notion-create-pages"]), &[1])
            .unwrap();
        let mut plan = draft.finish().unwrap();
        assert_eq!(plan.steps()[1].tools, ["notion-create-pages"]);
        assert_eq!(plan.steps()[1].uses, [1]);
        // 실행 중 보완하는 계획도 같은 한 도구 계약이며, 실패하면 순서와 참조가 남는다.
        assert!(plan
            .insert_after(Some(1), title, &tools(&["write", "notion-create-pages"]))
            .is_err());
        assert_eq!(plan.steps().len(), 2);
        assert_eq!(plan.steps()[1].number, 2);
        assert_eq!(plan.steps()[1].uses, [1]);
        for name in ["add_step", "insert_step"] {
            let schema = planning_tool_schemas()
                .into_iter()
                .find(|schema| schema["name"] == name)
                .unwrap();
            assert_eq!(schema["parameters"]["properties"]["tools"]["maxItems"], 1);
        }
    }
}
