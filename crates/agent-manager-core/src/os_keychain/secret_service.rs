//! 리눅스(Secret Service) OS 보안 저장소 통로. `keyring` 크레이트의 secret-service 백엔드가 쓰던
//! 항목 규칙 — 속성(`target`·`service`·`username`·`application`), 기본 컬렉션, target 없는 옛
//! 항목 대체 검색 — 을 그대로 따르되, 잠금 해제 prompt에 시한을 건다.
//!
//! `keyring`을 거치지 않는 이유: `keyring`은 잠긴 항목을 만나면 prompt를 띄우고 그 응답을
//! `dbus-secret-service`의 기본값대로 **1년** 기다린다(`SecretService::connect`, 시한을 바꿀 길이
//! 없다). 화면 없는 서버에서는 그 응답이 오지 않는다(격리 키링 실측: 70초 동안 `Completed`
//! 없음). 2026-10-28 NAS에서 죽은 키링 데몬 대신 잠긴 데몬이 떠 있던 몇 초 사이에 볼트 읽기가
//! 들어와 그렇게 멈췄고, 그 호출이 자격증명 Vault 잠금을 쥔 채라 감시가 키링을 다시 연 뒤에도
//! 6시간 동안 새 채팅·회차·원격 화면이 모두 막혔다.
//!
//! 그래서 prompt를 띄울지는 실행 환경이 정한다. 컨테이너 entrypoint는 `NO_PROMPT_ENV`를 켜서
//! prompt를 아예 띄우지 않게 하고, 잠긴 동안은 감시가 다시 열기를 `UNLOCK_WAIT`까지 기다린다.
//! 그 밖(데스크톱 리눅스)에서는 사람이 답할 prompt를 띄우되 `PROMPT_TIMEOUT_SECS`에서 끊는다.
//! 화면 유무(`DISPLAY`)로 가르지 않는다 — prompt는 이 프로세스가 아니라 키링 데몬이 사용자의
//! 그래픽 세션에 띄우므로, SSH·systemd로 띄운 서버에도 답할 사람이 있을 수 있다.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use dbus_secret_service::{EncryptionType, Error as SsError, Item, SecretService};
use zeroize::Zeroizing;

use crate::CoreError;

use super::{KEYCHAIN_LOCKED_CODE, KEYCHAIN_UNAVAILABLE_CODE};
use crate::app_error::AppError;

/// `keyring::Entry::new`가 쓰는 대상. 항목은 기본 컬렉션에 들어간다.
const TARGET: &str = "default";
const APPLICATION: &str = "rust-keyring";
const CONTENT_TYPE: &str = "text/plain";

/// 켜져 있으면(`1`) 잠금 해제 prompt를 띄우지 않는다. 화면 없는 컨테이너의 entrypoint가 켠다.
pub(crate) const NO_PROMPT_ENV: &str = "AGENT_MANAGER_KEYRING_NO_PROMPT";
/// prompt를 띄우는 환경에서 사람이 답하기를 기다리는 시간.
const PROMPT_TIMEOUT_SECS: u64 = 120;
/// prompt 없는 환경에서 잠긴 키링이 다시 열리기를 기다리는 시간. 컨테이너 감시(10초 간격)의
/// 한 주기와 데몬 교체 몇 초를 덮는다.
pub(super) const UNLOCK_WAIT: Duration = Duration::from_secs(15);
const UNLOCK_POLL: Duration = Duration::from_millis(500);
/// 기다려도 열리지 않았으면 이 동안은 기다리지 않고 바로 실패한다. 볼트 작업은 잠금 하나 뒤에
/// 줄을 서므로, 호출마다 `UNLOCK_WAIT`를 치르면 원격 화면 요청이 그 뒤에 겹겹이 묶인다.
const FAILURE_HOLD: Duration = Duration::from_secs(10);
/// prompt를 띄우는 환경에서 prompt가 거절되거나 시한을 넘긴 뒤 다시 띄우지 않는 시간. 답할 사람이
/// 없는 prompt를 호출마다 `PROMPT_TIMEOUT_SECS`씩 기다리면 같은 줄이 몇 분씩 묶인다.
const PROMPT_FAILURE_HOLD: Duration = Duration::from_secs(60);
/// 잠긴 항목에 손대면 Secret Service가 돌려주는 D-Bus 오류. `dbus-secret-service`는 이것을
/// `Error::Locked`로 바꾸지 않고 `Error::Dbus`로 그대로 올린다.
const IS_LOCKED_ERROR: &str = "org.freedesktop.Secret.Error.IsLocked";

