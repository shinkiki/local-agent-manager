//! C15. 자기 셸이 있는 에이전트가 부르는 `<CLI> secret …` 하위 명령.
//!
//! 값은 떠 있는 백엔드의 메모리에만 있으므로 세 작업 모두 백엔드로 넘어간다. 이 프로세스는
//! 값을 받지도, 명령을 직접 돌리지도 않는다 — 대행 실행의 영수증만 그대로 출력한다.
//!
//! - `secret list`: 이 대화의 비밀값 이름·용도·만료.
//! - `secret request --name NAME --purpose "…"`: 사용자에게 입력 카드를 띄운다.
//! - `secret run [--env ENV=NAME …] [--stdin TEXT] [--cwd DIR] [--timeout SEC] -- cmd args…`:
//!   백엔드가 값을 환경변수와 인자·stdin의 `{{secret:NAME}}` 자리에 넣어 명령을 돌리고,
//!   출력에서 값을 지운 영수증을 돌려준다.
//! - `secret write --path FILE (--content TEXT | --content-stdin) [--overwrite]`:
//!   내용의 자리표시자를 채운 파일을 백엔드가 대신 쓴다.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use crate::ssh_endpoints::RELAY_CHAT_ID_ENV;
use crate::CoreError;

pub fn run_chat_secret_cli(args: impl Iterator<Item = String>) -> Result<(), CoreError> {
    let mut args = args;
    let operation = args.next().ok_or_else(|| {
        CoreError::InvalidInput(
            "secret 다음에 작업이 필요합니다: list | request | run | write".to_owned(),
        )
    })?;
    let options = SecretCliOptions::from_args(args)?;
    let (command, body) = match operation.as_str() {
        "list" => (
            "list_chat_secrets",
            serde_json::json!({ "chatId": options.chat_id }),
        ),
        "request" => (
            "request_chat_secret",
            serde_json::json!({
                "request": {
                    "name": options.required(&options.name, "--name")?,
                    "purpose": options.required(&options.purpose, "--purpose")?,
                },
                "chatId": options.chat_id,
            }),
        ),
        "run" => {
            if options.command.is_empty() {
                return Err(CoreError::InvalidInput(
                    "`--` 뒤에 실행할 명령이 필요합니다".to_owned(),
                ));
            }
            (
                "run_with_chat_secrets",
                serde_json::json!({
                    "request": {
                        "command": options.command,
                        "env": options.env,
                        "stdin": options.stdin,
                        "cwd": options.cwd,
                        "timeoutSeconds": options.timeout_seconds,
                    },
                    "chatId": options.chat_id,
                }),
            )
        }
        "write" => {
            let content = match (&options.content, options.content_stdin) {
                (Some(content), false) => content.clone(),
                (None, true) => {
                    let mut buffer = String::new();
                    std::io::Read::read_to_string(&mut std::io::stdin(), &mut buffer)?;
                    buffer
                }
                _ => {
                    return Err(CoreError::InvalidInput(
                        "--content TEXT 또는 --content-stdin 중 하나가 필요합니다".to_owned(),
                    ))
                }
            };
            (
                "write_file_with_chat_secrets",
                serde_json::json!({
                    "request": {
                        "path": options.required(&options.path, "--path")?,
                        "content": content,
                        "overwrite": options.overwrite,
                    },
                    "chatId": options.chat_id,
                }),
            )
        }
        other => {
            return Err(CoreError::InvalidInput(format!(
                "알 수 없는 작업입니다: {other}. list | request | run | write 중 하나를 쓰세요"
            )))
        }
    };
    let value = relay(&options, command, &body)?;
    println!("{}", serde_json::to_string_pretty(&value)?);
    if command == "run_with_chat_secrets" {
        // 실행 결과가 실패면 종료 코드로도 알린다. 출력만 읽지 않는 호출자가 "됐다"로
        // 오해하지 않게 한다.
        let success = value
            .get("success")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if !success {
            std::process::exit(1);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SecretCliOptions {
    name: Option<String>,
    purpose: Option<String>,
    env: BTreeMap<String, String>,
    stdin: Option<String>,
    cwd: Option<String>,
    timeout_seconds: Option<u64>,
    command: Vec<String>,
    path: Option<String>,
    content: Option<String>,
    content_stdin: bool,
    overwrite: bool,
    app_data_dir: PathBuf,
    chat_id: Option<String>,
}

impl SecretCliOptions {
    fn from_args(args: impl Iterator<Item = String>) -> Result<Self, CoreError> {
        Self::parse(args, std::env::var(RELAY_CHAT_ID_ENV).ok())
    }

    fn parse(
        args: impl Iterator<Item = String>,
        chat_id: Option<String>,
    ) -> Result<Self, CoreError> {
        let mut args = args;
        let mut name = None;
        let mut purpose = None;
        let mut env = BTreeMap::new();
        let mut stdin = None;
        let mut cwd = None;
        let mut timeout_seconds = None;
        let mut app_data_dir = None;
        let mut command = Vec::new();
        let mut path = None;
        let mut content = None;
        let mut content_stdin = false;
        let mut overwrite = false;
        while let Some(flag) = args.next() {
            if flag == "--" {
                command.extend(args.by_ref());
                break;
            }
            // 값 없는 스위치는 값을 집어삼키지 않게 먼저 가른다.
            match flag.as_str() {
                "--content-stdin" => {
                    content_stdin = true;
                    continue;
                }
                "--overwrite" => {
                    overwrite = true;
                    continue;
                }
                _ => {}
            }
            let mut value = || {
                args.next()
                    .ok_or_else(|| CoreError::InvalidInput(format!("{flag} 값이 필요합니다")))
            };
            match flag.as_str() {
                "--name" => name = Some(value()?),
                "--purpose" => purpose = Some(value()?),
                "--env" => {
                    let pair = value()?;
                    let (env_name, secret_name) = pair.split_once('=').ok_or_else(|| {
                        CoreError::InvalidInput(format!(
                            "--env는 ENV=NAME 모양이어야 합니다: {pair}"
                        ))
                    })?;
                    env.insert(env_name.to_owned(), secret_name.to_owned());
                }
                "--stdin" => stdin = Some(value()?),
                "--path" => path = Some(value()?),
                "--content" => content = Some(value()?),
                "--cwd" => cwd = Some(value()?),
                "--timeout" => {
                    timeout_seconds = Some(value()?.parse::<u64>().map_err(|_| {
                        CoreError::InvalidInput("--timeout은 초 단위 숫자여야 합니다".to_owned())
                    })?)
                }
                "--app-data-dir" => app_data_dir = Some(PathBuf::from(value()?)),
                other => {
                    return Err(CoreError::InvalidInput(format!(
                        "알 수 없는 인자입니다: {other}. 명령은 `--` 뒤에 적으세요"
                    )))
                }
            }
        }
        Ok(Self {
            name,
            purpose,
            env,
            stdin,
            cwd,
            timeout_seconds,
            command,
            path,
            content,
            content_stdin,
            overwrite,
            app_data_dir: match app_data_dir {
                Some(path) => path,
                None => crate::remote::default_app_data_dir().map_err(CoreError::InvalidInput)?,
            },
            chat_id,
        })
    }

    fn required<'a>(&self, value: &'a Option<String>, flag: &str) -> Result<&'a str, CoreError> {
        value
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| CoreError::InvalidInput(format!("{flag} 값이 필요합니다")))
    }
}

