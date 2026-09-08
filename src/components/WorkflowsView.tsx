import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  Gauge,
  Layers3,
  ListChecks,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "../lib/i18n";
import {
  deleteSystemWorkflow,
  executeSystemWorkflow,
  getSchedulerSnapshot,
  getSystemAutomationSnapshot,
  getSystemWorkflow,
  getSystemWorkflows,
  runScheduledRequestNow,
} from "../lib/ipc";
import { aiaRuntimeProvider } from "../lib/aiaRuntime";
import { buildWorkflowArguments, workflowInputDefaults } from "../lib/scheduleWorkflow";
import type { TabRequest } from "../lib/uiGuide";
import type {
  ScheduledRequest,
  SystemWorkflowDetail,
  SystemWorkflowExecution,
  SystemWorkflowLimits,
  SystemWorkflowList,
  SystemWorkflowStep,
  SystemWorkflowSummary,
  SystemWorkflowVersion,
  WorkflowPacingMode,
  WorkflowRisk,
} from "../types";
import { ErrorBanner, HelpHint, LoadingState, useConfirm, WorkflowInputControl } from "./Shared";
import { UsageBudgetPanel } from "./UsageBudgetPanel";
import { errorText } from "../lib/errorText";

export type WorkflowsTabId = "catalog" | "recurring";

// 워크플로 화면의 중메뉴. 등록된 계약을 다루는 자리(관리)와, 페이싱이 통제하는 워크플로의
// 계정·예산을 다루는 자리를 나눈다. 반복 요청 자체는 채팅 화면의 반복 요청 탭이 만든다.
// 탭 id는 화면 안내(uiGuideTargets)·자동화가 참조하는 계약이라 이름만 바뀌어도 그대로 둔다.
const workflowsTabs: { id: WorkflowsTabId; icon: LucideIcon; ko: string; en: string }[] = [
  { id: "catalog", icon: Workflow, ko: "워크플로 관리", en: "Workflow management" },
  { id: "recurring", icon: Gauge, ko: "워크플로 페이싱", en: "Workflow pacing" },
];

interface Props {
  active: boolean;
  onRequestAiaPrompt?: (prompt: string) => void;
  /// 다른 화면(AIA 화면 안내)이 특정 탭을 열어 달라는 요청. requestId가 바뀔 때마다 전환한다.
  tabRequest?: TabRequest<WorkflowsTabId> | null;
}

export function WorkflowsView({ active, onRequestAiaPrompt, tabRequest }: Props) {
  const { text } = useI18n();
  const [tab, setTab] = useState<WorkflowsTabId>("catalog");
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest]);
  // 관리 탭의 목록·선택·입력·실행 결과는 탭이 아니라 화면에 속한다. 패널 안에 두면 페이싱
  // 탭을 잠깐 다녀오는 것만으로 패널이 내려가 채우던 실행 인자가 경고 없이 사라졌다(QA #27).
  // 상태는 여기서 들고 패널은 그리기만 한다. 관리 탭이 보일 때만 목록을 다시 읽는다.
  const catalog = useWorkflowCatalog(active && tab === "catalog");
  const aiaAvailable = useAiaAvailability(active);

  return <div className="view-stack workflows-view">
    <nav className="chat-hub-tabs settings-hub-tabs workflows-hub-tabs" role="tablist" aria-label={text("워크플로 메뉴", "Workflow menu")}>
      {workflowsTabs.map((item) => <button
        className={tab === item.id ? "active" : ""}
        type="button"
        role="tab"
        aria-selected={tab === item.id}
        key={item.id}
        data-ui-anchor={`workflows.tab.${item.id}`}
        onClick={() => setTab(item.id)}
      ><item.icon size={13} aria-hidden="true" /><span>{text(item.ko, item.en)}</span></button>)}
    </nav>
    {tab === "catalog"
      ? <WorkflowCatalogPanel catalog={catalog} aiaAvailable={aiaAvailable} onRequestAiaPrompt={onRequestAiaPrompt} />
      : <UsageBudgetPanel active={active} />}
    {/* 확인창은 탭과 무관하게 화면 위에 뜬다. 패널 안에 두면 탭을 옮긴 순간 대화가 사라진다. */}
    {catalog.confirmDialog}
  </div>;
}

/**
 * AIA 런타임 공급자가 있는지. 상단바의 AIA 버튼은 App이 들고 있는 자동화 스냅샷으로 판단하지만
 * 이 화면은 그 스냅샷을 받지 않으므로 화면이 보일 때 한 번 읽는다. 읽지 못하면 `null`(모름)로
 * 두고 막지 않는다 — 확실히 없을 때만 버튼을 막아야 사유가 거짓이 되지 않는다.
 */
function useAiaAvailability(active: boolean): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    void getSystemAutomationSnapshot()
      .then((snapshot) => { if (live) setAvailable(Boolean(aiaRuntimeProvider(snapshot))); })
      .catch(() => { if (live) setAvailable(null); });
    return () => { live = false; };
  }, [active]);
  return available;
}

type WorkflowCatalogState = ReturnType<typeof useWorkflowCatalog>;

/**
 * 워크플로 관리 탭의 상태와 동작 전부. 목록·회차 색인·선택·상세·입력·실행 결과·오류를 들고,
 * 실행(회차 1건·워크플로)·삭제·새로고침을 낸다. 패널 컴포넌트가 아니라 화면이 부르므로
 * 탭을 오가도 살아 있다.
 */
