import assert from "node:assert/strict";
import test from "node:test";
import {
  diagramPopoutId,
  diagramPopoutSearch,
  diagramPopoutWindowName,
  parseDiagramPopoutId,
  readStashedDiagram,
  stashDiagramSource,
} from "./diagramPopout.ts";

/** localStorage 흉내. 순서·length·key(i)까지 써야 오래된 항목 정리를 검증할 수 있다. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key(index) { return [...map.keys()][index] ?? null; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
    clear() { map.clear(); },
    get size() { return map.size; },
  };
}

test("같은 원문은 같은 열쇠와 같은 창 이름을 쓴다", () => {
  const first = diagramPopoutId("sequenceDiagram\nA->>B: 안녕");
  assert.equal(first, diagramPopoutId("sequenceDiagram\nA->>B: 안녕"));
  assert.notEqual(first, diagramPopoutId("flowchart LR\nA --> B"));
  // 창 label과 주소에 그대로 쓰이므로 영숫자여야 한다.
  assert.match(first, /^[0-9a-f]{8}$/);
  assert.equal(diagramPopoutWindowName(first), `popout-diagram-${first}`);
});

test("원문과 UI 언어를 저장하고 열쇠로 다시 읽는다", () => {
  const storage = fakeStorage();
  const id = stashDiagramSource(storage, "flowchart LR\n  A --> B", "en");
  assert.deepEqual(readStashedDiagram(storage, id), { source: "flowchart LR\n  A --> B", locale: "en" });
  assert.equal(readStashedDiagram(storage, "deadbeef"), null);
  // 언어를 주지 않으면 한국어로 남는다(앱 기본값).
  const korean = stashDiagramSource(storage, "pie\n  \"a\" : 1");
  assert.deepEqual(readStashedDiagram(storage, korean).locale, "ko");
});

test("깨진 저장값과 막힌 저장소는 열쇠만 남기고 조용히 넘어간다", () => {
  const broken = fakeStorage({ "agent-manager.diagram-popout.abc": "{" });
  assert.equal(readStashedDiagram(broken, "abc"), null);
  // 언어가 없는 옛 저장값도 읽힌다.
  const legacy = fakeStorage({ "agent-manager.diagram-popout.abc": JSON.stringify({ source: "pie" }) });
  assert.deepEqual(readStashedDiagram(legacy, "abc"), { source: "pie", locale: "ko" });

  const blocked = {
    length: 0,
    key: () => null,
    getItem: () => { throw new Error("차단"); },
    setItem: () => { throw new Error("차단"); },
    removeItem: () => { throw new Error("차단"); },
  };
  const id = stashDiagramSource(blocked, "pie\n  \"a\" : 1");
  assert.equal(id, diagramPopoutId("pie\n  \"a\" : 1"));
  assert.equal(readStashedDiagram(blocked, id), null);
});

test("저장해 둔 원문은 여덟 개까지만 남는다", () => {
  const storage = fakeStorage();
  for (let index = 0; index < 12; index += 1) {
    stashDiagramSource(storage, `flowchart LR\n  A${index} --> B`, "ko", 1000 + index);
  }
  assert.equal(storage.size, 8);
  // 가장 최근 것은 반드시 남고, 가장 오래된 것은 지워진다.
  assert.equal(readStashedDiagram(storage, diagramPopoutId("flowchart LR\n  A11 --> B"))?.source, "flowchart LR\n  A11 --> B");
  assert.equal(readStashedDiagram(storage, diagramPopoutId("flowchart LR\n  A0 --> B")), null);
});

test("주소 쿼리는 한 쌍으로 움직이고 형식이 어긋나면 일반 화면이다", () => {
  assert.equal(parseDiagramPopoutId(diagramPopoutSearch("1a2b3c4d")), "1a2b3c4d");
  assert.equal(parseDiagramPopoutId("?popout=diagram&diagram=NOTHEX"), null);
  assert.equal(parseDiagramPopoutId("?popout=chat&chat=x"), null);
  assert.equal(parseDiagramPopoutId(""), null);
});
