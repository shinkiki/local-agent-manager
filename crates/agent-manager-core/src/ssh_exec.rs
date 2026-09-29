//! C9-14~C9-16: 에이전트 사용을 켠 SSH 엔드포인트로 원격 명령을 실행하고 파일을 올린다.
//!
//! # 왜 앱이 대신 실행하는가
//!
//! 스킬 경로(C9-12)는 에이전트가 자기 셸에서 `ssh`를 직접 돌리는 것을 전제한다. 그 전제가
//! 성립하지 않는 실행 주체가 하나 있다 — AIA다. AIA는 시스템 인터페이스로만 움직이고 셸이
//! 없으므로, 사용자가 "에이전트 사용"을 켜 둔 키가 있어도 쓸 방법이 없었다. 이 어댑터는 그
//! 한 자리를 메우고, 대신 스킬 경로에서는 지시문에 그쳤던 명령 목록을 **실제 집행 지점**으로
//! 올린다.
//!
//! # 집행이 성립하는 조건
//!
//! argv를 앱이 조립하기 때문에 성립한다. 그래서 셸 메타문자를 통째로 거절한다 —
//! `ls; rm -rf /`가 `ls` 규칙을 통과하면 목록은 장식이 된다. 파이프·체이닝·리다이렉션이
//! 이 경로에서 빠지는 것은 그 대가다. 목록에 적혀 있어도 셸·인터프리터·네트워크 페치
//! 앞머리는 거절한다. 한 줄로 다른 규칙 전부를 무의미하게 만드는 앞머리이기 때문이다.
//!
//! 서버에서 강제되는 것은 여전히 아니다. `authorized_keys`의 forced command만이 서버측
//! 제한이고, 이 어댑터는 **이 앱의 실행 경로**만 좁힌다(C9-16).
//!
//! # 비밀값
//!
//! 개인키는 여기서도 열지 않는다 — `ssh`와 `scp`에 `-i` 경로만 넘긴다(G4). 원격이 돌려준
//! 문구는 그대로 싣지 않고 PEM 블록과 긴 토큰꼴 문자열을 지운 뒤 길이를 잘라 싣는다.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::ssh_approvals::{
    SshApprovalConsume, SshApprovalGate, SshApprovalOpen, SshApprovalScope, SshApprovalTicket,
};
// 명령 목록 집행은 `ssh_command_policy`가 맡는다. 실행 경로가 쓰던 이름을 그대로 두려고
// 여기서 다시 들여온다.
use crate::ssh_command_policy::{
    command_allowance, enforce_hard_command_refusals, enforce_redirect_policy,
    sudo_prompt_positions, validate_remote_command, CommandAllowance,
};
use crate::ssh_endpoints::{
    connect_args, destination, endpoint_of, scp_args, target, SshEndpointView,
};
use crate::ssh_keys::{private_key_present, validate_fingerprint};
use crate::ssh_output::{
    cap_output, diagnose_outcome, mentions_missing_command, mentions_sudo_auth_failure, redact,
    strip_key_blocks, strip_sudo_prompt, KeyBlockFilter, MAX_OUTPUT_CHARS,
};
use crate::user_home::home_dir;
use crate::CoreError;

/// 원격 출력이 어느 파이프에서 왔는지. 화면은 둘을 한 흐름으로 보여 주되 구분은 남긴다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SshOutputStream {
    Stdout,
    Stderr,
}

/// C9-18. 터미널 표시가 켜진 서버의 출력을 실시간으로 받는 자리. 실행 경로는 이 값만
/// 알고, 어느 대화의 어느 카드로 가는지는 구현이 정한다. 줄은 이미 키 블록이 지워진 뒤에
/// 도착하며, 상한을 넘은 뒤에는 오지 않는다 — 영수증의 `stdout`·`stderr`가 정본이고 이
/// 흐름은 화면용 사본이다.
pub trait SshTerminalSink {
    /// 접속을 시작한다. 대상과 정규화된 명령은 이 뒤에 오는 줄들의 제목이다.
    fn ssh_terminal_started(&self, destination: &str, command: &str);
    /// 줄 하나. 줄바꿈은 빠져 있다.
    fn ssh_terminal_output(&self, stream: SshOutputStream, line: &str);
    /// 실행이 끝났다. `message`는 영수증의 진단 한 문장과 같다.
    fn ssh_terminal_finished(&self, succeeded: bool, timed_out: bool, message: &str);
}

/// 원격 경로의 상한. `transferRoot`와 상대 경로에 같이 적용한다.
const MAX_REMOTE_PATH_CHARS: usize = 200;
/// 한 번에 옮길 수 있는 파일 크기. 배포 산출물·결과 파일 한 개를 옮기는 용도이며 올릴 때와
/// 받을 때 같은 상한을 쓴다.
///
/// 이 값은 "이보다 크면 위험하다"가 아니라 **제한 시간 천장에서 거꾸로 나온 값**이다.
/// [`transfer_timeout`]의 보장 하한으로 1GiB가 약 18분이고 천장이 30분이므로, 상한을 이보다
/// 크게 잡으면 천장에 걸려 아무것도 남기지 않고 실패하는 크기를 받아들이게 된다. 다운로드가
/// 로컬 디스크를 이만큼 채울 수 있다는 것과, 양쪽 SHA-256 검증이 파일 전체를 읽는다는 것도
/// 같은 크기에서 함께 감당되는 선이다.
pub(crate) const MAX_TRANSFER_BYTES: u64 = 1024 * 1024 * 1024;
const CONNECT_TIMEOUT_SECONDS: u32 = 10;
/// 원격 명령의 기본·최대 상한. 요청이 값을 주지 않으면 기본값을 쓴다.
pub(crate) const DEFAULT_COMMAND_TIMEOUT_SECONDS: u64 = 60;
pub(crate) const MAX_COMMAND_TIMEOUT_SECONDS: u64 = 300;
/// 접속·인증에 드는 고정 시간. 크기에 비례하지 않는 몫이다.
const TRANSFER_BASE_TIMEOUT_SECONDS: u64 = 60;
/// 전송이 이보다 느리지는 않다고 보는 **보장 하한**. 실측값이 아니다 — 사내망은 보통 이보다
/// 훨씬 빠르고, 이 값은 "느린 최악의 경우에도 끊지 않는다"는 뜻이다. 실제 속도를 가정으로
/// 넣으면 느린 회선에서 큰 파일이 조용히 실패한다.
const TRANSFER_BYTES_PER_SECOND: u64 = 1024 * 1024;
/// 어떤 크기에서도 이보다 오래 매달리지 않는다. 천장이 없으면 상한도 정할 수 없다.
const MAX_TRANSFER_TIMEOUT_SECONDS: u64 = 1800;
/// 지문을 읽는 쪽은 디스크를 훑는 일이라 네트워크보다 훨씬 빠르다. 전송과 같은 공식을 쓰면
/// 과하게 넉넉해져, 멈춘 `sha256sum` 하나가 30분을 잡아먹는다.
const DIGEST_BYTES_PER_SECOND: u64 = 8 * 1024 * 1024;
const MAX_DIGEST_TIMEOUT_SECONDS: u64 = 600;

/// 크기에 맞춘 전송 제한 시간. 고정값을 쓰면 상한을 올리는 순간 큰 파일이 전부 시간 초과로
/// 죽는다 — 실패하는 크기를 상한이 허락하는 상태가 된다.
///
/// 크기를 모를 때는 천장을 쓴다. 모른다고 짧게 끊으면 큰 파일이 "왜인지 모르게" 실패한다.
fn transfer_timeout(bytes: Option<u64>) -> Duration {
    scaled_timeout(
        bytes,
        TRANSFER_BYTES_PER_SECOND,
        MAX_TRANSFER_TIMEOUT_SECONDS,
    )
}

/// 크기에 맞춘 지문 확인 제한 시간. 원격이 파일 전체를 읽으므로 크기에 비례한다.
fn digest_timeout(bytes: Option<u64>) -> Duration {
    scaled_timeout(bytes, DIGEST_BYTES_PER_SECOND, MAX_DIGEST_TIMEOUT_SECONDS)
}

fn scaled_timeout(bytes: Option<u64>, per_second: u64, ceiling: u64) -> Duration {
    let seconds = match bytes {
        Some(bytes) => TRANSFER_BASE_TIMEOUT_SECONDS.saturating_add(bytes / per_second),
        None => ceiling,
    };
    Duration::from_secs(seconds.min(ceiling))
}

/// 원격 경로에 쓸 수 있는 글자. 명령과 달리 공백을 허용하지 않는다 — `scp`는 원격 경로를
/// 원격 셸에 넘기므로, 공백이 있으면 인용 없이는 두 인자로 갈라진다.
fn is_allowed_path_char(character: char) -> bool {
    character.is_ascii_alphanumeric()
        || matches!(character, '-' | '_' | '.' | '/' | '+' | '%' | '~')
}

/// 업로드 원본으로 받지 않는 이름·경로 조각. 앱 데이터·공급자 홈·`~/.ssh`는 별도 경계로
/// 막고(C9-16), 여기는 그 밖에서 흔히 자격증명을 담는 자리를 잡는다. 일반적인 비밀값
/// 탐지기가 아니므로 사용자에게 이 목록이 전부라고 말하지 않는다.
const REFUSED_LOCAL_SEGMENTS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".kube",
    ".docker",
    ".netrc",
    ".pgpass",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "keychains",
    "gcloud",
    "credential-profiles",
];

/// 사용자가 고른 엔드포인트를 실행 직전에 다시 확인한 결과. 지문·개인키·에이전트 사용
/// 여부를 화면이 아니라 저장본과 파일시스템에서 다시 읽으므로, 목록을 그린 뒤 토글이
/// 꺼졌으면 여기서 멈춘다.
#[derive(Debug)]
struct ResolvedEndpoint {
    fingerprint: String,
    identity: String,
    endpoint: SshEndpointView,
    destination: String,
    target: String,
}

/// 원격 명령 실행 요청. 명령은 한 줄이며 셸 메타문자를 담을 수 없다.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSshCommandRequest {
    pub fingerprint: String,
    pub command: String,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
    /// C9-17. 허용 목록 밖 명령을 사용자가 이 대화에서 1회 허용해 준 토큰. 처음 호출에는
    /// 없고, `approvalRequired` 응답을 받은 뒤 같은 명령으로 다시 부를 때만 채운다.
    #[serde(default)]
    pub approval_id: Option<String>,
    /// C9-20. 영수증에 실을 줄 수의 상한. 원격은 그대로 다 말하고 **앱이 앞에서 자른다** —
    /// `| head -n N`과 달리 명령이 무엇이든 지켜지고, 글자 수 상한과 달리 줄 가운데서
    /// 끊기지 않는다. 없으면 글자 수 상한만 적용된다.
    #[serde(default)]
    pub max_lines: Option<usize>,
}

/// 원격 명령 결과. 개인키 내용은 어느 필드에도 없고, 원격 문구는 걸러 실린다.
///
/// C9-17. `approvalRequired`가 true면 **아무것도 실행되지 않았다**. 그때만 `approvalId`·
/// `expiresAt`이 채워지며, 그 두 값과 `destination`·`command`가 사용자에게 보여 줘야 하는
/// 전부다. 실행된 응답에서는 `approvalRequired`가 false이고 `approvalId`는 실제로 쓴 토큰
/// (없으면 `null`)이다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshCommandReceipt {
    pub fingerprint: String,
    pub destination: String,
    /// 규칙과 맞춰 본 정규화된 명령. 요청 원문이 아니라 실제로 넘긴 값이다.
    pub command: String,
    pub succeeded: bool,
    pub timed_out: bool,
    /// 호스트 키가 `known_hosts`에 없어 거절된 경우. 앱은 대신 수락하지 않는다.
    pub host_key_rejected: bool,
    /// 서버가 이 키를 받지 않은 경우.
    pub permission_denied: bool,
    /// 사용자 승인을 기다리는 상태. true면 실행하지 않았다.
    pub approval_required: bool,
    /// 승인 카드의 id. 승인 뒤 같은 명령으로 다시 호출할 때 그대로 넘긴다.
    pub approval_id: Option<String>,
    /// 승인이 유효한 마지막 시각(Unix epoch 밀리초). 이 뒤에는 다시 승인을 받아야 한다.
    pub expires_at: Option<i64>,
    /// 왜 승인이 필요한지(또는 왜 승인 없이 진행할 수 없는지). 사용자에게 그대로 전한다.
    pub reason: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub message: String,
}

/// C9-17. 승인받은 명령을 그 서버의 허용 명령 목록에 영구히 적는 요청. 실행과 **분리된
/// 별도 작업**이라 이 경로는 어떤 경우에도 원격에 접속하지 않는다.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AllowSshCommandRequest {
    pub fingerprint: String,
    pub command: String,
    /// 목록 추가 용도로 발급된 승인 토큰. 없으면 승인 요청만 열고 목록은 바꾸지 않는다.
    #[serde(default)]
    pub approval_id: Option<String>,
}

/// 허용 목록 추가 결과. 실행 영수증과 같은 승인 계약을 쓴다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshCommandAllowlistReceipt {
    pub fingerprint: String,
    pub destination: String,
    pub command: String,
    /// 목록에 실제로 줄이 추가됐는지. 이미 있던 줄이면 false다.
    pub added: bool,
    /// 추가된 뒤 그 서버의 허용 명령 목록 전체.
    pub allowed_commands: Vec<String>,
    pub approval_required: bool,
    pub approval_id: Option<String>,
    pub expires_at: Option<i64>,
    pub reason: Option<String>,
    pub message: String,
}

/// 파일 업로드 요청. `remotePath`는 엔드포인트의 `transferRoot` 아래 상대 경로다.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadSshFileRequest {
    pub fingerprint: String,
    pub local_path: String,
    #[serde(default)]
    pub remote_path: String,
    #[serde(default)]
    pub overwrite: bool,
}

/// 업로드 결과. 대상 경로·크기·양쪽 SHA-256과 그 비교 결과를 함께 돌려준다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshUploadReceipt {
    pub fingerprint: String,
    pub destination: String,
    pub remote_path: String,
    pub bytes: u64,
    /// 올리기 전 로컬 파일의 SHA-256.
    pub sha256: String,
    /// 올린 뒤 원격에서 읽은 SHA-256. 원격에 지문 도구가 없으면 없다.
    pub remote_sha256: Option<String>,
    /// 두 지문이 같은지. 원격 지문을 읽지 못했으면 false이며 이유는 message에 담긴다.
    pub verified: bool,
    /// 전송에 쓴 방식. OpenSSH 9 이상의 `scp`는 SFTP 프로토콜로 전송한다.
    pub method: String,
    pub succeeded: bool,
    pub timed_out: bool,
    pub host_key_rejected: bool,
    pub permission_denied: bool,
    pub replaced: bool,
    pub message: String,
}

/// 파일 다운로드 요청. `remotePath`는 엔드포인트의 `transferRoot` 아래 상대 경로이고,
/// `localPath`는 이미 있는 폴더 아래의 절대 경로(또는 `~/` 아래 경로)다.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSshFileRequest {
    pub fingerprint: String,
    pub remote_path: String,
    pub local_path: String,
    #[serde(default)]
    pub overwrite: bool,
}

/// 다운로드 결과. 받은 자리·크기·양쪽 SHA-256과 그 비교 결과를 함께 돌려준다.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshDownloadReceipt {
    pub fingerprint: String,
    pub destination: String,
    pub remote_path: String,
    /// 실제로 쓴 로컬 경로. 정규화된 상위 폴더 아래의 경로라 요청 원문과 다를 수 있다.
    pub local_path: String,
    pub bytes: u64,
    /// 받은 뒤 로컬 파일에서 읽은 SHA-256.
    pub sha256: Option<String>,
    /// 받기 전 원격에서 읽은 SHA-256. 원격에 지문 도구가 없으면 없다.
    pub remote_sha256: Option<String>,
    /// 두 지문이 같은지. 한쪽이라도 읽지 못했으면 false이며 이유는 message에 담긴다.
    pub verified: bool,
    pub method: String,
    pub succeeded: bool,
    pub timed_out: bool,
    pub host_key_rejected: bool,
    pub permission_denied: bool,
    pub replaced: bool,
    pub message: String,
}

/// C9-14. 에이전트 사용을 켠 엔드포인트에서 허용 목록에 걸리는 명령 하나를 실행한다.
///
/// C9-17. `gate`가 있으면 허용 목록 밖 명령을 즉시 거절하는 대신 승인 요청을 열고
/// `approvalRequired` 영수증을 돌려준다. 대화가 없는 호출자(워크플로 단계 등)는 `gate`가
/// 없어 예전과 같이 즉시 거절된다 — 승인을 받을 사람이 그 자리에 없으므로 물을 곳도 없다.
pub fn execute_ssh_command(
    app_data_dir: &Path,
    request: ExecuteSshCommandRequest,
    gate: Option<&dyn SshApprovalGate>,
    terminal: Option<&dyn SshTerminalSink>,
) -> Result<SshCommandReceipt, CoreError> {
    let executable = crate::providers::resolve_named_executable(&["ssh"])?;
    execute_ssh_command_with(
        &home_dir()?,
        app_data_dir,
        &executable,
        &request,
        gate,
        terminal,
    )
}

