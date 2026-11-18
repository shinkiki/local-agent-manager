/// <reference types="cypress" />
/**
 * 채팅 실행 설정 메뉴의 카탈로그 목록 밖 모델·추론 옵션 보존과 승인 모드별 동적 안내 힌트 전환.
 *
 * 466db9b는 실행 설정 선택 박스의 목록 밖 현재값 보강 세 벌을 unlistedOption 한 벌로 모으고
 * 승인 처리 안내를 APPROVAL_MODE_HINTS 표로 분리했다.
 *
 * 카탈로그는 공급자·계정 상태에 따라 달라질 수 있어 기존 세션이 쓰던 모델이나 추론 수준이
 * 현재 카탈로그에 없을 때가 있다. 이때 unlistedOption이 없으면 첫 번째 선택지(공급자 기본)로
 * 자동 선택되어 사용자가 손대지 않은 설정이 바뀌게 된다.
 *
 * 본 스펙은 다음을 격리 화면에서 검증한다:
 * 1. 카탈로그에 없는 모델("unlisted-legacy-model")과 비표준 추론 수준("xhigh")을 가진
 *    세션에서 unlistedOption이 생성되어 현재 값이 손실 없이 선택된 채 보존되는지 확인.
 * 2. 실행 설정 요약 줄에 unlisted 모델과 추론 수준 라벨("매우 높음")이 온전히 반영되는지 확인.
 * 3. 승인 처리 모드(autoReview, granular, onFailure) 변경 시 APPROVAL_MODE_HINTS 표에 정의된
 *    안내 문구가 동적으로 올바르게 노출되고 전환되는지 확인.
 */

import { openStoppedChat, stoppedChat, stubLiveChat, visitWithFakeChatSocket } from "../support/chatSessionFixtures";

const UNLISTED_MODEL = "unlisted-legacy-model";
const UNLISTED_REASONING = "xhigh";

const chat = stoppedChat({
  chatId: "qa-runtime-unlisted-chat",
  providerSessionId: "qa-provider-session-unlisted",
  cwd: "/tmp/qa-runtime-unlisted",
  model: UNLISTED_MODEL,
  reasoningEffort: UNLISTED_REASONING,
  approvalMode: "autoReview",
});

describe("채팅 실행 설정 메뉴의 카탈로그 목록 밖 모델·추론 옵션 보존 및 승인 모드별 안내 힌트 전환", () => {
  beforeEach(() => {
    stubLiveChat(chat);
  });

  it("목록 밖 모델·추론 옵션이 unlistedOption으로 유지되고 승인 모드 전환에 따라 안내 문구가 바뀐다", () => {
    visitWithFakeChatSocket(chat);
    openStoppedChat();

    // 1. 실행 설정 요약 바 확인 (unlisted 모델명과 추론 수준 한국어 라벨 '매우 높음')
    const summaryButton = cy.get(".session-runtime-settings-button");
    summaryButton.should("be.visible");
    summaryButton.should("contain.text", UNLISTED_MODEL);
    summaryButton.should("contain.text", "매우 높음");

    // 2. 실행 설정 패널 열기
    summaryButton.click();
    cy.get("#chat-runtime-settings-panel").should("be.visible");

    // 3. 모델 선택기에서 목록 밖 옵션 보존 확인
    const modelSelect = cy.get(".session-model-selector select");
    modelSelect.should("be.visible");
    modelSelect.should("have.value", UNLISTED_MODEL);
    modelSelect.find(`option[value="${UNLISTED_MODEL}"]`).should("exist").and("have.text", UNLISTED_MODEL);

    // 4. 추론 수준 선택기에서 목록 밖 옵션 보존 확인 (label 함수 적용 확인: '매우 높음')
    const reasoningSelect = cy.get(".session-reasoning-selector select");
    reasoningSelect.should("be.visible");
    reasoningSelect.should("have.value", UNLISTED_REASONING);
    reasoningSelect.find(`option[value="${UNLISTED_REASONING}"]`).should("exist").and("have.text", "매우 높음");

    // 5. autoReview 모드 힌트 확인
    cy.get(".session-mode-hint").should(
      "contain.text",
      "Codex가 승인 요청의 위험도를 자동 검토하며 추가 사용량이 발생할 수 있습니다."
    );

    // 6. granular 모드로 전환 및 힌트 갱신 확인
    cy.get(".session-approval-selector select").select("granular");
    cy.get(".session-mode-hint").should(
      "contain.text",
      "Codex가 승인 종류별 정책에 따라 직접 확인을 요청합니다."
    );

    // 7. onFailure 모드로 전환 및 힌트 갱신 확인
    cy.get(".session-approval-selector select").select("onFailure");
    cy.get(".session-mode-hint").should(
      "contain.text",
      "Codex가 샌드박스 실행 실패 후 직접 확인을 요청합니다."
    );

    // 8. 스크린샷 캡처
    cy.screenshot("am20260910-chat-runtime-settings-unlisted");

    // 9. manual 모드로 전환 시 APPROVAL_MODE_HINTS에 등록된 힌트가 사라짐 확인
    cy.get(".session-approval-selector select").select("manual");
    cy.get(".session-mode-hint").each(($el) => {
      expect($el.text()).not.to.include("Codex가");
    });
  });
});
