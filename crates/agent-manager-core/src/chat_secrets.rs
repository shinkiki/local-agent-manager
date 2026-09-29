//! C15. 대화 도중 사용자가 건넨 비밀값을 **이름**으로만 에이전트에게 열어 주는 자리.
//!
//! # 왜 값이 아니라 이름인가
//!
//! 에이전트가 API 키나 비밀번호를 써야 할 때 값을 프롬프트에 적으면 그 값은 공급자
//! 서버·공급자 세션 파일·앱 전사 어디에나 남는다. sudo 비밀번호(C9-19)가 보여 준 길은
//! 다르다 — 값은 승인 카드의 별도 통로로 백엔드 메모리에만 오고, 실행은 앱이 대신 하며,
//! 에이전트는 "받았다"만 안다. 이 모듈은 그 구조를 sudo 한 갈래에서 **이름 붙은 비밀값
//! 전반**으로 넓힌다. 에이전트는 `API_KEY` 같은 이름을 들고 실행을 맡기고, 백엔드가 그
//! 자식 프로세스의 환경변수에만 값을 넣는다.
//!
//! # 무엇에 묶이는가
//!
//! (대화, 이름) 두 값에 묶인다. 다른 대화는 같은 이름으로도 값을 보지 못한다.
//! [`CHAT_SECRET_TTL_MS`]가 지나면 스스로 사라지고, 대화가 끝나면
//! [`ChatSecretStore::discard_chat`]으로 즉시 사라진다. 디스크·키체인 어디에도 적지 않는다.
//!
//! # 누가 넣을 수 있는가
//!
//! 사용자만이다. 에이전트가 이름을 대고 올린 승인 카드의 입력칸, 그리고 그렇게 맡긴 값이
//! 이미 있을 때만 화면에 나타나는 비밀값 패널(`set_chat_secret`) 둘뿐이다 — 첫 값은 언제나
//! 카드를 거친다. 에이전트가 닿는 어떤 도구도 값을 인자로 받지 않고
//! 응답에 싣지 않는다 — 목록 조회는 이름·용도·만료만 돌려준다.
//!
//! # 값이 나가는 곳
//!
//! 둘이다. [`run_with_chat_secrets`]는 에이전트가 준 argv를 승인된 실행 파일로 풀어 자식을
//! 띄우고, 값을 그 자식의 환경변수와 인자·stdin의 `{{secret:이름}}` 자리에 넣는다. 자식의
//! 출력에서 그 대화의 비밀값을 지운 뒤 돌려주므로, 명령이 값을 echo해도 에이전트 컨텍스트에는
//! 들어가지 않는다. [`write_file_with_chat_secrets`]는 값이 설정 파일 안에 있어야 도는 도구를
//! 위해 자리표시자를 채운 파일을 대신 쓴다 — 그 파일은 에이전트가 읽을 수 있는 자리에 놓이며,
//! 그것이 사용자가 카드에서 읽고 허락한 용도다. 정화는 정확 일치 치환이라 인코딩된 형태는
//! 잡지 못한다 — 실수를 막는 것이지 고의적 유출을 막는 것이 아니며, 그 경계는 스킬 문서가
//! 에이전트에게 밝힌다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::approval_ledger::{ApprovalEntry, ApprovalLedger, ApprovalWording};
use crate::clock::now_ms;
use crate::process_output::CappedOutputReaders;
use crate::CoreError;

/// 값을 들고 있는 시간. 한 작업이 여러 호출로 이어지는 동안 다시 묻지 않을 만큼 길고,
/// 자리를 비운 사이 하루 종일 남아 있지는 않은 값이다. 실행에 쓰일 때마다 이만큼 연장된다.
pub const CHAT_SECRET_TTL_MS: i64 = 3_600_000;

/// 비밀값 요청 카드가 유효한 시간. 사용자가 값을 찾아 붙여 넣기에 충분한 값이다.
pub const SECRET_REQUEST_TTL_MS: i64 = 300_000;

/// 저장소 전체 상한. 대화가 여러 개 열려 있어도 메모리는 이 선에서 멈춘다.
const MAX_ENTRIES: usize = 64;
/// 한 대화가 들 수 있는 비밀값 수.
const MAX_PER_CHAT: usize = 16;

pub const MAX_SECRET_NAME_CHARS: usize = 64;
pub const MAX_SECRET_PURPOSE_CHARS: usize = 200;
pub const MAX_SECRET_VALUE_CHARS: usize = 4096;

/// 대행 실행의 기본·최대 제한 시간.
pub const DEFAULT_RUN_TIMEOUT_SECONDS: u64 = 120;
pub const MAX_RUN_TIMEOUT_SECONDS: u64 = 900;
/// 영수증에 싣는 출력 상한(문자). 그보다 길면 앞부분을 잘라 낸다.
const OUTPUT_TAIL_CHARS: usize = 64 * 1024;
/// 정화된 값이 들어가는 자리.
const REDACTED: &str = "[제거된 비밀값]";
/// 한 실행에 넣을 수 있는 환경변수 수.
const MAX_INJECTIONS: usize = 16;

/// 값을 넣은 주체. 화면이 배지로 보여 주는 값이라 저장소 밖으로 나가도 된다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChatSecretSource {
    /// 사용자가 패널에서 직접 등록했다.
    User,
    /// 에이전트가 요청해 사용자가 승인 카드에 입력했다.
    Agent,
    /// C17. 저장해 둔 값을 에이전트의 요청에 따라 앱이 자동으로 실어 왔다. 사용자가 이
    /// 대화에서 다시 입력한 적은 없으므로 출처를 따로 둔다 — 어느 값이 자동으로 쓰였는지
    /// 화면에서 읽히지 않으면 저장의 편의가 곧 모르는 사이의 사용이 된다.
    Saved,
}

/// 들고 있는 값 하나. `Zeroizing`이 drop 시점에 버퍼를 0으로 덮는다.
struct StoredSecret {
    chat_id: String,
    name: String,
    purpose: String,
    source: ChatSecretSource,
    value: Zeroizing<String>,
    expires_at: i64,
}

impl StoredSecret {
    fn expired(&self, now: i64) -> bool {
        now >= self.expires_at
    }

    fn matches(&self, chat_id: &str, name: &str) -> bool {
        self.chat_id == chat_id && self.name == name
    }

    fn summary(&self) -> ChatSecretSummary {
        ChatSecretSummary {
            name: self.name.clone(),
            purpose: self.purpose.clone(),
            expires_at: self.expires_at,
            source: self.source,
        }
    }
}

/// 값 없는 항목 하나. 화면·에이전트 양쪽이 보는 모양이다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSecretSummary {
    pub name: String,
    pub purpose: String,
    pub expires_at: i64,
    pub source: ChatSecretSource,
}

