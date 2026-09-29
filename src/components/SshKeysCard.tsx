import { Bot, Eye, KeyRound, ShieldAlert, LoaderCircle, NotebookPen, Plus, PlugZap, RefreshCw, RotateCcw, Server, ShieldCheck, Terminal, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { checkSshEndpoint, deleteSshKey, generateSshKey, getSshKeys, getWebAccessStatus, hasTauriRuntime, readSshPublicKey, setSshKeyEndpoint, setSshKeyNote, type WebAccessStatus } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { SshCommandPolicyDefaults, SshEndpointCheckReceipt, SshEndpointView, SshKeysSnapshot, SshKeyView, SshPublicKeyView, TerminalSshMode } from "../types";
import { CopyAction } from "./CopyAction";
import { ErrorBanner, Modal, useConfirm } from "./Shared";
import { canOpenSshTerminal, SshTerminalPanel } from "./TerminalPanel";
import { errorText } from "../lib/errorText";
import { displayPath } from "../lib/displayPath";

const DEFAULT_FILE_NAME = "id_agent_manager";
const DEFAULT_COMMENT = "agent-manager";
const MAX_NOTE_CHARS = 300;
/** 설명(주석)의 한도. 생성 버튼의 비활성 조건과 입력 한도가 같은 값을 봐야 한다. */
const MAX_COMMENT_CHARS = 120;
const DEFAULT_SSH_PORT = "22";

/**
 * 이 카드는 한 번에 한 동작만 돌리고, 지금 도는 동작을 `"갈래:지문"` 문자열 하나로 들고
 * 다닌다. 그 문자열을 만드는 쪽(카드 본문의 `run` 호출)과 읽는 쪽(행·액션 버튼의 스피너
 * 조건)이 서로 떨어져 있어, 양쪽이 같은 리터럴을 각자 손으로 적고 있었다 — 한쪽에서 갈래
 * 이름을 고쳐도 다른 쪽은 조용히 어긋난 채 남는다. 만드는 자리와 읽는 자리를 아래 세
 * 도우미로 모아, 갈래 이름을 타입이 잡게 한다.
 */
type SshKeyTaskKind = "reveal" | "note" | "endpoint" | "check" | "delete";
type SshTask = "create" | `${SshKeyTaskKind}:${string}`;

/** 키 한 건을 대상으로 하는 동작의 표시를 만든다. */
function keyTask(kind: SshKeyTaskKind, fingerprint: string): SshTask {
  return `${kind}:${fingerprint}`;
}

/** 지금 도는 동작이 이 키의 그 갈래인지. 버튼 하나의 스피너 조건이다. */
function isKeyTask(busy: SshTask | null, kind: SshKeyTaskKind, fingerprint: string): boolean {
  return busy === keyTask(kind, fingerprint);
}

/** 갈래를 가리지 않고 이 키를 대상으로 무언가 돌고 있는지. 행 전체를 잠그는 조건이다. */
function isRowBusy(busy: SshTask | null, fingerprint: string): boolean {
  return busy !== null && busy.endsWith(`:${fingerprint}`);
}

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
    fileTransferEnabled: endpoint?.fileTransferEnabled ?? false,
    transferRoot: endpoint?.transferRoot ?? "",
    terminalEnabled: endpoint?.terminalEnabled ?? false,
    unrestrictedCommands: endpoint?.unrestrictedCommands ?? false,
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
    && commandLines(draft.denied).join("\n") === commandLines(saved.denied).join("\n")
    && draft.fileTransferEnabled === saved.fileTransferEnabled
    && draft.transferRoot.trim() === saved.transferRoot
    && draft.terminalEnabled === saved.terminalEnabled
    && draft.unrestrictedCommands === saved.unrestrictedCommands;
}

interface EndpointDraft {
  host: string;
  port: string;
  user: string;
  agentEnabled: boolean;
  allowed: string;
  denied: string;
  fileTransferEnabled: boolean;
  transferRoot: string;
  terminalEnabled: boolean;
  unrestrictedCommands: boolean;
}

/** 메모 편집기가 열렸을 때만 대상 키와 입력 중인 초안을 함께 둔다. */
interface NoteEditorState {
  fingerprint: string;
  draft: string;
}

/** 호스트·사용자 필수 입력과 파일 전송 시의 전송 폴더 입력 유효성을 확인한다. */
function isEndpointDraftValid(draft: EndpointDraft): boolean {
  if (!draft.host.trim() || !draft.user.trim()) return false;
  if (draft.fileTransferEnabled && !draft.transferRoot.trim()) return false;
  return true;
}

/** 저장 또는 해제 시 백엔드로 보낼 SSH 엔드포인트 요청 페이로드를 생성한다. */
function toSshEndpointPayload(fingerprint: string, draft: EndpointDraft, clear = false) {
  const port = Number.parseInt(draft.port.trim(), 10);
  return {
    fingerprint,
    host: clear ? "" : draft.host.trim(),
    port: clear || !Number.isInteger(port) ? null : port,
    user: clear ? "" : draft.user.trim(),
    agentEnabled: clear ? false : draft.agentEnabled,
    allowedCommands: clear ? [] : commandLines(draft.allowed),
    deniedCommands: clear ? [] : commandLines(draft.denied),
    fileTransferEnabled: clear ? false : draft.agentEnabled && draft.fileTransferEnabled,
    transferRoot: clear ? "" : draft.transferRoot.trim(),
    terminalEnabled: clear ? false : draft.agentEnabled && draft.terminalEnabled,
    unrestrictedCommands: clear ? false : draft.agentEnabled && draft.unrestrictedCommands,
  };
}

