/**
 * 다이어그램 확대 보기의 배율·이동 산식. 화면(`DiagramViewer`)은 이 값을 변환(transform)으로
 * 걸고 입력을 받는 일만 한다.
 *
 * 산식을 부품 밖에 두는 이유는 시험이다. 버튼·휠·핀치가 모두 같은 식에 기대는데, 부품 안에
 * 있는 동안에는 그 식을 붙잡는 시험이 없었다 — 한 조작에서만 어긋나는 확대는 손으로 만져
 * 보기 전까지 드러나지 않는다.
 */

export const MIN_SCALE = 0.2;
export const MAX_SCALE = 8;

/**
 * 휠 한 칸이 얼마나 확대할지. 배율은 곱으로 움직이므로 `exp(-delta/거리)`를 쓴다 —
 * 칸 단위로 딱딱 끊기는 마우스 휠(한 번에 100px 남짓)과 픽셀 단위로 잘게 오는 트랙패드가
 * **같은 손놀림에 같은 만큼** 확대돼야 한다. 고정 배수를 쓰면 트랙패드에서 이벤트가 수십 번
 * 쏟아지며 순식간에 최대 배율까지 튄다.
 */
const WHEEL_ZOOM_DISTANCE = 400;

/** 줄 단위로 오는 휠(deltaMode 1)을 픽셀로 환산하는 값. */
const WHEEL_LINE_HEIGHT = 16;

export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

export const IDENTITY: ViewTransform = { scale: 1, x: 0, y: 0 };

/** 배율은 늘 이 범위 안이다. 버튼·휠·핀치가 저마다 자르면 한 곳만 고쳐도 나머지가 남는다. */
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * 그림 전체가 프레임에 들어가는 배율. 늘리지는 않는다(1이 상한) — 작은 그림을 프레임에 맞춰
 * 키우면 글자만 굵어지고 얻는 것이 없다. 그림이나 프레임 크기가 0 이하면(아직 그림이 없거나
 * 프레임이 화면에 없음) 1로 둔다. 프레임 크기는 여백을 뺀 값이다.
 */
export function fitScaleFor(width: number, height: number, frameWidth: number, frameHeight: number): number {
  if (width <= 0 || height <= 0 || frameWidth <= 0 || frameHeight <= 0) return 1;
  return clampScale(Math.min(1, frameWidth / width, frameHeight / height));
}

/** 휠 이벤트 하나가 배율에 곱할 값. 줄 단위 휠은 픽셀로 환산해 트랙패드와 같은 척도로 잰다. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const delta = deltaMode === 1 ? deltaY * WHEEL_LINE_HEIGHT : deltaY;
  return Math.exp(-delta / WHEEL_ZOOM_DISTANCE);
}

/**
 * `anchor` 아래에 있던 그림이 `to` 자리에 머문 채 배율만 `nextScale`로 바뀐 변환. 이 보정이
 * 없으면 확대할 때마다 그림이 중앙으로 끌려가 손가락·커서가 가리키던 곳을 놓친다.
 *
 * 버튼(기준점 = 프레임 중심)·휠(기준점 = 커서)·핀치(기준점이 두 손가락 중점과 함께 움직여
 * `to`가 갈린다)가 같은 식을 쓴다. 바뀐 것이 없으면 같은 객체를 돌려줘 다시 그리지 않게 한다.
 */
export function scaledAround(
  view: ViewTransform,
  nextScale: number,
  anchor: { x: number; y: number },
  to = anchor,
): ViewTransform {
  const scale = clampScale(nextScale);
  if (scale === view.scale && to.x === anchor.x && to.y === anchor.y) return view;
  const ratio = scale / view.scale;
  return {
    scale,
    x: to.x - (anchor.x - view.x) * ratio,
    y: to.y - (anchor.y - view.y) * ratio,
  };
}
