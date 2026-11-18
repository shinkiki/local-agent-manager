/// <reference types="cypress" />

import type {
  AiaOnboardingCardView,
  AiaOnboardingCatalog,
  AiaOnboardingField,
  AiaOnboardingSkillTemplate,
  LocalizedText,
  SystemWorkflowContract,
} from "../../src/types";

// AM 신규 패턴 2건.
//
// 1) W6-9: 온보딩이 번들 절차를 워크플로 id의 프로젝트 전용 공통 스킬로 만들고,
//    등록 계약의 requiredSkills가 그 복사본을 가리키는지 확인한다.
// 2) W6-8: 병렬 회차를 고르면 레인 절차가 계약에 붙고, 회차 저장 확인창과 실제
//    create_scheduled_request 본문이 같은 동시 실행 건수를 싣는지 확인한다.
//
// 기존 온보딩 E2E는 단계 이동·기록 대상·언어 전환까지만 보고 실제 만들기 직전에서
// 멈춘다. 이 스펙은 앱이 이미 쓰는 격리 하네스와 IPC 인터셉트만 사용한다.

const AIA = '[data-ui-anchor="workflows.automation-content"]';
const PROJECT = "F:\\Project\\qa-onboarding";

const localized = (ko: string, en = ko): LocalizedText => ({ ko, en });

function field(
  key: string,
  label: string,
  kind: AiaOnboardingField["kind"],
  extra: Partial<AiaOnboardingField> = {},
): AiaOnboardingField {
  return {
    key,
    label: localized(label),
    kind,
    required: false,
    wide: false,
    placeholder: null,
    help: null,
    defaultValue: null,
    options: [],
    min: null,
    max: null,
    visibleWhen: null,
    allowOther: false,
    ...extra,
  };
}

function card({ id, title, procedure, scheduled }: {
  id: string;
  title: string;
  procedure: string | null;
  scheduled: boolean;
}): AiaOnboardingCardView {
  return {
    id,
    icon: "workflow",
    title: localized(title),
    summary: localized(`${title} 요약`),
    description: localized(`${title} 설명`),
    badge: null,
    enabled: true,
    templates: [],
    steps: [{
      id: "setup",
      title: localized("회차 설정"),
      hint: null,
      fields: [
        field("projectPath", "프로젝트", "projectPicker", { required: true, wide: true }),
        field("workflowKey", "워크플로 id", "text", { required: true }),
      ],
    }],
    actions: [
      {
        kind: "registerWorkflow",
        label: localized("회차 워크플로"),
        when: null,
        workflow: {
          id: "{{workflowKey}}-delivery",
          displayName: "{{workflowKey}} 진행 회차",
          description: "{{projectPath}}에서 한 항목씩 진행한다.",
          message: "{{projectPath}}의 회차다.",
          projectPathField: "projectPath",
          requiredSkills: [],
          parallel: true,
          procedure,
        },
      },
      ...(scheduled ? [{
        kind: "createScheduledRequest" as const,
        label: localized("페이싱 회차"),
        when: null,
        schedule: { name: "{{workflowKey}} 진행 회차", enabled: false },
      }] : []),
    ],
    previewOnly: false,
    source: "bundled",
    packId: "qa-e2e",
    skillKey: null,
    packCardCount: 2,
  };
}

const PROCEDURE_SKILL: AiaOnboardingSkillTemplate = {
  key: "delivery-round",
  name: "진행 회차",
  description: "프로젝트 진행 회차 절차",
  files: [{
    path: "SKILL.md",
    content: "---\nname: delivery-round\ndescription: 프로젝트 진행 회차 절차\n---\n\n# 진행 회차\n\n한 항목을 끝냅니다.\n",
  }],
  installed: false,
};

const LANE_SKILL: AiaOnboardingSkillTemplate = {
  key: "parallel-round-lanes",
  name: "병렬 회차 레인",
  description: "병렬 회차 레인 절차",
  files: [{
    path: "SKILL.md",
    content: "---\nname: parallel-round-lanes\ndescription: 병렬 회차 레인 절차\n---\n\n# 레인\n",
  }],
  installed: true,
};

