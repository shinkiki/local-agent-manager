/// <reference types="cypress" />
/**
 * 세션 참조 범위 편집기의 '등록 프로젝트 선택'을 목록이 있는 상태에서 확인한다.
 *
 * AM-183(am20260907-schedule-session-read-policy)은 이 필드셋을 열어 봤지만 격리
 * 백엔드에 세션이 하나도 없어 **빈 상태 안내**까지만 봤다. 목록이 채워졌을 때의
 * 툴바(모두 선택·선택 해제 비활성 조건)·검색 칸·검색 결과 없음·행의 세션 개수는
 * 어느 스펙도 연 적이 없다(src/components/SessionReadPolicyFields.tsx:349-436).
 *
 * 목록의 출처는 스냅숏 세션을 경로로 묶는 collectProjects(src/App.tsx:1346)다.
 * 그래서 숨김 세션과 AIA 작업공간 세션이 목록에서 빠지는지도 여기서 같이 본다.
 *
 * 붙잡는 계약
 * 1. 세션 3종이 프로젝트 3개로 접히고, 숨김·AIA 세션의 경로는 빠진다. 정렬은
 *    updatedAt 내림차순이고 행마다 '세션 N개'가 붙는다.
 * 2. 처음에는 0개 선택이라 '선택 해제'가 잠기고 '모두 선택'만 열린다. 하나 고르면
 *    툴바 수와 요약(`선택 프로젝트 N개`)이 같이 움직인다.
 * 3. 검색은 이름과 경로 둘 다에 걸리고, 맞는 것이 없으면 목록 대신 안내가 뜬다.
 *    검색은 이미 고른 값을 건드리지 않는다.
 * 4. '모두 선택'을 누르면 전체가 선택되어 그 버튼이 잠기고 '선택 해제'가 열린다.
 *    되돌리면 반대가 된다.
 */
import type { ProviderId, SessionSummary } from "../../src/types";

const META: SessionSummary["meta"] = {
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
};

const BASE = 1_757_000_000_000;
const ALPHA = "/tmp/qa-read-projects/alpha-service";
const BETA = "/tmp/qa-read-projects/beta-tools";
const GAMMA = "/tmp/qa-read-projects/gamma-lab";

let seq = 0;

function session(
  name: string,
  cwd: string,
  ageMinutes: number,
  overrides: { hidden?: boolean; aiaWorkspace?: boolean } = {},
): SessionSummary {
  const source: ProviderId = "claude";
  seq += 1;
  return {
    source,
    id: `qa-read-proj-${seq}`,
    title: `${name} 세션 ${seq}`,
    sourceTitle: null,
    project: name,
    cwd,
    startedAt: BASE - ageMinutes * 60_000 - 30_000,
    updatedAt: BASE - ageMinutes * 60_000,
    messageCount: 3,
    tokenTotal: 100,
    tokenUsage: null,
    model: "qa-model",
    gitBranch: "develop",
    isSubagent: false,
    aiaWorkspace: overrides.aiaWorkspace ?? false,
    archived: false,
    readable: true,
    sizeBytes: 2048,
    filePath: `${cwd}/qa-read-proj-${seq}.jsonl`,
    meta: { ...META, hidden: overrides.hidden ?? false },
    lastFailure: null,
  };
}

// 알파가 가장 최근이고 세션 둘, 베타·감마는 하나씩. 숨김과 AIA 작업공간 세션은 각자
// 다른 경로에 두어 목록에 새어 나오면 곧바로 드러나게 한다.
const SESSIONS: SessionSummary[] = [
  session("알파 서비스", ALPHA, 1),
  session("알파 서비스", ALPHA, 30),
  session("베타 도구", BETA, 60),
  session("감마 실험실", GAMMA, 120),
  session("숨김 프로젝트", "/tmp/qa-read-projects/hidden-proj", 2, { hidden: true }),
  session("AIA 작업공간", "/tmp/qa-read-projects/aia-proj", 3, { aiaWorkspace: true }),
];

const fields = () => cy.get(".schedule-editor .session-read-fields");
const summary = () => fields().find(".session-read-summary strong");
const picker = () => fields().find("fieldset.session-read-projects");
const rows = () => picker().find(".session-read-project-option");
const search = () => picker().find('input[aria-label="등록 프로젝트 검색"]');
const toolbarCount = () => picker().find(".session-read-project-toolbar strong");
const selectAll = () => picker().contains("button", "모두 선택");
const clearAll = () => picker().contains("button", "선택 해제");

