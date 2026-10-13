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

/**
 * 2026-10-06: `core.autocrlf=true`(Windows 기본)로 받은 작업 트리에서는 체크아웃이 이 파일을
 * CRLF로 풀어 놓는데 생성기는 늘 LF로 적는다. 바이트로 비교하면 소스와 한 글자도 다르지
 * 않은데도 `--check`가 매번 "소스와 다릅니다"로 떨어져, 갓 받은 저장소에서 `npm run check`가
 * 코드와 무관하게 실패했다. 줄끝은 저장 형식이지 카탈로그의 내용이 아니므로 비교에서 지운다.
 */
export function generatedCatalogMatches(current, next) {
  return current.replace(/\r\n/g, "\n") === next.replace(/\r\n/g, "\n");
}

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

// 시험이 위 비교 함수만 가져다 쓸 수 있도록, 거두고 쓰는 일은 이 파일을 직접 실행했을 때만
// 한다. 가져오기만 해도 본문이 돌면 시험이 생성 파일을 다시 쓴다.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const pairs = collectTextPairs(ROOT);
  const next = render(pairs);
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : "";

  if (process.argv.includes("--check")) {
    if (!generatedCatalogMatches(current, next)) {
      console.error(`UI 번역 카탈로그 생성 파일이 소스와 다릅니다. npm run i18n:catalog을 실행하세요: ${path.relative(ROOT, OUTPUT)}`);
      process.exitCode = 1;
    } else {
      console.log(`ui catalog generated pairs: ${pairs.size} (up to date)`);
    }
  } else {
    if (!generatedCatalogMatches(current, next)) fs.writeFileSync(OUTPUT, next);
    console.log(`ui catalog generated pairs: ${pairs.size} -> ${path.relative(ROOT, OUTPUT)}`);
  }
}
