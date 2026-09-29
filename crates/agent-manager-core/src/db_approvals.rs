//! C10-12: 데이터베이스 쓰기 문장의 1회 승인 토큰 저장소.
//!
//! # SSH 승인과 왜 따로 두는가
//!
//! 구조는 `ssh_approvals`와 같다(대화·대상·정규화된 명령에 묶인 1회용 토큰). 다른 것은
//! **사용자가 카드에서 읽는 값**이다. SSH 카드는 "이 명령을 한 번 실행한다"까지만 말할 수
//! 있지만, 데이터베이스 쓰기는 실행 전에 **몇 행이 바뀌는지** 세어 볼 수 있다. 그 숫자가
//! 카드에 실리면 승인은 "이 SQL을 허락한다"가 아니라 "이만큼의 변경을 허락한다"가 된다.
//! 두 저장소를 한 타입으로 접으면 그 차이가 사라지므로 나눠 둔다.
//!
//! # 승인을 낼 수 있는 대화
//!
//! SSH 승인은 AIA 대화에서만 열린다. 여기서는 앱이 관리하는 **모든** 채팅에서 열린다 —
//! 자기 셸이 있는 에이전트도 `<CLI> db exec`로 백엔드에 실행을 맡기므로, 그 대화에도
//! 카드가 떠야 쓰기 경로가 성립한다. 카드가 뜰 대화가 없는 호출(워크플로 단계, 대화 밖
//! 호출)은 승인을 열 수 없고 그대로 거절된다.

use serde::Serialize;
use uuid::Uuid;

use crate::approval_ledger::{ApprovalEntry, ApprovalLedger, ApprovalWording};
use crate::clock::now_ms;
use crate::CoreError;

/// 승인이 유효한 시간. 사용자가 영향 행 수를 읽고 판단하기에 충분하고, 예행을 돌린
/// 시점의 데이터 상태가 흐려질 만큼 길지는 않은 값이다.
pub const DB_APPROVAL_TTL_MS: i64 = 180_000;

/// 승인 카드에 적히는 문장의 성격. 예행으로 행 수를 세어 본 변경과, 되돌릴 수 없어
/// 예행조차 할 수 없는 변경은 사용자가 다른 결정을 내려야 한다.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DbApprovalKind {
    /// INSERT·UPDATE·DELETE. 트랜잭션 안에서 미리 실행해 영향 행 수를 세고 되돌렸다.
    Dml,
    /// CREATE·ALTER 등. 대부분의 엔진에서 암시적 커밋이라 예행이 성립하지 않는다.
    Ddl,
}

impl DbApprovalKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dml => "dml",
            Self::Ddl => "ddl",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Dml => "데이터베이스 변경 1회 실행 승인",
            Self::Ddl => "데이터베이스 구조 변경 승인",
        }
    }
}

#[derive(Clone, Debug)]
struct PendingDbApproval {
    id: String,
    chat_id: String,
    connection_id: String,
    destination: String,
    environment: String,
    sql: String,
    kind: DbApprovalKind,
    /// 예행에서 바뀐 행 수. DDL은 예행이 없어 비어 있다.
    previewed_rows: Option<u64>,
    reason: String,
    expires_at: i64,
    granted: Option<bool>,
    consumed: bool,
}

impl PendingDbApproval {
    fn ticket(&self) -> DbApprovalTicket {
        DbApprovalTicket {
            id: self.id.clone(),
            expires_at: self.expires_at,
            reason: self.reason.clone(),
        }
    }

    fn card(&self) -> DbApprovalCard {
        DbApprovalCard {
            id: self.id.clone(),
            kind: "dbStatement".to_owned(),
            title: self.kind.title().to_owned(),
            detail: self.detail(),
            destination: self.destination.clone(),
            sql: self.sql.clone(),
            statement_kind: self.kind,
            previewed_rows: self.previewed_rows,
            expires_at: self.expires_at,
            reason: self.reason.clone(),
        }
    }

    /// 카드 본문. 승인 버튼을 누르기 전에 알아야 하는 것은 대상·환경·정확한 SQL·영향
    /// 범위 넷이다. 앱이 SQL의 의도를 추측해 적지는 않는다.
    fn detail(&self) -> String {
        let impact = match (self.kind, self.previewed_rows) {
            (DbApprovalKind::Dml, Some(rows)) => format!(
                "예행 실행 결과 {rows}행이 바뀝니다(트랜잭션 안에서 실행 후 되돌림).\n허용하면 같은 문장을 트랜잭션 안에서 한 번 실행하고 커밋합니다. 예행 뒤 데이터가 바뀌었으면 실제 반영 행 수는 다를 수 있고, 영수증에 두 값이 모두 남습니다."
            ),
            (DbApprovalKind::Dml, None) => "예행 실행으로 영향 행 수를 세지 못했습니다. 허용하면 트랜잭션 안에서 한 번 실행하고 커밋합니다.".to_owned(),
            (DbApprovalKind::Ddl, _) => "구조 변경은 대부분의 엔진에서 암시적 커밋이라 예행이 성립하지 않습니다. **허용하면 되돌릴 수 없습니다.**".to_owned(),
        };
        // 답하지 않은 채 만료되면 카드는 스스로 닫힌다. 그 사실을 미리 적어 둔다.
        let seconds = DB_APPROVAL_TTL_MS / 1000;
        format!(
            "대상: {} [{}]\n실행할 SQL: {}\n승인이 필요한 이유: {}\n{impact}\n{seconds}초 안에 답하지 않으면 이 요청은 자동으로 취소됩니다.",
            self.destination, self.environment, self.sql, self.reason
        )
    }

