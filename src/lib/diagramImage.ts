import { saveBlobAsFile } from "./fileSave.ts";

/**
 * 다이어그램을 그림 파일로 내보내는 통로. 화면에 붙어 있는 SVG 노드를 그대로 쓰므로
 * 엔진을 다시 부르지 않는다.
 *
 * PNG는 화면 배율의 두 배로 그린다. 문서·메신저에 붙여 넣는 자리가 대개 화면보다 촘촘해,
 * 1배로 만들면 글자가 흐릿하게 남는다.
 */
const PNG_SCALE = 2;

/** 붙여 넣을 자리를 모르는 그림에 투명 배경을 주면 글자가 사라진다. 배경을 칠해 내보낸다. */
const DEFAULT_BACKGROUND = "#ffffff";

/**
 * 내보낼 SVG 한 벌 — 독립적인 문서 문자열과 그 문서에 박아 넣은 크기.
 *
 * 크기와 문자열은 나뉠 수 없는 한 벌이다. 문서에 박히는 width·height와 PNG 캔버스가 쓰는
 * 크기가 같은 값이어야 하는데, 두 자리가 각자 `diagramSize(node)`를 부르는 동안은 그 사이에
 * 레이아웃이 움직이면(창 크기 변경·펼침 애니메이션) 서로 다른 크기가 나온다. `viewBox`가
 * 없는 그림은 화면에 그려진 크기를 재므로 실제로 일어날 수 있는 일이고, 그때 캔버스는 문서에
 * 적힌 것과 다른 비율로 그려 내보낸 그림이 늘어난다. 한 번만 재서 함께 나른다.
 */
interface DiagramSvgDocument {
  text: string;
  width: number;
  height: number;
}

/**
 * 노드를 독립적인 SVG 문서로 만든다. 화면에 붙어 있는 노드는 이름공간 선언 없이도
 * 그려지지만, 파일로 나가면 그 선언이 없는 SVG는 어디서도 열리지 않는다.
 */
function diagramSvgDocument(node: SVGElement): DiagramSvgDocument {
  const clone = node.cloneNode(true) as SVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  const { width, height } = diagramSize(node);
  // 엔진은 너비를 100%로 두는 경우가 있어, 파일로 나갈 때는 실제 크기를 박아 준다.
  clone.setAttribute("width", String(Math.round(width)));
  clone.setAttribute("height", String(Math.round(height)));
  return { text: new XMLSerializer().serializeToString(clone), width, height };
}

/**
 * 그림의 실제 크기. `viewBox`가 있으면 그것이 원본 좌표계이므로 먼저 보고, 없으면 화면에
 * 그려진 크기를 쓴다. 둘 다 못 얻으면 0이 아닌 최소값으로 떨어뜨려 캔버스 생성이 실패하지
 * 않게 한다.
 */
function diagramSize(node: SVGElement): { width: number; height: number } {
  const viewBox = node.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every((value) => Number.isFinite(value)) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: viewBox[2], height: viewBox[3] };
  }
  const rect = node.getBoundingClientRect();
  return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
}

/** SVG blob URL이 가리키는 그림을 모두 읽을 때까지 기다린다. */
async function loadDiagramImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("다이어그램을 그림으로 읽지 못했습니다."));
    image.src = url;
  });
  return image;
}

/** 읽은 그림을 지정한 배경과 배율로 캔버스에 그린다. */
function drawDiagramCanvas(
  image: HTMLImageElement,
  width: number,
  height: number,
  background: string,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * PNG_SCALE));
  canvas.height = Math.max(1, Math.round(height * PNG_SCALE));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("이 브라우저에서 그림을 만들 수 없습니다.");
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** 캔버스의 비동기 변환 결과가 비어 있으면 저장 가능한 그림이 아니라고 알린다. */
async function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("그림 파일을 만들지 못했습니다.");
  return blob;
}

/**
 * SVG를 PNG로 굽는다. blob URL로 만든 `<img>`를 캔버스에 그리는 방식이라 같은 origin이고,
 * CSP의 `img-src`가 이미 `blob:`을 허용한다. 라벨이 SVG 글자(htmlLabels 꺼짐)라 외부
 * 참조가 없어 캔버스가 오염되지 않는다.
 */
async function diagramPngBlob(node: SVGElement, background = DEFAULT_BACKGROUND): Promise<Blob> {
  const { text, width, height } = diagramSvgDocument(node);
  const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
  try {
    const image = await loadDiagramImage(url);
    return await canvasPngBlob(drawDiagramCanvas(image, width, height, background));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * PNG를 클립보드에 담는다. 그림 복사는 글자 복사와 달리 지원하지 않는 브라우저가 있어,
 * 없으면 그 사실을 문구로 올린다(호출부가 실패를 보여 준다).
 */
export async function copyDiagramPng(node: SVGElement, background?: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("이 브라우저는 그림 복사를 지원하지 않습니다. 파일로 저장해 주세요.");
  }
  const blob = await diagramPngBlob(node, background);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export function saveDiagramPng(node: SVGElement, fileName: string, background?: string): Promise<void> {
  return diagramPngBlob(node, background).then((blob) => saveBlobAsFile(blob, fileName, "다이어그램 저장"));
}

export function saveDiagramSvg(node: SVGElement, fileName: string): Promise<void> {
  const blob = new Blob([diagramSvgDocument(node).text], { type: "image/svg+xml" });
  return saveBlobAsFile(blob, fileName, "다이어그램 저장");
}
