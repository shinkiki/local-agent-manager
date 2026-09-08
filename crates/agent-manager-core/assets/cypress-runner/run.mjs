// Agent Manager Cypress 러너.
//
// 백엔드가 stdin으로 넘긴 잡 JSON대로 대상 프로젝트의 Cypress 모듈을 불러 `cypress.run()`을
// 호출하고, 요약을 summaryPath에 JSON으로 남긴다. 인자·환경변수로는 아무것도 받지 않는다 —
// 잡 내용(경로·env)이 프로세스 목록이나 자식 환경에 새지 않게 하기 위해서다. 비밀은 여기에도
// 오지 않는다: Cypress가 프로젝트 루트의 cypress.env.json을 직접 읽는다.
//
// 잡 형식: { moduleDir, project, spec?, configFile?, browser?, env, config, summaryPath }
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

const options = {
  project: job.project,
  browser: job.browser ?? "electron",
  headless: true,
  quiet: true,
  reporter: "dot",
  config: job.config ?? {},
  env: job.env ?? {},
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
