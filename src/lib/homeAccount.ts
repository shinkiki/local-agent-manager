import type { ProviderAccountView, ProviderHomeView, ProviderId } from "../types";
import { IDLE_USAGE_REFRESH_INTERVAL_MS, usageRefreshDeferred, usageResetElapsedSinceUpdate } from "./accountUsage.ts";
import { formatRelative } from "./format.ts";
import type { UiText } from "./i18nLocale.ts";

type HomeAccountTone = "muted" | "ready" | "warning";

interface HomeAccountSummary {
  title: string;
  detail: string;
  tone: HomeAccountTone;
}

function mutedHomeSummary(title: string, detail: string): HomeAccountSummary {
  return { title, detail, tone: "muted" };
}

function uncheckedHomeSummary(text: UiText): HomeAccountSummary {
  return mutedHomeSummary(
    text("확인 중", "Checking"),
    text("공유 CLI 홈의 로그인을 아직 읽지 않았습니다.", "The shared CLI home has not been read yet."),
  );
}

function absentHomeSummary(text: UiText): HomeAccountSummary {
  return mutedHomeSummary(
    text("로그인 없음", "Not signed in"),
    text("공유 CLI 홈에 저장된 로그인이 없습니다.", "No credential is stored in the shared CLI home."),
  );
}

function expiredReauthGuidance(provider: ProviderId, text: UiText): string {
  if (provider === "claude") {
    return text(
      "터미널에서 claude를 열어 /login으로 다시 로그인하면 확인됩니다. Claude 데스크탑 앱 로그인은 공유 홈과 별개입니다.",
      "Run claude in a terminal and sign in again with /login to verify it. The Claude desktop app keeps a separate sign-in.",
    );
  }
  return text(
    "ChatGPT 데스크탑 앱을 쓰거나 터미널에서 다시 로그인하면 확인됩니다.",
    "Use the ChatGPT desktop app or sign in again from a terminal to verify it.",
  );
}

function expiredHomeSummary(provider: ProviderId, text: UiText): HomeAccountSummary {
  const common = text(
    "Agent Manager는 공유 홈 토큰을 갱신하지 않습니다.",
    "Agent Manager does not refresh the shared home token.",
  );
  return {
    title: text("만료된 로그인 · 신원 미확인", "Expired sign-in · identity unknown"),
    detail: `${common} ${expiredReauthGuidance(provider, text)}`,
    tone: "warning",
  };
}

function failedHomeSummary(home: ProviderHomeView, text: UiText): HomeAccountSummary {
  const parts = [home.error ?? text("원인을 알 수 없습니다.", "Unknown cause.")];
  if (home.retryAt) {
    parts.push(text(`다음 확인 ${formatRelative(home.retryAt)}`, `next check ${formatRelative(home.retryAt)}`));
  }
  return {
    title: text("신원 확인 실패", "Identity check failed"),
    detail: parts.join(" · "),
    tone: "warning",
  };
}

function verifiedHomeSummary(
  home: ProviderHomeView,
  accounts: ProviderAccountView[],
  now: number,
  text: UiText,
): HomeAccountSummary {
  const who = home.email ?? home.displayName ?? home.providerAccountId ?? text("알 수 없는 계정", "Unknown account");
  const matched = home.accountId ? accounts.find((account) => account.id === home.accountId) ?? null : null;
  const expired = home.accessTokenExpiresAt != null && home.accessTokenExpiresAt <= now;
  const parts = [
    matched
      ? text(`등록 계정 ‘${matched.displayName}’과 같은 계정`, `Same account as registered ‘${matched.displayName}’`)
      : text("등록되지 않은 계정", "Not a registered account"),
  ];
  if (expired) {
    parts.push(text("토큰 만료 · CLI가 사용할 때 갱신됩니다", "Token expired · refreshed when the CLI uses it"));
  }
  return { title: who, detail: parts.join(" · "), tone: matched ? "ready" : "muted" };
}

