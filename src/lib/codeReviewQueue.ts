// 에이전트매니저 코드리뷰 회차의 일감 큐와 중복 방지 규칙.
//
// 이 회차는 레인 10개가 동시에 돈다. 두 레인이 같은 커밋이나 같은 모듈을 리뷰하면 토큰만
// 두 배로 쓰고 같은 지적을 두 번 남긴다. 그래서 "무엇을 리뷰했는가"는 말이 아니라 **항목
// id** 로 적고, 그 id 를 만드는 규칙을 여기 한 곳에 둔다. 규칙이 두 곳에 있으면 같은 대상이
// 레인마다 다른 id 를 받아 점유가 성립하지 않는다.
//
// 이 파일은 순수 함수만 담는다. git 을 부르고 파일을 읽는 일은 scripts/code-review-queue.mjs
// 가 한다. 그래야 틀리기 쉬운 쪽(id 규칙과 중복 판정)에 단위 시험을 붙일 수 있다.

export type ReviewKind = 'commit' | 'module';

export interface CommitInput {
  /** git 해시. 길이는 7자 이상이면 되고 대소문자는 가리지 않는다. */
  hash: string;
  /** 커밋 시각(초). git log %ct. */
  timestamp: number;
  subject?: string;
}

export interface ModuleInput {
  /** 저장소 기준 상대 경로. 모듈 항목의 정체는 경로다. */
  path: string;
  title?: string;
  /** 점검표에 적힌 순서. 작을수록 먼저 고른다. */
  order?: number;
}

export interface LedgerEntry {
  itemId: string;
  kind?: ReviewKind;
  /** 리뷰한 시각. 장부 파일에 적히는 그대로의 ISO 8601 문자열이다(docs/code-review/README.md). */
  reviewedAt?: string;
}

export interface QueueItem {
  itemId: string;
  kind: ReviewKind;
  /** 커밋이면 해시, 모듈이면 경로. */
  ref: string;
  title: string;
}

export interface BuildQueueInput {
  commits?: CommitInput[];
  modules?: ModuleInput[];
  ledger?: LedgerEntry[];
  /** 지금(초). 커밋 창을 재는 기준. */
  now: number;
  /** 이 일수보다 오래된 미리뷰 커밋은 큐에서 떨어뜨린다. 기본 7일. */
  commitWindowDays?: number;
}

export interface QueueReport {
  items: QueueItem[];
  remaining: number;
  counts: { commit: number; module: number; expired: number; reviewed: number };
  /** 장부에 같은 항목 id 가 두 번 이상 적힌 것. 중복 리뷰가 실제로 일어났다는 증거다. */
  ledgerDuplicates: string[];
}

const HEX = /^[0-9a-f]+$/;

