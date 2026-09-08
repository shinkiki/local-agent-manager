import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, X } from "lucide-react";
import { useEscapeToClose } from "./Shared";
import type {
  AiaDecisionPolicy,
  AiaUiClickPolicy,
  ChatApprovalMode,
  ChatMode,
  ChatModelCatalogOption,
  ChatProviderOptions,
  ChatReasoningOption,
  ModelOption,
  ProviderId,
  ReasoningEffort,
} from "../types";
import {
  reasoningLabel,
  settingField,
  settingFieldsFor,
  type ChatSettingField,
} from "../lib/chatSettings";
import { anchoredPopoverPlacement, samePopoverPlacement, type PopoverPlacement } from "../lib/popoverPlacement";

function ModelPicker({ value, onChange, catalog, recent, label = "모델", defaultDetail }: { value: string; onChange: (value: string) => void; catalog: ChatProviderOptions | null; recent: ModelOption[]; label?: string; defaultDetail?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 팝오버는 설정 카드처럼 overflow가 걸린 조상에 잘리므로 document.body로 옮겨 놓고,
  // 트리거 위치를 재서 화면 좌표로 직접 배치한다.
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [catalog?.source]);
  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: 0 });
  }, [open]);
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return undefined;
    }
    const measure = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = anchoredPopoverPlacement(rect, { width: window.innerWidth, height: window.innerHeight });
      setPlacement((current) => (samePopoverPlacement(current, next) ? current : next));
    };
    measure();
    window.addEventListener("resize", measure);
    // 어느 조상이 스크롤되든 트리거를 따라가야 하므로 캡처 단계에서 듣는다.
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);
  useEscapeToClose(() => setOpen(false), open);
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      // 팝오버가 트리거와 다른 DOM 위치에 있으므로 두 영역을 함께 확인한다.
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);
  const modelMap = new Map<string, ChatModelCatalogOption>();
  for (const option of catalog?.models ?? []) modelMap.set(option.model, option);
  for (const item of recent) {
    if (!modelMap.has(item.model)) modelMap.set(item.model, { model: item.model, displayName: item.model, description: "최근 세션에서 사용한 모델", isDefault: false, defaultReasoningEffort: null, supportedReasoningEfforts: [] });
  }
  // 카탈로그에도 최근 목록에도 없는 값(예: CLI 설정이나 이전 버전에서 직접 입력한 식별자)이
  // 저장돼 있으면 목록에서 사라져 무엇이 선택됐는지 알 수 없다. 목록에 함께 노출한다.
  if (value && !modelMap.has(value)) modelMap.set(value, { model: value, displayName: value, description: "저장된 모델 식별자", isDefault: false, defaultReasoningEffort: null, supportedReasoningEfforts: [] });
  const selected = value ? modelMap.get(value) : catalog?.models.find((option) => option.isDefault);
  const countByModel = new Map(recent.map((item) => [item.model, item.count]));
  const options = [...modelMap.values()];
  const choose = (next: string) => { onChange(next); setOpen(false); };
  return (
    <div className="model-picker-field form-field" ref={rootRef}>
      <span className="field-label">{label} {!catalog && <small>불러오는 중</small>}</span>
      <button className="model-picker-trigger" type="button" ref={triggerRef} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span><strong>{value ? selected?.displayName ?? value : "공급자 기본값"}</strong><small>{value || selected?.model || defaultDetail || "CLI 설정을 그대로 사용"}</small></span><b><ChevronDown size={15} aria-hidden="true" /></b>
      </button>
      {open && createPortal(<div className="model-picker-popover is-anchored" ref={popoverRef} style={placement
        ? { left: placement.left, width: placement.width, maxHeight: placement.maxHeight, ...(placement.top === null ? { bottom: placement.bottom ?? 0 } : { top: placement.top }) }
        : { visibility: "hidden" }}>
        <div className="model-picker-popover-head">
          <strong>{label} 선택</strong>
          <button type="button" onClick={() => setOpen(false)} aria-label={`${label} 선택 닫기`}><X size={17} aria-hidden="true" /></button>
        </div>
        <div className="model-picker-list" role="listbox" ref={listRef}>
          <button className={!value ? "selected" : ""} type="button" role="option" aria-selected={!value} onClick={() => choose("")}><span><strong>공급자 기본값</strong><small>{catalog?.models.find((option) => option.isDefault)?.displayName ?? defaultDetail ?? "CLI 기본 설정"}</small></span><em>{!value ? <><Check size={10} /> 선택됨</> : "권장"}</em></button>
          {options.map((option) => <button className={value === option.model ? "selected" : ""} type="button" role="option" aria-selected={value === option.model} key={option.model} onClick={() => choose(option.model)}><span><strong>{option.displayName}</strong><small>{option.model}{option.description ? ` · ${option.description}` : ""}</small></span><em>{value === option.model ? <><Check size={10} /> 선택됨</> : option.isDefault ? "기본" : countByModel.has(option.model) ? `최근 ${countByModel.get(option.model)}회` : "사용 가능"}</em></button>)}
          {options.length === 0 && <p>선택할 수 있는 모델이 없습니다.</p>}
        </div>
        {catalog?.catalogError && <small className="model-catalog-warning">CLI 모델 목록을 불러오지 못했습니다. 조사된 목록과 최근 사용 모델을 표시합니다.</small>}
      </div>, document.body)}
    </div>
  );
}

