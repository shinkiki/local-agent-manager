// 간헐 실패 시험 격리 회차가 쓰는 순수 판정 규칙.
//
// cargo 의 조용한 리포터(`-q`) 출력을 읽어 한 번의 실행을 구조로 바꾸고(parseCargoTestOutput),
// 여러 번의 실행을 모아 판정한다(summarizeRuns·failureKinds·verdict). 셸·파일을 건드리지 않아
// 단위 시험으로 고정할 수 있고, 러너(scripts/flaky-isolate.mjs)는 이 규칙만 부른다.
//
// 판정은 합격률이 아니라 실패 종류다. 합격 횟수는 참고 수치로만 싣는다.

/** 한 번의 `cargo test` 실행에서 읽어 낸 것. */
export type CargoRun = {
  /** 프로세스 종료 코드. 0 이 아니면 어떤 식으로든 실패다. */
  exitCode: number;
  passed: number;
  failed: number;
  ignored: number;
  filteredOut: number;
  /** 시험 바이너리가 보고한 소요 초. 빌드가 깨지면 null. */
  durationSeconds: number | null;
  /** 실패한 시험의 전체 경로와 그 진단 블록(panic 메시지·left/right·file:line). */
  failures: { name: string; diagnostic: string }[];
  /** 컴파일·링크가 깨져 시험이 돌지조차 못한 실행. 간헐 실패와 섞으면 안 된다. */
  buildError: boolean;
};

export type RunSummary = {
  target: string;
  runs: number;
  /** 시험 결과를 한 줄이라도 낸 실행 수. buildError 실행은 빠진다. */
  measuredRuns: number;
  /** 대상 시험이 실패한 실행 수. */
  targetFailedRuns: number;
  /** 어떤 시험이든 실패한 실행 수. */
  failedRuns: number;
  buildErrorRuns: number;
  /** 시험 이름 → 실패한 실행 수. 실패 횟수 내림차순, 같으면 이름순. */
  failureCountsByTest: { name: string; runs: number }[];
  /**
   * 진단 지문 → 그 지문이 나온 실행 수와 그 지문으로 깨진 시험 이름들. 실패 횟수 내림차순,
   * 같으면 지문순.
   *
   * 2·3회차 실측에서 깨진 시험 **이름**은 회차마다 달랐는데(여섯 모듈 → 네 모듈, 겹치는
   * 이름이 하나도 없다) **진단**은 글자 그대로 같은 하나가 반복됐다 —
   * `Io(os error 5 · PermissionDenied)`. 흔들리는 단위가 시험이 아니라 그 시험들이 공유하는
   * 저장 경로였기 때문이다. 이름으로만 세면 그 사실이 "매번 다른 시험이 한 번씩 깨진다"는
   * 잡음으로 보여, 사람이 로그를 눈으로 읽어야만 원인이 하나라는 것을 알 수 있었다.
   */
  failureCountsByDiagnostic: { signature: string; runs: number; tests: string[] }[];
  /** 대상 시험이 실제로 돌았는가. 필터를 잘못 적어 0 번 돈 것을 "통과"로 읽지 않는다. */
  targetObserved: boolean;
};

export type FailureKind = { kind: string; count: number };

export type Verdict =
  /** 모든 실행이 전건 통과. 재현되지 않았다. */
  | 'clean'
  /** 대상 시험이 한 번이라도 실패했다. */
  | 'target-flaky'
  /** 대상은 통과했지만 다른 시험이 간헐 실패했다. */
  | 'suite-flaky'
  /** 빌드·링크가 깨졌거나 대상 시험이 한 번도 돌지 않았다. 측정이 성립하지 않는다. */
  | 'broken';

const RESULT_LINE =
  /test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in ([\d.]+)s/g;

/** 조용한 리포터가 실패를 알리는 인라인 줄: `<이름> --- FAILED`. */
const INLINE_FAILED = /^(\S+) --- FAILED$/gm;