/// 떠 있는 백엔드에 넘긴다. 값은 그쪽 메모리에만 있으므로 이 프로세스가 대신할 길이 없다.
fn relay(
    options: &SecretCliOptions,
    command: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, CoreError> {
    if options.chat_id.as_deref().unwrap_or_default().is_empty() {
        return Err(CoreError::Conflict(format!(
            "이 셸에 {RELAY_CHAT_ID_ENV}가 없습니다. Agent Manager가 띄운 대화의 셸에서만 비밀값을 쓸 수 있습니다"
        )));
    }
    let pointer = crate::system_skills::read_session_read_cli_pointer(&options.app_data_dir)?;
    let port = pointer.backend_port.ok_or_else(|| {
        CoreError::Conflict(
            "Agent Manager 백엔드가 포트를 남기지 않은 예전 버전입니다. 앱을 다시 시작한 뒤 시도하세요".to_owned(),
        )
    })?;
    let timeout = options
        .timeout_seconds
        .unwrap_or(crate::chat_secrets::DEFAULT_RUN_TIMEOUT_SECONDS)
        .min(crate::chat_secrets::MAX_RUN_TIMEOUT_SECONDS)
        .saturating_add(30);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|error| {
            CoreError::Runtime(format!("HTTP 클라이언트를 만들지 못했습니다: {error}"))
        })?;
    let response = client
        .post(format!("http://127.0.0.1:{port}/api/invoke/{command}"))
        .json(body)
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

    fn parse(args: &[&str]) -> SecretCliOptions {
        // `--app-data-dir`는 `--` 앞에 있어야 옵션이다. 뒤에 붙이면 명령의 인자가 된다.
        SecretCliOptions::parse(
            ["--app-data-dir", "/tmp/app"]
                .iter()
                .chain(args.iter())
                .map(|arg| (*arg).to_owned()),
            Some("chat-1".to_owned()),
        )
        .expect("parse")
    }

    #[test]
    fn run_flags_and_command_are_split_at_double_dash() {
        let options = parse(&[
            "--env",
            "API_KEY=SERVICE",
            "--env",
            "TOKEN=TOKEN",
            "--timeout",
            "30",
            "--",
            "curl",
            "--env",
            "https://example.com",
        ]);
        assert_eq!(
            options.env.get("API_KEY").map(String::as_str),
            Some("SERVICE")
        );
        assert_eq!(options.env.get("TOKEN").map(String::as_str), Some("TOKEN"));
        assert_eq!(options.timeout_seconds, Some(30));
        assert_eq!(
            options.command,
            vec!["curl", "--env", "https://example.com"],
            "`--` 뒤의 --env는 명령의 인자다"
        );
        assert_eq!(options.chat_id.as_deref(), Some("chat-1"));
    }

    #[test]
    fn env_pair_must_have_an_equals_sign() {
        let error = SecretCliOptions::parse(
            ["--env", "BROKEN", "--app-data-dir", "/tmp/app"]
                .iter()
                .map(|arg| (*arg).to_owned()),
            None,
        )
        .expect_err("ENV=NAME 모양이 아니다");
        assert!(error.to_string().contains("ENV=NAME"));
    }

    #[test]
    fn write_flags_and_bare_switches_are_parsed() {
        let options = parse(&[
            "--path",
            "/proj/.env",
            "--overwrite",
            "--content",
            "KEY={{secret:KEY}}",
        ]);
        assert_eq!(options.path.as_deref(), Some("/proj/.env"));
        assert!(options.overwrite);
        assert_eq!(options.content.as_deref(), Some("KEY={{secret:KEY}}"));
        assert!(!options.content_stdin);
        let options = parse(&["--content-stdin", "--path", "/proj/.env"]);
        assert!(
            options.content_stdin,
            "값 없는 스위치가 다음 인자를 삼키면 안 된다"
        );
        assert_eq!(options.path.as_deref(), Some("/proj/.env"));
    }

    #[test]
    fn request_needs_name_and_purpose() {
        let options = parse(&["--name", "API_KEY"]);
        assert!(options.required(&options.purpose, "--purpose").is_err());
        assert_eq!(
            options.required(&options.name, "--name").expect("name"),
            "API_KEY"
        );
    }
}
