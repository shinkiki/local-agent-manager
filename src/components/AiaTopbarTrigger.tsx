/**
 * 상단바의 AIA 트리거 한 벌 — 버튼 문구·강조 클래스, 옆에 붙는 대화 미리보기 말풍선,
 * 강조가 풀릴 때 바늘 회전을 되감는 마무리까지다.
 *
 * App 본문에 상태 하나·ref 하나·파생값 여섯·효과 하나·콜백 둘과 JSX가 흩어져 있어,
 * "말풍선이 언제 뜨는가"를 고치려면 화면 조립 전체를 훑어야 했다. 트리거가 스스로
 * 아는 것(닫아 둔 미리보기 키, 되감기 중인 각도)은 밖에서 보이지 않아도 되므로
 * 여기로 들어오고, App은 알림·제안·열림 여부만 내려보낸다.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { ChatAttentionItem } from "../types";
import type { AiaSuggestion } from "../lib/aiaSuggestions";
import { aiaAttentionBubble, shouldShowAiaAttentionBubble } from "../lib/aiaAttention";
import { useI18n } from "../lib/i18n";
import { AiaMark } from "./Shared";

/**
 * 화면에 낼 문구를 고르는 손잡이. 표에 담는 문구도 `{ko, en}` 자료가 아니라 이 손잡이를
 * 받는 함수로 적어, 문구 짝이 `text(ko, en)` 호출 형태로 남아 UI 카탈로그에 실린다.
 */
type TextPicker = (ko: string, en: string) => string;

/**
 * AIA 트리거 한 자리에 강조 클래스·읽어 주는 이름·툴팁이 함께 붙는데, 셋이 같은 상태를
 * 각자의 삼항 사슬로 다시 판단하고 있었다(문구 두 벌은 갈래 순서까지 같으면서 표현만
 * 달랐다). 상태를 먼저 한 값으로 정하고 문구는 표에서 꺼내면, 갈래가 늘어도 고칠 자리가
 * 한 곳으로 남는다.
 */
type AiaTriggerStatus = "disabled" | "approval" | "reply" | "suggestion" | "busy" | "idle";

const AIA_TRIGGER_TEXT: Record<AiaTriggerStatus, { label: (text: TextPicker) => string; title: (text: TextPicker) => string }> = {
  disabled: {
    label: (text) => text(
      "시스템 에이전트가 설정되지 않았습니다. 설정에서 시스템 에이전트를 선택하세요.",
      "No system agent is configured. Choose a system agent in Settings.",
    ),
    title: (text) => text(
      "시스템 에이전트가 설정되지 않았습니다. 설정에서 시스템 에이전트를 선택하세요.",
      "No system agent is configured. Choose a system agent in Settings.",
    ),
  },
  approval: {
    label: (text) => text("AIA에 확인할 내용이 있습니다", "AIA has something for you to check"),
    title: (text) => text("AIA 권한 승인이 필요합니다", "AIA needs permission approval"),
  },
  reply: {
    label: (text) => text("AIA에 확인할 내용이 있습니다", "AIA has something for you to check"),
    title: (text) => text("AIA 답변을 확인하세요", "Check AIA's reply"),
  },
  suggestion: {
    label: (text) => text("AIA에 확인할 내용이 있습니다", "AIA has something for you to check"),
    title: (text) => text("AIA 제안을 확인하세요", "Check AIA's suggestions"),
  },
  busy: {
    label: (text) => text("AIA가 작업 중입니다", "AIA is working"),
    title: (text) => text("AIA가 작업 중입니다", "AIA is working"),
  },
  idle: {
    label: (text) => text("AIA 열기", "Open AIA"),
    title: (text) => text("AIA 열기", "Open AIA"),
  },
};

/**
 * 트리거의 상태와 클래스를 한 번에 정한다. 강조 클래스는 상태 갈래와 결이 다르다 —
 * `busy`는 확인할 알림이 있어도 함께 붙고(문구는 알림이 이긴다), `unread`는 알림에만
 * 붙는다. 그래서 상태에서 파생하지 않고 같은 입력에서 따로 만든다.
 */
function aiaTriggerView(input: {
  enabled: boolean;
  open: boolean;
  busy: boolean;
  attentionKind: string | null;
  hasAttention: boolean;
  suggestionCount: number;
}): { status: AiaTriggerStatus; className: string } {
  const { enabled, open, busy, attentionKind, hasAttention, suggestionCount } = input;
  const status: AiaTriggerStatus = !enabled
    ? "disabled"
    : attentionKind === "approval"
      ? "approval"
      : hasAttention
        ? "reply"
        : suggestionCount > 0
          ? "suggestion"
          : busy
            ? "busy"
            : "idle";
  const className = [
    "aia-trigger",
    enabled && open ? "active" : "",
    enabled && busy ? "busy" : "",
    hasAttention ? "unread" : "",
    hasAttention || suggestionCount > 0 ? "attention" : "",
  ].filter(Boolean).join(" ");
  return { status, className };
}

/**
 * 강조가 풀리는 순간의 바늘 각도를 붙잡아 0도까지 천천히 되감는다. 배회 회전은 애니메이션
 * 값이라 강조가 풀리면 transform이 그대로 스냅된다(트랜지션은 지정값 변화에만 반응).
 */
