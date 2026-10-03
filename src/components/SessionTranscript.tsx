import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CircleAlert, History, Image as ImageIcon, OctagonPause, X } from "lucide-react";
import {
  directSessionTranscriptImageUrl,
  getSessionDetail,
  readSessionTranscriptImage,
} from "../lib/ipc";
import { formatBytes, formatDate, formatTokens } from "../lib/format";
import { displayPath } from "../lib/displayPath";
import type {
  ContentBlock,
  ProviderId,
  SessionDetail,
  SessionTranscriptLimit,
  TranscriptItem,
} from "../types";
import { INTERRUPTED_ROLE, RUNTIME_FAILURE_ROLE } from "../types";
import { joinMarkdownBlocks } from "../lib/copyPayload";
import { transcriptActivityMatches, type ActivityFilter } from "../lib/activityFilter";
import { collectTranscriptSkillUsages, isSkillUsageBlock } from "../lib/skillUsage";
import { splitAgentMessageMeta } from "../lib/agentMessageMeta";
import { MarkdownPreview } from "./MarkdownPreview";
import { AgentMessageMetaList } from "./AgentMessageMeta";
import { CopyAction } from "./CopyAction";
import { useEscapeToClose } from "./Shared";
import { ChatActivityGroup } from "./ChatActivityGroup";
import { ChatSkillUsageCard } from "./ChatSkillUsage";
import { ChatToolCard } from "./ChatToolCard";
import { SpeechPlaybackAction } from "./VoiceControls";
import { errorText } from "../lib/errorText";
import { transcriptMessageKey } from "../lib/readingAnchor";
import { readStoredText } from "../lib/storedText";
import { useI18n, type UiText } from "../lib/i18n";

import { runtimeText } from "../lib/i18nRuntime";
export const SESSION_TRANSCRIPT_LIMIT_KEY = "agent-manager.session-transcript-limit";
export const DEFAULT_SESSION_TRANSCRIPT_LIMIT: SessionTranscriptLimit = "latest100";
/**
 * 대화 내역 표시 범위 한 벌. 같은 네 값을 저장값 검사표, 이전 구간 조회 크기표, 선택 칸의
 * `<option>` 네 줄이 저마다 늘어놓고 있어 범위를 하나 더하거나 이름을 바꾸면 세 자리를 함께
 * 고쳐야 했다. 한 곳만 빠뜨리면 고른 범위가 저장 단계에서 기본값으로 되돌아가거나 '이전 대화
 * 더보기'가 조용히 잠긴다. 정의 순서가 곧 선택 칸에 나오는 순서다.
 */
interface SessionTranscriptLimitChoice {
  value: SessionTranscriptLimit;
  /** 선택 칸에 나오는 이름. 언어는 화면이 그릴 때 정해지므로 `text`를 받아 만든다. */
  label: (text: UiText) => string;
  /** '이전 대화 더보기'가 한 번에 더 읽는 항목 수. 앞선 구간이 남지 않는 범위는 null. */
  chunkSize: number | null;
}

const SESSION_TRANSCRIPT_LIMIT_CHOICES: SessionTranscriptLimitChoice[] = [
  { value: "latest100", label: (text) => text("최신 100개", "Latest 100"), chunkSize: 100 },
  { value: "latest500", label: (text) => text("최신 500개", "Latest 500"), chunkSize: 500 },
  { value: "latest1000", label: (text) => text("최신 1,000개", "Latest 1,000"), chunkSize: 1000 },
  { value: "all", label: (text) => text("전체", "All"), chunkSize: null },
];

export function readSessionTranscriptLimit(): SessionTranscriptLimit {
  const stored = readStoredText(SESSION_TRANSCRIPT_LIMIT_KEY) as SessionTranscriptLimit | null;
  return stored && SESSION_TRANSCRIPT_LIMIT_CHOICES.some((choice) => choice.value === stored)
    ? stored
    : DEFAULT_SESSION_TRANSCRIPT_LIMIT;
}

export interface SessionTranscriptState {
  detail: SessionDetail | null;
  error: string | null;
  loadingEarlier: boolean;
  earlierError: string | null;
  /** 이번에 더 불러올 수 있는 이전 항목 수. 0이면 앞선 구간이 없다. */
  earlierLoadCount: number;
  loadEarlier: () => Promise<void>;
  /** 같은 세션의 공급자 원문과 Agent Manager 실행 실패 기록을 다시 읽는다. */
  refresh: () => void;
}

/**
 * 위쪽에 내용을 덧붙일 때 보고 있던 위치를 유지하는 스크롤 보정. 붙이기 전 높이를 재
 * 두었다가, 붙은 뒤 늘어난 만큼 스크롤을 내린다. 이전 구간 조회('이전 대화 더보기')와
 * 마운트 창 넓히기가 같은 보정을 쓴다.
 *
 * `measure()`는 붙이기 직전에, `restore()`는 붙은 결과가 그려진 뒤 layout effect에서
 * 부른다. 재 두고도 결국 붙이지 못했으면(조회 실패) `forget()`으로 버린다 — 남겨 두면
 * 다음 번 보정이 옛 높이로 계산된다.
 */
function useTopInsertScrollAnchor(scrollContainerRef?: RefObject<HTMLElement | null>): {
  measure: () => void;
  restore: () => void;
  forget: () => void;
} {
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const forget = useCallback(() => { anchorRef.current = null; }, []);
  const measure = useCallback(() => {
    const container = scrollContainerRef?.current ?? null;
    anchorRef.current = container ? { height: container.scrollHeight, top: container.scrollTop } : null;
  }, [scrollContainerRef]);
  const restore = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    const container = scrollContainerRef?.current;
    if (container) container.scrollTop = anchor.top + (container.scrollHeight - anchor.height);
  }, [scrollContainerRef]);
  return { measure, restore, forget };
}

