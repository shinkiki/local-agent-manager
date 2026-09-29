/**
 * 링크 파일을 내려받는 통로. 대화·채팅·지침·문서 네 화면이 같은 일을 하지만,
 * 그 일은 `call` 한 줄이 아니다 — 백엔드 다운로드 엔드포인트를 직접 두드리고,
 * 응답 헤더에서 파일 이름을 되짚고, 데스크톱이면 바이트를 나르지 않는 복사 경로로
 * 빠진다. 명령 목록(`ipc.ts`)에 섞여 있으면 이 갈래가 명령 한 줄들 사이에 묻혀
 * 보이지 않으므로 통로만 따로 둔다.
 *
 * **저장 갈래 자체는 여기 있지 않다**(`fileSave.ts`). 고른 자리에 바이트를 쓰는 일은
 * 그 바이트를 백엔드에서 받아 왔는지 화면에서 만들었는지와 무관해서, 여기 두는 동안은
 * 다이어그램 내보내기가 "첨부 내려받기" 모듈을 가져다 쓰고 있었다. 여기 남는 것은
 * "무엇을 어디서 받아 어떤 이름으로 부를 것인가"뿐이다.
 *
 * **요청 본문의 모양도 여기서 정하지 않는다.** 네 입구는 각자의 도메인 모듈이 같은 링크를
 * 읽는 명령과 짝이고(세션·채팅·문서·지침), 그 둘이 봉투를 따로 조립하면 한쪽만 칸이 늘어도
 * 타입은 지나고 백엔드에서 인자 부족으로만 드러난다. 봉투는 도메인 모듈의 `*LinkedFileRef`
 * 한 벌에서 받아 그대로 싣는다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는
 * 예전 그대로 `lib/ipc`다.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "../types";
import { backendHttpUrl, hasNativeShell } from "./backend";
import {
  finishFileDownload,
  markFileDownloadCancelling,
  startFileDownload,
  updateFileDownload,
} from "./fileDownloads";
import { chooseDownloadDestination, sanitizeDownloadName, saveBlobAsFile } from "./fileSave";
import { chatLinkedFileRef, type ChatLinkedFileRef } from "./ipcChat";
import { docLinkedFileRef, type DocLinkedFileRef } from "./ipcDocuments";
import {
  deployedInstructionLinkedFileRef,
  type DeployedInstructionLinkedFileRef,
  type InstructionScope,
} from "./ipcInstructions";
import { sessionLinkedFileRef, type SessionLinkedFileRef } from "./ipcSessions";
import { postJson, responseError } from "./ipcTransport";

/**
 * 등록된 문서 루트 안의 파일 하나를 가리키는 자리. 이 자리만 있으면 데스크톱 셸은
 * 바이트를 웹뷰로 나르지 않고 Rust에서 곧장 복사할 수 있다. `href`가 있으면
 * `relativePath`는 링크가 적힌 문서의 경로다.
 */
interface DocumentFileRef {
  rootId: string;
  relativePath: string;
  href?: string;
}

/**
 * `doc` 입구의 HTTP 봉투가 가리키는 파일을 네이티브 복사 자리로 옮겨 적는다. 두 봉투는
 * 같은 파일을 가리키면서 칸 이름만 다르다(`currentPath` ↔ `relativePath`).
 *
 * 옮겨 적기를 호출부에 두면 한 입구가 같은 세 값을 두 번 적게 된다. 그 두 벌이 어긋나면
 * 타입은 그대로 지나고, 브라우저 셸은 A를 내려받는데 데스크톱 셸은 B를 복사하는 — 셸에
 * 따라 다른 파일이 저장되는 어긋남이 조용히 남는다. 값은 한 번만 적고 나머지는 여기서
 * 파생시킨다.
 */
function documentFileRefOf(ref: DocLinkedFileRef): DocumentFileRef {
  return { rootId: ref.rootId, relativePath: ref.currentPath, href: ref.href };
}

/**
 * 다섯 입구가 싣는 요청 본문. 각 봉투는 짝이 되는 도메인 모듈이 한 벌로 가지고, 여기서는
 * 그 이름들을 합집합으로 받기만 한다.
 *
 * 받는 자리를 `Record<string, unknown>`으로 열어 두면 봉투를 도메인 모듈에 모아 둔 이유가
 * 사라진다 — 무엇이든 통과하므로 봉투를 거치지 않고 손으로 조립한 객체를 그대로 넘겨도
 * 타입은 지나고, 칸을 빠뜨린 사실은 백엔드의 인자 부족으로만 드러난다. 봉투 이름을 받으면
 * 그 조립이 컴파일에서 막힌다.
 */
type LinkedFileRequest =
  | SessionLinkedFileRef
  | ChatLinkedFileRef
  | DocLinkedFileRef
  | DeployedInstructionLinkedFileRef
  | DocumentFileRef;

