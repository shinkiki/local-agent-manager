import assert from "node:assert/strict";
import test from "node:test";
import {
  cacheAwaitsNewerCliRelease,
  canCheckCliUpdate,
  canClearModelCaches,
  canRunCliUpdate,
  cliUpdateAlert,
  cliUpdateBadge,
  cliUpdateBlockedReason,
  hasCliUpdateAlert,
  modelCacheBlockedReason,
  modelCacheCleanupTargets,
  runtimeStopConfirmationCount,
  shouldShowCliUpdatePanel,
} from "./cliUpdate.ts";

const status = (overrides = {}) => ({
  provider: "codex",
  displayName: "OpenAI Codex",
  executablePath: "/opt/homebrew/Caskroom/codex/0.146.0/bin/codex",
  currentVersion: "0.146.0",
  versionError: null,
  installSource: "homebrewCask",
  packageName: "codex",
  updateMethod: "homebrewCask",
  updateSupported: true,
  unsupportedReason: null,
  updateCommandLabel: "brew upgrade --cask codex",
  manualUpdateHint: null,
  checkSupported: true,
  checkUnsupportedReason: null,
  checked: false,
  latestVersion: null,
  checkError: null,
  updateAvailable: false,
  modelCaches: [],
  modelCacheUnsupportedReason: null,
  ...overrides,
});

const cache = (overrides = {}) => ({
  id: "codex-models-cache",
  label: "Codex 모델 카탈로그 캐시",
  path: "/Users/example/.codex/models_cache.json",
  state: "mismatched",
  cacheClientVersion: "0.148.0",
  cliVersion: "0.146.0",
  error: null,
  cleanupAvailable: true,
  ...overrides,
});

const writable = { writable: true };
const readOnly = { writable: false };

test("업데이트 가능, 최신, 확인 실패를 서로 다른 상태로 구분한다", () => {
  assert.equal(
    cliUpdateBadge(status({ checked: true, latestVersion: "0.147.0", updateAvailable: true })),
    "updateAvailable",
  );
  assert.equal(cliUpdateBadge(status({ checked: true, latestVersion: "0.146.0" })), "upToDate");
  assert.equal(cliUpdateBadge(status({ checked: true, checkError: "네트워크 오류" })), "checkFailed");
  assert.equal(cliUpdateBadge(status({ executablePath: null })), "notDetected");
  assert.equal(cliUpdateBadge(status()), "unchecked");
});

test("실행 버전을 읽지 못하면 최신 버전을 알아도 '최신'이 아니라 '실행 버전 확인 실패'다 (QA #54)", () => {
  // 실행 파일은 있는데 --version이 실패한 경우: 최신 조회는 끝났고 값도 있지만 비교가 성립하지 않는다.
  const versionFailed = status({ currentVersion: null, versionError: "codex --version 실행 실패", checked: true, latestVersion: "0.146.0" });
  assert.equal(cliUpdateBadge(versionFailed), "versionUnknown");
  // 오류 문구 없이 값만 비어 있어도 같다.
  assert.equal(cliUpdateBadge(status({ currentVersion: null, checked: true, latestVersion: "0.146.0" })), "versionUnknown");
  // 최신 조회까지 실패했으면 실행 버전 쪽을 먼저 알린다 — 로컬 실행 파일 문제가 더 근본 원인이다.
  assert.equal(cliUpdateBadge(status({ currentVersion: null, versionError: "실패", checked: true, checkError: "네트워크 오류" })), "versionUnknown");
  // 실행 파일이 없으면 미탐지가 우선한다.
  assert.equal(cliUpdateBadge(status({ executablePath: null, currentVersion: null, versionError: "탐지 실패" })), "notDetected");
  // 백엔드가 업데이트 가능으로 판정했으면 그 판정을 따른다.
  assert.equal(cliUpdateBadge(status({ currentVersion: null, checked: true, latestVersion: "0.147.0", updateAvailable: true })), "updateAvailable");
  // 실행 버전을 읽었으면 기존 판정 그대로다.
  assert.equal(cliUpdateBadge(status({ checked: true, latestVersion: "0.146.0" })), "upToDate");
});

