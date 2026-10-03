import { ChevronDown, ChevronRight, KeyRound, LoaderCircle, Pencil, Plug, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SERVICE_ICON_SRC, type ServiceIconName } from "../assets/serviceIcons";
import { beginExternalPluginOAuth, cancelExternalPluginOAuth, getExternalPlugins, getWebAccessStatus, hasTauriRuntime, registerExternalPlugin, removeExternalPlugin, setExternalPluginEnabled, setExternalPluginToken, setExternalPluginToolPolicies, setExternalPluginToolPolicy, updateExternalPlugin, verifyExternalPlugin, type WebAccessStatus } from "../lib/ipc";
import { splitPluginNames } from "../lib/pluginNames";
import { markBuiltinToolsChanged } from "../lib/builtinToolsSignal";
import { openExternalUrl } from "../lib/externalUrl";
import { CopyAction } from "./CopyAction";
import { useI18n, type UiText } from "../lib/i18n";
import type { ExternalPluginAuthKind, ExternalPluginOAuthStart, ExternalPluginView, ExternalPluginsSnapshot, HostedMcpPreset, PluginToolPolicy } from "../types";
import { AppToggle, BrandMark, ErrorBanner, Modal, useConfirm, type ConfirmRequest } from "./Shared";
import { errorText } from "../lib/errorText";

import { formatDateTime } from "../lib/format";
/** OAuth 승인을 기다리는 동안 상태를 다시 읽는 간격. 콜백은 백엔드가 받으므로 화면은 폴링으로 안다. */
const OAUTH_POLL_INTERVAL_MS = 2_000;

type Preset = "notionOauth" | "notionToken" | "custom";

/** 도구 권한 세 가지. 저장하지 않은 도구는 "ask"로 다뤄진다. */
const TOOL_POLICIES: PluginToolPolicy[] = ["allow", "ask", "deny"];

