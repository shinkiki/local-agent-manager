/**
 * 채팅 비밀값 이름 규칙과 남은 시간 계산. 백엔드와 같은 규칙(`^[A-Z][A-Z0-9_]{0,63}$`)을
 * 화면에서도 미리 적용해, 서버 왕복 뒤에야 "이름이 틀렸다"를 듣는 일을 없앤다. 값 자체는
 * 이 모듈이 다루지 않는다 — 값은 입력칸에서 곧장 IPC로 나가고, 화면 상태에 남지 않는다.
 */

export const CHAT_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const CHAT_SECRET_NAME_MAX = 64;
export const CHAT_SECRET_PURPOSE_MAX = 200;
export const CHAT_SECRET_VALUE_MAX = 4096;

/** 입력 중인 이름을 규칙 쪽으로 끌어당긴다 — 대문자화, 공백·하이픈은 밑줄로, 앞뒤 여백 제거. */
export function normalizeChatSecretName(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, "_").slice(0, CHAT_SECRET_NAME_MAX);
}

export type ChatSecretNameIssue = "empty" | "leadingLetter" | "charset" | "tooLong";

/** 이름이 규칙에 어긋나면 그 이유 하나, 맞으면 null. 문구는 부르는 쪽이 언어에 맞게 고른다. */
export function chatSecretNameIssue(name: string): ChatSecretNameIssue | null {
  if (name.length === 0) return "empty";
  if (name.length > CHAT_SECRET_NAME_MAX) return "tooLong";
  if (!/^[A-Z]/.test(name)) return "leadingLetter";
  if (!CHAT_SECRET_NAME_PATTERN.test(name)) return "charset";
  return null;
}

export type ChatSecretFieldIssue = "empty" | "tooLong";

export function chatSecretPurposeIssue(purpose: string): ChatSecretFieldIssue | null {
  const trimmed = purpose.trim();
  if (trimmed.length === 0) return "empty";
  if (trimmed.length > CHAT_SECRET_PURPOSE_MAX) return "tooLong";
  return null;
}

export function chatSecretValueIssue(value: string): ChatSecretFieldIssue | null {
  if (value.length === 0) return "empty";
  if (value.length > CHAT_SECRET_VALUE_MAX) return "tooLong";
  return null;
}

/** 만료까지 남은 분. 지났으면 0, 1분 미만은 1로 올린다 — "0분 남음"이 아직 살아 있는 값에 붙지 않게. */
export function chatSecretMinutesLeft(expiresAt: number, now: number): number {
  const remaining = expiresAt - now;
  if (remaining <= 0) return 0;
  return Math.max(1, Math.ceil(remaining / 60_000));
}
