#!/usr/bin/env node
// 외부 서비스 표식을 iconify `logos` 팩에서 뽑아 `src/assets/serviceIcons.ts`로 굽는다.
//
// 팩 전체(7.6MB · 아이콘 2,174개)를 화면 묶음에 실을 수는 없다. 브랜드 표식은 설정 화면이
// 처음 뜰 때 바로 필요하므로 지연 로딩도 답이 아니다(그 한 번에 gzip 2.8MB를 받는다).
// 그래서 실제로 쓰는 이름만 데이터 URI로 인라인한다 — lucide가 아이콘 하나씩 트리셰이킹으로
// 남기는 것과 같은 결과이고, 런타임 비용이 0이다.
//
// mermaid 다이어그램 쪽은 반대로 팩 전체를 그대로 등록한다(`mermaidEngine.ts`). 그쪽은
// 다이어그램이 아이콘을 실제로 쓸 때만 청크를 받으므로 전체를 담아도 시작 비용이 없다.
//
//   node scripts/generate-service-icons.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "node_modules", "@iconify-json", "logos", "icons.json");
const OUTPUT = path.join(ROOT, "src", "assets", "serviceIcons.ts");

/**
 * 화면의 표식 이름 → 팩 아이콘 이름. 이름은 백엔드가 내려주는 프리셋의 `id` 또는 `brand`
 * 값과 같다(`external_plugins.rs`). 화면은 **서비스(id)를 먼저 찾고 없으면 브랜드(brand)로**
 * 떨어지므로, 서비스마다 다른 로고가 있으면 여기 id로 적고 없으면 브랜드만 남긴다.
 *
 * 구글 서비스 넷(Gmail·드라이브·캘린더·문서)이 `brand: "google"` 하나를 공유해 모두 같은
 * 구글 로고로 보였다. 서비스 로고가 있는 셋은 각자 아이콘을 받고, 팩에 없는 구글 문서만
 * 구글 로고로 떨어진다.
 *
 * 프리셋이 아니라 앱이 스스로 붙이는 도구(애드온 탭의 Claude Code·Cypress·Mermaid)도 같은
 * 표식을 쓴다. 그 이름은 백엔드에서 오지 않으므로 화면이 직접 고른 키다.
 *
 * 단색 글리프로 그려진 표식(`model-context-protocol-icon` 등)은 여기서 굽지 않는다. 데이터
 * URI를 `<img>`로 그리므로 `currentColor`가 닿지 않아 다크 테마에서 검게 사라진다.
 *
 * 워드마크가 아니라 정사각에 가까운 표식을 고른다 — 16~24px 자리에 들어가므로 가로로 긴
 * 워드마크는 글자가 뭉개진다.
 */
const SERVICE_ICONS = {
  // 서비스별(프리셋 id)
  gmail: "google-gmail",
  "google-drive": "google-drive",
  "google-calendar": "google-calendar",
  jira: "jira",
  // 브랜드(프리셋 brand). 서비스 로고가 없는 자리가 여기로 떨어진다.
  notion: "notion-icon",
  google: "google-icon",
  atlassian: "atlassian",
  github: "github-icon",
  figma: "figma",
  // 앱이 붙이는 도구(애드온 탭·카드 머리). 프리셋에서 오지 않는 이름이다.
  claude: "claude-icon",
  cypress: "cypress-icon",
  mermaid: "mermaid",
  // CLI 공급자. 대시보드 공급자 줄과 계정 도구 배지가 쓴다.
  openai: "openai-icon",
  antigravity: "antigravity",
  // 계정 도구 배지의 알려진 서비스(`src/lib/accountTools.ts`). 팩에 표식이 없는 서비스는
  // 여기 없고, 화면이 성격을 나타내는 lucide 아이콘으로 떨어뜨린다.
  airtable: "airtable",
  asana: "asana-icon",
  box: "box",
  chrome: "chrome",
  cloudflare: "cloudflare-icon",
  confluence: "confluence",
  dropbox: "dropbox",
  gitlab: "gitlab-icon",
  linear: "linear-icon",
  playwright: "playwright",
  postgres: "postgresql",
  sentry: "sentry-icon",
  slack: "slack-icon",
  sqlite: "sqlite",
  stripe: "stripe",
  supabase: "supabase-icon",
  vercel: "vercel-icon",
};

/**
 * 글리프가 어두운 색뿐인 표식. 다크 테마 배경에서 그대로 그리면 사라지므로 화면이 흰 받침을
 * 깔아 준다(`.brand-mark.plate`). 표식마다 색을 뜯어 판정하는 대신 손으로 적는다 — 어느 쪽이
 * 받침이 필요한지는 실제 배경색을 보고 정하는 판단이지 파일에서 읽히는 사실이 아니다.
 */
const PLATE_ICONS = new Set(["github", "openai", "vercel", "linear", "sentry"]);

function dataUri(icon, pack) {
  const width = icon.width ?? pack.width ?? 16;
  const height = icon.height ?? pack.height ?? 16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${icon.body}</svg>`;
  // base64보다 퍼센트 인코딩이 짧고, 생성 결과를 사람이 읽을 수 있다.
  return `data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}`;
}

function main() {
  if (!fs.existsSync(PACK)) {
    console.error(`[service-icons] 아이콘 팩이 없습니다: ${PACK}\n  npm i 로 의존성을 먼저 설치하세요.`);
    process.exit(1);
  }
  const pack = JSON.parse(fs.readFileSync(PACK, "utf8"));
  const packVersion = JSON.parse(
    fs.readFileSync(path.join(path.dirname(PACK), "package.json"), "utf8"),
  ).version;
  const entries = [];
  for (const [key, iconName] of Object.entries(SERVICE_ICONS)) {
    const icon = pack.icons[iconName];
    if (!icon) {
      console.error(`[service-icons] 팩에 ${iconName} 아이콘이 없습니다.`);
      process.exit(1);
    }
    entries.push([key, iconName, dataUri(icon, pack)]);
  }

  const unknownPlate = [...PLATE_ICONS].filter((key) => !(key in SERVICE_ICONS));
  if (unknownPlate.length > 0) {
    console.error(`[service-icons] 받침 목록에 없는 표식이 있습니다: ${unknownPlate.join(", ")}`);
    process.exit(1);
  }

  const lines = [
    "/**",
    " * 외부 서비스 표식. `npm run icons:generate`로 다시 만듭니다. 직접 편집하지 마십시오.",
    " *",
    ` * 출처: @iconify-json/logos ${packVersion}`,
    " * 라이선스: 각 상표는 해당 소유자의 것이며, 팩 자체 고지는 THIRD-PARTY-NOTICES.md에 있습니다.",
    " */",
    "",
    "export type ServiceIconName = " + entries.map(([key]) => `"${key}"`).join(" | ") + ";",
    "",
    "export const SERVICE_ICON_SRC: Record<ServiceIconName, string> = {",
    ...entries.map(([key, iconName, uri]) => `  // logos:${iconName}\n  ${JSON.stringify(key)}: "${uri}",`),
    "};",
    "",
    "/** 어두운 글리프라 다크 배경에서 흰 받침이 필요한 표식. */",
    "export const SERVICE_ICONS_NEEDING_PLATE: ReadonlySet<ServiceIconName> = new Set(["
      + entries.filter(([key]) => PLATE_ICONS.has(key)).map(([key]) => `"${key}"`).join(", ")
      + "]);",
    "",
  ];
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, lines.join("\n"));
  const bytes = fs.statSync(OUTPUT).size;
  console.error(`[service-icons] ${OUTPUT} 생성: ${entries.length}종, ${bytes} bytes`);
}

main();
