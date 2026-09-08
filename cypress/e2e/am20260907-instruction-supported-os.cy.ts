// 지침 관리 1단계 "지원 OS 지정"의 변경 판정과 저장 후 복원.
// 저장 버튼은 arraysEqual(순서를 보지 않는 집합 비교, src/components/InstructionsView.tsx:2878)로
// 열리고 닫히며, 저장은 setProjectInstructionPlatforms 뒤 목록을 다시 읽어 체크 상태를
// 저장본으로 되돌린다(InstructionsView.tsx:1008). 현재 OS를 지원하지 않는 지침은 1단계 탭이
// attention 톤을 달고 AIA 변형 만들기 버튼이 함께 나온다(InstructionsView.tsx:972, 1106).
type Entry = {
  key: string;
  name: string;
  platforms: string[];
  currentPlatformSupported: boolean;
};

function entry(key: string, name: string, platforms: string[], currentPlatformSupported: boolean) {
  return {
    key,
    name,
    description: `${name} 설명`,
    directory: `/Users/qa/.agents/instructions/${key}`,
    sourceDigest: "d1",
    providers: ["claude"],
    platforms,
    currentPlatformSupported,
    currentPlatformVariant: null,
    autoSync: false,
    linkedFiles: [],
    deployments: [],
  };
}

function library(entries: Entry[]) {
  return {
    schemaVersion: 1,
    commonRoot: "/Users/qa/.agents/instructions",
    commonRootPresent: true,
    currentPlatform: "macos",
    projects: ["/Users/qa/alpha-ledger"],
    entries: entries.map((item) => entry(item.key, item.name, item.platforms, item.currentPlatformSupported)),
    deployments: [],
    issues: [],
  };
}

const PORTABLE = { key: "portable-guide", name: "이식 지침", platforms: [], currentPlatformSupported: true };
const UNSUPPORTED = { key: "windows-guide", name: "윈도우 전용 지침", platforms: ["windows"], currentPlatformSupported: false };

function toggle(label: string) {
  return cy.get(".skill-use-toggle").contains(label).find("input[type=checkbox]");
}

function saveButton() {
  return cy.get("#instruction-step-panel").find("button").contains("지원 OS 저장");
}

function openManage(name: string) {
  cy.openInstructionMode("manage");
  cy.get(".skill-library-row").contains(name).click();
  return cy.get(".instruction-manage-card").should("be.visible");
}

describe("지침 1단계 지원 OS 지정", () => {
  it("같은 집합으로 되돌아오면 저장 버튼이 다시 닫히고, 저장하면 저장본으로 복원된다", () => {
    // 저장 요청을 받은 뒤에는 목록이 새 값을 돌려주도록 응답을 갈아 끼운다.
    let current = library([PORTABLE, UNSUPPORTED]);
    cy.stubInvoke("get_project_instruction_library", (req) => {
      req.reply({ statusCode: 200, body: current });
    });
    cy.stubInvoke("set_project_instruction_platforms", (req) => {
      current = library([{ ...PORTABLE, platforms: ["macos", "linux"] }, UNSUPPORTED]);
      req.reply({ statusCode: 200, body: entry(PORTABLE.key, PORTABLE.name, ["macos", "linux"], true) });
    }).as("savePlatforms");
    cy.visitApp();

    openManage("이식 지침");

    // 1) 미선택(portable) 상태에서는 세 OS 모두 꺼져 있고 저장할 것이 없다.
    cy.get('.instruction-tabs [role="tab"]').eq(0).should("have.attr", "aria-selected", "true");
    cy.get(".skill-use-toggle input[type=checkbox]:checked").should("have.length", 0);
    saveButton().should("be.disabled");

    // 2) 하나만 켜도 저장 버튼이 열린다.
    toggle("macOS").check();
    saveButton().should("be.enabled");

    // 3) 켠 것을 다시 끄면 저장본과 같은 집합이라 버튼이 닫힌다.
    toggle("macOS").uncheck();
    saveButton().should("be.disabled");

    // 4) 켠 순서를 바꿔도 집합이 같으면 판정은 바뀌지 않는다. Linux를 먼저 켜고 macOS를
    //    더한 뒤 Linux를 빼면 {macOS} 하나만 남아 여전히 열려 있어야 한다.
    toggle("Linux").check();
    toggle("macOS").check();
    toggle("Linux").uncheck();
    saveButton().should("be.enabled");

    // 5) 저장하면 지정한 두 OS가 그대로 요청에 실린다.
    toggle("Linux").check();
    saveButton().click();
    cy.wait("@savePlatforms").its("request.body").then((body) => {
      const request = (body.request ?? body) as { key: string; platforms: string[]; expectedDigest: string };
      expect(request.key).to.eq("portable-guide");
      expect(request.platforms).to.have.members(["macos", "linux"]);
      expect(request.expectedDigest).to.eq("d1");
    });

    // 6) 저장 뒤 다시 읽은 목록이 체크 상태의 기준이 되어, 두 OS가 켜진 채 버튼은 닫힌다.
    cy.get(".skill-use-toggle input[type=checkbox]:checked").should("have.length", 2);
    toggle("macOS").should("be.checked");
    toggle("Linux").should("be.checked");
    toggle("Windows").should("not.be.checked");
    saveButton().should("be.disabled");

    // 7) 다른 지침으로 옮기면 그 지침의 저장본이 다시 기준이 된다.
    cy.get(".skill-library-row").contains("윈도우 전용 지침").click();
    toggle("Windows").should("be.checked");
    toggle("macOS").should("not.be.checked");
    saveButton().should("be.disabled");
  });

  it("현재 OS를 지원하지 않는 지침은 1단계가 주의 표시를 달고 AIA 변형 버튼을 함께 낸다", () => {
    cy.stubInvoke("get_project_instruction_library", {
      statusCode: 200,
      body: library([PORTABLE, UNSUPPORTED]),
    });
    cy.visitApp();

    openManage("윈도우 전용 지침");

    // 8) 목록 행과 1단계 탭이 모두 미지원임을 알린다.
    cy.get(".skill-library-row.conflict").contains("윈도우 전용 지침").should("exist");
    cy.get('.instruction-tabs [role="tab"]').eq(0).should("have.class", "attention");

    // 9) 미지원일 때만 나오는 AIA 변형 만들기 버튼이 1단계 안에 있다.
    cy.get("#instruction-step-panel").find("button").contains("AIA로 현재 OS 변형 만들기").should("exist");

    // 10) 지원하는 지침으로 옮기면 주의 표시와 그 버튼이 함께 사라진다.
    cy.get(".skill-library-row").contains("이식 지침").click();
    cy.get('.instruction-tabs [role="tab"]').eq(0).should("not.have.class", "attention");
    cy.get("#instruction-step-panel").contains("AIA로 현재 OS 변형 만들기").should("not.exist");
  });
});
