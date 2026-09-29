/**
 * 세션 기록(색인 갱신·상세·전사 이미지·메타·폴더) 명령 묶음.
 *
 * `ipc.ts` 가운데에 흩어져 있던 열넷이다. 세션 화면 하나가 쓰는 한 덩어리인데,
 * 앞뒤가 사용량 예산과 스케줄러라 목록에서 경계가 보이지 않았다. 다른 `ipc*`
 * 모듈과 같은 규칙으로 따로 낸다.
 *
 * 전사 이미지 두 개는 `call`이 아니라 HTTP를 직접 타는 유일한 세션 명령이라
 * `remoteFetch`·`responseError`를 쓴다. 그 둘을 함께 옮겨야 `ipc.ts`가 통로
 * 원시 함수를 더는 직접 들지 않는다.
 */
import type {
  CatalogHealth,
  LinkedFile,
  ProviderId,
  SessionCatalogUpdate,
  SessionDetail,
  SessionFolder,
  SessionCleanupPolicy,
  SessionCleanupReceipt,
  SessionCleanupStatus,
  SessionMeta,
  SessionMetaPatch,
  SessionSummary,
  SessionTranscriptLimit,
} from "../types";
import { sessionTranscriptImagePath, type TranscriptImageRef } from "./sessionImage";
import { backendHttpUrl, hasNativeShell } from "./backend";
import { call, nativeCall, remoteFetch, responseError } from "./ipcTransport";

/**
 * 세션 하나를 가리키는 두 값. 색인 갱신·상세·앱 열기·링크 파일·메타 수정, 그리고 채팅
 * 런타임 조회와 첨부 내려받기까지 일곱 자리가 같은 짝을 각자 손으로 적고 있었다. 필드
 * 이름을 한 자리만 다르게 적어도 타입은 지나고 백엔드에서 인자 부족으로만 드러나므로,
 * 이름과 조립을 여기 한곳에 둔다(`deployedInstructionRef`와 같은 규칙이다).
 */
export type SessionRef = {
  source: ProviderId;
  id: string;
};

export function sessionRef(source: ProviderId, id: string): SessionRef {
  return { source, id };
}

/**
 * 전체 색인 재조정 제한 시간. 백엔드가 응답하지 않으면 화면이 조용히 오래된 목록을
 * 계속 보여 주기 때문에(단일 비행 가드가 영구 대기 상태로 남는다) 반드시 끊어 준다.
 * 새 대화 기록이 많이 쌓인 뒤의 정상 전체 조정도 수십 초가 걸릴 수 있어 넉넉히 잡는다.
 */
const SESSION_CATALOG_RECONCILE_TIMEOUT_MS = 60_000;
/** 단일 세션 색인 갱신 제한 시간. 호출부가 여러 번 재시도하므로 짧게 잡는다. */
const SESSION_CATALOG_REFRESH_TIMEOUT_MS = 15_000;

export function reconcileSessionCatalog(): Promise<SessionCatalogUpdate> {
  return call<SessionCatalogUpdate>("reconcile_session_catalog", {}, {
    timeoutMs: SESSION_CATALOG_RECONCILE_TIMEOUT_MS,
  });
}

export function refreshSessionCatalog(
  source: ProviderId,
  id: string,
): Promise<SessionCatalogUpdate> {
  return call<SessionCatalogUpdate>("refresh_session_catalog", { request: sessionRef(source, id) }, {
    timeoutMs: SESSION_CATALOG_REFRESH_TIMEOUT_MS,
  });
}

export function getCatalogHealth(): Promise<CatalogHealth> {
  return call<CatalogHealth>("get_catalog_health");
}

/**
 * 세션 한 건의 요약을 공급자 원본에서 바로 읽는다. 목록(스냅숏)을 거치지 않으므로
 * 색인이 아직 닿지 않은 세션도, 제외 프로젝트라 목록에서 빠지는 세션도 돌려준다.
 * 알림에서 무인 실행 결과를 열 때 목록 반영을 기다리다 실패하는 대신 쓰는 마지막 길이다.
 */
export function getSessionSummary(source: ProviderId, id: string): Promise<SessionSummary> {
  return call<SessionSummary>("get_session_summary", { request: sessionRef(source, id) });
}

export function getSessionDetail(
  source: ProviderId,
  id: string,
  transcriptLimit: SessionTranscriptLimit = "latest500",
  transcriptBeforeIndex?: number,
): Promise<SessionDetail> {
  return call<SessionDetail>("get_session_detail", {
    request: { ...sessionRef(source, id), transcriptLimit, transcriptBeforeIndex },
  });
}

export function openProviderSessionApp(source: ProviderId, id: string): Promise<void> {
  return nativeCall<void>("open_provider_session_app", { request: sessionRef(source, id) });
}

/** Tauri CSP는 loopback 이미지를 직접 삽입하지 않습니다. 네이티브에서는 Blob URL을 씁니다. */
export function directSessionTranscriptImageUrl(
  source: ProviderId,
  id: string,
  image: TranscriptImageRef,
): string | null {
  if (hasNativeShell()) return null;
  return backendHttpUrl(sessionTranscriptImagePath(source, id, image));
}

