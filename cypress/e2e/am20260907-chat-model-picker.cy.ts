/**
 * 새 채팅 시작 폼의 모델 선택기(ModelPicker: RuntimeSettings.tsx:25) 팝오버 계약.
 *
 * 최근 리팩토링(49f03b6, a3d438a)을 거치며 채팅 실행 설정 체계가 정비되었으나,
 * 시작 폼 내 모델 선택기(ModelPicker)의 팝오버 열림, 키보드 Esc 닫기,
 * 닫기 버튼 클릭, 모델 선택 시 트리거 반영 및 팝오버 닫힘에 대한 E2E 스펙은
 * 존재하지 않았다.
 *
 * 이 스펙은 격리 백엔드의 새 채팅 시작 폼에서 모델 선택기 팝오버를 열고,
 * 1) 기본 선택 상태("공급자 기본값") 및 목록 표시,
 * 2) Esc 키 입력 시 팝오버 닫힘,
 * 3) 닫기 버튼([aria-label="모델 선택 닫기"]) 클릭 시 닫힘,
 * 4) 특정 모델 클릭 시 선택 반영 및 닫힘
 * 동작을 붙잡는다.
 */

const modelPickerTrigger = () => cy.get(".model-picker-trigger");
const modelPickerPopover = () => cy.get(".model-picker-popover");
const modelPickerList = () => cy.get(".model-picker-list");
const modelPickerCloseButton = () => cy.get('.model-picker-popover-head button[aria-label="모델 선택 닫기"]');

describe("새 채팅 시작 폼의 모델 선택기 팝오버 열림·닫힘 및 선택 반영 계약", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openView("chat");
    cy.get(".chat-launch-form").should("be.visible");
  });

  it("초기에는 팝오버가 닫혀 있고, 트리거를 누르면 열리며 목록과 기본 선택 항목을 보여준다", () => {
    modelPickerPopover().should("not.exist");
    modelPickerTrigger()
      .should("have.attr", "aria-expanded", "false")
      .and("contain.text", "공급자 기본값");

    modelPickerTrigger().click();
    modelPickerTrigger().should("have.attr", "aria-expanded", "true");
    modelPickerPopover().should("be.visible");
    modelPickerList().should("be.visible");

    // 기본 선택 항목인 '공급자 기본값' 옵션이 선택 상태로 표시됨
    modelPickerList()
      .find('button[role="option"]')
      .first()
      .should("have.attr", "aria-selected", "true")
      .and("contain.text", "공급자 기본값");
  });

  it("팝오버가 열려 있을 때 Esc 키를 누르면 팝오버가 닫힌다", () => {
    modelPickerTrigger().click();
    modelPickerPopover().should("be.visible");

    cy.get("body").type("{esc}");
    modelPickerPopover().should("not.exist");
    modelPickerTrigger().should("have.attr", "aria-expanded", "false");
  });

  it("팝오버 상단의 닫기 버튼을 누르면 팝오버가 닫힌다", () => {
    modelPickerTrigger().click();
    modelPickerPopover().should("be.visible");

    modelPickerCloseButton().click();
    modelPickerPopover().should("not.exist");
    modelPickerTrigger().should("have.attr", "aria-expanded", "false");
  });

  it("목록에서 모델을 선택하면 트리거에 반영되고 팝오버가 닫히며, 다시 열었을 때 해당 항목이 선택됨으로 표시된다", () => {
    modelPickerTrigger().click();
    modelPickerPopover().should("be.visible");

    // 첫 번째 옵션은 '공급자 기본값'이므로, 목록에 모델이 있는 경우 두 번째 항목을 선택
    modelPickerList()
      .find('button[role="option"]')
      .then(($options) => {
        if ($options.length > 1) {
          const targetOption = $options.eq(1);
          const modelName = targetOption.find("strong").text().trim();

          cy.wrap(targetOption).click();
          modelPickerPopover().should("not.exist");
          modelPickerTrigger()
            .should("have.attr", "aria-expanded", "false")
            .and("contain.text", modelName);

          // 다시 열면 선택했던 항목에 aria-selected=true가 유지되어야 함
          modelPickerTrigger().click();
          modelPickerPopover().should("be.visible");
          cy.contains('.model-picker-list button[role="option"]', modelName)
            .should("have.attr", "aria-selected", "true");

          // 다시 '공급자 기본값'을 누르면 원복되고 닫힘
          modelPickerList().find('button[role="option"]').first().click();
          modelPickerPopover().should("not.exist");
          modelPickerTrigger().should("contain.text", "공급자 기본값");
        }
      });
  });
});
