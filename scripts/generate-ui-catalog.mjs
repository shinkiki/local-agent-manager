#!/usr/bin/env node

/**
 * 소스의 `text(ko, en)` 짝을 빌드 시점에 거둬 `src/lib/i18nGeneratedUiCatalog.ts`로 낸다.
 *
 * 런타임 등록표는 그 화면이 한 번이라도 렌더돼야 채워진다. 그래서 앱을 켜자마자 제3언어로
 * 바꾸면 그때 열려 있지 않던 화면의 문구가 카탈로그에 실리지 않았고, 백엔드는 요청마다
 * `ui_messages`를 비우므로 나중에 채워지지도 않았다. 생성 파일을 정본으로 두면 방문 여부와
 * 무관하게 같은 카탈로그가 나간다.
 *
 * `--check`는 생성 파일이 소스와 어긋났는지만 보고 종료 코드로 알린다(검증 사다리용).
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { collectTextPairs } from "./check-i18n-static-ui.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT = path.join(ROOT, "src/lib/i18nGeneratedUiCatalog.ts");

function render(pairs) {
  const entries = [...pairs].map(([ko, en]) => `  ${JSON.stringify(ko)}: ${JSON.stringify(en)},`).join("\n");
  return `/**
 * 생성 파일 — 직접 고치지 않는다. \`npm run i18n:catalog\`가 소스의 \`text(ko, en)\` 짝을
 * 거둬 다시 쓴다. 손으로 고칠 문구는 \`i18nStaticDictionary.ts\`에 있다.
 */
export const GENERATED_UI_EN: Record<string, string> = {
${entries}
};
`;
}

const pairs = collectTextPairs(ROOT);
const next = render(pairs);
const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";

if (process.argv.includes("--check")) {
  if (current !== next) {
    console.error(`UI 번역 카탈로그 생성 파일이 소스와 다릅니다. npm run i18n:catalog을 실행하세요: ${path.relative(ROOT, OUTPUT)}`);
    process.exitCode = 1;
  } else {
    console.log(`ui catalog generated pairs: ${pairs.size} (up to date)`);
  }
} else {
  if (current !== next) fs.writeFileSync(OUTPUT, next);
  console.log(`ui catalog generated pairs: ${pairs.size} -> ${path.relative(ROOT, OUTPUT)}`);
}
