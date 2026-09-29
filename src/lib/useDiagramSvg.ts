import { useEffect, useId, useState } from "react";
import { parseDiagramSvg } from "./mermaidSvg.ts";
import { renderMermaid } from "./mermaidEngine.ts";

/**
 * 그리기 상태. 실패를 두 갈래로 나누는 것이 이 타입의 존재 이유다 — 문법이 아니어서 못
 * 그린 것(문서 쪽 문제, 알려 줄 값이 있다)과 엔진을 못 받은 것(앱 쪽 문제, 사용자가 할
 * 수 있는 일이 없다)은 같은 폴백을 쓰지만 안내가 달라야 한다.
 */
type DiagramStatus = "loading" | "ready" | "invalid" | "unavailable";

interface DiagramRender {
  /** 문서에 붙일 수 있게 위생 처리까지 끝난 노드. 상태가 ready일 때만 값이 있다. */
  node: SVGElement | null;
  status: DiagramStatus;
}

/**
 * 원문을 그림 노드로 바꾼다. 인라인 블록과 확대 보기·별도 창이 같은 훅을 쓰므로,
 * 엔진 호출·테마 추적·위생 처리가 화면마다 갈라지지 않는다.
 */
export function useDiagramSvg(source: string): DiagramRender {
  const dark = useEffectiveDark();
  const [render, setRender] = useState<DiagramRender>({ node: null, status: "loading" });
  // useId는 `:r1:`처럼 콜론이 섞인 값을 준다. 엔진이 이 값을 엘리먼트 id와 CSS 선택자에
  // 함께 쓰므로, 선택자에서 쓸 수 없는 글자를 걷어낸 뒤 넘긴다.
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    let cancelled = false;
    setRender({ node: null, status: "loading" });
    void renderMermaid(id, source, dark)
      .then((svg) => {
        if (cancelled) return;
        const node = svg ? parseDiagramSvg(svg) : null;
        setRender(node ? { node, status: "ready" } : { node: null, status: "invalid" });
      })
      .catch(() => {
        // 엔진을 아예 못 받는 환경(오프라인 원격, 옛 셸의 자산 404)이 이 갈래다.
        if (!cancelled) setRender({ node: null, status: "unavailable" });
      });
    return () => { cancelled = true; };
  }, [dark, id, source]);

  return render;
}

/**
 * 지금 화면이 어두운 테마인지. 테마 모드는 `auto`가 기본이라 저장값만 봐서는 알 수 없고,
 * 어두움·밝음을 가르는 규칙은 CSS에 있다(`color-scheme`). 그래서 규칙을 여기서 다시 적지
 * 않고 적용된 결과를 읽는다 — 설정에서 모드를 바꾸면 `data-theme`이 바뀌고, `auto`인
 * 상태에서 OS 설정이 바뀌면 미디어 질의가 알려 준다.
 */
export function useEffectiveDark(): boolean {
  const [dark, setDark] = useState(effectiveDark);
  useEffect(() => {
    const update = () => setDark(effectiveDark());
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    update();
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  return dark;
}

function effectiveDark(): boolean {
  return window.getComputedStyle(document.documentElement).colorScheme.includes("dark");
}
