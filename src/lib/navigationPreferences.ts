import type { ViewId } from "../types";
import {
  configurableView,
  DEFAULT_NAVIGATION_ORDER,
  PREVIEW_VIEWS,
  type ConfigurableViewId,
} from "./navigationViews.ts";
import { readStoredText, writeStoredText } from "./storedText.ts";

/**
 * 사용자가 정한 메뉴 순서·숨김의 저장 규칙 — 저장 세대, 옛 값 옮기기, 정규화, 한 축만
 * 바꾼 새 설정.
 *
 * 저장 규칙의 중간 단계(정규화·옛 값 옮기기·원문 해석)는 이 파일 밖으로 내보내지 않는다.
 * 바깥이 쓰는 모양은 저장값을 읽고 쓰는 일과 한 축만 바꾼 새 설정, 그리고 복원 폴백 넷뿐이고,
 * 중간 단계까지 함께 내주면 정규화를 건너뛴 값이 저장되거나 옛 값을 옮기지 않고 그대로 쓰는
 * 두 번째 경로가 열린다 — 실제로 그 셋을 부르는 것은 자기 테스트뿐이었다. 목록과 저장 규칙을
 * 가른 `navigationViews`, 합친 결과를 내주지 않는 `projectRegistry`와 같은 경계다.
 *
 * 화면 목록 자체는 `navigationViews`에 있다. 설정 화면과 사이드바는 저장 규칙과 함께
 * 쓰는 둘(`previewView`·`ConfigurableViewId`)만 이 자리에서 가져가므로 그 둘만 다시
 * 내보낸다. 목록 상수(`DEFAULT_NAVIGATION_ORDER`·`PREVIEW_VIEWS`·`UNCONFIGURABLE_VIEWS`)도
 * 함께 내주고 있었지만 그 통로를 지나는 것은 시험뿐이었다 — 목록을 보는 쪽이 저장 세대와
 * 마이그레이션이 딸린 이 모듈을 거치게 되고, 목록이 어디 사는지가 두 자리에 적힌다.
 */
export { previewView, type ConfigurableViewId } from "./navigationViews.ts";

export interface NavigationPreferences {
  order: ConfigurableViewId[];
  hidden: ConfigurableViewId[];
}

/**
 * 준비중이 풀린 화면. 저장값의 `hidden`에 이 화면이 있어도 사용자가 숨긴 것이 아니라
 * 기본값이 남긴 흔적일 수 있어, 옛 키에서 넘어올 때 한 번만 걷어낸다. 그러지 않으면
 * 준비중일 때 앱을 켜 본 기기에서는 기능이 완성된 뒤에도 메뉴가 계속 보이지 않는다.
 *
 * 걷어내는 것은 키가 넘어오는 그 한 번뿐이다. 그 뒤로 사용자가 다시 숨기면 그 결정은
 * 새 키에 남아 그대로 존중된다.
 */
const RELEASED_PREVIEW_VIEWS: ConfigurableViewId[] = ["addons"];

/**
 * 저장값의 세대. v1은 준비중 화면이 생기기 전이라 `hidden`에 그 화면에 대한 결정이 없고,
 * v2는 애드온이 준비중이던 때라 `hidden`에 애드온이 기본으로 들어 있다. 둘 다 지금 규칙으로
 * 옮겨야 하므로 새 키로 올리고, 옛 키는 새것부터 차례로 찾는다.
 */
const NAVIGATION_PREFERENCES_KEY = "agent-manager.navigation-preferences.v3";

/**
 * 설정 저장 세대의 조회 순서와 레거시 판정. 키 목록과 마이그레이션 분기가 따로 있으면
 * 새 세대를 올릴 때 한쪽만 고쳐 현재 값보다 옛 값을 먼저 읽거나, 옛 값을 지금 규칙으로
 * 옮기지 않고 그대로 쓰는 갈래가 생긴다. 한 행이 그 세대의 두 사실을 함께 들고 있게 한다.
 */
const NAVIGATION_PREFERENCE_STORES = [
  { key: NAVIGATION_PREFERENCES_KEY, legacy: false },
  { key: "agent-manager.navigation-preferences.v2", legacy: true },
  { key: "agent-manager.navigation-preferences.v1", legacy: true },
] as const;

function uniqueConfigurableViews(value: unknown): ConfigurableViewId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(configurableView))];
}

