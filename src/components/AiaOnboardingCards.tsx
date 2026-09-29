/**
 * 애드온 → 자동화 탭의 온보딩 카드(W6).
 *
 * 카드 한 장마다 컴포넌트를 쓰던 자리다. 지금은 팩 데이터가 카드를 정하고 이 파일은
 * 그리는 규칙 한 벌만 들고 있다 — 카드를 더하는 일은 공통 스킬에
 * `references/aia-onboarding.json`을 쓰는 일이지 이 파일을 고치는 일이 아니다.
 *
 * 접힌 카드는 제목·한 줄 설명·시작 버튼만 보여 준다. 단계와 입력은 시작을 눌러야
 * 펼쳐진다 — 자동화 탭에 카드가 여럿 서는데 각 카드가 처음부터 자기 절차를 다 펼치면
 * 무엇을 고를 수 있는지가 화면 밖으로 밀려난다.
 *
 * 마지막 만들기는 팩이 선언한 산출물을 차례로 실행한다. 각 산출물은 이미 있는 변경
 * 작업 하나로 내려가므로 승인·원격 게이트가 그대로 걸리고, 워크플로는 등록 전에
 * `propose_system_workflow_schema`의 승인 요약을 사용자에게 보여 준다.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2, CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, EyeOff, FlaskConical, FolderTree,
  GitBranch, ListChecks, NotebookPen, Route, Sparkles, Target, Trash2, Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  createCommonSkill,
  createDirectory,
  createScheduledRequest,
  deleteSharedSkill,
  getAiaOnboardingCatalog,
  getClaudePluginBranchRules,
  getCypressRegistry,
  getCommonSkillDigests,
  getDocRoots,
  getExternalPlugins,
  getProjectRegistry,
  getSchedulerSnapshot,
  previewDirectoryCreation,
  readCypressWorkspaceFile,
  proposeSystemWorkflow,
  registerSystemWorkflow,
  setSystemAutomationSettings,
  unarchiveSharedSkill,
  updateCommonSkill,
  updateScheduledRequest,
} from "../lib/ipc";
import {
  activeActions,
  creationProblems,
  RECORD_TARGETS,
  buildScheduleInput,
  buildWorkflowContract,
  cardSteps,
  fillTemplate,
  initialValues,
  localized,
  missingRequired,
  parallelEnabled,
  plannedProcedureSkills,
  selectedProcedureSkillKeys,
  parallelRuns,
  roundSavePlan,
  supportsParallel,
  visibleFields,
  type OnboardingValues,
} from "../lib/aiaOnboarding";
import { onboardingDraftPrompt } from "../lib/aiaOnboardingDraftPrompt";
import { aiaRuntimeProvider } from "../lib/aiaRuntime";
import { directoryCreationItems } from "../lib/missingDirectory";
import { errorText } from "../lib/errorText";
import { useI18n } from "../lib/i18n";
import type {
  AiaOnboardingAction,
  AiaOnboardingCardView,
  AiaOnboardingCatalog,
  AiaOnboardingSkillTemplate,
  AiaOnboardingField,
  AiaOnboardingIcon,
  CypressWorkspace,
  DocRootStatus,
  ExternalPluginView,
  ProjectRegistryEntry,
  SystemAutomationSnapshot,
} from "../types";
import { AiaMark, ErrorBanner, LoadingState, useConfirm } from "./Shared";

const cardIcons: Record<AiaOnboardingIcon, LucideIcon> = {
  building2: Building2,
  calendarClock: CalendarClock,
  flaskConical: FlaskConical,
  folderTree: FolderTree,
  gitBranch: GitBranch,
  listChecks: ListChecks,
  notebookPen: NotebookPen,
  route: Route,
  sparkles: Sparkles,
  target: Target,
  workflow: Workflow,
};

function availableRecordTargets(plugins: readonly ExternalPluginView[]) {
  return RECORD_TARGETS.filter(({ needles }) => needles.length === 0 || plugins.some((plugin) => {
    if (!plugin.attachable) return false;
    const haystack = `${plugin.id} ${plugin.displayName} ${plugin.url ?? ""}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  }));
}

interface OnboardingSources {
  projects: ProjectRegistryEntry[];
  docRoots: DocRootStatus[];
  plugins: ExternalPluginView[];
  workspaces: CypressWorkspace[];
  /**
   * 고른 Cypress 작업공간의 `cypress.env.json` **키 이름**. 값이 가려진 사본을 읽으므로
   * 비밀번호·토큰은 화면에 오지 않는다. 계정 키를 손으로 옮겨 적게 하지 않으려는 것이다.
   */
  envKeys: string[];
  /**
   * 고른 프로젝트의 로컬 브랜치와 현재 브랜치. Claude 플러그인 브랜치 규칙 조회가 활성
   * 등록 프로젝트마다 이미 내주는 값이라 그대로 읽는다 — 같은 대상을 두 번 훑지 않는다.
   */
  branches: string[];
  currentBranch: string | null;
  /**
   * 플러그인 목록을 **읽는 데 성공했는지**. 조회가 실패해도 목록은 빈 채로 남으므로,
   * "고를 수 없는 대상"과 "아직 못 읽은 목록"을 이 표시로만 가른다.
   */
  pluginsLoaded: boolean;
}

/**
 * 앱이 채우는 칸의 목록. 카드를 시작한 뒤에만 읽는다 — 애드온의 패널은 고르지 않은
 * 탭까지 모두 마운트되므로, 접힌 카드까지 프로젝트·플러그인 목록을 읽으면 탭을 열지도
 * 않은 동안 조회가 돈다. 실패한 조회는 그 칸만 비우고 나머지는 계속 채운다.
 */
function useOnboardingSources(started: boolean): OnboardingSources {
  const [sources, setSources] = useState<OnboardingSources>({
    projects: [], docRoots: [], plugins: [], workspaces: [], envKeys: [],
    branches: [], currentBranch: null, pluginsLoaded: false,
  });

  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    const fill = async <T,>(load: () => Promise<T>, key: keyof OnboardingSources, pick: (value: T) => unknown) => {
      try {
        const value = await load();
        if (!cancelled) setSources((current) => ({ ...current, [key]: pick(value) }));
      } catch { /* 못 읽은 목록은 빈 칸으로 두고 사용자가 직접 적게 한다. */ }
    };
    void fill(getProjectRegistry, "projects", (entries) => entries.filter((entry) => entry.active));
    void fill(getDocRoots, "docRoots", (roots) => roots);
    void fill(getCypressRegistry, "workspaces", (registry) => registry.workspaces);
    // 플러그인만은 성공 여부를 따로 둔다. 실패한 조회를 "붙은 플러그인이 없다"로 읽으면
    // 사용자가 고른 기록 대상을 근거 없이 막게 된다.
    void (async () => {
      try {
        const snapshot = await getExternalPlugins();
        if (!cancelled) setSources((current) => ({ ...current, plugins: snapshot.plugins, pluginsLoaded: true }));
      } catch { /* 못 읽었으면 표시를 올리지 않는다. */ }
    })();
    return () => { cancelled = true; };
  }, [started]);

  return sources;
}

