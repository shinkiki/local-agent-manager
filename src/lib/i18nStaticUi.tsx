/**
 * 한국어 리터럴로 그려진 정적 UI를 DOM에서 되짚어 번역하는 장치 — 카탈로그 수집, 노드
 * 순회, MutationObserver 치환기가 여기 있다. 한국어 ↔ 영어 대응표 자체는
 * `i18nStaticDictionary.ts`가 가진다. 문구 한 줄을 고치는 일과 순회 규칙을 고치는 일은
 * 서로 다른 이유로 일어나므로, 표를 나눠 두면 어느 쪽도 다른 쪽을 지나지 않는다.
 *
 * 여기 있는 `getUiTranslationCatalog`는 `i18n.tsx`가 그대로 다시 내보낸다. 화면 쪽
 * import 경로는 예전 그대로 `lib/i18n`이다.
 */
import { useEffect } from "react";
import type { AppLocale } from "../types";
import { localizedUiText } from "./i18nLocale";
import {
  staticUiDictionarySources,
  staticUiEnglish,
  staticUiKoreanByEnglish,
  UI_CATALOG_VERSION,
} from "./i18nStaticDictionary";
import { canonicalSourceText, sendableUiCatalogSource } from "./staticUiText";
import { untranslatableUiProperNoun } from "./uiProperNouns";

/**
 * 되짚을 한국어 원문 보관함. 텍스트 노드의 값과 요소 속성을 한 표에 담고, 자리 이름
 * (`TEXT_SLOT` 또는 속성 이름)으로 가른다. 둘을 다른 표에 두면 원문을 기억하고 되짚는
 * 같은 규칙이 두 벌이 되어, 한쪽만 고친 자리가 어긋난 값에 눌러앉는다.
 */
const originalTextBySlot = new WeakMap<Node, Map<string, string>>();
/** 텍스트 노드 값의 자리 이름. 속성 이름과 겹치지 않도록 속성에 쓸 수 없는 글자를 쓴다. */
const TEXT_SLOT = "#text";
/**
 * 정적 치환이 손대지 않는 자리. 여기 드는 기준은 **그 자리에 앱이 소유하지 않은 문구가
 * 섞여 들어오는가** 하나다 — 사용자 문서·모델 출력·파일 이름을 대응표가 우연히 맞히면
 * 남의 글이 뜻 없이 바뀐다. 앱 라벨만 있는 자리는 여기 들지 않는다. 이미 `text(ko,en)`으로
 * 그린 문구는 렌더 시점에 번역되므로 제외돼도 무해하지만, 제외 영역이 넓으면 그 안의 맨
 * 한글 리터럴까지 함께 갇혀 영영 번역되지 않는다. 그래서 컨테이너를 통째로 막는 대신
 * 사용자 콘텐츠를 내는 자리에 `data-user-content`를 달아 좁힌다.
 */
const STATIC_UI_SKIP_SELECTORS = [
  /** 사용자 콘텐츠를 내는 자리가 스스로 다는 표식. 나머지 항목은 이걸로 좁히지 못한 영역이다. */
  "[data-user-content]",
  /** 등록 폴더에서 읽어 온 문서 본문 — 보기·원문·편집기 모두 남의 글이다. */
  ".markdown-preview",
  ".markdown-source",
  ".doc-editor",
  /** PTY가 뱉은 셸 출력. 앱이 쓴 글자가 한 자도 없다. */
  ".terminal-host",
  /** 모델·CLI가 낸 말과 그 부속(도구 입출력·승인 문답·전사 본문). 전부 세션 산출물이다. */
  ".chat-message > div",
  ".chat-tool pre",
  ".chat-approval pre",
  ".chat-approval-answers strong",
  ".chat-event-error",
  ".message .text-block",
  ".transcript-disclosure pre",
  /**
   * 백엔드가 내려보낸 오류 원문. 앞머리 라벨은 `text()`로 그려 렌더 시점에 번역되고,
   * 뒤따르는 본문만 남의 문자열이다. 그 본문을 번역하는 길은 DOM 되짚기가 아니라
   * 코드화다 — 백엔드가 안정 코드와 파라미터를 함께 보내고 `backendErrors.ts`가 현재
   * 언어의 문장을 고른다. 아직 옮기지 않은 모듈의 실패는 한국어로 남는다.
   */
  ".error-banner",
  /** 식별자·경로·모델 이름. 번역하면 가리키는 대상이 달라진다. */
  "code",
  /** 사용자가 지금 치고 있는 값. */
  "textarea",
].join(",");

