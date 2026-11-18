//! C23-6: 자기 셸이 있는 에이전트가 부르는 `<CLI> peer …` 하위 명령.
//!
//! 교환 상태는 백엔드 메모리에만 있고(`aia_peer_exchange`), 피어에 닿는 것도 백엔드가
//! 테일넷 주소로 한다. 그래서 목록만 이 프로세스에서 읽고 나머지는 모두 떠 있는 백엔드로
//! 넘긴다(`db exec`와 같은 갈래). 백엔드가 없으면 실패로 닫힌다 — 에이전트가 직접 상대
//! 기기에 HTTP 를 보내는 길은 없다.
//!
//! - `peer list`: 에이전트 사용이 켜진 피어 목록. 저장소만 읽는다.
//! - `peer check --peer <id>`: 상대에 인사해 닿는지 본다.
//! - `peer ask --peer <id> --message <글> [--timeout-sec N] [--wait-sec N]`: 묻는다.
//!   `--wait-sec`를 주면 그 시간까지 결과를 기다렸다가 찍는다.
//! - `peer exchange --id <id> [--wait-sec N]`: 교환 하나의 상태·답.
//! - `peer exchanges [--limit N]`: 최근 교환 목록.
//! - `peer skills --peer <id>`: 상대의 스킬 목록과 내 사본 대비 상태.
//! - `peer import --peer <id> --key <키> [--overwrite]`: 상대의 스킬 하나를 가져온다.

use std::path::PathBuf;
use std::time::Duration;

use crate::ssh_endpoints::RELAY_CHAT_ID_ENV;
use crate::CoreError;

const RELAY_TIMEOUT: Duration = Duration::from_secs(60);
/// 한 번의 `get_aia_peer_exchange` 가 기다려 주는 상한보다 조금 길게 잡아 왕복을 덮는다.
const WAIT_RELAY_TIMEOUT: Duration = Duration::from_secs(40);
const MAX_WAIT_SEC: u64 = 30 * 60;

pub fn run_aia_peer_cli(args: impl Iterator<Item = String>) -> Result<(), CoreError> {
    let mut args = args;
    let operation = args.next().ok_or_else(|| {
        CoreError::InvalidInput(
            "peer 다음에 작업이 필요합니다: list | check | ask | exchange | exchanges | skills | import"
                .to_owned(),
        )
    })?;
    let options = PeerCliOptions::from_args(args)?;
    match operation.as_str() {
        "list" => {
            let view = crate::aia_peers::list_agent_aia_peers(&options.app_data_dir, None)?;
            print_json(&view)
        }
        "check" => {
            let body = serde_json::json!({ "request": { "id": options.enabled_peer_id()? } });
            let receipt = relay(&options, "check_aia_peer", &body, RELAY_TIMEOUT)?;
            print_json(&receipt)
        }
        "ask" => {
            let body = serde_json::json!({
                "request": {
                    "peerId": options.peer_required()?,
                    "message": options.message_required()?,
                    "timeoutMs": options.timeout_sec.map(|seconds| seconds * 1000),
                },
                "chatId": options.chat_id,
            });
            let started = relay(&options, "ask_aia_peer", &body, RELAY_TIMEOUT)?;
            let Some(wait_sec) = options.wait_sec else {
                return print_json(&started);
            };
            let id = started
                .get("id")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| CoreError::Runtime("교환 id 를 받지 못했습니다".to_owned()))?
                .to_owned();
            let view = wait_for(&options, &id, wait_sec)?;
            print_json(&view)
        }
        "exchange" => {
            let id = options.id_required()?;
            let view = match options.wait_sec {
                Some(wait_sec) => wait_for(&options, &id, wait_sec)?,
                None => relay(
                    &options,
                    "get_aia_peer_exchange",
                    &serde_json::json!({ "id": id, "waitMs": 0 }),
                    RELAY_TIMEOUT,
                )?,
            };
            print_json(&view)
        }
        "exchanges" => {
            let body = serde_json::json!({ "request": { "limit": options.limit } });
            let list = relay(&options, "list_aia_peer_exchanges", &body, RELAY_TIMEOUT)?;
            print_json(&list)
        }
        "skills" => {
            let body = serde_json::json!({ "request": { "peerId": options.enabled_peer_id()? } });
            let view = relay(&options, "list_aia_peer_skills", &body, RELAY_TIMEOUT)?;
            print_json(&view)
        }
        "import" => {
            let body = serde_json::json!({
                "request": {
                    "peerId": options.enabled_peer_id()?,
                    "key": options.key_required()?,
                    "overwrite": options.overwrite,
                }
            });
            let receipt = relay(&options, "import_aia_peer_skill", &body, RELAY_TIMEOUT)?;
            print_json(&receipt)
        }
        other => Err(CoreError::InvalidInput(format!(
            "알 수 없는 작업입니다: {other}. list | check | ask | exchange | exchanges | skills | import 중 하나를 쓰세요"
        ))),
    }
}

