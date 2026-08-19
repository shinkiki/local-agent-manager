import { ArrowDownToLine, ArrowUpToLine, Eraser, KeyRound, Languages, Monitor, Moon, Plus, Power, PowerOff, RefreshCw, Repeat, Server, Settings, ShieldAlert, Star, Sun, Trash2, X, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { beginProviderAccountLogin, cancelProviderAccountLogin, cancelUiTranslation, deleteProviderAccount, finishProviderAccountLogin, getBackendServiceSettings, getProviderAccounts, getTailscaleServiceStatus, getWebAccessStatus, hasTauriRuntime, listExternalProviderProcesses, refreshProviderAccountUsage, registerCurrentProviderAccount, requestSystemLanguage, resetMenuTranslation, restartApp, revalidateProviderAccountCredential, retryMenuTranslation, retryUiTranslation, setAutoSwitchResume, setBackendServiceSettings, setDefaultProviderAccount, setProviderAccountAutoSwitch, setProviderAccountDisabled, setSystemAutomationSettings, setTailscaleServiceEnabled, switchActiveProviderAccount, type BackendServiceSettings, type TailscaleServiceStatus, type WebAccessStatus } from "../lib/ipc";
import { getUiTranslationCatalog, useI18n } from "../lib/i18n";
import { accountUsageDisplayState } from "../lib/accountUsage";
import type { AccountLoginSessionView, AccountSnapshot, AccentColor, AppLocale, AutoSwitchEventView, MessageDisplayMode, ProviderAccountView, ProviderId, ProviderStatus, SystemAutomationSnapshot, ThemeMode, TranslationLanguage, TranslationMenu, TranslationStatus } from "../types";
import { aiaRuntimeProvider, canRunSystemAgent } from "../lib/aiaRuntime";
import { refreshProviderOptions } from "../lib/providerOptions";
import { currentBackendServicePort, DEFAULT_BACKEND_SERVICE_PORT, MAX_BACKEND_SERVICE_PORT, MIN_BACKEND_SERVICE_PORT } from "../lib/backend";
import { Drawer, ErrorBanner, SourceBadge } from "./Shared";
import { AccountLoginTerminalPanel } from "./TerminalPanel";

interface SettingsViewProps {
  active: boolean;
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  onAccountsChange: (snapshot: AccountSnapshot) => void;
  onConnectCli: (provider: ProviderStatus) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  accentColor: AccentColor;
  onAccentColorChange: (color: AccentColor) => void;
  messageDisplayMode: MessageDisplayMode;
  onMessageDisplayModeChange: (mode: MessageDisplayMode) => void;
  automation: SystemAutomationSnapshot | null;
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void;
  onRequestAiaPrompt: (text: string) => void;
  /// 사이드바 CLI 상태 버튼이 눌릴 때마다 증가한다. 값이 바뀌면 CLI 연결 탭을 연다.
  connectionsRequest: number;
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
type SettingsTabId = "connections" | "service" | "language" | "display" | "runtime";

// 채팅·세션 화면과 같은 중메뉴. 한 화면에 모든 카드를 쌓지 않고 탭으로 나눈다.
const settingsTabs: { id: SettingsTabId; icon: LucideIcon; ko: string; en: string }[] = [
  { id: "connections", icon: KeyRound, ko: "CLI 연결·계정", en: "CLI and accounts" },
  { id: "service", icon: Server, ko: "백엔드 서비스", en: "Backend service" },
  { id: "language", icon: Languages, ko: "언어·번역", en: "Language" },
  { id: "display", icon: Monitor, ko: "화면·채팅", en: "Display and chat" },
  { id: "runtime", icon: Settings, ko: "실행설정", en: "Runtime settings" },
];

export function SettingsView({ active, providers, accounts, onAccountsChange, onConnectCli, themeMode, onThemeModeChange, accentColor, onAccentColorChange, messageDisplayMode, onMessageDisplayModeChange, automation, onAutomationChange, onRequestAiaPrompt, connectionsRequest }: SettingsViewProps) {
  const { text } = useI18n();
  const [tab, setTab] = useState<SettingsTabId>("connections");
  useEffect(() => {
    if (connectionsRequest > 0) setTab("connections");
  }, [connectionsRequest]);
  const systemSections: SystemSectionId[] | null = tab === "connections"
    ? ["cli", "agent"]
    : tab === "service"
      ? ["service"]
      : tab === "language"
        ? ["language"]
        : null;
  return (
    <div className="settings-view">
      <nav className="chat-hub-tabs settings-hub-tabs" role="tablist" aria-label={text("설정 메뉴", "Settings menu")}>
        {settingsTabs.map((item) => (
          <button className={tab === item.id ? "active" : ""} type="button" role="tab" aria-selected={tab === item.id} key={item.id} onClick={() => setTab(item.id)}>
            <item.icon size={13} aria-hidden="true" /><span>{text(item.ko, item.en)}</span>
          </button>
        ))}
      </nav>
      {systemSections && <SystemAutomationSettingsCard sections={systemSections} providers={providers} accounts={accounts} onAccountsChange={onAccountsChange} onConnectCli={onConnectCli} automation={automation} onChange={onAutomationChange} />}
      {tab === "display" && <><section className="settings-card display-settings-card">
        <header>
          <div><span>{text("화면", "Display")}</span><h2>{text("화면 설정", "Display settings")}</h2></div>
          <p>{text("앱 전체의 테마와 강조 색상을 한곳에서 설정합니다.", "Configure the app theme and accent color in one place.")}</p>
        </header>
        <div className="settings-card-sections">
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
      {tab === "runtime" && <RuntimeSettingsUpdateCard active={active} providers={providers} aiaAvailable={Boolean(aiaRuntimeProvider(automation))} onRequestDiscovery={onRequestAiaPrompt} />}
      <p className="settings-storage-note">{text("이 설정은 호스트에 저장되며 공급자 채팅 원본에는 영향을 주지 않습니다.", "These settings are stored on the host and do not modify provider conversation sources.")}</p>
    </div>
  );
}

const DISCOVERY_WATCH_INTERVAL_MS = 15_000;
const DISCOVERY_WATCH_MAX_ATTEMPTS = 20;

function schemaDiscoveryPrompt(sources: ProviderId[]): string {
  return [
    `실행설정 스키마 갱신 요청입니다. 대상 공급자: ${sources.join(", ")}.`,
    "먼저 get_chat_provider_options로 공급자별 현재 스키마를 확인한 뒤,",
    "설치된 CLI 인터페이스를 직접 조사해 주세요 (예: `claude --help`, `codex --help`, `codex exec --help`).",
    "조사 결과 변경이 있는 공급자만 propose_chat_settings_schema를 호출해 실행설정 스키마를 갱신해 주세요.",
    "내장 항목은 선택지 재구성만 가능하고, 새 항목은 화이트리스트 범위에서만 추가할 수 있습니다.",
    "완료 후 변경 내역을 요약해 주세요.",
  ].join("\n");
}

// 디스커버리는 AIA가 CLI를 조사해 스키마를 갱신하므로, 시스템 에이전트를 고르지 않아
// AIA가 꺼져 있으면 실행할 수 없다.
function RuntimeSettingsUpdateCard({ active, providers, aiaAvailable, onRequestDiscovery }: { active: boolean; providers: ProviderStatus[]; aiaAvailable: boolean; onRequestDiscovery: (text: string) => void }) {
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
      const latest = options.find((item) => item.settingsUpdatedAt !== null)?.settingsUpdatedAt ?? null;
      setUpdatedAt(latest);
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
  const refresh = async () => {
    if (refreshing || !aiaAvailable) return;
    setRefreshing(true);
    const baseline = await loadUpdatedAt();
    const sources = sourceKey ? sourceKey.split(",") as ProviderId[] : [];
    if (sources.length > 0) {
      onRequestDiscovery(schemaDiscoveryPrompt(sources));
      startDiscoveryWatch(baseline === undefined ? null : baseline);
    }
    setRefreshing(false);
  };
  return (
    <section className="settings-card settings-update-card">
      <header>
        <div><span>{text("업데이트", "Updates")}</span><h2>{text("실행설정 인터페이스", "Runtime settings interface")}</h2></div>
        <p>{text("새로고침을 누르면 AIA가 CLI 인터페이스를 직접 조사해 채팅 실행설정 항목을 최신 스키마로 갱신합니다.", "Refresh asks AIA to inspect the CLI interfaces and update chat runtime setting fields to the latest schema.")}</p>
      </header>
      <div className="settings-update-body">
        <span className="settings-update-status">
          <strong>{text("마지막 업데이트", "Last updated")}</strong>
          <small>{!aiaAvailable
            ? text("시스템 에이전트를 선택하면 디스커버리를 실행할 수 있습니다", "Select a system agent to run discovery")
            : !loaded
            ? text("확인 중…", "Checking…")
            : watching
              ? text("AIA가 CLI 인터페이스를 조사하는 중… 완료되면 자동 반영됩니다.", "AIA is inspecting the CLI interfaces… results will appear automatically.")
              : updatedAt !== null
                ? text(`${new Date(updatedAt).toLocaleString()} 기준`, `As of ${new Date(updatedAt).toLocaleString()}`)
                : text("디스커버리 업데이트 이력이 없습니다 · 내장 스키마 사용 중", "No discovery updates yet · using the built-in schema")}</small>
        </span>
        <button className="button compact" type="button" disabled={refreshing || !aiaAvailable} title={aiaAvailable ? undefined : text("시스템 설정에서 시스템 에이전트를 선택하세요", "Select a system agent in system settings")} onClick={() => void refresh()}><RefreshCw size={13} />{refreshing ? text("새로 고치는 중…", "Refreshing…") : text("새로고침", "Refresh")}</button>
      </div>
      {error && <ErrorBanner message={error} />}
    </section>
  );
}

function CliConnectionSettingsSection({ providers, accounts, onAccountsChange, onConnect }: {
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  onAccountsChange: (snapshot: AccountSnapshot) => void;
  onConnect: (provider: ProviderStatus) => void;
}) {
  const { text } = useI18n();
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const connectedCount = providers.filter((provider) => provider.cli.detected).length;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [login, setLogin] = useState<AccountLoginSessionView | null>(null);
  const [loginLabel, setLoginLabel] = useState("");
  const [loginComplete, setLoginComplete] = useState(false);
  const [pendingActivation, setPendingActivation] = useState<{ account: ProviderAccountView; runtimeCount: number; externalCount: number } | null>(null);
  const canManage = access?.writable === true;
  const providerLabel = (provider: ProviderId) => (provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider);

  useEffect(() => {
    let disposed = false;
    void getWebAccessStatus()
      .then((next) => { if (!disposed) setAccess(next); })
      .catch((cause) => { if (!disposed) setError(errorText(cause)); });
    return () => { disposed = true; };
  }, []);

  const mutate = async (key: string, action: () => Promise<AccountSnapshot>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try { onAccountsChange(await action()); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(null); }
  };

  // 활성 계정 변경: 종료 대상(관리 세션·외부 CLI 프로세스) 수를 실행 직전에
  // 다시 조회하고, 종료 대상이 있으면 확인창을 거쳐 모두 종료 후 전환한다.
  const requestActivation = async (account: ProviderAccountView) => {
    if (busy) return;
    setBusy(`active-${account.id}`);
    setError(null);
    setNotice(null);
    setPendingActivation(null);
    try {
      const snapshot = await getProviderAccounts();
      onAccountsChange(snapshot);
      const providerState = snapshot.providers.find((state) => state.provider === account.provider);
      const runtimeCount = providerState?.runtimeCount ?? 0;
      // 외부 프로세스 조회 실패가 전환 자체를 막지 않게 한다. 실제 종료는 전환 시점에 백엔드가 다시 수행한다.
      const externalCount = await listExternalProviderProcesses(account.provider)
        .then((processes) => processes.length)
        .catch(() => 0);
      if (runtimeCount > 0 || externalCount > 0) {
        setBusy(null);
        setPendingActivation({ account, runtimeCount, externalCount });
        return;
      }
    } catch (cause) {
      setBusy(null);
      setError(errorText(cause));
      return;
    }
    setBusy(null);
    await performActivation(account);
  };

  const performActivation = async (account: ProviderAccountView) => {
    if (busy) return;
    setBusy(`active-${account.id}`);
    setError(null);
    setNotice(null);
    setPendingActivation(null);
    try {
      // Core가 실행 직전 다시 전체 대상을 확인하도록, 사전 조회 결과가 0이어도
      // 관리 런타임과 외부 CLI 종료 정책은 항상 활성화한다.
      const receipt = await switchActiveProviderAccount(account.id, true, true);
      let nextSnapshot = receipt.snapshot;
      let usageRefreshNote = "";
      try {
        nextSnapshot = await refreshProviderAccountUsage(account.id);
      } catch (cause) {
        usageRefreshNote = ` 사용량은 갱신하지 못했습니다: ${errorText(cause)}`;
      }
      onAccountsChange(nextSnapshot);
      const stoppedParts: string[] = [];
      if (receipt.stoppedCount > 0) stoppedParts.push(`관리 세션 ${receipt.stoppedCount}개${receipt.forcedCount > 0 ? ` (강제 ${receipt.forcedCount})` : ""}`);
      if (receipt.terminalStoppedCount > 0) stoppedParts.push(`관리 터미널 ${receipt.terminalStoppedCount}개${receipt.terminalForcedCount > 0 ? ` (강제 ${receipt.terminalForcedCount})` : ""}`);
      if (receipt.externalTerminatedCount > 0) stoppedParts.push(`외부 프로세스 ${receipt.externalTerminatedCount}개${receipt.externalForcedCount > 0 ? ` (강제 ${receipt.externalForcedCount})` : ""}`);
      const failureParts: string[] = [];
      if (receipt.terminalFailed.length > 0) failureParts.push(`관리 터미널 ${receipt.terminalFailed.length}개`);
      if (receipt.externalFailed.length > 0) failureParts.push(`외부 프로세스 ${receipt.externalFailed.length}개`);
      const failNote = failureParts.length > 0 ? ` ${failureParts.join("와 ")}는 종료되지 않았습니다.` : "";
      setNotice(stoppedParts.length > 0
        ? `${providerLabel(account.provider)} ${stoppedParts.join("와 ")}를 종료하고 활성 계정을 ${account.displayName}(으)로 변경했습니다.${failNote}${usageRefreshNote}`
        : `활성 계정을 ${account.displayName}(으)로 변경했습니다. 기존 대화 이력은 유지됩니다.${failNote}${usageRefreshNote}`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const beginLogin = async (provider: ProviderId, account?: ProviderAccountView) => {
    setBusy(account?.id ?? provider);
    setError(null);
    setNotice(null);
    setLoginComplete(false);
    try {
      setLogin(await beginProviderAccountLogin(provider, account?.id));
      setLoginLabel(account?.displayName ?? "");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
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
      setError("브라우저 인증 코드를 로그인 터미널에 전송하고 CLI가 정상 종료될 때까지 기다려 주세요.");
      return;
    }
    const id = login.id;
    const provider = login.provider;
    const reauthentication = Boolean(login.accountId);
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      const snapshot = await finishProviderAccountLogin(id, loginLabel.trim() || null);
      onAccountsChange(snapshot);
      setLogin(null);
      setLoginComplete(false);
      const providerState = snapshot.providers.find((state) => state.provider === provider);
      if (providerState?.pendingDefaultAccountId) {
        setNotice(`${provider === "codex" ? "Codex" : "Claude"} 로그인 정보를 저장했습니다. 실행 중인 런타임이 모두 종료되면 활성 인증에 적용합니다.`);
      } else {
        setNotice(reauthentication ? "로그인 정보를 저장하고 활성 인증에 적용했습니다." : "로그인 정보를 저장하고 계정 등록을 완료했습니다.");
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  return <>
    <section className="settings-subsection cli-status-settings-section" id="cli-connections">
      <header>
        <div><strong>{text("CLI 연결·계정", "CLI connections and accounts")}</strong><small>{text(
          "공급자별 CLI와 공유 히스토리를 유지하면서 활성 인증 계정과 사용량을 관리합니다.",
          "Manage active authentication accounts and usage while keeping shared provider history.",
        )}</small></div>
      </header>
      <div className="cli-status-settings-body">
        <div className="cli-settings-summary">
          <strong>{connectedCount}/{providers.length} {text("CLI 탐지", "CLIs detected")}</strong>
          <span>{access === null
              ? text("원격 계정 관리 권한을 확인하고 있습니다.", "Checking remote account management access.")
              : !canManage
                ? text("원격 write 모드가 꺼져 있어 계정과 사용량만 조회할 수 있습니다.", "Remote write mode is off; accounts and usage are read-only.")
                : access.remote
                ? text("원격 write 모드에서 계정 추가와 활성 인증 변경을 사용할 수 있습니다.", "Remote write mode allows account login and active authentication changes.")
                : text("활성 계정 변경은 중앙 백엔드에서 실행 중인 관리 세션과 외부 실행 CLI 프로세스(터미널·IDE)를 모두 종료한 뒤 적용됩니다(정상 종료 실패 시 강제 종료). 새 세션은 변경된 활성 계정을 사용합니다.", "The central backend changes the active account only after stopping managed sessions and externally launched CLI processes (terminal/IDE), force-killing any that fail to stop; new sessions use the activated account.")}</span>
        </div>
        <div className="cli-settings-list account-settings-list">
          {providers.map((provider) => {
            const providerAccounts = accounts?.accounts.filter((account) => account.provider === provider.provider) ?? [];
            const providerState = accounts?.providers.find((state) => state.provider === provider.provider);
            const selectedActiveAccount = providerAccounts.find((account) => account.id === providerState?.activeAccountId);
            const observedActiveAccount = providerAccounts.find((account) => account.id === providerState?.observedActiveAccountId);
            const activeAccountMismatch = Boolean(selectedActiveAccount && observedActiveAccount
              && selectedActiveAccount.id !== observedActiveAccount.id);
            const managed = provider.provider === "codex" || provider.provider === "claude";
            return <article className={`cli-settings-provider account-provider-card ${provider.cli.detected ? "ready" : "needs-connection"}`} key={provider.provider}>
              <div className="account-provider-head">
                <SourceBadge source={provider.provider} />
                <span className="cli-settings-provider-copy"><strong>{provider.displayName}</strong><small>{provider.cli.path ?? text("CLI 실행 파일이 탐지되지 않았습니다.", "CLI executable was not detected.")}</small></span>
                <span className="cli-settings-provider-states">
                  <em className={provider.cli.detected ? "health ready" : "health warning"}>{provider.cli.detected ? text("CLI 탐지됨", "CLI detected") : text("연결 필요", "Connection required")}</em>
                  {providerState?.transitionInProgress && <em className="health warning">전환 중</em>}
                  {providerState?.pendingDefaultAccountId && <em className="health warning">전환 대기</em>}
                  <button className="button compact" type="button" onClick={() => onConnect(provider)}>{text("CLI 확인", "Check CLI")}</button>
                </span>
              </div>
              {activeAccountMismatch && selectedActiveAccount && observedActiveAccount
                ? <div className="account-active-mismatch" role="alert">
                  <ShieldAlert size={15} aria-hidden="true" />
                  <span><strong>{text(
                    `Agent Manager 선택: ${selectedActiveAccount.displayName} · CLI 실제 활성: ${observedActiveAccount.displayName}`,
                    `Agent Manager selection: ${selectedActiveAccount.displayName} · Actual CLI account: ${observedActiveAccount.displayName}`,
                  )}</strong><small>{text(
                    "사용량은 두 계정을 일치시킨 뒤 활성 계정에서만 갱신합니다.",
                    "Usage refresh is enabled only after the selected and actual CLI accounts match.",
                  )}</small></span>
                </div>
                : providerState?.recoveryError && <ErrorBanner message={`계정 복원 필요: ${providerState.recoveryError}`} />}
              {managed && <div className="provider-account-list">
                {providerAccounts.length === 0 && <p className="provider-account-empty">등록된 계정이 없습니다. 현재 공유 홈의 로그인을 가져오거나 새 계정 로그인을 시작하세요.</p>}
                {providerAccounts.map((account) => <ProviderAccountRow
                  key={account.id}
                  account={account}
                  providerState={providerState}
                  editable={canManage}
                  busyKey={busy}
                  activationConfirmation={pendingActivation?.account.id === account.id
                    ? { runtimeCount: pendingActivation.runtimeCount, externalCount: pendingActivation.externalCount }
                    : null}
                  onActivate={() => void requestActivation(account)}
                  onCancelActivation={() => setPendingActivation(null)}
                  onConfirmActivation={() => void performActivation(account)}
                  onDefault={() => void mutate(`default-${account.id}`, () => setDefaultProviderAccount(account.id))}
                  onRevalidate={() => void mutate(`validate-${account.id}`, () => revalidateProviderAccountCredential(account.id))}
                  onReauthenticate={() => void beginLogin(provider.provider, account)}
                  onToggleDisabled={() => void mutate(`disabled-${account.id}`, () => setProviderAccountDisabled(account.id, !account.disabled))}
                  onToggleAutoSwitch={() => void mutate(`autoswitch-${account.id}`, () => setProviderAccountAutoSwitch(account.id, !account.autoSwitch))}
                  onDelete={() => { if (window.confirm(`'${account.displayName}' 계정 등록과 보안 저장소 자격증명을 삭제할까요? 공급자 히스토리는 유지됩니다.`)) void mutate(`delete-${account.id}`, () => deleteProviderAccount(account.id)); }}
                  onRefreshUsage={() => void mutate(`usage-${account.id}`, () => refreshProviderAccountUsage(account.id))}
                />)}
                {providerState?.lastAutoSwitch && <ProviderAutoSwitchNote accounts={providerAccounts} event={providerState.lastAutoSwitch} />}
                <div className="provider-account-add-actions">
                  {canManage && provider.cli.detected && <button className="button compact" type="button" disabled={Boolean(busy)} onClick={() => void beginLogin(provider.provider)}><Plus size={13} />계정 추가</button>}
                  {canManage && provider.cli.detected && providerAccounts.length === 0 && <button className="button compact" type="button" disabled={Boolean(busy)} onClick={() => void mutate(`capture-${provider.provider}`, () => registerCurrentProviderAccount(provider.provider))}>현재 로그인 가져오기</button>}
                </div>
              </div>}
            </article>;
          })}
        </div>
        <div className="account-advanced-toggle">
          <span><strong>자동전환 후 세션 복원</strong><small>사용량 한도로 계정이 자동전환되면, 그때 종료된 실행 중 채팅을 새 계정에서 이어서(resume) 다시 시작합니다. 진행 중이던 응답·대기 메시지는 복구되지 않습니다.</small></span>
          <AppToggle
            checked={accounts?.autoSwitchResume ?? true}
            disabled={!canManage || Boolean(busy) || !accounts}
            label="자동전환 후 세션 복원"
            onChange={() => { if (accounts) void mutate("autoswitch-resume", () => setAutoSwitchResume(!accounts.autoSwitchResume)); }}
          />
        </div>
        {notice && <p className="account-action-notice" role="status">{notice}</p>}
        {error && <ErrorBanner message={error} />}
      </div>
    </section>
    {login && <Drawer title={<><SourceBadge source={login.provider} /><span>{login.accountId ? "계정 재인증" : "계정 추가"}</span></>} onClose={() => void closeLogin()}>
      <label className="account-login-label"><span>표시명</span><input value={loginLabel} onChange={(event) => setLoginLabel(event.target.value)} placeholder="비워두면 공급자 계정 이름 사용" /></label>
      <AccountLoginTerminalPanel login={login} onCompletionChange={setLoginComplete} />
      {!loginComplete && <p className="account-login-completion-hint">브라우저 인증 후 표시된 코드를 터미널에 전송하세요. CLI가 정상 종료되어야 저장할 수 있습니다.</p>}
      <div className="cli-connect-actions"><button className="button" type="button" disabled={busy === login.id} onClick={() => void closeLogin()}>취소</button><button className="button primary" type="button" disabled={busy === login.id || !loginComplete} onClick={() => void finishLogin()}>{busy === login.id ? "저장 중…" : "로그인 완료 저장"}</button></div>
    </Drawer>}
  </>;
}

function ProviderAutoSwitchNote({ accounts, event }: { accounts: ProviderAccountView[]; event: AutoSwitchEventView }) {
  const name = (id: string) => accounts.find((account) => account.id === id)?.displayName ?? id;
  const reason = event.reason === "usageExhausted" ? "사용량 100% 도달" : "에이전트 제한 응답";
  return <p className="provider-auto-switch-note"><Repeat size={12} aria-hidden="true" />자동전환됨: {name(event.fromAccountId)} → {name(event.toAccountId)} · {reason} · {new Date(event.at).toLocaleString()}{event.resumedSessionCount > 0 && ` · 세션 ${event.resumedSessionCount}개 복원`}</p>;
}

function ProviderAccountRow({ account, providerState, editable, busyKey, activationConfirmation, onActivate, onCancelActivation, onConfirmActivation, onDefault, onRevalidate, onReauthenticate, onToggleDisabled, onToggleAutoSwitch, onDelete, onRefreshUsage }: {
  account: ProviderAccountView;
  providerState: AccountSnapshot["providers"][number] | undefined;
  editable: boolean;
  busyKey: string | null;
  activationConfirmation: { runtimeCount: number; externalCount: number } | null;
  onActivate: () => void;
  onCancelActivation: () => void;
  onConfirmActivation: () => void;
  onDefault: () => void;
  onRevalidate: () => void;
  onReauthenticate: () => void;
  onToggleDisabled: () => void;
  onToggleAutoSwitch: () => void;
  onDelete: () => void;
  onRefreshUsage: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const busy = busyKey !== null;
  const refreshing = busyKey === `usage-${account.id}`;
  const windows = account.usage.windows;
  const authFailed = account.authStatus !== "ready";
  const observedActive = providerState?.observedActiveAccountId === account.id;
  const canDelete = !account.isActive && !observedActive && !account.isDefault && !account.isPendingDefault && (providerState?.runtimeCount ?? 0) === 0;
  const observedAccountKnown = providerState?.observedActiveAccountId != null;
  const selectedOnly = account.isActive && observedAccountKnown && !observedActive;
  const alignedActive = account.isActive && (!observedAccountKnown || observedActive);
  const usageDisplay = accountUsageDisplayState(account, providerState?.observedActiveAccountId ?? null);
  const hasBadges = account.isDefault || account.isPendingDefault || account.disabled || account.autoSwitch || authFailed || observedActive || selectedOnly;
  const activationLabel = alignedActive
    ? "활성 계정"
    : selectedOnly
      ? "CLI에 적용"
      : observedActive
        ? "선택에 반영"
        : "계정 활성";
  const activationTitle = alignedActive
    ? "Agent Manager 선택과 CLI 실제 활성 계정이 일치합니다"
    : selectedOnly
      ? "저장된 이 계정 자격증명을 CLI 공유 홈에 다시 적용합니다"
      : observedActive
        ? "CLI에서 실제 사용 중인 이 계정을 Agent Manager 활성 선택에 반영합니다"
        : "이 계정을 활성 계정으로 전환";
  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOutside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);
  const deleteHint = canDelete
    ? "계정 등록과 자격증명을 삭제합니다"
    : (providerState?.runtimeCount ?? 0) > 0
      ? "실행 중인 런타임이 있어 삭제할 수 없습니다"
      : "활성·기본 계정은 삭제할 수 없습니다";
  const runMenuAction = (action: () => void) => { setMenuOpen(false); action(); };
  return <div className={`provider-account-row${account.disabled ? " disabled" : ""}${authFailed ? " needs-auth" : ""}${activationConfirmation ? " confirming-activation" : ""}`}>
    <div className="provider-account-head">
      <span className="provider-account-identity"><strong>{account.displayName}</strong><small>{[account.email, account.organization].filter(Boolean).join(" · ") || account.providerAccountId}</small></span>
      {hasBadges && <span className="provider-account-badges">{account.isDefault && <em className="health muted">기본</em>}{account.isPendingDefault && <em className="health warning">전환 대기</em>}{account.disabled && <em className="health muted">비활성</em>}{account.autoSwitch && <em className="health muted">자동전환</em>}{selectedOnly && <em className="health warning">Agent Manager 선택</em>}{observedActive && <em className="health ready">CLI 실제 활성</em>}{authFailed && <em className="health warning">재인증 필요</em>}</span>}
      {editable && <div className="provider-account-controls">
        <button className={`button compact${alignedActive ? " active-account" : ""}`} type="button" disabled={busy || account.disabled || authFailed || alignedActive || Boolean(providerState?.transitionInProgress)} title={activationTitle} onClick={onActivate}>{activationLabel}</button>
        <div className="account-menu" ref={menuRef}>
          <button className={`icon-button compact${menuOpen ? " active" : ""}`} type="button" disabled={busy} aria-haspopup="menu" aria-expanded={menuOpen} aria-label="계정 관리 메뉴" title="계정 관리" onClick={() => setMenuOpen((open) => !open)}><Settings size={13} /></button>
          {menuOpen && <div className="account-menu-panel" role="menu" aria-label={`${account.displayName} 계정 관리`}>
            {!authFailed && <button type="button" role="menuitem" disabled={busy} title="공급자 CLI 로그인을 다시 실행합니다" onClick={() => runMenuAction(onReauthenticate)}><KeyRound size={13} aria-hidden="true" />재인증</button>}
            <button type="button" role="menuitem" disabled={busy || account.disabled || account.isDefault} title={account.isDefault ? "이미 기본 계정입니다" : "새 런타임이 사용할 기본 계정으로 지정합니다"} onClick={() => runMenuAction(onDefault)}><Star size={13} aria-hidden="true" />기본 계정으로 설정</button>
            <button type="button" role="menuitem" disabled={busy || account.isActive || observedActive} title={account.isActive || observedActive ? "Agent Manager 선택 또는 CLI 실제 활성 계정은 비활성화할 수 없습니다" : undefined} onClick={() => runMenuAction(onToggleDisabled)}>{account.disabled ? <><Power size={13} aria-hidden="true" />활성화</> : <><PowerOff size={13} aria-hidden="true" />비활성화</>}</button>
            <button type="button" role="menuitem" disabled={busy || account.disabled} title="사용량 100% 도달 또는 에이전트의 제한 응답 시 자동전환이 켜진 계정끼리 활성 계정을 순환합니다" onClick={() => runMenuAction(onToggleAutoSwitch)}><Repeat size={13} aria-hidden="true" />{account.autoSwitch ? "자동전환 끄기" : "자동전환 켜기"}</button>
            <span className="account-menu-divider" role="separator" />
            <button className="danger" type="button" role="menuitem" disabled={busy || !canDelete} title={deleteHint} onClick={() => runMenuAction(onDelete)}><Trash2 size={13} aria-hidden="true" />삭제</button>
          </div>}
        </div>
      </div>}
    </div>
    {activationConfirmation && <div className="account-switch-confirm" role="alertdialog" aria-label={`${account.displayName} 계정 전환 확인`}>
      <ShieldAlert size={16} aria-hidden="true" />
      <span>
        <strong>계정 전환 전 확인</strong>
        <small>
          {account.provider === "codex" ? "Codex" : "Claude"} 관리 세션 {activationConfirmation.runtimeCount}개와 외부 실행 프로세스(터미널·IDE) {activationConfirmation.externalCount}개를 모두 종료하고 {account.displayName} 계정으로 변경합니다.
          정상 종료가 실패하면 강제 종료하며, 진행 중 응답·승인 요청·대기 메시지는 복구되지 않을 수 있습니다. 기존 대화 이력은 삭제되지 않습니다.
        </small>
      </span>
      <div className="account-switch-confirm-actions">
        <button className="button compact" type="button" disabled={busy} onClick={onCancelActivation} autoFocus>취소</button>
        <button className="button compact primary" type="button" disabled={busy} onClick={onConfirmActivation}>확인</button>
      </div>
    </div>}
    <div className="provider-account-usage">
      <div className="account-usage-head">
        <strong>사용량</strong>
        <button className={`icon-button compact${refreshing ? " busy" : ""}`} type="button" disabled={busy || !usageDisplay.canRefresh} aria-label="사용량 새로고침" title={usageDisplay.canRefresh ? "활성 계정 사용량 새로고침" : account.isActive ? "CLI의 실제 활성 계정과 일치시킨 후 조회할 수 있습니다" : "활성 계정으로 전환한 후 조회할 수 있습니다"} onClick={onRefreshUsage}><RefreshCw size={13} /></button>
      </div>
      {windows.length > 0 && <ul className="account-usage-meters">
        {windows.map((window) => {
          const percent = Math.min(100, Math.max(0, window.usedPercent));
          return <li className={usageLevel(percent)} key={window.label}>
            <span><em>{window.label}</em><b>{Math.round(percent)}%</b></span>
            <div className="progress" role="img" aria-label={`${window.label} 사용량 ${Math.round(percent)}%`}><span style={{ width: `${percent}%` }} /></div>
            {window.resetsAt !== null && <small>{new Date(window.resetsAt).toLocaleString()} 초기화</small>}
          </li>;
        })}
      </ul>}
      <small className={`account-usage-note${usageDisplay.error ? " error" : ""}`}>{usageDisplay.error
        ?? (!account.isActive
          ? usageDisplay.cached && account.usage.updatedAt !== null
            ? `${new Date(account.usage.updatedAt).toLocaleString()} 마지막 성공 조회 · 활성화 후 갱신`
            : "활성 계정으로 전환하면 사용량을 조회합니다."
          : account.usage.updatedAt !== null
            ? `${new Date(account.usage.updatedAt).toLocaleString()} 기준`
            : "아직 조회하지 않았습니다. 새로고침으로 사용량을 확인하세요.")}</small>
    </div>
    {authFailed && <div className={`account-auth-alert${account.isActive ? "" : " inactive"}`} role="alert">
      <ShieldAlert size={15} aria-hidden="true" />
      <span><strong>{account.isActive
        ? account.authStatus === "missing" ? "보안 저장소에서 자격증명을 찾지 못했습니다" : "저장된 자격증명을 사용할 수 없습니다"
        : "활성화 전 재인증이 필요합니다"}</strong><small>{account.isActive
        ? "재인증을 완료해야 활성 인증을 복구할 수 있습니다."
        : "현재는 실시간 사용량을 조회하지 않으며, 이 계정을 활성화하려면 먼저 재인증해야 합니다."}</small></span>
      {editable && <div className="account-auth-actions">
        <button className="button compact" type="button" disabled={busy} onClick={onRevalidate}>저장 자격증명 확인</button>
        <button className="button compact" type="button" disabled={busy} onClick={onReauthenticate}>재인증</button>
      </div>}
    </div>}
  </div>;
}

function usageLevel(percent: number): string {
  if (percent >= 90) return "critical";
  if (percent >= 70) return "warning";
  return "normal";
}

// 시스템 설정은 중메뉴 탭별로 필요한 구획만 그린다. 번역 진행 상태와 저장
// 상태를 구획끼리 공유하므로 컴포넌트는 하나로 두고 렌더 대상만 나눈다.
function SystemAutomationSettingsCard({ sections, providers, accounts, onAccountsChange, onConnectCli, automation, onChange }: {
  sections: SystemSectionId[];
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  onAccountsChange: (snapshot: AccountSnapshot) => void;
  onConnectCli: (provider: ProviderStatus) => void;
  automation: SystemAutomationSnapshot | null;
  onChange: (snapshot: SystemAutomationSnapshot) => void;
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

  const changeLanguage = async (code: string) => {
    if (!automation || saving) return;
    const languages = [...builtInTranslationLanguages, ...automation.settings.additionalTranslationLanguages];
    const language = languages.find((item) => item.code === code);
    if (!language) return;
    setSaving(true);
    setError(null);
    setLanguageError(null);
    try {
      onChange(await requestSystemLanguage({ language, catalog: getUiTranslationCatalog() }));
    } catch (cause) {
      setLanguageError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const retryUi = async () => {
    setSaving(true);
    setLanguageError(null);
    try {
      onChange(await retryUiTranslation());
    } catch (cause) {
      setLanguageError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const cancelUi = async () => {
    setSaving(true);
    setLanguageError(null);
    try {
      onChange(await cancelUiTranslation());
    } catch (cause) {
      setLanguageError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

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
    setSaving(true);
    setError(null);
    try {
      onChange(await retryMenuTranslation(menu));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  // 저장된 번역을 버리는 유일한 조작이므로 한 번 더 확인받는다.
  const reset = async (menu: TranslationMenu) => {
    setSaving(true);
    setError(null);
    try {
      onChange(await resetMenuTranslation(menu));
      setPendingReset(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-card system-automation-card">
      <div className="settings-card-sections system-automation-body">
        {sections.includes("cli") && <CliConnectionSettingsSection providers={providers} accounts={accounts} onAccountsChange={onAccountsChange} onConnect={onConnectCli} />}
        {sections.includes("agent") && <section className="settings-subsection system-agent-section">
          <header><div><strong>{text("시스템 에이전트", "System agent")}</strong><small>{text("AIA 실행과 UI·콘텐츠 자동번역에 사용할 연결된 CLI를 선택합니다. 바꾸면 AIA가 즉시 새 공급자로 다시 시작합니다.", "Choose the connected CLI that runs AIA and translates UI and content. Changing it restarts AIA on the new provider.")}</small></div></header>
          {!automation ? <div className="settings-inline-loading">{text("시스템 자동화 설정을 불러오는 중…", "Loading system automation settings…")}</div> : (
            <div className="system-provider-list" role="radiogroup" aria-label={text("시스템 에이전트", "System agent")}>
              <button type="button" role="radio" aria-checked={!automation.settings.systemProvider} className={!automation.settings.systemProvider ? "selected" : ""} disabled={saving} onClick={() => void save({ systemProvider: null, translations: { skills: false, agents: false, artifacts: false } })}><strong>{text("선택 안 함", "None")}</strong><small>{text("AIA와 자동번역을 사용하지 않습니다", "AIA and automatic translation stay off")}</small></button>
              {automation.providers.filter((provider) => canRunSystemAgent(provider.provider as ProviderId)).map((provider) => {
                const connected = provider.cli.detected;
                const selected = automation.settings.systemProvider === provider.provider;
                return <button type="button" role="radio" aria-checked={selected} className={selected ? "selected" : ""} disabled={saving || !connected} onClick={() => void save({ systemProvider: provider.provider as ProviderId })} key={provider.provider}><strong>{provider.displayName}</strong><small>{connected ? text("CLI 연결됨", "CLI connected") : text("CLI 연결 필요", "CLI connection required")}</small></button>;
              })}
            </div>
          )}
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
            <p className="translation-language-note">{automation.settings.translations.skills || automation.settings.translations.agents || automation.settings.translations.artifacts
              ? text("번역 언어를 바꾸면 활성화된 메뉴를 새 언어로 다시 번역하며 선택한 CLI 사용량이 발생합니다.", "Changing the language retranslates enabled menus and uses the selected CLI quota.")
              : text("언어를 추가한 뒤 목록에서 선택할 수 있습니다.", "Add a language, then select it from the list.")}</p>
            {languageError && <p className="translation-language-error" role="alert">{languageError}</p>}
          </div>
          <div className="translation-toggle-list">
            {(["skills", "agents", "artifacts"] as TranslationMenu[]).map((menu) => {
              const status = automation[menu];
              const enabled = automation.settings.translations[menu];
              const label = menu === "skills" ? text("스킬", "Skills") : menu === "agents" ? text("에이전트", "Agents") : text("아티팩트", "Artifacts");
              return <div className={`translation-toggle-row ${status.phase}${enabled ? " enabled" : ""}`} key={menu}>
                <div className="translation-toggle-main">
                  <span><strong>{label}</strong><small>{translationStatusText(status, locale)}</small></span>
                  <div className="translation-toggle-actions">
                    {(status.phase === "partial" || status.phase === "error") && <button className="button secondary compact" type="button" disabled={saving} onClick={() => void retry(menu)}><RefreshCw size={13} />{text("재시도", "Retry")}</button>}
                    {status.total > 0 && <button className="button secondary compact" type="button" disabled={saving} onClick={() => { setPendingReset(menu); setPendingMenu(null); }}><Eraser size={13} />{text("번역 초기화", "Reset translation")}</button>}
                    <AppToggle checked={enabled} disabled={saving} label={label} onChange={(next) => void setMenu(menu, next)} />
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

function translationStatusText(status: TranslationStatus, locale: AppLocale): string {
  const labels: Record<string, [string, string]> = {
    disabled: ["목록과 상세 내용을 자동번역합니다", "Translates list and detail content"], queued: ["대기 중", "Queued"], running: ["번역 중", "Translating"],
    complete: ["완료", "Complete"], partial: ["일부 실패", "Partially failed"], paused: ["CLI 연결 대기", "Waiting for CLI"], error: ["오류", "Error"],
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

function RemoteAccessSettings() {
  const { text } = useI18n();
  const nativeRuntime = hasTauriRuntime();
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [serviceSettings, setServiceSettings] = useState<BackendServiceSettings | null>(null);
  const activePort = nativeRuntime ? currentBackendServicePort() : null;
  const [portText, setPortText] = useState(String(DEFAULT_BACKEND_SERVICE_PORT));
  const [saving, setSaving] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleServiceStatus | null>(null);
  const [tailscaleBusy, setTailscaleBusy] = useState(false);
  const [tailscaleError, setTailscaleError] = useState<string | null>(null);
  const [tailscaleConflict, setTailscaleConflict] = useState<string | null>(null);
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
    void getWebAccessStatus()
      .then((next) => {
        if (disposed) return;
        setAccess(next);
        setAccessError(null);
        if (!nativeRuntime) setPortText(String(next.backendPort));
      })
      .catch((cause) => { if (!disposed) setAccessError(errorText(cause)); });
    void getTailscaleServiceStatus()
      .then((next) => { if (!disposed) { setTailscale(next); setTailscaleError(null); } })
      .catch((cause) => { if (!disposed) setTailscaleError(errorText(cause)); });
    if (nativeRuntime) {
      void getBackendServiceSettings()
        .then((next) => {
          if (disposed) return;
          setServiceSettings(next);
          setPortText(String(next.port));
          setSettingsError(null);
        })
        .catch((cause) => { if (!disposed) setSettingsError(errorText(cause)); });
    }
    return () => { disposed = true; };
  }, [nativeRuntime]);

  const savePort = async () => {
    if (!nativeRuntime || portError || saving || serviceSettings?.port === port) return;
    setSaving(true);
    setSettingsError(null);
    setNotice(null);
    try {
      const next = await setBackendServiceSettings(port);
      setServiceSettings(next);
      setPortText(String(next.port));
      setNotice(text(
        `포트 ${next.port} 저장됨 · 다음 실행부터 적용`,
        `Port ${next.port} saved · applies on next launch`,
      ));
    } catch (cause) {
      setSettingsError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const runningPort = access?.backendPort ?? activePort;
  const savedPort = serviceSettings?.port ?? null;
  // 적용 예정 포트. Tailscale Serve 대상이 있으면 그 포트가 우선한다.
  const pendingPort = portFollowsTailscale ? tailscalePort : savedPort;
  const restartRequired = nativeRuntime && pendingPort !== null && runningPort !== null
    && pendingPort !== runningPort;

  const applyPortAndRestart = async () => {
    if (!nativeRuntime || pendingPort === null || restarting) return;
    if (!window.confirm(text(
      `서비스 포트를 ${pendingPort}(으)로 적용하려면 Agent Manager를 재시작해야 합니다. 실행 중인 채팅과 터미널이 종료됩니다. 지금 재시작할까요?`,
      `Applying service port ${pendingPort} requires restarting Agent Manager. Running chats and terminals will stop. Restart now?`,
    ))) return;
    setRestarting(true);
    setSettingsError(null);
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
      setSettingsError(errorText(cause));
      setRestarting(false);
    }
  };

  // 원격(Tailscale)으로 접속했을 때도 요약에는 백엔드가 실제로 수신 중인
  // 루프백 주소를 보여준다. 원격 주소는 Tailscale 서비스 행에서 따로 안내한다.
  const serviceEndpoint = `127.0.0.1:${access?.backendPort ?? activePort ?? DEFAULT_BACKEND_SERVICE_PORT}`;
  const error = settingsError ?? accessError;
  const connectionSummary = access
    ? `${text("서비스주소", "Service address")} ${serviceEndpoint}`
    : error
      ? text("연결 오류", "Connection error")
      : text("연결 확인 중", "Checking connection");
  const canManageTailscale = Boolean(access?.writable) && Boolean(tailscale?.available);
  const tailscaleSummary = tailscaleError
    ? tailscaleError
    : !tailscale
      ? text("Tailscale 상태 확인 중…", "Checking Tailscale status…")
      : !tailscale.available
        ? tailscale.error ?? text("Tailscale을 사용할 수 없습니다.", "Tailscale is unavailable.")
        : tailscale.enabled
          ? `${text("서비스주소", "Service address")} ${tailscale.url ?? `https://${tailscale.host ?? ""}`}${tailscale.remoteWrite ? "" : ` · ${text("원격 읽기 전용", "Remote read only")}`}`
          : tailscale.conflictTarget
            ? `${text("다른 서비스가 Serve 루트를 사용 중", "Another service owns the Serve root")}: ${tailscale.conflictTarget}`
            : tailscale.host
              ? `${text("꺼짐 · 켜면", "Off · turns on at")} https://${tailscale.host}`
              : text("꺼짐", "Off");

  const toggleTailscale = async (next: boolean, replaceExisting = false) => {
    if (tailscaleBusy) return;
    // 원격에서 끄면 지금 쓰는 접속 경로가 사라지므로 한 번 더 확인받는다.
    if (!next && access?.remote
      && !window.confirm(text(
        "Tailscale 서비스를 끄면 이 원격 접속이 끊깁니다. 계속할까요?",
        "Turning the Tailscale service off will drop this remote connection. Continue?",
      ))) return;
    setTailscaleBusy(true);
    setTailscaleError(null);
    setNotice(null);
    try {
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
    } catch (cause) {
      const message = errorText(cause);
      setTailscaleError(message);
      // 루트 경로를 다른 서비스가 쓰고 있으면 덮어쓰기 여부를 사용자가 정한다.
      setTailscaleConflict(next && message.includes("Serve 루트 경로") ? message : null);
    } finally {
      setTailscaleBusy(false);
      setRestarting(false);
    }
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
            <input type="number" min={MIN_BACKEND_SERVICE_PORT} max={MAX_BACKEND_SERVICE_PORT} value={displayPortText} readOnly={portFollowsTailscale} disabled={!nativeRuntime || saving || !serviceSettings || portFollowsTailscale} onChange={(event) => { setPortText(event.target.value); setNotice(null); }} inputMode="numeric" />
            {!portFollowsTailscale && <button className="button primary compact" type="button" disabled={!nativeRuntime || saving || Boolean(portError) || !serviceSettings || serviceSettings.port === port} onClick={() => void savePort()}>
              {saving ? text("저장 중…", "Saving…") : text("저장", "Save")}
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
        {restartRequired && <div className="backend-service-conflict" role="alert">
          <p>{text(
            `서비스 포트 ${pendingPort}이(가) 아직 적용되지 않았습니다. 현재 백엔드는 ${runningPort} 포트로 실행 중이며, 재시작해야 새 포트로 바뀝니다.`,
            `Service port ${pendingPort} is not applied yet. The backend is still running on port ${runningPort}; restart to switch to the new port.`,
          )}</p>
          <div>
            <button className="button primary compact" type="button" disabled={restarting} onClick={() => void applyPortAndRestart()}>
              {restarting ? text("재시작 중…", "Restarting…") : text("지금 재시작", "Restart now")}
            </button>
          </div>
        </div>}
        <div className={`backend-service-toggle${tailscale?.enabled ? " enabled" : ""}`}>
          <span>
            <strong>{text("Tailscale 서비스", "Tailscale service")}</strong>
            <small>{tailscaleSummary}</small>
          </span>
          <AppToggle
            checked={Boolean(tailscale?.enabled)}
            disabled={!canManageTailscale || tailscaleBusy || restarting}
            label={text("Tailscale 서비스", "Tailscale service")}
            onChange={(next) => void toggleTailscale(next)}
          />
        </div>
        {tailscale?.available && tailscale.enabled && !tailscale.remoteAccepted && <div className="backend-service-conflict" role="alert">
          <p>{text(
            nativeRuntime
              ? "Tailscale Serve는 켜져 있지만 현재 백엔드는 원격 요청을 받지 않습니다. 원격 접속 허용 설정으로 Agent Manager를 재시작하세요."
              : "Tailscale Serve는 켜져 있지만 현재 백엔드는 원격 요청을 받지 않습니다. 호스트의 Agent Manager 데스크톱 앱에서 원격 허용으로 재시작하세요.",
            nativeRuntime
              ? "Tailscale Serve is on, but the current backend does not accept remote requests. Restart Agent Manager with remote access enabled."
              : "Tailscale Serve is on, but the current backend does not accept remote requests. Restart with remote access enabled from the Agent Manager desktop app on the host.",
          )}</p>
          {nativeRuntime && <div>
            <button className="button primary compact" type="button" disabled={tailscaleBusy || restarting} onClick={() => void toggleTailscale(true)}>
              {restarting ? text("재시작 중…", "Restarting…") : text("원격 허용으로 재시작", "Restart with remote access")}
            </button>
          </div>}
        </div>}
        {tailscaleConflict && <div className="backend-service-conflict" role="alert">
          <p>{text(
            "Tailscale Serve 루트 경로를 다른 서비스가 사용하고 있습니다. 덮어쓰면 기존 설정이 이 백엔드로 바뀝니다.",
            "Another service owns the Tailscale Serve root path. Overwriting repoints it to this backend.",
          )}</p>
          <div>
            <button className="button secondary compact" type="button" disabled={tailscaleBusy} onClick={() => { setTailscaleConflict(null); setTailscaleError(null); }}>{text("취소", "Cancel")}</button>
            <button className="button primary compact" type="button" disabled={tailscaleBusy} onClick={() => void toggleTailscale(true, true)}>{text("덮어쓰고 켜기", "Overwrite and turn on")}</button>
          </div>
        </div>}
        {notice && <p className="settings-success" role="status">{notice}</p>}
        {error && <ErrorBanner message={error} />}
      </div>
    </section>
  );
}

function AppToggle({ checked, disabled = false, label, onChange }: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      className={`app-toggle${checked ? " checked" : ""}`}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="app-toggle-track" aria-hidden="true"><i /></span>
    </button>
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

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
