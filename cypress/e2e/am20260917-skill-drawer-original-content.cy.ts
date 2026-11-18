/// <reference types="cypress" />
/**
 * 스킬 → 스킬정보 → 설치본 드로워의 **번역본 폴백과 "원문 보기" 접기**.
 *
 * 2026-09-17 리팩토링(`c260bad4`)이 스킬·에이전트·아티팩트 세 드로워와 지침 화면 두 자리가
 * 각자 적던 "원문 보기" 접기를 `OriginalContent`(SkillLibraryPanel.tsx:2745) 한 벌로 모았다.
 * 산출물 드로워의 같은 자리는 AM-259가 이미 봤지만 스킬 드로워는 어느 스펙도 번역본을
 * 넣어 본 적이 없다 — 스킬 스펙들은 목록·필터(AM-9·AM-10·AM-40), 사용 설정
 * (am20260914-claude-skill-usage-override), 상세 조회 실패(AM-351)만 다뤘다.
 *
 * 스킬 드로워는 폴백 단계가 산출물과 다르다.
 * - 설명 = 상세 번역본`.description` ?? 목록 레코드`.description` ?? 원문 (SkillsView.tsx:323)
 * - SKILL.md = 상세 번역본`.body` ?? 원문 (`:339`)
 * - "원문 보기"는 **상세 번역본에 `body`가 있을 때만** 붙는다 (`:341`)
 * 3단 폴백은 산출물의 요약(3단)과 달리 목록 레코드에 description만 있고, 부분 번역이면
 * 번역된 설명 아래 한국어 본문이 그대로 서는 상태가 실제로 만들어진다.
 *
 * 영어 UI에서 접기 라벨이 영어로 서는지도 함께 본다. `OriginalContent`는 `text()`로 짝을
 * 들고 있고 정적 대응표에도 같은 짝이 있어(i18nStaticDictionary.ts:35) 두 경로 중 어느
 * 쪽으로 가도 "View original"이어야 한다.
 *
 * 축은 스킬, 조건은 저장 부분 상태의 폴백 경계와 다국어 전환이다.
 */
import type { SkillSummary } from "../../src/types";

const SKILL_ROOT = "/tmp/am20260917-skill-original";

const SKILL: SkillSummary = {
  id: "codex:personal:translated",
  source: "codex",
  scope: "personal",
  name: "번역대상스킬",
  description: "원문 설명입니다",
  path: `${SKILL_ROOT}/translated/SKILL.md`,
  directory: `${SKILL_ROOT}/translated`,
  origin: null,
  archived: false,
};

const ORIGINAL_BODY = "# 번역대상스킬\n\n원문 본문 문단입니다.";
const ORIGINAL_MARK = "원문 본문 문단입니다";
const TRANSLATED_MARK = "Translated body paragraph";

const drawer = () => cy.get(".drawer");
const original = () => drawer().find("details.original-content");
// 메타 칸의 파일 경로에도 "SKILL.md"가 들어 있어 `.detail-card` 통째로 찾으면 그쪽이 먼저
// 잡힌다. 본문 카드는 섹션 제목으로만 고른다.
const bodyCard = () => drawer().contains(".section-title h3", "SKILL.md").closest(".detail-card");

/** 목록 번역 레코드. `skills` 메뉴만 가로채고 다른 메뉴는 실제 응답을 흘린다. */
function stubMenuTranslations(record: Record<string, string> | null): void {
  cy.stubInvoke("get_menu_translations", (req) => {
    if ((req.body as { menu?: string }).menu !== "skills") {
      req.continue();
      return;
    }
    req.reply({
      statusCode: 200,
      body: {
        menu: "skills",
        language: "en",
        enabled: true,
        status: null,
        records: record ? [{ resourceId: SKILL.id, fields: record, updatedAt: 1 }] : [],
      },
    });
  });
}

