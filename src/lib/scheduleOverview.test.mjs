import assert from "node:assert/strict";
import test from "node:test";
import { recurrenceLabel, scheduleRunStatus } from "./scheduleOverview.ts";

const text = (_ko, en) => en;
const schedule = (fields = {}) => ({ enabled: true, manualRunRequestedAt: null, ...fields });
const run = (status) => ({ status });

test("a paused schedule reads paused even while a run is live", () => {
  assert.deepEqual(scheduleRunStatus(schedule({ enabled: false }), [run("running")], text), { status: "paused", label: "Paused" });
});

test("a live or waiting run anywhere in the list wins over a newer finished run", () => {
  assert.deepEqual(
    scheduleRunStatus(schedule(), [run("completed"), run("waitingForUsage")], text),
    { status: "waitingForUsage", label: "Waiting for usage to recover" },
  );
  assert.deepEqual(scheduleRunStatus(schedule(), [run("failed"), run("running")], text), { status: "running", label: "Running" });
});

test("a pending manual request outranks the last finished run", () => {
  assert.deepEqual(
    scheduleRunStatus(schedule({ manualRunRequestedAt: 10 }), [run("failed")], text),
    { status: "requested", label: "Run requested" },
  );
});

test("otherwise the first (newest) run decides, and no runs reads idle", () => {
  assert.deepEqual(scheduleRunStatus(schedule(), [run("failed"), run("completed")], text), { status: "failed", label: "Failed" });
  assert.deepEqual(scheduleRunStatus(schedule(), [], text), { status: "idle", label: "Waiting" });
});

test("recurrence labels pad the time and survive missing values", () => {
  assert.equal(recurrenceLabel({ frequency: "weekly", weekday: 9, hour: 7, minute: 5 }, text), "Every ? at 07:05");
  assert.equal(recurrenceLabel({ frequency: "weekly", weekday: 1, hour: 7, minute: 5 }, text), "Every Mon at 07:05");
  assert.equal(recurrenceLabel({ frequency: "hourly", interval: 1, hour: 0, minute: 0 }, text), "Every hour");
  assert.equal(recurrenceLabel({ frequency: "hourly", interval: 3, hour: 0, minute: 0 }, text), "Every 3 hours");
  assert.equal(recurrenceLabel({ frequency: "cron", cron: null, hour: 0, minute: 0 }, text), "Cron –");
});
