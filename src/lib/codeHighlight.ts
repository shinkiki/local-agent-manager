import type { HighlighterCore, ThemedTokenWithVariants } from "@shikijs/core";
import { codeLanguageLoader, type CodeLanguage, type CodeLanguageId } from "./codeLanguages.ts";

// 하이라이터 한 벌의 수명 — 엔진·테마를 언제 띄우고 문법을 언제 불러오는지, 그리고 얼마나
// 큰 원문까지 다루는지. 어떤 언어를 아는지와 파일명에서 언어를 고르는 규칙은
// codeLanguages.ts가 맡는다. 화면들은 이 창구 하나만 알면 되므로 언어 조회는 여기서 다시
// 내보낸다.

export { codeLanguageForPath } from "./codeLanguages.ts";
export type { CodeLanguage };

export const MAX_HIGHLIGHT_CHARACTERS = 1_000_000;

let highlighterPromise: Promise<HighlighterCore> | null = null;
const languageLoadPromises = new Map<CodeLanguageId, Promise<void>>();

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
    pending = highlighter.loadLanguage(codeLanguageLoader(languageId)).catch((error) => {
      languageLoadPromises.delete(languageId);
      throw error;
    });
    languageLoadPromises.set(languageId, pending);
  }
  await pending;
}

/** 엔진과 두 테마를 병렬로 불러와 빈 언어 하이라이터 한 벌을 조립한다. */
async function createHighlighter(): Promise<HighlighterCore> {
  const [core, engine, darkTheme, lightTheme] = await Promise.all([
    import("@shikijs/core"),
    import("@shikijs/engine-javascript"),
    import("@shikijs/themes/github-dark"),
    import("@shikijs/themes/github-light"),
  ]);
  return core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(),
    themes: [darkTheme.default, lightTheme.default],
    langs: [],
  });
}

/** 하이라이터 생성 약속을 한 번만 만들고 모든 강조 요청이 함께 기다리게 한다. */
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighter();
  return highlighterPromise;
}
