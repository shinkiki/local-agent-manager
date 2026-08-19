use std::convert::Infallible;
use std::future::Future;
use std::net::{Ipv4Addr, TcpListener as StdTcpListener};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::{Body, Incoming};
use hyper::header::{HeaderValue, CONTENT_TYPE, HOST};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::mcp_registry::{
    McpInterfaceCallRequest, McpInterfaceIdRequest, McpInterfaceProbeRequest,
    McpInterfaceRegisterRequest, McpInterfaceRegistry,
};
use crate::remote::{invoke_system_command, ServiceEndpoint, SystemCommandContext};
use crate::{
    ChatSupervisor, CoreError, SchedulerSupervisor, SessionCatalog, TerminalSupervisor,
    TranslationSupervisor,
};

const MAX_MCP_REQUEST_BODY: usize = 1024 * 1024;
const MAX_MCP_RESULT_BYTES: usize = 512 * 1024;

#[derive(Clone, Copy, PartialEq, Eq)]
enum CapabilityAccess {
    Read,
    Execute,
}

struct SystemCapability {
    operation: &'static str,
    access: CapabilityAccess,
    arguments_json: &'static str,
    description: &'static str,
}

macro_rules! capability {
    ($access:ident, $operation:literal, $arguments:tt, $description:literal) => {
        SystemCapability {
            operation: $operation,
            access: CapabilityAccess::$access,
            arguments_json: stringify!($arguments),
            description: $description,
        }
    };
}

