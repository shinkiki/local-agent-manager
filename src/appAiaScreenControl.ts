import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createAiaScreenBridge } from "./lib/aiaScreenBridge";
import { isViewId, resolveUiGuideTarget, UI_GUIDE_VIEW_TABS, uiGuideAnchorSelector } from "./lib/uiGuide";
import { activateUiElement, collectVisibleUiElements, locateUiElement, rankUiElements, uiClickRefusal } from "./lib/uiElements";
import type { UiCursorState } from "./components/UiCursor";
import { waitForVisibleElement } from "./lib/waitForVisibleElement";
import { e2eHooksEnabled, installE2eHooks } from "./lib/e2eHooks";
import { answerUiQuery } from "./lib/ipc";
import type { PopoutRequest } from "./lib/popout";
import type { ChatEvent, ViewId } from "./types";

interface UiGuideState {
  requestId: number;
  view: ViewId | null;
  label: string;
  note: string | null;
  element: Element;
}

/** AIA가 화면에 보내는 세 요청. 셋 다 본 창의 DOM 참조를 쓰므로 같은 통로로 오간다. */
type UiGuideRequest = Pick<Extract<ChatEvent, { type: "uiGuide" }>, "target" | "element" | "note">;
type UiQueryEvent = Extract<ChatEvent, { type: "uiQuery" }>;
type UiClickEvent = Extract<ChatEvent, { type: "uiClick" }>;

/** 창을 건너 넘기는 요청 한 건. 넘겨받은 쪽이 어떤 처리기를 부를지 `kind`로 가른다. */
type ScreenRequest =
  | { kind: "guide"; event: UiGuideRequest }
  | { kind: "query"; event: UiQueryEvent }
  | { kind: "click"; event: UiClickEvent };

interface ScreenHandlers {
  showUiGuide: (event: UiGuideRequest) => Promise<boolean>;
  answerAiaUiQuery: (event: UiQueryEvent) => void;
  performAiaUiClick: (event: UiClickEvent) => void;
}

const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
const waitMs = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
/**
 * 화면이 실제로 그려질 때까지 한 박자 쉰다. 한 프레임으로는 모자란다 — 상태를 바꾼
 * 렌더가 한 프레임, 그 결과가 배치되는 것이 다음 프레임이라 두 번을 기다려야 조회·클릭이
 * 방금 연 화면의 요소를 본다.
 */
const settleFrames = async () => { await nextFrame(); await nextFrame(); };

