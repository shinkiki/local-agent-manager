import { useState } from "react";
import { getAgentDetail } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { AgentDefinition, CatalogHealth, SystemAutomationSnapshot, TranslationSummary } from "../types";
import { Drawer, EmptyState } from "./Shared";
import { DetailInfo, DrawerBody, OriginalContent, useDrawerDetail } from "./DetailDrawer";
import { MenuSearchToolbar, matchesNeedle, useMenuSearch } from "./SkillLibraryPanel";
import { TranslateResourceButton } from "./TranslationProgress";
import { displayPath } from "../lib/displayPath";
import { CatalogHealthBanner } from "./CatalogHealthBanner";

export function AgentsView({ agents, automation, onAutomationChange, catalogHealth = null }: { agents: AgentDefinition[]; automation: SystemAutomationSnapshot | null; onAutomationChange: (snapshot: SystemAutomationSnapshot) => void; catalogHealth?: CatalogHealth | null }) {
  const { text } = useI18n();
  const [selected, setSelected] = useState<AgentDefinition | null>(null);
  const { query, setQuery, needle, filtered, translations } = useMenuSearch("agents", automation, onAutomationChange, agents, matchesAgent);
  return (
    <div className="view-stack">
      <MenuSearchToolbar
        progress={translations.progress}
        query={query}
        onQueryChange={setQuery}
        placeholder={text("에이전트명·설명·도구 검색", "Search agent, description, or tool")}
      >
        {/* 한 문장으로 짓는다. "agents"만 따로 된 글자 마디로 두면 정적 대응표가 그 마디를
            "에이전트"로 되짚었다가 메뉴 이름("Agents")으로 다시 옮겨 대문자로 바뀐다. */}
        {text(
          `Claude 에이전트 ${filtered.length.toLocaleString()}개`,
          `Claude agents ${filtered.length.toLocaleString()}`,
        )}
      </MenuSearchToolbar>
      <CatalogHealthBanner health={catalogHealth} kind="agents" />
      {filtered.length === 0 ? (
        // 원본이 0건인 것과 검색으로 좁혀 0건이 된 것은 다른 상황이다. 검색어가 있으면 탐지 경로 안내가
        // 아니라 검색어를 지우는 되돌림 길을 알리고, 전체 개수를 함께 적어 정의가 사라진 게 아님을 보인다.
        needle && agents.length > 0
          ? <EmptyState title={text("검색 결과가 없습니다", "No matching agents")} detail={text(`검색어를 지우거나 다른 낱말로 찾아보세요. (전체 ${agents.length.toLocaleString()}개)`, `Clear the search or try another term. (${agents.length.toLocaleString()} total)`)} />
          : <EmptyState title={text("에이전트 정의가 없습니다", "No agent definitions")} detail={text("~/.claude/agents의 Markdown 정의를 탐지합니다.", "Markdown definitions are discovered from ~/.claude/agents.")} />
      ) : (
        <section className="card-grid agent-grid">
          {filtered.map((agent) => (
            <AgentCard
              agent={agent}
              translated={translations.records.get(agent.path)}
              onSelect={setSelected}
              key={agent.path}
            />
          ))}
        </section>
      )}
      {selected && <AgentDrawer agent={selected} translated={translations.records.get(selected.path)} automation={automation} onAutomationChange={onAutomationChange} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** 목록 카드의 번역 표시·메타데이터·선택 처리를 목록 필터와 분리한다. */
function AgentCard({ agent, translated, onSelect }: {
  agent: AgentDefinition;
  translated?: TranslationSummary;
  onSelect: (agent: AgentDefinition) => void;
}) {
  const { text } = useI18n();
  return (
    <button className="entity-card agent-card" type="button" onClick={() => onSelect(agent)}>
      <div className="agent-avatar">A</div>
      <strong data-user-content>{translated?.fields.name ?? agent.name}</strong>
      <p data-user-content>{(translated?.fields.description ?? agent.description) || text("설명이 없습니다.", "No description.")}</p>
      <div className="chip-row">
        {agent.model && <span>{agent.model}</span>}
        {agent.tools.slice(0, 4).map((tool) => <span key={tool}>{tool}</span>)}
      </div>
      <footer><code>{displayPath(agent.path)}</code></footer>
    </button>
  );
}

function AgentDrawer({ agent, translated, automation, onAutomationChange, onClose }: { agent: AgentDefinition; translated?: TranslationSummary; automation: SystemAutomationSnapshot | null; onAutomationChange: (snapshot: SystemAutomationSnapshot) => void; onClose: () => void }) {
  const { text } = useI18n();
  const { detail, translatedDetail, error } = useDrawerDetail({
    menu: "agents",
    resourceId: agent.path,
    detailKey: agent.name,
    translated,
    translationRevision: automation?.revision ?? 0,
    load: () => getAgentDetail(agent.name),
  });

  return (
    <Drawer
      title={<><span className="agent-avatar small">A</span><span data-user-content>{translated?.fields.name ?? agent.name}</span></>}
      actions={<TranslateResourceButton menu="agents" resourceId={agent.path} translated={Boolean(translated)} automation={automation} onAutomationChange={onAutomationChange} />}
      onClose={onClose}
    >
      <DrawerBody detail={detail} error={error} loadingLabel={text("에이전트 정의를 읽고 있습니다", "Reading agent definition")}>
        {(detail) => (
          <>
            <section className="detail-card definition-list">
              <DetailInfo label={text("설명", "Description")} value={(translatedDetail?.fields.description ?? translated?.fields.description ?? detail.definition.description) || "–"} userContent />
              <DetailInfo label={text("모델", "Model")} value={detail.definition.model ?? text("상속", "Inherited")} />
              <DetailInfo label={text("최대 턴", "Max turns")} value={detail.definition.maxTurns?.toString() ?? "–"} />
              <DetailInfo label={text("권한 모드", "Permission mode")} value={detail.definition.permissionMode ?? text("기본", "Default")} />
              <DetailInfo label={text("도구", "Tools")} value={detail.definition.tools.join(", ") || text("전체", "All")} />
              <DetailInfo label={text("스킬", "Skills")} value={detail.definition.skills.join(", ") || "–"} />
              <DetailInfo label={text("파일", "File")} value={displayPath(detail.definition.path)} mono />
            </section>
            <section className="detail-card"><div className="section-title"><h3>{text("시스템 프롬프트", "System prompt")}</h3></div><pre className="markdown-source">{(translatedDetail?.fields.body ?? detail.body) || text("(본문 없음)", "(No content)")}</pre></section>
            {translatedDetail?.fields.body && <OriginalContent card><pre className="markdown-source">{detail.body}</pre></OriginalContent>}
          </>
        )}
      </DrawerBody>
    </Drawer>
  );
}

/** 에이전트 정의의 이름·설명·모델·도구·스킬과 번역 결과가 검색어에 맞는지 검사한다. */
function matchesAgent(agent: AgentDefinition, needle: string, translations: Map<string, TranslationSummary>): boolean {
  const translated = translations.get(agent.path)?.fields;
  return matchesNeedle([
    agent.name,
    agent.description,
    translated?.name,
    translated?.description,
    agent.model,
    ...agent.tools,
    ...agent.skills,
  ], needle);
}
