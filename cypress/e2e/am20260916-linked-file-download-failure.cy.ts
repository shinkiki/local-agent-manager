/// <reference types="cypress" />
// 세션 대화의 로컬 링크 미리보기에서 '다운로드'가 실패했을 때의 안내와 그 상태의 수명주기.
// AM-278이 같은 모달의 열림·로딩·미지원/오류 갈림·닫힘·요청 경합을 봤지만 다운로드 버튼은
// "브라우저 하네스에서 파일 저장을 확인할 수 없다"는 이유로 범위 밖에 두었다. 저장 성공은
// 지금도 볼 수 없지만, 실패 갈래는 볼 수 있다 — 다운로드는 invoke가 아니라
// POST /api/download/linked-file/session으로 나가므로 그 응답만 가로채면
// `useLinkedFileDownload`(LinkedFilePreview.tsx:104)의 진행 중 잠김·오류 배너·재시도 시
// 이전 오류 지움을 모두 화면으로 판정할 수 있다.
import type { SessionDetail, SessionSummary, TranscriptItem } from "../../src/types";

const HREF = "docs/QA_LINKED_DOWNLOAD.md";

const SESSION: SessionSummary = {
  source: "codex",
  id: "qa-linked-download-session",
  title: "링크 다운로드 실패 표본",
  sourceTitle: null,
  project: "/tmp/qa-linked-download",
  cwd: "/tmp/qa-linked-download",
  startedAt: 1_757_200_000_000,
  updatedAt: 1_757_200_060_000,
  messageCount: 1,
  tokenTotal: 30,
  tokenUsage: null,
  model: "gpt-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 1024,
  filePath: "/tmp/qa-linked-download/session.jsonl",
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

const transcript: TranscriptItem[] = [
  {
    index: 0,
    turnId: "turn-1",
    role: "assistant",
    timestamp: 1,
    model: null,
    typeLabel: null,
    blocks: [{ kind: "text", text: `정리한 내용은 [QA 링크 문서](${HREF})에 남겼습니다.` }],
    usage: null,
  },
];

const DETAIL: SessionDetail = {
  session: SESSION,
  transcript,
  truncated: false,
  skippedLines: 0,
  unavailableReason: null,
};

const LINKED_FILE = {
  relativePath: HREF,
  content: "# QA 링크 문서\n\n본문 한 줄.\n",
  sizeBytes: 2048,
  targetLine: null,
  imageDataUrl: null,
};

const DOWNLOAD_ROUTE = "**/api/download/linked-file/session";

const dialog = () => cy.get(".linked-file-dialog");
const downloadButton = () => dialog().contains(".linked-file-actions button", "다운로드");
const downloadError = () => dialog().find(".linked-file-download-error .error-banner");

/** 대화 본문의 로컬 링크를 눌러 미리보기 모달을 연다. */
function openPreview() {
  cy.stubSnapshotField("sessions", [SESSION]);
  cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL }).as("detail");
  cy.stubInvoke("get_session_linked_file", { statusCode: 200, body: LINKED_FILE });
  cy.visitApp();
  cy.openView("sessions");
  cy.contains(".session-table tbody tr", SESSION.title).click();
  cy.wait("@detail");
  cy.get('[role="tablist"][aria-label="세션 상세 보기"]')
    .contains('[role="tab"]', "대화")
    .click()
    .should("have.attr", "aria-selected", "true");
  cy.contains(".transcript-turn a", "QA 링크 문서").click();
  dialog().should("be.visible").find("header strong").should("have.text", HREF);
}

