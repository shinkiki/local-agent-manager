#!/usr/bin/env node
// Cypress E2E 하네스. 운영 백엔드(4178)는 건드리지 않고, 격리 백엔드를 별도 포트·임시 앱 데이터·
// 임시 HOME으로 띄운 뒤 Cypress를 돌리고 정리한다. Node 22, 외부 의존성 없음(cypress 모듈 API만).
//
//   node scripts/e2e.mjs [--open] [--spec <glob>] [--summary <json>] [--port <n>]
//                        [--server-bin <path>] [--static-dir <dir>] [--timeout-ms <n>]
//                        [--job-stdin]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeOpenShim } from "./e2e-open-shim.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const READY_TIMEOUT_MS = 20_000;
const READY_INTERVAL_MS = 250;
const BACKEND_EXIT_GRACE_MS = 2_000;

// 인자 하나를 읽는 세 갈래를 한 함수가 겹쳐 들고 있었다 — 플래그 해석, `--job-stdin`으로 들어온
// 작업 입력의 덮어쓰기, 마지막 값 검사. 무엇이 무엇을 덮는지 보이도록 갈래마다 이름을 준다.
function defaultOptions() {
  return {
    open: false,
    spec: null,
    summary: null,
    port: 54999,
    serverBin: path.join(ROOT, "target", "debug", "agent-manager-server"),
    staticDir: path.join(ROOT, "dist"),
    timeoutMs: 8 * 60 * 1000,
    screenshotsDir: null,
    env: {},
    headed: false,
    video: false,
    jobStdin: false,
  };
}

