/**
 * 계정 자격증명 사슬의 만료 예고.
 *
 * 공급자 OAuth 사슬은 토큰을 회전해도 수명이 늘지 않고, 로그인 시점부터 정해진 절대
 * 만료를 갖는다. 그 시각을 넘기면 갱신 요청이 거부되고 어느 사본도 살아 있지 않아
 * 재인증 말고는 길이 없다 — 그래서 만료는 **일어난 뒤 알리면 늦다.** 남은 기간이
 * 3일 아래로 떨어지는 순간부터 계정 카드에 적고, 그 문턱을 넘는 순간 기기로 한 번
 * 알린다.
 *
 * 판정을 이 모듈 하나에 두는 이유는 화면과 알림이 같은 창을 봐야 하기 때문이다. 한쪽만
 * 문턱을 바꾸면 알림은 울렸는데 카드에는 아무 말도 없는 상태가 생긴다.
 */

/** 만료를 예고하기 시작하는 남은 기간. */
export const CREDENTIAL_EXPIRY_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;

type ExpiringAccount = {
  id: string;
  displayName: string;
  credentialExpiresAt: number | null;
};

/**
 * 지금 만료를 예고할 계정인지. 만료 시각을 모르면(공급자가 밝히지 않음) 예고하지
 * 않는다 — 모르는 값을 추정해 재인증을 재촉하느니 조용한 편이 낫다.
 *
 * 이미 만료된 계정도 예고 대상이 아니다. 그때는 예고가 아니라 사실이고, 계정 카드의
 * "재인증 필요"와 사용량 오류가 그 상태를 말한다. 남은 기간을 셈하는 자리에서 음수
 * 기간을 "0일 남음"으로 적으면 아직 쓸 수 있는 것처럼 읽힌다.
 */
export function credentialExpiryImminent(
  account: Pick<ExpiringAccount, "credentialExpiresAt">,
  now: number,
): boolean {
  const expiresAt = account.credentialExpiresAt;
  if (expiresAt === null) return false;
  return now < expiresAt && expiresAt - now <= CREDENTIAL_EXPIRY_NOTICE_MS;
}

/**
 * 알림을 한 번만 내보내기 위한 기록 키. 계정과 만료 시각을 함께 담아, 재인증으로 사슬이
 * 바뀌면(만료 시각이 새로 잡히면) 다음 만료를 다시 알린다. 같은 사슬로는 몇 번을 다시
 * 켜도 울리지 않는다.
 */
export function credentialExpiryNoticeKey(
  account: Pick<ExpiringAccount, "id" | "credentialExpiresAt">,
): string {
  return `${account.id}\u0000${account.credentialExpiresAt ?? ""}`;
}

/**
 * 이번에 알려야 할 계정들. 예고 창에 들어왔고 아직 이 사슬로 알린 적이 없는 계정만
 * 남는다. 화면을 여는 시점에 이미 창 안이던 계정도 포함한다 — 기준선을 잡고 전환만
 * 보는 방식이면, 앱을 껐다 켠 사이에 창에 들어온 계정이 영영 조용해진다.
 */
export function accountsToNotifyForExpiry<T extends ExpiringAccount>(
  accounts: readonly T[],
  notified: ReadonlySet<string>,
  now: number,
): T[] {
  return accounts.filter((account) => (
    credentialExpiryImminent(account, now)
    && !notified.has(credentialExpiryNoticeKey(account))
  ));
}

/**
 * 만료까지 남은 일수. 화면에 적는 값이라 올림으로 센다 — 25시간 남았는데 "1일 남음"이라
 * 적으면 하루를 벌 수 있는 것처럼 읽히고, 1시간 남았는데 "0일"이라 적으면 이미 끝난
 * 것처럼 읽힌다. 하루가 채 남지 않았으면 1이다.
 */
export function daysUntilExpiry(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 86_400_000));
}
