/**
 * C17. 저장소 → 비밀정보 탭의 **저장된 비밀값** 카드. 대화 비밀값이 한 대화·한 시간짜리라면
 * 여기 있는 값은 기기에 남아 모든 대화가 같은 이름으로 쓴다. 값은 OS 보안 저장소에만 있고
 * 이 화면이 받는 것은 이름·용도·자동 사용 여부·시각뿐이다.
 *
 * 대화 비밀값 카드와 같은 규칙을 지킨다 — 값은 눈 아이콘을 누른 행에서만 백엔드에 물어
 * 보여 주고, 목록을 다시 읽거나 탭을 떠나면 지운다. 입력칸의 값은 저장을 누른 즉시 비운다.
 *
 * 자동 사용 토글(`agentEnabled`)은 값과 별개다. 꺼 두면 그 이름은 어떤 대화에도 자동으로
 * 실리지 않고 에이전트의 요청은 평소처럼 카드로 가지만, 값은 그대로 남는다.
 */
import { Eye, EyeOff, KeyRound, PenLine, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { listSavedSecrets, readSavedSecretValue, removeSavedSecret, saveSecret, setSavedSecretAgentEnabled } from "../lib/ipc";
import {
  CHAT_SECRET_NAME_MAX,
  CHAT_SECRET_PURPOSE_MAX,
  CHAT_SECRET_VALUE_MAX,
  chatSecretNameIssue,
  chatSecretPurposeIssue,
  chatSecretValueIssue,
  normalizeChatSecretName,
} from "../lib/chatSecrets";
import { errorText } from "../lib/errorText";
import { useI18n, type UiText } from "../lib/i18n";
import type { SavedSecretView } from "../types";
import { AppToggle, EmptyState, ErrorBanner, useConfirm } from "./Shared";

function nameIssueText(issue: NonNullable<ReturnType<typeof chatSecretNameIssue>>, text: UiText): string {
  switch (issue) {
    case "empty": return text("이름을 입력하세요.", "Enter a name.");
    case "tooLong": return text(`이름은 ${CHAT_SECRET_NAME_MAX}자까지입니다.`, `Names can be at most ${CHAT_SECRET_NAME_MAX} characters.`);
    case "leadingLetter": return text("이름은 대문자 영문으로 시작해야 합니다.", "Names must start with an uppercase letter.");
    case "charset": return text("이름에는 대문자·숫자·밑줄만 쓸 수 있습니다.", "Names may contain only uppercase letters, digits, and underscores.");
  }
}

function fieldIssueText(kind: "purpose" | "value", issue: "empty" | "tooLong", text: UiText): string {
  if (kind === "purpose") {
    return issue === "empty"
      ? text("용도를 한 줄로 적으세요.", "Describe the purpose in one line.")
      : text(`용도는 ${CHAT_SECRET_PURPOSE_MAX}자까지입니다.`, `The purpose can be at most ${CHAT_SECRET_PURPOSE_MAX} characters.`);
  }
  return issue === "empty"
    ? text("값을 입력하세요.", "Enter a value.")
    : text(`값은 ${CHAT_SECRET_VALUE_MAX}자까지입니다.`, `The value can be at most ${CHAT_SECRET_VALUE_MAX} characters.`);
}

/** 저장·수정 폼이 공유하는 검사. 통과하면 다듬은 값을, 아니면 화면에 띄울 문구를 준다. */
function validate(name: string, purpose: string, value: string, text: UiText): { name: string; purpose: string; value: string } | string {
  const normalized = normalizeChatSecretName(name);
  const nameIssue = chatSecretNameIssue(normalized);
  if (nameIssue) return nameIssueText(nameIssue, text);
  const purposeIssue = chatSecretPurposeIssue(purpose);
  if (purposeIssue) return fieldIssueText("purpose", purposeIssue, text);
  const valueIssue = chatSecretValueIssue(value);
  if (valueIssue) return fieldIssueText("value", valueIssue, text);
  return { name: normalized, purpose: purpose.trim(), value };
}

const dateText = (at: number | null) => (at === null ? null : new Date(at).toLocaleString());

export function SavedSecretsCard({ active, reloadSignal = 0 }: {
  active: boolean;
  /** 채팅 쪽에서 값을 새로 보관했을 때 올라가는 수. 목록을 다시 읽을 신호다. */
  reloadSignal?: number;
}) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [secrets, setSecrets] = useState<SavedSecretView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // 눈 아이콘으로 드러낸 값. 목록을 다시 읽거나 탭을 떠나면 통째로 비운다.
  const [revealed, setRevealed] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const snapshot = await listSavedSecrets();
      setSecrets(snapshot.secrets);
      setRevealed({});
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    if (!active) {
      setRevealed({});
      return;
    }
    void load();
  }, [active, reloadSignal, load]);

  const apply = (next: SavedSecretView[]) => {
    setSecrets(next);
    setRevealed({});
    setError(null);
  };

  const toggleReveal = async (name: string) => {
    if (name in revealed) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
      return;
    }
    setBusy(name);
    try {
      const view = await readSavedSecretValue({ name });
      setRevealed((current) => ({ ...current, [name]: view.value }));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const store = async (name: string, purpose: string, value: string): Promise<string | null> => {
    setBusy(name);
    try {
      apply((await saveSecret({ name, purpose, value })).secrets);
      setEditing(null);
      setAdding(false);
      return null;
    } catch (cause) {
      return errorText(cause);
    } finally {
      setBusy(null);
    }
  };

  const setEnabled = async (name: string, enabled: boolean) => {
    setBusy(name);
    try {
      apply((await setSavedSecretAgentEnabled({ name, enabled })).secrets);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (name: string) => {
    const accepted = await confirm({
      title: text("저장된 비밀값을 지울까요?", "Delete this saved secret?"),
      message: text(
        `${name} 값을 OS 보안 저장소에서 지웁니다. 되돌릴 수 없고, 다시 쓰려면 값을 새로 입력해야 합니다.`,
        `${name} will be deleted from the OS secure store. This cannot be undone; using it again means entering the value anew.`,
      ),
      confirmLabel: text("삭제", "Delete"),
      tone: "danger",
    });
    if (!accepted) return;
    setBusy(name);
    try {
      apply((await removeSavedSecret({ name })).secrets);
      if (editing === name) setEditing(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const locked = busy !== null;

  return (
    <article className="panel storage-secrets-group storage-saved-secrets" data-ui-anchor="storage.saved-secrets">
      <header className="storage-secrets-group-head">
        {/* 제목과 설명을 버튼과 한 줄에 늘어놓으면 설명이 먼저 눌린다. 제목 아래로 내려
            폭을 쓰게 하고, 버튼만 오른쪽 끝에 남긴다. */}
        <div className="storage-secrets-group-title">
          <KeyRound size={14} aria-hidden="true" />
          <span className="storage-saved-secrets-heading">
            <strong>{text("저장된 비밀값", "Saved secrets")}</strong>
            <span className="storage-saved-secrets-hint">{text(
              "기기에 남아 모든 대화가 같은 이름으로 씁니다. 값은 OS 보안 저장소에만 있습니다.",
              "Kept on this device and used by every chat under the same name. Values live only in the OS secure store.",
            )}</span>
          </span>
        </div>
        <div className="storage-secrets-toolbar">
          <button className="button compact" type="button" disabled={locked} onClick={() => void load()} title={text("목록을 다시 읽습니다", "Reload the list")}>
            <RefreshCw size={13} aria-hidden="true" />{text("새로고침", "Refresh")}
          </button>
          <button className={`button compact${adding ? " active" : ""}`} type="button" disabled={locked} aria-expanded={adding} onClick={() => { setAdding((current) => !current); setEditing(null); }}>
            <Plus size={13} aria-hidden="true" />{text("값 추가", "Add a secret")}
          </button>
        </div>
      </header>
      {error && <ErrorBanner message={error} />}
      {adding && (
        <SavedSecretForm
          busy={locked}
          onCancel={() => setAdding(false)}
          onSubmit={(name, purpose, value) => store(name, purpose, value)}
        />
      )}
      {secrets !== null && secrets.length === 0 && !adding && (
        <EmptyState
          title={text("저장해 둔 비밀값이 없습니다.", "No saved secrets yet.")}
          detail={text(
            "값 추가로 직접 넣거나, 진행 중인 대화의 비밀값 옆 저장 버튼으로 보관할 수 있습니다.",
            "Add one here, or keep a live chat's secret with the save button beside it.",
          )}
        />
      )}
      {secrets !== null && secrets.length > 0 && (
        <table className="storage-secrets-table">
          <thead>
            <tr>
              <th scope="col">{text("이름", "Name")}</th>
              <th scope="col">{text("값", "Value")}</th>
              <th scope="col">{text("용도", "Purpose")}</th>
              <th scope="col">{text("에이전트 사용", "Agent use")}</th>
              <th scope="col">{text("마지막 사용", "Last used")}</th>
              <th scope="col" aria-label={text("동작", "Actions")} />
            </tr>
          </thead>
          <tbody>
            {secrets.map((secret) => {
              const open = editing === secret.name;
              const shown = revealed[secret.name] ?? null;
              const lastUsed = dateText(secret.lastUsedAt);
              return [
                <tr key={secret.name} className={open ? "is-editing" : undefined}>
                  <td><code>{secret.name}</code></td>
                  <td className="storage-secrets-value">
                    <button
                      className="button compact icon-only storage-secrets-eye"
                      type="button"
                      disabled={locked}
                      aria-pressed={shown !== null}
                      aria-label={shown === null ? text(`${secret.name} 값 보기`, `Show ${secret.name}`) : text(`${secret.name} 값 숨기기`, `Hide ${secret.name}`)}
                      title={shown === null ? text("값 보기", "Show value") : text("값 숨기기", "Hide value")}
                      onClick={() => void toggleReveal(secret.name)}
                    >{shown === null ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}</button>
                    {shown === null
                      ? <span className="storage-secrets-masked" aria-hidden="true">••••••••</span>
                      : <code className="storage-secrets-plain">{shown}</code>}
                  </td>
                  <td className="storage-secrets-purpose">{secret.purpose}</td>
                  <td>
                    <AppToggle
                      checked={secret.agentEnabled}
                      disabled={locked}
                      label={text(`${secret.name} 에이전트 자동 사용`, `Use ${secret.name} automatically`)}
                      onChange={(next) => void setEnabled(secret.name, next)}
                    />
                  </td>
                  <td className="storage-secrets-left">{lastUsed ?? text("없음", "never")}</td>
                  <td className="storage-secrets-actions">
                    <button
                      className={`button compact${open ? " active" : ""}`}
                      type="button"
                      disabled={locked}
                      aria-expanded={open}
                      aria-label={text(`${secret.name} 수정`, `Edit ${secret.name}`)}
                      onClick={() => { setEditing((current) => (current === secret.name ? null : secret.name)); setAdding(false); }}
                    ><PenLine size={12} aria-hidden="true" />{text("수정", "Edit")}</button>
                    <button
                      className="button compact danger-subtle"
                      type="button"
                      disabled={locked}
                      aria-label={text(`${secret.name} 삭제`, `Delete ${secret.name}`)}
                      onClick={() => void remove(secret.name)}
                    ><Trash2 size={12} aria-hidden="true" />{text("삭제", "Delete")}</button>
                  </td>
                </tr>,
                open && (
                  <tr key={`${secret.name}-edit`} className="storage-secrets-edit-row">
                    <td colSpan={6}>
                      <SavedSecretForm
                        secret={secret}
                        busy={locked}
                        onCancel={() => setEditing(null)}
                        onSubmit={(name, purpose, value) => store(name, purpose, value)}
                      />
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      )}
      {confirmDialog}
    </article>
  );
}

/**
 * 추가와 수정이 쓰는 한 벌의 폼. 수정일 때 이름은 고정이다 — 이름을 바꾸는 것은 다른 값을
 * 만드는 것과 같고, 그 사이 옛 이름으로 저장된 값이 남는다. 값 칸은 늘 비어서 시작한다:
 * 백엔드가 값을 돌려주지 않으므로 채울 것이 없고, 수정은 값을 다시 입력해야 끝난다.
 */
function SavedSecretForm({ secret, busy, onCancel, onSubmit }: {
  secret?: SavedSecretView;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string, purpose: string, value: string) => Promise<string | null>;
}) {
  const { text } = useI18n();
  const [name, setName] = useState(secret?.name ?? "");
  const [purpose, setPurpose] = useState(secret?.purpose ?? "");
  const [value, setValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const checked = validate(name, purpose, value, text);
    if (typeof checked === "string") { setFormError(checked); return; }
    // 값은 요청에 실리는 순간 화면 상태에서 지운다. 실패해도 되살리지 않는다.
    setValue("");
    setFormError(await onSubmit(checked.name, checked.purpose, checked.value));
  };

  return (
    <form className="storage-secrets-form" onSubmit={(event) => void submit(event)}>
      <label>
        <span>{text("이름", "Name")}</span>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={CHAT_SECRET_NAME_MAX}
          value={name}
          readOnly={secret !== undefined}
          placeholder="OPENAI_API_KEY"
          onChange={(event) => setName(normalizeChatSecretName(event.target.value))}
        />
      </label>
      <label>
        <span>{text("용도", "Purpose")}</span>
        <input
          type="text"
          autoComplete="off"
          maxLength={CHAT_SECRET_PURPOSE_MAX}
          value={purpose}
          placeholder={text("어디에 쓰는 값인지 한 줄로", "What this value is for, in one line")}
          onChange={(event) => setPurpose(event.target.value)}
        />
      </label>
      <label>
        <span>{secret ? text("새 값", "New value") : text("값", "Value")}</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={CHAT_SECRET_VALUE_MAX}
          value={value}
          placeholder={text("에이전트에게 보이지 않습니다", "Never shown to the agent")}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <small className="storage-secrets-form-hint">{text(
        "값은 OS 보안 저장소에 저장되고 에이전트에게는 이름만 열립니다. 새로 만든 값은 에이전트 자동 사용이 켜진 채로 저장됩니다.",
        "The value goes to the OS secure store and the agent only ever sees the name. A new secret is saved with agent use switched on.",
      )}</small>
      <div className="storage-secrets-form-actions">
        {formError && <span className="storage-secrets-error" role="alert">{formError}</span>}
        <button className="button compact" type="button" disabled={busy} onClick={onCancel}>{text("취소", "Cancel")}</button>
        <button className="button primary compact" type="submit" disabled={busy}>{busy ? text("저장 중…", "Saving…") : text("저장", "Save")}</button>
      </div>
    </form>
  );
}
