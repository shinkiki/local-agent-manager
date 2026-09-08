/**
 * 컴포넌트가 부르는 언어 문맥. `text(ko, en)` 한 짝과 현재 언어만 다룬다 — 한국어
 * 리터럴을 DOM에서 되짚어 바꾸는 정적 치환기와 카탈로그 수집은 `i18nStaticUi.tsx`가
 * 가진다.
 *
 * `getUiTranslationCatalog`는 예전 자리를 유지하려 여기서 그대로 다시 내보낸다.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { AppLocale } from "../types";
import { registerUiEnglish, StaticUiLocalization } from "./i18nStaticUi";

export { getUiTranslationCatalog } from "./i18nStaticUi";

interface I18nValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale, messages?: Record<string, string>) => void;
  text: (ko: string, en: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<{ locale: AppLocale; messages: Record<string, string> }>({ locale: "ko", messages: {} });
  const setLocale = useCallback((locale: AppLocale, messages: Record<string, string> = {}) => {
    setActive((current) => current.locale === locale && sameMessages(current.messages, messages) ? current : { locale, messages });
  }, []);
  const value = useMemo<I18nValue>(() => ({
    locale: active.locale,
    setLocale,
    text: (ko, en) => {
      registerUiEnglish(ko, en);
      if (active.locale === "ko") return ko;
      if (active.locale === "en") return en;
      return active.messages[ko] ?? en;
    },
  }), [active, setLocale]);
  return <I18nContext.Provider value={value}><StaticUiLocalization locale={active.locale} messages={active.messages} />{children}</I18nContext.Provider>;
}

function sameMessages(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("I18nProvider is missing");
  return value;
}

