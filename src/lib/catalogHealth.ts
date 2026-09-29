import type { CatalogHealth, CatalogScanKind } from "../types";

// 백엔드가 내려준 갱신 상태 한 건을 읽는 규칙 — 들고 있는 목록을 다시 받아야 하는지,
// 어떤 스캔이 무엇을 건너뛰었는지. 그 상태를 화면 문구로 옮기는 일(catalogHealthNotice.ts)과는
// 바뀌는 이유가 다르다. 이쪽은 백엔드가 스캔과 개정을 알리는 방식이 바뀔 때 손대고,
// 문구는 무엇을 어떤 어조로 먼저 알릴지가 바뀔 때 손댄다.
// 화면들이 창구 하나만 알면 되도록 문구 쪽은 여기서 다시 내보낸다.
export { catalogHealthNotice } from "./catalogHealthNotice.ts";
export type { CatalogHealthNotice } from "./catalogHealthNotice.ts";

/** 개정 비교에 필요한 만큼의 스냅샷. 화면이 들고 있는 목록이 어느 개정인지만 본다. */
interface HeldRevisions {
  sessionCatalogRevision: number;
  resourceCatalogRevision: number;
}

/**
 * 화면이 들고 있는 목록을 다시 받아야 하는지.
 *
 * 두 축을 모두 본다. 예전에는 세션 개정만 봤는데, 백엔드의 리소스 스캔은 스킬·에이전트·
 * 산출물이 바뀔 때 따로 개정을 올린다. 대화가 오가지 않는 동안 AIA가 스킬을 게시하면
 * 세션 개정은 그대로라, 한 축만 보는 화면은 새 스킬을 영영 받지 못했다.
 */
export function catalogRefreshNeeded(
  held: HeldRevisions | null,
  health: CatalogHealth | null,
): boolean {
  if (!held || !health) return false;
  return held.sessionCatalogRevision !== health.sessionRevision
    || held.resourceCatalogRevision !== health.resourceRevision;
}

/**
 * 한 스캔이 건너뛴 경로 안내만 골라낸다. 건너뛴 곳이 없으면 빈 배열.
 *
 * 예전에는 "한 종류만"과 "전부"를 한 함수가 없을 수 있는 종류 인자 하나로 갈랐고, 이
 * 함수는 그 앞에 없는 상태만 걸러 주는 껍데기였다. 부르는 두 자리가 실제로 묻는 것은
 * 서로 다른 질문인데 인자를 생략했다는 사실이 "전부"를 뜻한다는 규칙이 함수 안에만 있어,
 * 호출부만 읽어서는 어느 질문인지 알 수 없었다. 질문은 묻는 자리에서 직접 적는다.
 *
 * 세션 배너는 세션 갱신 기준으로만 문구를 만들기 때문에, 스킬·에이전트 목록이 응답하지
 * 않는 경로를 건너뛴 채 완성돼도 그 화면에는 아무 표시가 남지 않는다. 목록이 0건이면
 * 사용자는 "스킬이 없다"로 읽지만 실제 원인은 접근할 수 없는 경로다. 문구는 백엔드가
 * 만든 것을 그대로 쓰고, 제목은 화면이 자기 언어로 붙인다.
 */
export function degradedScanMessages(
  health: CatalogHealth | null,
  kind: CatalogScanKind,
): string[] {
  if (!health) return [];
  return health.degradedScans
    .filter((scan) => scan.kind === kind)
    .map((scan) => scan.message);
}
