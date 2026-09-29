import type { ChatAttentionItem, ProjectRegistryEntry, ProviderAccountView, SessionSummary } from "../types";
import { hasTauriRuntime, showNativeNotification } from "./ipc";
import { deviceNotificationsOn, setDeviceNotifications } from "./webNotificationPreference";
import { attentionNotifications, credentialExpiryNotifications, projectNotifications, type DeviceNotification } from "./webNotificationContent";
import { attentionStateKey, freshItems, projectStateKey, snapshotKeys } from "./webNotificationState";
import {
  accountsToNotifyForExpiry,
  credentialExpiryImminent,
  credentialExpiryNoticeKey,
  daysUntilExpiry,
} from "./accountCredentialExpiry";
import { readStoredText, writeStoredText } from "./storedText";
import { runtimeText } from "./i18nRuntime";

/** 알림 센터 polling에서 새 상태를 찾아 현재 클라이언트의 OS 알림으로 표출한다.
 * Tauri는 최소 native command, 원격 웹/PWA는 Service Worker를 사용한다. */

/**
 * 알림 한 건이 나가는 통로. 런타임이 통로를 정하고, 통로가 그 뒤의 모든 갈래 — 표출
 * 방법·설정 확인 여부·권한 개념의 유무 — 를 정한다. `null`은 이 기기로는 내보낼 수
 * 없다는 뜻이다(웹 알림을 못 쓰는 브라우저·비보안 컨텍스트).
 *
 * 런타임 판정을 이 한 곳에만 두는 이유는 갈래가 두 번 갈리기 때문이다. 표출 흐름은
 * "내보낼 수 있는 런타임인가"를 먼저 보고, 기준선을 갱신한 뒤에야 "지금 켜져 있는가"를
 * 본다. 두 물음이 각자 런타임을 다시 판정하면 그 사이에 답이 어긋날 수 있다.
 */
type NotificationChannel = "native" | "web";

function notificationChannel(): NotificationChannel | null {
  if (hasTauriRuntime()) return "native";
  const webSupported = typeof window !== "undefined"
    && window.isSecureContext
    && "Notification" in window
    && "serviceWorker" in navigator;
  return webSupported ? "web" : null;
}

export function webNotificationsSupported(): boolean {
  return notificationChannel() === "web";
}

export function webNotificationsDenied(): boolean {
  return webNotificationsSupported() && Notification.permission === "denied";
}

export function webNotificationsEnabled(): boolean {
  return webNotificationsSupported() && deviceNotificationsOn(Notification.permission);
}

export async function enableWebNotifications(): Promise<boolean> {
  if (!webNotificationsSupported()) return false;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;
  setDeviceNotifications(true);
  // 이 기기·브라우저 컨텍스트에서 실제로 표출되는지 확인시켜 준다. 서비스워커 등록 조회와
  // OS 표출을 거쳐 수백 ms가 걸리므로 기다리지 않는다. 기다리면 버튼 문구가 알림이 뜬
  // 뒤에야 바뀌어, 이미 저장된 설정이 반영되지 않은 것처럼 보인다.
  void deliverNotification({
    title: runtimeText("기기 알림 켜짐", "Device notifications enabled"),
    body: runtimeText("승인 요청과 작업 완료/실패를 이 기기로 알립니다.", "This device will show approvals and task completion or failure."),
    tag: "device-notifications-enabled",
  }, "web");
  return true;
}

export function disableWebNotifications(): void {
  setDeviceNotifications(false);
}

/** polling 사이에 유지되는 기준선. 첫 스냅샷 전에는 `null`이다. */
interface NotificationBaseline {
  seen: Set<string> | null;
}

/**
 * 한 건을 통로에 맞춰 표출한다. Tauri는 최소 native command, 웹은 서비스워커다.
 * 표출 실패는 양쪽 모두 무시한다 — 인앱 알림 센터·감지 모달이 항상 기준이다. 그래서
 * 실패를 삼키는 자리도 통로마다 흩어 두지 않고 이 함수 하나로 둔다.
 */
async function deliverNotification(
  notification: DeviceNotification,
  channel: NotificationChannel,
): Promise<void> {
  const { title, body, tag, open } = notification;
  try {
    if (channel === "native") {
      await showNativeNotification(title, body);
      return;
    }
    // 오른쪽 큰 아이콘 자리는 비울 수 없다 — icon을 생략하면 Chrome이 출처 첫 글자로
    // 회색 모노그램("T")을 만들어 넣는다. 투명 PNG를 줘서 그 자리를 보이지 않게 한다.
    // 왼쪽 헤더의 작은 앱 아이콘은 브라우저가 매니페스트에서 알아서 쓴다.
    // `data`는 서비스워커의 notificationclick이 읽어 어느 대화를 열지 정하는 값이다.
    const options: NotificationOptions = { body, tag, icon: "/notification-blank.png", data: open ?? null };
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) await registration.showNotification(title, options);
    else new Notification(title, options);
  } catch {
    // 표출 실패는 무시한다.
  }
}

