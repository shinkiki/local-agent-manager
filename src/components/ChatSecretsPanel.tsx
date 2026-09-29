/**
 * 채팅 비밀값 패널. 이 대화에 맡겨 둔 API 키·비밀번호를 확인하고 지우고 더 넣는 자리다.
 * 백엔드는 값을 메모리에만 들고 있다가 에이전트가 이름으로 참조할 때 앱이 대신 주입한다.
 *
 * **맡긴 값이 하나도 없으면 이 줄은 아예 그리지 않는다.** 값을 처음 건네는 길은 권한 승인과
 * 같은 자리 — 에이전트가 이름을 대고 올리는 `secretRequest` 카드다. 빈 패널이 모든 채팅
 * 아래에 상시로 붙어 있으면 아무도 요청하지 않은 입력칸이 화면을 차지한다. 이미 맡긴 값이
 * 있을 때만 나타나므로, 보이지 않는 곳에 남은 비밀값이 생기지도 않는다.
 *
 * 이 컴포넌트가 지키는 것 하나 — **값은 화면 어디에도 되비치지 않는다.** 목록은 이름·
 * 용도·출처·남은 시간만 그리고, 입력칸의 값은 저장을 누른 즉시 비운다. 실패했을 때도
 * 값을 남겨 두지 않는다. 다시 붙여 넣는 손품이 값을 화면 상태에 오래 남기는 것보다 싸다.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ChevronDown, KeyRound, Trash2 } from "lucide-react";
import { listChatSecrets, removeChatSecret, setChatSecret } from "../lib/ipc";
import {
  CHAT_SECRET_NAME_MAX,
  CHAT_SECRET_PURPOSE_MAX,
  CHAT_SECRET_VALUE_MAX,
  chatSecretMinutesLeft,
  chatSecretNameIssue,
  chatSecretPurposeIssue,
  chatSecretValueIssue,
  normalizeChatSecretName,
  type ChatSecretFieldIssue,
  type ChatSecretNameIssue,
} from "../lib/chatSecrets";
import { useI18n } from "../lib/i18n";
import type { ChatSecretSummary } from "../types";
import { useDismissablePopover } from "./ChatPopover";

type UiText = (ko: string, en: string) => string;

function nameIssueText(issue: ChatSecretNameIssue, text: UiText): string {
  switch (issue) {
    case "empty": return text("이름을 입력하세요.", "Enter a name.");
    case "tooLong": return text(`이름은 ${CHAT_SECRET_NAME_MAX}자까지입니다.`, `Names can be at most ${CHAT_SECRET_NAME_MAX} characters.`);
    case "leadingLetter": return text("이름은 대문자 영문으로 시작해야 합니다.", "Names must start with an uppercase letter.");
    case "charset": return text("이름에는 대문자·숫자·밑줄만 쓸 수 있습니다.", "Names may contain only uppercase letters, digits, and underscores.");
  }
}

function purposeIssueText(issue: ChatSecretFieldIssue, text: UiText): string {
  return issue === "empty"
    ? text("용도를 한 줄로 적으세요.", "Describe the purpose in one line.")
    : text(`용도는 ${CHAT_SECRET_PURPOSE_MAX}자까지입니다.`, `The purpose can be at most ${CHAT_SECRET_PURPOSE_MAX} characters.`);
}

function valueIssueText(issue: ChatSecretFieldIssue, text: UiText): string {
  return issue === "empty"
    ? text("값을 입력하세요.", "Enter a value.")
    : text(`값은 ${CHAT_SECRET_VALUE_MAX}자까지입니다.`, `The value can be at most ${CHAT_SECRET_VALUE_MAX} characters.`);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ChatSecretsPanel({ chatId, disabled = false, refreshSignal = 0 }: {
  chatId: string | null;
  disabled?: boolean;
  /**
   * 승인 카드로 값이 들어갈 때마다 올라가는 수. 목록은 채팅이 바뀔 때와 패널을 열 때만
   * 읽는데, 이제 이 줄이 보일지 말지가 그 목록에 달려 있다 — 카드로 맡긴 첫 값이 목록에
   * 닿지 않으면 줄은 계속 숨은 채로 남는다.
   */
  refreshSignal?: number;
}) {
  const { text } = useI18n();
  const { open, setOpen, rootRef } = useDismissablePopover();
  const [secrets, setSecrets] = useState<ChatSecretSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [value, setValue] = useState("");
  // 남은 시간은 분 단위라 매초 새로 그릴 이유가 없다. 패널이 열려 있는 동안만 분마다 되센다.
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async (id: string) => {
    try {
      const snapshot = await listChatSecrets(id);
      setSecrets(snapshot.secrets);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, text("비밀값 목록을 불러오지 못했습니다.", "Could not load the secrets.")));
    }
  }, [text]);

  // 채팅이 바뀌면 이전 대화의 목록을 남기지 않는다. 닫힌 상태에서도 버튼의 개수는 맞아야
  // 하므로 한 번은 읽는다.
  useEffect(() => {
    setSecrets([]);
    setError(null);
    setName("");
    setPurpose("");
    setValue("");
    if (chatId) void refresh(chatId);
  }, [chatId, refresh]);

  // 승인 카드가 값을 맡긴 직후. 닫혀 있어도 읽어야 줄이 나타난다.
  useEffect(() => {
    if (refreshSignal > 0 && chatId) void refresh(chatId);
  }, [refreshSignal, chatId, refresh]);

  // 마지막 값을 지우면 줄 자체가 사라진다. 열린 채로 두면 다음 값이 들어올 때 펼쳐진
  // 채로 튀어나오므로 여기서 접어 둔다.
  useEffect(() => {
    if (secrets.length === 0) setOpen(false);
  }, [secrets.length, setOpen]);

  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const toggle = () => {
    if (!open && chatId) void refresh(chatId);
    setOpen((current) => !current);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chatId || busy) return;
    const normalized = normalizeChatSecretName(name);
    const nameIssue = chatSecretNameIssue(normalized);
    if (nameIssue) { setError(nameIssueText(nameIssue, text)); return; }
    const purposeIssue = chatSecretPurposeIssue(purpose);
    if (purposeIssue) { setError(purposeIssueText(purposeIssue, text)); return; }
    const valueIssue = chatSecretValueIssue(value);
    if (valueIssue) { setError(valueIssueText(valueIssue, text)); return; }
    // 값은 요청에 실리는 순간 화면 상태에서 지운다. 실패해도 되살리지 않는다.
    const payload = { chatId, name: normalized, purpose: purpose.trim(), value };
    setValue("");
    setBusy(true);
    try {
      const snapshot = await setChatSecret(payload);
      setSecrets(snapshot.secrets);
      setError(null);
      setName("");
      setPurpose("");
      await refresh(chatId);
    } catch (cause) {
      setError(errorMessage(cause, text("비밀값을 저장하지 못했습니다.", "Could not save the secret.")));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (secretName: string) => {
    if (!chatId || busy) return;
    setBusy(true);
    try {
      const snapshot = await removeChatSecret({ chatId, name: secretName });
      setSecrets(snapshot.secrets);
      setError(null);
      await refresh(chatId);
    } catch (cause) {
      setError(errorMessage(cause, text("비밀값을 삭제하지 못했습니다.", "Could not remove the secret.")));
    } finally {
      setBusy(false);
    }
  };

  const count = secrets.length;
  const panelId = "chat-secrets-panel";
  const locked = disabled || !chatId;

  // 맡긴 값도 없고 알릴 실패도 없으면 자리를 비운다.
  if (count === 0 && !error) return null;

  return (
    <div className="chat-secrets-menu" ref={rootRef}>
      <div className="chat-secrets-bar">
        <button
          className={`button compact chat-secrets-trigger${open ? " active" : ""}`}
          type="button"
          disabled={locked}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
        >
          <KeyRound size={13} aria-hidden="true" />
          <span>{text(`비밀값 ${count}개`, `${count} secret${count === 1 ? "" : "s"}`)}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </div>
      {open && chatId && (
        <div className="chat-secrets-panel" id={panelId} role="group" aria-label={text("채팅 비밀값", "Chat secrets")}>
          <p className="chat-secrets-hint">{text(
            "값은 이 대화에서만 앱 메모리에 잠시 보관되고, 에이전트는 이름으로만 씁니다.",
            "Values stay briefly in app memory for this chat only; the agent refers to them by name.",
          )}</p>
          {count === 0 ? (
            <p className="chat-secrets-empty">{text("등록된 비밀값이 없습니다.", "No secrets registered.")}</p>
          ) : (
            <ul className="chat-secrets-list">
              {secrets.map((secret) => {
                const minutes = chatSecretMinutesLeft(secret.expiresAt, now);
                return (
                  <li className="chat-secrets-item" key={secret.name}>
                    <div className="chat-secrets-item-head">
                      <code>{secret.name}</code>
                      <em className={`chat-secrets-source chat-secrets-source-${secret.source}`}>
                        {secret.source === "agent" ? text("에이전트", "agent") : secret.source === "saved" ? text("저장됨", "saved") : text("사용자", "user")}
                      </em>
                      <small>{minutes === 0 ? text("만료됨", "expired") : text(`${minutes}분 남음`, `${minutes} min left`)}</small>
                      <button
                        className="button compact danger-subtle chat-secrets-remove"
                        type="button"
                        disabled={busy}
                        aria-label={text(`${secret.name} 삭제`, `Remove ${secret.name}`)}
                        onClick={() => void remove(secret.name)}
                      >
                        <Trash2 size={12} aria-hidden="true" />
                      </button>
                    </div>
                    <span className="chat-secrets-purpose">{secret.purpose}</span>
                  </li>
                );
              })}
            </ul>
          )}
          <form className="chat-secrets-form" onSubmit={(event) => void submit(event)}>
            <label>
              <span>{text("이름", "Name")}</span>
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={CHAT_SECRET_NAME_MAX}
                value={name}
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
              <span>{text("값", "Value")}</span>
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
            <div className="chat-secrets-form-actions">
              {error && <span className="chat-secrets-error" role="alert">{error}</span>}
              <button className="button primary compact" type="submit" disabled={busy || locked}>
                {text("저장", "Save")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
