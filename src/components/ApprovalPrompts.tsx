/**
 * 승인 카드 한 벌. 에이전트가 멈춰 서서 사용자의 응답을 기다리는 자리(권한 확인, 계획
 * 검토, 되물은 질문)를 모두 이 모듈이 그린다. 채팅 화면·세션 상세·AIA 팝업이 같은 카드를
 * 쓰므로, 공용 UI 모음(Shared.tsx) 안에 두면 한 화면의 사정으로 고친 것이 나머지 두
 * 화면까지 흔든다 — 공용 UI가 아니라 하나의 주제로 묶어 여기에 둔다.
 */
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Maximize2 } from "lucide-react";
import { MarkdownPreview } from "./MarkdownPreview";
import { Modal } from "./Shared";
import type { ChatApprovalDecision, ChatApprovalQuestion } from "../types";
import { useI18n } from "../lib/i18n";

import { runtimeCatalogText } from "../lib/i18nRuntime";
export interface ChatApprovalPrompt {
  id: string;
  /**
   * `plan`이면 계획 문서를 읽고 실행 여부를 고르는 카드, `question`이면 에이전트가
   * 되물은 질문에 답하는 카드다. 그 밖에는 권한 확인 카드.
   */
  kind: string;
  title: string;
  detail: string;
  options: ChatApprovalDecision[];
  interactive: boolean;
  resolved: ChatApprovalDecision | null;
  /** `kind`가 `question`일 때 고를 질문지. */
  questions: ChatApprovalQuestion[];
  /** 답을 보낸 뒤 백엔드가 되돌려 준 "실제로 전달된 답"(질문 원문 -> 답). */
  answers: Record<string, string>;
  /**
   * 사용자가 고른 것이 아니라 앱이 카드를 닫았을 때(승인 시간 초과) 그 사정. 있으면
   * 결정 문구 대신 이 줄을 남긴다 — 답하지 못한 사이 사라진 카드를 사용자가 자신이
   * 취소한 것으로 읽으면 안 된다.
   */
  note: string;
  /**
   * C9-19. 원격 sudo 비밀번호를 함께 받아야 하는 카드인지. 입력한 값은 `answers`가 아니라
   * 별도 통로로 나간다 — `answers`는 카드에 그대로 되비쳐 그려지므로 비밀값을 실을 수 없다.
   */
  needsSecret: boolean;
}

export type ChatApprovalDecider = (id: string, decision: ChatApprovalDecision, answers?: Record<string, string>, secret?: string, saveSecret?: boolean) => void;

/**
 * 승인 카드를 모아 두는 채팅 하단 독. 계획 검토처럼 본문이 긴 카드가 대화를 가려
 * 읽을 수 없다는 문제가 있어, 헤더에서 통째로 접었다 펼 수 있게 한다. 접힌 동안에도
 * 무엇이 기다리는지 알 수 있도록 카드 제목을 한 줄 요약으로 남긴다.
 */
export function ChatApprovalDock({ className = "chat-approval-dock", label, title, hint, prompts, onDecision }: {
  className?: string;
  label?: string;
  title: string;
  hint: string;
  prompts: ChatApprovalPrompt[];
  onDecision: ChatApprovalDecider;
}) {
  const { text } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const ids = prompts.map((prompt) => prompt.id).join("|");
  // 새 요청이 도착하면 접힌 상태를 풀어, 접어 둔 채로 승인 대기를 놓치지 않게 한다.
  useEffect(() => { setCollapsed(false); }, [ids]);
  if (prompts.length === 0) return null;
  return (
    <div
      className={`${className}${collapsed ? " approval-dock-collapsed" : ""}`}
      aria-label={label ?? text("응답을 기다리는 권한 요청", "Permission requests awaiting a response")}
    >
      <header>
        <div className="approval-dock-heading"><strong>{title}</strong><span>{hint}</span></div>
        <button
          className="approval-dock-toggle"
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? "펼치기" : "접기"}
          {prompts.length > 1 && <em>{text(`${prompts.length}건`, `${prompts.length} items`)}</em>}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </header>
      {collapsed
        ? <p className="approval-dock-summary">{prompts.map((prompt) => runtimeCatalogText(prompt.title)).join(" · ")}</p>
        : prompts.map((prompt) => <ChatApprovalCard prompt={prompt} onDecision={onDecision} key={prompt.id} />)}
    </div>
  );
}