    /// 토큰이 묶인 연결·문장 성격·SQL이 지금 쓰려는 것과 같은지 본다. 사용자가 읽고
    /// 허락한 것은 이 세 값의 조합 하나뿐이라, 하나라도 어긋나면 승인이 아니다.
    fn ensure_matches(&self, request: &DbApprovalConsume<'_>) -> Result<(), CoreError> {
        if self.connection_id != request.connection_id {
            return Err(CoreError::Conflict(
                "이 승인은 다른 연결에 대한 것입니다. 같은 승인을 다른 데이터베이스에 쓸 수 없습니다".to_owned(),
            ));
        }
        if self.kind != request.kind {
            return Err(CoreError::Conflict(format!(
                "이 승인은 {} 문장으로 받은 것이라 {} 문장에 쓸 수 없습니다",
                self.kind.as_str(),
                request.kind.as_str()
            )));
        }
        if self.sql != request.sql {
            return Err(CoreError::Conflict(format!(
                "승인받은 SQL과 다릅니다. 사용자가 허용한 것은 \"{}\" 하나이며, 승인 뒤에 문장을 바꿀 수 없습니다",
                self.sql
            )));
        }
        Ok(())
    }
}

/// 장부가 지키는 규칙(대화 대조·소모·만료·상한)도 거절 문장도 [`crate::approval_ledger`]에
/// 있고, 그 문장에 들어갈 낱말만 여기서 고른다.
impl ApprovalEntry for PendingDbApproval {
    const WORDING: ApprovalWording = ApprovalWording {
        subject: "데이터베이스",
        retry_noun: "문장",
    };

    type Decision = DbApprovalDecision;

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

    fn decision(&self, granted: bool) -> DbApprovalDecision {
        DbApprovalDecision {
            id: self.id.clone(),
            granted,
            kind: self.kind,
            destination: self.destination.clone(),
            sql: self.sql.clone(),
        }
    }
}

/// 화면에 띄울 승인 카드. 채팅 이벤트로 나가는 값이라 비밀값은 없다.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbApprovalCard {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub destination: String,
    pub sql: String,
    pub statement_kind: DbApprovalKind,
    pub previewed_rows: Option<u64>,
    pub expires_at: i64,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DbApprovalTicket {
    pub id: String,
    pub expires_at: i64,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DbApprovalDecision {
    pub id: String,
    pub granted: bool,
    pub kind: DbApprovalKind,
    pub destination: String,
    pub sql: String,
}

#[derive(Clone, Debug)]
pub struct DbApprovalOpen<'a> {
    pub connection_id: &'a str,
    pub destination: &'a str,
    pub environment: &'a str,
    /// 정규화된 SQL. 사용자가 읽는 값과 나중에 대조하는 값이 같아야 한다.
    pub sql: &'a str,
    pub kind: DbApprovalKind,
    pub previewed_rows: Option<u64>,
    pub reason: &'a str,
}

/// 토큰을 소모할 때 대조하는 값. 하나라도 어긋나면 통과하지 않는다.
#[derive(Clone, Debug)]
pub struct DbApprovalConsume<'a> {
    pub approval_id: &'a str,
    pub connection_id: &'a str,
    pub sql: &'a str,
    pub kind: DbApprovalKind,
}

