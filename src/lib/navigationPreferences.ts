import type { ViewId } from "../types";

/**
 * 사용자가 순서·숨김을 정할 수 없는 화면. 설정은 메뉴 맨 뒤에 고정으로 붙으므로
 * `DEFAULT_NAVIGATION_ORDER` 밖에 있다.
 *
 * 이 목록이 그 사실의 유일한 자리다. 아래 `ConfigurableViewId`(타입 수준)와 도움말이 붙는
 * 화면 목록(`navigationHelp`의 `navigationHelpViews`)이 각자 `"settings"`를 다시 적고
 * 있었는데, 순서를 정할 수 없는 화면이 하나 더 늘면 한쪽만 고쳐진다 — 타입만 고치면 그
 * 화면이 도움말 목록에서 조용히 빠지고, 배열만 고치면 저장값 정규화가 그 화면을 계속
 * 사용자 설정 대상으로 받아들인다. 둘 다 여기서 파생되면 그 어긋남이 생길 자리가 없다.
 */
export const UNCONFIGURABLE_VIEWS = ["settings"] as const;

export type ConfigurableViewId = Exclude<ViewId, (typeof UNCONFIGURABLE_VIEWS)[number]>;

export interface NavigationPreferences {
  order: ConfigurableViewId[];
  hidden: ConfigurableViewId[];
}

export const DEFAULT_NAVIGATION_ORDER: ConfigurableViewId[] = [
  "dashboard",
  "chat",
  "sessions",
  "docs",
  "instructions",
  "skills",
  "agents",
  "artifacts",
  "workflows",
  "addons",
  "storage",
];

/**
 * 아직 개발 중이라 기본으로 숨기는 화면. 메뉴에는 "준비중" 태그를 붙여 보이고, 사용자가
 * 설정 → 화면에서 직접 켜면 다른 메뉴와 같게 다룬다. 기능이 완성되면 여기서 빼면 된다 —
 * 그 순간부터 새 사용자에게는 보이고, 이미 숨긴 사용자의 저장값은 그대로 존중된다.
 */
export const PREVIEW_VIEWS: ConfigurableViewId[] = ["addons"];

export function previewView(view: ViewId): boolean {
  return (PREVIEW_VIEWS as string[]).includes(view);
}

/**
 * v1은 준비중 화면이 생기기 전 저장값이라 `hidden`에 그 화면에 대한 결정이 없다. v1만
 * 있으면 준비중 화면을 숨긴 채 v2로 넘어가고, 그 뒤에는 사용자의 켜기·끄기만 남는다.
 */
const NAVIGATION_PREFERENCES_KEY = "agent-manager.navigation-preferences.v2";
const LEGACY_NAVIGATION_PREFERENCES_KEY = "agent-manager.navigation-preferences.v1";

const configurableViews = new Set<string>(DEFAULT_NAVIGATION_ORDER);

function configurableView(value: unknown): value is ConfigurableViewId {
  return typeof value === "string" && configurableViews.has(value);
}

function uniqueConfigurableViews(value: unknown): ConfigurableViewId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(configurableView))];
}

/**
 * 저장값이 오래됐거나 일부가 손상돼도 알려진 메뉴만 유지하고, 새로 추가된 메뉴는
 * 기본 순서의 뒤에 보완한다. `settings`는 사용자 설정 대상이 아니므로 항상 제외한다.
 * 숨김 목록이 아예 없으면(첫 실행·손상) 준비중 화면을 숨긴 기본값으로 시작한다. 목록이
 * 있으면 빈 배열이라도 사용자의 결정이므로 그대로 둔다.
 */
export function normalizeNavigationPreferences(value: unknown): NavigationPreferences {
  const stored = value && typeof value === "object" ? value as Partial<NavigationPreferences> : {};
  const order = uniqueConfigurableViews(stored.order);
  for (const view of DEFAULT_NAVIGATION_ORDER) {
    if (!order.includes(view)) order.push(view);
  }
  const hidden = Array.isArray(stored.hidden) ? uniqueConfigurableViews(stored.hidden) : [...PREVIEW_VIEWS];
  return { order, hidden };
}

/** v1 저장값에 준비중 화면 숨김을 더한다. 이미 숨겨 둔 화면은 두 번 넣지 않는다. */
export function migrateLegacyNavigationPreferences(preferences: NavigationPreferences): NavigationPreferences {
  const hidden = [...preferences.hidden];
  for (const view of PREVIEW_VIEWS) {
    if (!hidden.includes(view)) hidden.push(view);
  }
  return { ...preferences, hidden };
}

