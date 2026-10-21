import { Eye, KeyRound, LoaderCircle, LockKeyhole, NotebookPen, Plus, RefreshCw, Server, ShieldCheck, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteSshKey, generateSshKey, getSshKeys, readSshPublicKey, setSshKeyNote, setSshKeyPassphrase } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { SshEndpointView, SshKeysSnapshot, SshKeyTypeOption, SshKeyView, SshPublicKeyView } from "../types";
import { CopyAction } from "./CopyAction";
import { ErrorBanner, Modal, useConfirm } from "./Shared";
import { serverLabel, SshServersSection, type SshServerTask } from "./SshServersSection";
import { errorText } from "../lib/errorText";
import { displayPath } from "../lib/displayPath";

const DEFAULT_FILE_NAME = "id_agent_manager";
const DEFAULT_COMMENT = "agent-manager";
/** 백엔드가 키 종류 목록을 주지 않을 때(옛 백엔드) 쓰는 기본 종류. */
const DEFAULT_KEY_TYPE = "ed25519";
const MAX_NOTE_CHARS = 300;
/** 설명(주석)의 한도. 생성 버튼의 비활성 조건과 입력 한도가 같은 값을 봐야 한다. */
const MAX_COMMENT_CHARS = 120;

/**
 * 이 카드는 한 번에 한 동작만 돌리고, 지금 도는 동작을 `"갈래:대상"` 문자열 하나로 들고
 * 다닌다. 그 문자열을 만드는 쪽(카드 본문의 `run` 호출)과 읽는 쪽(행·액션 버튼의 스피너
 * 조건)이 서로 떨어져 있어, 양쪽이 같은 리터럴을 각자 손으로 적고 있었다 — 한쪽에서 갈래
 * 이름을 고쳐도 다른 쪽은 조용히 어긋난 채 남는다. 만드는 자리와 읽는 자리를 아래 세
 * 도우미로 모아, 갈래 이름을 타입이 잡게 한다. 연결 서버 갈래는 서버 구역이 따로 정한다.
 */
type SshKeyTaskKind = "reveal" | "note" | "passphrase" | "delete";
type SshTask = "create" | `${SshKeyTaskKind}:${string}` | SshServerTask;

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

/** 키 한 줄에 펴는 입력 상자. 메모와 암호는 같은 줄을 겹쳐 쓰므로 한 번에 하나만 연다. */
interface KeyEditorState {
  kind: "note" | "passphrase";
  fingerprint: string;
  draft: string;
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
    void load();
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

  return { snapshot, setSnapshot, error, notice, setNotice, busy, load, run };
}

/**
 * 키 한 줄에 딸려 열리는 자리(공개키 창·메모·암호). 메모와 암호는 같은 줄을 겹쳐 쓰므로
 * 한쪽을 펴면 다른 쪽을 접고, 사라진 키가 남긴 자리는 모두 닫는다. 연결 서버 편집·확인·
 * 터미널은 서버 단위라 서버 구역이 따로 든다.
 *
 * 열고 닫는 규칙만 여기로 가른다. 무엇을 저장하고 무엇을 조회할지는 부르는 쪽 그대로다.
 */
function useSshKeyRowEditors() {
  const [revealed, setRevealed] = useState<SshPublicKeyView | null>(null);
  const [keyEditor, setKeyEditor] = useState<KeyEditorState | null>(null);

  const editorOf = (kind: KeyEditorState["kind"], fingerprint: string) =>
    keyEditor?.kind === kind && keyEditor.fingerprint === fingerprint ? keyEditor : null;

  /** 메모 편집을 연다. 같은 줄의 암호 상자는 닫힌다 — 줄 하나에 두 폼이 겹쳐 쌓이지 않게 한다(QA #90). */
  const toggleNote = (key: SshKeyView) =>
    setKeyEditor(editorOf("note", key.fingerprint) ? null : { kind: "note", fingerprint: key.fingerprint, draft: key.note ?? "" });

  /** 암호 상자를 연다. 입력값은 언제나 빈 칸에서 시작한다 — 저장된 암호는 화면으로 오지 않는다. */
  const togglePassphrase = (key: SshKeyView) =>
    setKeyEditor(editorOf("passphrase", key.fingerprint) ? null : { kind: "passphrase", fingerprint: key.fingerprint, draft: "" });

  const changeDraft = (draft: string) =>
    setKeyEditor((current) => (current ? { ...current, draft } : current));
  const closeKeyEditor = () => setKeyEditor(null);

  /** 삭제된 키가 열어 두고 있던 자리를 갈래를 가리지 않고 모두 닫는다. */
  const forgetKey = (fingerprint: string) => {
    setRevealed((current) => (current?.fingerprint === fingerprint ? null : current));
    setKeyEditor((current) => (current?.fingerprint === fingerprint ? null : current));
  };

  return {
    revealed, setRevealed,
    keyEditor, editorOf, toggleNote, togglePassphrase, changeDraft, closeKeyEditor,
    forgetKey,
  };
}

