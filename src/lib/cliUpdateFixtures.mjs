// CLI 업데이트 시험이 함께 쓰는 상태 표본. 상태 한 건을 읽는 규칙(cliUpdateStatus)·그
// 상태로 버튼을 정하는 규칙(cliUpdate)·여러 공급자를 모아 알림과 구획을 정하는 규칙
// (cliUpdateAlerts)이 따로 시험되지만, 셋이 보는 입력은 같은 `ProviderCliUpdateStatus`
// 한 벌이다. 표본을 시험마다 한 벌씩 두면 백엔드가 칸을 하나 더할 때 한쪽만 따라가고
// 나머지는 예전 모양으로 남는다.

export const status = (overrides = {}) => ({
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

export const cache = (overrides = {}) => ({
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

// 같은 홈을 쓰는 옛 클라이언트(데스크톱 앱 등)가 되쓴 캐시. 백엔드가 outdated로 주며
// 정리 대상이 아니다.
export const olderCache = (overrides = {}) => cache({
  state: "outdated",
  cacheClientVersion: "0.151.0",
  cliVersion: "0.152.0",
  cleanupAvailable: false,
  ...overrides,
});
