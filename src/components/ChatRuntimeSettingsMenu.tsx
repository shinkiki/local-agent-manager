import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useDismissablePopover } from "./ChatPopover";
import { useI18n } from "../lib/i18n";
import type {
  ChatApprovalMode,
  ChatMode,
  ChatModelCatalogOption,
  ChatProviderOptions,
  ChatReasoningOption,
  ModelOption,
  ProviderId,
  ReasoningEffort,
} from "../types";
import { reasoningOptionsFor } from "../lib/providerOptions";
import type { LaunchAccountChoice } from "../lib/launchAccount";
import {
  fallbackSettingFields,
  reasoningLabel,
  settingOptionLabel,
  settingOptions,
  type ChatSettingField,
} from "../lib/chatSettings";

/**
 * 고른 모델이 허용하는 추론 수준 목록을 뽑고, 그 목록 밖으로 밀려난 선택을 비운다.
 *
 * 실행 설정 폼은 두 곳에 있다 — 진행 중 채팅과 반복 요청 편집기. 둘 다 모델·공급자를
 * 바꾸면 지금 고른 추론 수준이 카탈로그에서 사라질 수 있어 같은 뒷정리를 각자 적고
 * 있었고, "카탈로그가 아직 비어 있을 때는 복원한 값을 지우지 않는다"는 단서까지 두
 * 벌이었다. 한쪽만 고치면 다른 쪽이 조용히 옛 규칙으로 남으므로 여기 한 벌만 둔다.
 *
 * 비움 호출은 ref로 잡아 둔다. 호출부가 넘기는 화살표 함수는 렌더마다 새 값이라
 * 의존성에 그대로 넣으면 판정이 아니라 함수 신원 때문에 다시 돌게 된다.
 */
export function useCatalogReasoningOptions(
  catalog: ChatProviderOptions | null,
  model: string,
  reasoningEffort: ReasoningEffort | "",
  onUnavailable: () => void,
): ChatReasoningOption[] {
  const reasoningOptions = reasoningOptionsFor(catalog, model);
  const unavailable = Boolean(reasoningEffort)
    && reasoningOptions.length > 0
    && !reasoningOptions.some((option) => option.effort === reasoningEffort);
  const clear = useRef(onUnavailable);
  clear.current = onUnavailable;
  useEffect(() => {
    if (unavailable) clear.current();
  }, [unavailable]);
  return reasoningOptions;
}

/**
 * 실행 중 채팅에서 고를 수 있는 에이전트(공급자) 하나.
 *
 * 에이전트를 바꾸면 공급자가 달라져 세션 ID를 공유할 수 없으므로 재개가 아니라 새
 * 세션 인계가 된다. 그래서 다른 항목과 달리 선택 즉시 "새 세션"이라고 말해야 한다.
 */
export interface ChatAgentChoice {
  source: ProviderId;
  label: string;
  disabled: boolean;
  disabledReason: string | null;
}

