// 원격 편집 허용은 원격(Tailscale) 접속에 데스크톱과 같은 변경 권한을 주는 설정이라
// 켤 때만 확인을 받고 끌 때는 바로 좁힌다. 격리 백엔드는 임시 app-data에만 쓰고
// Tailscale CLI를 부르지 않으므로 여기서 켜고 꺼도 운영 설정에 닿지 않는다.
// 값이 백엔드에 남아 테스트끼리 새어 나가므로 한 흐름을 한 테스트로 이어서 본다.
const TOGGLE = '[role="switch"][aria-label="원격 편집 허용"]';
const ON_SUMMARY = "원격에서도 데스크톱과 같이 변경할 수 있습니다";
const OFF_SUMMARY = "원격은 읽기 전용입니다";

function openServiceTab() {
  cy.anchor("nav.settings").click();
  cy.view("settings").should("exist");
  cy.anchor("settings.tab.service").click().should("have.class", "active");
}

describe("백엔드 서비스 · 원격 편집 허용", () => {
  it("끄기는 확인 없이, 켜기는 확인을 거쳐 반영되고 새로고침 뒤에도 남는다", () => {
    cy.visitApp();
    openServiceTab();

    // 기본값은 켜짐(DEFAULT_BACKEND_REMOTE_WRITE)이고, 호스트 화면이라 바꿀 수 있다.
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true").and("be.enabled");
    cy.contains(ON_SUMMARY).should("be.visible");

    // 1) 끄는 쪽은 좁히는 방향이라 확인 대화 없이 바로 반영된다.
    cy.get(TOGGLE).click();
    cy.get('[role="dialog"]').should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
    cy.contains(OFF_SUMMARY).should("be.visible");
    cy.contains("원격을 읽기 전용으로 바꿨습니다").should("be.visible");

    // 2) 다시 켜면 확인 대화가 뜨고, 취소하면 읽기 전용 그대로다.
    cy.get(TOGGLE).click();
    cy.get('[role="dialog"]').should("be.visible").within(() => {
      cy.contains("원격 접속에서도 데스크톱과 같은 변경 권한을 줍니다.").should("be.visible");
      cy.contains("채팅 실행, 계정 전환").should("be.visible");
      cy.contains("button", "취소").click();
    });
    cy.get('[role="dialog"]').should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "false");
    cy.contains(OFF_SUMMARY).should("be.visible");
    cy.contains("원격 편집을 허용했습니다").should("not.exist");

    // 3) 허용하면 켜지고 안내가 바뀐다.
    cy.get(TOGGLE).click();
    cy.get('[role="dialog"]').contains("button", "허용").click();
    cy.get('[role="dialog"]').should("not.exist");
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
    cy.contains(ON_SUMMARY).should("be.visible");
    cy.contains("원격 편집을 허용했습니다").should("be.visible");

    // 4) 백엔드에 남는 설정이라 새로고침 뒤에도 켜진 채로 열린다.
    cy.reload();
    openServiceTab();
    cy.get(TOGGLE).should("have.attr", "aria-checked", "true");
    cy.contains(ON_SUMMARY).should("be.visible");
  });
});
