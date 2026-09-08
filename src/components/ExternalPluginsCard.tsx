import { ChevronDown, ChevronRight, Frame, GitBranch, KeyRound, LoaderCircle, Pencil, Plug, Plus, RefreshCw, ShieldCheck, SquareKanban, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { GOOGLE_LOGO_SRC } from "../assets/googleLogo";
import { NOTION_LOGO_SRC } from "../assets/notionLogo";
import { beginExternalPluginOAuth, cancelExternalPluginOAuth, getExternalPlugins, getWebAccessStatus, hasTauriRuntime, registerExternalPlugin, removeExternalPlugin, setExternalPluginEnabled, setExternalPluginToken, setExternalPluginToolPolicies, setExternalPluginToolPolicy, updateExternalPlugin, verifyExternalPlugin, type WebAccessStatus } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { ExternalPluginAuthKind, ExternalPluginOAuthStart, ExternalPluginView, ExternalPluginsSnapshot, HostedMcpPreset, PluginToolPolicy } from "../types";
import { AppToggle, ErrorBanner, Modal, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";

/** OAuth 승인을 기다리는 동안 상태를 다시 읽는 간격. 콜백은 백엔드가 받으므로 화면은 폴링으로 안다. */
const OAUTH_POLL_INTERVAL_MS = 2_000;

type Preset = "notionOauth" | "notionToken" | "custom";

/** 도구 권한 세 가지. 저장하지 않은 도구는 "ask"로 다뤄진다. */
const TOOL_POLICIES: PluginToolPolicy[] = ["allow", "ask", "deny"];

interface DraftForm {
  id: string;
  displayName: string;
  url: string;
  auth: ExternalPluginAuthKind;
  token: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

const EMPTY_DRAFT: DraftForm = { id: "", displayName: "", url: "", auth: "oauth", token: "", clientId: "", clientSecret: "", scope: "" };

/** 구글 공식 MCP 문서(Developer Preview 가입·API 활성화·OAuth 클라이언트 생성 절차). */
const GOOGLE_MCP_DOCS_URL = "https://developers.google.com/workspace/guides/configure-mcp-servers";

/** 디바이스 인가에 쓸 OAuth 앱을 만드는 곳(Client ID만 필요, Device Flow 스위치를 켠다). */
const GITHUB_OAUTH_APPS_URL = "https://github.com/settings/developers";

/** 브라우저 승인으로 토큰을 받는 방식인지. 두 방식은 화면에서 같은 자리를 쓴다. */
function isOAuthKind(auth: ExternalPluginAuthKind): boolean {
  return auth === "oauth" || auth === "oauthDevice";
}

/**
 * 폼 입력값(DraftForm)을 플러그인 등록·수정 요청의 공통 필드 형태로 정리한다.
 * 공백을 접고, Notion 전용 토큰 방식이면 주소를 비우며, OAuth/고정 토큰 방식에 맞추어 유효한 필드만 남긴다.
 */
function toExternalPluginPayload(draft: DraftForm) {
  const isOauth = isOAuthKind(draft.auth);
  const token = (draft.auth === "bearer" || draft.auth === "notionToken") && draft.token ? draft.token : null;
  return {
    displayName: draft.displayName.trim(),
    url: draft.auth === "notionToken" ? null : draft.url.trim(),
    auth: draft.auth,
    token,
    clientId: isOauth && draft.clientId.trim() ? draft.clientId.trim() : null,
    clientSecret: isOauth && draft.clientSecret.trim() ? draft.clientSecret.trim() : null,
    scope: isOauth && draft.scope.trim() ? draft.scope.trim() : null,
  };
}

/**
 * 구글 공식 MCP 프리셋을 화면에 내보낼지. 지금은 꺼 둔다.
 * false면 프리셋 버튼·구글 표식·전용 안내가 모두 사라지고, 프리셋을 내려주지 않는
 * 옛 백엔드에 붙어도 설정 화면이 뜬다.
 */
const GOOGLE_MCP_ENABLED = false;

/** 화면에서 쓸 프리셋. 구글은 기능 스위치가 꺼져 있으면 빼고, 옛 백엔드면 빈 목록이다. */
function hostedPresetsOf(snapshot: ExternalPluginsSnapshot): HostedMcpPreset[] {
  return (snapshot.hostedPresets ?? []).filter((preset) => GOOGLE_MCP_ENABLED || preset.brand !== "google");
}

function NotionMark({ size = 22 }: { size?: number }) {
  return <img className="notion-mark" src={NOTION_LOGO_SRC} width={size} height={size} alt="" aria-hidden="true" />;
}

function GoogleMark({ size = 20 }: { size?: number }) {
  return <img className="google-mark" src={GOOGLE_LOGO_SRC} width={size} height={size} alt="" aria-hidden="true" />;
}

/**
 * 브랜드 표식. 노션·구글은 공식 로고를 쓰고, 상표 원본이 없는 나머지는 성격을 나타내는
 * 아이콘으로 대신한다(디자인 언어: 브랜드 원색은 로고에만).
 */
function PluginMark({ brand, size = 20 }: { brand: string | null; size?: number }) {
  if (brand === "notion") return <NotionMark size={size + 2} />;
  if (brand === "google") return <GoogleMark size={size} />;
  if (brand === "atlassian") return <SquareKanban size={size} />;
  if (brand === "github") return <GitBranch size={size} />;
  if (brand === "figma") return <Frame size={size} />;
  return <Plug size={size} />;
}

function isNotionPlugin(plugin: ExternalPluginView): boolean {
  return plugin.id.toLowerCase() === "notion"
    || plugin.displayName.toLowerCase() === "notion"
    || plugin.auth === "notionToken";
}

function hostedPresetFor(presets: HostedMcpPreset[], url: string | null): HostedMcpPreset | null {
  if (!url) return null;
  const trimmed = url.trim().replace(/\/$/, "");
  return presets.find((preset) => preset.url.replace(/\/$/, "") === trimmed) ?? null;
}

/** 이 플러그인을 어느 브랜드로 그릴지. 주소가 프리셋과 같거나 id가 프리셋 id면 그 브랜드다. */
function brandOf(plugin: ExternalPluginView, presets: HostedMcpPreset[]): string | null {
  if (isNotionPlugin(plugin)) return "notion";
  const preset = hostedPresetFor(presets, plugin.url) ?? presets.find((entry) => entry.id === plugin.id) ?? null;
  return preset?.brand ?? null;
}

/** scope 문자열에서 토큰 하나를 켜고 끈다. 저장은 백엔드가 다시 정규화한다. */
function toggleScope(scope: string, entry: string): string {
  const parts = scope.split(/\s+/).filter(Boolean);
  return parts.includes(entry) ? parts.filter((part) => part !== entry).join(" ") : [...parts, entry].join(" ");
}

/**
 * 외부 플러그인(MCP 서버) 카드. 등록·편집·토글·연결 확인·OAuth 인증·토큰 변경·삭제를 한 자리에서 한다.
 * 인증(OAuth 시작, 토큰 입력, 등록, 편집, 삭제)은 호스트 화면 전용이다 — 원격 UI에서는 토글과 연결 확인만 된다.
 */
export function ExternalPluginsCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [snapshot, setSnapshot] = useState<ExternalPluginsSnapshot | null>(null);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ExternalPluginView | null>(null);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [tokenTarget, setTokenTarget] = useState<ExternalPluginView | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  /** 디바이스 인가에서 사용자가 브라우저에 입력할 코드. 승인이 끝나면 사용자가 닫는다. */
  const [deviceStart, setDeviceStart] = useState<{ plugin: ExternalPluginView; start: ExternalPluginOAuthStart } | null>(null);
  /** 도구 권한 목록을 펼친 플러그인 id. */
  const [toolsOpen, setToolsOpen] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const canWrite = access?.writable === true;
  // 데스크톱 셸은 호스트 UI 자체다. `/api/access` 응답을 기다리는 동안에도 호스트 전용
  // 버튼을 잘못 잠그지 않도록 SSH 키 화면과 같은 판정 기준을 쓴다.
  const isHost = hasTauriRuntime() || access?.remote === false;
  const isRemote = !hasTauriRuntime() && access?.remote === true;

  const load = useCallback(async () => {
    try {
      const next = await getExternalPlugins();
      setSnapshot(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!active) { loadedRef.current = false; return; }
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load();
    void getWebAccessStatus().then(setAccess).catch(() => setAccess(null));
  }, [active, load]);

  // OAuth 승인 대기 중에는 백엔드가 콜백을 받아 상태를 바꾸므로 주기적으로 다시 읽는다.
  const pending = snapshot?.plugins.some((plugin) => plugin.oauthPending) === true;
  useEffect(() => {
    if (!pending) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return undefined;
    }
    if (pollRef.current) return undefined;
    pollRef.current = setInterval(() => { void load(); }, OAUTH_POLL_INTERVAL_MS);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [pending, load]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const applyPreset = (preset: Preset) => {
    if (!snapshot) return;
    if (preset === "notionOauth") setDraft({ ...EMPTY_DRAFT, id: "notion", displayName: "Notion", url: snapshot.notionHostedUrl, auth: "oauth" });
    else if (preset === "notionToken") setDraft({ ...EMPTY_DRAFT, id: "notion", displayName: "Notion", auth: "notionToken" });
    else setDraft({ ...EMPTY_DRAFT, auth: "none" });
  };

  const applyHostedPreset = (preset: HostedMcpPreset) => {
    setDraft({ ...EMPTY_DRAFT, id: preset.id, displayName: preset.displayName, url: preset.url, auth: preset.auth, scope: preset.defaultScope });
  };

  const submitDraft = () => run("register", async () => {
    await registerExternalPlugin({
      id: draft.id.trim(),
      ...toExternalPluginPayload(draft),
    });
    setDraft(EMPTY_DRAFT);
    setAdding(false);
  });

  const beginEdit = (plugin: ExternalPluginView) => {
    setAdding(false);
    setEditing(plugin);
    setDraft({ ...EMPTY_DRAFT, id: plugin.id, displayName: plugin.displayName, url: plugin.url ?? "", auth: plugin.auth, scope: plugin.scope ?? "" });
  };

  const closeForm = () => {
    setAdding(false);
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  };

  /** 편집이 연결 지점을 바꾸는지. 백엔드는 이때 저장된 자격증명과 확인 결과를 초기화한다. */
  const editConnectionChanged = editing !== null && (
    draft.auth !== editing.auth
    || (draft.auth !== "notionToken" && draft.url.trim() !== (editing.url ?? ""))
    || (isOAuthKind(draft.auth) && (draft.clientId.trim() !== "" || draft.clientSecret.trim() !== ""))
    || (isOAuthKind(draft.auth) && draft.scope.trim() !== (editing.scope ?? "").trim())
  );

  /** client_secret은 어느 클라이언트의 것인지 알 수 없으므로 client_id 없이는 보내지 않는다. */
  const clientSecretNeedsClientId = isOAuthKind(draft.auth) && draft.clientSecret.trim() !== "" && draft.clientId.trim() === "";

  /** 디바이스 인가는 동적 등록이 없어 사용자가 만든 앱의 client_id가 반드시 필요하다. */
  const deviceNeedsClientId = draft.auth === "oauthDevice"
    && draft.clientId.trim() === ""
    && !(editing !== null && editing.auth === "oauthDevice");

  const submitEdit = async () => {
    const target = editing;
    if (!target) return;
    // 인증 없는 플러그인은 지울 자격증명이 없으니 조용히 저장한다(확인 결과 초기화는 폼 안내문이 설명한다).
    if (editConnectionChanged && target.auth !== "none" && target.credentialReady) {
      const accepted = await confirm({
        title: text("연결 정보 변경", "Change connection"),
        message: text(
          `"${target.displayName}"의 주소나 인증 방식이 바뀌면 보안 저장소의 자격증명과 연결 확인 결과가 초기화됩니다. 저장 뒤 다시 인증해야 합니다.`,
          `Changing the address or authentication of "${target.displayName}" clears the stored credential and verification result. You will need to authenticate again after saving.`,
        ),
        confirmLabel: text("변경", "Change"),
        tone: "danger",
      });
      if (!accepted) return;
    }
    await run(`update:${target.id}`, async () => {
      await updateExternalPlugin({
        id: target.id,
        ...toExternalPluginPayload(draft),
      });
      closeForm();
    });
  };

  const startOAuth = (plugin: ExternalPluginView) => run(`oauth:${plugin.id}`, async () => {
    const start = await beginExternalPluginOAuth(plugin.id);
    // 디바이스 인가는 주소만으로 끝나지 않는다. 사용자가 브라우저에 넣을 코드를 띄워 둔다.
    if (start.userCode) setDeviceStart({ plugin, start });
    await openExternalUrl(start.authorizationUrl);
  });

  const changeToolPolicy = (plugin: ExternalPluginView, tool: string, policy: PluginToolPolicy) =>
    run(`tool:${plugin.id}`, () => setExternalPluginToolPolicy(plugin.id, tool, policy));

  const changeAllToolPolicies = async (plugin: ExternalPluginView, policy: PluginToolPolicy) => {
    if (policy === "allow") {
      const accepted = await confirm({
        title: text("현재 도구 전체 허용", "Allow all current tools"),
        message: text(
          `"${plugin.displayName}"의 현재 도구를 모두 승인 카드 없이 실행하도록 바꿉니다. 새로 발견되는 도구는 계속 확인이 필요합니다.`,
          `All current tools from "${plugin.displayName}" will run without an approval card. Newly discovered tools will still require confirmation.`,
        ),
        confirmLabel: text("전체 허용", "Allow all"),
        tone: "danger",
      });
      if (!accepted) return;
    }
    await run(`tools:${plugin.id}`, () => setExternalPluginToolPolicies(plugin.id, policy));
  };

  const remove = async (plugin: ExternalPluginView) => {
    const accepted = await confirm({
      title: text("플러그인 삭제", "Remove plugin"),
      message: text(
        `"${plugin.displayName}" 플러그인과 보안 저장소의 자격증명을 삭제합니다. 실행 중인 채팅은 다음 턴부터 이 도구를 잃습니다.`,
        `Remove the "${plugin.displayName}" plugin and its credential from the secure store. Running chats lose the tools on their next turn.`,
      ),
      confirmLabel: text("삭제", "Remove"),
      tone: "danger",
    });
    if (!accepted) return;
    await run(`remove:${plugin.id}`, () => removeExternalPlugin(plugin.id));
  };

  const submitToken = () => {
    const target = tokenTarget;
    if (!target) return;
    void run(`token:${target.id}`, async () => {
      await setExternalPluginToken(target.id, tokenDraft);
      setTokenTarget(null);
      setTokenDraft("");
    });
  };

  const authLabel = (auth: ExternalPluginAuthKind) => auth === "oauth"
    ? "OAuth"
    : auth === "oauthDevice"
      ? text("OAuth 디바이스 인가", "OAuth device flow")
      : auth === "bearer"
        ? text("고정 토큰", "Bearer token")
        : auth === "notionToken"
          ? text("Notion 내부 통합 토큰", "Notion internal integration token")
          : text("인증 없음", "No auth");

  const policyLabel = (policy: PluginToolPolicy) => policy === "allow"
    ? text("허용", "Allow")
    : policy === "deny"
      ? text("제한", "Deny")
      : text("확인", "Ask");

  // 연결 확인은 저장된 자격증명으로 프록시를 두드리는 동작이라 인증 전에는 눌러도
  // 실패한다. 눌리지 않는 이유를 버튼 자신이 말하지 않으면 사용 토글을 켜 놓고
  // 왜 그대로인지 알 수 없다.
  const verifyHint = (plugin: ExternalPluginView, proxyReady: boolean): string => {
    if (!plugin.credentialReady) {
      return isOAuthKind(plugin.auth)
        ? text("먼저 인증해야 연결을 확인할 수 있습니다", "Sign in first to verify the connection")
        : text("먼저 토큰을 입력해야 연결을 확인할 수 있습니다", "Enter a token first to verify the connection");
    }
    if (!proxyReady) return text("MCP 프록시가 아직 준비되지 않았습니다", "The MCP proxy is not ready yet");
    return text("CLI가 쓰는 프록시 경로로 initialize와 tools/list를 실행합니다", "Runs initialize and tools/list through the proxy the CLI uses");
  };

  const statusFor = (plugin: ExternalPluginView): { tone: "ok" | "warn" | "waiting" | "muted"; label: string } => {
    if (!plugin.enabled) return { tone: "muted", label: text("사용 안 함", "Disabled") };
    if (plugin.oauthPending) return { tone: "waiting", label: text("브라우저 승인 대기 중", "Waiting for browser approval") };
    if (!plugin.credentialReady) return { tone: "warn", label: isOAuthKind(plugin.auth) ? text("인증 필요", "Sign-in required") : text("토큰 필요", "Token required") };
    if (plugin.lastVerifiedAt !== null) return { tone: "ok", label: text(`연결됨 · 도구 ${plugin.tools.length}개`, `Connected · ${plugin.tools.length} tools`) };
    return { tone: "ok", label: text("연결 준비됨", "Ready to connect") };
  };

  return (
    <section className="settings-card external-plugins-card" data-ui-anchor="settings.external-plugins-content">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><Plug size={18} aria-hidden="true" /></i>
          <div><span>MCP SERVER</span><h2>{text("외부 플러그인", "External plugins")}</h2></div>
        </div>
        <p>{text(
          "Notion 같은 서비스를 채팅 도구로 연결하고, 도구마다 허용·확인·제한을 정합니다. 자격증명은 이 기기의 보안 저장소에만 보관됩니다.",
          "Connect services such as Notion as chat tools and set each tool to allow, ask or deny. Credentials stay only in this device's secure store.",
        )}</p>
      </header>
      {isRemote && (
        <div className="plugin-host-notice" role="note">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            <strong>{text(
              access?.writable ? "원격 화면에서는 연결 관리가 제한됩니다" : "이 원격 연결은 읽기 전용입니다",
              access?.writable ? "Connection management is limited remotely" : "This remote connection is read-only",
            )}</strong>
            <small>{access?.writable
              ? text(
                "사용 전환과 연결 확인만 가능합니다. 편집·인증·도구 권한·삭제는 Agent Manager가 실행 중인 호스트 앱에서 진행하세요.",
                "You can toggle and verify here. Edit, sign-in, tool permissions and removal are available in the host app running Agent Manager.",
              )
              : text(
                "설정을 바꾸려면 쓰기 권한으로 다시 연결하세요. 편집·인증·도구 권한·삭제는 쓰기 권한과 관계없이 호스트 앱에서만 가능합니다.",
                "Reconnect with write access to change settings. Edit, sign-in, tool permissions and removal remain host-only regardless of remote write access.",
              )}</small>
          </span>
        </div>
      )}
      {snapshot === null
        ? <div className="plugin-loading-state">{!error && <LoaderCircle size={16} className="spin" />}<span>{error ? text("플러그인 목록을 읽지 못했습니다.", "Could not load plugins.") : text("플러그인을 확인하는 중…", "Checking plugins…")}</span></div>
        : snapshot.plugins.length === 0
          ? <div className="plugin-empty-state">
              <i><NotionMark size={28} /></i>
              <div><strong>{text("연결된 플러그인이 없습니다", "No plugins connected")}</strong><small>{text("Notion·Jira·GitHub·Figma 등을 OAuth 또는 토큰으로 연결할 수 있습니다.", "Connect Notion, Jira, GitHub, Figma and more with OAuth or a token.")}</small></div>
            </div>
          : <div className="plugin-list">
            {snapshot.plugins.map((plugin) => {
              const rowBusy = busy !== null && busy.endsWith(`:${plugin.id}`);
              const status = statusFor(plugin);
              const brand = brandOf(plugin, hostedPresetsOf(snapshot));
              const toolsExpanded = toolsOpen === plugin.id;
              // 제한한 도구는 연결 확인 때 목록에서 빠지므로, 되돌릴 수 있도록 정해 둔
              // 도구를 합쳐 보여 준다.
              const toolNames = [...new Set([...plugin.tools, ...Object.keys(plugin.toolPolicies ?? {})])].sort();
              return (
                <div className={`plugin-row${plugin.enabled ? "" : " plugin-off"}`} key={plugin.id}>
                  <i className={brand === "notion" || brand === "google" ? brand : undefined}><PluginMark brand={brand} size={17} /></i>
                  <div className="plugin-row-main">
                    <div className="plugin-row-name"><strong>{plugin.displayName}</strong><code>{plugin.id}</code></div>
                    <small>{authLabel(plugin.auth)} · {plugin.url ?? text("내장 MCP 서버", "Managed MCP server")}</small>
                    <span className={`plugin-status ${status.tone}`}><i />{status.label}{plugin.lastVerifiedAt !== null && status.tone === "ok" ? <time dateTime={new Date(plugin.lastVerifiedAt).toISOString()}>{new Date(plugin.lastVerifiedAt).toLocaleString()}</time> : null}</span>
                    {plugin.lastError && <small className="plugin-error">{plugin.lastError}</small>}
                  </div>
                  <div className="plugin-row-actions">
                    <div className="plugin-row-action-group plugin-row-runtime-actions">
                      <AppToggle checked={plugin.enabled} disabled={!canWrite || rowBusy} label={text("사용", "Enabled")} onChange={(next) => void run(`enable:${plugin.id}`, () => setExternalPluginEnabled(plugin.id, next))} />
                      <button className="button compact" type="button" disabled={!canWrite || rowBusy || !snapshot.proxyReady || !plugin.credentialReady} title={verifyHint(plugin, snapshot.proxyReady)} onClick={() => void run(`verify:${plugin.id}`, () => verifyExternalPlugin(plugin.id))}>
                        {busy === `verify:${plugin.id}` ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}{text("연결 확인", "Verify")}
                      </button>
                    </div>
                    <div className="plugin-row-action-group plugin-row-management-actions">
                      {isOAuthKind(plugin.auth) && (plugin.oauthPending
                        ? <button className="button compact" type="button" disabled={!isHost || rowBusy} onClick={() => void run(`cancel:${plugin.id}`, () => cancelExternalPluginOAuth(plugin.id))}><X size={13} />{text("취소", "Cancel")}</button>
                        : <button className="button compact primary" type="button" disabled={!isHost || !canWrite || rowBusy} title={isHost ? text("브라우저에서 승인하면 refresh token을 보안 저장소에 둡니다", "Approve in the browser; the refresh token is kept in the secure store") : text("인증은 호스트 화면에서만 할 수 있습니다", "Sign-in is only available on the host")} onClick={() => void startOAuth(plugin)}>
                          <ShieldCheck size={13} />{plugin.credentialReady ? text("다시 인증", "Re-authenticate") : text("인증", "Sign in")}
                        </button>)}
                      {(plugin.auth === "bearer" || plugin.auth === "notionToken") && <button className="button compact" type="button" disabled={!isHost || !canWrite || rowBusy} title={isHost ? undefined : text("토큰 입력은 호스트 화면에서만 할 수 있습니다", "Tokens can only be entered on the host")} onClick={() => { setTokenTarget(plugin); setTokenDraft(""); }}><KeyRound size={13} />{text("토큰 변경", "Change token")}</button>}
                      <button className="button compact" type="button" disabled={!isHost || !canWrite || rowBusy} title={isHost ? text("표시 이름·주소·인증 방식을 편집합니다", "Edit the name, address and authentication") : text("편집은 호스트 화면에서만 할 수 있습니다", "Editing is host-only")} onClick={() => beginEdit(plugin)}><Pencil size={13} />{text("편집", "Edit")}</button>
                      <button className="plugin-remove-button" type="button" disabled={!isHost || !canWrite || rowBusy} aria-label={text(`${plugin.displayName} 삭제`, `Remove ${plugin.displayName}`)} title={isHost ? text("삭제", "Remove") : text("삭제는 호스트 화면에서만 할 수 있습니다", "Removal is host-only")} onClick={() => void remove(plugin)}><Trash2 size={14} /></button>
                    </div>
                  </div>
                  {toolNames.length > 0 && (
                    <button className="plugin-tools-toggle" type="button" aria-expanded={toolsExpanded} onClick={() => setToolsOpen(toolsExpanded ? null : plugin.id)}>
                      {toolsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <strong>{text("도구 권한", "Tool permissions")}</strong>
                      <span>{text(`${toolNames.length}개`, `${toolNames.length} tools`)}</span>
                      {Object.keys(plugin.toolPolicies ?? {}).length > 0 && <em>{text(`${Object.keys(plugin.toolPolicies ?? {}).length}개 지정됨`, `${Object.keys(plugin.toolPolicies ?? {}).length} set`)}</em>}
                    </button>
                  )}
                  {toolsExpanded && (
                    <div className="plugin-tools">
                      <div className="plugin-tools-header">
                        <span>
                          <strong>{text("현재 도구 일괄 변경", "Change all current tools")}</strong>
                          <small>{text("나중에 새로 발견되는 도구는 확인으로 시작합니다.", "Tools discovered later start as Ask.")}</small>
                        </span>
                        <ToolPolicyButtonGroup
                          ariaLabel={text("현재 도구 전체 권한", "All current tool permissions")}
                          currentPolicy={TOOL_POLICIES.find((policy) => toolNames.every((tool) => (plugin.toolPolicies?.[tool] ?? "ask") === policy)) ?? null}
                          disabled={!isHost || !canWrite || rowBusy}
                          disabledTitle={isHost ? undefined : text("도구 권한은 호스트 화면에서만 바꿀 수 있습니다", "Tool permissions are host-only")}
                          isBulk
                          onSelect={(policy) => void changeAllToolPolicies(plugin, policy)}
                          policyLabel={policyLabel}
                          text={text}
                        />
                      </div>
                      <p className="plugin-field-note">{text(
                        "제한한 도구는 목록에서 사라져 CLI가 부를 수 없고, 허용한 도구는 승인 카드 없이 실행됩니다. 제한은 곧바로, 허용은 새로 시작하는 채팅부터 적용됩니다.",
                        "Denied tools disappear from the list so the CLI cannot call them; allowed tools run without an approval card. Denial applies at once, allowance from newly started chats.",
                      )}</p>
                      {toolNames.map((tool) => {
                        const current: PluginToolPolicy = plugin.toolPolicies?.[tool] ?? "ask";
                        return (
                          <div className="plugin-tool-row" key={tool}>
                            <code>{tool}</code>
                            <ToolPolicyButtonGroup
                              ariaLabel={text(`${tool} 권한`, `${tool} permission`)}
                              currentPolicy={current}
                              disabled={!isHost || !canWrite || rowBusy}
                              disabledTitle={isHost ? undefined : text("도구 권한은 호스트 화면에서만 바꿀 수 있습니다", "Tool permissions are host-only")}
                              onSelect={(policy) => void changeToolPolicy(plugin, tool, policy)}
                              policyLabel={policyLabel}
                              text={text}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>}
      {snapshot && !adding && !editing && (
        <div className="settings-update-body">
          <span className="settings-update-status">
            <strong>{text("새 플러그인 연결", "Connect a plugin")}</strong>
            <small>{isHost
              ? text(`최대 ${snapshot.maxPlugins}개 · 변경 내용은 새로 시작하는 채팅부터 적용됩니다.`, `Up to ${snapshot.maxPlugins} · Changes apply to newly started chats.`)
              : text("등록·인증·토큰 입력은 호스트 화면에서만 할 수 있습니다. 여기서는 사용 토글과 연결 확인만 됩니다.", "Registration, sign-in and tokens are host-only. Here you can toggle and verify.")}</small>
          </span>
          <button className="button compact primary" type="button" disabled={!isHost || !canWrite || snapshot.plugins.length >= snapshot.maxPlugins} onClick={() => { applyPreset("notionOauth"); setAdding(true); }}><Plus size={13} />{text("플러그인 추가", "Add plugin")}</button>
        </div>
      )}
      {snapshot && (adding || editing) && (
        <div className="detail-card plugin-form">
          {editing
            ? <div className="plugin-row-name"><strong>{text("플러그인 편집", "Edit plugin")}</strong><code>{editing.id}</code></div>
            : <div className="plugin-presets">
              <button className={`plugin-preset${draft.auth === "oauth" && draft.url === snapshot.notionHostedUrl ? " selected" : ""}`} type="button" aria-pressed={draft.auth === "oauth" && draft.url === snapshot.notionHostedUrl} onClick={() => applyPreset("notionOauth")}><NotionMark /><span><strong>Notion</strong><small>OAuth</small></span></button>
              <button className={`plugin-preset${draft.auth === "notionToken" ? " selected" : ""}`} type="button" aria-pressed={draft.auth === "notionToken"} onClick={() => applyPreset("notionToken")}><NotionMark /><span><strong>Notion</strong><small>{text("내부 통합 토큰", "Integration token")}</small></span></button>
              {hostedPresetsOf(snapshot).map((preset) => {
                const selected = draft.auth === preset.auth && draft.url === preset.url;
                return (
                  <button className={`plugin-preset${selected ? " selected" : ""}`} type="button" key={preset.id} aria-pressed={selected} onClick={() => applyHostedPreset(preset)}><PluginMark brand={preset.brand} /><span><strong>{preset.displayName}</strong><small>{authLabel(preset.auth)}</small></span></button>
                );
              })}
              <button className={`plugin-preset${draft.auth === "none" || draft.auth === "bearer" ? " selected" : ""}`} type="button" aria-pressed={draft.auth === "none" || draft.auth === "bearer"} onClick={() => applyPreset("custom")}><Plug size={20} /><span><strong>{text("직접 입력", "Custom")}</strong><small>{text("외부 MCP 서버", "External MCP server")}</small></span></button>
            </div>}
          <div className="form-row"><label htmlFor="plugin-id">{text("식별자", "Identifier")}</label><input id="plugin-id" value={draft.id} placeholder="notion" disabled={editing !== null} title={editing ? text("식별자는 MCP 서버 이름과 프록시 경로로 쓰여 바꿀 수 없습니다", "The identifier is the MCP server name and proxy path, so it cannot change") : undefined} onChange={(event) => setDraft({ ...draft, id: event.target.value })} /></div>
          <div className="form-row"><label htmlFor="plugin-name">{text("표시 이름", "Display name")}</label><input id="plugin-name" value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></div>
          <div className="form-row"><label htmlFor="plugin-auth">{text("인증 방식", "Authentication")}</label>
            <select id="plugin-auth" value={draft.auth} onChange={(event) => setDraft({ ...draft, auth: event.target.value as ExternalPluginAuthKind })}>
              <option value="oauth">OAuth</option>
              <option value="oauthDevice">{text("OAuth 디바이스 인가(사용자 코드)", "OAuth device flow (user code)")}</option>
              <option value="bearer">{text("고정 토큰(Bearer)", "Bearer token")}</option>
              <option value="notionToken">{text("Notion 내부 통합 토큰(내장 서버)", "Notion internal integration token (managed server)")}</option>
              <option value="none">{text("인증 없음", "No authentication")}</option>
            </select>
          </div>
          {draft.auth !== "notionToken" && <div className="form-row"><label htmlFor="plugin-url">{text("MCP 주소", "MCP URL")}</label><input id="plugin-url" value={draft.url} placeholder="https://mcp.example.com/mcp" onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></div>}
          {(draft.auth === "bearer" || draft.auth === "notionToken") && <div className="form-row"><label htmlFor="plugin-token">{text("토큰", "Token")}</label><input id="plugin-token" type="password" autoComplete="off" value={draft.token} placeholder={editing && !editConnectionChanged ? text("비워 두면 기존 토큰 유지", "Leave empty to keep the current token") : draft.auth === "notionToken" ? "ntn_…" : ""} onChange={(event) => setDraft({ ...draft, token: event.target.value })} /></div>}
          {isOAuthKind(draft.auth) && (() => {
            const preset = hostedPresetFor(hostedPresetsOf(snapshot), draft.url);
            const device = draft.auth === "oauthDevice";
            const google = preset?.brand === "google";
            const manual = google || device;
            const chosen = draft.scope.split(/\s+/).filter(Boolean);
            return <>
              <div className="form-row"><label htmlFor="plugin-client">{manual ? "client_id" : text("client_id (선택)", "client_id (optional)")}</label><input id="plugin-client" value={draft.clientId} placeholder={google ? text("GCP 콘솔의 OAuth 클라이언트 ID", "OAuth client ID from the GCP console") : device ? text("GitHub 등에서 만든 OAuth 앱의 Client ID", "Client ID of the OAuth app you created") : editing ? text("비워 두면 기존 인증 등록 유지", "Leave empty to keep the current registration") : text("비워 두면 인증할 때 자동 등록", "Leave empty to register automatically on sign-in")} onChange={(event) => setDraft({ ...draft, clientId: event.target.value })} /></div>
              {!device && <div className="form-row"><label htmlFor="plugin-client-secret">{text("client_secret (선택)", "client_secret (optional)")}</label><input id="plugin-client-secret" type="password" autoComplete="off" value={draft.clientSecret} placeholder={google ? text("GCP 콘솔의 OAuth 클라이언트 보안 비밀번호", "OAuth client secret from the GCP console") : text("client_id와 함께 발급받았을 때만", "Only when issued together with a client_id")} onChange={(event) => setDraft({ ...draft, clientSecret: event.target.value })} /></div>}
              {clientSecretNeedsClientId && <p className="plugin-field-note">{text("client_secret은 client_id와 함께 입력해야 합니다.", "A client_secret must be entered together with its client_id.")}</p>}
              {deviceNeedsClientId && <p className="plugin-field-note">{text("디바이스 인가는 자동 등록이 없어 client_id가 반드시 필요합니다.", "Device flow has no automatic registration, so a client_id is required.")}</p>}
              <div className="form-row"><label htmlFor="plugin-scope">{text("권한 범위(scope)", "Scope")}</label><input id="plugin-scope" value={draft.scope} placeholder={text("비우면 서버가 알려 준 범위를 그대로 요청합니다", "Leave empty to request whatever the server advertises")} onChange={(event) => setDraft({ ...draft, scope: event.target.value })} /></div>
              {preset && preset.availableScopes.length > 0 && (
                <div className="plugin-scope-chips">
                  {preset.availableScopes.map((entry) => (
                    <button className={`plugin-scope-chip${chosen.includes(entry) ? " selected" : ""}`} type="button" key={entry} aria-pressed={chosen.includes(entry)} onClick={() => setDraft({ ...draft, scope: toggleScope(draft.scope, entry) })}>{entry}</button>
                  ))}
                  {preset.defaultScope !== draft.scope.trim() && <button className="plugin-scope-chip reset" type="button" onClick={() => setDraft({ ...draft, scope: preset.defaultScope })}>{text("기본값으로", "Reset to default")}</button>}
                </div>
              )}
              <p className="plugin-field-note">{google
                ? <>
                  {text(
                    `구글 공식 MCP는 자동 등록이 없어 직접 만든 OAuth 클라이언트가 필요합니다: Google Workspace Developer Preview 프로그램 가입 → GCP 프로젝트에서 ${preset?.displayName ?? ""} API와 MCP API 활성화 → OAuth 동의 화면에 scope 추가 → "데스크톱 앱" 유형 클라이언트를 만들어 client_id·client_secret을 입력하세요. 웹 유형은 콜백 포트를 미리 등록해야 해서 쓸 수 없습니다.`,
                    `Google's official MCP has no automatic registration, so it needs your own OAuth client: join the Google Workspace Developer Preview Program → enable the ${preset?.displayName ?? ""} API and its MCP API in a GCP project → add the scopes on the OAuth consent screen → create a "Desktop app" client and enter its client_id and client_secret. The "Web application" type cannot be used because it pins the callback port.`,
                  )}
                  {" "}
                  <a href={GOOGLE_MCP_DOCS_URL} rel="noreferrer" onClick={(event) => { event.preventDefault(); void openExternalUrl(GOOGLE_MCP_DOCS_URL); }}>{text("구글 설정 안내 문서", "Google setup guide")}</a>
                </>
                : device
                  ? <>
                    {text(
                      "디바이스 인가는 콜백 주소를 쓰지 않아 client_secret이 필요 없습니다. GitHub은 Settings → Developer settings → OAuth Apps에서 앱을 만들고 \"Enable Device Flow\"를 켠 뒤 Client ID만 여기에 넣으세요. 인증을 누르면 사용자 코드가 뜨고, 브라우저에 그 코드를 입력해 승인합니다.",
                      "Device flow uses no callback URL, so no client_secret is needed. On GitHub create an app under Settings → Developer settings → OAuth Apps, turn on \"Enable Device Flow\", and paste only its Client ID here. Pressing Sign in shows a user code to enter in the browser.",
                    )}
                    {" "}
                    <a href={GITHUB_OAUTH_APPS_URL} rel="noreferrer" onClick={(event) => { event.preventDefault(); void openExternalUrl(GITHUB_OAUTH_APPS_URL); }}>{text("GitHub OAuth 앱 설정", "GitHub OAuth app settings")}</a>
                  </>
                  : text(
                    "비워 두면 [인증]을 누를 때 이 앱이 서버에 자기 자신을 등록해(RFC 7591) client_id를 발급받고, 그 값을 저장해 계속 같은 연결로 씁니다. client_id는 서버가 발급하는 값이라 임의로 지어낼 수 없으니, 자동 등록을 지원하지 않는 서버에서 미리 받아 둔 값이 있을 때만 채우세요.",
                    "Left empty, pressing Sign in registers this app with the server (RFC 7591) and stores the client_id it issues, which is then reused for every connection. A client_id is issued by the server and cannot be made up, so fill this in only when the server has no automatic registration and gave you one.",
                  )}</p>
            </>;
          })()}
          <p className="plugin-form-note">{editing
            ? text(
              "표시 이름만 바꾸면 자격증명과 연결 상태가 유지됩니다. 주소·인증 방식·client_id·client_secret·scope를 바꾸면 저장된 자격증명과 연결 확인 결과가 초기화되어 다시 인증해야 하며, 변경 내용은 새로 시작하는 채팅부터 적용됩니다.",
              "Renaming keeps the credential and connection state. Changing the address, authentication, client_id, client_secret or scope clears the stored credential and verification result, so you will need to authenticate again. Changes apply to newly started chats.",
            )
            : draft.auth === "notionToken"
            ? (snapshot.nodeAvailable
              ? text(`노션 워크스페이스 설정 → 연결에서 내부 통합을 만들고 토큰을 붙여 넣으세요. 이 백엔드가 ${snapshot.notionLocalPackage}를 loopback으로 띄워 연결하며, 통합에 공유한 페이지만 보입니다.`, `Create an internal integration in Notion settings → Connections and paste its token. The backend runs ${snapshot.notionLocalPackage} on loopback; only pages shared with the integration are visible.`)
              : text("이 방식은 Node.js(npx)가 필요합니다. 현재 호스트에서 npx를 찾지 못했습니다.", "This method needs Node.js (npx), which was not found on this host."))
            : draft.auth === "oauth"
              ? text("등록 뒤 [인증]을 누르면 브라우저가 열립니다. 승인 콜백은 이 호스트의 loopback으로 돌아오므로 원격 화면에서는 할 수 없습니다.", "After registering, press Sign in to open the browser. The callback returns to this host's loopback, so it is not possible from a remote screen.")
              : draft.auth === "oauthDevice"
                ? text("등록 뒤 [인증]을 누르면 사용자 코드가 뜹니다. 브라우저에서 그 코드를 입력해 승인하면 토큰이 이 기기의 보안 저장소에 저장됩니다.", "After registering, press Sign in to get a user code. Approve it in the browser and the token is stored in this device's secure store.")
                : hostedPresetFor(hostedPresetsOf(snapshot), draft.url)?.brand === "figma"
                  ? text("Figma 데스크톱 앱에서 Dev Mode(Shift+D) → MCP 서버 켜기를 먼저 해야 합니다. 원격 서버(mcp.figma.com)는 Figma가 승인한 클라이언트만 접속할 수 있어 여기서는 쓸 수 없습니다.", "Turn on Dev Mode (Shift+D) → enable the MCP server in the Figma desktop app first. The remote server (mcp.figma.com) only accepts clients approved by Figma, so it cannot be used here.")
                  : text("원격 서버는 HTTPS만, 로컬 서버는 loopback HTTP도 허용합니다. URL에는 토큰을 넣을 수 없습니다.", "Remote servers must use HTTPS; loopback HTTP is allowed for local servers. Tokens never go in the URL.")}</p>
          <div className="form-actions">
            <button className="button" type="button" onClick={closeForm}>{text("취소", "Cancel")}</button>
            {editing
              ? <button className="button primary" type="button" disabled={busy !== null || !draft.displayName.trim() || (draft.auth !== "notionToken" && !draft.url.trim()) || (editConnectionChanged && (draft.auth === "bearer" || draft.auth === "notionToken") && !draft.token) || clientSecretNeedsClientId || deviceNeedsClientId} onClick={() => void submitEdit()}>{busy === `update:${editing.id}` ? text("저장 중…", "Saving…") : text("저장", "Save")}</button>
              : <button className="button primary" type="button" disabled={busy !== null || !draft.id.trim() || !draft.displayName.trim() || (draft.auth !== "notionToken" && !draft.url.trim()) || ((draft.auth === "bearer" || draft.auth === "notionToken") && !draft.token) || clientSecretNeedsClientId || deviceNeedsClientId} onClick={() => void submitDraft()}>{busy === "register" ? text("등록 중…", "Registering…") : text("등록", "Register")}</button>}
          </div>
        </div>
      )}
      {error && <ErrorBanner message={error} />}
      {deviceStart && (
        <Modal
          title={text(`디바이스 인가 · ${deviceStart.plugin.displayName}`, `Device flow · ${deviceStart.plugin.displayName}`)}
          onClose={() => setDeviceStart(null)}
          footer={<>
            <button className="button" type="button" onClick={() => { void run(`cancel:${deviceStart.plugin.id}`, () => cancelExternalPluginOAuth(deviceStart.plugin.id)); setDeviceStart(null); }}>{text("인증 취소", "Cancel sign-in")}</button>
            <button className="button primary" type="button" onClick={() => void openExternalUrl(deviceStart.start.authorizationUrl)}>{text("승인 화면 다시 열기", "Reopen approval page")}</button>
          </>}
        >
          <p className="plugin-device-code"><code>{deviceStart.start.userCode}</code></p>
          <p className="plugin-form-note">{text(
            `브라우저에 열린 ${new URL(deviceStart.start.authorizationUrl).host} 화면에 위 코드를 입력해 승인하세요. 승인이 끝나면 이 목록의 상태가 "연결 준비됨"으로 바뀝니다.`,
            `Enter the code above on the ${new URL(deviceStart.start.authorizationUrl).host} page that opened in your browser. The row switches to "Ready to connect" once you approve.`,
          )}</p>
        </Modal>
      )}
      {tokenTarget && (
        <Modal
          title={text(`토큰 변경 · ${tokenTarget.displayName}`, `Change token · ${tokenTarget.displayName}`)}
          onClose={() => setTokenTarget(null)}
          footer={<>
            <button className="button" type="button" onClick={() => setTokenTarget(null)}>{text("취소", "Cancel")}</button>
            <button className="button primary" type="button" disabled={!tokenDraft || busy !== null} onClick={submitToken}>{text("저장", "Save")}</button>
          </>}
        >
          <div className="form-row"><label htmlFor="plugin-new-token">{text("새 토큰", "New token")}</label><input id="plugin-new-token" type="password" autoComplete="off" value={tokenDraft} placeholder={tokenTarget.auth === "notionToken" ? "ntn_…" : ""} onChange={(event) => setTokenDraft(event.target.value)} /></div>
          <p className="plugin-form-note">{text("이전 토큰은 보안 저장소에서 덮어써지고 내장 서버는 새 토큰으로 다시 뜹니다.", "The previous token is overwritten in the secure store; the managed server restarts with the new one.")}</p>
        </Modal>
      )}
      {confirmDialog}
    </section>
  );
}

interface ToolPolicyButtonGroupProps {
  currentPolicy: PluginToolPolicy | null;
  onSelect: (policy: PluginToolPolicy) => void;
  disabled: boolean;
  disabledTitle?: string;
  ariaLabel: string;
  isBulk?: boolean;
  policyLabel: (policy: PluginToolPolicy) => string;
  text: (ko: string, en: string) => string;
}

/** 도구 권한(허용·확인·제한) 선택 버튼 묶음. 일괄 변경 헤더와 개별 도구 행에서 공통으로 쓴다. */
function ToolPolicyButtonGroup({
  currentPolicy,
  onSelect,
  disabled,
  disabledTitle,
  ariaLabel,
  isBulk = false,
  policyLabel,
  text,
}: ToolPolicyButtonGroupProps) {
  return (
    <div className={`plugin-tool-policy${isBulk ? " plugin-tool-bulk" : ""}`} role="group" aria-label={ariaLabel}>
      {TOOL_POLICIES.map((policy) => {
        const selected = currentPolicy === policy;
        return (
          <button
            className={`plugin-tool-choice${selected ? ` selected ${policy}` : ""}`}
            type="button"
            key={policy}
            aria-pressed={selected}
            disabled={disabled}
            title={disabledTitle}
            onClick={() => { if (!selected) onSelect(policy); }}
          >
            {isBulk ? text(`전체 ${policyLabel(policy)}`, `${policyLabel(policy)} all`) : policyLabel(policy)}
          </button>
        );
      })}
    </div>
  );
}

async function openExternalUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`지원하지 않는 주소 형식입니다: ${url.protocol}`);
  }
  if (hasTauriRuntime()) {
    await openUrl(url.href);
    return;
  }
  window.open(url.href, "_blank", "noopener,noreferrer");
}
