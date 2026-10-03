// 프로젝트 메뉴 고도화 회차의 채점 규칙.
//
// 회차는 "구현했습니다"라는 말을 증거로 받지 않는다. 수용 점검표(docs/project-menu/acceptance.json)의
// 각 점검을 제품이 실제로 읽는 계약 — remote.rs 디스패치·쓰기 게이트, system_mcp.rs 능력 등록,
// ipcProjects.ts 래퍼, AGENTS.md 예외, 저장소 시험 — 위에서 다시 확인한다.
//
// 이 파일은 순수 함수만 담는다. 파일을 읽는 일은 scripts/project-menu-conformance.mjs가 한다.
// 그래야 틀리기 쉬운 쪽(맞추기 규칙과 실패 종류 분류)에 단위 시험을 붙일 수 있다.

export type CheckKind =
  | 'rustSymbol'
  | 'frontendSymbol'
  | 'remoteDispatch'
  | 'remoteWriteGate'
  | 'remoteHostOnly'
  | 'aiaCapability'
  | 'ipcWrapper'
  | 'agentsRule'
  | 'testNamed'
  | 'requiredLiterals'
  | 'forbiddenLiterals';

export type CheckCategory = 'impl' | 'contract' | 'test' | 'safety';

export type FailureKind = '회귀' | '안전규칙위반' | '미구현' | '계약누락' | '검증없음';

/** 분류 우선순위. 한 항목은 가장 앞선 종류 하나로만 센다. */
export const FAILURE_KIND_ORDER: FailureKind[] = [
  '회귀',
  '안전규칙위반',
  '미구현',
  '계약누락',
  '검증없음',
];

const DEFAULT_CATEGORY: Record<CheckKind, CheckCategory> = {
  rustSymbol: 'impl',
  frontendSymbol: 'impl',
  remoteDispatch: 'contract',
  remoteWriteGate: 'contract',
  remoteHostOnly: 'contract',
  aiaCapability: 'contract',
  ipcWrapper: 'contract',
  agentsRule: 'contract',
  testNamed: 'test',
  requiredLiterals: 'impl',
  forbiddenLiterals: 'safety',
};

export interface ConformanceCheck {
  id: string;
  kind: CheckKind;
  /** 사람이 읽을 한 줄. 실패 사유에 그대로 붙는다. */
  title: string;
  category?: CheckCategory;
  file?: string;
  files?: string[];
  symbol?: string;
  command?: string;
  access?: string;
  name?: string;
  literals?: string[];
  /** remoteWriteGate·remoteHostOnly에서 "목록에 없어야 한다"를 물을 때 false. 기본 true. */
  expect?: boolean;
}

export interface ConformanceItem {
  id: string;
  stage: string;
  title: string;
  checks: ConformanceCheck[];
}

export interface Checklist {
  version: number;
  source?: string;
  items: ConformanceItem[];
}

export interface CheckResult {
  id: string;
  kind: CheckKind;
  category: CheckCategory;
  title: string;
  ok: boolean;
  reason: string;
  /** 파일 자체가 없어서 실패한 점검. 아직 만들지 않은 것은 가드를 어긴 것이 아니다. */
  missingFile: boolean;
}

export interface ItemResult {
  id: string;
  stage: string;
  title: string;
  ok: boolean;
  checks: CheckResult[];
}

export interface ChecklistResult {
  items: ItemResult[];
  totalItems: number;
  passedItems: number;
  totalChecks: number;
  passedChecks: number;
}

export type FileMap = Record<string, string | null>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `fn <marker>` 선언부터 열 0의 닫는 중괄호까지. 목록 블록을 좁혀 보기 위한 것. */
export function sliceFnBlock(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const rest = text.slice(start);
  const end = rest.indexOf('\n}');
  return end < 0 ? rest : rest.slice(0, end);
}

export function checkCategory(check: ConformanceCheck): CheckCategory {
  return check.category ?? DEFAULT_CATEGORY[check.kind];
}

function fail(check: ConformanceCheck, reason: string, missingFile = false): CheckResult {
  return {
    id: check.id,
    kind: check.kind,
    category: checkCategory(check),
    title: check.title,
    ok: false,
    reason,
    missingFile,
  };
}

function pass(check: ConformanceCheck): CheckResult {
  return {
    id: check.id,
    kind: check.kind,
    category: checkCategory(check),
    title: check.title,
    ok: true,
    reason: '',
    missingFile: false,
  };
}

function needFile(
  check: ConformanceCheck,
  files: FileMap,
  path: string | undefined,
): string | CheckResult {
  if (!path) return fail(check, 'file이 비었다');
  const text = files[path];
  if (text === undefined) return fail(check, `${path}을 읽지 않았다`);
  if (text === null) return fail(check, `${path}이 없다`, true);
  return text;
}

