import { useEffect, useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { getArtifactDetail, getTranslatedDetail, retryMenuTranslation } from "../lib/ipc";
import { formatBytes, formatRelative } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { artifactGroupTranslationId, artifactTranslationId, useMenuTranslations } from "../lib/translations";
import type { ArtifactDetail, ArtifactGroup, ArtifactSummary, SystemAutomationSnapshot, TranslatedDetail, TranslationSummary } from "../types";
import { MarkdownPreview } from "./MarkdownPreview";
import { Drawer, EmptyState, ErrorBanner, LoadingState } from "./Shared";
import { TranslationProgress } from "./TranslationProgress";

export function ArtifactsView({ groups, automation, onAutomationChange }: { groups: ArtifactGroup[]; automation: SystemAutomationSnapshot | null; onAutomationChange: (snapshot: SystemAutomationSnapshot) => void }) {
  const { text } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ArtifactSummary | null>(null);
  const translations = useMenuTranslations("artifacts", automation?.revision ?? 0);
  const translationEnabled = Boolean(automation?.settings.translations.artifacts);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups.filter((group) => {
      const groupFields = translations.records.get(artifactGroupTranslationId(group.rootName, group.conversationId))?.fields;
      return [group.title, groupFields?.title, group.conversationId, ...group.artifacts.flatMap((artifact) => {
        const fields = translations.records.get(artifactTranslationId(artifact.rootName, artifact.conversationId, artifact.name))?.fields;
        return [artifact.name, artifact.summary, fields?.summary];
      })].filter((value): value is string => Boolean(value)).some((value) => value.toLowerCase().includes(needle));
    });
  }, [groups, query, translations.records]);
  return (
    <div className="view-stack">
      <section className="toolbar-card">
        <TranslationProgress enabled={translationEnabled} status={translations.data?.status ?? automation?.artifacts} error={translations.error} onRetry={() => { void retryMenuTranslation("artifacts").then(onAutomationChange); }} />
        <input className="search-input wide" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text("대화 제목·아티팩트·요약 검색", "Search conversation, artifact, or summary")} />
        <span className="toolbar-count">Antigravity {text("대화", "conversations")} {filtered.length.toLocaleString()}{text("개", "")}</span>
      </section>
      {filtered.length === 0 ? <EmptyState title={text("아티팩트가 없습니다", "No artifacts")} detail={text("Antigravity brain 폴더의 작업 목록·계획·워크스루를 탐지합니다.", "Tasks, plans, and walkthroughs are discovered from Antigravity brain folders.")} /> : (
        <section className="artifact-groups">
          {filtered.map((group) => <ArtifactGroupCard group={group} translations={translationEnabled ? translations.records : new Map()} key={`${group.rootName}:${group.conversationId}`} onSelect={setSelected} />)}
        </section>
      )}
      {selected && <ArtifactDrawer artifact={selected} translated={translationEnabled ? translations.records.get(artifactTranslationId(selected.rootName, selected.conversationId, selected.name)) : undefined} translationRevision={automation?.revision ?? 0} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ArtifactGroupCard({ group, translations, onSelect }: { group: ArtifactGroup; translations: Map<string, TranslationSummary>; onSelect: (artifact: ArtifactSummary) => void }) {
  const { text } = useI18n();
  const latest = Math.max(0, ...group.artifacts.map((artifact) => artifact.updatedAt ?? 0));
  const translatedGroup = translations.get(artifactGroupTranslationId(group.rootName, group.conversationId));
  return (
    <article className="panel artifact-group">
      <header>
        <div><span className="ag-mark">A</span><div><strong>{translatedGroup?.fields.title ?? group.title ?? `${text("(제목 없음)", "(Untitled)")} ${group.conversationId.slice(0, 8)}`}</strong><code>{group.conversationId}</code></div></div>
        <div className="artifact-meta"><span>{group.rootName}</span>{!group.readable && <span>{text("본문 잠김", "Content locked")}</span>}{latest > 0 && <time>{formatRelative(latest)}</time>}</div>
      </header>
      <div className="artifact-list">
        {group.artifacts.map((artifact) => {
          const translated = translations.get(artifactTranslationId(artifact.rootName, artifact.conversationId, artifact.name));
          return (
          <button type="button" key={artifact.name} onClick={() => onSelect(artifact)}>
            <span className="file-icon"><FileText size={14} /></span>
            <div><strong>{artifactTypeName(artifact.artifactType, artifact.name, text)}</strong><p>{translated?.fields.summary ?? artifact.summary ?? artifact.name}</p></div>
            <div className="artifact-file-meta"><span>{formatBytes(artifact.sizeBytes)}</span>{artifact.versions.length > 0 && <span>{text("버전", "Versions")} {artifact.versions.length}</span>}</div>
          </button>
        );})}
        {group.imageCount > 0 && <div className="image-count">{text("이미지", "Images")} {group.imageCount}{text("개", "")}</div>}
      </div>
    </article>
  );
}

function ArtifactDrawer({ artifact, translated, translationRevision, onClose }: { artifact: ArtifactSummary; translated?: TranslationSummary; translationRevision: number; onClose: () => void }) {
  const { text } = useI18n();
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [translatedDetail, setTranslatedDetail] = useState<TranslatedDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([
      getArtifactDetail(artifact.conversationId, artifact.rootName, artifact.name),
      translated ? getTranslatedDetail("artifacts", artifactTranslationId(artifact.rootName, artifact.conversationId, artifact.name)) : Promise.resolve(null),
    ])
      .then(([value, translatedValue]) => { if (active) { setDetail(value); setTranslatedDetail(translatedValue); } })
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { active = false; };
  }, [artifact, translated, translationRevision]);
  return (
    <Drawer title={<span data-user-content>{artifactTypeName(artifact.artifactType, artifact.name, text)}</span>} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      {!detail && !error ? <LoadingState label={text("아티팩트를 읽고 있습니다", "Reading artifact")} /> : detail && (
        <>
          <section className="detail-card meta-grid">
            <Info label={text("파일", "File")} value={detail.artifact.name} />
            <Info label={text("루트", "Root")} value={detail.artifact.rootName} />
            <Info label={text("크기", "Size")} value={formatBytes(detail.artifact.sizeBytes)} />
            <Info label={text("업데이트", "Updated")} value={formatRelative(detail.artifact.updatedAt)} />
          </section>
          {(translatedDetail?.fields.summary || translated?.fields.summary || detail.artifact.summary) && <section className="detail-card"><div className="section-title"><h3>{text("요약", "Summary")}</h3></div><p className="prose-copy" data-user-content>{translatedDetail?.fields.summary ?? translated?.fields.summary ?? detail.artifact.summary}</p></section>}
          <section className="detail-card"><div className="section-title"><h3>{text("내용", "Content")}</h3></div>{isMarkdownArtifact(detail.artifact.name) ? <MarkdownPreview source={translatedDetail?.fields.body ?? detail.content} compact /> : <pre className="markdown-source">{translatedDetail?.fields.body ?? detail.content}</pre>}</section>
          {translatedDetail?.fields.body && <details className="detail-card original-content"><summary>{text("원문 보기", "View original")}</summary>{isMarkdownArtifact(detail.artifact.name) ? <MarkdownPreview source={detail.content} compact /> : <pre className="markdown-source">{detail.content}</pre>}</details>}
        </>
      )}
    </Drawer>
  );
}

function isMarkdownArtifact(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

function artifactTypeName(type: string | null, fallback: string, text: (ko: string, en: string) => string): string {
  if (type === "ARTIFACT_TYPE_TASK") return text("작업 목록", "Task list");
  if (type === "ARTIFACT_TYPE_IMPLEMENTATION_PLAN") return text("구현 계획", "Implementation plan");
  if (type === "ARTIFACT_TYPE_WALKTHROUGH") return text("워크스루", "Walkthrough");
  return fallback.replace(/\.md$/i, "");
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