/// 한 대화의 비밀값 목록. 값은 어느 칸에도 없다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSecretsSnapshot {
    pub chat_id: String,
    pub secrets: Vec<ChatSecretSummary>,
    pub ttl_seconds: i64,
}

/// 대화별 비밀값 보관소. 프로세스 메모리에만 있고 디스크에 남지 않는다.
#[derive(Default)]
pub struct ChatSecretStore {
    entries: Mutex<Vec<StoredSecret>>,
    /// C17. 저장된 비밀값을 찾을 앱 데이터 폴더. 없으면 저장소가 없는 것과 같아, 이름이
    /// 없는 실행은 예전처럼 "그 이름이 없다"로 끝난다.
    vault: Option<PathBuf>,
}

// 값이 실수로 로그에 실리지 않도록 내용을 찍지 않는다.
impl std::fmt::Debug for ChatSecretStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let held = self
            .entries
            .lock()
            .map(|entries| entries.len())
            .unwrap_or(0);
        formatter
            .debug_struct("ChatSecretStore")
            .field("held", &held)
            .finish()
    }
}

/// 이름 규칙. 환경변수 이름으로 그대로 쓰이므로 대문자·숫자·밑줄만 받고 대문자로 시작한다.
pub fn validate_secret_name(name: &str) -> Result<(), CoreError> {
    let mut chars = name.chars();
    let valid_first = chars.next().is_some_and(|c| c.is_ascii_uppercase());
    let valid_rest = chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !valid_first || !valid_rest || name.chars().count() > MAX_SECRET_NAME_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "비밀값 이름은 대문자로 시작하고 대문자·숫자·밑줄만으로 {MAX_SECRET_NAME_CHARS}자 이내여야 합니다: {name:?}"
        )));
    }
    Ok(())
}

pub(crate) fn validate_secret_purpose(purpose: &str) -> Result<String, CoreError> {
    let trimmed = purpose.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_SECRET_PURPOSE_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "용도는 1~{MAX_SECRET_PURPOSE_CHARS}자로 적어야 합니다"
        )));
    }
    Ok(trimmed.to_owned())
}

pub(crate) fn validate_secret_value(value: &str) -> Result<(), CoreError> {
    if value.is_empty() {
        return Err(CoreError::InvalidInput("비밀값이 비어 있습니다".to_owned()));
    }
    if value.chars().count() > MAX_SECRET_VALUE_CHARS {
        return Err(CoreError::InvalidInput(format!(
            "비밀값은 {MAX_SECRET_VALUE_CHARS}자를 넘을 수 없습니다"
        )));
    }
    if value.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(CoreError::InvalidInput(
            "비밀값에는 줄바꿈이나 널 문자를 넣을 수 없습니다".to_owned(),
        ));
    }
    Ok(())
}

impl ChatSecretStore {
    /// C17. 저장된 비밀값을 함께 보는 보관소. 앱 데이터 폴더를 모르는 감독자(검사·일부
    /// 내장 실행)는 `None`을 받아 자동 사용이 일어나지 않는다.
    pub fn with_vault(app_data_dir: Option<PathBuf>) -> Self {
        Self {
            entries: Mutex::new(Vec::new()),
            vault: app_data_dir,
        }
    }

    /// C17. 저장해 둔 값을 이 대화로 실어 온다. 이미 들고 있으면 아무것도 하지 않고
    /// `false`다. 저장된 값이 없어도 `false` — 그때는 평소대로 카드를 띄울 차례다.
    pub fn hydrate_saved(&self, chat_id: &str, name: &str) -> Result<bool, CoreError> {
        validate_secret_name(name)?;
        let now = now_ms();
        let mut entries = self.lock_live(now)?;
        if entries.iter().any(|entry| entry.matches(chat_id, name)) {
            return Ok(false);
        }
        self.pull_saved(&mut entries, chat_id, name, now)
    }

    /// 저장된 값 하나를 메모리 목록에 밀어 넣는다. 대화당·전체 상한은 사용자가 직접 넣을
    /// 때와 같게 적용한다 — 자동으로 실려 온 값이라고 해서 자리를 더 쓸 이유는 없다.
    fn pull_saved(
        &self,
        entries: &mut Vec<StoredSecret>,
        chat_id: &str,
        name: &str,
        now: i64,
    ) -> Result<bool, CoreError> {
        let Some(app_data_dir) = self.vault.as_deref() else {
            return Ok(false);
        };
        let Some((purpose, value)) = crate::saved_secrets::take_for_use(app_data_dir, name)? else {
            return Ok(false);
        };
        if entries.iter().filter(|e| e.chat_id == chat_id).count() >= MAX_PER_CHAT
            || entries.len() >= MAX_ENTRIES
        {
            return Err(CoreError::Conflict(format!(
                "이 대화가 들 수 있는 비밀값은 {MAX_PER_CHAT}개까지입니다. 쓰지 않는 값을 지운 뒤 {name}을(를) 다시 쓰세요"
            )));
        }
        entries.push(StoredSecret {
            chat_id: chat_id.to_owned(),
            name: name.to_owned(),
            purpose,
            source: ChatSecretSource::Saved,
            value,
            expires_at: now + CHAT_SECRET_TTL_MS,
        });
        Ok(true)
    }

    /// 사용자가 준 값을 받아 둔다. 같은 (대화, 이름)에 이미 값이 있으면 갈아 끼운다 —
    /// 다시 입력했다는 것은 앞의 값이 틀렸거나 바뀌었다는 뜻이다.
    pub fn store(
        &self,
        chat_id: &str,
        name: &str,
        purpose: &str,
        value: &str,
        source: ChatSecretSource,
    ) -> Result<(), CoreError> {
        validate_secret_name(name)?;
        let purpose = validate_secret_purpose(purpose)?;
        validate_secret_value(value)?;
        let now = now_ms();
        let mut entries = self.lock_live(now)?;
        entries.retain(|entry| !entry.matches(chat_id, name));
        if entries
            .iter()
            .filter(|entry| entry.chat_id == chat_id)
            .count()
            >= MAX_PER_CHAT
        {
            return Err(CoreError::Conflict(format!(
                "이 대화가 들 수 있는 비밀값은 {MAX_PER_CHAT}개까지입니다. 쓰지 않는 값을 지운 뒤 다시 등록하세요"
            )));
        }
        if entries.len() >= MAX_ENTRIES {
            return Err(CoreError::Conflict(
                "들고 있는 비밀값이 너무 많습니다".to_owned(),
            ));
        }
        entries.push(StoredSecret {
            chat_id: chat_id.to_owned(),
            name: name.to_owned(),
            purpose,
            source,
            value: Zeroizing::new(value.to_owned()),
            expires_at: now + CHAT_SECRET_TTL_MS,
        });
        Ok(())
    }

