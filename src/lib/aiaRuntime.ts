import type { ChatSessionInfo, ProviderId, SystemAutomationSnapshot } from "../types";

/**
 * 시스템 에이전트로 고를 수 있는 공급자인지. 시스템 에이전트는 AIA 런타임을 겸하고
 * AIA는 aia_system MCP로만 시스템을 조작하는데, Antigravity CLI에는 실행 단위 MCP
 * 설정 플래그가 없어 그 인터페이스를 붙일 수 없다.
 * 백엔드 `ProviderId::can_run_system_agent`와 같은 규칙이어야 한다.
 */
export function canRunSystemAgent(provider: ProviderId): boolean {
  return provider === "codex" || provider === "claude";
}

/**
 * AIA가 실행될 공급자. 시스템 설정의 `시스템 에이전트` 선택을 그대로 따르며, 아직
 * 고르지 않았거나 더 이상 쓸 수 없는 값이 남아 있으면 AIA 기능을 쓸 수 없다(`null`).
 * 백엔드 `SystemAutomationSettings::aia_provider`와 같은 규칙이어야 한다.
 */
export function aiaRuntimeProvider(automation: SystemAutomationSnapshot | null): ProviderId | null {
  const selected = automation?.settings.systemProvider ?? null;
  return selected && canRunSystemAgent(selected) ? selected : null;
}

/** 해당 런타임이 aia_system MCP를 붙일 수 있는지. 선택 가능 여부와 같은 조건이다. */
export function supportsAiaSystemTools(provider: ProviderId): boolean {
  return canRunSystemAgent(provider);
}

/** 선택한 공급자에서 살아 있는 AIA 대화만 남긴다. 공급자를 바꾸면 이전 대화는 복원하지 않는다. */
export function aiaChatsForProvider(chats: ChatSessionInfo[], provider: ProviderId): ChatSessionInfo[] {
  return chats.filter((chat) => chat.source === provider);
}

/** 붙어 있는 런타임이 선택한 공급자와 어긋나면 정지 후 새 공급자로 다시 시작해야 한다. */
export function aiaRuntimeNeedsRestart(
  session: Pick<ChatSessionInfo, "source"> | null,
  provider: ProviderId,
): boolean {
  return Boolean(session) && session!.source !== provider;
}
