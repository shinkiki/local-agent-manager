import type { ServiceIconName } from "../assets/serviceIcons";
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
 * 알려진 서비스를 어떻게 그릴지. 한 서비스가 한 줄을 갖는다.
 *
 * - `icon`은 서비스의 성격을 나타내는 lucide 아이콘이다. 표식이 없는 서비스가 떨어질 자리다.
 * - `brand`는 구워 둔 공식 표식(`npm run icons:generate`) 이름이고, 상표가 있는 자리에만 붙는다.
 *   파일·검색·기억처럼 브랜드가 아닌 도구는 성격 아이콘으로 남는다 — 브랜드 원색은 상표에만
 *   쓴다는 규칙이 지켜져야 상표가 있는 자리와 없는 자리가 한눈에 갈린다. 코덱스와 OpenAI 문서
 *   서버는 같은 OpenAI 표식을 쓴다.
 *
 * 두 값이 서비스 이름을 키로 삼는 표 두 벌로 나뉘어 있었다. 표식을 굽는 목록에서 서비스를
 * 빼면 곧바로 성격 아이콘으로 떨어져야 하는데, 그 조건은 "표식 표의 모든 키가 아이콘 표에도
 * 있다"였고 어디에서도 확인되지 않았다 — 표식만 있고 아이콘이 없는 줄을 더하면 그 서비스는
 * 표식을 내린 순간 조용히 종류별 일반 아이콘으로 떨어진다. 한 서비스를 한 줄로 두면 표식을
 * 지우는 일이 곧 `brand`만 지우는 일이라 그 갈림이 생기지 않는다.
 */
const SERVICE_DISPLAY: Record<string, { icon: AccountToolIconName; brand?: ServiceIconName }> = {
  atlassian: { icon: "atlassian", brand: "atlassian" },
  airtable: { icon: "spreadsheet", brand: "airtable" },
  asana: { icon: "team", brand: "asana" },
  box: { icon: "folder", brand: "box" },
  browser: { icon: "browser" },
  chrome: { icon: "browser", brand: "chrome" },
  "claude-code-remote": { icon: "connector", brand: "claude" },
  cloudflare: { icon: "cloud", brand: "cloudflare" },
  codex: { icon: "terminal", brand: "openai" },
  "computer-use": { icon: "monitor" },
  confluence: { icon: "notebook", brand: "confluence" },
  documents: { icon: "document" },
  dropbox: { icon: "folder", brand: "dropbox" },
  fetch: { icon: "cloud" },
  figma: { icon: "design", brand: "figma" },
  filesystem: { icon: "folder" },
  gmail: { icon: "mail", brand: "gmail" },
  github: { icon: "repository", brand: "github" },
  gitlab: { icon: "repository", brand: "gitlab" },
  "google-calendar": { icon: "calendar", brand: "google-calendar" },
  "google-drive": { icon: "folder", brand: "google-drive" },
  jira: { icon: "atlassian", brand: "jira" },
  linear: { icon: "team", brand: "linear" },
  mail: { icon: "mail" },
  memory: { icon: "database" },
  "node-repl": { icon: "terminal" },
  notion: { icon: "notebook", brand: "notion" },
  "openai-developer-docs": { icon: "document", brand: "openai" },
  pdf: { icon: "document" },
  playwright: { icon: "browser", brand: "playwright" },
  postgres: { icon: "database", brand: "postgres" },
  presentations: { icon: "presentation" },
  search: { icon: "search" },
  sentry: { icon: "code", brand: "sentry" },
  sites: { icon: "site" },
  slack: { icon: "team", brand: "slack" },
  spreadsheets: { icon: "spreadsheet" },
  sqlite: { icon: "database", brand: "sqlite" },
  stripe: { icon: "payment", brand: "stripe" },
  supabase: { icon: "database", brand: "supabase" },
  teams: { icon: "team" },
  "template-creator": { icon: "document" },
  vercel: { icon: "cloud", brand: "vercel" },
  visualize: { icon: "visualize" },
};

/** 알려지지 않은 서비스는 도구의 종류만 드러내는 일반 아이콘으로 떨어뜨린다. */
const KIND_FALLBACK_ICONS: Record<AccountToolKind, AccountToolIconName> = {
  connector: "connector",
  mcpServer: "mcp",
  plugin: "plugin",
};

export function accountToolIcon(tool: Pick<AccountToolView, "service" | "kind">): AccountToolIconName {
  return SERVICE_DISPLAY[tool.service]?.icon ?? KIND_FALLBACK_ICONS[tool.kind] ?? "plugin";
}

/**
 * 이 도구를 공식 표식으로 그릴 수 있으면 그 이름, 아니면 null(성격 아이콘으로 떨어진다).
 * 표시 계층은 이 값을 배지의 `brand`로 받으므로 여기서 따로 내보내지 않는다 — 내보내면
 * 배지를 거치지 않고 표식만 따로 묻는 자리가 생기고, 그 자리는 `unverified` 흐림 처리를
 * 함께 받지 못한다.
 */