    /// 이 대화가 그 이름의 값을 들고 있는지. 값은 돌려주지 않는다.
    pub fn holds(&self, chat_id: &str, name: &str) -> bool {
        self.lock_live(now_ms())
            .map(|entries| entries.iter().any(|entry| entry.matches(chat_id, name)))
            .unwrap_or(false)
    }

    /// C15-8. 사용자가 저장소 → 비밀정보 탭의 눈 아이콘으로 자기 값을 다시 볼 때 꺼낸다.
    /// 호스트 화면 전용 명령 하나만 이 함수로 이어지고, 에이전트가 닿는 어떤 도구도 여기로
    /// 오지 않는다. 값은 그대로 돌려주므로 호출자가 응답을 로그·전사에 남기면 안 된다.
    pub fn reveal_for_user(
        &self,
        chat_id: &str,
        name: &str,
    ) -> Result<Zeroizing<String>, CoreError> {
        let entries = self.lock_live(now_ms())?;
        entries
            .iter()
            .find(|entry| entry.matches(chat_id, name))
            .map(|entry| entry.value.clone())
            .ok_or_else(|| {
                CoreError::NotFound(format!("이 대화에 {name} 비밀값이 없거나 만료됐습니다"))
            })
    }

    /// 그 대화의 목록. 값은 어느 칸에도 없다.
    pub fn snapshot(&self, chat_id: &str) -> ChatSecretsSnapshot {
        let secrets = self
            .lock_live(now_ms())
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| entry.chat_id == chat_id)
                    .map(StoredSecret::summary)
                    .collect()
            })
            .unwrap_or_default();
        ChatSecretsSnapshot {
            chat_id: chat_id.to_owned(),
            secrets,
            ttl_seconds: CHAT_SECRET_TTL_MS / 1000,
        }
    }

    /// 실행 직전에 요청한 이름들의 값을 꺼낸다. 하나라도 없으면 아무것도 꺼내지 않고 어느
    /// 이름이 없는지 말한다 — 절반만 넣고 돈 명령은 사용자가 뜻하지 않은 곳으로 요청을
    /// 보낼 수 있다. 꺼낸 값의 수명은 지금부터 다시 TTL만큼 연장된다.
    fn take(
        &self,
        chat_id: &str,
        names: &[&str],
    ) -> Result<Vec<(String, Zeroizing<String>)>, CoreError> {
        let now = now_ms();
        let mut entries = self.lock_live(now)?;
        // C17. 이 대화가 아직 받지 못한 이름은 저장해 둔 값에서 먼저 찾는다. 저장의 목적이
        // 매번 같은 값을 다시 묻지 않는 것이므로, 실행 직전이 그 값을 실을 자리다.
        let absent: Vec<String> = names
            .iter()
            .copied()
            .filter(|name| !entries.iter().any(|entry| entry.matches(chat_id, name)))
            .map(str::to_owned)
            .collect();
        for name in &absent {
            self.pull_saved(&mut entries, chat_id, name, now)?;
        }
        let missing: Vec<&str> = names
            .iter()
            .copied()
            .filter(|name| !entries.iter().any(|entry| entry.matches(chat_id, name)))
            .collect();
        if !missing.is_empty() {
            return Err(CoreError::NotFound(format!(
                "이 대화에 없는 비밀값입니다: {}. list_chat_secrets로 이름을 확인하거나 request_chat_secret으로 사용자에게 요청하세요",
                missing.join(", ")
            )));
        }
        let mut taken = Vec::with_capacity(names.len());
        for entry in entries.iter_mut() {
            if entry.chat_id == chat_id && names.contains(&entry.name.as_str()) {
                entry.expires_at = now + CHAT_SECRET_TTL_MS;
                taken.push((entry.name.clone(), entry.value.clone()));
            }
        }
        Ok(taken)
    }

    /// 그 대화가 들고 있는 모든 값. 출력 정화에만 쓴다 — 어떤 이름을 넣었든 그 대화의
    /// 값이면 출력에서 지워야 한다.
    fn values_for_scrub(&self, chat_id: &str) -> Vec<Zeroizing<String>> {
        self.lock_live(now_ms())
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| entry.chat_id == chat_id)
                    .map(|entry| entry.value.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 그 이름의 값을 버린다.
    pub fn discard(&self, chat_id: &str, name: &str) -> Result<(), CoreError> {
        let mut entries = self.lock()?;
        let before = entries.len();
        entries.retain(|entry| !entry.matches(chat_id, name));
        if entries.len() == before {
            return Err(CoreError::NotFound(format!(
                "이 대화에 {name} 비밀값이 없습니다"
            )));
        }
        Ok(())
    }

    /// 그 대화의 값을 모두 버린다. 대화가 끝나면 그 맥락에서 받은 값도 끝난다.
    pub fn discard_chat(&self, chat_id: &str) {
        if let Ok(mut entries) = self.lock() {
            entries.retain(|entry| entry.chat_id != chat_id);
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Vec<StoredSecret>>, CoreError> {
        self.entries
            .lock()
            .map_err(|_| CoreError::Runtime("비밀값 저장소를 잠그지 못했습니다".to_owned()))
    }

    fn lock_live(&self, now: i64) -> Result<MutexGuard<'_, Vec<StoredSecret>>, CoreError> {
        let mut entries = self.lock()?;
        entries.retain(|entry| !entry.expired(now));
        Ok(entries)
    }
}

// ---------------------------------------------------------------------------
// 요청 카드
// ---------------------------------------------------------------------------

/// 승인 카드의 종류. 프런트가 이 값으로 입력칸 문구를 가른다.
pub const SECRET_REQUEST_CARD_KIND: &str = "secretRequest";

/// 에이전트가 낸 비밀값 요청 하나. 값은 이 구조체에 담기지 않는다 — 카드는 채팅 이벤트로
/// 나가므로 비밀값이 지나면 안 되고, 사용자가 입력한 값은 응답 경로에서 곧장
/// [`ChatSecretStore`]로 간다.
#[derive(Clone, Debug)]
struct PendingSecretRequest {
    id: String,
    chat_id: String,
    name: String,
    purpose: String,
    expires_at: i64,
    granted: Option<bool>,
    consumed: bool,
}

impl PendingSecretRequest {
    fn card(&self) -> SecretRequestCard {
        SecretRequestCard {
            id: self.id.clone(),
            kind: SECRET_REQUEST_CARD_KIND.to_owned(),
            title: "비밀값 입력 요청".to_owned(),
            detail: format!(
                "에이전트가 `{}` 이름의 비밀값을 요청했습니다.\n\n용도: {}\n\n입력한 값은 에이전트에게 전달되지 않습니다. 이 대화에서 앱이 실행을 대신할 때 환경변수 `{}`로만 넣습니다. 기기에 남겨 다음 대화에서도 이 이름으로 쓰려면 '비밀값 저장'을 함께 선택하세요.",
                self.name, self.purpose, self.name
            ),
            name: self.name.clone(),
            expires_at: self.expires_at,
        }
    }

    fn ticket(&self) -> SecretRequestTicket {
        SecretRequestTicket {
            approval_id: self.id.clone(),
            name: self.name.clone(),
            expires_at: self.expires_at,
        }
    }
}

impl ApprovalEntry for PendingSecretRequest {
    const WORDING: ApprovalWording = ApprovalWording {
        subject: "비밀값",
        retry_noun: "요청",
    };

    type Decision = SecretRequestDecision;

    fn chat_id(&self) -> &str {
        &self.chat_id
    }

    fn expires_at(&self) -> i64 {
        self.expires_at
    }

    fn is_consumed(&self) -> bool {
        self.consumed
    }

    fn granted(&self) -> Option<bool> {
        self.granted
    }

    fn set_granted(&mut self, granted: bool) {
        self.granted = Some(granted);
        // 답을 받은 카드는 그 자리에서 끝난다. 실행 토큰과 달리 두 번째 걸음이 없다.
        self.consumed = true;
    }

    fn mark_consumed(&mut self) {
        self.consumed = true;
    }

    fn decision(&self, granted: bool) -> SecretRequestDecision {
        SecretRequestDecision {
            id: self.id.clone(),
            granted,
            name: self.name.clone(),
            purpose: self.purpose.clone(),
        }
    }
}

/// 화면으로 나가는 카드.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretRequestCard {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub name: String,
    pub expires_at: i64,
}

