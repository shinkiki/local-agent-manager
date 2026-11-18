/// <reference types="cypress" />

// 새 채팅 시작 폼에서 로컬 LLM(Ollama)을 고른 상태의 계약.
//
// 이 공급자는 계정을 관리하지 않는다(`ProviderId::manages_accounts == false`). 화면이 그것을
// 공급자 이름으로 판단하지 않고 내려온 값으로 판단하는지가 여기서 보는 것이다 — 로컬을 고르면
// '실행 계정' 칸이 아예 없고, 모델 목록은 계정이 아니라 연결된 서버가 내려 준 것이 뜬다.
// 계정이 하나 등록된 Codex 를 나란히 세워 그 칸이 로컬에서만 사라지는 것을 본다.

import {
  providerAccount,
  providerState,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";
import { stubLocalChatModels, stubProvidersDetected } from "../support/localLlmFixtures";

const form = () => cy.get(".chat-launch-form");
const providerSelect = () => form().contains("label", "공급자").find("select");

describe("새 채팅 · 로컬 LLM 선택", () => {
  beforeEach(() => {
    stubProvidersDetected("local", "codex");
    stubProviderAccounts([providerState()], [providerAccount({ authStatus: "ready" })]);
    stubLocalChatModels(["qwen3:8b", "gpt-oss:20b"]);
    cy.visitApp();
    cy.openView("chat");
    form().should("be.visible");
  });

  it("로컬을 고르면 실행 계정 칸이 사라지고 서버가 준 모델이 목록에 오른다", () => {
    providerSelect().should("contain.text", "Ollama").select("local");

    // 계정이 없는 공급자라 계정 칸 자체가 그려지지 않는다. 비활성이 아니라 부재다.
    form().contains("label", "실행 계정").should("not.exist");

    cy.get(".model-picker-trigger").should("contain.text", "공급자 기본값").click();
    cy.get(".model-picker-list").within(() => {
      cy.contains('button[role="option"]', "qwen3:8b").should("exist");
      cy.contains('button[role="option"]', "gpt-oss:20b").should("exist");
    });
    cy.contains('.model-picker-list button[role="option"]', "gpt-oss:20b").click();
    cy.get(".model-picker-popover").should("not.exist");
    cy.get(".model-picker-trigger").should("contain.text", "gpt-oss:20b");

    // 계정이 없어도 시작 버튼은 작업 경로만 채우면 열린다.
    form().contains("label", "작업 경로").find("input").clear().type("/tmp/am-qa-local-llm");
    cy.get(".chat-start-button").should("not.be.disabled");
  });

  it("계정을 관리하는 Codex 로 돌아오면 같은 폼에서 계정 칸이 다시 나타난다", () => {
    providerSelect().select("codex");
    form().contains("label", "실행 계정").find("select")
      .should("exist")
      .and("contain.text", "기본 계정");

    providerSelect().select("local");
    form().contains("label", "실행 계정").should("not.exist");

    providerSelect().select("codex");
    form().contains("label", "실행 계정").find("select").should("exist");
  });
});
