import type { ViewId } from "../types";
import { DEFAULT_NAVIGATION_ORDER, UNCONFIGURABLE_VIEWS } from "./navigationPreferences.ts";

const NAVIGATION_HELP: Record<ViewId, { ko: string; en: string }> = {
  dashboard: {
    ko: "연결된 CLI와 활성 계정 사용량, 세션·토큰·저장공간 요약, 최근 12주 추이, 반복 일정, 모델·프로젝트·최근 세션을 한 화면에서 확인합니다. 요약 카드와 목록을 눌러 관련 설정이나 세션으로 이동할 수 있습니다.",
    en: "Review connected CLIs, active-account usage, session, token, and storage summaries, 12-week trends, schedules, models, projects, and recent sessions in one place. Open related settings or sessions from the summary cards and lists.",
  },
  chat: {
    ko: "설치된 공급자 CLI로 새 구조화 채팅을 시작하고, 여러 실행 중 채팅을 전환하며 메시지와 파일을 보낼 수 있습니다. 권한 승인, 요청별 작업 로그, 실행설정과 반복 요청도 이 메뉴에서 관리합니다.",
    en: "Start structured chats with installed provider CLIs, switch between live chats, and send messages and files. This menu also manages approvals, per-request activity, runtime settings, and recurring requests.",
  },
  sessions: {
    ko: "공급자가 로컬에 저장한 대화 이력을 읽기 전용으로 색인해 검색·필터·즐겨찾기·폴더로 정리합니다. 세션 상세와 대화 내용을 확인하고, 지원되는 세션은 새 메시지로 안전하게 이어갈 수 있습니다. 폴더의 연필을 누르면 이름·색상·위치·순서·숨김·삭제를 다룹니다. 숨긴 폴더의 세션은 전체 세션과 상위 폴더에서 빠지고, 그 폴더를 눌렀을 때만 보입니다.",
    en: "Search, filter, favorite, and organize provider conversation history indexed read-only from local storage. Review session details and transcripts, and safely continue supported sessions with a new message. The pencil on a folder handles its name, color, position, order, hiding, and deletion. Sessions in a hidden folder drop out of the all-sessions list and its parent folders, and appear only when that folder is selected.",
  },
  docs: {
    ko: "로컬 Markdown 폴더를 등록해 문서를 검색하고 미리보기·편집·저장·다운로드할 수 있습니다. 폴더 등록을 해제해도 원본 폴더와 파일은 삭제되지 않습니다.",
    en: "Register local Markdown folders to search, preview, edit, save, and download documents. Unregistering a folder does not delete its original folder or files.",
  },
  instructions: {
    ko: "AGENTS.md·CLAUDE.md·GEMINI.md 지침을 공통 저장소에 보관하고 Agent Manager 세션에서 확인한 프로젝트에 배포합니다. 지침이 @경로·링크로 함께 읽는 연결 문서까지 한 세트로 보관·배포하며, ~/나 절대 경로처럼 위치에 매인 링크는 보관하지 않고 이유를 알립니다. 저장소는 기본적으로 앱 내부에 있으며 클라우드 드라이브의 특정 폴더로 바꿀 수 있습니다. OS별 변형은 일치하는 환경에서만 활성화되며 AIA가 만든 스크립트나 명령은 자동 실행하지 않습니다.",
    en: "Archive AGENTS.md, CLAUDE.md, and GEMINI.md instructions in the shared repository and publish them to projects discovered from Agent Manager sessions. Documents the instruction reads through @path imports and links are archived and published as one set; location-bound links (~/, absolute paths) stay out of the archive with the reason shown. The repository defaults to app storage and can point to a cloud-drive folder. OS variants activate only on matching systems, and AIA never automatically runs generated scripts or commands.",
  },
  skills: {
    ko: "Claude·Codex·Antigravity에서 발견한 스킬을 조회하고 공통 스킬 원본을 개인 또는 등록 프로젝트에 게시합니다. OS별 변형은 일치하는 환경에서만 활성화되며, 호환되지 않는 스킬은 AIA 마이그레이션 계획으로 연결됩니다.",
    en: "Review skills discovered from Claude, Codex, and Antigravity, then publish shared skill sources to personal or registered-project locations. OS variants activate only on matching systems, and incompatible skills link to an AIA migration plan.",
  },
  agents: {
    ko: "로컬 Claude 에이전트 Markdown 정의를 탐지해 이름·설명·도구·스킬·모델로 검색합니다. 에이전트를 선택하면 권한 모드, 최대 턴, 시스템 프롬프트와 원본 파일 위치를 확인할 수 있습니다.",
    en: "Discover local Claude agent Markdown definitions and search by name, description, tools, skills, or model. Select an agent to review its permission mode, maximum turns, system prompt, and source file.",
  },
  artifacts: {
    ko: "Antigravity 대화의 brain 폴더에서 작업 목록·구현 계획·워크스루와 이미지 정보를 탐지합니다. 대화나 요약으로 검색하고 아티팩트의 내용·버전·원문을 확인할 수 있습니다.",
    en: "Discover task lists, implementation plans, walkthroughs, and image information from Antigravity conversation brain folders. Search by conversation or summary and review artifact content, versions, and originals.",
  },
  workflows: {
    ko: "워크플로 관리 탭에서 AIA가 등록한 시스템 워크플로를 확인하고 실행·삭제하며, 워크플로마다 사용량 페이싱 상태를 봅니다(대상 여부는 계약이 정합니다). 워크플로는 system_catalog에 등록된 작업만 정해진 순서로 호출하며, 셸 명령·임의 파일 접근·다른 워크플로 호출은 표현할 수 없습니다. 단계 구성과 버전 이력, 직전 실행 결과를 보고 실행 전에 되돌리기 어려운 영향을 확인할 수 있습니다. 워크플로 페이싱 탭에서는 페이싱을 켠 워크플로가 쓸 계정 풀과 참여할 반복 요청, 회차마다 지킬 목표·가드·소비 상한을 정합니다. 요약 카드의 페이싱 사용 스위치는 기능 전체를 켜고 끄며, 끄면 예약 회차가 뜨지 않고 설정은 그대로 남습니다. 요약 카드의 스케줄 버튼은 페이싱 스케줄 — 페이싱을 멈출 시간대와 적용 요일 — 을 정합니다. 사용량을 쓰지 않는 워크플로는 이 예산이 통제하지 않습니다.",
    en: "In the workflow management tab, review system workflows registered by AIA, run or delete them, and see each workflow's usage pacing status (the contract decides which workflows are paced). A workflow calls only operations registered in system_catalog in a fixed order; shell commands, arbitrary file access, and calling other workflows cannot be expressed. Inspect step composition, version history, and the last run before executing, with hard-to-recover effects shown up front. The workflow pacing tab sets the account pool and scheduled requests pacing-enabled workflows may use, plus the target, guard, and per-run ceiling each round must respect. The pacing switch on the summary card turns the whole feature on and off; while off no round launches on schedule and every setting stays as it is. The schedule button on the summary card sets the pacing schedule: quiet hours and the days they apply to. Workflows that consume no usage stay outside that budget.",
  },
  addons: {
    ko: "에이전트별 부가 기능을 아이아·클로드·코덱스 탭으로 나눠 관리합니다. 아이아 탭은 이미 돌고 있는 QA 회차·티켓 처리 절차를 본떠 다른 시스템의 QA 워크플로를 만드는 온보딩(시작 버튼을 눌러야 단계가 열리는 화면 목업), 클로드 탭은 전역·프로젝트별 Claude Code 플러그인과 소속 스킬의 사용 설정, 코덱스 탭은 Codex 전용 부가 기능 자리입니다.",
    en: "Manage per-agent add-ons in AIA, Claude, and Codex tabs. The AIA tab is an onboarding (still a screen mock, opened by its start button) that builds a QA workflow for another system from the QA round and ticket procedures already in use; the Claude tab toggles global and per-project Claude Code plugins and their skills; the Codex tab is reserved for Codex add-ons.",
  },
  storage: {
    ko: "공급자 대화 원본과 Agent Manager 보완 저장소가 사용하는 로컬 용량과 파일 수를 구분해 보여줍니다. 공급자 원본은 읽기 전용이며 Agent Manager가 수정하지 않습니다.",
    en: "Review local space and file counts separately for provider conversation sources and Agent Manager supplemental storage. Provider source data remains read-only and is not modified by Agent Manager.",
  },
  settings: {
    ko: "공급자 CLI 연결과 계정, 외부 플러그인, 시스템 에이전트, 백엔드 서비스, 언어·자동번역, 화면 테마와 채팅 표시 방식을 설정합니다. 원격 접속에서는 호스트 권한에 따라 일부 항목이 읽기 전용으로 표시됩니다.",
    en: "Configure provider CLI connections and accounts, external plugins, the system agent, backend service, language and translation, appearance, and chat display. During remote access, some settings are read-only according to host permissions.",
  },
};

