import { Blocks, LoaderCircle, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getClaudePluginBranchRules, getClaudeSettingsStates, getProjectRegistry, getWebAccessStatus, removeClaudePluginBranchRule, setClaudePluginBranchRule, setClaudePluginEnabled, type WebAccessStatus } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { branchMatches } from "../lib/branchPattern";
import type { ClaudePluginBranchProject, ClaudePluginBranchRule, ClaudePluginBranchRulesSnapshot, ClaudeSettingsSnapshot, ProjectRegistryEntry } from "../types";
import { AppToggle, BrandMark, ErrorBanner } from "./Shared";
import { errorText } from "../lib/errorText";
import { displayPath } from "../lib/displayPath";

const CLAUDE_PLUGIN_SCOPE_KEY = "agent-manager.claude-plugin-scope.v1";

type PluginScope = "global" | "project" | "branch";

const PLUGIN_SCOPES: PluginScope[] = ["global", "project", "branch"];

function loadPluginScopes(): Record<string, PluginScope> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CLAUDE_PLUGIN_SCOPE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => PLUGIN_SCOPES.includes(value as PluginScope))) as Record<string, PluginScope>;
  } catch {
    return {};
  }
}

/** 아직 저장하지 않은 브랜치 규칙 입력. 키는 `<플러그인 id>:<프로젝트 경로>`다. */
type BranchDraft = { branch: string; enabled: boolean };

const EMPTY_DRAFT: BranchDraft = { branch: "", enabled: true };

/**
 * 브랜치별 사용 구획이 카드로 되돌려 보내는 편집 동작 넷. 플러그인 행 → 브랜치 구획 →
 * 프로젝트 행 세 단계가 같은 네 개를 각자 다시 선언하고 그대로 아래로 넘기고 있었다.
 * 어느 것도 중간에서 가로채거나 바꾸지 않으므로 묶음 하나로 내려보내, 동작이 늘거나
 * 서명이 바뀔 때 고칠 자리를 여기 하나로 둔다.
 */
interface BranchRuleHandlers {
  onDraftChange: (projectPath: string, draft: BranchDraft) => void;
  onAddBranchRule: (projectPath: string, branch: string, enabled: boolean) => void;
  onToggleBranchRule: (projectPath: string, branch: string, enabled: boolean) => void;
  onRemoveBranchRule: (projectPath: string, branch: string) => void;
}

/**
 * 진행 중 표시와 브랜치 초안 보관에 쓰는 키 문법. 카드·프로젝트 구획·브랜치 행이 각자
 * `${pluginId}:${projectPath}`와 거기에 브랜치를 덧붙인 모양을 손으로 적고 있었고, 아래
 * 화면이 만든 키를 다시 위로 돌려주어야 카드가 같은 키로 busy를 걸 수 있었다. 문법을 여기
 * 둘로 모아, 키는 카드가 혼자 만들고 화면은 무엇을 눌렀는지만 알린다.
 */
const pluginProjectKey = (pluginId: string, projectPath: string): string => `${pluginId}:${projectPath}`;
const branchRuleKey = (pluginId: string, projectPath: string, branch: string): string =>
  `${pluginProjectKey(pluginId, projectPath)}:${branch}`;

/**
 * 카드가 백엔드에서 읽어 오는 값 다섯과 "한 번에 한 동작" 껍데기. 이웃한 두 플러그인 카드
 * (`useExternalPluginsData`·`useSshKeysData`)는 이미 같은 자리를 훅으로 갈라 두었는데 이
 * 카드만 본문에 펼쳐 두고 있어, 화면을 읽으려면 적재 깃발·busy 토큰·오류 배너 배선을 먼저
 * 지나쳐야 했다.
 *
 * 옮긴 것은 자리뿐이고 규칙은 그대로다 — 탭을 벗어나면 적재 표시를 풀어 다음 진입에 다시
 * 읽고, 브랜치 규칙은 저장소가 달라 목록을 세운 뒤 따로 읽으며, 작업 셋은 앞선 작업이 도는
 * 동안 새 작업을 받지 않고 성공했을 때 어느 상태에 결과를 넣을지만 서로 다르다.
 *
 * 플러그인별 적용 범위(`pluginScopes`)와 브랜치 초안은 백엔드를 거치지 않는 화면 상태라
 * 여기로 들이지 않는다 — 부르는 쪽에 남겨 둔다.
 */
