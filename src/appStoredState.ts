/**
 * 본 창이 새로고침을 넘어 유지하는 화면 상태의 저장 자리. App.tsx는 화면 조립과
 * 런타임 배선을 맡는데, localStorage 키·해석·직렬화·적용까지 같은 파일에 있으면
 * 설정을 하나 늘릴 때 읽는 자리와 쓰는 자리가 2천 줄 사이에 흩어진다. 저장 계약만
 * 여기로 떼어 두면 키와 기본값, 저장 실패 처리가 한 화면에 들어온다.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readSessionTranscriptLimit, SESSION_TRANSCRIPT_LIMIT_KEY } from "./components/SessionTranscript";
import {
  emptyAiaEventBudget,
  emptyAiaSkillChangeState,
  emptyAiaSuggestionHistory,
  parseAiaEventBudget,
  parseAiaSkillChangeState,
  parseAiaSuggestionHistory,
  serializeAiaEventBudget,
  serializeAiaSkillChangeState,
  serializeAiaSuggestionHistory,
} from "./lib/aiaSuggestions";
import { hasTauriRuntime } from "./lib/ipc";
import { firstVisibleView, type ConfigurableViewId, type NavigationPreferences } from "./lib/navigationPreferences";
import { parseDiscoveryRequests } from "./lib/schemaDiscovery";
import type { SidebarUsageDensity } from "./lib/sidebarUsage";
import { applyAccentColor, applyThemeMode, saveAccentColor, saveThemeMode } from "./lib/theme";
import { isViewId } from "./lib/uiGuide";
import type { AccentColor, MessageDisplayMode, SessionTranscriptLimit, ThemeMode, ViewId } from "./types";

const MESSAGE_DISPLAY_MODE_KEY = "agent-manager.message-display-mode.v2";
const LEGACY_MESSAGE_DISPLAY_MODE_KEY = "agent-manager.message-display-mode.v1";
const AIA_SUGGESTION_HISTORY_KEY = "aia-suggestions-v1";
const AIA_EVENT_BUDGET_KEY = "aia-suggestion-events-v1";
const AIA_SKILL_CHANGE_KEY = "aia-skill-changes-v1";
const CATALOG_DISCOVERY_REQUEST_KEY = "catalog-discovery-requests-v1";
const ACTIVE_VIEW_KEY = "agent-manager.active-view.v1";
const SIDEBAR_USAGE_DENSITY_KEY = "agent-manager.statusbar-usage-density.v1";

/**
 * localStorage 한 키에 담기는 화면 상태. 키·해석·직렬화를 한 자리에 묶어 두면 읽는 쪽과
 * 쓰는 쪽이 서로 다른 키나 직렬화를 집을 수 없다. 저장소가 막힌 환경(프라이빗 창·정책
 * 차단)에서는 읽기가 기본값으로, 쓰기가 무동작으로 떨어져 현재 실행 중의 선택만 남는다.
 */
function localStore<T>({ key, parse, serialize, fallback }: {
  key: string;
  parse: (raw: string | null) => T;
  serialize: (value: T) => string;
  fallback: () => T;
}) {
  return {
    load: (): T => {
      try { return parse(window.localStorage.getItem(key)); }
      catch { return fallback(); }
    },
    save,
    /** 쓰기 전에 값이 실제로 달라졌는지를 저장 형태로 비교할 때 쓴다. */
    serialize,
    /**
     * 저장 형태가 달라졌을 때만 값을 갈아 끼우고 함께 저장하는 setState 갱신자.
     * 상태 갱신과 저장이 늘 같은 판정 위에서 함께 일어나므로, 화면에는 올라갔는데
     * 저장은 건너뛴(또는 그 반대인) 어긋난 상태가 생기지 않는다. 내용이 같으면 현재
     * 참조를 그대로 돌려 숨은 뷰까지 다시 그려지는 것도 막는다.
     */
    saveIfChanged: (compute: (current: T) => T) => (current: T): T => {
      const next = compute(current);
      if (serialize(next) === serialize(current)) return current;
      save(next);
      return next;
    },
  };

  function save(value: T): void {
    try { window.localStorage.setItem(key, serialize(value)); }
    catch { /* 저장소가 막혀도 현재 실행 중의 선택은 그대로 적용된다. */ }
  }
}

