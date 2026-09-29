import type { UiText } from "./i18nLocale.ts";

/**
 * 표에 적어 두는 두 언어 표기와, 그 표기를 지금 언어로 푸는 규칙.
 *
 * 카탈로그를 거치지 않고 자료 구조에 한글·영문을 나란히 적는 자리가 셋 있다 — 팝아웃 창의
 * 기본 제목, 화면별 도움말 문구, 페이싱 스케줄의 요일 이름. 셋 다 같은 모양(`{ ko, en }`)과
 * 같은 푸는 규칙(`text(ko, en)`)을 쓰면서 타입 이름(`PopoutTitle`·`LocalizedCopy`·
 * `WeekdayLabel`)과 푸는 함수를 각자 들고 있었다. 모양이 같은 세 벌이 따로 서 있으면
 * 한 자리가 규칙을 바꿔도(예: 비어 있는 영문을 한글로 떨어뜨리도록) 나머지 둘은 그대로
 * 남고, 같은 앱에서 어떤 문구는 새 규칙으로 어떤 문구는 옛 규칙으로 뜬다.
 *
 * 언어를 고르는 손잡이는 여기서도 `UiText`라는 정본 이름으로 받는다. 이 모듈이 정하는 것은
 * `en`이 `null`일 때 그 손잡이를 아예 거치지 않는다는 규칙뿐이고, 손잡이가 어떤 모양인지는
 * 그 정본이 정한다.
 */

/**
 * 한 문구의 두 언어 표기.
 *
 * `en`이 `null`이면 번역하지 않는 고유명이라는 뜻이고, 그때는 언어와 무관하게 `ko`를 그대로
 * 쓴다 — 번역 카탈로그를 거치면 제3언어에서 같은 철자의 다른 문구로 치환될 여지가 생긴다.
 */
export interface Phrase {
  ko: string;
  en: string | null;
}

/**
 * 영문 표기가 반드시 있는 문구. 고유명이 섞이지 않는 표(도움말 문구·요일 이름)는 이 쪽을
 * 써서 `en`을 빠뜨린 줄을 타입 검사가 잡게 한다. 푸는 규칙은 `Phrase`와 같은 한 벌이다.
 */
export interface TranslatedPhrase extends Phrase {
  en: string;
}

/** 두 언어 표기에서 지금 언어의 문구를 고른다. `en`이 `null`이면 손잡이를 부르지 않는다. */
export function phraseText(phrase: Phrase, text: UiText): string {
  return phrase.en === null ? phrase.ko : text(phrase.ko, phrase.en);
}
