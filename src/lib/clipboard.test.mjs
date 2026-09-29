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

/**
 * 전역 하나를 이 테스트 동안만 갈아 끼우고, 끝나면 원래대로 되돌리는 함수를 돌려준다.
 *
 * `navigator`·`document`·`HTMLElement`가 저마다 "원래 값을 기억하고, 끼우고, 되돌린다"를
 * 조금씩 다른 모양으로 들고 있었다 — 앞의 둘은 속성 기술자로, `HTMLElement`는 값 대입으로.
 * 그래서 갈아 끼울 전역을 하나 더할 때마다 되돌리는 쪽을 손으로 다시 적어야 했고, 한쪽만
 * 적으면 그 전역이 다음 테스트 파일까지 그대로 새어 나간다. 원래 없던 전역은 되돌릴 때 값을
 * 덮어쓰는 것이 아니라 지워야 하므로 값이 아니라 속성 기술자를 기억한다.
 */
function stubGlobal(name, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  return () => {
    if (original) {
      Object.defineProperty(globalThis, name, original);
    } else {
      delete globalThis[name];
    }
  };
}

async function withMockDom({ writeText, execCommandResult = true } = {}, run) {
  class MockHTMLElement {}

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

  const restores = [
    stubGlobal("HTMLElement", MockHTMLElement),
    stubGlobal("navigator", navigatorMock),
    stubGlobal("document", documentMock),
  ];

  try {
    return await run({
      getActiveElementFocused: () => activeElementFocused,
      getCreatedInput: () => createdInput,
    });
  } finally {
    for (const restore of restores.reverse()) restore();
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

test("writeClipboardText keeps a null writeText rejection distinct from an unavailable API", async () => {
  await withMockDom(
    {
      writeText: async () => {
        throw null;
      },
      execCommandResult: false,
    },
    async () => {
      let rejected = false;
      try {
        await writeClipboardText("null rejection");
      } catch (cause) {
        rejected = true;
        assert.equal(cause, null);
      }
      assert.equal(rejected, true);
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
