/**
 * 백엔드가 보낸 실패를 현재 언어의 문장으로 바꾸는 자리.
 *
 * 오류 배너 안은 정적 치환기가 건너뛴다(`i18nStaticUi.tsx`의 `.error-banner`) — 배너에는
 * 백엔드가 만든 동적 문자열(경로·ID·개수)이 섞여 있어 대응표가 맞힐 수 있는 문구가 아니기
 * 때문이다. 그래서 백엔드는 **무엇이 실패했는지**(안정 코드와 이름 붙은 파라미터)를 보내고,
 * 여기서 **그것을 어떻게 말할지**를 고른다. 구조와 코드 규칙은 Rust 쪽
 * `crates/agent-manager-core/src/app_error.rs`에 적혀 있다.
 *
 * 한국어 문장은 이 표에 두지 않는다. 백엔드가 이미 한국어 문장을 함께 보내므로, 한국어일
 * 때는 그것을 그대로 쓴다 — 같은 문장을 Rust와 여기 두 벌 두면 어긋나기만 한다. 이 표가
 * 가지는 것은 영어 정본뿐이고, 제3언어는 아직 영어로 떨어진다(번역 카탈로그는 한국어 원문을
 * 열쇠로 삼는데, 파라미터가 박힌 문장은 원문이 매번 달라 카탈로그에 실을 수 없다).
 */
import type { AppLocale } from "../types";

/** 코드 하나가 영어로 어떻게 읽히는지. `{이름}` 자리는 백엔드 파라미터로 채운다. */
const BACKEND_ERROR_EN: Record<string, string> = {
  SESSION_FOLDER_NOT_FOUND: "The session folder no longer exists.",
  SESSION_FOLDER_NOT_FOUND_BY_ID: "The session folder no longer exists: {id}",
  SESSION_FOLDER_NAME_REQUIRED: "Enter a folder name.",
  SESSION_FOLDER_NAME_TOO_LONG: "A folder name can be at most {max} characters.",
  SESSION_FOLDER_COLOR_INVALID: "A folder color must use the #RRGGBB format.",
  SESSION_FOLDER_DEPTH_EXCEEDED: "Folders can be nested up to {max} levels.",
  SESSION_FOLDER_PARENT_IS_SELF: "A folder cannot be moved inside itself.",
  SESSION_FOLDER_PARENT_IS_DESCENDANT: "A folder cannot be moved below one of its own subfolders.",
  SESSION_FOLDER_UNKNOWN_MOVE_DIRECTION: "Unknown folder move direction: {direction}. Use up or down.",
};

/** 백엔드 실패에 딸려 온 코드와 파라미터. 코드화되지 않은 실패에는 아예 없다. */
export interface BackendErrorCode {
  code: string;
  params: Record<string, string>;
}

/** 코드화된 백엔드 실패. `message`는 던지는 시점의 언어로 이미 정해져 있고,
 *  코드는 배너가 문의용 코드로 그대로 보여 줄 수 있게 남긴다. */
export class BackendCodedError extends Error {
  readonly code: string;
  readonly params: Record<string, string>;

  constructor(detail: BackendErrorCode, message: string) {
    super(message);
    this.name = "BackendCodedError";
    this.code = detail.code;
    this.params = detail.params;
  }
}

/** 알 수 없는 값을 문자열 키 객체로 좁힌다. 배열도 기존 응답 판정처럼 객체로 취급한다. */
function objectRecord(raw: unknown): Record<string, unknown> | null {
  return raw !== null && typeof raw === "object"
    ? raw as Record<string, unknown>
    : null;
}

/**
 * 응답 본문의 params 객체에서 문자열 값만 골라낸다. 값이 없거나 객체가 아니면 빈 객체다.
 */
function extractStringParams(raw: unknown): Record<string, string> {
  const source = objectRecord(raw);
  if (source === null) return {};
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") params[name] = value;
  }
  return params;
}

/**
 * 오류 응답 본문에서 코드와 파라미터를 꺼낸다. 두 칸이 없거나 모양이 다르면 null이고,
 * 부르는 쪽은 백엔드가 보낸 문장을 그대로 쓴다.
 */
export function backendErrorCodeFrom(payload: unknown): BackendErrorCode | null {
  const source = objectRecord(payload);
  if (source === null) return null;
  const code = source.code;
  if (typeof code !== "string" || code.length === 0) return null;
  return {
    code,
    params: extractStringParams(source.params),
  };
}

/** 템플릿의 `{이름}` 자리를 파라미터로 채운다. 값이 없는 자리는 그대로 둔다 —
 *  지워 버리면 "폴더는 단계까지만"처럼 뜻이 빠진 문장이 남는다. */
function fillTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}

/**
 * 이 실패를 지금 언어로 어떻게 말할지. 한국어이거나 코드에 영어 정본이 없으면 백엔드가
 * 보낸 문장을 그대로 쓴다 — 번역하지 못한 문장을 비워 두는 것보다 낫다.
 */
export function backendErrorMessage(
  locale: AppLocale,
  fallback: string,
  detail: BackendErrorCode | null,
): string {
  if (locale === "ko" || detail === null) return fallback;
  const template = BACKEND_ERROR_EN[detail.code];
  return template !== undefined ? fillTemplate(template, detail.params) : fallback;
}

/**
 * 던지는 시점에 문구를 고를 때 쓰는 현재 언어. 실패는 화면 어느 자리에서나 잡히고 대부분
 * 곧바로 문자열로 상태에 눌러앉으므로, 문구를 고르는 일도 그 시점에 끝나야 한다. 언어를
 * 바꾸면 `I18nProvider`가 이 값을 갱신한다.
 */
let activeLocale: AppLocale = "ko";

export function setBackendErrorLocale(locale: AppLocale): void {
  activeLocale = locale;
}

/**
 * 실패 응답 본문으로 던질 오류를 만든다. 코드가 실려 있으면 현재 언어로 문장을 고른
 * `BackendCodedError`, 없으면 평범한 `Error`다.
 */
export function backendError(payload: unknown, message: string): Error {
  const detail = backendErrorCodeFrom(payload);
  if (detail === null) return new Error(message);
  return new BackendCodedError(detail, backendErrorMessage(activeLocale, message, detail));
}
