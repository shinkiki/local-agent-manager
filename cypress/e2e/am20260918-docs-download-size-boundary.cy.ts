/**
 * 문서 작업대 파일 창 — 내려받기 한도(100MB)가 버튼과 안내 문구를 함께 가르는지 본다.
 *
 * - 한도 판정: crates/agent-manager-core/src/document_tree.rs:27,115
 *   (`downloadable = size <= 100MiB`. 미리보기 한도 5MB와는 별개의 값이다)
 * - 셸별 보정: src/components/DocumentFilePane.tsx:199-206 (`downloadableHere`)
 *   데스크톱 셸은 Rust가 곧장 이어 복사하므로 한도가 없고, 브라우저(이 하네스)는 파일 전체가
 *   응답 본문에 실리므로 한도가 그대로 산다.
 * - 버튼 붙는 자리: DocumentFilePane.tsx:121, 안내 문구: DocumentFilePane.tsx:222-224
 *
 * 이 스펙이 새로 보는 것은 **100MB 경계**다. AM-213이 미리보기 5MB 한도의 두 갈래(크기 초과·
 * 바이너리) 안내 문구를 봤지만 그때 두 파일 모두 100MB 이하라 안내는 "다운로드해 확인할 수
 * 있습니다" 한 줄뿐이었고, 버튼이 사라지는 갈래와 "다운로드할 수 없습니다" 문구는 어떤 스펙도
 * 본 적이 없다(`downloadable`을 거론하는 스펙이 하나도 없다). 두 한도가 같은 제목을 쓰면서
 * 다른 결말을 내므로, 제목이 같은 두 파일을 나란히 두고 갈라지는 자리만 본다.
 */
import { cleanupDocRoot, ensureDocRoot } from "../support/docRootFixtures";

describe("문서 파일 창의 내려받기 크기 경계", () => {
  const target = `/tmp/am-e2e-dlsize-${Date.now()}`;

  before(() => {
    cy.exec(`mkdir -p ${target}`);
    // 희소 파일이라 자리를 차지하지 않는다. 101MiB는 한도(100MiB) 바로 바깥,
    // 6MiB는 미리보기 한도(5MB) 바깥이면서 내려받기 한도 안쪽이다.
    cy.exec(`dd if=/dev/zero of=${target}/over-limit.bin bs=1m count=0 seek=101`);
    cy.exec(`dd if=/dev/zero of=${target}/under-limit.bin bs=1m count=0 seek=6`);
    cy.exec(`printf '{"probe":1}\\n' > ${target}/tiny-config.json`);
  });

  after(() => {
    cleanupDocRoot(target);
  });

  // runMode 재시도가 있으므로 등록 상태를 전제하지 않는다(docRootFixtures 주석 참고).
  const openRoot = () => {
    cy.visitApp();
    ensureDocRoot(target);
    cy.reload();
    cy.openView("docs");
    cy.contains(".root-row code", target).click();
    cy.get(".document-tree-pane").should("exist");
  };

  const selectFile = (name: string) => {
    cy.contains(".tree-row.file", name).click();
    cy.get(".doc-header-title strong").should("have.text", name);
  };

  it("한도를 넘은 파일은 다운로드 버튼이 사라지고 우회 안내도 막힌 문구로 바뀐다", () => {
    openRoot();
    selectFile("over-limit.bin");

    // 미리보기 한도도 함께 넘으므로 제목은 크기 초과 쪽이다.
    cy.get(".document-file-unavailable p")
      .should("have.text", "미리보기 크기 제한을 초과했습니다.");
    // 갈라지는 자리는 여기다 — 내려받기로 우회할 수 없다고 말해야 한다.
    cy.get(".document-file-unavailable small")
      .should("have.text", "이 파일은 다운로드할 수 없습니다.");
    cy.get('.document-file-header [aria-label="파일 다운로드"]').should("not.exist");
  });

  it("한도 안쪽의 크기 초과 파일은 같은 제목이지만 버튼과 우회 안내가 남는다", () => {
    openRoot();
    selectFile("under-limit.bin");

    cy.get(".document-file-unavailable p")
      .should("have.text", "미리보기 크기 제한을 초과했습니다.");
    cy.get(".document-file-unavailable small")
      .should("have.text", "파일을 다운로드해 확인할 수 있습니다.");
    cy.get('.document-file-header [aria-label="파일 다운로드"]')
      .should("exist")
      .and("not.be.disabled");
  });

  it("한도를 넘은 파일을 거쳤다 작은 파일로 오면 버튼이 되살아난다", () => {
    openRoot();
    selectFile("over-limit.bin");
    cy.get('.document-file-header [aria-label="파일 다운로드"]').should("not.exist");

    // 버튼이 붙고 떨어지는 판정이 파일마다 새로 서는지 본다 — 앞 파일의 결론이 남으면
    // 내려받을 수 있는 파일에서 버튼이 없는 채로 굳는다.
    selectFile("tiny-config.json");
    cy.get('.document-file-header [aria-label="파일 다운로드"]').should("exist");
    cy.get(".document-file-unavailable").should("not.exist");
    cy.get(".document-file-code").should("contain.text", "probe");
  });
});
