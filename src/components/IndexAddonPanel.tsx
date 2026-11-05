import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { addIndexSource, getIndexSources, refreshIndexSource, removeIndexSource, searchIndex, setIndexProjects, setIndexSettings, setIndexSourceEnabled, setIndexSourceProjects, type IndexProjectMode, type IndexSearchResult, type IndexSnapshot, type IndexSource } from "../lib/ipcIndex";
import { getProjectRegistry } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/errorText";
import { AppToggle, ErrorBanner, useBusyAction, useConfirm } from "./Shared";
import { IndexProjectsSection, indexPathKey as pathKey, sameIndexPath as samePath } from "./IndexProjectsSection";
import "./IndexAddonPanel.css";

interface ProjectOption { path: string; name: string; listed: boolean }

const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
/** 백엔드가 받는 적용 프로젝트 수 상한(index_addon.rs set_index_source_projects). */
const MAX_SCOPE_PROJECTS = 64;

/**
 * 고를 수 있는 프로젝트. 활성 프로젝트에 더해, 이미 저장된 범위에 남아 있지만 지금 목록에
 * 없는 경로(제외·삭제된 프로젝트)도 세워 둔다 — 체크만 남고 칸이 사라지면 풀 길이 없다.
 * `projects`를 주면 그 폴더의 범위만 더한다. 전체 적용인 폴더에 남의 목록 밖 경로가 켜진 채
 * 보이면 실제로는 적용되지 않는 프로젝트를 적용된 것처럼 읽는다.
 */