function useClaudePluginsData(active: boolean) {
  const [snapshot, setSnapshot] = useState<ClaudeSettingsSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectRegistryEntry[]>([]);
  const [projectSnapshots, setProjectSnapshots] = useState<Record<string, ClaudeSettingsSnapshot>>({});
  const [branchRules, setBranchRules] = useState<ClaudePluginBranchRulesSnapshot | null>(null);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!active) { loadedRef.current = false; return; }
    if (loadedRef.current) return;
    loadedRef.current = true;
    void (async () => {
      try {
        const [global, entries, writable] = await Promise.all([
          getClaudeSettingsStates(null),
          getProjectRegistry(),
          getWebAccessStatus(),
        ]);
        const activeProjects = entries.filter((entry) => entry.active && entry.exists);
        setSnapshot(global);
        setProjects(activeProjects);
        setAccess(writable);
        // 브랜치 규칙은 플러그인 목록과 저장소가 다르다. 여기서 실패해도 카드가 로딩에
        // 머무르지 않도록 목록을 먼저 세우고 따로 읽는다.
        void getClaudePluginBranchRules().then(setBranchRules).catch((cause) => setError(errorText(cause)));
        const projectResults = await Promise.all(activeProjects.map(async (project) => [project.path, await getClaudeSettingsStates(project.path)] as const));
        setProjectSnapshots(Object.fromEntries(projectResults));
        setError(null);
      } catch (cause) {
        setError(errorText(cause));
      }
    })();
  }, [active]);

  const runUpdate = async <T,>(key: string, action: () => Promise<T>, apply: (next: T) => void) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      apply(await action());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const run = (key: string, action: () => Promise<ClaudeSettingsSnapshot>) =>
    runUpdate(key, action, setSnapshot);

  /** 브랜치 규칙 저장·삭제는 플러그인 사용 설정과 저장소가 달라 자기 상태만 갱신한다. */
  const runBranch = (key: string, action: () => Promise<ClaudePluginBranchRulesSnapshot>) =>
    runUpdate(key, action, setBranchRules);

  const updateProjectSnapshot = (projectPath: string, next: ClaudeSettingsSnapshot) => {
    setProjectSnapshots((current) => ({ ...current, [projectPath]: next }));
  };

  return { snapshot, projects, projectSnapshots, branchRules, access, busy, error, run, runBranch, updateProjectSnapshot };
}

/**
 * Claude Code 자체 플러그인 설치본과 `enabledPlugins`를 관리한다. Agent Manager가
 * 연결하는 외부 MCP 플러그인 카드와 저장소·수명주기가 다르므로 별도 카드로 둔다.
 */
