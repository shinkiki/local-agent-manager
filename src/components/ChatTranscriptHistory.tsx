import { useMemo, type ReactNode, type RefObject } from "react";
import { liveStreamBoundaryMs, transcriptBeforeLiveStream } from "../lib/transcriptOverlap";
import {
  TranscriptLimitSelect,
  TranscriptLoadEarlier,
  TranscriptTurns,
  useSessionTranscript,
} from "./SessionTranscript";
import { ErrorBanner } from "./Shared";
import type { ChatSessionInfo, SessionTranscriptLimit, TranscriptItem } from "../types";
import type { ChatTurn } from "./ChatConversation";
import type { ActivityFilter } from "../lib/activityFilter";

/**
 * 채팅 화면 위에 붙는 '현재 연결 이전 기록'. 어떤 채팅이 파일 원문을 읽어야 하는지,
 * 라이브 스트림과 겹치는 구간을 어디서 자르는지, 그 결과를 어떤 머리말과 함께 세우는지가
 * 한 덩어리라 채팅 화면 본문에서 갈라 두었다. 채팅 화면은 결과만 원하는 자리에 놓는다.
 */
export function useChatTranscriptHistory({
  session,
  turns,
  limit,
  onLimitChange,
  mode,
  activityFilter,
  scrollContainerRef,
  onOpenLocalLink,
}: {
  session: ChatSessionInfo | null;
  turns: ChatTurn[];
  limit: SessionTranscriptLimit;
  onLimitChange: (limit: SessionTranscriptLimit) => void;
  /** 원문을 대화 흐름으로 세울지 작업 로그로 세울지. 탭마다 다르다. */
  mode: "conversation" | "activity";
  activityFilter: ActivityFilter;
  /** 이전 구간을 붙인 뒤 읽던 자리를 되돌릴 때 쓸 스크롤 컨테이너. */
  scrollContainerRef: RefObject<HTMLElement | null>;
  onOpenLocalLink: (href: string) => void;
}): {
  /** 잘라내기 전 파일 원문 전체. 다른 에이전트로 넘길 때 인계 문맥으로 쓴다. */
  items: TranscriptItem[];
  /** 원문이 한 번이라도 도착했는지. 도착 시점에 스크롤을 다시 맞추는 쪽이 본다. */
  loaded: boolean;
  history: ReactNode;
} {
  /**
   * 라이브 스트림이 대화의 처음부터를 담고 있으면 파일 원문을 읽을 이유가 없다. 리플레이
   * 버퍼가 앞부분을 밀어냈거나(재접속·긴 대화) 기존 세션을 이어 시작한 채팅만 원문을 읽는다.
   */
  const missesHistory = Boolean(session && (session.replayTruncated || session.resuming));
  /**
   * 세션 파일에 남은 원문을 스트림 위에 붙이고, 라이브가 이미 담당하는 구간은 세션 상세와
   * 같은 경계 계산으로 잘라내 같은 턴이 두 번 보이지 않게 한다.
   */
  const transcript = useSessionTranscript({
    source: session?.source ?? null,
    sessionId: missesHistory ? session?.providerSessionId ?? null : null,
    limit,
    scrollContainerRef,
  });
  const liveStreamBoundary = useMemo(() => liveStreamBoundaryMs(turns), [turns]);
  const visible = useMemo(
    () => transcriptBeforeLiveStream(transcript.detail?.transcript ?? [], liveStreamBoundary),
    [transcript.detail, liveStreamBoundary],
  );

  // 잘라낸 결과가 비어도 더 불러올 앞 구간이 남아 있으면 머리말과 '이전 대화 더보기'는 남긴다.
  // 파일에 1,000개가 있고 최신 100개를 라이브가 전부 담당하는 채팅이 그 경우다.
  const history = session && (visible.length > 0 || transcript.earlierLoadCount > 0) ? (
    <div className="chat-transcript-history">
      <div className="chat-transcript-history-head">
        <div><strong>이전 대화 내역</strong><small>{transcript.detail?.skippedLines ? `읽지 못한 줄 ${transcript.detail.skippedLines.toLocaleString()}개` : "현재 연결 이전 기록"}</small></div>
        <TranscriptLimitSelect
          label="채팅 대화 표시 범위"
          value={limit}
          itemCount={transcript.detail ? visible.length : null}
          onChange={onLimitChange}
        />
      </div>
      {transcript.error && <ErrorBanner message={transcript.error} />}
      <TranscriptLoadEarlier
        count={transcript.earlierLoadCount}
        loading={transcript.loadingEarlier}
        error={transcript.earlierError}
        onLoad={() => void transcript.loadEarlier()}
      />
      <TranscriptTurns
        items={visible}
        mode={mode}
        activityFilter={activityFilter}
        source={session.source}
        sessionId={session.providerSessionId}
        onOpenLocalLink={onOpenLocalLink}
        scrollContainerRef={scrollContainerRef}
        windowed={limit === "all"}
      />
      {turns.length > 0 && <div className="chat-transcript-boundary"><span>여기부터 현재 연결</span></div>}
    </div>
  ) : null;

  return { items: transcript.detail?.transcript ?? [], loaded: Boolean(transcript.detail), history };
}
