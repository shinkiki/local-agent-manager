//! 채팅 실행설정 스키마와 공급자 선택지 카탈로그.
//!
//! 모델·추론 수준·실행설정 항목을 어디서 얻고 어떤 순서로 덧입힐지만 다룬다. 내장 목록,
//! CLI 도움말 조사 결과, AIA가 제안한 카탈로그 세 갈래를 합쳐 프론트에 내려줄 형태로
//! 만들고, 저장본(`chat-settings-schema-v1.json`)의 읽기·검증·쓰기를 이 모듈 안에 가둔다.
//!
//! 채팅 실행(`chat.rs`)은 합쳐진 결과와 두 개의 저장 진입점만 본다. 저장 구조체와 검증
//! 규칙은 밖으로 나가지 않는다.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::chat::{
    configure_headless_command, effort_name_is_valid, normalize_model, read_rpc_result,
    resolve_executable, write_json_line, ChatModelOption, ChatProviderOptions, ChatReasoningOption,
    ChatSettingField, ChatSettingFieldKind, ChatSettingOption, ReasoningEffort,
    ANTIGRAVITY_MODELS_TIMEOUT,
};
use crate::cli_interface::{probe_cli_interface, CliInterface};
use crate::clock::now_ms;
use crate::domain::ProviderId;
use crate::CoreError;

/// 모델·추론 선택지와 실행설정 항목을 합쳐 프론트로 내려줄 형태로 만든다.
///
/// 우선순위는 세 단계다. CLI가 모델 목록을 직접 내보내면 그것이 최우선이고(조사 실패나
/// 환각이 실제 목록을 덮으면 안 된다), 목록을 못 얻었을 때만 AIA가 조사해 제안한
/// 카탈로그로 채운다. 추론 수준은 내장 목록 → 도움말 조사 → AIA 제안 순으로 덧입힌다.
pub fn load_chat_provider_options(
    source: ProviderId,
    app_data_dir: Option<&std::path::Path>,
) -> ChatProviderOptions {
    let overrides = app_data_dir.map(load_schema_overrides).unwrap_or_default();
    // 파일이 외부에서 바뀔 수 있으므로 저장 시점 검증과 별개로 읽을 때 다시 검증한다.
    let proposed = overrides
        .catalogs
        .get(source.as_str())
        .filter(|catalog| validate_provider_catalog(source, catalog).is_ok());
    let settings = merged_setting_fields(source, app_data_dir);
    let settings_updated_at = schema_overrides_updated_at(source, app_data_dir);
    let supported_reasoning_efforts = merged_reasoning_options(source, &overrides);
    // CLI가 모델 목록을 내보내는 공급자만 실제 카탈로그를 읽는다.
    let cli_models = match source {
        ProviderId::Codex => Some(
            resolve_executable(source)
                .and_then(|executable| load_codex_model_catalog(&executable))
                .map(|mut models| {
                    models.sort_by(|left, right| {
                        right
                            .is_default
                            .cmp(&left.is_default)
                            .then_with(|| left.display_name.cmp(&right.display_name))
                    });
                    models
                }),
        ),
        // `agy models`는 이미 모델 패밀리 순으로 내보내므로 CLI 순서를 그대로 쓴다.
        ProviderId::Antigravity => Some(
            resolve_executable(source)
                .and_then(|executable| load_antigravity_model_catalog(&executable)),
        ),
        ProviderId::Claude => None,
    };
    let (mut models, catalog_error) = match cli_models {
        Some(Ok(models)) => (models, None),
        Some(Err(error)) => (Vec::new(), Some(error.to_string())),
        None => (Vec::new(), None),
    };
    if models.is_empty() {
        if let Some(catalog) = proposed {
            models = catalog.models.clone();
        }
    }
    let default_reasoning_effort = models
        .iter()
        .find(|model| model.is_default)
        .and_then(|model| model.default_reasoning_effort.clone());
    ChatProviderOptions {
        source,
        models,
        supported_reasoning_efforts,
        default_reasoning_effort,
        catalog_error,
        settings,
        settings_updated_at,
        catalog_updated_at: proposed.map(|catalog| catalog.updated_at),
        cli_version: overrides
            .discovered
            .get(source.as_str())
            .and_then(|record| record.cli_version.clone()),
        catalog_stale: provider_catalog_is_stale(source, &overrides),
    }
}

/// 추론 수준 목록: 내장 → 도움말 조사 → AIA 제안 순으로 뒤에 오는 것이 이긴다.
/// 어느 단계든 비어 있으면 그 단계는 판단을 보류한 것으로 보고 앞 단계를 유지한다.
fn merged_reasoning_options(
    source: ProviderId,
    overrides: &ChatSettingsSchemaOverrides,
) -> Vec<ChatReasoningOption> {
    let mut options = provider_reasoning_options(source);
    if let Some(discovered) = overrides
        .discovered
        .get(source.as_str())
        .map(|record| &record.reasoning_efforts)
        .filter(|efforts| !efforts.is_empty())
    {
        options = discovered.clone();
    }
    if let Some(proposed) = overrides
        .catalogs
        .get(source.as_str())
        .filter(|catalog| validate_provider_catalog(source, catalog).is_ok())
        .map(|catalog| &catalog.reasoning_efforts)
        .filter(|efforts| !efforts.is_empty())
    {
        options = proposed.clone();
    }
    options
}

/// AIA가 모델·추론 카탈로그를 다시 조사해야 하는 상태인지.
///
/// CLI가 모델 목록을 직접 내보내는 공급자는 제안이 필요 없으므로 항상 false다. 그 외
/// 공급자는 제안이 아예 없거나, 제안을 남긴 시점의 CLI 버전이 지금 조사된 버전과 다르면
/// true가 된다. 오래된 제안을 지우지는 않는다 — 선택지가 갑자기 사라지면 안 된다.
fn provider_catalog_is_stale(source: ProviderId, overrides: &ChatSettingsSchemaOverrides) -> bool {
    if provider_publishes_model_catalog(source) {
        return false;
    }
    let installed = overrides
        .discovered
        .get(source.as_str())
        .and_then(|record| record.cli_version.clone());
    match overrides.catalogs.get(source.as_str()) {
        Some(catalog) => catalog.cli_version != installed,
        None => true,
    }
}

/// CLI가 모델 목록을 스스로 내보내는 공급자인지. 이 목록은 조사·제안보다 우선한다.
fn provider_publishes_model_catalog(source: ProviderId) -> bool {
    matches!(source, ProviderId::Codex | ProviderId::Antigravity)
}

fn provider_reasoning_options(source: ProviderId) -> Vec<ChatReasoningOption> {
    let efforts: &[ReasoningEffort] = match source {
        ProviderId::Codex => &[
            ReasoningEffort::None,
            ReasoningEffort::Minimal,
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
        ],
        ProviderId::Claude => &[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
            ReasoningEffort::Xhigh,
            ReasoningEffort::Max,
        ],
        ProviderId::Antigravity => &[
            ReasoningEffort::Low,
            ReasoningEffort::Medium,
            ReasoningEffort::High,
        ],
    };
    efforts
        .iter()
        .map(|effort| ChatReasoningOption {
            description: effort_description(effort).to_owned(),
            effort: effort.clone(),
        })
        .collect()
}

/// 내장 이름의 설명 문구. 조사·제안으로 들어온 새 이름은 설명을 알 수 없으므로 비우고,
/// 표시 문구는 AIA 제안 카탈로그가 채운다.
fn effort_description(effort: &ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::None => "추론 비활성화",
        ReasoningEffort::Minimal => "가장 빠른 단순 작업",
        ReasoningEffort::Low => "빠른 수정과 간단한 질의",
        ReasoningEffort::Medium => "속도와 정확도의 균형",
        ReasoningEffort::High => "복잡한 구현과 분석",
        ReasoningEffort::Xhigh => "더 깊은 검토가 필요한 작업",
        ReasoningEffort::Max => "최대 수준의 심층 추론",
        ReasoningEffort::Ultra => "장시간 자율 작업과 다중 에이전트",
        ReasoningEffort::Other(_) => "",
    }
}

fn setting_option(value: &str, label: &str, detail: &str, disabled: bool) -> ChatSettingOption {
    ChatSettingOption {
        value: value.to_owned(),
        label: label.to_owned(),
        detail: Some(detail.to_owned()),
        disabled,
    }
}

/// 동적 실행설정 값의 허용 규칙. 값은 이 규칙을 통과해야만 CLI 인자로 변환된다.
enum DynamicValueRule {
    /// 모델·에이전트 식별자 문자 집합(normalize_model과 동일)
    Identifier,
    /// 고정 선택지 중 하나
    #[allow(dead_code)]
    OneOf(&'static [&'static str]),
}

impl DynamicValueRule {
    /// 값 하나가 이 규칙을 통과하는지. 시작 요청 검증·저장본 정리·스키마 항목 검증이
    /// 각자 같은 `match`를 펼쳐 두고 있어 규칙 자신에게 물어보는 한 자리로 모았다.
    fn accepts(&self, value: &str) -> bool {
        match self {
            DynamicValueRule::Identifier => identifier_value_is_valid(value),
            DynamicValueRule::OneOf(allowed) => allowed.contains(&value),
        }
    }
}

struct DynamicSettingSpec {
    key: &'static str,
    flag: &'static str,
    rule: DynamicValueRule,
}

/// 공급자 화이트리스트에서 키 하나에 해당하는 항목을 찾는다. 네 곳이 각자
/// `specs.iter().find(...)`를 적고 있어 한 벌로 모았다.
fn dynamic_setting_spec(source: ProviderId, key: &str) -> Option<&'static DynamicSettingSpec> {
    provider_dynamic_setting_specs(source)
        .iter()
        .find(|spec| spec.key == key)
}

/// provider별로 CLI 전달이 허용된 동적 설정 목록. 이 화이트리스트에 없는 항목은
/// 스키마(디스커버리)가 무엇을 제안하든 절대 CLI 인자가 되지 않는다.
fn provider_dynamic_setting_specs(source: ProviderId) -> &'static [DynamicSettingSpec] {
    match source {
        ProviderId::Claude => &[DynamicSettingSpec {
            key: "fallbackModel",
            flag: "--fallback-model",
            rule: DynamicValueRule::Identifier,
        }],
        ProviderId::Codex | ProviderId::Antigravity => &[],
    }
}

pub(crate) fn identifier_value_is_valid(value: &str) -> bool {
    model_identifier_is_valid(value)
}

/// 모델 식별자의 기본 문자 집합에 Claude의 검증된 컨텍스트 변형 접미사 `[1m]`만
/// 추가로 허용한다. 대괄호 일반 허용은 CLI argv 신뢰 경계를 불필요하게 넓히므로
/// 접미사 위치와 내용을 고정한다.
pub(crate) fn model_identifier_is_valid(value: &str) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let base = value.strip_suffix("[1m]").unwrap_or(value);
    !base.is_empty()
        && base.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
}