function parseFlags(argv) {
  const options = defaultOptions();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} 뒤에 값이 없습니다`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--open": options.open = true; break;
      case "--spec": options.spec = value(); break;
      case "--summary": options.summary = path.resolve(value()); break;
      case "--port": options.port = Number(value()); break;
      case "--server-bin": options.serverBin = path.resolve(value()); break;
      case "--static-dir": options.staticDir = path.resolve(value()); break;
      case "--timeout-ms": options.timeoutMs = Number(value()); break;
      case "--job-stdin": options.jobStdin = true; break;
      default: throw new Error(`알 수 없는 인자: ${arg}`);
    }
  }
  return options;
}

/** 작업 입력(JSON)은 stdin 한 번 읽기가 전부다. 읽는 자리와 덮어쓰는 자리를 나눠 둔다. */
function readJobInput() {
  return JSON.parse(fs.readFileSync(0, "utf8"));
}

// 작업 입력이 있으면 실행 단위 값은 전부 여기서 온다 — 플래그로 같은 값을 함께 주더라도 진다.
function applyJobInput(options, job) {
  options.spec = typeof job.spec === "string" && job.spec.length > 0 ? job.spec : null;
  options.summary = path.resolve(job.summaryPath);
  options.port = Number(job.port);
  options.timeoutMs = Number(job.timeoutMs);
  options.screenshotsDir = path.resolve(job.screenshotsDir);
  options.env = job.env ?? {};
  options.headed = job.headed === true;
  options.video = job.video === true;
  // 런처 잡. 앱의 '런처 열기'가 격리 하네스로 들어오는 길이며, 스펙 고르기와 단계별
  // 진행은 런처 안에서 사람이 한다.
  options.open = job.open === true;
  return options;
}

// 플래그로 왔든 작업 입력으로 왔든 같은 검사를 지난다.
function assertOptions(options) {
  if (!Number.isInteger(options.port) || options.port <= 0) throw new Error("--port 는 양의 정수여야 합니다");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout-ms 는 양수여야 합니다");
  if (!options.env || Array.isArray(options.env) || typeof options.env !== "object") throw new Error("env 는 객체여야 합니다");
  return options;
}

function parseArgs(argv) {
  const options = parseFlags(argv);
  if (options.jobStdin) applyJobInput(options, readJobInput());
  return assertOptions(options);
}

function runStep(label, command, args) {
  console.error(`[e2e] ${label}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} 실패 (exit ${result.status ?? result.signal})`);
}

// cypress.config.ts의 specPattern은 `.cy.ts`만 잡는다. 다른 확장자로 들어온 스펙은 조용히
// 한 번도 돌지 않는다(QA #60에서 `.cy.js` 두 벌이 그렇게 묻혀 있었다). 패턴 밖의 스펙은
// 통과도 실패도 아닌 상태로 남으므로, 실행 전에 세어 알리고 멈춘다.
function assertNoUnmatchedSpecs() {
  const dir = path.join(ROOT, "cypress", "e2e");
  const strays = fs
    .readdirSync(dir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => /\.cy\.(js|mjs|cjs|jsx|tsx)$/.test(entry));
  if (strays.length === 0) return;
  throw new Error(
    `specPattern(.cy.ts) 밖의 스펙 ${strays.length}건이 있습니다 — 돌지 않습니다: ${strays.join(", ")}`,
  );
}

function ensureArtifacts(options) {
  // 바이너리 존재만 보면 소스가 바뀐 뒤에도 지난 빌드를 그대로 띄운다. Cargo의 증분
  // 판정에 맡겨 매 격리 실행마다 현재 소스와 맞는지 확인한다. 최신이면 즉시 끝나고,
  // 오래됐으면 필요한 크레이트만 다시 빌드한다.
  runStep("백엔드 빌드", "cargo", ["build", "-q", "-p", "agent-manager-server"]);
  if (!fs.existsSync(path.join(options.staticDir, "index.html"))) runStep("프런트 빌드", "npm", ["run", "build"]);
}

/** 백엔드 자식에만 적용하는 환경. 사용자 홈·자격증명 경로 변수를 물려주지 않는다. */
function backendEnv(dirs) {
  const env = { ...process.env, HOME: dirs.home, PATH: `${dirs.bin}${path.delimiter}${process.env.PATH ?? ""}` };
  for (const key of ["CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CODEX_SQLITE_HOME"]) delete env[key];
  return env;
}

function reportBlockedOpens(logPath) {
  let calls = [];
  try { calls = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean); } catch { return; }
  if (calls.length === 0) return;
  console.error(`[e2e] 백엔드 자손의 브라우저 열기 ${calls.length}건을 막았습니다:`);
  for (const call of calls) console.error(`[e2e]   open ${call.slice(0, 160)}`);
}

/**
 * qa41: 정적 자원은 `dist`를 그대로 서빙하지 않고 회차 작업 공간에 스냅샷으로 복사해 그것을
 * 서빙한다. 백엔드는 요청마다 `<static>/index.html`을 디스크에서 다시 읽으므로, 같은 트리에서
 * 다른 세션이 `vite build --emptyOutDir`(npm run build)로 dist를 비우는 순간 루트 문서가
 * 500(`정적 파일을 읽지 못했습니다: No such file or directory`)으로 떨어지고 cy.visit가
 * 간헐적으로 실패한다. 복사 중에 그 재빌드와 겹치면 짧게 몇 번 다시 시도한다.
 */
function snapshotStaticDir(source, target) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, { recursive: true, dereference: true });
      if (fs.existsSync(path.join(target, "index.html"))) return target;
      lastError = new Error(`${source}/index.html 이 없습니다`);
    } catch (error) {
      lastError = error;
    }
    spawnSync("sleep", ["0.5"]);
  }
  throw new Error(`정적 자원 스냅샷 실패 (${source} → ${target}): ${lastError?.message ?? lastError}`);
}

function startBackend(options, dirs) {
  const args = [
    "--port", String(options.port),
    "--static-dir", dirs.static,
    "--app-data-dir", dirs.appData,
    "--shutdown-on-stdin-eof",
  ];
  const child = spawn(options.serverBin, args, {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
    env: backendEnv(dirs),
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout = (output.stdout + chunk).slice(-8_000); });
  child.stderr.on("data", (chunk) => { output.stderr = (output.stderr + chunk).slice(-8_000); });
  child.on("error", (error) => { output.stderr += `\nspawn 오류: ${error.message}`; });
  return { child, output, exited: false };
}

async function waitForBackend(backend, port) {
  const url = `http://127.0.0.1:${port}/api/access`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (backend.exited) break;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const body = await response.json();
        if (body && typeof body.protocolVersion === "number") return;
      }
    } catch {
      // 아직 리스닝 전이거나 기동 중. 다음 회차에 다시 본다.
    }
    await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
  }
  const reason = backend.exited ? "백엔드가 준비 전에 종료되었습니다" : `백엔드가 ${READY_TIMEOUT_MS / 1000}초 안에 준비되지 않았습니다`;
  throw new Error(`${reason}\n--- stdout ---\n${backend.output.stdout}\n--- stderr ---\n${backend.output.stderr}`);
}