/** 저장값이 아예 없거나 읽을 수 없을 때 쓰는 완전한 기본 설정. */
function defaultNavigationPreferences(): NavigationPreferences {
  return normalizeNavigationPreferences(null);
}

/**
 * 저장소에 적힌 원문. localStorage 접근 자체가 막혀 있으면(사파리 프라이빗 모드, 원격
 * 브라우저) 저장값이 없는 것과 같이 다룬다 — 저장값 없음도 접근 불가도 결론은 기본
 * 설정이고, 여기서 흡수하면 아래 해석 경로가 접근 실패를 다시 볼 필요가 없다.
 */
function storedNavigationPreferences(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 저장 원문을 설정으로 읽는다. JSON이 깨져 있어도(손으로 고친 값) 메뉴는 떠야 하므로
 * 예외로 올리지 않고 기본 설정으로 떨어뜨린다. 되돌림이 실패 종류마다 한 겹씩만 있어,
 * 어느 갈래가 어떤 실패를 흡수하는지 함수 하나만 읽어도 드러난다.
 */
export function parseNavigationPreferences(value: string | null): NavigationPreferences {
  if (!value) return defaultNavigationPreferences();
  try {
    return normalizeNavigationPreferences(JSON.parse(value));
  } catch {
    return defaultNavigationPreferences();
  }
}

export function loadNavigationPreferences(): NavigationPreferences {
  // 빈 문자열은 저장값 없음과 같이 본다 — 손으로 지운 값과 E2E 하네스의 "기본값으로 되돌림"
  // 씨앗이 모두 그 모양이다.
  const current = storedNavigationPreferences(NAVIGATION_PREFERENCES_KEY);
  if (current) return parseNavigationPreferences(current);
  const legacy = storedNavigationPreferences(LEGACY_NAVIGATION_PREFERENCES_KEY);
  if (legacy) return migrateLegacyNavigationPreferences(parseNavigationPreferences(legacy));
  return defaultNavigationPreferences();
}

export function saveNavigationPreferences(preferences: NavigationPreferences): void {
  try {
    window.localStorage.setItem(
      NAVIGATION_PREFERENCES_KEY,
      JSON.stringify(normalizeNavigationPreferences(preferences)),
    );
  } catch {
    // 저장소가 차단돼도 현재 실행 중의 메뉴 설정은 유지한다.
  }
}

/**
 * 손댈 곳만 바꾼 새 설정. 화면이 넘겨주는 값은 이전 버전에서 저장한 것일 수 있으므로
 * 바꾸기 전에 항상 정규화하고, 바꾸지 않은 축은 정규화 결과를 그대로 물려준다.
 */
function updateNavigationPreferences(
  preferences: NavigationPreferences,
  change: (normalized: NavigationPreferences) => Partial<NavigationPreferences>,
): NavigationPreferences {
  const normalized = normalizeNavigationPreferences(preferences);
  return { ...normalized, ...change(normalized) };
}

export function setNavigationVisibility(
  preferences: NavigationPreferences,
  view: ConfigurableViewId,
  visible: boolean,
): NavigationPreferences {
  return updateNavigationPreferences(preferences, (normalized) => {
    const without = normalized.hidden.filter((item) => item !== view);
    return { hidden: visible ? without : [...without, view] };
  });
}

export function moveNavigationItem(
  preferences: NavigationPreferences,
  view: ConfigurableViewId,
  direction: -1 | 1,
): NavigationPreferences {
  return updateNavigationPreferences(preferences, (normalized) => {
    const index = normalized.order.indexOf(view);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= normalized.order.length) return {};
    const order = [...normalized.order];
    [order[index], order[nextIndex]] = [order[nextIndex], order[index]];
    return { order };
  });
}

/**
 * 메뉴에 보이는 첫 화면. 저장된 화면을 복원할 수 없을 때(없음·숨김) 본 창이 시작할 자리다.
 * 사용자가 정한 순서에서 숨기지 않은 첫 항목을 고르고, 구성 가능한 메뉴를 모두 숨긴 극단에서는
 * 숨길 수 없는 고정 메뉴인 설정으로 떨어진다 — 열린 화면은 언제나 사이드바에서 짚혀야 한다.
 */
export function firstVisibleView(preferences: NavigationPreferences): ViewId {
  const normalized = normalizeNavigationPreferences(preferences);
  return normalized.order.find((view) => !normalized.hidden.includes(view)) ?? "settings";
}
