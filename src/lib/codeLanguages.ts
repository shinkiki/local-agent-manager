import { pathFileName } from "./crossPlatformPath.ts";

// 강조 표시가 아는 언어 한 벌 — 지원 언어와 그 문법 로더, 그리고 파일명에서 언어를 고르는
// 규칙. 하이라이터를 언제 띄우고 문법을 언제 불러오는지(codeHighlight.ts)와는 바뀌는 이유가
// 다르다. 언어를 하나 더하는 일은 이 파일 안에서 끝나고, 그때 싱글턴·약속 관리 코드를 함께
// 읽을 이유가 없다.

export interface CodeLanguage {
  id: CodeLanguageId;
  label: string;
}

export type CodeLanguageId = keyof typeof LANGUAGES;

/**
 * 지원 언어 한 벌. 표시 이름과 문법 로더를 한 항목에 둔다. 예전에는 로더 표와 이름 표가
 * 따로 있어 언어를 하나 더할 때마다 두 곳의 키를 손으로 맞춰야 했다.
 */
const LANGUAGES = {
  bash: { label: "Bash", load: () => import("@shikijs/langs/bash") },
  c: { label: "C", load: () => import("@shikijs/langs/c") },
  cmake: { label: "CMake", load: () => import("@shikijs/langs/cmake") },
  cpp: { label: "C++", load: () => import("@shikijs/langs/cpp") },
  csharp: { label: "C#", load: () => import("@shikijs/langs/csharp") },
  css: { label: "CSS", load: () => import("@shikijs/langs/css") },
  dart: { label: "Dart", load: () => import("@shikijs/langs/dart") },
  dockerfile: { label: "Dockerfile", load: () => import("@shikijs/langs/dockerfile") },
  dotenv: { label: "Environment", load: () => import("@shikijs/langs/dotenv") },
  go: { label: "Go", load: () => import("@shikijs/langs/go") },
  graphql: { label: "GraphQL", load: () => import("@shikijs/langs/graphql") },
  groovy: { label: "Groovy", load: () => import("@shikijs/langs/groovy") },
  html: { label: "HTML", load: () => import("@shikijs/langs/html") },
  java: { label: "Java", load: () => import("@shikijs/langs/java") },
  javascript: { label: "JavaScript", load: () => import("@shikijs/langs/javascript") },
  json: { label: "JSON", load: () => import("@shikijs/langs/json") },
  jsonc: { label: "JSON with Comments", load: () => import("@shikijs/langs/jsonc") },
  jsx: { label: "JSX", load: () => import("@shikijs/langs/jsx") },
  kotlin: { label: "Kotlin", load: () => import("@shikijs/langs/kotlin") },
  less: { label: "Less", load: () => import("@shikijs/langs/less") },
  lua: { label: "Lua", load: () => import("@shikijs/langs/lua") },
  make: { label: "Makefile", load: () => import("@shikijs/langs/make") },
  markdown: { label: "Markdown", load: () => import("@shikijs/langs/markdown") },
  php: { label: "PHP", load: () => import("@shikijs/langs/php") },
  powershell: { label: "PowerShell", load: () => import("@shikijs/langs/powershell") },
  prisma: { label: "Prisma", load: () => import("@shikijs/langs/prisma") },
  python: { label: "Python", load: () => import("@shikijs/langs/python") },
  ruby: { label: "Ruby", load: () => import("@shikijs/langs/ruby") },
  rust: { label: "Rust", load: () => import("@shikijs/langs/rust") },
  scss: { label: "SCSS", load: () => import("@shikijs/langs/scss") },
  sh: { label: "Shell", load: () => import("@shikijs/langs/sh") },
  sql: { label: "SQL", load: () => import("@shikijs/langs/sql") },
  svelte: { label: "Svelte", load: () => import("@shikijs/langs/svelte") },
  swift: { label: "Swift", load: () => import("@shikijs/langs/swift") },
  toml: { label: "TOML", load: () => import("@shikijs/langs/toml") },
  tsx: { label: "TSX", load: () => import("@shikijs/langs/tsx") },
  typescript: { label: "TypeScript", load: () => import("@shikijs/langs/typescript") },
  vue: { label: "Vue", load: () => import("@shikijs/langs/vue") },
  xml: { label: "XML", load: () => import("@shikijs/langs/xml") },
  yaml: { label: "YAML", load: () => import("@shikijs/langs/yaml") },
} as const satisfies Record<string, { label: string; load: () => Promise<unknown> }>;

