import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppLocale } from "../types";
import { canonicalSourceText } from "./staticUiText";

interface I18nValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale, messages?: Record<string, string>) => void;
  text: (ko: string, en: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);
const nodeOriginalText = new WeakMap<Node, string>();
const attributeOriginalText = new WeakMap<Element, Map<string, string>>();
const registeredUiEnglish = new Map<string, string>();
const registeredUiKoreanByEnglish = new Map<string, string>();
const UI_CATALOG_VERSION = "2026-08-10.1";
const STATIC_UI_SKIP_SELECTOR = "[data-user-content],.markdown-preview,.markdown-source,.doc-editor,.terminal-host,.chat-message > div,.chat-tool pre,.chat-approval pre,.chat-event-error,.message .text-block,.transcript-disclosure pre,.error-banner,.entity-card,.artifact-group,.data-table tbody,.doc-tree,.recent-list,.project-list,code,textarea";

const STATIC_UI_EN: Record<string, string> = {
  "대시보드": "Dashboard", "채팅": "Chat", "세션": "Sessions", "문서": "Documents", "스킬": "Skills", "에이전트": "Agents", "아티팩트": "Artifacts", "저장소": "Storage", "설정": "Settings",
  "전체": "All", "개인": "Personal", "프로젝트": "Project", "플러그인": "Plugin", "시스템": "System", "내장": "Built-in", "태그": "Tag", "공급자": "Provider",
  "다시 시도": "Retry", "재시도": "Retry", "다시 확인": "Check again", "적용": "Apply", "적용 중…": "Applying…", "저장": "Save", "저장 중…": "Saving…", "취소": "Cancel", "닫기": "Close", "삭제": "Delete", "삭제 중…": "Deleting…", "수정": "Edit", "편집": "Edit", "미리보기": "Preview", "전송": "Send", "중단": "Stop", "새 채팅": "New chat", "새 채팅 시작": "Start new chat",
  "선택": "Select", "선택됨": "Selected", "선택 안 함": "None", "활성화": "Enable", "숨기기": "Hide", "숨김 해제": "Unhide", "상세 보기": "Show details", "접기": "Collapse", "원문 보기": "View original", "작업 내역 펼치기": "Expand activity history", "작업 내역 접기": "Collapse activity history",
  "연결됨": "Connected", "연결 중": "Connecting", "연결 중…": "Connecting…", "연결 필요": "Connection required", "연결 오류": "Connection error", "연결 종료": "Disconnected", "대기": "Queued", "대기 중": "Queued", "진행 중": "In progress", "실행 중": "Running", "완료": "Complete", "실패": "Failed", "오류": "Error", "일시정지": "Paused", "꺼짐": "Off", "중지됨": "Stopped", "확인 중": "Checking",
  "CLI 연결": "CLI connection", "CLI 연결됨": "CLI connected", "CLI 연결 필요": "CLI connection required", "CLI 미탐지": "CLI not detected", "CLI 다시 검사": "Check CLI again", "CLI에 연결": "Connect CLI", "설정 터미널 열기": "Open setup terminal", "터미널 다시 열기": "Reopen terminal",
  "화면": "Display", "테마": "Theme", "메인 색상": "Accent color", "메시지 표시 방식": "Message display", "대화 시작 부분 표시": "Show conversation start", "마지막 대화 표시": "Show latest messages", "자동 (시스템 연동)": "Auto (system)", "라이트 모드": "Light mode", "다크 모드": "Dark mode", "황동": "Brass", "그린": "Green", "블루": "Blue", "시안": "Cyan", "바이올렛": "Violet",
  "운영체제의 라이트/다크 설정을 따라가며, 시스템이 바뀌면 즉시 함께 바뀝니다.": "Follows the operating system and updates immediately when it changes.", "시스템 설정과 관계없이 항상 밝은 화면으로 표시합니다.": "Always use a light appearance regardless of the system setting.", "시스템 설정과 관계없이 항상 어두운 화면으로 표시합니다.": "Always use a dark appearance regardless of the system setting.", "세션을 열면 대화의 처음부터 보여주고, 새 응답이 도착해도 현재 위치를 유지합니다.": "Open at the start and keep the current position when new responses arrive.", "세션을 열면 가장 최근 대화 위치로 이동하고, 새 응답이 도착하면 최신 메시지를 따라갑니다.": "Open at the latest message and follow new responses.",
  "네트워크": "Network", "Tailscale 원격 접속": "Tailscale remote access", "앱이 실행 중일 때 Tailnet 안에서 이 화면과 채팅·터미널에 연결합니다.": "Connect to this UI, chat, and terminal from the Tailnet while the app is running.", "로컬 데스크톱 앱에서만 변경할 수 있습니다.": "This can only be changed in the local desktop app.", "연결 설정을 변경하려면 Agent Manager가 실행 중인 컴퓨터에서 설정 메뉴를 여세요.": "Open Settings on the computer running Agent Manager to change the connection.",
  "언어 및 자동번역": "Language and translation", "UI 언어": "UI language", "시스템 에이전트": "System agent", "번역 대기": "Translation queued", "번역 중": "Translating", "번역 완료": "Translation complete", "번역 일시 중지": "Translation paused", "일부 번역 실패": "Partially failed", "실패 항목 재시도": "Retry failures",
  "설명": "Description", "범위": "Scope", "출처": "Source", "파일": "File", "구성 파일": "Files", "모델": "Model", "최대 턴": "Max turns", "권한 모드": "Permission mode", "도구": "Tools", "시스템 프롬프트": "System prompt", "요약": "Summary", "내용": "Content", "루트": "Root", "크기": "Size", "업데이트": "Updated", "버전": "Version", "본문 잠김": "Content locked",
  "스킬을 찾지 못했습니다": "No skills found", "에이전트 정의가 없습니다": "No agent definitions", "아티팩트가 없습니다": "No artifacts", "세션이 없습니다": "No sessions", "조건에 맞는 세션이 없습니다": "No sessions match the filters", "표시할 대화가 없습니다": "No conversations to display", "등록된 폴더 없음": "No registered folders", "문서를 선택하세요": "Select a document", "데이터 없음": "No data", "설명이 없습니다.": "No description.", "모델 기록이 없습니다": "No model history", "프로젝트 기록이 없습니다": "No project history",
  "제목·프로젝트·ID·메모 검색": "Search title, project, ID, or note", "파일명 검색": "Search file name", "새 문서 경로.md": "new-document.md", "제목 입력": "Enter title", "새 폴더 이름": "New folder name", "표시 이름 (선택)": "Display name (optional)", "에이전트명·설명·도구 검색": "Search agent, description, or tool", "대화 제목·아티팩트·요약 검색": "Search conversation, artifact, or summary", "스킬명·설명·출처 검색": "Search name, description, or source",
  "대화 내역": "Conversation", "작업 로그": "Activity", "메타": "Metadata", "터미널": "Terminal", "메모": "Note", "표시 제목": "Display title", "세션 정보": "Session info", "요청일시": "Requested", "브랜치": "Branch", "총 토큰": "Total tokens", "입력 소스": "Input source", "실행 클라이언트": "Execution client", "기록 방식": "History mode", "컨텍스트 ID": "Context ID", "스레드 종류": "Thread type", "모델 공급자": "Model provider", "CLI 버전": "CLI version", "등록 도구": "Registered tools",
  "사용자": "User", "진행 상황": "Progress", "도구 실행": "Tool call", "도구 결과": "Tool result", "도구 오류": "Tool error", "승인 대기": "Awaiting approval", "권한 승인 대기": "Permission approval required", "선택할 때까지 Claude 작업이 일시 정지됩니다.": "Claude is paused until you choose an action.", "이번만 허용": "Allow once", "세션 동안 허용": "Allow for session", "거절": "Decline", "작업 취소": "Cancel task", "실행 정책에 의해 이미 거절된 권한 기록입니다. 현재 승인을 기다리고 있지 않습니다.": "This permission was already denied by policy and is not awaiting approval.", "권한 제한 후 응답 종료": "Response ended with permission limits", "사용자 중단": "Stopped by user", "응답 종료": "Response ended", "권한 제한": "Permission limited", "중단됨": "Interrupted", "도구 실패 포함": "Includes tool failures", "대기열 추가": "Queue", "대기열에서 삭제": "Remove from queue", "입력창으로 되돌리기": "Return to composer", "권한": "Permissions", "승인": "Approval", "이어가기 권한 모드": "Continuation permission mode", "이어가기 승인 처리": "Continuation approval handling", "권한 모드를 바꾸면 같은 세션으로 다시 연결합니다.": "Changing permission mode reconnects the same session.", "승인 처리를 바꾸면 같은 세션으로 다시 연결합니다.": "Changing approval handling reconnects the same session.", "다음 전송부터 같은 세션을 전체 접근으로 다시 연결합니다.": "The same session will reconnect with full access on the next send.", "권한 모드를 변경하지 못했습니다:": "Could not change permission mode:",
  "기본": "Default", "기본 모델": "Default model", "공급자 기본값": "Provider default", "상속": "Inherited", "전체 접근": "Full access", "작업공간 쓰기": "Workspace write", "분석·계획만": "Analysis and planning only", "외부 경로 허용": "Allow external paths", "읽기 전용": "Read only",
  "반복 요청 수정": "Edit recurring request", "새 반복 요청": "New recurring request", "반복할 요청": "Request to repeat", "작업 경로": "Working directory", "주기": "Schedule", "간격": "Interval", "실행 시각": "Run time", "요일": "Day", "세션 방식": "Session strategy", "재개 실패 시": "On resume failure", "매 N시간": "Every N hours", "매일": "Daily", "평일": "Weekdays", "매주": "Weekly", "고급 Cron": "Advanced Cron", "매번 새 채팅": "New chat each time", "동일 대화 이어가기": "Continue same conversation", "작업 일시정지": "Pause request", "즉시 새 대화": "Start a new chat", "한 번 재시도 후 새 대화": "Retry once, then new chat", "지금 실행": "Run now", "전체 일시정지": "Pause all", "전체 재개": "Resume all", "이전 실행": "Previous runs", "최근 실행": "Recent runs",
  "폴더 추가": "Add folder", "폴더 제거": "Remove folder", "폴더 삭제 확인": "Confirm folder deletion", "이름 변경": "Rename", "새 문서 만들기": "Create document", "문서 폴더 추가": "Add document folder", "폴더로 드래그": "Drag to folder",
  "개": "", "건": "items", "· 세션": "· sessions", "개 파일": "files",
  "전체 세션": "All sessions", "캐시 토큰 포함": "Includes cached tokens", "인덱싱 용량": "Indexed storage", "원본 파일은 읽기 전용": "Source files are read only", "스킬 / 에이전트": "Skills / agents", "로컬 정의 자동 탐지": "Automatic local discovery", "채팅 탐지": "Conversation discovery", "주간 세션 추이": "Weekly session trend", "최근 12주 생성·수정된 세션": "Sessions created or updated in the last 12 weeks", "모델 분포": "Model distribution", "세션에 기록된 모델": "Models recorded in sessions", "반복 일정": "Recurring schedules", "예약 자동 요청 현황": "Scheduled automatic requests", "관리": "Manage", "반복 일정을 불러오는 중입니다": "Loading recurring schedules", "등록된 반복 일정이 없습니다": "No recurring schedules", "관리를 눌러 첫 반복 요청을 만드세요.": "Click Manage to create your first recurring request.", "프로젝트 Top 10": "Top 10 projects", "연결된 작업 디렉터리 기준": "By linked working directory", "최근 세션": "Recent sessions", "업데이트 순": "Most recently updated",
  "대화": "Conversation", "반복 요청": "Recurring requests", "새 CLI 채팅": "New CLI chat", "설치된 공급자 CLI를 구조화 채팅으로 시작합니다.": "Start a structured chat with an installed provider CLI.", "실행 설정": "Execution settings", "권한 · 모델 · 추론": "Permissions, model, and reasoning", "권한 · 승인 · 모델 · 추론": "Permissions, approvals, model, and reasoning", "실행 모드": "Execution mode", "권한 범위": "Permission scope", "승인 처리": "Approval handling", "명령 · 파일 · 추가 권한": "Commands, files, and additional permissions", "직접 승인": "Manual approval", "사용자 확인": "User confirmation", "요청 시 거절": "Deny when requested", "자동 검토": "Auto-review", "위험도 판단": "Risk review", "Codex 전용": "Codex only", "승인 없이 실행": "Run without approvals", "승인 없음": "No approvals", "모드 범위 내": "Within mode limits", "프로젝트 수정": "Edit project", "CLI 설정을 그대로 사용": "Use the CLI configuration", "추론 수준": "Reasoning level", "모델과 공급자의 기본 추론 수준을 사용합니다.": "Use the default reasoning level for the model and provider.", "첫 메시지": "First message", "Codex 검토 에이전트가 승인 요청을 평가하며 추가 사용량이 발생할 수 있습니다.": "A Codex reviewer evaluates approval requests and may use additional quota.", "샌드박스와 승인 절차 없이 모든 명령을 실행합니다.": "Runs all commands without sandboxing or approval prompts.", "승인 요청 없이 현재 권한 범위에서만 실행하며, 범위를 벗어난 작업은 실패합니다.": "Runs without prompts only within the current permission scope; out-of-scope actions fail.", "백그라운드 실행은 직접 승인할 수 없어 추가 권한 요청을 거절합니다.": "Background runs cannot receive manual approval, so additional permission requests are denied.", "추가 권한이 필요하면 실행을 멈추고 직접 확인합니다.": "Pauses for manual confirmation when additional permissions are required.",
  "폴더": "Folders", "미분류": "Unfiled", "내 폴더": "My folders", "세션 행을 폴더로 드래그하세요.": "Drag a session row into a folder.", "즐겨찾기": "Favorites", "숨김만": "Hidden only", "추가 필터": "More filters", "보관 세션 포함": "Include archived sessions", "서브에이전트 포함": "Include subagents", "행을 폴더로 드래그해 분류하거나, 선택해서 대화 내역을 확인하세요.": "Drag rows into folders or select one to view its conversation.", "소스": "Source", "제목": "Title", "메시지": "Messages", "토큰": "Tokens",
  "문서 폴더": "Document folders", "상단 + 버튼에서 로컬 Markdown 폴더를 등록하세요.": "Add a local Markdown folder with the + button above.", "등록된 폴더의 Markdown 문서를 안전하게 열고 편집할 수 있습니다.": "Safely open and edit Markdown documents in registered folders.",
  "관리 대상 전체": "All managed storage", "대화 원본 + Agent Manager 상태": "Conversation sources + Agent Manager state", "공급자 대화 원본": "Provider conversation sources", "Agent Manager 상태": "Agent Manager state", "보완 응답과 반복 요청 포함": "Includes supplemental responses and recurring requests", "보완 저장 결과": "Supplemental storage", "공급자가 생성한 로컬 세션 데이터입니다. Agent Manager는 이 파일을 수정하지 않습니다.": "Local session data created by providers. Agent Manager does not modify these files.", "Claude 대화 원본": "Claude conversation sources", "Claude가 작성한 프로젝트별 세션 기록 · 읽기 전용": "Claude project session history · read only", "Codex 대화 원본": "Codex conversation sources", "Codex rollout과 세션 색인 · 읽기 전용": "Codex rollouts and session index · read only", "Antigravity 대화 원본": "Antigravity conversation sources", "대화 단계와 세션 요약 DB · 읽기 전용": "Conversation steps and session summary database · read only", "Agent Manager 보완 저장소": "Agent Manager supplemental storage", "실행 중 받은 최종 assistant 응답을 턴 완료 시 기록합니다. 원본 대화에 같은 응답이 있으면 세션 화면에서 한 번만 표시합니다.": "Stores the final assistant response received during execution when a turn completes. Duplicate source responses are shown once.", "메타데이터 · 반복 요청 · 보완 응답을 포함한 자체 저장소": "Internal storage for metadata, recurring requests, and supplemental responses",
};
const STATIC_UI_SOURCES = [
  "(본문 없음)", "(제목 없음)", "Antigravity brain 폴더의 작업 목록·계획·워크스루를 탐지합니다.",
  "CLI 연결", "CLI 연결 필요", "CLI 연결됨", "SKILL.md를 읽고 있습니다",
  "Tailscale 원격 접속과 로컬 연결 포트를 설정합니다.", "UI 및 콘텐츠 자동번역에 사용할 연결된 CLI를 선택합니다.",
  "UI·번역 언어", "UI와 활성 콘텐츠에 함께 사용할 언어를 선택합니다.", "~/.claude/agents의 Markdown 정의를 탐지합니다.",
  "개", "공급자", "구성 파일", "구현 계획", "권한 모드", "기본", "내용", "네트워크", "다시 시도", "대화",
  "대화 제목·아티팩트·요약 검색", "도구", "로컬", "로컬 SKILL.md 위치와 검색 조건을 확인하세요.",
  "로컬 에이전트 데이터를 인덱싱하고 있습니다", "루트", "먼저 CLI가 연결된 시스템 에이전트를 선택하세요.",
  "메시지 표시 방식", "메인 색상", "모델", "목록 갱신 재시도", "버전", "버튼과 강조 요소에 사용할 색상을 선택합니다.",
  "번역 대기", "번역 시작", "번역 언어를 바꾸면 활성화된 메뉴를 새 언어로 다시 번역하며 선택한 CLI 사용량이 발생합니다.",
  "번역 오류", "번역 일시 중지", "번역 중", "범위", "본문 잠김", "삭제", "상속",
  "서버 연결이 끊겼습니다. 재연결하는 중…", "서버와 다시 연결하는 중…", "선택", "선택 안 함", "선택됨",
  "설명", "설명이 없습니다.", "세션을 클릭했을 때 대화의 어느 위치부터 보여줄지 선택합니다.", "스킬", "스킬 검색",
  "스킬명·설명·출처 검색", "스킬을 찾지 못했습니다", "시스템", "시스템 설정", "시스템 에이전트",
  "시스템 에이전트, 원격 네트워크, 언어와 자동번역을 한곳에서 관리합니다.", "시스템 자동화 설정을 불러오는 중…",
  "시스템 프롬프트", "실패 항목 재시도", "아티팩트", "아티팩트가 없습니다", "아티팩트를 읽고 있습니다",
  "앱 전체의 밝기 테마를 선택합니다. 자동은 운영체제 설정을 따릅니다.", "앱 전체의 테마와 강조 색상을 한곳에서 설정합니다.",
  "앱을 시작하지 못했습니다", "언어 및 자동번역", "언어 설정을 불러오는 중…", "언어 추가",
  "언어를 추가한 뒤 목록에서 선택할 수 있습니다.", "추가할 언어", "추가할 수 있는 언어를 모두 등록했습니다.", "업데이트",
  "에이전트", "에이전트 정의가 없습니다", "에이전트 정의를 읽고 있습니다", "에이전트명·설명·도구 검색", "요약",
  "요청을 처리하지 못했습니다.", "워크스루", "원격 접속", "원문 보기",
  "이 설정은 호스트에 저장되며 공급자 채팅 원본에는 영향을 주지 않습니다.",
  "이미지", "일부 번역 실패", "자동번역을 실행하지 않습니다", "작업 목록", "재시도", "전체",
  "전체 데이터를 백그라운드에서 번역하며 선택한 CLI 사용량이 발생합니다.", "주 메뉴", "채팅", "채팅 메시지 표시 방식",
  "최대 턴", "추가", "추가 언어 UI는 시스템 에이전트로 번역한 뒤 전환됩니다.", "추가한 언어", "출처", "취소",
  "크기", "태그", "테마", "파일", "현재 사용 중인 언어는 다른 번역 언어를 선택한 뒤 삭제하세요.", "화면",
  "화면 설정", "화면 테마",
] as const;
const STATIC_UI_KOREAN_BY_ENGLISH = new Map(Object.entries(STATIC_UI_EN).map(([ko, en]) => [en, ko]));

