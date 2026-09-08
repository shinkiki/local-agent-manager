import { useEffect } from "react";
import { hasNativeShell } from "./backend";
import { popoutSearch, popoutWindowName, type PopoutRequest } from "./popout";
import { enableAiaWindowSessions } from "./aiaWindowSession";

/** 창 크기는 브라우저 팝업과 네이티브 창이 같아야 두 셸에서 같은 화면이 뜬다. */
const POPOUT_WIDTH = 1080;
const POPOUT_HEIGHT = 760;

/**
 * 현재 네이티브 창. Tauri API는 브라우저 번들에 실을 수 없어 쓰는 자리에서만 가져오는데,
 * 그 동적 가져오기를 한 곳에 모아 두면 네이티브 여부 판정과 모듈 경로가 갈라지지 않는다.
 */
async function currentNativeWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** 브라우저 셸의 팝아웃. 팝업 차단은 호출부가 문구로 보여 줘야 하므로 예외로 올린다. */
function openBrowserPopout(name: string, search: string): void {
  const url = new URL(window.location.href);
  url.search = search;
  url.hash = "";
  const popup = window.open(url.href, name, `width=${POPOUT_WIDTH},height=${POPOUT_HEIGHT},resizable=yes`);
  if (!popup) throw new Error("브라우저가 팝업을 차단했습니다. 이 사이트의 팝업을 허용해 주세요.");
  popup.focus();
}

/**
 * 네이티브 셸의 팝아웃. 같은 label의 창이 이미 있으면 새로 만들지 않고 앞으로 가져온다.
 * 창 생성은 이벤트로 끝나므로 만들어졌다는 신호를 받을 때까지 기다려, 실패를 호출부가
 * 팝업 차단과 같은 자리에서 문구로 받을 수 있게 한다.
 */
async function openNativePopout(name: string, search: string, request: PopoutRequest): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(name);
  if (existing) {
    // 이미 같은 대상을 띄운 창이 있으면 앞으로 가져오기만 한다. 포커스 실패는 무시한다.
    await existing.setFocus().catch(() => undefined);
    return;
  }
  const popout = new WebviewWindow(name, {
    url: `index.html${search}`,
    // 네이티브 창 제목은 만들 때 정한다. 웹 탭 제목은 화면에서 document.title로 맞춘다.
    title: request.kind === "aia" ? "AIA · Agent Manager" : request.kind === "chat" ? "채팅 · Agent Manager" : "세션 · Agent Manager",
    width: POPOUT_WIDTH,
    height: POPOUT_HEIGHT,
    minWidth: 640,
    minHeight: 480,
  });
  await new Promise<void>((resolve, reject) => {
    void popout.once("tauri://created", () => resolve());
    void popout.once("tauri://error", (event) => reject(new Error(
      typeof event.payload === "string" ? event.payload : "새 창을 만들지 못했습니다.",
    )));
  });
}

/**
 * 팝아웃 창을 연다. Tauri에서는 같은 앱의 WebviewWindow를 만들고, 브라우저에서는
 * 같은 origin의 창을 연다. 백엔드 상태는 서버가 공유하므로 두 창 모두 그대로 동작한다.
 *
 * 브라우저 팝업 차단을 피하려면 `window.open`이 클릭과 같은 처리 흐름에 있어야 하므로,
 * 호출부는 이 함수를 await 없이 바로 호출해야 하고 이 함수도 창을 열기 전에 대기하지 않는다.
 */
export async function openPopoutWindow(request: PopoutRequest): Promise<void> {
  if (request.kind === "aia") enableAiaWindowSessions(window.localStorage);
  const name = popoutWindowName(request);
  const search = popoutSearch(request);
  if (!hasNativeShell()) {
    openBrowserPopout(name, search);
    return;
  }
  await openNativePopout(name, search, request);
}

/** 팝아웃 창 자신을 닫는다. 창을 닫을 수 없으면(브라우저 정책) 조용히 무시한다. */
export async function closePopoutWindow(): Promise<void> {
  if (hasNativeShell()) {
    const nativeWindow = await currentNativeWindow();
    await nativeWindow.close().catch(() => undefined);
    return;
  }
  window.close();
}

/**
 * 팝아웃 창의 제목을 대상 이름으로 맞춘다. 웹 창은 document.title, 네이티브 창은
 * 타이틀바를 함께 갱신한다. 본 창의 제목까지 바꾸지 않도록, 팝아웃이 아닐 때는
 * 호출부가 null을 넘겨 아무것도 하지 않게 한다.
 */
export function usePopoutWindowTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return;
    const windowTitle = `${title} · Agent Manager`;
    document.title = windowTitle;
    if (!hasNativeShell()) return;
    // 제목 갱신 실패는 화면 동작과 무관하므로 조용히 넘긴다.
    void currentNativeWindow()
      .then((nativeWindow) => nativeWindow.setTitle(windowTitle))
      .catch(() => undefined);
  }, [title]);
}