static HELD_FAILURE: Mutex<Option<(Instant, Kind)>> = Mutex::new(None);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// 저장소는 있는데 잠겨 있고 열지 못했다(prompt 거절·시한 초과 포함).
    Locked,
    /// 저장소에 닿지 못했다(D-Bus·Secret Service 부재, 기본 컬렉션 없음 등).
    Unavailable,
}

#[derive(Debug)]
enum Failure {
    Service(SsError),
    /// 같은 이름의 항목이 둘 이상 — `keyring`의 `Ambiguous`와 같이 아무것도 하지 않는다.
    Ambiguous,
}

impl From<SsError> for Failure {
    fn from(error: SsError) -> Self {
        Self::Service(error)
    }
}

impl Failure {
    fn kind(&self) -> Option<Kind> {
        match self {
            Self::Service(SsError::Locked | SsError::Prompt) => Some(Kind::Locked),
            Self::Service(SsError::Dbus(error)) if error.name() == Some(IS_LOCKED_ERROR) => {
                Some(Kind::Locked)
            }
            Self::Service(_) => Some(Kind::Unavailable),
            Self::Ambiguous => None,
        }
    }

    /// 감시가 데몬을 바꾸는 몇 초 동안 나는 실패들. 잠김뿐 아니라 버스 호출 시한 초과·이름 없음,
    /// 새 데몬이 아직 기본 컬렉션을 잡지 못한 상태(`NoResult`)도 여기에 든다 — 이걸 "닿을 수
    /// 없음"으로 보고 바로 넘기면, 바로 그 틈에 들어온 호출이 실패한다.
    fn transient(&self) -> bool {
        matches!(
            self,
            Self::Service(
                SsError::Locked
                    | SsError::Prompt
                    | SsError::Dbus(_)
                    | SsError::Unavailable
                    | SsError::NoResult
            )
        )
    }

    fn into_core(self, prefix: &str) -> CoreError {
        let kind = self.kind();
        self.into_core_as(kind, prefix)
    }

    fn into_core_as(self, kind: Option<Kind>, prefix: &str) -> CoreError {
        match (kind, self) {
            (Some(kind), Self::Service(_)) => {
                // G4/C4-8: D-Bus·경로·암호화 오류의 원문은 비밀값을 포함할 수 있다.
                // 분류 코드는 보존하되 외부에서 받은 본문은 오류 안내에도 싣지 않는다.
                let reason = match kind {
                    Kind::Locked => "OS 보안 저장소(키링)가 잠겨 있거나 답하지 않습니다",
                    Kind::Unavailable => {
                        "OS 보안 저장소(키링)에 연결하거나 요청을 처리하지 못했습니다"
                    }
                };
                failure_for(kind, &format!("{prefix}: {reason}"))
            }
            _ => CoreError::Runtime(format!(
                "{prefix}: OS 보안 저장소에 같은 이름의 항목이 여러 개 있습니다"
            )),
        }
    }
}

fn failure_for(kind: Kind, message: &str) -> CoreError {
    CoreError::Coded(match kind {
        Kind::Locked => AppError::conflict(KEYCHAIN_LOCKED_CODE, message.to_owned()),
        Kind::Unavailable => AppError::conflict(KEYCHAIN_UNAVAILABLE_CODE, message.to_owned()),
    })
}

fn no_prompt() -> bool {
    std::env::var_os(NO_PROMPT_ENV).is_some_and(|value| value == "1")
}

pub(super) fn read(
    service: &str,
    account: &str,
    prefix: &str,
) -> Result<Option<Zeroizing<Vec<u8>>>, CoreError> {
    run(prefix, |secret_service| {
        let Some(item) = find_unique(secret_service, service, account)? else {
            return Ok(None);
        };
        ensure_unlocked(&item)?;
        Ok(Some(Zeroizing::new(item.get_secret()?)))
    })
}