/**
 * 공급자 세션 파일에서 읽은 대화 원문과 그 이전 구간 페이징. 세션 상세와 채팅 화면이
 * 같은 표시 범위 설정으로 같은 원문을 그리도록 상태를 한곳에 모았다.
 *
 * `scrollContainerRef`는 이전 구간을 위쪽에 붙인 뒤 보고 있던 위치를 되돌리는 데 쓴다.
 * 화면마다 스크롤을 맡는 요소가 다르므로(드로어 본문·채팅 스트림·작업 로그) 호출부가 넘긴다.
 */
export function useSessionTranscript({
  source,
  sessionId,
  limit,
  scrollContainerRef,
}: {
  source: ProviderId | null;
  sessionId: string | null;
  limit: SessionTranscriptLimit;
  scrollContainerRef: RefObject<HTMLElement | null>;
}): SessionTranscriptState {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const { measure, restore, forget } = useTopInsertScrollAnchor(scrollContainerRef);
  const refresh = useCallback(() => setRefreshRevision((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    setLoadingEarlier(false);
    setEarlierError(null);
    forget();
    if (!source || !sessionId) return () => { active = false; };
    getSessionDetail(source, sessionId, limit)
      .then((value) => active && setDetail(value))
      .catch((cause: unknown) => active && setError(errorText(cause)));
    return () => { active = false; };
  }, [forget, source, sessionId, limit, refreshRevision]);

  // 이전 구간 조회용 커서. tail 파싱에서는 항목 순번이 아니라 원본 파일의
  // 바이트 오프셋이므로 개수처럼 표시하면 안 된다. 0이면 앞선 항목이 없다.
  const oldestTranscriptIndex = useMemo(() => (
    detail && detail.transcript.length > 0
      ? detail.transcript.reduce((min, item) => Math.min(min, item.index), Number.MAX_SAFE_INTEGER)
      : 0
  ), [detail]);
  const earlierChunkSize = SESSION_TRANSCRIPT_LIMIT_CHOICES.find((choice) => choice.value === limit)?.chunkSize;
  const earlierLoadCount = detail?.truncated && earlierChunkSize
    ? Math.min(earlierChunkSize, oldestTranscriptIndex)
    : 0;

  const loadEarlier = useCallback(async () => {
    if (!source || !sessionId || loadingEarlier || earlierLoadCount <= 0) return;
    setLoadingEarlier(true);
    setEarlierError(null);
    measure();
    try {
      const page = await getSessionDetail(source, sessionId, limit, oldestTranscriptIndex);
      setDetail((prev) => prev && {
        ...prev,
        transcript: [...page.transcript, ...prev.transcript],
        truncated: page.transcript.length > 0 ? page.truncated : false,
      });
    } catch (cause) {
      // 붙이지 못했으므로 재 둔 높이는 버린다.
      forget();
      setEarlierError(errorText(cause));
    } finally {
      setLoadingEarlier(false);
    }
  }, [earlierLoadCount, forget, limit, loadingEarlier, measure, oldestTranscriptIndex, sessionId, source]);

  // 이전 구간을 위쪽에 붙인 뒤에도 보고 있던 위치가 유지되도록 스크롤을 보정한다.
  useLayoutEffect(restore, [detail, restore]);

  return { detail, error, loadingEarlier, earlierError, earlierLoadCount, loadEarlier, refresh };
}

/** 트랜스크립트 위쪽의 '이전 대화 더보기'. 더 불러올 구간이 없으면 아무것도 그리지 않는다. */
export function TranscriptLoadEarlier({ count, loading, error, onLoad }: {
  count: number;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}) {
  const { text } = useI18n();
  if (count <= 0) return null;
  return (
    <div className="transcript-load-earlier">
      <button className="button compact" type="button" disabled={loading} onClick={onLoad}>
        <History size={13} aria-hidden="true" />
        <span>{loading
          ? text("이전 대화를 불러오는 중…", "Loading earlier messages…")
          : text("이전 대화 더보기", "Load earlier messages")}</span>
      </button>
      {error && <small className="transcript-load-earlier-error" role="alert">{error}</small>}
    </div>
  );
}

/** 세션 상세와 채팅이 함께 쓰는 대화 내역 표시 범위 선택. 값은 한 곳에 저장된다. */
export function TranscriptLimitSelect({ label, value, itemCount, onChange }: {
  label: string;
  value: SessionTranscriptLimit;
  /** 지금 그리고 있는 항목 수. 아직 원문을 못 읽었으면 null. */
  itemCount: number | null;
  onChange: (limit: SessionTranscriptLimit) => void;
}) {
  const { text } = useI18n();
  return (
    <label className="session-transcript-range">
      <span>
        <strong>{text("대화 내역 표시 범위", "Transcript range")}</strong>
        <small>{itemCount === null
          ? text("불러오는 중", "Loading")
          : text(`${itemCount.toLocaleString()}개 항목 표시 중`, `Showing ${itemCount.toLocaleString()} item(s)`)}</small>
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as SessionTranscriptLimit)}
      >
        {SESSION_TRANSCRIPT_LIMIT_CHOICES.map((choice) => (
          <option key={choice.value} value={choice.value}>{choice.label(text)}</option>
        ))}
      </select>
    </label>
  );
}

