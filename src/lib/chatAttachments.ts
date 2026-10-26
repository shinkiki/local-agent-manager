import type { ChatInputFile } from "../types";
import { backendHttpUrl, hasNativeShell } from "./backend.ts";
import { assertRemoteChatAccess } from "./chatAccess.ts";
import { responseError, withLoginSession } from "./ipcTransport.ts";

export async function uploadChatInputFile(chatId: string, file: File): Promise<ChatInputFile> {
  await assertRemoteChatAccess();
  const response = await chatAttachmentRequest("/api/chat-attachment", "첨부 파일을 올리지 못했습니다", {
    method: "POST",
    headers: {
      "x-chat-id": encodeURIComponent(chatId),
      "x-file-name": encodeURIComponent(file.name),
      "x-file-type": encodeURIComponent(file.type || "application/octet-stream"),
    },
    body: file,
  });
  const payload = await responseJsonOrNull<ChatInputFile>(response);
  if (!payload?.id) throw new Error("첨부 파일 응답이 올바르지 않습니다");
  return payload;
}

export async function readChatInputFile(chatId: string, file: ChatInputFile): Promise<Blob> {
  const response = await chatAttachmentRequest(
    chatAttachmentPath(chatId, file.id),
    "첨부 파일을 읽지 못했습니다",
    { cache: "no-store" },
  );
  return response.blob();
}

export function directChatInputFileUrl(chatId: string, file: ChatInputFile): string | null {
  // Tauri CSP는 loopback 이미지를 직접 삽입하지 않습니다. 백엔드에서 읽은 Blob URL을 사용합니다.
  if (hasNativeShell()) return null;
  return backendHttpUrl(chatAttachmentPath(chatId, file.id));
}

export async function removeChatInputFile(chatId: string, attachmentId: string): Promise<void> {
  await chatAttachmentRequest("/api/invoke/remove_chat_input_file", "첨부 파일을 삭제하지 못했습니다", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request: { chatId, attachmentId } }),
  });
}

/** 한 첨부 파일을 가리키는 백엔드 경로. 링크와 읽기가 같은 경로를 쓰도록 한 곳에서 만든다. */
function chatAttachmentPath(chatId: string, attachmentId: string): string {
  return `/api/chat-attachment/${encodeURIComponent(chatId)}/${encodeURIComponent(attachmentId)}`;
}

/** JSON 본문이 없거나 올바르지 않으면 null로 맞춘다. 성공·실패 응답이 같은 파싱 규칙을 쓴다. */
async function responseJsonOrNull<Value>(response: Response): Promise<Value | null> {
  try {
    return await response.json() as Value;
  } catch {
    return null;
  }
}

/**
 * 첨부 파일 API를 호출하고 실패 응답을 공통 처리기에 맡긴다. C20: 로그인 만료 응답은
 * 만료 토큰을 지우고 로그인 게이트를 다시 열어야 한다. 성공 본문은 호출부가 읽는다.
 */
async function chatAttachmentRequest(
  path: string,
  fallback: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(backendHttpUrl(path), withLoginSession(init));
  if (response.ok) return response;
  throw await responseError(response, fallback);
}
