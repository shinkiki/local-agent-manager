import { Blocks, Building2, CalendarClock, ChevronLeft, ChevronRight, FlaskConical, NotebookPen, Route, SquareTerminal, Workflow, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { getDocRoots, getExternalPlugins } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { DocRootStatus, ExternalPluginView } from "../types";
import type { TabRequest } from "../lib/uiGuide";
import { ClaudePluginsCard } from "./ClaudePluginsCard";
import { SettingsSubTabPanel, SettingsSubTabs, type SettingsSubTab } from "./SettingsSubTabs";
import { AiaMark } from "./Shared";

export type AddonsTabId = "aia" | "claude" | "codex";

const ADDONS_TAB_KEY = "agent-manager.addons-tab.v1";

/**
 * 마지막으로 본 애드온 탭. App이 활성 화면을 기억하므로 탭까지 함께 남아야 새로고침 뒤에
 * 보던 자리로 돌아온다. 저장소가 막힌 환경에서는 기본 탭으로 떨어진다.
 */
function loadAddonsTab(): AddonsTabId {
  try {
    const stored = window.localStorage.getItem(ADDONS_TAB_KEY);
    return stored === "aia" || stored === "claude" || stored === "codex" ? stored : "aia";
  } catch {
    return "aia";
  }
}

const addonsTabs: readonly SettingsSubTab<AddonsTabId>[] = [
  { id: "aia", icon: AiaMark, ko: "아이아", en: "AIA", anchor: "addons.tab.aia" },
  { id: "claude", icon: Blocks, ko: "클로드", en: "Claude", anchor: "addons.tab.claude" },
  { id: "codex", icon: SquareTerminal, ko: "코덱스", en: "Codex", anchor: "addons.tab.codex" },
];

/**
 * 주 메뉴의 애드온 화면. 에이전트별 부가 기능을 아이아·클로드·코덱스 탭으로 나눈다.
 * Claude Code 플러그인 카드는 설정 → 플러그인에서 이곳으로 옮겨 왔고(동작 그대로),
 * 아이아 탭은 QA 워크플로 온보딩의 화면 목업이다. 탭 나눔은 설정의 중메뉴와 같은 부품을 쓴다.
 */
export function AddonsView({ active, tabRequest = null }: { active: boolean; tabRequest?: TabRequest<AddonsTabId> | null }) {
  const { text } = useI18n();
  const [tab, setTab] = useState<AddonsTabId>(loadAddonsTab);
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest]);
  useEffect(() => {
    try { window.localStorage.setItem(ADDONS_TAB_KEY, tab); }
    catch { /* 저장소가 막혀도 이번 실행의 선택은 그대로 적용된다. */ }
  }, [tab]);
  return (
    <div className="settings-subtab-view addons-view">
      <SettingsSubTabs idPrefix="addons" tabs={addonsTabs} value={tab} onChange={setTab} label={text("애드온 종류", "Add-on type")} />
      <SettingsSubTabPanel idPrefix="addons" id="aia" active={tab === "aia"}>
        <AiaQaOnboardingMock />
      </SettingsSubTabPanel>
      <SettingsSubTabPanel idPrefix="addons" id="claude" active={tab === "claude"}>
        <ClaudePluginsCard active={active && tab === "claude"} />
      </SettingsSubTabPanel>
      <SettingsSubTabPanel idPrefix="addons" id="codex" active={tab === "codex"}>
        <CodexAddonCard />
      </SettingsSubTabPanel>
    </div>
  );
}

interface OnboardingStep {
  id: "system" | "environment" | "scenario" | "records" | "rounds";
  icon: LucideIcon;
  ko: string;
  en: string;
  koHint: string;
  enHint: string;
}

const onboardingSteps: readonly OnboardingStep[] = [
  { id: "system", icon: Building2, ko: "대상 시스템", en: "Target system", koHint: "이름·저장소·개발서버", enHint: "Name, repository, dev server" },
  { id: "environment", icon: FlaskConical, ko: "테스트 환경", en: "Test environment", koHint: "Cypress 작업공간·계정 역할", enHint: "Cypress workspace and account roles" },
  { id: "scenario", icon: Route, ko: "시나리오 축·규율", en: "Scenario axes and rules", koHint: "회귀 선별·신규 패턴·검증 축", enHint: "Regression picks, new pattern, checks" },
  { id: "records", icon: NotebookPen, ko: "기록 대상", en: "Records", koHint: "회차 문서·QA 티켓을 남길 곳", enHint: "Where round docs and QA tickets go" },
  { id: "rounds", icon: CalendarClock, ko: "회차 운영·생성", en: "Rounds and output", koHint: "페이싱 회차·산출물", enHint: "Paced rounds and outputs" },
];

