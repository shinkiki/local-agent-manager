/**
 * 긴 대화를 처음 열 때 본문을 가리는 막의 '여는 동안' 판정. 세션 상세와 채팅이 같은 규칙을
 * 쓰도록 `useOpeningVeil`(components/TranscriptPlacementVeil)이 이 판정으로 단계를 정하고,
 * 여기는 React 없이 시험할 수 있게 순수 함수로 둔다.
 */

/**
 * 원문을 읽는 단계의 상한. 큰 세션 파일은 읽는 데만 몇 초가 걸려 자리 잡기보다 넉넉히 두되,
 * 그동안 가려지는 것(이어지는 대화·막 보낸 메시지)이 오래 숨지 않도록 10초에서 끊는다.
 */
export const LOADING_VEIL_MAX_MS = 10_000;
/** 자리를 잡는 단계의 상한. 앞 구간 조회를 기다리다 멈춰도 본문이 가려진 채 남지 않게 한다. */
export const PLACING_VEIL_MAX_MS = 6_000;

export type OpeningVeilPhase = "loading" | "placing";

export type OpeningVeilInput = {
  /** 여는 대상(세션·채팅). 바뀌면 다시 여는 것이다. 없으면 가리지 않는다. */
  openKey: string | null;
  /** 막이 걷힌 대상. 같은 대상에서는 막이 다시 서지 않는다. */
  doneKey: string | null;
  loading: boolean;
  placing: boolean;
  /** 사람이 바로 봐야 할 오류가 본문 안에 떴는지. 서면 가리지 않고 여는 동안도 끝낸다. */
  interrupt?: boolean;
};

/** 지금 막이 서야 할 단계. `null`이면 막이 없다(여는 동안이 아니거나, 끝났거나, 오류가 떴다). */
export function openingVeilPhase({ openKey, doneKey, loading, placing, interrupt = false }: OpeningVeilInput): OpeningVeilPhase | null {
  const opening = openKey !== null && doneKey !== openKey;
  if (!opening || interrupt) return null;
  return loading ? "loading" : placing ? "placing" : null;
}

/**
 * 여는 동안을 끝내는 조건. `now`는 이 렌더에서 끝낸다(가릴 단계가 없다). 숫자는 그 단계의
 * 상한(ms)으로, 지나면 끝낸 것으로 친다 — 상한이 지나 걷힌 막도 끝난 것이라 늦게 온 원문이
 * 막을 다시 세우지 않는다. `null`은 아무것도 하지 않는다(열고 있지 않거나 이미 끝났다).
 */
export function openingVeilSettle(input: OpeningVeilInput): "now" | number | null {
  if (input.openKey === null || input.doneKey === input.openKey) return null;
  const phase = openingVeilPhase(input);
  if (phase === null) return "now";
  return phase === "loading" ? LOADING_VEIL_MAX_MS : PLACING_VEIL_MAX_MS;
}
