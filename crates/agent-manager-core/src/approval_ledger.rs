//! 대화에 묶인 1회용 승인 토큰의 공통 장부.
//!
//! # 왜 한 벌로 모으는가
//!
//! `ssh_approvals`와 `db_approvals`는 사용자가 읽는 값(대상 서버·명령 대 연결·SQL·영향
//! 행 수)이 달라 타입을 나눠 두지만, **토큰을 지키는 규칙은 하나도 다르지 않았다** —
//! 대화별 미결 상한, 전체 상한, 같은 요청의 카드 두 장 막기, 만료된 항목 청소,
//! "이 대화의 항목인가 → 이미 소모됐는가 → 만료됐는가" 세 관문, 대화가 끝나면 버리기.
//! 두 벌로 펼쳐 두면 한쪽에만 관문을 더하거나 상한을 고쳐도 컴파일은 지나가고, 승인
//! 경계는 그런 어긋남이 그대로 구멍이 되는 자리다. 규칙은 여기 한 곳에 두고, 사용자가
//! 읽는 문구는 [`ApprovalEntry::WORDING`]이 고르는 낱말만 갈아 끼워 여기서 조립한다.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::CoreError;

/// 한 대화가 동시에 답을 기다릴 수 있는 카드 수. 사용자가 카드 더미에 묻히지 않을 만큼.
pub(crate) const MAX_PENDING_PER_CHAT: usize = 8;
/// 저장소 전체 항목 수. 만료 청소를 지나고도 이만큼 쌓였으면 새 요청을 받지 않는다.
const MAX_ENTRIES: usize = 64;

/// 승인 항목을 꺼내러 온 자리. [`ApprovalLedger::resolve`]와 [`ApprovalLedger::consume`]은
/// 같은 세 관문을 같은 순서로 지나면서 문구만 달랐다. 순서는
/// [`ApprovalLedger::with_usable`] 한 곳에 두고 문구만 이 표로 가른다.
#[derive(Clone, Copy)]
pub(crate) enum ApprovalUse {
    /// 사용자의 결정을 적으러 왔다.
    Resolve,
    /// 승인된 토큰을 쓰러 왔다.
    Consume,
}

/// 거절 문구가 승인 종류마다 실제로 달랐던 두 낱말. 나머지 문장은 SSH 쪽과 데이터베이스
/// 쪽이 글자까지 같았고, 두 벌로 펼쳐 두면 한쪽 문구만 고쳐도 아무것도 걸리지 않는다.
pub(crate) struct ApprovalWording {
    /// 승인의 종류를 가리키는 말. "SSH", "데이터베이스".
    pub subject: &'static str,
    /// 다시 승인을 받아야 하는 대상. "명령", "문장".
    pub retry_noun: &'static str,
}

/// 장부에 담기는 항목이 갖춰야 하는 것. 상태를 읽는 몇 가지와, 거절할 때 사용자가 읽을
/// 문구다. 문구를 트레잇에 두는 이유는 "SSH 승인"과 "데이터베이스 승인"이 서로 다른
/// 말을 해야 하는데 그 차이가 규칙 쪽으로 새면 안 되기 때문이다. 문장 자체는 [`WORDING`]
/// 두 낱말로 조립하는 기본 구현이 만들고, 구현은 낱말만 고른다.
///
/// [`WORDING`]: ApprovalEntry::WORDING
pub(crate) trait ApprovalEntry {
    /// 이 승인 종류가 문구에 쓰는 낱말.
    const WORDING: ApprovalWording;

    /// 결정이 난 항목이 호출한 쪽에 돌려주는 값. 승인 종류마다 실어 보내는 값이 달라
    /// 타입으로 열어 두고, 그 값을 언제 만드는지는 장부가 정한다.
    type Decision;

    /// 이 항목을 연 대화. 다른 대화의 id로는 꺼낼 수 없다.
    fn chat_id(&self) -> &str;

