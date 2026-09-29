import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { clampMatchIndex, findMatches, isFindShortcut, stepMatchIndex, topmostSurfaceIndex } from "../lib/findInPage";
import { useI18n } from "../lib/i18n";

/**
 * 대화 안에서 찾기(Cmd+F / Ctrl+F).
 *
 * 앱은 브라우저 창이 아니라 웹뷰라 공급자의 찾기 막대가 없다. 대화가 길어지면 위로
 * 굴려 눈으로 훑는 것 말고는 방법이 없어, 대화를 그리는 화면이 직접 찾기 막대를 세운다.
 * 채팅 대화·AIA 팝업·세션 상세가 같은 훅 하나를 쓴다.
 *
 * 글자는 **DOM 을 건드리지 않고** 칠한다 — 응답이 흘러들어오는 동안 React 가 다시 그리는
 * 자리에 `<mark>` 를 끼워 넣으면 그다음 렌더에서 사라지거나 트리가 어긋난다. CSS 사용자
 * 하이라이트(`CSS.highlights`)는 Range 만 넘기므로 트리를 그대로 둔 채 칠할 수 있고, 그
 * 이름이 없는 웹뷰에서는 현재 자리를 선택 영역으로 잡아 최소한 눈에 띄게 한다.
 *
 * 찾는 범위는 **지금 화면에 그려진 글**이다. 접힌 작업 내역은 애초에 DOM 에 없고
 * (`ChatActivityGroup`), 긴 세션 원문은 최신 쪽부터 창 단위로만 올라온다
 * (`SessionTranscript` 의 마운트 창·이전 대화 더보기). 그래서 아직 올라오지 않은 구간이
 * 남아 있으면 막대가 그 사실을 함께 적는다 — 찾은 수를 대화 전체의 수로 읽으면 없는
 * 것을 없다고 믿게 된다.
 */

const ALL_MATCHES_HIGHLIGHT = "chat-find";
const CURRENT_MATCH_HIGHLIGHT = "chat-find-current";

/** 아직 화면에 올라오지 않은 이전 구간이 남아 있다는 표식. 둘 다 컨테이너 안에 그려진다. */
const PENDING_HISTORY_SELECTOR = ".transcript-mount-boundary, .transcript-load-earlier";

type HighlightLike = object;
type HighlightConstructor = new (...ranges: Range[]) => HighlightLike;
interface HighlightRegistryLike {
  set(name: string, highlight: HighlightLike): void;
  delete(name: string): void;
}

/** CSS 사용자 하이라이트를 쓸 수 있는 웹뷰에서만 등록기를 돌려준다. */
function highlightApi(): { registry: HighlightRegistryLike; Highlight: HighlightConstructor } | null {
  if (typeof CSS === "undefined") return null;
  const registry = (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
  const Highlight = (window as unknown as { Highlight?: HighlightConstructor }).Highlight;
  if (!registry || typeof Highlight !== "function") return null;
  return { registry, Highlight };
}

function clearHighlights() {
  const api = highlightApi();
  if (!api) return;
  api.registry.delete(ALL_MATCHES_HIGHLIGHT);
  api.registry.delete(CURRENT_MATCH_HIGHLIGHT);
}

/**
 * 찾기를 붙일 수 있는 자리 한 곳. 한 문서에 여러 자리(대화 화면 + 그 위에 뜬 AIA 팝업)가
 * 같이 살아 있을 수 있는데, 하이라이트 이름은 문서 하나에 한 벌뿐이라 두 곳이 동시에
 * 칠하면 서로의 표시를 지운다. 그래서 단축키는 **가장 위에 떠 있는 한 곳**만 열고 나머지는
 * 닫는다. 어느 것이 위인지는 화면이 `priority` 로 적어 준다.
 */
interface FindSurface {
  priority: number;
  /** 지금 실제로 그려져 있는가. 감춰진 화면은 단축키를 가져가지 못한다. */
  available: () => boolean;
  open: () => void;
  close: () => void;
}

/**
 * 겹침 순서. 팝업은 세션 상세 위에, 세션 상세(드로어)는 대화 화면 위에 뜬다. 한 문서에
 * 여럿이 보일 때 단축키가 어디로 갈지는 이 표 하나로 정해진다.
 */
export const FIND_PRIORITY = {
  chatView: 10,
  sessionDrawer: 20,
  aiaPopup: 30,
} as const;

const findSurfaces = new Set<FindSurface>();
let shortcutListenerAttached = false;

function topmostFindSurface(): FindSurface | null {
  const surfaces = [...findSurfaces];
  const index = topmostSurfaceIndex(surfaces.map((surface) => ({
    priority: surface.priority,
    available: surface.available(),
  })));
  return index < 0 ? null : surfaces[index];
}

function handleFindShortcut(event: KeyboardEvent) {
  if (!isFindShortcut(event)) return;
  const target = topmostFindSurface();
  if (!target) return;
  event.preventDefault();
  for (const surface of findSurfaces) {
    if (surface !== target) surface.close();
  }
  target.open();
}

function registerFindSurface(surface: FindSurface): () => void {
  findSurfaces.add(surface);
  if (!shortcutListenerAttached) {
    window.addEventListener("keydown", handleFindShortcut);
    shortcutListenerAttached = true;
  }
  return () => {
    findSurfaces.delete(surface);
    if (findSurfaces.size === 0 && shortcutListenerAttached) {
      window.removeEventListener("keydown", handleFindShortcut);
      shortcutListenerAttached = false;
    }
  };
}

/** 컨테이너 안의 글 조각을 앞에서부터 모은다. 빈 조각은 찾을 것이 없으므로 건너뛴다. */
function textNodesIn(container: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue) nodes.push(node as Text);
  }
  return nodes;
}