/** 상자 한가운데. 커서는 언제나 대상의 중심을 향한다. */
function boxCenter(box: { left: number; top: number; width: number; height: number }) {
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

/**
 * 백엔드는 화면 응답을 3초만 기다린다. 그 뒤 도착한 답은 받는 곳이 없으므로 실패로
 * 올리지 않고 버린다. 조회도 클릭도 같은 계약이라 응답 경로를 한 벌로 둔다.
 */
async function answerUiQueryQuietly(queryId: string, answer: unknown) {
  try {
    await answerUiQuery(queryId, answer);
  } catch {
    // 백엔드가 이미 기다림을 끝냈다. 다음 조회에서 다시 답한다.
  }
}

/** 커서가 처음 나타나는 자리. AIA 트리거에서 출발해야 누가 누르는지 보인다. */
function cursorHomePosition(trigger: HTMLButtonElement | null): UiCursorState {
  const origin = trigger?.getBoundingClientRect();
  const at = origin ? boxCenter(origin) : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return { ...at, pressing: false };
}

/** 커서가 대상 위에서 머무는 시간. 누르기 전 이동, 누른 상태, 누른 뒤 여운 순서다. */
const CURSOR_TRAVEL_MS = 700;
const CURSOR_PRESS_MS = 120;
const CURSOR_LINGER_MS = 1_400;

/**
 * AIA가 화면을 누를 때 보이는 커서 한 벌. 클릭 절차는 "옮기고·누르고·조작하고·떼고·
 * 거둔다"인데, 그 사이사이가 모두 대기라서 다음 클릭 요청이 언제든 끼어든다. 그래서 판마다
 * 번호를 매겨 두고, 끼어든 판이 있으면 앞선 판이 스스로 멈춘다 — 멈추지 않으면 새 판이
 * 옮겨 놓은 커서를 앞 판의 뒷정리가 지워 버린다.
 *
 * 어디를 누를지·눌러도 되는지는 부르는 쪽이 정하고, 여기는 커서의 자리와 판 번호만 든다.
 */
function useAiaCursor(triggerRef: { current: HTMLButtonElement | null }) {
  const [uiCursor, setUiCursor] = useState<UiCursorState | null>(null);
  const runSeq = useRef(0);
  /** 새 판을 연다. 커서는 직전 자리(처음이면 AIA 트리거)에서 출발해야 누가 누르는지 보인다. */
  const start = useCallback(() => {
    runSeq.current += 1;
    setUiCursor((current) => ({ ...(current ?? cursorHomePosition(triggerRef.current)), pressing: false }));
    return runSeq.current;
  }, [triggerRef]);
  /** 이 판이 아직 최신인지. 대기에서 깨어날 때마다 물어 남은 절차를 이어갈지 정한다. */
  const latest = useCallback((token: number) => runSeq.current === token, []);
  const place = useCallback((at: { x: number; y: number }, pressing: boolean) => {
    setUiCursor({ ...at, pressing });
  }, []);
  /** 판이 끝나면 커서를 거둔다. 이미 다음 판이 열렸으면 그 커서를 건드리지 않는다. */
  const clear = useCallback((token: number) => {
    if (runSeq.current === token) setUiCursor(null);
  }, []);
  return { uiCursor, start, latest, place, clear };
}

/**
 * 다른 창으로 화면 요청을 넘기는 통로.
 *
 * 요소를 찍을 때 붙인 DOM 참조는 그 참조를 만든 창에서만 유효하다. 그래서 전용 창(팝아웃)에서
 * 온 안내·조회·클릭은 언제나 본 창이 대신 수행해야 하고, 본 창은 반대로 그 요청을 받아 자기
 * 화면에서 처리한다. 통로를 여는 일과 처리기를 고르는 일을 여기로 모아 두면, 화면 조작 본체는
 * "무엇을 어떻게 누르는가"만 들고 있으면 된다.
 *
 * 처리기는 참조로 받는다. 매 렌더마다 새로 만들어지는 콜백을 의존성에 넣으면 통로가 그때마다
 * 닫혔다 열려, 마침 오가던 요청이 받는 곳 없이 사라진다.
 */
function useAiaScreenBridge(popoutRequest: PopoutRequest | null, handlers: { current: ScreenHandlers }) {
  const bridge = useRef<ReturnType<typeof createAiaScreenBridge<ScreenRequest>> | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const connection = createAiaScreenBridge<ScreenRequest>(!popoutRequest, async (request) => {
      if (request.kind === "guide") return handlers.current.showUiGuide(request.event);
      if (request.kind === "query") handlers.current.answerAiaUiQuery(request.event);
      else if (request.kind === "click") handlers.current.performAiaUiClick(request.event);
      else return false;
      return true;
    });
    bridge.current = connection;
    return () => { bridge.current = null; connection.close(); };
  }, [handlers, popoutRequest]);
  /** 넘기지 못했으면 false. 부르는 쪽이 그때의 대비책을 정한다. */
  return useCallback((request: ScreenRequest) => bridge.current?.request(request) ?? Promise.resolve(false), []);
}

/**
 * 화면 안내 포인터 한 벌. 안내는 자기만의 상태 기계다 — 대상 화면·탭을 열고, 요소가 보일
 * 때까지 기다려 세우고, 팝업이 덮으면 비켜나고, 안내한 화면을 떠나면 스스로 거둔다. 이
 * 규칙들은 조회·클릭과 공유하는 것이 없으므로 여기에 모아 두고, 밖에는 안내를 세우는
 * 창구와 지금 서 있는 안내만 내보낸다.
 *
 * 조회·클릭이 쓰는 것은 둘뿐이다 — 대상 화면을 여는 `openViewForGuide`와, 방금 다룬 요소
 * 위에 그대로 안내를 세우는 `presentUiGuideHere`.
 */
