/**
 * 파일 화면 트리의 우클릭 메뉴.
 *
 * 사이드바의 `새문서.md` 입력 칸을 걷어 내고, 만들기·이름 변경·이동·복제·삭제·다운로드를
 * 트리 우클릭 메뉴로 옮겼다. 메뉴는 항목 종류마다 다르다 — 파일(이름 변경·이동·복제·
 * 다운로드·삭제), 폴더(이름 변경·이동·하위 폴더 만들기·삭제), 루트(파일 만들기·폴더 만들기).
 * 결과는 화면이 아니라 디스크에서 확인한다 — 화면만 맞고 파일이 남거나 덮이면 그게 사고다.
 *
 * 앞서 있던 `am20260906-docs-new-file-path`의 경계(앞뒤 공백 자르기, 확장자 없으면 .md 한 번,
 * 같은 이름이면 거절하고 원본을 덮지 않음)는 루트 메뉴의 '파일 만들기'가 그대로 이어받는다.
 */
import { cleanupDocRoot, ensureDocRoot } from "../support/docRootFixtures";

describe("파일 화면 우클릭 메뉴", () => {
  const target = `/tmp/am-e2e-entry-menu-${Date.now()}`;

  before(() => {
    cy.exec(`mkdir -p ${target}`);
  });

  after(() => {
    cleanupDocRoot(target);
  });

  const openRoot = () => {
    cy.visitApp();
    ensureDocRoot(target);
    cy.reload();
    cy.openView("docs");
    cy.contains(".root-row code", target).click();
    cy.get(".document-tree-pane").should("exist");
  };

  const rootMenu = () => cy.get(".document-tree-pane").rightclick("bottom");
  const rowMenu = (name: string) => cy.contains(".document-tree-pane .tree-row strong", new RegExp(`^${name}$`)).rightclick();
  const menuItem = (label: string) => cy.contains(".doc-entry-menu button", label).click();
  const nameDialog = (value: string) => {
    cy.get(".doc-entry-name-dialog input").clear().type(value);
    cy.get(".modal-footer .button.primary").click();
  };
  const ls = (path = "") => cy.exec(`ls -A ${target}/${path}`).its("stdout");

  it("새 문서 입력 칸은 없고 루트 메뉴는 파일·폴더 만들기만 보인다", () => {
    openRoot();
    cy.get(".new-doc-row").should("not.exist");
    rootMenu();
    cy.get(".doc-entry-menu button").should("have.length", 2);
    cy.contains(".doc-entry-menu button", "파일 만들기").should("exist");
    cy.contains(".doc-entry-menu button", "폴더 만들기").should("exist");
    cy.get("body").type("{esc}");
    cy.get(".doc-entry-menu").should("not.exist");
  });

  it("파일 만들기는 공백을 자르고 확장자가 없을 때만 .md를 붙이며 같은 이름은 덮지 않는다", () => {
    openRoot();
    rootMenu();
    menuItem("파일 만들기");
    nameDialog("  경계값-문서  ");
    cy.get(".doc-entry-name-dialog").should("not.exist");
    ls().should("eq", "경계값-문서.md");

    rootMenu();
    menuItem("파일 만들기");
    nameDialog("대문자.MD");
    ls().should("contain", "대문자.MD").and("not.contain", ".MD.md");

    cy.exec(`printf '# 지키고 싶은 본문\\n' > ${target}/경계값-문서.md`);
    rootMenu();
    menuItem("파일 만들기");
    nameDialog("경계값-문서");
    // 실패하면 대화상자는 닫히지 않고 그 자리에 사유를 보여 준다.
    cy.get(".modal .error-banner").should("contain.text", "같은 이름");
    cy.get(".modal-footer .button").contains("취소").click();
    cy.exec(`cat ${target}/경계값-문서.md`).its("stdout").should("contain", "지키고 싶은 본문");
  });

  it("파일 메뉴로 복제·이름 변경·이동·삭제한다", () => {
    cy.exec(`rm -rf ${target}/* && mkdir -p ${target}/보관 && printf 'body' > ${target}/메모.txt`);
    openRoot();
    rowMenu("메모.txt");
    ["이름 변경", "이동", "복제", "다운로드", "삭제"].forEach((label) => {
      cy.contains(".doc-entry-menu button", label).should("exist");
    });
    menuItem("복제");
    ls().should("contain", "메모 복사본.txt");
    cy.exec(`cat "${target}/메모 복사본.txt"`).its("stdout").should("eq", "body");

    rowMenu("메모 복사본.txt");
    menuItem("이름 변경");
    nameDialog("사본.txt");
    ls().should("contain", "사본.txt").and("not.contain", "메모 복사본.txt");

    rowMenu("사본.txt");
    menuItem("이동");
    cy.contains(".doc-entry-move-list .tree-row", "보관").click();
    cy.contains(".modal-footer .button", "여기로 이동").click();
    ls("보관").should("eq", "사본.txt");

    rowMenu("메모.txt");
    menuItem("삭제");
    cy.get(".modal .confirm-dialog").should("contain.text", "메모.txt");
    cy.get(".modal-footer .button.danger").click();
    ls().should("not.contain", "메모.txt");
  });

  it("폴더는 비어 있으면 바로 지우고, 안에 무언가 있으면 수를 보여 주며 다시 묻는다", () => {
    cy.exec(`rm -rf ${target}/* && mkdir -p ${target}/빈폴더 ${target}/찬폴더 && printf 'x' > ${target}/찬폴더/.숨김`);
    openRoot();
    rowMenu("찬폴더");
    ["이름 변경", "이동", "하위 폴더 만들기", "삭제"].forEach((label) => {
      cy.contains(".doc-entry-menu button", label).should("exist");
    });
    cy.contains(".doc-entry-menu button", "복제").should("not.exist");
    menuItem("하위 폴더 만들기");
    nameDialog("하위");
    ls("찬폴더").should("contain", "하위");

    rowMenu("빈폴더");
    menuItem("삭제");
    cy.get(".modal .confirm-dialog").should("not.exist");
    ls().should("not.contain", "빈폴더");

    rowMenu("찬폴더");
    menuItem("삭제");
    // 숨김 파일 하나와 하위 폴더 하나 — 화면에 보이지 않는 항목도 센다.
    cy.get(".modal .confirm-dialog").should("contain.text", "파일 1개").and("contain.text", "폴더 1개");
    cy.get(".modal-footer .button").contains("취소").click();
    ls().should("contain", "찬폴더");

    rowMenu("찬폴더");
    menuItem("삭제");
    cy.get(".modal-footer .button.danger").click();
    ls().should("eq", "");
  });
});
