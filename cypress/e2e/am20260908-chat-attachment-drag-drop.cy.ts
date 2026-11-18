/**
 * 새 채팅 시작 폼에 파일을 끌어다 놓는 첨부 경로를 붙잡는다. 지금까지 드롭을 받는 자리는
 * 클립 버튼을 감싼 `.chat-attachment-picker`뿐이었는데, 이 자리는 작성창 안에서
 * `display: contents`라 놓을 면적이 사실상 없었다. 드롭 자리를 폼 전체로 넓히고
 * (`useFileDropZone`, src/components/ChatAttachments.tsx) 끌어오는 동안 안내를 덮어 띄운다.
 *
 * 파일 고르기(input)와 같은 검사(개수·크기)를 거치는지도 함께 확인한다. 드롭이 검사를
 * 건너뛰면 상한을 넘긴 배치가 그대로 담긴다.
 */
const drafts = () => cy.get(".chat-attachment-drafts .chat-attachment-draft");
const launchForm = () => cy.get(".chat-launch-form");

function textFile(name: string, bytes: number) {
  return { contents: Cypress.Buffer.alloc(bytes, 0x61), fileName: name, mimeType: "text/plain" };
}

function dropOnForm(files: unknown[]) {
  launchForm().selectFile(files as never, { action: "drag-drop" });
}

describe("새 채팅 시작 폼의 드래그 앤 드롭 첨부", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("chat");
    launchForm().should("be.visible");
  });

  it("폼 위에 놓은 파일이 첨부 목록에 담긴다", () => {
    dropOnForm([textFile("끌어온.txt", 24), textFile("끌어온2.txt", 24)]);
    drafts().should("have.length", 2).and("contain.text", "끌어온.txt");
    cy.get(".error-banner").should("not.exist");
  });

  it("끌어오는 동안 놓을 자리 안내가 뜨고, 벗어나면 사라진다", () => {
    cy.window().then((win) => {
      const transfer = new win.DataTransfer();
      transfer.items.add(new win.File(["a"], "끌어온.txt", { type: "text/plain" }));
      launchForm().trigger("dragenter", { dataTransfer: transfer });
      cy.get(".chat-file-drop-overlay").should("be.visible");
      launchForm().trigger("dragleave", { dataTransfer: transfer });
      cy.get(".chat-file-drop-overlay").should("not.exist");
    });
  });

  it("드롭도 파일 고르기와 같은 검사를 거친다 — 상한을 넘긴 배치는 통째로 거절된다", () => {
    dropOnForm(Array.from({ length: 9 }, (_, index) => textFile(`파일${index + 1}.txt`, 16)));
    cy.get(".error-banner").should("contain.text", "최대 8개");
    cy.get(".chat-attachment-drafts").should("not.exist");
  });

  it("드롭한 뒤에는 안내가 남지 않는다", () => {
    dropOnForm([textFile("끌어온.txt", 24)]);
    drafts().should("have.length", 1);
    cy.get(".chat-file-drop-overlay").should("not.exist");
  });
});

import type { SessionDetail, SessionSummary } from "../../src/types";

const SESSION: SessionSummary = {
  source: "codex",
  id: "qa-drop-session",
  title: "끌어놓기 첨부 표본",
  sourceTitle: null,
  project: "/tmp/qa-drop",
  cwd: "/tmp/qa-drop",
  startedAt: 1_757_000_000_000,
  updatedAt: 1_757_000_060_000,
  messageCount: 1,
  tokenTotal: 12,
  tokenUsage: null,
  model: "gpt-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 512,
  filePath: "/tmp/qa-drop/session.jsonl",
  meta: {
    favorite: false,
    hidden: false,
    note: null,
    customTitle: null,
    folderIds: [],
    reasoningEffort: null,
    mode: null,
    approvalMode: null,
    creationAccountId: null,
    boundAccountId: null,
    pinnedAccountId: null,
  },
  lastFailure: null,
};

