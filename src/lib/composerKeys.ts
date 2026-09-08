import type { KeyboardEvent } from "react";

export type ComposerKeyState = {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** Enter sends the message. Shift+Enter (and other modifiers) keep inserting a line break. */
export function shouldSubmitOnEnter(event: ComposerKeyState): boolean {
  if (event.key !== "Enter") return false;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
  // Hangul/Japanese IME commits the in-progress composition with the same Enter press.
  return !event.isComposing && event.keyCode !== 229;
}

/**
 * Phones and tablets type through an on-screen keyboard with no Shift+Enter, so their
 * Enter key must keep inserting a line break. A narrow desktop window is not mobile.
 */
export function isSoftKeyboardEnvironment(matches: (query: string) => boolean, maxTouchPoints = 0): boolean {
  if (matches("(pointer: coarse)") && matches("(hover: none)")) return true;
  return maxTouchPoints > 0 && matches("(max-width: 760px)");
}

function softKeyboardDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return isSoftKeyboardEnvironment((query) => window.matchMedia(query).matches, window.navigator.maxTouchPoints ?? 0);
}

/** Submits the surrounding form when Enter is pressed on a composer field. */
export function submitComposerOnEnter(event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
  if (softKeyboardDevice()) return;
  const native = event.nativeEvent as unknown as { isComposing?: boolean; keyCode?: number };
  if (!shouldSubmitOnEnter({
    key: event.key,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    isComposing: native.isComposing,
    keyCode: native.keyCode,
  })) return;
  const form = event.currentTarget.form;
  if (!form) return;
  event.preventDefault();
  if (typeof form.requestSubmit === "function") form.requestSubmit();
  else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
