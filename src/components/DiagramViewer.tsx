import { Copy, Download, Minus, Plus, Scan } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { copyDiagramPng, saveDiagramPng, saveDiagramSvg } from "../lib/diagramImage";
import { diagramLinkAt } from "../lib/mermaidSvg";
import { useI18n } from "../lib/i18n";
import { useDiagramSvg } from "../lib/useDiagramSvg";
import { openDiagramLink } from "../lib/diagramLinkOpener";
import { DiagramCanvas, useDiagramNotice } from "./DiagramCanvas";
import { ErrorBanner, LoadingState } from "./Shared";

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
/** 버튼 한 번의 배율 변화. 휠·핀치는 손의 움직임에 비례하므로 이 값을 쓰지 않는다. */
const SCALE_STEP = 1.25;

/**
 * 휠 한 칸이 얼마나 확대할지. 배율은 곱으로 움직이므로 `exp(-delta/거리)`를 쓴다 —
 * 칸 단위로 딱딱 끊기는 마우스 휠(한 번에 100px 남짓)과 픽셀 단위로 잘게 오는 트랙패드가
 * **같은 손놀림에 같은 만큼** 확대돼야 한다. 고정 배수를 쓰면 트랙패드에서 이벤트가 수십 번
 * 쏟아지며 순식간에 최대 배율까지 튄다.
 */
const WHEEL_ZOOM_DISTANCE = 400;

/** 줄 단위로 오는 휠(deltaMode 1)을 픽셀로 환산하는 값. */
const WHEEL_LINE_HEIGHT = 16;

interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: ViewTransform = { scale: 1, x: 0, y: 0 };

/** 맞춤 배율을 잴 때 프레임 가장자리에 남기는 여백. 상자가 테두리에 붙어 잘려 보이지 않게 한다. */
const FIT_MARGIN = 16;

/** 배율은 늘 이 범위 안이다. 버튼·휠·핀치가 저마다 자르면 한 곳만 고쳐도 나머지가 남는다. */
function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * 그림을 원문이 정한 크기로 고정한다.
 *
 * 엔진이 준 SVG는 `width="100%"`로 온다. 담는 상자가 넓으면 그림이 그만큼 늘어나고 세로는
 * 비율대로 따라 늘어나므로, **화면이 넓을수록 그림이 세로로 길어져** 프레임을 넘는다.
 * 확대·축소는 변환(transform)으로 걸리니 레이아웃 크기는 여기서 한 번 못박는 편이 낫다 —
 * 그래야 맞춤 배율을 잴 기준이 생기고, 상자가 프레임 안에서 가운데로 놓인다.
 */
function applyNaturalSize(svg: SVGElement): void {
  const box = (svg as SVGSVGElement).viewBox?.baseVal;
  if (!box || box.width <= 0 || box.height <= 0) return;
  svg.style.width = `${box.width}px`;
  svg.style.height = `${box.height}px`;
}

/**
 * 그림 전체가 프레임에 들어가는 배율. 처음 보는 배율이 이것이어야 하는 이유는, 원문이 정한
 * 크기가 프레임보다 큰 일이 흔하기 때문이다 — 계약 하나에 상자가 열 개만 되어도 세로로
 * 프레임을 넘고, 그러면 사용자는 무엇이 그려졌는지 보기 전에 먼저 축소부터 해야 한다.
 *
 * 늘리지는 않는다(1이 상한). 작은 그림을 프레임에 맞춰 키우면 글자만 굵어지고 얻는 것이 없다.
 * 아직 그림이 없거나 프레임이 화면에 없을 때(폭·높이 0)는 1로 둔다.
 */
function fitScale(frame: HTMLDivElement): number {
  const canvas = frame.querySelector<HTMLElement>(".diagram-viewer-canvas");
  // 배율은 변환(transform)으로 걸리므로 레이아웃 크기(offset*)를 재야 배율이 섞이지 않는다.
  const width = canvas?.offsetWidth ?? 0;
  const height = canvas?.offsetHeight ?? 0;
  const frameWidth = frame.clientWidth - FIT_MARGIN;
  const frameHeight = frame.clientHeight - FIT_MARGIN;
  if (width <= 0 || height <= 0 || frameWidth <= 0 || frameHeight <= 0) return 1;
  return clampScale(Math.min(1, frameWidth / width, frameHeight / height));
}