/// C9-17. 승인받은 명령 한 줄을 그 서버의 허용 명령 목록에 영구히 적는다. 실행하지 않는다.
pub fn allow_ssh_command_permanently(
    app_data_dir: &Path,
    request: AllowSshCommandRequest,
    gate: Option<&dyn SshApprovalGate>,
) -> Result<SshCommandAllowlistReceipt, CoreError> {
    allow_ssh_command_permanently_with(&home_dir()?, app_data_dir, &request, gate)
}

/// C9-15. 전송 권한을 켠 엔드포인트의 `transferRoot` 아래로 파일 하나를 올린다.
pub fn upload_ssh_file(
    app_data_dir: &Path,
    request: UploadSshFileRequest,
) -> Result<SshUploadReceipt, CoreError> {
    let (ssh, scp) = transfer_executables()?;
    upload_ssh_file_with(&home_dir()?, app_data_dir, &ssh, &scp, &request)
}

/// C9-15. 전송 권한을 켠 엔드포인트의 `transferRoot` 아래에서 파일 하나를 받아 온다.
pub fn download_ssh_file(
    app_data_dir: &Path,
    request: DownloadSshFileRequest,
) -> Result<SshDownloadReceipt, CoreError> {
    let (ssh, scp) = transfer_executables()?;
    download_ssh_file_with(&home_dir()?, app_data_dir, &ssh, &scp, &request)
}

fn execute_ssh_command_with(
    home: &Path,
    app_data_dir: &Path,
    executable: &Path,
    request: &ExecuteSshCommandRequest,
    gate: Option<&dyn SshApprovalGate>,
    terminal: Option<&dyn SshTerminalSink>,
) -> Result<SshCommandReceipt, CoreError> {
    // 순서가 계약이다. 엔드포인트 확인(에이전트 사용 토글·개인키)과 명령 정규화(제어문자·
    // 셸 메타문자·길이), 그리고 하드 거부(셸·인터프리터·네트워크 페치 앞머리와 그 서버의
    // 차단 목록)를 **먼저** 지나야 승인 자리에 닿는다. 승인이 대신할 수 있는 것은 허용
    // 목록 대조 한 자리뿐이고, 그 앞의 어느 검사도 토큰으로 넘기지 못한다.
    let resolved = resolve_endpoint(home, app_data_dir, &request.fingerprint)?;
    let line = validate_remote_command(&request.command)?;
    enforce_hard_command_refusals(&resolved.endpoint, &line)?;
    enforce_redirect_policy(&resolved.endpoint, &line)?;
    // 이 뒤로는 앱이 다시 적은 정본만 다닌다. 원문을 그대로 보내면 이 파서와 원격 셸의
    // 해석 차이가 그대로 우회 경로가 되므로, 승인 카드·영수증·실행이 모두 같은 줄을 본다.
    let command = line.render();

    // C9-19. 원격 sudo가 비밀번호를 물을 명령인데 이 대화가 아직 그 값을 받지 않았다면,
    // 허용 목록에 있는 명령이어도 카드를 연다 — 사용자가 값을 입력할 자리가 그 카드뿐이고,
    // 값 없이 보내면 원격이 프롬프트에서 멈춰 제한 시간까지 아무 일도 일어나지 않는다.
    let sudo_positions = sudo_prompt_positions(&line);
    let wants_secret = !sudo_positions.is_empty();
    let secret_pending = wants_secret
        && !gate
            .map(|gate| gate.holds_sudo_secret(&resolved.fingerprint))
            .unwrap_or(false);

    let approval_id = match command_allowance(&resolved.endpoint, &line) {
        CommandAllowance::Allowed if !secret_pending => {
            // 이미 허용된 명령에는 승인이 필요 없다. 토큰을 함께 보냈어도 소모하지
            // 않는다 — 쓰지 않은 승인은 사용자에게 남아 있는 것이 맞다.
            None
        }
        allowance => {
            let reason = match allowance {
                CommandAllowance::NeedsApproval { reason } => reason,
                // 허용 목록은 지났고 비밀번호만 받으면 되는 자리다. 사용자가 카드에서
                // 읽을 이유가 "목록 밖이라서"가 아니므로 그대로 적는다.
                CommandAllowance::Allowed => "이 명령은 원격에서 sudo 비밀번호를 요구하며, 이 대화는 아직 그 값을 받지 않았습니다.".to_owned(),
            };
            let Some(gate) = gate else {
                return Err(CoreError::Conflict(format!("{reason} 이 호출 경로에는 승인을 받을 대화가 없어 실행하지 않았습니다. AIA 대화에서 요청하거나, 사용자에게 애드온 → SSH → 연결 서버 → 고급 설정에서 목록을 고쳐 달라고 요청하세요")));
            };
            match take_ssh_approval(
                gate,
                &resolved,
                &command,
                SshApprovalScope::OneShot,
                &reason,
                request.approval_id.as_deref(),
                secret_pending,
            )? {
                SshApprovalStep::Consumed(approval_id) => Some(approval_id),
                SshApprovalStep::Pending(ticket) => {
                    return Ok(approval_pending_receipt(&resolved, command, ticket));
                }
            }
        }
    };
    let timeout = command_timeout(request.timeout_seconds)?;

    // C9-19. 값을 꺼내는 것은 승인 자리를 모두 지난 뒤다. 원격에 나가는 줄에만 `-S`가
    // 붙고, 영수증·승인 카드에 남는 것은 사용자가 읽은 원본(`command`)이다.
    let secret = if wants_secret {
        gate.and_then(|gate| gate.take_sudo_secret(&resolved.fingerprint))
    } else {
        None
    };
    let remote_command = match secret {
        Some(_) => line.with_stdin_password_flag(&sudo_positions).render(),
        None => command.clone(),
    };

    // C9-18. 터미널 표시는 서버 설정과 받을 대화가 둘 다 있을 때만 흐른다. 둘 중 하나가
    // 없으면 종료까지 모아 한 번에 돌려주는 기존 경로 그대로다 — 영수증은 어느 쪽이든 같다.
    let outcome = match terminal.filter(|_| resolved.endpoint.terminal_enabled) {
        Some(terminal) => run_ssh_streaming(
            executable,
            &resolved,
            &remote_command,
            timeout,
            terminal,
            secret.as_ref().map(|value| value.as_str()),
        )?,
        None => run_ssh_with_input(
            executable,
            &resolved,
            &[remote_command.as_str()],
            timeout,
            secret.as_ref().map(|value| value.as_str()),
        )?,
    };
    // C9-19. 원격이 값을 거절했으면 들고 있던 것을 버린다. 틀린 값으로 남은 시간 내내 같은
    // 실패를 반복하는 대신 다음 명령에서 다시 묻는다.
    if wants_secret && mentions_sudo_auth_failure(&outcome.stderr) {
        if let Some(gate) = gate {
            gate.discard_sudo_secret(&resolved.fingerprint);
        }
    }
    // C9-19. sudo 프롬프트는 우리가 붙인 `-S` 때문에 생긴 것이라 사용자가 요청한 출력이
    // 아니다. 아래 진단 판정도 모두 이 정리된 값을 본다 — 프롬프트 한 줄이 섞인 채로
    // 판정하면 성공한 실행이 실패로 읽힌다.
    let outcome = crate::cli_interface::CommandOutcome {
        stderr: strip_sudo_prompt(&outcome.stderr),
        ..outcome
    };
    // 본문은 사용자가 요청한 출력이므로 모양을 지키되 키 블록은 어떤 경우에도 빼낸다.
    // 진단 한 문장(message)은 그보다 강하게 걸러 긴 토큰꼴 값까지 지운다.
    let stdout = cap_receipt_text(&outcome.stdout, request.max_lines);
    let stderr = cap_receipt_text(&outcome.stderr, request.max_lines);
    let diagnosis = diagnose_outcome(&outcome);
    Ok(SshCommandReceipt {
        fingerprint: resolved.fingerprint,
        destination: resolved.destination,
        command,
        succeeded: outcome.success,
        timed_out: outcome.timed_out,
        host_key_rejected: diagnosis.host_key_rejected,
        permission_denied: diagnosis.permission_denied,
        approval_required: false,
        approval_id,
        expires_at: None,
        reason: None,
        truncated: stdout.1 || stderr.1,
        stdout: stdout.0,
        stderr: stderr.0,
        message: diagnosis.message,
    })
}

/// 아무것도 실행하지 않은 영수증. 실행된 응답과 같은 형태를 쓰되, 성공·실패 칸은 모두
/// 비어 있고 `approvalRequired`가 그 이유를 밝힌다.
fn approval_pending_receipt(
    resolved: &ResolvedEndpoint,
    command: String,
    ticket: SshApprovalTicket,
) -> SshCommandReceipt {
    SshCommandReceipt {
        fingerprint: resolved.fingerprint.clone(),
        destination: resolved.destination.clone(),
        command,
        succeeded: false,
        timed_out: false,
        host_key_rejected: false,
        permission_denied: false,
        approval_required: true,
        approval_id: Some(ticket.id),
        expires_at: Some(ticket.expires_at),
        reason: Some(ticket.reason),
        stdout: String::new(),
        stderr: String::new(),
        truncated: false,
        message: "사용자 승인을 기다립니다. 아무것도 실행하지 않았습니다 — 사용자가 화면의 승인 카드에서 허용하면 같은 approvalId와 **같은 명령 문자열**로 다시 호출하세요".to_owned(),
    }
}

/// 승인 자리를 한 번 지난 결과.
enum SshApprovalStep {
    /// 사용자가 이미 답한 토큰을 이 호출이 소모했다. 값은 그 승인 id다.
    Consumed(String),
    /// 아직 답이 없어 카드를 새로 열었다. 호출부는 아무것도 실행하지 말고 이 카드를
    /// 담은 영수증을 돌려줘야 한다.
    Pending(SshApprovalTicket),
}

/// 승인 토큰을 소모하거나, 없으면 새 카드를 연다. 실행 경로와 허용 목록 추가 경로가
/// 같은 순서를 각자 적어 두면 한쪽만 고쳐지기 쉬운 자리라 한 벌로 모은다 — 두 경로의
/// 차이는 `scope`와 카드에 실리는 `reason`뿐이고, 대조 값(지문·명령)은 같아야 한다.
fn take_ssh_approval(
    gate: &dyn SshApprovalGate,
    resolved: &ResolvedEndpoint,
    command: &str,
    scope: SshApprovalScope,
    reason: &str,
    approval_id: Option<&str>,
    needs_secret: bool,
) -> Result<SshApprovalStep, CoreError> {
    let Some(approval_id) = approval_id else {
        let ticket = gate.open_ssh_approval(SshApprovalOpen {
            fingerprint: &resolved.fingerprint,
            destination: &resolved.destination,
            command,
            scope,
            reason,
            needs_secret,
        })?;
        return Ok(SshApprovalStep::Pending(ticket));
    };
    gate.consume_ssh_approval(SshApprovalConsume {
        approval_id,
        fingerprint: &resolved.fingerprint,
        command,
        scope,
    })?;
    Ok(SshApprovalStep::Consumed(approval_id.to_owned()))
}

fn allow_ssh_command_permanently_with(
    home: &Path,
    app_data_dir: &Path,
    request: &AllowSshCommandRequest,
    gate: Option<&dyn SshApprovalGate>,
) -> Result<SshCommandAllowlistReceipt, CoreError> {
    // 목록에 적히는 순간 이 명령은 승인 없이 실행된다. 그래서 적기 전에도 실행 경로와
    // 같은 정규화·하드 거부를 지난다 — 셸 앞머리나 차단 목록에 걸리는 줄을 목록에 남겨
    // 두면, 사용자는 허용했다고 읽지만 실행은 늘 거절되는 규칙이 쌓인다.
    let resolved = resolve_endpoint(home, app_data_dir, &request.fingerprint)?;
    let line = validate_remote_command(&request.command)?;
    enforce_hard_command_refusals(&resolved.endpoint, &line)?;
    let command = line.render();
    // C9-20. 규칙은 단계 단위로 대조되므로 파이프라인은 단계마다 한 줄씩 적는다. 줄 전체를
    // 한 규칙으로 적으면 어느 단계와도 맞지 않아, 사용자는 허용했다고 읽지만 다음 실행도
    // 똑같이 승인을 묻는 규칙이 쌓인다.
    let mut rules: Vec<String> = Vec::new();
    for stage in line.stages() {
        let rule = stage.render_command();
        if !rules.contains(&rule) {
            rules.push(rule);
        }
    }

    let Some(gate) = gate else {
        return Err(CoreError::Conflict(
            "허용 명령 목록 추가는 사용자가 승인해야 하므로 대화가 없는 호출 경로에서는 할 수 없습니다".to_owned(),
        ));
    };
    let approval_id = match take_ssh_approval(
        gate,
        &resolved,
        &command,
        SshApprovalScope::Persist,
        "이 명령을 이 서버의 허용 명령 목록에 영구히 추가하려 합니다. 추가되면 다음부터는 승인 없이 실행됩니다",
        request.approval_id.as_deref(),
        // 목록에 적기만 하는 자리라 실행이 없고, 따라서 비밀번호를 받을 이유도 없다.
        false,
    )? {
        SshApprovalStep::Consumed(approval_id) => approval_id,
        SshApprovalStep::Pending(ticket) => {
            return Ok(SshCommandAllowlistReceipt {
            fingerprint: resolved.fingerprint,
            destination: resolved.destination,
            command,
            added: false,
            allowed_commands: resolved.endpoint.allowed_commands.clone(),
            approval_required: true,
            approval_id: Some(ticket.id),
            expires_at: Some(ticket.expires_at),
            reason: Some(ticket.reason),
                message: "사용자 승인을 기다립니다. 허용 목록은 아직 바뀌지 않았습니다".to_owned(),
            });
        }
    };
    let mut added = false;
    for rule in &rules {
        added |= crate::ssh_endpoints::append_allowed_command(
            app_data_dir,
            &resolved.fingerprint,
            rule,
        )?;
    }
    // 목록은 방금 바뀌었으므로 저장본에서 다시 읽어 돌려준다.
    let updated = resolve_endpoint(home, app_data_dir, &resolved.fingerprint)?;
    Ok(SshCommandAllowlistReceipt {
        fingerprint: updated.fingerprint,
        destination: updated.destination,
        command,
        added,
        allowed_commands: updated.endpoint.allowed_commands.clone(),
        approval_required: false,
        approval_id: Some(approval_id),
        expires_at: None,
        reason: None,
        message: match (added, rules.len()) {
            (true, 1) => "허용 명령 목록에 추가했습니다".to_owned(),
            (true, count) => {
                format!("파이프라인의 {count}단계를 각각 허용 명령 목록에 적었습니다")
            }
            (false, _) => "이미 허용 목록에 있는 명령이라 목록을 바꾸지 않았습니다".to_owned(),
        },
    })
}

fn upload_ssh_file_with(
    home: &Path,
    app_data_dir: &Path,
    ssh: &Path,
    scp: &Path,
    request: &UploadSshFileRequest,
) -> Result<SshUploadReceipt, CoreError> {
    let (resolved, root) = open_transfer(home, app_data_dir, &request.fingerprint)?;
    let source = resolve_local_source(app_data_dir, home, &request.local_path)?;
    let remote_path = join_remote_path(&root, &request.remote_path, &source.file_name)?;

    // 이미 있는 파일을 말없이 덮지 않는다. 지문 명령은 파일이 없으면 실패하므로, 이 한
    // 번의 고정 명령이 존재 확인과 사후 검증을 함께 맡는다.
    let existing = remote_digest(ssh, &resolved, &remote_path, None)?;
    if existing.digest.is_some() && !request.overwrite {
        return Err(overwrite_conflict(&remote_path));
    }
    let replaced = existing.digest.is_some();

    let outcome = run_scp(
        scp,
        &resolved,
        &source.path.to_string_lossy(),
        &format!("{}:{remote_path}", resolved.target),
        transfer_timeout(Some(source.bytes)),
    )?;

    let mut diagnosis = diagnose_outcome(&outcome);
    let mut remote_sha256 = None;
    if outcome.success {
        let verification = remote_digest(ssh, &resolved, &remote_path, Some(source.bytes))?;
        match verification.digest {
            Some(digest) => remote_sha256 = Some(digest),
            None => {
                diagnosis.message = format!("{} — {}", diagnosis.message, verification.reason);
            }
        }
    }
    let verified = verify_transfer_digest(
        outcome.success,
        Some(source.sha256.as_str()),
        remote_sha256.as_deref(),
        "올린 파일의 SHA-256이 원본과 다릅니다",
        &mut diagnosis.message,
    );

    Ok(SshUploadReceipt {
        fingerprint: resolved.fingerprint,
        destination: resolved.destination,
        remote_path,
        bytes: source.bytes,
        sha256: source.sha256,
        remote_sha256,
        verified,
        method: "scp".to_owned(),
        succeeded: outcome.success,
        timed_out: outcome.timed_out,
        host_key_rejected: diagnosis.host_key_rejected,
        permission_denied: diagnosis.permission_denied,
        replaced,
        message: diagnosis.message,
    })
}

