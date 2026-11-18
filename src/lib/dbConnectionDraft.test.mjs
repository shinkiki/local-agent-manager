import assert from "node:assert/strict";
import test from "node:test";
import { dbConnectionDraftOf, isDbConnectionDraftValid, toSetDbConnectionRequest } from "./dbConnectionDraft.ts";

const connection = Object.freeze({
  id: "db-1", displayName: "Reports", engine: "postgres", environment: "staging",
  host: "db.example.test", port: 5432, user: "reader", database: "analytics",
  credentialSource: "appKeychain", credentialRef: "", credentialStoredAt: 123,
  agentEnabled: true, writeMode: "dmlWithApproval", schemaScope: Object.freeze(["public", "reporting"]),
  maskedColumns: Object.freeze(["password", "token"]), maxRows: 500, note: "replica", updatedAt: 123,
});
const snapshot = Object.freeze({
  connections: Object.freeze([connection]),
  defaults: Object.freeze({ maxRows: 250, maskedColumns: Object.freeze(["password", "email"]) }),
});
const draft = (patch = {}) => ({ ...dbConnectionDraftOf(connection, snapshot), ...patch });

test("C10/V4 새 초안은 서버 기본값과 초기 조회 전 기본값을 보존한다", () => {
  assert.deepEqual(dbConnectionDraftOf(null, snapshot), {
    id: "", displayName: "", engine: "mariadb", environment: "dev", host: "", port: "3306",
    user: "", database: "", credentialSource: "clientFile", credentialRef: "", secret: "",
    writeMode: "readOnly", schemaScope: "", maskedColumns: "password\nemail", maxRows: "250", note: "",
  });
  assert.equal(dbConnectionDraftOf(null, null).maxRows, "200");
  assert.equal(dbConnectionDraftOf(null, null).maskedColumns, "");
});

test("C10/V4 기존 연결 초안은 숫자와 목록을 입력 문자열로 바꾸고 비밀번호 칸을 비운다", () => {
  assert.deepEqual(draft(), {
    id: "db-1", displayName: "Reports", engine: "postgres", environment: "staging",
    host: "db.example.test", port: "5432", user: "reader", database: "analytics",
    credentialSource: "appKeychain", credentialRef: "", secret: "", writeMode: "dmlWithApproval",
    schemaScope: "public\nreporting", maskedColumns: "password\ntoken", maxRows: "500", note: "replica",
  });
  assert.equal(dbConnectionDraftOf({ ...connection, engine: "sqlite", port: 0 }, snapshot).port, "");
});

test("C10/V4 필수값은 엔진·자격증명 출처에 따라 검사하고 공백을 빈 입력으로 본다", () => {
  for (const engine of ["mysql", "mariadb", "postgres", "sqlite"]) {
    const valid = draft({ engine, credentialSource: "clientFile", credentialRef: "login" });
    assert.equal(isDbConnectionDraftValid(valid), true);
    for (const field of ["displayName", "database", ...(engine === "sqlite" ? [] : ["host", "user"])]) {
      assert.equal(isDbConnectionDraftValid({ ...valid, [field]: " \t " }), false, `${engine}:${field}`);
    }
    for (const credentialSource of ["clientFile", "appKeychain", "none"]) {
      assert.equal(isDbConnectionDraftValid({ ...valid, credentialSource, credentialRef: " " }),
        credentialSource !== "clientFile" || engine === "postgres" || engine === "sqlite");
    }
  }
  assert.equal(isDbConnectionDraftValid(draft({ engine: "sqlite", host: "", user: "" })), true);
});

test("C10/V4 저장 요청은 문자열·목록을 정리하고 기존 에이전트 사용과 빈 비밀번호를 보존한다", () => {
  const input = Object.freeze(draft({ displayName: " Reports ", host: " db.example.test ", user: " reader ",
    database: " analytics ", port: " 5432 ", maxRows: " 500 ", schemaScope: " public \n \n reporting \r\n",
    maskedColumns: " password\n token \n", note: " replica " }));
  assert.deepEqual(toSetDbConnectionRequest(input, snapshot), {
    id: "db-1", displayName: "Reports", engine: "postgres", environment: "staging",
    host: "db.example.test", port: 5432, user: "reader", database: "analytics",
    credentialSource: "appKeychain", credentialRef: "", secret: null, agentEnabled: true,
    writeMode: "dmlWithApproval", schemaScope: ["public", "reporting"],
    maskedColumns: ["password", "token"], maxRows: 500, note: "replica",
  });
  assert.equal(toSetDbConnectionRequest(draft({ secret: "fixture-password" }), snapshot).secret, "fixture-password");
  for (const credentialSource of ["clientFile", "none"]) {
    const request = toSetDbConnectionRequest(draft({ credentialSource, credentialRef: " login ", secret: "fixture" }), snapshot);
    assert.equal(request.secret, null);
    assert.equal(request.credentialRef, credentialSource === "clientFile" ? "login" : "");
  }
});

test("C10/V4 파일 엔진·운영 잠금·숫자 변환과 신규 연결 기본값은 기존 요청 형태를 유지한다", () => {
  const request = toSetDbConnectionRequest(draft({ id: "new", engine: "sqlite", environment: "production",
    writeMode: "ddlWithApproval", port: "3306", maxRows: "invalid" }), snapshot);
  assert.equal(request.host, "");
  assert.equal(request.port, null);
  assert.equal(request.user, "");
  assert.equal(request.writeMode, "readOnly");
  assert.equal(request.maxRows, null);
  assert.equal(request.agentEnabled, false);
  assert.equal(toSetDbConnectionRequest(draft(), null).agentEnabled, false);
  for (const value of ["", " ", "invalid"]) {
    const parsed = toSetDbConnectionRequest(draft({ port: value, maxRows: value }), snapshot);
    assert.equal(parsed.port, null);
    assert.equal(parsed.maxRows, null);
  }
  const parsed = toSetDbConnectionRequest(draft({ port: "123tail", maxRows: "9000" }), snapshot);
  assert.equal(parsed.port, 123);
  assert.equal(parsed.maxRows, 9000); // 상한 검사는 기존대로 백엔드가 소유한다.
});
