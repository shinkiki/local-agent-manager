//! C9-17. 허용 목록 밖 SSH 명령을 즉시 거절하는 대신, 사용자가 지금 보고 있는 대화에서
//! 그 **한 번**을 승인할 수 있게 하는 토큰 저장소.
//!
//! # 왜 즉시 거절을 대체하지 않고 남기는가
//!
//! 목록 밖 명령을 그 자리에서 거절하면 AIA가 할 수 있는 유일한 다음 수는 "사용자에게
//! 목록을 고쳐 달라"는 안내다. 그 안내는 설정 화면을 열게 하고, 한 번 적힌 규칙은 그
//! 서버에 대해 **영구히** 남는다. 한 번 돌려 보고 싶었을 뿐인 명령이 영구 권한을 만드는
//! 것이 유일한 길이라면 목록은 넓어지는 쪽으로만 움직인다. 그래서 이 자리는 즉시 거절을
//! **일회성 승인**으로 바꾼다 — 실행되는 것은 사용자가 카드에서 읽은 그 한 줄뿐이다.
//!
//! # 토큰이 무엇에 묶이는가
//!
//! 발급된 토큰은 (대화, 지문, 정규화된 명령 문자열, 용도) 네 값에 묶이고 한 번만 쓰인다.
//! 넷 중 하나라도 다르면 소모되지 않는다. 그래서 승인 뒤에 명령을 늘리거나(`ls /srv` →
//! `ls /srv /etc`), 다른 서버에 같은 토큰을 쓰거나, 같은 토큰으로 두 번 실행하는 일이
//! 성립하지 않는다. 만료는 짧다 — 승인은 "지금 이 대화에서 이것을 해라"는 뜻이고, 한참
//! 뒤의 재호출은 사용자가 승인한 그 맥락이 아니다.
//!
//! # 승인이 넘겨 주지 않는 것
//!
//! 토큰은 **허용 목록 대조 한 자리**만 대신한다. 에이전트 사용 토글, 개인키 존재, 셸·
//! 인터프리터·네트워크 페치 앞머리 거절, 그 서버의 차단 목록, 셸 메타문자 거절, 파일
//! 전송 권한은 토큰이 있어도 그대로 걸린다. 호스트 키 검증 실패·권한 거부·시간 초과는
//! 원격이 정하는 결과이므로 승인과 무관하다.
//!
//! # 승인을 낼 수 있는 주체
//!
//! [`SshApprovalStore::resolve`]는 화면의 승인 카드 응답 경로에만 연결된다. 에이전트가
//! 닿는 시스템 인터페이스에는 이 함수로 이어지는 작업이 없고, AIA 커서도 승인 카드
//! 안의 버튼은 누르지 않는다(`src/lib/uiElements.ts`).

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::approval_ledger::{ApprovalEntry, ApprovalLedger, ApprovalWording};
use crate::clock::now_ms;
use crate::CoreError;

/// 승인이 유효한 시간. 사용자가 카드를 읽고 누르기에 충분하고, 승인한 맥락이 흐려질
/// 만큼 길지는 않은 값이다.
pub const SSH_APPROVAL_TTL_MS: i64 = 120_000;

/// 승인 요청의 용도. 실행 토큰과 목록 추가 토큰은 **서로 쓸 수 없다** — 한 번 돌려 보는
/// 허락과 그 서버에 영구히 적는 허락은 다른 결정이고, 사용자는 카드에서 그중 하나만 읽었다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SshApprovalScope {
    /// 이 대화에서 이 명령을 한 번 실행한다. 기본값이다.
    OneShot,
    /// 이 명령을 그 서버의 허용 명령 목록에 영구히 적는다. 실행은 하지 않는다.
    Persist,
}

impl SshApprovalScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OneShot => "oneShot",
            Self::Persist => "persist",
        }
    }

    /// 승인 카드의 종류. 프런트가 승인 버튼의 문구를 이 값으로 가른다 — 일회성 실행과
    /// 영구 추가가 같은 문구로 보이면 분리해 둔 의미가 클릭 자리에서 사라진다.
    pub fn card_kind(self) -> &'static str {
        match self {
            Self::OneShot => "sshCommand",
            Self::Persist => "sshAllowlist",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::OneShot => "SSH 명령 1회 실행 승인",
            Self::Persist => "SSH 허용 명령 목록에 영구 추가",
        }
    }
}

