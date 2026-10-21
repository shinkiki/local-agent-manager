//! C9-21. 암호(passphrase)가 걸린 SSH 키를 앱이 대신 여는 자리.
//!
//! # 무엇을 하는가
//!
//! 키 암호는 OS 보안 저장소에만 둔다(서비스 [`PASSPHRASE_KEYCHAIN_SERVICE`], 계정은 지문).
//! 앱 데이터에는 "이 지문의 암호가 저장돼 있다"는 사실과 시각만 남는다(G7). 값을 쓰는
//! 자리는 백엔드가 직접 띄우는 `ssh`·`scp`·`ssh-keygen`뿐이고, 그 자식에게는 OpenSSH의
//! askpass 장치로 건넨다 — `SSH_ASKPASS`를 이 실행 파일로, `SSH_ASKPASS_REQUIRE=force`로
//! 두면 OpenSSH는 암호가 필요할 때 이 실행 파일을 프롬프트 한 줄을 인자로 실행하고 그
//! 표준출력 한 줄을 암호로 쓴다.
//!
//! # 값이 어떻게 건너가는가
//!
//! 값은 argv에도 환경에도 파일에도 실리지 않는다. 실행 한 번마다 [`AskpassSession`]이
//! loopback에 임시 포트를 열고 무작위 토큰을 만든다. 자식 환경에는 `포트:토큰`만 들어가고,
//! askpass로 불린 이 실행 파일([`exit_if_invoked_as_ssh_askpass`])이 그 포트에 토큰을 내밀면
//! 세션이 값을 한 줄 돌려준다. 세션은 답할 횟수가 정해져 있고(키 생성은 확인까지 두 번
//! 묻는다) 실행이 끝나 떨어지는 순간 포트를 닫는다.
//!
//! # 에이전트가 값에 닿지 않는 이유
//!
//! 셸이 있는 에이전트(Claude·Codex)는 암호가 걸린 키의 서버에서 `ssh`를 직접 부르지 않고
//! 언제나 `<CLI> ssh exec`로 백엔드에 실행을 맡긴다(C9-12). 그래서 askpass 환경은 에이전트
//! 셸에 들어가지 않는다. askpass는 프롬프트가 키 암호 질문일 때만 답하며, 서버 비밀번호
//! 프롬프트에는 답하지 않는다 — 비밀번호 인증은 이 경로의 `ssh`에서 아예 꺼 둔다.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::clock::now_ms;
use crate::json_store::{JsonStore, SchemaVersioned};
use crate::ssh_keys::{edit_sidecar, load_sidecar, FingerprintSidecar};
use crate::CoreError;

/// askpass로 불린 실행 파일이 `포트:토큰`을 읽는 환경 변수.
pub const ASKPASS_ENV: &str = "AGENT_MANAGER_SSH_ASKPASS";
/// 키 암호를 담는 OS 보안 저장소의 서비스 이름. 계정 이름은 키 지문이다.
pub(crate) const PASSPHRASE_KEYCHAIN_SERVICE: &str = "Agent Manager SSH Key Passphrases";

/// 키 생성만 "입력"과 "확인" 두 번을 묻는다. 접속(`ssh`·`scp`)과 암호 확인(`ssh-keygen -y`)은
/// 한 번이다. 남는 답이 있으면 같은 환경을 물려받은 자식(git hook, ProxyCommand)이 그 답을
/// 가져갈 수 있으므로, 세션은 쓰임에 꼭 맞는 횟수만 답한다.
pub(crate) const KEYGEN_ANSWERS: usize = 2;
pub(crate) const CONNECT_ANSWERS: usize = 1;
/// askpass 자식이 접속·응답을 기다리는 상한. 같은 기기 loopback이라 길 이유가 없다.
const HELPER_IO_TIMEOUT: Duration = Duration::from_secs(5);
/// 접속한 쪽이 토큰을 보내기까지 기다리는 상한. 진짜 helper는 접속하자마자 보낸다.
const TOKEN_READ_TIMEOUT: Duration = Duration::from_secs(1);
/// 동시에 붙들고 있는 연결 수 상한. 넘치는 연결은 바로 끊는다.
const MAX_OPEN_CONNECTIONS: usize = 8;
const ACCEPT_POLL: Duration = Duration::from_millis(20);
const MAX_TOKEN_LINE: u64 = 256;
pub(crate) const MAX_PASSPHRASE_CHARS: usize = 1024;

