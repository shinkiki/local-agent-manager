export const EMPTY_CLIPBOARD_TEXT_ERROR = "복사할 내용이 없습니다.";
export const UNSUPPORTED_CLIPBOARD_ERROR = "이 환경에서는 클립보드에 쓸 수 없습니다.";

export async function writeClipboardText(text: string): Promise<void> {
  if (!text) throw new Error(EMPTY_CLIPBOARD_TEXT_ERROR);

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (cause) {
      if (fallbackCopyText(text)) return;
      throw cause;
    }
  }

  if (!fallbackCopyText(text)) {
    throw new Error(UNSUPPORTED_CLIPBOARD_ERROR);
  }
}

function fallbackCopyText(text: string): boolean {
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("aria-hidden", "true");
  input.style.position = "fixed";
  input.style.top = "-9999px";
  input.style.left = "-9999px";
  input.style.opacity = "0";
  input.style.pointerEvents = "none";
  document.body.appendChild(input);
  input.focus({ preventScroll: true });
  input.select();

  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    input.remove();
    activeElement?.focus({ preventScroll: true });
  }
  return copied;
}
