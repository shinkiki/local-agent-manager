import assert from "node:assert/strict";
import test from "node:test";

import { parseWholeNumber, wholeNumberWithin } from "./runnerFields.ts";

test("parseWholeNumber accepts only whole digit strings, with surrounding whitespace", () => {
  assert.equal(parseWholeNumber("4"), 4);
  assert.equal(parseWholeNumber(" 12 "), 12);
  assert.equal(parseWholeNumber("007"), 7);
  assert.equal(parseWholeNumber("0"), 0);
});

test("parseWholeNumber refuses values the number input passes through but parseInt would truncate", () => {
  // `1e1` is 10 to the browser and 1 to parseInt — the stored value must not silently differ from what the user saw.
  for (const value of ["1e1", "3.5", "7x", "-1", "+2", ".", "", "  ", "abc", "1 2", "٣", "１"]) {
    assert.equal(parseWholeNumber(value), null, value);
  }
});

test("parseWholeNumber refuses digits beyond the safe integer range", () => {
  assert.equal(parseWholeNumber("9007199254740991"), 9007199254740991);
  assert.equal(parseWholeNumber("9007199254740992"), null);
});

test("wholeNumberWithin bounds a parsed value inclusively and is false for a non-value", () => {
  assert.equal(wholeNumberWithin("1", 1, 8), true);
  assert.equal(wholeNumberWithin("8", 1, 8), true);
  assert.equal(wholeNumberWithin("0", 1, 8), false);
  assert.equal(wholeNumberWithin("9", 1, 8), false);
  assert.equal(wholeNumberWithin("3.5", 1, 8), false);
  assert.equal(wholeNumberWithin("0", 0, 4_294_967_295), true);
});
