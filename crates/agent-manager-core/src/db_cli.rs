//! C10-13: 자기 셸이 있는 에이전트가 부르는 `<CLI> db …` 하위 명령.
//!
//! SSH(C9-12)와 같은 갈래지만 나뉘는 자리가 다르다. SSH는 에이전트가 `ssh`를 **직접**
//! 부를 수 있어 목록만 주면 됐다. 데이터베이스는 그럴 수 없다 — 비밀번호를 넘겨야 하기
//! 때문이다. 그래서 여기서는 목록도 실행도 앱이 맡고, 에이전트는 연결 id와 SQL만 준다.
//!
//! - `db list`: 열린 연결 목록. 이 프로세스에서 저장소만 읽는다.
//! - `db query`: 읽기 실행. 같은 프로세스에서 [`crate::db_exec`]를 그대로 부르므로 백엔드가
//!   떠 있지 않아도 된다. 정책·상한·마스킹은 같은 코드가 집행한다.
//! - `db exec`: 변경 실행. 승인 카드는 대화에 뜨는 것이라 반드시 떠 있는 백엔드로 넘긴다.

use std::path::PathBuf;
use std::time::Duration;

use crate::ssh_endpoints::RELAY_CHAT_ID_ENV;
use crate::CoreError;

pub fn run_db_cli(args: impl Iterator<Item = String>) -> Result<(), CoreError> {
    let mut args = args;
    let operation = args.next().ok_or_else(|| {
        CoreError::InvalidInput("db 다음에 작업이 필요합니다: list | query | exec".to_owned())
    })?;
    match operation.as_str() {
        "list" => {
            let options = DbCliOptions::from_args(args)?;
            let view = crate::db_connections::list_agent_db_connections(&options.app_data_dir)?;
            println!("{}", serde_json::to_string_pretty(&view)?);
            Ok(())
        }
        "query" => {
            let options = DbCliOptions::from_args(args)?;
            let receipt = crate::db_exec::run_db_query(
                &options.app_data_dir,
                crate::db_exec::DbQueryRequest {
                    connection_id: options.connection_required()?,
                    sql: options.sql_required()?,
                    max_rows: options.max_rows,
                },
            )?;
            println!("{}", serde_json::to_string_pretty(&receipt)?);
            Ok(())
        }
        "exec" => {
            let options = DbCliOptions::from_args(args)?;
            let receipt = relay_db_statement(&options)?;
            println!("{}", serde_json::to_string_pretty(&receipt)?);
            // 승인 대기는 실패가 아니다 — 에이전트는 사용자의 답을 기다렸다가 같은
            // approvalId로 다시 부른다. 종료 코드로 구분해 주지 않으면 출력만 읽지 않는
            // 호출자가 "실행됐다"로 오해한다.
            let committed = receipt
                .get("committed")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            if !committed {
                std::process::exit(2);
            }
            Ok(())
        }
        other => Err(CoreError::InvalidInput(format!(
            "알 수 없는 작업입니다: {other}. list | query | exec 중 하나를 쓰세요"
        ))),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DbCliOptions {
    connection: Option<String>,
    sql: Option<String>,
    approval_id: Option<String>,
    max_rows: Option<u32>,
    app_data_dir: PathBuf,
    chat_id: Option<String>,
}

impl DbCliOptions {
    fn from_args(args: impl Iterator<Item = String>) -> Result<Self, CoreError> {
        Self::parse(args, std::env::var(RELAY_CHAT_ID_ENV).ok())
    }

    fn parse(
        args: impl Iterator<Item = String>,
        chat_id: Option<String>,
    ) -> Result<Self, CoreError> {
        let mut args = args;
        let mut connection = None;
        let mut sql = None;
        let mut approval_id = None;
        let mut max_rows = None;
        let mut app_data_dir = None;
        while let Some(flag) = args.next() {
            let mut value = || {
                args.next()
                    .ok_or_else(|| CoreError::InvalidInput(format!("{flag} 값이 필요합니다")))
            };
            match flag.as_str() {
                "--connection" => connection = Some(value()?),
                "--sql" => sql = Some(value()?),
                "--approval-id" => approval_id = Some(value()?),
                "--max-rows" => {
                    max_rows = Some(value()?.parse::<u32>().map_err(|_| {
                        CoreError::InvalidInput("--max-rows는 숫자여야 합니다".to_owned())
                    })?)
                }
                "--app-data-dir" => app_data_dir = Some(PathBuf::from(value()?)),
                other => {
                    return Err(CoreError::InvalidInput(format!(
                        "알 수 없는 인자입니다: {other}"
                    )))
                }
            }
        }
        Ok(Self {
            connection,
            sql,
            approval_id,
            max_rows,
            app_data_dir: match app_data_dir {
                Some(path) => path,
                None => crate::remote::default_app_data_dir().map_err(CoreError::InvalidInput)?,
            },
            chat_id: chat_id.filter(|value| !value.trim().is_empty()),
        })
    }

    fn connection_required(&self) -> Result<String, CoreError> {
        self.connection
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| CoreError::InvalidInput("--connection 값이 필요합니다".to_owned()))
    }

    fn sql_required(&self) -> Result<String, CoreError> {
        self.sql
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| CoreError::InvalidInput("--sql 값이 필요합니다".to_owned()))
    }
}

