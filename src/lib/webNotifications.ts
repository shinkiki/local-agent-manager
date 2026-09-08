import type { ChatAttentionItem, ProjectRegistryEntry, SessionSummary } from "../types";
import { hasTauriRuntime, showNativeNotification } from "./ipc";
import { deviceNotificationsOn, setDeviceNotifications } from "./webNotificationPreference";
import { attentionNotifications, type DeviceNotification } from "./webNotificationContent";
import { attentionStateKey, freshItems, snapshotKeys } from "./webNotificationState";

/** 알림 센터 polling에서 새 상태를 찾아 현재 클라이언트의 OS 알림으로 표출한다.
 * Tauri는 최소 native command, 원격 웹/PWA는 Service Worker를 사용한다. */

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
  return deviceNotificationsOn(Notification.permission);
}

export async function enableWebNotifications(): Promise<boolean> {
  if (!webNotificationsSupported()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;
  setDeviceNotifications(true);
  // 이 기기·브라우저 컨텍스트에서 실제로 표출되는지 확인시켜 준다. 서비스워커 등록 조회와
  // OS 표출을 거쳐 수백 ms가 걸리므로 기다리지 않는다. 기다리면 버튼 문구가 알림이 뜬
  // 뒤에야 바뀌어, 이미 저장된 설정이 반영되지 않은 것처럼 보인다.
  void showDeviceNotification("기기 알림 켜짐", "승인 요청과 작업 완료/실패를 이 기기로 알립니다.", "device-notifications-enabled");
  return true;
}

export function disableWebNotifications(): void {
  setDeviceNotifications(false);
}

async function showDeviceNotification(title: string, body: string, tag: string): Promise<void> {
  // 오른쪽 큰 아이콘 자리는 비울 수 없다 — icon을 생략하면 Chrome이 출처 첫 글자로
  // 회색 모노그램("T")을 만들어 넣는다. 투명 PNG를 줘서 그 자리를 보이지 않게 한다.
  // 왼쪽 헤더의 작은 앱 아이콘은 브라우저가 매니페스트에서 알아서 쓴다.
  const options: NotificationOptions = { body, tag, icon: "/notification-blank.png" };
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) await registration.showNotification(title, options);
    else new Notification(title, options);
  } catch {
    // 표출 실패는 무시한다. 인앱 알림 센터가 항상 기준이다.
  }
}

/** polling 사이에 유지되는 기준선. 첫 스냅샷 전에는 `null`이다. */
interface NotificationBaseline {
  seen: Set<string> | null;
}

/**
 * 한 건을 현재 런타임으로 표출한다. Tauri는 최소 native command, 웹은 서비스워커다.
 * 표출 실패는 양쪽 모두 무시한다 — 인앱 알림 센터·감지 모달이 항상 기준이다.
 */
async function deliverNotification(
  notification: DeviceNotification,
  nativeRuntime: boolean,
): Promise<void> {
  const { title, body, tag } = notification;
  if (!nativeRuntime) {
    await showDeviceNotification(title, body, tag);
    return;
  }
  try {
    await showNativeNotification(title, body);
  } catch {
    // 표출 실패는 무시한다.
  }
}

/**
 * polling 스냅샷에서 새로 나타난 항목만 골라 OS 알림으로 내보낸다. 알림 종류마다
 * 다른 것은 비교 키(`keyOf`)와 문구(`describeAll`)뿐이라 나머지 흐름 — 런타임 지원
 * 확인, 기준선 갱신, 차집합, 설정 확인 — 은 여기 한 번만 둔다.
 *
 * 문구는 항목 하나씩이 아니라 이번에 새로 나타난 묶음 전체를 받는다. 한 번에 올라온
 * 여러 건을 한 알림으로 접으려면 그 셋을 한자리에서 봐야 하기 때문이다.
 *
 * 첫 스냅샷은 기준선으로만 삼는다. 페이지를 연 시점의 기존 항목을 쏟아내지 않기
 * 위함이다.
 */
async function notifyFreshItems<T>(
  baseline: NotificationBaseline,
  items: T[],
  keyOf: (item: T) => string,
  describeAll: (fresh: T[]) => DeviceNotification[],
): Promise<void> {
  const nativeRuntime = hasTauriRuntime();
  if (!nativeRuntime && !webNotificationsSupported()) return;
  const previous = baseline.seen;
  baseline.seen = snapshotKeys(items, keyOf);
  if (previous === null) return;
  const fresh = freshItems(items, previous, keyOf);
  if (fresh.length === 0) return;
  if (!nativeRuntime && !webNotificationsEnabled()) return;
  for (const notification of describeAll(fresh)) {
    await deliverNotification(notification, nativeRuntime);
  }
}

const attentionBaseline: NotificationBaseline = { seen: null };

export async function notifyNewAttention(
  items: ChatAttentionItem[],
  sessions: SessionSummary[],
): Promise<void> {
  // running -> completed처럼 같은 ID의 상태 전환도 실제 새 알림으로 취급한다.
  await notifyFreshItems(attentionBaseline, items, attentionStateKey, (fresh) =>
    attentionNotifications(fresh, sessions));
}

const projectBaseline: NotificationBaseline = { seen: null };

/**
 * 스냅샷 polling에서 새로 감지된(결정 대기) 프로젝트를 찾아 현재 클라이언트의 OS 알림으로
 * 표출한다. 인앱 감지 모달이 항상 기준이고 이 알림은 보조다.
 */
export async function notifyNewProjects(pending: ProjectRegistryEntry[]): Promise<void> {
  await notifyFreshItems(projectBaseline, pending, (project) => project.path, (fresh) =>
    fresh.map((project) => ({
      title: "새 프로젝트 감지",
      body: `${project.name} · 활성 유지 또는 제외를 정하세요`,
      tag: `new-project:${project.path}`,
    })));
}
