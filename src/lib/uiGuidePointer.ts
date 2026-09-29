/**
 * AIA 화면 안내 포인터의 배치 계산 — 링·화살표·말풍선을 화면 어디에 놓을지.
 *
 * 대상 목록(`uiGuide`)과는 서로 읽을 것이 없다. 목록은 "무엇을 가리킬 수 있는가"를 JSON
 * 한 벌에서 검증하고 화면·탭 전환을 정하는 일이고, 여기는 이미 정해진 사각형 하나를 받아
 * 뷰포트 안으로 밀어 넣는 순수 기하다. 쓰는 쪽도 갈린다 — 목록은 앱 셸과 AIA 화면 조작이,
 * 배치는 포인터 컴포넌트 하나가 쓴다. 한 모듈에 두면 포인터 여백 하나를 고치러 들어온
 * 사람이 JSON 검증 규칙을, 대상을 하나 늘리러 온 사람이 말풍선 기하를 함께 읽게 된다.
 */

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
  /**
   * 위로 열 때는 말풍선 높이를 몰라도 되도록 `bottom`을 고정하고 `top`은 null이다.
   * `maxHeight`는 그 방향으로 남은 세로 공간이다 — 긴 안내가 이 값을 넘어 뷰포트 밖으로
   * 자라면 사용자는 문장의 **앞부분**을 잃는다(QA #66). 넘치는 만큼은 말풍선 안에서 스크롤한다.
   */
  note: { top: number | null; bottom: number | null; left: number; width: number; maxHeight: number };
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

/** 배치에 쓰는 치수. 기본값과 화면 폭에 맞춘 말풍선 폭을 여기서 한 번에 정해, 조립
 * 단계마다 `?? 기본값`을 되풀이하지 않는다. */
interface PointerMetrics {
  ringPadding: number;
  arrowSize: number;
  gap: number;
  margin: number;
  /** 화면 폭 안으로 이미 줄여 둔 말풍선 폭. */
  noteWidth: number;
  noteHeight: number;
}

function pointerMetrics(options: UiGuidePlacementOptions, viewportWidth: number): PointerMetrics {
  const margin = options.margin ?? 12;
  return {
    ringPadding: options.ringPadding ?? 6,
    arrowSize: options.arrowSize ?? 34,
    gap: options.gap ?? 6,
    margin,
    noteWidth: Math.min(options.noteWidth ?? 320, Math.max(viewportWidth - margin * 2, 0)),
    noteHeight: options.noteHeight ?? 64,
  };
}

/**
 * 대상을 감싸는 링. 세로로 화면을 벗어난 부분은 잘라 낸다. 설정 화면의 실행설정 블록처럼
 * 화면보다 긴 대상을 자르지 않으면 화살표와 말풍선이 화면 밖 끝에 놓여, 사용자에게는
 * 거대한 테두리만 남고 설명이 사라진다.
 */
function pointerRing(anchor: UiGuideRect, viewportHeight: number, metrics: PointerMetrics): UiGuideRect {
  const { ringPadding, margin } = metrics;
  const top = clamp(anchor.top - ringPadding, margin, viewportHeight - margin);
  const bottom = clamp(anchor.top + anchor.height + ringPadding, top, viewportHeight - margin);
  return {
    top,
    left: anchor.left - ringPadding,
    width: anchor.width + ringPadding * 2,
    height: bottom - top,
  };
}

/**
 * 가로 위치. 화살표와 말풍선은 폭만 다를 뿐 규칙이 같다 — 링 중앙에 맞추되 화면 안으로
 * 민다. 두 벌로 적으면 한쪽만 여백을 고쳤을 때 화살표와 말풍선이 어긋나 보인다.
 */
function centeredLeft(center: number, width: number, viewportWidth: number, margin: number): number {
  return clamp(center - width / 2, margin, viewportWidth - margin - width);
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
  ring: UiGuideRect,
  viewportHeight: number,
  metrics: PointerMetrics,
): PointerAnchoring {
  const { arrowSize, gap, margin, noteHeight } = metrics;
  const needed = arrowSize + gap * 2 + noteHeight;
  const ringBottom = ring.top + ring.height;
  if (ring.top - margin >= needed) {
    return { arrowTop: ring.top - gap - arrowSize, direction: "down", above: true };
  }
  if (viewportHeight - margin - ringBottom >= needed) {
    return { arrowTop: ringBottom + gap, direction: "up", above: false };
  }
  return { arrowTop: ring.top + gap, direction: "down", above: false };
}

/**
 * 말풍선 상자. 위로 열 때는 높이를 몰라도 되도록 `bottom`을 고정하고, 아래로 열 때는
 * 화살표 아래에 `top`으로 붙인다. `maxHeight`는 그 방향으로 남은 세로 공간이며 음수가
 * 되지 않게 0으로 막는다.
 */
function pointerNote(
  anchoring: PointerAnchoring,
  left: number,
  viewportHeight: number,
  metrics: PointerMetrics,
): UiGuidePointerPlacement["note"] {
  const { arrowSize, gap, margin, noteWidth } = metrics;
  const { arrowTop, above } = anchoring;
  const top = above ? null : arrowTop + arrowSize + gap;
  return {
    top,
    bottom: above ? viewportHeight - arrowTop + gap : null,
    left,
    width: noteWidth,
    maxHeight: Math.max(above ? arrowTop - gap - margin : viewportHeight - margin - (top ?? 0), 0),
  };
}

/**
 * 대상 위에 아래를 가리키는 화살표와 말풍선을 놓는다. 위 공간이 부족하면 대상 아래에서
 * 위를 가리키고, 대상이 화면을 가득 채워 위아래 어디에도 자리가 없으면 링 안쪽 위에 얹는다.
 * 가로는 대상 중앙에 맞추되 화면 안으로 밀어 넣는다.
 *
 * 배치는 네 걸음이며 걸음마다 판단 기준이 다르다 — 치수 정하기, 화면에 맞춰 링 자르기,
 * 세로 갈래 고르기, 말풍선 상자 만들기. 여기서는 그 넷을 엮기만 하고, 가로 위치는
 * 화살표·말풍선이 같은 규칙을 쓰도록 한 도우미(`centeredLeft`)에 맡긴다.
 */
export function uiGuidePointerPlacement(
  anchor: UiGuideRect,
  viewport: { width: number; height: number },
  options: UiGuidePlacementOptions = {},
): UiGuidePointerPlacement {
  const metrics = pointerMetrics(options, viewport.width);
  const ring = pointerRing(anchor, viewport.height, metrics);
  const centerX = ring.left + ring.width / 2;
  const anchoring = pointerAnchoring(ring, viewport.height, metrics);
  return {
    ring,
    arrow: {
      top: anchoring.arrowTop,
      left: centeredLeft(centerX, metrics.arrowSize, viewport.width, metrics.margin),
      size: metrics.arrowSize,
      direction: anchoring.direction,
    },
    note: pointerNote(
      anchoring,
      centeredLeft(centerX, metrics.noteWidth, viewport.width, metrics.margin),
      viewport.height,
      metrics,
    ),
  };
}
