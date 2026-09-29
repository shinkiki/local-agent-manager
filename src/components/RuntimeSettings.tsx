import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, X } from "lucide-react";
import { useAnchoredViewportSync, useEscapeToClose, useOutsidePointerToClose } from "./Shared";
import { useI18n, type UiText } from "../lib/i18n";
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
  type ChatSettingOption,
} from "../lib/chatSettings";
import { anchoredPopoverPlacement, samePopoverPlacement, type PopoverPlacement } from "../lib/popoverPlacement";
import { catalogForLocalConnection, localConnectionLabel, selectedLocalConnection } from "../lib/localConnections";

function uncataloguedModelOption(model: string, description: string): ChatModelCatalogOption {
  return {
    model,
    displayName: model,
    description,
    isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
  };
}

/**
 * 트리거에 붙여 document.body로 내보내는 팝오버의 배선. 화면 좌표 재기·바깥 클릭 닫기·Esc
 * 닫기는 무엇을 고르는 팝오버든 같은 규칙이라, 어떤 목록을 그릴지와 섞이지 않게 여기로 뗀다.
 * 팝오버는 설정 카드처럼 overflow가 걸린 조상에 잘리므로 트리거 위치를 재서 직접 배치한다.
 */
function useAnchoredPopover(open: boolean, onClose: () => void) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  // 닫으면 잰 자리를 버린다. 남겨 두면 다음에 열릴 때 옛 자리에 한 번 그려졌다가 제자리로 튄다.
  useLayoutEffect(() => { if (!open) setPlacement(null); }, [open]);
  useAnchoredViewportSync(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = anchoredPopoverPlacement(rect, { width: window.innerWidth, height: window.innerHeight });
    setPlacement((current) => (samePopoverPlacement(current, next) ? current : next));
  }, open);
  useEscapeToClose(onClose, open);
  // 팝오버가 트리거와 다른 DOM 위치에 있으므로 두 영역을 함께 바깥 판정에 넣는다.
  useOutsidePointerToClose(onClose, open, [rootRef, popoverRef]);
  // 아직 재지 못한 첫 그림은 숨긴다. 원점에 한 번 그렸다가 제자리로 튀는 것을 막는다.
  const popoverStyle: CSSProperties = placement
    ? { left: placement.left, width: placement.width, maxHeight: placement.maxHeight, ...(placement.top === null ? { bottom: placement.bottom ?? 0 } : { top: placement.top }) }
    : { visibility: "hidden" };
  return { rootRef, triggerRef, popoverRef, popoverStyle };
}

/**
 * 모델 목록에 무엇을 담을지. 카탈로그 · 최근 사용 · 지금 저장된 값 순으로 합치고, 뒤에 오는
 * 것이 앞선 설명을 덮지 않게 먼저 담긴 항목을 남긴다. 화면 배선과 달리 입력만으로 정해진다.
 */
function modelPickerChoices(catalog: ChatProviderOptions | null, recent: ModelOption[], value: string, text: UiText) {
  const modelMap = new Map<string, ChatModelCatalogOption>();
  for (const option of catalog?.models ?? []) modelMap.set(option.model, option);
  for (const item of recent) {
    if (!modelMap.has(item.model)) {
      modelMap.set(item.model, uncataloguedModelOption(item.model, text("최근 세션에서 사용한 모델", "Model used in a recent session")));
    }
  }
  // 카탈로그에도 최근 목록에도 없는 값(예: CLI 설정이나 이전 버전에서 직접 입력한 식별자)이
  // 저장돼 있으면 목록에서 사라져 무엇이 선택됐는지 알 수 없다. 목록에 함께 노출한다.
  if (value && !modelMap.has(value)) {
    modelMap.set(value, uncataloguedModelOption(value, text("저장된 모델 식별자", "Saved model identifier")));
  }
  return {
    options: [...modelMap.values()],
    selected: value ? modelMap.get(value) : catalog?.models.find((option) => option.isDefault),
    countByModel: new Map(recent.map((item) => [item.model, item.count])),
  };
}

