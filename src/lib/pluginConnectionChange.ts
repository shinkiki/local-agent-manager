import type { ExternalPluginAuthKind } from "../types";

/**
 * 편집이 연결 지점을 바꾸는지 — 백엔드 `PluginEditPlan::decide`의 `connection_changed`와 같은 답을
 * 내야 한다. 백엔드는 정규화한 값끼리 비교하므로(`validate_mcp_endpoint`가 `Url`로 다시 쓰고,
 * `validate_scope`가 공백을 접고 중복을 뺀다) 화면도 같은 모양으로 맞춘 뒤 비교한다. 입력 그대로
 * 비교하면 `a  b`와 `a b`, 호스트 대소문자·끝 `/` 차이만으로 "자격증명이 초기화된다"는 확인을
 * 띄우는데 저장해 보면 아무것도 초기화되지 않는다.
 */
export interface PluginConnectionDraft {
  auth: ExternalPluginAuthKind;
  url: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

export interface PluginConnectionCurrent {
  auth: ExternalPluginAuthKind;
  url?: string | null;
  scope?: string | null;
}

/** 브라우저 승인으로 토큰을 받는 방식인지. 두 방식은 화면에서 같은 자리를 쓴다. */
export function isOAuthKind(auth: ExternalPluginAuthKind): boolean {
  return auth === "oauth" || auth === "oauthDevice";
}

/** `validate_scope`와 같은 정규화: 공백으로 나누고 처음 나온 순서대로 중복을 뺀다. */
export function normalizedPluginScope(scope: string | null | undefined): string {
  return [...new Set((scope ?? "").split(/\s+/).filter(Boolean))].join(" ");
}

/** `validate_mcp_endpoint`가 저장하는 `Url` 직렬화와 같은 WHATWG 모양. 해석이 안 되면 입력 그대로다. */
export function normalizedPluginUrl(url: string | null | undefined): string {
  const trimmed = (url ?? "").trim();
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

export function isPluginConnectionChanged(draft: PluginConnectionDraft, editing: PluginConnectionCurrent | null): boolean {
  if (!editing) return false;
  return (
    draft.auth !== editing.auth
    || (draft.auth !== "notionToken" && normalizedPluginUrl(draft.url) !== normalizedPluginUrl(editing.url))
    || (isOAuthKind(draft.auth) && (draft.clientId.trim() !== "" || draft.clientSecret.trim() !== ""))
    || (isOAuthKind(draft.auth) && normalizedPluginScope(draft.scope) !== normalizedPluginScope(editing.scope))
  );
}