interface RuntimeSettingsProps {
  source: ProviderId;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  approvalMode: ChatApprovalMode;
  onApprovalModeChange: (mode: ChatApprovalMode) => void;
  model: string;
  onModelChange: (model: string) => void;
  catalog: ChatProviderOptions | null;
  recent: ModelOption[];
  reasoningEffort: ReasoningEffort | "";
  onReasoningChange: (effort: ReasoningEffort | "") => void;
  reasoningOptions: ChatReasoningOption[];
  defaultEffort: ReasoningEffort | null;
  compact?: boolean;
  unattended?: boolean;
  /** 시스템 에이전트(AIA) 실행설정에서만 쓰는 판단 처리 항목. 넘기지 않으면 그리지 않는다. */
  decisionPolicy?: AiaDecisionPolicy;
  onDecisionPolicyChange?: (policy: AiaDecisionPolicy) => void;
  /** 시스템 에이전트(AIA) 실행설정에서만 쓰는 아이아 커서 클릭 권한. 넘기지 않으면 그리지 않는다. */
  uiClickPolicy?: AiaUiClickPolicy;
  onUiClickPolicyChange?: (policy: AiaUiClickPolicy) => void;
  extraSettings?: Record<string, string>;
  /** 넘기지 않으면 추가 스키마 항목을 그리지 않는다. 바깥 고급 옵션에서 `RuntimeExtraSettings`로 따로 그릴 때 생략한다. */
  onExtraSettingChange?: (key: string, value: string) => void;
}

// mode·approvalMode·모델·추론은 전용 UI가 있으므로, 그 외 스키마 항목만 일반 렌더러로 그린다.
const BUILTIN_SETTING_KEYS = new Set(["mode", "approvalMode", "model", "reasoningEffort"]);

/** 실행 설정 전용 UI가 없는 추가 스키마 항목. 바깥 고급 옵션이 접을지 판단하는 데도 쓴다. */
export function runtimeExtraSettingFields(catalog: ChatProviderOptions | null, source: ProviderId): ChatSettingField[] {
  return settingFieldsFor(catalog, source).filter((field) => !BUILTIN_SETTING_KEYS.has(field.key));
}

// 예비 모델은 자유 입력 스키마지만, 모델 필드와 같은 검색형 선택기로 고를 수 있게 따로 뽑는다.
function extraSettingFields(catalog: ChatProviderOptions | null, source: ProviderId) {
  const extraFields = runtimeExtraSettingFields(catalog, source);
  return {
    fallbackModelField: extraFields.find((field) => field.key === "fallbackModel") ?? null,
    genericExtraFields: extraFields.filter((field) => field.key !== "fallbackModel"),
  };
}