function useWorkflowCatalog(active: boolean) {
  const { text } = useI18n();
  const [list, setList] = useState<SystemWorkflowList | null>(null);
  /**
   * 워크플로마다 그 워크플로를 도는 회차(반복 요청). 페이싱 회차 계약의 "실행" 버튼은 이
   * 회차를 저장된 인자·병렬 설정으로 지금 한 번 돌리는 것이다 — 손으로 넣은 입력으로
   * 봉투를 따로 돌리면 병렬 설정을 무시하고 인자가 어긋난다. 켜진 회차를 우선하고, 없으면
   * 일시정지된 회차라도 잡는다(수동 실행은 일시정지 중에도 한 번 나간다).
   *
   * "페이싱이 지금 돌고 있는가"도 이 색인 하나로 본다 — 켜진 회차를 우선해 담으므로
   * 항목의 `enabled`가 곧 "켜진 회차가 하나라도 있다"이다.
   */
  const [roundsByWorkflow, setRoundsByWorkflow] = useState<Map<string, ScheduledRequest>>(new Map());
  /** 회차 실행을 요청한 뒤의 안내. 결과는 즉시 오지 않으므로 어디서 볼지 적어 둔다. */
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SystemWorkflowDetail | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [execution, setExecution] = useState<SystemWorkflowExecution | null>(null);
  /** 실패한 실행을 같은 멱등 키로 다시 보낼 수 있게 마지막 키를 남겨 둔다. */
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 실행·삭제 버튼이 만든 오류. 화면 맨 위 배너에만 두면 버튼을 보고 있는 사용자에게는
   * 아무 일도 일어나지 않은 것처럼 보이므로, 버튼 바로 아래 상세 패널 안에 따로 띄운다.
   */
  const [actionError, setActionError] = useState<string | null>(null);
  /** 비어 있어서 실행을 막은 필수 입력 이름. 어느 칸을 채워야 하는지 짚어 준다. */
  const [missingInputs, setMissingInputs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const runSectionRef = useRef<HTMLElement>(null);
  const { confirm, confirmDialog } = useConfirm();

  const refresh = useCallback(async () => {
    try {
      const loaded = await getSystemWorkflows();
      setList(loaded);
      setSelectedId((current) => (
        current && loaded.workflows.some((workflow) => workflow.id === current)
          ? current
          : loaded.workflows[0]?.id ?? null
      ));
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
    // 회차 정보는 표시용 부가 정보다. 못 읽어도 목록·실행은 그대로 쓰이게 오류를 겹치지 않고,
    // 그때는 페이싱 표시만 빠진다.
    try {
      const scheduler = await getSchedulerSnapshot();
      const rounds = new Map<string, ScheduledRequest>();
      for (const schedule of scheduler.schedules) {
        const workflowId = schedule.workflow?.workflowId;
        if (!workflowId) continue;
        const known = rounds.get(workflowId);
        if (!known || (schedule.enabled && !known.enabled)) rounds.set(workflowId, schedule);
      }
      setRoundsByWorkflow(rounds);
    } catch {
      setRoundsByWorkflow(new Map());
    }
  }, []);

  useEffect(() => { if (active) void refresh(); }, [active, refresh]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); setDetailLoading(false); return; }
    let live = true;
    setDetail(null);
    setDetailLoading(true);
    setExecution(null);
    setLastKey(null);
    setActionError(null);
    setNotice(null);
    setMissingInputs([]);
    void (async () => {
      try {
        const loaded = await getSystemWorkflow(selectedId);
        if (!live) return;
        setDetail(loaded);
        // 계약이 기본값을 선언한 입력은 미리 채운 상태로 보여 준다. 값이 매번 같은
        // 워크플로를 열자마자 실행 버튼만 눌러 돌릴 수 있어야 한다.
        setInputs(workflowInputDefaults(Object.entries(loaded.contract?.inputSchema ?? {})));
        setError(null);
      } catch (cause) {
        if (live) setError(errorText(cause));
      } finally {
        if (live) setDetailLoading(false);
      }
    })();
    return () => { live = false; };
  }, [selectedId]);

  const schema = useMemo(
    () => Object.entries(detail?.contract?.inputSchema ?? {}),
    [detail],
  );
  /** 계약 기본값으로 채워진 입력 수. 폼에 들어 있는 값이 어디서 왔는지 알려 준다. */
  const prefilledCount = useMemo(
    () => schema.filter(([, field]) => field.defaultValue !== undefined && field.defaultValue !== null).length,
    [schema],
  );

  /** 페이싱 회차 계약이면 그 워크플로를 도는 회차. 실행 버튼은 이 회차를 한 번 돌린다. */
  const pacedRound = detail?.pacingMode === "envelope" ? roundsByWorkflow.get(detail.id) ?? null : null;
  const isPaced = detail?.pacingMode === "envelope";
  /**
   * "페이싱 대상 계약"인 것과 "지금 회차가 돈다"는 다르다. 요약 개수·목록 배지·상세 표시가
   * 같은 기준을 써야 하는데 세 곳이 각자 같은 식을 적고 있었다. 회차(반복 요청)가 없거나
   * 전부 일시정지면 예산이 통제할 일이 없으므로 페이싱으로 세지 않는다.
   */
  const hasPacedRound = useCallback(
    (workflow: SystemWorkflowSummary) => workflow.pacingEnabled === true
      && roundsByWorkflow.get(workflow.id)?.enabled === true,
    [roundsByWorkflow],
  );

  /**
   * 실행 갈래 셋(회차 1건 실행·워크플로 실행·삭제)이 모두 `setBusy(true)` → 배너 비우기 →
   * 실행 → 실패하면 `setActionError` → `finally setBusy(null)`을 똑같이 되풀이했다.
   * 다르던 것은 본문뿐이라 그 껍데기만 한 벌로 모은다. 확인 대화와 갈래별로 다른 사전
   * 정리(알림 비우기·멱등 키 기록)는 호출부에 그대로 둔다.
   */
  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setActionError(null);
    try {
      await action();
    } catch (cause) {
      setActionError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  // 확인창 문구는 정적 UI 치환기 사전에 없는 문장들이라 text()로 영어를 함께 선언한다.
  // 버튼만 영어로 바뀌고 "복구할 수 없다"는 경고가 한국어로 남으면 영어 사용자는 읽지 못한
  // 채 승인하게 된다(QA #55).
  const runLabel = text("회차 1건 실행", "Run one round");
  const run = async (retryKey?: string) => {
    if (!detail || !detail.version) {
      setActionError(text(
        "승인된 워크플로 버전을 확인할 수 없어 실행할 수 없습니다. AIA가 계약을 다시 등록해야 합니다.",
        "Cannot run because the approved workflow version is unknown. AIA must register the contract again.",
      ));
      return;
    }
    if (pacedRound) {
      // 회차 1건 실행: 저장된 인자·병렬 설정으로 그 회차를 지금 한 번 돌린다. 스케줄러가
      // 다음 틱에 집어 봉투(갱신·계산·정리·기동·재갱신)를 두른다.
      const accepted = await confirm({
        title: text(`${workflowName(detail)} 회차 1건 실행`, `Run one round of ${workflowName(detail)}`),
        message: [
          text(
            `회차 '${pacedRound.name}'을 저장된 인자와 병렬 실행 설정(${parallelRunsLabel(pacedRound, text)})으로 지금 한 번 실행합니다.`,
            `Runs round '${pacedRound.name}' once now with its saved arguments and parallel-run setting (${parallelRunsLabel(pacedRound, text)}).`,
          ),
          text(
            "사용량 갱신 → 기동 수 계산(예약 기록) → 지난 회차 정리 → 기동 → 재갱신이 돌고, 실제 기동 건수는 예산이 정합니다.",
            "Usage refresh → launch count (reservation) → stale-round cleanup → launch → refresh will run; the budget decides how many actually launch.",
          ),
          pacedRound.enabled ? "" : text("회차가 일시정지 상태여도 이 한 번은 실행됩니다.", "This single run goes out even though the round is paused."),
        ].filter(Boolean).join("\n"),
        confirmLabel: runLabel,
        tone: "danger",
      });
      if (!accepted) return;
      setNotice(null);
      await runAction(async () => {
        await runScheduledRequestNow(pacedRound.id);
        setExecution(null);
        setNotice(text(
          `회차 '${pacedRound.name}' 실행을 요청했습니다. 스케줄러가 다음 틱(15초 이내)에 시작하며, 진행과 결과는 워크플로 페이싱 탭의 회차 카드와 반복 요청 기록에서 볼 수 있습니다.`,
          `Requested a run of round '${pacedRound.name}'. The scheduler starts it on the next tick (within 15 s); progress and results appear on the round card in the Workflow pacing tab and in the recurring request history.`,
        ));
        await refresh();
      });
      return;
    }
    const missing = schema
      .filter(([name, field]) => field.required && field.type !== "boolean" && !(inputs[name] ?? "").trim())
      .map(([name]) => name);
    if (missing.length > 0) {
      // 비어 있는 칸을 표시하고 그 자리로 화면을 옮긴다. 오류를 위쪽 배너에만 남기면
      // 실행 버튼을 보고 있는 사용자에게는 아무 반응이 없는 것처럼 보인다.
      setMissingInputs(missing);
      setActionError(null);
      runSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setMissingInputs([]);
    const steps = detail.contract?.steps.length ?? 0;
    const effects = detail.hardToRecoverEffects ?? [];
    const readOnly = detail.computedRisk === "readOnly";
    const accepted = await confirm({
      title: isPaced
        ? text(`${workflowName(detail)} 회차 1건 실행`, `Run one round of ${workflowName(detail)}`)
        : text(`${workflowName(detail)} 실행`, `Run ${workflowName(detail)}`),
      message: [
        text(`버전 v${detail.version}을 지금 실행합니다.`, `Runs version v${detail.version} now.`),
        text(`단계 ${steps}개 · ${riskLabel(detail.computedRisk)}`, `${steps} steps · ${riskLabelEn(detail.computedRisk)}`),
        isPaced
          ? text(
            "이 워크플로를 도는 회차가 없어 아래 입력값으로 회차 1건을 돌립니다(병렬 실행 끔). 사용량 갱신 → 기동 수 계산(예약 기록) → 지난 회차 정리 → 기동 → 재갱신이 돌고, 실제 기동 건수는 예산이 정합니다.",
            "No round runs this workflow, so one round runs with the inputs below (parallel runs off). Usage refresh → launch count (reservation) → stale-round cleanup → launch → refresh will run; the budget decides how many actually launch.",
          )
          : readOnly
            ? text("조회만 하는 워크플로입니다.", "This workflow only reads state.")
            : text("이 실행은 시스템 상태를 변경합니다.", "This run changes system state."),
      ].join("\n"),
      items: detail.requiredOperations ?? undefined,
      warning: effects.length > 0 ? effects.join(" / ") : undefined,
      confirmLabel: isPaced ? runLabel : text("실행", "Run"),
      tone: readOnly && !isPaced ? "default" : "danger",
    });
    if (!accepted) return;

    const key = retryKey ?? newIdempotencyKey();
    // 콜백 안에서는 위 가드로 좁혀 둔 `detail.version`의 non-null이 풀리므로 여기서 붙잡는다.
    const version = detail.version;
    await runAction(async () => {
      setLastKey(key);
      const receipt = await executeSystemWorkflow(detail.id, key, buildWorkflowArguments(schema, inputs), version);
      setExecution(receipt);
      await refresh();
    });
  };

  const remove = async (workflow: SystemWorkflowSummary) => {
    const accepted = await confirm({
      title: text(`${workflowName(workflow)} 삭제`, `Delete ${workflowName(workflow)}`),
      message: [
        text("등록된 워크플로와 실행 권한을 제거합니다.", "Removes the registered workflow and its execution permission."),
        text("감사 이력은 그대로 남지만 계약과 버전 이력은 복구할 수 없습니다.", "The audit trail is kept, but the contract and its version history cannot be recovered."),
        text("다시 쓰려면 AIA가 승인 요약을 거쳐 새로 등록해야 합니다.", "To use it again, AIA must register it anew through an approval summary."),
      ].join("\n"),
      confirmLabel: text("삭제", "Delete"),
      tone: "danger",
    });
    if (!accepted) return;
    await runAction(async () => {
      await deleteSystemWorkflow(workflow.id);
      if (selectedId === workflow.id) setSelectedId(null);
      await refresh();
    });
  };

  const changeInput = (name: string, value: string) => {
    setInputs((current) => ({ ...current, [name]: value }));
    // 채우는 즉시 그 칸의 표시를 걷어 남은 칸만 남긴다.
    if (value.trim()) setMissingInputs((current) => current.filter((missing) => missing !== name));
  };

  return {
    list, error, actionError, notice, selectedId, detail, detailLoading, inputs, execution, lastKey,
    missingInputs, busy, schema, prefilledCount, pacedRound, hasPacedRound, runSectionRef, confirmDialog,
    refresh, run, remove, select: setSelectedId, changeInput,
  };
}

/** 등록된 시스템 워크플로 계약을 고르고, 값을 넣어 실행하고, 이력을 보는 자리. 상태는 `useWorkflowCatalog`가 든다. */
function WorkflowCatalogPanel({ catalog, aiaAvailable, onRequestAiaPrompt }: {
  catalog: WorkflowCatalogState;
  aiaAvailable: boolean | null;
  onRequestAiaPrompt?: (prompt: string) => void;
}) {
  const { text } = useI18n();
  const {
    list, error, actionError, notice, selectedId, detail, detailLoading, inputs, execution, lastKey,
    missingInputs, busy, schema, prefilledCount, pacedRound, hasPacedRound, runSectionRef,
    refresh, run, remove, select, changeInput,
  } = catalog;

  if (!list && !error) return <LoadingState label="등록된 워크플로를 확인하고 있습니다" />;

  const workflows = list?.workflows ?? [];

  return <>
    {error && <ErrorBanner message={error} />}

    <WorkflowOverview
      workflows={workflows}
      limits={list?.limits}
      hasPacedRound={hasPacedRound}
      aiaAvailable={aiaAvailable}
      onRefresh={() => void refresh()}
      onRequestAiaPrompt={onRequestAiaPrompt}
    />

    <div className="workflow-workspace">
      <WorkflowCatalogList
        workflows={workflows}
        selectedId={selectedId}
        hasPacedRound={hasPacedRound}
        onSelect={select}
      />

      <main className="panel workflow-detail-panel">
        {detailLoading ? <LoadingState label="워크플로 계약을 읽고 있습니다" /> : detail ? <>
          <header className="workflow-detail-header">
            <div className="workflow-detail-title">
              <span className={`workflow-detail-symbol ${riskClass(detail.computedRisk)}`} aria-hidden="true"><Workflow size={19} /></span>
              <div>
                <div className="workflow-detail-badges">
                  <span className={`workflow-risk-badge ${riskClass(detail.computedRisk)}`}>{riskLabel(detail.computedRisk)}</span>
                  <span className={detail.compatible ? "workflow-compatible-badge" : "workflow-incompatible-badge"}>{detail.compatible ? "현재 카탈로그 호환" : "재등록 필요"}</span>
                </div>
                {/* 계약 설명은 길어서 헤더를 통째로 밀어낸다. 두 줄만 남기고 전문은 (?)로 옮긴다. */}
                <h2>{workflowName(detail)}<HelpHint
                  label={`${workflowName(detail)} 설명`}
                  title={workflowName(detail)}
                  footer={<code className="workflow-help-id">{detail.id}</code>}
                  popoverClassName="workflow-help-popover"
                >{detail.description ?? detail.id}</HelpHint></h2>
                {detail.description && <p>{detail.description}</p>}
              </div>
            </div>
            <button className="icon-button danger" type="button" disabled={busy} onClick={() => void remove(detail)} aria-label={text("워크플로 삭제", "Delete workflow")} title={text("워크플로 삭제", "Delete workflow")}><Trash2 size={14} /></button>
          </header>

          {/* 실행·페이싱은 제목과 섞이지 않게 헤더 아래 전용 줄에 오른쪽 정렬로 모은다. */}
          <div className="workflow-detail-actions">
            {hasPacedRound(detail) && <WorkflowPacingStatus mode={detail.pacingMode ?? null} />}
            {lastKey && execution && !execution.succeeded && execution.retryable && <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void run(lastKey)}
            ><RotateCcw size={14} /> 같은 키로 재시도</button>}
            <button
              className="button primary"
              type="button"
              disabled={busy || !detail.compatible || !detail.version}
              onClick={() => void run()}
            ><Play size={14} /> {busy ? "실행 중…" : "워크플로 실행"}</button>
          </div>

          <dl className="workflow-detail-meta">
            <div><dt>버전</dt><dd>v{detail.version ?? "?"}</dd></div>
            <div><dt>단계</dt><dd>{detail.contract?.steps.length ?? 0}개</dd></div>
            <div><dt>시스템 작업</dt><dd>{detail.requiredOperations?.length ?? 0}종</dd></div>
            <div><dt>계약 지문</dt><dd title={detail.contractDigest ?? undefined}>{detail.contractDigest ? `${detail.contractDigest.slice(0, 12)}…` : "없음"}</dd></div>
          </dl>

          <div className="workflow-detail-body">
            {actionError && <div className="workflow-action-error"><ErrorBanner message={actionError} /></div>}
            {notice && <div className="schedule-workflow-note" role="status"><p>{notice}</p></div>}
            {!detail.compatible && <div className="workflow-warning">
              <AlertTriangle size={16} aria-hidden="true" />
              <div><strong>현재 카탈로그와 호환되지 않습니다</strong><p>AIA가 계약을 다시 승인·등록해야 실행할 수 있습니다.</p></div>
            </div>}
            {(detail.hardToRecoverEffects?.length ?? 0) > 0 && <div className="workflow-warning">
              <AlertTriangle size={16} aria-hidden="true" />
              <div><strong>복구가 어려운 영향</strong><ul>{detail.hardToRecoverEffects?.map((effect) => <li key={effect}>{effect}</li>)}</ul></div>
            </div>}

            <section className="workflow-detail-section workflow-run-section" ref={runSectionRef}>
              {pacedRound ? <>
                <header><span><ListChecks size={15} /></span><div><strong>회차 1건 실행</strong><small>{`회차 '${pacedRound.name}' · 병렬 실행 ${parallelRunsLabel(pacedRound, text)} · ${pacedRound.enabled ? "활성" : "일시정지"}. 저장된 인자로 실행하며, 인자·병렬 설정은 워크플로 페이싱 탭의 회차 편집기에서 바꿉니다.`}</small></div></header>
                {Object.keys(pacedRound.workflow?.arguments ?? {}).length > 0 && <ul className="workflow-round-arguments">
                  {Object.entries(pacedRound.workflow?.arguments ?? {}).map(([name, value]) => <li key={name}><code>{inputLabel(schema, name)}</code> {String(value).length > 80 ? `${String(value).slice(0, 80)}…` : String(value)}</li>)}
                </ul>}
              </> : <>
              <header><span><ListChecks size={15} /></span><div><strong>실행 입력</strong><small>{schema.length > 0 ? `${schema.length}개 값을 확인한 뒤 실행합니다.${prefilledCount > 0 ? ` 계약이 선언한 기본값 ${prefilledCount}개를 미리 채웠습니다.` : ""}` : "추가 입력 없이 바로 실행할 수 있습니다."}</small></div></header>
              {missingInputs.length > 0 && <p className="workflow-input-problem" role="alert">
                <AlertTriangle size={13} aria-hidden="true" />
                필수 입력 {missingInputs.length}개를 채워야 실행할 수 있습니다: {missingInputs.map((name) => inputLabel(schema, name)).join(", ")}
              </p>}
              {schema.length > 0 && <div className="workflow-inputs">
                {schema.map(([name, field]) => <WorkflowInputControl
                  key={name}
                  name={name}
                  field={field}
                  value={inputs[name] ?? ""}
                  invalid={missingInputs.includes(name)}
                  onChange={(value) => changeInput(name, value)}
                />)}
              </div>}
              </>}
            </section>

            <WorkflowStepList steps={detail.contract?.steps ?? []} />

            {execution && <WorkflowExecutionReport execution={execution} />}

            {detail.versions.length > 0 && <WorkflowVersionHistory versions={detail.versions} />}
          </div>
        </> : <WorkflowDetailPlaceholder workflowCount={workflows.length} aiaAvailable={aiaAvailable} onRequestAiaPrompt={onRequestAiaPrompt} />}
      </main>
    </div>
  </>;
}