/**
 * 카드가 백엔드에서 읽어 오는 값과 "한 번에 한 동작" 껍데기. 외부 플러그인 카드의
 * `useExternalPluginsData`와 같은 자리를 이 카드만 컴포넌트 본문에 펼쳐 두고 있어, 화면을
 * 읽으려면 조회 깃발·busy 토큰·오류 배너 배선을 먼저 지나쳐야 했다.
 *
 * 성공했을 때 무엇을 적을지는 여기서 정하지 않는다 — 삭제만 영수증으로 안내를 남기고 나머지는
 * 조용히 끝나므로, `notice`는 상태만 들고 부르는 쪽이 채운다.
 */
function useSshKeysData(active: boolean) {
  const [snapshot, setSnapshot] = useState<SshKeysSnapshot | null>(null);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<SshTask | null>(null);
  const loadedRef = useRef(false);

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
  const run = async (token: SshTask, action: () => Promise<void>) => {
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

  return { snapshot, setSnapshot, access, error, notice, setNotice, busy, load, run };
}

/**
 * 키 한 줄에 딸려 열리는 자리 다섯(공개키 창·메모·연결 서버 편집과 그 확인 결과·대화형 창).
 * 다섯이 서로 지켜야 하는 규칙 — 메모와 연결 서버는 같은 줄을 겹쳐 쓰므로 한쪽을 펴면 다른
 * 쪽을 접는다, 대화형 창은 한 번에 하나만 연다, 사라진 키가 남긴 창은 모두 닫는다 — 이
 * 카드의 동작 함수들 사이에 흩어져 있었다. 어느 함수가 어느 자리를 닫아야 하는지가 그
 * 함수를 다 읽어야만 보였고, 삭제 뒤 정리는 네 줄의 `if`로 같은 판정을 되풀이했다.
 *
 * 열고 닫는 규칙만 여기로 가른다. 무엇을 저장하고 무엇을 조회할지는 부르는 쪽 그대로다.
 */
function useSshKeyRowEditors() {
  const [revealed, setRevealed] = useState<SshPublicKeyView | null>(null);
  const [noteEditor, setNoteEditor] = useState<NoteEditorState | null>(null);
  const [endpointTarget, setEndpointTarget] = useState<string | null>(null);
  const [endpointDraft, setEndpointDraft] = useState<EndpointDraft>(endpointDraftOf(null, null));
  const [checkReceipt, setCheckReceipt] = useState<SshEndpointCheckReceipt | null>(null);
  /**
   * C9-19/C9-20. 대화형 창을 열어 둔 키와 그 갈래. 한 번에 하나만 열어 어느 서버의 무슨
   * 창인지 흐려지지 않게 한다.
   */
  const [terminalTarget, setTerminalTarget] = useState<{ fingerprint: string; mode: TerminalSshMode } | null>(null);

  const openTerminalModeOf = (fingerprint: string): TerminalSshMode | null =>
    terminalTarget?.fingerprint === fingerprint ? terminalTarget.mode : null;
  const toggleTerminal = (fingerprint: string, mode: TerminalSshMode) =>
    setTerminalTarget(openTerminalModeOf(fingerprint) === mode ? null : { fingerprint, mode });

  /**
   * 메모 편집을 연다. 연결 서버 폼과 같은 줄을 쓰므로 여는 쪽이 반대쪽을 닫는다 —
   * `toggleEndpoint`만 한 방향을 막고 있어서 연결 서버를 편 채 메모를 열면 두 폼이 한 행에
   * 겹쳐 쌓였다(QA #90). 연결 서버 초안은 저장본에서 다시 펴지므로 버려도 잃는 것이 없다.
   */
  const toggleNote = (key: SshKeyView) => {
    const closing = noteEditor?.fingerprint === key.fingerprint;
    setNoteEditor(closing ? null : { fingerprint: key.fingerprint, draft: key.note ?? "" });
    if (!closing) {
      setEndpointTarget(null);
      setCheckReceipt(null);
    }
  };
  const changeNoteDraft = (draft: string) =>
    setNoteEditor((current) => (current ? { ...current, draft } : current));
  const closeNote = () => setNoteEditor(null);

  /** 저장본을 입력값으로 펴고, 그 값에 대해 아직 돌리지 않은 연결 확인 결과를 버린다. */
  const showEndpoint = (endpoint: SshEndpointView | null, defaults: SshCommandPolicyDefaults | null) => {
    setEndpointDraft(endpointDraftOf(endpoint, defaults));
    setCheckReceipt(null);
  };

  /** 연결 서버 편집을 연다. 메모와 동시에 열면 줄이 겹치므로 한 번에 하나만 편다. */
  const toggleEndpoint = (key: SshKeyView, defaults: SshCommandPolicyDefaults | null) => {
    const editing = endpointTarget === key.fingerprint;
    setEndpointTarget(editing ? null : key.fingerprint);
    showEndpoint(key.endpoint, defaults);
    if (!editing) setNoteEditor(null);
  };

  const closeEndpoint = () => {
    setEndpointTarget(null);
    setCheckReceipt(null);
  };

  /** 삭제된 키가 열어 두고 있던 자리를 갈래를 가리지 않고 모두 닫는다. */
  const forgetKey = (fingerprint: string) => {
    setRevealed((current) => (current?.fingerprint === fingerprint ? null : current));
    setNoteEditor((current) => (current?.fingerprint === fingerprint ? null : current));
    setTerminalTarget((current) => (current?.fingerprint === fingerprint ? null : current));
    if (endpointTarget === fingerprint) closeEndpoint();
  };

  return {
    revealed, setRevealed,
    noteEditor, toggleNote, changeNoteDraft, closeNote,
    endpointTarget, endpointDraft, setEndpointDraft, showEndpoint, toggleEndpoint, closeEndpoint,
    checkReceipt, setCheckReceipt,
    openTerminalModeOf, toggleTerminal,
    forgetKey,
  };
}

/**
 * 키 한 줄의 세 편집 구역(메모·연결 서버·터미널)이 각각 요구하는 상태와 핸들러를 묶는다.
 * SshKeyRow와 하위 편집기들이 20여 개의 개별 prop을 주고받으며 렌더마다 익명 클로저를
 * 양산하던 구조를 구역별 일관된 바인딩 객체로 정리한다.
 */
interface SshKeyNoteBinding {
  isEditing: boolean;
  draft: string;
  onChangeDraft: (value: string) => void;
  onToggle: () => void;
  onCancel: () => void;
  onSave: () => void;
}

interface SshKeyEndpointBinding {
  isEditing: boolean;
  draft: EndpointDraft;
  onChangeDraft: (draft: EndpointDraft) => void;
  onConfirmUnrestricted: () => Promise<boolean>;
  commandPolicyDefaults: SshCommandPolicyDefaults | null;
  checkReceipt: SshEndpointCheckReceipt | null;
  onToggle: () => void;
  onCancel: () => void;
  onClear: () => void;
  onCheck: () => void;
  onSave: () => void;
}

interface SshKeyTerminalBinding {
  available: boolean;
  openMode: TerminalSshMode | null;
  onToggle: (mode: TerminalSshMode) => void;
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
  const { snapshot, setSnapshot, access, error, notice, setNotice, busy, load, run } = useSshKeysData(active);
  const editors = useSshKeyRowEditors();
  const [adding, setAdding] = useState(false);
  const [fileName, setFileName] = useState(DEFAULT_FILE_NAME);
  const [comment, setComment] = useState(DEFAULT_COMMENT);
  const canWrite = access?.writable === true;
  const isRemote = !hasTauriRuntime() && access?.remote === true;

  const create = () => run("create", async () => {
    await generateSshKey({ fileName: fileName.trim(), comment: comment.trim() });
    await load();
    setAdding(false);
    setFileName(DEFAULT_FILE_NAME);
    setComment(DEFAULT_COMMENT);
  });

  const reveal = (key: SshKeyView) => run(keyTask("reveal", key.fingerprint), async () => {
    editors.setRevealed(await readSshPublicKey({ fileName: key.fileName, fingerprint: key.fingerprint }));
  });

  const saveNote = (key: SshKeyView) => run(keyTask("note", key.fingerprint), async () => {
    setSnapshot(await setSshKeyNote({ fingerprint: key.fingerprint, note: editors.noteEditor?.draft.trim() ?? "" }));
    editors.closeNote();
  });

  /** 저장은 앱 데이터만 바꾼다. 응답으로 온 저장본을 다시 입력값에 펴서, 화면의 값과
   *  저장된 값이 어긋난 채 "연결 확인"이 열리는 일이 없게 한다. */
  const saveEndpoint = (key: SshKeyView, clear = false) => run(keyTask("endpoint", key.fingerprint), async () => {
    const next = await setSshKeyEndpoint(toSshEndpointPayload(key.fingerprint, editors.endpointDraft, clear));
    setSnapshot(next);
    const saved = next.keys.find((entry) => entry.fingerprint === key.fingerprint)?.endpoint ?? null;
    editors.showEndpoint(saved, next.commandPolicyDefaults);
    if (clear) editors.closeEndpoint();
  });

  /** 저장된 지점으로 한 번 붙어 본다. 원격에서는 아무것도 바꾸지 않는다. */
  const checkEndpoint = (key: SshKeyView) => run(keyTask("check", key.fingerprint), async () => {
    editors.setCheckReceipt(await checkSshEndpoint({ fileName: key.fileName, fingerprint: key.fingerprint }));
  });

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
    await run(keyTask("delete", key.fingerprint), async () => {
      const receipt = await deleteSshKey({ fileName: key.fileName, fingerprint: key.fingerprint });
      await load();
      setNotice(text(
        `${receipt.fileName}${receipt.privateKeyMoved ? "와 개인키를" : "를"} ${receipt.trashPath}로 옮겼습니다.`,
        `Moved ${receipt.fileName}${receipt.privateKeyMoved ? " and its private key" : ""} to ${receipt.trashPath}.`,
      ));
      editors.forgetKey(key.fingerprint);
    });
  };

  const noteBindingFor = (key: SshKeyView): SshKeyNoteBinding => ({
    isEditing: editors.noteEditor?.fingerprint === key.fingerprint,
    draft: editors.noteEditor?.fingerprint === key.fingerprint ? editors.noteEditor.draft : "",
    onChangeDraft: editors.changeNoteDraft,
    onToggle: () => editors.toggleNote(key),
    onCancel: editors.closeNote,
    onSave: () => void saveNote(key),
  });

  const endpointBindingFor = (key: SshKeyView): SshKeyEndpointBinding => ({
    isEditing: editors.endpointTarget === key.fingerprint,
    draft: editors.endpointDraft,
    onChangeDraft: editors.setEndpointDraft,
    onConfirmUnrestricted: confirmUnrestricted,
    commandPolicyDefaults: snapshot?.commandPolicyDefaults ?? null,
    checkReceipt: editors.checkReceipt,
    onToggle: () => editors.toggleEndpoint(key, snapshot?.commandPolicyDefaults ?? null),
    onCancel: editors.closeEndpoint,
    onClear: () => void saveEndpoint(key, true),
    onCheck: () => void checkEndpoint(key),
    onSave: () => void saveEndpoint(key),
  });

  const terminalBindingFor = (key: SshKeyView): SshKeyTerminalBinding => ({
    available: !isRemote,
    openMode: editors.openTerminalModeOf(key.fingerprint),
    onToggle: (mode) => editors.toggleTerminal(key.fingerprint, mode),
  });

  return (
    <section className="settings-card ssh-keys-card" data-ui-anchor="addons.ssh-content">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><KeyRound size={18} aria-hidden="true" /></i>
          <div><span>SSH</span><h2>{text("접속정보관리", "Connection settings")}</h2></div>
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
            <span><strong>{text("키 폴더", "Key directory")}</strong><code>{displayPath(snapshot.directoryPath)}</code></span>
            <button className="button compact" type="button" disabled={busy !== null} onClick={() => void load()}><RefreshCw size={13} />{text("새로고침", "Refresh")}</button>
          </div>
          {snapshot.keys.length === 0
            ? <div className="plugin-empty-state ssh-key-empty"><i><KeyRound size={25} /></i><div><strong>{text("확인된 공개키가 없습니다", "No public keys found")}</strong><small>{text("직접 하위의 .pub 파일만 확인하며, 개인키 파일은 열지 않습니다.", "Only direct .pub files are inspected; private-key files are never opened.")}</small></div></div>
            : <div className="plugin-list ssh-key-list">
              {snapshot.keys.map((key) => (
                <SshKeyRow
                  key={key.path}
                  sshKey={key}
                  canWrite={canWrite}
                  busy={busy}
                  note={noteBindingFor(key)}
                  endpoint={endpointBindingFor(key)}
                  terminal={terminalBindingFor(key)}
                  onReveal={() => void reveal(key)}
                  onRemove={() => void remove(key)}
                />
              ))}
            </div>}
          {notice && <p className="ssh-key-notice">{notice}</p>}
          {snapshot.issues.length > 0 && <div className="ssh-key-issues"><strong>{text("읽지 못한 공개키", "Public keys not read")}</strong>{snapshot.issues.map((issue) => <small key={`${issue.path}:${issue.message}`}><code>{displayPath(issue.path)}</code>{issue.message}</small>)}</div>}
          {!adding && <div className="settings-update-body">
            <span className="settings-update-status"><strong>{text("새 SSH 키", "New SSH key")}</strong><small>{canWrite
              ? text("기존 파일을 덮어쓰지 않고 Ed25519 키 쌍을 생성합니다.", "Create an Ed25519 key pair without overwriting existing files.")
              : text("읽기 전용 접속에서는 키를 생성할 수 없습니다.", "Keys cannot be generated from a read-only connection.")}</small></span>
            <button className="button compact primary" type="button" disabled={!canWrite || !snapshot.keygenAvailable} onClick={() => setAdding(true)}><Plus size={13} />{text("키 생성", "Generate key")}</button>
          </div>}
          {adding && <SshKeyCreateCard
            fileName={fileName}
            onChangeFileName={setFileName}
            comment={comment}
            onChangeComment={setComment}
            busy={busy !== null}
            creating={busy === "create"}
            onCancel={() => setAdding(false)}
            onCreate={() => void create()}
          />}
          {!snapshot.keygenAvailable && <p className="ssh-key-unavailable">{text("이 호스트에서 ssh-keygen 실행 파일을 찾지 못해 기존 키 조회만 가능합니다.", "ssh-keygen was not found on this host, so existing keys are read-only.")}</p>}
        </>}
      {error && <ErrorBanner message={error} />}
      {editors.revealed && <SshKeyRevealModal revealed={editors.revealed} onClose={() => editors.setRevealed(null)} />}
      {confirmDialog}
    </section>
  );
}