/// 승인 요청 하나. 사용자가 카드에서 읽는 값과 나중에 대조하는 값이 같다.
#[derive(Clone, Debug)]
struct PendingSshApproval {
    id: String,
    chat_id: String,
    fingerprint: String,
    destination: String,
    command: String,
    scope: SshApprovalScope,
    reason: String,
    expires_at: i64,
    /// C9-19. 이 카드가 sudo 비밀번호 입력칸을 함께 띄워야 하는지. 값 자체는 이 구조체에
    /// 담기지 않는다 — 카드는 채팅 이벤트로 나가므로 비밀값이 지나면 안 되고, 사용자가
    /// 입력한 값은 응답 경로에서 곧장 `SshSecretStore`로 간다.
    needs_secret: bool,
    /// 사용자가 허용했는지. 아직 답하지 않았으면 `None`, 거절하면 `Some(false)`.
    granted: Option<bool>,
    /// 이미 한 번 쓰였는지. 소모된 토큰은 같은 값으로 다시 통과하지 않는다.
    consumed: bool,
}

impl PendingSshApproval {
    fn card(&self) -> SshApprovalCard {
        SshApprovalCard {
            id: self.id.clone(),
            kind: self.scope.card_kind().to_owned(),
            title: self.scope.title().to_owned(),
            detail: self.detail(),
            destination: self.destination.clone(),
            command: self.command.clone(),
            scope: self.scope,
            expires_at: self.expires_at,
            reason: self.reason.clone(),
            needs_secret: self.needs_secret,
        }
    }

    /// 승인이 묶인 네 값 중 대화를 뺀 셋을 대조한다. 하나라도 어긋나면 그 값이
    /// 무엇이었는지 말해 주는 문구로 거절한다.
    fn ensure_matches(&self, request: &SshApprovalConsume<'_>) -> Result<(), CoreError> {
        if self.scope != request.scope {
            return Err(CoreError::Conflict(format!(
                "이 승인은 {} 용도로 받은 것이라 {} 경로에서 쓸 수 없습니다. 필요한 용도로 다시 승인을 요청하세요",
                self.scope.as_str(),
                request.scope.as_str()
            )));
        }
        if self.fingerprint != request.fingerprint {
            return Err(CoreError::Conflict(
                "이 승인은 다른 연결 서버에 대한 것입니다. 같은 승인을 다른 서버에 쓸 수 없습니다"
                    .to_owned(),
            ));
        }
        if self.command != request.command {
            return Err(CoreError::Conflict(format!(
                "승인받은 명령과 다릅니다. 사용자가 허용한 것은 \"{}\" 하나이며, 승인 뒤에 명령을 바꾸거나 인자를 덧붙일 수 없습니다",
                self.command
            )));
        }
        Ok(())
    }

    /// 카드 본문. 사용자가 승인 버튼을 누르기 전에 알아야 하는 값은 대상 서버·정확한
    /// 명령·왜 승인이 필요한지 셋이고, 그 셋만 담는다.
    fn detail(&self) -> String {
        let closing = match self.scope {
            // 명령이 무엇을 하는지는 앱이 판정하지 않는다. 그러니 위험을 추측해 적는 대신
            // 확실한 두 가지만 적는다 — 원격에서 벌어진 일은 앱이 되돌릴 수 없고, 허락의
            // 범위는 이 한 줄이다.
            SshApprovalScope::OneShot => "허용하면 이 명령을 이 대화에서 한 번만 실행합니다. 원격에서 일어난 변경은 Agent Manager가 되돌릴 수 없습니다. 명령을 한 글자라도 바꾸거나 다른 서버에 쓰려면 다시 승인해야 합니다.",
            SshApprovalScope::Persist => "허용하면 이 명령이 이 서버의 허용 명령 목록에 영구히 남아 다음부터는 승인 없이 실행됩니다. 이 승인만으로는 지금 실행되지 않습니다.",
        };
        // 답하지 않은 채 만료되면 카드는 스스로 닫힌다. 그 사실을 미리 적어 두어야,
        // 사라진 카드를 누군가 대신 눌렀거나 잘못된 것으로 읽지 않는다.
        let seconds = SSH_APPROVAL_TTL_MS / 1000;
        // C9-19. 비밀번호를 받는 카드는 사용자가 그 값이 어디로 가는지 알고 입력해야 한다.
        // 어디에 적히지 않는다는 것과 언제 사라지는지 둘 다 적는다.
        let secret = if self.needs_secret {
            let minutes = crate::ssh_secrets::SSH_SECRET_TTL_MS / 60_000;
            format!(
                "\n이 명령은 원격에서 sudo 비밀번호를 요구합니다. 입력한 값은 디스크에 저장되지 않고 에이전트에게도 전달되지 않으며, 이 대화에서 이 서버에 대해서만 {minutes}분간 쓰인 뒤 사라집니다."
            )
        } else {
            String::new()
        };
        format!(
            "대상 서버: {}\n실행할 명령: {}\n승인이 필요한 이유: {}\n{closing}{secret}\n{seconds}초 안에 답하지 않으면 이 요청은 자동으로 취소됩니다.",
            self.destination, self.command, self.reason
        )
    }
}

