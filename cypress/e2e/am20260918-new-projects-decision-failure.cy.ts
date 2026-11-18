/// <reference types="cypress" />
// 새 프로젝트 감지 알림창에서 초기값 결정(`set_project_active`)이 실패했을 때의 거동.
//
// AM-192가 이 알림창의 실패 경로를 한 번 봤지만 "`.error-banner`에 서버 문구가 담기는가"
// 까지였고(그 회차는 트리가 더러워 스펙이 저장소에 남지도 못했다), 안내가 **사용자 눈에
// 닿는가**와 '모두 활성 유지'가 중간에 실패했을 때의 부분 적용은 열어 본 적이 없다.
// 기존 스펙으로도 남아 있는 것은 '나중에' 재등장 규칙(qa53)과 같은 명령을 쓰는 프로젝트 화면
// 설정 탭 카드 쪽의 실패 배너(am20260907-project-registry-card)뿐이다. 두 화면은 오류를 내보내는
// 자리가 서로 다르다. 카드는
// 자기 안에 `ErrorBanner`를 들고 있고(ProjectRegistryCard.tsx:165), 알림창도 QA #98 이후
// 자기 안에 배너를 세운다(`appNewProjects.ts`의 `failure` → `NewProjectsModal`). 알림창은
// `.modal-backdrop`이 화면을 덮는 모달이므로(Shared.tsx:264) 그 배너가 실제로 사용자 눈에
// 닿는지는 좌표로 본다.
//
// 여기서 보는 것은 셋이다.
// (1) 개별 결정이 실패하면 알림창이 닫히지 않고 버튼 잠금만 풀리는가.
// (2) '모두 활성 유지'가 도중에 실패해도 앞서 나간 저장은 취소되지 않고(순차 루프,
//     App.tsx:584) 알림창이 남는가.
// (3) 결정이 도는 동안 같은 줄뿐 아니라 다른 줄과 바닥 버튼까지 함께 잠기는가
//     (NewProjectsModal.tsx의 `busy`는 경로가 아니라 널 여부로만 갈린다).
import type { ProjectRegistryEntry } from "../../src/types";
import { projectEntry } from "../support/projectRegistryFixtures";

const project = (name: string) => projectEntry(name, { path: `/tmp/am-pending/${name}`, pending: true });

const alpha = project("alpha");
const beta = project("beta");
const PENDING: ProjectRegistryEntry[] = [alpha, beta];

const FAILURE = "프로젝트 활성여부를 저장하지 못했습니다.";

const modal = () => cy.get(".modal");
const row = (name: string) => modal().contains(".new-projects-row", name);
const footerButton = (label: string) => cy.get(".modal-footer").contains("button", label);

function openModal(): void {
  cy.stubSnapshotField("pendingProjects", PENDING);
  cy.visitApp();
  modal().should("be.visible").and("contain.text", "새 프로젝트 감지");
  modal().find(".new-projects-row").should("have.length", 2);
}

