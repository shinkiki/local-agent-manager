// (임시 스펙): 스킬관리 일괄 작업 바의 "선택 조합 → 버튼 잠금" 짝과, 삭제·보관취소
// 확인 대화가 대상 목록과 덧붙는 안내문(미보관 선보관·사용처 없는 항목 소멸)을
// 어떻게 조립하는지. AM-40은 같은 화면의 필터 칩 개수만 봤고, 일괄 작업 바의 잠금
// 규칙과 확인 대화의 items·안내문은 어느 시나리오도 확인하지 않았다. 취소 갈래에서
// 아무 명령도 나가지 않는 것까지 함께 붙잡는다.
import {
  openSkillLibrary,
  skillBulkBar as bar,
  skillBulkButton as bulkButton,
  skillLibraryFixtures,
} from "../support/skillLibraryFixtures";

const { entry, providerState, library } = skillLibraryFixtures("/tmp/ambulk");

// 설치본은 skillId를 갖는다(확인 대화의 "사용처" 산정 근거).
const install = (provider: string) => providerState(provider, { skillId: `${provider}-install` });

// 세 항목이 일괄 작업 바의 세 갈래를 각각 대표하도록 짠 표본.
//   alpha  보관 + 사용처 1곳  → 보관취소 대상, 보관 대상 아님
//   gamma  미보관             → 보관 대상, 보관취소 대상 아님, 선보관 안내의 근원
//   delta  보관 + 사용처 0곳  → 보관취소하면 목록에서 사라지는 항목
const LIBRARY = library([
  entry("alpha", { common: true, providers: [install("claude")] }),
  entry("gamma", { common: false, providers: [install("claude")] }),
  entry("delta", { common: true, providers: [] }),
]);

const check = (name: string) => cy.get(`.skill-bulk-check[aria-label="${name} 선택"]`);
const dialog = () => cy.get(".modal[role='dialog']");

function openLibrary(): void {
  openSkillLibrary();
  cy.get(".skill-library-filterbar").should("exist");
  cy.get(".skill-library-list .skill-library-item").should("have.length", 3);
}

describe("스킬관리 일괄 작업 바의 잠금 짝과 확인 대화 조립", () => {
  beforeEach(() => {
    cy.stubInvoke("get_skill_library", LIBRARY);
    cy.stubInvoke("delete_shared_skill", { statusCode: 200, body: {} }).as("deleteShared");
    cy.stubInvoke("unarchive_shared_skill", { statusCode: 200, body: {} }).as("unarchive");
    cy.stubInvoke("import_skill_to_common", { statusCode: 200, body: {} }).as("importCommon");
  });

  it("아무것도 고르지 않으면 실행 버튼 다섯이 모두 잠기고 전체선택만 열려 있다", () => {
    openLibrary();

    // 1) 선택 0건의 표기와 전체선택 라벨.
    bar().find("strong").should("have.text", "0개 선택됨");
    bulkButton("전체선택").should("not.be.disabled");

    // 2) 대상이 없으므로 실행 버튼은 전부 잠긴다.
    for (const label of ["보관", "보관취소", "사용", "미사용", "삭제"]) {
      bulkButton(label).should("be.disabled");
    }

    // 3) 전체선택을 누르면 세 건이 잡히고 버튼 이름이 해제로 뒤집힌다.
    bulkButton("전체선택").click();
    bar().find("strong").should("have.text", "3개 선택됨");
    bulkButton("전체해제").should("exist");
    bulkButton("전체해제").click();
    bar().find("strong").should("have.text", "0개 선택됨");
  });

  it("보관 여부에 따라 보관·보관취소만 갈라 잠기고 나머지 셋은 선택만 있으면 열린다", () => {
    openLibrary();

    // 4) 미보관 한 건만 고르면 보관은 열리고 보관취소는 잠긴다.
    check("gamma").click();
    bar().find("strong").should("have.text", "1개 선택됨");
    bulkButton("보관").should("not.be.disabled");
    bulkButton("보관취소").should("be.disabled");
    bulkButton("삭제").should("not.be.disabled");
    bulkButton("미사용").should("not.be.disabled");
    bulkButton("사용").should("not.be.disabled");

    // 5) 보관된 한 건만 고르면 정확히 반대가 된다.
    check("gamma").click();
    check("alpha").click();
    bulkButton("보관").should("be.disabled");
    bulkButton("보관취소").should("not.be.disabled");

    // 6) 섞어 고르면 둘 다 열린다 - 각자 자기 몫만 대상으로 삼기 때문이다.
    check("gamma").click();
    bar().find("strong").should("have.text", "2개 선택됨");
    bulkButton("보관").should("not.be.disabled");
    bulkButton("보관취소").should("not.be.disabled");
  });

  it("삭제 확인 대화는 고른 전부를 대상으로 세고 미보관 항목의 선보관을 안내한다", () => {
    openLibrary();
    bulkButton("전체선택").click();
    bulkButton("삭제").click();

    // 7) 제목·대상 수와 미보관 선보관 안내 한 줄.
    dialog().find(".modal-title").should("contain.text", "스킬 삭제");
    dialog().should("contain.text", "스킬 3개를 삭제할까요?");
    dialog().should("contain.text", "보관되지 않은 스킬 1개는 먼저 보관한 뒤 삭제합니다.");

    // 8) 대상 목록은 고른 세 건을 그대로 늘어놓는다.
    dialog().find(".confirm-dialog-items li code").should("have.length", 3);
    dialog().find(".confirm-dialog-items").should("contain.text", "alpha")
      .and("contain.text", "gamma").and("contain.text", "delta");

    // 9) 취소하면 대화만 닫히고 아무 명령도 나가지 않으며 선택은 남는다.
    dialog().contains("button", "취소").click();
    cy.get(".modal[role='dialog']").should("not.exist");
    cy.get("@deleteShared.all").should("have.length", 0);
    cy.get("@importCommon.all").should("have.length", 0);
    bar().find("strong").should("have.text", "3개 선택됨");
  });

  it("보관취소 확인 대화는 보관된 항목만 대상으로 세고 사용처 없는 항목의 소멸을 안내한다", () => {
    openLibrary();
    bulkButton("전체선택").click();
    bulkButton("보관취소").click();

    // 10) 미보관인 gamma는 대상에서 빠져 둘만 남는다.
    dialog().find(".modal-title").should("contain.text", "스킬 보관취소");
    dialog().should("contain.text", "스킬 2개의 보관을 취소할까요?");
    dialog().find(".confirm-dialog-items li code").should("have.length", 2);
    dialog().find(".confirm-dialog-items").should("not.contain.text", "gamma");

    // 11) 사용처가 없는 delta 한 건은 목록에서 사라진다고 미리 알린다.
    dialog().should("contain.text", "사용 중인 에이전트가 없는 1개는 목록에서 사라집니다.");

    // 12) 승인하면 대상 두 건만 명령이 나가고 미보관 항목은 보관되지 않는다.
    dialog().contains("button", "보관취소").click();
    cy.wait("@unarchive");
    cy.get("@unarchive.all").should("have.length", 2);
    cy.get("@importCommon.all").should("have.length", 0);
  });
});
