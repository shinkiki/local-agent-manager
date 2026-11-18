/// <reference types="cypress" />
// 세션 상세 '대화' 탭 맨 위에 서는 사용 스킬 카드를 화면으로 본다. 같은 스킬 하나가
// 도구 호출·확인 문장·CLI가 주입한 SKILL.md 레코드 세 자리에 나타나므로(`SkillUsageSet`,
// src/lib/skillUsage.ts:191-243), 합치기가 어긋나면 한 번 쓴 스킬이 항목 세 개로 보이거나
// 주입 본문이 붙지 않아 상세가 비어 보인다. 카드의 아코디언은 openId 한 개만 들고 있어
// (src/components/ChatSkillUsage.tsx:17) 다른 항목을 열면 앞 항목이 닫혀야 한다.
// 기존 스킬 시나리오(AM-40·AM-58·AM-87 필터바, AM-108 일괄 바, AM-307 보관함 카드,
// AM-310 일괄 마이그레이션)는 모두 스킬관리 화면만 봤고, 세션 트랜스크립트 시나리오
// (AM-278 링크 미리보기, 접힌 작업 로그)는 말풍선과 작업 로그만 봤다. 대화 흐름의 사용
// 스킬 카드는 어느 시나리오도 아직 확인하지 않았다.

import type { SessionDetail, SessionSummary, TranscriptItem } from "../../src/types";