/**
 * polling 스냅샷에서 새로 나타난 항목만 골라 OS 알림으로 내보낸다. 알림 종류마다
 * 다른 것은 비교 키(`keyOf`)와 문구(`describeAll`)뿐이라 나머지 흐름 — 통로 결정,
 * 기준선 갱신, 차집합, 설정 확인 — 은 여기 한 번만 둔다.
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
  const channel = notificationChannel();
  if (channel === null) return;
  const previous = baseline.seen;
  baseline.seen = snapshotKeys(items, keyOf);
  if (previous === null) return;
  const fresh = freshItems(items, previous, keyOf);
  if (fresh.length === 0) return;
  // 설정 확인은 기준선을 갱신한 뒤다. 꺼 둔 동안에도 기준선이 따라 올라가야, 나중에
  // 켰을 때 그동안 쌓인 항목이 한꺼번에 쏟아지지 않는다. native는 이 설정을 쓰지 않는다.
  if (channel === "web" && !webNotificationsEnabled()) return;
  for (const notification of describeAll(fresh)) {
    await deliverNotification(notification, channel);
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
  await notifyFreshItems(projectBaseline, pending, projectStateKey, projectNotifications);
}

/**
 * 이미 알린 사슬을 담아 두는 저장 항목. 다른 알림들처럼 프로세스 메모리에만 두면 앱을
 * 다시 열 때마다 기준선이 사라져, 사흘 창 안에 머무는 동안 켤 때마다 같은 만료를 다시
 * 알리거나(기준선을 비우면) 창에 들어온 계정을 영영 놓친다(첫 스냅샷을 기준선으로만
 * 삼으면). 만료 예고는 사슬마다 정확히 한 번이라야 해서 기기에 남긴다.
 */
const EXPIRY_NOTICE_KEY = "agentManager.credentialExpiryNotified";

/**
 * 마지막으로 남긴 기록의 프로세스 사본. 저장소가 막힌 브라우저(쿠키 전면 차단·사파리
 * 프라이빗)에서는 읽기가 늘 `null`이라, 이 사본이 없으면 계정 폴링마다 같은 만료를
 * 다시 알린다. 저장소가 살아 있으면 저장값이 이긴다 — 앱을 다시 연 뒤에도 기억이
 * 이어져야 하는 쪽은 저장소다.
 */
let lastExpiryRecord: string | null = null;

function notifiedExpiryChains(stored: string | null): ReadonlySet<string> {
  if (stored === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((key): key is string => typeof key === "string"));
  } catch {
    // 손상된 값은 아직 아무것도 알리지 않은 것으로 본다. 한 번 더 알리는 쪽이,
    // 만료를 놓치고 실행이 통째로 멈추는 쪽보다 낫다.
    return new Set();
  }
}

/**
 * 인증 만료가 사흘 앞으로 다가온 계정을 기기로 한 번 알린다.
 *
 * 만료 뒤에는 재인증 말고 되살릴 방법이 없으므로, 알림은 창에 들어온 계정을 놓치지
 * 않는 쪽으로 맞춘다 — 다른 알림들과 달리 첫 스냅샷도 그냥 넘기지 않고, 이미 창 안인
 * 계정도 아직 알린 적이 없으면 알린다.
 *
 * 기록은 지금 창 안에 있는 사슬들로 다시 쓴다. 재인증하거나 만료된 사슬의 키는 이때
 * 함께 빠져, 저장 항목이 죽은 키로 불어나지 않는다.
 */
export async function notifyExpiringCredentials(
  accounts: readonly ProviderAccountView[],
): Promise<void> {
  const channel = notificationChannel();
  if (channel === null) return;
  const now = Date.now();
  const seen = readStoredText(EXPIRY_NOTICE_KEY) ?? lastExpiryRecord;
  const record = JSON.stringify(
    accounts
      .filter((account) => credentialExpiryImminent(account, now))
      .map(credentialExpiryNoticeKey),
  );
  // 계정 폴링마다 불리므로 달라졌을 때만 쓴다. 창에 들고 나는 일은 며칠에 한 번이다.
  if (record === seen) return;
  const fresh = accountsToNotifyForExpiry(accounts, notifiedExpiryChains(seen), now)
    .flatMap((account) => (account.credentialExpiresAt === null ? [] : [{
      id: account.id,
      displayName: account.displayName,
      days: daysUntilExpiry(account.credentialExpiresAt, now),
    }]));
  // 기록은 설정 확인보다 먼저 올린다. 꺼 둔 동안에도 따라 올라가야, 나중에 켰을 때
  // 그동안 창에 들어온 계정이 한꺼번에 쏟아지지 않는다.
  lastExpiryRecord = record;
  writeStoredText(EXPIRY_NOTICE_KEY, record);
  if (fresh.length === 0) return;
  if (channel === "web" && !webNotificationsEnabled()) return;
  for (const notification of credentialExpiryNotifications(fresh)) {
    await deliverNotification(notification, channel);
  }
}
