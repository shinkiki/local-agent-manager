/// <reference types="cypress" />
import { cleanupDocRoot, ensureDocRoot, purgeDocRoots } from "../support/docRootFixtures";

// 문서 변경 자동화의 트리거 등록 폼에서 "액션" 종류를 바꿀 때 그 아래 입력부와 주의 안내가
// 함께 갈리는지 본다. 2d107be2가 이 자리의 다섯 칸(실행 대상 목록·채팅 선택지·고른 워크플로·
// 스킬 사라짐·승인 이후 스킬 변경)을 `TriggerActionView` 한 묶음으로 모았고, 값을 나르는
// 중간 자리가 바뀌었으므로 네 종류를 실제로 오가며 확인한다.
//
// 기존 문서 트리거 스펙(AM-51 빈 상태, AM-271 상태 토글, AM-303 초안 수명, AM-358 스위치
// 키보드, 0908 폼 검증)은 액션 종류를 바꾼 뒤의 입력부 전환과 주의 안내를 다루지 않는다.
// 여기서 보는 것은 세 가지다 — 실행 대상 목록이 반복 요청과 워크플로로 갈리는지, 주의 안내가
// 스킬·워크플로에만 서고 고른 워크플로의 "복구가 어려운 영향"이 붙는지, 액션을 거쳐 돌아온
// 뒤에 이전 선택(실행 대상·적용 스킬)이 남지 않고 프롬프트는 남는지.
const SNAPSHOT = {
  triggers: [],
  runs: [],
  offlineReport: null,
  options: {
    scheduledRequests: [{ id: "sched-1", label: "야간 문서 점검 반복", detail: "매일 02:00" }],
    skills: [{ id: "skill-1", label: "문서 요약 스킬", detail: null, contentDigest: "digest-1" }],
    workflows: [
      {
        id: "wf-1",
        label: "주간 문서 정리 워크플로",
        detail: null,
        version: 3,
        contentDigest: "wf-digest-1",
        hardToRecoverEffects: ["등록 폴더의 원본 문서를 덮어씀"],
      },
    ],
  },
};

describe("문서 트리거 액션 종류 전환", () => {
  const targetDir = `/tmp/am-e2e-doctrigger-action-${Date.now()}`;
  const tabs = () => cy.view("docs").find(".docs-section-tabs button");
  const grid = () => cy.get(".document-trigger-grid").last();
  const actionSelect = () => grid().find("select").first();
  const targetSelect = () => grid().contains("label", "실행 대상").find("select");
  const skillSelect = () => grid().contains("label", "적용 스킬").find("select");
  const note = () => cy.get(".document-trigger-note");

  beforeEach(() => {
    cy.exec(`mkdir -p ${targetDir}`);
    purgeDocRoots(targetDir);
    ensureDocRoot(targetDir);
    // 격리 백엔드는 반복 요청·스킬·워크플로가 모두 비어 있어 선택지 자체가 서지 않는다.
    // 선택지를 세 갈래로 채워 액션별 목록이 갈리는 것을 화면에서 볼 수 있게 한다.
    cy.stubInvoke("get_document_automation_snapshot", SNAPSHOT);
    cy.visitApp();
    cy.openView("docs").should("be.visible");
    tabs().eq(1).click();
    cy.get(".document-automation-panel").should("be.visible");
  });

  after(() => {
    cleanupDocRoot(targetDir);
  });

  it("액션을 바꾸면 실행 대상 목록이 갈리고 주의 안내가 종류에 맞춰 선다", () => {
    // 1. 기본 액션은 반복 요청 실행이다. 목록에는 반복 요청만 서고 주의 안내는 없다.
    actionSelect().should("have.value", "runSchedule");
    targetSelect().find("option").should("have.length", 2);
    targetSelect().should("contain.text", "야간 문서 점검 반복").and("not.contain.text", "주간 문서 정리 워크플로");
    note().should("not.exist");

    // 2. 대상을 고른 뒤 워크플로 실행으로 바꾸면 고른 값은 풀리고 목록이 워크플로로 갈린다.
    targetSelect().select("sched-1").should("have.value", "sched-1");
    actionSelect().select("executeWorkflow");
    targetSelect().should("have.value", "");
    targetSelect().should("contain.text", "주간 문서 정리 워크플로").and("not.contain.text", "야간 문서 점검 반복");

    // 3. 워크플로 주의 안내는 대상을 고르기 전에도 서지만, 복구가 어려운 영향은 고른 뒤에 붙는다.
    note().should("contain.text", "현재 워크플로 버전을 승인 버전으로 고정합니다");
    note().contains("strong", "복구가 어려운 영향").should("not.exist");
    targetSelect().select("wf-1");
    note().contains("strong", "복구가 어려운 영향").should("be.visible");
    note().find("li").should("have.length", 1).and("contain.text", "등록 폴더의 원본 문서를 덮어씀");

    // 4. 스킬 실행으로 바꾸면 실행 대상 자리가 적용 스킬로 바뀌고 주의 안내도 스킬 문구가 된다.
    actionSelect().select("runSkill");
    grid().contains("label", "실행 대상").should("not.exist");
    skillSelect().should("have.value", "");
    note()
      .should("contain.text", "등록 시점의 스킬 내용을 승인값으로 고정")
      .and("contain.text", "재승인 대기");
    note().contains("strong", "복구가 어려운 영향").should("not.exist");
    grid().contains("label", "스킬과 함께 보낼 요청").should("be.visible");
    cy.screenshot("doc-trigger-action-kind-skill");

    // 5. 새 채팅 요청은 스킬 칸도 주의 안내도 없이 채팅 요청 하나만 남긴다.
    actionSelect().select("startChat");
    grid().contains("label", "적용 스킬").should("not.exist");
    grid().contains("label", "채팅 요청").should("be.visible");
    note().should("not.exist");
  });

  it("고른 스킬은 다른 액션을 거쳐 돌아오면 남지 않고 프롬프트는 남는다", () => {
    actionSelect().select("runSkill");
    skillSelect().select("skill-1").should("have.value", "skill-1");
    cy.get(".document-trigger-form textarea").last().type("바뀐 문서를 요약해줘");

    // 스킬 실행이 아닌 액션으로 나가면 고른 스킬은 초안에서 지워진다.
    actionSelect().select("startChat");
    grid().contains("label", "적용 스킬").should("not.exist");
    actionSelect().select("runSkill");
    skillSelect().should("have.value", "");
    // 목록에 없는 값이 남아 "목록에 없음" 항목으로 되살아나지도 않는다.
    skillSelect().find("option").should("have.length", 2);
    note().contains("strong", "선택한 스킬을 찾을 수 없습니다").should("not.exist");

    // 액션 전환이 건드리지 않는 칸(프롬프트)은 그대로 남는다.
    cy.get(".document-trigger-form textarea").last().should("have.value", "바뀐 문서를 요약해줘");
  });
});
