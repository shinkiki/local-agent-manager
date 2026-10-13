import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  compareFailureKinds,
  comparisonLines,
  diagnosticKinds,
  diagnosticSignature,
  failureKinds,
  parseCargoTestOutput,
  splitEvenly,
  summarizeRuns,
  verdict,
} from './flakyTestReport.ts';

const TARGET =
  'usage_budget_policy::tests::the_completion_condition_switch_keeps_the_text_and_stops_applying_it';

// 2026-10-05, F:\Project\workspaces\local-agent-manager-private, dev-history 539927cb 에서
// `cargo test -q -p agent-manager-core --lib` 을 돌려 받은 출력을 줄여 적은 것. 조용한 리포터가
// 점 진행 막대와 `test result:` 한 줄만 낸다.
const PASSING = `warning: linker stdout: F:\\...\\agent_manager_core-ccc976390878730e.lib ...
  |
  = note: \`#[warn(linker_messages)]\` on by default


running 2084 tests
....................................................................................... 87/2084
................................................................................i...... 174/2084
...................................................................................
test result: ok. 2083 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 16.20s
`;

// 같은 날 같은 명령에서 실제로 난 실패(대상이 아닌 다른 시험이 혼자 깨졌다). 진단 블록의 모양은
// 같은 조용한 리포터로 재현해 떠 왔다 — `<이름> --- FAILED` 인라인 줄, `---- <이름> stdout ----`
// 블록, 꼬리의 `failures:` 목록 셋이 한 실행에 함께 나온다.
const FAILING_OTHER = `running 2084 tests
....................................................................................... 87/2084
accounts::tests::admissibility_is_decided_before_candidates_are_looked_at --- FAILED
...................................................................................

failures:

---- accounts::tests::admissibility_is_decided_before_candidates_are_looked_at stdout ----

thread 'accounts::tests::admissibility_is_decided_before_candidates_are_looked_at' (44388) panicked at crates\\agent-manager-core\\src\\accounts.rs:13325:9:
쿨다운 안
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    accounts::tests::admissibility_is_decided_before_candidates_are_looked_at

test result: FAILED. 2082 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 17.85s

error: test failed, to rerun pass \`-p agent-manager-core --lib\`
`;

const FAILING_TARGET = `running 2084 tests
${TARGET} --- FAILED

failures:

---- ${TARGET} stdout ----

thread '${TARGET}' (18320) panicked at crates\\agent-manager-core\\src\\usage_budget_policy.rs:2195:9:
assertion \`left == right\` failed: 꺼진 조건의 표식은 무시한다
  left: Some("근거")
 right: Some("다른 근거")


failures:
    ${TARGET}

test result: FAILED. 2082 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 17.40s
`;

// 2026-10-05 2회차와 2026-10-06 3회차가 실제로 본 저장 경로 실패. 깨진 시험 이름은 회차마다
// 달랐는데 진단은 글자 그대로 이 하나였다 — 지문 축이 묶어야 하는 것이 이것이다.
const FAILING_STORE_IO = `running 2084 tests
project_instructions::tests::updating_a_shared_source_requires_the_current_digest --- FAILED
store::tests::metadata_survives_a_reload --- FAILED

failures:

---- project_instructions::tests::updating_a_shared_source_requires_the_current_digest stdout ----

thread 'project_instructions::tests::updating_a_shared_source_requires_the_current_digest' (21044) panicked at crates\\agent-manager-core\\src\\project_instructions.rs:4412:9:
publish: Io(Os { code: 5, kind: PermissionDenied, message: "액세스가 거부되었습니다." })

---- store::tests::metadata_survives_a_reload stdout ----

thread 'store::tests::metadata_survives_a_reload' (9120) panicked at crates\\agent-manager-core\\src\\store.rs:881:9:
save: Io(Os { code: 5, kind: PermissionDenied, message: "C:\\Users\\me\\AppData\\Local\\Temp\\.tmpAbC123 액세스가 거부되었습니다." })

failures:
    project_instructions::tests::updating_a_shared_source_requires_the_current_digest
    store::tests::metadata_survives_a_reload

test result: FAILED. 2081 passed; 2 failed; 1 ignored; 0 measured; 0 filtered out; finished in 19.02s
`;

