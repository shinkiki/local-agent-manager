import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  Gauge,
  GitCompare,
  Layers3,
  Lightbulb,
  ListChecks,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useI18n, type UiText } from "../lib/i18n";
import { WorkflowProcedurePanel } from "./WorkflowProcedurePanel";
import { WorkflowRuntimeEditor } from "./WorkflowRuntimeEditor";
import { WorkflowVersionDiff } from "./WorkflowVersionDiff";
import {
  deleteSharedSkill,
  deleteSystemWorkflow,
  executeSystemWorkflow,
  getSchedulerSnapshot,
  getSystemAutomationSnapshot,
  getSystemWorkflow,
  getSystemWorkflows,
  runScheduledRequestNow,
} from "../lib/ipc";
import { aiaRuntimeProvider } from "../lib/aiaRuntime";
import { useWorkflowModelCatalogs } from "./PacedTriggerEditor";
import { buildWorkflowArguments, validateWorkflowModelInputs, workflowModelInputChoices, workflowInputDefaults } from "../lib/scheduleWorkflow";
import type { TabRequest } from "../lib/uiGuide";
import type {
  ChatAttentionItem,
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
import { ErrorBanner, HelpHint, LoadingState, NoticeBanner, useConfirm, WorkflowInputControl, type ConfirmRequest } from "./Shared";
import { UsageBudgetPanel } from "./UsageBudgetPanel";
import { errorText } from "../lib/errorText";

import { formatDateTime } from "../lib/format";
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
  /** 페이싱 관측이 올린 제안 알림. 페이싱 탭 위에 배너로 깔린다. */
  pacingSuggestions?: readonly ChatAttentionItem[];
}

/**
 * 페이싱 관측이 올린 제안. 알림(종)에서 이 탭으로 넘어온 사용자가 무엇을 보고 조정해야
 * 하는지 같은 화면에서 읽게 한다. 지우기·읽음은 알림창이 맡으므로 여기서는 보여주기만 한다.
 */
function PacingSuggestionBanner({ items }: { items: readonly ChatAttentionItem[] }) {
  const { text } = useI18n();
  if (items.length === 0) return null;
  return <section className="pacing-suggestions" aria-label={text("페이싱 제안", "Pacing suggestions")}>
    {items.map((item) => <article key={item.id} className="pacing-suggestion">
      <Lightbulb size={13} aria-hidden="true" />
      <div>
        <strong>{item.title}</strong>
        {item.detail ? <p>{item.detail}</p> : null}
      </div>
    </article>)}
  </section>;
}

export function WorkflowsView({ active, onRequestAiaPrompt, tabRequest, pacingSuggestions = [] }: Props) {
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
      : <><PacingSuggestionBanner items={pacingSuggestions} /><UsageBudgetPanel active={active} /></>}
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
 * 워크플로마다 표시·실행에 쓸 대표 회차를 고른다. 스케줄러 순서는 그대로 지키되, 같은
 * 워크플로에 켜진 회차가 하나라도 있으면 먼저 만난 일시정지 회차 대신 그것을 쓴다.
 */
function indexPreferredRounds(schedules: readonly ScheduledRequest[]): Map<string, ScheduledRequest> {
  const rounds = new Map<string, ScheduledRequest>();
  for (const schedule of schedules) {
    const workflowId = schedule.workflow?.workflowId;
    if (!workflowId) continue;
    const known = rounds.get(workflowId);
    if (!known || (schedule.enabled && !known.enabled)) rounds.set(workflowId, schedule);
  }
  return rounds;
}

/**
 * 고른 계약 하나를 읽어 입력 폼을 세우는 자리. 선택 id·상세·읽는 중·입력값·계약 스키마와
 * "같은 선택에서도 다시 읽기"(nonce)가 서로만 참조하는 한 덩어리인데, 실행·삭제·오류를 든
 * `useWorkflowCatalog` 본문 한가운데에 120줄로 끼어 있어 실행 갈래를 읽으려면 상세 읽기
 * 효과를 넘어가야 했다. 읽기 쪽을 이 훅으로 가르고, 본문에는 실행 쪽만 남긴다.
 *
 * 바깥과 닿는 두 자리만 콜백으로 받는다 — 선택을 옮겼을 때 지난 실행 흔적을 비우는 것과
 * (`onSwitch`), 읽기 실패를 화면 위 배너에 올리는 것(`onError`)이다. 둘 다 호출부가
 * `useCallback`으로 고정해 넘기므로 이 훅의 효과가 매 렌더 다시 돌지 않는다.
 */
function useWorkflowDetailForm({ onSwitch, onError }: {
  onSwitch: () => void;
  onError: (message: string | null) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SystemWorkflowDetail | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  /**
   * 상세를 다시 읽으라는 신호. 선택 id만으로는 "고른 워크플로의 계약이 바뀌었다"를 나타낼 수
   * 없어, AIA가 계약을 새 버전으로 다시 등록해도 선택이 그대로면 상세가 옛 버전 스냅샷에
   * 머물렀다. 등록된 계약이 하나뿐이면 선택을 옮겼다 되돌릴 수조차 없어 빠져나갈 길이
   * 없었다. 새로고침과 목록 클릭이 이 값을 올려 같은 선택에서도 다시 읽게 한다.
   */
  const [detailNonce, setDetailNonce] = useState(0);
  /** 상세에 이미 담긴 워크플로. 선택을 옮긴 것과 같은 계약을 다시 읽는 것을 가른다. */
  const loadedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedId) { loadedIdRef.current = null; setDetail(null); setDetailLoading(false); return; }
    // 선택을 옮긴 때만 지난 워크플로의 실행 결과·알림을 비우고 읽는 중 표시를 낸다. 같은
    // 계약을 다시 읽는 새로고침까지 비우면 방금 낸 실행 접수증이 사라지고 상세가 깜빡인다.
    const switched = loadedIdRef.current !== selectedId;
    loadedIdRef.current = selectedId;
    let live = true;
    if (switched) {
      setDetail(null);
      setDetailLoading(true);
      onSwitch();
    }
    void (async () => {
      try {
        const loaded = await getSystemWorkflow(selectedId);
        if (!live) return;
        setDetail(loaded);
        // 계약이 기본값을 선언한 입력은 미리 채운 상태로 보여 준다. 값이 매번 같은
        // 워크플로를 열자마자 실행 버튼만 눌러 돌릴 수 있어야 한다. 같은 계약을 다시 읽은
        // 때는 채우던 값을 지키고, 새 버전이 더한 입력만 기본값으로 채운다.
        const entries = Object.entries(loaded.contract?.inputSchema ?? {});
        const defaults = workflowInputDefaults(entries);
        setInputs((current) => {
          if (switched) return defaults;
          const declared = new Set(entries.map(([name]) => name));
          const kept = Object.entries(current).filter(([name]) => declared.has(name));
          return { ...defaults, ...Object.fromEntries(kept) };
        });
        onError(null);
      } catch (cause) {
        if (live) onError(errorText(cause));
      } finally {
        if (live) setDetailLoading(false);
      }
    })();
    return () => { live = false; };
  }, [selectedId, detailNonce, onSwitch, onError]);

  const schema = useMemo(
    () => Object.entries(detail?.contract?.inputSchema ?? {}),
    [detail],
  );
  /** 계약 기본값으로 채워진 입력 수. 폼에 들어 있는 값이 어디서 왔는지 알려 준다. */
  const prefilledCount = useMemo(
    () => schema.filter(([, field]) => field.defaultValue !== undefined && field.defaultValue !== null).length,
    [schema],
  );

  /**
   * 목록에서 항목을 고른다. 이미 고른 항목을 다시 눌러도 상세를 다시 읽는다 — 등록된 계약이
   * 하나뿐이면 그 재클릭이 사용자에게 남은 유일한 갱신 수단이다.
   */
  const select = useCallback((id: string) => {
    setSelectedId(id);
    setDetailNonce((nonce) => nonce + 1);
  }, []);

  /**
   * 새로 받은 목록에 선택을 맞춘다. 고른 계약이 사라졌으면 첫 항목으로 옮기고, 그대로여도
   * 상세를 다시 읽게 해 새로고침 한 번으로 화면 전체가 저장된 계약과 맞아떨어지게 한다.
   */
  const syncSelection = useCallback((workflows: readonly SystemWorkflowSummary[]) => {
    setSelectedId((current) => (
      current && workflows.some((workflow) => workflow.id === current)
        ? current
        : workflows[0]?.id ?? null
    ));
    setDetailNonce((nonce) => nonce + 1);
  }, []);

  const clearSelection = useCallback(() => setSelectedId(null), []);

  const setInput = useCallback((name: string, value: string) => {
    setInputs((current) => ({ ...current, [name]: value }));
  }, []);

  return { selectedId, detail, detailLoading, inputs, schema, prefilledCount, select, syncSelection, clearSelection, setInput };
}

