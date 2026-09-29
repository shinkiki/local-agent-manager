/**
 * mermaid 엔진 로딩과 렌더. 엔진은 첫 다이어그램을 만날 때 한 번만 불러온다 —
 * `codeHighlight`의 하이라이터 싱글턴과 같은 형태이고, 같은 이유로 실패한 약속은
 * 캐시에서 지워 다음 다이어그램이 다시 시도할 수 있게 한다.
 *
 * 엔진은 앱 시작 묶음에 들어가지 않는다. 여기서 `import("mermaid")`를 함수 안에 두면
 * 빌드가 따로 청크를 떼므로, 다이어그램이 없는 화면은 이 코드를 받지 않는다.
 *
 * 바깥에 내놓는 것은 `renderMermaid` 하나다. 로딩은 그 함수가 알아서 하는 일이고,
 * 내놓아 두면 호출부가 엔진 객체를 직접 잡아 `render`를 부를 수 있게 되는데 그 경로에는
 * 실패한 원문을 걸러 내는 `parse`가 없다(엔진이 오류 그림을 document.body에 붙인다).
 */

type MermaidApi = (typeof import("mermaid"))["default"];

let enginePromise: Promise<MermaidApi> | null = null;

/**
 * 엔진을 불러 초기화한다.
 *
 * - `securityLevel: "strict"` — 원문이 에이전트 답변에서 오므로 라벨의 HTML을 엔진이 걸러야 한다.
 *   다만 이것만으로는 부족하다: strict가 막는 것은 `click A call fn()`(JS 콜백)이고,
 *   `click A href "..."`는 strict에서도 `<a target="_blank">`로 그려진다. 그 앵커는 삽입 전에
 *   `MermaidBlock`이 걷어내고 앱이 직접 연다(`diagramLinks`).
 * - `htmlLabels: false` — 라벨을 foreignObject 안의 HTML이 아니라 SVG 글자로 그린다. 에이전트가
 *   쓴 문자열을 웹뷰 DOM에 HTML로 넣지 않는 것이 요점이고, 덤으로 스타일이 앱 CSS와 섞이지
 *   않고 크기 계산도 SVG 안에서 끝난다. 굵게·기울임·`<br/>` 줄바꿈은 이 설정에서도 그려진다
 *   (엔진이 tspan으로 옮긴다). 키는 반드시 루트에 둔다 — `flowchart.htmlLabels`는 폐기 예정이라
 *   같은 효과를 내면서 매 렌더마다 경고를 남긴다.
 * - `deterministicIds: true` — 같은 다이어그램을 다시 그려도 내부 id가 흔들리지 않는다.
 * - 글꼴은 본문에서 읽어 넘긴다. 기본값(trebuchet)은 앱 화면에서 혼자 튀고, 라벨 크기 계산도
 *   실제로 그릴 글꼴로 해야 글자가 상자를 넘지 않는다.
 */
function loadMermaid(): Promise<MermaidApi> {
  if (!enginePromise) {
    enginePromise = import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          deterministicIds: true,
          htmlLabels: false,
          fontFamily: window.getComputedStyle(document.body).fontFamily || undefined,
        });
        registerDiagramIcons(mermaid);
        return mermaid;
      })
      .catch((error: unknown) => {
        enginePromise = null;
        throw error;
      });
  }
  return enginePromise;
}

/**
 * 아이콘 팩을 엔진에 등록한다. `architecture` 다이어그램의 `icon(logos:aws)` 같은 표기가
 * 이 등록 없이는 대체 표식으로 떨어진다.
 *
 * 팩을 통째로(아이콘 2,174개 · gzip 2.8MB) 등록하되 **로더를 비동기로 준다.** 그래서 팩
 * 청크는 다이어그램이 아이콘을 실제로 찾을 때 한 번만 내려온다 — 아이콘을 쓰지 않는
 * 다이어그램은 물론이고, 엔진을 부르기만 한 화면도 이 무게를 받지 않는다.
 *
 * 화면(애드온 → Mermaid)의 서비스 표식은 이 팩을 런타임에 쓰지 않는다. 그쪽은 화면이 뜨는
 * 즉시 필요해 지연 로딩이 답이 아니므로, 쓰는 이름만 빌드 시점에 인라인한다
 * (`scripts/generate-service-icons.mjs`).
 */
function registerDiagramIcons(mermaid: MermaidApi): void {
  mermaid.registerIconPacks([{
    name: "logos",
    loader: () => import("@iconify-json/logos").then((module) => module.icons),
  }]);
}

/**
 * 원문을 SVG 문자열로 바꾼다. 그릴 수 없는 원문이면 null이다.
 *
 * 먼저 `parse`로 걸러내는 것이 핵심이다. 곧바로 `render`를 부르면 실패한 엔진이 오류
 * 그림을 `document.body`에 직접 붙여, 화면 아무 곳에나 빨간 상자가 남는다. 스트리밍으로
 * 반쯤 도착한 원문이 흔한 자리라 이 실패는 예외가 아니라 정상 경로다.
 *
 * 테마는 초기화가 아니라 원문 머리의 init 지시로 넘긴다. 초기화를 렌더마다 다시 부르면
 * 동시에 그리는 다이어그램들이 서로의 전역 설정을 덮어쓴다.
 */
export async function renderMermaid(id: string, source: string, dark: boolean): Promise<string | null> {
  const mermaid = await loadMermaid();
  const text = `%%{init: {"theme": "${dark ? "dark" : "default"}"}}%%\n${source}`;
  const parsed = await mermaid.parse(text, { suppressErrors: true });
  if (!parsed) return null;
  const { svg } = await mermaid.render(id, text);
  return svg;
}
