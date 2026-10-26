import { useEffect, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { openingVeilPhase, openingVeilSettle } from "../lib/openingVeil";

/**
 * 긴 대화를 처음 열 때 본문을 가릴지. 세션 상세와 채팅이 같은 규칙을 쓰도록 한 자리에 둔다.
 *
 * 처음 연 대화는 원문을 읽은 뒤 맨 위에 한 번 그려지고, 프레임마다 자리를 옮긴다 — 맨 아래로
 * 붙이기, 읽던 자리가 나올 때까지 위쪽 턴 펼치기, 앞 구간 불러와 위에 붙이기. 그 사이 글자가
 * 화면을 훑고 지나가 어지러우므로, 읽기부터 자리 잡기까지 막 하나로 가린다.
 *
 * - 여는 동안만이다. 한 번 걷힌 막은 같은 `openKey`(같은 대화)에서 다시 서지 않는다 — 다 연 뒤
 *   표시 범위를 바꾸거나 원문을 다시 읽을 때 읽던 화면을 가리지 않는다.
 * - `interrupt`(사람이 바로 봐야 할 오류가 본문 안에 떴는지)가 서면 가리지 않고, 그것으로 여는
 *   동안도 끝낸다. 흐르는 응답은 여기서 가르지 않는다 — 붙을 때 되풀이되는 지난 상태(리플레이)가
 *   잠깐씩 '응답 중'으로 보여, 그것으로 끝내면 막이 서야 할 긴 대화에서 막이 사라진다. 여는
 *   동안의 응답은 읽기 상한(10초) 안에서 함께 가린다.
 * - 단계마다 상한이 있다. 상한이 지나 걷힌 막도 끝난 것으로 쳐, 늦게 온 원문이 막을 다시 세워
 *   이미 읽던 본문을 가리는 일이 없다.
 * - `loading`도 `placing`도 아니게 되는 순간 여는 동안이 끝난다. 두 단계는 같은 렌더에서
 *   이어져야 막이 한 번만 선다.
 */
export function useOpeningVeil({ openKey, loading, placing, interrupt = false }: {
  /** 여는 대상(세션·채팅). 바뀌면 다시 여는 것이다. 없으면 가리지 않는다. */
  openKey: string | null;
  loading: boolean;
  placing: boolean;
  interrupt?: boolean;
}): boolean {
  const [doneKey, setDoneKey] = useState<string | null>(null);
  // 판정과 단계별 상한은 lib/openingVeil 이 정한다(순수 함수라 거기서 시험한다). 여기는 끝나는
  // 시점을 상태로 옮기는 일만 한다.
  const settle = openingVeilSettle({ openKey, doneKey, loading, placing, interrupt });
  useEffect(() => {
    if (openKey === null || settle === null) return undefined;
    if (settle === "now") {
      setDoneKey(openKey);
      return undefined;
    }
    const timer = window.setTimeout(() => setDoneKey(openKey), settle);
    return () => window.clearTimeout(timer);
  }, [openKey, settle]);
  return openingVeilPhase({ openKey, doneKey, loading, placing, interrupt }) !== null;
}

/**
 * 스크롤 본문 위에 덮는 진행 막. 본문 껍데기(`position: relative`) 안, 본문의 형제로
 * 둔다. 본문은 부르는 쪽이 `is-placing`으로 숨긴다 — 숨겨도 배치는 그대로라 자리 잡기의
 * 높이·위치 계산은 바뀌지 않고, 숨긴 본문은 휠·클릭을 받지 않아 자리를 잡는 중에 사용자
 * 조작으로 어긋나지도 않는다. 같은 겹의 스크롤 버튼은 그동안 세우지 않는다.
 */
export function TranscriptPlacementVeil({ progress = null }: {
  /**
   * 실제 진행 비율(0~1). 원문을 받은 바이트·되풀이된 지난 턴처럼 셀 수 있는 것만 넘긴다. 모르면
   * null — 그때는 흘러가는 막대를 보인다. 단계가 바뀌며 값이 줄어도 막대는 뒤로 가지 않는다.
   */
  progress?: number | null;
}) {
  const { text } = useI18n();
  // 막은 여는 동안 한 번만 서므로, 이 막이 보인 가장 큰 값을 쥐고 있으면 뒤로 가지 않는다.
  const shownRef = useRef<number | null>(null);
  if (progress !== null) shownRef.current = Math.max(shownRef.current ?? 0, Math.min(1, Math.max(0, progress)));
  const shown = shownRef.current;
  // 비율을 백분율로 내리는 곳은 여기 한 곳이다. 두 번 내리면 부동소수 오차로 29%가 28%로 보인다.
  const percent = shown === null ? null : Math.floor(shown * 100 + 1e-9);
  return (
    <div className="transcript-placement-veil" role="status" aria-live="polite">
      <div
        className={`progress${percent === null ? " is-indeterminate" : ""}`}
        role="progressbar"
        aria-label={text("로딩 진행률", "Loading progress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span style={percent === null ? undefined : { width: `${percent}%` }} />
      </div>
      {/* 백분율은 막대가 읽히므로 소리로 되풀이하지 않는다. 바뀔 때마다 알림이 쏟아진다. */}
      <small>{text("로딩 중입니다", "Loading…")}{percent !== null && <span aria-hidden="true"> {percent}%</span>}</small>
    </div>
  );
}
