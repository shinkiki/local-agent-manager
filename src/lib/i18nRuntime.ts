import type { AppLocale } from "../types";
import { localizedUiText } from "./i18nLocale.ts";
import { staticUiEnglish } from "./i18nStaticDictionary.ts";
import { readStoredText, writeStoredText } from "./storedText.ts";

interface RuntimeLocale {
  locale: AppLocale;
  messages: Record<string, string>;
}

let active: RuntimeLocale = { locale: "ko", messages: {} };
const STORAGE_KEY = "agent-manager.ui-locale";

/** 저장 캐시 한 덩이를 런타임 언어로 읽는다. 손상되었거나 필요한 칸이 없으면 무시한다. */
export function parseStoredRuntimeLocale(raw: string | null): RuntimeLocale | null {
  try {
    const stored = JSON.parse(raw ?? "null") as RuntimeLocale | null;
    if (stored && typeof stored.locale === "string" && stored.messages && typeof stored.messages === "object") {
      return stored;
    }
  } catch {
    // 손상된 캐시는 백엔드 설정을 읽으면 곧 교체되므로 무시한다.
  }
  return null;
}

if (typeof window !== "undefined") {
  // 쿠키·저장소를 막은 브라우저는 localStorage 접근 자체가 SecurityError를 던진다. 모듈을
  // 읽는 시점이라 그 예외가 셸 전체의 기동을 막았다(qa23). 저장소 읽기는 실패해도 된다.
  active = parseStoredRuntimeLocale(readStoredText(STORAGE_KEY)) ?? active;
}

/** 런타임 언어의 선택적 브라우저 캐시. 캐시 실패는 현재 상태를 되돌리지 않는다. */
function cacheRuntimeLocale(value: RuntimeLocale): void {
  writeStoredText(STORAGE_KEY, JSON.stringify(value));
}

/** React 문맥 밖(OS 알림·창 셸)에서도 화면과 같은 언어 선택 규칙을 쓴다. */
export function setRuntimeLocale(locale: AppLocale, messages: Record<string, string>): void {
  active = { locale, messages };
  cacheRuntimeLocale(active);
}

export function runtimeLocale(): RuntimeLocale {
  return active;
}

export function runtimeText(ko: string, en: string): string {
  return localizedUiText(active.locale, ko, () => en, active.messages);
}

/**
 * 백엔드가 한국어로 보낸 라벨 하나를 화면 언어로. 영어 짝을 코드가 모르는 자리(실행설정
 * 선택지, 사용량 창 이름, 승인 카드 제목)라 대응표에서 찾는다.
 *
 * `" · "`로 이어 붙인 문구는 **토막마다** 찾는다. 라벨 하나는 DOM 치환기가 바꿔 주지만,
 * 이어 붙인 한 줄("작업공간 쓰기 · 직접 승인")은 대응표에 통째로 없어 한국어로 남았다.
 */
export function runtimeCatalogText(source: string): string {
  if (active.locale === "ko") return source;
  const whole = localizedUiText(active.locale, source, staticUiEnglish, active.messages);
  if (whole !== source || !source.includes(" · ")) return whole;
  return source.split(" · ").map((part) => localizedUiText(active.locale, part, staticUiEnglish, active.messages)).join(" · ");
}
