import { useEffect, useState, useSyncExternalStore } from "react";
import { getAgentBuiltinTools } from "../lib/ipc";
import { builtinToolsRevision, subscribeBuiltinTools } from "../lib/builtinToolsSignal";
import { useI18n } from "../lib/i18n";
import type { AgentBuiltinToolNote, AgentBuiltinToolsCatalog } from "../types";
import { sourceName } from "../lib/format";

/**
 * 애드온 화면이 도구 축으로 서므로 카드마다 "이 도구를 어느 에이전트가 어떤 경로로 쓰는가"가
 * 필요하다. 그 표는 백엔드의 기본도구 카탈로그가 이미 계산해 두므로 화면이 다시 적지 않는다 —
 * 여기서 문구를 따로 박으면 에이전트가 늘 때 화면만 낡는다.
 *
 * 카드 본문이 무거워지지 않게 접힌 상세로 두고, 펼칠 때가 아니라 마운트할 때 한 번 읽는다.
 * 읽기에 실패하면 상세를 아예 그리지 않는다 — 도구 카드 자체의 조작은 이 표와 무관하다.
 */
export function BuiltinToolAccess({ toolId, active }: { toolId: string; active: boolean }) {
  const { text } = useI18n();
  const [catalog, setCatalog] = useState<AgentBuiltinToolsCatalog | null>(null);
  // 같은 패널의 도구 카드가 사용 상태를 바꾸면 이 표도 낡는다. 패널 활성화(`active`)만
  // 보고 있으면 탭을 다녀오기 전까지 스위치와 다른 말을 한다(QA #95).
  const revision = useSyncExternalStore(subscribeBuiltinTools, builtinToolsRevision, builtinToolsRevision);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await getAgentBuiltinTools();
        if (!cancelled) setCatalog(next);
      } catch { /* 접근 경로를 못 읽어도 도구 카드는 그대로 쓸 수 있다. */ }
    })();
    return () => { cancelled = true; };
  }, [active, revision]);

  const definition = catalog?.tools.find((tool) => tool.id === toolId);
  const rows = (catalog?.agents ?? []).flatMap((agentView) => {
    const view = agentView.tools.find((tool) => tool.id === toolId);
    return view ? [{ agent: agentView.agent, view }] : [];
  });
  if (!definition || rows.length === 0) return null;

  return (
    <details className="builtin-tool-access" data-ui-anchor={`addons.${toolId}.access`}>
      <summary>{text("상세 내용 · 어느 에이전트가 어떤 경로로 쓰는지", "Details · which agent uses it through which route")}</summary>
      <ul>
        {rows.map(({ agent, view }) => (
          <li key={agent}>
            <strong>{agentLabel(agent, text)}</strong>
            <span className="builtin-tool-route">{accessLabel(view.accessMethod, text)}</span>
            {view.accessMethod !== "none" && !view.available && (
              <em className="builtin-tool-badge off">{view.enabled ? text("쓸 수 없음", "Unavailable") : text("꺼짐", "Off")}</em>
            )}
            {view.enablementRequiresNewChat && (
              <em className="builtin-tool-badge notice">{text("켠 뒤 새 채팅 필요", "Needs a new chat after enabling")}</em>
            )}
            <small>{noteLabel(view.note, text)}</small>
          </li>
        ))}
      </ul>
      <p className="builtin-tool-operations">
        {/* QA #64 — 경로가 셋이어도 작업 집합이 같으면 같은 이름이 세 번 반복돼 10개가 30개로
            보였다. 이 줄이 답하는 것은 "이 도구가 무엇을 해 주는가"이므로 합집합을 한 번씩만 적는다.
            경로별 차이는 위 표가 이미 말한다. */}
        {text("제공 작업", "Operations")}:{" "}
        {[...new Set(definition.routes.flatMap((route) => route.operations))].join(" · ")}
      </p>
    </details>
  );
}

function agentLabel(agent: string, text: (ko: string, en: string) => string): string {
  switch (agent) {
    case "aia": return "AIA";
    case "claude": return text("클로드", "Claude");
    case "codex": return text("코덱스", "Codex");
    case "antigravity": return text("안티그라비티", "Antigravity");
    // 브랜드 이름 하나뿐이라 두 말이 같다. 빠뜨리면 식별자 "local"이 그대로 보인다.
    case "local": return sourceName("local");
    default: return agent;
  }
}