export function ChatApprovalCard({ prompt, onDecision }: { prompt: ChatApprovalPrompt; onDecision: ChatApprovalDecider }) {
  const { text } = useI18n();
  // 계획 검토는 승인할 권한이 아니라 읽어야 할 문서라, 요청 JSON 대신 계획 본문을 그대로 그린다.
  const plan = prompt.kind === "plan";
  // 질문지가 비어 있으면(리플레이 버퍼가 잘려 재구성된 카드) 고를 것이 없으므로 일반 카드로 둔다.
  const questions = prompt.kind === "question" ? prompt.questions : [];
  // 고른 선택지는 라벨 목록으로 들고 있다가 보낼 때만 한 줄로 잇는다. 이어 붙인 문자열을
  // 상태로 두면 라벨에 콤마가 든 선택지("예, 그대로 둡니다")를 다시 갈라낼 수 없어, 고른
  // 선택지가 골라지지 않은 것처럼 보였다.
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  // C9-19. sudo 비밀번호. 카드가 사라지면 함께 사라지고, 어떤 이벤트에도 되비치지 않는다.
  const [secret, setSecret] = useState("");
  // C17. 이 값을 기기 보관으로도 옮길지. 저장은 값이 들어오는 이 순간에만 할 수 있어서
  // 체크박스가 입력칸 옆에 있다 — 값은 어디에도 남지 않으므로 나중에 따라갈 수 없다.
  const [saveSecret, setSaveSecret] = useState(false);
  // 좁은 독 안에서는 계획을 몇 줄씩만 볼 수 있어, 큰 창으로 따로 띄워 읽고 그 자리에서 고른다.
  const [reading, setReading] = useState(false);
  // 아직 고를 수 있는 카드인지. 승인 버튼을 그릴지와 결과 문구를 그릴지가 이 하나로 갈린다.
  const pending = prompt.interactive && !prompt.resolved;
  const decide: ChatApprovalDecider = (id, decision, picked, typed, save) => {
    setReading(false);
    // 보낸 즉시 비운다. 카드가 화면에 남아 있어도 입력칸에 값이 머무르지 않는다.
    setSecret("");
    setSaveSecret(false);
    onDecision(id, decision, picked, typed, save);
  };
  const handlePick = (question: string, labels: string[]) => {
    setPicks((current) => ({ ...current, [question]: labels }));
  };
  const actions = pending
    ? <ChatApprovalActions prompt={prompt} questions={questions} picks={picks} secret={secret} saveSecret={saveSecret} onDecide={decide} />
    : null;
  return (
    <article className={`chat-approval${pending ? " chat-approval-pending" : ""}`} role={pending ? "alert" : undefined}>
      <header className="chat-approval-head">
        <strong>{runtimeCatalogText(prompt.title)}</strong>
        {plan && prompt.detail && (
          <button className="chat-approval-expand" type="button" onClick={() => setReading(true)}>
            <Maximize2 size={13} aria-hidden="true" />크게 보기
          </button>
        )}
      </header>
      <ChatApprovalBody prompt={prompt} plan={plan} questions={questions} picks={picks} onPick={handlePick} />
      {pending && prompt.needsSecret && <ChatApprovalSecretField
        kind={prompt.kind}
        value={secret}
        onChange={setSecret}
        save={saveSecret}
        onSaveChange={setSaveSecret}
      />}
      {prompt.resolved ? (
        <span className="chat-approval-result">{prompt.note || approvalDecisionLabel(prompt.resolved, prompt.kind, text, Object.keys(prompt.answers).length > 0)}</span>
      ) : actions ? (
        <div>{actions}</div>
      ) : (
        <p>실행 정책에 의해 이미 거절된 권한 기록입니다. 현재 승인을 기다리고 있지 않습니다.</p>
      )}
      {/* 본문이 긴 카드는 어디에 있든(채팅 독·AIA 팝업) 화면 맨 위 레이어에 띄워야 가려지지 않는다. */}
      {reading && createPortal(
        <Modal
          title={runtimeCatalogText(prompt.title)}
          size="wide"
          elevated
          onClose={() => setReading(false)}
          footer={actions && <div className="chat-approval-modal-actions">{actions}</div>}
        >
          <div className="chat-approval-reader"><MarkdownPreview source={prompt.detail} /></div>
        </Modal>,
        document.body,
      )}
    </article>
  );
}

