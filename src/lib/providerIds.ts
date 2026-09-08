import type { ProviderId } from "../types";

/**
 * 공급자 식별자의 정본 목록. 같은 세 값을 파일마다 다시 적으면 공급자가 늘었을 때
 * 한쪽만 고쳐진다 — 페이싱 요약이 새 공급자의 회당 소비를 세지 않거나, 팝아웃 주소가
 * 그 공급자의 세션을 열어 주지 않는 식으로 조용히 어긋난다. 목록을 한 곳에 두면
 * 그런 어긋남이 애초에 생기지 않는다.
 *
 * 순서는 화면이 공급자를 나열하는 순서(클로드·코덱스·안티그래비티)와 같다.
 */
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex", "antigravity"];

/**
 * 바깥에서 들어온 값이 공급자 식별자인지 본다. 주소 쿼리처럼 사용자가 손으로 고칠 수
 * 있는 입력은 단언(`as ProviderId`)으로 통과시키면 타입만 맞고 값은 틀린 채 흘러가므로,
 * 좁히는 자리를 이 하나로 둔다.
 */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDER_IDS.includes(value as ProviderId);
}