/**
 * "AIA로 만들기"가 채팅으로 보내는 요청문. 개요 헤더와 빈 상태 안내가 같은 문장을 보내야
 * 하므로 한자리에 둔다.
 */
const AIA_WORKFLOW_AUTHOR_PROMPT = "새 시스템 워크플로를 만들고 싶어. 어떤 작업을 자동화할지 먼저 물어보고, system_catalog 작업으로 표현되는지 확인한 뒤 propose_system_workflow_schema로 승인 요약을 보여줘.";

/**
 * 워크플로 작성을 AIA에게 넘기는 버튼. 두는 자리에 따라 아이콘 크기만 다르다.
 *
 * 시스템 에이전트를 고르지 않아 AIA 공급자가 없으면 App의 requestAiaPrompt는 조용히 반환한다.
 * 그대로 두면 눌러도 아무 일도 없고 사유도 없다(QA #29). 상단바 AIA 버튼과 같은 사유 문구를
 * aria-label·title에 싣고 버튼을 막는다. 이 화면은 설정 화면으로 옮기는 경로를 받지 않으므로
 * 상단바처럼 데려가지는 못하고, 사유만 알린다. 모름(`null`)은 막지 않는다.
 */
function AiaAuthorButton({ iconSize, aiaAvailable, onRequestAiaPrompt }: {
  iconSize: number;
  aiaAvailable: boolean | null;
  onRequestAiaPrompt: (prompt: string) => void;
}) {
  const { text } = useI18n();
  const label = text("AIA로 만들기", "Create with AIA");
  const blocked = aiaAvailable === false;
  const hint = blocked
    ? text("시스템 에이전트가 설정되지 않았습니다. 설정에서 시스템 에이전트를 선택하세요.", "No system agent is configured. Choose a system agent in Settings.")
    : label;
  return <button
    className="button primary"
    type="button"
    disabled={blocked}
    aria-disabled={blocked || undefined}
    aria-label={hint}
    title={hint}
    onClick={() => { if (!blocked) onRequestAiaPrompt(AIA_WORKFLOW_AUTHOR_PROMPT); }}
  >
    <Bot size={iconSize} /> {label}
  </button>;
}

