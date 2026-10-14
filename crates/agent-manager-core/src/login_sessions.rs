//! C20-3. 로그인 세션 저장소와 로그인 시도 제한.
//!
//! 세션 토큰의 원문은 발급 응답에만 실리고, 파일에는 SHA-256만 남는다. 그래서 앱 데이터
//! 파일을 읽은 사람이 그 값으로 로그인할 수는 없다. 백엔드를 재기동해도 세션이 살아
//! 남도록 파일(`login-sessions-v1.json`)에 두되, `lastSeenAt`은 분 단위로만 써서 요청마다
//! 디스크를 두드리지 않는다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::app_data_file::{ensure_schema_version, read_private_json, write_private_json};
use crate::login_auth::LoginChannel;
use crate::CoreError;

pub const LOGIN_SESSIONS_FILE_NAME: &str = "login-sessions-v1.json";
const SESSIONS_SCHEMA_VERSION: u32 = 1;
/// 마지막 사용 뒤 이만큼 지나면 세션이 끝난다.
pub const SESSION_IDLE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// 발급 뒤 이만큼 지나면 쓰고 있어도 끝난다.
pub const SESSION_ABSOLUTE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// `lastSeenAt`을 파일에 되쓰는 최소 간격.
const LAST_SEEN_PERSIST_INTERVAL_MS: i64 = 60 * 1000;
const TOKEN_BYTES: usize = 32;
/// 한 백엔드가 들고 있을 세션의 상한. 넘치면 가장 오래 안 쓴 것부터 버린다.
const MAX_SESSIONS: usize = 64;

/// 로그인 실패가 이만큼 쌓이면 잠근다.
pub const LOGIN_FAILURES_BEFORE_LOCK: u32 = 5;
const FIRST_LOCK_MS: i64 = 30 * 1000;
const MAX_LOCK_MS: i64 = 15 * 60 * 1000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSessions {
    schema_version: u32,
    sessions: Vec<StoredSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    id: String,
    token_sha256: String,
    channel: LoginChannel,
    created_at: i64,
    last_seen_at: i64,
    expires_at: i64,
    label: String,
}

/// 화면에 보여 주는 세션 한 줄. 토큰도 해시도 싣지 않는다.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoginSessionView {
    pub id: String,
    pub channel: LoginChannel,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub expires_at: i64,
    pub label: String,
    pub current: bool,
}

/// 막 발급한 세션. `token`은 이 값을 응답에 실은 뒤 버린다.
#[derive(Debug)]
pub struct IssuedSession {
    pub id: String,
    pub token: Zeroizing<String>,
    pub expires_at: i64,
}

/// 토큰이 가리키는 살아 있는 세션.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSession {
    pub id: String,
    pub channel: LoginChannel,
}

#[derive(Debug)]
pub struct LoginSessionStore {
    path: PathBuf,
    sessions: Vec<StoredSession>,
}

impl LoginSessionStore {
    pub fn open(app_data_dir: &Path) -> Result<Self, CoreError> {
        let path = app_data_dir.join(LOGIN_SESSIONS_FILE_NAME);
        let sessions = match read_private_json::<StoredSessions>(&path)? {
            Some(stored) => {
                ensure_schema_version(
                    stored.schema_version,
                    SESSIONS_SCHEMA_VERSION,
                    "로그인 세션",
                )?;
                stored.sessions
            }
            None => Vec::new(),
        };
        Ok(Self { path, sessions })
    }

    pub fn issue(
        &mut self,
        channel: LoginChannel,
        label: &str,
        now: i64,
    ) -> Result<IssuedSession, CoreError> {
        self.purge_expired(now);
        let token = random_token();
        let id = uuid::Uuid::new_v4().to_string();
        let expires_at = expiry(now, now);
        self.sessions.push(StoredSession {
            id: id.clone(),
            token_sha256: token_digest(&token),
            channel,
            created_at: now,
            last_seen_at: now,
            expires_at,
            label: label.chars().take(120).collect(),
        });
        if self.sessions.len() > MAX_SESSIONS {
            self.sessions.sort_by_key(|session| session.last_seen_at);
            let excess = self.sessions.len() - MAX_SESSIONS;
            self.sessions.drain(..excess);
        }
        self.persist()?;
        Ok(IssuedSession {
            id,
            token,
            expires_at,
        })
    }

