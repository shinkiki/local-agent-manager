import type { KeyboardEvent } from "react";
import { readStoredText, writeStoredText, type StoredTextStorage } from "./storedText.ts";

type ComposerKeyState = {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** 소프트 키보드 판정에 쓰는 미디어 조건. 브라우저 조회와 순수 판정이 같은 이름을 쓴다. */
const SOFT_KEYBOARD_MEDIA = {
  coarsePointer: "(pointer: coarse)",
  noHover: "(hover: none)",
  narrowViewport: "(max-width: 760px)",
} as const;

/** 조합 키(Shift, Alt, Ctrl, Meta)가 눌려 있는지 확인한다. */
function hasModifierKey(event: ComposerKeyState): boolean {
  return Boolean(event.shiftKey || event.altKey || event.ctrlKey || event.metaKey);
}

/**
 * 한글·일본어 IME 조합 중인지 확인한다.
 * keyCode 229는 브라우저가 한글 등 IME 조합 중에 보내는 특별 코드다.
 */
function isImeComposing(event: ComposerKeyState): boolean {
  return Boolean(event.isComposing || event.keyCode === 229);
}

/**
 * Enter 입력 시 메시지를 전송할지 여부를 판정한다.
 * 단순 Enter는 메시지를 전송하고, Shift+Enter나 다른 조합 키 또는 IME 조합 중에는 줄바꿈을 유지한다.
 */
export function shouldSubmitOnEnter(event: ComposerKeyState): boolean {
  if (event.key !== "Enter") return false;
  if (hasModifierKey(event)) return false;
  return !isImeComposing(event);
}

/**
 * 스마트폰이나 태블릿 등 온스크린 소프트 키보드 환경인지 확인한다.
 * 온스크린 키보드는 Shift+Enter를 누르기 어려우므로 Enter 키가 항상 줄바꿈으로 동작해야 한다.
 * 좁은 데스크톱 창은 모바일 환경이 아니므로 제외한다.
 */
export function isSoftKeyboardEnvironment(matches: (query: string) => boolean, maxTouchPoints = 0): boolean {
  const coarseTouchOnly = matches(SOFT_KEYBOARD_MEDIA.coarsePointer)
    && matches(SOFT_KEYBOARD_MEDIA.noHover);
  if (coarseTouchOnly) return true;
  return maxTouchPoints > 0 && matches(SOFT_KEYBOARD_MEDIA.narrowViewport);
}

/**
 * 이 기기에서 Enter를 어떻게 다룰지. `auto`는 소프트 키보드 판정을 따르고, `send`·`newline`은
 * 판정을 건너뛴다. 하드웨어 키보드를 붙인 iPad는 여전히 `pointer: coarse`로 보이고 브라우저는
 * 키보드 연결 여부를 알려 주지 않으므로, 그 경우는 사용자가 직접 고르는 수밖에 없다.
 */
export type ComposerEnterMode = "auto" | "send" | "newline";

export const COMPOSER_ENTER_MODE_KEY = "agent-manager.composer-enter-mode";

export function readComposerEnterMode(storage?: StoredTextStorage | null): ComposerEnterMode {
  const stored = readStoredText(COMPOSER_ENTER_MODE_KEY, storage);
  return stored === "send" || stored === "newline" ? stored : "auto";
}

export function writeComposerEnterMode(mode: ComposerEnterMode, storage?: StoredTextStorage | null): void {
  writeStoredText(COMPOSER_ENTER_MODE_KEY, mode, storage);
}

/** 고른 동작과 기기 판정으로 Enter가 전송 후보인지 정한다. 조합 키·IME 판정은 그 뒤에 따로 한다. */
export function enterSubmitsIn(mode: ComposerEnterMode, softKeyboard: boolean): boolean {
  if (mode === "send") return true;
  if (mode === "newline") return false;
  return !softKeyboard;
}

function softKeyboardDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return isSoftKeyboardEnvironment((query) => window.matchMedia(query).matches, window.navigator.maxTouchPoints ?? 0);
}

/** React 키보드 이벤트로부터 네이티브 IME 상태와 조합 키를 포함한 키 상태를 뽑아낸다. */
function extractComposerKeyState(
  event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>,
): ComposerKeyState {
  const native = event.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
  return {
    key: event.key,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    isComposing: native.isComposing,
    keyCode: native.keyCode,
  };
}

/** 폼 요소를 찾아 submit을 실행한다. requestSubmit을 지원하지 않는 환경에서는 submit 이벤트를 발송한다. */
function requestFormSubmit(form: HTMLFormElement): void {
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
  } else {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }
}

/** 입력 필드에서 Enter를 눌렀을 때 둘러싼 form을 전송한다. */
export function submitComposerOnEnter(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void {
  if (event.key !== "Enter") return;
  if (!enterSubmitsIn(readComposerEnterMode(), softKeyboardDevice())) return;
  if (!shouldSubmitOnEnter(extractComposerKeyState(event))) return;
  const form = event.currentTarget.form;
  if (!form) return;
  event.preventDefault();
  requestFormSubmit(form);
}
