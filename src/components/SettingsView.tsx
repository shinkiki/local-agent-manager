import { ArrowDownFromLine, CornerDownLeft, Keyboard, Send, ArrowDownToLine, ArrowUpToLine, Blocks, Cable, Calendar, ChartPie, ChevronDown, ChevronRight, CircleCheck, Cloud, Code, CreditCard, Database, Download, Eraser, Eye, EyeOff, FileText, FolderClosed, GitBranch, Globe, KeyRound, Languages, LayoutTemplate, Library, LoaderCircle, Mail, Monitor, MonitorCog, Moon, NotebookText,PenLine, PenTool, Plug, Plus, Power, PowerOff, Presentation, RefreshCw, Repeat, Search, Server, Settings, ShieldAlert, SquareTerminal, Sun, Table2, Ticket, Trash2, Upload, Users, Waypoints, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { TabRequest } from "../lib/uiGuide";
import { beginProviderAccountLogin, cancelProviderAccountLogin, cancelUiTranslation, checkProviderCliUpdate, clearProviderModelCaches, consumeAccountResetCredit, deleteProviderAccount, finishProviderAccountLogin, getAccountTools, getAntigravityUsage, getBackendServiceSettings, getBackgroundSettings, getCliUpdateStatus, getProviderRuntimeCounts, getResourceRepository, getSleepPrevention, getTailscaleServiceStatus, getWebAccessStatus, hasTauriRuntime, refreshProviderAccountUsage, requestSystemLanguage, resetMenuTranslation, restartApp, revalidateProviderAccountCredential, retryMenuTranslation, retryUiTranslation, setAutoSwitchPolicy, setAutoSwitchResume, setAutoSwitchUsageGap, setResumeAccountPolicy, setBackendServiceSettings, setBackgroundSettings, setSleepPrevention, setProviderAccountAutoSwitch, setProviderAccountAutoSwitchPriority, setProviderAccountDisabled, setProviderAccountNote, setProviderAccountLabel, setRemoteWriteEnabled, setResourceRepository, setSystemAutomationSettings, setTailscaleServiceEnabled, switchActiveProviderAccount, updateProviderCli, type BackendServiceSettings, type SleepPreventionStatus, type TailscaleServiceStatus, type WebAccessStatus } from "../lib/ipc";
import { getUiTranslationCatalog, useI18n, type UiText } from "../lib/i18n";
import { runtimeText } from "../lib/i18nRuntime";
import { sourceName } from "../lib/format";
import { accountUsageDisplayState, displayUsageWindows, usageLevel, usageWindowValueUnavailable, type DisplayUsageWindow } from "../lib/accountUsage";
import { autoSwitchEventSummary } from "../lib/autoSwitchEvent";
import { homeAccountSummary, homeUsageNote } from "../lib/homeAccount";
import { credentialExpiryImminent, daysUntilExpiry } from "../lib/accountCredentialExpiry";
import type { AccountUsageView, ProviderHomeToolsView, ProviderHomeView } from "../types";
import { accountNoteDraftState, submitAccountNote, ACCOUNT_NOTE_MAX_CHARS } from "../lib/accountNote";
import { accountLabelDraftState, submitAccountLabel, ACCOUNT_LABEL_MAX_CHARS } from "../lib/accountLabel";
import { accountToolBadges, accountToolsFor, homeToolsFor, DEFAULT_ACCOUNT_TOOL_BADGE_LIMIT, type AccountToolBadgeSource, type AccountToolIconName } from "../lib/accountTools";
import { cacheAwaitsNewerCliRelease, canCheckCliUpdate, canClearModelCaches, canRunCliUpdate, cliUpdateAlert, cliUpdateBadge, cliUpdateBlockedReason, hasCliUpdateAlert, modelCacheBlockedReason, runtimeStopConfirmationCount, shouldShowCliUpdatePanel, type CliActionAccess, type CliUpdateAlert } from "../lib/cliUpdate";
import type { AccountLoginSessionView, AccountSnapshot, AccountToolsSnapshot, AccountToolsView, AccentColor, AppLocale, HostPlatform, AutoSwitchEventView, AutoSwitchPolicy, ChatApprovalMode, ChatMode, ChatProviderOptions, CliUpdateReceipt, MessageDisplayMode, ModelCacheCleanupReceipt, ModelOption, ProviderAccountView, ProviderCliUpdateStatus, ProviderId, ProviderRuntimeCounts, ProviderStatus, ProviderRuntimeStopSummary, ResourceRepositorySettings, ResumeAccountPolicy, SystemAutomationSettings, SystemAutomationSnapshot, ThemeMode, TranslationLanguage, TranslationMenu } from "../types";
import { aiaRuntimeProvider, aiaRuntimeSettings, canRunSystemAgent, sameAiaRuntimeSettings, systemAgentRuntimePatch, type AiaRuntimeSettings } from "../lib/aiaRuntime";
import { cachedProviderOptions, reasoningOptionsFor, refreshProviderOptions, subscribeProviderOptions, useProviderOptions } from "../lib/providerOptions";
import { normalizeExtraSettings, normalizeSettingValue, settingFieldsFor } from "../lib/chatSettings";
import { catalogResetPrompt, schemaDiscoveryPrompt, staleCatalogSources } from "../lib/schemaDiscovery";
import { defaultEffortFor, RuntimeSettings } from "./RuntimeSettings";
import { currentBackendServicePort, DEFAULT_BACKEND_SERVICE_PORT, MAX_BACKEND_SERVICE_PORT, MIN_BACKEND_SERVICE_PORT } from "../lib/backend";
import { repositoryTransferPrompt } from "../lib/skillTransfer";
import { moveNavigationItem, previewView, setNavigationVisibility, type ConfigurableViewId, type NavigationPreferences } from "../lib/navigationPreferences";
import { AiaMark, AppToggle, BrandMark, Drawer, ErrorBanner, HelpHint, Modal, NoticeBanner, PathField, SourceBadge, useConfirm, useEscapeToClose, useOutsidePointerToClose } from "./Shared";
import { TelemetrySettingsCard } from "./TelemetrySettingsCard";
import { AccountLoginTerminalPanel } from "./TerminalPanel";
import { errorText } from "../lib/errorText";
import { APP_VERSION, hideAppVersion, isAppVersionHidden, isNewerAppVersion, lastAppVersionCheckAt, type AppVersionManifest } from "../lib/appUpdate";
import { openUrl } from "@tauri-apps/plugin-opener";
import { displayPath } from "../lib/displayPath";
import { readComposerEnterMode, writeComposerEnterMode, type ComposerEnterMode } from "../lib/composerKeys";
import { translationMenuLabel, translationStatusText, TranslationMenuRow, TRANSLATION_MENUS } from "./TranslationSettingsRows";
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
  appVersionManifest: AppVersionManifest | null;
  /// 공통 저장소 경로나 프로젝트 활성여부가 바뀌면 알린다. 스킬·지침 화면이 다시 읽고
  /// 스냅샷도 다시 받아야 한다.
  onRepositoryChanged?: () => void;
}

interface SettingsChoiceOption<T extends string> {
  value: T;
  title: string;
  description: string;
  icon: LucideIcon;
}

const themeModes = (text: UiText): SettingsChoiceOption<ThemeMode>[] => [
  {
    value: "auto",
    title: text("자동 (시스템 연동)", "Auto (system)"),
    description: text("운영체제의 라이트/다크 설정을 따라가며, 시스템이 바뀌면 즉시 함께 바뀝니다.", "Follows the operating system and updates immediately when it changes."),
    icon: Monitor,
  },
  {
    value: "light",
    title: text("라이트 모드", "Light mode"),
    description: text("시스템 설정과 관계없이 항상 밝은 화면으로 표시합니다.", "Always use a light appearance regardless of the system setting."),
    icon: Sun,
  },
  {
    value: "dark",
    title: text("다크 모드", "Dark mode"),
    description: text("시스템 설정과 관계없이 항상 어두운 화면으로 표시합니다.", "Always use a dark appearance regardless of the system setting."),
    icon: Moon,
  },
];

const accentColors = (text: UiText): { value: AccentColor; title: string; swatch: string }[] => [
  { value: "brass", title: text("황동", "Brass"), swatch: "#f0b054" },
  { value: "green", title: text("그린", "Green"), swatch: "#51e97d" },
  { value: "blue", title: text("블루", "Blue"), swatch: "#58a6ff" },
  { value: "cyan", title: text("시안", "Cyan"), swatch: "#3ddad0" },
  { value: "violet", title: text("바이올렛", "Violet"), swatch: "#b18cff" },
];

const builtInTranslationLanguages: TranslationLanguage[] = [
  { code: "ko", name: "Korean" },
  { code: "en", name: "English" },
];

const commonTranslationLanguages: (TranslationLanguage & { koreanName: string })[] = [
  { code: "ja", name: "Japanese", koreanName: runtimeText("일본어", "Japanese") },
  { code: "zh-cn", name: "Chinese (Simplified)", koreanName: runtimeText("중국어 (간체)", "Chinese (Simplified)") },
  { code: "zh-tw", name: "Chinese (Traditional)", koreanName: runtimeText("중국어 (번체)", "Chinese (Traditional)") },
  { code: "es", name: "Spanish", koreanName: runtimeText("스페인어", "Spanish") },
  { code: "fr", name: "French", koreanName: runtimeText("프랑스어", "French") },
  { code: "de", name: "German", koreanName: runtimeText("독일어", "German") },
  { code: "pt-br", name: "Portuguese (Brazil)", koreanName: runtimeText("포르투갈어 (브라질)", "Portuguese (Brazil)") },
  { code: "it", name: "Italian", koreanName: runtimeText("이탈리아어", "Italian") },
  { code: "ru", name: "Russian", koreanName: runtimeText("러시아어", "Russian") },
  { code: "ar", name: "Arabic", koreanName: runtimeText("아랍어", "Arabic") },
  { code: "hi", name: "Hindi", koreanName: runtimeText("힌디어", "Hindi") },
  { code: "id", name: "Indonesian", koreanName: runtimeText("인도네시아어", "Indonesian") },
  { code: "vi", name: "Vietnamese", koreanName: runtimeText("베트남어", "Vietnamese") },
  { code: "th", name: "Thai", koreanName: runtimeText("태국어", "Thai") },
  { code: "tr", name: "Turkish", koreanName: runtimeText("터키어", "Turkish") },
  { code: "pl", name: "Polish", koreanName: runtimeText("폴란드어", "Polish") },
  { code: "nl", name: "Dutch", koreanName: runtimeText("네덜란드어", "Dutch") },
  { code: "sv", name: "Swedish", koreanName: runtimeText("스웨덴어", "Swedish") },
  { code: "da", name: "Danish", koreanName: runtimeText("덴마크어", "Danish") },
  { code: "nb", name: "Norwegian Bokmål", koreanName: runtimeText("노르웨이어 (보크몰)", "Norwegian Bokmål") },
  { code: "fi", name: "Finnish", koreanName: runtimeText("핀란드어", "Finnish") },
  { code: "cs", name: "Czech", koreanName: runtimeText("체코어", "Czech") },
  { code: "uk", name: "Ukrainian", koreanName: runtimeText("우크라이나어", "Ukrainian") },
  { code: "he", name: "Hebrew", koreanName: runtimeText("히브리어", "Hebrew") },
];

function languageDisplayName(language: TranslationLanguage, locale: AppLocale): string {
  const preset = commonTranslationLanguages.find((item) => item.code === language.code);
  return locale === "ko" && preset ? preset.koreanName : language.name;
}

const composerEnterModes = (text: UiText): SettingsChoiceOption<ComposerEnterMode>[] => [
  {
    value: "auto",
    title: text("자동", "Auto"),
    description: text("PC에서는 Enter로 전송하고, 휴대폰·태블릿처럼 터치 화면이면 Enter가 줄바꿈이 됩니다.", "Enter sends on a computer and inserts a line break on touch devices such as phones and tablets."),
    icon: Keyboard,
  },
  {
    value: "send",
    title: text("Enter로 전송", "Enter sends"),
    description: text("터치 기기에서도 Enter로 전송하고 Shift+Enter로 줄바꿈합니다. 키보드를 연결한 태블릿에 맞습니다.", "Enter sends even on touch devices; Shift+Enter inserts a line break. Suits tablets with a keyboard attached."),
    icon: Send,
  },
  {
    value: "newline",
    title: text("Enter로 줄바꿈", "Enter inserts a line break"),
    description: text("Enter는 항상 줄바꿈이며 전송 버튼으로만 보냅니다.", "Enter always inserts a line break; send with the send button."),
    icon: CornerDownLeft,
  },
];

/** Enter 키 동작 선택. 입력창이 키를 누를 때마다 저장값을 읽으므로 화면 상태를 따로 넘기지 않는다. */
function ComposerEnterModeSection() {
  const { text } = useI18n();
  const [mode, setMode] = useState<ComposerEnterMode>(() => readComposerEnterMode());
  return (
    <section className="settings-card">
      <header>
        <div><span>{text("채팅", "Chat")}</span><h2>{text("Enter 키 동작", "Enter key")}</h2></div>
        <p>{text("메시지 입력창에서 Enter를 눌렀을 때의 동작을 고릅니다. 이 설정은 현재 기기에 저장됩니다.", "Choose what Enter does in the message box. This setting is stored on this device.")}</p>
      </header>
      <SettingsChoiceList
        ariaLabel={text("Enter 키 동작", "Enter key")}
        value={mode}
        options={composerEnterModes(text)}
        onChange={(next) => { setMode(next); writeComposerEnterMode(next); }}
      />
    </section>
  );
}

const displayModes = (text: UiText): SettingsChoiceOption<MessageDisplayMode>[] => [
  {
    value: "lastUser",
    title: text("마지막 보낸 메시지부터 표시", "Start at your last message"),
    description: text("세션을 열면 사용자가 마지막으로 보낸 메시지에서 시작해 응답을 아래로 읽어 내려갑니다.", "Open at your last sent message and read the response downward."),
    icon: ArrowDownFromLine,
  },
  {
    value: "start",
    title: text("대화 시작 부분 표시", "Show conversation start"),
    description: text("세션을 열면 대화의 처음부터 보여주고, 새 응답이 도착해도 현재 위치를 유지합니다.", "Open at the start and keep the current position when new responses arrive."),
    icon: ArrowUpToLine,
  },
  {
    value: "latest",
    title: text("마지막 대화 표시", "Show latest messages"),
    description: text("세션을 열면 가장 최근 대화 위치로 이동하고, 새 응답이 도착하면 최신 메시지를 따라갑니다.", "Open at the latest message and follow new responses."),
    icon: ArrowDownToLine,
  },
];

/**
 * 화면을 떠난 뒤 늦게 도착한 응답은 버리는 조회 한 건.
 *
 * 설정 화면의 카드들은 상태 조회마다 `let disposed = false`를 세우고, then·catch 양쪽에서
 * 그 깃발을 확인하고, effect 정리에서 내리는 껍데기를 똑같이 되풀이했다. 껍데기만 여기로
 * 모은다 — 무엇을 읽고 어디에 적을지, 실패를 어느 자리에 남길지는 부르는 쪽이 그대로 정한다.
 *
 * 돌려주는 함수가 그 깃발을 내리는 정리 함수라 `useEffect`가 그대로 반환하면 된다. 조회를
 * 여러 건 걸었으면 반환받은 함수들을 모아 한 번에 부른다.
 */
function loadWhileMounted<T>(
  fetchStatus: () => Promise<T>,
  apply: (value: T) => void,
  fail?: (message: string) => void,
): () => void {
  let disposed = false;
  void fetchStatus()
    .then((next) => { if (!disposed) apply(next); })
    .catch((cause) => { if (!disposed) fail?.(errorText(cause)); });
  return () => { disposed = true; };
}

/**
 * 설정 화면 카드들의 "한 번에 한 동작" 껍데기 — busy 키를 걸고, 지난 오류·안내를 지우고,
 * 무엇으로 끝나든 busy를 푼다. 라이브러리 저장소·세션 자동정리·CLI 연결 세 카드가 같은 모양을
 * 각자 적어 두고 있었다. 다른 것은 busy 키의 갈래와 실패 문구를 어디에 적느냐뿐이라 껍데기만
 * 여기로 모으고, 그 둘은 부르는 쪽이 정하게 남긴다.
 *
 * 되돌리기 어려운 동작 앞의 확인창도 이 껍데기가 맡는다. 세션 자동정리 셋(켜기·지금 정리·
 * 기록 비우기)과 계정 둘(리셋 크레딧·등록 삭제)이 "묻고, 거절하면 아무것도 하지 않는다"를
 * 각자 `const accepted = await confirm(...)`과 `if (!accepted) return;`으로 적어 두어, 한
 * 자리에서 빠뜨려도 드러나지 않았다. `confirm`에 null을 주면 묻지 않는 것이라, 켤 때만 묻는
 * 자리는 삼항 하나로 방향을 고르면 된다(`useBackendTask`와 같은 모양).
 *
 * `run`은 성공하면 null을, 실패하면 실패 문구를 돌려준다. 확인창에서 거절하면 아무것도 하지
 * 않고 null을 돌려준다 — busy도 걸지 않고 지난 오류·안내도 그대로 둔다. 기본은 실패 문구를
 * 카드의 오류 배너(`error`)에 적고, `quiet`를 켜면 배너를 건드리지 않고 문구만 돌려준다 — 편집 대화상자 안처럼
 * 실패를 다른 자리에 적어야 하는 호출이 쓴다. 성공했을 때 무엇을 적을지는 이 껍데기가 정하지
 * 않는다: 세션 정리 회차처럼 예외 없이 끝나고도 영수증의 실패 건수로 오류를 적어야 하는 작업이
 * 있어, 성패를 대신 판단할 수 없다.
 *
 * 백엔드 서비스 카드의 `useBackendTask`는 한 카드가 네 개를 따로 쥐고 동시에 돌리는 다른
 * 모양이라 여기로 합치지 않는다 — 합치면 포트 저장과 Tailscale 토글이 서로를 잠근다.
 */
function useCardTask<Key extends string>(clearNotice: () => void) {
  const [busy, setBusy] = useState<Key | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    key: Key,
    action: () => Promise<void>,
    options: { quiet?: boolean; confirm?: (() => Promise<boolean>) | null } = {},
  ): Promise<string | null> => {
    if (options.confirm && !(await options.confirm())) return null;
    setBusy(key);
    setError(null);
    clearNotice();
    try {
      await action();
      return null;
    } catch (cause) {
      const message = errorText(cause);
      if (!options.quiet) setError(message);
      return message;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, setError, run };
}

/**
 * 설정 화면은 한 번 열면 언마운트되지 않으므로(App의 `mountedViews`는 누적형) 탭을 벗어났다
 * 돌아올 때마다 한 번씩 다시 읽어야 바뀐 결과가 화면에 반영된다. 모델 카탈로그·세션 자동정리·
 * CLI 업데이트 세 자리가 "활성이 아니면 읽었다는 표시를 풀고, 이미 읽었으면 넘기고, 아니면
 * 표시를 세우고 읽는다"를 각자 적어 두고 있었다. 그 껍데기만 여기로 모은다.
 *
 * `load`가 정리 함수를 돌려주면(예: `loadWhileMounted`) 효과의 정리로 그대로 쓰인다. 함께
 * 넘겨받는 `forget`과 이 훅이 돌려주는 값은 같은 함수로, 부르면 "읽었다"는 표시가 풀려 다음
 * 진입을 기다리지 않고 다시 읽을 수 있다 — 실패한 조회를 읽은 것으로 치지 않으려는 자리가 쓴다.
 * `onLeave`는 화면을 벗어날 때 함께 풀어야 하는 다른 표시가 있는 자리를 위한 것이다.
 *
 * 읽는 함수의 정체성은 일부러 의존성에 넣지 않는다. 표시가 서 있는 동안에는 어차피 다시 읽지
 * 않으므로, 매 렌더 새로 만들어지는 함수를 넣어도 결과가 같다.
 */
