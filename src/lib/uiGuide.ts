import targets from "./uiGuideTargets.json" with { type: "json" };
import { attributeSelector } from "./uiElementDom.ts";
import type { ViewId } from "../types";

// AIA 화면 안내(show_ui_guide). 대상 목록은 백엔드와 공유하는 uiGuideTargets.json 하나다 —
// 백엔드는 id 검증과 카탈로그 노출에, 여기서는 화면 전환·탭 전환·앵커 탐색에 쓴다.

/** 다른 화면이 특정 탭을 열어 달라고 보내는 요청. requestId가 바뀔 때마다 한 번 전환한다. */
export interface TabRequest<T extends string> {
  tab: T;
  requestId: number;
}

interface UiGuideTarget {
  id: string;
  /** 가리키기 전에 열어야 하는 화면. null이면 현재 화면에서 가리키기만 한다. */
  view: ViewId | null;
  tab: string | null;
  /** `data-ui-anchor` 값. 같은 대상이 상태에 따라 다른 요소로 그려지면 둘 다 같은 값을 갖는다. */
  anchor: string;
  description: string;
}

const VIEW_IDS: readonly ViewId[] = [
  "dashboard", "chat", "sessions", "docs", "projects", "instructions", "skills", "agents", "artifacts", "workflows", "addons", "storage", "settings",
];

/** 화면별로 요청으로 열 수 있는 탭. JSON의 tab이 여기 없으면 프런트가 열 수 없는 대상이다. */
export const UI_GUIDE_VIEW_TABS: Partial<Record<ViewId, readonly string[]>> = {
  settings: ["connections", "aia", "service", "repository", "language", "display"],
  chat: ["conversation", "activity", "schedules"],
  workflows: ["catalog", "recurring"],
  addons: ["mcp", "ssh", "db", "cypress", "mermaid", "claude", "automation"],
  projects: ["files", "git", "settings"],
  storage: ["data", "secrets"],
};

export function isViewId(value: unknown): value is ViewId {
  return typeof value === "string" && (VIEW_IDS as readonly string[]).includes(value);
}

/** 항목의 문자열 필드. 문자열이 아니면 없는 것과 같이 빈 문자열로 본다. */
function textField(item: Record<string, unknown>, field: string): string {
  const value = item[field];
  return typeof value === "string" ? value : "";
}

/**
 * 문자열로 반드시 채워야 하는 필드와 비었을 때의 문구. 필드 이름을 값 해석과 검사에
 * 따로 적으면, 필드가 하나 늘 때 한쪽만 채워도 "문제 없음"인 채 값이 빈 대상이 생긴다.
 * 비었을 때의 문구는 필드마다 조사가 달라 이 표가 함께 소유한다.
 */
const REQUIRED_TEXT_FIELDS = [
  ["id", "id가 없습니다"],
  ["anchor", "anchor가 없습니다"],
  ["description", "description이 없습니다"],
] as const;

/**
 * 항목을 부르는 이름. 문제 문구에 쓸 이름(`label`)은 언제나 있지만, 그 이름이 항목이
 * **스스로 밝힌** id인지(`declared`)는 다르다 — 밝히지 않은 항목의 이름은 순번으로
 * 지어 준 것이라 다른 항목과 겹칠 수 없고, 그래서 중복 판정의 대상이 아니다.
 *
 * 같은 물음을 세 자리가 각자 답하고 있었다. 대상의 이름은 `typeof item.id === "string"`으로,
 * 중복 판정의 대상 여부는 거기에 빈 문자열 배제를 더해서, 중복 집합에 담는 값은
 * `String(item.id)`로 — 셋이 서로 다른 답을 주는 항목이 실제로 있었다(id를 밝히지 않은
 * 항목이 `"undefined"`라는 이름으로 집합에 들어가, 진짜 그 id를 쓴 항목을 중복으로
 * 잡을 수 있었다). 답을 한 자리에서 내면 그런 어긋남이 생길 자리가 없다.
 */
