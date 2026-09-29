import type { UsageBudgetAccount } from "../types";

/**
 * 페이싱이 계정 **한 건**에서 읽어내는 값과, 그 값이 없을 때의 뜻.
 *
 * 카드가 보여 줄 한 장짜리 요약(`pacingSummary`)과 한 파일에 있었지만 둘이 바뀌는 이유는
 * 다르다. 여기 있는 것은 백엔드 스냅샷 한 칸의 해석이라 그 칸이 늘거나 null의 뜻이
 * 달라질 때 손대고(잴 수 없는 계정, 지나간 초기화 시각, 순여유가 빠진 구형 응답 —
 * QA #57·#75가 모두 이 자리다), 저쪽은 어느 카드가 무엇을 보여 주는가라 화면이 담을
 * 수치가 달라질 때 손댄다. 카드에 칸 하나를 더하러 들어온 사람이 "사용량을 못 읽은
 * 계정을 평균에서 어떻게 빼는가"까지 함께 읽을 필요는 없다. 목록과 저장 규칙을 가른
 * `navigationViews`/`navigationPreferences`, 문법과 덩어리 분할을 가른
 * `markdownFences`/`markdownChunks`와 같은 경계다.
 *
 * 여기서 내보내는 것은 요약을 짓는 쪽이 쓰는 만큼뿐이다. 계정 한 건의 해석을 이 파일
 * 밖에서 다시 조립하는 두 번째 경로를 열지 않도록, 화면이 직접 부르는 것은
 * `accountLabel` 하나이고 나머지는 `pacingSummary`를 거친다.
 */

/** 값이 하나도 없으면 평균 자체가 없다 — 0은 "평균이 0"이라는 다른 뜻이다. */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 페이싱에 참여하는 계정만. 풀 요약과 회차 대상 계산이 같은 판정을 쓴다. */
export function pooledAccounts(accounts: UsageBudgetAccount[]): UsageBudgetAccount[] {
  return accounts.filter((account) => account.pacingEnabled);
}

/**
 * 이 창의 소진율. 스냅샷은 사용량을 못 읽은 계정에 null을 담고 구형 응답에는 필드 자체가
 * 없으므로, "잴 수 있는 값"의 판정을 한 곳에만 둔다. 여기서 number를 돌려준 계정만
 * 평균·최댓값에 들어가고, 그 덕에 호출부에 non-null 단언이 남지 않는다.
 */
function usedPercentOf(account: UsageBudgetAccount): number | null {
  const value = account.overview?.usedPercent;
  return typeof value === "number" ? value : null;
}

/** 소진율을 잴 수 있는 계정만 값과 함께. */
export interface MeasuredUsage {
  account: UsageBudgetAccount;
  usedPercent: number;
}

/**
 * 소진율을 잴 수 있는 계정만 고른다. `usedPercent === null`의 뜻(사용량을 못 읽었다)을
 * 푸는 자리는 여기 하나뿐이고, 풀 요약과 회차 요약이 같은 목록을 받아 각자 필요한 것만
 * 만든다. 순서는 넘어온 그대로라 동률 비교가 "먼저 나온 계정"을 유지한다.
 */
export function measuredUsage(accounts: UsageBudgetAccount[]): MeasuredUsage[] {
  const measured: MeasuredUsage[] = [];
  for (const account of accounts) {
    const usedPercent = usedPercentOf(account);
    if (usedPercent !== null) measured.push({ account, usedPercent });
  }
  return measured;
}

/**
 * 잴 수 있는 계정만 본 창 소진율 평균. 풀 요약과 회차 요약이 같은 수치를 각자 조립하고
 * 있었는데, 평균 대상을 좁히는 규칙이 두 곳에 흩어져 있으면 한쪽만 고쳐진다.
 */
export function averageUsedPercent(measured: MeasuredUsage[]): number | null {
  return mean(measured.map((entry) => entry.usedPercent));
}

/**
 * 순여유. 소진율을 잰 계정에만 부른다 — 사용량을 못 읽은 계정을 0으로 넣으면 "여유 없는
 * 계정"이 평균에 섞여 실제보다 낮게 나오고, 바로 아래 "평균에서 빠졌습니다" 안내와도
 * 어긋난다(QA #57). 잰 계정인데 순여유만 없는 구형 응답은 여유가 없는 것으로 본다.
 */