interface DraftForm {
  id: string;
  displayName: string;
  /** 다른 이름들. 화면에서는 쉼표로 구분한 한 줄이고, 보낼 때 목록으로 쪼갠다. */
  names: string;
  url: string;
  auth: ExternalPluginAuthKind;
  token: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

const EMPTY_DRAFT: DraftForm = { id: "", displayName: "", names: "", url: "", auth: "oauth", token: "", clientId: "", clientSecret: "", scope: "" };

/**
 * 등록·편집 폼의 상태. 폼이 닫혀 있으면 `null`이고, 열려 있으면 편집 대상(신규 등록이면
 * `editing`이 `null`)과 입력 중인 초안을 함께 든다.
 *
 * 전에는 `adding`·`editing`·`draft` 세 상태가 따로 있어 "추가 중이면서 편집 중"이나 "닫혔는데
 * 초안이 남아 있음" 같은 있을 수 없는 조합이 타입상 표현 가능했고, 폼을 여닫는 네 자리가 매번
 * 셋을 손으로 맞춰야 했다. 하나로 묶어 여닫기를 대입 한 번으로 만든다.
 */
interface PluginFormState {
  editing: ExternalPluginView | null;
  draft: DraftForm;
}

/** 프리셋 버튼이 채우는 초안. 폼을 여는 자리와 폼 안에서 갈아끼우는 자리가 함께 쓴다. */
function presetDraft(preset: Preset, snapshot: ExternalPluginsSnapshot): DraftForm {
  if (preset === "notionOauth") return { ...EMPTY_DRAFT, id: "notion", displayName: "Notion", names: "노션", url: snapshot.notionHostedUrl, auth: "oauth" };
  if (preset === "notionToken") return { ...EMPTY_DRAFT, id: "notion", displayName: "Notion", names: "노션", auth: "notionToken" };
  return { ...EMPTY_DRAFT, auth: "none" };
}

/** 구글 공식 MCP 문서(Developer Preview 가입·API 활성화·OAuth 클라이언트 생성 절차). */
const GOOGLE_MCP_DOCS_URL = "https://developers.google.com/workspace/guides/configure-mcp-servers";

/** 디바이스 인가에 쓸 OAuth 앱을 만드는 곳(Client ID만 필요, Device Flow 스위치를 켠다). */
const GITHUB_OAUTH_APPS_URL = "https://github.com/settings/developers";

/** 브라우저 승인으로 토큰을 받는 방식인지. 두 방식은 화면에서 같은 자리를 쓴다. */
function isOAuthKind(auth: ExternalPluginAuthKind): boolean {
  return auth === "oauth" || auth === "oauthDevice";
}

/** 사용자가 직접 붙여 넣는 토큰으로 붙는 방식인지. 토큰 입력 칸과 [토큰 변경]이 같은 판정을 쓴다. */
function usesStaticToken(auth: ExternalPluginAuthKind): boolean {
  return auth === "bearer" || auth === "notionToken";
}

/**
 * 폼 입력값(DraftForm)을 플러그인 등록·수정 요청의 공통 필드 형태로 정리한다.
 * 공백을 접고, Notion 전용 토큰 방식이면 주소를 비우며, OAuth/고정 토큰 방식에 맞추어 유효한 필드만 남긴다.
 */
function toExternalPluginPayload(draft: DraftForm) {
  const isOauth = isOAuthKind(draft.auth);
  const token = usesStaticToken(draft.auth) && draft.token ? draft.token : null;
  const clientId = draft.clientId.trim();
  const clientSecret = draft.clientSecret.trim();
  const scope = draft.scope.trim();
  return {
    displayName: draft.displayName.trim(),
    names: splitPluginNames(draft.names),
    url: draft.auth === "notionToken" ? null : draft.url.trim(),
    auth: draft.auth,
    token,
    clientId: isOauth && clientId ? clientId : null,
    clientSecret: isOauth && clientSecret ? clientSecret : null,
    scope: isOauth && scope ? scope : null,
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

/** 팩에 이 이름의 표식이 있는지. 없으면 다음 후보로 넘어간다. */
function serviceIconName(key: string | null): ServiceIconName | null {
  return key && key in SERVICE_ICON_SRC ? key as ServiceIconName : null;
}

/**
 * 서비스 표식. **서비스(프리셋 id)를 먼저 찾고 없으면 브랜드로 떨어진다.**
 *
 * 예전에는 노션·구글만 로고(손으로 넣은 base64 PNG)였고 나머지는 성격을 나타내는 lucide
 * 아이콘으로 대신했는데, 아틀라시안을 칸반으로, GitHub를 브랜치로, Figma를 액자로 그리면
 * 어느 서비스인지 알아볼 수 없었다. 게다가 브랜드만 보면 구글 서비스 넷(Gmail·드라이브·
 * 캘린더·문서)이 모두 같은 구글 로고였다. 이제 서비스 로고가 있는 자리는 서비스 로고를,
 * 없는 자리는 브랜드 로고를 쓴다 — 전부 `logos` 팩에서 뽑은 SVG다(`npm run icons:generate`).
 *
 * 상표가 없는 나머지 MCP 서버는 그대로 콘센트 아이콘이다 — 브랜드 원색은 로고에만 쓴다는
 * 디자인 언어를 지키려면 상표가 있는 자리와 없는 자리가 구분돼야 한다.
 */
function PluginMark({ brand, service = null, size = 20 }: { brand: string | null; service?: string | null; size?: number }) {
  const name = serviceIconName(service) ?? serviceIconName(brand);
  return name ? <BrandMark name={name} size={size} /> : <Plug size={size} />;
}

/** 주소가 Notion 호스팅 MCP(`mcp.notion.com`)인지. 하위 도메인까지 본다. */
function isNotionUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return host === "notion.com" || host.endsWith(".notion.com");
  } catch {
    return false;
  }
}

/**
 * Notion 플러그인인지. **이름이 아니라 주소와 인증 방식이 근거다** — 이름 완전일치만 보면
 * `notion-team`처럼 접미사를 붙여 등록한 자리가 표식을 잃는다.
 */
function isNotionPlugin(plugin: ExternalPluginView): boolean {
  return plugin.auth === "notionToken"
    || isNotionUrl(plugin.url)
    || plugin.id.toLowerCase() === "notion"
    || plugin.displayName.toLowerCase() === "notion";
}

function hostedPresetFor(presets: HostedMcpPreset[], url: string | null): HostedMcpPreset | null {
  if (!url) return null;
  const trimmed = url.trim().replace(/\/$/, "");
  return presets.find((preset) => preset.url.replace(/\/$/, "") === trimmed) ?? null;
}

/** 이 플러그인을 어느 브랜드로 그릴지. 주소가 프리셋과 같거나 id가 프리셋 id면 그 브랜드다. */
/**
 * 등록된 플러그인의 표식 후보. 서비스(프리셋 id)와 브랜드를 함께 돌려준다 — 표식은 서비스를
 * 먼저 쓰고, 그 서비스 로고가 팩에 없으면 브랜드로 떨어진다.
 */
function markOf(plugin: ExternalPluginView, presets: HostedMcpPreset[]): { service: string | null; brand: string | null } {
  if (isNotionPlugin(plugin)) return { service: "notion", brand: "notion" };
  const preset = hostedPresetFor(presets, plugin.url) ?? presets.find((entry) => entry.id === plugin.id) ?? null;
  return { service: preset?.id ?? null, brand: preset?.brand ?? null };
}

/** scope 문자열에서 토큰 하나를 켜고 끈다. 저장은 백엔드가 다시 정규화한다. */
function toggleScope(scope: string, entry: string): string {
  const parts = scope.split(/\s+/).filter(Boolean);
  return parts.includes(entry) ? parts.filter((part) => part !== entry).join(" ") : [...parts, entry].join(" ");
}

/** 인증 방식의 표시 이름. 목록 행과 프리셋 버튼이 같은 문구를 쓴다. */
function authLabel(auth: ExternalPluginAuthKind, text: UiText): string {
  return auth === "oauth"
    ? "OAuth"
    : auth === "oauthDevice"
      ? text("OAuth 디바이스 인가", "OAuth device flow")
      : auth === "bearer"
        ? text("고정 토큰", "Bearer token")
        : auth === "notionToken"
          ? text("Notion 내부 통합 토큰", "Notion internal integration token")
          : text("인증 없음", "No auth");
}

/** 도구 권한의 표시 이름. */
function policyLabel(policy: PluginToolPolicy, text: UiText): string {
  return policy === "allow"
    ? text("허용", "Allow")
    : policy === "deny"
      ? text("제한", "Deny")
      : text("확인", "Ask");
}

/**
 * [연결 확인] 버튼의 설명. 연결 확인은 저장된 자격증명으로 프록시를 두드리는 동작이라
 * 인증 전에는 눌러도 실패한다. 눌리지 않는 이유를 버튼 자신이 말하지 않으면 사용 토글을
 * 켜 놓고 왜 그대로인지 알 수 없다.
 */
function verifyHint(plugin: ExternalPluginView, proxyReady: boolean, text: UiText): string {
  if (!plugin.credentialReady) {
    return isOAuthKind(plugin.auth)
      ? text("먼저 인증해야 연결을 확인할 수 있습니다", "Sign in first to verify the connection")
      : text("먼저 토큰을 입력해야 연결을 확인할 수 있습니다", "Enter a token first to verify the connection");
  }
  if (!proxyReady) return text("MCP 프록시가 아직 준비되지 않았습니다", "The MCP proxy is not ready yet");
  return text("CLI가 쓰는 프록시 경로로 initialize와 tools/list를 실행합니다", "Runs initialize and tools/list through the proxy the CLI uses");
}

/** 목록 행의 상태 표식. 사용 안 함 → 승인 대기 → 자격증명 없음 → 연결됨 순으로 답한다. */
function statusFor(plugin: ExternalPluginView, text: UiText): { tone: "ok" | "warn" | "waiting" | "muted"; label: string } {
  if (!plugin.enabled) return { tone: "muted", label: text("사용 안 함", "Disabled") };
  if (plugin.oauthPending) return { tone: "waiting", label: text("브라우저 승인 대기 중", "Waiting for browser approval") };
  if (!plugin.credentialReady) return { tone: "warn", label: isOAuthKind(plugin.auth) ? text("인증 필요", "Sign-in required") : text("토큰 필요", "Token required") };
  if (plugin.lastVerifiedAt !== null) return { tone: "ok", label: text(`연결됨 · 도구 ${plugin.tools.length}개`, `Connected · ${plugin.tools.length} tools`) };
  return { tone: "ok", label: text("연결 준비됨", "Ready to connect") };
}

/** 편집이 연결 지점을 바꾸는지. 백엔드는 이때 저장된 자격증명과 확인 결과를 초기화한다. */
function isConnectionChanged(draft: DraftForm, editing: ExternalPluginView | null): boolean {
  if (!editing) return false;
  return (
    draft.auth !== editing.auth
    || (draft.auth !== "notionToken" && draft.url.trim() !== (editing.url ?? ""))
    || (isOAuthKind(draft.auth) && (draft.clientId.trim() !== "" || draft.clientSecret.trim() !== ""))
    || (isOAuthKind(draft.auth) && draft.scope.trim() !== (editing.scope ?? "").trim())
  );
}

/** client_secret은 어느 클라이언트의 것인지 알 수 없으므로 client_id 없이는 보내지 않는다. */
function clientSecretNeedsClientId(draft: DraftForm): boolean {
  return isOAuthKind(draft.auth) && draft.clientSecret.trim() !== "" && draft.clientId.trim() === "";
}

/** 디바이스 인가는 동적 등록이 없어 사용자가 만든 앱의 client_id가 반드시 필요하다. */
function deviceNeedsClientId(draft: DraftForm, editing: ExternalPluginView | null): boolean {
  return draft.auth === "oauthDevice"
    && draft.clientId.trim() === ""
    && !(editing !== null && editing.auth === "oauthDevice");
}

/** 등록과 편집이 함께 요구하는 최소 입력. 다른 점은 식별자와 토큰뿐이라 그 둘만 각 버튼이 덧붙인다. */
function isDraftIncomplete(draft: DraftForm, editing: ExternalPluginView | null): boolean {
  return !draft.displayName.trim()
    || (draft.auth !== "notionToken" && !draft.url.trim())
    || clientSecretNeedsClientId(draft)
    || deviceNeedsClientId(draft, editing);
}

/**
 * 카드가 백엔드에서 받아 오는 것들 — 플러그인 목록, 이 화면의 접근 권한, 그리고 "한 번에 한
 * 동작"을 지키는 작업 껍데기.
 *
 * 카드 본문이 목록 적재·탭 재진입 표시·OAuth 대기 폴링·작업 껍데기까지 함께 쥐고 있어, 폼
 * 초안이나 모달 같은 화면 상태를 읽으려면 그 사이를 지나가야 했다. 서버에서 오는 것과 화면에만
 * 있는 것을 갈라 두면 두 쪽 모두 자기 이유만 보면 된다.
 *
 * 옮긴 것은 자리뿐이고 규칙은 그대로다 — 탭을 벗어나면 적재 표시를 풀어 다음 진입에 다시 읽고,
 * 승인 대기 중인 플러그인이 하나라도 있는 동안만 주기 조회를 걸며(백엔드가 콜백으로 상태를
 * 바꾸므로 화면이 알 길이 그것뿐이다), `run`은 앞선 작업이 도는 동안 새 작업을 받지 않고 성패와
 * 무관하게 목록을 다시 읽는다.
 */
function useExternalPluginsData(active: boolean) {
  const [snapshot, setSnapshot] = useState<ExternalPluginsSnapshot | null>(null);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  return { snapshot, access, error, busy, run };
}

/**
 * 외부 플러그인(MCP 서버) 카드. 등록·편집·토글·연결 확인·OAuth 인증·토큰 변경·삭제를 한 자리에서 한다.
 * 인증(OAuth 시작, 토큰 입력, 등록, 편집, 삭제)은 호스트 화면 전용이다 — 원격 UI에서는 토글과 연결 확인만 된다.
 */
export function ExternalPluginsCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const { snapshot, access, error, busy, run } = useExternalPluginsData(active);
  const [form, setForm] = useState<PluginFormState | null>(null);
  const [tokenTarget, setTokenTarget] = useState<ExternalPluginView | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  /**
   * 진행 중인 OAuth 시작 응답. 인가 주소와(디바이스 인가라면) 사용자 코드를 화면에 남겨,
   * OS가 브라우저를 조용히 못 띄운 경우(Windows의 https 핸들러 부재·정책 차단)에도 사용자가
   * 주소를 복사하거나 다시 열 수 있게 한다. 승인이 끝나 대기가 풀리면 닫는다.
   */
  const [oauthStart, setOauthStart] = useState<{ plugin: ExternalPluginView; start: ExternalPluginOAuthStart } | null>(null);
  /** 도구 권한 목록을 펼친 플러그인 id. */
  const [toolsOpen, setToolsOpen] = useState<string | null>(null);