const STORE_VERSION: u32 = 1;
const STORE: JsonStore = JsonStore {
    file: "ssh-key-passphrases-v1.json",
    lock_file: "ssh-key-passphrases-v1.lock",
    label: "SSH 키 암호 표시 저장소",
    version: STORE_VERSION,
};

/// 앱 데이터에 남는 것은 "저장돼 있다"와 그 시각뿐이다. 값은 OS 보안 저장소에만 있다.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PassphraseMarker {
    pub(crate) saved_at: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PassphraseMarkerStore {
    schema_version: u32,
    #[serde(default)]
    passphrases: BTreeMap<String, PassphraseMarker>,
}

impl Default for PassphraseMarkerStore {
    fn default() -> Self {
        Self {
            schema_version: STORE_VERSION,
            passphrases: BTreeMap::new(),
        }
    }
}

impl SchemaVersioned for PassphraseMarkerStore {
    fn schema_version(&self) -> u32 {
        self.schema_version
    }
}

impl FingerprintSidecar for PassphraseMarkerStore {
    type Value = PassphraseMarker;
    const STORE: JsonStore = STORE;
    const ATTACH_FAILURE: &'static str = "SSH 키 암호 저장 여부를 읽지 못해 없음으로 표시합니다";

    fn table_mut(&mut self) -> &mut BTreeMap<String, PassphraseMarker> {
        &mut self.passphrases
    }

    fn into_table(self) -> BTreeMap<String, PassphraseMarker> {
        self.passphrases
    }
}

/// 값이 실제로 놓이는 자리. 시험은 OS 보안 저장소 대신 메모리 구현을 넘긴다.
pub(crate) trait PassphraseVault {
    fn read(&self, fingerprint: &str) -> Result<Option<Zeroizing<String>>, CoreError>;
    fn write(&self, fingerprint: &str, passphrase: &str) -> Result<(), CoreError>;
    fn delete(&self, fingerprint: &str) -> Result<(), CoreError>;
}

/// OS 보안 저장소(macOS 키체인·Windows 자격 증명 관리자·Secret Service).
pub(crate) struct OsPassphraseVault;

impl PassphraseVault for OsPassphraseVault {
    fn read(&self, fingerprint: &str) -> Result<Option<Zeroizing<String>>, CoreError> {
        crate::os_keychain::read_os_keychain_password(PASSPHRASE_KEYCHAIN_SERVICE, fingerprint)
    }

    fn write(&self, fingerprint: &str, passphrase: &str) -> Result<(), CoreError> {
        crate::os_keychain::write_os_keychain_password(
            PASSPHRASE_KEYCHAIN_SERVICE,
            fingerprint,
            passphrase,
        )
    }

    fn delete(&self, fingerprint: &str) -> Result<(), CoreError> {
        crate::os_keychain::delete_os_keychain_password(PASSPHRASE_KEYCHAIN_SERVICE, fingerprint)
    }
}

/// 암호 한 벌의 모양 검사. 값은 askpass가 한 줄로 돌려주므로 줄바꿈을 담을 수 없다.
pub(crate) fn validate_passphrase(value: &str) -> Result<&str, CoreError> {
    if value.is_empty() {
        return Err(CoreError::InvalidInput("암호가 비어 있습니다".to_owned()));
    }
    if value.chars().count() > MAX_PASSPHRASE_CHARS
        || value.chars().any(|character| character.is_control())
    {
        return Err(CoreError::InvalidInput(format!(
            "암호는 줄바꿈·제어문자 없이 {MAX_PASSPHRASE_CHARS}자 이하여야 합니다"
        )));
    }
    Ok(value)
}

/// 값을 보안 저장소에 넣고, 성공한 뒤에만 표시를 남긴다. 표시가 먼저 남으면 값 없는
/// "저장됨"이 생겨 실행이 엉뚱한 이유로 실패한다.
pub(crate) fn store_passphrase(
    vault: &dyn PassphraseVault,
    app_data_dir: &Path,
    fingerprint: &str,
    passphrase: &str,
) -> Result<(), CoreError> {
    vault.write(fingerprint, validate_passphrase(passphrase)?)?;
    edit_sidecar::<PassphraseMarkerStore>(app_data_dir, |table| {
        table.insert(
            fingerprint.to_owned(),
            PassphraseMarker { saved_at: now_ms() },
        );
        Ok(true)
    })?;
    Ok(())
}