export function navigationHelpDescription(view: ViewId, translate: (ko: string, en: string) => string): string {
  const description = NAVIGATION_HELP[view];
  return translate(description.ko, description.en);
}

/**
 * 도움말이 붙어야 하는 화면 전부. 이 목록을 `NAVIGATION_HELP`의 키에서 뽑지 않고 메뉴
 * 순서에서 만든다 — 화면이 늘었을 때 `Record<ViewId, …>`가 도움말 누락은 컴파일 시점에
 * 잡아 주지만 메뉴 순서 누락은 아무도 잡지 못했다. 순서를 기준으로 삼으면 새 화면이
 * `DEFAULT_NAVIGATION_ORDER`에 빠졌을 때 도움말 테스트가 먼저 걸린다. 키 나열 순서라는
 * 암묵적 규칙에 화면 순서가 기대던 것도 함께 사라진다.
 *
 * 순서를 정할 수 없는 화면도 여기서 다시 적지 않고 `UNCONFIGURABLE_VIEWS`를 그대로 붙인다 —
 * 도움말은 사용자 설정 대상 여부와 무관하게 모든 화면에 붙어야 하므로, 그 목록이 늘면
 * 도움말 목록도 함께 늘어야 한다.
 */
export function navigationHelpViews(): ViewId[] {
  return [...DEFAULT_NAVIGATION_ORDER, ...UNCONFIGURABLE_VIEWS];
}