const BUILD_BROKEN = `   Compiling agent-manager-core v0.1.0
error[E0425]: cannot find value \`consumer\` in this scope
   --> crates/agent-manager-core/src/usage_budget_policy.rs:900:9
error: could not compile \`agent-manager-core\` (lib test) due to 1 previous error
`;

test('통과한 실행은 실패 없이 숫자만 읽힌다', () => {
  const run = parseCargoTestOutput(PASSING, 0);
  assert.equal(run.passed, 2083);
  assert.equal(run.failed, 0);
  assert.equal(run.ignored, 1);
  assert.deepEqual(run.failures, []);
  assert.equal(run.buildError, false);
  assert.equal(run.durationSeconds, 16.2);
});

test('실패한 실행에서 시험 이름과 진단 블록을 떼어 온다', () => {
  const run = parseCargoTestOutput(FAILING_TARGET, 101);
  assert.equal(run.failed, 1);
  assert.equal(run.failures.length, 1);
  assert.equal(run.failures[0].name, TARGET);
  // 진단에는 panic 자리와 left/right 가 남고, 꼬리의 `failures:` 목록과 요약 줄은 빠진다.
  assert.match(run.failures[0].diagnostic, /usage_budget_policy\.rs:2195:9/);
  assert.match(run.failures[0].diagnostic, /left: Some\("근거"\)/);
  assert.doesNotMatch(run.failures[0].diagnostic, /test result:/);
});

test('빌드가 깨진 실행은 간헐 실패가 아니라 측정 실패로 센다', () => {
  const run = parseCargoTestOutput(BUILD_BROKEN, 101);
  assert.equal(run.buildError, true);
  assert.equal(run.passed, 0);
  assert.equal(run.durationSeconds, null);

  const summary = summarizeRuns([run], TARGET);
  assert.equal(summary.buildErrorRuns, 1);
  assert.equal(summary.measuredRuns, 0);
  assert.equal(verdict(summary), 'broken');
});

test('CRLF 로 들어온 출력도 같은 값으로 읽힌다', () => {
  const lf = parseCargoTestOutput(FAILING_TARGET, 101);
  const crlf = parseCargoTestOutput(FAILING_TARGET.replace(/\n/g, '\r\n'), 101);
  assert.deepEqual(crlf, lf);
});

test('대상만 실패하면 target-flaky, 다른 시험만 실패하면 suite-flaky 다', () => {
  const runs = [
    parseCargoTestOutput(PASSING, 0),
    parseCargoTestOutput(FAILING_TARGET, 101),
    parseCargoTestOutput(PASSING, 0),
  ];
  const summary = summarizeRuns(runs, TARGET);
  assert.equal(summary.runs, 3);
  assert.equal(summary.targetFailedRuns, 1);
  assert.equal(summary.failedRuns, 1);
  assert.equal(verdict(summary), 'target-flaky');

  const otherOnly = summarizeRuns(
    [parseCargoTestOutput(PASSING, 0), parseCargoTestOutput(FAILING_OTHER, 101)],
    TARGET,
  );
  assert.equal(otherOnly.targetFailedRuns, 0);
  assert.equal(otherOnly.failedRuns, 1);
  assert.equal(verdict(otherOnly), 'suite-flaky');
});

test('전건 통과만 clean 이다', () => {
  const summary = summarizeRuns(
    [parseCargoTestOutput(PASSING, 0), parseCargoTestOutput(PASSING, 0)],
    TARGET,
  );
  assert.equal(verdict(summary), 'clean');
  assert.deepEqual(failureKinds(summary), []);
});