/// 값과 표시를 함께 지운다. 값을 먼저 지운다 — 표시를 먼저 지우면 값 삭제가 실패했을 때
/// 다시 시도할 손잡이(표시)가 사라져 값이 보안 저장소에 고아로 남는다. 값 삭제가 실패하면
/// 표시가 남아 화면에 "저장됨"으로 보이고, 사용자가 다시 지울 수 있다.
pub(crate) fn forget_passphrase(
    vault: &dyn PassphraseVault,
    app_data_dir: &Path,
    fingerprint: &str,
) -> Result<bool, CoreError> {
    if !passphrase_saved(app_data_dir, fingerprint) {
        return Ok(false);
    }
    vault.delete(fingerprint)?;
    edit_sidecar::<PassphraseMarkerStore>(app_data_dir, |table| {
        Ok(table.remove(fingerprint).is_some())
    })
}

pub(crate) fn passphrase_saved(app_data_dir: &Path, fingerprint: &str) -> bool {
    load_sidecar::<PassphraseMarkerStore>(app_data_dir)
        .map(|table| table.contains_key(fingerprint))
        .unwrap_or(false)
}

/// 실행 직전에 값을 꺼낸다. 표시가 없으면 묻지 않고 `None`이다 — 암호 없는 키가 보통이고,
/// 그때 보안 저장소를 두드리면 macOS가 쓸데없이 접근 확인을 띄울 수 있다.
pub(crate) fn load_passphrase(
    vault: &dyn PassphraseVault,
    app_data_dir: &Path,
    fingerprint: &str,
) -> Result<Option<Zeroizing<String>>, CoreError> {
    if !passphrase_saved(app_data_dir, fingerprint) {
        return Ok(None);
    }
    match vault.read(fingerprint)? {
        Some(value) => Ok(Some(value)),
        None => Err(CoreError::Conflict(
            "이 키의 암호가 저장돼 있다고 기록돼 있지만 보안 저장소에서 찾지 못했습니다. 애드온 → SSH에서 암호를 다시 저장하세요".to_owned(),
        )),
    }
}

/// 실행 한 번 동안만 열려 있는 askpass 응답 자리. 정해진 횟수만 답하고, 떨어지면 포트를 닫는다.
pub(crate) struct AskpassSession {
    port: u16,
    token: Zeroizing<String>,
    executable: PathBuf,
    shutdown: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

/// 연결마다 띄우는 응답 스레드가 함께 보는 값.
struct Shared {
    token: Zeroizing<String>,
    secret: Zeroizing<String>,
    remaining: AtomicUsize,
    open: AtomicUsize,
}

impl AskpassSession {
    pub(crate) fn start(secret: Zeroizing<String>, answers: usize) -> Result<Self, CoreError> {
        #[cfg(test)]
        if let Some(executable) = tests::EXECUTABLE_OVERRIDE.with(|cell| cell.borrow().clone()) {
            return Self::start_with_executable(secret, answers, executable);
        }
        Self::start_with_executable(secret, answers, std::env::current_exe()?)
    }

    fn start_with_executable(
        secret: Zeroizing<String>,
        answers: usize,
        executable: PathBuf,
    ) -> Result<Self, CoreError> {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let token = Zeroizing::new(format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ));
        let shutdown = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared {
            token: token.clone(),
            secret,
            remaining: AtomicUsize::new(answers),
            open: AtomicUsize::new(0),
        });
        let worker = {
            let shutdown = Arc::clone(&shutdown);
            std::thread::spawn(move || serve(&listener, &shared, &shutdown))
        };
        Ok(Self {
            port,
            token,
            executable,
            shutdown,
            worker: Some(worker),
        })
    }

    /// 자식 프로세스에 심을 환경. 값 자체는 없고 포트와 토큰만 있다.
    pub(crate) fn env(&self) -> Vec<(String, String)> {
        vec![
            (
                "SSH_ASKPASS".to_owned(),
                self.executable.to_string_lossy().into_owned(),
            ),
            ("SSH_ASKPASS_REQUIRE".to_owned(), "force".to_owned()),
            (
                ASKPASS_ENV.to_owned(),
                format!("{}:{}", self.port, self.token.as_str()),
            ),
        ]
    }

    pub(crate) fn apply(&self, command: &mut std::process::Command) {
        for (key, value) in self.env() {
            command.env(key, value);
        }
    }
}