interface ChatRuntimeSettingsMenuProps {
  panelId: string;
  contextLabel: string;
  source: ProviderId;
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  model: string;
  modelOptions: ChatModelCatalogOption[];
  recentModels?: ModelOption[];
  reasoningEffort: ReasoningEffort | "";
  reasoningOptions: ChatReasoningOption[];
  settingFields?: ChatSettingField[];
  extraSettings?: Record<string, string>;
  /** 고를 수 있는 에이전트. 비어 있으면 항목을 그리지 않는다(시작 화면·AIA 등). */
  agentChoices?: ChatAgentChoice[];
  /** 고를 수 있는 실행 계정. 빈 선택("")은 이어가기 정책이 정하는 계정이다. */
  accountChoices?: LaunchAccountChoice[];
  /** 지금 실행 중인 계정. 모르면 null이고, 그때 계정 선택은 빈 값으로 둔다. */
  accountId?: string | null;
  locked: boolean;
  /**
   * 계획 승인 중에도 바꿀 수 있는 항목만 따로 잠그는 값. 주지 않으면 `locked`를 따른다.
   *
   * 에이전트·실행 계정·요청 모드는 실행 중에도 바꿀 수 있는 자리가 하나 더 있다 — 계획
   * 승인이다. 계획은 아직 아무것도 실행하지 않은 상태라 접고 다시 띄워도 잃을 작업이
   * 없어서, 응답 중이라는 이유로 함께 잠그면 정작 바꿀 수 있는 유일한 순간을 막게 된다.
   * 이 항목을 바꾼 호출부는 기다리는 승인을 취소로 닫고 계획을 새 실행에 넘긴다.
   */
  planRestartLocked?: boolean;
  /** 지금 바꾸면 실행을 접고 다시 띄운다는 안내. 계획 승인 중에만 채워 보낸다. */
  planRestartNote?: string;
  statusIndicator?: ReactNode;
  contextMeter?: ReactNode;
  statusLabel?: ReactNode;
  onOpen?: () => void;
  onModeChange: (mode: ChatMode) => void;
  onApprovalModeChange: (mode: ChatApprovalMode) => void;
  /** 에이전트 변경. 새 세션 인계가 되므로 호출부가 그 사실을 사용자에게 확인한다. */
  onAgentChange?: (source: ProviderId) => void;
  onAccountChange?: (accountId: string) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort | "") => void;
  onExtraSettingsApply?: (settings: Record<string, string>) => void;
}

const BUILTIN_SETTING_KEYS = new Set(["mode", "approvalMode", "model", "reasoningEffort"]);
const EMPTY_SETTINGS: Record<string, string> = {};

/**
 * 공급자가 스키마로 알려 온 추가 실행 설정의 초안 한 벌.
 *
 * 내장 다섯 항목과 달리 추가 설정은 고른 즉시 반영하지 않는다 — 여러 칸을 채운 뒤
 * '적용'을 눌러 한 번에 다시 연결한다. 그래서 저장본과 별개로 초안을 들고 있어야 하고,
 * 그 초안에 딸린 조각이 여섯이었다: 내장 키를 걸러 낸 항목 목록, 초안 상태, 저장본이
 * 바뀌면 초안을 되맞추는 효과, 칸 하나의 현재 값, 칸 하나의 수정, 저장본과 달라졌는지,
 * 그리고 빈 값을 털어 내보내는 적용. 여섯이 메뉴 본문과 마크업과 파일 바닥에 흩어져
 * 있어서, 예컨대 '달라졌는지'와 '무엇을 내보내는지'가 같은 정리 규칙(`cleanSettings`)을
 * 써야 한다는 사실이 읽는 자리에서는 보이지 않았다. 한 벌로 모아 그 규칙을 여기
 * 안에서만 쓰게 한다.
 *
 * 공급자를 바꾸면 항목 자체가 달라지므로 저장본이 그대로여도 초안을 되맞춘다.
 */
function useExtraRuntimeSettings({ fields, extraSettings, source, onApply }: {
  fields: ChatSettingField[];
  extraSettings: Record<string, string> | undefined;
  source: ProviderId;
  onApply?: (settings: Record<string, string>) => void;
}) {
  const saved = extraSettings ?? EMPTY_SETTINGS;
  const [draft, setDraft] = useState<Record<string, string>>(saved);
  useEffect(() => {
    setDraft(saved);
  }, [saved, source]);
  return {
    // 적용할 길이 없으면 고쳐 봐야 보낼 곳이 없으므로 칸도 세우지 않는다.
    fields: onApply ? fields.filter((field) => !BUILTIN_SETTING_KEYS.has(field.key)) : [],
    valueOf: (key: string) => draft[key] ?? "",
    change: (key: string, value: string) => setDraft((current) => ({ ...current, [key]: value })),
    changed: !sameSettings(saved, draft),
    apply: () => onApply?.(cleanSettings(draft)),
  };
}

function cleanSettings(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value.trim().length > 0));
}

