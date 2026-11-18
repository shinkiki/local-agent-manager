/// <reference types="cypress" />
/**
 * 저장소 화면(StorageView.tsx)의 **빈 상태와 수치 경계값 표기**.
 *
 * 기존 저장소 스펙 셋은 폴링 갱신 실패의 값 잔존(am20260907-storage-poll-refresh-failure),
 * 가시성 복귀 갱신(am20260907-storage-visibility-refresh), 다국어 문구(am32-storage-view)를
 * 본다. 셋 다 격리 백엔드의 실제 측정값을 그대로 쓰므로, "아무것도 쌓이지 않은 새 설치"와
 * "단위 경계에 걸린 수치"가 화면에 어떻게 적히는지는 아무 스펙도 보지 않았다.
 *
 * 두 갈래 모두 사용자가 정리 여부를 판단하는 근거다 — 0바이트를 "–"로 적으면 측정 실패로
 * 읽히고, 1023 B를 "1.0 KB"로 올려 적으면 단위 경계에서 수치가 튄다. formatBytes(format.ts:64)는
 * 1024 미만이면 소수점을 버리고, 100 이상이면 단위를 올리지 않은 채 정수로 적으며, TB에서
 * 단위 상승을 멈춘다. 그 계약이 지표 카드·목록 행·패널 꼬리말 네 자리에 같은 모양으로
 * 붙는지를 응답만 갈아 끼워 본다(격리 백엔드의 실제 파일은 건드리지 않는다).
 */
import type { StorageOverview, StorageUsageItem } from "../../src/types";

const STORAGE_VIEW = ".storage-view";

const item = (overrides: Partial<StorageUsageItem> = {}): StorageUsageItem => ({
  id: "source-codex",
  label: "Codex 세션",
  description: "~/.codex/sessions",
  rootPath: "/root/.codex",
  sizeBytes: 0,
  fileCount: 0,
  ...overrides,
});

const overview = (overrides: Partial<StorageOverview> = {}): StorageOverview => ({
  sourceTotalBytes: 0,
  managerTotalBytes: 0,
  totalBytes: 0,
  sourceItems: [],
  managerItems: [],
  supplements: { turnCount: 0, sessionCount: 0, sizeBytes: 0 },
  ...overrides,
});

/** 응답을 갈아 끼운 뒤 저장소 화면을 연다. 화면은 열릴 때 한 번 재므로 열기 전에 건다. */
function openStorageWith(body: StorageOverview) {
  cy.stubInvoke("get_storage_overview", { statusCode: 200, body }).as("overview");
  cy.openView("storage");
  cy.wait("@overview");
  return cy.get(STORAGE_VIEW, { timeout: 20000 }).should("be.visible");
}

/** 지표 카드 네 장의 값 자리와 설명 자리를 한 번에 읽는다. */
function statTexts(selector: string) {
  return cy.get(`${STORAGE_VIEW} .stat-card`).then(($cards) => (
    [...$cards].map((card) => card.querySelector(selector)?.textContent ?? "")
  ));
}

