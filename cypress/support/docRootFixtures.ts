/// <reference types="cypress" />

// 문서 화면 스펙 일곱이 저마다 "임시 폴더를 등록 폴더로 세우고, 끝나면 그 등록본을 지운다"를
// 통째로 적어 두고 있었다. 지우는 쪽은 `get_doc_roots`를 훑어 경로가 맞는 항목마다
// `delete_doc_root`를 부르는 다섯 줄이고, 세우는 쪽은 `create_doc_root` 요청 본문 한 줄이다.
// 격리 백엔드는 한 스위트를 통째로 함께 쓰므로(메모리: e2e-suite-state-leakage) 이 되돌리기는
// 빠질 수 없는 절차인데, 경로를 견주는 방식이 스펙마다 갈려 있었다 — 등호로 본 것 둘과
// `/tmp`를 떼어 낸 꼬리로 본 것 넷이다. 백엔드가 `/tmp`를 `/private/tmp`로 풀어 돌려주기
// 때문에 등호만으로는 놓치는 자리가 있어서 생긴 갈림이라, 여기서는 둘을 함께 본다.
// 명령(`Cypress.Commands`)이 아니라 함수로 두는 이유는 이 절차가 문서 화면 스펙에서만
// 쓰이기 때문이다 — 모든 스펙이 읽는 지원 파일에 얹을 만큼 넓은 규칙이 아니다.

/** 등록본 하나를 지울지 판단한다. 등호와 `/tmp` 꼬리를 함께 본다. */
function matchesTarget(rootPath: string, target: string): boolean {
  return rootPath === target || rootPath.endsWith(target.slice("/tmp".length));
}

/**
 * 등록 폴더를 지운다. `target`을 주면 그 경로에 해당하는 등록본만, 주지 않으면 남아 있는
 * 등록본 전부를 지운다(재시도가 돌아도 "폴더 0건"에서 시작하도록 비우는 자리).
 */
export function purgeDocRoots(target?: string): void {
  cy.request("POST", "/api/invoke/get_doc_roots", {}).then((res) => {
    for (const root of res.body as Array<{ id: string; path: string }>) {
      if (target === undefined || matchesTarget(root.path, target)) {
        cy.request("POST", "/api/invoke/delete_doc_root", { id: root.id });
      }
    }
  });
}

/**
 * 등록본과 임시 디렉터리를 함께 되돌린다. 스펙의 `after`가 하던 두 걸음 그대로다.
 */
export function cleanupDocRoot(target: string): void {
  purgeDocRoots(target);
  cy.exec(`rm -rf ${target}`, { failOnNonZeroExit: false });
}

/**
 * 이미 등록돼 있으면 그대로 두고, 없으면 API로 등록한다. runMode 재시도가 돌아도 같은 폴더를
 * 다시 고를 수 있게 하는 자리라 실패 상태코드를 막지 않는다. `name`은 스펙마다 빈 문자열과
 * null로 갈려 있었고 화면이 이름을 경로에서 뽑는 것은 같으므로 기본값만 받는다.
 */
export function ensureDocRoot(target: string, name: string | null = ""): void {
  cy.request({
    method: "POST",
    url: "/api/invoke/create_doc_root",
    body: { request: { name, path: target, createIfMissing: false } },
    failOnStatusCode: false,
  });
}
