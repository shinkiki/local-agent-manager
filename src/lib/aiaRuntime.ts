import type {
  AiaRuntimeSettings,
  ChatSessionInfo,
  ProviderId,
  SystemAgentRuntime,
  SystemAutomationSettings,
  SystemAutomationSnapshot,
} from "../types";

/** AIA 시작에 실제로 쓰이는 실행설정. 채팅 세션 정보에도 같은 모양으로 실려 온다. */
export type { AiaRuntimeSettings } from "../types";

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

/**
 * 지금 설정으로 다시 붙어도 되는 AIA 대화만 남긴다. 공급자를 바꿨거나 저장된 실행설정이
 * 달라진 대화에 다시 붙으면 옛 권한·모델 그대로 이어지므로 복원 대상에서 뺀다.
 */
export function aiaChatsForProvider(
  chats: ChatSessionInfo[],
  provider: ProviderId,
  runtime?: AiaRuntimeSettings,
): ChatSessionInfo[] {
  return chats.filter((chat) => chat.source === provider && (!runtime || aiaRuntimeApplied(chat, runtime)));
}

/**
 * 실행설정이 실행 중인 AIA에 이미 반영돼 있는지. 모델·추론·권한·승인·판단·동적 설정은 CLI를
 * 시작할 때 정해지므로 다시 시작해야 바뀐다. 아이아 커서 클릭 권한(`uiClickPolicy`)은 클릭마다
 * 저장본을 읽어 판단하므로 비교하지 않는다 — 넣으면 곧바로 듣는 설정 때문에 대화가 끊긴다.
 */
export function aiaRuntimeApplied(
  session: Pick<ChatSessionInfo, "aiaRuntime">,
  runtime: AiaRuntimeSettings,
): boolean {
  const applied = session.aiaRuntime;
  // 실행설정을 실어 보내지 않는 이전 버전 백엔드가 시작한 대화는 무엇으로 시작했는지 알 수
  // 없다. 근거 없이 정지시키지 않도록 판단을 보류하고 그대로 둔다.
  if (!applied) return true;
  return startupRuntimeSignature(applied) === startupRuntimeSignature(runtime);
}

/**
 * 붙어 있는 런타임이 선택한 공급자나 저장된 실행설정과 어긋나면, 정지한 뒤 지금 설정으로
 * 다시 시작해야 한다. 실행설정은 CLI 실행 인자와 개발자 지침으로 들어가 대화 중에는 바꿀 수
 * 없으므로, 저장 화면의 안내대로 새 대화부터 적용하려면 여기서 다시 시작해야 한다.
 */
export function aiaRuntimeNeedsRestart(
  session: Pick<ChatSessionInfo, "source" | "aiaRuntime"> | null,
  provider: ProviderId,
  runtime?: AiaRuntimeSettings,
): boolean {
  if (!session) return false;
  if (session.source !== provider) return true;
  return Boolean(runtime) && !aiaRuntimeApplied(session, runtime!);
}

/**
 * 시스템 에이전트 실행설정을 저장하기 전부터 AIA가 써 온 기본값. 저장된 실행설정이 없는
 * 공급자는 이 값으로 시작해야 기존 AIA 실행 동작이 그대로 유지된다.
 * 백엔드 `DEFAULT_AIA_MODE`·`DEFAULT_AIA_APPROVAL_MODE`·`DEFAULT_AIA_REASONING_EFFORT`·
 * `DEFAULT_AIA_DECISION_POLICY`와 같은 값이어야 한다.
 */
export const AIA_RUNTIME_DEFAULTS: AiaRuntimeSettings = {
  model: null,
  reasoningEffort: "medium",
  mode: "workspace",
  approvalMode: "manual",
  decisionPolicy: "ask",
  uiClickPolicy: "openers",
  settings: {},
};

/**
 * 해당 공급자로 AIA를 시작할 때 쓸 실행설정. 저장된 항목이 아예 없으면 기존 AIA 기본값을
 * 그대로 쓰고, 저장돼 있으면 비워 둔 모델·추론 강도는 공급자 기본값으로 남긴다.
 * 백엔드 `SystemAutomationSettings::aia_runtime_settings`와 같은 규칙이어야 한다.
 */