const SYSTEM_CAPABILITIES: &[SystemCapability] = &[
    capability!(
        Read,
        "get_app_status",
        {},
        "플랫폼과 공급자 CLI 및 이력 탐지 상태"
    ),
    capability!(
        Read,
        "get_provider_accounts",
        {},
        "공급자 계정 목록과 사용량, 기본·활성 계정 상태"
    ),
    capability!(Read, "refresh_provider_account_usage", {"accountId":"ACCOUNT_ID"}, "계정 사용량을 공급자에서 다시 조회"),
    capability!(Read, "get_chat_provider_options", {"source":"codex"}, "공급자 모델·추론 옵션과 실행설정 항목 스키마(settings)"),
    capability!(Read, "get_detached_chat_for_session", {"request":{"source":"codex","id":"SESSION_ID"}}, "분리된 라이브 채팅 조회"),
    capability!(Read, "get_live_chats", {"profile":"standard"}, "실행 중 라이브 채팅 목록. profile은 standard 또는 aia"),
    capability!(Read, "list_sessions", {"request":{"source":"codex","cwd":null,"from":null,"to":null,"status":null,"search":null,"sort":"updatedAt","direction":"desc","cursor":null,"limit":50}}, "세션 요약 목록. 공급자·프로젝트·기간·상태·검색 필터와 커서 페이지를 지원"),
    capability!(Read, "get_session_statistics", {"request":{"source":null,"cwd":null,"from":null,"to":null}}, "기간·공급자·프로젝트별 세션과 턴 및 완료·실패·중단 통계"),
    capability!(Read, "get_chat_delivery_status", {"idempotencyKey":"UNIQUE_KEY"}, "멱등 키로 채팅 전송·생성의 저장된 전달 결과를 다시 조회"),
    capability!(
        Read,
        "get_chat_attention_snapshot",
        {},
        "진행, 승인, 완료 알림"
    ),
    capability!(
        Read,
        "get_manager_snapshot",
        {},
        "대시보드, 세션, 스킬, 에이전트, 산출물 전체 스냅샷. 결과가 크면 더 좁은 작업을 사용"
    ),
    capability!(
        Read,
        "get_system_automation_snapshot",
        {},
        "언어, 번역, 시스템 공급자 설정과 상태"
    ),
    capability!(Read, "get_menu_translations", {"menu":"skills"}, "skills, agents, artifacts 번역 목록"),
    capability!(Read, "get_translated_detail", {"menu":"skills","resourceId":"RESOURCE_ID"}, "번역 상세"),
    capability!(
        Read,
        "reconcile_session_catalog",
        {},
        "세션 카탈로그 증분 동기화"
    ),
    capability!(Read, "refresh_session_catalog", {"request":{"source":"codex","id":"SESSION_ID"}}, "단일 세션 카탈로그 갱신"),
    capability!(Read, "get_storage_overview", {}, "저장소 사용량"),
    capability!(Read, "get_session_detail", {"request":{"source":"codex","id":"SESSION_ID","pageSize":50,"cursor":null,"from":null,"to":null,"turnStart":null,"turnEnd":null}}, "세션 상세와 구조화된 최신 대화 페이지. pageSize 등 페이지 인자를 생략하면 기존 transcriptLimit 응답을 유지"),
    capability!(Read, "get_session_linked_file", {"request":{"source":"codex","id":"SESSION_ID","href":"FILE_LINK"}}, "세션에 연결된 안전한 파일 미리보기"),
    capability!(Read, "get_chat_linked_file", {"request":{"chatId":"CHAT_ID","href":"FILE_LINK"}}, "라이브 채팅 연결 파일 미리보기"),
    capability!(Read, "get_session_folders", {}, "세션 폴더 목록"),
    capability!(Read, "get_skill_detail", {"id":"SKILL_ID"}, "스킬 상세"),
    capability!(Read, "get_agent_detail", {"name":"AGENT_NAME"}, "에이전트 정의 상세"),
    capability!(Read, "get_artifact_detail", {"request":{"conversationId":"ID","rootName":"ROOT","name":"NAME"}}, "산출물 상세"),
    capability!(Read, "get_doc_roots", {}, "문서 루트 목록"),
    capability!(Read, "get_doc_tree", {"rootId":"ROOT_ID"}, "문서 트리"),
    capability!(Read, "get_doc", {"request":{"rootId":"ROOT_ID","relativePath":"PATH"}}, "문서 읽기"),
    capability!(Read, "get_doc_linked_file", {"request":{"rootId":"ROOT_ID","currentPath":"PATH","href":"FILE_LINK"}}, "문서 연결 파일 미리보기"),
    capability!(Read, "get_scheduler_snapshot", {}, "반복 요청과 실행 이력"),
    capability!(Read, "list_scheduled_requests", {"request":{"id":null,"source":null,"cwd":null,"accountId":null,"enabled":null,"from":null,"to":null,"search":null,"cursor":null,"limit":50}}, "프롬프트를 제외한 반복 요청 요약 목록. 기간은 nextRunAt 기준"),
    capability!(Read, "get_scheduled_request_detail", {"id":"SCHEDULE_ID"}, "프롬프트를 포함한 단일 반복 요청 상세"),
    capability!(Read, "list_scheduled_runs", {"request":{"id":null,"scheduleId":null,"status":null,"from":null,"to":null,"cursor":null,"limit":50}}, "결과 본문을 제외한 반복 요청 실행 이력 요약 목록"),
    capability!(Read, "get_scheduled_run_detail", {"id":"RUN_ID"}, "요약과 오류를 포함한 단일 실행 이력 상세"),
    capability!(Read, "list_system_audit", {"request":{"operation":null,"success":null,"from":null,"to":null,"cursor":null,"limit":50}}, "AIA 시스템 변경 시도와 완료 감사 이력. 원문 인자 대신 SHA-256만 포함"),
    capability!(Execute, "patch_session_meta", {"request":{"source":"codex","id":"SESSION_ID","patch":{"favorite":true}}}, "세션 메타데이터 변경"),
    capability!(Execute, "create_session_folder", {"request":{"name":"NAME","color":"#HEX"}}, "세션 폴더 생성"),
    capability!(Execute, "update_session_folder", {"request":{"id":"ID","name":"NAME","color":"#HEX"}}, "세션 폴더 변경"),
    capability!(Execute, "delete_session_folder", {"id":"ID"}, "세션 폴더 삭제"),
    capability!(Execute, "create_doc_root", {"request":{"name":"NAME","path":"ABSOLUTE_PATH"}}, "문서 루트 추가"),
    capability!(Execute, "delete_doc_root", {"id":"ID"}, "문서 루트 제거"),
    capability!(Execute, "put_doc", {"request":{"rootId":"ROOT_ID","relativePath":"PATH","content":"CONTENT","expectedModifiedAt":null}}, "문서 저장"),
    capability!(Execute, "create_scheduled_request", {"request":"ScheduledRequestInput"}, "반복 요청 생성"),
    capability!(Execute, "update_scheduled_request", {"request":{"id":"ID","input":"ScheduledRequestInput"}}, "반복 요청 변경"),
    capability!(Execute, "delete_scheduled_request", {"id":"ID"}, "반복 요청 삭제"),
    capability!(Execute, "set_schedule_enabled", {"request":{"id":"ID","enabled":true}}, "반복 요청 활성화 변경"),
    capability!(Execute, "run_scheduled_request_now", {"id":"ID"}, "반복 요청 즉시 실행"),
    capability!(Execute, "cancel_scheduled_run", {"runId":"RUN_ID","reason":"운영자 취소 사유"}, "run ID 소유권을 검증해 실행 중 반복 요청을 취소하거나 고아 run을 terminal 처리"),
    capability!(Execute, "recover_provider_transition", {"provider":"claude","runId":"RUN_ID","transitionId":"TRANSITION_ID"}, "terminal run과 정확히 일치하는 고아 계정 전환 lease만 이전 활성 계정으로 복구"),
    capability!(Execute, "cancel_and_recover_scheduled_run", {"request":{"provider":"claude","runId":"RUN_ID","transitionId":"TRANSITION_ID"},"reason":"운영자 취소 사유"}, "반복 실행 취소 후 계정 전환 복구를 순서대로 수행하고 부분 실패를 반환"),
    capability!(Execute, "set_schedules_paused", {"paused":true}, "전체 반복 요청 일시정지 또는 재개"),
    capability!(Execute, "set_system_automation_settings", {"request":"SystemAutomationSettingsInput"}, "시스템 언어, 공급자, 자동 번역 설정 변경"),
    capability!(Execute, "request_system_language", {"request":"SystemLanguageRequest"}, "시스템 언어 전환 요청"),
    capability!(Execute, "retry_ui_translation", {}, "UI 번역 재시도"),
    capability!(Execute, "cancel_ui_translation", {}, "UI 번역 취소"),
    capability!(Execute, "retry_menu_translation", {"menu":"skills"}, "메뉴 번역 재시도"),
    capability!(Execute, "reset_menu_translation", {"menu":"skills"}, "메뉴 번역 초기화. 저장된 번역을 지우고 처음부터 다시 번역"),
    capability!(Execute, "mark_chat_attention_read", {"id":"ID"}, "채팅 알림 읽음 처리"),
    capability!(
        Execute,
        "mark_all_chat_attention_read",
        {},
        "종료 알림 모두 읽음 처리"
    ),
    capability!(
        Execute,
        "clear_read_chat_attention",
        {},
        "읽은 종료 알림 정리"
    ),
    capability!(
        Execute,
        "dismiss_chat_attention",
        {"id":"ID"},
        "채팅 알림 개별 삭제. 승인 대기 알림은 삭제 불가"
    ),
    // 공급자 계정 로그인 추가·재인증(begin/finish/cancel_provider_account_login)은
    // 대화형 터미널과 브라우저 인증이 필요해 AIA 시스템 인터페이스로 노출하지 않는다.
    capability!(Execute, "register_current_provider_account", {"source":"codex","displayName":null}, "현재 CLI 인증 계정을 관리 계정으로 등록"),
    capability!(Execute, "set_default_provider_account", {"accountId":"ACCOUNT_ID"}, "공급자 기본 계정 지정"),
    capability!(Execute, "set_active_provider_account", {"accountId":"ACCOUNT_ID"}, "관리 채팅·터미널과 외부 공급자 CLI를 종료·검증한 뒤 활성 인증 계정 전환"),
    capability!(Execute, "set_provider_account_disabled", {"accountId":"ACCOUNT_ID","disabled":true}, "계정 사용 중지 또는 재개"),
    capability!(Execute, "set_provider_account_auto_switch", {"accountId":"ACCOUNT_ID","autoSwitch":true}, "사용량 한도 도달 시 자동전환 순환 대상으로 지정 또는 해제"),
    capability!(Execute, "set_auto_switch_resume", {"enabled":true}, "자동전환으로 종료된 실행 중 채팅을 새 계정에서 resume으로 재시작할지 설정"),
    capability!(Execute, "delete_provider_account", {"accountId":"ACCOUNT_ID"}, "관리 계정 등록 삭제"),
    capability!(Execute, "propose_chat_settings_schema", {"source":"claude","fields":[{"key":"mode","label":"실행 모드","detail":"권한 범위","kind":"enum","options":[{"value":"plan","label":"읽기 전용","detail":"분석·계획만"}],"defaultValue":"plan"}]}, "CLI 인터페이스 조사 결과로 실행설정 스키마 갱신. 내장 항목은 선택지 재구성만, 새 항목은 화이트리스트 내에서만 허용. fields를 빈 배열로 주면 오버라이드 제거"),
    capability!(Execute, "send_chat_message", {"request":{"chatId":"CHAT_ID","message":"MESSAGE","idempotencyKey":"UNIQUE_KEY","queueIfRunning":false}}, "기존 채팅에 메시지 전달. ready 상태는 즉시 시작하고 실행 중에는 queueIfRunning=true일 때만 대기열에 추가"),
    capability!(Execute, "start_chat", {"request":{"chat":{"source":"codex","accountId":null,"cwd":"ABSOLUTE_PROJECT_PATH","model":null,"reasoningEffort":null,"mode":"workspace","approvalMode":"manual","resumeSessionId":null,"unattended":false,"profile":"standard","settings":{}},"message":"MESSAGE","idempotencyKey":"UNIQUE_KEY"}}, "새 채팅을 시작하고 첫 메시지 전달을 확인한 뒤 런타임을 분리 상태로 유지"),
    capability!(Execute, "detach_chat", {"chatId":"CHAT_ID"}, "채팅 화면 연결만 분리하고 공급자 런타임은 유지"),
    capability!(Execute, "stop_chat", {"chatId":"CHAT_ID"}, "채팅 프로세스를 종료하고 대기열·승인·계정 lease를 정리. 이미 종료된 채팅은 alreadyStopped=true를 반환"),
    capability!(Execute, "stop_provider_chats", {"provider":"claude","reason":null}, "해당 공급자의 Agent Manager 관리 런타임을 프로필·연결 여부와 무관하게 모두 종료. 정상 종료가 실패하면 SIGKILL 강제 종료로 승격(forcedCount로 보고)하고, 강제 종료까지 실패한 항목만 실패 chatId와 원인을 반환. 외부 독립 실행 프로세스는 terminate_external_provider_processes로 별도 종료"),
    capability!(Execute, "stop_provider_terminals", {"provider":"claude","reason":null}, "해당 공급자의 일반·설정·계정 로그인 관리 터미널을 SIGTERM으로 종료하고 유예 시간 이후 PID 기반 SIGKILL로 승격. 종료 확인 결과와 실패 terminalId를 반환"),
    capability!(Read, "list_external_provider_processes", {"provider":"claude"}, "Agent Manager 밖에서 독립 실행 중인 해당 공급자 CLI 프로세스(터미널·IDE 확장 등) 목록. 현재 사용자 소유만 포함하며 Agent Manager 자신과 그 자손·조상은 제외"),
    capability!(Execute, "terminate_external_provider_processes", {"provider":"claude","reason":null}, "외부 독립 실행 공급자 CLI 프로세스를 SIGTERM으로 종료하고, 유예 시간 안에 끝나지 않으면 SIGKILL 강제 종료로 승격(forcedCount로 보고). 강제 종료까지 실패한 프로세스만 pid와 원인을 반환"),
    capability!(Execute, "switch_active_provider_account", {"accountId":"ACCOUNT_ID","stopRunningChats":true,"stopExternalProcesses":true}, "실행 중 세션을 모두 종료한 뒤 활성 계정을 변경. 관리 런타임은 정상 종료 실패 시 SIGKILL 강제 종료로 승격하며 강제 종료까지 실패하면 자격증명을 변경하지 않음. 외부 독립 실행 CLI 프로세스도 종료 대상에 포함하되 외부 종료 실패는 보고만 하고 전환을 막지 않음"),
    capability!(Read, "list_provider_chats", {"provider":"claude"}, "해당 공급자의 Agent Manager 관리 런타임 전체 목록. standard·aia, attended·unattended, 연결·분리 상태를 모두 포함"),
    capability!(
        Read,
        "get_system_workflows",
        {},
        "등록된 시스템 워크플로 목록과 계약, 위험도, 호환성, 최근 실행 결과"
    ),
    capability!(Read, "get_system_workflow", {"workflowId":"WORKFLOW_ID"}, "단일 시스템 워크플로 상세와 버전 이력"),
    capability!(Read, "propose_system_workflow_schema", {"request":{"id":"WORKFLOW_ID","displayName":"NAME","description":"PURPOSE","inputSchema":{},"steps":[{"id":"STEP_ID","operation":"OPERATION","arguments":{}}],"risk":"mutating"}}, "system_catalog 기본 작업 조합으로 만든 워크플로 계약 초안을 검증하고 승인 요약을 반환. 상태를 변경하지 않음"),
    capability!(Execute, "register_system_workflow", {"request":{"id":"WORKFLOW_ID","displayName":"NAME","description":"PURPOSE","inputSchema":{},"steps":[{"id":"STEP_ID","operation":"OPERATION","arguments":{}}],"risk":"mutating"}}, "사용자가 검토·승인한 워크플로 계약을 등록. 수정은 기존 버전을 덮어쓰지 않고 새 버전으로 저장"),
    capability!(Execute, "execute_system_workflow", {"workflowId":"WORKFLOW_ID","arguments":{},"idempotencyKey":"UNIQUE_KEY"}, "등록된 워크플로만 실행. 단계별 성공·실패·건너뜀 상태와 변경 대상, 사후조건 결과를 반환"),
    capability!(Execute, "delete_system_workflow", {"workflowId":"WORKFLOW_ID"}, "등록된 워크플로와 실행 권한을 제거. 감사 이력은 유지"),
];

