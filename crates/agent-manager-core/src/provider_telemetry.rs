//! 공급자 CLI가 자기 서버로 보내는 사용정보 수집을 끄고 켜는 유일한 어댑터(C13).
//!
//! 모델 학습 동의와는 다른 축이다. 학습 동의는 공급자 계정·조직 정책이 정하고 이 앱이
//! 건드릴 수 있는 자리가 없다. 여기서 다루는 것은 각 CLI가 **설정 파일에 적어 두는**
//! 사용정보·오류보고 수집 스위치뿐이다.
//!
//! 화면에 서는 토글은 공급자마다 극성이 다르다 — Claude는 `DISABLE_*`를 켜야 꺼지고,
//! Gemini는 `usageStatisticsEnabled`를 꺼야 꺼진다. 사용자가 그 차이를 외우게 두지 않으려고
//! 이 모듈의 계약은 **"차단(blocked)"** 한 방향으로만 말한다. 파일에 실제로 어떤 값이
//! 들어가는지는 아래 `OptionLocation`이 혼자 안다.
//!
//! 차단을 풀 때는 반대값을 적지 않고 **키를 지운다**. 세 공급자 모두 "그 키가 없음"이
//! 수집하는 기본 상태라, 지우는 쪽이 파일에 우리 흔적을 덜 남기고 공급자가 나중에 기본값을
//! 바꾸면 그 변경을 그대로 따른다.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use toml_edit::{DocumentMut, Item};

use crate::provider_settings_file::{
    redirected_dir, save_backup, SettingsFileGuard, SettingsPathRules,
};
use crate::store_lock;
use crate::user_home::home_dir;
use crate::CoreError;

const MAX_SETTINGS_BYTES: u64 = 1024 * 1024;
const TELEMETRY_LOCK_FILE: &str = "provider-telemetry.lock";
const BACKUP_STORE: &str = "provider-telemetry-backups";

/// 설정 파일을 손댈 때 쓰는 판정표. 문구는 "공급자 설정"으로 묶어 적는다 — 어느 공급자인지는
/// 오류를 받는 화면이 이미 알고 있고, 세 공급자가 같은 판정을 쓴다.
const TELEMETRY_GUARD: SettingsFileGuard = SettingsFileGuard {
    read: SettingsPathRules {
        symlink: "심볼릭 링크 설정 파일은 읽지 않습니다",
        wrong_kind: "설정 경로가 일반 파일이 아닙니다",
        directory: false,
    },
    write: SettingsPathRules {
        symlink: "공급자 설정 파일이 심볼릭 링크라 수정하지 않습니다",
        wrong_kind: "공급자 설정 경로가 일반 파일이 아닙니다",
        directory: false,
    },
    parent: SettingsPathRules {
        symlink: "공급자 설정 폴더가 심볼릭 링크라 수정하지 않습니다",
        wrong_kind: "공급자 설정 상위 경로가 폴더가 아닙니다",
        directory: true,
    },
    grandparent: SettingsPathRules {
        symlink: "공급자 설정 폴더의 상위 경로가 안전한 폴더가 아닙니다",
        wrong_kind: "공급자 설정 폴더의 상위 경로가 안전한 폴더가 아닙니다",
        directory: true,
    },
    missing_parent: "공급자 설정 상위 경로가 없습니다",
    missing_grandparent: "공급자 설정 폴더의 상위 경로가 없습니다",
    fallback_file_name: "settings.json",
};

/// 설정 파일의 형식. 파일 하나를 통째로 읽고 쓰는 방식이 형식마다 다르다.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SettingsFormat {
    Json,
    Toml,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TelemetryProvider {
    Claude,
    Codex,
    Gemini,
}

impl TelemetryProvider {
    const ALL: [Self; 3] = [Self::Claude, Self::Codex, Self::Gemini];

    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
        }
    }
}