fn download_ssh_file_with(
    home: &Path,
    app_data_dir: &Path,
    ssh: &Path,
    scp: &Path,
    request: &DownloadSshFileRequest,
) -> Result<SshDownloadReceipt, CoreError> {
    let (resolved, root) = open_transfer(home, app_data_dir, &request.fingerprint)?;
    // 받을 원격 파일은 전송 폴더 아래로만 정해진다. 이름을 생략할 수 없는 쪽은 여기다 —
    // 로컬처럼 "상대편 파일 이름"으로 채울 값이 없다.
    if request.remote_path.trim().is_empty() {
        return Err(CoreError::InvalidInput(
            "받을 원격 파일 경로가 비어 있습니다".to_owned(),
        ));
    }
    let remote_path = join_remote_path(&root, &request.remote_path, "")?;

    // 크기를 **먼저** 읽는다. 상한을 넘는 파일은 디스크에 한 바이트도 쓰지 않고 거절하고,
    // 원격이 그 파일을 해시하느라 애쓰기도 전에 끝낸다. 크기를 알면 이어지는 지문 확인과
    // 전송의 제한 시간도 그 크기에 맞출 수 있다.
    let size = remote_size(ssh, &resolved, &remote_path)?;
    if size.is_some_and(|bytes| bytes > MAX_TRANSFER_BYTES) {
        return Err(CoreError::TooLarge(MAX_TRANSFER_BYTES));
    }
    let remote = remote_digest(ssh, &resolved, &remote_path, size)?;
    let remote_sha256 = remote.digest.clone();
    if size.is_none() && remote_sha256.is_none() {
        return Err(CoreError::NotFound(format!(
            "{remote_path}을(를) 원격에서 읽지 못했습니다: {}",
            remote.reason
        )));
    }

    let destination = resolve_local_destination(app_data_dir, home, &request.local_path)?;
    if destination.replaced && !request.overwrite {
        return Err(overwrite_conflict(&destination.path.to_string_lossy()));
    }
    let replaced = destination.replaced;

    let outcome = run_scp(
        scp,
        &resolved,
        &format!("{}:{remote_path}", resolved.target),
        &destination.path.to_string_lossy(),
        transfer_timeout(size),
    )?;

    let mut diagnosis = diagnose_outcome(&outcome);
    let mut bytes = 0;
    let mut sha256 = None;
    if outcome.success {
        // 끊긴 전송이 남긴 반쪽 파일을 성공한 결과처럼 두지 않는다. 상한을 넘겼으면
        // 우리가 만든 파일이므로 지우고 거절한다.
        let written = std::fs::symlink_metadata(&destination.path)?;
        if !written.is_file() {
            return Err(CoreError::Runtime(
                "받은 자리에 일반 파일이 만들어지지 않았습니다".to_owned(),
            ));
        }
        if written.len() > MAX_TRANSFER_BYTES {
            remove_partial_download(&destination);
            return Err(CoreError::TooLarge(MAX_TRANSFER_BYTES));
        }
        bytes = written.len();
        sha256 = Some(digest_file(&destination.path)?);
    } else {
        remove_partial_download(&destination);
    }
    if outcome.success && remote_sha256.is_none() {
        diagnosis.message = format!("{} — {}", diagnosis.message, remote.reason);
    }

    let verified = verify_transfer_digest(
        outcome.success,
        sha256.as_deref(),
        remote_sha256.as_deref(),
        "받은 파일의 SHA-256이 원격과 다릅니다",
        &mut diagnosis.message,
    );

    Ok(SshDownloadReceipt {
        fingerprint: resolved.fingerprint,
        destination: resolved.destination,
        remote_path,
        local_path: destination.path.to_string_lossy().into_owned(),
        bytes,
        sha256,
        remote_sha256,
        verified,
        method: "scp".to_owned(),
        succeeded: outcome.success,
        timed_out: outcome.timed_out,
        host_key_rejected: diagnosis.host_key_rejected,
        permission_denied: diagnosis.permission_denied,
        replaced,
        message: diagnosis.message,
    })
}

/// 실패한 전송이 남긴 파일을 치운다. 우리가 만든 자리일 때만 지운다 — 사용자가 덮어쓰기를
/// 승인해 이미 있던 파일을 받던 중이라면, 반쪽짜리라도 지우는 것이 더 큰 손실이다.
fn remove_partial_download(destination: &LocalDestination) {
    if destination.replaced {
        return;
    }
    let _ = std::fs::remove_file(&destination.path);
}

/// 실행 직전에 저장본과 파일시스템을 다시 읽는다. 화면이 보낸 값은 지문뿐이다.
fn resolve_endpoint(
    home: &Path,
    app_data_dir: &Path,
    fingerprint: &str,
) -> Result<ResolvedEndpoint, CoreError> {
    let fingerprint = validate_fingerprint(fingerprint)?.to_owned();
    let snapshot = crate::ssh_keys::snapshot_with_metadata(home, app_data_dir)?;
    let key = snapshot
        .keys
        .iter()
        .find(|key| key.fingerprint == fingerprint)
        .ok_or_else(|| {
            CoreError::NotFound("이 지문의 공개키를 ~/.ssh에서 찾지 못했습니다".to_owned())
        })?;
    let endpoint = endpoint_of(key)
        .ok_or_else(|| CoreError::NotFound("이 키에 저장된 연결 서버가 없습니다".to_owned()))?;
    // 에이전트 사용 토글이 곧 접근 허용 결정이다. 꺼져 있으면 조용히 건너뛰지 않고
    // 왜 거절했는지 말한다 — 사용자가 켤 자리를 찾을 수 있어야 한다.
    if !endpoint.agent_enabled {
        return Err(CoreError::Conflict(
            "이 연결 서버는 에이전트 사용이 꺼져 있습니다. 애드온 → SSH → 연결 서버에서 에이전트 사용을 켜야 합니다".to_owned(),
        ));
    }
    let identity = Path::new(&key.path).with_extension("");
    if !private_key_present(&identity)? {
        return Err(CoreError::Conflict(
            "같은 이름의 개인키가 없어 이 키로는 접속할 수 없습니다".to_owned(),
        ));
    }
    Ok(ResolvedEndpoint {
        fingerprint,
        identity: identity.to_string_lossy().into_owned(),
        destination: destination(&endpoint),
        target: target(&endpoint),
        endpoint,
    })
}

/// C9-15. 전송 권한까지 확인한 엔드포인트. 명령 허용 목록과 **별개의 권한**이라 여기서만
/// 본다 — 명령을 하나도 허용하지 않은 서버에 산출물만 주고받게 하는 것도, 그 반대도
/// 사용자의 정당한 선택이다.
/// 올리기와 받기가 똑같이 여는 자리다. 저장된 전송 폴더 검사까지 여기서 끝내 두 갈래가
/// 각자 같은 두 줄을 펼쳐 두지 않게 한다 — 한쪽에만 검사가 빠지면 경계가 갈라진다.
fn open_transfer(
    home: &Path,
    app_data_dir: &Path,
    fingerprint: &str,
) -> Result<(ResolvedEndpoint, String), CoreError> {
    let resolved = resolve_endpoint(home, app_data_dir, fingerprint)?;
    if !resolved.endpoint.file_transfer_enabled {
        return Err(CoreError::Conflict(
            "이 연결 서버는 파일 전송이 꺼져 있습니다. 애드온 → SSH → 연결 서버에서 파일 전송을 켜고 전송 폴더를 적어야 합니다".to_owned(),
        ));
    }
    let root = validate_transfer_root(&resolved.endpoint.transfer_root)?;
    Ok((resolved, root))
}

/// 전송 두 갈래가 함께 쓰는 실행 파일 한 쌍. 지문·크기 조회는 `ssh`로, 전송 자체는
/// `scp`로 한다.
fn transfer_executables() -> Result<(PathBuf, PathBuf), CoreError> {
    Ok((
        crate::providers::resolve_named_executable(&["ssh"])?,
        crate::providers::resolve_named_executable(&["scp"])?,
    ))
}

/// 전송이 끝난 뒤 양쪽 SHA-256을 맞춰 본다. 한쪽이라도 없으면 확인되지 않은 것으로 두고,
/// 둘 다 있는데 다르면 진단 문장 끝에 그 사실을 덧붙인다. 올릴 때와 받을 때 달라지는 것은
/// 어긋남을 부르는 주어 한 문장뿐이라 판정은 한곳에 둔다.
fn verify_transfer_digest(
    succeeded: bool,
    local: Option<&str>,
    remote: Option<&str>,
    mismatch: &str,
    message: &mut String,
) -> bool {
    let verified = matches!((local, remote), (Some(local), Some(remote)) if local == remote);
    if succeeded && !verified && remote.is_some() {
        *message = format!("{message} — {mismatch}");
    }
    verified
}

/// 접속을 무인으로 묶는 공통 옵션. 제한 시간 없이 매달리거나 비밀번호 프롬프트에서
/// 멈추면 `run_capped`의 제한 시간까지 아무 일도 하지 않고 흘려보내게 되므로, `ssh`와
/// `scp` 양쪽이 같은 값을 쓴다.
fn noninteractive_args() -> [String; 4] {
    [
        "-o".to_owned(),
        format!("ConnectTimeout={CONNECT_TIMEOUT_SECONDS}"),
        "-o".to_owned(),
        "NumberOfPasswordPrompts=0".to_owned(),
    ]
}

/// scp 한 번을 돌린다. 올릴 때와 받을 때 다른 것은 `from`·`to`의 방향뿐이고, 신원·포트·
/// 무인 옵션·조용한 출력·`--` 종결은 같다. 양쪽이 이 조립을 각자 복사해 두면 한쪽에만
/// 옵션이 붙어 갈라지므로 한곳에 둔다.
fn run_scp(
    scp: &Path,
    resolved: &ResolvedEndpoint,
    from: &str,
    to: &str,
    timeout: Duration,
) -> Result<crate::cli_interface::CommandOutcome, CoreError> {
    let mut args = scp_args(&resolved.identity, &resolved.endpoint.port.to_string());
    args.extend(noninteractive_args());
    args.extend([
        "-q".to_owned(),
        "--".to_owned(),
        from.to_owned(),
        to.to_owned(),
    ]);
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    crate::cli_interface::run_capped(scp, &borrowed, timeout)
}

/// 이미 있는 파일을 말없이 덮지 않는다는 거절 한 벌. 올릴 때는 원격 경로, 받을 때는 로컬
/// 경로가 주어가 되고 문구는 같다.
fn overwrite_conflict(subject: &str) -> CoreError {
    CoreError::Conflict(format!(
        "{subject}에 이미 파일이 있습니다. 덮어쓰려면 overwrite를 켜서 다시 요청하세요"
    ))
}

/// 접속 인자와 원격 명령을 한 argv로 조립한다. 모아서 돌리는 경로와 흘리는 경로가 같은
/// argv를 쓰도록 한 곳에 둔다.
fn ssh_argv(resolved: &ResolvedEndpoint, remote: &[&str]) -> Vec<String> {
    let mut args = connect_args(&resolved.identity, &resolved.endpoint.port.to_string());
    args.extend(noninteractive_args());
    args.push(resolved.target.clone());
    args.extend(remote.iter().map(|value| (*value).to_owned()));
    args
}

/// 명령 하나를 원격에 넘긴다. 인자는 구조화된 벡터로만 조립하며 셸 문자열은 만들지 않는다(G9).
fn run_ssh(
    executable: &Path,
    resolved: &ResolvedEndpoint,
    remote: &[&str],
    timeout: Duration,
) -> Result<crate::cli_interface::CommandOutcome, CoreError> {
    run_ssh_with_input(executable, resolved, remote, timeout, None)
}

/// C9-19. 원격 `sudo`가 stdin에서 읽을 비밀번호를 함께 넘기는 변형.
///
/// 값은 argv에 실리지 않는다 — 원격 호스트의 다른 프로세스가 `ps`로 읽을 수 있고, 이 앱의
/// 영수증·승인 카드·감사 기록에도 명령 문자열은 그대로 남기 때문이다. `ssh`의 stdin은 원격
/// 명령의 stdin으로 이어지므로, 부모가 쓴 한 줄이 원격 `sudo -S`에 그대로 닿는다.
fn run_ssh_with_input(
    executable: &Path,
    resolved: &ResolvedEndpoint,
    remote: &[&str],
    timeout: Duration,
    input: Option<&str>,
) -> Result<crate::cli_interface::CommandOutcome, CoreError> {
    let args = ssh_argv(resolved, remote);
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    crate::cli_interface::run_capped_with_input(executable, &borrowed, timeout, input)
}

/// C9-18. 종료를 기다리지 않고 줄이 생기는 대로 싱크에 넘기면서 같은 결과를 모은다.
///
/// 영수증은 [`run_ssh`]와 같은 모양으로 돌려주므로 호출자는 두 경로를 구분하지 않는다.
/// 흘리는 쪽에는 두 가지 제한이 더 있다 — 키 블록은 줄 단위 필터가 BEGIN에서 END까지
/// 붙잡아 두고, 화면에 나가는 총량은 영수증 상한과 같다. 원격이 상한을 넘겨 계속 말하면
/// 그 뒤는 화면에 나가지 않고 영수증도 같은 자리에서 잘린다.
fn run_ssh_streaming(
    executable: &Path,
    resolved: &ResolvedEndpoint,
    command: &str,
    timeout: Duration,
    terminal: &dyn SshTerminalSink,
    input: Option<&str>,
) -> Result<crate::cli_interface::CommandOutcome, CoreError> {
    use std::sync::mpsc;

    terminal.ssh_terminal_started(&resolved.destination, command);
    let args = ssh_argv(resolved, &[command]);
    let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
    let mut process = crate::cli_interface::capped_command(executable, &borrowed);
    if input.is_some() {
        process.stdin(std::process::Stdio::piped());
    }
    let mut child = process.spawn().map_err(|error| {
        let message = format!(
            "{} 실행을 시작하지 못했습니다: {error}",
            executable.to_string_lossy()
        );
        terminal.ssh_terminal_finished(false, false, &message);
        CoreError::Runtime(message)
    })?;
    // C9-19. 쓰고 곧바로 닫는다. 열어 둔 채로 두면 입력을 더 기다리는 원격이 제한 시간까지
    // 매달린다. 이 값은 화면으로 흐르는 줄에 실리지 않는다 — 우리가 쓰는 쪽이고 읽는 쪽이
    // 아니다.
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(input.as_bytes());
            let _ = stdin.write_all(b"\n");
            let _ = stdin.flush();
        }
    }

    let (sender, receiver) = mpsc::channel::<(SshOutputStream, Vec<u8>)>();
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let sender = sender.clone();
        readers.push(std::thread::spawn(move || {
            forward_lines(stdout, SshOutputStream::Stdout, &sender)
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let sender = sender.clone();
        readers.push(std::thread::spawn(move || {
            forward_lines(stderr, SshOutputStream::Stderr, &sender)
        }));
    }
    drop(sender);

    let mut relay = TerminalRelay::new(terminal);
    let started = std::time::Instant::now();
    let mut timed_out = false;
    let mut status = None;
    // 줄이 오면 넘기고, 조용하면 자식 상태와 제한 시간을 본다. 파이프가 모두 닫힌 뒤에도
    // 종료 코드는 따로 기다려야 하므로 두 단계로 나뉜다.
    let mut readers_open = true;
    while readers_open {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok((stream, bytes)) => relay.push(stream, &bytes),
            Err(mpsc::RecvTimeoutError::Disconnected) => readers_open = false,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    timed_out = true;
                    // 죽인 뒤 잠깐 남은 줄을 흘린다. 파이프를 물고 있는 손자(ProxyCommand)가
                    // 있으면 끝까지 기다릴 수 없으므로 기다림에도 상한을 둔다.
                    let drain_until = std::time::Instant::now() + Duration::from_secs(2);
                    while let Ok((stream, bytes)) = receiver.recv_timeout(
                        drain_until.saturating_duration_since(std::time::Instant::now()),
                    ) {
                        relay.push(stream, &bytes);
                    }
                    readers_open = false;
                }
            }
        }
    }
    if !timed_out {
        // 파이프가 모두 닫혔으니 리더는 끝났다. 시간 초과면 리더가 아직 막혀 있을 수 있어
        // 기다리지 않는다 — 스레드는 파이프가 닫힐 때 스스로 끝난다.
        for reader in readers {
            let _ = reader.join();
        }
        loop {
            match child.try_wait()? {
                Some(exit) => {
                    status = Some(exit);
                    break;
                }
                None if started.elapsed() >= timeout => {
                    let _ = child.kill();
                    timed_out = true;
                    break;
                }
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }
    let _ = child.wait();

    let outcome = crate::cli_interface::CommandOutcome {
        success: status.map(|status| status.success()).unwrap_or(false),
        timed_out,
        stdout: String::from_utf8_lossy(&relay.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&relay.stderr).into_owned(),
    };
    let message = diagnose_outcome(&outcome).message;
    terminal.ssh_terminal_finished(outcome.success, outcome.timed_out, &message);
    Ok(outcome)
}

/// 파이프를 줄 단위로 읽어 채널로 보낸다. 줄바꿈 없는 마지막 조각도 한 줄로 보낸다.
fn forward_lines(
    reader: impl std::io::Read,
    stream: SshOutputStream,
    sender: &std::sync::mpsc::Sender<(SshOutputStream, Vec<u8>)>,
) {
    use std::io::BufRead;
    let mut reader = std::io::BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
            Ok(_) => {
                if sender.send((stream, line.clone())).is_err() {
                    break;
                }
            }
        }
    }
}

