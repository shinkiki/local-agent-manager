import { call } from "./ipcTransport";
import { notifyBuiltinTools } from "./builtinToolsSignal";

export interface IndexSource {
  id: string;
  name: string;
  path: string;
  agentEnabled: boolean;
  indexedAt: number | null;
  files: number;
  chunks: number;
  excluded: number;
  truncated: boolean;
  /** 이 폴더를 쓰는 프로젝트 경로. `null`이면 모든 프로젝트(기본값). */
  projects: string[] | null;
  /** 프로젝트 적용으로 자동 등록된 폴더면 그 프로젝트 경로. 직접 등록한 폴더는 `null`. */
  projectPath: string | null;
  /** 프로젝트 폴더의 첫 색인이 실패한 이유. 백엔드가 30분 뒤 다시 시도한다. */
  lastError: string | null;
}
/** `all`이면 활성 프로젝트 폴더를 모두(새 프로젝트 포함) 자동 등록, `selected`면 고른 것만. */
export type IndexProjectMode = "all" | "selected";
export interface IndexProjectIssue { path: string; reason: string }
export interface IndexSnapshot {
  enabled: boolean;
  autoRefresh: boolean;
  sources: IndexSource[];
  projectMode: IndexProjectMode;
  /** 선택 적용에서 켠 프로젝트(정규화한 경로). 전체 적용이면 비어 있다. */
  selectedProjects: string[];
  /** 적용했지만 등록하지 못한 프로젝트와 이유. */
  projectIssues: IndexProjectIssue[];
}
export interface IndexHit {
  sourceId: string;
  sourceName: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  digest: string;
  excerpt: string;
  untrusted: boolean;
}
export interface IndexSearchResult {
  hits: IndexHit[];
  staleFiles: string[];
  truncated: boolean;
  untrusted: boolean;
}
export const getIndexSources = () => call<IndexSnapshot>("get_index_sources");
export const addIndexSource = (request: { name: string; path: string }) =>
  notifyBuiltinTools(call<IndexSnapshot>("add_index_source", { request }));
export const setIndexSourceEnabled = (id: string, enabled: boolean) =>
  notifyBuiltinTools(call<IndexSnapshot>("set_index_source_enabled", { request: { id, enabled } }));
/** `null`이면 모든 프로젝트, 목록이면 그 프로젝트(하위 폴더·워크트리 포함)의 에이전트만 쓴다. */
export const setIndexSourceProjects = (id: string, projects: string[] | null) =>
  notifyBuiltinTools(call<IndexSnapshot>("set_index_source_projects", { request: { id, projects } }));
/** 프로젝트 적용 방식 저장. 백엔드가 활성 프로젝트에 맞춰 폴더를 등록·삭제하고 첫 색인은 뒤에서 한다. */
export const setIndexProjects = (mode: IndexProjectMode, projects: string[] = []) =>
  notifyBuiltinTools(call<IndexSnapshot>("set_index_projects", { request: { mode, projects } }));
export const removeIndexSource = (id: string) =>
  notifyBuiltinTools(call<IndexSnapshot>("remove_index_source", { request: { id } }));
export const refreshIndexSource = (id: string) =>
  notifyBuiltinTools(call<IndexSnapshot>("refresh_index_source", { request: { id } }, { timeoutMs: 120_000 }));
/** `project`를 주면 그 프로젝트의 에이전트가 보는 폴더에서만 찾는다. */
export const searchIndex = (request: { query: string; sourceId?: string; limit?: number; project?: string }) =>
  call<IndexSearchResult>("search_index", { request });
export const readIndexExcerpt = (request: { sourceId: string; relativePath: string; digest: string; startLine: number; endLine: number }) =>
  call<IndexHit>("read_index_excerpt", { request });

export const setIndexSettings = (enabled: boolean, autoRefresh: boolean) =>
  notifyBuiltinTools(call<IndexSnapshot>("set_index_settings", { request: { enabled, autoRefresh } }));