/**
 * 키 한 줄의 두 입력 상자(메모·암호)가 각각 요구하는 상태와 핸들러를 묶는다. SshKeyRow와
 * 하위 편집기들이 개별 prop을 주고받으며 렌더마다 익명 클로저를 양산하지 않게 한다.
 */
interface SshKeyNoteBinding {
  isEditing: boolean;
  draft: string;
  onChangeDraft: (value: string) => void;
  onToggle: () => void;
  onCancel: () => void;
  onSave: () => void;
}

interface SshKeyPassphraseBinding {
  isEditing: boolean;
  draft: string;
  onChangeDraft: (value: string) => void;
  onToggle: () => void;
  onCancel: () => void;
  onSave: () => void;
  onForget: () => void;
}

/**
 * 로컬 ~/.ssh 공개키의 메타데이터만 보여 주고, 새 키(Ed25519·RSA·ECDSA)를 충돌 없이 생성한다.
 * 공개키 본문 확인·키 삭제·기기 단위 메모·키 암호 저장, 그리고 키와 따로 저장되는 연결 서버
 * 목록까지 여기서 하며, 개인키는 어떤 경로로도 열지 않는다 — 삭제도 ~/.ssh 안 휴지통으로
 * 옮기는 것이라 되돌릴 수 있다.
 *
 * 이 카드에는 호스트 전용 작업이 없다(C9-5/C9-10). 생성은 검증된 새 경로에만 만들고 삭제는
 * 휴지통으로 옮기는 것이라 되돌릴 수 있고, 로그인한 채널은 데스크톱과 같은 권한을 가지므로
 * (C20) 원격 화면에서도 메모·연결 서버·키 생성·삭제·터미널·공개키 등록이 전부 호스트와
 * 같이 동작한다. 그래서 접근 채널을 따로 묻지 않는다 — 버튼을 잠그는 것은 진행 중인 작업뿐이다.
 * 고급 설정의 명령 목록은 그 서버에서 무엇까지 하게 할지에 대한 사용자 결정이고, 스킬이
 * 에이전트에게 지켜야 할 규칙으로 전달한다.
 */
