//! 화면이 문구를 스스로 정할 수 있는 오류 — 안정 코드 하나와 이름 붙은 파라미터.
//!
//! # 왜 필요한가
//!
//! 지금까지 백엔드 실패는 한국어 문장 하나로 화면에 도착했다. 정적 치환기는 오류 배너를
//! 건너뛰므로(`i18nStaticUi.tsx`의 `.error-banner`) 그 문장은 어느 언어에서도 한국어로
//! 남는다. 배너 안을 DOM에서 되짚어 고치는 길은 막혀 있다 — 배너에는 백엔드가 만든
//! 동적 문자열(경로·ID·개수)이 섞여 있어 대응표가 맞힐 수 있는 문구가 아니다.
//!
//! 그래서 **무엇이 실패했는지**(코드와 파라미터)와 **그것을 어떻게 말하는지**(문장)를
//! 가른다. 백엔드는 앞의 것을 보내고, 화면이 뒤의 것을 고른다.
//!
//! # 구조
//!
//! 오류 하나는 세 조각이다.
//!
//! - `code` — 화면이 문구를 고르는 열쇠. `<도메인>_<사유>` 꼴의 대문자 스네이크이며 한
//!   번 내보낸 코드는 뜻을 바꾸지 않는다. 뜻이 바뀌면 새 코드를 만든다.
//! - `params` — 문장에 끼워 넣을 이름 붙은 값(`id`, `max`, …). 화면 템플릿의 `{이름}`
//!   자리와 이름으로 맞춘다. 순서에 기대지 않으므로 언어마다 어순이 달라도 된다.
//! - `message` — 같은 뜻의 한국어 문장. 코드를 모르는 소비자(로그, Tauri 명령의
//!   `Result<_, String>`, 기존 Rust 테스트)가 그대로 읽는다.
//!
//! `message`를 함께 보내는 것은 의도한 선택이다. 화면은 한국어일 때 이 문장을 그대로 쓰고,
//! 다른 언어일 때만 코드로 자기 템플릿을 찾는다. 그래서 **한국어 문장은 Rust에만 있고**
//! 프런트 표에는 영어(와 제3언어 번역)만 둔다 — 같은 한국어 문장을 두 저장소에 두고
//! 어긋나기를 기다릴 이유가 없다.
//!
//! # 상태 코드
//!
//! `kind`는 이 실패가 어느 범주인지만 말한다. HTTP 상태로 옮기는 일은 전송 계층
//! (`remote.rs`)이 계속 가진다 — 코어는 HTTP를 모른다.
//!
//! # 넓히는 법
//!
//! 모듈 하나를 옮길 때: 그 모듈의 `CoreError::InvalidInput(...)` 등을 여기 생성자로 바꾸고,
//! 코드마다 프런트 `backendErrors.ts`에 영어 템플릿을 한 줄 더한다. 코드를 더해도 옛
//! 소비자는 `message`를 계속 읽으므로 한 모듈씩 독립적으로 옮길 수 있다.

use std::collections::BTreeMap;
use std::fmt;

/// 실패의 범주. 전송 계층이 이것만 보고 상태 코드를 정한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppErrorKind {
    /// 요청 값이 규칙에 맞지 않는다.
    InvalidInput,
    /// 가리킨 대상이 없다.
    NotFound,
    /// 지금 상태와 충돌해 받을 수 없다.
    Conflict,
}

/// 코드와 파라미터를 함께 나르는 실패 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppError {
    kind: AppErrorKind,
    code: &'static str,
    params: BTreeMap<&'static str, String>,
    message: String,
}

impl AppError {
    fn new(kind: AppErrorKind, code: &'static str, message: impl Into<String>) -> Self {
        debug_assert!(
            valid_app_error_code(code),
            "오류 코드는 대문자·숫자·밑줄만 쓴다: {code}"
        );
        Self {
            kind,
            code,
            params: BTreeMap::new(),
            message: message.into(),
        }
    }

    pub fn invalid_input(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(AppErrorKind::InvalidInput, code, message)
    }

    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(AppErrorKind::NotFound, code, message)
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(AppErrorKind::Conflict, code, message)
    }

    /// 문장에 끼워 넣을 값 하나. 같은 이름을 두 번 주면 나중 값이 남는다.
    #[must_use]
    pub fn with(mut self, name: &'static str, value: impl ToString) -> Self {
        self.params.insert(name, value.to_string());
        self
    }

    pub fn kind(&self) -> AppErrorKind {
        self.kind
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn params(&self) -> &BTreeMap<&'static str, String> {
        &self.params
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

/// 코드가 약속한 모양인지. 대문자·숫자·밑줄만 쓰고 밑줄로 시작하거나 끝나지 않는다.
fn valid_app_error_code(code: &str) -> bool {
    !code.is_empty()
        && !code.starts_with('_')
        && !code.ends_with('_')
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carries_code_kind_and_korean_message() {
        let error = AppError::not_found("SESSION_FOLDER_NOT_FOUND", "세션 폴더를 찾을 수 없습니다");
        assert_eq!(error.code(), "SESSION_FOLDER_NOT_FOUND");
        assert_eq!(error.kind(), AppErrorKind::NotFound);
        assert_eq!(error.to_string(), "세션 폴더를 찾을 수 없습니다");
        assert!(error.params().is_empty());
    }

    #[test]
    fn params_are_named_and_last_write_wins() {
        let error = AppError::invalid_input("SESSION_FOLDER_DEPTH_EXCEEDED", "너무 깊습니다")
            .with("max", 5)
            .with("max", 6);
        assert_eq!(error.params().get("max").map(String::as_str), Some("6"));
    }

    #[test]
    fn code_shape_is_checked() {
        assert!(valid_app_error_code("SESSION_FOLDER_NOT_FOUND"));
        assert!(valid_app_error_code("DB_2_BUSY"));
        assert!(!valid_app_error_code(""));
        assert!(!valid_app_error_code("_LEADING"));
        assert!(!valid_app_error_code("TRAILING_"));
        assert!(!valid_app_error_code("lower_case"));
        assert!(!valid_app_error_code("HAS SPACE"));
        assert!(!valid_app_error_code("HAS-DASH"));
    }
}