/// 변경 실행은 떠 있는 백엔드로 넘긴다. 승인 카드는 대화에 뜨는 것이고, 대화를 아는
/// 것은 백엔드뿐이다.
fn relay_db_statement(options: &DbCliOptions) -> Result<serde_json::Value, CoreError> {
    let pointer = crate::system_skills::read_session_read_cli_pointer(&options.app_data_dir)?;
    let port = pointer.backend_port.ok_or_else(|| {
        CoreError::Conflict(
            "Agent Manager 백엔드가 포트를 남기지 않은 예전 버전입니다. 앱을 다시 시작한 뒤 시도하세요".to_owned(),
        )
    })?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!("HTTP 클라이언트를 만들지 못했습니다: {error}"))
        })?;
    let body = serde_json::json!({
        "request": {
            "connectionId": options.connection_required()?,
            "sql": options.sql_required()?,
            "approvalId": options.approval_id,
        },
        "chatId": options.chat_id,
    });
    let response = client
        .post(format!(
            "http://127.0.0.1:{port}/api/invoke/relay_db_statement"
        ))
        .json(&body)
        .send()
        .map_err(|error| {
            CoreError::Conflict(format!(
                "Agent Manager 백엔드(127.0.0.1:{port})에 연결하지 못했습니다. 앱이 실행 중인지 확인하세요: {error}"
            ))
        })?;
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .map_err(|error| CoreError::Runtime(format!("백엔드 응답을 읽지 못했습니다: {error}")))?;
    if !status.is_success() {
        let message = value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("백엔드가 요청을 거절했습니다");
        return Err(CoreError::Conflict(message.to_owned()));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c10_13_flags_are_parsed_and_the_chat_id_comes_from_the_environment() {
        let options = DbCliOptions::parse(
            [
                "--connection",
                "kbf",
                "--sql",
                "SELECT 1",
                "--max-rows",
                "10",
                "--app-data-dir",
                "/tmp/app",
            ]
            .into_iter()
            .map(str::to_owned),
            Some("chat-1".to_owned()),
        )
        .expect("parse");
        assert_eq!(options.connection.as_deref(), Some("kbf"));
        assert_eq!(options.sql.as_deref(), Some("SELECT 1"));
        assert_eq!(options.max_rows, Some(10));
        assert_eq!(options.chat_id.as_deref(), Some("chat-1"));
    }

    #[test]
    fn c10_13_unknown_flags_are_refused() {
        let error = DbCliOptions::parse(["--danger", "1"].into_iter().map(str::to_owned), None)
            .expect_err("unknown");
        assert!(matches!(error, CoreError::InvalidInput(_)));
    }
}
