import { test } from "node:test";
import assert from "node:assert/strict";
import { createAiaScreenBridge } from "./aiaScreenBridge.ts";

test("popout routes guide, query and click to exactly one main window", async () => {
  const received = [[], [], []];
  const name = `aia-test-${crypto.randomUUID()}`;
  const connections = received.map((events, index) => createAiaScreenBridge(index < 2, async (payload) => {
    events.push(payload);
    return true;
  }, new BroadcastChannel(name)));
  try {
    for (const kind of ["guide", "query", "click"]) {
      assert.equal(await connections[2].request({ kind }), true);
    }
    assert.deepEqual(received[2], []);
    assert.deepEqual(received.slice(0, 2).map((items) => items.length).sort(), [0, 3]);
  } finally {
    connections.forEach((connection) => connection.close());
  }
});

test("a missing main window does not execute a request inside the popout", async () => {
  const popup = createAiaScreenBridge(false, async () => { assert.fail("local execution"); }, new BroadcastChannel(crypto.randomUUID()));
  try { assert.equal(await popup.request({ kind: "guide" }), false); }
  finally { popup.close(); }
});
