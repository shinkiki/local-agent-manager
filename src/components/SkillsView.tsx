import { useEffect, useMemo, useState } from "react";
import { Folder, RefreshCw, RotateCcw } from "lucide-react";
import { getClaudeSettingsStates, getProjectRegistry, getSkillDetail, getTranslatedDetail, getWebAccessStatus, retryMenuTranslation, setClaudeSkillOverride, type WebAccessStatus } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { useMenuTranslations } from "../lib/translations";
import { skillBulkMigrationPrompt } from "../lib/skillTransfer";
import { degradedScanMessages } from "../lib/catalogHealth";
import type { CatalogHealth, ClaudePluginState, ClaudeSettingsSnapshot, ClaudeSkillOverrideState, ProjectRegistryEntry, SkillDetail, SkillOverrideValue, SkillSummary, SystemAutomationSnapshot, TranslatedDetail, TranslationSummary } from "../types";
import { MarkdownPreview } from "./MarkdownPreview";
import { AiaMark, Drawer, EmptyState, ErrorBanner, LoadingState, SourceBadge } from "./Shared";
import { SkillLibraryPanel } from "./SkillLibraryPanel";
import { TranslateResourceButton, TranslationProgress } from "./TranslationProgress";
import { errorText } from "../lib/errorText";

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
type SkillViewMode = "installed" | "library";