/// 시작 요청의 동적 설정을 화이트리스트로 검증한다. 모르는 키나 규칙에 어긋난 값은
/// 조용히 버리지 않고 오류로 돌려보내 UI/AIA 쪽 스키마 불일치를 즉시 드러낸다.
pub(crate) fn validate_dynamic_settings(
    source: ProviderId,
    settings: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, CoreError> {
    let mut validated = BTreeMap::new();
    for (key, value) in settings {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let Some(spec) = dynamic_setting_spec(source, key) else {
            return Err(CoreError::InvalidInput(format!(
                "지원하지 않는 실행설정 항목입니다: {key}"
            )));
        };
        if !spec.rule.accepts(value) {
            return Err(CoreError::InvalidInput(format!(
                "실행설정 값이 올바르지 않습니다: {key}"
            )));
        }
        validated.insert(key.clone(), value.to_owned());
    }
    Ok(validated)
}

/// 이미 저장돼 있는 실행설정에서 지금 화이트리스트를 통과하는 항목만 남긴다. 시작 요청과
/// 달리 저장본은 CLI가 바뀌면 예전 항목이 남을 수 있어, 오류로 막지 않고 조용히 버린다.
pub(crate) fn retained_dynamic_settings(
    source: ProviderId,
    settings: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    settings
        .iter()
        .filter_map(|(key, value)| {
            let value = value.trim();
            let spec = dynamic_setting_spec(source, key)?;
            let valid = !value.is_empty() && spec.rule.accepts(value);
            valid.then(|| (key.clone(), value.to_owned()))
        })
        .collect()
}

pub(crate) fn dynamic_setting_args(
    source: ProviderId,
    settings: &BTreeMap<String, String>,
) -> Vec<String> {
    let mut args = Vec::new();
    for (key, value) in settings {
        if let Some(spec) = dynamic_setting_spec(source, key) {
            args.push(spec.flag.to_owned());
            args.push(value.clone());
        }
    }
    args
}

/// 실행설정 스키마 갱신 기록의 저장 파일. 내장 스키마 위에 덧입힌다.
const CHAT_SETTINGS_SCHEMA_FILE: &str = "chat-settings-schema-v1.json";
/// 조사 항목이 늘어난 앱 버전에서 기존 기록을 한 번 다시 조사하게 하는 표식.
/// 같은 CLI 버전이라도 이 값이 다르면 재조사한다. 조사 대상을 늘릴 때 올린다.
/// 1: `--help`의 `--effort` 허용값으로 추론 수준 목록을 함께 기록.
/// 2: Claude permission mode 내장 선택지 확장 결과를 다시 조사.
const CURRENT_PROBE_REVISION: u32 = 2;
/// 제안 카탈로그 상한. 선택 박스에서 고를 수 있는 현실적인 크기로 묶는다.
const MAX_PROPOSED_MODELS: usize = 24;
const MAX_PROPOSED_REASONING_OPTIONS: usize = 12;
/// 표시 문자열 상한. 라벨은 선택 박스 한 줄에, 설명은 그 아래 보조 문구에 들어간다.
const MAX_LABEL_CHARS: usize = 40;
const MAX_DETAIL_CHARS: usize = 120;
/// 스키마 항목 수 상한. 한 공급자의 실행설정 화면이 담을 수 있는 크기다.
const MAX_SCHEMA_FIELDS: usize = 24;
/// 한 항목이 가질 수 있는 선택지 수 상한.
const MAX_FIELD_OPTIONS: usize = 12;
/// 선택지 값(식별자·플래그 문자열) 길이 상한.
const MAX_OPTION_VALUE_LEN: usize = 128;
/// 항목 키 길이 상한.
const MAX_FIELD_KEY_LEN: usize = 40;

/// 검증 실패 메시지를 한 형식으로 만든다. `<대상> 검증 실패: <사유>` 꼴을 세 곳에서
/// 각자의 클로저로 조립하고 있어 한 곳으로 모았다.
fn validation_error(subject: &str, reason: &str) -> CoreError {
    CoreError::InvalidInput(format!("{subject} 검증 실패: {reason}"))
}

const CATALOG_SUBJECT: &str = "모델·추론 카탈로그";
const SCHEMA_SUBJECT: &str = "실행설정 스키마";

/// 화면에 그대로 찍히는 라벨·표시명 규칙. 비어 있으면 고를 수 없는 항목이 되고,
/// 너무 길면 선택 박스를 밀어낸다.
fn label_is_valid(value: &str) -> bool {
    !value.is_empty() && value.chars().count() <= MAX_LABEL_CHARS
}

/// 보조 설명 규칙. 없는 것은 정상이고, 길이만 본다.
fn detail_is_valid(detail: Option<&str>) -> bool {
    detail.is_none_or(|detail| detail.chars().count() <= MAX_DETAIL_CHARS)
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatSettingsSchemaOverrides {
    /// AIA가 `propose_chat_settings_schema`로 제안한 오버라이드. 명시적 제안이므로
    /// 자동 조사 결과보다 뒤에 적용해 우선한다.
    #[serde(default)]
    providers: BTreeMap<String, Vec<ChatSettingField>>,
    #[serde(default)]
    updated_at: i64,
    /// 설치된 CLI의 `--help`를 직접 읽어 만든 조사 결과. AIA 제안과 서로 덮어쓰지
    /// 않도록 분리해 보관한다. 기존 파일에는 이 항목이 없으므로 기본값으로 읽는다.
    #[serde(default)]
    discovered: BTreeMap<String, DiscoveredSettingsSchema>,
    /// AIA가 조사해 제안한 공급자별 모델·추론 카탈로그. CLI가 모델 목록을 내보내지
    /// 않는 공급자(Claude)에서 앱 배포 없이 최신 모델을 고를 수 있게 하는 슬롯이다.
    #[serde(default)]
    catalogs: BTreeMap<String, ProposedProviderCatalog>,
}

/// AIA가 제안한 한 공급자의 모델·추론 카탈로그.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProposedProviderCatalog {
    #[serde(default)]
    models: Vec<ChatModelOption>,
    #[serde(default)]
    reasoning_efforts: Vec<ChatReasoningOption>,
    /// 제안을 만들 때 조사한 CLI 버전. 지금 설치된 버전과 다르면 재조사 대상이 된다.
    #[serde(default)]
    cli_version: Option<String>,
    #[serde(default)]
    updated_at: i64,
}

/// 제안 카탈로그의 신뢰 경계. 모델 식별자와 추론 이름은 CLI로 그대로 전달되므로
/// 값 문법을 실행 경로와 같은 규칙으로 좁히고, 표시 문구 길이와 개수도 제한한다.
/// 하나라도 규칙을 어기면 카탈로그 전체를 버린다 — 일부만 살리면 어떤 목록이
/// 화면에 있는지 예측할 수 없다.
fn validate_provider_catalog(
    source: ProviderId,
    catalog: &ProposedProviderCatalog,
) -> Result<(), CoreError> {
    let invalid = |reason: &str| Err(validation_error(CATALOG_SUBJECT, reason));
    if provider_publishes_model_catalog(source) && !catalog.models.is_empty() {
        return invalid("CLI가 모델 목록을 직접 내보내는 공급자입니다");
    }
    if catalog.models.len() > MAX_PROPOSED_MODELS {
        return invalid("모델이 24개를 넘습니다");
    }
    let mut seen = HashSet::new();
    for model in &catalog.models {
        if normalize_model(Some(model.model.clone())).ok().flatten() != Some(model.model.clone()) {
            return invalid("모델 식별자가 규칙에 어긋납니다");
        }
        if !seen.insert(model.model.clone()) {
            return invalid("모델 식별자가 중복됩니다");
        }
        if !label_is_valid(&model.display_name) {
            return invalid("모델 표시명 길이가 잘못됐습니다");
        }
        if !detail_is_valid(Some(&model.description)) {
            return invalid("모델 설명이 너무 깁니다");
        }
        validate_reasoning_options(&model.supported_reasoning_efforts)
            .map_err(|_| validation_error(CATALOG_SUBJECT, "모델별 추론 목록이 잘못됐습니다"))?;
    }
    if catalog
        .models
        .iter()
        .filter(|model| model.is_default)
        .count()
        > 1
    {
        return invalid("기본 모델이 둘 이상입니다");
    }
    validate_reasoning_options(&catalog.reasoning_efforts)?;
    Ok(())
}

/// 카탈로그 제안 단계의 결과. 호출자가 '확인함'과 '조사되지 않음'을 구분하는 데 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CatalogProposalOutcome {
    /// 제안이 저장됐다. 지금 조사된 CLI 버전을 확인한 것으로 함께 기록했다.
    Recorded,
    /// 빈 목록으로 제안을 지웠거나, 애초에 제안이 필요 없는 공급자다.
    Cleared,
    /// 유지할 제안도 새 제안도 없었다. 확인으로 볼 수 없는 상태.
    Missing,
}

/// 제안된 모델·추론 카탈로그를 오버라이드에 반영한다. 넘기지 않은 목록은 기존 값을
/// 유지하고, 빈 목록으로 넘기면 그 목록만 지운다. 둘 다 비게 되면 제안 자체를 지워
/// CLI 조사 결과와 내장 목록으로 돌아간다.
///
/// 제안에는 지금 조사된 CLI 버전을 함께 기록한다. 목록을 하나도 넘기지 않은 '차이 없음'
/// 호출도 기존 제안을 그대로 둔 채 이 버전만 다시 새겨, 같은 CLI를 확인했다는 사실이
/// 남는다. CLI가 업데이트되면 이 값이 어긋나 `catalog_stale`이 서고, 화면이 재조사를
/// 요청할 수 있다.
fn apply_catalog_proposal(
    source: ProviderId,
    overrides: &mut ChatSettingsSchemaOverrides,
    models: Option<Vec<ChatModelOption>>,
    reasoning_efforts: Option<Vec<ChatReasoningOption>>,
) -> Result<CatalogProposalOutcome, CoreError> {
    let key = source.as_str().to_owned();
    // 빈 목록은 '지워 달라'는 명시적 요청이다. 아무것도 넘기지 않아 비어 있는 것과 달리
    // 제안 없는 상태가 의도된 결과이므로, 재조사가 안 끝난 것으로 보고하지 않는다.
    let cleared = models.as_ref().is_some_and(|models| models.is_empty())
        || reasoning_efforts
            .as_ref()
            .is_some_and(|efforts| efforts.is_empty());
    let existing = overrides.catalogs.get(&key);
    let catalog = ProposedProviderCatalog {
        models: models
            .or_else(|| existing.map(|catalog| catalog.models.clone()))
            .unwrap_or_default(),
        reasoning_efforts: reasoning_efforts
            .or_else(|| existing.map(|catalog| catalog.reasoning_efforts.clone()))
            .unwrap_or_default(),
        cli_version: overrides
            .discovered
            .get(&key)
            .and_then(|record| record.cli_version.clone()),
        updated_at: now_ms(),
    };
    if catalog.models.is_empty() && catalog.reasoning_efforts.is_empty() {
        let removed = overrides.catalogs.remove(&key).is_some();
        // CLI가 목록을 직접 내보내는 공급자는 제안 자체가 필요 없으므로 빈 상태가 정상이다.
        let needs_catalog = !provider_publishes_model_catalog(source);
        return Ok(if cleared || removed || !needs_catalog {
            CatalogProposalOutcome::Cleared
        } else {
            CatalogProposalOutcome::Missing
        });
    }
    validate_provider_catalog(source, &catalog)?;
    overrides.catalogs.insert(key, catalog);
    Ok(CatalogProposalOutcome::Recorded)
}

