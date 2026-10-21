import assert from "node:assert/strict";
import test from "node:test";
import {
  canCheckCliUpdate,
  canClearModelCaches,
  canRunCliUpdate,
  cliUpdateAlert,
  cliUpdateBlockedReason,
  hasCliUpdateAlert,
  modelCacheBlockedReason,
  shouldShowManualUpdateHint,
  runtimeStopConfirmationCount,
  shouldShowCliUpdatePanel,
} from "./cliUpdate.ts";
import { cache, olderCache, status } from "./cliUpdateFixtures.mjs";

// 상태 한 건으로 버튼이 켜지는지와 못 누르는 사유만 본다. 상태를 어떻게 읽는지(배지·캐시
// 판정)는 cliUpdateStatus.test.mjs가, 여러 공급자를 모아 알림과 구획을 정하는 규칙은
// cliUpdateAlerts.test.mjs가 맡는다.

const writable = {};

test("최신 버전을 조회할 수 없는 설치도 업데이트 실행 자체는 제공한다", () => {
  const selfUpdate = status({
    provider: "antigravity",
    installSource: "standalone",
    updateMethod: "selfUpdate",
    packageName: null,
    checkSupported: false,
    checkUnsupportedReason: "agy update는 확인과 설치를 함께 수행합니다",
    updateCommandLabel: "/Users/example/.local/bin/agy update",
  });
  assert.equal(canRunCliUpdate(selfUpdate, writable), true);
  assert.equal(canCheckCliUpdate(selfUpdate, writable), false);
});

test("업데이트 버튼은 호스트·원격 구분 없이 활성화된다(C20: 로그인 뒤 모든 채널이 같다)", () => {
  const updatable = status({ checked: true, latestVersion: "0.147.0", updateAvailable: true });
  assert.equal(canRunCliUpdate(updatable, writable), true);
  assert.equal(canCheckCliUpdate(updatable, writable), true);
  assert.equal(cliUpdateBlockedReason(updatable, writable), null);

  // 다른 작업 진행 중에는 여전히 막는다.
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

test("헤드리스라는 이유만으로는 업데이트를 막지 않고 백엔드의 지원 여부를 따른다", () => {
  // 컨테이너는 CLI를 HOME 볼륨의 ~/.local에 둬 앱이 올릴 수 있다(H11). 막을지는 백엔드가
  // 설치 위치에 쓸 수 있는지로 정한다.
  const headless = { headless: true };
  const updatable = status({ checked: true, latestVersion: "0.147.0", updateAvailable: true });
  assert.equal(canRunCliUpdate(updatable, headless), true);
  assert.equal(cliUpdateBlockedReason(updatable, headless), null);

  // 옛 이미지(root 소유 /usr/local)는 백엔드가 updateSupported를 끄고 재생성 사유를 준다.
  // 화면은 그 사유를 그대로 싣는다.
  const readOnly = status({
    updateSupported: false,
    unsupportedReason: "설치 위치(/usr/local/lib/node_modules)에 현재 사용자가 쓸 수 없어 업데이트할 수 없습니다. 컨테이너 배포라면 이미지에 고정된 설치본입니다 — 새 이미지로 한 번 재생성하면 앱에서 업데이트할 수 있습니다",
  });
  assert.equal(canRunCliUpdate(readOnly, headless), false);
  assert.match(cliUpdateBlockedReason(readOnly, headless), /재생성/);

  // 막혔을 때 호스트 셸 수동 명령은 헤드리스에서만 숨긴다.
  const withHint = status({ manualUpdateHint: "brew upgrade --cask codex" });
  assert.equal(shouldShowManualUpdateHint(withHint, headless), false);
  assert.equal(shouldShowManualUpdateHint(withHint, writable), true);
  assert.equal(shouldShowManualUpdateHint(status({ manualUpdateHint: null }), writable), false);

  // 탐지되지 않은 CLI는 그대로 미탐지로 알린다.
  assert.match(cliUpdateBlockedReason(status({ executablePath: null }), headless), /탐지되지 않았습니다/);

  // 최신 버전 확인과 캐시 정리도 헤드리스에서 그대로 동작한다.
  assert.equal(canCheckCliUpdate(updatable, headless), true);
  assert.equal(canClearModelCaches(status({ modelCaches: [cache()] }), headless), true);
});

test("캐시 정리는 불일치가 있을 때만 열리고, 캐시가 없는 공급자는 미지원으로 표시한다", () => {
  const mismatched = status({ modelCaches: [cache()] });
  assert.equal(canClearModelCaches(mismatched, writable), true);
  assert.equal(modelCacheBlockedReason(mismatched, writable), null);
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

test("실행 버전보다 낮게 기록된 캐시는 경고도 정리 대상도 아니다", () => {
  const current = status({ currentVersion: "0.152.0", checked: true, latestVersion: "0.152.0", modelCaches: [olderCache()] });
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