function sameSettings(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(cleanSettings(left)).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(cleanSettings(right)).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

/**
 * 공급자 카탈로그를 정본으로 두고, 거기에 없는 최근 사용 모델만 뒤에 보탠다.
 * Claude처럼 카탈로그를 내보내지 않는 공급자에서는 최근 모델이 그대로 선택지가 된다.
 */
function mergeModelChoices(
  catalog: ChatModelCatalogOption[],
  recent: ModelOption[] = [],
): ChatModelCatalogOption[] {
  const choices = new Map(catalog.map((option) => [option.model, option]));
  for (const item of recent) {
    if (!choices.has(item.model)) {
      choices.set(item.model, {
        model: item.model,
        displayName: item.model,
        description: "",
        isDefault: false,
        defaultReasoningEffort: null,
        supportedReasoningEfforts: [],
      });
    }
  }
  return [...choices.values()];
}

/**
 * 지금 고른 값이 선택지 목록에 없을 때만 덧붙이는 임시 옵션.
 *
 * 카탈로그는 공급자·계정 상태에 따라 줄어들 수 있어서 실행 중인 채팅이 쓰던 모델이나
 * 추론 수준이 목록에서 사라지는 일이 있다. 그때 옵션을 만들어 주지 않으면 select가 첫
 * 항목을 고른 것처럼 보여, 사용자가 손대지 않은 값이 바뀐 것으로 읽힌다. 모델·추론
 * 수준·예비 모델 세 선택 박스가 같은 이유로 같은 보강을 하던 것을 한 벌로 모은다.
 */
function unlistedOption<T extends string>(value: T | "", listed: boolean, label: (value: T) => string = (raw) => raw) {
  if (!value || listed) return null;
  return <option value={value}>{label(value)}</option>;
}

/**
 * 화면에 낼 문구를 고르는 손잡이. 표에 담는 문구도 `{ko, en}` 자료가 아니라 이 손잡이를
 * 받는 함수로 적어, 문구 짝이 `text(ko, en)` 호출 형태로 남아 UI 카탈로그에 실린다.
 */
type TextPicker = (ko: string, en: string) => string;

/**
 * 승인 처리 방식별 안내 문구. 값마다 같은 모양의 한 줄을 그리고 있어 문구만 표로 모은다.
 * 표에 없는 값은 안내가 필요 없는 것이다(문구 없이 그대로 둔다).
 */
const APPROVAL_MODE_HINTS: Partial<Record<ChatApprovalMode, (text: TextPicker) => string>> = {
  autoReview: (text) => text(
    "Codex가 승인 요청의 위험도를 자동 검토하며 추가 사용량이 발생할 수 있습니다.",
    "Codex reviews the risk of each approval request automatically, which may use extra quota.",
  ),
  granular: (text) => text(
    "Codex가 승인 종류별 정책에 따라 직접 확인을 요청합니다.",
    "Codex asks you directly according to the per-approval-type policy.",
  ),
  onFailure: (text) => text(
    "Codex가 샌드박스 실행 실패 후 직접 확인을 요청합니다.",
    "Codex asks you directly after a sandboxed run fails.",
  ),
};

/** 내장 선택 박스 하나에 붙는 글자 묶음. 세 문구 모두 `text` 손잡이를 받아 스스로 고른다. */
interface RuntimeSettingText {
  /** 라벨에 덧붙일 클래스. 요청 모드 칸처럼 여벌 클래스가 없는 항목도 있다. */
  className?: string;
  /** 이 값을 바꾸면 무슨 일이 일어나는지 알리는 툴팁. */
  title: (text: TextPicker) => string;
  /** 칸 이름. */
  label: (text: TextPicker) => string;
  /** aria-label. 앞에 붙는 화면 이름(`contextLabel`)까지 함께 고른다. */
  aria: (text: TextPicker, contextLabel: string) => string;
}

type RuntimeSettingKey = "agent" | "account" | "model" | "reasoning" | "mode" | "approval";

/**
 * 내장 선택 박스 여섯 칸의 글자 표.
 *
 * 칸마다 세 벌이 필요한데 셋은 서로에게서 나오지 않는다 — 모델 칸의 이름은 "모델"이지만
 * aria-label은 "응답 모델"이고, 에이전트 칸은 영어 이름만 대문자로 적는다. 기계적으로
 * 만들 수 없는 문구인데도 여섯 벌이 마크업 사이에 흩어져 있어, 칸 하나의 문구를 고칠 때
 * 세 줄 중 둘만 고치는 일이 생긴다(화면에는 새 이름, 읽어 주는 이름은 옛 이름). 문구만
 * 여기 모으고 값·잠금·선택지는 그대로 마크업이 정한다 — 승인 안내를
 * `APPROVAL_MODE_HINTS`에 모아 둔 것과 같은 자리다.
 */
const RUNTIME_SETTING_TEXTS: Record<RuntimeSettingKey, RuntimeSettingText> = {
  agent: {
    className: "session-agent-selector",
    title: (text) => text("에이전트를 바꾸면 새 세션을 만들어 지금까지의 대화를 인계합니다.", "Changing the agent creates a new session and hands over the conversation so far."),
    label: (text) => text("에이전트", "Agent"),
    aria: (text, at) => text(`${at} 에이전트`, `${at} agent`),
  },
  account: {
    className: "session-account-selector",
    title: (text) => text("실행 계정을 바꾸면 같은 대화를 선택한 계정으로 다시 연결합니다.", "Changing the account reconnects this conversation with the selected account."),
    label: (text) => text("실행 계정", "Account"),
    aria: (text, at) => text(`${at} 실행 계정`, `${at} account`),
  },
  model: {
    className: "session-model-selector",
    title: (text) => text("응답 모델을 바꾸면 같은 대화를 선택한 모델로 다시 연결합니다.", "Changing the model reconnects this conversation with the selected model."),
    label: (text) => text("모델", "Model"),
    aria: (text, at) => text(`${at} 응답 모델`, `${at} model`),
  },
  reasoning: {
    className: "session-reasoning-selector",
    title: (text) => text("추론 수준을 바꾸면 같은 대화로 다시 연결합니다.", "Changing the reasoning level reconnects this conversation."),
    label: (text) => text("추론 수준", "Reasoning"),
    aria: (text, at) => text(`${at} 추론 수준`, `${at} reasoning`),
  },
  mode: {
    title: (text) => text("요청 모드를 바꾸면 같은 대화를 선택한 권한 범위로 다시 연결합니다.", "Changing the request mode reconnects this conversation with the selected permission scope."),
    label: (text) => text("요청 모드", "Request mode"),
    aria: (text, at) => text(`${at} 요청 모드`, `${at} request mode`),
  },
  approval: {
    className: "session-approval-selector",
    title: (text) => text("승인 처리를 바꾸면 같은 대화로 다시 연결합니다.", "Changing approval handling reconnects this conversation."),
    label: (text) => text("승인 처리", "Approvals"),
    aria: (text, at) => text(`${at} 승인 처리`, `${at} approvals`),
  },
};

/**
 * 표의 한 줄을 `RuntimeSettingSelect`가 받는 글자 속성으로 편다. aria-label만 화면
 * 이름(`contextLabel`)을 앞에 달아, 같은 칸이 여러 화면에 서도 읽어 주는 이름이 갈린다.
 */
function runtimeSettingLabels(
  key: RuntimeSettingKey,
  contextLabel: string,
  text: TextPicker,
): { className?: string; title: string; label: string; ariaLabel: string } {
  const spec = RUNTIME_SETTING_TEXTS[key];
  return {
    className: spec.className,
    title: spec.title(text),
    label: spec.label(text),
    ariaLabel: spec.aria(text, contextLabel),
  };
}

/**
 * 메뉴가 글자로만 보여 주는 것들 — 접힌 상태의 요약 칩, 안내 두 줄, 경고 한 줄.
 *
 * 네 문구는 고른 값에서 바로 나오는 파생값인데도 컴포넌트 본문에 선택 박스를 그릴
 * 준비(목록 병합·잠금 판정·상태 초안)와 섞여 있었다. 그중 `modelLabel`·
 * `effectiveApprovalMode`는 문구를 만드는 데만 쓰이면서도 본문 지역 변수로 남아,
 * 마크업을 읽는 사람이 "이 값도 어딘가 그려지나" 하고 다시 훑어야 했다.
 *
 * 문구 계산만 여기로 옮겨 본문에는 그리는 데 쓰는 값만 남긴다. 렌더에 쓰이는
 * `hasApprovalField`는 선택 박스를 그릴지도 정하므로 본문이 계산해 넘긴다.
 * 승인 항목이 없는 공급자를 "승인 없음"으로 보는 규칙은 경고 문구에만 필요해 이 안에
 * 둔다.
 */
function runtimeSettingsMessages(
  { fields, mode, approvalMode, hasApprovalField, model, modelChoices, reasoningEffort, agentChangeable }: {
    fields: ChatSettingField[];
    mode: ChatMode;
    approvalMode: ChatApprovalMode;
    hasApprovalField: boolean;
    model: string;
    modelChoices: ChatModelCatalogOption[];
    reasoningEffort: ReasoningEffort | "";
    agentChangeable: boolean;
  },
  text: (ko: string, en: string) => string,
): { summary: string; agentHandoffNote: string | null; approvalModeHint: string | null; warning: string | null } {
  const modelLabel = modelChoices.find((option) => option.model === model)?.displayName
    || model
    || text("공급자 기본", "Provider default");
  const effectiveApprovalMode: ChatApprovalMode = hasApprovalField ? approvalMode : "never";
  const approvalModeHint = APPROVAL_MODE_HINTS[approvalMode];
  return {
    summary: [
      modelLabel,
      reasoningEffort ? reasoningLabel(reasoningEffort) : text("기본 추론", "Default reasoning"),
      settingOptionLabel(fields, "mode", mode) ?? mode,
      ...(hasApprovalField ? [settingOptionLabel(fields, "approvalMode", approvalMode) ?? approvalMode] : []),
    ].join(" · "),
    agentHandoffNote: agentChangeable
      ? text("에이전트를 바꾸면 새 세션을 만들어 대화를 인계합니다. 원래 세션은 그대로 남습니다.", "Changing the agent creates a new session and hands the conversation over. The original session stays as is.")
      : null,
    approvalModeHint: approvalModeHint ? approvalModeHint(text) : null,
    warning: mode === "fullAccess" && effectiveApprovalMode === "never"
      ? text("다음 요청부터 샌드박스 없이 실행됩니다.", "From the next request, runs without a sandbox.")
      : mode === "fullAccess"
        ? text("다음 요청부터 같은 대화를 전체 접근으로 다시 연결합니다.", "From the next request, reconnects this conversation with full access.")
        : effectiveApprovalMode === "never" && hasApprovalField
          ? text("승인 요청 없이 현재 권한 범위에서 실행합니다.", "Runs within the current permission scope without approval prompts.")
          : null,
  };
}

export function ChatRuntimeSettingsMenu({
  panelId,
  contextLabel,
  source,
  mode,
  approvalMode,
  model,
  modelOptions,
  recentModels,
  reasoningEffort,
  reasoningOptions,
  settingFields,
  extraSettings,
  agentChoices,
  accountChoices,
  accountId,
  locked,
  planRestartLocked,
  planRestartNote,
  statusIndicator,
  contextMeter,
  statusLabel,
  onOpen,
  onModeChange,
  onApprovalModeChange,
  onAgentChange,
  onAccountChange,
  onModelChange,
  onReasoningEffortChange,
  onExtraSettingsApply,
}: ChatRuntimeSettingsMenuProps) {
  const { text } = useI18n();
  const { open, setOpen, rootRef } = useDismissablePopover();
  const fields = settingFields?.length ? settingFields : fallbackSettingFields(source);
  const extra = useExtraRuntimeSettings({ fields, extraSettings, source, onApply: onExtraSettingsApply });
  const modelChoices = mergeModelChoices(modelOptions, recentModels);
  const agents = agentChoices ?? [];
  const accounts = accountChoices ?? [];
  const planRestartDisabled = planRestartLocked ?? locked;
  // 승인 처리를 CLI로 전달할 통로가 없는 공급자는 스키마에서 항목 자체가 빠진다.
  // 고를 것이 없는 선택 박스와 요약 칩을 남기지 않고, 승인 요청은 없는 것으로 본다.
  const approvalOptions = settingOptions(fields, "approvalMode");
  const hasApprovalField = approvalOptions.length > 0;
  const { summary, agentHandoffNote, approvalModeHint, warning } = runtimeSettingsMessages({
    fields,
    mode,
    approvalMode,
    hasApprovalField,
    model,
    modelChoices,
    reasoningEffort,
    agentChangeable: agents.length > 0 && Boolean(onAgentChange),
  }, text);
  const settingLabels = (key: RuntimeSettingKey) => runtimeSettingLabels(key, contextLabel, text);

  return (
    <div className="chat-runtime-settings-menu" ref={rootRef}>
      <div className="chat-runtime-settings-bar">
        {statusIndicator}
        <button
          className={`button compact session-runtime-settings-button${open ? " active" : ""}`}
          type="button"
          aria-label={text(`현재 ${contextLabel} 설정: ${summary}`, `Current ${contextLabel} settings: ${summary}`)}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            if (!open) onOpen?.();
            setOpen((current) => !current);
          }}
        >
          <SlidersHorizontal size={13} aria-hidden="true" />
          <span>{summary}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        {statusLabel}
        {contextMeter}
      </div>
      {open && <div className="session-runtime-settings-panel" id={panelId}>
        <div className="session-composer-settings" role="group" aria-label={text(`${contextLabel} 실행 설정`, `${contextLabel} run settings`)}>
          {/* 에이전트는 공급자가 달라져 세션 ID를 공유할 수 없다. 재개가 아니라 새 세션
              인계이므로 다른 항목과 문구를 다르게 쓴다. */}
          {agents.length > 0 && onAgentChange && <RuntimeSettingSelect
            {...settingLabels("agent")}
            value={source}
            disabled={planRestartDisabled}
            onChange={(value) => onAgentChange(value as ProviderId)}
          >
            {agents.map((choice) => <option value={choice.source} key={choice.source} disabled={choice.disabled} title={choice.disabledReason ?? undefined}>
              {choice.label}{choice.source === source ? text(" · 현재", " · current") : ""}{choice.disabled ? text(" · CLI 미연결", " · CLI not connected") : ""}
            </option>)}
          </RuntimeSettingSelect>}
          {accounts.length > 0 && onAccountChange && <RuntimeSettingSelect
            {...settingLabels("account")}
            value={accountId ?? ""}
            disabled={planRestartDisabled}
            onChange={onAccountChange}
          >
            <option value="">{text("이어가기 설정에 따름", "Follow resume settings")}</option>
            {accounts.map((choice) => <option value={choice.id} key={choice.id} disabled={choice.blocked} title={choice.blockedReason ?? undefined}>
              {choice.label}{choice.blocked ? text(" · 자격증명 격리 불가", " · credential isolation unavailable") : ""}
            </option>)}
          </RuntimeSettingSelect>}
          <RuntimeSettingSelect
            {...settingLabels("model")}
            value={model}
            disabled={locked}
            onChange={onModelChange}
          >
            <option value="">{text("공급자 기본", "Provider default")}</option>
            {unlistedOption(model, modelChoices.some((option) => option.model === model))}
            {modelChoices.map((option) => <option value={option.model} key={option.model}>{option.displayName}</option>)}
          </RuntimeSettingSelect>
          <RuntimeSettingSelect
            {...settingLabels("reasoning")}
            value={reasoningEffort}
            disabled={locked}
            onChange={(value) => onReasoningEffortChange(value as ReasoningEffort | "")}
          >
            <option value="">{text("기본", "Default")}</option>
            {unlistedOption(reasoningEffort, reasoningOptions.some((option) => option.effort === reasoningEffort), reasoningLabel)}
            {reasoningOptions.map((option) => <option value={option.effort} key={option.effort}>{reasoningLabel(option.effort)}</option>)}
          </RuntimeSettingSelect>
          <RuntimeSettingSelect
            {...settingLabels("mode")}
            value={mode}
            disabled={planRestartDisabled}
            onChange={(value) => onModeChange(value as ChatMode)}
          >
            {settingOptions(fields, "mode").map((option) => (
              <option value={option.value} disabled={option.disabled} key={option.value}>{option.label}</option>
            ))}
          </RuntimeSettingSelect>
          {hasApprovalField && <RuntimeSettingSelect
            {...settingLabels("approval")}
            value={approvalMode}
            disabled={locked}
            onChange={(value) => onApprovalModeChange(value as ChatApprovalMode)}
          >
            {approvalOptions.map((option) => (
              <option value={option.value} disabled={option.disabled} key={option.value}>
                {option.label}{option.disabled && option.detail ? ` · ${option.detail}` : ""}
              </option>
            ))}
          </RuntimeSettingSelect>}
          {extra.fields.map((field) => <ExtraRuntimeSettingField
            field={field}
            value={extra.valueOf(field.key)}
            disabled={locked}
            modelChoices={field.key === "fallbackModel" ? modelChoices : undefined}
            onChange={(value) => extra.change(field.key, value)}
            key={field.key}
          />)}
        </div>
        {planRestartNote && <small className="session-mode-hint">{planRestartNote}</small>}
        {agentHandoffNote && <small className="session-mode-hint">{agentHandoffNote}</small>}
        {approvalModeHint && <small className="session-mode-hint">{approvalModeHint}</small>}
        {extra.fields.length > 0 && <div className="session-runtime-settings-actions">
          <small>{text("공급자가 제공한 추가 실행 설정입니다. 적용하면 다음 요청부터 같은 대화로 다시 연결합니다.", "Extra run settings provided by the provider. Applying them reconnects this conversation from the next request.")}</small>
          <button
            className="button compact"
            type="button"
            disabled={locked || !extra.changed}
            onClick={extra.apply}
          >{text("추가 설정 적용", "Apply extra settings")}</button>
        </div>}
      </div>}
      {warning && <small className="session-mode-warning" role="alert">{warning}</small>}
    </div>
  );
}

