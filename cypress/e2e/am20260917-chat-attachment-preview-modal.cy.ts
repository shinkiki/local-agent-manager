/**
 * 첨부 확대보기 모달(src/components/ChatAttachmentPreview.tsx)의 형식별 본문 분기를 붙잡는다.
 * 이 모듈은 2026-09-17에 ChatAttachments.tsx에서 갈라져 나왔고, 자기만의 규칙 한 벌 —
 * 텍스트로 펼칠 수 있는 형식 판정, 512KB 자르기 안내, 지원하지 않는 형식의 안내문 — 을
 * 들고 있다. 기존 첨부 스펙(am20260907-chat-attachment-limits, am20260908-chat-attachment-drag-drop)은
 * 담기·상한만 보고 확대보기는 한 번도 열어 보지 않았다.
 *
 * 아직 올리지 않은 드래프트는 로컬 File을 그대로 읽으므로 격리 백엔드 없이도 세 갈래를
 * 모두 지날 수 있다.
 */
const launchForm = () => cy.get(".chat-launch-form");
const drafts = () => cy.get(".chat-attachment-drafts .chat-attachment-draft");
const dialog = () => cy.get(".chat-attachment-preview-dialog");

function file(name: string, bytes: number, mimeType: string) {
  return { contents: Cypress.Buffer.alloc(bytes, 0x61), fileName: name, mimeType };
}

function dropAndZoom(spec: ReturnType<typeof file>) {
  launchForm().selectFile([spec] as never, { action: "drag-drop" });
  drafts().should("have.length", 1);
  drafts().find(".chat-attachment-zoom").click();
  return dialog().should("be.visible");
}

describe("새 채팅 첨부 드래프트의 확대보기 모달", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("chat");
    launchForm().should("be.visible");
  });

  it("텍스트 첨부는 본문을 펼쳐 보여 주고 머리글에 형식·크기를 적는다", () => {
    dropAndZoom(file("메모.txt", 24, "text/plain"));
    dialog().should("have.attr", "aria-modal", "true").and("have.attr", "aria-label", "메모.txt 확대보기");
    dialog().find("header small").should("have.text", "text/plain · 24 B");
    dialog().find("pre").should("contain.text", "aaaa").and("not.contain.text", "처음");
    dialog().find("a.button").should("contain.text", "다운로드").and("have.attr", "download", "메모.txt");
  });

  it("확장자로만 알 수 있는 코드 파일도 텍스트로 펼친다", () => {
    // mediaType이 빈 값이라 application/octet-stream으로 떨어져도 이름이 판정을 살려야 한다.
    dropAndZoom(file("설정.ts", 32, ""));
    dialog().find("header small").should("contain.text", "application/octet-stream");
    dialog().find("pre").should("contain.text", "aaaa");
    dialog().find(".state-panel").should("not.exist");
  });

  it("512KB를 넘는 텍스트는 앞부분만 보여 주고 잘렸다고 알린다", () => {
    dropAndZoom(file("커다란.log", 512 * 1024 + 2048, "text/plain"));
    dialog().find("pre").should("contain.text", "파일이 커서 처음 512 KB까지만 표시합니다");
  });

  it("펼칠 수 없는 형식은 다운로드하라고 안내한다", () => {
    dropAndZoom(file("표본.bin", 64, "application/octet-stream"));
    dialog().find(".state-panel").should("contain.text", "미리보기를 지원하지 않는 형식입니다");
    dialog().find("pre").should("not.exist");
    dialog().find("a.button").should("contain.text", "다운로드");
  });

  it("Esc로 닫히고 첨부 드래프트는 남는다", () => {
    dropAndZoom(file("메모.txt", 24, "text/plain"));
    cy.get("body").type("{esc}");
    dialog().should("not.exist");
    drafts().should("have.length", 1).and("contain.text", "메모.txt");
  });

  it("닫기 버튼으로 닫힌다", () => {
    dropAndZoom(file("메모.txt", 24, "text/plain"));
    dialog().find('button[aria-label="확대보기 닫기"]').click();
    dialog().should("not.exist");
  });

  it("모달 안쪽 클릭으로는 닫히지 않고, 바깥 클릭으로는 닫힌다", () => {
    dropAndZoom(file("메모.txt", 24, "text/plain"));
    // 모달 안쪽을 눌러도 닫히면 안 된다 — 본문을 드래그해 고르는 동작이 그때마다 끊긴다.
    dialog().find("header strong").click();
    dialog().should("exist");
    cy.get(".chat-attachment-preview-backdrop").click("topLeft");
    dialog().should("not.exist");
  });
});
