import type { CypressRunStatus, CypressRunTest, CypressWorkspaceFile } from "../types";
import { errorText } from "./errorText.ts";

// 설정 → 자동화 탭의 Cypress 작업공간 패널이 쓰는 순수 함수. 화면 상태와 IPC를 섞지 않고
// 경로 검증·스펙 선별·요약 문구처럼 따로 검증할 수 있는 판단만 모았다.

/** 비밀정보 파일 이름. 백엔드도 같은 이름을 민감 파일로 다룬다. */
const SENSITIVE_FILE = "cypress.env.json";

/** 작업공간 안에서 사용자가 만들 수 없는 최상위 폴더. 모듈·실행 산출물 자리다. */
const RESERVED_TOP_DIRS = ["node_modules", "artifacts"];

/** `e2e/` 아래 Cypress 스펙 파일만 골라내는 규칙. */
const SPEC_PATTERN = /^e2e\/.+\.cy\.(js|ts)$/;

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** `cypress.env.json`(어느 폴더에 있어도 그 이름이면)을 민감 파일로 본다. */
export function isSensitiveCypressFile(path: string): boolean {
  const normalized = normalizeSlashes(path.trim());
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name === SENSITIVE_FILE;
}

/** `e2e/` 아래 `*.cy.js`·`*.cy.ts`만 경로순으로 돌려준다. */
export function specFiles(files: readonly CypressWorkspaceFile[]): CypressWorkspaceFile[] {
  return files
    .filter((file) => SPEC_PATTERN.test(normalizeSlashes(file.path)))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 작업공간 상대 경로가 파일 편집기에서 쓸 수 있는 값인지 검사한다.
 * 문제가 있으면 사용자에게 보일 한국어 문구, 없으면 null.
 */
export function validateWorkspaceRelativePath(path: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return "파일 경로를 입력하세요.";
  const normalized = normalizeSlashes(trimmed);
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("~")) {
    return "작업공간 안의 상대 경로만 쓸 수 있습니다.";
  }
  if (normalized.endsWith("/")) return "파일 이름으로 끝나야 합니다.";
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) return "상위 폴더(..)로 나갈 수 없습니다.";
  if (segments.some((segment) => segment === "" || segment === ".")) return "빈 폴더 이름이나 '.'은 쓸 수 없습니다.";
  if (RESERVED_TOP_DIRS.includes(segments[0])) return `${segments[0]}/ 아래는 직접 편집할 수 없습니다.`;
  return null;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest > 0 ? `${minutes}분 ${rest}초` : `${minutes}분`;
}

/** 실행 결과를 패널 한 줄에 보일 요약 문구로 만든다. */
export function summarizeCypressRun(status: CypressRunStatus): string {
  const target = status.spec ?? "전체 스펙";
  switch (status.state) {
    case "running":
      return `${target} 실행 중`;
    case "timedOut":
      return `${target} 시간 초과${status.message ? ` · ${status.message}` : ""}`;
    case "error":
      return `${target} 실행 오류${status.message ? ` · ${status.message}` : ""}`;
    default: {
      const summary = status.summary;
      if (!summary) return `${target} ${status.state === "passed" ? "통과" : "실패"}`;
      const counts = `통과 ${summary.passed} · 실패 ${summary.failed} · 보류 ${summary.pending}`;
      return `${target} ${status.state === "passed" ? "통과" : "실패"} · ${counts} · ${formatDuration(summary.durationMs)}`;
    }
  }
}

/** 실패한 테스트만 스펙 경로와 함께 평탄하게 뽑는다. */
export function failedCypressTests(status: CypressRunStatus): { spec: string; test: CypressRunTest }[] {
  if (!status.summary) return [];
  const failed: { spec: string; test: CypressRunTest }[] = [];
  for (const spec of status.summary.specs) {
    for (const test of spec.tests) {
      if (test.state === "failed") failed.push({ spec: spec.spec, test });
    }
  }
  return failed;
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
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Error("env JSON은 { \"KEY\": \"value\" } 형태의 객체여야 합니다.");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string") result[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") result[key] = String(value);
    else return new Error(`env 값 '${key}'은 문자열·숫자·불리언이어야 합니다.`);
  }
  return result;
}