export const messageDisplayModeStore = localStore<MessageDisplayMode>({
  key: MESSAGE_DISPLAY_MODE_KEY,
  parse: (stored) => {
    if (stored === "lastUser" || stored === "start" || stored === "latest") return stored;
    // v1은 기본값("latest")도 자동 저장돼 명시 선택과 구분되지 않는다. 기본값이 아니었던
    // "start"(구 "fixed")만 이어받고, 나머지는 새 기본값인 lastUser로 시작한다.
    const legacy = window.localStorage.getItem(LEGACY_MESSAGE_DISPLAY_MODE_KEY);
    return legacy === "start" || legacy === "fixed" ? "start" : "lastUser";
  },
  serialize: (mode) => mode,
  fallback: () => "lastUser",
});
export const aiaSuggestionHistoryStore = localStore({
  key: AIA_SUGGESTION_HISTORY_KEY,
  parse: parseAiaSuggestionHistory,
  serialize: serializeAiaSuggestionHistory,
  fallback: emptyAiaSuggestionHistory,
});
export const aiaEventBudgetStore = localStore({
  key: AIA_EVENT_BUDGET_KEY,
  parse: parseAiaEventBudget,
  serialize: serializeAiaEventBudget,
  fallback: emptyAiaEventBudget,
});
export const aiaSkillChangeStore = localStore({
  key: AIA_SKILL_CHANGE_KEY,
  parse: parseAiaSkillChangeState,
  serialize: serializeAiaSkillChangeState,
  fallback: emptyAiaSkillChangeState,
});
export const sessionTranscriptLimitStore = localStore<SessionTranscriptLimit>({
  key: SESSION_TRANSCRIPT_LIMIT_KEY,
  parse: () => readSessionTranscriptLimit(),
  serialize: (limit) => limit,
  fallback: readSessionTranscriptLimit,
});
/** 하단 상태바의 사용량 표시 밀도. 기본은 접힌 한 줄 요약이고, 펼침은 사용자가 고른 때만 남는다. */
export const sidebarUsageDensityStore = localStore<SidebarUsageDensity>({
  key: SIDEBAR_USAGE_DENSITY_KEY,
  parse: (stored) => (stored === "detailed" ? "detailed" : "compact"),
  serialize: (density) => density,
  fallback: () => "compact",
});
export const catalogDiscoveryStore = localStore<string[]>({
  key: CATALOG_DISCOVERY_REQUEST_KEY,
  parse: parseDiscoveryRequests,
  serialize: (requests) => JSON.stringify(requests),
  fallback: () => [],
});
/**
 * 마지막으로 보던 화면. 스킬 화면의 모드, 문서 사이드바, UI 언어는 이미 새로고침을 넘어
 * 유지되는데 상위 화면만 매번 대시보드로 돌아가 저장 범위가 어긋나 있었다. 프런트가 갱신돼
 * stale-shell 재로드가 걸릴 때도 보던 자리를 잃는다.
 */
export const activeViewStore = localStore<ViewId | null>({
  key: ACTIVE_VIEW_KEY,
  parse: (stored) => isViewId(stored) ? stored : null,
  serialize: (view) => view ?? "",
  fallback: () => null,
});

/**
 * 테마는 저장과 함께 문서와 창 크롬에 곧바로 적용해야 값과 화면이 어긋나지 않는다.
 */
export function persistThemeMode(mode: ThemeMode): void {
  saveThemeMode(mode);
  applyThemeMode(mode);
  if (hasTauriRuntime()) {
    // 창 크롬(타이틀바)도 콘텐츠 테마와 맞춘다. auto는 OS 설정을 따르도록 되돌린다.
    void getCurrentWindow().setTheme(mode === "auto" ? null : mode).catch(() => undefined);
  }
}

/** 악센트도 테마와 같이 저장과 적용을 함께 한다. */
export function persistAccentColor(color: AccentColor): void {
  saveAccentColor(color);
  applyAccentColor(color);
}

/**
 * 새로고침을 넘어 유지되는 화면 설정 하나. 불러오기와 저장을 선언 자리에서 짝지어 두면
 * 저장 효과를 따로 늘어놓지 않아도 되고, 설정을 하나 더 늘릴 때 저장을 빠뜨릴 자리가
 * 없어진다. 저장만으로 끝나지 않는 값(테마·악센트)은 persist가 적용까지 함께 한다.
 */
export function useStoredState<T>(load: () => T, persist: (value: T) => void): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(load);
  useEffect(() => { persist(value); }, [persist, value]);
  return [value, setValue];
}

/**
 * 저장된 화면으로 시작해도 되는지. 메뉴에서 숨긴 화면으로 복원하면 주 메뉴에 짚이는 자리가
 * 없는 화면이 열려, 사용자는 자기가 숨긴 화면을 왜 보고 있는지 알 수 없다. 설정은 숨김
 * 대상이 아니라 언제나 허용한다.
 */
function restorableView(stored: ViewId | null, preferences: NavigationPreferences): ViewId | null {
  if (!stored) return null;
  if (stored === "settings") return stored;
  return preferences.hidden.includes(stored as ConfigurableViewId) ? null : stored;
}
/**
 * 본 창이 시작할 화면. 저장된 화면을 복원할 수 없으면(없음·숨김) 고정값 대시보드가 아니라
 * 메뉴에 보이는 첫 화면으로 떨어진다 — 대시보드도 숨길 수 있는 메뉴라, 고정값으로 두면
 * 바로 위 숨김 판정이 막은 일이 다음 줄에서 그대로 일어난다.
 */
export function initialMainView(stored: ViewId | null, preferences: NavigationPreferences): ViewId {
  return restorableView(stored, preferences) ?? firstVisibleView(preferences);
}