/// 세션이 없으면 빈 환경. 접속 경로마다 같은 한 줄을 펼쳐 두지 않게 한다.
pub(crate) fn env_of(session: Option<&AskpassSession>) -> Vec<(String, String)> {
    session.map(AskpassSession::env).unwrap_or_default()
}

impl Drop for AskpassSession {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// 연결을 받는 즉시 응답 스레드에 넘긴다. 토큰을 보내지 않고 붙들고 있는 연결 하나가 진짜
/// helper의 차례를 막지 못하게 하려는 것이다. 답할 횟수를 다 쓰면 더 받지 않는다.
fn serve(listener: &TcpListener, shared: &Arc<Shared>, shutdown: &AtomicBool) {
    while shared.remaining.load(Ordering::SeqCst) > 0 && !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                if shared.open.fetch_add(1, Ordering::SeqCst) >= MAX_OPEN_CONNECTIONS {
                    shared.open.fetch_sub(1, Ordering::SeqCst);
                    continue;
                }
                let shared = Arc::clone(shared);
                std::thread::spawn(move || {
                    answer(stream, &shared);
                    shared.open.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(ACCEPT_POLL);
            }
            Err(_) => std::thread::sleep(ACCEPT_POLL),
        }
    }
}

/// 토큰 한 줄을 받아 맞고 답할 횟수가 남아 있으면 값을 한 줄 돌려준다. 틀린 토큰에는 아무것도
/// 쓰지 않는다.
fn answer(stream: TcpStream, shared: &Shared) -> bool {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(TOKEN_READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HELPER_IO_TIMEOUT));
    let mut line = Zeroizing::new(String::new());
    let Ok(reader) = stream.try_clone() else {
        return false;
    };
    if BufReader::new(reader.take(MAX_TOKEN_LINE))
        .read_line(&mut line)
        .is_err()
    {
        return false;
    }
    if line.trim_end() != shared.token.as_str() {
        return false;
    }
    // 횟수는 값을 쓰기 **전에** 줄인다. 동시에 온 두 연결이 마지막 한 번을 함께 가져가지 않게 한다.
    let mut current = shared.remaining.load(Ordering::SeqCst);
    let decremented = loop {
        let Some(next) = current.checked_sub(1) else {
            break false;
        };
        match shared.remaining.compare_exchange_weak(
            current,
            next,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => break true,
            Err(actual) => current = actual,
        }
    };
    if !decremented {
        return false;
    }
    let mut stream = stream;
    let mut reply = Zeroizing::new(String::with_capacity(shared.secret.len() + 1));
    reply.push_str(&shared.secret);
    reply.push('\n');
    stream.write_all(reply.as_bytes()).is_ok() && stream.flush().is_ok()
}

/// OpenSSH가 키 암호를 물을 때 쓰는 프롬프트인지. `ssh`는 "Enter passphrase for key",
/// `ssh-keygen`은 "Enter passphrase", "Enter same passphrase again"으로 묻는다. 서버
/// 비밀번호(`… password:`)나 호스트 키 확인(`Are you sure …`)에는 답하지 않는다.
fn is_passphrase_prompt(prompt: &str) -> bool {
    let prompt = prompt.trim_start();
    prompt.starts_with("Enter passphrase") || prompt.starts_with("Enter same passphrase again")
}

/// askpass로 불렸으면 값을 한 줄 출력하고 프로세스를 끝낸다. 아니면 아무 일도 하지 않는다.
/// 실행 파일의 `main` 맨 앞에서 부른다 — 창·잠금·백엔드를 만들기 전이어야 한다.
pub fn exit_if_invoked_as_ssh_askpass() {
    let Ok(value) = std::env::var(ASKPASS_ENV) else {
        return;
    };
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let code = match run_helper(&value, &prompt) {
        Ok(secret) => {
            let mut stdout = std::io::stdout();
            let written = stdout
                .write_all(secret.as_bytes())
                .and_then(|()| stdout.write_all(b"\n"))
                .and_then(|()| stdout.flush());
            i32::from(written.is_err())
        }
        Err(message) => {
            eprintln!("Agent Manager askpass: {message}");
            1
        }
    };
    std::process::exit(code);
}

