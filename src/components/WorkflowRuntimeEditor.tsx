import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { useI18n, type UiText } from "../lib/i18n";
import { errorText } from "../lib/errorText";
import { proposeSystemWorkflow, registerSystemWorkflow } from "../lib/ipc";
import type { RegisteredWorkflowRound } from "../lib/ipcWorkflows";
import { UNATTENDED_WORKFLOW_RUNTIME, workflowRuntimeContract, workflowRuntimeDraft } from "../lib/workflowRuntime";
import type { SystemWorkflowContract, WorkflowChatRuntime } from "../types";
import { ErrorBanner, useConfirm } from "./Shared";

/**
 * 저장이 페이싱 회차에 무엇을 했는지 한 줄로. 승인 버전은 등록과 함께 백엔드가 올리므로
 * 사용자가 누를 것은 없지만, 말해 주지 않으면 회차 설정이 언제 바뀌었는지 알 수 없다.
 * 못 올린 회차(저장된 인자가 새 입력 스키마를 못 채움)는 사유와 함께 앞에 세운다 — 그것만이
 * 사용자가 할 일이 남은 항목이다.
 */
function roundAdoptionNotice(rounds: RegisteredWorkflowRound[], text: UiText): string | null {
  if (rounds.length === 0) return null;
  const blocked = rounds.filter((round) => !round.adopted);
  const resumed = rounds.filter((round) => round.resumed);
  const adopted = rounds.filter((round) => round.adopted);
  const lines: string[] = [];
  if (blocked.length > 0) {
    lines.push(text(
      `입력을 채워야 하는 회차: ${blocked.map((round) => `${round.name}(${round.reason ?? "사유 미상"})`).join(", ")}`,
      `Rounds needing input: ${blocked.map((round) => `${round.name} (${round.reason ?? "unknown reason"})`).join(", ")}`,
    ));
  }
  if (adopted.length > 0) {
    lines.push(text(
      `회차 ${adopted.length}건에 함께 적용했습니다: ${adopted.map((round) => round.name).join(", ")}`,
      `Applied to ${adopted.length} round(s): ${adopted.map((round) => round.name).join(", ")}`,
    ));
  }
  if (resumed.length > 0) {
    lines.push(text(
      `버전이 어긋나 멈춰 있던 ${resumed.length}건을 다시 켰습니다.`,
      `Resumed ${resumed.length} round(s) that were paused on a version mismatch.`,
    ));
  }
  return lines.join(" ");
}