function useAiaNeedleUnwind(emphasized: boolean, triggerRef: RefObject<HTMLButtonElement | null>) {
  const wasEmphasized = useRef(emphasized);
  useEffect(() => {
    const was = wasEmphasized.current;
    wasEmphasized.current = emphasized;
    const needle = triggerRef.current?.querySelector<SVGGElement>(".aia-mark-needle");
    if (!needle) return undefined;
    if (emphasized) {
      // 되감기 도중 다시 강조되면 인라인 고정을 걷어 배회 애니메이션이 이어받게 한다.
      needle.style.removeProperty("animation-name");
      needle.style.removeProperty("transition");
      needle.style.removeProperty("transform");
      return undefined;
    }
    if (!was) return undefined;
    const frozen = getComputedStyle(needle).transform;
    if (!frozen || frozen === "none") return undefined;
    // 단축 속성(animation)은 React가 인라인으로 준 인스턴스별 delay/duration까지 지워 버리므로
    // animation-name만 끈다.
    needle.style.animationName = "none";
    needle.style.transition = "none";
    needle.style.transform = frozen;
    // 고정된 각도가 한 프레임 반영된 뒤에 트랜지션을 걸어야 스냅 없이 되감긴다.
    void needle.getBoundingClientRect();
    needle.style.transition = "transform 1.6s ease-in-out";
    needle.style.transform = "rotate(0deg)";
    const settle = () => {
      needle.style.removeProperty("animation-name");
      needle.style.removeProperty("transition");
      needle.style.removeProperty("transform");
    };
    needle.addEventListener("transitionend", settle, { once: true });
    return () => needle.removeEventListener("transitionend", settle);
  }, [emphasized, triggerRef]);
}

export function AiaTopbarTrigger({
  triggerRef,
  enabled,
  popupOpen,
  popupVisible,
  busy,
  attention,
  suggestions,
  guideActive,
  onToggle,
  onOpenSettings,
}: {
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** 시스템 에이전트를 골랐는가. 고르지 않았으면 트리거는 설정으로 안내만 한다. */
  enabled: boolean;
  /** 팝업 상태값. 미리보기 말풍선은 팝업이 열려 있으면 띄우지 않는다. */
  popupOpen: boolean;
  /** 실제로 화면에 떠 있는가(전용 창 안내 중에는 열려 있어도 가려진다). */
  popupVisible: boolean;
  busy: boolean;
  attention: ChatAttentionItem | null;
  suggestions: AiaSuggestion[];
  /** AIA가 화면을 조작하는 중인가. 커서·안내 말풍선과 겹치지 않게 미리보기를 접는다. */
  guideActive: boolean;
  onToggle: () => void;
  onOpenSettings: () => void;
}) {
  const { text } = useI18n();
  // 말풍선 클릭은 미확인 상태나 제안을 지우지 않고 현재 미리보기만 닫는다. 실제 AIA
  // attention이 남아 있으므로 사용자는 활성화된 트리거를 눌러 해당 대화를 확인할 수 있다.
  const [closedBubbleKey, setClosedBubbleKey] = useState<string | null>(null);
  // 트리거에 점 세 개만 띄우던 자리를, 마지막 대화를 잘라 담은 말풍선으로 바꾼다.
  // 미리보기를 못 받은 알림(옛 백엔드·본문 없는 턴)은 기존 점 표시로 남는다.
  const suggestionBubble = suggestions[0]
    ? { request: text("AIA 제안", "AIA suggestions"), response: suggestions[0].title }
    : null;
  const bubbleKey = attention
    ? `attention:${attention.id}`
    : suggestions[0]
      ? `suggestion:${suggestions[0].fingerprint}`
      : null;
  const bubble = !guideActive && shouldShowAiaAttentionBubble(popupOpen, bubbleKey, closedBubbleKey)
    ? aiaAttentionBubble(attention) ?? suggestionBubble
    : null;
  const emphasized = enabled && (popupOpen || busy || Boolean(attention) || suggestions.length > 0);
  useAiaNeedleUnwind(emphasized, triggerRef);

  const trigger = aiaTriggerView({
    enabled,
    open: popupVisible,
    busy,
    attentionKind: attention?.kind ?? null,
    hasAttention: Boolean(attention),
    suggestionCount: suggestions.length,
  });

  return <span className="aia-trigger-shell">
    <button
      ref={triggerRef}
      data-ui-anchor="topbar.aia"
      className={trigger.className}
      type="button"
      aria-label={AIA_TRIGGER_TEXT[trigger.status].label(text)}
      aria-pressed={popupVisible && enabled}
      onClick={() => { if (enabled) onToggle(); else onOpenSettings(); }}
      title={AIA_TRIGGER_TEXT[trigger.status].title(text)}
    ><span className="aia-mark-shell" aria-hidden="true"><AiaMark size={18} /></span><span className="aia-trigger-name">AIA</span>{attention && !bubble && !popupOpen && <span className="aia-attention-label" aria-hidden="true">...</span>}</button>
    {bubble && <button
      className={`aia-attention-bubble${attention?.kind === "approval" ? " approval" : ""}`}
      type="button"
      aria-label={text("AIA 메시지 미리보기 닫기", "Close AIA message preview")}
      title={text("AIA 메시지 미리보기 닫기", "Close AIA message preview")}
      onClick={() => { if (bubbleKey) setClosedBubbleKey(bubbleKey); }}
    >
      {bubble.request && <span className="aia-attention-bubble-request">{bubble.request}</span>}
      <span className="aia-attention-bubble-answer">
        <span className="aia-attention-bubble-avatar" aria-hidden="true"><AiaMark size={14} /></span>
        <span className="aia-attention-bubble-response"><span>{bubble.response}</span></span>
      </span>
    </button>}
  </span>;
}