export function ActivityFilterSelect({ value, onChange }: {
  value: ActivityFilter;
  onChange: (filter: ActivityFilter) => void;
}) {
  const { text } = useI18n();
  return (
    <select
      className="activity-filter-select"
      aria-label={text("작업 로그 항목 필터", "Activity log filter")}
      value={value}
      onChange={(event) => onChange(event.target.value as ActivityFilter)}
    >
      <option value="all">{text("전체", "All")}</option>
      <option value="tool">{text("도구 실행", "Tool call")}</option>
      <option value="reasoning">{text("진행 상황", "Progress")}</option>
      <option value="skill">{text("사용 스킬", "Skills used")}</option>
      <option value="error">{text("오류·승인", "Errors and approvals")}</option>
    </select>
  );
}

/**
 * 한 번에 화면에 올리는 턴 수. 표시 범위를 '전체'로 두면 수천 턴이 올 수 있는데, 보이지도
 * 않는 구간까지 한꺼번에 엘리먼트로 만들면 메모리와 레이아웃 비용이 그대로 든다.
 */
/**
 * 트랜스크립트 한 벌이 공유하는 출처. 어느 세션의 기록인지(이미지 원본을 다시 읽을 때)와
 * 본문 안 로컬 링크를 열 통로는 턴·항목·블록 어디서 쓰이든 같은 값이라, 중간 컴포넌트들이
 * 그대로 넘겨주기만 하던 세 인자를 컨텍스트로 돌린다.
 */
interface TranscriptViewSource {
  source: ProviderId | null;
  sessionId: string | null;
  onOpenLocalLink: (href: string) => void;
}

const TranscriptViewContext = createContext<TranscriptViewSource>({
  source: null,
  sessionId: null,
  onOpenLocalLink: () => {},
});

const TRANSCRIPT_MOUNT_STEP = 60;
/** 위쪽 경계가 이만큼 가까워지면 미리 다음 구간을 붙여, 스크롤이 빈 화면에 닿지 않게 한다. */
const TRANSCRIPT_MOUNT_MARGIN = "600px 0px 0px 0px";

// 트랜스크립트는 수백 개 항목을 그리므로, 상위 폴링·연결 상태 변화에 딸려 재조정되지 않도록 memo한다.
export const TranscriptTurns = memo(function TranscriptTurns({ items, mode, activityFilter = "all", source, sessionId, onOpenLocalLink, scrollContainerRef, windowed = false }: { items: TranscriptItem[]; mode: "conversation" | "activity"; activityFilter?: ActivityFilter; source: ProviderId | null; sessionId: string | null; onOpenLocalLink: (href: string) => void; scrollContainerRef?: RefObject<HTMLElement | null>; /** 표시 범위가 '전체'일 때만 켠다. 아래 주석 참고. */ windowed?: boolean }) {
  const { text } = useI18n();
  const turns = useMemo(() => groupTranscriptTurns(items), [items]);
  const viewSource = useMemo<TranscriptViewSource>(() => ({ source, sessionId, onOpenLocalLink }), [source, sessionId, onOpenLocalLink]);
  const { hiddenCount, visibleTurns, topBoundaryRef, showEarlierTurns } =
    useTranscriptMountWindow(turns, items, windowed, scrollContainerRef);

  return (
    <TranscriptViewContext.Provider value={viewSource}>
      <div className="transcript-list transcript-turn-list">
        {hiddenCount > 0 && <div className="transcript-mount-boundary" ref={topBoundaryRef}>
          <button className="button compact" type="button" onClick={showEarlierTurns}>
            <History size={13} aria-hidden="true" />
            <span>{text(
              `이전 대화 ${Math.min(TRANSCRIPT_MOUNT_STEP, hiddenCount).toLocaleString()}개 더 표시`,
              `Show ${Math.min(TRANSCRIPT_MOUNT_STEP, hiddenCount).toLocaleString()} more earlier message(s)`,
            )}</span>
          </button>
          <small>{text(
            `아직 표시하지 않은 대화 ${hiddenCount.toLocaleString()}개`,
            `${hiddenCount.toLocaleString()} earlier message(s) not shown yet`,
          )}</small>
        </div>}
        {visibleTurns.map((turn) => (
          <TranscriptTurnView
            turn={turn}
            mode={mode}
            activityFilter={activityFilter}
            key={turn.id}
          />
        ))}
      </div>
    </TranscriptViewContext.Provider>
  );
});

/**
 * 최신 쪽부터 조금씩 붙이는 마운트 창.
 *
 * 창 관리(얼마나 붙였는지·언제 되돌리는지·스크롤을 어떻게 보정하는지)는 턴을 어떻게
 * 그리는지와 아무 상관이 없어, 트랜스크립트 본문에서 떼어내 여기 모아 둔다.
 */
