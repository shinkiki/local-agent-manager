import type { UiText } from "./i18n.ts";
import type { LoginChannel, LoginMethod, LoginSettingsView } from "./ipcLogin.ts";

export const CHANNELS: LoginChannel[] = ["desktop", "localBrowser", "remote"];

export function channelLabel(channel: LoginChannel, text: UiText): string {
  switch (channel) {
    case "desktop": return text("데스크톱 앱", "Desktop app");
    case "localBrowser": return text("로컬 브라우저", "Local browser");
    case "remote": return text("원격", "Remote");
  }
}

export function channelHint(channel: LoginChannel, text: UiText): string {
  switch (channel) {
    case "desktop": return text("이 컴퓨터의 Agent Manager 창", "The Agent Manager window on this computer");
    case "localBrowser": return text("같은 컴퓨터의 브라우저로 127.0.0.1에 연 화면", "A browser on this computer opened at 127.0.0.1");
    case "remote": return text("Tailscale을 지나온 원격 브라우저·PWA, 헤드리스 NAS", "Remote browsers and PWAs over Tailscale, headless NAS");
  }
}

export function methodLabel(method: LoginMethod, text: UiText): string {
  return method === "password" ? text("ID/비밀번호", "user ID/password") : "OTP";
}

export function summaryText(settings: LoginSettingsView, text: UiText): string {
  const required = CHANNELS.filter((channel) => settings.channels[channel].password || settings.channels[channel].otp);
  if (required.length === 0) return text("모든 채널이 로그인 없이 열립니다", "Every channel opens without a sign-in");
  return `${text("로그인 요구", "Sign-in required")}: ${required.map((channel) => channelLabel(channel, text)).join(" · ")}`;
}

export function validatePasswordDraft(next: string, again: string, text: UiText): string | null {
  if (next !== again) {
    return text("새 비밀번호 두 칸이 다릅니다.", "The two new password fields differ.");
  }
  if (next.length < 8) {
    return text("비밀번호는 8자 이상이어야 합니다.", "A password needs at least 8 characters.");
  }
  return null;
}