/** 화면 위 개요 — 등록 수와 계약 안전 한도, 새로고침·생성 동작. */
function WorkflowOverview({ workflows, limits, hasPacedRound, aiaAvailable, onRefresh, onRequestAiaPrompt }: {
  workflows: SystemWorkflowSummary[];
  limits: SystemWorkflowLimits | undefined;
  hasPacedRound: (workflow: SystemWorkflowSummary) => boolean;
  aiaAvailable: boolean | null;
  onRefresh: () => void;
  onRequestAiaPrompt?: (prompt: string) => void;
}) {
  const compatibleCount = workflows.filter((workflow) => workflow.compatible).length;
  const successfulCount = workflows.filter((workflow) => workflow.lastExecution?.succeeded).length;
  // "대상 계약"이 아니라 실제로 회차가 도는 워크플로 수를 센다 — 배지·상세 표시와 같은 기준.
  const pacedCount = workflows.filter(hasPacedRound).length;

  return <section className="panel workflow-overview">
    <div className="workflow-overview-copy">
      <span className="workflow-overview-icon" aria-hidden="true"><Workflow size={21} /></span>
      <div>
        <span className="workflow-eyebrow">AUTOMATION LIBRARY</span>
        <h2>시스템 워크플로</h2>
        <p>
          AIA가 등록한 안전한 실행 계약을 살펴보고, 필요한 값을 넣어 바로 실행할 수 있습니다.
          등록된 시스템 작업만 순서대로 호출합니다.
        </p>
      </div>
    </div>
    <div className="workflow-overview-actions">
      <button className="icon-button" type="button" onClick={onRefresh} aria-label="새로고침" title="새로고침"><RefreshCw size={15} /></button>
      {onRequestAiaPrompt && <AiaAuthorButton iconSize={15} aiaAvailable={aiaAvailable} onRequestAiaPrompt={onRequestAiaPrompt} />}
    </div>
    <dl className="workflow-overview-stats five">
      <div><dt>등록</dt><dd>{workflows.length}<span>{limits ? ` / ${limits.maxWorkflows}` : "개"}</span></dd></div>
      <div><dt>실행 가능</dt><dd>{compatibleCount}<span>개</span></dd></div>
      <div><dt>페이싱 회차</dt><dd>{pacedCount}<span>개</span></dd></div>
      <div><dt>최근 성공</dt><dd>{successfulCount}<span>개</span></dd></div>
      <div className="workflow-limit-summary">
        <dt><ShieldCheck size={13} /> 계약 안전 한도</dt>
        <dd>{limits ? `단계 ${limits.maxSteps} · 반복 ${limits.maxForEachIterations} · 호출 ${limits.maxTotalOperationCalls}` : "한도 확인 중"}</dd>
      </div>
    </dl>
  </section>;
}

