import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  aiaEventBudgetStore,
  aiaSkillChangeStore,
  aiaSuggestionHistoryStore,
} from "./appStoredState";
import {
  canDispatchAiaEvent,
  captureAiaEventBaseline,
  clearAiaSkillChange,
  coalesceAiaEvents,
  detectAiaEvents,
  dismissAiaSuggestion,
  evaluateAiaSuggestionState,
  observeAiaSkillChanges,
  recordAiaEventDispatch,
  suggestionFingerprint,
  type AiaEvent,
  type AiaEventBaseline,
  type AiaEventKind,
  type AiaSkillChangeState,
  type AiaSuggestion,
  type AiaSuggestionCatalog,
  type AiaSuggestionHistory,
  type AiaSuggestionKind,
} from "./lib/aiaSuggestions";
import {
  analyzeAiaEvent,
  getAiaSuggestionCatalog,
  getCommonSkillDigests,
  hasTauriRuntime,
  type AiaBackgroundAnalysis,
} from "./lib/ipc";
import { usePoll } from "./lib/poll";
import type { PopoutRequest } from "./lib/popout";
import type { AccountSnapshot, ChatAttentionSnapshot, ManagerSnapshot, ProviderId, SchedulerSnapshot, SystemAutomationSnapshot } from "./types";

/**
 * AIA 트리거에 띄울 제안을 만드는 자리. 카탈로그 폴링·공통 스킬 변경 감지·운영 사건 분석
 * 세 갈래가 각자 상태와 폴링과 저장본을 들고 있어 App 본문에 흩어져 있으면 화면 조립과
 * 섞여 읽히지 않는다. 제안 계산은 화면을 하나도 그리지 않으므로 App에서 떼어 이 모듈에
 * 모으고, 밖으로는 합친 목록과 내리기만 내보낸다.
 */

/**
 * 운영 사건 종류를 제안 종류로 옮기는 표. 이 제안은 카탈로그를 거치지 않고 여기서 바로
 * 만들어지므로 짝을 맺어 줄 곳이 여기뿐이다. 일정 실패 두 갈래는 받는 쪽에서 구분할 일이
 * 없어 같은 종류로 모인다.
 */
const ANALYSIS_SUGGESTION_KIND: Record<AiaEventKind, AiaSuggestionKind> = {
  cliLost: "providerCliMissing",
  accountAuthError: "accountAuthError",
  scheduleFailed: "scheduleRunFailed",
  scheduleRecoveryError: "scheduleRunFailed",
  translationFailed: "translationFailed",
};

/** 제한 분석에 넘기는 한 줄. 합쳐진 사건은 몇 건이 묶였는지까지 알려야 규모가 전달된다. */
function aiaEventSummaryLine(event: AiaEvent): string {
  const merged = event.coalescedCount && event.coalescedCount > 1 ? ` (병합 사건 ${event.coalescedCount}건)` : "";
  return `${event.kind}: ${event.summary}${merged}`;
}

/**
 * 분석 결과를 제안 한 건으로 옮긴다. 지문에 사건 id가 들어가 같은 사건이 두 번 뜨지 않는다.
 * 조립만 하는 순수 함수로 떼어 두어, 부르는 효과 쪽에는 합치기·예산·발송 판단만 남는다.
 */
function runtimeAnalysisSuggestion(event: AiaEvent, analysis: AiaBackgroundAnalysis): AiaSuggestion {
  const fingerprint = suggestionFingerprint("aia-runtime-analysis", event.kind, event.targetId, event.id);
  return {
    id: fingerprint,
    definitionId: event.kind,
    fingerprint,
    kind: ANALYSIS_SUGGESTION_KIND[event.kind],
    severity: "error",
    priority: 1_000,
    title: "새 운영 오류를 분석했습니다",
    detail: analysis.summary,
    prompt: analysis.command ?? `현재 발생한 ${event.summary} 원인을 확인하고 안전한 해결 절차를 제안해줘`,
    packId: "aia-runtime-analysis",
    packDisplayName: "AIA 제한 분석",
    source: "isolatedAnalysis",
    skillKey: null,
    targetId: event.targetId,
    stateKey: event.id,
    metadata: { afterResolved: true, cooldownMinutes: 0 },
  };
}