/** 공급자를 나누지 않고 한 벌로 관리한다. 모델·계정·추론 선택은 기존 페이싱의 몫이다. */
export function WorkflowRuntimeEditor({ contract, disabled, onSaved }: {
  contract: SystemWorkflowContract;
  disabled: boolean;
  onSaved: () => Promise<void>;
}) {
  const { text } = useI18n();
  const [draft, setDraft] = useState(() => workflowRuntimeDraft(contract));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  const dirty = (["mode", "approvalMode", "decisionPolicy"] as const)
    .some((key) => (draft[key] ?? null) !== (contract.chatRuntime?.[key] ?? null));
  /**
   * 지금 초안이 어느 프리셋과 같은지. 버튼 두 개가 "누르는 것"으로만 보이면 지금 무엇이
   * 걸려 있는지는 아래 선택 상자 셋을 읽어야 알 수 있다 — 눌린 자리를 표시해 한눈에 가른다.
   */
  const preset = draft.mode == null && draft.approvalMode == null && draft.decisionPolicy == null
    ? "inherited"
    : (["mode", "approvalMode", "decisionPolicy"] as const)
      .every((key) => draft[key] === UNATTENDED_WORKFLOW_RUNTIME[key])
      ? "unattended"
      : null;
  const inherited = text("기존 단계 설정 유지", "Keep existing step settings");
  const modes = { plan: text("읽기 전용", "Read only"), workspace: text("작업공간 쓰기", "Workspace write"), fullAccess: text("전체권한", "Full access") };
  const approvals = { manual: text("직접 승인", "Manual approval"), never: text("승인 없이 실행", "No approval prompts") };
  const decisions = { ask: text("사용자에게 확인", "Ask the user"), recommended: text("추천안 자동 선택", "Choose recommended action") };

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const proposal = await proposeSystemWorkflow(workflowRuntimeContract(contract, draft));
      if (!proposal.valid) throw new Error(text("실행설정 계약 검증에 실패했습니다.", "Runtime contract validation failed."));
      const runtime = proposal.contract.chatRuntime;
      const accepted = await confirm({
        title: text("워크플로 실행설정 저장", "Save workflow runtime settings"),
        message: text(
          "이 워크플로가 시작하는 Codex·Claude·Antigravity 채팅에 공통 적용합니다. 새 계약 버전으로 저장하며, 이 워크플로를 도는 페이싱 회차에도 함께 적용됩니다. 이미 실행 중인 채팅은 유지됩니다.",
          "Applies to Codex, Claude and Antigravity chats started by this workflow. Saves a new contract version, which the paced rounds running this workflow adopt as well. Running chats are unchanged.",
        ),
        items: [
          `${text("권한 범위", "Permissions")}: ${runtime?.mode ? modes[runtime.mode] : inherited}`,
          `${text("승인 처리", "Approval")}: ${runtime?.approvalMode ? approvals[runtime.approvalMode] : inherited}`,
          `${text("판단 처리", "Decisions")}: ${runtime?.decisionPolicy ? decisions[runtime.decisionPolicy] : inherited}`,
          `${text("변경 작업", "Mutations")}: ${proposal.approvalSummary.mutatingOperations.join(", ")}`,
        ],
        warning: [runtime?.mode === "fullAccess" ? text("전체권한은 작업 경로 밖의 파일과 명령에도 접근할 수 있습니다.", "Full access permits files and commands outside the working directory.") : "", ...proposal.approvalSummary.hardToRecoverEffects].filter(Boolean).join("\n") || undefined,
        confirmLabel: text("새 버전 저장", "Save new version"),
        tone: "danger",
      });
      if (!accepted) return;
      const { rounds = [] } = await registerSystemWorkflow(proposal.contract);
      setNotice(roundAdoptionNotice(rounds, text));
      await onSaved();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return <section className="workflow-detail-section" data-ui-anchor="workflows.runtime-settings">
    <header>
      <span><SlidersHorizontal size={15} /></span>
      <div><strong>{text("공통 실행설정", "Shared runtime settings")}</strong><small>{text("이 워크플로의 모든 공급자 채팅에 적용", "Applies to all provider chats in this workflow")}</small></div>
      {dirty && <em className="workflow-runtime-dirty">{text("저장 전", "Unsaved")}</em>}
    </header>
    {error && <ErrorBanner message={error} />}
    {notice && <p className="runtime-settings-hint" role="status">{notice}</p>}
    <fieldset disabled={disabled || saving} className="runtime-settings">
      <div className="runtime-settings-actions">
        <span>{text("프리셋", "Presets")}</span>
        <button
          className={`button compact${preset === "unattended" ? " selected" : ""}`}
          type="button"
          aria-pressed={preset === "unattended"}
          onClick={() => setDraft({ ...UNATTENDED_WORKFLOW_RUNTIME })}
        >{text("무인 개발 설정", "Unattended development preset")}</button>
        <button
          className={`button compact${preset === "inherited" ? " selected" : ""}`}
          type="button"
          aria-pressed={preset === "inherited"}
          onClick={() => setDraft({})}
        >{text("기존 단계 설정 사용", "Use existing step settings")}</button>
      </div>
      <div className="workflow-inputs">
        <label className="form-field"><span>{text("권한 범위", "Permissions")}</span><select aria-label={text("권한 범위", "Permissions")} value={draft.mode ?? ""} onChange={(e) => setDraft({ ...draft, mode: (e.target.value || null) as WorkflowChatRuntime["mode"] })}><option value="">{inherited}</option>{Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="form-field"><span>{text("승인 처리", "Approval")}</span><select aria-label={text("승인 처리", "Approval")} value={draft.approvalMode ?? ""} onChange={(e) => setDraft({ ...draft, approvalMode: (e.target.value || null) as WorkflowChatRuntime["approvalMode"] })}><option value="">{inherited}</option>{Object.entries(approvals).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="form-field"><span>{text("판단 처리", "Decisions")}</span><select aria-label={text("판단 처리", "Decisions")} value={draft.decisionPolicy ?? ""} onChange={(e) => setDraft({ ...draft, decisionPolicy: (e.target.value || null) as WorkflowChatRuntime["decisionPolicy"] })}><option value="">{inherited}</option>{Object.entries(decisions).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <small className="runtime-settings-hint">{text("무인 개발 설정: 전체권한 · 승인 없이 실행 · 추천안 자동 선택. 판단 처리는 에이전트 지침이며 추가 권한을 부여하지 않습니다.", "Unattended preset: full access, no approval prompts, recommended decisions. Decision policy is an agent instruction, not a permission grant.")}</small>
      {draft.approvalMode === "manual" && <p className="runtime-settings-warning" role="status">
        <AlertTriangle size={13} aria-hidden="true" />
        {text("무인 회차에서는 직접 승인 요청을 처리할 수 없어 해당 요청이 거절될 수 있습니다. Antigravity의 권한 승인은 권한 범위 설정을 따릅니다.", "Unattended rounds may reject manual approval requests. Antigravity permission handling follows the selected permissions mode.")}
      </p>}
      <div className="runtime-settings-actions">
        <small>{dirty
          ? text("저장하면 새 계약 버전이 만들어집니다.", "Saving creates a new contract version.")
          : text("저장된 설정과 같습니다.", "Same as the saved settings.")}</small>
        <button className="button" type="button" disabled={!dirty} onClick={() => setDraft(workflowRuntimeDraft(contract))}>{text("변경 취소", "Discard changes")}</button>
        <button className="button primary" type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? text("저장 중…", "Saving…") : text("검토 후 저장", "Review and save")}</button>
      </div>
    </fieldset>
    {confirmDialog}
  </section>;
}
