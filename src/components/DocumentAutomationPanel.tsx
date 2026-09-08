import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  acknowledgeDocumentOfflineReport,
  createDocumentTrigger,
  deleteDocumentTrigger,
  getDocumentAutomationSnapshot,
  runDocumentTriggerTest,
  setDocumentTriggerEnabled,
  updateDocumentTrigger,
} from "../lib/ipc";
import { defaultApprovalMode, effectiveApprovalMode, normalizeSettingValue, settingFieldsFor } from "../lib/chatSettings";
import { validateDocumentTriggerDraft, type DocumentTriggerActionKind } from "../lib/documentWorkspace";
import { reasoningOptionsFor, useProviderOptions } from "../lib/providerOptions";
import type {
  AccountSnapshot,
  ChatApprovalMode,
  ChatMode,
  DocRootStatus,
  DocumentActionOption,
  DocumentAutomationSnapshot,
  DocumentChangeKind,
  DocumentOfflineChangeReport,
  DocumentTrigger,
  DocumentTriggerAction,
  DocumentTriggerInput,
  DocumentTriggerStatus,
  ModelOption,
  ProviderId,
  ProviderStatus,
  ReasoningEffort,
} from "../types";
import { defaultEffortFor, RuntimeSettings } from "./RuntimeSettings";
import { ErrorBanner, LoadingState, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";

/**
 * 저장 형식에서 스킬 실행은 스킬을 고정한 `startChat`이지만, 승인 규칙이 다르므로 화면에서는
 * 따로 고른다. SKILL.md 안의 명령을 실행하는 경로는 없고, 승인한 본문만 새 채팅 지침으로 붙는다.
 */
type ActionKind = DocumentTriggerActionKind;

/**
 * 트리거 초안 한 벌. 같은 열여섯 칸을 초기화·수정 적재·저장 세 곳이 각각 나열하던 것을
 * 한 자료로 모아, 칸이 늘 때 세 곳을 함께 고쳐야 하는 부담을 없앤다.
 */
interface TriggerDraft {
  name: string;
  rootId: string;
  include: string;
  exclude: string;
  changeKinds: DocumentChangeKind[];
  actionKind: ActionKind;
  targetId: string;
  source: ProviderId;
  accountId: string;
  model: string;
  reasoningEffort: ReasoningEffort | "";
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  fullAccessAcknowledged: boolean;
  prompt: string;
  skillId: string;
}

function emptyDraft(providers: ProviderStatus[], rootId: string): TriggerDraft {
  const source = providers[0]?.provider ?? "codex";
  return {
    name: "",
    rootId,
    include: "**/*",
    exclude: "",
    changeKinds: ["created", "modified", "deleted"],
    actionKind: "runSchedule",
    targetId: "",
    source,
    accountId: "",
    model: "",
    reasoningEffort: "",
    mode: "workspace",
    approvalMode: defaultApprovalMode(source),
    fullAccessAcknowledged: false,
    prompt: "",
    skillId: "",
  };
}

/**
 * 채팅 계열이 아닌 액션에는 공급자·모델 칸이 없으므로, 그 칸은 지금 화면에 있는 값을 그대로
 * 둔다(예전 setter 나열과 같은 동작).
 */
function draftFromTrigger(trigger: DocumentTrigger, current: TriggerDraft): TriggerDraft {
  const common: TriggerDraft = {
    ...current,
    name: trigger.name,
    rootId: trigger.rootId,
    include: trigger.include.join("\n"),
    exclude: trigger.exclude.join("\n"),
    changeKinds: trigger.changeKinds,
    fullAccessAcknowledged: false,
  };
  const action = trigger.action;
  if (action.type === "runSchedule") return { ...common, actionKind: "runSchedule", targetId: action.scheduleId };
  if (action.type === "executeWorkflow") return { ...common, actionKind: "executeWorkflow", targetId: action.workflowId };
  return {
    ...common,
    actionKind: action.skill ? "runSkill" : "startChat",
    targetId: "",
    source: action.source,
    accountId: action.accountId ?? "",
    model: action.model ?? "",
    reasoningEffort: action.reasoningEffort ?? "",
    mode: action.mode,
    approvalMode: action.approvalMode,
    prompt: action.prompt,
    skillId: action.skill?.skillId ?? "",
  };
}

interface Props {
  roots: DocRootStatus[];
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  models: ModelOption[];
  onRequestAiaPrompt?: (prompt: string) => void;
}

export function DocumentAutomationPanel({ roots, providers, accounts, models, onRequestAiaPrompt }: Props) {
  const [snapshot, setSnapshot] = useState<DocumentAutomationSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<DocumentTrigger | null>(null);
  const [draft, setDraft] = useState<TriggerDraft>(() => emptyDraft(providers, ""));
  const {
    name, rootId, include, exclude, changeKinds, actionKind, targetId, source, accountId,
    model, reasoningEffort, mode, approvalMode, fullAccessAcknowledged, prompt, skillId,
  } = draft;
  const patch = useCallback((changes: Partial<TriggerDraft>) => setDraft((current) => ({ ...current, ...changes })), []);
  const { confirm, confirmDialog } = useConfirm();

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setSnapshot(await getDocumentAutomationSnapshot());
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  /**
   * 트리거가 감시할 수 있는 폴더. 사라졌거나 접근이 막힌 등록본은 고를 수 없으므로 기본
   * 선택도 이 목록에서 잡는다 — 전체 등록본에서 고르면 선택지에 없는 값이 기본이 된다.
   */
  const watchableRoots = useMemo(() => roots.filter((root) => root.exists && !root.restricted), [roots]);
  useEffect(() => {
    if (!rootId && watchableRoots.length > 0) patch({ rootId: watchableRoots[0].id });
  }, [patch, rootId, watchableRoots]);

  const chatAction = actionKind === "startChat" || actionKind === "runSkill";
  const providerOptions = useProviderOptions(source);
  // CLI를 찾지 못한 공급자로 자동 실행을 새로 걸지는 않게 하되, 이미 저장된 선택은
  // 목록에서 사라지지 않도록 함께 보여 준다.
  const selectableProviders = providers.filter((provider) => provider.cli.detected || provider.provider === source);
  const providerAccounts = accounts?.accounts.filter((account) => account.provider === source && !account.disabled) ?? [];
  const activeAccountId = accounts?.providers.find((state) => state.provider === source)?.activeAccountId ?? null;
  const options = useMemo(() => actionKind === "runSchedule"
    ? snapshot?.options.scheduledRequests ?? []
    : snapshot?.options.workflows ?? [], [actionKind, snapshot]);
  const selectedWorkflow = actionKind === "executeWorkflow"
    ? snapshot?.options.workflows.find((item) => item.id === targetId)
    : undefined;
  const selectedSkill = actionKind === "runSkill" && skillId
    ? snapshot?.options.skills.find((item) => item.id === skillId)
    : undefined;
  // 승인 당시 지문과 현재 지문이 다르면 저장이 곧 재승인이라는 사실을 미리 알린다.
  const pinnedDigest = editing?.action.type === "startChat" ? editing.action.skill?.contentDigest ?? null : null;
  const skillChangedSinceApproval = Boolean(pinnedDigest && selectedSkill?.contentDigest && pinnedDigest !== selectedSkill.contentDigest);
  const skillUnavailable = actionKind === "runSkill" && Boolean(skillId) && !selectedSkill;

  useEffect(() => {
    const efforts = reasoningOptionsFor(providerOptions, model);
    // 카탈로그 로딩 중(목록이 비어 있음)에는 저장된 값을 지우지 않는다.
    if (reasoningEffort && efforts.length > 0 && !efforts.some((option) => option.effort === reasoningEffort)) patch({ reasoningEffort: "" });
  }, [model, patch, providerOptions, reasoningEffort]);
  useEffect(() => {
    // 저장된 권한·승인 값이 최신 스키마에서 사라졌으면 안전한 값으로 되돌린다.
    const fields = settingFieldsFor(providerOptions, source);
    setDraft((current) => ({
      ...current,
      mode: normalizeSettingValue(fields, "mode", current.mode) as ChatMode,
      approvalMode: normalizeSettingValue(fields, "approvalMode", current.approvalMode) as ChatApprovalMode,
    }));
  }, [providerOptions, source]);

  const reset = () => {
    setEditing(null);
    setDraft(emptyDraft(providers, watchableRoots[0]?.id ?? ""));
  };

  const edit = (trigger: DocumentTrigger) => {
    setEditing(trigger);
    setDraft((current) => draftFromTrigger(trigger, current));
  };

  const buildInput = (): DocumentTriggerInput => {
    let action: DocumentTriggerAction;
    if (actionKind === "runSchedule") {
      action = { type: "runSchedule", scheduleId: targetId };
    } else if (actionKind === "executeWorkflow") {
      const option = snapshot?.options.workflows.find((item) => item.id === targetId);
      const approvedVersion = option?.version ?? 0;
      action = { type: "executeWorkflow", workflowId: targetId, approvedVersion, arguments: {} };
    } else {
      action = {
        type: "startChat",
        source,
        accountId: accountId || null,
        model: model.trim() || null,
        reasoningEffort: reasoningEffort || null,
        mode,
        approvalMode: effectiveApprovalMode(source, approvalMode),
        prompt,
        settings: {},
        // 스킬 실행은 지금 보이는 내용의 지문을 승인값으로 고정한다. 새 채팅 구분에서는
        // 스킬을 붙이지 않아 두 구분이 저장본에서도 섞이지 않는다.
        skill: actionKind === "runSkill" && selectedSkill
          ? { skillId: selectedSkill.id, contentDigest: selectedSkill.contentDigest ?? "" }
          : null,
      };
    }
    return {
      name: name.trim(),
      rootId,
      include: lines(include),
      exclude: lines(exclude),
      changeKinds,
      enabled: editing?.enabled ?? true,
      debounceMs: editing?.debounceMs ?? 2000,
      cooldownMs: editing?.cooldownMs ?? 30000,
      action,
    };
  };

  /**
   * 트리거 저장·삭제·활성화·시험 실행·오프라인 보고 확인이 공유하는 작업 수명주기.
   * `afterSuccess`는 서버 작업이 성공한 뒤, 새 스냅샷을 읽기 전에만 실행한다.
   */
  const runMutation = async (work: () => Promise<unknown>, afterSuccess?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      afterSuccess?.();
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const input = buildInput();
    const problems = validateDocumentTriggerDraft({
      name,
      rootId,
      changeKinds,
      actionKind,
      actionTargetId: targetId,
      prompt,
      skillId,
      skillContentDigest: selectedSkill?.contentDigest ?? null,
      workflowApprovedVersion: input.action.type === "executeWorkflow" ? input.action.approvedVersion : null,
      fullAccessMode: chatAction && mode === "fullAccess",
      fullAccessAcknowledged,
    });
    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }
    await runMutation(
      () => editing
        ? updateDocumentTrigger(editing.id, input)
        : createDocumentTrigger(input),
      reset,
    );
  };

  const removeTrigger = async (trigger: DocumentTrigger) => {
    const accepted = await confirm({
      title: "문서 트리거 삭제",
      message: `'${trigger.name}' 트리거를 삭제할까요?`,
      warning: "대기 중인 변경 이벤트도 함께 사라집니다. 등록 폴더의 파일은 그대로 유지됩니다.",
      confirmLabel: "삭제",
      tone: "danger",
    });
    if (accepted) await runMutation(() => deleteDocumentTrigger(trigger.id));
  };

  if (!snapshot && !error) return <LoadingState label="문서 자동화 확인 중" />;

  return <div className="document-automation-panel">
    {error && <ErrorBanner message={error} />}
    {snapshot?.offlineReport && !snapshot.offlineReport.acknowledged && <DocumentOfflineReportBanner
      report={snapshot.offlineReport}
      onRequestAiaPrompt={onRequestAiaPrompt}
      onAcknowledge={(id) => void runMutation(() => acknowledgeDocumentOfflineReport(id))}
    />}

    <section className="document-trigger-form">
      <header><div><strong>{editing ? "문서 트리거 수정" : "문서 트리거 등록"}</strong><span>등록 폴더 변경을 기존 타입화된 액션에 연결합니다.</span></div><button className="icon-button" type="button" onClick={() => void refresh()} aria-label="새로고침"><RefreshCw size={15} /></button></header>
      {watchableRoots.length === 0 ? <p className="tree-empty">{roots.length === 0
        ? "감시할 문서 폴더가 없습니다. 왼쪽 문서 폴더 사이드바의 + 버튼에서 폴더를 먼저 등록하세요."
        : "등록된 문서 폴더가 모두 사라졌거나 접근할 수 없습니다. 사이드바에서 폴더 상태를 확인한 뒤 다시 등록하세요."}</p> : <>
      <div className="document-trigger-grid">
        <label>이름<input value={name} onChange={(event) => patch({ name: event.target.value })} placeholder="예: 보고서 변경 검토" /></label>
        <label>문서 폴더<select value={rootId} onChange={(event) => patch({ rootId: event.target.value })}>{watchableRoots.map((root) => <option value={root.id} key={root.id}>{root.name}</option>)}</select></label>
        <label>포함 패턴<textarea value={include} onChange={(event) => patch({ include: event.target.value })} placeholder="**/*" /></label>
        <label>제외 패턴<textarea value={exclude} onChange={(event) => patch({ exclude: event.target.value })} placeholder="tmp/**" /></label>
      </div>
      <fieldset><legend>변경 종류</legend>{(["created", "modified", "deleted"] as DocumentChangeKind[]).map((kind) => <label key={kind}><input type="checkbox" checked={changeKinds.includes(kind)} onChange={() => patch({ changeKinds: changeKinds.includes(kind) ? changeKinds.filter((item) => item !== kind) : [...changeKinds, kind] })} />{kindLabel(kind)}</label>)}</fieldset>
      <div className="document-trigger-grid">
        <label>액션<select value={actionKind} onChange={(event) => { const next = event.target.value as ActionKind; patch({ actionKind: next, targetId: "", skillId: next === "runSkill" ? skillId : "" }); }}><option value="runSchedule">반복 요청 실행</option><option value="startChat">새 채팅 요청</option><option value="runSkill">스킬 실행</option><option value="executeWorkflow">시스템 워크플로 실행</option></select></label>
        {chatAction ? <>
          <label>공급자<select value={source} onChange={(event) => { const next = event.target.value as ProviderId; patch({ source: next, accountId: "", model: "", reasoningEffort: "", approvalMode: defaultApprovalMode(next) }); }}>{selectableProviders.map((provider) => <option value={provider.provider} key={provider.provider}>{provider.displayName}{provider.cli.detected ? "" : " · CLI 미탐지"}</option>)}</select></label>
          <label>실행 계정<select value={accountId} onChange={(event) => patch({ accountId: event.target.value })}><option value="">실행 시점 기본 계정{activeAccountId ? ` · 지금은 ${providerAccounts.find((account) => account.id === activeAccountId)?.displayName ?? activeAccountId}` : ""}</option>{providerAccounts.map((account) => <option value={account.id} key={account.id}>{account.displayName}{account.authStatus === "ready" ? "" : " · 인증 필요"}{account.id === activeAccountId ? " · 기본" : ""}</option>)}</select></label>
          {actionKind === "runSkill" && <label>적용 스킬<select value={skillId} onChange={(event) => patch({ skillId: event.target.value })}><option value="">선택</option>{skillUnavailable && <option value={skillId}>{skillId} · 목록에 없음</option>}{snapshot?.options.skills.map((item) => <option value={item.id} key={item.id}>{item.label}{item.detail ? ` (${item.detail})` : ""}</option>)}</select></label>}
          <label className="wide">{actionKind === "runSkill" ? "스킬과 함께 보낼 요청" : "채팅 요청"}<textarea value={prompt} onChange={(event) => patch({ prompt: event.target.value })} placeholder="변경 파일을 검토하고 요약해줘" /></label>
          <RuntimeSettings source={source} mode={mode} onModeChange={(nextMode) => patch({ mode: nextMode, fullAccessAcknowledged: false })} approvalMode={approvalMode} onApprovalModeChange={(next) => patch({ approvalMode: next })} model={model} onModelChange={(next) => patch({ model: next })} catalog={providerOptions} recent={models.filter((item) => item.source === source)} reasoningEffort={reasoningEffort} onReasoningChange={(next) => patch({ reasoningEffort: next })} reasoningOptions={reasoningOptionsFor(providerOptions, model)} defaultEffort={defaultEffortFor(providerOptions, model)} compact unattended />
          {mode === "fullAccess" && <label className="wide check-filter"><input type="checkbox" checked={fullAccessAcknowledged} onChange={(event) => patch({ fullAccessAcknowledged: event.target.checked })} /> 전체 접근으로 자동 실행되면 문서 폴더 밖 명령도 무인으로 실행될 수 있음을 이해했습니다</label>}
        </> : <label>실행 대상<select value={targetId} onChange={(event) => patch({ targetId: event.target.value })}><option value="">선택</option>{options.map((item) => <option value={item.id} key={item.id}>{item.label}{item.detail ? ` (${item.detail})` : ""}</option>)}</select></label>}
      </div>
      {actionKind === "runSkill" && <div className="document-trigger-note">
        <p>등록 시점의 스킬 내용을 승인값으로 고정하고, 변경이 감지되면 그 본문을 지침으로 붙인 일반 채팅을 실행합니다. SKILL.md 안의 명령이나 스크립트를 직접 실행하지는 않습니다.</p>
        <p>이후 스킬이 수정되면 실행을 멈추고 재승인 대기로 바뀝니다. 이 화면에서 트리거를 다시 저장할 때까지 실행하지 않고, 그 사이 변경 이벤트는 보존합니다.</p>
        {skillUnavailable ? <div><strong>선택한 스킬을 찾을 수 없습니다</strong><ul><li>공통 원본이 없거나 삭제된 스킬입니다. 스킬 메뉴에서 확인한 뒤 다시 선택하세요.</li></ul></div>
          : skillChangedSinceApproval ? <div><strong>승인 당시와 스킬 내용이 다릅니다</strong><ul><li>지금 저장하면 현재 내용을 새 승인값으로 고정합니다. 변경 내용을 먼저 확인하세요.</li></ul></div>
            : null}
      </div>}
      {actionKind === "executeWorkflow" && <div className="document-trigger-note"><p>현재 워크플로 버전을 승인 버전으로 고정합니다. 이후 워크플로가 바뀌면 재승인 전까지 실행되지 않습니다.</p>{selectedWorkflow?.hardToRecoverEffects?.length ? <div><strong>복구가 어려운 영향</strong><ul>{selectedWorkflow.hardToRecoverEffects.map((effect) => <li key={effect}>{effect}</li>)}</ul></div> : null}</div>}
      <div className="document-trigger-form-actions">{editing && <button className="button" type="button" onClick={reset}>취소</button>}<button className="button primary" type="button" disabled={busy} onClick={() => void save()}><Plus size={14} /> {editing ? "수정 저장" : "트리거 등록"}</button></div>
      </>}
    </section>

    <DocumentTriggerList
      triggers={snapshot?.triggers ?? []}
      roots={roots}
      skills={snapshot?.options.skills ?? []}
      busy={busy}
      onEdit={edit}
      onTest={(trigger) => void runMutation(() => runDocumentTriggerTest(trigger.id))}
      onToggleEnabled={(trigger, enabled) => void runMutation(() => setDocumentTriggerEnabled(trigger.id, enabled))}
      onRemove={(trigger) => void removeTrigger(trigger)}
    />
    {confirmDialog}
  </div>;
}