    /// 만료 시각(ms). 정렬 기준이기도 하다.
    fn expires_at(&self) -> i64;

    /// 이미 한 번 쓰인 항목인가.
    fn is_consumed(&self) -> bool;

    /// 사용자가 허용했는지. 아직 답하지 않았으면 `None`, 거절하면 `Some(false)`.
    fn granted(&self) -> Option<bool>;

    /// 사용자의 답을 적는다.
    fn set_granted(&mut self, granted: bool);

    /// 토큰을 소모한 것으로 표시한다. 한 번 표시되면 같은 값으로 다시 통과하지 않는다.
    fn mark_consumed(&mut self);

    /// 결정이 난 항목을 호출한 쪽이 읽을 값으로 옮긴다.
    fn decision(&self, granted: bool) -> Self::Decision;

    /// 아직 사용자의 답을 기다리는가. 답이 없고 아직 쓰이지 않은 항목이라는 뜻은 승인
    /// 종류와 무관하게 같아, 상태 두 개에서 여기서 세운다.
    fn is_awaiting(&self) -> bool {
        self.granted().is_none() && !self.is_consumed()
    }

    fn expired(&self, now: i64) -> bool {
        now >= self.expires_at()
    }

    /// 사용자가 실제로 허용했는지 본다. 답이 없는 것과 거절은 다른 문구로 갈라 준다 —
    /// 애초에 이 토큰으로 될 수 없는 호출에 "답을 기다리세요"라고 답하면, 호출한 쪽은
    /// 기다리기만 하면 되는 줄 안다. 대조를 지난 호출만 여기까지 온다.
    fn ensure_granted(&self) -> Result<(), CoreError> {
        match self.granted() {
            None => Err(CoreError::Conflict(
                "사용자가 아직 이 승인 요청에 답하지 않았습니다. 답을 기다리세요".to_owned(),
            )),
            Some(false) => Err(CoreError::Conflict(
                "사용자가 이 요청을 거절했습니다".to_owned(),
            )),
            Some(true) => Ok(()),
        }
    }

    /// 만료 문구에 덧붙일 단서. 카드를 여러 장 받아 둔 사용자가 어느 것이 사라졌는지
    /// 알아야 하는 쪽만 채운다.
    fn expired_hint(&self) -> String {
        String::new()
    }

    /// 저장소 락이 깨졌을 때의 문구.
    fn lock_poisoned() -> CoreError {
        CoreError::Runtime(format!(
            "{} 승인 저장소 락이 깨졌습니다",
            Self::WORDING.subject
        ))
    }

    /// 이 대화에 그 id가 없을 때.
    fn missing(usage: ApprovalUse) -> CoreError {
        CoreError::NotFound(match usage {
            ApprovalUse::Resolve => {
                format!(
                    "이미 끝났거나 없는 {} 승인 요청입니다",
                    Self::WORDING.subject
                )
            }
            ApprovalUse::Consume => {
                "이 대화에 그 승인 id가 없습니다. 승인은 요청한 대화에서만 쓸 수 있습니다"
                    .to_owned()
            }
        })
    }

    /// 대화별 미결 상한에 걸렸을 때. 에이전트가 거절될 요청을 연달아 밀어 넣어 승인
    /// 카드로 화면을 덮는 일을 막는다.
    fn too_many_pending() -> CoreError {
        CoreError::Conflict(format!(
            "이 대화에 답을 기다리는 {} 승인 요청이 이미 {MAX_PENDING_PER_CHAT}건입니다. 사용자가 그 카드에 답한 뒤 다시 요청하세요",
            Self::WORDING.subject
        ))
    }

    /// 저장소 전체 상한에 걸렸을 때.
    fn too_many_entries() -> CoreError {
        CoreError::Conflict(format!(
            "답을 기다리는 {} 승인 요청이 너무 많습니다",
            Self::WORDING.subject
        ))
    }

