import type { AccountToolAttribution, AccountToolKind, AccountToolView, AccountToolsSnapshot, AccountToolsView, ProviderHomeToolsView, ProviderId } from "../types";

/**
 * 계정 행에 붙일 도구 아이콘의 표시 규칙.
 *
 * Core는 계정별로 "무엇을 확인했는지"를 그대로 넘겨준다. 이 모듈은 그 사실을 줄이지
 * 않고 한 줄 아이콘으로 옮기는 일만 한다.
 * - 같은 서비스가 커넥터·MCP 서버·플러그인으로 중복되면 하나로 합치고, 가장 강한
 *   귀속 근거를 남긴다.
 * - 미확정(unverified) 항목은 지우지 않고 흐리게 표시한다. 지우면 "이 계정에는 없다"는
 *   확정으로 읽히는데, 실제로는 확인하지 못한 것뿐이다. 같은 서비스가 한 계정에서는
 *   또렷하게, 다른 계정에서는 흐리게 보이는 것이 곧 계정 간 차이다.
 * - 연결 상태 문구는 붙이지 않는다. 아이콘 대체 텍스트는 서비스 이름까지만 쓴다.
 */

/** 아이콘 자산 키. 실제 컴포넌트 매핑은 표시 계층이 갖는다. */
export type AccountToolIconName =
  | "atlassian"
  | "browser"
  | "calendar"
  | "cloud"
  | "code"
  | "connector"
  | "database"
  | "design"
  | "document"
  | "folder"
  | "mail"
  | "mcp"
  | "monitor"
  | "notebook"
  | "payment"
  | "plugin"
  | "presentation"
  | "repository"
  | "search"
  | "site"
  | "spreadsheet"
  | "team"
  | "terminal"
  | "visualize";

/**
 * 알려진 서비스의 아이콘. 기존 디자인 시스템(lucide) 안에 있는 의미 아이콘만 쓴다.
 * 브랜드 마크는 아이콘 라이브러리가 제공하지 않으므로, 서비스의 성격을 나타내는
 * 아이콘으로 대신한다.
 */
const SERVICE_ICONS: Record<string, AccountToolIconName> = {
  atlassian: "atlassian",
  airtable: "spreadsheet",
  asana: "team",
  box: "folder",
  browser: "browser",
  chrome: "browser",
  "claude-code-remote": "connector",
  cloudflare: "cloud",
  codex: "terminal",
  "computer-use": "monitor",
  confluence: "notebook",
  documents: "document",
  dropbox: "folder",
  fetch: "cloud",
  figma: "design",
  filesystem: "folder",
  gmail: "mail",
  github: "repository",
  gitlab: "repository",
  "google-calendar": "calendar",
  "google-drive": "folder",
  jira: "atlassian",
  linear: "team",
  mail: "mail",
  memory: "database",
  "node-repl": "terminal",
  notion: "notebook",
  "openai-developer-docs": "document",
  pdf: "document",
  playwright: "browser",
  postgres: "database",
  presentations: "presentation",
  search: "search",
  sentry: "code",
  sites: "site",
  slack: "team",
  spreadsheets: "spreadsheet",
  sqlite: "database",
  stripe: "payment",
  supabase: "database",
  teams: "team",
  "template-creator": "document",
  vercel: "cloud",
  visualize: "visualize",
};

/** 알려지지 않은 서비스는 도구의 종류만 드러내는 일반 아이콘으로 떨어뜨린다. */
const KIND_FALLBACK_ICONS: Record<AccountToolKind, AccountToolIconName> = {
  connector: "connector",
  mcpServer: "mcp",
  plugin: "plugin",
};

export function accountToolIcon(tool: Pick<AccountToolView, "service" | "kind">): AccountToolIconName {
  return SERVICE_ICONS[tool.service] ?? KIND_FALLBACK_ICONS[tool.kind] ?? "plugin";
}

export interface AccountToolBadge {
  key: string;
  service: string;
  label: string;
  icon: AccountToolIconName;
  /** 이 계정에서 쓸 수 있는지 확인하지 못했다. 흐리게 표시한다. */
  unverified: boolean;
}

export interface AccountToolBadgeList {
  badges: AccountToolBadge[];
  /** 표시 한도를 넘겨 접힌 도구 수 */
  overflow: number;
}

/** 귀속 근거의 강도. 같은 서비스가 여러 경로로 잡혔을 때 무엇을 남길지 정한다. */
const ATTRIBUTION_STRENGTH: Record<AccountToolAttribution, number> = {
  account: 0,
  shared: 1,
  unverified: 2,
};

/**
 * 표시 순서. 계정 단위 항목을 확정·미확정 순으로 앞에 모으고, 계정과 무관한 공용
 * 항목을 뒤로 보낸다. 계정 간 차이는 계정 단위 항목에서만 생기므로, 한도에 잘려도
 * 차이가 보이는 쪽이 먼저 남아야 한다.
 */
const ATTRIBUTION_ORDER: Record<AccountToolAttribution, number> = {
  account: 0,
  unverified: 1,
  shared: 2,
};

/** 같은 서비스가 여러 경로로 잡히면 가장 강한 귀속 근거를 남긴다. */
function stronger(current: AccountToolView, candidate: AccountToolView): AccountToolView {
  return ATTRIBUTION_STRENGTH[candidate.attribution] < ATTRIBUTION_STRENGTH[current.attribution] ? candidate : current;
}

export const DEFAULT_ACCOUNT_TOOL_BADGE_LIMIT = 10;

/**
 * 배지로 옮길 수 있는 도구 묶음. 등록 계정과 홈 계정이 같은 표시 규칙을 쓰므로
 * 목록만 받는다.
 */
export type AccountToolBadgeSource = Pick<AccountToolsView, "tools">;

/**
 * 계정 하나의 도구 목록을 아이콘 배지로 바꾼다.
 */
export function accountToolBadges(
  view: AccountToolBadgeSource | null | undefined,
  limit: number = DEFAULT_ACCOUNT_TOOL_BADGE_LIMIT,
): AccountToolBadgeList {
  if (!view || view.tools.length === 0) return { badges: [], overflow: 0 };

  const merged = new Map<string, AccountToolView>();
  for (const tool of view.tools) {
    if (!tool.exposed || tool.service.length === 0) continue;
    const current = merged.get(tool.service);
    merged.set(tool.service, current ? stronger(current, tool) : tool);
  }

  const ordered = [...merged.values()].sort((left, right) => {
    const rank = ATTRIBUTION_ORDER[left.attribution] - ATTRIBUTION_ORDER[right.attribution];
    return rank !== 0 ? rank : left.label.localeCompare(right.label);
  });

  const visible = limit > 0 ? ordered.slice(0, limit) : ordered;
  return {
    badges: visible.map((tool) => ({
      key: tool.id,
      service: tool.service,
      label: tool.label,
      icon: accountToolIcon(tool),
      unverified: tool.attribution === "unverified",
    })),
    overflow: ordered.length - visible.length,
  };
}

/** 스냅샷에서 계정 하나의 요약을 꺼낸다. */
export function accountToolsFor(
  snapshot: AccountToolsSnapshot | null | undefined,
  accountId: string,
): AccountToolsView | null {
  return snapshot?.accounts.find((view) => view.accountId === accountId) ?? null;
}

/** 스냅샷에서 공급자 하나의 홈 계정 요약을 꺼낸다. */
export function homeToolsFor(
  snapshot: AccountToolsSnapshot | null | undefined,
  provider: ProviderId,
): ProviderHomeToolsView | null {
  return snapshot?.homes.find((view) => view.provider === provider) ?? null;
}