/** 진단 블록의 머리: `---- <이름> stdout ----`. */
const DIAGNOSTIC_HEAD = /^---- (\S+) stdout ----$/gm;

const BUILD_ERROR =
  /(^error\[E\d+\]|^error: could not compile|^error: linking with |^error: failed to run custom build)/m;

/**
 * 한 번의 실행 출력을 구조로 바꾼다. 시험 바이너리가 여럿이면 숫자는 더하고 실패는 이어 붙인다.
 *
 * 종료 코드만으로 판정하지 않는 이유: 빌드가 깨진 실행과 시험이 깨진 실행은 둘 다 0 이 아닌데,
 * 앞엣것은 간헐 실패의 증거가 아니라 측정 실패다.
 */
export function parseCargoTestOutput(stdout: string, exitCode: number): CargoRun {
  const text = stdout.replace(/\r\n/g, '\n');
  let passed = 0;
  let failed = 0;
  let ignored = 0;
  let filteredOut = 0;
  let durationSeconds: number | null = null;
  let sawResult = false;

  RESULT_LINE.lastIndex = 0;
  for (let match = RESULT_LINE.exec(text); match; match = RESULT_LINE.exec(text)) {
    sawResult = true;
    passed += Number(match[2]);
    failed += Number(match[3]);
    ignored += Number(match[4]);
    filteredOut += Number(match[6]);
    durationSeconds = (durationSeconds ?? 0) + Number(match[7]);
  }

  const names = new Set<string>();
  INLINE_FAILED.lastIndex = 0;
  for (let match = INLINE_FAILED.exec(text); match; match = INLINE_FAILED.exec(text)) {
    names.add(match[1]);
  }

  const diagnostics = new Map<string, string>();
  const heads: { name: string; start: number; end: number }[] = [];
  DIAGNOSTIC_HEAD.lastIndex = 0;
  for (let match = DIAGNOSTIC_HEAD.exec(text); match; match = DIAGNOSTIC_HEAD.exec(text)) {
    heads.push({ name: match[1], start: match.index, end: match.index + match[0].length });
  }
  for (const [index, head] of heads.entries()) {
    const next = heads[index + 1];
    const tail = text.slice(head.end, next ? next.start : undefined);
    // 마지막 블록 뒤에는 요약(`failures:` 목록과 `test result:`)이 붙는다. 진단만 남긴다.
    const cut = tail.search(/\n\nfailures:\n|\ntest result: /);
    diagnostics.set(head.name, (cut === -1 ? tail : tail.slice(0, cut)).trim());
    names.add(head.name);
  }

  const failures = [...names]
    .sort()
    .map((name) => ({ name, diagnostic: diagnostics.get(name) ?? '' }));

  return {
    exitCode,
    passed,
    failed,
    ignored,
    filteredOut,
    durationSeconds,
    failures,
    buildError: !sawResult && exitCode !== 0 && BUILD_ERROR.test(text),
  };
}

/** 진단 블록 머리의 panic 자리. 줄 번호가 붙어 있어 지문에서는 떼어 낸다. */
const PANIC_HEAD = /^thread '[^']*'(?: \(\d+\))? panicked at [^\n]*:\n/m;

