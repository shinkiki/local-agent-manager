import assert from "node:assert/strict";
import { test } from "node:test";
import targets from "./uiGuideTargets.json" with { type: "json" };
import {
  UI_GUIDE_TARGETS,
  normalizeUiGuideTargets,
  resolveUiGuideTarget,
  uiGuideAnchorSelector,
  uiGuidePointerPlacement,
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

test("anchor selectors escape quotes", () => {
  assert.equal(uiGuideAnchorSelector("nav.settings"), '[data-ui-anchor="nav.settings"]');
  assert.equal(uiGuideAnchorSelector('a"b'), '[data-ui-anchor="a\\"b"]');
});

const viewport = { width: 1200, height: 800 };

test("the pointer sits above the anchor and points down when there is room", () => {
  const placement = uiGuidePointerPlacement({ top: 400, left: 500, width: 100, height: 40 }, viewport);
  assert.equal(placement.arrow.direction, "down");
  assert.deepEqual(placement.ring, { top: 394, left: 494, width: 112, height: 52 });
  assert.equal(placement.arrow.top, 394 - 6 - 34);
  assert.equal(placement.arrow.left, 550 - 17);
  assert.equal(placement.note.top, null);
  assert.equal(placement.note.bottom, 800 - placement.arrow.top + 6);
  assert.equal(placement.note.left, 550 - 160);
  assert.equal(placement.note.width, 320);
});

test("near the top the pointer flips below the anchor and points up", () => {
  const placement = uiGuidePointerPlacement({ top: 20, left: 500, width: 100, height: 40 }, viewport);
  assert.equal(placement.arrow.direction, "up");
  assert.equal(placement.arrow.top, 20 + 40 + 6 + 6);
  assert.equal(placement.note.bottom, null);
  assert.equal(placement.note.top, placement.arrow.top + 34 + 6);
});

test("an anchor that runs past the fold is ringed only where it is visible", () => {
  const placement = uiGuidePointerPlacement({ top: 300, left: 400, width: 500, height: 900 }, viewport);
  assert.equal(placement.ring.top, 294);
  assert.equal(placement.ring.top + placement.ring.height, 800 - 12, "링 아래쪽은 화면 안에서 끝난다");
  assert.equal(placement.arrow.direction, "down", "위에 자리가 있으면 그대로 위에서 가리킨다");
  assert.equal(placement.arrow.top, 294 - 6 - 34);
});

test("an anchor taller than the viewport keeps the arrow and note on screen", () => {
  // 화면보다 긴 대상(설정 화면의 시스템 에이전트 블록)을 가운데로 맞춘 뒤의 사각형.
  const placement = uiGuidePointerPlacement({ top: -200, left: 400, width: 500, height: 1200 }, viewport);
  assert.equal(placement.ring.top, 12);
  assert.equal(placement.ring.height, 800 - 24, "링이 화면 안으로 잘린다");
  assert.equal(placement.arrow.direction, "down");
  assert.equal(placement.arrow.top, 12 + 6, "화살표는 링 안쪽 위에 얹힌다");
  assert.equal(placement.note.top, 12 + 6 + 34 + 6);
  assert.equal(placement.note.bottom, null);
  assert.ok(placement.note.top + 64 < viewport.height, "말풍선이 화면 밖으로 나가지 않는다");
});

test("the arrow and note stay inside the viewport for anchors at the edges", () => {
  const left = uiGuidePointerPlacement({ top: 400, left: 0, width: 30, height: 30 }, viewport);
  assert.equal(left.arrow.left, 12);
  assert.equal(left.note.left, 12);
  const right = uiGuidePointerPlacement({ top: 400, left: 1180, width: 30, height: 30 }, viewport);
  assert.equal(right.arrow.left, 1200 - 12 - 34);
  assert.equal(right.note.left, 1200 - 12 - 320);
  const narrow = uiGuidePointerPlacement({ top: 400, left: 100, width: 30, height: 30 }, { width: 320, height: 600 });
  assert.equal(narrow.note.width, 320 - 24);
  assert.equal(narrow.note.left, 12);
});
