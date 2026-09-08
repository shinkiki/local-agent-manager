/// <reference types="cypress" />
// 원격 편집 허용 행은 확인 대화까지 딸린 설정이라 문구가 네 곳(스위치 aria-label·요약·
// 확인 대화 본문과 경고·성공 안내)에 흩어져 있다. 기존 원격 스펙 셋(remote-write,
// am20260906-remote-write-host-scope, AM-57/AM-60)은 모두 한국어 문구를 고정 문자열로
// 잡아 확인 대화의 흐름만 보므로, 영어 UI에서 이 네 곳이 실제로 번역되는지는 아무도 보지
// 않았다. 확인 대화는 공용 useConfirm 모달을 거쳐 그리므로 취소 버튼까지 함께 본다.
// 격리 백엔드는 임시 app-data에만 쓰고 Tailscale CLI를 부르지 않으므로 여기서 껐다 켜도
// 운영 설정에 닿지 않는다. UI 언어와 원격 편집 값은 둘 다 백엔드에 남아 뒤따르는 스펙으로
// 새므로, 끝에서 언어는 한국어로 원격 편집은 기본값(켜짐)으로 되돌린다.
const TOGGLE_KO = '[role="switch"][aria-label="원격 편집 허용"]';
const TOGGLE_EN = '[role="switch"][aria-label="Allow remote editing"]';
const HANGUL = /[가-힣]/;

describe("백엔드 서비스 · 원격 편집 허용의 영어 현지화", () => {
  after(() => {
    // 언어를 먼저 한국어로 되돌린 뒤, 한국어 선택자로 원격 편집을 기본값으로 맞춘다.
    cy.restoreLanguage();
    cy.openSettingsTab("service");
    cy.get(TOGGLE_KO).then(($toggle) => {
      if ($toggle.attr("aria-checked") === "true") return;
      cy.get(TOGGLE_KO).click();
      cy.get('[role="dialog"]').contains("button", "허용").click();
      cy.get(TOGGLE_KO).should("have.attr", "aria-checked", "true");
    });
  });

  it("영어에서 스위치 이름·요약·확인 대화·성공 안내가 모두 영어로 나온다", () => {
    cy.visitApp();
    cy.setLanguage("en");

    cy.openSettingsTab("service");
    // 1) 스위치 이름 자체가 번역된다 — 한국어 aria-label로는 더 이상 잡히지 않아야 한다.
    cy.get(TOGGLE_KO).should("not.exist");
    cy.get(TOGGLE_EN).should("have.attr", "aria-checked", "true").and("be.enabled");
    cy.contains("Remote can change things just like the desktop").should("be.visible");

    // 2) 끄는 쪽은 확인 없이 바로 반영되고, 요약과 안내가 영어로 바뀐다.
    cy.get(TOGGLE_EN).click();
    cy.get('[role="dialog"]').should("not.exist");
    cy.get(TOGGLE_EN).should("have.attr", "aria-checked", "false");
    cy.contains("Remote is read only · viewing only").should("be.visible");
    cy.contains("Remote is now read only").should("be.visible");

    // 3) 켜는 쪽 확인 대화는 제목·본문·경고·버튼이 모두 영어여야 한다. 취소 버튼은
    //    cancelLabel을 넘기지 않아 공용 모달의 기본값을 쓰므로 여기서 함께 본다.
    cy.get(TOGGLE_EN).click();
    cy.get('[role="dialog"]').should("be.visible").within(() => {
      cy.contains("Allow remote editing").should("be.visible");
      cy.contains("Remote access will get the same change permissions as the desktop.").should("be.visible");
      cy.contains("Starting chats, switching accounts, and editing skills or instructions become possible from remote.").should("be.visible");
      cy.contains("button", "Allow").should("be.visible");
      cy.contains("button", "Cancel").should("be.visible");
      // 대화 전체에 한글이 한 글자도 남지 않는다.
      cy.root().invoke("text").should("not.match", HANGUL);
      cy.contains("button", "Cancel").click();
    });

    // 4) 취소는 권한을 열지 않는다 — 읽기 전용 그대로다.
    cy.get('[role="dialog"]').should("not.exist");
    cy.get(TOGGLE_EN).should("have.attr", "aria-checked", "false");
    cy.contains("Remote editing is allowed").should("not.exist");

    // 5) 허용하면 켜지고 성공 안내가 영어로 나온다.
    cy.get(TOGGLE_EN).click();
    cy.get('[role="dialog"]').contains("button", "Allow").click();
    cy.get('[role="dialog"]').should("not.exist");
    cy.get(TOGGLE_EN).should("have.attr", "aria-checked", "true");
    cy.contains("Remote can change things just like the desktop").should("be.visible");
    cy.contains("Remote editing is allowed").should("be.visible");

    // 6) 도움말 팝오버도 같은 행에 딸린 문구다.
    cy.get('[aria-label="How remote editing works"]').click();
    cy.contains("Decides whether remote (Tailscale) access gets the same change permissions as the desktop.")
      .should("be.visible")
      .invoke("text")
      .should("not.match", HANGUL);
  });
});