fn validate_reasoning_options(options: &[ChatReasoningOption]) -> Result<(), CoreError> {
    let invalid = |reason: &str| Err(validation_error(CATALOG_SUBJECT, reason));
    if options.len() > MAX_PROPOSED_REASONING_OPTIONS {
        return invalid("추론 수준이 12개를 넘습니다");
    }
    let mut seen = HashSet::new();
    for option in options {
        // 역직렬화가 이미 문법을 걸렀지만, 코드에서 만든 값도 같은 규칙을 지나게 한다.
        if !effort_name_is_valid(option.effort.as_str()) {
            return invalid("추론 수준 이름이 규칙에 어긋납니다");
        }
        if !seen.insert(option.effort.as_str().to_owned()) {
            return invalid("추론 수준이 중복됩니다");
        }
        if !detail_is_valid(Some(&option.description)) {
            return invalid("추론 수준 설명이 너무 깁니다");
        }
    }
    Ok(())
}

/// 한 공급자의 CLI 인터페이스 조사 결과. 같은 실행 파일·같은 버전이면 재조사하지 않는다.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DiscoveredSettingsSchema {
    /// 조사로 확정된 해당 공급자의 전체 항목 목록. 내장 스키마를 대체한다.
    fields: Vec<ChatSettingField>,
    /// 도움말에서 읽은 추론 수준 목록. 값 목록을 못 읽었으면 비어 있고, 그때는
    /// 내장 목록을 쓴다. 이전 버전 파일에는 없으므로 기본값으로 읽는다.
    #[serde(default)]
    reasoning_efforts: Vec<ChatReasoningOption>,
    #[serde(default)]
    cli_version: Option<String>,
    #[serde(default)]
    executable_path: Option<String>,
    /// 이 기록을 만든 조사 로직의 표식. 이전 버전 파일에는 없으므로 0으로 읽히고,
    /// 그러면 CLI가 그대로여도 한 번 다시 조사한다.
    #[serde(default)]
    probe_revision: u32,
    #[serde(default)]
    updated_at: i64,
}

impl DiscoveredSettingsSchema {
    /// 같은 실행 파일·버전을 같은 조사 로직으로 읽어 둔 기록인지.
    fn matches_install(&self, executable: Option<&str>, cli_version: Option<&str>) -> bool {
        self.executable_path.as_deref() == executable
            && self.cli_version.as_deref() == cli_version
            && self.probe_revision == CURRENT_PROBE_REVISION
    }
}

fn schema_overrides_path(app_data_dir: &std::path::Path) -> PathBuf {
    app_data_dir.join(CHAT_SETTINGS_SCHEMA_FILE)
}

