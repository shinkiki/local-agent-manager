import { AlertTriangle, Bot, GitBranch, KeyRound, LoaderCircle, Pencil, Plus, PlugZap, RotateCcw, Server, ShieldAlert, Terminal, Trash2, Upload, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { checkSshEndpoint, deleteSshServer, saveSshServer } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { parseSshPort } from "../lib/sshPort";
import { commandLines } from "../lib/sshCommandRules";
import type { ConfirmRequest } from "./Shared";
import type { SaveSshServerRequest, SshCommandPolicyDefaults, SshEndpointCheckReceipt, SshEndpointView, SshKeysSnapshot, SshKeyView, TerminalSshMode } from "../types";
import { canOpenSshTerminal, SshTerminalPanel } from "./TerminalPanel";

const DEFAULT_SSH_PORT = "22";
/** 서버 이름 한도. 백엔드 `MAX_SERVER_NAME_CHARS`와 같은 값이다. */
const MAX_SERVER_NAME_CHARS = 80;
/** 새 서버 폼이 열렸을 때의 편집 대상 표시. 서버 ID(`srv-…`)와 겹치지 않는다. */
const NEW_SERVER = "new";

/**
 * 연결 서버 구역이 카드의 "한 번에 한 동작" 껍데기에 싣는 동작 표시. 키 쪽 표시와 같은
 * `"갈래:대상"` 모양이고, 대상은 서버 ID(새 서버는 `new`)다. 갈래 이름이 키 쪽과 겹치지
 * 않아, 키 행의 "이 키로 무언가 도는가" 판정에 서버 동작이 섞이지 않는다.
 */
type SshServerTaskKind = "server-save" | "server-check" | "server-delete";
export type SshServerTask = `${SshServerTaskKind}:${string}`;

function serverTask(kind: SshServerTaskKind, serverId: string): SshServerTask {
  return `${kind}:${serverId}`;
}

/** 저장된 서버의 접속 대상 한 줄. 이름이 없을 때 이름 자리도 이 값이다. */
export function serverDestination(server: SshEndpointView): string {
  return `${server.user}@${server.host}:${server.port}`;
}

/** 목록·확인 대화·영수증에 쓰는 서버 이름. 비어 있으면 접속 대상을 대신 쓴다. */
export function serverLabel(server: SshEndpointView): string {
  return server.name.trim() || serverDestination(server);
}

interface ServerDraft {
  name: string;
  host: string;
  port: string;
  user: string;
  fingerprint: string;
  agentEnabled: boolean;
  allowed: string;
  denied: string;
  fileTransferEnabled: boolean;
  transferRoot: string;
  terminalEnabled: boolean;
  unrestrictedCommands: boolean;
  projectGitEnabled: boolean;
}

/**
 * 저장된 서버를 편집 상자의 입력값으로 편다. 새 서버면 22번 포트와 백엔드가 준 기본 명령
 * 정책을 채우고, 접속할 수 있는 첫 키를 미리 골라 둔다 — 빈 정책·빈 키로 열리지 않게 한다.
 */
function serverDraftOf(server: SshEndpointView | null, defaults: SshCommandPolicyDefaults | null, defaultFingerprint = ""): ServerDraft {
  return {
    name: server?.name ?? "",
    host: server?.host ?? "",
    port: server ? String(server.port) : DEFAULT_SSH_PORT,
    user: server?.user ?? "",
    fingerprint: server?.fingerprint ?? defaultFingerprint,
    agentEnabled: server?.agentEnabled ?? false,
    allowed: (server ? server.allowedCommands : defaults?.allowed ?? []).join("\n"),
    denied: (server ? server.deniedCommands : defaults?.denied ?? []).join("\n"),
    fileTransferEnabled: server?.fileTransferEnabled ?? false,
    transferRoot: server?.transferRoot ?? "",
    terminalEnabled: server?.terminalEnabled ?? false,
    unrestrictedCommands: server?.unrestrictedCommands ?? false,
    projectGitEnabled: server?.projectGitEnabled ?? false,
  };
}

/** 저장본과 같은 값인지. 같으면 저장 버튼을 잠근다. */
function sameServer(draft: ServerDraft, server: SshEndpointView): boolean {
  const saved = serverDraftOf(server, null);
  return draft.name.trim() === saved.name
    && draft.host.trim() === saved.host
    && draft.port.trim() === saved.port
    && draft.user.trim() === saved.user
    && draft.fingerprint === saved.fingerprint
    && draft.agentEnabled === saved.agentEnabled
    && commandLines(draft.allowed).join("\n") === commandLines(saved.allowed).join("\n")
    && commandLines(draft.denied).join("\n") === commandLines(saved.denied).join("\n")
    && draft.fileTransferEnabled === saved.fileTransferEnabled
    && draft.transferRoot.trim() === saved.transferRoot
    && draft.terminalEnabled === saved.terminalEnabled
    && draft.unrestrictedCommands === saved.unrestrictedCommands
    && draft.projectGitEnabled === saved.projectGitEnabled;
}

/** 주소·사용자·인증키 필수 입력, 포트 형식, 이름 길이, 파일 전송 시의 전송 폴더 입력을 확인한다. */
function isServerDraftValid(draft: ServerDraft, keys: SshKeyView[]): boolean {
  if (!draft.host.trim() || !draft.user.trim()) return false;
  if (draft.name.trim().length > MAX_SERVER_NAME_CHARS) return false;
  // 백엔드는 ~/.ssh에 없는 지문을 받지 않는다. 키가 사라진 서버는 다른 키를 골라야 저장된다.
  if (!keys.some((key) => key.fingerprint === draft.fingerprint)) return false;
  if (draft.fileTransferEnabled && !draft.transferRoot.trim()) return false;
  return parseSshPort(draft.port) !== undefined;
}

/** 저장 요청. 에이전트 사용에 딸린 세 권한은 에이전트 사용이 꺼지면 함께 꺼서 보낸다. */
function toSaveServerRequest(id: string | null, draft: ServerDraft): SaveSshServerRequest {
  return {
    id,
    name: draft.name.trim(),
    fingerprint: draft.fingerprint,
    host: draft.host.trim(),
    port: parseSshPort(draft.port) ?? null,
    user: draft.user.trim(),
    agentEnabled: draft.agentEnabled,
    allowedCommands: commandLines(draft.allowed),
    deniedCommands: commandLines(draft.denied),
    fileTransferEnabled: draft.agentEnabled && draft.fileTransferEnabled,
    transferRoot: draft.transferRoot.trim(),
    terminalEnabled: draft.agentEnabled && draft.terminalEnabled,
    unrestrictedCommands: draft.agentEnabled && draft.unrestrictedCommands,
    // 이 토글만 agentEnabled에 곱하지 않는다 — 에이전트 권한이 아니라 사용자 git의 신원이다(C16-10).
    projectGitEnabled: draft.projectGitEnabled,
  };
}

/**
 * 서버 한 줄에 딸려 열리는 자리 셋(편집 상자·연결 확인 결과·대화형 창)의 열고 닫는 규칙.
 * 편집 상자와 대화형 창은 각각 한 번에 하나만 열고, 확인 결과는 그 결과를 낸 서버 줄에만
 * 붙는다. 편집을 열거나 저장하면 확인 결과를 버린다 — 저장본이 바뀌었을 수 있어서다.
 */
function useSshServerEditors() {
  const [target, setTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState<ServerDraft>(serverDraftOf(null, null));
  const [checkReceipt, setCheckReceipt] = useState<SshEndpointCheckReceipt | null>(null);
  /** C9-19/C9-20. 대화형 창을 열어 둔 서버와 그 갈래. */
  const [terminalTarget, setTerminalTarget] = useState<{ serverId: string; mode: TerminalSshMode } | null>(null);

  const openTerminalModeOf = (serverId: string): TerminalSshMode | null =>
    terminalTarget?.serverId === serverId ? terminalTarget.mode : null;
  const toggleTerminal = (serverId: string, mode: TerminalSshMode) =>
    setTerminalTarget(openTerminalModeOf(serverId) === mode ? null : { serverId, mode });

  /** 편집 상자를 연다(새 서버는 `NEW_SERVER`). 같은 대상을 다시 누르면 닫는다. */
  const toggleEditor = (nextTarget: string, nextDraft: ServerDraft) => {
    const closing = target === nextTarget;
    setTarget(closing ? null : nextTarget);
    setDraft(nextDraft);
    setCheckReceipt(null);
  };

  const closeEditor = () => setTarget(null);

  /** 저장 뒤 응답으로 온 저장본을 다시 입력값에 펴, 화면 값과 저장 값이 어긋나지 않게 한다. */
  const showSaved = (serverId: string, nextDraft: ServerDraft) => {
    setTarget(serverId);
    setDraft(nextDraft);
    setCheckReceipt(null);
  };

  /** 지워진 서버가 열어 두고 있던 자리를 모두 닫는다. */
  const forgetServer = (serverId: string) => {
    if (target === serverId) setTarget(null);
    setCheckReceipt((current) => (current?.serverId === serverId ? null : current));
    setTerminalTarget((current) => (current?.serverId === serverId ? null : current));
  };

  return {
    target, draft, setDraft, toggleEditor, closeEditor, showSaved,
    checkReceipt, setCheckReceipt,
    openTerminalModeOf, toggleTerminal,
    forgetServer,
  };
}

interface SshServersSectionProps {
  snapshot: SshKeysSnapshot;
  setSnapshot: (snapshot: SshKeysSnapshot) => void;
  /** 카드 전체에서 지금 도는 동작. 하나라도 돌면 이 구역의 버튼도 잠근다. */
  busy: string | null;
  run: (token: SshServerTask, action: () => Promise<void>) => Promise<void>;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** 쓸 키가 없을 때 키 생성 폼으로 보내는 바로가기. */
  onGenerateKey: () => void;
}

/**
 * 연결 서버 목록. 서버는 키와 따로 저장되고 접속에 쓸 키를 지문으로 가리킨다 — 키 하나를
 * 여러 서버가 함께 쓸 수 있고, 키를 지워도 서버는 남는다(다른 키로 바꾸면 다시 쓸 수 있다).
 * 연결 확인·터미널·공개키 등록은 모두 서버 단위로 열린다.
 */
export function SshServersSection({ snapshot, setSnapshot, busy, run, confirm, onGenerateKey }: SshServersSectionProps) {
  const { text } = useI18n();
  const editors = useSshServerEditors();
  const usableKeys = snapshot.keys.filter((key) => key.hasPrivateKey);
  const defaults = snapshot.commandPolicyDefaults;
  const keyOf = (server: SshEndpointView) => snapshot.keys.find((key) => key.fingerprint === server.fingerprint) ?? null;

  const toggleNew = () => editors.toggleEditor(NEW_SERVER, serverDraftOf(null, defaults, usableKeys[0]?.fingerprint ?? ""));
  const toggleEdit = (server: SshEndpointView) => editors.toggleEditor(server.id, serverDraftOf(server, defaults));

  /** 저장은 앱 데이터만 바꾼다. `serverId`가 null이면 새 서버다. */
  const save = (serverId: string | null) => run(serverTask("server-save", serverId ?? NEW_SERVER), async () => {
    const next = await saveSshServer(toSaveServerRequest(serverId, editors.draft));
    setSnapshot(next);
    // 새 서버는 추가하고 폼을 닫는다 — 새 줄이 목록에 생기고, 연결 확인·터미널은 그 줄에 있다.
    // 고친 서버는 폼을 연 채 저장본을 다시 펴서 이어서 고칠 수 있게 한다.
    const saved = serverId ? next.servers.find((server) => server.id === serverId) ?? null : null;
    if (saved) editors.showSaved(saved.id, serverDraftOf(saved, next.commandPolicyDefaults));
    else editors.closeEditor();
  });

  /** 저장된 서버로 한 번 붙어 본다. 원격에서는 아무것도 바꾸지 않는다. */
  const check = (server: SshEndpointView) => run(serverTask("server-check", server.id), async () => {
    editors.setCheckReceipt(null);
    editors.setCheckReceipt(await checkSshEndpoint({ serverId: server.id }));
  });

  const remove = async (server: SshEndpointView) => {
    const accepted = await confirm({
      title: text("연결 서버 삭제", "Delete server"),
      message: text(
        `"${serverLabel(server)}" 서버를 목록에서 지웁니다. 에이전트는 더 이상 이 서버에 접속하지 못합니다.`,
        `"${serverLabel(server)}" will be removed. Agents will no longer connect to this server.`,
      ),
      items: [serverDestination(server)],
      warning: text(
        "키 파일과 다른 서버는 그대로이며, .ssh 폴더도 바뀌지 않습니다.",
        "Key files and other servers are untouched; nothing in the .ssh folder changes.",
      ),
      confirmLabel: text("삭제", "Delete"),
      tone: "danger",
    });
    if (!accepted) return;
    await run(serverTask("server-delete", server.id), async () => {
      setSnapshot(await deleteSshServer({ serverId: server.id }));
      editors.forgetServer(server.id);
    });
  };

  /**
   * 무제한 명령 허용을 켜기 직전에 한 번 더 묻는다. 이 토글은 허용 목록과 승인 카드를
   * 통째로 걷어내는 유일한 자리라, 다른 토글처럼 조용히 켜지면 사용자가 무엇을 연 것인지
   * 모른 채 저장하게 된다. 끌 때는 묻지 않는다 — 좁히는 방향이다.
   */
  const confirmUnrestricted = () => confirm({
    title: text("무제한 명령 허용", "Allow any command"),
    message: text(
      "이 서버에서는 에이전트가 허용 명령 목록과 상관없이 어떤 명령이든 승인 카드 없이 실행합니다. 파일을 지우거나 서비스를 바꾸는 명령도 그대로 실행되며, 결과를 파일로 내보내는 리다이렉션(>, >>)도 이 서버에서만 열립니다. 실행 전에 사용자에게 묻지 않습니다.",
      "On this server agents will run any command regardless of the allowed-command list, with no approval card. Commands that delete files or change services run as-is, redirecting output into a file (>, >>) opens only here, and you are not asked first.",
    ),
    items: [
      text("차단 명령 목록은 그대로 적용되며, 파이프로 이은 명령은 단계마다 대조합니다", "The denied-command list still applies, and a piped command is checked stage by stage"),
      text("셸·인터프리터·네트워크 내려받기 명령(sh, bash, curl, python …)은 이 경로에서 계속 거절됩니다", "Shell, interpreter and network-fetch commands (sh, bash, curl, python …) are still refused on this path"),
    ],
    warning: text(
      "믿을 수 있는 서버에만 켜세요. 되돌리려면 이 토글을 끄고 저장하면 됩니다.",
      "Turn this on only for servers you trust. To undo it, switch the toggle off and save.",
    ),
    confirmLabel: text("무제한으로 켜기", "Turn on"),
    tone: "danger",
  });

  const editorFor = (server: SshEndpointView | null) => (
    <SshServerEditor
      server={server}
      keys={snapshot.keys}
      draft={editors.draft}
      onChangeDraft={editors.setDraft}
      onConfirmUnrestricted={confirmUnrestricted}
      commandPolicyDefaults={defaults}
      busy={busy !== null}
      saving={busy === serverTask("server-save", server?.id ?? NEW_SERVER)}
      onGenerateKey={onGenerateKey}
      onCancel={editors.closeEditor}
      onSave={() => void save(server?.id ?? null)}
    />
  );

  return (
    <div className="ssh-server-section">
      <div className="ssh-section-head">
        <span>
          <strong>{text("연결 서버", "Servers")}</strong>
          <small>{text(
            "에이전트와 터미널이 접속할 서버입니다. 서버마다 인증키를 하나 고르며, 키 하나를 여러 서버가 함께 쓸 수 있습니다.",
            "Servers that agents and terminals connect to. Each server picks one key, and one key can be shared by several servers.",
          )}</small>
        </span>
        <button className="button compact primary" type="button" disabled={busy !== null} onClick={toggleNew}>
          {editors.target === NEW_SERVER ? <X size={13} /> : <Plus size={13} />}
          {editors.target === NEW_SERVER ? text("추가 닫기", "Close") : text("서버 추가", "Add server")}
        </button>
      </div>
      {editors.target === NEW_SERVER && <div className="ssh-server-new">{editorFor(null)}</div>}
      {snapshot.servers.length === 0
        ? editors.target !== NEW_SERVER && <div className="plugin-empty-state ssh-server-empty">
          <i><Server size={25} /></i>
          <div>
            <strong>{text("저장된 연결 서버가 없습니다", "No servers yet")}</strong>
            <small>{usableKeys.length === 0
              ? text("먼저 접속에 쓸 SSH 키를 만든 뒤 서버를 추가하세요.", "Create an SSH key to connect with first, then add a server.")
              : text("서버 추가로 주소·사용자·인증키를 적으면 에이전트와 터미널이 그 서버에 접속할 수 있습니다.", "Add a server with its address, user and key so agents and terminals can connect to it.")}</small>
          </div>
          {usableKeys.length === 0 && snapshot.keygenAvailable && <button className="button compact" type="button" disabled={busy !== null} onClick={onGenerateKey}><KeyRound size={13} />{text("키 생성", "Generate key")}</button>}
        </div>
        : <div className="plugin-list ssh-server-list">
          {snapshot.servers.map((server) => (
            <SshServerRow
              key={server.id}
              server={server}
              sshKey={keyOf(server)}
              busy={busy}
              editing={editors.target === server.id}
              editor={editors.target === server.id ? editorFor(server) : null}
              checkReceipt={editors.checkReceipt?.serverId === server.id ? editors.checkReceipt : null}
              terminalMode={editors.openTerminalModeOf(server.id)}
              onToggleTerminal={(mode) => editors.toggleTerminal(server.id, mode)}
              onToggleEdit={() => toggleEdit(server)}
              onCheck={() => void check(server)}
              onRemove={() => void remove(server)}
            />
          ))}
        </div>}
    </div>
  );
}

/** 연결 서버의 한 줄 문자열 입력. 칸마다 같은 id·라벨·입력 배선을 되풀이하지 않게 한다. */
function SshServerTextField({ id, label, value, placeholder, inputMode, spellCheck, maxLength, help, onChange }: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  inputMode?: "numeric";
  spellCheck?: boolean;
  maxLength?: number;
  help?: string;
  onChange: (value: string) => void;
}) {
  return <div className="form-row">
    <label htmlFor={id}>{label}</label>
    <input
      id={id}
      value={value}
      inputMode={inputMode}
      autoComplete="off"
      spellCheck={spellCheck}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
    {help && <small>{help}</small>}
  </div>;
}

/** 연결 서버의 여러 줄 명령 목록 칸. 허용·차단 두 칸이 같은 배선을 되풀이하지 않게 한다. */
function SshServerTextArea({ id, label, value, placeholder, onChange }: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return <div className="form-row">
    <label htmlFor={id}>{label}</label>
    <textarea
      id={id}
      value={value}
      rows={5}
      spellCheck={false}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  </div>;
}

/**
 * 연결 서버의 권한 스위치 한 줄. 체크 상태를 어떻게 받아 무엇을 바꿀지는 부르는 쪽이 그대로
 * 남기고, 라벨·체크박스·설명 배치만 여기로 모은다.
 */
function SshServerToggleField({ id, title, help, checked, disabled, onChange }: {
  id: string;
  title: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <label className="ssh-key-endpoint-toggle" htmlFor={id}>
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
    <span>
      <strong>{title}</strong>
      <small>{help}</small>
    </span>
  </label>;
}

interface SshServerEditorProps {
  /** 고치는 서버. 새 서버면 null이다. */
  server: SshEndpointView | null;
  keys: SshKeyView[];
  draft: ServerDraft;
  onChangeDraft: (draft: ServerDraft) => void;
  onConfirmUnrestricted: () => Promise<boolean>;
  commandPolicyDefaults: SshCommandPolicyDefaults | null;
  busy: boolean;
  saving: boolean;
  onGenerateKey: () => void;
  onCancel: () => void;
  onSave: () => void;
}

/** 연결 서버 설정 폼. 이름·주소·포트·사용자·인증키, 에이전트 허용, 파일 전송 폴더, 명령 정책을 편집한다. */
function SshServerEditor({
  server,
  keys,
  draft,
  onChangeDraft,
  onConfirmUnrestricted,
  commandPolicyDefaults,
  busy,
  saving,
  onGenerateKey,
  onCancel,
  onSave,
}: SshServerEditorProps) {
  const { text } = useI18n();
  const usableKeys = keys.filter((key) => key.hasPrivateKey);
  const selectedKey = keys.find((key) => key.fingerprint === draft.fingerprint) ?? null;
  const keyMissing = draft.fingerprint !== "" && selectedKey === null;
  const hasPrivateKey = selectedKey?.hasPrivateKey ?? false;
  const dirty = server ? !sameServer(draft, server) : true;
  const canSave = !busy && dirty && isServerDraftValid(draft, keys);
  const update = (patch: Partial<ServerDraft>) => onChangeDraft({ ...draft, ...patch });
  /** 한 화면에 새 서버 폼과 기존 서버 폼이 함께 그려질 수 있어 칸의 id에 서버 ID를 붙인다. */
  const fieldId = (name: string) => `ssh-server-${name}-${server?.id ?? NEW_SERVER}`;
  /** 에이전트 사용을 끄면 그 아래 권한 셋은 함께 잠긴다. */
  const agentOptionDisabled = !hasPrivateKey || !draft.agentEnabled;
  /** 고른 키가 목록에서 빠지면(키 삭제·공개키만 남음) 선택 상자가 빈칸으로 보이지 않게 현재 값을 한 줄 남긴다. */
  const showCurrentOption = draft.fingerprint !== "" && !usableKeys.some((key) => key.fingerprint === draft.fingerprint);

  return (
    <div className="ssh-key-endpoint-form ssh-server-form">
      <div className="ssh-key-endpoint-fields">
        <SshServerTextField id={fieldId("name")} label={text("이름", "Name")} value={draft.name} maxLength={MAX_SERVER_NAME_CHARS} placeholder={text("비우면 사용자@주소:포트로 표시", "Shown as user@host:port when empty")} onChange={(name) => update({ name })} />
        <SshServerTextField id={fieldId("host")} label={text("주소", "Host")} value={draft.host} spellCheck={false} placeholder={text("IP 또는 호스트 이름 (build.example.com)", "IP or host name (build.example.com)")} onChange={(host) => update({ host })} />
        <SshServerTextField id={fieldId("port")} label={text("포트", "Port")} value={draft.port} inputMode="numeric" placeholder={DEFAULT_SSH_PORT} onChange={(port) => update({ port })} />
        <SshServerTextField id={fieldId("user")} label={text("사용자", "User")} value={draft.user} spellCheck={false} placeholder="deploy" onChange={(user) => update({ user })} />
        <div className="form-row">
          <label htmlFor={fieldId("key")}>{text("인증키", "Key")}</label>
          <select
            id={fieldId("key")}
            value={draft.fingerprint}
            onChange={(event) => {
              const fingerprint = event.target.value;
              const nextKey = keys.find((key) => key.fingerprint === fingerprint);
              // 개인키가 없는 키로 바꾸면 그 키로는 접속할 수 없으니 키에 묶인 권한을 함께 끈다.
              update(nextKey?.hasPrivateKey
                ? { fingerprint }
                : { fingerprint, agentEnabled: false, fileTransferEnabled: false, terminalEnabled: false, unrestrictedCommands: false, projectGitEnabled: false });
            }}
          >
            {draft.fingerprint === "" && <option value="">{text("키를 고르세요", "Choose a key")}</option>}
            {showCurrentOption && <option value={draft.fingerprint}>
              {selectedKey
                ? text(`${selectedKey.fileName} · ${selectedKey.algorithm} (공개키만 있음)`, `${selectedKey.fileName} · ${selectedKey.algorithm} (public key only)`)
                : text(`없는 키 · ${draft.fingerprint}`, `Missing key · ${draft.fingerprint}`)}
            </option>}
            {usableKeys.map((key) => (
              <option key={key.fingerprint} value={key.fingerprint}>{`${key.fileName} · ${key.algorithm}`}</option>
            ))}
          </select>
          {keyMissing && <small className="ssh-server-warning">{text(
            "이 서버가 쓰는 키가 ~/.ssh에 없습니다. 다른 키를 골라 저장하면 다시 쓸 수 있습니다.",
            "The key this server uses is not in ~/.ssh. Choose another key and save to use it again.",
          )}</small>}
          {usableKeys.length === 0 && <span className="ssh-server-no-key">
            <small className="ssh-server-warning">{text("접속에 쓸 수 있는 키(개인키가 있는 키)가 없습니다. 먼저 키를 만드세요.", "No key with a private key is available to connect with. Create one first.")}</small>
            <button className="button compact" type="button" disabled={busy} onClick={onGenerateKey}><KeyRound size={13} />{text("키 생성", "Generate key")}</button>
          </span>}
        </div>
      </div>
      <SshServerToggleField
        id={fieldId("agent")}
        title={text("에이전트 사용", "Let agents use this server")}
        help={hasPrivateKey
          ? text(
            "에이전트가 고른 키로 이 서버에 접속해 작업할 수 있습니다.",
            "Agents can connect to this server with the chosen key and work there.",
          )
          : text(
            "고른 키에 같은 이름의 개인키가 없어 접속할 수 없습니다. 접속 정보만 적어 둘 수 있습니다.",
            "The chosen key has no matching private key, so it cannot authenticate. You can still record the server.",
          )}
        checked={draft.agentEnabled}
        disabled={!hasPrivateKey}
        onChange={(agentEnabled) => update({
          agentEnabled,
          fileTransferEnabled: agentEnabled && draft.fileTransferEnabled,
          terminalEnabled: agentEnabled && draft.terminalEnabled,
          unrestrictedCommands: agentEnabled && draft.unrestrictedCommands,
        })}
      />
      <SshServerToggleField
        id={fieldId("upload")}
        title={text("파일 전송", "Let agents transfer files")}
        help={text(
          "에이전트가 이 서버의 전송 폴더 아래로 파일을 올리고 받을 수 있습니다. 명령 허용 목록과 별개의 권한이라, 명령을 열지 않고 산출물만 주고받게 할 수도 있습니다.",
          "Agents may upload and download files under this server's transfer folder. This is a separate permission from the command lists, so you can allow transfers without allowing any command.",
        )}
        checked={draft.fileTransferEnabled}
        disabled={agentOptionDisabled}
        onChange={(fileTransferEnabled) => update({ fileTransferEnabled })}
      />
      {draft.fileTransferEnabled && <SshServerTextField
        id={fieldId("upload-root")}
        label={text("서버의 전송 폴더", "Transfer folder on the server")}
        value={draft.transferRoot}
        spellCheck={false}
        placeholder="/srv/releases"
        onChange={(transferRoot) => update({ transferRoot })}
        help={text(
          "접속하는 서버 안의 경로입니다 — 이 PC의 폴더가 아니므로 C:\\ 같은 Windows 경로는 쓸 수 없습니다. 올리고 받는 대상은 모두 이 폴더 아래 상대 경로로만 정해집니다. 서버 기준 /로 시작하거나 ~/ 아래 경로를 적고, 공백과 상위 이동(..)은 쓸 수 없습니다.",
          "This is a path inside the server you connect to — not a folder on this computer, so Windows paths like C:\\ are not accepted. Both uploads and downloads are resolved only under this folder. Use an absolute path on the server or one under ~/; spaces and parent traversal (..) are refused.",
        )}
      />}
      <SshServerToggleField
        id={fieldId("project-git")}
        title={text("git 원격용", "Use for project git remotes")}
        help={text(
          "프로젝트 화면의 git이 원격과 주고받을 때(원격 확인·받아서 합치기·올리기) 이 서버의 키로 인증합니다. 그 세 작업에만 쓰이고 에이전트가 실행하는 명령에는 들어가지 않으며, 개인키는 복사되지 않고 경로만 git에 넘어갑니다. 기기 전체에서 한 서버만 켤 수 있습니다.",
          "The git panel authenticates with this server's key when it talks to a remote (fetch, pull, push). It is used for those three operations only, never for commands an agent runs, and the private key is not copied — only its path is handed to git. Only one server on this device can carry this.",
        )}
        checked={draft.projectGitEnabled}
        disabled={!hasPrivateKey}
        onChange={(projectGitEnabled) => update({ projectGitEnabled })}
      />
      <SshServerToggleField
        id={fieldId("terminal")}
        title={text("출력 표시", "Stream command output")}
        help={text(
          "에이전트가 이 서버에서 실행하는 명령의 출력이 채팅 화면의 도구 카드에 실시간으로 흐릅니다. 자기 셸이 있는 에이전트(Claude·Codex)도 Agent Manager를 거쳐 실행하므로 같은 화면에 나오고, 그 경로에서는 명령 목록이 실제로 집행됩니다. 목록 밖 명령은 승인 카드 없이 거절됩니다.",
          "Output of commands agents run on this server streams live into a tool card in the chat. Agents with their own shell (Claude, Codex) also run through Agent Manager, so they appear on the same screen and the command lists are enforced on that path. Commands outside the lists are refused without an approval card.",
        )}
        checked={draft.terminalEnabled}
        disabled={agentOptionDisabled}
        onChange={(terminalEnabled) => update({ terminalEnabled })}
      />
      <SshServerToggleField
        id={fieldId("unrestricted")}
        title={text("무제한 명령 허용", "Allow any command")}
        help={text(
          "에이전트가 허용 명령 목록과 상관없이 어떤 명령이든 승인 카드 없이 실행합니다. 결과를 파일로 내보내는 리다이렉션(>, >>)도 이 서버에서만 열립니다. 차단 명령 목록과 셸·인터프리터·네트워크 내려받기 거부는 그대로 남습니다. 믿을 수 있는 서버에만 켜세요.",
          "Agents run any command regardless of the allowed-command list, with no approval card. Redirecting output into a file (>, >>) also opens only here. The denied-command list and the shell, interpreter and network-fetch refusals still stand. Turn this on only for servers you trust.",
        )}
        checked={draft.unrestrictedCommands}
        disabled={agentOptionDisabled}
        onChange={(checked) => {
          // 켜는 쪽만 한 번 더 묻는다. 확인 전에는 초안을 바꾸지 않아, 거절하면 스위치가
          // 켜졌다 돌아오는 깜빡임 없이 그대로 꺼져 있다.
          if (!checked) {
            update({ unrestrictedCommands: false });
            return;
          }
          void onConfirmUnrestricted().then((accepted) => {
            if (accepted) update({ unrestrictedCommands: true });
          });
        }}
      />
      <details className="ssh-key-advanced">
        <summary>{text("고급 설정 · 명령 목록", "Advanced · command lists")}</summary>
        {draft.unrestrictedCommands && <p className="ssh-key-advanced-override">{text(
          "무제한 명령 허용이 켜져 있어 허용 목록은 지금 쓰이지 않습니다. 차단 목록은 그대로 적용됩니다.",
          "Allow-any-command is on, so the allowed list is not consulted right now. The denied list still applies.",
        )}</p>}
        <p>{text(
          "에이전트가 이 서버에서 쓸 명령을 한 줄에 하나씩 적습니다. 규칙은 명령 앞머리와 맞춰 보며(systemctl status → systemctl status app), 차단이 허용보다 우선합니다. 파이프로 이은 명령은 단계마다 따로 맞춰 보므로 모든 단계가 목록을 지나야 합니다. 허용을 비우면 차단에 걸리지 않는 명령을 모두 쓸 수 있습니다.",
          "One command per line for what agents may run here. A rule matches the start of the command (systemctl status → systemctl status app) and deny wins over allow. A piped command is checked stage by stage, so every stage must pass the lists. Leave allow empty to permit anything not denied.",
        )}</p>
        <SshServerTextArea
          id={fieldId("allow")}
          label={text("허용 명령", "Allowed")}
          value={draft.allowed}
          placeholder={text("비우면 차단 목록만 적용됩니다", "Leave empty to apply only the deny list")}
          onChange={(allowed) => update({ allowed })}
        />
        <SshServerTextArea
          id={fieldId("deny")}
          label={text("차단 명령", "Denied")}
          value={draft.denied}
          onChange={(denied) => update({ denied })}
        />
        <div className="ssh-key-advanced-actions">
          <small>{text(
            `허용 ${commandLines(draft.allowed).length}개 · 차단 ${commandLines(draft.denied).length}개 · 각 64개까지`,
            `${commandLines(draft.allowed).length} allowed · ${commandLines(draft.denied).length} denied · up to 64 each`,
          )}</small>
          <button
            className="button compact"
            type="button"
            disabled={busy}
            onClick={() => update({
              allowed: (commandPolicyDefaults?.allowed ?? []).join("\n"),
              denied: (commandPolicyDefaults?.denied ?? []).join("\n"),
            })}
          >
            <RotateCcw size={13} />{text("기본값으로", "Reset to defaults")}
          </button>
        </div>
      </details>
      <div className="form-actions">
        <small>{text("이 기기에만 저장되며 .ssh 폴더의 파일은 바뀌지 않습니다", "Stored on this device only; nothing in the .ssh folder changes")}</small>
        <button className="button" type="button" disabled={busy} onClick={onCancel}><X size={13} />{text("취소", "Cancel")}</button>
        <button className="button primary" type="button" disabled={!canSave} onClick={onSave}>
          {saving ? <LoaderCircle size={13} className="spin" /> : <Server size={13} />}{server ? text("저장", "Save") : text("추가", "Add")}
        </button>
      </div>
    </div>
  );
}

/** 서버 줄의 권한 배지(에이전트 사용·파일 전송·출력 표시·무제한 명령·git 원격용). */
function SshServerSummary({ server }: { server: SshEndpointView }) {
  const { text } = useI18n();

  return (
    <small className="ssh-key-endpoint">
      <Server size={12} aria-hidden="true" />
      <code>{serverDestination(server)}</code>
      <em className={server.agentEnabled ? "on" : "off"}>
        <Bot size={11} aria-hidden="true" />
        {server.agentEnabled ? text("에이전트 사용", "Agent enabled") : text("에이전트 사용 꺼짐", "Agent disabled")}
      </em>
      {server.fileTransferEnabled && <em className="on">
        <Upload size={11} aria-hidden="true" />
        {text("파일 전송", "Transfers")}
      </em>}
      {server.terminalEnabled && <em className="on">
        <Terminal size={11} aria-hidden="true" />
        {text("출력 표시", "Output streaming")}
      </em>}
      {server.projectGitEnabled && <em className="on">
        <GitBranch size={11} aria-hidden="true" />
        {text("git 원격용", "Git remotes")}
      </em>}
      {server.unrestrictedCommands && <em className="warn">
        <ShieldAlert size={11} aria-hidden="true" />
        {text("무제한 명령", "Any command")}
      </em>}
    </small>
  );
}

interface SshServerRowProps {
  server: SshEndpointView;
  /** 서버가 가리키는 키. ~/.ssh에서 사라졌으면 null이다. */
  sshKey: SshKeyView | null;
  busy: string | null;
  editing: boolean;
  editor: ReactNode;
  checkReceipt: SshEndpointCheckReceipt | null;
  terminalMode: TerminalSshMode | null;
  onToggleTerminal: (mode: TerminalSshMode) => void;
  onToggleEdit: () => void;
  onCheck: () => void;
  onRemove: () => void;
}

/**
 * 연결 서버 한 줄. 이름·접속 대상·쓰는 키와 권한 배지를 보여 주고, 연결 확인·공개키 등록·
 * 터미널·수정·삭제를 단다. 접근 채널로 잠그는 버튼은 없다 — 로그인한 원격 화면도 호스트와
 * 같은 권한이다(C20, C9-19/C9-20).
 */
function SshServerRow({
  server,
  sshKey,
  busy,
  editing,
  editor,
  checkReceipt,
  terminalMode,
  onToggleTerminal,
  onToggleEdit,
  onCheck,
  onRemove,
}: SshServerRowProps) {
  const { text } = useI18n();
  const label = serverLabel(server);
  const usable = canOpenSshTerminal(server, sshKey);
  const checking = busy === serverTask("server-check", server.id);

  return (
    <div className="plugin-row ssh-server-row">
      <i><Server size={17} /></i>
      <div className="plugin-row-main">
        <div className="plugin-row-name"><strong>{label}</strong></div>
        <SshServerSummary server={server} />
        {sshKey
          ? <small className="ssh-server-key"><KeyRound size={12} aria-hidden="true" />{`${sshKey.fileName} · ${sshKey.algorithm}`}</small>
          : <small className="ssh-server-warning ssh-server-missing-key">
            <AlertTriangle size={12} aria-hidden="true" />
            {text("이 서버가 쓰는 키가 ~/.ssh에 없습니다. 수정에서 다른 키를 고르세요.", "The key this server uses is not in ~/.ssh. Edit the server to choose another key.")}
            <code>{server.fingerprint}</code>
          </small>}
        {sshKey && !sshKey.hasPrivateKey && <small className="ssh-server-warning">
          <AlertTriangle size={12} aria-hidden="true" />
          {text("고른 키에 같은 이름의 개인키가 없어 접속할 수 없습니다.", "The chosen key has no matching private key, so it cannot connect.")}
        </small>}
        {checkReceipt && <p className={`ssh-key-check ${checkReceipt.reachable ? "ok" : "fail"}`}>
          <code>{checkReceipt.destination}</code>{checkReceipt.message}
        </p>}
      </div>
      <div className="plugin-row-actions">
        <div className="plugin-row-action-group">
          {usable && <>
            <button
              className="button compact"
              type="button"
              disabled={busy !== null}
              title={text("저장된 서버에 한 번 붙어 보고 바로 끊습니다", "Connects once with the saved server and disconnects")}
              onClick={onCheck}
            >
              {checking ? <LoaderCircle size={13} className="spin" /> : <PlugZap size={13} />}{text("연결 확인", "Test connection")}
            </button>
            <button
              className="button compact"
              type="button"
              disabled={busy !== null}
              title={text(
                "이 서버가 쓰는 키의 공개키를 서버의 authorized_keys에 등록합니다. 비밀번호를 물으면 열리는 창에서 직접 답하며, 앱은 비밀번호를 저장하지 않습니다",
                "Adds this server's public key to its authorized_keys. Answer the password prompt in the window that opens; the app never stores it",
              )}
              onClick={() => onToggleTerminal("installKey")}
            >
              <KeyRound size={13} />
              {terminalMode === "installKey" ? text("등록 닫기", "Close install") : text("공개키 등록", "Install key")}
            </button>
            <button
              className="button compact"
              type="button"
              disabled={busy !== null}
              title={text(
                "이 서버에 직접 붙는 터미널을 엽니다. 사용자가 치는 명령이라 허용 목록은 적용되지 않습니다",
                "Opens a terminal connected to this server. Commands you type are not filtered by the allow list",
              )}
              onClick={() => onToggleTerminal("shell")}
            >
              <Terminal size={13} />
              {terminalMode === "shell" ? text("터미널 닫기", "Close terminal") : text("터미널", "Terminal")}
            </button>
          </>}
          <button
            className="button compact"
            type="button"
            disabled={busy !== null}
            title={text("주소·인증키·에이전트 권한을 고칩니다", "Edit the address, key and agent permissions")}
            onClick={onToggleEdit}
          >
            <Pencil size={13} />
            {editing ? text("수정 닫기", "Close edit") : text("수정", "Edit")}
          </button>
        </div>
        <div className="plugin-row-action-group plugin-row-management-actions">
          <button
            className="plugin-remove-button"
            type="button"
            disabled={busy !== null}
            aria-label={text(`${label} 서버 삭제`, `Delete server ${label}`)}
            title={text("이 서버를 목록에서 지웁니다. 키 파일은 그대로입니다", "Removes this server. Key files stay")}
            onClick={onRemove}
          >
            {busy === serverTask("server-delete", server.id) ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
          </button>
        </div>
      </div>
      {editor}
      {terminalMode && usable && <div className="ssh-key-terminal"><SshTerminalPanel server={server} sshKey={sshKey} mode={terminalMode} /></div>}
    </div>
  );
}