/**
 * 워크플로 관리 탭의 상태와 동작 전부. 목록·회차 색인·실행 결과·오류를 들고, 실행(회차
 * 1건·워크플로)·삭제·새로고침을 낸다. 고른 계약을 읽어 폼을 세우는 일은
 * `useWorkflowDetailForm`이 맡는다. 패널 컴포넌트가 아니라 화면이 부르므로 탭을 오가도
 * 살아 있다.
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
  /**
   * 삭제 결과 안내. 상세 패널의 `notice`에 둘 수 없다 — 삭제가 끝나면 선택이 다른 워크플로로
   * 옮겨가고, 그 전환이 지난 실행 흔적(`clearRunTrace`)과 함께 안내까지 비워 "스킬도 같이
   * 지웠다"는 말이 렌더 한 번 만에 사라진다. 사라진 워크플로에 대한 말이라 선택과 함께
   * 살아서도 안 되므로 목록 위에 따로 둔다. `failed`면 실패 배너로 보여 준다.
   */
  const [removal, setRemoval] = useState<{ message: string; failed: boolean } | null>(null);
  const modelCatalogs = useWorkflowModelCatalogs();
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
  const runSectionRef = useRef<HTMLElement>(null);
  const { confirm, confirmDialog } = useConfirm();

  /**
   * 선택을 다른 워크플로로 옮겼을 때 지난 계약의 실행 흔적을 비운다. 접수증·멱등 키·실행
   * 오류·안내·빈 칸 표시는 모두 "방금 그 워크플로에서 일어난 일"이라, 남겨 두면 새로 고른
   * 계약의 것처럼 보인다.
   */
  const clearRunTrace = useCallback(() => {
    setExecution(null);
    setLastKey(null);
    setActionError(null);
    setNotice(null);
    setMissingInputs([]);
  }, []);
  const {
    selectedId, detail, detailLoading, inputs, schema, prefilledCount,
    select, syncSelection, clearSelection, setInput,
  } = useWorkflowDetailForm({ onSwitch: clearRunTrace, onError: setError });

  const refresh = useCallback(async () => {
    try {
      const loaded = await getSystemWorkflows();
      setList(loaded);
      syncSelection(loaded.workflows);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
    // 회차 정보는 표시용 부가 정보다. 못 읽어도 목록·실행은 그대로 쓰이게 오류를 겹치지 않고,
    // 그때는 페이싱 표시만 빠진다.
    try {
      const scheduler = await getSchedulerSnapshot();
      setRoundsByWorkflow(indexPreferredRounds(scheduler.schedules));
    } catch {
      setRoundsByWorkflow(new Map());
    }
  }, [syncSelection]);

  useEffect(() => { if (active) void refresh(); }, [active, refresh]);

  /** 페이싱 회차 계약이면 그 워크플로를 도는 회차. 실행 버튼은 이 회차를 한 번 돌린다. */
  const pacedRound = detail?.pacingMode === "envelope" ? roundsByWorkflow.get(detail.id) ?? null : null;
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

  /**
   * 실행 전 검사가 막았을 때의 되돌림. 빈 필수 입력과 모르는 모델 값은 표시할 자리가 서로
   * 다를 뿐(칸 표시 · 오류 문구) 뒤처리가 같았다 — 둘 다 오류를 위쪽 배너에만 남기면 실행
   * 버튼을 보고 있는 사용자에게는 아무 반응이 없는 것처럼 보이므로, 표시한 뒤 실행 칸으로
   * 화면을 옮긴다. 두 갈래가 각자 적던 `scrollIntoView`와 "다른 쪽 표시는 비운다"를 모은다.
   */
  const rejectRun = ({ missing = [], problem = null }: { missing?: string[]; problem?: string | null }) => {
    setMissingInputs(missing);
    setActionError(problem);
    runSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  /**
   * 회차 1건 실행: 저장된 인자·병렬 설정으로 그 회차를 지금 한 번 돌린다. 스케줄러가
   * 다음 틱에 집어 봉투(갱신·계산·정리·기동·재갱신)를 두른다.
   */
  const runPacedRound = async (workflow: SystemWorkflowDetail, round: ScheduledRequest) => {
    const accepted = await confirm(pacedRoundRunConfirm(workflow, round, text));
    if (!accepted) return;
    setNotice(null);
    await runAction(async () => {
      await runScheduledRequestNow(round.id);
      setExecution(null);
      setNotice(text(
        `회차 '${round.name}' 실행을 요청했습니다. 스케줄러가 다음 틱(15초 이내)에 시작하며, 진행과 결과는 워크플로 페이싱 탭의 회차 카드와 반복 요청 기록에서 볼 수 있습니다.`,
        `Requested a run of round '${round.name}'. The scheduler starts it on the next tick (within 15 s); progress and results appear on the round card in the Workflow pacing tab and in the recurring request history.`,
      ));
      await refresh();
    });
  };

  /**
   * 폼에 넣은 값으로 승인된 버전을 지금 한 번 실행한다. 실행 전 검사(빈 필수 입력·카탈로그에
   * 없는 모델)는 이 갈래에만 있다 — 회차 실행은 저장된 인자를 쓰므로 검사할 폼이 없다.
   * 버전은 호출부가 확인한 값을 인자로 받는다. 콜백 안에서는 `detail.version`의 non-null
   * 좁힘이 풀리기 때문이다.
   */
  const runWithInputs = async (workflow: SystemWorkflowDetail, version: number, retryKey?: string) => {
    const missing = schema
      .filter(([name, field]) => field.required && field.type !== "boolean" && !(inputs[name] ?? "").trim())
      .map(([name]) => name);
    if (missing.length > 0) {
      rejectRun({ missing });
      return;
    }
    setMissingInputs([]);
    // 선택지와 실행 전 검사가 같은 공급자 카탈로그를 사용한다.
    const modelProblems = validateWorkflowModelInputs(schema, inputs, modelCatalogs);
    if (modelProblems.length > 0) {
      rejectRun({ problem: modelProblems.join("\n") });
      return;
    }
    const accepted = await confirm(workflowRunConfirm(workflow, version, text));
    if (!accepted) return;

    const key = retryKey ?? newIdempotencyKey();
    await runAction(async () => {
      setLastKey(key);
      const receipt = await executeSystemWorkflow(workflow.id, key, buildWorkflowArguments(schema, inputs), version);
      setExecution(receipt);
      await refresh();
    });
  };

  const run = async (retryKey?: string) => {
    if (!detail || !detail.version) {
      setActionError(text(
        "승인된 워크플로 버전을 확인할 수 없어 실행할 수 없습니다. AIA가 계약을 다시 등록해야 합니다.",
        "Cannot run because the approved workflow version is unknown. AIA must register the contract again.",
      ));
      return;
    }
    // 회차가 도는 페이싱 계약이면 그 회차를 한 번 돌리고, 그 밖은 폼 입력으로 실행한다.
    if (pacedRound) await runPacedRound(detail, pacedRound);
    else await runWithInputs(detail, detail.version, retryKey);
  };

  /**
   * 계약과 그 절차를 함께 지운다. 워크플로는 단계 목록일 뿐이고 실제 절차는 계약이
   * `requiredSkills`로 거는 보관 스킬에 적혀 있어, 계약만 지우면 아무도 부르지 않는 절차
   * 스킬이 스킬 화면에 남는다. 그래서 삭제 확인에서 한 번 더 묻고, 고른 때만 같이 지운다.
   * 기본값은 끔이다 — 스킬 삭제는 이 워크플로 밖의 자산을 건드리므로 사용자가 골라야 한다.
   */
  const remove = async (workflow: SystemWorkflowSummary) => {
    const skills = relatedSkillKeys(workflow, list?.workflows ?? []);
    let alsoSkills = false;
    const accepted = await confirm(workflowDeleteConfirm(workflow, text, skills, (checked) => { alsoSkills = checked; }));
    if (!accepted) return;
    setRemoval(null);
    await runAction(async () => {
      // 워크플로를 먼저 지운다. 스킬만 먼저 사라지면 실패한 순간 절차 없는 계약이 남는다.
      await deleteSystemWorkflow(workflow.id);
      const deleted: string[] = [];
      const failed: string[] = [];
      if (alsoSkills) {
        // 스킬 하나가 실패해도 나머지는 계속 지운다. 중간에 멈추면 무엇이 남았는지 알 수 없다.
        for (const key of skills.exclusive) {
          try {
            await deleteSharedSkill(key);
            deleted.push(key);
          } catch (cause) {
            failed.push(`${key}: ${errorText(cause)}`);
          }
        }
      }
      if (selectedId === workflow.id) clearSelection();
      await refresh();
      setRemoval(removalNotice(workflowName(workflow), deleted, failed, text));
    });
  };

  const changeInput = (name: string, value: string) => {
    setInput(name, value);
    // 채우는 즉시 그 칸의 표시를 걷어 남은 칸만 남긴다.
    if (value.trim()) setMissingInputs((current) => current.filter((missing) => missing !== name));
  };

  const reloadRuntime = async () => {
    if (!selectedId) return;
    setNotice(text(
      "실행설정을 새 버전으로 저장했습니다. 기존 페이싱 회차는 페이싱 탭의 회차 편집기에서 다시 저장해야 적용됩니다.",
      "Runtime settings saved as a new version. Re-save existing rounds in the pacing tab to apply it.",
    ));
    // 새로고침이 목록과 상세를 함께 다시 읽으므로 방금 저장한 버전이 그대로 올라온다.
    await refresh();
  };

  return {
    list, error, actionError, notice, removal, selectedId, detail, detailLoading, inputs, execution, lastKey,
    missingInputs, busy, schema, prefilledCount, pacedRound, hasPacedRound, runSectionRef, confirmDialog,
    refresh, run, remove, select, changeInput, reloadRuntime, modelCatalogs,
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
    list, error, removal, selectedId, detail, detailLoading, execution, lastKey,
    busy, hasPacedRound, refresh, run, remove, select,
  } = catalog;

  if (!list && !error) return <LoadingState label={text("등록된 워크플로를 확인하고 있습니다", "Loading registered workflows")} />;

  const workflows = list?.workflows ?? [];

  return <>
    {error && <ErrorBanner message={error} />}
    {/* 방금 지운 워크플로의 결과. 선택이 다른 계약으로 옮겨가도 남아 있어야 읽힌다. */}
    {removal && (removal.failed
      ? <ErrorBanner message={removal.message} />
      : <NoticeBanner message={removal.message} />)}

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
        {detailLoading ? <LoadingState label={text("워크플로 계약을 읽고 있습니다", "Loading the workflow contract")} /> : detail ? <>
          <WorkflowDetailHeader detail={detail} busy={busy} onRemove={() => void remove(detail)} />

          <WorkflowDetailActions
            detail={detail}
            busy={busy}
            paced={hasPacedRound(detail)}
            retryKey={lastKey && execution && !execution.succeeded && execution.retryable ? lastKey : null}
            onRun={(retryKey) => void run(retryKey)}
          />

          <WorkflowDetailMeta detail={detail} />

          <WorkflowDetailBody catalog={catalog} detail={detail} />
        </> : <WorkflowDetailPlaceholder workflowCount={workflows.length} aiaAvailable={aiaAvailable} onRequestAiaPrompt={onRequestAiaPrompt} />}
      </main>
    </div>
  </>;
}

/**
 * 상세 판이 거는 경고 한 장. 호환되지 않는 계약과 복구가 어려운 영향이 같은
 * `아이콘 + 제목 + 본문` 껍데기를 각자 적고 있어, 한쪽에서 아이콘 크기나 태그를 바꾸면
 * 그 경고만 다른 모양이 되던 자리다. 본문은 문단이기도 목록이기도 해서 자식으로 받는다.
 */
function WorkflowWarning({ title, children }: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="workflow-warning">
      <AlertTriangle size={16} aria-hidden="true" />
      <div><strong>{title}</strong>{children}</div>
    </div>
  );
}