function catalog(cards: AiaOnboardingCardView[]): AiaOnboardingCatalog {
  return {
    packs: [{
      packId: "qa-e2e",
      version: "1.0.0",
      displayName: "QA E2E",
      source: "bundled",
      skillKey: null,
      cardCount: cards.length,
    }],
    cards,
    issues: [],
    skills: [PROCEDURE_SKILL, LANE_SKILL],
    manifestRelative: "references/aia-onboarding.json",
    skillsRoot: "F:\\AgentManager\\resource-repository\\skills",
  };
}

function stubOnboarding(onboardingCatalog: AiaOnboardingCatalog): void {
  cy.stubInvoke("get_aia_onboarding_catalog", onboardingCatalog);
  cy.stubInvoke("get_project_registry", [{
    path: PROJECT,
    name: "QA onboarding",
    sessionCount: 1,
    hiddenSessionCount: 0,
    updatedAt: null,
    providers: ["codex"],
    active: true,
    pending: false,
    exists: true,
  }]);
  cy.stubInvoke("get_doc_roots", []);
  cy.stubInvoke("get_cypress_registry", { enabled: false, workspaces: [] });
  cy.stubInvoke("get_external_plugins", { plugins: [] });
  cy.stubInvoke("get_claude_plugin_branch_rules", { projects: [] });
}

function stubWorkflowRegistration(version: number): void {
  cy.stubInvoke("propose_system_workflow_schema", (req) => {
    const contract = (req.body as { request: SystemWorkflowContract }).request;
    req.reply({
      valid: true,
      contract,
      computedRisk: "mutating",
      requiredOperations: ["start_chat"],
      approvalSummary: {
        name: contract.displayName,
        purpose: contract.description,
        mutatingOperations: ["start_chat"],
        hardToRecoverEffects: [],
        grantsAfterRegistration: "이 계약은 등록 뒤 채팅을 시작할 수 있습니다.",
      },
    });
  }).as("proposeWorkflow");
  cy.stubInvoke("register_system_workflow", (req) => {
    const contract = (req.body as { request: SystemWorkflowContract }).request;
    req.reply({ registered: true, workflowId: contract.id, version });
  }).as("registerWorkflow");
}

function openCard(title: string, workflowKey: string): Cypress.Chainable<JQuery<HTMLElement>> {
  cy.visitApp();
  cy.openAutomationTab();
  cy.contains(".aia-onboarding-start", title).contains("button", "시작").click();
  cy.contains(".aia-onboarding-wizard", title).as("wizard");
  cy.get("@wizard").contains("label", "프로젝트").find("select").select(PROJECT);
  cy.get("@wizard").contains("label", "워크플로 id").find("input").type(workflowKey);
  return cy.get("@wizard");
}

function confirmDialog(title: string): Cypress.Chainable<JQuery<HTMLElement>> {
  return cy.contains('[role="dialog"]', title);
}