/** FNV-1a 32비트. 슬러그가 겹쳐도 항목 id 는 겹치지 않게 하는 꼬리표를 만든다. */
export function fingerprint(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** 경로를 한 표기로 누른다. Windows 레인이 적은 역슬래시 경로가 다른 항목이 되면 안 된다. */
function normalizePath(input: unknown): string {
  return String(input ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

/**
 * 커밋 하나의 항목 id. 짧은 해시로 들어오든 긴 해시로 들어오든, 대문자로 적혀 있든
 * 같은 커밋이면 같은 id 가 나와야 한다 — 그래야 점유가 레인을 가로질러 성립한다.
 */
export function commitItemId(hash: string): string {
  const normalized = String(hash ?? '').trim().toLowerCase();
  if (normalized.length < 7 || !HEX.test(normalized)) {
    throw new Error(`커밋 해시로 볼 수 없다: ${JSON.stringify(hash)}`);
  }
  return `C-${normalized.slice(0, 12)}`;
}

/**
 * 모듈 하나의 항목 id. 슬러그만 쓰면 `a/b.rs` 와 `a-b.rs` 가 같은 id 를 받아 한쪽이
 * 영영 리뷰되지 않는다. 경로 원문의 지문을 꼬리에 붙여 그 일이 생기지 않게 한다.
 */
export function moduleItemId(path: string): string {
  const normalized = normalizePath(path);
  if (normalized.length === 0) throw new Error('모듈 경로가 비어 있다');
  return `M-${slug(normalized)}-${fingerprint(normalized)}`;
}

/**
 * 결함 하나의 지문. 두 레인이 서로 다른 커밋에서 같은 결함을 발견했을 때 티켓이 둘
 * 생기지 않게 한다. 증상 문구는 사람이 적으므로 슬러그로 눌러 비교한다.
 */
export function findingId(input: { file: string; symptom: string; symbol?: string }): string {
  const file = normalizePath(input?.file);
  const symptom = String(input?.symptom ?? '').trim();
  if (file.length === 0 || symptom.length === 0) {
    throw new Error('결함 지문에는 파일과 증상이 모두 필요하다');
  }
  const symbol = String(input?.symbol ?? '').trim();
  const key = `${file}::${symbol}::${slug(symptom)}`;
  return `F-${slug(`${file}-${symbol}`)}-${fingerprint(key)}`;
}

/** 장부를 항목 id 집합으로 누른다. 같은 id 가 두 번 적혀 있으면 함께 돌려준다. */
export function ledgerIndex(ledger: LedgerEntry[] = []): { reviewed: Set<string>; duplicates: string[] } {
  const reviewed = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of ledger) {
    const itemId = String(entry?.itemId ?? '').trim();
    if (itemId.length === 0) continue;
    if (reviewed.has(itemId)) {
      if (!duplicates.includes(itemId)) duplicates.push(itemId);
      continue;
    }
    reviewed.add(itemId);
  }
  return { reviewed, duplicates };
}

/**
 * 큐를 만든다. 커밋이 먼저고 모듈이 뒤다 — 갓 들어온 결함을 먼저 잡고, 창 밖으로 밀려난
 * 것은 모듈 전수 리뷰가 그물로 받는다. 커밋을 오래된 것부터 돌리면 매일 들어오는 백 건에
 * 밀려 새 결함을 영영 못 보고, 창 없이 최신부터만 돌리면 오래된 것이 굶는다.
 */
export function buildQueue(input: BuildQueueInput): QueueReport {
  const now = Number(input?.now);
  if (!Number.isFinite(now)) throw new Error('now 는 초 단위 숫자여야 한다');
  const windowDays = input?.commitWindowDays ?? 7;
  const floor = now - windowDays * 86400;

  const { reviewed, duplicates } = ledgerIndex(input?.ledger ?? []);
  const items: QueueItem[] = [];
  const seen = new Set<string>();
  let expired = 0;

  const commits = [...(input?.commits ?? [])].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  for (const commit of commits) {
    const itemId = commitItemId(commit.hash);
    if (reviewed.has(itemId) || seen.has(itemId)) continue;
    seen.add(itemId);
    if (Number(commit.timestamp) < floor) {
      expired += 1;
      continue;
    }
    items.push({
      itemId,
      kind: 'commit',
      ref: String(commit.hash).trim().toLowerCase(),
      title: String(commit.subject ?? '').trim() || String(commit.hash).slice(0, 12),
    });
  }

  const modules = [...(input?.modules ?? [])].sort(
    (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
  );
  for (const module of modules) {
    const itemId = moduleItemId(module.path);
    if (reviewed.has(itemId) || seen.has(itemId)) continue;
    seen.add(itemId);
    items.push({
      itemId,
      kind: 'module',
      ref: normalizePath(module.path),
      title: String(module.title ?? '').trim() || String(module.path),
    });
  }

  const counts = {
    commit: items.filter((item) => item.kind === 'commit').length,
    module: items.filter((item) => item.kind === 'module').length,
    expired,
    reviewed: reviewed.size,
  };
  return { items, remaining: items.length, counts, ledgerDuplicates: duplicates };
}

/** 이미 점유된 항목을 건너뛰고 이 레인이 집을 것 하나를 고른다. 없으면 null. */
export function pickItem(items: QueueItem[], takenItemIds: Iterable<string> = []): QueueItem | null {
  const taken = new Set(takenItemIds);
  for (const item of items) {
    if (!taken.has(item.itemId)) return item;
  }
  return null;
}
