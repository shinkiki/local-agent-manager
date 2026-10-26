import type { ChatApprovalMode, ChatMode, ChatModelCatalogOption, ReasoningEffort } from "../types";
import { reasoningLabel, settingOptionLabel, type ChatSettingField } from "./chatSettings.ts";

/**
 * 화면에 낼 문구를 고르는 손잡이. 표에 담는 문구도 `{ko, en}` 자료가 아니라 이 손잡이를
 * 받는 함수로 적어, 문구 짝이 `text(ko, en)` 호출 형태로 남아 UI 카탈로그에 실린다.
 */
export type TextPicker = (ko: string, en: string) => string;

/**
 * 승인 처리 방식별 안내 문구. 값마다 같은 모양의 한 줄을 그리고 있어 문구만 표로 모은다.
 * 표에 없는 값은 안내가 필요 없는 것이다(문구 없이 그대로 둔다).
 */
const APPROVAL_MODE_HINTS: Partial<Record<ChatApprovalMode, (text: TextPicker) => string>> = {
  autoReview: (text) => text(
    "Codex가 승인 요청의 위험도를 자동 검토하며 추가 사용량이 발생할 수 있습니다.",
    "Codex reviews the risk of each approval request automatically, which may use extra quota.",
  ),
  granular: (text) => text(
    "Codex가 승인 종류별 정책에 따라 직접 확인을 요청합니다.",
    "Codex asks you directly according to the per-approval-type policy.",
  ),
  onFailure: (text) => text(
    "Codex가 샌드박스 실행 실패 후 직접 확인을 요청합니다.",
    "Codex asks you directly after a sandboxed run fails.",
  ),
};

/**
 * 메뉴가 글자로만 보여 주는 것들 — 접힌 상태의 요약 칩, 안내 두 줄, 경고 한 줄.
 *
 * 네 문구는 고른 값에서 바로 나오는 파생값인데도 컴포넌트 본문에 선택 박스를 그릴
 * 준비(목록 병합·잠금 판정·상태 초안)와 섞여 있었다. 그중 `modelLabel`·
 * `effectiveApprovalMode`는 문구를 만드는 데만 쓰이면서도 본문 지역 변수로 남아,
 * 마크업을 읽는 사람이 "이 값도 어딘가 그려지나" 하고 다시 훑어야 했다.
 *
 * 문구 계산만 여기로 옮겨 본문에는 그리는 데 쓰는 값만 남긴다. 렌더에 쓰이는
 * `hasApprovalField`는 선택 박스를 그릴지도 정하므로 본문이 계산해 넘긴다.
 * 승인 항목이 없는 공급자를 "승인 없음"으로 보는 규칙은 경고와 승인 안내에만 필요해
 * 이 안에 둔다.
 */
export function runtimeSettingsMessages(
  { fields, mode, approvalMode, hasApprovalField, model, modelChoices, reasoningEffort, agentChangeable }: {
    fields: ChatSettingField[];
    mode: ChatMode;
    approvalMode: ChatApprovalMode;
    hasApprovalField: boolean;
    model: string;
    modelChoices: ChatModelCatalogOption[];
    reasoningEffort: ReasoningEffort | "";
    agentChangeable: boolean;
  },
  text: TextPicker,
): { summary: string; agentHandoffNote: string | null; approvalModeHint: string | null; warning: string | null } {
  const modelLabel = modelChoices.find((option) => option.model === model)?.displayName
    || model
    || text("공급자 기본", "Provider default");
  const effectiveApprovalMode: ChatApprovalMode = hasApprovalField ? approvalMode : "never";
  // 승인 항목이 없는 공급자에는 승인 처리 값이 실행에 쓰이지 않는다. 선택 박스·요약 칩·
  // 경고가 모두 그렇게 보므로, 남아 있는 옛 값의 안내도 내지 않는다.
  const approvalModeHint = hasApprovalField ? APPROVAL_MODE_HINTS[approvalMode] : undefined;
  return {
    summary: [
      modelLabel,
      reasoningEffort ? reasoningLabel(reasoningEffort) : text("기본 추론", "Default reasoning"),
      settingOptionLabel(fields, "mode", mode) ?? mode,
      ...(hasApprovalField ? [settingOptionLabel(fields, "approvalMode", approvalMode) ?? approvalMode] : []),
    ].join(" · "),
    agentHandoffNote: agentChangeable
      ? text("에이전트를 바꾸면 새 세션을 만들어 대화를 인계합니다. 원래 세션은 그대로 남습니다.", "Changing the agent creates a new session and hands the conversation over. The original session stays as is.")
      : null,
    approvalModeHint: approvalModeHint ? approvalModeHint(text) : null,
    warning: mode === "fullAccess" && effectiveApprovalMode === "never"
      ? text("다음 요청부터 샌드박스 없이 실행됩니다.", "From the next request, runs without a sandbox.")
      : mode === "fullAccess"
        ? text("다음 요청부터 같은 대화를 전체 접근으로 다시 연결합니다.", "From the next request, reconnects this conversation with full access.")
        : effectiveApprovalMode === "never" && hasApprovalField
          ? text("승인 요청 없이 현재 권한 범위에서 실행합니다.", "Runs within the current permission scope without approval prompts.")
          : null,
  };
}