fn print_json(value: &impl serde::Serialize) -> Result<(), CoreError> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn relay(
    options: &PeerCliOptions,
    command: &str,
    body: &serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, CoreError> {
    crate::chat_secret_cli::relay_to_backend(&options.app_data_dir, command, body, timeout)
}

/// 결과가 날 때까지 `get_aia_peer_exchange` 를 되풀이한다. 한 호출은 백엔드가 짧게 기다려
/// 주고(`waitMs`), 여기서는 그 호출을 전체 상한까지 잇는다.
fn wait_for(
    options: &PeerCliOptions,
    id: &str,
    wait_sec: u64,
) -> Result<serde_json::Value, CoreError> {
    let deadline = std::time::Instant::now() + Duration::from_secs(wait_sec.min(MAX_WAIT_SEC));
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let wait_ms = remaining
            .as_millis()
            .min(crate::aia_peer_exchange::MAX_WAIT_MS as u128) as u64;
        let view = relay(
            options,
            "get_aia_peer_exchange",
            &serde_json::json!({ "id": id, "waitMs": wait_ms }),
            WAIT_RELAY_TIMEOUT,
        )?;
        let running = view.get("state").and_then(serde_json::Value::as_str) == Some("running");
        if !running || remaining.is_zero() {
            return Ok(view);
        }
    }
}

#[derive(Debug)]
struct PeerCliOptions {
    peer: Option<String>,
    message: Option<String>,
    id: Option<String>,
    key: Option<String>,
    timeout_sec: Option<u64>,
    wait_sec: Option<u64>,
    limit: Option<u64>,
    overwrite: bool,
    app_data_dir: PathBuf,
    chat_id: Option<String>,
}

impl PeerCliOptions {
    fn from_args(args: impl Iterator<Item = String>) -> Result<Self, CoreError> {
        Self::parse(args, std::env::var(RELAY_CHAT_ID_ENV).ok())
    }