/// 옵션 하나가 파일 어디에 어떤 값으로 적히는지. 공급자마다 다른 극성과 표기를 여기서만 안다.
#[derive(Clone, Copy)]
enum OptionLocation {
    /// `~/.claude/settings.json`의 `env.<name>`. 차단은 문자열 `"1"`이다.
    ClaudeEnv { name: &'static str },
    /// `~/.codex/config.toml`의 `[otel] exporter`. 차단은 `"none"`이다.
    CodexExporter,
    /// `~/.codex/config.toml`의 `[otel] <name>` 불리언. 차단은 `false`다.
    CodexOtelFlag { name: &'static str },
    /// `~/.gemini/settings.json`의 `<section>.<name>` 불리언. 차단은 `false`다.
    GeminiFlag {
        section: &'static str,
        name: &'static str,
    },
}

impl OptionLocation {
    fn provider(self) -> TelemetryProvider {
        match self {
            Self::ClaudeEnv { .. } => TelemetryProvider::Claude,
            Self::CodexExporter | Self::CodexOtelFlag { .. } => TelemetryProvider::Codex,
            Self::GeminiFlag { .. } => TelemetryProvider::Gemini,
        }
    }
}

/// 화면에 서는 옵션 하나의 정의. 라벨과 설명은 화면이 키로 찾아 붙이므로 여기에 두지 않는다.
struct OptionSpec {
    key: &'static str,
    location: OptionLocation,
}

/// 이 어댑터가 바꿀 수 있는 항목 전부. 이 표에 없는 키는 쓰기 요청을 받지 않는다.
const OPTIONS: &[OptionSpec] = &[
    OptionSpec {
        key: "claude.telemetry",
        location: OptionLocation::ClaudeEnv {
            name: "DISABLE_TELEMETRY",
        },
    },
    OptionSpec {
        key: "claude.errorReporting",
        location: OptionLocation::ClaudeEnv {
            name: "DISABLE_ERROR_REPORTING",
        },
    },
    OptionSpec {
        key: "claude.nonessentialTraffic",
        location: OptionLocation::ClaudeEnv {
            name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        },
    },
    OptionSpec {
        key: "codex.telemetry",
        location: OptionLocation::CodexExporter,
    },
    OptionSpec {
        key: "codex.promptLogging",
        location: OptionLocation::CodexOtelFlag {
            name: "log_user_prompt",
        },
    },
    OptionSpec {
        key: "gemini.usageStatistics",
        location: OptionLocation::GeminiFlag {
            section: "privacy",
            name: "usageStatisticsEnabled",
        },
    },
    OptionSpec {
        key: "gemini.telemetry",
        location: OptionLocation::GeminiFlag {
            section: "telemetry",
            name: "enabled",
        },
    },
];

/// 공급자 설정 파일 한 곳과 그 안 옵션들의 현재 상태.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTelemetryFile {
    pub provider: String,
    pub path: String,
    pub exists: bool,
    /// 파일을 안전하게 읽지 못한 이유. 있으면 그 공급자의 옵션은 모두 편집 불가다.
    pub parse_error: Option<String>,
    pub options: Vec<TelemetryOptionState>,
}

/// 옵션 하나의 현재 상태.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryOptionState {
    pub key: String,
    /// 수집을 막고 있는지. `None`이면 설정 파일에 값이 없다 — 공급자 기본값을 따른다.
    pub blocked: Option<bool>,
    /// 화면에서 토글을 움직여도 되는지. 우리가 해석하지 못하는 값이 이미 있으면 false다.
    pub editable: bool,
    /// 파일에 적혀 있는 값의 표기. 없으면 `None`.
    pub current: Option<String>,
    /// 편집을 막은 이유. `editable`이 false일 때만 채운다.
    pub note: Option<String>,
}

/// 세 공급자 전체 상태.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTelemetrySnapshot {
    pub files: Vec<ProviderTelemetryFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProviderTelemetryOptionRequest {
    pub key: String,
    /// true면 수집을 막는 값을 적고, false면 그 키를 지워 공급자 기본값으로 되돌린다.
    pub blocked: bool,
}

/// 공급자 설정 파일 위치. 공급자가 홈을 옮길 때 쓰는 환경변수만 본다(G8).
struct TelemetryRoots {
    claude: PathBuf,
    codex: PathBuf,
    gemini: PathBuf,
}

impl TelemetryRoots {
    fn resolve(home: &Path) -> Self {
        Self {
            claude: redirected_dir("CLAUDE_CONFIG_DIR")
                .unwrap_or_else(|| home.join(".claude"))
                .join("settings.json"),
            codex: redirected_dir("CODEX_HOME")
                .unwrap_or_else(|| home.join(".codex"))
                .join("config.toml"),
            // Gemini CLI는 설정 폴더 이름을 상수 `.gemini`로 고정한다. 옮길 환경변수가 없다.
            gemini: home.join(".gemini/settings.json"),
        }
    }

    fn file_for(&self, provider: TelemetryProvider) -> (&Path, SettingsFormat) {
        match provider {
            TelemetryProvider::Claude => (&self.claude, SettingsFormat::Json),
            TelemetryProvider::Codex => (&self.codex, SettingsFormat::Toml),
            TelemetryProvider::Gemini => (&self.gemini, SettingsFormat::Json),
        }
    }
}

/// 읽어 둔 설정 파일 하나. 파싱에 실패하면 `document`가 비고 사유만 남는다.
struct LoadedFile {
    path: String,
    exists: bool,
    parse_error: Option<String>,
    json: Option<Map<String, Value>>,
    toml: Option<DocumentMut>,
}

/// 세 공급자의 현재 수집 설정.
pub fn load_provider_telemetry() -> Result<ProviderTelemetrySnapshot, CoreError> {
    load_from(&TelemetryRoots::resolve(&home_dir()?))
}