    /// 토큰이 살아 있는 세션을 가리키면 마지막 사용 시각을 당기고 세션을 돌려준다.
    pub fn touch(&mut self, token: &str, now: i64) -> Option<ResolvedSession> {
        let digest = token_digest(token);
        let index = self
            .sessions
            .iter()
            .position(|session| session.token_sha256 == digest)?;
        if self.sessions[index].expires_at <= now {
            self.sessions.remove(index);
            let _ = self.persist();
            return None;
        }
        let session = &mut self.sessions[index];
        let stale = now - session.last_seen_at >= LAST_SEEN_PERSIST_INTERVAL_MS;
        session.last_seen_at = now;
        session.expires_at = expiry(session.created_at, now);
        let resolved = ResolvedSession {
            id: session.id.clone(),
            channel: session.channel,
        };
        if stale {
            // 분 단위로만 되쓴다. 실패해도 세션 자체는 메모리에서 유효하다.
            let _ = self.persist();
        }
        Some(resolved)
    }

    pub fn revoke(&mut self, id: &str) -> Result<bool, CoreError> {
        let before = self.sessions.len();
        self.sessions.retain(|session| session.id != id);
        let removed = self.sessions.len() != before;
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    pub fn revoke_by_token(&mut self, token: &str) -> Result<bool, CoreError> {
        let digest = token_digest(token);
        let before = self.sessions.len();
        self.sessions
            .retain(|session| session.token_sha256 != digest);
        let removed = self.sessions.len() != before;
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    /// `keep`에 준 세션만 남기고 전부 끝낸다. 돌려주는 값은 끝낸 개수.
    pub fn revoke_all(&mut self, keep: Option<&str>) -> Result<usize, CoreError> {
        let before = self.sessions.len();
        self.sessions
            .retain(|session| keep.is_some_and(|keep| keep == session.id));
        let removed = before - self.sessions.len();
        if removed > 0 {
            self.persist()?;
        }
        Ok(removed)
    }

    pub fn list(&mut self, now: i64, current: Option<&str>) -> Vec<LoginSessionView> {
        self.purge_expired(now);
        let mut views: Vec<_> = self
            .sessions
            .iter()
            .map(|session| LoginSessionView {
                id: session.id.clone(),
                channel: session.channel,
                created_at: session.created_at,
                last_seen_at: session.last_seen_at,
                expires_at: session.expires_at,
                label: session.label.clone(),
                current: current.is_some_and(|current| current == session.id),
            })
            .collect();
        views.sort_by_key(|view| std::cmp::Reverse(view.last_seen_at));
        views
    }

    fn purge_expired(&mut self, now: i64) {
        let before = self.sessions.len();
        self.sessions.retain(|session| session.expires_at > now);
        if self.sessions.len() != before {
            let _ = self.persist();
        }
    }

    fn persist(&self) -> Result<(), CoreError> {
        write_private_json(
            &self.path,
            &StoredSessions {
                schema_version: SESSIONS_SCHEMA_VERSION,
                sessions: self.sessions.clone(),
            },
        )
    }
}

fn expiry(created_at: i64, last_seen_at: i64) -> i64 {
    (last_seen_at + SESSION_IDLE_MS).min(created_at + SESSION_ABSOLUTE_MS)
}

fn random_token() -> Zeroizing<String> {
    use rand_core::{OsRng, RngCore};
    let mut bytes = Zeroizing::new([0u8; TOKEN_BYTES]);
    OsRng.fill_bytes(bytes.as_mut());
    Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_ref()))
}