/// 워크플로 검증용 카탈로그 조회. Some(true)=변경 작업, Some(false)=읽기 작업.
pub(crate) fn system_operation_kind(operation: &str) -> Option<bool> {
    system_capability(operation).map(|capability| capability.access == CapabilityAccess::Execute)
}

#[derive(Clone)]
struct SystemMcpContext {
    service: ServiceEndpoint,
    app_data_dir: PathBuf,
    interfaces: McpInterfaceRegistry,
    session_catalog: SessionCatalog,
    chats: ChatSupervisor,
    terminals: TerminalSupervisor,
    scheduler: SchedulerSupervisor,
    translations: TranslationSupervisor,
}

pub struct SystemMcpServer {
    url: String,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl SystemMcpServer {
    pub fn start(
        service: ServiceEndpoint,
        app_data_dir: PathBuf,
        session_catalog: SessionCatalog,
        chats: ChatSupervisor,
        terminals: TerminalSupervisor,
        scheduler: SchedulerSupervisor,
        translations: TranslationSupervisor,
    ) -> Result<Self, CoreError> {
        let listener = StdTcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|error| {
            CoreError::Runtime(format!("AIA 시스템 MCP 포트를 열 수 없습니다: {error}"))
        })?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let route_key = Uuid::new_v4().simple().to_string();
        let route = format!("/mcp/{route_key}");
        let url = format!("http://127.0.0.1:{port}{route}");
        let interfaces = McpInterfaceRegistry::new(app_data_dir.clone());
        let context = Arc::new(SystemMcpContext {
            service,
            app_data_dir,
            interfaces,
            session_catalog,
            chats,
            terminals,
            scheduler,
            translations,
        });
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                CoreError::Runtime(format!("AIA 시스템 MCP 런타임을 만들 수 없습니다: {error}"))
            })?;
        let (shutdown_sender, shutdown_receiver) = oneshot::channel();
        let thread = thread::Builder::new()
            .name("agent-manager-aia-mcp".to_owned())
            .spawn(move || {
                runtime.block_on(async move {
                    match TcpListener::from_std(listener) {
                        Ok(listener) => {
                            let shutdown = async move {
                                let _ = shutdown_receiver.await;
                            };
                            if let Err(error) = serve_loop(listener, context, route, shutdown).await
                            {
                                eprintln!("AIA system MCP stopped: {error}");
                            }
                        }
                        Err(error) => eprintln!("AIA system MCP listener failed: {error}"),
                    }
                });
            })
            .map_err(|error| {
                CoreError::Runtime(format!(
                    "AIA 시스템 MCP 스레드를 시작할 수 없습니다: {error}"
                ))
            })?;
        Ok(Self {
            url,
            shutdown: Mutex::new(Some(shutdown_sender)),
            thread: Mutex::new(Some(thread)),
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }
}