const SESSION: SessionSummary = {
  source: "claude",
  id: "qa-skill-usage-session",
  title: "사용 스킬 카드 표본",
  sourceTitle: null,
  project: "/tmp/qa-skill-usage",
  cwd: "/tmp/qa-skill-usage",
  startedAt: 1_757_200_000_000,
  updatedAt: 1_757_200_060_000,
  messageCount: 6,
  tokenTotal: 320,
  tokenUsage: null,
  model: "claude-opus-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 4096,
  filePath: "/tmp/qa-skill-usage/session.jsonl",
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

const INJECTED_BODY = [
  "Base directory for this skill: /tmp/qa-skills/qa-round-skill",
  "",
  "QA_SKILL_BODY_MARKER 회차 규율 본문",
].join("\n");

const transcript: TranscriptItem[] = [
  { index: 0, turnId: "turn-1", role: "user", timestamp: 1, model: null, typeLabel: null, blocks: [{ kind: "text", text: "QA_USER_TEXT" }], usage: null },
  // 같은 스킬 하나가 아래 세 자리에 나뉘어 들어온다. 카드 항목은 하나여야 한다.
  {
    index: 1,
    turnId: "turn-1",
    role: "assistant",
    timestamp: 2,
    model: null,
    typeLabel: null,
    blocks: [{ kind: "tool_use", name: "Skill", inputJson: '{"skill":"qa-round-skill","args":"QA_SKILL_ARGS_MARKER"}' }],
    usage: null,
  },
  { index: 2, turnId: "turn-1", role: "assistant", timestamp: 3, model: null, typeLabel: null, blocks: [{ kind: "tool_result", text: "Launching skill: qa-round-skill", isError: false }], usage: null },
  { index: 3, turnId: "turn-1", role: "user", timestamp: 4, model: null, typeLabel: null, blocks: [{ kind: "context", label: "사용 스킬 · qa-round-skill", text: INJECTED_BODY }], usage: null },
  // 주입 레코드 없이 SKILL.md 경로만 읽은 두 번째 스킬. 상세는 스킬 목록에서 원본을 찾는다.
  {
    index: 4,
    turnId: "turn-1",
    role: "assistant",
    timestamp: 5,
    model: null,
    typeLabel: null,
    blocks: [{ kind: "tool_use", name: "Read", inputJson: '{"file_path":"/tmp/qa-skills/qa-path-skill/SKILL.md"}' }],
    usage: null,
  },
  { index: 5, turnId: "turn-1", role: "assistant", timestamp: 6, model: null, typeLabel: null, blocks: [{ kind: "text", text: "QA_ANSWER_TEXT" }], usage: null },
];

const DETAIL: SessionDetail = {
  session: SESSION,
  transcript,
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

const EMPTY_LIBRARY = {
  schemaVersion: 1,
  commonRoot: "/tmp/qa-skills",
  commonRootPresent: true,
  currentPlatform: "macos",
  entries: [],
  adapters: [],
  projects: [],
  issues: [],
};

const card = () => cy.get(".transcript-turn.conversation-turn .chat-skill-usage");
const cardToggle = () => card().find("button.chat-skill-usage-toggle");
const items = () => card().find(".chat-skill-usage-list > li");

describe("세션 상세 대화 탭의 사용 스킬 카드", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", [SESSION]);
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
    cy.stubInvoke("get_skill_library", { statusCode: 200, body: EMPTY_LIBRARY }).as("library");
    cy.visitApp();
    cy.openView("sessions");
    cy.contains(".session-table tbody tr", SESSION.title).click();
    cy.wait("@detail");
    cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
      .contains('[role="tab"]', "대화")
      .click()
      .should("have.attr", "aria-selected", "true");
  });

  it("세 자리에 나뉘어 온 같은 스킬이 항목 하나로 합쳐져 머리에 개수와 이름이 선다", () => {
    cardToggle().should("have.attr", "aria-expanded", "false");
    cardToggle().find("strong").should("have.text", "사용 스킬 2개");
    cardToggle().find("em").should("contain.text", "qa-round-skill").and("contain.text", "qa-path-skill");
    card().find(".chat-skill-usage-list").should("not.exist");

    cardToggle().click().should("have.attr", "aria-expanded", "true");
    items().should("have.length", 2);
    items().eq(0).find("b").should("have.text", "qa-round-skill");
    items().eq(1).find("b").should("have.text", "qa-path-skill");
    // Skill 도구 인자에서 읽은 지시가 부제로 선다. 경로로 추정한 쪽은 지시가 없다.
    items().eq(0).find("small").should("contain.text", "QA_SKILL_ARGS_MARKER");
    items().eq(1).find("small").should("have.text", "SKILL.md를 직접 읽어 시작");
  });

  it("주입된 SKILL.md가 항목 상세로 붙어 출처·경로·본문이 읽힌다", () => {
    cardToggle().click();
    items().eq(0).find("button.chat-skill-usage-item").click().should("have.attr", "aria-expanded", "true");
    const detail = () => items().eq(0).find(".chat-skill-usage-detail");
    detail().find(".chat-skill-usage-meta").should("contain.text", "이 대화에 주입된 SKILL.md");
    detail().find(".chat-skill-usage-meta").should("contain.text", "/tmp/qa-skills/qa-round-skill");
    detail().find(".chat-skill-usage-body").should("contain.text", "QA_SKILL_BODY_MARKER");
    // 주입 본문이 있으면 스킬 목록을 읽지 않는다.
    cy.get("@library.all").should("have.length", 0);
  });

  it("스킬 목록에 없는 스킬은 못 찾음 안내를 내고, 항목은 한 번에 하나만 열린다", () => {
    cardToggle().click();
    items().eq(0).find("button.chat-skill-usage-item").click().should("have.attr", "aria-expanded", "true");
    items().eq(1).find("button.chat-skill-usage-item").click().should("have.attr", "aria-expanded", "true");
    items().eq(0).find("button.chat-skill-usage-item").should("have.attr", "aria-expanded", "false");
    items().eq(0).find(".chat-skill-usage-detail").should("not.exist");
    cy.wait("@library");
    items().eq(1).find(".chat-skill-usage-detail")
      .should("contain.text", "이 기기의 스킬 목록에서 찾지 못했습니다");
  });

  it("카드가 대신 보여주는 Skill 도구 블록은 접힌 작업 로그에 겹쳐 나오지 않는다", () => {
    const collapsed = () => cy.get(".transcript-turn.conversation-turn .turn-activity-summary");
    collapsed().find("button.turn-activity-toggle").click().should("have.attr", "aria-expanded", "true");
    collapsed().should("not.contain.text", "Launching skill:");
    collapsed().should("not.contain.text", "QA_SKILL_ARGS_MARKER");
    // 경로로 추정한 쪽은 그 자체가 일반 도구 실행이라 로그에 남는다.
    collapsed().should("contain.text", "qa-path-skill");
  });
});
