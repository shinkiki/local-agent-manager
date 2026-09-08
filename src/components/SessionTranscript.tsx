import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CircleAlert, History, Image as ImageIcon, OctagonPause, X } from "lucide-react";
import {
  directSessionTranscriptImageUrl,
  getSessionDetail,
  readSessionTranscriptImage,
} from "../lib/ipc";
import { formatBytes, formatDate, formatTokens } from "../lib/format";
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

export const SESSION_TRANSCRIPT_LIMIT_KEY = "agent-manager.session-transcript-limit";
export const DEFAULT_SESSION_TRANSCRIPT_LIMIT: SessionTranscriptLimit = "latest100";
const SESSION_TRANSCRIPT_LIMITS: SessionTranscriptLimit[] = ["latest100", "latest500", "latest1000", "all"];
const SESSION_TRANSCRIPT_CHUNK_SIZES: Partial<Record<SessionTranscriptLimit, number>> = {
  latest100: 100,
  latest500: 500,
  latest1000: 1000,
};

export function readSessionTranscriptLimit(): SessionTranscriptLimit {
  if (typeof window === "undefined") return DEFAULT_SESSION_TRANSCRIPT_LIMIT;
  try {
    const stored = window.localStorage.getItem(SESSION_TRANSCRIPT_LIMIT_KEY) as SessionTranscriptLimit | null;
    return stored && SESSION_TRANSCRIPT_LIMITS.includes(stored)
      ? stored
      : DEFAULT_SESSION_TRANSCRIPT_LIMIT;
  } catch {
    return DEFAULT_SESSION_TRANSCRIPT_LIMIT;
  }
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
  const [anchor, setAnchor] = useState<{ height: number; top: number } | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const refresh = useCallback(() => setRefreshRevision((current) => current + 1), []);

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    setLoadingEarlier(false);
    setEarlierError(null);
    setAnchor(null);
    if (!source || !sessionId) return () => { active = false; };
    getSessionDetail(source, sessionId, limit)
      .then((value) => active && setDetail(value))
      .catch((cause: unknown) => active && setError(errorText(cause)));
    return () => { active = false; };
  }, [source, sessionId, limit, refreshRevision]);

  // 이전 구간 조회용 커서. tail 파싱에서는 항목 순번이 아니라 원본 파일의
  // 바이트 오프셋이므로 개수처럼 표시하면 안 된다. 0이면 앞선 항목이 없다.
  const oldestTranscriptIndex = useMemo(() => (
    detail && detail.transcript.length > 0
      ? detail.transcript.reduce((min, item) => Math.min(min, item.index), Number.MAX_SAFE_INTEGER)
      : 0
  ), [detail]);
  const earlierChunkSize = SESSION_TRANSCRIPT_CHUNK_SIZES[limit];
  const earlierLoadCount = detail?.truncated && earlierChunkSize
    ? Math.min(earlierChunkSize, oldestTranscriptIndex)
    : 0;

  const loadEarlier = useCallback(async () => {
    if (!source || !sessionId || loadingEarlier || earlierLoadCount <= 0) return;
    setLoadingEarlier(true);
    setEarlierError(null);
    const container = scrollContainerRef.current;
    const measured = container ? { height: container.scrollHeight, top: container.scrollTop } : null;
    try {
      const page = await getSessionDetail(source, sessionId, limit, oldestTranscriptIndex);
      setAnchor(measured);
      setDetail((prev) => prev && {
        ...prev,
        transcript: [...page.transcript, ...prev.transcript],
        truncated: page.transcript.length > 0 ? page.truncated : false,
      });
    } catch (cause) {
      setEarlierError(errorText(cause));
    } finally {
      setLoadingEarlier(false);
    }
  }, [earlierLoadCount, limit, loadingEarlier, oldestTranscriptIndex, scrollContainerRef, sessionId, source]);

  // 이전 구간을 위쪽에 붙인 뒤에도 보고 있던 위치가 유지되도록 스크롤을 보정한다.
  useLayoutEffect(() => {
    if (!anchor) return;
    setAnchor(null);
    const container = scrollContainerRef.current;
    if (container) container.scrollTop = anchor.top + (container.scrollHeight - anchor.height);
  }, [anchor, detail, scrollContainerRef]);

  return { detail, error, loadingEarlier, earlierError, earlierLoadCount, loadEarlier, refresh };
}

