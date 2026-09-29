import { BookOpen, Bot, FileText, FolderGit2, HardDrive, LayoutDashboard, Layers, MessagesSquare, PackagePlus, Puzzle, Settings, Sparkles, Workflow, type LucideIcon } from "lucide-react";
import { LogoMark } from "./Shared";
import { useI18n } from "../lib/i18n";
import { previewView, type NavigationPreferences } from "../lib/navigationPreferences";
import type { ViewId } from "../types";

/**
 * 화면 하나가 사이드바에서 쓰는 것 — 아이콘, 메뉴 이름, 헤더 제목 — 을 한 줄에 모은다.
 * 세 곳에 흩어 두면 화면을 추가할 때 한 곳을 빠뜨려도 타입이 잡아 주지 못한다.
 * `title`은 메뉴 이름과 헤더 제목이 다른 화면에만 둔다.
 */
type TranslateFn = (ko: string, en: string) => string;

const NAVIGATION: Record<ViewId, { icon: LucideIcon; label: (text: TranslateFn) => string; title?: (text: TranslateFn) => string }> = {
  dashboard: { icon: LayoutDashboard, label: (text) => text("대시보드", "Dashboard") },
  chat: { icon: Sparkles, label: (text) => text("채팅", "Chat") },
  sessions: { icon: MessagesSquare, label: (text) => text("세션", "Sessions") },
  docs: { icon: FileText, label: (text) => text("파일", "Files") },
  projects: { icon: FolderGit2, label: (text) => text("프로젝트", "Projects") },
  instructions: { icon: BookOpen, label: (text) => text("지침", "Instructions"), title: (text) => text("에이전트 지침", "Agent instructions") },
  skills: { icon: Puzzle, label: (text) => text("스킬", "Skills") },
  agents: { icon: Bot, label: (text) => text("에이전트", "Agents") },
  artifacts: { icon: Layers, label: (text) => text("아티팩트", "Artifacts") },
  workflows: { icon: Workflow, label: (text) => text("워크플로", "Workflows"), title: (text) => text("워크플로 관리", "Workflow management") },
  addons: { icon: PackagePlus, label: (text) => text("애드온", "Add-ons") },
  storage: { icon: HardDrive, label: (text) => text("저장소", "Storage") },
  settings: { icon: Settings, label: (text) => text("설정", "Settings") },
};

/** 로케일이 한국어면 원문 그대로, 아니면 번역 훅에 맡긴다. */
function navigationText(render: (text: TranslateFn) => string, locale: string, translate: TranslateFn): string {
  return render(locale === "ko" ? (ko) => ko : translate);
}

export function navigationLabel(view: ViewId, locale: string, translate: (ko: string, en: string) => string): string {
  return navigationText(NAVIGATION[view].label, locale, translate);
}

export function navigationTitle(view: ViewId, locale: string, translate: (ko: string, en: string) => string): string {
  const entry = NAVIGATION[view];
  return navigationText(entry.title ?? entry.label, locale, translate);
}

/**
 * 로고(앱 데이터 새로고침)와 주 메뉴만 맡는 좌측 기둥. 설정은 숨기거나 순서를 바꿀 수
 * 없으므로 저장된 순서 뒤에 항상 붙인다.
 */
export function AppSidebar({ view, sessionCount, refreshing, preferences, onActivate, onRefresh }: {
  view: ViewId;
  sessionCount: number;
  refreshing: boolean;
  preferences: NavigationPreferences;
  onActivate: (view: ViewId) => void;
  onRefresh: () => void;
}) {
  const { locale, text } = useI18n();
  const items = [
    ...preferences.order
      .filter((id) => !preferences.hidden.includes(id))
      .map((id) => ({ id, icon: NAVIGATION[id].icon })),
    { id: "settings" as const, icon: NAVIGATION.settings.icon },
  ];
  return (
    <aside className="app-sidebar">
      <div className="brand">
        <button
          className="brand-logo"
          type="button"
          disabled={refreshing}
          aria-label={text("데이터 새로고침", "Refresh data")}
          title={text("데이터 새로고침", "Refresh data")}
          onClick={onRefresh}
        ><LogoMark size={37} spinning={refreshing} /></button>
        <div><strong>Agent Manager</strong><span>LOCAL CONTROL PLANE</span></div>
      </div>
      <nav aria-label={text("주 메뉴", "Main menu")}>
        {items.map((item) => (
          <button className={view === item.id ? "active" : ""} aria-current={view === item.id ? "page" : undefined} type="button" key={item.id} data-ui-anchor={`nav.${item.id}`} onClick={() => onActivate(item.id)}>
            <span><item.icon size={16} strokeWidth={1.8} aria-hidden="true" /></span>{navigationLabel(item.id, locale, text)}
            {item.id === "sessions" && <em>{sessionCount}</em>}
            {previewView(item.id) && <em className="nav-preview-tag" data-ui-anchor={`nav.${item.id}.preview`}>{text("준비중", "Preparing")}</em>}
          </button>
        ))}
      </nav>
    </aside>
  );
}
