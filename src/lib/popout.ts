import type { ProviderId } from "../types";
import { isProviderId } from "./providerIds.ts";

/** 별도 창(팝아웃)으로 열 대상. 주소 쿼리로 전달되어 새 창이 해당 화면만 바로 연다. */
export type PopoutRequest =
  | { kind: "aia"; windowId: string }
  | { kind: "chat"; chatId: string }
  | { kind: "session"; source: ProviderId; sessionId: string };

/** 주소의 popout 쿼리를 해석한다. 값이 불완전하면 일반 화면으로 연다. */
export function parsePopoutRequest(search: string): PopoutRequest | null {
  const params = new URLSearchParams(search);
  const kind = params.get("popout");
  if (kind === "aia") {
    const windowId = params.get("window");
    return windowId && /^[A-Za-z0-9_-]{1,80}$/.test(windowId) ? { kind: "aia", windowId } : null;
  }
  if (kind === "chat") {
    const chatId = params.get("chat")?.trim();
    return chatId ? { kind: "chat", chatId } : null;
  }
  if (kind === "session") {
    const source = params.get("source");
    const sessionId = params.get("session")?.trim();
    if (!sessionId || !isProviderId(source)) return null;
    return { kind: "session", source, sessionId };
  }
  return null;
}

export function popoutSearch(request: PopoutRequest): string {
  const params = new URLSearchParams();
  params.set("popout", request.kind);
  if (request.kind === "aia") {
    params.set("window", request.windowId);
  } else if (request.kind === "chat") {
    params.set("chat", request.chatId);
  } else {
    params.set("source", request.source);
    params.set("session", request.sessionId);
  }
  return `?${params.toString()}`;
}

/**
 * 같은 대상을 다시 열면 창을 늘리지 않고 기존 창을 재사용하도록 대상별 고정 이름을
 * 만든다. Tauri 창 label 규칙(영숫자·-·_)에 맞춰 나머지 문자는 -로 치환한다.
 */
export function popoutWindowName(request: PopoutRequest): string {
  const target = request.kind === "aia" ? request.windowId : request.kind === "chat" ? request.chatId : `${request.source}-${request.sessionId}`;
  return `popout-${request.kind}-${target}`.replace(/[^0-9A-Za-z_-]/g, "-");
}
