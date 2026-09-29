import assert from "node:assert/strict";
import test from "node:test";
import {
  fileDownloadActivities,
  fileDownloadRatio,
  finishFileDownload,
  markFileDownloadCancelling,
  startFileDownload,
  subscribeFileDownloads,
  updateFileDownload,
} from "./fileDownloads.ts";

test("진행 보고는 시작한 저장에만 쌓이고 끝나면 목록에서 빠진다", () => {
  const seen = [];
  const stop = subscribeFileDownloads((activities) => seen.push(activities.length));

  startFileDownload("a", "archive.zip");
  updateFileDownload("a", 512, 2048);
  assert.deepEqual(fileDownloadActivities(), [
    { id: "a", fileName: "archive.zip", copiedBytes: 512, totalBytes: 2048, cancelling: false },
  ]);

  startFileDownload("b", "video.mp4");
  assert.equal(fileDownloadActivities().length, 2);

  finishFileDownload("a");
  finishFileDownload("b");
  assert.deepEqual(fileDownloadActivities(), []);
  assert.deepEqual(seen, [1, 1, 2, 1, 0]);
  stop();
});

test("끝난 저장의 늦은 보고는 목록을 되살리지 않는다", () => {
  startFileDownload("late", "big.bin");
  finishFileDownload("late");
  updateFileDownload("late", 10, 20);
  assert.deepEqual(fileDownloadActivities(), []);
});

test("취소 표시는 같은 항목에만 붙고 비율은 총량을 알 때만 나온다", () => {
  startFileDownload("c", "dump.sql");
  assert.equal(fileDownloadRatio(fileDownloadActivities()[0]), null);

  updateFileDownload("c", 3, 4);
  markFileDownloadCancelling("c");
  const [activity] = fileDownloadActivities();
  assert.equal(activity.cancelling, true);
  assert.equal(fileDownloadRatio(activity), 0.75);

  // 보고가 총량을 넘겨도 비율은 1을 넘지 않는다.
  updateFileDownload("c", 9, 4);
  assert.equal(fileDownloadRatio(fileDownloadActivities()[0]), 1);
  finishFileDownload("c");
});

test("끝난 저장의 취소 표시는 목록도 구독도 건드리지 않는다", () => {
  const seen = [];
  const stop = subscribeFileDownloads((activities) => seen.push(activities));

  startFileDownload("gone", "late.bin");
  finishFileDownload("gone");
  const settled = fileDownloadActivities();

  markFileDownloadCancelling("gone");
  // 같은 배열이어야 useSyncExternalStore가 다시 그리지 않는다.
  assert.equal(fileDownloadActivities(), settled);
  assert.equal(seen.length, 2);
  stop();
});
