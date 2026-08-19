export function deviceNotificationsEnabled(
  preference: string | null,
  permission: NotificationPermission,
): boolean {
  if (permission === "denied" || preference === "off") return false;
  return preference === "on" || permission === "granted";
}