export function ClaudePluginsCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { snapshot, projects, projectSnapshots, branchRules, access, busy, error, run, runBranch, updateProjectSnapshot } = useClaudePluginsData(active);
  const [pluginScopes, setPluginScopes] = useState<Record<string, PluginScope>>(loadPluginScopes);
  const [branchDrafts, setBranchDrafts] = useState<Record<string, BranchDraft>>({});
  const canWrite = access?.writable === true;

  const setPluginScope = (pluginId: string, scope: PluginScope) => {
    setPluginScopes((current) => {
      const next = { ...current, [pluginId]: scope };
      try { window.localStorage.setItem(CLAUDE_PLUGIN_SCOPE_KEY, JSON.stringify(next)); } catch { /* 저장소가 막혀도 현재 화면에는 적용한다. */ }
      return next;
    });
  };

  /**
   * 브랜치 규칙 편집 넷을 플러그인 하나 몫으로 묶는다. 목록을 그리는 JSX 한가운데 펼쳐 두면
   * 어느 동작이 어느 키로 busy를 거는지가 마크업에 가려지고, 규칙이 하나 늘 때마다 고칠
   * 자리가 화면 안으로 파고든다. 키 문법은 그대로 카드가 만들고, 화면은 무엇을 눌렀는지만
   * 알린다.
   */
  const branchRuleHandlersFor = (pluginId: string): BranchRuleHandlers => ({
    onDraftChange: (projectPath, draft) => {
      setBranchDrafts((current) => ({ ...current, [pluginProjectKey(pluginId, projectPath)]: draft }));
    },
    onAddBranchRule: (projectPath, branch, enabled) => {
      const draftKey = pluginProjectKey(pluginId, projectPath);
      void runBranch(draftKey, async () => {
        const next = await setClaudePluginBranchRule({ projectPath, branch, pluginId, enabled });
        setBranchDrafts((current) => ({ ...current, [draftKey]: EMPTY_DRAFT }));
        return next;
      });
    },
    onToggleBranchRule: (projectPath, branch, enabled) => {
      void runBranch(branchRuleKey(pluginId, projectPath, branch), () => setClaudePluginBranchRule({ projectPath, branch, pluginId, enabled }));
    },
    onRemoveBranchRule: (projectPath, branch) => {
      void runBranch(branchRuleKey(pluginId, projectPath, branch), () => removeClaudePluginBranchRule({ projectPath, branch, pluginId }));
    },
  });

  return (
    <section className="settings-card claude-plugins-card" data-ui-anchor="addons.claude-plugins-content">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><BrandMark name="claude" size={18} /></i>
          <div><span>CLAUDE CODE</span><h2>{text("Claude Code 플러그인", "Claude Code plugins")}</h2></div>
        </div>
        <p>{text(
          "Claude Code에 설치된 플러그인을 켜거나 끕니다. 플러그인을 끄면 그 플러그인에 포함된 스킬도 모두 꺼집니다.",
          "Enable or disable plugins installed in Claude Code. Disabling a plugin also disables every skill it contains.",
        )}</p>
      </header>
      <div className="claude-plugin-scopebar">
        <div>
          <strong>{text("전역·프로젝트·브랜치별 적용", "Global, per-project and per-branch settings")}</strong>
          <small>{text("전역 토글은 사용자 설정에 저장하고, 프로젝트 목록에서는 여러 프로젝트를 한 번에 관리합니다. 브랜치별 규칙은 Agent Manager가 들고 있다가 실행을 띄울 때 적용합니다.", "The global toggle is saved to user settings; manage multiple projects from each expanded list. Branch rules are kept by Agent Manager and applied when it starts a run.")}</small>
        </div>
      </div>
      {error && <ErrorBanner message={error} />}
      {snapshot === null
        ? <div className="plugin-loading-state"><LoaderCircle size={16} className="spin" /><span>{text("Claude Code 플러그인을 확인하는 중…", "Checking Claude Code plugins…")}</span></div>
        : snapshot.plugins.length === 0
          ? <div className="plugin-empty-state"><i><Blocks size={25} /></i><div><strong>{text("설치된 플러그인이 없습니다", "No plugins installed")}</strong><small>{text("Claude Code 플러그인 설치 레지스트리에서 확인된 항목이 없습니다.", "No entries were found in the Claude Code plugin registry.")}</small></div></div>
          : <div className="plugin-list">
            {snapshot.plugins.map((plugin) => (
              <ClaudePluginRow
                key={plugin.pluginId}
                plugin={plugin}
                scope={pluginScopes[plugin.pluginId] ?? "global"}
                busy={busy}
                canWrite={canWrite}
                projects={projects}
                projectSnapshots={projectSnapshots}
                branchRules={branchRules}
                branchDrafts={branchDrafts}
                onScopeChange={(scope) => setPluginScope(plugin.pluginId, scope)}
                onToggleUserEnabled={(enabled) => {
                  void run(plugin.pluginId, () => setClaudePluginEnabled({ pluginId: plugin.pluginId, scope: "user", projectPath: null, enabled }));
                }}
                onToggleProject={(projectPath, enabled) => {
                  void run(pluginProjectKey(plugin.pluginId, projectPath), async () => {
                    const next = await setClaudePluginEnabled({ pluginId: plugin.pluginId, scope: "project", projectPath, enabled });
                    updateProjectSnapshot(projectPath, next);
                    return snapshot;
                  });
                }}
                branchHandlers={branchRuleHandlersFor(plugin.pluginId)}
              />
            ))}
          </div>}
      <p className="claude-plugin-reload-note">{text(
        "실행 중인 Claude Code 세션에는 /reload-plugins 또는 재시작 후 반영됩니다. 브랜치 규칙은 다음 실행부터 적용되며, 세션 도중 브랜치를 바꿔도 그 세션은 달라지지 않습니다.",
        "Running Claude Code sessions pick up changes after /reload-plugins or a restart. Branch rules apply from the next run; switching branches mid-session does not change that session.",
      )}</p>
    </section>
  );
}

