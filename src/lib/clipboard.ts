export const EMPTY_CLIPBOARD_TEXT_ERROR = "복사할 내용이 없습니다.";
export const UNSUPPORTED_CLIPBOARD_ERROR = "이 환경에서는 클립보드에 쓸 수 없습니다.";

type NativeClipboardAttempt =
  | { state: "copied" }
  | { state: "unavailable" }
  | { state: "failed"; cause: unknown };

/** 네이티브 Clipboard API 한 번의 결과. 던진 값이 null이어도 API 미지원과 구분한다. */
async function tryNativeClipboardWrite(text: string): Promise<NativeClipboardAttempt> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) return { state: "unavailable" };

  try {
    await clipboard.writeText(text);
    return { state: "copied" };
  } catch (cause) {
    return { state: "failed", cause };
  }
}

export async function writeClipboardText(text: string): Promise<void> {
  if (!text) throw new Error(EMPTY_CLIPBOARD_TEXT_ERROR);

  const nativeAttempt = await tryNativeClipboardWrite(text);
  if (nativeAttempt.state === "copied") return;

  if (fallbackCopyText(text)) return;
  if (nativeAttempt.state === "failed") throw nativeAttempt.cause;
  throw new Error(UNSUPPORTED_CLIPBOARD_ERROR);
}

/** 레거시 복사 명령이 선택할 화면 밖 입력을 만들고 문서에 붙인다. */
function createFallbackClipboardInput(text: string): HTMLTextAreaElement {
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("aria-hidden", "true");
  input.style.position = "fixed";
  input.style.top = "-9999px";
  input.style.left = "-9999px";
  input.style.opacity = "0";
  input.style.pointerEvents = "none";
  document.body.appendChild(input);
  return input;
}

/** 임시 입력을 선택해 레거시 복사 명령을 실행한다. 명령 예외는 지원 실패로 다룬다. */
function copyFromFallbackInput(input: HTMLTextAreaElement): boolean {
  input.focus({ preventScroll: true });
  input.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

function fallbackCopyText(text: string): boolean {
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = createFallbackClipboardInput(text);
  try {
    return copyFromFallbackInput(input);
  } finally {
    input.remove();
    activeElement?.focus({ preventScroll: true });
  }
}
