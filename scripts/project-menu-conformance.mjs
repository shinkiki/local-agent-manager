#!/usr/bin/env node
// 프로젝트 메뉴 고도화 회차의 측정 탐침.
//
// docs/project-menu/acceptance.json의 점검을 저장소 파일 위에서 다시 묻고, 실패를 종류로 묶어
// 찍는다. 합격률은 참고 수치고 판정은 실패 종류다.
//
//   node --experimental-strip-types scripts/project-menu-conformance.mjs
//   node --experimental-strip-types scripts/project-menu-conformance.mjs --json
//   node --experimental-strip-types scripts/project-menu-conformance.mjs --write-baseline
//
// 종료 코드: 회귀나 안전규칙위반이 있으면 1, 그 밖에는 0. 미구현은 아직 안 한 일이지 고장이 아니다.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkOkMap,
  classifyFailureKinds,
  evaluateChecklist,
  requiredFiles,
  validateChecklist,
} from '../src/lib/projectMenuConformance.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKLIST_PATH = path.join(ROOT, 'docs', 'project-menu', 'acceptance.json');
const BASELINE_PATH = path.join(ROOT, 'docs', 'project-menu', 'baseline.json');

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const shouldWriteBaseline = args.has('--write-baseline');

async function readMaybe(absolute) {
  try {
    return await readFile(absolute, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
    throw error;
  }
}

const checklist = JSON.parse(await readFile(CHECKLIST_PATH, 'utf8'));
const problems = validateChecklist(checklist);
if (problems.length > 0) {
  console.error('점검표가 쓸 수 없는 상태다:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(2);
}

const files = {};
for (const relative of requiredFiles(checklist)) {
  files[relative] = await readMaybe(path.join(ROOT, relative));
}

const result = evaluateChecklist(checklist, files);
const checks = checkOkMap(result);

const baselineText = await readMaybe(BASELINE_PATH);
const previous = baselineText ? JSON.parse(baselineText).checks : undefined;
const failureKinds = classifyFailureKinds(result, previous);

const report = {
  measuredAt: new Date().toISOString(),
  itemsPassed: `${result.passedItems}/${result.totalItems}`,
  checksPassed: `${result.passedChecks}/${result.totalChecks}`,
  comparedToBaseline: Boolean(previous),
  failureKinds,
  failing: result.items
    .filter((item) => !item.ok)
    .map((item) => ({
      id: item.id,
      stage: item.stage,
      title: item.title,
      reasons: item.checks
        .filter((check) => !check.ok)
        .map((check) => `${check.id}: ${check.reason}`),
    })),
};

if (asJson) {
  console.log(JSON.stringify({ ...report, checks }, null, 2));
} else {
  const tail = previous ? '' : ' (기준선 없음 — 회귀는 다음 회차부터 센다)';
  console.log(`항목 ${report.itemsPassed} · 점검 ${report.checksPassed}${tail}`);
  if (failureKinds.length === 0) {
    console.log('실패 종류: 없음');
  } else {
    console.log('실패 종류:');
    for (const kind of failureKinds) {
      console.log(`  ${kind.kind} ${kind.count} — ${kind.items.join(', ')}`);
    }
  }
  for (const item of report.failing) {
    console.log(`\n[${item.id}] ${item.stage} · ${item.title}`);
    for (const reason of item.reasons) console.log(`  - ${reason}`);
  }
}

if (shouldWriteBaseline) {
  await mkdir(path.dirname(BASELINE_PATH), { recursive: true });
  const saved = {
    measuredAt: report.measuredAt,
    itemsPassed: report.itemsPassed,
    checksPassed: report.checksPassed,
    failureKinds,
    // 점검별 통과 여부. 다음 회차가 회귀를 세는 근거다.
    checks,
  };
  await writeFile(BASELINE_PATH, `${JSON.stringify(saved, null, 2)}\n`);
  if (!asJson) console.error(`기준선을 갱신했다: ${path.relative(ROOT, BASELINE_PATH)}`);
}

const blocking = failureKinds.filter(
  (kind) => kind.kind === '회귀' || kind.kind === '안전규칙위반',
);
process.exit(blocking.length > 0 ? 1 : 0);
