import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { GENERATED_UI_EN } from "./i18nGeneratedUiCatalog.ts";
import {
  registerUiEnglish,
  staticUiDictionarySources,
  staticUiEnglish,
  staticUiKoreanByEnglish,
} from "./i18nStaticDictionary.ts";

/**
 * 손으로 적는 `STATIC_UI_SOURCES`는 표 바깥에 남은 원문만 담는다. 목록 자체는 내보내지
 * 않으므로(표의 모양을 읽는 쪽에 흘리지 않는다) 선언을 원문에서 읽어 확인한다.
 */
function staticUiSourceList() {
  const file = fs.readFileSync(path.join(import.meta.dirname, "i18nStaticDictionary.ts"), "utf8");
  const block = file.split("const STATIC_UI_SOURCES = [")[1]?.split("] as const;")[0];
  assert.ok(block, "STATIC_UI_SOURCES 선언을 찾지 못했습니다.");
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => JSON.parse(`"${match[1]}"`));
}

/**
 * 생성 카탈로그에 이미 짝이 있는 문구를 손 목록에 또 적으면 카탈로그는 그대로인데 표를
 * 고칠 때마다 이쪽도 함께 고쳐야 하는 것처럼 보인다. 실제로 52줄 중 42줄이 그렇게 쌓여
 * 있었다 — 컴포넌트가 그 문구를 `text(ko, en)`으로 감싸면서 생성 카탈로그에 실렸는데
 * 목록에서는 지워지지 않았다.
 */
test("손으로 적는 정적 원문은 생성 카탈로그와 겹치지 않는다", () => {
  const generated = new Set(Object.keys(GENERATED_UI_EN));
  const sources = staticUiSourceList();
  assert.deepEqual(sources.filter((source) => generated.has(source)), []);
  const duplicated = sources.filter((source, index) => sources.indexOf(source) !== index);
  assert.deepEqual(duplicated, []);
  assert.ok(sources.includes("워크스루"));
});

/** 카탈로그에 실리는 원문 집합. 중복을 걷어내도 생성 카탈로그의 원문은 한 줄도 빠지지 않는다. */
test("카탈로그 원문은 생성 카탈로그와 손 목록을 모두 포함한다", () => {
  const catalog = new Set(staticUiDictionarySources());
  for (const ko of Object.keys(GENERATED_UI_EN)) assert.ok(catalog.has(ko), ko);
  for (const source of staticUiSourceList()) assert.ok(catalog.has(source), source);
});

/**
 * 되짚기 표의 우선순위. 같은 영어가 손 대응표와 생성 카탈로그 양쪽에 있으면 손 대응표가
 * 이긴다 — 정방향 조회(`staticUiEnglish`)가 쓰는 순서와 같은 방향이어야, 번역했다 되짚은
 * 값이 원래 원문으로 돌아온다.
 */
test("되짚기 표는 손 대응표를 생성 카탈로그보다 앞에 둔다", () => {
  assert.equal(staticUiEnglish("아티팩트"), "Artifacts");
  assert.equal(GENERATED_UI_EN["산출물"], "Artifacts");
  assert.equal(staticUiKoreanByEnglish.get("Artifacts"), "아티팩트");
});

/** 영어 되짚기 경로는 그대로다 — 손 목록을 줄여도 대응표와 등록 짝은 건드리지 않았다. */
test("등록한 짝과 대응표가 영어를 되짚는다", () => {
  assert.equal(staticUiEnglish("대시보드"), "Dashboard");
  registerUiEnglish("회차 시험 문구", "Round test label");
  assert.equal(staticUiEnglish("회차 시험 문구"), "Round test label");
});

/**
 * 한 표 안의 같은 영어는 뒤 항목이 이긴다. 채팅 탭("대화")과 세션 상세 탭("대화 내역")이
 * 모두 "Conversation"이라, 이 규칙이 뒤집히면 한국어로 되돌린 채팅 탭이 "대화 내역"이 된다.
 */
test("되짚기 표는 한 표 안의 같은 영어에서 뒤 항목을 고른다", () => {
  assert.equal(staticUiEnglish("대화"), "Conversation");
  assert.equal(staticUiEnglish("대화 내역"), "Conversation");
  assert.equal(staticUiKoreanByEnglish.get("Conversation"), "대화");
});