// 2026-10-05 실측에서 나온 함정 그대로다: 그날 한 실행은 대상이 아니라 accounts 쪽 시험이 깨졌다.
// 대상만 보고 판정하면 "고쳐졌다"로 읽히지만 suite 는 여전히 흔들린다.
test('대상이 통과해도 다른 시험이 깨진 실행은 통과로 적지 않는다', () => {
  const summary = summarizeRuns(
    [
      parseCargoTestOutput(PASSING, 0),
      parseCargoTestOutput(FAILING_OTHER, 101),
      parseCargoTestOutput(FAILING_OTHER, 101),
    ],
    TARGET,
  );
  assert.deepEqual(failureKinds(summary), [{ kind: '다른 시험 간헐 실패', count: 2 }]);
  assert.deepEqual(summary.failureCountsByTest, [
    { name: 'accounts::tests::admissibility_is_decided_before_candidates_are_looked_at', runs: 2 },
  ]);
  assert.notEqual(verdict(summary), 'clean');
});

// 필터를 잘못 적어 대상이 한 번도 돌지 않으면 모든 실행이 0 건 통과로 보인다. 그 통과를
// "고쳐졌다"로 읽으면 회차가 아무것도 안 하고 끝난다.
test('대상이 한 번도 돌지 않은 측정은 clean 이 아니라 broken 이다', () => {
  const empty = parseCargoTestOutput(
    'running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 2084 filtered out; finished in 0.00s\n',
    0,
  );
  const summary = summarizeRuns([empty, empty], TARGET);
  assert.equal(summary.targetObserved, false);
  assert.equal(verdict(summary), 'broken');
});

test('실패 종류 전후 비교가 사라진 종류와 새로 생긴 종류를 가른다', () => {
  const before = [
    { kind: '대상 시험 실패', count: 2 },
    { kind: '다른 시험 간헐 실패', count: 1 },
  ];
  const after = [
    { kind: '다른 시험 간헐 실패', count: 1 },
    { kind: '빌드·링크 실패', count: 1 },
  ];
  assert.deepEqual(compareFailureKinds(before, after), [
    { kind: '다른 시험 간헐 실패', before: 1, after: 1, direction: 'same' },
    { kind: '대상 시험 실패', before: 2, after: 0, direction: 'gone' },
    { kind: '빌드·링크 실패', before: 0, after: 1, direction: 'new' },
  ]);
});

test('후보 가르기는 조각 크기 차이를 1 안으로 두고 빈 조각을 내지 않는다', () => {
  assert.deepEqual(splitEvenly([1, 2, 3, 4, 5], 2), [
    [1, 2, 3],
    [4, 5],
  ]);
  assert.deepEqual(splitEvenly([1, 2, 3], 2), [[1, 2], [3]]);
  // 조각 수가 후보보다 많으면 빈 조각은 버린다 — 빈 목록으로 cargo 를 부르면 전건이 돈다.
  assert.deepEqual(splitEvenly([1], 4), [[1]]);
  assert.deepEqual(splitEvenly([], 3), []);
  assert.throws(() => splitEvenly([1], 0), /1 이상/);
});

// 2·3회차 실측의 핵심이다: 깨진 시험 이름은 여섯 모듈 → 네 모듈로 전혀 겹치지 않았는데 진단은
// 같은 하나였다. 지문은 OS 로캘 문구와 실행마다 다른 tempdir 경로를 지나 같은 값이어야 한다 —
// 그러지 못하면 한 원인이 매번 새 종류로 보여 이 축이 이름 축과 똑같아진다.
test('OS 오류 진단은 메시지와 경로가 달라도 같은 지문으로 묶인다', () => {
  const run = parseCargoTestOutput(FAILING_STORE_IO, 101);
  assert.equal(run.failures.length, 2);
  const signatures = run.failures.map((failure) => diagnosticSignature(failure.diagnostic));
  assert.deepEqual(signatures, [
    'Io(os error 5 · PermissionDenied)',
    'Io(os error 5 · PermissionDenied)',
  ]);
});