/// 에이전트에게 돌아가는 값. 값 자체는 없고 "카드를 띄웠다"만 있다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRequestTicket {
    pub approval_id: String,
    pub name: String,
    pub expires_at: i64,
}

/// 요청의 결과. 카드를 띄웠거나, 이미 들고 있어 띄울 필요가 없었거나.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum SecretRequestOutcome {
    /// 카드를 띄웠다. 에이전트는 사용자의 답을 기다렸다가 안내를 받은 뒤 실행을 맡긴다.
    Requested(SecretRequestTicket),
    /// 이미 이 대화가 그 이름의 값을 들고 있다. 바로 실행을 맡기면 된다.
    AlreadyHeld { name: String },
    /// C17. 사용자가 저장해 둔 값을 앱이 이 대화로 실어 왔다. 카드는 뜨지 않았고, 에이전트는
    /// 곧장 실행을 맡기면 된다. 값은 여기에도 없다.
    SavedValueUsed { name: String },
}

/// 사용자의 결정.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SecretRequestDecision {
    pub id: String,
    pub granted: bool,
    pub name: String,
    pub purpose: String,
}

/// 대화별 비밀값 요청 장부. 규칙은 [`ApprovalLedger`]가 지킨다.
#[derive(Debug, Default)]
pub struct SecretRequestStore {
    entries: ApprovalLedger<PendingSecretRequest>,
}

impl SecretRequestStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 요청을 하나 연다. 같은 대화에서 같은 이름의 요청이 아직 답을 기다리면 그 카드를
    /// 돌려준다.
    pub fn open(
        &self,
        chat_id: &str,
        name: &str,
        purpose: &str,
    ) -> Result<(SecretRequestTicket, SecretRequestCard), CoreError> {
        validate_secret_name(name)?;
        let purpose = validate_secret_purpose(purpose)?;
        let now = now_ms();
        self.entries.open(
            chat_id,
            now,
            |entry| entry.name == name,
            || {
                let entry = PendingSecretRequest {
                    id: format!("secret-request-{}", Uuid::new_v4()),
                    chat_id: chat_id.to_owned(),
                    name: name.to_owned(),
                    purpose: purpose.clone(),
                    expires_at: now + SECRET_REQUEST_TTL_MS,
                    granted: None,
                    consumed: false,
                };
                (entry.id.clone(), entry)
            },
            |entry| (entry.ticket(), entry.card()),
        )
    }

    pub fn owns(&self, approval_id: &str) -> bool {
        self.entries.owns(approval_id)
    }

    pub fn resolve(
        &self,
        chat_id: &str,
        approval_id: &str,
        granted: bool,
    ) -> Result<SecretRequestDecision, CoreError> {
        self.entries
            .resolve(chat_id, approval_id, now_ms(), granted)
    }

    pub fn discard_chat(&self, chat_id: &str) {
        self.entries.discard_chat(chat_id);
    }
}

// ---------------------------------------------------------------------------
// 대행 실행
// ---------------------------------------------------------------------------

/// 값이 들어갈 자리를 텍스트 안에 적는 표기. `{{secret:API_KEY}}`처럼 쓴다. 인자·stdin·
/// 파일 내용 어디에 있든 백엔드가 값으로 바꾸므로, 에이전트는 "값이 여기 들어간다"만 적는다.
pub const PLACEHOLDER_OPEN: &str = "{{secret:";
pub const PLACEHOLDER_CLOSE: &str = "}}";

/// 텍스트 안의 자리표시자가 가리키는 이름들. 중복은 하나로 센다. 이름 규칙에 어긋나는
/// 표기는 자리표시자로 보지 않고 그대로 둔다 — 조용히 넘어가면 값이 안 들어간 채 나가므로
/// 오류로 알린다.
pub(crate) fn placeholder_names(text: &str) -> Result<Vec<String>, CoreError> {
    let mut names: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find(PLACEHOLDER_OPEN) {
        let after = &rest[start + PLACEHOLDER_OPEN.len()..];
        let Some(end) = after.find(PLACEHOLDER_CLOSE) else {
            return Err(CoreError::InvalidInput(
                "닫히지 않은 자리표시자가 있습니다. `{{secret:이름}}` 모양이어야 합니다".to_owned(),
            ));
        };
        let name = &after[..end];
        validate_secret_name(name).map_err(|_| {
            CoreError::InvalidInput(format!(
                "자리표시자 이름이 규칙에 맞지 않습니다: {{{{secret:{name}}}}}"
            ))
        })?;
        if !names.iter().any(|known| known == name) {
            names.push(name.to_owned());
        }
        rest = &after[end + PLACEHOLDER_CLOSE.len()..];
    }
    Ok(names)
}

/// 자리표시자를 값으로 바꾼다. 꺼내 온 값에 없는 이름은 [`placeholder_names`]와 `take`가
/// 먼저 걸러 여기까지 오지 않는다.
fn substitute(text: &str, taken: &[(String, Zeroizing<String>)]) -> Zeroizing<String> {
    let mut out = text.to_owned();
    for (name, value) in taken {
        let token = format!("{PLACEHOLDER_OPEN}{name}{PLACEHOLDER_CLOSE}");
        out = out.replace(&token, value.as_str());
    }
    Zeroizing::new(out)
}

