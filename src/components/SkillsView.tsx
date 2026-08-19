import { useEffect, useMemo, useState } from "react";
import { Folder } from "lucide-react";
import { getSkillDetail, getTranslatedDetail, retryMenuTranslation } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { useMenuTranslations } from "../lib/translations";
import type { SkillDetail, SkillSummary, SystemAutomationSnapshot, TranslatedDetail, TranslationSummary } from "../types";
import { MarkdownPreview } from "./MarkdownPreview";
import { Drawer, EmptyState, ErrorBanner, LoadingState, SourceBadge } from "./Shared";
import { TranslationProgress } from "./TranslationProgress";

const SKILL_FILTERS_KEY = "agent-manager.skill-filters.v1";
const SKILL_SOURCES = ["all", "claude", "codex", "antigravity"] as const;
const SKILL_SCOPES = [
  { value: "all", label: "모든 태그" },
  { value: "personal", label: "개인" },
  { value: "project", label: "프로젝트" },
  { value: "plugin", label: "플러그인" },
  { value: "system", label: "시스템" },
  { value: "builtin", label: "내장" },
] as const;

type SkillSourceFilter = (typeof SKILL_SOURCES)[number];
type SkillScopeFilter = (typeof SKILL_SCOPES)[number]["value"];

interface SkillFilters {
  source: SkillSourceFilter;
  scope: SkillScopeFilter;
}

