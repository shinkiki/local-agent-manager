import type { ProviderId } from "../types";
import { memberGuard } from "./memberGuard.ts";

/**
 * 공급자 식별자의 정본 목록. 같은 세 값을 파일마다 다시 적으면 공급자가 늘었을 때
 * 한쪽만 고쳐진다 — 페이싱 요약이 새 공급자의 회당 소비를 세지 않거나, 팝아웃 주소가
 * 그 공급자의 세션을 열어 주지 않는 식으로 조용히 어긋난다. 목록을 한 곳에 두면
 * 그런 어긋남이 애초에 생기지 않는다.
 *
 * 순서는 화면이 공급자를 나열하는 순서(클로드·코덱스·안티그래비티·로컬)와 같다.
 */
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex", "antigravity", "local"];

/**
 * 바깥에서 들어온 값이 공급자 식별자인지 본다. 주소 쿼리처럼 사용자가 손으로 고칠 수
 * 있는 입력은 단언(`as ProviderId`)으로 통과시키면 타입만 맞고 값은 틀린 채 흘러가므로,
 * 좁히는 자리를 이 하나로 둔다. 목록을 넓혀 단언 없이 조회하는 요령은 `memberGuard`에 있다.
 */
export const isProviderId = memberGuard<ProviderId>(PROVIDER_IDS);

/**
 * 공급자를 실제로 실행하는 하네스. 공급자 하나가 곧 실행 방식 하나였던 동안에는 화면이
 * `source === "codex"`로 갈라도 뜻이 같았지만, 한 하네스를 여러 공급자가 나눠 쓰기
 * 시작하면 둘이 갈라진다. 백엔드 `domain::Harness`와 같은 표여야 한다.
 */
/** 백엔드 `domain::Harness`와 같은 목록이어야 한다. `opencode`는 ACP를 말하는 하네스다. */
export type Harness = "claude" | "codex" | "antigravity" | "opencode";

/**
 * 공급자별 능력 한 줄. 네 값이 각자 다른 파일에 흩어져 있으면 공급자를 늘릴 때 한 칸만
 * 고치고 나머지를 잊게 되므로, 백엔드 `ProviderId`의 술어 표와 같은 모양으로 모아 둔다.
 * 어느 칸이 무엇을 뜻하는지는 아래 술어 주석에 있다.
 */
const PROVIDER_CAPABILITIES: Readonly<
  Record<ProviderId, { systemAgent: boolean; runScopedMcp: boolean; accounts: boolean; usageQuota: boolean; harness: Harness }>
> = {
  claude: { systemAgent: true, runScopedMcp: true, accounts: true, usageQuota: true, harness: "claude" },
  codex: { systemAgent: true, runScopedMcp: true, accounts: true, usageQuota: true, harness: "codex" },
  antigravity: { systemAgent: false, runScopedMcp: false, accounts: true, usageQuota: true, harness: "antigravity" },
  // 사용자가 직접 띄운 서버라 계정도 사용량 한도도 없고, 실행은 ACP 하네스로 돈다.
  // 시스템 에이전트로 고를 수는 없지만 실행마다 MCP 를 붙일 수는 있다 — 둘은 다른 물음이다.
  local: { systemAgent: false, runScopedMcp: true, accounts: false, usageQuota: false, harness: "opencode" },
};

/**
 * 시스템 에이전트로 고를 수 있는 공급자인지. 시스템 에이전트는 AIA 런타임을 겸하고
 * AIA는 aia_system MCP로만 시스템을 조작하는데, Antigravity CLI에는 실행 단위 MCP
 * 설정 플래그가 없어 그 인터페이스를 붙일 수 없다.
 * 백엔드 `ProviderId::can_run_system_agent`와 같은 규칙이어야 한다.
 */
export function canRunSystemAgent(provider: ProviderId): boolean {
  return PROVIDER_CAPABILITIES[provider]?.systemAgent ?? false;
}

/**
 * 앱이 실행마다 MCP 서버를 붙여 줄 수 있는 공급자인지. Rust 의 `supports_run_scoped_mcp`
 * 와 같은 표다.
 *
 * `canRunSystemAgent` 와 **다른 물음**이다 — 시스템 에이전트로 고를 수 있느냐와 시스템
 * 도구를 실을 수 있느냐는 갈린다. 로컬이 그 자리다(고를 수는 없고 실을 수는 있다).
 * 예전에는 둘을 같은 값으로 써서, 로컬 대화가 시스템 도구를 쥐고도 화면은 "없음"이라고
 * 적었다(2026-09-27).
 */
export function supportsRunScopedMcp(provider: ProviderId): boolean {
  return PROVIDER_CAPABILITIES[provider]?.runScopedMcp ?? false;
}

/**
 * 계정 레지스트리가 이 공급자의 계정을 관리하는지. 거짓인 공급자는 계정 선택·전환·사용량
 * 귀속이 없으므로, 화면은 계정 select 자리를 비우고 실행도 계정 없이 보낸다.
 * 백엔드 `ProviderId::manages_accounts`와 같은 규칙이어야 한다.
 */
export function managesAccounts(provider: ProviderId): boolean {
  return PROVIDER_CAPABILITIES[provider]?.accounts ?? false;
}

/**
 * 이 공급자의 사용량에 공급자 쪽 한도가 걸리는지. 구독 창·리셋 시각·퍼센트가 있는
 * 공급자만 참이다. 거짓인 공급자는 사용량 창 자체가 없어 페이싱·예산·상태바 계산에서
 * 빼야 하며, 0%로 취급해 "여유가 가장 많은 계정"으로 뽑히게 두면 안 된다.
 * 백엔드 `ProviderId::has_usage_quota`와 같은 규칙이어야 한다.
 */
export function hasUsageQuota(provider: ProviderId): boolean {
  return PROVIDER_CAPABILITIES[provider]?.usageQuota ?? false;
}

/**
 * 이 공급자를 실행하는 하네스. 실행 규약(승인·중간 전달·중단·재개)이 갈리는 자리는
 * 공급자가 아니라 이 값을 봐야 한다.
 * 백엔드 `ProviderId::harness`와 같은 규칙이어야 한다.
 */
export function harnessOf(provider: ProviderId): Harness {
  return PROVIDER_CAPABILITIES[provider]?.harness ?? "codex";
}
