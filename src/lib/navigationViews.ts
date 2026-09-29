import type { ViewId } from "../types";
import { memberGuard } from "./memberGuard.ts";

/**
 * 사이드바 메뉴의 화면 목록 — 어떤 화면이 있고, 그중 무엇을 사용자가 정할 수 있는가.
 *
 * 이 사실은 저장 규칙과 함께 `navigationPreferences`에 있었다. 그 파일이 실제로 다루는
 * 것은 사용자가 정한 순서·숨김을 어느 세대의 키로 저장하고 옛 값을 어떻게 옮기는가인데,
 * 화면 목록만 필요한 쪽(`navigationHelp`의 도움말 대상)까지 그 저장 세대와 마이그레이션이
 * 딸린 모듈을 가져와야 했다. 목록이 바뀌는 이유(화면 추가·준비중 해제)와 저장 규칙이
 * 바뀌는 이유(키 세대를 올림)는 서로 무관하므로 파일을 나눠 둔다.
 */

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

export const DEFAULT_NAVIGATION_ORDER: ConfigurableViewId[] = [
  "dashboard",
  "chat",
  "sessions",
  "docs",
  "projects",
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
 * 설정 → 화면에서 직접 켜면 다른 메뉴와 같게 다룬다. 지금은 비어 있다 — 태그와 기본 숨김
 * 기계는 그대로 두고 목록만 비웠으므로, 다음 개발 중 화면은 여기 한 줄을 더하면 된다.
 */
export const PREVIEW_VIEWS: ConfigurableViewId[] = [];

/** 메뉴에 "준비중" 태그가 붙는 화면인지. */
export const previewView = memberGuard<ConfigurableViewId>(PREVIEW_VIEWS);

/**
 * 바깥에서 들어온 값이 사용자 설정 대상 화면인지. 저장값은 옛 버전이 적은 것이거나 손으로
 * 고친 것일 수 있어 좁히는 자리를 여기 하나로 둔다.
 */
export const configurableView = memberGuard<ConfigurableViewId>(DEFAULT_NAVIGATION_ORDER);
