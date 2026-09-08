import {
  accountTextDraftState,
  accountTextLength,
  submitAccountText,
  type AccountTextSubmitResult,
} from "./accountTextDraft.ts";

/**
 * 사용자가 붙이는 계정 표시 이름의 최대 길이(문자 수). Rust Core의
 * `ACCOUNT_LABEL_MAX_CHARS`와 같은 값이라 저장 요청 전에 같은 기준으로 걸러 낸다.
 */
export const ACCOUNT_LABEL_MAX_CHARS = 60;

/**
 * 입력한 표시 이름을 저장 형태로 정리한다. 목록 한 줄에 들어가야 하므로 줄바꿈과
 * 연속 공백을 공백 하나로 접고, 빈 값은 사용자 지정 해제를 뜻하는 null로 바꾼다.
 * Core의 `normalize_account_label`과 같은 규칙이어야 한다.
 */
export function normalizeAccountLabel(draft: string): string | null {
  const collapsed = draft.split(/\s+/u).filter(Boolean).join(" ");
  return collapsed === "" ? null : collapsed;
}

/** 서로게이트 쌍이나 이모지를 한 글자로 세어 Rust의 문자 수 기준과 맞춘다. */
export function accountLabelLength(draft: string): number {
  return accountTextLength(draft, normalizeAccountLabel);
}

export interface AccountLabelDraftState {
  /** 저장 요청으로 보낼 값. 사용자 지정 해제는 null. */
  value: string | null;
  length: number;
  changed: boolean;
  tooLong: boolean;
  /** 저장하면 사용자 지정이 풀려 공급자 이름으로 돌아가는 상태. */
  restores: boolean;
  canSave: boolean;
}

/**
 * 편집 중인 표시 이름과 저장된 값을 비교해 저장 버튼 상태를 정한다. 값이 그대로면
 * 요청을 보내지 않고, 길이 제한을 넘으면 저장을 막아 백엔드 오류 전에 알린다.
 */
export function accountLabelDraftState(draft: string, saved: string | null): AccountLabelDraftState {
  const { clears, ...state } = accountTextDraftState(
    draft,
    saved,
    normalizeAccountLabel,
    ACCOUNT_LABEL_MAX_CHARS,
  );
  return { ...state, restores: clears };
}

export type AccountLabelSubmitResult = AccountTextSubmitResult;

/**
 * 표시 이름 편집기의 저장 동작. 보낼 값이 없으면 요청을 만들지 않고, 저장이 성공한
 * 경우에만 편집기를 닫는다. `save`는 성공하면 null, 실패하면 오류 문구를 준다.
 */
export function submitAccountLabel(
  draft: string,
  saved: string | null,
  save: (label: string | null) => Promise<string | null>,
): Promise<AccountLabelSubmitResult> {
  return submitAccountText(draft, saved, save, normalizeAccountLabel, ACCOUNT_LABEL_MAX_CHARS);
}