/** 기존 순서를 지키면서 빠진 화면만 주어진 순서대로 뒤에 보완한다. */
function appendMissingViews(target: ConfigurableViewId[], required: readonly ConfigurableViewId[]): void {
  const included = new Set(target);
  for (const view of required) {
    if (included.has(view)) continue;
    target.push(view);
    included.add(view);
  }
}

/**
 * 저장값이 오래됐거나 일부가 손상돼도 알려진 메뉴만 유지하고, 새로 추가된 메뉴는
 * 기본 순서의 뒤에 보완한다. `settings`는 사용자 설정 대상이 아니므로 항상 제외한다.
 * 숨김 목록이 아예 없으면(첫 실행·손상) 준비중 화면만 숨긴 기본값으로 시작한다 — 준비중
 * 화면이 없으면 모두 보이는 것이 기본값이다. 목록이 있으면 빈 배열이라도 사용자의
 * 결정이므로 그대로 둔다.
 */
function normalizeNavigationPreferences(value: unknown): NavigationPreferences {
  const stored = value && typeof value === "object" ? value as Partial<NavigationPreferences> : {};
  const order = uniqueConfigurableViews(stored.order);
  appendMissingViews(order, DEFAULT_NAVIGATION_ORDER);
  const hidden = Array.isArray(stored.hidden) ? uniqueConfigurableViews(stored.hidden) : [...PREVIEW_VIEWS];
  return { order, hidden };
}

/**
 * 옛 키의 저장값을 지금 규칙으로 옮긴다. 준비중이 풀린 화면의 숨김을 걷어내고, 아직
 * 준비중인 화면의 숨김을 더한다(이미 숨겨 둔 화면은 두 번 넣지 않는다).
 */
function migrateLegacyNavigationPreferences(preferences: NavigationPreferences): NavigationPreferences {
  const hidden = preferences.hidden.filter((view) => !RELEASED_PREVIEW_VIEWS.includes(view));
  appendMissingViews(hidden, PREVIEW_VIEWS);
  return { ...preferences, hidden };
}

/** 저장값이 아예 없거나 읽을 수 없을 때 쓰는 완전한 기본 설정. */
function defaultNavigationPreferences(): NavigationPreferences {
  return normalizeNavigationPreferences(null);
}

/**
 * 저장 원문을 설정으로 읽는다. JSON이 깨져 있어도(손으로 고친 값) 메뉴는 떠야 하므로
 * 예외로 올리지 않고 기본 설정으로 떨어뜨린다. 되돌림이 실패 종류마다 한 겹씩만 있어,
 * 어느 갈래가 어떤 실패를 흡수하는지 함수 하나만 읽어도 드러난다.
 */
function parseNavigationPreferences(value: string | null): NavigationPreferences {
  if (!value) return defaultNavigationPreferences();
  try {
    return normalizeNavigationPreferences(JSON.parse(value));
  } catch {
    return defaultNavigationPreferences();
  }
}

/**
 * 저장 세대를 최신순으로 훑어 처음 발견한 비어 있지 않은 설정을 읽는다. 레거시 세대는
 * 같은 행의 판정에 따라 지금 규칙으로 옮긴 뒤 돌려준다.
 *
 * 저장소 접근 자체가 막혀 있어도(쿠키 전면 차단, 사파리 프라이빗 모드) 저장값이 없는 것과
 * 같이 다뤄야 하는데, 그 흡수는 `readStoredText`가 이미 한다 — 예외를 삼키는 try/catch를
 * 여기 한 벌 더 두면 새 저장 항목이 그중 한쪽만 감싸도 아무도 알아채지 못한다.
 */
function firstStoredNavigationPreferences(): NavigationPreferences | null {
  for (const store of NAVIGATION_PREFERENCE_STORES) {
    const stored = readStoredText(store.key);
    if (stored) {
      const preferences = parseNavigationPreferences(stored);
      return store.legacy ? migrateLegacyNavigationPreferences(preferences) : preferences;
    }
  }
  return null;
}

export function loadNavigationPreferences(): NavigationPreferences {
  // 빈 문자열은 저장값 없음과 같이 본다 — 손으로 지운 값과 E2E 하네스의 "기본값으로 되돌림"
  // 씨앗이 모두 그 모양이다.
  return firstStoredNavigationPreferences() ?? defaultNavigationPreferences();
}

export function saveNavigationPreferences(preferences: NavigationPreferences): void {
  writeStoredText(
    NAVIGATION_PREFERENCES_KEY,
    JSON.stringify(normalizeNavigationPreferences(preferences)),
  );
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
