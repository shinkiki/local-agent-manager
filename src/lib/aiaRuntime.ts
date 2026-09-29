import type {
  AiaRuntimeSettings,
  ChatPhase,
  ChatSessionInfo,
  ProviderId,
  SystemAgentRuntime,
  SystemAutomationSettings,
  SystemAutomationSnapshot,
} from "../types";
import { canRunSystemAgent, supportsRunScopedMcp } from "./providerIds.ts";

/** AIA 시작에 실제로 쓰이는 실행설정. 채팅 세션 정보에도 같은 모양으로 실려 온다. */
export type { AiaRuntimeSettings } from "../types";

/**
 * 시스템 에이전트로 고를 수 있는 공급자인지. 판정 자체는 공급자 능력 표가 들고 있고
 * (`providerIds`), 이 이름으로 부르던 호출부가 많아 여기서 그대로 다시 내보낸다.
 */
export { canRunSystemAgent };

/**
 * AIA가 실행될 공급자. 시스템 설정의 `시스템 에이전트` 선택을 그대로 따르며, 아직
 * 고르지 않았거나 더 이상 쓸 수 없는 값이 남아 있으면 AIA 기능을 쓸 수 없다(`null`).
 * 백엔드 `SystemAutomationSettings::aia_provider`와 같은 규칙이어야 한다.
 */
export function aiaRuntimeProvider(automation: SystemAutomationSnapshot | null): ProviderId | null {
  const selected = automation?.settings.systemProvider ?? null;
  return selected && canRunSystemAgent(selected) ? selected : null;
}

/**
 * 해당 런타임이 aia_system MCP를 붙일 수 있는지.
 *
 * 선택 가능 여부(`canRunSystemAgent`)와 **같지 않다.** 백엔드는 둘을 갈라 두는데
 * (`chat.rs` 의 `provider_supports_aia_system_mcp` → `supports_run_scoped_mcp`) 화면만
 * 옛 술어를 쓰고 있었다. 로컬이 그 자리다 — 도구를 쥐고도 화면은 "없음"이라고 적었다.
 */
