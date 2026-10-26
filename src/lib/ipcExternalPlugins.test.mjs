import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { builtinToolsRevision, subscribeBuiltinTools } from "./builtinToolsSignal.ts";

// V4: 소스에 알림 함수 이름이 있는지만 보면, 실제 요청과 분리된 알림도 통과한다.
// 전송만 지연시키고 실제 IPC 함수와 신호를 함께 실행해 화면이 다시 읽는 시점을 확인한다.
const transportUrl = `data:text/javascript,${encodeURIComponent(`
  let response;
  export function setResponse(value) { response = value; }
  export function call() { return response; }
`)}`;
const transport = await import(transportUrl);
const clientUrl = new URL("./ipcExternalPlugins.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === clientUrl) {
      if (specifier === "./ipcTransport") return { url: transportUrl, shortCircuit: true };
      if (specifier === "./builtinToolsSignal") {
        return nextResolve(new URL("./builtinToolsSignal.ts", import.meta.url).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
let setExternalPluginEnabled;
try {
  ({ setExternalPluginEnabled } = await import(clientUrl));
} finally {
  hooks.deregister();
}

test("V4: 플러그인 사용 변경이 끝난 뒤에만 기본도구 상세를 한 번 갱신한다", async (t) => {
  const pending = Promise.withResolvers();
  transport.setResponse(pending.promise);
  const before = builtinToolsRevision();
  let notifications = 0;
  t.after(subscribeBuiltinTools(() => { notifications += 1; }));

  const request = setExternalPluginEnabled("example", true);
  await Promise.resolve();
  assert.equal(notifications, 0, "변경이 끝나기 전에 옛 카탈로그를 다시 읽으면 안 된다");
  assert.equal(builtinToolsRevision(), before);

  const updated = { id: "example", enabled: true };
  pending.resolve(updated);
  assert.equal(await request, updated, "화면에는 백엔드가 확인한 결과를 그대로 돌려준다");
  assert.equal(notifications, 1);
  assert.equal(builtinToolsRevision(), before + 1);
});

test("V4: 거절된 플러그인 사용 변경은 기본도구 상세를 갱신하지 않고 오류를 전달한다", async (t) => {
  const pending = Promise.withResolvers();
  transport.setResponse(pending.promise);
  const before = builtinToolsRevision();
  let notifications = 0;
  t.after(subscribeBuiltinTools(() => { notifications += 1; }));

  const request = setExternalPluginEnabled("example", false);
  const rejected = new Error("플러그인 변경 거절");
  const checked = assert.rejects(request, (error) => error === rejected);
  pending.reject(rejected);
  await checked;
  assert.equal(notifications, 0);
  assert.equal(builtinToolsRevision(), before);
});
