/**
 * 새 통합 스킬 저장 폼의 입력 검증 — 이름과 설명이 서버에 닿기 전에 같은 규칙으로 걸러 낸다.
 *
 * 목록 화면의 표시 문구·정렬(`skillLibrary`)과는 서로 읽을 것이 없다. 저쪽은 이미 저장된
 * 항목을 어떤 말로 어떤 차례에 보여 줄지를 정하고, 여기는 아직 저장되지 않은 두 칸이 Rust
 * 쪽 `validate_skill_key`와 같은 규칙을 지키는지만 본다. 보는 재료(항목·게시 영수증 대
 * 입력 문자열)도, 답이 달라지는 이유(공급자 상태 대 서버 규칙)도 겹치지 않는다.
 *
 * 한 파일에 두면 상한 한 자리를 서버에 맞추러 들어온 사람이 게시 요약 집계를, 상태 칩을
 * 하나 늘리러 온 사람이 Windows 예약 이름 목록을 함께 읽게 된다.
 */
import { countTextCharacters } from "./boundedText.ts";
import type { LabelText, Translate } from "./skillLocaleText.ts";

/** 스킬 키 규칙. Rust 쪽 `validate_skill_key`와 같은 규칙을 화면에서 미리 알린다. */
const SKILL_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SKILL_KEY_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;
const WINDOWS_RESERVED = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

/**
 * 이름과 설명이 함께 지키는 두 가지 — 비어 있지 않을 것, 상한을 넘지 않을 것.
 *
 * 자리마다 다른 것은 상한 수와 문구뿐인데 판정까지 두 벌로 적혀 있었다. 그러면 무엇을
 * 재는지(다듬기 전 원문인지 다듬은 뒤인지, 글자인지 바이트인지)가 두 곳에 흩어져, 한쪽만
 * 고쳐도 빌드는 통과하고 같은 저장 폼의 두 칸이 다른 기준으로 길이를 재게 된다.
 */
interface TextLimitRule {
  maxChars: number;
  /** 빈 값일 때의 문구. */
  empty: LabelText;
  /** 상한을 넘었을 때의 문구. 상한 수는 이미 끼워 넣은 짝이다. */
  tooLong: LabelText;
}

/** 규칙에 걸리면 그 문구, 걸리지 않으면 `null`. 자리 고유의 규칙은 호출부가 이어서 본다. */
function textLimitError(value: string, rule: TextLimitRule, translate: Translate): string | null {
  const trimmed = value.trim();
  if (!trimmed) return translate(...rule.empty);
  // 서버는 `chars().count()`(코드 포인트)로 센다. `.length`(UTF-16 코드 단위)로 세면
  // 서로게이트 쌍이 섞인 설명에서 화면이 서버보다 먼저, 그것도 두 배로 거절한다 —
  // 규칙대로 적은 사용자가 저장 버튼을 열지 못한다. 세는 단위는 `boundedText` 한 벌이다.
  if (countTextCharacters(trimmed) > rule.maxChars) return translate(...rule.tooLong);
  return null;
}

const SKILL_KEY_LIMIT: TextLimitRule = {
  maxChars: MAX_SKILL_KEY_CHARS,
  empty: ["스킬 이름을 입력하세요.", "Enter a skill name."],
  tooLong: [
    `스킬 이름은 ${MAX_SKILL_KEY_CHARS}자까지 쓸 수 있습니다.`,
    `Skill names may be up to ${MAX_SKILL_KEY_CHARS} characters.`,
  ],
};

const SKILL_DESCRIPTION_LIMIT: TextLimitRule = {
  maxChars: MAX_DESCRIPTION_CHARS,
  empty: [
    "설명을 입력하세요. 공급자는 설명으로 스킬을 찾습니다.",
    "Enter a description. Providers discover skills by description.",
  ],
  tooLong: [
    `설명은 ${MAX_DESCRIPTION_CHARS}자까지 쓸 수 있습니다.`,
    `Descriptions may be up to ${MAX_DESCRIPTION_CHARS} characters.`,
  ],
};

/**
 * 새 통합 스킬 이름을 화면에서 먼저 검증한다. 서버가 최종 판정을 하지만, 같은
 * 규칙을 미리 알려 주면 사용자가 저장 실패로 되돌아오지 않는다.
 * 문제가 없으면 `null`을 돌려준다.
 */
export function skillKeyError(key: string, translate: Translate): string | null {
  const limit = textLimitError(key, SKILL_KEY_LIMIT, translate);
  if (limit) return limit;
  const trimmed = key.trim();
  if (!SKILL_KEY_PATTERN.test(trimmed)) {
    return translate(
      "영소문자·숫자·하이픈만 쓸 수 있고 영소문자나 숫자로 시작해야 합니다.",
      "Use only lowercase letters, digits, and hyphens, starting with a letter or digit.",
    );
  }
  if (trimmed.endsWith("-")) {
    return translate("하이픈으로 끝날 수 없습니다.", "It cannot end with a hyphen.");
  }
  if (WINDOWS_RESERVED.has(trimmed.split(".")[0])) {
    return translate(
      `'${trimmed}'은 Windows 예약 이름입니다.`,
      `'${trimmed}' is a reserved name on Windows.`,
    );
  }
  return null;
}

export function skillDescriptionError(
  description: string,
  translate: Translate,
): string | null {
  return textLimitError(description, SKILL_DESCRIPTION_LIMIT, translate);
}
