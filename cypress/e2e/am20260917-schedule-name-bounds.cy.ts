import {
  providerAccount,
  providerState,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";
// 반복 요청을 실제로 저장해 이름 칸의 두 경계를 본다. 지금까지 편집기 스펙은 모두 저장 앞에서
// 멈췄다(qa49는 저장 버튼의 잠김만 본다). 저장을 통과해야만 드러나는 규칙이 둘 있다.
//   1) 이름을 비우면 화면이 "비워두면 요청 앞부분 사용" 약속대로 요청 앞 60자를 이름으로 세운다.
//   2) 백엔드 validate_input은 이름을 120자로 자른다(crates/agent-manager-core/src/scheduler.rs:2620).
//      화면 입력칸에는 maxlength가 없으므로 더 긴 이름을 넣을 수 있고, 저장본에서 잘린다.
// 격리 백엔드에는 계정이 없어 채팅 대상 저장이 막히므로 계정 스냅샷 한 벌을 덧댄다.

const PROMPT = "긴 요청 본문으로 이름을 대신 세우는지 본다 ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789 끝";
const LONG_NAME = "가".repeat(130);

function editor() {
  return cy.get(".schedule-editor");
}

function field(label: string) {
  return editor().contains("label > span", new RegExp(`^${label}$`)).parent();
}

function fillChatRequest(name: string) {
  if (name) field("이름").find("input").type(name);
  field("공급자").find("select").select("claude");
  // 격리 백엔드에는 등록 계정이 없어 고정 계정은 저장 시점 조회에서 막힌다. 실행 시점 조회를
  // 고르면 저장 시점에 볼 계정이 없으므로(scheduler.rs:1084) 이름 경계만 남는다.
  field("실행 계정").find("select").select("__active__");
  field("반복할 요청").find("textarea").clear().type(PROMPT);
  field("작업 경로").find("input").clear().type("/tmp");
  // 저장 직후 예약 실행이 나가지 않도록 비활성으로 저장한다.
  editor().contains("label", "저장 후 활성화").find("input").uncheck();
  editor().find('footer button[type="submit"]').click();
  cy.get(".schedule-editor").should("not.exist");
}

describe("반복 요청 저장 시 이름 경계", () => {
  beforeEach(() => {
    stubProviderAccounts(
      [providerState({ provider: "claude", activeAccountId: "claude-name-bounds" })],
      [providerAccount({
        id: "claude-name-bounds",
        provider: "claude",
        displayName: "QA 계정",
        providerAccountId: "claude-name-bounds-acc",
        providerDisplayName: "QA 계정",
        authStatus: "ready",
      })],
    );
    cy.visitApp();
    cy.openScheduleEditor();
  });

  it("이름 칸이 상한을 먼저 알리고 그 이상은 받지 않는다", () => {
    // 한때 칸은 끝까지 받아 두고 백엔드가 저장 직전에 120자로 잘랐다 — 잘렸다는 표시가
    // 어디에도 없어 뒤에 붙인 식별자가 조용히 사라졌다(QA #91).
    cy.get(".schedule-editor").contains("label", "이름").find("input")
      .should("have.attr", "maxlength", "120")
      .and("have.attr", "placeholder")
      .and("contain", "120자");
    cy.get(".schedule-editor").contains("label", "이름").find("input")
      .type("가".repeat(130))
      .should("have.value", "가".repeat(120));
  });

  it("이름을 비우면 요청 앞 60자가 이름이 되고, 120자를 넘긴 이름은 120자로 잘려 저장된다", () => {
    fillChatRequest("");

    cy.get(".schedule-card header strong").should("have.length", 1).first().then(($name) => {
      expect($name.text()).to.equal(PROMPT.slice(0, 60));
      expect($name.text()).to.have.length(60);
    });

    cy.newScheduleEditor();
    fillChatRequest(LONG_NAME);

    cy.get(".schedule-card header strong").should("have.length", 2);
    cy.get(".schedule-card header strong").filter(`:contains("가가")`).should("have.length", 1).then(($name) => {
      expect($name.text()).to.have.length(120);
      expect($name.text()).to.equal("가".repeat(120));
    });
  });
});