impl Drop for SystemMcpServer {
    fn drop(&mut self) {
        if let Ok(shutdown) = self.shutdown.get_mut() {
            if let Some(shutdown) = shutdown.take() {
                let _ = shutdown.send(());
            }
        }
        if let Ok(thread) = self.thread.get_mut() {
            if let Some(thread) = thread.take() {
                let _ = thread.join();
            }
        }
    }
}

async fn serve_loop<F>(
    listener: TcpListener,
    context: Arc<SystemMcpContext>,
    route: String,
    shutdown: F,
) -> Result<(), std::io::Error>
where
    F: Future<Output = ()> + Send,
{
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => return Ok(()),
            accepted = listener.accept() => {
                let (stream, peer) = accepted?;
                if !peer.ip().is_loopback() {
                    continue;
                }
                let io = TokioIo::new(stream);
                let context = Arc::clone(&context);
                let route = route.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |request| {
                        handle_request(request, Arc::clone(&context), route.clone())
                    });
                    if let Err(error) = http1::Builder::new().serve_connection(io, service).await {
                        eprintln!("AIA system MCP HTTP connection error: {error}");
                    }
                });
            }
        }
    }
}

async fn handle_request(
    request: Request<Incoming>,
    context: Arc<SystemMcpContext>,
    route: String,
) -> Result<Response<Full<Bytes>>, Infallible> {
    if request.method() != Method::POST || request.uri().path() != route {
        return Ok(response(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            "Not found",
        ));
    }
    if !request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(is_loopback_host)
    {
        return Ok(response(
            StatusCode::FORBIDDEN,
            "text/plain; charset=utf-8",
            "Forbidden",
        ));
    }
    let upper = request.body().size_hint().upper().unwrap_or(u64::MAX);
    if upper > MAX_MCP_REQUEST_BODY as u64 {
        return Ok(response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "text/plain; charset=utf-8",
            "Request too large",
        ));
    }
    let body = match request.into_body().collect().await {
        Ok(body) => body.to_bytes(),
        Err(error) => {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                rpc_error(
                    Value::Null,
                    -32700,
                    &format!("요청 본문을 읽지 못했습니다: {error}"),
                ),
            ));
        }
    };
    if body.len() > MAX_MCP_REQUEST_BODY {
        return Ok(response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "text/plain; charset=utf-8",
            "Request too large",
        ));
    }
    let payload = match serde_json::from_slice::<Value>(&body) {
        Ok(payload) => payload,
        Err(error) => {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                rpc_error(
                    Value::Null,
                    -32700,
                    &format!("JSON 요청을 읽지 못했습니다: {error}"),
                ),
            ));
        }
    };
    let notification = payload.get("id").is_none();
    let result = tokio::task::spawn_blocking(move || handle_rpc(&context, payload)).await;
    if notification {
        return Ok(response(
            StatusCode::ACCEPTED,
            "text/plain; charset=utf-8",
            "",
        ));
    }
    let value = match result {
        Ok(value) => value,
        Err(error) => rpc_error(
            Value::Null,
            -32603,
            &format!("시스템 MCP 작업이 중단되었습니다: {error}"),
        ),
    };
    Ok(json_response(StatusCode::OK, value))
}

