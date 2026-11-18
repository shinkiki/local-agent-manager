// 반복 요청 편집기 '고급 옵션' 안의 세션 참조 범위 편집기(SessionReadPolicyFields)를 붙잡는다.
// 이 컴포넌트는 반복 요청과 채팅 입력창이 함께 쓰는데(src/components/SessionReadPolicyFields.tsx:55),
// 어떤 스펙도 내부를 연 적이 없다. 기존 AM 시나리오는 편집기의 실행 대상 전환에서 고급 요약줄에
// '세션 참조' 문구가 붙고 사라지는 것까지만 봤고, 켠 뒤의 필드 묶음·요약 동기화·빈 상태는 처음이다.
//
// 붙잡는 계약
// - 꺼짐이 기본이다(defaultSessionReadPolicy, src/lib/sessionReadPolicy.ts:29). 이때 하위 필드는
//   아예 그려지지 않고 안내문만 남으며, 요약은 '세션 참조 사용 안 함'이다.
// - 출처 배지는 AIA 추천값이 없으면 '수동 설정'이고, 추천이 없으니 되돌리기 버튼도 없다
//   (sessionReadOriginFor, src/lib/sessionReadPolicy.ts:65).
// - 켜면 요약(describeSessionReadPolicy, src/lib/sessionReadPolicy.ts:150)이 기본값을 그대로
//   문장으로 편다. 값을 바꿀 때마다 컴포넌트 안 요약과 바깥 '고급 옵션' 접힘 요약이 같이 움직인다.
// - 숫자 칸의 상한은 SESSION_READ_LIMITS(같은 파일 20)를 max 속성으로 내보낸다.
// - 프로젝트 범위를 '선택한 등록 프로젝트'로 옮기면, 등록 프로젝트가 없는 격리 하네스에서는
//   목록 대신 빈 상태 안내가 뜨고 요약은 '선택 프로젝트 0개'가 된다.
// - 편집기를 취소하고 다시 열면 정책은 저장된 적이 없으므로 기본값(꺼짐)으로 돌아간다.

function editor() {
  return cy.get(".schedule-editor");
}

function advancedToggle() {
  return editor().find(".schedule-advanced-toggle");
}

/** 고급 옵션 접힘 줄에 실린 한 줄 요약. 컴포넌트 안 요약과 같은 함수를 쓴다. */
function advancedSummary() {
  return advancedToggle().find("small");
}

function policyFields() {
  return editor().find(".session-read-fields");
}

/** 컴포넌트 상단의 aria-live 요약 문단 */
function policySummary() {
  return policyFields().find(".session-read-summary strong");
}

function enableToggle() {
  return policyFields().find("> label.check-filter input[type=checkbox]");
}

/** 라벨 span 텍스트로 정책 그리드의 칸 하나를 잡는다. */
function policyField(label: string) {
  return policyFields().contains("label > span", new RegExp(`^${label}$`)).parent();
}

/** 칩 묶음(공급자·세션 상태) 안의 체크박스 하나 */
function chip(legend: string, text: string) {
  return policyFields()
    .contains("fieldset.session-read-chips > legend", legend)
    .parent()
    .contains("label.check-filter", text)
    .find("input[type=checkbox]");
}

function openAdvanced() {
  advancedToggle().click().should("have.attr", "aria-expanded", "true");
  policyFields().should("be.visible");
}

