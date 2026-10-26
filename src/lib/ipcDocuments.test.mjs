import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// V4: 실제 문서 API와 전송을 연결해 읽은 수정 시각이 저장까지 유지되는지 검증한다.
const lib = new URL("./", import.meta.url);
const clientUrl = new URL("ipcDocuments.ts", lib).href;
const transportUrl = new URL("ipcTransport.ts", lib).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if ([clientUrl, transportUrl].includes(context.parentURL)
      && ["./ipcTransport", "./backend", "./backendErrors"].includes(specifier)) {
      return nextResolve(new URL(`${specifier}.ts`, lib).href, context);
    }
    return nextResolve(specifier, context);
  },
});
let documents;
let transport;
try {
  documents = await import(clientUrl);
  transport = await import(transportUrl);
} finally {
  hooks.deregister();
}

const rootId = "test-root";
const relativePath = "하위 폴더/문서.md";
const conflictMessage = "다른 프로그램에서 파일이 변경되었습니다. 다시 불러온 뒤 저장하세요.";

function fixture(t, modifiedAt) {
  const originalWindow = globalThis.window;
  globalThis.window = { location: { protocol: "https:", host: "manager.example.test" } };
  transport.resetBackendProtocolHandshake();
  let current = { rootId, relativePath, content: "# 처음 읽은 본문\n", modifiedAt };
  const writes = [];
  const file = () => ({ ...current, sizeBytes: Buffer.byteLength(current.content) });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).origin, "https://manager.example.test");
    const path = new URL(url).pathname;
    if (path === "/api/access") {
      return Response.json({
        protocolVersion: 14,
        storeId: "00000000-0000-0000-0000-000000000001",
        instanceId: "test-backend",
        backendPort: 54178,
        mode: "tailscale",
        remote: true,
        channel: "remote",
        authenticated: false,
        loginRequired: { password: false, otp: false },
        headless: true,
      });
    }
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Content-Type"), "application/json");
    const args = JSON.parse(init.body);
    if (path === "/api/invoke/get_document_file") {
      assert.deepEqual(args, { rootId, relativePath });
      return Response.json({ ...file(), kind: "markdown", downloadable: true });
    }
    assert.equal(path, "/api/invoke/put_doc");
    assert.equal(args.request.rootId, rootId);
    assert.equal(args.request.relativePath, relativePath);
    writes.push(args.request);
    // Core save_doc와 같은 계약: 기대 시각이 없으면 검사를 생략한다.
    // 클라이언트가 이 필드를 빠뜨리면 아래 충돌 시험에서 본문이 덮여 실패한다.
    if (args.request.expectedModifiedAt != null && args.request.expectedModifiedAt !== current.modifiedAt) {
      return Response.json({ error: conflictMessage }, { status: 409 });
    }
    current = { ...current, content: args.request.content, modifiedAt: current.modifiedAt + 1 };
    return Response.json(file());
  });
  t.after(() => {
    transport.resetBackendProtocolHandshake();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  return {
    writes,
    file,
    externalEdit() {
      current = { ...current, content: "# 외부에서 바뀐 본문\n", modifiedAt: current.modifiedAt + 1 };
    },
  };
}

for (const modifiedAt of [0, 1_700_000_000_123]) {
  test(`V4: 수정 시각 ${modifiedAt}의 오래된 초안은 충돌을 알리고 재조회 전까지 덮어쓰지 않는다`, async (t) => {
    const backend = fixture(t, modifiedAt);
    const loaded = await documents.getDocumentFile(rootId, relativePath);
    backend.externalEdit();
    const external = backend.file();
    await assert.rejects(
      documents.putDoc(loaded.rootId, loaded.relativePath, "# 오래된 초안\n", loaded.modifiedAt),
      { message: conflictMessage },
    );
    assert.deepEqual(backend.file(), external);
    assert.equal(backend.writes.length, 1, "충돌 뒤 보호 검사를 빼고 자동 재시도하면 안 된다");
    assert.equal(backend.writes[0].expectedModifiedAt, modifiedAt);

    const refreshed = await documents.getDocumentFile(rootId, relativePath);
    assert.equal(refreshed.content, external.content);
    const saved = await documents.putDoc(rootId, relativePath, "# 병합한 본문\n", refreshed.modifiedAt);
    assert.deepEqual(saved, backend.file());
    assert.equal(saved.content, "# 병합한 본문\n");
    assert.equal(saved.modifiedAt, external.modifiedAt + 1);
    assert.equal(backend.writes.length, 2);
    assert.equal(backend.writes[1].expectedModifiedAt, refreshed.modifiedAt);
  });
}

test("V4: 변경되지 않은 문서는 읽은 밀리초 시각으로 빈 본문도 저장한다", async (t) => {
  const backend = fixture(t, 1_700_000_000_123);
  const loaded = await documents.getDocumentFile(rootId, relativePath);
  const saved = await documents.putDoc(rootId, relativePath, "", loaded.modifiedAt);
  assert.deepEqual(saved, backend.file());
  assert.equal(saved.content, "");
  assert.equal(saved.sizeBytes, 0);
  assert.equal(saved.modifiedAt, loaded.modifiedAt + 1);
  assert.equal(backend.writes.length, 1);
  assert.equal(backend.writes[0].expectedModifiedAt, loaded.modifiedAt);
});