// 2026-10-06 5회차 실측: 같은 시험의 같은 실패 2회가 로컬 서버 포트만 달라 지문 둘로 갈렸다.
// 지문 축의 숫자가 원인의 빈도여야 하므로 루프백 포트는 지워 한 지문으로 묶인다.
test('로컬 서버 포트만 다른 진단은 같은 지문으로 묶인다', () => {
  const head = "thread 'tests::c16' panicked at src/project_git.rs:1:\n";
  const body = (port) =>
    `${head}assertion \`left == right\` failed: fetch: 실제 git 출력이 AuthFailed로 분류되지 않는다: fatal: unable to access 'http://127.0.0.1:${port}/repo.git/'\n`;
  assert.equal(diagnosticSignature(body(2150)), diagnosticSignature(body(6401)));
  assert.match(diagnosticSignature(body(2150)), /127\.0\.0\.1:<포트>/);
});

// 2026-10-06 코드리뷰 C-4ccc192750e0: 루프백 갈래 셋 중 `[::1]` 이 `\b` 때문에 죽어 있었다.
// `[` 는 낱말 문자가 아니라 앞이 `/` 면 경계가 서지 않아 IPv6 루프백만 포트가 남았다.
test('IPv6 루프백과 localhost 의 포트도 지문에서 지워진다', () => {
  const head = "thread 'tests::c16' panicked at src/project_git.rs:1:\n";
  const body = (host, port) => `${head}fetch 실패: unable to access 'http://${host}:${port}/repo.git/'\n`;
  for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
    assert.equal(diagnosticSignature(body(host, 2150)), diagnosticSignature(body(host, 6401)));
  }
  assert.match(diagnosticSignature(body('[::1]', 6401)), /\[::1\]:<포트>/);
});

// 반대쪽 함정: 루프백처럼 보이는 원격 호스트의 포트는 남아야 한다.
test('루프백이 아닌 주소의 포트는 지문에 남는다', () => {
  const head = "thread 'tests::c16' panicked at src/project_git.rs:1:\n";
  const sig = (host) => diagnosticSignature(`${head}fetch 실패: unable to access 'http://${host}:6401/repo.git/'\n`);
  assert.match(sig('10.0.0.1'), /10\.0\.0\.1:6401/);
  assert.match(sig('notlocalhost'), /notlocalhost:6401/);
});

// 반대쪽 함정: 과하게 묶으면 서로 다른 원인이 한 지문에 합쳐진다. 3회차의 단언 불일치는 저장
// 경로와 전혀 다른 원인이었고, 그 구분이 지문에 남아야 한다.
test('원인이 다른 진단은 다른 지문으로 갈린다', () => {
  const io = diagnosticSignature(
    parseCargoTestOutput(FAILING_STORE_IO, 101).failures[0].diagnostic,
  );
  const assertion = diagnosticSignature(
    parseCargoTestOutput(FAILING_TARGET, 101).failures[0].diagnostic,
  );
  const panic = diagnosticSignature(
    parseCargoTestOutput(FAILING_OTHER, 101).failures[0].diagnostic,
  );
  assert.notEqual(io, assertion);
  assert.notEqual(io, panic);
  assert.notEqual(assertion, panic);
  // panic 자리(파일:줄)는 지문에서 빠지고 메시지만 남는다.
  assert.equal(panic, '쿨다운 안');
  assert.doesNotMatch(assertion, /left: Some/);
});