/** 정적 자원 스냅샷을 뜨고 격리 백엔드를 띄운 뒤 준비 완료까지 기다린다. */
async function launchBackend(options, dirs) {
  snapshotStaticDir(options.staticDir, dirs.static);
  const backend = startBackend(options, dirs);
  backend.child.once("exit", () => { backend.exited = true; });
  await waitForBackend(backend, options.port);
  return backend;
}

/** pgrep -P 로 자손 pid를 모은다. Cypress 모듈 API가 띄운 바이너리·브라우저를 타임아웃에 죽일 때 쓴다. */
function descendantPids(pid) {
  const found = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift();
    const result = spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8" });
    if (result.status !== 0 || !result.stdout) continue;
    for (const line of result.stdout.split("\n")) {
      const child = Number(line.trim());
      if (Number.isInteger(child) && child > 0) { found.push(child); queue.push(child); }
    }
  }
  return found;
}

function killDescendants(signal) {
  for (const pid of descendantPids(process.pid).reverse()) {
    try { process.kill(pid, signal); } catch { /* 이미 죽었다 */ }
  }
}

// 백엔드를 세우는 두 걸음. stdin EOF가 정상 종료 신호이고(--shutdown-on-stdin-eof), 그래도
// 남으면 프로세스 그룹째 SIGTERM으로 걷는다. 급한 정리(동기)와 정상 종료(유예 대기)가 같은
// 두 걸음을 각자 적어 두고 있었다.
function endBackendStdin(backend) {
  try { backend.child.stdin.end(); } catch { /* 이미 닫혔다 */ }
}

function killBackendGroup(backend) {
  try { process.kill(-backend.child.pid, "SIGTERM"); } catch { /* 이미 죽었다 */ }
}

function stopBackendSync(backend) {
  if (!backend || backend.exited) return;
  endBackendStdin(backend);
  killBackendGroup(backend);
}

async function stopBackend(backend) {
  if (!backend || backend.exited) return;
  endBackendStdin(backend);
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), BACKEND_EXIT_GRACE_MS);
    backend.child.once("exit", () => { clearTimeout(timer); resolve(true); });
  });
  if (!exited) killBackendGroup(backend);
}

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
}

function removeFile(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* 정리 실패는 무시 */ }
}

function cleanupDirs(dirs, keepScreenshots) {
  if (!dirs) return;
  removeDir(dirs.appData);
  removeDir(dirs.home);
  removeDir(dirs.bin);
  removeDir(dirs.static);
  removeFile(dirs.openLog);
  const hasScreenshots = fs.existsSync(dirs.screenshots) && fs.readdirSync(dirs.screenshots).length > 0;
  if (dirs.ownsScreenshots) {
    if (keepScreenshots && hasScreenshots) return;
    removeDir(dirs.screenshots);
  }
  try { fs.rmdirSync(dirs.root); } catch { /* 남은 것이 있으면 둔다 */ }
}

function summarizeTest(test) {
  return {
    title: Array.isArray(test.title) ? test.title.join(" › ") : String(test.title ?? ""),
    state: test.state,
    error: test.displayError ?? null,
  };
}

function summarizeRun(run, specRoot) {
  return {
    spec: run.spec?.relative ?? path.relative(specRoot, run.spec?.absolute ?? ""),
    tests: (run.tests ?? []).map(summarizeTest),
    screenshots: (run.screenshots ?? []).map((shot) => shot.path),
  };
}

function summarize(result, specRoot) {
  if (result.status === "failed") {
    return { totalPassed: 0, totalFailed: 1, totalPending: 0, totalDuration: 0, runs: [], error: result.message ?? "Cypress 실행 실패" };
  }
  return {
    totalPassed: result.totalPassed ?? 0,
    totalFailed: result.totalFailed ?? 0,
    totalPending: result.totalPending ?? 0,
    totalDuration: result.totalDuration ?? 0,
    runs: (result.runs ?? []).map((run) => summarizeRun(run, specRoot)),
  };
}

