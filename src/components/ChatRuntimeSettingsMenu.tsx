import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type {
  ChatApprovalMode,
  ChatMode,
  ChatModelCatalogOption,
  ChatReasoningOption,
  ProviderId,
  ReasoningEffort,
} from "../types";
import {
  fallbackSettingFields,
  reasoningLabel,
  settingOptionLabel,
  settingOptions,
  type ChatSettingField,
} from "../lib/chatSettings";

interface ChatRuntimeSettingsMenuProps {
  panelId: string;
  contextLabel: string;
  source: ProviderId;
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  model: string;
  modelOptions: ChatModelCatalogOption[];
  reasoningEffort: ReasoningEffort | "";
  reasoningOptions: ChatReasoningOption[];
  settingFields?: ChatSettingField[];
  extraSettings?: Record<string, string>;
  locked: boolean;
  statusIndicator?: ReactNode;
  statusLabel?: ReactNode;
  onOpen?: () => void;
  onModeChange: (mode: ChatMode) => void;
  onApprovalModeChange: (mode: ChatApprovalMode) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (effort: ReasoningEffort | "") => void;
  onExtraSettingsApply?: (settings: Record<string, string>) => void;
}

const BUILTIN_SETTING_KEYS = new Set(["mode", "approvalMode", "model", "reasoningEffort"]);
const EMPTY_SETTINGS: Record<string, string> = {};