/**
 * 고른 계약의 상세 본문. 머리줄·실행 버튼·메타는 이미 각자 조각인데 그 아래 40줄(경고 둘,
 * 실행 칸, 실행설정, 절차, 단계, 접수증, 버전 이력)만 패널 본문에 남아 있어, 목록·개요·
 * 선택 갈래를 읽으려면 이 마크업을 먼저 지나야 했다. 훑기 상태를 열 몇 개로 풀어 받으면
 * 그것대로 긴 인자 목록이 되므로, 패널이 이미 통째로 받는 `catalog`를 그대로 넘긴다 —
 * 좁혀진 `detail`만 따로 받아 여기서 다시 null을 묻지 않는다.
 */
function WorkflowDetailBody({ catalog, detail }: {
  catalog: WorkflowCatalogState;
  detail: SystemWorkflowDetail;
}) {
  const { text } = useI18n();
  const {
    actionError, notice, inputs, execution, missingInputs, busy, schema, prefilledCount,
    pacedRound, runSectionRef, changeInput, reloadRuntime, modelCatalogs,
  } = catalog;

  return (
    <div className="workflow-detail-body">
      {actionError && <div className="workflow-action-error"><ErrorBanner message={actionError} /></div>}
      {notice && <div className="schedule-workflow-note" role="status"><p>{notice}</p></div>}
      {!detail.compatible && (
        <WorkflowWarning title={text("현재 카탈로그와 호환되지 않습니다", "Not compatible with the current catalog")}>
          <p>{text("AIA가 계약을 다시 승인·등록해야 실행할 수 있습니다.", "AIA must approve and register the contract again before it can run.")}</p>
        </WorkflowWarning>
      )}
      {(detail.hardToRecoverEffects?.length ?? 0) > 0 && (
        <WorkflowWarning title={text("복구가 어려운 영향", "Hard to recover effects")}>
          <ul>{detail.hardToRecoverEffects?.map((effect) => <li key={effect}>{effect}</li>)}</ul>
        </WorkflowWarning>
      )}

      <WorkflowRunSection
        sectionRef={runSectionRef}
        pacedRound={pacedRound}
        schema={schema}
        prefilledCount={prefilledCount}
        missingInputs={missingInputs}
        inputs={inputs}
        modelCatalogs={modelCatalogs}
        onChangeInput={changeInput}
      />

      {detail.contract?.steps.some((step) => step.operation === "start_chat") && <WorkflowRuntimeEditor
        key={`${detail.id}:${detail.version}`}
        contract={detail.contract}
        disabled={busy || !detail.compatible}
        onSaved={reloadRuntime}
      />}

      {detail.contract && <WorkflowProcedurePanel
        contract={detail.contract}
        missingSkills={detail.missingSkills ?? []}
      />}

      <WorkflowStepList steps={detail.contract?.steps ?? []} />

      {execution && <WorkflowExecutionReport execution={execution} />}

      {detail.versions.length > 0 && <WorkflowVersionHistory versions={detail.versions} />}
    </div>
  );
}

/**
 * 고른 워크플로의 머리줄. 위험도 표시는 아이콘·배지가 함께 쓰므로 한 번만 뽑아 쓴다.
 */
