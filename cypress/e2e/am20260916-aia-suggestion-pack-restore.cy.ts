/**
 * 설정 → AIA 설정, 'AIA 선제 제안 팩' 카드의 설치 상태별 버튼 3상태와 검증 문제 목록.
 *
 * AM-258(am20260912-skill-library-suggestion-pack-card)은 팩이 **설치되지 않은** 상태의
 * 복사 버튼과 확인 모달 취소 갈래만 봤고, AM-246은 설정 탭 시절의 on/off 토글만 봤다.
 * 팩이 이미 설치된 뒤의 세 갈래 — 문제 없음(비활성), 다른 팩의 문제(여전히 비활성),
 * 번들 팩 자신의 문제(복구 활성) — 와 복구 승인이 실제로 내보내는 IPC 순서는 어느
 * 시나리오도 확인하지 않았다.
 *
 * 축은 AIA, 조건은 경계 상태 전환(설치 여부 × 문제 귀속)과 되돌릴 수 없는 덮어쓰기의
 * 승인 갈래다. 버튼 비활성 판정은 `AiaSuggestionPackPanel.tsx:200`의
 * `installed && bundledIssues.length === 0`이고, bundledIssues는 `skillKey`가 번들 키와
 * 같은 문제만 센다(:79) — 다른 공통 스킬 팩의 문제는 목록에만 뜨고 복구를 열어 주지 않는다.
 *
 * 확인하는 것:
 *  - 설치됨 + 문제 없음 → 버튼은 '공통 스킬에 설치됨'이고 비활성, 문제 목록이 없다
 *  - 설치됨 + 다른 팩의 문제 → 문제 줄은 뜨지만 버튼은 그대로 비활성이다
 *  - 설치됨 + 번들 팩의 문제 → '기본 팩으로 복구'가 열리고 '마지막 정상 팩 사용 중'이 붙는다
 *  - 복구 확인 모달은 danger 어조이고, 승인하면 create_common_skill 없이
 *    get_common_skill_detail → update_common_skill 순으로 나가며 안내가 남는다
 */
const BUNDLED_KEY = "aia-suggestion-pack";

function definition(id: string) {
  return {
    packId: "bundled",
    packDisplayName: "기본 제안 팩",
    skillKey: null,
    definition: { id, title: `제안 ${id}`, body: "" },
  };
}

function catalog(options: { installed: boolean; issues: Array<{ skillKey: string; message: string; usingLastKnownGood: boolean }> }) {
  return {
    contentDigest: "qa-digest",
    packs: [],
    definitions: [definition("alpha"), definition("beta")],
    issues: options.issues,
    bundledSkill: {
      key: BUNDLED_KEY,
      name: "AIA 선제 제안 팩",
      description: "제안 문구와 명령 초안",
      files: [{ path: "SKILL.md", content: "# 제안 팩" }],
      installed: options.installed,
    },
  };
}

const BUNDLED_ISSUE = {
  skillKey: BUNDLED_KEY,
  message: "제안 3번의 임계값이 숫자가 아닙니다.",
  usingLastKnownGood: true,
};

const OTHER_ISSUE = {
  skillKey: "team-suggestion-pack",
  message: "제안 목록이 비어 있습니다.",
  usingLastKnownGood: false,
};

function card() {
  return cy.get(".aia-suggestion-pack-card");
}

function packButton() {
  return card().find("button.button.compact");
}

function dialog() {
  return cy.get('.modal[role="dialog"]');
}

function openSuggestionPanel() {
  cy.visitApp();
  cy.openSettingsTab("aia");
  card().should("be.visible");
}