function useTranscriptMountWindow(
  turns: TranscriptTurn[],
  items: TranscriptItem[],
  windowed: boolean,
  scrollContainerRef?: RefObject<HTMLElement | null>,
): { hiddenCount: number; visibleTurns: TranscriptTurn[]; topBoundaryRef: RefObject<HTMLDivElement | null>; showEarlierTurns: () => void } {
  // 최신 쪽부터 이만큼만 올린다. 항목 묶음이 갈리면(세션 전환·표시 범위 변경) 창을 되돌린다.
  const [mounted, setMounted] = useState(TRANSCRIPT_MOUNT_STEP);
  useEffect(() => setMounted(TRANSCRIPT_MOUNT_STEP), [items]);
  // 창은 '전체'에서만 쓴다. 최신 N개 범위에는 '이전 대화 더보기'가 있어 데이터 자체가
  // 이미 끊겨 오고, 두 장치를 겹치면 더보기로 불러온 구간이 창에 가려 아무 일도 일어나지
  // 않은 것처럼 보인다. 반대로 '전체'는 더보기가 없고 항목 수에 상한도 없어 창이 필요하다.
  const hiddenCount = windowed ? Math.max(0, turns.length - mounted) : 0;
  const visibleTurns = hiddenCount > 0 ? turns.slice(hiddenCount) : turns;

  const topBoundaryRef = useRef<HTMLDivElement | null>(null);
  const { measure, restore } = useTopInsertScrollAnchor(scrollContainerRef);

  // 위쪽에 턴을 붙이면 보고 있던 내용이 아래로 밀린다. 붙이기 전 높이를 재 두고 뒤에서 보정한다.
  const showEarlierTurns = useCallback(() => {
    measure();
    setMounted((current) => current + TRANSCRIPT_MOUNT_STEP);
  }, [measure]);

  // 위쪽 경계가 보이면 버튼을 누르지 않아도 이어서 붙인다. 어디까지나 덧붙임이다 —
  // 관찰자가 콜백을 주지 않는 환경에서도 아래 버튼으로 끝까지 올라갈 수 있어야 한다.
  useEffect(() => {
    if (hiddenCount <= 0 || typeof IntersectionObserver === "undefined") return;
    const boundary = topBoundaryRef.current;
    if (!boundary) return;
    const container = scrollContainerRef?.current ?? null;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) showEarlierTurns();
    }, { root: container, rootMargin: TRANSCRIPT_MOUNT_MARGIN });
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [hiddenCount, scrollContainerRef, showEarlierTurns]);

  // 붙인 만큼 스크롤을 내려 보고 있던 위치를 유지한다. '이전 대화 더보기'와 같은 보정이다.
  useLayoutEffect(restore, [mounted, restore]);

  return { hiddenCount, visibleTurns, topBoundaryRef, showEarlierTurns };
}

interface TranscriptTurn {
  id: string;
  title: string;
  startedAt: number | null;
  items: TranscriptItem[];
}

/** 턴별 항목 분류와 두 표시 모드를 트랜스크립트의 마운트 창 관리에서 떼어낸다. */
function TranscriptTurnView({ turn, mode, activityFilter }: {
  turn: TranscriptTurn;
  mode: "conversation" | "activity";
  activityFilter: ActivityFilter;
}) {
  if (mode === "activity") {
    return <TranscriptActivityTurn turn={turn} items={activityTurnItems(turn.items, activityFilter)} />;
  }

  const { activityItems, userItems, otherItems, lastAssistantItem } = conversationTurnItems(turn.items);
  return <TranscriptConversationTurn
    turn={turn}
    userItems={userItems}
    activityItems={activityItems}
    otherItems={otherItems}
    lastAssistantItem={lastAssistantItem}
  />;
}

/** 작업 로그 모드의 턴. 머리글이 턴 전체의 성패를 함께 보여준다. */
function TranscriptActivityTurn({ turn, items }: { turn: TranscriptTurn; items: TranscriptItem[] }) {
  const { text } = useI18n();
  if (items.length === 0) return null;
  const activity = transcriptActivityView(items, text);
  return <section className="transcript-turn activity-turn">
    <header><span className={`chat-tool-state chat-tool-state-${activity.status}`} /><strong>{turn.title}</strong><time>{activity.statusText} · {formatDate(turn.startedAt)}</time></header>
    <div>{items.map((item) => <TranscriptArticle item={item} blocks="activity" key={item.index} />)}</div>
  </section>;
}

/** 대화 모드의 턴. 요청 → 사용 스킬 → 접힌 작업 로그 → 응답 순으로 쌓는다. */
function TranscriptConversationTurn({ turn, userItems, activityItems, otherItems, lastAssistantItem }: {
  turn: TranscriptTurn;
  userItems: TranscriptItem[];
  activityItems: TranscriptItem[];
  otherItems: TranscriptItem[];
  lastAssistantItem: TranscriptItem | undefined;
}) {
  return <section className="transcript-turn conversation-turn">
    {userItems.map((item) => <TranscriptArticle item={item} blocks="conversation" key={item.index} />)}
    <ChatSkillUsageCard usages={collectTranscriptSkillUsages(turn.items)} />
    {activityItems.length > 0 && <ConversationActivitySummary items={activityItems} />}
    {otherItems.map((item) => <TranscriptArticle item={item} blocks="conversation" speechReady={item === lastAssistantItem} key={item.index} />)}
  </section>;
}

/**
 * 작업 로그 모드가 그리는 항목. 대화 갈래가 아닌 블록을 가졌고 지금 고른 표시 필터를
 * 통과한 항목만 남는다.
 */
function activityTurnItems(items: TranscriptItem[], activityFilter: ActivityFilter): TranscriptItem[] {
  return items.filter((item) => item.blocks.some((block) => isActivityBlock(block, item))
    && transcriptActivityMatches(item.blocks, activityFilter));
}

/**
 * 대화 모드가 그리는 항목 — 요청, 응답, 그리고 그 사이에 접어 둘 작업 로그. 마지막 응답은
 * 읽어주기 버튼을 그 하나에만 붙이려고 따로 집어 둔다.
 */