/** 정적 문구가 실려 있는 속성. 수집과 번역이 같은 목록을 봐야 한쪽만 늘어나지 않는다. */
const LOCALIZED_ATTRIBUTES = ["placeholder", "aria-label", "title"] as const;
/**
 * 보낼 수 없는 문구(빈 문구·제어 문자·512바이트 초과)는 `sendableUiCatalogSource`가 걸러 낸다 —
 * 하나만 실려도 백엔드가 카탈로그 전체를 거절해 UI 언어를 바꿀 수 없었다(QA #18·#21).
 * 판정과 그 근거는 `staticUiText.ts`에 있고, 네 출처(대응표·정적 원문·`text()` 등록 키·
 * 렌더된 DOM)가 모두 같은 문을 지난다.
 */
export function getUiTranslationCatalog(): { version: string; messages: Record<string, string> } {
  const messages: Record<string, string> = {};
  const add = (source: string) => {
    if (sendableUiCatalogSource(source) && !untranslatableUiProperNoun(source)) messages[source] = source;
  };
  for (const source of staticUiDictionarySources()) add(source);
  for (const source of collectRenderedUiSources()) add(source);
  return { version: UI_CATALOG_VERSION, messages };
}

/**
 * 이 노드 자리가 정적 치환에서 빠지는지. 수집과 치환이 같은 판정을 봐야 한쪽만 건너뛰어
 * 수집된 문구가 끝내 번역되지 않는 일이 없다. 텍스트 노드는 자기를 담은 요소로 판정한다.
 */
function skipsStaticUi(node: Node): boolean {
  const scope = node instanceof Element ? node : node.parentElement;
  return scope === null || scope.closest(STATIC_UI_SKIP_SELECTORS) !== null;
}

/**
 * 정적 치환이 다루는 자리 하나 — 텍스트 노드의 값이거나 요소 속성 하나의 값이다.
 *
 * "어디가 번역 대상인가"는 이 파일에서 두 번 쓰인다: 카탈로그에 실을 원문을 거둘 때와
 * 화면 값을 현재 언어로 고쳐 쓸 때. 그 둘이 각자 순회하면서 "텍스트 노드는 `nodeValue`,
 * 요소는 `LOCALIZED_ATTRIBUTES`를 하나씩" 이라는 같은 규칙을 네 자리에 나눠 적고 있었고,
 * 건너뛰기 판정도 자리마다 따로 걸려 있었다. 속성을 하나 늘리거나 건너뛸 자리를 바꿀 때
 * 네 자리를 모두 맞춰야 했고, 한쪽만 맞추면 수집된 문구가 끝내 번역되지 않는다.
 *
 * 자리의 정의(어디를 읽고 어디에 쓰는가)는 여기 한 벌만 두고, 그 값으로 **무엇을 할지는**
 * 부르는 쪽이 계속 정한다 — 수집은 원문을 모으고, 치환은 고쳐 쓴다.
 */
interface StaticUiSlot {
  /** 원문 보관함의 키가 되는 노드. 속성 자리는 그 속성을 가진 요소다. */
  node: Node;
  /** 같은 노드 안에서 자리를 가르는 이름 — `TEXT_SLOT`이거나 속성 이름. */
  slot: string;
  value: string;
  write: (next: string) => void;
}

/** 노드 하나가 내놓는 자리. 건너뛸 자리거나 값이 빈 속성이면 아무것도 내지 않는다. */
function nodeStaticUiSlots(node: Node): StaticUiSlot[] {
  if (skipsStaticUi(node)) return [];
  if (node.nodeType === Node.TEXT_NODE) {
    return [{
      node,
      slot: TEXT_SLOT,
      value: node.nodeValue ?? "",
      write: (next) => { node.nodeValue = next; },
    }];
  }
  if (!(node instanceof Element)) return [];
  const element = node;
  const slots: StaticUiSlot[] = [];
  for (const attribute of LOCALIZED_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (!value) continue;
    slots.push({
      node: element,
      slot: attribute,
      value,
      write: (next) => element.setAttribute(attribute, next),
    });
  }
  return slots;
}

/**
 * 이 노드 **아래**의 모든 자리. TreeWalker는 `root` 자신을 내지 않으므로, 대상 자체가
 * 필요한 쪽은 `nodeStaticUiSlots`로 따로 다룬다.
 */
function eachDescendantStaticUiSlot(root: Node, visit: (slot: StaticUiSlot) => void): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    for (const slot of nodeStaticUiSlots(node)) visit(slot);
  }
}

function collectRenderedUiSources(): string[] {
  if (typeof document === "undefined") return [];
  const root = document.getElementById("root");
  if (!root) return [];
  const sources = new Set<string>();
  eachDescendantStaticUiSlot(root, ({ value }) => {
    const source = value.trim();
    if (source && source.length <= 500 && /[가-힣]/.test(source)) sources.add(source);
  });
  return [...sources];
}