fn load_schema_overrides(app_data_dir: &std::path::Path) -> ChatSettingsSchemaOverrides {
    fs::read(schema_overrides_path(app_data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_schema_overrides(
    app_data_dir: &std::path::Path,
    overrides: &ChatSettingsSchemaOverrides,
) -> Result<(), CoreError> {
    let body = serde_json::to_vec_pretty(overrides).map_err(|error| {
        CoreError::Runtime(format!("실행설정 스키마를 직렬화하지 못했습니다: {error}"))
    })?;
    fs::write(schema_overrides_path(app_data_dir), body)?;
    Ok(())
}

/// 해당 공급자의 실행설정 스키마가 마지막으로 바뀐 시각. AIA 제안(파일 단위)과
/// 자동 조사(공급자 단위) 중 더 최근 것을 쓴다.
fn schema_overrides_updated_at(
    source: ProviderId,
    app_data_dir: Option<&std::path::Path>,
) -> Option<i64> {
    let overrides = load_schema_overrides(app_data_dir?);
    let discovered = overrides
        .discovered
        .get(source.as_str())
        .map(|record| record.updated_at)
        .unwrap_or_default();
    let updated_at = overrides.updated_at.max(discovered);
    (updated_at > 0).then_some(updated_at)
}

/// 제안된 스키마 필드를 검증한다. 내장 항목은 선택지 값이 내장 값의 부분집합일 때만
/// (재라벨·재배열·숨김) 허용하고, 새 항목은 동적 화이트리스트에 있어야 한다.
/// AI가 생성한 스키마가 임의 CLI 플래그나 표시 폭주로 이어지지 않게 막는 신뢰 경계다.
/// 스키마 항목 하나를 검증한다. 항목 자체의 표시 규칙을 먼저 보고, 선택지 값은
/// 동적 화이트리스트 규칙과 내장 값 부분집합 규칙 중 해당하는 쪽으로 넘긴다.
fn validate_schema_field(
    source: ProviderId,
    field: &ChatSettingField,
    builtin: &[ChatSettingField],
) -> Result<(), CoreError> {
    let invalid = |reason: &str| Err(validation_error(SCHEMA_SUBJECT, reason));
    if !label_is_valid(&field.label) {
        return invalid("항목 라벨 길이가 잘못됐습니다");
    }
    if !detail_is_valid(field.detail.as_deref()) {
        return invalid("항목 설명이 너무 깁니다");
    }
    if field.options.len() > MAX_FIELD_OPTIONS {
        return invalid("선택지가 12개를 넘습니다");
    }
    for option in &field.options {
        if option.value.is_empty()
            || option.value.len() > MAX_OPTION_VALUE_LEN
            || !label_is_valid(&option.label)
            || !detail_is_valid(option.detail.as_deref())
        {
            return invalid("선택지 값 또는 라벨이 잘못됐습니다");
        }
    }
    // 동적 화이트리스트 항목(내장 여부와 무관)은 해당 값 규칙으로,
    // 그 외 내장 enum 항목(mode·approvalMode)은 내장 값 부분집합 규칙으로 검증한다.
    if let Some(spec) = dynamic_setting_spec(source, &field.key) {
        validate_dynamic_field_values(field, spec)
    } else if let Some(builtin_field) = builtin.iter().find(|candidate| candidate.key == field.key)
    {
        validate_builtin_field_values(field, builtin_field)
    } else {
        invalid("동적 화이트리스트에 없는 항목입니다")
    }
}

/// 화이트리스트 항목의 값 규칙(식별자 또는 정해진 목록)을 선택지와 기본값에 적용한다.
fn validate_dynamic_field_values(
    field: &ChatSettingField,
    spec: &DynamicSettingSpec,
) -> Result<(), CoreError> {
    if !field
        .options
        .iter()
        .all(|option| spec.rule.accepts(&option.value))
    {
        return Err(validation_error(
            SCHEMA_SUBJECT,
            "동적 항목 선택지 값이 규칙에 어긋납니다",
        ));
    }
    if field
        .default_value
        .as_deref()
        .is_some_and(|default| !spec.rule.accepts(default))
    {
        return Err(validation_error(
            SCHEMA_SUBJECT,
            "동적 항목 기본값이 규칙에 어긋납니다",
        ));
    }
    Ok(())
}

/// 내장 enum 항목은 값 집합을 넓히지 못한다. 선택지는 내장 목록의 부분집합이어야 하고
/// 기본값은 남은 선택지 안에 있어야 한다.
fn validate_builtin_field_values(
    field: &ChatSettingField,
    builtin_field: &ChatSettingField,
) -> Result<(), CoreError> {
    let invalid = |reason: &str| Err(validation_error(SCHEMA_SUBJECT, reason));
    if field.options.is_empty() {
        return invalid("내장 항목의 선택지가 비었습니다");
    }
    let allowed = |value: &str| {
        builtin_field
            .options
            .iter()
            .any(|allowed| allowed.value == value)
    };
    if !field.options.iter().all(|option| allowed(&option.value)) {
        return invalid("내장 항목에 허용되지 않은 선택지 값이 있습니다");
    }
    if field
        .default_value
        .as_deref()
        .is_some_and(|default| !field.options.iter().any(|option| option.value == default))
    {
        return invalid("기본값이 선택지에 없습니다");
    }
    Ok(())
}

fn validate_schema_fields(
    source: ProviderId,
    fields: &[ChatSettingField],
) -> Result<(), CoreError> {
    if fields.len() > MAX_SCHEMA_FIELDS {
        return Err(validation_error(SCHEMA_SUBJECT, "항목이 24개를 넘습니다"));
    }
    let builtin = provider_setting_fields(source);
    let mut seen = HashSet::new();
    for field in fields {
        if field.key.is_empty() || field.key.len() > MAX_FIELD_KEY_LEN || !seen.insert(&field.key) {
            return Err(validation_error(
                SCHEMA_SUBJECT,
                "항목 키가 비었거나 중복됩니다",
            ));
        }
        validate_schema_field(source, field, &builtin)?;
    }
    Ok(())
}

/// 내장 스키마 → CLI 조사 결과 → AIA 제안 순으로 덧입힌다. 저장 시점에 검증했더라도
/// 파일이 외부에서 바뀔 수 있으므로 로드 때 다시 검증하고, 실패하면 이전 단계로 폴백한다.
fn merged_setting_fields(
    source: ProviderId,
    app_data_dir: Option<&std::path::Path>,
) -> Vec<ChatSettingField> {
    let mut merged = overlaid_setting_fields(source, app_data_dir);
    // 어느 단계에서 온 항목이든, 그 공급자가 실행에 쓰지 못하는 항목은 내보내지 않는다.
    merged.retain(|field| provider_exposes_setting_field(source, &field.key));
    merged
}

fn overlaid_setting_fields(
    source: ProviderId,
    app_data_dir: Option<&std::path::Path>,
) -> Vec<ChatSettingField> {
    let base = provider_setting_fields(source);
    let Some(app_data_dir) = app_data_dir else {
        return base;
    };
    let overrides = load_schema_overrides(app_data_dir);
    // 조사 결과는 항목 추가·삭제까지 반영해야 하므로 목록 전체를 대체한다.
    let mut merged = match overrides.discovered.get(source.as_str()) {
        Some(record)
            if !record.fields.is_empty()
                && validate_schema_fields(source, &record.fields).is_ok() =>
        {
            record.fields.clone()
        }
        _ => base.clone(),
    };
    let Some(fields) = overrides.providers.get(source.as_str()) else {
        return merged;
    };
    if validate_schema_fields(source, fields).is_err() {
        return merged;
    }
    for field in fields {
        if let Some(existing) = merged
            .iter_mut()
            .find(|candidate| candidate.key == field.key)
        {
            *existing = field.clone();
        } else {
            merged.push(field.clone());
        }
    }
    merged
}

/// 실행설정 화면에 내보낼 항목인지. 값을 골라도 CLI로 전달될 통로가 없는 항목은
/// 숨긴다. Antigravity CLI는 `--print`에 대화형 승인 연결이 없어 승인 처리 값이
/// 실행에 전혀 쓰이지 않는다(권한 범위는 실행 모드가 전부 결정한다).
/// 내장 스키마에서 항목 자체를 빼지 않는 이유는, 이미 저장된 AIA 제안·조사 결과가
/// `validate_schema_fields`에서 통째로 거절돼 나머지 항목까지 잃지 않게 하기 위함이다.
fn provider_exposes_setting_field(source: ProviderId, key: &str) -> bool {
    !(source == ProviderId::Antigravity && key == "approvalMode")
}

/// 스키마 선택지와 그 선택지를 실행할 때 쓰는 CLI 인자를 잇는 근거표.
/// 도움말에서 해당 플래그의 허용값 목록을 읽어냈고 그 안에 값이 없을 때만 선택지를 뺀다.
/// 여기 없는 선택지는 CLI 플래그로 표현되지 않는 앱 내부 동작이므로 조사 대상이 아니다.
struct SettingOptionEvidence {
    field: &'static str,
    option: &'static str,
    flag: &'static str,
    flag_value: &'static str,
}

const fn evidence(
    field: &'static str,
    option: &'static str,
    flag: &'static str,
    flag_value: &'static str,
) -> SettingOptionEvidence {
    SettingOptionEvidence {
        field,
        option,
        flag,
        flag_value,
    }
}

/// claude_stream_cli_args의 --permission-mode 매핑과 짝을 맞춘다. 승인 처리는
/// --permission-prompt-tool 유무로 표현되고 열거형이 아니므로 조사 대상이 아니다.
const CLAUDE_OPTION_EVIDENCE: &[SettingOptionEvidence] = &[
    evidence("mode", "plan", "--permission-mode", "plan"),
    evidence("mode", "workspace", "--permission-mode", "acceptEdits"),
    evidence(
        "mode",
        "fullAccess",
        "--permission-mode",
        "bypassPermissions",
    ),
    evidence("mode", "auto", "--permission-mode", "auto"),
    evidence("mode", "dontAsk", "--permission-mode", "dontAsk"),
    evidence("mode", "manual", "--permission-mode", "manual"),
];

/// Codex는 app-server RPC로 실행하지만 sandboxPolicy·approvalPolicy 값 집합은
/// CLI 도움말의 --sandbox·--ask-for-approval과 같은 열거형을 공유한다.
const CODEX_OPTION_EVIDENCE: &[SettingOptionEvidence] = &[
    evidence("mode", "plan", "--sandbox", "read-only"),
    evidence("mode", "workspace", "--sandbox", "workspace-write"),
    evidence("mode", "fullAccess", "--sandbox", "danger-full-access"),
    evidence("approvalMode", "manual", "--ask-for-approval", "on-request"),
    evidence(
        "approvalMode",
        "autoReview",
        "--ask-for-approval",
        "on-request",
    ),
    evidence("approvalMode", "never", "--ask-for-approval", "never"),
];
// granular는 app-server가 세분화 객체로 노출하고, on-failure는 0.148.0 바이너리의
// AskForApproval enum에는 있지만 --help와 thread/start 문자열 스키마에는 없다.
// 도움말만으로 제거하지 않도록 두 내장 선택지는 evidence 표에서 의도적으로 제외한다.

/// antigravity_stream_cli_args의 --mode 매핑과 짝을 맞춘다.
const ANTIGRAVITY_OPTION_EVIDENCE: &[SettingOptionEvidence] = &[
    evidence("mode", "plan", "--mode", "plan"),
    evidence("mode", "workspace", "--mode", "accept-edits"),
    evidence("mode", "fullAccess", "--mode", "accept-edits"),
];

fn provider_option_evidence(source: ProviderId) -> &'static [SettingOptionEvidence] {
    match source {
        ProviderId::Claude => CLAUDE_OPTION_EVIDENCE,
        ProviderId::Codex => CODEX_OPTION_EVIDENCE,
        ProviderId::Antigravity => ANTIGRAVITY_OPTION_EVIDENCE,
    }
}

/// 조사된 인터페이스로 내장 스키마를 좁힌다. 항목·선택지를 새로 만들지는 않는다.
/// 내장에 없는 항목이 조사 결과로 들어오는 경로는 없으므로 신뢰 경계가 그대로 유지된다.
fn discovered_setting_fields(
    source: ProviderId,
    interface: &CliInterface,
) -> Vec<ChatSettingField> {
    let evidences = provider_option_evidence(source);
    let mut fields = provider_setting_fields(source);
    for field in &mut fields {
        let supported: Vec<ChatSettingOption> = field
            .options
            .iter()
            .filter(|option| {
                evidences
                    .iter()
                    .find(|item| item.field == field.key && item.option == option.value)
                    .map(|item| interface.accepts_value(item.flag, item.flag_value))
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        // 전부 사라지면 조사를 신뢰하지 않고 내장 선택지를 유지한다.
        if supported.is_empty() || supported.len() == field.options.len() {
            continue;
        }
        // 기본값이 빠졌으면 남은 선택지 중 고를 수 있는 첫 값으로 정규화한다.
        if field
            .default_value
            .as_deref()
            .is_some_and(|value| !supported.iter().any(|option| option.value == value))
        {
            field.default_value = supported
                .iter()
                .find(|option| !option.disabled)
                .or_else(|| supported.first())
                .map(|option| option.value.clone());
        }
        field.options = supported;
    }
    // 화이트리스트 동적 항목은 도움말에 플래그가 보일 때만 노출한다. 지원하지 않는
    // 옵션을 UI에 남기지 않기 위한 것이고, 플래그가 다시 보이면 자동으로 돌아온다.
    fields.retain(|field| {
        dynamic_setting_spec(source, &field.key)
            .map(|spec| interface.has_flag(spec.flag))
            .unwrap_or(true)
    });
    fields
}

/// 추론 수준을 CLI 플래그로 넘기는 공급자와 그 플래그. Codex는 플래그가 아니라
/// app-server `turn/start` 파라미터로 보내므로 도움말에서 읽을 값 목록이 없다.
fn provider_effort_flag(source: ProviderId) -> Option<&'static str> {
    match source {
        ProviderId::Claude | ProviderId::Antigravity => Some("--effort"),
        ProviderId::Codex => None,
    }
}

/// 도움말에서 읽은 `--effort` 허용값으로 추론 수준 목록을 만든다. 값 목록을 뽑지
/// 못했으면 빈 목록을 돌려 내장 목록을 그대로 쓰게 한다(단방향 판정).
///
/// 내장에 없는 이름도 그대로 받아들인다. CLI가 새 수준을 추가했을 때 앱을 새로
/// 배포하지 않고 선택지에 나타나게 하려는 것이고, 설명 문구는 비어 있다가 AIA 제안
/// 카탈로그가 채운다. 표시 순서는 내장 순서를 먼저 지키고 새 이름을 뒤에 붙인다.
fn discovered_reasoning_efforts(
    source: ProviderId,
    interface: &CliInterface,
) -> Vec<ChatReasoningOption> {
    let Some(flag) = provider_effort_flag(source) else {
        return Vec::new();
    };
    let Some(values) = interface.values_for(flag) else {
        return Vec::new();
    };
    let builtin = provider_reasoning_options(source);
    let mut options: Vec<ChatReasoningOption> = builtin
        .iter()
        .filter(|option| values.contains(option.effort.as_str()))
        .cloned()
        .collect();
    for value in values {
        if builtin
            .iter()
            .any(|option| option.effort.as_str() == value.as_str())
        {
            continue;
        }
        if let Some(effort) = ReasoningEffort::parse(value) {
            options.push(ChatReasoningOption {
                description: effort_description(&effort).to_owned(),
                effort,
            });
        }
    }
    options
}

/// 실행설정 항목 스키마. 프론트는 이 목록을 그대로 렌더링하므로,
/// 항목·선택지를 바꾸면 UI가 함께 바뀐다. 프론트 fallbackSettingFields와 내용을 맞출 것.
fn provider_setting_fields(source: ProviderId) -> Vec<ChatSettingField> {
    let codex = source == ProviderId::Codex;
    let claude = source == ProviderId::Claude;
    let mut mode_options = vec![
        setting_option("plan", "읽기 전용", "분석·계획만", false),
        setting_option("workspace", "작업공간 쓰기", "프로젝트 수정", false),
        setting_option("fullAccess", "전체 접근", "외부 경로 허용", false),
    ];
    if claude {
        mode_options.extend([
            setting_option("auto", "자동 권한", "Claude auto 모드", false),
            setting_option("dontAsk", "추가 권한 차단", "Claude dontAsk 모드", false),
            setting_option("manual", "수동 권한", "Claude manual 모드", false),
        ]);
    }
    let mut approval_options = vec![
        setting_option("manual", "직접 승인", "사용자 확인", false),
        if codex {
            setting_option("autoReview", "자동 검토", "위험도 판단", false)
        } else {
            setting_option("autoReview", "자동 검토", "Codex 전용", true)
        },
    ];
    if codex {
        approval_options.extend([
            setting_option("granular", "세분화 승인", "승인 종류별 제어", false),
            setting_option("onFailure", "실패 시 승인", "샌드박스 실패 후 요청", false),
        ]);
    }
    approval_options.push(setting_option(
        "never",
        "승인 없이 실행",
        "모드 범위 내",
        false,
    ));
    let mut fields = vec![
        ChatSettingField {
            key: "mode".to_owned(),
            label: "실행 모드".to_owned(),
            detail: Some("권한 범위".to_owned()),
            kind: ChatSettingFieldKind::Enum,
            options: mode_options,
            default_value: Some("workspace".to_owned()),
        },
        ChatSettingField {
            key: "approvalMode".to_owned(),
            label: "승인 처리".to_owned(),
            detail: Some("명령 · 파일 · 추가 권한".to_owned()),
            kind: ChatSettingFieldKind::Enum,
            options: approval_options,
            default_value: Some(if codex { "autoReview" } else { "manual" }.to_owned()),
        },
    ];
    // 화이트리스트에 등록된 동적 항목을 스키마에 노출한다. Claude --fallback-model이 첫 사례.
    if source == ProviderId::Claude {
        fields.push(ChatSettingField {
            key: "fallbackModel".to_owned(),
            label: "예비 모델".to_owned(),
            detail: Some("기본 모델 과부하 시 자동 전환".to_owned()),
            kind: ChatSettingFieldKind::Text,
            options: Vec::new(),
            default_value: None,
        });
    }
    fields
}

fn load_codex_model_catalog(
    executable: &std::path::Path,
) -> Result<Vec<ChatModelOption>, CoreError> {
    let mut command = Command::new(executable);
    command
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_headless_command(&mut command);
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!("Codex 모델 목록을 시작하지 못했습니다: {error}"))
    })?;
    let result = (|| {
        let mut stdin = child.stdin.take().ok_or_else(|| {
            CoreError::Runtime("Codex 모델 목록 stdin을 열지 못했습니다".to_owned())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            CoreError::Runtime("Codex 모델 목록 stdout을 열지 못했습니다".to_owned())
        })?;
        let mut reader = BufReader::new(stdout);
        write_json_line(
            &mut stdin,
            &json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {"name": "agent-manager", "title": "Agent Manager", "version": env!("CARGO_PKG_VERSION")},
                    "capabilities": {"experimentalApi": true}
                }
            }),
        )?;
        read_rpc_result(&mut reader, 1)?;
        write_json_line(&mut stdin, &json!({"method": "initialized"}))?;

        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        for request_id in 2..=5 {
            write_json_line(
                &mut stdin,
                &json!({
                    "id": request_id,
                    "method": "model/list",
                    "params": {"cursor": cursor, "includeHidden": false}
                }),
            )?;
            let page = read_rpc_result(&mut reader, request_id)?;
            if let Some(items) = page.get("data").and_then(Value::as_array) {
                models.extend(items.iter().filter_map(parse_codex_model));
            }
            cursor = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        Ok(models)
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn parse_codex_model(value: &Value) -> Option<ChatModelOption> {
    let model = value.get("model")?.as_str()?.to_owned();
    let supported_reasoning_efforts = value
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        // 지원 목록(어떤 effort를 쓸 수 있는지)만 CLI를 따르고, 설명 문구는 앱 한국어로 통일한다.
        // CLI가 주는 description은 영문이라 화면 문구가 섞이고 선택 박스 폭도 넘친다.
        .filter_map(|option| {
            let effort = ReasoningEffort::parse(option.get("reasoningEffort")?.as_str()?)?;
            Some(ChatReasoningOption {
                description: effort_description(&effort).to_owned(),
                effort,
            })
        })
        .collect();
    Some(ChatModelOption {
        display_name: value
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(&model)
            .to_owned(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        is_default: value
            .get("isDefault")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        default_reasoning_effort: value
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .and_then(ReasoningEffort::parse),
        supported_reasoning_efforts,
        model,
    })
}

/// `agy models`는 stdout에 `모델ID\t표시명` TSV를 내보낸다(진행 안내는 stderr).
/// 네트워크 조회라 응답이 없으면 멈출 수 있어 마감 시한을 두고 기다린다.
fn load_antigravity_model_catalog(
    executable: &std::path::Path,
) -> Result<Vec<ChatModelOption>, CoreError> {
    let mut command = Command::new(executable);
    command
        .arg("models")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    configure_headless_command(&mut command);
    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!(
            "Antigravity 모델 목록을 시작하지 못했습니다: {error}"
        ))
    })?;
    let deadline = Instant::now() + ANTIGRAVITY_MODELS_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CoreError::Runtime(
                        "Antigravity 모델 목록 조회 시간이 초과되었습니다".to_owned(),
                    ));
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CoreError::Runtime(format!(
                    "Antigravity 모델 목록 상태를 확인하지 못했습니다: {error}"
                )));
            }
        }
    };
    if !status.success() {
        return Err(CoreError::Runtime(
            "Antigravity CLI가 모델 목록 조회에 실패했습니다. 로그인 상태를 확인하세요".to_owned(),
        ));
    }
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        pipe.read_to_string(&mut stdout).map_err(|error| {
            CoreError::Runtime(format!("Antigravity 모델 목록을 읽지 못했습니다: {error}"))
        })?;
    }
    let models = parse_antigravity_models(&stdout);
    if models.is_empty() {
        return Err(CoreError::Runtime(
            "Antigravity CLI가 모델 목록을 반환하지 않았습니다".to_owned(),
        ));
    }
    Ok(models)
}

