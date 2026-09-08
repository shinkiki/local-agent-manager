//! 선언형 AIA 선제 제안 팩 로더와 검증기.
//!
//! 앱에 포함된 기본 팩과 사용자가 선택한 공통 스킬 저장소만
//! 읽는다. 팩은 문구와 제한된 파라미터만 제공하며 코드·도구·네트워크 실행을
//! 표현할 수 없다.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(test)]
use serde_json::Value;
#[cfg(test)]
use std::path::PathBuf;

use crate::domain::wire_enum;
use crate::resource_repository::repository_skills_root;
use crate::skill_library::validate_skill_key;
use crate::CoreError;

const SCHEMA_VERSION: u32 = 1;
#[cfg(test)]
const COMMON_ROOT_RELATIVE: &str = ".agents/skills";
const MANIFEST_RELATIVE: &str = "references/aia-suggestions.json";
const MAX_PACK_BYTES: u64 = 64 * 1024;
const MAX_TOTAL_DEFINITIONS: usize = 100;
const MAX_TITLE_CHARS: usize = 80;
const MAX_DETAIL_CHARS: usize = 240;
const MAX_PROMPT_CHARS: usize = 1_000;
const BUNDLED_SKILL_KEY: &str = "aia-proactive-suggestions";
const BUNDLED_SKILL_NAME: &str = "aia-proactive-suggestions";
const BUNDLED_SKILL_DESCRIPTION: &str =
    "AIA가 앱 상태를 바탕으로 안전한 선제 제안을 만드는 선언형 규칙 모음";
const BUNDLED_SKILL_MD: &str = include_str!("../assets/aia-proactive-suggestions/SKILL.md");
const BUNDLED_MANIFEST: &str =
    include_str!("../assets/aia-proactive-suggestions/references/aia-suggestions.json");

/// 같은 프로세스에서 공통 팩 파일이 일시적으로 손상됐을 때 사용하는 마지막 정상본.
/// 홈 경로까지 키에 포함해 테스트·복수 사용자 환경의 캐시가 섞이지 않게 한다.
static LAST_KNOWN_GOOD: OnceLock<Mutex<HashMap<String, AiaSuggestionPack>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiaSuggestionKind {
    ProviderCliMissing,
    AccountAuthError,
    /// 폐기된 종류. 사용량은 사이드바 계량기로 이미 보이므로 제안하지 않는다.
    /// 기존 설치본 팩이 계속 검증을 통과하도록 파싱만 남기고 로드 시 걸러낸다.
    AccountUsageThreshold,
    AccountAutoSwitchMissing,
    SchedulerPaused,
    ScheduleRunFailed,
    TranslationFailed,
    ProjectSessionCleanup,
    InterruptedSessionReminder,
    /// 공통 스킬 원본의 내용 지문이 바뀐 직후 변경 검토를 제안하는 즉시 트리거.
    SkillContentChanged,
    FeatureTip,
}

wire_enum!(trimmed AiaSuggestionKind, "알 수 없는 AIA 제안 종류입니다", {
    ProviderCliMissing => "providerCliMissing",
    AccountAuthError => "accountAuthError",
    AccountUsageThreshold => "accountUsageThreshold",
    AccountAutoSwitchMissing => "accountAutoSwitchMissing",
    SchedulerPaused => "schedulerPaused",
    ScheduleRunFailed => "scheduleRunFailed",
    TranslationFailed => "translationFailed",
    ProjectSessionCleanup => "projectSessionCleanup",
    InterruptedSessionReminder => "interruptedSessionReminder",
    SkillContentChanged => "skillContentChanged",
    FeatureTip => "featureTip",
});

impl AiaSuggestionKind {
    #[cfg(test)]
    pub const ALL: [Self; 11] = [
        Self::ProviderCliMissing,
        Self::AccountAuthError,
        Self::AccountUsageThreshold,
        Self::AccountAutoSwitchMissing,
        Self::SchedulerPaused,
        Self::ScheduleRunFailed,
        Self::TranslationFailed,
        Self::ProjectSessionCleanup,
        Self::InterruptedSessionReminder,
        Self::SkillContentChanged,
        Self::FeatureTip,
    ];

    /// 폐기된 제안 종류인지 여부. 사용량 임계치 제안은 사이드바 계량기로 대체되어 폐기됨.
    pub fn is_deprecated(self) -> bool {
        matches!(self, Self::AccountUsageThreshold)
    }