/**
 * 카드 아래(와 크게 보기 창 바닥)의 응답 버튼 줄. 질문지가 있는 카드는 답을 보내는 두
 * 갈래, 그 밖은 공급자가 제시한 선택지만 그린다.
 */
function ChatApprovalActions({ prompt, questions, picks, secret, saveSecret, onDecide }: {
  prompt: ChatApprovalPrompt;
  questions: ChatApprovalQuestion[];
  picks: Record<string, string[]>;
  secret: string;
  saveSecret: boolean;
  onDecide: ChatApprovalDecider;
}) {
  const { text } = useI18n();
  const offered = new Set(prompt.options);
  const label = approvalKindText(prompt.kind, text);
  const answered = questions.filter((question) => (picks[question.question] ?? []).length > 0).length;
  // C9-19. 비밀번호를 요구한 카드는 값 없이 허용해도 원격이 프롬프트에서 멈춘다. 누르기
  // 전에 막아, 사용자가 "허용했는데 아무 일도 없다"를 겪지 않게 한다. 거절은 그대로 된다.
  const secretMissing = prompt.needsSecret && secret.length === 0;
  return (
    <>
      {questions.length > 0 ? (
        <>
          <button className="button primary" type="button" disabled={answered === 0} onClick={() => onDecide(prompt.id, "accept", joinedAnswers(picks))}>답변 보내기</button>
          {/* 답을 비운 허용도 유효한 응답이다. 에이전트는 "답하지 않았다"를 받고 스스로 판단해 넘어간다. */}
          <button className="button" type="button" onClick={() => onDecide(prompt.id, "accept")}>답변 없이 진행</button>
        </>
      ) : (
        <>
          {offered.has("accept") && <button className="button primary" type="button" disabled={secretMissing} onClick={() => onDecide(prompt.id, "accept", undefined, prompt.needsSecret ? secret : undefined, saveSecret)}>{label.accept}</button>}
          {offered.has("acceptForSession") && <button className="button" type="button" onClick={() => onDecide(prompt.id, "acceptForSession")}>{label.acceptForSession}</button>}
          {offered.has("acceptAll") && <button className="button" type="button" title={label.acceptAllHint} onClick={() => onDecide(prompt.id, "acceptAll")}>{label.acceptAll}</button>}
          {offered.has("decline") && <button className="button danger-subtle" type="button" onClick={() => onDecide(prompt.id, "decline")}>{label.decline}</button>}
        </>
      )}
      {offered.has("cancel") && <button className="button danger-subtle" type="button" onClick={() => onDecide(prompt.id, "cancel")}>작업 취소</button>}
    </>
  );
}

/**
 * C9-19. 비밀값 입력칸. 값은 이 카드의 지역 상태로만 살고, 보내는 즉시 비워진다.
 * 무엇에 쓰이고 언제 사라지는지를 칸 아래 한 줄로 적는다 — 사용자가 값이 어디로 가는지
 * 알고 입력해야 한다. `sshCommand`는 원격 sudo 비밀번호를, `secretRequest`는 에이전트가
 * 이름으로 요청한 채팅 비밀값을 받는다. 통로는 같고 문구만 다르다.
 */
