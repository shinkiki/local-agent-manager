import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { liveStreamBoundaryMs, transcriptBeforeLiveStream } from "../lib/transcriptOverlap";
import {
  TranscriptLimitSelect,
  TranscriptLoadEarlier,
  TranscriptTurns,
  useSessionTranscript,
} from "./SessionTranscript";
import { ErrorBanner } from "./Shared";
import { useI18n } from "../lib/i18n";
import type { ChatSessionInfo, SessionTranscriptLimit, TranscriptItem } from "../types";
import type { ChatTurn } from "./ChatConversation";
import type { ActivityFilter } from "../lib/activityFilter";

/**
 * 채팅이 이어받은 원문을 읽는다. 대개 이 채팅의 공급자 세션 파일이지만, Claude fork는 새
 * 세션 id를 미리 정해 두고 기록 파일은 첫 메시지를 보낼 때 만든다. 그 전에 새 id로 읽으면
 * "세션을 찾을 수 없습니다"가 이전 대화 자리에 뜨므로, 새 id가 읽히지 않으면 원본 세션에서
 * 읽는다. 원본으로 넘어가는 동안의 실패는 오류로 내보내지 않는다 — 내보내면 오류 배너가
 * 한 번 깜박이고, 자리 잡기는 원문이 오기 전에 끝난 것으로 읽는다.
 */
function useForkAwareTranscript(
  session: ChatSessionInfo | null,
  missesHistory: boolean,
  limit: SessionTranscriptLimit,
  scrollContainerRef: RefObject<HTMLElement | null>,
) {
  const ownId = missesHistory ? session?.providerSessionId ?? null : null;
  const forkSourceId = ownId ? session?.forkSourceSessionId ?? null : null;
  // 읽지 못한 새 세션 id. 다른 채팅으로 바뀌면 비운다 — 돌아왔을 때는 첫 메시지로 새 기록이
  // 생겼을 수 있고, 리플레이가 앞부분을 밀어냈다면 그 몫은 새 기록에만 있다.
  const [unreadableOwnId, setUnreadableOwnId] = useState<string | null>(null);
  const chatId = session?.chatId ?? null;
  useEffect(() => {
    setUnreadableOwnId(null);
  }, [chatId]);
  const historySessionId = forkSourceId && unreadableOwnId === ownId ? forkSourceId : ownId;
  const transcript = useSessionTranscript({
    source: session?.source ?? null,
    sessionId: historySessionId,
    limit,
    scrollContainerRef,
  });
  // 원본으로 넘어가는 것은 새 기록이 아직 없을 때뿐이다. 있는 파일을 읽다 난 다른 실패를
  // 원본의 짧은 기록으로 덮으면 무엇이 잘못됐는지 사라진다.
  const fallingBack = Boolean(
    forkSourceId && historySessionId === ownId && transcript.error && /찾을 수 없|not found/i.test(transcript.error),
  );
  useEffect(() => {
    if (fallingBack) setUnreadableOwnId(ownId);
  }, [fallingBack, ownId]);
  return {
    transcript: fallingBack ? { ...transcript, error: null } : transcript,
    historySessionId,
    fromForkSource: Boolean(forkSourceId && historySessionId === forkSourceId),
  };
}

/**
 * 채팅 화면 위에 붙는 '현재 연결 이전 기록'. 어떤 채팅이 파일 원문을 읽어야 하는지,
 * 라이브 스트림과 겹치는 구간을 어디서 자르는지, 그 결과를 어떤 머리말과 함께 세우는지가
 * 한 덩어리라 채팅 화면 본문에서 갈라 두었다. 채팅 화면은 결과만 원하는 자리에 놓는다.
 */
