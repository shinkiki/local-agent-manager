#!/usr/bin/env node
// 에이전트매니저 코드리뷰 회차의 일감 큐.
//
// 리뷰 안 된 커밋과 리뷰 안 된 모듈을 세어 docs/code-review/queue.json 에 적는다. 회차 봉투는
// 계획 **전에** 그 파일의 remaining 을 읽어 남은 수만큼만 레인을 띄운다 — 병렬 10은 상한이지
// 매 회차 채워야 할 목표가 아니다.
//
//   node --experimental-strip-types scripts/code-review-queue.mjs            # 요약만
//   node --experimental-strip-types scripts/code-review-queue.mjs --json     # 큐 전체
//   node --experimental-strip-types scripts/code-review-queue.mjs --write    # queue.json 갱신
//   node --experimental-strip-types scripts/code-review-queue.mjs --branch origin/dev-history --window 7
//
// 장부는 항목당 파일 하나(docs/code-review/reviewed/<항목id>.json)다. 한 파일에 몰아 적으면
// 레인 열 개가 같은 줄을 고쳐 rebase 마다 충돌한다.
//
// 종료 코드: 장부에 중복 리뷰가 적혀 있으면 1, 그 밖에는 0.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildQueue } from '../src/lib/codeReviewQueue.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVIEW_DIR = path.join(ROOT, 'docs', 'code-review');
const LEDGER_DIR = path.join(REVIEW_DIR, 'reviewed');
const MODULES_PATH = path.join(REVIEW_DIR, 'modules.json');
const QUEUE_PATH = path.join(REVIEW_DIR, 'queue.json');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const asJson = argv.includes('--json');
const shouldWrite = argv.includes('--write');
const branch = flag('--branch', 'origin/dev-history');
const windowDays = Number(flag('--window', '7'));

function readCommits() {
  // 커밋 제목에 파이프가 들어와도 앞 두 칸만 고정으로 끊어 읽는다.
  const out = execFileSync(
    'git',
    ['log', '--first-parent', '--no-merges', `--since=${windowDays + 1}.days.ago`, '--format=%H|%ct|%s', branch],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  const commits = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split('|');
    const hash = parts.shift();
    const timestamp = Number(parts.shift());
    if (!hash || !Number.isFinite(timestamp)) continue;
    commits.push({ hash, timestamp, subject: parts.join('|') });
  }
  return commits;
}

function readLedger() {
  let names = [];
  try {
    names = readdirSync(LEDGER_DIR);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const itemId = name.slice(0, -'.json'.length);
    let reviewedAt;
    let kind;
    try {
      const body = JSON.parse(readFileSync(path.join(LEDGER_DIR, name), 'utf8'));
      // 파일 이름이 정체다. 본문의 itemId 가 어긋나면 그 파일을 쓴 쪽이 규칙을 어긴 것이니
      // 둘 다 리뷰된 것으로 세어 다시 집히지 않게 한다.
      if (body?.itemId && body.itemId !== itemId) entries.push({ itemId: body.itemId, kind: body.kind });
      reviewedAt = body?.reviewedAt;
      kind = body?.kind;
    } catch {
      // 본문이 깨져도 이름만으로 리뷰된 것으로 센다. 깨진 파일 때문에 다시 리뷰하면 중복이다.
    }
    entries.push({ itemId, kind, reviewedAt });
  }
  return entries;
}

function readModules() {
  try {
    const body = JSON.parse(readFileSync(MODULES_PATH, 'utf8'));
    const modules = Array.isArray(body) ? body : body?.modules;
    return Array.isArray(modules) ? modules : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const report = buildQueue({
  commits: readCommits(),
  modules: readModules(),
  ledger: readLedger(),
  now: Math.floor(Date.now() / 1000),
  commitWindowDays: windowDays,
});

const queue = {
  generatedAt: new Date().toISOString(),
  branch,
  commitWindowDays: windowDays,
  remaining: report.remaining,
  counts: report.counts,
  ledgerDuplicates: report.ledgerDuplicates,
  items: report.items,
};

if (shouldWrite) {
  // 저장되는 것은 **세어 둔 수**뿐이다. 항목 목록까지 적으면 수천 줄짜리 파일을 레인 열 개가
  // 회차마다 통째로 다시 써서 반영마다 충돌한다. 목록이 필요한 레인은 러너를 직접 돌린다.
  const { items: _items, ...counted } = queue;
  mkdirSync(REVIEW_DIR, { recursive: true });
  writeFileSync(QUEUE_PATH, `${JSON.stringify(counted, null, 2)}\n`, 'utf8');
}

if (asJson) {
  console.log(JSON.stringify(queue, null, 2));
} else {
  const { commit, module: moduleCount, expired, reviewed } = report.counts;
  console.log(
    `남은 일감 ${report.remaining}건 (커밋 ${commit} · 모듈 ${moduleCount}) / 리뷰됨 ${reviewed} · 창 밖 ${expired} · 기준 ${branch}`,
  );
  for (const item of report.items.slice(0, 10)) {
    console.log(`  ${item.itemId}  ${item.kind}  ${item.title}`);
  }
  if (report.items.length > 10) console.log(`  ... 그 밖 ${report.items.length - 10}건`);
}

if (report.ledgerDuplicates.length > 0) {
  console.error(`장부에 중복 리뷰가 적혀 있다: ${report.ledgerDuplicates.join(', ')}`);
  process.exit(1);
}
