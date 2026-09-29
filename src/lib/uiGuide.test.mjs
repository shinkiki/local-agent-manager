import assert from "node:assert/strict";
import { test } from "node:test";
import targets from "./uiGuideTargets.json" with { type: "json" };
import {
  UI_GUIDE_TARGETS,
  normalizeUiGuideTargets,
  resolveUiGuideTarget,
  uiGuideAnchorSelector,
  uiGuideTargetProblems,
} from "./uiGuide.ts";

test("the shared target catalog is valid and every entry is resolvable", () => {
  assert.deepEqual(uiGuideTargetProblems(targets), []);
  assert.equal(UI_GUIDE_TARGETS.length, targets.length);
  for (const target of targets) {
    const resolved = resolveUiGuideTarget(target.id);
    assert.ok(resolved, `${target.id}를 찾아야 한다`);
    assert.equal(resolved.anchor, target.anchor);
  }
  assert.equal(resolveUiGuideTarget("settings.nowhere"), null);
});

test("projects view tabs resolve to the projects view with their tab", () => {
  // 프로젝트 화면의 세 탭은 `UI_GUIDE_VIEW_TABS.projects`에 있어야 안내 요청이 그 탭을 연다.
  // 한쪽(JSON)만 고치면 `uiGuideTargetProblems`가 잡지만, 탭 목록을 빼먹은 채 JSON만 남으면
  // 카탈로그가 통째로 비므로 여기서 해석 결과까지 본다.
  const git = resolveUiGuideTarget("projects.tab.git");
  assert.ok(git);
  assert.equal(git.view, "projects");
  assert.equal(git.tab, "git");
  assert.equal(git.anchor, "projects.tab.git");
  const selector = resolveUiGuideTarget("projects.selector");
  assert.ok(selector);
  assert.equal(selector.view, "projects");
  assert.equal(selector.tab, "files");
});

test("targets with an unknown view, tab, or duplicate id are rejected", () => {
  const raw = [
    { id: "a", view: "settings", tab: "connections", anchor: "a", description: "ok" },
    { id: "a", view: "nowhere", anchor: "b", description: "dup + bad view" },
    { id: "c", view: "chat", tab: "history", anchor: "c", description: "bad tab" },
    { id: "d", view: null, tab: "x", anchor: "", description: "" },
  ];
  const problems = uiGuideTargetProblems(raw);
  assert.ok(problems.some((problem) => problem.includes("중복")));
  assert.ok(problems.some((problem) => problem.includes("알 수 없는 화면")));
  assert.ok(problems.some((problem) => problem.includes("history 탭이 없습니다")));
  assert.ok(problems.some((problem) => problem.includes("anchor가 없습니다")));
  assert.deepEqual(normalizeUiGuideTargets(raw), [], "문제가 하나라도 있으면 목록을 통째로 비운다");
  assert.equal(normalizeUiGuideTargets([raw[0]])[0].tab, "connections");
  assert.equal(normalizeUiGuideTargets([{ ...raw[0], tab: undefined }])[0].tab, null);
});

test("duplicate ids are judged only among entries that declare one", () => {
  const nameless = [
    { view: null, anchor: "a", description: "id가 없다" },
    { view: null, anchor: "b", description: "id가 없다" },
    { id: "undefined", view: null, anchor: "c", description: "이름이 하필 undefined" },
  ];
  const problems = uiGuideTargetProblems(nameless);
  assert.equal(problems.filter((problem) => problem.includes("중복")).length, 0);
  // 이름을 못 얻은 항목도 순번으로는 서로 구분된다.
  assert.ok(problems.includes("#0: id가 없습니다"));
  assert.ok(problems.includes("#1: id가 없습니다"));
});

test("anchor selectors escape quotes", () => {
  assert.equal(uiGuideAnchorSelector("nav.settings"), '[data-ui-anchor="nav.settings"]');
  assert.equal(uiGuideAnchorSelector('a"b'), '[data-ui-anchor="a\\"b"]');
});