/// 장부가 지키는 규칙(대화 대조·소모·만료·상한)도 거절 문장도 [`crate::approval_ledger`]에
/// 있고, 그 문장에 들어갈 낱말만 여기서 고른다.
impl ApprovalEntry for PendingSshApproval {
    const WORDING: ApprovalWording = ApprovalWording {
        subject: "SSH",
        retry_noun: "명령",
    };

    type Decision = SshApprovalDecision;

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
    }

    fn mark_consumed(&mut self) {
        self.consumed = true;
    }

    fn decision(&self, granted: bool) -> SshApprovalDecision {
        SshApprovalDecision {
            id: self.id.clone(),
            granted,
            scope: self.scope,
            destination: self.destination.clone(),
            command: self.command.clone(),
            fingerprint: self.fingerprint.clone(),
            needs_secret: self.needs_secret,
        }
    }

    /// 만료 문구에 명령을 싣는다. 카드를 여러 장 받아 둔 사용자가 어느 것이 사라졌는지
    /// 알아야 한다.
    fn expired_hint(&self) -> String {
        format!("(\"{}\")", self.command)
    }
}

/// 화면에 띄울 승인 카드. 채팅 이벤트로 나가는 값이라 비밀값은 없다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshApprovalCard {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub destination: String,
    pub command: String,
    pub scope: SshApprovalScope,
    pub expires_at: i64,
    pub reason: String,
    /// C9-19. 화면이 비밀번호 입력칸을 함께 그려야 하는지. 이 카드에 비밀값은 실리지 않는다.
    pub needs_secret: bool,
}

/// 발급된 승인 요청. 호출한 에이전트는 이 값을 그대로 사용자에게 전하고 승인을 기다린다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshApprovalTicket {
    pub id: String,
    pub expires_at: i64,
    pub reason: String,
}

/// 사용자의 결정. 승인된 용도까지 함께 돌려주므로, 결정을 받은 쪽이 "무엇을 승인한
/// 것인지"를 다시 추측하지 않는다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshApprovalDecision {
    pub id: String,
    pub granted: bool,
    pub scope: SshApprovalScope,
    pub destination: String,
    pub command: String,
    /// C9-19. 사용자가 비밀번호를 함께 보냈을 때 그것을 어느 서버 앞으로 둘지 가른다.
    pub fingerprint: String,
    /// C9-19. 이 카드가 비밀번호를 요구했는지. 요구하지 않은 카드에 딸려 온 값은 버린다.
    pub needs_secret: bool,
}

/// 승인 요청을 열 때 필요한 값.
#[derive(Clone, Debug)]
pub struct SshApprovalOpen<'a> {
    pub fingerprint: &'a str,
    pub destination: &'a str,
    /// 정규화된 명령. 요청 원문이 아니라 실제로 넘어갈 값이어야 한다 — 대조하는 값과
    /// 사용자가 읽는 값이 다르면 승인은 다른 명령에 대한 것이 된다.
    pub command: &'a str,
    pub scope: SshApprovalScope,
    pub reason: &'a str,
    /// C9-19. 이 실행이 sudo 비밀번호를 필요로 하고 아직 들고 있지 않은지.
    pub needs_secret: bool,
}

