import assert from "node:assert/strict";
import test from "node:test";
import { cliUpdateAlert, hasCliUpdateAlert, shouldShowCliUpdatePanel } from "./cliUpdateAlerts.ts";
import { cache, status } from "./cliUpdateFixtures.mjs";

// 여러 공급자의 상태를 모아 상단 알림에 무엇이 쌓이고 어느 카드의 업데이트 구획이 열리는지만
// 본다. 버튼 하나를 누를 수 있는지는 cliUpdate.test.mjs가 맡는다.

test("업데이트 알림과 캐시 스키마 불일치 알림을 분리해 집계한다", () => {
  const statuses = [
    status({ provider: "codex", modelCaches: [cache()] }),
    status({
      provider: "claude",
      checked: true,
      latestVersion: "2.1.235",
      currentVersion: "2.1.233",
      updateAvailable: true,
    }),
    status({ provider: "antigravity", checkSupported: false }),
  ];
  const alert = cliUpdateAlert(statuses);
  assert.deepEqual(alert.updatable, ["claude"]);
  assert.deepEqual(alert.cacheMismatched, ["codex"]);
  assert.deepEqual(alert.checkFailed, []);
  assert.equal(hasCliUpdateAlert(alert), true);
  assert.equal(hasCliUpdateAlert(cliUpdateAlert([status()])), false);
});

test("버전을 읽지 못한 공급자도 알림 근거로 집계한다", () => {
  const checkFailed = cliUpdateAlert([status({ checked: true, checkError: "네트워크 오류" })]);
  assert.deepEqual(checkFailed.checkFailed, ["codex"]);
  assert.equal(hasCliUpdateAlert(checkFailed), true);

  const versionUnknown = cliUpdateAlert([status({ versionError: "codex --version 실행 실패" })]);
  assert.deepEqual(versionUnknown.checkFailed, ["codex"]);

  // 실행 파일이 없으면 카드 머리말이 이미 연결 필요를 알리므로 업데이트 알림에는 넣지 않는다.
  const notDetected = cliUpdateAlert([status({ executablePath: null, currentVersion: null, versionError: "탐지 실패" })]);
  assert.deepEqual(notDetected.checkFailed, []);
  assert.equal(hasCliUpdateAlert(notDetected), false);
});

test("업데이트 구획은 알림 근거나 진행·결과가 있을 때만 연다", () => {
  const idle = { busy: false, hasMessage: false, pending: false };
  const upToDate = status({ checked: true, latestVersion: "0.146.0" });
  const quietAlert = cliUpdateAlert([upToDate]);
  assert.equal(shouldShowCliUpdatePanel(upToDate, quietAlert, idle), false);

  const updatable = status({ checked: true, latestVersion: "0.147.0", updateAvailable: true });
  assert.equal(shouldShowCliUpdatePanel(updatable, cliUpdateAlert([updatable]), idle), true);

  const mismatched = status({ checked: true, latestVersion: "0.146.0", modelCaches: [cache()] });
  assert.equal(shouldShowCliUpdatePanel(mismatched, cliUpdateAlert([mismatched]), idle), true);

  // 다른 공급자의 알림 때문에 열리지는 않는다.
  const otherAlert = cliUpdateAlert([updatable, { ...upToDate, provider: "claude" }]);
  assert.equal(shouldShowCliUpdatePanel({ ...upToDate, provider: "claude" }, otherAlert, idle), false);

  // 업데이트를 끝내면 근거는 사라지지만 결과 안내는 남아 있어야 한다.
  assert.equal(
    shouldShowCliUpdatePanel(upToDate, quietAlert, { busy: false, hasMessage: true, pending: false }),
    true,
  );
  assert.equal(
    shouldShowCliUpdatePanel(upToDate, quietAlert, { busy: true, hasMessage: false, pending: false }),
    true,
  );
  assert.equal(
    shouldShowCliUpdatePanel(upToDate, quietAlert, { busy: false, hasMessage: false, pending: true }),
    true,
  );
});