describe("AIA 선제 제안 팩 카드의 설치 뒤 상태와 기본값 복구", () => {
  beforeEach(() => {
    // 복사 경로의 IPC는 모두 막아 두고, 복구가 어느 쪽을 쓰는지까지 센다.
    cy.stubInvoke("create_common_skill", { statusCode: 200, body: { key: BUNDLED_KEY, contentDigest: "qa-digest" } }).as("createCommon");
    cy.stubInvoke("get_common_skill_detail", {
      statusCode: 200,
      body: { source: { key: BUNDLED_KEY, name: "AIA 선제 제안 팩", contentDigest: "installed-digest" }, body: "# 제안 팩", files: [] },
    }).as("detailCommon");
    cy.stubInvoke("update_common_skill", { statusCode: 200, body: { key: BUNDLED_KEY, contentDigest: "qa-digest" } }).as("updateCommon");
  });

  it("설치됐고 문제가 없으면 버튼이 '공통 스킬에 설치됨'으로 잠기고 문제 목록이 없다", () => {
    cy.stubInvoke("get_aia_suggestion_catalog", { statusCode: 200, body: catalog({ installed: true, issues: [] }) });
    openSuggestionPanel();

    card().find(".section-title span").should("have.text", "2개 제안");
    packButton().should("have.text", "공통 스킬에 설치됨").and("be.disabled");
    card().find(".aia-suggestion-pack-issues").should("not.exist");
  });

  it("다른 공통 스킬 팩의 문제는 목록에만 뜨고 복구 버튼을 열어 주지 않는다", () => {
    cy.stubInvoke("get_aia_suggestion_catalog", { statusCode: 200, body: catalog({ installed: true, issues: [OTHER_ISSUE] }) });
    openSuggestionPanel();

    card().find(".aia-suggestion-pack-issues li").should("have.length", 1);
    card().find(".aia-suggestion-pack-issues li code").should("have.text", "team-suggestion-pack");
    card().find(".aia-suggestion-pack-issues li span").should("have.text", OTHER_ISSUE.message);
    card().find(".aia-suggestion-pack-issues li small").should("not.exist");
    packButton().should("have.text", "공통 스킬에 설치됨").and("be.disabled");
  });

  it("번들 팩 자신의 문제면 '기본 팩으로 복구'가 열리고 마지막 정상 팩 표기가 붙는다", () => {
    cy.stubInvoke("get_aia_suggestion_catalog", { statusCode: 200, body: catalog({ installed: true, issues: [OTHER_ISSUE, BUNDLED_ISSUE] }) });
    openSuggestionPanel();

    card().find(".aia-suggestion-pack-issues li").should("have.length", 2);
    card().find(".aia-suggestion-pack-issues li").last().find("code").should("have.text", BUNDLED_KEY);
    card().find(".aia-suggestion-pack-issues li").last().find("small").should("have.text", "마지막 정상 팩 사용 중");
    packButton().should("have.text", "기본 팩으로 복구").and("not.be.disabled");
  });

  it("복구 확인 모달은 덮어쓰기를 danger로 알리고, 취소하면 아무 쓰기도 나가지 않는다", () => {
    cy.stubInvoke("get_aia_suggestion_catalog", { statusCode: 200, body: catalog({ installed: true, issues: [BUNDLED_ISSUE] }) });
    openSuggestionPanel();

    packButton().click();
    dialog().find(".modal-title").should("contain.text", "AIA 제안 팩 복구");
    dialog().find(".confirm-dialog p").first()
      .should("have.text", "현재 공통 스킬의 내용을 앱 기본 제안 팩으로 덮어씁니다. 계속할까요?");
    dialog().find(".modal-footer button").last().should("have.text", "기본값으로 복구").and("have.class", "danger");

    dialog().find(".modal-footer button").first().should("have.text", "취소").click();
    dialog().should("not.exist");
    cy.get("@detailCommon").should("not.exist");
    cy.get("@updateCommon").should("not.exist");
  });

  it("복구를 승인하면 새 스킬을 만들지 않고 기존 원본의 지문으로 덮어쓰며 안내가 남는다", () => {
    cy.stubInvoke("get_aia_suggestion_catalog", { statusCode: 200, body: catalog({ installed: true, issues: [BUNDLED_ISSUE] }) });
    openSuggestionPanel();

    packButton().click();
    dialog().find(".modal-footer button").last().click();

    cy.wait("@detailCommon");
    cy.wait("@updateCommon").its("request.body").should((body) => {
      const request = (body as { request: { key?: string; expectedDigest?: string; deletes?: unknown[] } }).request;
      expect(request.key).to.eq(BUNDLED_KEY);
      // 복구는 목록이 들고 있던 옛 지문이 아니라 그 자리에서 다시 읽은 원본 지문을 쓴다.
      expect(request.expectedDigest).to.eq("installed-digest");
      expect(request.deletes).to.deep.eq([]);
    });
    cy.get("@createCommon").should("not.exist");

    cy.get(".addon-inline-notice").should("have.text", "AIA 제안 팩을 앱 기본값으로 복구했습니다.");
  });
});