    /// 현재 유효하게 지원되는 제안 종류인지 여부.
    pub fn is_supported(self) -> bool {
        !self.is_deprecated()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiaSuggestionSeverity {
    Info,
    Warning,
    Error,
}

wire_enum!(trimmed AiaSuggestionSeverity, "알 수 없는 AIA 제안 심각도입니다. info|warning|error 중 하나를 쓰세요", {
    Info => "info",
    Warning => "warning",
    Error => "error",
});

impl AiaSuggestionSeverity {
    #[cfg(test)]
    pub const ALL: [Self; 3] = [Self::Info, Self::Warning, Self::Error];
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AiaSuggestionParameterValue {
    Number(serde_json::Number),
    String(String),
    Bool(bool),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaSuggestionRearm {
    #[serde(default)]
    pub after_resolved: bool,
    #[serde(default)]
    pub cooldown_minutes: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaSuggestionDefinition {
    pub id: String,
    pub kind: AiaSuggestionKind,
    pub enabled: bool,
    pub severity: AiaSuggestionSeverity,
    pub priority: i32,
    pub title_template: String,
    pub detail_template: String,
    pub prompt_template: String,
    pub parameters: BTreeMap<String, AiaSuggestionParameterValue>,
    pub rearm: AiaSuggestionRearm,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiaSuggestionPack {
    pub schema_version: u32,
    pub pack_id: String,
    pub version: String,
    pub display_name: String,
    pub suggestions: Vec<AiaSuggestionDefinition>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiaSuggestionPackSource {
    Bundled,
    CommonSkill,
    LastKnownGood,
}

wire_enum!(trimmed AiaSuggestionPackSource, "알 수 없는 AIA 제안 팩 출처입니다. bundled|commonSkill|lastKnownGood 중 하나를 쓰세요", {
    Bundled => "bundled",
    CommonSkill => "commonSkill",
    LastKnownGood => "lastKnownGood",
});

impl AiaSuggestionPackSource {
    #[cfg(test)]
    pub const ALL: [Self; 3] = [Self::Bundled, Self::CommonSkill, Self::LastKnownGood];
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaSuggestionEffectivePack {
    pub source: AiaSuggestionPackSource,
    pub skill_key: Option<String>,
    pub pack: AiaSuggestionPack,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaSuggestionCatalogDefinition {
    pub pack_id: String,
    pub pack_display_name: String,
    pub skill_key: Option<String>,
    pub definition: AiaSuggestionDefinition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaSuggestionCatalogIssue {
    pub skill_key: String,
    pub message: String,
    pub using_last_known_good: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaSuggestionTemplateFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaSuggestionBundledSkillTemplate {
    pub key: String,
    pub name: String,
    pub description: String,
    pub files: Vec<AiaSuggestionTemplateFile>,
    pub installed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiaSuggestionCatalog {
    pub content_digest: String,
    pub packs: Vec<AiaSuggestionEffectivePack>,
    pub definitions: Vec<AiaSuggestionCatalogDefinition>,
    pub issues: Vec<AiaSuggestionCatalogIssue>,
    pub bundled_skill: AiaSuggestionBundledSkillTemplate,
}

pub fn load_aia_suggestion_catalog(app_data_dir: &Path) -> Result<AiaSuggestionCatalog, CoreError> {
    let root = repository_skills_root(app_data_dir);
    load_aia_suggestion_catalog_from_root(&root, &root)
}

#[cfg(test)]
pub(crate) fn load_aia_suggestion_catalog_from_home(
    home: &Path,
) -> Result<AiaSuggestionCatalog, CoreError> {
    let common_root = home.join(COMMON_ROOT_RELATIVE);
    load_aia_suggestion_catalog_from_root(home, &common_root)
}

fn load_aia_suggestion_catalog_from_root(
    cache_root: &Path,
    common_root: &Path,
) -> Result<AiaSuggestionCatalog, CoreError> {
    let bundled = parse_and_validate_pack(BUNDLED_MANIFEST.as_bytes(), "번들 기본 팩")?;
    let mut effective = BTreeMap::new();
    effective.insert(
        bundled.pack_id.clone(),
        AiaSuggestionEffectivePack {
            source: AiaSuggestionPackSource::Bundled,
            skill_key: None,
            pack: bundled,
        },
    );

    let mut issues = Vec::new();
    if common_root.exists() {
        load_common_packs(cache_root, common_root, &mut effective, &mut issues)?;
    }

    let packs: Vec<_> = effective.into_values().collect();
    let definitions = packs
        .iter()
        .flat_map(|entry| {
            entry.pack.suggestions.iter().cloned().map(|definition| {
                AiaSuggestionCatalogDefinition {
                    pack_id: entry.pack.pack_id.clone(),
                    pack_display_name: entry.pack.display_name.clone(),
                    skill_key: entry.skill_key.clone(),
                    definition,
                }
            })
        })
        .collect::<Vec<_>>();
    let content_digest = digest_effective_packs(&packs)?;
    let bundled_path = common_root.join(BUNDLED_SKILL_KEY);

    Ok(AiaSuggestionCatalog {
        content_digest,
        packs,
        definitions,
        issues,
        bundled_skill: AiaSuggestionBundledSkillTemplate {
            key: BUNDLED_SKILL_KEY.to_owned(),
            name: BUNDLED_SKILL_NAME.to_owned(),
            description: BUNDLED_SKILL_DESCRIPTION.to_owned(),
            files: vec![
                AiaSuggestionTemplateFile {
                    path: "SKILL.md".to_owned(),
                    content: BUNDLED_SKILL_MD.to_owned(),
                },
                AiaSuggestionTemplateFile {
                    path: MANIFEST_RELATIVE.to_owned(),
                    content: BUNDLED_MANIFEST.to_owned(),
                },
            ],
            installed: fs::symlink_metadata(bundled_path).is_ok(),
        },
    })
}

fn load_common_packs(
    home: &Path,
    common_root: &Path,
    effective: &mut BTreeMap<String, AiaSuggestionEffectivePack>,
    issues: &mut Vec<AiaSuggestionCatalogIssue>,
) -> Result<(), CoreError> {
    let canonical_root = fs::canonicalize(common_root)?;
    let mut entries = fs::read_dir(common_root)?.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let directory = entry.path();
        let key = entry.file_name().to_string_lossy().into_owned();
        let manifest = directory.join(MANIFEST_RELATIVE);
        if fs::symlink_metadata(&manifest).is_err() {
            continue;
        }

        let candidate = load_common_pack(&canonical_root, &directory, &key);
        let (pack, source, had_error) = match candidate {
            Ok(pack) => (Some(pack), AiaSuggestionPackSource::CommonSkill, None),
            Err(error) => {
                let cached = cached_pack(home, &key);
                let using_last_known_good = cached.is_some();
                issues.push(AiaSuggestionCatalogIssue {
                    skill_key: key.clone(),
                    message: error.to_string(),
                    using_last_known_good,
                });
                (cached, AiaSuggestionPackSource::LastKnownGood, Some(error))
            }
        };
        let Some(pack) = pack else {
            continue;
        };

        let proposed_count = effective_definition_count_after_insert(effective, &pack);
        if proposed_count > MAX_TOTAL_DEFINITIONS {
            if had_error.is_none() {
                let fallback = cached_pack(home, &key).filter(|cached| {
                    effective_definition_count_after_insert(effective, cached)
                        <= MAX_TOTAL_DEFINITIONS
                });
                issues.push(AiaSuggestionCatalogIssue {
                    skill_key: key.clone(),
                    message: format!("유효 제안은 전체 {MAX_TOTAL_DEFINITIONS}개까지 허용됩니다"),
                    using_last_known_good: fallback.is_some(),
                });
                if let Some(fallback) = fallback {
                    effective.insert(
                        fallback.pack_id.clone(),
                        AiaSuggestionEffectivePack {
                            source: AiaSuggestionPackSource::LastKnownGood,
                            skill_key: Some(key),
                            pack: fallback,
                        },
                    );
                }
            }
            continue;
        }

        if source == AiaSuggestionPackSource::CommonSkill {
            cache_pack(home, &key, &pack);
        }
        effective.insert(
            pack.pack_id.clone(),
            AiaSuggestionEffectivePack {
                source,
                skill_key: Some(key),
                pack,
            },
        );
    }
    Ok(())
}

fn load_common_pack(
    canonical_root: &Path,
    directory: &Path,
    key: &str,
) -> Result<AiaSuggestionPack, CoreError> {
    validate_skill_key(key)?;
    let directory_meta = fs::symlink_metadata(directory)?;
    if directory_meta.file_type().is_symlink() || !directory_meta.is_dir() {
        return Err(CoreError::InvalidInput(
            "AIA 제안 팩 스킬 디렉터리는 실제 디렉터리여야 합니다".to_owned(),
        ));
    }
    let canonical_directory = fs::canonicalize(directory)?;
    if canonical_directory.parent() != Some(canonical_root) {
        return Err(CoreError::InvalidInput(
            "AIA 제안 팩 경로가 공통 스킬 루트를 벗어났습니다".to_owned(),
        ));
    }

    let references = directory.join("references");
    let references_metadata = fs::symlink_metadata(&references)?;
    if references_metadata.file_type().is_symlink() || !references_metadata.is_dir() {
        return Err(CoreError::InvalidInput(
            "AIA 제안 팩 references는 실제 디렉터리여야 합니다".to_owned(),
        ));
    }
    let manifest = directory.join(MANIFEST_RELATIVE);
    let metadata = fs::symlink_metadata(&manifest)?;
    if metadata.file_type().is_symlink() {
        return Err(CoreError::InvalidInput(
            "AIA 제안 팩 manifest는 심볼릭 링크일 수 없습니다".to_owned(),
        ));
    }
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "AIA 제안 팩 manifest가 일반 파일이 아닙니다".to_owned(),
        ));
    }
    if metadata.len() > MAX_PACK_BYTES {
        return Err(CoreError::TooLarge(MAX_PACK_BYTES));
    }
    let canonical_manifest = fs::canonicalize(&manifest)?;
    if !canonical_manifest.starts_with(&canonical_directory) {
        return Err(CoreError::InvalidInput(
            "AIA 제안 팩 manifest 경로가 스킬 디렉터리를 벗어났습니다".to_owned(),
        ));
    }
    let bytes = fs::read(canonical_manifest)?;
    parse_and_validate_pack(&bytes, key)
}

fn parse_and_validate_pack(bytes: &[u8], source: &str) -> Result<AiaSuggestionPack, CoreError> {
    if bytes.len() as u64 > MAX_PACK_BYTES {
        return Err(CoreError::TooLarge(MAX_PACK_BYTES));
    }
    let mut pack: AiaSuggestionPack = serde_json::from_slice(bytes).map_err(|error| {
        CoreError::InvalidInput(format!(
            "'{source}' AIA 제안 팩 JSON이 올바르지 않습니다: {error}"
        ))
    })?;
    validate_pack(&pack, source)?;
    // 폐기된 종류는 팩 전체를 무효로 만들지 않고 조용히 제외한다.
    pack.suggestions
        .retain(|definition| definition.kind.is_supported());
    Ok(pack)
}

fn validate_pack(pack: &AiaSuggestionPack, source: &str) -> Result<(), CoreError> {
    if pack.schema_version != SCHEMA_VERSION {
        return invalid_pack(
            source,
            format!("schemaVersion은 {SCHEMA_VERSION}이어야 합니다"),
        );
    }
    validate_identifier(&pack.pack_id, "packId", source)?;
    validate_nonempty_limited(&pack.version, "version", 64, source)?;
    validate_nonempty_limited(&pack.display_name, "displayName", 120, source)?;
    if pack.suggestions.len() > MAX_TOTAL_DEFINITIONS {
        return invalid_pack(
            source,
            format!("제안은 팩당 {MAX_TOTAL_DEFINITIONS}개까지 허용됩니다"),
        );
    }

    let mut ids = BTreeSet::new();
    for definition in &pack.suggestions {
        validate_identifier(&definition.id, "suggestion.id", source)?;
        if !ids.insert(definition.id.as_str()) {
            return invalid_pack(source, format!("중복 제안 ID: {}", definition.id));
        }
        if !(-1_000..=1_000).contains(&definition.priority) {
            return invalid_pack(
                source,
                format!("{} priority 범위는 -1000~1000입니다", definition.id),
            );
        }
        validate_template(
            &definition.title_template,
            "titleTemplate",
            MAX_TITLE_CHARS,
            source,
        )?;
        validate_template(
            &definition.detail_template,
            "detailTemplate",
            MAX_DETAIL_CHARS,
            source,
        )?;
        validate_template(
            &definition.prompt_template,
            "promptTemplate",
            MAX_PROMPT_CHARS,
            source,
        )?;
        if definition
            .rearm
            .cooldown_minutes
            .is_some_and(|value| value > 525_600)
        {
            return invalid_pack(source, "rearm.cooldownMinutes는 525600 이하여야 합니다");
        }
        validate_parameters(definition, source)?;
    }
    Ok(())
}

fn validate_parameters(
    definition: &AiaSuggestionDefinition,
    source: &str,
) -> Result<(), CoreError> {
    use AiaSuggestionKind::*;
    let allowed: &[(&str, ParameterRule)] = match definition.kind {
        ProviderCliMissing | AccountAuthError | SchedulerPaused => &[],
        AccountUsageThreshold => &[("thresholdPercent", ParameterRule::Number(1.0, 100.0))],
        AccountAutoSwitchMissing => &[("minAccounts", ParameterRule::Integer(2, 100))],
        ScheduleRunFailed => &[("lookbackHours", ParameterRule::Integer(1, 720))],
        TranslationFailed => &[("minFailureCount", ParameterRule::Integer(1, 1_000))],
        ProjectSessionCleanup => &[
            ("minSessions", ParameterRule::Integer(1, 10_000)),
            ("minUnfiled", ParameterRule::Integer(1, 10_000)),
            ("minUnfiledRatio", ParameterRule::Number(0.0, 1.0)),
            ("rearmDelta", ParameterRule::Integer(1, 10_000)),
        ],
        InterruptedSessionReminder => &[
            ("delayMinutes", ParameterRule::Integer(1, 43_200)),
            ("expiresDays", ParameterRule::Integer(1, 365)),
        ],
        SkillContentChanged => &[
            ("expiresHours", ParameterRule::Integer(1, 720)),
            ("maxResults", ParameterRule::Integer(1, 10)),
        ],
        FeatureTip => &[
            ("featureId", ParameterRule::NonemptyString(64)),
            ("oncePerVersion", ParameterRule::Bool),
        ],
    };

    for (key, value) in &definition.parameters {
        let Some((_, rule)) = allowed.iter().find(|(allowed_key, _)| *allowed_key == key) else {
            return invalid_pack(
                source,
                format!(
                    "{} kind에는 parameters.{key}를 사용할 수 없습니다",
                    definition.id
                ),
            );
        };
        if !rule.matches(value) {
            return invalid_pack(
                source,
                format!(
                    "{}.parameters.{key} 값의 형식이나 범위가 올바르지 않습니다",
                    definition.id
                ),
            );
        }
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ParameterRule {
    Number(f64, f64),
    Integer(i64, i64),
    NonemptyString(usize),
    Bool,
}

impl ParameterRule {
    fn matches(self, value: &AiaSuggestionParameterValue) -> bool {
        match (self, value) {
            (Self::Number(min, max), AiaSuggestionParameterValue::Number(value)) => value
                .as_f64()
                .is_some_and(|number| number >= min && number <= max),
            (Self::Integer(min, max), AiaSuggestionParameterValue::Number(value)) => value
                .as_i64()
                .is_some_and(|number| number >= min && number <= max),
            (Self::NonemptyString(max), AiaSuggestionParameterValue::String(value)) => {
                !value.trim().is_empty() && value.chars().count() <= max
            }
            (Self::Bool, AiaSuggestionParameterValue::Bool(_)) => true,
            _ => false,
        }
    }
}

fn validate_template(
    value: &str,
    field: &str,
    max_chars: usize,
    source: &str,
) -> Result<(), CoreError> {
    validate_nonempty_limited(value, field, max_chars, source)?;
    let allowed = [
        "projectName",
        "projectPath",
        "sessionTitle",
        "providerName",
        "usagePercent",
        "scheduleName",
        "featureName",
        "translationTarget",
        "skillName",
    ];
    let mut remainder = value;
    while let Some(open) = remainder.find('{') {
        let after_open = &remainder[open + 1..];
        let Some(close) = after_open.find('}') else {
            return invalid_pack(source, format!("{field} 템플릿 괄호가 닫히지 않았습니다"));
        };
        let placeholder = &after_open[..close];
        if !allowed.contains(&placeholder) {
            return invalid_pack(
                source,
                format!("{field}에서 허용되지 않은 템플릿 변수: {placeholder}"),
            );
        }
        remainder = &after_open[close + 1..];
    }
    if remainder.contains('}') {
        return invalid_pack(source, format!("{field} 템플릿 괄호가 올바르지 않습니다"));
    }
    Ok(())
}

fn validate_identifier(value: &str, field: &str, source: &str) -> Result<(), CoreError> {
    let valid = !value.is_empty()
        && value.chars().count() <= 64
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit());
    if !valid {
        return invalid_pack(
            source,
            format!("{field}는 영소문자·숫자·하이픈으로 된 64자 이하 식별자여야 합니다"),
        );
    }
    Ok(())
}

fn validate_nonempty_limited(
    value: &str,
    field: &str,
    max_chars: usize,
    source: &str,
) -> Result<(), CoreError> {
    if value.trim().is_empty() {
        return invalid_pack(source, format!("{field} 값이 비어 있습니다"));
    }
    if value.chars().count() > max_chars {
        return invalid_pack(source, format!("{field}는 {max_chars}자까지 허용됩니다"));
    }
    if value.contains('\0') {
        return invalid_pack(source, format!("{field}에 허용되지 않은 문자가 있습니다"));
    }
    Ok(())
}

fn invalid_pack<T>(source: &str, message: impl Into<String>) -> Result<T, CoreError> {
    Err(CoreError::InvalidInput(format!(
        "'{source}' AIA 제안 팩: {}",
        message.into()
    )))
}

fn effective_definition_count_after_insert(
    effective: &BTreeMap<String, AiaSuggestionEffectivePack>,
    pack: &AiaSuggestionPack,
) -> usize {
    effective
        .iter()
        .filter(|(pack_id, _)| pack_id.as_str() != pack.pack_id)
        .map(|(_, entry)| entry.pack.suggestions.len())
        .sum::<usize>()
        + pack.suggestions.len()
}

fn digest_effective_packs(packs: &[AiaSuggestionEffectivePack]) -> Result<String, CoreError> {
    // 출처가 정상 파일에서 LKG로 바뀌어도 실제 평가 정의가 같으면 재평가할 필요가
    // 없으므로 팩 내용만 지문에 포함한다.
    let effective_content = packs.iter().map(|entry| &entry.pack).collect::<Vec<_>>();
    let encoded = serde_json::to_vec(&effective_content)?;
    let mut hasher = Sha256::new();
    hasher.update(encoded);
    Ok(format!("{:x}", hasher.finalize()))
}

fn cache_key(home: &Path, skill_key: &str) -> String {
    format!("{}\0{skill_key}", home.to_string_lossy())
}

fn cache_pack(home: &Path, skill_key: &str, pack: &AiaSuggestionPack) {
    let cache = LAST_KNOWN_GOOD.get_or_init(|| Mutex::new(HashMap::new()));
    cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(cache_key(home, skill_key), pack.clone());
}

fn cached_pack(home: &Path, skill_key: &str) -> Option<AiaSuggestionPack> {
    LAST_KNOWN_GOOD.get().and_then(|cache| {
        cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&cache_key(home, skill_key))
            .cloned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_pack(home: &Path, key: &str, content: &str) -> PathBuf {
        let references = home.join(COMMON_ROOT_RELATIVE).join(key).join("references");
        fs::create_dir_all(&references).expect("references");
        let manifest = references.join("aia-suggestions.json");
        fs::write(&manifest, content).expect("manifest");
        manifest
    }

    fn pack_json(pack_id: &str, suggestion_id: &str, title: &str) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "packId": pack_id,
            "version": "1.0.0",
            "displayName": "테스트 팩",
            "suggestions": [{
                "id": suggestion_id,
                "kind": "featureTip",
                "enabled": true,
                "severity": "info",
                "priority": 1,
                "titleTemplate": title,
                "detailTemplate": "설명",
                "promptTemplate": "요청 초안",
                "parameters": {"featureId": "test", "oncePerVersion": true},
                "rearm": {"afterResolved": false}
            }]
        })
        .to_string()
    }

    #[test]
    fn bundled_pack_is_valid_and_covers_every_active_kind() {
        let pack = parse_and_validate_pack(BUNDLED_MANIFEST.as_bytes(), "bundle").expect("pack");
        assert_eq!(pack.schema_version, 1);
        // featureTip만 정의가 둘이다(일반 안내, 리소스 단위 번역 안내). 나머지 종류는
        // 정의 하나씩이라 제안 수가 종류 수보다 하나 많다.
        assert_eq!(pack.suggestions.len(), 11);
        let kinds = pack
            .suggestions
            .iter()
            .map(|definition| definition.kind)
            .collect::<BTreeSet<_>>();
        assert_eq!(kinds.len(), 10);
        assert!(!kinds.contains(&AiaSuggestionKind::AccountUsageThreshold));

        let cleanup = pack
            .suggestions
            .iter()
            .find(|definition| definition.kind == AiaSuggestionKind::ProjectSessionCleanup)
            .expect("cleanup");
        assert_eq!(
            cleanup.parameters["minSessions"],
            AiaSuggestionParameterValue::Number(8.into())
        );
        assert_eq!(
            cleanup.parameters["minUnfiled"],
            AiaSuggestionParameterValue::Number(5.into())
        );
        assert_eq!(
            cleanup.parameters["rearmDelta"],
            AiaSuggestionParameterValue::Number(3.into())
        );

        let reminder = pack
            .suggestions
            .iter()
            .find(|definition| definition.kind == AiaSuggestionKind::InterruptedSessionReminder)
            .expect("reminder");
        assert_eq!(
            reminder.parameters["delayMinutes"],
            AiaSuggestionParameterValue::Number(30.into())
        );
        assert_eq!(
            reminder.parameters["expiresDays"],
            AiaSuggestionParameterValue::Number(7.into())
        );
        assert!(reminder.prompt_template.contains("초안만"));

        let skill_change = pack
            .suggestions
            .iter()
            .find(|definition| definition.kind == AiaSuggestionKind::SkillContentChanged)
            .expect("skill change");
        assert_eq!(
            skill_change.parameters["expiresHours"],
            AiaSuggestionParameterValue::Number(24.into())
        );
        assert_eq!(
            skill_change.parameters["maxResults"],
            AiaSuggestionParameterValue::Number(3.into())
        );
        assert!(skill_change.title_template.contains("{skillName}"));
        assert!(skill_change.prompt_template.contains("승인"));
    }

    /// 즉시 트리거는 검토 제안이므로 파라미터 범위를 벗어난 팩은 거부해야 한다.
    #[test]
    fn skill_change_kind_rejects_out_of_range_and_foreign_parameters() {
        let base: Value =
            serde_json::from_str(&pack_json("skill-pack", "skill-tip", "제목")).expect("json");
        let mut valid = base.clone();
        set_json_path(
            &mut valid,
            "suggestions.0.kind",
            Value::String("skillContentChanged".to_owned()),
        );
        set_json_path(
            &mut valid,
            "suggestions.0.parameters",
            serde_json::json!({"expiresHours": 6, "maxResults": 2}),
        );
        assert!(parse_and_validate_pack(&serde_json::to_vec(&valid).unwrap(), "valid").is_ok());

        for parameters in [
            serde_json::json!({"expiresHours": 0}),
            serde_json::json!({"maxResults": 11}),
            serde_json::json!({"featureId": "general"}),
        ] {
            let mut invalid = valid.clone();
            set_json_path(&mut invalid, "suggestions.0.parameters", parameters.clone());
            assert!(
                parse_and_validate_pack(&serde_json::to_vec(&invalid).unwrap(), "invalid").is_err(),
                "{parameters}"
            );
        }
    }

    /// 이미 배포된 설치본이 사용량 제안을 담고 있어도 팩 전체가 살아남고
    /// 폐기된 제안만 빠져야 한다.
    #[test]
    fn retired_usage_kind_is_dropped_without_invalidating_the_pack() {
        let mut pack: Value =
            serde_json::from_str(&pack_json("legacy-pack", "keep-tip", "유지 제목")).expect("json");
        let mut retired = pack["suggestions"][0].clone();
        retired["id"] = Value::String("account-usage-threshold".to_owned());
        retired["kind"] = Value::String("accountUsageThreshold".to_owned());
        retired["titleTemplate"] =
            Value::String("{providerName} 사용량 {usagePercent}%".to_owned());
        retired["parameters"] = serde_json::json!({"thresholdPercent": 70});
        pack["suggestions"]
            .as_array_mut()
            .expect("suggestions")
            .push(retired);

        let parsed =
            parse_and_validate_pack(&serde_json::to_vec(&pack).unwrap(), "legacy").expect("pack");
        assert_eq!(parsed.suggestions.len(), 1);
        assert_eq!(parsed.suggestions[0].id, "keep-tip");
    }

    #[test]
    fn common_pack_overrides_bundle_and_additional_pack_appends() {
        let temp = TempDir::new().expect("temp");
        write_pack(
            temp.path(),
            "override",
            &pack_json("agent-manager-default", "override-tip", "대체 제목"),
        );
        write_pack(
            temp.path(),
            "extra",
            &pack_json("extra-pack", "extra-tip", "추가 제목"),
        );

        let catalog = load_aia_suggestion_catalog_from_home(temp.path()).expect("catalog");
        assert_eq!(catalog.packs.len(), 2);
        assert_eq!(catalog.definitions.len(), 2);
        assert!(catalog
            .definitions
            .iter()
            .any(|entry| entry.definition.id == "override-tip"));
        assert!(catalog
            .definitions
            .iter()
            .any(|entry| entry.definition.id == "extra-tip"));
    }

    #[test]
    fn invalid_update_uses_last_known_good_and_reports_issue() {
        let temp = TempDir::new().expect("temp");
        let manifest = write_pack(
            temp.path(),
            "custom-pack",
            &pack_json("custom-pack", "custom-tip", "정상 제목"),
        );
        let first = load_aia_suggestion_catalog_from_home(temp.path()).expect("first");
        fs::write(manifest, "{ invalid").expect("break manifest");
        let second = load_aia_suggestion_catalog_from_home(temp.path()).expect("second");

        assert_eq!(first.content_digest, second.content_digest);
        assert_eq!(second.issues.len(), 1);
        assert!(second.issues[0].using_last_known_good);
        assert!(second.packs.iter().any(|entry| {
            entry.source == AiaSuggestionPackSource::LastKnownGood
                && entry.pack.pack_id == "custom-pack"
        }));
    }

    #[test]
    fn content_digest_changes_with_effective_content_but_not_invalid_update() {
        let temp = TempDir::new().expect("temp");
        let manifest = write_pack(
            temp.path(),
            "digest-pack",
            &pack_json("digest-pack", "digest-tip", "첫 제목"),
        );
        let first = load_aia_suggestion_catalog_from_home(temp.path()).expect("first");
        fs::write(
            &manifest,
            pack_json("digest-pack", "digest-tip", "둘째 제목"),
        )
        .expect("update");
        let second = load_aia_suggestion_catalog_from_home(temp.path()).expect("second");
        assert_ne!(first.content_digest, second.content_digest);
        fs::write(manifest, "[]").expect("invalid");
        let third = load_aia_suggestion_catalog_from_home(temp.path()).expect("third");
        assert_eq!(second.content_digest, third.content_digest);
    }

    #[test]
    fn total_definition_limit_reuses_the_previous_effective_pack() {
        let temp = TempDir::new().expect("temp");
        // 내장 팩과 사용자 팩 하나를 더해 상한을 정확히 채운다. 내장 제안이 늘어도
        // 이 시험이 상한 경계를 계속 겨냥하도록 개수를 여기서 계산한다.
        let bundled = parse_and_validate_pack(BUNDLED_MANIFEST.as_bytes(), "bundle")
            .expect("pack")
            .suggestions
            .len();
        let filler_count = MAX_TOTAL_DEFINITIONS - bundled - 1;
        let filler = serde_json::json!({
            "schemaVersion": 1,
            "packId": "filler-pack",
            "version": "1.0.0",
            "displayName": "채움 팩",
            "suggestions": (0..filler_count).map(|index| serde_json::json!({
                "id": format!("tip-{index}"),
                "kind": "featureTip",
                "enabled": true,
                "severity": "info",
                "priority": 1,
                "titleTemplate": "제목",
                "detailTemplate": "설명",
                "promptTemplate": "요청",
                "parameters": {},
                "rearm": {"afterResolved": false}
            })).collect::<Vec<_>>()
        })
        .to_string();
        write_pack(temp.path(), "a-filler", &filler);
        let custom_manifest = write_pack(
            temp.path(),
            "z-custom",
            &pack_json("custom-pack", "custom-tip", "정상 제목"),
        );
        let first = load_aia_suggestion_catalog_from_home(temp.path()).expect("first");
        assert_eq!(first.definitions.len(), 100);

        let mut expanded: Value =
            serde_json::from_str(&pack_json("custom-pack", "custom-tip", "변경 제목"))
                .expect("json");
        let second_definition = expanded["suggestions"][0].clone();
        expanded["suggestions"]
            .as_array_mut()
            .expect("suggestions")
            .push(second_definition);
        expanded["suggestions"][1]["id"] = Value::String("second-tip".to_owned());
        fs::write(custom_manifest, serde_json::to_vec(&expanded).unwrap()).expect("expanded");

        let second = load_aia_suggestion_catalog_from_home(temp.path()).expect("second");
        assert_eq!(second.definitions.len(), 100);
        assert!(second
            .issues
            .iter()
            .any(|issue| { issue.skill_key == "z-custom" && issue.using_last_known_good }));
        assert!(second.packs.iter().any(|entry| {
            entry.skill_key.as_deref() == Some("z-custom")
                && entry.source == AiaSuggestionPackSource::LastKnownGood
        }));
    }

    #[test]
    fn rejects_unknown_fields_kind_parameter_placeholder_and_limits() {
        let base: Value =
            serde_json::from_str(&pack_json("strict-pack", "strict-tip", "제목")).expect("json");
        for (label, mutate) in [
            ("unknown field", ("unknown", Value::Bool(true))),
            (
                "unknown kind",
                (
                    "suggestions.0.kind",
                    Value::String("executeShell".to_owned()),
                ),
            ),
            (
                "unknown parameter",
                (
                    "suggestions.0.parameters.shell",
                    Value::String("rm".to_owned()),
                ),
            ),
            (
                "unknown placeholder",
                (
                    "suggestions.0.titleTemplate",
                    Value::String("{secret}".to_owned()),
                ),
            ),
        ] {
            let mut value = base.clone();
            set_json_path(&mut value, mutate.0, mutate.1);
            let encoded = serde_json::to_vec(&value).expect("encode");
            assert!(parse_and_validate_pack(&encoded, label).is_err(), "{label}");
        }

        let mut long = base;
        set_json_path(
            &mut long,
            "suggestions.0.titleTemplate",
            Value::String("가".repeat(MAX_TITLE_CHARS + 1)),
        );
        assert!(parse_and_validate_pack(&serde_json::to_vec(&long).unwrap(), "long").is_err());
        assert!(
            parse_and_validate_pack(&vec![b' '; MAX_PACK_BYTES as usize + 1], "large").is_err()
        );
    }

    fn set_json_path(value: &mut Value, path: &str, replacement: Value) {
        let segments = path.split('.').collect::<Vec<_>>();
        let mut current = value;
        for segment in &segments[..segments.len() - 1] {
            current = if let Ok(index) = segment.parse::<usize>() {
                &mut current.as_array_mut().expect("array")[index]
            } else {
                current
                    .as_object_mut()
                    .expect("object")
                    .get_mut(*segment)
                    .expect("field")
            };
        }
        current
            .as_object_mut()
            .expect("target object")
            .insert(segments.last().unwrap().to_string(), replacement);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_manifest_and_skill_path_escape() {
        use std::os::unix::fs::symlink;

        let temp = TempDir::new().expect("temp");
        let root = temp.path().join(COMMON_ROOT_RELATIVE);
        let linked = root.join("linked-pack");
        fs::create_dir_all(linked.join("references")).expect("references");
        let outside = temp.path().join("outside.json");
        fs::write(&outside, pack_json("linked-pack", "tip", "제목")).expect("outside");
        symlink(&outside, linked.join(MANIFEST_RELATIVE)).expect("manifest link");

        let external_dir = temp.path().join("external-skill");
        fs::create_dir_all(external_dir.join("references")).expect("external");
        fs::write(
            external_dir.join(MANIFEST_RELATIVE),
            pack_json("escaped-pack", "tip", "제목"),
        )
        .expect("external manifest");
        symlink(&external_dir, root.join("escaped-pack")).expect("skill link");

        let linked_references = root.join("linked-references-pack");
        fs::create_dir_all(&linked_references).expect("linked references skill");
        let real_references = linked_references.join("real-references");
        fs::create_dir_all(&real_references).expect("real references");
        fs::write(
            real_references.join("aia-suggestions.json"),
            pack_json("linked-references-pack", "tip", "제목"),
        )
        .expect("linked references manifest");
        symlink(&real_references, linked_references.join("references")).expect("references link");

        let catalog = load_aia_suggestion_catalog_from_home(temp.path()).expect("catalog");
        assert_eq!(catalog.packs.len(), 1);
        assert_eq!(catalog.issues.len(), 3);
    }

    #[test]
    fn installed_flag_tracks_common_default_skill_key() {
        let temp = TempDir::new().expect("temp");
        let before = load_aia_suggestion_catalog_from_home(temp.path()).expect("before");
        assert!(!before.bundled_skill.installed);
        fs::create_dir_all(
            temp.path()
                .join(COMMON_ROOT_RELATIVE)
                .join(BUNDLED_SKILL_KEY),
        )
        .expect("skill");
        let after = load_aia_suggestion_catalog_from_home(temp.path()).expect("after");
        assert!(after.bundled_skill.installed);
    }

    #[test]
    fn aia_suggestion_kind_display_and_from_str_round_trip() {
        assert_eq!(
            AiaSuggestionKind::ALL,
            [
                AiaSuggestionKind::ProviderCliMissing,
                AiaSuggestionKind::AccountAuthError,
                AiaSuggestionKind::AccountUsageThreshold,
                AiaSuggestionKind::AccountAutoSwitchMissing,
                AiaSuggestionKind::SchedulerPaused,
                AiaSuggestionKind::ScheduleRunFailed,
                AiaSuggestionKind::TranslationFailed,
                AiaSuggestionKind::ProjectSessionCleanup,
                AiaSuggestionKind::InterruptedSessionReminder,
                AiaSuggestionKind::SkillContentChanged,
                AiaSuggestionKind::FeatureTip,
            ]
        );
        for kind in AiaSuggestionKind::ALL {
            assert_eq!(kind.to_string(), kind.as_str());
            assert_eq!(kind.as_str().parse::<AiaSuggestionKind>().unwrap(), kind);
            // serde 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&kind).unwrap();
            assert_eq!(serialized, format!("\"{}\"", kind.as_str()));
            let deserialized: AiaSuggestionKind = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, kind);
        }
        assert_eq!(
            "  providerCliMissing  "
                .parse::<AiaSuggestionKind>()
                .unwrap(),
            AiaSuggestionKind::ProviderCliMissing
        );
        assert_eq!(
            "  featureTip  ".parse::<AiaSuggestionKind>().unwrap(),
            AiaSuggestionKind::FeatureTip
        );
        assert!(matches!(
            "unknown".parse::<AiaSuggestionKind>(),
            Err(CoreError::InvalidInput(_))
        ));

        // 헬퍼 메서드 검증
        assert!(AiaSuggestionKind::AccountUsageThreshold.is_deprecated());
        assert!(!AiaSuggestionKind::AccountUsageThreshold.is_supported());

        assert!(!AiaSuggestionKind::FeatureTip.is_deprecated());
        assert!(AiaSuggestionKind::FeatureTip.is_supported());
        assert!(!AiaSuggestionKind::ProviderCliMissing.is_deprecated());
        assert!(AiaSuggestionKind::ProviderCliMissing.is_supported());
    }

    #[test]
    fn aia_suggestion_severity_display_and_from_str_round_trip() {
        assert_eq!(
            AiaSuggestionSeverity::ALL,
            [
                AiaSuggestionSeverity::Info,
                AiaSuggestionSeverity::Warning,
                AiaSuggestionSeverity::Error,
            ]
        );
        for severity in AiaSuggestionSeverity::ALL {
            assert_eq!(severity.to_string(), severity.as_str());
            assert_eq!(
                severity.as_str().parse::<AiaSuggestionSeverity>().unwrap(),
                severity
            );
            // serde 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&severity).unwrap();
            assert_eq!(serialized, format!("\"{}\"", severity.as_str()));
            let deserialized: AiaSuggestionSeverity = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, severity);
        }
        assert_eq!(
            "  info  ".parse::<AiaSuggestionSeverity>().unwrap(),
            AiaSuggestionSeverity::Info
        );
        assert_eq!(
            "  warning  ".parse::<AiaSuggestionSeverity>().unwrap(),
            AiaSuggestionSeverity::Warning
        );
        assert_eq!(
            "  error  ".parse::<AiaSuggestionSeverity>().unwrap(),
            AiaSuggestionSeverity::Error
        );
        assert!(matches!(
            "critical".parse::<AiaSuggestionSeverity>(),
            Err(CoreError::InvalidInput(_))
        ));
    }

    #[test]
    fn aia_suggestion_pack_source_display_and_from_str_round_trip() {
        assert_eq!(
            AiaSuggestionPackSource::ALL,
            [
                AiaSuggestionPackSource::Bundled,
                AiaSuggestionPackSource::CommonSkill,
                AiaSuggestionPackSource::LastKnownGood,
            ]
        );
        for source in AiaSuggestionPackSource::ALL {
            assert_eq!(source.to_string(), source.as_str());
            assert_eq!(
                source.as_str().parse::<AiaSuggestionPackSource>().unwrap(),
                source
            );
            // serde 직렬화 및 역직렬화 라운드트립 검증
            let serialized = serde_json::to_string(&source).unwrap();
            assert_eq!(serialized, format!("\"{}\"", source.as_str()));
            let deserialized: AiaSuggestionPackSource = serde_json::from_str(&serialized).unwrap();
            assert_eq!(deserialized, source);
        }
        assert_eq!(
            "  bundled  ".parse::<AiaSuggestionPackSource>().unwrap(),
            AiaSuggestionPackSource::Bundled
        );
        assert_eq!(
            "  commonSkill  "
                .parse::<AiaSuggestionPackSource>()
                .unwrap(),
            AiaSuggestionPackSource::CommonSkill
        );
        assert_eq!(
            "  lastKnownGood  "
                .parse::<AiaSuggestionPackSource>()
                .unwrap(),
            AiaSuggestionPackSource::LastKnownGood
        );
        assert!(matches!(
            "remote".parse::<AiaSuggestionPackSource>(),
            Err(CoreError::InvalidInput(_))
        ));
    }
}