function WorkflowDetailHeader({ detail, busy, onRemove }: {
  detail: SystemWorkflowDetail;
  busy: boolean;
  onRemove: () => void;
}) {
  const { text } = useI18n();
  const risk = riskView(detail.computedRisk, text);
  return (
    <header className="workflow-detail-header">
      <div className="workflow-detail-title">
        <span className={`workflow-detail-symbol ${risk.className}`} aria-hidden="true"><Workflow size={19} /></span>
        <div>
          <div className="workflow-detail-badges">
            <span className={`workflow-risk-badge ${risk.className}`}>{risk.label}</span>
            <span className={detail.compatible ? "workflow-compatible-badge" : "workflow-incompatible-badge"}>{detail.compatible ? text("현재 카탈로그 호환", "Compatible with the current catalog") : text("재등록 필요", "Needs re-registration")}</span>
          </div>
          {/* 계약 설명은 길어서 헤더를 통째로 밀어낸다. 두 줄만 남기고 전문은 (?)로 옮긴다. */}
          <h2>{workflowName(detail)}<HelpHint
            label={text(`${workflowName(detail)} 설명`, `About ${workflowName(detail)}`)}
            title={workflowName(detail)}
            footer={<code className="workflow-help-id">{detail.id}</code>}
          >{detail.description ?? detail.id}</HelpHint></h2>
          {detail.description && <p>{detail.description}</p>}
        </div>
      </div>
      <button className="icon-button danger" type="button" disabled={busy} onClick={onRemove} aria-label={text("워크플로 삭제", "Delete workflow")} title={text("워크플로 삭제", "Delete workflow")}><Trash2 size={14} /></button>
    </header>
  );
}

/**
 * 실행·페이싱은 제목과 섞이지 않게 헤더 아래 전용 줄에 오른쪽 정렬로 모은다.
 * `retryKey`가 있으면 같은 멱등 키로 다시 보내는 버튼을 함께 둔다 — 다시 보낼 키가 있는지는
 * 실행 결과가 정하므로 판정은 호출부에 두고, 여기는 키의 유무만 본다.
 */
function WorkflowDetailActions({ detail, busy, paced, retryKey, onRun }: {
  detail: SystemWorkflowDetail;
  busy: boolean;
  paced: boolean;
  retryKey: string | null;
  onRun: (retryKey?: string) => void;
}) {
  const { text } = useI18n();
  return (
    <div className="workflow-detail-actions">
      {paced && <WorkflowPacingStatus mode={detail.pacingMode ?? null} />}
      {retryKey && <button
        className="button"
        type="button"
        disabled={busy}
        onClick={() => onRun(retryKey)}
      ><RotateCcw size={14} /> {text("같은 키로 재시도", "Retry with the same key")}</button>}
      <button
        className="button primary"
        type="button"
        disabled={busy || !detail.compatible || !detail.version}
        onClick={() => onRun()}
      ><Play size={14} /> {busy ? text("실행 중…", "Running…") : text("워크플로 실행", "Run workflow")}</button>
    </div>
  );
}

/** 계약을 식별하는 값들. 버전·단계 수·작업 종수·계약 지문을 한 줄로 놓는다. */
function WorkflowDetailMeta({ detail }: { detail: SystemWorkflowDetail }) {
  const { text } = useI18n();
  return (
    <dl className="workflow-detail-meta">
      <div><dt>{text("버전", "Version")}</dt><dd>v{detail.version ?? "?"}</dd></div>
      <div><dt>{text("단계", "Steps")}</dt><dd>{text(`${detail.contract?.steps.length ?? 0}개`, `${detail.contract?.steps.length ?? 0}`)}</dd></div>
      <div><dt>{text("시스템 작업", "System operations")}</dt><dd>{text(`${detail.requiredOperations?.length ?? 0}종`, `${detail.requiredOperations?.length ?? 0}`)}</dd></div>
      <div><dt>{text("계약 지문", "Contract digest")}</dt><dd title={detail.contractDigest ?? undefined}>{detail.contractDigest ? `${detail.contractDigest.slice(0, 12)}…` : text("없음", "None")}</dd></div>
    </dl>
  );
}

/**
 * 상세 패널의 한 칸. 실행 입력·실행 단계·실행 결과·버전 이력 네 자리가 바깥 테두리와
 * `아이콘 · 제목 · 설명 · (오른쪽 개수)` 머리줄을 글자 단위로 같게 적고 있었다. 머리줄의
 * 칸 순서가 곧 스타일 규칙이라 한 자리만 고쳐도 네 칸이 어긋나므로 껍데기를 한 벌로 모은다.
 * 칸마다 다른 것은 변형 클래스와 머리줄에 담는 값뿐이고, 개수와 머리줄 버튼은 있는 칸에만
 * 붙는다 — `undefined`면 그 자리에 아무것도 그리지 않아 없던 칸의 DOM이 그대로 유지된다.
 */
