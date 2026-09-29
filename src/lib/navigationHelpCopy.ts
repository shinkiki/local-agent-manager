import type { ViewId } from "../types";
import type { TranslatedPhrase } from "./phrase.ts";

/**
 * 화면별 도움말 본문. 이 파일에 있는 것은 제품 문구뿐이고, 문구를 문단으로 끊어 화면에
 * 넘기는 규칙은 `navigationHelp`에 있다.
 *
 * 둘을 나눈 이유는 바뀌는 이유가 다르기 때문이다. 문구는 기능이 늘거나 안내가 틀렸을 때
 * 거의 매번 손대는 값이고, 도움말이 붙는 화면 목록이나 문단 경계 규칙은 화면 구조가
 * 바뀔 때만 손대는 규칙이다. 한 파일에 있으면 문구 한 줄을 고치러 들어온 사람이 규칙까지
 * 함께 읽게 되고, 규칙을 고치러 들어온 사람은 50여 줄의 문구를 지나쳐야 한다. 목록과
 * 저장 규칙을 가른 `navigationViews`/`navigationPreferences`와 같은 경계다.
 */

/**
 * 화면 하나의 도움말. `emphasis`는 본문 뒤에 굵게 따로 서는 한 문단으로, 화면을 쓰기
 * 전에 알아야 하는 권한·범위처럼 놓치면 곤란한 것만 담는다.
 *
 * 두 언어 표기의 모양과 그것을 지금 언어로 푸는 규칙은 `phrase`에 한 벌로 있다. 여기는
 * 도움말 문구뿐이라 영문이 반드시 있는 쪽(`TranslatedPhrase`)을 쓴다 — 번역하지 않는
 * 고유명은 도움말 본문에 오지 않으므로, `en`을 빠뜨린 줄은 타입 검사가 잡아야 한다.
 */
export interface NavigationHelpEntry extends TranslatedPhrase {
  emphasis?: TranslatedPhrase;
}