/** 왼쪽 계약 목록. 고른 항목을 알리는 것 말고는 아무 상태도 갖지 않는다. */
function WorkflowCatalogList({ workflows, selectedId, hasPacedRound, onSelect }: {
  workflows: SystemWorkflowSummary[];
  selectedId: string | null;
  hasPacedRound: (workflow: SystemWorkflowSummary) => boolean;
  onSelect: (id: string) => void;
}) {
  return <aside className="panel workflow-catalog" aria-label="워크플로 목록">
    <header className="workflow-panel-heading">
      <div><span>WORKFLOWS</span><strong>등록된 계약</strong></div>
      <em>{workflows.length}</em>
    </header>
    <div className="workflow-list">
      {workflows.length === 0
        ? <div className="workflow-catalog-empty"><CircleDashed size={22} /><strong>아직 워크플로가 없습니다</strong><span>AIA에게 자동화할 작업을 설명해 보세요.</span></div>
        : workflows.map((workflow) => <article
          key={workflow.id}
          className={`workflow-card${selectedId === workflow.id ? " selected" : ""}${workflow.compatible ? "" : " incompatible"}`}
        >
          <button className="workflow-card-main" type="button" onClick={() => onSelect(workflow.id)} aria-pressed={selectedId === workflow.id}>
            <span className={`workflow-card-symbol ${riskClass(workflow.computedRisk)}`} aria-hidden="true"><Workflow size={15} /></span>
            <span className="workflow-card-copy">
              <span className="workflow-card-title"><strong>{workflowName(workflow)}</strong><small>v{workflow.version ?? "?"}</small></span>
              <span>{workflow.description ?? workflow.id}</span>
              <span className="workflow-card-badges">
                <em className={`workflow-risk-badge ${riskClass(workflow.computedRisk)}`}>{riskLabel(workflow.computedRisk)}</em>
                <em className={workflow.compatible ? "compatible" : "blocked"}>{workflow.compatible ? "실행 가능" : "재등록 필요"}</em>
                <em className={workflow.lastExecution ? (workflow.lastExecution.succeeded ? "succeeded" : "failed") : "idle"}>
                  {workflow.lastExecution ? `최근 ${workflow.lastExecution.succeeded ? "성공" : "실패"}` : "실행 전"}
                </em>
                {hasPacedRound(workflow) && <em className="paced">페이싱</em>}
              </span>
            </span>
            <ChevronRight className="workflow-card-chevron" size={15} aria-hidden="true" />
          </button>
        </article>)}
    </div>
  </aside>;
}

