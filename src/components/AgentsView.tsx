import { useEffect, useState } from "react";
import { getAgentDetail, getTranslatedDetail, retryMenuTranslation } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { useMenuTranslations } from "../lib/translations";
import type { AgentDefinition, AgentDetail, SystemAutomationSnapshot, TranslatedDetail, TranslationSummary } from "../types";
import { Drawer, EmptyState, ErrorBanner, LoadingState } from "./Shared";
import { TranslationProgress } from "./TranslationProgress";

export function AgentsView({ agents, automation, onAutomationChange }: { agents: AgentDefinition[]; automation: SystemAutomationSnapshot | null; onAutomationChange: (snapshot: SystemAutomationSnapshot) => void }) {
  const { text } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<AgentDefinition | null>(null);
  const translations = useMenuTranslations("agents", automation?.revision ?? 0);
  const translationEnabled = Boolean(automation?.settings.translations.agents);
  const needle = query.trim().toLowerCase();
  const filtered = agents.filter((agent) => {
    const translated = translations.records.get(agent.path)?.fields;
    return !needle || [agent.name, agent.description, translated?.name, translated?.description, agent.model, ...agent.tools, ...agent.skills].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle));
  });
  return (
    <div className="view-stack">
      <section className="toolbar-card">
        <TranslationProgress enabled={translationEnabled} status={translations.data?.status ?? automation?.agents} error={translations.error} onRetry={() => { void retryMenuTranslation("agents").then(onAutomationChange); }} />
        <input className="search-input wide" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text("에이전트명·설명·도구 검색", "Search agent, description, or tool")} />
        <span className="toolbar-count">Claude {text("에이전트", "agents")} {filtered.length.toLocaleString()}{text("개", "")}</span>
      </section>
      {filtered.length === 0 ? <EmptyState title={text("에이전트 정의가 없습니다", "No agent definitions")} detail={text("~/.claude/agents의 Markdown 정의를 탐지합니다.", "Markdown definitions are discovered from ~/.claude/agents.")} /> : (
        <section className="card-grid agent-grid">
          {filtered.map((agent) => {
            const translated = translationEnabled ? translations.records.get(agent.path) : undefined;
            return (
            <button className="entity-card agent-card" type="button" key={agent.path} onClick={() => setSelected(agent)}>
              <div className="agent-avatar">A</div>
              <strong>{translated?.fields.name ?? agent.name}</strong>
              <p>{(translated?.fields.description ?? agent.description) || text("설명이 없습니다.", "No description.")}</p>
              <div className="chip-row">{agent.model && <span>{agent.model}</span>}{agent.tools.slice(0, 4).map((tool) => <span key={tool}>{tool}</span>)}</div>
              <footer><code>{agent.path}</code></footer>
            </button>
          );})}
        </section>
      )}
      {selected && <AgentDrawer agent={selected} translated={translationEnabled ? translations.records.get(selected.path) : undefined} translationRevision={automation?.revision ?? 0} onClose={() => setSelected(null)} />}
    </div>
  );
}

function AgentDrawer({ agent, translated, translationRevision, onClose }: { agent: AgentDefinition; translated?: TranslationSummary; translationRevision: number; onClose: () => void }) {
  const { text } = useI18n();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [translatedDetail, setTranslatedDetail] = useState<TranslatedDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([getAgentDetail(agent.name), translated ? getTranslatedDetail("agents", agent.path) : Promise.resolve(null)])
      .then(([value, translatedValue]) => { if (active) { setDetail(value); setTranslatedDetail(translatedValue); } })
      .catch((cause: unknown) => active && setError(cause instanceof Error ? cause.message : String(cause)));
    return () => { active = false; };
  }, [agent.name, agent.path, translated, translationRevision]);
  return (
    <Drawer title={<><span className="agent-avatar small">A</span><span data-user-content>{translated?.fields.name ?? agent.name}</span></>} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      {!detail && !error ? <LoadingState label={text("에이전트 정의를 읽고 있습니다", "Reading agent definition")} /> : detail && (
        <>
          <section className="detail-card definition-list">
            <Info label={text("설명", "Description")} value={(translatedDetail?.fields.description ?? translated?.fields.description ?? detail.definition.description) || "–"} userContent />
            <Info label={text("모델", "Model")} value={detail.definition.model ?? text("상속", "Inherited")} />
            <Info label={text("최대 턴", "Max turns")} value={detail.definition.maxTurns?.toString() ?? "–"} />
            <Info label={text("권한 모드", "Permission mode")} value={detail.definition.permissionMode ?? text("기본", "Default")} />
            <Info label={text("도구", "Tools")} value={detail.definition.tools.join(", ") || text("전체", "All")} />
            <Info label={text("스킬", "Skills")} value={detail.definition.skills.join(", ") || "–"} />
            <Info label={text("파일", "File")} value={detail.definition.path} mono />
          </section>
          <section className="detail-card"><div className="section-title"><h3>{text("시스템 프롬프트", "System prompt")}</h3></div><pre className="markdown-source">{(translatedDetail?.fields.body ?? detail.body) || text("(본문 없음)", "(No content)")}</pre></section>
          {translatedDetail?.fields.body && <details className="detail-card original-content"><summary>{text("원문 보기", "View original")}</summary><pre className="markdown-source">{detail.body}</pre></details>}
        </>
      )}
    </Drawer>
  );
}

function Info({ label, value, mono = false, userContent = false }: { label: string; value: string; mono?: boolean; userContent?: boolean }) {
  return <div><span>{label}</span><strong className={mono ? "mono" : ""} data-user-content={userContent || undefined}>{value}</strong></div>;
}