/** `Io(Os { code: 5, kind: PermissionDenied, message: "..." })` 꼴의 OS 오류. */
const OS_ERROR = /Os \{ code: (\d+), kind: (\w+)/;

/** 지문이 길면 사람이 견주지 못한다. 첫 줄만 쓰고 그마저 자른다. */
const SIGNATURE_MAX = 120;

/**
 * 시험이 띄운 로컬 서버의 포트. 실행마다 비어 있는 포트를 고르므로 같은 원인이 매번 다른
 * 지문이 된다 — 2026-10-06 5회차 측정에서 `project_git::…c16_auth_failure…` 한 시험의 같은
 * 실패 2회가 포트(2150·6401)만 달라 지문 둘로 갈렸고, 둘 다 "1회"로 찍혀 2회짜리 한 원인이
 * 1회짜리 두 원인처럼 보였다. 호스트가 루프백일 때만 지운다 — 원격 주소의 포트는 원인을
 * 가르는 정보일 수 있다.
 *
 * `\b` 는 낱말 문자로 시작하는 갈래에만 붙인다 — `[::1]` 앞에 붙이면 `[` 가 낱말 문자가
 * 아니라서 앞이 `/` 든 줄머리든 경계가 서지 않아 그 갈래가 통째로 죽는다(2026-10-06 실측:
 * `http://[::1]:6401/am.git/` 이 그대로 남았다).
 */
const LOOPBACK_PORT = /(\b127\.0\.0\.1|\[::1\]|\blocalhost):\d+/g;

/**
 * 진단 블록 하나를 견줄 수 있는 지문 한 줄로 줄인다.
 *
 * OS 오류가 보이면 코드와 kind 만 남긴다 — `message` 는 OS 로캘을 타고("액세스가
 * 거부되었습니다") 경로는 실행마다 다른 tempdir 이라, 그대로 두면 같은 원인이 매번 다른
 * 지문이 된다. 그 밖에는 panic 메시지의 첫 줄을 쓴다. `left: …`/`right: …` 같은 뒷줄은
 * 값이 실행마다 달라지므로 넣지 않는다.
 *
 * 루프백 주소의 포트 번호도 지운다 — 시험이 띄운 로컬 서버는 실행마다 다른 포트를 잡는다.
 *
 * 그 밖에는 더 똑똑하게 정규화하지 않는다 — 과하게 묶으면 서로 다른 원인이 한 지문으로 합쳐져,
 * 이 축을 둔 이유가 사라진다. 3회차의 `assertion left == right: 2 != 3` 은 저장 경로와
 * 전혀 다른 원인이었고, 그 구분이 지문에 남아야 한다.
 */
export function diagnosticSignature(diagnostic: string): string {
  const text = diagnostic.replace(/\r\n/g, '\n');
  const osError = OS_ERROR.exec(text);
  if (osError) return `Io(os error ${osError[1]} · ${osError[2]})`;
  // 시험이 panic 전에 찍은 표준 출력이 진단 블록 앞에 함께 잡힌다. 그 줄을 지문으로 쓰면
  // 같은 출력을 내는 시험의 서로 다른 실패가 한 지문으로 묶인다 — panic 머리 뒤부터 읽는다.
  const panic = PANIC_HEAD.exec(text);
  const body = panic ? text.slice(panic.index + panic[0].length) : text;
  const first = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('note: run with'));
  if (!first) return '(진단 없음)';
  const stable = first.replace(LOOPBACK_PORT, '$1:<포트>');
  return stable.length > SIGNATURE_MAX ? `${stable.slice(0, SIGNATURE_MAX)}…` : stable;
}

/**
 * 진단 지문을 실패 종류로 본 축. `failureKinds` 와 같은 모양이라 `compareFailureKinds` 로
 * 그대로 전후 비교할 수 있다 — 2회차 보고가 "판정은 '진단이 code 5 인 실패 종류'가 사라졌는지로
 * 한다"로 남긴 다음 회차의 판정 축이 이것이다.
 *
 * `failureKinds` 의 셋(대상·다른 시험·빌드)을 바꾸지 않고 축을 더하는 이유: 그 셋은 기준선
 * 파일과 회차 절차가 이미 쓰고 있는 계약이라, 늘리면 지난 기준선과 견줄 수 없게 된다.
 */
export function diagnosticKinds(summary: RunSummary): FailureKind[] {
  return summary.failureCountsByDiagnostic.map((entry) => ({
    kind: entry.signature,
    count: entry.runs,
  }));
}

