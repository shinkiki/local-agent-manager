/// <reference types="cypress" />
// 스킬관리 화면의 '새 보관 스킬' 모달(CreateSkillModal)의 입력 유효성 검증,
// 이름(key) 형식 경계 조건, 설명 필수 입력, 백엔드 실패 응답 처리, 생성 성공 후 안내 토스트 및 취소 복귀를 검증한다.
import { openSkillLibrary, skillLibraryFixtures } from "../support/skillLibraryFixtures";

const { library } = skillLibraryFixtures("/tmp/am-qa-skill-create");
const EMPTY_LIBRARY = library([]);

const CREATE_BUTTON_TEXT = "새 보관 스킬";
const MODAL = '.modal[role="dialog"]';
const KEY_INPUT = "#skill-key";
const TITLE_INPUT = "#skill-title";
const DESC_INPUT = "#skill-description";
const SUBMIT_BUTTON = `${MODAL} .modal-footer button.primary`;
const CANCEL_BUTTON = `${MODAL} .modal-footer button:not(.primary)`;

describe("스킬관리 · 새 보관 스킬 모달의 입력 유효성과 생성 흐름", () => {
  beforeEach(() => {
    cy.stubInvoke("get_skill_library", EMPTY_LIBRARY);
  });

  it("초기 상태에서는 만들기 버튼이 잠겨 있고, 잘못된 키 형식에는 오류를 알리며 잠금을 유지한다", () => {
    openSkillLibrary();

    // 1) 툴바의 '새 보관 스킬' 버튼 클릭으로 모달을 연다.
    cy.contains(".skill-library-toolbar button", CREATE_BUTTON_TEXT).click();
    cy.get(MODAL).should("be.visible");
    cy.get(`${MODAL} .modal-title`).should("contain.text", "새 보관 스킬");

    // 2) 초기 상태: 만들기 버튼은 비활성화 상태이고 인라인 오류는 없다.
    cy.get(SUBMIT_BUTTON).should("be.disabled");
    cy.get(`${MODAL} .field-problem`).should("not.exist");

    // 3) 대문자가 섞인 유효하지 않은 키 입력 시 오류 문구가 표시되고 만들기 버튼은 계속 잠긴다.
    cy.get(KEY_INPUT).type("InvalidSkillName");
    cy.get(`${MODAL} .field-problem`).should("be.visible");
    cy.get(SUBMIT_BUTTON).should("be.disabled");

    // 4) 슬래시(/)가 포함된 유효하지 않은 키 입력 시에도 오류를 유지한다.
    cy.get(KEY_INPUT).clear().type("bad/skill/name");
    cy.get(`${MODAL} .field-problem`).should("be.visible");
    cy.get(SUBMIT_BUTTON).should("be.disabled");

    // 5) 올바른 형식의 키를 넣으면 키 오류가 사라지지만 설명이 없어 버튼은 여전히 잠긴다.
    cy.get(KEY_INPUT).clear().type("release-helper");
    cy.get(`${MODAL} .field-problem`).should("not.exist");
    cy.get(SUBMIT_BUTTON).should("be.disabled");

    // 6) 취소 버튼을 누르면 모달이 닫힌다.
    cy.get(CANCEL_BUTTON).click();
    cy.get(MODAL).should("not.exist");
  });

  it("설명까지 채워야 만들기가 풀리고, 생성 실패 시 모달을 닫지 않고 오류 배너를 띄운다", () => {
    // 실패 응답 모킹
    cy.stubInvoke("create_common_skill", {
      statusCode: 500,
      body: { error: "이미 존재하는 스킬 이름입니다." },
    }).as("createFailed");

    openSkillLibrary();
    cy.contains(".skill-library-toolbar button", CREATE_BUTTON_TEXT).click();

    // 키와 표시 이름 입력
    cy.get(KEY_INPUT).type("duplicate-skill");
    cy.get(TITLE_INPUT).type("중복 스킬");

    // 공백 설명만으로는 만들기가 풀리지 않는다.
    cy.get(DESC_INPUT).type("   ");
    cy.get(SUBMIT_BUTTON).should("be.disabled");

    // 실제 설명 입력 시 만들기 버튼 활성화
    cy.get(DESC_INPUT).clear().type("테스트용 스킬 설명입니다.");
    cy.get(SUBMIT_BUTTON).should("be.enabled");

    // 만들기 클릭 -> 실패 응답 수신
    cy.get(SUBMIT_BUTTON).click();
    cy.wait("@createFailed");

    // 모달은 닫히지 않고 내부에 에러 배너가 나타나며 입력 내용이 유지된다.
    cy.get(MODAL).should("be.visible");
    cy.get(`${MODAL} .error-banner`).should("contain.text", "이미 존재하는 스킬 이름입니다.");
    cy.get(KEY_INPUT).should("have.value", "duplicate-skill");
    cy.get(TITLE_INPUT).should("have.value", "중복 스킬");

    // 헤더 닫기 버튼으로 닫기
    cy.get(`${MODAL} .modal-header button[aria-label="닫기"]`).click();
    cy.get(MODAL).should("not.exist");
  });

  it("정상 생성 시 모달이 닫히고 상단에 생성 완료 안내가 표시된다", () => {
    cy.stubInvoke("create_common_skill", {
      statusCode: 200,
      body: {
        id: "common-auto-release",
        key: "auto-release",
        name: "자동 릴리스",
        description: "자동 릴리스 생성 스킬",
        path: "/tmp/am-qa-skill-create/common/auto-release",
        directory: "auto-release",
        contentDigest: "digest-123",
        fileCount: 1,
        totalBytes: 256,
      },
    }).as("createSuccess");

    openSkillLibrary();
    cy.contains(".skill-library-toolbar button", CREATE_BUTTON_TEXT).click();

    cy.get(KEY_INPUT).type("auto-release");
    cy.get(TITLE_INPUT).type("자동 릴리스");
    cy.get(DESC_INPUT).type("자동 릴리스 생성 스킬");

    cy.get(SUBMIT_BUTTON).should("be.enabled").click();
    cy.wait("@createSuccess");

    // 모달이 닫히고 생성 성공 안내가 뜬다.
    cy.get(MODAL).should("not.exist");
    cy.get(".skill-library-notice")
      .should("contain.text", "'auto-release' 보관 스킬을 만들었습니다.");

    cy.screenshot("am20260908-skill-create-modal");
  });
});