function conversationTurnItems(items: TranscriptItem[]): {
  activityItems: TranscriptItem[];
  userItems: TranscriptItem[];
  otherItems: TranscriptItem[];
  lastAssistantItem: TranscriptItem | undefined;
} {
  const activityItems: TranscriptItem[] = [];
  const userItems: TranscriptItem[] = [];
  const otherItems: TranscriptItem[] = [];
  let lastAssistantItem: TranscriptItem | undefined;

  for (const item of items) {
    if (item.blocks.some((block) => isConversationBlock(block, item))) {
      if (item.role === "user") userItems.push(item);
      else otherItems.push(item);
      if (item.role === "assistant") lastAssistantItem = item;
    }
    if (item.blocks.some((block) => isConversationActivityBlock(block, item))) {
      activityItems.push(item);
    }
  }

  return { activityItems, userItems, otherItems, lastAssistantItem };
}

function ConversationActivitySummary({ items }: { items: TranscriptItem[] }) {
  const { text } = useI18n();
  const activity = transcriptActivityView(items, text);
  return <ChatActivityGroup
    entries={items}
    active={false}
    status={activity.status}
    statusText={activity.statusText}
    summary={activity.summary}
    entryKey={(item) => String(item.index)}
    renderEntry={(item) => <TranscriptArticle item={item} blocks="operational" />}
  />;
}

const TranscriptArticle = memo(function TranscriptArticle({ item, blocks, speechReady = false }: { item: TranscriptItem; blocks: TranscriptBlockView; speechReady?: boolean }) {
  const { text } = useI18n();
  const shown = visibleTranscriptBlocks(item, blocks);
  const { visible } = shown;
  if (visible.length === 0) return null;
  // CLI가 남긴 중단 자리표시자는 요청이 아니라 턴이 끊긴 지점이므로 구분선으로만 보여준다.
  if (item.role === INTERRUPTED_ROLE) return <TranscriptInterruptRow item={item} />;
  // 응답이 끝나지 못한 지점은 말풍선이 아니라 실패 표식으로 보여준다.
  if (item.role === RUNTIME_FAILURE_ROLE) {
    const failure = item.blocks.find(
      (block): block is Extract<ContentBlock, { kind: "runtime_failure" }> => block.kind === "runtime_failure",
    );
    return failure ? <RuntimeFailureCallout failure={failure} timestamp={item.timestamp} /> : null;
  }
  const { kind, label } = transcriptArticleKind(item, shown, text);
  const copyText = item.role === "assistant" && blocks === "conversation"
    // 화면에 안 그리는 공급자 메타 블록은 복사본과 읽어주기에도 들어가지 않는다.
    ? joinMarkdownBlocks(visible.flatMap((block) => block.kind === "text" ? [splitAgentMessageMeta(block.text).text] : []))
    : "";
  if (kind === "tool-event") {
    return <div className="transcript-tool-sequence">{visible.map((block, index) => <BlockView block={block} key={index} />)}</div>;
  }
  return (
    <article className={`message message-${kind}`} data-message-key={transcriptMessageKey(item.index)}>
      <header><strong>{label}</strong><span>{item.model ?? ""}</span><time>{formatDate(item.timestamp)}</time></header>
      {copyText && speechReady && <SpeechPlaybackAction responseId={`session:${item.index}:${item.timestamp ?? "unknown"}`} text={copyText} />}
      {copyText && <CopyAction value={copyText} kind="response" className="message-copy-action" />}
      {visible.map((block, index) => <BlockView block={block} copyable={Boolean(copyText)} key={index} />)}
      {item.usage && <footer>{text(
        `입력 ${formatTokens(item.usage.input)} · 출력 ${formatTokens(item.usage.output)} · 캐시 ${formatTokens(item.usage.cacheRead + item.usage.cacheWrite)}`,
        `In ${formatTokens(item.usage.input)} · Out ${formatTokens(item.usage.output)} · Cache ${formatTokens(item.usage.cacheRead + item.usage.cacheWrite)}`,
      )}</footer>}
    </article>
  );
});

function TranscriptInterruptRow({ item }: { item: TranscriptItem }) {
  const { text } = useI18n();
  return (
    <div className="transcript-interrupt">
      <OctagonPause size={12} aria-hidden="true" />
      <span>{item.typeLabel ?? roleName(item.role, text)}</span>
      <time>{formatDate(item.timestamp)}</time>
    </div>
  );
}

/**
 * 보이는 블록 구성으로 이 항목이 어떤 카드가 될지 정한다. 종류를 고르는 규칙과 그 종류의
 * 머리글 문구가 한 자리에 있어야, 한쪽만 고쳐 클래스와 이름이 어긋나는 일이 없다.
 * 위에서부터 먼저 맞는 줄이 이긴다.
 */
function transcriptArticleKind(item: TranscriptItem, { groups, hasSessionInfo }: VisibleTranscriptBlocks, text: UiText): { kind: string; label: string } {
  if (hasSessionInfo) return { kind: "session-info", label: text("세션 정보", "Session info") };
  /** 보이는 블록이 모두 이 갈래인가. 빈 목록을 참으로 보는 것은 예전 `every`와 같다. */
  const onlyGroup = (group: TranscriptBlockGroup) => groups.size === 0 || (groups.size === 1 && groups.has(group));
  if (onlyGroup("tool")) return { kind: "tool-event", label: text("도구 실행", "Tool call") };
  if (onlyGroup("reasoning")) return { kind: "reasoning", label: text("진행 상황", "Progress") };
  // 세션 정보도 컨텍스트 갈래지만 위에서 이미 걸러졌으므로, 여기 남는 것은 context·raw뿐이다.
  if (onlyGroup("context")) return { kind: "context", label: item.typeLabel ?? text("런타임 컨텍스트", "Runtime context") };
  const label = item.role === "user" ? text("사용자 요청", "User request")
    : item.role === "assistant" ? text("에이전트 응답", "Agent response")
      : item.typeLabel ?? roleName(item.role, text);
  return { kind: item.role, label };
}