/// 옵션 하나를 바꾸고 바뀐 전체 상태를 돌려준다.
pub fn set_provider_telemetry_option(
    app_data_dir: &Path,
    request: &SetProviderTelemetryOptionRequest,
) -> Result<ProviderTelemetrySnapshot, CoreError> {
    set_option_in(
        app_data_dir,
        &TelemetryRoots::resolve(&home_dir()?),
        request,
    )
}

fn set_option_in(
    app_data_dir: &Path,
    roots: &TelemetryRoots,
    request: &SetProviderTelemetryOptionRequest,
) -> Result<ProviderTelemetrySnapshot, CoreError> {
    let _guard = store_lock::acquire(app_data_dir, TELEMETRY_LOCK_FILE, "공급자 수집 설정")?;
    let spec = OPTIONS
        .iter()
        .find(|option| option.key == request.key)
        .ok_or_else(|| CoreError::InvalidInput("알 수 없는 수집 설정 항목입니다".to_owned()))?;
    let provider = spec.location.provider();
    let (target, format) = roots.file_for(provider);
    let target = target.to_path_buf();
    let loaded = read_file(&target, format);
    if let Some(error) = loaded.parse_error {
        return Err(CoreError::InvalidInput(format!(
            "공급자 설정 파일을 안전하게 수정할 수 없습니다: {error}"
        )));
    }
    let state = read_option(&loaded, spec);
    if !state.editable {
        return Err(CoreError::InvalidInput(state.note.unwrap_or_else(|| {
            "이 항목은 Agent Manager가 덮어쓰지 않습니다".to_owned()
        })));
    }
    // 값이 없는 것은 "막지 않음"과 같은 상태다. 둘을 구분해 쓰면 끄기 요청이 빈 설정
    // 파일을 새로 만들거나, 사용자가 직접 적어 둔 명시값을 이유 없이 지운다.
    if state.blocked.unwrap_or(false) == request.blocked {
        return load_from(roots);
    }
    let bytes = match format {
        SettingsFormat::Json => write_json_option(&loaded, spec, request.blocked)?,
        SettingsFormat::Toml => write_toml_option(&loaded, spec, request.blocked)?,
    };
    TELEMETRY_GUARD.ensure_parent(&target)?;
    if loaded.exists {
        let original = fs::read(&target)?;
        let extension = match format {
            SettingsFormat::Json => "json",
            SettingsFormat::Toml => "toml",
        };
        save_backup(app_data_dir, BACKUP_STORE, extension, &target, &original)?;
    }
    TELEMETRY_GUARD.atomic_write(&target, &bytes)?;
    load_from(roots)
}

fn load_from(roots: &TelemetryRoots) -> Result<ProviderTelemetrySnapshot, CoreError> {
    let files = TelemetryProvider::ALL
        .into_iter()
        .map(|provider| {
            let (path, format) = roots.file_for(provider);
            let loaded = read_file(path, format);
            let options = OPTIONS
                .iter()
                .filter(|spec| spec.location.provider() == provider)
                .map(|spec| read_option(&loaded, spec))
                .collect();
            ProviderTelemetryFile {
                provider: provider.as_str().to_owned(),
                path: loaded.path.clone(),
                exists: loaded.exists,
                parse_error: loaded.parse_error.clone(),
                options,
            }
        })
        .collect();
    Ok(ProviderTelemetrySnapshot { files })
}

fn read_file(path: &Path, format: SettingsFormat) -> LoadedFile {
    let path_text = path.to_string_lossy().into_owned();
    // 읽지 못한 파일은 본문 없이 사유만 남긴다. 본문을 비워 두면 그 위의 모든 항목이
    // 편집 불가로 읽히므로, 절반만 해석한 상태로 쓰기에 들어갈 길이 없다.
    let empty = |exists: bool, error: Option<String>| LoadedFile {
        path: path_text.clone(),
        exists,
        parse_error: error,
        json: None,
        toml: None,
    };
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // 파일이 없는 것은 오류가 아니다. 모든 항목이 "미설정"으로 읽힌다.
            return LoadedFile {
                path: path_text,
                exists: false,
                parse_error: None,
                json: Some(Map::new()),
                toml: Some(DocumentMut::new()),
            };
        }
        Err(error) => return empty(false, Some(error.to_string())),
    };
    if let Err(message) = TELEMETRY_GUARD.read.check(&metadata) {
        return empty(true, Some(message.to_owned()));
    }
    if metadata.len() > MAX_SETTINGS_BYTES {
        return empty(
            true,
            Some(format!(
                "설정 파일이 {MAX_SETTINGS_BYTES}바이트 제한을 넘었습니다"
            )),
        );
    }
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => return empty(true, Some(error.to_string())),
    };
    match format {
        SettingsFormat::Json => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(root)) => LoadedFile {
                path: path_text,
                exists: true,
                parse_error: None,
                json: Some(root),
                toml: None,
            },
            Ok(_) => empty(
                true,
                Some("설정 파일 최상위 값이 객체가 아닙니다".to_owned()),
            ),
            Err(error) => empty(true, Some(error.to_string())),
        },
        SettingsFormat::Toml => match text.parse::<DocumentMut>() {
            Ok(document) => LoadedFile {
                path: path_text,
                exists: true,
                parse_error: None,
                json: None,
                toml: Some(document),
            },
            Err(error) => empty(true, Some(error.to_string())),
        },
    }
}