/// 흘러온 줄을 영수증용 버퍼에 모으면서 화면 싱크에도 넘긴다. 두 상한을 함께 지킨다 —
/// 버퍼는 바이트 상한, 화면은 글자 상한이며 넘긴 뒤에는 한 번만 생략을 알린다.
struct TerminalRelay<'a> {
    terminal: &'a dyn SshTerminalSink,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_filter: KeyBlockFilter,
    stderr_filter: KeyBlockFilter,
    shown_chars: usize,
    truncated_announced: bool,
}

impl<'a> TerminalRelay<'a> {
    fn new(terminal: &'a dyn SshTerminalSink) -> Self {
        Self {
            terminal,
            stdout: Vec::new(),
            stderr: Vec::new(),
            stdout_filter: KeyBlockFilter::default(),
            stderr_filter: KeyBlockFilter::default(),
            shown_chars: 0,
            truncated_announced: false,
        }
    }

    fn push(&mut self, stream: SshOutputStream, bytes: &[u8]) {
        let (buffer, filter) = match stream {
            SshOutputStream::Stdout => (&mut self.stdout, &mut self.stdout_filter),
            SshOutputStream::Stderr => (&mut self.stderr, &mut self.stderr_filter),
        };
        if buffer.len() < crate::process_output::MAX_CAPTURED_OUTPUT_BYTES {
            let room = crate::process_output::MAX_CAPTURED_OUTPUT_BYTES - buffer.len();
            buffer.extend_from_slice(&bytes[..bytes.len().min(room)]);
        }
        let text = String::from_utf8_lossy(bytes);
        let line = text.trim_end_matches(['\n', '\r']);
        let Some(visible) = filter.filter_line(line) else {
            return;
        };
        let length = visible.chars().count().saturating_add(1);
        if self.shown_chars.saturating_add(length) > MAX_OUTPUT_CHARS {
            if !self.truncated_announced {
                self.truncated_announced = true;
                self.terminal
                    .ssh_terminal_output(stream, "[출력 상한을 넘어 이후 줄은 생략합니다]");
            }
            return;
        }
        self.shown_chars += length;
        self.terminal.ssh_terminal_output(stream, &visible);
    }
}

struct RemoteDigest {
    digest: Option<String>,
    reason: String,
}

/// 원격 파일의 SHA-256을 읽는다. 에이전트가 문자열을 주지 않는 고정 명령 두 개만 쓴다 —
/// 전송 권한이 함의하는 범위가 그 두 개로 끝난다는 뜻이다(C9-15).
fn remote_digest(
    ssh: &Path,
    resolved: &ResolvedEndpoint,
    remote_path: &str,
    bytes: Option<u64>,
) -> Result<RemoteDigest, CoreError> {
    let timeout = digest_timeout(bytes);
    for command in [
        vec!["sha256sum", "--", remote_path],
        vec!["shasum", "-a", "256", "--", remote_path],
    ] {
        let outcome = run_ssh(ssh, resolved, &command, timeout)?;
        if outcome.success {
            if let Some(digest) = parse_digest(&outcome.stdout) {
                return Ok(RemoteDigest {
                    digest: Some(digest),
                    reason: String::new(),
                });
            }
            return Ok(RemoteDigest {
                digest: None,
                reason: "원격 지문 명령의 출력을 읽지 못했습니다".to_owned(),
            });
        }
        // 도구가 없는 경우에만 다음 후보로 넘어간다. 파일이 없거나 권한이 없는 것은
        // 다른 후보로도 같은 결과라 여기서 끝낸다.
        if !mentions_missing_command(&outcome.stderr) {
            return Ok(RemoteDigest {
                digest: None,
                reason: redact(&outcome.stderr),
            });
        }
    }
    Ok(RemoteDigest {
        digest: None,
        reason: "원격에 sha256sum도 shasum도 없어 지문을 확인하지 못했습니다".to_owned(),
    })
}

/// 원격 파일의 바이트 수. 지문과 같은 이유로 고정 명령 하나만 쓴다(C9-15). 상한을 넘는
/// 파일을 받기 **전에** 거절하려면 크기를 먼저 알아야 하고, 그 값을 로컬 디스크에 한
/// 바이트도 쓰지 않고 얻는 방법은 이 조회뿐이다.
fn remote_size(
    ssh: &Path,
    resolved: &ResolvedEndpoint,
    remote_path: &str,
) -> Result<Option<u64>, CoreError> {
    // 크기를 모르는 채 크기를 물으므로 이 조회만 상한 기준 고정값이다. `wc -c`는 파일을
    // 읽지 않고 메타데이터만 보는 구현이 흔하고, 읽더라도 이 시간 안에 끝난다.
    let outcome = run_ssh(
        ssh,
        resolved,
        &["wc", "-c", "--", remote_path],
        digest_timeout(Some(MAX_TRANSFER_BYTES)),
    )?;
    if !outcome.success {
        return Ok(None);
    }
    Ok(outcome
        .stdout
        .split_whitespace()
        .next()
        .and_then(|token| token.parse::<u64>().ok()))
}

fn parse_digest(stdout: &str) -> Option<String> {
    let token = stdout.split_whitespace().next()?;
    let valid = token.len() == 64 && token.chars().all(|value| value.is_ascii_hexdigit());
    valid.then(|| token.to_ascii_lowercase())
}

/// 영수증에 실을 본문 하나를 만든다. 키 블록을 빼고, 요청이 정한 줄 수에서 자르고, 글자
/// 수 상한으로 한 번 더 자른다. 두 상한 중 어느 쪽이 걸렸든 잘린 것은 잘린 것이므로
/// `truncated`는 둘을 합쳐 돌려준다 — 한쪽만 보면 영수증이 "다 실었다"고 거짓말을 한다.
fn cap_receipt_text(raw: &str, max_lines: Option<usize>) -> (String, bool) {
    let (lined, lines_cut) = cap_lines(&strip_key_blocks(raw), max_lines);
    let (capped, chars_cut) = cap_output(&lined);
    (capped, lines_cut || chars_cut)
}

/// C9-20. 요청이 정한 줄 수까지만 남긴다. 원격에는 그대로 다 말하게 두고 앱이 앞에서
/// 자르므로, 명령이 무엇이든 지켜지고 글자 수 상한과 달리 줄 가운데서 끊기지 않는다.
fn cap_lines(text: &str, max_lines: Option<usize>) -> (String, bool) {
    let Some(max_lines) = max_lines.filter(|value| *value > 0) else {
        return (text.to_owned(), false);
    };
    let mut kept: Vec<&str> = Vec::new();
    for line in text.lines() {
        if kept.len() == max_lines {
            return (kept.join("\n"), true);
        }
        kept.push(line);
    }
    // 자를 것이 없으면 받은 그대로 돌려준다. 줄을 나눴다 다시 이으면 끝의 줄바꿈이 사라져,
    // 상한을 주기만 해도 본문이 미묘하게 달라진다.
    (text.to_owned(), false)
}

fn command_timeout(requested: Option<u64>) -> Result<Duration, CoreError> {
    let seconds = requested.unwrap_or(DEFAULT_COMMAND_TIMEOUT_SECONDS);
    if seconds == 0 || seconds > MAX_COMMAND_TIMEOUT_SECONDS {
        return Err(CoreError::InvalidInput(format!(
            "원격 명령 제한 시간은 1에서 {MAX_COMMAND_TIMEOUT_SECONDS}초 사이여야 합니다"
        )));
    }
    Ok(Duration::from_secs(seconds))
}

/// C9-15. 업로드가 닿을 수 있는 원격 루트. 절대 경로나 `~/` 아래만 받고 상위 이동을 막는다.
pub(crate) fn validate_transfer_root(value: &str) -> Result<String, CoreError> {
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err(CoreError::InvalidInput(
            "전송 폴더가 비어 있습니다. 설정에서 접속하는 서버 안의 전송 폴더 경로를 적어야 합니다"
                .to_owned(),
        ));
    }
    let absolute = value.starts_with('/') || value.starts_with("~/");
    if !absolute
        || value.chars().count() > MAX_REMOTE_PATH_CHARS
        || !value.chars().all(is_allowed_path_char)
        || value.split('/').any(|segment| segment == "..")
        || value.contains("//")
    {
        return Err(CoreError::InvalidInput(format!(
            "전송 폴더는 접속하는 서버 안의 경로입니다 — 이 PC의 폴더가 아니므로 C:\\ 같은 Windows 경로는 받지 않습니다. 서버 기준 /로 시작하거나 ~/ 아래의 {MAX_REMOTE_PATH_CHARS}자 이하 경로여야 하고, 공백·상위 이동(..)·특수문자를 담을 수 없습니다"
        )));
    }
    // `~`는 원격 홈을 여는 첫 글자로만 쓸 수 있다. 경로 중간의 `~`는 셸 확장이 어디로
    // 갈지 앱이 알 수 없다.
    if value[1..].contains('~') {
        return Err(CoreError::InvalidInput(
            "전송 폴더의 ~는 맨 앞에서만 쓸 수 있습니다".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

/// 전송 루트 아래 상대 경로를 붙인다. 비어 있으면 상대편 파일 이름을 그대로 쓴다.
fn join_remote_path(root: &str, requested: &str, file_name: &str) -> Result<String, CoreError> {
    let requested = requested.trim();
    // 절대 경로는 접어 넣지 않고 거절한다. `/etc/passwd`를 `<root>/etc/passwd`로 조용히
    // 바꾸면 대상은 폴더 안에 남지만, 호출한 쪽은 자기가 시스템 파일을 다룬다고 믿은 채
    // "없는 파일"이라는 답을 받는다. 경계를 지키는 것과 계약을 알려 주는 것은 다른 일이다.
    if requested.starts_with('/') {
        return Err(CoreError::InvalidInput(format!(
            "원격 경로는 전송 폴더({root}) 아래 상대 경로로 지정해야 합니다. 절대 경로는 받지 않습니다"
        )));
    }
    // 올릴 때는 로컬 파일 이름으로 채울 수 있지만, 받을 때는 채울 값이 없다. 빈 이름은
    // 아래 검사에서 거절되므로 여기서 특별히 다루지 않는다.
    let relative = if requested.is_empty() {
        file_name
    } else {
        requested
    };
    let relative = relative.trim_end_matches('/');
    if relative.is_empty()
        || relative.chars().count() > MAX_REMOTE_PATH_CHARS
        || !relative.chars().all(is_allowed_path_char)
        || relative.contains('~')
        || relative.contains("//")
        || relative
            .split('/')
            .any(|segment| segment == ".." || segment == ".")
    {
        return Err(CoreError::InvalidInput(format!(
            "원격 경로는 전송 폴더 아래의 {MAX_REMOTE_PATH_CHARS}자 이하 상대 경로여야 하고, 공백·상위 이동(..)·~·특수문자를 담을 수 없습니다"
        )));
    }
    Ok(format!("{root}/{relative}"))
}

#[derive(Debug)]
struct LocalSource {
    path: PathBuf,
    file_name: String,
    bytes: u64,
    sha256: String,
}

/// C9-16. 올릴 로컬 파일을 검증한다. 경로를 먼저 canonicalize하고 그 결과에 경계를 걸어,
/// 보호 구역을 가리키는 심링크로 우회할 수 없게 한다(G10).
fn resolve_local_source(
    app_data_dir: &Path,
    home: &Path,
    raw: &str,
) -> Result<LocalSource, CoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(
            "올릴 파일의 경로가 비어 있거나 제어문자를 담고 있습니다".to_owned(),
        ));
    }
    let requested = match trimmed.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(trimmed),
    };
    if !requested.is_absolute() {
        return Err(CoreError::InvalidInput(
            "올릴 파일은 절대 경로나 ~/ 아래 경로로 지정해야 합니다".to_owned(),
        ));
    }
    let path = std::fs::canonicalize(&requested).map_err(|error| {
        CoreError::NotFound(format!(
            "{}을(를) 읽을 수 없습니다: {error}",
            requested.to_string_lossy()
        ))
    })?;
    let metadata = std::fs::symlink_metadata(&path)?;
    if !metadata.is_file() {
        return Err(CoreError::InvalidInput(
            "올릴 대상이 일반 파일이 아닙니다".to_owned(),
        ));
    }
    if metadata.len() > MAX_TRANSFER_BYTES {
        return Err(CoreError::TooLarge(MAX_TRANSFER_BYTES));
    }
    assert_local_path_allowed(app_data_dir, &path)?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| value.chars().all(is_allowed_path_char) && !value.starts_with('.'))
        .ok_or_else(|| {
            CoreError::InvalidInput(
                "올릴 파일 이름에 원격 경로로 쓸 수 없는 글자가 있습니다. remotePath로 쓸 이름을 직접 지정하세요".to_owned(),
            )
        })?
        .to_owned();
    let sha256 = digest_file(&path)?;
    Ok(LocalSource {
        path,
        file_name,
        bytes: metadata.len(),
        sha256,
    })
}

/// C9-16. 이 어댑터가 로컬에서 읽거나 쓰지 않는 자리. 양방향에 같은 경계를 쓴다 — 올릴 수
/// 없는 파일을 받은 자리에 덮어쓸 수 있으면 경계가 한쪽만 남는다.
///
/// 앞의 두 항목은 문서 루트·C6 폴더 만들기와 **같은 기준**(`store::is_restricted_doc_root`)
/// 이고, 세 번째는 그 밖에서 흔히 자격증명을 담는 자리다. 일반적인 비밀값 탐지기가 아니므로
/// 사용자에게 이 목록이 전부라고 말하지 않는다.
pub(crate) fn assert_local_path_allowed(app_data_dir: &Path, path: &Path) -> Result<(), CoreError> {
    if crate::store::is_restricted_doc_root(app_data_dir, path) {
        return Err(CoreError::InvalidInput(
            "공급자 홈과 Agent Manager 데이터 폴더는 이 전송의 대상이 될 수 없습니다".to_owned(),
        ));
    }
    if let Some(segment) = path.components().find_map(|component| {
        let value = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        REFUSED_LOCAL_SEGMENTS
            .contains(&value.as_str())
            .then_some(value)
    }) {
        return Err(CoreError::InvalidInput(format!(
            "{segment}은(는) 자격증명이 놓이는 자리라 이 전송의 대상이 될 수 없습니다. 다른 경로로 다시 요청하세요"
        )));
    }
    Ok(())
}

/// 받은 파일을 쓸 자리.
#[derive(Debug)]
struct LocalDestination {
    path: PathBuf,
    /// 그 자리에 이미 파일이 있었는지. 실패 정리가 남의 파일을 지우지 않게 하는 근거다.
    replaced: bool,
}

/// C9-16. 받은 파일을 쓸 로컬 경로를 정한다. 쓰기 경계는 에이전트가 이미 가진 것과 **같다**
/// — C6의 폴더 만들기(`user_path::create_user_directory`)와 같은 규칙이다: `~`를 펼친 절대
/// 경로만 받고, `..`를 거절하고, **상위 폴더가 이미 있어야** 하며, 그 상위를 정규화한 뒤
/// 이름을 붙인다. 상위를 정규화하고 나서 붙이는 것이 심볼릭 링크로 경계를 넘는 길을 막고,
/// 상위를 만들어 주지 않는 것이 오타 하나로 트리가 생기는 일을 막는다.
fn resolve_local_destination(
    app_data_dir: &Path,
    home: &Path,
    raw: &str,
) -> Result<LocalDestination, CoreError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return Err(CoreError::InvalidInput(
            "받을 자리의 경로가 비어 있거나 제어문자를 담고 있습니다".to_owned(),
        ));
    }
    let requested = match trimmed.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(trimmed),
    };
    if !requested.is_absolute() {
        return Err(CoreError::InvalidInput(
            "받을 자리는 절대 경로나 ~/ 아래 경로로 지정해야 합니다".to_owned(),
        ));
    }
    if crate::path_guard::has_parent_dir(&requested) {
        return Err(CoreError::InvalidInput(
            "받을 자리의 경로에 상위 디렉터리(..)를 쓸 수 없습니다".to_owned(),
        ));
    }
    let (parent, name) = requested
        .parent()
        .zip(requested.file_name())
        .ok_or_else(|| CoreError::InvalidInput("최상위 경로에는 받을 수 없습니다".to_owned()))?;
    let parent = crate::user_path::resolve_existing_directory_path(parent)?;
    let path = parent.join(name);
    assert_local_path_allowed(app_data_dir, &path)?;

    // 이미 있는 자리는 사용자가 승인한 덮어쓰기일 때만 쓴다. 폴더나 심볼릭 링크가 있으면
    // 어느 쪽이든 그 자리를 우리가 정할 수 없으므로 거절한다.
    let replaced = match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(CoreError::Conflict(format!(
                "{}이(가) 심볼릭 링크라 받을 자리로 쓰지 않았습니다",
                path.display()
            )));
        }
        Ok(metadata) if metadata.is_file() => true,
        Ok(_) => {
            return Err(CoreError::Conflict(format!(
                "{}에 파일이 아닌 항목이 있습니다",
                path.display()
            )));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    Ok(LocalDestination { path, replaced })
}