/// 에이전트가 맡기는 실행 한 건.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSecretRunRequest {
    /// 실행 파일과 인자. 첫 원소는 PATH에서 찾거나 절대 경로여야 한다. 셸 문자열이 아니다(G9).
    /// 두 번째 원소부터는 `{{secret:이름}}` 자리표시자를 쓸 수 있다.
    pub command: Vec<String>,
    /// 환경변수 이름 → 비밀값 이름. `{"OPENAI_API_KEY": "OPENAI"}`처럼 서로 다를 수 있다.
    /// 자리표시자만으로 충분하면 비워도 된다.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// 자식의 표준 입력으로 넣을 텍스트. 자리표시자를 쓸 수 있다.
    #[serde(default)]
    pub stdin: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

/// 에이전트가 맡기는 파일 쓰기 한 건. 설정 파일·`.env`처럼 값이 파일 안에 있어야 하는
/// 경우다. 내용의 `{{secret:이름}}` 자리에 값을 넣어 쓴다.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSecretFileRequest {
    /// `~`를 펼친 절대 경로. 상위 폴더가 이미 있어야 한다.
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub overwrite: bool,
}

// 내용에 자리표시자 말고 다른 비밀이 섞여 있을 수 있어 찍지 않는다.
impl std::fmt::Debug for ChatSecretFileRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChatSecretFileRequest")
            .field("path", &self.path)
            .field("overwrite", &self.overwrite)
            .finish_non_exhaustive()
    }
}

/// 파일 쓰기 영수증. 내용은 되돌려 주지 않는다.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSecretFileReceipt {
    pub path: String,
    pub bytes: u64,
    pub replaced: bool,
    /// 값을 넣은 자리표시자 이름.
    pub injected: Vec<String>,
}

/// 파일 내용 상한. 설정 파일 한 장 분량이다.
const MAX_FILE_CONTENT_BYTES: usize = 256 * 1024;

/// C15. 자리표시자를 값으로 채운 파일을 쓴다. 쓰기 경계는 SSH 다운로드가 로컬에 쓰는
/// 경계와 같다 — `~`를 펼친 절대 경로, `..` 없음, 상위 폴더가 이미 있어야 하고, 공급자
/// 홈·앱 데이터·자격증명 자리는 거절한다. 파일은 소유자만 읽는 권한으로 원자적으로 놓인다.
///
/// 이 파일은 에이전트가 읽을 수 있는 자리에 놓인다. 그것이 이 작업의 목적이다 — 값을
/// 파일에 두어야 도는 도구가 있고, 사용자는 용도를 카드에서 읽고 값을 건넸다. 그래서
/// 자리표시자가 하나도 없는 내용은 거절한다: 값 없는 쓰기는 에이전트의 다른 도구가 한다.
pub fn write_file_with_chat_secrets(
    store: &ChatSecretStore,
    app_data_dir: &Path,
    home: &Path,
    chat_id: &str,
    request: ChatSecretFileRequest,
) -> Result<ChatSecretFileReceipt, CoreError> {
    if request.content.len() > MAX_FILE_CONTENT_BYTES {
        return Err(CoreError::InvalidInput(format!(
            "파일 내용은 {}KiB를 넘을 수 없습니다",
            MAX_FILE_CONTENT_BYTES / 1024
        )));
    }
    let names = placeholder_names(&request.content)?;
    if names.is_empty() {
        return Err(CoreError::InvalidInput(
            "내용에 `{{secret:이름}}` 자리표시자가 없습니다. 비밀값이 들어가지 않는 파일은 이 경로로 쓰지 말고 직접 쓰세요".to_owned(),
        ));
    }
    let path = resolve_file_target(app_data_dir, home, &request.path)?;
    let replaced = path.exists();
    if replaced && !request.overwrite {
        return Err(CoreError::Conflict(format!(
            "{} 파일이 이미 있습니다. 덮어쓰려면 overwrite를 true로 다시 요청하세요",
            path.display()
        )));
    }
    let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let taken = store.take(chat_id, &name_refs)?;
    let filled = substitute(&request.content, &taken);
    drop(taken);
    crate::app_data_file::write_private_bytes(&path, filled.as_bytes())?;
    Ok(ChatSecretFileReceipt {
        path: path.to_string_lossy().into_owned(),
        bytes: filled.len() as u64,
        replaced,
        injected: names,
    })
}

/// 파일을 놓을 자리. 상위를 정규화한 뒤 이름을 붙여 심볼릭 링크로 경계를 넘지 못하게 한다.
fn resolve_file_target(app_data_dir: &Path, home: &Path, raw: &str) -> Result<PathBuf, CoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(
            "파일 경로가 비어 있거나 제어 문자를 담고 있습니다".to_owned(),
        ));
    }
    let expanded = if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        home.join(rest)
    } else if trimmed == "~" {
        home.to_path_buf()
    } else {
        PathBuf::from(trimmed)
    };
    if !expanded.is_absolute() {
        return Err(CoreError::InvalidInput(
            "파일 경로는 절대 경로여야 합니다".to_owned(),
        ));
    }
    if expanded
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(CoreError::InvalidInput(
            "파일 경로에 `..`을 쓸 수 없습니다".to_owned(),
        ));
    }
    let file_name = expanded
        .file_name()
        .ok_or_else(|| CoreError::InvalidInput("파일 이름이 없습니다".to_owned()))?
        .to_owned();
    let parent = expanded
        .parent()
        .ok_or_else(|| CoreError::InvalidInput("상위 폴더가 없습니다".to_owned()))?;
    let parent = crate::path_guard::canonical_child_facing(parent).map_err(|_| {
        CoreError::NotFound(format!(
            "상위 폴더가 없습니다: {}. 폴더를 만들어 주지 않으니 있는 폴더를 지정하세요",
            parent.display()
        ))
    })?;
    // 아직 없는 파일은 정규화되지 않아 보호 폴더와 표기가 어긋날 수 있다(Windows `\\?\`
    // 접두). 실제로 있는 상위 폴더로 경계를 먼저 대조하고, 이름 조각 검사는 전체 경로로 한다.
    crate::ssh_exec::assert_local_path_allowed(app_data_dir, &parent)?;
    let path = parent.join(file_name);
    crate::ssh_exec::assert_local_path_allowed(app_data_dir, &path)?;
    if path.is_symlink() || path.is_dir() {
        return Err(CoreError::InvalidInput(
            "그 자리에 심볼릭 링크나 폴더가 있어 파일을 쓸 수 없습니다".to_owned(),
        ));
    }
    Ok(path)
}

/// 실행 영수증. 출력은 그 대화의 비밀값을 지운 뒤 실린다.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSecretRunReceipt {
    pub executable: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    /// 실제로 넣은 환경변수 이름. 값은 없다.
    pub injected: Vec<String>,
}