    /// 이미 소모된 항목을 다시 꺼내려 할 때.
    fn already_consumed(&self, usage: ApprovalUse) -> CoreError {
        CoreError::Conflict(match usage {
            ApprovalUse::Resolve => {
                format!("이 {} 승인은 이미 사용됐습니다", Self::WORDING.subject)
            }
            ApprovalUse::Consume => format!(
                "이 승인은 이미 한 번 사용됐습니다. 같은 {}을 다시 실행하려면 사용자에게 다시 승인을 받으세요",
                Self::WORDING.retry_noun
            ),
        })
    }

    /// 만료된 항목을 꺼내려 할 때.
    fn already_expired(&self, usage: ApprovalUse) -> CoreError {
        CoreError::Conflict(match usage {
            ApprovalUse::Resolve => format!(
                "이 {} 승인 요청은 만료됐습니다{}. 필요하면 에이전트에게 다시 요청하게 하세요",
                Self::WORDING.subject,
                self.expired_hint()
            ),
            ApprovalUse::Consume => {
                "이 승인은 만료됐습니다. 사용자에게 다시 승인을 요청하세요".to_owned()
            }
        })
    }
}

/// 대화별 승인 토큰 장부. 프로세스 메모리에만 있고 디스크에 남지 않는다 — 승인은 지금
/// 이 대화에 대한 것이라, 백엔드가 다시 뜬 뒤에도 유효하다면 그 전제가 깨진다.
#[derive(Debug)]
pub(crate) struct ApprovalLedger<T> {
    entries: Mutex<HashMap<String, T>>,
}

impl<T> Default for ApprovalLedger<T> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<T: ApprovalEntry> ApprovalLedger<T> {
    /// 요청을 하나 연다. 같은 대화에서 `duplicate`가 가리키는 요청이 아직 답을 기다리고
    /// 있으면 새로 열지 않고 그 항목을 돌려준다 — 같은 도구 호출을 두 번 한 에이전트
    /// 때문에 사용자가 똑같은 카드를 두 장 받지는 않아야 한다.
    pub(crate) fn open<R>(
        &self,
        chat_id: &str,
        now: i64,
        duplicate: impl Fn(&T) -> bool,
        build: impl FnOnce() -> (String, T),
        view: impl Fn(&T) -> R,
    ) -> Result<R, CoreError> {
        let mut entries = self.lock_live(now)?;
        if let Some(existing) = entries
            .values()
            .find(|entry| entry.chat_id() == chat_id && entry.is_awaiting() && duplicate(entry))
        {
            return Ok(view(existing));
        }
        if entries
            .values()
            .filter(|entry| entry.chat_id() == chat_id && entry.is_awaiting())
            .count()
            >= MAX_PENDING_PER_CHAT
        {
            return Err(T::too_many_pending());
        }
        if entries.len() >= MAX_ENTRIES {
            return Err(T::too_many_entries());
        }
        let (id, entry) = build();
        let opened = view(&entry);
        entries.insert(id, entry);
        Ok(opened)
    }

    /// 이 id가 이 장부의 승인인지. 공급자 승인과 같은 응답 경로를 쓰므로, 응답을 어디로
    /// 보낼지 가리는 데 쓴다. 이미 답한 카드도 만료 전까지는 우리 것이다 — 두 번째
    /// 클릭이 공급자 런타임으로 새어 나가지 않아야 한다.
    pub(crate) fn owns(&self, approval_id: &str) -> bool {
        self.lock()
            .map(|entries| entries.contains_key(approval_id))
            .unwrap_or(false)
    }

    /// 사용자의 결정을 적는다. 승인은 이 걸음을 지나온 것만 유효하다.
    pub(crate) fn resolve(
        &self,
        chat_id: &str,
        approval_id: &str,
        now: i64,
        granted: bool,
    ) -> Result<T::Decision, CoreError> {
        self.with_usable(chat_id, approval_id, now, ApprovalUse::Resolve, |entry| {
            entry.set_granted(granted);
            Ok(entry.decision(granted))
        })
    }

