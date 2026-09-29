import { useEffect, useMemo, useState } from "react";
import { Folder, RotateCcw } from "lucide-react";
import { getClaudeSettingsStates, getProjectRegistry, getSkillDetail, getWebAccessStatus, setClaudeSkillOverride, type WebAccessStatus } from "../lib/ipc";
import { useI18n, type UiText } from "../lib/i18n";
import { CatalogHealthBanner } from "./CatalogHealthBanner";
import { skillBulkMigrationPrompt } from "../lib/skillTransfer";
import type { CatalogHealth, ClaudePluginState, ClaudeSettingsSnapshot, ClaudeSkillOverrideState, ProjectRegistryEntry, SkillDetail, SkillOverrideValue, SkillSummary, SystemAutomationSnapshot, TranslationSummary } from "../types";
import { MarkdownPreview } from "./MarkdownPreview";
import { Drawer, EmptyState, ErrorBanner, SourceBadge } from "./Shared";
import { FilterAxisBar, filterMatcher, type FilterAxisSpec } from "./FilterAxisBar";
import { DetailInfo, DrawerBody, OriginalContent, useDrawerDetail } from "./DetailDrawer";
import { BulkMigrationButton, LibraryRowMain, LibraryToolbar, SkillLibraryPanel, ViewModeTabs, filterAxes, matchesNeedle, rowActivationProps, useMenuTranslationBar, useStoredChoice, useStoredFilters } from "./SkillLibraryPanel";
import { TranslateResourceButton, TranslationProgress } from "./TranslationProgress";
import { errorText } from "../lib/errorText";
import { sourceName } from "../lib/format";
import { displayPath } from "../lib/displayPath";
import { normalizePathSlashes } from "../lib/crossPlatformPath";

const SKILL_FILTERS_KEY = "agent-manager.skill-filters.v3";
const SKILL_MODE_KEY = "agent-manager.skill-mode.v1";
/** 구분은 스킬을 노출한 공급자로 가른다. 아는 공급자가 아니면 `other`로 모은다. */
const SKILL_GROUPS = ["all", "claude", "codex", "antigravity", "other"] as const;
/**
 * 태그는 구분과 독립된 축이다. `archived`는 범위가 아니라 공용 보관 원본에서 배포된
 * 설치본이라는 표시라서 개인·프로젝트 어느 범위와도 겹칠 수 있다.
 */
const SKILL_TAGS = ["all", "archived", "personal", "project", "plugin", "system", "builtin"] as const;

type SkillGroupFilter = (typeof SKILL_GROUPS)[number];
type SkillTagFilter = (typeof SKILL_TAGS)[number];

interface SkillFilters {
  group: SkillGroupFilter;
  tag: SkillTagFilter;
}


/**
 * `installed`는 공급자별로 감지된 설치본을 그대로 보여주는 읽기 전용 목록이고,
 * `library`는 공통 원본 하나를 여러 공급자에 게시·동기화하는 통합 관리 화면이다.
 */
const SKILL_VIEW_MODES = ["installed", "library"] as const;
type SkillViewMode = (typeof SKILL_VIEW_MODES)[number];

interface SkillsViewProps {
  /** 이 화면이 지금 보이는지. 보관 스킬 목록이 화면에 들어올 때마다 다시 읽는 근거다. */
  active?: boolean;
  skills: SkillSummary[];
  automation: SystemAutomationSnapshot | null;
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void;
  /** 삭제 등으로 설치본이 바뀐 뒤 스냅샷을 다시 읽게 한다. */
  onSkillsChanged?: () => void;
  /** OS 변형 일괄 마이그레이션 등 AIA 위임 요청을 입력창에 넣는다. */
  onRequestAiaPrompt?: (prompt: string) => void;
  aiaTransferAvailable?: boolean;
  /** 스캔이 건너뛴 경로를 목록 위에 알리는 근거. */
  catalogHealth?: CatalogHealth | null;
  /** 공통 저장소 경로가 바뀌면 이미 마운트된 라이브러리도 새 루트에서 다시 읽는다. */
  repositoryRevision?: number;
}