/// 읽지 못한 파일 위의 항목. 값을 모르니 편집도 막는다.
fn unreadable(spec: &OptionSpec, error: &str) -> TelemetryOptionState {
    TelemetryOptionState {
        key: spec.key.to_owned(),
        blocked: None,
        editable: false,
        current: None,
        note: Some(format!("설정 파일을 읽지 못했습니다: {error}")),
    }
}

/// 값은 읽었지만 이 어댑터가 해석하지 못하는 항목. 화면이 덮어쓰지 않도록 편집을 막는다.
fn unknown(spec: &OptionSpec, current: Option<String>, note: &str) -> TelemetryOptionState {
    TelemetryOptionState {
        key: spec.key.to_owned(),
        blocked: None,
        editable: false,
        current,
        note: Some(note.to_owned()),
    }
}

/// 읽어서 뜻을 안 항목. `blocked`가 비면 파일에 값이 없다는 뜻이다.
fn known(
    spec: &OptionSpec,
    blocked: Option<bool>,
    current: Option<String>,
) -> TelemetryOptionState {
    TelemetryOptionState {
        key: spec.key.to_owned(),
        blocked,
        editable: true,
        current,
        note: None,
    }
}

/// 불리언 항목의 극성은 세 갈래가 모두 같다 — `false`가 곧 차단이다.
fn known_flag(spec: &OptionSpec, value: bool) -> TelemetryOptionState {
    known(spec, Some(!value), Some(value.to_string()))
}

const BAD_FORMAT: &str = "설정 파일 형식이 맞지 않습니다";
const NOT_A_STRING: &str = "이 항목이 문자열이 아니라 화면에서 바꾸지 않습니다";
const NOT_A_BOOL: &str = "이 항목이 참/거짓이 아니라 화면에서 바꾸지 않습니다";
const OTEL_NOT_A_TABLE: &str = "설정의 otel 값이 표가 아니라 화면에서 바꾸지 않습니다";

/// JSON 설정에서 `<section>.<name>`을 꺼낸 결과. 구획이 없는 것과 구획이 객체가 아닌 것은
/// 뜻이 달라(전자는 기본값, 후자는 손대면 안 되는 파일) 갈라 둔다.
enum JsonEntry<'a> {
    /// 파일을 객체로 읽지 못했다.
    Unreadable,
    /// 구획이 없거나 그 안에 항목이 없다.
    Missing,
    /// 구획이 객체가 아니다.
    NotASection,
    Value(&'a Value),
}

fn json_entry<'a>(loaded: &'a LoadedFile, section: &str, name: &str) -> JsonEntry<'a> {
    let Some(root) = &loaded.json else {
        return JsonEntry::Unreadable;
    };
    match root.get(section) {
        None => JsonEntry::Missing,
        Some(Value::Object(entries)) => match entries.get(name) {
            None => JsonEntry::Missing,
            Some(value) => JsonEntry::Value(value),
        },
        Some(_) => JsonEntry::NotASection,
    }
}

/// `~/.claude/settings.json`의 `env.<name>`. 문자열 표기라 극성도 문자열로 읽는다.
fn read_claude_env(loaded: &LoadedFile, spec: &OptionSpec, name: &str) -> TelemetryOptionState {
    match json_entry(loaded, "env", name) {
        JsonEntry::Unreadable => unreadable(spec, BAD_FORMAT),
        JsonEntry::Missing => known(spec, None, None),
        JsonEntry::NotASection => unknown(
            spec,
            None,
            "설정의 env 값이 객체가 아니라 화면에서 바꾸지 않습니다",
        ),
        JsonEntry::Value(Value::String(text)) => match text.as_str() {
            "1" | "true" => known(spec, Some(true), Some(text.clone())),
            "0" | "false" | "" => known(spec, Some(false), Some(text.clone())),
            other => unknown(
                spec,
                Some(other.to_owned()),
                "이 항목에 Agent Manager가 해석하지 못하는 값이 들어 있습니다",
            ),
        },
        JsonEntry::Value(other) => unknown(spec, Some(other.to_string()), NOT_A_STRING),
    }
}