function useUiGuidePresenter({ view, activateView, requestGuideTab, setAiaOpen }: {
  view: ViewId;
  activateView: (next: ViewId) => void;
  requestGuideTab: (view: ViewId, tab: string) => void;
  setAiaOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const [uiGuide, setUiGuide] = useState<UiGuideState | null>(null);
  const uiGuideSeq = useRef(0);
  // 클릭·안내가 끝난 뒤의 "지금 화면". 콜백이 만들어질 때의 `view`를 그대로 안내에 실으면,
  // AIA가 주 메뉴처럼 화면을 바꾸는 요소를 눌렀을 때 안내가 이전 화면 것으로 기록되어
  // 아래 "안내한 화면을 떠나면 거둔다" 효과가 말풍선을 그 자리에서 닫아 버린다.
  const viewRef = useRef(view);
  viewRef.current = view;
  const [aiaGuideYield, setAiaGuideYield] = useState(false);
  const reopenAiaAfterGuideRef = useRef(false);
  // 지금 서 있는 안내. 거두기 요청이 자기 안내를 가리키는지 렌더를 기다리지 않고 가릴 수
  // 있어야 해서 상태와 함께 참조로도 들고 있다.
  const uiGuideRef = useRef<UiGuideState | null>(null);
  /**
   * 안내를 거둔다. `requestId`를 주면 그 안내가 아직 서 있을 때만 거둔다.
   *
   * QA #67 — 연속 안내에서 앞선 안내의 UiGuidePointer가 대상 요소가 DOM에서 빠진 것을
   * 뒤늦게 알아채고 거두기를 부르면, 그사이 새로 세운 안내까지 함께 지워졌다. 그래서
   * 탭을 옮겨 가며 안내하면 마지막 안내만 서자마자 사라졌다.
   */
  const dismissUiGuide = useCallback((requestId?: number) => {
    if (requestId !== undefined && uiGuideRef.current?.requestId !== requestId) return;
    uiGuideRef.current = null;
    setUiGuide(null);
    setAiaGuideYield(false);
    if (reopenAiaAfterGuideRef.current) {
      reopenAiaAfterGuideRef.current = false;
      setAiaOpen(true);
    }
  }, [setAiaOpen]);
  // 화면·탭을 열어 달라는 요청을 실행하고, 그 화면 패널이 실제로 보일 때까지 기다린다.
  const openViewForGuide = useCallback(async (viewId: string | null, tab: string | null) => {
    // 전용 창은 대화가 전체를 덮으므로 메뉴·상단바를 찾기 전에 앱 화면을 드러낸다.
    if (document.querySelector(".aia-chat-popup.standalone.open")) {
      reopenAiaAfterGuideRef.current = true;
      setAiaOpen(false);
      await nextFrame();
    }
    if (!viewId || !isViewId(viewId)) return viewId === null;
    activateView(viewId);
    if (tab && UI_GUIDE_VIEW_TABS[viewId]?.includes(tab)) requestGuideTab(viewId, tab);
    return Boolean(await waitForVisibleElement(`[data-view="${viewId}"]`));
  }, [activateView, requestGuideTab, setAiaOpen]);
  const presentUiGuide = useCallback((element: Element, guideView: ViewId | null, label: string, note: string | null) => {
    // 화면보다 긴 대상(설정 화면의 시스템 에이전트 블록 등)을 가운데로 맞추면 머리말도 첫
    // 조작도 없는 중간만 남는다. 그런 대상은 시작 부분부터 보여 준다.
    const tall = element.getBoundingClientRect().height > window.innerHeight - 80;
    element.scrollIntoView({ block: tall ? "start" : "center", inline: "nearest" });
    uiGuideSeq.current += 1;
    const next: UiGuideState = { requestId: uiGuideSeq.current, view: guideView, label, note, element };
    uiGuideRef.current = next;
    setUiGuide(next);
  }, []);
  /** 지금 화면에 묶어 세우는 안내. 화면을 옮기지 않은 자리(요소 직접 지정·클릭 뒤)가 쓴다. */
  const presentUiGuideHere = useCallback((element: Element, label: string, note: string | null) => {
    presentUiGuide(element, viewRef.current, label, note);
  }, [presentUiGuide]);
  const showUiGuide = useCallback(async (request: UiGuideRequest) => {
    if (request.target) {
      const target = resolveUiGuideTarget(request.target);
      if (!target) return false;
      await openViewForGuide(target.view, target.tab);
      const element = await waitForVisibleElement(uiGuideAnchorSelector(target.anchor));
      if (!element) return false;
      presentUiGuide(element, target.view, target.description, request.note);
      return true;
    }
    if (request.element) {
      // 등록되지 않은 요소는 지금 화면에서 되찾는다. 스캔 때 붙인 ref가 살아 있으면 그것,
      // 화면이 다시 그려져 사라졌으면 텍스트·역할로 다시 찾는다.
      const element = locateUiElement(request.element);
      if (!element) return false;
      presentUiGuideHere(element, request.element.text ?? request.element.ref ?? "", request.note);
      return true;
    }
    return false;
  }, [openViewForGuide, presentUiGuide, presentUiGuideHere]);
  // 팝업이 대상을 덮고 있으면 비켜난다. 좁은 화면에서는 팝업이 거의 전체를 덮어 비켜날 곳이
  // 없으므로 잠시 닫고, 안내가 끝나면 다시 연다.
  useEffect(() => {
    if (!uiGuide) return;
    const popup = document.querySelector(".aia-chat-popup.open");
    if (!popup) return;
    const anchor = uiGuide.element.getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    const overlaps = anchor.left < box.right && anchor.right > box.left && anchor.top < box.bottom && anchor.bottom > box.top;
    if (!overlaps) return;
    if (popup.classList.contains("standalone") || window.matchMedia("(max-width: 760px)").matches) {
      reopenAiaAfterGuideRef.current = true;
      setAiaOpen(false);
    } else {
      setAiaGuideYield(true);
    }
  }, [setAiaOpen, uiGuide]);
  // 안내한 화면을 떠나면 포인터도 거둔다.
  useEffect(() => {
    if (uiGuide?.view && uiGuide.view !== view) dismissUiGuide();
  }, [dismissUiGuide, uiGuide, view]);

  return { uiGuide, aiaGuideYield, dismissUiGuide, openViewForGuide, presentUiGuideHere, showUiGuide };
}

/**
 * AIA가 화면을 직접 다루는 세 경로(show_ui_guide·find_ui_elements·click_ui_element)와
 * 그 결과로 뜨는 안내 포인터·커서 상태를 한곳에 모은다. App은 화면 전환(`activateView`)과
 * 탭 요청(`requestGuideTab`)만 넘기고, 어떤 순서로 열고 얼마나 기다릴지는 여기서 정한다.
 *
 * 안내 포인터의 상태 기계는 `useUiGuidePresenter`가 들고 있고, 여기 남은 것은 조회·클릭과
 * 전용 창 우회다.
 */
export function useAiaScreenControl({ view, activateView, requestGuideTab, aiaTriggerRef, setAiaOpen, popoutRequest }: {
  popoutRequest: PopoutRequest | null;
  view: ViewId;
  activateView: (next: ViewId) => void;
  requestGuideTab: (view: ViewId, tab: string) => void;
  aiaTriggerRef: { current: HTMLButtonElement | null };
  setAiaOpen: Dispatch<SetStateAction<boolean>>;
}) {
  // AIA 화면 안내(show_ui_guide): 대상 화면·탭을 열고 요소가 실제로 보일 때까지 기다린 뒤
  // 포인터를 띄운다. false를 돌려주면 팝업이 "찾지 못했다"고 알린다.
  const { uiGuide, aiaGuideYield, dismissUiGuide, openViewForGuide, presentUiGuideHere, showUiGuide } =
    useUiGuidePresenter({ view, activateView, requestGuideTab, setAiaOpen });
  // AIA의 요소 조회(find_ui_elements): 요청한 화면·탭을 열고 두 프레임 뒤에 보이는 조작 요소를
  // 스캔해 query에 맞는 것부터 답한다.
  const answerAiaUiQuery = useCallback((event: UiQueryEvent) => {
    void (async () => {
      const opened = await openViewForGuide(event.view, event.tab);
      await settleFrames();
      let candidates = collectVisibleUiElements();
      if (candidates.length === 0 && opened && event.view) {
        // lazy 화면은 패널이 보인 뒤에도 내용이 잠시 늦게 그려진다.
        await waitMs(400);
        candidates = collectVisibleUiElements();
      }
      const elements = rankUiElements(candidates, event.query).map(({ ref, role, text, anchor }) => ({ ref, role, text, anchor }));
      await answerUiQueryQuietly(event.id, elements);
    })();
  }, [openViewForGuide]);
  // AIA 커서 클릭(open/click_ui_element): 요소를 되찾아 눌러도 되는지 판단하고, 커서를 마지막
  // 위치(처음엔 AIA 트리거)에서 대상까지 움직인 뒤 누른다. 결과와 거절 이유는 그대로 답한다.
  // 커서 자리(`uiCursor`)는 클릭 한 번에 다섯 번 바뀐다. 창구를 따로 받아 두면 아래 절차가
  // 그 상태에 의존하지 않아, 커서가 움직이는 동안 클릭 처리기가 새로 만들어지지 않는다.
  const { uiCursor, start: startCursor, latest: cursorLatest, place: placeCursor, clear: clearCursor } = useAiaCursor(aiaTriggerRef);
  const performAiaUiClick = useCallback((event: UiClickEvent) => {
    void (async () => {
      const element = locateUiElement(event.element);
      if (!element) {
        await answerUiQueryQuietly(event.id, { clicked: false, reason: "요소를 화면에서 찾지 못했습니다. find_ui_elements로 다시 찍어 주세요" });
        return;
      }
      const refusal = uiClickRefusal(element, event.mode);
      if (refusal) {
        await answerUiQueryQuietly(event.id, { clicked: false, reason: refusal });
        return;
      }
      element.scrollIntoView({ block: "center", inline: "nearest" });
      const token = startCursor();
      // 대상 자리는 커서가 화면에 오른 뒤에 잰다. 스크롤이 끝나기 전에 재면 커서가 엉뚱한
      // 자리를 누르는 것처럼 보인다.
      await settleFrames();
      const target = boxCenter(element.getBoundingClientRect());
      placeCursor(target, false);
      await waitMs(CURSOR_TRAVEL_MS);
      if (!cursorLatest(token)) return;
      placeCursor(target, true);
      await waitMs(CURSOR_PRESS_MS);
      const text = element.getAttribute("aria-label") ?? (element as HTMLElement).innerText?.trim() ?? "";
      activateUiElement(element);
      placeCursor(target, false);
      await answerUiQueryQuietly(event.id, { clicked: true, text });
      if (event.note) {
        // 클릭이 화면을 바꿨다면 그 전환이 그려진 뒤의 화면을 안내에 기록해야 말풍선이
        // "막 데려간 화면"의 것으로 남는다. 응답 왕복만으로는 렌더가 끝났다고 보장할 수 없다.
        await settleFrames();
        presentUiGuideHere(element, text, event.note);
      }
      await waitMs(CURSOR_LINGER_MS);
      clearCursor(token);
    })();
  }, [clearCursor, cursorLatest, placeCursor, presentUiGuideHere, startCursor]);

  // 전용 창은 자기가 찍은 요소만 되찾을 수 있으므로 화면 조작은 늘 본 창이 맡는다.
  const screenHandlers = useRef<ScreenHandlers>({ showUiGuide, answerAiaUiQuery, performAiaUiClick });
  screenHandlers.current = { showUiGuide, answerAiaUiQuery, performAiaUiClick };
  const forwardToMainWindow = useAiaScreenBridge(popoutRequest, screenHandlers);
  const popout = popoutRequest?.kind === "aia";
  const routedGuide = useCallback((event: UiGuideRequest) => (popout
    ? forwardToMainWindow({ kind: "guide", event })
    : showUiGuide(event)), [forwardToMainWindow, popout, showUiGuide]);
  const routedQuery = useCallback((event: UiQueryEvent) => {
    if (!popout) return answerAiaUiQuery(event);
    // 본 창에 닿지 못했으면 빈 목록으로 답한다. 답이 없으면 AIA가 3초를 그냥 기다린다.
    void forwardToMainWindow({ kind: "query", event }).then((sent) => {
      if (!sent) void answerUiQueryQuietly(event.id, []);
    });
  }, [answerAiaUiQuery, forwardToMainWindow, popout]);
  const routedClick = useCallback((event: UiClickEvent) => {
    if (!popout) return performAiaUiClick(event);
    void forwardToMainWindow({ kind: "click", event }).then((sent) => {
      if (!sent) void answerUiQueryQuietly(event.id, { clicked: false, reason: "메인 창에 연결하지 못했습니다. 메인 창을 열고 다시 요청해 주세요." });
    });
  }, [forwardToMainWindow, performAiaUiClick, popout]);
  // Test the same routing callbacks that the AIA conversation uses.
  useEffect(() => (e2eHooksEnabled() ? installE2eHooks(window, { showUiGuide: routedGuide, answerAiaUiQuery: routedQuery, performAiaUiClick: routedClick }) : undefined), [routedGuide, routedQuery, routedClick]);
  return { uiGuide, uiCursor, aiaGuideYield, dismissUiGuide, showUiGuide: routedGuide, answerAiaUiQuery: routedQuery, performAiaUiClick: routedClick };
}