interface SshEndpointEditorProps {
  sshKey: SshKeyView;
  binding: SshKeyEndpointBinding;
  rowBusy: boolean;
  checking: boolean;
  saving: boolean;
}

/** 연결 서버의 한 줄 문자열 입력. 네 칸이 같은 id·라벨·입력 배선을 되풀이하지 않게 한다. */
function SshEndpointTextField({ id, label, value, placeholder, inputMode, spellCheck, help, onChange }: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  inputMode?: "numeric";
  spellCheck?: boolean;
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
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
    {help && <small>{help}</small>}
  </div>;
}

/** 연결 서버의 여러 줄 명령 목록 칸. 허용·차단 두 칸이 같은 배선을 되풀이하지 않게 한다. */
function SshEndpointTextArea({ id, label, value, placeholder, onChange }: {
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
 * 연결 서버의 권한 스위치 한 줄. 네 줄(에이전트 사용·파일 전송·출력 표시·무제한 명령 허용)이
 * 같은 라벨·체크박스·설명 배치를 각자 적어 두고 있었다. 체크 상태를 어떻게 받아 무엇을
 * 바꿀지는 부르는 쪽이 그대로 남기고, 모양만 여기로 모은다.
 */
function SshEndpointToggleField({ id, title, help, checked, disabled, onChange }: {
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

/** 연결 서버 설정 폼. 호스트·사용자·포트, 에이전트 허용, 파일 전송 폴더, 명령 정책을 편집한다. */
function SshEndpointEditor({
  sshKey,
  binding,
  rowBusy,
  checking,
  saving,
}: SshEndpointEditorProps) {
  const { text } = useI18n();
  const endpointDirty = !sameEndpoint(binding.draft, sshKey.endpoint);
  const canSave = !rowBusy && endpointDirty && isEndpointDraftValid(binding.draft);
  const canCheck = !rowBusy && Boolean(sshKey.endpoint) && !endpointDirty && sshKey.hasPrivateKey;
  const updateEndpointDraft = (patch: Partial<EndpointDraft>) => {
    binding.onChangeDraft({ ...binding.draft, ...patch });
  };
  /** 한 화면에 여러 키의 폼이 열릴 수 있어 칸의 id에 지문을 붙인다. 열 자리가 같은 문법을
   *  각자 적어 두면 라벨과 입력이 어긋나도 드러나지 않는다. */
  const fieldId = (name: string) => `ssh-endpoint-${name}-${sshKey.fingerprint}`;
  /** 에이전트 사용을 끄면 그 아래 권한 셋은 함께 잠긴다. */
  const agentOptionDisabled = !sshKey.hasPrivateKey || !binding.draft.agentEnabled;

  return (
    <div className="ssh-key-endpoint-form">
      <div className="ssh-key-endpoint-fields">
        <SshEndpointTextField id={fieldId("host")} label={text("호스트", "Host")} value={binding.draft.host} placeholder="build.example.com" onChange={(host) => updateEndpointDraft({ host })} />
        <SshEndpointTextField id={fieldId("user")} label={text("사용자", "User")} value={binding.draft.user} placeholder="deploy" onChange={(user) => updateEndpointDraft({ user })} />
        <SshEndpointTextField id={fieldId("port")} label={text("포트", "Port")} value={binding.draft.port} inputMode="numeric" placeholder={DEFAULT_SSH_PORT} onChange={(port) => updateEndpointDraft({ port })} />
      </div>
      <SshEndpointToggleField
        id={fieldId("agent")}
        title={text("에이전트 사용", "Let agents use this key")}
        help={sshKey.hasPrivateKey
          ? text(
            "에이전트가 이 키로 서버에 접속해 작업할 수 있습니다.",
            "Agents can connect to this server and work with this key.",
          )
          : text(
            "같은 이름의 개인키가 없어 이 키로는 접속할 수 없습니다. 접속 지점만 적어 둘 수 있습니다.",
            "There is no matching private key, so this key cannot authenticate. You can still record the endpoint.",
          )}
        checked={binding.draft.agentEnabled}
        disabled={!sshKey.hasPrivateKey}
        onChange={(agentEnabled) => updateEndpointDraft({
          agentEnabled,
          fileTransferEnabled: agentEnabled && binding.draft.fileTransferEnabled,
          terminalEnabled: agentEnabled && binding.draft.terminalEnabled,
          unrestrictedCommands: agentEnabled && binding.draft.unrestrictedCommands,
        })}
      />
      <SshEndpointToggleField
        id={fieldId("upload")}
        title={text("파일 전송", "Let agents transfer files")}
        help={text(
          "에이전트가 이 서버의 전송 폴더 아래로 파일을 올리고 받을 수 있습니다. 명령 허용 목록과 별개의 권한이라, 명령을 열지 않고 산출물만 주고받게 할 수도 있습니다.",
          "Agents may upload and download files under this server's transfer folder. This is a separate permission from the command lists, so you can allow transfers without allowing any command.",
        )}
        checked={binding.draft.fileTransferEnabled}
        disabled={agentOptionDisabled}
        onChange={(fileTransferEnabled) => updateEndpointDraft({ fileTransferEnabled })}
      />
      {binding.draft.fileTransferEnabled && <SshEndpointTextField
        id={fieldId("upload-root")}
        label={text("서버의 전송 폴더", "Transfer folder on the server")}
        value={binding.draft.transferRoot}
        spellCheck={false}
        placeholder="/srv/releases"
        onChange={(transferRoot) => updateEndpointDraft({ transferRoot })}
        help={text(
          "접속하는 서버 안의 경로입니다 — 이 PC의 폴더가 아니므로 C:\\ 같은 Windows 경로는 쓸 수 없습니다. 올리고 받는 대상은 모두 이 폴더 아래 상대 경로로만 정해집니다. 서버 기준 /로 시작하거나 ~/ 아래 경로를 적고, 공백과 상위 이동(..)은 쓸 수 없습니다.",
          "This is a path inside the server you connect to — not a folder on this computer, so Windows paths like C:\\ are not accepted. Both uploads and downloads are resolved only under this folder. Use an absolute path on the server or one under ~/; spaces and parent traversal (..) are refused.",
        )}
      />}
      <SshEndpointToggleField
        id={fieldId("terminal")}
        title={text("출력 표시", "Stream command output")}
        help={text(
          "에이전트가 이 서버에서 실행하는 명령의 출력이 채팅 화면의 도구 카드에 실시간으로 흐릅니다. 자기 셸이 있는 에이전트(Claude·Codex)도 Agent Manager를 거쳐 실행하므로 같은 화면에 나오고, 그 경로에서는 명령 목록이 실제로 집행됩니다. 목록 밖 명령은 승인 카드 없이 거절됩니다.",
          "Output of commands agents run on this server streams live into a tool card in the chat. Agents with their own shell (Claude, Codex) also run through Agent Manager, so they appear on the same screen and the command lists are enforced on that path. Commands outside the lists are refused without an approval card.",
        )}
        checked={binding.draft.terminalEnabled}
        disabled={agentOptionDisabled}
        onChange={(terminalEnabled) => updateEndpointDraft({ terminalEnabled })}
      />
      <SshEndpointToggleField
        id={fieldId("unrestricted")}
        title={text("무제한 명령 허용", "Allow any command")}
        help={text(
          "에이전트가 허용 명령 목록과 상관없이 어떤 명령이든 승인 카드 없이 실행합니다. 결과를 파일로 내보내는 리다이렉션(>, >>)도 이 서버에서만 열립니다. 차단 명령 목록과 셸·인터프리터·네트워크 내려받기 거부는 그대로 남습니다. 믿을 수 있는 서버에만 켜세요.",
          "Agents run any command regardless of the allowed-command list, with no approval card. Redirecting output into a file (>, >>) also opens only here. The denied-command list and the shell, interpreter and network-fetch refusals still stand. Turn this on only for servers you trust.",
        )}
        checked={binding.draft.unrestrictedCommands}
        disabled={agentOptionDisabled}
        onChange={(checked) => {
          // 켜는 쪽만 한 번 더 묻는다. 확인 전에는 초안을 바꾸지 않아, 거절하면 스위치가
          // 켜졌다 돌아오는 깜빡임 없이 그대로 꺼져 있다.
          if (!checked) {
            updateEndpointDraft({ unrestrictedCommands: false });
            return;
          }
          void binding.onConfirmUnrestricted().then((accepted) => {
            if (accepted) updateEndpointDraft({ unrestrictedCommands: true });
          });
        }}
      />
      <details className="ssh-key-advanced">
        <summary>{text("고급 설정 · 명령 목록", "Advanced · command lists")}</summary>
        {binding.draft.unrestrictedCommands && <p className="ssh-key-advanced-override">{text(
          "무제한 명령 허용이 켜져 있어 허용 목록은 지금 쓰이지 않습니다. 차단 목록은 그대로 적용됩니다.",
          "Allow-any-command is on, so the allowed list is not consulted right now. The denied list still applies.",
        )}</p>}
        <p>{text(
          "에이전트가 이 서버에서 쓸 명령을 한 줄에 하나씩 적습니다. 규칙은 명령 앞머리와 맞춰 보며(systemctl status → systemctl status app), 차단이 허용보다 우선합니다. 파이프로 이은 명령은 단계마다 따로 맞춰 보므로 모든 단계가 목록을 지나야 합니다. 허용을 비우면 차단에 걸리지 않는 명령을 모두 쓸 수 있습니다.",
          "One command per line for what agents may run here. A rule matches the start of the command (systemctl status → systemctl status app) and deny wins over allow. A piped command is checked stage by stage, so every stage must pass the lists. Leave allow empty to permit anything not denied.",
        )}</p>
        <SshEndpointTextArea
          id={fieldId("allow")}
          label={text("허용 명령", "Allowed")}
          value={binding.draft.allowed}
          placeholder={text("비우면 차단 목록만 적용됩니다", "Leave empty to apply only the deny list")}
          onChange={(allowed) => updateEndpointDraft({ allowed })}
        />
        <SshEndpointTextArea
          id={fieldId("deny")}
          label={text("차단 명령", "Denied")}
          value={binding.draft.denied}
          onChange={(denied) => updateEndpointDraft({ denied })}
        />
        <div className="ssh-key-advanced-actions">
          <small>{text(
            `허용 ${commandLines(binding.draft.allowed).length}개 · 차단 ${commandLines(binding.draft.denied).length}개 · 각 64개까지`,
            `${commandLines(binding.draft.allowed).length} allowed · ${commandLines(binding.draft.denied).length} denied · up to 64 each`,
          )}</small>
          <button
            className="button compact"
            type="button"
            disabled={rowBusy}
            onClick={() => updateEndpointDraft({
              allowed: (binding.commandPolicyDefaults?.allowed ?? []).join("\n"),
              denied: (binding.commandPolicyDefaults?.denied ?? []).join("\n"),
            })}
          >
            <RotateCcw size={13} />{text("기본값으로", "Reset to defaults")}
          </button>
        </div>
      </details>
      {binding.checkReceipt && <p className={`ssh-key-check ${binding.checkReceipt.reachable ? "ok" : "fail"}`}>
        <code>{binding.checkReceipt.destination}</code>{binding.checkReceipt.message}
      </p>}
      <div className="form-actions">
        <small>{text("이 기기에만 저장되며 .ssh 폴더의 파일은 바뀌지 않습니다", "Stored on this device only; nothing in the .ssh folder changes")}</small>
        <button className="button" type="button" disabled={rowBusy} onClick={binding.onCancel}><X size={13} />{text("취소", "Cancel")}</button>
        {sshKey.endpoint && <button className="button" type="button" disabled={rowBusy} title={text("저장된 연결 서버를 지웁니다", "Removes the saved server")} onClick={binding.onClear}><Trash2 size={13} />{text("해제", "Clear")}</button>}
        <button
          className="button"
          type="button"
          disabled={!canCheck}
          title={endpointDirty
            ? text("저장한 연결 서버로만 확인합니다. 먼저 저장하세요", "The check uses the saved server — save first")
            : text("저장된 지점에 한 번 붙어 보고 바로 끊습니다", "Connects once with the saved endpoint and disconnects")}
          onClick={binding.onCheck}
        >
          {checking ? <LoaderCircle size={13} className="spin" /> : <PlugZap size={13} />}{text("연결 확인", "Test connection")}
        </button>
        <button className="button primary" type="button" disabled={!canSave} onClick={binding.onSave}>
          {saving ? <LoaderCircle size={13} className="spin" /> : <Server size={13} />}{text("저장", "Save")}
        </button>
      </div>
    </div>
  );
}

interface SshNoteEditorProps {
  sshKey: SshKeyView;
  binding: SshKeyNoteBinding;
  rowBusy: boolean;
  saving: boolean;
}

/** SSH 키 메모 입력 폼. 기기 로컬 메모를 작성하거나 지운다. */
function SshNoteEditor({
  sshKey,
  binding,
  rowBusy,
  saving,
}: SshNoteEditorProps) {
  const { text } = useI18n();
  const trimmed = binding.draft.trim();
  const canSave = !rowBusy && trimmed !== (sshKey.note ?? "");

  return (
    <div className="ssh-key-note-form">
      <label htmlFor={`ssh-key-note-${sshKey.fingerprint}`}>{text("메모", "Note")}</label>
      <textarea
        id={`ssh-key-note-${sshKey.fingerprint}`}
        value={binding.draft}
        rows={2}
        maxLength={MAX_NOTE_CHARS}
        placeholder={text("이 키를 어디에 쓰는지 적어 두세요", "Note what this key is used for")}
        onChange={(event) => binding.onChangeDraft(event.target.value)}
      />
      <div className="form-actions">
        <small>{text(`이 기기에만 저장되며 공개키 파일은 바뀌지 않습니다 · ${trimmed.length}/${MAX_NOTE_CHARS}`, `Stored on this device only; the public-key file is untouched · ${trimmed.length}/${MAX_NOTE_CHARS}`)}</small>
        <button className="button" type="button" disabled={rowBusy} onClick={binding.onCancel}><X size={13} />{text("취소", "Cancel")}</button>
        <button className="button primary" type="button" disabled={!canSave} onClick={binding.onSave}>
          {saving ? <LoaderCircle size={13} className="spin" /> : <NotebookPen size={13} />}{trimmed ? text("저장", "Save") : text("메모 지우기", "Clear note")}
        </button>
      </div>
    </div>
  );
}

interface SshKeyRowProps {
  sshKey: SshKeyView;
  canWrite: boolean;
  busy: SshTask | null;
  note: SshKeyNoteBinding;
  endpoint: SshKeyEndpointBinding;
  terminal: SshKeyTerminalBinding;
  onReveal: () => void;
  onRemove: () => void;
}

/** SSH 키 행에 연결 서버 정보(사용자@호스트:포트, 에이전트 허용 여부, 파일 전송 여부)를 표시한다. */
function SshKeyEndpointSummary({ endpoint }: { endpoint: SshEndpointView }) {
  const { text } = useI18n();

  return (
    <small className="ssh-key-endpoint">
      <Server size={12} aria-hidden="true" />
      <code>{`${endpoint.user}@${endpoint.host}:${endpoint.port}`}</code>
      <em className={endpoint.agentEnabled ? "on" : "off"}>
        <Bot size={11} aria-hidden="true" />
        {endpoint.agentEnabled ? text("에이전트 사용", "Agent enabled") : text("에이전트 사용 꺼짐", "Agent disabled")}
      </em>
      {endpoint.fileTransferEnabled && <em className="on">
        <Upload size={11} aria-hidden="true" />
        {text("파일 전송", "Transfers")}
      </em>}
      {endpoint.terminalEnabled && <em className="on">
        <Terminal size={11} aria-hidden="true" />
        {text("출력 표시", "Output streaming")}
      </em>}
      {endpoint.unrestrictedCommands && <em className="warn">
        <ShieldAlert size={11} aria-hidden="true" />
        {text("무제한 명령", "Any command")}
      </em>}
    </small>
  );
}

interface SshKeyRowActionsProps {
  sshKey: SshKeyView;
  canWrite: boolean;
  busy: SshTask | null;
  note: SshKeyNoteBinding;
  endpoint: SshKeyEndpointBinding;
  terminal: SshKeyTerminalBinding;
  onReveal: () => void;
  onRemove: () => void;
}

/**
 * SSH 키 행 액션 버튼 그룹. 공개키 보기, 메모 편집, 연결 서버 편집, 공개키 등록, 터미널
 * 열기, 키 삭제 액션을 제공한다.
 */
function SshKeyRowActions({
  sshKey,
  canWrite,
  busy,
  note,
  endpoint,
  terminal,
  onReveal,
  onRemove,
}: SshKeyRowActionsProps) {
  const { text } = useI18n();

  return (
    <div className="plugin-row-actions">
      <div className="plugin-row-action-group">
        <button
          className="button compact"
          type="button"
          disabled={busy !== null}
          title={text("공개키 한 줄을 그대로 보여 줍니다", "Shows the public-key line as it is stored")}
          onClick={onReveal}
        >
          {isKeyTask(busy, "reveal", sshKey.fingerprint) ? <LoaderCircle size={13} className="spin" /> : <Eye size={13} />}
          {text("공개키 확인", "View key")}
        </button>
        <button
          className="button compact"
          type="button"
          disabled={!canWrite || busy !== null}
          title={canWrite
            ? text("이 기기에만 저장되는 메모입니다", "A note stored on this device only")
            : text("읽기 전용 접속에서는 메모를 바꿀 수 없습니다", "Notes cannot be changed from a read-only connection")}
          onClick={note.onToggle}
        >
          <NotebookPen size={13} />
          {sshKey.note ? text("메모 편집", "Edit note") : text("메모", "Add note")}
        </button>
        <button
          className="button compact"
          type="button"
          disabled={!canWrite || busy !== null}
          title={canWrite
            ? text("이 키로 붙을 서버를 적고, 에이전트에게 열어 줄지 정합니다", "Set the server this key connects to and whether agents may use it")
            : text("읽기 전용 접속에서는 연결 서버를 바꿀 수 없습니다", "Servers cannot be changed from a read-only connection")}
          onClick={endpoint.onToggle}
        >
          <Server size={13} />
          {sshKey.endpoint ? text("연결 서버 편집", "Edit server") : text("연결 서버", "Add server")}
        </button>
        {terminal.available && canOpenSshTerminal(sshKey) && <>
          <button
            className="button compact"
            type="button"
            disabled={busy !== null}
            title={text(
              "이 공개키를 서버의 authorized_keys에 등록합니다. 비밀번호를 물으면 열리는 창에서 직접 답하며, 앱은 비밀번호를 저장하지 않습니다",
              "Adds this public key to the server's authorized_keys. Answer the password prompt in the window that opens; the app never stores it",
            )}
            onClick={() => terminal.onToggle("installKey")}
          >
            <KeyRound size={13} />
            {terminal.openMode === "installKey"
              ? text("등록 닫기", "Close install")
              : text("공개키 등록", "Install key")}
          </button>
          <button
            className="button compact"
            type="button"
            disabled={busy !== null}
            title={text(
              "이 서버에 직접 붙는 터미널을 엽니다. 사용자가 치는 명령이라 허용 목록은 적용되지 않습니다",
              "Opens a terminal connected to this server. Commands you type are not filtered by the allow list",
            )}
            onClick={() => terminal.onToggle("shell")}
          >
            <Terminal size={13} />
            {terminal.openMode === "shell" ? text("터미널 닫기", "Close terminal") : text("터미널", "Terminal")}
          </button>
        </>}
      </div>
      <div className="plugin-row-action-group plugin-row-management-actions">
        <button
          className="plugin-remove-button"
          type="button"
          disabled={!canWrite || busy !== null}
          aria-label={text(`${sshKey.fileName} 삭제`, `Delete ${sshKey.fileName}`)}
          title={canWrite
            ? text("키 쌍을 .ssh 안 휴지통으로 옮깁니다", "Moves the key pair to the trash folder inside .ssh")
            : text("읽기 전용 접속에서는 키를 지울 수 없습니다", "Keys cannot be removed from a read-only connection")}
          onClick={onRemove}
        >
          {isKeyTask(busy, "delete", sshKey.fingerprint) ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  );
}

/** 단일 SSH 키 행 컴포넌트. 키 정보 요약과 액션 버튼, 메모·연결 서버 편집 영역을 렌더링한다. */
function SshKeyRow({
  sshKey,
  canWrite,
  busy,
  note,
  endpoint,
  terminal,
  onReveal,
  onRemove,
}: SshKeyRowProps) {
  const { text } = useI18n();
  const rowBusy = isRowBusy(busy, sshKey.fingerprint);

  return (
    <div className="plugin-row" key={sshKey.path}>
      <i><KeyRound size={17} /></i>
      <div className="plugin-row-main">
        <div className="plugin-row-name"><strong>{sshKey.fileName}</strong><code>{sshKey.algorithm}</code></div>
        <small>{displayPath(sshKey.path)}</small>
        <code className="ssh-key-fingerprint">{sshKey.fingerprint}</code>
        {sshKey.comment && <small>{text("설명", "Comment")} · {sshKey.comment}</small>}
        {sshKey.note && !note.isEditing && <small className="ssh-key-note"><NotebookPen size={12} aria-hidden="true" />{sshKey.note}</small>}
        {sshKey.endpoint && <SshKeyEndpointSummary endpoint={sshKey.endpoint} />}
        <span className={`plugin-status ${sshKey.hasPrivateKey ? "ok" : "warn"}`}><i />{sshKey.hasPrivateKey ? text("개인키 쌍 확인", "Private pair found") : text("공개키만 있음", "Public key only")}</span>
      </div>
      <SshKeyRowActions
        sshKey={sshKey}
        canWrite={canWrite}
        busy={busy}
        note={note}
        endpoint={endpoint}
        terminal={terminal}
        onReveal={onReveal}
        onRemove={onRemove}
      />
      {endpoint.isEditing && <SshEndpointEditor
        sshKey={sshKey}
        binding={endpoint}
        rowBusy={rowBusy}
        checking={isKeyTask(busy, "check", sshKey.fingerprint)}
        saving={isKeyTask(busy, "endpoint", sshKey.fingerprint)}
      />}
      {terminal.openMode && <div className="ssh-key-terminal"><SshTerminalPanel sshKey={sshKey} mode={terminal.openMode} /></div>}
      {note.isEditing && <SshNoteEditor
        sshKey={sshKey}
        binding={note}
        rowBusy={rowBusy}
        saving={isKeyTask(busy, "note", sshKey.fingerprint)}
      />}
    </div>
  );
}

interface SshKeyCreateCardProps {
  fileName: string;
  onChangeFileName: (value: string) => void;
  comment: string;
  onChangeComment: (value: string) => void;
  busy: boolean;
  creating: boolean;
  onCancel: () => void;
  onCreate: () => void;
}

/** 새 Ed25519 SSH 키 생성 카드. 파일 이름과 설명을 받아 키 쌍을 생성한다. */
function SshKeyCreateCard({
  fileName,
  onChangeFileName,
  comment,
  onChangeComment,
  busy,
  creating,
  onCancel,
  onCreate,
}: SshKeyCreateCardProps) {
  const { text } = useI18n();
  const canCreate = !busy && Boolean(fileName.trim()) && comment.length <= MAX_COMMENT_CHARS;

  return (
    <div className="detail-card ssh-key-form">
      <div className="plugin-row-name"><strong>{text("Ed25519 키 생성", "Generate Ed25519 key")}</strong><code>ssh-keygen</code></div>
      <div className="form-row">
        <label htmlFor="ssh-key-file-name">{text("파일 이름", "File name")}</label>
        <input
          id="ssh-key-file-name"
          value={fileName}
          autoComplete="off"
          placeholder={DEFAULT_FILE_NAME}
          onChange={(event) => onChangeFileName(event.target.value)}
        />
      </div>
      <div className="form-row">
        <label htmlFor="ssh-key-comment">{text("설명", "Comment")}</label>
        <span className="ssh-key-comment-field">
          <input
            id="ssh-key-comment"
            value={comment}
            autoComplete="off"
            maxLength={MAX_COMMENT_CHARS}
            placeholder={DEFAULT_COMMENT}
            onChange={(event) => onChangeComment(event.target.value)}
          />
          <small>{text(`${comment.length}/${MAX_COMMENT_CHARS}자`, `${comment.length}/${MAX_COMMENT_CHARS} characters`)}</small>
        </span>
      </div>
      <p className="plugin-form-note"><ShieldCheck size={13} />{text(
        "개인키는 0600 권한의 암호 없는 키로 생성되며 앱은 그 내용을 읽지 않습니다. 암호가 필요한 키는 터미널의 ssh-keygen으로 직접 생성하세요.",
        "The private key is created unencrypted with 0600 permissions and is never read by the app. Use ssh-keygen in a terminal when a passphrase is required.",
      )}</p>
      <div className="form-actions">
        <button className="button" type="button" disabled={busy} onClick={onCancel}><X size={13} />{text("취소", "Cancel")}</button>
        <button className="button primary" type="button" disabled={!canCreate} onClick={onCreate}>
          {creating ? <LoaderCircle size={13} className="spin" /> : <KeyRound size={13} />}{creating ? text("생성 중…", "Generating…") : text("생성", "Generate")}
        </button>
      </div>
    </div>
  );
}

interface SshKeyRevealModalProps {
  revealed: SshPublicKeyView;
  onClose: () => void;
}

/** 공개키 내용 확인 모달. 공개키 전문 복사와 지문을 제공한다. */
function SshKeyRevealModal({ revealed, onClose }: SshKeyRevealModalProps) {
  const { text } = useI18n();

  return (
    <Modal
      title={<><Eye size={15} /><span>{text("공개키 확인", "Public key")}</span></>}
      onClose={onClose}
      footer={<button className="button" type="button" onClick={onClose}>{text("닫기", "Close")}</button>}
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
    </Modal>
  );
}