export function SshKeysCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const { snapshot, setSnapshot, error, notice, setNotice, busy, load, run } = useSshKeysData(active);
  const editors = useSshKeyRowEditors();
  const [adding, setAdding] = useState(false);
  const [fileName, setFileName] = useState(DEFAULT_FILE_NAME);
  const [comment, setComment] = useState(DEFAULT_COMMENT);
  /** 빈 값은 "백엔드 목록의 첫 종류"다. 목록이 오기 전에도 상태를 정할 수 있게 둔다. */
  const [keyType, setKeyType] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const keyTypes = snapshot?.keyTypes ?? [];
  const selectedKeyType = keyType || keyTypes[0]?.id || DEFAULT_KEY_TYPE;

  const resetPassphrase = () => {
    setPassphrase("");
    setPassphraseConfirm("");
  };

  const create = () => run("create", async () => {
    try {
      await generateSshKey({
        fileName: fileName.trim(),
        comment: comment.trim(),
        keyType: selectedKeyType,
        // 암호는 공백도 값이라 다듬지 않는다. 빈 칸은 암호 없는 키다.
        passphrase: passphrase.length > 0 ? passphrase : null,
      });
    } catch (cause) {
      // 백엔드는 키를 게시한 뒤에도 실패를 돌려줄 수 있다(암호를 보안 저장소에 넣지 못한 경우).
      // 목록은 새로 고쳐 방금 생긴 키를 보이게 하되, 오류 문구는 그대로 남긴다.
      await getSshKeys().then(setSnapshot, () => undefined);
      throw cause;
    }
    await load();
    setAdding(false);
    setFileName(DEFAULT_FILE_NAME);
    setComment(DEFAULT_COMMENT);
    setKeyType("");
    resetPassphrase();
  });

  /** 취소는 파일 이름·설명은 남기지만 암호는 지운다 — 닫힌 폼에 암호를 들고 있을 이유가 없다. */
  const cancelCreate = () => {
    setAdding(false);
    resetPassphrase();
  };

  /** 연결 서버 구역의 "키 생성" 바로가기. 폼을 열고 첫 칸으로 옮겨 화면 밖이어도 보이게 한다. */
  const openCreate = () => {
    setAdding(true);
    requestAnimationFrame(() => document.getElementById("ssh-key-file-name")?.focus());
  };

  const reveal = (key: SshKeyView) => run(keyTask("reveal", key.fingerprint), async () => {
    editors.setRevealed(await readSshPublicKey({ fileName: key.fileName, fingerprint: key.fingerprint }));
  });

  const saveNote = (key: SshKeyView) => run(keyTask("note", key.fingerprint), async () => {
    setSnapshot(await setSshKeyNote({ fingerprint: key.fingerprint, note: editors.keyEditor?.draft.trim() ?? "" }));
    editors.closeKeyEditor();
  });

  /** 백엔드가 ssh-keygen으로 맞는 암호인지 확인한 뒤에만 저장한다. 틀리면 배너에 사유가 뜬다. */
  const savePassphrase = (key: SshKeyView) => run(keyTask("passphrase", key.fingerprint), async () => {
    const value = editors.keyEditor?.draft ?? "";
    if (!value) return;
    setSnapshot(await setSshKeyPassphrase({ fileName: key.fileName, fingerprint: key.fingerprint, passphrase: value }));
    editors.closeKeyEditor();
  });

  const forgetPassphrase = async (key: SshKeyView) => {
    const accepted = await confirm({
      title: text("저장된 암호 지우기", "Forget saved passphrase"),
      message: text(
        `"${key.fileName}"의 암호를 보안 저장소에서 지웁니다. 키 파일에 걸린 암호는 바뀌지 않으며, 에이전트가 이 키로 접속하려면 암호를 다시 저장해야 합니다.`,
        `The passphrase for "${key.fileName}" will be removed from secure storage. The key file itself stays locked; save the passphrase again before agents can connect with this key.`,
      ),
      items: [key.fingerprint],
      confirmLabel: text("지우기", "Forget"),
      tone: "danger",
    });
    if (!accepted) return;
    await run(keyTask("passphrase", key.fingerprint), async () => {
      setSnapshot(await setSshKeyPassphrase({ fileName: key.fileName, fingerprint: key.fingerprint, passphrase: "" }));
      editors.closeKeyEditor();
    });
  };

  const serversUsing = (key: SshKeyView): SshEndpointView[] =>
    (snapshot?.servers ?? []).filter((server) => server.fingerprint === key.fingerprint);

  const remove = async (key: SshKeyView) => {
    const using = serversUsing(key);
    const accepted = await confirm({
      title: text("SSH 키 삭제", "Delete SSH key"),
      message: text(
        `"${key.fileName}"${key.hasPrivateKey ? "와 같은 이름의 개인키를" : "를"} .ssh 폴더 안의 휴지통(.agent-manager-trash)으로 옮깁니다. 이 키로 접속하던 서버·저장소는 더 이상 인증되지 않습니다.`
          + (using.length > 0 ? ` 이 키를 쓰는 연결 서버 ${using.length}개는 지워지지 않고 남지만, 키를 되돌리거나 수정에서 다른 키를 고를 때까지 접속할 수 없습니다.` : "")
          + (key.passphraseSaved ? " 저장된 암호도 보안 저장소에서 지웁니다." : ""),
        `"${key.fileName}"${key.hasPrivateKey ? " and its private key" : ""} will be moved to the .agent-manager-trash folder inside .ssh. Servers and repositories that relied on this key will no longer authenticate.`
          + (using.length > 0 ? ` ${using.length} server(s) using this key will stay but cannot connect until the key is restored or they are switched to another key.` : "")
          + (key.passphraseSaved ? " The saved passphrase is removed from secure storage as well." : ""),
      ),
      items: [
        key.fingerprint,
        ...(key.note ? [key.note] : []),
        ...using.map((server) => text(`연결 서버 · ${serverLabel(server)}`, `Server · ${serverLabel(server)}`)),
      ],
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
      const servers = receipt.serversUsingKey.join(", ");
      setNotice(text(
        `${receipt.fileName}${receipt.privateKeyMoved ? "와 개인키를" : "를"} ${receipt.trashPath}로 옮겼습니다.`
          + (receipt.passphraseRemoved ? " 저장된 암호도 지웠습니다." : "")
          + (receipt.serversUsingKey.length > 0 ? ` 이 키를 쓰던 연결 서버(${servers})는 남아 있지만, 수정에서 다른 키를 고르기 전까지 접속할 수 없습니다.` : ""),
        `Moved ${receipt.fileName}${receipt.privateKeyMoved ? " and its private key" : ""} to ${receipt.trashPath}.`
          + (receipt.passphraseRemoved ? " The saved passphrase was removed too." : "")
          + (receipt.serversUsingKey.length > 0 ? ` Servers that used this key (${servers}) remain but cannot connect until you choose another key for them.` : ""),
      ));
      editors.forgetKey(key.fingerprint);
    });
  };

  const noteBindingFor = (key: SshKeyView): SshKeyNoteBinding => {
    const editor = editors.editorOf("note", key.fingerprint);
    return {
      isEditing: editor !== null,
      draft: editor?.draft ?? "",
      onChangeDraft: editors.changeDraft,
      onToggle: () => editors.toggleNote(key),
      onCancel: editors.closeKeyEditor,
      onSave: () => void saveNote(key),
    };
  };

  const passphraseBindingFor = (key: SshKeyView): SshKeyPassphraseBinding => {
    const editor = editors.editorOf("passphrase", key.fingerprint);
    return {
      isEditing: editor !== null,
      draft: editor?.draft ?? "",
      onChangeDraft: editors.changeDraft,
      onToggle: () => editors.togglePassphrase(key),
      onCancel: editors.closeKeyEditor,
      onSave: () => void savePassphrase(key),
      onForget: () => void forgetPassphrase(key),
    };
  };

  return (
    <section className="settings-card ssh-keys-card" data-ui-anchor="addons.ssh-content">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><KeyRound size={18} aria-hidden="true" /></i>
          <div><span>SSH</span><h2>{text("접속정보관리", "Connection settings")}</h2></div>
        </div>
        <p>{text(
          "로컬 .ssh 폴더의 공개키 알고리즘과 지문을 확인하고, 연결 서버마다 접속에 쓸 키를 고릅니다. 공개키 본문은 필요할 때만 펼쳐 보고, 개인키 내용은 읽거나 화면으로 보내지 않습니다. 서버에서 에이전트 사용을 켜면 에이전트가 그 서버에 접속해 작업할 수 있습니다.",
          "Inspect public-key algorithms and fingerprints in the local .ssh folder and pick the key each server connects with. Public-key bodies are shown on request; private-key contents are never read or sent to the UI. Turn on agent use for a server and agents may connect to it.",
        )}</p>
      </header>
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
                  servers={serversUsing(key)}
                  busy={busy}
                  note={noteBindingFor(key)}
                  passphrase={passphraseBindingFor(key)}
                  onReveal={() => void reveal(key)}
                  onRemove={() => void remove(key)}
                />
              ))}
            </div>}
          {notice && <p className="ssh-key-notice">{notice}</p>}
          {snapshot.issues.length > 0 && <div className="ssh-key-issues"><strong>{text("읽지 못한 공개키", "Public keys not read")}</strong>{snapshot.issues.map((issue) => <small key={`${issue.path}:${issue.message}`}><code>{displayPath(issue.path)}</code>{issue.message}</small>)}</div>}
          {!adding && <div className="settings-update-body">
            <span className="settings-update-status"><strong>{text("새 SSH 키", "New SSH key")}</strong><small>{text("기존 파일을 덮어쓰지 않고 새 키 쌍(Ed25519·RSA·ECDSA)을 생성합니다.", "Create a new key pair (Ed25519, RSA or ECDSA) without overwriting existing files.")}</small></span>
            <button className="button compact primary" type="button" disabled={!snapshot.keygenAvailable} onClick={() => setAdding(true)}><Plus size={13} />{text("키 생성", "Generate key")}</button>
          </div>}
          {adding && <SshKeyCreateCard
            fileName={fileName}
            onChangeFileName={setFileName}
            comment={comment}
            onChangeComment={setComment}
            keyTypes={keyTypes}
            keyType={selectedKeyType}
            onChangeKeyType={setKeyType}
            passphrase={passphrase}
            onChangePassphrase={setPassphrase}
            passphraseConfirm={passphraseConfirm}
            onChangePassphraseConfirm={setPassphraseConfirm}
            busy={busy !== null}
            creating={busy === "create"}
            onCancel={cancelCreate}
            onCreate={() => void create()}
          />}
          {!snapshot.keygenAvailable && <p className="ssh-key-unavailable">{text("이 호스트에서 ssh-keygen 실행 파일을 찾지 못해 기존 키 조회만 가능합니다.", "ssh-keygen was not found on this host, so existing keys are read-only.")}</p>}
          <SshServersSection
            snapshot={snapshot}
            setSnapshot={setSnapshot}
            busy={busy}
            run={run}
            confirm={confirm}
            onGenerateKey={openCreate}
          />
        </>}
      {error && <ErrorBanner message={error} />}
      {editors.revealed && <SshKeyRevealModal revealed={editors.revealed} onClose={() => editors.setRevealed(null)} />}
      {confirmDialog}
    </section>
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