/**
 * 회차 하나가 쓰는 임시 작업 공간. 백엔드의 앱 데이터·HOME·PATH 앞 bin·정적 자원 스냅샷·
 * 스크린샷·막힌 open 기록이 모두 이 루트 아래 모여, 정리는 루트 하나만 걷으면 끝난다.
 */
function createWorkspace(options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-e2e-"));
  const dirs = {
    root,
    appData: fs.mkdtempSync(path.join(root, "app-data-")),
    home: fs.mkdtempSync(path.join(root, "home-")),
    bin: fs.mkdtempSync(path.join(root, "bin-")),
    static: path.join(root, "static"),
    screenshots: options.screenshotsDir ?? path.join(root, "screenshots"),
    ownsScreenshots: options.screenshotsDir === null,
    openLog: path.join(root, "blocked-open.log"),
  };
  writeOpenShim(dirs.bin, dirs.openLog);
  return dirs;
}

/**
 * 강제 종료 경로를 한 곳에 세운다. 신호·전체 제한 시간·프로세스 종료가 모두 같은 정리를
 * 불러야 하고, 정상 종료와 겹쳐 두 번 도는 것은 `session.finished`가 막는다. 백엔드는 이
 * 시점에 아직 없으므로 `session`으로 늦게 넘겨받는다.
 */
function installEmergencyCleanup(session, dirs, keepScreenshots) {
  const cleanup = () => {
    if (session.finished) return;
    session.finished = true;
    killDescendants("SIGKILL");
    stopBackendSync(session.backend);
    cleanupDirs(dirs, keepScreenshots);
  };
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { cleanup(); process.exit(130); });
  }
  return cleanup;
}

function buildCypressRunConfig(options, baseUrl, screenshotsFolder) {
  return {
    ...(options.spec ? { spec: options.spec } : {}),
    browser: "electron",
    ...(options.headed ? { headed: true } : { headless: true }),
    quiet: true,
    reporter: "dot",
    env: options.env,
    config: {
      baseUrl,
      screenshotsFolder,
      videosFolder: path.join(path.dirname(screenshotsFolder), "videos"),
      video: options.video,
      trashAssetsBeforeRuns: false,
    },
  };
}

function writeSummaryFile(summaryPath, summary) {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
}

function printSummary(summary) {
  if (summary.error) console.error(`[e2e] ${summary.error}`);
  console.log(
    `passed=${summary.totalPassed} failed=${summary.totalFailed} pending=${summary.totalPending} duration=${summary.totalDuration}ms`,
  );
}

/** Cypress를 돌리고(또는 열고) 요약을 기록한다. 반환값은 이 프로세스의 종료 코드다. */
async function runCypress(options, baseUrl, screenshotsFolder) {
  const cypress = (await import("cypress")).default;
  if (options.open) {
    // 런처에서 찍은 스크린샷도 실행 폴더로 모은다 — 앱이 산출물을 그 자리에서만 회수한다.
    await cypress.open({ config: { baseUrl, screenshotsFolder, trashAssetsBeforeRuns: false }, e2e: true });
    return 0;
  }
  const result = await cypress.run(buildCypressRunConfig(options, baseUrl, screenshotsFolder));
  const summary = summarize(result, ROOT);
  if (options.summary) writeSummaryFile(options.summary, summary);
  printSummary(summary);
  return summary.totalFailed > 0 || summary.error ? 1 : 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  assertNoUnmatchedSpecs();
  ensureArtifacts(options);

  const dirs = createWorkspace(options);
  const keepScreenshots = Boolean(options.summary);
  const session = { backend: null, finished: false };
  const emergencyCleanup = installEmergencyCleanup(session, dirs, keepScreenshots);

  const timer = setTimeout(() => {
    console.error(`[e2e] 전체 제한 시간 ${options.timeoutMs}ms 초과 — Cypress와 백엔드를 강제 종료합니다`);
    emergencyCleanup();
    process.exit(1);
  }, options.timeoutMs);

  session.backend = await launchBackend(options, dirs);

  let exitCode = 0;
  try {
    exitCode = await runCypress(options, `http://127.0.0.1:${options.port}`, dirs.screenshots);
  } finally {
    clearTimeout(timer);
    await stopBackend(session.backend);
    reportBlockedOpens(dirs.openLog);
    session.finished = true;
    cleanupDirs(dirs, keepScreenshots);
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