/**
 * 백엔드가 멈춰 있던 사이의 변경 보고 알림. 보고 한 건을 값으로 받으므로 본문과 두 버튼이
 * 저마다 `snapshot?.offlineReport`를 다시 짚지 않는다(확인 버튼의 `!` 단정도 함께 사라진다).
 */
function DocumentOfflineReportBanner({
  report,
  onRequestAiaPrompt,
  onAcknowledge,
}: {
  report: DocumentOfflineChangeReport;
  onRequestAiaPrompt?: (prompt: string) => void;
  onAcknowledge: (reportId: string) => void;
}) {
  return <section className="document-offline-report">
    <div><strong>백엔드 중단 중 문서 변경 {report.totalCount}건</strong><span>자동 실행하지 않았습니다. AIA가 통합 변경 보고를 검토하도록 요청할 수 있습니다.</span></div>
    <button className="button" type="button" onClick={() => onRequestAiaPrompt?.(`백엔드 중단 중 감지된 문서 변경 보고 ${report.id}를 검토하고, 자동 실행 없이 영향과 권장 후속조치만 정리해줘.`)}><Bot size={14} /> AIA 검토</button>
    <button className="button" type="button" onClick={() => onAcknowledge(report.id)}>확인</button>
  </section>;
}

/**
 * 등록된 트리거 목록. 목록은 초안·검증·저장과 상태를 나눠 갖지 않고 네 콜백으로만 이어지므로,
 * 표시 전용 컴포넌트로 떼어 패널의 렌더가 트리거 등록 폼만 다루게 한다.
 */
