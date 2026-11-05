import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NOW, account, accountSnapshot, automation, manager, schedulerSnapshot } from "./aiaSuggestionFixtures.mjs";

// V4: 실제 제안 훅을 실행하되 React의 렌더·효과 경계와 IPC·타이머만 제어한다.
// 분석 완료 전에 새 스냅샷이 도착하는 순서를 결정적으로 재현한다.
let runtime;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source;
    if (specifier === "react") {
      source = ["useState", "useRef", "useMemo", "useCallback", "useEffect"]
        .map((name) => `export const ${name} = (...args) => globalThis.aiaHookRuntime.${name}(...args);`).join("\n");
    } else if (context.parentURL?.endsWith("/appAiaSuggestions.ts")) {
      if (specifier === "./appStoredState") {
        source = `
          const store = (initial) => ({ load: () => initial(), save() {}, saveIfChanged: (update) => update(initial()) });
          export const aiaEventBudgetStore = store(() => ({ dispatches: [] }));
          export const aiaSkillChangeStore = store(() => ({ changes: [] }));
          export const aiaSuggestionHistoryStore = store(() => ({}));
        `;
      } else if (specifier === "./lib/poll") {
        source = "export function usePoll() {}";
      } else if (specifier === "./lib/ipc") {
        source = `
          export const hasTauriRuntime = () => true;
          export const analyzeAiaEvent = (summary) => globalThis.aiaHookRuntime.analyze(summary);
          export async function getAiaSuggestionCatalog() { throw new Error('unexpected catalog poll'); }
          export async function getCommonSkillDigests() { throw new Error('unexpected skill poll'); }
        `;
      } else if (specifier === "./lib/aiaSuggestions") {
        return nextResolve("./lib/aiaSuggestions.ts", context);
      }
    }
    if (source !== undefined) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { useAiaSuggestionCenter } = await import("../appAiaSuggestions.ts");
hooks.deregister();

function createRuntime() {
  const slots = [];
  const timers = new Map();
  const requests = [];
  let cursor = 0;
  let effects = [];
  let dirty = false;
  let now = NOW;
  let nextTimer = 0;
  const same = (left, right) => left && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
  const api = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (update) => {
        const next = typeof update === "function" ? update(slots[index]) : update;
        if (!Object.is(slots[index], next)) { slots[index] = next; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ??= { current: initial };
    },
    useMemo(build, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: build() };
      return slots[index].value;
    },
    useCallback(callback, deps) { return api.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const index = cursor++;
      if (same(slots[index]?.deps, deps)) return;
      const previous = slots[index];
      slots[index] = { deps };
      effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
    },
    analyze(summary) {
      return new Promise((resolve, reject) => requests.push({ summary, resolve, reject }));
    },
    render(input) {
      let result;
      let renders = 0;
      do {
        assert.ok(++renders < 20, "hook render did not settle");
        cursor = 0;
        dirty = false;
        effects = [];
        result = useAiaSuggestionCenter(input);
        for (const effect of effects) effect();
      } while (dirty);
      return result.aiaSuggestions;
    },
    fireAnalysisTimer() {
      now += 30_000;
      const due = [...timers.values()];
      timers.clear();
      assert.equal(due.length, 1);
      due[0]();
      assert.equal(requests.length, 1);
    },
    now: () => now,
    requests,
    window: {
      setTimeout(callback) { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimeout(id) { timers.delete(id); },
    },
  };
  return api;
}

const provider = { provider: "claude", cli: { detected: true, path: "/cli" }, history: { detected: true, path: "/history" } };
function input() {
  return {
    aiaProviderId: "claude", aiaOpen: false, popoutRequest: null,
    snapshot: manager([], [provider]), accounts: accountSnapshot(account("primary")),
    scheduler: schedulerSnapshot(false), automation: automation({ providers: [provider] }), attention: {},
  };
}

test("V4: 분석 도중 해소된 운영 오류는 늦게 온 분석으로 다시 나타나지 않는다", async () => {
  const originalWindow = globalThis.window;
  const originalNow = Date.now;
  try {
    for (const recoveredBeforeCompletion of [true, false]) {
      runtime = createRuntime();
      globalThis.aiaHookRuntime = runtime;
      globalThis.window = runtime.window;
      Date.now = runtime.now;
      const good = input();
      const bad = { ...good, accounts: accountSnapshot(account("primary", { authStatus: "missing" })) };
      assert.deepEqual(runtime.render(good), []);
      runtime.render(bad);
      runtime.fireAnalysisTimer();
      runtime.render(bad);
      const current = recoveredBeforeCompletion ? good : bad;
      assert.deepEqual(runtime.render(current), []);
      runtime.requests[0].resolve({ summary: "인증 오류 분석", command: null });
      await new Promise(setImmediate);
      const suggestions = runtime.render(current);
      assert.equal(suggestions.length, recoveredBeforeCompletion ? 0 : 1);
      if (!recoveredBeforeCompletion) {
        assert.equal(suggestions[0].kind, "accountAuthError");
        assert.equal(suggestions[0].detail, "인증 오류 분석");
        assert.deepEqual(runtime.render(good), [], "완료 후 해소된 오류도 내려야 한다");
      }
    }
  } finally {
    Date.now = originalNow;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    delete globalThis.aiaHookRuntime;
  }
});