export function getUiTranslationCatalog(): { version: string; messages: Record<string, string> } {
  const messages: Record<string, string> = {};
  for (const source of Object.keys(STATIC_UI_EN)) messages[source] = source;
  for (const source of STATIC_UI_SOURCES) messages[source] = source;
  for (const source of registeredUiEnglish.keys()) messages[source] = source;
  for (const source of collectRenderedUiSources()) messages[source] = source;
  return { version: UI_CATALOG_VERSION, messages };
}

function collectRenderedUiSources(): string[] {
  if (typeof document === "undefined") return [];
  const root = document.getElementById("root");
  if (!root) return [];
  const sources = new Set<string>();
  const collect = (value: string | null) => {
    const source = value?.trim();
    if (source && source.length <= 500 && /[가-힣]/.test(source)) sources.add(source);
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.parentElement?.closest(STATIC_UI_SKIP_SELECTOR)) collect(node.nodeValue);
    } else if (node instanceof Element && !node.closest(STATIC_UI_SKIP_SELECTOR)) {
      for (const attribute of ["placeholder", "aria-label", "title"]) collect(node.getAttribute(attribute));
    }
    node = walker.nextNode();
  }
  return [...sources];
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<{ locale: AppLocale; messages: Record<string, string> }>({ locale: "ko", messages: {} });
  const setLocale = useCallback((locale: AppLocale, messages: Record<string, string> = {}) => {
    setActive((current) => current.locale === locale && sameMessages(current.messages, messages) ? current : { locale, messages });
  }, []);
  const value = useMemo<I18nValue>(() => ({
    locale: active.locale,
    setLocale,
    text: (ko, en) => {
      registeredUiEnglish.set(ko, en);
      registeredUiKoreanByEnglish.set(en, ko);
      if (active.locale === "ko") return ko;
      if (active.locale === "en") return en;
      return active.messages[ko] ?? en;
    },
  }), [active, setLocale]);
  return <I18nContext.Provider value={value}><StaticUiLocalization locale={active.locale} messages={active.messages} />{children}</I18nContext.Provider>;
}

