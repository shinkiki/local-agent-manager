import assert from "node:assert/strict";
import test from "node:test";
import {
  accountsToNotifyForExpiry,
  credentialExpiryImminent,
  credentialExpiryNoticeKey,
  daysUntilExpiry,
  CREDENTIAL_EXPIRY_NOTICE_MS,
} from "./accountCredentialExpiry.ts";

const NOW = 1_800_000_000_000;
const account = (id, credentialExpiresAt) => ({ id, displayName: id, credentialExpiresAt });

test("the notice opens exactly three days before expiry", () => {
  assert.equal(
    credentialExpiryImminent(account("a", NOW + CREDENTIAL_EXPIRY_NOTICE_MS), NOW),
    true,
  );
  assert.equal(
    credentialExpiryImminent(account("a", NOW + CREDENTIAL_EXPIRY_NOTICE_MS + 1), NOW),
    false,
  );
});

test("an already expired chain is not a warning", () => {
  // 지난 일은 예고가 아니다 — 계정 카드의 재인증 필요 배지가 그 상태를 말한다.
  assert.equal(credentialExpiryImminent(account("a", NOW), NOW), false);
  assert.equal(credentialExpiryImminent(account("a", NOW - 1), NOW), false);
});

test("an unknown expiry stays silent", () => {
  assert.equal(credentialExpiryImminent(account("a", null), NOW), false);
});

test("a chain is announced once and re-arms only when re-authentication moves the expiry", () => {
  const soon = account("claude-a", NOW + 86_400_000);
  const notified = new Set();

  assert.deepEqual(accountsToNotifyForExpiry([soon], notified, NOW), [soon]);

  notified.add(credentialExpiryNoticeKey(soon));
  assert.deepEqual(accountsToNotifyForExpiry([soon], notified, NOW), []);

  // 재인증으로 새 사슬이 잡히면 그 사슬의 만료는 다시 알린다.
  const renewed = account("claude-a", NOW + 86_400_000 * 2);
  assert.deepEqual(accountsToNotifyForExpiry([renewed], notified, NOW), [renewed]);
});

test("remaining days round up and never read as zero", () => {
  assert.equal(daysUntilExpiry(NOW + 86_400_000 * 3, NOW), 3);
  assert.equal(daysUntilExpiry(NOW + 86_400_000 * 2 + 1, NOW), 3);
  assert.equal(daysUntilExpiry(NOW + 60_000, NOW), 1);
});
