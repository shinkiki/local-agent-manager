#!/usr/bin/env node
// 간헐 실패 시험 격리 회차의 측정·탐색 도구.
//
// 같은 명령을 여러 번 돌려 간헐 실패를 재현하고, 실패를 종류로 묶어 찍고, 함께 돌 때만 깨지는
// 시험 묶음을 좁힌다. 판정 규칙은 src/lib/flakyTestReport.ts 에 있고 여기서는 돌리고 모으기만
// 한다 — 규칙은 단위 시험으로 고정돼 있다.
//
//   node --experimental-strip-types scripts/flaky-isolate.mjs --mode=suite  --runs=10
//   node --experimental-strip-types scripts/flaky-isolate.mjs --mode=solo   --runs=10
//   node --experimental-strip-types scripts/flaky-isolate.mjs --mode=serial --runs=5
//   node --experimental-strip-types scripts/flaky-isolate.mjs --mode=with --with=a::b,c::d --runs=10
//   node --experimental-strip-types scripts/flaky-isolate.mjs --mode=bisect --repro-runs=4
//   node --experimental-strip-types scripts/flaky-isolate.mjs --mode=suite --runs=10 --write-baseline
//
// 종료 코드: 대상 시험이 한 번이라도 실패하면(또는 측정이 성립하지 않으면) 1, 그 밖에는 0.
// 재현 단계에서는 1 이 "재현됐다"는 성공이므로 --expect=flaky 로 뒤집을 수 있다.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareFailureKinds,
  comparisonLines,
  diagnosticKinds,
  failureKinds,
  parseCargoTestOutput,
  splitEvenly,
  summarizeRuns,
  verdict,
} from '../src/lib/flakyTestReport.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs', 'flaky-tests');
const BASELINE_PATH = path.join(OUT_DIR, 'baseline.json');

const DEFAULT_TARGET =
  'usage_budget_policy::tests::the_completion_condition_switch_keeps_the_text_and_stops_applying_it';
const DEFAULT_PACKAGE = 'agent-manager-core';

function parseArgs(argv) {
  const options = {
    mode: 'suite',
    runs: 10,
    reproRuns: 4,
    target: DEFAULT_TARGET,
    pkg: DEFAULT_PACKAGE,
    with: [],
    testThreads: null,
    expect: 'clean',
    writeBaseline: false,
    json: false,
    out: null,
  };
  for (const argument of argv) {
    const [key, rawValue] = argument.startsWith('--')
      ? argument.slice(2).split('=')
      : [argument, undefined];
    const value = rawValue ?? '';
    switch (key) {
      case 'mode':
        options.mode = value;
        break;
      case 'runs':
        options.runs = Number(value);
        break;
      case 'repro-runs':
        options.reproRuns = Number(value);
        break;
      case 'target':
        options.target = value;
        break;
      case 'package':
        options.pkg = value;
        break;
      case 'with':
        options.with = value.split(',').map((name) => name.trim()).filter(Boolean);
        break;
      case 'test-threads':
        options.testThreads = Number(value);
        break;
      case 'expect':
        options.expect = value;
        break;
      case 'write-baseline':
        options.writeBaseline = true;
        break;
      case 'json':
        options.json = true;
        break;
      case 'out':
        options.out = value;
        break;
      default:
        throw new Error(`모르는 인자입니다: ${argument}`);
    }
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error('--runs 는 1 이상의 정수여야 합니다');
  }
  if (!Number.isInteger(options.reproRuns) || options.reproRuns < 1) {
    throw new Error('--repro-runs 는 1 이상의 정수여야 합니다');
  }
  return options;
}

/**
 * cargo 를 한 번 돌린다. `filters` 가 비면 전건, 아니면 `--exact` 로 그 이름들만 돌린다.
 *
 * 검증 사다리(AGENTS.md 8절)가 정한 명령과 같은 모양을 쓴다 — 탐침이 제품 검증보다 느슨하거나
 * 엄하면 여기서 깨끗한 것이 거기서 깨진다.
 */
