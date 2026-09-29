/**
 * '읽던 자리' 한 벌 — 자동으로 챙겨 두는 자리 하나와, 사용자가 이름 붙여 남기는 목록.
 *
 * 답변 하나가 화면 몇 개 분량이면 다 읽기 전에 다음 질문을 보내게 되고, 그 순간 화면은
 * 새 요청 자리로 옮겨 간다(`scrollToLastUserMessage`). 읽다 만 자리로 돌아갈 방법이
 * 없어서 처음부터 다시 훑어야 했다.
 *
 * 대화 화면·세션 상세·AIA 팝업이 같은 훅 하나를 쓴다. 세 벌로 두면 한 화면에서 남긴
 * 자리를 다른 화면이 못 찾거나, 되돌아가기 버튼이 한 곳에서만 사라지는 식으로 조용히
 * 갈라진다. 자리를 어떻게 적고 어떻게 되찾을지는 `lib/readingAnchor.ts`가, DOM에서
 * 어디를 짚을지는 `readingAnchorDom.ts`가 맡는다. 이 파일에는 훅과 버튼만 둔다.
 */
import { useCallback, useEffect, useState, type ReactNode, type RefObject } from "react";
import { Bookmark, BookmarkPlus, CornerUpLeft, Pencil, Trash2, X } from "lucide-react";
import { getSessionMeta, patchSessionMeta } from "../lib/ipc";
import { errorText } from "../lib/errorText";
import { useI18n } from "../lib/i18n";
import {
  addBookmark,
  anchorSnippet,
  bookmarkAnchor,
  bookmarksFull,
  bookmarkTitle,
  readingPointStillUseful,
  removeBookmark,
  renameBookmark,
} from "../lib/readingAnchor";
import type { ProviderId, SessionBookmark, SessionMeta } from "../types";
import { useDismissablePopover } from "./ChatPopover";
import { formatDate } from "../lib/format";
import { captureReadingAnchor, scrollToReadingAnchor, type AnchorWithSnippet } from "./readingAnchorDom";

/** 표시 범위 밖의 자리를 찾으려고 이전 구간을 더 불러오는 횟수 상한. */
const RANGE_EXPAND_TRIES = 5;
/** 이만큼도 넘치지 않는 대화는 스크롤할 것이 없다고 본다. */
const MIN_SCROLLABLE_PX = 8;

/** 자동으로 챙겨 둔 자리 하나. 되돌아갈 위치와, 그 버튼을 언제 거둘지 판단할 스크롤 값. */
interface ReadingPoint {
  anchor: AnchorWithSnippet;
  scrollTop: number;
}

/** 화면이 이 훅에서 받아 쓰는 것. 버튼 묶음 하나와, 화면이 옮겨 가기 직전에 부를 손잡이 하나. */
export interface ReadingBookmarksHandle {
  /**
   * 스크롤 컨트롤 묶음 맨 위에 함께 세우는 버튼들(되돌아가기·책갈피 목록).
   * `ChatScrollControls`의 `leading`에 그대로 넘긴다 — 스크롤 가능 여부를 그 묶음이
   * 이미 알고 있어, 표시할 것이 없을 때 조용히 사라지는 판정을 여기서 함께 한다.
   */
  controls: (scrollable: boolean) => ReactNode;
  /**
   * 지금 읽고 있는 자리를 챙겨 둔다. 새 요청 때문에 화면을 옮기기 **직전**에 부른다 —
   * 옮긴 뒤에 부르면 옮겨 간 자리가 "읽던 자리"로 적힌다.
   */
  captureReadingPoint: () => void;
}