function WorkflowDetailSection({ variant, icon, title, note, action, count, sectionRef, children }: {
  /** `workflow-detail-section` 뒤에 붙는 변형 클래스. 실행 결과처럼 상태 클래스를 함께 실어도 된다. */
  variant: string;
  icon: ReactNode;
  title: ReactNode;
  note: ReactNode;
  /** 머리줄 오른쪽 버튼(버전 비교 등). 개수보다 앞에 온다. */
  action?: ReactNode;
  count?: number;
  sectionRef?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  return <section className={`workflow-detail-section ${variant}`} ref={sectionRef}>
    <header>
      <span>{icon}</span>
      <div><strong>{title}</strong><small>{note}</small></div>
      {action}
      {count === undefined ? null : <em>{count}</em>}
    </header>
    {children}
  </section>;
}

/**
 * 실행 칸. 회차가 도는 페이싱 계약이면 저장된 인자를 읽기 전용으로 보이고(이 화면에서 고치지
 * 않는다), 그 밖은 폼 입력을 그린다. 실행 전 검사가 막았을 때 화면을 여기로 옮기므로
 * 바깥 참조를 받는다.
 */
function WorkflowRunSection({ sectionRef, pacedRound, schema, prefilledCount, missingInputs, inputs, modelCatalogs, onChangeInput }: {
  sectionRef: WorkflowCatalogState["runSectionRef"];
  pacedRound: WorkflowCatalogState["pacedRound"];
  schema: WorkflowCatalogState["schema"];
  prefilledCount: number;
  missingInputs: string[];
  inputs: Record<string, string>;
  modelCatalogs: WorkflowCatalogState["modelCatalogs"];
  onChangeInput: (name: string, value: string) => void;
}) {
  const { text } = useI18n();
  return (
    <WorkflowDetailSection
      variant="workflow-run-section"
      sectionRef={sectionRef}
      icon={<ListChecks size={15} />}
      title={pacedRound ? text("회차 1건 실행", "Run one round") : text("실행 입력", "Run inputs")}
      note={workflowRunSectionNote(pacedRound, schema.length, prefilledCount, text)}
    >
      {pacedRound ? <>
        {Object.keys(pacedRound.workflow?.arguments ?? {}).length > 0 && <ul className="workflow-round-arguments">
          {Object.entries(pacedRound.workflow?.arguments ?? {}).map(([name, value]) => <li key={name}><code>{inputLabel(schema, name)}</code> {String(value).length > 80 ? `${String(value).slice(0, 80)}…` : String(value)}</li>)}
        </ul>}
      </> : <>
      {missingInputs.length > 0 && <p className="workflow-input-problem" role="alert">
        <AlertTriangle size={13} aria-hidden="true" />
        {text(`필수 입력 ${missingInputs.length}개를 채워야 실행할 수 있습니다:`, `Fill in ${missingInputs.length} required inputs before running:`)} {missingInputs.map((name) => inputLabel(schema, name)).join(", ")}
      </p>}
      {schema.length > 0 && <div className="workflow-inputs">
        {schema.map(([name, field]) => <WorkflowInputControl
          key={name}
          name={name}
          field={field}
          value={inputs[name] ?? ""}
          invalid={missingInputs.includes(name)}
          choices={workflowModelInputChoices(name, modelCatalogs)}
          onChange={(value) => onChangeInput(name, value)}
        />)}
      </div>}
      </>}
    </WorkflowDetailSection>
  );
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

/**
 * 개요 숫자는 같은 워크플로 목록에서 함께 만든다. 각 숫자가 따로 목록 전체를 훑으면 새 통계가
 * 붙을 때마다 순회와 판정 위치가 늘어나므로, 표시 기준을 한 벌로 모아 둔다.
 */
function workflowOverviewCounts(
  workflows: SystemWorkflowSummary[],
  hasPacedRound: (workflow: SystemWorkflowSummary) => boolean,
) {
  let compatible = 0;
  let successful = 0;
  let paced = 0;
  for (const workflow of workflows) {
    if (workflow.compatible) compatible += 1;
    if (workflow.lastExecution?.succeeded) successful += 1;
    // "대상 계약"이 아니라 실제로 회차가 도는 워크플로 수를 센다 — 배지·상세 표시와 같은 기준.
    if (hasPacedRound(workflow)) paced += 1;
  }
  return { compatible, successful, paced };
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
  // 숫자가 끼는 머리말·통계 라벨은 정적 대응표로 만들 수 없어 컴포넌트가 언어마다 문장을
  // 통째로 든다(QA #93 — 영어 UI에서 제목 한 줄만 빼고 이 패널 전체가 한국어로 남았다).
  const { text } = useI18n();
  const counts = workflowOverviewCounts(workflows, hasPacedRound);
  const unit = text("개", "");
  const refreshLabel = text("새로고침", "Refresh");

  return <section className="panel workflow-overview">
    <div className="workflow-overview-copy">
      <span className="workflow-overview-icon" aria-hidden="true"><Workflow size={21} /></span>
      <div>
        <span className="workflow-eyebrow">AUTOMATION LIBRARY</span>
        <h2>{text("시스템 워크플로", "System workflows")}</h2>
        <p>{text(
          "AIA가 등록한 안전한 실행 계약을 살펴보고, 필요한 값을 넣어 바로 실행할 수 있습니다. 등록된 시스템 작업만 순서대로 호출합니다.",
          "Review the safe execution contracts AIA registered, fill in the values they need, and run them right away. They call only registered system operations, in order.",
        )}</p>
      </div>
    </div>
    <div className="workflow-overview-actions">
      <button className="icon-button" type="button" onClick={onRefresh} aria-label={refreshLabel} title={refreshLabel}><RefreshCw size={15} /></button>
      {onRequestAiaPrompt && <AiaAuthorButton iconSize={15} aiaAvailable={aiaAvailable} onRequestAiaPrompt={onRequestAiaPrompt} />}
    </div>
    <dl className="workflow-overview-stats five">
      <div><dt>{text("등록", "Registered")}</dt><dd>{workflows.length}<span>{limits ? ` / ${limits.maxWorkflows}` : unit}</span></dd></div>
      <div><dt>{text("실행 가능", "Runnable")}</dt><dd>{counts.compatible}<span>{unit}</span></dd></div>
      <div><dt>{text("페이싱 회차", "Paced rounds")}</dt><dd>{counts.paced}<span>{unit}</span></dd></div>
      <div><dt>{text("최근 성공", "Last succeeded")}</dt><dd>{counts.successful}<span>{unit}</span></dd></div>
      <div className="workflow-limit-summary">
        <dt><ShieldCheck size={13} /> {text("계약 안전 한도", "Contract safety limits")}</dt>
        <dd>{limits
          ? text(
              `단계 ${limits.maxSteps} · 반복 ${limits.maxForEachIterations} · 호출 ${limits.maxTotalOperationCalls}`,
              `steps ${limits.maxSteps} · loops ${limits.maxForEachIterations} · calls ${limits.maxTotalOperationCalls}`,
            )
          : text("한도 확인 중", "Checking limits")}</dd>
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
  const { text } = useI18n();
  return <aside className="panel workflow-catalog" aria-label={text("워크플로 목록", "Workflow list")}>
    <header className="workflow-panel-heading">
      <div><span>WORKFLOWS</span><strong>{text("등록된 계약", "Registered contracts")}</strong></div>
      <em>{workflows.length}</em>
    </header>
    <div className="workflow-list">
      {workflows.length === 0
        ? <div className="workflow-catalog-empty"><CircleDashed size={22} /><strong>{text("아직 워크플로가 없습니다", "No workflows yet")}</strong><span>{text("AIA에게 자동화할 작업을 설명해 보세요.", "Describe the work you want automated to AIA.")}</span></div>
        : workflows.map((workflow) => <WorkflowCatalogCard
          key={workflow.id}
          workflow={workflow}
          selected={selectedId === workflow.id}
          paced={hasPacedRound(workflow)}
          onSelect={onSelect}
        />)}
    </div>
  </aside>;
}

/**
 * 목록의 계약 한 장. 카드 마크업이 목록의 `map` 안에 25줄로 들어 있어, 비어 있을 때의 안내와
 * 한 장의 배치가 같은 삼항 하나에 묶여 있었다 — 배지를 하나 더하면 목록 컴포넌트가 그만큼
 * 길어지고, 상세 쪽 카드(`WorkflowDetailHeader`)와 나란히 견주기도 어려웠다.
 *
 * 위험도 뷰는 여기서 한 번만 뽑는다. 아이콘 색·배지 색·배지 문구 세 자리가 각자
 * `riskView(workflow.computedRisk, text)`를 다시 불러, 한 자리만 다른 값을 보게 고쳐도
 * 읽어서는 갈라지지 않았다 — 상세 머리줄은 이미 한 번만 뽑는 쪽이다. 최근 실행 배지도
 * `workflowLastRunView` 헬퍼가 색과 문구를 한 벌로 세운다.
 */
function WorkflowCatalogCard({ workflow, selected, paced, onSelect }: {
  workflow: SystemWorkflowSummary;
  selected: boolean;
  /** 이 워크플로를 도는 회차가 실제로 켜져 있는지. 판정은 목록이 받아 온 그대로다. */
  paced: boolean;
  onSelect: (id: string) => void;
}) {
  const { text } = useI18n();
  const risk = riskView(workflow.computedRisk, text);
  const lastRun = workflowLastRunView(workflow.lastExecution, text);
  return <article className={`workflow-card${selected ? " selected" : ""}${workflow.compatible ? "" : " incompatible"}`}>
    <button className="workflow-card-main" type="button" onClick={() => onSelect(workflow.id)} aria-pressed={selected}>
      <span className={`workflow-card-symbol ${risk.className}`} aria-hidden="true"><Workflow size={15} /></span>
      <span className="workflow-card-copy">
        <span className="workflow-card-title"><strong>{workflowName(workflow)}</strong><small>v{workflow.version ?? "?"}</small></span>
        <span>{workflow.description ?? workflow.id}</span>
        <span className="workflow-card-badges">
          <em className={`workflow-risk-badge ${risk.className}`}>{risk.label}</em>
          <em className={workflow.compatible ? "compatible" : "blocked"}>{workflow.compatible ? text("실행 가능", "Runnable") : text("재등록 필요", "Needs re-registration")}</em>
          <em className={lastRun.className}>{lastRun.label}</em>
          {paced && <em className="paced">{text("페이싱", "Paced")}</em>}
          {/* 실행은 막히지 않지만 절차가 없어 의도대로 돌지 않는다. 계약을 옮겨 받은
              장치에서 가장 먼저 알아야 할 사실이라 목록 배지까지 올린다. */}
          {(workflow.missingSkills?.length ?? 0) > 0 && <em className="blocked">{text("스킬 없음", "Skill missing")}</em>}
        </span>
      </span>
      <ChevronRight className="workflow-card-chevron" size={15} aria-hidden="true" />
    </button>
  </article>;
}

/**
 * 페이싱 모드별 설명과 꼬리 배지. 설명은 모드를 가르는 사다리로, 배지는 "봉투가 아니면"과
 * "구형이면"을 따로 물어 같은 모드를 두 번 판정했다 — 모드를 하나 더하면 배지 쪽 사다리가
 * 조용히 "기동만 통제"로 떨어진다. 모드당 한 줄로 모으고, 배지가 없는 모드는 `null`로 적는다.
 * 모드를 못 읽은 계약은 기동만 통제하는 것으로 읽는다(백엔드의 기본값과 같다).
 */
const PACING_MODE_VIEWS: Record<WorkflowPacingMode, { hint: (text: UiText) => string; badge: ((text: UiText) => string) | null }> = {
  envelope: {
    hint: (text) => text(
      "페이싱 회차 계약입니다. 회차마다 스케줄러가 계약 바깥에서 사용량 갱신·기동 수 계산·지난 회차 정리·기동·재갱신을 수행하고, 계약은 봉투가 정한 계정으로 뜨는 한 건의 작업만 기술합니다. 회차를 멈추려면 워크플로 페이싱 탭에서 반복 요청을 일시정지하세요.",
      "A paced-round contract. Each round, the scheduler refreshes usage, computes the launch count, clears stale runs, launches, and refreshes again outside the contract; the contract itself describes only the single job that starts with the account the envelope picked. To stop the rounds, pause the repeating request on the workflow pacing tab.",
    ),
    badge: null,
  },
  contract: {
    hint: (text) => text(
      "계약 안에서 직접 기동 수를 계산하는 구형 5단계 계약입니다. 백엔드가 뜰 때 회차 봉투 계약으로 자동 이관되며, 그때까지는 기존처럼 돕니다.",
      "A legacy five-step contract that computes the launch count itself. It migrates to the round envelope contract when the backend starts, and runs as before until then.",
    ),
    badge: (text) => text("구형 계약", "Legacy contract"),
  },
  launchGate: {
    hint: (text) => text(
      "무인 런타임을 띄우는 계약이라 이 워크플로를 돌리는 반복 요청은 워크플로 페이싱 탭의 예산 소비자가 되고, 예산이 기동을 통제합니다(회차 계산은 없음).",
      "The contract starts an unattended runtime, so a repeating request that runs this workflow becomes a budget consumer on the workflow pacing tab and the budget gates its launches (no round math).",
    ),
    badge: (text) => text("기동만 통제", "Launch gating only"),
  },
};

/**
 * 페이싱 참여 여부는 계약이 정한다(사용량을 쓰는 계약이면 대상). 사용자가 켜고 끄는 설정이
 * 아니므로 여기서는 상태만 알린다 — 그것도 회차가 실제로 돌 때만이다.
 */
function WorkflowPacingStatus({ mode }: { mode: WorkflowPacingMode | null }) {
  const { text } = useI18n();
  const view = PACING_MODE_VIEWS[mode ?? "launchGate"];
  return <div className="workflow-pacing-control" data-ui-anchor="workflows.pacing-status">
    <Gauge size={13} aria-hidden="true" />
    <span>{text("사용량 페이싱", "Usage pacing")}</span>
    <HelpHint label={text("사용량 페이싱 설명", "About usage pacing")} title={text("사용량 페이싱", "Usage pacing")}>{view.hint(text)}</HelpHint>
    {view.badge && <em>{view.badge(text)}</em>}
  </div>;
}

/** 계약에 고정된 실행 순서와 제어 조건. */
function WorkflowStepList({ steps }: { steps: SystemWorkflowStep[] }) {
  const { text } = useI18n();
  return <WorkflowDetailSection
    variant="workflow-steps"
    icon={<Layers3 size={15} />}
    title={text("실행 단계", "Run steps")}
    note={text("계약에 고정된 순서와 제어 조건입니다.", "The order and control conditions fixed by the contract.")}
    count={steps.length}
  >
    <div className="workflow-table-wrap"><table>
      <thead><tr><th>{text("단계", "Step")}</th><th>{text("시스템 작업", "System operation")}</th><th>{text("제어", "Control")}</th></tr></thead>
      <tbody>
        {steps.map((step, index) => <tr key={step.id}>
          <td><span className="workflow-step-index">{index + 1}</span><code>{step.id}</code></td>
          <td><code>{step.operation}</code></td>
          <td>{[
            step.condition ? text("조건", "Condition") : null,
            step.forEach ? text(`반복 최대 ${step.forEach.maxIterations}회`, `Up to ${step.forEach.maxIterations} iterations`) : null,
            step.expect ? text("사후검증", "Post-check") : null,
          ].filter(Boolean).join(" · ") || text("기본 실행", "Plain run")}</td>
        </tr>)}
      </tbody>
    </table></div>
  </WorkflowDetailSection>;
}

/** 방금 돌린 실행 한 건의 결과와 단계별 상태. */
function WorkflowExecutionReport({ execution }: { execution: SystemWorkflowExecution }) {
  const { text } = useI18n();
  return <WorkflowDetailSection
    variant={`workflow-execution${execution.succeeded ? " succeeded" : " failed"}`}
    icon={execution.succeeded ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
    title={execution.succeeded ? text("실행 성공", "Run succeeded") : text("실행 실패", "Run failed")}
    note={<>v{execution.version} · {execution.finishedAt - execution.startedAt}ms{execution.failedStepId ? text(` · 실패 단계 ${execution.failedStepId}`, ` · failed step ${execution.failedStepId}`) : ""}{execution.round ? text(
      ` · 회차 계획 ${execution.round.plannedRuns}건 · 기동 ${execution.round.launchedRuns}건 · 정리 ${execution.round.staleRuns}건`,
      ` · ${execution.round.plannedRuns} planned · ${execution.round.launchedRuns} launched · ${execution.round.staleRuns} cleared`,
    ) : ""}</>}
  >
    {execution.failure && <p>{execution.failure}</p>}
    <ul>{execution.steps.map((step) => {
      const view = stepStatusView(step.status, text);
      return <li className={step.status} key={step.stepId}>
      <span><view.icon size={13} /></span>
      <code>{step.stepId}</code><strong>{view.label}</strong>
      {step.iterations > 1 ? <small>{text(`${step.iterations}회`, `${step.iterations} runs`)}</small> : null}
      {step.error ? <p>{step.error}</p> : null}
      </li>;
    })}</ul>
  </WorkflowDetailSection>;
}

/**
 * 등록된 버전 이력. 최근 등록 버전부터 보여 주고, 두 버전을 골라 계약의 차이를 볼 수 있다.
 *
 * 차이는 기본으로 접어 둔다 — 버전이 올라간 사실을 확인하러 오는 것이 대부분이고, 원문 비교는
 * 그 이유를 캐물을 때만 필요하다. 보관 상한(10개)을 넘긴 버전은 저장소에서 밀려나므로
 * 목록에 없는 버전과는 비교할 수 없다.
 */
function WorkflowVersionHistory({ versions }: { versions: SystemWorkflowVersion[] }) {
  const { text } = useI18n();
  const [comparing, setComparing] = useState(false);
  return <WorkflowDetailSection
    variant="workflow-versions"
    icon={<Clock3 size={15} />}
    title={text("버전 이력", "Version history")}
    note={text("최근 등록 버전부터 표시합니다.", "Newest registered version first.")}
    action={versions.length > 1 && <button
      className={`button subtle${comparing ? " active" : ""}`}
      type="button"
      aria-expanded={comparing}
      data-ui-anchor="workflows.version-compare"
      onClick={() => setComparing((open) => !open)}
    ><GitCompare size={13} />{text("버전 비교", "Compare versions")}</button>}
    count={versions.length}
  >
    {comparing && <WorkflowVersionDiff versions={versions} />}
    <ul>{[...versions].reverse().map((version) => <li key={version.version}>
      <span>v{version.version}</span>
      <div><strong>{riskView(version.computedRisk, text).label}</strong><small>{text(`시스템 작업 ${version.requiredOperations.length}종`, `${version.requiredOperations.length} system operations`)}</small></div>
      <time>{formatDateTime(version.registeredAt)}</time>
    </li>)}</ul>
  </WorkflowDetailSection>;
}

/** 고른 계약이 없을 때의 안내. 목록이 비었는지에 따라 다음에 할 일이 다르다. */
function WorkflowDetailPlaceholder({ workflowCount, aiaAvailable, onRequestAiaPrompt }: {
  workflowCount: number;
  aiaAvailable: boolean | null;
  onRequestAiaPrompt?: (prompt: string) => void;
}) {
  const { text } = useI18n();
  return <div className="workflow-detail-empty">
    <span aria-hidden="true"><Workflow size={26} /></span>
    <strong>{workflowCount === 0
      ? text("새 워크플로를 만들어 보세요", "Create your first workflow")
      : text("워크플로를 선택하세요", "Select a workflow")}</strong>
    <p>{workflowCount === 0
      ? text("AIA가 자동화할 작업을 확인하고 안전한 실행 계약을 제안합니다.", "AIA checks what you want automated and proposes a safe execution contract.")
      : text("왼쪽 목록에서 계약을 고르면 입력, 단계, 버전 이력을 확인할 수 있습니다.", "Pick a contract on the left to see its inputs, steps, and version history.")}</p>
    {workflowCount === 0 && onRequestAiaPrompt && <AiaAuthorButton iconSize={14} aiaAvailable={aiaAvailable} onRequestAiaPrompt={onRequestAiaPrompt} />}
  </div>;
}

/** 화면에 쓰는 워크플로 이름. 계약이 표시 이름을 주지 않으면 id를 그대로 쓴다. */
/**
 * 회차 1건을 돌릴 때 확인창에 다는 제목. 회차가 있는 갈래와 없는 갈래가 같은 문장을 각자
 * 적고 있었다 — 둘 다 "이 워크플로의 회차 1건"을 말하므로 한 곳에서 만든다.
 */
function roundRunTitle(workflow: SystemWorkflowSummary, text: UiText): string {
  return text(`${workflowName(workflow)} 회차 1건 실행`, `Run one round of ${workflowName(workflow)}`);
}

/**
 * 회차 1건이 스케줄러에서 어떤 봉투를 두르는지 설명하는 한 줄. 저장된 회차를 돌리는 갈래와
 * 회차가 없어 입력값으로 도는 갈래가 같은 순서를 설명하는데 문장이 두 벌로 적혀 있었다.
 * 봉투 단계가 바뀌면 한 곳만 고치면 된다.
 */
function pacedEnvelopeNote(text: UiText): string {
  return text(
    "사용량 갱신 → 기동 수 계산(예약 기록) → 지난 회차 정리 → 기동 → 재갱신이 돌고, 실제 기동 건수는 예산이 정합니다.",
    "Usage refresh → launch count (reservation) → stale-round cleanup → launch → refresh will run; the budget decides how many actually launch.",
  );
}

function workflowName(workflow: SystemWorkflowSummary): string {
  return workflow.displayName ?? workflow.id;
}

/**
 * 확인창 문구는 정적 UI 치환기 사전에 없는 문장들이라 text()로 영어를 함께 선언한다.
 * 버튼만 영어로 바뀌고 "복구할 수 없다"는 경고가 한국어로 남으면 영어 사용자는 읽지 못한
 * 채 승인하게 된다(QA #55).
 */
function runRoundLabel(text: UiText): string {
  return text("회차 1건 실행", "Run one round");
}

/**
 * 회차 1건 실행(저장된 회차를 그대로 돌리는 갈래)의 확인 대화.
 *
 * 실행·삭제 세 갈래의 확인 문구가 훅 본문 안에 흩어져 있어, 같은 말을 하는 두 실행 갈래가
 * 서로 어긋났는지 보려면 200줄 떨어진 두 자리를 번갈아 읽어야 했다. 문구 조립은 훅의 상태를
 * 하나도 읽지 않고 인자만 보므로, 이미 같은 문장을 나눠 쓰는 `roundRunTitle`·
 * `pacedEnvelopeNote` 옆으로 옮겨 한눈에 대조되게 둔다. 훅에는 확인 결과로 무엇을 하는지만
 * 남는다.
 */
function pacedRoundRunConfirm(
  workflow: SystemWorkflowDetail,
  round: ScheduledRequest,
  text: UiText,
): ConfirmRequest {
  return {
    title: roundRunTitle(workflow, text),
    message: [
      text(
        `회차 '${round.name}'을 저장된 인자와 병렬 실행 설정(${parallelRunsLabel(round, text)})으로 지금 한 번 실행합니다.`,
        `Runs round '${round.name}' once now with its saved arguments and parallel-run setting (${parallelRunsLabel(round, text)}).`,
      ),
      pacedEnvelopeNote(text),
      round.enabled ? "" : text("회차가 일시정지 상태여도 이 한 번은 실행됩니다.", "This single run goes out even though the round is paused."),
    ].filter(Boolean).join("\n"),
    confirmLabel: runRoundLabel(text),
    tone: "danger",
  };
}

/**
 * 폼에 넣은 값으로 승인된 버전을 돌리는 갈래의 확인 대화. 회차가 없는 페이싱 계약도 여기로
 * 오므로, 그때는 제목·버튼이 회차 1건 쪽 문구가 된다.
 */
function workflowRunConfirm(
  workflow: SystemWorkflowDetail,
  version: number,
  text: UiText,
): ConfirmRequest {
  const isPaced = workflow.pacingMode === "envelope";
  const steps = workflow.contract?.steps.length ?? 0;
  const effects = workflow.hardToRecoverEffects ?? [];
  const readOnly = workflow.computedRisk === "readOnly";
  return {
    title: isPaced
      ? roundRunTitle(workflow, text)
      : text(`${workflowName(workflow)} 실행`, `Run ${workflowName(workflow)}`),
    message: [
      text(`버전 v${version}을 지금 실행합니다.`, `Runs version v${version} now.`),
      text(`단계 ${steps}개 · ${riskView(workflow.computedRisk, text).label}`, `${steps} steps · ${riskView(workflow.computedRisk, text).en}`),
      isPaced
        ? [
          text(
            "이 워크플로를 도는 회차가 없어 아래 입력값으로 회차 1건을 돌립니다(병렬 실행 끔).",
            "No round runs this workflow, so one round runs with the inputs below (parallel runs off).",
          ),
          pacedEnvelopeNote(text),
        ].join(" ")
        : readOnly
          ? text("조회만 하는 워크플로입니다.", "This workflow only reads state.")
          : text("이 실행은 시스템 상태를 변경합니다.", "This run changes system state."),
    ].join("\n"),
    items: workflow.requiredOperations ?? undefined,
    warning: effects.length > 0 ? effects.join(" / ") : undefined,
    confirmLabel: isPaced ? runRoundLabel(text) : text("실행", "Run"),
    tone: readOnly && !isPaced ? "default" : "danger",
  };
}

/**
 * 이 워크플로와 함께 지울 수 있는 절차 스킬. 계약이 선언한 보관 스킬 가운데 셋을 뺀다 —
 * 이 장치에 없는 것(`missingSkills`: 계약만 오고 절차는 오지 않은 상태라 지울 것이 없다),
 * 다른 등록 워크플로가 같이 거는 것(그쪽 절차가 끊긴다), 중복이다. 남은 것(`exclusive`)만
 * 확인 대화가 선택지로 내고, 다른 워크플로가 쓰는 것은 "남긴다"고 말하기 위해 따로 담는다.
 */
function relatedSkillKeys(
  workflow: SystemWorkflowSummary,
  workflows: readonly SystemWorkflowSummary[],
): { exclusive: string[]; shared: string[] } {
  const present = Array.from(new Set(workflow.requiredSkills ?? []))
    .filter((key) => !(workflow.missingSkills ?? []).includes(key));
  const elsewhere = new Set(
    workflows
      .filter((other) => other.id !== workflow.id)
      .flatMap((other) => other.requiredSkills ?? []),
  );
  return {
    exclusive: present.filter((key) => !elsewhere.has(key)),
    shared: present.filter((key) => elsewhere.has(key)),
  };
}

/**
 * 계약 삭제의 확인 대화. 복구할 수 없는 것이 무엇인지 세 줄로 나눠 말하고, 이 워크플로만
 * 쓰는 절차 스킬이 있으면 함께 지울지 한 번 더 묻는다. 스킬 삭제는 계약 밖의 자산을
 * 건드리므로 선택 항목은 꺼진 상태로 시작한다 — 취소는 언제나 "아무것도 지우지 않음"이다.
 */
function workflowDeleteConfirm(
  workflow: SystemWorkflowSummary,
  text: UiText,
  skills: { exclusive: string[]; shared: string[] },
  onSkillChoice: (checked: boolean) => void,
): ConfirmRequest {
  return {
    title: text(`${workflowName(workflow)} 삭제`, `Delete ${workflowName(workflow)}`),
    message: [
      text("등록된 워크플로와 실행 권한을 제거합니다.", "Removes the registered workflow and its execution permission."),
      text("감사 이력은 그대로 남지만 계약과 버전 이력은 복구할 수 없습니다.", "The audit trail is kept, but the contract and its version history cannot be recovered."),
      text("다시 쓰려면 AIA가 승인 요약을 거쳐 새로 등록해야 합니다.", "To use it again, AIA must register it anew through an approval summary."),
      skills.shared.length > 0
        ? text(
          `스킬 ${skills.shared.join(", ")}은(는) 다른 워크플로도 쓰므로 그대로 둡니다.`,
          `${skills.shared.join(", ")} stays because other workflows use it too.`,
        )
        : "",
    ].join("\n"),
    confirmLabel: text("삭제", "Delete"),
    tone: "danger",
    checkbox: skills.exclusive.length > 0
      ? {
        label: text(
          `이 워크플로만 쓰는 절차 스킬 ${skills.exclusive.length}개도 함께 삭제 (${skills.exclusive.join(", ")})`,
          `Also delete the ${skills.exclusive.length} procedure skill(s) only this workflow uses (${skills.exclusive.join(", ")})`,
        ),
        defaultChecked: false,
        onConfirm: onSkillChoice,
      }
      : undefined,
  };
}

/** 삭제 결과 한 줄. 스킬을 같이 지웠는지, 지우지 못한 것이 있는지까지 말한다. */
function removalNotice(
  name: string,
  deleted: string[],
  failed: string[],
  text: UiText,
): { message: string; failed: boolean } {
  if (failed.length > 0) {
    return {
      failed: true,
      message: text(
        `워크플로 '${name}'은(는) 지웠지만 스킬 ${failed.length}개를 지우지 못했습니다. ${failed.join(" / ")}`,
        `Deleted the workflow '${name}' but could not delete ${failed.length} skill(s). ${failed.join(" / ")}`,
      ),
    };
  }
  if (deleted.length > 0) {
    return {
      failed: false,
      message: text(
        `워크플로 '${name}'과(와) 절차 스킬 ${deleted.join(", ")}을(를) 지웠습니다. 스킬은 스킬 화면의 휴지통에서 복구할 수 있습니다.`,
        `Deleted the workflow '${name}' and the procedure skill(s) ${deleted.join(", ")}. The skills can be restored from the trash on the Skills screen.`,
      ),
    };
  }
  return {
    failed: false,
    message: text(`워크플로 '${name}'을(를) 지웠습니다.`, `Deleted the workflow '${name}'.`),
  };
}

/** 회차의 병렬 실행 설정 표기. 확인 대화와 회차 카드가 같은 문구를 써야 한다. */
function parallelRunsLabel(round: ScheduledRequest, text: UiText): string {
  const maxRuns = round.workflow?.pacing?.maxRuns ?? 1;
  return maxRuns > 1 ? text(`${maxRuns}건`, `${maxRuns} runs`) : text("끔", "off");
}

/**
 * 워크플로 실행 칸 머리줄의 안내 문구 조립.
 * 페이싱 회차 여부와 계약 선언 스키마/기본값 유무에 따라 필요한 안내 문구를 단일 갈래로 정리한다.
 */
function workflowRunSectionNote(
  pacedRound: ScheduledRequest | null,
  schemaLength: number,
  prefilledCount: number,
  text: UiText,
): string {
  if (pacedRound) {
    return text(
      `회차 '${pacedRound.name}' · 병렬 실행 ${parallelRunsLabel(pacedRound, text)} · ${pacedRound.enabled ? text("활성", "Active") : text("일시정지", "Paused")}. 저장된 인자로 실행하며, 인자·병렬 설정은 워크플로 페이싱 탭의 회차 편집기에서 바꿉니다.`,
      `Round '${pacedRound.name}' · parallel runs ${parallelRunsLabel(pacedRound, text)} · ${pacedRound.enabled ? text("활성", "Active") : text("일시정지", "Paused")}. It runs with the saved arguments; change the arguments and parallel setting in the round editor on the workflow pacing tab.`,
    );
  }
  if (schemaLength > 0) {
    const prefilledNote = prefilledCount > 0
      ? text(` 계약이 선언한 기본값 ${prefilledCount}개를 미리 채웠습니다.`, ` ${prefilledCount} defaults declared by the contract are prefilled.`)
      : "";
    return text(
      `${schemaLength}개 값을 확인한 뒤 실행합니다.${prefilledNote}`,
      `Review ${schemaLength} values before running.${prefilledNote}`,
    );
  }
  return text("추가 입력 없이 바로 실행할 수 있습니다.", "It can run right away with no extra input.");
}

/** 안내에 쓸 입력 이름. 계약이 표시 이름을 주면 그것을, 없으면 키를 그대로 쓴다. */
function inputLabel(schema: [string, { label?: string | null }][], name: string): string {
  const label = schema.find(([key]) => key === name)?.[1]?.label;
  return label?.trim() ? label : name;
}

/**
 * 위험도 한 갈래가 화면에서 쓰이는 값 전부 — 배지 문구, 확인창 영어 본문의 같은 말, 색을
 * 정하는 CSS 갈래. 갈래마다 세우던 if 사다리 세 벌을 항목당 한 줄로 모았다. 셋이 갈라져
 * 있으면 갈래를 하나 더할 때 세 곳을 같이 고쳐야 하고, 한 곳을 빠뜨리면 색만 바뀌고 문구는
 * "위험도 미확인"으로 남는다. 배지 문구는 `text(ko, en)` 짝을 그대로 드는 함수라 부르는
 * 쪽이 자기 `text`를 넘긴다. `en`은 확인창 본문 안에 문장으로 녹는 소문자 말이라 배지와
 * 대소문자가 달라 따로 둔다.
 */
const RISK_VIEWS: Record<WorkflowRisk | "unknown", { label: (text: UiText) => string; en: string; className: string }> = {
  readOnly: { label: (text) => text("조회 전용", "Read-only"), en: "read-only", className: "read-only" },
  mutating: { label: (text) => text("상태 변경", "Changes state"), en: "changes state", className: "mutating" },
  destructive: { label: (text) => text("파괴적 변경", "Destructive"), en: "destructive", className: "destructive" },
  // 위험도를 못 읽은 계약(구형 응답·재등록 필요)도 배지 자리를 비우지 않는다.
  unknown: { label: (text) => text("위험도 미확인", "Risk unknown"), en: "risk unknown", className: "unknown" },
};

function riskView(risk: WorkflowRisk | null, text: UiText) {
  const view = RISK_VIEWS[risk ?? "unknown"];
  return { label: view.label(text), en: view.en, className: view.className };
}

/**
 * 실행 단계 상태의 표기와 아이콘. 문구와 아이콘이 각자 3항 사다리로 갈라져 있어 같은 상태를
 * 두 곳에서 판정했다 — 아이콘만 고치면 문구가 어긋난다. 알 수 없는 상태는 실패로 읽는다.
 */
const STEP_STATUS_VIEWS: Record<"succeeded" | "skipped" | "failed", { label: (text: UiText) => string; icon: LucideIcon }> = {
  succeeded: { label: (text) => text("성공", "Succeeded"), icon: CheckCircle2 },
  skipped: { label: (text) => text("건너뜀", "Skipped"), icon: CircleDashed },
  failed: { label: (text) => text("실패", "Failed"), icon: AlertTriangle },
};

function stepStatusView(status: string, text: UiText) {
  const view = STEP_STATUS_VIEWS[status as keyof typeof STEP_STATUS_VIEWS] ?? STEP_STATUS_VIEWS.failed;
  return { label: view.label(text), icon: view.icon };
}

/**
 * 워크플로 목록 카드의 최근 실행 상태 표기와 색상 클래스.
 * 마지막 실행 여부와 성공/실패에 따라 카드 배지에 실릴 클래스와 문구를 조립한다.
 */
function workflowLastRunView(
  lastExecution: SystemWorkflowSummary["lastExecution"],
  text: UiText,
): { className: string; label: string } {
  if (!lastExecution) {
    return { className: "idle", label: text("실행 전", "Never run") };
  }
  return lastExecution.succeeded
    ? { className: "succeeded", label: text("최근 성공", "Last succeeded") }
    : { className: "failed", label: text("최근 실패", "Last failed") };
}

/**
 * 같은 실행을 두 번 보내지 않기 위한 키. `crypto.randomUUID`는 보안 컨텍스트에서만
 * 있으므로, 원격 접속처럼 없을 수 있는 환경에서는 난수 문자열로 대신한다.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
