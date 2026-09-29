import type { ProviderId } from "../types";
import { memberGuard } from "./memberGuard.ts";
import type { Phrase } from "./phrase.ts";
import { isProviderId } from "./providerIds.ts";

/** 별도 창(팝아웃)으로 열 대상. 주소 쿼리로 전달되어 새 창이 해당 화면만 바로 연다. */
export type PopoutRequest =
  | { kind: "aia"; windowId: string }
  | { kind: "chat"; chatId: string }
  | { kind: "session"; source: ProviderId; sessionId: string }
  | { kind: "gitDiff"; projectPath: string; path: string; originalPath: string | null; staged: boolean; commit: string | null };

type PopoutKind = PopoutRequest["kind"];

/**
 * 종류별 기본 창 제목. 창을 여는 자리가 언어를 고르지만, 고를 값 자체는 다른 종류별
 * 규칙과 같은 표에 있어야 종류를 더할 때 한 줄만 늘어난다 — 제목만 창을 여는 쪽의
 * 종류별 분기로 남아 있었고, 그쪽은 규약 표를 보지 않으므로 종류가 늘면 새 종류가 조용히
 * 한국어로만 떴다. 이 모듈은 주소·창 이름과 함께 순수 함수로 시험되므로 언어 선택(런타임
 * 로캘)까지 들이지 않고 표기만 내준다.
 *
 * 표기의 모양과 `en`이 `null`일 때의 뜻, 지금 언어로 푸는 규칙은 `phrase`에 한 벌로 있다 —
 * 도움말 문구·요일 이름도 같은 모양을 쓴다.
 */

/**
 * 팝아웃 종류별 규약(주소 쿼리 해석·조립, 대상 식별자, 기본 창 제목).
 * 네 함수가 종류별 if-else 분기를 각자 들고 있으면 종류가 늘거나 파라미터가 바뀔 때
 * 한쪽만 고쳐지는 어긋남이 생기므로, 종류별 입출력 규칙을 한곳에 모아 둔다.
 *
 * 표에서 파생되는 값은 이 파일 밖으로 내보내지 않는다 — 바깥이 쓰는 모양은 주소 해석·조립과
 * 창 이름·기본 제목 넷뿐이고, 종류 목록이나 대상 식별자를 함께 내주면 그 넷을 거치지 않고
 * 종류별 규칙을 다시 조립하는 두 번째 경로가 열린다(예: 창 이름을 직접 이어 붙이는 자리).
 * 그 경로에는 Tauri label 문자 규칙도, 알 수 없는 종류를 거르는 판정도 없다.
 */
interface PopoutKindSpec<T extends PopoutRequest> {
  defaultTitle: Phrase;
  parse(params: URLSearchParams): T | null;
  populateParams(request: T, params: URLSearchParams): void;
  targetId(request: T): string;
}