export const NAVIGATION_HELP: Record<ViewId, NavigationHelpEntry> = {
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
    ko: "로컬 폴더를 등록해 그 안의 파일을 검색하고 미리보기·편집·저장·다운로드할 수 있으며, 파일 변경을 트리거로 삼아 에이전트 작업을 걸 수도 있습니다. 폴더 등록을 해제해도 원본 폴더와 파일은 삭제되지 않습니다.",
    en: "Register local folders to search, preview, edit, save, and download the files inside, and trigger agent work from file changes. Unregistering a folder does not delete its original folder or files.",
    emphasis: {
      ko: "등록한 폴더는 모든 채팅의 작업 범위에 함께 들어갑니다. 채팅의 작업 폴더가 어디든 에이전트가 등록 폴더를 읽고 고칠 수 있으므로, 에이전트에게 맡기지 않을 폴더는 등록하지 마세요.",
      en: "Registered folders join every chat's workspace. Agents can read and change them no matter which working folder a chat uses, so do not register a folder you would not hand to an agent.",
    },
  },
  projects: {
    ko: "세션에서 확인한 활성 프로젝트를 골라 파일을 읽기 전용으로 둘러보고, 형상관리 탭에서 git 상태·브랜치·스태시·로그를 확인합니다. 커밋·브랜치 전환·리베이스·fetch·pull은 쓰기 권한이 있을 때만 할 수 있고 push는 호스트 화면에서만 가능합니다. 프로젝트 활성여부 설정은 설정 → 라이브러리에서 이 화면의 설정 탭으로 옮겨 왔습니다.",
    en: "Pick an active project found in sessions to browse its files read-only, and check git status, branches, stashes, and the log in the Source control tab. Commit, branch switch, rebase, fetch, and pull need write access, and push is available only on the host screen. Project activation moved here from Settings → Library into this view's Settings tab.",
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
    ko: "워크플로 관리 탭에서 AIA가 등록한 시스템 워크플로를 확인하고 실행·삭제합니다. 워크플로는 system_catalog에 등록된 작업만 정해진 순서로 호출하며, 셸 명령·임의 파일 접근·다른 워크플로 호출은 표현할 수 없습니다. 단계 구성과 버전 이력, 직전 실행 결과를 보고 실행 전에 되돌리기 어려운 영향을 확인할 수 있습니다. 삭제할 때는 계약이 선언한 절차 스킬 가운데 이 워크플로만 쓰는 것을 함께 지울지 한 번 더 묻고, 고른 스킬은 휴지통으로 가 스킬 화면에서 복구할 수 있습니다(다른 워크플로도 쓰는 스킬은 남습니다).\n목록 카드의 배지는 계약에서 계산한 값입니다. 위험도는 조회 전용(읽기만 하는 단계), 상태 변경(시스템 상태를 바꾸는 작업이 하나라도 있음), 파괴적 변경(계정 등록·반복 요청·등록 폴더 삭제나 외부 CLI 종료처럼 되돌리기 어려운 작업이 있음) 세 단계이며, 등록할 때 단계에서 역산하므로 작성자가 실제보다 낮게 적을 수 없습니다. 위험도 미확인은 구형 응답이라 재등록이 필요하다는 뜻입니다. 나머지 배지는 지금 환경에서 실행 가능한지(실행 가능·재등록 필요), 직전 실행 결과, 이 워크플로를 도는 회차가 켜져 있는지(페이싱)를 나타냅니다.\n워크플로 페이싱 탭에서는 페이싱을 켠 워크플로가 쓸 계정 풀과 참여할 반복 요청, 회차마다 지킬 목표·가드·소비 상한을 정합니다(페이싱 대상 여부는 계약이 정합니다). 사용량을 쓰지 않는 워크플로는 이 예산이 통제하지 않습니다.\n요약 카드의 페이싱 사용 스위치는 기능 전체를 켜고 끄며, 끄면 예약 회차가 뜨지 않고 설정은 그대로 남습니다. 요약 카드의 스케줄 버튼은 페이싱 스케줄 — 페이싱을 멈출 시간대와 적용 요일 — 을 정합니다.",
    en: "In the workflow management tab, review system workflows registered by AIA and run or delete them. A workflow calls only operations registered in system_catalog in a fixed order; shell commands, arbitrary file access, and calling other workflows cannot be expressed. Inspect step composition, version history, and the last run before executing, with hard-to-recover effects shown up front. Deleting one asks once more whether to also delete the procedure skills only that workflow declares; the chosen skills go to the trash and can be restored from the Skills screen (skills other workflows also use are kept).\nThe badges on a list card are computed from the contract. Risk has three levels: read-only (every step only reads), changes state (at least one operation changes system state), and destructive (it includes hard-to-recover work such as deleting an account registration, a scheduled request, or a registered folder, or killing an external CLI). Risk is derived from the steps at registration time, so an author cannot declare it lower than it is; \"risk unknown\" means the response predates the field and the workflow must be registered again. The other badges show whether the contract can run in this environment (runnable / needs re-registration), the last run result, and whether a round driving this workflow is currently enabled (paced).\nThe workflow pacing tab sets the account pool and scheduled requests pacing-enabled workflows may use, plus the target, guard, and per-run ceiling each round must respect (the contract decides which workflows are paced). Workflows that consume no usage stay outside that budget.\nThe pacing switch on the summary card turns the whole feature on and off; while off no round launches on schedule and every setting stays as it is. The schedule button on the summary card sets the pacing schedule: quiet hours and the days they apply to.",
  },
  addons: {
    ko: "앱이 에이전트에 붙여 주는 기본도구를 도구별 탭으로 관리합니다. 외부 MCP는 Notion 등 MCP 서버 등록·인증, SSH는 인증키와 연결 서버, Cypress는 브라우저 자동화 작업공간, Mermaid는 앱이 그리는 다이어그램 안내, Claude Code는 전역·프로젝트별 플러그인과 소속 스킬의 사용 설정입니다. 같은 도구라도 에이전트마다 붙는 경로가 달라 탭마다 접힌 상세로 보여 줍니다. 자동화 탭은 다른 시스템의 QA 워크플로를 만드는 온보딩(시작 버튼을 눌러야 단계가 열리는 화면 목업)입니다.",
    en: "Manage the built-in tools the app attaches to agents, one tab per tool. External MCP registers and authenticates MCP servers such as Notion, SSH holds keys and endpoints, Cypress holds browser-automation workspaces, Mermaid explains the diagrams the app renders, and Claude Code toggles global and per-project plugins and their skills. The same tool reaches each agent through a different route, so every tab carries a collapsed detail showing them. The Automation tab is an onboarding (still a screen mock, opened by its start button) that builds a QA workflow for another system.",
  },
  storage: {
    ko: "공급자 대화 원본과 Agent Manager 보완 저장소가 사용하는 로컬 용량과 파일 수를 구분해 보여줍니다. 공급자 원본은 읽기 전용이며 Agent Manager가 수정하지 않습니다.",
    en: "Review local space and file counts separately for provider conversation sources and Agent Manager supplemental storage. Provider source data remains read-only and is not modified by Agent Manager.",
  },
  settings: {
    ko: "공급자 CLI 연결과 계정, 시스템 에이전트, 백엔드 서비스, 언어·자동번역, 화면 테마와 채팅 표시 방식을 설정합니다. 외부 MCP·SSH·Cypress 같은 기본도구는 애드온 화면에 있고, 프로젝트 활성여부는 프로젝트 화면의 설정 탭으로 옮겨 갔습니다. 원격 접속에서는 호스트 권한에 따라 일부 항목이 읽기 전용으로 표시됩니다.",
    en: "Configure provider CLI connections and accounts, the system agent, backend service, language and translation, appearance, and chat display. Built-in tools such as external MCP, SSH, and Cypress live in the Add-ons view, and project activation moved to the Projects view's Settings tab. During remote access, some settings are read-only according to host permissions.",
  },
};
