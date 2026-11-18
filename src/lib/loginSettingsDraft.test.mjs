import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANNELS,
  channelHint,
  channelLabel,
  methodLabel,
  summaryText,
  validatePasswordDraft,
} from "./loginSettingsDraft.ts";

const dummyText = (ko, _en) => ko;
const enText = (_ko, en) => en;

test("C20 채널 목록과 라벨 및 설명은 지원하는 세 접근 채널을 포괄한다", () => {
  assert.deepEqual(CHANNELS, ["desktop", "localBrowser", "remote"]);
  assert.equal(channelLabel("desktop", dummyText), "데스크톱 앱");
  assert.equal(channelLabel("localBrowser", dummyText), "로컬 브라우저");
  assert.equal(channelLabel("remote", dummyText), "원격");

  assert.equal(channelLabel("desktop", enText), "Desktop app");
  assert.equal(channelLabel("localBrowser", enText), "Local browser");
  assert.equal(channelLabel("remote", enText), "Remote");

  assert.match(channelHint("desktop", dummyText), /Agent Manager 창/);
  assert.match(channelHint("localBrowser", dummyText), /127\.0\.0\.1/);
  assert.match(channelHint("remote", dummyText), /Tailscale/);
});

test("C20 로그인 방식 라벨은 비밀번호와 OTP를 올바르게 표시한다", () => {
  assert.equal(methodLabel("password", dummyText), "ID/비밀번호");
  assert.equal(methodLabel("otp", dummyText), "OTP");
  assert.equal(methodLabel("password", enText), "user ID/password");
  assert.equal(methodLabel("otp", enText), "OTP");
});

test("C20 요약 문구는 요구 채널이 없을 때와 있을 때를 구분한다", () => {
  const emptySettings = {
    userId: "test",
    passwordConfigured: false,
    otpConfigured: false,
    otpSecretStorage: null,
    channels: {
      desktop: { password: false, otp: false },
      localBrowser: { password: false, otp: false },
      remote: { password: false, otp: false },
    },
  };
  assert.equal(summaryText(emptySettings, dummyText), "모든 채널이 로그인 없이 열립니다");
  assert.equal(summaryText(emptySettings, enText), "Every channel opens without a sign-in");

  const remoteSettings = {
    ...emptySettings,
    channels: {
      ...emptySettings.channels,
      remote: { password: true, otp: false },
    },
  };
  assert.equal(summaryText(remoteSettings, dummyText), "로그인 요구: 원격");
  assert.equal(summaryText(remoteSettings, enText), "Sign-in required: Remote");

  const multiSettings = {
    ...emptySettings,
    channels: {
      desktop: { password: true, otp: true },
      localBrowser: { password: false, otp: false },
      remote: { password: false, otp: true },
    },
  };
  assert.equal(summaryText(multiSettings, dummyText), "로그인 요구: 데스크톱 앱 · 원격");
  assert.equal(summaryText(multiSettings, enText), "Sign-in required: Desktop app · Remote");
});

test("C20 새 비밀번호 입력 검증은 일치 여부와 8자 이상 제한을 확인한다", () => {
  assert.equal(validatePasswordDraft("secret123", "different", dummyText), "새 비밀번호 두 칸이 다릅니다.");
  assert.equal(validatePasswordDraft("short", "short", dummyText), "비밀번호는 8자 이상이어야 합니다.");
  assert.equal(validatePasswordDraft("validPassword123", "validPassword123", dummyText), null);
  assert.equal(validatePasswordDraft("secret123", "different", enText), "The two new password fields differ.");
  assert.equal(validatePasswordDraft("short", "short", enText), "A password needs at least 8 characters.");
  assert.equal(validatePasswordDraft("validPassword123", "validPassword123", enText), null);
});
