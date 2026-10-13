// 프로젝트 메뉴 고도화 회차의 채점 규칙.
//
// 회차는 "구현했습니다"라는 말을 증거로 받지 않는다. 수용 점검표(docs/project-menu/acceptance.json)의
// 각 점검을 제품이 실제로 읽는 계약 — remote.rs 디스패치·변경 명령 분류표, system_mcp.rs 능력 등록,
// ipcProjects.ts 래퍼, AGENTS.md 예외, 저장소 시험 — 위에서 다시 확인한다.
//
// 이 파일은 순수 함수만 담는다. 파일을 읽는 일은 scripts/project-menu-conformance.mjs가 한다.
// 그래야 틀리기 쉬운 쪽(맞추기 규칙과 실패 종류 분류)에 단위 시험을 붙일 수 있다.

export type CheckKind =
  | 'rustSymbol'
  | 'frontendSymbol'
  | 'remoteDispatch'
  | 'remoteWriteGate'
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
  /**
   * forbiddenLiterals에서 금지 "계열"을 묻는 정규식. 문자열 목록은 계열을 표현하지 못한다 —
   * C16-4가 금지한 것은 `--force` 하나가 아니라 어떤 `--force*`도이고, `"--force"`라는 문자열은
   * `"--force-with-lease"`를 보지 못한다(2026-10-04 실측, 아래 forbiddenLiterals 주석).
   */
  patterns?: string[];
  /** remoteWriteGate에서 "분류표에 없어야 한다"를 물을 때 false. 기본 true. */
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

/**
 * Rust 시험 선언의 상태. 이름이 있는 것만으로는 그 시험이 **돈다**는 뜻이 아니다 —
 * `#[ignore]` 한 줄이면 cargo 는 그 시험을 실패가 아니라 ignored 로 세므로 전건이 녹색으로 남는다.
 * 그래서 `fn <이름>(` 바로 앞에 붙은 특성 줄을 함께 읽는다. 중간에 빈 줄이나 주석(`//`, `///`)이
 * 끼어도 특성 묶음은 이어진 것으로 본다 — 시험 앞에 설명을 다는 것은 이 저장소의 흔한 모양이다.
 */
