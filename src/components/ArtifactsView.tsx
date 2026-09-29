import { useState } from "react";
import { FileText } from "lucide-react";
import { getArtifactDetail } from "../lib/ipc";
import { formatBytes, formatRelative } from "../lib/format";
import { useI18n, type UiText } from "../lib/i18n";
import { artifactGroupTranslationId, artifactTranslationId } from "../lib/translations";
import type { ArtifactDetail, ArtifactGroup, ArtifactSummary, CatalogHealth, SystemAutomationSnapshot, TranslatedDetail, TranslationSummary } from "../types";
import { MarkdownPreview } from "./MarkdownPreview";
import { Drawer, EmptyState } from "./Shared";
import { DetailInfo, DrawerBody, OriginalContent, useDrawerDetail } from "./DetailDrawer";
import { MenuSearchToolbar, matchesNeedle, useMenuSearch } from "./SkillLibraryPanel";
import { TranslateResourceButton } from "./TranslationProgress";
import { CatalogHealthBanner } from "./CatalogHealthBanner";

export interface ArtifactsViewProps {
  groups: ArtifactGroup[];
  automation: SystemAutomationSnapshot | null;
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void;
  catalogHealth?: CatalogHealth | null;
}

export function ArtifactsView({ groups, automation, onAutomationChange, catalogHealth = null }: ArtifactsViewProps) {
  const { text } = useI18n();
  const [selected, setSelected] = useState<ArtifactSummary | null>(null);
  const { query, setQuery, filtered, translations } = useMenuSearch("artifacts", automation, onAutomationChange, groups, matchesArtifactGroup);
  return (
    <div className="view-stack">
      <MenuSearchToolbar
        progress={translations.progress}
        query={query}
        onQueryChange={setQuery}
        placeholder={text("대화 제목·아티팩트·요약 검색", "Search conversation, artifact, or summary")}
      >
        Antigravity {text("대화", "conversations")} {filtered.length.toLocaleString()}{text("개", "")}
      </MenuSearchToolbar>
      <CatalogHealthBanner health={catalogHealth} kind="artifacts" />
      {filtered.length === 0 ? <EmptyState title={text("아티팩트가 없습니다", "No artifacts")} detail={text("Antigravity brain 폴더의 작업 목록·계획·워크스루를 탐지합니다.", "Tasks, plans, and walkthroughs are discovered from Antigravity brain folders.")} /> : (
        <section className="artifact-groups">
          {filtered.map((group) => <ArtifactGroupCard group={group} translations={translations.records} key={`${group.rootName}:${group.conversationId}`} onSelect={setSelected} />)}
        </section>
      )}
      {selected && <ArtifactDrawer artifact={selected} translated={translations.records.get(artifactResourceId(selected))} automation={automation} onAutomationChange={onAutomationChange} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** 아티팩트 그룹과 하위 아티팩트들의 제목·요약·ID가 검색어에 맞는지 검사한다. */
function matchesArtifactGroup(group: ArtifactGroup, needle: string, translations: Map<string, TranslationSummary>): boolean {
  const groupFields = translations.get(artifactGroupResourceId(group))?.fields;
  if (matchesNeedle([group.title, groupFields?.title, group.conversationId], needle)) {
    return true;
  }
  return group.artifacts.some((artifact) => {
    const fields = translations.get(artifactResourceId(artifact))?.fields;
    return matchesNeedle([artifact.name, artifact.summary, fields?.summary], needle);
  });
}

interface ArtifactGroupCardProps {
  group: ArtifactGroup;
  translations: Map<string, TranslationSummary>;
  onSelect: (artifact: ArtifactSummary) => void;
}

function ArtifactGroupCard({ group, translations, onSelect }: ArtifactGroupCardProps) {
  const { text } = useI18n();
  const latest = latestArtifactTimestamp(group.artifacts);
  const translatedGroup = translations.get(artifactGroupResourceId(group));
  const title = groupCardTitle(group, translatedGroup, text);
  return (
    <article className="panel artifact-group">
      <header>
        <div><span className="ag-mark">A</span><div><strong data-user-content>{title}</strong><code>{group.conversationId}</code></div></div>
        <div className="artifact-meta"><span data-user-content>{group.rootName}</span>{!group.readable && <span>{text("본문 잠김", "Content locked")}</span>}{latest > 0 && <time>{formatRelative(latest)}</time>}</div>
      </header>
      <div className="artifact-list">
        {group.artifacts.map((artifact) => (
          <ArtifactRow
            artifact={artifact}
            translated={translations.get(artifactResourceId(artifact))}
            onSelect={onSelect}
            key={artifact.name}
          />
        ))}
        {group.imageCount > 0 && <div className="image-count">{text("이미지", "Images")} {group.imageCount}{text("개", "")}</div>}
      </div>
    </article>
  );
}

/** 아티팩트 그룹 목록에서 가장 최근 수정 시각을 구한다. */
function latestArtifactTimestamp(artifacts: readonly ArtifactSummary[]): number {
  return artifacts.reduce((max, artifact) => Math.max(max, artifact.updatedAt ?? 0), 0);
}

/** 그룹 카드의 제목을 번역본·지정 제목·기본 대화 ID 순으로 결정한다. */
function groupCardTitle(group: ArtifactGroup, translatedGroup: TranslationSummary | undefined, text: UiText): string {
  return translatedGroup?.fields.title ?? group.title ?? `${text("(제목 없음)", "(Untitled)")} ${group.conversationId.slice(0, 8)}`;
}

interface ArtifactRowProps {
  artifact: ArtifactSummary;
  translated?: TranslationSummary;
  onSelect: (artifact: ArtifactSummary) => void;
}

/** 그룹 카드 안의 아티팩트 한 줄. 번역·파일 메타데이터·선택 처리를 그룹 뼈대와 분리한다. */
function ArtifactRow({ artifact, translated, onSelect }: ArtifactRowProps) {
  const { text } = useI18n();
  return (
    <button type="button" onClick={() => onSelect(artifact)}>
      <span className="file-icon"><FileText size={14} /></span>
      <div><strong>{artifactTypeName(artifact.artifactType, artifact.name, text)}</strong><p data-user-content>{translated?.fields.summary ?? artifact.summary ?? artifact.name}</p></div>
      <div className="artifact-file-meta"><span>{formatBytes(artifact.sizeBytes)}</span>{artifact.versions.length > 0 && <span>{text("버전", "Versions")} {artifact.versions.length}</span>}</div>
    </button>
  );
}

interface ArtifactDrawerProps {
  artifact: ArtifactSummary;
  translated?: TranslationSummary;
  automation: SystemAutomationSnapshot | null;
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void;
  onClose: () => void;
}

function ArtifactDrawer({ artifact, translated, automation, onAutomationChange, onClose }: ArtifactDrawerProps) {
  const { text } = useI18n();
  const resourceId = artifactResourceId(artifact);
  const { detail, translatedDetail, error } = useDrawerDetail({
    menu: "artifacts",
    resourceId,
    translated,
    translationRevision: automation?.revision ?? 0,
    load: () => getArtifactDetail(artifact.conversationId, artifact.rootName, artifact.name),
  });

  return (
    <Drawer
      title={<span data-user-content>{artifactTypeName(artifact.artifactType, artifact.name, text)}</span>}
      actions={(
        <TranslateResourceButton
          menu="artifacts"
          resourceId={resourceId}
          alsoResourceIds={[artifactGroupResourceId(artifact)]}
          translated={Boolean(translated)}
          automation={automation}
          onAutomationChange={onAutomationChange}
        />
      )}
      onClose={onClose}
    >
      <DrawerBody detail={detail} error={error} loadingLabel={text("아티팩트를 읽고 있습니다", "Reading artifact")}>
        {(detail) => (
          <ArtifactDetailContent
            detail={detail}
            translatedDetail={translatedDetail}
            translated={translated}
          />
        )}
      </DrawerBody>
    </Drawer>
  );
}

interface ArtifactDetailContentProps {
  detail: ArtifactDetail;
  translatedDetail?: TranslatedDetail | null;
  translated?: TranslationSummary;
}

/** 아티팩트 드로어 본문. 메타 정보 격자·요약·마크다운/일반 텍스트 본문과 번역 대조를 조립한다. */
function ArtifactDetailContent({ detail, translatedDetail, translated }: ArtifactDetailContentProps) {
  const { text } = useI18n();
  const summary = translatedDetail?.fields.summary ?? translated?.fields.summary ?? detail.artifact.summary;
  const translatedBody = translatedDetail?.fields.body;

  return (
    <>
      <section className="detail-card meta-grid">
        <DetailInfo label={text("파일", "File")} value={detail.artifact.name} />
        <DetailInfo label={text("루트", "Root")} value={detail.artifact.rootName} />
        <DetailInfo label={text("크기", "Size")} value={formatBytes(detail.artifact.sizeBytes)} />
        <DetailInfo label={text("업데이트", "Updated")} value={formatRelative(detail.artifact.updatedAt)} />
      </section>
      {summary && (
        <section className="detail-card">
          <div className="section-title"><h3>{text("요약", "Summary")}</h3></div>
          <p className="prose-copy" data-user-content>{summary}</p>
        </section>
      )}
      <section className="detail-card">
        <div className="section-title"><h3>{text("내용", "Content")}</h3></div>
        <ArtifactBodyPreview name={detail.artifact.name} content={translatedBody ?? detail.content} />
      </section>
      {translatedBody && (
        <OriginalContent card>
          <ArtifactBodyPreview name={detail.artifact.name} content={detail.content} />
        </OriginalContent>
      )}
    </>
  );
}

/** 아티팩트 본문 미리보기. 마크다운 파일은 컴팩트 미리보기로, 그 외 텍스트는 원문 pre로 렌더링한다. */
function ArtifactBodyPreview({ name, content }: { name: string; content: string }) {
  if (isMarkdownArtifact(name)) {
    return <MarkdownPreview source={content} compact />;
  }
  return <pre className="markdown-source">{content}</pre>;
}

function isMarkdownArtifact(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

function artifactResourceId(artifact: Pick<ArtifactSummary, "rootName" | "conversationId" | "name">): string {
  return artifactTranslationId(artifact.rootName, artifact.conversationId, artifact.name);
}

function artifactGroupResourceId(group: Pick<ArtifactGroup, "rootName" | "conversationId">): string {
  return artifactGroupTranslationId(group.rootName, group.conversationId);
}

const artifactTypeLabels: Readonly<Record<string, readonly [ko: string, en: string]>> = {
  ARTIFACT_TYPE_TASK: ["작업 목록", "Task list"],
  ARTIFACT_TYPE_IMPLEMENTATION_PLAN: ["구현 계획", "Implementation plan"],
  ARTIFACT_TYPE_WALKTHROUGH: ["워크스루", "Walkthrough"],
};

function artifactTypeName(type: string | null, fallback: string, text: UiText): string {
  const label = type ? artifactTypeLabels[type] : undefined;
  if (label) return text(...label);
  return fallback.replace(/\.md$/i, "");
}
