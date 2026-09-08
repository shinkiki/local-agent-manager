/**
 * 새 채팅 시작 폼(ChatView.tsx:1707)의 첨부 담기 경계를 붙잡는다.
 * `appendAttachmentDrafts`(src/components/ChatAttachments.tsx:23)는 개수 상한 8개,
 * 0바이트 거절, 일반 20MB·이미지 10MB 상한 세 규칙을 가지고 있고, 셋 다 배치를
 * 통째로 거절한다(부분 수용 없음). 이 계약을 화면에서 확인한 스펙은 아직 없다 —
 * 채팅 축의 기존 스펙은 첫 메시지 칸의 Enter 키(AM-124), 목록 패널, 활동 탭
 * 빈 상태만 다뤘고 첨부는 어느 축에서도 다룬 적이 없다.
 *
 * 격리 백엔드에는 등록 프로젝트가 0건이라 시작 폼이 바로 열린다. 첨부는 담기만
 * 하고 채팅을 시작하지 않으므로 업로드 요청이 백엔드로 나가지 않는다.
 */
const attachmentInput = () => cy.get(".chat-attachment-input");
const attachmentButton = () => cy.get(".chat-attachment-button");
const drafts = () => cy.get(".chat-attachment-drafts .chat-attachment-draft");

function textFile(name: string, bytes: number) {
  return { contents: Cypress.Buffer.alloc(bytes, 0x61), fileName: name, mimeType: "text/plain" };
}

function imageFile(name: string, bytes: number) {
  return { contents: Cypress.Buffer.alloc(bytes, 0x61), fileName: name, mimeType: "image/png" };
}

function attach(files: unknown[]) {
  attachmentInput().selectFile(files as never, { force: true });
}

describe("새 채팅 시작 폼 첨부의 개수·크기 경계", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("chat");
    cy.get(".chat-launch-form").should("be.visible");
  });

  it("빈 상태에서는 담긴 목록이 없고 첨부 버튼이 열려 있다", () => {
    cy.get(".chat-attachment-drafts").should("not.exist");
    attachmentButton().should("not.be.disabled");
    cy.get(".error-banner").should("not.exist");
  });

  it("8개까지 담기면 목록에 그대로 남고 첨부 버튼이 잠긴다", () => {
    attach(Array.from({ length: 8 }, (_, index) => textFile(`파일${index + 1}.txt`, 16)));
    drafts().should("have.length", 8);
    cy.get(".error-banner").should("not.exist");
    attachmentButton().should("be.disabled");
  });

  it("상한을 넘기는 배치는 통째로 거절되고 이미 담긴 것은 그대로 남는다", () => {
    attach(Array.from({ length: 7 }, (_, index) => textFile(`파일${index + 1}.txt`, 16)));
    drafts().should("have.length", 7);

    // 7 + 2 = 9라 상한을 넘는다. 한 개만 받아들이는 부분 수용은 하지 않는다.
    attach([textFile("여덟.txt", 16), textFile("아홉.txt", 16)]);
    cy.get(".error-banner").should("contain.text", "최대 8개");
    drafts().should("have.length", 7);
    attachmentButton().should("not.be.disabled");
  });

  it("0바이트 파일은 이름과 함께 거절되고 같은 배치의 정상 파일도 담기지 않는다", () => {
    attach([textFile("정상.txt", 16), textFile("빈파일.txt", 0)]);
    cy.get(".error-banner").should("contain.text", "빈파일.txt").and("contain.text", "빈 파일");
    cy.get(".chat-attachment-drafts").should("not.exist");
  });

  it("이미지 상한(10MB)을 1바이트 넘기면 거절되고, 상한과 같은 크기는 담긴다", () => {
    const limit = 10 * 1024 * 1024;
    attach([imageFile("큰그림.png", limit + 1)]);
    cy.get(".error-banner").should("contain.text", "큰그림.png");
    cy.get(".chat-attachment-drafts").should("not.exist");

    attach([imageFile("딱맞는그림.png", limit)]);
    drafts().should("have.length", 1).and("contain.text", "딱맞는그림.png");
  });

  it("이미지가 아닌 파일은 20MB 상한을 따른다 — 10MB는 통과한다", () => {
    attach([textFile("십메가.txt", 10 * 1024 * 1024)]);
    drafts().should("have.length", 1).and("contain.text", "십메가.txt");
    cy.get(".error-banner").should("not.exist");
  });

  // QA #36 조치: 거절 안내는 시작·연결 오류와 다른 자리(attachmentNotice)에 실리고,
  // 거절 없이 담기가 성공하면 이전 거절 안내가 지워진다.
  it("거절 안내는 뒤이은 정상 첨부에서 지워진다", () => {
    attach([textFile("빈파일.txt", 0)]);
    cy.get(".error-banner").should("exist").and("contain.text", "빈 파일");
    attach([textFile("정상.txt", 16)]);
    drafts().should("have.length", 1);
    cy.get(".error-banner").should("not.exist");
  });

  it("거절이 이어지면 안내는 마지막 거절 이유로 바뀐다", () => {
    attach([textFile("빈파일.txt", 0)]);
    cy.get(".error-banner").should("contain.text", "빈 파일");
    attach(Array.from({ length: 9 }, (_, index) => textFile(`파일${index + 1}.txt`, 16)));
    cy.get(".error-banner").should("contain.text", "최대 8개").and("not.contain.text", "빈 파일");
    cy.get(".chat-attachment-drafts").should("not.exist");
  });

  it("담긴 첨부를 제거하면 잠겼던 첨부 버튼이 다시 열린다", () => {
    attach(Array.from({ length: 8 }, (_, index) => textFile(`파일${index + 1}.txt`, 16)));
    attachmentButton().should("be.disabled");
    cy.get("button[aria-label='파일1.txt 첨부 제거']").click();
    drafts().should("have.length", 7);
    attachmentButton().should("not.be.disabled");
  });
});