export function SkillsView({ skills, automation, onAutomationChange }: { skills: SkillSummary[]; automation: SystemAutomationSnapshot | null; onAutomationChange: (snapshot: SystemAutomationSnapshot) => void }) {
  const { locale, text } = useI18n();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SkillFilters>(loadSkillFilters);
  const [selected, setSelected] = useState<SkillSummary | null>(null);
  const translations = useMenuTranslations("skills", automation?.revision ?? 0);
  const translationEnabled = Boolean(automation?.settings.translations.skills);

  useEffect(() => {
    saveSkillFilters(filters);
  }, [filters]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (filters.source !== "all" && skill.source !== filters.source) return false;
      if (filters.scope !== "all" && skill.scope !== filters.scope) return false;
      if (!needle) return true;
      const translated = translations.records.get(skill.id)?.fields;
      return [skill.name, skill.description, translated?.name, translated?.description, skill.origin, skill.path]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [skills, filters, query, translations.records]);

  const hasActiveFilter = filters.source !== "all" || filters.scope !== "all" || Boolean(query.trim());

  return (
    <div className="view-stack">
      <section className="toolbar-card skill-toolbar">
        <TranslationProgress enabled={translationEnabled} status={translations.data?.status ?? automation?.skills} error={translations.error} onRetry={() => { void retryMenuTranslation("skills").then(onAutomationChange); }} />
        <div className="skill-filter-group">
          <span className="skill-filter-label">{text("공급자", "Provider")}</span>
          <div className="source-tabs" role="group" aria-label="스킬 공급자 필터">
            {SKILL_SOURCES.map((item) => (
              <button className={filters.source === item ? "active" : ""} type="button" key={item} aria-pressed={filters.source === item} onClick={() => setFilters((current) => ({ ...current, source: item }))}>
                {item === "all" ? text("전체", "All") : item === "antigravity" ? "Antigravity" : item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="skill-filter-group">
          <span className="skill-filter-label">{text("태그", "Tag")}</span>
          <div className="scope-tabs" role="group" aria-label="스킬 태그 필터">
            {SKILL_SCOPES.map((item) => (
              <button className={filters.scope === item.value ? "active" : ""} type="button" key={item.value} aria-pressed={filters.scope === item.value} onClick={() => setFilters((current) => ({ ...current, scope: item.value }))}>
                {locale === "ko" ? item.label : scopeName(item.value, "en")}
              </button>
            ))}
          </div>
        </div>
        <input className="search-input wide" aria-label={text("스킬 검색", "Search skills")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text("스킬명·설명·출처 검색", "Search name, description, or source")} />
        <span className="toolbar-count">{hasActiveFilter ? `${filtered.length.toLocaleString()} / ${skills.length.toLocaleString()}개` : `${filtered.length.toLocaleString()}개`}</span>
      </section>

      {filtered.length === 0 ? (
        <EmptyState title={text("스킬을 찾지 못했습니다", "No skills found")} detail={text("로컬 SKILL.md 위치와 검색 조건을 확인하세요.", "Check local SKILL.md locations and your filters.")} />
      ) : (
        <section className="card-grid skill-grid">
          {filtered.map((skill) => {
            const translated = translationEnabled ? translations.records.get(skill.id) : undefined;
            return (
            <button className="entity-card" type="button" key={skill.id} onClick={() => setSelected(skill)}>
              <div className="entity-card-head"><SourceBadge source={skill.source} /><span className="scope-pill">{scopeName(skill.scope, locale === "ko" ? "ko" : "en")}</span></div>
              <strong>{translated?.fields.name ?? skill.name}</strong>
              <p>{(translated?.fields.description ?? skill.description) || text("설명이 없습니다.", "No description.")}</p>
              <footer><span>{skill.origin ?? text("로컬", "Local")}</span><code>{skill.path}</code></footer>
            </button>
          );})}
        </section>
      )}

      {selected && <SkillDrawer skill={selected} translated={translationEnabled ? translations.records.get(selected.id) : undefined} translationRevision={automation?.revision ?? 0} onClose={() => setSelected(null)} />}
    </div>
  );
}

function SkillDrawer({ skill, translated, translationRevision, onClose }: { skill: SkillSummary; translated?: TranslationSummary; translationRevision: number; onClose: () => void }) {
  const { locale, text } = useI18n();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [translatedDetail, setTranslatedDetail] = useState<TranslatedDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([getSkillDetail(skill.id), translated ? getTranslatedDetail("skills", skill.id) : Promise.resolve(null)])
      .then(([value, translatedValue]) => { if (active) { setDetail(value); setTranslatedDetail(translatedValue); } })
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { active = false; };
  }, [skill.id, translated, translationRevision]);
  return (
    <Drawer title={<><SourceBadge source={skill.source} /><span data-user-content>{translated?.fields.name ?? skill.name}</span></>} onClose={onClose}>
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

function FileList({ nodes, depth = 0 }: { nodes: SkillDetail["files"]; depth?: number }) {
  return <div className="file-list">{nodes.map((node) => <div key={node.relativePath}><div className="file-row" style={{ paddingLeft: `${depth * 14}px` }}><span>{node.isDirectory ? <Folder size={11} /> : "·"}</span><code>{node.name}</code></div>{node.isDirectory && <FileList nodes={node.children} depth={depth + 1} />}</div>)}</div>;
}

function countFiles(nodes: SkillDetail["files"]): number {
  return nodes.reduce((total, node) => total + (node.isDirectory ? countFiles(node.children) : 1), 0);
}

function scopeName(scope: string, locale: "ko" | "en" = "ko"): string {
  const labels = locale === "ko"
    ? { personal: "개인", project: "프로젝트", plugin: "플러그인", system: "시스템", builtin: "내장", all: "모든 태그" }
    : { personal: "Personal", project: "Project", plugin: "Plugin", system: "System", builtin: "Built-in", all: "All tags" };
  return (labels as Record<string, string>)[scope] ?? scope;
}

function loadSkillFilters(): SkillFilters {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SKILL_FILTERS_KEY) ?? "null") as Partial<SkillFilters> | null;
    const source = stored?.source;
    const scope = stored?.scope;
    return {
      source: SKILL_SOURCES.includes(source as SkillSourceFilter) ? source as SkillSourceFilter : "all",
      scope: SKILL_SCOPES.some((item) => item.value === scope) ? scope as SkillScopeFilter : "all",
    };
  } catch {
    return { source: "all", scope: "all" };
  }
}

function saveSkillFilters(filters: SkillFilters): void {
  try {
    window.localStorage.setItem(SKILL_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // 저장에 실패해도 현재 실행 중에는 선택한 필터가 유지된다.
  }
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong className="mono" title={value}>{value}</strong></div>;
}