const POPOUT_SPECS: { [K in PopoutKind]: PopoutKindSpec<Extract<PopoutRequest, { kind: K }>> } = {
  aia: {
    defaultTitle: { ko: "AIA", en: null },
    targetId: (request) => request.windowId,
    populateParams: (request, params) => {
      params.set("window", request.windowId);
    },
    parse: (params) => {
      const windowId = params.get("window");
      return windowId && /^[A-Za-z0-9_-]{1,80}$/.test(windowId) ? { kind: "aia", windowId } : null;
    },
  },
  chat: {
    defaultTitle: { ko: "채팅", en: "Chat" },
    targetId: (request) => request.chatId,
    populateParams: (request, params) => {
      params.set("chat", request.chatId);
    },
    parse: (params) => {
      const chatId = params.get("chat")?.trim();
      return chatId ? { kind: "chat", chatId } : null;
    },
  },
  session: {
    defaultTitle: { ko: "세션", en: "Session" },
    targetId: (request) => `${request.source}-${request.sessionId}`,
    populateParams: (request, params) => {
      params.set("source", request.source);
      params.set("session", request.sessionId);
    },
    parse: (params) => {
      const source = params.get("source");
      const sessionId = params.get("session")?.trim();
      if (!sessionId || !isProviderId(source)) return null;
      return { kind: "session", source, sessionId };
    },
  },
  // 프로젝트 화면의 diff 창. 대상은 백엔드에 있으므로(프로젝트·경로·커밋) 주소에 그 식별자만
  // 싣고 새 창이 다시 읽는다. 같은 파일·같은 대상을 다시 열면 기존 창이 앞으로 온다.
  gitDiff: {
    defaultTitle: { ko: "변경 내용", en: "Diff" },
    targetId: (request) => `${request.commit ?? (request.staged ? "staged" : "worktree")}-${request.path}`,
    populateParams: (request, params) => {
      params.set("project", request.projectPath);
      params.set("path", request.path);
      if (request.originalPath) params.set("orig", request.originalPath);
      if (request.commit) params.set("commit", request.commit);
      else if (request.staged) params.set("staged", "1");
    },
    parse: (params) => {
      const projectPath = params.get("project")?.trim();
      const path = params.get("path")?.trim();
      if (!projectPath || !path) return null;
      const commit = params.get("commit")?.trim() || null;
      if (commit && !/^[0-9a-fA-F]{4,64}$/.test(commit)) return null;
      return {
        kind: "gitDiff",
        projectPath,
        path,
        originalPath: params.get("orig")?.trim() || null,
        staged: commit === null && params.get("staged") === "1",
        commit,
      };
    },
  },
};

/**
 * 지원 종류는 규약 표의 키에서 꺼낸다. 종류 추가 시 목록만 따로 갱신할 자리를 남기지 않는다.
 * 키를 종류로 되돌리는 단언을 거치지 않는 것이 요점이라, 문자열 목록을 그대로 `memberGuard`에
 * 넘긴다 — 주소 쿼리에서 온 값을 그 목록에 물어보는 것이 이 표의 유일한 용도다.
 */
const isPopoutKind = memberGuard<PopoutKind>(Object.keys(POPOUT_SPECS));

function specFor(request: PopoutRequest): PopoutKindSpec<PopoutRequest> {
  return POPOUT_SPECS[request.kind] as unknown as PopoutKindSpec<PopoutRequest>;
}

/** 주소의 popout 쿼리를 해석한다. 값이 불완전하면 일반 화면으로 연다. */
export function parsePopoutRequest(search: string): PopoutRequest | null {
  const params = new URLSearchParams(search);
  const kind = params.get("popout");
  if (!isPopoutKind(kind)) return null;
  return POPOUT_SPECS[kind].parse(params);
}

export function popoutSearch(request: PopoutRequest): string {
  const params = new URLSearchParams();
  params.set("popout", request.kind);
  specFor(request).populateParams(request, params);
  return `?${params.toString()}`;
}

/**
 * 팝아웃 대상의 고유 식별 문자열. 창 이름을 만드는 아래 함수만 쓴다.
 */
function popoutTargetId(request: PopoutRequest): string {
  return specFor(request).targetId(request);
}

/**
 * 같은 대상을 다시 열면 창을 늘리지 않고 기존 창을 재사용하도록 대상별 고정 이름을
 * 만든다. Tauri 창 label 규칙(영숫자·-·_)에 맞춰 나머지 문자는 -로 치환한다.
 */
export function popoutWindowName(request: PopoutRequest): string {
  return `popout-${request.kind}-${popoutTargetId(request)}`.replace(/[^0-9A-Za-z_-]/g, "-");
}

/** 팝아웃 창 타이틀에 붙는 공통 앱 접미사. */
const POPOUT_APP_TITLE_SUFFIX = " · Agent Manager";

/** 팝아웃 종류별 기본 제목. 화면에서 별도 제목을 정하기 전에 쓴다. */
export function popoutDefaultTitle(request: PopoutRequest): Phrase {
  return specFor(request).defaultTitle;
}

/** 팝아웃 창 타이틀바와 웹 문서 제목에 쓸 형식화된 전체 제목. */
export function formatPopoutWindowTitle(title: string): string {
  return `${title}${POPOUT_APP_TITLE_SUFFIX}`;
}