fn handle_rpc(context: &SystemMcpContext, payload: Value) -> Value {
    let id = payload.get("id").cloned().unwrap_or(Value::Null);
    if payload.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return rpc_error(id, -32600, "JSON-RPC 2.0 요청이 필요합니다");
    }
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match method {
        "initialize" => rpc_result(
            id,
            json!({
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {
                    "name": "AIA Agent Manager System",
                    "title": "AIA 시스템 인터페이스",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        ),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({"tools": tool_definitions()})),
        "tools/call" => {
            let params = payload.get("params").cloned().unwrap_or(Value::Null);
            rpc_result(id, call_tool(context, &params))
        }
        method if method.starts_with("notifications/") => rpc_result(id, Value::Null),
        _ => rpc_error(id, -32601, "지원하지 않는 MCP 메서드입니다"),
    }
}

fn call_tool(context: &SystemMcpContext, params: &Value) -> Value {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if name == "system_catalog" {
        let mut catalog = operation_catalog();
        match context.interfaces.catalog() {
            Ok(interfaces) => catalog["dynamicInterfaces"] = interfaces,
            Err(error) => {
                return tool_error(&format!("동적 MCP 인터페이스 목록 조회 실패: {error}"))
            }
        }
        match crate::system_workflows::SystemWorkflowRegistry::new(context.app_data_dir.clone())
            .catalog_summary()
        {
            Ok(workflows) => catalog["systemWorkflows"] = workflows,
            Err(error) => return tool_error(&format!("시스템 워크플로 목록 조회 실패: {error}")),
        }
        return tool_success(catalog);
    }
    let dynamic_result = match name {
        "interface_catalog" => Some(context.interfaces.catalog()),
        "interface_probe" => Some(
            parse_tool_arguments::<McpInterfaceProbeRequest>(&arguments)
                .and_then(|request| context.interfaces.probe(request)),
        ),
        "interface_register" => Some(
            parse_tool_arguments::<McpInterfaceRegisterRequest>(&arguments)
                .and_then(|request| context.interfaces.register(request)),
        ),
        "interface_revoke" => Some(
            parse_tool_arguments::<McpInterfaceIdRequest>(&arguments)
                .and_then(|request| context.interfaces.revoke(request)),
        ),
        "interface_read" => Some(
            parse_tool_arguments::<McpInterfaceCallRequest>(&arguments)
                .and_then(|request| context.interfaces.call_read(request)),
        ),
        "interface_execute" => Some(
            parse_tool_arguments::<McpInterfaceCallRequest>(&arguments)
                .and_then(|request| context.interfaces.call_execute(request)),
        ),
        _ => None,
    };
    if let Some(result) = dynamic_result {
        return match result {
            Ok(value) => tool_success(value),
            Err(error) => tool_error(&error.to_string()),
        };
    }
    let expected = match name {
        "system_read" => CapabilityAccess::Read,
        "system_execute" => CapabilityAccess::Execute,
        _ => return tool_error("알 수 없는 AIA 시스템 도구입니다"),
    };
    let operation = match arguments.get("operation").and_then(Value::as_str) {
        Some(operation)
            if system_capability(operation)
                .is_some_and(|capability| capability.access == expected) =>
        {
            operation
        }
        Some(_) => return tool_error("이 도구에서 허용되지 않는 시스템 작업입니다"),
        None => return tool_error("operation 인자가 필요합니다"),
    };
    let command_arguments = arguments
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let command_owns_audit = matches!(
        operation,
        "cancel_scheduled_run" | "recover_provider_transition" | "cancel_and_recover_scheduled_run"
    );
    if expected == CapabilityAccess::Execute && !command_owns_audit {
        if let Err(error) = crate::append_system_audit(
            &context.app_data_dir,
            operation,
            &command_arguments,
            crate::SystemAuditPhase::Attempted,
            None,
        ) {
            return tool_error(&format!("{operation} 감사 기록 준비 실패: {error}"));
        }
    }
    let command_context = SystemCommandContext {
        app_data_dir: &context.app_data_dir,
        service: &context.service,
        session_catalog: &context.session_catalog,
        chats: &context.chats,
        terminals: &context.terminals,
        scheduler: &context.scheduler,
        translations: &context.translations,
    };
    let result = invoke_system_command(&command_context, operation, command_arguments);
    if expected == CapabilityAccess::Execute && !command_owns_audit {
        if let Err(error) = crate::append_system_audit(
            &context.app_data_dir,
            operation,
            &arguments
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({})),
            crate::SystemAuditPhase::Completed,
            Some(result.is_ok()),
        ) {
            return tool_error(&format!(
                "{operation} 실행 후 감사 완료 기록에 실패했습니다: {error}"
            ));
        }
    }
    match result {
        Ok(value) => tool_success(json!({"operation": operation, "result": value})),
        Err(error) => tool_error(&format!("{operation} 실패: {error}")),
    }
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "system_catalog",
            "title": "Agent Manager 기능 목록",
            "description": "AIA가 사용할 수 있는 Agent Manager 조회 및 실행 작업과 정확한 인자 형태를 반환합니다.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false}
        }),
        json!({
            "name": "system_read",
            "title": "Agent Manager 상태 조회",
            "description": "시스템 카탈로그에 등록된 읽기 전용 작업을 실행합니다. arguments는 해당 작업의 invoke 인자 객체입니다.",
            "inputSchema": {
                "type": "object",
                "required": ["operation"],
                "properties": {
                    "operation": {"type": "string", "enum": operation_names(CapabilityAccess::Read)},
                    "arguments": {"type": "object", "default": {}}
                },
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true, "openWorldHint": false}
        }),
        json!({
            "name": "system_execute",
            "title": "Agent Manager 기능 실행",
            "description": "사용자가 명시적으로 요청한 Agent Manager 설정 또는 기능 변경을 실행합니다. 실행 전 승인 화면에 작업과 인자를 표시합니다.",
            "inputSchema": {
                "type": "object",
                "required": ["operation"],
                "properties": {
                    "operation": {"type": "string", "enum": operation_names(CapabilityAccess::Execute)},
                    "arguments": {"type": "object", "default": {}}
                },
                "additionalProperties": false
            },
            "annotations": {
                "readOnlyHint": false,
                "destructiveHint": true,
                "idempotentHint": false,
                "openWorldHint": false
            }
        }),
        json!({
            "name": "interface_catalog",
            "title": "동적 MCP 인터페이스 목록",
            "description": "사용자가 승인해 등록한 외부 MCP 인터페이스, 허용 도구, 권한 만료와 최근 감사 이력을 조회합니다.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false},
            "annotations": {"readOnlyHint": true, "openWorldHint": false}
        }),
        json!({
            "name": "interface_probe",
            "title": "외부 MCP 연결 조사 승인",
            "description": "등록 전에 사용자가 지정한 HTTP MCP URL에 연결해 서버 identity와 도구 목록을 조사합니다. 외부 네트워크 연결이므로 실행 전 승인이 필요합니다.",
            "inputSchema": {
                "type": "object",
                "required": ["url"],
                "properties": {
                    "url": {"type": "string", "description": "원격은 HTTPS, 로컬은 loopback HTTP 또는 HTTPS MCP endpoint"}
                },
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": true}
        }),
        json!({
            "name": "interface_register",
            "title": "외부 MCP 인터페이스 권한 등록",
            "description": "probe에서 확인한 identity와 사용자가 선택한 도구 allowlist를 검증한 뒤 권한을 저장합니다. URL에는 인증정보를 넣을 수 없습니다.",
            "inputSchema": {
                "type": "object",
                "required": ["id", "displayName", "url", "expectedIdentity", "enabledTools"],
                "properties": {
                    "id": {"type": "string", "description": "소문자 식별자"},
                    "displayName": {"type": "string"},
                    "url": {"type": "string"},
                    "expectedIdentity": {"type": "string", "description": "probe가 반환한 identityHash"},
                    "enabledTools": {"type": "array", "minItems": 1, "maxItems": 64, "items": {"type": "string"}},
                    "grantExpiresAt": {"type": ["integer", "null"], "description": "선택적 Unix epoch 밀리초 만료 시각"}
                },
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true}
        }),
        json!({
            "name": "interface_revoke",
            "title": "외부 MCP 인터페이스 권한 회수",
            "description": "등록된 외부 MCP 인터페이스와 모든 도구 권한을 즉시 회수합니다. 감사 이력은 유지합니다.",
            "inputSchema": {
                "type": "object",
                "required": ["id"],
                "properties": {"id": {"type": "string"}},
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": false}
        }),
        json!({
            "name": "interface_read",
            "title": "승인된 외부 MCP 조회",
            "description": "등록된 allowlist의 readOnlyHint=true 도구만 호출합니다. 서버 identity, 권한 만료와 도구 분류를 호출 시마다 다시 검증합니다.",
            "inputSchema": interface_call_schema(),
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true}
        }),
        json!({
            "name": "interface_execute",
            "title": "승인된 외부 MCP 변경 실행",
            "description": "등록된 allowlist의 변경 가능 도구만 호출합니다. 외부 시스템 변경이므로 각 호출 전에 승인이 필요합니다.",
            "inputSchema": interface_call_schema(),
            "annotations": {"readOnlyHint": false, "destructiveHint": true, "idempotentHint": false, "openWorldHint": true}
        }),
    ]
}