/**
 * 이전 구간을 한 걸음 더 불러오는 단추. 화면이 이미 가지고 있는 두 단추 — 세션 원문의
 * '이전 대화 더보기'(서버에서 앞 구간을 읽어 온다)와 마운트 창의 '이전 대화 N개 더
 * 표시'(읽어 온 것을 DOM 에 올린다) — 를 그대로 누른다.
 *
 * 두 단추를 훅으로 따로 받지 않는 이유는, 그것이 사용자가 직접 할 일과 정확히 같은
 * 동작이고 세 화면(채팅·팝업·세션 상세)이 모두 같은 단추를 쓰기 때문이다. 손잡이를
 * 새로 뚫으면 화면 세 곳에 같은 배선을 깔고도 결국 같은 조회를 부르게 된다.
 */
const EXPAND_BUTTON_SELECTOR = ".transcript-mount-boundary button, .transcript-load-earlier button";

/** 한 번의 '전체 찾기'가 누를 수 있는 최대 걸음. 끝없이 도는 것을 막는 상한이다. */
const MAX_EXPAND_STEPS = 200;
/** 한 걸음이 화면을 바꾸기를 기다리는 시간. 넘기면 더 불러올 수 없다고 보고 멈춘다. */
const EXPAND_CHANGE_TIMEOUT_MS = 6_000;
/** 불러오는 중이라 단추가 잠겨 있을 때 기다리는 시간. */
const EXPAND_BUSY_TIMEOUT_MS = 6_000;

/** 컨테이너 안이 바뀔 때까지(또는 시간이 다할 때까지) 기다린다. */
function waitForChange(container: HTMLElement, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer = 0;
    const observer = new MutationObserver(() => {
      window.clearTimeout(timer);
      observer.disconnect();
      resolve(true);
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    timer = window.setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeoutMs);
  });
}

/** 찾은 자리가 컨테이너 밖에 있으면 화면 위쪽 1/3 지점으로 끌어온다. */
function revealMatch(container: HTMLElement, range: Range) {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const box = container.getBoundingClientRect();
  if (rect.top >= box.top + 24 && rect.bottom <= box.bottom - 24) return;
  const top = container.scrollTop + rect.top - box.top - container.clientHeight / 3;
  container.scrollTo({ top: Math.max(0, top), behavior: "auto" });
}