function ChatApprovalSecretField({ kind, value, onChange, save, onSaveChange }: {
  kind: string;
  value: string;
  onChange: (value: string) => void;
  save: boolean;
  onSaveChange: (save: boolean) => void;
}) {
  const { text } = useI18n();
  const secretRequest = kind === "secretRequest";
  return (
  <>
    <label className="chat-approval-secret">
      <span>{secretRequest ? text("비밀값", "Secret value") : text("sudo 비밀번호", "sudo password")}</span>
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={secretRequest ? text("에이전트가 요청한 값", "The value the agent asked for") : text("원격 계정의 비밀번호", "Password for the remote account")}
        onChange={(event) => onChange(event.target.value)}
      />
      <em>{secretRequest ? text(
        "에이전트에게 전달되지 않습니다. 앱이 대신 실행할 때만 주입해 쓰고, 저장하지 않으면 이 대화가 끝날 때 사라집니다.",
        "It is never passed to the agent. The app injects it only when running on your behalf, and unless you save it, it disappears when this chat ends.",
      ) : text(
        "저장되지 않고 에이전트에게 전달되지 않습니다. 이 대화에서 이 서버에만 잠시 쓰입니다.",
        "It is never stored or passed to the agent. It is used briefly, only in this chat and only for this server.",
      )}</em>
    </label>
    {/* C17. 보관은 값이 들어오는 이 순간에만 고를 수 있다 — 값은 어디에도 남지 않으므로
        카드가 닫힌 뒤에는 따라갈 수 없다. sudo 비밀번호 카드에는 보관이 없다. 입력칸
        라벨 안에 넣지 않는 것은, 라벨 안의 라벨이 올바른 HTML이 아니고 그 글이 모두
        비밀번호 칸의 이름으로 읽히기 때문이다. */}
    {secretRequest && <label className="chat-approval-secret-save">
      <input type="checkbox" checked={save} onChange={(event) => onSaveChange(event.target.checked)} />
      <span>{text("비밀값 저장", "Save this secret")}</span>
      <em>{text(
        "기기에 남겨 다음 대화에서도 이 이름으로 씁니다. 값은 OS 보안 저장소에 들어가고, 저장소 → 비밀정보에서 언제든 지울 수 있습니다.",
        "Keep it on this device and reuse it by this name in later chats. The value goes to the OS secure store and can be deleted any time in Storage → Secrets.",
      )}</em>
    </label>}
  </>
  );
}

/**
 * 승인 카드 종류별 문구. 버튼 세 개와 결과 문장이 모두 `kind` 하나를 축으로 갈리므로 한
 * 표에 모은다. C9-17. SSH 승인은 "이번 1회 실행"과 "영구 추가"가 서로 다른 결정이라 별도
 * 요청·별도 승인으로 갈라져 있는데, 두 카드의 문구가 같으면 사용자는 클릭하는 자리에서도
 * 기록에서도 그 차이를 읽을 수 없다.
 */
interface ApprovalKindText {
  /** 허용 버튼 */
  accept: string;
  /** 세션 동안 허용 버튼 */
  acceptForSession: string;
  /** 전체 허용(정책 제외) 버튼. 계획 검토 카드만 제시한다. */
  acceptAll: string;
  /** 전체 허용 버튼에 마우스를 올리면 보이는 설명 — 무엇은 묻고 무엇은 지나가는지. */
  acceptAllHint: string;
  /** 거절 버튼 */
  decline: string;
  /** 허용한 뒤 카드에 남는 문장 */
  accepted: string;
  /** 거절한 뒤 카드에 남는 문장 */
  declined: string;
}

/**
 * 표의 한 줄. 지금 언어를 고르는 손잡이를 받아 문구를 만든다 — 표가 컴포넌트 밖에 서 있어
 * `text`를 미리 부를 수 없고, 짝을 자료로만 적어 두면 번역 카탈로그가 소스에서 거두지
 * 못한다(카탈로그는 `text(ko, en)` 호출만 읽는다).
 */
type ApprovalTextSpec = (text: (ko: string, en: string) => string) => Partial<ApprovalKindText>;

const APPROVAL_TEXT_DEFAULT = (text: (ko: string, en: string) => string): ApprovalKindText => ({
  accept: text("이번만 허용", "Allow once"),
  acceptForSession: text("세션 동안 허용", "Allow for session"),
  acceptAll: text("전체 허용(정책 제외)", "Allow all except decisions"),
  acceptAllHint: text("계획 변경과 질문만 묻고 나머지 권한 요청은 자동 승인합니다. 도구별 제한은 그대로 적용됩니다.", "Only plan changes and questions are asked; every other permission request is approved automatically. Per-tool restrictions still apply."),
  decline: text("거절", "Decline"),
  accepted: text("이번 요청을 허용했습니다", "Allowed this request"),
  declined: text("요청을 거절했습니다", "Declined this request"),
});

