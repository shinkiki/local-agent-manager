import {
  accountTextDraftState,
  accountTextLength,
  submitAccountText,
  type AccountTextSubmitResult,
} from "./accountTextDraft.ts";

/**
 * 계정 메모 최대 길이(문자 수). Rust Core의 `ACCOUNT_NOTE_MAX_CHARS`와 같은 값이라
 * 저장 요청 전에 같은 기준으로 걸러 낸다.
 */
export const ACCOUNT_NOTE_MAX_CHARS = 500;

/**
 * 입력한 메모를 저장 형태로 정리한다. 줄바꿈을 통일하고 앞뒤 공백을 제거하며,
 * 빈 값은 메모 삭제를 뜻하는 null로 바꾼다. Core의 정규화 규칙과 같아야 한다.
 */
export function normalizeAccountNote(draft: string): string | null {
  const trimmed = draft.replace(/\r\n/g, "\n").trim();
  return trimmed === "" ? null : trimmed;
}

/** 서로게이트 쌍이나 이모지를 한 글자로 세어 Rust의 문자 수 기준과 맞춘다. */
export function accountNoteLength(draft: string): number {
  return accountTextLength(draft, normalizeAccountNote);
}

export interface AccountNoteDraftState {
  /** 저장 요청으로 보낼 값. 메모 삭제는 null. */
  value: string | null;
  length: number;
  changed: boolean;
  tooLong: boolean;
  /** 저장하면 기존 메모가 지워지는 상태. 버튼 문구를 삭제로 바꾼다. */
  removes: boolean;
  canSave: boolean;
}

/**
 * 편집 중인 메모와 저장된 메모를 비교해 저장 버튼 상태를 정한다. 값이 그대로면
 * 요청을 보내지 않고, 길이 제한을 넘으면 저장을 막아 백엔드 오류 전에 알린다.
 */
export function accountNoteDraftState(draft: string, saved: string | null): AccountNoteDraftState {
  const { clears, ...state } = accountTextDraftState(
    draft,
    saved,
    normalizeAccountNote,
    ACCOUNT_NOTE_MAX_CHARS,
  );
  return { ...state, removes: clears };
}

export type AccountNoteSubmitResult = AccountTextSubmitResult;

/**
 * 메모 편집기의 저장 동작. 보낼 값이 없으면 요청을 만들지 않고, 저장이 성공한
 * 경우에만 편집기를 닫는다. `save`는 성공하면 null, 실패하면 오류 문구를 준다.
 */
export function submitAccountNote(
  draft: string,
  saved: string | null,
  save: (note: string | null) => Promise<string | null>,
): Promise<AccountNoteSubmitResult> {
  return submitAccountText(draft, saved, save, normalizeAccountNote, ACCOUNT_NOTE_MAX_CHARS);
}