/** 개별 프로젝트의 Claude 플러그인 활성 상태 목록 섹션 */
interface ClaudePluginProjectSectionProps {
  pluginId: string;
  pluginLocked: boolean;
  projects: ProjectRegistryEntry[];
  projectSnapshots: Record<string, ClaudeSettingsSnapshot>;
  busy: string | null;
  canWrite: boolean;
  onToggleProject: (projectPath: string, enabled: boolean) => void;
}

function ClaudePluginProjectSection({
  pluginId,
  pluginLocked,
  projects,
  projectSnapshots,
  busy,
  canWrite,
  onToggleProject,
}: ClaudePluginProjectSectionProps) {
  const { text } = useI18n();
  return (
    <div className="claude-plugin-projects">
      <div className="claude-plugin-projects-header">
        <strong>{text("프로젝트별 사용", "Enabled per project")}</strong>
        <small>{text("체크한 프로젝트의 settings.local.json에 사용 여부를 저장합니다.", "Selections are saved to each project's settings.local.json.")}</small>
      </div>
      {projects.length === 0
        ? <small className="claude-plugin-project-empty">{text("활성 프로젝트가 없습니다.", "No active projects.")}</small>
        : projects.map((project) => {
          const projectPlugin = projectSnapshots[project.path]?.plugins.find((item) => item.pluginId === pluginId);
          const projectBusy = busy === pluginProjectKey(pluginId, project.path);
          return (
            <label className="claude-plugin-project-item" key={project.path}>
              <input
                type="checkbox"
                checked={projectPlugin?.effectiveEnabled ?? false}
                disabled={!canWrite || projectBusy || pluginLocked || !projectPlugin}
                onChange={(event) => onToggleProject(project.path, event.target.checked)}
              />
              <span>{displayPath(project.name)}</span>
              <code>{displayPath(project.path)}</code>
            </label>
          );
        })}
    </div>
  );
}

/** 브랜치 목록과 저장된 규칙을 함께 보여 주는 브랜치별 사용 섹션 */
interface ClaudePluginBranchSectionProps {
  pluginId: string;
  pluginLocked: boolean;
  branchRules: ClaudePluginBranchRulesSnapshot | null;
  branchDrafts: Record<string, BranchDraft>;
  projectSnapshots: Record<string, ClaudeSettingsSnapshot>;
  busy: string | null;
  canWrite: boolean;
  branchHandlers: BranchRuleHandlers;
}

function ClaudePluginBranchSection({
  pluginId,
  pluginLocked,
  branchRules,
  branchDrafts,
  projectSnapshots,
  busy,
  canWrite,
  branchHandlers,
}: ClaudePluginBranchSectionProps) {
  const { text } = useI18n();
  // 프로젝트별에서 끈 프로젝트는 기본으로 접어 둔다. 다만 "프로젝트에선 끄고 이 브랜치만
  // 켜기"도 쓸 수 있어야 하므로, 규칙이 이미 걸린 프로젝트는 접지 않고 전체 보기를 남긴다.
  const [showAll, setShowAll] = useState(false);
  const projects = branchRules?.projects ?? [];
  // 한 플러그인의 프로젝트 상태를 화면 곳곳에서 다시 찾지 않도록 렌더링용 인덱스를 한 번
  // 만든다. 규칙 배열은 원래 순서를 유지해야 같은 순서로 표시된다.
  const { enabledProjects, rulesByProject } = useMemo(() => {
    const enabled = new Set<string>();
    for (const [projectPath, snapshot] of Object.entries(projectSnapshots)) {
      if (snapshot.plugins.find((item) => item.pluginId === pluginId)?.effectiveEnabled === true) enabled.add(projectPath);
    }
    const grouped = new Map<string, ClaudePluginBranchRule[]>();
    for (const rule of branchRules?.rules ?? []) {
      if (rule.pluginId !== pluginId) continue;
      const rules = grouped.get(rule.projectPath);
      if (rules) rules.push(rule);
      else grouped.set(rule.projectPath, [rule]);
    }
    return { enabledProjects: enabled, rulesByProject: grouped };
  }, [branchRules, pluginId, projectSnapshots]);
  const visible = showAll
    ? projects
    : projects.filter((project) => enabledProjects.has(project.path) || rulesByProject.has(project.path));
  return (
    <div className="claude-plugin-projects">
      <div className="claude-plugin-projects-header">
        <strong>{text("브랜치별 사용", "Enabled per branch")}</strong>
        <small>{text(
          "설정 파일에는 브랜치 조건을 적을 자리가 없어, 규칙은 Agent Manager가 들고 있다가 Claude 실행을 띄울 때 그 브랜치의 값으로 넘깁니다. 프로젝트별 설정보다 우선합니다.",
          "Settings files cannot express a branch condition, so Agent Manager keeps these rules and passes the matching value when it starts Claude. They take precedence over the per-project setting.",
        )}</small>
        <label className="claude-branch-showall">
          <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
          <span>{text("프로젝트별에서 끈 프로젝트도 보기", "Show projects disabled per project")}</span>
        </label>
      </div>
      {projects.length === 0
        ? <small className="claude-plugin-project-empty">{text("활성 프로젝트가 없습니다.", "No active projects.")}</small>
        : visible.length === 0
          ? <small className="claude-plugin-project-empty">{text(
            "프로젝트별에서 이 플러그인을 켠 프로젝트가 없습니다. 위 체크를 켜면 모든 프로젝트가 보입니다.",
            "No project has this plugin enabled. Tick the box above to see every project.",
          )}</small>
          : visible.map((project) => (
            <ClaudePluginBranchProjectRow
              key={project.path}
              pluginId={pluginId}
              pluginLocked={pluginLocked}
              project={project}
              rules={rulesByProject.get(project.path) ?? []}
              inherited={enabledProjects.has(project.path)}
              draft={branchDrafts[pluginProjectKey(pluginId, project.path)] ?? EMPTY_DRAFT}
              busy={busy}
              canWrite={canWrite}
              branchHandlers={branchHandlers}
            />
          ))}
    </div>
  );
}