    /// 승인된 토큰을 한 번 쓴다. `ensure_matches`가 보는 값은 승인 종류마다 다르지만
    /// **순서는 다르지 않다** — 토큰이 묶인 값 대조를 사용자의 답보다 먼저 보고, 둘 다
    /// 지난 뒤에야 소모 표시가 붙는다. 실행이 실패해도 토큰은 돌아오지 않는다.
    pub(crate) fn consume<R>(
        &self,
        chat_id: &str,
        approval_id: &str,
        now: i64,
        ensure_matches: impl FnOnce(&T) -> Result<R, CoreError>,
    ) -> Result<T::Decision, CoreError> {
        self.with_usable(chat_id, approval_id, now, ApprovalUse::Consume, |entry| {
            ensure_matches(entry)?;
            entry.ensure_granted()?;
            entry.mark_consumed();
            Ok(entry.decision(true))
        })
    }

    /// 이 대화의 아직 쓸 수 있는 항목을 꺼내 `act`에 넘긴다. 못 찾거나 이미 소모됐거나
    /// 만료됐으면 `usage`에 맞는 문구로 거절한다. 대화 대조를 조회와 같은 걸음에 두어,
    /// 다른 대화의 id를 넘긴 호출이 "없는 항목"과 구분되지 않게 한다.
    fn with_usable<R>(
        &self,
        chat_id: &str,
        approval_id: &str,
        now: i64,
        usage: ApprovalUse,
        act: impl FnOnce(&mut T) -> Result<R, CoreError>,
    ) -> Result<R, CoreError> {
        let mut entries = self.lock()?;
        let entry = entries
            .get_mut(approval_id)
            .filter(|entry| entry.chat_id() == chat_id)
            .ok_or_else(|| T::missing(usage))?;
        if entry.is_consumed() {
            return Err(entry.already_consumed(usage));
        }
        if entry.expired(now) {
            return Err(entry.already_expired(usage));
        }
        act(entry)
    }

    /// 그 대화에서 아직 답을 기다리는 항목을 만료가 이른 것부터. 화면이 다시 붙을 때
    /// 되살릴 값이다.
    pub(crate) fn pending<R>(&self, chat_id: &str, now: i64, view: impl Fn(&T) -> R) -> Vec<R> {
        let Ok(entries) = self.lock_live(now) else {
            return Vec::new();
        };
        let mut awaiting: Vec<&T> = entries
            .values()
            .filter(|entry| entry.chat_id() == chat_id && entry.is_awaiting())
            .collect();
        awaiting.sort_by_key(|entry| entry.expires_at());
        awaiting.into_iter().map(view).collect()
    }

    /// 그 대화의 승인 요청을 모두 버린다. 대화가 끝나면 그 맥락에서 받은 허락도 끝난다.
    pub(crate) fn discard_chat(&self, chat_id: &str) {
        if let Ok(mut entries) = self.lock() {
            entries.retain(|_, entry| entry.chat_id() != chat_id);
        }
    }

    /// 만료 동작을 확인하는 테스트용 입구. 시계를 되감을 수 없으므로 저장본을 늙힌다.
    #[cfg(test)]
    pub(crate) fn with_entry_for_test(&self, approval_id: &str, act: impl FnOnce(&mut T)) {
        act(self.lock().expect("락").get_mut(approval_id).expect("항목"));
    }

    /// 잠금을 잡으면서 만료된 항목을 걷어낸다. 새 요청을 여는 자리와 카드 목록을
    /// 되살리는 자리가 같은 청소를 하므로 한 벌로 둔다.
    fn lock_live(&self, now: i64) -> Result<MutexGuard<'_, HashMap<String, T>>, CoreError> {
        let mut entries = self.lock()?;
        entries.retain(|_, entry| !entry.expired(now));
        Ok(entries)
    }

    fn lock(&self) -> Result<MutexGuard<'_, HashMap<String, T>>, CoreError> {
        self.entries.lock().map_err(|_| T::lock_poisoned())
    }
}
