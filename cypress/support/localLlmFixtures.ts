/// <reference types="cypress" />

// 로컬 LLM(Ollama) 스펙 셋이 공유하는 세우기. 셋 다 똑같은 두 가지를 먼저 해야 한다 —
// 스냅숏의 `status.providers`에 local 을 탐지된 것으로 세우고(격리 하네스에는 `opencode`가
// 없어 화면이 이 공급자를 아예 그리지 않는다), 연결 설정·probe·저장 응답을 세 자리에 건다.
// 스펙마다 적으면 백엔드가 필드를 하나 늘릴 때 고칠 곳이 셋이 되므로 여기 한 벌만 둔다.
//
// `status.providers`는 스냅숏의 **중첩** 필드라 `cy.stubSnapshotField`로는 닿지 않는다.
// 그래서 `stubInvoke` + `req.continue`로 실제 응답을 흘리고 그 배열만 갈아 끼운다.

import type { LocalLlmConnection, LocalLlmProbeResult, ProviderStatus } from "../../src/types";

/** 목록에 이름이 없을 때 세울 최소한의 행. 화면이 읽는 것은 이 넷뿐이다. */
const DISPLAY_NAMES: Record<string, string> = {
  local: "Ollama",
  codex: "OpenAI Codex",
  claude: "Claude Code",
  antigravity: "Google Antigravity",
};

/**
 * 주어진 공급자가 탐지된 것으로 보이게 한다. 이미 목록에 있으면 그 행만 고친다.
 * 격리 하네스의 탐지는 임시 HOME 이 아니라 PATH 를 타므로, 무엇이 깔린 기계인지에
 * 따라 목록이 달라진다. 스펙이 고르려는 공급자는 여기서 못박는다.
 */
export function stubProvidersDetected(...names: string[]) {
  const wanted = names.length > 0 ? names : ["local"];
  return cy.stubInvoke("get_manager_snapshot", (req) => {
    req.continue((res) => {
      const body = res.body as { status?: { providers?: ProviderStatus[] } };
      if (!body.status) return;
      const providers = body.status.providers ?? [];
      for (const name of wanted) {
        const found = providers.find((provider) => provider.provider === name);
        const path = `/usr/local/bin/${name}`;
        if (found) {
          found.cli = { detected: true, path };
        } else {
          providers.push({
            provider: name as ProviderStatus["provider"],
            displayName: DISPLAY_NAMES[name] ?? name,
            cli: { detected: true, path },
            history: { detected: false, path: null },
          });
        }
      }
      body.status.providers = providers;
    });
  });
}

/** 저장된 연결. 기본은 "아직 아무것도 적지 않은" 상태다. */
export function localLlmConnection(overrides: Partial<LocalLlmConnection> = {}): LocalLlmConnection {
  return {
    baseUrl: "",
    defaultModel: "",
    contextWindow: null,
    apiKeyConfigured: false,
    enabled: false,
    ...overrides,
  };
}

/** probe 응답. 기본은 모델 둘을 가진 Ollama 서버다. */
export function localLlmProbe(overrides: Partial<LocalLlmProbeResult> = {}): LocalLlmProbeResult {
  return {
    reachable: true,
    models: ["qwen3:8b", "gpt-oss:20b"],
    server: "ollama/0.34.2",
    error: null,
    ...overrides,
  };
}

/** 새 채팅 모델 목록. 로컬만 세우고 다른 공급자는 실제 응답을 그대로 쓴다. */
export function stubLocalChatModels(models: string[]) {
  return cy.stubInvoke("get_chat_provider_options", (req) => {
    if ((req.body as { source?: string }).source !== "local") {
      req.continue();
      return;
    }
    req.reply({
      source: "local",
      models: models.map((model) => ({ model, displayName: model, supportedReasoningEfforts: [] })),
      supportedReasoningEfforts: [],
      settings: [],
    });
  });
}