export function useReadingBookmarks({
  containerRef,
  source,
  sessionId,
  resetKey,
  uiAnchor,
  onMetaChanged,
  onExpandRange,
}: {
  /** 대화를 담고 있는 스크롤 컨테이너. 화면마다 다르다. */
  containerRef: RefObject<HTMLElement | null>;
  /** 이 대화의 공급자 세션. 아직 없으면(새 채팅) 책갈피는 잠기고 되돌아가기만 남는다. */
  source: ProviderId | null;
  sessionId: string | null;
  /** 이 값이 바뀌면 챙겨 둔 자리를 버린다. 대개 대화 id다. */
  resetKey: string | null;
  /** AIA가 가리킬 수 있게 남기는 안내 앵커. 드로어·팝업 안쪽에는 주지 않는다. */
  uiAnchor?: string;
  /** 저장 결과를 세션 목록에도 반영할 화면이 넘긴다. 목록이 없는 화면(AIA)은 비운다. */
  onMetaChanged?: (source: ProviderId, id: string, meta: SessionMeta) => void;
  /**
   * 찾는 자리가 아직 화면에 올라오지 않았을 때 이전 구간을 더 붙인다. 더 붙일 것이
   * 있으면 true. 세션 상세처럼 뒤에서부터 읽는 화면만 넘긴다.
   */
  onExpandRange?: () => Promise<boolean>;
}): ReadingBookmarksHandle {
  const { text } = useI18n();
  const [point, setPoint] = useState<ReadingPoint | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bookmarks = useSessionBookmarkStore({ source, sessionId, onMetaChanged, onError: setNotice });

  // 대화가 바뀌면 지난 대화의 자리는 뜻이 없다.
  useEffect(() => {
    setPoint(null);
    setNotice(null);
  }, [resetKey]);

  const captureReadingPoint = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    // 스크롤할 것이 없는 대화는 화면이 옮겨 갈 일도 없다. 자리를 적어 두면 되돌아갈
    // 곳이 지금 보는 곳과 같은, 아무 일도 하지 않는 버튼만 남는다.
    if (container.scrollHeight - container.clientHeight <= MIN_SCROLLABLE_PX) return;
    const anchor = captureReadingAnchor(container);
    if (anchor) setPoint({ anchor, scrollTop: container.scrollTop });
  }, [containerRef]);

  /**
   * 되돌아갈 자리가 지금 보는 자리와 실제로 떨어져 있는가. 자리를 적어 두는 것과 버튼을
   * 보여주는 것은 다른 문제다 — 적어 둔 뒤 화면이 정말 옮겨 갔을 때만 보여준다.
   *
   * 화면이 언제 옮겨 가는지는 화면마다 다르다. 대화 화면은 새 요청 자리로 곧바로
   * 옮겨 가고, AIA 팝업은 사용자가 응답을 보려고 맨 아래로 내려갈 때 비로소 멀어진다.
   * 두 경우를 각각 적지 않도록, 떨어졌는지만 계속 보고 그 답에 버튼을 맡긴다.
   */
  const [pointFar, setPointFar] = useState(false);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !point) {
      setPointFar(false);
      return undefined;
    }
    const evaluate = () => setPointFar(readingPointStillUseful(container.scrollTop, point.scrollTop));
    // 적어 둔 직후의 이동은 이 이펙트가 붙기 전에 끝날 수 있어 스크롤 이벤트를 놓친다.
    // 두 프레임 뒤에 한 번 직접 본다.
    const frame = window.requestAnimationFrame(() => window.requestAnimationFrame(evaluate));
    container.addEventListener("scroll", evaluate, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      container.removeEventListener("scroll", evaluate);
    };
  }, [containerRef, point]);

  const jumpTo = useCallback(async (anchor: AnchorWithSnippet): Promise<boolean> => {
    const container = containerRef.current;
    if (!container) return false;
    if (scrollToReadingAnchor(container, anchor)) return true;
    // 아직 화면에 올라오지 않은 자리일 수 있다. 이전 구간을 붙여 가며 다시 찾는다.
    for (let attempt = 0; onExpandRange && attempt < RANGE_EXPAND_TRIES; attempt += 1) {
      if (!await onExpandRange()) break;
      if (scrollToReadingAnchor(container, anchor)) return true;
    }
    return false;
  }, [containerRef, onExpandRange]);

  const returnToPoint = useCallback(() => {
    if (!point) return;
    void jumpTo(point.anchor).then((moved) => {
      if (moved) setPoint(null);
      else setNotice(text("읽던 자리를 더 찾을 수 없습니다", "That reading spot can no longer be found"));
    });
  }, [jumpTo, point, text]);

  const addHere = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const anchor = captureReadingAnchor(container);
    if (!anchor) {
      setNotice(text("표시할 자리를 찾지 못했습니다", "There is no spot here to mark"));
      return;
    }
    setNotice(null);
    void bookmarks.save(addBookmark(bookmarks.items, {
      id: crypto.randomUUID(),
      label: "",
      snippet: anchor.snippet,
      anchor: { messageKey: anchor.messageKey, markdownLine: anchor.markdownLine },
      createdAt: Date.now(),
    }));
  }, [bookmarks, containerRef, text]);

  const jumpToBookmark = useCallback((bookmark: SessionBookmark) => {
    setNotice(null);
    void jumpTo(bookmarkAnchor(bookmark)).then((moved) => {
      if (moved) return;
      setNotice(onExpandRange
        ? text("이 자리는 표시 범위 밖입니다. 대화 내역 표시 범위를 넓혀 주세요.", "This spot is outside the shown range. Widen the conversation range.")
        : text("이 자리를 더 찾을 수 없습니다", "This spot can no longer be found"));
    });
  }, [jumpTo, onExpandRange, text]);

  const controls = (scrollable: boolean) => (
    <ReadingControls
      scrollable={scrollable}
      hasPoint={Boolean(point) && pointFar}
      bookmarks={bookmarks.items}
      bookmarksReady={bookmarks.ready}
      notice={notice}
      uiAnchor={uiAnchor}
      onReturn={returnToPoint}
      onAdd={addHere}
      onJump={jumpToBookmark}
      onRename={(id, label) => void bookmarks.save(renameBookmark(bookmarks.items, id, label))}
      onRemove={(id) => void bookmarks.save(removeBookmark(bookmarks.items, id))}
      onDismissNotice={() => setNotice(null)}
    />
  );

  return { controls, captureReadingPoint };
}