/**
 * 여러 실행을 모은다. `target` 은 대상 시험의 전체 경로(`모듈::tests::이름`)다.
 *
 * `targetObserved` 를 따로 두는 이유: 필터를 잘못 적으면 대상 시험이 한 번도 돌지 않고도 모든
 * 실행이 통과로 보인다. 그 통과를 "고쳐졌다"로 읽으면 회차가 아무것도 안 하고 끝난다.
 */
export function summarizeRuns(runs: CargoRun[], target: string): RunSummary {
  const counts = new Map<string, number>();
  const bySignature = new Map<string, { runs: number; tests: Set<string> }>();
  let targetFailedRuns = 0;
  let failedRuns = 0;
  let buildErrorRuns = 0;
  let measuredRuns = 0;

  for (const run of runs) {
    if (run.buildError) {
      buildErrorRuns += 1;
      continue;
    }
    measuredRuns += 1;
    const names = new Set(run.failures.map((failure) => failure.name));
    if (names.size > 0) failedRuns += 1;
    if (names.has(target)) targetFailedRuns += 1;
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    // 한 실행 안에서 같은 지문이 여러 시험에 걸쳐 나와도 그 실행은 1 회로 센다 — 옆에 적히는
    // 다른 숫자가 모두 "실행 수"인데 이것만 "실패 건수"면 나란히 두고 견줄 수 없다. 이름은
    // 전부 모은다: 어느 시험들이 한 지문을 공유하는지가 이 축의 쓸모다.
    const seen = new Set<string>();
    for (const failure of run.failures) {
      const signature = diagnosticSignature(failure.diagnostic);
      const entry = bySignature.get(signature) ?? { runs: 0, tests: new Set<string>() };
      if (!seen.has(signature)) {
        entry.runs += 1;
        seen.add(signature);
      }
      entry.tests.add(failure.name);
      bySignature.set(signature, entry);
    }
  }

  const failureCountsByTest = [...counts.entries()]
    .map(([name, count]) => ({ name, runs: count }))
    .sort((left, right) => right.runs - left.runs || left.name.localeCompare(right.name));

  const failureCountsByDiagnostic = [...bySignature.entries()]
    .map(([signature, entry]) => ({ signature, runs: entry.runs, tests: [...entry.tests].sort() }))
    .sort(
      (left, right) => right.runs - left.runs || left.signature.localeCompare(right.signature),
    );

  return {
    target,
    runs: runs.length,
    measuredRuns,
    targetFailedRuns,
    failedRuns,
    buildErrorRuns,
    failureCountsByTest,
    failureCountsByDiagnostic,
    targetObserved: runs.some(
      (run) => !run.buildError && run.passed + run.failed > 0,
    ),
  };
}

/**
 * 판정 축. 실패 "횟수"가 아니라 실패 "종류"가 회차의 성적표다. 종류가 사라졌는지, 새 종류가
 * 생겼는지를 전후로 비교한다.
 */
export function failureKinds(summary: RunSummary): FailureKind[] {
  const kinds: FailureKind[] = [
    { kind: '대상 시험 실패', count: summary.targetFailedRuns },
    {
      kind: '다른 시험 간헐 실패',
      count: summary.failureCountsByTest
        .filter((entry) => entry.name !== summary.target)
        .reduce((total, entry) => total + entry.runs, 0),
    },
    { kind: '빌드·링크 실패', count: summary.buildErrorRuns },
  ];
  return kinds.filter((kind) => kind.count > 0);
}

/** 측정이 성립했는지까지 함께 본다. 성립하지 않은 측정은 통과가 아니라 broken 이다. */
export function verdict(summary: RunSummary): Verdict {
  if (summary.buildErrorRuns > 0 || summary.measuredRuns === 0 || !summary.targetObserved) {
    return 'broken';
  }
  if (summary.targetFailedRuns > 0) return 'target-flaky';
  if (summary.failedRuns > 0) return 'suite-flaky';
  return 'clean';
}