function accountToolBrand(tool: Pick<AccountToolView, "service">): ServiceIconName | null {
  return SERVICE_DISPLAY[tool.service]?.brand ?? null;
}

export interface AccountToolBadge {
  key: string;
  service: string;
  label: string;
  icon: AccountToolIconName;
  /** 공식 표식이 있으면 그 이름. 없으면 `icon`의 성격 아이콘으로 그린다. */
  brand: ServiceIconName | null;
  /** 이 계정에서 쓸 수 있는지 확인하지 못했다. 흐리게 표시한다. */
  unverified: boolean;
}

export interface AccountToolBadgeList {
  badges: AccountToolBadge[];
  /** 표시 한도를 넘겨 접힌 도구 수 */
  overflow: number;
}

/**
 * 귀속 근거를 어떻게 다룰지. 한 근거가 한 줄을 갖는다.
 *
 * - `strength`는 같은 서비스가 여러 경로로 잡혔을 때 무엇을 남길지 정한다. 작을수록 강하다.
 * - `order`는 표시 순서다. 계정 단위 항목을 확정·미확정 순으로 앞에 모으고, 계정과 무관한
 *   공용 항목을 뒤로 보낸다. 계정 간 차이는 계정 단위 항목에서만 생기므로, 한도에 잘려도
 *   차이가 보이는 쪽이 먼저 남아야 한다.
 *
 * 두 값이 귀속 근거를 키로 삼는 표 두 벌로 나뉘어 있었다. 근거를 하나 더할 때 한쪽 표에만
 * 적으면 다른 표에서 그 근거는 `undefined`가 되는데, 두 값 모두 뺄셈에 들어가므로 합치기는
 * 늘 나중 항목을 버리고 정렬 비교자는 NaN을 돌려준다 — 오류 없이 배지 순서만 흐트러진다.
 * 같은 파일의 `SERVICE_DISPLAY`를 한 줄로 모은 이유와 같아, 여기도 한 줄로 둔다.
 */
const ATTRIBUTION_DISPLAY: Record<AccountToolAttribution, { strength: number; order: number }> = {
  account: { strength: 0, order: 0 },
  unverified: { strength: 2, order: 1 },
  shared: { strength: 1, order: 2 },
};

/** 같은 서비스가 여러 경로로 잡히면 가장 강한 귀속 근거를 남긴다. */
function stronger(current: AccountToolView, candidate: AccountToolView): AccountToolView {
  return ATTRIBUTION_DISPLAY[candidate.attribution].strength < ATTRIBUTION_DISPLAY[current.attribution].strength
    ? candidate
    : current;
}

/** 같은 서비스의 도구 중복을 하나로 합치고 노출 대상만 남긴다. */
function mergeToolsByService(tools: AccountToolView[]): AccountToolView[] {
  const merged = new Map<string, AccountToolView>();
  for (const tool of tools) {
    if (!tool.exposed || tool.service.length === 0) continue;
    const current = merged.get(tool.service);
    merged.set(tool.service, current ? stronger(current, tool) : tool);
  }
  return [...merged.values()];
}

/** 계정 도구 표시 순서: 귀속 근거(계정 > 미확정 > 공용) 우선 후 레이블 사전순 */
function compareAccountTools(left: AccountToolView, right: AccountToolView): number {
  const rank = ATTRIBUTION_DISPLAY[left.attribution].order - ATTRIBUTION_DISPLAY[right.attribution].order;
  return rank !== 0 ? rank : left.label.localeCompare(right.label);
}

/** 도구 정보를 UI 표시용 배지 객체로 변환한다. */
function toAccountToolBadge(tool: AccountToolView): AccountToolBadge {
  return {
    key: tool.id,
    service: tool.service,
    label: tool.label,
    icon: accountToolIcon(tool),
    brand: accountToolBrand(tool),
    unverified: tool.attribution === "unverified",
  };
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

  const merged = mergeToolsByService(view.tools);
  const ordered = merged.sort(compareAccountTools);
  const visible = limit > 0 ? ordered.slice(0, limit) : ordered;
  return {
    badges: visible.map(toAccountToolBadge),
    overflow: ordered.length - visible.length,
  };
}

/** 스냅샷의 선택 목록에서 조건에 맞는 요약 하나를 찾는다. */
function snapshotViewFor<View>(
  views: readonly View[] | null | undefined,
  matches: (view: View) => boolean,
): View | null {
  return views?.find(matches) ?? null;
}

/** 스냅샷에서 계정 하나의 요약을 꺼낸다. */
export function accountToolsFor(
  snapshot: AccountToolsSnapshot | null | undefined,
  accountId: string,
): AccountToolsView | null {
  return snapshotViewFor(snapshot?.accounts, (view) => view.accountId === accountId);
}

/** 스냅샷에서 공급자 하나의 홈 계정 요약을 꺼낸다. */
export function homeToolsFor(
  snapshot: AccountToolsSnapshot | null | undefined,
  provider: ProviderId,
): ProviderHomeToolsView | null {
  return snapshotViewFor(snapshot?.homes, (view) => view.provider === provider);
}