/// 승인 토큰을 소모할 때 대조하는 값. 넷 중 하나라도 어긋나면 통과하지 않는다.
#[derive(Clone, Debug)]
pub struct SshApprovalConsume<'a> {
    pub approval_id: &'a str,
    pub fingerprint: &'a str,
    pub command: &'a str,
    pub scope: SshApprovalScope,
}

/// 승인 흐름의 상대편. `ssh_exec`는 채팅 런타임을 알지 않고 이 계약만 본다 — 대화가 없는
/// 호출자(워크플로 단계 등)에게는 이 값이 없어 승인을 열 수 없고, 그때는 예전처럼 즉시
/// 거절된다.
pub trait SshApprovalGate {
    /// 승인 요청을 열고 그 대화 화면에 카드를 띄운다.
    fn open_ssh_approval(
        &self,
        request: SshApprovalOpen<'_>,
    ) -> Result<SshApprovalTicket, CoreError>;

    /// 승인된 토큰을 이 한 번에 소모한다. 성공하면 그 토큰은 다시 쓸 수 없다.
    fn consume_ssh_approval(&self, request: SshApprovalConsume<'_>) -> Result<(), CoreError>;

    /// C9-19. 이 대화가 그 서버에 대해 sudo 비밀번호를 들고 있는지. 값을 묻지 않고 있는지만
    /// 묻는 자리다 — 승인 카드에 입력칸을 띄울지 가리는 데 쓴다. 대화가 없는 호출자는 값을
    /// 받을 자리도 없으므로 기본은 "없음"이다.
    fn holds_sudo_secret(&self, _fingerprint: &str) -> bool {
        false
    }

    /// C9-19. 실행 직전에 값을 꺼낸다. `Zeroizing`이라 호출자가 떨어뜨리면 함께 지워진다.
    fn take_sudo_secret(&self, _fingerprint: &str) -> Option<Zeroizing<String>> {
        None
    }

    /// C9-19. 원격이 그 값을 거절했을 때 버린다. 틀린 값을 들고 남은 시간 내내 실패하는
    /// 대신 다음 명령에서 다시 묻는다.
    fn discard_sudo_secret(&self, _fingerprint: &str) {}
}

/// 대화별 승인 토큰 저장소. 규칙은 [`ApprovalLedger`]가 지키고, 여기서는 SSH 승인이
/// 무엇을 대조하고 무엇을 카드에 싣는지만 정한다.
#[derive(Debug, Default)]
pub struct SshApprovalStore {
    entries: ApprovalLedger<PendingSshApproval>,
}

impl SshApprovalStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 승인 요청을 하나 연다. 같은 대화에서 같은 지문·명령·용도의 요청이 아직 답을
    /// 기다리고 있으면 새로 열지 않고 그 카드를 돌려준다 — 같은 도구 호출을 두 번 한
    /// AIA 때문에 사용자가 똑같은 카드를 두 장 받지는 않아야 한다.
    pub fn open(
        &self,
        chat_id: &str,
        request: SshApprovalOpen<'_>,
    ) -> Result<(SshApprovalTicket, SshApprovalCard), CoreError> {
        let now = now_ms();
        self.entries.open(
            chat_id,
            now,
            |entry| {
                entry.fingerprint == request.fingerprint
                    && entry.command == request.command
                    && entry.scope == request.scope
            },
            || {
                let entry = PendingSshApproval {
                    // 승인 id는 공급자 승인 id와 한 이름공간을 쓰므로 접두로 갈라 둔다.
                    id: format!("ssh-approval-{}", Uuid::new_v4()),
                    chat_id: chat_id.to_owned(),
                    fingerprint: request.fingerprint.to_owned(),
                    destination: request.destination.to_owned(),
                    command: request.command.to_owned(),
                    scope: request.scope,
                    reason: request.reason.to_owned(),
                    expires_at: now + SSH_APPROVAL_TTL_MS,
                    needs_secret: request.needs_secret,
                    granted: None,
                    consumed: false,
                };
                (entry.id.clone(), entry)
            },
            |entry| (entry.ticket(), entry.card()),
        )
    }

