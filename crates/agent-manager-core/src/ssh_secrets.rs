//! C9-19. 원격 `sudo`가 요구하는 비밀번호를 그 **대화·그 서버**에 한해 짧게 들고 있는
//! 자리.
//!
//! # 왜 저장하지 않고 들고만 있는가
//!
//! 이 값을 디스크에 적으면 그 순간부터 앱은 사용자의 계정 비밀번호를 보관하는 프로그램이
//! 된다. 키체인에 넣어도 마찬가지다 — 잠금 해제된 동안은 앱이 언제든 꺼내 쓸 수 있고,
//! 사용자가 "지금 이 작업"에 준 허락이 "앞으로 계속"으로 바뀐다. 그래서 이 저장소는
//! 프로세스 메모리에만 있고, 백엔드가 다시 뜨면 비어 있다.
//!
//! 대안이었던 `NOPASSWD` sudoers와 비교하면 경계가 반대다. `NOPASSWD`는 서버에 영구
//! 설정을 남겨 그 뒤로는 아무도 묻지 않지만, 이 자리는 서버를 건드리지 않는 대신 사용자가
//! 한 번 입력해야 한다. 둘은 대체재가 아니라 무인 자동화와 대화형 작업으로 쓰임이 갈린다.
//!
//! # 무엇에 묶이는가
//!
//! (대화, 지문) 두 값에 묶인다. 다른 대화는 같은 서버에 대해서도 이 값을 보지 못하고,
//! 같은 대화라도 다른 서버에는 쓰이지 않는다. [`SSH_SECRET_TTL_MS`]가 지나면 스스로
//! 사라지고, 대화가 끝나면 [`SshSecretStore::discard_chat`]으로 즉시 사라진다.
//!
//! # 누가 넣을 수 있는가
//!
//! [`SshSecretStore::store`]는 화면의 승인 카드 응답 경로에만 연결된다. 에이전트가 닿는
//! 시스템 인터페이스에는 이 함수로 이어지는 작업이 없고, 값이 도구 인자로 들어오지도
//! 응답으로 나가지도 않는다. 에이전트는 "비밀번호가 필요하다"와 "받았다"만 알 수 있다.

use std::sync::{Mutex, MutexGuard};

use zeroize::Zeroizing;

use crate::clock::now_ms;
use crate::CoreError;

/// 들고 있는 시간. 한 작업이 여러 `sudo` 명령으로 이어지는 동안(설치 → 기동 → 확인)
/// 다시 묻지 않을 만큼 길고, 자리를 비운 사이에 남아 있을 만큼 길지는 않은 값이다.
/// 승인 카드의 120초보다 긴 것은 의도다 — 카드는 한 명령에 대한 답이고, 이 값은 한
/// 작업에 대한 답이다.
pub const SSH_SECRET_TTL_MS: i64 = 300_000;

/// 저장소 전체 상한. 대화가 여러 개 열려 있어도 메모리는 이 선에서 멈춘다.
const MAX_ENTRIES: usize = 16;

/// 들고 있는 값 하나. `Zeroizing`이 drop 시점에 버퍼를 0으로 덮는다.
struct StoredSecret {
    chat_id: String,
    fingerprint: String,
    secret: Zeroizing<String>,
    expires_at: i64,
}

impl StoredSecret {
    fn expired(&self, now: i64) -> bool {
        now >= self.expires_at
    }

    fn matches(&self, chat_id: &str, fingerprint: &str) -> bool {
        self.chat_id == chat_id && self.fingerprint == fingerprint
    }
}

/// 대화·서버별 sudo 비밀번호 보관소. 프로세스 메모리에만 있고 디스크에 남지 않는다.
#[derive(Default)]
pub struct SshSecretStore {
    entries: Mutex<Vec<StoredSecret>>,
}