export function ChatRuntimeSettingsMenu({
  panelId,
  contextLabel,
  source,
  mode,
  approvalMode,
  model,
  modelOptions,
  reasoningEffort,
  reasoningOptions,
  settingFields,
  extraSettings,
  locked,
  statusIndicator,
  statusLabel,
  onOpen,
  onModeChange,
  onApprovalModeChange,
  onModelChange,
  onReasoningEffortChange,
  onExtraSettingsApply,
}: ChatRuntimeSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  const fields = settingFields?.length ? settingFields : fallbackSettingFields(source);
  const runtimeExtraSettings = extraSettings ?? EMPTY_SETTINGS;
  const extraFields = onExtraSettingsApply
    ? fields.filter((field) => !BUILTIN_SETTING_KEYS.has(field.key))
    : [];
  const [draftExtraSettings, setDraftExtraSettings] = useState<Record<string, string>>(runtimeExtraSettings);
  useEffect(() => {
    setDraftExtraSettings(runtimeExtraSettings);
  }, [runtimeExtraSettings, source]);
  const modelLabel = modelOptions.find((option) => option.model === model)?.displayName
    || model
    || "공급자 기본";
  const summary = [
    modelLabel,
    reasoningEffort ? reasoningLabel(reasoningEffort) : "기본 추론",
    settingOptionLabel(fields, "mode", mode) ?? mode,
    settingOptionLabel(fields, "approvalMode", approvalMode) ?? approvalMode,
  ].join(" · ");
  const warning = mode === "fullAccess" && approvalMode === "never"
    ? "전체 접근과 승인 없이 실행이 함께 선택되어, 다음 요청부터 샌드박스 없이 실행됩니다."
    : mode === "fullAccess"
      ? "다음 요청부터 같은 대화를 전체 접근으로 다시 연결합니다."
      : approvalMode === "never"
        ? "승인 요청 없이 현재 권한 범위에서 실행합니다."
        : null;

  return (
    <div className="chat-runtime-settings-menu" ref={containerRef}>
      <div className="chat-runtime-settings-bar">
        {statusIndicator}
        <button
          className={`button compact session-runtime-settings-button${open ? " active" : ""}`}
          type="button"
          aria-label={`현재 ${contextLabel} 설정: ${summary}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            if (!open) onOpen?.();
            setOpen((current) => !current);
          }}
        >
          <SlidersHorizontal size={13} aria-hidden="true" />
          <span>{summary}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        {statusLabel}
      </div>
      {open && <div className="session-runtime-settings-panel" id={panelId}>
        <div className="session-composer-settings" role="group" aria-label={`${contextLabel} 실행 설정`}>
          <label className="session-mode-selector session-model-selector" title="응답 모델을 바꾸면 같은 대화를 선택한 모델로 다시 연결합니다.">
            <span>모델</span>
            <select
              aria-label={`${contextLabel} 응답 모델`}
              value={model}
              disabled={locked}
              onChange={(event) => onModelChange(event.target.value)}
            >
              <option value="">공급자 기본</option>
              {model && !modelOptions.some((option) => option.model === model) && <option value={model}>{model}</option>}
              {modelOptions.map((option) => <option value={option.model} key={option.model}>{option.displayName}</option>)}
            </select>
          </label>
          <label className="session-mode-selector session-reasoning-selector" title="추론 수준을 바꾸면 같은 대화로 다시 연결합니다.">
            <span>추론 수준</span>
            <select
              aria-label={`${contextLabel} 추론 수준`}
              value={reasoningEffort}
              disabled={locked}
              onChange={(event) => onReasoningEffortChange(event.target.value as ReasoningEffort | "")}
            >
              <option value="">기본</option>
              {reasoningEffort && !reasoningOptions.some((option) => option.effort === reasoningEffort) && (
                <option value={reasoningEffort}>{reasoningLabel(reasoningEffort)}</option>
              )}
              {reasoningOptions.map((option) => <option value={option.effort} key={option.effort}>{reasoningLabel(option.effort)}</option>)}
            </select>
          </label>
          <label className="session-mode-selector" title="요청 모드를 바꾸면 같은 대화를 선택한 권한 범위로 다시 연결합니다.">
            <span>요청 모드</span>
            <select
              aria-label={`${contextLabel} 요청 모드`}
              value={mode}
              disabled={locked}
              onChange={(event) => onModeChange(event.target.value as ChatMode)}
            >
              {settingOptions(fields, "mode").map((option) => (
                <option value={option.value} disabled={option.disabled} key={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="session-mode-selector session-approval-selector" title="승인 처리를 바꾸면 같은 대화로 다시 연결합니다.">
            <span>승인 처리</span>
            <select
              aria-label={`${contextLabel} 승인 처리`}
              value={approvalMode}
              disabled={locked}
              onChange={(event) => onApprovalModeChange(event.target.value as ChatApprovalMode)}
            >
              {settingOptions(fields, "approvalMode").map((option) => (
                <option value={option.value} disabled={option.disabled} key={option.value}>
                  {option.label}{option.disabled && option.detail ? ` · ${option.detail}` : ""}
                </option>
              ))}
            </select>
          </label>
          {extraFields.map((field) => <ExtraRuntimeSettingField
            field={field}
            value={draftExtraSettings[field.key] ?? ""}
            disabled={locked}
            onChange={(value) => setDraftExtraSettings((current) => ({ ...current, [field.key]: value }))}
            key={field.key}
          />)}
        </div>
        {approvalMode === "autoReview" && <small className="session-mode-hint">Codex가 승인 요청의 위험도를 자동 검토하며 추가 사용량이 발생할 수 있습니다.</small>}
        {extraFields.length > 0 && <div className="session-runtime-settings-actions">
          <small>공급자가 제공한 추가 실행 설정입니다. 적용하면 다음 요청부터 같은 대화로 다시 연결합니다.</small>
          <button
            className="button compact"
            type="button"
            disabled={locked || sameSettings(runtimeExtraSettings, draftExtraSettings)}
            onClick={() => onExtraSettingsApply?.(cleanSettings(draftExtraSettings))}
          >추가 설정 적용</button>
        </div>}
      </div>}
      {warning && <small className="session-mode-warning" role="alert">{warning}</small>}
    </div>
  );
}

function ExtraRuntimeSettingField({ field, value, disabled, onChange }: {
  field: ChatSettingField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  if (field.kind === "enum") {
    return <label className="session-mode-selector session-extra-setting-selector" title={field.detail ?? field.label}>
      <span>{field.label}</span>
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">공급자 기본{field.defaultValue ? ` · ${field.defaultValue}` : ""}</option>
        {field.options.map((option) => <option value={option.value} disabled={option.disabled} key={option.value}>
          {option.label}{option.detail ? ` · ${option.detail}` : ""}
        </option>)}
      </select>
    </label>;
  }
  return <label className="session-mode-selector session-extra-setting-selector" title={field.detail ?? field.label}>
    <span>{field.label}</span>
    <input
      value={value}
      disabled={disabled}
      placeholder={field.detail ?? field.defaultValue ?? "공급자 기본"}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>;
}

function cleanSettings(settings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value.trim().length > 0));
}

function sameSettings(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(cleanSettings(left)).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  const rightEntries = Object.entries(cleanSettings(right)).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}
