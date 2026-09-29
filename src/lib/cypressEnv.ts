import { errorText } from "./errorText.ts";

// Cypress 작업공간 패널의 추가 환경변수(env) 입력란 처리 — JSON 텍스트 파싱과 값 정규화.
// 작업공간 파일 및 경로를 검사하는 규칙(cypressWorkspace.ts)과 바뀌는 이유가 다르므로
// 독립 모듈로 분리한다.

/**
 * env 객체 한 항목의 값을 문자열로 바꾼다.
 * 문자열은 그대로 두고 숫자나 불리언은 문자열로 변환하며, 그 외 타입은 Error를 낸다.
 */
function normalizeEnvValue(key: string, value: unknown): string | Error {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return new Error(`env 값 '${key}'은 문자열·숫자·불리언이어야 합니다.`);
}

/** JSON으로 읽은 값을 env 객체 모양으로 검증하고 각 값을 문자열로 맞춘다. */
function normalizeEnvObject(parsed: unknown): Record<string, string> | Error {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Error('env JSON은 { "KEY": "value" } 형태의 객체여야 합니다.');
  }
  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
    const value = normalizeEnvValue(key, rawValue);
    if (value instanceof Error) return value;
    result[key] = value;
  }
  return result;
}

/**
 * 추가 env 입력란의 JSON을 `Record<string, string>`으로 만든다. 빈 입력은 빈 객체.
 * 객체가 아니거나 값이 문자열·숫자·불리언이 아니면 Error를 돌려준다(던지지 않는다).
 */
export function parseEnvJsonText(text: string): Record<string, string> | Error {
  const trimmed = text.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    return new Error(`env JSON을 읽을 수 없습니다: ${errorText(cause)}`);
  }
  return normalizeEnvObject(parsed);
}