    /// 이 id가 이 저장소의 승인인지. 공급자 승인과 같은 응답 경로를 쓰므로, 응답을
    /// 어디로 보낼지 가리는 데 쓴다. 이미 답한 카드도 만료 전까지는 우리 것이다 —
    /// 두 번째 클릭이 공급자 런타임으로 새어 나가지 않아야 한다.
    pub fn owns(&self, approval_id: &str) -> bool {
        self.entries.owns(approval_id)
    }

    /// 사용자의 결정을 기록한다. 승인은 이 함수를 지나온 것만 유효하다.
    pub fn resolve(
        &self,
        chat_id: &str,
        approval_id: &str,
        granted: bool,
    ) -> Result<SshApprovalDecision, CoreError> {
        self.entries
            .resolve(chat_id, approval_id, now_ms(), granted)
    }

    /// 승인된 토큰을 한 번 쓴다. 네 값 대조를 모두 통과해야 하고, 통과하면 그 자리에서
    /// 소모 표시가 붙는다 — 실행이 실패해도 토큰은 돌아오지 않는다. 실패의 이유(호스트
    /// 키, 권한, 시간 초과)는 원격이 정하는 것이라 다시 시도할 허락과 같지 않다.
    pub fn consume(
        &self,
        chat_id: &str,
        request: SshApprovalConsume<'_>,
    ) -> Result<SshApprovalDecision, CoreError> {
        self.entries
            .consume(chat_id, request.approval_id, now_ms(), |entry| {
                entry.ensure_matches(&request)
            })
    }

    /// 그 대화에서 아직 답을 기다리는 카드. 화면이 다시 붙을 때 되살릴 값이다.
    pub fn pending_cards(&self, chat_id: &str) -> Vec<SshApprovalCard> {
        self.entries
            .pending(chat_id, now_ms(), PendingSshApproval::card)
    }

    /// 그 대화의 승인 요청을 모두 버린다. 대화가 끝나면 그 맥락에서 받은 허락도 끝난다.
    pub fn discard_chat(&self, chat_id: &str) {
        self.entries.discard_chat(chat_id);
    }

    /// 만료 동작을 확인하는 테스트용 입구. 시계를 되감을 수 없으므로 저장본을 늙힌다.
    #[cfg(test)]
    pub(crate) fn expire_for_test(&self, approval_id: &str) {
        self.entries.with_entry_for_test(approval_id, |entry| {
            entry.expires_at = now_ms() - 1;
        });
    }
}