fn parse_antigravity_models(stdout: &str) -> Vec<ChatModelOption> {
    stdout
        .lines()
        .filter_map(|line| {
            let (model, display_name) = line.split_once('\t')?;
            let model = model.trim();
            let display_name = display_name.trim();
            if model.is_empty() || display_name.is_empty() {
                return None;
            }
            Some(ChatModelOption {
                model: model.to_owned(),
                display_name: display_name.to_owned(),
                description: String::new(),
                is_default: false,
                default_reasoning_effort: None,
                supported_reasoning_efforts: Vec::new(),
            })
        })
        .collect()
}

/// AIA 디스커버리가 조사한 항목·모델·추론 카탈로그를 검증해 저장본에 반영한다.
///
/// 진입점이 여기 하나뿐이라 저장 구조체와 검증 규칙이 모듈 밖으로 새지 않는다.
pub(crate) fn propose_schema(
    source: ProviderId,
    app_data_dir: &Path,
    fields: Option<Vec<ChatSettingField>>,
    models: Option<Vec<ChatModelOption>>,
    reasoning_efforts: Option<Vec<ChatReasoningOption>>,
) -> Result<(), CoreError> {
    if let Some(fields) = fields.as_ref().filter(|fields| !fields.is_empty()) {
        validate_schema_fields(source, fields)?;
    }
    let mut overrides = load_schema_overrides(app_data_dir);
    let proposed_fields = fields.is_some();
    if let Some(fields) = fields {
        if fields.is_empty() {
            overrides.providers.remove(source.as_str());
        } else {
            overrides
                .providers
                .insert(source.as_str().to_owned(), fields);
        }
    }
    // 목록을 넘기지 않은 호출도 카탈로그 단계를 지난다. 기존 제안을 그대로 둔 채
    // CLI 버전만 다시 새기지 않으면 `catalog_stale`이 계속 서서, 화면의 자동 재조사가
    // 같은 CLI 버전에서 같은 요청을 반복해 보낸다.
    let outcome = apply_catalog_proposal(source, &mut overrides, models, reasoning_efforts)?;
    overrides.updated_at = now_ms();
    write_schema_overrides(app_data_dir, &overrides)?;
    // 유지할 제안도 새 제안도 없으면 '차이 없음'이 아니라 아직 조사되지 않은 상태이므로
    // 확인으로 기록하지 않는다(`catalog_stale`이 그대로 선다). 항목 제안만 담긴 호출은
    // 그 제안 자체가 결과이므로 그대로 두고, 아무것도 담기지 않은 호출만 확인할 대상이
    // 없다고 알린다 — 조용히 성공하면 재조사가 끝난 것으로 오해된다.
    if outcome == CatalogProposalOutcome::Missing && !proposed_fields {
        return Err(CoreError::InvalidInput(
            "확인할 기존 제안도 새로 저장할 제안도 없습니다: models 또는 \
             reasoningEfforts를 채워 보내세요. 빈 배열은 제안을 지울 때만 씁니다"
                .to_owned(),
        ));
    }
    Ok(())
}