    fn parse(
        args: impl Iterator<Item = String>,
        chat_id: Option<String>,
    ) -> Result<Self, CoreError> {
        let mut args = args;
        let mut peer = None;
        let mut message = None;
        let mut id = None;
        let mut key = None;
        let mut timeout_sec = None;
        let mut wait_sec = None;
        let mut limit = None;
        let mut overwrite = false;
        let mut app_data_dir = None;
        while let Some(flag) = args.next() {
            let mut value = || {
                args.next()
                    .ok_or_else(|| CoreError::InvalidInput(format!("{flag} 값이 필요합니다")))
            };
            // 같은 인자를 두 번 주면 앞의 값이 조용히 사라진다. 어느 쪽이 의도인지 알 수
            // 없으므로 거절한다(C10-13 과 같은 규칙).
            let duplicate =
                || CoreError::InvalidInput(format!("{flag}가 두 번 지정됐습니다. 하나만 남기세요"));
            let number = |text: String, name: &str| {
                text.parse::<u64>()
                    .map_err(|_| CoreError::InvalidInput(format!("{name}는 숫자여야 합니다")))
            };
            match flag.as_str() {
                "--peer" if peer.is_some() => return Err(duplicate()),
                "--message" if message.is_some() => return Err(duplicate()),
                "--id" if id.is_some() => return Err(duplicate()),
                "--key" if key.is_some() => return Err(duplicate()),
                "--timeout-sec" if timeout_sec.is_some() => return Err(duplicate()),
                "--wait-sec" if wait_sec.is_some() => return Err(duplicate()),
                "--limit" if limit.is_some() => return Err(duplicate()),
                "--app-data-dir" if app_data_dir.is_some() => return Err(duplicate()),
                "--peer" => peer = Some(value()?),
                "--message" => message = Some(value()?),
                "--id" => id = Some(value()?),
                "--key" => key = Some(value()?),
                "--timeout-sec" => timeout_sec = Some(number(value()?, "--timeout-sec")?),
                "--wait-sec" => wait_sec = Some(number(value()?, "--wait-sec")?),
                "--limit" => limit = Some(number(value()?, "--limit")?),
                "--overwrite" => overwrite = true,
                "--app-data-dir" => app_data_dir = Some(PathBuf::from(value()?)),
                other => {
                    return Err(CoreError::InvalidInput(format!(
                        "알 수 없는 인자입니다: {other}"
                    )))
                }
            }
        }
        let app_data_dir = crate::remote::cli_app_data_dir(app_data_dir)?;
        Ok(Self {
            peer,
            message,
            id,
            key,
            timeout_sec,
            wait_sec,
            limit,
            overwrite,
            app_data_dir,
            chat_id: chat_id.filter(|value| !value.trim().is_empty()),
        })
    }

    fn peer_required(&self) -> Result<String, CoreError> {
        self.peer
            .clone()
            .ok_or_else(|| CoreError::InvalidInput("--peer <피어 id> 가 필요합니다".to_owned()))
    }

    /// C23-7: CLI 릴레이는 `/api/invoke`의 사용자 문맥으로 들어가므로, 화면과 길을 공유하는
    /// 연결 확인·스킬 목록·스킬 가져오기는 백엔드로 넘기기 전에 기능 활성과 에이전트 사용
    /// 토글(`agent_peer_of`)을 먼저 확인한다.
    fn enabled_peer_id(&self) -> Result<String, CoreError> {
        let id = self.peer_required()?;
        Ok(crate::aia_peers::agent_peer_of(&self.app_data_dir, &id)?.id)
    }

    fn message_required(&self) -> Result<String, CoreError> {
        self.message
            .clone()
            .ok_or_else(|| CoreError::InvalidInput("--message <글> 이 필요합니다".to_owned()))
    }

    fn id_required(&self) -> Result<String, CoreError> {
        self.id
            .clone()
            .ok_or_else(|| CoreError::InvalidInput("--id <교환 id> 가 필요합니다".to_owned()))
    }

