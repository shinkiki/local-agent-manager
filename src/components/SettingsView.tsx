import { ArrowDownFromLine, ArrowDownToLine, ArrowUpToLine, Blocks, Cable, Calendar, ChartPie, ChevronDown, ChevronRight, CircleCheck, Cloud, Code, CreditCard, Database, Download, Eraser, Eye, EyeOff, FileText, FolderClosed, GitBranch, Globe, KeyRound, Languages, LayoutTemplate, Library, LoaderCircle, Mail, Monitor, MonitorCog, Moon, MousePointerClick, NotebookText,PenLine, PenTool, Plug, Plus, Power, PowerOff, Presentation, RefreshCw, Repeat, Search, Server, Settings, ShieldAlert, SquareTerminal, Sun, Table2, Ticket, Trash2, Upload, Users, Waypoints, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { TabRequest } from "../lib/uiGuide";
import { beginProviderAccountLogin, cancelProviderAccountLogin, cancelUiTranslation, checkProviderCliUpdate, clearProviderModelCaches, consumeAccountResetCredit, deleteProviderAccount, finishProviderAccountLogin, getAccountTools, getAntigravityUsage, getBackendServiceSettings, getCliUpdateStatus, getProviderRuntimeCounts, getResourceRepository, getSleepPrevention, getTailscaleServiceStatus, getWebAccessStatus, hasTauriRuntime, refreshProviderAccountUsage, requestSystemLanguage, resetMenuTranslation, restartApp, revalidateProviderAccountCredential, retryMenuTranslation, retryUiTranslation, setAutoSwitchPolicy, setAutoSwitchResume, setAutoSwitchUsageGap, setResumeAccountPolicy, setBackendServiceSettings, setSleepPrevention, setProviderAccountAutoSwitch, setProviderAccountAutoSwitchPriority, setProviderAccountDisabled, setProviderAccountNote, setProviderAccountLabel, setRemoteWriteEnabled, setResourceRepository, setSystemAutomationSettings, setTailscaleServiceEnabled, switchActiveProviderAccount, updateProviderCli, type BackendServiceSettings, type SleepPreventionStatus, type TailscaleServiceStatus, type WebAccessStatus } from "../lib/ipc";
import { getUiTranslationCatalog, useI18n } from "../lib/i18n";
import { accountUsageDisplayState, displayUsageWindows, usageLevel, usageWindowValueUnavailable } from "../lib/accountUsage";
import { autoSwitchEventSummary } from "../lib/autoSwitchEvent";
import { homeAccountSummary, homeUsageNote } from "../lib/homeAccount";
import type { AccountUsageView, ProviderHomeToolsView, ProviderHomeView } from "../types";
import { accountNoteDraftState, submitAccountNote, ACCOUNT_NOTE_MAX_CHARS } from "../lib/accountNote";
import { accountLabelDraftState, submitAccountLabel, ACCOUNT_LABEL_MAX_CHARS } from "../lib/accountLabel";
import { accountToolBadges, accountToolsFor, homeToolsFor, DEFAULT_ACCOUNT_TOOL_BADGE_LIMIT, type AccountToolBadgeSource, type AccountToolIconName } from "../lib/accountTools";
import { cacheAwaitsNewerCliRelease, canCheckCliUpdate, canClearModelCaches, canRunCliUpdate, cliUpdateAlert, cliUpdateBadge, cliUpdateBlockedReason, hasCliUpdateAlert, modelCacheBlockedReason, runtimeStopConfirmationCount, shouldShowCliUpdatePanel, type CliActionAccess } from "../lib/cliUpdate";
import type { AccountLoginSessionView, AccountSnapshot, AccountToolsSnapshot, AccountToolsView, AccentColor, AppLocale, HostPlatform, AutoSwitchEventView, AutoSwitchPolicy, ChatApprovalMode, ChatMode, CliUpdateReceipt, MessageDisplayMode, ModelCacheCleanupReceipt, ModelOption, ProviderAccountView, ProviderCliUpdateStatus, ProviderId, ProviderRuntimeCounts, ProviderStatus, ProviderRuntimeStopSummary, ResourceRepositorySettings, ResumeAccountPolicy, SystemAutomationSettings, SystemAutomationSnapshot, ThemeMode, TranslationLanguage, TranslationMenu, TranslationStatus } from "../types";
import { aiaRuntimeProvider, aiaRuntimeSettings, canRunSystemAgent, sameAiaRuntimeSettings, systemAgentRuntimePatch, type AiaRuntimeSettings } from "../lib/aiaRuntime";
import { cachedProviderOptions, reasoningOptionsFor, refreshProviderOptions, subscribeProviderOptions, useProviderOptions } from "../lib/providerOptions";
import { normalizeExtraSettings, normalizeSettingValue, settingFieldsFor } from "../lib/chatSettings";
import { catalogResetPrompt, schemaDiscoveryPrompt, staleCatalogSources } from "../lib/schemaDiscovery";
import { defaultEffortFor, RuntimeSettings } from "./RuntimeSettings";
import { currentBackendServicePort, DEFAULT_BACKEND_SERVICE_PORT, MAX_BACKEND_SERVICE_PORT, MIN_BACKEND_SERVICE_PORT } from "../lib/backend";
import { repositoryTransferPrompt } from "../lib/skillTransfer";
import { moveNavigationItem, previewView, setNavigationVisibility, type ConfigurableViewId, type NavigationPreferences } from "../lib/navigationPreferences";
import { AiaMark, AppToggle, Drawer, ErrorBanner, HelpHint, Modal, PathField, SourceBadge, useConfirm, useEscapeToClose } from "./Shared";
import { AccountLoginTerminalPanel } from "./TerminalPanel";
import { ProjectRegistryCard } from "./ProjectRegistryCard";
import { CypressWorkspacePanel } from "./CypressWorkspacePanel";
import { PluginSettingsView, type PluginSectionId } from "./PluginSettingsView";
import { errorText } from "../lib/errorText";

interface SettingsViewProps {
  active: boolean;
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  onAccountsChange: (snapshot: AccountSnapshot) => void;
  onConnectCli: (provider: ProviderStatus) => void;
  /// 세션 이력에서 모은 최근 사용 모델. Claude처럼 CLI 모델 카탈로그가 없는 공급자는
  /// 이 목록이 시스템 에이전트 실행설정의 유일한 모델 선택지가 된다(채팅 메뉴와 동일).
  models: ModelOption[];
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  accentColor: AccentColor;
  onAccentColorChange: (color: AccentColor) => void;
  navigationPreferences: NavigationPreferences;
  onNavigationPreferencesChange: (preferences: NavigationPreferences) => void;
  messageDisplayMode: MessageDisplayMode;
  onMessageDisplayModeChange: (mode: MessageDisplayMode) => void;
  automation: SystemAutomationSnapshot | null;
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void;
  onRequestAiaPrompt: (text: string) => void;
  /// 다른 화면(사이드바 CLI 상태 버튼, AIA 화면 안내)이 특정 탭을 열어 달라는 요청.
  /// requestId가 바뀔 때마다 그 탭으로 전환한다.
  tabRequest: TabRequest<SettingsTabId> | null;
  /** AIA 버튼에서 기본 에이전트 설정이 필요해 이동한 요청. 값이 바뀔 때 안내를 다시 연다. */
  systemAgentNoticeRequest?: number | null;
  /// 공통 저장소 경로나 프로젝트 활성여부가 바뀌면 알린다. 스킬·지침 화면이 다시 읽고
  /// 스냅샷도 다시 받아야 한다.
  onRepositoryChanged?: () => void;
}

const themeModes: { value: ThemeMode; title: string; description: string; icon: LucideIcon }[] = [
  {
    value: "auto",
    title: "자동 (시스템 연동)",
    description: "운영체제의 라이트/다크 설정을 따라가며, 시스템이 바뀌면 즉시 함께 바뀝니다.",
    icon: Monitor,
  },
  {
    value: "light",
    title: "라이트 모드",
    description: "시스템 설정과 관계없이 항상 밝은 화면으로 표시합니다.",
    icon: Sun,
  },
  {
    value: "dark",
    title: "다크 모드",
    description: "시스템 설정과 관계없이 항상 어두운 화면으로 표시합니다.",
    icon: Moon,
  },
];

const accentColors: { value: AccentColor; title: string; swatch: string }[] = [
  { value: "brass", title: "황동", swatch: "#f0b054" },
  { value: "green", title: "그린", swatch: "#51e97d" },
  { value: "blue", title: "블루", swatch: "#58a6ff" },
  { value: "cyan", title: "시안", swatch: "#3ddad0" },
  { value: "violet", title: "바이올렛", swatch: "#b18cff" },
];

const builtInTranslationLanguages: TranslationLanguage[] = [
  { code: "ko", name: "Korean" },
  { code: "en", name: "English" },
];

const commonTranslationLanguages: (TranslationLanguage & { koreanName: string })[] = [
  { code: "ja", name: "Japanese", koreanName: "일본어" },
  { code: "zh-cn", name: "Chinese (Simplified)", koreanName: "중국어 (간체)" },
  { code: "zh-tw", name: "Chinese (Traditional)", koreanName: "중국어 (번체)" },
  { code: "es", name: "Spanish", koreanName: "스페인어" },
  { code: "fr", name: "French", koreanName: "프랑스어" },
  { code: "de", name: "German", koreanName: "독일어" },
  { code: "pt-br", name: "Portuguese (Brazil)", koreanName: "포르투갈어 (브라질)" },
  { code: "it", name: "Italian", koreanName: "이탈리아어" },
  { code: "ru", name: "Russian", koreanName: "러시아어" },
  { code: "ar", name: "Arabic", koreanName: "아랍어" },
  { code: "hi", name: "Hindi", koreanName: "힌디어" },
  { code: "id", name: "Indonesian", koreanName: "인도네시아어" },
  { code: "vi", name: "Vietnamese", koreanName: "베트남어" },
  { code: "th", name: "Thai", koreanName: "태국어" },
  { code: "tr", name: "Turkish", koreanName: "터키어" },
  { code: "pl", name: "Polish", koreanName: "폴란드어" },
  { code: "nl", name: "Dutch", koreanName: "네덜란드어" },
  { code: "sv", name: "Swedish", koreanName: "스웨덴어" },
  { code: "da", name: "Danish", koreanName: "덴마크어" },
  { code: "nb", name: "Norwegian Bokmål", koreanName: "노르웨이어 (보크몰)" },
  { code: "fi", name: "Finnish", koreanName: "핀란드어" },
  { code: "cs", name: "Czech", koreanName: "체코어" },
  { code: "uk", name: "Ukrainian", koreanName: "우크라이나어" },
  { code: "he", name: "Hebrew", koreanName: "히브리어" },
];

function languageDisplayName(language: TranslationLanguage, locale: AppLocale): string {
  const preset = commonTranslationLanguages.find((item) => item.code === language.code);
  return locale === "ko" && preset ? preset.koreanName : language.name;
}

const displayModes: { value: MessageDisplayMode; title: string; description: string; icon: LucideIcon }[] = [
  {
    value: "lastUser",
    title: "마지막 보낸 메시지부터 표시",
    description: "세션을 열면 사용자가 마지막으로 보낸 메시지에서 시작해 응답을 아래로 읽어 내려갑니다.",
    icon: ArrowDownFromLine,
  },
  {
    value: "start",
    title: "대화 시작 부분 표시",
    description: "세션을 열면 대화의 처음부터 보여주고, 새 응답이 도착해도 현재 위치를 유지합니다.",
    icon: ArrowUpToLine,
  },
  {
    value: "latest",
    title: "마지막 대화 표시",
    description: "세션을 열면 가장 최근 대화 위치로 이동하고, 새 응답이 도착하면 최신 메시지를 따라갑니다.",
    icon: ArrowDownToLine,
  },
];

type SystemSectionId = "cli" | "agent" | "service" | "language";
export type SettingsTabId = "connections" | "plugins" | "service" | "repository" | "language" | "display" | "automation";

// 채팅·세션 화면과 같은 중메뉴. 한 화면에 모든 카드를 쌓지 않고 탭으로 나눈다.
// 채팅 실행설정 스키마는 CLI 정보가 갱신될 때 백엔드가 직접 조사해 맞추므로 독립된
// 중메뉴를 두지 않는다. 실행설정 선택 UI는 채팅 생성·이어가기 화면에 있다.
const settingsTabs: { id: SettingsTabId; icon: LucideIcon; ko: string; en: string }[] = [
  { id: "connections", icon: KeyRound, ko: "CLI 설정", en: "CLI settings" },
  { id: "plugins", icon: Plug, ko: "플러그인", en: "Plugins" },
  { id: "service", icon: Server, ko: "백엔드 서비스", en: "Backend service" },
  { id: "repository", icon: Library, ko: "라이브러리", en: "Library" },
  { id: "language", icon: Languages, ko: "언어·번역", en: "Language" },
  { id: "display", icon: Monitor, ko: "화면·채팅", en: "Display and chat" },
  { id: "automation", icon: MousePointerClick, ko: "자동화", en: "Automation" },
];

const navigationLabels: Record<ConfigurableViewId, [string, string]> = {
  dashboard: ["대시보드", "Dashboard"],
  chat: ["채팅", "Chat"],
  sessions: ["세션", "Sessions"],
  docs: ["문서", "Documents"],
  instructions: ["지침", "Instructions"],
  skills: ["스킬", "Skills"],
  agents: ["에이전트", "Agents"],
  artifacts: ["아티팩트", "Artifacts"],
  workflows: ["워크플로", "Workflows"],
  addons: ["애드온", "Add-ons"],
  storage: ["저장소", "Storage"],
};

export function SettingsView({ active, providers, accounts, onAccountsChange, onConnectCli, models, themeMode, onThemeModeChange, accentColor, onAccentColorChange, navigationPreferences, onNavigationPreferencesChange, messageDisplayMode, onMessageDisplayModeChange, automation, onAutomationChange, onRequestAiaPrompt, tabRequest, systemAgentNoticeRequest = null, onRepositoryChanged }: SettingsViewProps) {
  const { text } = useI18n();
  const [tab, setTab] = useState<SettingsTabId>("connections");
  // 플러그인 중메뉴 선택. PluginSettingsView는 플러그인 탭일 때만 마운트되므로 선택을 여기서
  // 들고 있어야 다른 설정 탭을 다녀와도 남는다(QA #46). 상위 탭과 같이 세션 동안만 유지한다.
  const [pluginSection, setPluginSection] = useState<PluginSectionId>("external");
  const [showSystemAgentNotice, setShowSystemAgentNotice] = useState(false);
  const tabsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest]);
  useEffect(() => {
    if (systemAgentNoticeRequest === null) return;
    setTab("connections");
    setShowSystemAgentNotice(true);
    const timer = window.setTimeout(() => {
      document.querySelector('[data-ui-anchor="settings.system-agent"]')?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [systemAgentNoticeRequest]);
  // 좁은 화면에서 중메뉴는 가로로 스크롤되므로 선택된 탭이 화면 밖에 남을 수 있다.
  // 다른 화면에서 CLI 설정을 요청해 탭이 바뀌는 경우까지 포함해 항상 보이게 끌어온다.
  useEffect(() => {
    const nav = tabsRef.current;
    const active = nav?.querySelector<HTMLElement>("button.active");
    if (!nav || !active) return;
    const left = active.offsetLeft - 12;
    const right = active.offsetLeft + active.offsetWidth + 12 - nav.clientWidth;
    const next = nav.scrollLeft < right ? right : nav.scrollLeft > left ? left : null;
    if (next !== null) nav.scrollTo({ left: Math.max(0, next), behavior: "smooth" });
  }, [tab]);
  const systemSections: SystemSectionId[] | null = tab === "connections"
    ? ["cli", "agent"]
    : tab === "service"
      ? ["service"]
      : tab === "language"
        ? ["language"]
        : null;
  return (
    <div className="settings-view">
      <nav className="chat-hub-tabs settings-hub-tabs" ref={tabsRef} role="tablist" aria-label={text("설정 메뉴", "Settings menu")}>
        {settingsTabs.map((item) => (
          <button className={tab === item.id ? "active" : ""} type="button" role="tab" aria-selected={tab === item.id} key={item.id} data-ui-anchor={`settings.tab.${item.id}`} onClick={() => setTab(item.id)}>
            <item.icon size={13} aria-hidden="true" /><span>{text(item.ko, item.en)}</span>
          </button>
        ))}
      </nav>
      {systemSections && <SystemAutomationSettingsCard active={active} sections={systemSections} providers={providers} accounts={accounts} onAccountsChange={onAccountsChange} onConnectCli={onConnectCli} models={models} automation={automation} onChange={onAutomationChange} showSystemAgentNotice={showSystemAgentNotice} onCloseSystemAgentNotice={() => setShowSystemAgentNotice(false)} />}
      {tab === "repository" && <>
        <ResourceRepositoryCard onChanged={onRepositoryChanged} automation={automation} onRequestAiaPrompt={onRequestAiaPrompt} />
        <ProjectRegistryCard onChanged={onRepositoryChanged} />
      </>}
      {tab === "connections" && <RuntimeSettingsUpdateCard active={active} providers={providers} automation={automation} aiaAvailable={Boolean(aiaRuntimeProvider(automation))} onRequestDiscovery={onRequestAiaPrompt} onAutomationChange={onAutomationChange} />}
      {tab === "plugins" && <PluginSettingsView active={active} section={pluginSection} onSectionChange={setPluginSection} />}
      {tab === "automation" && <CypressWorkspacePanel active={active} />}
      {tab === "display" && <><section className="settings-card display-settings-card">
        <header>
          <div><span>{text("화면", "Display")}</span><h2>{text("화면 설정", "Display settings")}</h2></div>
          <p>{text("메인 메뉴 구성과 앱 전체의 테마·강조 색상을 한곳에서 설정합니다.", "Configure the main menu, app theme, and accent color in one place.")}</p>
        </header>
        <div className="settings-card-sections">
          <section className="settings-subsection">
            <header><div><strong>{text("메인 메뉴", "Main menu")}</strong><small>{text("설정을 제외한 메뉴의 표시 여부와 순서를 정합니다. 이 설정은 현재 기기에 저장됩니다.", "Choose which menus are shown and arrange their order. This setting is stored on this device.")}</small></div></header>
            <div className="navigation-preference-list">
              {navigationPreferences.order.map((view, index) => {
                const [ko, en] = navigationLabels[view];
                const label = text(ko, en);
                const visible = !navigationPreferences.hidden.includes(view);
                return (
                  <div className={visible ? "navigation-preference-row" : "navigation-preference-row hidden-menu"} key={view}>
                    <button
                      className="navigation-visibility-toggle"
                      type="button"
                      aria-pressed={visible}
                      title={visible ? text("메뉴에서 숨기기", "Hide from menu") : text("메뉴에 표시하기", "Show in menu")}
                      onClick={() => onNavigationPreferencesChange(setNavigationVisibility(navigationPreferences, view, !visible))}
                    >
                      <i aria-hidden="true">{visible ? <Eye size={16} /> : <EyeOff size={16} />}</i>
                      <span><strong>{label}{previewView(view) && <em className="nav-preview-tag">{text("준비중", "Preparing")}</em>}</strong><small>{visible ? text("메뉴에 표시", "Shown in menu") : text("메뉴에서 숨김", "Hidden from menu")}</small></span>
                    </button>
                    <div className="navigation-order-actions">
                      <button type="button" disabled={index === 0} aria-label={text(`${ko} 위로 이동`, `Move ${en} up`)} title={text("위로 이동", "Move up")} onClick={() => onNavigationPreferencesChange(moveNavigationItem(navigationPreferences, view, -1))}><ArrowUpToLine size={15} /></button>
                      <button type="button" disabled={index === navigationPreferences.order.length - 1} aria-label={text(`${ko} 아래로 이동`, `Move ${en} down`)} title={text("아래로 이동", "Move down")} onClick={() => onNavigationPreferencesChange(moveNavigationItem(navigationPreferences, view, 1))}><ArrowDownToLine size={15} /></button>
                    </div>
                  </div>
                );
              })}
              <div className="navigation-preference-row fixed-menu">
                <div className="navigation-fixed-label"><i aria-hidden="true"><Settings size={16} /></i><span><strong>{text("설정", "Settings")}</strong><small>{text("항상 마지막에 표시", "Always shown last")}</small></span></div>
                <em>{text("고정", "Fixed")}</em>
              </div>
            </div>
          </section>
          <section className="settings-subsection">
            <header><div><strong>{text("테마", "Theme")}</strong><small>{text("앱 전체의 밝기 테마를 선택합니다. 자동은 운영체제 설정을 따릅니다.", "Choose the app appearance. Auto follows the operating system.")}</small></div></header>
            <div className="settings-choice-list" role="radiogroup" aria-label={text("화면 테마", "Display theme")}>
              {themeModes.map((option) => {
                const selected = option.value === themeMode;
                return (
                  <button className={selected ? "selected" : ""} type="button" role="radio" aria-checked={selected} onClick={() => onThemeModeChange(option.value)} key={option.value}>
                    <i aria-hidden="true"><option.icon size={19} strokeWidth={1.8} /></i>
                    <span><strong>{option.title}</strong><small>{option.description}</small></span>
                    <em>{selected ? text("선택됨", "Selected") : text("선택", "Select")}</em>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="settings-subsection">
            <header><div><strong>{text("메인 색상", "Accent color")}</strong><small>{text("버튼과 강조 요소에 사용할 색상을 선택합니다.", "Choose the color used for buttons and highlights.")}</small></div></header>
            <div className="accent-swatch-list" role="radiogroup" aria-label={text("메인 색상", "Accent color")}>
              {accentColors.map((option) => {
                const selected = option.value === accentColor;
                return (
                  <button className={selected ? "accent-swatch selected" : "accent-swatch"} type="button" role="radio" aria-checked={selected} onClick={() => onAccentColorChange(option.value)} style={{ "--swatch": option.swatch } as CSSProperties} key={option.value}>
                    <i aria-hidden="true" />{option.title}
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </section>
      <section className="settings-card">
        <header>
          <div><span>{text("채팅", "Chat")}</span><h2>{text("메시지 표시 방식", "Message display")}</h2></div>
          <p>{text("세션을 클릭했을 때 대화의 어느 위치부터 보여줄지 선택합니다.", "Choose which part of a conversation is shown when opening a session.")}</p>
        </header>
        <div className="settings-choice-list" role="radiogroup" aria-label={text("채팅 메시지 표시 방식", "Chat message display")}>
          {displayModes.map((option) => {
            const selected = option.value === messageDisplayMode;
            return (
              <button
                className={selected ? "selected" : ""}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onMessageDisplayModeChange(option.value)}
                key={option.value}
              >
                <i aria-hidden="true"><option.icon size={19} strokeWidth={1.8} /></i>
                <span><strong>{option.title}</strong><small>{option.description}</small></span>
                <em>{selected ? text("선택됨", "Selected") : text("선택", "Select")}</em>
              </button>
            );
          })}
        </div>
      </section></>}
      <p className="settings-storage-note">{text("이 설정은 호스트에 저장되며 공급자 채팅 원본에는 영향을 주지 않습니다.", "These settings are stored on the host and do not modify provider conversation sources.")}</p>
    </div>
  );
}

/** 사용량 분산 교체로 고를 수 있는 격차 폭(%p). 촘촘한 분산이 요점이라 낮은 쪽을 촘촘히 둔다. */
const AUTO_SWITCH_USAGE_GAP_CHOICES = [5, 10, 15, 20, 25, 30, 40, 50];

const DISCOVERY_WATCH_INTERVAL_MS = 15_000;
const DISCOVERY_WATCH_MAX_ATTEMPTS = 20;

// 채팅 실행설정은 CLI 상태를 읽을 때 백엔드가 `--help`를 직접 조사해 자동으로 맞춘다.
// 이 카드는 그 결과와 AIA가 제안한 모델·추론 카탈로그 상태를 보여주고, 자동 조사로
// 판단할 수 없는 부분(도움말 산문의 모델 alias 등)을 AIA가 살펴보게 하는 경로다.
// AIA가 꺼져 있으면 재조사 경로 전체를 쓸 수 없다.
/**
 * 스킬·지침 공통 저장소 위치 설정. 지침관리 화면에 있던 카드를 설정 저장소 탭으로
 * 옮겼다. 경로를 바꾸면 스킬·지침 목록이 새 경로를 다시 읽어야 하므로 `onChanged`로
 * 알린다.
 */
function ResourceRepositoryCard({ onChanged, automation, onRequestAiaPrompt }: {
  onChanged?: () => void;
  automation: SystemAutomationSnapshot | null;
  /** 저장소 백업·복구를 AIA 입력창에 위임한다. */
  onRequestAiaPrompt?: (prompt: string) => void;
}) {
  const { text } = useI18n();
  const aiaAvailable = Boolean(aiaRuntimeProvider(automation));
  const [repository, setRepository] = useState<ResourceRepositorySettings | null>(null);
  const [rootPath, setRootPath] = useState("");
  const [migrateExisting, setMigrateExisting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getResourceRepository()
      .then((settings) => {
        if (!active) return;
        setRepository(settings);
        setRootPath(settings.rootPath);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorText(cause));
      });
    return () => { active = false; };
  }, []);

  const apply = async (useDefault: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const settings = await setResourceRepository({
        rootPath: useDefault ? null : rootPath.trim(),
        migrateExisting,
      });
      setRepository(settings);
      setRootPath(settings.rootPath);
      setNotice(useDefault
        ? text("기본 저장소 경로로 되돌렸습니다.", "Restored the default repository path.")
        : text("라이브러리 경로를 적용했습니다.", "Applied the library path."));
      onChanged?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-card">
      <header>
        <div>
          <span>{text("라이브러리", "Library")}</span>
          <h2>{text("스킬·프로젝트 지침 저장 위치", "Skill and project instruction storage")}</h2>
        </div>
        <p>{text(
          "스킬 원본과 프로젝트 지침 원본을 보관할 위치입니다. 클라우드 드라이브 폴더로 바꾸면 여러 기기에서 같은 원본을 씁니다.",
          "Where skill and project instruction sources are archived. Point it at a cloud-drive folder to share the same sources across devices.",
        )}</p>
      </header>
      <div className="settings-card-sections">
        <section className="settings-subsection">
          <header>
            <div>
              <strong>{text("현재 장치", "Current device")}</strong>
              <small>{repository ? platformLabel(repository.currentPlatform, text) : "-"}</small>
            </div>
            {repository && (
              <span className={`skill-sync-pill ${repository.custom ? "conflict" : "current"}`}>
                {repository.custom ? text("사용자 지정", "Custom") : text("앱 기본값", "App default")}
              </span>
            )}
          </header>
          {error && <ErrorBanner message={error} />}
          {!repository ? (
            <p className="settings-storage-note">{text("저장소 설정을 불러오는 중…", "Loading repository settings…")}</p>
          ) : (
            <div className="detail-card">
              <div className="form-row">
                <label htmlFor="resource-repository-path">{text("저장소 경로", "Repository path")}</label>
                <div data-ui-anchor="settings.repository-path">
                  <PathField
                    id="resource-repository-path"
                    value={rootPath}
                    onChange={setRootPath}
                    placeholder={repository.defaultRootPath}
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="resource-repository-default-path">{text("기본 경로", "Default path")}</label>
                <div>
                  <PathField id="resource-repository-default-path" value={repository.defaultRootPath} />
                </div>
              </div>
              <div className="form-row">
                <label>{text("하위 경로", "Managed folders")}</label>
                <div className="path-field-group">
                  <PathField value={repository.skillsPath} />
                  <PathField value={repository.instructionsPath} />
                </div>
              </div>
              <div className="form-row">
                <label>{text("이전", "Migration")}</label>
                <label className="check-filter">
                  <input
                    type="checkbox"
                    checked={migrateExisting}
                    onChange={(event) => setMigrateExisting(event.target.checked)}
                    disabled={busy}
                  />
                  {text("기존 스킬·지침 원본을 새 경로로 복사", "Copy existing skill and instruction sources to the new path")}
                </label>
              </div>
              <div className="form-actions">
                <button
                  className="button"
                  type="button"
                  disabled={busy || !repository.custom}
                  onClick={() => { void apply(true); }}
                >{text("기본 경로로 복귀", "Restore default")}</button>
                <button
                  className="button primary"
                  type="button"
                  disabled={busy || !rootPath.trim()}
                  onClick={() => { void apply(false); }}
                >{busy ? text("적용 중…", "Applying…") : text("적용", "Apply")}</button>
              </div>
              {notice && <p className="settings-storage-note" role="status">{notice}</p>}
            </div>
          )}
        </section>
        {onRequestAiaPrompt && (
          <section className="settings-subsection">
            <header>
              <div>
                <strong>{text("백업 및 복구", "Backup and restore")}</strong>
                <small>{text(
                  "스킬·지침 원본을 AIA로 백업하거나 복원합니다. 채팅·세션·계정 정보는 포함되지 않습니다.",
                  "Back up or restore skill and instruction sources with AIA. Chats, sessions, and account data are not included.",
                )}</small>
              </div>
              <div className="repository-transfer-buttons">
                <button
                  className="button"
                  type="button"
                  disabled={!aiaAvailable}
                  title={aiaAvailable
                    ? text("AIA에게 라이브러리 백업을 요청합니다", "Ask AIA to back up the library")
                    : text("연결된 시스템 에이전트를 설정하세요", "Configure a connected system agent")}
                  onClick={() => onRequestAiaPrompt(repositoryTransferPrompt("backup"))}
                ><Download size={15} aria-hidden="true" /><AiaMark size={14} />{text("백업", "Back up")}</button>
                <button
                  className="button"
                  type="button"
                  disabled={!aiaAvailable}
                  title={aiaAvailable
                    ? text("AIA에게 라이브러리 복구를 요청합니다", "Ask AIA to restore the library")
                    : text("연결된 시스템 에이전트를 설정하세요", "Configure a connected system agent")}
                  onClick={() => onRequestAiaPrompt(repositoryTransferPrompt("restore"))}
                ><Upload size={15} aria-hidden="true" /><AiaMark size={14} />{text("복구", "Restore")}</button>
              </div>
            </header>
          </section>
        )}
      </div>
    </section>
  );
}

function platformLabel(platform: HostPlatform, text: (ko: string, en: string) => string): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "linux") return "Linux";
  return text("알 수 없음", "Unknown");
}

function RuntimeSettingsUpdateCard({ active, providers, automation, aiaAvailable, onRequestDiscovery, onAutomationChange }: {
  active: boolean;
  providers: ProviderStatus[];
  automation: SystemAutomationSnapshot | null;
  aiaAvailable: boolean;
  onRequestDiscovery: (text: string) => void;
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void;
}) {
  const { text } = useI18n();
  const sourceKey = providers
    .filter((provider) => provider.cli.detected)
    .map((provider) => provider.provider)
    .join(",");
  const [loaded, setLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [watching, setWatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogState, setCatalogState] = useState<{ updatedAt: number | null; stale: ProviderId[] }>({ updatedAt: null, stale: [] });
  const autoDiscovery = automation?.settings.catalogAutoDiscovery !== false;
  const loadedForCurrentEntryRef = useRef(false);
  const watchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadUpdatedAt = useCallback(async (): Promise<number | null | undefined> => {
    try {
      const sources = sourceKey ? sourceKey.split(",") as ProviderId[] : [];
      if (sources.length === 0) {
        setUpdatedAt(null);
        setError(null);
        return null;
      }
      const options = await Promise.all(sources.map((source) => refreshProviderOptions(source)));
      const stamps = options.map((item) => item.settingsUpdatedAt).filter((stamp): stamp is number => stamp !== null);
      const latest = stamps.length > 0 ? Math.max(...stamps) : null;
      setUpdatedAt(latest);
      const catalogStamps = options.map((item) => item.catalogUpdatedAt).filter((stamp): stamp is number => stamp !== null);
      setCatalogState({
        updatedAt: catalogStamps.length > 0 ? Math.max(...catalogStamps) : null,
        stale: staleCatalogSources(options).map((item) => item.source),
      });
      setError(null);
      return latest;
    } catch (cause) {
      setError(errorText(cause));
      return undefined;
    } finally {
      setLoaded(true);
    }
  }, [sourceKey]);
  const stopDiscoveryWatch = useCallback(() => {
    if (watchTimerRef.current !== null) {
      clearInterval(watchTimerRef.current);
      watchTimerRef.current = null;
    }
    setWatching(false);
  }, []);
  // AIA가 propose_chat_settings_schema로 스키마를 저장하면 갱신 시각이 바뀌므로, 바뀔 때까지 주기적으로 재조회한다.
  const startDiscoveryWatch = useCallback((baseline: number | null) => {
    stopDiscoveryWatch();
    setWatching(true);
    let attempts = 0;
    watchTimerRef.current = setInterval(() => {
      attempts += 1;
      void loadUpdatedAt().then((latest) => {
        if ((latest !== undefined && latest !== baseline) || attempts >= DISCOVERY_WATCH_MAX_ATTEMPTS) stopDiscoveryWatch();
      });
    }, DISCOVERY_WATCH_INTERVAL_MS);
  }, [loadUpdatedAt, stopDiscoveryWatch]);
  useEffect(() => () => stopDiscoveryWatch(), [stopDiscoveryWatch]);
  useEffect(() => {
    if (!active) {
      loadedForCurrentEntryRef.current = false;
      return;
    }
    if (loadedForCurrentEntryRef.current) return;
    loadedForCurrentEntryRef.current = true;
    void loadUpdatedAt();
  }, [active, loadUpdatedAt]);
  // 옆 카드가 CLI 상태를 읽으면 백엔드가 스키마를 다시 조사하고 카탈로그가 갱신된다.
  // 그 결과가 이 카드의 표시에도 바로 반영되도록 카탈로그 갱신 알림을 함께 듣는다.
  useEffect(() => subscribeProviderOptions(() => {
    const sources = sourceKey ? sourceKey.split(",") as ProviderId[] : [];
    const options = sources.map((source) => cachedProviderOptions(source));
    const stamps = options
      .map((item) => item?.settingsUpdatedAt ?? null)
      .filter((stamp): stamp is number => stamp !== null);
    if (stamps.length > 0) setUpdatedAt(Math.max(...stamps));
    const catalogStamps = options
      .map((item) => item?.catalogUpdatedAt ?? null)
      .filter((stamp): stamp is number => stamp !== null);
    setCatalogState({
      updatedAt: catalogStamps.length > 0 ? Math.max(...catalogStamps) : null,
      stale: staleCatalogSources(options).map((item) => item.source),
    });
  }), [sourceKey]);
  const requestDiscovery = async (prompt: (sources: ProviderId[]) => string) => {
    if (refreshing || !aiaAvailable) return;
    setRefreshing(true);
    const baseline = await loadUpdatedAt();
    const sources = sourceKey ? sourceKey.split(",") as ProviderId[] : [];
    if (sources.length > 0) {
      onRequestDiscovery(prompt(sources));
      startDiscoveryWatch(baseline === undefined ? null : baseline);
    }
    setRefreshing(false);
  };
  // 자동 재조사는 호스트 설정이므로 원격 브라우저에서 바꿔도 같은 판단이 공유된다.
  // 값 하나를 쓰는 일이라 결과를 누른 쪽이 이미 안다. 왕복을 기다리면 체크박스가 잠긴 채
  // 그대로 있어 눌리지 않은 것처럼 보이므로, 화면을 먼저 바꾸고 거절되면 되돌린다.
  const changeAutoDiscovery = (enabled: boolean) => {
    if (!automation) return;
    const previous = automation;
    setError(null);
    onAutomationChange({ ...previous, settings: { ...previous.settings, catalogAutoDiscovery: enabled } });
    void setSystemAutomationSettings({ ...previous.settings, catalogAutoDiscovery: enabled })
      .then(onAutomationChange)
      .catch((cause: unknown) => { onAutomationChange(previous); setError(errorText(cause)); });
  };
  return (
    <section className="settings-card settings-update-card">
      <header>
        <div><span>{text("실행설정", "Runtime settings")}</span><h2>{text("채팅 실행설정 스키마", "Chat runtime settings schema")}</h2></div>
        <p>{text("CLI 정보를 갱신할 때마다 설치된 CLI의 `--help`를 직접 조사해, 채팅 실행설정 항목에서 지원하지 않는 선택지를 자동으로 걸러냅니다.", "Whenever CLI information is refreshed, the installed CLI's `--help` is inspected directly to drop chat runtime setting options the CLI no longer accepts.")}</p>
      </header>
      <div className="settings-update-body">
        <span className="settings-update-status">
          <strong>{text("마지막 조사", "Last inspected")}</strong>
          <small>{!loaded
            ? text("확인 중…", "Checking…")
            : watching
              ? text("AIA가 CLI 인터페이스를 다시 살펴보는 중… 완료되면 자동 반영됩니다.", "AIA is re-checking the CLI interfaces… results will appear automatically.")
              : updatedAt !== null
                ? text(`${new Date(updatedAt).toLocaleString()} 기준`, `As of ${new Date(updatedAt).toLocaleString()}`)
                : text("조사 기록이 없습니다 · 내장 스키마 사용 중", "No inspection recorded yet · using the built-in schema")}</small>
        </span>
        <button className="button compact" type="button" disabled={refreshing || !aiaAvailable} title={aiaAvailable ? text("AIA에게 CLI 인터페이스 재검토를 요청합니다", "Ask AIA to re-check the CLI interfaces") : text("시스템 설정에서 시스템 에이전트를 선택하세요", "Select a system agent in system settings")} onClick={() => void requestDiscovery(schemaDiscoveryPrompt)}><RefreshCw size={13} />{refreshing ? text("요청 중…", "Requesting…") : text("AIA 재검토", "Re-check with AIA")}</button>
      </div>
      <div className="settings-update-body">
        <span className="settings-update-status">
          <strong>{text("모델·추론 카탈로그", "Model and reasoning catalog")}</strong>
          <small>{!loaded
            ? text("확인 중…", "Checking…")
            : catalogState.stale.length > 0
              ? text(`재조사 필요 · ${catalogState.stale.join(", ")}`, `Needs a re-check · ${catalogState.stale.join(", ")}`)
              : catalogState.updatedAt !== null
                ? text(`${new Date(catalogState.updatedAt).toLocaleString()} 기준 · CLI 버전과 일치`, `As of ${new Date(catalogState.updatedAt).toLocaleString()} · matches the CLI version`)
                : text("CLI가 목록을 직접 제공합니다 · 제안 없음", "The CLI provides the list directly · no proposal")}</small>
        </span>
        <button
          className="button compact"
          type="button"
          disabled={refreshing || !aiaAvailable || catalogState.updatedAt === null}
          title={text("AIA가 제안한 모델·추론 목록을 지우고 CLI 조사 결과와 내장 목록으로 되돌립니다", "Clear the model and reasoning lists AIA proposed and fall back to the CLI inspection and built-in lists")}
          onClick={() => void requestDiscovery(catalogResetPrompt)}
        >{text("제안 되돌리기", "Reset proposal")}</button>
      </div>
      <label className="check-filter settings-update-toggle">
        <input
          type="checkbox"
          checked={autoDiscovery}
          disabled={!automation}
          onChange={(event) => changeAutoDiscovery(event.target.checked)}
        />
        <span>{text("CLI가 업데이트되면 AIA에게 모델·추론 재조사를 자동으로 요청", "Ask AIA to re-check models and reasoning automatically after a CLI update")}</span>
      </label>
      {!aiaAvailable && <small className="settings-storage-note">{text("시스템 에이전트를 선택하면 재조사를 요청할 수 있습니다.", "Select a system agent to request a re-check.")}</small>}
      {error && <ErrorBanner message={error} />}
    </section>
  );
}

function CliConnectionSettingsSection({ active, providers, accounts, onAccountsChange, onConnect }: {
  /** 설정 화면이 보이는 중인지. 진입할 때마다 CLI 상태를 다시 읽는 근거다. */
  active: boolean;
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  onAccountsChange: (snapshot: AccountSnapshot) => void;
  onConnect: (provider: ProviderStatus) => void;
}) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [login, setLogin] = useState<AccountLoginSessionView | null>(null);
  const [loginLabel, setLoginLabel] = useState("");
  const [loginComplete, setLoginComplete] = useState(false);
  const [accountTools, setAccountTools] = useState<AccountToolsSnapshot | null>(null);
  const [cliStatuses, setCliStatuses] = useState<ProviderCliUpdateStatus[] | null>(null);
  const [cliBusy, setCliBusy] = useState<string | null>(null);
  const [cliPending, setCliPending] = useState<{ kind: CliActionKind; status: ProviderCliUpdateStatus; counts: ProviderRuntimeCounts } | null>(null);
  // 업데이트 실패와 캐시 정리 실패를 서로 덮어쓰지 않도록 작업 종류까지 키에 넣는다.
  const [cliNotices, setCliNotices] = useState<Record<string, string>>({});
  const [cliErrors, setCliErrors] = useState<Record<string, string>>({});
  // 설정 화면은 한 번 열면 언마운트되지 않으므로(App의 mountedViews는 누적형), 진입할
  // 때마다 다시 읽어야 캐시·버전이 바뀐 결과가 화면에 반영된다. 두 참조 모두 화면을
  // 벗어날 때 풀린다.
  const cliStatusLoadedForEntryRef = useRef(false);
  const autoCheckedRef = useRef(false);
  const canManage = access?.writable === true;
  const providerLabel = (provider: ProviderId) => (provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider);

  useEffect(() => {
    let disposed = false;
    void getWebAccessStatus()
      .then((next) => { if (!disposed) setAccess(next); })
      .catch((cause) => { if (!disposed) setError(errorText(cause)); });
    return () => { disposed = true; };
  }, []);

  // 계정별 도구 요약은 공급자 홈 설정만 읽는 부수효과 없는 조회다. 계정 목록이
  // 바뀔 때(추가·삭제·활성 계정 전환)마다 다시 읽어 귀속을 최신 상태로 맞춘다.
  const accountRevision = accounts?.accounts.map((account) => account.id).join(",") ?? "";
  const observedRevision = accounts?.providers
    .map((state) => `${state.provider}:${state.observedActiveAccountId ?? ""}`)
    .join(",") ?? "";
  // Antigravity 사용량은 계정 레지스트리에 없어 계정 스냅샷에 실려 오지 않는다. 이 탭을
  // 열었을 때만 따로 읽는다 — 값이 실행 중인 language server에서 오므로 화면을 보지 않는
  // 동안 주기적으로 두드릴 이유가 없다.
  const hasAntigravity = providers.some((provider) => provider.provider === "antigravity");
  const [antigravityUsage, setAntigravityUsage] = useState<AccountUsageView | null>(null);
  const [antigravityLoading, setAntigravityLoading] = useState(false);
  const refreshAntigravityUsage = useCallback(() => {
    setAntigravityLoading(true);
    // 조회 실패도 사용량 상태로 그려 준다. 계정 관리 화면 전체를 막을 이유가 없다.
    void getAntigravityUsage()
      .then((next) => setAntigravityUsage(next))
      .catch((cause) => setAntigravityUsage({
        status: "error",
        windows: [],
        updatedAt: Date.now(),
        error: errorText(cause),
        retryAt: null,
        rateLimited: false,
        tokenRefreshLimited: false,
        tokenRefreshThrottleStreak: 0,
      }))
      .finally(() => setAntigravityLoading(false));
  }, []);
  useEffect(() => {
    if (!active || !hasAntigravity) return;
    refreshAntigravityUsage();
  }, [active, hasAntigravity, refreshAntigravityUsage]);

  useEffect(() => {
    if (!accounts) return undefined;
    let disposed = false;
    // 도구 요약 조회가 실패해도 계정 관리 화면 자체는 계속 쓸 수 있어야 한다.
    void getAccountTools()
      .then((next) => { if (!disposed) setAccountTools(next); })
      .catch(() => { if (!disposed) setAccountTools(null); });
    return () => { disposed = true; };
  }, [Boolean(accounts), accountRevision, observedRevision]);

  useEffect(() => {
    if (!active) {
      cliStatusLoadedForEntryRef.current = false;
      autoCheckedRef.current = false;
      return undefined;
    }
    if (cliStatusLoadedForEntryRef.current) return undefined;
    cliStatusLoadedForEntryRef.current = true;
    let disposed = false;
    void getCliUpdateStatus()
      .then((next) => {
        if (disposed) return;
        setCliStatuses(next);
        // 백엔드는 CLI 상태를 읽으면서 실행설정 스키마를 다시 조사한다. 채팅 화면이
        // 이미 캐시한 스키마를 최신 결과로 바꾸기 위해 탐지된 공급자만 다시 읽는다.
        for (const status of next) {
          if (status.detected) void refreshProviderOptions(status.provider).catch(() => undefined);
        }
      })
      .catch((cause) => { if (!disposed) failCli("status", errorText(cause)); });
    return () => { disposed = true; };
  }, [active]);

  const applyCliStatus = (next: ProviderCliUpdateStatus) => {
    setCliStatuses((current) => current?.map((status) => (status.provider === next.provider ? next : status)) ?? [next]);
    // 최신 버전 확인·업데이트도 같은 재조사를 거치므로 스키마를 함께 갱신한다.
    void refreshProviderOptions(next.provider).catch(() => undefined);
  };

  // 설정 화면에 들어올 때마다 최신 버전을 한 번 조회해 버전 차이를 알린다. 위 조회가
  // 새로 읽은 상태를 넣어 주면 이 효과가 이어서 돈다. 원격 화면도 write 권한이 있으면
  // 같은 조회를 수행한다.
  useEffect(() => {
    if (!cliStatuses || !access || autoCheckedRef.current || !canManage) return undefined;
    const targets = cliStatuses.filter((status) => status.checkSupported && !status.checked);
    if (targets.length === 0) return undefined;
    autoCheckedRef.current = true;
    let disposed = false;
    void (async () => {
      for (const target of targets) {
        try {
          const next = await checkProviderCliUpdate(target.provider);
          if (disposed) return;
          applyCliStatus(next);
        } catch (cause) {
          if (disposed) return;
          failCli(`check-${target.provider}`, errorText(cause));
        }
      }
    })();
    return () => { disposed = true; };
  }, [cliStatuses, access, canManage]);

  const clearCliMessages = (keys: string[]) => {
    setCliNotices((current) => withoutKeys(current, keys));
    setCliErrors((current) => withoutKeys(current, keys));
  };

  // CLI 작업의 결과 문구는 작업 키마다 안내 아니면 오류 한 줄로 남는다. 두 표에 같은
  // 모양으로 값을 끼워 넣던 여덟 자리를 이 두 함수로 모은다.
  const noteCli = (key: string, message: string) => {
    setCliNotices((current) => ({ ...current, [key]: message }));
  };
  const failCli = (key: string, message: string) => {
    setCliErrors((current) => ({ ...current, [key]: message }));
  };

  // 최신 버전 확인·업데이트·캐시 정리는 "busy 키를 걸고, 그 키에 남은 지난 문구를 지우고,
  // 무엇으로 끝나든 busy를 푼다"는 껍데기를 똑같이 되풀이했다. 껍데기만 여기로 모으고,
  // 성공했는지는 부르는 쪽이 돌려받은 값으로 판단한다.
  const runCliAction = async <T,>(
    key: string,
    action: () => Promise<T>,
    describeFailure: (message: string) => string = (message) => message,
  ): Promise<{ value: T } | null> => {
    setCliBusy(key);
    clearCliMessages([key]);
    try {
      return { value: await action() };
    } catch (cause) {
      failCli(key, describeFailure(errorText(cause)));
      return null;
    } finally {
      setCliBusy(null);
    }
  };

  const checkCliUpdate = async (status: ProviderCliUpdateStatus) => {
    if (cliBusy) return;
    await runCliAction(`check-${status.provider}`, async () => {
      applyCliStatus(await checkProviderCliUpdate(status.provider));
    });
  };

  // 업데이트와 캐시 정리는 실행 직전 대상 수를 다시 조회하고, 종료할 런타임이 있으면
  // 확인을 받는다. 실제 종료는 백엔드가 계정 전환과 같은 정책으로 다시 수행한다.
  const requestCliAction = async (kind: CliActionKind, status: ProviderCliUpdateStatus) => {
    if (cliBusy) return;
    const key = `${kind}-${status.provider}`;
    setCliPending(null);
    const read = await runCliAction(key, () => getProviderRuntimeCounts(status.provider));
    if (!read) return;
    if (runtimeStopConfirmationCount(read.value) > 0) {
      setCliPending({ kind, status, counts: read.value });
      return;
    }
    await performCliAction(kind, status);
  };

  const performCliAction = async (kind: CliActionKind, status: ProviderCliUpdateStatus) => {
    const key = `${kind}-${status.provider}`;
    setCliPending(null);
    // 업데이트와 캐시 정리는 요청이 성공해도 영수증이 실패를 담고 올 수 있다. 그때는
    // 예외가 아니라 오류 문구로 남겨야 하므로 판정을 여기서 하고, 왕복 자체가 실패한
    // 경우의 문구만 어느 작업이었는지 붙여 다시 적는다.
    await runCliAction(key, async () => {
      if (kind === "update") {
        const receipt = await updateProviderCli(status.provider);
        applyCliStatus(receipt.status);
        const message = `${cliUpdateOutcomeMessage(receipt)}${stopSummaryText(receipt.stopped)}`;
        if (receipt.outcome === "failed" || receipt.outcome === "verificationFailed") {
          failCli(key, `${message}${receipt.failureOutput ? `\n${receipt.failureOutput}` : ""}`);
        } else {
          noteCli(key, message);
        }
      } else {
        const receipt = await clearProviderModelCaches(status.provider);
        applyCliStatus(receipt.status);
        const message = `${cacheCleanupMessage(receipt)}${stopSummaryText(receipt.stopped)}`;
        if (receipt.failedCount > 0) {
          failCli(key, message);
        } else {
          noteCli(key, message);
        }
      }
    }, (message) => `${kind === "update" ? "업데이트 실패" : "모델 캐시 정리 실패"}: ${message}`);
  };

  const cliAlert = cliUpdateAlert(cliStatuses ?? []);

  // 계정 카드의 작업들은 "busy 키를 걸고, 지난 오류·안내를 지우고, 무엇으로 끝나든 busy를
  // 푼다"는 껍데기를 똑같이 되풀이했다. 껍데기만 여기로 모으고, 실패를 카드 하단에 적을지
  // 대화상자 안에 적을지는 부르는 쪽이 돌려받은 문구로 정한다.
  const runAccountAction = async (key: string, action: () => Promise<void>): Promise<string | null> => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      return null;
    } catch (cause) {
      return errorText(cause);
    } finally {
      setBusy(null);
    }
  };

  const mutate = async (key: string, action: () => Promise<AccountSnapshot>) => {
    if (busy) return;
    const failure = await runAccountAction(key, async () => { onAccountsChange(await action()); });
    if (failure) setError(failure);
  };

  // 자격증명 재검증이나 계정 전환과 달리, 자동전환 설정은 레지스트리에 값 하나를 쓰는 일이라
  // 결과를 누른 쪽이 이미 안다. 공용 mutate는 왕복이 끝날 때까지 busy로 카드 전체를 잠그고
  // 값도 그때 바뀌므로, 이 설정들은 화면을 먼저 바꾸고 요청을 뒤로 보낸다. 연속으로 바꿔
  // 응답 순서가 뒤바뀌어도 마지막 요청의 응답만 반영하고, 그 요청이 실패했을 때만 되돌린다.
  const settingRevision = useRef(0);
  const patchAccount = (accountId: string, patch: Partial<ProviderAccountView>) =>
    (current: AccountSnapshot): AccountSnapshot => ({
      ...current,
      accounts: current.accounts.map((item) => item.id === accountId ? { ...item, ...patch } : item),
    });
  const applySetting = (
    optimistic: (current: AccountSnapshot) => AccountSnapshot,
    action: () => Promise<AccountSnapshot>,
  ) => {
    if (!accounts) return;
    const previous = accounts;
    settingRevision.current += 1;
    const revision = settingRevision.current;
    setError(null);
    setNotice(null);
    onAccountsChange(optimistic(previous));
    void action()
      .then((next) => { if (settingRevision.current === revision) onAccountsChange(next); })
      .catch((cause: unknown) => {
        if (settingRevision.current !== revision) return;
        onAccountsChange(previous);
        setError(errorText(cause));
      });
  };

  // 별칭과 메모는 저장 대상만 다르고 절차가 같다. 저장 실패는 카드 하단이 아니라 편집
  // 대화상자 안에서 보여야 하므로 오류 문구를 그대로 돌려준다.
  const saveAccountText = async (
    field: "label" | "note",
    account: ProviderAccountView,
    value: string | null,
  ): Promise<string | null> => {
    if (busy) return "다른 계정 작업이 끝난 뒤 다시 저장하세요.";
    const save = field === "label" ? setProviderAccountLabel : setProviderAccountNote;
    return runAccountAction(`${field}-${account.id}`, async () => {
      onAccountsChange(await save(account.id, value));
    });
  };

  // 기본 계정 변경: 자격증명을 바꾸지 않으므로 실행 중 세션을 종료하거나 확인을 받을 이유가
  // 없다. 전환 경로가 대상 계정 사용량을 다시 조회해 영수증에 담아 주므로, 그 조회가
  // 실패했을 때만 여기서 보충한다.
  /**
   * 한도 리셋 크레딧 한 장을 쓴다.
   *
   * 장수가 한정돼 있고 되돌릴 수 없어서 누르기 전에 한 번 확인한다. 결과는 네 가지고
   * 크레딧이 실제로 줄어드는 것은 `reset`뿐이라, 물린 경우에는 그 이유를 그대로 알린다 —
   * 특히 `nothingToReset`은 "아직 초기화할 만큼 쓰지 않았다"는 뜻이라 실패가 아니다.
   */
  const consumeResetCredit = async (account: ProviderAccountView) => {
    if (busy) return;
    const remaining = account.usage.resetCredits?.availableCount ?? 0;
    if (!window.confirm(
      `${account.displayName}의 한도 리셋 크레딧 한 장을 사용합니다. 되돌릴 수 없고 사용 후 ${Math.max(remaining - 1, 0)}장이 남습니다.\n\n`
      + "지금 소진된 창이 없으면 크레딧을 쓰지 않고 물립니다. 계속할까요?",
    )) return;
    const failure = await runAccountAction(`reset-credit-${account.id}`, async () => {
      const { outcome, accounts } = await consumeAccountResetCredit(account.id);
      onAccountsChange(accounts);
      setNotice(outcome === "reset"
        ? `${account.displayName}의 사용량 한도를 초기화했습니다.`
        : outcome === "nothingToReset"
          ? "지금 초기화할 수 있는 창이 없어 크레딧을 쓰지 않았습니다. 한도를 더 쓴 뒤 다시 시도하세요."
          : outcome === "noCredit"
            ? "쓸 수 있는 리셋 크레딧이 없습니다."
            : "같은 요청이 이미 처리되어 크레딧을 추가로 쓰지 않았습니다.");
    });
    if (failure) setError(failure);
  };

  const activateAccount = async (account: ProviderAccountView) => {
    if (busy) return;
    const failure = await runAccountAction(`active-${account.id}`, async () => {
      const receipt = await switchActiveProviderAccount(account.id);
      let nextSnapshot = receipt.snapshot;
      let usageRefreshNote = "";
      if (!receipt.usageRefreshed) {
        try {
          nextSnapshot = await refreshProviderAccountUsage(account.id);
        } catch (cause) {
          usageRefreshNote = ` 사용량은 갱신하지 못했습니다: ${errorText(cause)}`;
        }
      }
      onAccountsChange(nextSnapshot);
      setNotice(`기본 계정을 ${account.displayName}(으)로 변경했습니다. 실행 중인 세션은 그대로 유지됩니다.${usageRefreshNote}`);
    });
    if (failure) setError(failure);
  };

  const beginLogin = async (provider: ProviderId, account?: ProviderAccountView) => {
    setLoginComplete(false);
    const failure = await runAccountAction(account?.id ?? provider, async () => {
      setLogin(await beginProviderAccountLogin(provider, account?.id));
      setLoginLabel(account?.displayName ?? "");
    });
    if (failure) setError(failure);
  };

  const closeLogin = async () => {
    if (!login) return;
    const id = login.id;
    setLogin(null);
    setLoginComplete(false);
    try { await cancelProviderAccountLogin(id); }
    catch (cause) { setError(errorText(cause)); }
  };

  const finishLogin = async () => {
    if (!login) return;
    if (!loginComplete) {
      setError(login.provider === "codex"
        ? "브라우저에서 일회용 코드 입력을 마치고 CLI가 정상 종료될 때까지 기다려 주세요."
        : "브라우저 인증 코드를 로그인 터미널에 전송하고 CLI가 정상 종료될 때까지 기다려 주세요.");
      return;
    }
    const id = login.id;
    const reauthentication = Boolean(login.accountId);
    const failure = await runAccountAction(id, async () => {
      const snapshot = await finishProviderAccountLogin(id, loginLabel.trim() || null);
      onAccountsChange(snapshot);
      setLogin(null);
      setLoginComplete(false);
      setNotice(reauthentication
        ? "로그인 정보를 저장했습니다. 이 계정의 다음 실행부터 새 자격증명을 씁니다."
        : "로그인 정보를 저장하고 계정 등록을 완료했습니다.");
    });
    if (failure) setError(failure);
  };

  return <>
    <section className="settings-subsection cli-status-settings-section" id="cli-connections" data-ui-anchor="settings.connections">
      <header>
        <div>
          {/* 활성 계정 변경 방식은 평소에 읽을 필요가 없는 상세 동작이라 제목 옆 물음표에 접어 둔다. */}
          <strong>{text("CLI 설정", "CLI settings")}<HelpHint
            label={text("활성 계정 변경 동작 설명", "How active account changes are applied")}
            title={text("활성 계정 변경 동작", "How active account changes are applied")}
          >{access === null
            ? text("원격 계정 관리 권한을 확인하고 있습니다.", "Checking remote account management access.")
            : !canManage
              ? text("원격 편집이 꺼져 있어 계정과 사용량만 조회할 수 있습니다.", "Remote editing is off; accounts and usage are read-only.")
              : access.remote
              ? text("원격 편집이 켜져 있어 계정 추가와 활성 인증 변경을 사용할 수 있습니다.", "Remote editing is on, so account login and active authentication changes are available.")
              : text("활성 계정 변경은 중앙 백엔드에서 실행 중인 관리 세션과 외부 실행 CLI 프로세스(터미널·IDE)를 모두 종료한 뒤 적용됩니다(정상 종료 실패 시 강제 종료). 새 세션은 변경된 활성 계정을 사용합니다.", "The central backend changes the active account only after stopping managed sessions and externally launched CLI processes (terminal/IDE), force-killing any that fail to stop; new sessions use the activated account.")}</HelpHint></strong>
          <small>{text(
            "공급자별 CLI와 공유 히스토리를 유지하면서 활성 인증 계정과 사용량을 관리합니다.",
            "Manage active authentication accounts and usage while keeping shared provider history.",
          )}</small>
        </div>
      </header>
      <div className="cli-status-settings-body">
        {hasCliUpdateAlert(cliAlert) && <div className="cli-update-alert" role="status">
          <Download size={15} aria-hidden="true" />
          <span>
            <strong>{text("CLI 업데이트 알림", "CLI update notice")}</strong>
            <small>
              {cliAlert.updatable.length > 0 && text(
                `${cliAlert.updatable.map(providerLabel).join(", ")} CLI에 새 버전이 있습니다.`,
                `A newer version is available for ${cliAlert.updatable.map(providerLabel).join(", ")}.`,
              )}
              {cliAlert.updatable.length > 0 && cliAlert.cacheMismatched.length > 0 && " "}
              {cliAlert.cacheMismatched.length > 0 && text(
                `${cliAlert.cacheMismatched.map(providerLabel).join(", ")} 모델 캐시가 실행 버전과 다른 클라이언트 버전으로 기록되어 있습니다(모델 캐시 스키마 불일치).`,
                `The model cache of ${cliAlert.cacheMismatched.map(providerLabel).join(", ")} was written by a different client version (model cache schema mismatch).`,
              )}
              {cliAlert.checkFailed.length > 0 && (cliAlert.updatable.length > 0 || cliAlert.cacheMismatched.length > 0) && " "}
              {cliAlert.checkFailed.length > 0 && text(
                `${cliAlert.checkFailed.map(providerLabel).join(", ")} 버전을 확인하지 못해 업데이트 필요 여부를 판단할 수 없습니다.`,
                `Could not read the version of ${cliAlert.checkFailed.map(providerLabel).join(", ")}, so update availability is unknown.`,
              )}
            </small>
          </span>
        </div>}
        {cliErrors.status && <ErrorBanner message={cliErrors.status} />}
        <div className="cli-settings-list account-settings-list">
          {providers.map((provider) => {
            const providerAccounts = accounts?.accounts.filter((account) => account.provider === provider.provider) ?? [];
            const providerState = accounts?.providers.find((state) => state.provider === provider.provider);
            const managed = provider.provider === "codex" || provider.provider === "claude";
            const cliStatus = cliStatuses?.find((status) => status.provider === provider.provider) ?? null;
            const cliAccess: CliActionAccess = { writable: canManage, busy: Boolean(cliBusy) };
            // 업데이트 구획은 상단 알림 근거가 있을 때만 알림과 함께 연다. 진행 중인 작업과
            // 남아 있는 결과 안내는 근거가 사라진 뒤에도 읽을 수 있게 함께 조건에 넣는다.
            const cliActionKeys = [`check-${provider.provider}`, `update-${provider.provider}`, `cache-${provider.provider}`];
            const showCliPanel = cliStatus !== null && shouldShowCliUpdatePanel(cliStatus, cliAlert, {
              busy: cliActionKeys.includes(cliBusy ?? ""),
              hasMessage: cliActionKeys.some((key) => Boolean(cliNotices[key]) || Boolean(cliErrors[key])),
              pending: cliPending?.status.provider === provider.provider,
            });
            return <article className={`cli-settings-provider account-provider-card ${provider.cli.detected ? "ready" : "needs-connection"}`} key={provider.provider}>
              <div className="account-provider-head">
                <SourceBadge source={provider.provider} />
                <span className="cli-settings-provider-copy"><strong>{provider.displayName}</strong><small>{provider.cli.path ?? text("CLI 실행 파일이 탐지되지 않았습니다.", "CLI executable was not detected.")}</small></span>
                <span className="cli-settings-provider-states">
                  <em className={provider.cli.detected ? "health ready" : "health warning"}>{provider.cli.detected ? text("CLI 탐지됨", "CLI detected") : text("연결 필요", "Connection required")}</em>
                  <button className="button compact" type="button" onClick={() => onConnect(provider)}>
                    {provider.cli.detected ? text("연결 관리", "Manage connection") : text("연결", "Connect")}
                  </button>
                </span>
              </div>
              {cliStatus && showCliPanel && <ProviderCliUpdatePanel
                status={cliStatus}
                access={cliAccess}
                busyKey={cliBusy}
                pending={cliPending?.status.provider === provider.provider ? cliPending : null}
                notices={cliNotices}
                errors={cliErrors}
                onCheck={() => void checkCliUpdate(cliStatus)}
                onUpdate={() => void requestCliAction("update", cliStatus)}
                onClearCache={() => void requestCliAction("cache", cliStatus)}
                onCancelPending={() => setCliPending(null)}
                onConfirmPending={() => { if (cliPending) void performCliAction(cliPending.kind, cliPending.status); }}
              />}
              {!managed && provider.provider === "antigravity" && <AntigravityUsageCard
                usage={antigravityUsage}
                loading={antigravityLoading}
                onRefresh={refreshAntigravityUsage}
                text={text}
              />}
              {managed && <ProviderHomeCard provider={provider.provider} home={providerState?.home} accounts={providerAccounts} tools={homeToolsFor(accountTools, provider.provider)} />}
              {managed && <div className="provider-account-list">
                {providerAccounts.length === 0 && <p className="provider-account-empty">{text("등록된 계정이 없습니다. 새 계정 로그인을 시작하세요. 계정은 각자의 격리 프로필로 로그인해 등록되며, 공유 CLI 홈의 로그인은 위 홈 계정 카드에만 표시됩니다.", "No accounts are registered yet. Start a new account login. Each account signs in to its own isolated profile; a sign-in in the shared CLI home appears only on the home account card above.")}</p>}
                {providerAccounts.map((account) => <ProviderAccountRow
                  key={account.id}
                  account={account}
                  tools={accountToolsFor(accountTools, account.id)}
                  editable={canManage}
                  busyKey={busy}
                  onActivate={() => void activateAccount(account)}
                  onRevalidate={() => void mutate(`validate-${account.id}`, () => revalidateProviderAccountCredential(account.id))}
                  onReauthenticate={() => void beginLogin(provider.provider, account)}
                  onToggleDisabled={() => void mutate(`disabled-${account.id}`, () => setProviderAccountDisabled(account.id, !account.disabled))}
                  onToggleAutoSwitch={() => applySetting(
                    patchAccount(account.id, { autoSwitch: !account.autoSwitch }),
                    () => setProviderAccountAutoSwitch(account.id, !account.autoSwitch),
                  )}
                  autoSwitchPolicy={accounts?.autoSwitchPolicy ?? "maxHeadroom"}
                  onChangePriority={(priority) => applySetting(
                    patchAccount(account.id, { autoSwitchPriority: priority }),
                    () => setProviderAccountAutoSwitchPriority(account.id, priority),
                  )}
                  onDelete={() => { void (async () => {
                    const accepted = await confirm({
                      title: text("계정 등록 삭제", "Delete account registration"),
                      message: text(
                        "이 계정의 등록과 보안 저장소 자격증명을 삭제합니다.\n공급자 대화 히스토리는 지워지지 않습니다.",
                        "This removes the account registration and its stored credential.\nProvider conversation history is kept.",
                      ),
                      items: [account.displayName],
                      warning: text("삭제한 자격증명은 되돌릴 수 없고 다시 로그인해야 합니다.", "The deleted credential cannot be restored; you must sign in again."),
                      confirmLabel: text("삭제", "Delete"),
                      tone: "danger",
                    });
                    if (accepted) await mutate(`delete-${account.id}`, () => deleteProviderAccount(account.id));
                  })(); }}
                  onRefreshUsage={() => void mutate(`usage-${account.id}`, () => refreshProviderAccountUsage(account.id))}
                  onConsumeResetCredit={() => void consumeResetCredit(account)}
                  onSaveNote={(note) => saveAccountText("note", account, note)}
                  onSaveLabel={(label) => saveAccountText("label", account, label)}
                />)}
                {providerState?.lastAutoSwitch && <ProviderAutoSwitchNote accounts={providerAccounts} event={providerState.lastAutoSwitch} />}
                <div className="provider-account-add-actions">
                  {canManage && provider.cli.detected && <button className="button compact" type="button" disabled={Boolean(busy)} onClick={() => void beginLogin(provider.provider)}><Plus size={13} />계정 추가</button>}
                </div>
              </div>}
            </article>;
          })}
        </div>
        <AccountAdvancedSelect
          title="한도 페일오버 방식"
          help="사용량 한도에 걸린 세션을 어느 계정으로 넘길지 정합니다. 자격증명이 계정별로 갈려 있으면 한도에 걸린 세션만 다른 계정에 다시 묶고 나머지 세션은 그대로 진행합니다. 세 방식 모두 자동전환이 켜져 있고 사용 가능하며 한도에 걸리지 않은 계정만 후보로 봅니다."
          disabled={!canManage || !accounts}
          value={accounts?.autoSwitchPolicy ?? "maxHeadroom"}
          options={[
            { value: "maxHeadroom", label: "사용량 여유 최대 우선" },
            { value: "priority", label: "지정한 우선순위 순" },
            { value: "registration", label: "등록 순 라운드로빈" },
          ]}
          onChange={(value) => {
            const policy = value as AutoSwitchPolicy;
            applySetting((current) => ({ ...current, autoSwitchPolicy: policy }), () => setAutoSwitchPolicy(policy));
          }}
        />
        <AccountAdvancedSelect
          title="사용량 분산 교체"
          help="계정을 100%까지 다 쓰기 전에, 활성 계정이 가장 덜 쓴 계정보다 정한 폭만큼 앞서면 그 계정으로 넘겨 사용량을 고르게 맞춥니다. 계정들이 비슷한 사용량에서 시작하면 결과적으로 이 폭만큼 쓸 때마다 순환합니다. 어느 계정으로 넘길지는 위 페일오버 방식이 정합니다. 사용량은 가장 빡빡한 창을 기준으로 보고, 사용량을 아직 읽지 못한 계정은 얼마나 뒤처졌는지 알 수 없어 후보에서 빠집니다. 실행 중인 턴은 끊지 않고 끝난 뒤에 옮기며, 새 채팅과 이어가기가 열릴 활성 계정도 함께 옮깁니다(기본 계정 지정은 그대로 둡니다). 사용량 조회 주기에 맞춰 판정하므로 격차가 벌어진 뒤 최대 5분쯤 지나 순환합니다."
          disabled={!canManage || !accounts}
          value={String(accounts?.autoSwitchUsageGapPercent ?? "")}
          options={[
            { value: "", label: "쓰지 않음 (100% 도달 시에만)" },
            ...AUTO_SWITCH_USAGE_GAP_CHOICES.map((percent) => ({ value: String(percent), label: `${percent}% 앞서면 교체` })),
          ]}
          onChange={(value) => {
            const percent = value === "" ? null : Number.parseInt(value, 10);
            applySetting((current) => ({ ...current, autoSwitchUsageGapPercent: percent }), () => setAutoSwitchUsageGap(percent));
          }}
        />
        <AccountAdvancedSelect
          title="이어가기 실행 계정"
          help="저장된 세션을 다시 열 때 어느 계정으로 실행할지 정합니다. 기본 계정으로 이어가면 기본 계정을 바꿀 때 기존 세션도 함께 옮겨지고, 마지막으로 쓴 계정으로 이어가면 세션마다 이전 계정의 한도를 계속 씁니다. 세션별로 실행 계정을 고정해 두면 이 설정과 무관하게 고정한 계정으로 실행됩니다. 이미 실행 중인 채팅은 시작 시점 계정을 유지하므로 다음 이어가기부터 적용됩니다."
          disabled={!canManage || !accounts}
          value={accounts?.resumeAccountPolicy ?? "activeAccount"}
          options={[
            { value: "activeAccount", label: "기본 계정으로 이어가기" },
            { value: "lastUsedAccount", label: "마지막으로 쓴 계정으로 이어가기" },
          ]}
          onChange={(value) => {
            const policy = value as ResumeAccountPolicy;
            applySetting((current) => ({ ...current, resumeAccountPolicy: policy }), () => setResumeAccountPolicy(policy));
          }}
        />
        <AccountAdvancedRow
          title="자동전환 후 세션 복원"
          helpTitle="자동전환 후 세션 복원 동작"
          help="사용량 한도로 계정이 자동전환되면, 그때 종료된 실행 중 채팅을 새 계정에서 이어서(resume) 다시 시작하고, 한도로 응답을 받지 못한 요청과 대기열 메시지를 순서대로 자동 재전송합니다. 진행 중이던 응답(부분 출력)과 첨부 파일은 복구되지 않습니다."
        >
          <AppToggle
            checked={accounts?.autoSwitchResume ?? true}
            disabled={!canManage || !accounts}
            label="자동전환 후 세션 복원"
            onChange={() => {
              if (!accounts) return;
              const enabled = !accounts.autoSwitchResume;
              applySetting((current) => ({ ...current, autoSwitchResume: enabled }), () => setAutoSwitchResume(enabled));
            }}
          />
        </AccountAdvancedRow>
        {notice && <p className="account-action-notice" role="status">{notice}</p>}
        {error && !login && <ErrorBanner message={error} />}
      </div>
    </section>
    {login && <Drawer title={<><SourceBadge source={login.provider} /><span>{login.accountId ? "계정 재인증" : "계정 추가"}</span></>} onClose={() => void closeLogin()}>
      <label className="account-login-label"><span>표시명</span><input value={loginLabel} onChange={(event) => setLoginLabel(event.target.value)} placeholder="비워두면 공급자 계정 이름 사용" /></label>
      <AccountLoginTerminalPanel login={login} remote={access?.remote === true} onCompletionChange={setLoginComplete} />
      {!loginComplete && <p className="account-login-completion-hint">{login.provider !== "codex"
        ? "브라우저 인증 후 표시된 코드를 터미널에 전송하세요. CLI가 정상 종료되어야 저장할 수 있습니다."
        : access?.remote === true
          ? "터미널의 링크를 브라우저에서 열고 표시된 일회용 코드를 입력하세요. CLI가 정상 종료되어야 저장할 수 있습니다."
          : "이 컴퓨터의 브라우저에서 로그인만 마치세요. CLI가 정상 종료되어야 저장할 수 있습니다."}</p>}
      {error && <ErrorBanner message={error} />}
      <div className="cli-connect-actions"><button className="button" type="button" disabled={busy === login.id} onClick={() => void closeLogin()}>취소</button><button className="button primary" type="button" disabled={busy === login.id || !loginComplete} onClick={() => void finishLogin()}>{busy === login.id ? "저장 중…" : "로그인 완료 저장"}</button></div>
    </Drawer>}
    {confirmDialog}
  </>;
}

/**
 * 계정 관리 아래쪽 고급 설정 한 행. 제목 옆 물음표에 긴 설명을 접어 두고 오른쪽에 조작부
 * 하나를 두는 모양이 네 자리(페일오버 방식·분산 교체·이어가기 계정·전환 후 복원) 모두
 * 같아 껍데기를 여기로 모은다. 물음표의 접근성 이름도 제목에서 만들어, 네 자리가 각자
 * 적다가 어긋나는 일을 막는다. 제목과 설명 제목이 다른 행만 `helpTitle`로 따로 적는다.
 */
function AccountAdvancedRow({ title, helpTitle, help, children }: {
  title: string;
  helpTitle?: string;
  help: ReactNode;
  children: ReactNode;
}) {
  const hintTitle = helpTitle ?? title;
  return (
    <div className="account-advanced-toggle">
      <span><strong>{title}<HelpHint label={`${hintTitle} 설명`} title={hintTitle}>{help}</HelpHint></strong></span>
      {children}
    </div>
  );
}

/**
 * 조작부가 선택 상자인 고급 설정 행. 세 자리(페일오버 방식·분산 교체·이어가기 계정)가
 * 접근성 이름·잠금 조건·선택지 목록의 모양까지 같아, 부르는 쪽에는 값과 선택지만 남긴다.
 * 선택 값은 언제나 문자열로 다룬다 — 숫자를 고르는 행도 "쓰지 않음"을 빈 문자열로 담기
 * 때문이다.
 */
function AccountAdvancedSelect({ title, help, disabled, value, options, onChange }: {
  title: string;
  help: ReactNode;
  disabled: boolean;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <AccountAdvancedRow title={title} help={help}>
      <select
        className="account-auto-switch-policy"
        aria-label={title}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </AccountAdvancedRow>
  );
}

type CliActionKind = "update" | "cache";

function withoutKeys(source: Record<string, string>, keys: string[]): Record<string, string> {
  const next = { ...source };
  for (const key of keys) delete next[key];
  return next;
}

const installSourceLabels: Record<ProviderCliUpdateStatus["installSource"], string> = {
  notDetected: "탐지되지 않음",
  homebrewCask: "Homebrew cask",
  homebrewFormula: "Homebrew formula",
  npmGlobal: "npm 전역 설치",
  standalone: "단독 설치",
};

function cliUpdateOutcomeMessage(receipt: CliUpdateReceipt): string {
  const prefix = receipt.outcome === "updated"
    ? "업데이트 완료"
    : receipt.outcome === "alreadyLatest"
      ? "업데이트 없음"
      : receipt.outcome === "verificationFailed"
        ? "업데이트 검증 실패"
        : "업데이트 실패";
  const versions = receipt.previousVersion && receipt.currentVersion && receipt.previousVersion !== receipt.currentVersion
    ? ` (${receipt.previousVersion} → ${receipt.currentVersion})`
    : receipt.currentVersion
      ? ` (${receipt.currentVersion})`
      : "";
  return `${prefix}${versions}: ${receipt.message}`;
}

function cacheCleanupMessage(receipt: ModelCacheCleanupReceipt): string {
  if (receipt.failedCount > 0) {
    const failures = receipt.entries.filter((entry) => entry.error).map((entry) => `${entry.label}: ${entry.error}`);
    return `모델 캐시 정리 실패: ${failures.join(" · ")}`;
  }
  if (receipt.removedCount === 0) {
    const skipped = receipt.entries.map((entry) => entry.skippedReason).filter(Boolean);
    return `모델 캐시를 정리하지 않았습니다. ${skipped.join(" · ")}`;
  }
  const removed = receipt.entries.filter((entry) => entry.removed);
  return `모델 캐시 ${receipt.removedCount}개를 삭제했습니다(${removed
    .map((entry) => `${entry.label}${entry.previousCacheClientVersion ? ` ${entry.previousCacheClientVersion}` : ""}`)
    .join(", ")}). 다음 실행에서 ${receipt.status.currentVersion ?? "현재"} 버전 기준으로 다시 생성됩니다.`;
}

function stopSummaryText(stopped: ProviderRuntimeStopSummary): string {
  const parts: string[] = [];
  if (stopped.chatStoppedCount > 0) parts.push(`관리 세션 ${stopped.chatStoppedCount}개`);
  if (stopped.terminalStoppedCount > 0) parts.push(`관리 터미널 ${stopped.terminalStoppedCount}개`);
  if (stopped.externalTerminatedCount > 0) parts.push(`외부 프로세스 ${stopped.externalTerminatedCount}개`);
  const failure = stopped.externalFailedCount > 0 ? ` 외부 프로세스 ${stopped.externalFailedCount}개는 종료되지 않았습니다.` : "";
  return parts.length > 0 ? ` ${parts.join("와 ")}를 종료했습니다.${failure}` : failure;
}

/**
 * 공급자 카드의 공통 업데이트 구획. 현재 버전, 최신 버전 또는 확인 실패,
 * 업데이트 가능 여부, 업데이트 버튼과 수동 안내, 모델 캐시 상태를 같은 순서로 그린다.
 * 상단 업데이트 알림에 근거가 있는 공급자에서만 열리므로(shouldShowCliUpdatePanel)
 * 평상시 최신 상태에서는 그려지지 않는다.
 */
function ProviderCliUpdatePanel({ status, access, busyKey, pending, notices, errors, onCheck, onUpdate, onClearCache, onCancelPending, onConfirmPending }: {
  status: ProviderCliUpdateStatus;
  access: CliActionAccess;
  busyKey: string | null;
  pending: { kind: CliActionKind; status: ProviderCliUpdateStatus; counts: ProviderRuntimeCounts } | null;
  notices: Record<string, string>;
  errors: Record<string, string>;
  onCheck: () => void;
  onUpdate: () => void;
  onClearCache: () => void;
  onCancelPending: () => void;
  onConfirmPending: () => void;
}) {
  const { text } = useI18n();
  const badge = cliUpdateBadge(status);
  const badgeTone = badge === "updateAvailable" ? "warning" : badge === "upToDate" ? "ready" : "muted";
  const badgeLabel = {
    notDetected: text("CLI 미탐지", "CLI not detected"),
    updateAvailable: text("업데이트 가능", "Update available"),
    versionUnknown: text("실행 버전 확인 실패", "Running version unknown"),
    checkFailed: text("최신 버전 확인 실패", "Version check failed"),
    upToDate: text("최신 버전", "Up to date"),
    unsupported: text("자동 업데이트 미지원", "Automatic update unsupported"),
    checkUnsupported: text("최신 버전 확인 미지원", "Version check unsupported"),
    unchecked: text("확인 전", "Not checked"),
  }[badge];
  const updateBlocked = cliUpdateBlockedReason(status, access);
  const cacheBlocked = modelCacheBlockedReason(status, access);
  const checking = busyKey === `check-${status.provider}`;
  const updating = busyKey === `update-${status.provider}`;
  const clearing = busyKey === `cache-${status.provider}`;
  const latestText = status.checkError
    ? text("확인 실패", "Check failed")
    : status.latestVersion
      ? status.latestVersion
      : status.checkSupported
        ? text("확인 전", "Not checked")
        : text("확인 미지원", "Not supported");

  return <div className="cli-update-panel">
    <div className="cli-update-versions">
      <span><em>{text("현재 버전", "Current")}</em><b>{status.currentVersion ?? text("확인 실패", "Unknown")}</b></span>
      <span><em>{text("최신 버전", "Latest")}</em><b>{latestText}</b></span>
      <em className={`health ${badgeTone}`}>{badgeLabel}</em>
    </div>
    <small className="cli-update-source">
      {text("설치 출처", "Install source")}: {installSourceLabels[status.installSource]}
      {status.packageName ? ` · ${status.packageName}` : ""}
      {status.updateCommandLabel ? ` · ${status.updateCommandLabel}` : ""}
    </small>
    {status.versionError && <small className="cli-update-note error">{status.versionError}</small>}
    {status.checkError && <small className="cli-update-note error">{text("최신 버전 확인 실패", "Version check failed")}: {status.checkError}</small>}
    {!status.checkSupported && status.checkUnsupportedReason && !status.checkError
      && <small className="cli-update-note">{status.checkUnsupportedReason}</small>}
    {updateBlocked && <small className="cli-update-note">{updateBlocked}
      {status.manualUpdateHint ? ` · ${text("수동 업데이트", "Manual update")}: ${status.manualUpdateHint}` : ""}</small>}
    <div className="cli-update-actions">
      <button className="button compact" type="button" disabled={!canCheckCliUpdate(status, access)} title={status.checkSupported ? undefined : status.checkUnsupportedReason ?? undefined} onClick={onCheck}>
        <RefreshCw size={13} />{checking ? text("확인 중…", "Checking…") : text("업데이트 확인", "Check for updates")}
      </button>
      <button className={`button compact${status.updateAvailable ? " primary" : ""}`} type="button" disabled={!canRunCliUpdate(status, access)} title={updateBlocked ?? status.updateCommandLabel ?? undefined} onClick={onUpdate}>
        <Download size={13} />{updating ? text("업데이트 중…", "Updating…") : text("업데이트", "Update")}
      </button>
      {status.modelCaches.length > 0 && <button className="button compact" type="button" disabled={!canClearModelCaches(status, access)} title={cacheBlocked ?? text("실행 버전보다 높은 기록 버전의 모델 캐시만 삭제합니다", "Deletes only model caches written by a newer client version")} onClick={onClearCache}>
        <Eraser size={13} />{clearing ? text("정리 중…", "Clearing…") : text("모델 캐시 정리", "Clear model cache")}
      </button>}
    </div>
    {status.modelCaches.length === 0
      ? <small className="cli-update-note">{status.modelCacheUnsupportedReason ?? text("이 공급자는 자동 캐시 정리를 지원하지 않습니다.", "Automatic cache cleanup is not supported for this provider.")}</small>
      : status.modelCaches.map((cache) => <small className={`cli-update-note${cache.cleanupAvailable ? " warning" : ""}`} key={cache.id}>
        {cache.label}: {cache.state === "absent"
          ? text("캐시 없음 · 다음 실행에서 생성됩니다", "No cache · created on next run")
          : cache.state === "matched"
            ? text(`기록 버전 ${cache.cacheClientVersion} · 실행 버전과 일치`, `Written by ${cache.cacheClientVersion} · matches the running CLI`)
            : cache.state === "mismatched"
              ? cacheAwaitsNewerCliRelease(status, cache)
                ? text(`기록 버전 ${cache.cacheClientVersion} ≠ 실행 버전 ${cache.cliVersion} · 같은 홈을 쓰는 더 새 클라이언트(데스크톱 앱 등)가 기록한 캐시입니다. CLI는 이미 배포된 최신이라 지금은 올릴 수 없고, ${cache.cacheClientVersion} 이상 CLI가 배포되면 업데이트로 해결됩니다. Codex가 정상 동작하면 그대로 둬도 됩니다.`, `Written by ${cache.cacheClientVersion} ≠ running ${cache.cliVersion} · a newer client sharing this home (such as a desktop app) wrote this cache. The CLI is already at the latest release; updating once ${cache.cacheClientVersion} or later ships will resolve it. Safe to leave as-is while Codex works normally.`)
                : text(`기록 버전 ${cache.cacheClientVersion} ≠ 실행 버전 ${cache.cliVersion} · 모델 캐시 스키마 불일치. 정리해도 같은 홈을 쓰는 다른 클라이언트(데스크톱 앱 등)가 다시 기록하면 재발할 수 있어, CLI를 최신으로 올리는 것이 근본 해결입니다.`, `Written by ${cache.cacheClientVersion} ≠ running ${cache.cliVersion} · schema mismatch. Another client sharing this home (such as a desktop app) can write it again after cleanup, so updating the CLI is the durable fix.`)
              : cache.state === "outdated"
                ? text(`기록 버전 ${cache.cacheClientVersion} · 실행 버전 ${cache.cliVersion}보다 낮습니다. 같은 홈을 쓰는 다른 클라이언트(데스크톱 앱 등)가 남긴 기록이며, 실행 CLI가 다음 카탈로그 조회에서 자기 버전으로 다시 기록합니다. 조치할 것은 없습니다.`, `Written by ${cache.cacheClientVersion} · older than the running ${cache.cliVersion}. Another client sharing this home (such as a desktop app) wrote it, and the running CLI restamps it on its next catalog fetch. No action needed.`)
                : cache.state === "unreadable"
                  ? text(`캐시를 해석할 수 없습니다${cache.error ? ` (${cache.error})` : ""}`, `Cache could not be read${cache.error ? ` (${cache.error})` : ""}`)
                  : text("실행 버전을 몰라 비교할 수 없습니다", "Cannot compare without the running CLI version")}
      </small>)}
    {pending && <div className="account-switch-confirm" role="alertdialog" aria-label={`${status.displayName} ${pending.kind === "update" ? "업데이트" : "모델 캐시 정리"} 확인`}>
      <ShieldAlert size={16} aria-hidden="true" />
      <span>
        <strong>{pending.kind === "update" ? "업데이트 전 종료 확인" : "캐시 정리 전 종료 확인"}</strong>
        <small>
          {status.displayName} 관리 세션 {pending.counts.chatCount}개, 관리 터미널 {pending.counts.terminalCount}개,
          외부 실행 프로세스 {pending.counts.externalProcessCount}개를 모두 종료한 뒤
          {pending.kind === "update" ? ` ${status.updateCommandLabel ?? "업데이트"}를 실행합니다.` : " 모델 캐시를 정리합니다."}
          {" "}정상 종료가 실패하면 강제 종료하며, 진행 중 응답·승인 요청은 복구되지 않을 수 있습니다. 대화 이력, 인증, 설정은 삭제하지 않습니다.
        </small>
      </span>
      <div className="account-switch-confirm-actions">
        <button className="button compact" type="button" disabled={Boolean(busyKey)} onClick={onCancelPending} autoFocus>취소</button>
        <button className="button compact primary" type="button" disabled={Boolean(busyKey)} onClick={onConfirmPending}>확인</button>
      </div>
    </div>}
    {notices[`update-${status.provider}`] && <p className="account-action-notice" role="status">{notices[`update-${status.provider}`]}</p>}
    {errors[`update-${status.provider}`] && <ErrorBanner message={errors[`update-${status.provider}`]} />}
    {errors[`check-${status.provider}`] && <ErrorBanner message={errors[`check-${status.provider}`]} />}
    {notices[`cache-${status.provider}`] && <p className="account-action-notice" role="status">{notices[`cache-${status.provider}`]}</p>}
    {errors[`cache-${status.provider}`] && <ErrorBanner message={errors[`cache-${status.provider}`]} />}
  </div>;
}

function ProviderAutoSwitchNote({ accounts, event }: { accounts: ProviderAccountView[]; event: AutoSwitchEventView }) {
  const summary = autoSwitchEventSummary(accounts, event);
  return <p className="provider-auto-switch-note"><Repeat size={12} aria-hidden="true" />자동전환됨: {summary.transition} · {new Date(event.at).toLocaleString()}{summary.resumedNote}</p>;
}

/** 계정 행 아이콘에 쓰는 도구 아이콘 자산. 디자인 시스템의 lucide 세트만 쓴다. */
const accountToolIcons: Record<AccountToolIconName, LucideIcon> = {
  atlassian: Waypoints,
  browser: Globe,
  calendar: Calendar,
  cloud: Cloud,
  code: Code,
  connector: Cable,
  database: Database,
  design: PenTool,
  document: FileText,
  folder: FolderClosed,
  mail: Mail,
  mcp: Plug,
  monitor: MonitorCog,
  notebook: NotebookText,
  payment: CreditCard,
  plugin: Blocks,
  presentation: Presentation,
  repository: GitBranch,
  search: Search,
  site: LayoutTemplate,
  spreadsheet: Table2,
  team: Users,
  terminal: SquareTerminal,
  visualize: ChartPie,
};

/** 사용량 창 미터. 등록 계정 행과 홈 계정 카드가 같은 눈금을 쓴다. */
function UsageMeters({ usage, now }: { usage: AccountUsageView; now: number }) {
  const windows = displayUsageWindows(usage.windows, now);
  if (windows.length === 0) return null;
  return <ul className="account-usage-meters">
    {windows.map((window) => {
      const percent = Math.min(100, Math.max(0, window.usedPercent));
      const unavailable = usageWindowValueUnavailable(usage, window);
      return <li className={usageLevel(percent)} key={window.label}>
        <span><em>{window.label}</em><b>{unavailable ? "확인 불가" : `${Math.round(percent)}%`}</b></span>
        <div className="progress" role="img" aria-label={unavailable ? `${window.label} 사용량 확인 불가` : `${window.label} 사용량 ${Math.round(percent)}%`}><span style={{ width: `${unavailable ? 0 : percent}%` }} /></div>
        {window.resetsAt !== null && <small>{new Date(window.resetsAt).toLocaleString()} {unavailable ? "초기화 후 갱신 실패" : window.resetElapsed ? "초기화됨" : "초기화"}</small>}
      </li>;
    })}
  </ul>;
}

/**
 * Antigravity 사용량 카드.
 *
 * 이 공급자는 계정 레지스트리에 없어 계정 행이 하나도 없다. 그래서 사용량을 붙일 자리가
 * 없었고 설정 화면에는 CLI 탐지 여부만 남았다. 값은 실행 중인 language server가 들고
 * 있으므로 계정 목록과 따로 읽어 여기에 붙인다.
 *
 * 모델 창이 열한 개인데 계열끼리 쿼터를 공유해 같은 값이 줄줄이 늘어선다. 그래서 계정
 * 대표 창만 펼쳐 두고 모델별 창은 접어 둔다 — 어느 계열이 얼마나 남았는지는 대표 창으로
 * 충분하고, 모델별 구분이 필요할 때만 펼치면 된다.
 */
function AntigravityUsageCard({
  usage,
  loading,
  onRefresh,
  text,
}: {
  usage: AccountUsageView | null;
  loading: boolean;
  onRefresh: () => void;
  text: (ko: string, en: string) => string;
}) {
  const [showModels, setShowModels] = useState(false);
  const now = Date.now();
  const windows = usage ? displayUsageWindows(usage.windows, now) : [];
  const summary = windows.find((window) => !window.modelScoped) ?? null;
  const models = windows.filter((window) => window.modelScoped);
  const unread = usage === null;
  const idle = usage?.status === "idle";
  return <section className="provider-usage-card">
    <header>
      <span className="provider-usage-heading">
        <strong>{text("사용량", "Usage")}</strong>
        {usage?.updatedAt !== null && usage?.updatedAt !== undefined && <small className="provider-usage-updated">
          {text("확인 시각", "Checked")} {new Date(usage.updatedAt).toLocaleString()}
        </small>}
      </span>
      <button className="button compact" type="button" onClick={onRefresh} disabled={loading}>
        <RefreshCw size={13} aria-hidden="true" />
        {loading ? text("확인 중…", "Checking…") : text("새로고침", "Refresh")}
      </button>
    </header>
    {unread && !loading && <p className="provider-account-empty">{text("아직 확인하지 않았습니다.", "Not checked yet.")}</p>}
    {idle && <p className="provider-account-empty">
      {text(
        "Antigravity language server가 실행 중이 아니어서 사용량을 읽을 수 없습니다. 회차나 IDE가 도는 동안 다시 확인하세요.",
        "The Antigravity language server is not running, so usage cannot be read. Check again while a round or the IDE is running.",
      )}
    </p>}
    {usage?.status === "error" && <ErrorBanner message={usage.error ?? text("사용량을 읽지 못했습니다.", "Could not read usage.")} />}
    {usage?.status === "ok" && summary && <>
      <UsageMeters usage={{ ...usage, windows: usage.windows.filter((window) => !window.modelScoped) }} now={now} />
      {models.length > 0 && <>
        <button
          className="provider-model-usage-toggle"
          type="button"
          aria-expanded={showModels}
          aria-controls="antigravity-model-usage"
          onClick={() => setShowModels((open) => !open)}
        >
          <span>
            {showModels ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
            <strong>{text("모델별 사용량", "Usage by model")}</strong>
          </span>
          <em>{models.length}{text("개", "")}</em>
        </button>
        {showModels && <div className="provider-model-usage-panel" id="antigravity-model-usage">
          <UsageMeters usage={{ ...usage, windows: usage.windows.filter((window) => window.modelScoped) }} now={now} />
        </div>}
      </>}
    </>}
  </section>;
}

/**
 * 계정에서 쓸 수 있는 외부 도구를 아이콘만으로 나열한다. 연결 상태 문구는 붙이지
 * 않고, 확인하지 못한 항목만 흐리게 구분한다. 맨 앞 눈 아이콘으로 상세정보를 켜면
 * 접혀 있던 항목까지 아이콘과 도구 이름을 함께 펼친다.
 */
function AccountToolBadges({ tools }: { tools: AccountToolBadgeSource | null }) {
  const [detailed, setDetailed] = useState(false);
  // 상세정보를 켠 동안에는 개수 제한을 풀어 모든 도구를 보여 준다.
  const { badges, overflow } = accountToolBadges(tools, detailed ? 0 : DEFAULT_ACCOUNT_TOOL_BADGE_LIMIT);
  if (badges.length === 0) return null;
  return <span className={`provider-account-tools${detailed ? " detailed" : ""}`} aria-label="이 계정에서 사용할 수 있는 도구">
    <button
      className={`provider-account-tool toggle${detailed ? " active" : ""}`}
      type="button"
      aria-pressed={detailed}
      aria-label={detailed ? "도구 상세정보 숨기기" : "도구 상세정보 표시"}
      title={detailed ? "도구 이름을 숨기고 아이콘만 봅니다" : "아이콘과 도구 이름을 모두 봅니다"}
      onClick={() => setDetailed((on) => !on)}
    >{detailed ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}</button>
    {badges.map((badge) => {
      const Icon = accountToolIcons[badge.icon];
      return <span className={`provider-account-tool${badge.unverified ? " unverified" : ""}`} key={badge.key} title={badge.label}>
        <Icon size={13} aria-hidden="true" />
        <em>{badge.label}</em>
      </span>;
    })}
    {overflow > 0 && <span className="provider-account-tool more" title={`외 ${overflow}개`}>+{overflow}</span>}
  </span>;
}

/** 공유 CLI 홈에 실제로 든 로그인. 관측만 하는 자리라 실행·전환 동작이 없고, 등록 계정
 *  상자와 구분되는 점선 상자로 그린다. */
function ProviderHomeCard({ provider, home, accounts, tools }: { provider: ProviderId; home: ProviderHomeView | undefined; accounts: ProviderAccountView[]; tools: ProviderHomeToolsView | null }) {
  const { text } = useI18n();
  const now = Date.now();
  const summary = homeAccountSummary(provider, home, accounts, now, text);
  const usageNote = homeUsageNote(home, text);
  return <div className={`provider-home-card ${summary.tone}`}>
    <KeyRound size={15} aria-hidden="true" />
    <span>
      <em>{text("홈 계정 · 공유 CLI 홈", "Home account · shared CLI home")}</em>
      <strong title={summary.title}>{summary.title}</strong>
      <small>{summary.detail}</small>
      {/* 도구는 공유 홈의 설정을 그대로 읽은 것이라 이 카드가 원 소유자다. 계정 단위
          항목은 홈 신원을 확인했을 때만 또렷하게 붙는다(그 판정은 Core가 한다). */}
      <AccountToolBadges tools={tools} />
      {home && home.state === "verified" && <div className="provider-home-usage">
        <UsageMeters usage={home.usage} now={now} />
        {usageNote && <small className={usageNote.tone === "error" ? "error" : undefined}>{usageNote.note}</small>}
      </div>}
    </span>
  </div>;
}

// 표시 이름과 메모 편집기는 같은 뼈대를 쓴다: 열 때 저장값을 초안으로 복사하고,
// 저장 중에는 닫지 않으며, 저장 결과가 닫으라고 할 때만 초안을 비운다. 두 벌로 두면
// 한쪽만 고쳐 동작이 갈리므로 초안 상태를 이 훅 하나로 모은다.
function useAccountDraftEditor(
  saving: boolean,
  initialDraft: () => string,
  submit: (draft: string) => Promise<{ close: boolean; error: string | null }>,
) {
  // null이면 편집 대화상자가 닫힌 상태다.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return {
    draft,
    error,
    setDraft: (value: string) => setDraft(value),
    open: () => { setError(null); setDraft(initialDraft()); },
    close: () => { if (!saving) { setDraft(null); setError(null); } },
    save: async () => {
      const result = await submit(draft ?? "");
      setError(result.error);
      if (result.close) setDraft(null);
    },
  };
}

// 두 편집기의 바닥줄은 글자 수 표시와 취소·저장 버튼으로 모양이 같고, 저장 버튼 문구와
// 글자 수 상한만 다르다.
function AccountDraftFooter({ state, maxChars, saving, saveLabel, onCancel, onSave }: {
  state: { length: number; tooLong: boolean; canSave: boolean };
  maxChars: number;
  saving: boolean;
  saveLabel: string;
  onCancel: () => void;
  onSave: () => Promise<void>;
}) {
  return <div className="account-note-actions">
    <small className={state.tooLong ? "error" : ""}>{state.tooLong
      ? `${maxChars}자까지 저장할 수 있습니다 (현재 ${state.length}자)`
      : `${state.length}/${maxChars}자`}</small>
    <button className="button" type="button" disabled={saving} onClick={onCancel}>취소</button>
    <button className="button primary" type="button" disabled={saving || !state.canSave} onClick={() => void onSave()}>{saving ? "저장 중…" : saveLabel}</button>
  </div>;
}

function ProviderAccountRow({ account, tools, editable, busyKey, autoSwitchPolicy, onActivate, onRevalidate, onReauthenticate, onToggleDisabled, onToggleAutoSwitch, onChangePriority, onDelete, onRefreshUsage, onConsumeResetCredit, onSaveNote, onSaveLabel }: {
  account: ProviderAccountView;
  tools: AccountToolsView | null;
  editable: boolean;
  busyKey: string | null;
  autoSwitchPolicy: AutoSwitchPolicy;
  onActivate: () => void;
  onRevalidate: () => void;
  onReauthenticate: () => void;
  onToggleDisabled: () => void;
  onToggleAutoSwitch: () => void;
  onChangePriority: (priority: number | null) => void;
  onDelete: () => void;
  onRefreshUsage: () => void;
  onConsumeResetCredit: () => void;
  onSaveNote: (note: string | null) => Promise<string | null>;
  onSaveLabel: (label: string | null) => Promise<string | null>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const busy = busyKey !== null;
  const refreshing = busyKey === `usage-${account.id}`;
  const consumingCredit = busyKey === `reset-credit-${account.id}`;
  const resetCredits = account.usage.resetCredits ?? null;
  // 기본 계정 변경은 사용량 재조회까지 포함해 1초쯤 걸린다. 그 사이 버튼이 눌린 티가
  // 나지 않으면 다시 누르려 하므로 진행 중임을 적는다.
  const activating = busyKey === `active-${account.id}`;
  const savingNote = busyKey === `note-${account.id}`;
  const savingLabel = busyKey === `label-${account.id}`;
  const labelEditor = useAccountDraftEditor(savingLabel, () => account.label ?? account.providerDisplayName,
    (draft) => submitAccountLabel(draft, account.label, onSaveLabel));
  const noteEditor = useAccountDraftEditor(savingNote, () => account.note ?? "",
    (draft) => submitAccountNote(draft, account.note, onSaveNote));
  const labelDraft = labelEditor.draft;
  const noteDraft = noteEditor.draft;
  const noteState = accountNoteDraftState(noteDraft ?? "", account.note);
  const labelState = accountLabelDraftState(labelDraft ?? "", account.label);
  const now = Date.now();
  const windows = displayUsageWindows(account.usage.windows, now);
  const resetElapsed = windows.some((window) => window.resetElapsed);
  const authFailed = account.authStatus !== "ready";
  // 기본 계정과 이 계정으로 실행 중인 런타임만 삭제를 막는다. 다른 계정의 런타임은
  // 무관하다 — 자격증명이 계정별로 갈려 있다.
  const canDelete = !account.isActive && account.runtimeCount === 0;
  const usageDisplay = accountUsageDisplayState(account, now);
  const usageRetryAt = usageDisplay.retryBlockedUntil;
  // 격리 실패만 표시한다. 실패 사유가 없는데 격리가 꺼져 있는 건 아직 프로브를 돌리지
  // 않았다는 뜻뿐이고, 판정은 프로세스 메모리에만 있어 백엔드를 다시 띄우면 이미 격리된
  // 계정까지 전부 그 상태가 된다. 그런 값으로 배지를 달면 사실과 다른 경고만 남는다.
  const isolationFallback = !account.credentialIsolated && account.credentialIsolationNote !== null;
  const hasBadges = account.isActive || account.disabled || account.autoSwitch || authFailed || isolationFallback;
  // 기본 계정 지정은 자주 쓰는 동작이 아니라 관리 메뉴 안에 둔다. 지금 기본 계정인지는
  // '기본 계정' 배지가 알리고, 메뉴 항목은 그 상태에서 비활성으로 남는다.
  const activationTitle = account.isActive
    ? "이미 기본 계정입니다"
    : account.disabled
      ? "비활성 계정은 기본 계정으로 지정할 수 없습니다. 먼저 활성화하세요"
      : authFailed
        ? "재인증이 필요한 계정은 기본 계정으로 지정할 수 없습니다"
        : "이 계정을 새 채팅·터미널의 기본 실행 계정으로 지정합니다. 자격증명은 바뀌지 않고 실행 중인 세션도 그대로입니다";
  useEscapeToClose(() => setMenuOpen(false), menuOpen);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOutside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [menuOpen]);
  const deleteHint = canDelete
    ? "계정 등록과 자격증명을 삭제합니다"
    : account.runtimeCount > 0
      ? "이 계정으로 실행 중인 런타임이 있어 삭제할 수 없습니다"
      : "기본 계정은 삭제할 수 없습니다. 먼저 다른 계정을 기본으로 선택하세요";
  const runMenuAction = (action: () => void) => { setMenuOpen(false); action(); };
  // 한도 재시도 시각 전에는 버튼이 비활성이지만, 어떤 경로로 눌리더라도 갱신 요청을 만들지 않는다.
  const requestUsageRefresh = () => { if (usageDisplay.canRefresh) onRefreshUsage(); };
  return <div className={`provider-account-row${account.disabled ? " disabled" : ""}${authFailed ? " needs-auth" : ""}${account.isActive ? " is-active" : ""}`}>
    <div className="provider-account-head">
      <span className="provider-account-identity"><strong>{account.displayName}</strong><small>{[account.email, account.organization].filter(Boolean).join(" · ") || account.providerAccountId}</small></span>
      {hasBadges && <span className="provider-account-badges">{account.isActive && <em className="health ready">기본 계정</em>}{account.disabled && <em className="health muted">비활성</em>}{account.autoSwitch && <em className="health muted">자동전환</em>}{authFailed && <em className="health warning">재인증 필요</em>}{isolationFallback && <em className="health warning" title={account.credentialIsolationNote ?? undefined}>격리 실패</em>}</span>}
      {editable && <div className="provider-account-controls">
        {activating && <span className="provider-account-activating" role="status" title="기본 계정을 바꾸고 있습니다"><LoaderCircle size={13} className="spin" aria-hidden="true" />변경 중…</span>}
        <div className="account-menu" ref={menuRef}>
          <button className={`icon-button compact${menuOpen ? " active" : ""}`} type="button" disabled={busy} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="계정 관리 메뉴" title="계정 관리" onClick={() => setMenuOpen((open) => !open)}><Settings size={13} /></button>
          {menuOpen && <div className="account-menu-panel" role="menu" aria-label={`${account.displayName} 계정 관리`}>
            <button type="button" role="menuitem" disabled={busy || account.isActive || account.disabled || authFailed} title={activationTitle} onClick={() => runMenuAction(onActivate)}><CircleCheck size={13} aria-hidden="true" />기본계정설정</button>
            <span className="account-menu-divider" role="separator" />
            <button type="button" role="menuitem" disabled={busy} title="목록에 보일 이름을 직접 정합니다. 같은 이름을 쓰는 계정을 구분할 때 씁니다" onClick={() => runMenuAction(labelEditor.open)}><PenLine size={13} aria-hidden="true" />표시 이름 변경</button>
            {!authFailed && <button type="button" role="menuitem" disabled={busy} title="공급자 CLI 로그인을 다시 실행합니다" onClick={() => runMenuAction(onReauthenticate)}><KeyRound size={13} aria-hidden="true" />재인증</button>}
            <button type="button" role="menuitem" disabled={busy || account.isActive} title={account.isActive ? "기본 계정은 비활성화할 수 없습니다. 먼저 다른 계정을 기본으로 선택하세요" : undefined} onClick={() => runMenuAction(onToggleDisabled)}>{account.disabled ? <><Power size={13} aria-hidden="true" />활성화</> : <><PowerOff size={13} aria-hidden="true" />비활성화</>}</button>
            <button type="button" role="menuitem" disabled={busy || account.disabled} title="사용량 100% 도달 또는 에이전트의 제한 응답 시 한도에 걸린 세션을 자동전환이 켜진 다른 계정으로 옮기고, 기본 계정이면 기본 계정도 함께 바꿉니다" onClick={() => runMenuAction(onToggleAutoSwitch)}><Repeat size={13} aria-hidden="true" />{account.autoSwitch ? "자동전환 끄기" : "자동전환 켜기"}</button>
            {autoSwitchPolicy === "priority" && <label className="account-menu-priority">
              <span>페일오버 우선순위</span>
              <input
                type="number"
                min={1}
                max={999}
                inputMode="numeric"
                placeholder="미지정"
                aria-label={`${account.displayName} 페일오버 우선순위`}
                defaultValue={account.autoSwitchPriority ?? ""}
                disabled={busy}
                onBlur={(event) => {
                  const raw = event.target.value.trim();
                  const next = raw === "" ? null : Number.parseInt(raw, 10);
                  if (next !== null && (Number.isNaN(next) || next < 1 || next > 999)) return;
                  if (next === (account.autoSwitchPriority ?? null)) return;
                  onChangePriority(next);
                }}
              />
            </label>}
            <button type="button" role="menuitem" disabled={busy} title="이 계정에만 남는 메모입니다. 계정 등록을 삭제하면 함께 지워집니다" onClick={() => runMenuAction(noteEditor.open)}><NotebookText size={13} aria-hidden="true" />{account.note ? "메모 편집" : "메모 추가"}</button>
            <span className="account-menu-divider" role="separator" />
            <button className="danger" type="button" role="menuitem" disabled={busy || !canDelete} title={deleteHint} onClick={() => runMenuAction(onDelete)}><Trash2 size={13} aria-hidden="true" />삭제</button>
          </div>}
        </div>
      </div>}
    </div>
    <AccountToolBadges tools={tools} />
    {account.note && <p className="provider-account-note"><NotebookText size={13} aria-hidden="true" /><span>{account.note}</span></p>}
    {labelDraft !== null && <Modal
      title={<><PenLine size={16} aria-hidden="true" /><span>표시 이름 변경</span></>}
      onClose={labelEditor.close}
      footer={<AccountDraftFooter
        state={labelState}
        maxChars={ACCOUNT_LABEL_MAX_CHARS}
        saving={savingLabel}
        saveLabel={labelState.restores ? "공급자 이름으로" : "저장"}
        onCancel={labelEditor.close}
        onSave={labelEditor.save}
      />}
    >
      <input
        className="account-label-input"
        type="text"
        value={labelDraft}
        disabled={savingLabel}
        placeholder={account.providerDisplayName}
        aria-label="계정 표시 이름"
        autoFocus
        onChange={(event) => labelEditor.setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && labelState.canSave && !savingLabel) { event.preventDefault(); void labelEditor.save(); } }}
      />
      <dl className="account-label-facts">
        <div><dt>공급자 이름</dt><dd>{account.providerDisplayName}</dd></div>
        {account.email && <div><dt>이메일</dt><dd>{account.email}</dd></div>}
        {account.organization && <div><dt>조직</dt><dd>{account.organization}</dd></div>}
        <div><dt>계정 ID</dt><dd><code>{account.providerAccountId}</code></dd></div>
      </dl>
      <p className="account-note-hint">이 이름은 Agent Manager 목록에만 쓰입니다. 공급자 계정 자체는 바뀌지 않으며, 로그인을 다시 조회해도 덮이지 않습니다. 비우고 저장하면 공급자가 알려 준 이름으로 되돌아갑니다.</p>
      {labelEditor.error && <ErrorBanner message={labelEditor.error} />}
    </Modal>}
    {noteDraft !== null && <Modal
      title={<><NotebookText size={16} aria-hidden="true" /><span>{account.displayName} 메모</span></>}
      onClose={noteEditor.close}
      footer={<AccountDraftFooter
        state={noteState}
        maxChars={ACCOUNT_NOTE_MAX_CHARS}
        saving={savingNote}
        saveLabel={noteState.removes ? "메모 삭제" : "저장"}
        onCancel={noteEditor.close}
        onSave={noteEditor.save}
      />}
    >
      <textarea
        className="account-note-input"
        value={noteDraft}
        rows={7}
        disabled={savingNote}
        placeholder="이 계정을 구분할 메모를 남기세요. 비우고 저장하면 메모를 삭제합니다."
        aria-label={`${account.displayName} 계정 메모`}
        autoFocus
        onChange={(event) => noteEditor.setDraft(event.target.value)}
      />
      <p className="account-note-hint">메모는 이 계정에만 저장되며 공급자 히스토리나 자격증명에는 남지 않습니다. 계정 등록을 삭제하면 함께 지워집니다.</p>
      {noteEditor.error && <ErrorBanner message={noteEditor.error} />}
    </Modal>}
    <div className="provider-account-usage">
      <div className="account-usage-head">
        <strong>사용량</strong>
        <button className={`icon-button compact${refreshing ? " busy" : ""}`} type="button" disabled={busy || !usageDisplay.canRefresh} aria-label="사용량 새로고침" title={usageRetryAt !== null
          ? `사용량 한도로 지금은 갱신하지 않습니다. ${new Date(usageRetryAt).toLocaleString()} 이후 갱신할 수 있습니다`
          : usageDisplay.canRefresh ? "사용량 새로고침" : "중지되었거나 재인증이 필요한 계정은 조회하지 않습니다"} onClick={requestUsageRefresh}><RefreshCw size={13} /></button>
        {usageRetryAt !== null && <em className="account-usage-retry" role="status">{new Date(usageRetryAt).toLocaleString()} 이후 갱신 가능</em>}
      </div>
      <UsageMeters usage={account.usage} now={now} />
      {/* 소진된 창을 즉시 되돌리는 크레딧. 장수가 한정돼 있고 만료가 있어서, 남은 장수와
          가장 이른 만료를 함께 적고 실제 사용은 확인을 한 번 받는다. 한도를 충분히 쓰지
          않았으면 공급자가 물리므로 그 판정은 눌러 봐야 안다. */}
      {resetCredits !== null && resetCredits.availableCount > 0 && <div className="account-reset-credits">
        <span>
          <Ticket size={13} aria-hidden="true" />
          <strong>한도 리셋 {resetCredits.availableCount}장</strong>
          {resetCredits.nextExpiresAt !== null && <em>{new Date(resetCredits.nextExpiresAt).toLocaleDateString()} 만료</em>}
        </span>
        {editable && <button
          className="button compact"
          type="button"
          disabled={busy}
          title={resetCredits.title ?? "소진된 사용량 창을 즉시 되돌립니다"}
          onClick={onConsumeResetCredit}
        >{consumingCredit ? "초기화 중…" : "지금 사용"}</button>}
      </div>}
      {/* 조회에 실패해도 마지막 성공 수치가 있으면 오류 문구로 갈아치우지 않는다.
          기준 시각으로 낡음을 알리고, 실패 사유는 도움말로만 남긴다. */}
      <small className={`account-usage-note${usageDisplay.error ? " error" : ""}`} title={usageDisplay.staleError ?? undefined}>{usageDisplay.error
        ?? (usageDisplay.staleError !== null && account.usage.updatedAt !== null
          ? `${new Date(account.usage.updatedAt).toLocaleString()} 기준 · 갱신에 실패해 마지막 조회 값을 유지합니다`
          : usageDisplay.cached && account.usage.updatedAt !== null
            ? `${new Date(account.usage.updatedAt).toLocaleString()} 마지막 성공 조회 · ${resetElapsed ? "초기화 시간 경과로 0% 표시" : "중지·재인증 상태라 갱신하지 않습니다"}`
            : account.usage.updatedAt !== null
              ? `${new Date(account.usage.updatedAt).toLocaleString()} 기준`
              : "아직 조회하지 않았습니다. 새로고침으로 사용량을 확인하세요.")}</small>
    </div>
    {authFailed && <div className="account-auth-alert" role="alert">
      <ShieldAlert size={15} aria-hidden="true" />
      <span><strong>{account.authStatus === "missing" ? "보안 저장소에서 자격증명을 찾지 못했습니다" : "저장된 자격증명을 사용할 수 없습니다"}</strong><small>재인증을 완료해야 이 계정으로 실행하고 사용량을 조회할 수 있습니다.</small></span>
      {editable && <div className="account-auth-actions">
        <button className="button compact" type="button" disabled={busy} onClick={onRevalidate}>저장 자격증명 확인</button>
        <button className="button compact" type="button" disabled={busy} onClick={onReauthenticate}>재인증</button>
      </div>}
    </div>}
  </div>;
}

// 시스템 설정은 중메뉴 탭별로 필요한 구획만 그린다. 번역 진행 상태와 저장
// 상태를 구획끼리 공유하므로 컴포넌트는 하나로 두고 렌더 대상만 나눈다.
function SystemAutomationSettingsCard({ active, sections, providers, accounts, onAccountsChange, onConnectCli, models, automation, onChange, showSystemAgentNotice, onCloseSystemAgentNotice }: {
  active: boolean;
  sections: SystemSectionId[];
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  onAccountsChange: (snapshot: AccountSnapshot) => void;
  onConnectCli: (provider: ProviderStatus) => void;
  models: ModelOption[];
  automation: SystemAutomationSnapshot | null;
  onChange: (snapshot: SystemAutomationSnapshot) => void;
  showSystemAgentNotice: boolean;
  onCloseSystemAgentNotice: () => void;
}) {
  const { locale, text } = useI18n();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuError, setMenuError] = useState<{ menu: TranslationMenu; message: string } | null>(null);
  const [pendingMenu, setPendingMenu] = useState<TranslationMenu | null>(null);
  const [pendingReset, setPendingReset] = useState<TranslationMenu | null>(null);
  const [addingLanguage, setAddingLanguage] = useState(false);
  const [additionalLanguageCode, setAdditionalLanguageCode] = useState("");
  const [languageError, setLanguageError] = useState<string | null>(null);
  const availableAdditionalLanguages = useMemo(() => {
    if (!automation || automation.settings.additionalTranslationLanguages.length >= 24) return [];
    const knownCodes = new Set([
      ...builtInTranslationLanguages.map((language) => language.code),
      ...automation.settings.additionalTranslationLanguages.map((language) => language.code),
    ]);
    return commonTranslationLanguages.filter((language) => !knownCodes.has(language.code));
  }, [automation]);

  // 실행설정을 함께 편집할 수 있는 시스템 에이전트. 고르지 않았거나 더 이상 쓸 수 없는
  // 공급자가 저장돼 있으면 AIA 자체가 꺼지므로 실행설정도 보여 주지 않는다.
  const selectedSystemProvider = aiaRuntimeProvider(automation);

  const save = async (patch: Partial<SystemAutomationSnapshot["settings"]>): Promise<boolean> => {
    if (!automation || saving) return false;
    const next = {
      ...automation.settings,
      ...patch,
      translations: patch.translations ?? automation.settings.translations,
    };
    setSaving(true);
    setError(null);
    setMenuError(null);
    setPendingMenu(null);
    try {
      onChange(await setSystemAutomationSettings(next));
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const addLanguage = async () => {
    if (!automation) return;
    const language = availableAdditionalLanguages.find((item) => item.code === additionalLanguageCode)
      ?? availableAdditionalLanguages[0];
    if (!language) {
      setLanguageError(text("추가할 수 있는 언어를 모두 등록했습니다.", "All available languages have already been added."));
      return;
    }
    const saved = await save({
      additionalTranslationLanguages: [
        ...automation.settings.additionalTranslationLanguages,
        { code: language.code, name: language.name },
      ],
    });
    if (saved) {
      setAddingLanguage(false);
      setAdditionalLanguageCode("");
      setLanguageError(null);
    }
  };

  const removeLanguage = async (language: TranslationLanguage) => {
    if (!automation) return;
    if (automation.settings.language.code === language.code || automation.pendingLanguage?.code === language.code) {
      setLanguageError(text("현재 사용 중인 언어는 다른 번역 언어를 선택한 뒤 삭제하세요.", "Select another translation language before removing the active one."));
      return;
    }
    setLanguageError(null);
    await save({
      additionalTranslationLanguages: automation.settings.additionalTranslationLanguages.filter((item) => item.code !== language.code),
    });
  };

  // 번역 조작 다섯 벌은 저장 중 표시·오류 자리 비우기·새 스냅숏 반영·실패 표시가 모두
  // 같고, 실패를 어느 오류 자리에 담는지와 성공 뒤 처리만 다르다.
  const runTranslationTask = async (
    request: () => Promise<SystemAutomationSnapshot>,
    fail: (message: string | null) => void,
    onDone?: () => void,
  ) => {
    setSaving(true);
    fail(null);
    try {
      onChange(await request());
      onDone?.();
    } catch (cause) {
      fail(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const changeLanguage = async (code: string) => {
    if (!automation || saving) return;
    const languages = [...builtInTranslationLanguages, ...automation.settings.additionalTranslationLanguages];
    const language = languages.find((item) => item.code === code);
    if (!language) return;
    setError(null);
    await runTranslationTask(() => requestSystemLanguage({ language, catalog: getUiTranslationCatalog() }), setLanguageError);
  };

  const retryUi = async () => { await runTranslationTask(retryUiTranslation, setLanguageError); };

  const cancelUi = async () => { await runTranslationTask(cancelUiTranslation, setLanguageError); };

  const setMenu = async (menu: TranslationMenu, enabled: boolean) => {
    if (!automation) return;
    setMenuError(null);
    if (enabled && !automation.settings.systemProvider) {
      setPendingMenu(null);
      setMenuError({
        menu,
        message: text("먼저 CLI가 연결된 시스템 에이전트를 선택하세요.", "Select a connected system agent first."),
      });
      return;
    }
    if (enabled && !automation.settings.translations[menu]) {
      setPendingMenu(menu);
      return;
    }
    setPendingMenu(null);
    await save({ translations: { ...automation.settings.translations, [menu]: enabled } });
  };

  const confirmMenu = async (menu: TranslationMenu) => {
    if (!automation || pendingMenu !== menu) return;
    await save({ translations: { ...automation.settings.translations, [menu]: true } });
  };

  const retry = async (menu: TranslationMenu) => {
    await runTranslationTask(() => retryMenuTranslation(menu), setError);
  };

  // 저장된 번역을 버리는 유일한 조작이므로 한 번 더 확인받는다.
  const reset = async (menu: TranslationMenu) => {
    await runTranslationTask(() => resetMenuTranslation(menu), setError, () => setPendingReset(null));
  };

  return (
    <section className="settings-card system-automation-card">
      <div className="settings-card-sections system-automation-body">
        {sections.includes("cli") && <CliConnectionSettingsSection active={active} providers={providers} accounts={accounts} onAccountsChange={onAccountsChange} onConnect={onConnectCli} />}
        {sections.includes("agent") && <section className={`settings-subsection system-agent-section${showSystemAgentNotice ? " attention" : ""}`} data-ui-anchor="settings.system-agent">
          {showSystemAgentNotice && <div className="system-agent-settings-notice" role="status">
            <span><strong>{text("AIA를 사용하려면 시스템 에이전트를 설정하세요.", "Choose a system agent to use AIA.")}</strong><small>{text("아래에서 연결된 CLI를 선택하면 AIA가 바로 활성화됩니다.", "Select a connected CLI below to enable AIA immediately.")}</small></span>
            <button type="button" aria-label={text("안내 닫기", "Close notice")} title={text("닫기", "Close")} onClick={onCloseSystemAgentNotice}><X size={14} /></button>
          </div>}
          <header><div><strong>{text("시스템 에이전트", "System agent")}<HelpHint
            label={text("시스템 에이전트 변경 동작 설명", "What happens when the system agent changes")}
            title={text("시스템 에이전트 변경 동작", "What happens when the system agent changes")}
          >{text("바꾸면 AIA가 즉시 새 공급자로 다시 시작합니다.", "Changing it restarts AIA on the new provider.")}</HelpHint></strong><small>{text("AIA 실행과 UI·콘텐츠 자동번역에 사용할 연결된 CLI를 선택합니다.", "Choose the connected CLI that runs AIA and translates UI and content.")}</small></div></header>
          {!automation ? <div className="settings-inline-loading">{text("시스템 자동화 설정을 불러오는 중…", "Loading system automation settings…")}</div> : (
            <div className="system-provider-list" role="radiogroup" aria-label={text("시스템 에이전트", "System agent")}>
              <button type="button" role="radio" aria-checked={!automation.settings.systemProvider} className={!automation.settings.systemProvider ? "selected" : ""} disabled={saving} onClick={() => void save({ systemProvider: null })}><strong>{text("선택 안 함", "None")}</strong><small>{text("AIA를 사용하지 않고 자동번역은 일시중지됩니다", "AIA stays off and automatic translation pauses")}</small></button>
              {automation.providers.filter((provider) => canRunSystemAgent(provider.provider as ProviderId)).map((provider) => {
                const connected = provider.cli.detected;
                const selected = automation.settings.systemProvider === provider.provider;
                return <button type="button" role="radio" aria-checked={selected} className={selected ? "selected" : ""} disabled={saving || !connected} onClick={() => void save({ systemProvider: provider.provider as ProviderId })} key={provider.provider}><strong>{provider.displayName}</strong><small>{connected ? text("CLI 연결됨", "CLI connected") : text("CLI 연결 필요", "CLI connection required")}</small></button>;
              })}
            </div>
          )}
          {automation && selectedSystemProvider && <SystemAgentRuntimeSettings
            provider={selectedSystemProvider}
            providerName={automation.providers.find((provider) => provider.provider === selectedSystemProvider)?.displayName ?? selectedSystemProvider}
            recentModels={models.filter((item) => item.source === selectedSystemProvider)}
            runtimes={automation.settings.systemAgentRuntimes}
            saving={saving}
            onSave={(runtimes) => save({ systemAgentRuntimes: runtimes })}
          />}
        </section>}
        {sections.includes("service") && <RemoteAccessSettings />}
        {sections.includes("language") && <section className="settings-subsection language-settings-section">
          <header><div><strong>{text("언어 및 자동번역", "Language and translation")}</strong><small>{text("UI와 활성 콘텐츠에 함께 사용할 언어를 선택합니다.", "Choose one language for both the UI and enabled content.")}</small></div></header>
          {!automation ? <div className="settings-inline-loading">{text("언어 설정을 불러오는 중…", "Loading language settings…")}</div> : <div className="language-settings-body">
          <div className="system-setting-group vertical translation-language-setting">
            <div className="translation-language-head">
              <div className="system-setting-label"><Languages size={17} /><span><strong>{text("UI·번역 언어", "UI and translation language")}</strong><small>{text("추가 언어 UI는 시스템 에이전트로 번역한 뒤 전환됩니다.", "Additional UI languages switch after the system agent finishes translation.")}</small></span></div>
              <div className="translation-language-actions">
                <select
                  aria-label={text("UI·번역 언어", "UI and translation language")}
                  disabled={saving || automation.uiTranslation.phase === "running"}
                  value={automation.pendingLanguage?.code ?? automation.settings.language.code}
                  onChange={(event) => void changeLanguage(event.target.value)}
                >
                  {[...builtInTranslationLanguages, ...automation.settings.additionalTranslationLanguages].map((language) => <option value={language.code} key={language.code}>{languageDisplayName(language, locale)} ({language.code})</option>)}
                </select>
                <button className="button secondary compact" type="button" disabled={saving || (!addingLanguage && availableAdditionalLanguages.length === 0)} onClick={() => { setAddingLanguage((value) => !value); setAdditionalLanguageCode(availableAdditionalLanguages[0]?.code ?? ""); setLanguageError(null); }}><Plus size={13} />{text("언어 추가", "Add language")}</button>
              </div>
            </div>
            {automation.settings.additionalTranslationLanguages.length > 0 && <div className="translation-language-chips" aria-label={text("추가한 언어", "Added languages")}>
              {automation.settings.additionalTranslationLanguages.map((language) => <span data-user-content key={language.code}>{languageDisplayName(language, locale)} <small>{language.code}</small><button type="button" disabled={saving} aria-label={`${languageDisplayName(language, locale)} ${text("삭제", "Delete")}`} onClick={() => void removeLanguage(language)}><X size={12} /></button></span>)}
            </div>}
            {addingLanguage && <form className="translation-language-form" onSubmit={(event) => { event.preventDefault(); void addLanguage(); }}>
              <label><span>{text("추가할 언어", "Language to add")}</span><select aria-label={text("추가할 언어", "Language to add")} value={additionalLanguageCode || availableAdditionalLanguages[0]?.code || ""} disabled={saving || availableAdditionalLanguages.length === 0} onChange={(event) => setAdditionalLanguageCode(event.target.value)}>{availableAdditionalLanguages.map((language) => <option value={language.code} key={language.code}>{locale === "ko" ? language.koreanName : language.name} ({language.code})</option>)}</select></label>
              <div><button className="button secondary compact" type="button" disabled={saving} onClick={() => { setAddingLanguage(false); setLanguageError(null); }}>{text("취소", "Cancel")}</button><button className="button primary compact" type="submit" disabled={saving || availableAdditionalLanguages.length === 0}>{text("추가", "Add")}</button></div>
            </form>}
            {automation.pendingLanguage && <div className={`ui-language-status ${automation.uiTranslation.phase}`} role="status">
              <span><strong>{automation.pendingLanguage.name} ({automation.pendingLanguage.code})</strong><small>{translationStatusText(automation.uiTranslation, locale)}</small></span>
              {automation.uiTranslation.total > 0 && <progress max={automation.uiTranslation.total} value={automation.uiTranslation.completed} />}
              <div>
                {automation.uiTranslation.phase === "error" && <button className="button secondary compact" type="button" disabled={saving} onClick={() => void retryUi()}><RefreshCw size={13} />{text("재시도", "Retry")}</button>}
                <button className="button secondary compact" type="button" disabled={saving} onClick={() => void cancelUi()}>{text("취소", "Cancel")}</button>
              </div>
              {automation.uiTranslation.lastError && <p>{automation.uiTranslation.lastError}</p>}
            </div>}
            <p className="translation-language-note">{automation.settings.translations.skills || automation.settings.translations.agents || automation.settings.translations.artifacts || automation.settings.translations.instructions
              ? text("번역 언어를 바꾸면 활성화된 메뉴를 새 언어로 다시 번역하며 선택한 CLI 사용량이 발생합니다.", "Changing the language retranslates enabled menus and uses the selected CLI quota.")
              : text("언어를 추가한 뒤 목록에서 선택할 수 있습니다.", "Add a language, then select it from the list.")}</p>
            {languageError && <p className="translation-language-error" role="alert">{languageError}</p>}
          </div>
          <div className="translation-toggle-list">
            {(["instructions", "skills", "agents", "artifacts"] as TranslationMenu[]).map((menu) => {
              const status = automation[menu];
              const enabled = automation.settings.translations[menu];
              // 시스템 에이전트가 없으면 켜 둔 설정은 보존한 채 읽기 전용으로 두고,
              // 번역 작업은 백엔드가 일시중지한다.
              const readOnly = !automation.settings.systemProvider;
              const label = menu === "skills" ? text("스킬", "Skills") : menu === "agents" ? text("에이전트", "Agents") : menu === "artifacts" ? text("아티팩트", "Artifacts") : text("지침", "Instructions");
              return <div className={`translation-toggle-row ${status.phase}${enabled ? " enabled" : ""}`} key={menu}>
                <div className="translation-toggle-main">
                  <span><strong>{label}</strong><small>{translationStatusText(status, locale)}</small></span>
                  <div className="translation-toggle-actions">
                    {(status.phase === "partial" || status.phase === "error") && <button className="button secondary compact" type="button" disabled={saving || readOnly} onClick={() => void retry(menu)}><RefreshCw size={13} />{text("재시도", "Retry")}</button>}
                    {status.total > 0 && <button className="button secondary compact" type="button" disabled={saving || readOnly} onClick={() => { setPendingReset(menu); setPendingMenu(null); }}><Eraser size={13} />{text("번역 초기화", "Reset translation")}</button>}
                    <AppToggle checked={enabled} disabled={saving || readOnly} label={label} onChange={(next) => void setMenu(menu, next)} />
                  </div>
                </div>
                {pendingReset === menu && <div className="translation-toggle-confirm" role="alert">
                  <p>{text("저장된 번역을 모두 지우고 처음부터 다시 번역합니다. 선택한 CLI 사용량이 다시 발생합니다.", "Discards every stored translation and translates from scratch, spending the selected CLI quota again.")}</p>
                  <div><button className="button secondary compact" type="button" disabled={saving} onClick={() => setPendingReset(null)}>{text("취소", "Cancel")}</button><button className="button primary compact" type="button" disabled={saving} onClick={() => void reset(menu)}>{text("번역 초기화", "Reset translation")}</button></div>
                </div>}
                {pendingMenu === menu && <div className="translation-toggle-confirm" role="alert">
                  <p>{text("전체 데이터를 백그라운드에서 번역하며 선택한 CLI 사용량이 발생합니다.", "All data will be translated in the background using the selected CLI quota.")}</p>
                  <div><button className="button secondary compact" type="button" disabled={saving} onClick={() => setPendingMenu(null)}>{text("취소", "Cancel")}</button><button className="button primary compact" type="button" disabled={saving} onClick={() => void confirmMenu(menu)}>{text("번역 시작", "Start translation")}</button></div>
                </div>}
                {menuError?.menu === menu && <p role="alert">{menuError.message}</p>}
                {status.lastError && <p title={status.lastError}>{status.lastError}</p>}
              </div>;
            })}
          </div>
          </div>}
        </section>}
      </div>
      {error && <ErrorBanner message={error} />}
    </section>
  );
}

/**
 * 고른 시스템 에이전트의 실행설정. 항목과 선택지는 일반 채팅과 같은 실행설정 스키마
 * (`get_chat_provider_options`)에서 오고, 화면도 새 채팅과 같은 `RuntimeSettings`를 쓴다.
 * 저장은 공급자별로 남으므로 공급자를 바꿔도 각 공급자의 선택이 유지된다.
 */
function SystemAgentRuntimeSettings({ provider, providerName, recentModels, runtimes, saving, onSave }: {
  provider: ProviderId;
  providerName: string;
  // CLI 카탈로그가 빈 공급자(Claude 등)에서도 채팅 메뉴처럼 최근 사용 모델을 고를 수 있게 한다.
  recentModels: ModelOption[];
  // 실행설정 필드가 없는 이전 버전 백엔드 스냅샷에서도 화면이 죽지 않도록 없는 값을 허용한다.
  runtimes: SystemAutomationSettings["systemAgentRuntimes"] | undefined;
  saving: boolean;
  onSave: (runtimes: SystemAutomationSettings["systemAgentRuntimes"]) => Promise<boolean>;
}) {
  const { text } = useI18n();
  const catalog = useProviderOptions(provider);
  // 시스템 자동화 스냅샷은 번역 상태나 CLI 탐지가 바뀌어도 새 객체로 온다. 저장된 실행설정이
  // 실제로 달라질 때만 초안을 되돌려, 편집 중이던 값이 폴링에 지워지지 않게 한다.
  const storedSignature = JSON.stringify(runtimes?.[provider] ?? null);
  const stored = useMemo(() => aiaRuntimeSettings(runtimes, provider), [provider, storedSignature]);
  const [draft, setDraft] = useState<AiaRuntimeSettings>(stored);
  // 저장이 끝나거나 공급자가 바뀌면 저장된 값을 다시 초안으로 삼는다.
  useEffect(() => { setDraft(stored); }, [stored]);
  // 예전에 저장한 선택지가 최신 스키마에서 사라졌으면 안전한 값으로 되돌린다.
  useEffect(() => {
    const fields = settingFieldsFor(catalog, provider);
    setDraft((current) => ({
      ...current,
      mode: normalizeSettingValue(fields, "mode", current.mode) as ChatMode,
      approvalMode: normalizeSettingValue(fields, "approvalMode", current.approvalMode) as ChatApprovalMode,
      settings: normalizeExtraSettings(fields, current.settings),
    }));
  }, [catalog, provider]);
  const pristine = sameAiaRuntimeSettings(draft, stored);
  const model = draft.model ?? "";

  return (
    <div className="system-agent-runtime" data-ui-anchor="settings.system-agent-runtime">
      <div className="system-agent-runtime-head">
        <strong>{text(`${providerName} 실행설정`, `${providerName} run settings`)}<HelpHint
          label={text("AIA 실행설정 적용 범위 설명", "How AIA run settings apply")}
          title={text("AIA 실행설정 적용 범위", "How AIA run settings apply")}
        >{text("AIA 시스템 채팅을 새로 시작할 때 쓰는 권한·승인·판단·모델·추론 설정입니다. 공급자가 지원하는 항목만 표시됩니다.", "Permission, approval, decision, model, and reasoning settings used when a new AIA conversation starts. Only options the provider supports appear here.")}
          {" "}
          {text("저장하면 돌고 있는 AIA 대화를 정지하고 새 설정으로 다시 시작합니다. 진행 중인 작업이나 승인 대기가 있으면 그것이 끝난 뒤에 다시 시작합니다.", "Saving stops the running AIA conversation and restarts it with the new settings. If a turn or approval is in progress, the restart waits until it finishes.")}</HelpHint></strong>
      </div>
      <RuntimeSettings
        source={provider}
        mode={draft.mode}
        onModeChange={(mode) => setDraft((current) => ({ ...current, mode }))}
        approvalMode={draft.approvalMode}
        onApprovalModeChange={(approvalMode) => setDraft((current) => ({ ...current, approvalMode }))}
        decisionPolicy={draft.decisionPolicy}
        onDecisionPolicyChange={(decisionPolicy) => setDraft((current) => ({ ...current, decisionPolicy }))}
        uiClickPolicy={draft.uiClickPolicy}
        onUiClickPolicyChange={(uiClickPolicy) => setDraft((current) => ({ ...current, uiClickPolicy }))}
        model={model}
        onModelChange={(next) => setDraft((current) => ({ ...current, model: next.trim() ? next.trim() : null }))}
        catalog={catalog}
        recent={recentModels}
        reasoningEffort={draft.reasoningEffort ?? ""}
        onReasoningChange={(effort) => setDraft((current) => ({ ...current, reasoningEffort: effort || null }))}
        reasoningOptions={reasoningOptionsFor(catalog, model)}
        defaultEffort={defaultEffortFor(catalog, model)}
        extraSettings={draft.settings}
        onExtraSettingChange={(key, value) => setDraft((current) => ({ ...current, settings: { ...current.settings, [key]: value } }))}
        compact
      />
      <div className="system-agent-runtime-actions">
        <button className="button secondary compact" type="button" disabled={saving || pristine} onClick={() => setDraft(stored)}>{text("변경 취소", "Discard")}</button>
        <button className="button primary compact" type="button" disabled={saving || pristine} onClick={() => void onSave(systemAgentRuntimePatch(runtimes ?? {}, provider, draft))}>{saving ? text("저장 중…", "Saving…") : text("실행설정 저장", "Save run settings")}</button>
      </div>
    </div>
  );
}

function translationStatusText(status: TranslationStatus, locale: AppLocale): string {
  const labels: Record<string, [string, string]> = {
    disabled: ["목록과 상세 내용을 자동번역합니다", "Translates list and detail content"], queued: ["대기 중", "Queued"], running: ["번역 중", "Translating"],
    complete: ["완료", "Complete"], partial: ["일부 실패", "Partially failed"], paused: ["일시중지", "Paused"], error: ["오류", "Error"],
  };
  const label = labels[status.phase] ?? [status.phase, status.phase];
  const segmentCount = status.segmentTotal > status.total
    ? locale === "ko"
      ? ` · 요청 ${status.segmentCompleted + status.segmentFailed}/${status.segmentTotal}`
      : ` · requests ${status.segmentCompleted + status.segmentFailed}/${status.segmentTotal}`
    : "";
  const fieldCount = status.total > 0
    ? locale === "ko"
      ? ` · 항목 ${status.completed + status.failed}/${status.total}`
      : ` · items ${status.completed + status.failed}/${status.total}`
    : "";
  // 캐시를 재사용한 항목은 이번 실행 대상이 아니므로 따로 표시한다.
  const cachedCount = status.cached > 0
    ? locale === "ko" ? ` · 캐시 재사용 ${status.cached}` : ` · reused ${status.cached}`
    : "";
  return `${label[locale === "ko" ? 0 : 1]}${fieldCount}${cachedCount}${segmentCount}`;
}

/// 백엔드 서비스 카드의 토글 행. 강조(enabled 클래스)는 기본적으로 켬 상태를
/// 따르지만, 절전 억제처럼 "켰지만 실제로 걸리지 않은" 상태가 따로 있는 행은
/// highlighted로 실제 동작 여부를 준다.
///
/// `checked`가 null이면 상태 조회가 아직 끝나지 않은(또는 실패한) 것이다. 이때 스위치를
/// 꺼짐으로 그리면 이미 켜진 설정이 꺼진 것처럼 보이고, 누르면 "켜기" 확인까지 뜬다
/// (QA #34). 모르는 값은 false로 그리지 않고 스위치 자리에 확인 중 표식을 둔다.
function BackendServiceToggleRow({ title, help, summary, checked, highlighted, disabled, onChange }: {
  title: string;
  help?: ReactNode;
  summary: string;
  checked: boolean | null;
  highlighted?: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const { text } = useI18n();
  const unknown = checked === null;
  return (
    <div className={`backend-service-toggle${(highlighted ?? checked) ? " enabled" : ""}${unknown ? " pending" : ""}`} data-state={unknown ? "unknown" : checked ? "on" : "off"}>
      <span>
        <strong>{title}{help}</strong>
        <small>{summary}</small>
      </span>
      {unknown
        ? <em className="health muted backend-service-toggle-pending" role="status" aria-label={text(`${title} 상태 확인 중`, `Checking ${title} status`)}>{text("확인 중…", "Checking…")}</em>
        : <AppToggle checked={checked} disabled={disabled} label={title} onChange={onChange} />}
    </div>
  );
}

/**
 * 백엔드 서비스 카드의 경고 상자. 문구 한 줄과 그 아래 버튼 줄이라는 모양이 세 자리
 * (포트 재시작 안내·원격 미허용 안내·Serve 루트 충돌) 모두 같아 여기로 모은다.
 */
function BackendServiceAlert({ message, actions }: { message: string; actions?: ReactNode }) {
  return (
    <div className="backend-service-conflict" role="alert">
      <p>{message}</p>
      {actions && <div>{actions}</div>}
    </div>
  );
}

/**
 * Tailscale 서비스 행의 요약 문구. 오류 → 조회 전 → 사용 불가 → 켜짐 → Serve 루트 충돌 →
 * 꺼짐 순으로, 사용자가 먼저 알아야 할 사정부터 답한다.
 */
function tailscaleSummaryText(
  taskError: string | null,
  tailscale: TailscaleServiceStatus | null,
  text: (ko: string, en: string) => string,
): string {
  if (taskError) return taskError;
  if (!tailscale) return text("Tailscale 상태 확인 중…", "Checking Tailscale status…");
  if (!tailscale.available) return tailscale.error ?? text("Tailscale을 사용할 수 없습니다.", "Tailscale is unavailable.");
  // 읽기 전용 여부는 아래 원격 편집 허용 행이 단독으로 알린다.
  if (tailscale.enabled) return `${text("서비스주소", "Service address")} ${tailscale.url ?? `https://${tailscale.host ?? ""}`}`;
  if (tailscale.conflictTarget) return `${text("다른 서비스가 Serve 루트를 사용 중", "Another service owns the Serve root")}: ${tailscale.conflictTarget}`;
  if (tailscale.host) return `${text("꺼짐 · 켜면", "Off · turns on at")} https://${tailscale.host}`;
  return text("꺼짐", "Off");
}

/** 원격 편집 허용 행의 요약 문구. 현재 권한 상태 뒤에, 이 화면에서 못 바꾸는 경우만 그 사정을 덧붙인다. */
function remoteWriteSummaryText(
  taskError: string | null,
  tailscale: TailscaleServiceStatus | null,
  access: WebAccessStatus | null,
  canManage: boolean,
  text: (ko: string, en: string) => string,
): string {
  if (taskError) return taskError;
  if (!tailscale) return text("설정 확인 중…", "Checking setting…");
  const state = tailscale.remoteWrite
    ? text("원격에서도 데스크톱과 같이 변경할 수 있습니다", "Remote can change things just like the desktop")
    : text("원격은 읽기 전용입니다 · 조회만 됩니다", "Remote is read only · viewing only");
  if (!access || canManage) return state;
  return `${state} · ${text("호스트 화면에서만 바꿀 수 있습니다", "Changeable from the host screen only")}`;
}

/** 절전 억제 행의 요약 문구. 호스트가 알려 준 실패 사유가 있으면 켜짐·꺼짐보다 그것을 먼저 보여 준다. */
function sleepSummaryText(
  taskError: string | null,
  sleep: SleepPreventionStatus | null,
  text: (ko: string, en: string) => string,
): string {
  if (taskError) return taskError;
  if (!sleep) return text("절전 설정 확인 중…", "Checking sleep settings…");
  if (sleep.error) return sleep.error;
  if (!sleep.supported) {
    return text(
      "이 호스트에서 쓸 수 있는 절전 억제 수단을 찾지 못했습니다.",
      "No usable sleep-prevention mechanism was found on this host.",
    );
  }
  if (sleep.active) return `${text("자동 절전을 막고 있습니다", "Blocking automatic sleep")} · ${sleep.mechanism ?? ""}`;
  return text("꺼짐 · 호스트가 잠들면 원격 접속이 끊깁니다", "Off · remote access drops while the host sleeps");
}

// 백엔드 서비스 카드의 작업 네 벌(포트 저장·Tailscale 서비스·원격 편집 허용·절전 억제)은
// 각자 busy 플래그와 오류 자리를 따로 두고 "busy를 걸고, 자기 오류와 공용 안내를 지우고,
// 요청하고, 무엇으로 끝나든 busy를 푼다"는 껍데기를 똑같이 되풀이했다. 상태 짝과 껍데기만
// 이 훅으로 모으고, 성공 문구를 어디에 적을지와 실패 뒤 정리는 부르는 쪽이 그대로 정한다.
function useBackendTask(clearNotice: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    action: () => Promise<void>,
    options: { onFailure?: (message: string) => void; onSettled?: () => void } = {},
  ) => {
    setBusy(true);
    setError(null);
    clearNotice();
    try {
      await action();
    } catch (cause) {
      const message = errorText(cause);
      setError(message);
      options.onFailure?.(message);
    } finally {
      setBusy(false);
      options.onSettled?.();
    }
  };
  return { busy, error, setError, run };
}

function RemoteAccessSettings() {
  const { text } = useI18n();
  const nativeRuntime = hasTauriRuntime();
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [serviceSettings, setServiceSettings] = useState<BackendServiceSettings | null>(null);
  const activePort = nativeRuntime ? currentBackendServicePort() : null;
  const [portText, setPortText] = useState(String(DEFAULT_BACKEND_SERVICE_PORT));
  const [accessError, setAccessError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const portTask = useBackendTask(clearNotice);
  const tailscaleTask = useBackendTask(clearNotice);
  const sleepTask = useBackendTask(clearNotice);
  const remoteWriteTask = useBackendTask(clearNotice);
  const [tailscale, setTailscale] = useState<TailscaleServiceStatus | null>(null);
  const [tailscaleConflict, setTailscaleConflict] = useState<string | null>(null);
  const [sleep, setSleep] = useState<SleepPreventionStatus | null>(null);
  const [restarting, setRestarting] = useState(false);
  // Tailscale Serve가 이미 루프백 대상을 잡고 있으면 그 포트가 서비스 포트의
  // 원본이 된다. 사용자는 두 값을 따로 바꿀 수 없고 Serve 쪽을 따라간다.
  const tailscalePort = loopbackTargetPort(tailscale?.serveTarget ?? null);
  const portFollowsTailscale = tailscalePort !== null;
  // 입력값을 Serve 대상으로 덮어쓰지 않고 표시 단계에서만 대체한다. 상태 로드
  // 두 건이 어떤 순서로 끝나든 잠긴 포트가 흔들리지 않는다.
  const displayPortText = portFollowsTailscale ? String(tailscalePort) : portText;
  const port = Number(displayPortText);
  const portError = useMemo(() => {
    if (!Number.isInteger(port) || port < MIN_BACKEND_SERVICE_PORT || port > MAX_BACKEND_SERVICE_PORT) {
      return text(
        `서비스 포트는 ${MIN_BACKEND_SERVICE_PORT}~${MAX_BACKEND_SERVICE_PORT} 범위의 정수여야 합니다.`,
        `The service port must be an integer from ${MIN_BACKEND_SERVICE_PORT} to ${MAX_BACKEND_SERVICE_PORT}.`,
      );
    }
    return null;
  }, [port, text]);

  useEffect(() => {
    let disposed = false;
    // 네 건의 상태 조회는 순서가 정해져 있지 않고 각자 자기 오류 자리에 담긴다.
    // 화면을 떠난 뒤 늦게 도착한 응답은 어느 갈래든 버린다.
    const load = <T,>(
      fetchStatus: () => Promise<T>,
      apply: (value: T) => void,
      fail: (message: string) => void,
    ) => {
      void fetchStatus()
        .then((next) => { if (!disposed) apply(next); })
        .catch((cause) => { if (!disposed) fail(errorText(cause)); });
    };
    load(getWebAccessStatus, (next) => {
      setAccess(next);
      setAccessError(null);
      if (!nativeRuntime) setPortText(String(next.backendPort));
    }, setAccessError);
    load(getTailscaleServiceStatus, (next) => { setTailscale(next); tailscaleTask.setError(null); }, tailscaleTask.setError);
    load(getSleepPrevention, (next) => { setSleep(next); sleepTask.setError(null); }, sleepTask.setError);
    if (nativeRuntime) {
      load(getBackendServiceSettings, (next) => {
        setServiceSettings(next);
        setPortText(String(next.port));
        portTask.setError(null);
      }, portTask.setError);
    }
    return () => { disposed = true; };
  }, [nativeRuntime]);

  const savePort = async () => {
    if (!nativeRuntime || portError || portTask.busy || serviceSettings?.port === port) return;
    await portTask.run(async () => {
      const next = await setBackendServiceSettings(port);
      setServiceSettings(next);
      setPortText(String(next.port));
      setNotice(text(
        `포트 ${next.port} 저장됨 · 다음 실행부터 적용`,
        `Port ${next.port} saved · applies on next launch`,
      ));
    });
  };

  const runningPort = access?.backendPort ?? activePort;
  const savedPort = serviceSettings?.port ?? null;
  // 적용 예정 포트. Tailscale Serve 대상이 있으면 그 포트가 우선한다.
  const pendingPort = portFollowsTailscale ? tailscalePort : savedPort;
  const restartRequired = nativeRuntime && pendingPort !== null && runningPort !== null
    && pendingPort !== runningPort;
  const { confirm, confirmDialog } = useConfirm();

  const applyPortAndRestart = async () => {
    if (!nativeRuntime || pendingPort === null || restarting) return;
    const accepted = await confirm({
      title: text("서비스 포트 적용", "Apply service port"),
      message: text(
        `서비스 포트를 ${pendingPort}(으)로 적용하려면 Agent Manager를 재시작해야 합니다.\n지금 재시작할까요?`,
        `Applying service port ${pendingPort} requires restarting Agent Manager.\nRestart now?`,
      ),
      warning: text("실행 중인 채팅과 터미널이 모두 종료됩니다.", "All running chats and terminals will stop."),
      confirmLabel: text("재시작", "Restart"),
      tone: "danger",
    });
    if (!accepted) return;
    setRestarting(true);
    portTask.setError(null);
    setNotice(null);
    try {
      if (savedPort !== pendingPort) {
        const next = await setBackendServiceSettings(pendingPort);
        setServiceSettings(next);
        setPortText(String(next.port));
      }
      // 성공하면 프로세스가 그대로 교체되므로 이 아래는 실행되지 않는다.
      await restartApp();
    } catch (cause) {
      portTask.setError(errorText(cause));
      setRestarting(false);
    }
  };

  // 원격(Tailscale)으로 접속했을 때도 요약에는 백엔드가 실제로 수신 중인
  // 루프백 주소를 보여준다. 원격 주소는 Tailscale 서비스 행에서 따로 안내한다.
  const serviceEndpoint = `127.0.0.1:${access?.backendPort ?? activePort ?? DEFAULT_BACKEND_SERVICE_PORT}`;
  const error = portTask.error ?? accessError;
  const connectionSummary = access
    ? `${text("서비스주소", "Service address")} ${serviceEndpoint}`
    : error
      ? text("연결 오류", "Connection error")
      : text("연결 확인 중", "Checking connection");
  const canManageTailscale = Boolean(access?.writable) && Boolean(tailscale?.available);
  const tailscaleSummary = tailscaleSummaryText(tailscaleTask.error, tailscale, text);

  // 원격 편집 허용은 원격이 자기 권한을 정하지 못하도록 호스트 화면 전용이다.
  // 데스크톱 앱이 아니어도 호스트의 브라우저(127.0.0.1)면 같은 자리다.
  const canManageRemoteWrite = Boolean(access && !access.remote && access.writable);
  // 조회 전에는 null — 알려진 값처럼 꺼짐으로 그리지 않는다(QA #34).
  const remoteWriteEnabled = tailscale ? tailscale.remoteWrite : null;
  const remoteWriteSummary = remoteWriteSummaryText(remoteWriteTask.error, tailscale, access, canManageRemoteWrite, text);

  const canManageSleep = Boolean(access?.writable);
  const sleepSummary = sleepSummaryText(sleepTask.error, sleep, text);

  const toggleSleep = async (next: boolean) => {
    if (sleepTask.busy) return;
    await sleepTask.run(async () => {
      const status = await setSleepPrevention(next);
      setSleep(status);
      // 설정은 저장됐지만 이 호스트에서 실제로 걸리지 않은 경우를 성공으로 보이면 안 된다.
      if (next && !status.active) {
        sleepTask.setError(status.error ?? text(
          "설정은 저장했지만 이 호스트에서 자동 절전을 막지 못했습니다.",
          "The setting was saved, but automatic sleep could not be blocked on this host.",
        ));
        return;
      }
      setNotice(next
        ? text("자동 절전을 막습니다", "Automatic sleep is now blocked")
        : text("자동 절전을 원래 설정대로 되돌렸습니다", "System sleep behavior restored"));
    });
  };

  const toggleRemoteWrite = async (next: boolean) => {
    if (remoteWriteTask.busy) return;
    // 켜는 쪽만 확인받는다. 원격에 데스크톱과 같은 변경 권한을 주는 결정이고,
    // 끄는 쪽은 좁히는 방향이라 되돌리기 쉽다.
    if (next) {
      const accepted = await confirm({
        title: text("원격 편집 허용", "Allow remote editing"),
        message: text(
          "원격 접속에서도 데스크톱과 같은 변경 권한을 줍니다.\n계속할까요?",
          "Remote access will get the same change permissions as the desktop.\nContinue?",
        ),
        warning: text(
          "채팅 실행, 계정 전환, 스킬·지침 편집 같은 변경 작업이 원격에서도 가능해집니다.",
          "Starting chats, switching accounts, and editing skills or instructions become possible from remote.",
        ),
        confirmLabel: text("허용", "Allow"),
      });
      if (!accepted) return;
    }
    await remoteWriteTask.run(async () => {
      const status = await setRemoteWriteEnabled(next);
      setTailscale(status);
      setNotice(next
        ? text("원격 편집을 허용했습니다", "Remote editing is allowed")
        : text("원격을 읽기 전용으로 바꿨습니다", "Remote is now read only"));
    });
  };

  const toggleTailscale = async (next: boolean, replaceExisting = false) => {
    if (tailscaleTask.busy) return;
    // 원격에서 끄면 지금 쓰는 접속 경로가 사라지므로 한 번 더 확인받는다.
    if (!next && access?.remote) {
      const accepted = await confirm({
        title: text("Tailscale 서비스 끄기", "Turn off Tailscale service"),
        message: text(
          "Tailscale 서비스를 끄면 지금 쓰는 이 원격 접속이 끊깁니다.\n계속할까요?",
          "Turning the Tailscale service off will drop the remote connection you are using now.\nContinue?",
        ),
        warning: text("맥에서 직접 다시 켜야 원격 접속을 복구할 수 있습니다.", "You must turn it back on from the Mac itself to restore remote access."),
        confirmLabel: text("끄기", "Turn off"),
        tone: "danger",
      });
      if (!accepted) return;
    }
    await tailscaleTask.run(async () => {
      const status = await setTailscaleServiceEnabled(next, replaceExisting);
      setTailscale(status);
      setTailscaleConflict(null);
      if (next && nativeRuntime && !status.remoteAccepted) {
        setRestarting(true);
        setNotice(text(
          "Tailscale 원격 접속을 허용하도록 Agent Manager를 재시작합니다…",
          "Restarting Agent Manager to accept Tailscale remote access…",
        ));
        await restartApp();
        return;
      }
      setNotice(next
        ? text(`Tailscale 서비스를 켰습니다 · ${status.url ?? ""}`, `Tailscale service on · ${status.url ?? ""}`)
        : text("Tailscale 서비스를 껐습니다", "Tailscale service off"));
    }, {
      // 루트 경로를 다른 서비스가 쓰고 있으면 덮어쓰기 여부를 사용자가 정한다.
      onFailure: (message) => setTailscaleConflict(next && message.includes("Serve 루트 경로") ? message : null),
      onSettled: () => setRestarting(false),
    });
  };

  return (
    <section className="settings-subsection remote-access-card">
      <header>
        <div><strong>{text("백엔드 서비스", "Backend service")}</strong><small>{connectionSummary}</small></div>
      </header>
      <div className="backend-service-body">
        <label className="backend-service-port">
          <span>{text("백엔드 서비스 포트", "Backend service port")}</span>
          <div>
            <input type="number" min={MIN_BACKEND_SERVICE_PORT} max={MAX_BACKEND_SERVICE_PORT} value={displayPortText} readOnly={portFollowsTailscale} disabled={!nativeRuntime || portTask.busy || !serviceSettings || portFollowsTailscale} onChange={(event) => { setPortText(event.target.value); setNotice(null); }} inputMode="numeric" />
            {!portFollowsTailscale && <button className="button primary compact" type="button" disabled={!nativeRuntime || portTask.busy || Boolean(portError) || !serviceSettings || serviceSettings.port === port} onClick={() => void savePort()}>
              {portTask.busy ? text("저장 중…", "Saving…") : text("저장", "Save")}
            </button>}
          </div>
          <small>{portError ?? (!nativeRuntime
            ? text("읽기 전용 · 변경은 호스트의 Agent Manager 데스크톱 앱에서 할 수 있습니다.", "Read only · change this in the Agent Manager desktop app on the host.")
            : portFollowsTailscale
              ? text(`Tailscale Serve 대상 포트 ${tailscalePort}을(를) 따릅니다 · 직접 변경할 수 없습니다`, `Follows the Tailscale Serve target port ${tailscalePort} · not editable here`)
              : text(`기본값 ${DEFAULT_BACKEND_SERVICE_PORT} · 다음 실행부터 적용`, `Default ${DEFAULT_BACKEND_SERVICE_PORT} · applies on next launch`))}</small>
        </label>
        {Boolean(tailscale?.available) && <p className="backend-service-port-warning">{text(
          "Tailscale Serve 이용시 AgentManager 서비스도 동일한 서비스 포트로 설정됩니다.",
          "While Tailscale Serve is in use, the Agent Manager service uses the same service port.",
        )}</p>}
        {restartRequired && <BackendServiceAlert
          message={text(
            `서비스 포트 ${pendingPort}이(가) 아직 적용되지 않았습니다. 현재 백엔드는 ${runningPort} 포트로 실행 중이며, 재시작해야 새 포트로 바뀝니다.`,
            `Service port ${pendingPort} is not applied yet. The backend is still running on port ${runningPort}; restart to switch to the new port.`,
          )}
          actions={<button className="button primary compact" type="button" disabled={restarting} onClick={() => void applyPortAndRestart()}>
            {restarting ? text("재시작 중…", "Restarting…") : text("지금 재시작", "Restart now")}
          </button>}
        />}
        <BackendServiceToggleRow
          title={text("Tailscale 서비스", "Tailscale service")}
          summary={tailscaleSummary}
          checked={tailscale ? tailscale.enabled : null}
          disabled={!canManageTailscale || tailscaleTask.busy || restarting}
          onChange={(next) => void toggleTailscale(next)}
        />
        <BackendServiceToggleRow
          title={text("원격 편집 허용", "Allow remote editing")}
          help={<HelpHint label={text("원격 편집 허용 설명", "How remote editing works")} title={text("원격 편집 허용", "Allow remote editing")} popoverClassName="backend-service-help-popover">
            {text(
              "원격(Tailscale) 접속에 데스크톱과 같은 변경 권한을 줄지 정합니다. 끄면 원격 화면은 조회만 되고 채팅 실행·계정 전환·편집이 모두 거절됩니다. 재시작 없이 바로 반영되지만 이미 열려 있는 채팅 스트림은 접속할 때의 권한으로 이어집니다. 켜도 계정 로그인처럼 호스트에서만 되는 작업은 원격에 열리지 않으며, 이 설정은 호스트 화면에서만 바꿀 수 있습니다.",
              "Decides whether remote (Tailscale) access gets the same change permissions as the desktop. While off, the remote UI can only view: starting chats, switching accounts, and editing are refused. It applies without a restart, but streams that are already open keep the permission they connected with. Host-only actions such as account login stay closed to remote either way, and only the host can change this setting.",
            )}
          </HelpHint>}
          summary={remoteWriteSummary}
          checked={remoteWriteEnabled}
          disabled={!canManageRemoteWrite || remoteWriteTask.busy || restarting}
          onChange={(next) => void toggleRemoteWrite(next)}
        />
        <BackendServiceToggleRow
          title={text("절전 억제", "Prevent sleep")}
          help={<HelpHint label={text("절전 억제 동작 설명", "How preventing sleep works")} title={text("절전 억제", "Prevent sleep")} popoverClassName="backend-service-help-popover">
            {text(
              "호스트가 자동으로 잠들지 않게 막습니다. 호스트가 잠들면 백엔드도 멈춰 원격 화면에는 연결 실패로만 보이므로, 휴대폰에서 원격으로 쓰는 동안 켜 두세요. 자동 절전만 막습니다 — 노트북 뚜껑을 닫거나 직접 잠재우는 것은 그대로 동작합니다. 배터리로 쓰는 동안에는 소모가 늘어납니다.",
              "Keeps the host from sleeping on its own. When the host sleeps the backend stops with it, and the remote UI can only show a connection failure, so turn this on while you use Agent Manager from your phone. It blocks automatic sleep only — closing a laptop lid or sleeping the machine yourself still works. Expect higher battery drain while unplugged.",
            )}
          </HelpHint>}
          summary={sleepSummary}
          checked={sleep ? sleep.enabled : null}
          highlighted={Boolean(sleep?.active)}
          disabled={!canManageSleep || sleepTask.busy}
          onChange={(next) => void toggleSleep(next)}
        />
        {tailscale?.available && tailscale.enabled && !tailscale.remoteAccepted && <BackendServiceAlert
          message={text(
            nativeRuntime
              ? "Tailscale Serve는 켜져 있지만 현재 백엔드는 원격 요청을 받지 않습니다. 원격 접속 허용 설정으로 Agent Manager를 재시작하세요."
              : "Tailscale Serve는 켜져 있지만 현재 백엔드는 원격 요청을 받지 않습니다. 호스트의 Agent Manager 데스크톱 앱에서 원격 허용으로 재시작하세요.",
            nativeRuntime
              ? "Tailscale Serve is on, but the current backend does not accept remote requests. Restart Agent Manager with remote access enabled."
              : "Tailscale Serve is on, but the current backend does not accept remote requests. Restart with remote access enabled from the Agent Manager desktop app on the host.",
          )}
          actions={nativeRuntime
            ? <button className="button primary compact" type="button" disabled={tailscaleTask.busy || restarting} onClick={() => void toggleTailscale(true)}>
              {restarting ? text("재시작 중…", "Restarting…") : text("원격 허용으로 재시작", "Restart with remote access")}
            </button>
            : null}
        />}
        {tailscaleConflict && <BackendServiceAlert
          message={text(
            "Tailscale Serve 루트 경로를 다른 서비스가 사용하고 있습니다. 덮어쓰면 기존 설정이 이 백엔드로 바뀝니다.",
            "Another service owns the Tailscale Serve root path. Overwriting repoints it to this backend.",
          )}
          actions={<>
            <button className="button secondary compact" type="button" disabled={tailscaleTask.busy} onClick={() => { setTailscaleConflict(null); tailscaleTask.setError(null); }}>{text("취소", "Cancel")}</button>
            <button className="button primary compact" type="button" disabled={tailscaleTask.busy} onClick={() => void toggleTailscale(true, true)}>{text("덮어쓰고 켜기", "Overwrite and turn on")}</button>
          </>}
        />}
        {notice && <p className="settings-success" role="status">{notice}</p>}
        {error && <ErrorBanner message={error} />}
      </div>
      {confirmDialog}
    </section>
  );
}

/// Tailscale Serve 대상이 이 컴퓨터의 루프백을 가리킬 때만 포트를 읽는다.
/// 다른 호스트를 가리키는 대상은 서비스 포트로 따라갈 수 없다.
function loopbackTargetPort(target: string | null): number | null {
  if (!target) return null;
  let url: URL;
  try { url = new URL(target); } catch { return null; }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < MIN_BACKEND_SERVICE_PORT || port > MAX_BACKEND_SERVICE_PORT) return null;
  return port;
}