function useLoadOnActiveEntry(
  active: boolean,
  load: (forget: () => void) => void | (() => void),
  onLeave?: () => void,
): () => void {
  const loadedRef = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  const forget = useCallback(() => { loadedRef.current = false; }, []);
  useEffect(() => {
    if (!active) {
      loadedRef.current = false;
      leaveRef.current?.();
      return undefined;
    }
    if (loadedRef.current) return undefined;
    loadedRef.current = true;
    return loadRef.current(forget) ?? undefined;
  }, [active, forget]);
  return forget;
}

type SystemSectionId = "cli" | "agent" | "service" | "language";
export type SettingsTabId = "connections" | "aia" | "service" | "repository" | "language" | "display";

// 채팅·세션 화면과 같은 중메뉴. 한 화면에 모든 카드를 쌓지 않고 탭으로 나눈다.
// 채팅 실행설정 스키마는 CLI 정보가 갱신될 때 백엔드가 직접 조사해 맞추므로 독립된
// 중메뉴를 두지 않는다. 실행설정 선택 UI는 채팅 생성·이어가기 화면에 있다.
// AIA 설정은 CLI 설정과 같은 단계에 선다 — 시스템 에이전트 선택과 그 실행설정은 CLI 연결·계정
// 아래 딸린 항목이 아니라 앱 전체가 쓰는 에이전트를 정하는 자리다.
const settingsTabs: { id: SettingsTabId; icon: ComponentType<{ size?: number; "aria-hidden"?: "true" }>; label: (text: UiText) => string }[] = [
  { id: "connections", icon: KeyRound, label: (text) => text("CLI 설정", "CLI settings") },
  { id: "aia", icon: AiaMark, label: (text) => text("AIA 설정", "AIA settings") },
  { id: "service", icon: Server, label: (text) => text("시스템", "System") },
  { id: "repository", icon: Library, label: (text) => text("라이브러리", "Library") },
  { id: "language", icon: Languages, label: (text) => text("언어·번역", "Language") },
  { id: "display", icon: Monitor, label: (text) => text("화면·채팅", "Display and chat") },
];

const navigationLabels = (text: UiText): Record<ConfigurableViewId, { label: string; moveUp: string; moveDown: string }> => ({
  dashboard: {
    label: text("대시보드", "Dashboard"),
    moveUp: text("대시보드 위로 이동", "Move Dashboard up"),
    moveDown: text("대시보드 아래로 이동", "Move Dashboard down"),
  },
  chat: {
    label: text("채팅", "Chat"),
    moveUp: text("채팅 위로 이동", "Move Chat up"),
    moveDown: text("채팅 아래로 이동", "Move Chat down"),
  },
  sessions: {
    label: text("세션", "Sessions"),
    moveUp: text("세션 위로 이동", "Move Sessions up"),
    moveDown: text("세션 아래로 이동", "Move Sessions down"),
  },
  docs: {
    label: text("파일", "Files"),
    moveUp: text("파일 위로 이동", "Move Files up"),
    moveDown: text("파일 아래로 이동", "Move Files down"),
  },
  projects: {
    label: text("프로젝트", "Projects"),
    moveUp: text("프로젝트 위로 이동", "Move Projects up"),
    moveDown: text("프로젝트 아래로 이동", "Move Projects down"),
  },
  instructions: {
    label: text("지침", "Instructions"),
    moveUp: text("지침 위로 이동", "Move Instructions up"),
    moveDown: text("지침 아래로 이동", "Move Instructions down"),
  },
  skills: {
    label: text("스킬", "Skills"),
    moveUp: text("스킬 위로 이동", "Move Skills up"),
    moveDown: text("스킬 아래로 이동", "Move Skills down"),
  },
  agents: {
    label: text("에이전트", "Agents"),
    moveUp: text("에이전트 위로 이동", "Move Agents up"),
    moveDown: text("에이전트 아래로 이동", "Move Agents down"),
  },
  artifacts: {
    label: text("아티팩트", "Artifacts"),
    moveUp: text("아티팩트 위로 이동", "Move Artifacts up"),
    moveDown: text("아티팩트 아래로 이동", "Move Artifacts down"),
  },
  workflows: {
    label: text("워크플로", "Workflows"),
    moveUp: text("워크플로 위로 이동", "Move Workflows up"),
    moveDown: text("워크플로 아래로 이동", "Move Workflows down"),
  },
  addons: {
    label: text("애드온", "Add-ons"),
    moveUp: text("애드온 위로 이동", "Move Add-ons up"),
    moveDown: text("애드온 아래로 이동", "Move Add-ons down"),
  },
  storage: {
    label: text("저장소", "Storage"),
    moveUp: text("저장소 위로 이동", "Move Storage up"),
    moveDown: text("저장소 아래로 이동", "Move Storage down"),
  },
});

export function SettingsView({ active, providers, accounts, onAccountsChange, onConnectCli, models, themeMode, onThemeModeChange, accentColor, onAccentColorChange, navigationPreferences, onNavigationPreferencesChange, messageDisplayMode, onMessageDisplayModeChange, automation, onAutomationChange, onRequestAiaPrompt, tabRequest, systemAgentNoticeRequest = null, appVersionManifest, onRepositoryChanged }: SettingsViewProps) {
  const { text } = useI18n();
  const [tab, setTab] = useState<SettingsTabId>("connections");
  const [showSystemAgentNotice, setShowSystemAgentNotice] = useState(false);
  const tabsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (tabRequest) {
      setTab(tabRequest.tab);
    }
  }, [tabRequest]);
  useEffect(() => {
    if (systemAgentNoticeRequest === null) return;
    setTab("aia");
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
    // 탭 줄에는 position 지정이 없어 버튼의 offsetParent가 탭 줄이 아니다. offsetLeft를
    // 그대로 쓰면 탭 줄 자신의 가로 위치까지 섞여 목표 스크롤이 오른쪽으로 밀리고,
    // 왼쪽으로 되감는 갈래가 모자라 활성 탭이 줄 바깥에 남는다(QA #77).
    const offset = active.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
    const left = offset - 12;
    const right = offset + active.offsetWidth + 12 - nav.clientWidth;
    const next = nav.scrollLeft < right ? right : nav.scrollLeft > left ? left : null;
    if (next !== null) nav.scrollTo({ left: Math.max(0, next), behavior: "smooth" });
  }, [tab]);
  // 시스템 자동화 카드는 탭마다 자기 구획만 그린다.
  const systemCard = (sections: SystemSectionId[]) => (
    <SystemAutomationSettingsCard active={active} sections={sections} providers={providers} accounts={accounts} onAccountsChange={onAccountsChange} onConnectCli={onConnectCli} models={models} automation={automation} onChange={onAutomationChange} showSystemAgentNotice={showSystemAgentNotice} onCloseSystemAgentNotice={() => setShowSystemAgentNotice(false)} appVersionManifest={appVersionManifest} />
  );
  return (
    <div className="settings-view">
      <nav className="chat-hub-tabs settings-hub-tabs" ref={tabsRef} role="tablist" aria-label={text("설정 메뉴", "Settings menu")}>
        {settingsTabs.map((item) => (
          <button className={tab === item.id ? "active" : ""} type="button" role="tab" aria-selected={tab === item.id} key={item.id} data-ui-anchor={`settings.tab.${item.id}`} onClick={() => setTab(item.id)}>
            <item.icon size={13} aria-hidden="true" /><span>{item.label(text)}</span>
          </button>
        ))}
      </nav>
      {tab === "connections" && <>
        {systemCard(["cli"])}
        <RuntimeSettingsUpdateCard active={active} providers={providers} automation={automation} aiaAvailable={Boolean(aiaRuntimeProvider(automation))} onRequestDiscovery={onRequestAiaPrompt} onAutomationChange={onAutomationChange} />
      </>}
      {tab === "aia" && systemCard(["agent"])}
      {tab === "service" && systemCard(["service"])}
      {tab === "language" && systemCard(["language"])}
      {/* 프로젝트 활성여부 카드는 프로젝트 화면의 설정 탭으로 옮겨 갔다. `onRepositoryChanged`는
          공통 저장소 경로 변경이 스킬·지침 화면을 다시 읽게 하는 데 그대로 쓰인다. */}
      {tab === "repository" && <ResourceRepositoryCard onChanged={onRepositoryChanged} automation={automation} onRequestAiaPrompt={onRequestAiaPrompt} />}
      {tab === "display" && (
        <DisplaySettingsSection
          navigationPreferences={navigationPreferences}
          onNavigationPreferencesChange={onNavigationPreferencesChange}
          themeMode={themeMode}
          onThemeModeChange={onThemeModeChange}
          accentColor={accentColor}
          onAccentColorChange={onAccentColorChange}
          messageDisplayMode={messageDisplayMode}
          onMessageDisplayModeChange={onMessageDisplayModeChange}
        />
      )}
      <p className="settings-storage-note">{text("이 설정은 호스트에 저장되며 공급자 채팅 원본에는 영향을 주지 않습니다.", "These settings are stored on the host and do not modify provider conversation sources.")}</p>
    </div>
  );
}


/**
 * 테마·메시지 표시 방식처럼 아이콘과 설명이 달린 라디오 선택지 목록을 렌더링한다.
 */
function SettingsChoiceList<T extends string>({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: T;
  options: readonly SettingsChoiceOption<T>[];
  onChange: (value: T) => void;
}) {
  const { text } = useI18n();
  return (
    <div className="settings-choice-list" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            className={selected ? "selected" : ""}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            key={option.value}
          >
            <i aria-hidden="true"><option.icon size={19} strokeWidth={1.8} /></i>
            <span><strong>{option.title}</strong><small>{option.description}</small></span>
            <em>{selected ? text("선택됨", "Selected") : text("선택", "Select")}</em>
          </button>
        );
      })}
    </div>
  );
}

interface DisplaySettingsSectionProps {
  navigationPreferences: NavigationPreferences;
  onNavigationPreferencesChange: (preferences: NavigationPreferences) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  accentColor: AccentColor;
  onAccentColorChange: (color: AccentColor) => void;
  messageDisplayMode: MessageDisplayMode;
  onMessageDisplayModeChange: (mode: MessageDisplayMode) => void;
}

function NavigationPreferenceRow({
  view,
  index,
  preferences,
  onChange,
}: {
  view: ConfigurableViewId;
  index: number;
  preferences: NavigationPreferences;
  onChange: (preferences: NavigationPreferences) => void;
}) {
  const { text } = useI18n();
  const nav = navigationLabels(text)[view];
  const visible = !preferences.hidden.includes(view);
  return (
    <div className={visible ? "navigation-preference-row" : "navigation-preference-row hidden-menu"}>
      <button
        className="navigation-visibility-toggle"
        type="button"
        aria-pressed={visible}
        title={visible ? text("메뉴에서 숨기기", "Hide from menu") : text("메뉴에 표시하기", "Show in menu")}
        onClick={() => onChange(setNavigationVisibility(preferences, view, !visible))}
      >
        <i aria-hidden="true">{visible ? <Eye size={16} /> : <EyeOff size={16} />}</i>
        <span><strong>{nav.label}{previewView(view) && <em className="nav-preview-tag">{text("준비중", "Preparing")}</em>}</strong><small>{visible ? text("메뉴에 표시", "Shown in menu") : text("메뉴에서 숨김", "Hidden from menu")}</small></span>
      </button>
      <div className="navigation-order-actions">
        <button type="button" disabled={index === 0} aria-label={nav.moveUp} title={text("위로 이동", "Move up")} onClick={() => onChange(moveNavigationItem(preferences, view, -1))}><ArrowUpToLine size={15} /></button>
        <button type="button" disabled={index === preferences.order.length - 1} aria-label={nav.moveDown} title={text("아래로 이동", "Move down")} onClick={() => onChange(moveNavigationItem(preferences, view, 1))}><ArrowDownToLine size={15} /></button>
      </div>
    </div>
  );
}

/**
 * 설정 → 화면·채팅 탭. 메뉴 표시·순서, 테마, 강조 색상 및 세션 열기 시 메시지 표시 위치를 설정한다.
 */
