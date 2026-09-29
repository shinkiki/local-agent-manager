import type { AppLocale } from "../types";
import { localizedUiText } from "./i18nLocale.ts";

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
  active = parseStoredRuntimeLocale(window.localStorage.getItem(STORAGE_KEY)) ?? active;
}

/** 런타임 언어의 선택적 브라우저 캐시. 캐시 실패는 현재 상태를 되돌리지 않는다. */
function cacheRuntimeLocale(value: RuntimeLocale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 캐시는 선택 사항이다.
  }
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