function groupTranscriptTurns(items: TranscriptItem[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const item of items) {
    const userText = item.role === "user"
      ? item.blocks.find((block): block is Extract<ContentBlock, { kind: "text" }> => block.kind === "text")?.text
      : null;
    if (userText || turns.length === 0) {
      turns.push({ id: item.turnId ?? `turn-${item.index}`, title: userText?.replace(/\s+/g, " ").slice(0, 90) ?? "세션 정보", startedAt: item.timestamp, items: [] });
    }
    turns[turns.length - 1].items.push(item);
  }
  return turns;
}

/**
 * 도구가 돌려준 화면 캡처인지. 사용자가 메시지에 붙인 이미지는 대화에, 도구가 만든
 * 캡처는 작업 로그에 두어 같은 이미지가 두 화면에 겹쳐 나오지 않게 한다.
 */
function isToolImage(block: ContentBlock, item: TranscriptItem): boolean {
  return block.kind === "image"
    && item.blocks.some((other) => other.kind === "tool_use" || other.kind === "tool_result");
}

/**
 * 블록 하나가 화면에서 어떤 성격으로 다뤄지는지. 블록 종류는 아홉 가지인데 표시 술어 셋,
 * 카드 종류 판정, 접힌 로그 요약이 저마다 그 종류 이름을 늘어놓고 있었다. 종류가 하나
 * 늘거나 성격이 바뀔 때 다섯 자리를 같이 고쳐야 했으므로 가름은 여기 한 벌만 둔다.
 */
type TranscriptBlockGroup = "message" | "tool" | "reasoning" | "context" | "failure";

function transcriptBlockGroup(block: ContentBlock, item: TranscriptItem): TranscriptBlockGroup {
  switch (block.kind) {
    case "tool_use":
    case "tool_result":
      return "tool";
    case "thinking":
      return "reasoning";
    case "context":
    case "session_info":
    case "raw":
      return "context";
    case "runtime_failure":
      return "failure";
    case "image":
      return isToolImage(block, item) ? "tool" : "message";
    default:
      return "message";
  }
}

/** 한 항목을 그릴 때 고르는 표시 갈래와 그 갈래가 남기는 블록. */
type TranscriptBlockView = "conversation" | "activity" | "operational";

/**
 * 표시 갈래마다 어떤 블록을 남기는지. 블록 자체가 아니라 이미 유도된 성격(`group`)을 받는
 * 것이 요점이다 — 한 항목을 그릴 때 이 셋과 카드 종류 판정이 저마다 `transcriptBlockGroup`을
 * 다시 불러, 같은 블록의 성격을 최대 네 번 유도하고 있었다. 성격은 부르는 쪽이 한 번 내고
 * 여기서는 가름만 한다. `operational`만 블록을 함께 보는데, 스킬 실행은 성격이 아니라
 * 사용 스킬 카드가 대신 그린다는 자리 배분의 문제라 갈래로 나타나지 않기 때문이다.
 */
const TRANSCRIPT_BLOCK_VIEWS: Record<TranscriptBlockView, (group: TranscriptBlockGroup, block: ContentBlock) => boolean> = {
  conversation: (group) => group === "message" || group === "failure",
  activity: (group) => group !== "message",
  /** 대화 흐름에 딸려 나오는 작업 로그. 스킬 실행은 사용 스킬 카드가 대신 보여준다. */
  operational: (group, block) => !isSkillUsageBlock(block) && (group === "tool" || group === "reasoning"),
};

function transcriptBlockInView(view: TranscriptBlockView, block: ContentBlock, item: TranscriptItem): boolean {
  return TRANSCRIPT_BLOCK_VIEWS[view](transcriptBlockGroup(block, item), block);
}

function isConversationBlock(block: ContentBlock, item: TranscriptItem): boolean {
  return transcriptBlockInView("conversation", block, item);
}

function isActivityBlock(block: ContentBlock, item: TranscriptItem): boolean {
  return transcriptBlockInView("activity", block, item);
}

function isConversationActivityBlock(block: ContentBlock, item: TranscriptItem): boolean {
  return transcriptBlockInView("operational", block, item);
}

/** 한 항목이 한 표시 갈래에서 실제로 그리는 블록과, 그 블록들에서 한 번에 읽어 둔 성격. */
interface VisibleTranscriptBlocks {
  visible: ContentBlock[];
  /** 남은 블록들이 속한 성격 전부. 카드 종류 판정이 이것만 보고 결정한다. */
  groups: Set<TranscriptBlockGroup>;
  /** 세션 정보는 컨텍스트 성격에 묻히므로 따로 표시해 둔다. */
  hasSessionInfo: boolean;
}

/**
 * 한 항목의 블록을 한 번만 훑어 표시 갈래가 남길 블록과 그 성격을 함께 낸다. 성격을 내는
 * `transcriptBlockGroup`은 이미지 블록일 때 항목의 블록 전체를 다시 훑으므로(`isToolImage`),
 * 블록마다 갈래별로 되풀이하면 그 비용이 항목 크기의 제곱으로 겹친다.
 */
function visibleTranscriptBlocks(item: TranscriptItem, view: TranscriptBlockView): VisibleTranscriptBlocks {
  const keeps = TRANSCRIPT_BLOCK_VIEWS[view];
  const visible: ContentBlock[] = [];
  const groups = new Set<TranscriptBlockGroup>();
  let hasSessionInfo = false;
  for (const block of item.blocks) {
    const group = transcriptBlockGroup(block, item);
    if (!keeps(group, block)) continue;
    visible.push(block);
    groups.add(group);
    if (block.kind === "session_info") hasSessionInfo = true;
  }
  return { visible, groups, hasSessionInfo };
}