export function evaluateCheck(check: ConformanceCheck, files: FileMap): CheckResult {
  switch (check.kind) {
    case 'rustSymbol': {
      const text = needFile(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.symbol) return fail(check, 'symbol이 비었다');
      const re = new RegExp(
        `\\b(fn|struct|enum|const|static|type)\\s+${escapeRegExp(check.symbol)}\\b`,
      );
      return re.test(text) ? pass(check) : fail(check, `${check.file}에 ${check.symbol} 선언이 없다`);
    }
    case 'frontendSymbol': {
      const text = needFile(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.symbol) return fail(check, 'symbol이 비었다');
      return text.includes(check.symbol)
        ? pass(check)
        : fail(check, `${check.file}에 ${check.symbol}이 없다`);
    }
    case 'remoteDispatch': {
      const text = needFile(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.command) return fail(check, 'command가 비었다');
      const re = new RegExp(`"${escapeRegExp(check.command)}"\\s*=>`);
      return re.test(text) ? pass(check) : fail(check, `remote 디스패치에 ${check.command}이 없다`);
    }
    case 'remoteWriteGate':
    case 'remoteHostOnly': {
      const text = needFile(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.command) return fail(check, 'command가 비었다');
      const marker =
        check.kind === 'remoteWriteGate' ? 'fn is_write_command' : 'fn is_host_only_command';
      const block = sliceFnBlock(text, marker);
      if (!block) return fail(check, `${marker} 블록을 찾지 못했다`);
      const listed = block.includes(`"${check.command}"`);
      const expected = check.expect ?? true;
      if (listed === expected) return pass(check);
      const label = check.kind === 'remoteWriteGate' ? '쓰기 게이트' : '호스트 전용 목록';
      return fail(check, `${check.command}이 ${label}에 ${expected ? '없다' : '들어 있다'}`);
    }
    case 'aiaCapability': {
      const text = needFile(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.command) return fail(check, 'command가 비었다');
      const access = check.access ?? 'Read';
      const re = new RegExp(
        `capability!\\(\\s*${escapeRegExp(access)}\\s*,\\s*"${escapeRegExp(check.command)}"`,
      );
      return re.test(text)
        ? pass(check)
        : fail(check, `AIA 카탈로그에 ${check.command}이 ${access}로 등록되지 않았다`);
    }
    case 'ipcWrapper': {
      const text = needFile(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.command) return fail(check, 'command가 비었다');
      return text.includes(`"${check.command}"`)
        ? pass(check)
        : fail(check, `${check.file}에 ${check.command} 래퍼가 없다`);
    }
    case 'agentsRule': {
      const text = needFile(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.name) return fail(check, 'name이 비었다');
      const re = new RegExp(`^###\\s+${escapeRegExp(check.name)}\\s+—`, 'm');
      return re.test(text) ? pass(check) : fail(check, `AGENTS.md에 ${check.name} 예외 절이 없다`);
    }
    case 'testNamed': {
      const text = needFile(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.name) return fail(check, 'name이 비었다');
      const needle = check.file?.endsWith('.rs') ? `fn ${check.name}(` : check.name;
      return text.includes(needle)
        ? pass(check)
        : fail(check, `${check.file}에 시험 ${check.name}이 없다`);
    }
    case 'requiredLiterals':
    case 'forbiddenLiterals': {
      const paths = check.files ?? (check.file ? [check.file] : []);
      if (paths.length === 0) return fail(check, 'files가 비었다');
      const literals = check.literals ?? [];
      if (literals.length === 0) return fail(check, 'literals가 비었다');
      const missing: string[] = [];
      const found: string[] = [];
      for (const path of paths) {
        const text = files[path];
        if (text === undefined) return fail(check, `${path}을 읽지 않았다`);
        // 아직 없는 파일은 required에서는 "가드 없음", forbidden에서는 "깨끗함"으로 센다.
        for (const literal of literals) {
          const present = text !== null && text.includes(literal);
          if (check.kind === 'requiredLiterals' && !present) missing.push(`${path}:${literal}`);
          if (check.kind === 'forbiddenLiterals' && present) found.push(`${path}:${literal}`);
        }
      }
      if (check.kind === 'requiredLiterals') {
        if (missing.length === 0) return pass(check);
        const allMissingFiles = paths.every((path) => files[path] === null);
        return fail(check, `없다 — ${missing.join(', ')}`, allMissingFiles);
      }
      return found.length === 0
        ? pass(check)
        : fail(check, `금지된 문자열이 있다 — ${found.join(', ')}`);
    }
    default:
      return fail(check, `알 수 없는 점검 종류 ${(check as ConformanceCheck).kind}`);
  }
}

export function evaluateChecklist(checklist: Checklist, files: FileMap): ChecklistResult {
  const items: ItemResult[] = checklist.items.map((item) => {
    const checks = item.checks.map((check) => evaluateCheck(check, files));
    return {
      id: item.id,
      stage: item.stage,
      title: item.title,
      ok: checks.every((check) => check.ok),
      checks,
    };
  });
  const allChecks = items.flatMap((item) => item.checks);
  return {
    items,
    totalItems: items.length,
    passedItems: items.filter((item) => item.ok).length,
    totalChecks: allChecks.length,
    passedChecks: allChecks.filter((check) => check.ok).length,
  };
}

