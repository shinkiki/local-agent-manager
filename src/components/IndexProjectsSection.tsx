import { RefreshCw } from "lucide-react";
import type { IndexProjectMode, IndexSnapshot, IndexSource } from "../lib/ipcIndex";
import { useI18n } from "../lib/i18n";
import { AppToggle } from "./Shared";

export interface IndexProjectOption { path: string; name: string }

/** 백엔드가 저장할 때 붙이는 Windows 확장 경로 접두와 끝 구분자를 걷어 등록부 경로와 견준다. */
export const indexPathKey = (path: string) => path.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
export const sameIndexPath = (a: string, b: string) => indexPathKey(a) === indexPathKey(b);

/**
 * 프로젝트 한 칸을 켜고 끈 뒤의 적용 설정. 전체 적용에서 하나를 끄면 지금 목록의 나머지를
 * 고른 선택 적용이 된다. 선택 적용은 비어 있어도 된다(아무 프로젝트도 쓰지 않음).
 */
export function toggledIndexProjects(mode: IndexProjectMode, selected: string[], listed: string[], project: string): string[] {
  const chosen = mode === "all" ? listed : selected;
  return chosen.some((item) => sameIndexPath(item, project))
    ? chosen.filter((item) => !sameIndexPath(item, project))
    : [...chosen, project];
}

/**
 * 인덱스 애드온의 적용 프로젝트 목록. 프로젝트 활성여부 카드와 같은 줄(이름·경로·스위치)로 그리고,
 * 켠 프로젝트의 폴더는 백엔드가 인덱스에 자동 등록·색인한다. 기본은 전체 적용(새 프로젝트 포함).
 */
