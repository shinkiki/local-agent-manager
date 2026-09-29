import assert from "node:assert/strict";
import test from "node:test";

import { cacheAwaitsNewerCliRelease, cliUpdateBadge } from "./cliUpdateStatus.ts";
import { cache, olderCache, status } from "./cliUpdateFixtures.mjs";

// 백엔드가 내려준 상태 한 건을 어떻게 읽는지만 본다. 그 상태로 어떤 버튼이 켜지고 어떤
// 구획이 열리는지는 cliUpdate.test.mjs가 맡는다 — 모듈이 갈라진 경계와 같다.

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