describe("세션 링크 문서 미리보기의 다운로드 실패 안내", () => {
  it("보내는 동안 버튼이 잠기고, 실패하면 모달 안에 오류 배너가 남는다", () => {
    let calls = 0;
    cy.intercept("POST", DOWNLOAD_ROUTE, (req) => {
      calls += 1;
      req.reply({
        statusCode: 403,
        delay: 500,
        body: { error: "링크 파일을 내려받을 권한이 없습니다" },
      });
    }).as("download");
    openPreview();

    // 1) 처음에는 오류 안내가 없고 버튼은 누를 수 있다.
    dialog().find(".linked-file-download-error").should("not.exist");
    downloadButton().should("be.enabled");

    downloadButton().click();

    // 2) 응답을 기다리는 동안은 문구가 '다운로드 중…'으로 바뀌고 버튼이 잠긴다.
    //    이 잠김이 `run()`의 중복 실행 방지(downloading 가드)와 같은 상태다.
    dialog().contains(".linked-file-actions button", "다운로드 중…").should("be.disabled");

    cy.wait("@download").then((interception) => {
      // 3) 요청은 세션 출처·ID·링크 주소를 request로 감싸 보낸다.
      expect(interception.request.body).to.deep.equal({
        request: { source: SESSION.source, id: SESSION.id, href: HREF },
      });
    });

    // 4) 실패하면 모달은 열린 채 남고, 본문 위에 오류 배너가 붙는다.
    downloadError().should("be.visible").and("contain.text", "링크 파일을 내려받을 권한이 없습니다");
    dialog().should("be.visible");
    dialog().find("header strong").should("have.text", HREF);

    // 5) 미리보기 본문은 실패와 무관하게 그대로 읽힌다 — 다운로드 실패가 조회까지 되돌리지 않는다.
    dialog().find(".linked-file-body").should("contain.text", "본문 한 줄.");

    // 6) 버튼은 다시 눌릴 수 있는 상태로 돌아온다. 잠긴 동안 요청은 한 번만 나갔다.
    downloadButton().should("be.enabled").and("have.text", "다운로드");
    cy.then(() => expect(calls, "잠긴 동안 추가 요청이 나가지 않는다").to.equal(1));
  });

  it("다시 누르면 앞선 오류 안내부터 지우고 새 결과로 바꾼다", () => {
    let calls = 0;
    cy.intercept("POST", DOWNLOAD_ROUTE, (req) => {
      calls += 1;
      req.reply(calls === 1
        ? { statusCode: 500, body: { error: "첫 번째 실패 QA_FIRST" } }
        : { statusCode: 500, delay: 700, body: { error: "두 번째 실패 QA_SECOND" } });
    }).as("download");
    openPreview();

    // 7) 첫 시도의 오류가 배너에 남는다.
    downloadButton().click();
    downloadError().should("contain.text", "QA_FIRST");

    // 8) 두 번째 시도를 시작하면 응답이 오기 전에 앞선 오류부터 사라진다 — 지난 실패가
    //    진행 중인 시도의 결과처럼 읽히면 안 된다.
    downloadButton().click();
    dialog().contains(".linked-file-actions button", "다운로드 중…").should("be.disabled");
    dialog().find(".linked-file-download-error").should("not.exist");

    // 9) 새 응답이 도착하면 그 문구로 바뀐다.
    downloadError().should("contain.text", "QA_SECOND").and("not.contain.text", "QA_FIRST");
  });

  it("실패 안내가 떠 있어도 모달은 정상으로 닫히고, 다시 열면 남지 않는다", () => {
    cy.intercept("POST", DOWNLOAD_ROUTE, {
      statusCode: 500,
      body: { error: "저장에 실패했습니다 QA_STALE" },
    }).as("download");
    openPreview();

    downloadButton().click();
    downloadError().should("contain.text", "QA_STALE");

    // 10) 오류 배너가 떠 있어도 Esc 닫힘 경로는 그대로 동작한다.
    cy.get("body").type("{esc}");
    cy.get(".linked-file-dialog").should("not.exist");

    // 11) 같은 링크를 다시 열면 지난 실패 안내가 따라오지 않는다.
    cy.contains(".transcript-turn a", "QA 링크 문서").click();
    dialog().should("be.visible");
    dialog().find(".linked-file-download-error").should("not.exist");
    downloadButton().should("be.enabled").and("have.text", "다운로드");
  });
});