/**
 * 운영 사건(계정 인증 오류·CLI 유실·일정 실패·번역 실패)을 기준선 대조로 감지하고,
 * 30초 동안 합쳐 가장 중요한 한 건만 제한된 Core 분석 경로로 보낸 뒤 그 결과를 제안
 * 하나로 돌려준다. 사건 예산과 진행 중 표시는 이 훅 안에서만 쓰이므로 부르는 쪽에는
 * 제안과 내림 함수만 남는다.
 */
function useAiaRuntimeAnalysis({ aiaProviderId, aiaOpen, popoutRequest, snapshot, accounts, scheduler, automation }: {
  aiaProviderId: ProviderId | null;
  aiaOpen: boolean;
  popoutRequest: PopoutRequest | null;
  snapshot: ManagerSnapshot | null;
  accounts: AccountSnapshot | null;
  scheduler: SchedulerSnapshot | null;
  automation: SystemAutomationSnapshot | null;
}): { analysisSuggestion: AiaSuggestion | null; dismissAnalysisSuggestion: (fingerprint: string) => void } {
  const [pendingAiaEvents, setPendingAiaEvents] = useState<AiaEvent[]>([]);
  const [aiaAnalysisSuggestion, setAiaAnalysisSuggestion] = useState<{ event: AiaEvent; suggestion: AiaSuggestion } | null>(null);
  const aiaEventBaselineRef = useRef<AiaEventBaseline | null>(null);
  const aiaEventBudgetRef = useRef(aiaEventBudgetStore.load());
  const aiaAnalysisRunningRef = useRef(false);

  // 모든 스냅샷이 처음 모인 시점은 기준선으로만 기록한다. 이후 새로 발생한 운영
  // 전환만 모아 제한된 AIA 분석 후보로 만든다.
  useEffect(() => {
    if (!hasTauriRuntime() || popoutRequest || !snapshot || !accounts || !scheduler || !automation) return;
    const facts = { manager: snapshot, accounts, scheduler: scheduler, automation };
    const previous = aiaEventBaselineRef.current;
    if (!previous) {
      aiaEventBaselineRef.current = captureAiaEventBaseline(facts);
      return;
    }
    const detected = detectAiaEvents(previous, { ...facts, now: Date.now() });
    aiaEventBaselineRef.current = detected.baseline;
    setAiaAnalysisSuggestion((current) => (
      current && aiaEventStillActive(current.event, detected.baseline) ? current : null
    ));
    setPendingAiaEvents((current) => {
      const active = current.filter((event) => aiaEventStillActive(event, detected.baseline));
      const known = new Set(active.map((event) => event.id));
      return [...active, ...detected.events.filter((event) => !known.has(event.id))];
    });
  }, [accounts, automation, popoutRequest, scheduler, snapshot]);

  // 사건은 30초 동안 합치고 가장 중요한 한 건만 전용 Core 경로로 전달한다. 이 경로는
  // 기존 AIA 대화와 분리되며 세션·MCP·도구 없이 1KB 입력과 제한된 JSON 응답만 허용한다.
  useEffect(() => {
    if (pendingAiaEvents.length === 0) return undefined;
    const oldest = Math.min(...pendingAiaEvents.map((event) => event.observedAt));
    const waitMs = Math.max(0, 30_000 - (Date.now() - oldest));
    const timer = window.setTimeout(() => {
      if (!aiaProviderId || aiaOpen || aiaAnalysisRunningRef.current || !hasTauriRuntime() || popoutRequest) return;
      const now = Date.now();
      const event = coalesceAiaEvents(pendingAiaEvents, now);
      if (!event) return;
      setPendingAiaEvents([]);
      if (!canDispatchAiaEvent(aiaEventBudgetRef.current, now)) return;
      const nextBudget = recordAiaEventDispatch(aiaEventBudgetRef.current, now);
      aiaEventBudgetRef.current = nextBudget;
      aiaEventBudgetStore.save(nextBudget);
      aiaAnalysisRunningRef.current = true;
      void analyzeAiaEvent(aiaEventSummaryLine(event))
        .then((analysis) => setAiaAnalysisSuggestion({ event, suggestion: runtimeAnalysisSuggestion(event, analysis) }))
        .catch(() => undefined)
        .finally(() => { aiaAnalysisRunningRef.current = false; });
    }, waitMs || 1);
    return () => window.clearTimeout(timer);
  }, [aiaOpen, aiaProviderId, pendingAiaEvents, popoutRequest]);

  // 내려도 기준선은 남으므로 같은 사건이 계속 살아 있는 동안에는 다시 제안되지 않는다.
  const dismissAnalysisSuggestion = useCallback((fingerprint: string) => {
    setAiaAnalysisSuggestion((current) => current?.suggestion.fingerprint === fingerprint ? null : current);
  }, []);

  return { analysisSuggestion: aiaAnalysisSuggestion?.suggestion ?? null, dismissAnalysisSuggestion };
}