pub(super) fn write(
    service: &str,
    account: &str,
    secret: &[u8],
    prefix: &str,
) -> Result<(), CoreError> {
    run(prefix, |secret_service| {
        if let Some(item) = find_unique(secret_service, service, account)? {
            ensure_unlocked(&item)?;
            item.set_secret(secret, CONTENT_TYPE)?;
            return Ok(());
        }
        let collection = secret_service.get_default_collection()?;
        if collection.is_locked()? {
            collection.unlock()?;
        }
        collection.create_item(
            &format!("{account}@{service}:{TARGET} (agent-manager)"),
            HashMap::from([
                ("service", service),
                ("username", account),
                ("target", TARGET),
                ("application", APPLICATION),
            ]),
            secret,
            true,
            CONTENT_TYPE,
        )?;
        Ok(())
    })
}

/// 지웠으면 `true`, 없었으면 `false`.
pub(super) fn delete(service: &str, account: &str, prefix: &str) -> Result<bool, CoreError> {
    run(prefix, |secret_service| {
        let Some(item) = find_unique(secret_service, service, account)? else {
            return Ok(false);
        };
        ensure_unlocked(&item)?;
        item.delete()?;
        Ok(true)
    })
}

/// `keyring`의 `map_matching_items(.., require_unique = true)`와 같은 검색. 먼저 target까지
/// 맞는 항목을 서비스 전체에서 찾고, 하나도 없으면 기본 컬렉션에서 target 없는 항목(keyring v1,
/// 그리고 `go-keyring`처럼 다른 프로그램이 남긴 항목)을 찾는다.
fn find_unique<'a>(
    secret_service: &'a SecretService,
    service: &str,
    account: &str,
) -> Result<Option<Item<'a>>, Failure> {
    let search = secret_service.search_items(HashMap::from([
        ("target", TARGET),
        ("service", service),
        ("username", account),
    ]))?;
    let mut items: Vec<Item<'a>> = search.unlocked.into_iter().chain(search.locked).collect();
    if items.is_empty() {
        let collection = secret_service.get_default_collection()?;
        // 컬렉션이 돌려준 항목은 컬렉션 값에 묶여 있어, 같은 경로로 서비스에 다시 묶는다.
        items = collection
            .search_items(HashMap::from([("service", service), ("username", account)]))?
            .into_iter()
            .map(|item| Item::new(secret_service, item.path))
            .collect();
    }
    match items.len() {
        0 => Ok(None),
        1 => Ok(items.pop()),
        _ => Err(Failure::Ambiguous),
    }
}

/// 연결의 prompt 시한이 0이면 `unlock`은 prompt를 띄우지 않고 바로 `Prompt`로 실패한다.
fn ensure_unlocked(item: &Item<'_>) -> Result<(), Failure> {
    if item.is_locked()? {
        item.unlock()?;
    }
    Ok(())
}

fn run<T>(
    prefix: &str,
    operation: impl Fn(&SecretService) -> Result<T, Failure>,
) -> Result<T, CoreError> {
    if let Some(kind) = held_failure(Instant::now()) {
        return Err(failure_for(
            kind,
            &format!("{prefix}: OS 보안 저장소(키링)가 잠겨 있거나 답하지 않습니다"),
        ));
    }
    if !no_prompt() {
        let result =
            connect(PROMPT_TIMEOUT_SECS).and_then(|secret_service| operation(&secret_service));
        return match result {
            Ok(value) => {
                clear_held_failure();
                Ok(value)
            }
            Err(failure) => {
                if matches!(failure, Failure::Service(SsError::Prompt)) {
                    hold_failure(Instant::now() + PROMPT_FAILURE_HOLD, Kind::Locked);
                }
                Err(failure.into_core(prefix))
            }
        };
    }
    let result = retry_transient(Instant::now() + UNLOCK_WAIT, UNLOCK_POLL, || {
        if !secret_service_has_owner()? {
            return Err(SsError::Unavailable.into());
        }
        connect(0).and_then(|secret_service| operation(&secret_service))
    });
    match result {
        Ok(value) => {
            clear_held_failure();
            Ok(value)
        }
        Err(failure) => {
            if failure.transient() {
                hold_failure(Instant::now() + FAILURE_HOLD, Kind::Locked);
            }
            // 이 환경에서는 키링이 늘 있어야 한다(entrypoint가 열린 것을 확인하고서야 서버를
            // 띄운다). 여기서 나는 실패는 잠깐 막혔거나 고장 난 것이지 저장소가 없는 것이 아니다
            // — 파일 폴백으로 비밀을 옮기지 않도록 모두 "잠김"으로 올린다.
            let kind = failure.kind().map(|_| Kind::Locked);
            Err(failure.into_core_as(kind, prefix))
        }
    }
}