  // 브라우저 승인이 끝나 대기가 풀리면(또는 목록에서 사라지면) 안내 모달을 거둔다. 시작 직후의
  // 목록은 아직 옛 상태(대기 아님)일 수 있으므로, 대기 중인 목록을 한 번 본 뒤에만 닫는다.
  const sawOAuthPendingRef = useRef(false);
  useEffect(() => {
    if (!oauthStart || !snapshot) return;
    const current = snapshot.plugins.find((plugin) => plugin.id === oauthStart.plugin.id);
    if (current?.oauthPending) { sawOAuthPendingRef.current = true; return; }
    if (sawOAuthPendingRef.current) {
      // 브라우저 승인이 끝난 자리다. 자격증명이 준비되면 이 플러그인은 "인증 대기"에서
      // "붙는 플러그인"으로 옮겨 가므로 기본도구 접근 상세도 다시 읽어야 한다 — 이 전환은
      // ipc 응답이 아니라 스냅숏 관찰로 드러나 `notifyBuiltinTools`가 닿지 않는다(QA #95).
      markBuiltinToolsChanged();
      setOauthStart(null);
    }
  }, [oauthStart, snapshot]);

  const canWrite = access?.writable === true;
  // 데스크톱 셸은 호스트 UI 자체다. `/api/access` 응답을 기다리는 동안에도 호스트 전용
  // 버튼을 잘못 잠그지 않도록 SSH 키 화면과 같은 판정 기준을 쓴다.
  const isHost = hasTauriRuntime() || access?.remote === false;
  const isRemote = !hasTauriRuntime() && access?.remote === true;

  /**
   * 되돌리기 어려운 방향일 때만 한 번 묻고, 사용자가 거절하면 아무것도 하지 않는다. 연결 정보
   * 변경·도구 전체 허용·삭제 세 자리가 "묻는다 → 거절이면 그대로 돌아온다 → 승낙이면 `run`에
   * 넘긴다"를 각자 적어 두어, 한 자리에서 거절 처리를 빠뜨려도 드러나지 않았다.
   *
   * 묻는 조건까지 여기서 맡지는 않는다 — 셋 중 둘은 좁히는 방향(인증 없는 플러그인 저장,
   * 도구를 확인·제한으로 되돌리기)일 때 묻지 않아야 해서, 물을지 말지는 부르는 쪽이 판단해
   * `prompt`에 null을 준다. 백엔드 서비스 카드의 `useBackendTask`가 쓰는 계약과 같은 모양이다.
   */
  const runAfterConfirm = async (key: string, prompt: ConfirmRequest | null, action: () => Promise<unknown>) => {
    if (prompt && !(await confirm(prompt))) return;
    await run(key, action);
  };

  /** 폼이 열려 있을 때만 초안을 갈아끼운다. 닫힌 폼에 초안만 남는 상태를 만들지 않는다. */
  const changeDraft = (draft: DraftForm) => setForm((prev) => (prev ? { ...prev, draft } : prev));

  const applyPreset = (preset: Preset) => { if (snapshot) changeDraft(presetDraft(preset, snapshot)); };

  const applyHostedPreset = (preset: HostedMcpPreset) => {
    changeDraft({ ...EMPTY_DRAFT, id: preset.id, displayName: preset.displayName, names: (preset.names ?? []).join(", "), url: preset.url, auth: preset.auth, scope: preset.defaultScope });
  };

  /** 등록·편집 폼을 닫는 모든 경로가 같은 빈 상태로 돌아가게 한다. */
  const closeForm = () => setForm(null);

  const submitDraft = (draft: DraftForm) => run("register", async () => {
    await registerExternalPlugin({
      id: draft.id.trim(),
      ...toExternalPluginPayload(draft),
    });
    closeForm();
  });

  const beginEdit = (plugin: ExternalPluginView) => {
    setForm({ editing: plugin, draft: { ...EMPTY_DRAFT, id: plugin.id, displayName: plugin.displayName, names: (plugin.names ?? []).join(", "), url: plugin.url ?? "", auth: plugin.auth, scope: plugin.scope ?? "" } });
  };