/**
 * 델타 디버깅의 한 걸음: 후보를 `parts` 조각으로 고르게 가른다. 나머지는 앞 조각부터 하나씩
 * 더해 조각 크기 차이가 1 을 넘지 않는다.
 */
export function splitEvenly<T>(list: T[], parts: number): T[][] {
  if (parts < 1) throw new Error('parts는 1 이상이어야 합니다');
  const size = Math.floor(list.length / parts);
  const extra = list.length % parts;
  const chunks: T[][] = [];
  let cursor = 0;
  for (let index = 0; index < parts; index += 1) {
    const take = size + (index < extra ? 1 : 0);
    chunks.push(list.slice(cursor, cursor + take));
    cursor += take;
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * 기준선과 지금을 견준다. 사라진 종류·새로 생긴 종류·늘어난 종류를 가른다 — 회귀는 "새로 생긴"
 * 과 "늘어난" 쪽이고, 성과는 "사라진" 쪽이다.
 */
export function compareFailureKinds(
  before: FailureKind[],
  after: FailureKind[],
): {
  kind: string;
  before: number;
  after: number;
  direction: 'gone' | 'new' | 'up' | 'down' | 'same';
}[] {
  const beforeMap = new Map(before.map((kind) => [kind.kind, kind.count]));
  const afterMap = new Map(after.map((kind) => [kind.kind, kind.count]));
  const names = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  return names.map((kind) => {
    const from = beforeMap.get(kind) ?? 0;
    const to = afterMap.get(kind) ?? 0;
    let direction: 'gone' | 'new' | 'up' | 'down' | 'same' = 'same';
    if (from > 0 && to === 0) direction = 'gone';
    else if (from === 0 && to > 0) direction = 'new';
    else if (to > from) direction = 'up';
    else if (to < from) direction = 'down';
    return { kind, before: from, after: to, direction };
  });
}

export type ComparisonEntry = ReturnType<typeof compareFailureKinds>[number];

/**
 * 비교 축 한 줄을 사람이 읽을 글로 만든다. 러너가 아니라 여기 두는 이유: 이것은 돌리고 모으는
 * 일이 아니라 **판정을 읽는 규칙**이고(파일 머리말의 계약이다), 러너 안에 두면 시험이 닿지
 * 않는다.
 *
 * `comparison` 이 `null` 인 까닭은 둘이다 — 기준선 파일이 아예 없거나, 있는데 그 축을 갖기
 * 전에 적힌 것이거나. 둘을 한 문장으로 뭉치면 기준선이 아직 없는 첫 측정에서도 "기준선에 이
 * 축이 없다"고 찍혀, 사람이 멀쩡한 기준선을 낡은 것으로 읽고 덮어쓴다. 그래서 가른다.
 *
 * 분모를 제목에 함께 찍는다: 비교는 실행 수가 아니라 횟수를 견주므로 기준선 10회 ↔ 이번 20회면
 * 같은 빈도라도 숫자가 두 배로 보인다.
 */
export function comparisonLines(input: {
  title: string;
  comparison: ComparisonEntry[] | null;
  baselineRuns: number | null;
  runs: number;
  hasBaseline: boolean;
}): string[] {
  const { title, comparison, baselineRuns, runs, hasBaseline } = input;
  if (comparison === null) {
    return [`  ${title}: ${hasBaseline ? '기준선에 이 축이 없어' : '기준선이 없어'} 견주지 않았다`];
  }
  const scale = baselineRuns === null ? '' : ` (기준선 ${baselineRuns}회 ↔ 이번 ${runs}회)`;
  if (comparison.length === 0) return [`  ${title}: 달라진 종류 없다${scale}`];
  return [
    `  ${title}${scale}`,
    ...comparison.map((entry) => `    ${entry.direction} · ${entry.kind}: ${entry.before} → ${entry.after}`),
  ];
}