/// 비밀 서비스 이름에 주인이 있는지만 묻는다. 주인이 없을 때 서비스에 바로 말을 걸면 D-Bus가
/// 잠긴 데몬을 새로 띄운다(`org.freedesktop.secrets.service`, 암호 없음). 감시가 데몬을 바꾸는
/// 틈에 그렇게 되면 감시가 띄운 열린 데몬 대신 잠긴 데몬이 이름을 잡는다(격리 키링에서 0.5초
/// 간격 재시도로 재현). 감시(entrypoint `keyring_locked_state`)도 같은 이유로 이 질문부터 한다.
/// 묻고 나서 말을 거는 사이에 데몬이 죽으면 여전히 깨울 수 있다 — 틈을 좁힐 뿐이고, 그렇게 뜬
/// 잠긴 데몬은 감시가 다시 바꾼다.
fn secret_service_has_owner() -> Result<bool, Failure> {
    let connection = dbus::blocking::Connection::new_session().map_err(SsError::from)?;
    let (owned,): (bool,) = connection
        .with_proxy(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            Duration::from_secs(2),
        )
        .method_call(
            "org.freedesktop.DBus",
            "NameHasOwner",
            ("org.freedesktop.secrets",),
        )
        .map_err(SsError::from)?;
    Ok(owned)
}

fn connect(prompt_timeout_secs: u64) -> Result<SecretService, Failure> {
    Ok(SecretService::connect_with_max_prompt_timeout(
        EncryptionType::Dh,
        prompt_timeout_secs,
    )?)
}

/// 일시 실패는 `deadline`까지 `poll` 간격으로 다시 한다. 시도는 처음부터 다시 하므로(새 연결·새
/// 검색) 같은 일을 두 번 해도 결과가 같아야 한다 — 읽기·덮어쓰기·지우기 모두 그렇다.
fn retry_transient<T>(
    deadline: Instant,
    poll: Duration,
    mut attempt: impl FnMut() -> Result<T, Failure>,
) -> Result<T, Failure> {
    loop {
        match attempt() {
            Err(failure) if failure.transient() && Instant::now() < deadline => {
                std::thread::sleep(poll);
            }
            result => return result,
        }
    }
}

fn held_failure(now: Instant) -> Option<Kind> {
    let mut held = HELD_FAILURE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    match *held {
        Some((until, kind)) if now < until => Some(kind),
        Some(_) => {
            *held = None;
            None
        }
        None => None,
    }
}

fn hold_failure(until: Instant, kind: Kind) {
    *HELD_FAILURE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = Some((until, kind));
}