describe("저장소 화면의 빈 상태와 용량 단위 경계 표기", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  it("아무것도 쌓이지 않은 저장소는 네 지표를 0으로 적고 목록은 행 없이 패널만 남는다", () => {
    openStorageWith(overview());

    // 오류가 아니므로 배너도 낡음 표시도 없다. 0은 측정 실패("–")가 아니라 측정된 값이다.
    cy.get(`${STORAGE_VIEW} .error-banner`).should("not.exist");
    cy.get(".storage-refresh-status")
      .should("not.have.class", "is-stale")
      .invoke("text")
      .should("match", /^마지막 측정 시각 .+ · 30초마다 다시 잽니다$/);
    cy.get(`${STORAGE_VIEW} .stat-grid`).should("not.have.class", "is-stale");

    statTexts("strong").should("deep.equal", ["0 B", "0 B", "0 B", "0건"]);
    // 보완 카드의 설명 자리는 세션 수와 크기를 함께 적는다. 둘 다 0이어도 문장 모양은 같다.
    statTexts("small").should("deep.equal", [
      "대화 원본 + Agent Manager 상태",
      "원본 파일은 읽기 전용",
      "보완 응답과 반복 요청 포함",
      "0개 세션 · 0 B",
    ]);

    // 항목이 없어도 패널 두 장은 제목·설명과 함께 남고, 목록만 비어 있다.
    cy.get(`${STORAGE_VIEW} .storage-panel`).should("have.length", 2);
    cy.get(`${STORAGE_VIEW} .storage-row`).should("not.exist");
    cy.get(`${STORAGE_VIEW} .storage-panel`).first().find("h2").should("have.text", "공급자 대화 원본");
    cy.get(`${STORAGE_VIEW} .storage-panel`).last().find("h2").should("have.text", "Agent Manager 보완 저장소");
    // 보완 저장소 꼬리말은 0건이어도 보관 한도를 그대로 알린다.
    cy.get(`${STORAGE_VIEW} .storage-panel`).last().find("footer")
      .should("have.text", "보완 응답 0건 · 최대 세션당 200건, 전체 4,000건 보관");
  });

  it("단위 경계에 걸린 수치는 올려 적지 않고 TB에서 단위 상승을 멈추며 건수에는 천단위 구분이 붙는다", () => {
    openStorageWith(overview({
      // 1023 B는 KB로 올리지 않고, 1024 B는 소수 한 자리 KB가 된다.
      sourceTotalBytes: 1023,
      managerTotalBytes: 1024,
      // 1024^5. TB가 마지막 단위라 PB로 넘어가지 않고 정수 TB로 적힌다.
      totalBytes: 1125899906842624,
      supplements: { turnCount: 1234567, sessionCount: 89012, sizeBytes: 104857600 },
      // 1048575 B는 1024 KB에 0.001 KB 모자란 값이다. 100 이상이면 소수를 버리므로
      // "1024 KB"로 적히고 MB로 올라가지 않는다 — 단위가 튀지 않는다는 뜻이다.
      sourceItems: [item({ sizeBytes: 1048575, fileCount: 1234 })],
      managerItems: [item({ id: "manager-supplements", label: "보완 저장소", description: "supplements.json", sizeBytes: 0, fileCount: 0 })],
    }));

    statTexts("strong").should("deep.equal", ["1024 TB", "1023 B", "1.0 KB", "1,234,567건"]);
    statTexts("small").should("have.length", 4).then((texts) => {
      expect(texts[3]).to.equal("89,012개 세션 · 100 MB");
    });

    cy.get(`${STORAGE_VIEW} .storage-row`).should("have.length", 2);
    cy.get(`${STORAGE_VIEW} .storage-row`).first().find("strong").then(($cells) => {
      expect([...$cells].map((cell) => cell.textContent)).to.deep.equal(["Codex 세션", "1024 KB"]);
    });
    cy.get(`${STORAGE_VIEW} .storage-row`).first().find("span").last().should("have.text", "1,234개 파일");
    // 0바이트·0파일 행도 빈칸이 아니라 값으로 적힌다.
    cy.get(`${STORAGE_VIEW} .storage-row`).last().find("strong").last().should("have.text", "0 B");
    cy.get(`${STORAGE_VIEW} .storage-row`).last().find("span").last().should("have.text", "0개 파일");
    // 꼬리말의 보완 건수도 같은 천단위 구분을 쓴다.
    cy.get(`${STORAGE_VIEW} .storage-panel`).last().find("footer")
      .should("contain.text", "보완 응답 1,234,567건");
  });

  // L09(헤드리스 리눅스 제한 백로그). NAS 배포에서는 이 화면을 원격 브라우저로 보므로, 행에
  // 수치만 적히면 자기 컴퓨터의 세션 용량으로 읽힌다. 실제로 잰 자리는 백엔드가 도는 컨테이너
  // 안이다. 백엔드가 공통 조상을 뽑지 못해 경로를 비워 보낸 행에는 빈 칸을 만들지 않는다.
  it("행마다 백엔드가 잰 경로를 적고 경로가 없는 행에는 빈 자리를 만들지 않는다", () => {
    openStorageWith(overview({
      sourceItems: [item({ rootPath: "/root/.codex" })],
      managerItems: [item({ id: "manager", label: "Agent Manager 상태", rootPath: "" })],
    }));

    cy.get(`${STORAGE_VIEW} .storage-row`).first().find("code.storage-row-path")
      .should("have.text", "/root/.codex")
      .and("have.attr", "title", "/root/.codex");
    cy.get(`${STORAGE_VIEW} .storage-row`).last().find("code.storage-row-path").should("not.exist");
  });
});