/**
 * 파일명 조각 -> 언어 표. 값이 식별자 하나면 그 언어의 기본 이름을 그대로 쓰고,
 * 같은 언어를 다른 이름으로 보여야 하는 항목만 `[식별자, 표시 이름]`으로 적는다.
 */
type LanguageTableEntry = CodeLanguageId | readonly [CodeLanguageId, string];

const EXTENSION_LANGUAGE_IDS: Record<string, LanguageTableEntry> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cmake: "cmake",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  dart: "dart",
  env: "dotenv",
  go: "go",
  gql: "graphql",
  gradle: ["groovy", "Gradle"],
  graphql: "graphql",
  groovy: "groovy",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  json5: ["jsonc", "JSON5"],
  jsonc: "jsonc",
  jsx: "jsx",
  kts: "kotlin",
  kt: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  markdown: "markdown",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  prisma: "prisma",
  ps1: "powershell",
  py: "python",
  pyw: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "sh",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "sh",
};

const FILE_NAME_LANGUAGE_IDS: Record<string, LanguageTableEntry> = {
  "cmakelists.txt": "cmake",
  "dockerfile": "dockerfile",
  "makefile": "make",
};

/** 표를 조회용 언어 목록으로 편다. 모듈이 뜰 때 한 번만 만들어 조회마다 새 객체를 내지 않는다. */
function codeLanguageTable(table: Record<string, LanguageTableEntry>): Record<string, CodeLanguage> {
  const languages: Record<string, CodeLanguage> = {};
  for (const [key, entry] of Object.entries(table)) {
    languages[key] = typeof entry === "string"
      ? { id: entry, label: LANGUAGES[entry].label }
      : { id: entry[0], label: entry[1] };
  }
  return languages;
}

const EXTENSION_LANGUAGES = codeLanguageTable(EXTENSION_LANGUAGE_IDS);
const FILE_NAME_LANGUAGES = codeLanguageTable(FILE_NAME_LANGUAGE_IDS);

/**
 * 경로에서 언어 표를 조회할 두 키를 꺼낸다. 대소문자·마지막 점 처리를 언어 선택
 * 우선순위와 섞지 않아, 새 특수 파일명이나 확장자를 더해도 경로 해석 규칙은 이 단계
 * 하나만 유지하면 된다. 구분자를 맞춰 마지막 조각을 뽑는 일은 이 도메인과 무관한 문자열
 * 규칙이라 crossPlatformPath.ts가 맡는다.
 */
function languageLookupKeys(path: string): { fileName: string; extension: string } {
  const fileName = pathFileName(path).toLowerCase();
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "";
  return { fileName, extension };
}

/** 파일명이나 확장자로 언어를 고른다. 아는 언어가 없으면 null. */
export function codeLanguageForPath(path: string): CodeLanguage | null {
  const { fileName, extension } = languageLookupKeys(path);
  const exact = FILE_NAME_LANGUAGES[fileName];
  if (exact) return exact;
  return EXTENSION_LANGUAGES[extension] ?? null;
}

/**
 * 한 언어의 문법 로더. 하이라이터가 그대로 넘길 수 있도록 표에 적힌 모듈 타입을 그대로
 * 들고 나간다 — `() => Promise<unknown>`으로 넓히면 shiki가 받지 않는다.
 */
type CodeLanguageLoader = (typeof LANGUAGES)[CodeLanguageId]["load"];

/** 이 언어의 문법 로더. 실제로 언제 부를지는 하이라이터 쪽이 정한다. */
export function codeLanguageLoader(id: CodeLanguageId): CodeLanguageLoader {
  return LANGUAGES[id].load;
}