interface SshPassphraseEditorProps {
  sshKey: SshKeyView;
  binding: SshKeyPassphraseBinding;
  rowBusy: boolean;
  saving: boolean;
}

/**
 * C9-21. 이미 있는 키의 암호를 저장하거나 지우는 상자. 입력은 백엔드가 ssh-keygen으로 맞는지
 * 확인한 뒤에만 OS 보안 저장소에 들어가고, 저장된 값은 다시 화면으로 오지 않는다.
 */
function SshPassphraseEditor({ sshKey, binding, rowBusy, saving }: SshPassphraseEditorProps) {
  const { text } = useI18n();
  const id = `ssh-key-passphrase-${sshKey.fingerprint}`;

  return (
    <div className="ssh-key-passphrase-form">
      <label htmlFor={id}>{sshKey.passphraseSaved ? text("새 암호", "New passphrase") : text("키 암호", "Key passphrase")}</label>
      <input
        id={id}
        type="password"
        value={binding.draft}
        autoComplete="off"
        spellCheck={false}
        placeholder={text("이 키를 만들 때 정한 암호", "The passphrase set when this key was created")}
        onChange={(event) => binding.onChangeDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && binding.draft && !rowBusy) binding.onSave();
        }}
      />
      <div className="form-actions">
        <small>{text(
          "맞는 암호인지 확인한 뒤 보안 저장소에 저장하며, 다시 보여 주지 않습니다. 에이전트는 이 키를 앱을 거쳐서만 씁니다.",
          "Checked against the key, then kept in secure storage and never shown again. Agents use this key only through the app.",
        )}</small>
        <button className="button" type="button" disabled={rowBusy} onClick={binding.onCancel}><X size={13} />{text("취소", "Cancel")}</button>
        {sshKey.passphraseSaved && <button className="button" type="button" disabled={rowBusy} onClick={binding.onForget}><Trash2 size={13} />{text("저장된 암호 지우기", "Forget saved passphrase")}</button>}
        <button className="button primary" type="button" disabled={rowBusy || !binding.draft} onClick={binding.onSave}>
          {saving ? <LoaderCircle size={13} className="spin" /> : <LockKeyhole size={13} />}{text("암호 저장", "Save passphrase")}
        </button>
      </div>
    </div>
  );
}