export function aiaRuntimeSettings(
  runtimes: SystemAutomationSettings["systemAgentRuntimes"] | undefined,
  provider: ProviderId,
): AiaRuntimeSettings {
  const stored = runtimes?.[provider];
  if (!stored) return { ...AIA_RUNTIME_DEFAULTS, settings: {} };
  return {
    model: stored.model ?? null,
    reasoningEffort: stored.reasoningEffort ?? null,
    mode: stored.mode ?? AIA_RUNTIME_DEFAULTS.mode,
    approvalMode: stored.approvalMode ?? AIA_RUNTIME_DEFAULTS.approvalMode,
    decisionPolicy: stored.decisionPolicy ?? AIA_RUNTIME_DEFAULTS.decisionPolicy,
    uiClickPolicy: stored.uiClickPolicy ?? AIA_RUNTIME_DEFAULTS.uiClickPolicy,
    settings: stored.settings ?? {},
  };
}

/** 실행설정 화면에서 편집한 값을 저장 요청 형태로 바꾼다. 비운 항목은 공급자 기본값으로 남긴다. */
export function systemAgentRuntimePatch(
  runtimes: SystemAutomationSettings["systemAgentRuntimes"],
  provider: ProviderId,
  edited: AiaRuntimeSettings,
): SystemAutomationSettings["systemAgentRuntimes"] {
  // 고르지 않은 공급자의 실행설정은 그대로 두고 편집한 공급자만 덮어쓴다.
  return { ...runtimes, [provider]: normalizedRuntime(edited) };
}

/**
 * 실행설정을 저장·비교가 함께 쓰는 정본 모양으로 옮긴다. 항목마다 무엇이 빈 값이고
 * 무엇을 다듬어야 하는지(모델 앞뒤 공백, 공급자 기본값을 뜻하는 null, 값이 빈 동적 설정)를
 * 저장 요청·재시작 판정·저장 버튼 판정 세 곳이 각자 나열하고 있었다. 항목이 하나 늘 때
 * 세 곳을 함께 고치지 않으면 "저장은 되는데 다시 시작하지 않는" 쪽으로 조용히 갈리므로
 * 여기 한 벌만 둔다.
 *
 * 동적 설정은 키 순서를 정렬해 담는다. 지문을 만드는 쪽이 어차피 정렬해야 했고, 맵의 키
 * 순서는 값의 뜻을 바꾸지 않는다.
 */
function normalizedRuntime(settings: AiaRuntimeSettings): SystemAgentRuntime {
  return {
    model: settings.model?.trim() || null,
    reasoningEffort: settings.reasoningEffort ?? null,
    mode: settings.mode,
    approvalMode: settings.approvalMode,
    decisionPolicy: settings.decisionPolicy,
    uiClickPolicy: settings.uiClickPolicy,
    settings: Object.fromEntries(normalizedDynamicSettings(settings.settings)),
  };
}

/** 동적 CLI 설정의 값 공백을 걷고 공급자 기본값을 뜻하는 빈 항목은 제외한다. 키 순으로 정렬한다. */
function normalizedDynamicSettings(settings: Record<string, string> | undefined): [string, string][] {
  return Object.entries(settings ?? {})
    .flatMap<[string, string]>(([key, value]) => {
      const trimmed = value.trim();
      return trimmed ? [[key, trimmed]] : [];
    })
    .sort((leftEntry, rightEntry) => leftEntry[0].localeCompare(rightEntry[0]));
}

/**
 * CLI를 시작할 때 정해져 다시 시작해야만 바뀌는 항목의 지문. 아이아 커서 클릭 권한만
 * 빼고 정본을 그대로 쓴다 — 그 하나가 클릭마다 저장본을 읽는 유일한 항목이다.
 */
function startupRuntimeSignature(settings: AiaRuntimeSettings): string {
  const startup = normalizedRuntime(settings);
  delete startup.uiClickPolicy;
  return JSON.stringify(startup);
}

/** 두 실행설정이 같은지. 저장 버튼을 켜고 끌 때 쓴다. */
export function sameAiaRuntimeSettings(left: AiaRuntimeSettings, right: AiaRuntimeSettings): boolean {
  return JSON.stringify(normalizedRuntime(left)) === JSON.stringify(normalizedRuntime(right));
}