function runCargo({ pkg, filters, testThreads }) {
  const args = ['test', '-q', '-p', pkg, '--lib'];
  const harness = [];
  if (filters.length > 0) harness.push('--exact', ...filters);
  if (testThreads !== null) harness.push('--test-threads', String(testThreads));
  if (harness.length > 0) args.push('--', ...harness);

  const started = Date.now();
  const result = spawnSync('cargo', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const run = parseCargoTestOutput(stdout, result.status ?? -1);
  return { ...run, wallSeconds: Number(((Date.now() - started) / 1000).toFixed(1)) };
}

function repeat(count, make) {
  const runs = [];
  for (let index = 0; index < count; index += 1) runs.push(make(index));
  return runs;
}

/** 시험 바이너리에게 이름 목록을 물어본다. 전건을 알아야 함께 돌 후보를 가를 수 있다. */
function listTests(pkg) {
  const result = spawnSync('cargo', ['test', '-q', '-p', pkg, '--lib', '--', '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  return `${result.stdout ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.match(/^(\S+): test$/))
    .filter(Boolean)
    .map((match) => match[1]);
}

/**
 * 대상과 `candidates` 를 함께 `attempts` 번 돌려 대상이 한 번이라도 깨지는지 본다.
 *
 * 돌아온 false 는 "간섭이 없다"가 아니라 "이번 attempts 번 안에는 안 나왔다"일 뿐이다. 간헐
 * 실패를 좁히는 일은 음성이 약한 증거라서, attempts 를 올리지 않고 좁힌 결과는 믿을 수 없다.
 */
function reproduces({ pkg, target, candidates, attempts, testThreads }) {
  const runs = repeat(attempts, () =>
    runCargo({ pkg, filters: [target, ...candidates], testThreads }),
  );
  const summary = summarizeRuns(runs, target);
  return { hit: summary.targetFailedRuns > 0, summary, runs };
}

/**
 * 델타 디버깅으로 "대상과 함께 돌 때만 깨지는" 최소 묶음을 좁힌다.
 *
 * 조각을 반씩 갈라 보고, 어느 조각도 재현하지 못하면 여집합을 본 다음 조각 수를 늘린다. 조각
 * 수가 후보 수를 넘으면 더 좁힐 수 없으므로 멈춘다.
 */
function bisect({ pkg, target, all, attempts, testThreads, log }) {
  let candidates = all.filter((name) => name !== target);
  const trail = [];

  const first = reproduces({ pkg, target, candidates, attempts, testThreads });
  trail.push({ step: 'all', size: candidates.length, hit: first.hit });
  log(`전건 동반 ${candidates.length}건: ${first.hit ? '재현' : '미재현'}`);
  if (!first.hit) {
    return { minimal: null, trail, note: '전건을 함께 돌려도 재현되지 않았다. --repro-runs 를 올려라.' };
  }

  let parts = 2;
  while (candidates.length > 1 && parts <= candidates.length) {
    const chunks = splitEvenly(candidates, parts);
    let narrowed = false;

    for (const chunk of chunks) {
      const probe = reproduces({ pkg, target, candidates: chunk, attempts, testThreads });
      trail.push({ step: 'chunk', size: chunk.length, hit: probe.hit });
      log(`조각 ${chunk.length}건: ${probe.hit ? '재현' : '미재현'}`);
      if (probe.hit) {
        candidates = chunk;
        parts = 2;
        narrowed = true;
        break;
      }
    }
    if (narrowed) continue;

    for (const chunk of chunks) {
      const complement = candidates.filter((name) => !chunk.includes(name));
      if (complement.length === 0 || complement.length === candidates.length) continue;
      const probe = reproduces({ pkg, target, candidates: complement, attempts, testThreads });
      trail.push({ step: 'complement', size: complement.length, hit: probe.hit });
      log(`여집합 ${complement.length}건: ${probe.hit ? '재현' : '미재현'}`);
      if (probe.hit) {
        candidates = complement;
        parts = Math.max(parts - 1, 2);
        narrowed = true;
        break;
      }
    }
    if (!narrowed) parts *= 2;
  }

  return {
    minimal: candidates,
    trail,
    note:
      '좁힌 묶음은 이 attempts 안에서 재현된 것이다. 묶음 밖을 "무죄"로 읽지 말고, 찾은 묶음으로 ' +
      '--mode=with 를 다시 돌려 확인한다.',
  };
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// 글을 만드는 일은 판정을 읽는 규칙이라 flakyTestReport.ts 에 있다(파일 머리말의 계약이다).
// 여기서는 기준선에서 분모만 꺼내 넘기고 찍기만 한다.
function logComparison(log, title, comparison, baseline, summary) {
  const lines = comparisonLines({
    title,
    comparison,
    baselineRuns: baseline?.summary?.measuredRuns ?? null,
    runs: summary.measuredRuns,
    hasBaseline: baseline !== null,
  });
  for (const line of lines) log(line);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const log = (line) => {
    if (!options.json) process.stdout.write(`${line}\n`);
  };

  let payload;

  if (options.mode === 'bisect') {
    const all = listTests(options.pkg);
    if (all.length === 0) throw new Error('시험 목록을 읽지 못했습니다');
    if (!all.includes(options.target)) {
      throw new Error(`대상 시험이 목록에 없습니다: ${options.target}`);
    }
    log(`시험 ${all.length}건에서 좁힌다 (한 묶음당 ${options.reproRuns}회)`);
    const found = bisect({
      pkg: options.pkg,
      target: options.target,
      all,
      attempts: options.reproRuns,
      testThreads: options.testThreads,
      log,
    });
    payload = {
      mode: options.mode,
      target: options.target,
      attempts: options.reproRuns,
      totalTests: all.length,
      ...found,
    };
    log(
      found.minimal
        ? `최소 묶음 ${found.minimal.length}건: ${found.minimal.join(', ')}`
        : '좁히지 못했다',
    );
    log(found.note);
  } else {
    const filters =
      options.mode === 'solo'
        ? [options.target]
        : options.mode === 'with'
          ? [options.target, ...options.with]
          : [];
    const testThreads =
      options.mode === 'serial' ? (options.testThreads ?? 1) : options.testThreads;

    const runs = repeat(options.runs, (index) => {
      const run = runCargo({ pkg: options.pkg, filters, testThreads });
      const names = run.failures.map((failure) => failure.name);
      log(
        `${index + 1}/${options.runs} ${run.buildError ? '빌드실패' : names.length === 0 ? 'ok' : `실패 ${names.join(', ')}`} (${run.wallSeconds}s)`,
      );
      return run;
    });

    const summary = summarizeRuns(runs, options.target);
    const kinds = failureKinds(summary);
    const diagnostics = diagnosticKinds(summary);
    const baseline = readBaseline();
    payload = {
      mode: options.mode,
      command: `cargo test -q -p ${options.pkg} --lib${filters.length > 0 ? ' -- --exact ...' : ''}${testThreads !== null ? ` --test-threads ${testThreads}` : ''}`,
      target: options.target,
      filters,
      testThreads,
      summary,
      failureKinds: kinds,
      // 진단 지문 축. 깨진 시험 이름은 회차마다 바뀌는데 원인은 하나였다는 2·3회차 실측
      // 때문에 둔다 — 이름 축만으로는 그것이 잡음으로 보인다.
      diagnosticKinds: diagnostics,
      verdict: verdict(summary),
      // V6: 통과 출력은 싣지 않는다. 실패한 시험의 진단만 남긴다.
      diagnostics: runs
        .flatMap((run) => run.failures)
        .filter((failure) => failure.diagnostic.length > 0),
      comparedToBaseline:
        baseline && baseline.failureKinds
          ? compareFailureKinds(baseline.failureKinds, kinds)
          : null,
      // 같은 모양이라 같은 비교 함수를 쓴다. 기준선이 이 축을 갖기 전에 적힌 것이면 null —
      // 없는 것을 0 으로 읽으면 "전부 새로 생긴 종류"가 되어 회귀로 오인된다.
      comparedToBaselineDiagnostics:
        baseline && baseline.diagnosticKinds
          ? compareFailureKinds(baseline.diagnosticKinds, diagnostics)
          : null,
    };

    log(
      `판정: ${payload.verdict} — 대상 실패 ${summary.targetFailedRuns}/${summary.measuredRuns}, 어떤 시험이든 실패 ${summary.failedRuns}/${summary.measuredRuns}`,
    );
    for (const kind of kinds) log(`  실패 종류 · ${kind.kind}: ${kind.count}`);
    for (const entry of summary.failureCountsByTest) log(`  ${entry.name}: ${entry.runs}회`);
    for (const entry of summary.failureCountsByDiagnostic) {
      log(`  진단 · ${entry.signature}: ${entry.runs}회 (${entry.tests.length}개 시험)`);
    }
    // 회차 절차 6절은 "출력의 comparedToBaseline 이 사라진 종류·새로 생긴 종류를 찍는다"를
    // 전제로 보고를 쓰게 한다. 그런데 이 둘은 payload 에만 담기고 화면에는 한 줄도 나오지
    // 않아, 회차마다 사람이 JSON 을 따로 열어야 했다. 판정 축이니 결과와 같은 자리에 찍는다.
    logComparison(log, '기준선 대비 실패 종류', payload.comparedToBaseline, baseline, summary);
    logComparison(
      log,
      '기준선 대비 진단 지문',
      payload.comparedToBaselineDiagnostics,
      baseline,
      summary,
    );
  }

  payload.recordedAt = new Date().toISOString();
  payload.toolVersion = 1;

  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  // 둘 다 주면 둘 다 적는다. 예전에는 --write-baseline 이 --out 을 조용히 삼켜, 기준선을
  // 내면서 그 회차의 실행 기록도 남기려던 측정이 흔적 없이 사라졌다(기준선은 덮어써지므로
  // 다음 회차가 그 블록을 다시 읽을 길이 없다).
  const destinations = [];
  if (options.writeBaseline) destinations.push(BASELINE_PATH);
  if (options.out) destinations.push(path.resolve(ROOT, options.out));
  for (const destination of destinations) {
    // 기준선 폴더만 만들면 `--out=docs/flaky-tests/runs/after.json`(README·회차 절차가
    // 적어 둔 그 경로다)이 ENOENT 로 죽어 **방금 돌린 측정이 통째로 사라진다.** 측정은
    // 몇 분짜리라 다시 돌리면 다른 조건에서 찍힌 숫자가 되므로, 목적지 자신의 부모를 만든다.
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    log(`적었다: ${path.relative(ROOT, destination)}`);
  }

  const flaky = payload.verdict ? payload.verdict !== 'clean' : Boolean(payload.minimal);
  const bad = options.expect === 'flaky' ? !flaky : flaky;
  process.exitCode = bad ? 1 : 0;
}

main();