async function downloadLinkedFile(
  endpoint: "session" | "chat" | "doc" | "document" | "instruction",
  request: LinkedFileRequest,
  href: string,
  documentRef?: DocumentFileRef,
): Promise<void> {
  const fallbackName = linkedFileName(href);
  // 데스크톱 셸에서 문서 루트 안의 파일을 내려받는 경우에만, 파일 전체를 HTTP 응답과
  // Blob과 IPC 본문으로 세 번 더 들고 있지 않는 경로를 쓴다. 그 사본들이 100MB 상한의
  // 이유였으므로, 이 경로에는 크기 제한이 없다.
  if (documentRef && hasNativeShell()) {
    await copyDocumentFileToChosenPath(documentRef, fallbackName);
    return;
  }
  const response = await postJson(
    backendHttpUrl(`/api/download/linked-file/${endpoint}`),
    { request },
  );
  if (!response.ok) throw await responseError(response, "파일 다운로드에 실패했습니다");
  const fileName = responseFileName(response.headers.get("Content-Disposition")) ?? fallbackName;
  await saveBlobAsFile(await response.blob(), fileName, "링크 파일 저장");
}

/**
 * 저장 대화상자로 목적지만 정하고, 읽기·쓰기는 Rust에 맡긴다. 진행률은 명령이 끝날
 * 때까지 채널로 올라오고, 사용자는 그 사이에 [`cancelFileDownload`]로 멈출 수 있다.
 */
async function copyDocumentFileToChosenPath(
  documentRef: DocumentFileRef,
  fileName: string,
): Promise<void> {
  const chosen = await chooseDownloadDestination(fileName, "링크 파일 저장");
  if (!chosen) return;
  const { destination, safeName } = chosen;
  const downloadId = newDownloadId();
  const progress = new Channel<{ copiedBytes: number; totalBytes: number }>();
  progress.onmessage = (message) => {
    updateFileDownload(downloadId, message.copiedBytes, message.totalBytes);
  };
  startFileDownload(downloadId, safeName);
  try {
    await invoke<{ saved: boolean; copiedBytes: number }>("save_document_file_to_path", {
      request: { ...documentRef, destination, downloadId },
      progress,
    });
  } finally {
    finishFileDownload(downloadId);
  }
}

/** 진행 중인 저장을 멈춘다. 멈춤은 Rust가 확인하므로 현황판은 요청 사실만 먼저 적는다. */
export async function cancelFileDownload(downloadId: string): Promise<void> {
  markFileDownloadCancelling(downloadId);
  await invoke<void>("cancel_document_file_download", { downloadId });
}

function newDownloadId(): string {
  return typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `download-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function linkedFileName(href: string): string {
  let target = href.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0].replace(/:\d+$/, "");
  target = decodedUriComponent(target) ?? target;
  const name = target.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return sanitizeDownloadName(name || "download");
}

function responseFileName(disposition: string | null): string | null {
  if (!disposition) return null;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    const decoded = decodedUriComponent(encoded);
    if (decoded !== null) return sanitizeDownloadName(decoded);
  }
  const fallback = disposition.match(/filename="([^"]+)"/i)?.[1];
  return fallback ? sanitizeDownloadName(fallback) : null;
}

/** 링크와 응답 헤더가 공유하는 URI 디코딩 실패 규칙. 호출부가 각자의 대체값을 고른다. */
function decodedUriComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function downloadSessionLinkedFile(
  source: ProviderId,
  id: string,
  href: string,
): Promise<void> {
  return downloadLinkedFile("session", sessionLinkedFileRef(source, id, href), href);
}

export function downloadChatLinkedFile(chatId: string, href: string): Promise<void> {
  return downloadLinkedFile("chat", chatLinkedFileRef(chatId, href), href);
}

export function downloadDeployedInstructionLinkedFile(
  scope: InstructionScope,
  projectPath: string | null,
  provider: ProviderId,
  currentPath: string | null,
  href: string,
): Promise<void> {
  return downloadLinkedFile(
    "instruction",
    deployedInstructionLinkedFileRef(scope, projectPath, provider, currentPath, href),
    href,
  );
}

/** 문서 파일 자체. HTTP 봉투와 네이티브 복사 자리가 같은 모양이라 한 벌이 둘을 겸한다. */
export function downloadDocumentFile(rootId: string, relativePath: string): Promise<void> {
  const documentRef: DocumentFileRef = { rootId, relativePath };
  return downloadLinkedFile("document", documentRef, relativePath, documentRef);
}

/** 문서 안의 링크. 네이티브 복사 자리는 같은 봉투에서 파생한다(`documentFileRefOf`). */
export function downloadDocLinkedFile(
  rootId: string,
  currentPath: string,
  href: string,
): Promise<void> {
  const request = docLinkedFileRef(rootId, currentPath, href);
  return downloadLinkedFile("doc", request, href, documentFileRefOf(request));
}