function ExtraRuntimeSettingField({ field, value, disabled, modelChoices, onChange }: {
  field: ChatSettingField;
  value: string;
  disabled: boolean;
  modelChoices?: ChatModelCatalogOption[];
  onChange: (value: string) => void;
}) {
  // 예비 모델처럼 자유 입력 스키마여도 모델 선택지가 주어지면 select로 고른다.
  const common = { className: "session-extra-setting-selector", title: field.detail ?? field.label, label: field.label, disabled, value, onChange } as const;
  const defaultOption = <option value="">공급자 기본{field.defaultValue ? ` · ${field.defaultValue}` : ""}</option>;
  if (modelChoices) {
    return <RuntimeSettingSelect {...common}>
      {defaultOption}
      {unlistedOption(value, modelChoices.some((option) => option.model === value))}
      {modelChoices.map((option) => <option value={option.model} key={option.model}>{option.displayName}</option>)}
    </RuntimeSettingSelect>;
  }
  if (field.kind === "enum") {
    return <RuntimeSettingSelect {...common}>
      {defaultOption}
      {field.options.map((option) => <option value={option.value} disabled={option.disabled} key={option.value}>
        {option.label}{option.detail ? ` · ${option.detail}` : ""}
      </option>)}
    </RuntimeSettingSelect>;
  }
  return <RuntimeSettingLabel className={common.className} title={common.title} label={common.label}>
    <input
      value={value}
      disabled={disabled}
      placeholder={field.detail ?? field.defaultValue ?? "공급자 기본"}
      onChange={(event) => onChange(event.target.value)}
    />
  </RuntimeSettingLabel>;
}

/** 실행 설정 항목의 공통 껍데기. 라벨 문구와 클래스만 다르고 구조는 모두 같다. */
function RuntimeSettingLabel({ className, title, label, children }: {
  className?: string;
  title: string;
  label: string;
  children: ReactNode;
}) {
  return <label className={`session-mode-selector${className ? ` ${className}` : ""}`} title={title}>
    <span>{label}</span>
    {children}
  </label>;
}

/** 선택 박스형 실행 설정 항목. 값 변환은 호출부가 onChange에서 맡는다. */
function RuntimeSettingSelect({ className, title, label, ariaLabel, value, disabled, onChange, children }: {
  className?: string;
  title: string;
  label: string;
  ariaLabel?: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return <RuntimeSettingLabel className={className} title={title} label={label}>
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {children}
    </select>
  </RuntimeSettingLabel>;
}
