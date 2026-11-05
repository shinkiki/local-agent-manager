import test from "node:test";
import assert from "node:assert/strict";
import { availableRecordTargets } from "./aiaOnboardingRecordTargets.ts";

const plugin = (overrides = {}) => ({
  id: "example-plugin", displayName: "Example", url: null, attachable: true, ...overrides,
});
const ids = (plugins) => availableRecordTargets(plugins).map(({ id }) => id);

test("V2/V4: 플러그인이 없거나 관계없어도 마크다운은 항상 선택할 수 있다", () => {
  assert.deepEqual(ids([]), ["markdown"]);
  assert.deepEqual(ids([plugin()]), ["markdown"]);
});

test("V2/V4: 연결할 수 없는 플러그인은 이름과 주소가 일치해도 대상을 늘리지 않는다", () => {
  assert.deepEqual(ids([
    plugin({ id: "notion", attachable: false }),
    plugin({ displayName: "JIRA", url: "https://atlassian.example", attachable: false }),
  ]), ["markdown"]);
  assert.deepEqual(ids([
    plugin({ id: "notion", attachable: false }),
    plugin({ id: "jira" }),
  ]), ["markdown", "jira"]);
});

test("V2/V4: 식별자·표시 이름·주소를 대소문자와 무관하게 모두 검색한다", () => {
  for (const [needle, expected] of [["NoTiOn", "notion"], ["JiRa", "jira"], ["AtLaSsIaN", "jira"]]) {
    for (const key of ["id", "displayName", "url"]) {
      assert.deepEqual(ids([plugin({ [key]: `prefix-${needle}-suffix` })]), ["markdown", expected], `${needle}/${key}`);
    }
  }
});

test("V2/V4: 서버의 연결 가능 판정을 사용하며 빈 주소도 안전하게 처리한다", () => {
  assert.deepEqual(ids([plugin({ id: "notion", url: null, enabled: false, credentialReady: false })]), ["markdown", "notion"]);
  assert.deepEqual(ids([plugin({ displayName: "jira", url: "" })]), ["markdown", "jira"]);
});

test("V2/V4: 여러 플러그인이 일치해도 대상은 고정 순서로 한 번씩만 나타난다", () => {
  const plugins = [plugin({ id: "jira" }), plugin({ id: "atlassian" }), plugin({ id: "notion-jira" }), plugin({ id: "notion" })];
  const targets = availableRecordTargets(plugins);
  assert.deepEqual(targets, [
    { id: "markdown", ko: "마크다운 문서(.md)", en: "Markdown documents (.md)", needles: [] },
    { id: "notion", ko: "노션", en: "Notion", needles: ["notion"] },
    { id: "jira", ko: "지라", en: "Jira", needles: ["jira", "atlassian"] },
  ]);
  assert.deepEqual(ids([...plugins].reverse()), ["markdown", "notion", "jira"]);
});

test("V2/V4: 입력을 바꾸지 않고 호출마다 별도 선택 목록을 만든다", () => {
  const plugins = Object.freeze([Object.freeze(plugin({ id: "notion" }))]);
  const before = structuredClone(plugins);
  const first = availableRecordTargets(plugins);
  first.pop();
  assert.deepEqual(plugins, before);
  assert.deepEqual(ids(plugins), ["markdown", "notion"]);
});
