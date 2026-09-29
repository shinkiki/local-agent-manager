/**
 * 문서 자동화 트리거 편집기가 저장 전에 거치는 유효성 검사.
 *
 * `documentWorkspace.ts`는 이름 그대로 "문서 작업 환경"을 다루는 곳인데, 폴더 쪽 목록을
 * 합치는 캐시 규칙과 이 검사가 한 파일에 얹혀 있었다. 둘은 바뀌는 이유가 전혀 다르다 —
 * 앞쪽은 백엔드가 쪽을 나눠 주는 방식이 바뀔 때, 이쪽은 트리거가 고를 수 있는 액션과
 * 그 액션이 요구하는 승인값이 늘 때 바뀐다. 실제로 쓰는 화면도 갈라져 있어서,
 * `DocumentTreePane`·`DocumentFilePane`은 캐시 쪽만, `DocumentAutomationPanel`은 검사
 * 쪽만 가져다 쓴다. 한 파일에 두면 액션을 하나 늘릴 때마다 폴더 캐시를 지나야 했다.
 *
 * 여기 있는 이름은 `documentWorkspace.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는
 * 예전 그대로 `lib/documentWorkspace`다.
 *
 * 문제 문구는 그대로 화면에 뜨므로 로케일을 따라야 한다. 여기서 로케일을 읽지 않고 부르는
 * 쪽이 쥔 `text` 손잡이를 받아 쓴다 — 검사 규칙은 화면 상태에 기대지 않는다.
 */

import type { UiText } from "./i18nLocale";

/**
 * 화면에 보여주는 액션 구분. 저장 형식에서 `runSkill`은 스킬을 고정한 `startChat`이지만,
 * 승인 규칙이 다르므로 편집 중에는 따로 다룬다.
 */
export type DocumentTriggerActionKind = "runSchedule" | "startChat" | "runSkill" | "executeWorkflow";

export interface DocumentTriggerDraftLike {
  name: string;
  /** 없으면 검사하지 않는다. 폴더 선택이 있는 편집기만 넘긴다. */
  rootId?: string | null;
  changeKinds: readonly string[];
  actionKind: DocumentTriggerActionKind | null;
  actionTargetId?: string | null;
  prompt?: string | null;
  /** 스킬 실행에서 고른 스킬 키. */
  skillId?: string | null;
  /** 고른 스킬의 현재 내용 지문. 공통 원본 목록에서 찾지 못하면 없다. */
  skillContentDigest?: string | null;
  /** 고정할 워크플로 승인 버전. 카탈로그에서 읽지 못하면 없다. */
  workflowApprovedVersion?: number | null;
  /** 전체 접근으로 자동 실행된다는 안내를 확인했는지. */
  fullAccessMode?: boolean;
  fullAccessAcknowledged?: boolean;
}

/** 선택값과 요청값이 공백이 아닌 실제 텍스트를 담았는지 한 규칙으로 판정한다. */
function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

/** 채팅 계열 액션이 공유하는 요청 내용·전체 접근 확인을 검사한다. */
function validateChatActionErrors(
  draft: DocumentTriggerDraftLike,
  text: UiText,
  actionErrors: readonly string[] = [],
): string[] {
  const errors: string[] = [];
  if (!hasText(draft.prompt)) errors.push(text("새 채팅 요청 내용을 입력하세요.", "Enter the request for the new chat."));
  errors.push(...actionErrors);
  if (draft.fullAccessMode && !draft.fullAccessAcknowledged) {
    errors.push(text("전체 접근 자동 실행 안내를 확인하세요.", "Acknowledge the full-access automatic execution notice."));
  }
  return errors;
}

/** 스킬 액션의 고정 승인값을 검사한 뒤 채팅 계열 공통 검사를 잇는다. */
function validateSkillActionErrors(draft: DocumentTriggerDraftLike, text: UiText): string[] {
  let skillError: string | null = null;
  if (!hasText(draft.skillId)) {
    skillError = text("적용할 스킬을 선택하세요.", "Select the skill to apply.");
  } else if (!hasText(draft.skillContentDigest)) {
    skillError = text(
      "선택한 스킬의 현재 내용을 공통 원본에서 확인할 수 없어 승인값으로 고정할 수 없습니다.",
      "The selected skill's current content cannot be read from the shared source, so it cannot be pinned as the approved value.",
    );
  }
  return validateChatActionErrors(draft, text, skillError ? [skillError] : []);
}

/** 저장된 반복 요청·워크플로처럼 대상 식별자가 필요한 액션을 검사한다. */
function validateTargetActionErrors(draft: DocumentTriggerDraftLike, text: UiText): string[] {
  if (!hasText(draft.actionTargetId)) {
    return [
      draft.actionKind === "runSchedule"
        ? text("실행할 반복 요청을 선택하세요.", "Select the recurring request to run.")
        : text("실행할 시스템 워크플로를 선택하세요.", "Select the system workflow to execute."),
    ];
  }

  if (draft.actionKind === "executeWorkflow" && !((draft.workflowApprovedVersion ?? 0) >= 1)) {
    return [text("승인할 워크플로 버전을 확인할 수 없습니다.", "The workflow version to approve cannot be determined.")];
  }
  return [];
}

/** 액션 종류별 유효성 검사. 액션이 없거나 세부 대상·승인값이 누락되었는지 검사한다. */
function validateTriggerActionErrors(draft: DocumentTriggerDraftLike, text: UiText): string[] {
  if (!draft.actionKind) {
    return [text("실행할 액션을 선택하세요.", "Select the action to run.")];
  }
  switch (draft.actionKind) {
    case "startChat":
      return validateChatActionErrors(draft, text);
    case "runSkill":
      return validateSkillActionErrors(draft, text);
    case "runSchedule":
    case "executeWorkflow":
      return validateTargetActionErrors(draft, text);
  }
}

/**
 * Frontend validation keeps the editor actionable; the Core remains authoritative. Target IDs
 * are required for schedule/workflow actions, while a new chat needs a non-empty prompt.
 * 스킬 실행은 고른 스킬의 현재 지문까지 있어야 저장할 수 있다. 지문이 곧 승인값이고,
 * 그 값 없이 저장하면 실행 시점에 무엇을 승인했는지 대조할 수 없기 때문이다.
 */
export function validateDocumentTriggerDraft(draft: DocumentTriggerDraftLike, text: UiText): string[] {
  const errors: string[] = [];
  if (!hasText(draft.name)) errors.push(text("트리거 이름을 입력하세요.", "Enter a trigger name."));
  if (draft.rootId !== undefined && !hasText(draft.rootId)) {
    errors.push(text("감시할 등록 폴더를 선택하세요.", "Select the registered folder to watch."));
  }
  if (draft.changeKinds.length === 0) {
    errors.push(text("감지할 변경 종류를 하나 이상 선택하세요.", "Select at least one change kind to detect."));
  }
  errors.push(...validateTriggerActionErrors(draft, text));
  return errors;
}
