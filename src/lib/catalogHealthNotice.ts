import type { CatalogHealth } from "../types";

// 갱신 상태 한 건을 화면 문구로 옮기는 규칙 — 어떤 어조로, 어떤 제목과 상세로 알릴지.
// 상태를 읽는 규칙(catalogHealth.ts)과는 바뀌는 이유가 다르다. 문구는 "무엇을 사용자에게
// 어떻게 알릴 것인가"라는 화면 구성이 바뀔 때 손대고, 상태 읽기는 백엔드가 스캔과 개정을
// 알리는 방식이 바뀔 때 손댄다. 화면들이 창구 하나만 알면 되도록 catalogHealth.ts가
// 이 모듈을 다시 내보낸다.

/** 목록 위에 띄울 갱신 상태 알림. */
export interface CatalogHealthNotice {
  tone: "warning" | "info";
  headline: string;
  detail: string | null;
}

/** 사람이 읽는 경과 시간. 분 단위 아래는 "방금"으로 묶는다. */
function formatCatalogAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
}

/** 스캔 저하와 마지막 갱신 오류를 백엔드가 만든 순서대로 한 줄에 모은다. */
function catalogHealthDetail(health: CatalogHealth): string | null {
  const reasons = health.degradedScans.map((scan) => scan.message);
  if (health.lastReconcileError) reasons.push(health.lastReconcileError);
  return reasons.length > 0 ? reasons.join(" · ") : null;
}

/** 오래된 목록이 어느 시점 기준인지, 아직 한 번도 갱신되지 않았는지 제목으로 만든다. */
function staleCatalogHeadline(health: CatalogHealth, nowMs: number): string {
  if (health.lastReconciledAt === null) return "세션 목록이 아직 갱신되지 않았습니다";
  const age = Math.max(0, nowMs - health.lastReconciledAt);
  return `세션 목록이 ${formatCatalogAge(age)} 전 기준입니다`;
}

/**
 * 갱신 상태를 화면 문구로 바꾼다. 정상이면 `null`.
 *
 * 스냅샷 읽기는 갱신이 완전히 멈춰도 성공하므로, 목록이 굳었는지는 이 상태로만 알 수
 * 있다. 예전에는 응답하지 않는 스킬 루트 하나 때문에 목록이 몇 시간 굳어도 화면에
 * 아무 표시가 없어, 사용자가 "특정 공급자 세션만 안 보인다"로 관측했다.
 */
export function catalogHealthNotice(
  health: CatalogHealth | null,
  nowMs: number,
): CatalogHealthNotice | null {
  if (!health) return null;
  const detail = catalogHealthDetail(health);

  if (health.stale) {
    return { tone: "warning", headline: staleCatalogHeadline(health, nowMs), detail };
  }
  if (detail) {
    return { tone: "info", headline: "일부 갱신이 지연되고 있습니다", detail };
  }
  return null;
}
