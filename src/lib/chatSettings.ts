import type {
  ChatApprovalMode,
  ChatMode,
  ChatProviderOptions,
  ChatSettingField,
  ChatSettingOption,
  KnownReasoningEffort,
  ProviderId,
  ReasoningEffort,
} from "../types";

// 실행설정 항목 스키마는 백엔드 ChatProviderOptions.settings로 내려오며,
// 카탈로그가 도착하기 전에는 fallbackSettingFields가 같은 내용을 즉시 제공한다.
export type { ChatSettingField, ChatSettingOption };

/**
 * 실행 모드·승인 처리 선택지의 표시 문구를 한 곳에 모은 표. 실행설정 스키마의 선택지와
 * 요약 줄의 짧은 문구가 같은 값을 두 벌로 들고 있어 한쪽만 고치면 어긋났다. `short`는
 * 선택지 문구와 요약 문구가 다른 값에만 둔다.
 */
interface ModeLabel {
  label: string;
  detail: string;
  short?: string;
}

const MODE_LABELS: Record<ChatMode, ModeLabel> = {
  plan: { label: "읽기 전용", detail: "분석·계획만" },
  workspace: { label: "작업공간 쓰기", detail: "프로젝트 수정" },
  fullAccess: { label: "전체 접근", detail: "외부 경로 허용" },
  auto: { label: "자동 권한", detail: "Claude auto 모드" },
  dontAsk: { label: "추가 권한 차단", detail: "Claude dontAsk 모드" },
  manual: { label: "수동 권한", detail: "Claude manual 모드" },
};

/** Claude CLI에만 있는 실행 모드. 나머지는 모든 공급자가 쓴다. */
const CLAUDE_ONLY_MODES: ChatMode[] = ["auto", "dontAsk", "manual"];

const APPROVAL_LABELS: Record<ChatApprovalMode, ModeLabel> = {
  manual: { label: "직접 승인", detail: "사용자 확인" },
  autoReview: { label: "자동 검토", detail: "위험도 판단" },
  granular: { label: "세분화 승인", detail: "승인 종류별 제어" },
  onFailure: { label: "실패 시 승인", detail: "샌드박스 실패 후 요청" },
  never: { label: "승인 없이 실행", detail: "모드 범위 내", short: "승인 없음" },
};

/** Codex CLI에서만 고를 수 있는 승인 처리. 다른 공급자에서는 직접 승인으로 되돌린다. */
const CODEX_ONLY_APPROVAL_MODES: ChatApprovalMode[] = ["autoReview", "granular", "onFailure"];

/**
 * Codex 전용이지만 다른 공급자에서도 선택지에 남기는 승인 처리. 왜 못 고르는지 보이도록
 * 비활성으로 내놓는다(`approvalOption` 참고).
 */
const APPROVAL_MODES_SHOWN_DISABLED: ChatApprovalMode[] = ["autoReview"];

/**
 * 공급자가 고를 수 있는 선택지 목록. 화면 순서는 위 표의 정의 순서이고, 공급자별 차이는
 * 전용 목록 한 벌로만 적는다. 예전에는 같은 값 묶음을 표와 목록에 두 벌로 적어 두어
 * 선택지를 하나 늘릴 때 한쪽만 고치면 조용히 어긋났다.
 */
function chatModesFor(source: ProviderId): ChatMode[] {
  const modes = Object.keys(MODE_LABELS) as ChatMode[];
  return source === "claude" ? modes : modes.filter((mode) => !CLAUDE_ONLY_MODES.includes(mode));
}

function approvalModesFor(source: ProviderId): ChatApprovalMode[] {
  const modes = Object.keys(APPROVAL_LABELS) as ChatApprovalMode[];
  if (source === "codex") return modes;
  return modes.filter((mode) =>
    !CODEX_ONLY_APPROVAL_MODES.includes(mode) || APPROVAL_MODES_SHOWN_DISABLED.includes(mode));
}

function modeOption(mode: ChatMode): ChatSettingOption {
  const { label, detail } = MODE_LABELS[mode];
  return { value: mode, label, detail };
}

function approvalOption(mode: ChatApprovalMode, source: ProviderId): ChatSettingOption {
  const { label, detail } = APPROVAL_LABELS[mode];
  // 자동 검토는 Codex 전용이지만 다른 공급자에서도 왜 못 고르는지 보이도록 남긴다.
  if (mode === "autoReview") {
    const codex = source === "codex";
    return { value: mode, label, detail: codex ? detail : "Codex 전용", disabled: !codex };
  }
  return { value: mode, label, detail };
}