fn interface_call_schema() -> Value {
    json!({
        "type": "object",
        "required": ["id", "tool"],
        "properties": {
            "id": {"type": "string"},
            "tool": {"type": "string"},
            "arguments": {"type": "object", "default": {}}
        },
        "additionalProperties": false
    })
}

fn parse_tool_arguments<T: DeserializeOwned>(arguments: &Value) -> Result<T, CoreError> {
    serde_json::from_value(arguments.clone()).map_err(|error| {
        CoreError::InvalidInput(format!("MCP 도구 인자가 올바르지 않습니다: {error}"))
    })
}

fn operation_catalog() -> Value {
    let mut catalog = json!({
        "interface": "aia_system",
        "rule": "조회는 system_read, 변경은 system_execute를 사용합니다. 각 arguments는 Agent Manager typed invoke 계약을 그대로 따릅니다.",
        "limits": "공급자 계정 로그인 추가와 재인증은 대화형 터미널 인증이 필요해 이 인터페이스에서 지원하지 않습니다. 설정 → CLI 연결·계정 화면을 안내하세요.",
        "read": [
            {"operation":"get_app_status","arguments":{},"description":"플랫폼과 공급자 CLI 및 이력 탐지 상태"},
            {"operation":"get_provider_accounts","arguments":{},"description":"공급자 계정 목록과 사용량, 기본·활성 계정 상태"},
            {"operation":"refresh_provider_account_usage","arguments":{"accountId":"ACCOUNT_ID"},"description":"계정 사용량을 공급자에서 다시 조회"},
            {"operation":"get_chat_provider_options","arguments":{"source":"codex"},"description":"공급자 모델·추론 옵션과 실행설정 항목 스키마(settings)"},
            {"operation":"get_detached_chat_for_session","arguments":{"request":{"source":"codex","id":"SESSION_ID"}},"description":"분리된 라이브 채팅 조회"},
            {"operation":"get_live_chats","arguments":{"profile":"standard"},"description":"실행 중 라이브 채팅 목록. profile은 standard 또는 aia"},
            {"operation":"list_sessions","arguments":{},"description":"세션 요약 목록"},
            {"operation":"get_session_statistics","arguments":{},"description":"세션 통계"},
            {"operation":"get_chat_delivery_status","arguments":{},"description":"채팅 전달 결과 재조회"},
            {"operation":"get_chat_attention_snapshot","arguments":{},"description":"진행, 승인, 완료 알림"},
            {"operation":"get_manager_snapshot","arguments":{},"description":"대시보드, 세션, 스킬, 에이전트, 산출물 전체 스냅샷. 결과가 크면 더 좁은 작업을 사용"},
            {"operation":"get_system_automation_snapshot","arguments":{},"description":"언어, 번역, 시스템 공급자 설정과 상태"},
            {"operation":"get_menu_translations","arguments":{"menu":"skills"},"description":"skills, agents, artifacts 번역 목록"},
            {"operation":"get_translated_detail","arguments":{"menu":"skills","resourceId":"RESOURCE_ID"},"description":"번역 상세"},
            {"operation":"reconcile_session_catalog","arguments":{},"description":"세션 카탈로그 증분 동기화"},
            {"operation":"refresh_session_catalog","arguments":{"request":{"source":"codex","id":"SESSION_ID"}},"description":"단일 세션 카탈로그 갱신"},
            {"operation":"get_storage_overview","arguments":{},"description":"저장소 사용량"},
            {"operation":"get_session_detail","arguments":{"request":{"source":"codex","id":"SESSION_ID","transcriptLimit":"latest100"}},"description":"세션 상세와 대화 기록"},
            {"operation":"get_session_linked_file","arguments":{"request":{"source":"codex","id":"SESSION_ID","href":"FILE_LINK"}},"description":"세션에 연결된 안전한 파일 미리보기"},
            {"operation":"get_chat_linked_file","arguments":{"request":{"chatId":"CHAT_ID","href":"FILE_LINK"}},"description":"라이브 채팅 연결 파일 미리보기"},
            {"operation":"get_session_folders","arguments":{},"description":"세션 폴더 목록"},
            {"operation":"get_skill_detail","arguments":{"id":"SKILL_ID"},"description":"스킬 상세"},
            {"operation":"get_agent_detail","arguments":{"name":"AGENT_NAME"},"description":"에이전트 정의 상세"},
            {"operation":"get_artifact_detail","arguments":{"request":{"conversationId":"ID","rootName":"ROOT","name":"NAME"}},"description":"산출물 상세"},
            {"operation":"get_doc_roots","arguments":{},"description":"문서 루트 목록"},
            {"operation":"get_doc_tree","arguments":{"rootId":"ROOT_ID"},"description":"문서 트리"},
            {"operation":"get_doc","arguments":{"request":{"rootId":"ROOT_ID","relativePath":"PATH"}},"description":"문서 읽기"},
            {"operation":"get_doc_linked_file","arguments":{"request":{"rootId":"ROOT_ID","currentPath":"PATH","href":"FILE_LINK"}},"description":"문서 연결 파일 미리보기"},
            {"operation":"get_scheduler_snapshot","arguments":{},"description":"반복 요청과 실행 이력"},
            {"operation":"list_scheduled_requests","arguments":{},"description":"반복 요청 요약 목록"},
            {"operation":"get_scheduled_request_detail","arguments":{},"description":"반복 요청 상세"},
            {"operation":"list_scheduled_runs","arguments":{},"description":"실행 이력 요약 목록"},
            {"operation":"get_scheduled_run_detail","arguments":{},"description":"실행 이력 상세"},
            {"operation":"list_system_audit","arguments":{},"description":"AIA 시스템 감사 이력"},
            {"operation":"list_provider_chats","arguments":{},"description":"공급자 관리 런타임 전체 목록"},
            {"operation":"list_external_provider_processes","arguments":{},"description":"외부 독립 실행 공급자 CLI 프로세스 목록"},
            {"operation":"get_system_workflows","arguments":{},"description":"시스템 워크플로 목록"},
            {"operation":"get_system_workflow","arguments":{},"description":"시스템 워크플로 상세"},
            {"operation":"propose_system_workflow_schema","arguments":{},"description":"워크플로 계약 초안 검증"}
        ],
        "execute": [
            {"operation":"patch_session_meta","arguments":{"request":{"source":"codex","id":"SESSION_ID","patch":{"favorite":true}}},"description":"세션 메타데이터 변경"},
            {"operation":"create_session_folder","arguments":{"request":{"name":"NAME","color":"#HEX"}},"description":"세션 폴더 생성"},
            {"operation":"update_session_folder","arguments":{"request":{"id":"ID","name":"NAME","color":"#HEX"}},"description":"세션 폴더 변경"},
            {"operation":"delete_session_folder","arguments":{"id":"ID"},"description":"세션 폴더 삭제"},
            {"operation":"create_doc_root","arguments":{"request":{"name":"NAME","path":"ABSOLUTE_PATH"}},"description":"문서 루트 추가"},
            {"operation":"delete_doc_root","arguments":{"id":"ID"},"description":"문서 루트 제거"},
            {"operation":"put_doc","arguments":{"request":{"rootId":"ROOT_ID","relativePath":"PATH","content":"CONTENT","expectedModifiedAt":null}},"description":"문서 저장"},
            {"operation":"create_scheduled_request","arguments":{"request":"ScheduledRequestInput"},"description":"반복 요청 생성"},
            {"operation":"update_scheduled_request","arguments":{"request":{"id":"ID","input":"ScheduledRequestInput"}},"description":"반복 요청 변경"},
            {"operation":"delete_scheduled_request","arguments":{"id":"ID"},"description":"반복 요청 삭제"},
            {"operation":"set_schedule_enabled","arguments":{"request":{"id":"ID","enabled":true}},"description":"반복 요청 활성화 변경"},
            {"operation":"run_scheduled_request_now","arguments":{"id":"ID"},"description":"반복 요청 즉시 실행"},
            {"operation":"cancel_scheduled_run","arguments":{"runId":"RUN_ID","reason":"운영자 취소 사유"},"description":"실행 소유권을 검증해 반복 run 취소"},
            {"operation":"recover_provider_transition","arguments":{"provider":"claude","runId":"RUN_ID","transitionId":"TRANSITION_ID"},"description":"고아 계정 전환 lease 복구"},
            {"operation":"cancel_and_recover_scheduled_run","arguments":{"request":{"provider":"claude","runId":"RUN_ID","transitionId":"TRANSITION_ID"},"reason":"운영자 취소 사유"},"description":"실행 취소 후 계정 전환 복구"},
            {"operation":"set_schedules_paused","arguments":{"paused":true},"description":"전체 반복 요청 일시정지 또는 재개"},
            {"operation":"set_system_automation_settings","arguments":{"request":"SystemAutomationSettingsInput"},"description":"시스템 언어, 공급자, 자동 번역 설정 변경"},
            {"operation":"request_system_language","arguments":{"request":"SystemLanguageRequest"},"description":"시스템 언어 전환 요청"},
            {"operation":"retry_ui_translation","arguments":{},"description":"UI 번역 재시도"},
            {"operation":"cancel_ui_translation","arguments":{},"description":"UI 번역 취소"},
            {"operation":"retry_menu_translation","arguments":{"menu":"skills"},"description":"메뉴 번역 재시도"},
            {"operation":"reset_menu_translation","arguments":{"menu":"skills"},"description":"메뉴 번역 초기화. 저장된 번역을 지우고 처음부터 다시 번역"},
            {"operation":"mark_chat_attention_read","arguments":{"id":"ID"},"description":"채팅 알림 읽음 처리"},
            {"operation":"mark_all_chat_attention_read","arguments":{},"description":"종료 알림 모두 읽음 처리"},
            {"operation":"clear_read_chat_attention","arguments":{},"description":"읽은 종료 알림 정리"},
            {"operation":"dismiss_chat_attention","arguments":{"id":"ID"},"description":"채팅 알림 개별 삭제. 승인 대기 알림은 삭제 불가"},
            {"operation":"register_current_provider_account","arguments":{"source":"codex","displayName":null},"description":"현재 CLI 인증 계정을 관리 계정으로 등록"},
            {"operation":"set_default_provider_account","arguments":{"accountId":"ACCOUNT_ID"},"description":"공급자 기본 계정 지정"},
            {"operation":"set_active_provider_account","arguments":{"accountId":"ACCOUNT_ID"},"description":"관리·외부 런타임 종료 후 활성 인증 계정 전환"},
            {"operation":"set_provider_account_disabled","arguments":{"accountId":"ACCOUNT_ID","disabled":true},"description":"계정 사용 중지 또는 재개"},
            {"operation":"set_provider_account_auto_switch","arguments":{"accountId":"ACCOUNT_ID","autoSwitch":true},"description":"사용량 한도 도달 시 자동전환 순환 대상으로 지정 또는 해제"},
            {"operation":"set_auto_switch_resume","arguments":{"enabled":true},"description":"자동전환으로 종료된 실행 중 채팅을 resume으로 재시작할지 설정"},
            {"operation":"delete_provider_account","arguments":{"accountId":"ACCOUNT_ID"},"description":"관리 계정 등록 삭제"},
            {"operation":"propose_chat_settings_schema","arguments":{"source":"claude","fields":[{"key":"mode","label":"실행 모드","detail":"권한 범위","kind":"enum","options":[{"value":"plan","label":"읽기 전용","detail":"분석·계획만"}],"defaultValue":"plan"}]},"description":"CLI 인터페이스 조사 결과로 실행설정 스키마 갱신. 내장 항목은 선택지 재구성만, 새 항목은 화이트리스트 내에서만 허용. fields를 빈 배열로 주면 오버라이드 제거"},
            {"operation":"send_chat_message","arguments":{},"description":"채팅 메시지 전달"},
            {"operation":"start_chat","arguments":{},"description":"새 채팅 시작"},
            {"operation":"detach_chat","arguments":{},"description":"채팅 런타임 분리"},
            {"operation":"stop_chat","arguments":{},"description":"채팅 종료"},
            {"operation":"stop_provider_chats","arguments":{},"description":"공급자 채팅 전체 종료"},
            {"operation":"stop_provider_terminals","arguments":{},"description":"공급자 관리 터미널 전체 종료"},
            {"operation":"terminate_external_provider_processes","arguments":{},"description":"외부 독립 실행 공급자 CLI 프로세스 종료"},
            {"operation":"switch_active_provider_account","arguments":{},"description":"관리 세션·외부 CLI 프로세스 종료 후 활성 계정 전환"},
            {"operation":"register_system_workflow","arguments":{},"description":"시스템 워크플로 등록"},
            {"operation":"execute_system_workflow","arguments":{},"description":"시스템 워크플로 실행"},
            {"operation":"delete_system_workflow","arguments":{},"description":"시스템 워크플로 삭제"}
        ]
    });
    for section in ["read", "execute"] {
        for entry in catalog[section]
            .as_array_mut()
            .expect("system catalog section must be an array")
        {
            let operation = entry["operation"]
                .as_str()
                .expect("system catalog operation must be a string");
            let capability =
                system_capability(operation).expect("system catalog operation must be registered");
            entry["arguments"] = serde_json::from_str(capability.arguments_json)
                .expect("registered capability arguments must be valid JSON");
            entry["description"] = Value::String(capability.description.to_owned());
        }
    }
    catalog
}