export function rustTestDeclaration(
  text: string,
  name: string,
): 'ok' | 'ignored' | 'notATest' | 'missing' {
  const index = text.indexOf(`fn ${name}(`);
  if (index < 0) return 'missing';
  const before = text.slice(0, index).split('\n');
  // `fn` 줄 자체(`async fn` 같은 수식어가 붙은 마지막 조각)를 버리고 위로 올라간다.
  before.pop();
  const attributes: string[] = [];
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const line = before[i].trim();
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('#[')) {
      attributes.push(line);
      continue;
    }
    break;
  }
  const joined = attributes.join(' ');
  if (/#\[\s*ignore/.test(joined)) return 'ignored';
  // `#[test]`, `#[tokio::test]`, `#[test(...)]` 를 모두 받는다.
  if (!/#\[\s*[\w:]*\btest\b/.test(joined)) return 'notATest';
  return 'ok';
}

/**
 * node:test 시험 선언의 상태. Rust 쪽 `#[ignore]` 와 **같은 구멍의 프런트 쪽 모양**이다.
 * 2026-10-04 실측: `test("diff를 싣지 않는다", …)` 를 `test.skip(…)` 으로 바꾸고
 * `test("readOnly …", { skip: true }, …)` 로 바꿔도 탐침은 35/35 · 97/97 녹색을 유지했다.
 * 제목 문자열이 파일에 그대로 남아 있어 단순 부분 문자열 일치가 통과하고, node:test 는
 * 건너뛴 시험을 실패가 아니라 통과 점(dot)으로 세므로 단위 전건도 녹색이다 — 즉 한 줄로
 * A2(요청에 diff 를 싣지 않는다)·A4(분석 모드 기본 읽기 전용)의 유일한 회귀 시험을 끄고도
 * 모든 관문을 지날 수 있었다.
 *
 * 그래서 이름이 **시험 제목 자리**에 있는지, 그리고 그 선언이 꺼져 있지 않은지를 함께 본다.
 * - `missing`  이름이 제목 자리에 없다(import 줄이나 다른 단언 안에만 있는 경우).
 * - `skipped`  `test.skip` / `it.skip` / `.todo`, 또는 제목 뒤 옵션 객체의 `skip` / `todo`.
 * `.only` 와 `.concurrent` 는 그 시험을 끄지 않으므로 통과시킨다.
 * `describe` 까지 받는다 — `describe.skip` 은 그 안의 시험을 통째로 끄므로 `test.skip` 과
 * 같은 끄기이고, 받지 않으면 묶음 제목을 이름으로 쓰는 점검이 생길 때 조용히 통과한다.
 */
export function nodeTestDeclaration(text: string, name: string): 'ok' | 'skipped' | 'missing' {
  const quoted = `(['"\`])${escapeRegExp(name)}\\3`;
  const call = new RegExp(
    `(^|[^\\w.$])(?:test|it|describe)((?:\\.\\w+)*)\\s*\\(\\s*${quoted}([\\s\\S]{0,160})`,
    'g',
  );
  let sawTitle = false;
  for (let match = call.exec(text); match !== null; match = call.exec(text)) {
    sawTitle = true;
    const modifiers = match[2] ?? '';
    if (/\.(?:skip|todo)\b/.test(modifiers)) continue;
    // `test("제목", { skip: true }, fn)` — 제목 뒤 옵션 객체도 같은 끄기다. 콜백이 시작되면
    // 거기서 멈춘다. 그 뒤는 시험 본문이고, 본문에 적힌 `skip: true` 는 선언이 아니라 자료다.
    const after = match[4] ?? '';
    const bodyAt = after.search(/\basync\b|\bfunction\b|=>/);
    const head = bodyAt < 0 ? after : after.slice(0, bodyAt);
    // `skip: false` 는 끈 것이 아니다. 부정 선행(`(?!false)`)으로 적으면 `\s*` 가 빈 문자열로
    // 되감겨 공백 앞에서 성립해 버리므로, 값을 집어 와서 비교한다.
    const option = /\{[\s\S]*?\b(skip|todo)\s*:\s*([^,}\s]+)/.exec(head);
    if (option && option[2] !== 'false') continue;
    return 'ok';
  }
  return sawTitle ? 'skipped' : 'missing';
}

/**
 * 주석을 같은 길이의 공백으로 덮는다(줄바꿈은 그대로). 문자열 리터럴 안의 `//`는 코드다.
 *
 * 2026-10-04 실측. remote.rs의 진짜 디스패치 팔 `"snapshot_project_overlay" => {` 을 지우고
 * 그 자리에 `// "snapshot_project_overlay" => { … }` 한 줄만 남겼더니 탐침이
 * **39/39 · 124/124 녹색을 그대로** 냈다. 명령이 IPC로 닿지 않아 화면도 AIA도 overlay
 * 스냅샷을 영영 부르지 못하는 상태가 계약 점검 전부를 통과한 것이다.
 *
 * 악의를 가정하지 않는다 — 팔을 옮기면서 "여기 있던 것" 자국을 주석으로 남기는 것은
 * 흔한 습관이고, 그 한 줄이 remoteDispatch·ipcWrapper·frontendSymbol·rustSymbol·
 * aiaCapability를 전부 눈멀게 한다.
 *
 * 길이를 보존하는 이유는 `sliceFnBlock`이 오프셋으로 블록을 뗼기 때문이다. 길이가
 * 줄면 블록 경계가 어긋난다. 문자열을 건너뛰는 이유는 그 반대 방향의 오탐이다 —
 * `"https://…"` 안의 `//`를 주석으로 읽으면 살아 있는 코드가 지워져 멀정한 계약이
 * 실패로 뒤집힌다.
 */
export function stripComments(text: string, path: string): string {
  const rust = path.endsWith('.rs');
  const out = text.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < text.length && text[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      // Rust의 블록 주석은 중첩된다. TS는 중첩되지 않으므로 깊이를 세지 않는다.
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (rust && text[j] === '/' && text[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (text[j] === '*' && text[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (rust && c === 'r' && (text[i + 1] === '"' || text[i + 1] === '#')) {
      // r"..." / r#"..."# — 안에서는 백슬래시가 이스케이프가 아니다.
      let h = 0;
      let j = i + 1;
      while (text[j] === '#') {
        h += 1;
        j += 1;
      }
      if (text[j] === '"') {
        const close = '"' + '#'.repeat(h);
        const end = text.indexOf(close, j + 1);
        i = end < 0 ? text.length : end + close.length;
        continue;
      }
    }
    const opens = rust ? c === '"' : c === '"' || c === "'" || c === '`';
    if (opens) {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === c) {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** `fn <marker>` 선언부터 열 0의 닫는 중괄호까지. 목록 블록을 좁혀 보기 위한 것. */
export function sliceFnBlock(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start < 0) return '';
  const rest = text.slice(start);
  const end = rest.indexOf('\n}');
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * `#[cfg(test)]` 가 붙은 모듈 블록을 (길이를 보존한 채) 지운다. `rustSymbol` 이 읽을
 * 범위를 제품 코드로 좁히기 위한 것이다.
 *
 * 2026-10-04 실측: 이 좁힘이 없으면 `rustSymbol` 은 Rust **파일 전체**에서
 * `fn|struct|enum|const|static|type <이름>` 선언을 찾는다. project_overlays.rs 의 진짜
 * 선언 `pub fn exclude_project_overlay_paths(` 를 `…_MOVED` 로 바꿔 그 함수가 제품에서
 * 사라지게 한 뒤 `mod tests` 안에 `fn exclude_project_overlay_paths() {}` 한 줄을 두었더니
 * 탐침이 **42/42 · 142/142 녹색**을 그대로 냈다. 미끼가 일부러 둔 것일 필요도 없다 —
 * 시험 모듈에 같은 이름의 보조 함수나 상수를 두는 것은 흔한 모양이고, 제품 쪽 선언을
 * 지우거나 개명하면서 그 한 줄을 남기면 그대로 눈이 먼다. `rustSymbol` 점검은 36 갈래 중
 * 가장 많은 20 건이라 이 눈멂의 사정거리가 가장 넓다.
 *
 * 길이를 보존하는 이유는 `stripComments` 와 같다 — `sliceFnBlock` 이 오프셋으로 블록을
 * 떼므로 길이가 줄면 경계가 어긋난다. 블록 경계는 다른 슬라이서와 같은 규칙(열 0 의 닫는
 * 중괄호)이고, 제품의 시험 모듈은 전부 열 0 선언이다. `#[cfg(test)]` 뒤에 `mod` 가 바로
 * 오지 않으면(함수 하나에 붙은 경우 등) 그 한 줄만 지우고 지나간다 — 블록이 어디서 끝나는지
 * 모르는 채 지우면 살아 있는 제품 코드를 지운다.
 */
export function stripTestModules(text: string): string {
  const re = /^#\[cfg\(test\)\]\s*$/gm;
  const out = text.split('');
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const after = text.slice(match.index + match[0].length);
    const modAt = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+[A-Za-z0-9_]+\s*\{/.exec(after);
    let end: number;
    if (modAt) {
      const closing = after.indexOf('\n}', modAt[0].length);
      end = match.index + match[0].length + (closing < 0 ? after.length : closing + 2);
    } else {
      end = match.index + match[0].length;
    }
    for (let i = match.index; i < end; i += 1) if (out[i] !== '\n') out[i] = ' ';
  }
  return out.join('');
}

/**
 * `const SYSTEM_CAPABILITIES: &[SystemCapability] = &[` 목록의 본문만 떼어 낸다.
 * `aiaCapability` 가 읽을 범위다.
 *
 * 2026-10-04 실측: 이 좁힘이 없으면 `aiaCapability` 는 system_mcp.rs **파일 전체**에서
 * `capability!(<등급>, "<명령>"` 을 찾는다. 진짜 등재 줄
 * `capability!(Execute, "save_project_overlay_set", …)` 를 목록에서 통째로 지우고 `mod tests`
 * 안에 같은 모양의 상수 하나를 두었더니 탐침이 **42/42 · 142/142 녹색**을 그대로 냈다.
 * AIA 가 그 명령을 영영 볼 수 없는 상태(AGENTS.md 7절)가 계약 점검을 통과한 것이다. 미끼가
 * 일부러 둔 것일 필요도 없다 — 카탈로그 모양을 그대로 적는 시험이 같은 파일에 생기면 된다.
 *
 * 경계는 `sliceDispatchBlocks` 와 같은 규칙(열 0 의 닫는 괄호)이고 이 상수는 열 0 선언이다.
 */
export function sliceCapabilityTable(text: string): string {
  const re = /^(?:pub(?:\([^)]*\))?\s+)?const\s+SYSTEM_CAPABILITIES\s*:[^=]*=\s*&\[/m;
  const match = re.exec(text);
  if (!match) return '';
  const rest = text.slice(match.index);
  const end = rest.indexOf('\n];');
  return end < 0 ? rest : rest.slice(0, end);
}

/**
 * `export function <이름>(` 블록만 이어 붙인다. `ipcWrapper` 가 읽을 범위다.
 *
 * 2026-10-04 실측: 이 좁힘이 없으면 `ipcWrapper` 는 ipcProjects.ts **파일 전체**에서
 * `"<명령>"` 문자열 하나를 찾는다. `snapshotProjectOverlay` 가 부르는 이름을
 * `"snapshot_project_overlay_MOVED"` 로 바꿔 화면이 그 명령에 영영 닿지 못하게 만든 뒤 파일
 * 맨 위에 옛 이름을 담은 상수 배열 한 줄을 두었더니 탐침이 **42/42 · 142/142 녹색**을 그대로
 * 냈다. 이름이 어딘가 남아 있는지 묻는 점검은 래퍼가 살아 있는지 묻지 않는다.
 *
 * 경계는 `sliceDispatchBlocks` 와 같은 규칙(열 0 의 닫는 중괄호)이다. `async` 도 집는다.
 */
export function sliceExportedFnBlocks(text: string): string {
  const re = /^export\s+(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*[(<]/gm;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const rest = text.slice(match.index);
    const end = rest.indexOf('\n}');
    blocks.push(end < 0 ? rest : rest.slice(0, end));
  }
  return blocks.join('\n');
}

/**
 * `fn dispatch_*(` 로 시작하는 함수 블록만 이어 붙인다. `remoteDispatch` 가 읽을 범위다.
 *
 * 2026-10-04 실측: 이 좁힘이 없으면 `remoteDispatch` 는 remote.rs **파일 전체**에서
 * `"<명령>" =>` 를 찾는다. 진짜 팔을 `"snapshot_project_overlay_MOVED" =>` 로 바꿔 그
 * 명령이 IPC 로 영영 닿지 못하게 만든 뒤, `mod tests` 안에 같은 문자열을 쓰는 보조 함수
 * 하나를 두었더니 탐침이 **42/42 · 142/142 녹색**을 그대로 냈다. 시험 모듈의 한 줄이
 * 살아 있는 계약 행세를 한 것이다. 미끼가 일부러 둔 것일 필요도 없다 — 명령 이름을
 * 문자열로 쓰는 파수꾼 시험이 이미 remote.rs 안에 여럿 있다.
 *
 * 블록 경계는 `sliceFnBlock` 과 같은 규칙(열 0 의 닫는 중괄호)이고, 디스패치 함수는
 * 전부 열 0 선언이다. `pub`·`async` 가 붙어도 집도록 열어 둔다.
 */
export function sliceDispatchBlocks(text: string): string {
  const re = /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+dispatch_[A-Za-z0-9_]*\s*\(/gm;
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const rest = text.slice(match.index);
    const end = rest.indexOf('\n}');
    blocks.push(end < 0 ? rest : rest.slice(0, end));
  }
  return blocks.join('\n');
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

/** 주석·시험 모듈 해석을 적용할 수 있는 코드 파일. */
const CODE_FILE_RE = /\.(rs|ts|tsx|js|jsx|mjs|cjs)$/;

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

/** `needFile`과 같되, 살아 있는 계약만 보도록 주석을 지운 본문을 돌려준다. */
function needCode(
  check: ConformanceCheck,
  files: FileMap,
  path: string | undefined,
): string | CheckResult {
  const text = needFile(check, files, path);
  if (typeof text !== 'string') return text;
  return stripComments(text, path ?? '');
}

export function evaluateCheck(check: ConformanceCheck, files: FileMap): CheckResult {
  switch (check.kind) {
    case 'rustSymbol': {
      const text = needCode(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.symbol) return fail(check, 'symbol이 비었다');
      // 파일 전체가 아니라 mod tests 밖만 본다(stripTestModules 주석의 실측).
      const scope = stripTestModules(text);
      const re = new RegExp(
        `\\b(fn|struct|enum|const|static|type)\\s+${escapeRegExp(check.symbol)}\\b`,
      );
      return re.test(scope)
        ? pass(check)
        : fail(check, `${check.file}의 제품 코드에 ${check.symbol} 선언이 없다`);
    }
    case 'frontendSymbol': {
      const text = needCode(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.symbol) return fail(check, 'symbol이 비었다');
      // 부분 문자열이 아니라 **온전한 이름**으로 본다(2026-10-04 실측).
      // ProjectOverlayPanel.tsx 의 `export function ProjectOverlayPanel(` 를
      // `ProjectOverlayPanelV2(` 로 개명하는 것만으로 — 미끼를 하나도 두지 않고 —
      // 탐침이 42/42 · 142/142 녹색을 그대로 냈다. 예전 이름이 새 이름의 앞머리라
      // 부분 문자열로는 그대로 걸리기 때문이다 — 화면에 그 이름이 더는 없는데도.
      // 경계 문자집합은 symbol 의 종류를 따른다. JS 식별자면 `$` 도 이어지는 문자라
      // 배제해야 `foo$bar` 가 `foo` 로 읽히지 않는다. 그러나 B9.ui 같은 CSS 클래스
      // (`git-change-path-button`)는 식별자가 아니고 제품에서 템플릿 보간이 바로 뒤에
      // 붙어(`...button${...}`) `$` 를 배제하면 살아 있는 계약을 오탄한다(2026-10-04 실측).
      const identifierLike = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(check.symbol);
      const edge = identifierLike ? 'A-Za-z0-9_$' : 'A-Za-z0-9_';
      const bounded = new RegExp(
        `(?<![${edge}])${escapeRegExp(check.symbol)}(?![${edge}])`,
      );
      return bounded.test(text)
        ? pass(check)
        : fail(check, `${check.file}에 ${check.symbol}이 온전한 이름으로 없다`);
    }
    case 'remoteDispatch': {
      const text = needCode(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.command) return fail(check, 'command가 비었다');
      // 파일 전체가 아니라 디스패치 함수 블록 안만 본다(sliceDispatchBlocks 주석의 실측).
      const scope = sliceDispatchBlocks(text);
      if (!scope) return fail(check, `${check.file}에 fn dispatch_* 블록이 없다`);
      const re = new RegExp(`"${escapeRegExp(check.command)}"\\s*=>`);
      return re.test(scope)
        ? pass(check)
        : fail(check, `remote 디스패치(fn dispatch_*)에 ${check.command}이 없다`);
    }
    case 'remoteWriteGate': {
      const text = needCode(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.command) return fail(check, 'command가 비었다');
      // C20 뒤 `fn is_write_command(` 는 게이트가 아니라 **변경 명령 분류표**다 — 로그인한
      // 채널은 모두 데스크톱과 같은 권한이라 원격 읽기 전용 모드도 호스트 전용 목록
      // (`is_host_only_command`, 삭제됨)도 없다. 그래도 이 블록은 어느 명령이 변경이고 어느
      // 명령이 읽기인지 적는 유일한 표이므로, 변경 명령이 빠지거나 읽기가 변경으로 적히는
      // 것을 여기서 잡는다.
      //
      // 마커에 여는 괄호까지 붙인다. 2026-10-04 실측: 괄호가 없으면 `indexOf`가 **이름이 같은
      // 접두사로 시작하는 다른 함수**를 먼저 집는다. `is_write_command` 바로 위에
      // `fn is_write_command_for_actor(`를 두고 진짜 분류표에서 `apply_project_overlay` 한 줄을
      // 지웠더니 탐침이 35/35 · 97/97 녹색을 그대로 유지했다. 미끼가 일부러 둔 것이 아니어도
      // 된다: `is_write_command_for_actor` 같은 보조 함수나 같은 접두사의 시험 함수를 분류표보다
      // 위에 적는 순간 아홉 개 분류표 점검이 전부 그쪽을 읽는다. 함수 이름이 고정이므로
      // `fn <이름>(` 전체를 요구하면 접두사 충돌 자체가 성립하지 않는다.
      const marker = 'fn is_write_command(';
      const block = sliceFnBlock(text, marker);
      if (!block) return fail(check, `${marker} 블록을 찾지 못했다`);
      const listed = block.includes(`"${check.command}"`);
      const expected = check.expect ?? true;
      if (listed === expected) return pass(check);
      return fail(check, `${check.command}이 변경 명령 분류표에 ${expected ? '없다' : '들어 있다'}`);
    }
    case 'aiaCapability': {
      const text = needCode(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.command) return fail(check, 'command가 비었다');
      const access = check.access ?? 'Read';
      // 파일 전체가 아니라 SYSTEM_CAPABILITIES 목록 안만 본다(sliceCapabilityTable 주석의 실측).
      const scope = sliceCapabilityTable(text);
      if (!scope) return fail(check, `${check.file}에 SYSTEM_CAPABILITIES 목록이 없다`);
      const re = new RegExp(
        `capability!\\(\\s*${escapeRegExp(access)}\\s*,\\s*"${escapeRegExp(check.command)}"`,
      );
      return re.test(scope)
        ? pass(check)
        : fail(check, `AIA 카탈로그에 ${check.command}이 ${access}로 등록되지 않았다`);
    }
    case 'ipcWrapper': {
      const text = needCode(check, files, check.file);
      if (typeof text !== 'string') return text;
      if (!check.command) return fail(check, 'command가 비었다');
      // 파일 전체의 문자열이 아니라 내보낸 함수 안의 `call(...)` 만 본다
      // (sliceExportedFnBlocks 주석의 실측). 래퍼의 계약은 이름이 어딘가 적혀 있는 것이
      // 아니라 그 명령을 **부르는** 것이다.
      const scope = sliceExportedFnBlocks(text);
      if (!scope) return fail(check, `${check.file}에 export function 블록이 없다`);
      const re = new RegExp(
        `\\bcall\\s*(?:<[^()<>]*>)?\\s*\\(\\s*"${escapeRegExp(check.command)}"`,
      );
      return re.test(scope)
        ? pass(check)
        : fail(check, `${check.file}의 내보낸 래퍼가 ${check.command}을 call로 부르지 않는다`);
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
      if (!check.file?.endsWith('.rs')) {
        const node = nodeTestDeclaration(text, check.name);
        if (node === 'missing') return fail(check, `${check.file}에 시험 ${check.name}이 없다`);
        if (node === 'skipped')
          return fail(check, `${check.file}의 시험 ${check.name}이 skip/todo로 꺼져 있다`);
        return pass(check);
      }
      // 이름만 보면 시험을 끄는 한 줄이 잡히지 않는다. 2026-10-03 실측: V1 파수꾼
      // project_git_c16_split_writes_between_remote_and_host_only 바로 위에 `#[ignore]` 한 줄을
      // 넣어도 탐침은 97/97 녹색을 유지했고(cargo 는 실패가 아니라 ignored 로 센다),
      // push_project_git 의 호스트 전용 고정이 꺼진 채로 모든 관문이 통과했다.
      // 그래서 선언까지 본다 — `fn` 앞의 특성 줄에 `#[test]` 가 있고 `#[ignore]` 가 없어야 한다.
      const state = rustTestDeclaration(text, check.name);
      if (state === 'missing') return fail(check, `${check.file}에 시험 ${check.name}이 없다`);
      if (state === 'ignored')
        return fail(check, `${check.file}의 시험 ${check.name}이 #[ignore]로 꺼져 있다`);
      if (state === 'notATest')
        return fail(check, `${check.file}의 ${check.name}에 #[test] 특성이 없다`);
      return pass(check);
    }
    case 'requiredLiterals':
    case 'forbiddenLiterals': {
      const paths = check.files ?? (check.file ? [check.file] : []);
      if (paths.length === 0) return fail(check, 'files가 비었다');
      const literals = check.literals ?? [];
      // 금지 계열은 정규식으로만 표현된다. 2026-10-04 실측: O7.forbidden이 금지 문자열 다섯
      // (`"--force"`·`"--hard"`·`"clean"`·`"--amend"`·`"checkout"`)만 보던 때,
      // project_overlays.rs의 git 인수 벡터에 `"--force-with-lease"`와 `"--rebase=interactive"`를
      // 끼워 넣어도 탐침은 35/35 · 97/97 녹색이었다. `"--force"`는 뒤의 따옴표까지 포함하는
      // 문자열이라 `"--force-with-lease"`에 들어 있지 않고, 대화형 rebase는 애초에 목록에 없었다.
      // 둘 다 C16-4가 "제공하지 않는다"고 못박은 명령이고, C19-3이 그 금지를 그대로 물려받는다.
      // 그래서 forbiddenLiterals는 문자열 목록과 정규식 목록 중 **하나만 있어도** 성립한다.
      const patterns = check.kind === 'forbiddenLiterals' ? (check.patterns ?? []) : [];
      if (literals.length === 0 && patterns.length === 0)
        return fail(
          check,
          check.kind === 'forbiddenLiterals' ? 'literals와 patterns가 모두 비었다' : 'literals가 비었다',
        );
      const compiled: { source: string; re: RegExp }[] = [];
      for (const source of patterns) {
        try {
          compiled.push({ source, re: new RegExp(source) });
        } catch {
          return fail(check, `정규식을 읽지 못했다 — ${source}`);
        }
      }
      const missing: string[] = [];
      const found: string[] = [];
      for (const path of paths) {
        const raw = files[path];
        if (raw === undefined) return fail(check, `${path}을 읽지 않았다`);
        // 아직 없는 파일은 required에서는 "가드 없음", forbidden에서는 "깨끗함"으로 센다.
        // 파일 전체가 아니라 **살아 있는 제품 코드**만 본다(2026-10-04 실측). O3.restore가
        // 날것 그대로 읽던 때, project_overlays.rs의 되돌림 인수 벡터에서 `"--source=HEAD"`와
        // `"--worktree"`를 빼고 `"--staged"` 하나로 바꿔도 탐침은 42/42 · 142/142 녹색이었다.
        // 그 둘이 바로 위 문서 주석(C19-3 설명)과 `mod tests`의 가드 시험 목록에 같은 모양으로
        // 적혀 있기 때문이다. 그 상태의 제품은 작업 트리를 되돌리지 않고 인덱스만 내리므로
        // C19-3이 약속한 되돌림이 통째로 꺼진다. 주석과 시험 모듈은 계약을 지키지 않는다.
        // 금지 쪽도 같은 범위다 — 주석에 적은 `--force`는 어떤 git도 실행하지 않으므로
        // 그것으로 붉게 만들면 오탐이고, 시험 모듈이 금지 문자열을 이름으로 거는 것도 같다.
        // 주석 해석은 코드 파일에만 쓴다. AGENTS.md나 JSON에 같은 규칙을 대면 `https://`의
        // 두 빗금이 주석 시작으로 읽혀 살아 있는 문장이 지워진다(R2.clauses·O11.guide).
        const text = raw === null ? null : CODE_FILE_RE.test(path) ? stripTestModules(stripComments(raw, path)) : raw;
        for (const literal of literals) {
          const present = text !== null && text.includes(literal);
          if (check.kind === 'requiredLiterals' && !present) missing.push(`${path}:${literal}`);
          if (check.kind === 'forbiddenLiterals' && present) found.push(`${path}:${literal}`);
        }
        for (const { source, re } of compiled) {
          if (text !== null && re.test(text)) found.push(`${path}:/${source}/`);
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
