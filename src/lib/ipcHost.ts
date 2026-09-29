/**
 * 데스크톱 셸·원격 접근·전원 관련 IPC 명령 묶음.
 *
 * `ipc.ts` 중간에 흩어져 있던 네이티브 셸 호출(알림·재시작·로그인 시작), Tailscale 원격
 * 접근, 자동 절전 억제를 한 모듈로 모은다. 모두 호스트 화면에서만 의미가 있는 명령이고
 * `SettingsView`가 한 덩어리로 쓰는 면이라, `ipcUsageBudget` 등 다른 `ipc*` 모듈과 같은
 * 방식으로 갈라 `ipc.ts`의 책임을 줄인다.
 */
import type { BackgroundSettings } from "../types";
import type { AppLocale } from "../types";
import { hasNativeShell } from "./backend";
import { call, nativeCall } from "./ipcTransport";

export function hasTauriRuntime(): boolean {
  return hasNativeShell();
}

export function showNativeNotification(title: string, body: string): Promise<void> {
  return nativeCall<void>("show_native_notification", { title, body });
}

export function setTrayLocale(locale: AppLocale): Promise<void> {
  if (!hasNativeShell()) return Promise.resolve();
  return nativeCall<void>("set_tray_locale", { locale });
}

/// 데스크톱 셸을 재시작해 저장된 서비스 포트를 실제 수신 포트로 만든다.
/// 프로세스가 그대로 종료되므로 이 호출은 정상 경로에서 resolve되지 않는다.
export function restartApp(): Promise<void> {
  return nativeCall<void>("restart_app");
}

/**
 * 셸이 보낸 `quit-requested`에 답한다. 끊길 작업이 있어 확인 창을 띄웠으면 `prompting`을
 * 먼저 보내 셸의 폴백 종료를 멈추고, 사용자의 선택을 `quit`·`cancel`로 보낸다.
 * `quit`은 프로세스를 종료시키므로 정상 경로에서 resolve되지 않는다.
 */
export function respondToQuit(decision: "prompting" | "quit" | "cancel"): Promise<void> {
  if (!hasNativeShell()) return Promise.resolve();
  return nativeCall<void>("respond_to_quit", { decision });
}

export function getBackgroundSettings(): Promise<BackgroundSettings> {
  return nativeCall<BackgroundSettings>("get_background_settings");
}

export function setBackgroundSettings(loginStart: boolean): Promise<BackgroundSettings> {
  return nativeCall<BackgroundSettings>("set_background_settings", { loginStart });
}

export interface TailscaleServiceStatus {
  available: boolean;
  enabled: boolean;
  host: string | null;
  login: string | null;
  url: string | null;
  servicePort: number;
  serveTarget: string | null;
  conflictTarget: string | null;
  remoteAccepted: boolean;
  remoteWrite: boolean;
  error: string | null;
}

export function getTailscaleServiceStatus(): Promise<TailscaleServiceStatus> {
  return call<TailscaleServiceStatus>("get_tailscale_service_status");
}

export function setTailscaleServiceEnabled(
  enabled: boolean,
  replaceExisting = false,
): Promise<TailscaleServiceStatus> {
  return call<TailscaleServiceStatus>("set_tailscale_service_enabled", { enabled, replaceExisting });
}

/**
 * 원격 UI에 데스크톱과 같은 변경 권한을 줄지 바꿉니다. 저장 지점은 백엔드 서비스
 * 설정 하나이고 실행 중인 백엔드에 바로 반영되며, 호스트 화면에서만 호출할 수 있습니다.
 */
export function setRemoteWriteEnabled(enabled: boolean): Promise<TailscaleServiceStatus> {
  return call<TailscaleServiceStatus>("set_remote_write_enabled", { enabled });
}

/** 호스트 자동 절전 억제 상태. 억제 수단은 OS마다 다르므로 어떤 수단인지 함께 알린다. */
export interface SleepPreventionStatus {
  /** 이 호스트에서 억제 수단을 쓸 수 있는지. */
  supported: boolean;
  /** 저장된 설정값. */
  enabled: boolean;
  /** 지금 실제로 걸려 있는지. 설정이 켜져 있어도 수단이 없으면 거짓이다. */
  active: boolean;
  /** `caffeinate`, `systemd-inhibit`, `SetThreadExecutionState` 중 하나. */
  mechanism: string | null;
  error: string | null;
}

export function getSleepPrevention(): Promise<SleepPreventionStatus> {
  return call<SleepPreventionStatus>("get_sleep_prevention");
}

export function setSleepPrevention(enabled: boolean): Promise<SleepPreventionStatus> {
  return call<SleepPreventionStatus>("set_sleep_prevention", { enabled });
}