fn digest_file(path: &Path) -> Result<String, CoreError> {
    use std::io::Read;

    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    #[cfg(unix)]
    use crate::ssh_approvals::SshApprovalStore;
    use crate::ssh_endpoints::{set_ssh_key_endpoint_for_test, SetSshKeyEndpointRequest};

    fn public_key_line() -> String {
        public_key_line_seeded(9)
    }

    /// 지문이 서로 다른 공개키를 만들기 위해 키 재료 한 바이트만 바꾼다.
    fn public_key_line_seeded(seed: u8) -> String {
        let key_type = "ssh-ed25519";
        let mut blob = Vec::new();
        blob.extend_from_slice(&(key_type.len() as u32).to_be_bytes());
        blob.extend_from_slice(key_type.as_bytes());
        blob.extend_from_slice(&32u32.to_be_bytes());
        blob.extend_from_slice(&[seed; 32]);
        format!("{key_type} {} dev@example\n", STANDARD.encode(blob))
    }

    /// 공개키·개인키 한 벌을 갖춘 홈을 만들고 그 지문을 돌려준다.
    fn key_fixture(home: &Path, with_private_key: bool) -> String {
        let root = home.join(".ssh");
        fs::create_dir_all(&root).expect("ssh root");
        fs::write(root.join("id_example.pub"), public_key_line()).expect("public");
        if with_private_key {
            fs::write(root.join("id_example"), b"private material").expect("private");
        }
        crate::ssh_keys::get_ssh_keys_with_home(home)
            .expect("inventory")
            .keys[0]
            .fingerprint
            .clone()
    }

    /// 같은 홈에 이름·지문이 다른 키 한 벌을 더 만든다. 승인이 다른 서버로 새지 않는지
    /// 실행 경로에서 확인하려면 지문이 둘 필요하다.
    #[cfg(unix)]
    fn extra_key_fixture(home: &Path, name: &str, seed: u8) -> String {
        let root = home.join(".ssh");
        fs::create_dir_all(&root).expect("ssh root");
        fs::write(
            root.join(format!("{name}.pub")),
            public_key_line_seeded(seed),
        )
        .expect("public");
        fs::write(root.join(name), b"private material").expect("private");
        crate::ssh_keys::get_ssh_keys_with_home(home)
            .expect("inventory")
            .keys
            .iter()
            .find(|key| key.file_name == format!("{name}.pub"))
            .expect("추가 키")
            .fingerprint
            .clone()
    }

    fn endpoint_request(fingerprint: &str) -> SetSshKeyEndpointRequest {
        SetSshKeyEndpointRequest {
            fingerprint: fingerprint.to_owned(),
            host: "build.example.com".to_owned(),
            port: Some(2222),
            user: "deploy".to_owned(),
            agent_enabled: true,
            allowed_commands: vec![
                "systemctl status".to_owned(),
                "tar -xzf".to_owned(),
                "ls".to_owned(),
                "sudo systemctl restart".to_owned(),
            ],
            denied_commands: vec!["rm -rf".to_owned(), "cat ~/.ssh/id_".to_owned()],
            file_transfer_enabled: false,
            transfer_root: String::new(),
            terminal_enabled: false,
            unrestricted_commands: false,
        }
    }

    /// 실행 파일 자리에 놓을 셸 스크립트를 하나 만든다.
    #[cfg(unix)]
    fn script(directory: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = directory.join(name);
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("script");
        let mut permissions = fs::metadata(&path).expect("metadata").permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).expect("mode");
        path
    }

    /// C9-20. 원격이 아무리 길게 말해도 요청이 정한 줄 수까지만 영수증에 실리고, 잘린 사실은
    /// `truncated`가 말한다. 두 상한 중 어느 쪽이 걸렸는지는 구분하지 않는다.
    #[test]
    fn c9_20_receipt_lines_are_capped_by_the_request() {
        let body = (1..=10)
            .map(|n| format!("line{n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (text, truncated) = cap_receipt_text(&body, Some(3));
        assert_eq!(text, "line1\nline2\nline3");
        assert!(truncated);
        // 자를 것이 없으면 본문은 한 글자도 달라지지 않는다 — 상한을 주기만 해도 끝의
        // 줄바꿈이 사라지면 같은 출력이 두 모양으로 보인다.
        let intact = strip_key_blocks(&body);
        assert_eq!(cap_receipt_text(&body, Some(50)), (intact.clone(), false));
        // 값이 없거나 0이면 줄 상한은 적용되지 않고 글자 수 상한만 남는다.
        assert_eq!(cap_receipt_text(&body, None), (intact.clone(), false));
        assert_eq!(cap_receipt_text(&body, Some(0)), (intact, false));
        // 줄 상한을 지나도 키 블록은 그대로 지워진다.
        let secret =
            "keep\n-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----";
        let (filtered, _) = cap_receipt_text(secret, Some(10));
        assert!(!filtered.contains('x') && filtered.contains("keep"));
    }

    /// 제한 시간은 요청이 주면 범위를 보고, 주지 않으면 기본값으로 떨어진다.
    #[test]
    fn c9_command_timeout_stays_inside_the_bounds() {
        assert!(command_timeout(Some(0)).is_err());
        assert!(command_timeout(Some(MAX_COMMAND_TIMEOUT_SECONDS + 1)).is_err());
        assert_eq!(
            command_timeout(None).expect("기본값"),
            Duration::from_secs(DEFAULT_COMMAND_TIMEOUT_SECONDS)
        );
    }

    /// C9-14. 에이전트 사용이 꺼진 키, 저장된 서버가 없는 키, 개인키가 없는 키, 목록에
    /// 없는 지문은 모두 `ssh`를 부르기 전에 거절된다.
    #[test]
    fn c9_execution_refuses_keys_the_user_has_not_opened() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = key_fixture(home.path(), true);

        // 저장된 연결 서버가 없다.
        let error = resolve_endpoint(home.path(), app_data.path(), &fingerprint).expect_err("없음");
        assert!(matches!(error, CoreError::NotFound(_)));

        // 에이전트 사용이 꺼져 있다.
        let mut request = endpoint_request(&fingerprint);
        request.agent_enabled = false;
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request).expect("저장");
        let error = resolve_endpoint(home.path(), app_data.path(), &fingerprint).expect_err("꺼짐");
        assert!(matches!(error, CoreError::Conflict(_)));
        assert!(error.to_string().contains("에이전트 사용"));

        // 목록에 없는 지문.
        request.agent_enabled = true;
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request).expect("저장");
        assert!(resolve_endpoint(
            home.path(),
            app_data.path(),
            "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
        .is_err());
        assert!(resolve_endpoint(home.path(), app_data.path(), "not-a-fingerprint").is_err());
        // 켜 둔 뒤에는 개인키 경로가 확정된다.
        let resolved = resolve_endpoint(home.path(), app_data.path(), &fingerprint).expect("확정");
        assert!(Path::new(&resolved.identity).ends_with(".ssh/id_example"));
        assert_eq!(resolved.destination, "deploy@build.example.com:2222");

        // 개인키가 사라지면 다시 거절된다.
        fs::remove_file(home.path().join(".ssh/id_example")).expect("remove");
        let error =
            resolve_endpoint(home.path(), app_data.path(), &fingerprint).expect_err("개인키 없음");
        assert!(error.to_string().contains("개인키"));
    }

    /// C9-15. 업로드는 명령 허용 목록과 분리된 권한이고, 그 권한은 에이전트 사용을 켠
    /// 서버에만 붙는다. 전송 폴더는 저장 시점에 검증된다.
    #[test]
    fn c9_transfer_permission_is_separate_and_bounded() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let fingerprint = key_fixture(home.path(), true);

        // 에이전트 사용이 꺼진 서버에는 전송만 열 수 없다.
        let mut request = endpoint_request(&fingerprint);
        request.agent_enabled = false;
        request.file_transfer_enabled = true;
        request.transfer_root = "/srv/releases".to_owned();
        assert!(set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request).is_err());

        // 전송을 켜면 전송 폴더가 필요하다.
        request.agent_enabled = true;
        request.transfer_root = String::new();
        assert!(set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request).is_err());

        request.transfer_root = "/srv/releases/".to_owned();
        let snapshot =
            set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request).expect("저장");
        let endpoint = snapshot.keys[0].endpoint.as_ref().expect("endpoint");
        assert!(endpoint.file_transfer_enabled);
        assert_eq!(endpoint.transfer_root, "/srv/releases");

        // 전송을 끄면 폴더도 남지 않는다.
        request.file_transfer_enabled = false;
        request.transfer_root = "/srv/releases".to_owned();
        let snapshot =
            set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &request).expect("저장");
        let endpoint = snapshot.keys[0].endpoint.as_ref().expect("endpoint");
        assert!(!endpoint.file_transfer_enabled);
        assert!(endpoint.transfer_root.is_empty());

        for root in [
            "srv/releases",
            "/srv/../etc",
            "/srv/rel eases",
            "/srv;touch x",
            "/srv/~/x",
            "~",
            "",
            "/srv//releases",
        ] {
            assert!(
                validate_transfer_root(root).is_err(),
                "{root} 는 거절돼야 합니다"
            );
        }
        assert_eq!(
            validate_transfer_root("~/releases").expect("홈 아래"),
            "~/releases"
        );
    }

    /// C9-16. 원격 대상은 전송 폴더 아래로만 정해진다. 상위 이동·절대 경로·`~`·공백은
    /// 대상이 폴더 밖으로 나가거나 원격 셸에서 두 인자로 갈라질 수 있어 거절한다.
    #[test]
    fn c9_remote_target_stays_under_the_transfer_root() {
        assert_eq!(
            join_remote_path("/srv/releases", "", "app.tgz").expect("기본 이름"),
            "/srv/releases/app.tgz"
        );
        assert_eq!(
            join_remote_path("/srv/releases", "2026/app.tgz", "app.tgz").expect("하위"),
            "/srv/releases/2026/app.tgz"
        );
        // 절대 경로는 접어 넣지 않고 거절한다. 폴더 안에 남더라도, 호출한 쪽이 시스템
        // 파일을 다룬다고 믿는 채로 답을 받게 두지 않는다.
        for requested in [
            "/app.tgz",
            "/etc/passwd",
            "../etc/passwd",
            "a/../../etc/passwd",
            "./app.tgz",
            "~/app.tgz",
            "app tgz",
            "app;rm -rf /",
            "a//b",
            "..",
        ] {
            assert!(
                join_remote_path("/srv/releases", requested, "app.tgz").is_err(),
                "{requested} 는 거절돼야 합니다"
            );
        }
    }

    /// C9-16. 로컬 원본은 실제 일반 파일이어야 하고, 자격증명이 놓이는 자리는 거절된다.
    /// 경로를 먼저 canonicalize하므로 보호 구역을 가리키는 심링크로도 우회할 수 없다.
    #[test]
    fn c9_local_source_is_validated_and_credential_paths_are_refused() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        key_fixture(home.path(), true);
        let payload = home.path().join("app.tgz");
        fs::write(&payload, b"release bytes").expect("payload");

        let source = resolve_local_source(app_data.path(), home.path(), payload.to_str().unwrap())
            .expect("원본");
        assert_eq!(source.file_name, "app.tgz");
        assert_eq!(source.bytes, 13);
        assert_eq!(source.sha256, digest_file(&payload).expect("digest"));
        assert_eq!(source.sha256.len(), 64);
        // `~/`도 같은 파일로 풀린다.
        assert_eq!(
            resolve_local_source(app_data.path(), home.path(), "~/app.tgz")
                .expect("홈 상대")
                .path,
            source.path
        );

        // ~/.ssh의 개인키는 어떤 경로로도 올릴 수 없다.
        let private_key = home.path().join(".ssh/id_example");
        let error =
            resolve_local_source(app_data.path(), home.path(), private_key.to_str().unwrap())
                .expect_err("개인키");
        assert!(error.to_string().contains(".ssh"));

        // 보호 구역을 가리키는 심링크도 canonicalize 뒤에 걸린다.
        #[cfg(unix)]
        {
            let link = home.path().join("looks_harmless.tgz");
            std::os::unix::fs::symlink(&private_key, &link).expect("symlink");
            assert!(
                resolve_local_source(app_data.path(), home.path(), link.to_str().unwrap()).is_err()
            );
        }

        // 앱 데이터 안의 파일도 거절된다.
        let inside_app_data = app_data.path().join("state.json");
        fs::write(&inside_app_data, b"{}").expect("app data file");
        assert!(resolve_local_source(
            app_data.path(),
            home.path(),
            inside_app_data.to_str().unwrap()
        )
        .is_err());

        // 상대 경로, 없는 파일, 폴더, 제어문자는 파일시스템을 건드리기 전이나 직후에 걸린다.
        for raw in ["app.tgz", "", "~/missing.tgz", "\u{1}/x"] {
            assert!(
                resolve_local_source(app_data.path(), home.path(), raw).is_err(),
                "{raw:?} 는 거절돼야 합니다"
            );
        }
        assert!(
            resolve_local_source(app_data.path(), home.path(), home.path().to_str().unwrap())
                .is_err()
        );
        // 원격 경로로 쓸 수 없는 이름은 remotePath를 직접 주라고 알린다.
        let odd = home.path().join("release note.tgz");
        fs::write(&odd, b"x").expect("odd");
        assert!(resolve_local_source(app_data.path(), home.path(), odd.to_str().unwrap()).is_err());
    }

    /// 지문 명령의 출력에서 해시만 가려낸다. 64자 16진수가 아니면 지문이 없는 것으로 본다.
    #[test]
    fn parse_digest_takes_only_a_full_sha256_head() {
        assert_eq!(
            parse_digest(&format!("{}  /srv/x\n", "a".repeat(64))),
            Some("a".repeat(64))
        );
        assert_eq!(parse_digest("nope /srv/x"), None);
    }

    /// 흘러온 줄을 순서대로 기록하는 시험용 싱크.
    #[derive(Default)]
    struct RecordingTerminal {
        events: std::sync::Mutex<Vec<String>>,
    }

    impl RecordingTerminal {
        fn events(&self) -> Vec<String> {
            self.events.lock().expect("events").clone()
        }
    }

    impl SshTerminalSink for RecordingTerminal {
        fn ssh_terminal_started(&self, destination: &str, command: &str) {
            self.events
                .lock()
                .expect("events")
                .push(format!("start {destination} {command}"));
        }

        fn ssh_terminal_output(&self, stream: SshOutputStream, line: &str) {
            let tag = match stream {
                SshOutputStream::Stdout => "out",
                SshOutputStream::Stderr => "err",
            };
            self.events
                .lock()
                .expect("events")
                .push(format!("{tag} {line}"));
        }

        fn ssh_terminal_finished(&self, succeeded: bool, timed_out: bool, message: &str) {
            self.events
                .lock()
                .expect("events")
                .push(format!("end {succeeded} {timed_out} {message}"));
        }
    }

    /// C9-18. 터미널 표시가 켜진 서버에서 싱크가 있으면 줄이 흐르고 영수증은 같다. 키 블록은
    /// 흐르는 중에도 나가지 않고, 시간 초과는 그대로 알린다. 서버의 토글이 꺼져 있으면 싱크가
    /// 있어도 아무것도 흐르지 않는다.
    #[cfg(unix)]
    #[test]
    fn c9_18_streaming_relays_filtered_lines_and_keeps_the_receipt_identical() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        let mut endpoint = endpoint_request(&fingerprint);
        endpoint.terminal_enabled = true;
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &endpoint).expect("저장");
        let request = |command: &str, timeout: Option<u64>| ExecuteSshCommandRequest {
            fingerprint: fingerprint.clone(),
            command: command.to_owned(),
            timeout_seconds: timeout,
            approval_id: None,
            max_lines: None,
        };

        let chatty = script(
            bin.path(),
            "ssh-chatty",
            "echo one\necho '-----BEGIN OPENSSH PRIVATE KEY-----'\necho secretline\necho '-----END OPENSSH PRIVATE KEY-----'\necho warn >&2\necho two\nexit 0",
        );
        let terminal = RecordingTerminal::default();
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &chatty,
            &request("ls /srv", None),
            None,
            Some(&terminal),
        )
        .expect("실행");
        assert!(receipt.succeeded);
        assert!(receipt.stdout.contains("one") && receipt.stdout.contains("two"));
        assert!(!receipt.stdout.contains("secretline"));
        assert_eq!(receipt.stderr.trim(), "warn");
        let events = terminal.events();
        assert_eq!(events[0], "start deploy@build.example.com:2222 ls /srv");
        assert!(events.contains(&"out one".to_owned()));
        assert!(events.contains(&"out [생략된 키 블록]".to_owned()));
        assert!(events.contains(&"err warn".to_owned()));
        assert!(events.contains(&"out two".to_owned()));
        assert!(!events.iter().any(|event| event.contains("secretline")));
        assert_eq!(
            events.last().expect("end"),
            "end true false 실행에 성공했습니다"
        );

        // 시간 초과는 자식을 죽이고 그때까지의 줄은 남긴다. 제한 시간을 짧게 잡으면 전체
        // 스위트가 병렬로 도는 동안 자식이 `echo`에 닿기도 전에 죽어 줄이 아예 오지 않는다 —
        // 여기서 재는 것은 "제한 시간이 정확히 언제 끊는가"가 아니라 "끊긴 뒤에도 그전 줄이
        // 남는가"이므로, 스케줄링에 흔들리지 않을 만큼 넉넉히 준다.
        let hang = script(bin.path(), "ssh-hang", "echo partial\nsleep 60");
        let terminal = RecordingTerminal::default();
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &hang,
            &request("ls /srv", Some(6)),
            None,
            Some(&terminal),
        )
        .expect("실행");
        assert!(receipt.timed_out && !receipt.succeeded);
        let events = terminal.events();
        assert!(events.contains(&"out partial".to_owned()), "{events:?}");
        assert!(
            events.last().expect("end").starts_with("end false true "),
            "{events:?}"
        );

        // 서버의 터미널 표시가 꺼져 있으면 싱크가 있어도 흐르지 않는다.
        let mut quiet = endpoint_request(&fingerprint);
        quiet.terminal_enabled = false;
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &quiet).expect("저장");
        let terminal = RecordingTerminal::default();
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &chatty,
            &request("ls /srv", None),
            None,
            Some(&terminal),
        )
        .expect("실행");
        assert!(receipt.succeeded);
        assert!(terminal.events().is_empty());
    }

    /// C9-18. 화면으로 나가는 총량은 영수증 상한과 같고, 넘으면 한 번만 생략을 알린다.
    #[test]
    fn c9_18_relay_announces_truncation_once_after_the_output_cap() {
        let terminal = RecordingTerminal::default();
        let mut relay = TerminalRelay::new(&terminal);
        let line = format!("{}\n", "x".repeat(999));
        for _ in 0..20 {
            relay.push(SshOutputStream::Stdout, line.as_bytes());
        }
        let events = terminal.events();
        let shown = events
            .iter()
            .filter(|event| event.starts_with("out x"))
            .count();
        assert_eq!(shown, MAX_OUTPUT_CHARS / 1000);
        assert_eq!(
            events
                .iter()
                .filter(|event| event.contains("생략합니다"))
                .count(),
            1
        );
        assert_eq!(events.len(), shown + 1);
    }

    /// C9-14. 성공·권한 거부·호스트 키 검증 실패·시간 초과가 각각 구분되어 보고된다.
    #[cfg(unix)]
    #[test]
    fn c9_command_outcomes_are_classified_for_every_failure_mode() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &endpoint_request(&fingerprint),
        )
        .expect("저장");
        let request = |command: &str, timeout: Option<u64>| ExecuteSshCommandRequest {
            fingerprint: fingerprint.clone(),
            command: command.to_owned(),
            timeout_seconds: timeout,
            approval_id: None,
            max_lines: None,
        };

        let ok = script(bin.path(), "ssh-ok", "echo 'active (running)'\nexit 0");
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ok,
            &request("systemctl status app --no-pager", None),
            None,
            None,
        )
        .expect("실행");
        assert!(receipt.succeeded && !receipt.timed_out && !receipt.truncated);
        assert!(receipt.stdout.contains("active (running)"));
        assert_eq!(receipt.command, "systemctl status app --no-pager");
        assert_eq!(receipt.destination, "deploy@build.example.com:2222");
        assert_eq!(receipt.message, "실행에 성공했습니다");

        let denied = script(
            bin.path(),
            "ssh-denied",
            "echo 'deploy@build.example.com: Permission denied (publickey).' >&2\nexit 255",
        );
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &denied,
            &request("ls /srv", None),
            None,
            None,
        )
        .expect("실행");
        assert!(!receipt.succeeded && receipt.permission_denied && !receipt.host_key_rejected);
        assert!(receipt.message.contains("authorized_keys"));

        let host_key = script(
            bin.path(),
            "ssh-hostkey",
            "echo 'Host key verification failed.' >&2\nexit 255",
        );
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &host_key,
            &request("ls /srv", None),
            None,
            None,
        )
        .expect("실행");
        assert!(!receipt.succeeded && receipt.host_key_rejected);
        assert!(receipt.message.contains("known_hosts에 없습니다"));

        let hang = script(bin.path(), "ssh-hang", "sleep 5");
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &hang,
            &request("ls /srv", Some(1)),
            None,
            None,
        )
        .expect("실행");
        assert!(!receipt.succeeded && receipt.timed_out);
        assert_eq!(receipt.message, "정해진 시간 안에 끝나지 않아 중단했습니다");

        // 정책에 걸리는 명령은 실행 파일을 부르기 전에 거절된다.
        let missing = bin.path().join("does-not-exist");
        for command in ["docker ps", "sh -c whoami", "ls; rm -rf /"] {
            assert!(
                execute_ssh_command_with(
                    home.path(),
                    app_data.path(),
                    &missing,
                    &request(command, None),
                    None,
                    None,
                )
                .is_err(),
                "{command}"
            );
        }
    }

    /// C9-15. 업로드는 전송 권한을 확인하고, 대상 경로·크기·양쪽 SHA-256을 함께 돌려준다.
    /// 이미 있는 파일은 overwrite 없이는 덮지 않는다.
    #[cfg(unix)]
    #[test]
    fn c9_upload_reports_target_size_and_digest_and_never_clobbers_silently() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        let payload = home.path().join("app.tgz");
        fs::write(&payload, b"release bytes").expect("payload");
        let digest = digest_file(&payload).expect("digest");

        let mut endpoint = endpoint_request(&fingerprint);
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &endpoint).expect("저장");
        let scp_ok = script(bin.path(), "scp-ok", "exit 0");
        let ssh_absent = script(
            bin.path(),
            "ssh-absent",
            "echo 'sha256sum: /srv/releases/app.tgz: No such file or directory' >&2\nexit 1",
        );
        let request = |overwrite: bool| UploadSshFileRequest {
            fingerprint: fingerprint.clone(),
            local_path: payload.to_string_lossy().into_owned(),
            remote_path: String::new(),
            overwrite,
        };

        // 전송 권한이 꺼져 있으면 원본을 읽기도 전에 거절된다.
        let error = upload_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_absent,
            &scp_ok,
            &request(false),
        )
        .expect_err("전송 꺼짐");
        assert!(error.to_string().contains("파일 전송"));

        endpoint.file_transfer_enabled = true;
        endpoint.transfer_root = "/srv/releases".to_owned();
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &endpoint).expect("저장");

        // 원격에 없던 파일을 올리고 지문을 맞춘다. 첫 호출은 없음, 이후는 지문을 낸다.
        let state = bin.path().join("uploaded");
        let ssh_verify = script(
            bin.path(),
            "ssh-verify",
            &format!(
                "if [ ! -f {state} ]; then : > {state}; echo 'sha256sum: no such file' >&2; exit 1; fi\necho '{digest}  /srv/releases/app.tgz'",
                state = state.display(),
            ),
        );
        let receipt = upload_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_verify,
            &scp_ok,
            &request(false),
        )
        .expect("업로드");
        assert!(receipt.succeeded && receipt.verified && !receipt.replaced);
        assert_eq!(receipt.remote_path, "/srv/releases/app.tgz");
        assert_eq!(receipt.bytes, 13);
        assert_eq!(receipt.sha256, digest);
        assert_eq!(receipt.remote_sha256.as_deref(), Some(digest.as_str()));
        assert_eq!(receipt.method, "scp");
        assert_eq!(receipt.destination, "deploy@build.example.com:2222");

        // 같은 대상이 이미 있으면 overwrite 없이는 전송하지 않는다.
        let ssh_present = script(
            bin.path(),
            "ssh-present",
            &format!("echo '{digest}  /srv/releases/app.tgz'"),
        );
        let error = upload_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_present,
            &scp_ok,
            &request(false),
        )
        .expect_err("덮어쓰기 거절");
        assert!(error.to_string().contains("overwrite"));
        let receipt = upload_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_present,
            &scp_ok,
            &request(true),
        )
        .expect("덮어쓰기");
        assert!(receipt.succeeded && receipt.verified && receipt.replaced);

        // 전송 실패는 호스트 키·권한 거부를 구분해 보고한다.
        let scp_host_key = script(
            bin.path(),
            "scp-hostkey",
            "echo 'Host key verification failed.' >&2\nexit 255",
        );
        let receipt = upload_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_absent,
            &scp_host_key,
            &request(false),
        )
        .expect("전송 실패");
        assert!(!receipt.succeeded && receipt.host_key_rejected && !receipt.verified);
        assert!(receipt.remote_sha256.is_none());
        assert!(receipt.message.contains("known_hosts에 없습니다"));

        let scp_denied = script(
            bin.path(),
            "scp-denied",
            "echo 'Permission denied (publickey).' >&2\nexit 255",
        );
        let receipt = upload_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_absent,
            &scp_denied,
            &request(false),
        )
        .expect("전송 실패");
        assert!(!receipt.succeeded && receipt.permission_denied);

        // 원격에 지문 도구가 없으면 오류가 아니라 verified=false와 이유로 보고한다.
        let ssh_no_tool = script(
            bin.path(),
            "ssh-no-tool",
            "echo 'sh: sha256sum: command not found' >&2\nexit 127",
        );
        let receipt = upload_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_no_tool,
            &scp_ok,
            &request(false),
        )
        .expect("검증 실패");
        assert!(receipt.succeeded && !receipt.verified);
        assert!(receipt.remote_sha256.is_none());
        assert!(receipt.message.contains("지문"));

        // 크기 상한을 넘는 원본은 전송하지 않는다. 상한 판정은 파일을 읽기 전 메타데이터로
        // 하므로, 실제로 1GiB를 쓰지 않고 크기만 늘려 둔 성긴 파일로 확인한다.
        let oversized = home.path().join("oversized.tgz");
        fs::File::create(&oversized)
            .expect("큰 파일")
            .set_len(MAX_TRANSFER_BYTES + 1)
            .expect("크기 지정");
        let error = upload_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_absent,
            &scp_ok,
            &UploadSshFileRequest {
                fingerprint: fingerprint.clone(),
                local_path: oversized.to_string_lossy().into_owned(),
                remote_path: String::new(),
                overwrite: false,
            },
        )
        .expect_err("크기 상한");
        assert!(matches!(error, CoreError::TooLarge(limit) if limit == MAX_TRANSFER_BYTES));

        // 상한과 같은 크기는 지난다 — 경계가 한 바이트 어긋나면 이 쌍이 갈라진다.
        let at_cap = home.path().join("atcap.tgz");
        fs::File::create(&at_cap)
            .expect("경계 파일")
            .set_len(MAX_TRANSFER_BYTES)
            .expect("크기 지정");
        assert!(
            resolve_local_source(app_data.path(), home.path(), at_cap.to_str().unwrap()).is_ok()
        );
    }

    /// C9-15. 제한 시간은 크기에 비례하고, 상한은 그 천장 안에 들어와야 한다. 이 둘이
    /// 어긋나면 상한이 "실패하는 크기"를 허락하게 된다 — 고정 제한 시간에서 상한만 올릴 때
    /// 생기는 일이고, 이 테스트가 그 조합을 막는다.
    #[test]
    fn c9_transfer_timeout_scales_with_size_and_covers_the_cap() {
        let seconds = |bytes: Option<u64>| transfer_timeout(bytes).as_secs();
        let mib = 1024 * 1024;

        // 작은 파일은 접속 몫만 쓴다. 크기에 비례해 늘어난다.
        assert_eq!(seconds(Some(0)), TRANSFER_BASE_TIMEOUT_SECONDS);
        assert_eq!(seconds(Some(64 * mib)), TRANSFER_BASE_TIMEOUT_SECONDS + 64);
        assert_eq!(
            seconds(Some(512 * mib)),
            TRANSFER_BASE_TIMEOUT_SECONDS + 512
        );

        // 상한 크기가 천장 안에 들어와야 한다. 상한을 올릴 때 이 단정이 먼저 깨진다.
        let at_cap = seconds(Some(MAX_TRANSFER_BYTES));
        assert!(
            at_cap < MAX_TRANSFER_TIMEOUT_SECONDS,
            "상한 {MAX_TRANSFER_BYTES}바이트가 천장 {MAX_TRANSFER_TIMEOUT_SECONDS}초를 넘어섭니다({at_cap}초). 상한을 낮추거나 천장을 올리세요"
        );
        // 어떤 크기도 천장을 넘지 않는다.
        assert_eq!(seconds(Some(u64::MAX)), MAX_TRANSFER_TIMEOUT_SECONDS);
        // 크기를 모르면 천장을 쓴다. 짧게 끊으면 큰 파일이 이유 없이 실패한다.
        assert_eq!(seconds(None), MAX_TRANSFER_TIMEOUT_SECONDS);

        // 지문 확인은 디스크를 훑는 일이라 전송보다 짧게 잡는다. 멈춘 지문 명령 하나가
        // 전송 천장만큼 매달리면 안 된다.
        assert!(
            digest_timeout(Some(MAX_TRANSFER_BYTES)) < transfer_timeout(Some(MAX_TRANSFER_BYTES))
        );
        assert_eq!(digest_timeout(None).as_secs(), MAX_DIGEST_TIMEOUT_SECONDS);
        assert_eq!(
            digest_timeout(Some(0)).as_secs(),
            TRANSFER_BASE_TIMEOUT_SECONDS
        );
    }

    /// C9-16. 받는 자리의 쓰기 경계는 에이전트가 이미 가진 것과 같다 — C6의 폴더 만들기와
    /// 같은 규칙이다. 상위 폴더를 만들어 주지 않고, `..`를 거절하고, 상위를 정규화한 뒤
    /// 이름을 붙여 심볼릭 링크로 경계를 넘지 못하게 한다.
    #[test]
    fn c9_download_destination_uses_the_same_local_write_boundary_as_the_agent() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        key_fixture(home.path(), true);
        let inbox = home.path().join("inbox");
        fs::create_dir(&inbox).expect("inbox");

        let destination = resolve_local_destination(
            app_data.path(),
            home.path(),
            inbox.join("app.log").to_str().unwrap(),
        )
        .expect("자리");
        assert!(!destination.replaced);
        assert!(destination.path.ends_with("inbox/app.log"));
        // `~/`도 같은 자리로 풀린다.
        assert_eq!(
            resolve_local_destination(app_data.path(), home.path(), "~/inbox/app.log")
                .expect("홈 상대")
                .path,
            destination.path
        );

        // 상위 폴더를 만들어 주지 않는다. 오타 하나로 트리가 생기지 않게 하는 C6 규칙이다.
        let error = resolve_local_destination(
            app_data.path(),
            home.path(),
            inbox.join("missing/app.log").to_str().unwrap(),
        )
        .expect_err("없는 상위");
        assert!(matches!(error, CoreError::NotFound(_)));

        // 상대 경로·상위 이동·제어문자·빈 값은 파일시스템을 보기 전에 걸린다.
        for raw in ["inbox/app.log", "", "~/inbox/../.ssh/id_x", "/x/\u{1}"] {
            assert!(
                resolve_local_destination(app_data.path(), home.path(), raw).is_err(),
                "{raw:?} 는 거절돼야 합니다"
            );
        }

        // 공급자 홈·앱 데이터·자격증명 경로는 올릴 때와 같은 기준으로 거절된다.
        assert!(resolve_local_destination(
            app_data.path(),
            home.path(),
            app_data.path().join("stolen.json").to_str().unwrap()
        )
        .is_err());
        assert!(resolve_local_destination(
            app_data.path(),
            home.path(),
            home.path().join(".ssh/authorized_keys").to_str().unwrap()
        )
        .is_err());

        // 이미 있는 파일은 replaced로 알리고, 폴더와 심볼릭 링크 자리는 거절한다.
        let existing = inbox.join("old.log");
        fs::write(&existing, b"old").expect("existing");
        assert!(
            resolve_local_destination(app_data.path(), home.path(), existing.to_str().unwrap())
                .expect("기존 파일")
                .replaced
        );
        assert!(
            resolve_local_destination(app_data.path(), home.path(), inbox.to_str().unwrap())
                .is_err()
        );
        #[cfg(unix)]
        {
            let link = inbox.join("linked.log");
            std::os::unix::fs::symlink(home.path().join(".ssh/id_example"), &link)
                .expect("symlink");
            assert!(resolve_local_destination(
                app_data.path(),
                home.path(),
                link.to_str().unwrap()
            )
            .is_err());
        }
    }

    /// C9-16. 다운로드는 업로드와 같은 전송 권한·같은 전송 폴더를 쓰고, 받은 파일의 지문을
    /// 원격 지문과 맞춰 본다. 상한을 넘는 파일은 디스크에 쓰기 전에 거절된다.
    #[cfg(unix)]
    #[test]
    fn c9_download_verifies_the_digest_and_refuses_oversized_or_unopened_servers() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        let inbox = home.path().join("inbox");
        fs::create_dir(&inbox).expect("inbox");
        let landed = inbox.join("app.log");

        let mut endpoint = endpoint_request(&fingerprint);
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &endpoint).expect("저장");
        let request = |overwrite: bool| DownloadSshFileRequest {
            fingerprint: fingerprint.clone(),
            remote_path: "logs/app.log".to_owned(),
            local_path: landed.to_string_lossy().into_owned(),
            overwrite,
        };
        // 전송 권한이 꺼진 서버에서는 원격을 건드리지도 않는다.
        let idle = script(bin.path(), "ssh-idle", "exit 1");
        let error = upload_or_download_error(&home, &app_data, &idle, &request(false));
        assert!(error.contains("파일 전송"));

        endpoint.file_transfer_enabled = true;
        endpoint.transfer_root = "/srv/releases".to_owned();
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &endpoint).expect("저장");

        // 원격이 준 내용을 그대로 쓰는 scp 대역과, 그 내용의 지문·크기를 답하는 ssh 대역.
        let payload = "log line\n";
        let digest = {
            let staged = bin.path().join("staged.log");
            fs::write(&staged, payload).expect("staged");
            digest_file(&staged).expect("digest")
        };
        let ssh_ready = script(
            bin.path(),
            "ssh-ready",
            &format!(
                "case \"$*\" in\n  *wc*) echo '{bytes} /srv/releases/logs/app.log' ;;\n  *) echo '{digest}  /srv/releases/logs/app.log' ;;\nesac",
                bytes = payload.len(),
            ),
        );
        let scp_ready = script(
            bin.path(),
            "scp-ready",
            &format!("printf '{payload}' > \"${{@: -1}}\""),
        );
        let receipt = download_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_ready,
            &scp_ready,
            &request(false),
        )
        .expect("다운로드");
        assert!(receipt.succeeded && receipt.verified && !receipt.replaced);
        assert_eq!(receipt.remote_path, "/srv/releases/logs/app.log");
        // 받은 자리는 정규화된 상위 폴더 아래의 경로로 보고된다. 요청 원문과 다를 수 있고,
        // 그 차이가 심볼릭 링크로 경계를 넘지 못하게 하는 검사의 결과다.
        assert_eq!(
            receipt.local_path,
            std::fs::canonicalize(&inbox)
                .expect("정규 경로")
                .join("app.log")
                .to_string_lossy()
        );
        assert_eq!(receipt.bytes, payload.len() as u64);
        assert_eq!(receipt.remote_sha256.as_deref(), Some(digest.as_str()));
        assert_eq!(receipt.sha256.as_deref(), Some(digest.as_str()));
        assert_eq!(fs::read_to_string(&landed).expect("받은 파일"), payload);

        // 같은 자리에 다시 받으려면 사용자가 덮어쓰기를 승인해야 한다.
        let error = download_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_ready,
            &scp_ready,
            &request(false),
        )
        .expect_err("덮어쓰기 거절");
        assert!(error.to_string().contains("overwrite"));
        assert!(
            download_ssh_file_with(
                home.path(),
                app_data.path(),
                &ssh_ready,
                &scp_ready,
                &request(true),
            )
            .expect("덮어쓰기")
            .replaced
        );

        // 상한을 넘는 원격 파일은 디스크에 쓰기 전에 거절된다.
        fs::remove_file(&landed).expect("정리");
        let ssh_huge = script(
            bin.path(),
            "ssh-huge",
            &format!(
                "case \"$*\" in\n  *wc*) echo '{huge} /srv/releases/logs/app.log' ;;\n  *) echo '{digest}  /srv/releases/logs/app.log' ;;\nesac",
                huge = MAX_TRANSFER_BYTES + 1,
            ),
        );
        assert!(matches!(
            download_ssh_file_with(
                home.path(),
                app_data.path(),
                &ssh_huge,
                &scp_ready,
                &request(false)
            ),
            Err(CoreError::TooLarge(_))
        ));
        assert!(!landed.exists());

        // 없는 원격 파일은 전송을 시작하지 않는다.
        let ssh_absent = script(
            bin.path(),
            "ssh-absent-dl",
            "echo 'sha256sum: no such file' >&2\nexit 1",
        );
        assert!(download_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_absent,
            &scp_ready,
            &request(false)
        )
        .is_err());
        assert!(!landed.exists());

        // 실패한 전송이 남긴 새 파일은 지운다. 반쪽짜리를 성공한 결과처럼 두지 않는다.
        let scp_partial = script(
            bin.path(),
            "scp-partial",
            "printf 'half' > \"${@: -1}\"\necho 'Host key verification failed.' >&2\nexit 255",
        );
        let receipt = download_ssh_file_with(
            home.path(),
            app_data.path(),
            &ssh_ready,
            &scp_partial,
            &request(false),
        )
        .expect("전송 실패");
        assert!(!receipt.succeeded && receipt.host_key_rejected && !receipt.verified);
        assert!(receipt.sha256.is_none() && receipt.bytes == 0);
        assert!(!landed.exists(), "실패한 다운로드가 파일을 남겼습니다");
        assert!(receipt.message.contains("known_hosts에 없습니다"));

        // 원격 경로도 전송 폴더 밖으로 나가지 못한다. 이름을 생략할 수도 없다.
        for remote in ["", "   ", "../../etc/passwd", "/etc/passwd"] {
            let mut escaping = request(false);
            escaping.remote_path = remote.to_owned();
            assert!(
                download_ssh_file_with(
                    home.path(),
                    app_data.path(),
                    &ssh_ready,
                    &scp_ready,
                    &escaping
                )
                .is_err(),
                "{remote:?} 는 거절돼야 합니다"
            );
        }
    }

    /// 전송 권한이 꺼진 상태의 실패 문구만 꺼내 본다. 원격은 부르지 않는다.
    #[cfg(unix)]
    fn upload_or_download_error(
        home: &tempfile::TempDir,
        app_data: &tempfile::TempDir,
        executable: &Path,
        request: &DownloadSshFileRequest,
    ) -> String {
        download_ssh_file_with(
            home.path(),
            app_data.path(),
            executable,
            executable,
            request,
        )
        .expect_err("전송 꺼짐")
        .to_string()
    }

    /// 채팅 런타임 없이 승인 흐름을 돌리는 창구. 저장소는 실물이라 토큰 의미(1회 사용·
    /// 네 값 묶임·만료)가 그대로 검증되고, 사용자의 클릭만 테스트가 대신한다.
    #[cfg(unix)]
    struct TestGate {
        store: SshApprovalStore,
        chat_id: &'static str,
        opened: std::sync::Mutex<Vec<String>>,
        /// C9-19. 화면의 응답 경로가 채우는 자리. 에이전트가 닿는 인자로는 들어오지 않는다.
        secrets: crate::ssh_secrets::SshSecretStore,
        /// 마지막으로 열린 카드가 비밀번호를 요구했는지.
        asked_secret: std::sync::Mutex<Option<bool>>,
    }

    #[cfg(unix)]
    impl TestGate {
        fn new() -> Self {
            Self {
                store: SshApprovalStore::new(),
                chat_id: "aia-chat",
                opened: std::sync::Mutex::new(Vec::new()),
                secrets: crate::ssh_secrets::SshSecretStore::new(),
                asked_secret: std::sync::Mutex::new(None),
            }
        }

        /// C9-19. 사용자가 카드의 비밀번호 칸을 채워 허용한 것과 같은 경로.
        fn user_decides_with_secret(&self, approval_id: &str, secret: &str) {
            let decision = self
                .store
                .resolve(self.chat_id, approval_id, true)
                .expect("사용자 결정");
            assert!(decision.needs_secret, "비밀번호를 묻지 않은 카드입니다");
            self.secrets
                .store(self.chat_id, &decision.fingerprint, secret)
                .expect("비밀번호 보관");
        }

        /// 마지막 카드가 비밀번호를 요구했는지.
        fn asked_secret(&self) -> Option<bool> {
            *self.asked_secret.lock().expect("락")
        }

        /// 지금까지 열린 승인 요청 수. 승인 자리에 닿지도 못해야 하는 거부를 확인할 때
        /// 카드가 하나도 안 열렸는지 보는 값이다.
        fn opened_count(&self) -> usize {
            self.opened.lock().expect("락").len()
        }

        /// 사용자가 카드에서 누른 것과 같은 결정. 에이전트가 닿을 수 없는 경로다.
        fn user_decides(&self, approval_id: &str, granted: bool) {
            self.store
                .resolve(self.chat_id, approval_id, granted)
                .expect("사용자 결정");
        }
    }

    #[cfg(unix)]
    impl SshApprovalGate for TestGate {
        fn open_ssh_approval(
            &self,
            request: SshApprovalOpen<'_>,
        ) -> Result<SshApprovalTicket, CoreError> {
            let (ticket, card) = self.store.open(self.chat_id, request)?;
            *self.asked_secret.lock().expect("락") = Some(card.needs_secret);
            let mut opened = self.opened.lock().expect("락");
            // 같은 요청이 같은 카드로 접히는지 보려면 호출 수가 아니라 카드 수를 센다.
            if !opened.contains(&card.id) {
                opened.push(card.id);
            }
            Ok(ticket)
        }

        fn consume_ssh_approval(&self, request: SshApprovalConsume<'_>) -> Result<(), CoreError> {
            self.store.consume(self.chat_id, request).map(|_| ())
        }

        fn holds_sudo_secret(&self, fingerprint: &str) -> bool {
            self.secrets.holds(self.chat_id, fingerprint)
        }

        fn take_sudo_secret(&self, fingerprint: &str) -> Option<zeroize::Zeroizing<String>> {
            self.secrets.peek(self.chat_id, fingerprint)
        }

        fn discard_sudo_secret(&self, fingerprint: &str) {
            self.secrets.discard(self.chat_id, fingerprint);
        }
    }

    #[cfg(unix)]
    fn exec_request(
        fingerprint: &str,
        command: &str,
        approval_id: Option<&str>,
    ) -> ExecuteSshCommandRequest {
        ExecuteSshCommandRequest {
            fingerprint: fingerprint.to_owned(),
            command: command.to_owned(),
            timeout_seconds: None,
            approval_id: approval_id.map(str::to_owned),
            max_lines: None,
        }
    }

    /// C9-19. sudo 비밀번호는 승인 카드로만 들어오고 stdin으로만 나간다.
    ///
    /// 확인하는 것은 다섯이다 — 허용 목록에 **있는** 명령이어도 값이 없으면 카드가 열리고,
    /// 값은 argv에 실리지 않으며, 영수증에 남는 명령은 사용자가 승인한 원본이고, 한 번 받은
    /// 값은 그 대화·그 서버의 다음 sudo 명령에서 다시 묻지 않으며, 비대화형을 스스로 적은
    /// 명령에는 값을 밀어 넣지 않는다.
    #[cfg(unix)]
    #[test]
    fn c9_19_sudo_password_comes_from_the_card_and_leaves_only_through_stdin() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        // 허용 규칙은 토큰이 같아야 맞으므로, 마지막 단계의 `sudo -n …`에는 그 모양의 규칙이
        // 따로 있어야 한다.
        let mut endpoint = endpoint_request(&fingerprint);
        endpoint
            .allowed_commands
            .push("sudo -n systemctl restart".to_owned());
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &endpoint).expect("저장");
        // 받은 argv와 stdin을 각각 남기는 `ssh`. 비밀번호가 어느 쪽으로 갔는지 파일로 가른다.
        let argv = bin.path().join("argv");
        let stdin_seen = bin.path().join("stdin");
        let ssh = script(
            bin.path(),
            "ssh-sudo",
            &format!(
                "echo \"$@\" >> {}\ncat >> {}\necho ok",
                argv.display(),
                stdin_seen.display()
            ),
        );
        let gate = TestGate::new();

        // `sudo systemctl restart`는 이 서버의 허용 목록에 **있다**. 그래도 값을 들고 있지
        // 않으면 카드가 열린다 — 사용자가 비밀번호를 넣을 자리가 그 카드뿐이다.
        let pending = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "sudo systemctl restart app", None),
            Some(&gate),
            None,
        )
        .expect("승인 대기");
        assert!(pending.approval_required && !pending.succeeded);
        assert_eq!(gate.asked_secret(), Some(true));
        assert!(pending
            .reason
            .as_deref()
            .expect("reason")
            .contains("sudo 비밀번호"));
        assert!(!argv.exists(), "승인 전에는 ssh가 불리지 않아야 합니다");
        let approval_id = pending.approval_id.clone().expect("approvalId");

        // 사용자가 카드의 비밀번호 칸을 채워 허용하면 실행된다.
        gate.user_decides_with_secret(&approval_id, "hunter2");
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(
                &fingerprint,
                "sudo systemctl restart app",
                Some(&approval_id),
            ),
            Some(&gate),
            None,
        )
        .expect("실행");
        assert!(receipt.succeeded, "{receipt:?}");
        // 영수증·승인 기록에 남는 것은 사용자가 읽고 허용한 원본이다.
        assert_eq!(receipt.command, "sudo systemctl restart app");
        let seen_argv = std::fs::read_to_string(&argv).expect("argv");
        // 원격에 넘어간 명령에는 `-S`가 붙는다.
        assert!(
            seen_argv.contains("sudo -S systemctl restart app"),
            "argv: {seen_argv}"
        );
        // 값은 어느 인자에도 실리지 않는다.
        assert!(
            !seen_argv.contains("hunter2"),
            "비밀번호가 argv에 실렸습니다: {seen_argv}"
        );
        // 값이 지나간 통로는 stdin 하나다.
        assert_eq!(
            std::fs::read_to_string(&stdin_seen).expect("stdin"),
            "hunter2\n"
        );

        // 한 번 받은 값은 그 대화·그 서버의 다음 sudo 명령에서 다시 묻지 않는다. 허용
        // 목록에 있는 명령이므로 이번에는 카드도 열리지 않고 바로 실행된다.
        let repeat = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "sudo systemctl restart web", None),
            Some(&gate),
            None,
        )
        .expect("두 번째 실행");
        assert!(repeat.succeeded && !repeat.approval_required);
        assert!(repeat.approval_id.is_none());
        assert_eq!(gate.opened_count(), 1, "다시 묻지 않아야 합니다");

        // 비대화형을 스스로 적은 명령에는 값을 밀어 넣지 않는다. 그렇게 적은 호출은
        // "비밀번호 없이 되는가"를 읽으려는 것이다. `-n`은 **sudo 자신의** 옵션 자리에
        // 있어야 한다 — 감싸인 명령 뒤의 `-n`은 그 명령의 플래그다(`sudo_own_options`).
        std::fs::write(&stdin_seen, "").expect("비우기");
        let non_interactive = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "sudo -n systemctl restart api", None),
            Some(&gate),
            None,
        )
        .expect("비대화형 실행");
        assert!(non_interactive.succeeded);
        assert_eq!(
            std::fs::read_to_string(&stdin_seen).expect("stdin"),
            "",
            "-n을 적은 명령에 비밀번호를 밀어 넣었습니다"
        );
    }

    /// C9-19. 원격이 값을 거절하면 들고 있던 것을 버리고, 프롬프트 한 줄은 영수증에서 지운다.
    #[cfg(unix)]
    #[test]
    fn c9_19_a_rejected_password_is_dropped_and_the_prompt_never_reaches_the_receipt() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &endpoint_request(&fingerprint),
        )
        .expect("저장");
        // sudo가 값을 거절했을 때의 실제 모양: 프롬프트가 stderr에 남고 실패로 끝난다.
        let ssh = script(
            bin.path(),
            "ssh-sudo-reject",
            "cat > /dev/null\nprintf '[sudo] password for deploy: Sorry, try again.\\n' >&2\nexit 1",
        );
        let gate = TestGate::new();

        let pending = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "sudo systemctl restart app", None),
            Some(&gate),
            None,
        )
        .expect("승인 대기");
        let approval_id = pending.approval_id.clone().expect("approvalId");
        gate.user_decides_with_secret(&approval_id, "wrong-one");

        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(
                &fingerprint,
                "sudo systemctl restart app",
                Some(&approval_id),
            ),
            Some(&gate),
            None,
        )
        .expect("실행");
        assert!(!receipt.succeeded);
        // 프롬프트는 우리가 붙인 `-S` 때문에 생긴 것이라 영수증에 싣지 않는다.
        assert!(
            !receipt.stderr.contains("[sudo] password for"),
            "stderr: {}",
            receipt.stderr
        );
        assert!(receipt.stderr.contains("Sorry, try again."));
        // 틀린 값은 버린다 — 다음 명령은 다시 카드를 연다.
        assert!(!gate.holds_sudo_secret(&fingerprint));
        let asked_again = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "sudo systemctl restart web", None),
            Some(&gate),
            None,
        )
        .expect("다시 묻기");
        assert!(asked_again.approval_required);
        assert_eq!(gate.opened_count(), 2);
    }

    /// C9-17. 허용 목록 밖 명령은 즉시 거절되지 않고 승인 대기로 돌아온다. 승인 전에는
    /// `ssh`가 한 번도 불리지 않고, 승인 뒤 같은 명령으로 다시 부르면 정확히 한 번 실행된다.
    #[cfg(unix)]
    #[test]
    fn c9_17_out_of_policy_command_waits_for_approval_and_runs_exactly_once() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &endpoint_request(&fingerprint),
        )
        .expect("저장");
        // 실행되면 흔적을 남기는 `ssh`. 승인 전에 아무 일도 없었다는 것을 파일 하나로
        // 확인한다 — "거절됐다"와 "실행하지 않았다"는 다른 주장이다.
        let marker = bin.path().join("ran");
        let ssh = script(
            bin.path(),
            "ssh-marker",
            &format!("echo ran >> {}\necho ok", marker.display()),
        );
        let gate = TestGate::new();

        let pending = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "docker ps -a", None),
            Some(&gate),
            None,
        )
        .expect("승인 대기");
        assert!(pending.approval_required);
        assert!(!pending.succeeded && pending.stdout.is_empty());
        assert!(!marker.exists(), "승인 전에는 ssh가 불리지 않아야 합니다");
        // 사용자가 알아야 하는 값이 모두 실린다: 대상 서버·정확한 명령·위험 설명·만료.
        assert_eq!(pending.destination, "deploy@build.example.com:2222");
        assert_eq!(pending.command, "docker ps -a");
        let approval_id = pending.approval_id.clone().expect("approvalId");
        assert!(pending.expires_at.expect("expiresAt") > crate::clock::now_ms());
        assert!(pending
            .reason
            .as_deref()
            .expect("reason")
            .contains("허용 명령 목록에 없습니다"));
        assert_eq!(gate.opened_count(), 1);

        // 같은 요청을 다시 보내도 카드는 하나다. 승인 대기 중 재호출이 카드를 늘리면
        // 사용자는 같은 결정을 여러 번 눌러야 한다.
        let again = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "docker ps -a", None),
            Some(&gate),
            None,
        )
        .expect("같은 승인 대기");
        assert_eq!(again.approval_id.as_deref(), Some(approval_id.as_str()));
        assert_eq!(gate.opened_count(), 1);

        // 답하지 않은 승인으로는 실행되지 않는다.
        let error = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "docker ps -a", Some(&approval_id)),
            Some(&gate),
            None,
        )
        .expect_err("미승인");
        assert!(error.to_string().contains("아직"));
        assert!(!marker.exists());

        gate.user_decides(&approval_id, true);
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "docker ps -a", Some(&approval_id)),
            Some(&gate),
            None,
        )
        .expect("승인 실행");
        assert!(receipt.succeeded && !receipt.approval_required);
        assert_eq!(receipt.approval_id.as_deref(), Some(approval_id.as_str()));
        assert!(receipt.expires_at.is_none() && receipt.reason.is_none());
        assert!(receipt.stdout.contains("ok"));
        assert_eq!(fs::read_to_string(&marker).expect("marker"), "ran\n");

        // 같은 토큰으로 두 번 실행되지 않는다. 실행은 첫 번째 한 번뿐이다.
        let error = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "docker ps -a", Some(&approval_id)),
            Some(&gate),
            None,
        )
        .expect_err("재사용");
        assert!(error.to_string().contains("이미 한 번 사용"));
        assert_eq!(fs::read_to_string(&marker).expect("marker"), "ran\n");
    }

    /// C9-17. 거절과 만료는 실행으로 이어지지 않는다.
    #[cfg(unix)]
    #[test]
    fn c9_17_declined_and_expired_approvals_do_not_execute() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &endpoint_request(&fingerprint),
        )
        .expect("저장");
        let marker = bin.path().join("ran");
        let ssh = script(
            bin.path(),
            "ssh-marker",
            &format!("echo ran >> {}", marker.display()),
        );
        let gate = TestGate::new();
        let run = |command: &str, approval: Option<&str>| {
            execute_ssh_command_with(
                home.path(),
                app_data.path(),
                &ssh,
                &exec_request(&fingerprint, command, approval),
                Some(&gate),
                None,
            )
        };

        let declined = run("docker ps", None).expect("승인 대기");
        let declined_id = declined.approval_id.expect("approvalId");
        gate.user_decides(&declined_id, false);
        let error = run("docker ps", Some(&declined_id)).expect_err("거절");
        assert!(error.to_string().contains("거절"));

        let expiring = run("docker images", None).expect("승인 대기");
        let expiring_id = expiring.approval_id.expect("approvalId");
        gate.user_decides(&expiring_id, true);
        // 승인은 짧게 만료된다. 시계를 되감을 수 없으므로 저장본을 직접 늙힌다.
        gate.store.expire_for_test(&expiring_id);
        let error = run("docker images", Some(&expiring_id)).expect_err("만료");
        assert!(error.to_string().contains("만료"));
        assert!(!marker.exists(), "어느 경로에서도 실행되지 않아야 합니다");
    }

    /// C9-17. 승인은 그 명령 문자열과 그 서버에만 유효하다. 승인 뒤 명령을 늘리거나
    /// 다른 지문에 같은 토큰을 쓰는 것은 실행 경로에서 거절된다.
    #[cfg(unix)]
    #[test]
    fn c9_17_granted_approval_cannot_be_retargeted_or_extended() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let first = key_fixture(home.path(), true);
        let second = extra_key_fixture(home.path(), "id_second", 7);
        assert_ne!(first, second);
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &endpoint_request(&first))
            .expect("저장");
        let mut other = endpoint_request(&second);
        other.host = "stage.example.com".to_owned();
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &other).expect("저장");

        let marker = bin.path().join("ran");
        let ssh = script(
            bin.path(),
            "ssh-marker",
            &format!("echo ran >> {}", marker.display()),
        );
        let gate = TestGate::new();
        let run = |fingerprint: &str, command: &str, approval: Option<&str>| {
            execute_ssh_command_with(
                home.path(),
                app_data.path(),
                &ssh,
                &exec_request(fingerprint, command, approval),
                Some(&gate),
                None,
            )
        };

        let pending = run(&first, "docker ps", None).expect("승인 대기");
        let approval_id = pending.approval_id.expect("approvalId");
        gate.user_decides(&approval_id, true);

        // 승인 뒤 인자를 덧붙이거나 명령을 바꾸면 다른 명령이다.
        for tampered in ["docker ps -a", "docker", "docker ps --format json"] {
            let error = run(&first, tampered, Some(&approval_id)).expect_err(tampered);
            assert!(
                error.to_string().contains("승인받은 명령과 다릅니다"),
                "{tampered}: {error}"
            );
        }
        // 다른 연결 서버에 같은 토큰을 쓸 수 없다.
        let error = run(&second, "docker ps", Some(&approval_id)).expect_err("다른 서버");
        assert!(error.to_string().contains("다른 연결 서버"));
        assert!(!marker.exists());

        // 승인받은 그 한 줄, 그 서버에서만 실행된다.
        assert!(
            run(&first, "docker ps", Some(&approval_id))
                .expect("승인 실행")
                .succeeded
        );
    }

    /// C9-17. 승인이 넘기지 못하는 자리. 셸·인터프리터 앞머리, 그 서버의 차단 목록,
    /// 셸 메타문자, 에이전트 사용 토글은 승인 자리에 닿기도 전에 거절되고 카드도 열리지
    /// 않는다. 호스트 키 실패·시간 초과는 승인해도 그대로 실패한다.
    #[cfg(unix)]
    #[test]
    fn c9_17_approval_never_bypasses_hard_refusals_or_the_agent_toggle() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        let mut endpoint = endpoint_request(&fingerprint);
        // 사용자가 셸·인터프리터·삭제까지 허용해 둔 최악의 목록에서도 결과는 같아야 한다.
        endpoint.allowed_commands = vec!["bash".to_owned(), "curl".to_owned(), "ls".to_owned()];
        endpoint.denied_commands = vec!["rm -rf".to_owned()];
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &endpoint).expect("저장");
        let missing = bin.path().join("does-not-exist");
        let gate = TestGate::new();
        let refuse = |command: &str| {
            execute_ssh_command_with(
                home.path(),
                app_data.path(),
                &missing,
                &exec_request(&fingerprint, command, None),
                Some(&gate),
                None,
            )
            .expect_err(command)
        };

        for command in [
            // 셸·인터프리터·네트워크 페치 앞머리(허용 목록에 적혀 있어도)
            "bash /tmp/install.sh",
            "curl https://example.com/x",
            "sudo bash -c whoami",
            // 그 서버의 차단 명령
            "rm -rf /srv/old",
            // 명령을 잇거나 새로 만드는 문법
            "ls; rm -rf /",
            "ls && whoami",
            "ls `id`",
            // C9-20. 파이프라인의 중간 단계도 같은 자리를 지난다. 앞머리만 보면 이 두 줄이
            // `ls`·`tail` 규칙만으로 지나가, 파이프를 여는 순간 목록이 다시 장식이 된다.
            "ls | xargs rm",
            "tail -n 5 /var/log/app.log | rm -rf /srv",
            // 파일을 만드는 리다이렉션은 목록이 판정할 수 없는 자리라 이 서버에서는 닫혀 있다.
            "ls > /tmp/out",
        ] {
            let error = refuse(command);
            assert!(
                matches!(error, CoreError::Conflict(_) | CoreError::InvalidInput(_)),
                "{command}: {error}"
            );
        }
        // 승인 카드는 한 장도 열리지 않았다 — 승인으로 우회할 수 있다고 사용자에게
        // 물어보는 것 자체가 이 자리에서는 잘못된 제안이다.
        assert_eq!(gate.opened_count(), 0);

        // 에이전트 사용이 꺼진 서버는 승인 자리에 닿지 않는다.
        let mut disabled = endpoint_request(&fingerprint);
        disabled.agent_enabled = false;
        set_ssh_key_endpoint_for_test(home.path(), app_data.path(), &disabled).expect("저장");
        let error = refuse("docker ps");
        assert!(error.to_string().contains("에이전트 사용이 꺼져"));
        assert_eq!(gate.opened_count(), 0);

        // 승인을 받아도 호스트 키 검증 실패와 시간 초과는 그대로 실패로 보고된다.
        set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &endpoint_request(&fingerprint),
        )
        .expect("저장");
        let host_key = script(
            bin.path(),
            "ssh-hostkey",
            "echo 'Host key verification failed.' >&2\nexit 255",
        );
        let pending = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &host_key,
            &exec_request(&fingerprint, "docker ps", None),
            Some(&gate),
            None,
        )
        .expect("승인 대기");
        let approval_id = pending.approval_id.expect("approvalId");
        gate.user_decides(&approval_id, true);
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &host_key,
            &exec_request(&fingerprint, "docker ps", Some(&approval_id)),
            Some(&gate),
            None,
        )
        .expect("실행 시도");
        assert!(!receipt.succeeded && receipt.host_key_rejected && !receipt.approval_required);
        // 실패했어도 토큰은 돌아오지 않는다. 실패 이유는 다시 시도할 허락과 다르다.
        assert!(execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &host_key,
            &exec_request(&fingerprint, "docker ps", Some(&approval_id)),
            Some(&gate),
            None,
        )
        .is_err());
    }

    /// C9-17. 대화가 없는 호출 경로(워크플로 단계 등)에서는 승인을 열 수 없으므로 목록
    /// 밖 명령이 예전처럼 즉시 거절된다. 이미 허용된 명령은 승인 없이 그대로 실행된다.
    #[cfg(unix)]
    #[test]
    fn c9_17_without_a_conversation_the_allow_list_is_the_only_answer() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &endpoint_request(&fingerprint),
        )
        .expect("저장");
        let ssh = script(bin.path(), "ssh-ok", "echo ok");

        let error = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "docker ps", None),
            None,
            None,
        )
        .expect_err("대화 없음");
        assert!(error.to_string().contains("승인을 받을 대화가 없어"));

        // 허용 목록에 있는 명령은 창구가 없어도, 엉뚱한 토큰이 실려 와도 그대로 실행된다.
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "ls /srv", Some("ssh-approval-bogus")),
            None,
            None,
        )
        .expect("허용된 명령");
        assert!(receipt.succeeded && !receipt.approval_required);
        // 쓰지 않은 토큰은 응답에 실리지 않는다 — 소모하지 않았다는 뜻이다.
        assert!(receipt.approval_id.is_none());
    }

    /// C9-17. 허용 목록 영구 추가는 별도 요청·별도 승인이다. 1회 실행 승인과 서로 쓸 수
    /// 없고, 추가되기 전에는 목록이 바뀌지 않으며, 추가된 뒤에는 승인 없이 실행된다.
    #[cfg(unix)]
    #[test]
    fn c9_17_permanent_allowlist_addition_is_a_separate_request_and_approval() {
        let home = tempfile::tempdir().expect("home");
        let app_data = tempfile::tempdir().expect("app data");
        let bin = tempfile::tempdir().expect("bin");
        let fingerprint = key_fixture(home.path(), true);
        set_ssh_key_endpoint_for_test(
            home.path(),
            app_data.path(),
            &endpoint_request(&fingerprint),
        )
        .expect("저장");
        let ssh = script(bin.path(), "ssh-ok", "echo ok");
        let gate = TestGate::new();
        let persist = |command: &str, approval: Option<&str>| {
            allow_ssh_command_permanently_with(
                home.path(),
                app_data.path(),
                &AllowSshCommandRequest {
                    fingerprint: fingerprint.clone(),
                    command: command.to_owned(),
                    approval_id: approval.map(str::to_owned),
                },
                Some(&gate),
            )
        };

        // 1회 실행 승인을 받아 둔다. 이 토큰으로는 목록을 바꿀 수 없어야 한다.
        let pending_exec = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "docker ps", None),
            Some(&gate),
            None,
        )
        .expect("실행 승인 대기");
        let exec_approval = pending_exec.approval_id.expect("approvalId");
        gate.user_decides(&exec_approval, true);
        let error = persist("docker ps", Some(&exec_approval)).expect_err("용도 교차");
        assert!(error.to_string().contains("용도"));

        // 목록 추가는 자기 승인 카드를 따로 받는다. 그 사이 목록은 그대로다.
        let requested = persist("docker ps", None).expect("추가 승인 대기");
        assert!(requested.approval_required && !requested.added);
        assert!(!requested
            .allowed_commands
            .iter()
            .any(|rule| rule == "docker ps"));
        assert!(requested.expires_at.expect("expiresAt") > crate::clock::now_ms());
        assert!(requested
            .reason
            .as_deref()
            .expect("reason")
            .contains("영구히"));
        let persist_approval = requested.approval_id.expect("approvalId");
        assert_ne!(persist_approval, exec_approval);

        // 목록 추가 승인으로는 명령을 실행할 수 없다.
        let error = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "docker ps", Some(&persist_approval)),
            Some(&gate),
            None,
        )
        .expect_err("용도 교차");
        assert!(error.to_string().contains("용도"));

        // 사용자가 답하지 않은 상태에서는 목록이 바뀌지 않는다.
        assert!(persist("docker ps", Some(&persist_approval)).is_err());
        gate.user_decides(&persist_approval, true);
        let added = persist("docker ps", Some(&persist_approval)).expect("추가");
        assert!(added.added && !added.approval_required);
        assert!(added
            .allowed_commands
            .iter()
            .any(|rule| rule == "docker ps"));
        // 추가 승인도 1회용이다.
        assert!(persist("docker ps", Some(&persist_approval)).is_err());

        // 목록에 들어간 뒤에는 승인 없이 실행된다.
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "docker ps --all", None),
            Some(&gate),
            None,
        )
        .expect("허용된 명령");
        assert!(receipt.succeeded && !receipt.approval_required);

        // 셸 앞머리·차단 명령은 목록에도 넣지 않는다. 승인 카드조차 열리지 않는다.
        let before = gate.opened_count();
        for command in ["bash /tmp/x.sh", "rm -rf /srv", "ls; whoami"] {
            assert!(persist(command, None).is_err(), "{command}");
        }
        assert_eq!(gate.opened_count(), before);

        // C9-20. 파이프라인은 단계마다 한 줄씩 적힌다. 줄 전체를 한 규칙으로 적으면 어느
        // 단계와도 맞지 않아, 사용자는 허용했다고 읽지만 다음 실행도 똑같이 승인을 묻는다.
        let piped = persist("docker logs app | tail -n 50", None).expect("파이프라인 승인 대기");
        let piped_approval = piped.approval_id.expect("approvalId");
        gate.user_decides(&piped_approval, true);
        let added = persist("docker logs app | tail -n 50", Some(&piped_approval)).expect("추가");
        assert!(added.added);
        for rule in ["docker logs app", "tail -n 50"] {
            assert!(
                added.allowed_commands.iter().any(|value| value == rule),
                "{rule}: {:?}",
                added.allowed_commands
            );
        }
        let receipt = execute_ssh_command_with(
            home.path(),
            app_data.path(),
            &ssh,
            &exec_request(&fingerprint, "docker logs app | tail -n 50", None),
            Some(&gate),
            None,
        )
        .expect("허용된 파이프라인");
        assert!(receipt.succeeded && !receipt.approval_required);
    }
}