const DETAIL: SessionDetail = {
  session: SESSION,
  transcript: [
    { index: 0, turnId: "turn-1", role: "user", timestamp: 1, model: null, typeLabel: null, blocks: [{ kind: "text", text: "QA_DROP_TEXT" }], usage: null },
  ],
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

describe("세션 상세 서랍의 드래그 앤 드롭 첨부", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", [SESSION]);
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
    cy.visitApp();
    cy.openView("sessions");
    cy.contains(".session-table tbody tr", SESSION.title).click();
    cy.wait("@detail");
  });

  // 작성창 막대가 아니라 대화 내역 위에 놓아도 담겨야 한다 — 자리가 서랍 전체이기 때문이다.
  it("대화 내역 위에 놓은 파일이 이어가기 작성창의 첨부로 담긴다", () => {
    cy.get(".transcript-section").selectFile([textFile("세션.txt", 24)] as never, { action: "drag-drop" });
    drafts().should("have.length", 1).and("contain.text", "세션.txt");
  });

  // 작성창은 대화 탭에서만 그려진다. 다른 탭에서 받으면 담긴 파일을 보여 줄 자리도,
  // 지울 자리도 없이 조용히 쌓인다.
  it("작성창이 없는 탭에서는 받지 않는다", () => {
    cy.get('[role="tablist"][aria-label="세션 상세 보기"]').contains('[role="tab"]', "작업 로그").click();
    cy.get(".transcript-section").selectFile([textFile("작업로그.txt", 24)] as never, { action: "drag-drop" });
    cy.get(".chat-file-drop-overlay").should("not.exist");
    cy.get('[role="tablist"][aria-label="세션 상세 보기"]').contains('[role="tab"]', "대화").click();
    cy.get(".chat-attachment-drafts").should("not.exist");
  });

  it("서랍 위로 끌어오는 동안 놓을 자리 안내가 한 번만 뜬다", () => {
    cy.window().then((win) => {
      const transfer = new win.DataTransfer();
      transfer.items.add(new win.File(["a"], "세션.txt", { type: "text/plain" }));
      cy.get(".drawer").trigger("dragenter", { dataTransfer: transfer });
      // 안내는 pointer-events: none이라 Cypress의 가려짐 검사에 걸린다. 존재와 문구로 본다.
      cy.get(".chat-file-drop-overlay").should("have.length", 1).and("contain.text", "여기에 놓아 첨부");
      cy.get(".drawer").trigger("dragleave", { dataTransfer: transfer });
      cy.get(".chat-file-drop-overlay").should("not.exist");
    });
  });
});

/**
 * 첨부를 받지 않는 자리에 놓은 파일. Tauri 창은 dragDropEnabled를 꺼 두었으므로 처리되지
 * 않은 드롭은 웹뷰 기본 동작 — 놓은 파일로 문서를 갈아치우기 — 으로 넘어간다. 실제로
 * 대시보드에 놓았더니 앱 화면이 빈 문서로 바뀌었다. `guardStrayFileDrops`가 그 기본 동작을
 * 지우는지 확인한다. 브라우저 테스트에서는 이동 자체가 일어나지 않으므로, 이동을 막는 유일한
 * 수단인 preventDefault가 걸렸는지를 본다.
 */
describe("첨부 자리 밖에 놓은 파일", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  function dropOn(selector: string): Cypress.Chainable<boolean> {
    return cy.window().then((win) => {
      const transfer = new win.DataTransfer();
      transfer.items.add(new win.File(["a"], "밖에서.txt", { type: "text/plain" }));
      return cy.get(selector).then(($el) => {
        const event = new win.DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
        $el[0].dispatchEvent(event);
        return event.defaultPrevented;
      });
    });
  }

  it("대시보드에 놓은 파일은 기본 동작이 막혀 웹뷰가 이동하지 않는다", () => {
    cy.openView("dashboard");
    dropOn('[data-view="dashboard"]').should("equal", true);
    cy.get(".chat-attachment-drafts").should("not.exist");
    cy.get(".chat-file-drop-overlay").should("not.exist");
  });

  it("가드는 파일이 아닌 드래그에는 끼어들지 않는다 — 입력창 사이 글 옮기기가 막히면 안 된다", () => {
    cy.window().then((win) => {
      const transfer = new win.DataTransfer();
      transfer.setData("text/plain", "글자");
      const event = new win.DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
      win.document.body.dispatchEvent(event);
      expect(event.defaultPrevented).to.equal(false);
    });
  });
});