/**
 * `anchor` 아래에 있던 그림이 `to` 자리에 머문 채 배율만 `nextScale`로 바뀐 변환. 이 보정이
 * 없으면 확대할 때마다 그림이 중앙으로 끌려가 손가락·커서가 가리키던 곳을 놓친다.
 *
 * 버튼(기준점 = 프레임 중심)·휠(기준점 = 커서)·핀치(기준점이 두 손가락 중점과 함께 움직여
 * `to`가 갈린다)가 같은 식을 쓴다. 셋이 따로 적혀 있으면 한 조작에서만 어긋나는 확대가
 * 생기고, 그건 손으로 만져 보기 전까지 드러나지 않는다.
 */
function scaledAround(view: ViewTransform, nextScale: number, anchor: { x: number; y: number }, to = anchor): ViewTransform {
  const scale = clampScale(nextScale);
  if (scale === view.scale && to.x === anchor.x && to.y === anchor.y) return view;
  const ratio = scale / view.scale;
  return {
    scale,
    x: to.x - (anchor.x - view.x) * ratio,
    y: to.y - (anchor.y - view.y) * ratio,
  };
}

/** 진행 중인 손짓. 손가락 하나면 이동, 둘이면 확대다. 시작 시점의 상태를 함께 들고 있어야 누적 오차가 없다. */
type Gesture =
  | { kind: "pan"; pointerId: number; from: { x: number; y: number }; view: ViewTransform }
  | { kind: "pinch"; ids: [number, number]; distance: number; center: { x: number; y: number }; view: ViewTransform };

/**
 * 프레임 하나의 확대·이동 상태와 그것을 움직이는 입력을 한 벌로 들고 있는 훅. 배율을 바꾸는
 * 길은 버튼·휠·핀치 셋이고 이동은 한 손가락 끌기인데, 넷이 같은 `view` 하나를 두고 기준점만
 * 달리 잡는다. 그래서 상태와 입력 처리를 한 자리에 묶어 두고 화면 쪽에는 결과와 창구만 넘긴다.
 */
function useDiagramView() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<ViewTransform>(IDENTITY);
  /** 화면에 닿아 있는 포인터. 손가락 수로 이동·확대를 가르므로 개수를 알아야 한다. */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<Gesture | null>(null);

  /** 화면 좌표를 프레임 중심 기준으로 옮긴다. 확대·이동 계산은 모두 이 좌표계에서 한다. */
  const framePoint = useCallback((clientX: number, clientY: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  }, []);

  /** 프레임에 맞춰 처음 자리로. 그림이 바뀌었을 때·버튼·두 번 누르기가 같은 자리로 돌아온다. */
  const reset = useCallback(() => {
    const frame = frameRef.current;
    setView(frame ? { ...IDENTITY, scale: fitScale(frame) } : IDENTITY);
  }, []);

  /** 버튼용. 기준점은 프레임 중심이라 그림이 제자리에서 커지고 작아진다. */
  const zoomBy = useCallback((factor: number) => {
    setView((current) => scaledAround(current, current.scale * factor, { x: 0, y: 0 }));
  }, []);

  // 휠 확대는 브라우저 확대·스크롤을 막아야 하므로 passive가 아닌 리스너로 붙인다.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * WHEEL_LINE_HEIGHT : event.deltaY;
      // 기준점은 갱신자 밖에서 읽는다 — setView 갱신자는 같은 값으로 두 번 불릴 수 있어
      // 그 안에서 프레임 위치를 재는 것은 순수하지 않다.
      const anchor = framePoint(event.clientX, event.clientY);
      setView((current) => scaledAround(current, current.scale * Math.exp(-delta / WHEEL_ZOOM_DISTANCE), anchor));
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, [framePoint]);

  /** 지금 닿아 있는 포인터로 손짓을 다시 정한다. 손가락이 하나 늘거나 줄 때마다 부른다. */
  const restartGesture = useCallback(() => {
    const pointers = [...pointersRef.current.entries()];
    if (pointers.length >= 2) {
      const [[firstId, first], [secondId, second]] = pointers.slice(-2);
      gestureRef.current = {
        kind: "pinch",
        ids: [firstId, secondId],
        distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
        center: framePoint((first.x + second.x) / 2, (first.y + second.y) / 2),
        view,
      };
      return;
    }
    if (pointers.length === 1) {
      const [pointerId, point] = pointers[0];
      gestureRef.current = { kind: "pan", pointerId, from: point, view };
      return;
    }
    gestureRef.current = null;
  }, [framePoint, view]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 링크를 누른 것이면 손짓을 시작하지 않는다 — 시작하면 클릭이 이동으로 먹힌다.
    if (event.button !== 0 || diagramLinkAt(event.target)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      // 프레임 밖으로 손이 나가도 손짓이 이어지게 붙잡는다. 붙잡을 수 없는 포인터면(합성
      // 이벤트·이미 끝난 포인터) 프레임 위에서만 이어지므로 실패를 삼킨다.
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch { /* 캡처 없이 진행한다. */ }
    restartGesture();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const gesture = gestureRef.current;
    if (!gesture) return;

    if (gesture.kind === "pan") {
      if (gesture.pointerId !== event.pointerId) return;
      setView({
        scale: gesture.view.scale,
        x: gesture.view.x + (event.clientX - gesture.from.x),
        y: gesture.view.y + (event.clientY - gesture.from.y),
      });
      return;
    }

    const first = pointers.get(gesture.ids[0]);
    const second = pointers.get(gesture.ids[1]);
    if (!first || !second) return;
    const distance = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
    const center = framePoint((first.x + second.x) / 2, (first.y + second.y) / 2);
    // 손짓 시작 시점의 변환에서 다시 계산해야 누적 오차가 없다. 두 손가락의 중점이 움직이면
    // 그림도 함께 따라가므로, 시작 중점을 지금 중점 자리로 옮기는 형태가 된다 — 핀치 도중의
    // 이동까지 한 손짓으로 다룬다.
    setView(scaledAround(gesture.view, gesture.view.scale * (distance / gesture.distance), gesture.center, center));
  };

  const releasePointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.delete(event.pointerId)) return;
    restartGesture();
  };

  return {
    view,
    reset,
    zoomBy,
    /** 프레임 div에 그대로 펼친다. 손짓은 프레임이 받아야 캡처와 좌표계가 맞는다. */
    frameProps: {
      ref: frameRef,
      onPointerDown,
      onPointerMove,
      onPointerUp: releasePointer,
      onPointerCancel: releasePointer,
      onLostPointerCapture: releasePointer,
      onDoubleClick: reset,
    },
  };
}