/// 실행 파일 이름을 절대 경로로 푼다. 경로 구분자가 있으면 그대로(절대 경로만), 없으면
/// PATH에서 찾는다. 셸을 거치지 않으므로 별칭·내장 명령은 실행되지 않는다.
fn resolve_executable(name: &str) -> Result<PathBuf, CoreError> {
    if name.is_empty() {
        return Err(CoreError::InvalidInput(
            "실행할 명령이 비어 있습니다".to_owned(),
        ));
    }
    let candidate = Path::new(name);
    if name.contains('/') || name.contains('\\') {
        if !candidate.is_absolute() {
            return Err(CoreError::InvalidInput(format!(
                "실행 파일은 이름만 주거나 절대 경로여야 합니다: {name}"
            )));
        }
        return candidate
            .is_file()
            .then(|| candidate.to_path_buf())
            .ok_or_else(|| CoreError::NotFound(format!("실행 파일이 없습니다: {name}")));
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_owned())
            .split(';')
            .filter(|ext| !ext.is_empty())
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    for dir in std::env::split_paths(&path) {
        let base = dir.join(name);
        if base.is_file() {
            return Ok(base);
        }
        for ext in &extensions {
            let with_ext = dir.join(format!("{name}{ext}"));
            if with_ext.is_file() {
                return Ok(with_ext);
            }
        }
    }
    Err(CoreError::NotFound(format!(
        "PATH에서 실행 파일을 찾지 못했습니다: {name}"
    )))
}

/// 회수한 텍스트에서 비밀값을 지운다. 정확 일치만 잡는다.
pub(crate) fn scrub(text: &str, secrets: &[Zeroizing<String>]) -> String {
    let mut scrubbed = text.to_owned();
    for secret in secrets {
        if secret.len() >= 4 {
            scrubbed = scrubbed.replace(secret.as_str(), REDACTED);
        }
    }
    scrubbed
}

fn tail(text: &str, chars: usize) -> (String, bool) {
    let count = text.chars().count();
    if count <= chars {
        return (text.to_owned(), false);
    }
    (text.chars().skip(count - chars).collect(), true)
}