export function useChatFind({ containerRef, enabled, resetKey, priority = 0 }: {
  /** 찾을 글이 들어 있는 스크롤 컨테이너. 탭마다 다르면 그때그때 풀리는 프록시를 넘긴다. */
  containerRef: RefObject<HTMLElement | null>;
  /** 이 화면이 지금 대화를 보여 주고 있는가. 꺼져 있으면 단축키도 듣지 않는다. */
  enabled: boolean;
  /** 이 값이 바뀌면(대화 전환) 찾기를 닫는다. 다른 대화의 결과 수가 남는 것을 막는다. */
  resetKey?: string | null;
  /** 겹쳐 뜨는 자리일수록 큰 값. 팝업이 대화 화면보다 위다. */
  priority?: number;
}): { findBar: ReactNode } {
  const { text } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [total, setTotal] = useState(0);
  /** 아직 화면에 올라오지 않은 이전 구간이 남아 있는가. */
  const [partial, setPartial] = useState(false);
  // 대화가 자라거나 접힌 구간이 펼쳐지면 찾은 자리가 달라진다. 관찰자가 이 값을 올려
  // 다시 세게 한다.
  const [revision, setRevision] = useState(0);
  // 찾기가 한 번 끝날 때마다 올라간다. 칠하는 쪽이 이 값을 보고 새 Range 로 다시 칠한다.
  const [located, setLocated] = useState(0);
  /** 이전 구간을 끝까지 불러오는 중인가. 몇 걸음째인지는 막대에 적는다. */
  const [expanding, setExpanding] = useState<number | null>(null);
  const rangesRef = useRef<Range[]>([]);
  const expandingRef = useRef(false);
  const stopExpandingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 단축키 처리에서 "지금 열려 있는가"를 읽는 자리. 열고 닫을 때마다 등록을 다시 하지
  // 않으려고 ref 로 둔다.
  const openRef = useRef(false);
  openRef.current = open;

  const close = useCallback(() => {
    // 닫으면서 불러오기도 멈춘다. 막대가 사라진 뒤에도 앞 구간을 계속 붙이면 사용자가
    // 멈출 수단이 없다.
    stopExpandingRef.current = true;
    setOpen(false);
    setIndex(0);
    setTotal(0);
  }, []);

  useEffect(() => {
    if (!enabled) close();
  }, [close, enabled]);

  useEffect(() => {
    close();
  }, [close, resetKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    return registerFindSurface({
      priority,
      // 화면 묶음은 다른 화면으로 옮겨도 그대로 살아 있고 `hidden` 으로만 감춰진다
      // (`App.tsx` 의 view-panel). 감춰진 대화가 단축키를 가져가면 보이지 않는 막대에
      // 글을 치게 되므로, 실제로 그려져 있을 때만 후보가 된다.
      available: () => {
        const container = containerRef.current;
        return Boolean(container && container.offsetParent !== null);
      },
      open: () => {
        // 막 열릴 때는 입력칸이 스스로 초점을 가져간다(autoFocus). 여기서 다시 고르면 그
        // 사이에 친 첫 글자를 지우게 되므로 손대지 않는다. 이미 열려 있을 때 다시 누른
        // 것은 새 낱말을 찾겠다는 뜻이라, 그때만 있던 글을 고른 채로 둔다.
        if (openRef.current) {
          inputRef.current?.focus();
          inputRef.current?.select();
        }
        setOpen(true);
      },
      close,
    });
  }, [close, containerRef, enabled, priority]);

  useEffect(() => {
    if (!open) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;
    let frame = 0;
    const bump = () => {
      // 끝까지 불러오는 동안에는 한 걸음마다 다시 세지 않는다. 걸음마다 자라는 대화를
      // 매번 훑으면 불러오기가 그만큼 느려진다 — 다 불러온 뒤 한 번만 센다.
      if (frame || expandingRef.current) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setRevision((current) => current + 1);
      });
    };
    const observer = new MutationObserver(bump);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [containerRef, open]);

  // 찾기. DOM 을 훑는 쪽은 찾는 말이 바뀌거나 대화가 자랄 때만 돈다 — 결과 사이를
  // 오가는 것만으로 긴 대화를 다시 훑으면 한 번 누를 때마다 몇 천 개 글 조각을 다시 읽는다.
  useEffect(() => {
    if (!open || expanding !== null) {
      if (!open) rangesRef.current = [];
      return undefined;
    }
    const container = containerRef.current;
    if (!container) {
      rangesRef.current = [];
      setTotal(0);
      return undefined;
    }
    const nodes = textNodesIn(container);
    const matches = findMatches(nodes.map((node) => node.nodeValue ?? ""), query);
    rangesRef.current = matches.map((match) => {
      const range = document.createRange();
      range.setStart(nodes[match.nodeIndex], match.start);
      range.setEnd(nodes[match.nodeIndex], match.end);
      return range;
    });
    setTotal(matches.length);
    setPartial(Boolean(container.querySelector(PENDING_HISTORY_SELECTOR)));
    setLocated((current) => current + 1);
    return undefined;
  }, [containerRef, expanding, open, query, revision]);

  // 칠하기. 찾은 자리 전체를 옅게, 지금 자리를 진하게 얹고 그 자리로 굴린다.
  useEffect(() => {
    if (!open) {
      clearHighlights();
      return undefined;
    }
    const ranges = rangesRef.current;
    const safeIndex = clampMatchIndex(index, ranges.length);
    if (safeIndex !== index) {
      setIndex(safeIndex);
      return undefined;
    }
    const current = ranges[safeIndex];
    const api = highlightApi();
    if (api) {
      api.registry.set(ALL_MATCHES_HIGHLIGHT, new api.Highlight(...ranges));
      if (current) api.registry.set(CURRENT_MATCH_HIGHLIGHT, new api.Highlight(current));
      else api.registry.delete(CURRENT_MATCH_HIGHLIGHT);
    } else if (current) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(current);
    }
    const container = containerRef.current;
    if (container && current) revealMatch(container, current);
    return clearHighlights;
  }, [containerRef, index, located, open]);

  const step = useCallback((direction: number) => {
    setIndex((current) => stepMatchIndex(current, total, direction));
  }, [total]);

  /**
   * 이전 구간을 끝까지 불러온 뒤 다시 찾는다. 화면이 이미 가진 두 단추를 사용자 대신
   * 차례로 누르는 것이라, 서버 조회(이전 대화 더보기)와 마운트(이전 대화 N개 더 표시)
   * 어느 쪽이 남아 있든 같은 걸음으로 줄어든다.
   *
   * 끝나면 자리 번호를 처음으로 되돌린다. 앞 구간이 붙으면 찾은 자리가 통째로 뒤로
   * 밀리므로, 보고 있던 번호를 그대로 두면 엉뚱한 곳을 가리킨다.
   */
  const expandAll = useCallback(async () => {
    const container = containerRef.current;
    if (!container || expandingRef.current) return;
    expandingRef.current = true;
    stopExpandingRef.current = false;
    setExpanding(0);
    try {
      for (let taken = 0; taken < MAX_EXPAND_STEPS; taken += 1) {
        if (stopExpandingRef.current) break;
        const button = container.querySelector<HTMLButtonElement>(EXPAND_BUTTON_SELECTOR);
        if (!button) break;
        if (button.disabled) {
          // 앞 구간을 읽어 오는 중이다. 끝나면 단추가 풀리거나 다음 단추로 바뀐다.
          const released = await waitForChange(container, EXPAND_BUSY_TIMEOUT_MS);
          if (!released) break;
          continue;
        }
        button.click();
        setExpanding(taken + 1);
        const changed = await waitForChange(container, EXPAND_CHANGE_TIMEOUT_MS);
        if (!changed) break;
      }
    } finally {
      expandingRef.current = false;
      setExpanding(null);
      setIndex(0);
      setRevision((current) => current + 1);
    }
  }, [containerRef]);

  const handleInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    // IME 조합을 끝내는 Enter 는 아직 찾기 명령이 아니다.
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  };

  const searching = Boolean(query.trim());
  // 불러오는 동안에는 결과 수 자리가 진행 상황을 적는다. 그 사이 세지 않으므로 옛 숫자를
  // 그대로 두면 멈춘 것처럼 보인다.
  const expandingLabel = expanding === null
    ? ""
    : text(`불러오는 중 ${expanding}`, `Loading ${expanding}`);
  const countLabel = !searching
    ? ""
    : total === 0
      ? text("결과 없음", "No results")
      : `${index + 1}/${total}`;

  const findBar = open ? (
    <div className="chat-find-bar" role="search">
      <Search size={13} aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        autoFocus
        spellCheck={false}
        aria-label={text("대화에서 찾기", "Find in conversation")}
        placeholder={text("대화에서 찾기", "Find in conversation")}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={handleInputKeyDown}
      />
      <span className="chat-find-count" aria-live="polite">{expandingLabel || countLabel}</span>
      {searching && partial && expanding === null && <small
        className="chat-find-scope"
        title={text(
          "지금은 화면에 올라온 대화만 찾습니다. '전체 찾기'를 누르면 이전 구간을 끝까지 불러온 뒤 다시 찾습니다.",
          "Only the messages already on screen are searched. 'Search all' loads every earlier message, then searches again.",
        )}
      >{text("화면에 올라온 대화만", "Loaded messages only")}</small>}
      {searching && (partial || expanding !== null) && <button
        type="button"
        className="chat-find-expand"
        aria-label={expanding === null ? text("전체 찾기", "Search all") : text("불러오기 중지", "Stop loading")}
        title={expanding === null
          ? text(
            "이전 대화를 끝까지 불러온 뒤 다시 찾습니다. 대화가 길면 시간이 걸립니다.",
            "Loads all earlier messages and searches again. This can take a while in a long conversation.",
          )
          : text("불러오기를 멈추고 지금까지 올라온 만큼에서 찾습니다", "Stops loading and searches what is on screen so far")}
        onClick={() => {
          if (expanding === null) void expandAll();
          else stopExpandingRef.current = true;
        }}
      >{expanding === null ? text("전체 찾기", "Search all") : text("중지", "Stop")}</button>}
      <button
        type="button"
        disabled={total === 0 || expanding !== null}
        aria-label={text("이전 결과", "Previous match")}
        title={text("이전 결과 (Shift+Enter)", "Previous match (Shift+Enter)")}
        onClick={() => step(-1)}
      >
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        disabled={total === 0 || expanding !== null}
        aria-label={text("다음 결과", "Next match")}
        title={text("다음 결과 (Enter)", "Next match (Enter)")}
        onClick={() => step(1)}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label={text("찾기 닫기", "Close find")}
        title={text("닫기 (Esc)", "Close (Esc)")}
        onClick={close}
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  ) : null;

  return { findBar };
}