/// `~/.gemini/settings.json`의 `<section>.<name>` 불리언.
fn read_gemini_flag(
    loaded: &LoadedFile,
    spec: &OptionSpec,
    section: &str,
    name: &str,
) -> TelemetryOptionState {
    match json_entry(loaded, section, name) {
        JsonEntry::Unreadable => unreadable(spec, BAD_FORMAT),
        JsonEntry::Missing => known(spec, None, None),
        JsonEntry::NotASection => unknown(
            spec,
            None,
            "설정의 해당 구획이 객체가 아니라 화면에서 바꾸지 않습니다",
        ),
        JsonEntry::Value(Value::Bool(value)) => known_flag(spec, *value),
        JsonEntry::Value(other) => unknown(spec, Some(other.to_string()), NOT_A_BOOL),
    }
}

/// `~/.codex/config.toml`의 `[otel] exporter`. 내보내기 없음이 곧 차단이다.
fn read_codex_exporter(loaded: &LoadedFile, spec: &OptionSpec) -> TelemetryOptionState {
    match otel_entry(loaded, "exporter") {
        OtelEntry::Missing => known(spec, None, None),
        OtelEntry::NotATable => unknown(spec, None, OTEL_NOT_A_TABLE),
        OtelEntry::Value(item) => match item.as_str() {
            Some("none") => known(spec, Some(true), Some("none".to_owned())),
            Some("statsig") => known(spec, Some(false), Some("statsig".to_owned())),
            // OTLP 수집기를 직접 구성해 둔 사용자의 파이프라인을 화면 토글로 끊지 않는다.
            Some(other) => unknown(
                spec,
                Some(other.to_owned()),
                "OTLP 내보내기가 구성되어 있어 화면에서 바꾸지 않습니다",
            ),
            None => unknown(spec, None, NOT_A_STRING),
        },
    }
}

/// `~/.codex/config.toml`의 `[otel] <name>` 불리언.
fn read_codex_otel_flag(
    loaded: &LoadedFile,
    spec: &OptionSpec,
    name: &str,
) -> TelemetryOptionState {
    match otel_entry(loaded, name) {
        OtelEntry::Missing => known(spec, None, None),
        OtelEntry::NotATable => unknown(spec, None, OTEL_NOT_A_TABLE),
        OtelEntry::Value(item) => match item.as_bool() {
            Some(value) => known_flag(spec, value),
            None => unknown(spec, None, NOT_A_BOOL),
        },
    }
}

/// 항목 하나의 현재 상태. 파일이 통째로 깨졌는지만 여기서 가르고, 나머지는 자리마다
/// 다른 갈래라 위치별 읽기 함수에 맡긴다.
fn read_option(loaded: &LoadedFile, spec: &OptionSpec) -> TelemetryOptionState {
    if let Some(error) = &loaded.parse_error {
        return unreadable(spec, error);
    }
    match spec.location {
        OptionLocation::ClaudeEnv { name } => read_claude_env(loaded, spec, name),
        OptionLocation::CodexExporter => read_codex_exporter(loaded, spec),
        OptionLocation::CodexOtelFlag { name } => read_codex_otel_flag(loaded, spec, name),
        OptionLocation::GeminiFlag { section, name } => {
            read_gemini_flag(loaded, spec, section, name)
        }
    }
}

/// `[otel]` 표에서 항목 하나를 꺼낸 결과.
enum OtelEntry<'a> {
    /// `[otel]`이 없거나 그 안에 항목이 없다.
    Missing,
    /// `[otel]`이 표가 아니다.
    NotATable,
    Value(&'a Item),
}

fn otel_entry<'a>(loaded: &'a LoadedFile, name: &str) -> OtelEntry<'a> {
    let Some(document) = &loaded.toml else {
        return OtelEntry::NotATable;
    };
    match document.get("otel") {
        None => OtelEntry::Missing,
        Some(item) => match item.as_table_like() {
            None => OtelEntry::NotATable,
            Some(table) => match table.get(name) {
                None => OtelEntry::Missing,
                Some(value) => OtelEntry::Value(value),
            },
        },
    }
}