fn run_helper(value: &str, prompt: &str) -> Result<Zeroizing<String>, String> {
    if !is_passphrase_prompt(prompt) {
        return Err("키 암호 질문이 아니라 답하지 않습니다".to_owned());
    }
    let (port, token) = value
        .split_once(':')
        .ok_or_else(|| "askpass 환경 값의 모양이 맞지 않습니다".to_owned())?;
    let port = port
        .parse::<u16>()
        .map_err(|_| "askpass 포트가 숫자가 아닙니다".to_owned())?;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, HELPER_IO_TIMEOUT)
        .map_err(|error| format!("앱에 접속하지 못했습니다: {error}"))?;
    let _ = stream.set_read_timeout(Some(HELPER_IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(HELPER_IO_TIMEOUT));
    stream
        .write_all(format!("{token}\n").as_bytes())
        .map_err(|error| format!("토큰을 보내지 못했습니다: {error}"))?;
    let mut line = Zeroizing::new(String::new());
    BufReader::new(stream.take(MAX_PASSPHRASE_CHARS as u64 * 4 + 2))
        .read_line(&mut line)
        .map_err(|error| format!("응답을 읽지 못했습니다: {error}"))?;
    if !line.ends_with('\n') {
        return Err("앱이 암호를 돌려주지 않았습니다".to_owned());
    }
    let trimmed = line.trim_end_matches(['\r', '\n']).len();
    line.truncate(trimmed);
    Ok(line)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::sync::Mutex;

    thread_local! {
        /// 시험 바이너리는 askpass로 불려도 값을 내주지 못한다. 진짜 `ssh-keygen`으로 끝까지
        /// 돌리는 시험은 이 자리에 같은 일을 하는 작은 스크립트를 꽂는다.
        pub(crate) static EXECUTABLE_OVERRIDE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    }

    /// 실행 파일의 askpass 모드와 같은 일을 하는 bash 스크립트. 키 암호 질문에만, 토큰을
    /// 내밀어 받은 한 줄로 답한다 — loopback 왕복까지 진짜로 지난다.
    #[cfg(unix)]
    pub(crate) fn install_script_helper(directory: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = directory.join("askpass.sh");
        std::fs::write(
            &script,
            "#!/bin/bash\ncase \"$1\" in \"Enter passphrase\"*|\"Enter same passphrase again\"*) ;; *) exit 1 ;; esac\nvalue=\"$AGENT_MANAGER_SSH_ASKPASS\"\nexec 3<>\"/dev/tcp/127.0.0.1/${value%%:*}\" || exit 1\nprintf '%s\\n' \"${value#*:}\" >&3\nIFS= read -r line <&3 || exit 1\nprintf '%s\\n' \"$line\"\n",
        )
        .expect("askpass script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
            .expect("executable");
        EXECUTABLE_OVERRIDE.with(|cell| *cell.borrow_mut() = Some(script.clone()));
        script
    }

    /// 시험용 보안 저장소. 값은 메모리에만 있다.
    #[derive(Default)]
    pub(crate) struct MemoryVault {
        pub(crate) values: Mutex<BTreeMap<String, String>>,
    }

    impl PassphraseVault for MemoryVault {
        fn read(&self, fingerprint: &str) -> Result<Option<Zeroizing<String>>, CoreError> {
            Ok(self
                .values
                .lock()
                .expect("vault")
                .get(fingerprint)
                .map(|value| Zeroizing::new(value.clone())))
        }

        fn write(&self, fingerprint: &str, passphrase: &str) -> Result<(), CoreError> {
            self.values
                .lock()
                .expect("vault")
                .insert(fingerprint.to_owned(), passphrase.to_owned());
            Ok(())
        }

        fn delete(&self, fingerprint: &str) -> Result<(), CoreError> {
            self.values.lock().expect("vault").remove(fingerprint);
            Ok(())
        }
    }

    fn port_and_token(session: &AskpassSession) -> String {
        session
            .env()
            .into_iter()
            .find(|(key, _)| key == ASKPASS_ENV)
            .map(|(_, value)| value)
            .expect("askpass env")
    }

    /// C9-21. 맞는 토큰과 키 암호 프롬프트에만 값을 돌려주고, 정해진 횟수 뒤에는 닫는다.
    #[test]
    fn c9_21_askpass_answers_only_the_token_holder_and_only_passphrase_prompts() {
        let session = AskpassSession::start_with_executable(
            Zeroizing::new("correct horse".to_owned()),
            KEYGEN_ANSWERS,
            PathBuf::from("/bin/agent-manager"),
        )
        .expect("start");
        let value = port_and_token(&session);
        let env = session.env();
        assert!(env.contains(&("SSH_ASKPASS_REQUIRE".to_owned(), "force".to_owned())));
        assert!(env
            .iter()
            .all(|(_, value)| !value.contains("correct horse")));

        // 서버 비밀번호·호스트 키 질문에는 접속조차 하지 않는다.
        assert!(run_helper(&value, "deploy@host's password: ").is_err());
        assert!(run_helper(&value, "Are you sure you want to continue connecting").is_err());
        // 틀린 토큰은 값을 받지 못한다.
        let (port, _) = value.split_once(':').expect("value");
        assert!(run_helper(&format!("{port}:wrong"), "Enter passphrase: ").is_err());

        let first = run_helper(&value, "Enter passphrase (empty for no passphrase): ")
            .expect("first answer");
        assert_eq!(first.as_str(), "correct horse");
        let second = run_helper(&value, "Enter same passphrase again: ").expect("second answer");
        assert_eq!(second.as_str(), "correct horse");
        // 답할 횟수를 다 쓰면 더 이상 값을 내주지 않는다.
        assert!(run_helper(&value, "Enter passphrase for key '/k': ").is_err());
        drop(session);
    }

    /// C9-21. 접속용 세션은 한 번만 답한다. 같은 환경을 물려받은 자식(git hook 등)이 남은 답을
    /// 가져갈 수 없다. 토큰을 보내지 않고 붙들고 있는 연결도 진짜 helper를 막지 못한다.
    #[test]
    fn c9_21_connect_session_answers_once_and_idle_connections_do_not_block_it() {
        let session = AskpassSession::start_with_executable(
            Zeroizing::new("only once".to_owned()),
            CONNECT_ANSWERS,
            PathBuf::from("/bin/agent-manager"),
        )
        .expect("start");
        let value = port_and_token(&session);
        let (port, _) = value.split_once(':').expect("value");
        let _idle = TcpStream::connect(("127.0.0.1", port.parse::<u16>().expect("port")))
            .expect("idle connection");
        let first = run_helper(&value, "Enter passphrase for key '/k': ").expect("answer");
        assert_eq!(first.as_str(), "only once");
        assert!(run_helper(&value, "Enter passphrase for key '/k': ").is_err());
    }

    /// C9-21. 응답 횟수가 0인 세션은 키 암호 프롬프트에도 값을 내주지 않는다.
    #[test]
    fn c9_21_zero_answer_session_rejects_immediately() {
        let session = AskpassSession::start_with_executable(
            Zeroizing::new("secret".to_owned()),
            0,
            PathBuf::from("/bin/agent-manager"),
        )
        .expect("start");
        let value = port_and_token(&session);
        assert!(run_helper(&value, "Enter passphrase: ").is_err());
    }

    /// C9-21. 표시는 값이 저장된 뒤에만 남고, 지우면 값과 함께 사라진다.
    #[test]
    fn c9_21_marker_follows_the_vault_value() {
        let app_data = tempfile::tempdir().expect("app data");
        let vault = MemoryVault::default();
        assert!(load_passphrase(&vault, app_data.path(), "SHA256:abc")
            .expect("none")
            .is_none());
        assert!(store_passphrase(&vault, app_data.path(), "SHA256:abc", "line\nbreak").is_err());
        assert!(!passphrase_saved(app_data.path(), "SHA256:abc"));

        store_passphrase(&vault, app_data.path(), "SHA256:abc", "s3cret").expect("store");
        assert!(passphrase_saved(app_data.path(), "SHA256:abc"));
        let stored = std::fs::read_to_string(app_data.path().join(STORE.file)).expect("marker");
        assert!(!stored.contains("s3cret"));
        assert_eq!(
            load_passphrase(&vault, app_data.path(), "SHA256:abc")
                .expect("load")
                .expect("value")
                .as_str(),
            "s3cret"
        );

        assert!(forget_passphrase(&vault, app_data.path(), "SHA256:abc").expect("forget"));
        assert!(!passphrase_saved(app_data.path(), "SHA256:abc"));
        assert!(vault.values.lock().expect("vault").is_empty());
    }
}
