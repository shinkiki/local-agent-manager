import type { CypressWorkspaceFile } from "../types";
import { cleanPathInput, normalizePathSlashes, pathFileName } from "./crossPlatformPath.ts";

// 설정 → 자동화 탭의 Cypress 작업공간 패널이 쓰는 순수 함수 중 작업공간 안의 파일을 다루는
// 규칙 — 어떤 경로를 만질 수 있고, 무엇이 스펙이며, 어떤 파일이 민감한지. 화면 상태와 IPC를
// 섞지 않아 따로 검증할 수 있다.
//
// 실행 한 건을 사람이 읽는 모양으로 바꾸는 일은 cypressRunSummary.ts가, 환경변수 JSON 파싱은
// cypressEnv.ts가, 경로 문자열을 판단 전에 손질하는 일(구분자 통일·공백 다듬기·마지막 조각)은
// crossPlatformPath.ts가 맡는다. 화면과 테스트가 창구 하나만 알면 되도록 앞의 둘은 여기서
// 다시 내보낸다(경로 손질은 도메인과 무관한 규칙이라 쓰는 쪽에서 직접 가져다 쓴다).
export { cypressArtifactLabel, failedCypressTests, summarizeCypressRun } from "./cypressRunSummary.ts";
export { parseEnvJsonText } from "./cypressEnv.ts";

/** 비밀정보 파일 이름. 백엔드도 같은 이름을 민감 파일로 다룬다. */
const SENSITIVE_FILE = "cypress.env.json";

/**
 * 작업공간 안에서 사용자가 만질 수 없는 최상위 폴더. 모듈·실행 산출물·VCS 내부 자리다.
 *
 * Rust `cypress_workspaces::DENIED_TOP_DIRS`와 같아야 하고 Rust 테스트로 묶는다. 한쪽에만
 * 있으면 화면은 통과시킨 경로를 백엔드가 거절해, 사용자는 다 적고 나서야 못 쓴다는 걸 안다.
 */
export const RESERVED_TOP_DIRS = ["node_modules", "artifacts", ".git"];

/**
 * "그 파일이 없다"는 실패의 접두사. Rust `cypress_workspaces::MISSING_FILE_PREFIX`와 같은
 * 문구를 여기서 다시 정의하고 Rust 테스트로 묶는다(`missingDirectory.ts`와 같은 방식).
 *
 * 파일 목록이 실패하거나 잘리면 편집기에 닿는 길은 "새 파일 경로" 입력란뿐인데, 거기 적은
 * 이름이 이미 디스크에 있는 파일일 수 있다. 이 문구로 갈라야 없는 파일만 빈 내용으로 열고,
 * 있는 파일은 내용을 읽어 연다 — 못 가르면 저장 순간 원본이 빈 파일이 된다.
 */
export const MISSING_FILE_PREFIX = "파일이 없습니다: ";

/** 실패 문구가 "그 파일이 없다"는 뜻인지. */
export function isMissingCypressFile(message: string): boolean {
  return message.includes(MISSING_FILE_PREFIX);
}

/**
 * Cypress 스펙 파일을 골라내는 규칙. 어느 깊이에 있든 `e2e/` 폴더 아래의 `*.cy.js`·`*.cy.ts`다.
 *
 * 루트에 `e2e/`를 두는 것은 앱이 제공하는 작업공간 템플릿의 배치일 뿐이고, 저장소를 그대로
 * 작업공간으로 등록하면 Cypress 기본값인 `cypress/e2e/` 아래에 있다. 루트만 보던 때는 그런
 * 작업공간에서 실행할 스펙을 하나도 고를 수 없었다.
 */
const SPEC_PATTERN = /(^|\/)e2e\/.+\.cy\.(js|ts)$/;

/** 경로가 Cypress 스펙 파일(`e2e/` 폴더 아래 `*.cy.js`·`*.cy.ts`)인지 확인한다. */
export function isCypressSpecFile(path: string): boolean {
  return SPEC_PATTERN.test(normalizePathSlashes(path));
}

/** `cypress.env.json`(어느 폴더에 있어도 그 이름이면)을 민감 파일로 본다. */
export function isSensitiveCypressFile(path: string): boolean {
  return pathFileName(cleanPathInput(path)) === SENSITIVE_FILE;
}

/** `e2e/` 폴더 아래 `*.cy.js`·`*.cy.ts`만 경로순으로 돌려준다. */
export function specFiles(files: readonly CypressWorkspaceFile[]): CypressWorkspaceFile[] {
  return files
    .filter((file) => isCypressSpecFile(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

interface WorkspacePathParts {
  normalized: string;
  segments: string[];
}

function isNonRelativePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.startsWith("~");
}

function hasParentTraversal(segments: readonly string[]): boolean {
  return segments.some((segment) => segment === "..");
}

function hasEmptyOrDotSegment(segments: readonly string[]): boolean {
  return segments.some((segment) => segment === "" || segment === ".");
}

function isReservedTopDir(dir: string): boolean {
  return RESERVED_TOP_DIRS.includes(dir);
}

/**
 * 상대 경로 거절 규칙. 먼저 걸린 문구를 보여주므로 배열 순서가 오류 우선순위다.
 *
 * 예전에는 전체 경로 검사와 조각 검사가 두 함수의 조건문에 나뉘어 있었다. 규칙을 더할 때
 * 어느 함수의 어느 위치에 넣어야 기존 문구 우선순위를 지키는지 두 구현을 함께 읽어야 했다.
 * 검사 대상을 한 모양으로 맞춰 두면 허용 범위를 바꾸지 않고도 순서를 이 한 벌에서 확인한다.
 */
const WORKSPACE_PATH_RULES: readonly ((path: WorkspacePathParts) => string | null)[] = [
  ({ normalized }) => (normalized ? null : "파일 경로를 입력하세요."),
  ({ normalized }) =>
    isNonRelativePath(normalized) ? "작업공간 안의 상대 경로만 쓸 수 있습니다." : null,
  ({ normalized }) => (normalized.endsWith("/") ? "파일 이름으로 끝나야 합니다." : null),
  ({ segments }) =>
    hasParentTraversal(segments) ? "상위 폴더(..)로 나갈 수 없습니다." : null,
  ({ segments }) =>
    hasEmptyOrDotSegment(segments) ? "빈 폴더 이름이나 '.'은 쓸 수 없습니다." : null,
  ({ segments }) =>
    isReservedTopDir(segments[0]) ? `${segments[0]}/ 아래는 직접 편집할 수 없습니다.` : null,
];

/**
 * 작업공간 상대 경로가 파일 편집기에서 쓸 수 있는 값인지 검사한다.
 * 문제가 있으면 사용자에게 보일 한국어 문구, 없으면 null.
 */
export function validateWorkspaceRelativePath(path: string): string | null {
  const normalized = cleanPathInput(path);
  const parts = { normalized, segments: normalized.split("/") };
  for (const rule of WORKSPACE_PATH_RULES) {
    const message = rule(parts);
    if (message) return message;
  }
  return null;
}

/**
 * 파일 편집기 목록을 검색어로 좁힌다. 대소문자를 가리지 않고 경로 어디든 들어 있으면 남기며,
 * 검색어가 비면 전부 남는다.
 *
 * 활성 파일은 검색어와 무관하게 남긴다 — 편집 중인 파일이 목록에서 사라지면 어느 파일을
 * 고치고 있는지 화면에 아무 표시가 없어진다.
 */
export function filterCypressFilePaths(paths: readonly string[], query: string, activePath: string | null = null): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...paths];
  return paths.filter((path) => path.toLowerCase().includes(needle) || path === activePath);
}