function ModelPicker({ value, onChange, catalog: fullCatalog, recent, label, defaultDetail, localConnectionId = "", onLocalConnectionChange }: { value: string; onChange: (value: string) => void; catalog: ChatProviderOptions | null; recent: ModelOption[]; label?: string; defaultDetail?: string; localConnectionId?: string; onLocalConnectionChange?: (id: string) => void }) {
  const { text } = useI18n();
  // 로컬 공급자는 연결을 먼저 고르고 그 연결의 목록에서 모델을 고른다(M7 7.4). 연결 목록이
  // 없는 공급자는 카탈로그가 그대로다.
  const connections = onLocalConnectionChange ? fullCatalog?.localConnections ?? [] : [];
  const catalog = connections.length > 0 ? catalogForLocalConnection(fullCatalog, localConnectionId) : fullCatalog;
  const connection = connections.length > 0 ? selectedLocalConnection(fullCatalog, localConnectionId) : null;
  const fieldLabel = label ?? (connections.length > 0 ? text("연결 · 모델", "Connection · model") : text("모델", "Model"));
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const { rootRef, triggerRef, popoverRef, popoverStyle } = useAnchoredPopover(open, close);
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [catalog?.source]);
  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: 0 });
  }, [open]);
  const { options, selected, countByModel } = modelPickerChoices(catalog, recent, value, text);
  const choose = (next: string) => { onChange(next); setOpen(false); };
  // 연결을 바꾸면 모델은 그 연결의 기본값으로 돌아간다. 다른 연결의 모델 이름을 들고
  // 가면 그 서버에 없는 모델로 기동이 거절된다.
  const chooseConnection = (next: string) => { onLocalConnectionChange?.(next); onChange(""); };
  const connectionTitle = connection ? localConnectionLabel(connection, text) : "";
  return (
    <div className="model-picker-field form-field" ref={rootRef}>
      <span className="field-label">{fieldLabel} {!catalog && <small>{text("불러오는 중", "Loading")}</small>}</span>
      <button className="model-picker-trigger" type="button" ref={triggerRef} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <span><strong>{connection ? `${connection.label} · ` : ""}{value ? selected?.displayName ?? value : text("공급자 기본값", "Provider default")}</strong><small>{value || selected?.model || defaultDetail || text("CLI 설정을 그대로 사용", "Uses the CLI setting as is")}</small></span><b><ChevronDown size={15} aria-hidden="true" /></b>
      </button>
      {open && createPortal(<div className="model-picker-popover is-anchored" ref={popoverRef} style={popoverStyle}>
        <div className="model-picker-popover-head">
          <strong>{text(`${fieldLabel} 선택`, `Select ${fieldLabel}`)}</strong>
          <button type="button" onClick={() => setOpen(false)} aria-label={text(`${fieldLabel} 선택 닫기`, `Close ${fieldLabel} selection`)}><X size={17} aria-hidden="true" /></button>
        </div>
        {connections.length > 0 && <div className="model-picker-connections" role="radiogroup" aria-label={text("서빙 연결", "Serving connection")}>
          {connections.map((entry) => {
            const active = connection?.id === entry.id;
            return <button key={entry.id} type="button" role="radio" aria-checked={active} className={`button compact${active ? " primary" : ""}`} disabled={!entry.enabled} title={entry.baseUrl} onClick={() => chooseConnection(entry.isDefault ? "" : entry.id)}>{localConnectionLabel(entry, text)}</button>;
          })}
          {connectionTitle && <small>{text(`${connectionTitle} — ${connection?.baseUrl ?? ""}`, `${connectionTitle} — ${connection?.baseUrl ?? ""}`)}</small>}
        </div>}
        <div className="model-picker-list" role="listbox" ref={listRef}>
          <button className={!value ? "selected" : ""} type="button" role="option" aria-selected={!value} onClick={() => choose("")}><span><strong>{text("공급자 기본값", "Provider default")}</strong><small>{catalog?.models.find((option) => option.isDefault)?.displayName ?? defaultDetail ?? text("CLI 기본 설정", "CLI default setting")}</small></span><em>{!value ? <><Check size={10} /> {text("선택됨", "Selected")}</> : text("권장", "Recommended")}</em></button>
          {options.map((option) => <button className={value === option.model ? "selected" : ""} type="button" role="option" aria-selected={value === option.model} key={option.model} onClick={() => choose(option.model)}><span><strong>{option.displayName}</strong><small>{option.model}{option.description ? ` · ${option.description}` : ""}</small></span><em>{value === option.model ? <><Check size={10} /> {text("선택됨", "Selected")}</> : option.isDefault ? text("기본", "Default") : countByModel.has(option.model) ? text(`최근 ${countByModel.get(option.model)}회`, `${countByModel.get(option.model)} recent use(s)`) : text("사용 가능", "Available")}</em></button>)}
          {options.length === 0 && <p>{text("선택할 수 있는 모델이 없습니다.", "No models are available to choose from.")}</p>}
        </div>
        {catalog?.catalogError && <small className="model-catalog-warning">{text(
          "CLI 모델 목록을 불러오지 못했습니다. 조사된 목록과 최근 사용 모델을 표시합니다.",
          "Could not load the CLI model list. Showing the probed list and recently used models instead.",
        )}</small>}
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
  /** 로컬 공급자의 서빙 연결(M7 7.4). 빈 값은 기본 연결. 넘기지 않으면 연결 선택을 그리지 않는다. */
  localConnectionId?: string;
  onLocalConnectionChange?: (id: string) => void;
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
  /** 시스템 에이전트(AIA) 실행설정에서만 쓰는 AIA 커서 클릭 권한. 넘기지 않으면 그리지 않는다. */
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

interface RuntimeExtraSettingsRowProps {
  className?: string;
  fallbackModelField: ChatSettingField | null;
  genericExtraFields: ChatSettingField[];
  catalog: ChatProviderOptions | null;
  recent: ModelOption[];
  extraSettings: Record<string, string>;
  onExtraSettingChange: (key: string, value: string) => void;
}

/** 예비 모델과 일반 추가 스키마 필드의 공통 행. 두 실행설정 진입점이 같은 렌더링 규칙을 쓴다. */
function RuntimeExtraSettingsRow({ className = "runtime-model-row", fallbackModelField, genericExtraFields, catalog, recent, extraSettings, onExtraSettingChange }: RuntimeExtraSettingsRowProps) {
  if (!fallbackModelField && genericExtraFields.length === 0) return null;
  return <div className={className}>
    {fallbackModelField && <ModelPicker label={fallbackModelField.label} defaultDetail={fallbackModelField.detail ?? undefined} value={extraSettings[fallbackModelField.key] ?? ""} onChange={(value) => onExtraSettingChange(fallbackModelField.key, value)} catalog={catalog} recent={recent} />}
    {genericExtraFields.map((field) => <ExtraSettingField field={field} value={extraSettings[field.key] ?? ""} onChange={(value) => onExtraSettingChange(field.key, value)} key={field.key} />)}
  </div>;
}

/** 실행 설정 밖(예: 새 채팅 고급 옵션)에 추가 스키마 항목만 떼어 그린다. */
export function RuntimeExtraSettings({ source, catalog, recent, extraSettings, onExtraSettingChange }: { source: ProviderId; catalog: ChatProviderOptions | null; recent: ModelOption[]; extraSettings: Record<string, string>; onExtraSettingChange: (key: string, value: string) => void }) {
  const { fallbackModelField, genericExtraFields } = extraSettingFields(catalog, source);
  return <RuntimeExtraSettingsRow className="runtime-model-row runtime-extra-settings" fallbackModelField={fallbackModelField} genericExtraFields={genericExtraFields} catalog={catalog} recent={recent} extraSettings={extraSettings} onExtraSettingChange={onExtraSettingChange} />;
}

export function RuntimeSettings({ source, mode, onModeChange, approvalMode, onApprovalModeChange, model, onModelChange, localConnectionId, onLocalConnectionChange, catalog, recent, reasoningEffort, onReasoningChange, reasoningOptions, defaultEffort, compact = false, unattended = false, decisionPolicy, onDecisionPolicyChange, uiClickPolicy, onUiClickPolicyChange, extraSettings, onExtraSettingChange }: RuntimeSettingsProps) {
  const { text } = useI18n();
  const fields = settingFieldsFor(catalog, source);
  const { fallbackModelField, genericExtraFields } = onExtraSettingChange
    ? extraSettingFields(catalog, source)
    : { fallbackModelField: null, genericExtraFields: [] as ChatSettingField[] };
  return (
    <fieldset className={`runtime-settings${compact ? " compact" : ""}`}>
      <legend><span>{text("실행 설정", "Run settings")}</span><small>{decisionPolicy && onDecisionPolicyChange
        ? text("권한 · 승인 · 판단 · 모델 · 추론", "Permissions · approvals · decisions · model · reasoning")
        : text("권한 · 승인 · 모델 · 추론", "Permissions · approvals · model · reasoning")}</small></legend>
      <ModeField mode={mode} onChange={onModeChange} field={settingField(fields, "mode")} />
      <ApprovalField source={source} mode={mode} value={approvalMode} onChange={onApprovalModeChange} unattended={unattended} field={settingField(fields, "approvalMode")} />
      {decisionPolicy && onDecisionPolicyChange && <AiaPolicyField spec={decisionPolicyField(text)} value={decisionPolicy} onChange={onDecisionPolicyChange} />}
      {uiClickPolicy && onUiClickPolicyChange && <AiaPolicyField spec={uiClickPolicyField(text)} value={uiClickPolicy} onChange={onUiClickPolicyChange} />}
      <div className="runtime-model-row">
        <ModelPicker value={model} onChange={onModelChange} catalog={catalog} recent={recent} localConnectionId={source === "local" ? localConnectionId : undefined} onLocalConnectionChange={source === "local" ? onLocalConnectionChange : undefined} />
        <ReasoningField value={reasoningEffort} onChange={onReasoningChange} options={reasoningOptions} defaultEffort={defaultEffort} />
      </div>
      {onExtraSettingChange && <RuntimeExtraSettingsRow fallbackModelField={fallbackModelField} genericExtraFields={genericExtraFields} catalog={catalog} recent={recent} extraSettings={extraSettings ?? {}} onExtraSettingChange={onExtraSettingChange} />}
    </fieldset>
  );
}

/**
 * 실행 설정의 선택 버튼 줄 한 칸. "제목 + 보조 설명 · 버튼 묶음 · 그 아래 한 줄 안내"라는
 * 모양이 실행 모드·승인 처리·판단 처리·화면 클릭 권한 네 자리 모두 같고, 다른 것은 바깥
 * 상자 이름(실행 모드만 `mode-field`)과 아래 안내뿐이라 껍데기를 여기로 모은다. 눌린 표시를
 * `selected`와 `aria-pressed` 두 곳에 적는 규칙도 여기 한 벌만 남겨 네 자리가 각자 적다가
 * 어긋나는 일을 막는다.
 */
function OptionButtonField({ variant = "approval", label, detail, options, value, onChange, children }: {
  variant?: "mode" | "approval";
  label: string;
  detail: ReactNode;
  options: ChatSettingOption[];
  value: string;
  onChange: (value: string) => void;
  /** 선택에 따라 달라지는 아래 한 줄 안내. 부르는 쪽이 그대로 정한다. */
  children?: ReactNode;
}) {
  const mode = variant === "mode";
  return <div className={mode ? "mode-field" : "approval-field"}>
    <span className="field-label">{label} <small>{detail}</small></span>
    <div className={mode ? "mode-options" : "mode-options approval-options"} role="group" aria-label={label}>
      {options.map((option) => <button className={value === option.value ? "selected" : ""} type="button" aria-pressed={value === option.value} disabled={option.disabled} onClick={() => onChange(option.value)} key={option.value}><strong>{option.label}</strong><small>{option.detail}</small></button>)}
    </div>
    {children}
  </div>;
}

/**
 * 실행 설정의 선택 상자·입력 칸 한 칸을 감싸는 라벨. 추론 수준과 추가 스키마 항목(열거·자유
 * 입력)이 같은 모양을 쓴다. 보조 설명이 없는 칸은 "선택"으로 적는다.
 */
function RuntimeInputField({ label, detail, children }: { label: string; detail?: string | null; children: ReactNode }) {
  const { text } = useI18n();
  return <label className="reasoning-field"><span className="field-label">{label} <small>{detail ? detail : text("선택", "Optional")}</small></span>{children}</label>;
}

/**
 * 실행 설정 칸 아래에 붙는 한 줄 안내. 같은 자리에 등급이 셋이고(안내·경고·권한 경고),
 * 등급마다 클래스 이름과 스크린리더 알림 여부가 짝지어져 있는데 열두 자리가 그 짝을 각자
 * 적어 두고 있었다. 등급 이름만 받아 그 짝은 여기 한 벌만 남긴다.
 *
 * 한 자리(무인 실행의 승인 거절 안내)만 경고인데 `role="alert"`가 빠져 있다. 동작을 그대로
 * 두는 회차라 고치지 않고 `alert={false}`로 드러내 둔다 — 짝이 어긋난 자리가 여기 하나뿐임이
 * 이제 호출부에서 보인다.
 */
function FieldNote({ tone, alert = tone !== "hint", children }: {
  tone: "hint" | "warning" | "permission";
  alert?: boolean;
  children: ReactNode;
}) {
  const className = tone === "hint"
    ? "approval-mode-hint"
    : tone === "warning" ? "approval-mode-warning" : "chat-permission-warning";
  return <small className={className} role={alert ? "alert" : undefined}>{children}</small>;
}

function ExtraSettingField({ field, value, onChange }: { field: ChatSettingField; value: string; onChange: (value: string) => void }) {
  const { text } = useI18n();
  if (field.kind === "enum") {
    return <RuntimeInputField label={field.label} detail={field.detail}><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">{text("기본값", "Default")}</option>{field.options.map((option) => <option value={option.value} disabled={option.disabled} key={option.value}>{option.label}{option.detail ? ` · ${option.detail}` : ""}</option>)}</select></RuntimeInputField>;
  }
  // 자유 입력 칸은 보조 설명을 제목 옆이 아니라 입력 칸의 예시 문구로 쓴다.
  return <RuntimeInputField label={field.label}><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={field.detail ?? ""} /></RuntimeInputField>;
}

function ApprovalField({ source, mode, value, onChange, unattended, field }: { source: ProviderId; mode: ChatMode; value: ChatApprovalMode; onChange: (mode: ChatApprovalMode) => void; unattended: boolean; field: ChatSettingField | null }) {
  const { text } = useI18n();
  // "직접 승인"의 설명은 실행 맥락(무인 여부)에 따라 달라지므로 스키마 값을 덮어쓴다.
  const options = (field?.options ?? []).map((option) =>
    option.value === "manual" && unattended ? { ...option, detail: text("요청 시 거절", "Declines when asked") } : option);
  return <OptionButtonField
    label={field?.label ?? text("승인 처리", "Approval handling")}
    detail={field?.detail ?? text("명령 · 파일 · 추가 권한", "Commands · files · extra permissions")}
    options={options}
    value={value}
    onChange={(next) => onChange(next as ChatApprovalMode)}
  >{approvalModeDescription(source, mode, value, unattended, text)}</OptionButtonField>;
}

function approvalModeDescription(source: ProviderId, mode: ChatMode, approvalMode: ChatApprovalMode, unattended: boolean, text: UiText) {
  if (approvalMode === "autoReview") return <FieldNote tone="hint">{text(
    "Codex 검토 에이전트가 승인 요청을 평가하며 추가 사용량이 발생할 수 있습니다.",
    "A Codex review agent evaluates approval requests, which may consume extra usage.",
  )}</FieldNote>;
  if (approvalMode === "granular") return <FieldNote tone="hint">{text(
    "Codex가 샌드박스·규칙·스킬·권한 요청을 종류별로 승인 요청합니다.",
    "Codex asks for approval per request type: sandbox, rules, skills, and permissions.",
  )}</FieldNote>;
  if (approvalMode === "onFailure") return <FieldNote tone="hint">{text(
    "샌드박스에서 실행이 실패한 뒤 추가 권한을 요청합니다.",
    "Asks for extra permissions only after a command fails inside the sandbox.",
  )}</FieldNote>;
  if (approvalMode === "never" && mode === "fullAccess") return <FieldNote tone="permission">{text(
    "샌드박스와 승인 절차 없이 모든 명령을 실행합니다.",
    "Runs every command without a sandbox or approval step.",
  )}</FieldNote>;
  if (approvalMode === "never") return <FieldNote tone="warning">{text(
    "승인 요청 없이 현재 권한 범위에서만 실행하며, 범위를 벗어난 작업은 실패합니다.",
    "Runs only within the current permission scope without asking; work outside that scope fails.",
  )}</FieldNote>;
  if (unattended) return <FieldNote tone="warning" alert={false}>{text(
    "백그라운드 실행은 직접 승인할 수 없어 추가 권한 요청을 거절합니다.",
    "Background runs cannot be approved in person, so extra permission requests are declined.",
  )}</FieldNote>;
  return <FieldNote tone="hint">{source === "claude"
    ? text("Claude가 추가 권한을 요청하면 실행을 멈추고 직접 확인합니다.", "When Claude asks for extra permissions, the run pauses for you to confirm.")
    : text("추가 권한이 필요하면 실행을 멈추고 직접 확인합니다.", "When extra permissions are needed, the run pauses for you to confirm.")}</FieldNote>;
}

/**
 * 시스템 에이전트 전용 2지선다 정책 칸. 판단 처리와 화면 클릭 권한 두 자리가 "선택지 둘 ·
 * 넓은 쪽을 고르면 경고, 좁은 쪽이면 안내"라는 같은 모양을 각자 적고 있었다. 무엇이 다른지는
 * 아래 두 정본뿐이라 껍데기는 여기 한 벌만 두고, 문구와 선택지는 정본이 들고 있게 한다.
 */
interface AiaPolicyFieldSpec<T extends string> {
  label: string;
  detail: string;
  options: { value: T; label: string; detail: string }[];
  /** 이 값을 고르면 아래 한 줄이 안내 대신 경고가 된다. 둘 중 권한이 넓은 쪽이다. */
  alertOn: T;
  alertNote: string;
  hintNote: string;
}

function AiaPolicyField<T extends string>({ spec, value, onChange }: {
  spec: AiaPolicyFieldSpec<T>;
  value: T;
  onChange: (value: T) => void;
}) {
  return <OptionButtonField
    label={spec.label}
    detail={spec.detail}
    options={spec.options}
    value={value}
    onChange={(next) => onChange(next as T)}
  >{value === spec.alertOn
    ? <FieldNote tone="warning">{spec.alertNote}</FieldNote>
    : <FieldNote tone="hint">{spec.hintNote}</FieldNote>}</OptionButtonField>;
}

/**
 * 권한 승인 밖의 선택을 누가 정할지. 승인 절차를 생략해도 정책·개선안 선택 같은 판단은
 * 남으므로, 그때 멈춰서 물어볼지 추천안으로 계속 진행할지 따로 고른다. CLI 플래그가 아니라
 * AIA 개발자 지침으로 전달되므로, 저장해도 돌고 있는 대화에는 적용되지 않는다 — 그 대화에
 * 다시 보내는 순간 팝업이 정지하고 새 설정으로 다시 시작한다.
 */
function decisionPolicyField(text: UiText): AiaPolicyFieldSpec<AiaDecisionPolicy> {
  return {
    label: text("판단 처리", "Decision handling"),
    detail: text("승인 외 정책 · 개선안 선택", "Policy and improvement choices beyond approvals"),
    options: [
      { value: "ask", label: text("사용자에게 확인", "Ask the user"), detail: text("선택지 제시 후 대기", "Presents options and waits") },
      { value: "recommended", label: text("추천안 자동 선택", "Pick the recommendation"), detail: text("권장안으로 계속 진행", "Continues with the recommended option") },
    ],
    alertOn: "recommended",
    alertNote: text(
      "방향을 되묻지 않고 추천안으로 진행하며, 무엇을 골랐는지는 답변에 정리합니다.",
      "Proceeds with the recommended option without asking, and summarizes what it chose in the answer.",
    ),
    hintNote: text(
      "정책이나 개선안을 정해야 하면 진행을 멈추고 선택지를 제시합니다.",
      "Stops and presents options whenever a policy or improvement choice has to be made.",
    ),
  };
}

function uiClickPolicyField(text: UiText): AiaPolicyFieldSpec<AiaUiClickPolicy> {
  return {
    label: text("화면 클릭 권한", "Screen click permission"),
    detail: text("AIA 커서가 승인 없이 누르는 범위", "What the AIA cursor may click without approval"),
    options: [
      { value: "openers", label: text("여는 동작만", "Opening actions only"), detail: text("탭 · 메뉴 · 드로워 열기", "Opens tabs, menus, and drawers") },
      { value: "all", label: text("모든 클릭 허용", "Allow every click"), detail: text("확인창 안만 제외", "Except inside confirmation dialogs") },
    ],
    alertOn: "all",
    alertNote: text(
      "저장·게시·삭제처럼 실제 동작을 하는 버튼도 승인 없이 눌립니다. 확인 모달 안의 버튼만 AIA가 누르지 않습니다.",
      "Buttons that act for real — save, publish, delete — are clicked without approval. Only buttons inside a confirmation modal are left alone.",
    ),
    hintNote: text(
      "화면을 여는 버튼(탭·주 메뉴·드로워·패널)만 바로 누르고, 그 외 버튼은 승인 요청을 거칩니다.",
      "Only buttons that open a view (tabs, main menu, drawers, panels) are clicked directly; every other button goes through an approval request.",
    ),
  };
}

function ReasoningField({ value, onChange, options, defaultEffort }: { value: ReasoningEffort | ""; onChange: (value: ReasoningEffort | "") => void; options: ChatReasoningOption[]; defaultEffort: ReasoningEffort | null }) {
  const { text } = useI18n();
  return <RuntimeInputField label={text("추론 수준", "Reasoning effort")}><select value={value} onChange={(event) => onChange(event.target.value as ReasoningEffort | "")}><option value="">{text("공급자 기본값", "Provider default")}{defaultEffort ? ` · ${reasoningLabel(defaultEffort)}` : ""}</option>{options.map((option) => <option value={option.effort} key={option.effort}>{reasoningLabel(option.effort)} · {option.description}</option>)}</select></RuntimeInputField>;
}

export function defaultEffortFor(catalog: ChatProviderOptions | null, model: string): ReasoningEffort | null {
  if (!catalog) return null;
  const selected = model ? catalog.models.find((option) => option.model === model) : catalog.models.find((option) => option.isDefault);
  return selected?.defaultReasoningEffort ?? catalog.defaultReasoningEffort;
}

function ModeField({ mode, onChange, field }: { mode: ChatMode; onChange: (mode: ChatMode) => void; field: ChatSettingField | null }) {
  const { text } = useI18n();
  return <OptionButtonField
    variant="mode"
    label={field?.label ?? text("실행 모드", "Run mode")}
    detail={field?.detail ?? text("권한 범위", "Permission scope")}
    options={field?.options ?? []}
    value={mode}
    onChange={(next) => onChange(next as ChatMode)}
  >{mode === "fullAccess" && <FieldNote tone="permission">{text(
    "작업 경로 밖의 명령과 파일 접근까지 허용합니다.",
    "Allows commands and file access outside the working directory.",
  )}</FieldNote>}</OptionButtonField>;
}