/**
 * 페이싱 참여 여부는 계약이 정한다(사용량을 쓰는 계약이면 대상). 사용자가 켜고 끄는 설정이
 * 아니므로 여기서는 상태만 알린다 — 그것도 회차가 실제로 돌 때만이다.
 */
function WorkflowPacingStatus({ mode }: { mode: WorkflowPacingMode | null }) {
  return <div className="workflow-pacing-control" data-ui-anchor="workflows.pacing-status">
    <Gauge size={13} aria-hidden="true" />
    <span>사용량 페이싱</span>
    <HelpHint label="사용량 페이싱 설명" title="사용량 페이싱" popoverClassName="workflow-pacing-help-popover">
      {mode === "envelope"
        ? "페이싱 회차 계약입니다. 회차마다 스케줄러가 계약 바깥에서 사용량 갱신·기동 수 계산·지난 회차 정리·기동·재갱신을 수행하고, 계약은 봉투가 정한 계정으로 뜨는 한 건의 작업만 기술합니다. 회차를 멈추려면 워크플로 페이싱 탭에서 반복 요청을 일시정지하세요."
        : mode === "contract"
          ? "계약 안에서 직접 기동 수를 계산하는 구형 5단계 계약입니다. 백엔드가 뜰 때 회차 봉투 계약으로 자동 이관되며, 그때까지는 기존처럼 돕니다."
          : "무인 런타임을 띄우는 계약이라 이 워크플로를 돌리는 반복 요청은 워크플로 페이싱 탭의 예산 소비자가 되고, 예산이 기동을 통제합니다(회차 계산은 없음)."}
    </HelpHint>
    {mode !== "envelope" && <em>{mode === "contract" ? "구형 계약" : "기동만 통제"}</em>}
  </div>;
}

