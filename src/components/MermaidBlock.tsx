import { Copy, Maximize2, SquareArrowOutUpRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copyDiagramPng } from "../lib/diagramImage";
import { openDiagramLink } from "../lib/diagramLinkOpener";
import { diagramPopoutId } from "../lib/diagramPopout";
import { useI18n } from "../lib/i18n";
import { openDiagramWindow } from "../lib/popoutWindow";
import { useDiagramSvg } from "../lib/useDiagramSvg";
import { DiagramCanvas, useDiagramNotice } from "./DiagramCanvas";
import { DiagramViewer } from "./DiagramViewer";
import { DialogCloseButton, DialogSurface, useEscapeToClose } from "./Shared";

/**
 * 마크다운의 mermaid 펜스를 그린 자리. 아직 엔진이 오지 않았거나 그릴 수 없는 원문이면
 * `fallback`(원래의 코드 상자)을 그대로 보여 준다 — 다이어그램이 안 되는 자리에서 내용이
 * 사라지는 것이 가장 나쁜 결과다. 스트리밍으로 반쯤 온 원문은 애초에 여기까지 오지
 * 않는다(닫는 펜스를 만난 블록만 넘어온다).
 *
 * 그림 위에 도구줄이 뜬다. 인라인에서는 크게 보거나 다른 창으로 옮기는 일만 하고, 배율·
 * 내보내기는 확대 보기와 별도 창이 맡는다(`DiagramViewer`) — 대화 흐름 안의 그림 위에
 * 버튼을 여섯 개 얹으면 읽는 데 방해가 된다.
 */
export function MermaidBlock({ source, fallback, onOpenLocalLink }: {
  source: string;
  fallback: ReactNode;
  onOpenLocalLink?: (href: string) => void;
}) {
  const { text, locale } = useI18n();
  const { node, status } = useDiagramSvg(source);
  const { notice, setNotice, run } = useDiagramNotice();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="markdown-mermaid" data-state={status}>
      {status === "ready" ? null : fallback}
      {status === "ready" ? <div className="markdown-mermaid-shell">
        <div className="markdown-mermaid-actions">
          <button className="icon-button" type="button" onClick={() => setExpanded(true)} aria-label={text("확대보기", "Expand")} title={text("확대보기", "Expand")}><Maximize2 size={14} /></button>
          <button className="icon-button" type="button" onClick={() => run(() => openDiagramWindow(source, locale))} aria-label={text("새 창으로 열기", "Open in a new window")} title={text("새 창으로 열기", "Open in a new window")}><SquareArrowOutUpRight size={14} /></button>
          <button
            className="icon-button"
            type="button"
            onClick={() => run(async () => { if (node) await copyDiagramPng(node); })}
            aria-label={text("그림 복사", "Copy image")}
            title={text("그림 복사", "Copy image")}
          ><Copy size={14} /></button>
        </div>
        <DiagramCanvas
          className="markdown-mermaid-canvas"
          node={node}
          onClick={(event) => openDiagramLink(event, setNotice, onOpenLocalLink)}
        />
      </div> : null}
      {status === "invalid"
        ? <p className="markdown-mermaid-note">{text(
          "mermaid 다이어그램 문법이 아니어서 원문을 그대로 보여 줍니다.",
          "Not valid mermaid syntax, so the source is shown as is.",
        )}</p>
        : null}
      {notice ? <p className="markdown-mermaid-note">{notice}</p> : null}
      {expanded ? <DiagramModal source={source} onOpenLocalLink={onOpenLocalLink} onClose={() => setExpanded(false)} /> : null}
    </div>
  );
}

/**
 * 확대 보기. 첨부 확대와 같은 자리(최상위 레이어)에 띄운다 — 그림은 채팅 메시지 안에도
 * 문서 안에도 있어, 그 자리에서 키우면 주변 레이아웃이 밀린다.
 *
 * 모달 안의 버튼은 AIA가 누를 수 없다(프런트가 `.modal-backdrop` 안쪽 클릭을 항상 거절한다).
 * 같은 일을 하는 새 창 쪽은 그 제약이 없다.
 */
function DiagramModal({ source, onOpenLocalLink, onClose }: {
  source: string;
  onOpenLocalLink?: (href: string) => void;
  onClose: () => void;
}) {
  const { text } = useI18n();
  useEscapeToClose(onClose);
  return createPortal(
    <DialogSurface
      backdropClassName="modal-backdrop diagram-modal-backdrop"
      className="diagram-modal"
      label={text("다이어그램 확대보기", "Diagram expanded view")}
      onBackdropClose={onClose}
    >
      <header>
        <strong>{text("다이어그램", "Diagram")}</strong>
        <DialogCloseButton label={text("확대보기 닫기", "Close expanded view")} onClose={onClose} autoFocus />
      </header>
      <DiagramViewer source={source} fileName={`diagram-${diagramPopoutId(source)}`} onOpenLocalLink={onOpenLocalLink} />
    </DialogSurface>,
    document.body,
  );
}
