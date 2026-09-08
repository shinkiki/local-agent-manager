import type { HighlighterCore, ThemedTokenWithVariants } from "@shikijs/core";

export interface CodeLanguage {
  id: CodeLanguageId;
  label: string;
}

type CodeLanguageId = keyof typeof LANGUAGES;

export const MAX_HIGHLIGHT_CHARACTERS = 1_000_000;

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

let highlighterPromise: Promise<HighlighterCore> | null = null;
const languageLoadPromises = new Map<CodeLanguageId, Promise<void>>();

export function codeLanguageForPath(path: string): CodeLanguage | null {
  const fileName = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const exact = FILE_NAME_LANGUAGES[fileName];
  if (exact) return exact;
  const extension = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".") + 1) : "";
  return EXTENSION_LANGUAGES[extension] ?? null;
}

export async function highlightCode(
  content: string,
  language: CodeLanguage,
): Promise<ThemedTokenWithVariants[][] | null> {
  if (content.length > MAX_HIGHLIGHT_CHARACTERS) return null;
  const highlighter = await getHighlighter();
  await ensureLanguageLoaded(highlighter, language.id);
  return highlighter.codeToTokensWithThemes(content, {
    lang: language.id,
    themes: { light: "github-light", dark: "github-dark" },
    tokenizeMaxLineLength: 20_000,
    tokenizeTimeLimit: 250,
  });
}

/** 같은 언어를 동시에 요청해도 한 번만 불러오고, 실패한 약속은 다음 시도가 다시 만들게 한다. */
async function ensureLanguageLoaded(highlighter: HighlighterCore, languageId: CodeLanguageId): Promise<void> {
  if (highlighter.getLoadedLanguages().includes(languageId)) return;
  let pending = languageLoadPromises.get(languageId);
  if (!pending) {
    pending = highlighter.loadLanguage(LANGUAGES[languageId].load).catch((error) => {
      languageLoadPromises.delete(languageId);
      throw error;
    });
    languageLoadPromises.set(languageId, pending);
  }
  await pending;
}

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("@shikijs/core"),
      import("@shikijs/engine-javascript"),
      import("@shikijs/themes/github-dark"),
      import("@shikijs/themes/github-light"),
    ]).then(([core, engine, darkTheme, lightTheme]) => core.createHighlighterCore({
      engine: engine.createJavaScriptRegexEngine(),
      themes: [darkTheme.default, lightTheme.default],
      langs: [],
    }));
  }
  return highlighterPromise;
}