function stubDetail(translatedFields: Record<string, string>): void {
  cy.stubInvoke("get_skill_detail", {
    statusCode: 200,
    body: { skill: SKILL, body: ORIGINAL_BODY, files: [] },
  });
  cy.stubInvoke("get_translated_detail", {
    statusCode: 200,
    body: { menu: "skills", resourceId: SKILL.id, fields: translatedFields, updatedAt: 2 },
  }).as("translatedDetail");
}

function openDrawer(): void {
  cy.stubSnapshotField("skills", [SKILL]);
  cy.visitApp();
  cy.openView("skills");
  cy.get(".skill-library-list > .skill-library-item").should("have.length", 1).click();
  drawer().should("exist");
}

describe("설치 스킬 드로워의 번역본 폴백과 원문 보기 접기", () => {
  after(() => {
    cy.restoreLanguage();
  });

  it("상세 번역본에 본문이 있으면 본문 카드는 번역본이고 원문은 접힌 카드로만 남는다", () => {
    stubMenuTranslations({ name: "Translated skill", description: "목록 레코드 설명" });
    stubDetail({ description: "Translated description", body: TRANSLATED_MARK });
    openDrawer();

    // 1) 설명은 상세 번역본이 이긴다 — 목록 레코드도 원문도 화면에 없다.
    drawer().should("contain.text", "Translated description");
    drawer().should("not.contain.text", "목록 레코드 설명");
    drawer().should("not.contain.text", "원문 설명입니다");

    // 2) SKILL.md 카드는 번역본을 그리고, 원문 문단은 그 카드 안에 없다.
    bodyCard().should("contain.text", TRANSLATED_MARK);
    bodyCard().should("not.contain.text", ORIGINAL_MARK);

    // 3) 원문은 접힌 채로만 남는다 — `open` 없이 붙고, 드로워 안에서는 카드 한 장으로 선다.
    original().should("have.length", 1);
    original().should("not.have.attr", "open");
    original().should("have.class", "detail-card");
    original().find("summary").should("have.text", "원문 보기");
    original().should("contain.text", ORIGINAL_MARK);
  });

  it("설명만 번역된 부분 번역이면 본문은 원문이 서고 원문 보기 접기는 붙지 않는다", () => {
    stubMenuTranslations({ name: "Translated skill", description: "목록 레코드 설명" });
    stubDetail({ description: "Translated description" });
    openDrawer();

    // 4) 같은 원문을 본문 카드와 접기에 두 번 두지 않는다.
    bodyCard().should("contain.text", ORIGINAL_MARK);
    original().should("not.exist");

    // 5) 설명 폴백은 필드 단위라 본문이 비어도 번역된 설명은 그대로 선다.
    drawer().should("contain.text", "Translated description");
  });

  it("상세 번역본 필드가 비면 설명이 목록 레코드로 한 칸만 떨어진다", () => {
    stubMenuTranslations({ name: "Translated skill", description: "목록 레코드 설명" });
    stubDetail({});
    openDrawer();

    // 6) 원문으로 곧장 떨어지지 않고 목록 레코드를 거친다.
    drawer().should("contain.text", "목록 레코드 설명");
    drawer().should("not.contain.text", "원문 설명입니다");
    original().should("not.exist");
  });

  it("영어 UI에서 원문 보기 접기 라벨이 영어로 서고 펼치면 원문이 보인다", () => {
    stubMenuTranslations({ name: "Translated skill", description: "목록 레코드 설명" });
    stubDetail({ description: "Translated description", body: TRANSLATED_MARK });
    cy.stubSnapshotField("skills", [SKILL]);
    cy.visitApp();
    cy.setLanguage("en");
    cy.openView("skills");
    cy.get(".skill-library-list > .skill-library-item").should("have.length", 1).click();
    drawer().should("exist");

    // 7) 접기 라벨에 한국어가 남지 않는다.
    original().find("summary").should("have.text", "View original");

    // 8) 펼치면 원문이 실제로 보인다 — 접기가 값을 잃어버리지 않는다.
    original().find("summary").click();
    original().should("have.attr", "open");
    original().contains(ORIGINAL_MARK).should("be.visible");
    cy.screenshot("am20260917-skill-original-content-english", { overwrite: true });
  });
});
