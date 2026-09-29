/**
 * 계정 표시 이름과 메모 편집기의 공통 뼈대. 두 편집기는 정규화 규칙과 길이 상한만
 * 다르고 초안 비교·길이 계산·저장 가능 판정·저장 후 닫기 규칙이 같았다. 같은 규칙이
 * 두 벌로 있으면 한쪽만 고쳐져 편집기끼리 어긋나므로 여기 한 벌만 둔다.
 */
import { countTextCharacters } from "./boundedText.ts";

/** 초안을 저장 형태로 정리한다. 빈 값은 사용자 지정 해제를 뜻하는 null이다. */
export type AccountTextNormalizer = (draft: string) => string | null;

/**
 * 편집기 하나를 뼈대에 태우는 데 필요한 전부. 정규화 규칙과 길이 상한은 언제나 짝으로
 * 움직이는데(상한은 정규화를 지난 값의 글자 수를 재는 기준이다) 두 값이 인자 자리에
 * 따로 놓여 있어, 초안 상태와 저장 두 곳에 같은 짝을 각자 적어 넣어야 했다. 한쪽만
 * 고치면 화면이 막지 않은 초안을 저장 쪽이 막거나 그 반대가 되는데, 둘 다 문자열 상한
 * 숫자라 형식 오류가 나지 않는다. 짝을 한 값으로 묶어 그 갈림을 없앤다.
 */
export interface AccountTextRules {
  normalize: AccountTextNormalizer;
  maxChars: number;
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
  rules: AccountTextRules,
): AccountTextDraftState {
  const value = rules.normalize(draft);
  // null은 비어 있는 초안이므로 0자로 센다.
  const length = countTextCharacters(value);
  const changed = value !== (saved ?? null);
  const tooLong = length > rules.maxChars;
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

/** 편집기가 값을 실제로 남기는 자리. 성공하면 null, 실패하면 오류 문구를 준다. */
export type AccountTextSave = (value: string | null) => Promise<string | null>;

/**
 * 편집기의 저장 동작. 보낼 값이 없으면 요청을 만들지 않고, 저장이 성공한 경우에만
 * 편집기를 닫는다.
 */
export async function submitAccountText(
  draft: string,
  saved: string | null,
  save: AccountTextSave,
  rules: AccountTextRules,
): Promise<AccountTextSubmitResult> {
  const state = accountTextDraftState(draft, saved, rules);
  if (!state.canSave) return { requested: false, close: false, error: null };
  const error = await save(state.value);
  return { requested: true, close: error === null, error };
}

/**
 * 공용 초안 상태에서 `clears`만 편집기의 이름으로 바꿔 단 모양. 나머지 항목은 공용
 * 선언 그대로다 — 항목을 다시 세어 적으면 공용 상태에 무엇이 늘어도 편집기가 따라가지
 * 않아, 화면이 보는 모양과 계산하는 모양이 갈린다.
 */
export type AccountTextDraftStateAs<ClearsAs extends string> =
  Omit<AccountTextDraftState, "clears"> & { [Key in ClearsAs]: boolean };

/** 편집기 하나가 쓰는 두 동작. 정규화 규칙·상한·`clears`의 이름이 이미 묶여 있다. */
export interface AccountTextEditor<ClearsAs extends string> {
  draftState(draft: string, saved: string | null): AccountTextDraftStateAs<ClearsAs>;
  submit(draft: string, saved: string | null, save: AccountTextSave): Promise<AccountTextSubmitResult>;
}

/**
 * 편집기 규격 하나로 두 동작을 함께 만든다. 표시 이름과 메모가 각자 뼈대를 부르며
 * 정규화 규칙과 상한을 두 번씩 적고, `clears`를 자기 이름으로 바꿔 다는 손걸음까지
 * 그대로 두 벌 갖고 있었다. 편집기가 늘 때 그 네 자리를 다시 쓰는 대신 규격 한 줄을
 * 더한다.
 */
export function accountTextEditor<ClearsAs extends string>(
  spec: AccountTextRules & { clearsAs: ClearsAs },
): AccountTextEditor<ClearsAs> {
  const rules: AccountTextRules = { normalize: spec.normalize, maxChars: spec.maxChars };
  return {
    draftState: (draft, saved) => {
      const { clears, ...state } = accountTextDraftState(draft, saved, rules);
      return { ...state, [spec.clearsAs]: clears } as AccountTextDraftStateAs<ClearsAs>;
    },
    submit: (draft, saved, save) => submitAccountText(draft, saved, save, rules),
  };
}