/// 승인 흐름의 상대편. `db_exec`은 채팅 런타임을 알지 않고 이 계약만 본다.
pub trait DbApprovalGate {
    fn open_db_approval(&self, request: DbApprovalOpen<'_>) -> Result<DbApprovalTicket, CoreError>;

    fn consume_db_approval(&self, request: DbApprovalConsume<'_>) -> Result<(), CoreError>;
}

/// 대화별 승인 토큰 저장소. 규칙은 [`ApprovalLedger`]가 지키고, 여기서는 데이터베이스
/// 승인이 무엇을 대조하고 무엇을 카드에 싣는지만 정한다.
#[derive(Debug, Default)]
pub struct DbApprovalStore {
    entries: ApprovalLedger<PendingDbApproval>,
}

impl DbApprovalStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn open(
        &self,
        chat_id: &str,
        request: DbApprovalOpen<'_>,
    ) -> Result<(DbApprovalTicket, DbApprovalCard), CoreError> {
        let now = now_ms();
        self.entries.open(
            chat_id,
            now,
            // 같은 대화에서 같은 연결·같은 SQL이 아직 답을 기다리면 카드를 두 장 만들지 않는다.
            |entry| {
                entry.connection_id == request.connection_id
                    && entry.sql == request.sql
                    && entry.kind == request.kind
            },
            || {
                let entry = PendingDbApproval {
                    // 공급자 승인·SSH 승인과 한 이름공간을 쓰므로 접두로 갈라 둔다.
                    id: format!("db-approval-{}", Uuid::new_v4()),
                    chat_id: chat_id.to_owned(),
                    connection_id: request.connection_id.to_owned(),
                    destination: request.destination.to_owned(),
                    environment: request.environment.to_owned(),
                    sql: request.sql.to_owned(),
                    kind: request.kind,
                    previewed_rows: request.previewed_rows,
                    reason: request.reason.to_owned(),
                    expires_at: now + DB_APPROVAL_TTL_MS,
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

    /// 사용자의 결정을 기록한다. 승인은 이 함수를 지나온 것만 유효하다.
    pub fn resolve(
        &self,
        chat_id: &str,
        approval_id: &str,
        granted: bool,
    ) -> Result<DbApprovalDecision, CoreError> {
        self.entries
            .resolve(chat_id, approval_id, now_ms(), granted)
    }

    /// 승인된 토큰을 한 번 쓴다. 세 값 대조를 모두 통과해야 하고, 통과하면 그 자리에서
    /// 소모 표시가 붙는다.
    pub fn consume(
        &self,
        chat_id: &str,
        request: DbApprovalConsume<'_>,
    ) -> Result<DbApprovalDecision, CoreError> {
        self.entries
            .consume(chat_id, request.approval_id, now_ms(), |entry| {
                entry.ensure_matches(&request)
            })
    }

    pub fn pending_cards(&self, chat_id: &str) -> Vec<DbApprovalCard> {
        self.entries
            .pending(chat_id, now_ms(), PendingDbApproval::card)
    }

    pub fn discard_chat(&self, chat_id: &str) {
        self.entries.discard_chat(chat_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(store: &DbApprovalStore, sql: &str) -> DbApprovalTicket {
        store
            .open(
                "chat",
                DbApprovalOpen {
                    connection_id: "kbf",
                    destination: "app@db:3306/appdb",
                    environment: "개발",
                    sql,
                    kind: DbApprovalKind::Dml,
                    previewed_rows: Some(3),
                    reason: "쓰기 문장은 매번 사용자 승인을 받습니다",
                },
            )
            .expect("open")
            .0
    }

    #[test]
    fn c10_12_a_token_is_bound_to_one_chat_connection_and_statement() {
        let store = DbApprovalStore::new();
        let ticket = open(&store, "UPDATE t SET a = 1");
        store.resolve("chat", &ticket.id, true).expect("resolve");
        // 다른 SQL로는 소모되지 않는다.
        let error = store
            .consume(
                "chat",
                DbApprovalConsume {
                    approval_id: &ticket.id,
                    connection_id: "kbf",
                    sql: "UPDATE t SET a = 2",
                    kind: DbApprovalKind::Dml,
                },
            )
            .expect_err("different sql");
        assert!(matches!(error, CoreError::Conflict(_)));
        // 같은 SQL은 한 번만 통과한다.
        let request = DbApprovalConsume {
            approval_id: &ticket.id,
            connection_id: "kbf",
            sql: "UPDATE t SET a = 1",
            kind: DbApprovalKind::Dml,
        };
        store.consume("chat", request.clone()).expect("first");
        let error = store.consume("chat", request).expect_err("second");
        assert!(matches!(error, CoreError::Conflict(_)));
    }

    #[test]
    fn c10_12_the_card_states_the_previewed_row_count() {
        let store = DbApprovalStore::new();
        let ticket = open(&store, "DELETE FROM t WHERE a = 1");
        let cards = store.pending_cards("chat");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].id, ticket.id);
        assert!(cards[0].detail.contains("3행이 바뀝니다"));
        assert!(cards[0].detail.contains("개발"));
    }

    #[test]
    fn c10_12_an_unanswered_token_cannot_be_used() {
        let store = DbApprovalStore::new();
        let ticket = open(&store, "UPDATE t SET a = 1");
        let error = store
            .consume(
                "chat",
                DbApprovalConsume {
                    approval_id: &ticket.id,
                    connection_id: "kbf",
                    sql: "UPDATE t SET a = 1",
                    kind: DbApprovalKind::Dml,
                },
            )
            .expect_err("not answered");
        assert!(matches!(error, CoreError::Conflict(_)));
    }
}