describe("반복 요청 편집기의 세션 참조 범위 편집기", () => {
  beforeEach(() => {
    cy.visitApp();
    cy.openScheduleEditor();
  });

  it("기본은 꺼짐이라 하위 필드가 없고, 추천값이 없으니 출처는 수동 설정에 되돌리기 버튼도 없다", () => {
    // 1) 고급 옵션을 열기 전에도 접힘 줄이 이미 정책 요약을 들고 있다.
    advancedToggle().should("have.attr", "aria-expanded", "false");
    advancedSummary().should("contain.text", "세션 참조: 세션 참조 사용 안 함");

    // 2) 열면 편집기가 나타나고, 기본 정책은 꺼짐이다.
    openAdvanced();
    enableToggle().should("not.be.checked");
    policySummary().should("have.text", "세션 참조: 세션 참조 사용 안 함");

    // 3) 꺼짐일 때는 그리드 자체가 그려지지 않고 안내문만 남는다.
    policyFields().find(".session-read-grid").should("not.exist");
    policyFields()
      .find("small.session-read-hint")
      .should("contain.text", "실행 중에는 이 범위를 넓힐 수 없고");

    // 4) AIA 추천값이 없는 새 반복 요청이므로 출처는 수동 설정이고 되돌리기 버튼이 없다.
    policyFields().find(".session-read-origin").should("have.text", "수동 설정").and("have.class", "manual");
    policyFields().contains("button", "AIA 추천값 다시 적용").should("not.exist");
  });

  it("켜면 기본값이 요약 한 줄로 펴지고 숫자 칸은 정책 상한을 max로 내건다", () => {
    openAdvanced();
    enableToggle().check().should("be.checked");

    // 1) 기본값 그대로가 요약이 된다 — 범위·공급자·기간·상세수준·최대 세션 수 다섯 조각.
    policySummary().should("have.text", "세션 참조: 일정 작업 경로 · 전체 공급자 · 보고기간 · 요약 · 최대 50개");
    // 접힘 줄도 같은 문장을 든다.
    advancedSummary().should("contain.text", "세션 참조: 일정 작업 경로 · 전체 공급자 · 보고기간 · 요약 · 최대 50개");

    // 2) 프로젝트 범위 첫 선택지는 이 편집기가 넘긴 이름(ownScopeLabel)을 쓴다.
    policyField("프로젝트 범위").find("select").should("have.value", "scheduleCwd");
    policyField("프로젝트 범위").find("option:selected").should("have.text", "이 일정의 작업 경로");

    // 3) 칩은 비어 있는 상태가 '전체'라고 안내한다.
    chip("공급자", "Claude").should("not.be.checked");
    chip("세션 상태", "완료").should("not.be.checked");

    // 4) 숫자 칸의 기본값과 상한.
    policyField("최대 세션 수").find("input").should("have.value", "50").and("have.attr", "max", "500");
    policyField("세션당 최대 턴").find("input").should("have.value", "40").and("have.attr", "max", "200");
    policyField("페이지 크기").find("input").should("have.value", "20").and("have.attr", "max", "50");

    // 5) 상세 수준은 요약이고, 고른 값에 맞는 설명이 붙는다.
    policyField("상세 수준").find("select").should("have.value", "summary");
    policyField("상세 수준").find("small.session-read-hint").should("have.text", "세션 요약 항목만 읽습니다.");
  });

  it("값을 바꿀 때마다 요약이 따라 붙고, 기간을 최근 N일로 바꾸면 일수 칸이 생긴다", () => {
    openAdvanced();
    enableToggle().check();

    // 1) 공급자를 하나 고르면 '전체 공급자'가 그 이름으로 바뀐다.
    chip("공급자", "Claude").check();
    policySummary().should("contain.text", "Claude").and("not.contain.text", "전체 공급자");

    // 2) 상태 칩은 요약 끝에 '…만'으로 따로 붙는다.
    chip("세션 상태", "완료").check();
    policySummary().should("contain.text", "완료만");

    // 3) 기간을 최근 N일로 옮기면 숫자 칸이 새로 생기고 요약의 기간 조각이 바뀐다.
    policyField("기간").find("select").select("recentDays");
    policyField("최근 N일").find("input").should("have.attr", "max", "365").and("have.value", "7");
    policySummary().should("not.contain.text", "보고기간").and("contain.text", "최근 7일");
    // 숫자 칸은 controlled라 clear()가 0을 거쳐 되돌아온다. 앞에 덧붙지 않도록 통째로 고쳐 넣는다.
    policyField("최근 N일").find("input").type("{selectall}3");
    policySummary().should("contain.text", "최근 3일");

    // 4) 상세 수준·민감정보 제거·연결 파일은 각자 요약 조각을 갖는다.
    policyField("상세 수준").find("select").select("limitedTranscript");
    policySummary().should("contain.text", "제한된 원문");
    policyField("민감정보 제거").find("select").select("strict");
    policySummary().should("contain.text", "민감정보 강력 제거");
    policyFields().contains("label.check-filter", "연결 파일도 읽기 허용").find("input").check();
    policySummary().should("contain.text", "연결 파일 포함");

    // 5) 접었다 펴도 값은 그대로다 — 상태는 편집기 쪽에 있고 컴포넌트는 다시 그려질 뿐이다.
    advancedToggle().click().should("have.attr", "aria-expanded", "false");
    policyFields().should("not.exist");
    advancedSummary().should("contain.text", "최근 3일").and("contain.text", "연결 파일 포함");
    openAdvanced();
    chip("공급자", "Claude").should("be.checked");
    policyField("최근 N일").find("input").should("have.value", "3");
  });

  it("선택한 등록 프로젝트로 옮기면 빈 목록 안내가 뜨고, 편집기를 다시 열면 기본값으로 돌아온다", () => {
    openAdvanced();
    enableToggle().check();
    policyField("프로젝트 범위").find("select").select("selected");

    // 1) 격리 하네스에는 등록 프로젝트가 없어 목록 대신 빈 상태 안내만 남는다.
    const projects = () => policyFields().find("fieldset.session-read-projects");
    projects().should("be.visible");
    projects().find("legend").should("have.text", "등록 프로젝트 선택");
    projects().should("contain.text", "확인한 등록 프로젝트가 없습니다");
    // 목록이 없으니 검색 칸도 모두 선택 버튼도 그려지지 않는다.
    projects().find('input[aria-label="등록 프로젝트 검색"]').should("not.exist");
    projects().contains("button", "모두 선택").should("not.exist");
    // 목록에 없는 경로는 거부된다는 안내는 빈 상태에서도 남는다.
    projects().should("contain.text", "목록에 없는 경로는 저장 시점과 실행 시점 모두 거부됩니다");

    // 2) 고를 것이 없으므로 요약은 0개다.
    policySummary().should("contain.text", "선택 프로젝트 0개");

    // 3) 취소하고 새로 열면 저장된 적이 없으니 기본값(꺼짐)으로 돌아온다.
    editor().find("footer .button").contains("취소").click();
    editor().should("not.exist");
    cy.newScheduleEditor();
    advancedSummary().should("contain.text", "세션 참조: 세션 참조 사용 안 함");
    openAdvanced();
    enableToggle().should("not.be.checked");
  });
});