/**
 * AIA 트리거에 띄울 제안 목록. 제안 카탈로그 폴링, 공통 스킬 변경 감지, 운영 사건 분석
 * 세 갈래가 각각 자기 상태를 들고 있다가 한 목록으로 합쳐지고, 내리기도 갈래별로 다른
 * 저장본을 손대야 해서 App 본문에 상태 네 개와 폴링 두 벌이 흩어져 있었다. 합친 목록과
 * 내리기 둘만 밖으로 내보내면 App은 어느 갈래에서 온 제안인지 알 필요가 없다.
 */
export function useAiaSuggestionCenter({ aiaProviderId, aiaOpen, popoutRequest, snapshot, accounts, scheduler, automation, attention }: {
  aiaProviderId: ProviderId | null;
  aiaOpen: boolean;
  popoutRequest: PopoutRequest | null;
  snapshot: ManagerSnapshot | null;
  accounts: AccountSnapshot | null;
  scheduler: SchedulerSnapshot | null;
  automation: SystemAutomationSnapshot | null;
  attention: ChatAttentionSnapshot;
}): {
  aiaSuggestions: AiaSuggestion[];
  dismissSuggestion: (suggestion: AiaSuggestion) => void;
  // 지침·스킬을 고치면 제안 카탈로그가 곧바로 낡으므로, 폴링 주기를 기다리지 않고 다시 읽는다.
  refreshSuggestionCatalog: () => Promise<void>;
} {
  const [catalog, setCatalog] = useState<AiaSuggestionCatalog | null>(null);
  const [history, setHistory] = useState<AiaSuggestionHistory>(aiaSuggestionHistoryStore.load);
  const [now, setNow] = useState(() => Date.now());
  const [skillChanges, setSkillChanges] = useState<AiaSkillChangeState>(aiaSkillChangeStore.load);

  const pollCatalog = useCallback(async () => {
    const next = await getAiaSuggestionCatalog();
    setCatalog((current) => current?.contentDigest === next.contentDigest ? current : next);
    // 지연 리마인드와 만료 조건은 모델 호출 없이 분 단위로 다시 판단한다.
    setNow(Date.now());
  }, []);
  // 선제 제안을 끄면 제안 팩을 읽을 이유도 없다. 다시 켜면 폴링이 살아나 곧 따라온다.
  const suggestionsEnabled = automation?.settings.aiaSuggestions !== false;
  usePoll(pollCatalog, 60_000, { enabled: !popoutRequest && suggestionsEnabled });

  // 즉시 트리거용 스킬 변경 감지. 공통 원본의 내용 지문만 읽는 축약 조회라 짧은
  // 주기로도 부담이 적다. 처음 본 스킬은 기준선만 잡으므로 첫 실행에는 제안이
  // 뜨지 않고, 이후 내용이 바뀐 스킬만 검토 제안 후보가 된다.
  const pollSkillChanges = useCallback(async () => {
    const digests = await getCommonSkillDigests();
    setSkillChanges(aiaSkillChangeStore.saveIfChanged((current) => observeAiaSkillChanges(current, digests, Date.now())));
  }, []);
  usePoll(pollSkillChanges, 30_000, { enabled: !popoutRequest && Boolean(aiaProviderId) });

  // 운영 사건 감지→합치기→제한 분석 호출은 useAiaRuntimeAnalysis가 통째로 맡는다.
  const { analysisSuggestion, dismissAnalysisSuggestion } = useAiaRuntimeAnalysis({
    aiaProviderId,
    aiaOpen,
    popoutRequest,
    snapshot,
    accounts,
    scheduler,
    automation,
  });

  const evaluation = useMemo(() => {
    if (!snapshot || !catalog || !suggestionsEnabled) return null;
    return evaluateAiaSuggestionState({
      catalog,
      manager: snapshot,
      accounts,
      scheduler,
      automation,
      attention,
      now,
      history,
      skillChanges: skillChanges.changes,
    });
  }, [accounts, skillChanges, catalog, history, now, automation, attention, scheduler, snapshot, suggestionsEnabled]);
  const aiaSuggestions = aiaProviderId && !popoutRequest
    ? [
      ...(analysisSuggestion ? [analysisSuggestion] : []),
      ...(evaluation?.suggestions ?? []),
    ]
    : [];

  // 해결/재발 상태를 반영한 이력만 로컬에 저장한다. 오류 원문, 계정 정보와 대화
  // 본문은 평가 이력에 들어가지 않는다.
  useEffect(() => {
    const next = evaluation?.history;
    if (!next) return;
    setHistory(aiaSuggestionHistoryStore.saveIfChanged(() => next));
  }, [evaluation?.history]);

  const dismissSuggestion = useCallback((suggestion: AiaSuggestion) => {
    if (suggestion.source === "isolatedAnalysis") {
      dismissAnalysisSuggestion(suggestion.fingerprint);
      return;
    }
    // 스킬 변경 제안은 감지 목록에서 내린다. 기준선은 남으므로 같은 내용으로는
    // 다시 뜨지 않고, 스킬이 또 바뀌면 새 변경으로 다시 제안된다.
    if (suggestion.kind === "skillContentChanged") {
      setSkillChanges(aiaSkillChangeStore.saveIfChanged((current) => clearAiaSkillChange(current, suggestion.targetId)));
    }
    setHistory(aiaSuggestionHistoryStore.saveIfChanged((current) => dismissAiaSuggestion(current, suggestion, Date.now())));
  }, [dismissAnalysisSuggestion]);

  return { aiaSuggestions, dismissSuggestion, refreshSuggestionCatalog: pollCatalog };
}

/** 감지된 사건이 아직 살아 있는지. 해소된 사건은 분석 후보에서도 제안에서도 빠진다. */
function aiaEventStillActive(event: AiaEvent, baseline: AiaEventBaseline): boolean {
  if (event.kind === "cliLost") return baseline.cliMissing.includes(event.targetId);
  if (event.kind === "accountAuthError") return baseline.authErrors[event.targetId] !== undefined;
  if (event.kind === "scheduleRecoveryError") return baseline.scheduleProblems[event.targetId]?.endsWith("recovery-error") ?? false;
  if (event.kind === "scheduleFailed") return baseline.scheduleProblems[event.targetId] !== undefined;
  return baseline.translationFailures[event.targetId] !== undefined;
}