    fn key_required(&self) -> Result<String, CoreError> {
        self.key
            .clone()
            .ok_or_else(|| CoreError::InvalidInput("--key <스킬 키> 가 필요합니다".to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c23_6_flags_are_parsed_and_the_chat_id_comes_from_the_environment() {
        let options = PeerCliOptions::parse(
            [
                "--peer",
                "peer-1",
                "--message",
                "안녕",
                "--timeout-sec",
                "90",
                "--wait-sec",
                "120",
                "--overwrite",
                "--app-data-dir",
                "/tmp/app",
            ]
            .into_iter()
            .map(str::to_owned),
            Some("chat-1".to_owned()),
        )
        .expect("parse");
        assert_eq!(options.peer.as_deref(), Some("peer-1"));
        assert_eq!(options.message.as_deref(), Some("안녕"));
        assert_eq!(options.timeout_sec, Some(90));
        assert_eq!(options.wait_sec, Some(120));
        assert!(options.overwrite);
        assert_eq!(options.chat_id.as_deref(), Some("chat-1"));
        assert_eq!(options.app_data_dir, PathBuf::from("/tmp/app"));
    }

    #[test]
    fn c23_6_unknown_and_repeated_flags_are_refused() {
        let unknown = PeerCliOptions::parse(
            ["--danger", "1", "--app-data-dir", "/tmp/app"]
                .into_iter()
                .map(str::to_owned),
            None,
        )
        .expect_err("unknown");
        assert!(matches!(unknown, CoreError::InvalidInput(_)));
        let repeated = PeerCliOptions::parse(
            ["--peer", "a", "--peer", "b", "--app-data-dir", "/tmp/app"]
                .into_iter()
                .map(str::to_owned),
            None,
        )
        .expect_err("repeated");
        assert!(matches!(&repeated, CoreError::InvalidInput(message) if message.contains("두 번")));
        let not_number = PeerCliOptions::parse(
            ["--wait-sec", "soon", "--app-data-dir", "/tmp/app"]
                .into_iter()
                .map(str::to_owned),
            None,
        )
        .expect_err("number");
        assert!(matches!(not_number, CoreError::InvalidInput(_)));
    }

    #[test]
    fn c23_7_cli_refuses_check_skills_and_import_while_feature_or_peer_agent_flag_is_off() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = dir.path().to_str().expect("utf8 path");
        let snapshot = crate::aia_peers::set_aia_peer(
            dir.path(),
            None,
            crate::aia_peers::SetAiaPeerRequest {
                id: None,
                name: "NAS".to_owned(),
                url: "https://nas.tail1234.ts.net".to_owned(),
                note: String::new(),
                agent_enabled: Some(true),
            },
        )
        .expect("register peer");
        let peer_id = snapshot.peers[0].id.clone();

        for args in [
            vec!["check", "--peer", &peer_id, "--app-data-dir", app],
            vec!["skills", "--peer", &peer_id, "--app-data-dir", app],
            vec![
                "import",
                "--peer",
                &peer_id,
                "--key",
                "demo-skill",
                "--app-data-dir",
                app,
            ],
        ] {
            let error = run_aia_peer_cli(args.iter().map(|item| (*item).to_owned()))
                .expect_err("feature off must refuse before relay");
            assert!(
                matches!(&error, CoreError::InvalidInput(message) if message.contains("AIA 대화 기능이 꺼져 있습니다")),
                "{args:?}: {error:?}"
            );
        }

        crate::aia_peers::set_aia_peer_policy(
            dir.path(),
            None,
            crate::aia_peers::SetAiaPeerPolicyRequest {
                enabled: Some(true),
                ..Default::default()
            },
        )
        .expect("enable policy");
        crate::aia_peers::set_aia_peer_agent_enabled(
            dir.path(),
            None,
            crate::aia_peers::SetAiaPeerAgentEnabledRequest {
                id: peer_id.clone(),
                enabled: false,
            },
        )
        .expect("disable peer agent use");

        for args in [
            vec!["check", "--peer", &peer_id, "--app-data-dir", app],
            vec!["skills", "--peer", &peer_id, "--app-data-dir", app],
            vec![
                "import",
                "--peer",
                &peer_id,
                "--key",
                "demo-skill",
                "--app-data-dir",
                app,
            ],
        ] {
            let error = run_aia_peer_cli(args.iter().map(|item| (*item).to_owned()))
                .expect_err("agent_enabled=false must refuse before relay");
            assert!(
                matches!(&error, CoreError::InvalidInput(message) if message.contains("에이전트 사용이 꺼져 있습니다")),
                "{args:?}: {error:?}"
            );
        }
    }
}