/// 다른 호출이 성공했으면 저장소가 다시 열린 것이다. 남은 시간을 채우지 않는다.
fn clear_held_failure() {
    *HELD_FAILURE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g4_service_error_payloads_never_reach_core_errors() {
        const PAYLOAD: &str = "test-secret-payload";
        for forced_kind in [None, Some(Kind::Locked)] {
            for error in [
                SsError::from(dbus::Error::new_custom(IS_LOCKED_ERROR, PAYLOAD)),
                SsError::from(dbus::Error::new_custom(
                    "org.example.test_secret_payload",
                    PAYLOAD,
                )),
                SsError::Path(PAYLOAD.to_owned()),
                SsError::Crypto(Box::new(std::io::Error::other(PAYLOAD))),
            ] {
                let failure = Failure::from(error);
                let expected_kind = forced_kind.or_else(|| failure.kind()).unwrap();
                let core = if let Some(kind) = forced_kind {
                    failure.into_core_as(Some(kind), "저장 실패")
                } else {
                    failure.into_core("저장 실패")
                };
                let CoreError::Coded(coded) = &core else {
                    panic!("service failures must retain their classification");
                };
                assert_eq!(
                    coded.code(),
                    match expected_kind {
                        Kind::Locked => KEYCHAIN_LOCKED_CODE,
                        Kind::Unavailable => KEYCHAIN_UNAVAILABLE_CODE,
                    }
                );
                assert!(coded.params().is_empty());
                assert!(coded
                    .message()
                    .starts_with("저장 실패: OS 보안 저장소(키링)"));
                for rendered in [core.to_string(), format!("{core:?}")] {
                    assert!(!rendered.contains(PAYLOAD));
                    assert!(!rendered.contains("org.example.test_secret_payload"));
                }
            }
        }
    }

    #[test]
    fn locked_and_dismissed_prompts_are_not_reported_as_a_missing_store() {
        // 파일 폴백을 가진 호출자(OTP 비밀)는 "저장소 없음"일 때만 파일로 간다. 잠김을 같은
        // 코드로 올리면 잠긴 몇 초 사이에 비밀이 파일로 새고, 키링의 옛 값과 갈라진다.
        for error in [SsError::Locked, SsError::Prompt] {
            let core = Failure::from(error).into_core("읽기");
            assert!(!super::super::is_keychain_unavailable(&core), "{core}");
            assert!(super::super::is_keychain_locked(&core), "{core}");
        }
        let core = Failure::from(SsError::Unavailable).into_core("읽기");
        assert!(super::super::is_keychain_unavailable(&core), "{core}");
        let core = Failure::Ambiguous.into_core("읽기");
        assert!(!super::super::is_keychain_unavailable(&core));
        assert!(!super::super::is_keychain_locked(&core));
    }

    #[test]
    fn transient_failures_are_retried_until_the_deadline_then_returned() {
        let mut calls = 0;
        let started = Instant::now();
        let result: Result<(), Failure> = retry_transient(
            started + Duration::from_millis(120),
            Duration::from_millis(20),
            || {
                calls += 1;
                Err(SsError::Locked.into())
            },
        );
        assert!(matches!(result, Err(Failure::Service(SsError::Locked))));
        assert!(calls >= 3, "{calls}");
        assert!(started.elapsed() < Duration::from_secs(5));

        let mut calls = 0;
        let value = retry_transient(
            Instant::now() + Duration::from_secs(5),
            Duration::from_millis(1),
            || {
                calls += 1;
                if calls < 3 {
                    Err(SsError::NoResult.into())
                } else {
                    Ok(calls)
                }
            },
        );
        assert_eq!(value.unwrap(), 3);
    }

    #[test]
    fn non_transient_failures_are_returned_at_once() {
        let mut calls = 0;
        let result: Result<(), Failure> = retry_transient(
            Instant::now() + Duration::from_secs(5),
            Duration::from_millis(1),
            || {
                calls += 1;
                Err(Failure::Ambiguous)
            },
        );
        assert!(matches!(result, Err(Failure::Ambiguous)));
        assert_eq!(calls, 1);
    }

    #[test]
    fn a_held_failure_expires_and_a_success_clears_it() {
        let now = Instant::now();
        hold_failure(now + FAILURE_HOLD, Kind::Locked);
        assert_eq!(held_failure(now), Some(Kind::Locked));
        assert_eq!(held_failure(now + FAILURE_HOLD), None);
        assert_eq!(held_failure(now), None, "만료된 기록은 지운다");

        hold_failure(now + FAILURE_HOLD, Kind::Locked);
        clear_held_failure();
        assert_eq!(held_failure(now), None);
    }

    #[test]
    fn the_secret_service_is_locked_dbus_error_counts_as_locked() {
        let error =
            dbus::Error::new_custom(IS_LOCKED_ERROR, "Cannot get secret of a locked object");
        let core = Failure::from(SsError::from(error)).into_core("읽기");
        assert!(super::super::is_keychain_locked(&core), "{core}");
        let other = dbus::Error::new_custom("org.freedesktop.DBus.Error.NoReply", "no reply");
        let core = Failure::from(SsError::from(other)).into_core("읽기");
        assert!(super::super::is_keychain_unavailable(&core), "{core}");
    }
}
