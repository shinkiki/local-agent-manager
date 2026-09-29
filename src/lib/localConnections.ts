import type { ChatProviderOptions, LocalConnectionOptions } from "../types";

/**
 * 로컬 공급자의 "연결 · 모델" 선택(M7 7.4).
 *
 * 카탈로그는 기본 연결의 모델을 `models`에, 연결별 목록을 `localConnections`에 싣는다.
 * 화면은 연결을 먼저 고르고 그 연결의 목록에서 모델을 고른다 — 같은 모델 이름이 두
 * 연결에 있어도 백엔드가 연결 id 로 가르므로 여기서는 목록만 바꿔 끼우면 된다.
 */

/** 고른 연결. 빈 id 는 기본 연결이고, 없는 id 는 목록에 없으므로 null 이다. */
export function selectedLocalConnection(
  catalog: ChatProviderOptions | null,
  connectionId: string,
): LocalConnectionOptions | null {
  const list = catalog?.localConnections ?? [];
  if (list.length === 0) return null;
  if (!connectionId) return list.find((entry) => entry.isDefault) ?? list[0] ?? null;
  return list.find((entry) => entry.id === connectionId) ?? null;
}

/**
 * 고른 연결의 모델 목록으로 바꿔 끼운 카탈로그. 로컬 연결 목록이 없는 공급자는 그대로다.
 * 목록에 없는 id 를 골랐으면(연결이 지워진 반복요청 등) 기본 연결 목록을 쓴다 — 빈 목록을
 * 보여 주면 사용자는 서버가 죽은 줄 안다.
 */
export function catalogForLocalConnection(
  catalog: ChatProviderOptions | null,
  connectionId: string,
): ChatProviderOptions | null {
  if (!catalog || !catalog.localConnections?.length) return catalog;
  const connection = selectedLocalConnection(catalog, connectionId)
    ?? selectedLocalConnection(catalog, "");
  if (!connection) return catalog;
  return { ...catalog, models: connection.models, catalogError: connection.catalogError };
}

/** 연결 한 줄 표시. 꺼진 연결과 기본 연결을 표시로 가른다. */
export function localConnectionLabel(
  connection: LocalConnectionOptions,
  text: (ko: string, en: string) => string,
): string {
  const marks: string[] = [];
  if (connection.isDefault) marks.push(text("기본", "default"));
  if (!connection.enabled) marks.push(text("꺼짐", "off"));
  return marks.length > 0 ? `${connection.label} (${marks.join(" · ")})` : connection.label;
}

/** 요청에 실을 값. 로컬 공급자가 아니거나 기본 연결이면 보내지 않는다. */
export function localConnectionIdForRequest(source: string, connectionId: string): string | null {
  if (source !== "local") return null;
  const trimmed = connectionId.trim();
  return trimmed === "" ? null : trimmed;
}
