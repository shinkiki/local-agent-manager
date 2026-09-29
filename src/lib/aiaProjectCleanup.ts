/**
 * 프로젝트 세션 정리 제안 한 종류. 규칙 하나가 나머지 종류와 다른 것을 셋이나 요구해
 * `aiaSuggestionRules.ts` 곳곳에 흩어져 있었다 — 세션을 프로젝트로 묶는 집계, 경로
 * 정규화, 그리고 "미분류 세션이 많은 순"이라는 자기만의 정렬. 그 탓에 일반 비교자와
 * 목록 한도까지 이 종류의 예외를 안고 있었다.
 *
 * 종류 하나에만 필요한 것을 한자리에 모아, 규칙 모듈에는 종류와 무관한 뼈대만 남긴다.
 * `RuleContext`는 타입으로만 가져오므로 규칙 모듈과의 런타임 순환은 생기지 않는다.
 */
import type { SessionSummary } from "../types";
import {
  byNumberMetadataDesc,
  bySuggestionId,
  bySuggestionPriority,
  orderSuggestionsBy,
} from "./aiaSuggestionOrder.ts";
import { projectHistoryKey } from "./aiaSuggestionHistory.ts";
import type { RuleContext } from "./aiaSuggestionRules.ts";
import type { AiaSuggestion } from "./aiaSuggestionTypes.ts";

interface ProjectGroup {
  cwd: string;
  name: string;
  total: number;
  unfiled: number;
  updatedAt: number;
}

/** 처음 관찰한 세션으로 프로젝트 묶음의 변하지 않는 표지와 빈 집계값을 만든다. */
function emptyProjectGroup(cwd: string, session: SessionSummary): ProjectGroup {
  return {
    cwd,
    name: session.project?.trim() || projectName(cwd),
    total: 0,
    unfiled: 0,
    updatedAt: 0,
  };
}

/** 세션 하나가 프로젝트 묶음의 집계값에 미치는 영향을 한곳에서 누적한다. */
function accumulateProjectSession(group: ProjectGroup, session: SessionSummary): void {
  group.total += 1;
  if (session.meta.folderIds.length === 0) group.unfiled += 1;
  group.updatedAt = Math.max(group.updatedAt, session.updatedAt ?? session.startedAt ?? 0);
}

/**
 * 프로젝트 정리 제안. 임계에 닿은 묶음만 제안이 되지만, 닿지 않은 묶음도 숨김 기록의
 * 재무장 판정에 필요하다 — 그래서 임계 상태는 종류마다 다른 반환값이 아니라
 * `rule.projectState`로 문맥에 남긴다. 이 종류만 부산물을 갖는 탓에 열한 종류의 반환
 * 모양이 함께 무거워지던 것을 여기 한 줄로 옮겼다.
 */
export function projectCleanupSuggestions(rule: RuleContext): AiaSuggestion[] {
  const minSessions = rule.integer("minSessions", 8, 1, 10_000);
  const minUnfiled = rule.integer("minUnfiled", 5, 1, 10_000);
  const minUnfiledRatio = rule.number("minUnfiledRatio", 0.6, 0, 1);
  const fallbackRearm = rule.number("rearmDelta", 3, 1, 10_000);
  const rearmDelta = rule.rearmInteger("delta", fallbackRearm, 1, 10_000);
  const groups = projectGroups(rule.input.manager.sessions);
  const suggestions: AiaSuggestion[] = [];

  for (const group of groups) {
    const qualifies = group.total >= minSessions && group.unfiled >= minUnfiled && group.unfiled / group.total >= minUnfiledRatio;
    const key = projectHistoryKey(rule.packId, rule.definitionId, group.cwd);
    rule.projectState({ key, qualifies, unfiledCount: group.unfiled });
    if (!qualifies) continue;
    suggestions.push(rule.suggest(group.cwd, "threshold-crossed", {
      projectName: group.name,
      projectPath: group.cwd,
      sessionCount: group.total,
      unfiledCount: group.unfiled,
      updatedAt: group.updatedAt,
      rearmDelta,
    }));
  }
  // 한 정의가 만든 제안이라 우선순위·id 접두사가 모두 같고, 최종 정렬과 같은 비교를 쓴다.
  suggestions.sort(compareProjectSuggestions);
  return suggestions;
}

