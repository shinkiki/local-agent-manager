import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  builtinToolsRevision,
  markBuiltinToolsChanged,
  notifyBuiltinTools,
  subscribeBuiltinTools,
} from "./builtinToolsSignal.ts";

test("알림은 구독자를 깨우고 판을 올린다", () => {
  const before = builtinToolsRevision();
  let woke = 0;
  const stop = subscribeBuiltinTools(() => { woke += 1; });
  markBuiltinToolsChanged();
  assert.equal(woke, 1);
  assert.equal(builtinToolsRevision(), before + 1);
  stop();
  markBuiltinToolsChanged();
  assert.equal(woke, 1, "구독을 끊은 뒤에는 깨우지 않는다");
});

test("거절된 요청은 아무것도 바꾸지 않았으므로 알리지 않는다", async () => {
  const before = builtinToolsRevision();
  await assert.rejects(notifyBuiltinTools(Promise.reject(new Error("거절"))));
  assert.equal(builtinToolsRevision(), before);
  assert.equal(await notifyBuiltinTools(Promise.resolve("값")), "값");
  assert.equal(builtinToolsRevision(), before + 1, "성공한 요청만 알린다");
});

/**
 * QA #101 — 기본도구 접근 상세(`BuiltinToolAccess`)는 백엔드 카탈로그를 읽고, 그 카탈로그가
 * 세는 값은 `load_agent_builtin_tools`가 읽는 네 가지다: Cypress 사용 여부,
 * `list_agent_ssh_endpoints`, `list_agent_db_connections`,
 * `ExternalPluginRegistry::summary()`(사용 중 + 자격증명 준비 여부).
 *
 * QA #95는 그중 **사용 스위치** 넷만 알리게 했다. 같은 패널의 형제 변경 — 키 삭제로 접속
 * 서버가 함께 사라지는 것(C9-9), 연결 편집으로 `usable` 판정이 뒤집히는 것, 플러그인 등록·
 * 삭제·토큰 입력으로 "인증 대기"가 "붙는 플러그인"이 되는 것 — 은 같은 수를 바꾸면서도
 * 알리지 않아, 스위치를 켤 때 고쳤던 어긋남이 그대로 돌아왔다.
 *
 * 그래서 조건을 명령 이름으로 고정한다. 목록을 손으로 적는 것이 아니라 **카탈로그가 읽는
 * 값을 바꾸는가**로 갈린다 — 새 명령을 더하는 사람이 어느 쪽인지 여기서 한 번 정하게 된다.
 */
const NOTIFYING = {
  "src/lib/ipcCypress.ts": ["set_cypress_enabled"],
  "src/lib/ipcSshKeys.ts": ["set_ssh_key_endpoint", "delete_ssh_key"],
  "src/lib/ipcDbConnections.ts": [
    "set_db_connection", "set_db_connection_enabled", "remove_db_connection",
  ],
  "src/lib/ipcExternalPlugins.ts": [
    "register_external_plugin", "update_external_plugin", "remove_external_plugin",
    "set_external_plugin_enabled", "set_external_plugin_token",
    "cancel_external_plugin_oauth", "verify_external_plugin",
  ],
};

/** 카탈로그가 읽지 않는 값만 바꾸는 명령. 알리면 표를 헛되이 다시 읽는다. */
const SILENT = {
  "src/lib/ipcCypress.ts": [
    "get_cypress_registry", "add_cypress_workspace", "remove_cypress_workspace",
    "set_cypress_workspace_options", "run_cypress_spec",
  ],
  "src/lib/ipcSshKeys.ts": ["get_ssh_keys", "generate_ssh_key", "set_ssh_key_note", "check_ssh_endpoint"],
  "src/lib/ipcDbConnections.ts": ["get_db_connections", "check_db_connection"],
  "src/lib/ipcExternalPlugins.ts": [
    "get_external_plugins", "set_external_plugin_tool_policy",
    "set_external_plugin_tool_policies", "begin_external_plugin_oauth",
  ],
};

/** 한 명령을 내보내는 `export function` 한 덩어리. 다음 `export`나 파일 끝까지다. */
function commandBlock(source, command) {
  const at = source.indexOf(`"${command}"`);
  assert.notEqual(at, -1, `${command} 호출이 없다`);
  const from = source.lastIndexOf("\nexport function", at);
  assert.notEqual(from, -1, `${command}을 감싸는 export function이 없다`);
  const next = source.indexOf("\nexport ", at);
  return source.slice(from, next === -1 ? source.length : next);
}

for (const [path, commands] of Object.entries(NOTIFYING)) {
  test(`${path}: 카탈로그가 읽는 값을 바꾸는 명령은 성공 뒤 접근 상세를 다시 읽게 한다`, () => {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    for (const command of commands) {
      assert.ok(
        commandBlock(source, command).includes("notifyBuiltinTools"),
        `${command}은 notifyBuiltinTools로 감싸야 한다`,
      );
    }
  });

  test(`${path}: 카탈로그와 무관한 명령은 표를 다시 읽게 하지 않는다`, () => {
    const source = readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    for (const command of SILENT[path]) {
      assert.ok(
        !commandBlock(source, command).includes("notifyBuiltinTools"),
        `${command}은 카탈로그가 읽지 않는 값만 바꾼다`,
      );
    }
  });
}
