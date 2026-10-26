/**
 * C20. 설정 → 시스템의 **로그인 설정** 카드. 네 구획이다 — 계정(ID/비밀번호), OTP, 접근
 * 채널별 사용 여부, 로그인 세션. 비밀번호와 OTP 비밀은 이 화면을 지나 백엔드로만 가고
 * 되돌아오지 않는다; 화면이 받는 것은 아이디·설정 여부·채널별 요구·세션 목록뿐이다.
 *
 * 설정을 바꾸는 명령은 세션만으로는 부족하고 현재 비밀번호(없으면 OTP)를 함께 낸다
 * (C20-4). 그래서 변경 폼마다 재인증 칸이 하나 붙는다.
 */
import { Copy, KeyRound, LogOut, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { errorText } from "../lib/errorText";
import { formatDateTime } from "../lib/format";
import { useI18n, type UiText } from "../lib/i18n";
import {
  beginLoginOtpSetup,
  clearLoginPassword,
  confirmLoginOtpSetup,
  disableLoginOtp,
  getLoginSettings,
  getTailscaleServiceStatus,
  getWebAccessStatus,
  listLoginSessions,
  logout,
  revokeAllLoginSessions,
  revokeLoginSession,
  setLoginChannelRequirement,
  setLoginPassword,
  type LoginChannel,
  type LoginMethod,
  type LoginSessionView,
  type LoginSettingsView,
  type OtpSetup,
  type Reauth,
  type TailscaleServiceStatus,
  type WebAccessStatus,
} from "../lib/ipc";
import { writeClipboardText } from "../lib/clipboard";
import { AppToggle, ErrorBanner, HelpHint, useConfirm } from "./Shared";

const CHANNELS: LoginChannel[] = ["desktop", "localBrowser", "remote"];

function channelLabel(channel: LoginChannel, text: UiText): string {
  switch (channel) {
    case "desktop": return text("데스크톱 앱", "Desktop app");
    case "localBrowser": return text("로컬 브라우저", "Local browser");
    case "remote": return text("원격", "Remote");
  }
}

function channelHint(channel: LoginChannel, text: UiText): string {
  switch (channel) {
    case "desktop": return text("이 컴퓨터의 Agent Manager 창", "The Agent Manager window on this computer");
    case "localBrowser": return text("같은 컴퓨터의 브라우저로 127.0.0.1에 연 화면", "A browser on this computer opened at 127.0.0.1");
    case "remote": return text("Tailscale을 지나온 원격 브라우저·PWA, 헤드리스 NAS", "Remote browsers and PWAs over Tailscale, headless NAS");
  }
}

type Panel = "password" | "clearPassword" | "otp" | "disableOtp" | null;

/** 아직 마운트돼 있을 때만 결과를 적는 조회. 설정 화면의 다른 카드와 같은 껍데기다. */
function loadWhileMounted<T>(fetchStatus: () => Promise<T>, apply: (value: T) => void, fail?: (message: string) => void): () => void {
  let disposed = false;
  void fetchStatus()
    .then((next) => { if (!disposed) apply(next); })
    .catch((cause) => { if (!disposed) fail?.(errorText(cause)); });
  return () => { disposed = true; };
}

export function LoginSettingsCard() {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [settings, setSettings] = useState<LoginSettingsView | null>(null);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleServiceStatus | null>(null);
  const [sessions, setSessions] = useState<LoginSessionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);

  const reloadSessions = useCallback(() => loadWhileMounted(listLoginSessions, setSessions, setError), []);

  useEffect(() => {
    const disposers = [
      loadWhileMounted(getLoginSettings, setSettings, setError),
      // 접속 상태와 Tailscale 상태는 "지금 이 화면" 표시와 경고 한 줄에만 쓴다. 못 읽어도 카드는
      // 선다 — 그 실패는 시스템 카드가 이미 자기 배너에 적는다.
      loadWhileMounted(getWebAccessStatus, setAccess),
      loadWhileMounted(getTailscaleServiceStatus, setTailscale),
      reloadSessions(),
    ];
    return () => disposers.forEach((dispose) => dispose());
  }, [reloadSessions]);

  /** 한 번에 한 동작. 성공 문구는 부르는 쪽이 정하고, 실패는 카드 아래 배너 하나에 적는다. */
  const run = async (action: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const done = await action();
      if (done) setNotice(done);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const applySettings = (next: LoginSettingsView, done: string) => {
    setSettings(next);
    setPanel(null);
    return done;
  };

  const currentChannel: LoginChannel | null = access && access.channel !== "native" ? access.channel : null;

  const toggleRequirement = async (channel: LoginChannel, method: LoginMethod, enabled: boolean) => {
    if (enabled && channel === currentChannel) {
      const accepted = await confirm({
        title: text("이 채널에 로그인 요구", "Require sign-in on this channel"),
        message: text(
          `지금 보고 있는 이 화면도 ${channelLabel(channel, text)} 채널입니다. 켜면 다음 요청부터 로그인을 요구하고, 세션이 없으면 로그인 화면이 뜹니다.\n계속할까요?`,
          `The screen you are using now is on the ${channelLabel(channel, text)} channel. Once on, the next request requires a sign-in and the sign-in screen appears if there is no session.\nContinue?`,
        ),
        warning: text(
          "비밀번호·OTP를 잃으면 호스트에서 로그인 설정을 초기화해야 합니다(--reset-login 또는 앱 데이터의 login-* 파일 삭제).",
          "If you lose the password or OTP, reset the sign-in settings on the host (--reset-login, or delete the login-* files in app data).",
        ),
        confirmLabel: text("켜기", "Turn on"),
      });
      if (!accepted) return;
    }
    await run(async () => {
      setSettings(await setLoginChannelRequirement(channel, method, enabled));
      return enabled
        ? text(`${channelLabel(channel, text)} 채널에 ${methodLabel(method, text)} 로그인을 요구합니다`, `${channelLabel(channel, text)} now requires ${methodLabel(method, text)} sign-in`)
        : text(`${channelLabel(channel, text)} 채널의 ${methodLabel(method, text)} 로그인을 껐습니다`, `${channelLabel(channel, text)} no longer requires ${methodLabel(method, text)} sign-in`);
    });
  };

  const remoteOpenWithoutLogin = Boolean(tailscale?.enabled && settings && !settings.channels.remote.password && !settings.channels.remote.otp);

  return (
    <section className="settings-subsection login-settings-card" data-ui-anchor="settings.login">
      <header>
        <div>
          <strong>{text("로그인 설정", "Sign-in settings")}<HelpHint label={text("로그인 설정 설명", "How sign-in settings work")} title={text("로그인 설정", "Sign-in settings")}>
            {text(
              "접근 채널(데스크톱 앱·로컬 브라우저·원격)마다 ID/비밀번호와 OTP를 따로 켭니다. 켜진 수단을 모두 통과해야 그 채널에서 Agent Manager를 쓸 수 있고, 로그인한 뒤에는 어느 채널이든 데스크톱과 같은 권한입니다. 아무 수단도 켜지 않은 채널은 지금처럼 바로 열립니다. CLI 릴레이처럼 이 컴퓨터 안에서 오는 호출은 로그인 대상이 아닙니다.",
              "Each access channel (desktop app, local browser, remote) can require a user ID/password and an OTP separately. Every method switched on for a channel must pass before Agent Manager opens there, and once signed in every channel has the same permissions as the desktop. A channel with nothing switched on opens right away. Calls from inside this computer, such as CLI relays, are never asked to sign in.",
            )}
          </HelpHint></strong>
          <small>{settings
            ? summaryText(settings, text)
            : error ? text("설정을 읽지 못했습니다", "Could not read the settings") : text("설정 확인 중…", "Checking settings…")}</small>
        </div>
      </header>
      <div className="backend-service-body login-settings-body">
        {remoteOpenWithoutLogin && <div className="login-settings-warning" role="alert">
          <p>{text(
            "Tailscale 서비스가 켜져 있는데 원격 채널에 로그인 수단이 없습니다. 원격은 이제 데스크톱과 같은 권한이므로, 비밀번호나 OTP를 등록하고 원격 채널에 켜 두세요.",
            "The Tailscale service is on, but the remote channel has no sign-in method. Remote now has the same permissions as the desktop, so set up a password or OTP and require it on the remote channel.",
          )}</p>
        </div>}

        <div className="login-settings-section">
          <div className="login-settings-row">
            <span>
              <strong><KeyRound size={14} /> {text("계정 (ID/비밀번호)", "Account (user ID/password)")}</strong>
              <small>{settings?.passwordConfigured
                ? text(`아이디 ${settings.userId} · 비밀번호 설정됨`, `User ID ${settings.userId} · password set`)
                : text("비밀번호가 없습니다. 설정하면 채널에 ID/비밀번호 로그인을 켤 수 있습니다.", "No password yet. Set one to require user ID/password sign-in on a channel.")}</small>
            </span>
            <span className="login-settings-actions">
              <button className="button compact" type="button" disabled={busy || !settings} onClick={() => setPanel(panel === "password" ? null : "password")}>
                {settings?.passwordConfigured ? text("변경", "Change") : text("설정", "Set up")}
              </button>
              {settings?.passwordConfigured && <button className="button compact" type="button" disabled={busy} onClick={() => setPanel(panel === "clearPassword" ? null : "clearPassword")}>{text("해제", "Remove")}</button>}
            </span>
          </div>
          {panel === "password" && settings && <PasswordForm
            settings={settings}
            busy={busy}
            onCancel={() => setPanel(null)}
            onSubmit={(userId, next, reauth) => run(async () => applySettings(
              await setLoginPassword(next, reauth, userId),
              text("비밀번호를 저장했습니다", "Password saved"),
            ))}
          />}
          {panel === "clearPassword" && settings && <ReauthForm
            settings={settings}
            busy={busy}
            title={text("비밀번호 해제", "Remove password")}
            hint={text("어느 채널에서든 ID/비밀번호를 요구하는 동안은 해제할 수 없습니다. 먼저 채널에서 끄세요.", "The password cannot be removed while any channel requires it. Turn it off there first.")}
            submitLabel={text("해제", "Remove")}
            onCancel={() => setPanel(null)}
            onSubmit={(reauth) => run(async () => applySettings(
              await clearLoginPassword(reauth),
              text("비밀번호를 해제했습니다", "Password removed"),
            ))}
          />}
        </div>

        <div className="login-settings-section">
          <div className="login-settings-row">
            <span>
              <strong><Smartphone size={14} /> {text("OTP (인증 앱)", "OTP (authenticator app)")}</strong>
              <small>{settings?.otpConfigured
                ? settings.otpSecretStorage === "file"
                  ? text("등록됨 · OS 보안 저장소가 없어 비밀이 앱 데이터의 전용 파일(소유자만 읽기)에 있습니다", "Enrolled · no OS secure store here, so the secret lives in a private file in app data")
                  : text("등록됨 · 비밀은 OS 보안 저장소에 있습니다", "Enrolled · the secret is in the OS secure store")
                : text("등록된 인증 앱이 없습니다. 등록하면 채널에 OTP 로그인을 켤 수 있습니다.", "No authenticator app enrolled. Enroll one to require OTP sign-in on a channel.")}</small>
            </span>
            <span className="login-settings-actions">
              <button className="button compact" type="button" disabled={busy || !settings} onClick={() => setPanel(panel === "otp" ? null : "otp")}>
                {settings?.otpConfigured ? text("다시 등록", "Re-enroll") : text("등록", "Enroll")}
              </button>
              {settings?.otpConfigured && <button className="button compact" type="button" disabled={busy} onClick={() => setPanel(panel === "disableOtp" ? null : "disableOtp")}>{text("해제", "Remove")}</button>}
            </span>
          </div>
          {panel === "otp" && settings && <OtpEnrollForm
            settings={settings}
            busy={busy}
            onCancel={() => setPanel(null)}
            onBegin={async (reauth) => {
              setError(null);
              return beginLoginOtpSetup(reauth);
            }}
            onConfirm={(code) => run(async () => applySettings(
              await confirmLoginOtpSetup(code),
              text("OTP를 등록했습니다", "OTP enrolled"),
            ))}
            onError={(message) => setError(message)}
          />}
          {panel === "disableOtp" && settings && <ReauthForm
            settings={settings}
            busy={busy}
            title={text("OTP 해제", "Remove OTP")}
            hint={text("어느 채널에서든 OTP를 요구하는 동안은 해제할 수 없습니다. 먼저 채널에서 끄세요.", "OTP cannot be removed while any channel requires it. Turn it off there first.")}
            submitLabel={text("해제", "Remove")}
            onCancel={() => setPanel(null)}
            onSubmit={(reauth) => run(async () => applySettings(
              await disableLoginOtp(reauth),
              text("OTP를 해제했습니다", "OTP removed"),
            ))}
          />}
        </div>

        <div className="login-settings-section">
          <strong className="login-settings-heading"><ShieldCheck size={14} /> {text("접근 채널별 사용", "Per-channel requirements")}</strong>
          <table className="login-channel-table">
            <thead>
              <tr>
                <th scope="col">{text("채널", "Channel")}</th>
                <th scope="col">{text("ID/비밀번호", "User ID/password")}</th>
                <th scope="col">OTP</th>
              </tr>
            </thead>
            <tbody>
              {CHANNELS.map((channel) => {
                const requirement = settings?.channels[channel];
                return (
                  <tr key={channel} data-login-channel={channel} className={channel === currentChannel ? "current" : undefined}>
                    <th scope="row">
                      <span>{channelLabel(channel, text)}{channel === currentChannel && <em className="login-channel-current">{text("지금 이 화면", "This screen")}</em>}</span>
                      <small>{channelHint(channel, text)}</small>
                    </th>
                    {(["password", "otp"] as LoginMethod[]).map((method) => {
                      const configured = method === "password" ? settings?.passwordConfigured : settings?.otpConfigured;
                      const checked = requirement ? requirement[method] : false;
                      return (
                        <td key={method} title={!configured && !checked ? text(`${methodLabel(method, text)}을(를) 먼저 설정하세요`, `Set up ${methodLabel(method, text)} first`) : undefined}>
                          <AppToggle
                            checked={checked}
                            disabled={busy || !settings || (!configured && !checked)}
                            label={text(`${channelLabel(channel, text)} ${methodLabel(method, text)} 로그인`, `${channelLabel(channel, text)} ${methodLabel(method, text)} sign-in`)}
                            onChange={(next) => void toggleRequirement(channel, method, next)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="login-settings-section">
          <div className="login-settings-row">
            <span>
              <strong><LogOut size={14} /> {text("로그인 세션", "Sign-in sessions")}</strong>
              <small>{text("발급된 세션은 30일 동안 쓰지 않거나 90일이 지나면 끝납니다. 토큰 원문은 어디에도 남지 않습니다.", "A session ends after 30 days unused or 90 days in total. The raw token is never stored.")}</small>
            </span>
            <span className="login-settings-actions">
              {sessions && sessions.length > 0 && <button className="button compact" type="button" disabled={busy} onClick={() => void run(async () => {
                const accepted = await confirm({
                  title: text("다른 세션 모두 종료", "End all other sessions"),
                  message: text("이 화면의 세션만 남기고 다른 기기·브라우저의 세션을 모두 끝냅니다.\n계속할까요?", "Ends every session except the one on this screen.\nContinue?"),
                  confirmLabel: text("종료", "End"),
                  tone: "danger",
                });
                if (!accepted) return null;
                const result = await revokeAllLoginSessions(true);
                reloadSessions();
                return text(`세션 ${result.revokedCount}개를 끝냈습니다`, `Ended ${result.revokedCount} session(s)`);
              })}>{text("다른 세션 모두 종료", "End all other sessions")}</button>}
              {access?.authenticated && <button className="button compact" type="button" disabled={busy} onClick={() => void run(async () => {
                await logout();
                window.location.reload();
                return null;
              })}>{text("이 화면 로그아웃", "Sign out this screen")}</button>}
            </span>
          </div>
          {sessions && sessions.length > 0 && <ul className="login-session-list">
            {sessions.map((session) => (
              <li key={session.id} data-login-session={session.id}>
                <span>
                  <strong>{channelLabel(session.channel, text)}{session.current && <em className="login-channel-current">{text("현재", "Current")}</em>}</strong>
                  <small>{session.label || text("이름 없는 클라이언트", "Unnamed client")} · {text("마지막 사용", "Last used")} {formatDateTime(session.lastSeenAt)}</small>
                </span>
                <button className="button compact" type="button" disabled={busy || session.current} aria-label={text("세션 종료", "End session")} onClick={() => void run(async () => {
                  await revokeLoginSession(session.id);
                  reloadSessions();
                  return text("세션을 끝냈습니다", "Session ended");
                })}><Trash2 size={13} /></button>
              </li>
            ))}
          </ul>}
          {sessions && sessions.length === 0 && <small className="settings-storage-note">{text("살아 있는 세션이 없습니다.", "No active sessions.")}</small>}
        </div>

        {notice && <p className="settings-success" role="status">{notice}</p>}
        {error && <ErrorBanner message={error} />}
      </div>
      {confirmDialog}
    </section>
  );
}

function methodLabel(method: LoginMethod, text: UiText): string {
  return method === "password" ? text("ID/비밀번호", "user ID/password") : "OTP";
}

function summaryText(settings: LoginSettingsView, text: UiText): string {
  const required = CHANNELS.filter((channel) => settings.channels[channel].password || settings.channels[channel].otp);
  if (required.length === 0) return text("모든 채널이 로그인 없이 열립니다", "Every channel opens without a sign-in");
  return `${text("로그인 요구", "Sign-in required")}: ${required.map((channel) => channelLabel(channel, text)).join(" · ")}`;
}

/** 재인증 칸 — 비밀번호가 있으면 비밀번호, 없고 OTP만 있으면 OTP, 둘 다 없으면 아무것도. */
function ReauthInputs({ settings, value, onChange }: {
  settings: LoginSettingsView;
  value: Reauth;
  onChange: (next: Reauth) => void;
}) {
  const { text } = useI18n();
  if (settings.passwordConfigured) {
    return <label>
      <span>{text("현재 비밀번호", "Current password")}</span>
      <input type="password" autoComplete="current-password" value={value.currentPassword ?? ""} onChange={(event) => onChange({ currentPassword: event.target.value })} />
    </label>;
  }
  if (settings.otpConfigured) {
    return <label>
      <span>{text("현재 OTP 코드", "Current OTP code")}</span>
      <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={value.currentOtp ?? ""} onChange={(event) => onChange({ currentOtp: event.target.value.replace(/\D/g, "") })} />
    </label>;
  }
  return null;
}

function PasswordForm({ settings, busy, onCancel, onSubmit }: {
  settings: LoginSettingsView;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (userId: string, next: string, reauth: Reauth) => Promise<void>;
}) {
  const { text } = useI18n();
  const [userId, setUserId] = useState(settings.userId);
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [reauth, setReauth] = useState<Reauth>({});
  const [issue, setIssue] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (next !== again) {
      setIssue(text("새 비밀번호 두 칸이 다릅니다.", "The two new password fields differ."));
      return;
    }
    if (next.length < 8) {
      setIssue(text("비밀번호는 8자 이상이어야 합니다.", "A password needs at least 8 characters."));
      return;
    }
    setIssue(null);
    // 저장에 성공하면 카드가 패널을 닫아 이 폼째로 사라진다. 그러니 여기서 칸을 비우면 그것은
    // 실패(현재 비밀번호 틀림, 아이디 거절)나 다른 동작이 도는 중일 때뿐이고, 고칠 칸 하나 때문에
    // 새 비밀번호 두 칸까지 다시 치게 된다. 입력은 그대로 둔다.
    void onSubmit(userId.trim(), next, reauth);
  };
  return (
    <form className="storage-secrets-form login-settings-form" onSubmit={submit}>
      <label>
        <span>{text("아이디", "User ID")}</span>
        <input type="text" autoComplete="username" maxLength={64} value={userId} onChange={(event) => setUserId(event.target.value)} />
      </label>
      <ReauthInputs settings={settings} value={reauth} onChange={setReauth} />
      <label>
        <span>{settings.passwordConfigured ? text("새 비밀번호", "New password") : text("비밀번호", "Password")}</span>
        <input type="password" autoComplete="new-password" maxLength={256} value={next} onChange={(event) => setNext(event.target.value)} />
      </label>
      <label>
        <span>{text("비밀번호 확인", "Confirm password")}</span>
        <input type="password" autoComplete="new-password" maxLength={256} value={again} onChange={(event) => setAgain(event.target.value)} />
      </label>
      <small className="storage-secrets-form-hint">{text("비밀번호는 argon2id 해시로만 저장되고 원문은 어디에도 남지 않습니다. 8~256자.", "The password is stored only as an argon2id hash; the plain text is never kept. 8 to 256 characters.")}</small>
      <FormActions busy={busy} issue={issue} submitLabel={text("저장", "Save")} onCancel={onCancel} />
    </form>
  );
}

function ReauthForm({ settings, busy, title, hint, submitLabel, onCancel, onSubmit }: {
  settings: LoginSettingsView;
  busy: boolean;
  title: string;
  hint: string;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (reauth: Reauth) => Promise<void>;
}) {
  const [reauth, setReauth] = useState<Reauth>({});
  return (
    <form className="storage-secrets-form login-settings-form" onSubmit={(event) => { event.preventDefault(); void onSubmit(reauth); }}>
      <strong className="login-settings-form-title">{title}</strong>
      <ReauthInputs settings={settings} value={reauth} onChange={setReauth} />
      <small className="storage-secrets-form-hint">{hint}</small>
      <FormActions busy={busy} issue={null} submitLabel={submitLabel} onCancel={onCancel} />
    </form>
  );
}

function OtpEnrollForm({ settings, busy, onCancel, onBegin, onConfirm, onError }: {
  settings: LoginSettingsView;
  busy: boolean;
  onCancel: () => void;
  onBegin: (reauth: Reauth) => Promise<OtpSetup>;
  onConfirm: (code: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { text } = useI18n();
  const [reauth, setReauth] = useState<Reauth>({});
  const [setup, setSetup] = useState<OtpSetup | null>(null);
  const [code, setCode] = useState("");
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState(false);
  const needsReauth = settings.passwordConfigured || settings.otpConfigured;

  const begin = async (event: FormEvent) => {
    event.preventDefault();
    if (starting) return;
    setStarting(true);
    try {
      setSetup(await onBegin(reauth));
    } catch (cause) {
      onError(errorText(cause));
    } finally {
      setStarting(false);
    }
  };

  if (!setup) {
    return (
      <form className="storage-secrets-form login-settings-form" onSubmit={(event) => void begin(event)}>
        <strong className="login-settings-form-title">{settings.otpConfigured ? text("OTP 다시 등록", "Re-enroll OTP") : text("OTP 등록", "Enroll OTP")}</strong>
        {needsReauth && <ReauthInputs settings={settings} value={reauth} onChange={setReauth} />}
        <small className="storage-secrets-form-hint">{text("QR 코드를 인증 앱(Google Authenticator, 1Password 등)으로 읽고 첫 코드를 넣어야 등록이 끝납니다. 그 전에는 아무것도 저장되지 않습니다.", "Scan the QR code with an authenticator app (Google Authenticator, 1Password, …) and enter the first code to finish. Nothing is stored before that.")}</small>
        <FormActions busy={busy || starting} issue={null} submitLabel={text("시작", "Start")} onCancel={onCancel} />
      </form>
    );
  }

  const qrSrc = `data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`;
  return (
    <form className="storage-secrets-form login-settings-form login-otp-enroll" onSubmit={(event) => { event.preventDefault(); void onConfirm(code).then(() => setCode("")); }}>
      <div className="login-otp-qr">
        <img src={qrSrc} alt={text("OTP 등록 QR 코드", "OTP enrollment QR code")} width={220} height={220} />
      </div>
      <div className="login-otp-manual">
        <span>{text("수동 입력 키", "Manual entry key")}</span>
        <code data-login-otp-secret>{setup.secretBase32.replace(/(.{4})/g, "$1 ").trim()}</code>
        <button className="button compact" type="button" onClick={() => void writeClipboardText(setup.secretBase32).then(() => setCopied(true)).catch((cause: unknown) => onError(errorText(cause)))}>
          <Copy size={13} /> {copied ? text("복사됨", "Copied") : text("복사", "Copy")}
        </button>
        <small>{text("Agent Manager · SHA1 · 6자리 · 30초", "Agent Manager · SHA1 · 6 digits · 30 s")}</small>
      </div>
      <label>
        <span>{text("인증 앱의 현재 코드", "Current code from the app")}</span>
        <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} />
      </label>
      <FormActions busy={busy} issue={null} submitLabel={text("등록 완료", "Finish enrollment")} onCancel={onCancel} />
    </form>
  );
}

function FormActions({ busy, issue, submitLabel, onCancel }: { busy: boolean; issue: string | null; submitLabel: string; onCancel: () => void }): ReactNode {
  const { text } = useI18n();
  return (
    <div className="storage-secrets-form-actions">
      {issue && <span className="storage-secrets-error" role="alert">{issue}</span>}
      <button className="button compact" type="button" disabled={busy} onClick={onCancel}>{text("취소", "Cancel")}</button>
      <button className="button primary compact" type="submit" disabled={busy}>{busy ? text("처리 중…", "Working…") : submitLabel}</button>
    </div>
  );
}
