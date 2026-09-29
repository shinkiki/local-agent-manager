/**
 * 대응표에 없는 한국어 문구의 영어 폴백 — 지금은 수량 표현 하나뿐이다.
 *
 * 되짚기(`staticUiText`)와는 방향부터 반대다. 저쪽은 화면에 그려진 값을 한국어 원문으로
 * **되돌리는** 일이고 여기는 대응표가 답을 주지 못한 한국어를 영어로 **내보내는** 일이라,
 * 보는 재료(번역표·역방향 표 대 문구 하나)도 답이 달라지는 이유(표의 출처 대 새로 다룰
 * 수량 단위)도 겹치지 않는다.
 *
 * 문구 **전체**가 수량 표현일 때만 바꾸고, 그 밖에는 원문을 그대로 돌려준다. 예전에는
 * `전체 ` → `total `처럼 문장 일부만 바꾸는 규칙이 있어, 대응표에 없는 문장이
 * "활성 0 / total 0 · 다음 실행 순"처럼 한국어·영어가 섞인 채 그려졌다(QA #51).
 * 반쯤 번역된 문장보다 한국어 그대로가 낫고, 그런 문장은 컴포넌트가 `text(ko, en)`으로
 * 온전한 영어 문장을 들고 있어야 한다.
 */

/** 완전한 수량 표현의 단위별 영어 접미사. 빈 접미사는 숫자만 남긴다는 뜻이다. */
const STATIC_COUNT_SUFFIX = {
  "개": "",
  "건": " items",
  "개 세션": " sessions",
} as const;

type StaticCountUnit = keyof typeof STATIC_COUNT_SUFFIX;

/**
 * 수량 표현을 알아보는 패턴. 단위 목록은 접미사 표에서 그대로 뽑는다 — 목록을 정규식에
 * 손으로 한 번 더 적으면 단위를 하나 늘릴 때 표만 채워도 빌드가 통과하고, 그 단위는
 * 영어에서 한국어 그대로 남는다(반대로 정규식에만 넣으면 접미사가 `undefined`로 붙는다).
 *
 * 긴 단위를 앞에 둔다. `개 세션`은 `개`로 시작하므로 짧은 쪽이 앞서면 그 자리에서 먼저
 * 걸리고, 지금은 끝 고정(`$`) 덕에 되짚어 맞지만 뒤에 다른 조각이 붙는 순간 조용히
 * 짧은 단위로 읽힌다. 단위는 한글뿐이라 정규식 특수문자로 새지 않는다.
 */
const STATIC_COUNT_PATTERN = new RegExp(
  `^(\\d[\\d,]*)(${Object.keys(STATIC_COUNT_SUFFIX).sort((left, right) => right.length - left.length).join("|")})$`,
);

export function staticEnglishFallback(core: string): string {
  const count = STATIC_COUNT_PATTERN.exec(core);
  if (!count) return core;
  const [, number, unit] = count;
  return `${number}${STATIC_COUNT_SUFFIX[unit as StaticCountUnit]}`;
}
