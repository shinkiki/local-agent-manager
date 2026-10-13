import assert from "node:assert/strict";
import test from "node:test";
import {
  TerminalHintCollector,
  extractTerminalHints,
  hasTerminalHints,
  hintLinkLabel,
  sameTerminalHints,
  stripAnsi,
} from "./terminalHints.ts";

const encoder = new TextEncoder();

// 2026-10-10 NAS 원격 로그인 실측 모양. Codex는 색 이스케이프로 주소와 코드를 감싼다.
const CODEX_OUTPUT = [
  "Follow these steps to sign in with ChatGPT using device code authorization:\r\n",
  "1. Open this link in your browser and sign in to your account\r\n",
  "   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n",
  "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n",
  "   \x1b[94mAB12-CD3E4\x1b[0m\r\n",
].join("");

test("strips colour escapes and carriage returns", () => {
  assert.equal(stripAnsi("\x1b[94mhttps://a.example\x1b[0m\r\n"), "https://a.example\n");
});

test("finds the login address and the one-time code in codex output", () => {
  assert.deepEqual(extractTerminalHints(CODEX_OUTPUT), {
    links: ["https://auth.openai.com/codex/device"],
    codes: ["AB12-CD3E4"],
  });
});

test("keeps a long OAuth address whole even though xterm would wrap it", () => {
  const long = "https://accounts.google.com/o/oauth2/v2/auth?client_id=1234567890-abc.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A51000%2Foauth2callback&scope=openid+email&state=6NDbcU86ZU4hpX3wPX0ihA";
  const hints = extractTerminalHints(`Open this URL:\r\n${long}\r\n`);
  assert.deepEqual(hints.links, [long]);
  assert.deepEqual(hints.codes, [], "주소 안의 조각을 코드로 오인하지 않는다");
});

test("drops trailing punctuation that the sentence, not the address, owns", () => {
  assert.deepEqual(extractTerminalHints("Visit https://example.com/login).").links, ["https://example.com/login"]);
});

test("newest hints come first and duplicates collapse", () => {
  const hints = extractTerminalHints("https://a.example\nhttps://b.example\nhttps://a.example\nAAAA-BBBB1\nAAAA-BBBB1\nCCCC-DDDD2");
  assert.deepEqual(hints.links, ["https://a.example", "https://b.example"]);
  assert.deepEqual(hints.codes, ["CCCC-DDDD2", "AAAA-BBBB1"]);
});

test("ignores non-http schemes and lower-case words that look like codes", () => {
  const hints = extractTerminalHints("file:///etc/passwd javascript:alert(1) abcd-efghi ABCD-EFGH");
  assert.deepEqual(hints, { links: [], codes: [] });
});

test("the collector joins an address split across two pty chunks", () => {
  const collector = new TerminalHintCollector();
  // 조각 경계는 알 수 없으므로 반쪽도 일단 주소다. 다음 조각이 오면 온전한 주소가 그 자리를 대신한다.
  assert.deepEqual(collector.push(encoder.encode("Open https://auth.exam"))?.links, ["https://auth.exam"]);
  const hints = collector.push(encoder.encode("ple.com/device?x=1\r\n"));
  assert.deepEqual(hints?.links, ["https://auth.example.com/device?x=1"], "반쪽은 남지 않는다");
  assert.equal(collector.push(encoder.encode("more text\r\n")), null, "힌트가 그대로면 알리지 않는다");
  collector.reset();
  assert.equal(collector.push(encoder.encode("plain\r\n")), null);
});

test("the collector keeps multibyte characters intact across chunk boundaries", () => {
  const bytes = encoder.encode("코드 https://x.example/한 ");
  const collector = new TerminalHintCollector();
  collector.push(bytes.slice(0, 5));
  const hints = collector.push(bytes.slice(5));
  assert.deepEqual(hints?.links, ["https://x.example/한"]);
});

test("equality and emptiness helpers", () => {
  assert.ok(sameTerminalHints(null, null));
  assert.ok(!sameTerminalHints(null, { links: [], codes: [] }));
  assert.ok(sameTerminalHints({ links: ["a"], codes: [] }, { links: ["a"], codes: [] }));
  assert.ok(!hasTerminalHints({ links: [], codes: [] }));
  assert.ok(hasTerminalHints({ links: [], codes: ["AAAA-BBBB1"] }));
});

test("link labels show host and path only", () => {
  assert.equal(hintLinkLabel("https://auth.openai.com/codex/device?x=1"), "auth.openai.com/codex/device");
  assert.equal(hintLinkLabel("https://example.com"), "example.com");
});