/** 트랜스크립트 위쪽의 '이전 대화 더보기'. 더 불러올 구간이 없으면 아무것도 그리지 않는다. */
export function TranscriptLoadEarlier({ count, loading, error, onLoad }: {
  count: number;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}) {
  if (count <= 0) return null;
  return (
    <div className="transcript-load-earlier">
      <button className="button compact" type="button" disabled={loading} onClick={onLoad}>
        <History size={13} aria-hidden="true" />
        <span>{loading ? "이전 대화를 불러오는 중…" : "이전 대화 더보기"}</span>
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
  return (
    <label className="session-transcript-range">
      <span>
        <strong>대화 내역 표시 범위</strong>
        <small>{itemCount === null ? "불러오는 중" : `${itemCount.toLocaleString()}개 항목 표시 중`}</small>
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as SessionTranscriptLimit)}
      >
        <option value="latest100">최신 100개</option>
        <option value="latest500">최신 500개</option>
        <option value="latest1000">최신 1,000개</option>
        <option value="all">전체</option>
      </select>
    </label>
  );
}

export function ActivityFilterSelect({ value, onChange }: {
  value: ActivityFilter;
  onChange: (filter: ActivityFilter) => void;
}) {
  return (
    <select
      className="activity-filter-select"
      aria-label="작업 로그 항목 필터"
      value={value}
      onChange={(event) => onChange(event.target.value as ActivityFilter)}
    >
      <option value="all">전체</option>
      <option value="tool">도구 실행</option>
      <option value="reasoning">진행 상황</option>
      <option value="skill">사용 스킬</option>
      <option value="error">오류·승인</option>
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
            <span>이전 대화 {Math.min(TRANSCRIPT_MOUNT_STEP, hiddenCount).toLocaleString()}개 더 표시</span>
          </button>
          <small>아직 표시하지 않은 대화 {hiddenCount.toLocaleString()}개</small>
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
  const anchorRef = useRef<{ height: number; top: number } | null>(null);

  // 위쪽에 턴을 붙이면 보고 있던 내용이 아래로 밀린다. 붙이기 전 높이를 재 두고 뒤에서 보정한다.
  const showEarlierTurns = useCallback(() => {
    const container = scrollContainerRef?.current ?? null;
    anchorRef.current = container ? { height: container.scrollHeight, top: container.scrollTop } : null;
    setMounted((current) => current + TRANSCRIPT_MOUNT_STEP);
  }, [scrollContainerRef]);

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
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    const container = scrollContainerRef?.current;
    if (container) container.scrollTop = anchor.top + (container.scrollHeight - anchor.height);
  }, [mounted, scrollContainerRef]);

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
  const conversationItems = turn.items.filter((item) =>
    item.blocks.some((block) => isConversationBlock(block, item)));
  const activityItems = turn.items.filter((item) =>
    item.blocks.some((block) => isActivityBlock(block, item))
    && transcriptActivityMatches(item.blocks, activityFilter));
  const conversationActivityItems = turn.items.filter((item) =>
    item.blocks.some((block) => isConversationActivityBlock(block, item)));
  const lastAssistantItem = [...conversationItems].reverse().find((item) => item.role === "assistant");

  if (mode === "activity") {
    if (activityItems.length === 0) return null;
    const activityStatus = transcriptActivityStatus(activityItems);
    return <section className="transcript-turn activity-turn">
      <header><span className={`chat-tool-state chat-tool-state-${activityStatus}`} /><strong>{turn.title}</strong><time>{transcriptActivityStatusLabel(activityStatus)} · {formatDate(turn.startedAt)}</time></header>
      <div>{activityItems.map((item) => <TranscriptArticle item={item} blocks="activity" key={item.index} />)}</div>
    </section>;
  }

  return <section className="transcript-turn conversation-turn">
    {conversationItems.filter((item) => item.role === "user").map((item) => <TranscriptArticle item={item} blocks="conversation" key={item.index} />)}
    <ChatSkillUsageCard usages={collectTranscriptSkillUsages(turn.items)} />
    {conversationActivityItems.length > 0 && <ConversationActivitySummary items={conversationActivityItems} />}
    {conversationItems.filter((item) => item.role !== "user").map((item) => <TranscriptArticle item={item} blocks="conversation" speechReady={item === lastAssistantItem} key={item.index} />)}
  </section>;
}

function ConversationActivitySummary({ items }: { items: TranscriptItem[] }) {
  const status = transcriptActivityStatus(items);
  return <ChatActivityGroup
    entries={items}
    active={false}
    status={status}
    statusText={transcriptActivityStatusLabel(status)}
    summary={transcriptActivitySummary(items)}
    entryKey={(item) => String(item.index)}
    renderEntry={(item) => <TranscriptArticle item={item} blocks="operational" />}
  />;
}