/**
 * 확대·이동이 되는 다이어그램 보기. 확대 보기 모달과 별도 창이 같은 부품을 쓴다 — 두 자리의
 * 배율·이동·내보내기가 갈라지면 같은 그림이 창에 따라 다르게 움직인다.
 *
 * 조작은 셸마다 다른 것을 쓴다. 데스크톱은 휠(트랙패드 두 손가락·맥 핀치 포함), 손가락
 * 화면은 두 손가락 핀치, 양쪽 모두 한 손가락(또는 마우스 끌기)으로 이동한다. 프레임에
 * `touch-action: none`을 걸어 브라우저가 그 제스처를 먼저 가져가지 못하게 하므로, 핀치를
 * 우리가 처리하지 않으면 손가락 화면에서는 확대할 방법이 아예 없다.
 *
 * 원문에서 다시 그리는 이유는 별도 창 때문이다. 새 창은 본 창의 DOM을 볼 수 없고 저장소에서
 * 원문만 받아 오므로, 이 부품이 원문 하나로 자립해야 한다. 엔진은 이미 받아 둔 상태라 다시
 * 그리는 비용은 거의 없다.
 */
export function DiagramViewer({ source, fileName, onOpenLocalLink }: {
  source: string;
  fileName: string;
  /** 문서 화면에서 띄운 보기만 로컬 파일을 열 수 있다. 별도 창에는 없다. */
  onOpenLocalLink?: (href: string) => void;
}) {
  const { text } = useI18n();
  const { node, status } = useDiagramSvg(source);
  const { view, reset, zoomBy, frameProps } = useDiagramView();
  const { notice, setNotice, run } = useDiagramNotice();

  // 다른 그림이 오면 배율·위치를 처음으로 돌린다. 앞 그림에 맞춰 두었던 변환이 남으면 새
  // 그림이 화면 밖에서 시작하는 일이 생긴다. 이 효과는 그림을 붙이는 자식 효과 뒤에 도므로
  // (React는 자식 효과를 먼저 돌린다) 여기서 재는 크기는 이미 붙은 그림의 크기다.
  useEffect(() => {
    if (!node) return;
    applyNaturalSize(node);
    reset();
  }, [node, reset]);

  const background = () => {
    const frame = frameProps.ref.current;
    return frame ? window.getComputedStyle(frame).backgroundColor : undefined;
  };

  return (
    <div className="diagram-viewer" data-state={status}>
      <DiagramViewerToolbar
        node={node}
        fileName={fileName}
        scale={view.scale}
        zoomBy={zoomBy}
        reset={reset}
        run={run}
        background={background}
      />

      {notice ? <p className="diagram-viewer-notice">{notice}</p> : null}

      <div
        className="diagram-viewer-frame"
        {...frameProps}
        onClick={(event) => openDiagramLink(event, setNotice, onOpenLocalLink)}
      >
        {status === "loading" ? <LoadingState label={text("다이어그램을 그리는 중입니다", "Drawing the diagram")} /> : null}
        {status === "invalid" ? <ErrorBanner message={text("mermaid 다이어그램 문법이 아닙니다.", "Not valid mermaid syntax.")} /> : null}
        {status === "unavailable" ? <ErrorBanner message={text("다이어그램 엔진을 불러올 수 없습니다.", "The diagram engine could not be loaded.")} /> : null}
        {status === "ready" ? <DiagramCanvas
          className="diagram-viewer-canvas"
          node={node}
          // `-50%` 두 번이 상자의 중심을 프레임 중심에 올린다(자리는 CSS의 top·left 50%).
          // 그 뒤에 이동과 배율을 얹으므로 손짓 계산은 프레임 중심 기준 그대로 맞는다.
          style={{ transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        /> : null}
      </div>
    </div>
  );
}

/**
 * 배율 손잡이와 내보내기 버튼이 있는 도구줄. 보기 본체는 그림을 그리고 손짓을 받는 일만
 * 하면 되므로 버튼 묶음은 여기로 뺀다.
 */
function DiagramViewerToolbar({ node, fileName, scale, zoomBy, reset, run, background }: {
  node: SVGElement | null;
  fileName: string;
  scale: number;
  zoomBy: (factor: number) => void;
  reset: () => void;
  run: (action: () => Promise<void>, done?: string) => void;
  /** 프레임의 배경색. PNG는 투명 배경 대신 보던 그대로의 바탕을 깔아야 읽힌다. */
  background: () => string | undefined;
}) {
  const { text } = useI18n();
  // 세 버튼은 아이콘·문구·수행할 일만 다르고 그림이 없으면 눌리지 않는 골격이 같다.
  // 같은 줄을 세 번 적으면 한쪽만 고쳐지는 자리가 생기므로 표로 세운다.
  const exports: { key: string; icon: ReactNode; label: string; done: string; act: (svg: SVGElement) => Promise<void> }[] = [
    {
      key: "copy",
      icon: <Copy size={13} />,
      label: text("그림 복사", "Copy image"),
      done: text("그림을 복사했습니다.", "Diagram copied."),
      act: (svg) => copyDiagramPng(svg, background()),
    },
    {
      key: "png",
      icon: <Download size={13} />,
      label: "PNG",
      done: text("PNG로 저장했습니다.", "Saved as PNG."),
      act: (svg) => saveDiagramPng(svg, `${fileName}.png`, background()),
    },
    {
      key: "svg",
      icon: <Download size={13} />,
      label: "SVG",
      done: text("SVG로 저장했습니다.", "Saved as SVG."),
      act: (svg) => saveDiagramSvg(svg, `${fileName}.svg`),
    },
  ];

  return (
    <div className="diagram-viewer-toolbar">
      <div className="diagram-viewer-zoom">
        <button className="icon-button" type="button" onClick={() => zoomBy(1 / SCALE_STEP)} aria-label={text("축소", "Zoom out")}><Minus size={15} /></button>
        <output aria-label={text("배율", "Zoom level")}>{Math.round(scale * 100)}%</output>
        <button className="icon-button" type="button" onClick={() => zoomBy(SCALE_STEP)} aria-label={text("확대", "Zoom in")}><Plus size={15} /></button>
        <button className="icon-button" type="button" onClick={reset} aria-label={text("화면에 맞추기", "Fit to frame")} title={text("화면에 맞추기", "Fit to frame")}><Scan size={15} /></button>
        <small>{text("휠·핀치로 확대, 끌어서 이동", "Wheel or pinch to zoom, drag to pan")}</small>
      </div>
      <div className="diagram-viewer-exports">
        {exports.map((entry) => (
          <button
            key={entry.key}
            className="button compact"
            type="button"
            disabled={!node}
            onClick={() => node && run(() => entry.act(node), entry.done)}
          >{entry.icon}{entry.label}</button>
        ))}
      </div>
    </div>
  );
}
