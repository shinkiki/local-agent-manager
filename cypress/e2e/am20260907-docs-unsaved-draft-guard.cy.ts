/**
 * 문서 화면 — 저장하지 않은 초안이 있을 때 다른 문서로 옮기려 할 때의 되묻기.
 *
 * 이탈 확인은 DocsView.tsx:110의 confirmDiscardDraft 한 벌이 네 자리(문서 이동·폴더
 * 전환·새 문서·기록 이동)를 맡는다. 이 스펙은 그중 문서 이동 자리를 화면에서 본다.
 * - 되묻는 조건: src/components/DocsView.tsx:110 (dirty가 아니면 묻지 않는다)
 * - 이동 앞 관문: DocsView.tsx:167 (confirmDiscardDraft를 지나야 조회로 들어간다)
 * - 초안 초기화: DocsView.tsx:185 showDocument(file, false) — 새 문서는 미리보기로 선다
 * - 편집·저장 버튼 계약: src/components/DocumentFilePane.tsx:73-86 (dirty가 아니면 저장 비활성)
 *
 * 기존 AM 문서 시나리오는 사이드바 접힘(AM-5)·폴더 등록 검증(AM-36/AM-47)·새 문서 경로
 * (AM-101)·트리 검색(AM-121)만 다뤘고, 저장하지 않은 편집 초안을 들고 이탈하는 갈래는
 * 어떤 스펙도 잡은 적이 없다.
 *
 * 등록한 폴더를 남기면 "폴더 0건"을 전제로 하는 다른 문서 스펙이 무너지므로 이 스펙 안에서
 * 되돌린다.
 */
const ALPHA_BODY = "# 알파 원본\n";
const BETA_BODY = "# 베타 원본\n";

describe("문서 화면 저장하지 않은 초안 이탈 확인", () => {
  const target = `/tmp/am-e2e-docsdraft-${Date.now()}`;

  before(() => {
    cy.exec(`mkdir -p ${target}`);
    cy.exec(`printf '${ALPHA_BODY}' > ${target}/alpha-draft.md`);
    cy.exec(`printf '${BETA_BODY}' > ${target}/beta-draft.md`);
  });

  after(() => {
    cy.request("POST", "/api/invoke/get_doc_roots", {}).then((res) => {
      for (const root of res.body as Array<{ id: string; path: string }>) {
        if (root.path.endsWith(target.slice("/tmp".length))) {
          cy.request("POST", "/api/invoke/delete_doc_root", { id: root.id });
        }
      }
    });
    cy.exec(`rm -rf ${target}`, { failOnNonZeroExit: false });
  });

  // runMode 재시도가 있으므로 등록 상태를 전제하지 않는다. 없으면 API로 등록해 둔다.
  const openRoot = () => {
    cy.visitApp();
    cy.request({ method: "POST", url: "/api/invoke/create_doc_root", body: { request: { name: "", path: target, createIfMissing: false } }, failOnStatusCode: false });
    cy.reload();
    cy.anchor("nav.docs").click();
    cy.contains(".root-row code", target).click();
    cy.get(".document-tree-pane").should("exist");
  };

  // 알파 문서를 열고 편집 칸에 한 줄 덧붙여 저장하지 않은 초안을 만든다.
  const startDirtyDraft = () => {
    openRoot();
    cy.contains(".tree-row.file", "alpha-draft.md").click();
    cy.get(".doc-header-title strong").should("have.text", "alpha-draft.md");
    cy.get('.document-file-header [aria-label="편집"]').click();
    cy.get("textarea.doc-editor").should("have.value", ALPHA_BODY).type("초안 한 줄");
    cy.get(".document-file-header .button.primary").should("have.text", "저장").and("not.be.disabled");
  };

  it("초안이 있으면 되묻고, 거절하면 원래 문서와 편집 중 초안이 그대로 남는다", () => {
    startDirtyDraft();

    const asked: string[] = [];
    cy.on("window:confirm", (text) => {
      asked.push(text);
      return false;
    });

    cy.contains(".tree-row.file", "beta-draft.md").click();
    cy.wrap(asked).should("have.length", 1);
    cy.wrap(asked).its(0).should("eq", "저장하지 않은 변경이 있습니다. 이동할까요?");

    // 이탈을 거절했으니 머리말·편집 칸·저장 버튼이 모두 알파 초안 그대로여야 한다.
    cy.get(".doc-header-title strong").should("have.text", "alpha-draft.md");
    cy.get("textarea.doc-editor").should("have.value", `${ALPHA_BODY}초안 한 줄`);
    cy.get(".document-file-header .button.primary").should("not.be.disabled");
    cy.get(".tree-row.file.active").should("contain.text", "alpha-draft.md");
  });

  it("초안이 있어도 승인하면 새 문서가 미리보기로 서고 버린 초안은 되돌아오지 않는다", () => {
    startDirtyDraft();

    cy.on("window:confirm", () => true);

    cy.contains(".tree-row.file", "beta-draft.md").click();
    cy.get(".doc-header-title strong").should("have.text", "beta-draft.md");
    // 이동한 문서는 편집이 아니라 미리보기로 서므로 편집 칸과 저장 버튼이 없다.
    cy.get("textarea.doc-editor").should("not.exist");
    cy.get(".document-file-header .button.primary").should("not.exist");
    cy.get(".markdown-preview").should("contain.text", "베타 원본");

    // 알파로 돌아오면 버린 초안이 아니라 파일에 저장된 원본이 보여야 한다.
    cy.contains(".tree-row.file", "alpha-draft.md").click();
    cy.get(".doc-header-title strong").should("have.text", "alpha-draft.md");
    cy.get(".markdown-preview").should("contain.text", "알파 원본").and("not.contain.text", "초안 한 줄");
  });

  it("저장하지 않은 변경이 없으면 문서 이동에 아무 것도 묻지 않는다", () => {
    openRoot();
    cy.contains(".tree-row.file", "alpha-draft.md").click();
    cy.get(".doc-header-title strong").should("have.text", "alpha-draft.md");

    const asked: string[] = [];
    cy.on("window:confirm", (text) => {
      asked.push(text);
      return true;
    });

    cy.contains(".tree-row.file", "beta-draft.md").click();
    cy.get(".doc-header-title strong").should("have.text", "beta-draft.md");
    cy.wrap(asked).should("have.length", 0);
  });
});