const TranscriptArticle = memo(function TranscriptArticle({ item, blocks, speechReady = false }: { item: TranscriptItem; blocks: "conversation" | "activity" | "operational"; speechReady?: boolean }) {
  const visible = item.blocks.filter((block) => blocks === "conversation"
    ? isConversationBlock(block, item)
    : blocks === "operational" ? isConversationActivityBlock(block, item) : isActivityBlock(block, item));
  if (visible.length === 0) return null;
  // CLI가 남긴 중단 자리표시자는 요청이 아니라 턴이 끊긴 지점이므로 구분선으로만 보여준다.
  if (item.role === INTERRUPTED_ROLE) {
    return (
      <div className="transcript-interrupt">
        <OctagonPause size={12} aria-hidden="true" />
        <span>{item.typeLabel ?? roleName(item.role)}</span>
        <time>{formatDate(item.timestamp)}</time>
      </div>
    );
  }
  // 응답이 끝나지 못한 지점은 말풍선이 아니라 실패 표식으로 보여준다.
  if (item.role === RUNTIME_FAILURE_ROLE) {
    const failure = item.blocks.find(
      (block): block is Extract<ContentBlock, { kind: "runtime_failure" }> => block.kind === "runtime_failure",
    );
    return failure ? <RuntimeFailureCallout failure={failure} timestamp={item.timestamp} /> : null;
  }
  const toolEvent = visible.every((block) => block.kind === "tool_use" || block.kind === "tool_result" || isToolImage(block, item));
  const sessionInfoEvent = visible.some((block) => block.kind === "session_info");
  const reasoningEvent = visible.every((block) => block.kind === "thinking");
  const contextEvent = visible.every((block) => block.kind === "context" || block.kind === "raw");
  const messageKind = sessionInfoEvent ? "session-info" : toolEvent ? "tool-event" : reasoningEvent ? "reasoning" : contextEvent ? "context" : item.role;
  const roleLabel = item.role === "user" ? "사용자 요청" : item.role === "assistant" ? "에이전트 응답" : item.typeLabel ?? roleName(item.role);
  const messageLabel = sessionInfoEvent
    ? "세션 정보"
    : toolEvent
      ? "도구 실행"
      : reasoningEvent
        ? "진행 상황"
        : contextEvent
          ? item.typeLabel ?? "런타임 컨텍스트"
          : roleLabel;
  const copyText = item.role === "assistant" && blocks === "conversation"
    // 화면에 안 그리는 공급자 메타 블록은 복사본과 읽어주기에도 들어가지 않는다.
    ? joinMarkdownBlocks(visible.flatMap((block) => block.kind === "text" ? [splitAgentMessageMeta(block.text).text] : []))
    : "";
  if (toolEvent) {
    return <div className="transcript-tool-sequence">{visible.map((block, index) => <BlockView block={block} key={index} />)}</div>;
  }
  return (
    <article className={`message message-${messageKind}`}>
      <header><strong>{messageLabel}</strong><span>{item.model ?? ""}</span><time>{formatDate(item.timestamp)}</time></header>
      {copyText && speechReady && <SpeechPlaybackAction responseId={`session:${item.index}:${item.timestamp ?? "unknown"}`} text={copyText} />}
      {copyText && <CopyAction value={copyText} kind="response" className="message-copy-action" />}
      {visible.map((block, index) => <BlockView block={block} copyable={Boolean(copyText)} key={index} />)}
      {item.usage && <footer>입력 {formatTokens(item.usage.input)} · 출력 {formatTokens(item.usage.output)} · 캐시 {formatTokens(item.usage.cacheRead + item.usage.cacheWrite)}</footer>}
    </article>
  );
});

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

function isConversationBlock(block: ContentBlock, item: TranscriptItem): boolean {
  return block.kind === "text" || block.kind === "runtime_failure" || (block.kind === "image" && !isToolImage(block, item));
}

function isActivityBlock(block: ContentBlock, item: TranscriptItem): boolean {
  return block.kind === "context" || block.kind === "thinking" || block.kind === "tool_use" || block.kind === "tool_result" || block.kind === "session_info" || block.kind === "raw" || block.kind === "runtime_failure" || isToolImage(block, item);
}

/** 대화 흐름에 딸려 나오는 작업 로그. 스킬 실행은 사용 스킬 카드가 대신 보여준다. */
function isConversationActivityBlock(block: ContentBlock, item: TranscriptItem): boolean {
  if (isSkillUsageBlock(block)) return false;
  return block.kind === "thinking" || block.kind === "tool_use" || block.kind === "tool_result" || isToolImage(block, item);
}

function transcriptActivitySummary(items: TranscriptItem[]): string {
  // 사용 스킬 카드로 빠진 블록은 이 요약에서도 뺀다. 그러지 않으면 접힌 로그의 개수가
  // 펼쳤을 때 실제로 보이는 항목 수와 어긋난다.
  const blocks = items.flatMap((item) => item.blocks).filter((block) => !isSkillUsageBlock(block));
  const tools = Math.max(
    blocks.filter((block) => block.kind === "tool_use").length,
    blocks.filter((block) => block.kind === "tool_result").length,
  );
  const reasoning = blocks.filter((block) => block.kind === "thinking").length;
  const contexts = blocks.filter((block) => block.kind === "context" || block.kind === "session_info" || block.kind === "raw").length;
  const failures = blocks.filter((block) => block.kind === "runtime_failure").length;
  return [tools ? `도구 ${tools}개` : "", reasoning ? `진행 상황 ${reasoning}개` : "", contexts ? `컨텍스트 ${contexts}개` : "", failures ? `응답 실패 ${failures}개` : ""].filter(Boolean).join(" · ") || "작업 로그";
}

