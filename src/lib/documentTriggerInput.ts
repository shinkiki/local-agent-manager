import type {
  ChatApprovalMode,
  ChatMode,
  DocumentActionOption,
  DocumentChangeKind,
  DocumentTrigger,
  DocumentTriggerAction,
  DocumentTriggerInput,
  ProviderId,
  ReasoningEffort,
} from "../types";
import { effectiveApprovalMode } from "./chatModes.ts";
import type { DocumentTriggerActionKind } from "./documentTriggerDraft.ts";

/*
 * 문서 자동화 패널(`DocumentAutomationPanel`)이 저장된 트리거와 화면 초안 사이를 오가는
 * 순수 변환 한 벌. 컴포넌트 안에 있어 시험이 닿지 않았는데, 기존 트리거를 다시 저장할 때
 * 켜짐·지연·냉각 값을 지우지 않는 규칙과, 스킬 실행과 새 채팅이 저장본에서 섞이지 않는
 * 규칙이 여기 모여 있다 — 한 줄이 빠지면 편집한 트리거가 조용히 기본값으로 되돌아간다.
 */

/**
 * 트리거 초안 한 벌. 같은 열여섯 칸을 초기화·수정 적재·저장 세 곳이 각각 나열하던 것을
 * 한 자료로 모아, 칸이 늘 때 세 곳을 함께 고쳐야 하는 부담을 없앤다.
 */
export interface DocumentTriggerDraft {
  name: string;
  rootId: string;
  include: string;
  exclude: string;
  changeKinds: DocumentChangeKind[];
  actionKind: DocumentTriggerActionKind;
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

/** 새 트리거가 다시 저장될 때 받는 실행 간격 기본값. 편집 중인 트리거는 자기 값을 지킨다. */
export const DEFAULT_TRIGGER_DEBOUNCE_MS = 2000;
export const DEFAULT_TRIGGER_COOLDOWN_MS = 30000;

/**
 * 액션 갈래가 어느 계열인지. 화면의 칸 노출과 저장 변환이 같은 판정을 읽으므로 한 표에 둔다 —
 * 갈래가 하나 늘면 이 표가 타입으로 빈 줄을 알린다.
 */
export const ACTION_KIND_TRAITS: Record<DocumentTriggerActionKind, { chat: boolean; skill: boolean }> = {
  runSchedule: { chat: false, skill: false },
  startChat: { chat: true, skill: false },
  runSkill: { chat: true, skill: true },
  executeWorkflow: { chat: false, skill: false },
};

/** 채팅 실행 계열인가. 공급자·실행 계정·모델·프롬프트 칸은 이 갈래에만 뜬다. */
export function isChatActionKind(kind: DocumentTriggerActionKind): boolean {
  return ACTION_KIND_TRAITS[kind].chat;
}

/** 스킬 실행 계열인가. 적용 스킬 칸과 재승인 안내는 이 갈래에만 뜬다. */
export function isSkillActionKind(kind: DocumentTriggerActionKind): boolean {
  return ACTION_KIND_TRAITS[kind].skill;
}

/** 줄 단위 패턴 입력을 다듬어 빈 줄을 뺀 목록으로 만든다. */
export function patternLines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

/**
 * 저장된 트리거를 편집 초안으로 적재한다. 채팅 계열이 아닌 액션에는 공급자·모델 칸이
 * 없으므로, 그 칸은 지금 화면에 있는 값을 그대로 둔다(예전 setter 나열과 같은 동작).
 * 전체 접근 확인은 저장본에 없으니 적재할 때마다 다시 받는다.
 */
export function draftFromTrigger(trigger: DocumentTrigger, current: DocumentTriggerDraft): DocumentTriggerDraft {
  const common: DocumentTriggerDraft = {
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
export function buildDocumentTriggerInput(
  draft: DocumentTriggerDraft,
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
    include: patternLines(include),
    exclude: patternLines(exclude),
    changeKinds,
    enabled: editing?.enabled ?? true,
    debounceMs: editing?.debounceMs ?? DEFAULT_TRIGGER_DEBOUNCE_MS,
    cooldownMs: editing?.cooldownMs ?? DEFAULT_TRIGGER_COOLDOWN_MS,
    action,
  };
}
