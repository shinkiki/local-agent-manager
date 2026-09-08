import assert from "node:assert/strict";
import test from "node:test";

import { orderSessionsForList } from "./sessionList.ts";

test("favorites move to the front and keep the incoming recency order", () => {
  const ordered = orderSessionsForList([
    { id: "a", meta: { favorite: false } },
    { id: "b", meta: { favorite: true } },
    { id: "c", meta: { favorite: false } },
    { id: "d", meta: { favorite: true } },
  ]);
  assert.deepEqual(ordered.map((session) => session.id), ["b", "d", "a", "c"]);
});