/** 온보딩이 본뜨는 절차의 뼈대. 특정 고객사 이름 없이 회차 절차와 티켓 처리 절차의 단계만 남긴다. */
const sourceWorkflows: readonly { key: string; ko: string; en: string; koMeta: string; enMeta: string; steps: readonly [string, string][] }[] = [
  {
    key: "<system>-qa",
    ko: "QA 회차 절차",
    en: "QA round procedure",
    koMeta: "회차당 신규 패턴 1건 · 사용량 페이싱 회차로 무인 실행",
    enMeta: "One new pattern per round, run unattended by usage pacing",
    steps: [
      ["대상 확인", "Pick targets"], ["회귀 선별", "Select regressions"], ["신규 패턴 1건", "One new pattern"],
      ["입력·권한·출력 검증", "Verify input, authority, print"], ["Cypress 실행", "Run Cypress"], ["시나리오 ID", "Scenario ID"],
      ["시나리오 등록", "Register scenario"], ["결함은 QA 티켓", "Defect to QA ticket"], ["데이터 정리", "Clean up data"], ["최종 보고", "Final report"],
    ],
  },
  {
    key: "qa-flow",
    ko: "QA 티켓 처리",
    en: "QA ticket handling",
    koMeta: "등록된 QA 티켓을 잡아 수정·커밋·리베이스·결과 작성까지",
    enMeta: "Take a registered QA ticket through fix, commit, rebase, and write-up",
    steps: [
      ["티켓 확인", "Read the ticket"], ["코드 수정", "Fix code"], ["개발선 커밋", "Commit to the dev line"],
      ["로컬 원격 리베이스", "Rebase local origin"], ["결과 작성", "Write results"],
    ],
  },
];

const accountRoles: readonly [string, string][] = [
  ["기안자", "Drafter"], ["결재자", "Approver"], ["관리자", "Admin"], ["열람 자격자", "Reader"], ["순수 제3자(인가 검증)", "Outsider (authz check)"],
];

const verificationAxes: readonly [string, string][] = [
  ["입력·팝업·그리드", "Input, popups, grids"], ["권한·문서 상태", "Authority and document state"], ["출력·인쇄", "Print"], ["변경이력 비교", "Change-history diff"],
];

/** 회차 문서·QA 티켓을 남길 곳. 마크다운은 늘 있고, 나머지는 플러그인이 붙어 있을 때만 고를 수 있다. */
type RecordTarget = "markdown" | "notion" | "jira";

/**
 * 연결된 외부 플러그인에서 고를 수 있는 기록 대상을 뽑는다. 마크다운 문서는 앱이 스스로
 * 쓰므로 언제나 선택지이고, 노션·지라는 실제로 새 채팅에 붙는 플러그인(attachable)이
 * 있을 때만 더한다. 플러그인 식별자·표시 이름·주소 어디에 이름이 있어도 잡는다.
 */
