import type { HighlighterCore, ThemedTokenWithVariants } from "@shikijs/core";

export interface CodeLanguage {
  id: CodeLanguageId;
  label: string;
}

type CodeLanguageId = keyof typeof LANGUAGE_LOADERS;

const MAX_HIGHLIGHT_CHARACTERS = 1_000_000;

const LANGUAGE_LOADERS = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cmake: () => import("@shikijs/langs/cmake"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  dart: () => import("@shikijs/langs/dart"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  groovy: () => import("@shikijs/langs/groovy"),
  html: () => import("@shikijs/langs/html"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  jsx: () => import("@shikijs/langs/jsx"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  less: () => import("@shikijs/langs/less"),
  lua: () => import("@shikijs/langs/lua"),
  make: () => import("@shikijs/langs/make"),
  markdown: () => import("@shikijs/langs/markdown"),
  php: () => import("@shikijs/langs/php"),
  powershell: () => import("@shikijs/langs/powershell"),
  prisma: () => import("@shikijs/langs/prisma"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  rust: () => import("@shikijs/langs/rust"),
  scss: () => import("@shikijs/langs/scss"),
  sh: () => import("@shikijs/langs/sh"),
  sql: () => import("@shikijs/langs/sql"),
  svelte: () => import("@shikijs/langs/svelte"),
  swift: () => import("@shikijs/langs/swift"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  vue: () => import("@shikijs/langs/vue"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
} as const;

const EXTENSION_LANGUAGES: Record<string, CodeLanguage> = {
  bash: { id: "bash", label: "Bash" },
  c: { id: "c", label: "C" },
  cc: { id: "cpp", label: "C++" },
  cjs: { id: "javascript", label: "JavaScript" },
  cmake: { id: "cmake", label: "CMake" },
  cpp: { id: "cpp", label: "C++" },
  cs: { id: "csharp", label: "C#" },
  css: { id: "css", label: "CSS" },
  cts: { id: "typescript", label: "TypeScript" },
  cxx: { id: "cpp", label: "C++" },
  dart: { id: "dart", label: "Dart" },
  env: { id: "dotenv", label: "Environment" },
  go: { id: "go", label: "Go" },
  gql: { id: "graphql", label: "GraphQL" },
  gradle: { id: "groovy", label: "Gradle" },
  graphql: { id: "graphql", label: "GraphQL" },
  groovy: { id: "groovy", label: "Groovy" },
  h: { id: "c", label: "C" },
  hpp: { id: "cpp", label: "C++" },
  htm: { id: "html", label: "HTML" },
  html: { id: "html", label: "HTML" },
  java: { id: "java", label: "Java" },
  js: { id: "javascript", label: "JavaScript" },
  json: { id: "json", label: "JSON" },
  json5: { id: "jsonc", label: "JSON5" },
  jsonc: { id: "jsonc", label: "JSON with Comments" },
  jsx: { id: "jsx", label: "JSX" },
  kts: { id: "kotlin", label: "Kotlin" },
  kt: { id: "kotlin", label: "Kotlin" },
  less: { id: "less", label: "Less" },
  lua: { id: "lua", label: "Lua" },
  md: { id: "markdown", label: "Markdown" },
  markdown: { id: "markdown", label: "Markdown" },
  mjs: { id: "javascript", label: "JavaScript" },
  mts: { id: "typescript", label: "TypeScript" },
  php: { id: "php", label: "PHP" },
  prisma: { id: "prisma", label: "Prisma" },
  ps1: { id: "powershell", label: "PowerShell" },
  py: { id: "python", label: "Python" },
  pyw: { id: "python", label: "Python" },
  rb: { id: "ruby", label: "Ruby" },
  rs: { id: "rust", label: "Rust" },
  scss: { id: "scss", label: "SCSS" },
  sh: { id: "sh", label: "Shell" },
  sql: { id: "sql", label: "SQL" },
  svelte: { id: "svelte", label: "Svelte" },
  swift: { id: "swift", label: "Swift" },
  toml: { id: "toml", label: "TOML" },
  ts: { id: "typescript", label: "TypeScript" },
  tsx: { id: "tsx", label: "TSX" },
  vue: { id: "vue", label: "Vue" },
  xml: { id: "xml", label: "XML" },
  yaml: { id: "yaml", label: "YAML" },
  yml: { id: "yaml", label: "YAML" },
  zsh: { id: "sh", label: "Shell" },
};

const FILE_NAME_LANGUAGES: Record<string, CodeLanguage> = {
  "cmakelists.txt": { id: "cmake", label: "CMake" },
  "dockerfile": { id: "dockerfile", label: "Dockerfile" },
  "makefile": { id: "make", label: "Makefile" },
};

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
  if (!highlighter.getLoadedLanguages().includes(language.id)) {
    let pending = languageLoadPromises.get(language.id);
    if (!pending) {
      pending = highlighter.loadLanguage(LANGUAGE_LOADERS[language.id]).catch((error) => {
        languageLoadPromises.delete(language.id);
        throw error;
      });
      languageLoadPromises.set(language.id, pending);
    }
    await pending;
  }
  return highlighter.codeToTokensWithThemes(content, {
    lang: language.id,
    themes: { light: "github-light", dark: "github-dark" },
    tokenizeMaxLineLength: 20_000,
    tokenizeTimeLimit: 250,
  });
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