/** 실행 설정 밖(예: 새 채팅 고급 옵션)에 추가 스키마 항목만 떼어 그린다. */
export function RuntimeExtraSettings({ source, catalog, recent, extraSettings, onExtraSettingChange }: { source: ProviderId; catalog: ChatProviderOptions | null; recent: ModelOption[]; extraSettings: Record<string, string>; onExtraSettingChange: (key: string, value: string) => void }) {
  const { fallbackModelField, genericExtraFields } = extraSettingFields(catalog, source);
  if (!fallbackModelField && genericExtraFields.length === 0) return null;
  return <div className="runtime-model-row runtime-extra-settings">
    {fallbackModelField && <ModelPicker label={fallbackModelField.label} defaultDetail={fallbackModelField.detail ?? undefined} value={extraSettings[fallbackModelField.key] ?? ""} onChange={(value) => onExtraSettingChange(fallbackModelField.key, value)} catalog={catalog} recent={recent} />}
    {genericExtraFields.map((field) => <ExtraSettingField field={field} value={extraSettings[field.key] ?? ""} onChange={(value) => onExtraSettingChange(field.key, value)} key={field.key} />)}
  </div>;
}

export function RuntimeSettings({ source, mode, onModeChange, approvalMode, onApprovalModeChange, model, onModelChange, catalog, recent, reasoningEffort, onReasoningChange, reasoningOptions, defaultEffort, compact = false, unattended = false, decisionPolicy, onDecisionPolicyChange, uiClickPolicy, onUiClickPolicyChange, extraSettings, onExtraSettingChange }: RuntimeSettingsProps) {
  const fields = settingFieldsFor(catalog, source);
  const { fallbackModelField, genericExtraFields } = onExtraSettingChange
    ? extraSettingFields(catalog, source)
    : { fallbackModelField: null, genericExtraFields: [] as ChatSettingField[] };
  return (
    <fieldset className={`runtime-settings${compact ? " compact" : ""}`}>
      <legend><span>실행 설정</span><small>{decisionPolicy && onDecisionPolicyChange ? "권한 · 승인 · 판단 · 모델 · 추론" : "권한 · 승인 · 모델 · 추론"}</small></legend>
      <ModeField mode={mode} onChange={onModeChange} field={settingField(fields, "mode")} />
      <ApprovalField source={source} mode={mode} value={approvalMode} onChange={onApprovalModeChange} unattended={unattended} field={settingField(fields, "approvalMode")} />
      {decisionPolicy && onDecisionPolicyChange && <DecisionPolicyField value={decisionPolicy} onChange={onDecisionPolicyChange} />}
      {uiClickPolicy && onUiClickPolicyChange && <UiClickPolicyField value={uiClickPolicy} onChange={onUiClickPolicyChange} />}
      <div className="runtime-model-row">
        <ModelPicker value={model} onChange={onModelChange} catalog={catalog} recent={recent} />
        <ReasoningField value={reasoningEffort} onChange={onReasoningChange} options={reasoningOptions} defaultEffort={defaultEffort} />
      </div>
      {(fallbackModelField || genericExtraFields.length > 0) && <div className="runtime-model-row">
        {fallbackModelField && <ModelPicker label={fallbackModelField.label} defaultDetail={fallbackModelField.detail ?? undefined} value={extraSettings?.[fallbackModelField.key] ?? ""} onChange={(value) => onExtraSettingChange?.(fallbackModelField.key, value)} catalog={catalog} recent={recent} />}
        {genericExtraFields.map((field) => <ExtraSettingField field={field} value={extraSettings?.[field.key] ?? ""} onChange={(value) => onExtraSettingChange?.(field.key, value)} key={field.key} />)}
      </div>}
    </fieldset>
  );
}

