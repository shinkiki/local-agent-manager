import { useEffect, useRef, useState } from "react";
import { CopyAction } from "./CopyAction";
import { CornerUpLeft, Pencil } from "lucide-react";
import { errorText } from "../lib/errorText";
import { useI18n } from "../lib/i18n";

/** Keep the source and draft intact until the new branch has accepted the message. */
export function MessageEdit({ text: original, onSend, messageContainer }: { text: string; onSend: (text: string, sendImmediately?: boolean) => Promise<void>; messageContainer: HTMLElement | null }) {
  const { text } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(original);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    if (!messageContainer || editing) return;
    const select = (event: MouseEvent) => {
      const target = event.target;
      // 작업 막대는 메시지 안에 그려지므로, 그 안의 빈 자리나 오류 문구를 누른 것은 메시지 선택이 아니다.
      if (!(target instanceof Element) || target.closest("button, a, input, textarea, select, summary, [contenteditable=true], .message-edit-popup")) return;
      if (!messageContainer.ownerDocument.getSelection()?.isCollapsed) return;
      setSelected((value) => !value);
    };
    const selectWithKeyboard = (event: KeyboardEvent) => {
      if (event.target !== messageContainer || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      setSelected((value) => !value);
    };
    messageContainer.addEventListener("click", select);
    messageContainer.addEventListener("keydown", selectWithKeyboard);
    return () => {
      messageContainer.removeEventListener("click", select);
      messageContainer.removeEventListener("keydown", selectWithKeyboard);
    };
  }, [messageContainer, editing]);
  useEffect(() => {
    if (!selected || !messageContainer) return;
    const document = messageContainer.ownerDocument;
    const dismiss = (event: PointerEvent) => {
      if (!pending.current && event.target instanceof Node && !messageContainer.contains(event.target)) setSelected(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (!pending.current && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setSelected(false); messageContainer.focus({ preventScroll: true }); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape, true); };
  }, [selected, messageContainer]);
  if (!editing) return selected ? <div className="message-edit-popup" role="toolbar" aria-label={text("메시지 작업", "Message actions")}>
    <CopyAction value={original} kind="message" iconOnly disabled={busy} className="message-edit-action" />
    <button disabled={busy} className="message-edit-action message-edit-trigger" type="button" aria-label={text("편집 후 다시 진행", "Edit and continue")} title={text("편집 후 다시 진행", "Edit and continue")} onClick={() => { setDraft(original); setError(null); setSelected(false); setEditing(true); }}><Pencil size={13} aria-hidden="true" /></button>
    <button className="message-edit-action message-rewind-action" type="button" disabled={busy} aria-label={text("메시지 시점으로 이동", "Return to before this message")} title={text("메시지를 보내기 전으로 돌아가 입력창에 채우기", "Return to before this message and fill the composer")} onClick={() => {
      if (pending.current) return;
      pending.current = true; setBusy(true); setError(null);
      void onSend(original, false).then(() => setSelected(false)).catch((cause: unknown) => setError(errorText(cause))).finally(() => { pending.current = false; setBusy(false); });
    }}><CornerUpLeft size={15} aria-hidden="true" /></button>
    {error && <p className="message-action-error" role="alert">{error}</p>}
  </div> : null;
  return <form className="message-edit-form" onSubmit={(event) => {
    event.preventDefault();
    if (pending.current || !draft.trim()) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    void onSend(draft).then(() => setEditing(false)).catch((cause: unknown) => setError(errorText(cause))).finally(() => { pending.current = false; setBusy(false); });
  }}>
    <p>{text("이 메시지 직전까지의 대화에서 수정한 메시지로 새 대화를 시작합니다. 이후 대화는 제외되며 원본은 보존됩니다. 이미 변경된 파일은 되돌리지 않습니다.", "Start a new conversation from just before this message. Later messages are excluded and the original is kept. Existing file changes are not reverted.")}</p>
    <textarea aria-label={text("메시지 편집", "Edit message")} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} rows={5} />
    {error && <p role="alert">{error}</p>}
    <div><button className="button compact" type="button" disabled={busy} onClick={() => setEditing(false)}>{text("취소", "Cancel")}</button><button className="button primary compact" type="submit" disabled={busy || !draft.trim()}>{busy ? text("진행 중…", "Starting…") : text("수정 후 전송", "Send edited message")}</button></div>
  </form>;
}
