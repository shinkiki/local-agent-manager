import { useEffect, useState } from "react";
import { ChevronDown, Puzzle } from "lucide-react";
import { getCommonSkillDetail, getSkillDetail, getSkillLibrary } from "../lib/ipc";
import { providerLabel } from "../lib/skillLibrary";
import { matchSkillLibraryEntry, skillUsageNamePreview, type SkillUsage } from "../lib/skillUsage";
import type { SkillLibrary } from "../types";
import { MarkdownPreview } from "./MarkdownPreview";
import { errorText } from "../lib/errorText";

/**
 * 이 턴에서 실행된 스킬을 대화 흐름의 별도 항목으로 보여준다. 작업 로그 안에 도구 호출
 * 하나로 묻히면 어떤 스킬이 걸렸는지 펼쳐 보기 전까지 알 수 없어, 스킬만 따로 세운다.
 * 항목을 누르면 SKILL.md 본문까지 확인할 수 있다.
 */
export function ChatSkillUsageCard({ usages }: { usages: readonly SkillUsage[] }) {
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  if (usages.length === 0) return null;
  return (
    <div className={`chat-skill-usage${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="chat-skill-usage-toggle"
        aria-expanded={expanded}
        title={expanded ? "사용 스킬 접기" : "사용 스킬 펼치기"}
        onClick={() => setExpanded((current) => !current)}
      >
        <Puzzle size={13} aria-hidden="true" />
        <strong>사용 스킬 {usages.length}개</strong>
        <em>{skillUsageNamePreview(usages)}</em>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {expanded && <ul className="chat-skill-usage-list">
        {usages.map((usage) => {
          const open = openId === usage.id;
          return <li key={usage.id}>
            <button
              type="button"
              className="chat-skill-usage-item"
              aria-expanded={open}
              title={open ? "스킬 내용 접기" : "스킬 내용 보기"}
              onClick={() => setOpenId(open ? null : usage.id)}
            >
              <span className={`chat-tool-state chat-tool-state-${usage.status}`} />
              <b>{usage.name}</b>
              <small>{usageSubtitle(usage)}</small>
              <ChevronDown size={13} aria-hidden="true" />
            </button>
            {open && <SkillUsageDetail usage={usage} />}
          </li>;
        })}
      </ul>}
    </div>
  );
}

function usageSubtitle(usage: SkillUsage): string {
  if (usage.args) return usage.args.replace(/\s+/g, " ");
  return usage.detection === "path" ? "SKILL.md를 직접 읽어 시작" : "함께 넘긴 지시 없음";
}

type SkillSource =
  | { state: "loading" }
  | { state: "ready"; origin: string; description: string; path: string; body: string }
  | { state: "missing" }
  | { state: "failed"; message: string };

function SkillUsageDetail({ usage }: { usage: SkillUsage }) {
  const source = useSkillSource(usage);
  return (
    <div className="chat-skill-usage-detail">
      {usage.args && <p className="chat-skill-usage-args">{usage.args}</p>}
      {source.state === "loading" && <small>스킬 내용을 읽고 있습니다…</small>}
      {source.state === "missing" && <small>이 기기의 스킬 목록에서 찾지 못했습니다. CLI 내장 스킬이거나 실행 뒤 삭제된 스킬입니다.</small>}
      {source.state === "failed" && <small role="alert">스킬 내용을 읽지 못했습니다: {source.message}</small>}
      {source.state === "ready" && <>
        <dl className="chat-skill-usage-meta">
          <div><dt>출처</dt><dd>{source.origin}</dd></div>
          {source.description && <div><dt>설명</dt><dd>{source.description}</dd></div>}
          {source.path && <div><dt>경로</dt><dd title={source.path}>{source.path}</dd></div>}
        </dl>
        {source.body
          ? <div className="chat-skill-usage-body"><MarkdownPreview source={source.body} compact /></div>
          : <small>SKILL.md 본문이 비어 있습니다.</small>}
      </>}
    </div>
  );
}

/**
 * 상세를 눌렀을 때만 읽는다. 트랜스크립트에는 CLI가 주입한 SKILL.md 본문이 그대로 남아
 * 있어 그것을 쓰고, 라이브 채팅에는 그 레코드가 오지 않으므로 스킬 목록에서 원본을 찾는다.
 */
function useSkillSource(usage: SkillUsage): SkillSource {
  const injectedBody = usage.body;
  const directory = usage.directory;
  const name = usage.name;
  const [source, setSource] = useState<SkillSource>(() => injectedBody
    ? { state: "ready", origin: "이 대화에 주입된 SKILL.md", description: "", path: directory, body: injectedBody }
    : { state: "loading" });

  useEffect(() => {
    if (injectedBody) {
      setSource({ state: "ready", origin: "이 대화에 주입된 SKILL.md", description: "", path: directory, body: injectedBody });
      return undefined;
    }
    let active = true;
    setSource({ state: "loading" });
    void loadSkillSource(name)
      .then((next) => { if (active) setSource(next); })
      .catch((cause: unknown) => {
        if (active) setSource({ state: "failed", message: errorText(cause) });
      });
    return () => { active = false; };
  }, [directory, injectedBody, name]);

  return source;
}

async function loadSkillSource(name: string): Promise<SkillSource> {
  const library = await loadSkillLibrary();
  const entry = matchSkillLibraryEntry(library.entries, name);
  if (!entry) return { state: "missing" };
  if (entry.common) {
    const detail = await getCommonSkillDetail(entry.key);
    return {
      state: "ready",
      origin: "공통 스킬 원본",
      description: detail.source.description,
      path: detail.source.path,
      body: detail.body,
    };
  }
  const install = entry.providers.find((provider) => provider.skillId);
  if (!install?.skillId) return { state: "missing" };
  const detail = await getSkillDetail(install.skillId);
  return {
    state: "ready",
    origin: `${providerLabel(install.provider)} 스킬`,
    description: detail.skill.description,
    path: detail.skill.path,
    body: detail.body,
  };
}

/**
 * 스킬 목록은 파일시스템을 훑는 호출이라 상세를 열 때마다 다시 읽지 않는다. 실패한 약속은
 * 버려 다음 클릭이 새로 시도하게 한다.
 */
let libraryPromise: Promise<SkillLibrary> | null = null;

function loadSkillLibrary(): Promise<SkillLibrary> {
  libraryPromise ??= getSkillLibrary().catch((cause: unknown) => {
    libraryPromise = null;
    throw cause;
  });
  return libraryPromise;
}