export function IndexProjectsSection({ snapshot, projects, registryFailed, busy, onSave, onRefresh }: {
  snapshot: IndexSnapshot | null;
  /** 활성이면서 폴더가 있는 프로젝트. */
  projects: IndexProjectOption[];
  registryFailed: boolean;
  busy: boolean;
  onSave: (mode: IndexProjectMode, projects: string[]) => void;
  onRefresh: (source: IndexSource) => void;
}) {
  const { text } = useI18n();
  const mode = snapshot?.projectMode ?? "all";
  const all = mode === "all";
  const selected = snapshot?.selectedProjects ?? [];
  const sources = snapshot?.sources ?? [];
  const listed = projects.map((project) => project.path);
  const appliedCount = all ? projects.length : projects.filter((project) => selected.some((item) => sameIndexPath(item, project.path))).length;
  const status = (project: IndexProjectOption, checked: boolean): { tone: string; label: string; source?: IndexSource } => {
    const issue = snapshot?.projectIssues.find((item) => sameIndexPath(item.path, project.path));
    if (checked && issue) return { tone: "warn", label: text(`등록하지 못함: ${issue.reason}`, `Not added: ${issue.reason}`) };
    const source = sources.find((item) => sameIndexPath(item.path, project.path));
    if (!checked) return { tone: "", label: text("적용 안 함", "Not applied") };
    // 다른 적용 프로젝트 안에 든 프로젝트(워크트리·하위 폴더)는 바깥 폴더가 덮는다. 직접 등록 폴더는
    // 에이전트 사용이 켜진 채 모든 프로젝트에 적용될 때만 덮는다(백엔드 sync_index_projects와 같은 규칙).
    const outer = source ? undefined : sources.find((item) => (item.projectPath !== null || (item.agentEnabled && item.projects === null)) && indexPathKey(project.path).startsWith(`${indexPathKey(item.path)}/`));
    if (outer) return { tone: "", label: text(`바깥 폴더(${outer.name})로 적용 중`, `Applied through the enclosing folder (${outer.name})`) };
    if (!source) return { tone: "", label: snapshot?.enabled ? text("등록 대기 중 (1분 안에 등록됩니다)", "Waiting to be added (within a minute)") : text("인덱스 사용을 켜면 등록됩니다", "Added once the index is enabled") };
    // 같은 경로를 직접 등록해 둔 폴더는 그 폴더 설정(에이전트 사용·적용 범위)을 따른다.
    if (source.projectPath === null && !source.agentEnabled) return { tone: "warn", label: text("직접 등록한 같은 폴더가 있어 자동 등록하지 않았습니다. 아래 직접 등록한 폴더에서 에이전트 사용을 켜 주세요", "A folder you added has the same path, so it was not added automatically. Turn on agent use for it under Folders you added") };
    const manual = source.projectPath === null ? text(" · 직접 등록한 폴더로 적용 중", " · applied through a folder you added") : "";
    if (source.indexedAt === null && source.lastError) return { tone: "warn", label: text(`색인 실패(30분 뒤 다시 시도): ${source.lastError}`, `Indexing failed (retrying in 30 minutes): ${source.lastError}`), source };
    if (source.indexedAt === null) return { tone: "", label: text("색인 대기 중 (1분 안에 시작합니다)", "Waiting to index (starts within a minute)") + manual, source };
    return {
      tone: "",
      label: `${text("파일", "Files")} ${source.files} · ${text("조각", "Chunks")} ${source.chunks} · ${text("최근 갱신", "Last refreshed")} ${new Date(source.indexedAt).toLocaleString()}${source.truncated ? text(" · 상한에 닿아 일부만 색인", " · limit reached, partly indexed") : ""}${manual}`,
      source,
    };
  };

  return (
    <section className="settings-subsection index-addon-apply" aria-label={text("적용 프로젝트", "Applied projects")}>
      <header><div>
        <strong>{text("적용 프로젝트", "Applied projects")}</strong>
        <small>{text("켠 프로젝트의 폴더를 인덱스에 자동으로 등록하고 색인합니다. 폴더 경로를 따로 넣지 않아도 됩니다. 기본은 전체 적용이라 새로 생기는 프로젝트도 자동으로 들어가고, 프로젝트를 하나 끄면 전체 적용이 풀립니다. 각 프로젝트 폴더는 그 프로젝트(하위 폴더·워크트리 포함)에서 실행한 대화의 인덱스 검색에 쓰이고, 작업 경로를 알 수 없는 실행(Antigravity 등)은 보지 않습니다. 자동 갱신은 프로젝트 폴더를 10분마다 다시 훑습니다.", "Folders of the projects you turn on are added to the index and indexed automatically, with no paths to enter. All projects is the default, so new projects are included too; turning off a project clears it. Each project folder is used by index searches from chats running in that project (including subfolders and worktrees); runs whose working path is unknown (such as Antigravity) do not see it. Auto refresh rescans project folders every 10 minutes.")}</small>
      </div></header>
      <div className="index-addon-body">
        <ul className="project-registry-list index-addon-project-rows">
          <li className="project-registry-row index-addon-scope-all">
            <div className="project-registry-main">
              <div className="project-registry-name"><strong>{text("전체 적용", "All projects")}</strong><span className="index-addon-count">{text(`${appliedCount}/${projects.length}개 적용`, `${appliedCount}/${projects.length} applied`)}</span></div>
              <span className="index-addon-scope-note">{text("새로 생기는 프로젝트도 자동으로 포함합니다. 프로젝트를 하나 끄면 풀립니다.", "Projects added later are included automatically. Turning off any project clears this.")}</span>
            </div>
            <AppToggle checked={all} disabled={busy || snapshot === null || (all && listed.length === 0)} label={text("인덱스 전체 적용", "Index all projects")} onChange={(checked) => onSave(checked ? "all" : "selected", checked ? [] : listed)} />
          </li>
          {projects.length === 0 ? <li className="project-registry-row"><span className="index-addon-scope-note" role="status">{registryFailed ? text("프로젝트 목록을 불러오지 못했습니다. 화면을 다시 열어 주세요.", "Could not load the project list. Reopen this view.") : text("활성 프로젝트가 없습니다. 프로젝트 화면에 활성 프로젝트가 생기면 여기에 나타납니다.", "No active projects. Active projects appear here once they show up in the Projects view.")}</span></li> : projects.map((project) => {
            const checked = all || selected.some((item) => sameIndexPath(item, project.path));
            const { tone, label, source } = status(project, checked);
            return <li key={project.path} className={`project-registry-row${checked ? "" : " inactive"}`}>
              <div className="project-registry-main">
                <div className="project-registry-name"><strong>{project.name}</strong></div>
                <span className="project-registry-path" title={project.path}>{project.path}</span>
                <span className={`index-addon-scope-note${tone ? ` ${tone}` : ""}`}>{label}</span>
              </div>
              <span className="index-addon-row-actions">
                {source && source.indexedAt !== null ? <button type="button" className="button compact" disabled={busy} title={text("인덱스 갱신", "Refresh index")} aria-label={text(`${project.name} 인덱스 갱신`, `Refresh ${project.name} index`)} onClick={() => onRefresh(source)}><RefreshCw size={14} /></button> : null}
                <AppToggle checked={checked} disabled={busy || snapshot === null} label={text(`${project.name} 인덱스 적용`, `Index ${project.name}`)} onChange={() => onSave("selected", toggledIndexProjects(mode, selected, listed, project.path))} />
              </span>
            </li>;
          })}
        </ul>
        {snapshot !== null && !snapshot.enabled ? <p role="status">{text("인덱스 사용이 꺼져 있어 적용 설정만 저장됩니다. 켜면 그때 폴더를 등록합니다.", "The index is off, so only the selection is saved. Folders are added once it is turned on.")}</p> : null}
      </div>
    </section>
  );
}
