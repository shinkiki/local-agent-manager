/**
 * 링크 파일을 내려받는 통로. 대화·채팅·지침·문서 네 화면이 같은 일을 하지만,
 * 그 일은 `call` 한 줄이 아니다 — 백엔드 다운로드 엔드포인트를 직접 두드리고,
 * 응답 헤더에서 파일 이름을 되짚고, 데스크톱이면 저장 대화상자를, 브라우저면
 * Blob 앵커를 쓴다. 명령 목록(`ipc.ts`)에 섞여 있으면 이 갈래가 명령 한 줄들
 * 사이에 묻혀 보이지 않으므로 통로만 따로 둔다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는
 * 예전 그대로 `lib/ipc`다.
 */
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { ProviderId } from "../types";
import { backendHttpUrl, hasNativeShell } from "./backend";
import { postJson, responseError } from "./ipcTransport";

async function downloadLinkedFile(
  endpoint: "session" | "chat" | "doc" | "document" | "instruction",
  request: Record<string, unknown>,
  href: string,
): Promise<void> {
  const fallbackName = linkedFileName(href);
  const response = await postJson(
    backendHttpUrl(`/api/download/linked-file/${endpoint}`),
    { request },
  );
  if (!response.ok) throw await responseError(response, "파일 다운로드에 실패했습니다");
  const fileName = responseFileName(response.headers.get("Content-Disposition")) ?? fallbackName;
  if (hasNativeShell()) {
    const destination = await saveDialog({
      title: "링크 파일 저장",
      defaultPath: fileName,
    });
    if (!destination) return;
    await invoke<void>(
      "save_downloaded_linked_file",
      new Uint8Array(await response.arrayBuffer()),
      {
        headers: {
          "x-destination": encodeURIComponent(destination),
          "x-relative-path": encodeURIComponent(fileName),
        },
      },
    );
    return;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function linkedFileName(href: string): string {
  let target = href.trim().replace(/^<|>$/g, "").split(/[?#]/, 1)[0].replace(/:\d+$/, "");
  try { target = decodeURIComponent(target); } catch { /* Keep the encoded fallback. */ }
  const name = target.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return sanitizeDownloadName(name || "download");
}

function responseFileName(disposition: string | null): string | null {
  if (!disposition) return null;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return sanitizeDownloadName(decodeURIComponent(encoded)); } catch { /* Use fallback. */ }
  }
  const fallback = disposition.match(/filename="([^"]+)"/i)?.[1];
  return fallback ? sanitizeDownloadName(fallback) : null;
}

function sanitizeDownloadName(name: string): string {
  const safe = name.replace(/[\\/\0]/g, "_").trim();
  return safe && safe !== "." && safe !== ".." ? safe : "download";
}

export function downloadSessionLinkedFile(
  source: ProviderId,
  id: string,
  href: string,
): Promise<void> {
  return downloadLinkedFile("session", { source, id, href }, href);
}

export function downloadChatLinkedFile(chatId: string, href: string): Promise<void> {
  return downloadLinkedFile("chat", { chatId, href }, href);
}

export function downloadDeployedInstructionLinkedFile(
  scope: "personal" | "project",
  projectPath: string | null,
  provider: ProviderId,
  currentPath: string | null,
  href: string,
): Promise<void> {
  return downloadLinkedFile(
    "instruction",
    { scope, projectPath, provider, currentPath, href },
    href,
  );
}

export function downloadDocumentFile(rootId: string, relativePath: string): Promise<void> {
  return downloadLinkedFile("document", { rootId, relativePath }, relativePath);
}

export function downloadDocLinkedFile(
  rootId: string,
  currentPath: string,
  href: string,
): Promise<void> {
  return downloadLinkedFile("doc", { rootId, currentPath, href }, href);
}