describe("새 프로젝트 알림창의 결정 실패 경로", () => {
  it("개별 결정이 실패하면 알림창은 그대로 남고 버튼 잠금만 풀린다", () => {
    cy.stubInvoke("set_project_active", { statusCode: 500, body: { error: FAILURE } }).as("decide");
    openModal();

    row("alpha").contains("button", "제외").click();
    cy.wait("@decide");

    // 1) 실패한 결정은 알림창을 닫지 않는다. 닫아 버리면 사용자는 저장된 줄 알고 넘어간다.
    modal().should("be.visible");
    modal().find(".new-projects-row").should("have.length", 2);

    // 2) 잠금은 풀려 다시 시도할 수 있다 — `finally`에서 busy를 비운다(App.tsx:578).
    row("alpha").contains("button", "제외").should("be.enabled");
    row("beta").contains("button", "활성 유지").should("be.enabled");
    footerButton("나중에").should("be.enabled");
    footerButton("모두 활성 유지").should("be.enabled");

    // 3) 오류 문구는 알림창 **안에** 선다. 한때 전역 오류 상태로 올라가 본문 영역에
    //    그려졌는데, 그 자리는 이 창의 백드롭 아래라 보고 있는 사용자에게 닿지 않았다(QA #98).
    modal().should("contain.text", FAILURE);
    modal().find(".error-banner").should("contain.text", FAILURE);
    cy.get(".content-error .error-banner").should("not.exist");

    // 4) 안내가 실제로 읽히는 자리에 있는지는 좌표로 본다 — `be.visible`은 백드롭에 덮인
    //    요소도 통과시키므로 `elementFromPoint`로 가려짐을 가른다.
    modal().find(".error-banner").then(($banner) => {
      const box = $banner[0].getBoundingClientRect();
      const x = Math.round(box.left + box.width / 2);
      const y = Math.round(box.top + box.height / 2);
      const hit = $banner[0].ownerDocument.elementFromPoint(x, y);
      // 배너는 알림창 안에 있으므로 `.modal-backdrop`의 자손인 것이 정상이다. 가려짐은
      // "중심에서 잡힌 것이 배너 자신인가"로 가른다 — 백드롭이 덮고 있으면 백드롭
      // 엘리먼트가 그대로 잡힌다(한때 본문 영역 배너가 그랬다).
      expect(hit === $banner[0] || $banner[0].contains(hit), "배너 중심에서 배너 자신이 잡혀야 읽힌다").to.equal(true);
      expect(hit?.classList.contains("modal-backdrop"), "백드롭이 덮고 있으면 안 된다").to.equal(false);
    });

    // 5) 가려지든 아니든 지켜야 하는 것: 실패한 결정이 알림창의 표시를 '결정됨'으로
    //    바꾸지 않는다. 두 줄 모두 아직 결정 대기로 남아 다시 고를 수 있다.
    row("alpha").contains("button", "활성 유지").should("be.enabled");
    cy.screenshot("am-new-projects-decide-failure");
  });

  it("'모두 활성 유지'가 두 번째에서 실패해도 첫 저장은 나간 채 알림창이 남는다", () => {
    // 순차 루프라 첫 줄은 이미 저장되고 둘째 줄에서 멈춘다. 되돌리는 장치가 없으므로
    // 알림창이 남아 사용자가 남은 줄을 다시 정할 수 있어야 한다.
    let calls = 0;
    cy.intercept("POST", "**/api/invoke/set_project_active", (req) => {
      calls += 1;
      if (calls === 1) req.reply({ statusCode: 200, body: null });
      else req.reply({ statusCode: 500, body: { error: FAILURE } });
    }).as("decideAll");
    openModal();

    footerButton("모두 활성 유지").click();
    cy.wait("@decideAll");
    cy.wait("@decideAll");
    cy.then(() => { expect(calls, "순차 저장 호출 수").to.equal(2); });

    modal().should("be.visible");
    modal().find(".new-projects-row").should("have.length", 2);
    footerButton("모두 활성 유지").should("be.enabled");
    // 실패 사유와 함께 **어디까지 적용됐는지**도 알림창 안에 적는다. 되돌리는 장치가 없으므로
    // 사용자가 남은 줄만 다시 정하려면 그 수를 알아야 한다(QA #98).
    modal().find(".error-banner").should("contain.text", FAILURE);
    modal().should("contain.text", "1/2건은 이미 적용됐습니다");
  });

  it("결정이 도는 동안 다른 줄과 바닥 버튼까지 함께 잠긴다", () => {
    cy.stubInvoke("set_project_active", (req) => {
      req.reply({ statusCode: 200, body: null, delay: 700 });
    }).as("slowDecide");
    openModal();

    row("alpha").contains("button", "제외").click();

    // busy는 경로가 아니라 널 여부로 갈리므로, 도는 동안에는 다른 줄도 바닥도 잠긴다.
    row("beta").contains("button", "제외").should("be.disabled");
    row("beta").contains("button", "활성 유지").should("be.disabled");
    footerButton("나중에").should("be.disabled");
    footerButton("모두 활성 유지").should("be.disabled");

    cy.wait("@slowDecide");
    footerButton("나중에").should("be.enabled");
  });
});