impl PendingSshApproval {
    fn ticket(&self) -> SshApprovalTicket {
        SshApprovalTicket {
            id: self.id.clone(),
            expires_at: self.expires_at,
            reason: self.reason.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval_ledger::MAX_PENDING_PER_CHAT;

    const CHAT: &str = "chat-1";
    const OTHER_CHAT: &str = "chat-2";
    const PRINT: &str = "SHA256:aaaa";
    const OTHER_PRINT: &str = "SHA256:bbbb";

    fn open_request(command: &str, scope: SshApprovalScope) -> SshApprovalOpen<'_> {
        SshApprovalOpen {
            fingerprint: PRINT,
            destination: "deploy@build.example.com:22",
            command,
            scope,
            reason: "허용 명령 목록에 없습니다",
            needs_secret: false,
        }
    }

    fn consume_request<'a>(
        approval_id: &'a str,
        command: &'a str,
        scope: SshApprovalScope,
    ) -> SshApprovalConsume<'a> {
        SshApprovalConsume {
            approval_id,
            fingerprint: PRINT,
            command,
            scope,
        }
    }

    /// C9-17. 승인 전에는 소모되지 않고, 승인 뒤에는 정확히 한 번만 소모된다.
    #[test]
    fn c9_17_approval_is_single_use_and_requires_an_explicit_grant() {
        let store = SshApprovalStore::new();
        let (ticket, card) = store
            .open(CHAT, open_request("docker ps", SshApprovalScope::OneShot))
            .expect("발급");
        assert!(ticket.expires_at > now_ms());
        assert_eq!(card.scope, SshApprovalScope::OneShot);
        assert_eq!(card.kind, "sshCommand");
        assert!(card.detail.contains("docker ps"));
        assert!(card.detail.contains("deploy@build.example.com:22"));
        assert!(card.detail.contains("한 번만"));
        assert!(store.owns(&ticket.id));

        // 답하지 않은 승인은 쓸 수 없다.
        let error = store
            .consume(
                CHAT,
                consume_request(&ticket.id, "docker ps", SshApprovalScope::OneShot),
            )
            .expect_err("미승인");
        assert!(error.to_string().contains("아직"));

        store.resolve(CHAT, &ticket.id, true).expect("승인");
        store
            .consume(
                CHAT,
                consume_request(&ticket.id, "docker ps", SshApprovalScope::OneShot),
            )
            .expect("첫 사용");
        // 두 번째 사용은 이유를 밝히며 거절된다.
        let error = store
            .consume(
                CHAT,
                consume_request(&ticket.id, "docker ps", SshApprovalScope::OneShot),
            )
            .expect_err("재사용");
        assert!(error.to_string().contains("이미 한 번 사용"));
        // 소모된 카드는 더 이상 대기 목록에 없고, 사용자도 다시 답할 수 없다.
        assert!(store.pending_cards(CHAT).is_empty());
        assert!(store.resolve(CHAT, &ticket.id, true).is_err());
    }

    /// C9-17. 거절된 승인은 실행되지 않고, 만료된 토큰은 승인돼 있어도 쓸 수 없다.
    #[test]
    fn c9_17_declined_and_expired_approvals_never_execute() {
        let store = SshApprovalStore::new();
        let (declined, _) = store
            .open(CHAT, open_request("docker ps", SshApprovalScope::OneShot))
            .expect("발급");
        store.resolve(CHAT, &declined.id, false).expect("거절");
        let error = store
            .consume(
                CHAT,
                consume_request(&declined.id, "docker ps", SshApprovalScope::OneShot),
            )
            .expect_err("거절된 승인");
        assert!(error.to_string().contains("거절"));
        assert!(store.pending_cards(CHAT).is_empty());

        let (expiring, _) = store
            .open(CHAT, open_request("docker logs", SshApprovalScope::OneShot))
            .expect("발급");
        store.resolve(CHAT, &expiring.id, true).expect("승인");
        store.expire_for_test(&expiring.id);
        let error = store
            .consume(
                CHAT,
                consume_request(&expiring.id, "docker logs", SshApprovalScope::OneShot),
            )
            .expect_err("만료");
        assert!(error.to_string().contains("만료"));

        // 만료된 요청에는 사용자도 답할 수 없다.
        let (stale, _) = store
            .open(CHAT, open_request("docker top", SshApprovalScope::OneShot))
            .expect("발급");
        store.expire_for_test(&stale.id);
        assert!(store.resolve(CHAT, &stale.id, true).is_err());
        // 만료 항목은 다음 조회에서 정리된다.
        assert!(store.pending_cards(CHAT).is_empty());
        assert!(!store.owns(&stale.id));
    }

    /// C9-17. 승인은 명령 문자열·서버·용도·대화 넷 모두에 묶인다. 하나라도 다르면 거절된다.
    #[test]
    fn c9_17_approval_is_bound_to_command_endpoint_scope_and_chat() {
        let store = SshApprovalStore::new();
        let (ticket, _) = store
            .open(CHAT, open_request("ls /srv", SshApprovalScope::OneShot))
            .expect("발급");
        store.resolve(CHAT, &ticket.id, true).expect("승인");

        // 명령을 늘리거나 줄이면 다른 명령이다.
        for tampered in ["ls /srv /etc", "ls", "ls  /srv", "ls /srv2"] {
            let error = store
                .consume(
                    CHAT,
                    consume_request(&ticket.id, tampered, SshApprovalScope::OneShot),
                )
                .expect_err(tampered);
            assert!(
                error.to_string().contains("승인받은 명령과 다릅니다"),
                "{tampered}"
            );
        }
        // 다른 서버에는 쓸 수 없다.
        let error = store
            .consume(
                CHAT,
                SshApprovalConsume {
                    approval_id: &ticket.id,
                    fingerprint: OTHER_PRINT,
                    command: "ls /srv",
                    scope: SshApprovalScope::OneShot,
                },
            )
            .expect_err("다른 서버");
        assert!(error.to_string().contains("다른 연결 서버"));
        // 실행 승인으로 목록 추가를 할 수 없다.
        let error = store
            .consume(
                CHAT,
                consume_request(&ticket.id, "ls /srv", SshApprovalScope::Persist),
            )
            .expect_err("다른 용도");
        assert!(error.to_string().contains("용도"));
        // 다른 대화에서는 보이지도 않는다.
        assert!(store
            .consume(
                OTHER_CHAT,
                consume_request(&ticket.id, "ls /srv", SshApprovalScope::OneShot)
            )
            .is_err());
        assert!(store.resolve(OTHER_CHAT, &ticket.id, true).is_err());
        // 넷을 모두 맞춘 호출만 통과한다.
        store
            .consume(
                CHAT,
                consume_request(&ticket.id, "ls /srv", SshApprovalScope::OneShot),
            )
            .expect("정확히 일치");
    }

    /// C9-17. 승인된 토큰 하나에 여러 요청이 동시에 달려들어도 정확히 하나만 통과한다.
    /// 이 성질이 없으면 "1회용"은 순차 호출에서만 참이고, 같은 승인으로 원격 명령이 여러
    /// 번 나갈 수 있다.
    #[test]
    fn c9_17_a_granted_token_survives_exactly_one_of_many_racing_consumers() {
        let store = std::sync::Arc::new(SshApprovalStore::new());
        let (ticket, _) = store
            .open(
                CHAT,
                open_request("docker restart app", SshApprovalScope::OneShot),
            )
            .expect("발급");
        store.resolve(CHAT, &ticket.id, true).expect("승인");

        // 모든 스레드를 같은 자리에서 출발시켜 경쟁을 실제로 만든다.
        let gate = std::sync::Arc::new(std::sync::Barrier::new(8));
        let winners = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let store = std::sync::Arc::clone(&store);
            let gate = std::sync::Arc::clone(&gate);
            let winners = std::sync::Arc::clone(&winners);
            let id = ticket.id.clone();
            handles.push(std::thread::spawn(move || {
                gate.wait();
                let consumed = store
                    .consume(
                        CHAT,
                        SshApprovalConsume {
                            approval_id: &id,
                            fingerprint: PRINT,
                            command: "docker restart app",
                            scope: SshApprovalScope::OneShot,
                        },
                    )
                    .is_ok();
                if consumed {
                    winners.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }));
        }
        for handle in handles {
            handle.join().expect("스레드");
        }
        assert_eq!(winners.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// C9-17. 같은 명령을 두 번 요청해도 카드는 하나이고, 용도가 다르면 각자의 카드를
    /// 받는다. 대화당 대기 건수에는 상한이 있다.
    #[test]
    fn c9_17_concurrent_requests_share_one_card_per_exact_command() {
        let store = SshApprovalStore::new();
        let (first, _) = store
            .open(CHAT, open_request("docker ps", SshApprovalScope::OneShot))
            .expect("첫 요청");
        let (second, _) = store
            .open(CHAT, open_request("docker ps", SshApprovalScope::OneShot))
            .expect("같은 요청");
        assert_eq!(first.id, second.id);
        // 용도가 다르면 다른 결정이므로 카드도 따로 열린다.
        let (persist, persist_card) = store
            .open(CHAT, open_request("docker ps", SshApprovalScope::Persist))
            .expect("목록 추가 요청");
        assert_ne!(first.id, persist.id);
        assert_eq!(persist_card.kind, "sshAllowlist");
        assert!(persist_card.detail.contains("영구히"));
        assert_eq!(store.pending_cards(CHAT).len(), 2);
        assert!(store.pending_cards(OTHER_CHAT).is_empty());

        // 답한 카드는 대기 목록에서 빠진다.
        store.resolve(CHAT, &persist.id, false).expect("거절");
        assert_eq!(store.pending_cards(CHAT).len(), 1);

        for index in 0..MAX_PENDING_PER_CHAT {
            let command = format!("uptime -{index}");
            let opened = store
                .open(CHAT, open_request(&command, SshApprovalScope::OneShot))
                .is_ok();
            // 이미 한 건이 대기 중이라 상한에 닿는 마지막 요청은 거절된다.
            assert_eq!(opened, index + 1 < MAX_PENDING_PER_CHAT, "{index}");
        }

        // 대화가 끝나면 그 대화의 승인도 함께 사라진다.
        store.discard_chat(CHAT);
        assert!(store.pending_cards(CHAT).is_empty());
        assert!(!store.owns(&first.id));
    }
}