export function supportsAiaSystemTools(provider: ProviderId): boolean {
  return supportsRunScopedMcp(provider);
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
 * 시작할 때 정해지므로 다시 시작해야 바뀐다. AIA 커서 클릭 권한(`uiClickPolicy`)은 클릭마다
 * 저장본을 읽어 판단하므로 비교하지 않는다 — 넣으면 곧바로 듣는 설정 때문에 대화가 끊긴다.
 */
function aiaRuntimeApplied(
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
 * 붙어 있는 런타임이 선택한 공급자나 저장된 실행설정과 어긋나는지. 실행설정은 CLI 실행
 * 인자와 개발자 지침으로 들어가 대화 중에는 바꿀 수 없으므로, 저장 화면의 안내대로 새
 * 대화부터 적용하려면 정지한 뒤 지금 설정으로 다시 시작해야 한다.
 *
 * 다시 시작하는 시점은 붙는 때가 아니라 **다음 요청을 보내는 때**다(`aiaStaleSendAction`).
 * 채팅 런타임은 화면마다 구독을 따로 갖는데 정지는 CLI 프로세스를 죽여 모든 화면에
 * 적용되므로, 알림에서 옛 대화를 열어 보기만 한 화면이 다른 창이 함께 보고 있던 런타임을
 * 끊어서는 안 된다.
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

/** 예전 실행설정으로 시작한 대화에서 요청을 보내려 할 때 화면이 취할 행동. */
export type AiaStaleSendAction = "send" | "restart" | "blocked";

/**
 * 저장본과 어긋난 대화에 요청을 보내려 하면 그 자리에서 정지하고 새 설정으로 다시 시작한다
 * (`restart`). 옛 설정 런타임에 새 요청을 밀어 넣지 않으면서도, 보기만 하는 화면은 아무것도
 * 끊지 않게 하는 시점이 여기다.
 *
 * 턴이 도는 중이거나 승인을 기다리는 중이면 끊지 못한다(`blocked`) — 하던 작업과 승인
 * 요청이 사라진다. 그렇다고 옛 설정으로 보내지도 않으므로, 화면은 무엇을 해야 하는지만
 * 알려 주고 사용자가 작업을 끝내거나 중단하기를 기다린다.
 */
export function aiaStaleSendAction(
  staleRuntime: boolean,
  phase: ChatPhase | "connecting",
): AiaStaleSendAction {
  if (!staleRuntime) return "send";
  return phase === "running" || phase === "waitingApproval" ? "blocked" : "restart";
}

/**
 * 시스템 에이전트 실행설정을 저장하기 전부터 AIA가 써 온 기본값. 저장된 실행설정이 없는
 * 공급자는 이 값으로 시작해야 기존 AIA 실행 동작이 그대로 유지된다.
 * 백엔드 `DEFAULT_AIA_MODE`·`DEFAULT_AIA_APPROVAL_MODE`·`DEFAULT_AIA_REASONING_EFFORT`·
 * `DEFAULT_AIA_DECISION_POLICY`와 같은 값이어야 한다.
 */
export const AIA_RUNTIME_DEFAULTS: AiaRuntimeSettings = {
  model: null,
  localConnectionId: null,
  reasoningEffort: "medium",
  mode: "workspace",
  approvalMode: "manual",
  decisionPolicy: "ask",
  uiClickPolicy: "openers",
  settings: {},
};

/**
 * 실행설정 항목 하나가 스스로 아는 것 — 저장본이 이 항목을 비워 뒀을 때 무엇으로 읽고,
 * 저장 정본으로 어떻게 다듬고, CLI를 시작할 때 정해지는 항목인지.
 *
 * 네 가지가 항목마다 흩어져, 저장본 되읽기·정본 만들기·시작 지문 세 자리가 같은 일곱
 * 줄을 각자 열거하고 있었다. 항목을 하나 더할 때 그중 정본을 빠뜨리면 저장은 되는데
 * 비교에 들어가지 않아 "저장했는데 다시 시작하지 않는" 쪽으로 조용히 갈리고, 되읽기를
 * 빠뜨리면 저장해 둔 값이 조용히 사라진다. 어느 쪽도 형식 오류를 내지 않는다.
 */
interface RuntimeField<Key extends keyof AiaRuntimeSettings> {
  /** 저장본에 이 항목이 없을 때 쓸 값. 매번 새로 떠서 표의 값이 밖으로 새지 않게 한다. */
  stored(): AiaRuntimeSettings[Key];
  /** 저장·비교가 함께 쓰는 정본 모양. 뜻을 바꾸지 않는 차이(앞뒤 공백·키 순서)를 여기서 없앤다. */
  normalize(value: AiaRuntimeSettings[Key]): SystemAgentRuntime[Key];
  /**
   * CLI를 시작할 때 정해져 다시 시작해야만 바뀌는 항목인지. AIA 커서 클릭 권한만
   * `false`다 — 그 하나가 클릭마다 저장본을 읽어, 시작 지문에 넣으면 곧바로 듣는 설정
   * 때문에 대화가 끊긴다.
   */
  startup: boolean;
}

/**
 * 항목 한 벌. 매핑 타입이 양쪽을 다 막는다 — 실행설정에 항목을 더하면 여기 줄이 없어
 * 컴파일이 멈추고, 실행설정에 없는 항목을 여기 적어도 멈춘다.
 */
const RUNTIME_FIELDS: { [Key in keyof AiaRuntimeSettings]: RuntimeField<Key> } = {
  model: {
    stored: () => null,
    normalize: (value) => value?.trim() || null,
    startup: true,
  },
  // 로컬 공급자의 서빙 연결(M7). 기동 때 정해지므로 바꾸면 다시 시작한다.
  localConnectionId: {
    stored: () => null,
    normalize: (value) => value?.trim() || null,
    startup: true,
  },
  // 저장본이 있는데 추론 강도만 비어 있으면 AIA 기본값이 아니라 공급자 기본값으로 남긴다.
  reasoningEffort: {
    stored: () => null,
    normalize: (value) => value ?? null,
    startup: true,
  },
  mode: {
    stored: () => AIA_RUNTIME_DEFAULTS.mode,
    normalize: (value) => value,
    startup: true,
  },
  approvalMode: {
    stored: () => AIA_RUNTIME_DEFAULTS.approvalMode,
    normalize: (value) => value,
    startup: true,
  },
  decisionPolicy: {
    stored: () => AIA_RUNTIME_DEFAULTS.decisionPolicy,
    normalize: (value) => value,
    startup: true,
  },
  uiClickPolicy: {
    stored: () => AIA_RUNTIME_DEFAULTS.uiClickPolicy,
    normalize: (value) => value,
    startup: false,
  },
  settings: {
    stored: () => ({}),
    normalize: (value) => Object.fromEntries(normalizedDynamicSettings(value)),
    startup: true,
  },
};

/** 표에 선 순서 그대로. 정본 JSON의 키 순서도 이 순서를 따른다. */
const RUNTIME_FIELD_KEYS = Object.keys(RUNTIME_FIELDS) as Array<keyof AiaRuntimeSettings>;

/**
 * 항목을 칸의 타입에서 풀어 낸 모양. 표가 칸마다 타입을 이미 맞춰 두었고, 순회하는 쪽은
 * 어느 칸의 값인지 모른 채 같은 항목에서 꺼낸 값을 그 항목에 도로 넘길 뿐이다.
 */
function runtimeField(key: keyof AiaRuntimeSettings): RuntimeField<keyof AiaRuntimeSettings> {
  return RUNTIME_FIELDS[key] as RuntimeField<keyof AiaRuntimeSettings>;
}

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
  const settings = { ...AIA_RUNTIME_DEFAULTS };
  for (const key of RUNTIME_FIELD_KEYS) applyStoredField(settings, key, stored);
  return settings;
}

/**
 * 저장본의 항목 하나를 실행설정에 옮긴다. 칸마다 타입이 다른 표를 순회하며 값을 쓰는
 * 일은 칸을 타입 변수로 묶어야 성립하므로 이 한 줄을 따로 둔다.
 */
function applyStoredField<Key extends keyof AiaRuntimeSettings>(
  target: AiaRuntimeSettings,
  key: Key,
  stored: SystemAgentRuntime,
): void {
  const value = stored[key] as AiaRuntimeSettings[Key] | null | undefined;
  target[key] = value ?? RUNTIME_FIELDS[key].stored();
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
 * 고른 항목만 정본 모양으로 옮긴다. 저장 요청은 전부를, 시작 지문은 시작에 걸리는
 * 항목만 담는데 다듬는 규칙은 같아, 무엇을 담을지만 판정으로 받는다.
 *
 * 동적 설정은 키 순서를 정렬해 담는다. 지문을 만드는 쪽이 어차피 정렬해야 했고, 맵의 키
 * 순서는 값의 뜻을 바꾸지 않는다.
 */
function normalizedFields(
  settings: AiaRuntimeSettings,
  included: (field: RuntimeField<keyof AiaRuntimeSettings>) => boolean,
): SystemAgentRuntime {
  const normalized: Record<string, unknown> = {};
  for (const key of RUNTIME_FIELD_KEYS) {
    const field = runtimeField(key);
    if (included(field)) normalized[key] = field.normalize(settings[key]);
  }
  return normalized as SystemAgentRuntime;
}

/** 실행설정을 저장·비교가 함께 쓰는 정본 모양으로 옮긴다. */
function normalizedRuntime(settings: AiaRuntimeSettings): SystemAgentRuntime {
  return normalizedFields(settings, () => true);
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
 * CLI를 시작할 때 정해져 다시 시작해야만 바뀌는 항목의 지문. 어떤 항목이 여기 드는지는
 * 표의 `startup`이 갖는다 — 정본을 다 만든 뒤 한 항목을 지워 내던 때는 "시작에 걸리는
 * 항목"이 표가 아니라 이 한 줄에 적혀 있어, 항목을 더하는 사람이 볼 자리가 아니었다.
 */
function startupRuntimeSignature(settings: AiaRuntimeSettings): string {
  return JSON.stringify(normalizedFields(settings, (field) => field.startup));
}

/** 두 실행설정이 같은지. 저장 버튼을 켜고 끌 때 쓴다. */
export function sameAiaRuntimeSettings(left: AiaRuntimeSettings, right: AiaRuntimeSettings): boolean {
  return JSON.stringify(normalizedRuntime(left)) === JSON.stringify(normalizedRuntime(right));
}