export interface AiaOnboardingCardsProps {
  active: boolean;
  automation?: SystemAutomationSnapshot | null;
  onAutomationChange?: (snapshot: SystemAutomationSnapshot) => void;
  onSkillsChanged?: () => void;
  /** 읽을 마일스톤·기록이 아직 없을 때 그 자리에서 AIA에게 만들어 달라고 넘기는 길. */
  onRequestAiaPrompt?: (prompt: string) => void;
}

/** 끄기 목록에 적는 이름. 카드 id는 팩 안에서만 고유하므로 팩까지 묶는다. */
function hiddenCardKey(card: AiaOnboardingCardView): string {
  return `${card.packId}:${card.id}`;
}

export function AiaOnboardingCards({ active, automation = null, onAutomationChange, onSkillsChanged, onRequestAiaPrompt }: AiaOnboardingCardsProps) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [catalog, setCatalog] = useState<AiaOnboardingCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCatalog(await getAiaOnboardingCatalog());
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const hidden = useMemo(
    () => automation?.settings.hiddenOnboardingCards ?? [],
    [automation],
  );
  // 카드 id는 팩 안에서만 고유하다. 팩까지 묶은 이름으로만 비교한다 — 맨 id를 함께
  // 받아 주면 다른 팩의 같은 이름 카드까지 숨는 원래 문제가 그대로 남는다.
  const cards = (catalog?.cards ?? []).filter((card) => !hidden.includes(hiddenCardKey(card)));

  /** 번들 카드는 지울 파일이 없어 설정의 끄기 목록으로 감춘다(W6-7). */
  const hideCard = async (card: AiaOnboardingCardView) => {
    if (!automation) return;
    const accepted = await confirm({
      title: text("온보딩 카드 끄기", "Hide onboarding card"),
      message: text(
        "이 카드를 자동화 탭에서 감춥니다. 앱에 포함된 기본 카드라 지워지지는 않고, 설정에서 다시 켤 수 있습니다.",
        "Hides this card from the Automation tab. It ships with the app, so nothing is deleted and it can be shown again.",
      ),
      items: [localized(card.title, text)],
      confirmLabel: text("끄기", "Hide"),
    });
    if (!accepted) return;
    try {
      onAutomationChange?.(await setSystemAutomationSettings({
        ...automation.settings,
        hiddenOnboardingCards: [...hidden, hiddenCardKey(card)],
      }));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  /** 공통 스킬로 설치된 팩은 그 스킬을 휴지통으로 옮겨 지운다. 복구할 수 있다. */
  const deleteCard = async (card: AiaOnboardingCardView) => {
    if (!card.skillKey) return;
    const siblings = card.packCardCount - 1;
    const accepted = await confirm({
      title: text("온보딩 카드 삭제", "Delete onboarding card"),
      message: siblings > 0
        ? text(
          `이 카드가 든 팩 스킬을 휴지통으로 옮깁니다. 같은 팩의 다른 카드 ${siblings}장도 함께 사라집니다. 휴지통에서 되돌릴 수 있습니다.`,
          `Moves the pack skill to the trash. ${siblings} other card(s) in the same pack go with it. Recoverable from the trash.`,
        )
        : text(
          "이 카드가 든 팩 스킬을 휴지통으로 옮깁니다. 휴지통에서 되돌릴 수 있습니다.",
          "Moves the pack skill to the trash. Recoverable from the trash.",
        ),
      items: [`${localized(card.title, text)} — ${card.skillKey}`],
      confirmLabel: text("삭제", "Delete"),
      warning: text("휴지통으로 옮깁니다. 영구 삭제가 아닙니다.", "Moved to the trash, not erased."),
    });
    if (!accepted) return;
    try {
      await deleteSharedSkill(card.skillKey);
      onSkillsChanged?.();
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const showAgain = async () => {
    if (!automation) return;
    try {
      onAutomationChange?.(await setSystemAutomationSettings({ ...automation.settings, hiddenOnboardingCards: [] }));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  return (
    <section className="settings-card aia-addon-card" data-ui-anchor="addons.automation-content">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><AiaMark size={18} /></i>
          <div>
            <span>{text("자동화", "Automation")}</span>
            <h2>{text("온보딩", "Onboarding")}</h2>
          </div>
        </div>
        <p>{text(
          "절차 한 벌을 몇 단계로 물어 워크플로·회차·폴더를 한 번에 만듭니다. 카드는 앱에 포함된 기본 팩과 공통 스킬에 설치한 팩에서 오며, 새 카드는 AIA에게 만들어 달라고 하면 됩니다.",
          "Each card asks a few questions and then creates the workflow, rounds, and folders in one go. Cards come from the bundled pack and from packs installed as common skills; ask AIA to author a new one.",
        )}</p>
      </header>

      {error ? <ErrorBanner message={error} /> : null}

      {catalog?.issues.map((issue) => (
        <p className="aia-onboarding-note" key={issue.skillKey}>
          <Trash2 size={14} aria-hidden="true" />
          {text(
            `'${issue.skillKey}' 팩을 읽지 못해 건너뛰었습니다: ${issue.message}`,
            `Skipped the '${issue.skillKey}' pack: ${issue.message}`,
          )}
        </p>
      ))}

      {loading && !catalog ? <LoadingState label={text("온보딩 카드를 읽는 중", "Loading onboarding cards")} /> : null}

      {cards.map((card) => (
        <OnboardingCard
          key={`${card.packId}:${card.id}`}
          card={card}
          skills={catalog?.skills ?? []}
          skillsRoot={catalog?.skillsRoot ?? ""}
          onHide={() => void hideCard(card)}
          onDelete={() => void deleteCard(card)}
          // 시스템 에이전트를 고르지 않았으면 넘길 곳이 없다. 눌러도 아무 일도 없는
          // 버튼을 세우지 않는다 — 자동화 스냅샷이 이 화면에 이미 와 있다.
          onRequestAiaPrompt={aiaRuntimeProvider(automation) ? onRequestAiaPrompt : undefined}
          confirm={confirm}
        />
      ))}

      {hidden.length > 0 ? (
        <p className="aia-onboarding-note">
          <EyeOff size={14} aria-hidden="true" />
          {text(`꺼 둔 카드 ${hidden.length}장이 있습니다.`, `${hidden.length} card(s) are hidden.`)}
          <button className="link-button" type="button" onClick={() => void showAgain()}>
            {text("모두 다시 켜기", "Show all again")}
          </button>
        </p>
      ) : null}

      {confirmDialog}
    </section>
  );
}

/** 만들기가 끝난 뒤 남기는 한 줄. 무엇이 실제로 만들어졌는지만 적는다. */
interface OnboardingOutcome {
  label: string;
  detail: string;
}

/**
 * 만들기 한 번이 보는 값 한 벌 — 카드와 입력, 그리고 그 입력에서 이미 정해진 판정들.
 * 산출물 함수마다 인자를 줄줄이 다시 넘기지 않으려고 한 봉투로 묶는다.
 */
interface CreationRun {
  card: AiaOnboardingCardView;
  values: OnboardingValues;
  skills: readonly AiaOnboardingSkillTemplate[];
  skillsRoot: string;
  sources: OnboardingSources;
  /** 회차를 만드는 카드는 페이싱 계약으로, 아니면 수동 실행 계약으로 등록한다. */
  paced: boolean;
  /** 병렬은 카드가 지원한다고 선언하고 사용자가 켰을 때만이다. 기본은 꺼짐. */
  parallel: boolean;
  runs: number;
  confirm: ReturnType<typeof useConfirm>["confirm"];
  text: ReturnType<typeof useI18n>["text"];
  /** 지금까지 실제로 만들어진 것. 도중에 멈춰도 여기까지는 화면에 남는다. */
  made: OnboardingOutcome[];
}

/** 방금 등록한 워크플로 — 뒤따르는 회차 산출물이 붙을 대상. */
interface RegisteredWorkflow {
  id: string;
  version: number;
  /** 카드의 병렬 스위치가 켜져 있어도 parallel:false인 계약은 한 건씩 돌아야 한다. */
  parallel: boolean;
}

/**
 * 등록이 거절할 것과 값이 어긋난 것은 **아무것도 만들기 전에** 본다. 절차 스킬을
 * 먼저 만들고 등록에서 죽으면 쓰지 않는 스킬만 남는다. 기록 대상은 플러그인 목록을
 * 읽는 데 성공했을 때만 판정한다.
 */
function assertCreatable({ card, values, paced, skillsRoot, sources }: CreationRun): void {
  const problems = creationProblems(card, values, {
    paced,
    skillsRoot,
    recordTargets: sources.pluginsLoaded
      ? availableRecordTargets(sources.plugins).map((target) => target.id)
      : null,
  });
  if (problems.length > 0) throw new Error(problems.join(" "));
}

/**
 * 계약이 따르게 하는 절차는 스킬 파일이 들고 있다(W6-9). 워크플로마다 제 이름의
 * 복사본이 붙으므로, 한 프로젝트의 절차를 고쳐도 다른 프로젝트 회차는 그대로다.
 * 이미 있는 키는 사용자가 손봤을 수 있어 건드리지 않는다.
 */
async function createProcedureSkills({ card, values, skills, parallel, confirm, text, made }: CreationRun): Promise<void> {
  const installed = new Set((await getCommonSkillDigests().catch(() => [])).map((skill) => skill.key));
  const missingSelected = selectedProcedureSkillKeys(values).filter((key) => !installed.has(key));
  if (missingSelected.length > 0) {
    throw new Error(text(
      `따를 스킬을 찾을 수 없습니다: ${missingSelected.join(", ")}. 먼저 공통 스킬에 설치한 뒤 다시 만드세요.`,
      `The selected procedure skill is not installed: ${missingSelected.join(", ")}. Install it as a common skill, then try again.`,
    ));
  }
  const needed = plannedProcedureSkills(card, values, skills, { parallel, installed });
  if (needed.length === 0) return;
  const accepted = await confirm({
    title: text("회차 절차 스킬 만들기", "Create the round procedure skills"),
    message: text(
      "만들 회차가 따를 절차를 이 프로젝트 전용 공통 스킬로 만듭니다. 나중에 그 파일을 고치면 이 프로젝트의 회차만 새 절차를 따릅니다.",
      "The procedures these rounds follow are created as common skills for this project. Editing those files later changes only this project's rounds.",
    ),
    items: needed.map((skill) => `${skill.key} — ${skill.description}`),
    confirmLabel: text("만들기", "Create"),
  });
  if (!accepted) throw new Error(text("절차 스킬 없이는 회차를 만들지 않습니다.", "Not creating rounds without their procedure skills."));
  for (const skill of needed) {
    const source = await createCommonSkill({
      key: skill.key,
      name: skill.key,
      description: skill.description,
    });
    try {
      await updateCommonSkill({
        key: skill.key,
        files: skill.files,
        deletes: [],
        expectedDigest: source.contentDigest,
      });
    } catch (cause) {
      // 만들기만 하고 내용 쓰기가 실패하면 "여기에 스킬 지침을 작성하세요"가 든
      // 껍데기가 남는다. 다음 시도는 그 키를 이미 있는 것으로 보고 건너뛰어,
      // 플레이스홀더를 절차로 건 회차가 등록된다. 껍데기를 거둔다 — 보관 취소는
      // **원본만** 휴지통으로 옮긴다(공유 삭제는 사용자가 따로 둔 배포본까지
      // 가져가고, 설치본 삭제는 공급자 설치본만 훑어 이 원본을 찾지 못한다).
      await unarchiveSharedSkill(skill.key).catch(() => undefined);
      throw cause;
    }
    made.push({ label: text("절차 스킬", "Procedure skill"), detail: skill.key });
  }
}

/** 폴더 산출물. 이미 있으면 만들지 않고 그렇다고만 적는다. */
async function createCardDirectory(
  action: Extract<AiaOnboardingAction, { kind: "createDirectory" }>,
  { values, confirm, text, made }: CreationRun,
): Promise<void> {
  const path = fillTemplate(action.path, values);
  const plan = await previewDirectoryCreation(path).catch(() => null);
  if (plan?.exists) {
    made.push({ label: localized(action.label, text), detail: text(`이미 있음 — ${path}`, `Already there — ${path}`) });
    return;
  }
  const accepted = await confirm({
    title: text("새 폴더 만들기", "Create folders"),
    message: text("아래 폴더를 차례로 만듭니다.", "The following folders will be created in order."),
    items: directoryCreationItems(plan, path),
    confirmLabel: text("만들기", "Create"),
  });
  if (!accepted) throw new Error(text("폴더 만들기를 취소했습니다.", "Folder creation was cancelled."));
  const created = await createDirectory(path);
  made.push({ label: localized(action.label, text), detail: created.path });
}

/** 워크플로 산출물. 등록 전에 백엔드가 계산한 승인 요약을 그대로 보여 준다. */
async function registerCardWorkflow(
  action: Extract<AiaOnboardingAction, { kind: "registerWorkflow" }>,
  { values, paced, parallel, skillsRoot, confirm, text, made }: CreationRun,
): Promise<RegisteredWorkflow> {
  const contract = buildWorkflowContract(action.workflow, values, { paced, skillsRoot });
  // 여기서 거절하면 아무것도 등록되지 않는다.
  const proposal = await proposeSystemWorkflow(contract);
  const accepted = await confirm({
    title: text("워크플로 등록", "Register workflow"),
    message: proposal.approvalSummary.grantsAfterRegistration,
    items: [
      `${proposal.approvalSummary.name} (${contract.id})`,
      proposal.approvalSummary.purpose,
      text(`위험도: ${proposal.computedRisk}`, `Risk: ${proposal.computedRisk}`),
      text(`쓰는 작업: ${proposal.requiredOperations.join(", ")}`, `Operations: ${proposal.requiredOperations.join(", ")}`),
    ],
    confirmLabel: text("등록", "Register"),
  });
  if (!accepted) throw new Error(text("워크플로 등록을 취소했습니다.", "Workflow registration was cancelled."));
  const registered = await registerSystemWorkflow(contract);
  made.push({
    label: localized(action.label, text),
    detail: text(`${registered.workflowId} v${registered.version}`, `${registered.workflowId} v${registered.version}`),
  });
  return { id: registered.workflowId, version: registered.version, parallel: parallel && action.workflow.parallel };
}

/**
 * 회차 산출물. 바로 앞에서 등록한 워크플로에 붙는다.
 *
 * **같은 워크플로를 도는 회차가 이미 있으면 그것을 고쳐 쓴다.** 만들기를 다시 누르면
 * 워크플로는 새 버전으로 재등록되는데, 여기서 매번 새로 만들면 같은 이름의 회차가
 * 하나씩 늘고 **먼저 만든 것들은 옛 버전에 고정된 채로 남는다.** 그 상태로 하나를 켜면
 * 지금 화면에서 정한 내용이 아니라 옛 계약으로 돈다(2026-09-21에 farm-next-theme 회차가
 * v1·v2·v3 셋으로 늘어 실제로 이렇게 됐다).
 *
 * 켜짐 여부만은 기존 값을 지킨다 — 마법사를 다시 훑었다는 이유로 돌고 있던 회차를
 * 멈추거나, 사용자가 꺼 둔 회차를 되살리지 않는다.
 */
async function createCardRound(
  action: Extract<AiaOnboardingAction, { kind: "createScheduledRequest" }>,
  { values, runs, confirm, text, made }: CreationRun,
  workflow: RegisteredWorkflow | null,
): Promise<void> {
  if (!workflow) throw new Error(text("등록된 워크플로가 없어 회차를 만들지 못했습니다.", "No registered workflow to attach the round to."));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const input = buildScheduleInput(
    fillTemplate(action.schedule.name, values),
    workflow.id,
    workflow.version,
    { enabled: action.schedule.enabled, timezone, maxRuns: workflow.parallel ? runs : 1 },
  );
  const plan = roundSavePlan((await getSchedulerSnapshot()).schedules, workflow.id, input);
  const accepted = await confirm({
    title: text("페이싱 회차 저장", "Save paced round"),
    message: plan.id
      ? text("기존 회차를 새 워크플로 버전으로 갱신합니다.", "The existing round will be updated to the new workflow version.")
      : text("새 회차를 일시정지 상태로 저장합니다. 워크플로 페이싱에서 켤 수 있습니다.", "A new paused round will be saved. You can enable it under Workflow pacing."),
    items: [
      fillTemplate(action.schedule.name, values),
      `${workflow.id} v${workflow.version}`,
      workflow.parallel && runs > 1 ? text(`동시 실행 ${runs}건`, `${runs} concurrent runs`) : text("동시 실행 없음", "No concurrent runs"),
    ],
    confirmLabel: plan.id ? text("갱신", "Update") : text("저장", "Save"),
  });
  if (!accepted) throw new Error(text("페이싱 회차 저장을 취소했습니다.", "Saving the paced round was cancelled."));
  const schedule = plan.id
    ? await updateScheduledRequest(plan.id, plan.input)
    : await createScheduledRequest(plan.input);
  made.push({
    label: localized(action.label, text),
    detail: (schedule.enabled
      ? text(`${schedule.name} — 켜짐`, `${schedule.name} — enabled`)
      : text(`${schedule.name} — 꺼진 상태. 워크플로 → 워크플로 페이싱에서 켭니다.`, `${schedule.name} — paused. Enable it under Workflows → Pacing.`))
      + (workflow.parallel && runs > 1 ? text(` · 동시 ${runs}건`, ` · ${runs} at a time`) : "")
      + (plan.id ? text(" · 기존 회차를 새 버전으로 고쳤습니다", " · updated the existing round to the new version") : ""),
  });
}

/**
 * 만들기 버튼이 누르는 절차 한 벌 — 진행 표시·실패 문구·지금까지 만들어진 목록을 한
 * 자리에 둔다. 마법사 본문에는 무엇을 그릴지만 남고, 산출물을 더하는 일은 위 산출물
 * 함수를 하나 더하고 아래 순회에 한 줄 거는 일이 된다.
 */
function useOnboardingCreation(context: Omit<CreationRun, "made">, planned: AiaOnboardingAction[]) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<OnboardingOutcome[]>([]);
  /**
   * 끝까지 간 만들기 한 번. 만들어진 목록만으로는 "다 됐다"를 말할 수 없다 — 도중에
   * 멈춘 실행도 거기까지의 목록을 남기므로, 화면이 같은 목록을 보고 완료를 그리면
   * 실패한 실행이 성공처럼 보인다.
   */
  const [done, setDone] = useState(false);

  const create = async () => {
    setRunning(true);
    setError(null);
    setDone(false);
    const run: CreationRun = { ...context, made: [] };
    let failed = false;
    try {
      assertCreatable(run);
      await createProcedureSkills(run);
      let workflow: RegisteredWorkflow | null = null;
      for (const action of planned) {
        if (action.kind === "createDirectory") await createCardDirectory(action, run);
        if (action.kind === "registerWorkflow") workflow = await registerCardWorkflow(action, run);
        if (action.kind === "createScheduledRequest") await createCardRound(action, run, workflow);
      }
    } catch (cause) {
      failed = true;
      setError(errorText(cause));
    } finally {
      // 도중에 멈춰도 앞서 만든 것은 남는다. 무엇까지 갔는지 보여 줘야 사용자가
      // 다시 눌러야 할지 화면에서 확인할지 정할 수 있다.
      setOutcomes(run.made);
      setDone(!failed);
      setRunning(false);
    }
  };

  const reset = () => {
    setOutcomes([]);
    setError(null);
    setDone(false);
  };

  return { running, error, outcomes, done, create, reset };
}

/** 접힌 카드. 제목·한 줄 설명·시작 버튼만 서고, 단계와 입력은 시작을 눌러야 펼쳐진다. */
function OnboardingStartCard({ card, onHide, onDelete, onStart }: {
  card: AiaOnboardingCardView;
  onHide: () => void;
  onDelete: () => void;
  onStart: () => void;
}) {
  const { text } = useI18n();
  const Icon = cardIcons[card.icon];
  return (
    <article className="aia-onboarding-start" data-ui-anchor="addons.automation-start">
      <i className="aia-onboarding-mark"><Icon size={16} aria-hidden="true" /></i>
      <div>
        <strong>
          {localized(card.title, text)}
          {card.badge ? <em className="addon-mock-badge">{localized(card.badge, text)}</em> : null}
        </strong>
        <small>{localized(card.summary, text)}</small>
      </div>
      <div className="aia-onboarding-card-tools">
        {card.source === "bundled"
          ? <button className="button compact ghost" type="button" onClick={onHide} title={text("끄기", "Hide")}><EyeOff size={13} /></button>
          : <button className="button compact ghost" type="button" onClick={onDelete} title={text("삭제", "Delete")}><Trash2 size={13} /></button>}
        <button className="button compact primary" type="button" onClick={onStart}>
          {text("시작", "Start")}<ChevronRight size={13} />
        </button>
      </div>
    </article>
  );
}

function OnboardingCard({ card, skills, skillsRoot, onHide, onDelete, onRequestAiaPrompt, confirm }: {
  card: AiaOnboardingCardView;
  skills: readonly AiaOnboardingSkillTemplate[];
  skillsRoot: string;
  onHide: () => void;
  onDelete: () => void;
  onRequestAiaPrompt?: (prompt: string) => void;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const { text } = useI18n();
  const [started, setStarted] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<OnboardingValues>(() => initialValues(card));
  const sources = useOnboardingSources(started);
  // 작업공간을 고르면 그 env 파일의 키를 읽어 계정 키 칸을 채워 준다. 값이 가려진 사본을
  // 읽으므로 비밀번호·토큰은 화면에 오지 않는다.
  const workspaceId = cardSteps(card)
    .flatMap((step) => step.fields)
    .find((field) => field.kind === "cypressWorkspacePicker")
    ?.key;
  const [envKeys, setEnvKeys] = useState<string[]>([]);
  // 고른 프로젝트의 브랜치. 저장소를 열면 알 수 있는 값을 사용자가 외워 적게 하지 않는다.
  const projectField = cardSteps(card)
    .flatMap((step) => step.fields)
    .find((field) => field.kind === "projectPicker")
    ?.key;
  const selectedProject = projectField ? values[projectField] ?? "" : "";
  const [branchInfo, setBranchInfo] = useState<{ branches: string[]; currentBranch: string | null }>({
    branches: [], currentBranch: null,
  });
  useEffect(() => {
    if (!started || !selectedProject) {
      setBranchInfo({ branches: [], currentBranch: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      const snapshot = await getClaudePluginBranchRules().catch(() => null);
      const project = snapshot?.projects.find((entry) => entry.path === selectedProject);
      if (!cancelled) {
        setBranchInfo({
          branches: project?.branches ?? [],
          currentBranch: project?.currentBranch ?? null,
        });
      }
    })();
    return () => { cancelled = true; };
  }, [started, selectedProject]);
  const selectedWorkspace = workspaceId ? values[workspaceId] ?? "" : "";
  useEffect(() => {
    if (!started || !selectedWorkspace) {
      setEnvKeys([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const keys = await readCypressWorkspaceFile(selectedWorkspace, "cypress.env.json")
        .then((file: { content: string }) => Object.keys(JSON.parse(file.content) as Record<string, unknown>))
        .catch(() => [] as string[]);
      if (!cancelled) setEnvKeys(keys);
    })();
    return () => { cancelled = true; };
  }, [started, selectedWorkspace]);

  // 현재 브랜치를 한 번 채워 준다. 사용자가 비우면(커밋하지 않겠다는 뜻) 다시 채우지
  // 않는다 — 브랜치 정보는 프로젝트를 바꿀 때만 다시 오므로 그 선택이 유지된다.
  const branchField = cardSteps(card)
    .flatMap((step) => step.fields)
    .find((field) => field.kind === "branchPicker")
    ?.key;
  useEffect(() => {
    if (!branchField || !branchInfo.currentBranch) return;
    setValues((current) => (current[branchField] ? current : { ...current, [branchField]: branchInfo.currentBranch ?? "" }));
  }, [branchField, branchInfo.currentBranch]);

  const Icon = cardIcons[card.icon];
  const steps = cardSteps(card);
  const step = steps[stepIndex];
  const last = stepIndex === steps.length - 1;
  const missing = missingRequired(card, values);
  const planned = activeActions(card, values);
  const paced = planned.some((action) => action.kind === "createScheduledRequest");
  const parallel = supportsParallel(card) && parallelEnabled(values);
  const runs = parallel ? parallelRuns(values) : 1;

  const { running, error, outcomes, done, create, reset } = useOnboardingCreation(
    { card, values, skills, skillsRoot, sources, paced, parallel, runs, confirm, text },
    planned,
  );

  const setValue = (key: string, value: string) => setValues((current) => ({ ...current, [key]: value }));

  /**
   * 만들기가 끝난 뒤 처음 상태로 되돌린다. 적은 값이 그대로 남아 있으면 같은 화면이
   * 다시 서서 만들어졌는지 알 수 없고, 한 번 더 누르면 같은 이름으로 또 등록된다.
   */
  const startOver = () => {
    setValues(initialValues(card));
    setStepIndex(0);
    reset();
  };

  if (!started) {
    return (
      <OnboardingStartCard
        card={card}
        onHide={onHide}
        onDelete={onDelete}
        onStart={() => { setStepIndex(0); setStarted(true); }}
      />
    );
  }

  return (
    <article className="aia-onboarding-wizard">
      <header className="aia-onboarding-card-header">
        <i className="aia-onboarding-mark"><Icon size={16} aria-hidden="true" /></i>
        <div>
          <strong>{localized(card.title, text)}</strong>
          {card.description ? <small>{localized(card.description, text)}</small> : null}
        </div>
        {/* 접기는 적던 값을 그대로 둔다. 다만 만들기를 끝낸 뒤라면 처음 상태로 되돌린다 —
            다 만든 값이 남아 있으면 다시 열었을 때 만들기 전 화면과 구분되지 않는다. */}
        <button className="button compact" type="button" onClick={() => { setStarted(false); if (done) startOver(); else reset(); }}>
          {text("접기", "Collapse")}
        </button>
      </header>

      {done ? <OnboardingDonePanel outcomes={outcomes} onStartOver={startOver} /> : <>

      {card.templates.length > 0 ? (
        <div className="aia-onboarding-templates">
          {card.templates.map((template) => (
            <div className="aia-onboarding-template" key={template.key}>
              <header>
                <strong><Workflow size={13} aria-hidden="true" />{localized(template.title, text)}</strong>
                <code>{template.key}</code>
              </header>
              <ol>{template.steps.map((item) => <li key={item.ko}>{localized(item, text)}</li>)}</ol>
              {template.meta ? <small>{localized(template.meta, text)}</small> : null}
            </div>
          ))}
        </div>
      ) : null}

      <ol className="aia-onboarding-steps" aria-label={text("온보딩 단계", "Onboarding steps")}>
        {steps.map((item, index) => (
          <li key={item.id}>
            <button
              type="button"
              className={index === stepIndex ? "active" : index < stepIndex ? "done" : ""}
              aria-current={index === stepIndex ? "step" : undefined}
              onClick={() => setStepIndex(index)}
            >
              <i>{index + 1}</i>
              <span>{localized(item.title, text)}{item.hint ? <small>{localized(item.hint, text)}</small> : null}</span>
            </button>
          </li>
        ))}
      </ol>

      <div className="aia-onboarding-panel">
        <div className="aia-onboarding-fields">
          {visibleFields(step, values).map((field) => (
            <OnboardingFieldInput
              key={field.key}
              field={field}
              value={values[field.key] ?? ""}
              onChange={(next) => setValue(field.key, next)}
              sources={{ ...sources, envKeys, ...branchInfo }}
              // 읽을 것이 없을 때만 쓰는 길이라 값이 있든 없든 서 있게 둔다. 시스템
              // 에이전트를 고르지 않았으면 넘길 곳이 없어 버튼 자체가 서지 않는다.
              onDraft={onRequestAiaPrompt
                ? () => onRequestAiaPrompt(onboardingDraftPrompt(card, field, values, text))
                : undefined}
            />
          ))}
        </div>

        {error ? <ErrorBanner message={error} /> : null}

        {outcomes.length > 0 ? (
          <div className="aia-onboarding-output">
            {outcomes.map((outcome) => (
              <div key={`${outcome.label}:${outcome.detail}`}><strong>{outcome.label}</strong><small>{outcome.detail}</small></div>
            ))}
          </div>
        ) : null}

        <footer className="aia-onboarding-footer">
          <small>
            {card.previewOnly
              ? text("화면 미리보기 카드입니다. 아직 만들어지는 것이 없습니다.", "Preview card: nothing is created yet.")
              : text(
                `만들기를 누르면 ${planned.length}가지를 차례로 만들고, 각각 승인을 먼저 받습니다.${parallel ? ` 회차는 동시 ${runs}건으로 돌고 레인 절차 스킬을 따릅니다.` : ""}`,
                `Create runs ${planned.length} outcome(s) in order, each with its own approval.${parallel ? ` Rounds run ${runs} at a time under the lane procedure.` : ""}`,
              )}
            {/* 못 채운 칸은 다른 단계에 있을 수 있다. 버튼만 꺼 두면 왜 못 누르는지가
                화면에 없어 사용자가 그 자리에서 멈춘다. */}
            {missing.length > 0 ? (
              <em className="aia-onboarding-missing">
                {text(
                  `채우지 않은 필수 입력: ${missing.map((field) => localized(field.label, text)).join(", ")}`,
                  `Required and still empty: ${missing.map((field) => localized(field.label, text)).join(", ")}`,
                )}
              </em>
            ) : null}
          </small>
          <div className="aia-onboarding-actions">
            <button className="button compact" type="button" disabled={stepIndex === 0} onClick={() => setStepIndex((index) => Math.max(0, index - 1))}>
              <ChevronLeft size={13} />{text("이전", "Back")}
            </button>
            {last
              ? (
                <button
                  className="button compact primary"
                  type="button"
                  disabled={card.previewOnly || running || missing.length > 0}
                  title={missing.length > 0 ? text(`채우지 않은 필수 입력: ${missing.map((field) => localized(field.label, text)).join(", ")}`, `Required: ${missing.map((field) => localized(field.label, text)).join(", ")}`) : undefined}
                  onClick={() => void create()}
                >
                  {running ? text("만드는 중…", "Creating…") : text("만들기", "Create")}
                </button>
              )
              : (
                <button className="button compact primary" type="button" onClick={() => setStepIndex((index) => Math.min(steps.length - 1, index + 1))}>
                  {text("다음", "Next")}<ChevronRight size={13} />
                </button>
              )}
          </div>
        </footer>
      </div>

      </>}
    </article>
  );
}

/**
 * 만들기를 끝낸 카드가 서는 자리. 입력 칸과 만들기 버튼을 치우고 무엇이 만들어졌는지만
 * 남긴다 — 값이 그대로 남은 화면에 "만들기" 버튼이 다시 서 있으면 끝난 줄 모르고 한 번
 * 더 누르게 되고, 같은 이름의 워크플로에 새 버전이 또 얹힌다.
 */
function OnboardingDonePanel({ outcomes, onStartOver }: {
  outcomes: readonly OnboardingOutcome[];
  onStartOver: () => void;
}) {
  const { text } = useI18n();
  return (
    <div className="aia-onboarding-panel aia-onboarding-done-panel" data-ui-anchor="addons.automation-done">
      <p className="aia-onboarding-done">
        <CheckCircle2 size={15} aria-hidden="true" />
        <strong>{text("만들기가 끝났습니다.", "Everything was created.")}</strong>
        <span>{text(
          `아래 ${outcomes.length}가지가 만들어졌습니다.`,
          `The ${outcomes.length} item(s) below were created.`,
        )}</span>
      </p>

      {outcomes.length > 0 ? (
        <div className="aia-onboarding-output">
          {outcomes.map((outcome) => (
            <div key={`${outcome.label}:${outcome.detail}`}><strong>{outcome.label}</strong><small>{outcome.detail}</small></div>
          ))}
        </div>
      ) : null}

      <footer className="aia-onboarding-footer">
        <small>{text(
          "다시 만들려면 처음부터 값을 적습니다. 적었던 값은 지워집니다.",
          "Creating another one starts from empty fields; what you typed is cleared.",
        )}</small>
        <div className="aia-onboarding-actions">
          <button className="button compact primary" type="button" onClick={onStartOver}>
            {text("새로 만들기", "Create another")}
          </button>
        </div>
      </footer>
    </div>
  );
}

/** 드롭다운에서 "직접 적기"를 고른 상태를 나타내는 표식. 값으로 저장되지는 않는다. */
const OTHER_VALUE = "\u0000other";

/** 드롭다운 한 줄. 라벨은 팩이 정한 글이거나 앱이 읽은 목록에 표시를 덧붙인 것이다. */
interface OnboardingChoice {
  value: string;
  label: React.ReactNode;
}

/**
 * 목록에서 고르거나 "기타"로 직접 적는 드롭다운. 팩이 정한 선택지(`select`)와 앱이 읽은
 * 브랜치 목록(`branchPicker`)이 같은 규칙을 쓴다 — 목록에 없는 값이 들어 있으면 사용자가
 * 직접 적은 것이므로, 드롭다운을 "기타"에 두고 옆 칸에 그 값을 그대로 보여 준다.
 *
 * 직접 적기로 옮길 때 값을 공백 한 칸으로 두는 것은, 빈 문자열이 "고르지 않음"과 구별되지
 * 않아 드롭다운이 첫 줄로 되돌아가 버리기 때문이다.
 */
function OnboardingOtherableSelect({ value, onChange, allowOther, emptyLabel, otherPlaceholder, options }: {
  value: string;
  onChange: (value: string) => void;
  allowOther: boolean;
  emptyLabel: React.ReactNode;
  otherPlaceholder: string;
  options: OnboardingChoice[];
}) {
  const { text } = useI18n();
  const other = allowOther && value.length > 0 && !options.some((option) => option.value === value);
  return (
    <>
      <select
        value={other ? OTHER_VALUE : value}
        onChange={(event) => onChange(event.target.value === OTHER_VALUE ? " " : event.target.value)}
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
        {allowOther ? <option value={OTHER_VALUE}>{text("기타(직접 적기)", "Other (type it)")}</option> : null}
      </select>
      {other ? (
        <input
          type="text"
          value={value.trim()}
          placeholder={otherPlaceholder}
          onChange={(event) => onChange(event.target.value || " ")}
        />
      ) : null}
    </>
  );
}

/**
 * 여러 개를 고르는 칸의 확인란 묶음. 팩이 정한 선택지(`multiSelect`)와 앱이 읽은 키
 * 목록(`cypressEnvKeyPicker`)이 같은 모양으로 선다.
 */
function OnboardingChoiceList({ options, chosen, onToggle }: {
  options: OnboardingChoice[];
  chosen: string[];
  onToggle: (value: string, on: boolean) => void;
}) {
  return (
    <div className="aia-onboarding-choices">
      {options.map((option) => (
        <label key={option.value}>
          <input
            type="checkbox"
            checked={chosen.includes(option.value)}
            onChange={(event) => onToggle(option.value, event.target.checked)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/**
 * 쉼표로 이어 둔 한 칸을 항목 목록으로 읽는다. 여러 개를 고르는 칸은 값을 이 한 가지
 * 모양으로만 저장하므로, 읽는 자리마다 다듬기 규칙을 다시 적으면 어느 한 곳에서 빈
 * 항목이나 공백이 섞인 항목이 새어 나간다.
 */
function commaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

/** 입력 한 칸. 종류는 닫힌 목록이라 이 스위치가 팩이 그릴 수 있는 것의 전부다(W6-3). */
function OnboardingFieldInput({ field, value, onChange, sources, onDraft }: {
  field: AiaOnboardingField;
  value: string;
  onChange: (value: string) => void;
  sources: OnboardingSources;
  /** 기록 대상 칸에서만 쓴다 — 읽을 것을 AIA에게 만들어 달라고 넘긴다. */
  onDraft?: () => void;
}) {
  const { text } = useI18n();
  const label = localized(field.label, text);
  const placeholder = field.placeholder ? localized(field.placeholder, text) : undefined;

  const wrap = (input: React.ReactNode) => (
    <label className={field.wide ? "wide" : undefined}>
      <span>{label}{field.required ? " *" : ""}</span>
      {input}
      {field.help ? <small>{localized(field.help, text)}</small> : null}
    </label>
  );

  // 글자 칸이 먼저다. 이 분기가 없으면 아래 기록 대상 목록이 기본 갈래가 되어, 식별자나
  // 경로를 적어야 하는 칸이 마크다운·노션·지라 드롭다운으로 그려진다.
  if (field.kind === "text") {
    return wrap(
      <input type="text" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />,
    );
  }
  if (field.kind === "textarea") {
    return wrap(<textarea rows={2} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />);
  }
  if (field.kind === "number") {
    return wrap(
      <input
        type="number"
        value={value}
        min={field.min ?? undefined}
        max={field.max ?? undefined}
        onChange={(event) => onChange(event.target.value)}
      />,
    );
  }
  if (field.kind === "toggle") {
    return wrap(
      <input type="checkbox" checked={value === "true"} onChange={(event) => onChange(String(event.target.checked))} />,
    );
  }
  if (field.kind === "select") {
    return wrap(
      <OnboardingOtherableSelect
        value={value}
        onChange={onChange}
        allowOther={Boolean(field.allowOther)}
        emptyLabel={text("선택하세요", "Select")}
        otherPlaceholder={text("직접 적기", "Type a value")}
        options={field.options.map((option) => ({ value: option.value, label: localized(option.label, text) }))}
      />,
    );
  }
  if (field.kind === "multiSelect") {
    const chosen = commaList(value);
    const known = new Set(field.options.map((option) => option.value));
    // 목록에 없는 값은 사용자가 직접 적은 것이다. 하나의 칸에 모아 보여 준다.
    const extras = chosen.filter((item) => !known.has(item));
    const write = (items: string[]) => onChange(items.join(","));
    return (
      <div className="wide">
        <span>{label}</span>
        <OnboardingChoiceList
          options={field.options.map((option) => ({ value: option.value, label: localized(option.label, text) }))}
          chosen={chosen}
          onToggle={(option, on) => write(on ? [...chosen, option] : chosen.filter((item) => item !== option))}
        />
        {field.allowOther ? (
          <input
            type="text"
            value={extras.join(", ")}
            placeholder={text("기타 — 쉼표로 구분해 적습니다", "Other — comma separated")}
            onChange={(event) => write([...chosen.filter((item) => known.has(item)), ...commaList(event.target.value)])}
          />
        ) : null}
        {field.help ? <small>{localized(field.help, text)}</small> : null}
      </div>
    );
  }

  // 앱이 목록을 채우는 네 칸. 목록이 비어 있으면 무엇이 없어서 못 고르는지 그 자리에 적는다.
  if (field.kind === "projectPicker") {
    return wrap(
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{sources.projects.length === 0 ? text("활성 프로젝트가 없습니다", "No active project") : text("프로젝트 선택", "Select a project")}</option>
        {sources.projects.map((project) => (
          <option key={project.path} value={project.path}>{project.name} — {project.path}</option>
        ))}
      </select>,
    );
  }
  if (field.kind === "docRootPicker") {
    return wrap(
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{sources.docRoots.length === 0 ? text("등록된 폴더가 없습니다", "No registered folder") : text("등록 폴더 선택", "Select a folder")}</option>
        {/* 값은 id가 아니라 경로다. 회차는 id를 경로로 풀 수단이 없어, 지시문에 id가
            실리면 "기준 없는 상대경로"가 그대로 남는다. */}
        {sources.docRoots.map((root) => <option key={root.id} value={root.path}>{root.name} — {root.path}</option>)}
      </select>,
    );
  }
  if (field.kind === "branchPicker") {
    return wrap(
      <OnboardingOtherableSelect
        value={value}
        onChange={onChange}
        allowOther={Boolean(field.allowOther)}
        emptyLabel={sources.branches.length === 0
          ? text("브랜치를 읽지 못했습니다 — 비워 두면 커밋하지 않습니다", "No branches read — empty means no commit")
          : text("커밋하지 않음", "Do not commit")}
        otherPlaceholder={text("브랜치 이름", "Branch name")}
        options={sources.branches.map((branch) => ({
          value: branch,
          label: <>{branch}{branch === sources.currentBranch ? text(" (현재)", " (current)") : ""}</>,
        }))}
      />,
    );
  }
  if (field.kind === "cypressEnvKeyPicker") {
    // 값은 가려진 사본에서 읽은 키 이름뿐이다. 작업공간을 고르기 전이거나 파일이 없으면
    // 직접 적을 수 있게 둔다 — 온보딩이 "적을 수 없는 값"을 묻는 자리가 되지 않게.
    const chosen = commaList(value);
    const write = (items: string[]) => onChange(items.join(","));
    return (
      <div className="wide">
        <span>{label}</span>
        {sources.envKeys.length > 0 ? (
          <OnboardingChoiceList
            options={sources.envKeys.map((key) => ({ value: key, label: key }))}
            chosen={chosen}
            onToggle={(key, on) => write(on ? [...chosen, key] : chosen.filter((item) => item !== key))}
          />
        ) : null}
        <input
          type="text"
          value={chosen.join(", ")}
          placeholder={text("쉼표로 구분해 적습니다", "Comma separated")}
          onChange={(event) => write(commaList(event.target.value))}
        />
        <small>
          {sources.envKeys.length > 0
            ? text(
              `고른 작업공간의 cypress.env.json에서 키 ${sources.envKeys.length}개를 읽었습니다. 값은 읽지 않습니다.`,
              `Read ${sources.envKeys.length} key(s) from the workspace's cypress.env.json; values are never read.`,
            )
            : text(
              "작업공간을 고르면 그 cypress.env.json의 키를 읽어 보여 줍니다. 파일이 없으면 여기에 직접 적으세요.",
              "Pick a workspace to read the key names from its cypress.env.json, or type them here.",
            )}
          {field.help ? ` ${localized(field.help, text)}` : ""}
        </small>
      </div>
    );
  }
  if (field.kind === "cypressWorkspacePicker") {
    return wrap(
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{sources.workspaces.length === 0 ? text("등록된 작업공간이 없습니다", "No registered workspace") : text("작업공간 선택", "Select a workspace")}</option>
        {sources.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
      </select>,
    );
  }

  if (field.kind !== "recordTargetPicker") {
    // 앞의 어느 갈래에도 들지 않는 종류. 백엔드가 닫힌 목록으로 막지만, 앱이 새 종류를
    // 알기 전의 팩을 만나도 값을 잃지 않도록 글자 칸으로 받는다.
    return wrap(
      <input type="text" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />,
    );
  }

  const targets = availableRecordTargets(sources.plugins);
  return wrap(
    <>
      <select value={targets.some((target) => target.id === value) ? value : ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">{text("선택하세요", "Select")}</option>
        {targets.map((target) => <option key={target.id} value={target.id}>{text(target.ko, target.en)}</option>)}
      </select>
      {/* 읽을 것이 아직 없는 프로젝트를 위한 갈래. 앱은 만들지 않는다 — 적어 둔 값을
          실은 요청문으로 AIA 대화를 열고, 만드는 일과 승인은 거기서 이뤄진다. */}
      {onDraft ? (
        <button className="button compact" type="button" onClick={onDraft} data-ui-anchor="addons.automation-draft">
          <AiaMark size={13} />
          {text("AIA에게 만들어 달라고 하기", "Ask AIA to create them")}
        </button>
      ) : null}
    </>,
  );
}