/** 계약에 고정된 실행 순서와 제어 조건. */
function WorkflowStepList({ steps }: { steps: SystemWorkflowStep[] }) {
  return <section className="workflow-detail-section workflow-steps">
    <header><span><Layers3 size={15} /></span><div><strong>실행 단계</strong><small>계약에 고정된 순서와 제어 조건입니다.</small></div><em>{steps.length}</em></header>
    <div className="workflow-table-wrap"><table>
      <thead><tr><th>단계</th><th>시스템 작업</th><th>제어</th></tr></thead>
      <tbody>
        {steps.map((step, index) => <tr key={step.id}>
          <td><span className="workflow-step-index">{index + 1}</span><code>{step.id}</code></td>
          <td><code>{step.operation}</code></td>
          <td>{[
            step.condition ? "조건" : null,
            step.forEach ? `반복 최대 ${step.forEach.maxIterations}회` : null,
            step.expect ? "사후검증" : null,
          ].filter(Boolean).join(" · ") || "기본 실행"}</td>
        </tr>)}
      </tbody>
    </table></div>
  </section>;
}

/** 방금 돌린 실행 한 건의 결과와 단계별 상태. */
function WorkflowExecutionReport({ execution }: { execution: SystemWorkflowExecution }) {
  return <section className={`workflow-detail-section workflow-execution${execution.succeeded ? " succeeded" : " failed"}`}>
    <header>
      <span>{execution.succeeded ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}</span>
      <div><strong>{execution.succeeded ? "실행 성공" : "실행 실패"}</strong><small>v{execution.version} · {execution.finishedAt - execution.startedAt}ms{execution.failedStepId ? ` · 실패 단계 ${execution.failedStepId}` : ""}{execution.round ? ` · 회차 계획 ${execution.round.plannedRuns}건 · 기동 ${execution.round.launchedRuns}건 · 정리 ${execution.round.staleRuns}건` : ""}</small></div>
    </header>
    {execution.failure && <p>{execution.failure}</p>}
    <ul>{execution.steps.map((step) => <li className={step.status} key={step.stepId}>
      <span>{step.status === "succeeded" ? <CheckCircle2 size={13} /> : step.status === "skipped" ? <CircleDashed size={13} /> : <AlertTriangle size={13} />}</span>
      <code>{step.stepId}</code><strong>{stepStatusLabel(step.status)}</strong>
      {step.iterations > 1 ? <small>{step.iterations}회</small> : null}
      {step.error ? <p>{step.error}</p> : null}
    </li>)}</ul>
  </section>;
}