function DocumentTriggerList({
  triggers,
  roots,
  skills,
  busy,
  onEdit,
  onTest,
  onToggleEnabled,
  onRemove,
}: {
  triggers: DocumentTrigger[];
  roots: DocRootStatus[];
  skills: DocumentActionOption[];
  busy: boolean;
  onEdit: (trigger: DocumentTrigger) => void;
  onTest: (trigger: DocumentTrigger) => void;
  onToggleEnabled: (trigger: DocumentTrigger, enabled: boolean) => void;
  onRemove: (trigger: DocumentTrigger) => void;
}) {
  return <section className="document-trigger-list"><header><strong>등록된 트리거</strong><span>{triggers.length}개</span></header>{triggers.length ? triggers.map((trigger) => <article key={trigger.id}>
    <div><strong>{trigger.name}</strong><span>{roots.find((root) => root.id === trigger.rootId)?.name ?? trigger.rootId} · {actionLabel(trigger.action, skills)} · {statusLabel(trigger.status)}</span>{trigger.statusReason && <small>{trigger.statusReason}</small>}{trigger.status === "needsReview" && <small>수정 화면에서 다시 저장해 재승인하기 전까지 실행하지 않습니다.</small>}</div>
    <div className="document-trigger-row-actions"><button className="button" type="button" onClick={() => onEdit(trigger)}>수정</button><button className="icon-button" type="button" disabled={busy} onClick={() => onTest(trigger)} aria-label="테스트"><Play size={14} /></button><label className="switch"><input type="checkbox" checked={trigger.enabled} onChange={(event) => onToggleEnabled(trigger, event.target.checked)} /><span /></label><button className="icon-button danger" type="button" disabled={busy} onClick={() => onRemove(trigger)} aria-label="삭제"><Trash2 size={14} /></button></div>
  </article>) : <p className="tree-empty">등록된 트리거가 없습니다.</p>}</section>;
}

function lines(value: string): string[] { return value.split("\n").map((item) => item.trim()).filter(Boolean); }
function kindLabel(kind: DocumentChangeKind): string { return kind === "created" ? "등록" : kind === "modified" ? "수정" : "삭제"; }

function actionLabel(action: DocumentTriggerAction, skills: DocumentActionOption[]): string {
  if (action.type === "runSchedule") return "반복 요청";
  if (action.type === "executeWorkflow") return `워크플로 v${action.approvedVersion}`;
  if (!action.skill) return "새 채팅";
  const skill = skills.find((item) => item.id === action.skill?.skillId);
  return `스킬 실행 · ${skill?.label ?? action.skill.skillId}`;
}

function statusLabel(status: DocumentTriggerStatus): string {
  switch (status) {
    case "active": return "활성";
    case "paused": return "일시중지";
    case "degraded": return "저하";
    case "needsReview": return "재승인 필요";
    case "restricted": return "접근 제한";
    default: return status;
  }
}