function sameMessages(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("I18nProvider is missing");
  return value;
}

export function localizedError(locale: AppLocale, cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const heading = locale === "ko" ? "요청을 처리하지 못했습니다." : "The request could not be completed.";
  return raw ? `${heading}\n${raw}` : heading;
}

function StaticUiLocalization({ locale, messages }: { locale: AppLocale; messages: Record<string, string> }) {
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return undefined;
    let applying = false;
    const translateTextNode = (node: Node) => {
      if (node.nodeType !== Node.TEXT_NODE || !node.parentElement || node.parentElement.closest(STATIC_UI_SKIP_SELECTOR)) return;
      const current = node.nodeValue ?? "";
      let original = nodeOriginalText.get(node);
      if (!original || (current !== original && current !== localizedStaticText(original, locale, messages))) {
        original = canonicalSourceText(current, messages, STATIC_UI_KOREAN_BY_ENGLISH, registeredUiKoreanByEnglish);
        nodeOriginalText.set(node, original);
      }
      const next = localizedStaticText(original, locale, messages);
      if (current !== next) node.nodeValue = next;
    };
    const translateElement = (element: Element) => {
      if (element.closest(STATIC_UI_SKIP_SELECTOR)) return;
      for (const attribute of ["placeholder", "aria-label", "title"]) {
        const current = element.getAttribute(attribute);
        if (!current) continue;
        let originals = attributeOriginalText.get(element);
        if (!originals) { originals = new Map(); attributeOriginalText.set(element, originals); }
        let original = originals.get(attribute);
        if (!original || (current !== original && current !== localizedStaticText(original, locale, messages))) {
          original = canonicalSourceText(current, messages, STATIC_UI_KOREAN_BY_ENGLISH, registeredUiKoreanByEnglish);
          originals.set(attribute, original);
        }
        const next = localizedStaticText(original, locale, messages);
        if (current !== next) element.setAttribute(attribute, next);
      }
    };
    const walk = (target: Node) => {
      if (target.nodeType === Node.TEXT_NODE) { translateTextNode(target); return; }
      if (!(target instanceof Element)) return;
      translateElement(target);
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
        else if (node instanceof Element) translateElement(node);
        node = walker.nextNode();
      }
    };
    const apply = (target: Node) => {
      if (applying) return;
      applying = true;
      walk(target);
      applying = false;
    };
    apply(root);
    const observer = new MutationObserver((mutations) => {
      if (applying) return;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") apply(mutation.target);
        mutation.addedNodes.forEach(apply);
      }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [locale, messages]);
  return null;
}