/**
 * 홈 계정 카드에 적을 한 줄 제목과 설명. 관측 상태마다 사용자가 다음에 할 수 있는 일이
 * 다르므로 설명에 그 행동을 담는다 — Agent Manager 안에서 고칠 수 있는 일은 없고,
 * 다시 로그인할 곳이 공급자마다 다르다. Codex는 ChatGPT 데스크탑 앱이 공유 홈
 * auth.json을 되쓰지만, Claude 데스크탑 앱은 별도 웹 세션이라 공유 홈을 건드리지
 * 않아 터미널의 CLI 재로그인만 유효하다(2026-09-02 실측).
 */
export function homeAccountSummary(
  provider: ProviderId,
  home: ProviderHomeView | undefined,
  accounts: ProviderAccountView[],
  now: number,
  text: UiText,
): HomeAccountSummary {
  if (!home || home.state === "unchecked") {
    return uncheckedHomeSummary(text);
  }
  switch (home.state) {
    case "absent":
      return absentHomeSummary(text);
    case "expired":
      return expiredHomeSummary(provider, text);
    case "error":
      return failedHomeSummary(home, text);
    case "verified":
      return verifiedHomeSummary(home, accounts, now, text);
  }
}

/**
 * 홈 계정 사용량 아래에 적을 한 줄. 등록 계정 행과 달리 새로고침 버튼이 없으므로,
 * 왜 값이 없는지·언제 다시 되는지를 문구가 대신 말해야 한다.
 *
 * `usage.error`는 여기서 지우지 않는다. 앱이 공유 홈의 토큰을 갱신하지 않아 생기는
 * 조회 불가는 고장이 아니라 설계상의 한계고, 그 사실을 그대로 읽는 편이 낫다. 다만
 * 마지막 성공 수치가 남아 있으면 수치를 오류 문구로 갈아치우지 않고 낡음만 알린다.
 */
export function homeUsageNote(
  home: ProviderHomeView | undefined,
  text: UiText,
): { note: string; tone: "muted" | "error" } | null {
  if (!home || home.state !== "verified") return null;
  const usage = home.usage;
  const keepsLastValue = usage.error !== null && usage.updatedAt !== null && usage.windows.length > 0;
  if (usage.error !== null && !keepsLastValue) {
    return { note: usage.error, tone: "error" };
  }
  if (usage.updatedAt === null) {
    return {
      note: text("아직 조회하지 않았습니다.", "Not queried yet."),
      tone: "muted",
    };
  }
  const at = new Date(usage.updatedAt).toLocaleString();
  if (keepsLastValue) {
    return {
      note: text(
        `${at} 기준 · 갱신에 실패해 마지막 조회 값을 유지합니다`,
        `As of ${at} · refresh failed, keeping the last value`,
      ),
      tone: "muted",
    };
  }
  return { note: text(`${at} 기준`, `As of ${at}`), tone: "muted" };
}

/**
 * 공유 홈 계정의 사용량을 지금 조회할 수 있는지. 수동 새로고침은 자동 주기를 기다리지
 * 않지만, 등록 계정과 겹치는 홈과 공급자가 정한 재시도 대기는 그대로 제외한다.
 */
export function homeUsageCanRefresh(
  home: ProviderHomeView | undefined,
  now: number,
): home is ProviderHomeView {
  if (!home || home.state !== "verified" || home.accountId !== null) return false;
  if (usageRefreshDeferred(home.usage, now)) return false;
  return true;
}

/**
 * 홈 계정 사용량을 다시 읽을 때가 됐는지. 백엔드 `refresh_home_usage`와 같은 판정이라
 * 프론트가 부른 갱신을 백엔드가 도로 걸러 헛도는 일이 없다.
 *
 * 등록 계정과 신원이 겹치는 홈은 대상이 아니다 — 그 계정이 자기 주기로 이미 같은
 * 공급자 계정을 조회하고, 표시할 값도 거기서 가져온다. 홈 계정은 실행 대상이 아니라
 * 사용량이 저절로 오르지 않으므로 항상 느린 주기를 쓴다.
 */
export function homeUsageRefreshDue(home: ProviderHomeView | undefined, now: number): boolean {
  if (!homeUsageCanRefresh(home, now)) return false;
  if (usageResetElapsedSinceUpdate(home.usage, now)) return true;
  return (home.usage.updatedAt ?? 0) <= now - IDLE_USAGE_REFRESH_INTERVAL_MS;
}
