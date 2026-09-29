/**
 * 지금 언어에서 어느 문구를 쓸지 고르는 규칙 한 벌.
 *
 * 규칙 자체는 한 문장이다 — 한국어면 원문, 영어면 영어 정본, 그 밖의 언어면 번역
 * 카탈로그에 실린 값을 쓰되 없으면 영어 정본으로 떨어진다. 그런데 이 세 갈래가
 * `i18n.tsx`의 `text(ko, en)`과 `i18nStaticUi.tsx`의 정적 치환에 각자 한 벌씩 적혀
 * 있었다. 두 자리가 다루는 문구는 같은 화면의 같은 언어이므로 갈래가 갈라지면
 * 컴포넌트가 선언한 문구와 DOM에서 되짚은 문구가 서로 다른 언어로 남는다 — 실제로
 * 제3언어에서 카탈로그가 비었을 때 무엇으로 떨어지는지를 두 자리에서 각각 확인해야
 * 했다.
 *
 * **영어 정본을 어디서 얻는지는 부르는 쪽이 계속 정한다.** `text(ko, en)`은 인자로
 * 받은 영어를 그대로 쓰고, 정적 치환은 대응표(`staticUiEnglish`)를 뒤진다. 여기 모으는
 * 것은 "언어에 따라 셋 중 무엇을 쓰는가"뿐이다.
 */
import type { AppLocale } from "../types";

/**
 * 한국어 원문과 영어 정본을 받아 지금 언어의 문구를 돌려주는 손잡이 — `useI18n().text`의
 * 모양이다.
 *
 * 이 모양은 화면 코드 전체에서 라벨을 만드는 보조 함수에 인자로 실려 다니는데, 서른 자리
 * 가까이가 `(ko: string, en: string) => string`을 그대로 다시 적고 있었고 이름을 붙인
 * 세 자리는 그 이름마저 `Text`·`TextPicker`·`TranslateFn`으로 갈라져 있었다. 이름이 없으면
 * 이 손잡이가 무엇인지는 인자 이름(`text`·`translate`·`pick`)으로만 짐작되고, 손잡이에
 * 칸을 더하는 날에는 같은 모양을 적은 자리를 하나씩 찾아 세어야 한다.
 *
 * 정본을 여기 두는 이유는 이 파일이 언어 갈래 규칙만 가진 순수 모듈이기 때문이다 —
 * React 문맥을 가진 `i18n.tsx`에 두면 타입 하나를 쓰려고 컴포넌트 모듈을 가리키게 된다.
 * `i18n.tsx`가 그대로 다시 내보내므로 화면 쪽 import 경로는 `lib/i18n` 그대로다.
 */
export type UiText = (ko: string, en: string) => string;

export function localizedUiText(
  locale: AppLocale,
  source: string,
  english: (source: string) => string,
  messages: Record<string, string>,
): string {
  if (locale === "ko") return source;
  if (locale === "en") return english(source);
  return messages[source] ?? english(source);
}
