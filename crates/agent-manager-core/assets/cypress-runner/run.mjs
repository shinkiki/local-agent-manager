// Agent Manager Cypress 러너.
//
// 백엔드가 stdin으로 넘긴 잡 JSON대로 대상 프로젝트의 Cypress 모듈을 불러 `cypress.run()`을
// 호출하고, 요약을 summaryPath에 JSON으로 남긴다. 인자·환경변수로는 아무것도 받지 않는다 —
// 잡 내용(경로·env)이 프로세스 목록이나 자식 환경에 새지 않게 하기 위해서다. 비밀은 여기에도
// 오지 않는다: Cypress가 프로젝트 루트의 cypress.env.json을 직접 읽는다.
//
// 잡 형식: { mode?, moduleDir, project, spec?, configFile?, browser?, headed?, env, config, summaryPath }
//
// mode가 "open"이면 `cypress.run()` 대신 `cypress.open()`으로 Cypress 런처를 띄운다. 사람이
// 스펙을 골라 한 커맨드씩 멈춰 가며(cy.pause) 보는 수동 실행이라 요약이 없고, 사용자가 창을
// 닫을 때까지 이 프로세스가 살아 있다. 런처를 띄우지 못했을 때만 요약에 사유를 남긴다.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function writeSummary(summaryPath, summary) {
  mkdirSync(path.dirname(summaryPath), { recursive: true });
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
}

const job = JSON.parse(readFileSync(0, "utf8"));
const require = createRequire(path.join(job.moduleDir, "package.json"));
const cypress = require("cypress");

if (job.mode === "open") {
  const openOptions = {
    project: job.project,
    // 런처의 테스트 종류 고르기를 건너뛰고 바로 E2E 스펙 목록으로 들어간다.
    testingType: "e2e",
    config: job.config ?? {},
    env: job.env ?? {},
  };
  if (job.configFile) openOptions.configFile = job.configFile;
  // 브라우저는 일부러 고정하지 않는다 — 런처에서 사람이 고르는 값이다.
  try {
    await cypress.open(openOptions);
  } catch (error) {
    writeSummary(job.summaryPath, { passed: 0, failed: 0, pending: 0, durationMs: 0, specs: [], screenshots: [], error: String(error?.message ?? error) });
    console.error(String(error?.message ?? error));
    process.exit(2);
  }
  process.exit(0);
}

const options = {
  project: job.project,
  browser: job.browser ?? "electron",
  quiet: true,
  reporter: "dot",
  config: job.config ?? {},
  env: job.env ?? {},
  // 창을 띄우려면 headed를 켜야 한다. cypress.run은 headless를 truthy일 때만 보므로
  // `headless: false`로는 아무 일도 일어나지 않고 그대로 헤드리스로 돈다. 둘을 같이 주면
  // 오류라 한쪽만 싣는다. 잡에 값이 없으면(옛 잡·다른 호출자) 헤드리스가 기본이다.
  ...(job.headed ? { headed: true } : { headless: true }),
};
if (job.spec) options.spec = job.spec;
if (job.configFile) options.configFile = job.configFile;

let results;
try {
  results = await cypress.run(options);
} catch (error) {
  writeSummary(job.summaryPath, { passed: 0, failed: 0, pending: 0, durationMs: 0, specs: [], screenshots: [], error: String(error?.message ?? error) });
  console.error(String(error?.message ?? error));
  process.exit(2);
}

// Cypress가 아예 뜨지 못한 경우(설정 오류·바이너리 없음 등)는 status: "failed"로 온다.
if (results.status === "failed") {
  writeSummary(job.summaryPath, { passed: 0, failed: 0, pending: 0, durationMs: 0, specs: [], screenshots: [], error: results.message ?? "Cypress를 실행하지 못했습니다" });
  console.error(results.message ?? "Cypress failed to start");
  process.exit(2);
}

const runs = results.runs ?? [];
const summary = {
  passed: results.totalPassed ?? 0,
  failed: results.totalFailed ?? 0,
  pending: results.totalPending ?? 0,
  durationMs: results.totalDuration ?? 0,
  specs: runs.map((run) => ({
    spec: run.spec?.relative ?? run.spec?.name ?? "",
    tests: (run.tests ?? []).map((test) => ({
      title: Array.isArray(test.title) ? test.title.join(" › ") : String(test.title ?? ""),
      state: test.state ?? "unknown",
      error: test.displayError ?? null,
    })),
  })),
  screenshots: runs.flatMap((run) => (run.screenshots ?? []).map((shot) => shot.path)),
};
writeSummary(job.summaryPath, summary);
process.exit(summary.failed > 0 ? 1 : 0);
