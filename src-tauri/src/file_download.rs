//! 문서 파일을 웹뷰를 거치지 않고 저장하는 갈래.
//!
//! 기본 내려받기 경로(`save_downloaded_linked_file`)는 백엔드가 파일 전체를 읽어
//! HTTP로 내려주고, 웹뷰가 그것을 Blob과 ArrayBuffer로 한 번씩 더 들고, 그 바이트가
//! 다시 IPC로 넘어온다. 한 파일에 사본이 네 벌 생기므로 100MB가 상한이었다.
//!
//! 여기서는 바이트가 아니라 **자리**만 넘긴다. 프런트는 저장 대화상자가 고른 경로만
//! 보내고, 원본 경로 해석부터 목적지 쓰기까지는 Rust Core가 조각 단위로 이어 붙인다.
//! 그래서 파일 크기와 무관하게 상주 메모리는 한 조각뿐이고, 상한도 필요 없다.
//!
//! 이 갈래가 데스크톱 셸 전용인 이유는 두 가지다. 브라우저 UI에는 저장 대화상자가
//! 없어 목적지 경로 자체가 없고, 원격 UI에서 호스트의 임의 경로에 쓰는 일은 `G11`이
//! 막는다. 요청이 Tauri 명령으로만 들어오므로 원격에는 애초에 노출되지 않는다.

use std::collections::HashMap;
use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use agent_manager_core::{
    copy_linked_file_source, read_doc_linked_file_source, read_document_file_source,
    LinkedFileSource,
};
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Manager};

/// 진행률을 올려 보내는 최소 간격. 조각마다 그대로 보내면 수 GB 복사가 수천 개의
/// IPC 메시지가 되고, 그리는 쪽이 더 바빠진다. 마지막 보고만 간격과 무관하게 보낸다.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDownloadRequest {
    /// 취소 요청이 이 실행을 찾는 이름. 프런트가 만든다.
    download_id: String,
    root_id: String,
    /// 문서 루트 기준 상대 경로. `href`가 있으면 링크가 적힌 문서의 경로다.
    relative_path: String,
    /// 문서 안 링크를 내려받을 때만 있다.
    href: Option<String>,
    destination: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDownloadProgress {
    copied_bytes: u64,
    total_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentDownloadResult {
    /// 취소로 끝났으면 false. 취소는 실패가 아니므로 오류로 올리지 않는다.
    saved: bool,
    copied_bytes: u64,
}

/// 등록된 문서 루트 안의 파일 하나를 사용자가 고른 경로로 이어 복사한다.
#[tauri::command]
pub async fn save_document_file_to_path(
    app: AppHandle,
    request: DocumentDownloadRequest,
    progress: Channel<DocumentDownloadProgress>,
) -> Result<DocumentDownloadResult, String> {
    let app_data_dir = app.path().app_data_dir().map_err(error_message)?;
    // 복사는 파일 크기만큼 오래 걸린다. 명령 스레드에서 그대로 돌리면 그동안 다른
    // 명령이 뒤에 밀리므로 블로킹 풀로 내보낸다.
    tauri::async_runtime::spawn_blocking(move || {
        copy_document_file(&app_data_dir, request, progress)
    })
    .await
    .map_err(|_| "파일 저장 작업이 중단되었습니다".to_owned())?
}

/// 진행 중인 저장 하나를 멈춘다. 이미 끝났거나 없는 이름은 멈출 것이 없으므로
/// 조용히 지나간다 — 사용자가 완료 직전에 누른 취소를 오류로 돌려줄 이유가 없다.
#[tauri::command]
pub fn cancel_document_file_download(download_id: String) {
    if let Some(flag) = lock_active_downloads().get(&download_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

fn copy_document_file(
    app_data_dir: &Path,
    request: DocumentDownloadRequest,
    progress: Channel<DocumentDownloadProgress>,
) -> Result<DocumentDownloadResult, String> {
    let destination = PathBuf::from(&request.destination);
    if !destination.is_absolute() {
        return Err("파일 저장 경로는 절대 경로여야 합니다".to_owned());
    }
    let source = resolve_source(app_data_dir, &request)?;
    let total_bytes = source.size_bytes;
    let active = ActiveDownload::register(request.download_id);

    let mut reported_at: Option<Instant> = None;
    let mut report = |copied_bytes: u64| {
        let now = Instant::now();
        if reported_at.is_some_and(|last| now.duration_since(last) < PROGRESS_INTERVAL) {
            return;
        }
        reported_at = Some(now);
        send_progress(&progress, copied_bytes, total_bytes);
    };
    let cancelled = || active.cancelled();
    let copy = copy_linked_file_source(&source, &destination, &mut report, &cancelled)
        .map_err(error_message)?;
    if !copy.cancelled {
        send_progress(&progress, copy.copied_bytes, total_bytes);
    }
    Ok(DocumentDownloadResult {
        saved: !copy.cancelled,
        copied_bytes: copy.copied_bytes,
    })
}

fn send_progress(
    progress: &Channel<DocumentDownloadProgress>,
    copied_bytes: u64,
    total_bytes: u64,
) {
    let _ = progress.send(DocumentDownloadProgress {
        copied_bytes,
        total_bytes,
    });
}

/// 문서 자체와 문서 안 링크는 경로 해석 규칙이 다르다. 두 갈래 모두 Core가 루트
/// 경계를 확인하므로 여기서는 어느 쪽인지만 고른다.
fn resolve_source(
    app_data_dir: &Path,
    request: &DocumentDownloadRequest,
) -> Result<LinkedFileSource, String> {
    match request.href.as_deref() {
        Some(href) => read_doc_linked_file_source(
            app_data_dir,
            &request.root_id,
            &request.relative_path,
            href,
        ),
        None => read_document_file_source(app_data_dir, &request.root_id, &request.relative_path),
    }
    .map_err(error_message)
}

/// 살아 있는 저장 하나. 등록은 실행이 하고, 해제는 끝나는 자리가 아니라 `Drop`이
/// 한다 — 오류로 빠져나가는 갈래가 여럿이라 한 곳이라도 빠뜨리면 이름이 남는다.
struct ActiveDownload {
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl ActiveDownload {
    fn register(id: String) -> Self {
        let cancelled = Arc::new(AtomicBool::new(false));
        lock_active_downloads().insert(id.clone(), cancelled.clone());
        Self { id, cancelled }
    }

    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

impl Drop for ActiveDownload {
    fn drop(&mut self) {
        lock_active_downloads().remove(&self.id);
    }
}

type ActiveDownloads = HashMap<String, Arc<AtomicBool>>;

fn lock_active_downloads() -> std::sync::MutexGuard<'static, ActiveDownloads> {
    static REGISTRY: OnceLock<Mutex<ActiveDownloads>> = OnceLock::new();
    REGISTRY
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn error_message(error: impl Display) -> String {
    error.to_string()
}