/** 등록된 버전 이력. 최근 등록 버전부터 보여 준다. */
function WorkflowVersionHistory({ versions }: { versions: SystemWorkflowVersion[] }) {
  return <section className="workflow-detail-section workflow-versions">
    <header><span><Clock3 size={15} /></span><div><strong>버전 이력</strong><small>최근 등록 버전부터 표시합니다.</small></div><em>{versions.length}</em></header>
    <ul>{[...versions].reverse().map((version) => <li key={version.version}>
      <span>v{version.version}</span>
      <div><strong>{riskLabel(version.computedRisk)}</strong><small>시스템 작업 {version.requiredOperations.length}종</small></div>
      <time>{new Date(version.registeredAt).toLocaleString()}</time>
    </li>)}</ul>
  </section>;
}

/** 고른 계약이 없을 때의 안내. 목록이 비었는지에 따라 다음에 할 일이 다르다. */
function WorkflowDetailPlaceholder({ workflowCount, aiaAvailable, onRequestAiaPrompt }: {
  workflowCount: number;
  aiaAvailable: boolean | null;
  onRequestAiaPrompt?: (prompt: string) => void;
}) {
  return <div className="workflow-detail-empty">
    <span aria-hidden="true"><Workflow size={26} /></span>
    <strong>{workflowCount === 0 ? "새 워크플로를 만들어 보세요" : "워크플로를 선택하세요"}</strong>
    <p>{workflowCount === 0 ? "AIA가 자동화할 작업을 확인하고 안전한 실행 계약을 제안합니다." : "왼쪽 목록에서 계약을 고르면 입력, 단계, 버전 이력을 확인할 수 있습니다."}</p>
    {workflowCount === 0 && onRequestAiaPrompt && <AiaAuthorButton iconSize={14} aiaAvailable={aiaAvailable} onRequestAiaPrompt={onRequestAiaPrompt} />}
  </div>;
}

/** 화면에 쓰는 워크플로 이름. 계약이 표시 이름을 주지 않으면 id를 그대로 쓴다. */
function workflowName(workflow: SystemWorkflowSummary): string {
  return workflow.displayName ?? workflow.id;
}

/** 회차의 병렬 실행 설정 표기. 확인 대화와 회차 카드가 같은 문구를 써야 한다. */
function parallelRunsLabel(round: ScheduledRequest, text: (ko: string, en: string) => string): string {
  const maxRuns = round.workflow?.pacing?.maxRuns ?? 1;
  return maxRuns > 1 ? text(`${maxRuns}건`, `${maxRuns} runs`) : text("끔", "off");
}

/** 안내에 쓸 입력 이름. 계약이 표시 이름을 주면 그것을, 없으면 키를 그대로 쓴다. */
function inputLabel(schema: [string, { label?: string | null }][], name: string): string {
  const label = schema.find(([key]) => key === name)?.[1]?.label;
  return label?.trim() ? label : name;
}

function riskLabel(risk: WorkflowRisk | null): string {
  if (risk === "readOnly") return "조회 전용";
  if (risk === "mutating") return "상태 변경";
  if (risk === "destructive") return "파괴적 변경";
  return "위험도 미확인";
}

/** 확인창의 영어 본문에 쓰는 위험도 표기. 배지는 한국어 리터럴로 그려져 정적 치환기가 맡는다. */
function riskLabelEn(risk: WorkflowRisk | null): string {
  if (risk === "readOnly") return "read-only";
  if (risk === "mutating") return "changes state";
  if (risk === "destructive") return "destructive";
  return "risk unknown";
}

function riskClass(risk: WorkflowRisk | null): string {
  if (risk === "readOnly") return "read-only";
  if (risk === "mutating") return "mutating";
  if (risk === "destructive") return "destructive";
  return "unknown";
}

function stepStatusLabel(status: string): string {
  return status === "succeeded" ? "성공" : status === "skipped" ? "건너뜀" : "실패";
}

/**
 * 같은 실행을 두 번 보내지 않기 위한 키. `crypto.randomUUID`는 보안 컨텍스트에서만
 * 있으므로, 원격 접속처럼 없을 수 있는 환경에서는 난수 문자열로 대신한다.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
