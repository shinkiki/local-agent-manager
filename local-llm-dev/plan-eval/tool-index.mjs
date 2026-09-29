// 계획 턴에 실을 도구 색인. "id + 한 줄 설명" 목록 하나가 전부다.
//
// 스키마는 싣지 않는다 — 계획 턴이 부를 수 있는 도구는 add_step·finish_plan·cannot_do
// 셋뿐이고, 색인은 프롬프트 안의 글이다. 도구 수 민감도(26개→이름 지어냄)는 호출 가능한
// 스키마 수에 걸리는 압력이지 이 목록에 걸리는 것이 아니다. 대신 여기 드는 비용은 맥락이다.

import { readFileSync } from "node:fs";

/// 설명에서 첫 산문 줄만 뽑는다.
///
/// **마크다운 헤딩을 건너뛴다.** 그냥 첫 줄을 잡으면 설명이 `## Overview` 로 시작하는
/// notion-create-pages 와 notion-update-page 가 빈칸으로 나온다 — 하필 가장 많이 쓰는
/// 둘이다(2026-09-26 실측에서 실제로 그렇게 비었다).
export function firstLine(description) {
  for (const raw of String(description ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line.split(/(?<=\.)\s/)[0].trim();
  }
  return "";
}

/// 플러그인별 카탈로그를 하나의 색인으로 접는다.
///
/// 도구 집합이 같은 플러그인은 설명을 한 벌만 적고 어느 플러그인에 있는지만 나열한다.
/// notion-team 과 notion-personal 는 같은 Notion MCP 를 계정만 달리 붙인 것이라 45개가
/// 정확히 겹친다 — 두 번 적으면 9,005자, 접으면 4,410자다.
/// 플러그인 id 에 걸리는 한글 표기. Rust 쪽 `aliases_for_plugin` 과 같은 규칙이다.
const PLUGIN_ALIASES = [["notion", "노션"], ["github", "깃허브"], ["figma", "피그마"],
  ["gmail", "지메일"], ["google", "구글"], ["drive", "드라이브"], ["calendar", "캘린더"],
  ["atlassian", "아틀라시안"], ["jira", "지라"], ["confluence", "컨플루언스"],
  ["slack", "슬랙"], ["vercel", "버셀"]];

function labelFor(plugin) {
  // 별칭 전후를 다시 재려면 NO_ALIAS=1. 2026-09-26 실측(web-to-notion): GPU 20회에서
  // 18/20 대 14/20, 없는 이름 되묻기 1회 대 4회. 합격률 차이만으로는 결정적이지 않고
  // (p≈0.23) 이 과제는 n≤6 에서 3/6 과 6/6 을 오간다 — 별칭을 남기는 근거는 실패
  // 종류다. 별칭 없이는 계획이 노션 자리를 write(파일)나 빈 계획으로 채운다.
  if (process.env.NO_ALIAS) return plugin;
  const lowered = plugin.toLowerCase();
  const hit = PLUGIN_ALIASES.filter(([latin]) => lowered.includes(latin)).map(([, ko]) => ko);
  return hit.length ? `${plugin} · ${hit.join(" · ")}` : plugin;
}

export function buildIndex(catalogs, extras = []) {
  const byName = new Map();
  for (const { plugin, tools } of catalogs) {
    for (const tool of tools) {
      const entry = byName.get(tool.name) ?? { description: firstLine(tool.description), plugins: [] };
      if (entry.plugins.includes(labelFor(plugin))) continue;
      entry.plugins.push(labelFor(plugin));
      byName.set(tool.name, entry);
    }
  }
  const lines = extras.map((tool) => `- ${tool.name}: ${tool.description}`);
  for (const [name, { description, plugins }] of byName) {
    lines.push(`- ${name} (${plugins.join(" | ")}): ${description}`);
  }
  return lines.join("\n");
}

export function loadFixture(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/// 색인에 실제로 들어간 이름 전부. 계획이 고른 이름을 검증할 때 쓴다.
export function indexNames(catalogs, extras = []) {
  const names = extras.map((tool) => tool.name);
  for (const { tools } of catalogs) for (const tool of tools) if (!names.includes(tool.name)) names.push(tool.name);
  return names;
}

/// 배포되는 문자열 상수를 소스에서 그대로 읽는다.
///
/// 베껴 두면 프롬프트를 고칠 때 측정만 옛 문장을 계속 재게 된다 — 재는 대상이 배포본이
/// 아니게 되는 것이 평가셋의 가장 조용한 고장 방식이다(LEG 회차가 같은 자리를 겪었다).
export function readRustConst(name, root = process.cwd(), file = "crates/agent-manager-core/src/opencode_config.rs") {
  const src = readFileSync(`${root}/${file}`, "utf8");
  const head = `const ${name}: &str = "`;
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`${name} 를 ${file} 에서 찾지 못했다`);
  const BS = String.fromCharCode(92);
  const ESC = { n: String.fromCharCode(10), t: String.fromCharCode(9) };
  let out = "";
  for (let i = at + head.length; i < src.length; i++) {
    const ch = src[i];
    if (ch === BS) { const n = src[++i]; out += ESC[n] ?? n; continue; }
    if (ch === '"') return out;
    out += ch;
  }
  throw new Error(`${name} 의 끝따옴표를 찾지 못했다`);
}
