/**
 * C20. 접근 채널 로그인 게이트. 앱 셸 바깥에서 악수(`/api/access`)를 한 번 보고, 이 채널이
 * 로그인을 요구하는데 세션이 없으면 로그인 화면을 띄운다. 그 뒤로는 어느 요청이든 401
 * `LOGIN_REQUIRED`로 거절되면(`loginRequiredStore`) 같은 화면이 앱 위에 다시 선다 — 앱은
 * 내리지 않는다. 세션이 끝났을 뿐 화면의 상태까지 잃을 이유는 없다.
 */
import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { errorText } from "../lib/errorText";
import { useI18n } from "../lib/i18n";
import { accessNeedsLogin, ensureBackendProtocol } from "../lib/ipcTransport";
import { login, type LoginForm } from "../lib/ipcLogin";
import { loginRequiredStore, type LoginRequirement } from "../lib/loginSession";
import { ErrorBanner } from "./Shared";

type GatePhase = "checking" | "ready" | "failed";

export function LoginGate({ children }: { children: ReactNode }) {
  const { text } = useI18n();
  const required = useSyncExternalStore(loginRequiredStore.subscribe, loginRequiredStore.get);
  const [phase, setPhase] = useState<GatePhase>("checking");
  const [cause, setCause] = useState<unknown>(null);
  // 처음 한 번 로그인을 지나기 전에는 앱을 올리지 않는다 — 올리자마자 모든 요청이 401로
  // 돌아와 화면이 오류로 뒤덮인다. 한 번 지난 뒤의 재로그인은 앱 위에 겹쳐 띄운다.
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    let disposed = false;
    ensureBackendProtocol()
      .then((access) => {
        if (disposed) return;
        if (accessNeedsLogin(access)) loginRequiredStore.raise(access.loginRequired);
        else {
          loginRequiredStore.clear();
          setUnlocked(true);
        }
        setPhase("ready");
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setCause(error);
        setPhase("failed");
      });
    return () => { disposed = true; };
  }, []);

  if (phase === "failed") {
    return <main role="alert" className="startup-error">
      <strong>{text("백엔드 서비스에 연결하지 못했습니다.", "Could not reach the backend service.")}</strong>
      <p>{errorText(cause)}</p>
    </main>;
  }
  if (phase === "checking") return null;
  return <>
    {unlocked && children}
    {required && <LoginScreen requirement={required} overlay={unlocked} onSignedIn={() => setUnlocked(true)} />}
  </>;
}

function LoginScreen({ requirement, overlay, onSignedIn }: {
  requirement: LoginRequirement;
  overlay: boolean;
  onSignedIn: () => void;
}) {
  const { text } = useI18n();
  const [userId, setUserId] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const form: LoginForm = {};
    if (requirement.password) {
      form.userId = userId.trim();
      form.password = password;
    }
    if (requirement.otp) form.otp = otp.trim();
    setBusy(true);
    setError(null);
    try {
      await login(form);
      setPassword("");
      setOtp("");
      onSignedIn();
    } catch (cause) {
      setError(errorText(cause));
      setOtp("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`login-gate${overlay ? " overlay" : ""}`} role="dialog" aria-modal="true" aria-labelledby="login-gate-title" data-ui-anchor="login.gate">
      <form className="login-gate-card" onSubmit={(event) => void submit(event)}>
        <h1 id="login-gate-title">{text("Agent Manager 로그인", "Sign in to Agent Manager")}</h1>
        <p className="login-gate-lead">{requirement.password && requirement.otp
          ? text("이 접근 채널은 ID/비밀번호와 OTP를 요구합니다.", "This access channel requires a user ID, password, and OTP code.")
          : requirement.password
            ? text("이 접근 채널은 ID/비밀번호를 요구합니다.", "This access channel requires a user ID and password.")
            : text("이 접근 채널은 OTP를 요구합니다.", "This access channel requires an OTP code.")}</p>
        {requirement.password && <>
          <label>
            <span>{text("아이디", "User ID")}</span>
            <input type="text" name="userId" autoComplete="username" autoFocus value={userId} onChange={(event) => setUserId(event.target.value)} />
          </label>
          <label>
            <span>{text("비밀번호", "Password")}</span>
            <input type="password" name="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
        </>}
        {requirement.otp && <label>
          <span>{text("OTP 코드", "OTP code")}</span>
          <input type="text" name="otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} autoFocus={!requirement.password} value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))} />
        </label>}
        {error && <ErrorBanner message={error} />}
        <button className="button primary" type="submit" disabled={busy}>{busy ? text("확인 중…", "Signing in…") : text("로그인", "Sign in")}</button>
        <small className="login-gate-help">{text(
          "비밀번호나 OTP를 잃었으면 호스트에서 로그인 설정을 초기화하세요: 헤드리스는 `agent-manager-server --reset-login`, 데스크톱은 앱 데이터 폴더의 login-settings-v1.json·login-sessions-v1.json·login-otp-secret 파일을 지운 뒤 다시 시작합니다.",
          "Lost the password or OTP? Reset the sign-in settings on the host: headless runs `agent-manager-server --reset-login`; on the desktop delete login-settings-v1.json, login-sessions-v1.json, and login-otp-secret from the app data folder, then restart.",
        )}</small>
      </form>
    </div>
  );
}