/**
 * 한 번의 치환에 필요한 두 방향. `translate`는 한국어 원문을 현재 언어로 보내고,
 * `restate`는 화면에 남아 있는 값에서 한국어 원문을 되짚는다. 언어와 카탈로그는 이 두
 * 함수 안에 이미 묶여 있어, 아래 순회 함수들은 그것을 다시 들고 다니지 않는다.
 */
interface StaticUiRewrite {
  translate: (source: string) => string;
  restate: (current: string) => string;
}

/**
 * 한 자리의 값을 현재 언어로 고쳐 쓴 결과. 이미 그 값이면 null이라, 부르는 쪽은 바뀐
 * 때만 DOM에 쓴다.
 *
 * 기억해 둔 원문이 지금 값을 설명하지 못하면 — 원문 그대로도, 그 원문의 번역도 아니면 —
 * 앱이 그 자리를 다시 그린 것이므로 옛 원문을 버리고 화면 값에서 되짚는다. 텍스트 노드와
 * 속성은 값을 읽고 쓰는 곳만 다르고 이 판정은 같아야 한다.
 */
function rewrittenSlotText(
  node: Node,
  slot: string,
  current: string,
  rewrite: StaticUiRewrite,
): string | null {
  const originals = slotOriginals(node);
  const remembered = originals.get(slot);
  const source = remembered && (current === remembered || current === rewrite.translate(remembered))
    ? remembered
    : rewrite.restate(current);
  originals.set(slot, source);
  const next = rewrite.translate(source);
  return next === current ? null : next;
}

/** 대상 자체와 그 아래를 한 벌로 치환한다. TreeWalker가 `root`를 내지 않아 대상은 따로 다룬다. */
function translateStaticUiTree(target: Node, rewrite: StaticUiRewrite): void {
  const apply = (slot: StaticUiSlot) => {
    const next = rewrittenSlotText(slot.node, slot.slot, slot.value, rewrite);
    if (next !== null) slot.write(next);
  };
  // 텍스트 노드도 요소도 아닌 대상(주석 등)은 자기 자리도 아래 자리도 없다.
  if (target.nodeType !== Node.TEXT_NODE && !(target instanceof Element)) return;
  for (const slot of nodeStaticUiSlots(target)) apply(slot);
  if (target.nodeType === Node.TEXT_NODE) return;
  eachDescendantStaticUiSlot(target, apply);
}

export function StaticUiLocalization({ locale, messages }: { locale: AppLocale; messages: Record<string, string> }) {
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return undefined;
    const rewrite: StaticUiRewrite = {
      translate: (source) => localizedStaticText(source, locale, messages),
      restate: (current) => canonicalSourceText(current, messages, staticUiKoreanByEnglish),
    };
    let applying = false;
    const apply = (target: Node) => {
      if (applying) return;
      applying = true;
      translateStaticUiTree(target, rewrite);
      applying = false;
    };
    apply(root);
    const observer = new MutationObserver((mutations) => {
      if (applying) return;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") apply(mutation.target);
        mutation.addedNodes.forEach(apply);
      }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [locale, messages]);
  return null;
}

/** 이 노드의 자리별 원문 보관함. 처음 다루는 노드면 만들어 붙인다. */
function slotOriginals(node: Node): Map<string, string> {
  let originals = originalTextBySlot.get(node);
  if (!originals) {
    originals = new Map();
    originalTextBySlot.set(node, originals);
  }
  return originals;
}

/**
 * 앞뒤 공백은 그대로 두고 가운데 문구만 바꾼다. React가 동적 값 사이에 끼워 넣은 공백까지
 * 번역 결과로 갈아치우면 이웃 문구와 붙어 버리므로, 껍데기는 원본을 그대로 되돌려 준다.
 */
function withSurroundingWhitespace(original: string, translate: (core: string) => string): string {
  const whitespace = original.match(/^(\s*)(.*?)(\s*)$/s);
  const leading = whitespace?.[1] ?? "";
  const core = whitespace?.[2] ?? original;
  const trailing = whitespace?.[3] ?? "";
  return `${leading}${translate(core)}${trailing}`;
}

/**
 * 언어별로 무엇을 쓸지는 `localizedUiText` 한 벌이 정하고, 여기 남는 것은 "앞뒤 공백을
 * 건드리지 않는다"는 이 자리만의 규칙이다. 한국어는 고르는 규칙이 원문을 그대로 돌려주므로
 * 껍데기를 다시 붙여도 원문 그대로다 — 그래서 언어 분기를 한 번 더 둘 이유가 없다.
 */
function localizedStaticText(original: string, locale: AppLocale, messages: Record<string, string>): string {
  return withSurroundingWhitespace(original, (core) => localizedUiText(locale, core, staticUiEnglish, messages));
}