interface TranscriptActivityStats {
  toolUses: number;
  toolResults: number;
  reasoning: number;
  failures: number;
  failed: boolean;
}

/** 작업 로그의 상태와 요약 문구가 함께 쓰는 블록 통계. 같은 항목을 두 번 훑지 않는다. */
function transcriptActivityStats(items: TranscriptItem[]): TranscriptActivityStats {
  // 사용 스킬 카드로 빠진 블록은 이 요약에서도 뺀다. 그러지 않으면 접힌 로그의 개수가
  // 펼쳤을 때 실제로 보이는 항목 수와 어긋난다.
  let toolUses = 0;
  let toolResults = 0;
  let reasoning = 0;
  let failures = 0;
  let failed = false;
  for (const item of items) {
    for (const block of item.blocks) {
      const group = transcriptBlockGroup(block, item);
      if ((block.kind === "tool_result" && block.isError) || group === "failure") failed = true;
      if (isSkillUsageBlock(block)) continue;
      // 도구 캡처 이미지는 도구 갈래이면서도 개수로는 세지 않는다 — 도구 호출·결과 쌍의
      // 최댓값이 실행 횟수라, 같은 실행에 딸린 이미지를 더하면 개수가 부풀어 오른다.
      if (block.kind === "tool_use") toolUses += 1;
      else if (block.kind === "tool_result") toolResults += 1;
      else {
        if (group === "reasoning") reasoning += 1;
        // context 갈래는 대화 갈래(isConversationBlock)에도 접힌 로그 갈래
        // (isConversationActivityBlock)에도 들어가지 않아 펼쳐도 보이지 않는다. 세면
        // 사용자가 찾을 수 없는 "컨텍스트 n개"가 붙는다(QA #78).
        else if (group === "failure") failures += 1;
      }
    }
  }
  return { toolUses, toolResults, reasoning, failures, failed };
}

/** 작업 로그 머리줄이 그대로 꽂아 쓰는 한 벌. 상태 표식·상태 문구·요약이 늘 같은 통계에서 나온다. */
interface TranscriptActivityView {
  status: "completed" | "failed";
  statusText: string;
  summary: string;
}

/**
 * 블록 통계에서 머리줄에 필요한 것을 한 번에 낸다. 통계 → 상태 → 상태 문구 3단을 작업 로그
 * 모드의 턴과 대화 모드의 접힌 요약이 각각 풀어 적고 있어, 같은 항목을 두고도 한쪽만 고치면
 * 표식과 문구가 엇갈릴 수 있었다. 유도는 여기 한 벌만 두고 부르는 쪽은 꽂기만 한다.
 */
function transcriptActivityView(items: TranscriptItem[], text: UiText): TranscriptActivityView {
  const { toolUses, toolResults, reasoning, failures, failed } = transcriptActivityStats(items);
  const tools = Math.max(toolUses, toolResults);
  return {
    status: failed ? "failed" : "completed",
    statusText: failed ? text("실패 포함", "Includes failures") : text("응답 종료", "Response finished"),
    summary: [
      tools ? text(`도구 ${tools}개`, `${tools} tool call(s)`) : "",
      reasoning ? text(`진행 상황 ${reasoning}개`, `${reasoning} progress entr(ies)`) : "",
      failures ? text(`응답 실패 ${failures}개`, `${failures} response failure(s)`) : "",
    ].filter(Boolean).join(" · ") || text("작업 로그", "Activity log"),
  };
}

/** 응답이 끝나지 못한 지점의 실패 표식. 상태 문구·오류 코드·시각과 실패 안내 본문을 담는다. */
function RuntimeFailureCallout({ failure, timestamp = null }: { failure: Extract<ContentBlock, { kind: "runtime_failure" }>; timestamp?: number | null }) {
  const { text } = useI18n();
  return (
    <div className="transcript-runtime-failure">
      <div>
        <CircleAlert size={12} aria-hidden="true" />
        <span>{failure.status === "interrupted"
          ? text("요청이 중단되었습니다", "The request was interrupted")
          : text("응답을 완료하지 못했습니다", "The response could not be completed")}</span>
        <code>{failure.code}</code>
        {timestamp !== null && <time>{formatDate(timestamp)}</time>}
      </div>
      {failure.text.trim() !== "" && <p>{failure.text}</p>}
    </div>
  );
}

const BlockView = memo(function BlockView({ block, copyable = false }: { block: ContentBlock; copyable?: boolean }) {
  const { onOpenLocalLink } = useContext(TranscriptViewContext);
  const { text } = useI18n();
  if (block.kind === "session_info") return <SessionInfoBlock block={block} />;
  if (block.kind === "runtime_failure") return <RuntimeFailureCallout failure={block} />;
  if (block.kind === "image") return <TranscriptImageBlockView block={block} />;
  if (block.kind === "context") return <details className="block context-block transcript-disclosure"><summary><strong>{block.label}</strong><span>{toolPreview(block.text)} · {inlineSize(block.text)}</span></summary><pre>{block.text}</pre></details>;
  if (block.kind === "tool_use") {
    return <ChatToolCard name={block.name} status="completed" detail={block.inputJson} />;
  }
  if (block.kind === "tool_result") {
    return <ChatToolCard name={block.isError ? "도구 오류" : "도구 결과"} status={block.isError ? "failed" : "completed"} output={block.text} />;
  }
  if (block.kind === "thinking") return <details className="block thinking-block"><summary>추론</summary><pre>{block.text}</pre></details>;
  if (block.kind === "raw") return <details className="block raw-block transcript-disclosure"><summary><strong>{text("원본 이벤트", "Raw event")}</strong><span>{inlineSize(block.json)}</span></summary><pre>{block.json}</pre></details>;
  const { text: bodyText, meta } = splitAgentMessageMeta(block.text);
  return <div className="block text-block text-block-markdown">
    <MarkdownPreview source={bodyText} compact copyable={copyable} onOpenLocalLink={onOpenLocalLink} />
    <AgentMessageMetaList meta={meta} />
  </div>;
});