// 지문 축의 숫자는 옆에 적히는 다른 숫자와 같은 단위여야 한다 — 전부 "실행 수"다. 한 실행에서
// 두 시험이 같은 지문으로 깨져도 그 실행은 1 회다.
test('한 실행에서 같은 지문이 여럿 나와도 실행 수로 센다', () => {
  const summary = summarizeRuns(
    [parseCargoTestOutput(PASSING, 0), parseCargoTestOutput(FAILING_STORE_IO, 101)],
    TARGET,
  );
  assert.deepEqual(summary.failureCountsByDiagnostic, [
    {
      signature: 'Io(os error 5 · PermissionDenied)',
      runs: 1,
      tests: [
        'project_instructions::tests::updating_a_shared_source_requires_the_current_digest',
        'store::tests::metadata_survives_a_reload',
      ],
    },
  ]);
  // 이름 축은 같은 실행을 시험 둘로 센다. 두 축이 서로 다른 것을 재고 있다는 증거다.
  assert.equal(summary.failureCountsByTest.length, 2);
  assert.deepEqual(diagnosticKinds(summary), [
    { kind: 'Io(os error 5 · PermissionDenied)', count: 1 },
  ]);
});

// 2회차 보고가 남긴 다음 회차의 판정 축: "진단이 code 5 인 종류가 사라졌는가". 종류 비교 함수는
// 이름 축과 공유하므로 지문 축도 그대로 전후 비교된다.
test('지문 축도 같은 비교 함수로 사라진 종류를 찍는다', () => {
  const before = diagnosticKinds(
    summarizeRuns([parseCargoTestOutput(FAILING_STORE_IO, 101)], TARGET),
  );
  const after = diagnosticKinds(summarizeRuns([parseCargoTestOutput(PASSING, 0)], TARGET));
  assert.deepEqual(compareFailureKinds(before, after), [
    { kind: 'Io(os error 5 · PermissionDenied)', before: 1, after: 0, direction: 'gone' },
  ]);
});

// 기준선 파일이 아예 없는 첫 측정에서 "기준선에 이 축이 없다"로 찍히면, 사람이 멀쩡한 기준선을
// 낡은 것으로 읽고 덮어쓴다. 두 null 을 가르는지 본다.
test('comparisonLines는 기준선 없음과 축 없음을 가른다', () => {
  assert.deepEqual(
    comparisonLines({
      title: '기준선 대비 진단 지문',
      comparison: null,
      baselineRuns: null,
      runs: 20,
      hasBaseline: false,
    }),
    ['  기준선 대비 진단 지문: 기준선이 없어 견주지 않았다'],
  );
  assert.deepEqual(
    comparisonLines({
      title: '기준선 대비 진단 지문',
      comparison: null,
      baselineRuns: 10,
      runs: 20,
      hasBaseline: true,
    }),
    ['  기준선 대비 진단 지문: 기준선에 이 축이 없어 견주지 않았다'],
  );
});

// 분모를 제목에 찍지 않으면 기준선 10회 ↔ 이번 20회에서 같은 빈도가 회귀로 보인다.
test('comparisonLines는 분모를 제목에 찍고 축마다 한 줄을 낸다', () => {
  assert.deepEqual(
    comparisonLines({
      title: '기준선 대비 실패 종류',
      comparison: compareFailureKinds(
        [{ kind: 'Io(os error 5)', count: 1 }],
        [
          { kind: 'Io(os error 5)', count: 3 },
          { kind: '빌드 실패', count: 1 },
        ],
      ),
      baselineRuns: 10,
      runs: 20,
      hasBaseline: true,
    }),
    [
      '  기준선 대비 실패 종류 (기준선 10회 ↔ 이번 20회)',
      '    up · Io(os error 5): 1 → 3',
      '    new · 빌드 실패: 0 → 1',
    ],
  );
  assert.deepEqual(
    comparisonLines({
      title: '기준선 대비 실패 종류',
      comparison: [],
      baselineRuns: 10,
      runs: 20,
      hasBaseline: true,
    }),
    ['  기준선 대비 실패 종류: 달라진 종류 없다 (기준선 10회 ↔ 이번 20회)'],
  );
});