/// 명령을 그 대화의 비밀값을 환경변수로 넣어 실행하고, 출력에서 값을 지운 영수증을 돌려준다.
pub fn run_with_chat_secrets(
    store: &ChatSecretStore,
    chat_id: &str,
    request: ChatSecretRunRequest,
) -> Result<ChatSecretRunReceipt, CoreError> {
    // 인자(첫 원소 제외)와 stdin의 자리표시자. 값이 들어갈 곳이 env에도 여기에도 없으면
    // 이 경로로 돌릴 이유가 없다.
    let mut placeholder_refs: Vec<String> = Vec::new();
    for text in request.command.iter().skip(1).chain(request.stdin.iter()) {
        for name in placeholder_names(text)? {
            if !placeholder_refs.contains(&name) {
                placeholder_refs.push(name);
            }
        }
    }
    if request.env.is_empty() && placeholder_refs.is_empty() {
        return Err(CoreError::InvalidInput(
            "env도 `{{secret:이름}}` 자리표시자도 없습니다. 비밀값을 넣지 않는 명령은 이 경로로 돌리지 말고 직접 실행하세요"
                .to_owned(),
        ));
    }
    if request.env.len() > MAX_INJECTIONS {
        return Err(CoreError::InvalidInput(format!(
            "한 실행에 넣을 수 있는 환경변수는 {MAX_INJECTIONS}개까지입니다"
        )));
    }
    for (env_name, secret_name) in &request.env {
        validate_secret_name(env_name).map_err(|_| {
            CoreError::InvalidInput(format!(
                "환경변수 이름은 대문자로 시작하고 대문자·숫자·밑줄만 쓸 수 있습니다: {env_name:?}"
            ))
        })?;
        validate_secret_name(secret_name)?;
        if crate::credential_profiles::CREDENTIAL_ENV_KEYS.contains(&env_name.as_str()) {
            return Err(CoreError::InvalidInput(format!(
                "{env_name}은(는) 앱이 계정 격리에 쓰는 이름이라 덮을 수 없습니다"
            )));
        }
    }
    let Some(program) = request.command.first() else {
        return Err(CoreError::InvalidInput(
            "command가 비어 있습니다".to_owned(),
        ));
    };
    let executable = resolve_executable(program)?;
    let cwd = match request.cwd.as_deref() {
        Some(raw) => {
            let dir = PathBuf::from(raw);
            if !dir.is_absolute() {
                return Err(CoreError::InvalidInput(
                    "작업 폴더는 절대 경로여야 합니다".to_owned(),
                ));
            }
            if !dir.is_dir() {
                return Err(CoreError::NotFound(format!(
                    "작업 폴더가 없습니다: {}",
                    dir.display()
                )));
            }
            Some(dir)
        }
        None => None,
    };
    let timeout = Duration::from_secs(
        request
            .timeout_seconds
            .unwrap_or(DEFAULT_RUN_TIMEOUT_SECONDS)
            .clamp(1, MAX_RUN_TIMEOUT_SECONDS),
    );
    let mut secret_names: Vec<&str> = request.env.values().map(String::as_str).collect();
    for name in &placeholder_refs {
        if !secret_names.contains(&name.as_str()) {
            secret_names.push(name);
        }
    }
    let taken = store.take(chat_id, &secret_names)?;

    let mut command = Command::new(&executable);
    let filled_args: Vec<Zeroizing<String>> = request.command[1..]
        .iter()
        .map(|arg| substitute(arg, &taken))
        .collect();
    for arg in &filled_args {
        command.arg(arg.as_str());
    }
    drop(filled_args);
    let stdin_payload = request
        .stdin
        .as_deref()
        .map(|text| substitute(text, &taken));
    if let Some(dir) = &cwd {
        command.current_dir(dir);
    }
    if let Some(path) = crate::providers::command_search_path(&executable) {
        command.env("PATH", path);
    }
    command
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1");
    crate::credential_profiles::strip_inherited_credential_env(&mut command);
    crate::chat::configure_no_window_command(&mut command);
    let mut injected = Vec::with_capacity(request.env.len() + placeholder_refs.len());
    for (env_name, secret_name) in &request.env {
        if let Some((_, value)) = taken.iter().find(|(name, _)| name == secret_name) {
            command.env(env_name, value.as_str());
            injected.push(env_name.clone());
        }
    }
    for name in &placeholder_refs {
        injected.push(format!("{PLACEHOLDER_OPEN}{name}{PLACEHOLDER_CLOSE}"));
    }
    drop(taken);

    let mut child = command.spawn().map_err(|error| {
        CoreError::Runtime(format!(
            "명령을 시작하지 못했습니다({}): {error}",
            executable.display()
        ))
    })?;
    if let (Some(payload), Some(mut stdin)) = (stdin_payload, child.stdin.take()) {
        use std::io::Write as _;
        // 자식이 다 읽기 전에 죽어도 쓰기 오류로 우리가 죽으면 안 된다.
        let _ = stdin.write_all(payload.as_bytes());
        drop(stdin);
    }
    let readers = CappedOutputReaders::spawn(child.stdout.take(), child.stderr.take());
    let started = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break Some(status),
            None if started.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    let (stdout, stderr) = readers.finish();
    let secrets = store.values_for_scrub(chat_id);
    let (stdout, stdout_cut) = tail(
        &scrub(&String::from_utf8_lossy(&stdout), &secrets),
        OUTPUT_TAIL_CHARS,
    );
    let (stderr, stderr_cut) = tail(
        &scrub(&String::from_utf8_lossy(&stderr), &secrets),
        OUTPUT_TAIL_CHARS,
    );
    Ok(ChatSecretRunReceipt {
        executable: executable.to_string_lossy().into_owned(),
        exit_code: status.and_then(|status| status.code()),
        success: status.map(|status| status.success()).unwrap_or(false),
        timed_out,
        stdout,
        stderr,
        truncated: stdout_cut || stderr_cut,
        injected,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAT: &str = "chat-1";

    fn store() -> ChatSecretStore {
        ChatSecretStore::with_vault(None)
    }

    #[test]
    fn stores_and_lists_without_values() {
        let store = store();
        store
            .store(
                CHAT,
                "API_KEY",
                "결제 API",
                "sk-live-1234",
                ChatSecretSource::User,
            )
            .expect("store");
        let snapshot = store.snapshot(CHAT);
        assert_eq!(snapshot.secrets.len(), 1);
        assert_eq!(snapshot.secrets[0].name, "API_KEY");
        assert_eq!(snapshot.secrets[0].purpose, "결제 API");
        let json = serde_json::to_string(&snapshot).expect("json");
        assert!(!json.contains("sk-live"), "목록에 값이 실리면 안 된다");
        assert!(store.holds(CHAT, "API_KEY"));
    }

    #[test]
    fn another_chat_cannot_see_the_secret() {
        let store = store();
        store
            .store(CHAT, "API_KEY", "용도", "value-1", ChatSecretSource::User)
            .expect("store");
        assert!(!store.holds("chat-2", "API_KEY"));
        assert!(store.snapshot("chat-2").secrets.is_empty());
        assert!(store.take("chat-2", &["API_KEY"]).is_err());
    }

    #[test]
    fn take_refuses_when_any_name_is_missing() {
        let store = store();
        store
            .store(CHAT, "A", "용도", "value-a", ChatSecretSource::User)
            .expect("store");
        let error = store.take(CHAT, &["A", "B"]).expect_err("B가 없다");
        assert!(error.to_string().contains("B"));
    }

    #[test]
    fn restoring_replaces_the_previous_value() {
        let store = store();
        store
            .store(CHAT, "A", "용도", "old-value", ChatSecretSource::User)
            .expect("store");
        store
            .store(CHAT, "A", "용도2", "new-value", ChatSecretSource::Agent)
            .expect("store");
        let taken = store.take(CHAT, &["A"]).expect("take");
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].1.as_str(), "new-value");
        assert_eq!(
            store.snapshot(CHAT).secrets[0].source,
            ChatSecretSource::Agent
        );
    }

    #[test]
    fn name_rules_are_enforced() {
        assert!(validate_secret_name("API_KEY").is_ok());
        assert!(validate_secret_name("A1_B2").is_ok());
        assert!(validate_secret_name("api_key").is_err());
        assert!(validate_secret_name("1KEY").is_err());
        assert!(validate_secret_name("").is_err());
        assert!(validate_secret_name("KEY-1").is_err());
        assert!(validate_secret_name(&"A".repeat(65)).is_err());
    }

    #[test]
    fn value_rules_are_enforced() {
        let store = store();
        assert!(store
            .store(CHAT, "A", "용도", "", ChatSecretSource::User)
            .is_err());
        assert!(store
            .store(CHAT, "A", "용도", "line\nbreak", ChatSecretSource::User)
            .is_err());
        assert!(store
            .store(CHAT, "A", "", "value", ChatSecretSource::User)
            .is_err());
    }

    #[test]
    fn discard_chat_drops_every_secret_of_that_chat() {
        let store = store();
        store
            .store(CHAT, "A", "용도", "value-a", ChatSecretSource::User)
            .expect("store");
        store
            .store("chat-2", "A", "용도", "value-b", ChatSecretSource::User)
            .expect("store");
        store.discard_chat(CHAT);
        assert!(!store.holds(CHAT, "A"));
        assert!(store.holds("chat-2", "A"));
    }

    #[test]
    fn discard_reports_missing_name() {
        let store = store();
        assert!(store.discard(CHAT, "NOPE").is_err());
    }

    #[test]
    fn scrub_removes_exact_values_only() {
        let secrets = vec![
            Zeroizing::new("hunter2secret".to_owned()),
            Zeroizing::new("ab".to_owned()),
        ];
        let scrubbed = scrub("token=hunter2secret ab", &secrets);
        assert_eq!(scrubbed, format!("token={REDACTED} ab"));
    }

    #[test]
    fn debug_output_hides_values() {
        let store = store();
        store
            .store(CHAT, "A", "용도", "very-secret", ChatSecretSource::User)
            .expect("store");
        let debug = format!("{store:?}");
        assert!(!debug.contains("very-secret"));
        assert!(debug.contains("held: 1"));
    }

    #[test]
    fn request_opens_once_per_name_and_resolves() {
        let requests = SecretRequestStore::new();
        let (ticket, card) = requests
            .open(CHAT, "API_KEY", "결제 API 호출")
            .expect("open");
        assert_eq!(card.kind, SECRET_REQUEST_CARD_KIND);
        assert!(card.detail.contains("API_KEY"));
        let (again, _) = requests
            .open(CHAT, "API_KEY", "결제 API 호출")
            .expect("open");
        assert_eq!(
            ticket.approval_id, again.approval_id,
            "같은 이름은 카드 한 장"
        );
        assert!(requests.owns(&ticket.approval_id));
        let decision = requests
            .resolve(CHAT, &ticket.approval_id, true)
            .expect("resolve");
        assert!(decision.granted);
        assert_eq!(decision.name, "API_KEY");
        assert!(
            requests.resolve(CHAT, &ticket.approval_id, true).is_err(),
            "답한 카드는 다시 답할 수 없다"
        );
    }

    #[test]
    fn request_from_another_chat_cannot_be_resolved() {
        let requests = SecretRequestStore::new();
        let (ticket, _) = requests.open(CHAT, "API_KEY", "용도").expect("open");
        assert!(requests
            .resolve("chat-2", &ticket.approval_id, true)
            .is_err());
    }

    fn run_request(command: Vec<String>, env: BTreeMap<String, String>) -> ChatSecretRunRequest {
        ChatSecretRunRequest {
            command,
            env,
            stdin: None,
            cwd: None,
            timeout_seconds: Some(30),
        }
    }

    #[test]
    fn run_rejects_empty_env_and_reserved_names() {
        let store = store();
        let request = run_request(vec!["true".to_owned()], BTreeMap::new());
        assert!(run_with_chat_secrets(&store, CHAT, request).is_err());
        let mut env = BTreeMap::new();
        env.insert("CODEX_HOME".to_owned(), "A".to_owned());
        let request = run_request(vec!["true".to_owned()], env);
        assert!(run_with_chat_secrets(&store, CHAT, request).is_err());
    }

    #[test]
    fn placeholders_are_parsed_and_validated() {
        assert_eq!(
            placeholder_names("a {{secret:ONE}} b {{secret:TWO}} {{secret:ONE}}").expect("names"),
            vec!["ONE".to_owned(), "TWO".to_owned()]
        );
        assert!(placeholder_names("plain text").expect("none").is_empty());
        assert!(placeholder_names("{{secret:lower}}").is_err());
        assert!(placeholder_names("{{secret:OPEN").is_err());
    }

    #[test]
    fn run_substitutes_placeholders_in_arguments_and_stdin() {
        let store = store();
        store
            .store(
                CHAT,
                "TOKEN",
                "용도",
                "hunter2secret",
                ChatSecretSource::User,
            )
            .expect("store");
        let command = if cfg!(windows) {
            vec![
                "cmd".to_owned(),
                "/c".to_owned(),
                "echo arg={{secret:TOKEN}}".to_owned(),
            ]
        } else {
            vec![
                "sh".to_owned(),
                "-c".to_owned(),
                "echo arg={{secret:TOKEN}}; cat".to_owned(),
            ]
        };
        let mut request = run_request(command, BTreeMap::new());
        request.stdin = Some("in={{secret:TOKEN}}\n".to_owned());
        let receipt = run_with_chat_secrets(&store, CHAT, request).expect("run");
        assert!(receipt.success, "{receipt:?}");
        assert!(!receipt.stdout.contains("hunter2secret"));
        assert!(
            receipt.stdout.contains(&format!("arg={REDACTED}")),
            "{}",
            receipt.stdout
        );
        assert!(receipt.injected.iter().any(|name| name.contains("TOKEN")));
    }

    #[test]
    fn write_file_fills_placeholders_and_keeps_boundaries() {
        let store = store();
        store
            .store(
                CHAT,
                "API_KEY",
                "용도",
                "sk-live-1234567",
                ChatSecretSource::User,
            )
            .expect("store");
        let temporary = tempfile::tempdir().expect("tempdir");
        let app_data = temporary.path().join("app-data");
        std::fs::create_dir_all(&app_data).expect("app data");
        let home = temporary.path().join("home");
        std::fs::create_dir_all(home.join("proj")).expect("home");
        let request = |path: String, overwrite: bool| ChatSecretFileRequest {
            path,
            content: "API_KEY={{secret:API_KEY}}\nOTHER=1\n".to_owned(),
            overwrite,
        };
        let target = home.join("proj").join(".env");
        let receipt = write_file_with_chat_secrets(
            &store,
            &app_data,
            &home,
            CHAT,
            request(target.to_string_lossy().into_owned(), false),
        )
        .expect("write");
        assert_eq!(receipt.injected, vec!["API_KEY".to_owned()]);
        assert!(!receipt.replaced);
        let written = std::fs::read_to_string(&target).expect("read");
        assert_eq!(written, "API_KEY=sk-live-1234567\nOTHER=1\n");
        // 같은 자리에 다시 쓰려면 overwrite가 있어야 한다.
        assert!(write_file_with_chat_secrets(
            &store,
            &app_data,
            &home,
            CHAT,
            request(target.to_string_lossy().into_owned(), false),
        )
        .is_err());
        assert!(
            write_file_with_chat_secrets(
                &store,
                &app_data,
                &home,
                CHAT,
                request(target.to_string_lossy().into_owned(), true),
            )
            .expect("overwrite")
            .replaced
        );
        // `~` 확장, 없는 상위 폴더, 앱 데이터 폴더, 자리표시자 없는 내용은 거절된다.
        assert!(write_file_with_chat_secrets(
            &store,
            &app_data,
            &home,
            CHAT,
            request("~/proj/.env".to_owned(), true),
        )
        .is_ok());
        assert!(write_file_with_chat_secrets(
            &store,
            &app_data,
            &home,
            CHAT,
            request(
                home.join("missing")
                    .join("x")
                    .to_string_lossy()
                    .into_owned(),
                true
            ),
        )
        .is_err());
        assert!(write_file_with_chat_secrets(
            &store,
            &app_data,
            &home,
            CHAT,
            request(app_data.join("x").to_string_lossy().into_owned(), true),
        )
        .is_err());
        assert!(write_file_with_chat_secrets(
            &store,
            &app_data,
            &home,
            CHAT,
            ChatSecretFileRequest {
                path: target.to_string_lossy().into_owned(),
                content: "no placeholder".to_owned(),
                overwrite: true,
            },
        )
        .is_err());
    }

    #[test]
    fn run_injects_env_and_scrubs_output() {
        let store = store();
        store
            .store(
                CHAT,
                "TOKEN",
                "용도",
                "hunter2secret",
                ChatSecretSource::User,
            )
            .expect("store");
        let mut env = BTreeMap::new();
        env.insert("MY_TOKEN".to_owned(), "TOKEN".to_owned());
        let command = if cfg!(windows) {
            vec![
                "cmd".to_owned(),
                "/c".to_owned(),
                "echo value=%MY_TOKEN%".to_owned(),
            ]
        } else {
            vec![
                "sh".to_owned(),
                "-c".to_owned(),
                "echo value=$MY_TOKEN".to_owned(),
            ]
        };
        let receipt = run_with_chat_secrets(&store, CHAT, run_request(command, env)).expect("run");
        assert!(receipt.success, "{receipt:?}");
        assert!(!receipt.stdout.contains("hunter2secret"));
        assert!(receipt.stdout.contains(REDACTED), "{}", receipt.stdout);
        assert_eq!(receipt.injected, vec!["MY_TOKEN".to_owned()]);
    }

    #[test]
    fn run_refuses_missing_secret_without_spawning() {
        let store = store();
        let mut env = BTreeMap::new();
        env.insert("X".to_owned(), "MISSING".to_owned());
        let error = run_with_chat_secrets(
            &store,
            CHAT,
            run_request(vec!["definitely-not-a-real-binary-xyz".to_owned()], env),
        )
        .expect_err("실행 파일을 찾기 전에 비밀값 검증이 아니라 실행 파일이 없어 실패한다");
        assert!(matches!(error, CoreError::NotFound(_)));
    }
}