function ExtraSettingField({ field, value, onChange }: { field: ChatSettingField; value: string; onChange: (value: string) => void }) {
  if (field.kind === "enum") {
    return <label className="reasoning-field"><span className="field-label">{field.label} {field.detail ? <small>{field.detail}</small> : <small>선택</small>}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">기본값</option>{field.options.map((option) => <option value={option.value} disabled={option.disabled} key={option.value}>{option.label}{option.detail ? ` · ${option.detail}` : ""}</option>)}</select></label>;
  }
  return <label className="reasoning-field"><span className="field-label">{field.label} <small>선택</small></span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.detail ?? ""} /></label>;
}

function ApprovalField({ source, mode, value, onChange, unattended, field }: { source: ProviderId; mode: ChatMode; value: ChatApprovalMode; onChange: (mode: ChatApprovalMode) => void; unattended: boolean; field: ChatSettingField | null }) {
  // "직접 승인"의 설명은 실행 맥락(무인 여부)에 따라 달라지므로 스키마 값을 덮어쓴다.
  const options = (field?.options ?? []).map((option) =>
    option.value === "manual" && unattended ? { ...option, detail: "요청 시 거절" } : option);
  return <div className="approval-field"><span className="field-label">{field?.label ?? "승인 처리"} <small>{field?.detail ?? "명령 · 파일 · 추가 권한"}</small></span><div className="mode-options approval-options" role="group" aria-label={field?.label ?? "승인 처리"}>{options.map((option) => <button className={value === option.value ? "selected" : ""} type="button" aria-pressed={value === option.value} disabled={option.disabled} onClick={() => onChange(option.value as ChatApprovalMode)} key={option.value}><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div>{approvalModeDescription(source, mode, value, unattended)}</div>;
}

function approvalModeDescription(source: ProviderId, mode: ChatMode, approvalMode: ChatApprovalMode, unattended: boolean) {
  if (approvalMode === "autoReview") return <small className="approval-mode-hint">Codex 검토 에이전트가 승인 요청을 평가하며 추가 사용량이 발생할 수 있습니다.</small>;
  if (approvalMode === "granular") return <small className="approval-mode-hint">Codex가 샌드박스·규칙·스킬·권한 요청을 종류별로 승인 요청합니다.</small>;
  if (approvalMode === "onFailure") return <small className="approval-mode-hint">샌드박스에서 실행이 실패한 뒤 추가 권한을 요청합니다.</small>;
  if (approvalMode === "never" && mode === "fullAccess") return <small className="chat-permission-warning" role="alert">샌드박스와 승인 절차 없이 모든 명령을 실행합니다.</small>;
  if (approvalMode === "never") return <small className="approval-mode-warning" role="alert">승인 요청 없이 현재 권한 범위에서만 실행하며, 범위를 벗어난 작업은 실패합니다.</small>;
  if (unattended) return <small className="approval-mode-warning">백그라운드 실행은 직접 승인할 수 없어 추가 권한 요청을 거절합니다.</small>;
  return <small className="approval-mode-hint">{source === "claude" ? "Claude가 추가 권한을 요청하면 실행을 멈추고 직접 확인합니다." : "추가 권한이 필요하면 실행을 멈추고 직접 확인합니다."}</small>;
}

/**
 * 권한 승인 밖의 선택을 누가 정할지. 승인 절차를 생략해도 정책·개선안 선택 같은 판단은
 * 남으므로, 그때 멈춰서 물어볼지 추천안으로 계속 진행할지 따로 고른다. CLI 플래그가 아니라
 * AIA 개발자 지침으로 전달되므로, 저장하면 돌고 있는 AIA 대화를 정지하고 다시 시작해야 적용된다.
 */
function DecisionPolicyField({ value, onChange }: { value: AiaDecisionPolicy; onChange: (policy: AiaDecisionPolicy) => void }) {
  const options: { value: AiaDecisionPolicy; label: string; detail: string }[] = [
    { value: "ask", label: "사용자에게 확인", detail: "선택지 제시 후 대기" },
    { value: "recommended", label: "추천안 자동 선택", detail: "권장안으로 계속 진행" },
  ];
  return <div className="approval-field"><span className="field-label">판단 처리 <small>승인 외 정책 · 개선안 선택</small></span><div className="mode-options approval-options" role="group" aria-label="판단 처리">{options.map((option) => <button className={value === option.value ? "selected" : ""} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)} key={option.value}><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div>{value === "recommended"
    ? <small className="approval-mode-warning" role="alert">방향을 되묻지 않고 추천안으로 진행하며, 무엇을 골랐는지는 답변에 정리합니다.</small>
    : <small className="approval-mode-hint">정책이나 개선안을 정해야 하면 진행을 멈추고 선택지를 제시합니다.</small>}</div>;
}

function UiClickPolicyField({ value, onChange }: { value: AiaUiClickPolicy; onChange: (policy: AiaUiClickPolicy) => void }) {
  const options: { value: AiaUiClickPolicy; label: string; detail: string }[] = [
    { value: "openers", label: "여는 동작만", detail: "탭 · 메뉴 · 드로워 열기" },
    { value: "all", label: "모든 클릭 허용", detail: "확인창 안만 제외" },
  ];
  return <div className="approval-field"><span className="field-label">화면 클릭 권한 <small>아이아 커서가 승인 없이 누르는 범위</small></span><div className="mode-options approval-options" role="group" aria-label="화면 클릭 권한">{options.map((option) => <button className={value === option.value ? "selected" : ""} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)} key={option.value}><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div>{value === "all"
    ? <small className="approval-mode-warning" role="alert">저장·게시·삭제처럼 실제 동작을 하는 버튼도 승인 없이 눌립니다. 확인 모달 안의 버튼만 아이아가 누르지 않습니다.</small>
    : <small className="approval-mode-hint">화면을 여는 버튼(탭·주 메뉴·드로워·패널)만 바로 누르고, 그 외 버튼은 승인 요청을 거칩니다.</small>}</div>;
}

function ReasoningField({ value, onChange, options, defaultEffort }: { value: ReasoningEffort | ""; onChange: (value: ReasoningEffort | "") => void; options: ChatReasoningOption[]; defaultEffort: ReasoningEffort | null }) {
  return <label className="reasoning-field"><span className="field-label">추론 수준 <small>선택</small></span><select value={value} onChange={(event) => onChange(event.target.value as ReasoningEffort | "")}><option value="">공급자 기본값{defaultEffort ? ` · ${reasoningLabel(defaultEffort)}` : ""}</option>{options.map((option) => <option value={option.effort} key={option.effort}>{reasoningLabel(option.effort)} · {option.description}</option>)}</select></label>;
}

export function defaultEffortFor(catalog: ChatProviderOptions | null, model: string): ReasoningEffort | null {
  if (!catalog) return null;
  const selected = model ? catalog.models.find((option) => option.model === model) : catalog.models.find((option) => option.isDefault);
  return selected?.defaultReasoningEffort ?? catalog.defaultReasoningEffort;
}

function ModeField({ mode, onChange, field }: { mode: ChatMode; onChange: (mode: ChatMode) => void; field: ChatSettingField | null }) {
  return <div className="mode-field"><span className="field-label">{field?.label ?? "실행 모드"} <small>{field?.detail ?? "권한 범위"}</small></span><div className="mode-options" role="group" aria-label={field?.label ?? "실행 모드"}>{(field?.options ?? []).map((option) => <button className={mode === option.value ? "selected" : ""} type="button" aria-pressed={mode === option.value} disabled={option.disabled} onClick={() => onChange(option.value as ChatMode)} key={option.value}><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div>{mode === "fullAccess" && <small className="chat-permission-warning" role="alert">작업 경로 밖의 명령과 파일 접근까지 허용합니다.</small>}</div>;
}
