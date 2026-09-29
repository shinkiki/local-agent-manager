import { useCallback, useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Bot, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useI18n } from "../lib/i18n";
import type { UiText } from "../lib/i18nLocale";
import {
  acknowledgeDocumentOfflineReport,
  createDocumentTrigger,
  deleteDocumentTrigger,
  getDocumentAutomationSnapshot,
  runDocumentTriggerTest,
  setDocumentTriggerEnabled,
  updateDocumentTrigger,
} from "../lib/ipc";
import { defaultApprovalMode, effectiveApprovalMode, normalizeSettingValue, settingFieldsFor } from "../lib/chatSettings";
import { validateDocumentTriggerDraft, type DocumentTriggerActionKind } from "../lib/documentWorkspace";
import { reasoningOptionsFor, useProviderOptions } from "../lib/providerOptions";
import type {
  AccountSnapshot,
  ChatApprovalMode,
  ChatMode,
  DocRootStatus,
  DocumentActionOption,
  DocumentAutomationSnapshot,
  DocumentChangeKind,
  DocumentOfflineChangeReport,
  DocumentTrigger,
  DocumentTriggerAction,
  DocumentTriggerInput,
  DocumentTriggerStatus,
  ModelOption,
  ProviderId,
  ProviderStatus,
  ReasoningEffort,
} from "../types";
import { defaultEffortFor, RuntimeSettings } from "./RuntimeSettings";
import { AppToggle, ErrorBanner, LoadingState, useBusyAction, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";

/**
 * 저장 형식에서 스킬 실행은 스킬을 고정한 `startChat`이지만, 승인 규칙이 다르므로 화면에서는
 * 따로 고른다. SKILL.md 안의 명령을 실행하는 경로는 없고, 승인한 본문만 새 채팅 지침으로 붙는다.
 */
type ActionKind = DocumentTriggerActionKind;

/**
 * 트리거 초안 한 벌. 같은 열여섯 칸을 초기화·수정 적재·저장 세 곳이 각각 나열하던 것을
 * 한 자료로 모아, 칸이 늘 때 세 곳을 함께 고쳐야 하는 부담을 없앤다.
 */
interface TriggerDraft {
  name: string;
  rootId: string;
  include: string;
  exclude: string;
  changeKinds: DocumentChangeKind[];
  actionKind: ActionKind;
  targetId: string;
  source: ProviderId;
  accountId: string;
  model: string;
  reasoningEffort: ReasoningEffort | "";
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  fullAccessAcknowledged: boolean;
  prompt: string;
  skillId: string;
}

/**
 * 액션 갈래 하나가 정하는 것 한 벌. 갈래를 보고 갈리는 자리는 넷(고르는 드롭다운의 선택지,
 * 채팅 계열인지, 스킬 계열인지, 채팅 계열이 아닐 때 '실행 대상'이 고를 목록)인데 넷이
 * 저마다 갈래 이름을 문자열로 다시 나열했다. 그래서 갈래가 하나 늘면 네 자리를 함께
 * 고쳐야 했고, 어느 한 자리를 빠뜨려도 타입은 아무 말을 하지 않았다.
 */
interface ActionKindSpec {
  /** 액션 드롭다운에 보일 이름. 목록 순서는 아래 표의 줄 순서 그대로다. */
  label: (text: (ko: string, en: string) => string) => string;
  /** 채팅 계열인가. 공급자·실행 계정·모델·프롬프트 칸은 이 갈래에만 뜬다. */
  chat: boolean;
  /** 스킬 계열인가. 적용 스킬 칸과 재승인 안내는 이 갈래에만 뜬다. */
  skill: boolean;
  /** 채팅 계열이 아닐 때 '실행 대상'이 고를 목록. 채팅 계열은 그 칸 자체가 없어 null이다. */
  targets: "scheduledRequests" | "workflows" | null;
}

const ACTION_KIND_SPECS = {
  runSchedule: { label: (text) => text("반복 요청 실행", "Run recurring schedule"), chat: false, skill: false, targets: "scheduledRequests" },
  startChat: { label: (text) => text("새 채팅 요청", "New chat request"), chat: true, skill: false, targets: null },
  runSkill: { label: (text) => text("스킬 실행", "Run skill"), chat: true, skill: true, targets: null },
  executeWorkflow: { label: (text) => text("시스템 워크플로 실행", "Execute system workflow"), chat: false, skill: false, targets: "workflows" },
} satisfies Record<ActionKind, ActionKindSpec>;

/** 드롭다운이 훑을 갈래 목록. 표에서 뽑으므로 선택지와 규칙이 어긋날 수 없다. */
const ACTION_KINDS = Object.keys(ACTION_KIND_SPECS) as ActionKind[];

/** 채팅 실행 계열과 스킬 실행 여부를 액션 분기마다 문자열로 다시 풀어 쓰지 않는다. */
function isChatActionKind(kind: ActionKind): boolean {
  return ACTION_KIND_SPECS[kind].chat;
}

function isSkillActionKind(kind: ActionKind): boolean {
  return ACTION_KIND_SPECS[kind].skill;
}

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function emptyDraft(providers: ProviderStatus[], rootId: string): TriggerDraft {
  const source = providers[0]?.provider ?? "codex";
  return {
    name: "",
    rootId,
    include: "**/*",
    exclude: "",
    // 새 트리거는 변경 종류를 모두 감시한다. 갈래 이름을 여기서 다시 적으면 갈래가 늘
    // 때 기본값만 예전 셋에 머무르므로, 체크박스와 같은 표를 본다.
    changeKinds: [...CHANGE_KINDS],
    actionKind: "runSchedule",
    targetId: "",
    source,
    accountId: "",
    model: "",
    reasoningEffort: "",
    mode: "workspace",
    approvalMode: defaultApprovalMode(source),
    fullAccessAcknowledged: false,
    prompt: "",
    skillId: "",
  };
}

/**
 * 채팅 계열이 아닌 액션에는 공급자·모델 칸이 없으므로, 그 칸은 지금 화면에 있는 값을 그대로
 * 둔다(예전 setter 나열과 같은 동작).
 */
function draftFromTrigger(trigger: DocumentTrigger, current: TriggerDraft): TriggerDraft {
  const common: TriggerDraft = {
    ...current,
    name: trigger.name,
    rootId: trigger.rootId,
    include: trigger.include.join("\n"),
    exclude: trigger.exclude.join("\n"),
    changeKinds: trigger.changeKinds,
    fullAccessAcknowledged: false,
  };
  const action = trigger.action;
  if (action.type === "runSchedule") return { ...common, actionKind: "runSchedule", targetId: action.scheduleId };
  if (action.type === "executeWorkflow") return { ...common, actionKind: "executeWorkflow", targetId: action.workflowId };
  return {
    ...common,
    actionKind: action.skill ? "runSkill" : "startChat",
    targetId: "",
    source: action.source,
    accountId: action.accountId ?? "",
    model: action.model ?? "",
    reasoningEffort: action.reasoningEffort ?? "",
    mode: action.mode,
    approvalMode: action.approvalMode,
    prompt: action.prompt,
    skillId: action.skill?.skillId ?? "",
  };
}

/**
 * 화면 초안을 저장 계약으로 바꾼다. 패널은 상태와 검증 흐름만 맡고, 액션별 직렬화와 기존
 * 트리거의 실행 간격 보존은 이 순수 변환 한 곳에서 다룬다.
 */
function buildDocumentTriggerInput(
  draft: TriggerDraft,
  editing: DocumentTrigger | null,
  selectedSkill?: DocumentActionOption,
  selectedWorkflow?: DocumentActionOption,
): DocumentTriggerInput {
  const {
    name, rootId, include, exclude, changeKinds, actionKind, targetId, source, accountId,
    model, reasoningEffort, mode, approvalMode, prompt,
  } = draft;
  let action: DocumentTriggerAction;
  if (actionKind === "runSchedule") {
    action = { type: "runSchedule", scheduleId: targetId };
  } else if (actionKind === "executeWorkflow") {
    action = {
      type: "executeWorkflow",
      workflowId: targetId,
      approvedVersion: selectedWorkflow?.version ?? 0,
      arguments: {},
    };
  } else {
    action = {
      type: "startChat",
      source,
      accountId: accountId || null,
      model: model.trim() || null,
      reasoningEffort: reasoningEffort || null,
      mode,
      approvalMode: effectiveApprovalMode(source, approvalMode),
      prompt,
      settings: {},
      // 스킬 실행은 지금 보이는 내용의 지문을 승인값으로 고정한다. 새 채팅 구분에서는
      // 스킬을 붙이지 않아 두 구분이 저장본에서도 섞이지 않는다.
      skill: isSkillActionKind(actionKind) && selectedSkill
        ? { skillId: selectedSkill.id, contentDigest: selectedSkill.contentDigest ?? "" }
        : null,
    };
  }

  return {
    name: name.trim(),
    rootId,
    include: lines(include),
    exclude: lines(exclude),
    changeKinds,
    enabled: editing?.enabled ?? true,
    debounceMs: editing?.debounceMs ?? 2000,
    cooldownMs: editing?.cooldownMs ?? 30000,
    action,
  };
}

/**
 * 저장 전에 초안을 검사해 사람이 읽을 문제 목록을 만든다. 검사기(`validateDocumentTriggerDraft`)는
 * lib에 있지만 그 입력 열두 칸을 초안·저장 입력·고른 스킬에서 골라 담는 일은 화면 몫인데,
 * 그 조립이 저장 절차(검사 → 오류 표시 → 서버 호출 → 초기화) 한가운데에 펼쳐져 있어 저장이
 * 무엇을 하는지 읽으려면 칸 이름 열둘을 먼저 지나야 했다. 조립만 여기로 가르고, 무엇을
 * 문제로 볼지는 검사기에, 언제 부를지는 저장 절차에 그대로 둔다.
 *
 * 승인 지문과 워크플로 승인본은 초안에 없고 고른 항목·저장 입력에만 있으므로 함께 받는다.
 */
function documentTriggerDraftProblems(
  draft: TriggerDraft,
  input: DocumentTriggerInput,
  text: UiText,
  selectedSkill?: DocumentActionOption,
): string[] {
  return validateDocumentTriggerDraft({
    name: draft.name,
    rootId: draft.rootId,
    changeKinds: draft.changeKinds,
    actionKind: draft.actionKind,
    actionTargetId: draft.targetId,
    prompt: draft.prompt,
    skillId: draft.skillId,
    skillContentDigest: selectedSkill?.contentDigest ?? null,
    workflowApprovedVersion: input.action.type === "executeWorkflow" ? input.action.approvedVersion : null,
    fullAccessMode: isChatActionKind(draft.actionKind) && draft.mode === "fullAccess",
    fullAccessAcknowledged: draft.fullAccessAcknowledged,
  }, text);
}

/**
 * 변경 자동화 패널이 서버와 주고받는 몫 한 벌. 스냅숏·오류·진행 표시 세 상태는 언제나 함께
 * 움직인다 — 첫 적재도, 트리거를 저장·삭제·전환·시험 실행하는 다섯 자리도 같은 순서(진행
 * 표시 켜기 → 오류 지우기 → 실패 시 오류 표시 → 스냅숏 다시 읽기)를 지나는데, 그 흐름이
 * 초안 열여섯 칸과 그 정규화 효과 사이에 끼어 패널 본문의 절반을 차지했다. 서버 몫을 훅으로
 * 들어내 패널은 초안·검증·렌더만 다룬다.
 *
 * 훅 호출은 패널 본문 맨 앞에 둔다 — 첫 적재 효과는 예전에도 초안 효과들보다 먼저 돌았다.
 *
 * 진행 표시와 실패 문구를 다루는 열 줄(`busy` 켜기 → 문구 지우기 → 실행 → 실패 문구 →
 * `finally`로 되돌리기)은 앱 공용 봉투(`useBusyAction`)가 이미 들고 있는 것과 같은 모양이라
 * 그 한 벌을 쓴다. 이 화면은 한 번에 한 작업만 도는 자리라 토큰은 하나만 쓰고, 부르는 쪽에는
 * 예전처럼 참·거짓으로 내보낸다.
 */
function useDocumentAutomationSnapshot() {
  const [snapshot, setSnapshot] = useState<DocumentAutomationSnapshot | null>(null);
  const { busy, error, setError, run } = useBusyAction();

  // 첫 적재와 다시 읽기는 진행 표시를 켜지 않는다(예전 그대로). 실패 문구만 같은 자리에 쓴다.
  const refresh = useCallback(async () => {
    setError(null);
    try {
      setSnapshot(await getDocumentAutomationSnapshot());
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [setError]);

  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * 트리거 저장·삭제·활성화·시험 실행·오프라인 보고 확인이 공유하는 작업 수명주기.
   * `afterSuccess`는 서버 작업이 성공한 뒤, 새 스냅샷을 읽기 전에만 실행한다.
   */
  const runMutation = async (work: () => Promise<unknown>, afterSuccess?: () => void) => {
    await run("mutation", async () => {
      await work();
      afterSuccess?.();
      await refresh();
    });
  };

  return { snapshot, error, setError, busy: busy !== null, refresh, runMutation };
}

interface UseDocumentTriggerDraftOptions {
  providers: ProviderStatus[];
  watchableRoots: DocRootStatus[];
  snapshot: DocumentAutomationSnapshot | null;
  runMutation: (work: () => Promise<unknown>, afterSuccess?: () => void) => Promise<void>;
  setError: (message: string | null) => void;
}

/**
 * 트리거 초안 한 벌의 수명주기(초기화·수정 적재·저장 검증)와 모델 카탈로그 변경에 따른
 * 초안 정규화(공급자·사고 수준·권한 모드)를 다룬다.
 * 패널 본문에서 초안 상태와 효과들을 훅으로 들어내 렌더는 UI 조립과 확인 모달에 집중한다.
 */
function useDocumentTriggerDraft({
  providers,
  watchableRoots,
  snapshot,
  runMutation,
  setError,
}: UseDocumentTriggerDraftOptions) {
  // 저장 검증 문구는 사용자가 읽는 것이라 로케일을 따른다. 검사기는 손잡이를 받으므로 여기서 쥔다.
  const { text } = useI18n();
  const [editing, setEditing] = useState<DocumentTrigger | null>(null);
  const [draft, setDraft] = useState<TriggerDraft>(() => emptyDraft(providers, ""));
  // 효과의 의존 목록과 아래 파생값이 실제로 보는 칸만 푼다. 저장은 초안 한 벌을 그대로
  // 넘기므로, 칸이 늘어도 이 목록은 흔들리지 않는다.
  const { rootId, actionKind, targetId, source, model, reasoningEffort, skillId } = draft;
  const patch = useCallback((changes: Partial<TriggerDraft>) => setDraft((current) => ({ ...current, ...changes })), []);

  useEffect(() => {
    if (!rootId && watchableRoots.length > 0) patch({ rootId: watchableRoots[0].id });
  }, [patch, rootId, watchableRoots]);

  const providerOptions = useProviderOptions(source);

  const selectedWorkflow = actionKind === "executeWorkflow"
    ? snapshot?.options.workflows.find((item) => item.id === targetId)
    : undefined;
  const selectedSkill = isSkillActionKind(actionKind) && skillId
    ? snapshot?.options.skills.find((item) => item.id === skillId)
    : undefined;
  // 승인 당시 지문과 현재 지문이 다르면 저장이 곧 재승인이라는 사실을 미리 알린다.
  const pinnedDigest = editing?.action.type === "startChat" ? editing.action.skill?.contentDigest ?? null : null;
  const skillChangedSinceApproval = Boolean(pinnedDigest && selectedSkill?.contentDigest && pinnedDigest !== selectedSkill.contentDigest);
  const skillUnavailable = isSkillActionKind(actionKind) && Boolean(skillId) && !selectedSkill;

  useProviderSchemaFallback({ providerOptions, source, model, reasoningEffort, patch, setDraft });

  const reset = () => {
    setEditing(null);
    setDraft(emptyDraft(providers, watchableRoots[0]?.id ?? ""));
  };

  const edit = (trigger: DocumentTrigger) => {
    setEditing(trigger);
    setDraft((current) => draftFromTrigger(trigger, current));
  };

  const save = async () => {
    const input = buildDocumentTriggerInput(draft, editing, selectedSkill, selectedWorkflow);
    const problems = documentTriggerDraftProblems(draft, input, text, selectedSkill);
    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }
    await runMutation(
      () => editing
        ? updateDocumentTrigger(editing.id, input)
        : createDocumentTrigger(input),
      reset,
    );
  };

  return {
    draft,
    editing,
    patch,
    reset,
    edit,
    save,
    derived: { providerOptions, selectedWorkflow, skillUnavailable, skillChangedSinceApproval },
  };
}

/**
 * 공급자 카탈로그가 바뀌었을 때 초안의 실행 설정 세 칸(추론 강도·권한·승인)을 지금 스키마가
 * 인정하는 값으로 되맞추는 효과 한 벌. 초안 훅은 칸 열여섯을 들고 편집·저장을 이끄는데,
 * 그 한가운데에 카탈로그를 읽어 값을 도로 끌어내리는 효과 둘이 끼어 있어 초안 흐름과
 * 스키마 되맞춤이 한 몸으로 읽혔다. 되맞춤만 이 훅으로 가른다.
 *
 * 호출 자리는 초안 훅 안, 기본 폴더 효과 바로 뒤여야 한다 — 효과 등록 순서가 그대로였다.
 * 두 효과의 조건과 의존 목록은 옮기기 전과 같다.
 */
function useProviderSchemaFallback({
  providerOptions,
  source,
  model,
  reasoningEffort,
  patch,
  setDraft,
}: {
  providerOptions: ReturnType<typeof useProviderOptions>;
  source: ProviderId;
  model: string;
  reasoningEffort: ReasoningEffort | "";
  patch: (changes: Partial<TriggerDraft>) => void;
  setDraft: Dispatch<SetStateAction<TriggerDraft>>;
}) {
  useEffect(() => {
    const efforts = reasoningOptionsFor(providerOptions, model);
    // 카탈로그 로딩 중(목록이 비어 있음)에는 저장된 값을 지우지 않는다.
    if (reasoningEffort && efforts.length > 0 && !efforts.some((option) => option.effort === reasoningEffort)) patch({ reasoningEffort: "" });
  }, [model, patch, providerOptions, reasoningEffort]);

  useEffect(() => {
    // 저장된 권한·승인 값이 최신 스키마에서 사라졌으면 안전한 값으로 되돌린다.
    const fields = settingFieldsFor(providerOptions, source);
    setDraft((current) => ({
      ...current,
      mode: normalizeSettingValue(fields, "mode", current.mode) as ChatMode,
      approvalMode: normalizeSettingValue(fields, "approvalMode", current.approvalMode) as ChatApprovalMode,
    }));
  }, [providerOptions, setDraft, source]);
}

/**
 * 초안 훅이 이미 정한 파생값 한 벌. 읽는 곳은 액션 입력부와 그 아래 주의 안내 둘뿐인데도
 * 네 이름이 초안 훅의 반환·패널 본문의 구조분해·액션 뷰 훅의 옵션 서명·구조분해·반환까지
 * 다섯 자리에 되풀이됐다. 파생 규칙의 소유는 초안 훅에 그대로 두고, 중간 자리는 이름을
 * 몰라도 되게 묶음 하나로 넘긴다.
 */
interface TriggerDraftDerived {
  providerOptions: ReturnType<typeof useProviderOptions>;
  selectedWorkflow?: DocumentActionOption;
  /** 저장된 스킬이 목록에서 사라졌는지. */
  skillUnavailable: boolean;
  /** 승인 당시 지문과 현재 지문이 달라, 저장이 곧 재승인이 되는지. */
  skillChangedSinceApproval: boolean;
}

interface Props {
  roots: DocRootStatus[];
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  models: ModelOption[];
  onRequestAiaPrompt?: (prompt: string) => void;
}

interface UseTriggerActionViewOptions {
  draft: TriggerDraft;
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  models: ModelOption[];
  snapshot: DocumentAutomationSnapshot | null;
  derived: TriggerDraftDerived;
}

/**
 * 액션 입력부와 그 아래 주의 안내가 함께 보는 한 벌. 다섯 칸 모두 그 두 자리에서만 읽히는데도
 * 패널 본문의 구조분해·폼 호출부·폼 서명·폼 구조분해·두 자식 호출부까지 같은 이름이
 * 되풀이돼, 칸이 하나 늘면 여섯 자리를 함께 고쳐야 했다. 범위 입력부가 초안 한 벌을 받고
 * 트리거 줄이 `DocumentTriggerRowView`로 층을 잇는 것과 같은 모양으로, 중간 자리는 이름을
 * 몰라도 되게 한다.
 *
 * 초안 훅이 이미 만들어 둔 세 칸(워크플로 선택·스킬 사라짐·승인 이후 변경)은 다시 계산하지
 * 않고 그대로 받아 묶음에 싣는다 — 파생 규칙의 소유는 초안 훅에 그대로 둔다.
 */
function useTriggerActionView({
  draft: { actionKind, source },
  providers,
  accounts,
  models,
  snapshot,
  derived,
}: UseTriggerActionViewOptions): TriggerActionView {
  // CLI를 찾지 못한 공급자로 자동 실행을 새로 걸지는 않게 하되, 이미 저장된 선택은
  // 목록에서 사라지지 않도록 함께 보여 준다.
  const selectableProviders = providers.filter((provider) => provider.cli.detected || provider.provider === source);
  const providerAccounts = accounts?.accounts.filter((account) => account.provider === source && !account.disabled) ?? [];
  const activeAccountId = accounts?.providers.find((state) => state.provider === source)?.activeAccountId ?? null;
  // 어느 목록을 고를지는 갈래 표가 정한다. 채팅 계열은 '실행 대상' 칸 자체가 없어 빈
  // 목록이다 — 예전에는 그 자리에도 워크플로 목록이 담겼지만, 그리는 자리가 없어 아무도
  // 읽지 않는 값이었다.
  const options = useMemo(() => {
    const targets = ACTION_KIND_SPECS[actionKind].targets;
    return targets ? snapshot?.options[targets] ?? [] : [];
  }, [actionKind, snapshot]);

  const choices: TriggerChatChoices = {
    selectableProviders,
    providerAccounts,
    activeAccountId,
    providerOptions: derived.providerOptions,
    models,
    availableSkills: snapshot?.options.skills ?? [],
    skillUnavailable: derived.skillUnavailable,
  };
  return { options, choices, derived };
}

/** 액션 종류를 고르는 자리부터 그 주의 안내까지가 함께 보는 값 한 벌. */
interface TriggerActionView {
  /** 반복 요청·워크플로 실행이 고를 대상 목록. 액션 종류에 따라 갈린다. */
  options: DocumentActionOption[];
  choices: TriggerChatChoices;
  /** 주의 안내가 보는 파생값. 초안 훅이 정한 것을 그대로 싣는다. */
  derived: TriggerDraftDerived;
}

export function DocumentAutomationPanel({ roots, providers, accounts, models, onRequestAiaPrompt }: Props) {
  const { text } = useI18n();
  const { snapshot, error, setError, busy, refresh, runMutation } = useDocumentAutomationSnapshot();
  const { confirm, confirmDialog } = useConfirm();

  /**
   * 트리거가 감시할 수 있는 폴더. 사라졌거나 접근이 막힌 등록본은 고를 수 없으므로 기본
   * 선택도 이 목록에서 잡는다 — 전체 등록본에서 고르면 선택지에 없는 값이 기본이 된다.
   */
  const watchableRoots = useMemo(() => roots.filter((root) => root.exists && !root.restricted), [roots]);

  const { draft, editing, patch, reset, edit, save, derived } = useDocumentTriggerDraft({
    providers,
    watchableRoots,
    snapshot,
    runMutation,
    setError,
  });

  const action = useTriggerActionView({ draft, providers, accounts, models, snapshot, derived });

  const removeTrigger = async (trigger: DocumentTrigger) => {
    const accepted = await confirm({
      title: text("파일 트리거 삭제", "Delete file trigger"),
      message: text(`'${trigger.name}' 트리거를 삭제할까요?`, `Delete trigger '${trigger.name}'?`),
      warning: text("대기 중인 변경 이벤트도 함께 사라집니다. 등록 폴더의 파일은 그대로 유지됩니다.", "Pending change events will also be discarded. Files in registered folders will be kept as is."),
      confirmLabel: text("삭제", "Delete"),
      tone: "danger",
    });
    if (accepted) await runMutation(() => deleteDocumentTrigger(trigger.id));
  };

  if (!snapshot && !error) return <LoadingState label={text("변경 자동화 확인 중", "Checking document automation...")} />;

  return <div className="document-automation-panel">
    {error && <ErrorBanner message={error} />}
    {snapshot?.offlineReport && !snapshot.offlineReport.acknowledged && <DocumentOfflineReportBanner
      report={snapshot.offlineReport}
      onRequestAiaPrompt={onRequestAiaPrompt}
      onAcknowledge={(id) => void runMutation(() => acknowledgeDocumentOfflineReport(id))}
    />}

    <DocumentTriggerForm
      roots={roots}
      watchableRoots={watchableRoots}
      draft={draft}
      editing={editing}
      busy={busy}
      action={action}
      onPatch={patch}
      onReset={reset}
      onSave={save}
      onRefresh={refresh}
    />

    <DocumentTriggerList
      triggers={snapshot?.triggers ?? []}
      roots={roots}
      row={{
        skills: snapshot?.options.skills ?? [],
        busy,
        onEdit: edit,
        onTest: (trigger) => void runMutation(() => runDocumentTriggerTest(trigger.id)),
        onToggleEnabled: (trigger, enabled) => void runMutation(() => setDocumentTriggerEnabled(trigger.id, enabled)),
        onRemove: (trigger) => void removeTrigger(trigger),
      }}
    />
    {confirmDialog}
  </div>;
}

/**
 * 트리거 등록·수정 폼의 표시 한 벌. 패널 본문은 서버 스냅숏과 초안 훅을 연결한 뒤에도
 * 빈 상태·범위 필드·액션 필드·주의 문구·저장 액션의 배치를 모두 직접 들고 있었다.
 * 표시만 전용 컴포넌트로 가르고, 초안 상태와 저장 수명주기는 기존 훅에 그대로 둔다.
 */
function DocumentTriggerForm({
  roots,
  watchableRoots,
  draft,
  editing,
  busy,
  action,
  onPatch,
  onReset,
  onSave,
  onRefresh,
}: {
  roots: DocRootStatus[];
  watchableRoots: DocRootStatus[];
  draft: TriggerDraft;
  editing: DocumentTrigger | null;
  busy: boolean;
  action: TriggerActionView;
  onPatch: (changes: Partial<TriggerDraft>) => void;
  onReset: () => void;
  onSave: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const { text } = useI18n();
  const emptyMessage = roots.length === 0
    ? text("감시할 등록 폴더가 없습니다. 왼쪽 등록 폴더 사이드바의 + 버튼에서 폴더를 먼저 등록하세요.", "No registered folders to watch. Please register a folder first using the + button in the left sidebar.")
    : text("등록된 등록 폴더가 모두 사라졌거나 접근할 수 없습니다. 사이드바에서 폴더 상태를 확인한 뒤 다시 등록하세요.", "All registered folders are missing or inaccessible. Please check the folder status in the sidebar and register again.");

  return (
    <section className="document-trigger-form">
      <header><div><strong>{editing ? text("파일 트리거 수정", "Edit file trigger") : text("파일 트리거 등록", "Register file trigger")}</strong><span>{text("등록 폴더 변경을 기존 타입화된 액션에 연결합니다.", "Connect registered folder changes to existing typed actions.")}</span></div><button className="icon-button" type="button" onClick={() => void onRefresh()} aria-label={text("새로고침", "Refresh")}><RefreshCw size={15} /></button></header>
      {watchableRoots.length === 0 ? <p className="tree-empty">{emptyMessage}</p> : <>
      <TriggerScopeFields
        draft={draft}
        watchableRoots={watchableRoots}
        onPatch={onPatch}
      />
      <TriggerActionFields
        draft={draft}
        action={action}
        onPatch={onPatch}
      />
      <TriggerActionNotes actionKind={draft.actionKind} action={action} />
      <div className="document-trigger-form-actions">{editing && <button className="button" type="button" onClick={onReset}>{text("취소", "Cancel")}</button>}<button className="button primary" type="button" disabled={busy} onClick={() => void onSave()}><Plus size={14} /> {editing ? text("수정 저장", "Save changes") : text("트리거 등록", "Register trigger")}</button></div>
      </>}
    </section>
  );
}

/**
 * 백엔드가 멈춰 있던 사이의 변경 보고 알림. 보고 한 건을 값으로 받으므로 본문과 두 버튼이
 * 저마다 `snapshot?.offlineReport`를 다시 짚지 않는다(확인 버튼의 `!` 단정도 함께 사라진다).
 */
function DocumentOfflineReportBanner({
  report,
  onRequestAiaPrompt,
  onAcknowledge,
}: {
  report: DocumentOfflineChangeReport;
  onRequestAiaPrompt?: (prompt: string) => void;
  onAcknowledge: (reportId: string) => void;
}) {
  const { text } = useI18n();
  return <section className="document-offline-report">
    <div><strong>{text(`백엔드 중단 중 문서 변경 ${report.totalCount}건`, `${report.totalCount} document changes during backend downtime`)}</strong><span>{text("자동 실행하지 않았습니다. AIA가 통합 변경 보고를 검토하도록 요청할 수 있습니다.", "Not automatically executed. You can request AIA to review the consolidated change report.")}</span></div>
    <button className="button" type="button" onClick={() => onRequestAiaPrompt?.(text(`백엔드 중단 중 감지된 문서 변경 보고 ${report.id}를 검토하고, 자동 실행 없이 영향과 권장 후속조치만 정리해줘.`, `Review document change report ${report.id} detected during backend downtime, and summarize the impact and recommended follow-up actions without automatic execution.`))}><Bot size={14} /> {text("AIA 검토", "AIA Review")}</button>
    <button className="button" type="button" onClick={() => onAcknowledge(report.id)}>{text("확인", "Acknowledge")}</button>
  </section>;
}

/**
 * 트리거 감시 범위(이름, 대상 등록 폴더, 포함·제외 패턴, 감지할 변경 종류) 입력부.
 *
 * 액션 입력부는 이미 초안 한 벌을 받는데 이 자리만 다섯 칸을 손으로 풀어 받아, 초안에
 * 범위 칸이 하나 늘면 패널 본문의 구조분해·호출부·서명·구조분해 네 자리를 함께 고쳐야
 * 했다. 두 입력부가 같은 모양으로 초안을 받게 하고, 푸는 일은 쓰는 자리에서 끝낸다.
 */
function TriggerScopeFields({
  draft: { name, rootId, include, exclude, changeKinds },
  watchableRoots,
  onPatch,
}: {
  draft: TriggerDraft;
  watchableRoots: DocRootStatus[];
  onPatch: (changes: Partial<TriggerDraft>) => void;
}) {
  const { text } = useI18n();
  return (
    <>
      <div className="document-trigger-grid">
        <label>{text("이름", "Name")}<input value={name} onChange={(event) => onPatch({ name: event.target.value })} placeholder={text("예: 보고서 변경 검토", "e.g. Review report changes")} /></label>
        <TriggerSelect label={text("등록 폴더", "Registered folder")} value={rootId} onChange={(next) => onPatch({ rootId: next })}>{watchableRoots.map((root) => <option value={root.id} key={root.id}>{root.name}</option>)}</TriggerSelect>
        <label>{text("포함 패턴", "Include pattern")}<textarea value={include} onChange={(event) => onPatch({ include: event.target.value })} placeholder="**/*" /></label>
        <label>{text("제외 패턴", "Exclude pattern")}<textarea value={exclude} onChange={(event) => onPatch({ exclude: event.target.value })} placeholder="tmp/**" /></label>
      </div>
      <fieldset><legend>{text("변경 종류", "Change types")}</legend>{CHANGE_KINDS.map((kind) => <label key={kind}><input type="checkbox" checked={changeKinds.includes(kind)} onChange={() => onPatch({ changeKinds: toggleChangeKind(changeKinds, kind) })} />{CHANGE_KIND_LABELS[kind](text)}</label>)}</fieldset>
    </>
  );
}

/**
 * 트리거 한 줄이 쓰는 값과 조작 한 벌. 목록은 이 여섯 칸을 하나도 읽지 않고 줄에 그대로
 * 넘기기만 하는데도 패널 호출부·목록 서명·전달·줄 서명 네 자리에 같은 이름이 되풀이됐다.
 * 칸이 하나 늘면 네 자리를 함께 고쳐야 했으므로, 묶음 하나로 두어 목록은 이름을 몰라도
 * 되게 한다(트리 창이 `DocumentTreeView`로 층을 잇는 것과 같은 모양이다).
 */
interface DocumentTriggerRowView {
  skills: DocumentActionOption[];
  busy: boolean;
  onEdit: (trigger: DocumentTrigger) => void;
  onTest: (trigger: DocumentTrigger) => void;
  onToggleEnabled: (trigger: DocumentTrigger, enabled: boolean) => void;
  onRemove: (trigger: DocumentTrigger) => void;
}

/**
 * 등록된 트리거 목록. 목록은 초안·검증·저장과 상태를 나눠 갖지 않고 네 콜백으로만 이어지므로,
 * 표시 전용 컴포넌트로 떼어 패널의 렌더가 트리거 등록 폼만 다루게 한다.
 */
function DocumentTriggerList({
  triggers,
  roots,
  row,
}: {
  triggers: DocumentTrigger[];
  roots: DocRootStatus[];
  row: DocumentTriggerRowView;
}) {
  const { text } = useI18n();
  return <section className="document-trigger-list"><header><strong>{text("등록된 트리거", "Registered triggers")}</strong><span>{text(`${triggers.length}개`, `${triggers.length}`)}</span></header>{triggers.length ? triggers.map((trigger) => <DocumentTriggerRow
    key={trigger.id}
    trigger={trigger}
    rootName={roots.find((root) => root.id === trigger.rootId)?.name ?? trigger.rootId}
    view={row}
  />) : <p className="tree-empty">{text("등록된 트리거가 없습니다.", "No registered triggers.")}</p>}</section>;
}

function DocumentTriggerRow({
  trigger,
  rootName,
  view: { skills, busy, onEdit, onTest, onToggleEnabled, onRemove },
}: {
  trigger: DocumentTrigger;
  rootName: string;
  view: DocumentTriggerRowView;
}) {
  const { text } = useI18n();
  return <article>
    <div><strong>{trigger.name}</strong><span>{rootName} · {actionLabel(trigger.action, skills, text)} · {TRIGGER_STATUS_LABELS[trigger.status](text)}</span>{trigger.statusReason && <small>{trigger.statusReason}</small>}{trigger.status === "needsReview" && <small>{text("수정 화면에서 다시 저장해 재승인하기 전까지 실행하지 않습니다.", "Will not execute until re-approved by saving again in the edit screen.")}</small>}</div>
    <div className="document-trigger-row-actions"><button className="button" type="button" onClick={() => onEdit(trigger)}>{text("수정", "Edit")}</button><button className="icon-button" type="button" disabled={busy} onClick={() => onTest(trigger)} aria-label={text("테스트", "Test")}><Play size={14} /></button><AppToggle checked={trigger.enabled} disabled={busy} label={text(`${trigger.name} 활성화`, `Enable ${trigger.name}`)} onChange={(checked) => onToggleEnabled(trigger, checked)} /><button className="icon-button danger" type="button" disabled={busy} onClick={() => onRemove(trigger)} aria-label={text("삭제", "Delete")}><Trash2 size={14} /></button></div>
  </article>;
}

/**
 * 변경 종류·트리거 상태 이름표는 `satisfies Record<…>`로 갈래를 빠짐없이 덮는다. 그래서
 * 찾지 못한 경우란 없는데도 두 표 모두 `?? 원래 값` 갈래를 낀 도우미를 한 겹 두고 있었다.
 * 닿을 수 없는 갈래는 갈래가 늘었을 때 화면이 영문 식별자를 그대로 보여 주며 조용히
 * 넘어가게 할 뿐이다 — 표에서 빠지면 지금은 타입 오류로 먼저 걸린다. 이름만 있는 우회로를
 * 걷어내고 부르는 자리가 표를 곧장 본다.
 */
const CHANGE_KIND_LABELS = {
  created: (text) => text("등록", "Created"),
  modified: (text) => text("수정", "Modified"),
  deleted: (text) => text("삭제", "Deleted"),
} satisfies Record<DocumentChangeKind, (text: (ko: string, en: string) => string) => string>;

/**
 * 체크박스가 훑을 변경 종류 목록. 액션 갈래가 이미 그러듯(`ACTION_KINDS`) 이름표 표에서
 * 뽑으므로 선택지와 이름표가 어긋날 수 없다. 예전에는 같은 세 이름이 이름표 표에서 백 줄
 * 떨어진 자리에 배열로 한 번 더 적혀 있어, 갈래가 하나 늘면 표에 이름을 넣고도 체크박스에
 * 뜨지 않는(또는 그 반대의) 모양이 조용히 생길 수 있었다.
 */
const CHANGE_KINDS = Object.keys(CHANGE_KIND_LABELS) as readonly DocumentChangeKind[];

/** 실행 대상·스킬 선택지에 보일 한 줄. 덧말은 있을 때만 괄호로 붙인다. */
function optionLabel(item: DocumentActionOption): string {
  return item.detail ? `${item.label} (${item.detail})` : item.label;
}

/**
 * 초안 한 칸을 고르는 select 입력. 트리거 폼에는 이런 칸이 다섯(등록 폴더·액션·공급자·
 * 실행 계정·실행 대상) 있는데, 다섯 모두 같은 세 줄(`<label>` 안에 머리말과 `<select>`,
 * `event.target.value`를 꺼내 넘기는 onChange)을 각자 적고 있었다. 그래서 칸 하나의 모양을
 * 고치면 나머지 넷이 조용히 어긋났고, 값이 문자열 합집합인 칸(액션·공급자)은 저마다
 * `as` 단언을 자기 자리에 두어 단언이 붙는 자리가 흩어졌다.
 *
 * 다른 것은 머리말·값·선택지 목록뿐이므로 그 셋만 칸으로 남긴다. 선택지는 자리마다
 * 달라(정적 표·등록 폴더·공급자·계정·서버 목록) 자식으로 받고, 값 타입을 타입 변수로
 * 열어 단언을 이 한 자리에 모은다.
 */
function TriggerSelect<T extends string>({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>{children}</select>
    </label>
  );
}

/**
 * 실행 대상·적용 스킬을 고르는 select. 두 자리가 `선택` 자리표시자와 `optionLabel` 목록을
 * 각자 나열했고, 실제로 다른 것은 머리말과 `missing` 한 칸뿐이었다. 목록에 없는 현재 값을
 * 항목으로 남기는 것은 사라진 스킬을 고른 트리거가 수정 화면에서 선택이 풀린 채로 보이지
 * 않게 하려는 것이라, 대상 쪽에는 예전처럼 켜지 않는다.
 */
function TriggerOptionSelect({
  label,
  value,
  options,
  missing = false,
  onChange,
}: {
  label: string;
  value: string;
  options: DocumentActionOption[];
  /** 지금 값이 목록에 없을 때 그 값을 항목으로 남긴다. */
  missing?: boolean;
  onChange: (value: string) => void;
}) {
  const { text } = useI18n();
  return (
    <TriggerSelect label={label} value={value} onChange={onChange}>
      <option value="">{text("선택", "Select")}</option>
      {missing && <option value={value}>{value} {text("· 목록에 없음", "· Not in list")}</option>}
      {options.map((item) => (
        <option value={item.id} key={item.id}>{optionLabel(item)}</option>
      ))}
    </TriggerSelect>
  );
}

/**
 * 주의 안내 상자. 스킬 없음·스킬 변경·복구가 어려운 영향 세 자리가 `제목 + 목록` 같은
 * 마크업을 각자 나열해, 한 자리의 모양을 고치면 나머지 둘이 조용히 어긋났다. 다른 것은
 * 제목과 줄 목록뿐이라 그 둘만 칸으로 남긴다.
 */
function TriggerNoteCallout({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <strong>{title}</strong>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>
  );
}

function actionLabel(action: DocumentTriggerAction, skills: DocumentActionOption[], text: (ko: string, en: string) => string): string {
  if (action.type === "runSchedule") return text("반복 요청", "Recurring schedule");
  if (action.type === "executeWorkflow") return text(`워크플로 v${action.approvedVersion}`, `Workflow v${action.approvedVersion}`);
  if (!action.skill) return text("새 채팅", "New chat");
  const skill = skills.find((item) => item.id === action.skill?.skillId);
  return text(`스킬 실행 · ${skill?.label ?? action.skill.skillId}`, `Run skill · ${skill?.label ?? action.skill.skillId}`);
}

const TRIGGER_STATUS_LABELS = {
  active: (text) => text("활성", "Active"),
  paused: (text) => text("일시중지", "Paused"),
  degraded: (text) => text("저하", "Degraded"),
  needsReview: (text) => text("재승인 필요", "Needs re-approval"),
  restricted: (text) => text("접근 제한", "Restricted"),
} satisfies Record<DocumentTriggerStatus, (text: (ko: string, en: string) => string) => string>;

/** 변경 종류 목록에서 특정 항목의 포함 여부를 토글한 새 배열을 반환한다. */
function toggleChangeKind(current: DocumentChangeKind[], target: DocumentChangeKind): DocumentChangeKind[] {
  return current.includes(target)
    ? current.filter((item) => item !== target)
    : [...current, target];
}

/**
 * 채팅·스킬 실행 상세 설정이 고르는 선택지 한 벌. 일곱 칸 모두 실제로 읽는 곳은 상세 설정
 * 입력부 하나뿐인데, 그 위의 액션 입력부가 같은 일곱 칸을 받아 그대로 넘기기만 해서
 * 부모 호출부·중간 서명·전달·자식 서명 네 자리에 같은 이름이 되풀이됐다. 칸이 하나 늘면
 * 네 자리를 함께 고쳐야 했다. 묶음 하나로 두어 중간 자리는 이름을 몰라도 되게 한다.
 */
interface TriggerChatChoices {
  selectableProviders: ProviderStatus[];
  providerAccounts: AccountSnapshot["accounts"];
  activeAccountId: string | null;
  providerOptions: ReturnType<typeof useProviderOptions>;
  models: ModelOption[];
  availableSkills: DocumentActionOption[];
  /** 저장된 스킬이 목록에서 사라졌는지. 사라진 값도 선택지에 남겨 보여 준다. */
  skillUnavailable: boolean;
}

/**
 * 액션 종류에 따른 상세 설정 입력부.
 * 채팅·스킬 실행인 경우 공급자·실행 계정·모델·런타임 설정을,
 * 반복 요청이나 시스템 워크플로 실행인 경우 대상 선택 드롭다운을 렌더링한다.
 */
function TriggerActionFields({
  draft,
  action: { options, choices },
  onPatch,
}: {
  draft: TriggerDraft;
  action: TriggerActionView;
  onPatch: (changes: Partial<TriggerDraft>) => void;
}) {
  const { text } = useI18n();
  const { actionKind, targetId, skillId } = draft;
  const chatAction = isChatActionKind(actionKind);

  return (
    <div className="document-trigger-grid">
      <TriggerSelect
        label={text("액션", "Action")}
        value={actionKind}
        onChange={(next) => onPatch({ actionKind: next, targetId: "", skillId: isSkillActionKind(next) ? skillId : "" })}
      >
        {ACTION_KINDS.map((kind) => (
          <option value={kind} key={kind}>{ACTION_KIND_SPECS[kind].label(text)}</option>
        ))}
      </TriggerSelect>
      {chatAction ? (
        <TriggerChatActionFields draft={draft} choices={choices} onPatch={onPatch} />
      ) : (
        <TriggerOptionSelect
          label={text("실행 대상", "Target")}
          value={targetId}
          options={options}
          onChange={(next) => onPatch({ targetId: next })}
        />
      )}
    </div>
  );
}

/** 새 채팅 요청 또는 스킬 실행 시 필요한 상세 설정(공급자·계정·스킬·프롬프트·런타임 설정·전체 접근 확인). */
function TriggerChatActionFields({
  draft,
  choices,
  onPatch,
}: {
  draft: TriggerDraft;
  choices: TriggerChatChoices;
  onPatch: (changes: Partial<TriggerDraft>) => void;
}) {
  const { text } = useI18n();
  const { providerOptions, models, availableSkills, skillUnavailable } = choices;
  const {
    actionKind,
    source,
    accountId,
    skillId,
    prompt,
    mode,
    approvalMode,
    model,
    reasoningEffort,
    fullAccessAcknowledged,
  } = draft;

  return (
    <>
      <TriggerChatIdentityFields
        source={source}
        accountId={accountId}
        choices={choices}
        onPatch={onPatch}
      />
      {isSkillActionKind(actionKind) && (
        <TriggerOptionSelect
          label={text("적용 스킬", "Applied skill")}
          value={skillId}
          options={availableSkills}
          missing={skillUnavailable}
          onChange={(next) => onPatch({ skillId: next })}
        />
      )}
      <label className="wide">
        {isSkillActionKind(actionKind) ? text("스킬과 함께 보낼 요청", "Prompt to send with skill") : text("채팅 요청", "Chat prompt")}
        <textarea
          value={prompt}
          onChange={(event) => onPatch({ prompt: event.target.value })}
          placeholder={text("변경 파일을 검토하고 요약해줘", "Review the changed files and provide a summary")}
        />
      </label>
      <RuntimeSettings
        source={source}
        mode={mode}
        onModeChange={(nextMode) => onPatch({ mode: nextMode, fullAccessAcknowledged: false })}
        approvalMode={approvalMode}
        onApprovalModeChange={(next) => onPatch({ approvalMode: next })}
        model={model}
        onModelChange={(next) => onPatch({ model: next })}
        catalog={providerOptions}
        recent={models.filter((item) => item.source === source)}
        reasoningEffort={reasoningEffort}
        onReasoningChange={(next) => onPatch({ reasoningEffort: next })}
        reasoningOptions={reasoningOptionsFor(providerOptions, model)}
        defaultEffort={defaultEffortFor(providerOptions, model)}
        compact
        unattended
      />
      {mode === "fullAccess" && (
        <label className="wide check-filter">
          <input
            type="checkbox"
            checked={fullAccessAcknowledged}
            onChange={(event) => onPatch({ fullAccessAcknowledged: event.target.checked })}
          />
          {text("전체 접근으로 자동 실행되면 등록 폴더 밖 명령도 무인으로 실행될 수 있음을 이해했습니다", "I understand that unattended execution with full access allows commands outside registered folders to be run automatically")}
        </label>
      )}
    </>
  );
}

function TriggerChatIdentityFields({
  source,
  accountId,
  choices: { selectableProviders, providerAccounts, activeAccountId },
  onPatch,
}: {
  source: ProviderId;
  accountId: string;
  choices: TriggerChatChoices;
  onPatch: (changes: Partial<TriggerDraft>) => void;
}) {
  const { text } = useI18n();
  // 활성 계정 이름은 언어별 문구가 함께 쓰는 값이다. 같은 목록을 두 번 찾지 않고 한 번만
  // 풀되, 목록에서 사라진 계정은 예전처럼 식별자를 표시한다.
  const activeAccountName = activeAccountId
    ? providerAccounts.find((account) => account.id === activeAccountId)?.displayName ?? activeAccountId
    : null;
  return (
    <>
      <TriggerSelect
        label={text("공급자", "Provider")}
        value={source}
        onChange={(next) => onPatch({ source: next, accountId: "", model: "", reasoningEffort: "", approvalMode: defaultApprovalMode(next) })}
      >
        {selectableProviders.map((provider) => (
          <option value={provider.provider} key={provider.provider}>
            {provider.displayName}{provider.cli.detected ? "" : text(" · CLI 미탐지", " · CLI not detected")}
          </option>
        ))}
      </TriggerSelect>
      <TriggerSelect label={text("실행 계정", "Execution account")} value={accountId} onChange={(next) => onPatch({ accountId: next })}>
        <option value="">
          {text("실행 시점 활성 계정", "Active account at execution time")}{activeAccountName !== null ? text(` · 지금은 ${activeAccountName}`, ` · Currently ${activeAccountName}`) : ""}
        </option>
        {providerAccounts.map((account) => (
          <option value={account.id} key={account.id}>
            {account.displayName}{account.authStatus === "ready" ? "" : text(" · 인증 필요", " · Needs authentication")}{account.id === activeAccountId ? text(" · 활성", " · Active") : ""}
          </option>
        ))}
      </TriggerSelect>
    </>
  );
}

/**
 * 스킬 실행 및 워크플로 실행 시 주의사항과 재승인 안내.
 * 액션 종류에 맞추어 스킬 고정·수정 여부 또는 워크플로 버전 승인 영향도를 표시한다.
 */
function TriggerActionNotes({
  actionKind,
  action: { derived: { skillUnavailable, skillChangedSinceApproval, selectedWorkflow } },
}: {
  actionKind: ActionKind;
  action: TriggerActionView;
}) {
  const { text } = useI18n();
  if (isSkillActionKind(actionKind)) {
    return (
      <div className="document-trigger-note">
        <p>
          {text(
            "등록 시점의 스킬 내용을 승인값으로 고정하고, 변경이 감지되면 그 본문을 지침으로 붙인 일반 채팅을 실행합니다. SKILL.md 안의 명령이나 스크립트를 직접 실행하지는 않습니다.",
            "Pins the skill content at the time of registration as the approved value, and starts a normal chat with its body attached as instructions when changes are detected. Does not directly execute commands or scripts inside SKILL.md."
          )}
        </p>
        <p>
          {text(
            "이후 스킬이 수정되면 실행을 멈추고 재승인 대기로 바뀝니다. 이 화면에서 트리거를 다시 저장할 때까지 실행하지 않고, 그 사이 변경 이벤트는 보존합니다.",
            "If the skill is modified later, execution is halted and status changes to pending re-approval. It will not run until the trigger is saved again in this screen, and change events are preserved in the meantime."
          )}
        </p>
        {skillUnavailable ? (
          <TriggerNoteCallout
            title={text("선택한 스킬을 찾을 수 없습니다", "Selected skill not found")}
            items={[text("공통 원본이 없거나 삭제된 스킬입니다. 스킬 메뉴에서 확인한 뒤 다시 선택하세요.", "The skill has no common origin or was deleted. Please check in the skills menu and select again.")]}
          />
        ) : skillChangedSinceApproval ? (
          <TriggerNoteCallout
            title={text("승인 당시와 스킬 내용이 다릅니다", "Skill content differs from approval time")}
            items={[text("지금 저장하면 현재 내용을 새 승인값으로 고정합니다. 변경 내용을 먼저 확인하세요.", "Saving now will pin the current content as the new approved value. Please review the changes first.")]}
          />
        ) : null}
      </div>
    );
  }

  if (actionKind === "executeWorkflow") {
    return (
      <div className="document-trigger-note">
        <p>
          {text("현재 워크플로 버전을 승인 버전으로 고정합니다. 이후 워크플로가 바뀌면 재승인 전까지 실행되지 않습니다.", "Pins the current workflow version as the approved version. If the workflow changes later, it will not run until re-approved.")}
        </p>
        {selectedWorkflow?.hardToRecoverEffects?.length ? (
          <TriggerNoteCallout title={text("복구가 어려운 영향", "Hard to recover effects")} items={selectedWorkflow.hardToRecoverEffects} />
        ) : null}
      </div>
    );
  }

  return null;
}
