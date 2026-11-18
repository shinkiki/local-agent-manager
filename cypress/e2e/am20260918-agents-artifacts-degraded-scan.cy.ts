/**
 * 리소스 스캔이 경로를 건너뛴 사실을 **에이전트 정의·산출물 화면이 알리는지**.
 *
 * 백엔드는 스캔 저하를 `kind`별로 남긴다 — `skills`·`agents`·`artifacts`
 * (types.ts:3206). `catalogHealth.ts:55-60`은 이 갈래를 둔 이유를 못박아 두었다:
 * "스킬·에이전트 목록이 응답하지 않는 경로를 건너뛴 채 완성돼도 그 화면에는 아무
 * 표시가 남지 않는다. 목록이 0건이면 사용자는 '스킬이 없다'로 읽지만 실제 원인은
 * 접근할 수 없는 경로다."
 *
 * 그런데 `degradedScanMessages`를 부르는 화면은 스킬정보 하나뿐이다
 * (SkillsView.tsx:99). 에이전트 정의(`[data-view=agents]`)와 산출물
 * (`[data-view=artifacts]`)은 자기 `kind`의 저하를 화면에 세우지 않는다. AM-238은
 * 스킬 배너가 **다른 kind를 섞지 않는지**까지만 봤고, 섞이지 않은 그 kind들이
 * **어디에서도 자기 목록 옆에 서지 않는다**는 쪽은 본 적이 없다.
 *
 * 그래서 이 스펙은 세 화면을 같은 표본으로 나란히 본다. 세션 화면의 일반 배너를
 * 대조군으로 둬 `get_catalog_health` 스텁이 실제로 프런트까지 닿았음을 먼저 못박고,
 * 그 다음 에이전트·산출물 화면에 아무 표시가 없음을 확인한다.
 *
 * 축은 UI 공통, 조건은 부분 실패 응답의 오류 안내와 화면 전환이다.
 * **아래 2·3번 단언은 현재 동작을 기록한 것이지 바라는 동작이 아니다.** 결함은 QA
 * 티켓으로 남긴다 — 고쳐지면 이 스펙이 먼저 깨져 알려 준다.
 */
import type { CatalogHealth } from "../../src/types";

const SKILL_MESSAGE = "스킬 루트 /Volumes/원격스킬 응답 없음 — 건너뜀";
const AGENT_MESSAGE = "에이전트 루트 /Volumes/원격에이전트 응답 없음 — 건너뜀";
const ARTIFACT_MESSAGE = "산출물 루트 /Volumes/원격산출물 응답 없음 — 건너뜀";

function scan(kind: "skills" | "agents" | "artifacts", message: string): CatalogHealth["degradedScans"][number] {
  return { kind, label: message, retryAt: null, message };
}

/** 세 종류의 저하를 함께 담은 카탈로그 상태. 개정 번호는 스냅샷 재조회를 부르지 않도록 0으로 둔다. */
function health(): CatalogHealth {
  return {
    sessionRevision: 0,
    resourceRevision: 0,
    lastReconciledAt: Date.now(),
    lastReconcileError: null,
    reconcileInFlight: false,
    lastResourceScanAt: Date.now(),
    degradedScans: [
      scan("skills", SKILL_MESSAGE),
      scan("agents", AGENT_MESSAGE),
      scan("artifacts", ARTIFACT_MESSAGE),
    ],
    stale: false,
    checkedAt: Date.now(),
  };
}

function openWithDegradedScans(view: string): void {
  cy.stubInvoke("get_catalog_health", { statusCode: 200, body: health() });
  cy.visitApp();
  cy.openView(view);
}

describe("건너뛴 스캔을 알리는 화면과 알리지 않는 화면", () => {
  it("대조군 — 세션 화면은 세 종류를 한 줄에 모아 알린다", () => {
    openWithDegradedScans("sessions");

    // 스텁이 프런트까지 닿았음을 먼저 못박는다. 여기가 비면 아래 두 건은 아무것도 증명하지 못한다.
    const banner = () => cy.view("sessions").find(".catalog-health-banner");
    banner().should("exist").and("have.attr", "role", "status");
    banner().find("strong").should("have.text", "일부 갱신이 지연되고 있습니다");
    banner().find("small").should("have.text", `${SKILL_MESSAGE} · ${AGENT_MESSAGE} · ${ARTIFACT_MESSAGE}`);
  });

  it("에이전트 정의 화면은 자기 종류의 저하만 골라 알린다", () => {
    openWithDegradedScans("agents");

    // 한때 이 화면은 `catalogHealth`를 받지도 않아 목록이 불완전하다는 단서가 없었고,
    // 사용자는 "정의가 없다"로 읽었다(QA #96).
    const banner = () => cy.view("agents").find(".catalog-health-banner");
    banner().should("exist").and("have.attr", "role", "status");
    banner().find("strong").should("have.text", "일부 경로를 건너뛴 목록입니다");
    banner().find("small").should("have.text", AGENT_MESSAGE);
    banner().should("not.contain.text", SKILL_MESSAGE);
    banner().should("not.contain.text", ARTIFACT_MESSAGE);
  });

  it("산출물 화면도 자기 종류의 저하만 골라 알린다", () => {
    openWithDegradedScans("artifacts");

    const banner = () => cy.view("artifacts").find(".catalog-health-banner");
    banner().should("exist");
    banner().find("small").should("have.text", ARTIFACT_MESSAGE);
    banner().should("not.contain.text", SKILL_MESSAGE);
    banner().should("not.contain.text", AGENT_MESSAGE);
  });

  it("스킬정보 화면은 자기 종류만 골라 알린다(AM-238이 세운 계약)", () => {
    openWithDegradedScans("skills");

    const banner = () => cy.view("skills").find(".catalog-health-banner");
    banner().find("strong").should("have.text", "일부 경로를 건너뛴 목록입니다");
    banner().find("small").should("have.text", SKILL_MESSAGE);
    banner().should("not.contain.text", AGENT_MESSAGE);
    banner().should("not.contain.text", ARTIFACT_MESSAGE);
  });
});