fn token_digest(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 채널별 로그인 실패 제한. 메모리에만 있고 재기동하면 풀린다 — 잠금은 비밀번호 추측을
/// 느리게 하는 장치이지 계정 잠금이 아니다.
#[derive(Debug, Default)]
pub struct LoginRateLimiter {
    entries: HashMap<LoginChannel, LimiterEntry>,
}

#[derive(Debug, Default, Clone, Copy)]
struct LimiterEntry {
    failures: u32,
    locked_until: i64,
}

impl LoginRateLimiter {
    /// 지금 시도를 받을 수 있는지. 막혀 있으면 남은 초를 돌려준다.
    pub fn check(&self, channel: LoginChannel, now: i64) -> Result<(), u64> {
        match self.entries.get(&channel) {
            Some(entry) if entry.locked_until > now => {
                Err(((entry.locked_until - now) as u64).div_ceil(1000).max(1))
            }
            _ => Ok(()),
        }
    }

    pub fn record_failure(&mut self, channel: LoginChannel, now: i64) {
        let entry = self.entries.entry(channel).or_default();
        entry.failures += 1;
        if entry.failures >= LOGIN_FAILURES_BEFORE_LOCK {
            let doublings = entry.failures - LOGIN_FAILURES_BEFORE_LOCK;
            let lock = FIRST_LOCK_MS
                .saturating_mul(1i64 << doublings.min(10))
                .min(MAX_LOCK_MS);
            entry.locked_until = now + lock;
        }
    }

    pub fn record_success(&mut self, channel: LoginChannel) {
        self.entries.remove(&channel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const NOW: i64 = 1_700_000_000_000;

    #[test]
    fn issued_tokens_resolve_until_they_expire_and_only_their_hash_is_stored() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut store = LoginSessionStore::open(directory.path()).expect("open");
        let issued = store
            .issue(LoginChannel::Remote, "iPhone", NOW)
            .expect("issue");
        let token = issued.token.to_string();

        let resolved = store.touch(&token, NOW + 1000).expect("resolve");
        assert_eq!(resolved.id, issued.id);
        assert_eq!(resolved.channel, LoginChannel::Remote);

        let raw =
            fs::read_to_string(directory.path().join(LOGIN_SESSIONS_FILE_NAME)).expect("file");
        assert!(!raw.contains(&token), "토큰 원문이 파일에 남으면 안 된다");
        assert!(raw.contains(&token_digest(&token)));

        // 유휴 30일을 넘기면 끝난다.
        assert!(store.touch(&token, NOW + SESSION_IDLE_MS + 1000).is_none());
        assert!(
            store.touch(&token, NOW + 2000).is_none(),
            "끝난 세션은 지워진다"
        );
    }

    #[test]
    fn absolute_lifetime_ends_a_session_that_is_still_in_use() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut store = LoginSessionStore::open(directory.path()).expect("open");
        let token = store
            .issue(LoginChannel::Desktop, "", NOW)
            .expect("issue")
            .token
            .to_string();
        let mut at = NOW;
        while at < NOW + SESSION_ABSOLUTE_MS - SESSION_IDLE_MS {
            at += SESSION_IDLE_MS / 2;
            assert!(store.touch(&token, at).is_some());
        }
        assert!(store.touch(&token, NOW + SESSION_ABSOLUTE_MS + 1).is_none());
    }

    #[test]
    fn sessions_survive_a_reopen_and_revocation_is_persisted() {
        let directory = tempfile::tempdir().expect("tempdir");
        let (token_a, id_a, token_b) = {
            let mut store = LoginSessionStore::open(directory.path()).expect("open");
            let a = store.issue(LoginChannel::Remote, "a", NOW).expect("a");
            let b = store
                .issue(LoginChannel::LocalBrowser, "b", NOW)
                .expect("b");
            (a.token.to_string(), a.id, b.token.to_string())
        };
        let mut store = LoginSessionStore::open(directory.path()).expect("reopen");
        assert!(store.touch(&token_a, NOW + 1).is_some());
        assert!(store.revoke(&id_a).expect("revoke"));
        assert!(!store.revoke(&id_a).expect("revoke twice"));
        assert!(store.touch(&token_a, NOW + 2).is_none());
        assert!(store.touch(&token_b, NOW + 2).is_some());

        let keep = store.touch(&token_b, NOW + 3).expect("b").id;
        store.issue(LoginChannel::Remote, "c", NOW).expect("c");
        assert_eq!(store.revoke_all(Some(&keep)).expect("revoke all"), 1);
        let listed = store.list(NOW + 4, Some(&keep));
        assert_eq!(listed.len(), 1);
        assert!(listed[0].current);
        assert_eq!(store.revoke_all(None).expect("revoke rest"), 1);
        assert!(LoginSessionStore::open(directory.path())
            .expect("reopen")
            .list(NOW, None)
            .is_empty());
    }

    /// `list`는 최근에 쓰인 세션을 먼저 돌려준다. 정렬이 빠지거나 뒤집히면
    /// 길이·current만 보는 기존 단언은 그대로 통과하므로 방향을 따로 고정한다.
    #[test]
    fn list_orders_sessions_by_most_recently_seen_first() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut store = LoginSessionStore::open(directory.path()).expect("open");
        let old = store.issue(LoginChannel::Remote, "old", NOW).expect("old");
        let middle = store
            .issue(LoginChannel::Desktop, "middle", NOW)
            .expect("middle");
        let recent = store
            .issue(LoginChannel::LocalBrowser, "recent", NOW)
            .expect("recent");
        store.touch(&middle.token, NOW + 10).expect("touch middle");
        store.touch(&recent.token, NOW + 20).expect("touch recent");

        let listed = store.list(NOW + 30, None);
        let order: Vec<_> = listed.iter().map(|view| view.label.as_str()).collect();
        assert_eq!(order, vec!["recent", "middle", "old"]);
        assert_eq!(listed[0].id, recent.id);
        assert_eq!(listed[2].id, old.id);
        assert!(listed
            .windows(2)
            .all(|pair| pair[0].last_seen_at >= pair[1].last_seen_at));
    }

    /// C20-3: 세션은 최대 64개이고, 넘치면 가장 오래 안 쓴 것부터 버린다. 상한이 빠지면
    /// 파일이 끝없이 자라고, 버리는 순서가 뒤집히면 방금 쓴 세션이 끊긴다.
    #[test]
    fn c20_3_issue_evicts_the_least_recently_seen_session_past_the_cap() {
        let directory = tempfile::tempdir().expect("tempdir");
        let mut store = LoginSessionStore::open(directory.path()).expect("open");
        // 가장 먼저 발급했어도 최근에 쓴 세션은 밀려나지 않는다 — 발급 순서가 아니라
        // 마지막 사용 순서로 버린다.
        let oldest_but_used = store
            .issue(LoginChannel::Remote, "used", NOW)
            .expect("used")
            .token
            .to_string();
        let stale = store
            .issue(LoginChannel::Remote, "stale", NOW + 1)
            .expect("stale");
        for index in 2..MAX_SESSIONS {
            store
                .issue(LoginChannel::Remote, "kept", NOW + index as i64)
                .expect("issue");
        }
        store
            .touch(&oldest_but_used, NOW + 1_000)
            .expect("touch first kept");

        let newest = store
            .issue(LoginChannel::Remote, "newest", NOW + 2_000)
            .expect("newest");
        let listed = store.list(NOW + 3_000, None);
        assert_eq!(listed.len(), MAX_SESSIONS);
        assert!(listed.iter().all(|view| view.id != stale.id));
        // 버린 세션은 파일에서도 빠진다 — 메모리만 보지 않도록 다시 열어 확인한다.
        let mut reopened = LoginSessionStore::open(directory.path()).expect("reopen");
        assert_eq!(reopened.list(NOW + 3_000, None).len(), MAX_SESSIONS);
        assert!(reopened.touch(&stale.token, NOW + 3_000).is_none());
        assert!(reopened.touch(&oldest_but_used, NOW + 3_000).is_some());
        assert!(reopened.touch(&newest.token, NOW + 3_000).is_some());
    }

    #[test]
    fn rate_limiter_locks_after_five_failures_and_backs_off() {
        let mut limiter = LoginRateLimiter::default();
        for _ in 0..4 {
            limiter.record_failure(LoginChannel::Remote, NOW);
            assert!(limiter.check(LoginChannel::Remote, NOW).is_ok());
        }
        limiter.record_failure(LoginChannel::Remote, NOW);
        assert_eq!(limiter.check(LoginChannel::Remote, NOW), Err(30));
        assert!(
            limiter.check(LoginChannel::Desktop, NOW).is_ok(),
            "채널별로 센다"
        );
        assert!(limiter
            .check(LoginChannel::Remote, NOW + FIRST_LOCK_MS)
            .is_ok());
        limiter.record_failure(LoginChannel::Remote, NOW + FIRST_LOCK_MS);
        assert_eq!(
            limiter.check(LoginChannel::Remote, NOW + FIRST_LOCK_MS),
            Err(60)
        );
        for _ in 0..20 {
            limiter.record_failure(LoginChannel::Remote, NOW);
        }
        assert_eq!(
            limiter.check(LoginChannel::Remote, NOW),
            Err((MAX_LOCK_MS / 1000) as u64)
        );
        limiter.record_success(LoginChannel::Remote);
        assert!(limiter.check(LoginChannel::Remote, NOW).is_ok());
    }

    #[test]
    fn unknown_schema_versions_are_refused() {
        let directory = tempfile::tempdir().expect("tempdir");
        fs::write(
            directory.path().join(LOGIN_SESSIONS_FILE_NAME),
            r#"{"schemaVersion":9,"sessions":[]}"#,
        )
        .expect("write");
        assert!(matches!(
            LoginSessionStore::open(directory.path()),
            Err(CoreError::Conflict(_))
        ));
    }
}