fn write_json_option(
    loaded: &LoadedFile,
    spec: &OptionSpec,
    blocked: bool,
) -> Result<Vec<u8>, CoreError> {
    let mut root = loaded
        .json
        .clone()
        .ok_or_else(|| CoreError::InvalidInput("설정 파일 형식이 맞지 않습니다".to_owned()))?;
    let (section, name, value) = match spec.location {
        OptionLocation::ClaudeEnv { name } => ("env", name, Value::String("1".to_owned())),
        OptionLocation::GeminiFlag { section, name } => (section, name, Value::Bool(false)),
        _ => {
            return Err(CoreError::InvalidInput(
                "이 항목은 JSON 설정이 아닙니다".to_owned(),
            ))
        }
    };
    let entries = root
        .entry(section.to_owned())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or_else(|| CoreError::InvalidInput(format!("설정의 {section} 값이 객체가 아닙니다")))?;
    if blocked {
        entries.insert(name.to_owned(), value);
    } else {
        entries.remove(name);
    }
    // 우리가 만든 구획이 비었으면 남기지 않는다.
    if entries.is_empty() {
        root.remove(section);
    }
    let mut bytes = serde_json::to_vec_pretty(&Value::Object(root))?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn write_toml_option(
    loaded: &LoadedFile,
    spec: &OptionSpec,
    blocked: bool,
) -> Result<Vec<u8>, CoreError> {
    let mut document = loaded
        .toml
        .clone()
        .ok_or_else(|| CoreError::InvalidInput("설정 파일 형식이 맞지 않습니다".to_owned()))?;
    let (name, value) = match spec.location {
        OptionLocation::CodexExporter => ("exporter", toml_edit::value("none")),
        OptionLocation::CodexOtelFlag { name } => (name, toml_edit::value(false)),
        _ => {
            return Err(CoreError::InvalidInput(
                "이 항목은 TOML 설정이 아닙니다".to_owned(),
            ))
        }
    };
    if blocked {
        if document.get("otel").is_none() {
            document["otel"] = Item::Table(toml_edit::Table::new());
        }
        let table = document["otel"]
            .as_table_like_mut()
            .ok_or_else(|| CoreError::InvalidInput("설정의 otel 값이 표가 아닙니다".to_owned()))?;
        table.insert(name, value);
    } else {
        if let Some(table) = document.get_mut("otel").and_then(Item::as_table_like_mut) {
            table.remove(name);
            if table.is_empty() {
                document.remove("otel");
            }
        }
    }
    Ok(document.to_string().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    impl TelemetryRoots {
        /// 환경변수를 보지 않고 임시 홈 아래 경로만 쓰는 테스트용 생성자. 테스트 프로세스에
        /// `CODEX_HOME` 같은 값이 떠 있어도 결과가 흔들리지 않게 한다.
        fn under(home: &Path) -> Self {
            Self {
                claude: home.join(".claude/settings.json"),
                codex: home.join(".codex/config.toml"),
                gemini: home.join(".gemini/settings.json"),
            }
        }
    }

    struct Fixture {
        home: TempDir,
        app_data: TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                home: TempDir::new().expect("home"),
                app_data: TempDir::new().expect("app data"),
            }
        }

        fn roots(&self) -> TelemetryRoots {
            TelemetryRoots::under(self.home.path())
        }

        fn write(&self, relative: &str, contents: &str) -> PathBuf {
            let path = self.home.path().join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("parent");
            fs::write(&path, contents).expect("write");
            path
        }

        fn set(&self, key: &str, blocked: bool) -> Result<ProviderTelemetrySnapshot, CoreError> {
            set_option_in(
                self.app_data.path(),
                &self.roots(),
                &SetProviderTelemetryOptionRequest {
                    key: key.to_owned(),
                    blocked,
                },
            )
        }

        fn option(&self, key: &str) -> TelemetryOptionState {
            load_from(&self.roots())
                .expect("load")
                .files
                .into_iter()
                .flat_map(|file| file.options)
                .find(|option| option.key == key)
                .expect("option must exist")
        }
    }

    #[test]
    fn reports_every_option_as_unset_when_no_settings_file_exists() {
        let fixture = Fixture::new();
        let snapshot = load_from(&fixture.roots()).expect("load");
        assert_eq!(snapshot.files.len(), 3);
        assert!(snapshot.files.iter().all(|file| !file.exists));
        assert!(snapshot
            .files
            .iter()
            .flat_map(|file| &file.options)
            .all(|option| option.blocked.is_none() && option.editable));
    }

    #[test]
    fn blocking_claude_telemetry_writes_the_env_switch_and_keeps_other_keys() {
        let fixture = Fixture::new();
        fixture.write(
            ".claude/settings.json",
            r#"{"theme":"dark","env":{"FOO":"bar"}}"#,
        );
        fixture.set("claude.telemetry", true).expect("set");
        let written: Value = serde_json::from_slice(
            &fs::read(fixture.home.path().join(".claude/settings.json")).expect("read"),
        )
        .expect("json");
        assert_eq!(
            written["env"]["DISABLE_TELEMETRY"],
            Value::String("1".into())
        );
        assert_eq!(written["env"]["FOO"], Value::String("bar".into()));
        assert_eq!(written["theme"], Value::String("dark".into()));
        assert_eq!(fixture.option("claude.telemetry").blocked, Some(true));
    }

    #[test]
    fn unblocking_removes_the_key_instead_of_writing_the_opposite_value() {
        let fixture = Fixture::new();
        fixture.write(
            ".claude/settings.json",
            r#"{"env":{"DISABLE_TELEMETRY":"1","KEEP":"1"}}"#,
        );
        fixture.set("claude.telemetry", false).expect("set");
        let written: Value = serde_json::from_slice(
            &fs::read(fixture.home.path().join(".claude/settings.json")).expect("read"),
        )
        .expect("json");
        assert!(written["env"].get("DISABLE_TELEMETRY").is_none());
        assert_eq!(written["env"]["KEEP"], Value::String("1".into()));
        assert_eq!(fixture.option("claude.telemetry").blocked, None);
    }

    #[test]
    fn removing_the_last_entry_drops_the_section_it_created() {
        let fixture = Fixture::new();
        fixture.set("claude.telemetry", true).expect("block");
        fixture.set("claude.telemetry", false).expect("unblock");
        let written: Value = serde_json::from_slice(
            &fs::read(fixture.home.path().join(".claude/settings.json")).expect("read"),
        )
        .expect("json");
        assert!(written.as_object().expect("object").get("env").is_none());
    }

    #[test]
    fn keeps_a_backup_of_the_file_it_replaced() {
        let fixture = Fixture::new();
        fixture.write(".claude/settings.json", r#"{"env":{}}"#);
        fixture.set("claude.telemetry", true).expect("set");
        let store = fixture.app_data.path().join(BACKUP_STORE);
        let backups: Vec<_> = fs::read_dir(&store)
            .expect("store")
            .flatten()
            .flat_map(|entry| fs::read_dir(entry.path()).expect("target dir").flatten())
            .collect();
        assert_eq!(backups.len(), 1);
    }

    #[test]
    fn codex_blocking_writes_exporter_none_and_preserves_comments() {
        let fixture = Fixture::new();
        fixture.write(
            ".codex/config.toml",
            "# 내 설정\nmodel = \"gpt-5.6-sol\"\n\n[otel]\nlog_user_prompt = true\n",
        );
        fixture.set("codex.telemetry", true).expect("set");
        let written =
            fs::read_to_string(fixture.home.path().join(".codex/config.toml")).expect("read");
        assert!(written.contains("# 내 설정"));
        assert!(written.contains("model = \"gpt-5.6-sol\""));
        assert!(written.contains("exporter = \"none\""));
        assert!(written.contains("log_user_prompt = true"));
        assert_eq!(fixture.option("codex.telemetry").blocked, Some(true));
    }

    #[test]
    fn codex_creates_the_otel_table_when_the_file_has_none() {
        let fixture = Fixture::new();
        fixture.write(".codex/config.toml", "model = \"gpt-5.6-sol\"\n");
        fixture.set("codex.promptLogging", true).expect("set");
        let written =
            fs::read_to_string(fixture.home.path().join(".codex/config.toml")).expect("read");
        assert!(written.contains("[otel]"));
        assert!(written.contains("log_user_prompt = false"));
    }

    #[test]
    fn codex_unblocking_removes_the_key_and_the_table_it_emptied() {
        let fixture = Fixture::new();
        fixture.write(".codex/config.toml", "model = \"gpt-5.6-sol\"\n");
        fixture.set("codex.telemetry", true).expect("block");
        fixture.set("codex.telemetry", false).expect("unblock");
        let written =
            fs::read_to_string(fixture.home.path().join(".codex/config.toml")).expect("read");
        assert!(!written.contains("[otel]"));
        assert!(written.contains("model = \"gpt-5.6-sol\""));
        assert_eq!(fixture.option("codex.telemetry").blocked, None);
    }

    #[test]
    fn unblocking_an_unset_option_does_not_create_a_settings_file() {
        let fixture = Fixture::new();
        fixture.set("gemini.usageStatistics", false).expect("no-op");
        assert!(!fixture.home.path().join(".gemini/settings.json").exists());
    }

    #[test]
    fn unblocking_leaves_an_explicit_provider_value_alone() {
        let fixture = Fixture::new();
        fixture.write(
            ".gemini/settings.json",
            r#"{"privacy":{"usageStatisticsEnabled":true}}"#,
        );
        fixture.set("gemini.usageStatistics", false).expect("no-op");
        let written: Value = serde_json::from_slice(
            &fs::read(fixture.home.path().join(".gemini/settings.json")).expect("read"),
        )
        .expect("json");
        assert_eq!(
            written["privacy"]["usageStatisticsEnabled"],
            Value::Bool(true)
        );
    }

    #[test]
    fn codex_refuses_to_touch_a_configured_otlp_exporter() {
        let fixture = Fixture::new();
        fixture.write(
            ".codex/config.toml",
            "[otel]\nexporter = \"otlp-http\"\nendpoint = \"https://collector.example\"\n",
        );
        let option = fixture.option("codex.telemetry");
        assert!(!option.editable);
        assert_eq!(option.current.as_deref(), Some("otlp-http"));
        let error = fixture
            .set("codex.telemetry", true)
            .expect_err("must refuse");
        assert!(matches!(error, CoreError::InvalidInput(_)));
        let written =
            fs::read_to_string(fixture.home.path().join(".codex/config.toml")).expect("read");
        assert!(written.contains("otlp-http"));
    }

    #[test]
    fn gemini_blocking_writes_false_and_unblocking_removes_the_section() {
        let fixture = Fixture::new();
        fixture.set("gemini.usageStatistics", true).expect("block");
        let written: Value = serde_json::from_slice(
            &fs::read(fixture.home.path().join(".gemini/settings.json")).expect("read"),
        )
        .expect("json");
        assert_eq!(
            written["privacy"]["usageStatisticsEnabled"],
            Value::Bool(false)
        );

        fixture
            .set("gemini.usageStatistics", false)
            .expect("unblock");
        let written: Value = serde_json::from_slice(
            &fs::read(fixture.home.path().join(".gemini/settings.json")).expect("read"),
        )
        .expect("json");
        assert!(written
            .as_object()
            .expect("object")
            .get("privacy")
            .is_none());
    }

    #[test]
    fn gemini_reads_an_explicit_true_as_not_blocked() {
        let fixture = Fixture::new();
        fixture.write(
            ".gemini/settings.json",
            r#"{"privacy":{"usageStatisticsEnabled":true}}"#,
        );
        assert_eq!(
            fixture.option("gemini.usageStatistics").blocked,
            Some(false)
        );
    }

    #[test]
    fn a_value_we_cannot_interpret_locks_the_toggle_instead_of_guessing() {
        let fixture = Fixture::new();
        fixture.write(
            ".claude/settings.json",
            r#"{"env":{"DISABLE_TELEMETRY":"maybe"}}"#,
        );
        let option = fixture.option("claude.telemetry");
        assert!(!option.editable);
        assert_eq!(option.current.as_deref(), Some("maybe"));
        assert!(fixture.set("claude.telemetry", true).is_err());
    }

    #[test]
    fn a_broken_settings_file_is_reported_and_never_overwritten() {
        let fixture = Fixture::new();
        let path = fixture.write(".gemini/settings.json", "{ not json");
        let snapshot = load_from(&fixture.roots()).expect("load");
        let file = snapshot
            .files
            .iter()
            .find(|file| file.provider == "gemini")
            .expect("gemini file");
        assert!(file.parse_error.is_some());
        assert!(file.options.iter().all(|option| !option.editable));
        assert!(fixture.set("gemini.telemetry", true).is_err());
        assert_eq!(fs::read_to_string(path).expect("read"), "{ not json");
    }

    #[test]
    fn an_unknown_option_key_is_refused() {
        let fixture = Fixture::new();
        let error = fixture.set("claude.everything", true).expect_err("refuse");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }

    /// 심링크를 만들 수 있으면 만들고, 못 만들면 이유를 남기고 `false`를 준다.
    ///
    /// Windows에서 심링크 생성은 `SeCreateSymbolicLinkPrivilege`를 요구하고, 개발자 모드를
    /// 켜지 않은 기본 설치에는 그 권한이 없다 — `C4-5`가 정션·하드링크로 되돌아가는 것과
    /// 같은 제약이다. 그 기계에서 `expect("symlink")`가 터지면 "심링크를 따라가지 않는다"는
    /// 성질이 깨진 것처럼 보이지만, 실제로는 시험을 **세우지도** 못한 것이다. 둘을 같은
    /// 실패로 보고하면 진짜 회귀가 이 소음에 묻힌다. 권한이 있는 기계에서는 그대로 검사한다.
    fn try_symlink_file(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_file(target, link);
        match result {
            Ok(()) => true,
            Err(error) => {
                eprintln!(
                    "[provider_telemetry] 심링크를 만들 수 없어 건너뜁니다(권한 부족으로 보임): {error}"
                );
                false
            }
        }
    }

    #[test]
    fn a_symlinked_settings_file_is_never_followed() {
        let fixture = Fixture::new();
        let real = fixture.write("elsewhere/settings.json", r#"{"env":{}}"#);
        let link_parent = fixture.home.path().join(".claude");
        fs::create_dir_all(&link_parent).expect("parent");
        if !try_symlink_file(&real, &link_parent.join("settings.json")) {
            return;
        }
        let snapshot = load_from(&fixture.roots()).expect("load");
        let file = snapshot
            .files
            .iter()
            .find(|file| file.provider == "claude")
            .expect("claude file");
        assert!(file.parse_error.is_some());
        assert!(fixture.set("claude.telemetry", true).is_err());
    }
}
