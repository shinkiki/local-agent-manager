import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_CLIPBOARD_TEXT_ERROR,
  UNSUPPORTED_CLIPBOARD_ERROR,
  writeClipboardText,
} from "./clipboard.ts";

function createMockElement() {
  return {
    value: "",
    style: {},
    setAttribute() {},
    focus() {},
    select() {},
    remove() {
      this.removed = true;
    },
    removed: false,
  };
}

async function withMockDom({ writeText, execCommandResult = true } = {}, run) {
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocDesc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalHtmlElement = globalThis.HTMLElement;

  class MockHTMLElement {}
  globalThis.HTMLElement = MockHTMLElement;

  let createdInput = null;
  let activeElementFocused = false;
  const activeElement = new MockHTMLElement();
  activeElement.focus = () => {
    activeElementFocused = true;
  };

  const documentMock = {
    activeElement,
    body: {
      appendChild(child) {
        this.lastChild = child;
      },
    },
    createElement(tag) {
      if (tag === "textarea") {
        createdInput = createMockElement();
        return createdInput;
      }
      return createMockElement();
    },
    execCommand(command) {
      if (command === "copy") {
        if (typeof execCommandResult === "function") {
          return execCommandResult();
        }
        return execCommandResult;
      }
      return false;
    },
  };

  const navigatorMock = writeText !== undefined ? { clipboard: { writeText } } : {};

  Object.defineProperty(globalThis, "navigator", {
    value: navigatorMock,
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, "document", {
    value: documentMock,
    configurable: true,
    writable: true,
  });

  try {
    return await run({
      getActiveElementFocused: () => activeElementFocused,
      getCreatedInput: () => createdInput,
    });
  } finally {
    if (originalNavDesc) {
      Object.defineProperty(globalThis, "navigator", originalNavDesc);
    } else {
      delete globalThis.navigator;
    }
    if (originalDocDesc) {
      Object.defineProperty(globalThis, "document", originalDocDesc);
    } else {
      delete globalThis.document;
    }
    globalThis.HTMLElement = originalHtmlElement;
  }
}

test("constants have expected Korean error messages", () => {
  assert.equal(EMPTY_CLIPBOARD_TEXT_ERROR, "복사할 내용이 없습니다.");
  assert.equal(UNSUPPORTED_CLIPBOARD_ERROR, "이 환경에서는 클립보드에 쓸 수 없습니다.");
});

test("writeClipboardText rejects empty or whitespace-only falsey text", async () => {
  await assert.rejects(
    async () => writeClipboardText(""),
    (err) => err instanceof Error && err.message === EMPTY_CLIPBOARD_TEXT_ERROR,
  );
});

test("writeClipboardText uses navigator.clipboard.writeText when available", async () => {
  let copied = null;
  await withMockDom(
    {
      writeText: async (text) => {
        copied = text;
      },
    },
    async () => {
      await writeClipboardText("hello clipboard");
      assert.equal(copied, "hello clipboard");
    },
  );
});

test("writeClipboardText falls back to execCommand when writeText rejects", async () => {
  let fallbackExecuted = false;
  await withMockDom(
    {
      writeText: async () => {
        throw new Error("PermissionDeniedError");
      },
      execCommandResult: () => {
        fallbackExecuted = true;
        return true;
      },
    },
    async ({ getActiveElementFocused, getCreatedInput }) => {
      await writeClipboardText("fallback text");
      assert.equal(fallbackExecuted, true);
      assert.equal(getCreatedInput().value, "fallback text");
      assert.equal(getCreatedInput().removed, true);
      assert.equal(getActiveElementFocused(), true);
    },
  );
});

test("writeClipboardText rethrows writeText error when fallback also fails", async () => {
  const originalError = new Error("NotAllowedError");
  await withMockDom(
    {
      writeText: async () => {
        throw originalError;
      },
      execCommandResult: false,
    },
    async () => {
      await assert.rejects(
        async () => writeClipboardText("failed text"),
        (err) => err === originalError,
      );
    },
  );
});

test("writeClipboardText falls back to execCommand when clipboard API is absent", async () => {
  let fallbackExecuted = false;
  await withMockDom(
    {
      writeText: undefined,
      execCommandResult: () => {
        fallbackExecuted = true;
        return true;
      },
    },
    async ({ getCreatedInput }) => {
      await writeClipboardText("no clipboard api");
      assert.equal(fallbackExecuted, true);
      assert.equal(getCreatedInput().value, "no clipboard api");
      assert.equal(getCreatedInput().removed, true);
    },
  );
});

test("writeClipboardText throws unsupported error when no clipboard API and fallback fails", async () => {
  await withMockDom(
    {
      writeText: undefined,
      execCommandResult: false,
    },
    async () => {
      await assert.rejects(
        async () => writeClipboardText("unsupported text"),
        (err) => err instanceof Error && err.message === UNSUPPORTED_CLIPBOARD_ERROR,
      );
    },
  );
});