// 값이 실수로 로그에 실리지 않도록 내용을 찍지 않는다. `#[derive(Debug)]`였다면 상위
// 구조체를 찍는 한 줄이 비밀번호를 그대로 뱉는다.
impl std::fmt::Debug for SshSecretStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let held = self
            .entries
            .lock()
            .map(|entries| entries.len())
            .unwrap_or(0);
        formatter
            .debug_struct("SshSecretStore")
            .field("held", &held)
            .finish()
    }
}

impl SshSecretStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 사용자가 승인 카드에 입력한 값을 받아 둔다. 같은 (대화, 지문)에 이미 값이 있으면
    /// 갈아 끼운다 — 사용자가 다시 입력했다는 것은 앞의 값이 틀렸다는 뜻이다.
    pub fn store(&self, chat_id: &str, fingerprint: &str, secret: &str) -> Result<(), CoreError> {
        if secret.is_empty() {
            return Err(CoreError::InvalidInput(
                "비밀번호가 비어 있습니다".to_owned(),
            ));
        }
        let now = now_ms();
        let mut entries = self.lock_live(now)?;
        entries.retain(|entry| !entry.matches(chat_id, fingerprint));
        if entries.len() >= MAX_ENTRIES {
            return Err(CoreError::Conflict(
                "들고 있는 SSH 비밀번호가 너무 많습니다".to_owned(),
            ));
        }
        entries.push(StoredSecret {
            chat_id: chat_id.to_owned(),
            fingerprint: fingerprint.to_owned(),
            secret: Zeroizing::new(secret.to_owned()),
            expires_at: now + SSH_SECRET_TTL_MS,
        });
        Ok(())
    }

    /// 이 대화가 이 서버에 대해 값을 들고 있는지. 값 자체는 돌려주지 않는다 — 실행 경로
    /// 밖에서 이 질문에 답해야 하는 자리(승인 카드를 비밀번호 칸과 함께 띄울지)가 있고,
    /// 그 자리에 값을 내주면 통로가 하나 늘어난다.
    pub fn holds(&self, chat_id: &str, fingerprint: &str) -> bool {
        let now = now_ms();
        self.lock_live(now)
            .map(|entries| {
                entries
                    .iter()
                    .any(|entry| entry.matches(chat_id, fingerprint))
            })
            .unwrap_or(false)
    }

    /// 실행 직전에 값을 꺼낸다. 꺼내도 사라지지 않는다 — 한 작업이 여러 명령으로 이어지는
    /// 동안 다시 묻지 않는 것이 이 저장소의 목적이고, 수명은 TTL과 대화 종료가 정한다.
    ///
    /// 돌려주는 값은 `Zeroizing`이라 호출자가 떨어뜨리는 순간 그 복사본도 0으로 덮인다.
    pub fn peek(&self, chat_id: &str, fingerprint: &str) -> Option<Zeroizing<String>> {
        let now = now_ms();
        let entries = self.lock_live(now).ok()?;
        entries
            .iter()
            .find(|entry| entry.matches(chat_id, fingerprint))
            .map(|entry| entry.secret.clone())
    }

    /// 그 서버의 값을 버린다. 비밀번호가 틀렸을 때 실행 경로가 부른다 — 틀린 값을 들고
    /// 남은 TTL 동안 계속 실패하는 대신 다음 명령에서 다시 묻는다.
    pub fn discard(&self, chat_id: &str, fingerprint: &str) {
        if let Ok(mut entries) = self.lock() {
            entries.retain(|entry| !entry.matches(chat_id, fingerprint));
        }
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
            .map_err(|_| CoreError::Runtime("SSH 비밀번호 저장소를 잠그지 못했습니다".to_owned()))
    }

    /// 잠그면서 만료된 항목을 먼저 버린다. 만료 판정을 읽는 자리마다 따로 두면 한쪽이
    /// 지난 값을 그대로 쓴다.
    fn lock_live(&self, now: i64) -> Result<MutexGuard<'_, Vec<StoredSecret>>, CoreError> {
        let mut entries = self.lock()?;
        entries.retain(|entry| !entry.expired(now));
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAT: &str = "chat-1";
    const PRINT: &str = "SHA256:aaa";

    fn store() -> SshSecretStore {
        SshSecretStore::new()
    }

    #[test]
    fn stores_and_reads_back_for_same_chat_and_endpoint() {
        let store = store();
        store.store(CHAT, PRINT, "hunter2").expect("store");
        assert!(store.holds(CHAT, PRINT));
        assert_eq!(
            store.peek(CHAT, PRINT).as_ref().map(|v| v.as_str()),
            Some("hunter2")
        );
    }

    #[test]
    fn peek_does_not_consume() {
        let store = store();
        store.store(CHAT, PRINT, "hunter2").expect("store");
        assert!(store.peek(CHAT, PRINT).is_some());
        assert!(
            store.peek(CHAT, PRINT).is_some(),
            "한 작업이 여러 sudo 명령으로 이어지는 동안 다시 묻지 않아야 한다"
        );
    }

    #[test]
    fn another_chat_cannot_read_the_same_endpoint() {
        let store = store();
        store.store(CHAT, PRINT, "hunter2").expect("store");
        assert!(!store.holds("chat-2", PRINT));
        assert!(store.peek("chat-2", PRINT).is_none());
    }

    #[test]
    fn another_endpoint_in_the_same_chat_does_not_share() {
        let store = store();
        store.store(CHAT, PRINT, "hunter2").expect("store");
        assert!(!store.holds(CHAT, "SHA256:bbb"));
        assert!(store.peek(CHAT, "SHA256:bbb").is_none());
    }

    #[test]
    fn restoring_replaces_the_previous_value() {
        let store = store();
        store.store(CHAT, PRINT, "old").expect("store");
        store.store(CHAT, PRINT, "new").expect("store");
        assert_eq!(
            store.peek(CHAT, PRINT).as_ref().map(|v| v.as_str()),
            Some("new")
        );
        let entries = store.entries.lock().expect("lock");
        assert_eq!(entries.len(), 1, "갈아 끼운 값이 쌓이지 않아야 한다");
    }

    #[test]
    fn empty_secret_is_rejected() {
        let store = store();
        assert!(store.store(CHAT, PRINT, "").is_err());
    }

    #[test]
    fn discard_drops_only_that_endpoint() {
        let store = store();
        store.store(CHAT, PRINT, "a").expect("store");
        store.store(CHAT, "SHA256:bbb", "b").expect("store");
        store.discard(CHAT, PRINT);
        assert!(!store.holds(CHAT, PRINT));
        assert!(store.holds(CHAT, "SHA256:bbb"));
    }

    #[test]
    fn discard_chat_drops_every_endpoint_of_that_chat() {
        let store = store();
        store.store(CHAT, PRINT, "a").expect("store");
        store.store(CHAT, "SHA256:bbb", "b").expect("store");
        store.store("chat-2", PRINT, "c").expect("store");
        store.discard_chat(CHAT);
        assert!(!store.holds(CHAT, PRINT));
        assert!(!store.holds(CHAT, "SHA256:bbb"));
        assert!(store.holds("chat-2", PRINT), "다른 대화는 남는다");
    }

    #[test]
    fn expired_entries_are_dropped_on_read() {
        let store = store();
        {
            let mut entries = store.entries.lock().expect("lock");
            entries.push(StoredSecret {
                chat_id: CHAT.to_owned(),
                fingerprint: PRINT.to_owned(),
                secret: Zeroizing::new("stale".to_owned()),
                expires_at: now_ms() - 1,
            });
        }
        assert!(!store.holds(CHAT, PRINT));
        assert!(store.peek(CHAT, PRINT).is_none());
        assert!(store.entries.lock().expect("lock").is_empty());
    }

    #[test]
    fn debug_does_not_print_the_secret() {
        let store = store();
        store.store(CHAT, PRINT, "hunter2").expect("store");
        let rendered = format!("{store:?}");
        assert!(
            !rendered.contains("hunter2"),
            "저장소를 찍은 한 줄이 비밀번호를 뱉으면 안 된다: {rendered}"
        );
    }
}
