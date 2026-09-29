import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { errorText } from "../lib/errorText";

/**
 * 그려진 SVG 상자를 담는 자리. 인라인 블록(`MermaidBlock`)과 확대·이동 보기(`DiagramViewer`)가
 * 같은 부품을 쓴다 — 붙이는 일 자체는 같고, 다른 것은 감싼 자리의 배율·클릭 처리뿐이다.
 *
 * 그림은 React가 아니라 이 효과가 채운다. mermaid가 만들어 준 것은 이미 완성된 DOM 노드라
 * JSX로 다시 표현할 수 없고, 그래서 상자는 계속 붙어 있어야 채울 자리가 있다.
 */
export function DiagramCanvas({ node, className, style, onClick }: {
  /** 아직 안 그려졌으면 `null`. 그 사이 상자는 비어 있다. */
  node: SVGElement | null;
  className: string;
  style?: CSSProperties;
  onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !node) return;
    host.replaceChildren(node);
    return () => host.replaceChildren();
  }, [node]);

  return <div className={className} ref={hostRef} style={style} onClick={onClick} />;
}

/**
 * 그림 도구줄이 알림 한 줄을 다루는 방식. 복사·저장·새 창 열기·링크 열기가 모두 같은 자리에
 * 한 줄로 결과를 적으므로, 지난 알림을 지우고 실패를 문구로 바꾸는 배선이 부품마다 되풀이됐다.
 *
 * `run`은 기다리지 않고 시작만 시킨다. 새 창 열기는 팝업 차단을 피하려고 클릭과 같은 처리
 * 흐름에 있어야 하고, 나머지도 그림 저장이 끝날 때까지 도구줄을 묶어 둘 이유가 없다.
 * `setNotice`를 함께 내주는 것은 링크 열기(`openDiagramLink`)처럼 스스로 문구를 적는 쪽이
 * 있기 때문이다.
 */
export function useDiagramNotice() {
  const [notice, setNotice] = useState<string | null>(null);
  /** `done`을 주면 성공했을 때 그 문구를 남기고, 주지 않으면 알림 없이 조용히 끝난다. */
  const run = useCallback((action: () => Promise<void>, done?: string) => {
    setNotice(null);
    void action().then(() => setNotice(done ?? null)).catch((cause: unknown) => setNotice(errorText(cause)));
  }, []);
  return { notice, setNotice, run };
}