fn operation_names(access: CapabilityAccess) -> Vec<&'static str> {
    SYSTEM_CAPABILITIES
        .iter()
        .filter(|capability| capability.access == access)
        .map(|capability| capability.operation)
        .collect()
}

fn system_capability(operation: &str) -> Option<&'static SystemCapability> {
    SYSTEM_CAPABILITIES
        .iter()
        .find(|capability| capability.operation == operation)
}

fn tool_success(value: Value) -> Value {
    let text = match serde_json::to_string_pretty(&value) {
        Ok(text) if text.len() <= MAX_MCP_RESULT_BYTES => text,
        Ok(_) => {
            return tool_error(
                "시스템 응답이 너무 큽니다. 카탈로그에서 더 좁은 조회 작업을 선택하세요",
            )
        }
        Err(error) => return tool_error(&format!("시스템 응답을 직렬화하지 못했습니다: {error}")),
    };
    json!({"content": [{"type": "text", "text": text}], "isError": false})
}

fn tool_error(message: &str) -> Value {
    json!({"content": [{"type": "text", "text": message}], "isError": true})
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.rsplit_once(':').map_or(host, |(name, _)| name);
    matches!(host, "127.0.0.1" | "localhost" | "[::1]")
}

fn json_response(status: StatusCode, value: Value) -> Response<Full<Bytes>> {
    let body = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
    response(status, "application/json; charset=utf-8", body)
}

