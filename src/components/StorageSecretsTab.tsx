/**
 * 저장소 → 비밀정보 탭. 채팅 비밀값은 백엔드 메모리에만 있고 대화별로 묶이는데, 채팅 화면의
 * 패널은 그 대화 하나만 보인다. 여기는 **모든 대화의 비밀값**을 한 자리에서 확인·수정·삭제하는
 * 자리다.
 *
 * 값은 기본으로 가려져 있고, 사용자가 눈 아이콘을 누른 행에서만 백엔드에 물어 보여 준다
 * (호스트 화면 전용 명령). 보인 값은 화면 상태에만 있으며 숨기거나 목록을 다시 읽거나 탭을
 * 떠나면 지운다. 수정 폼의 값 칸은 저장을 누른 즉시 비운다.
 * 백엔드 계약상 수정도 값이 필수라(`set_chat_secret`은 같은 이름을 덮어쓴다) 용도만 바꾸는
 * 길은 없다 — 폼이 그 사실을 안내문으로 말한다.
 */
import { Bookmark, Eye, EyeOff, KeyRound, PenLine, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { listAllChatSecrets, readChatSecretValue, rememberChatSecret, removeChatSecret, setChatSecret } from "../lib/ipc";
import {
  CHAT_SECRET_PURPOSE_MAX,
  CHAT_SECRET_VALUE_MAX,
  chatSecretMinutesLeft,
  chatSecretPurposeIssue,
  chatSecretValueIssue,
  type ChatSecretFieldIssue,
} from "../lib/chatSecrets";
import { displayPath } from "../lib/displayPath";
import { errorText } from "../lib/errorText";
import { useI18n, type UiText } from "../lib/i18n";
import { usePoll } from "../lib/poll";
import type { ChatSecretsGroup, ChatSecretsOverview, ChatSecretSummary } from "../types";
import { SavedSecretsCard } from "./SavedSecretsCard";
import { EmptyState, ErrorBanner, LoadingState, SourceBadge, useConfirm } from "./Shared";

import { formatDateTime } from "../lib/format";
function purposeIssueText(issue: ChatSecretFieldIssue, text: UiText): string {
  return issue === "empty"
    ? text("용도를 한 줄로 적으세요.", "Describe the purpose in one line.")
    : text(`용도는 ${CHAT_SECRET_PURPOSE_MAX}자까지입니다.`, `The purpose can be at most ${CHAT_SECRET_PURPOSE_MAX} characters.`);
}

function valueIssueText(issue: ChatSecretFieldIssue, text: UiText): string {
  return issue === "empty"
    ? text("값을 다시 입력해야 저장됩니다.", "Re-enter the value to save.")
    : text(`값은 ${CHAT_SECRET_VALUE_MAX}자까지입니다.`, `The value can be at most ${CHAT_SECRET_VALUE_MAX} characters.`);
}

/** 수정 중인 비밀값 하나의 좌표. 대화가 다르면 같은 이름이 있을 수 있어 둘을 함께 든다. */
interface SecretKey {
  chatId: string;
  name: string;
}

const sameKey = (a: SecretKey | null, b: SecretKey) => a !== null && a.chatId === b.chatId && a.name === b.name;

export function StorageSecretsTab({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [overview, setOverview] = useState<ChatSecretsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SecretKey | null>(null);
  const [editing, setEditing] = useState<SecretKey | null>(null);
  // 눈 아이콘으로 드러낸 값. 키 하나에 값 하나이며, 목록을 다시 읽으면 통째로 비운다 —
  // 그 사이 값이 바뀌었거나 사라졌을 수 있고, 화면에 오래 남을 이유도 없다.
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  // 남은 시간은 분 단위라 매초 새로 그릴 이유가 없다. 탭이 보이는 동안만 분마다 되센다.
  const [now, setNow] = useState(() => Date.now());
  // C17. 대화 비밀값을 보관으로 옮길 때마다 오르는 수. 위 카드가 목록을 다시 읽을 신호다.
  const [savedSignal, setSavedSignal] = useState(0);

  const load = useCallback(async () => {
    try {
      setOverview(await listAllChatSecrets());
      setRevealed({});
      setError(null);
      setNow(Date.now());
    } catch (cause) {
      setError(errorText(cause));
      throw cause;
    }
  }, []);
  // 탭이 보일 때만 돈다. 켜지는 순간 첫 회차가 바로 돌아 탭 진입마다 다시 읽는 셈이다.
  const refresh = usePoll(load, 30_000, { enabled: active });

  useEffect(() => {
    if (!active) {
      // 탭을 떠나면 드러낸 값을 두지 않는다.
      setRevealed({});
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const revealKey = (key: SecretKey) => `${key.chatId}\n${key.name}`;
  const toggleReveal = async (key: SecretKey) => {
    const id = revealKey(key);
    if (id in revealed) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return;
    }
    setBusy(key);
    try {
      const view = await readChatSecretValue({ chatId: key.chatId, name: key.name });
      setRevealed((current) => ({ ...current, [id]: view.value }));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const applySnapshot = (chatId: string, secrets: ChatSecretSummary[]) => {
    setOverview((current) => {
      if (!current) return current;
      // 비어 버린 대화는 묶음째 내린다 — 백엔드 목록도 비어 있는 대화를 싣지 않는다.
      const chats = current.chats
        .map((group) => (group.chatId === chatId ? { ...group, secrets } : group))
        .filter((group) => group.secrets.length > 0);
      return { ...current, chats };
    });
  };

  const save = async (key: SecretKey, purpose: string, value: string): Promise<string | null> => {
    setBusy(key);
    try {
      const snapshot = await setChatSecret({ chatId: key.chatId, name: key.name, purpose, value });
      applySnapshot(key.chatId, snapshot.secrets);
      setEditing(null);
      setError(null);
      return null;
    } catch (cause) {
      return errorText(cause);
    } finally {
      setBusy(null);
    }
  };

  /**
   * C17. 이 대화가 들고 있는 값을 기기 보관으로 옮긴다. 값은 백엔드 안에서만 움직이므로
   * 화면은 이름만 보내고, 성공하면 위 카드가 목록을 다시 읽는다.
   */
  const remember = async (key: SecretKey) => {
    setBusy(key);
    try {
      await rememberChatSecret({ chatId: key.chatId, name: key.name });
      setSavedSignal((current) => current + 1);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (key: SecretKey) => {
    const accepted = await confirm({
      title: text("비밀값을 삭제할까요?", "Remove this secret?"),
      message: text(
        `${key.name} 값을 앱 메모리에서 지웁니다. 에이전트가 이 이름을 다시 참조하면 요청 카드가 새로 뜹니다.`,
        `${key.name} will be cleared from app memory. If the agent refers to this name again, a new request card appears.`,
      ),
      confirmLabel: text("삭제", "Remove"),
      tone: "danger",
    });
    if (!accepted) return;
    setBusy(key);
    try {
      const snapshot = await removeChatSecret({ chatId: key.chatId, name: key.name });
      applySnapshot(key.chatId, snapshot.secrets);
      if (sameKey(editing, key)) setEditing(null);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const total = overview?.chats.reduce((sum, group) => sum + group.secrets.length, 0) ?? 0;

  return (
    <div className="view-stack storage-secrets">
      {/* 설명과 집계·새로고침을 한 줄에 나란히 두면 설명이 좁은 칸에서 잘리고 오른쪽 정렬로
          꺾인다. 읽는 글과 조작은 줄을 나눠, 설명은 폭을 다 쓰고 조작만 오른쪽에 둔다. */}
      <div className="storage-secrets-head">
        <p className="storage-secrets-note" role="note">{text(
          "아래 대화 비밀값은 진행 중인 대화에만 앱 메모리로 보관되며, 대화가 끝나거나 만료되면 사라집니다. 저장된 비밀값은 기기에 남아 모든 대화가 씁니다. 값은 눈 아이콘을 누른 동안에만 보입니다.",
          "The chat secrets below are kept in app memory only for chats in progress and disappear when the chat ends or they expire. Saved secrets stay on this device and serve every chat. A value is shown only while its eye icon is pressed.",
        )}</p>
        <div className="storage-secrets-toolbar">
          {overview && <small>{text(
            `${overview.chats.length}개 대화 · ${total}개 비밀값 · 등록 후 ${Math.round(overview.ttlSeconds / 60)}분 보관`,
            `${overview.chats.length} chats · ${total} secrets · kept ${Math.round(overview.ttlSeconds / 60)} min after registration`,
          )}</small>}
          <button className="button compact" type="button" onClick={() => void refresh()} title={text("목록을 다시 읽습니다", "Reload the list")}>
            <RefreshCw size={13} aria-hidden="true" />{text("새로고침", "Refresh")}
          </button>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      <SavedSecretsCard active={active} reloadSignal={savedSignal} />
      {!overview && !error && <LoadingState label={text("비밀값 목록을 읽고 있습니다", "Reading the secrets list…")} />}
      {overview && overview.chats.length === 0 && (
        <EmptyState
          title={text("보관 중인 비밀값이 없습니다.", "No secrets are being kept.")}
          detail={text("에이전트가 이름을 대고 올리는 요청 카드에 값을 넣으면 등록됩니다.", "A secret is registered by filling in the request card an agent raises for it by name.")}
        />
      )}
      {overview?.chats.map((group) => (
        <SecretsGroupCard
          key={group.chatId}
          group={group}
          now={now}
          busy={busy}
          editing={editing}
          revealed={(key) => revealed[revealKey(key)] ?? null}
          onToggleReveal={(key) => void toggleReveal(key)}
          onEdit={(key) => setEditing((current) => (sameKey(current, key) ? null : key))}
          onCancelEdit={() => setEditing(null)}
          onSave={save}
          onRemember={(key) => void remember(key)}
          onRemove={(key) => void remove(key)}
        />
      ))}
      {confirmDialog}
    </div>
  );
}

function SecretsGroupCard({ group, now, busy, editing, revealed, onToggleReveal, onEdit, onCancelEdit, onSave, onRemember, onRemove }: {
  group: ChatSecretsGroup;
  now: number;
  busy: SecretKey | null;
  editing: SecretKey | null;
  revealed: (key: SecretKey) => string | null;
  onToggleReveal: (key: SecretKey) => void;
  onEdit: (key: SecretKey) => void;
  onCancelEdit: () => void;
  onSave: (key: SecretKey, purpose: string, value: string) => Promise<string | null>;
  onRemember: (key: SecretKey) => void;
  onRemove: (key: SecretKey) => void;
}) {
  const { text } = useI18n();
  return (
    <article className="panel storage-secrets-group">
      <header className="storage-secrets-group-head">
        <div className="storage-secrets-group-title">
          <KeyRound size={14} aria-hidden="true" />
          <SourceBadge source={group.source} />
          <span className={`storage-secrets-profile storage-secrets-profile-${group.profile}`}>
            {group.profile === "aia" ? "AIA" : text("일반", "Standard")}
          </span>
          <code className="storage-secrets-cwd" title={group.cwd}>{displayPath(group.cwd)}</code>
        </div>
        <small>{text(`시작 ${formatDateTime(group.startedAt)}`, `Started ${formatDateTime(group.startedAt)}`)}</small>
      </header>
      <table className="storage-secrets-table">
        <thead>
          <tr>
            <th scope="col">{text("이름", "Name")}</th>
            <th scope="col">{text("값", "Value")}</th>
            <th scope="col">{text("용도", "Purpose")}</th>
            <th scope="col">{text("출처", "Source")}</th>
            <th scope="col">{text("남은 시간", "Time left")}</th>
            <th scope="col" aria-label={text("동작", "Actions")} />
          </tr>
        </thead>
        <tbody>
          {group.secrets.map((secret) => {
            const key = { chatId: group.chatId, name: secret.name };
            const minutes = chatSecretMinutesLeft(secret.expiresAt, now);
            const locked = busy !== null;
            const open = sameKey(editing, key);
            const shown = revealed(key);
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
                    onClick={() => onToggleReveal(key)}
                  >{shown === null ? <Eye size={13} aria-hidden="true" /> : <EyeOff size={13} aria-hidden="true" />}</button>
                  {shown === null
                    ? <span className="storage-secrets-masked" aria-hidden="true">••••••••</span>
                    : <code className="storage-secrets-plain">{shown}</code>}
                </td>
                <td className="storage-secrets-purpose">{secret.purpose}</td>
                <td>
                  <em className={`storage-secrets-source storage-secrets-source-${secret.source}`}>
                    {secret.source === "agent" ? text("에이전트", "agent") : secret.source === "saved" ? text("저장됨", "saved") : text("사용자", "user")}
                  </em>
                </td>
                <td className="storage-secrets-left">{minutes === 0 ? text("만료됨", "expired") : text(`${minutes}분`, `${minutes} min`)}</td>
                <td className="storage-secrets-actions">
                  <button
                    className={`button compact${open ? " active" : ""}`}
                    type="button"
                    disabled={locked}
                    aria-expanded={open}
                    aria-label={text(`${secret.name} 수정`, `Edit ${secret.name}`)}
                    onClick={() => onEdit(key)}
                  ><PenLine size={12} aria-hidden="true" />{text("수정", "Edit")}</button>
                  {/* C17. 이미 건넨 값을 기기 보관으로 옮긴다. 이미 저장된 값이 실려 온 행은
                      옮길 것이 없으므로 버튼을 두지 않는다. */}
                  {secret.source !== "saved" && <button
                    className="button compact"
                    type="button"
                    disabled={locked}
                    aria-label={text(`${secret.name} 저장해 두기`, `Save ${secret.name} for later`)}
                    title={text("기기에 저장해 다음 대화에서도 씁니다", "Keep it on this device for later chats")}
                    onClick={() => onRemember(key)}
                  ><Bookmark size={12} aria-hidden="true" />{text("저장", "Save")}</button>}
                  <button
                    className="button compact danger-subtle"
                    type="button"
                    disabled={locked}
                    aria-label={text(`${secret.name} 삭제`, `Remove ${secret.name}`)}
                    onClick={() => onRemove(key)}
                  ><Trash2 size={12} aria-hidden="true" />{text("삭제", "Remove")}</button>
                </td>
              </tr>,
              open && (
                <tr key={`${secret.name}-edit`} className="storage-secrets-edit-row">
                  <td colSpan={6}>
                    <SecretEditForm secret={secret} busy={sameKey(busy, key)} onCancel={onCancelEdit} onSave={(purpose, value) => onSave(key, purpose, value)} />
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>
    </article>
  );
}

/**
 * 인라인 수정 폼. 용도는 저장된 것을 초깃값으로 두고, 값 칸은 늘 비어서 시작한다 — 백엔드가
 * 값을 돌려주지 않으므로 채울 것도 없다. 값은 요청에 실리는 순간 화면 상태에서 지운다.
 */
function SecretEditForm({ secret, busy, onCancel, onSave }: {
  secret: ChatSecretSummary;
  busy: boolean;
  onCancel: () => void;
  onSave: (purpose: string, value: string) => Promise<string | null>;
}) {
  const { text } = useI18n();
  const [purpose, setPurpose] = useState(secret.purpose);
  const [value, setValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const purposeIssue = chatSecretPurposeIssue(purpose);
    if (purposeIssue) { setFormError(purposeIssueText(purposeIssue, text)); return; }
    const valueIssue = chatSecretValueIssue(value);
    if (valueIssue) { setFormError(valueIssueText(valueIssue, text)); return; }
    const payload = value;
    setValue("");
    setFormError(await onSave(purpose.trim(), payload));
  };

  return (
    <form className="storage-secrets-form" onSubmit={(event) => void submit(event)}>
      <label>
        <span>{text("용도", "Purpose")}</span>
        <input
          type="text"
          autoComplete="off"
          maxLength={CHAT_SECRET_PURPOSE_MAX}
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
        />
      </label>
      <label>
        <span>{text("새 값", "New value")}</span>
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
        "저장된 값은 되비치지 않습니다. 값을 다시 입력해야 저장됩니다.",
        "The stored value is never shown back. Re-enter the value to save.",
      )}</small>
      <div className="storage-secrets-form-actions">
        {formError && <span className="storage-secrets-error" role="alert">{formError}</span>}
        <button className="button compact" type="button" disabled={busy} onClick={onCancel}>{text("취소", "Cancel")}</button>
        <button className="button primary compact" type="submit" disabled={busy}>{busy ? text("저장 중…", "Saving…") : text("저장", "Save")}</button>
      </div>
    </form>
  );
}
