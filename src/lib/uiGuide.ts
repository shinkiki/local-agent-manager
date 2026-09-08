import targets from "./uiGuideTargets.json" with { type: "json" };
import { attributeSelector } from "./uiElements.ts";
import type { ViewId } from "../types";

// AIA 화면 안내(show_ui_guide). 대상 목록은 백엔드와 공유하는 uiGuideTargets.json 하나다 —
// 백엔드는 id 검증과 카탈로그 노출에, 여기서는 화면 전환·탭 전환·앵커 탐색에 쓴다.

/** 다른 화면이 특정 탭을 열어 달라고 보내는 요청. requestId가 바뀔 때마다 한 번 전환한다. */
export interface TabRequest<T extends string> {
  tab: T;
  requestId: number;
}

export interface UiGuideTarget {
  id: string;
  /** 가리키기 전에 열어야 하는 화면. null이면 현재 화면에서 가리키기만 한다. */
  view: ViewId | null;
  tab: string | null;
  /** `data-ui-anchor` 값. 같은 대상이 상태에 따라 다른 요소로 그려지면 둘 다 같은 값을 갖는다. */
  anchor: string;
  description: string;
}

const VIEW_IDS: readonly ViewId[] = [
  "dashboard", "chat", "sessions", "docs", "instructions", "skills", "agents", "artifacts", "workflows", "addons", "storage", "settings",
];

/** 화면별로 요청으로 열 수 있는 탭. JSON의 tab이 여기 없으면 프런트가 열 수 없는 대상이다. */
export const UI_GUIDE_VIEW_TABS: Partial<Record<ViewId, readonly string[]>> = {
  settings: ["connections", "plugins", "service", "repository", "language", "display", "automation"],
  chat: ["conversation", "activity", "schedules"],
  workflows: ["catalog", "recurring"],
  addons: ["aia", "claude", "codex"],
};

export function isViewId(value: unknown): value is ViewId {
  return typeof value === "string" && (VIEW_IDS as readonly string[]).includes(value);
}

/**
 * JSON 항목 하나를 읽어 대상과 그 항목의 문제를 함께 돌려준다. 검사와 정규화가 같은
 * 필드를 각자 해석하면 한쪽만 고쳤을 때 "문제 없음"인데 값이 비는 항목이 생기므로,
 * 필드 해석은 여기 한 벌만 둔다. id 중복은 항목 하나만 봐서는 알 수 없어 호출부가 본다.
 */
function readUiGuideTarget(item: Record<string, unknown>, index: number): {
  target: UiGuideTarget;
  problems: string[];
} {
  const label = typeof item.id === "string" ? item.id : `#${index}`;
  const view = isViewId(item.view) ? item.view : null;
  const tab = typeof item.tab === "string" ? item.tab : null;
  const anchor = typeof item.anchor === "string" ? item.anchor : "";
  const description = typeof item.description === "string" ? item.description : "";
  const problems: string[] = [];
  if (typeof item.id !== "string" || !item.id) problems.push(`${label}: id가 없습니다`);
  if (item.view !== null && view === null) problems.push(`${label}: 알 수 없는 화면 ${String(item.view)}`);
  if (item.tab !== undefined && item.tab !== null) {
    const tabs = view ? UI_GUIDE_VIEW_TABS[view] : undefined;
    if (!tabs || !tabs.includes(String(item.tab))) {
      problems.push(`${label}: ${String(item.view)} 화면에 ${String(item.tab)} 탭이 없습니다`);
    }
  }
  if (!anchor) problems.push(`${label}: anchor가 없습니다`);
  if (!description) problems.push(`${label}: description이 없습니다`);
  return { target: { id: label, view, tab, anchor, description }, problems };
}