/** 점검 id → 통과 여부. 회차 사이 비교(회귀 검출)에 쓴다. */
export function checkOkMap(result: ChecklistResult): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const item of result.items) {
    for (const check of item.checks) map[check.id] = check.ok;
  }
  return map;
}

/**
 * 항목 하나의 실패 종류. 통과한 항목은 null.
 *
 * - 금지 문자열이 들어온 것은 구현 여부와 무관하게 안전규칙위반이다.
 * - 아직 구현되지 않은 항목의 빠진 가드는 위반이 아니라 미구현이다. 그래서 impl이 먼저다.
 */
export function classifyItem(
  item: ItemResult,
  previous?: Record<string, boolean>,
): FailureKind | null {
  if (item.ok) return null;
  const failed = item.checks.filter((check) => !check.ok);
  if (previous && failed.some((check) => previous[check.id] === true)) return '회귀';
  // 파일이 아직 없어서 실패한 점검은 어느 갈래로 적혔든 "아직 만들지 않은 것"이다.
  const effective = (check: CheckResult): CheckCategory =>
    check.missingFile ? 'impl' : check.category;
  if (failed.some((check) => check.kind === 'forbiddenLiterals' && !check.missingFile)) {
    return '안전규칙위반';
  }
  if (failed.some((check) => effective(check) === 'impl')) return '미구현';
  if (failed.some((check) => effective(check) === 'safety')) return '안전규칙위반';
  if (failed.some((check) => effective(check) === 'contract')) return '계약누락';
  if (failed.some((check) => effective(check) === 'test')) return '검증없음';
  return '미구현';
}

export interface FailureKindCount {
  kind: FailureKind;
  count: number;
  items: string[];
}

export function classifyFailureKinds(
  result: ChecklistResult,
  previous?: Record<string, boolean>,
): FailureKindCount[] {
  const buckets = new Map<FailureKind, string[]>();
  for (const item of result.items) {
    const kind = classifyItem(item, previous);
    if (!kind) continue;
    const list = buckets.get(kind) ?? [];
    list.push(item.id);
    buckets.set(kind, list);
  }
  return FAILURE_KIND_ORDER.filter((kind) => buckets.has(kind)).map((kind) => ({
    kind,
    count: buckets.get(kind)?.length ?? 0,
    items: buckets.get(kind) ?? [],
  }));
}

/** record_round_report의 failureKinds 모양. 0으로 내려간 종류도 남긴다 — 사라진 것이 보여야 한다. */
export function diffFailureKinds(
  before: FailureKindCount[],
  after: FailureKindCount[],
): Array<{ kind: FailureKind; before: number; after: number }> {
  const beforeMap = new Map(before.map((entry) => [entry.kind, entry.count]));
  const afterMap = new Map(after.map((entry) => [entry.kind, entry.count]));
  return FAILURE_KIND_ORDER.filter((kind) => beforeMap.has(kind) || afterMap.has(kind)).map(
    (kind) => ({
      kind,
      before: beforeMap.get(kind) ?? 0,
      after: afterMap.get(kind) ?? 0,
    }),
  );
}

/** 점검표가 판정에 쓸 만큼 넓은지. 표본이 좁으면 한 항목을 고치고 "좋아졌다"고 적게 된다. */
export const MIN_CHECKLIST_ITEMS = 20;

export function validateChecklist(checklist: Checklist): string[] {
  const problems: string[] = [];
  if (!Array.isArray(checklist.items)) return ['items가 배열이 아니다'];
  if (checklist.items.length < MIN_CHECKLIST_ITEMS) {
    problems.push(
      `점검 항목이 ${checklist.items.length}개다 — ${MIN_CHECKLIST_ITEMS}개 이상이어야 한다`,
    );
  }
  const seen = new Set<string>();
  for (const item of checklist.items) {
    if (seen.has(item.id)) problems.push(`항목 id가 겹친다 — ${item.id}`);
    seen.add(item.id);
    if (!item.checks || item.checks.length === 0) problems.push(`${item.id}에 점검이 없다`);
    for (const check of item.checks ?? []) {
      if (seen.has(check.id)) problems.push(`점검 id가 겹친다 — ${check.id}`);
      seen.add(check.id);
      if (!DEFAULT_CATEGORY[check.kind]) problems.push(`${check.id}의 kind가 알 수 없다 — ${check.kind}`);
    }
  }
  return problems;
}

/** 점검이 읽어야 하는 저장소 상대 경로 전부. 러너가 이것만 읽는다. */
export function requiredFiles(checklist: Checklist): string[] {
  const paths = new Set<string>();
  for (const item of checklist.items) {
    for (const check of item.checks) {
      if (check.file) paths.add(check.file);
      for (const path of check.files ?? []) paths.add(path);
    }
  }
  return [...paths].sort();
}
