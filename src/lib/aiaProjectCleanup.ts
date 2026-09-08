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
import type { ProjectDismissalState } from "./aiaSuggestionHistory.ts";
import { numberMetadata, projectHistoryKey } from "./aiaSuggestionHistory.ts";
import type { RuleContext } from "./aiaSuggestionRules.ts";
import type { AiaSuggestion } from "./aiaSuggestions.ts";

interface ProjectGroup {
  cwd: string;
  name: string;
  total: number;
  unfiled: number;
  updatedAt: number;
}

export function projectCleanupSuggestions(rule: RuleContext) {
  const minSessions = rule.integer("minSessions", 8, 1, 10_000);
  const minUnfiled = rule.integer("minUnfiled", 5, 1, 10_000);
  const minUnfiledRatio = rule.number("minUnfiledRatio", 0.6, 0, 1);
  const fallbackRearm = rule.number("rearmDelta", 3, 1, 10_000);
  const rearmDelta = rule.rearmInteger("delta", fallbackRearm, 1, 10_000);
  const groups = projectGroups(rule.input.manager.sessions);
  const projectStates: ProjectDismissalState[] = [];
  const suggestions: AiaSuggestion[] = [];

  for (const group of groups) {
    const qualifies = group.total >= minSessions && group.unfiled >= minUnfiled && group.unfiled / group.total >= minUnfiledRatio;
    const key = projectHistoryKey(rule.packId, rule.definitionId, group.cwd);
    projectStates.push({ key, qualifies, unfiledCount: group.unfiled });
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
  return { suggestions, projectStates };
}

function projectGroups(sessions: SessionSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    // AIA 작업공간은 프로젝트가 아니므로 정리·분류 제안 대상에서 뺀다.
    if (session.meta.hidden || session.archived || !session.readable || session.isSubagent || session.aiaWorkspace) continue;
    const cwd = normalizeProjectPath(session.cwd);
    if (!cwd) continue;
    const existing = groups.get(cwd) ?? {
      cwd,
      name: session.project?.trim() || projectName(cwd),
      total: 0,
      unfiled: 0,
      updatedAt: 0,
    };
    existing.total += 1;
    if (session.meta.folderIds.length === 0) existing.unfiled += 1;
    existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt ?? session.startedAt ?? 0);
    if (!existing.name && session.project?.trim()) existing.name = session.project.trim();
    groups.set(cwd, existing);
  }
  return [...groups.values()];
}

export function normalizeProjectPath(value: string | null | undefined): string | null {
  const source = value?.trim().replace(/\\/g, "/");
  if (!source) return null;
  const drive = source.match(/^[A-Za-z]:/)?.[0].toLowerCase() ?? "";
  const absolute = source.startsWith("/") || Boolean(drive);
  const rest = drive ? source.slice(2) : source;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (drive) return `${drive}/${parts.join("/")}`.replace(/\/$/, "");
  if (absolute) return `/${parts.join("/")}` || "/";
  return parts.join("/") || null;
}

function projectName(path: string): string {
  if (path === "/") return path;
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** 정리 제안은 미분류가 많고 최근에 쓴 프로젝트를 먼저 보여준다. */
export function compareProjectSuggestions(left: AiaSuggestion, right: AiaSuggestion): number {
  return numberMetadata(right, "unfiledCount", 0) - numberMetadata(left, "unfiledCount", 0)
    || numberMetadata(right, "updatedAt", 0) - numberMetadata(left, "updatedAt", 0)
    || right.priority - left.priority
    || left.id.localeCompare(right.id);
}

export function limitProjectSuggestions(suggestions: AiaSuggestion[]): AiaSuggestion[] {
  const projects = suggestions
    .filter((suggestion) => suggestion.kind === "projectSessionCleanup")
    .sort(compareProjectSuggestions);
  const selected = new Set<string>();
  const targets = new Set<string>();
  for (const suggestion of projects) {
    if (targets.has(suggestion.targetId)) continue;
    targets.add(suggestion.targetId);
    selected.add(suggestion.id);
    if (selected.size === 3) break;
  }
  return suggestions.filter((suggestion) => suggestion.kind !== "projectSessionCleanup" || selected.has(suggestion.id));
}