/** 브랜치 목록이 길어지면 검색창을 띄우는 기준. 레인 워크트리를 쓰는 저장소는 금방 넘는다. */
const BRANCH_SEARCH_THRESHOLD = 8;

/** 프로젝트 한 곳의 브랜치 목록과 패턴 규칙 */
interface ClaudePluginBranchProjectRowProps {
  pluginId: string;
  pluginLocked: boolean;
  project: ClaudePluginBranchProject;
  rules: ClaudePluginBranchRule[];
  inherited: boolean;
  draft: BranchDraft;
  busy: string | null;
  canWrite: boolean;
  branchHandlers: BranchRuleHandlers;
}

/** 현재 체크아웃한 브랜치를 맨 위로 올리고 나머지는 원래 순서를 유지한다. */
function prioritizeCurrentBranch(branches: readonly string[], currentBranch: string | null): string[] {
  const ordered = [...branches];
  const at = ordered.indexOf(currentBranch ?? "");
  if (at > 0) ordered.splice(0, 0, ...ordered.splice(at, 1));
  return ordered;
}

function projectFolderName(path: string): string {
  const displayed = displayPath(path);
  return displayed.split(/[\\/]/).filter(Boolean).pop() || displayed;
}

interface ClaudeBranchRuleRowProps {
  branch: string;
  rule?: ClaudePluginBranchRule;
  applies: boolean;
  inherited: boolean;
  locked: boolean;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
}