export function useChatTranscriptHistory({
  session,
  previewItems,
  turns,
  limit,
  onLimitChange,
  mode,
  activityFilter,
  scrollContainerRef,
  onOpenLocalLink,
  onEditMessage,
}: {
  session: ChatSessionInfo | null;
  previewItems?: TranscriptItem[];
  turns: ChatTurn[];
  limit: SessionTranscriptLimit;
  onLimitChange: (limit: SessionTranscriptLimit) => void;
  /** 원문을 대화 흐름으로 세울지 작업 로그로 세울지. 탭마다 다르다. */
  mode: "conversation" | "activity";
  activityFilter: ActivityFilter;
  /** 이전 구간을 붙인 뒤 읽던 자리를 되돌릴 때 쓸 스크롤 컨테이너. */
  scrollContainerRef: RefObject<HTMLElement | null>;
  onOpenLocalLink: (href: string) => void;
  onEditMessage?: (item: TranscriptItem, text: string, sendImmediately?: boolean) => Promise<void>;
}): {
  /** 잘라내기 전 파일 원문 전체. 다른 에이전트로 넘길 때 인계 문맥으로 쓴다. */
  items: TranscriptItem[];
  /** 원문이 한 번이라도 도착했는지. 도착 시점에 스크롤을 다시 맞추는 쪽이 본다. */
  loaded: boolean;
  /** 읽어야 할 원문이 아직 오지 않았는지. 오면 위에 붙어 화면이 밀리므로 그때까지 자리 잡기를 미룬다. */
  pending: boolean;
  /** 읽는 중인 원문을 받은 비율(0~1). 읽을 원문이 없거나 전체 크기를 모르면 null이다. */
  loadRatio: number | null;
  history: ReactNode;
} {
  const { text } = useI18n();
  /**
   * 라이브 스트림이 대화의 처음부터를 담고 있으면 파일 원문을 읽을 이유가 없다. 리플레이
   * 버퍼가 앞부분을 밀어냈거나(재접속·긴 대화) 기존 세션을 이어 시작하거나 분기한 채팅은 원문을 읽는다.
   */
  const missesHistory = Boolean(session && (session.replayTruncated || session.resuming || session.forked));
  /**
   * 세션 파일에 남은 원문을 스트림 위에 붙이고, 라이브가 이미 담당하는 구간은 세션 상세와
   * 같은 경계 계산으로 잘라내 같은 턴이 두 번 보이지 않게 한다.
   */
  const { transcript, historySessionId, fromForkSource } = useForkAwareTranscript(session, missesHistory, limit, scrollContainerRef);
  const forkStartedAt = fromForkSource ? session?.startedAt ?? null : null;
  // 원본 채팅은 fork 뒤에도 원본에 이어 쓸 수 있다. 그 뒤 대화는 이 채팅이 이어받은 것이
  // 아니므로 원본에서 읽었으면 fork를 시작한 시각에서 자른다. 화면과 인계 문맥이 같은 몫을 본다.
  const fileItems = useMemo(() => {
    const all = transcript.detail?.transcript ?? [];
    return forkStartedAt === null ? all : transcriptBeforeLiveStream(all, forkStartedAt);
  }, [transcript.detail, forkStartedAt]);
  const sourceItems = useMemo(() => (fileItems.length ? fileItems : previewItems ?? []), [fileItems, previewItems]);
  // 원본의 최근 구간이 전부 fork 뒤 대화면 자르고 나서 아무것도 남지 않는다. 이어받은 몫이
  // 나올 때까지 앞 구간을 더 읽고, 그동안은 원문이 아직 오지 않은 것으로 둔다.
  const fillingForkHistory = fromForkSource && Boolean(transcript.detail) && fileItems.length === 0
    && transcript.earlierLoadCount > 0 && !transcript.earlierError;
  const { loadingEarlier, loadEarlier } = transcript;
  useEffect(() => {
    if (fillingForkHistory && !loadingEarlier) void loadEarlier();
  }, [fillingForkHistory, loadingEarlier, loadEarlier]);
  // 원본에서 읽은 메시지의 순번은 이 채팅의 세션 파일 것이 아니라 편집 경계로 쓸 수 없다.
  const editHistoryMessage = fromForkSource ? undefined : onEditMessage;
  const liveStreamBoundary = useMemo(() => liveStreamBoundaryMs(turns), [turns]);
  const visible = useMemo(
    () => transcriptBeforeLiveStream(sourceItems, liveStreamBoundary),
    [sourceItems, liveStreamBoundary],
  );

  // 잘라낸 결과가 비어도 더 불러올 앞 구간이 남아 있으면 머리말과 '이전 대화 더보기'는 남긴다.
  // 파일에 1,000개가 있고 최신 100개를 라이브가 전부 담당하는 채팅이 그 경우다.
  const history = session && (visible.length > 0 || transcript.earlierLoadCount > 0 || transcript.error) ? (
    <div className="chat-transcript-history">
      <div className="chat-transcript-history-head">
        <div>
          <strong>{text("이전 대화 내역", "Earlier conversation")}</strong>
          <small>
            {transcript.detail?.skippedLines
              ? text(`읽지 못한 줄 ${transcript.detail.skippedLines.toLocaleString()}개`, `${transcript.detail.skippedLines.toLocaleString()} unreadable lines`)
              : text("현재 연결 이전 기록", "Before this connection")}
          </small>
        </div>
        <TranscriptLimitSelect
          label={text("채팅 대화 표시 범위", "Chat transcript range")}
          value={limit}
          itemCount={transcript.detail ? visible.length : null}
          onChange={onLimitChange}
        />
      </div>
      {transcript.error && !previewItems && <ErrorBanner message={transcript.error} />}
      <TranscriptLoadEarlier
        count={transcript.earlierLoadCount}
        loading={transcript.loadingEarlier}
        error={transcript.earlierError}
        onLoad={() => void transcript.loadEarlier()}
      />
      <TranscriptTurns
        onEditMessage={editHistoryMessage}
        items={visible}
        mode={mode}
        activityFilter={activityFilter}
        source={session.source}
        sessionId={historySessionId ?? session.providerSessionId}
        onOpenLocalLink={onOpenLocalLink}
        scrollContainerRef={scrollContainerRef}
        windowed={limit === "all"}
      />
      {turns.length > 0 && <div className="chat-transcript-boundary"><span>{text("여기부터 현재 연결", "Current connection starts here")}</span></div>}
    </div>
  ) : null;

  // 원문 훅은 지금 요청(세션·한도) 몫만 돌려주므로, 채팅을 바꾼 직후 앞 채팅 원문을 도착으로 세지 않는다.
  const loaded = (Boolean(transcript.detail) && !fillingForkHistory) || previewItems !== undefined;
  return {
    items: sourceItems,
    loaded,
    pending: missesHistory && Boolean(session?.providerSessionId) && !loaded && !transcript.error,
    loadRatio: transcript.loadRatio,
    history,
  };
}