interface SshKeyRowProps {
  sshKey: SshKeyView;
  /** 이 키를 쓰는 연결 서버. 키 줄에는 이름만 싣고 편집은 서버 구역에서 한다. */
  servers: SshEndpointView[];
  busy: SshTask | null;
  note: SshKeyNoteBinding;
  passphrase: SshKeyPassphraseBinding;
  onReveal: () => void;
  onRemove: () => void;
}

/**
 * SSH 키 행 액션 버튼 그룹. 공개키 보기, 메모 편집, 암호 저장, 키 삭제를 제공한다. 연결 확인·
 * 터미널·공개키 등록은 서버 단위라 연결 서버 줄에 있다. 접근 채널로 잠그는 버튼은 없다 —
 * 로그인한 원격 화면도 호스트와 같은 권한이다(C20).
 */
function SshKeyRowActions({
  sshKey,
  busy,
  note,
  passphrase,
  onReveal,
  onRemove,
}: Omit<SshKeyRowProps, "servers">) {
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
          disabled={busy !== null}
          title={text("이 기기에만 저장되는 메모입니다", "A note stored on this device only")}
          onClick={note.onToggle}
        >
          <NotebookPen size={13} />
          {sshKey.note ? text("메모 편집", "Edit note") : text("메모", "Add note")}
        </button>
        {sshKey.hasPrivateKey && <button
          className="button compact"
          type="button"
          disabled={busy !== null}
          title={text(
            "암호가 걸린 키의 암호를 보안 저장소에 저장합니다. 저장하면 에이전트가 앱을 거쳐 이 키를 쓸 수 있습니다",
            "Saves the passphrase of a locked key in secure storage so agents can use the key through the app",
          )}
          onClick={passphrase.onToggle}
        >
          <LockKeyhole size={13} />
          {sshKey.passphraseSaved ? text("암호 변경", "Change passphrase") : text("암호 저장", "Save passphrase")}
        </button>}
      </div>
      <div className="plugin-row-action-group plugin-row-management-actions">
        <button
          className="plugin-remove-button"
          type="button"
          disabled={busy !== null}
          aria-label={text(`${sshKey.fileName} 삭제`, `Delete ${sshKey.fileName}`)}
          title={text("키 쌍을 .ssh 안 휴지통으로 옮깁니다", "Moves the key pair to the trash folder inside .ssh")}
          onClick={onRemove}
        >
          {isKeyTask(busy, "delete", sshKey.fingerprint) ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  );
}