export function SkillsView({ active = true, skills, automation, onAutomationChange, onSkillsChanged, onRequestAiaPrompt, aiaTransferAvailable, catalogHealth = null, repositoryRevision = 0 }: SkillsViewProps) {
  const { text } = useI18n();
  const [mode, setMode] = useStoredChoice<SkillViewMode>(SKILL_MODE_KEY, SKILL_VIEW_MODES, "installed");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useStoredFilters(SKILL_FILTERS_KEY, parseSkillFilters);
  const [selected, setSelected] = useState<SkillSummary | null>(null);
  const translations = useMenuTranslationBar("skills", automation, onAutomationChange);
  const [migrationRequiredCount, setMigrationRequiredCount] = useState(0);
  const [claudeSettings, setClaudeSettings] = useState<ClaudeSettingsSnapshot | null>(null);
  const [claudeSettingsError, setClaudeSettingsError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "installed") return;
    let active = true;
    getClaudeSettingsStates(null)
      .then((snapshot) => { if (active) { setClaudeSettings(snapshot); setClaudeSettingsError(null); } })
      .catch((cause: unknown) => { if (active) setClaudeSettingsError(errorText(cause)); });
    return () => { active = false; };
  }, [mode]);

  const needle = query.trim().toLowerCase();
  const searched = useMemo(() => {
    if (!needle) return skills;
    return skills.filter((skill) => matchesSkill(skill, needle, translations.records));
  }, [skills, needle, translations.records]);

  const filtered = useMemo(
    () => searched.filter((skill) => SKILL_FILTER.matches(skill, filters)),
    [searched, filters],
  );

  /**
   * 그 축만 이 값으로 바꿨을 때 남는 스킬 수. 자기 축은 빼고 나머지 필터만 적용하므로,
   * 개인 스킬이 몇 개인지 눌러 보지 않아도 버튼에 보인다.
   */
  const countWhere = SKILL_FILTER.counter(searched, filters);

  const hasActiveFilter = filters.group !== "all" || filters.tag !== "all" || Boolean(query.trim());
  // 보관 원본에서 배포된 설치본 수. 스킬관리의 요약 줄과 같은 자리에 보여 준다.
  const archivedInstalls = useMemo(() => skills.filter((skill) => skill.archived).length, [skills]);

  const modeSwitch = (
    <ViewModeTabs
      label={text("스킬 화면 모드", "Skill view mode")}
      modes={[
        { id: "installed", label: text("스킬정보", "Info") },
        { id: "library", label: text("스킬관리", "Manage") },
      ]}
      current={mode}
      onSelect={setMode}
    />
  );

  if (mode === "library") {
    return (
      <div className="view-stack">
        <section className="toolbar-card skill-mode-toolbar">
          {modeSwitch}
          {onRequestAiaPrompt && (
            <BulkMigrationButton
              aiaAvailable={Boolean(aiaTransferAvailable)}
              count={migrationRequiredCount}
              noneTitle={text("현재 OS에서 변형이 필요한 스킬이 없습니다", "No skills need a variant on this OS")}
              requestTitle={text("AIA에게 미지원 스킬 전체의 현재 OS 변형 생성을 요청합니다", "Ask AIA to create current-OS variants for every unsupported skill")}
              onRequest={() => onRequestAiaPrompt(skillBulkMigrationPrompt(migrationRequiredCount))}
            />
          )}
          <TranslationProgress {...translations.progress} />
        </section>
        <SkillLibraryPanel key={repositoryRevision} active={active} translations={translations.records} automation={automation} onAutomationChange={onAutomationChange} onInstalledChanged={onSkillsChanged} onMigrationRequiredCount={setMigrationRequiredCount} onRequestAiaPrompt={onRequestAiaPrompt} />
      </div>
    );
  }

  return (
    <div className="view-stack">
      <section className="toolbar-card skill-mode-toolbar">
        {modeSwitch}
        <TranslationProgress {...translations.progress} />
      </section>

      <LibraryToolbar
        title={text("설치된 스킬", "Installed skills")}
        summary={text("공급자별로 감지한 SKILL.md 설치본입니다. 조회 전용이라 여기서는 바꾸지 않습니다.", "SKILL.md installs detected per provider. Read-only — nothing is changed here.")}
      >
        <div className="skill-sync-counts">
          {archivedInstalls > 0 && <span className="skill-sync-pill current">{text("보관", "Archived")} {archivedInstalls.toLocaleString()}</span>}
          <span className="toolbar-count">{hasActiveFilter
            ? text(`${filtered.length.toLocaleString()} / ${skills.length.toLocaleString()}개`, `${filtered.length.toLocaleString()} / ${skills.length.toLocaleString()} skills`)
            : text(`${filtered.length.toLocaleString()}개`, `${filtered.length.toLocaleString()} skills`)}</span>
        </div>
        <input className="search-input" aria-label={text("스킬 검색", "Search skills")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text("스킬명·설명·출처 검색", "Search name, description, or source")} />
      </LibraryToolbar>

      <section className="toolbar-card skill-library-filterbar">
        <FilterAxisBar
          axes={skillFilterAxes(text)}
          filters={filters}
          countWhere={countWhere}
          onChange={setFilters}
        />
      </section>

      <CatalogHealthBanner health={catalogHealth} kind="skills" />

      {claudeSettingsError && <ErrorBanner message={claudeSettingsError} />}

      {filtered.length === 0 ? (
        <EmptyState title={text("스킬을 찾지 못했습니다", "No skills found")} detail={text("로컬 SKILL.md 위치와 검색 조건을 확인하세요.", "Check local SKILL.md locations and your filters.")} />
      ) : (
        <section className="skill-library-list">
          {filtered.map((skill) => (
            <InstalledSkillRow
              skill={skill}
              translated={translations.records.get(skill.id)}
              claudeSettings={claudeSettings}
              onSelect={setSelected}
              key={skill.id}
            />
          ))}
        </section>
      )}

      {selected && <SkillDrawer skill={selected} translated={translations.records.get(selected.id)} automation={automation} claudeSettings={claudeSettings} onClaudeSettingsChange={setClaudeSettings} onAutomationChange={onAutomationChange} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** 설치된 스킬 목록의 한 줄 카드. 번역·Claude 상태 표시·키보드 선택 처리를 목록 뼈대와 분리한다. */
function InstalledSkillRow({
  skill,
  translated,
  claudeSettings,
  onSelect,
}: {
  skill: SkillSummary;
  translated?: TranslationSummary;
  claudeSettings: ClaudeSettingsSnapshot | null;
  onSelect: (skill: SkillSummary) => void;
}) {
  const { text } = useI18n();
  const claudeState = claudeStatusForSkill(skill, claudeSettings, text);
  return (
    // 스킬관리와 같은 줄 카드 형태를 쓴다. 여기는 조회 전용이라 체크박스·사용 토글이 없다.
    <div className={`skill-library-item${claudeState?.off ? " skill-disabled" : ""}`}>
      <div
        className={`skill-library-row${skill.archived ? " is-shared" : ""}`}
        {...rowActivationProps(() => onSelect(skill))}
      >
        <LibraryRowMain
          path={skill.path}
          description={(translated?.fields.description ?? skill.description) || text("설명이 없습니다.", "No description.")}
        >
          <strong data-user-content>{translated?.fields.name ?? skill.name}</strong>
          <span className="scope-pill">{scopeName(skill.scope, text)}</span>
          {skill.archived && <span className="skill-archived-pill">{text("보관", "Archived")}</span>}
          {claudeState && <span className={`skill-state-pill${claudeState.off ? " off" : ""}`}>{claudeState.label}</span>}
        </LibraryRowMain>
        <div className="skill-provider-matrix">
          <SourceBadge source={skill.source} />
          <span className="skill-provider-chip" title={skill.origin ?? undefined}>
            <em>{text("출처", "Source")}</em>
            <b>{skill.origin ?? text("로컬", "Local")}</b>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Claude 스킬 한 개의 사용 설정 상태를 모은 훅. 서랍 본문이 상세 조회·번역 표시와 나란히
 * 설정 스냅샷 조회·프로젝트 목록·쓰기 가능 판정·저장 중 표시·저장 실패 문구를 평평하게
 * 들고 있어, 어느 상태가 본문 렌더링에 필요하고 어느 것이 설정 카드에만 쓰이는지 읽히지
 * 않았다. 설정 쪽 상태와 저장 절차만 이리로 옮기고 서랍에는 상세 조회만 남긴다.
 *
 * 조회는 Claude 스킬이면서 플러그인 소속이 아닐 때만 돈다(플러그인 스킬은 개별로 켜고 끌 수
 * 없어 설정 카드가 안내만 보여 준다). 조회 실패는 화면을 막지 않고 문구로만 알린다.
 */
function useClaudeSkillOverride(
  skill: SkillSummary,
  claudeSettings: ClaudeSettingsSnapshot | null,
  onClaudeSettingsChange: (snapshot: ClaudeSettingsSnapshot) => void,
) {
  const intrinsicProject = projectPathFromSkill(skill);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectRegistryEntry[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(skill.scope === "project" ? intrinsicProject : null);
  const [settings, setSettings] = useState<ClaudeSettingsSnapshot | null>(claudeSettings);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (skill.source !== "claude" || skill.scope === "plugin") return;
    let active = true;
    const contextProject = selectedProject ?? intrinsicProject;
    Promise.all([getClaudeSettingsStates(contextProject), getProjectRegistry(), getWebAccessStatus()])
      .then(([snapshot, entries, webAccess]) => {
        if (!active) return;
        setSettings(snapshot);
        setProjects(entries.filter((entry) => entry.active && entry.exists));
        setAccess(webAccess);
      })
      .catch((cause: unknown) => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [skill.source, skill.scope, intrinsicProject, selectedProject]);

  const override = settings?.skills.find((entry) => entry.directory === skill.directory) ?? null;
  const canWrite = access?.writable === true && !override?.locked && !override?.disableModelInvocation;
  const writeScope = selectedProject ? "project" : "user";
  const explicit = override ? (writeScope === "user" ? override.values.user : override.values.local) : undefined;

  const setOverride = async (value: SkillOverrideValue | null) => {
    if (!override || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await setClaudeSkillOverride({
        overrideKey: override.overrideKey,
        scope: writeScope,
        projectPath: selectedProject ?? intrinsicProject,
        value,
      });
      setSettings(next);
      // 화면 목록의 상태 배지는 전역 스냅샷을 보므로 범위 저장과 별개로 다시 읽어 올린다.
      void getClaudeSettingsStates(null).then(onClaudeSettingsChange).catch(() => undefined);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return { intrinsicProject, projects, selectedProject, setSelectedProject, override, explicit, canWrite, busy, error, setOverride };
}

function SkillDrawer({ skill, translated, automation, claudeSettings, onClaudeSettingsChange, onAutomationChange, onClose }: { skill: SkillSummary; translated?: TranslationSummary; automation: SystemAutomationSnapshot | null; claudeSettings: ClaudeSettingsSnapshot | null; onClaudeSettingsChange: (snapshot: ClaudeSettingsSnapshot) => void; onAutomationChange: (snapshot: SystemAutomationSnapshot) => void; onClose: () => void }) {
  const { text } = useI18n();
  const { detail, translatedDetail, error: detailError } = useDrawerDetail({
    menu: "skills",
    resourceId: skill.id,
    translated,
    translationRevision: automation?.revision ?? 0,
    load: () => getSkillDetail(skill.id),
  });
  const claude = useClaudeSkillOverride(skill, claudeSettings, onClaudeSettingsChange);
  const error = detailError ?? claude.error;
  return (
    <Drawer
      title={<><SourceBadge source={skill.source} /><span data-user-content>{translated?.fields.name ?? skill.name}</span>{skill.archived && <span className="skill-archived-pill">{text("보관", "Archived")}</span>}</>}
      actions={<TranslateResourceButton menu="skills" resourceId={skill.id} translated={Boolean(translated)} automation={automation} onAutomationChange={onAutomationChange} />}
      onClose={onClose}
    >
      <DrawerBody detail={detail} error={error} loadingLabel={text("SKILL.md를 읽고 있습니다", "Reading SKILL.md")}>
        {(detail) => (
          <>
            <section className="detail-card meta-grid">
              <DetailInfo mono title label={text("범위", "Scope")} value={scopeName(detail.skill.scope, text)} />
              <DetailInfo mono title label={text("출처", "Source")} value={detail.skill.origin ?? text("로컬", "Local")} />
              <DetailInfo mono title label={text("파일", "File")} value={displayPath(detail.skill.path)} />
              <DetailInfo mono title label={text("구성 파일", "Files")} value={`${countFiles(detail.files)}${text("개", "")}`} />
            </section>
            <section className="detail-card">
              <div className="section-title"><h3>{text("설명", "Description")}</h3></div>
              <p className="prose-copy" data-user-content>{(translatedDetail?.fields.description ?? translated?.fields.description ?? detail.skill.description) || text("설명이 없습니다.", "No description.")}</p>
            </section>
            {skill.source === "claude" && <ClaudeSkillSettings
              skill={skill}
              intrinsicProject={claude.intrinsicProject}
              projects={claude.projects}
              selectedProject={claude.selectedProject}
              onProjectChange={claude.setSelectedProject}
              override={claude.override}
              explicit={claude.explicit}
              canWrite={claude.canWrite}
              busy={claude.busy}
              onChange={(value) => { void claude.setOverride(value); }}
            />}
            <section className="detail-card">
              <div className="section-title"><h3>SKILL.md</h3></div>
              <MarkdownPreview source={translatedDetail?.fields.body ?? detail.body} compact />
            </section>
            {translatedDetail?.fields.body && <OriginalContent card><MarkdownPreview source={detail.body} compact /></OriginalContent>}
            <section className="detail-card">
              <div className="section-title"><h3>{text("파일", "Files")}</h3></div>
              <FileList nodes={detail.files} />
            </section>
          </>
        )}
      </DrawerBody>
    </Drawer>
  );
}

const SKILL_OVERRIDE_VALUES: SkillOverrideValue[] = ["on", "name-only", "user-invocable-only", "off"];

function ClaudeSkillSettings({ skill, intrinsicProject, projects, selectedProject, onProjectChange, override, explicit, canWrite, busy, onChange }: {
  skill: SkillSummary;
  intrinsicProject: string | null;
  projects: ProjectRegistryEntry[];
  selectedProject: string | null;
  onProjectChange: (project: string | null) => void;
  override: ClaudeSkillOverrideState | null;
  explicit: SkillOverrideValue | undefined;
  canWrite: boolean;
  busy: boolean;
  onChange: (value: SkillOverrideValue | null) => void;
}) {
  const { text } = useI18n();
  if (skill.scope === "plugin") {
    return (
      <section className="detail-card claude-skill-settings">
        <div className="section-title"><h3>{text("사용 설정", "Usage settings")}</h3></div>
        <p className="prose-copy">{text(
          "플러그인 소속 스킬은 개별로 켜거나 끌 수 없습니다. 애드온 → Claude Code에서 플러그인 전체를 변경하세요.",
          "Plugin skills cannot be toggled individually. Change the whole plugin under Add-ons → Claude Code.",
        )}</p>
      </section>
    );
  }
  const availableProjects = skill.scope === "project" && intrinsicProject
    ? projects.filter((project) => normalizedPath(project.path) === normalizedPath(intrinsicProject))
    : projects;
  const projectSelectionMissing = skill.scope === "project"
    && intrinsicProject !== null
    && availableProjects.length === 0;
  const settingsWritable = canWrite && !(projectSelectionMissing && selectedProject);
  return (
    <section className="detail-card claude-skill-settings">
      <div className="section-title"><h3>{text("사용 설정", "Usage settings")}</h3></div>
      <label className="claude-skill-scope">
        <span>{text("적용 범위", "Scope")}</span>
        <select value={selectedProject ?? ""} disabled={busy} onChange={(event) => onProjectChange(event.target.value || null)}>
          <option value="">{text("전역", "Global")}</option>
          {availableProjects.map((project) => <option value={project.path} key={project.path}>{text(`프로젝트 · ${displayPath(project.name)}`, `Project · ${displayPath(project.name)}`)}</option>)}
          {projectSelectionMissing && <option value={intrinsicProject} disabled>{text("등록되지 않은 프로젝트", "Unregistered project")}</option>}
        </select>
      </label>
      {projectSelectionMissing && selectedProject && <p className="claude-skill-lock-note">{text("이 프로젝트는 현재 활성 프로젝트로 등록되지 않아 프로젝트 설정을 바꿀 수 없습니다.", "This project is not registered as active, so its project setting cannot be changed.")}</p>}
      {!override ? <p className="settings-storage-note">{text("이 범위에서 스킬 상태를 확인하는 중입니다.", "Checking the skill state for this scope.")}</p> : <>
        <div className="claude-skill-options" role="group" aria-label={text("스킬 사용 상태", "Skill usage state")}>
          {SKILL_OVERRIDE_VALUES.map((value) => (
            <button type="button" className={override.effective === value ? "selected" : ""} aria-pressed={override.effective === value} disabled={!settingsWritable || busy} key={value} onClick={() => onChange(value)}>{overrideLabel(value, text)}</button>
          ))}
        </div>
        <div className="claude-skill-effective">
          <span>{text("적용값", "Effective")} <strong>{overrideLabel(override.effective, text)}</strong></span>
          {override.decidedBy && <small>{scopeLabel(override.decidedBy, text)}</small>}
          {explicit !== undefined && <button className="button compact" type="button" disabled={!settingsWritable || busy} onClick={() => onChange(null)}><RotateCcw size={13} />{text("상속으로 되돌리기", "Restore inheritance")}</button>}
        </div>
        {override.disableModelInvocation && <p className="claude-skill-lock-note">{text("SKILL.md의 disable-model-invocation 설정이 우선해 모델 호출 설정을 바꿀 수 없습니다.", "SKILL.md's disable-model-invocation setting takes precedence, so model invocation cannot be changed here.")}</p>}
        {override.locked && <p className="claude-skill-lock-note">{text("관리 정책 또는 알 수 없는 사용자 지정 값이 우선해 Agent Manager에서 덮어쓰지 않습니다.", "A managed policy or unknown custom value takes precedence and is not overwritten by Agent Manager.")}</p>}
      </>}
      <p className="claude-skill-reload-note">{text("실행 중인 Claude Code 세션에는 /reload-plugins 또는 재시작 후 반영됩니다.", "Running Claude Code sessions pick up changes after /reload-plugins or a restart.")}</p>
    </section>
  );
}

function claudeStatusForSkill(skill: SkillSummary, snapshot: ClaudeSettingsSnapshot | null, text: UiText): { label: string; off: boolean } | null {
  if (skill.source !== "claude" || !snapshot) return null;
  if (skill.scope === "plugin") {
    const plugin = pluginForSkill(skill, snapshot.plugins);
    if (!plugin) return null;
    return plugin.effectiveEnabled
      ? { label: text("플러그인 사용", "Plugin enabled"), off: false }
      : { label: text("플러그인 꺼짐", "Plugin disabled"), off: true };
  }
  const state = snapshot.skills.find((entry) => entry.directory === skill.directory);
  if (!state) return skill.scope === "project" ? { label: text("프로젝트 설정", "Project settings"), off: false } : null;
  return { label: overrideLabel(state.effective, text), off: state.effective === "off" };
}

function pluginForSkill(skill: SkillSummary, plugins: ClaudePluginState[]): ClaudePluginState | null {
  const normalized = normalizePathSlashes(skill.directory);
  return plugins.find((plugin) => normalized.startsWith(`${normalizePathSlashes(plugin.installPath)}/skills/`))
    ?? plugins.find((plugin) => plugin.name === skill.origin)
    ?? null;
}

function projectPathFromSkill(skill: SkillSummary): string | null {
  if (skill.scope !== "project") return null;
  const normalized = normalizePathSlashes(skill.directory);
  const marker = "/.claude/skills/";
  const index = normalized.lastIndexOf(marker);
  return index > 0 ? normalized.slice(0, index) : null;
}

/** 같은 프로젝트인지 견주기 전의 손질. 구분자는 정본에 맡기고 여기서는 끝 슬래시만 떼어 낸다. */
function normalizedPath(path: string): string {
  return normalizePathSlashes(path).replace(/\/+$/, "");
}

function overrideLabel(value: SkillOverrideValue, text: UiText): string {
  if (value === "name-only") return text("이름만", "Name only");
  if (value === "user-invocable-only") return text("직접 호출만", "User invocation only");
  if (value === "off") return text("꺼짐", "Off");
  return text("사용", "On");
}

function scopeLabel(scope: ClaudeSkillOverrideState["decidedBy"], text: UiText): string {
  if (scope === "policy") return text("관리 정책에서 결정", "Decided by managed policy");
  if (scope === "local") return text("프로젝트 로컬 설정에서 결정", "Decided by project local settings");
  if (scope === "project") return text("프로젝트 공유 설정에서 결정", "Decided by project settings");
  return text("전역 설정에서 결정", "Decided by global settings");
}


function FileList({ nodes, depth = 0 }: { nodes: SkillDetail["files"]; depth?: number }) {
  return <div className="file-list">{nodes.map((node) => <div key={node.relativePath}><div className="file-row" style={{ paddingLeft: `${depth * 14}px` }}><span>{node.isDirectory ? <Folder size={11} /> : "·"}</span><code>{node.name}</code></div>{node.isDirectory && <FileList nodes={node.children} depth={depth + 1} />}</div>)}</div>;
}

function countFiles(nodes: SkillDetail["files"]): number {
  return nodes.reduce((total, node) => total + (node.isDirectory ? countFiles(node.children) : 1), 0);
}

/** 스킬이 속한 구분. 아는 공급자면 그 공급자, 아니면 기타로 모아 목록에서 사라지지 않게 한다. */
function skillGroup(skill: SkillSummary): Exclude<SkillGroupFilter, "all"> {
  return SKILL_GROUPS.includes(skill.source as SkillGroupFilter) ? skill.source as Exclude<SkillGroupFilter, "all"> : "other";
}

/**
 * 필터 축 둘의 판정 한 벌. 남길 스킬을 고르는 일과 버튼에 붙는 개수를 세는 일이 같은
 * 조건을 각자 적어 두어, 축을 늘리거나 규칙을 고칠 때 한쪽만 바뀔 자리가 여럿이었다.
 * 지침정보 탭이 쓰는 판정 표와 같은 모양이라 두 화면이 같은 조립기를 쓴다.
 */
const SKILL_FILTER = filterMatcher<SkillSummary, SkillFilters>({
  group: (skill, value) => value === "all" || skillGroup(skill) === value,
  tag: (skill, value) => value === "all"
    || (value === "archived" ? skill.archived : skill.scope === value),
});

function groupName(group: SkillGroupFilter, text: UiText): string {
  if (group === "all") return text("전체", "All");
  if (group === "other") return text("기타", "Other");
  return sourceName(group);
}

function scopeName(scope: string, text: UiText): string {
  const labels: Record<string, string> = {
    personal: text("개인", "Personal"),
    project: text("프로젝트", "Project"),
    plugin: text("플러그인", "Plugin"),
    system: text("시스템", "System"),
    builtin: text("내장", "Built-in"),
    archived: text("보관", "Archived"),
    all: text("모든 태그", "All tags"),
  };
  return labels[scope] ?? scope;
}

function parseSkillFilters(stored: Partial<SkillFilters> | null): SkillFilters {
  // 구분의 뜻이 바뀌면 키를 올려서 예전 선택을 버린다. 알 수 없는 값은 전체로 되돌린다.
  return {
    group: SKILL_GROUPS.includes(stored?.group as SkillGroupFilter) ? stored!.group as SkillGroupFilter : "all",
    tag: SKILL_TAGS.includes(stored?.tag as SkillTagFilter) ? stored!.tag as SkillTagFilter : "all",
  };
}

/**
 * 스킬정보 탭의 필터 축 둘. 축 이름표와 칩 이름만 다르고 개수·활성·"고르면 그 축만 바꾼다"는
 * 축 줄(`FilterAxisBar`)에서 나온다. "전체"는 0건이어도 눌러서 되돌아갈 길이라 칩 줄의 기본
 * 규칙(0건이면서 고른 칩이 아니면 잠근다)에서 빼 준다.
 */
function skillFilterAxes(
  text: UiText,
): FilterAxisSpec<SkillFilters>[] {
  return filterAxes<SkillFilters>([
    {
      axis: "group",
      label: text("구분", "Category"),
      groupLabel: text("스킬 구분 필터", "Skill category filter"),
      chips: SKILL_GROUPS.map((item) => ({
        value: item,
        label: groupName(item, text),
        ...(item === "all" ? { disabled: false } : {}),
      })),
    },
    {
      axis: "tag",
      label: text("태그", "Tag"),
      groupLabel: text("스킬 태그 필터", "Skill tag filter"),
      chips: SKILL_TAGS.map((item) => ({
        value: item,
        label: scopeName(item, text),
        ...(item === "all" ? { disabled: false } : {}),
      })),
    },
  ]);
}

/** 스킬의 이름·설명·출처·경로와 번역 결과가 검색어에 맞는지 검사한다. */
function matchesSkill(skill: SkillSummary, needle: string, translations: Map<string, TranslationSummary>): boolean {
  const translated = translations.get(skill.id)?.fields;
  return matchesNeedle([
    skill.name,
    skill.description,
    translated?.name,
    translated?.description,
    skill.origin,
    skill.path,
  ], needle);
}
