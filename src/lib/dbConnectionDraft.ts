import type {
  DbConnectionsSnapshot,
  DbConnectionView,
  DbCredentialSource,
  DbEngineKind,
  DbEnvironment,
  DbWriteMode,
  SetDbConnectionRequest,
} from "../types";

/** 엔진마다 기본 포트가 다르다. 백엔드도 같은 값을 쓰므로 한쪽만 고치지 않는다. */
export const DEFAULT_PORTS: Record<DbEngineKind, string> = {
  mysql: "3306",
  mariadb: "3306",
  postgres: "5432",
  sqlite: "",
};

/** 파일 하나로 끝나는 엔진은 호스트·포트·사용자가 없다. */
export function isFileEngine(engine: DbEngineKind): boolean {
  return engine === "sqlite";
}

/** MySQL 계열만 ~/.mylogin.cnf의 로그인 경로 이름을 참조로 쓴다. */
export function usesLoginPath(engine: DbEngineKind): boolean {
  return engine === "mysql" || engine === "mariadb";
}

export interface DbConnectionDraft {
  id: string;
  displayName: string;
  engine: DbEngineKind;
  environment: DbEnvironment;
  host: string;
  port: string;
  user: string;
  database: string;
  credentialSource: DbCredentialSource;
  credentialRef: string;
  secret: string;
  writeMode: DbWriteMode;
  schemaScope: string;
  maskedColumns: string;
  maxRows: string;
  note: string;
}

export function dbConnectionDraftOf(
  connection: DbConnectionView | null,
  snapshot: Pick<DbConnectionsSnapshot, "defaults"> | null,
): DbConnectionDraft {
  if (connection) {
    return {
      id: connection.id,
      displayName: connection.displayName,
      engine: connection.engine,
      environment: connection.environment,
      host: connection.host,
      port: connection.port ? String(connection.port) : "",
      user: connection.user,
      database: connection.database,
      credentialSource: connection.credentialSource,
      credentialRef: connection.credentialRef,
      secret: "",
      writeMode: connection.writeMode,
      schemaScope: connection.schemaScope.join("\n"),
      maskedColumns: connection.maskedColumns.join("\n"),
      maxRows: String(connection.maxRows),
      note: connection.note,
    };
  }
  return {
    id: "",
    displayName: "",
    engine: "mariadb",
    environment: "dev",
    host: "",
    port: DEFAULT_PORTS.mariadb,
    user: "",
    database: "",
    credentialSource: "clientFile",
    credentialRef: "",
    secret: "",
    writeMode: "readOnly",
    schemaScope: "",
    // 개인정보가 조회 결과로 흘러나가는 흔한 자리를 미리 채워 둔다. 목록은 백엔드가 소유한다.
    maskedColumns: (snapshot?.defaults.maskedColumns ?? []).join("\n"),
    maxRows: String(snapshot?.defaults.maxRows ?? 200),
    note: "",
  };
}

export function dbConnectionLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** 저장을 걸 수 있는 최소 조건. 백엔드가 다시 검사하지만, 눌러 봐야 아는 실패는 줄인다. */
export function isDbConnectionDraftValid(draft: DbConnectionDraft): boolean {
  if (!draft.displayName.trim() || !draft.database.trim()) return false;
  if (isFileEngine(draft.engine)) return true;
  if (!draft.host.trim() || !draft.user.trim()) return false;
  if (draft.credentialSource === "clientFile" && usesLoginPath(draft.engine) && !draft.credentialRef.trim()) return false;
  return true;
}

export function toSetDbConnectionRequest(
  draft: DbConnectionDraft,
  snapshot: Pick<DbConnectionsSnapshot, "connections"> | null,
): SetDbConnectionRequest {
  const fileEngine = isFileEngine(draft.engine);
  const port = Number.parseInt(draft.port.trim(), 10);
  const maxRows = Number.parseInt(draft.maxRows.trim(), 10);
  return {
    id: draft.id,
    displayName: draft.displayName.trim(),
    engine: draft.engine,
    environment: draft.environment,
    host: fileEngine ? "" : draft.host.trim(),
    port: fileEngine || !Number.isInteger(port) ? null : port,
    user: fileEngine ? "" : draft.user.trim(),
    database: draft.database.trim(),
    credentialSource: draft.credentialSource,
    credentialRef: draft.credentialSource === "clientFile" ? draft.credentialRef.trim() : "",
    // 빈 칸은 "바꾸지 않음"이다. 저장된 비밀번호는 화면으로 돌아오지 않으므로 매번
    // 다시 입력하게 만들면 편집이 곧 재입력이 된다.
    secret: draft.credentialSource === "appKeychain" && draft.secret.length > 0 ? draft.secret : null,
    agentEnabled: snapshot?.connections.find((entry) => entry.id === draft.id)?.agentEnabled ?? false,
    writeMode: draft.environment === "production" ? "readOnly" : draft.writeMode,
    schemaScope: dbConnectionLines(draft.schemaScope),
    maskedColumns: dbConnectionLines(draft.maskedColumns),
    maxRows: Number.isInteger(maxRows) ? maxRows : null,
    note: draft.note.trim(),
  };
}