/// 설치된 CLI의 실제 인터페이스를 조사해 저장된 스키마를 최신 상태로 맞춘다.
/// 기록이 바뀌었으면 true.
pub(crate) fn refresh_discovered_schema(
    source: ProviderId,
    app_data_dir: &Path,
    executable: Option<&Path>,
    cli_version: Option<&str>,
    force: bool,
) -> Result<bool, CoreError> {
    let mut overrides = load_schema_overrides(app_data_dir);
    let key = source.as_str().to_owned();
    // CLI가 사라졌으면 조사 기록을 버리고 내장 스키마로 돌아간다.
    let Some(executable) = executable else {
        if overrides.discovered.remove(&key).is_none() {
            return Ok(false);
        }
        write_schema_overrides(app_data_dir, &overrides)?;
        return Ok(true);
    };
    let executable_path = executable.to_string_lossy().into_owned();
    if !force
        && overrides
            .discovered
            .get(&key)
            .is_some_and(|record| record.matches_install(Some(&executable_path), cli_version))
    {
        return Ok(false);
    }

    let interface = probe_cli_interface(executable)?;
    let fields = discovered_setting_fields(source, &interface);
    // 조사 결과도 저장 전에 같은 신뢰 경계를 통과해야 한다.
    validate_schema_fields(source, &fields)?;
    let record = DiscoveredSettingsSchema {
        fields,
        reasoning_efforts: discovered_reasoning_efforts(source, &interface),
        cli_version: cli_version.map(str::to_owned),
        executable_path: Some(executable_path),
        probe_revision: CURRENT_PROBE_REVISION,
        updated_at: now_ms(),
    };
    if overrides.discovered.get(&key).is_some_and(|previous| {
        previous.fields == record.fields && previous.reasoning_efforts == record.reasoning_efforts
    }) {
        // 항목이 그대로면 갱신 시각을 흔들지 않고, 재조사를 건너뛸 수 있도록
        // 조사 대상 버전·경로만 최신으로 맞춘다.
        let previous = overrides.discovered.get_mut(&key).expect("직전에 확인함");
        if previous.matches_install(record.executable_path.as_deref(), cli_version) {
            return Ok(false);
        }
        previous.cli_version = record.cli_version;
        previous.executable_path = record.executable_path;
        previous.probe_revision = record.probe_revision;
        write_schema_overrides(app_data_dir, &overrides)?;
        return Ok(true);
    }
    overrides.discovered.insert(key, record);
    write_schema_overrides(app_data_dir, &overrides)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::ChatSupervisor;

    /// 시험용 앱 데이터 디렉터리. 열두 곳이 같은 한 줄을 손으로 되풀이했다.
    fn schema_dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("schema dir")
    }

    /// 스키마 저장본을 앱 데이터 디렉터리에 미리 깔아 둔다. 일곱 곳이
    /// `fs::write(dir.path().join(CHAT_SETTINGS_SCHEMA_FILE), value.to_string())`를
    /// 손으로 되풀이했고 실패 문구만 곳마다 달랐다.
    fn write_stored_schema(dir: &tempfile::TempDir, value: &Value) {
        fs::write(
            dir.path().join(CHAT_SETTINGS_SCHEMA_FILE),
            value.to_string(),
        )
        .expect("write schema file");
    }

    /// 해당 디렉터리를 앱 데이터로 삼는 감독자. 아홉 곳이 같은 두 줄이었다.
    fn supervisor_at(dir: &tempfile::TempDir) -> ChatSupervisor {
        ChatSupervisor::with_app_data_dir(dir.path().to_path_buf())
            .expect("supervisor with app data dir")
    }

    #[test]
    fn codex_catalog_preserves_model_specific_reasoning_options() {
        let model = parse_codex_model(&json!({
            "model": "gpt-5.6-sol",
            "displayName": "GPT-5.6-Sol",
            "description": "Latest frontier agentic coding model.",
            "isDefault": true,
            "defaultReasoningEffort": "medium",
            "supportedReasoningEfforts": [
                {"reasoningEffort": "low", "description": "Fast"},
                {"reasoningEffort": "ultra", "description": "Delegation"}
            ]
        }))
        .expect("catalog model");
        assert!(model.is_default);
        assert_eq!(
            model.default_reasoning_effort,
            Some(ReasoningEffort::Medium)
        );
        assert_eq!(
            model
                .supported_reasoning_efforts
                .iter()
                .map(|option| option.effort.clone())
                .collect::<Vec<_>>(),
            vec![ReasoningEffort::Low, ReasoningEffort::Ultra]
        );
        // 설명 문구는 CLI 영문("Fast"/"Delegation")이 아니라 앱 한국어를 쓴다.
        assert_eq!(
            model
                .supported_reasoning_efforts
                .iter()
                .map(|option| option.description.as_str())
                .collect::<Vec<_>>(),
            vec![
                effort_description(&ReasoningEffort::Low),
                effort_description(&ReasoningEffort::Ultra)
            ]
        );
    }

    #[test]
    fn schema_overrides_merge_from_disk_and_fall_back_when_invalid() {
        let dir = schema_dir();

        // 유효한 오버라이드: 내장 mode 항목 재구성(선택지 축소) + 화이트리스트 항목 enum화
        let overrides = json!({
            "providers": {"claude": [
                {"key": "mode", "label": "모드", "kind": "enum",
                 "options": [{"value": "plan", "label": "읽기"}], "defaultValue": "plan"},
                {"key": "fallbackModel", "label": "예비 모델", "kind": "enum",
                 "options": [{"value": "claude-sonnet-5", "label": "Sonnet 5"}]}
            ]},
            "updatedAt": 1
        });
        write_stored_schema(&dir, &overrides);
        let fields = merged_setting_fields(ProviderId::Claude, Some(dir.path()));
        let mode = fields
            .iter()
            .find(|field| field.key == "mode")
            .expect("mode");
        assert_eq!(mode.options.len(), 1);
        assert_eq!(mode.default_value.as_deref(), Some("plan"));
        assert!(fields
            .iter()
            .any(|field| field.key == "fallbackModel" && field.options.len() == 1));

        // 내장 항목에 없는 선택지 값을 끼워 넣으면 검증 실패 → 전체 오버라이드 폐기, 내장 폴백
        let hostile = json!({
            "providers": {"claude": [
                {"key": "mode", "label": "모드", "kind": "enum",
                 "options": [{"value": "godMode", "label": "무제한"}], "defaultValue": "godMode"}
            ]}
        });
        write_stored_schema(&dir, &hostile);
        let fields = merged_setting_fields(ProviderId::Claude, Some(dir.path()));
        let mode = fields
            .iter()
            .find(|field| field.key == "mode")
            .expect("mode");
        assert_eq!(mode.options.len(), 6);
        assert_eq!(mode.default_value.as_deref(), Some("workspace"));

        // 화이트리스트에 없는 새 항목 제안은 검증 단계에서 거부된다
        let rogue = vec![ChatSettingField {
            key: "skipChecks".to_owned(),
            label: "검사 생략".to_owned(),
            detail: None,
            kind: ChatSettingFieldKind::Enum,
            options: vec![setting_option("true", "켜기", "", false)],
            default_value: None,
        }];
        assert!(validate_schema_fields(ProviderId::Claude, &rogue).is_err());
    }

    /// 조사 결과가 내장 선택지를 좁히고, 좁혀진 결과도 신뢰 경계를 통과한다.
    #[test]
    fn discovered_fields_drop_options_the_cli_no_longer_accepts() {
        // Codex가 danger-full-access를 없애고 never 승인을 남긴 가상의 도움말.
        let interface = CliInterface::parse(
            "Options:\n  -s, --sandbox <SANDBOX_MODE>\n          Sandbox policy\n\n          [possible values: read-only, workspace-write]\n\n  -a, --ask-for-approval <APPROVAL_POLICY>\n          Approval policy\n\n          [possible values: on-request, never]\n\n  -m, --model <MODEL>\n          Model\n\n  -h, --help\n          Print help\n",
        );
        assert!(interface.is_reliable());
        let fields = discovered_setting_fields(ProviderId::Codex, &interface);
        validate_schema_fields(ProviderId::Codex, &fields).expect("조사 결과도 검증을 통과한다");

        let mode = fields
            .iter()
            .find(|field| field.key == "mode")
            .expect("mode field");
        assert_eq!(
            mode.options
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            vec!["plan", "workspace"]
        );
        // 기본값은 남은 선택지 안에 있어야 한다.
        assert_eq!(mode.default_value.as_deref(), Some("workspace"));

        // 도움말에 있는 선택지와 바이너리/API로 검증된 숨은 선택지를 함께 유지한다.
        let approval = fields
            .iter()
            .find(|field| field.key == "approvalMode")
            .expect("approvalMode field");
        assert_eq!(
            approval
                .options
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            vec!["manual", "autoReview", "granular", "onFailure", "never"]
        );
    }

    /// 도움말에 값 목록이 없으면 판단을 보류하고 내장 선택지를 그대로 쓴다.
    #[test]
    fn discovered_fields_keep_builtin_options_without_enumerated_values() {
        let interface = CliInterface::parse(
            "Options:\n  --permission-mode <mode>              Permission mode to use\n  --model <model>                       Model\n  --print                               Print mode\n  --verbose                             Verbose\n",
        );
        assert!(interface.is_reliable());
        let fields = discovered_setting_fields(ProviderId::Claude, &interface);
        let mode = fields
            .iter()
            .find(|field| field.key == "mode")
            .expect("mode field");
        assert_eq!(mode.options.len(), 6);
        // --fallback-model이 없는 도움말에서는 화이트리스트 동적 항목을 노출하지 않는다.
        assert!(!fields.iter().any(|field| field.key == "fallbackModel"));
    }

    /// 조사 항목이 늘어난 버전에서는 CLI가 그대로여도 기존 기록을 한 번 다시 조사한다.
    #[test]
    fn records_from_an_older_probe_revision_are_reprobed() {
        let legacy: DiscoveredSettingsSchema = serde_json::from_value(json!({
            "fields": [],
            "cliVersion": "2.1.233",
            "executablePath": "/usr/local/bin/claude",
            "updatedAt": 10
        }))
        .expect("이전 버전 조사 기록");
        assert_eq!(legacy.probe_revision, 0);
        assert!(!legacy.matches_install(Some("/usr/local/bin/claude"), Some("2.1.233")));

        let current = DiscoveredSettingsSchema {
            probe_revision: CURRENT_PROBE_REVISION,
            ..legacy
        };
        assert!(current.matches_install(Some("/usr/local/bin/claude"), Some("2.1.233")));
    }

    /// 도움말의 `--effort` 허용값으로 추론 수준을 좁히고, 내장에 없는 새 이름도 흡수한다.
    #[test]
    fn reasoning_efforts_follow_the_effort_flag_in_help() {
        let narrowed = CliInterface::parse(
            "Options:\n  --effort <level>  Effort level for the current session (low, high)\n  --model <model>  Model\n  --add-dir <dirs...>  Dirs\n  --agent <agent>  Agent\n",
        );
        assert_eq!(
            discovered_reasoning_efforts(ProviderId::Claude, &narrowed)
                .iter()
                .map(|option| option.effort.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec!["low", "high"]
        );

        // 내장에 없는 이름은 뒤에 붙고, 설명 문구는 비운다(AIA 제안이 채운다).
        let extended = CliInterface::parse(
            "Options:\n  --effort <level>  Effort level (low, high, turbo)\n  --model <model>  Model\n  --add-dir <dirs...>  Dirs\n  --agent <agent>  Agent\n",
        );
        let options = discovered_reasoning_efforts(ProviderId::Claude, &extended);
        assert_eq!(
            options
                .iter()
                .map(|option| option.effort.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec!["low", "high", "turbo"]
        );
        assert_eq!(
            options[2].effort,
            ReasoningEffort::Other("turbo".to_owned())
        );
        assert!(options[2].description.is_empty());

        // 값 목록을 못 읽으면 판단을 보류한다(내장 목록 유지).
        let unknown = CliInterface::parse(
            "Options:\n  --effort <level>  Effort level for the current session\n  --model <model>  Model\n  --add-dir <dirs...>  Dirs\n  --agent <agent>  Agent\n",
        );
        assert!(discovered_reasoning_efforts(ProviderId::Claude, &unknown).is_empty());
        // Codex는 추론을 플래그로 넘기지 않으므로 도움말에서 읽을 값이 없다.
        assert!(discovered_reasoning_efforts(ProviderId::Codex, &extended).is_empty());
    }

    #[test]
    fn codex_none_effort_is_distinct_from_an_unspecified_effort() {
        assert_eq!(ReasoningEffort::parse("none"), Some(ReasoningEffort::None));
        assert_eq!(
            serde_json::to_value(ReasoningEffort::None).expect("serialize none effort"),
            json!("none")
        );
        assert_eq!(
            provider_reasoning_options(ProviderId::Codex)
                .first()
                .map(|option| option.effort.clone()),
            Some(ReasoningEffort::None)
        );
    }

    /// 조사된 추론 목록이 내장 목록을 대체하고, AIA 제안이 그 위를 덮는다.
    #[test]
    fn reasoning_options_merge_builtin_then_discovered_then_proposal() {
        let dir = schema_dir();
        let stored = json!({
            "discovered": {"claude": {
                "fields": [],
                "reasoningEfforts": [{"effort": "low", "description": "빠름"}],
                "cliVersion": "2.1.233",
                "executablePath": "/usr/local/bin/claude",
                "updatedAt": 20
            }},
            "updatedAt": 20
        });
        write_stored_schema(&dir, &stored);
        let overrides = load_schema_overrides(dir.path());
        assert_eq!(
            merged_reasoning_options(ProviderId::Claude, &overrides)
                .iter()
                .map(|option| option.effort.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec!["low"]
        );
        // 조사 기록이 없는 공급자는 내장 목록을 그대로 쓴다.
        assert_eq!(
            merged_reasoning_options(ProviderId::Codex, &overrides),
            provider_reasoning_options(ProviderId::Codex)
        );

        let supervisor = supervisor_at(&dir);
        let options = supervisor
            .propose_chat_settings_schema(
                ProviderId::Claude,
                None,
                None,
                Some(vec![
                    ChatReasoningOption {
                        effort: ReasoningEffort::High,
                        description: "복잡한 구현".to_owned(),
                    },
                    ChatReasoningOption {
                        effort: ReasoningEffort::Other("turbo".to_owned()),
                        description: "새 수준".to_owned(),
                    },
                ]),
            )
            .expect("catalog proposal is accepted");
        assert_eq!(
            options
                .supported_reasoning_efforts
                .iter()
                .map(|option| option.effort.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec!["high", "turbo"]
        );
        // 제안에는 지금 조사된 CLI 버전이 함께 기록되어 재조사 판단에 쓰인다.
        let reloaded = load_schema_overrides(dir.path());
        assert_eq!(
            reloaded.catalogs["claude"].cli_version.as_deref(),
            Some("2.1.233")
        );
        assert!(!options.catalog_stale);
    }

    /// CLI가 목록을 내보내지 않는 공급자는 제안 모델이 선택지가 되고, 빈 배열로 제거된다.
    #[test]
    fn proposed_models_fill_the_catalog_and_empty_lists_remove_it() {
        let dir = schema_dir();
        let supervisor = supervisor_at(&dir);
        // 제안이 없으면 재조사 대상이다.
        assert!(
            supervisor
                .chat_provider_options(ProviderId::Claude)
                .catalog_stale
        );

        let model = |id: &str, name: &str, default: bool| ChatModelOption {
            model: id.to_owned(),
            display_name: name.to_owned(),
            description: String::new(),
            is_default: default,
            default_reasoning_effort: None,
            supported_reasoning_efforts: Vec::new(),
        };
        let options = supervisor
            .propose_chat_settings_schema(
                ProviderId::Claude,
                None,
                Some(vec![
                    model("claude-fable-5", "Fable 5", true),
                    model("opus", "Opus", false),
                    model("opus[1m]", "Opus 1M", false),
                ]),
                None,
            )
            .expect("model proposal is accepted");
        assert_eq!(
            options
                .models
                .iter()
                .map(|option| option.model.as_str())
                .collect::<Vec<_>>(),
            vec!["claude-fable-5", "opus", "opus[1m]"]
        );
        assert!(options.catalog_updated_at.is_some());
        // 조사 기록이 없어 CLI 버전을 모르면 제안 버전도 비어 일치한다.
        assert!(!options.catalog_stale);

        // 추론 목록만 남기면 모델 제안만 사라진다.
        let options = supervisor
            .propose_chat_settings_schema(ProviderId::Claude, None, Some(Vec::new()), None)
            .expect("empty model list removes the proposal");
        assert!(options.models.is_empty());
        assert!(load_schema_overrides(dir.path()).catalogs.is_empty());
    }

    /// 제안 카탈로그는 실행 경로와 같은 값 규칙을 통과해야 저장된다.
    #[test]
    fn invalid_catalog_proposals_are_rejected() {
        let dir = schema_dir();
        let supervisor = supervisor_at(&dir);
        let model = |id: &str| ChatModelOption {
            model: id.to_owned(),
            display_name: "표시명".to_owned(),
            description: String::new(),
            is_default: false,
            default_reasoning_effort: None,
            supported_reasoning_efforts: Vec::new(),
        };
        let propose = |source: ProviderId, models: Vec<ChatModelOption>| {
            supervisor.propose_chat_settings_schema(source, None, Some(models), None)
        };

        // 모델 식별자 문법(실행 시 --model에 그대로 들어가는 값)
        assert!(propose(ProviderId::Claude, vec![model("claude fable 5")]).is_err());
        assert!(propose(ProviderId::Claude, vec![model("claude;rm -rf /")]).is_err());
        assert!(propose(ProviderId::Claude, vec![model("opus[2m]")]).is_err());
        // 중복·개수 상한
        assert!(propose(ProviderId::Claude, vec![model("opus"), model("opus")]).is_err());
        assert!(propose(
            ProviderId::Claude,
            (0..MAX_PROPOSED_MODELS + 1)
                .map(|index| model(&format!("model-{index}")))
                .collect()
        )
        .is_err());
        // 기본 모델은 하나뿐
        let mut duplicated_default = vec![model("opus"), model("sonnet")];
        for entry in &mut duplicated_default {
            entry.is_default = true;
        }
        assert!(propose(ProviderId::Claude, duplicated_default).is_err());
        // CLI가 모델 목록을 직접 내보내는 공급자에는 제안하지 못한다.
        assert!(propose(ProviderId::Codex, vec![model("gpt-5.6-sol")]).is_err());
        // 거부된 제안은 파일에 남지 않는다.
        assert!(load_schema_overrides(dir.path()).catalogs.is_empty());

        // 추론 수준 이름도 같은 규칙을 지난다.
        assert!(supervisor
            .propose_chat_settings_schema(
                ProviderId::Claude,
                None,
                None,
                Some(vec![ChatReasoningOption {
                    effort: ReasoningEffort::Other("bad name".to_owned()),
                    description: String::new(),
                }]),
            )
            .is_err());
    }

    /// CLI가 업데이트되면 제안이 오래된 것으로 표시되지만 지워지지는 않는다.
    #[test]
    fn catalog_becomes_stale_when_the_cli_version_moves() {
        let dir = schema_dir();
        let stored = json!({
            "discovered": {"claude": {
                "fields": [],
                "cliVersion": "2.2.0",
                "executablePath": "/usr/local/bin/claude",
                "updatedAt": 30
            }},
            "catalogs": {"claude": {
                "models": [{"model": "claude-fable-5", "displayName": "Fable 5"}],
                "cliVersion": "2.1.233",
                "updatedAt": 20
            }},
            "updatedAt": 30
        });
        write_stored_schema(&dir, &stored);
        let options = load_chat_provider_options(ProviderId::Claude, Some(dir.path()));
        assert!(options.catalog_stale);
        // 오래됐다고 선택지를 지우지는 않는다.
        assert_eq!(options.models.len(), 1);
        // CLI가 목록을 직접 내보내는 공급자는 재조사 대상이 아니다.
        assert!(!load_chat_provider_options(ProviderId::Codex, Some(dir.path())).catalog_stale);
    }

    /// 기존 제안을 그대로 두는 '차이 없음' 완료도 지금 설치된 CLI 버전을 확인한 것으로
    /// 기록한다. 그러지 않으면 같은 CLI 버전에서 자동 재조사가 같은 요청을 되풀이한다.
    #[test]
    fn a_no_difference_proposal_confirms_the_installed_cli_version() {
        let dir = schema_dir();
        let stored = json!({
            "discovered": {"claude": {
                "fields": [],
                "cliVersion": "2.2.0",
                "executablePath": "/usr/local/bin/claude",
                "updatedAt": 30
            }},
            "catalogs": {"claude": {
                "models": [{"model": "claude-fable-5", "displayName": "Fable 5"}],
                "reasoningEfforts": [{"effort": "high", "description": "복잡한 구현"}],
                "cliVersion": "2.1.233",
                "updatedAt": 20
            }},
            "updatedAt": 30
        });
        write_stored_schema(&dir, &stored);
        let supervisor = supervisor_at(&dir);
        assert!(
            supervisor
                .chat_provider_options(ProviderId::Claude)
                .catalog_stale
        );

        // 목록을 하나도 넘기지 않은 보존형 호출.
        let options = supervisor
            .propose_chat_settings_schema(ProviderId::Claude, None, None, None)
            .expect("a no-difference proposal is accepted");
        assert!(!options.catalog_stale);
        // 선택지는 그대로 남고 CLI 버전만 지금 설치된 값으로 다시 새겨진다.
        assert_eq!(options.models.len(), 1);
        assert_eq!(
            options
                .supported_reasoning_efforts
                .iter()
                .map(|option| option.effort.as_str().to_owned())
                .collect::<Vec<_>>(),
            vec!["high"]
        );
        let reloaded = load_schema_overrides(dir.path());
        assert_eq!(
            reloaded.catalogs["claude"].cli_version.as_deref(),
            Some("2.2.0")
        );
        assert_eq!(reloaded.catalogs["claude"].models.len(), 1);
        // 다시 읽어도 재조사 대상이 아니다 — 같은 버전에서 요청이 재발하지 않는다.
        assert!(!load_chat_provider_options(ProviderId::Claude, Some(dir.path())).catalog_stale);
    }

    /// 유지할 제안도 새 제안도 없는 호출은 '차이 없음'이 아니다. 항목 제안만 담긴 호출은
    /// 그대로 저장하되 카탈로그는 재조사 대상으로 남기고, 아무것도 담기지 않은 호출은
    /// 확인할 대상이 없다고 알린다.
    #[test]
    fn a_proposal_without_any_catalog_is_not_treated_as_confirmed() {
        let dir = schema_dir();
        let supervisor = supervisor_at(&dir);
        let fields = vec![ChatSettingField {
            key: "mode".to_owned(),
            label: "실행 모드".to_owned(),
            detail: None,
            kind: ChatSettingFieldKind::Enum,
            options: vec![setting_option("plan", "읽기 전용", "분석만", false)],
            default_value: Some("plan".to_owned()),
        }];
        // 항목 제안은 저장되지만, 카탈로그는 확인되지 않아 재조사 대상으로 남는다.
        let options = supervisor
            .propose_chat_settings_schema(ProviderId::Claude, Some(fields), None, None)
            .expect("a field-only proposal is stored");
        assert!(options.catalog_stale);
        let saved = load_schema_overrides(dir.path());
        assert!(saved.providers.contains_key("claude"));
        assert!(saved.catalogs.is_empty());

        // 아무것도 담기지 않은 호출은 확인할 제안이 없다는 것을 오류로 알린다.
        let error = supervisor
            .propose_chat_settings_schema(ProviderId::Claude, None, None, None)
            .expect_err("an empty call has nothing to confirm");
        assert!(error.to_string().contains("확인할 기존 제안"));
        assert!(load_schema_overrides(dir.path()).catalogs.is_empty());

        // CLI가 모델 목록을 직접 내보내는 공급자는 제안이 필요 없어 그대로 통과한다.
        supervisor
            .propose_chat_settings_schema(ProviderId::Codex, None, None, None)
            .expect("codex needs no catalog proposal");
    }

    /// 조사 기록은 AIA 제안과 겹치지 않고, 제안이 있으면 제안이 이긴다.
    #[test]
    fn discovered_schema_and_proposed_override_are_stored_separately() {
        let dir = schema_dir();
        let stored = json!({
            "discovered": {"claude": {
                "fields": [
                    {"key": "mode", "label": "실행 모드", "kind": "enum",
                     "options": [
                        {"value": "plan", "label": "읽기 전용"},
                        {"value": "workspace", "label": "작업공간 쓰기"}
                     ],
                     "defaultValue": "workspace"},
                    {"key": "approvalMode", "label": "승인 처리", "kind": "enum",
                     "options": [{"value": "manual", "label": "직접 승인"}],
                     "defaultValue": "manual"}
                ],
                "cliVersion": "2.1.233",
                "executablePath": "/usr/local/bin/claude",
                "updatedAt": 20
            }},
            "updatedAt": 10
        });
        write_stored_schema(&dir, &stored);

        // 조사 결과는 항목 삭제까지 반영한다 (fallbackModel이 사라짐).
        let fields = merged_setting_fields(ProviderId::Claude, Some(dir.path()));
        assert_eq!(
            fields
                .iter()
                .map(|field| field.key.as_str())
                .collect::<Vec<_>>(),
            vec!["mode", "approvalMode"]
        );
        // 갱신 시각은 제안과 조사 중 더 최근 것.
        assert_eq!(
            schema_overrides_updated_at(ProviderId::Claude, Some(dir.path())),
            Some(20)
        );
        // 조사 기록이 없는 공급자는 내장 스키마를 그대로 쓴다.
        assert_eq!(
            merged_setting_fields(ProviderId::Codex, Some(dir.path())),
            provider_setting_fields(ProviderId::Codex)
        );

        // AIA 제안은 조사 결과 위에 덧입혀지고, 조사 기록을 덮어쓰지 않는다.
        let supervisor = supervisor_at(&dir);
        let proposed = vec![ChatSettingField {
            key: "mode".to_owned(),
            label: "실행 모드".to_owned(),
            detail: None,
            kind: ChatSettingFieldKind::Enum,
            options: vec![setting_option("plan", "읽기 전용", "분석만", false)],
            default_value: Some("plan".to_owned()),
        }];
        let options = supervisor
            .propose_chat_settings_schema(ProviderId::Claude, Some(proposed), None, None)
            .expect("proposal is accepted");
        let mode = options
            .settings
            .iter()
            .find(|field| field.key == "mode")
            .expect("mode field");
        assert_eq!(mode.options.len(), 1);
        assert!(options
            .settings
            .iter()
            .any(|field| field.key == "approvalMode"));
        let reloaded = load_schema_overrides(dir.path());
        assert!(reloaded.discovered.contains_key("claude"));
        assert_eq!(
            reloaded.discovered["claude"].cli_version.as_deref(),
            Some("2.1.233")
        );
    }

    #[test]
    fn omitted_fields_keep_the_existing_proposal_and_empty_fields_remove_it() {
        let dir = schema_dir();
        let supervisor = supervisor_at(&dir);
        let proposed = vec![ChatSettingField {
            key: "mode".to_owned(),
            label: "실행 모드".to_owned(),
            detail: None,
            kind: ChatSettingFieldKind::Enum,
            options: vec![setting_option("plan", "읽기 전용", "분석만", false)],
            default_value: Some("plan".to_owned()),
        }];
        supervisor
            .propose_chat_settings_schema(ProviderId::Claude, Some(proposed), None, None)
            .expect("field proposal");
        // Claude는 모델 제안이 있어야 '차이 없음' 호출이 확인으로 받아들여진다.
        supervisor
            .propose_chat_settings_schema(
                ProviderId::Claude,
                None,
                Some(vec![ChatModelOption {
                    model: "claude-fable-5".to_owned(),
                    display_name: "Fable 5".to_owned(),
                    description: String::new(),
                    is_default: true,
                    default_reasoning_effort: None,
                    supported_reasoning_efforts: Vec::new(),
                }]),
                None,
            )
            .expect("model proposal");

        let retained = supervisor
            .propose_chat_settings_schema(ProviderId::Claude, None, None, None)
            .expect("omitted fields retain the proposal");
        assert_eq!(
            retained
                .settings
                .iter()
                .find(|field| field.key == "mode")
                .expect("mode field")
                .options
                .len(),
            1
        );
        assert!(load_schema_overrides(dir.path())
            .providers
            .contains_key("claude"));

        let cleared = supervisor
            .propose_chat_settings_schema(ProviderId::Claude, Some(Vec::new()), None, None)
            .expect("empty fields remove the proposal");
        assert_eq!(
            cleared
                .settings
                .iter()
                .find(|field| field.key == "mode")
                .expect("mode field")
                .options
                .len(),
            6
        );
        assert!(!load_schema_overrides(dir.path())
            .providers
            .contains_key("claude"));
    }

    /// 실제 실행 파일을 조사해 스키마가 갱신되고, 같은 버전이면 재조사를 건너뛴다.
    #[test]
    #[cfg(unix)]
    fn probing_a_fixture_cli_updates_and_then_reuses_the_stored_schema() {
        use std::os::unix::fs::PermissionsExt;

        let dir = schema_dir();
        let script = dir.path().join("fake-codex");
        // danger-full-access를 없앤 Codex 도움말. 전체 접근 선택지가 사라져야 한다.
        fs::write(
            &script,
            "#!/bin/sh\ncat <<'HELP'\nOptions:\n  -s, --sandbox <SANDBOX_MODE>\n          Sandbox policy\n\n          [possible values: read-only, workspace-write]\n\n  -a, --ask-for-approval <APPROVAL_POLICY>\n          Approval policy\n\n          [possible values: on-request, never]\n\n  -m, --model <MODEL>\n          Model\n\n  -h, --help\n          Print help\nHELP\n",
        )
        .expect("fixture");
        let mut permissions = fs::metadata(&script).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&script, permissions).expect("권한");

        let supervisor = supervisor_at(&dir);
        assert!(supervisor
            .refresh_discovered_chat_settings_schema(
                ProviderId::Codex,
                Some(&script),
                Some("0.146.0"),
                false,
            )
            .expect("probe succeeds"));

        let fields = merged_setting_fields(ProviderId::Codex, Some(dir.path()));
        let mode = fields
            .iter()
            .find(|field| field.key == "mode")
            .expect("mode field");
        assert!(!mode
            .options
            .iter()
            .any(|option| option.value == "fullAccess"));
        assert!(schema_overrides_updated_at(ProviderId::Codex, Some(dir.path())).is_some());

        // 같은 실행 파일·같은 버전이면 다시 조사하지 않는다.
        assert!(!supervisor
            .refresh_discovered_chat_settings_schema(
                ProviderId::Codex,
                Some(&script),
                Some("0.146.0"),
                false,
            )
            .expect("skips reprobing"));
        // 버전이 바뀌면 다시 조사한다. 결과가 같아도 조사 대상 버전은 최신으로 맞춘다.
        assert!(supervisor
            .refresh_discovered_chat_settings_schema(
                ProviderId::Codex,
                Some(&script),
                Some("0.147.0"),
                false,
            )
            .expect("reprobes on a new version"));
    }

    /// CLI가 사라지면 조사 기록을 지워 내장 스키마로 돌아간다.
    #[test]
    fn losing_the_cli_clears_the_discovered_schema() {
        let dir = schema_dir();
        let stored = json!({
            "discovered": {"claude": {
                "fields": [
                    {"key": "mode", "label": "실행 모드", "kind": "enum",
                     "options": [{"value": "plan", "label": "읽기 전용"}],
                     "defaultValue": "plan"}
                ],
                "cliVersion": "2.1.233",
                "executablePath": "/usr/local/bin/claude",
                "updatedAt": 20
            }}
        });
        write_stored_schema(&dir, &stored);
        let supervisor = supervisor_at(&dir);
        assert!(supervisor
            .refresh_discovered_chat_settings_schema(ProviderId::Claude, None, None, false)
            .expect("clearing succeeds"));
        assert_eq!(
            merged_setting_fields(ProviderId::Claude, Some(dir.path())),
            provider_setting_fields(ProviderId::Claude)
        );
        // 지울 것이 없으면 파일을 다시 쓰지 않는다.
        assert!(!supervisor
            .refresh_discovered_chat_settings_schema(ProviderId::Claude, None, None, false)
            .expect("no-op succeeds"));
    }

    #[test]
    fn provider_setting_fields_gate_auto_review_to_codex() {
        for source in [ProviderId::Claude, ProviderId::Antigravity] {
            let fields = provider_setting_fields(source);
            let approval = fields
                .iter()
                .find(|field| field.key == "approvalMode")
                .expect("approvalMode field");
            let auto_review = approval
                .options
                .iter()
                .find(|option| option.value == "autoReview")
                .expect("autoReview option");
            assert!(auto_review.disabled);
            assert_eq!(approval.default_value.as_deref(), Some("manual"));
        }

        let fields = provider_setting_fields(ProviderId::Codex);
        let approval = fields
            .iter()
            .find(|field| field.key == "approvalMode")
            .expect("approvalMode field");
        let auto_review = approval
            .options
            .iter()
            .find(|option| option.value == "autoReview")
            .expect("autoReview option");
        assert!(!auto_review.disabled);
        assert_eq!(approval.default_value.as_deref(), Some("autoReview"));

        let mode = fields
            .iter()
            .find(|field| field.key == "mode")
            .expect("mode field");
        assert_eq!(mode.options.len(), 3);
        assert_eq!(mode.default_value.as_deref(), Some("workspace"));

        let claude_mode = provider_setting_fields(ProviderId::Claude)
            .into_iter()
            .find(|field| field.key == "mode")
            .expect("Claude mode field");
        assert_eq!(
            claude_mode
                .options
                .iter()
                .map(|option| option.value.as_str())
                .collect::<Vec<_>>(),
            vec![
                "plan",
                "workspace",
                "fullAccess",
                "auto",
                "dontAsk",
                "manual"
            ]
        );
        assert!(approval
            .options
            .iter()
            .any(|option| option.value == "granular"));
        assert!(approval
            .options
            .iter()
            .any(|option| option.value == "onFailure"));
    }

    #[test]
    fn schema_proposals_accept_the_new_builtin_provider_values() {
        let field_with = |source: ProviderId, key: &str, values: &[&str]| {
            let mut field = provider_setting_fields(source)
                .into_iter()
                .find(|field| field.key == key)
                .expect("built-in field");
            field
                .options
                .retain(|option| values.contains(&option.value.as_str()));
            field.default_value = values.first().map(|value| (*value).to_owned());
            field
        };
        validate_schema_fields(
            ProviderId::Claude,
            &[field_with(
                ProviderId::Claude,
                "mode",
                &["auto", "dontAsk", "manual"],
            )],
        )
        .expect("Claude permission mode subset");
        validate_schema_fields(
            ProviderId::Codex,
            &[field_with(
                ProviderId::Codex,
                "approvalMode",
                &["granular", "onFailure"],
            )],
        )
        .expect("Codex approval mode subset");
    }

    #[test]
    fn antigravity_hides_the_approval_setting_it_cannot_deliver() {
        let dir = tempfile::tempdir().expect("app data");
        let fields = merged_setting_fields(ProviderId::Antigravity, Some(dir.path()));
        assert!(fields.iter().any(|field| field.key == "mode"));
        assert!(!fields.iter().any(|field| field.key == "approvalMode"));

        for source in [ProviderId::Claude, ProviderId::Codex] {
            let fields = merged_setting_fields(source, Some(dir.path()));
            assert!(fields.iter().any(|field| field.key == "approvalMode"));
        }
    }

    #[test]
    fn parse_antigravity_models_reads_tsv_lines() {
        let stdout = "gemini-3.1-pro-high\tGemini 3.1 Pro (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
        let models = parse_antigravity_models(stdout);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].model, "gemini-3.1-pro-high");
        assert_eq!(models[0].display_name, "Gemini 3.1 Pro (High)");
        assert!(!models[0].is_default);
        assert!(models[0].supported_reasoning_efforts.is_empty());
        assert_eq!(models[1].model, "claude-sonnet-4-6");
    }

    #[test]
    fn parse_antigravity_models_skips_noise_lines() {
        // 탭 없는 안내 문구, 빈 조각, 공백 줄은 모델이 아니다.
        let stdout = "Fetching available models...\n\t\n \tname-only\nid-only\t \ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n";
        let models = parse_antigravity_models(stdout);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].model, "gemini-3.1-pro-low");
    }

    #[test]
    fn parse_antigravity_models_handles_empty_output() {
        assert!(parse_antigravity_models("").is_empty());
    }

    #[test]
    fn stored_dynamic_settings_keep_only_whitelisted_entries() {
        let stored = BTreeMap::from([
            ("fallbackModel".to_owned(), " claude-sonnet-5 ".to_owned()),
            ("unknownFlag".to_owned(), "value".to_owned()),
            ("blank".to_owned(), "   ".to_owned()),
        ]);
        assert_eq!(
            retained_dynamic_settings(ProviderId::Claude, &stored),
            BTreeMap::from([("fallbackModel".to_owned(), "claude-sonnet-5".to_owned())])
        );
        // Codex has no dynamic settings, so a stored Claude-only entry must not survive.
        assert!(retained_dynamic_settings(ProviderId::Codex, &stored).is_empty());
        assert!(retained_dynamic_settings(
            ProviderId::Claude,
            &BTreeMap::from([("fallbackModel".to_owned(), "bad model!".to_owned())])
        )
        .is_empty());
    }

    #[test]
    fn dynamic_settings_are_whitelisted_and_validated() {
        let mut settings = BTreeMap::new();
        settings.insert("fallbackModel".to_owned(), "claude-sonnet-5".to_owned());
        let validated = validate_dynamic_settings(ProviderId::Claude, &settings)
            .expect("fallbackModel is whitelisted for Claude");
        assert_eq!(
            validated.get("fallbackModel").map(String::as_str),
            Some("claude-sonnet-5")
        );

        // 화이트리스트에 없는 키는 오류로 드러난다 (조용한 무시 금지).
        let mut unknown = BTreeMap::new();
        unknown.insert("dangerouslySkipChecks".to_owned(), "true".to_owned());
        assert!(validate_dynamic_settings(ProviderId::Claude, &unknown).is_err());

        // 값 규칙(식별자 문자 집합) 위반도 오류.
        let mut invalid = BTreeMap::new();
        invalid.insert("fallbackModel".to_owned(), "bad value; rm -rf".to_owned());
        assert!(validate_dynamic_settings(ProviderId::Claude, &invalid).is_err());

        // Claude 전용 키는 다른 provider에서 거부된다.
        assert!(validate_dynamic_settings(ProviderId::Codex, &settings).is_err());

        // 빈 값은 "설정 안 함"으로 취급되어 통과하되 결과에서 빠진다.
        let mut empty = BTreeMap::new();
        empty.insert("fallbackModel".to_owned(), "  ".to_owned());
        let validated = validate_dynamic_settings(ProviderId::Claude, &empty)
            .expect("blank value clears the setting");
        assert!(validated.is_empty());
    }
}