  const submitEdit = async (target: ExternalPluginView, draft: DraftForm) => {
    // 인증 없는 플러그인은 지울 자격증명이 없으니 조용히 저장한다(확인 결과 초기화는 폼 안내문이 설명한다).
    const asksAgain = isConnectionChanged(draft, target) && target.auth !== "none" && target.credentialReady;
    await runAfterConfirm(`update:${target.id}`, asksAgain ? {
      title: text("연결 정보 변경", "Change connection"),
      message: text(
        `"${target.displayName}"의 주소나 인증 방식이 바뀌면 보안 저장소의 자격증명과 연결 확인 결과가 초기화됩니다. 저장 뒤 다시 인증해야 합니다.`,
        `Changing the address or authentication of "${target.displayName}" clears the stored credential and verification result. You will need to authenticate again after saving.`,
      ),
      confirmLabel: text("변경", "Change"),
      tone: "danger",
    } : null, async () => {
      await updateExternalPlugin({
        id: target.id,
        ...toExternalPluginPayload(draft),
      });
      closeForm();
    });
  };

  const startOAuth = (plugin: ExternalPluginView) => run(`oauth:${plugin.id}`, async () => {
    const start = await beginExternalPluginOAuth(plugin.id);
    // 브라우저를 열기 전에 주소를 먼저 화면에 둔다. 열기가 실패하거나 OS가 성공만 돌려주고
    // 아무것도 띄우지 않아도, 사용자가 여기서 주소를 복사해 인증을 이어갈 수 있다.
    sawOAuthPendingRef.current = false;
    setOauthStart({ plugin, start });
    await openExternalUrl(start.authorizationUrl);
  });

  const changeToolPolicy = (plugin: ExternalPluginView, tool: string, policy: PluginToolPolicy) =>
    run(`tool:${plugin.id}`, () => setExternalPluginToolPolicy(plugin.id, tool, policy));

  const changeAllToolPolicies = (plugin: ExternalPluginView, policy: PluginToolPolicy) =>
    // 확인·제한으로 되돌리는 방향은 좁히는 쪽이라 묻지 않는다.
    runAfterConfirm(`tools:${plugin.id}`, policy === "allow" ? {
      title: text("현재 도구 전체 허용", "Allow all current tools"),
      message: text(
        `"${plugin.displayName}"의 현재 도구를 모두 승인 카드 없이 실행하도록 바꿉니다. 새로 발견되는 도구는 계속 확인이 필요합니다.`,
        `All current tools from "${plugin.displayName}" will run without an approval card. Newly discovered tools will still require confirmation.`,
      ),
      confirmLabel: text("전체 허용", "Allow all"),
      tone: "danger",
    } : null, () => setExternalPluginToolPolicies(plugin.id, policy));

  const remove = (plugin: ExternalPluginView) =>
    runAfterConfirm(`remove:${plugin.id}`, {
      title: text("플러그인 삭제", "Remove plugin"),
      message: text(
        `"${plugin.displayName}" 플러그인과 보안 저장소의 자격증명을 삭제합니다. 실행 중인 채팅은 다음 턴부터 이 도구를 잃습니다.`,
        `Remove the "${plugin.displayName}" plugin and its credential from the secure store. Running chats lose the tools on their next turn.`,
      ),
      confirmLabel: text("삭제", "Remove"),
      tone: "danger",
    }, () => removeExternalPlugin(plugin.id));

  const submitToken = () => {
    const target = tokenTarget;
    if (!target) return;
    void run(`token:${target.id}`, async () => {
      await setExternalPluginToken(target.id, tokenDraft);
      setTokenTarget(null);
      setTokenDraft("");
    });
  };

  const presets = snapshot ? hostedPresetsOf(snapshot) : [];

  return (
    <section className="settings-card external-plugins-card" data-ui-anchor="addons.mcp-content">
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
              access?.writable ? "원격 화면에서는 OAuth 인증만 제한됩니다" : "이 원격 연결은 읽기 전용입니다",
              access?.writable ? "Only OAuth sign-in is limited on a remote screen" : "This remote connection is read-only",
            )}</strong>
            <small>{access?.writable
              ? text(
                "등록·편집·토큰 입력·삭제는 여기서 할 수 있습니다. OAuth 승인은 콜백이 호스트의 loopback으로 돌아와 호스트 앱에서만 끝낼 수 있고, 도구 권한도 호스트 전용입니다 — 원격에서 새로 붙이려면 토큰 방식을 쓰세요.",
                "You can register, edit, enter tokens and remove here. OAuth approval only finishes in the host app because the callback returns to the host's loopback, and tool permissions stay host-only — use a token method to connect from a remote screen.",
              )
              : text(
                "설정을 바꾸려면 쓰기 권한으로 다시 연결하세요. OAuth 인증과 도구 권한은 쓰기 권한과 관계없이 호스트 앱에서만 가능합니다.",
                "Reconnect with write access to change settings. OAuth sign-in and tool permissions remain host-only regardless of remote write access.",
              )}</small>
          </span>
        </div>
      )}
      {snapshot === null
        ? <div className="plugin-loading-state">{!error && <LoaderCircle size={16} className="spin" />}<span>{error ? text("플러그인 목록을 읽지 못했습니다.", "Could not load plugins.") : text("플러그인을 확인하는 중…", "Checking plugins…")}</span></div>
        : snapshot.plugins.length === 0
          ? <div className="plugin-empty-state">
              <i><PluginMark brand="notion" size={28} /></i>
              <div><strong>{text("연결된 플러그인이 없습니다", "No plugins connected")}</strong><small>{text("Notion·Jira·GitHub·Figma 등을 OAuth 또는 토큰으로 연결할 수 있습니다.", "Connect Notion, Jira, GitHub, Figma and more with OAuth or a token.")}</small></div>
            </div>
          : <div className="plugin-list">
            {snapshot.plugins.map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                presets={presets}
                proxyReady={snapshot.proxyReady}
                busy={busy}
                canWrite={canWrite}
                isHost={isHost}
                toolsExpanded={toolsOpen === plugin.id}
                onToggleTools={() => setToolsOpen(toolsOpen === plugin.id ? null : plugin.id)}
                onSetEnabled={(next) => void run(`enable:${plugin.id}`, () => setExternalPluginEnabled(plugin.id, next))}
                onVerify={() => void run(`verify:${plugin.id}`, () => verifyExternalPlugin(plugin.id))}
                onStartOAuth={() => void startOAuth(plugin)}
                onCancelOAuth={() => void run(`cancel:${plugin.id}`, () => cancelExternalPluginOAuth(plugin.id))}
                onChangeToken={() => { setTokenTarget(plugin); setTokenDraft(""); }}
                onEdit={() => beginEdit(plugin)}
                onRemove={() => void remove(plugin)}
                onChangeToolPolicy={(tool, policy) => void changeToolPolicy(plugin, tool, policy)}
                onChangeAllToolPolicies={(policy) => void changeAllToolPolicies(plugin, policy)}
              />
            ))}
          </div>}
      {snapshot && !form && (
        <div className="settings-update-body">
          <span className="settings-update-status">
            <strong>{text("새 플러그인 연결", "Connect a plugin")}</strong>
            <small>{isHost
              ? text(`최대 ${snapshot.maxPlugins}개 · 변경 내용은 새로 시작하는 채팅부터 적용됩니다.`, `Up to ${snapshot.maxPlugins} · Changes apply to newly started chats.`)
              : text(`최대 ${snapshot.maxPlugins}개 · 원격에서는 토큰 방식으로 붙일 수 있습니다. OAuth 승인은 호스트 화면에서 끝내야 합니다.`, `Up to ${snapshot.maxPlugins} · Token methods work from a remote screen; OAuth approval must finish on the host.`)}</small>
          </span>
          <button className="button compact primary" type="button" disabled={!canWrite || snapshot.plugins.length >= snapshot.maxPlugins} onClick={() => setForm({ editing: null, draft: presetDraft(isHost ? "notionOauth" : "notionToken", snapshot) })}><Plus size={13} />{text("플러그인 추가", "Add plugin")}</button>
        </div>
      )}
      {snapshot && form && (
        <ExternalPluginForm
          editing={form.editing}
          draft={form.draft}
          presets={presets}
          snapshot={snapshot}
          busy={busy}
          onChangeDraft={changeDraft}
          onApplyPreset={applyPreset}
          onApplyHostedPreset={applyHostedPreset}
          onClose={closeForm}
          onSubmitEdit={() => { if (form.editing) void submitEdit(form.editing, form.draft); }}
          onSubmitDraft={() => void submitDraft(form.draft)}
        />
      )}
      {error && <ErrorBanner message={error} />}
      {oauthStart && (
        <PluginOAuthStartModal
          oauthStart={oauthStart}
          onCancel={() => { void run(`cancel:${oauthStart.plugin.id}`, () => cancelExternalPluginOAuth(oauthStart.plugin.id)); setOauthStart(null); }}
          onClose={() => setOauthStart(null)}
        />
      )}
      {tokenTarget && (
        <PluginTokenModal
          target={tokenTarget}
          tokenDraft={tokenDraft}
          busy={busy !== null}
          onChangeTokenDraft={setTokenDraft}
          onSubmit={submitToken}
          onClose={() => setTokenTarget(null)}
        />
      )}
      {confirmDialog}
    </section>
  );
}