function DisplaySettingsSection({
  navigationPreferences,
  onNavigationPreferencesChange,
  themeMode,
  onThemeModeChange,
  accentColor,
  onAccentColorChange,
  messageDisplayMode,
  onMessageDisplayModeChange,
}: DisplaySettingsSectionProps) {
  const { text } = useI18n();
  return (
    <>
      <section className="settings-card display-settings-card">
        <header>
          <div><span>{text("화면", "Display")}</span><h2>{text("화면 설정", "Display settings")}</h2></div>
          <p>{text("메인 메뉴 구성과 앱 전체의 테마·강조 색상을 한곳에서 설정합니다.", "Configure the main menu, app theme, and accent color in one place.")}</p>
        </header>
        <div className="settings-card-sections">
          <section className="settings-subsection">
            <header><div><strong>{text("메인 메뉴", "Main menu")}</strong><small>{text("설정을 제외한 메뉴의 표시 여부와 순서를 정합니다. 이 설정은 현재 기기에 저장됩니다.", "Choose which menus are shown and arrange their order. This setting is stored on this device.")}</small></div></header>
            <div className="navigation-preference-list">
              {navigationPreferences.order.map((view, index) => <NavigationPreferenceRow view={view} index={index} preferences={navigationPreferences} onChange={onNavigationPreferencesChange} key={view} />)}
              <div className="navigation-preference-row fixed-menu">
                <div className="navigation-fixed-label"><i aria-hidden="true"><Settings size={16} /></i><span><strong>{text("설정", "Settings")}</strong><small>{text("항상 마지막에 표시", "Always shown last")}</small></span></div>
                <em>{text("고정", "Fixed")}</em>
              </div>
            </div>
          </section>
          <section className="settings-subsection">
            <header><div><strong>{text("테마", "Theme")}</strong><small>{text("앱 전체의 밝기 테마를 선택합니다. 자동은 운영체제 설정을 따릅니다.", "Choose the app appearance. Auto follows the operating system.")}</small></div></header>
            <SettingsChoiceList
              ariaLabel={text("화면 테마", "Display theme")}
              value={themeMode}
              options={themeModes(text)}
              onChange={onThemeModeChange}
            />
          </section>
          <section className="settings-subsection">
            <header><div><strong>{text("메인 색상", "Accent color")}</strong><small>{text("버튼과 강조 요소에 사용할 색상을 선택합니다.", "Choose the color used for buttons and highlights.")}</small></div></header>
            <div className="accent-swatch-list" role="radiogroup" aria-label={text("메인 색상", "Accent color")}>
              {accentColors(text).map((option) => {
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
        <SettingsChoiceList
          ariaLabel={text("채팅 메시지 표시 방식", "Chat message display")}
          value={messageDisplayMode}
          options={displayModes(text)}
          onChange={onMessageDisplayModeChange}
        />
      </section>
      <ComposerEnterModeSection />
    </>
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
  const [notice, setNotice] = useState<string | null>(null);
  const { busy: busyKey, error, setError, run } = useCardTask<"apply">(() => setNotice(null));
  const busy = busyKey !== null;

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

  const apply = (useDefault: boolean) => run("apply", async () => {
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
  });

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

function platformLabel(platform: HostPlatform, text: UiText): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "linux") return "Linux";
  return text("알 수 없음", "Unknown");
}

/**
 * 실행설정 갱신 카드가 화면에 그리는 값은 조사 원본(CLI가 감지된 공급자)들의 스냅샷을 겹쳐
 * 만든 것이다. 새로 조사한 결과와 캐시에서 읽은 결과가 서로 다른 경로로 들어오지만 겹치는
 * 방식은 같으므로, 겹치기만 여기 한 벌로 둔다. 캐시 경로는 값이 없는 원본을 null로 넘긴다.
 */
function summarizeProviderOptions(options: (ChatProviderOptions | null)[]): {
  settingsUpdatedAt: number | null;
  catalog: { updatedAt: number | null; stale: ProviderId[] };
} {
  const latest = (pick: (item: ChatProviderOptions) => number | null): number | null => {
    const stamps = options
      .map((item) => (item ? pick(item) : null))
      .filter((stamp): stamp is number => stamp !== null);
    return stamps.length > 0 ? Math.max(...stamps) : null;
  };
  return {
    settingsUpdatedAt: latest((item) => item.settingsUpdatedAt),
    catalog: {
      updatedAt: latest((item) => item.catalogUpdatedAt),
      stale: staleCatalogSources(options).map((item) => item.source),
    },
  };
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
  const sources = useMemo(() => (sourceKey ? sourceKey.split(",") as ProviderId[] : []), [sourceKey]);
  const [loaded, setLoaded] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [watching, setWatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogState, setCatalogState] = useState<{ updatedAt: number | null; stale: ProviderId[] }>({ updatedAt: null, stale: [] });
  const autoDiscovery = automation?.settings.catalogAutoDiscovery !== false;
  const watchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadUpdatedAt = useCallback(async (): Promise<number | null | undefined> => {
    try {
      if (sources.length === 0) {
        setUpdatedAt(null);
        setError(null);
        return null;
      }
      const summary = summarizeProviderOptions(await Promise.all(sources.map((source) => refreshProviderOptions(source))));
      setUpdatedAt(summary.settingsUpdatedAt);
      setCatalogState(summary.catalog);
      setError(null);
      return summary.settingsUpdatedAt;
    } catch (cause) {
      setError(errorText(cause));
      return undefined;
    } finally {
      setLoaded(true);
    }
  }, [sources]);
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
  useLoadOnActiveEntry(active, () => { void loadUpdatedAt(); });
  // 옆 카드가 CLI 상태를 읽으면 백엔드가 스키마를 다시 조사하고 카탈로그가 갱신된다.
  // 그 결과가 이 카드의 표시에도 바로 반영되도록 카탈로그 갱신 알림을 함께 듣는다.
  useEffect(() => subscribeProviderOptions(() => {
    const summary = summarizeProviderOptions(sources.map((source) => cachedProviderOptions(source)));
    // 캐시가 아직 비어 있을 때 이미 조사해 둔 시각을 지우지 않으려고 값이 있을 때만 덮어쓴다.
    if (summary.settingsUpdatedAt !== null) setUpdatedAt(summary.settingsUpdatedAt);
    setCatalogState(summary.catalog);
  }), [sources]);
  const requestDiscovery = async (prompt: (sources: ProviderId[]) => string) => {
    if (refreshing || !aiaAvailable) return;
    setRefreshing(true);
    const baseline = await loadUpdatedAt();
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
              : sources.length === 0
                ? text("탐지된 CLI가 없어 조사할 대상이 없습니다 · 내장 스키마 사용 중", "No CLI was detected, so there is nothing to inspect · using the built-in schema")
                : updatedAt !== null
                  ? text(`${new Date(updatedAt).toLocaleString()} 기준`, `As of ${new Date(updatedAt).toLocaleString()}`)
                  : text("조사 기록이 없습니다 · 내장 스키마 사용 중", "No inspection recorded yet · using the built-in schema")}</small>
        </span>
        {/* 조사 대상이 없으면 요청해도 보낼 것이 없다. 눌리기만 하고 아무 일도 일어나지
            않으면 사용자는 AIA가 실패했다고 읽으므로, 이유가 있는 자리에서 잠근다. */}
        <button className="button compact" type="button" disabled={refreshing || !aiaAvailable || sources.length === 0} title={sources.length === 0 ? text("CLI를 연결하면 조사할 수 있습니다", "Connect a CLI to inspect it") : aiaAvailable ? text("AIA에게 CLI 인터페이스 재검토를 요청합니다", "Ask AIA to re-check the CLI interfaces") : text("시스템 설정에서 시스템 에이전트를 선택하세요", "Select a system agent in system settings")} onClick={() => void requestDiscovery(schemaDiscoveryPrompt)}><RefreshCw size={13} />{refreshing ? text("요청 중…", "Requesting…") : text("AIA 재검토", "Re-check with AIA")}</button>
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

/**
 * 공급자 CLI 업데이트 구획의 상태 한 벌.
 *
 * 목록 조회·자동 최신 확인·업데이트·모델 캐시 정리는 상태 다섯 칸(목록·busy 키·확인 대기·
 * 안내·오류)과 참조 둘을 자기들끼리만 주고받는데, 계정 관리 화면 본문 한가운데에 그 한 벌이
 * 펼쳐져 있어 계정 쪽 상태와 뒤섞여 보였다. 한 벌을 통째로 이 훅으로 옮겨 화면 함수에는
 * 그리는 일만 남긴다. 조회 시점(화면 진입)과 자동 확인 조건은 그대로다.
 */
/**
 * CLI 작업 한 건의 잠금 키. 최신 확인·업데이트·캐시 정리 세 작업이 `종류-공급자` 문자열을
 * 거는 쪽(훅)과 읽는 쪽(패널)에서 각자 손으로 적고 있었다. 종류 이름을 하나라도 다르게
 * 적으면 버튼이 영영 진행 중으로 보이지 않을 뿐 오류는 나지 않아, 문법을 한 자리에 둔다.
 */
type CliTaskKind = "check" | CliActionKind;

function cliTaskKey(kind: CliTaskKind, provider: ProviderId): string {
  return `${kind}-${provider}`;
}

function useProviderCliUpdates(active: boolean, access: WebAccessStatus | null, canManage: boolean) {
  const [cliStatuses, setCliStatuses] = useState<ProviderCliUpdateStatus[] | null>(null);
  const [cliBusy, setCliBusy] = useState<string | null>(null);
  const [cliPending, setCliPending] = useState<{ kind: CliActionKind; status: ProviderCliUpdateStatus; counts: ProviderRuntimeCounts } | null>(null);
  // 업데이트 실패와 캐시 정리 실패를 서로 덮어쓰지 않도록 작업 종류까지 키에 넣는다.
  const [cliNotices, setCliNotices] = useState<Record<string, string>>({});
  const [cliErrors, setCliErrors] = useState<Record<string, string>>({});
  // 최신 버전 자동 확인도 진입마다 한 번이라 조회와 같은 때에 풀려야 한다.
  const autoCheckedRef = useRef(false);
  useLoadOnActiveEntry(active, () => loadWhileMounted(getCliUpdateStatus, (next) => {
    setCliStatuses(next);
    // 백엔드는 CLI 상태를 읽으면서 실행설정 스키마를 다시 조사한다. 채팅 화면이
    // 이미 캐시한 스키마를 최신 결과로 바꾸기 위해 탐지된 공급자만 다시 읽는다.
    for (const status of next) {
      if (status.detected) void refreshProviderOptions(status.provider).catch(() => undefined);
    }
  }, (message) => failCli("status", message)), () => { autoCheckedRef.current = false; });

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
          failCli(cliTaskKey("check", target.provider), errorText(cause));
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
    await runCliAction(cliTaskKey("check", status.provider), async () => {
      applyCliStatus(await checkProviderCliUpdate(status.provider));
    });
  };

  // 업데이트와 캐시 정리는 실행 직전 대상 수를 다시 조회하고, 종료할 런타임이 있으면
  // 확인을 받는다. 실제 종료는 백엔드가 계정 전환과 같은 정책으로 다시 수행한다.
  const requestCliAction = async (kind: CliActionKind, status: ProviderCliUpdateStatus) => {
    if (cliBusy) return;
    const key = cliTaskKey(kind, status.provider);
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
    const key = cliTaskKey(kind, status.provider);
    const action = cliActions[kind];
    setCliPending(null);
    // 업데이트와 캐시 정리는 요청이 성공해도 영수증이 실패를 담고 올 수 있다. 그때는
    // 예외가 아니라 오류 문구로 남겨야 하므로, 영수증을 읽어 무엇을 남길지 정하는 일은
    // 작업 표에 맡기고 여기서는 그 판정을 안내·오류 자리에 옮겨 적기만 한다. 왕복 자체가
    // 실패한 경우의 문구만 어느 작업이었는지 붙여 다시 적는다.
    await runCliAction(key, async () => {
      const outcome = await action.run(status.provider);
      applyCliStatus(outcome.status);
      if (outcome.failure) failCli(key, outcome.failure);
      else noteCli(key, outcome.notice);
    }, (message) => `${action.failurePrefix}: ${message}`);
  };

  const cliAlert = cliUpdateAlert(cliStatuses ?? []);
  return {
    statuses: cliStatuses,
    busy: cliBusy,
    pending: cliPending,
    notices: cliNotices,
    errors: cliErrors,
    alert: cliAlert,
    setPending: setCliPending,
    check: checkCliUpdate,
    request: requestCliAction,
    perform: performCliAction,
  };
}

/**
 * 계정 추가·재인증 로그인 한 판의 상태와 절차.
 *
 * 시작·취소·저장 세 절차가 같은 세 값(진행 중인 로그인 세션·표시명·CLI 정상 종료 여부)을
 * 짝지어 바꾸는데, 그 값들이 계정 카드의 목록·도구 요약·CLI 업데이트 상태와 한 덩어리로
 * 섞여 있어 어느 자리가 로그인 한 판에 속하는지 읽어내기 어려웠다. 세 값과 세 절차만 이
 * 훅으로 떼면 부르는 쪽에는 "어느 공급자로 시작할지"만 남는다.
 *
 * busy 잠금과 안내·오류 자리는 그대로 계정 카드의 것이다. 로그인도 다른 계정 작업과 같은
 * 잠금 아래에서 돌아야 하므로 껍데기(`runAccountTask`)를 통째로 받아 쓴다.
 */
function useAccountLogin({ run, onAccountsChange, onError, onNotice }: {
  /** 카드의 `useCardTask` 실행기. 실패 문구는 카드가 이미 배너에 적으므로 여기서는 버린다. */
  run: (key: string, action: () => Promise<void>) => Promise<unknown>;
  onAccountsChange: (snapshot: AccountSnapshot) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const { text } = useI18n();
  const [session, setSession] = useState<AccountLoginSessionView | null>(null);
  const [label, setLabel] = useState("");
  const [complete, setComplete] = useState(false);

  const begin = async (provider: ProviderId, account?: ProviderAccountView) => {
    setComplete(false);
    await run(account?.id ?? provider, async () => {
      setSession(await beginProviderAccountLogin(provider, account?.id));
      setLabel(account?.displayName ?? "");
    });
  };

  const close = async () => {
    if (!session) return;
    const id = session.id;
    setSession(null);
    setComplete(false);
    try { await cancelProviderAccountLogin(id); }
    catch (cause) { onError(errorText(cause)); }
  };

  const finish = async () => {
    if (!session) return;
    if (!complete) {
      onError(session.provider === "codex"
        ? text("브라우저에서 일회용 코드 입력을 마치고 CLI가 정상 종료될 때까지 기다려 주세요.", "Please finish entering the one-time code in your browser and wait until the CLI exits cleanly.")
        : text("브라우저 인증 코드를 로그인 터미널에 전송하고 CLI가 정상 종료될 때까지 기다려 주세요.", "Please send the browser authorization code to the login terminal and wait until the CLI exits cleanly."));
      return;
    }
    const id = session.id;
    const reauthentication = Boolean(session.accountId);
    await run(id, async () => {
      const snapshot = await finishProviderAccountLogin(id, label.trim() || null);
      onAccountsChange(snapshot);
      setSession(null);
      setComplete(false);
      onNotice(reauthentication
        ? text("로그인 정보를 저장했습니다. 이 계정의 다음 실행부터 새 자격증명을 씁니다.", "Login credentials saved. New credentials will be used from the next run of this account.")
        : text("로그인 정보를 저장하고 계정 등록을 완료했습니다.", "Saved login credentials and completed account registration."));
    });
  };

  return { session, label, setLabel, complete, setComplete, begin, close, finish };
}

/**
 * 로그인을 끝내려면 무엇을 해야 하는지 한 줄. 공급자마다 브라우저와 터미널이 나눠 맡는
 * 몫이 달라 갈린다.
 */
function loginCompletionHint(provider: ProviderId, remote: boolean): string {
  if (provider === "antigravity") {
    return runtimeText("브라우저 인증 후 표시된 코드를 60초 안에 터미널로 전송하세요. 시간을 넘기면 CLI가 끝나므로 취소하고 다시 시작해야 합니다.", "Send the code shown after browser authorization to the terminal within 60 seconds. If time expires, the CLI terminates and you must cancel and start again.");
  }
  if (provider !== "codex") {
    return runtimeText("브라우저 인증 후 표시된 코드를 터미널에 전송하세요. CLI가 정상 종료되어야 저장할 수 있습니다.", "Send the code shown after browser authorization to the terminal. You can save once the CLI exits cleanly.");
  }
  return remote
    ? runtimeText("터미널의 링크를 브라우저에서 열고 표시된 일회용 코드를 입력하세요. CLI가 정상 종료되어야 저장할 수 있습니다.", "Open the link from the terminal in your browser and enter the one-time code. You can save once the CLI exits cleanly.")
    : runtimeText("이 컴퓨터의 브라우저에서 로그인만 마치세요. CLI가 정상 종료되어야 저장할 수 있습니다.", "Complete the login in your browser on this computer. You can save once the CLI exits cleanly.");
}

/** 로그인 터미널 한 판을 담는 서랍. 그리는 일만 하고 상태는 `useAccountLogin`이 쥔다. */
function AccountLoginDrawer({ login, label, complete, remote, saving, error, onLabelChange, onCompletionChange, onClose, onFinish }: {
  login: AccountLoginSessionView;
  label: string;
  complete: boolean;
  /** 원격 UI 여부. 안내 문구가 Codex 일회용 코드 경로와 브라우저 경로로 갈린다. */
  remote: boolean;
  saving: boolean;
  error: string | null;
  onLabelChange: (label: string) => void;
  onCompletionChange: (complete: boolean) => void;
  onClose: () => void;
  onFinish: () => void;
}) {
  const { text } = useI18n();
  return <Drawer title={<><SourceBadge source={login.provider} /><span>{login.accountId ? text("계정 재인증", "Re-authenticate account") : text("계정 추가", "Add account")}</span></>} onClose={onClose}>
    <label className="account-login-label"><span>{text("표시명", "Display name")}</span><input value={label} onChange={(event) => onLabelChange(event.target.value)} placeholder={text("비워두면 공급자 계정 이름 사용", "Leave blank to use provider account name")} /></label>
    <AccountLoginTerminalPanel login={login} remote={remote} onCompletionChange={onCompletionChange} />
    {!complete && <p className="account-login-completion-hint">{loginCompletionHint(login.provider, remote)}</p>}
    {error && <ErrorBanner message={error} />}
    <div className="cli-connect-actions"><button className="button" type="button" disabled={saving} onClick={onClose}>{text("취소", "Cancel")}</button><button className="button primary" type="button" disabled={saving || !complete} onClick={onFinish}>{saving ? text("저장 중…", "Saving…") : text("로그인 완료 저장", "Save login")}</button></div>
  </Drawer>;
}

/**
 * 계정 행이 부르는 변경 동작을 한자리에 모은 훅.
 *
 * `CliConnectionSettingsSection`은 CLI 탐지·업데이트·계정 도구·Antigravity 사용량까지 함께
 * 그리는 큰 구획이라, 계정 하나를 바꾸는 절차(낙관적 반영과 되돌리기, 확인 대화상자, 결과
 * 문구)까지 같은 본문에 두면 화면 구조가 그 사이에 파묻힌다. 상태는 그대로 구획이 쥐고,
 * 그 상태를 쓰는 동작만 여기로 옮긴다 — 동작은 바뀌지 않는다.
 */
/**
 * 계정 작업 한 건의 잠금 키. 계정 카드는 작업 하나만 돌리고 그 키로 어느 행의 무엇이
 * 진행 중인지 판단하는데, `종류-계정id` 문자열을 거는 쪽(작업 훅·계정 목록)과 읽는 쪽
 * (계정 행)이 일곱 종류를 각자 손으로 적고 있었다. 종류 이름이 어긋나면 잠금은 걸리되
 * 그 행의 버튼만 진행 중 표시를 놓치는, 오류 없이 지나가는 어긋남이 된다. 종류를 이름
 * 붙은 갈래로 좁히고 문법은 이 한 자리에 둔다.
 */
type AccountTaskKind = "active" | "validate" | "disabled" | "usage" | "reset-credit" | "delete" | "label" | "note";

function accountTaskKey(kind: AccountTaskKind, accountId: string): string {
  return `${kind}-${accountId}`;
}

function useAccountActions({ accounts, busy, onAccountsChange, run, setError, setNotice, confirm }: {
  accounts: AccountSnapshot | null;
  busy: string | null;
  onAccountsChange: (snapshot: AccountSnapshot) => void;
  run: ReturnType<typeof useCardTask<string>>["run"];
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const { text } = useI18n();

  const mutate = async (
    key: string,
    action: () => Promise<AccountSnapshot>,
    options: { confirm?: (() => Promise<boolean>) | null } = {},
  ) => {
    if (busy) return;
    await run(key, async () => { onAccountsChange(await action()); }, options);
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

  // 스냅샷 최상위 설정 네 가지는 값 하나를 낙관적으로 갈아 끼우고 같은 이름의 저장 요청을
  // 보내는 모양이 같다. 어느 칸을 바꾸는지만 받아 그 껍데기를 여기서 만든다.
  const applySnapshotSetting = <K extends keyof AccountSnapshot>(
    key: K,
    value: AccountSnapshot[K],
    save: () => Promise<AccountSnapshot>,
  ) => applySetting((current) => ({ ...current, [key]: value }), save);

  // 별칭과 메모는 저장 대상만 다르고 절차가 같다. 저장 실패는 카드 하단이 아니라 편집
  // 대화상자 안에서 보여야 하므로 오류 문구를 그대로 돌려준다.
  const saveAccountText = async (
    field: "label" | "note",
    account: ProviderAccountView,
    value: string | null,
  ): Promise<string | null> => {
    if (busy) return text("다른 계정 작업이 끝난 뒤 다시 저장하세요.", "Please wait until the other account operation completes before saving.");
    const save = field === "label" ? setProviderAccountLabel : setProviderAccountNote;
    // 문구를 카드 하단 배너가 아니라 편집 대화상자 안에 적어야 해서 조용히 돌려받는다.
    return run(accountTaskKey(field, account.id), async () => {
      onAccountsChange(await save(account.id, value));
    }, { quiet: true });
  };

  // 활성 계정 변경: 자격증명을 바꾸지 않으므로 실행 중 세션을 종료하거나 확인을 받을 이유가
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
    await run(accountTaskKey("reset-credit", account.id), async () => {
      const { outcome, accounts } = await consumeAccountResetCredit(account.id);
      onAccountsChange(accounts);
      setNotice(outcome === "reset"
        ? `${account.displayName}${text("의 사용량 한도를 초기화했습니다.", "'s usage limit has been reset.")}`
        : outcome === "nothingToReset"
          ? text("지금 초기화할 수 있는 창이 없어 크레딧을 쓰지 않았습니다. 한도를 더 쓴 뒤 다시 시도하세요.", "No exhausted windows to reset; credit was not consumed. Try again after consuming more limit.")
          : outcome === "noCredit"
            ? text("쓸 수 있는 리셋 크레딧이 없습니다.", "No reset credits available.")
            : text("같은 요청이 이미 처리되어 크레딧을 추가로 쓰지 않았습니다.", "The same request was already processed; no additional credit was consumed."));
    }, {
      confirm: () => confirm({
        title: text("한도 리셋 크레딧 사용", "Use limit reset credit"),
        message: `${account.displayName}${text("의 한도 리셋 크레딧 한 장을 사용합니다. 사용 후 ", "'s limit reset credit will be used. Remaining after use: ")}${Math.max(remaining - 1, 0)}${text("장이 남습니다.\n지금 소진된 창이 없으면 크레딧을 쓰지 않고 물립니다. 계속할까요?", ".\nIf no window is currently exhausted, the credit will not be consumed. Continue?")}`,
        warning: text("크레딧 사용은 되돌릴 수 없습니다.", "Credit usage cannot be undone."),
        confirmLabel: text("크레딧 사용", "Use credit"),
        tone: "danger",
      }),
    });
  };

  const activateAccount = async (account: ProviderAccountView) => {
    if (busy) return;
    await run(accountTaskKey("active", account.id), async () => {
      const receipt = await switchActiveProviderAccount(account.id);
      let nextSnapshot = receipt.snapshot;
      let usageRefreshNote = "";
      if (!receipt.usageRefreshed) {
        try {
          nextSnapshot = await refreshProviderAccountUsage(account.id);
        } catch (cause) {
          usageRefreshNote = ` ${text("사용량은 갱신하지 못했습니다", "Could not refresh usage")}: ${errorText(cause)}`;
        }
      }
      onAccountsChange(nextSnapshot);
      setNotice(`${text("활성 계정을", "Changed active account to")} ${account.displayName}${text("(으)로 변경했습니다. 실행 중인 세션은 그대로 유지됩니다.", ". Running sessions remain unchanged.")}${usageRefreshNote}`);
    });
  };

  /**
   * 계정 등록 삭제. 되돌릴 수 없는 자격증명 삭제라 먼저 확인을 받는다. 확인 절차를 가진
   * 다른 계정 작업(리셋 크레딧 사용)과 같은 자리에 두어, 행을 그리는 쪽이 확인 문구까지
   * 떠안지 않게 한다.
   */
  const deleteAccount = (account: ProviderAccountView) => {
    // 자격증명 격리가 들어온 뒤로 이 계정의 대화 원문이 계정 프로필 안에 쌓인다. 프로필은
    // 등록과 함께 통째로 지워지므로, 무엇이 남고 무엇이 사라지는지 공급자별로 적어 확인을
    // 받는다(`AGENTS.md` C12-9). Claude 프로필은 Keychain 항목뿐이라 지워질 원문이 없다.
    const keepsTranscripts = account.provider === "claude";
    const message = keepsTranscripts
      ? text(
        "이 계정의 등록과 보안 저장소 자격증명을 삭제합니다.\n공급자 대화 히스토리는 지워지지 않습니다.",
        "This removes the account registration and its stored credential.\nProvider conversation history is kept.",
      )
      : account.provider === "antigravity"
        ? text(
          "이 계정의 등록과 보안 저장소 자격증명을 삭제합니다.\n이 계정 홈에 저장된 대화는 목록과 본문이 함께 사라집니다. 공유 CLI 홈의 대화는 그대로 남습니다.",
          "This removes the account registration and its stored credential.\nConversations stored in this account's home disappear from both the list and their contents. Conversations in the shared CLI home are kept.",
        )
        : text(
          "이 계정의 등록과 보안 저장소 자격증명을 삭제합니다.\n이 계정 프로필에 저장된 대화 원문도 함께 삭제됩니다. 세션 목록은 공유 홈에 남아 있어 제목은 그대로 보입니다.",
          "This removes the account registration and its stored credential.\nConversation transcripts stored in this account's profile are deleted with it. The session list lives in the shared home, so titles remain visible.",
        );
    return mutate(accountTaskKey("delete", account.id), () => deleteProviderAccount(account.id), {
      confirm: () => confirm({
        title: text("계정 등록 삭제", "Delete account registration"),
        message,
        items: [account.displayName],
        warning: keepsTranscripts
          ? text("삭제한 자격증명은 되돌릴 수 없고 다시 로그인해야 합니다.", "The deleted credential cannot be restored; you must sign in again.")
          : text("삭제한 자격증명과 대화 원문은 되돌릴 수 없습니다. 계정은 다시 로그인해야 합니다.", "The deleted credential and transcripts cannot be restored; you must sign in again."),
        confirmLabel: text("삭제", "Delete"),
        tone: "danger",
      }),
    });
  };

  return { mutate, applySetting, patchAccount, applySnapshotSetting, saveAccountText, consumeResetCredit, activateAccount, deleteAccount };
}

/** CLI 갱신 상태 세 갈래를 한 알림 문장으로 잇는 표시 규칙. */
function CliUpdateNotice({ alert }: { alert: CliUpdateAlert }) {
  const { text } = useI18n();
  if (!hasCliUpdateAlert(alert)) return null;
  // 표시 이름은 `format`의 표 하나가 정본이다. 여기서 삼항으로 다시 세면 표에 없는
  // 공급자가 식별자 그대로("local") 문장에 섞여 나온다.
  const providerLabel = sourceName;

  return <div className="cli-update-alert" role="status">
    <Download size={15} aria-hidden="true" />
    <span>
      <strong>{text("CLI 업데이트 알림", "CLI update notice")}</strong>
      <small>
        {alert.updatable.length > 0 && text(
          `${alert.updatable.map(providerLabel).join(", ")} CLI에 새 버전이 있습니다.`,
          `A newer version is available for ${alert.updatable.map(providerLabel).join(", ")}.`,
        )}
        {alert.updatable.length > 0 && alert.cacheMismatched.length > 0 && " "}
        {alert.cacheMismatched.length > 0 && text(
          `${alert.cacheMismatched.map(providerLabel).join(", ")} 모델 캐시가 실행 버전과 다른 클라이언트 버전으로 기록되어 있습니다(모델 캐시 스키마 불일치).`,
          `The model cache of ${alert.cacheMismatched.map(providerLabel).join(", ")} was written by a different client version (model cache schema mismatch).`,
        )}
        {alert.checkFailed.length > 0 && (alert.updatable.length > 0 || alert.cacheMismatched.length > 0) && " "}
        {alert.checkFailed.length > 0 && text(
          `${alert.checkFailed.map(providerLabel).join(", ")} 버전을 확인하지 못해 업데이트 필요 여부를 판단할 수 없습니다.`,
          `Could not read the version of ${alert.checkFailed.map(providerLabel).join(", ")}, so update availability is unknown.`,
        )}
      </small>
    </span>
  </div>;
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
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, setError, run: runAccountTask } = useCardTask<string>(() => setNotice(null));
  const [accountTools, setAccountTools] = useState<AccountToolsSnapshot | null>(null);
  const canManage = access?.writable === true;
  const cli = useProviderCliUpdates(active, access, canManage);

  useEffect(() => loadWhileMounted(getWebAccessStatus, setAccess, setError), []);

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
    // 도구 요약 조회가 실패해도 계정 관리 화면 자체는 계속 쓸 수 있어야 한다.
    return loadWhileMounted(getAccountTools, setAccountTools, () => setAccountTools(null));
  }, [Boolean(accounts), accountRevision, observedRevision]);


  const accountLogin = useAccountLogin({
    run: runAccountTask,
    onAccountsChange,
    onError: setError,
    onNotice: setNotice,
  });
  const login = accountLogin.session;
  const accountActions = useAccountActions({ accounts, busy, onAccountsChange, run: runAccountTask, setError, setNotice, confirm });

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
        <CliUpdateNotice alert={cli.alert} />
        {cli.errors.status && <ErrorBanner message={cli.errors.status} />}
        <div className="cli-settings-list account-settings-list">
          {providers.map((provider) => <CliProviderCard
            key={provider.provider}
            provider={provider}
            accounts={accounts}
            canManage={canManage}
            busy={busy}
            cli={cli}
            accountTools={accountTools}
            antigravityUsage={antigravityUsage}
            antigravityLoading={antigravityLoading}
            onRefreshAntigravityUsage={refreshAntigravityUsage}
            onConnect={onConnect}
            accountLogin={accountLogin}
            accountActions={accountActions}
          />)}
        </div>
        <AccountAdvancedSettings snapshot={accounts} editable={canManage} onApply={accountActions.applySnapshotSetting} />
        {notice && <p className="account-action-notice" role="status">{notice}</p>}
        {error && !login && <ErrorBanner message={error} />}
      </div>
    </section>
    {/* 수집 설정은 계정·연결과 같은 CLI 단위 결정이라 같은 탭에 잇대어 세운다. */}
    <TelemetrySettingsCard active={active} />
    {login && <AccountLoginDrawer
      login={login}
      label={accountLogin.label}
      complete={accountLogin.complete}
      remote={access?.remote === true}
      saving={busy === login.id}
      error={error}
      onLabelChange={accountLogin.setLabel}
      onCompletionChange={accountLogin.setComplete}
      onClose={() => void accountLogin.close()}
      onFinish={() => void accountLogin.finish()}
    />}
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
  const { text } = useI18n();
  const hintTitle = helpTitle ?? title;
  return (
    <div className="account-advanced-toggle">
      <span><strong>{title}<HelpHint label={`${hintTitle} ${text("설명", "description")}`} title={hintTitle}>{help}</HelpHint></strong></span>
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

/**
 * 계정 관리 카드 아래쪽 고급 설정 묶음(페일오버 방식·분산 교체·이어가기 계정·전환 후 복원).
 * 네 행 모두 계정 스냅샷의 최상위 값 하나만 읽고 쓰는 자리라, 계정 목록·로그인·CLI 업데이트
 * 상태를 모두 쥔 위쪽 구획에 섞여 있을 이유가 없어 여기로 옮긴다. 조작 가능 여부도 네 행이
 * 같은 판정(쓰기 권한과 스냅샷 도착 여부)을 각자 적던 것을 한 줄로 모은다.
 */
function AccountAdvancedSettings({ snapshot, editable, onApply }: {
  snapshot: AccountSnapshot | null;
  editable: boolean;
  onApply: <K extends keyof AccountSnapshot>(key: K, value: AccountSnapshot[K], save: () => Promise<AccountSnapshot>) => void;
}) {
  const { text } = useI18n();
  const disabled = !editable || !snapshot;
  return <>
    <AccountAdvancedSelect
      title={text("한도 페일오버 방식", "Limit failover policy")}
      help={text(
        "사용량 한도에 걸린 세션을 어느 계정으로 넘길지 정합니다. 자격증명이 계정별로 갈려 있으면 한도에 걸린 세션만 다른 계정에 다시 묶고 나머지 세션은 그대로 진행합니다. 세 방식 모두 자동전환이 켜져 있고 사용 가능하며 한도에 걸리지 않은 계정만 후보로 봅니다.",
        "Choose which account receives sessions that hit usage limits. When credentials differ by account, only limited sessions are rebound to another account while other sessions continue. All three policies only consider accounts with auto-switch enabled, available, and not limited."
      )}
      disabled={disabled}
      value={snapshot?.autoSwitchPolicy ?? "maxHeadroom"}
      options={[
        { value: "maxHeadroom", label: text("사용량 여유 최대 우선", "Most headroom first") },
        { value: "priority", label: text("지정한 우선순위 순", "Configured priority order") },
        { value: "registration", label: text("등록 순 라운드로빈", "Registration order round-robin") },
      ]}
      onChange={(value) => {
        const policy = value as AutoSwitchPolicy;
        onApply("autoSwitchPolicy", policy, () => setAutoSwitchPolicy(policy));
      }}
    />
    <AccountAdvancedSelect
      title={text("사용량 분산 교체", "Usage distribution rotation")}
      help={text(
        "계정을 100%까지 다 쓰기 전에, 활성 계정이 가장 덜 쓴 계정보다 정한 폭만큼 앞서면 그 계정으로 넘겨 사용량을 고르게 맞춥니다. 계정들이 비슷한 사용량에서 시작하면 결과적으로 이 폭만큼 쓸 때마다 순환합니다. 어느 계정으로 넘길지는 위 페일오버 방식이 정합니다. 사용량은 가장 빡빡한 창을 기준으로 보고, 사용량을 아직 읽지 못한 계정은 얼마나 뒤처졌는지 알 수 없어 후보에서 빠집니다. 실행 중인 턴은 끊지 않고 끝난 뒤에 옮기며, 새 채팅과 이어가기가 열릴 활성 계정도 함께 옮깁니다(활성 계정 지정은 그대로 둡니다). 사용량 조회 주기에 맞춰 판정하므로 격차가 벌어진 뒤 최대 5분쯤 지나 순환합니다.",
        "Before reaching 100% limit, if the active account exceeds the least-used account by a chosen margin, rotate to distribute usage evenly. When accounts start near equal usage, they cycle after each margin. The failover policy decides the target account. Calculations use the tightest window; accounts with unread usage are excluded. In-flight turns complete before rotating, and the active account for new sessions rotates alongside (preserving manual selection). Evaluated on usage poll intervals, rotating within ~5 minutes of a widening gap."
      )}
      disabled={disabled}
      value={String(snapshot?.autoSwitchUsageGapPercent ?? "")}
      options={[
        { value: "", label: text("쓰지 않음 (100% 도달 시에만)", "Disabled (only at 100%)") },
        ...AUTO_SWITCH_USAGE_GAP_CHOICES.map((percent) => ({
          value: String(percent),
          label: `${percent}%${text(" 앞서면 교체", " ahead rotate")}`,
        })),
      ]}
      onChange={(value) => {
        const percent = value === "" ? null : Number.parseInt(value, 10);
        onApply("autoSwitchUsageGapPercent", percent, () => setAutoSwitchUsageGap(percent));
      }}
    />
    <AccountAdvancedSelect
      title={text("이어가기 실행 계정", "Resume execution account")}
      help={text(
        "저장된 세션을 다시 열 때 어느 계정으로 실행할지 정합니다. 활성 계정으로 이어가면 활성 계정을 바꿀 때 기존 세션도 함께 옮겨지고, 마지막으로 쓴 계정으로 이어가면 세션마다 이전 계정의 한도를 계속 씁니다. 세션별로 실행 계정을 고정해 두면 이 설정과 무관하게 고정한 계정으로 실행됩니다. 이미 실행 중인 채팅은 시작 시점 계정을 유지하므로 다음 이어가기부터 적용됩니다.",
        "Choose which account runs when reopening a saved session. Resuming with the active account moves existing sessions when switching active accounts, while resuming with the last-used account preserves each session's prior account limit. Pinning an account on a session overrides this setting. Currently running chats keep their launch account and apply this on the next resume."
      )}
      disabled={disabled}
      value={snapshot?.resumeAccountPolicy ?? "activeAccount"}
      options={[
        { value: "activeAccount", label: text("활성 계정으로 이어가기", "Resume with active account") },
        { value: "lastUsedAccount", label: text("마지막으로 쓴 계정으로 이어가기", "Resume with last-used account") },
      ]}
      onChange={(value) => {
        const policy = value as ResumeAccountPolicy;
        onApply("resumeAccountPolicy", policy, () => setResumeAccountPolicy(policy));
      }}
    />
    <AccountAdvancedRow
      title={text("자동전환 후 세션 복원", "Session resume after auto-switch")}
      helpTitle={text("자동전환 후 세션 복원 동작", "Session resume after auto-switch behavior")}
      help={text(
        "사용량 한도로 계정이 자동전환되면, 그때 종료된 실행 중 채팅을 새 계정에서 이어서(resume) 다시 시작하고, 한도로 응답을 받지 못한 요청과 대기열 메시지를 순서대로 자동 재전송합니다. 진행 중이던 응답(부분 출력)과 첨부 파일은 복구되지 않습니다.",
        "When an account auto-switches due to limit, running chats terminated by the switch resume automatically under the new account, resending unfulfilled requests and queued messages in order. In-progress partial output and attachments are not recovered."
      )}
    >
      <AppToggle
        checked={snapshot?.autoSwitchResume ?? true}
        disabled={disabled}
        label={text("자동전환 후 세션 복원", "Session resume after auto-switch")}
        onChange={() => {
          if (!snapshot) return;
          const enabled = !snapshot.autoSwitchResume;
          onApply("autoSwitchResume", enabled, () => setAutoSwitchResume(enabled));
        }}
      />
    </AccountAdvancedRow>
  </>;
}

type CliActionKind = "update" | "cache";

function withoutKeys(source: Record<string, string>, keys: string[]): Record<string, string> {
  const next = { ...source };
  for (const key of keys) delete next[key];
  return next;
}

const installSourceLabels: Record<ProviderCliUpdateStatus["installSource"], string> = {
  notDetected: runtimeText("탐지되지 않음", "Not detected"),
  homebrewCask: "Homebrew cask",
  homebrewFormula: "Homebrew formula",
  npmGlobal: runtimeText("npm 전역 설치", "npm global install"),
  standalone: runtimeText("단독 설치", "Standalone install"),
};

function cliUpdateOutcomeMessage(receipt: CliUpdateReceipt): string {
  const prefix = receipt.outcome === "updated"
    ? runtimeText("업데이트 완료", "Update completed")
    : receipt.outcome === "alreadyLatest"
      ? runtimeText("업데이트 없음", "Already up to date")
      : receipt.outcome === "verificationFailed"
        ? runtimeText("업데이트 검증 실패", "Update verification failed")
        : runtimeText("업데이트 실패", "Update failed");
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
    return `${runtimeText("모델 캐시 정리 실패", "Model cache cleanup failed")}: ${failures.join(" · ")}`;
  }
  if (receipt.removedCount === 0) {
    const skipped = receipt.entries.map((entry) => entry.skippedReason).filter(Boolean);
    return `${runtimeText("모델 캐시를 정리하지 않았습니다.", "Did not clean model cache.")} ${skipped.join(" · ")}`;
  }
  const removed = receipt.entries.filter((entry) => entry.removed);
  const currentText = runtimeText("현재", "current");
  return `${runtimeText("모델 캐시를 삭제했습니다.", "Deleted model cache.")} (${receipt.removedCount} items: ${removed
    .map((entry) => `${entry.label}${entry.previousCacheClientVersion ? ` ${entry.previousCacheClientVersion}` : ""}`)
    .join(", ")}). ${runtimeText("다음 실행에서 다시 생성됩니다.", "Will be recreated on next run based on version")} ${receipt.status.currentVersion ?? currentText}.`;
}

function stopSummaryText(stopped: ProviderRuntimeStopSummary): string {
  const parts: string[] = [];
  if (stopped.chatStoppedCount > 0) parts.push(`${runtimeText("관리 세션", "Managed sessions")} ${stopped.chatStoppedCount}`);
  if (stopped.terminalStoppedCount > 0) parts.push(`${runtimeText("관리 터미널", "Managed terminals")} ${stopped.terminalStoppedCount}`);
  if (stopped.externalTerminatedCount > 0) parts.push(`${runtimeText("외부 프로세스", "External processes")} ${stopped.externalTerminatedCount}`);
  const failure = stopped.externalFailedCount > 0 ? ` ${runtimeText("외부 프로세스는 종료되지 않았습니다.", "external processes were not stopped.")} (${stopped.externalFailedCount})` : "";
  // 조회 자체가 안 된 경우. 작업은 그대로 진행했으므로 실패가 아니라 건너뛴 사실만 알린다.
  const skipped = stopped.externalSkippedReason
    ? ` ${runtimeText("외부 프로세스는 확인하지 못해 정리를 건너뛰었습니다.", "External processes could not be inspected, so cleanup was skipped.")} (${stopped.externalSkippedReason})`
    : "";
  return (parts.length > 0 ? ` ${parts.join(" · ")} ${runtimeText("종료했습니다.", "stopped.")}${failure}` : failure) + skipped;
}

/**
 * CLI 작업 종류(업데이트·모델 캐시 정리)마다 달라지는 것들을 모은 표.
 *
 * 두 작업은 "요청하고, 돌아온 영수증의 상태를 카드에 갈아 끼우고, 요약에 종료 알림을
 * 이어 붙이고, 영수증이 실패를 담고 있으면 안내 대신 오류로 남긴다"는 절차가 같고 다른
 * 것은 부르는 함수·요약 문구·실패 판정뿐이다. 실행 쪽(performCliAction)과 확인 상자
 * (ProviderCliUpdatePanel)가 각자 `kind === "update"` 삼항으로 여섯 자리에서 갈라지던 것을
 * 종류당 한 칸으로 모은다.
 */
const cliActions: Record<CliActionKind, {
  /** 왕복 자체가 실패했을 때 오류 문구 앞에 붙일 말. */
  failurePrefix: string;
  /** 종료 확인 상자의 제목과, 무엇을 실행하는지 알리는 꼬리 문장. */
  confirmTitle: string;
  confirmAction: (status: ProviderCliUpdateStatus) => string;
  /** 확인 상자의 aria-label에 쓰는 작업 이름. */
  noun: string;
  run: (provider: ProviderId) => Promise<{
    status: ProviderCliUpdateStatus;
    notice: string;
    /** 영수증이 실패를 담고 왔을 때 오류 자리에 적을 문구. 성공이면 null. */
    failure: string | null;
  }>;
}> = {
  update: {
    failurePrefix: runtimeText("업데이트 실패", "Update failed"),
    confirmTitle: runtimeText("업데이트 전 종료 확인", "Confirm shutdown before update"),
    confirmAction: (status) => ` ${status.updateCommandLabel ?? runtimeText("업데이트", "update")}${runtimeText("를 실행합니다.", " will be run.")}`,
    noun: runtimeText("업데이트", "update"),
    run: async (provider) => {
      const receipt = await updateProviderCli(provider);
      const message = `${cliUpdateOutcomeMessage(receipt)}${stopSummaryText(receipt.stopped)}`;
      const failed = receipt.outcome === "failed" || receipt.outcome === "verificationFailed";
      return {
        status: receipt.status,
        notice: message,
        failure: failed ? `${message}${receipt.failureOutput ? `\n${receipt.failureOutput}` : ""}` : null,
      };
    },
  },
  cache: {
    failurePrefix: runtimeText("모델 캐시 정리 실패", "Model cache cleanup failed"),
    confirmTitle: runtimeText("캐시 정리 전 종료 확인", "Confirm shutdown before cache cleanup"),
    confirmAction: () => ` ${runtimeText("모델 캐시를 정리합니다.", "cleans the model cache.")}`,
    noun: runtimeText("모델 캐시 정리", "model cache cleanup"),
    run: async (provider) => {
      const receipt = await clearProviderModelCaches(provider);
      const message = `${cacheCleanupMessage(receipt)}${stopSummaryText(receipt.stopped)}`;
      return { status: receipt.status, notice: message, failure: receipt.failedCount > 0 ? message : null };
    },
  },
};

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
  const checking = busyKey === cliTaskKey("check", status.provider);
  const updating = busyKey === cliTaskKey("update", status.provider);
  const clearing = busyKey === cliTaskKey("cache", status.provider);
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
    {pending && <div className="account-switch-confirm" role="alertdialog" aria-label={`${status.displayName} ${cliActions[pending.kind].noun} ${text("확인", "Confirmation")}`}>
      <ShieldAlert size={16} aria-hidden="true" />
      <span>
        <strong>{cliActions[pending.kind].confirmTitle}</strong>
        <small>
          {status.displayName} {text("관리 세션", "managed sessions")} {pending.counts.chatCount}{text("개, 관리 터미널", " · managed terminals")} {pending.counts.terminalCount}{text("개, 외부 실행 프로세스", " · external processes")} {pending.counts.externalProcessCount}{text("개를 모두 종료한 뒤", " will all be stopped before")}
          {cliActions[pending.kind].confirmAction(status)}
          {" "}{text("정상 종료가 실패하면 강제 종료하며, 진행 중 응답·승인 요청은 복구되지 않을 수 있습니다. 대화 이력, 인증, 설정은 삭제하지 않습니다.", "Processes that fail to stop gracefully will be forcefully terminated; active responses and approval requests may not be recovered. Conversation history, credentials, and settings are preserved.")}
        </small>
      </span>
      <div className="account-switch-confirm-actions">
        <button className="button compact" type="button" disabled={Boolean(busyKey)} onClick={onCancelPending} autoFocus>{text("취소", "Cancel")}</button>
        <button className="button compact primary" type="button" disabled={Boolean(busyKey)} onClick={onConfirmPending}>{text("확인", "Confirm")}</button>
      </div>
    </div>}
    {notices[cliTaskKey("update", status.provider)] && <p className="account-action-notice" role="status">{notices[cliTaskKey("update", status.provider)]}</p>}
    {errors[cliTaskKey("update", status.provider)] && <ErrorBanner message={errors[cliTaskKey("update", status.provider)]} />}
    {errors[cliTaskKey("check", status.provider)] && <ErrorBanner message={errors[cliTaskKey("check", status.provider)]} />}
    {notices[cliTaskKey("cache", status.provider)] && <p className="account-action-notice" role="status">{notices[cliTaskKey("cache", status.provider)]}</p>}
    {errors[cliTaskKey("cache", status.provider)] && <ErrorBanner message={errors[cliTaskKey("cache", status.provider)]} />}
  </div>;
}

function ProviderAutoSwitchNote({ accounts, event }: { accounts: ProviderAccountView[]; event: AutoSwitchEventView }) {
  const { text } = useI18n();
  const summary = autoSwitchEventSummary(accounts, event);
  return <p className="provider-auto-switch-note"><Repeat size={12} aria-hidden="true" />{text("자동전환됨:", "Auto-switched:")} {summary.transition} · {new Date(event.at).toLocaleString()}{summary.resumedNote}</p>;
}

/**
 * 계정 행 아이콘에 쓰는 도구 아이콘 자산. 상표가 있는 서비스는 공식 표식(`badge.brand`)이
 * 먼저 서고, 이 표는 표식이 없는 서비스가 떨어지는 자리다.
 */
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
/**
 * 사용량 창 미터. 어떤 창을 그릴지는 부르는 쪽이 이미 정한 뒤라, 여기서 다시 고르거나
 * 다시 계산하지 않는다 — 표시용 창 목록을 그대로 받는다. 원래는 `usage`만 받아 자기가
 * `displayUsageWindows`를 돌렸는데, 부르는 쪽도 같은 목록이 필요해 같은 계산을 한 번 더
 * 하거나(계정 패널) 원본 창을 따로 걸러 넘겨(Antigravity 카드) 같은 판정이 두 벌로 갈렸다.
 */
function UsageMeters({ usage, windows }: { usage: AccountUsageView; windows: DisplayUsageWindow[] }) {
  const { text } = useI18n();
  if (windows.length === 0) return null;
  return <ul className="account-usage-meters">
    {windows.map((window) => {
      const percent = Math.min(100, Math.max(0, window.usedPercent));
      const unavailable = usageWindowValueUnavailable(usage, window);
      return <li className={usageLevel(percent)} key={window.label}>
        <span><em>{window.label}</em><b>{unavailable ? text("확인 불가", "Unavailable") : `${Math.round(percent)}%`}</b></span>
        <div className="progress" role="img" aria-label={unavailable ? `${window.label} ${text("사용량 확인 불가", "usage unavailable")}` : `${window.label} ${text("사용량", "usage")} ${Math.round(percent)}%`}><span style={{ width: `${unavailable ? 0 : percent}%` }} /></div>
        {window.resetsAt !== null && <small>{new Date(window.resetsAt).toLocaleString()} {unavailable ? text("초기화 후 갱신 실패", "Failed to refresh after reset") : window.resetElapsed ? text("초기화됨", "Reset") : text("초기화", "Reset")}</small>}
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
  detected,
  loading,
  onRefresh,
}: {
  usage: AccountUsageView | null;
  detected: boolean;
  loading: boolean;
  onRefresh: () => void;
}) {
  const { text } = useI18n();
  const [showModels, setShowModels] = useState(false);
  const now = Date.now();
  const windows = usage ? displayUsageWindows(usage.windows, now) : [];
  const summaryWindows = windows.filter((window) => !window.modelScoped);
  const models = windows.filter((window) => window.modelScoped);
  const unread = usage === null;
  const idle = usage?.status === "idle";
  // CLI가 없으면 조회는 시작도 못 한다. 그 사정을 실패 배너로 그리면 "요청을 처리하지
  // 못했습니다 · APP_RUNTIME"이라는 머리말과 문의용 코드가 붙어, 아직 깔지 않은 CLI가
  // 앱 장애처럼 보인다(QA #59와 같은 부류). 사전 조건은 안내 배너로 문장만 보인다.
  const notInstalled = !detected && usage?.status === "error";
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
    {notInstalled && <NoticeBanner message={text(
      "Antigravity CLI가 설치되어 있지 않아 사용량을 읽을 수 없습니다. 위 '연결'에서 CLI를 연결한 뒤 새로고침하세요.",
      "The Antigravity CLI is not installed, so usage cannot be read. Connect the CLI with 'Connect' above, then refresh.",
    )} />}
    {!notInstalled && usage?.status === "error" && <ErrorBanner message={usage.error ?? text("사용량을 읽지 못했습니다.", "Could not read usage.")} />}
    {usage?.status === "ok" && summaryWindows.length > 0 && <>
      <UsageMeters usage={usage} windows={summaryWindows} />
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
          <UsageMeters usage={usage} windows={models} />
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
  const { text } = useI18n();
  const [detailed, setDetailed] = useState(false);
  // 상세정보를 켠 동안에는 개수 제한을 풀어 모든 도구를 보여 준다.
  const { badges, overflow } = accountToolBadges(tools, detailed ? 0 : DEFAULT_ACCOUNT_TOOL_BADGE_LIMIT);
  if (badges.length === 0) return null;
  return <span className={`provider-account-tools${detailed ? " detailed" : ""}`} aria-label={text("이 계정에서 사용할 수 있는 도구", "Tools available in this account")}>
    <button
      className={`provider-account-tool toggle${detailed ? " active" : ""}`}
      type="button"
      aria-pressed={detailed}
      aria-label={detailed ? text("도구 상세정보 숨기기", "Hide tool details") : text("도구 상세정보 표시", "Show tool details")}
      title={detailed ? text("도구 이름을 숨기고 아이콘만 봅니다", "Hide tool names and view icons only") : text("아이콘과 도구 이름을 모두 봅니다", "View both icons and tool names")}
      onClick={() => setDetailed((on) => !on)}
    >{detailed ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}</button>
    {badges.map((badge) => {
      const Icon = accountToolIcons[badge.icon];
      return <span className={`provider-account-tool${badge.unverified ? " unverified" : ""}`} key={badge.key} title={badge.label}>
        {badge.brand ? <BrandMark name={badge.brand} size={13} /> : <Icon size={13} aria-hidden="true" />}
        <em>{badge.label}</em>
      </span>;
    })}
    {overflow > 0 && <span className="provider-account-tool more" title={`${text("외", "and")} ${overflow}${text("개", " more")}`}>+{overflow}</span>}
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
        <UsageMeters usage={home.usage} windows={displayUsageWindows(home.usage.windows, now)} />
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

type AccountDraftEditor = ReturnType<typeof useAccountDraftEditor>;

// 표시 이름과 메모 편집 대화상자는 제목·입력 칸·안내문만 다르고 나머지가 같다. 바닥줄의
// 글자 수 표시와 취소·저장 버튼, 닫기 경로, 오류 자리를 두 벌 적어 두던 것을 여기로 모으고,
// 입력 칸과 그 아래 붙는 설명 목록만 children으로 받는다.
function AccountDraftModal({ title, editor, state, maxChars, saving, saveLabel, hint, children }: {
  title: ReactNode;
  editor: AccountDraftEditor;
  state: { length: number; tooLong: boolean; canSave: boolean };
  maxChars: number;
  saving: boolean;
  saveLabel: string;
  hint: string;
  children: ReactNode;
}) {
  const { text } = useI18n();
  return <Modal
    title={title}
    onClose={editor.close}
    footer={<div className="account-note-actions">
      <small className={state.tooLong ? "error" : ""}>{state.tooLong
        ? `${maxChars}${text("자까지 저장할 수 있습니다 (현재", " characters max (currently ")} ${state.length}${text("자)", ")")}`
        : `${state.length}/${maxChars}${text("자", " chars")}`}</small>
      <button className="button" type="button" disabled={saving} onClick={editor.close}>{text("취소", "Cancel")}</button>
      <button className="button primary" type="button" disabled={saving || !state.canSave} onClick={() => void editor.save()}>{saving ? text("저장 중…", "Saving…") : saveLabel}</button>
    </div>}
  >
    {children}
    <p className="account-note-hint">{hint}</p>
    {editor.error && <ErrorBanner message={editor.error} />}
  </Modal>;
}

/**
 * 계정 행의 관리 메뉴. 열고 닫는 상태와 바깥 클릭·Esc 처리, 항목마다 다른 비활성 사유
 * 문구는 모두 이 메뉴 안에서만 쓰인다. 계정 행 본체와 섞여 있어 행이 무엇을 그리는지
 * 읽기 어려웠던 것을 그대로 이 컴포넌트로 내렸다.
 */
function ProviderAccountMenu({ account, busy, activating, authFailed, autoSwitchPolicy, onActivate, onReauthenticate, onToggleDisabled, onToggleAutoSwitch, onChangePriority, onDelete, onEditLabel, onEditNote }: {
  account: ProviderAccountView;
  busy: boolean;
  activating: boolean;
  authFailed: boolean;
  autoSwitchPolicy: AutoSwitchPolicy;
  onActivate: () => void;
  onReauthenticate: () => void;
  onToggleDisabled: () => void;
  onToggleAutoSwitch: () => void;
  onChangePriority: (priority: number | null) => void;
  onDelete: () => void;
  onEditLabel: () => void;
  onEditNote: () => void;
}) {
  const { text } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // 활성 계정과 이 계정으로 실행 중인 런타임만 삭제를 막는다. 다른 계정의 런타임은
  // 무관하다 — 자격증명이 계정별로 갈려 있다.
  const canDelete = !account.isActive && account.runtimeCount === 0;
  // 활성 계정 지정은 자주 쓰는 동작이 아니라 관리 메뉴 안에 둔다. 지금 활성 계정인지는
  // '활성 계정' 배지가 알리고, 메뉴 항목은 그 상태에서 비활성으로 남는다.
  const activationTitle = account.isActive
    ? text("이미 활성 계정입니다", "Already the active account")
    : account.disabled
      ? text("비활성화된 계정은 활성 계정으로 지정할 수 없습니다. 먼저 비활성화를 해제하세요", "Disabled accounts cannot be set as active. Enable the account first")
      : authFailed
        ? text("재인증이 필요한 계정은 활성 계정으로 지정할 수 없습니다", "Accounts requiring re-authentication cannot be set as active")
        : text("이 계정을 새 채팅·터미널의 활성 실행 계정으로 지정합니다. 자격증명은 바뀌지 않고 실행 중인 세션도 그대로입니다", "Set this account as the active execution account for new chats and terminals. Credentials and running sessions remain unchanged");
  useEscapeToClose(() => setMenuOpen(false), menuOpen);
  useOutsidePointerToClose(() => setMenuOpen(false), menuOpen, [menuRef]);
  const deleteHint = canDelete
    ? text("계정 등록과 자격증명을 삭제합니다", "Delete account registration and credentials")
    : account.runtimeCount > 0
      ? text("이 계정으로 실행 중인 런타임이 있어 삭제할 수 없습니다", "Cannot delete while runtimes are running with this account")
      : text("활성 계정은 삭제할 수 없습니다. 먼저 다른 계정을 활성으로 선택하세요", "Cannot delete active account. Choose another active account first");
  const runMenuAction = (action: () => void) => { setMenuOpen(false); action(); };
  return <div className="provider-account-controls">
    {activating && <span className="provider-account-activating" role="status" title={text("활성 계정을 바꾸고 있습니다", "Switching active account")}><LoaderCircle size={13} className="spin" aria-hidden="true" />{text("변경 중…", "Changing…")}</span>}
    <div className="account-menu" ref={menuRef}>
      <button className={`icon-button compact${menuOpen ? " active" : ""}`} type="button" disabled={busy} aria-haspopup="menu" aria-expanded={menuOpen} aria-label={text("계정 관리 메뉴", "Account management menu")} title={text("계정 관리", "Manage account")} onClick={() => setMenuOpen((open) => !open)}><Settings size={13} /></button>
      {menuOpen && <div className="account-menu-panel" role="menu" aria-label={`${account.displayName} ${text("계정 관리", "Manage account")}`}>
        <button type="button" role="menuitem" disabled={busy || account.isActive || account.disabled || authFailed} title={activationTitle} onClick={() => runMenuAction(onActivate)}><CircleCheck size={13} aria-hidden="true" />{text("활성계정설정", "Set active account")}</button>
        <span className="account-menu-divider" role="separator" />
        <button type="button" role="menuitem" disabled={busy} title={text("목록에 보일 이름을 직접 정합니다. 같은 이름을 쓰는 계정을 구분할 때 씁니다", "Set a custom display name in the list. Useful to distinguish accounts with the same name")} onClick={() => runMenuAction(onEditLabel)}><PenLine size={13} aria-hidden="true" />{text("표시 이름 변경", "Change display name")}</button>
        {!authFailed && <button type="button" role="menuitem" disabled={busy} title={text("공급자 CLI 로그인을 다시 실행합니다", "Rerun provider CLI login")} onClick={() => runMenuAction(onReauthenticate)}><KeyRound size={13} aria-hidden="true" />{text("재인증", "Re-authenticate")}</button>}
        <button type="button" role="menuitem" disabled={busy || account.isActive} title={account.isActive ? text("활성 계정은 비활성화할 수 없습니다. 먼저 다른 계정을 활성으로 선택하세요", "Active account cannot be disabled. Select another active account first") : undefined} onClick={() => runMenuAction(onToggleDisabled)}>{account.disabled ? <><Power size={13} aria-hidden="true" />{text("활성화", "Enable")}</> : <><PowerOff size={13} aria-hidden="true" />{text("비활성화", "Disable")}</>}</button>
        <button type="button" role="menuitem" disabled={busy || account.disabled} title={text("사용량 100% 도달 또는 에이전트의 제한 응답 시 한도에 걸린 세션을 자동전환이 켜진 다른 계정으로 옮기고, 활성 계정이면 활성 계정도 함께 바꿉니다", "Move sessions hitting limits to another auto-switch account on 100% usage or limit response; switches active account too if active")} onClick={() => runMenuAction(onToggleAutoSwitch)}><Repeat size={13} aria-hidden="true" />{account.autoSwitch ? text("자동전환 끄기", "Disable auto-switch") : text("자동전환 켜기", "Enable auto-switch")}</button>
        {autoSwitchPolicy === "priority" && <label className="account-menu-priority">
          <span>{text("페일오버 우선순위", "Failover priority")}</span>
          <input
            type="number"
            min={1}
            max={999}
            inputMode="numeric"
            placeholder={text("미지정", "Unset")}
            aria-label={`${account.displayName} ${text("페일오버 우선순위", "failover priority")}`}
            defaultValue={account.autoSwitchPriority ?? ""}
            disabled={busy}
            onBlur={(event) => {
              const raw = event.target.value.trim();
              const next = raw === "" ? null : Number.parseInt(raw, 10);
              if (next !== null && (Number.isNaN(next) || next < 1 || next > 999)) {
                // 범위 밖 값은 저장하지 않는다. 칸에 그대로 두면 사용자는 그 값이 반영된 것으로
                // 읽으므로(QA #89), 거절했다는 사실이 보이게 저장본으로 되돌린다. 입력이
                // 비제어(defaultValue)라 값을 직접 되돌려야 화면이 따라온다.
                event.target.value = account.autoSwitchPriority === null ? "" : String(account.autoSwitchPriority ?? "");
                return;
              }
              if (next === (account.autoSwitchPriority ?? null)) return;
              onChangePriority(next);
            }}
          />
        </label>}
        <button type="button" role="menuitem" disabled={busy} title={text("이 계정에만 남는 메모입니다. 계정 등록을 삭제하면 함께 지워집니다", "Note saved only on this account. Deleted when account registration is removed")} onClick={() => runMenuAction(onEditNote)}><NotebookText size={13} aria-hidden="true" />{account.note ? text("메모 편집", "Edit note") : text("메모 추가", "Add note")}</button>
        <span className="account-menu-divider" role="separator" />
        <button className="danger" type="button" role="menuitem" disabled={busy || !canDelete} title={deleteHint} onClick={() => runMenuAction(onDelete)}><Trash2 size={13} aria-hidden="true" />{text("삭제", "Delete")}</button>
      </div>}
    </div>
  </div>;
}

/**
 * 계정 행의 사용량 구획. 표시에 필요한 값(창 목록·재조회 가능 여부·크레딧)은 모두
 * 계정과 현재 시각에서 나오므로 행이 미리 계산해 넘기지 않고 여기서 구한다.
 */
function ProviderAccountUsagePanel({ account, editable, busy, refreshing, consumingCredit, onRefreshUsage, onConsumeResetCredit }: {
  account: ProviderAccountView;
  editable: boolean;
  busy: boolean;
  refreshing: boolean;
  consumingCredit: boolean;
  onRefreshUsage: () => void;
  onConsumeResetCredit: () => void;
}) {
  const { text } = useI18n();
  const now = Date.now();
  const windows = displayUsageWindows(account.usage.windows, now);
  const resetElapsed = windows.some((window) => window.resetElapsed);
  const resetCredits = account.usage.resetCredits ?? null;
  const usageDisplay = accountUsageDisplayState(account, now);
  const usageRetryAt = usageDisplay.retryBlockedUntil;
  // 한도 재시도 시각 전에는 버튼이 비활성이지만, 어떤 경로로 눌리더라도 갱신 요청을 만들지 않는다.
  const requestUsageRefresh = () => { if (usageDisplay.canRefresh) onRefreshUsage(); };
  return <div className="provider-account-usage">
    <div className="account-usage-head">
      <strong>{text("사용량", "Usage")}</strong>
      <button className={`icon-button compact${refreshing ? " busy" : ""}`} type="button" disabled={busy || !usageDisplay.canRefresh} aria-label={text("사용량 새로고침", "Refresh usage")} title={usageRetryAt !== null
        ? `${text("사용량 한도로 지금은 갱신하지 않습니다.", "Refresh paused due to usage limit.")} ${new Date(usageRetryAt).toLocaleString()} ${text("이후 갱신할 수 있습니다", "or later can be refreshed")}`
        : usageDisplay.canRefresh ? text("사용량 새로고침", "Refresh usage") : text("중지되었거나 재인증이 필요한 계정은 조회하지 않습니다", "Stopped or re-authentication required accounts are not polled")} onClick={requestUsageRefresh}><RefreshCw size={13} /></button>
      {usageRetryAt !== null && <em className="account-usage-retry" role="status">{new Date(usageRetryAt).toLocaleString()} {text("이후 갱신 가능", "or later refresh available")}</em>}
    </div>
    <UsageMeters usage={account.usage} windows={windows} />
    {/* 소진된 창을 즉시 되돌리는 크레딧. 장수가 한정돼 있고 만료가 있어서, 남은 장수와
        가장 이른 만료를 함께 적고 실제 사용은 확인을 한 번 받는다. 한도를 충분히 쓰지
        않았으면 공급자가 물리므로 그 판정은 눌러 봐야 안다. */}
    {resetCredits !== null && resetCredits.availableCount > 0 && <div className="account-reset-credits">
      <span>
        <Ticket size={13} aria-hidden="true" />
        <strong>{text("한도 리셋", "Limit reset")} {resetCredits.availableCount}{text("장", " credits")}</strong>
        {resetCredits.nextExpiresAt !== null && <em>{new Date(resetCredits.nextExpiresAt).toLocaleDateString()} {text("만료", "expires")}</em>}
      </span>
      {editable && <button
        className="button compact"
        type="button"
        disabled={busy}
        title={resetCredits.title ?? text("소진된 사용량 창을 즉시 되돌립니다", "Instantly resets exhausted usage window")}
        onClick={onConsumeResetCredit}
      >{consumingCredit ? text("초기화 중…", "Resetting…") : text("지금 사용", "Use now")}</button>}
    </div>}
    {/* 조회에 실패해도 마지막 성공 수치가 있으면 오류 문구로 갈아치우지 않는다.
        기준 시각으로 낡음을 알리고, 실패 사유는 도움말로만 남긴다. */}
    <small className={`account-usage-note${usageDisplay.error ? " error" : ""}`} title={usageDisplay.staleError ?? undefined}>{usageDisplay.error
      ?? (usageDisplay.staleError !== null && account.usage.updatedAt !== null
        ? `${new Date(account.usage.updatedAt).toLocaleString()} ${text("기준 · 갱신에 실패해 마지막 조회 값을 유지합니다", "as of · refresh failed, retaining last polled value")}`
        : usageDisplay.cached && account.usage.updatedAt !== null
          ? `${new Date(account.usage.updatedAt).toLocaleString()} ${text("마지막 성공 조회", "last successful poll")} · ${resetElapsed ? text("초기화 시간 경과로 0% 표시", "showing 0% due to elapsed reset time") : text("중지·재인증 상태라 갱신하지 않습니다", "refresh paused in stopped/re-auth state")}`
          : account.usage.updatedAt !== null
            ? `${new Date(account.usage.updatedAt).toLocaleString()} ${text("기준", "as of")}`
            : text("아직 조회하지 않았습니다. 새로고침으로 사용량을 확인하세요.", "Not polled yet. Click refresh to check usage."))}</small>
  </div>;
}

/**
 * 인증 만료 예고. 사슬 만료는 회전으로 늘어나지 않아, 지나고 나면 재인증 말고 되살릴
 * 길이 없다 — 그래서 사흘 전부터 남은 기간과 만료 시각을 카드에 적는다.
 *
 * 만료된 뒤에는 적지 않는다. 그때는 예고가 아니라 사실이고, 머리줄의 "재인증 필요"
 * 배지와 사용량 오류가 같은 것을 이미 말한다. 남은 기간 자리에 지난 시각을 적으면
 * 아직 여유가 있는 것처럼 읽힌다.
 */
function AccountExpiryNotice({ account }: { account: ProviderAccountView }) {
  const { text } = useI18n();
  const expiresAt = account.credentialExpiresAt;
  if (expiresAt === null || !credentialExpiryImminent(account, Date.now())) return null;
  const days = daysUntilExpiry(expiresAt, Date.now());
  return <p className="provider-account-expiry" role="status">
    <ShieldAlert size={13} aria-hidden="true" />
    <span>{text(
      `인증이 ${days}일 뒤 만료됩니다 (${new Date(expiresAt).toLocaleString()}). 만료되면 갱신이 거부되어 재인증해야만 이 계정으로 실행할 수 있습니다.`,
      `Authentication expires in ${days} day${days === 1 ? "" : "s"} (${new Date(expiresAt).toLocaleString()}). After that, refresh is refused and the account cannot run until you re-authenticate.`,
    )}</span>
  </p>;
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
  const { text } = useI18n();
  const busy = busyKey !== null;
  const refreshing = busyKey === accountTaskKey("usage", account.id);
  const consumingCredit = busyKey === accountTaskKey("reset-credit", account.id);
  // 활성 계정 변경은 사용량 재조회까지 포함해 1초쯤 걸린다. 그 사이 버튼이 눌린 티가
  // 나지 않으면 다시 누르려 하므로 진행 중임을 적는다.
  const activating = busyKey === accountTaskKey("active", account.id);
  const savingNote = busyKey === accountTaskKey("note", account.id);
  const savingLabel = busyKey === accountTaskKey("label", account.id);
  const labelEditor = useAccountDraftEditor(savingLabel, () => account.label ?? account.providerDisplayName,
    (draft) => submitAccountLabel(draft, account.label, onSaveLabel));
  const noteEditor = useAccountDraftEditor(savingNote, () => account.note ?? "",
    (draft) => submitAccountNote(draft, account.note, onSaveNote));
  const labelDraft = labelEditor.draft;
  const noteDraft = noteEditor.draft;
  const noteState = accountNoteDraftState(noteDraft ?? "", account.note);
  const labelState = accountLabelDraftState(labelDraft ?? "", account.label);
  const authFailed = account.authStatus !== "ready";
  // 격리 실패만 표시한다. 실패 사유가 없는데 격리가 꺼져 있는 건 아직 프로브를 돌리지
  // 않았다는 뜻뿐이고, 판정은 프로세스 메모리에만 있어 백엔드를 다시 띄우면 이미 격리된
  // 계정까지 전부 그 상태가 된다. 그런 값으로 배지를 달면 사실과 다른 경고만 남는다.
  const isolationFallback = !account.credentialIsolated && account.credentialIsolationNote !== null;
  const hasBadges = account.isActive || account.disabled || account.autoSwitch || authFailed || isolationFallback;
  return <div className={`provider-account-row${account.disabled ? " disabled" : ""}${authFailed ? " needs-auth" : ""}${account.isActive ? " is-active" : ""}`}>
    <div className="provider-account-head">
      <span className="provider-account-identity"><strong>{account.displayName}</strong><small>{[account.email, account.organization].filter(Boolean).join(" · ") || account.providerAccountId}</small></span>
      {hasBadges && <span className="provider-account-badges">{account.isActive && <em className="health ready">{text("활성 계정", "Active account")}</em>}{account.disabled && <em className="health muted">{text("비활성", "Disabled")}</em>}{account.autoSwitch && <em className="health muted">{text("자동전환", "Auto-switch")}</em>}{authFailed && <em className="health warning">{text("재인증 필요", "Needs re-auth")}</em>}{isolationFallback && <em className="health warning" title={account.credentialIsolationNote ?? undefined}>{text("격리 실패", "Isolation failed")}</em>}</span>}
      {editable && <ProviderAccountMenu
        account={account}
        busy={busy}
        activating={activating}
        authFailed={authFailed}
        autoSwitchPolicy={autoSwitchPolicy}
        onActivate={onActivate}
        onReauthenticate={onReauthenticate}
        onToggleDisabled={onToggleDisabled}
        onToggleAutoSwitch={onToggleAutoSwitch}
        onChangePriority={onChangePriority}
        onDelete={onDelete}
        onEditLabel={labelEditor.open}
        onEditNote={noteEditor.open}
      />}
    </div>
    <AccountToolBadges tools={tools} />
    <AccountExpiryNotice account={account} />
    {account.note && <p className="provider-account-note"><NotebookText size={13} aria-hidden="true" /><span>{account.note}</span></p>}
    {labelDraft !== null && <AccountDraftModal
      title={<><PenLine size={16} aria-hidden="true" /><span>{text("표시 이름 변경", "Change display name")}</span></>}
      editor={labelEditor}
      state={labelState}
      maxChars={ACCOUNT_LABEL_MAX_CHARS}
      saving={savingLabel}
      saveLabel={labelState.restores ? text("공급자 이름으로", "Reset to provider name") : text("저장", "Save")}
      hint={text("이 이름은 Agent Manager 목록에만 쓰입니다. 공급자 계정 자체는 바뀌지 않으며, 로그인을 다시 조회해도 덮이지 않습니다. 비우고 저장하면 공급자가 알려 준 이름으로 되돌아갑니다.", "This name is only used in Agent Manager. The provider account itself is unchanged, and re-fetching login will not overwrite it. Saving empty restores the provider-reported name.")}
    >
      <input
        className="account-label-input"
        type="text"
        value={labelDraft}
        disabled={savingLabel}
        placeholder={account.providerDisplayName}
        aria-label={text("계정 표시 이름", "Account display name")}
        autoFocus
        onChange={(event) => labelEditor.setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && labelState.canSave && !savingLabel) { event.preventDefault(); void labelEditor.save(); } }}
      />
      <dl className="account-label-facts">
        <div><dt>{text("공급자 이름", "Provider name")}</dt><dd>{account.providerDisplayName}</dd></div>
        {account.email && <div><dt>{text("이메일", "Email")}</dt><dd>{account.email}</dd></div>}
        {account.organization && <div><dt>{text("조직", "Organization")}</dt><dd>{account.organization}</dd></div>}
        <div><dt>{text("계정 ID", "Account ID")}</dt><dd><code>{account.providerAccountId}</code></dd></div>
      </dl>
    </AccountDraftModal>}
    {noteDraft !== null && <AccountDraftModal
      title={<><NotebookText size={16} aria-hidden="true" /><span>{account.displayName} {text("메모", "Note")}</span></>}
      editor={noteEditor}
      state={noteState}
      maxChars={ACCOUNT_NOTE_MAX_CHARS}
      saving={savingNote}
      saveLabel={noteState.removes ? text("메모 삭제", "Delete note") : text("저장", "Save")}
      hint={text("메모는 이 계정에만 저장되며 공급자 히스토리나 자격증명에는 남지 않습니다. 계정 등록을 삭제하면 함께 지워집니다.", "Notes are stored only with this account and not in provider history or credentials. Removed when account registration is deleted.")}
    >
      <textarea
        className="account-note-input"
        value={noteDraft}
        rows={7}
        disabled={savingNote}
        placeholder={text("이 계정을 구분할 메모를 남기세요. 비우고 저장하면 메모를 삭제합니다.", "Leave a note to identify this account. Save empty to delete note.")}
        aria-label={`${account.displayName} ${text("계정 메모", "account note")}`}
        autoFocus
        onChange={(event) => noteEditor.setDraft(event.target.value)}
      />
    </AccountDraftModal>}
    <ProviderAccountUsagePanel
      account={account}
      editable={editable}
      busy={busy}
      refreshing={refreshing}
      consumingCredit={consumingCredit}
      onRefreshUsage={onRefreshUsage}
      onConsumeResetCredit={onConsumeResetCredit}
    />
    {authFailed && <div className="account-auth-alert" role="alert">
      <ShieldAlert size={15} aria-hidden="true" />
      <span><strong>{account.authStatus === "missing" ? text("보안 저장소에서 자격증명을 찾지 못했습니다", "Credentials not found in secure storage") : text("저장된 자격증명을 사용할 수 없습니다", "Stored credentials cannot be used")}</strong><small>{text("재인증을 완료해야 이 계정으로 실행하고 사용량을 조회할 수 있습니다.", "Re-authentication required to run with this account and poll usage.")}</small></span>
      {editable && <div className="account-auth-actions">
        <button className="button compact" type="button" disabled={busy} onClick={onRevalidate}>{text("저장 자격증명 확인", "Check stored credentials")}</button>
        <button className="button compact" type="button" disabled={busy} onClick={onReauthenticate}>{text("재인증", "Re-authenticate")}</button>
      </div>}
    </div>}
  </div>;
}

/**
 * CLI 연결 설정의 공급자 한 칸.
 * 공급자 헤더, CLI 업데이트 패널, Antigravity 전역 사용량, 공급자 홈 카드,
 * 그리고 등록된 계정 목록(`ProviderAccountRow` 묶음)을 렌더링한다.
 */
function CliProviderCard({
  provider,
  accounts,
  canManage,
  busy,
  cli,
  accountTools,
  antigravityUsage,
  antigravityLoading,
  onRefreshAntigravityUsage,
  onConnect,
  accountLogin,
  accountActions,
}: {
  provider: ProviderStatus;
  accounts: AccountSnapshot | null;
  canManage: boolean;
  busy: string | null;
  cli: ReturnType<typeof useProviderCliUpdates>;
  accountTools: AccountToolsSnapshot | null;
  antigravityUsage: AccountUsageView | null;
  antigravityLoading: boolean;
  onRefreshAntigravityUsage: () => void;
  onConnect: (provider: ProviderStatus) => void;
  accountLogin: ReturnType<typeof useAccountLogin>;
  accountActions: ReturnType<typeof useAccountActions>;
}) {
  const { text } = useI18n();
  const providerAccounts = accounts?.accounts.filter((account) => account.provider === provider.provider) ?? [];
  const providerState = accounts?.providers.find((state) => state.provider === provider.provider);
  // 계정 관리를 지원하는 공급자는 백엔드 레지스트리가 정한다
  // (`ProviderId::manages_accounts`). 여기에 목록을 따로 적으면 공급자가 늘 때
  // 화면만 뒤처져, 등록된 계정이 있는데도 계정 구획이 통째로 숨는다.
  const managed = Boolean(providerState);
  const cliStatus = cli.statuses?.find((status) => status.provider === provider.provider) ?? null;
  const cliAccess: CliActionAccess = { writable: canManage, busy: Boolean(cli.busy) };
  // 업데이트 구획은 상단 알림 근거가 있을 때만 알림과 함께 연다. 진행 중인 작업과
  // 남아 있는 결과 안내는 근거가 사라진 뒤에도 읽을 수 있게 함께 조건에 넣는다.
  const cliActionKeys = [cliTaskKey("check", provider.provider), cliTaskKey("update", provider.provider), cliTaskKey("cache", provider.provider)];
  const showCliPanel = cliStatus !== null && shouldShowCliUpdatePanel(cliStatus, cli.alert, {
    busy: cliActionKeys.includes(cli.busy ?? ""),
    hasMessage: cliActionKeys.some((key) => Boolean(cli.notices[key]) || Boolean(cli.errors[key])),
    pending: cli.pending?.status.provider === provider.provider,
  });

  return (
    <article className={`cli-settings-provider account-provider-card ${provider.cli.detected ? "ready" : "needs-connection"}`}>
      <div className="account-provider-head">
        <SourceBadge source={provider.provider} />
        <span className="cli-settings-provider-copy"><strong>{provider.displayName}</strong><small>{provider.cli.path ? displayPath(provider.cli.path) : text("CLI 실행 파일이 탐지되지 않았습니다.", "CLI executable was not detected.")}</small></span>
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
        busyKey={cli.busy}
        pending={cli.pending?.status.provider === provider.provider ? cli.pending : null}
        notices={cli.notices}
        errors={cli.errors}
        onCheck={() => void cli.check(cliStatus)}
        onUpdate={() => void cli.request("update", cliStatus)}
        onClearCache={() => void cli.request("cache", cliStatus)}
        onCancelPending={() => cli.setPending(null)}
        onConfirmPending={() => { if (cli.pending) void cli.perform(cli.pending.kind, cli.pending.status); }}
      />}
      {/* 계정을 등록하기 전에는 기계에 로그인된 하나로만 도므로 전역 사용량을
          보여 준다. 계정이 생기면 계정 행이 각자의 잔량을 싣는다. */}
      {provider.provider === "antigravity" && providerAccounts.length === 0 && <AntigravityUsageCard
        usage={antigravityUsage}
        detected={provider.cli.detected}
        loading={antigravityLoading}
        onRefresh={onRefreshAntigravityUsage}
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
          onActivate={() => void accountActions.activateAccount(account)}
          onRevalidate={() => void accountActions.mutate(accountTaskKey("validate", account.id), () => revalidateProviderAccountCredential(account.id))}
          onReauthenticate={() => void accountLogin.begin(provider.provider, account)}
          onToggleDisabled={() => void accountActions.mutate(accountTaskKey("disabled", account.id), () => setProviderAccountDisabled(account.id, !account.disabled))}
          onToggleAutoSwitch={() => accountActions.applySetting(
            accountActions.patchAccount(account.id, { autoSwitch: !account.autoSwitch }),
            () => setProviderAccountAutoSwitch(account.id, !account.autoSwitch),
          )}
          autoSwitchPolicy={accounts?.autoSwitchPolicy ?? "maxHeadroom"}
          onChangePriority={(priority) => accountActions.applySetting(
            accountActions.patchAccount(account.id, { autoSwitchPriority: priority }),
            () => setProviderAccountAutoSwitchPriority(account.id, priority),
          )}
          onDelete={() => void accountActions.deleteAccount(account)}
          onRefreshUsage={() => void accountActions.mutate(accountTaskKey("usage", account.id), () => refreshProviderAccountUsage(account.id))}
          onConsumeResetCredit={() => void accountActions.consumeResetCredit(account)}
          onSaveNote={(note) => accountActions.saveAccountText("note", account, note)}
          onSaveLabel={(label) => accountActions.saveAccountText("label", account, label)}
        />)}
        {providerState?.lastAutoSwitch && <ProviderAutoSwitchNote accounts={providerAccounts} event={providerState.lastAutoSwitch} />}
        <div className="provider-account-add-actions">
          {canManage && provider.cli.detected && <button className="button compact" type="button" disabled={Boolean(busy)} onClick={() => void accountLogin.begin(provider.provider)}><Plus size={13} />{text("계정 추가", "Add account")}</button>}
        </div>
      </div>}
    </article>
  );
}

/**
 * 시스템 자동화 카드. 설정 탭마다 자기 구획 하나만 그린다 — CLI 연결·시스템 에이전트·
 * 서비스·언어가 각각 다른 탭에 서므로 두 구획이 한 화면에 함께 서는 일은 없다. 그래서
 * 구획마다 쓰는 상태도 각자의 구획 안에 둔다. 카드가 직접 쥐는 것은 아래에 한 줄로 서는
 * 오류 배너 하나뿐이고, 구획들은 실패 문구만 그리로 올린다.
 */
function SystemAutomationSettingsCard({ active, sections, providers, accounts, onAccountsChange, onConnectCli, models, automation, onChange, showSystemAgentNotice, onCloseSystemAgentNotice, appVersionManifest }: {
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
  appVersionManifest: AppVersionManifest | null;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="settings-card system-automation-card">
      <div className="settings-card-sections system-automation-body">
        {sections.includes("cli") && <CliConnectionSettingsSection active={active} providers={providers} accounts={accounts} onAccountsChange={onAccountsChange} onConnect={onConnectCli} />}
        {sections.includes("agent") && <SystemAgentSection automation={automation} onChange={onChange} models={models} showSystemAgentNotice={showSystemAgentNotice} onCloseSystemAgentNotice={onCloseSystemAgentNotice} onError={setError} />}
        {sections.includes("service") && <>
          <AppVersionSettings manifest={appVersionManifest} />
          <RemoteAccessSettings />
        </>}
        {sections.includes("language") && <LanguageAutomationSection automation={automation} onChange={onChange} onError={setError} />}
      </div>
      {error && <ErrorBanner message={error} />}
    </section>
  );
}

/**
 * 시스템 자동화 카드의 두 구획(시스템 에이전트·언어)이 백엔드를 부르는 껍데기 — 저장 중
 * 표시를 세우고, 적어 둘 오류 자리를 비우고, 돌려받은 스냅숏을 위로 올리고, 무엇으로 끝나든
 * 표시를 내린다. 두 구획이 이 모양을 각자 적어 두었고, 언어 구획은 설정 저장과 번역 조작
 * 두 벌로 또 한 번 되풀이하고 있었다.
 *
 * 다른 것은 셋뿐이라 부르는 쪽이 정하게 남긴다 — 실패 문구를 어느 오류 자리에 담을지(`fail`),
 * 요청에 들어가기 전에 함께 비울 상태가 있는지(`before`), 성공 뒤 닫을 것이 있는지(`onDone`).
 * `saving` 중 재진입을 막는 앞머리는 여기서 맡지 않는다: 설정 저장 둘만 그 앞머리를 두고,
 * 번역 조작은 자기 버튼이 이미 `saving`으로 잠겨 있어 앞머리 없이 불러 왔다.
 */
function useSystemAutomationTask(onChange: (snapshot: SystemAutomationSnapshot) => void) {
  const [saving, setSaving] = useState(false);
  const run = async (
    request: () => Promise<SystemAutomationSnapshot>,
    options: { fail: (message: string | null) => void; before?: () => void; onDone?: () => void },
  ): Promise<boolean> => {
    setSaving(true);
    options.fail(null);
    options.before?.();
    try {
      onChange(await request());
      options.onDone?.();
      return true;
    } catch (cause) {
      options.fail(errorText(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { saving, run };
}

/**
 * 설정 한 벌을 통째로 받는 저장 창구에 부분 수정만 실어 보내는 자리가 두 구획에 있다.
 * `translations`는 중첩 객체라 퍼뜨리기로는 합쳐지지 않아 두 자리 모두 손으로 한 번 더
 * 골라 왔다 — 그 규칙을 여기 한 자리에 둔다.
 */
function patchedAutomationSettings(
  automation: SystemAutomationSnapshot,
  patch: Partial<SystemAutomationSnapshot["settings"]>,
): SystemAutomationSnapshot["settings"] {
  return { ...automation.settings, ...patch, translations: patch.translations ?? automation.settings.translations };
}

/**
 * 시스템 에이전트 구획. AIA 실행과 자동번역을 맡을 CLI를 고르고, 그 공급자의 실행설정과
 * AIA 대화 기록 여부를 이어서 편집한다. 저장 중 표시는 이 구획 안에서 끝나고, 실패 문구만
 * 카드의 오류 배너로 올린다.
 */
function SystemAgentSection({ automation, onChange, models, showSystemAgentNotice, onCloseSystemAgentNotice, onError }: {
  automation: SystemAutomationSnapshot | null;
  onChange: (snapshot: SystemAutomationSnapshot) => void;
  models: ModelOption[];
  showSystemAgentNotice: boolean;
  onCloseSystemAgentNotice: () => void;
  onError: (message: string | null) => void;
}) {
  const { text } = useI18n();
  const { saving, run } = useSystemAutomationTask(onChange);
  // 실행설정을 함께 편집할 수 있는 시스템 에이전트. 고르지 않았거나 더 이상 쓸 수 없는
  // 공급자가 저장돼 있으면 AIA 자체가 꺼지므로 실행설정도 보여 주지 않는다.
  const selectedSystemProvider = aiaRuntimeProvider(automation);

  const save = async (patch: Partial<SystemAutomationSnapshot["settings"]>): Promise<boolean> => {
    if (!automation || saving) return false;
    return run(() => setSystemAutomationSettings(patchedAutomationSettings(automation, patch)), { fail: onError });
  };

  return (
    <section className={`settings-subsection system-agent-section${showSystemAgentNotice ? " attention" : ""}`} data-ui-anchor="settings.system-agent">
      {showSystemAgentNotice && <div className="system-agent-settings-notice" role="status">
        <span><strong>{text("AIA를 사용하려면 시스템 에이전트를 설정하세요.", "Choose a system agent to use AIA.")}</strong><small>{text("아래에서 연결된 CLI를 선택하면 AIA가 바로 활성화됩니다.", "Select a connected CLI below to enable AIA immediately.")}</small></span>
        <button type="button" aria-label={text("안내 닫기", "Close notice")} title={text("닫기", "Close")} onClick={onCloseSystemAgentNotice}><X size={14} /></button>
      </div>}
      <header><div><strong>{text("시스템 에이전트", "System agent")}<HelpHint
        label={text("시스템 에이전트 변경 동작 설명", "What happens when the system agent changes")}
        title={text("시스템 에이전트 변경 동작", "What happens when the system agent changes")}
      >{text("바꾸면 다음 AIA 요청부터 새 공급자로 실행됩니다.", "AIA runs on the new provider from the next request.")}</HelpHint></strong><small>{text("AIA 실행과 UI·콘텐츠 자동번역에 사용할 연결된 CLI를 선택합니다.", "Choose the connected CLI that runs AIA and translates UI and content.")}</small></div></header>
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
      {automation && selectedSystemProvider && <div className="system-setting-group">
        <div className="system-setting-label"><NotebookText size={17} /><span>
          <strong>{text("AIA 대화 기록", "Record AIA conversations")}<HelpHint
            label={text("AIA 대화 기록 설명", "About recording AIA conversations")}
            title={text("AIA 대화 기록", "Record AIA conversations")}
          >{text("Codex 시스템 에이전트에만 해당합니다. 끄면 AIA 세션을 ephemeral로 띄워 Codex가 대화 기록을 만들지 않습니다. Claude는 언제나 기록을 남깁니다.", "Applies to the Codex system agent. When off, AIA sessions start ephemeral and Codex writes no conversation record. Claude always keeps one.")}</HelpHint></strong>
          <small>{text("끄면 AIA 대화가 세션 목록에 나타나지 않습니다. 실행할 때 정해지므로 새 대화부터 적용됩니다.", "When off, AIA conversations never appear in the session list. It is decided at launch, so it applies from the next conversation.")}</small>
        </span></div>
        <AppToggle
          checked={automation.settings.aiaSessionRecording !== false}
          disabled={saving}
          label={text("AIA 대화 기록", "Record AIA conversations")}
          onChange={(next) => void save({ aiaSessionRecording: next })}
        />
      </div>}
    </section>
  );
}

/**
 * 언어 및 자동번역 구획. UI·번역 언어 선택, 추가 언어 등록·삭제, 메뉴별 자동번역 토글을
 * 맡는다. 확인을 기다리는 메뉴·초기화 확인·언어 추가 폼처럼 이 구획 밖에서는 읽지도 쓰지도
 * 않는 상태가 여기 모여 있다. 번역 조작 다섯 벌은 저장 중 표시·오류 자리 비우기·새 스냅숏
 * 반영·실패 표시가 모두 같고, 실패를 어느 오류 자리에 담는지와 성공 뒤 처리만 다르다.
 */
function LanguageAutomationSection({ automation, onChange, onError }: {
  automation: SystemAutomationSnapshot | null;
  onChange: (snapshot: SystemAutomationSnapshot) => void;
  onError: (message: string | null) => void;
}) {
  const { locale, text } = useI18n();
  const { saving, run } = useSystemAutomationTask(onChange);
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

  const save = async (patch: Partial<SystemAutomationSnapshot["settings"]>): Promise<boolean> => {
    if (!automation || saving) return false;
    return run(() => setSystemAutomationSettings(patchedAutomationSettings(automation, patch)), {
      fail: onError,
      before: () => { setMenuError(null); setPendingMenu(null); },
    });
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

  const runTranslationTask = async (
    request: () => Promise<SystemAutomationSnapshot>,
    fail: (message: string | null) => void,
    onDone?: () => void,
  ) => { await run(request, { fail, onDone }); };

  const changeLanguage = async (code: string) => {
    if (!automation || saving) return;
    const languages = [...builtInTranslationLanguages, ...automation.settings.additionalTranslationLanguages];
    const language = languages.find((item) => item.code === code);
    if (!language) return;
    onError(null);
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
    await runTranslationTask(() => retryMenuTranslation(menu), onError);
  };

  // 저장된 번역을 버리는 유일한 조작이므로 한 번 더 확인받는다.
  const reset = async (menu: TranslationMenu) => {
    await runTranslationTask(() => resetMenuTranslation(menu), onError, () => setPendingReset(null));
  };

  return (
    <section className="settings-subsection language-settings-section">
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
        {/* 시스템 에이전트가 없으면 켜 둔 설정은 보존한 채 읽기 전용으로 두고,
            번역 작업은 백엔드가 일시중지한다. */}
        {TRANSLATION_MENUS.map((menu) => <TranslationMenuRow
          key={menu}
          label={translationMenuLabel(menu, text)}
          status={automation[menu]}
          enabled={automation.settings.translations[menu]}
          readOnly={!automation.settings.systemProvider}
          saving={saving}
          confirmReset={pendingReset === menu}
          confirmStart={pendingMenu === menu}
          errorMessage={menuError?.menu === menu ? menuError.message : null}
          onRetry={() => void retry(menu)}
          onRequestReset={() => { setPendingReset(menu); setPendingMenu(null); }}
          onCancelReset={() => setPendingReset(null)}
          onConfirmReset={() => void reset(menu)}
          onCancelStart={() => setPendingMenu(null)}
          onConfirmStart={() => void confirmMenu(menu)}
          onToggle={(next) => void setMenu(menu, next)}
        />)}
      </div>
      </div>}
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
          {text("저장하면 다음 요청부터 새 설정이 적용됩니다. 돌고 있는 AIA 대화에 다시 보내는 순간 그 대화를 정지하고 새 설정으로 새 대화를 시작하며, 진행 중인 작업이나 승인 대기가 있으면 그것이 끝난 뒤입니다.", "Saved settings apply from the next request. Sending again in a running AIA conversation stops it and starts a new one with the new settings; if a turn or approval is in progress, that has to finish first.")}</HelpHint></strong>
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
        localConnectionId={draft.localConnectionId ?? ""}
        onLocalConnectionChange={(next) => setDraft((current) => ({ ...current, localConnectionId: next.trim() ? next.trim() : null }))}
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

/// 백엔드 서비스 카드의 토글 행. 강조(enabled 클래스)는 기본적으로 켬 상태를
/// 따르지만, 절전 억제처럼 "켰지만 실제로 걸리지 않은" 상태가 따로 있는 행은
/// highlighted로 실제 동작 여부를 준다.
///
/// `checked`가 null이면 상태 조회가 아직 끝나지 않은(또는 실패한) 것이다. 이때 스위치를
/// 꺼짐으로 그리면 이미 켜진 설정이 꺼진 것처럼 보이고, 누르면 "켜기" 확인까지 뜬다
/// (QA #34). 모르는 값은 false로 그리지 않고 스위치 자리에 확인 중 표식을 둔다.
///
/// 다만 "아직 안 온 값"과 "오지 못한 값"은 다르다. 조회가 실패로 끝났는데도 확인 중을
/// 두면 화면에 다시 부르는 길이 없어 영원히 기다리는 표식이 되고, 같은 줄의 요약이
/// 실패를 말하는 것과 정면으로 어긋난다(QA #80). `loadError`가 있으면 그 사실을 적는다.
function BackendServiceToggleRow({ title, help, summary, checked, highlighted, disabled, loadError, onChange }: {
  title: string;
  help?: ReactNode;
  summary: string;
  checked: boolean | null;
  highlighted?: boolean;
  disabled: boolean;
  /** 이 행의 값을 실어 오는 조회가 실패로 끝났을 때의 사유. */
  loadError?: string | null;
  onChange: (next: boolean) => void;
}) {
  const { text } = useI18n();
  const unknown = checked === null;
  const failed = unknown && Boolean(loadError);
  // `data-state`는 "스위치를 내줄 수 있는 값인가"만 가른다(QA #34). 읽지 못한 것도 모르는
  // 값이라는 점은 같으므로 unknown 그대로 두고, 사용자에게 보이는 구분은 아래 표식이 한다.
  return (
    <div className={`backend-service-toggle${(highlighted ?? checked) ? " enabled" : ""}${unknown ? " pending" : ""}`} data-state={unknown ? "unknown" : checked ? "on" : "off"}>
      <span>
        <strong>{title}{help}</strong>
        <small>{summary}</small>
      </span>
      {unknown
        ? failed
          ? <em className="health warning backend-service-toggle-failed" role="status" aria-label={text(`${title} 상태를 읽지 못했습니다`, `Could not read ${title} status`)}>{text("읽지 못함", "Unavailable")}</em>
          : <em className="health muted backend-service-toggle-pending" role="status" aria-label={text(`${title} 상태 확인 중`, `Checking ${title} status`)}>{text("확인 중…", "Checking…")}</em>
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
  text: UiText,
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

/**
 * 원격 편집 허용 행의 요약 문구. 현재 권한 상태 뒤에, 이 화면에서 못 바꾸는 경우만 그 사정을 덧붙인다.
 *
 * 이 행의 값은 Tailscale 상태 조회가 함께 실어 온다. 그 조회가 실패하면 여기에도 값이
 * 영영 오지 않으므로, 자기 작업 오류가 없더라도 조회 실패를 그대로 옮겨 적는다 —
 * 그러지 않으면 이 줄만 아무 일도 없다는 듯 "설정 확인 중…"에 머문다(QA #80).
 */
function remoteWriteSummaryText(
  taskError: string | null,
  loadError: string | null,
  tailscale: TailscaleServiceStatus | null,
  access: WebAccessStatus | null,
  canManage: boolean,
  text: UiText,
): string {
  if (taskError) return taskError;
  if (!tailscale) return loadError ?? text("설정 확인 중…", "Checking setting…");
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
  text: UiText,
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
//
// 요청에 들어가기 전의 앞머리 둘 — "이미 돌고 있으면 무시한다"와 "되돌리기 어려운 방향일
// 때만 한 번 묻고, 사용자가 거절하면 아무것도 하지 않는다" — 도 여기서 맡는다. 토글 셋과
// 포트 저장이 그 둘을 각자 `if (task.busy) return;`과 `if (!accepted) return;`으로 적어
// 두어, 한 자리에서 빠뜨려도 드러나지 않았다. `confirm`에 null을 주면 묻지 않는 것이라,
// 켤 때만 묻는 자리는 삼항 하나로 방향을 고르면 된다.
function useBackendTask(clearNotice: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    action: () => Promise<void>,
    options: {
      confirm?: (() => Promise<boolean>) | null;
      onFailure?: (message: string) => void;
      onSettled?: () => void;
    } = {},
  ) => {
    if (busy) return;
    if (options.confirm && !(await options.confirm())) return;
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

function AppVersionSettings({ manifest }: { manifest: AppVersionManifest | null }) {
  const { text } = useI18n();
  const [hiddenVersion, setHiddenVersion] = useState<string | null>(null);
  useEffect(() => { setHiddenVersion(manifest ? (isAppVersionHidden(manifest.latestVersion) ? manifest.latestVersion : null) : null); }, [manifest]);
  const hidden = manifest?.latestVersion === hiddenVersion;
  const checkedAt = lastAppVersionCheckAt();
  const openDownload = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!hasTauriRuntime()) return;
    event.preventDefault();
    void openUrl(manifest?.downloadUrl ?? "https://github.com/shinkiki/local-agent-manager/releases/latest");
  };
  return <section className="settings-subsection app-version-card">
    <header><div><strong>{text("Agent Manager 버전", "Agent Manager version")}</strong><small>{text("앱 버전과 새 릴리스 정보를 확인합니다.", "Check the app version and new release information.")}</small></div></header>
    <div className="app-version-body">
      <div className="app-version-row"><span>{text("현재 버전", "Current version")}</span><strong>v{APP_VERSION}</strong></div>
      {manifest && !hidden && <>
        <div className="app-version-row"><span>{text("최신 버전", "Latest version")}</span><strong className="app-version-new">v{manifest.latestVersion}</strong></div>
        {!isNewerAppVersion(manifest.latestVersion) && <small>{text("현재 최신 버전입니다.", "This is the latest version.")}</small>}
        {manifest.releasedAt && <small>{text("릴리스", "Released")} {new Date(manifest.releasedAt).toLocaleString()}</small>}
        {manifest.releaseNotes && <p className="app-version-notes">{manifest.releaseNotes}</p>}
        <div className="app-version-actions">
          <a className="button primary compact" href={manifest.downloadUrl} target="_blank" rel="noreferrer" onClick={openDownload}>{text("다운로드 페이지", "Download page")}</a>
          <button className="button compact" type="button" onClick={() => { hideAppVersion(manifest.latestVersion); setHiddenVersion(manifest.latestVersion); }}>{text("이번 버전 숨기기", "Hide this version")}</button>
        </div>
      </>}
      {manifest && hidden && <small>{text("이 버전의 알림을 숨겼습니다.", "Notifications for this version are hidden.")}</small>}
      {!manifest && <small>{checkedAt
        ? text(`${new Date(checkedAt).toLocaleString()}에 확인했습니다. 새 버전이 없습니다.`, `Checked ${new Date(checkedAt).toLocaleString()}. No newer version found.`)
        : text("새 버전 정보를 확인하지 못했습니다.", "Version information is not available yet.")}</small>}
    </div>
  </section>;
}

/**
 * 백엔드 서비스 포트 칸이 쥐고 있던 것 — 저장된 설정, 입력 중인 문자열, 범위 판정, 저장,
 * 그리고 "적용하려면 재시작" 갈래. 원격 접속 카드 한 함수가 Tailscale·원격 편집·절전까지
 * 네 갈래를 한 몸에 담고 있어 포트 쪽 상태가 어디까지 퍼지는지 읽히지 않았다. 포트만
 * 여기로 가른다.
 *
 * `restarting`은 Tailscale 쪽 토글도 함께 세우는 깃발이라 이 훅이 소유하지 않고 받아 쓴다 —
 * 옮겨오면 재시작 중에 두 갈래가 서로의 버튼을 풀어 준다.
 */
function useBackendServicePort({ nativeRuntime, tailscalePort, runningPort, clearNotice, setNotice, restarting, setRestarting, confirm }: {
  nativeRuntime: boolean;
  tailscalePort: number | null;
  runningPort: number | null;
  clearNotice: () => void;
  setNotice: (value: string | null) => void;
  restarting: boolean;
  setRestarting: (value: boolean) => void;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const { text } = useI18n();
  const [serviceSettings, setServiceSettings] = useState<BackendServiceSettings | null>(null);
  const [portText, setPortText] = useState(String(DEFAULT_BACKEND_SERVICE_PORT));
  const task = useBackendTask(clearNotice);
  const followsTailscale = tailscalePort !== null;
  // 입력값을 Serve 대상으로 덮어쓰지 않고 표시 단계에서만 대체한다. 상태 로드
  // 두 건이 어떤 순서로 끝나든 잠긴 포트가 흔들리지 않는다.
  const displayText = followsTailscale ? String(tailscalePort) : portText;
  const port = Number(displayText);
  const error = useMemo(() => {
    if (!Number.isInteger(port) || port < MIN_BACKEND_SERVICE_PORT || port > MAX_BACKEND_SERVICE_PORT) {
      return text(
        `서비스 포트는 ${MIN_BACKEND_SERVICE_PORT}~${MAX_BACKEND_SERVICE_PORT} 범위의 정수여야 합니다.`,
        `The service port must be an integer from ${MIN_BACKEND_SERVICE_PORT} to ${MAX_BACKEND_SERVICE_PORT}.`,
      );
    }
    return null;
  }, [port, text]);

  useEffect(() => {
    // 저장된 설정은 데스크톱 앱에서만 읽는다. 원격·브라우저는 접속 상태가 알려 준 포트를
    // 그대로 보여주므로 부르는 쪽이 `setPortText`로 채운다.
    if (!nativeRuntime) return;
    return loadWhileMounted(getBackendServiceSettings, (next) => {
      setServiceSettings(next);
      setPortText(String(next.port));
      task.setError(null);
    }, task.setError);
  }, [nativeRuntime]);

  const savedPort = serviceSettings?.port ?? null;
  // 적용 예정 포트. Tailscale Serve 대상이 있으면 그 포트가 우선한다.
  const pendingPort = followsTailscale ? tailscalePort : savedPort;
  const restartRequired = nativeRuntime && pendingPort !== null && runningPort !== null
    && pendingPort !== runningPort;

  const save = async () => {
    if (!nativeRuntime || error || serviceSettings?.port === port) return;
    await task.run(async () => {
      const next = await setBackendServiceSettings(port);
      setServiceSettings(next);
      setPortText(String(next.port));
      setNotice(text(
        `포트 ${next.port} 저장됨 · 다음 실행부터 적용`,
        `Port ${next.port} saved · applies on next launch`,
      ));
    });
  };

  const applyAndRestart = async () => {
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
    task.setError(null);
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
      task.setError(errorText(cause));
      setRestarting(false);
    }
  };

  return { task, serviceSettings, port, displayText, followsTailscale, error, pendingPort, restartRequired, setPortText, save, applyAndRestart };
}

type BackendServicePortState = ReturnType<typeof useBackendServicePort>;

/** 포트 입력 칸과 그 아래 안내 두 줄 — 잠긴 이유와 아직 적용되지 않은 포트를 알린다. */
function BackendServicePortRow({ state, nativeRuntime, tailscalePort, runningPort, restarting, showTailscaleNote, onPortTextChange }: {
  state: BackendServicePortState;
  nativeRuntime: boolean;
  tailscalePort: number | null;
  runningPort: number | null;
  restarting: boolean;
  showTailscaleNote: boolean;
  onPortTextChange: (value: string) => void;
}) {
  const { text } = useI18n();
  return <>
    <label className="backend-service-port">
      <span>{text("백엔드 서비스 포트", "Backend service port")}</span>
      <div>
        <input type="number" min={MIN_BACKEND_SERVICE_PORT} max={MAX_BACKEND_SERVICE_PORT} value={state.displayText} readOnly={state.followsTailscale} disabled={!nativeRuntime || state.task.busy || !state.serviceSettings || state.followsTailscale} onChange={(event) => onPortTextChange(event.target.value)} inputMode="numeric" />
        {!state.followsTailscale && <button className="button primary compact" type="button" disabled={!nativeRuntime || state.task.busy || Boolean(state.error) || !state.serviceSettings || state.serviceSettings.port === state.port} onClick={() => void state.save()}>
          {state.task.busy ? text("저장 중…", "Saving…") : text("저장", "Save")}
        </button>}
      </div>
      <small>{state.error ?? (!nativeRuntime
        ? text("읽기 전용 · 변경은 호스트의 Agent Manager 데스크톱 앱에서 할 수 있습니다.", "Read only · change this in the Agent Manager desktop app on the host.")
        : state.followsTailscale
          ? text(`Tailscale Serve 대상 포트 ${tailscalePort}을(를) 따릅니다 · 직접 변경할 수 없습니다`, `Follows the Tailscale Serve target port ${tailscalePort} · not editable here`)
          : text(`기본값 ${DEFAULT_BACKEND_SERVICE_PORT} · 다음 실행부터 적용`, `Default ${DEFAULT_BACKEND_SERVICE_PORT} · applies on next launch`))}</small>
    </label>
    {showTailscaleNote && <p className="backend-service-port-warning">{text(
      "Tailscale Serve 이용시 AgentManager 서비스도 동일한 서비스 포트로 설정됩니다.",
      "While Tailscale Serve is in use, the Agent Manager service uses the same service port.",
    )}</p>}
    {state.restartRequired && <BackendServiceAlert
      message={text(
        `서비스 포트 ${state.pendingPort}이(가) 아직 적용되지 않았습니다. 현재 백엔드는 ${runningPort} 포트로 실행 중이며, 재시작해야 새 포트로 바뀝니다.`,
        `Service port ${state.pendingPort} is not applied yet. The backend is still running on port ${runningPort}; restart to switch to the new port.`,
      )}
      actions={<button className="button primary compact" type="button" disabled={restarting} onClick={() => void state.applyAndRestart()}>
        {restarting ? text("재시작 중…", "Restarting…") : text("지금 재시작", "Restart now")}
      </button>}
    />}
  </>;
}

/**
 * 백엔드 서비스 카드의 토글 행 하나가 `BackendServiceToggleRow`에 넘기는 값 한 벌.
 * 세 행(Tailscale 서비스·원격 편집 허용·절전 억제)이 모두 이 모양으로 그려지므로,
 * 행마다의 훅이 이 타입 하나를 돌려주고 컴포넌트는 그대로 펴 넘기기만 한다.
 */
type BackendToggleState = {
  summary: string;
  checked: boolean | null;
  loadError: string | null;
  disabled: boolean;
  highlighted?: boolean;
  onChange: (next: boolean) => void;
};

/**
 * Tailscale 서비스 행 — 상태 조회, 켜고 끄기, Serve 루트 충돌 안내까지.
 *
 * 읽어 온 상태(`status`)는 이 행만의 것이 아니라 그대로 내보낸다. 서비스 포트가 Serve
 * 대상 포트를 따라가고, 원격 편집 허용 행도 같은 조회가 실어 온 값을 쓰기 때문이다.
 */
function useTailscaleServiceToggle({ nativeRuntime, access, restarting, setRestarting, clearNotice, setNotice, confirm }: {
  nativeRuntime: boolean;
  access: WebAccessStatus | null;
  restarting: boolean;
  setRestarting: (value: boolean) => void;
  clearNotice: () => void;
  setNotice: (value: string | null) => void;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}) {
  const { text } = useI18n();
  const task = useBackendTask(clearNotice);
  const [status, setStatus] = useState<TailscaleServiceStatus | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => loadWhileMounted(
    getTailscaleServiceStatus,
    (next) => { setStatus(next); task.setError(null); },
    task.setError,
  ), []);

  /**
   * 켜기가 재시작을 동반하는지. `remoteAccepted`는 지금 도는 백엔드가 Tailscale 프록시
   * 요청을 받도록 떴는지이고 그 프로세스가 사는 동안 바뀌지 않으므로, 켜기 전에 이미
   * 알 수 있다. 켠 뒤에 물으면 되돌릴 수 없는 종료를 통보하는 데 그치므로 여기서 판단해
   * 확인을 먼저 받는다.
   */
  const restartsOnEnable = Boolean(nativeRuntime && status && !status.remoteAccepted);

  const toggle = async (next: boolean, replaceExisting = false) => {
    const restarts = next && restartsOnEnable;
    await task.run(async () => {
      const value = await setTailscaleServiceEnabled(next, replaceExisting);
      setStatus(value);
      setConflict(null);
      if (restarts && !value.remoteAccepted) {
        setRestarting(true);
        setNotice(text(
          "Tailscale 원격 접속을 허용하도록 Agent Manager를 재시작합니다…",
          "Restarting Agent Manager to accept Tailscale remote access…",
        ));
        await restartApp();
        return;
      }
      setNotice(next
        ? text(`Tailscale 서비스를 켰습니다 · ${value.url ?? ""}`, `Tailscale service on · ${value.url ?? ""}`)
        : text("Tailscale 서비스를 껐습니다", "Tailscale service off"));
    }, {
      confirm: next
        // 켜면 원격 요청을 받는 백엔드로 갈아 끼우느라 앱이 한 번 종료됐다 다시 뜬다.
        // 물어보기 전에 껐다 켜면 사용자가 겪는 것은 예고 없는 종료라서, 먼저 확인받고
        // 거절하면 Serve 설정도 그대로 둔다.
        ? (restarts ? () => confirm({
          title: text("Tailscale 서비스 켜기", "Turn on Tailscale service"),
          message: text(
            "Tailscale 서비스를 켜려면 원격 접속을 허용하는 상태로 Agent Manager를 다시 시작해야 합니다.\n프로그램이 종료됐다가 다시 켜집니다. 지금 켤까요?",
            "Turning the Tailscale service on requires restarting Agent Manager so that it accepts remote access.\nThe app will quit and start again. Turn it on now?",
          ),
          warning: text("실행 중인 채팅과 터미널이 모두 종료됩니다.", "All running chats and terminals will stop."),
          confirmLabel: text("켜고 재시작", "Turn on and restart"),
          tone: "danger",
        }) : null)
        // 원격에서 끄면 지금 쓰는 접속 경로가 사라지므로 한 번 더 확인받는다.
        : (access?.remote ? () => confirm({
          title: text("Tailscale 서비스 끄기", "Turn off Tailscale service"),
          message: text(
            "Tailscale 서비스를 끄면 지금 쓰는 이 원격 접속이 끊깁니다.\n계속할까요?",
            "Turning the Tailscale service off will drop the remote connection you are using now.\nContinue?",
          ),
          warning: text("맥에서 직접 다시 켜야 원격 접속을 복구할 수 있습니다.", "You must turn it back on from the Mac itself to restore remote access."),
          confirmLabel: text("끄기", "Turn off"),
          tone: "danger",
        }) : null),
      // 루트 경로를 다른 서비스가 쓰고 있으면 덮어쓰기 여부를 사용자가 정한다.
      onFailure: (message) => setConflict(next && (message.includes(text("Serve 루트 경로", "Serve root path")) || message.includes("Serve root path")) ? message : null),
      onSettled: () => setRestarting(false),
    });
  };

  const canManage = Boolean(access?.writable) && Boolean(status?.available);
  const row: BackendToggleState = {
    summary: tailscaleSummaryText(task.error, status, text),
    checked: status ? status.enabled : null,
    loadError: task.error,
    disabled: !canManage || task.busy || restarting,
    onChange: (next) => void toggle(next),
  };
  return { task, status, setStatus, conflict, setConflict, toggle, row };
}

/**
 * 원격 편집 허용 행. 값은 Tailscale 상태 조회가 함께 실어 오므로 그 상태와 조회 실패
 * 사유를 넘겨받아 쓰고, 자기가 바꾼 결과는 같은 자리에 되돌려 놓는다.
 */
function useRemoteWriteToggle({ status, setStatus, loadError, access, restarting, clearNotice, setNotice, confirm }: {
  status: TailscaleServiceStatus | null;
  setStatus: (value: TailscaleServiceStatus) => void;
  loadError: string | null;
  access: WebAccessStatus | null;
  restarting: boolean;
  clearNotice: () => void;
  setNotice: (value: string | null) => void;
  confirm: ReturnType<typeof useConfirm>["confirm"];
}): BackendToggleState {
  const { text } = useI18n();
  const task = useBackendTask(clearNotice);

  const toggle = async (next: boolean) => {
    await task.run(async () => {
      setStatus(await setRemoteWriteEnabled(next));
      setNotice(next
        ? text("원격 편집을 허용했습니다", "Remote editing is allowed")
        : text("원격을 읽기 전용으로 바꿨습니다", "Remote is now read only"));
    }, {
      // 켜는 쪽만 확인받는다. 원격에 데스크톱과 같은 변경 권한을 주는 결정이고,
      // 끄는 쪽은 좁히는 방향이라 되돌리기 쉽다.
      confirm: next ? () => confirm({
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
      }) : null,
    });
  };

  // 원격 편집 허용은 원격이 자기 권한을 정하지 못하도록 호스트 화면 전용이다.
  // 데스크톱 앱이 아니어도 호스트의 브라우저(127.0.0.1)면 같은 자리다.
  const canManage = Boolean(access && !access.remote && access.writable);
  return {
    summary: remoteWriteSummaryText(task.error, loadError, status, access, canManage, text),
    // 조회 전에는 null — 알려진 값처럼 꺼짐으로 그리지 않는다(QA #34).
    checked: status ? status.remoteWrite : null,
    loadError: task.error ?? loadError,
    disabled: !canManage || task.busy || restarting,
    onChange: (next) => void toggle(next),
  };
}

/** 절전 억제 행. 조회도 토글도 이 행 안에서 끝나 다른 행과 나눠 쓰는 값이 없다. */
function useSleepPreventionToggle({ access, clearNotice, setNotice }: {
  access: WebAccessStatus | null;
  clearNotice: () => void;
  setNotice: (value: string | null) => void;
}): BackendToggleState {
  const { text } = useI18n();
  const task = useBackendTask(clearNotice);
  const [status, setStatus] = useState<SleepPreventionStatus | null>(null);

  useEffect(() => loadWhileMounted(
    getSleepPrevention,
    (next) => { setStatus(next); task.setError(null); },
    task.setError,
  ), []);

  const toggle = async (next: boolean) => {
    await task.run(async () => {
      const value = await setSleepPrevention(next);
      setStatus(value);
      // 설정은 저장됐지만 이 호스트에서 실제로 걸리지 않은 경우를 성공으로 보이면 안 된다.
      if (next && !value.active) {
        task.setError(value.error ?? text(
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

  return {
    summary: sleepSummaryText(task.error, status, text),
    checked: status ? status.enabled : null,
    loadError: task.error,
    highlighted: Boolean(status?.active),
    disabled: !access?.writable || task.busy,
    onChange: (next) => void toggle(next),
  };
}

/**
 * 시스템 시작 시 자동 시작 행. OS 로그인 항목(tauri autostart) 하나를 켜고 끈다 — 값은 앱
 * 전역이고 백엔드가 아니라 데스크톱 셸이 갖고 있어, 브라우저·원격 화면에서는 읽지도 바꾸지도
 * 못한다. 반복 요청 편집기에 요청별 칸처럼 놓여 있던 것을 여기로 옮겼다(2026-09-27):
 * 예약은 앱이 떠 있는 동안에는 이 값과 무관하게 돌고, 이 값이 정하는 것은 재부팅 뒤 앱을
 * 사람이 열기 전에도 예약이 돌게 할지뿐이다.
 */
function useLoginStartToggle({ nativeRuntime, clearNotice, setNotice }: {
  nativeRuntime: boolean;
  clearNotice: () => void;
  setNotice: (value: string | null) => void;
}): BackendToggleState {
  const { text } = useI18n();
  const task = useBackendTask(clearNotice);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!nativeRuntime) return;
    return loadWhileMounted(
      getBackgroundSettings,
      (next) => { setEnabled(next.loginStart); task.setError(null); },
      task.setError,
    );
  }, [nativeRuntime]);

  const toggle = async (next: boolean) => {
    await task.run(async () => {
      const value = await setBackgroundSettings(next);
      setEnabled(value.loginStart);
      setNotice(next
        ? text("시스템 시작 시 Agent Manager를 자동으로 시작합니다", "Agent Manager will start automatically at system startup")
        : text("시스템 시작 시 자동 시작을 해제했습니다", "Automatic start at system startup is off"));
    });
  };

  const summary = task.error
    ?? (!nativeRuntime
      ? text("호스트의 Agent Manager 데스크톱 앱에서만 바꿀 수 있습니다", "Only the Agent Manager desktop app on the host can change this")
      : enabled === null
        ? text("자동 시작 설정 확인 중…", "Checking automatic start…")
        : enabled
          ? text("로그인하면 트레이에서 자동으로 시작되어 반복 요청이 예정대로 실행됩니다", "Starts in the tray at login so scheduled requests run on time")
          : text("직접 실행하기 전까지는 반복 요청이 실행되지 않습니다", "Scheduled requests do not run until you open the app yourself"));

  return {
    summary,
    checked: enabled,
    loadError: task.error,
    disabled: !nativeRuntime || task.busy,
    onChange: (next) => void toggle(next),
  };
}

function RemoteAccessSettings() {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const nativeRuntime = hasTauriRuntime();
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const activePort = nativeRuntime ? currentBackendServicePort() : null;
  const [accessError, setAccessError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const [restarting, setRestarting] = useState(false);
  const tailscaleToggle = useTailscaleServiceToggle({
    nativeRuntime, access, restarting, setRestarting, clearNotice, setNotice, confirm,
  });
  const tailscale = tailscaleToggle.status;
  const remoteWriteRow = useRemoteWriteToggle({
    status: tailscale,
    setStatus: tailscaleToggle.setStatus,
    loadError: tailscaleToggle.task.error,
    access, restarting, clearNotice, setNotice, confirm,
  });
  const sleepRow = useSleepPreventionToggle({ access, clearNotice, setNotice });
  const loginStartRow = useLoginStartToggle({ nativeRuntime, clearNotice, setNotice });
  // Tailscale Serve가 이미 루프백 대상을 잡고 있으면 그 포트가 서비스 포트의
  // 원본이 된다. 사용자는 두 값을 따로 바꿀 수 없고 Serve 쪽을 따라간다.
  const tailscalePort = loopbackTargetPort(tailscale?.serveTarget ?? null);
  const runningPort = access?.backendPort ?? activePort;
  const servicePort = useBackendServicePort({
    nativeRuntime, tailscalePort, runningPort, clearNotice, setNotice, restarting, setRestarting, confirm,
  });
  const setPortText = servicePort.setPortText;

  // 접속 상태 조회. Tailscale·절전 조회는 각 행의 훅이 자기 몫으로 따로 건다 — 셋은
  // 순서가 정해져 있지 않고 각자 자기 오류 자리에 담기므로 한 효과로 묶을 이유가 없다.
  // 화면을 떠난 뒤 늦게 도착한 응답은 어느 갈래든 버린다.
  useEffect(() => loadWhileMounted(getWebAccessStatus, (next) => {
    setAccess(next);
    setAccessError(null);
    if (!nativeRuntime) setPortText(String(next.backendPort));
  }, setAccessError), [nativeRuntime]);

  // 원격(Tailscale)으로 접속했을 때도 요약에는 백엔드가 실제로 수신 중인
  // 루프백 주소를 보여준다. 원격 주소는 Tailscale 서비스 행에서 따로 안내한다.
  const serviceEndpoint = `127.0.0.1:${access?.backendPort ?? activePort ?? DEFAULT_BACKEND_SERVICE_PORT}`;
  const error = servicePort.task.error ?? accessError;
  const connectionSummary = access
    ? `${text("서비스주소", "Service address")} ${serviceEndpoint}`
    : error
      ? text("연결 오류", "Connection error")
      : text("연결 확인 중", "Checking connection");

  return (
    <section className="settings-subsection remote-access-card">
      <header>
        <div><strong>{text("시스템", "System")}</strong><small>{connectionSummary}</small></div>
      </header>
      <div className="backend-service-body">
        <BackendServicePortRow
          state={servicePort}
          nativeRuntime={nativeRuntime}
          tailscalePort={tailscalePort}
          runningPort={runningPort}
          restarting={restarting}
          showTailscaleNote={Boolean(tailscale?.available)}
          onPortTextChange={(value) => { setPortText(value); setNotice(null); }}
        />
        <BackendServiceToggleRow
          title={text("Tailscale 서비스", "Tailscale service")}
          {...tailscaleToggle.row}
        />
        <BackendServiceToggleRow
          title={text("원격 편집 허용", "Allow remote editing")}
          help={<HelpHint label={text("원격 편집 허용 설명", "How remote editing works")} title={text("원격 편집 허용", "Allow remote editing")}>
            {text(
              "원격(Tailscale) 접속에 데스크톱과 같은 변경 권한을 줄지 정합니다. 끄면 원격 화면은 조회만 되고 채팅 실행·계정 전환·편집이 모두 거절됩니다. 재시작 없이 바로 반영되지만 이미 열려 있는 채팅 스트림은 접속할 때의 권한으로 이어집니다. 켜도 계정 로그인처럼 호스트에서만 되는 작업은 원격에 열리지 않으며, 이 설정은 호스트 화면에서만 바꿀 수 있습니다.",
              "Decides whether remote (Tailscale) access gets the same change permissions as the desktop. While off, the remote UI can only view: starting chats, switching accounts, and editing are refused. It applies without a restart, but streams that are already open keep the permission they connected with. Host-only actions such as account login stay closed to remote either way, and only the host can change this setting.",
            )}
          </HelpHint>}
          {...remoteWriteRow}
        />
        <BackendServiceToggleRow
          title={text("절전 억제", "Prevent sleep")}
          help={<HelpHint label={text("절전 억제 동작 설명", "How preventing sleep works")} title={text("절전 억제", "Prevent sleep")}>
            {text(
              "호스트가 자동으로 잠들지 않게 막습니다. 호스트가 잠들면 백엔드도 멈춰 원격 화면에는 연결 실패로만 보이므로, 휴대폰에서 원격으로 쓰는 동안 켜 두세요. 자동 절전만 막습니다 — 노트북 뚜껑을 닫거나 직접 잠재우는 것은 그대로 동작합니다. 배터리로 쓰는 동안에는 소모가 늘어납니다.",
              "Keeps the host from sleeping on its own. When the host sleeps the backend stops with it, and the remote UI can only show a connection failure, so turn this on while you use Agent Manager from your phone. It blocks automatic sleep only — closing a laptop lid or sleeping the machine yourself still works. Expect higher battery drain while unplugged.",
            )}
          </HelpHint>}
          {...sleepRow}
        />
        <BackendServiceToggleRow
          title={text("시스템 시작 시 Agent Manager 자동 시작", "Start Agent Manager at system startup")}
          help={<HelpHint label={text("자동 시작 동작 설명", "How automatic start works")} title={text("시스템 시작 시 Agent Manager 자동 시작", "Start Agent Manager at system startup")}>
            {text(
              "OS 로그인 항목에 Agent Manager를 등록합니다. 켜면 로그인 직후 트레이에서 조용히 시작되어, 앱을 직접 열지 않아도 반복 요청이 예정된 시각에 실행됩니다. 끄면 앱을 실행하기 전까지 예약이 건너뛰어집니다. 앱이 떠 있는 동안의 실행에는 영향이 없으며, 이 설정은 호스트의 데스크톱 앱에서만 바꿀 수 있습니다.",
              "Registers Agent Manager as an OS login item. While on, it starts quietly in the tray right after login, so scheduled requests run on time even if you never open the app. While off, schedules are skipped until you launch the app. It does not affect runs while the app is already open, and only the desktop app on the host can change it.",
            )}
          </HelpHint>}
          {...loginStartRow}
        />
        {tailscale?.available && tailscale.enabled && !tailscale.remoteAccepted && <BackendServiceAlert
          message={nativeRuntime
            ? text(
                "Tailscale Serve는 켜져 있지만 현재 백엔드는 원격 요청을 받지 않습니다. 원격 접속 허용 설정으로 Agent Manager를 재시작하세요.",
                "Tailscale Serve is on, but the current backend does not accept remote requests. Restart Agent Manager with remote access enabled."
              )
            : text(
                "Tailscale Serve는 켜져 있지만 현재 백엔드는 원격 요청을 받지 않습니다. 호스트의 Agent Manager 데스크톱 앱에서 원격 허용으로 재시작하세요.",
                "Tailscale Serve is on, but the current backend does not accept remote requests. Restart with remote access enabled from the Agent Manager desktop app on the host."
              )}
          actions={nativeRuntime
            ? <button className="button primary compact" type="button" disabled={tailscaleToggle.task.busy || restarting} onClick={() => void tailscaleToggle.toggle(true)}>
              {restarting ? text("재시작 중…", "Restarting…") : text("원격 허용으로 재시작", "Restart with remote access")}
            </button>
            : null}
        />}
        {tailscaleToggle.conflict && <BackendServiceAlert
          message={text(
            "Tailscale Serve 루트 경로를 다른 서비스가 사용하고 있습니다. 덮어쓰면 기존 설정이 이 백엔드로 바뀝니다.",
            "Another service owns the Tailscale Serve root path. Overwriting repoints it to this backend.",
          )}
          actions={<>
            <button className="button secondary compact" type="button" disabled={tailscaleToggle.task.busy} onClick={() => { tailscaleToggle.setConflict(null); tailscaleToggle.task.setError(null); }}>{text("취소", "Cancel")}</button>
            <button className="button primary compact" type="button" disabled={tailscaleToggle.task.busy} onClick={() => void tailscaleToggle.toggle(true, true)}>{text("덮어쓰고 켜기", "Overwrite and turn on")}</button>
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