/** 이름으로 행 하나의 체크박스를 잡는다. */
const rowBox = (name: string) =>
  picker().contains(".session-read-project-option", name).find("input[type=checkbox]");

function openPicker() {
  cy.get(".schedule-editor .schedule-advanced-toggle").click().should("have.attr", "aria-expanded", "true");
  fields().find("> label.check-filter input[type=checkbox]").check().should("be.checked");
  fields().contains("label > span", /^프로젝트 범위$/).parent().find("select").select("selected");
  picker().should("be.visible");
}

describe("세션 참조 범위의 등록 프로젝트 선택 목록", () => {
  beforeEach(() => {
    seq = 0;
    cy.stubSnapshotField("sessions", SESSIONS);
    cy.visitApp();
    cy.openScheduleEditor();
    openPicker();
  });

  it("세션을 경로로 접어 최근 순으로 세우고 숨김·AIA 세션의 경로는 빼 놓는다", () => {
    rows().should("have.length", 3);
    rows().eq(0).should("contain.text", "알파 서비스").and("contain.text", "세션 2개");
    rows().eq(1).should("contain.text", "베타 도구").and("contain.text", "세션 1개");
    rows().eq(2).should("contain.text", "감마 실험실").and("contain.text", "세션 1개");

    // 숨김 세션과 AIA 작업공간 세션의 경로는 목록에 없다.
    picker().should("not.contain.text", "숨김 프로젝트");
    picker().should("not.contain.text", "AIA 작업공간");

    // 경로도 같이 보이고, 빈 상태에서도 남던 안내는 그대로다.
    rows().eq(0).should("contain.text", "alpha-service");
    picker().should("contain.text", "목록에 없는 경로는 저장 시점과 실행 시점 모두 거부됩니다");
  });

  it("고른 것이 없으면 선택 해제가 잠기고, 하나 고르면 툴바 수와 요약이 같이 움직인다", () => {
    toolbarCount().should("have.text", "0개 선택");
    clearAll().should("be.disabled");
    selectAll().should("not.be.disabled");
    summary().should("contain.text", "선택 프로젝트 0개");

    rowBox("베타 도구").check().should("be.checked");
    toolbarCount().should("have.text", "1개 선택");
    clearAll().should("not.be.disabled");
    summary().should("contain.text", "선택 프로젝트 1개");
    // 고른 행은 표시용 클래스를 얻는다.
    picker().contains(".session-read-project-option", "베타 도구").should("have.class", "selected");

    rowBox("베타 도구").uncheck().should("not.be.checked");
    toolbarCount().should("have.text", "0개 선택");
    summary().should("contain.text", "선택 프로젝트 0개");
  });

  it("검색은 이름과 경로 둘 다에 걸리고, 맞는 것이 없으면 안내만 남으며 고른 값은 그대로다", () => {
    rowBox("감마 실험실").check();
    summary().should("contain.text", "선택 프로젝트 1개");

    // 이름으로 좁힌다.
    search().type("베타");
    rows().should("have.length", 1).and("contain.text", "베타 도구");

    // 경로 조각으로 좁힌다.
    search().clear().type("gamma-lab");
    rows().should("have.length", 1).and("contain.text", "감마 실험실");
    // 좁혀도 이미 고른 값은 살아 있다.
    rowBox("감마 실험실").should("be.checked");
    toolbarCount().should("have.text", "1개 선택");

    // 맞는 것이 없으면 목록 대신 안내다.
    search().clear().type("없는프로젝트");
    rows().should("not.exist");
    picker().find(".session-read-project-empty").should("have.text", "검색 결과가 없습니다.");
    // 검색은 정책을 건드리지 않는다.
    summary().should("contain.text", "선택 프로젝트 1개");

    // 지우면 셋이 다시 선다.
    search().clear();
    rows().should("have.length", 3);
  });

  it("모두 선택은 전체를 담아 스스로 잠기고, 선택 해제가 그것을 되돌린다", () => {
    selectAll().click();
    rows().filter(".selected").should("have.length", 3);
    toolbarCount().should("have.text", "3개 선택");
    summary().should("contain.text", "선택 프로젝트 3개");
    selectAll().should("be.disabled");
    clearAll().should("not.be.disabled");

    clearAll().click();
    rows().filter(".selected").should("have.length", 0);
    toolbarCount().should("have.text", "0개 선택");
    summary().should("contain.text", "선택 프로젝트 0개");
    selectAll().should("not.be.disabled");
    clearAll().should("be.disabled");
  });
});