export async function readSessionTranscriptImage(
  source: ProviderId,
  id: string,
  image: TranscriptImageRef,
): Promise<Blob> {
  const response = await remoteFetch(
    backendHttpUrl(sessionTranscriptImagePath(source, id, image)),
    { cache: "no-store" },
  );
  if (!response.ok) throw await responseError(response, "이미지를 읽지 못했습니다");
  return response.blob();
}

/**
 * 세션 대화에 적힌 링크 하나를 가리키는 요청 본문. 같은 링크를 **읽는** 명령
 * (`get_session_linked_file`)과 **내려받는** 통로(`ipcLinkedFile`)가 둘 다 이 모양을
 * 보내는데, 봉투를 각자 조립하면 한쪽만 칸이 늘어도 타입은 지나고 백엔드에서 인자
 * 부족으로만 드러난다. `sessionRef`가 세션을 가리키는 두 값을 모은 것과 같은 규칙으로,
 * 링크 한 줄을 가리키는 모양도 도메인 모듈이 한 벌만 가진다.
 */
export type SessionLinkedFileRef = SessionRef & {
  href: string;
};

export function sessionLinkedFileRef(
  source: ProviderId,
  id: string,
  href: string,
): SessionLinkedFileRef {
  return { ...sessionRef(source, id), href };
}

export function getSessionLinkedFile(
  source: ProviderId,
  id: string,
  href: string,
): Promise<LinkedFile> {
  return call<LinkedFile>("get_session_linked_file", { request: sessionLinkedFileRef(source, id, href) });
}

/**
 * 세션 하나의 메타데이터. 세션 목록을 들고 있는 화면은 카탈로그 항목의 `meta`를 그대로
 * 쓰지만, 목록 없이 대화 하나만 띄우는 화면(AIA 팝업)은 이 통로로 읽는다. 아직 아무것도
 * 남기지 않은 세션은 기본값으로 온다.
 */
export function getSessionMeta(source: ProviderId, id: string): Promise<SessionMeta> {
  return call<SessionMeta>("get_session_meta", { request: sessionRef(source, id) });
}

export function patchSessionMeta(
  source: ProviderId,
  id: string,
  patch: SessionMetaPatch,
): Promise<SessionMeta> {
  return call<SessionMeta>("patch_session_meta", { request: { ...sessionRef(source, id), patch } });
}

/** `parentId`를 주면 그 폴더의 하위로, 비우면 최상위에 만든다. */
export function createSessionFolder(
  name: string,
  color: string,
  parentId?: string | null,
): Promise<SessionFolder> {
  return call<SessionFolder>("create_session_folder", { request: { name, color, parentId: parentId ?? null } });
}

/**
 * `parentId`를 넘기지 않으면 상위 폴더를 그대로 두고, `null`이면 최상위로 올린다.
 * 자기 자신이나 자기 하위 폴더로 옮기려 하면 백엔드가 거부한다. `hidden`을 넘기지
 * 않으면 숨김 여부를 그대로 둔다.
 */
export function updateSessionFolder(
  id: string,
  patch: { name?: string; color?: string; parentId?: string | null; hidden?: boolean },
): Promise<SessionFolder> {
  return call<SessionFolder>("update_session_folder", { request: { id, ...patch } });
}

/**
 * 같은 상위 폴더의 형제 사이에서 한 칸 위나 아래로 옮기고, 새 순서의 폴더 목록을
 * 트리 순서로 돌려준다. 끝이라 바꿀 형제가 없으면 순서를 그대로 둔다.
 */
export function reorderSessionFolder(
  id: string,
  direction: "up" | "down",
): Promise<SessionFolder[]> {
  return call<SessionFolder[]>("reorder_session_folder", { request: { id, direction } });
}

/** 하위 폴더까지 함께 지우고, 지워진 폴더 ID를 트리 순서로 돌려준다. */
export function deleteSessionFolder(id: string): Promise<string[]> {
  return call<string[]>("delete_session_folder", { id });
}

/**
 * 세션 자동정리(`C11`)의 현재 조건과 미리보기. 조건에 걸리는 건수·용량은 실행과 같은
 * 판정 경로에서 나오므로 미리보기와 실제 결과가 갈라지지 않는다.
 */
export function getSessionCleanupStatus(): Promise<SessionCleanupStatus> {
  return call<SessionCleanupStatus>("get_session_cleanup_status");
}

/** 정리 조건을 저장하고 갱신된 상태를 돌려준다. */
export function setSessionCleanupPolicy(
  policy: SessionCleanupPolicy,
): Promise<SessionCleanupStatus> {
  return call<SessionCleanupStatus>("set_session_cleanup_policy", { request: policy });
}

/**
 * 지금 한 회차를 돌린다. 자동정리가 꺼져 있어도 수동 실행은 받는다 — 켜기 전에 결과를
 * 한 번 보고 판단할 수 있어야 한다.
 */
export function runSessionCleanup(): Promise<SessionCleanupReceipt> {
  return call<SessionCleanupReceipt>("run_session_cleanup");
}

/**
 * 정리 기록(툼스톤)을 모두 지운다. 공유 공급자 홈 원문은 손대지 않았으므로 다음
 * 재조사에서 세션이 목록으로 되돌아온다. 돌려주는 값은 되돌린 세션 수다.
 */
export function clearSessionCleanupTombstones(): Promise<number> {
  return call<number>("clear_session_cleanup_tombstones");
}