/** 단일 SSH 키 행 컴포넌트. 키 정보 요약과 액션 버튼, 메모·암호 입력 상자를 렌더링한다. */
function SshKeyRow({
  sshKey,
  servers,
  busy,
  note,
  passphrase,
  onReveal,
  onRemove,
}: SshKeyRowProps) {
  const { text } = useI18n();
  const rowBusy = isRowBusy(busy, sshKey.fingerprint);

  return (
    <div className="plugin-row" key={sshKey.path}>
      <i><KeyRound size={17} /></i>
      <div className="plugin-row-main">
        <div className="plugin-row-name">
          <strong>{sshKey.fileName}</strong>
          <code>{sshKey.algorithm}</code>
          {sshKey.passphraseSaved && <em className="ssh-key-badge"><LockKeyhole size={11} aria-hidden="true" />{text("암호 저장됨", "Passphrase saved")}</em>}
        </div>
        <small>{displayPath(sshKey.path)}</small>
        <code className="ssh-key-fingerprint">{sshKey.fingerprint}</code>
        {sshKey.comment && <small>{text("설명", "Comment")} · {sshKey.comment}</small>}
        {sshKey.note && !note.isEditing && <small className="ssh-key-note"><NotebookPen size={12} aria-hidden="true" />{sshKey.note}</small>}
        {servers.length > 0 && <small className="ssh-key-servers">
          <Server size={12} aria-hidden="true" />
          {text(`연결 서버 ${servers.length}개`, `${servers.length} server(s)`)} · {servers.map(serverLabel).join(", ")}
        </small>}
        <span className={`plugin-status ${sshKey.hasPrivateKey ? "ok" : "warn"}`}><i />{sshKey.hasPrivateKey ? text("개인키 쌍 확인", "Private pair found") : text("공개키만 있음", "Public key only")}</span>
      </div>
      <SshKeyRowActions
        sshKey={sshKey}
        busy={busy}
        note={note}
        passphrase={passphrase}
        onReveal={onReveal}
        onRemove={onRemove}
      />
      {note.isEditing && <SshNoteEditor
        sshKey={sshKey}
        binding={note}
        rowBusy={rowBusy}
        saving={isKeyTask(busy, "note", sshKey.fingerprint)}
      />}
      {passphrase.isEditing && <SshPassphraseEditor
        sshKey={sshKey}
        binding={passphrase}
        rowBusy={rowBusy}
        saving={isKeyTask(busy, "passphrase", sshKey.fingerprint)}
      />}
    </div>
  );
}

