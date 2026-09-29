import { isLocalFileHref, safeHref } from "./markdownLinks.ts";

/**
 * 다이어그램 안의 링크를 어떻게 다룰지. 원문이 에이전트 답변에서 오므로 주소를 그대로
 * 브라우저에 넘기지 않고, 여기서 갈래를 정해 앱이 직접 연다.
 */
export type DiagramLinkAction =
  | { kind: "external"; href: string }
  | { kind: "local"; href: string }
  | { kind: "blocked" };

/**
 * mermaid는 `click A href "..."`를 `securityLevel`과 무관하게 `<a target="_blank">`로 그린다
 * (막히는 것은 `click A call fn()` 쪽뿐이다). 그 앵커를 그대로 두면 네이티브 웹뷰가 그 주소로
 * **이동해 앱 화면이 사라진다.** 그래서 앵커의 href를 걷어내고 이 판정으로 앱이 연다.
 *
 * 판정 규칙은 마크다운 링크와 같은 부품(`safeHref`·`isLocalFileHref`)을 쓴다 — 같은 문서 안에서
 * 글의 링크와 그림의 링크가 다르게 움직이면 사용자가 규칙을 배울 수 없다.
 *
 * 다만 받아들이는 스킴은 더 좁다. `mailto:`나 `#조각`은 문서에서는 뜻이 있지만 그림 안에서는
 * 무엇이 열릴지 예측할 수 없어 막는다. 남는 것은 http(s)와 로컬 파일 경로뿐이다.
 */
export function diagramLinkAction(raw: string | null | undefined): DiagramLinkAction {
  const trimmed = raw?.trim();
  const href = trimmed ? safeHref(trimmed) : null;
  if (!href) return { kind: "blocked" };
  if (isLocalFileHref(href)) return { kind: "local", href };
  return /^https?:/i.test(href) ? { kind: "external", href } : { kind: "blocked" };
}
