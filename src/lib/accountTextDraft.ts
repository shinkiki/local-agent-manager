/**
 * 계정 표시 이름과 메모 편집기의 공통 뼈대. 두 편집기는 정규화 규칙과 길이 상한만
 * 다르고 초안 비교·길이 계산·저장 가능 판정·저장 후 닫기 규칙이 같았다. 같은 규칙이
 * 두 벌로 있으면 한쪽만 고쳐져 편집기끼리 어긋나므로 여기 한 벌만 둔다.
 */

/** 초안을 저장 형태로 정리한다. 빈 값은 사용자 지정 해제를 뜻하는 null이다. */
export type AccountTextNormalizer = (draft: string) => string | null;

/** 서로게이트 쌍이나 이모지를 한 글자로 세어 Rust의 문자 수 기준과 맞춘다. */
export function accountTextLength(draft: string, normalize: AccountTextNormalizer): number {
  const normalized = normalize(draft);
  return normalized ? [...normalized].length : 0;
}

export interface AccountTextDraftState {
  /** 저장 요청으로 보낼 값. 값 비우기는 null. */
  value: string | null;
  length: number;
  changed: boolean;
  tooLong: boolean;
  /** 저장하면 저장돼 있던 값이 사라지는 상태. */
  clears: boolean;
  canSave: boolean;
}

/**
 * 편집 중인 값과 저장된 값을 비교해 저장 버튼 상태를 정한다. 값이 그대로면 요청을
 * 보내지 않고, 길이 제한을 넘으면 저장을 막아 백엔드 오류 전에 알린다.
 */
export function accountTextDraftState(
  draft: string,
  saved: string | null,
  normalize: AccountTextNormalizer,
  maxChars: number,
): AccountTextDraftState {
  const value = normalize(draft);
  const length = value ? [...value].length : 0;
  const changed = value !== (saved ?? null);
  const tooLong = length > maxChars;
  return {
    value,
    length,
    changed,
    tooLong,
    clears: value === null && saved !== null,
    canSave: changed && !tooLong,
  };
}

export interface AccountTextSubmitResult {
  /** 저장 요청을 실제로 보냈는지. 변경이 없거나 길이 초과면 보내지 않는다. */
  requested: boolean;
  /** 편집기를 닫아도 되는지. 저장에 실패하면 입력을 잃지 않도록 열어 둔다. */
  close: boolean;
  /** 저장 실패 원인. 편집기 안에서 그대로 보여 준다. */
  error: string | null;
}

/**
 * 편집기의 저장 동작. 보낼 값이 없으면 요청을 만들지 않고, 저장이 성공한 경우에만
 * 편집기를 닫는다. `save`는 성공하면 null, 실패하면 오류 문구를 준다.
 */
export async function submitAccountText(
  draft: string,
  saved: string | null,
  save: (value: string | null) => Promise<string | null>,
  normalize: AccountTextNormalizer,
  maxChars: number,
): Promise<AccountTextSubmitResult> {
  const state = accountTextDraftState(draft, saved, normalize, maxChars);
  if (!state.canSave) return { requested: false, close: false, error: null };
  const error = await save(state.value);
  return { requested: true, close: error === null, error };
}
