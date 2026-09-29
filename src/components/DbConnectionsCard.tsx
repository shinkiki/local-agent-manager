import { Database, LoaderCircle, Plus, PlugZap, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type PropsWithChildren } from "react";
import { checkDbConnection, getDbConnections, getWebAccessStatus, hasTauriRuntime, removeDbConnection, setDbConnection, setDbConnectionEnabled, type WebAccessStatus } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { DbConnectionCheckReceipt, DbConnectionsSnapshot, DbConnectionView, DbCredentialSource, DbEngineKind, DbEnvironment, DbWriteMode } from "../types";
import { ErrorBanner, useBusyAction, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";

/** 엔진마다 기본 포트가 다르다. 백엔드도 같은 값을 쓰므로 한쪽만 고치지 않는다. */
const DEFAULT_PORTS: Record<DbEngineKind, string> = { mysql: "3306", mariadb: "3306", postgres: "5432", sqlite: "" };

const ENGINE_LABELS: Record<DbEngineKind, string> = { mysql: "MySQL", mariadb: "MariaDB", postgres: "PostgreSQL", sqlite: "SQLite" };

/** 환경·쓰기 모드의 한국어 이름. 목록 배지와 편집기 선택지가 같은 표를 본다. */
const ENVIRONMENT_LABELS_KO: Record<DbEnvironment, string> = { local: "로컬", dev: "개발", staging: "스테이징", production: "운영" };

const WRITE_MODE_LABELS_KO: Record<DbWriteMode, string> = { readOnly: "읽기 전용", dmlWithApproval: "변경 승인", ddlWithApproval: "구조 변경 승인" };

/** 편집기의 쓰기 모드 선택지. 배지와 같은 이름에 허용 범위를 덧붙인다. */
const WRITE_MODE_OPTIONS: { value: DbWriteMode; ko: string; en: string }[] = [
  { value: "readOnly", ko: WRITE_MODE_LABELS_KO.readOnly, en: "Read only" },
  { value: "dmlWithApproval", ko: `${WRITE_MODE_LABELS_KO.dmlWithApproval} (INSERT·UPDATE·DELETE)`, en: "Data changes with approval" },
  { value: "ddlWithApproval", ko: `${WRITE_MODE_LABELS_KO.ddlWithApproval} (CREATE·ALTER)`, en: "Schema changes with approval" },
];

/** 파일 하나로 끝나는 엔진은 호스트·포트·사용자가 없다. */
function isFileEngine(engine: DbEngineKind): boolean {
  return engine === "sqlite";
}

/** MySQL 계열만 ~/.mylogin.cnf의 로그인 경로 이름을 참조로 쓴다. */
function usesLoginPath(engine: DbEngineKind): boolean {
  return engine === "mysql" || engine === "mariadb";
}

/**
 * select가 돌려주는 값은 늘 넓은 문자열이다. 선택지는 모두 위 표나 백엔드 기본값에서
 * 그대로 나오므로 되돌려 놓을 이름은 이미 정해져 있고, 좁히는 자리를 이 한 곳으로
 * 모아 두면 초안이 넓은 문자열로 되돌아가는 틈이 생기지 않는다.
 */
function chosen<T extends string>(event: ChangeEvent<HTMLSelectElement>): T {
  return event.target.value as T;
}

interface Draft {
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

function draftOf(connection: DbConnectionView | null, snapshot: DbConnectionsSnapshot | null): Draft {
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

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** 편집기의 한 칸. 이름표와 보조 설명 자리가 모든 칸에서 같다. */
function DraftField({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string | false }>) {
  return <label><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

/** 초안의 문자열 칸 하나. rows를 주면 여러 줄 입력이 된다. */
function DraftTextField({ label, value, onChange, hint, rows, type, maxLength, inputMode, placeholder, autoComplete }: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  rows?: number;
  type?: "password";
  maxLength?: number;
  inputMode?: "numeric";
  placeholder?: string;
  autoComplete?: string;
}) {
  const change = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value);
  return (
    <DraftField label={label} hint={hint}>
      {rows === undefined
        ? <input type={type} value={value} maxLength={maxLength} inputMode={inputMode} placeholder={placeholder} autoComplete={autoComplete} onChange={change} />
        : <textarea rows={rows} value={value} onChange={change} />}
    </DraftField>
  );
}

/** 저장을 걸 수 있는 최소 조건. 백엔드가 다시 검사하지만, 눌러 봐야 아는 실패는 줄인다. */
function isValid(draft: Draft): boolean {
  if (!draft.displayName.trim() || !draft.database.trim()) return false;
  if (isFileEngine(draft.engine)) return true;
  if (!draft.host.trim() || !draft.user.trim()) return false;
  if (draft.credentialSource === "clientFile" && usesLoginPath(draft.engine) && !draft.credentialRef.trim()) return false;
  return true;
}

/** 목록의 연결 한 줄. 배지·접속 대상·자격증명 요약과 네 가지 동작이 여기서 끝난다. */
function DbConnectionRow({ connection, receipt, busy, canWrite, canManage, onToggle, onCheck, onEdit, onRemove }: {
  connection: DbConnectionView;
  receipt: DbConnectionCheckReceipt | null;
  busy: string | null;
  canWrite: boolean;
  canManage: boolean;
  onToggle: () => void;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { text } = useI18n();
  return (
  <article className="db-connection-row" data-environment={connection.environment}>
    <div className="db-connection-head">
      <strong>{connection.displayName}</strong>
      <span className="db-badge">{ENGINE_LABELS[connection.engine] ?? connection.engine}</span>
      <span className={`db-badge db-badge-${connection.environment}`}>{text(ENVIRONMENT_LABELS_KO[connection.environment], connection.environment)}</span>
      <span className="db-badge">{text(WRITE_MODE_LABELS_KO[connection.writeMode], connection.writeMode)}</span>
    </div>
    <code className="db-connection-target">{isFileEngine(connection.engine)
      ? connection.database
      : `${connection.user}@${connection.host}:${connection.port}/${connection.database}`}</code>
    <small className="db-connection-meta">
      {connection.credentialSource === "appKeychain"
        ? text(connection.credentialStoredAt ? "앱 보관 비밀번호 저장됨" : "앱 보관 — 비밀번호 미저장", connection.credentialStoredAt ? "Stored in app keychain" : "App keychain — no password yet")
        : connection.credentialSource === "clientFile"
          ? text(`클라이언트 파일 참조${connection.credentialRef ? ` (${connection.credentialRef})` : ""}`, `Client credential file${connection.credentialRef ? ` (${connection.credentialRef})` : ""}`)
          : text("비밀번호 없음", "No password")}
      {connection.schemaScope.length > 0 && ` · ${text("범위", "Scope")} ${connection.schemaScope.join(", ")}`}
      {` · ${text("최대", "Max")} ${connection.maxRows}${text("행", " rows")}`}
    </small>
    <div className="db-connection-actions">
      <label className="db-connection-toggle">
        <input
          type="checkbox"
          checked={connection.agentEnabled}
          disabled={!canWrite || busy !== null}
          onChange={() => onToggle()}
        />
        <span>{text("에이전트 사용", "Agent use")}</span>
      </label>
      <button className="button compact" type="button" disabled={!canWrite || busy !== null} onClick={() => onCheck()}><PlugZap size={13} />{text("연결 확인", "Check")}</button>
      <button className="button compact" type="button" disabled={!canManage || busy !== null} onClick={() => onEdit()}>{text("편집", "Edit")}</button>
      <button className="button compact danger" type="button" disabled={!canManage || busy !== null} onClick={() => onRemove()}><Trash2 size={13} />{text("삭제", "Remove")}</button>
    </div>
    {receipt?.id === connection.id && (
      <p className={`db-connection-receipt${receipt.reachable ? " ok" : " failed"}`}>
        {receipt.reachable
          ? `${text("접속 성공", "Connected")} — ${receipt.serverVersion}`
          : receipt.message}
      </p>
    )}
  </article>
  );
}

/**
 * 연결 하나를 만들거나 고치는 편집기. 어떤 칸이 서는지는 엔진과 자격증명 출처가 정한다 —
 * 파일 엔진은 호스트·사용자·자격증명이 없고, 운영 환경은 쓰기 모드를 잠근다.
 */
function DbConnectionEditor({ draft, snapshot, busy, canManage, patchDraft, onCancel, onSave }: {
  draft: Draft;
  snapshot: DbConnectionsSnapshot;
  busy: string | null;
  canManage: boolean;
  patchDraft: (patch: Partial<Draft>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { text } = useI18n();
  const fileEngine = isFileEngine(draft.engine);
  /** 운영으로 표시한 연결은 쓰기 모드를 고르지 못한다. */
  const production = draft.environment === "production";
  return (
    <div className="db-connection-editor">
      <DraftTextField label={text("이름", "Name")} value={draft.displayName} maxLength={60} onChange={(displayName) => patchDraft({ displayName })} />
      <DraftField label={text("엔진", "Engine")}>
        <select value={draft.engine} onChange={(event) => {
          const engine = chosen<DbEngineKind>(event);
          patchDraft({
            engine,
            port: DEFAULT_PORTS[engine] ?? draft.port,
            // QA #71·#72. 파일 엔진은 자격증명이 없다. 남겨 두면 PostgreSQL용
            // ~/.pgpass 안내가 서고, 저장하면 백엔드가 거절한다.
            credentialSource: isFileEngine(engine) ? "none" : draft.credentialSource,
          });
        }}>
          {snapshot.defaults.engines.map((engine) => <option key={engine} value={engine}>{ENGINE_LABELS[engine] ?? engine}</option>)}
        </select>
      </DraftField>
      <DraftField label={text("환경", "Environment")}>
        <select value={draft.environment} onChange={(event) => {
          const environment = chosen<DbEnvironment>(event);
          patchDraft({ environment, writeMode: environment === "production" ? "readOnly" : draft.writeMode });
        }}>
          {snapshot.defaults.environments.map((value) => <option key={value} value={value}>{text(ENVIRONMENT_LABELS_KO[value] ?? value, value)}</option>)}
        </select>
      </DraftField>
      {!fileEngine && <>
        <DraftTextField label={text("호스트", "Host")} value={draft.host} onChange={(host) => patchDraft({ host })} />
        <DraftTextField label={text("포트", "Port")} value={draft.port} inputMode="numeric" onChange={(port) => patchDraft({ port })} />
        <DraftTextField label={text("사용자", "User")} value={draft.user} onChange={(user) => patchDraft({ user })} />
      </>}
      <DraftTextField
        label={fileEngine ? text("파일 경로", "File path") : text("데이터베이스", "Database")}
        value={draft.database}
        onChange={(database) => patchDraft({ database })}
      />
      {fileEngine
        ? <p className="db-connection-hint">{text(
          "파일 기반 엔진은 자격증명을 쓰지 않습니다. 파일 경로와 그 파일의 접근 권한이 전부입니다.",
          "File-based engines take no credential. The file path and its permissions are all there is.",
        )}</p>
        : <DraftField label={text("자격증명", "Credential")}>
          <select value={draft.credentialSource} onChange={(event) => patchDraft({ credentialSource: chosen<DbCredentialSource>(event) })}>
            <option value="clientFile">{text("클라이언트 파일 참조", "Client credential file")}</option>
            <option value="appKeychain">{text("앱이 보관", "Stored by the app")}</option>
            <option value="none">{text("없음", "None")}</option>
          </select>
        </DraftField>}
      {!fileEngine && draft.credentialSource === "clientFile" && (
        usesLoginPath(draft.engine)
          ? <DraftTextField
            label={text("로그인 경로", "Login path")}
            value={draft.credentialRef}
            placeholder="kbfps-dev"
            onChange={(credentialRef) => patchDraft({ credentialRef })}
            hint={text("~/.mylogin.cnf에 등록된 이름입니다. 접속할 때마다 읽고 앱에 저장하지 않습니다.", "A name registered in ~/.mylogin.cnf. Read at connect time and never copied into the app.")}
          />
          : <p className="db-connection-hint">{text("~/.pgpass에서 호스트·포트·데이터베이스·사용자가 맞는 줄을 접속할 때마다 읽습니다.", "The matching ~/.pgpass line is read at connect time.")}</p>
      )}
      {!fileEngine && draft.credentialSource === "appKeychain" && (
        <DraftTextField
          label={text("비밀번호", "Password")}
          type="password"
          value={draft.secret}
          autoComplete="new-password"
          placeholder={snapshot.connections.find((entry) => entry.id === draft.id)?.credentialStoredAt ? text("저장됨 — 바꿀 때만 입력", "Stored — type only to replace") : ""}
          onChange={(secret) => patchDraft({ secret })}
          hint={text("OS 보안 저장소에만 저장되고 화면으로 다시 나오지 않습니다.", "Kept in the OS secure store and never returned to the UI.")}
        />
      )}
      <DraftField label={text("쓰기 모드", "Write mode")} hint={production && text("운영으로 표시한 연결에는 쓰기 모드를 설정할 수 없습니다.", "Connections marked production cannot take a write mode.")}>
        <select value={draft.writeMode} disabled={production} onChange={(event) => patchDraft({ writeMode: chosen<DbWriteMode>(event) })}>
          {WRITE_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{text(option.ko, option.en)}</option>)}
        </select>
      </DraftField>
      <DraftTextField label={text("스키마 범위", "Schema scope")} rows={3} value={draft.schemaScope} onChange={(schemaScope) => patchDraft({ schemaScope })} hint={text("한 줄에 하나. 비우면 제한하지 않습니다. 참조하는 테이블 이름의 앞머리로 봅니다.", "One per line; empty means no restriction. Matched as a prefix of referenced table names.")} />
      <DraftTextField label={text("마스킹 컬럼", "Masked columns")} rows={3} value={draft.maskedColumns} onChange={(maskedColumns) => patchDraft({ maskedColumns })} hint={text("이 이름이 들어간 컬럼의 값은 조회 결과에서 가려집니다.", "Values of columns containing these names are hidden in results.")} />
      <DraftTextField label={text("최대 행", "Max rows")} value={draft.maxRows} inputMode="numeric" onChange={(maxRows) => patchDraft({ maxRows })} hint={text(`천장은 ${snapshot.defaults.maxRowsCeiling}행입니다.`, `The ceiling is ${snapshot.defaults.maxRowsCeiling} rows.`)} />
      <DraftTextField label={text("메모", "Note")} value={draft.note} maxLength={200} onChange={(note) => patchDraft({ note })} />
      <div className="db-connection-editor-actions">
        <button className="button compact" type="button" onClick={() => onCancel()}>{text("취소", "Cancel")}</button>
        <button className="button compact primary" type="button" disabled={!canManage || !isValid(draft) || busy !== null} onClick={() => onSave()}>{text("저장", "Save")}</button>
      </div>
    </div>
  );
}


/**
 * 애드온의 데이터베이스 탭. 연결을 등록하고 에이전트에게 열어 주는 자리다.
 *
 * SSH 카드와 나뉘는 자리가 하나 있다 — 여기서는 비밀번호가 오갈 수 있다. 그래서 등록·
 * 삭제는 호스트 전용이고(원격 편집이 켜져 있어도 잠긴다), 에이전트 사용 토글과 연결
 * 확인만 원격에서 열린다. 저장된 비밀번호는 어느 응답으로도 돌아오지 않으므로 입력칸은
 * 언제나 비어 있고, 저장돼 있다는 사실만 표시한다.
 */
export function DbConnectionsCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [snapshot, setSnapshot] = useState<DbConnectionsSnapshot | null>(null);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const { busy, error, setError, run: runAction } = useBusyAction();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(draftOf(null, null));
  const [receipt, setReceipt] = useState<DbConnectionCheckReceipt | null>(null);
  const loadedRef = useRef(false);
  const canWrite = access?.writable === true;
  const isRemote = !hasTauriRuntime() && access?.remote === true;
  /** 등록·삭제·비밀번호 입력은 호스트 화면 전용이다(C10-5). */
  const canManage = canWrite && !isRemote;
  const fileEngine = isFileEngine(draft.engine);
  const patchDraft = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const load = useCallback(async () => {
    try {
      const next = await getDbConnections();
      setSnapshot(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!active) { loadedRef.current = false; return; }
    if (loadedRef.current) return;
    loadedRef.current = true;
    void Promise.all([load(), getWebAccessStatus().then(setAccess)])
      .catch((cause: unknown) => setError(errorText(cause)));
  }, [active, load]);

  // 이 카드는 한 번에 하나만 돌린다. 봉투 자체는 공용이고, 무엇을 막을지만 여기서 정한다.
  const run = async (token: string, action: () => Promise<void>) => {
    if (busy !== null) return;
    await runAction(token, action);
  };

  const openEditor = (connection: DbConnectionView | null) => {
    setEditing(connection ? connection.id : "new");
    setDraft(draftOf(connection, snapshot));
    setReceipt(null);
  };

  const save = () => run("save", async () => {
    const port = Number.parseInt(draft.port.trim(), 10);
    const maxRows = Number.parseInt(draft.maxRows.trim(), 10);
    const next = await setDbConnection({
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
      schemaScope: lines(draft.schemaScope),
      maskedColumns: lines(draft.maskedColumns),
      maxRows: Number.isInteger(maxRows) ? maxRows : null,
      note: draft.note.trim(),
    });
    setSnapshot(next);
    setEditing(null);
  });

  const toggle = (connection: DbConnectionView) => run(`toggle:${connection.id}`, async () => {
    setSnapshot(await setDbConnectionEnabled({ id: connection.id, enabled: !connection.agentEnabled }));
  });

  const check = (connection: DbConnectionView) => run(`check:${connection.id}`, async () => {
    setReceipt(await checkDbConnection({ id: connection.id }));
  });

  const remove = (connection: DbConnectionView) => run(`remove:${connection.id}`, async () => {
    const ok = await confirm({
      title: text("연결을 삭제할까요?", "Remove this connection?"),
      message: text(
        `${connection.displayName} 등록과 이 기기에 저장된 비밀번호를 함께 지웁니다. 데이터베이스 자체는 바뀌지 않습니다.`,
        `Removes ${connection.displayName} and any password stored on this device. The database itself is unchanged.`,
      ),
      warning: text("이 기기에 저장된 비밀번호는 되돌릴 수 없습니다.", "A password stored on this device cannot be restored."),
      confirmLabel: text("삭제", "Remove"),
      // QA #73. 되돌릴 수 없는 삭제라 SshKeysCard와 같은 파괴적 동작 톤으로 세운다.
      tone: "danger",
    });
    if (!ok) return;
    setSnapshot(await removeDbConnection({ id: connection.id }));
    if (editing === connection.id) setEditing(null);
  });

  return (
    <section className="settings-card db-connections-card" data-ui-anchor="addons.db-content">
      <header>
        <div className="plugin-page-title">
          <i><Database size={18} aria-hidden="true" /></i>
          <div><span>{text("데이터베이스", "Database")}</span><h2>{text("연결 관리", "Connections")}</h2></div>
        </div>
        <p>{text(
          "등록한 데이터베이스에 에이전트가 직접 조회하고, 승인을 받아 변경할 수 있습니다. 비밀번호는 에이전트에게 넘어가지 않고 앱이 대신 접속합니다. 조회는 엔진 수준 읽기 전용 트랜잭션에서 돌고, 변경은 실행 전에 바뀔 행 수를 세어 승인 카드에 싣습니다.",
          "Agents can query registered databases and change data after approval. Passwords never reach the agent — the app connects on its behalf. Reads run inside an engine-level read-only transaction; writes are previewed for affected rows before the approval card.",
        )}</p>
      </header>
      {isRemote && (
        <div className="plugin-host-notice" role="note">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            <strong>{text("연결 등록은 호스트 화면에서만 합니다", "Connections are registered on the host")}</strong>
            <small>{text(
              "비밀번호를 받는 자리라 등록·수정·삭제는 원격에서 열지 않습니다. 원격에서는 목록 확인과 에이전트 사용 토글, 연결 확인만 할 수 있습니다.",
              "Registration, editing and removal stay on the host because they accept passwords. From remote you can read the list, toggle agent use, and check a connection.",
            )}</small>
          </span>
        </div>
      )}
      {error && <ErrorBanner message={error} />}
      {snapshot === null
        ? <div className="plugin-loading-state">{!error && <LoaderCircle size={16} className="spin" />}<span>{text("연결을 확인하는 중…", "Checking connections…")}</span></div>
        : <>
          <div className="ssh-key-location">
            <span><strong>{text("등록된 연결", "Registered")}</strong><code>{snapshot.connections.length}</code></span>
            <button className="button compact" type="button" disabled={busy !== null} onClick={() => void load()}><RefreshCw size={13} />{text("새로고침", "Refresh")}</button>
          </div>
          {snapshot.connections.length === 0
            ? <div className="plugin-empty-state"><i><Database size={25} /></i><div><strong>{text("등록된 연결이 없습니다", "No connections yet")}</strong><small>{text("연결을 등록하고 에이전트 사용을 켜야 에이전트가 조회할 수 있습니다.", "Register a connection and turn on agent use before an agent can query it.")}</small></div></div>
            : <div className="plugin-list db-connection-list">
              {snapshot.connections.map((connection) => (
                <DbConnectionRow
                  key={connection.id}
                  connection={connection}
                  receipt={receipt}
                  busy={busy}
                  canWrite={canWrite}
                  canManage={canManage}
                  onToggle={() => void toggle(connection)}
                  onCheck={() => void check(connection)}
                  onEdit={() => openEditor(connection)}
                  onRemove={() => void remove(connection)}
                />
              ))}
            </div>}
          {snapshot.issues.map((issue) => <p key={issue} className="db-connection-receipt failed">{issue}</p>)}
          {editing === null
            ? <div className="settings-update-body">
              <span className="settings-update-status"><strong>{text("새 연결", "New connection")}</strong><small>{canManage
                ? text("호스트·스키마와 자격증명 출처를 정하고, 무엇까지 허용할지 함께 정합니다.", "Set the host, schema and credential source, and decide how far an agent may go.")
                : text("연결 등록은 호스트 화면에서만 할 수 있습니다.", "Connections can only be registered on the host.")}</small></span>
              <button className="button compact primary" type="button" data-ui-anchor="addons.db.add" disabled={!canManage} onClick={() => openEditor(null)}><Plus size={13} />{text("연결 추가", "Add connection")}</button>
            </div>
            : <DbConnectionEditor
              draft={draft}
              snapshot={snapshot}
              busy={busy}
              canManage={canManage}
              patchDraft={patchDraft}
              onCancel={() => setEditing(null)}
              onSave={() => void save()}
            />}
        </>}
      {confirmDialog}
    </section>
  );
}