function uiGuideItemId(item: Record<string, unknown>, index: number): {
  label: string;
  declared: string | null;
} {
  const raw = typeof item.id === "string" ? item.id : null;
  return { label: raw ?? `#${index}`, declared: raw || null };
}

/**
 * JSON 항목 하나를 읽어 대상과 그 항목의 문제를 함께 돌려준다. 검사와 정규화가 같은
 * 필드를 각자 해석하면 한쪽만 고쳤을 때 "문제 없음"인데 값이 비는 항목이 생기므로,
 * 필드 해석은 여기 한 벌만 둔다. 이름은 호출부가 이미 정한 것을 받고(중복 판정도 같은
 * 이름을 봐야 한다), id 중복 자체는 항목 하나만 봐서는 알 수 없어 호출부가 본다.
 */
function readUiGuideTarget(item: Record<string, unknown>, label: string): {
  target: UiGuideTarget;
  problems: string[];
} {
  const view = isViewId(item.view) ? item.view : null;
  const tab = typeof item.tab === "string" ? item.tab : null;
  const problems = REQUIRED_TEXT_FIELDS
    .filter(([field]) => !textField(item, field))
    .map(([, problem]) => `${label}: ${problem}`);
  if (item.view !== null && view === null) problems.push(`${label}: 알 수 없는 화면 ${String(item.view)}`);
  if (item.tab !== undefined && item.tab !== null) {
    const tabs = view ? UI_GUIDE_VIEW_TABS[view] : undefined;
    if (!tabs || !tabs.includes(String(item.tab))) {
      problems.push(`${label}: ${String(item.view)} 화면에 ${String(item.tab)} 탭이 없습니다`);
    }
  }
  return {
    target: {
      id: label,
      view,
      tab,
      anchor: textField(item, "anchor"),
      description: textField(item, "description"),
    },
    problems,
  };
}

function readUiGuideTargets(raw: unknown[]): { targets: UiGuideTarget[]; problems: string[] } {
  const targets: UiGuideTarget[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const { label, declared } = uiGuideItemId(item, index);
    if (declared !== null) {
      if (seen.has(declared)) problems.push(`${declared}: id가 중복되었습니다`);
      seen.add(declared);
    }
    const read = readUiGuideTarget(item, label);
    problems.push(...read.problems);
    targets.push(read.target);
  });
  return { targets, problems };
}

/** JSON 항목이 프런트가 다룰 수 있는 대상인지 검사한다. 문제가 없으면 빈 배열. */
export function uiGuideTargetProblems(raw: unknown[]): string[] {
  return readUiGuideTargets(raw).problems;
}

/** 문제가 하나라도 있으면 목록을 통째로 비운다 — 일부만 살아 있으면 안내가 엉뚱한 곳을 가리킨다. */
export function normalizeUiGuideTargets(raw: unknown[]): UiGuideTarget[] {
  const { targets, problems } = readUiGuideTargets(raw);
  return problems.length > 0 ? [] : targets;
}

export const UI_GUIDE_TARGETS: readonly UiGuideTarget[] = normalizeUiGuideTargets(targets);

export function resolveUiGuideTarget(id: string, list: readonly UiGuideTarget[] = UI_GUIDE_TARGETS): UiGuideTarget | null {
  return list.find((target) => target.id === id) ?? null;
}

export function uiGuideAnchorSelector(anchor: string): string {
  return attributeSelector("data-ui-anchor", anchor);
}

/**
 * 포인터 배치는 `uiGuidePointer`가 소유한다. 화면 안내는 대상 목록과 배치가 함께 하나의
 * 기능이므로 쓰는 쪽이 보는 입구는 이 모듈 하나로 둔다 — 나눈 쪽의 사정이 컴포넌트의
 * import 목록으로 새어 나가면 다음에 다시 나눌 때마다 컴포넌트를 함께 고쳐야 한다.
 */
export {
  uiGuidePointerPlacement,
  type UiGuidePlacementOptions,
  type UiGuidePointerPlacement,
  type UiGuideRect,
} from "./uiGuidePointer.ts";
