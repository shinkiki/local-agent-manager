import type {
  ChatApprovalMode,
  ChatMode,
  ChatProviderOptions,
  ChatSettingField,
  ChatSettingOption,
  ProviderId,
  ReasoningEffort,
} from "../types";

// 실행설정 항목 스키마는 백엔드 ChatProviderOptions.settings로 내려오며,
// 카탈로그가 도착하기 전에는 fallbackSettingFields가 같은 내용을 즉시 제공한다.
export type { ChatSettingField, ChatSettingOption };

export function fallbackSettingFields(source: ProviderId): ChatSettingField[] {
  return [
    {
      key: "mode",
      label: "실행 모드",
      detail: "권한 범위",
      kind: "enum",
      defaultValue: "workspace",
      options: [
        { value: "plan", label: "읽기 전용", detail: "분석·계획만" },
        { value: "workspace", label: "작업공간 쓰기", detail: "프로젝트 수정" },
        { value: "fullAccess", label: "전체 접근", detail: "외부 경로 허용" },
      ],
    },
    {
      key: "approvalMode",
      label: "승인 처리",
      detail: "명령 · 파일 · 추가 권한",
      kind: "enum",
      defaultValue: source === "codex" ? "autoReview" : "manual",
      options: [
        { value: "manual", label: "직접 승인", detail: "사용자 확인" },
        { value: "autoReview", label: "자동 검토", detail: source === "codex" ? "위험도 판단" : "Codex 전용", disabled: source !== "codex" },
        { value: "never", label: "승인 없이 실행", detail: "모드 범위 내" },
      ],
    },
  ];
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

export function defaultApprovalMode(source: ProviderId): ChatApprovalMode {
  return source === "codex" ? "autoReview" : "manual";
}

export function effectiveApprovalMode(source: ProviderId, mode: ChatApprovalMode): ChatApprovalMode {
  return mode === "autoReview" && source !== "codex" ? "manual" : mode;
}

export function reasoningLabel(effort: ReasoningEffort): string {
  return effort === "minimal" ? "최소" : effort === "low" ? "낮음" : effort === "medium" ? "보통" : effort === "high" ? "높음" : effort === "xhigh" ? "매우 높음" : effort === "max" ? "최대" : "울트라";
}

export function approvalModeLabel(mode: ChatApprovalMode): string {
  return mode === "manual" ? "직접 승인" : mode === "autoReview" ? "자동 검토" : "승인 없음";
}

export function permissionModeLabel(mode: ChatMode): string {
  return mode === "plan" ? "읽기 전용" : mode === "fullAccess" ? "전체 접근" : "작업공간 쓰기";
}

export function sameChatSettings(left: Record<string, string>, right: Record<string, string>): boolean {
  const normalize = (settings: Record<string, string>) => Object.entries(settings)
    .filter(([, value]) => value.trim().length > 0)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