interface SkillsViewProps {
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

export function SkillsView({ skills, automation, onAutomationChange, onSkillsChanged, onRequestAiaPrompt, aiaTransferAvailable, catalogHealth = null, repositoryRevision = 0 }: SkillsViewProps) {
  const { locale, text } = useI18n();
  const [mode, setMode] = useState<SkillViewMode>(loadSkillMode);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SkillFilters>(loadSkillFilters);
  const [selected, setSelected] = useState<SkillSummary | null>(null);
  const translations = useMenuTranslations("skills", automation?.revision ?? 0);
  const translationEnabled = Boolean(automation?.settings.translations.skills);
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

  useEffect(() => {
    saveSkillFilters(filters);
  }, [filters]);

  useEffect(() => {
    saveSkillMode(mode);
  }, [mode]);

  const searched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => {
      const translated = translations.records.get(skill.id)?.fields;
      return [skill.name, skill.description, translated?.name, translated?.description, skill.origin, skill.path]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [skills, query, translations.records]);

  // 개수는 자기 축의 선택을 뺀 상태로 센다. 그래서 개인 스킬이 몇 개인지 눌러 보지 않아도 보인다.
  const groupCounts = useMemo(() => {
    const tagged = searched.filter((skill) => matchesTag(skill, filters.tag));
    return Object.fromEntries(SKILL_GROUPS.map((group) => [group, tagged.filter((skill) => matchesGroup(skill, group)).length])) as Record<SkillGroupFilter, number>;
  }, [searched, filters.tag]);

  const tagCounts = useMemo(() => {
    const grouped = searched.filter((skill) => matchesGroup(skill, filters.group));
    return Object.fromEntries(SKILL_TAGS.map((tag) => [tag, grouped.filter((skill) => matchesTag(skill, tag)).length])) as Record<SkillTagFilter, number>;
  }, [searched, filters.group]);

  const filtered = useMemo(
    () => searched.filter((skill) => matchesGroup(skill, filters.group) && matchesTag(skill, filters.tag)),
    [searched, filters],
  );

  const hasActiveFilter = filters.group !== "all" || filters.tag !== "all" || Boolean(query.trim());
  // 보관 원본에서 배포된 설치본 수. 스킬관리의 요약 줄과 같은 자리에 보여 준다.
  const archivedInstalls = useMemo(() => skills.filter((skill) => skill.archived).length, [skills]);
  const skippedRoots = useMemo(() => degradedScanMessages(catalogHealth, "skills"), [catalogHealth]);

  const modeSwitch = (
    <div className="skill-mode-tabs" role="group" aria-label={text("스킬 화면 모드", "Skill view mode")}>
      <button className={mode === "installed" ? "active" : ""} type="button" aria-pressed={mode === "installed"} onClick={() => setMode("installed")}>
        {text("스킬정보", "Info")}
      </button>
      <button className={mode === "library" ? "active" : ""} type="button" aria-pressed={mode === "library"} onClick={() => setMode("library")}>
        {text("스킬관리", "Manage")}
      </button>
    </div>
  );

  if (mode === "library") {
    return (
      <div className="view-stack">
        <section className="toolbar-card skill-mode-toolbar">
          {modeSwitch}
          {onRequestAiaPrompt && (
            <div className="skill-transfer-buttons">
              <button
                className="button compact"
                type="button"
                disabled={!aiaTransferAvailable || migrationRequiredCount === 0}
                title={!aiaTransferAvailable
                  ? text("연결된 시스템 에이전트를 설정하세요", "Configure a connected system agent")
                  : migrationRequiredCount === 0
                    ? text("현재 OS에서 변형이 필요한 스킬이 없습니다", "No skills need a variant on this OS")
                    : text("AIA에게 미지원 스킬 전체의 현재 OS 변형 생성을 요청합니다", "Ask AIA to create current-OS variants for every unsupported skill")}
                onClick={() => onRequestAiaPrompt(skillBulkMigrationPrompt(migrationRequiredCount))}
              ><RefreshCw size={13} aria-hidden="true" /><AiaMark size={13} />{text("일괄 마이그레이션", "Migrate all")}{migrationRequiredCount > 0 && <small>{migrationRequiredCount}</small>}</button>
            </div>
          )}
          <TranslationProgress enabled={translationEnabled} status={translations.data?.status ?? automation?.skills} error={translations.error} onRetry={() => { void retryMenuTranslation("skills").then(onAutomationChange); }} />
        </section>
        <SkillLibraryPanel key={repositoryRevision} translations={translations.records} automation={automation} onAutomationChange={onAutomationChange} onInstalledChanged={onSkillsChanged} onMigrationRequiredCount={setMigrationRequiredCount} onRequestAiaPrompt={onRequestAiaPrompt} />
      </div>
    );
  }

  return (
    <div className="view-stack">
      <section className="toolbar-card skill-mode-toolbar">
        {modeSwitch}
        <TranslationProgress enabled={translationEnabled} status={translations.data?.status ?? automation?.skills} error={translations.error} onRetry={() => { void retryMenuTranslation("skills").then(onAutomationChange); }} />
      </section>

      <section className="toolbar-card skill-library-toolbar">
        <div className="skill-library-titlebar">
          <div className="skill-library-summary">
            <strong>{text("설치된 스킬", "Installed skills")}</strong>
            <small>{text("공급자별로 감지한 SKILL.md 설치본입니다. 조회 전용이라 여기서는 바꾸지 않습니다.", "SKILL.md installs detected per provider. Read-only — nothing is changed here.")}</small>
          </div>
        </div>
        <div className="skill-library-toolbar-row">
          <div className="skill-sync-counts">
            {archivedInstalls > 0 && <span className="skill-sync-pill current">{text("보관", "Archived")} {archivedInstalls.toLocaleString()}</span>}
            <span className="toolbar-count">{hasActiveFilter
              ? text(`${filtered.length.toLocaleString()} / ${skills.length.toLocaleString()}개`, `${filtered.length.toLocaleString()} / ${skills.length.toLocaleString()} skills`)
              : text(`${filtered.length.toLocaleString()}개`, `${filtered.length.toLocaleString()} skills`)}</span>
          </div>
          <input className="search-input" aria-label={text("스킬 검색", "Search skills")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text("스킬명·설명·출처 검색", "Search name, description, or source")} />
        </div>
      </section>

      <section className="toolbar-card skill-library-filterbar">
        <SkillFilterGroup
          label={text("구분", "Category")}
          groupLabel={text("스킬 구분 필터", "Skill category filter")}
          options={SKILL_GROUPS}
          value={filters.group}
          counts={groupCounts}
          name={(item) => groupName(item, locale === "ko" ? "ko" : "en")}
          onChange={(item) => setFilters((current) => ({ ...current, group: item }))}
        />
        <SkillFilterGroup
          label={text("태그", "Tag")}
          groupLabel={text("스킬 태그 필터", "Skill tag filter")}
          options={SKILL_TAGS}
          value={filters.tag}
          counts={tagCounts}
          name={(item) => scopeName(item, locale === "ko" ? "ko" : "en")}
          onChange={(item) => setFilters((current) => ({ ...current, tag: item }))}
        />
      </section>

      {skippedRoots.length > 0 && (
        <div className="catalog-health-banner" role="status">
          <div>
            <strong>{text("일부 경로를 건너뛴 목록입니다", "Some paths were skipped")}</strong>
            <small>{skippedRoots.join(" · ")}</small>
          </div>
        </div>
      )}

      {claudeSettingsError && <ErrorBanner message={claudeSettingsError} />}

      {filtered.length === 0 ? (
        <EmptyState title={text("스킬을 찾지 못했습니다", "No skills found")} detail={text("로컬 SKILL.md 위치와 검색 조건을 확인하세요.", "Check local SKILL.md locations and your filters.")} />
      ) : (
        <section className="skill-library-list">
          {filtered.map((skill) => {
            const translated = translations.records.get(skill.id);
            const claudeState = claudeStatusForSkill(skill, claudeSettings, text);
            return (
              // 스킬관리와 같은 줄 카드 형태를 쓴다. 여기는 조회 전용이라 체크박스·사용 토글이 없다.
              <div className={`skill-library-item${claudeState?.off ? " skill-disabled" : ""}`} key={skill.id}>
                <div
                  className={`skill-library-row${skill.archived ? " is-shared" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(skill)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(skill);
                    }
                  }}
                >
                  <div className="skill-library-row-main">
                    <div className="skill-library-row-head">
                      <strong data-user-content>{translated?.fields.name ?? skill.name}</strong>
                      <span className="scope-pill">{scopeName(skill.scope, locale === "ko" ? "ko" : "en")}</span>
                      {skill.archived && <span className="skill-archived-pill">{text("보관", "Archived")}</span>}
                      {claudeState && <span className={`skill-state-pill${claudeState.off ? " off" : ""}`}>{claudeState.label}</span>}
                    </div>
                    <p data-user-content>{(translated?.fields.description ?? skill.description) || text("설명이 없습니다.", "No description.")}</p>
                    <code>{skill.path}</code>
                  </div>
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
          })}
        </section>
      )}

      {selected && <SkillDrawer skill={selected} translated={translations.records.get(selected.id)} automation={automation} claudeSettings={claudeSettings} onClaudeSettingsChange={setClaudeSettings} onAutomationChange={onAutomationChange} onClose={() => setSelected(null)} />}
    </div>
  );
}

function SkillDrawer({ skill, translated, automation, claudeSettings, onClaudeSettingsChange, onAutomationChange, onClose }: { skill: SkillSummary; translated?: TranslationSummary; automation: SystemAutomationSnapshot | null; claudeSettings: ClaudeSettingsSnapshot | null; onClaudeSettingsChange: (snapshot: ClaudeSettingsSnapshot) => void; onAutomationChange: (snapshot: SystemAutomationSnapshot) => void; onClose: () => void }) {
  const translationRevision = automation?.revision ?? 0;
  const { locale, text } = useI18n();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [translatedDetail, setTranslatedDetail] = useState<TranslatedDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intrinsicProject = projectPathFromSkill(skill);
  const [projects, setProjects] = useState<ProjectRegistryEntry[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(skill.scope === "project" ? intrinsicProject : null);
  const [settings, setSettings] = useState<ClaudeSettingsSnapshot | null>(claudeSettings);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  useEffect(() => {
    let active = true;
    Promise.all([getSkillDetail(skill.id), translated ? getTranslatedDetail("skills", skill.id) : Promise.resolve(null)])
      .then(([value, translatedValue]) => { if (active) { setDetail(value); setTranslatedDetail(translatedValue); } })
      .catch((cause: unknown) => active && setError(errorText(cause)));
    return () => { active = false; };
  }, [skill.id, translated, translationRevision]);
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
    if (!override || settingsBusy) return;
    setSettingsBusy(true);
    setError(null);
    try {
      const next = await setClaudeSkillOverride({
        overrideKey: override.overrideKey,
        scope: writeScope,
        projectPath: selectedProject ?? intrinsicProject,
        value,
      });
      setSettings(next);
      void getClaudeSettingsStates(null).then(onClaudeSettingsChange).catch(() => undefined);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSettingsBusy(false);
    }
  };
  return (
    <Drawer
      title={<><SourceBadge source={skill.source} /><span data-user-content>{translated?.fields.name ?? skill.name}</span>{skill.archived && <span className="skill-archived-pill">{text("보관", "Archived")}</span>}</>}
      actions={<TranslateResourceButton menu="skills" resourceId={skill.id} translated={Boolean(translated)} automation={automation} onAutomationChange={onAutomationChange} />}
      onClose={onClose}
    >
      {error && <ErrorBanner message={error} />}
      {!detail && !error ? <LoadingState label={text("SKILL.md를 읽고 있습니다", "Reading SKILL.md")} /> : detail && (
        <>
          <section className="detail-card meta-grid">
            <Info label={text("범위", "Scope")} value={scopeName(detail.skill.scope, locale === "ko" ? "ko" : "en")} />
            <Info label={text("출처", "Source")} value={detail.skill.origin ?? text("로컬", "Local")} />
            <Info label={text("파일", "File")} value={detail.skill.path} />
            <Info label={text("구성 파일", "Files")} value={`${countFiles(detail.files)}${text("개", "")}`} />
          </section>
          <section className="detail-card">
            <div className="section-title"><h3>{text("설명", "Description")}</h3></div>
            <p className="prose-copy" data-user-content>{(translatedDetail?.fields.description ?? translated?.fields.description ?? detail.skill.description) || text("설명이 없습니다.", "No description.")}</p>
          </section>
          {skill.source === "claude" && <ClaudeSkillSettings
            skill={skill}
            intrinsicProject={intrinsicProject}
            projects={projects}
            selectedProject={selectedProject}
            onProjectChange={setSelectedProject}
            override={override}
            explicit={explicit}
            canWrite={canWrite}
            busy={settingsBusy}
            onChange={(value) => { void setOverride(value); }}
          />}
          <section className="detail-card">
            <div className="section-title"><h3>SKILL.md</h3></div>
            <MarkdownPreview source={translatedDetail?.fields.body ?? detail.body} compact />
          </section>
          {translatedDetail?.fields.body && <details className="detail-card original-content"><summary>{text("원문 보기", "View original")}</summary><MarkdownPreview source={detail.body} compact /></details>}
          <section className="detail-card">
            <div className="section-title"><h3>파일</h3></div>
            <FileList nodes={detail.files} />
          </section>
        </>
      )}
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
          "플러그인 소속 스킬은 개별로 켜거나 끌 수 없습니다. 설정 → 플러그인에서 Claude Code 플러그인 전체를 변경하세요.",
          "Plugin skills cannot be toggled individually. Change the whole Claude Code plugin under Settings → Plugins.",
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
          {availableProjects.map((project) => <option value={project.path} key={project.path}>{text(`프로젝트 · ${project.name}`, `Project · ${project.name}`)}</option>)}
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

function claudeStatusForSkill(skill: SkillSummary, snapshot: ClaudeSettingsSnapshot | null, text: (ko: string, en: string) => string): { label: string; off: boolean } | null {
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
  const normalized = skill.directory.replace(/\\/g, "/");
  return plugins.find((plugin) => normalized.startsWith(`${plugin.installPath.replace(/\\/g, "/")}/skills/`))
    ?? plugins.find((plugin) => plugin.name === skill.origin)
    ?? null;
}

function projectPathFromSkill(skill: SkillSummary): string | null {
  if (skill.scope !== "project") return null;
  const normalized = skill.directory.replace(/\\/g, "/");
  const marker = "/.claude/skills/";
  const index = normalized.lastIndexOf(marker);
  return index > 0 ? normalized.slice(0, index) : null;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function overrideLabel(value: SkillOverrideValue, text: (ko: string, en: string) => string): string {
  if (value === "name-only") return text("이름만", "Name only");
  if (value === "user-invocable-only") return text("직접 호출만", "User invocation only");
  if (value === "off") return text("꺼짐", "Off");
  return text("사용", "On");
}

function scopeLabel(scope: ClaudeSkillOverrideState["decidedBy"], text: (ko: string, en: string) => string): string {
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

function matchesGroup(skill: SkillSummary, group: SkillGroupFilter): boolean {
  return group === "all" || skillGroup(skill) === group;
}

/** 스킬이 속한 구분. 아는 공급자면 그 공급자, 아니면 기타로 모아 목록에서 사라지지 않게 한다. */
function skillGroup(skill: SkillSummary): Exclude<SkillGroupFilter, "all"> {
  return SKILL_GROUPS.includes(skill.source as SkillGroupFilter) ? skill.source as Exclude<SkillGroupFilter, "all"> : "other";
}

function matchesTag(skill: SkillSummary, tag: SkillTagFilter): boolean {
  if (tag === "all") return true;
  return tag === "archived" ? skill.archived : skill.scope === tag;
}

function groupName(group: SkillGroupFilter, locale: "ko" | "en"): string {
  if (group === "all") return locale === "ko" ? "전체" : "All";
  if (group === "other") return locale === "ko" ? "기타" : "Other";
  return group === "antigravity" ? "Antigravity" : group[0].toUpperCase() + group.slice(1);
}

function scopeName(scope: string, locale: "ko" | "en" = "ko"): string {
  const labels = locale === "ko"
    ? { personal: "개인", project: "프로젝트", plugin: "플러그인", system: "시스템", builtin: "내장", archived: "보관", all: "모든 태그" }
    : { personal: "Personal", project: "Project", plugin: "Plugin", system: "System", builtin: "Built-in", archived: "Archived", all: "All tags" };
  return (labels as Record<string, string>)[scope] ?? scope;
}

function loadSkillFilters(): SkillFilters {
  // 구분의 뜻이 바뀌면 키를 올려서 예전 선택을 버린다. 알 수 없는 값은 전체로 되돌린다.
  const stored = readStoredJson(SKILL_FILTERS_KEY) as Partial<SkillFilters> | null;
  return {
    group: SKILL_GROUPS.includes(stored?.group as SkillGroupFilter) ? stored!.group as SkillGroupFilter : "all",
    tag: SKILL_TAGS.includes(stored?.tag as SkillTagFilter) ? stored!.tag as SkillTagFilter : "all",
  };
}

/**
 * 브라우저 저장소는 사생활 보호 모드나 정책 차단에서 읽기·쓰기 모두 예외를 던진다.
 * 화면 상태 기억은 실패해도 이번 실행에 영향이 없으므로, 네 자리에서 각자 두르던
 * try/catch를 읽기·쓰기 한 쌍으로 모은다.
 */
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 저장에 실패해도 현재 실행 중에는 선택이 그대로 유지된다.
  }
}

function readStoredJson(key: string): unknown {
  const raw = readStored(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadSkillMode(): SkillViewMode {
  return readStored(SKILL_MODE_KEY) === "library" ? "library" : "installed";
}

function saveSkillMode(mode: SkillViewMode): void {
  writeStored(SKILL_MODE_KEY, mode);
}

function saveSkillFilters(filters: SkillFilters): void {
  writeStored(SKILL_FILTERS_KEY, JSON.stringify(filters));
}

/**
 * 필터 한 축의 버튼 줄. 구분과 태그는 라벨·항목·이름 함수만 다르고 활성 표시·개수 배지·
 * "선택 중이 아니면서 0건이면 못 누른다" 규칙이 같다. 두 벌로 두면 한쪽만 고쳐진다.
 */
function SkillFilterGroup<V extends string>({ label, groupLabel, options, value, counts, name, onChange }: {
  label: string;
  groupLabel: string;
  options: readonly V[];
  value: V;
  counts: Record<V, number>;
  name: (item: V) => string;
  onChange: (item: V) => void;
}) {
  return (
    <div className="skill-filter-group">
      <span className="skill-filter-label">{label}</span>
      <div className="source-tabs" role="group" aria-label={groupLabel}>
        {options.map((item) => (
          <button
            className={value === item ? "active" : ""}
            type="button"
            key={item}
            aria-pressed={value === item}
            disabled={item !== "all" && counts[item] === 0 && value !== item}
            onClick={() => onChange(item)}
          >
            {name(item)}<small>{counts[item].toLocaleString()}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong className="mono" title={value}>{value}</strong></div>;
}