interface ExternalPluginFormProps {
  editing: ExternalPluginView | null;
  draft: DraftForm;
  presets: HostedMcpPreset[];
  snapshot: ExternalPluginsSnapshot;
  busy: string | null;
  onChangeDraft: (draft: DraftForm) => void;
  onApplyPreset: (preset: Preset) => void;
  onApplyHostedPreset: (preset: HostedMcpPreset) => void;
  onClose: () => void;
  onSubmitEdit: () => void;
  onSubmitDraft: () => void;
}

/**
 * 플러그인 폼의 라벨+입력 한 줄.
 *
 * 식별자·표시 이름·주소·토큰·client_id·client_secret·scope·새 토큰 여덟 자리가 같은
 * `form-row > label + input` 구조를 각자 한 줄에 펼쳐 두고 있었다. 자리마다 실제로
 * 다른 것은 비밀 입력인지·잠겼는지·안내 문구가 무엇인지뿐이라, 그 셋만 인자로 남기고
 * 구조는 여기 한 곳에 둔다. `secret`은 기존 자리들이 함께 쓰던 `type="password"`와
 * `autoComplete="off"`를 한 이름으로 묶은 것이다.
 */
function PluginTextField({ id, label, value, onChange, placeholder, secret = false, disabled = false, title }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  secret?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="form-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={secret ? "password" : "text"}
        autoComplete={secret ? "off" : undefined}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        title={title}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/**
 * 외부 플러그인 등록 및 수정 폼.
 *
 * 프리셋 선택, 식별자·표시명·인증 방식·URL·토큰·OAuth 설정(client_id, client_secret, scope) 입력과
 * 그에 따른 안내 문구 및 유효성 검사를 담당한다.
 */
function ExternalPluginForm({
  editing,
  draft,
  presets,
  snapshot,
  busy,
  onChangeDraft,
  onApplyPreset,
  onApplyHostedPreset,
  onClose,
  onSubmitEdit,
  onSubmitDraft,
}: ExternalPluginFormProps) {
  const { text } = useI18n();
  const editConnectionChanged = isConnectionChanged(draft, editing);
  const draftIncomplete = isDraftIncomplete(draft, editing);
  const patch = (part: Partial<DraftForm>) => onChangeDraft({ ...draft, ...part });

  return (
    <div className="detail-card plugin-form">
      {editing
        ? <div className="plugin-row-name"><strong>{text("플러그인 편집", "Edit plugin")}</strong><code>{editing.id}</code></div>
        : <div className="plugin-presets">
          <button className={`plugin-preset${draft.auth === "oauth" && draft.url === snapshot.notionHostedUrl ? " selected" : ""}`} type="button" aria-pressed={draft.auth === "oauth" && draft.url === snapshot.notionHostedUrl} onClick={() => onApplyPreset("notionOauth")}><PluginMark brand="notion" size={22} /><span><strong>Notion</strong><small>OAuth</small></span></button>
          <button className={`plugin-preset${draft.auth === "notionToken" ? " selected" : ""}`} type="button" aria-pressed={draft.auth === "notionToken"} onClick={() => onApplyPreset("notionToken")}><PluginMark brand="notion" size={22} /><span><strong>Notion</strong><small>{text("내부 통합 토큰", "Integration token")}</small></span></button>
          {presets.map((preset) => {
            const selected = draft.auth === preset.auth && draft.url === preset.url;
            return (
              <button className={`plugin-preset${selected ? " selected" : ""}`} type="button" key={preset.id} aria-pressed={selected} onClick={() => onApplyHostedPreset(preset)}><PluginMark service={preset.id} brand={preset.brand} /><span><strong>{preset.displayName}</strong><small>{authLabel(preset.auth, text)}</small></span></button>
            );
          })}
          <button className={`plugin-preset${draft.auth === "none" || draft.auth === "bearer" ? " selected" : ""}`} type="button" aria-pressed={draft.auth === "none" || draft.auth === "bearer"} onClick={() => onApplyPreset("custom")}><Plug size={20} /><span><strong>{text("직접 입력", "Custom")}</strong><small>{text("외부 MCP 서버", "External MCP server")}</small></span></button>
        </div>}
      <PluginTextField id="plugin-id" label={text("식별자", "Identifier")} value={draft.id} placeholder="notion" disabled={editing !== null} title={editing ? text("식별자는 MCP 서버 이름과 프록시 경로로 쓰여 바꿀 수 없습니다", "The identifier is the MCP server name and proxy path, so it cannot change") : undefined} onChange={(id) => patch({ id })} />
      <PluginTextField id="plugin-name" label={text("표시 이름", "Display name")} value={draft.displayName} onChange={(displayName) => patch({ displayName })} />
      <PluginTextField
        id="plugin-names"
        label={text("다른 이름 (쉼표로 구분)", "Other names (comma-separated)")}
        value={draft.names}
        onChange={(names) => patch({ names })}
        placeholder={text("예: 노션, Notion — 요청에 이 말이 나오면 이 애드온을 고른다", "e.g. Notion, 노션 — requests using these words pick this add-on")}
      />
      <div className="form-row"><label htmlFor="plugin-auth">{text("인증 방식", "Authentication")}</label>
        <select id="plugin-auth" value={draft.auth} onChange={(event) => patch({ auth: event.target.value as ExternalPluginAuthKind })}>
          <option value="oauth">OAuth</option>
          <option value="oauthDevice">{text("OAuth 디바이스 인가(사용자 코드)", "OAuth device flow (user code)")}</option>
          <option value="bearer">{text("고정 토큰(Bearer)", "Bearer token")}</option>
          <option value="notionToken">{text("Notion 내부 통합 토큰(내장 서버)", "Notion internal integration token (managed server)")}</option>
          <option value="none">{text("인증 없음", "No authentication")}</option>
        </select>
      </div>
      {draft.auth !== "notionToken" && <PluginTextField id="plugin-url" label={text("MCP 주소", "MCP URL")} value={draft.url} placeholder="https://mcp.example.com/mcp" onChange={(url) => patch({ url })} />}
      {usesStaticToken(draft.auth) && <PluginTextField id="plugin-token" label={text("토큰", "Token")} secret value={draft.token} placeholder={editing && !editConnectionChanged ? text("비워 두면 기존 토큰 유지", "Leave empty to keep the current token") : draft.auth === "notionToken" ? "ntn_…" : ""} onChange={(token) => patch({ token })} />}
      {isOAuthKind(draft.auth) && <PluginOAuthFields draft={draft} editing={editing} presets={presets} onChangeDraft={onChangeDraft} />}
      <p className="plugin-form-note">{pluginFormNote(draft, editing, presets, snapshot, text)}</p>
      <div className="form-actions">
        <button className="button" type="button" onClick={onClose}>{text("취소", "Cancel")}</button>
        {editing
          ? <button className="button primary" type="button" disabled={busy !== null || draftIncomplete || (editConnectionChanged && usesStaticToken(draft.auth) && !draft.token)} onClick={onSubmitEdit}>{busy === `update:${editing.id}` ? text("저장 중…", "Saving…") : text("저장", "Save")}</button>
          : <button className="button primary" type="button" disabled={busy !== null || !draft.id.trim() || draftIncomplete || (usesStaticToken(draft.auth) && !draft.token)} onClick={onSubmitDraft}>{busy === "register" ? text("등록 중…", "Registering…") : text("등록", "Register")}</button>}
      </div>
    </div>
  );
}

/**
 * OAuth 계열 인증에서만 쓰는 입력 묶음 — client_id·client_secret·scope와 그 안내문.
 * 폼 본문 한가운데에 즉시 실행 함수로 박혀 있어, 프리셋·디바이스 인가·구글 여부를 가리는
 * 조건이 폼의 다른 칸들과 같은 높이에 섞여 있었다. 부르는 쪽은 이 묶음을 보일지만 정하고,
 * 무엇을 요구하는지는 이 컴포넌트가 혼자 안다.
 */
function PluginOAuthFields({ draft, editing, presets, onChangeDraft }: {
  draft: DraftForm;
  editing: ExternalPluginView | null;
  presets: HostedMcpPreset[];
  onChangeDraft: (draft: DraftForm) => void;
}) {
  const { text } = useI18n();
  const secretNeedsId = clientSecretNeedsClientId(draft);
  const deviceNeedsId = deviceNeedsClientId(draft, editing);
  const preset = hostedPresetFor(presets, draft.url);
  const device = draft.auth === "oauthDevice";
  const google = preset?.brand === "google";
  const manual = google || device;
  const chosen = draft.scope.split(/\s+/).filter(Boolean);
  const patch = (part: Partial<DraftForm>) => onChangeDraft({ ...draft, ...part });
  return <>
    <PluginTextField id="plugin-client" label={manual ? "client_id" : text("client_id (선택)", "client_id (optional)")} value={draft.clientId} placeholder={google ? text("GCP 콘솔의 OAuth 클라이언트 ID", "OAuth client ID from the GCP console") : device ? text("GitHub 등에서 만든 OAuth 앱의 Client ID", "Client ID of the OAuth app you created") : editing ? text("비워 두면 기존 인증 등록 유지", "Leave empty to keep the current registration") : text("비워 두면 인증할 때 자동 등록", "Leave empty to register automatically on sign-in")} onChange={(clientId) => patch({ clientId })} />
    {!device && <PluginTextField id="plugin-client-secret" label={text("client_secret (선택)", "client_secret (optional)")} secret value={draft.clientSecret} placeholder={google ? text("GCP 콘솔의 OAuth 클라이언트 보안 비밀번호", "OAuth client secret from the GCP console") : text("client_id와 함께 발급받았을 때만", "Only when issued together with a client_id")} onChange={(clientSecret) => patch({ clientSecret })} />}
    {secretNeedsId && <p className="plugin-field-note">{text("client_secret은 client_id와 함께 입력해야 합니다.", "A client_secret must be entered together with its client_id.")}</p>}
    {deviceNeedsId && <p className="plugin-field-note">{text("디바이스 인가는 자동 등록이 없어 client_id가 반드시 필요합니다.", "Device flow has no automatic registration, so a client_id is required.")}</p>}
    <PluginTextField id="plugin-scope" label={text("권한 범위(scope)", "Scope")} value={draft.scope} placeholder={text("비우면 서버가 알려 준 범위를 그대로 요청합니다", "Leave empty to request whatever the server advertises")} onChange={(scope) => patch({ scope })} />
    {preset && preset.availableScopes.length > 0 && (
      <div className="plugin-scope-chips">
        {preset.availableScopes.map((entry) => (
          <button className={`plugin-scope-chip${chosen.includes(entry) ? " selected" : ""}`} type="button" key={entry} aria-pressed={chosen.includes(entry)} onClick={() => patch({ scope: toggleScope(draft.scope, entry) })}>{entry}</button>
        ))}
        {preset.defaultScope !== draft.scope.trim() && <button className="plugin-scope-chip reset" type="button" onClick={() => patch({ scope: preset.defaultScope })}>{text("기본값으로", "Reset to default")}</button>}
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
}

/**
 * 폼 맨 아래 한 문단. 편집인지 등록인지, 등록이면 어느 인증 방식인지에 따라 여섯 갈래로
 * 갈리는 문구를 폼 반환문 안이 아니라 여기서 고른다.
 */
function pluginFormNote(
  draft: DraftForm,
  editing: ExternalPluginView | null,
  presets: HostedMcpPreset[],
  snapshot: ExternalPluginsSnapshot,
  text: UiText,
): string {
  return editing
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
        : hostedPresetFor(presets, draft.url)?.brand === "figma"
          ? text("Figma 데스크톱 앱에서 Dev Mode(Shift+D) → MCP 서버 켜기를 먼저 해야 합니다. 원격 서버(mcp.figma.com)는 Figma가 승인한 클라이언트만 접속할 수 있어 여기서는 쓸 수 없습니다.", "Turn on Dev Mode (Shift+D) → enable the MCP server in the Figma desktop app first. The remote server (mcp.figma.com) only accepts clients approved by Figma, so it cannot be used here.")
          : text("원격 서버는 HTTPS만, 로컬 서버는 loopback HTTP도 허용합니다. URL에는 토큰을 넣을 수 없습니다.", "Remote servers must use HTTPS; loopback HTTP is allowed for local servers. Tokens never go in the URL.");
}

interface PluginOAuthStartModalProps {
  oauthStart: { plugin: ExternalPluginView; start: ExternalPluginOAuthStart };
  onCancel: () => void;
  onClose: () => void;
}

/**
 * OAuth 승인 대기 모달. 인가 주소를 그대로 보여주고 다시 열기·복사를 제공한다 — 브라우저 열기는
 * OS 셸에 맡기는 자리라 실패해도 앱은 알 수 없고(Windows ShellExecute는 핸들러가 없어도 성공을
 * 돌려준다), 이 모달이 유일한 우회 경로다. 디바이스 인가에서는 사용자 코드도 함께 보여준다.
 */
function PluginOAuthStartModal({ oauthStart, onCancel, onClose }: PluginOAuthStartModalProps) {
  const { text } = useI18n();
  const { plugin, start } = oauthStart;
  const host = new URL(start.authorizationUrl).host;
  const device = Boolean(start.userCode);
  return (
    <Modal
      title={device
        ? text(`디바이스 인가 · ${plugin.displayName}`, `Device flow · ${plugin.displayName}`)
        : text(`브라우저 승인 · ${plugin.displayName}`, `Browser approval · ${plugin.displayName}`)}
      onClose={onClose}
      footer={<>
        <button className="button" type="button" onClick={onCancel}>{text("인증 취소", "Cancel sign-in")}</button>
        <button className="button primary" type="button" onClick={() => void openExternalUrl(start.authorizationUrl)}>{text("승인 화면 다시 열기", "Reopen approval page")}</button>
      </>}
    >
      {device && <p className="plugin-device-code"><code>{start.userCode}</code></p>}
      <p className="plugin-form-note">{device
        ? text(
          `브라우저에 열린 ${host} 화면에 위 코드를 입력해 승인하세요. 승인이 끝나면 이 목록의 상태가 "연결 준비됨"으로 바뀝니다.`,
          `Enter the code above on the ${host} page that opened in your browser. The row switches to "Ready to connect" once you approve.`,
        )
        : text(
          `브라우저에 열린 ${host} 화면에서 승인하세요. 승인이 끝나면 이 창은 닫히고 목록의 상태가 "연결 준비됨"으로 바뀝니다.`,
          `Approve on the ${host} page that opened in your browser. This dialog closes and the row switches to "Ready to connect" once you approve.`,
        )}</p>
      <div className="plugin-oauth-url" data-testid="plugin-oauth-url">
        <span className="plugin-oauth-url-label">{text("브라우저가 열리지 않으면 이 주소를 직접 열어 주세요.", "If no browser opened, open this address yourself.")}</span>
        <div className="plugin-oauth-url-row">
          <code>{start.authorizationUrl}</code>
          <CopyAction value={start.authorizationUrl} kind="link" />
        </div>
      </div>
    </Modal>
  );
}

interface PluginTokenModalProps {
  target: ExternalPluginView;
  tokenDraft: string;
  busy: boolean;
  onChangeTokenDraft: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

/** 고정 토큰(Bearer, Notion 등) 입력 및 변경 모달. */
function PluginTokenModal({
  target,
  tokenDraft,
  busy,
  onChangeTokenDraft,
  onSubmit,
  onClose,
}: PluginTokenModalProps) {
  const { text } = useI18n();
  return (
    <Modal
      title={text(`토큰 변경 · ${target.displayName}`, `Change token · ${target.displayName}`)}
      onClose={onClose}
      footer={<>
        <button className="button" type="button" onClick={onClose}>{text("취소", "Cancel")}</button>
        <button className="button primary" type="button" disabled={!tokenDraft || busy} onClick={onSubmit}>{text("저장", "Save")}</button>
      </>}
    >
      <PluginTextField id="plugin-new-token" label={text("새 토큰", "New token")} secret value={tokenDraft} placeholder={target.auth === "notionToken" ? "ntn_…" : ""} onChange={onChangeTokenDraft} />
      <p className="plugin-form-note">{text("이전 토큰은 보안 저장소에서 덮어써지고 내장 서버는 새 토큰으로 다시 뜹니다.", "The previous token is overwritten in the secure store; the managed server restarts with the new one.")}</p>
    </Modal>
  );
}
interface PluginRowProps {
  plugin: ExternalPluginView;
  presets: HostedMcpPreset[];
  proxyReady: boolean;
  /** 진행 중인 작업 키. `<작업>:<플러그인 id>` 꼴이라 이 행의 것인지 접미사로 가른다. */
  busy: string | null;
  canWrite: boolean;
  isHost: boolean;
  toolsExpanded: boolean;
  onToggleTools: () => void;
  onSetEnabled: (next: boolean) => void;
  onVerify: () => void;
  onStartOAuth: () => void;
  onCancelOAuth: () => void;
  onChangeToken: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onChangeToolPolicy: (tool: string, policy: PluginToolPolicy) => void;
  onChangeAllToolPolicies: (policy: PluginToolPolicy) => void;
}

/**
 * 등록된 플러그인 한 줄. 표식·상태·실행 동작(사용 토글·연결 확인)·관리 동작(인증·토큰·편집·
 * 삭제)과 도구 권한 패널을 담는다. 요청을 보내는 일은 전부 카드가 하고, 이 행은 무엇을
 * 누를 수 있는지와 왜 못 누르는지만 판단한다.
 */
function PluginRow({
  plugin,
  presets,
  proxyReady,
  busy,
  canWrite,
  isHost,
  toolsExpanded,
  onToggleTools,
  onSetEnabled,
  onVerify,
  onStartOAuth,
  onCancelOAuth,
  onChangeToken,
  onEdit,
  onRemove,
  onChangeToolPolicy,
  onChangeAllToolPolicies,
}: PluginRowProps) {
  const { text } = useI18n();
  const rowBusy = busy !== null && busy.endsWith(`:${plugin.id}`);
  // 편집·토큰 변경·삭제는 쓰기 권한만 있으면 원격에서도 눌린다(P4, 2026-09-30).
  const manageDisabled = !canWrite || rowBusy;
  // 인증과 도구 권한만 호스트에 남는다 — 앞은 콜백이 호스트 loopback으로 돌아와서,
  // 뒤는 허용이 승인 카드를 없애는 권한 확대라서다.
  const hostOnlyDisabled = !isHost || manageDisabled;
  const status = statusFor(plugin, text);
  const mark = markOf(plugin, presets);
  const brand = mark.brand;
  // 제한한 도구는 연결 확인 때 목록에서 빠지므로, 되돌릴 수 있도록 정해 둔
  // 도구를 합쳐 보여 준다.
  const policyNames = Object.keys(plugin.toolPolicies ?? {});
  const toolNames = [...new Set([...plugin.tools, ...policyNames])].sort();
  return (
    <div className={`plugin-row${plugin.enabled ? "" : " plugin-off"}`}>
      <i className={brand === "notion" || brand === "google" ? brand : undefined}><PluginMark service={mark.service} brand={brand} size={17} /></i>
      <div className="plugin-row-main">
        <div className="plugin-row-name"><strong>{plugin.displayName}</strong><code>{plugin.id}</code></div>
        <small>{authLabel(plugin.auth, text)} · {plugin.url ?? text("내장 MCP 서버", "Managed MCP server")}</small>
        <span className={`plugin-status ${status.tone}`}><i />{status.label}{plugin.lastVerifiedAt !== null && status.tone === "ok" ? <time dateTime={new Date(plugin.lastVerifiedAt).toISOString()}>{formatDateTime(plugin.lastVerifiedAt)}</time> : null}</span>
        {plugin.lastError && <small className="plugin-error">{plugin.lastError}</small>}
      </div>
      <div className="plugin-row-actions">
        <div className="plugin-row-action-group plugin-row-runtime-actions">
          <AppToggle checked={plugin.enabled} disabled={!canWrite || rowBusy} label={text("사용", "Enabled")} onChange={onSetEnabled} />
          <button className="button compact" type="button" disabled={!canWrite || rowBusy || !proxyReady || !plugin.credentialReady} title={verifyHint(plugin, proxyReady, text)} onClick={onVerify}>
            {busy === `verify:${plugin.id}` ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}{text("연결 확인", "Verify")}
          </button>
        </div>
        <div className="plugin-row-action-group plugin-row-management-actions">
          {isOAuthKind(plugin.auth) && (plugin.oauthPending
            ? <button className="button compact" type="button" disabled={rowBusy || !canWrite} onClick={onCancelOAuth}><X size={13} />{text("취소", "Cancel")}</button>
            : <button className="button compact primary" type="button" disabled={hostOnlyDisabled} title={isHost ? text("브라우저에서 승인하면 refresh token을 보안 저장소에 둡니다", "Approve in the browser; the refresh token is kept in the secure store") : text("승인 콜백이 호스트의 loopback으로 돌아오므로 인증은 호스트 화면에서만 끝낼 수 있습니다", "The approval callback returns to the host's loopback, so sign-in can only finish on the host")} onClick={onStartOAuth}>
              <ShieldCheck size={13} />{plugin.credentialReady ? text("다시 인증", "Re-authenticate") : text("인증", "Sign in")}
            </button>)}
          {usesStaticToken(plugin.auth) && <button className="button compact" type="button" disabled={manageDisabled} onClick={onChangeToken}><KeyRound size={13} />{text("토큰 변경", "Change token")}</button>}
          <button className="button compact" type="button" disabled={manageDisabled} title={text("표시 이름·주소·인증 방식을 편집합니다", "Edit the name, address and authentication")} onClick={onEdit}><Pencil size={13} />{text("편집", "Edit")}</button>
          <button className="plugin-remove-button" type="button" disabled={manageDisabled} aria-label={text(`${plugin.displayName} 삭제`, `Remove ${plugin.displayName}`)} title={text("삭제", "Remove")} onClick={onRemove}><Trash2 size={14} /></button>
        </div>
      </div>
      {toolNames.length > 0 && (
        <button className="plugin-tools-toggle" type="button" aria-expanded={toolsExpanded} onClick={onToggleTools}>
          {toolsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <strong>{text("도구 권한", "Tool permissions")}</strong>
          <span>{text(`${toolNames.length}개`, `${toolNames.length} tools`)}</span>
          {policyNames.length > 0 && <em>{text(`${policyNames.length}개 지정됨`, `${policyNames.length} set`)}</em>}
        </button>
      )}
      {toolsExpanded && (
        <PluginToolsPanel
          plugin={plugin}
          toolNames={toolNames}
          disabled={hostOnlyDisabled}
          isHost={isHost}
          onChangeToolPolicy={onChangeToolPolicy}
          onChangeAllToolPolicies={onChangeAllToolPolicies}
        />
      )}
    </div>
  );
}

interface PluginToolsPanelProps {
  plugin: ExternalPluginView;
  /** 발견된 도구와 권한을 정해 둔 도구의 합집합. 제한한 도구도 되돌릴 수 있어야 한다. */
  toolNames: string[];
  disabled: boolean;
  isHost: boolean;
  onChangeToolPolicy: (tool: string, policy: PluginToolPolicy) => void;
  onChangeAllToolPolicies: (policy: PluginToolPolicy) => void;
}

/** 펼친 도구 권한 패널. 일괄 변경 머리줄과 도구별 행이 같은 버튼 묶음을 쓴다. */
function PluginToolsPanel({ plugin, toolNames, disabled, isHost, onChangeToolPolicy, onChangeAllToolPolicies }: PluginToolsPanelProps) {
  const { text } = useI18n();
  // 도구 권한은 쓰기 권한과 무관하게 호스트 전용이다. 일괄 버튼과 개별 행이 같은 이유를 말한다.
  const disabledTitle = isHost ? undefined : text("도구 권한은 호스트 화면에서만 바꿀 수 있습니다", "Tool permissions are host-only");
  return (
    <div className="plugin-tools">
      <div className="plugin-tools-header">
        <span>
          <strong>{text("현재 도구 일괄 변경", "Change all current tools")}</strong>
          <small>{text("나중에 새로 발견되는 도구는 확인으로 시작합니다.", "Tools discovered later start as Ask.")}</small>
        </span>
        <ToolPolicyButtonGroup
          ariaLabel={text("현재 도구 전체 권한", "All current tool permissions")}
          currentPolicy={TOOL_POLICIES.find((policy) => toolNames.every((tool) => (plugin.toolPolicies?.[tool] ?? "ask") === policy)) ?? null}
          disabled={disabled}
          disabledTitle={disabledTitle}
          isBulk
          onSelect={onChangeAllToolPolicies}
        />
      </div>
      <p className="plugin-field-note">{text(
        "제한한 도구는 목록에서 사라져 CLI가 부를 수 없고, 허용한 도구는 승인 카드 없이 실행됩니다. 제한은 곧바로, 허용은 새로 시작하는 채팅부터 적용됩니다.",
        "Denied tools disappear from the list so the CLI cannot call them; allowed tools run without an approval card. Denial applies at once, allowance from newly started chats.",
      )}</p>
      {toolNames.map((tool) => (
        <div className="plugin-tool-row" key={tool}>
          <code>{tool}</code>
          <ToolPolicyButtonGroup
            ariaLabel={text(`${tool} 권한`, `${tool} permission`)}
            currentPolicy={plugin.toolPolicies?.[tool] ?? "ask"}
            disabled={disabled}
            disabledTitle={disabledTitle}
            onSelect={(policy) => onChangeToolPolicy(tool, policy)}
          />
        </div>
      ))}
    </div>
  );
}

interface ToolPolicyButtonGroupProps {
  currentPolicy: PluginToolPolicy | null;
  onSelect: (policy: PluginToolPolicy) => void;
  disabled: boolean;
  disabledTitle?: string;
  ariaLabel: string;
  isBulk?: boolean;
}

/** 도구 권한(허용·확인·제한) 선택 버튼 묶음. 일괄 변경 헤더와 개별 도구 행에서 공통으로 쓴다. */
function ToolPolicyButtonGroup({
  currentPolicy,
  onSelect,
  disabled,
  disabledTitle,
  ariaLabel,
  isBulk = false,
}: ToolPolicyButtonGroupProps) {
  const { text } = useI18n();
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
            {isBulk ? text(`전체 ${policyLabel(policy, text)}`, `${policyLabel(policy, text)} all`) : policyLabel(policy, text)}
          </button>
        );
      })}
    </div>
  );
}