/** 기본 문구와 다른 칸만 적는다. 빠진 칸은 기본 문구를 그대로 쓴다. */
const APPROVAL_TEXT_BY_KIND: Record<string, ApprovalTextSpec> = {
  plan: (text) => ({
    accept: text("계획대로 실행", "Run this plan"),
    // 계획 승인의 "세션 동안 허용"은 편집 자동 승인이다. 승인하면 CLI는 계획 모드를
    // 빠져나가지만 편집 권한은 그대로라 파일마다 다시 묻는데, 이 버튼이 그것을 끈다.
    acceptForSession: text("계획대로 실행 + 편집 자동 승인", "Run this plan and auto-approve edits"),
    // 편집 자동 승인만으로는 명령·조회 도구가 계획 실행 내내 카드로 올라온다. 이 버튼은
    // 사용자 판단이 필요한 계획 변경·질문만 남기고 나머지를 앱이 승인하게 한다.
    acceptAll: text("계획대로 실행 + 전체 허용(정책 제외)", "Run this plan and allow all except decisions"),
    decline: text("계획 다시 세우기", "Revise the plan"),
    accepted: text("계획대로 실행했습니다", "Approved and ran this plan"),
    declined: text("계획을 다시 세우도록 돌려보냈습니다", "Sent back for a revised plan"),
  }),
  sshCommand: (text) => ({
    accept: text("이번 1회만 실행 허용", "Allow this one run"),
    accepted: text("이 명령을 1회만 실행하도록 허용했습니다", "Allowed this command to run once"),
  }),
  sshAllowlist: (text) => ({
    accept: text("허용 목록에 영구 추가", "Add to the allowlist permanently"),
    accepted: text("허용 명령 목록에 영구히 추가하도록 허용했습니다", "Allowed adding this command to the allowlist permanently"),
  }),
  // 에이전트가 이름을 대고 비밀값을 요청한 카드. 값은 `secret` 통로로만 나가고 카드에 남지 않는다.
  secretRequest: (text) => ({
    accept: text("값 보내기", "Send value"),
    decline: text("거절", "Decline"),
    accepted: text("값을 보냈습니다", "Sent the value"),
    declined: text("값 요청을 거절했습니다", "Declined the value request"),
  }),
};

function approvalKindText(kind: string, text: (ko: string, en: string) => string): ApprovalKindText {
  return { ...APPROVAL_TEXT_DEFAULT(text), ...APPROVAL_TEXT_BY_KIND[kind]?.(text) };
}

/** 카드 본문. 질문지·계획 문서·요청 원문 세 갈래 중 하나만 그린다. */
function ChatApprovalBody({ prompt, plan, questions, picks, onPick }: {
  prompt: ChatApprovalPrompt;
  plan: boolean;
  questions: ChatApprovalQuestion[];
  picks: Record<string, string[]>;
  onPick: (question: string, labels: string[]) => void;
}) {
  if (questions.length > 0) {
    // 답을 보낸 뒤에는 질문만 남기지 않고 무엇을 골라 보냈는지 그대로 남긴다.
    if (prompt.resolved) return <ChatApprovalAnswerList questions={questions} answers={prompt.answers} />;
    return (
      <section className="chat-approval-questions">
        {questions.map((question) => (
          <ChatApprovalQuestionField
            key={question.question}
            question={question}
            answer={picks[question.question] ?? EMPTY_PICKS}
            onAnswer={(labels) => onPick(question.question, labels)}
          />
        ))}
      </section>
    );
  }
  if (!prompt.detail) return null;
  if (plan) return <section className="chat-approval-document"><MarkdownPreview source={prompt.detail} compact /></section>;
  return <pre>{prompt.detail}</pre>;
}

/** 아직 아무것도 고르지 않은 질문의 답. 매 렌더에 새 배열을 만들지 않도록 하나만 둔다. */
const EMPTY_PICKS: string[] = [];

/** 고른 선택지를 CLI가 읽는 한 줄 답으로 잇는다. 비어 있는 질문은 답하지 않은 것으로 둔다. */
function joinedAnswers(picks: Record<string, string[]>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(picks)
      .filter(([, labels]) => labels.length > 0)
      .map(([question, labels]) => [question, labels.join(", ")]),
  );
}