function projectOptions(registry: ProjectOption[], projects: string[]): ProjectOption[] {
  const options = new Map(registry.map((project) => [pathKey(project.path), project]));
  for (const path of projects) {
    if (!options.has(pathKey(path))) options.set(pathKey(path), { path, name: baseName(path), listed: false });
  }
  return [...options.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/**
 * 프로젝트 한 칸을 켜고 끈 뒤의 범위. 전체 적용(null)에서 하나를 끄면 지금 목록의 나머지
 * 프로젝트를 고른 상태가 되고 전체 적용은 풀린다. 빈 범위는 저장할 수 없어 null을 돌려준다.
 */
function toggledIndexScope(projects: string[] | null, listed: string[], project: string): string[] | null {
  const chosen = projects ?? listed;
  const next = chosen.some((item) => samePath(item, project)) ? chosen.filter((item) => !samePath(item, project)) : [...chosen, project];
  return next.length > 0 ? next : null;
}

/** UI collects choices; registration, indexing and search policy live in Rust Core. */
export function IndexAddonPanel({ active }: { active: boolean }) {
  const { text } = useI18n();
  const [snapshot, setSnapshot] = useState<IndexSnapshot | null>(null);
  const [registry, setRegistry] = useState<ProjectOption[]>([]);
  const [registryFailed, setRegistryFailed] = useState(false);
  // 적용 프로젝트 목록을 펼친 폴더. 기본은 접어 두고 요약만 보인다.
  const [openScope, setOpenScope] = useState<Record<string, true>>({});
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [previewProject, setPreviewProject] = useState("");
  const [result, setResult] = useState<IndexSearchResult | null>(null);
  const { busy, error, setError, run } = useBusyAction();
  const { confirm, confirmDialog } = useConfirm();
  const revision = useRef(0);
  const resultRevision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active || busy !== null) return;
    let cancelled = false;
    const load = () => {
      const current = ++revision.current;
      void getIndexSources().then((next) => {
        if (!cancelled && current === revision.current) setSnapshot(next);
      }).catch((cause) => { if (!cancelled && current === revision.current) setError(errorText(cause)); });
    };
    load();
    const timer = window.setInterval(load, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active, busy, setError]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // 프로젝트 목록을 못 읽어도 인덱스는 쓸 수 있다. 저장된 범위의 경로만으로 칸을 세운다.
    void getProjectRegistry().then((entries) => {
      if (cancelled) return;
      setRegistry(entries.filter((entry) => entry.active && entry.exists).map((entry) => ({ path: entry.path, name: entry.name, listed: true })));
      setRegistryFailed(false);
    }).catch(() => { if (!cancelled) setRegistryFailed(true); });
    return () => { cancelled = true; };
  }, [active]);

  const clearResult = () => { resultRevision.current += 1; setResult(null); };
  const update = (token: string, action: () => Promise<IndexSnapshot>) => {
    revision.current += 1;
    clearResult();
    void run(token, async () => {
      const next = await action();
      if (mounted.current) setSnapshot(next);
    });
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    update("add", async () => {
      const next = await addIndexSource({ name, path });
      if (mounted.current) { setName(""); setPath(""); }
      return next;
    });
  };
  const search = (event: FormEvent) => {
    event.preventDefault();
    setResult(null);
    const current = ++resultRevision.current;
    void run("search", async () => {
      const next = await searchIndex({ query, ...(sourceId ? { sourceId } : {}), ...(previewProject ? { project: previewProject } : {}), limit: 8 });
      if (mounted.current && current === resultRevision.current) setResult(next);
    });
  };
  const toggleOpen = (id: string) => setOpenScope((current) => {
    const next = { ...current };
    if (next[id]) delete next[id]; else next[id] = true;
    return next;
  });
  const saveScope = (source: IndexSource, projects: string[] | null) => {
    // 전체 적용을 풀면 보이는 프로젝트를 모두 저장한다. 상한을 넘으면 백엔드가 거절하므로 미리 알린다.
    if (projects !== null && projects.length > MAX_SCOPE_PROJECTS) {
      setError(text(`적용 프로젝트는 ${MAX_SCOPE_PROJECTS}개까지 고를 수 있습니다. 전체 적용을 쓰거나, 프로젝트 → 설정의 프로젝트 활성여부에서 쓰지 않는 프로젝트를 제외해 주세요.`, `You can choose up to ${MAX_SCOPE_PROJECTS} projects. Use All projects, or exclude unused projects under Projects → Settings → Project activation.`));
      return;
    }
    update(`scope:${source.id}`, () => setIndexSourceProjects(source.id, projects));
  };
  const listedPaths = registry.map((project) => project.path);
  // 전체 적용을 끄면 지금 보이는 프로젝트를 모두 고른 채로 둔다. 화면은 그대로이고, 이후
  // 새로 생기는 프로젝트만 자동으로 들어오지 않는다. 거기서 필요 없는 칸을 끈다.
  const toggleAll = (source: IndexSource, all: boolean) => saveScope(source, all ? null : listedPaths);
  const toggleProject = (source: IndexSource, project: string) => {
    const next = toggledIndexScope(source.projects, listedPaths, project);
    if (next !== null) saveScope(source, next);
  };
  const saveProjects = (mode: IndexProjectMode, projects: string[]) => update("projects", () => setIndexProjects(mode, projects));
  const sources = snapshot?.sources ?? [];
  // 프로젝트 적용으로 생긴 폴더는 적용 프로젝트 목록에서 다룬다. 여기에는 직접 등록한 폴더만 둔다.
  const manualSources = sources.filter((source) => source.projectPath === null);
  const enabled = sources.filter((source) => source.agentEnabled);
  const previewOptions = projectOptions(registry, []);
  const scopeLabel = (source: IndexSource) => source.projects === null
    ? text("모든 프로젝트", "All projects")
    : source.projects.map((project) => registry.find((option) => samePath(option.path, project))?.name ?? baseName(project)).sort((a, b) => a.localeCompare(b)).join(", ");

  return (
    <section className="settings-card index-addon" data-ui-anchor="addons.index-content" aria-busy={busy !== null}>
      <header>
        <div><span>{text("애드온", "Add-ons")}</span><h2>{text("인덱스", "Index")}</h2></div>
        <p>{text("프로젝트 폴더와 직접 추가한 폴더를 색인해 필요한 본문만 에이전트에 제공합니다. 적용할 프로젝트를 켜면 그 폴더는 자동으로 등록·색인하고, 그 밖의 폴더는 경로로 직접 추가할 수 있습니다.", "Index project folders and folders you add, and give agents only the relevant text. Turning on a project adds and indexes its folder automatically; any other folder can be added by path.")}</p>
      </header>
      <div className="settings-card-sections">
        <section className="settings-subsection">
          <header><div>
            <strong>{text("사용 설정", "Usage")}</strong>
            <small>{text("원본 파일은 읽기 전용이며 색인은 이 기기의 앱 데이터에 저장합니다. 갱신할 때 변경된 파일을 반영하며 AI 호출 비용은 없습니다.", "Source files are read only. Indexes are stored in this device’s app data. Refresh updates changed files without AI calls.")}</small>
            <small>{text("숨김·민감 경로, 의존성·빌드 폴더, 바이너리는 제외합니다. 텍스트·소스 파일만 지원하며 PDF·이미지·외부 DB는 포함하지 않습니다.", "Hidden and sensitive paths, dependencies, build folders and binaries are excluded. Supports text and source files; PDF, images and external databases are not included.")}</small>
          </div></header>
          <div className="index-addon-body">
            {error ? <ErrorBanner message={error} /> : null}
            <div className="index-addon-toggles">
              <label className="index-addon-check"><input type="checkbox" checked={snapshot?.enabled ?? false} disabled={busy !== null || snapshot === null} onChange={() => update("settings", () => setIndexSettings(!snapshot?.enabled, snapshot?.autoRefresh ?? false))} />{text("인덱스 사용", "Enable index")}</label>
              <label className="index-addon-check"><input type="checkbox" checked={snapshot?.autoRefresh ?? false} disabled={busy !== null || !snapshot?.enabled} onChange={() => update("settings", () => setIndexSettings(true, !snapshot?.autoRefresh))} />{text("자동 갱신 (1분마다)", "Auto refresh (every minute)")}</label>
            </div>
            <p>{text("자동 갱신은 에이전트 사용이 켜진 폴더에 적용됩니다. 폴더별 갱신 버튼은 언제든 직접 사용할 수 있습니다.", "Auto refresh applies to folders with agent use enabled. You can manually refresh any folder at any time.")}</p>
            {!snapshot?.enabled && snapshot !== null ? <p role="status">{text("인덱스 사용이 꺼져 있습니다. 저장된 색인은 유지하며 에이전트 검색과 자동 갱신을 중지합니다.", "Index is off. Stored indexes are kept; agent search and auto refresh are stopped.")}</p> : null}
          </div>
        </section>

        <IndexProjectsSection snapshot={snapshot} projects={registry} registryFailed={registryFailed} busy={busy !== null} onSave={saveProjects} onRefresh={(source) => update(source.id, () => refreshIndexSource(source.id))} />

        <section className="settings-subsection">
          <header><div>
            <strong>{text("색인할 폴더 직접 추가", "Add a folder to index")}</strong>
            <small>{text("적용 프로젝트와 별도로, 색인할 폴더(문서 모음·다른 저장소 등)를 절대 경로로 직접 추가합니다. 새 폴더는 에이전트 사용이 꺼진 채, 모든 프로젝트에 적용되는 상태로 등록됩니다.", "Separately from applied projects, add any folder to index (document collections, other repositories, etc.) by its absolute path. New folders start with agent use off and apply to all projects.")}</small>
          </div></header>
          <form className="index-addon-body index-addon-form" onSubmit={add}>
            <label><span>{text("이름", "Name")}</span><input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label><span>{text("폴더 절대 경로", "Absolute folder path")}</span><input required value={path} onChange={(event) => setPath(event.target.value)} spellCheck={false} /></label>
            <button className="button" disabled={busy !== null || !name.trim() || !path.trim()}><Plus size={15} />{text("폴더 등록", "Add folder")}</button>
          </form>
        </section>

        <section className="settings-subsection">
          <header><div>
            <strong>{text("직접 등록한 폴더", "Folders you added")}</strong>
            <small>{text("직접 등록한 폴더도 기본은 모든 프로젝트에 적용되고 새 프로젝트도 자동으로 들어갑니다. 프로젝트를 하나 끄면 전체 적용이 풀리고, 켜 둔 프로젝트(하위 폴더·워크트리 포함)에서 실행한 대화의 인덱스 검색에만 이 폴더가 들어갑니다. 작업 경로를 알 수 없는 실행(Antigravity 등)은 모든 프로젝트에 적용된 폴더만 봅니다. 검색 대상을 고르는 설정이며 폴더 접근을 막지는 않습니다.", "Folders you add also apply to all projects by default, including projects added later. Turning off a project clears that, and the folder is then included only in index searches from chats running in the projects left on (including subfolders and worktrees). Runs whose working path is unknown (such as Antigravity) only see folders applied to all projects. This picks search targets; it does not block access to the folder.")}</small>
          </div></header>
          <div className="index-addon-body">
            {snapshot === null ? <p role="status">{text("불러오는 중…", "Loading…")}</p> : manualSources.length === 0 ? <p>{text("직접 추가한 폴더가 없습니다. 위에서 경로로 추가하거나, 프로젝트 폴더는 적용 프로젝트에서 켜 주세요.", "No folders added yet. Add one by path above; project folders are handled by Applied projects.")}</p> : (
              <ul className="index-addon-sources">
                {manualSources.map((source) => {
                  const all = source.projects === null;
                  const chosen = source.projects ?? listedPaths;
                  const options = projectOptions(registry, source.projects ?? []);
                  const open = openScope[source.id] === true;
                  const listId = `index-addon-projects-${source.id}`;
                  return <li key={source.id}>
                    <div className="index-addon-source-title"><strong>{source.name}</strong><code>{source.path}</code></div>
                    <small>{source.indexedAt === null ? text("색인 전", "Not indexed") : <>{text("최근 갱신", "Last refreshed")}: {new Date(source.indexedAt).toLocaleString()}</>} · {text("파일", "Files")} {source.files} · {text("조각", "Chunks")} {source.chunks} · {text("제외 파일", "Excluded files")} {source.excluded} · {text("적용", "Applies to")}: {scopeLabel(source)}</small>
                    {source.truncated ? <p role="status">{text("색인 상한에 도달해 일부 파일이 빠졌습니다. 더 작은 하위 폴더를 등록해 주세요.", "The indexing limit was reached. Register a smaller subfolder to include all files.")}</p> : null}
                    <div className="index-addon-source-controls">
                      <label className="index-addon-check"><input type="checkbox" checked={source.agentEnabled} disabled={busy !== null} onChange={() => {
                        if (sourceId === source.id) setSourceId("");
                        update(source.id, () => setIndexSourceEnabled(source.id, !source.agentEnabled));
                      }} />{text("에이전트 사용", "Agent use")}</label>
                      <span className="index-addon-source-actions">
                        <button type="button" className="button compact" disabled={busy !== null} onClick={() => update(source.id, () => refreshIndexSource(source.id))}><RefreshCw size={14} />{busy === source.id ? text("처리 중…", "Working…") : text("인덱스 갱신", "Refresh index")}</button>
                        <button type="button" className="button compact" disabled={busy !== null} onClick={() => {
                          void (async () => {
                            if (!await confirm({ title: text("인덱스 폴더 제거", "Remove index folder"), message: text("등록과 저장된 인덱스를 제거합니다. 원본 파일은 유지합니다.", "Remove the registration and stored index. Source files are kept."), items: [source.path], confirmLabel: text("제거", "Remove") })) return;
                            if (sourceId === source.id) setSourceId("");
                            update(source.id, () => removeIndexSource(source.id));
                          })();
                        }}><Trash2 size={14} />{text("제거", "Remove")}</button>
                      </span>
                    </div>
                    <div className="index-addon-scope">
                      <button className="project-registry-collapse" type="button" aria-expanded={open} aria-controls={listId} onClick={() => toggleOpen(source.id)}>
                        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                        <strong>{text("적용 프로젝트", "Applies to")}</strong>
                        <small>{all ? text("전체 적용 · 새 프로젝트 자동 포함", "All projects · new projects included") : text(`${chosen.length}개 선택`, `${chosen.length} selected`)}</small>
                      </button>
                      {open ? <ul className="project-registry-list" id={listId}>
                        <li className="project-registry-row index-addon-scope-all">
                          <div className="project-registry-main">
                            <div className="project-registry-name"><strong>{text("전체 적용", "All projects")}</strong></div>
                            <span className="index-addon-scope-note">{text("새로 생기는 프로젝트도 자동으로 포함합니다. 프로젝트를 하나 끄면 풀립니다.", "Projects added later are included automatically. Turning off any project clears this.")}</span>
                          </div>
                          <AppToggle checked={all} disabled={busy !== null || (all && listedPaths.length === 0)} label={text(`${source.name} 전체 적용`, `${source.name} all projects`)} onChange={(checked) => toggleAll(source, checked)} />
                        </li>
                        {options.length === 0 ? <li className="project-registry-row"><span className="index-addon-scope-note" role="status">{registryFailed ? text("프로젝트 목록을 불러오지 못했습니다. 화면을 다시 열어 주세요.", "Could not load the project list. Reopen this view.") : text("고를 수 있는 프로젝트가 없습니다. 프로젝트 화면에 활성 프로젝트가 생기면 여기에 나타납니다.", "No projects to choose from. Active projects appear here once they show up in the Projects view.")}</span></li> : options.map((project) => {
                          const checked = chosen.some((item) => samePath(item, project.path));
                          // 마지막 하나는 끌 수 없다(빈 범위는 저장하지 않는다). 전체로 되돌리려면 전체 적용을 켠다.
                          const locked = checked && chosen.length === 1;
                          const lockReason = all ? text("하나뿐인 프로젝트라 끌 수 없습니다", "The only project cannot be turned off") : text("마지막 프로젝트는 끌 수 없습니다. 전체 적용을 켜 주세요", "The last project cannot be turned off. Turn on All projects instead");
                          return <li key={project.path} className={`project-registry-row${checked ? "" : " inactive"}`} title={locked ? lockReason : undefined}>
                            <div className="project-registry-main">
                              <div className="project-registry-name"><strong>{project.name}</strong>{project.listed ? null : <span className="skill-sync-pill unmanaged">{text("목록에 없음", "Not listed")}</span>}</div>
                              <span className="project-registry-path" title={project.path}>{project.path}</span>
                            </div>
                            <AppToggle checked={checked} disabled={busy !== null || locked} label={text(`${source.name} · ${project.name} 적용`, `${source.name} · apply to ${project.name}`) + (locked ? ` (${lockReason})` : "")} onChange={() => toggleProject(source, project.path)} />
                          </li>;
                        })}
                      </ul> : null}
                    </div>
                  </li>;
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="settings-subsection" aria-label={text("인덱스 검색", "Index search")}>
          <header><div>
            <strong>{text("검색 미리보기", "Search preview")}</strong>
            <small>{text("에이전트 사용을 켠 폴더에서 검색합니다. 기준 프로젝트를 고르면 그 프로젝트의 대화가 보는 폴더만 찾습니다. 일반 채팅의 MCP 연결은 켠 뒤 새 채팅부터 적용됩니다.", "Search folders with agent use enabled. Pick a project to search only the folders its chats see. MCP connections for standard chats apply to new chats after enabling.")}</small>
          </div></header>
          <div className="index-addon-body">
            <form className="index-addon-form" onSubmit={search}>
              <label><span>{text("검색 대상", "Search scope")}</span><select value={sourceId} onChange={(event) => { setSourceId(event.target.value); clearResult(); }}>
                <option value="">{text("허용된 모든 폴더", "All enabled folders")}</option>
                {enabled.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
              </select></label>
              <label><span>{text("기준 프로젝트", "As project")}</span><select value={previewProject} onChange={(event) => { setPreviewProject(event.target.value); clearResult(); }}>
                <option value="">{text("범위 무시 (전체)", "Ignore scope (all)")}</option>
                {previewOptions.map((project) => <option key={project.path} value={project.path}>{project.name}</option>)}
              </select></label>
              <label><span>{text("검색어", "Search query")}</span><input value={query} maxLength={256} onChange={(event) => { setQuery(event.target.value); clearResult(); }} /></label>
              <button className="button" disabled={busy !== null || !query.trim() || enabled.length === 0 || !snapshot?.enabled}><Search size={15} />{text("검색", "Search")}</button>
            </form>
            {result ? <div className="index-addon-results" aria-live="polite">
              {result.staleFiles.length > 0 ? <p role="status">{text("원본이 변경된 파일은 결과에서 제외했습니다. 해당 폴더의 인덱스를 갱신해 주세요.", "Changed source files were excluded. Refresh the corresponding folder index.")}</p> : null}
              {result.truncated ? <p>{text("결과 상한에 도달했습니다. 검색 범위를 좁혀 주세요.", "Result limit reached. Narrow your search.")}</p> : null}
              {result.hits.length === 0 ? <p>{text("인덱스 검색 결과가 없습니다.", "No index results found.")}</p> : result.hits.map((hit) => <article className="index-addon-hit" key={`${hit.sourceId}/${hit.relativePath}:${hit.startLine}`}>
                <strong>{hit.sourceName}</strong><code>{hit.relativePath}:{hit.startLine}–{hit.endLine}</code><pre>{hit.excerpt}</pre>
              </article>)}
            </div> : null}
          </div>
        </section>
      </div>
      {confirmDialog}
    </section>
  );
}