fn response(
    status: StatusCode,
    content_type: &'static str,
    body: impl Into<Bytes>,
) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(body.into()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    fn catalog_operations(section: &str) -> BTreeSet<String> {
        operation_catalog()[section]
            .as_array()
            .expect("catalog section")
            .iter()
            .map(|entry| {
                entry["operation"]
                    .as_str()
                    .expect("operation name")
                    .to_owned()
            })
            .collect()
    }

    #[test]
    fn separates_read_and_mutating_operations() {
        let read = operation_names(CapabilityAccess::Read);
        let execute = operation_names(CapabilityAccess::Execute);
        assert!(read.contains(&"get_scheduler_snapshot"));
        assert!(read.contains(&"get_provider_accounts"));
        assert!(read.contains(&"get_live_chats"));
        assert!(read.contains(&"list_sessions"));
        assert!(read.contains(&"get_session_statistics"));
        assert!(read.contains(&"get_chat_delivery_status"));
        assert!(read.contains(&"list_scheduled_requests"));
        assert!(read.contains(&"list_scheduled_runs"));
        assert!(!read.contains(&"set_schedules_paused"));
        assert!(execute.contains(&"set_schedules_paused"));
        assert!(execute.contains(&"set_active_provider_account"));
        assert!(execute.contains(&"send_chat_message"));
        assert!(execute.contains(&"start_chat"));
        assert!(execute.contains(&"detach_chat"));
        assert!(!execute.contains(&"get_manager_snapshot"));
        for operation in &read {
            assert!(
                !crate::remote::is_write_command(operation),
                "{operation} 은 읽기 목록에 있지만 원격 계약에서는 변경 작업입니다"
            );
            assert!(
                !execute.contains(operation),
                "{operation} 이 읽기와 실행 목록에 중복되어 있습니다"
            );
        }
        for operation in &execute {
            assert!(
                crate::remote::is_write_command(operation),
                "{operation} 은 실행 목록에 있지만 원격 계약에서는 변경 작업이 아닙니다"
            );
        }
    }

    #[test]
    fn interactive_account_login_is_not_exposed() {
        for operation in [
            "begin_provider_account_login",
            "finish_provider_account_login",
            "cancel_provider_account_login",
        ] {
            assert!(system_capability(operation).is_none());
        }
    }

    #[test]
    fn catalog_matches_operation_lists() {
        let read_names = operation_names(CapabilityAccess::Read);
        let write_names = operation_names(CapabilityAccess::Execute);
        let read: BTreeSet<String> = read_names
            .iter()
            .map(|operation| (*operation).to_owned())
            .collect();
        let write: BTreeSet<String> = write_names
            .iter()
            .map(|operation| (*operation).to_owned())
            .collect();
        assert_eq!(
            read.len(),
            read_names.len(),
            "읽기 기능 id가 중복되었습니다"
        );
        assert_eq!(
            write.len(),
            write_names.len(),
            "실행 기능 id가 중복되었습니다"
        );
        assert_eq!(
            catalog_operations("read").len(),
            operation_catalog()["read"].as_array().unwrap().len(),
            "읽기 카탈로그 항목이 중복되었습니다"
        );
        assert_eq!(
            catalog_operations("execute").len(),
            operation_catalog()["execute"].as_array().unwrap().len(),
            "실행 카탈로그 항목이 중복되었습니다"
        );
        assert_eq!(catalog_operations("read"), read);
        assert_eq!(catalog_operations("execute"), write);
    }

    #[test]
    fn execute_tool_is_marked_as_mutating() {
        let tools = tool_definitions();
        let execute = tools
            .iter()
            .find(|tool| tool["name"] == "system_execute")
            .expect("execute tool");
        assert_eq!(execute["annotations"]["readOnlyHint"], false);
        assert_eq!(execute["annotations"]["destructiveHint"], true);

        let interface_read = tools
            .iter()
            .find(|tool| tool["name"] == "interface_read")
            .expect("interface_read tool");
        let interface_execute = tools
            .iter()
            .find(|tool| tool["name"] == "interface_execute")
            .expect("interface_execute tool");
        assert_eq!(interface_read["annotations"]["readOnlyHint"], true);
        assert_eq!(interface_execute["annotations"]["readOnlyHint"], false);
    }
}
