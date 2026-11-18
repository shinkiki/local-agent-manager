/// <reference types="cypress" />

// 반복 요청 편집기에서 로컬 LLM(Ollama)을 고른 상태의 계약.
//
// 이 편집기의 저장 버튼은 `(managesAccounts && !accountId) || !prompt || !cwd` 로 잠긴다
// (src/components/ChatScheduleEditor.tsx). 계정을 관리하지 않는 공급자에서 그 첫 항이
// 살아 있으면 고를 계정이 없는데 저장만 막혀 무인 반복을 아예 세울 수 없다 — 이 스펙이
// 붙잡는 회귀가 그것이다. 계정 하나를 가진 Codex 를 나란히 세워, 같은 폼에서 공급자만
// 바꿔도 계정 칸·계정 없음 배너·저장 잠김이 함께 갈리는 것을 본다.

import {
  providerAccount,
  providerState,
  stubProviderAccounts,
} from "../support/providerAccountFixtures";
import { stubLocalChatModels, stubProvidersDetected } from "../support/localLlmFixtures";

function editor() {
  return cy.get(".schedule-editor");
}

function field(label: string) {
  return editor().contains("label > span", new RegExp(`^${label}$`)).parent();
}

function saveButton() {
  return editor().find("footer .button.primary");
}

describe("반복 요청 · 로컬 LLM 공급자", () => {
  beforeEach(() => {
    stubProvidersDetected("local", "codex");
    // Codex 에는 계정이 하나 있고 로컬에는 공급자 상태 자체가 없다 — 실제 백엔드와 같은 모양이다.
    stubProviderAccounts([providerState()], [providerAccount({ authStatus: "ready" })]);
    stubLocalChatModels(["qwen3:8b"]);
    cy.visitApp();
    cy.openScheduleEditor();
  });

  it("로컬을 고르면 실행 계정 칸이 사라지고 요청·경로만으로 저장이 열린다", () => {
    // 먼저 계정을 고르지 않은 Codex 에서는 요청·경로를 채워도 저장이 잠긴다.
    // 기본 공급자는 목록 순서를 타므로 가정하지 않고 명시적으로 고른다.
    field("공급자").find("select").select("codex");
    field("실행 계정").find("select").should("exist");
    field("반복할 요청").find("textarea").type("매일 아침 로컬 모델로 회차 상태를 정리해줘");
    field("작업 경로").find("input").clear().type("/tmp/am-qa-local-schedule");
    saveButton().should("be.disabled");

    field("공급자").find("select").select("local");
    editor().contains("label > span", /^실행 계정$/).should("not.exist");
    editor().find(".error-banner").should("not.exist");
    // 계정을 한 번도 고르지 않았지만 저장은 열린다.
    saveButton().should("not.be.disabled");

    // 채워 둔 값은 공급자를 바꿔도 남는다.
    field("반복할 요청").find("textarea")
      .should("have.value", "매일 아침 로컬 모델로 회차 상태를 정리해줘");
    field("작업 경로").find("input").should("have.value", "/tmp/am-qa-local-schedule");
  });

  it("로컬에서 Codex 로 되돌리면 계정 칸과 저장 잠김이 함께 돌아온다", () => {
    field("공급자").find("select").select("local");
    field("반복할 요청").find("textarea").type("주간 요약");
    field("작업 경로").find("input").clear().type("/tmp/am-qa-local-schedule");
    saveButton().should("not.be.disabled");

    field("공급자").find("select").select("codex");
    // 계정을 고르지 않은 채로 돌아왔으므로 칸이 다시 서고 저장은 도로 잠긴다.
    field("실행 계정").find("select").should("exist");
    saveButton().should("be.disabled");
  });
});