/**
 * 대화 기록에 base64로 박혀 있는 첨부 이미지. 목록 응답에는 위치만 담겨 오므로
 * 화면에서 필요할 때 원본 바이트를 따로 읽어 미리보기를 그린다.
 */
function TranscriptImageBlockView({ block }: { block: Extract<ContentBlock, { kind: "image" }> }) {
  const { text } = useI18n();
  const { source, sessionId } = useContext(TranscriptViewContext);
  const { sourceOffset, sourcePointer } = block;
  const directUrl = source && sessionId
    ? directSessionTranscriptImageUrl(source, sessionId, { sourceOffset, sourcePointer })
    : null;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setError(null);
    if (!source || !sessionId) {
      setUrl(null);
      return undefined;
    }
    if (directUrl) {
      setUrl(directUrl);
      return undefined;
    }
    let active = true;
    let objectUrl: string | null = null;
    void readSessionTranscriptImage(source, sessionId, { sourceOffset, sourcePointer })
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorText(cause));
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [directUrl, source, sessionId, sourceOffset, sourcePointer]);

  const fileName = `session-image${transcriptImageExtension(block.mediaType)}`;
  return (
    <div className="block transcript-image-block">
      {url && !error ? (
        <button
          className="transcript-image-thumb"
          type="button"
          title={text("원본 크기로 보기", "View full size")}
          onClick={() => setExpanded(true)}
        >
          <img src={url} alt={text("첨부 이미지", "Attached image")} onError={() => setError(text("이미지를 표시할 수 없습니다", "Could not display the image"))} />
        </button>
      ) : (
        <span className="transcript-image-fallback">
          <ImageIcon size={18} aria-hidden="true" />
          <span>{error ?? text("이미지를 읽고 있습니다…", "Loading the image…")}</span>
        </span>
      )}
      <span className="transcript-image-meta">
        <span>{block.mediaType} · {formatBytes(block.byteSize)}</span>
        {url && !error && <a href={url} download={fileName}>다운로드</a>}
      </span>
      {expanded && url && <TranscriptImageLightbox url={url} onClose={() => setExpanded(false)} />}
    </div>
  );
}

function TranscriptImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const { text } = useI18n();
  useEscapeToClose(onClose);
  return (
    <div className="transcript-image-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="transcript-image-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={text("첨부 이미지", "Attached image")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="icon-button" type="button" onClick={onClose} aria-label={text("이미지 닫기", "Close image")} autoFocus>
          <X size={16} />
        </button>
        <img src={url} alt={text("첨부 이미지", "Attached image")} />
      </div>
    </div>
  );
}

function transcriptImageExtension(mediaType: string): string {
  const subtype = mediaType.split("/")[1] ?? "";
  return /^[a-z0-9.+-]{1,12}$/.test(subtype) ? `.${subtype === "jpeg" ? "jpg" : subtype}` : "";
}

function SessionInfoBlock({ block }: { block: Extract<ContentBlock, { kind: "session_info" }> }) {
  const { text } = useI18n();
  const fields = [
    ["세션 ID", block.id],
    ["작업 경로", block.cwd ? displayPath(block.cwd) : block.cwd],
    ["실행 클라이언트", block.originator],
    ["CLI 버전", block.cliVersion],
    ["입력 소스", block.source],
    ["모델 공급자", block.modelProvider],
    ["스레드 종류", block.threadSource],
    ["기록 방식", block.historyMode],
    ["컨텍스트 ID", block.contextWindowId],
    ["등록 도구", runtimeText(`${block.toolCount.toLocaleString()}개`, block.toolCount.toLocaleString())],
  ].filter((field): field is [string, string] => Boolean(field[1]));

  return (
    <div className="session-info-block">
      <div className="session-info-grid">
        {fields.map(([label, value]) => (
          <div key={label}><span>{label}</span><strong title={value}>{value}</strong></div>
        ))}
      </div>
      <details className="session-info-raw transcript-disclosure">
        <summary>
          <strong>{text("원본 메타데이터", "Raw metadata")}</strong>
          <span>{inlineSize(block.rawJson)}{block.rawTruncated ? text(" · 일부 생략", " · partly omitted") : ""}</span>
        </summary>
        <pre>{block.rawJson}</pre>
      </details>
    </div>
  );
}

function toolPreview(text: string): string {
  if (!text) return "";
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const preview = value.file_path ?? value.path ?? value.command ?? value.cmd ?? value.query;
    if (typeof preview === "string") return preview;
  } catch { /* Plain tool output is summarized below. */ }
  return text.replace(/\s+/g, " ").slice(0, 72);
}

function inlineSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function roleName(role: string, text: UiText): string {
  if (role === INTERRUPTED_ROLE) return text("중단됨", "Interrupted");
  if (role === RUNTIME_FAILURE_ROLE) return text("실행 실패", "Run failed");
  if (role === "user") return text("사용자", "User");
  if (role === "assistant") return text("에이전트", "Agent");
  if (role === "system") return text("시스템", "System");
  return text("메타", "Meta");
}
