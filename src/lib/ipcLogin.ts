/**
 * C20. 접근 채널 로그인 — 로그인·로그아웃과 설정 → 시스템의 로그인 설정 명령.
 *
 * 비밀번호·OTP 코드는 이 파일을 지나 백엔드로 가고 되돌아오지 않는다. 설정 화면이 받는
 * 것은 아이디, 설정 여부, 채널별 요구, 세션 목록뿐이다.
 */
import { backendHttpUrl } from "./backend";
import {
  call,
  postJson,
  resetBackendProtocolHandshake,
  responseError,
} from "./ipcTransport";
import { runtimeText } from "./i18nRuntime";
import { loginRequiredStore, setLoginSessionToken, type LoginRequirement } from "./loginSession";

export type LoginChannel = "desktop" | "localBrowser" | "remote";
export type LoginMethod = "password" | "otp";
export type OtpSecretStorage = "keychain" | "file";

export interface ChannelRequirements {
  desktop: LoginRequirement;
  localBrowser: LoginRequirement;
  remote: LoginRequirement;
}

export interface LoginSettingsView {
  userId: string;
  passwordConfigured: boolean;
  otpConfigured: boolean;
  /** OTP 비밀이 OS 보안 저장소에 있는지, 저장소가 없어 앱 데이터 파일로 내려갔는지(C20-8). */
  otpSecretStorage: OtpSecretStorage | null;
  channels: ChannelRequirements;
}

export interface OtpSetup {
  otpauthUrl: string;
  secretBase32: string;
  qrSvg: string;
  expiresAt: number;
}

export interface LoginSessionView {
  id: string;
  channel: LoginChannel;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  label: string;
  current: boolean;
}

/** 설정을 바꾸는 명령이 함께 내는 재인증. 비밀번호가 있으면 비밀번호, 없고 OTP만 있으면 OTP. */
export interface Reauth {
  currentPassword?: string;
  currentOtp?: string;
}

export interface LoginForm {
  userId?: string;
  password?: string;
  otp?: string;
}

/**
 * 로그인. 성공하면 토큰을 저장하고 악수를 다시 맺게 하며 "로그인 필요" 신호를 내린다.
 * `/api/invoke`가 아니라 전용 경로라 `call()`을 쓰지 않는다 — `call()`은 악수를 먼저
 * 기다리는데, 그 악수가 바로 로그인이 없다고 답한 것이다.
 */
export async function login(form: LoginForm): Promise<void> {
  const response = await postJson(backendHttpUrl("/api/login"), form);
  if (!response.ok) throw await responseError(response, runtimeText("로그인하지 못했습니다", "Could not sign in"));
  const payload = await response.json().catch(() => null) as { token?: unknown } | null;
  if (!payload || typeof payload.token !== "string" || payload.token.length === 0) {
    throw new Error(runtimeText("로그인 응답이 올바르지 않습니다.", "The sign-in response is malformed."));
  }
  setLoginSessionToken(payload.token);
  resetBackendProtocolHandshake();
  loginRequiredStore.clear();
}

/** 이 화면의 세션을 끝낸다. 백엔드가 거절해도 토큰은 버린다 — 더 쓸 수 없는 값이다. */
export async function logout(): Promise<void> {
  try {
    await postJson(backendHttpUrl("/api/logout"), {});
  } finally {
    setLoginSessionToken(null);
    resetBackendProtocolHandshake();
  }
}

export function getLoginSettings(): Promise<LoginSettingsView> {
  return call<LoginSettingsView>("get_login_settings");
}

export function setLoginUserId(userId: string, reauth: Reauth): Promise<LoginSettingsView> {
  return call<LoginSettingsView>("set_login_user_id", { userId, ...reauth });
}

export function setLoginPassword(next: string, reauth: Reauth, userId?: string): Promise<LoginSettingsView> {
  return call<LoginSettingsView>("set_login_password", { next, userId, ...reauth });
}

export function clearLoginPassword(reauth: Reauth): Promise<LoginSettingsView> {
  return call<LoginSettingsView>("clear_login_password", { ...reauth });
}

export function beginLoginOtpSetup(reauth: Reauth): Promise<OtpSetup> {
  return call<OtpSetup>("begin_login_otp_setup", { ...reauth });
}

export function confirmLoginOtpSetup(code: string): Promise<LoginSettingsView> {
  return call<LoginSettingsView>("confirm_login_otp_setup", { code });
}

export function disableLoginOtp(reauth: Reauth): Promise<LoginSettingsView> {
  return call<LoginSettingsView>("disable_login_otp", { ...reauth });
}

export function setLoginChannelRequirement(
  channel: LoginChannel,
  method: LoginMethod,
  enabled: boolean,
): Promise<LoginSettingsView> {
  return call<LoginSettingsView>("set_login_channel_requirement", { channel, method, enabled });
}

export function listLoginSessions(): Promise<LoginSessionView[]> {
  return call<LoginSessionView[]>("list_login_sessions");
}

export function revokeLoginSession(id: string): Promise<{ revoked: boolean }> {
  return call<{ revoked: boolean }>("revoke_login_session", { id });
}

export function revokeAllLoginSessions(keepCurrent: boolean): Promise<{ revokedCount: number }> {
  return call<{ revokedCount: number }>("revoke_all_login_sessions", { keepCurrent });
}
