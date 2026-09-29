import { diagramLinkAction, type DiagramLinkAction } from "./diagramLinks.ts";

/**
 * 위생 처리를 통과해 속성으로 남는 링크. 차단된 갈래는 속성을 아예 심지 않으므로,
 * 읽는 쪽이 마주치는 값은 허용 갈래뿐이다 — 그 사실을 타입으로 적어 둔다.
 */
type DiagramLinkTarget = Exclude<DiagramLinkAction, { kind: "blocked" }>;

/**
 * 앵커에서 걷어낸 주소를 다시 심는 자리. 클릭 위임이 이 표시를 보고 갈래를 정한다.
 *
 * 이름은 이 파일 밖으로 내보내지 않는다. 심는 쪽(`sanitizeDiagramSvg`)과 읽는 쪽
 * (`diagramLinkAt`)이 모두 여기 있고, 화면은 속성 이름을 CSS 선택자로만 쓴다
 * (`.markdown-mermaid-canvas [data-diagram-link]`). 내보내 두면 컴포넌트가 속성을 직접
 * 읽어 링크를 해석하는 두 번째 경로가 생기는데, 그쪽에는 허용 갈래 판정이 없다.
 */
const DIAGRAM_LINK_ATTR = "data-diagram-link";
const DIAGRAM_LINK_KIND_ATTR = "data-diagram-link-kind";

const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * 엔진이 준 SVG 문자열을 문서에 붙일 수 있는 노드로 만든다. 붙일 수 없는 문자열이면 null.
 *
 * 파싱을 `image/svg+xml`이 아니라 `text/html`로 하는 이유는 관용성이다. XML 파서는 사소한
 * 어긋남에도 문서 전체를 오류로 돌려주고, HTML 파서는 SVG를 foreign content로 제대로
 * 다루면서(viewBox 같은 대소문자 구분 속성 포함) 그런 어긋남을 넘긴다.
 *
 * 파싱만으로는 스크립트가 실행되지 않지만, 붙일 때는 실행될 수 있다. 그래서 위생 처리는
 * 여기서 끝내고 호출부는 결과 노드만 문서에 넣는다.
 */
export function parseDiagramSvg(svg: string): SVGElement | null {
  const parsed = new DOMParser().parseFromString(svg, "text/html").body.querySelector("svg");
  if (!parsed) return null;
  sanitizeDiagramSvg(parsed);
  return parsed;
}

/**
 * 붙이기 전에 실행되거나 화면을 떠날 수 있는 것을 걷어낸다. 엔진이 strict로 라벨을 이미
 * 걸러 주지만, 그림의 원문은 에이전트 답변이라 우리 쪽에서도 한 겹 본다.
 *
 * 세 가지를 지운다.
 *  - `<script>` — 노드로 붙이면 실행된다.
 *  - `on*` 속성 — 이벤트 처리기는 어떤 태그에도 붙을 수 있다.
 *  - 앵커의 `href`·`target` — 남겨 두면 네이티브 웹뷰가 그 주소로 이동해 앱 화면이 사라진다.
 *    허용 갈래는 `data-diagram-link`로 옮겨, 앱이 자기 방식으로 연다.
 */
function sanitizeDiagramSvg(root: SVGElement): void {
  for (const script of root.querySelectorAll("script")) script.remove();

  removeEventHandlers(root);
  for (const anchor of root.querySelectorAll("a")) sanitizeDiagramAnchor(anchor);
}

/** 루트와 모든 자손에서 DOM 이벤트 처리기 속성을 걷어낸다. */
function removeEventHandlers(root: SVGElement): void {
  for (const element of [root, ...root.querySelectorAll<Element>("*")]) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
    }
  }
}

/** SVG 앵커의 브라우저 이동을 막고 허용된 주소만 앱이 처리할 메타데이터로 옮긴다. */
function sanitizeDiagramAnchor(anchor: Element): void {
  // HTML 파서는 `xlink:href`를 XLink 이름공간으로 옮기므로 두 자리를 모두 본다.
  const raw = anchor.getAttribute("href") ?? anchor.getAttributeNS(XLINK_NS, "href");
  anchor.removeAttribute("href");
  anchor.removeAttributeNS(XLINK_NS, "href");
  anchor.removeAttribute("target");
  const action = diagramLinkAction(raw);
  if (action.kind === "blocked") return;
  anchor.setAttribute(DIAGRAM_LINK_ATTR, action.href);
  anchor.setAttribute(DIAGRAM_LINK_KIND_ATTR, action.kind);
  // 앵커가 아니게 됐으므로 역할과 초점을 손으로 돌려준다.
  anchor.setAttribute("role", "link");
  anchor.setAttribute("tabindex", "0");
}

/**
 * 속성에 적힌 갈래 이름을 갈래로 되돌린다. DOM을 거치면 어떤 문자열이든 올 수 있는데,
 * 여는 쪽은 "로컬 파일인가 아닌가"만 가르므로 로컬이 아닌 값은 전부 외부 주소로 본다 —
 * 속성이 비거나 모르는 이름일 때 지금까지 흘러가던 갈래와 같다.
 */
function diagramLinkKind(value: string | null): DiagramLinkTarget["kind"] {
  return value === "local" ? "local" : "external";
}

/**
 * 눌린 자리에서 위로 올라가 다이어그램 링크를 찾는다. 링크 밖이면 null.
 *
 * 갈래를 `string`으로 내놓지 않는 이유는 이 값이 바로 위 `sanitizeDiagramAnchor`가 심은
 * 것이기 때문이다. 심는 쪽은 `DiagramLinkAction`의 갈래를 그대로 쓰는데 읽는 쪽만 임의
 * 문자열로 받으면, 같은 속성의 값 범위가 한 파일 안에서 두 가지로 적히고 여는 쪽
 * (`diagramLinkOpener`)은 `"local"`과 비교하는 근거를 타입에서 얻지 못한다.
 */
export function diagramLinkAt(target: EventTarget | null): DiagramLinkTarget | null {
  const element = target instanceof Element ? target.closest(`[${DIAGRAM_LINK_ATTR}]`) : null;
  const href = element?.getAttribute(DIAGRAM_LINK_ATTR);
  return href ? { kind: diagramLinkKind(element?.getAttribute(DIAGRAM_LINK_KIND_ATTR) ?? null), href } : null;
}
