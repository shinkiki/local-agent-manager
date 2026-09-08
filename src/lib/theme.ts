import type { AccentColor, ThemeMode } from "../types";

/**
 * 화면 표시 설정(테마 모드·악센트 색)의 저장과 적용. 두 설정은 값 목록과 저장 키,
 * 문서 루트에 붙일 `data-*` 이름만 다르고 나머지는 같다 — 저장소 접근을 감싸고,
 * 알 수 없는 값이면 기본값으로 되돌리고, 기본값일 때는 속성을 지운다(CSS 기본 규칙이
 * 그대로 적용되게). 그래서 그 세 벌을 값마다 되풀이하지 않고 한 벌만 둔다.
 */
interface RootPreference<T extends string> {
  load(): T;
  save(value: T): void;
  apply(value: T): void;
}

function rootPreference<T extends string>(
  storageKey: string,
  values: readonly T[],
  fallback: T,
  datasetKey: string,
): RootPreference<T> {
  return {
    load() {
      try {
        const stored = window.localStorage.getItem(storageKey);
        return values.includes(stored as T) ? (stored as T) : fallback;
      } catch {
        // 저장소를 못 읽는 브라우저 설정에서도 기본 표시로는 동작해야 한다.
        return fallback;
      }
    },
    save(value) {
      try {
        window.localStorage.setItem(storageKey, value);
      } catch {
        // 저장에 실패해도 현재 실행 중에는 선택한 값이 유지된다.
      }
    },
    apply(value) {
      const root = document.documentElement;
      if (value === fallback) delete root.dataset[datasetKey];
      else root.dataset[datasetKey] = value;
    },
  };
}

export const THEME_MODE_KEY = "agent-manager.theme-mode.v1";
export const THEME_MODES: readonly ThemeMode[] = ["auto", "light", "dark"];

const themeMode = rootPreference<ThemeMode>(THEME_MODE_KEY, THEME_MODES, "auto", "theme");

export const loadThemeMode = themeMode.load;
export const saveThemeMode = themeMode.save;
export const applyThemeMode = themeMode.apply;

export const ACCENT_COLOR_KEY = "agent-manager.accent-color.v1";
export const ACCENT_COLORS: readonly AccentColor[] = ["brass", "green", "blue", "cyan", "violet"];

const accentColor = rootPreference<AccentColor>(ACCENT_COLOR_KEY, ACCENT_COLORS, "brass", "accent");

export const loadAccentColor = accentColor.load;
export const saveAccentColor = accentColor.save;
export const applyAccentColor = accentColor.apply;
