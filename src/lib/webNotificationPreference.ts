/**
 * 기기 알림을 켤지 정하는 설정. 저장 키와 읽기·쓰기·판정을 이 모듈이 모두 가져,
 * 표출 쪽(`webNotifications.ts`)은 설정이 어디에 어떤 이름으로 남는지 몰라도 되게 한다.
 * 키를 아는 자리가 둘이면 한쪽만 이름을 바꿔도 저장한 설정이 조용히 사라진다.
 *
 * 저장소 접근은 막힐 수 있다는 전제로만 한다. 쿠키를 전면 차단한 브라우저는
 * `window.localStorage`를 읽는 것만으로 SecurityError를 던지는데, 이 읽기는 상단바가
 * 마운트될 때 지연 초기값으로 불리므로 감싸지 않으면 앱 셸이 통째로 오류 경계로 떨어진다.
 * 읽기는 저장값 없음(null)으로, 쓰기는 무동작으로 떨어져 현재 실행 중의 선택만 남는다 —
 * 저장소를 다루는 다른 모듈(`navigationPreferences`, `theme`, App의 `localStore`)과 같은 모양이다.
 */

const PREFERENCE_KEY = "agentManager.deviceNotifications";

export function deviceNotificationsEnabled(
  preference: string | null,
  permission: NotificationPermission,
): boolean {
  if (permission === "denied" || preference === "off") return false;
  return preference === "on" || permission === "granted";
}

/** 저장된 설정 원문. 저장소가 막혀 있으면 저장값이 없는 것과 같이 본다. */
function storedPreference(): string | null {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY);
  } catch {
    return null;
  }
}

/**
 * 저장된 설정과 브라우저 권한으로 지금 이 기기의 알림이 켜져 있는지.
 *
 * 저장값이 유실돼도 브라우저 권한이 이미 허용되어 있으면 켜진 상태를 복원한다.
 * 반대로 iOS PWA가 허용 권한을 "default"로 보고하는 경우에는 저장값을 사용한다.
 */
export function deviceNotificationsOn(permission: NotificationPermission): boolean {
  return deviceNotificationsEnabled(storedPreference(), permission);
}

export function setDeviceNotifications(enabled: boolean): void {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, enabled ? "on" : "off");
  } catch {
    // 저장소가 막혀도 이번 실행의 켜기·끄기는 브라우저 권한 상태로 그대로 동작한다.
  }
}
