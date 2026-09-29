import { errorText } from "./errorText.ts";
import { openExternalUrl } from "./externalUrl.ts";
import { diagramLinkAt } from "./mermaidSvg.ts";

/**
 * 다이어그램에서 링크를 누른 자리. 인라인 그림과 확대 보기·별도 창이 같은 함수를 쓴다.
 *
 * 앵커의 href는 이미 걷어냈으므로(`mermaidSvg`) 브라우저는 아무 데도 가지 않는다. 여는 일은
 * 전부 여기서 한다 — 외부 주소는 앱이 셸에 맞게 열고, 로컬 파일은 그 화면이 파일을 열 수
 * 있을 때만 넘긴다. 별도 창처럼 문서 화면이 없는 자리에서는 열지 못한다는 사실을 알린다.
 */
export function openDiagramLink(
  event: { target: EventTarget | null; preventDefault: () => void },
  onNotice: (message: string | null) => void,
  onOpenLocalLink?: (href: string) => void,
): void {
  const link = diagramLinkAt(event.target);
  if (!link) return;
  event.preventDefault();
  if (link.kind === "local") {
    if (onOpenLocalLink) onOpenLocalLink(link.href);
    else onNotice(`이 창에서는 파일을 열 수 없습니다: ${link.href}`);
    return;
  }
  onNotice(null);
  void openExternalUrl(link.href).catch((cause: unknown) => onNotice(errorText(cause)));
}