function availableRecordTargets(plugins: readonly ExternalPluginView[]): RecordTarget[] {
  const has = (...needles: string[]) => plugins.some((plugin) => {
    if (!plugin.attachable) return false;
    const haystack = `${plugin.id} ${plugin.displayName} ${plugin.url ?? ""}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
  const targets: RecordTarget[] = ["markdown"];
  if (has("notion")) targets.push("notion");
  if (has("jira", "atlassian")) targets.push("jira");
  return targets;
}

/**
 * 아이아 탭의 QA 워크플로 온보딩 목업. 지금 돌고 있는 QA 회차·티켓 처리 절차를 본떠
 * 다른 시스템의 QA 워크플로(스킬·워크플로 계약·페이싱 회차)를 만드는 화면의 골격만 있다.
 * 처음에는 절차 소개만 보이고, 시작 버튼을 눌러야 단계 화면이 열린다. 단계 이동은 되지만
 * 입력은 저장되지 않고 생성 버튼은 백엔드가 붙기 전까지 잠겨 있다.
 */
function AiaQaOnboardingMock() {
  const { text } = useI18n();
  const [started, setStarted] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [docRoots, setDocRoots] = useState<DocRootStatus[]>([]);
  const [targets, setTargets] = useState<RecordTarget[]>(["markdown"]);
  const step = onboardingSteps[stepIndex];
  const last = stepIndex === onboardingSteps.length - 1;

  // 기록 대상 선택지는 시작한 뒤에 읽는다. 목업이라 실패해도 화면을 막지 않고,
  // 마크다운 문서만 남은 기본 선택지로 계속 진행한다.
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    void (async () => {
      try {
        const roots = await getDocRoots();
        if (!cancelled) setDocRoots(roots);
      } catch { /* 문서 루트를 못 읽으면 경로만 직접 적는다. */ }
      try {
        const snapshot = await getExternalPlugins();
        if (!cancelled) setTargets(availableRecordTargets(snapshot.plugins));
      } catch { /* 플러그인 목록을 못 읽으면 마크다운 문서만 남는다. */ }
    })();
    return () => { cancelled = true; };
  }, [started]);

  return (
    <section className="settings-card aia-addon-card" data-ui-anchor="addons.aia-content">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><AiaMark size={18} /></i>
          <div>
            <span>AIA</span>
            <h2>{text("QA 워크플로 온보딩", "QA workflow onboarding")} <em className="addon-mock-badge">{text("목업 · 준비 중", "Mock · in preparation")}</em></h2>
          </div>
        </div>
        <p>{text(
          "이미 돌고 있는 QA 회차·티켓 처리 절차를 본떠 다른 시스템의 QA 워크플로를 만듭니다. 아직 화면 목업이라 입력은 저장되지 않고 생성은 열리지 않습니다.",
          "Builds a QA workflow for another system from the QA round and ticket procedures already in use. This is a screen mock: nothing is saved and generation is not wired yet.",
        )}</p>
      </header>

      <div className="aia-onboarding-templates">
        {sourceWorkflows.map((workflow) => (
          <article className="aia-onboarding-template" key={workflow.key}>
            <header>
              <strong><Workflow size={13} aria-hidden="true" />{text(workflow.ko, workflow.en)}</strong>
              <code>{workflow.key}</code>
            </header>
            <ol>
              {workflow.steps.map(([ko, en]) => <li key={ko}>{text(ko, en)}</li>)}
            </ol>
            <small>{text(workflow.koMeta, workflow.enMeta)}</small>
          </article>
        ))}
      </div>

      {!started ? (
        <div className="aia-onboarding-start" data-ui-anchor="addons.aia-start">
          <div>
            <strong>{text("다섯 단계로 워크플로를 맞춥니다", "Five steps to shape the workflow")}</strong>
            <small>{text(
              "대상 시스템 · 테스트 환경 · 시나리오 축 · 기록 대상 · 회차 운영을 차례로 정합니다. 시작해도 아직 아무것도 저장되지 않습니다.",
              "Target system, test environment, scenario axes, records, and round operation in order. Starting still saves nothing.",
            )}</small>
          </div>
          <button className="button compact primary" type="button" onClick={() => { setStepIndex(0); setStarted(true); }}>
            {text("온보딩 시작", "Start onboarding")}<ChevronRight size={13} />
          </button>
        </div>
      ) : (
        <div className="aia-onboarding-wizard">
          <ol className="aia-onboarding-steps" aria-label={text("온보딩 단계", "Onboarding steps")}>
            {onboardingSteps.map((item, index) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={index === stepIndex ? "active" : index < stepIndex ? "done" : ""}
                  aria-current={index === stepIndex ? "step" : undefined}
                  onClick={() => setStepIndex(index)}
                >
                  <i>{index + 1}</i>
                  <span>{text(item.ko, item.en)}<small>{text(item.koHint, item.enHint)}</small></span>
                </button>
              </li>
            ))}
          </ol>

          <div className="aia-onboarding-panel">
            <header>
              <i><step.icon size={16} aria-hidden="true" /></i>
              <div><strong>{text(step.ko, step.en)}</strong><small>{text(step.koHint, step.enHint)}</small></div>
            </header>

            {/* qa28: 입력이 비제어(defaultValue)라 단계가 바뀌어도 같은 자리의 <input>이 재사용되면
                앞 단계에 친 값이 다음 단계의 엉뚱한 칸에 남는다. 단계마다 key를 달아 입력을
                새로 마운트한다. 목업이 아닌 실제 화면에서는 입력값을 부모 상태로 끌어올릴 것. */}
            <AiaQaStepFields key={step.id} stepId={step.id} docRoots={docRoots} targets={targets} />

            <footer className="aia-onboarding-footer">
              <small>{text("목업 화면입니다. 입력값은 저장되지 않고 생성 버튼은 백엔드 연결 뒤 열립니다.", "Screen mock: inputs are not saved and generation opens once the backend is connected.")}</small>
              <div className="aia-onboarding-actions">
                <button className="button compact" type="button" disabled={stepIndex === 0} onClick={() => setStepIndex((index) => Math.max(0, index - 1))}><ChevronLeft size={13} />{text("이전", "Back")}</button>
                {last
                  ? <button className="button compact primary" type="button" disabled title={text("준비 중", "In preparation")}>{text("워크플로 생성", "Generate workflow")}</button>
                  : <button className="button compact primary" type="button" onClick={() => setStepIndex((index) => Math.min(onboardingSteps.length - 1, index + 1))}>{text("다음", "Next")}<ChevronRight size={13} /></button>}
              </div>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 온보딩 목업의 입력 한 칸. 단계마다 `<label><span>{text(ko, en)}</span>…</label>` 껍데기를
 * 손으로 되풀이하면서 넓은 칸(`wide`)을 붙이는 자리와 빠뜨린 자리가 섞였다. 껍데기를 한 벌로
 * 두고 안에 들어갈 입력만 각 단계가 정한다.
 */
function MockField({ ko, en, wide = false, children }: { ko: string; en: string; wide?: boolean; children: ReactNode }) {
  const { text } = useI18n();
  return <label className={wide ? "wide" : undefined}><span>{text(ko, en)}</span>{children}</label>;
}

/**
 * 글자 입력 한 칸. 목업의 입력 열두 벌이 모두 같은 모양이라 이름표와 자리글만 받는다.
 * 자리글이 한국어·영어 두 벌이면 `placeholderEn`을 함께 주고, 경로·주소처럼 번역이 없는
 * 자리글은 `placeholder` 하나만 준다.
 */
function MockTextField({ ko, en, wide, placeholder, placeholderEn, defaultValue }: {
  ko: string;
  en: string;
  wide?: boolean;
  placeholder?: string;
  placeholderEn?: string;
  defaultValue?: string;
}) {
  const { text } = useI18n();
  return (
    <MockField ko={ko} en={en} wide={wide}>
      <input
        type="text"
        placeholder={placeholderEn === undefined ? placeholder : text(placeholder ?? "", placeholderEn)}
        defaultValue={defaultValue}
      />
    </MockField>
  );
}

/**
 * 여러 개를 고르는 체크박스 묶음. 앞에서부터 `checkedThrough`개가 켜진 채로 시작한다
 * (생략하면 전부 켬).
 */
function MockChoiceGroup({ ko, en, options, checkedThrough }: {
  ko: string;
  en: string;
  options: readonly (readonly [string, string])[];
  checkedThrough?: number;
}) {
  const { text } = useI18n();
  const checked = checkedThrough ?? options.length;
  return (
    <div className="wide">
      <span>{text(ko, en)}</span>
      <div className="aia-onboarding-choices">
        {options.map(([optionKo, optionEn], index) => (
          <label key={optionKo}><input type="checkbox" defaultChecked={index < checked} />{text(optionKo, optionEn)}</label>
        ))}
      </div>
    </div>
  );
}

/** 단계별 입력 영역. 온보딩의 이동·생성 제어와 각 단계의 필드 구성을 분리한다. */
function AiaQaStepFields({ stepId, docRoots, targets }: { stepId: OnboardingStep["id"]; docRoots: readonly DocRootStatus[]; targets: readonly RecordTarget[] }) {
  const { text } = useI18n();

  if (stepId === "system") {
    return (
      <div className="aia-onboarding-fields">
        <MockTextField ko="시스템 이름" en="System name" placeholder="예: 인사 포털" placeholderEn="e.g. HR portal" />
        <MockTextField ko="업무 영역" en="Business areas" placeholder="예: 결재 · 동적양식 · 공통영역 · 인쇄" placeholderEn="e.g. approval · dynamic forms · common area · print" />
        <MockTextField ko="저장소 경로" en="Repository path" wide placeholder="~/gsProjects/<system>" />
        <MockTextField ko="개발서버 주소" en="Dev server URL" wide placeholder="https://dev.example.com" />
      </div>
    );
  }

  if (stepId === "environment") {
    return (
      <div className="aia-onboarding-fields">
        <MockField ko="Cypress 작업공간" en="Cypress workspace">
          <select defaultValue="default">
            <option value="default">{text("기본 작업공간(앱 데이터)", "Default workspace (app data)")}</option>
            <option value="external">{text("외부 프로젝트 등록(저장소 안의 cypress 폴더)", "Register external project (a cypress folder in the repository)")}</option>
          </select>
        </MockField>
        <MockTextField
          ko="계정 파일 키"
          en="Account file keys"
          placeholder="cypress.env.json 키 이름(값은 앱에 저장되지 않음)"
          placeholderEn="cypress.env.json key names (values never stored in the app)"
        />
        <MockChoiceGroup ko="테스트 계정 역할" en="Test account roles" options={accountRoles} checkedThrough={3} />
      </div>
    );
  }

  if (stepId === "scenario") {
    return (
      <div className="aia-onboarding-fields">
        <MockField ko="회차당 신규 패턴" en="New patterns per round">
          <input type="number" defaultValue={1} min={1} max={3} />
        </MockField>
        <MockTextField ko="시나리오 ID 접두어" en="Scenario ID prefix" placeholder="예: DF-, AC-" placeholderEn="e.g. DF-, AC-" />
        <MockChoiceGroup ko="검증 축" en="Verification axes" options={verificationAxes} />
        <MockField ko="회귀 선별 규칙" en="Regression selection rule" wide>
          <textarea rows={2} placeholder={text("예: 직전 회차 결함 재검증 + 무작위 2건. 매회 전부 돌리지 않는다.", "e.g. re-verify last round's defects + 2 random picks; never run everything each round.")} />
        </MockField>
      </div>
    );
  }

  if (stepId === "records") return <AiaQaRecordFields docRoots={docRoots} targets={targets} />;

  return (
    <div className="aia-onboarding-fields">
      <MockField ko="실행 방식" en="Execution">
        <select defaultValue="paced">
          <option value="paced">{text("사용량 페이싱 회차(무인)", "Usage-paced rounds (unattended)")}</option>
          <option value="manual">{text("수동 실행", "Manual runs")}</option>
        </select>
      </MockField>
      <MockTextField ko="회당 토큰 목표" en="Token target per round" placeholder="예: 40만 토큰 이하" placeholderEn="e.g. under 400k tokens" />
      <div className="wide">
        <span>{text("생성될 산출물", "Outputs to generate")}</span>
        <div className="aia-onboarding-output">
          <div><strong>SKILL.md</strong><small>{text("<시스템>-qa 회차 스킬. 회차 절차의 규율을 시스템 값으로 치환", "<system>-qa round skill: the round discipline with this system's values")}</small></div>
          <div><strong>{text("워크플로 계약", "Workflow contract")}</strong><small>{text("paced:true · start_chat 1건 · 스킬 호출 프롬프트", "paced:true · one start_chat · skill invocation prompt")}</small></div>
          <div><strong>{text("페이싱 회차 초안", "Paced round draft")}</strong><small>{text("워크플로 페이싱 탭에 자동 주기로 등록(꺼진 상태)", "Registered in the pacing tab on auto interval, paused")}</small></div>
        </div>
      </div>
    </div>
  );
}

/**
 * 기록 대상 단계. 기본은 마크다운 문서라 회차 문서·QA 티켓이 문서 폴더에 .md로 쌓인다.
 * 노션·지라 플러그인이 실제로 붙어 있을 때만 그 선택지가 늘어나므로, 연결이 없는 환경에서는
 * 쓸 수 없는 칸이 보이지 않는다.
 */
function AiaQaRecordFields({ docRoots, targets }: { docRoots: readonly DocRootStatus[]; targets: readonly RecordTarget[] }) {
  const { text } = useI18n();
  const [target, setTarget] = useState<RecordTarget>("markdown");
  const choice = targets.includes(target) ? target : "markdown";
  const labels: Record<RecordTarget, [string, string]> = {
    markdown: ["마크다운 문서(.md)", "Markdown documents (.md)"],
    notion: ["노션 데이터베이스", "Notion databases"],
    jira: ["지라 이슈", "Jira issues"],
  };

  return (
    <div className="aia-onboarding-fields">
      <MockField ko="기록 대상" en="Record destination" wide>
        <select value={choice} onChange={(event) => setTarget(event.target.value as RecordTarget)}>
          {targets.map((item) => (
            <option key={item} value={item}>{text(...labels[item])}</option>
          ))}
        </select>
      </MockField>

      {choice === "markdown" ? (
        <>
          <MockField ko="문서 폴더" en="Document folder">
            <select defaultValue={docRoots[0]?.id ?? ""}>
              {docRoots.length === 0
                ? <option value="">{text("등록된 문서 폴더가 없습니다", "No document folder registered")}</option>
                : docRoots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
            </select>
          </MockField>
          <MockTextField ko="회차 문서 경로" en="Round document path" defaultValue="qa/rounds/{round}.md" />
          <MockTextField ko="QA 티켓 경로" en="QA ticket path" wide defaultValue="qa/tickets/{id}.md" />
        </>
      ) : null}

      {choice === "notion" ? (
        <>
          <MockTextField ko="Test Scenario 데이터베이스" en="Test Scenario database" placeholder="노션 데이터베이스 주소" placeholderEn="Notion database URL" />
          <MockTextField ko="QA Sheets 데이터베이스" en="QA Sheets database" placeholder="노션 데이터베이스 주소" placeholderEn="Notion database URL" />
        </>
      ) : null}

      {choice === "jira" ? (
        <>
          <MockTextField ko="프로젝트 키" en="Project key" placeholder="QA" />
          <MockTextField ko="이슈 유형" en="Issue type" placeholder="예: Bug, Task" placeholderEn="e.g. Bug, Task" />
        </>
      ) : null}

      <p className="wide aia-onboarding-note">
        <NotebookPen size={14} aria-hidden="true" />
        {choice === "markdown"
          ? text(
            targets.length > 1
              ? "회차 문서와 QA 티켓을 고른 문서 폴더 아래 .md로 만들어 문서 화면에 그대로 나타납니다. 연결된 노션·지라로 바꿀 수도 있습니다."
              : "회차 문서와 QA 티켓을 고른 문서 폴더 아래 .md로 만들어 문서 화면에 그대로 나타납니다. 설정 → 플러그인에서 노션·지라를 연결하면 기록 대상 선택지가 늘어납니다.",
            targets.length > 1
              ? "Round documents and QA tickets are created as .md under the chosen document folder and show up in Documents. You can switch to a connected Notion or Jira instead."
              : "Round documents and QA tickets are created as .md under the chosen document folder and show up in Documents. Connect Notion or Jira under Settings → Plugins to get more destinations.",
          )
          : text(
            "연결된 플러그인으로 기록합니다. 증적(캡처·JSON)은 산출물 폴더에서 티켓 본문으로 첨부합니다.",
            "Records are written through the connected plugin. Evidence (captures, JSON) is attached to tickets from the artifacts folder.",
          )}
      </p>
    </div>
  );
}

/** 코덱스 탭 자리. 아직 정해진 기능이 없어 비어 있음을 알리는 카드만 둔다. */
function CodexAddonCard() {
  const { text } = useI18n();
  return (
    <section className="settings-card codex-addon-card" data-ui-anchor="addons.codex-content">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><SquareTerminal size={18} aria-hidden="true" /></i>
          <div><span>CODEX</span><h2>{text("Codex 애드온", "Codex add-ons")}</h2></div>
        </div>
        <p>{text("Codex CLI에 붙는 부가 기능이 여기에 모입니다.", "Add-ons that attach to the Codex CLI will live here.")}</p>
      </header>
      <div className="plugin-empty-state addon-empty-state">
        <i><SquareTerminal size={25} /></i>
        <div>
          <strong>{text("준비 중입니다", "Coming soon")}</strong>
          <small>{text("아직 등록된 Codex 애드온이 없습니다. Codex 플러그인·스킬 설정이 정해지면 이 자리에 들어옵니다.", "No Codex add-on is registered yet. Codex plugin and skill settings will appear here once defined.")}</small>
        </div>
      </div>
    </section>
  );
}