/** 브랜치 하나(또는 패턴)의 사용 여부 토글과 규칙 삭제 버튼 행 */
function ClaudeBranchRuleRow({
  branch,
  rule,
  applies,
  inherited,
  locked,
  busy,
  onToggle,
  onRemove,
}: ClaudeBranchRuleRowProps) {
  const { text } = useI18n();
  const stateLabel = rule
    ? rule.enabled ? text("이 브랜치에서 사용", "On for this branch") : text("이 브랜치에서 사용 안 함", "Off for this branch")
    : text("프로젝트 설정 상속", "Inherited");

  return (
    <div className={`claude-branch-rule${applies ? " applies" : ""}`}>
      <code>{branch}</code>
      {applies && <em>{text("지금 적용", "Active now")}</em>}
      <span className="claude-branch-state">{stateLabel}</span>
      <AppToggle
        checked={rule ? rule.enabled : inherited}
        disabled={locked || busy}
        label={text(`${branch} 사용여부`, `${branch} enabled`)}
        onChange={onToggle}
      />
      <button
        className="button compact danger"
        type="button"
        disabled={locked || busy || !rule}
        title={text("규칙 삭제 — 프로젝트 설정을 따릅니다", "Remove the rule and fall back to the project setting")}
        onClick={onRemove}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function ClaudePluginBranchProjectRow({
  pluginId,
  pluginLocked,
  project,
  rules,
  inherited,
  draft,
  busy,
  canWrite,
  branchHandlers: { onDraftChange, onAddBranchRule, onToggleBranchRule, onRemoveBranchRule },
}: ClaudePluginBranchProjectRowProps) {
  const { text } = useI18n();
  const [query, setQuery] = useState("");
  const draftKey = pluginProjectKey(pluginId, project.path);
  const locked = !canWrite || pluginLocked;
  // 지금 체크아웃한 브랜치를 맨 위로 올린다. 나머지는 사전순 그대로다.
  const branches = useMemo(
    () => prioritizeCurrentBranch(project.branches, project.currentBranch),
    [project.branches, project.currentBranch],
  );
  const needle = query.trim().toLowerCase();
  const listed = needle ? branches.filter((branch) => branch.toLowerCase().includes(needle)) : branches;
  // 목록에 없는 규칙 = 패턴이거나 지워진 브랜치. 이것도 보여야 지울 수 있다.
  const extraRules = rules.filter((rule) => !project.branches.includes(rule.branch));
  return (
    <div className="claude-branch-project">
      <div className="claude-branch-project-head">
        <span>{projectFolderName(project.path)}</span>
        <code>{displayPath(project.path)}</code>
        <em>{project.currentBranch
          ? text(`현재 ${project.currentBranch}`, `on ${project.currentBranch}`)
          : text("브랜치 없음", "No branch")}</em>
        <em>{inherited
          ? text("프로젝트 기본: 사용", "Project default: on")
          : text("프로젝트 기본: 사용 안 함", "Project default: off")}</em>
      </div>
      {branches.length > BRANCH_SEARCH_THRESHOLD && (
        <div className="claude-branch-search">
          <input
            value={query}
            placeholder={text(`브랜치 ${branches.length}개 중 찾기`, `Search ${branches.length} branches`)}
            aria-label={text("브랜치 찾기", "Search branches")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}
      {branches.length === 0
        ? <small className="claude-plugin-project-empty">{text(
          "로컬 브랜치를 읽지 못했습니다. git 저장소가 아니면 아래 패턴만 쓸 수 있습니다.",
          "No local branches were found. Without a git repository only the pattern below can be used.",
        )}</small>
        : listed.length === 0
          ? <small className="claude-plugin-project-empty">{text("찾는 브랜치가 없습니다.", "No matching branch.")}</small>
          : <div className="claude-branch-list">
            {listed.map((branch) => (
              <ClaudeBranchRuleRow
                key={branch}
                branch={branch}
                rule={rules.find((rule) => rule.branch === branch)}
                applies={branch === project.currentBranch}
                inherited={inherited}
                locked={locked}
                busy={busy === branchRuleKey(pluginId, project.path, branch)}
                onToggle={(enabled) => onToggleBranchRule(project.path, branch, enabled)}
                onRemove={() => onRemoveBranchRule(project.path, branch)}
              />
            ))}
          </div>}
      {extraRules.length > 0 && (
        <div className="claude-branch-extra">
          <small>{text("패턴·목록에 없는 브랜치 규칙", "Patterns and rules for missing branches")}</small>
          {extraRules.map((rule) => (
            <ClaudeBranchRuleRow
              key={rule.branch}
              branch={rule.branch}
              rule={rule}
              applies={branchMatches(rule.branch, project.currentBranch)}
              inherited={inherited}
              locked={locked}
              busy={busy === branchRuleKey(pluginId, project.path, rule.branch)}
              onToggle={(enabled) => onToggleBranchRule(project.path, rule.branch, enabled)}
              onRemove={() => onRemoveBranchRule(project.path, rule.branch)}
            />
          ))}
        </div>
      )}
      <div className="claude-branch-add">
        <input
          value={draft.branch}
          placeholder={text("패턴 추가 — feature/*", "Add a pattern — feature/*")}
          aria-label={text("브랜치 패턴 규칙 추가", "Add a branch pattern rule")}
          disabled={locked}
          onChange={(event) => onDraftChange(project.path, { ...draft, branch: event.target.value })}
        />
        <label>
          <span>{text("사용", "Enabled")}</span>
          <AppToggle
            checked={draft.enabled}
            disabled={locked}
            label={text("추가할 규칙의 사용여부", "Enabled for the new rule")}
            onChange={(enabled) => onDraftChange(project.path, { ...draft, enabled })}
          />
        </label>
        <button
          className="button compact"
          type="button"
          disabled={locked || !draft.branch.trim() || busy === draftKey}
          onClick={() => onAddBranchRule(project.path, draft.branch.trim(), draft.enabled)}
        >
          {text("추가", "Add")}
        </button>
      </div>
    </div>
  );
}

/** 플러그인 목록의 개별 플러그인 행 컴포넌트 */
interface ClaudePluginRowProps {
  plugin: ClaudeSettingsSnapshot["plugins"][number];
  scope: PluginScope;
  busy: string | null;
  canWrite: boolean;
  projects: ProjectRegistryEntry[];
  projectSnapshots: Record<string, ClaudeSettingsSnapshot>;
  branchRules: ClaudePluginBranchRulesSnapshot | null;
  branchDrafts: Record<string, BranchDraft>;
  onScopeChange: (scope: PluginScope) => void;
  onToggleUserEnabled: (enabled: boolean) => void;
  onToggleProject: (projectPath: string, enabled: boolean) => void;
  branchHandlers: BranchRuleHandlers;
}

function ClaudePluginRow({
  plugin,
  scope,
  busy,
  canWrite,
  projects,
  projectSnapshots,
  branchRules,
  branchDrafts,
  onScopeChange,
  onToggleUserEnabled,
  onToggleProject,
  branchHandlers,
}: ClaudePluginRowProps) {
  const { text } = useI18n();
  const rowBusy = busy === plugin.pluginId;
  const scopeLabels: Record<PluginScope, string> = {
    global: text("전역", "Global"),
    project: text("프로젝트별", "Per project"),
    branch: text("브랜치별", "Per branch"),
  };
  return (
    <div className={`plugin-row${plugin.effectiveEnabled ? "" : " plugin-off"}`}>
      <i><Blocks size={17} /></i>
      <div className="plugin-row-main">
        <div className="plugin-row-name">
          <strong>{plugin.name}</strong>
          <code>{plugin.pluginId}</code>
        </div>
        <small>
          {plugin.marketplace || text("마켓플레이스 미상", "Unknown marketplace")}
          {plugin.version ? ` · v${plugin.version}` : ""} · {text(`스킬 ${plugin.skillCount}개`, `${plugin.skillCount} skills`)}
        </small>
        <div className="claude-plugin-badges">
          <span className={`plugin-status ${plugin.effectiveEnabled ? "ok" : "muted"}`}>
            <i />{plugin.effectiveEnabled ? text("사용", "Enabled") : text("사용 안 함", "Disabled")}
          </span>
          {plugin.locked && <em className="locked">{text("사용자 지정·정책 잠금", "Custom or policy locked")}</em>}
        </div>
      </div>
      <div className="plugin-row-actions">
        <label className="claude-plugin-toggle-label">
          <span>{text("사용여부", "Enabled")}</span>
          <AppToggle
            checked={plugin.effectiveEnabled}
            disabled={!canWrite || rowBusy || plugin.locked}
            label={text(`${plugin.name} 사용여부`, `${plugin.name} enabled`)}
            onChange={onToggleUserEnabled}
          />
        </label>
        <div className="claude-plugin-scope-toggle" role="group" aria-label={text("적용 범위", "Scope")}>
          {/* 버튼 셋이 이름만 다른 같은 markup이었다. 저장값을 거르는 PLUGIN_SCOPES를
              그대로 돌려, 범위가 늘 때 한쪽만 고쳐 어긋나는 길을 없앤다. */}
          {PLUGIN_SCOPES.map((item) => (
            <button
              key={item}
              className={`button compact${scope === item ? " selected" : ""}`}
              type="button"
              disabled={rowBusy}
              onClick={() => onScopeChange(item)}
            >
              {scopeLabels[item]}
            </button>
          ))}
        </div>
      </div>
      {scope === "project" && (
        <ClaudePluginProjectSection
          pluginId={plugin.pluginId}
          pluginLocked={plugin.locked}
          projects={projects}
          projectSnapshots={projectSnapshots}
          busy={busy}
          canWrite={canWrite}
          onToggleProject={onToggleProject}
        />
      )}
      {scope === "branch" && (
        <ClaudePluginBranchSection
          pluginId={plugin.pluginId}
          pluginLocked={plugin.locked}
          branchRules={branchRules}
          branchDrafts={branchDrafts}
          projectSnapshots={projectSnapshots}
          busy={busy}
          canWrite={canWrite}
          branchHandlers={branchHandlers}
        />
      )}
    </div>
  );
}
