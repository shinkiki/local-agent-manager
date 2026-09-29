import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { DiagramViewer } from "./DiagramViewer";

/**
 * 앱이 그릴 수 있는 표기. 백엔드 기본도구 카탈로그의 `MERMAID_OPERATIONS`와 같은 목록이고,
 * 양쪽 다 "무엇을 적으면 그림이 되는지"를 알리는 것이 목적이라 한쪽만 늘리지 않는다.
 */
const DIAGRAM_KINDS = [
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "quadrantChart",
  "mindmap",
  "timeline",
  "gitGraph",
  "architecture-beta",
] as const;

const SAMPLE = `flowchart LR
  A[요청] --> B{승인?}
  B -- 예 --> C[실행]
  B -- 아니오 --> D[반려]
  C --> E[기록]`;

/** 타이핑 한 글자마다 엔진을 부르지 않는다. 반쯤 적힌 원문은 어차피 문법이 아니다. */
const PREVIEW_DELAY_MS = 400;

/**
 * 애드온의 Mermaid 탭. 다른 기본도구와 달리 등록·인증·토글이 없다 — 앱에
 * 들어 있는 그리기 엔진이라 언제나 켜져 있고, 이 화면은 "무엇이 붙어 있는지"를 보이고
 * 원문을 그 자리에서 그려 보는 자리다.
 */
export function MermaidPluginPanel({ active }: { active: boolean }) {
  const { text } = useI18n();
  const [draft, setDraft] = useState(SAMPLE);
  const [source, setSource] = useState(SAMPLE);

  useEffect(() => {
    const timer = window.setTimeout(() => setSource(draft), PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft]);

  return (
    <section className="settings-card mermaid-panel" data-ui-anchor="addons.mermaid-content">
      <header>
        <div>
          <span>{text("애드온", "Add-ons")}</span>
          <h2>{text("Mermaid 다이어그램", "Mermaid diagrams")}</h2>
        </div>
        <p>{text(
          "에이전트 답변과 문서에 적힌 mermaid 펜스를 앱이 그림으로 그립니다. 플로우·순서도·상태도처럼 글로 설명하기 어려운 구조를 그대로 보여 줄 때 씁니다.",
          "The app renders mermaid fences in agent answers and documents as diagrams — flows, sequences, and state charts that are hard to explain in prose.",
        )}</p>
      </header>
      <div className="settings-card-sections">
        <section className="settings-subsection">
          <header>
            <div>
              <strong>{text("앱에 내장되어 항상 켜져 있음", "Built into the app and always on")}</strong>
              <small>{text(
                "등록·인증·설치가 없어 켜고 끌 항목이 없습니다. Claude·Codex·Antigravity와 AIA가 모두 같은 표기를 쓰고, 그릴 수 없는 원문은 사라지지 않고 코드 상자로 남습니다.",
                "There is nothing to register, authorize, or install. Claude, Codex, Antigravity, and AIA all use the same syntax, and source that cannot be drawn stays visible as a code block.",
              )}</small>
              <small>{text(
                "다이어그램 라벨은 HTML이 아니라 SVG 글자로 그리고, 그림 안의 링크는 앱이 직접 엽니다 — 에이전트가 쓴 문자열이 화면 DOM에 HTML로 들어가지 않습니다.",
                "Labels are drawn as SVG text rather than HTML, and links inside a diagram are opened by the app, so agent-written strings never enter the DOM as HTML.",
              )}</small>
            </div>
            <span className="mermaid-state">{text("사용 중", "In use")}</span>
          </header>
        </section>

        <section className="settings-subsection">
          <header>
            <div>
              <strong>{text("그릴 수 있는 표기", "Supported diagram types")}</strong>
              <small>{text(
                "코드 펜스의 언어를 mermaid로 적고 첫 줄에 종류를 씁니다. architecture-beta의 아이콘도 함께 들어 있습니다.",
                "Mark the fence as mermaid and put the type on the first line. The icon pack for architecture-beta is bundled as well.",
              )}</small>
            </div>
          </header>
          <div className="mermaid-kinds">
            {DIAGRAM_KINDS.map((kind) => <code key={kind}>{kind}</code>)}
          </div>
        </section>

        <section className="settings-subsection">
          <header>
            <div>
              <strong>{text("미리보기", "Preview")}</strong>
              <small>{text(
                "원문을 고치면 그대로 그려 봅니다. 문법이 아니면 그림 대신 안내가 뜹니다.",
                "Edit the source and see it drawn. If it is not valid syntax, a note appears instead of a diagram.",
              )}</small>
            </div>
            <button className="button compact" type="button" disabled={draft === SAMPLE} onClick={() => setDraft(SAMPLE)}>
              {text("예제로 되돌리기", "Reset to sample")}
            </button>
          </header>
          <div className="mermaid-preview">
            <textarea
              aria-label={text("mermaid 원문", "Mermaid source")}
              spellCheck={false}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            {/* 숨은 패널에서는 엔진을 부르지 않는다(패널은 DOM에 남아 있다). */}
            {active ? <DiagramViewer source={source} fileName="mermaid-preview" /> : null}
          </div>
        </section>
      </div>
    </section>
  );
}