test("자동 업데이트 미지원과 최신 버전 확인 미지원은 다른 상태다", () => {
  const unsupported = status({
    installSource: "npmGlobal",
    updateMethod: "unsupported",
    updateSupported: false,
    checkSupported: false,
    unsupportedReason: "공식 npm 패키지가 아닙니다",
  });
  assert.equal(cliUpdateBadge(unsupported), "unsupported");

  const selfUpdate = status({
    provider: "antigravity",
    installSource: "standalone",
    updateMethod: "selfUpdate",
    packageName: null,
    checkSupported: false,
    checkUnsupportedReason: "agy update는 확인과 설치를 함께 수행합니다",
    updateCommandLabel: "/Users/example/.local/bin/agy update",
  });
  assert.equal(cliUpdateBadge(selfUpdate), "checkUnsupported");
  // 최신 버전을 조회할 수 없어도 업데이트 실행 자체는 제공한다.
  assert.equal(canRunCliUpdate(selfUpdate, writable), true);
  assert.equal(canCheckCliUpdate(selfUpdate, writable), false);
});

test("업데이트 버튼은 호스트·원격 구분 없이 write 권한으로 활성화된다", () => {
  const updatable = status({ checked: true, latestVersion: "0.147.0", updateAvailable: true });
  assert.equal(canRunCliUpdate(updatable, writable), true);
  assert.equal(canCheckCliUpdate(updatable, writable), true);
  assert.equal(cliUpdateBlockedReason(updatable, writable), null);

  // read 전용과 다른 작업 진행 중에는 여전히 막는다.
  assert.equal(canRunCliUpdate(updatable, readOnly), false);
  assert.match(cliUpdateBlockedReason(updatable, readOnly), /원격 변경이 비활성화/);
  assert.equal(canCheckCliUpdate(updatable, readOnly), false);
  assert.equal(canRunCliUpdate(updatable, { ...writable, busy: true }), false);
});

test("탐지되지 않았거나 자동 업데이트 미지원이면 사유를 그대로 보여준다", () => {
  assert.match(cliUpdateBlockedReason(status({ executablePath: null }), writable), /탐지되지 않았습니다/);
  const unsupported = status({
    updateSupported: false,
    unsupportedReason: "Homebrew 설치로 보이지만 brew 실행 파일을 찾지 못했습니다",
  });
  assert.equal(canRunCliUpdate(unsupported, writable), false);
  assert.equal(
    cliUpdateBlockedReason(unsupported, writable),
    "Homebrew 설치로 보이지만 brew 실행 파일을 찾지 못했습니다",
  );
});

test("캐시 정리는 불일치가 있을 때만 열리고, 캐시가 없는 공급자는 미지원으로 표시한다", () => {
  const mismatched = status({ modelCaches: [cache()] });
  assert.equal(modelCacheCleanupTargets(mismatched).length, 1);
  assert.equal(canClearModelCaches(mismatched, writable), true);
  assert.equal(modelCacheBlockedReason(mismatched, writable), null);
  // 캐시 정리도 원격 write 권한으로 실행하고, read 전용에서만 막는다.
  assert.equal(canClearModelCaches(mismatched, readOnly), false);
  assert.match(modelCacheBlockedReason(mismatched, readOnly), /원격 변경이 비활성화/);
  assert.equal(canClearModelCaches(mismatched, { ...writable, busy: true }), false);

  const matched = status({
    modelCaches: [cache({ state: "matched", cacheClientVersion: "0.146.0", cleanupAvailable: false })],
  });
  assert.equal(canClearModelCaches(matched, writable), false);
  assert.equal(modelCacheBlockedReason(matched, writable), null);

  const noCache = status({
    provider: "claude",
    modelCaches: [],
    modelCacheUnsupportedReason: "Claude Code 홈에는 모델 카탈로그 캐시 파일이 없습니다",
  });
  assert.equal(canClearModelCaches(noCache, writable), false);
  assert.equal(
    modelCacheBlockedReason(noCache, writable),
    "Claude Code 홈에는 모델 카탈로그 캐시 파일이 없습니다",
  );
  // 캐시 정리를 지원하지 않아도 업데이트 기능은 그대로 제공한다.
  assert.equal(canRunCliUpdate(noCache, writable), true);
});

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

