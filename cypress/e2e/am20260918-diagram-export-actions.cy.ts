/**
 * 다이어그램 도구줄의 내보내기 세 버튼이 남기는 결과 안내.
 *
 * 그림 복사·PNG·SVG는 눌러도 화면이 바뀌지 않는다 — 결과가 클립보드나 파일로 나가므로,
 * 사용자가 성공·실패를 아는 유일한 통로가 도구줄 아래 한 줄 안내다. 그 한 줄이 비거나
 * 이전 결과가 그대로 남으면 사용자는 같은 버튼을 계속 누르게 된다.
 *
 * 확인하는 계약은 셋이다.
 *   - 복사가 되는 셸: 클립보드에 PNG가 담기고 성공 안내가 뜬다.
 *   - 복사를 지원하지 않는 셸: 실패 안내가 뜨고, 다음 동작이 성공하면 그 안내로 갈린다.
 *   - 영어 창: 버튼 이름과 성공 안내가 영어로 나온다.
 *
 * 자리는 다이어그램 별도 창이다. 백엔드·계정 없이 그림 하나만 띄울 수 있어 도구줄만
 * 보기에 가장 적은 준비로 닿는다(`DiagramWindow`).
 */
import { diagramPopoutId } from "../../src/lib/diagramPopout";

const SOURCE = "flowchart LR\n    시작 --> 끝";
const ID = diagramPopoutId(SOURCE);

type ClipboardCall = { type: string; size: number };

/**
 * 별도 창을 연다. `clipboard`가 `false`면 그림 복사를 지원하지 않는 셸을 흉내 낸다 —
 * `navigator.clipboard.write`가 없는 브라우저가 실제로 있고, 앱은 그때 파일 저장으로
 * 안내해야 한다.
 */
function openDiagramWindow(options: { locale: "ko" | "en"; clipboard: boolean }): void {
  const calls: ClipboardCall[] = [];
  cy.visit(`/?popout=diagram&diagram=${ID}`, {
    onBeforeLoad(win) {
      win.localStorage.setItem(
        `agent-manager.diagram-popout.${ID}`,
        JSON.stringify({ source: SOURCE, locale: options.locale, savedAt: Date.now() }),
      );
      // 실제 클립보드는 헤드리스에서 권한이 막혀 있다. 담긴 내용을 직접 보려면 바꿔 끼운다.
      Object.defineProperty(win.navigator, "clipboard", {
        configurable: true,
        value: options.clipboard
          ? {
            write: (items: { types: string[]; getType: (type: string) => Promise<Blob> }[]) =>
              Promise.all(items.flatMap((item) => item.types.map((type) =>
                item.getType(type).then((blob) => { calls.push({ type, size: blob.size }); }),
              ))).then(() => undefined),
          }
          : {},
      });
      if (!options.clipboard) {
        // `ClipboardItem`이 없는 셸까지 함께 흉내 낸다 — 앱은 둘 중 하나만 없어도 막아야 한다.
        Object.defineProperty(win, "ClipboardItem", { configurable: true, value: undefined });
      }
    },
  });
  cy.wrap(calls).as("clipboardCalls");
  cy.get(".diagram-window .diagram-viewer-canvas svg", { timeout: 20_000 }).should("exist");
}

const notice = () => cy.get(".diagram-viewer-notice");

describe("다이어그램 내보내기 결과 안내", () => {
  it("복사가 되는 셸에서는 PNG가 클립보드에 담기고 성공 안내가 뜬다", () => {
    openDiagramWindow({ locale: "ko", clipboard: true });

    // 누르기 전에는 안내가 없다. 지난 결과가 미리 떠 있으면 방금 누른 결과와 구분되지 않는다.
    cy.get(".diagram-viewer-notice").should("not.exist");

    cy.contains(".diagram-viewer-exports button", "그림 복사").click();
    notice().should("have.text", "그림을 복사했습니다.");
    cy.get<ClipboardCall[]>("@clipboardCalls").should((calls) => {
      expect(calls).to.have.length(1);
      expect(calls[0].type).to.eq("image/png");
      // 배경을 칠하고 두 배로 굽기 때문에 빈 파일이 나올 수 없다.
      expect(calls[0].size).to.be.greaterThan(0);
    });
  });

  it("복사를 지원하지 않으면 그 사실을 알리고, 이어진 SVG 저장이 안내를 갈아치운다", () => {
    openDiagramWindow({ locale: "ko", clipboard: false });

    cy.contains(".diagram-viewer-exports button", "그림 복사").click();
    notice().should("contain.text", "그림 복사를 지원하지 않습니다");
    cy.get<ClipboardCall[]>("@clipboardCalls").should("have.length", 0);

    // 실패 안내가 남아 있으면 다음 동작의 성공을 가린다.
    cy.contains(".diagram-viewer-exports button", "SVG").click();
    notice().should("have.text", "SVG로 저장했습니다.");
  });

  it("영어 창에서는 버튼 이름과 성공 안내가 영어로 나온다", () => {
    openDiagramWindow({ locale: "en", clipboard: true });

    cy.contains(".diagram-viewer-exports button", "Copy image").click();
    notice().should("have.text", "Diagram copied.");
    cy.contains(".diagram-viewer-exports button", "SVG").click();
    notice().should("have.text", "Saved as SVG.");
  });
});
