import type { ViewId } from "../types";
import type { UiText } from "./i18nLocale.ts";
import { NAVIGATION_HELP } from "./navigationHelpCopy.ts";
import { DEFAULT_NAVIGATION_ORDER, UNCONFIGURABLE_VIEWS } from "./navigationViews.ts";
import { phraseText } from "./phrase.ts";

/**
 * 도움말 팝오버가 쓰는 규칙 — 어느 화면에 도움말이 붙고, 본문을 어떻게 끊어 넘기는가.
 * 문구 자체는 `navigationHelpCopy`에 있고, 두 언어 표기를 지금 언어로 푸는 규칙은
 * `phrase`에 있다.
 *
 * 언어를 고르는 손잡이는 `UiText`라는 정본 이름으로 받는다. 같은 모양을 인자마다 다시
 * 적으면 손잡이에 칸이 생기는 날 이 파일이 그 목록에서 조용히 빠진다.
 */

/**
 * 도움말 본문을 문단으로 나눠 준다. 긴 안내가 줄바꿈 없이 한 덩어리로 붙으면 팝오버에서
 * 어디까지가 한 주제인지 읽히지 않으므로, 본문은 `\n`으로 문단을 끊어 적고 화면은 그 경계를
 * 그대로 그린다. 한 문단짜리 화면도 같은 경로를 타므로 호출하는 쪽에 분기가 생기지 않는다.
 *
 * 문단으로 나누기 전의 본문 한 덩어리는 내보내지 않는다. 화면이 쓰는 모양은 문단 목록
 * 하나뿐인데 덩어리째 내놓는 진입점이 함께 서 있으면, 문단 경계를 모르는 두 번째 경로가
 * 열린 채로 남는다 — 실제로 그 진입점을 부르는 것은 자기 테스트뿐이었다.
 */
export function navigationHelpParagraphs(view: ViewId, translate: UiText): string[] {
  return phraseText(NAVIGATION_HELP[view], translate).split("\n");
}

/** 본문 뒤에 강조로 붙는 문단. 없는 화면이 대부분이라 `null`이 정상이다. */
export function navigationHelpEmphasis(view: ViewId, translate: UiText): string | null {
  const emphasis = NAVIGATION_HELP[view].emphasis;
  return emphasis ? phraseText(emphasis, translate) : null;
}

/**
 * 도움말이 붙어야 하는 화면 전부. 이 목록을 `NAVIGATION_HELP`의 키에서 뽑지 않고 메뉴
 * 순서에서 만든다 — 화면이 늘었을 때 `Record<ViewId, …>`가 도움말 누락은 컴파일 시점에
 * 잡아 주지만 메뉴 순서 누락은 아무도 잡지 못했다. 순서를 기준으로 삼으면 새 화면이
 * `DEFAULT_NAVIGATION_ORDER`에 빠졌을 때 도움말 테스트가 먼저 걸린다. 키 나열 순서라는
 * 암묵적 규칙에 화면 순서가 기대던 것도 함께 사라진다.
 *
 * 순서를 정할 수 없는 화면도 여기서 다시 적지 않고 `UNCONFIGURABLE_VIEWS`를 그대로 붙인다 —
 * 도움말은 사용자 설정 대상 여부와 무관하게 모든 화면에 붙어야 하므로, 그 목록이 늘면
 * 도움말 목록도 함께 늘어야 한다.
 */
export function navigationHelpViews(): ViewId[] {
  return [...DEFAULT_NAVIGATION_ORDER, ...UNCONFIGURABLE_VIEWS];
}