function ChatApprovalQuestionField({ question, answer, onAnswer }: { question: ChatApprovalQuestion; answer: string[]; onAnswer: (labels: string[]) => void }) {
  const name = useId();
  const [custom, setCustom] = useState("");
  const [customPicked, setCustomPicked] = useState(false);
  // 답 목록에서 선택지 라벨과 직접 입력한 글을 갈라 본다. 라벨을 그대로 맞춰 보므로
  // 콤마가 든 라벨도 고른 그대로 표시된다.
  const optionLabels = answer.filter((label) => question.options.some((option) => option.label === label));
  const picked = new Set(optionLabels);
  const commit = (labels: string[], customText: string, useCustom: boolean) => {
    const parts = [...labels];
    if (useCustom && customText.trim()) parts.push(customText.trim());
    onAnswer(parts);
  };
  const toggle = (label: string) => {
    if (!question.multiSelect) {
      setCustomPicked(false);
      commit([label], custom, false);
      return;
    }
    commit(picked.has(label) ? optionLabels.filter((current) => current !== label) : [...optionLabels, label], custom, customPicked);
  };
  const pickCustom = (text: string) => {
    setCustom(text);
    setCustomPicked(true);
    commit(question.multiSelect ? optionLabels : [], text, true);
  };
  // 여러 개를 고르는 질문에서는 직접 입력도 되돌릴 수 있어야 한다. 라디오는 하나를
  // 고르는 자리라 다시 눌러도 그대로 둔다.
  const toggleCustom = () => {
    if (question.multiSelect && customPicked) {
      setCustomPicked(false);
      commit(optionLabels, custom, false);
      return;
    }
    pickCustom(custom);
  };
  return (
    <div className="chat-approval-question" role="group" aria-labelledby={`${name}-label`}>
      <p id={`${name}-label`}>{question.header && <em>{question.header}</em>}<span>{question.question}</span></p>
      {question.options.map((option) => (
        <label key={option.label}>
          <input
            type={question.multiSelect ? "checkbox" : "radio"}
            name={name}
            checked={picked.has(option.label)}
            onChange={() => toggle(option.label)}
          />
          <span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>
        </label>
      ))}
      <label className="chat-approval-question-custom">
        <input
          type={question.multiSelect ? "checkbox" : "radio"}
          name={name}
          checked={customPicked}
          onChange={toggleCustom}
        />
        <span>
          <b>직접 입력</b>
          <input type="text" value={custom} placeholder="선택지에 없는 답을 적으세요" onChange={(event) => pickCustom(event.target.value)} />
        </span>
      </label>
    </div>
  );
}

/** 답을 보낸 뒤의 질문 카드. 물어본 질문 옆에 실제로 전달된 답을 남긴다. */
function ChatApprovalAnswerList({ questions, answers }: { questions: ChatApprovalQuestion[]; answers: Record<string, string> }) {
  return (
    <section className="chat-approval-answers">
      {questions.map((question) => (
        <div key={question.question}>
          <p>{question.header && <em>{question.header}</em>}<span>{question.question}</span></p>
          {answers[question.question]
            ? <strong>{answers[question.question]}</strong>
            : <small>답하지 않고 진행했습니다</small>}
        </div>
      ))}
    </section>
  );
}

function approvalDecisionLabel(
  decision: ChatApprovalDecision,
  kind: string,
  text: (ko: string, en: string) => string,
  answered = false,
): string {
  // 질문 카드의 허용 결과만 문구가 답을 보냈는지로 갈려 표에 담기지 않는다.
  if (decision === "accept" && kind === "question") {
    return answered
      ? text("답변을 보냈습니다", "Answers sent")
      : text("답변 없이 진행했습니다", "Continued without answering");
  }
  const label = approvalKindText(kind, text);
  if (decision === "accept") return label.accepted;
  if (decision === "acceptForSession") return text("이 세션 동안 허용했습니다", "Allowed for this session");
  if (decision === "acceptAll") return text("계획대로 실행하고 나머지 권한을 자동 승인합니다", "Approved this plan; remaining permissions are auto-approved");
  if (decision === "decline") return label.declined;
  return text("작업을 취소했습니다", "Cancelled this work");
}
