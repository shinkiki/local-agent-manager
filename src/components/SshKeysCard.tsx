import { Bot, Eye, KeyRound, LoaderCircle, NotebookPen, Plus, PlugZap, RefreshCw, RotateCcw, Server, ShieldCheck, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { checkSshEndpoint, deleteSshKey, generateSshKey, getSshKeys, getWebAccessStatus, hasTauriRuntime, readSshPublicKey, setSshKeyEndpoint, setSshKeyNote, type WebAccessStatus } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { SshCommandPolicyDefaults, SshEndpointCheckReceipt, SshEndpointView, SshKeysSnapshot, SshKeyView, SshPublicKeyView } from "../types";
import { CopyAction } from "./CopyAction";
import { ErrorBanner, Modal, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";

const DEFAULT_FILE_NAME = "id_agent_manager";
const DEFAULT_COMMENT = "agent-manager";
const MAX_NOTE_CHARS = 300;
/** 설명(주석)의 한도. 생성 버튼의 비활성 조건과 입력 한도가 같은 값을 봐야 한다. */
const MAX_COMMENT_CHARS = 120;
const DEFAULT_SSH_PORT = "22";

/**
 * 저장된 연결 서버를 편집 상자의 입력값으로 편다. 아직 저장본이 없으면 22번 포트와
 * 백엔드가 준 기본 명령 정책을 채워, 처음 만드는 서버도 빈 정책으로 열리지 않게 한다.
 */
function endpointDraftOf(endpoint: SshEndpointView | null, defaults: SshCommandPolicyDefaults | null): EndpointDraft {
  return {
    host: endpoint?.host ?? "",
    port: endpoint ? String(endpoint.port) : DEFAULT_SSH_PORT,
    user: endpoint?.user ?? "",
    agentEnabled: endpoint?.agentEnabled ?? false,
    allowed: (endpoint ? endpoint.allowedCommands : defaults?.allowed ?? []).join("\n"),
    denied: (endpoint ? endpoint.deniedCommands : defaults?.denied ?? []).join("\n"),
  };
}

/** 여러 줄 입력을 규칙 목록으로 바꾼다. 백엔드와 같은 규칙으로 빈 줄과 공백을 접는다. */
function commandLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

/** 저장본과 같은 값인지. 같으면 저장 버튼을 잠그고, 연결 확인은 저장본으로만 돌린다. */
function sameEndpoint(draft: EndpointDraft, endpoint: SshEndpointView | null): boolean {
  const saved = endpointDraftOf(endpoint, null);
  return draft.host.trim() === saved.host
    && draft.port.trim() === saved.port
    && draft.user.trim() === saved.user
    && draft.agentEnabled === saved.agentEnabled
    && commandLines(draft.allowed).join("\n") === commandLines(saved.allowed).join("\n")
    && commandLines(draft.denied).join("\n") === commandLines(saved.denied).join("\n");
}

interface EndpointDraft {
  host: string;
  port: string;
  user: string;
  agentEnabled: boolean;
  allowed: string;
  denied: string;
}

/**
 * 로컬 ~/.ssh 공개키의 메타데이터만 보여 주고, 새 Ed25519 키를 충돌 없이 생성한다.
 * 공개키 본문 확인·키 삭제·기기 단위 메모·키별 연결 서버까지 여기서 하며, 개인키는 어떤
 * 경로로도 열지 않는다 — 삭제도 ~/.ssh 안 휴지통으로 옮기는 것이라 되돌릴 수 있다.
 *
 * 2026-09-03 결정으로 이 카드에는 호스트 전용 작업이 없다(C9-5/C9-10). 생성은 검증된 새
 * 경로에만 만들고 삭제는 휴지통으로 옮기는 것이라 되돌릴 수 있어, 원격 편집이 켜져 있으면
 * 전부 호스트와 같이 동작한다. 고급 설정의 명령 목록은 그 서버에서 무엇까지 하게 할지에
 * 대한 사용자 결정이고, 스킬이 에이전트에게 지켜야 할 규칙으로 전달한다.
 */
export function SshKeysCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [snapshot, setSnapshot] = useState<SshKeysSnapshot | null>(null);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [fileName, setFileName] = useState(DEFAULT_FILE_NAME);
  const [comment, setComment] = useState(DEFAULT_COMMENT);
  const [revealed, setRevealed] = useState<SshPublicKeyView | null>(null);
  const [noteTarget, setNoteTarget] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [endpointTarget, setEndpointTarget] = useState<string | null>(null);
  const [endpointDraft, setEndpointDraft] = useState<EndpointDraft>(endpointDraftOf(null, null));
  const [checkReceipt, setCheckReceipt] = useState<SshEndpointCheckReceipt | null>(null);
  const loadedRef = useRef(false);
  const canWrite = access?.writable === true;
  const isRemote = !hasTauriRuntime() && access?.remote === true;

  const load = useCallback(async () => {
    try {
      const next = await getSshKeys();
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

  /** 한 번에 한 동작만 돌리고, 실패 문구는 배너 한 곳에 모은다. */
  const run = async (token: string, action: () => Promise<void>) => {
    if (busy !== null) return;
    setBusy(token);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const create = () => run("create", async () => {
    await generateSshKey({ fileName: fileName.trim(), comment: comment.trim() });
    await load();
    setAdding(false);
    setFileName(DEFAULT_FILE_NAME);
    setComment(DEFAULT_COMMENT);
  });

  const reveal = (key: SshKeyView) => run(`reveal:${key.fingerprint}`, async () => {
    setRevealed(await readSshPublicKey({ fileName: key.fileName, fingerprint: key.fingerprint }));
  });

  const saveNote = (key: SshKeyView) => run(`note:${key.fingerprint}`, async () => {
    setSnapshot(await setSshKeyNote({ fingerprint: key.fingerprint, note: noteDraft.trim() }));
    setNoteTarget(null);
    setNoteDraft("");
  });

  /** 연결 서버 편집을 연다. 메모와 동시에 열면 줄이 겹치므로 한 번에 하나만 편다. */
  const openEndpoint = (key: SshKeyView) => {
    const editing = endpointTarget === key.fingerprint;
    setEndpointTarget(editing ? null : key.fingerprint);
    setEndpointDraft(endpointDraftOf(key.endpoint, snapshot?.commandPolicyDefaults ?? null));
    setCheckReceipt(null);
    if (!editing) setNoteTarget(null);
  };

  /** 저장은 앱 데이터만 바꾼다. 응답으로 온 저장본을 다시 입력값에 펴서, 화면의 값과
   *  저장된 값이 어긋난 채 "연결 확인"이 열리는 일이 없게 한다. */
  const saveEndpoint = (key: SshKeyView, clear = false) => run(`endpoint:${key.fingerprint}`, async () => {
    const port = Number.parseInt(endpointDraft.port.trim(), 10);
    const next = await setSshKeyEndpoint({
      fingerprint: key.fingerprint,
      host: clear ? "" : endpointDraft.host.trim(),
      port: clear || !Number.isInteger(port) ? null : port,
      user: clear ? "" : endpointDraft.user.trim(),
      agentEnabled: clear ? false : endpointDraft.agentEnabled,
      allowedCommands: clear ? [] : commandLines(endpointDraft.allowed),
      deniedCommands: clear ? [] : commandLines(endpointDraft.denied),
    });
    setSnapshot(next);
    setCheckReceipt(null);
    const saved = next.keys.find((entry) => entry.fingerprint === key.fingerprint)?.endpoint ?? null;
    setEndpointDraft(endpointDraftOf(saved, next.commandPolicyDefaults));
    if (clear) setEndpointTarget(null);
  });

  /** 저장된 지점으로 한 번 붙어 본다. 원격에서는 아무것도 바꾸지 않는다. */
  const checkEndpoint = (key: SshKeyView) => run(`check:${key.fingerprint}`, async () => {
    setCheckReceipt(await checkSshEndpoint({ fileName: key.fileName, fingerprint: key.fingerprint }));
  });

  const remove = async (key: SshKeyView) => {
    const accepted = await confirm({
      title: text("SSH 키 삭제", "Delete SSH key"),
      message: text(
        `"${key.fileName}"${key.hasPrivateKey ? "와 같은 이름의 개인키를" : "를"} .ssh 폴더 안의 휴지통(.agent-manager-trash)으로 옮깁니다. 이 키로 접속하던 서버·저장소는 더 이상 인증되지 않습니다.`,
        `"${key.fileName}"${key.hasPrivateKey ? " and its private key" : ""} will be moved to the .agent-manager-trash folder inside .ssh. Servers and repositories that relied on this key will no longer authenticate.`,
      ),
      items: [key.fingerprint, ...(key.note ? [key.note] : [])],
      warning: text(
        "파일은 지워지지 않고 옮겨지므로, 휴지통 폴더에서 다시 꺼내면 그대로 복구됩니다.",
        "The files are moved, not erased — move them back out of the trash folder to restore the key.",
      ),
      confirmLabel: text("삭제", "Delete"),
      tone: "danger",
    });
    if (!accepted) return;
    await run(`delete:${key.fingerprint}`, async () => {
      const receipt = await deleteSshKey({ fileName: key.fileName, fingerprint: key.fingerprint });
      await load();
      setNotice(text(
        `${receipt.fileName}${receipt.privateKeyMoved ? "와 개인키를" : "를"} ${receipt.trashPath}로 옮겼습니다.`,
        `Moved ${receipt.fileName}${receipt.privateKeyMoved ? " and its private key" : ""} to ${receipt.trashPath}.`,
      ));
      if (revealed?.fingerprint === key.fingerprint) setRevealed(null);
      if (noteTarget === key.fingerprint) setNoteTarget(null);
      if (endpointTarget === key.fingerprint) { setEndpointTarget(null); setCheckReceipt(null); }
    });
  };

  return (
    <section className="settings-card ssh-keys-card" data-ui-anchor="settings.ssh-keys-content">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><KeyRound size={18} aria-hidden="true" /></i>
          <div><span>SSH</span><h2>{text("SSH 인증키", "SSH keys")}</h2></div>
        </div>
        <p>{text(
          "로컬 .ssh 폴더의 공개키 알고리즘과 지문을 확인합니다. 공개키 본문은 필요할 때만 펼쳐 보고, 개인키 내용은 읽거나 화면으로 보내지 않습니다. 키마다 연결 서버를 적고 에이전트 사용을 켜면, 에이전트가 그 키로 서버에 접속해 작업할 수 있습니다.",
          "Inspect public-key algorithms and fingerprints in the local .ssh folder. Public-key bodies are shown on request; private-key contents are never read or sent to the UI. Give a key an endpoint and turn on agent use, and agents may connect to that server with it.",
        )}</p>
      </header>
      {/* 원격 편집이 켜져 있으면 이 카드는 호스트와 같다. 꺼져 있을 때만, 왜 버튼이
          눌리지 않는지 카드가 직접 말한다 — 손가락으로 쓰는 화면에는 hover가 없어
          title 속성의 설명은 보이지 않는다. */}
      {isRemote && !canWrite && (
        <div className="plugin-host-notice" role="note">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            <strong>{text("이 원격 연결은 읽기 전용입니다", "This remote connection is read-only")}</strong>
            <small>{text(
              "공개키와 지문은 그대로 볼 수 있습니다. 메모·연결 서버·키 생성·삭제를 하려면 호스트의 설정 → 백엔드 서비스에서 원격 편집 허용을 켠 뒤 다시 연결하세요.",
              "Public keys and fingerprints stay visible. To use notes, endpoints, key generation or removal, turn on remote editing in Settings → Backend service on the host and reconnect.",
            )}</small>
          </span>
        </div>
      )}
      {snapshot === null
        ? <div className="plugin-loading-state">{!error && <LoaderCircle size={16} className="spin" />}<span>{text("SSH 키를 확인하는 중…", "Checking SSH keys…")}</span></div>
        : <>
          <div className="ssh-key-location">
            <span><strong>{text("키 폴더", "Key directory")}</strong><code>{snapshot.directoryPath}</code></span>
            <button className="button compact" type="button" disabled={busy !== null} onClick={() => void load()}><RefreshCw size={13} />{text("새로고침", "Refresh")}</button>
          </div>
          {snapshot.keys.length === 0
            ? <div className="plugin-empty-state ssh-key-empty"><i><KeyRound size={25} /></i><div><strong>{text("확인된 공개키가 없습니다", "No public keys found")}</strong><small>{text("직접 하위의 .pub 파일만 확인하며, 개인키 파일은 열지 않습니다.", "Only direct .pub files are inspected; private-key files are never opened.")}</small></div></div>
            : <div className="plugin-list ssh-key-list">
              {snapshot.keys.map((key) => {
                const editing = noteTarget === key.fingerprint;
                const endpointEditing = endpointTarget === key.fingerprint;
                const endpointDirty = !sameEndpoint(endpointDraft, key.endpoint);
                const rowBusy = busy !== null && busy.endsWith(`:${key.fingerprint}`);
                return (
                  <div className="plugin-row" key={key.path}>
                    <i><KeyRound size={17} /></i>
                    <div className="plugin-row-main">
                      <div className="plugin-row-name"><strong>{key.fileName}</strong><code>{key.algorithm}</code></div>
                      <small>{key.path}</small>
                      <code className="ssh-key-fingerprint">{key.fingerprint}</code>
                      {key.comment && <small>{text("설명", "Comment")} · {key.comment}</small>}
                      {key.note && !editing && <small className="ssh-key-note"><NotebookPen size={12} aria-hidden="true" />{key.note}</small>}
                      {key.endpoint && <small className="ssh-key-endpoint">
                        <Server size={12} aria-hidden="true" />
                        <code>{`${key.endpoint.user}@${key.endpoint.host}:${key.endpoint.port}`}</code>
                        <em className={key.endpoint.agentEnabled ? "on" : "off"}>
                          <Bot size={11} aria-hidden="true" />
                          {key.endpoint.agentEnabled ? text("에이전트 사용", "Agent enabled") : text("에이전트 사용 꺼짐", "Agent disabled")}
                        </em>
                      </small>}
                      <span className={`plugin-status ${key.hasPrivateKey ? "ok" : "warn"}`}><i />{key.hasPrivateKey ? text("개인키 쌍 확인", "Private pair found") : text("공개키만 있음", "Public key only")}</span>
                    </div>
                    <div className="plugin-row-actions">
                      <div className="plugin-row-action-group">
                        <button className="button compact" type="button" disabled={busy !== null} title={text("공개키 한 줄을 그대로 보여 줍니다", "Shows the public-key line as it is stored")} onClick={() => void reveal(key)}>
                          {busy === `reveal:${key.fingerprint}` ? <LoaderCircle size={13} className="spin" /> : <Eye size={13} />}{text("공개키 확인", "View key")}
                        </button>
                        <button className="button compact" type="button" disabled={!canWrite || busy !== null} title={canWrite ? text("이 기기에만 저장되는 메모입니다", "A note stored on this device only") : text("읽기 전용 접속에서는 메모를 바꿀 수 없습니다", "Notes cannot be changed from a read-only connection")} onClick={() => { setNoteTarget(editing ? null : key.fingerprint); setNoteDraft(key.note ?? ""); }}>
                          <NotebookPen size={13} />{key.note ? text("메모 편집", "Edit note") : text("메모", "Add note")}
                        </button>
                        <button className="button compact" type="button" disabled={!canWrite || busy !== null} title={canWrite
                          ? text("이 키로 붙을 서버를 적고, 에이전트에게 열어 줄지 정합니다", "Set the server this key connects to and whether agents may use it")
                          : text("읽기 전용 접속에서는 연결 서버를 바꿀 수 없습니다", "Servers cannot be changed from a read-only connection")} onClick={() => openEndpoint(key)}>
                          <Server size={13} />{key.endpoint ? text("연결 서버 편집", "Edit server") : text("연결 서버", "Add server")}
                        </button>
                      </div>
                      <div className="plugin-row-action-group plugin-row-management-actions">
                        <button className="plugin-remove-button" type="button" disabled={!canWrite || busy !== null} aria-label={text(`${key.fileName} 삭제`, `Delete ${key.fileName}`)} title={canWrite ? text("키 쌍을 .ssh 안 휴지통으로 옮깁니다", "Moves the key pair to the trash folder inside .ssh") : text("읽기 전용 접속에서는 키를 지울 수 없습니다", "Keys cannot be removed from a read-only connection")} onClick={() => void remove(key)}>
                          {busy === `delete:${key.fingerprint}` ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
                        </button>
                      </div>
                    </div>
                    {endpointEditing && <div className="ssh-key-endpoint-form">
                      <div className="ssh-key-endpoint-fields">
                        <div className="form-row"><label htmlFor={`ssh-endpoint-host-${key.fingerprint}`}>{text("호스트", "Host")}</label><input id={`ssh-endpoint-host-${key.fingerprint}`} value={endpointDraft.host} autoComplete="off" placeholder="build.example.com" onChange={(event) => setEndpointDraft({ ...endpointDraft, host: event.target.value })} /></div>
                        <div className="form-row"><label htmlFor={`ssh-endpoint-user-${key.fingerprint}`}>{text("사용자", "User")}</label><input id={`ssh-endpoint-user-${key.fingerprint}`} value={endpointDraft.user} autoComplete="off" placeholder="deploy" onChange={(event) => setEndpointDraft({ ...endpointDraft, user: event.target.value })} /></div>
                        <div className="form-row"><label htmlFor={`ssh-endpoint-port-${key.fingerprint}`}>{text("포트", "Port")}</label><input id={`ssh-endpoint-port-${key.fingerprint}`} value={endpointDraft.port} inputMode="numeric" autoComplete="off" placeholder={DEFAULT_SSH_PORT} onChange={(event) => setEndpointDraft({ ...endpointDraft, port: event.target.value })} /></div>
                      </div>
                      <label className="ssh-key-endpoint-toggle" htmlFor={`ssh-endpoint-agent-${key.fingerprint}`}>
                        <input id={`ssh-endpoint-agent-${key.fingerprint}`} type="checkbox" checked={endpointDraft.agentEnabled} disabled={!key.hasPrivateKey} onChange={(event) => setEndpointDraft({ ...endpointDraft, agentEnabled: event.target.checked })} />
                        <span>
                          <strong>{text("에이전트 사용", "Let agents use this key")}</strong>
                          <small>{key.hasPrivateKey
                            ? text(
                              "에이전트가 이 키로 서버에 접속해 작업할 수 있습니다.",
                              "Agents can connect to this server and work with this key.",
                            )
                            : text(
                              "같은 이름의 개인키가 없어 이 키로는 접속할 수 없습니다. 접속 지점만 적어 둘 수 있습니다.",
                              "There is no matching private key, so this key cannot authenticate. You can still record the endpoint.",
                            )}</small>
                        </span>
                      </label>
                      <details className="ssh-key-advanced">
                        <summary>{text("고급 설정 · 명령 목록", "Advanced · command lists")}</summary>
                        <p>{text(
                          "에이전트가 이 서버에서 쓸 명령을 한 줄에 하나씩 적습니다. 규칙은 명령 앞머리와 맞춰 보며(systemctl status → systemctl status app), 차단이 허용보다 우선합니다. 허용을 비우면 차단에 걸리지 않는 명령을 모두 쓸 수 있습니다.",
                          "One command per line for what agents may run here. A rule matches the start of the command (systemctl status → systemctl status app) and deny wins over allow. Leave allow empty to permit anything not denied.",
                        )}</p>
                        <div className="form-row">
                          <label htmlFor={`ssh-endpoint-allow-${key.fingerprint}`}>{text("허용 명령", "Allowed")}</label>
                          <textarea id={`ssh-endpoint-allow-${key.fingerprint}`} value={endpointDraft.allowed} rows={5} spellCheck={false} placeholder={text("비우면 차단 목록만 적용됩니다", "Leave empty to apply only the deny list")} onChange={(event) => setEndpointDraft({ ...endpointDraft, allowed: event.target.value })} />
                        </div>
                        <div className="form-row">
                          <label htmlFor={`ssh-endpoint-deny-${key.fingerprint}`}>{text("차단 명령", "Denied")}</label>
                          <textarea id={`ssh-endpoint-deny-${key.fingerprint}`} value={endpointDraft.denied} rows={5} spellCheck={false} onChange={(event) => setEndpointDraft({ ...endpointDraft, denied: event.target.value })} />
                        </div>
                        <div className="ssh-key-advanced-actions">
                          <small>{text(
                            `허용 ${commandLines(endpointDraft.allowed).length}개 · 차단 ${commandLines(endpointDraft.denied).length}개 · 각 64개까지`,
                            `${commandLines(endpointDraft.allowed).length} allowed · ${commandLines(endpointDraft.denied).length} denied · up to 64 each`,
                          )}</small>
                          <button className="button compact" type="button" disabled={rowBusy} onClick={() => setEndpointDraft({
                            ...endpointDraft,
                            allowed: (snapshot?.commandPolicyDefaults.allowed ?? []).join("\n"),
                            denied: (snapshot?.commandPolicyDefaults.denied ?? []).join("\n"),
                          })}><RotateCcw size={13} />{text("기본값으로", "Reset to defaults")}</button>
                        </div>
                      </details>
                      {checkReceipt && <p className={`ssh-key-check ${checkReceipt.reachable ? "ok" : "fail"}`}>
                        <code>{checkReceipt.destination}</code>{checkReceipt.message}
                      </p>}
                      <div className="form-actions">
                        <small>{text("이 기기에만 저장되며 .ssh 폴더의 파일은 바뀌지 않습니다", "Stored on this device only; nothing in the .ssh folder changes")}</small>
                        <button className="button" type="button" disabled={rowBusy} onClick={() => { setEndpointTarget(null); setCheckReceipt(null); }}><X size={13} />{text("취소", "Cancel")}</button>
                        {key.endpoint && <button className="button" type="button" disabled={rowBusy} title={text("저장된 연결 서버를 지웁니다", "Removes the saved server")} onClick={() => void saveEndpoint(key, true)}><Trash2 size={13} />{text("해제", "Clear")}</button>}
                        <button className="button" type="button" disabled={rowBusy || !key.endpoint || endpointDirty || !key.hasPrivateKey} title={endpointDirty
                          ? text("저장한 연결 서버로만 확인합니다. 먼저 저장하세요", "The check uses the saved server — save first")
                          : text("저장된 지점에 한 번 붙어 보고 바로 끊습니다", "Connects once with the saved endpoint and disconnects")} onClick={() => void checkEndpoint(key)}>
                          {busy === `check:${key.fingerprint}` ? <LoaderCircle size={13} className="spin" /> : <PlugZap size={13} />}{text("연결 확인", "Test connection")}
                        </button>
                        <button className="button primary" type="button" disabled={rowBusy || !endpointDirty || !endpointDraft.host.trim() || !endpointDraft.user.trim()} onClick={() => void saveEndpoint(key)}>
                          {busy === `endpoint:${key.fingerprint}` ? <LoaderCircle size={13} className="spin" /> : <Server size={13} />}{text("저장", "Save")}
                        </button>
                      </div>
                    </div>}
                    {editing && <div className="ssh-key-note-form">
                      <label htmlFor={`ssh-key-note-${key.fingerprint}`}>{text("메모", "Note")}</label>
                      <textarea
                        id={`ssh-key-note-${key.fingerprint}`}
                        value={noteDraft}
                        rows={2}
                        maxLength={MAX_NOTE_CHARS}
                        placeholder={text("이 키를 어디에 쓰는지 적어 두세요", "Note what this key is used for")}
                        onChange={(event) => setNoteDraft(event.target.value)}
                      />
                      <div className="form-actions">
                        <small>{text(`이 기기에만 저장되며 공개키 파일은 바뀌지 않습니다 · ${noteDraft.trim().length}/${MAX_NOTE_CHARS}`, `Stored on this device only; the public-key file is untouched · ${noteDraft.trim().length}/${MAX_NOTE_CHARS}`)}</small>
                        <button className="button" type="button" disabled={rowBusy} onClick={() => { setNoteTarget(null); setNoteDraft(""); }}><X size={13} />{text("취소", "Cancel")}</button>
                        <button className="button primary" type="button" disabled={rowBusy || noteDraft.trim() === (key.note ?? "")} onClick={() => void saveNote(key)}>
                          {busy === `note:${key.fingerprint}` ? <LoaderCircle size={13} className="spin" /> : <NotebookPen size={13} />}{noteDraft.trim() ? text("저장", "Save") : text("메모 지우기", "Clear note")}
                        </button>
                      </div>
                    </div>}
                  </div>
                );
              })}
            </div>}
          {notice && <p className="ssh-key-notice">{notice}</p>}
          {snapshot.issues.length > 0 && <div className="ssh-key-issues"><strong>{text("읽지 못한 공개키", "Public keys not read")}</strong>{snapshot.issues.map((issue) => <small key={`${issue.path}:${issue.message}`}><code>{issue.path}</code>{issue.message}</small>)}</div>}
          {!adding && <div className="settings-update-body">
            <span className="settings-update-status"><strong>{text("새 SSH 키", "New SSH key")}</strong><small>{canWrite
              ? text("기존 파일을 덮어쓰지 않고 Ed25519 키 쌍을 생성합니다.", "Create an Ed25519 key pair without overwriting existing files.")
              : text("읽기 전용 접속에서는 키를 생성할 수 없습니다.", "Keys cannot be generated from a read-only connection.")}</small></span>
            <button className="button compact primary" type="button" disabled={!canWrite || !snapshot.keygenAvailable} onClick={() => setAdding(true)}><Plus size={13} />{text("키 생성", "Generate key")}</button>
          </div>}
          {adding && <div className="detail-card ssh-key-form">
            <div className="plugin-row-name"><strong>{text("Ed25519 키 생성", "Generate Ed25519 key")}</strong><code>ssh-keygen</code></div>
            <div className="form-row"><label htmlFor="ssh-key-file-name">{text("파일 이름", "File name")}</label><input id="ssh-key-file-name" value={fileName} autoComplete="off" placeholder={DEFAULT_FILE_NAME} onChange={(event) => setFileName(event.target.value)} /></div>
            <div className="form-row"><label htmlFor="ssh-key-comment">{text("설명", "Comment")}</label><span className="ssh-key-comment-field"><input id="ssh-key-comment" value={comment} autoComplete="off" maxLength={MAX_COMMENT_CHARS} placeholder={DEFAULT_COMMENT} onChange={(event) => setComment(event.target.value)} /><small>{text(`${comment.length}/${MAX_COMMENT_CHARS}자`, `${comment.length}/${MAX_COMMENT_CHARS} characters`)}</small></span></div>
            <p className="plugin-form-note"><ShieldCheck size={13} />{text(
              "개인키는 0600 권한의 암호 없는 키로 생성되며 앱은 그 내용을 읽지 않습니다. 암호가 필요한 키는 터미널의 ssh-keygen으로 직접 생성하세요.",
              "The private key is created unencrypted with 0600 permissions and is never read by the app. Use ssh-keygen in a terminal when a passphrase is required.",
            )}</p>
            <div className="form-actions">
              <button className="button" type="button" disabled={busy !== null} onClick={() => setAdding(false)}><X size={13} />{text("취소", "Cancel")}</button>
              <button className="button primary" type="button" disabled={busy !== null || !fileName.trim() || comment.length > MAX_COMMENT_CHARS} onClick={() => void create()}>{busy === "create" ? <LoaderCircle size={13} className="spin" /> : <KeyRound size={13} />}{busy === "create" ? text("생성 중…", "Generating…") : text("생성", "Generate")}</button>
            </div>
          </div>}
          {!snapshot.keygenAvailable && <p className="ssh-key-unavailable">{text("이 호스트에서 ssh-keygen 실행 파일을 찾지 못해 기존 키 조회만 가능합니다.", "ssh-keygen was not found on this host, so existing keys are read-only.")}</p>}
        </>}
      {error && <ErrorBanner message={error} />}
      {revealed && <Modal
        title={<><Eye size={15} /><span>{text("공개키 확인", "Public key")}</span></>}
        onClose={() => setRevealed(null)}
        footer={<button className="button" type="button" onClick={() => setRevealed(null)}>{text("닫기", "Close")}</button>}
      >
        <div className="ssh-key-reveal">
          <div className="ssh-key-reveal-head">
            <div className="plugin-row-name"><strong>{revealed.fileName}</strong><code>{revealed.algorithm}</code></div>
            <CopyAction value={revealed.publicKey} kind="code" />
          </div>
          <code className="ssh-key-fingerprint">{revealed.fingerprint}</code>
          <pre className="ssh-key-body">{revealed.publicKey}</pre>
          <small>{text(
            "공개키는 서버의 authorized_keys나 GitHub 등에 그대로 등록하는 값입니다. 개인키는 어떤 화면에도 실리지 않습니다.",
            "A public key is meant to be pasted into authorized_keys, GitHub, and the like. The private key is never shown anywhere.",
          )}</small>
        </div>
      </Modal>}
      {confirmDialog}
    </section>
  );
}