function readUiGuideTargets(raw: unknown[]): { targets: UiGuideTarget[]; problems: string[] } {
  const targets: UiGuideTarget[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    if (typeof item.id === "string" && item.id && seen.has(item.id)) {
      problems.push(`${item.id}: id가 중복되었습니다`);
    }
    seen.add(String(item.id));
    const read = readUiGuideTarget(item, index);
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

/** 값을 [min, max] 안으로 민다. max가 min보다 작아진 좁은 화면에서도 min을 지킨다. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export interface UiGuideRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface UiGuidePointerPlacement {
  ring: UiGuideRect;
  arrow: { top: number; left: number; size: number; direction: "down" | "up" };
  /** 위로 열 때는 말풍선 높이를 몰라도 되도록 `bottom`을 고정하고 `top`은 null이다. */
  note: { top: number | null; bottom: number | null; left: number; width: number };
}

export interface UiGuidePlacementOptions {
  ringPadding?: number;
  arrowSize?: number;
  gap?: number;
  margin?: number;
  noteWidth?: number;
  /** 위쪽에 화살표와 말풍선을 놓을 수 있는지 판단할 때 쓰는 말풍선 예상 높이. */
  noteHeight?: number;
}

/** 세로 배치 결정. 화살표를 어디에 두고 어느 쪽을 가리키는지, 말풍선을 그 위로 다는지. */
interface PointerAnchoring {
  arrowTop: number;
  direction: "down" | "up";
  /** 참이면 말풍선을 화살표 위에 매단다(`bottom` 고정). 높이를 몰라도 되게 하기 위함이다. */
  above: boolean;
}

/**
 * 화살표를 어디에 놓을지만 정한다. 대상 위에 자리가 있으면 위에서 아래를 가리키고,
 * 없으면 대상 아래에서 위를 가리키며, 대상이 화면을 가득 채워 위아래 어디에도 자리가
 * 없으면 링 안쪽 위에 얹는다(내용을 조금 가리더라도 어느 영역인지는 보이게 한다).
 */
function pointerAnchoring(
  ringTop: number,
  ringBottom: number,
  viewportHeight: number,
  metrics: { arrowSize: number; gap: number; margin: number; needed: number },
): PointerAnchoring {
  const { arrowSize, gap, margin, needed } = metrics;
  if (ringTop - margin >= needed) {
    return { arrowTop: ringTop - gap - arrowSize, direction: "down", above: true };
  }
  if (viewportHeight - margin - ringBottom >= needed) {
    return { arrowTop: ringBottom + gap, direction: "up", above: false };
  }
  return { arrowTop: ringTop + gap, direction: "down", above: false };
}

/**
 * 대상 위에 아래를 가리키는 화살표와 말풍선을 놓는다. 위 공간이 부족하면 대상 아래에서
 * 위를 가리키고, 대상이 화면을 가득 채워 위아래 어디에도 자리가 없으면 링 안쪽 위에 얹는다.
 * 가로는 대상 중앙에 맞추되 화면 안으로 밀어 넣는다.
 *
 * 세로 갈래가 셋이지만 갈래마다 다른 것은 화살표 위치·방향과 말풍선을 화살표 위에 매다는지
 * 뿐이라, 그 결정만 `pointerAnchoring`이 하고 결과 조립은 여기 한 벌만 둔다.
 */
export function uiGuidePointerPlacement(
  anchor: UiGuideRect,
  viewport: { width: number; height: number },
  options: UiGuidePlacementOptions = {},
): UiGuidePointerPlacement {
  const ringPadding = options.ringPadding ?? 6;
  const arrowSize = options.arrowSize ?? 34;
  const gap = options.gap ?? 6;
  const margin = options.margin ?? 12;
  const noteHeight = options.noteHeight ?? 64;
  // 세로로 화면을 벗어난 부분은 링에서 잘라 낸다. 설정 화면의 실행설정 블록처럼 화면보다
  // 긴 대상을 자르지 않으면 화살표와 말풍선이 화면 밖 끝에 놓여, 사용자에게는 거대한
  // 테두리만 남고 설명이 사라진다.
  const ringTop = clamp(anchor.top - ringPadding, margin, viewport.height - margin);
  const ringBottom = clamp(anchor.top + anchor.height + ringPadding, ringTop, viewport.height - margin);
  const ring = {
    top: ringTop,
    left: anchor.left - ringPadding,
    width: anchor.width + ringPadding * 2,
    height: ringBottom - ringTop,
  };
  const centerX = ring.left + ring.width / 2;
  const arrowLeft = clamp(centerX - arrowSize / 2, margin, viewport.width - margin - arrowSize);
  const noteWidth = Math.min(options.noteWidth ?? 320, Math.max(viewport.width - margin * 2, 0));
  const noteLeft = clamp(centerX - noteWidth / 2, margin, viewport.width - margin - noteWidth);
  const { arrowTop, direction, above } = pointerAnchoring(ringTop, ringBottom, viewport.height, {
    arrowSize,
    gap,
    margin,
    needed: arrowSize + gap * 2 + noteHeight,
  });
  return {
    ring,
    arrow: { top: arrowTop, left: arrowLeft, size: arrowSize, direction },
    note: {
      top: above ? null : arrowTop + arrowSize + gap,
      bottom: above ? viewport.height - arrowTop + gap : null,
      left: noteLeft,
      width: noteWidth,
    },
  };
}
