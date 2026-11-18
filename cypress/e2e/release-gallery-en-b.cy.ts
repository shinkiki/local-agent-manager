/// <reference types="cypress" />
// 영어 README용 갤러리(am-031-en-*). 테스트 본문은 한국어 갤러리 스펙과 같고, 데모 데이터와 UI 언어만 영어다.
// 실행: node scripts/e2e.mjs --spec "cypress/e2e/release-gallery-en-b.cy.ts" --summary /tmp/am-gallery-en.json
import "../support/galleryLangEn";
import "./release-gallery-v030-b.cy";
