import { useEffect } from "react";
import { hasNativeShell } from "./backend";
import {
  formatPopoutWindowTitle,
  popoutDefaultTitle,
  popoutSearch,
  popoutWindowName,
  type PopoutRequest,
} from "./popout";
import type { AppLocale } from "../types";
import { enableAiaWindowSessions } from "./aiaWindowSession";
import { diagramPopoutSearch, diagramPopoutWindowName, stashDiagramSource } from "./diagramPopout";
import { runtimeText } from "./i18nRuntime";
import { phraseText, type Phrase } from "./phrase";

/** 창 크기는 브라우저 팝업과 네이티브 창이 같아야 두 셸에서 같은 화면이 뜬다. */
const POPOUT_WIDTH = 1080;
const POPOUT_HEIGHT = 760;

/**
 * 셸마다 다른 창 조작 한 벌 — 대상 창 열기, 이 창 닫기, 이 창 제목 맞추기.
 *
 * 셋이 각자 `hasNativeShell()`을 묻고 그 안에서 Tauri API를 동적으로 가져오고 있었다.
 * 그러면 "브라우저와 네이티브가 무엇이 다른가"가 세 함수 본문에 흩어져, 네 번째 조작을
 * 더하는 사람은 어느 쪽이 무엇을 하는지 셋을 모두 읽어야 알 수 있다. 판정은 한 줄
 * (`popoutShell`)에서만 하고, 셸별로 다른 것은 아래 두 구현이 나란히 들고 있게 한다.
 */
interface PopoutShell {
  /** 팝아웃 대상 창을 연다. 열지 못하면 호출부가 문구로 보여 주도록 예외로 올린다. */
  open(name: string, search: string, title: string): Promise<void>;
  /** 지금 창(팝아웃 자신)을 닫는다. */
  close(): Promise<void>;
  /** 지금 창의 타이틀바 제목. 웹 문서 제목은 셸과 무관하므로 호출부가 따로 맞춘다. */
  setTitle(title: string): Promise<void>;
}

const browserShell: PopoutShell = {
  open(name, search) {
    const url = new URL(window.location.href);
    url.search = search;
    url.hash = "";
    const popup = window.open(url.href, name, `width=${POPOUT_WIDTH},height=${POPOUT_HEIGHT},resizable=yes`);
    if (!popup) throw new Error("브라우저가 팝업을 차단했습니다. 이 사이트의 팝업을 허용해 주세요.");
    popup.focus();
    return Promise.resolve();
  },
  close() {
    window.close();
    return Promise.resolve();
  },
  // 브라우저 창에는 따로 맞출 타이틀바가 없다. document.title은 호출부가 이미 맞춘 뒤다.
  setTitle: () => Promise.resolve(),
};

/**
 * 현재 네이티브 창. Tauri API는 브라우저 번들에 실을 수 없어 쓰는 자리에서만 가져오는데,
 * 그 동적 가져오기를 한 곳에 모아 두면 네이티브 여부 판정과 모듈 경로가 갈라지지 않는다.
 */
async function currentNativeWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

const nativeShell: PopoutShell = {
  /**
   * 같은 label의 창이 이미 있으면 새로 만들지 않고 앞으로 가져온다. 창 생성은 이벤트로
   * 끝나므로 만들어졌다는 신호를 받을 때까지 기다려, 실패를 호출부가 팝업 차단과 같은
   * 자리에서 문구로 받을 수 있게 한다.
   */
  async open(name, search, title) {
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
      title: formatPopoutWindowTitle(title),
      width: POPOUT_WIDTH,
      height: POPOUT_HEIGHT,
      minWidth: 640,
      minHeight: 480,
      // 웹뷰가 OS 드롭을 가로채면 화면의 드래그 앤 드롭 첨부가 동작하지 않는다. 메인 창과 같은 규칙.
      dragDropEnabled: false,
    });
    await new Promise<void>((resolve, reject) => {
      void popout.once("tauri://created", () => resolve());
      void popout.once("tauri://error", (event) => reject(new Error(
        typeof event.payload === "string" ? event.payload : "새 창을 만들지 못했습니다.",
      )));
    });
  },
  // 창을 닫을 수 없으면(창이 이미 사라진 뒤) 조용히 무시한다.
  async close() {
    const nativeWindow = await currentNativeWindow();
    await nativeWindow.close().catch(() => undefined);
  },
  async setTitle(title) {
    const nativeWindow = await currentNativeWindow();
    await nativeWindow.setTitle(title);
  },
};