describe("AIA 온보딩의 절차 의존과 페이싱 회차 저장 확인", () => {
  it("프로젝트 전용 절차 스킬을 먼저 만들고 그 키를 워크플로 의존으로 등록한다 (W6-9)", () => {
    const procedureCard = card({
      id: "procedure-dependency",
      title: "절차 의존 확인",
      procedure: "delivery-round",
      scheduled: false,
    });
    stubOnboarding(catalog([procedureCard]));
    cy.stubInvoke("get_common_skill_digests", []).as("skillDigests");
    cy.stubInvoke("create_common_skill", {
      key: "alpha-delivery",
      name: "alpha-delivery",
      contentDigest: "empty-digest",
    }).as("createProcedure");
    cy.stubInvoke("update_common_skill", {
      key: "alpha-delivery",
      name: "alpha-delivery",
      contentDigest: "filled-digest",
    }).as("writeProcedure");
    stubWorkflowRegistration(3);

    openCard("절차 의존 확인", "alpha").contains("button", "만들기").click();

    confirmDialog("회차 절차 스킬 만들기")
      .should("contain.text", "alpha-delivery")
      .contains("button", "만들기")
      .click();

    cy.wait("@createProcedure").its("request.body.request").should("deep.include", {
      key: "alpha-delivery",
      name: "alpha-delivery",
    });
    cy.wait("@writeProcedure").then(({ request }) => {
      const input = request.body.request as {
        key: string;
        expectedDigest: string;
        files: { path: string; content: string }[];
      };
      expect(input.key).to.equal("alpha-delivery");
      expect(input.expectedDigest).to.equal("empty-digest");
      expect(input.files).to.have.length(1);
      expect(input.files[0].path).to.equal("SKILL.md");
      expect(input.files[0].content).to.contain("name: alpha-delivery");
      expect(input.files[0].content).to.contain("# 진행 회차");
    });

    confirmDialog("워크플로 등록").should("contain.text", "alpha-delivery");
    cy.get("@proposeWorkflow").its("request.body.request").then((contract: SystemWorkflowContract) => {
      expect(contract.id).to.equal("alpha-delivery");
      expect(contract.requiredSkills).to.deep.equal(["alpha-delivery"]);
      expect(contract.requiredSkills).not.to.include("delivery-round");
      expect(contract.requiredSkills).not.to.include("parallel-round-lanes");
    });
    confirmDialog("워크플로 등록").contains("button", "등록").click();

    cy.wait("@registerWorkflow");
    cy.anchor("workflows.automation-done")
      .should("contain.text", "만들기가 끝났습니다")
      .and("contain.text", "절차 스킬")
      .and("contain.text", "alpha-delivery")
      .and("contain.text", "alpha-delivery v3");
  });

  it("병렬 수 20건을 확인창과 예약 요청에 같은 값으로 싣고 일시정지 회차를 저장한다 (W6-8)", () => {
    const scheduledCard = card({
      id: "round-save-preview",
      title: "회차 저장 확인",
      procedure: null,
      scheduled: true,
    });
    stubOnboarding(catalog([scheduledCard]));
    cy.stubInvoke("get_common_skill_digests", [{
      key: "parallel-round-lanes",
      name: "병렬 회차 레인",
      contentDigest: "lane-digest",
    }]);
    stubWorkflowRegistration(4);
    cy.stubInvoke("get_scheduler_snapshot", { paused: false, runnerActive: true, schedules: [], runs: [] });
    cy.stubInvoke("create_scheduled_request", (req) => {
      const input = req.body.request as { name: string; enabled: boolean };
      req.reply({ id: "round-alpha", ...input });
    }).as("createRound");

    openCard("회차 저장 확인", "beta").then(($wizard) => {
      cy.wrap($wizard).contains("label", "병렬 실행").find('input[type="checkbox"]').check();
      cy.wrap($wizard).contains("label", "동시 실행 건수").find('input[type="number"]').clear().type("20");
      cy.wrap($wizard)
        .should("contain.text", "회차는 동시 20건으로 돌고 레인 절차 스킬을 따릅니다")
        .contains("button", "만들기")
        .click();
    });

    cy.wait("@proposeWorkflow").its("request.body.request").then((contract: SystemWorkflowContract) => {
      expect(contract.id).to.equal("beta-delivery");
      expect(contract.requiredSkills).to.deep.equal(["parallel-round-lanes"]);
      const message = contract.inputSchema.message.defaultValue;
      expect(message).to.be.a("string")
        .and.contain("## 병렬 실행")
        .and.contain("병렬 수: 20")
        .and.contain("parallel-round-lanes");
    });
    confirmDialog("워크플로 등록").contains("button", "등록").click();

    confirmDialog("페이싱 회차 저장")
      .should("contain.text", "새 회차를 일시정지 상태로 저장합니다")
      .and("contain.text", "beta 진행 회차")
      .and("contain.text", "beta-delivery v4")
      .and("contain.text", "동시 실행 20건");
    cy.get("@createRound.all").should("have.length", 0);
    confirmDialog("페이싱 회차 저장").contains("button", "저장").click();

    cy.wait("@createRound").then(({ request }) => {
      const input = request.body.request as {
        name: string;
        enabled: boolean;
        workflow: { workflowId: string; approvedVersion: number; pacing: { maxRuns: number } };
      };
      expect(input.name).to.equal("beta 진행 회차");
      expect(input.enabled).to.equal(false);
      expect(input.workflow).to.deep.include({ workflowId: "beta-delivery", approvedVersion: 4 });
      expect(input.workflow.pacing.maxRuns).to.equal(20);
    });
    cy.anchor("workflows.automation-done")
      .should("contain.text", "만들기가 끝났습니다")
      .and("contain.text", "꺼진 상태")
      .and("contain.text", "동시 20건");
  });
});
