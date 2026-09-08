import type { CatalogHealth, CatalogScanKind } from "../types";

/** 목록 위에 띄울 갱신 상태 알림. */
export interface CatalogHealthNotice {
  tone: "warning" | "info";
  headline: string;
  detail: string | null;
}

/** 사람이 읽는 경과 시간. 분 단위 아래는 "방금"으로 묶는다. */
export function formatCatalogAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
}

/**
 * 한 스캔이 건너뛴 경로 안내만 골라낸다. 건너뛴 곳이 없으면 빈 배열.
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
  return health.degradedScans.filter((scan) => scan.kind === kind).map((scan) => scan.message);
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
  const reasons = health.degradedScans.map((scan) => scan.message);
  if (health.lastReconcileError) reasons.push(health.lastReconcileError);
  const detail = reasons.length > 0 ? reasons.join(" · ") : null;

  if (health.stale) {
    const age = health.lastReconciledAt === null
      ? null
      : Math.max(0, nowMs - health.lastReconciledAt);
    const when = age === null
      ? "아직 갱신되지 않았습니다"
      : `${formatCatalogAge(age)} 전 기준입니다`;
    return { tone: "warning", headline: `세션 목록이 ${when}`, detail };
  }
  if (detail) {
    return { tone: "info", headline: "일부 갱신이 지연되고 있습니다", detail };
  }
  return null;
}