// 같은 홈을 쓰는 옛 클라이언트(데스크톱 앱 등)가 되쓴 캐시. 백엔드가 outdated로 주며
// 정리 대상이 아니다.
const olderCache = (overrides = {}) => cache({
  state: "outdated",
  cacheClientVersion: "0.151.0",
  cliVersion: "0.152.0",
  cleanupAvailable: false,
  ...overrides,
});

test("배포된 최신 CLI보다 새 클라이언트가 기록한 캐시는 배포 대기로 안내한다", () => {
  const newerCache = cache({ cacheClientVersion: "0.149.0", cliVersion: "0.148.0" });
  // 최신 확인이 끝났고 올릴 버전이 없을 때만 배포 대기다.
  const upToDate = status({ currentVersion: "0.148.0", checked: true, latestVersion: "0.148.0" });
  assert.equal(cacheAwaitsNewerCliRelease(upToDate, newerCache), true);

  // 올릴 버전이 있으면 업데이트가 해결책이므로 기존 안내를 유지한다.
  const updatable = status({ currentVersion: "0.148.0", checked: true, latestVersion: "0.149.0", updateAvailable: true });
  assert.equal(cacheAwaitsNewerCliRelease(updatable, newerCache), false);

  // 확인 전이거나, 기록 버전이 실행 버전보다 오래된 캐시도 해당하지 않는다.
  assert.equal(cacheAwaitsNewerCliRelease(status({ currentVersion: "0.148.0" }), newerCache), false);
  assert.equal(cacheAwaitsNewerCliRelease(upToDate, olderCache()), false);
});

test("실행 버전을 읽지 못한 캐시 불일치는 배포 대기가 아니다 (QA #54)", () => {
  const newerCache = cache({ cacheClientVersion: "0.149.0", cliVersion: null });
  // "CLI가 이미 최신"이라는 전제는 실행 버전을 알 때만 선다.
  const versionUnknown = status({ currentVersion: null, versionError: "codex --version 실행 실패", checked: true, latestVersion: "0.148.0" });
  assert.equal(cacheAwaitsNewerCliRelease(versionUnknown, newerCache), false);
  assert.equal(cacheAwaitsNewerCliRelease(status({ currentVersion: null, checked: true, latestVersion: "0.148.0" }), newerCache), false);
});

test("실행 버전보다 낮게 기록된 캐시는 경고도 정리 대상도 아니다", () => {
  const current = status({ currentVersion: "0.152.0", checked: true, latestVersion: "0.152.0", modelCaches: [olderCache()] });
  assert.deepEqual(modelCacheCleanupTargets(current), []);
  assert.equal(canClearModelCaches(current, writable), false);

  // 상단 알림 근거가 되지 않으므로 업데이트 구획도 접힌 채로 둔다.
  const alert = cliUpdateAlert([current]);
  assert.deepEqual(alert.cacheMismatched, []);
  assert.equal(hasCliUpdateAlert(alert), false);
  assert.equal(
    shouldShowCliUpdatePanel(current, alert, { busy: false, hasMessage: false, pending: false }),
    false,
  );

  // 반대 방향(기록 버전이 더 높음)은 그대로 경고와 정리 대상으로 남는다.
  const newer = status({ currentVersion: "0.148.0", modelCaches: [cache()] });
  assert.deepEqual(cliUpdateAlert([newer]).cacheMismatched, ["codex"]);
  assert.equal(canClearModelCaches(newer, writable), true);
});

test("종료 확인 대상은 관리 채팅·터미널·외부 프로세스를 합산한다", () => {
  assert.equal(
    runtimeStopConfirmationCount({ chatCount: 1, terminalCount: 2, externalProcessCount: 3 }),
    6,
  );
  assert.equal(
    runtimeStopConfirmationCount({ chatCount: 0, terminalCount: 0, externalProcessCount: 0 }),
    0,
  );
});
