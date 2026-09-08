// 카드·스크롤 영역 안에서 열리는 팝오버는 조상의 overflow에 잘려 선택할 수 없게 된다
// (예: `.settings-card { overflow: hidden }` 안의 실행설정 모델 선택). 팝오버를
// document.body로 옮겨 화면 좌표에 직접 놓으면 조상의 overflow와 무관해지므로,
// 이 파일은 그 좌표 계산만 순수 함수로 담당한다.

/** 팝오버를 붙일 트리거의 화면 좌표. DOMRect를 그대로 넘길 수 있다. */
export interface PopoverAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

export interface PopoverViewport {
  width: number;
  height: number;
}

export interface PopoverPlacementOptions {
  /** 트리거와 팝오버 사이 간격. */
  gap?: number;
  /** 화면 가장자리에서 남길 최소 여백. */
  margin?: number;
  /** 트리거가 좁아도 이 폭까지는 넓힌다. */
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** 아래 공간이 이 높이보다 좁고 위가 더 넓으면 위로 뒤집는다. */
  flipHeight?: number;
  /** 위아래 어느 쪽도 이 높이를 못 채우면 화면 기준으로 펼친다. */
  minHeight?: number;
}

export interface PopoverPlacement {
  left: number;
  /** `null`이면 `bottom`을 쓴다. 위로 열 때는 팝오버 높이를 몰라도 되도록 아래를 고정한다. */
  top: number | null;
  bottom: number | null;
  width: number;
  maxHeight: number;
  direction: "down" | "up";
}

/** 기본 수치를 채운 배치 지표. 계산 함수들은 옵션이 아니라 이 완성된 값만 본다. */
type PopoverMetrics = Required<PopoverPlacementOptions>;

const DEFAULT_METRICS: PopoverMetrics = {
  gap: 7,
  margin: 12,
  minWidth: 320,
  maxWidth: 540,
  maxHeight: 520,
  flipHeight: 260,
  minHeight: 200,
};

function popoverMetrics(options: PopoverPlacementOptions): PopoverMetrics {
  const metrics = { ...DEFAULT_METRICS };
  for (const key of Object.keys(DEFAULT_METRICS) as (keyof PopoverMetrics)[]) {
    const value = options[key];
    if (typeof value === "number") metrics[key] = value;
  }
  return metrics;
}

/**
 * 가로 배치. 트리거의 오른쪽 끝에 맞추되 최소·최대 폭과 화면 폭으로 폭을 먼저 정하고,
 * 그 폭을 화면 여백 안으로 민다. 왼쪽 좌표가 폭에 매여 있어 둘을 함께 계산한다.
 */
function horizontalPlacement(
  anchor: PopoverAnchor,
  viewport: PopoverViewport,
  metrics: PopoverMetrics,
): Pick<PopoverPlacement, "left" | "width"> {
  const widthLimit = Math.max(viewport.width - metrics.margin * 2, 0);
  const width = Math.min(Math.max(anchor.width, metrics.minWidth), metrics.maxWidth, widthLimit);
  const leftLimit = Math.max(viewport.width - metrics.margin - width, metrics.margin);
  return { left: Math.min(Math.max(anchor.right - width, metrics.margin), leftLimit), width };
}

/**
 * 세로 배치. 세 갈래가 전부다 — 위아래 어느 쪽도 최소 높이를 못 채우면 화면 기준으로
 * 펼치고, 아래가 좁고 위가 더 넓으면 위로 뒤집고(팝오버 높이를 몰라도 되도록 아래를
 * 고정한다), 그 밖에는 트리거 아래에 놓는다.
 */
function verticalPlacement(
  anchor: PopoverAnchor,
  viewport: PopoverViewport,
  metrics: PopoverMetrics,
): Pick<PopoverPlacement, "top" | "bottom" | "maxHeight" | "direction"> {
  const spaceBelow = Math.max(viewport.height - anchor.bottom - metrics.gap - metrics.margin, 0);
  const spaceAbove = Math.max(anchor.top - metrics.gap - metrics.margin, 0);
  const heightLimit = Math.max(viewport.height - metrics.margin * 2, 0);
  // 창이 너무 낮아 트리거 기준으로는 목록을 못 펼치는 경우.
  if (Math.max(spaceBelow, spaceAbove) < Math.min(metrics.minHeight, heightLimit)) {
    return { top: metrics.margin, bottom: null, maxHeight: heightLimit, direction: "down" };
  }
  if (spaceBelow < Math.min(metrics.flipHeight, metrics.maxHeight) && spaceAbove > spaceBelow) {
    return {
      top: null,
      bottom: Math.max(viewport.height - anchor.top + metrics.gap, metrics.margin),
      maxHeight: Math.min(metrics.maxHeight, spaceAbove),
      direction: "up",
    };
  }
  return {
    top: anchor.bottom + metrics.gap,
    bottom: null,
    maxHeight: Math.min(metrics.maxHeight, spaceBelow),
    direction: "down",
  };
}

/**
 * 트리거 아래(공간이 부족하면 위)에 팝오버를 놓을 화면 좌표를 만든다. 가로와 세로는
 * 서로의 결과를 쓰지 않으므로 따로 계산해 합친다 — 폭을 좁히는 규칙과 위로 뒤집는
 * 규칙이 한 함수에 섞여 있으면 어느 쪽을 고쳐도 다른 쪽 경계까지 함께 읽어야 한다.
 */
export function anchoredPopoverPlacement(
  anchor: PopoverAnchor,
  viewport: PopoverViewport,
  options: PopoverPlacementOptions = {},
): PopoverPlacement {
  const metrics = popoverMetrics(options);
  return {
    ...horizontalPlacement(anchor, viewport, metrics),
    ...verticalPlacement(anchor, viewport, metrics),
  };
}

/** 스크롤·리사이즈마다 같은 값으로 다시 렌더하지 않도록 비교한다. */
export function samePopoverPlacement(a: PopoverPlacement | null, b: PopoverPlacement | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.left === b.left && a.top === b.top && a.bottom === b.bottom && a.width === b.width && a.maxHeight === b.maxHeight && a.direction === b.direction;
}