function projectGroups(sessions: SessionSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    // AIA 작업공간은 프로젝트가 아니므로 정리·분류 제안 대상에서 뺀다.
    if (session.meta.hidden || session.archived || !session.readable || session.isSubagent || session.aiaWorkspace) continue;
    const cwd = normalizeProjectPath(session.cwd);
    if (!cwd) continue;
    const group = groups.get(cwd) ?? emptyProjectGroup(cwd, session);
    accumulateProjectSession(group, session);
    groups.set(cwd, group);
  }
  return [...groups.values()];
}

/**
 * 경로에서 조각을 뺀 나머지 — 드라이브 문자와 뿌리에서 시작하는지 여부. 조각을 다시
 * 이어 붙일 때 앞에 무엇이 서는지는 이 둘만으로 정해진다.
 */
function pathPrefix(source: string): { drive: string; absolute: boolean } {
  const drive = source.match(/^[A-Za-z]:/)?.[0].toLowerCase() ?? "";
  return { drive, absolute: source.startsWith("/") || Boolean(drive) };
}

/** `.`과 `..`을 풀어 낸 경로 조각. 빈 조각은 버린다. */
function pathSegments(rest: string): string[] {
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts;
}

/**
 * 세션 작업 경로를 프로젝트 묶음의 열쇠로 쓸 수 있게 다듬는다. 구분자를 `/`로 통일하고
 * `.`·`..`을 풀며, 드라이브 문자는 소문자로 맞춘다.
 *
 * 조각을 이어 붙이는 일이 갈래마다 따로 적혀 있었다 — 드라이브 갈래는 붙인 뒤 꼬리
 * 슬래시를 정규식으로 도로 떼어 냈고, 뿌리 갈래에는 결코 참이 될 수 없는 `|| "/"`가
 * 남아 있었다(`/${...}`는 언제나 비어 있지 않다). 이어 붙이기를 한 줄로 두고 갈래는
 * 앞에 무엇이 서는지만 고르게 하면, 빈 조각 목록이 갈래마다 어떻게 읽히는지가 그
 * 자리에서 바로 보인다.
 */
export function normalizeProjectPath(value: string | null | undefined): string | null {
  const source = value?.trim().replace(/\\/g, "/");
  if (!source) return null;
  const { drive, absolute } = pathPrefix(source);
  const body = pathSegments(drive ? source.slice(2) : source).join("/");
  if (drive) return body ? `${drive}/${body}` : drive;
  if (absolute) return `/${body}`;
  return body || null;
}

function projectName(path: string): string {
  if (path === "/") return path;
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** 정리 제안은 미분류가 많고 최근에 쓴 프로젝트를 먼저 보여준다. 그 뒤는 뼈대와 같다. */
export const compareProjectSuggestions = orderSuggestionsBy(
  byNumberMetadataDesc("unfiledCount"),
  byNumberMetadataDesc("updatedAt"),
  bySuggestionPriority,
  bySuggestionId,
);

/**
 * 한 번에 보여줄 프로젝트 정리 제안 수. 정리 대상은 프로젝트 수만큼 늘어날 수 있어
 * 상한이 없으면 이 한 종류가 제안 목록을 통째로 차지한다.
 */
const MAX_PROJECT_SUGGESTIONS = 3;

export function limitProjectSuggestions(suggestions: AiaSuggestion[]): AiaSuggestion[] {
  const projects = suggestions
    .filter((suggestion) => suggestion.kind === "projectSessionCleanup")
    .sort(compareProjectSuggestions);
  // 같은 프로젝트를 가리키는 제안은 앞선 하나만 남긴다. 상한은 그렇게 고른 것의 수로 센다.
  const selected = new Set<string>();
  const targets = new Set<string>();
  for (const suggestion of projects) {
    if (targets.has(suggestion.targetId)) continue;
    targets.add(suggestion.targetId);
    selected.add(suggestion.id);
    if (selected.size === MAX_PROJECT_SUGGESTIONS) break;
  }
  return suggestions.filter((suggestion) => suggestion.kind !== "projectSessionCleanup" || selected.has(suggestion.id));
}
