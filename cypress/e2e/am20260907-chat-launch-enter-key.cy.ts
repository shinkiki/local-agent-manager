/**
 * 새 채팅 시작 폼(ChatView.tsx:1663)의 '첫 메시지'(선택) 칸은 composer와 같은
 * `submitComposerOnEnter`(src/lib/composerKeys.ts:36)를 달고 있지만, 감싸는 form이
 * composer가 아니라 `chat-launch-form`이다. 그래서 이 칸의 Enter는 '보내기'가 아니라
 * '새 채팅 시작'을 부른다. 어느 스펙도 이 키 계약을 잡은 적이 없다 — 채팅 축의 기존
 * 스펙(AM-77 탭, 채팅 목록 패널, 활동 탭 빈 상태)은 모두 폼 바깥이었다.
 *
 * 격리 백엔드에는 등록 프로젝트가 0건이라 작업 경로가 직접 입력 칸으로 열린다.
 * 실제 CLI를 붙이지 않기 위해 경로는 없는 폴더로 두고, 폴더 생성 확인에는 '아니오'로
 * 답해 기동이 실패로 끝나게 한다 — 파일시스템에 아무것도 만들지 않는다.
 */
const MISSING_CWD = "/tmp/am-qa-20260907-not-a-real-dir";

const firstMessage = () => cy.get(".chat-initial-composer textarea");
const cwdInput = () => cy.get(".chat-launch-form input[placeholder='/absolute/project/path']");
const startButton = () => cy.get(".chat-start-button");

describe("새 채팅 시작 폼의 첫 메시지 칸 Enter 계약과 시작 잠금 경계", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("chat");
    // 폴더 생성 제안은 네이티브 confirm이라 Cypress가 기본으로 승인해 버린다.
    // 거절로 고정해 두지 않으면 테스트가 실제로 폴더를 만든다.
    cy.on("window:confirm", () => false);
    cy.get(".chat-launch-form").should("be.visible");
  });

  it("등록 프로젝트가 없으면 작업 경로는 직접 입력 칸으로 열리고, 비어 있는 동안 시작이 잠긴다", () => {
    cy.get(".chat-launch-form select").first().should("contain.text", "Claude Code");
    cwdInput().should("have.value", "").and("have.attr", "required");
    startButton().should("be.disabled");

    // 공백만 적어도 잠금은 풀리지 않아야 한다(trim 경계).
    cwdInput().type("   ");
    startButton().should("be.disabled");

    cwdInput().clear().type(MISSING_CWD);
    startButton().should("not.be.disabled");
  });

  it("첫 메시지 칸의 Shift+Enter는 줄바꿈만 남기고 채팅을 시작하지 않는다", () => {
    cwdInput().type(MISSING_CWD);
    firstMessage().type("첫 줄{shift+enter}둘째 줄");
    firstMessage().should("have.value", "첫 줄\n둘째 줄");
    // 시작이 걸렸다면 버튼 문구가 'CLI 연결 중…'으로 바뀌거나 오류 안내가 떴을 것이다.
    startButton().should("have.text", "새 채팅 시작");
    cy.get(".error-banner").should("not.exist");
  });

  it("첫 메시지 칸의 Enter는 줄바꿈 대신 새 채팅 시작을 부른다", () => {
    cwdInput().type(MISSING_CWD);
    firstMessage().type("바로 보낼 요청{enter}");
    // 줄바꿈은 들어가지 않는다.
    firstMessage().should("have.value", "바로 보낼 요청");
    // 없는 경로라 기동은 실패로 끝나고, 실패 안내가 폼 안에 남는다.
    cy.get(".error-banner", { timeout: 20000 }).should("be.visible");
    // 실패했으므로 폼은 그대로 남아 다시 시도할 수 있어야 한다.
    cy.get(".chat-launch-form").should("be.visible");
    startButton().should("have.text", "새 채팅 시작");
  });

  it("작업 경로가 공백뿐이면 Enter도 시작을 부르지 않는다 — 버튼 잠금과 같은 기준", () => {
    cwdInput().type("   ");
    firstMessage().type("경로 없이 보내보기{enter}");
    firstMessage().should("have.value", "경로 없이 보내보기");
    cy.get(".error-banner").should("not.exist");
    startButton().should("be.disabled").and("have.text", "새 채팅 시작");
  });
});
