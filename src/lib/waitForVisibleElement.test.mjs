import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForVisibleElement } from "./waitForVisibleElement.ts";

function fakeProbe({ appearsAtFrame, visibleAtFrame = appearsAtFrame }) {
  let frame = 0;
  const frames = [];
  const element = { id: "anchor" };
  return {
    element,
    frames,
    probe: {
      query: () => (frame >= appearsAtFrame ? element : null),
      isVisible: () => frame >= visibleAtFrame,
      requestFrame(callback) {
        frame += 1;
        frames.push(frame);
        queueMicrotask(callback);
        return frame;
      },
      cancelFrame() {},
      now: () => frame * 16,
    },
  };
}

test("resolves with the element once it exists and has a size", async () => {
  const { probe, element } = fakeProbe({ appearsAtFrame: 2, visibleAtFrame: 4 });
  const found = await waitForVisibleElement("[data-ui-anchor]", 3000, probe);
  assert.equal(found, element);
});

test("a hidden element does not count until it gets a size", async () => {
  const { probe, frames } = fakeProbe({ appearsAtFrame: 0, visibleAtFrame: 3 });
  await waitForVisibleElement("[data-ui-anchor]", 3000, probe);
  assert.equal(frames.length, 3, "존재만으로 끝내지 않고 크기가 생길 때까지 기다린다");
});

test("gives up with null after the timeout", async () => {
  const { probe, frames } = fakeProbe({ appearsAtFrame: Number.POSITIVE_INFINITY });
  const found = await waitForVisibleElement("[data-ui-anchor]", 100, probe);
  assert.equal(found, null);
  assert.ok(frames.length >= 6 && frames.length <= 8, `약 100ms 뒤에 멈춰야 한다: ${frames.length}`);
});