function transcriptActivityStatus(items: TranscriptItem[]): "completed" | "failed" {
  return items.some((item) => item.blocks.some((block) => (block.kind === "tool_result" && block.isError) || block.kind === "runtime_failure")) ? "failed" : "completed";
}

function transcriptActivityStatusLabel(status: "completed" | "failed"): string {
  return status === "failed" ? "실패 포함" : "응답 종료";
}

/** 응답이 끝나지 못한 지점의 실패 표식. 상태 문구·오류 코드·시각과 실패 안내 본문을 담는다. */
function RuntimeFailureCallout({ failure, timestamp = null }: { failure: Extract<ContentBlock, { kind: "runtime_failure" }>; timestamp?: number | null }) {
  return (
    <div className="transcript-runtime-failure">
      <div>
        <CircleAlert size={12} aria-hidden="true" />
        <span>{failure.status === "interrupted" ? "요청이 중단되었습니다" : "응답을 완료하지 못했습니다"}</span>
        <code>{failure.code}</code>
        {timestamp !== null && <time>{formatDate(timestamp)}</time>}
      </div>
      {failure.text.trim() !== "" && <p>{failure.text}</p>}
    </div>
  );
}

const BlockView = memo(function BlockView({ block, copyable = false }: { block: ContentBlock; copyable?: boolean }) {
  const { onOpenLocalLink } = useContext(TranscriptViewContext);
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
  if (block.kind === "raw") return <details className="block raw-block transcript-disclosure"><summary><strong>원본 이벤트</strong><span>{inlineSize(block.json)}</span></summary><pre>{block.json}</pre></details>;
  const { text, meta } = splitAgentMessageMeta(block.text);
  return <div className="block text-block text-block-markdown">
    <MarkdownPreview source={text} compact copyable={copyable} onOpenLocalLink={onOpenLocalLink} />
    <AgentMessageMetaList meta={meta} />
  </div>;
});

/**
 * 대화 기록에 base64로 박혀 있는 첨부 이미지. 목록 응답에는 위치만 담겨 오므로
 * 화면에서 필요할 때 원본 바이트를 따로 읽어 미리보기를 그린다.
 */
function TranscriptImageBlockView({ block }: { block: Extract<ContentBlock, { kind: "image" }> }) {
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
          title="원본 크기로 보기"
          onClick={() => setExpanded(true)}
        >
          <img src={url} alt="첨부 이미지" onError={() => setError("이미지를 표시할 수 없습니다")} />
        </button>
      ) : (
        <span className="transcript-image-fallback">
          <ImageIcon size={18} aria-hidden="true" />
          <span>{error ?? "이미지를 읽고 있습니다…"}</span>
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
  useEscapeToClose(onClose);
  return (
    <div className="transcript-image-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="transcript-image-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="첨부 이미지"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="icon-button" type="button" onClick={onClose} aria-label="이미지 닫기" autoFocus>
          <X size={16} />
        </button>
        <img src={url} alt="첨부 이미지" />
      </div>
    </div>
  );
}

function transcriptImageExtension(mediaType: string): string {
  const subtype = mediaType.split("/")[1] ?? "";
  return /^[a-z0-9.+-]{1,12}$/.test(subtype) ? `.${subtype === "jpeg" ? "jpg" : subtype}` : "";
}

function SessionInfoBlock({ block }: { block: Extract<ContentBlock, { kind: "session_info" }> }) {
  const fields = [
    ["세션 ID", block.id],
    ["작업 경로", block.cwd],
    ["실행 클라이언트", block.originator],
    ["CLI 버전", block.cliVersion],
    ["입력 소스", block.source],
    ["모델 공급자", block.modelProvider],
    ["스레드 종류", block.threadSource],
    ["기록 방식", block.historyMode],
    ["컨텍스트 ID", block.contextWindowId],
    ["등록 도구", `${block.toolCount.toLocaleString()}개`],
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
          <strong>원본 메타데이터</strong>
          <span>{inlineSize(block.rawJson)}{block.rawTruncated ? " · 일부 생략" : ""}</span>
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

function roleName(role: string): string {
  if (role === INTERRUPTED_ROLE) return "중단됨";
  if (role === RUNTIME_FAILURE_ROLE) return "실행 실패";
  if (role === "user") return "사용자";
  if (role === "assistant") return "에이전트";
  if (role === "system") return "시스템";
  return "메타";
}