export function headroomOf(account: UsageBudgetAccount): number {
  return account.overview?.netHeadroomPercent ?? 0;
}

/**
 * 잴 수 있는 계정만 본 순여유 평균. 소진율 평균과 마찬가지로 사용량을 읽지 못한
 * 계정은 제외한다(QA #57).
 */
export function averageHeadroomPercent(measured: MeasuredUsage[]): number | null {
  return mean(measured.map((entry) => headroomOf(entry.account)));
}

/** 가장 많이 쓴 계정 한 줄. 표시 이름까지 함께 들고 나온다. */
export interface BusiestUsage {
  label: string;
  usedPercent: number;
}

/**
 * 가장 많이 쓴 계정. 동률이면 먼저 나온 계정을 유지한다(비교가 strict `>`다).
 *
 * 평균 둘과 같은 자리에 둔다 — 셋 다 "잴 수 있는 계정만 본 목록"에서 나오는 집계이고,
 * 그 목록을 만드는 규칙(`measuredUsage`)이 여기 있다. 카드를 조립하는 쪽에 두면 최댓값만
 * 계정 해석을 다시 들고 있게 되고(표시 이름을 고르는 `accountLabel`까지 그쪽에서 부른다),
 * 동률 처리와 평균 대상이 같은 목록에서 나온다는 사실이 두 파일에 나뉘어 적힌다.
 */
export function busiestUsage(measured: MeasuredUsage[]): BusiestUsage | null {
  let busiest: BusiestUsage | null = null;
  for (const entry of measured) {
    if (!busiest || entry.usedPercent > busiest.usedPercent) {
      busiest = { label: accountLabel(entry.account), usedPercent: entry.usedPercent };
    }
  }
  return busiest;
}

/**
 * 앞으로 올 창 초기화 시각(epoch ms). 없거나 이미 지났으면 null.
 *
 * QA #75 — 예전에는 `resetsAt > 0`만 따져 이미 지나간 시각도 후보로 삼았고, 카드의
 * "가장 이른 초기화"가 '1시간 전'을 냈다. 막대가 쓰는 판정(`formatCountdown`은 남은 시간이
 * 0 이하면 null)과 같게, 지금보다 미래인 시각만 센다.
 */
export function resetTimeOf(account: UsageBudgetAccount, now: number): number | null {
  const resetsAt = account.overview?.resetsAt;
  return typeof resetsAt === "number" && resetsAt > now ? resetsAt : null;
}

/**
 * 참여 계정 중 가장 먼저 초기화되는 창의 시각. 모두 지났거나 없으면 null.
 *
 * 초기화 시각 한 건의 뜻(`resetTimeOf` — 지나간 시각은 없는 것과 같다)을 푸는 자리가
 * 여기이므로, 그 값을 모아 가장 이른 것을 고르는 일도 같은 자리에 둔다. 카드 쪽에서
 * 모으면 "지나간 시각을 어떻게 볼 것인가"(QA #75)가 두 파일에 걸쳐 읽힌다.
 */
export function earliestResetAt(accounts: UsageBudgetAccount[], now: number): number | null {
  let earliest: number | null = null;
  for (const account of accounts) {
    const resetsAt = resetTimeOf(account, now);
    if (resetsAt !== null && (earliest === null || resetsAt < earliest)) earliest = resetsAt;
  }
  return earliest;
}

/**
 * 비활성으로 꺼져 있어 회차가 쓰지 못하는 계정 수.
 *
 * `disabled` 칸을 읽는 자리는 여기 하나다. 카드를 조립하는 쪽이 스냅샷 칸을 직접
 * 들여다보면 계정 한 건의 해석이 이 파일 밖에서 다시 조립되는 두 번째 경로가 열린다 —
 * "쓸 수 없는 계정"의 뜻이 넓어지는 날(예: 자격증명이 만료된 계정) 한쪽만 고쳐진다.
 */
export function disabledCount(accounts: UsageBudgetAccount[]): number {
  return accounts.filter((account) => account.disabled).length;
}

/**
 * 칩·모달이 함께 쓰는 계정 표시 이름. 좌측 메뉴 미터와 같은 이름을 쓰도록 설정에서 정한
 * 표시 이름을 우선하고, 그 값이 비어 있을 때만 이메일로 떨어진다.
 */
export function accountLabel(account: UsageBudgetAccount): string {
  return account.displayName || account.email || account.accountId;
}