/**
 * 백엔드가 갈래와 수치로만 내려준 상태를 화면 언어로 조립한다. QA #69 — 예전에는 백엔드가
 * 한국어 문장을 만들어 내려, 영어 UI에서 이 줄만 한국어로 남았다.
 */
function noteLabel(note: AgentBuiltinToolNote, text: (ko: string, en: string) => string): string {
  switch (note.kind) {
    case "sshEndpoints":
      return text(
        `사용 가능한 연결 서버 ${note.available}개, 켰지만 사용할 수 없는 서버 ${note.unusable}개`,
        `${note.available} usable server(s), ${note.unusable} enabled but unusable`,
      );
    case "dbConnections":
      return text(
        `사용 가능한 연결 ${note.available}개, 켰지만 사용할 수 없는 연결 ${note.unusable}개`,
        `${note.available} usable connection(s), ${note.unusable} enabled but unusable`,
      );
    case "cypressEnabled":
      return text("설정에서 사용 중", "Turned on in settings");
    case "cypressDisabled":
      return text("애드온 → Cypress에서 사용을 켜야 함", "Turn it on in Add-ons → Cypress");
    case "mcpExternalConfig": {
      const registered = note.registered.length
        ? text(
            `CLI 전역 설정에 등록된 플러그인 ${note.registered.length}개: ${note.registered.join(", ")}`,
            `${note.registered.length} plugin(s) registered in the CLI's global config: ${note.registered.join(", ")}`,
          )
        : text(
            "CLI 전역 설정에 등록된 플러그인 없음",
            "No plugin is registered in the CLI's global config",
          );
      const missing = note.missing.length
        ? text(
            `. 앱에서는 쓸 수 있지만 아직 등록되지 않음: ${note.missing.join(", ")}`,
            `. Usable in the app but not registered yet: ${note.missing.join(", ")}`,
          )
        : "";
      return `${registered}${missing}${pendingLabel(note.pending, text)}`;
    }
    case "mcpNone":
      return text(
        `붙는 플러그인 없음${pendingLabel(note.pending, text)}. 애드온 → 외부 MCP에서 등록`,
        `No plugin attaches${pendingLabel(note.pending, text)}. Register one in Add-ons → External MCP`,
      );
    case "mcpAttached":
      return text(
        `붙는 플러그인 ${note.names.length}개: ${note.names.join(", ")}${pendingLabel(note.pending, text)}`,
        `${note.names.length} plugin(s) attached: ${note.names.join(", ")}${pendingLabel(note.pending, text)}`,
      );
    case "mermaid":
      return text(
        "답변·문서의 ```mermaid 펜스를 앱이 그림으로 그림. 그릴 수 없는 원문은 코드 상자로 남음",
        "The app renders ```mermaid fences in replies and documents; sources it cannot draw stay as code blocks",
      );
    default:
      return "";
  }
}

function pendingLabel(pending: number, text: (ko: string, en: string) => string): string {
  if (pending === 0) return "";
  return text(`, 인증을 기다리는 플러그인 ${pending}개`, `, ${pending} awaiting authentication`);
}

/** 백엔드가 내려주는 접근 방식 id를 사람이 읽는 말로 옮긴다. 모르는 값은 그대로 보인다. */
function accessLabel(method: string, text: (ko: string, en: string) => string): string {
  switch (method) {
    case "aiaSystem": return text("AIA 시스템 도구", "AIA system tools");
    case "directMcp": return text("채팅에 직접 붙는 MCP", "MCP attached to the chat");
    case "externalMcpConfig":
      return text("CLI 전역 설정에 등록한 MCP", "MCP registered in the CLI's global config");
    case "systemSkillCli": return text("시스템 스킬 · CLI", "System skill · CLI");
    case "systemSkillHttp": return text("시스템 스킬 · HTTP", "System skill · HTTP");
    case "appRender": return text("앱 화면이 그림", "Rendered by the app");
    case "none": return text("붙지 않음", "Not attached");
    default: return method;
  }
}