interface SshKeyCreateCardProps {
  fileName: string;
  onChangeFileName: (value: string) => void;
  comment: string;
  onChangeComment: (value: string) => void;
  keyTypes: SshKeyTypeOption[];
  keyType: string;
  onChangeKeyType: (value: string) => void;
  passphrase: string;
  onChangePassphrase: (value: string) => void;
  passphraseConfirm: string;
  onChangePassphraseConfirm: (value: string) => void;
  busy: boolean;
  creating: boolean;
  onCancel: () => void;
  onCreate: () => void;
}

/** 새 SSH 키 생성 카드. 키 종류·파일 이름·설명과 선택 암호를 받아 키 쌍을 생성한다. */
function SshKeyCreateCard({
  fileName,
  onChangeFileName,
  comment,
  onChangeComment,
  keyTypes,
  keyType,
  onChangeKeyType,
  passphrase,
  onChangePassphrase,
  passphraseConfirm,
  onChangePassphraseConfirm,
  busy,
  creating,
  onCancel,
  onCreate,
}: SshKeyCreateCardProps) {
  const { text } = useI18n();
  const passphraseMismatch = passphrase !== passphraseConfirm;
  const canCreate = !busy && Boolean(fileName.trim()) && comment.length <= MAX_COMMENT_CHARS && !passphraseMismatch;

  return (
    <div className="detail-card ssh-key-form">
      <div className="plugin-row-name"><strong>{text("SSH 키 생성", "Generate SSH key")}</strong><code>ssh-keygen</code></div>
      <div className="form-row">
        <label htmlFor="ssh-key-type">{text("키 종류", "Key type")}</label>
        <select id="ssh-key-type" value={keyType} onChange={(event) => onChangeKeyType(event.target.value)}>
          {keyTypes.length === 0 && <option value={keyType}>Ed25519</option>}
          {keyTypes.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </div>
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
      <div className="form-row">
        <label htmlFor="ssh-key-passphrase">{text("암호 (선택)", "Passphrase (optional)")}</label>
        <input
          id="ssh-key-passphrase"
          type="password"
          value={passphrase}
          autoComplete="new-password"
          spellCheck={false}
          placeholder={text("비우면 암호 없는 키", "Leave empty for no passphrase")}
          onChange={(event) => onChangePassphrase(event.target.value)}
        />
      </div>
      <div className="form-row">
        <label htmlFor="ssh-key-passphrase-confirm">{text("암호 확인", "Confirm")}</label>
        <span className="ssh-key-comment-field">
          <input
            id="ssh-key-passphrase-confirm"
            type="password"
            value={passphraseConfirm}
            autoComplete="new-password"
            spellCheck={false}
            disabled={passphrase.length === 0 && passphraseConfirm.length === 0}
            onChange={(event) => onChangePassphraseConfirm(event.target.value)}
          />
          {passphraseMismatch && <small className="ssh-key-passphrase-mismatch">{text("두 암호가 다릅니다", "The passphrases do not match")}</small>}
        </span>
      </div>
      <p className="plugin-form-note"><ShieldCheck size={13} />{text(
        "개인키는 0600 권한으로 생성되며 앱은 그 내용을 읽지 않습니다. 암호를 넣으면 키를 잠그고 보안 저장소에 저장합니다. 에이전트는 이 키를 앱을 거쳐서만 씁니다.",
        "The private key is created with 0600 permissions and is never read by the app. A passphrase locks the key and is kept in secure storage; agents then use the key only through the app.",
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
