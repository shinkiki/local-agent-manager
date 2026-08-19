import type { AccentColor, ThemeMode } from "../types";

const THEME_MODE_KEY = "agent-manager.theme-mode.v1";

export function loadThemeMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_MODE_KEY);
    return stored === "light" || stored === "dark" ? stored : "auto";
  } catch {
    return "auto";
  }
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_MODE_KEY, mode);
  } catch {
    // 저장에 실패해도 현재 실행 중에는 선택한 테마가 유지된다.
  }
}

export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "auto") delete root.dataset.theme;
  else root.dataset.theme = mode;
}

const ACCENT_COLOR_KEY = "agent-manager.accent-color.v1";

const accentColorValues: readonly AccentColor[] = ["brass", "green", "blue", "cyan", "violet"];

export function loadAccentColor(): AccentColor {
  try {
    const stored = window.localStorage.getItem(ACCENT_COLOR_KEY);
    return accentColorValues.includes(stored as AccentColor) ? (stored as AccentColor) : "brass";
  } catch {
    return "brass";
  }
}

export function saveAccentColor(color: AccentColor): void {
  try {
    window.localStorage.setItem(ACCENT_COLOR_KEY, color);
  } catch {
    // 저장에 실패해도 현재 실행 중에는 선택한 색상이 유지된다.
  }
}

export function applyAccentColor(color: AccentColor): void {
  const root = document.documentElement;
  if (color === "brass") delete root.dataset.accent;
  else root.dataset.accent = color;
}