export function fallbackSettingFields(source: ProviderId): ChatSettingField[] {
  const fields: ChatSettingField[] = [
    {
      key: "mode",
      label: "실행 모드",
      detail: "권한 범위",
      kind: "enum",
      defaultValue: "workspace",
      options: chatModesFor(source).map(modeOption),
    },
  ];
  // Antigravity CLI는 print 모드에 대화형 승인 연결이 없어 승인 처리 값이 실행에
  // 쓰이지 않는다. 백엔드 스키마와 같게, 카탈로그가 오기 전에도 항목을 내지 않는다.
  if (source !== "antigravity") {
    fields.push({
      key: "approvalMode",
      label: "승인 처리",
      detail: "명령 · 파일 · 추가 권한",
      kind: "enum",
      defaultValue: defaultApprovalMode(source),
      options: approvalModesFor(source).map((mode) => approvalOption(mode, source)),
    });
  }
  return fields;
}

export function settingFieldsFor(catalog: ChatProviderOptions | null, source: ProviderId): ChatSettingField[] {
  return catalog?.settings?.length ? catalog.settings : fallbackSettingFields(source);
}

export function settingField(fields: ChatSettingField[], key: string): ChatSettingField | null {
  return fields.find((field) => field.key === key) ?? null;
}

export function settingOptions(fields: ChatSettingField[], key: string): ChatSettingOption[] {
  return settingField(fields, key)?.options ?? [];
}

export function settingOptionLabel(fields: ChatSettingField[], key: string, value: string): string | null {
  return settingOptions(fields, key).find((option) => option.value === value)?.label ?? null;
}

/**
 * 저장된 선택값을 최신 스키마에 맞춘다. CLI가 더 이상 받지 않는 선택지는 스키마에서
 * 빠지므로, 예전 버전에서 저장한 값이 남아 있으면 스키마 기본값(없으면 고를 수 있는 첫
 * 선택지)으로 되돌린다. 스키마에 없는 항목은 판단할 근거가 없으니 그대로 둔다.
 */
export function normalizeSettingValue(fields: ChatSettingField[], key: string, value: string): string {
  const options = settingOptions(fields, key);
  if (options.length === 0) return value;
  const selected = options.find((option) => option.value === value);
  if (selected && !selected.disabled) return value;
  const defaultValue = settingField(fields, key)?.defaultValue;
  const preferred = options.find((option) => option.value === defaultValue && !option.disabled);
  return (preferred ?? options.find((option) => !option.disabled) ?? options[0]).value;
}

/** 스키마에서 사라진 추가 실행설정 항목과 허용되지 않는 값을 떨어낸다. */
export function normalizeExtraSettings(
  fields: ChatSettingField[],
  settings: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).filter(([key, value]) => {
    const field = settingField(fields, key);
    if (!field || value.trim().length === 0) return false;
    return field.kind !== "enum" || field.options.some((option) => option.value === value && !option.disabled);
  }));
}

export function defaultApprovalMode(source: ProviderId): ChatApprovalMode {
  return source === "codex" ? "autoReview" : "manual";
}

export function effectiveApprovalMode(source: ProviderId, mode: ChatApprovalMode): ChatApprovalMode {
  return source !== "codex" && CODEX_ONLY_APPROVAL_MODES.includes(mode) ? "manual" : mode;
}

const REASONING_LABELS: Record<KnownReasoningEffort, string> = {
  none: "없음",
  minimal: "최소",
  low: "낮음",
  medium: "보통",
  high: "높음",
  xhigh: "매우 높음",
  max: "최대",
  ultra: "울트라",
};

/**
 * 추론 수준 표시 문구. CLI가 새로 추가한 수준은 내장 문구가 없으므로 이름을 그대로 보여준다.
 * 모르는 값을 마지막 내장 문구로 떨어뜨리면 다른 수준으로 잘못 표시된다.
 */
export function reasoningLabel(effort: ReasoningEffort): string {
  return REASONING_LABELS[effort as KnownReasoningEffort] ?? effort;
}

/**
 * 표에서 요약용 문구를 꺼낸다. 저장된 값이 표에 없을 수 있으므로(예전 버전에서 저장한 값)
 * 조회 결과를 없을 수 있는 것으로 다루고, 없으면 호출부가 정한 문구로 대신한다.
 */
function modeLabelText<Key extends string>(
  table: Record<Key, ModeLabel>,
  key: Key,
  fallback: string,
): string {
  const entry = table[key] as ModeLabel | undefined;
  return entry?.short ?? entry?.label ?? fallback;
}

export function approvalModeLabel(mode: ChatApprovalMode): string {
  return modeLabelText(APPROVAL_LABELS, mode, "승인 없음");
}

export function permissionModeLabel(mode: ChatMode): string {
  return modeLabelText(MODE_LABELS, mode, MODE_LABELS.workspace.label);
}

export function sameChatSettings(left: Record<string, string>, right: Record<string, string>): boolean {
  const normalize = (settings: Record<string, string>) => Object.entries(settings)
    .filter(([, value]) => value.trim().length > 0)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