function localizedStaticText(original: string, locale: AppLocale, messages: Record<string, string>): string {
  if (locale === "ko") return original;
  if (locale === "en") return staticEnglish(original);
  const whitespace = original.match(/^(\s*)(.*?)(\s*)$/s);
  const leading = whitespace?.[1] ?? "";
  const core = whitespace?.[2] ?? original;
  const trailing = whitespace?.[3] ?? "";
  return `${leading}${messages[core] ?? staticEnglish(core)}${trailing}`;
}

function staticEnglish(original: string): string {
  const whitespace = original.match(/^(\s*)(.*?)(\s*)$/s);
  const leading = whitespace?.[1] ?? "";
  const core = whitespace?.[2] ?? original;
  const trailing = whitespace?.[3] ?? "";
  const exact = STATIC_UI_EN[core] ?? registeredUiEnglish.get(core);
  if (exact !== undefined) return `${leading}${exact}${trailing}`;
  if (/^\d[\d,]*개$/.test(core)) return `${leading}${core.slice(0, -1)}${trailing}`;
  const translated = core
    .replace(/(\d[\d,]*)개 세션/g, "$1 sessions")
    .replace(/(\d[\d,]*)건/g, "$1 items")
    .replace(/^보완 응답 /, "Supplemental responses ")
    .replace(/최대 세션당 /, "up to ")
    .replace(/전체 /, "total ")
    .replace(/ items 보관$/, " items stored");
  return `${leading}${translated}${trailing}`;
}
