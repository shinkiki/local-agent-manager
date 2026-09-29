/**
 * 컴포넌트가 부르는 언어 문맥. `text(ko, en)` 한 짝과 현재 언어만 다룬다 — 한국어
 * 리터럴을 DOM에서 되짚어 바꾸는 정적 치환기와 카탈로그 수집은 `i18nStaticUi.tsx`가,
 * 한국어 ↔ 영어 대응표는 `i18nStaticDictionary.ts`가 가진다.
 *
 * `getUiTranslationCatalog`는 예전 자리를 유지하려 여기서 그대로 다시 내보낸다.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppLocale } from "../types";
import { setBackendErrorLocale } from "./backendErrors";
import { localizedUiText, type UiText } from "./i18nLocale";
import { runtimeLocale, runtimeText, setRuntimeLocale } from "./i18nRuntime";
import { setTrayLocale } from "./ipcHost";
import { registerUiEnglish } from "./i18nStaticDictionary";
import { StaticUiLocalization } from "./i18nStaticUi";

export { getUiTranslationCatalog } from "./i18nStaticUi";
/** 라벨 보조 함수에 `text`를 실어 나르는 자리가 쓰는 이름. 정본은 `i18nLocale.ts`에 있다. */
export type { UiText } from "./i18nLocale";

interface I18nValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale, messages?: Record<string, string>) => void;
  text: UiText;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<{ locale: AppLocale; messages: Record<string, string> }>(runtimeLocale);
  const setLocale = useCallback((locale: AppLocale, messages: Record<string, string> = {}) => {
    setRuntimeLocale(locale, messages);
    setActive((current) => current.locale === locale && sameMessages(current.messages, messages) ? current : { locale, messages });
  }, []);
  // 백엔드 실패는 화면 어느 자리에서나 잡혀 곧바로 문자열이 되므로, 문구를 고르는 쪽이
  // 현재 언어를 문맥 없이도 알아야 한다(`backendErrors.ts`).
  useEffect(() => {
    setBackendErrorLocale(active.locale);
    document.documentElement.lang = active.locale;
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute(
      "content",
      runtimeText(
        "Claude Code, OpenAI Codex, Google Antigravity 로컬 세션 관리자",
        "Local session manager for Claude Code, OpenAI Codex, and Google Antigravity",
      ),
    );
    void setTrayLocale(active.locale).catch(() => undefined);
  }, [active]);
  const value = useMemo<I18nValue>(() => ({
    locale: active.locale,
    setLocale,
    text: (ko, en) => {
      registerUiEnglish(ko, en);
      return localizedUiText(active.locale, ko, () => en, active.messages);
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
