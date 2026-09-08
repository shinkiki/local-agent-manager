#!/usr/bin/env node
// Cypress E2E 하네스. 운영 백엔드(4178)는 건드리지 않고, 격리 백엔드를 별도 포트·임시 앱 데이터·
// 임시 HOME으로 띄운 뒤 Cypress를 돌리고 정리한다. Node 22, 외부 의존성 없음(cypress 모듈 API만).
//
//   node scripts/e2e.mjs [--open] [--spec <glob>] [--summary <json>] [--port <n>]
//                        [--server-bin <path>] [--static-dir <dir>] [--timeout-ms <n>]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const READY_TIMEOUT_MS = 20_000;
const READY_INTERVAL_MS = 250;
const BACKEND_EXIT_GRACE_MS = 2_000;

function parseArgs(argv) {
  const options = {
    open: false,
    spec: null,
    summary: null,
    port: 54999,
    serverBin: path.join(ROOT, "target", "debug", "agent-manager-server"),
    staticDir: path.join(ROOT, "dist"),
    timeoutMs: 8 * 60 * 1000,
  };
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
      default: throw new Error(`알 수 없는 인자: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0) throw new Error("--port 는 양의 정수여야 합니다");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout-ms 는 양수여야 합니다");
  return options;
}

function runStep(label, command, args) {
  console.error(`[e2e] ${label}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${label} 실패 (exit ${result.status ?? result.signal})`);
}

function ensureArtifacts(options) {
  if (!fs.existsSync(options.serverBin)) runStep("백엔드 빌드", "cargo", ["build", "-q", "-p", "agent-manager-server"]);
  if (!fs.existsSync(path.join(options.staticDir, "index.html"))) runStep("프런트 빌드", "npm", ["run", "build"]);
}

/**
 * 백엔드 자손이 시스템 브라우저를 열지 못하게 PATH 앞에 세우는 `open` 대체. 임시 HOME에는
 * 로그인 토큰이 없어 공급자 CLI(예: Antigravity `agy`)가 print 모드에서도 대화형 OAuth로
 * 넘어가 구글 로그인 창을 띄운다. 호출은 막고 인자만 기록해 두어 실행 끝에 알린다.
 */
function writeOpenShim(binDir, logPath) {
  const shim = path.join(binDir, "open");
  fs.writeFileSync(shim, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
exit 0
`, { mode: 0o755 });
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
        if (body && body.writable === true) return;
      }
    } catch {
      // 아직 리스닝 전이거나 기동 중. 다음 회차에 다시 본다.
    }
    await new Promise((resolve) => setTimeout(resolve, READY_INTERVAL_MS));
  }
  const reason = backend.exited ? "백엔드가 준비 전에 종료되었습니다" : `백엔드가 ${READY_TIMEOUT_MS / 1000}초 안에 준비되지 않았습니다`;
  throw new Error(`${reason}\n--- stdout ---\n${backend.output.stdout}\n--- stderr ---\n${backend.output.stderr}`);
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
  if (keepScreenshots && hasScreenshots) return;
  removeDir(dirs.screenshots);
  try { fs.rmdirSync(dirs.root); } catch { /* 남은 것이 있으면 둔다 */ }
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
    runs: (result.runs ?? []).map((run) => ({
      spec: run.spec?.relative ?? path.relative(specRoot, run.spec?.absolute ?? ""),
      tests: (run.tests ?? []).map((test) => ({
        title: Array.isArray(test.title) ? test.title.join(" › ") : String(test.title ?? ""),
        state: test.state,
        error: test.displayError ?? null,
      })),
      screenshots: (run.screenshots ?? []).map((shot) => shot.path),
    })),
  };
}

/**
 * 회차 하나가 쓰는 임시 작업 공간. 백엔드의 앱 데이터·HOME·PATH 앞 bin·정적 자원 스냅샷·
 * 스크린샷·막힌 open 기록이 모두 이 루트 아래 모여, 정리는 루트 하나만 걷으면 끝난다.
 */
function createWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-manager-e2e-"));
  const dirs = {
    root,
    appData: fs.mkdtempSync(path.join(root, "app-data-")),
    home: fs.mkdtempSync(path.join(root, "home-")),
    bin: fs.mkdtempSync(path.join(root, "bin-")),
    static: path.join(root, "static"),
    screenshots: path.join(root, "screenshots"),
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

/** Cypress를 돌리고(또는 열고) 요약을 기록한다. 반환값은 이 프로세스의 종료 코드다. */
async function runCypress(options, baseUrl, screenshotsFolder) {
  const cypress = (await import("cypress")).default;
  if (options.open) {
    await cypress.open({ config: { baseUrl }, e2e: true });
    return 0;
  }
  const result = await cypress.run({
    ...(options.spec ? { spec: options.spec } : {}),
    browser: "electron",
    headless: true,
    quiet: true,
    reporter: "dot",
    config: { baseUrl, screenshotsFolder },
  });
  const summary = summarize(result, ROOT);
  if (options.summary) {
    fs.mkdirSync(path.dirname(options.summary), { recursive: true });
    fs.writeFileSync(options.summary, JSON.stringify(summary, null, 2));
  }
  if (summary.error) console.error(`[e2e] ${summary.error}`);
  console.log(`passed=${summary.totalPassed} failed=${summary.totalFailed} pending=${summary.totalPending} duration=${summary.totalDuration}ms`);
  return summary.totalFailed > 0 || summary.error ? 1 : 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureArtifacts(options);

  const dirs = createWorkspace();
  const keepScreenshots = Boolean(options.summary);
  const session = { backend: null, finished: false };
  const emergencyCleanup = installEmergencyCleanup(session, dirs, keepScreenshots);

  const timer = setTimeout(() => {
    console.error(`[e2e] 전체 제한 시간 ${options.timeoutMs}ms 초과 — Cypress와 백엔드를 강제 종료합니다`);
    emergencyCleanup();
    process.exit(1);
  }, options.timeoutMs);

  snapshotStaticDir(options.staticDir, dirs.static);
  session.backend = startBackend(options, dirs);
  session.backend.child.once("exit", () => { session.backend.exited = true; });
  await waitForBackend(session.backend, options.port);

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
