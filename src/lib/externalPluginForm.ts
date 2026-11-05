import type { ExternalPluginAuthKind } from "../types";
import { splitPluginNames } from "./pluginNames.ts";
import { isOAuthKind } from "./pluginConnectionChange.ts";

export interface ExternalPluginDraft {
  id: string;
  displayName: string;
  /** 다른 이름들. 화면에서는 쉼표로 구분한 한 줄이고, 보낼 때 목록으로 쪼갠다. */
  names: string;
  url: string;
  auth: ExternalPluginAuthKind;
  token: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

/** 사용자가 직접 붙여 넣는 토큰으로 붙는 방식인지. 토큰 입력 칸과 [토큰 변경]이 같은 판정을 쓴다. */
export function usesStaticToken(auth: ExternalPluginAuthKind): boolean {
  return auth === "bearer" || auth === "notionToken";
}

/**
 * 폼 입력값(DraftForm)을 플러그인 등록·수정 요청의 공통 필드 형태로 정리한다.
 * 공백을 접고, Notion 전용 토큰 방식이면 주소를 비우며, OAuth/고정 토큰 방식에 맞추어 유효한 필드만 남긴다.
 */
export function toExternalPluginPayload(draft: ExternalPluginDraft) {
  const isOauth = isOAuthKind(draft.auth);
  const token = usesStaticToken(draft.auth) && draft.token ? draft.token : null;
  const clientId = draft.clientId.trim();
  const clientSecret = draft.clientSecret.trim();
  const scope = draft.scope.trim();
  return {
    displayName: draft.displayName.trim(),
    names: splitPluginNames(draft.names),
    url: draft.auth === "notionToken" ? null : draft.url.trim(),
    auth: draft.auth,
    token,
    clientId: isOauth && clientId ? clientId : null,
    clientSecret: isOauth && clientSecret ? clientSecret : null,
    scope: isOauth && scope ? scope : null,
  };
}
