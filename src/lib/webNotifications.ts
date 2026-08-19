import type { AccountSnapshot, ChatAttentionItem, ProviderId, SessionSummary } from "../types";
import { hasTauriRuntime, showNativeNotification } from "./ipc";
import { deviceNotificationsEnabled } from "./webNotificationPreference";
import { attentionNotificationDetail } from "./webNotificationContent";
import { attentionStateKeys, freshAttentionStates } from "./webNotificationState";

/** 알림 센터 polling에서 새 상태를 찾아 현재 클라이언트의 OS 알림으로 표출한다.
 * Tauri는 최소 native command, 원격 웹/PWA는 Service Worker를 사용한다. */

const PREFERENCE_KEY = "agentManager.deviceNotifications";

const KIND_LABELS: Partial<Record<ChatAttentionItem["kind"], string>> = {
  approval: "승인 필요",
  completed: "작업 완료",
  failed: "작업 실패",
};

export function webNotificationsSupported(): boolean {
  return (
    !hasTauriRuntime() &&
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator
  );
}

export function webNotificationsDenied(): boolean {
  return webNotificationsSupported() && Notification.permission === "denied";
}

export function webNotificationsEnabled(): boolean {
  if (!webNotificationsSupported()) return false;
  // 저장값이 유실돼도 브라우저 권한이 이미 허용되어 있으면 켜진 상태를 복원한다.
  // 반대로 iOS PWA가 허용 권한을 "default"로 보고하는 경우에는 저장값을 사용한다.
  return deviceNotificationsEnabled(
    window.localStorage.getItem(PREFERENCE_KEY),
    Notification.permission,
  );
}

export async function enableWebNotifications(): Promise<boolean> {
  if (!webNotificationsSupported()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;
  window.localStorage.setItem(PREFERENCE_KEY, "on");
  // 이 기기·브라우저 컨텍스트에서 실제로 표출되는지 즉시 확인시켜 준다.
  await showDeviceNotification("기기 알림 켜짐", "승인 요청과 작업 완료/실패를 이 기기로 알립니다.", "device-notifications-enabled");
  return true;
}

export function disableWebNotifications(): void {
  window.localStorage.setItem(PREFERENCE_KEY, "off");
}

async function showDeviceNotification(title: string, body: string, tag: string): Promise<void> {
  const options: NotificationOptions = { body, tag, icon: "/pwa-192.png" };
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) await registration.showNotification(title, options);
    else new Notification(title, options);
  } catch {
    // 표출 실패는 무시한다. 인앱 알림 센터가 항상 기준이다.
  }
}

let seenStates: Set<string> | null = null;

export async function notifyNewAttention(
  items: ChatAttentionItem[],
  sessions: SessionSummary[],
): Promise<void> {
  const nativeRuntime = hasTauriRuntime();
  if (!nativeRuntime && !webNotificationsSupported()) return;
  // 첫 스냅샷은 기준선으로만 삼는다. 페이지를 연 시점의 기존 알림을 쏟아내지 않기 위함.
  const previous = seenStates;
  seenStates = attentionStateKeys(items);
  if (previous === null) return;
  // running -> completed처럼 같은 ID의 상태 전환도 실제 새 알림으로 취급한다.
  const fresh = freshAttentionStates(items, previous);
  if (fresh.length === 0) return;
  if (!nativeRuntime && !webNotificationsEnabled()) return;
  for (const item of fresh) {
    const label = KIND_LABELS[item.kind];
    if (!label) continue;
    const detail = attentionNotificationDetail(item, sessions);
    if (nativeRuntime) {
      try {
        await showNativeNotification(label, detail);
      } catch {
        // 표출 실패는 무시한다. 인앱 알림 센터가 항상 기준이다.
      }
    } else {
      await showDeviceNotification(label, detail, item.id);
    }
  }
}

const providerLabel = (provider: ProviderId) => (provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : provider);

let seenAutoSwitchAts: Map<ProviderId, number> | null = null;

/** 계정 스냅샷 polling에서 새 자동전환 이력을 찾아 현재 클라이언트의 OS 알림으로 표출한다. */
export async function notifyAutoSwitchEvents(snapshot: AccountSnapshot): Promise<void> {
  const nativeRuntime = hasTauriRuntime();
  if (!nativeRuntime && !webNotificationsSupported()) return;
  const previous = seenAutoSwitchAts;
  const current = new Map<ProviderId, number>();
  for (const provider of snapshot.providers) {
    if (provider.lastAutoSwitch) current.set(provider.provider, provider.lastAutoSwitch.at);
  }
  seenAutoSwitchAts = current;
  // 첫 스냅샷은 기준선으로만 삼는다. 앱을 연 시점의 과거 전환 이력을 알리지 않기 위함.
  if (previous === null) return;
  if (!nativeRuntime && !webNotificationsEnabled()) return;
  for (const provider of snapshot.providers) {
    const event = provider.lastAutoSwitch;
    if (!event || previous.get(provider.provider) === event.at) continue;
    const name = (id: string) => snapshot.accounts.find((account) => account.id === id)?.displayName ?? id;
    const reason = event.reason === "usageExhausted" ? "사용량 100% 도달" : "에이전트 제한 응답";
    const resumedNote = event.resumedSessionCount > 0 ? ` · 세션 ${event.resumedSessionCount}개 복원` : "";
    const body = `${providerLabel(provider.provider)}: ${name(event.fromAccountId)} → ${name(event.toAccountId)} · ${reason}${resumedNote}`;
    if (nativeRuntime) {
      try {
        await showNativeNotification("계정 자동전환", body);
      } catch {
        // 표출 실패는 무시한다. 설정 화면의 전환 이력이 항상 기준이다.
      }
    } else {
      await showDeviceNotification("계정 자동전환", body, `auto-switch-${provider.provider}`);
    }
  }
}