/** 지금 셸에 맞는 창 조작. 셸을 묻는 자리는 여기 하나뿐이다. */
function popoutShell(): PopoutShell {
  return hasNativeShell() ? nativeShell : browserShell;
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
  await openPopoutTarget(popoutWindowName(request), popoutSearch(request), popoutDefaultTitle(request));
}

/**
 * 다이어그램 창의 기본 제목. `PopoutRequest`의 종류가 아니라 규약 표에 자리가 없지만,
 * 표기만은 다른 팝아웃과 같은 모양으로 적어 같은 해석 규칙(`phraseText`)을 탄다 —
 * 제목을 고르는 자리가 이 파일에 두 벌 있으면 `en`이 없는 고유명을 언젠가 한쪽만
 * 번역 카탈로그에 태우게 된다.
 */
const DIAGRAM_POPOUT_TITLE: Phrase = { ko: "다이어그램", en: "Diagram" };

/**
 * 다이어그램을 별도 창으로 연다. 원문은 주소에 실을 수 없어 같은 origin이 공유하는 저장소로
 * 넘기고(`diagramPopout`), 주소에는 그 열쇠만 싣는다. 열쇠가 원문의 해시라 같은 그림을 다시
 * 열면 창이 늘지 않고 이미 열린 창이 앞으로 온다.
 *
 * 이 팝아웃은 `PopoutRequest`의 종류가 아니다. 나머지 셋(AIA·채팅·세션)은 새 창이 앱 셸을
 * 띄우고 백엔드에서 대상을 읽어 오지만, 다이어그램 창은 백엔드가 필요 없어 앱 셸 없이 뜬다.
 */
export async function openDiagramWindow(source: string, locale: AppLocale): Promise<void> {
  const id = stashDiagramSource(window.localStorage, source, locale);
  await openPopoutTarget(diagramPopoutWindowName(id), diagramPopoutSearch(id), DIAGRAM_POPOUT_TITLE);
}

/**
 * 셸에 맞는 창 열기. 팝아웃 종류를 모르는 자리도 이름·주소·제목만 있으면 창을 띄운다.
 *
 * 제목은 두 언어 표기(`Phrase`)로 받아 **여기서** 지금 언어로 푼다. 위의 두 진입점이
 * 각자 `phraseText(…, runtimeText)`를 적고 있었는데, 그 둘은 반드시 같아야 한다 —
 * 한쪽만 다른 손잡이를 쓰거나 `en`이 `null`인 고유명의 처리를 건너뛰면, 같은 앱에서 연
 * 팝아웃 제목이 무엇을 열었는지에 따라 다른 언어로 뜬다. 창을 여는 자리가 하나이므로
 * 언어를 고르는 자리도 하나면 그 어긋남이 생길 자리가 없다.
 */
async function openPopoutTarget(name: string, search: string, title: Phrase): Promise<void> {
  await popoutShell().open(name, search, phraseText(title, runtimeText));
}

/** 팝아웃 창 자신을 닫는다. 창을 닫을 수 없으면(브라우저 정책) 조용히 무시한다. */
export async function closePopoutWindow(): Promise<void> {
  await popoutShell().close();
}

/**
 * 팝아웃 창의 제목을 대상 이름으로 맞춘다. 웹 창은 document.title, 네이티브 창은
 * 타이틀바를 함께 갱신한다. 본 창의 제목까지 바꾸지 않도록, 팝아웃이 아닐 때는
 * 호출부가 null을 넘겨 아무것도 하지 않게 한다.
 */
export function usePopoutWindowTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return;
    const windowTitle = formatPopoutWindowTitle(title);
    document.title = windowTitle;
    // 제목 갱신 실패는 화면 동작과 무관하므로 조용히 넘긴다.
    void popoutShell().setTitle(windowTitle).catch(() => undefined);
  }, [title]);
}