/**
 * 이 대화에 저장된 읽던 자리 목록. 저장은 목록 통째 교체(`patch.bookmarks`)라 추가·이름
 * 변경·삭제가 모두 같은 한 자리를 지난다.
 *
 * 세션 목록을 들고 있는 화면도 카탈로그의 `meta`를 쓰지 않고 여기서 다시 읽는다. 세
 * 화면이 같은 값을 같은 통로로 얻어야 한 화면에서 남긴 자리가 다른 화면에 늦게 나타나는
 * 일이 없다.
 */
function useSessionBookmarkStore({ source, sessionId, onMetaChanged, onError }: {
  source: ProviderId | null;
  sessionId: string | null;
  onMetaChanged?: (source: ProviderId, id: string, meta: SessionMeta) => void;
  onError: (message: string) => void;
}): { items: SessionBookmark[]; ready: boolean; save: (next: SessionBookmark[]) => Promise<void> } {
  const [items, setItems] = useState<SessionBookmark[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setItems([]);
    setReady(false);
    if (!source || !sessionId) return undefined;
    let active = true;
    getSessionMeta(source, sessionId)
      .then((meta) => {
        if (!active) return;
        setItems(meta.bookmarks ?? []);
        setReady(true);
      })
      // 읽지 못해도 대화는 그대로 쓸 수 있어야 한다. 목록만 비어 있는 채로 둔다.
      .catch(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [source, sessionId]);

  const save = useCallback(async (next: SessionBookmark[]) => {
    if (!source || !sessionId) return;
    const previous = items;
    setItems(next);
    try {
      const meta = await patchSessionMeta(source, sessionId, { bookmarks: next });
      setItems(meta.bookmarks ?? []);
      onMetaChanged?.(source, sessionId, meta);
    } catch (cause) {
      // 저장이 실패했는데 화면에만 남으면, 다음에 열었을 때 있던 자리가 사라진다.
      setItems(previous);
      onError(errorText(cause));
    }
  }, [items, onError, onMetaChanged, source, sessionId]);

  return { items, ready, save };
}

function ReadingControls({
  scrollable,
  hasPoint,
  bookmarks,
  bookmarksReady,
  notice,
  uiAnchor,
  onReturn,
  onAdd,
  onJump,
  onRename,
  onRemove,
  onDismissNotice,
}: {
  /** 대화가 넘쳐 스크롤할 것이 있는가. 스크롤 컨트롤 묶음이 이미 아는 값을 받아 쓴다. */
  scrollable: boolean;
  hasPoint: boolean;
  bookmarks: SessionBookmark[];
  bookmarksReady: boolean;
  notice: string | null;
  uiAnchor?: string;
  onReturn: () => void;
  onAdd: () => void;
  onJump: (bookmark: SessionBookmark) => void;
  onRename: (id: string, label: string) => void;
  onRemove: (id: string) => void;
  onDismissNotice: () => void;
}) {
  const { text } = useI18n();
  const { open, setOpen, rootRef } = useDismissablePopover();
  const full = bookmarksFull(bookmarks);

  // 화면 하나에 다 들어오는 대화에는 표시할 자리랄 것이 없다. 이미 남긴 자리가 있을
  // 때만(다시 찾아갈 것이 있으므로) 버튼을 남긴다.
  if (!scrollable && bookmarks.length === 0 && !notice) return null;

  return (
    <div className="reading-controls" ref={rootRef}>
      {notice && <div className="reading-notice" role="status">
        <span>{notice}</span>
        <button type="button" onClick={onDismissNotice} aria-label={text("알림 닫기", "Dismiss")}><X size={12} /></button>
      </div>}
      {hasPoint && <button
        className="reading-return"
        type="button"
        aria-label={text("읽던 곳으로", "Back to where I was")}
        // 옆에 선 맨 위·맨 아래 버튼과 같이 무엇을 하는 버튼인지만 짧게 적는다.
        // 긴 설명을 담으면 마우스를 올렸을 때 정작 이름이 보이지 않는다.
        title={text("읽던 곳으로", "Back to where I was")}
        onClick={onReturn}
      >
        <CornerUpLeft size={15} aria-hidden="true" />
      </button>}
      <button
        className={`reading-bookmark-toggle${open ? " is-active" : ""}`}
        type="button"
        aria-label={text("읽던 자리", "Reading spots")}
        aria-expanded={open}
        title={text("읽던 자리", "Reading spots")}
        data-ui-anchor={uiAnchor}
        onClick={() => setOpen(!open)}
      >
        <Bookmark size={15} fill={bookmarks.length > 0 ? "currentColor" : "none"} aria-hidden="true" />
        {bookmarks.length > 0 && <span className="reading-bookmark-count">{bookmarks.length}</span>}
      </button>
      {open && <div className="reading-bookmark-panel" role="dialog" aria-label={text("읽던 자리", "Reading spots")}>
        <header>
          <strong>{text("읽던 자리", "Reading spots")}</strong>
          <button
            className="button compact"
            type="button"
            disabled={full}
            title={full
              ? text("이 대화에 저장할 수 있는 자리를 모두 썼습니다", "This conversation has all the spots it can hold")
              : text("지금 화면 맨 위에 있는 자리를 표시합니다", "Marks the spot now at the top of the view")}
            onClick={onAdd}
          >
            <BookmarkPlus size={13} aria-hidden="true" />
            <span>{text("여기 표시", "Mark here")}</span>
          </button>
        </header>
        {bookmarks.length === 0
          ? <p className="reading-bookmark-empty">{bookmarksReady
            ? text("아직 표시한 자리가 없습니다. 읽던 자리에서 '여기 표시'를 누르세요.", "No spots yet. Press “Mark here” where you stopped reading.")
            : text("읽는 중…", "Loading…")}</p>
          : <ul className="reading-bookmark-list">
            {bookmarks.map((bookmark) => (
              <ReadingBookmarkRow
                bookmark={bookmark}
                onJump={() => onJump(bookmark)}
                onRename={(label) => onRename(bookmark.id, label)}
                onRemove={() => onRemove(bookmark.id)}
                key={bookmark.id}
              />
            ))}
          </ul>}
      </div>}
    </div>
  );
}

function ReadingBookmarkRow({ bookmark, onJump, onRename, onRemove }: {
  bookmark: SessionBookmark;
  onJump: () => void;
  onRename: (label: string) => void;
  onRemove: () => void;
}) {
  const { text } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bookmark.label);

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== bookmark.label) onRename(draft);
  };

  return (
    <li className="reading-bookmark-row">
      {editing ? (
        <input
          className="reading-bookmark-rename"
          value={draft}
          autoFocus
          aria-label={text("읽던 자리 이름", "Reading spot name")}
          placeholder={anchorSnippet(bookmark.snippet, 30)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              // Esc가 팝오버까지 닫으면 이름 고치기를 그만두려던 것이 목록까지 닫는다.
              event.stopPropagation();
              setDraft(bookmark.label);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button className="reading-bookmark-jump" type="button" onClick={onJump}>
          <strong>{bookmarkTitle(bookmark)}</strong>
          <small>{formatDate(bookmark.createdAt)}</small>
        </button>
      )}
      <button
        className="icon-button"
        type="button"
        aria-label={text("이름 바꾸기", "Rename")}
        title={text("이름 바꾸기", "Rename")}
        onClick={() => { setDraft(bookmark.label); setEditing(true); }}
      >
        <Pencil size={13} />
      </button>
      <button
        className="icon-button"
        type="button"
        aria-label={text("읽던 자리 삭제", "Remove reading spot")}
        title={text("삭제", "Remove")}
        onClick={onRemove}
      >
        <Trash2 size={13} />
      </button>
    </li>
  );
}
