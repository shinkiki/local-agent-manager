import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkOkMap,
  classifyFailureKinds,
  classifyItem,
  diffFailureKinds,
  evaluateCheck,
  evaluateChecklist,
  requiredFiles,
  sliceCapabilityTable,
  sliceDispatchBlocks,
  sliceExportedFnBlocks,
  sliceFnBlock,
  stripComments,
  stripTestModules,
  validateChecklist,
} from './projectMenuConformance.ts';

// 실제 저장소에서 떼어 온 모양. 맞추기 규칙이 제품 계약과 같은 글을 읽는지 보려고
// 축약하지 않고 같은 형태로 적는다.
const REMOTE_RS = `
fn dispatch_project_command(
    command: &str,
) -> Result<Value, CoreError> {
    match command {
        "get_project_git_status" => {
            to_value(crate::get_project_git_status(&request.project_path)?)
        }
        "commit_project_git" => {
            to_value(crate::commit_project_git(request)?)
        }
        _ => return Err(CoreError::NotFound),
    }
}

pub(crate) fn is_write_command(command: &str) -> bool {
    matches!(
        command,
        "commit_project_git"
            | "switch_project_git_branch"
            | "push_project_git"
    )
}

pub(crate) fn is_next_command_block(command: &str) -> bool {
    matches!(command, "push_project_git")
}
`;

// 제품의 system_mcp.rs는 등재 줄을 `SYSTEM_CAPABILITIES` 상수 안에 담는다. 픽스처를 맨바닥에
// 적으면 `aiaCapability`의 좁힘(목록 안만 읽는다)을 비껴가므로 제품 모양 그대로 적는다.
const SYSTEM_MCP_RS = `
const SYSTEM_CAPABILITIES: &[SystemCapability] = &[
    capability!(Read, "get_project_git_status", {"request":{}}, "작업 트리 상태"),
    capability!(Execute, "commit_project_git", {"request":{}}, "스테이지된 변경을 커밋"),
];

    #[test]
    fn project_git_c16_operations_are_exposed_with_expected_access() {}
`;

const FILES = {
  'crates/agent-manager-core/src/remote.rs': REMOTE_RS,
  'crates/agent-manager-core/src/system_mcp.rs': SYSTEM_MCP_RS,
  'crates/agent-manager-core/src/project_git.rs':
    'pub fn commit_project_git() {}\nassert_within_root(&root, &path)?;\n',
  // 제품의 래퍼는 내보낸 함수 안에서 `call`을 부른다. 픽스처를 본문 한 줄로 적으면
  // `ipcWrapper`의 좁힘(내보낸 함수 블록 안의 `call(...)`)을 비껴간다.
  'src/lib/ipcProjects.ts':
    'export function commitProjectGit(request) {\n  return call("commit_project_git", { request });\n}\n',
  'AGENTS.md': '### C16 — project git adapter (`project_git.rs`)\n',
  'crates/agent-manager-core/src/project_overlays.rs': null,
};

test('rustSymbol은 선언만 통과시키고 호출은 통과시키지 않는다', () => {
  const declared = evaluateCheck(
    {
      id: 'a',
      kind: 'rustSymbol',
      title: '선언',
      file: 'crates/agent-manager-core/src/project_git.rs',
      symbol: 'commit_project_git',
    },
    FILES,
  );
  assert.equal(declared.ok, true);

  // remote.rs에는 같은 이름이 호출로만 나온다. 호출을 구현으로 세면 "껍데기만 등록"이 통과한다.
  const calledOnly = evaluateCheck(
    {
      id: 'b',
      kind: 'rustSymbol',
      title: '선언',
      file: 'crates/agent-manager-core/src/remote.rs',
      symbol: 'commit_project_git',
    },
    FILES,
  );
  assert.equal(calledOnly.ok, false);
});

test('없는 파일과 읽지 않은 파일은 사유가 다르다', () => {
  const missing = evaluateCheck(
    {
      id: 'a',
      kind: 'rustSymbol',
      title: '오버레이',
      file: 'crates/agent-manager-core/src/project_overlays.rs',
      symbol: 'snapshot_project_overlay',
    },
    FILES,
  );
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /없다/);

  const unread = evaluateCheck(
    { id: 'b', kind: 'rustSymbol', title: '안 읽음', file: 'nope.rs', symbol: 'x' },
    FILES,
  );
  assert.equal(unread.ok, false);
  assert.match(unread.reason, /읽지 않았다/);
});

test('remoteDispatch는 디스패치 갈래만 본다', () => {
  const base = { kind: 'remoteDispatch', title: '디스패치', file: 'crates/agent-manager-core/src/remote.rs' };
  assert.equal(evaluateCheck({ ...base, id: 'a', command: 'commit_project_git' }, FILES).ok, true);
  assert.equal(evaluateCheck({ ...base, id: 'b', command: 'apply_project_overlay' }, FILES).ok, false);
});

test('변경 명령 분류표는 is_write_command 블록 안에서만 센다', () => {
  const file = 'crates/agent-manager-core/src/remote.rs';
  assert.equal(
    evaluateCheck({ id: 'a', kind: 'remoteWriteGate', title: '분류표', file, command: 'commit_project_git' }, FILES).ok,
    true,
  );
  // 읽기 명령은 디스패치에는 있지만 변경 명령 분류표에는 없어야 한다.
  assert.equal(
    evaluateCheck(
      { id: 'b', kind: 'remoteWriteGate', title: '분류표', file, command: 'get_project_git_status' },
      FILES,
    ).ok,
    false,
  );
  assert.equal(
    evaluateCheck(
      { id: 'c', kind: 'remoteWriteGate', title: '분류표 아님', file, command: 'get_project_git_status', expect: false },
      FILES,
    ).ok,
    true,
  );
  // C20. push는 더 이상 호스트 전용이 아니다 — 분류표에는 변경으로 남고, 그 밖의 목록은 없다.
  assert.equal(
    evaluateCheck({ id: 'd', kind: 'remoteWriteGate', title: '분류표', file, command: 'push_project_git' }, FILES).ok,
    true,
  );
});

test('aiaCapability는 접근 등급까지 맞춘다', () => {
  const file = 'crates/agent-manager-core/src/system_mcp.rs';
  assert.equal(
    evaluateCheck({ id: 'a', kind: 'aiaCapability', title: '등록', file, command: 'commit_project_git', access: 'Execute' }, FILES).ok,
    true,
  );
  // 쓰기를 Read로 등록한 것은 통과가 아니다.
  assert.equal(
    evaluateCheck({ id: 'b', kind: 'aiaCapability', title: '등록', file, command: 'commit_project_git', access: 'Read' }, FILES).ok,
    false,
  );
});

test('agentsRule은 예외 절 제목만 통과시킨다', () => {
  assert.equal(
    evaluateCheck({ id: 'a', kind: 'agentsRule', title: 'C16', file: 'AGENTS.md', name: 'C16' }, FILES).ok,
    true,
  );
  assert.equal(
    evaluateCheck({ id: 'b', kind: 'agentsRule', title: 'C19', file: 'AGENTS.md', name: 'C19' }, FILES).ok,
    false,
  );
});

test('required·forbidden 리터럴은 없는 파일을 반대로 센다', () => {
  const required = evaluateCheck(
    {
      id: 'a',
      kind: 'requiredLiterals',
      title: '가드',
      file: 'crates/agent-manager-core/src/project_git.rs',
      literals: ['assert_within_root'],
    },
    FILES,
  );
  assert.equal(required.ok, true);

  const missingFileRequired = evaluateCheck(
    {
      id: 'b',
      kind: 'requiredLiterals',
      title: '가드',
      file: 'crates/agent-manager-core/src/project_overlays.rs',
      literals: ['assert_within_root'],
    },
    FILES,
  );
  assert.equal(missingFileRequired.ok, false);

  // 파일이 아직 없으면 금지 문자열도 당연히 없다 — 위반으로 세지 않는다.
  const forbidden = evaluateCheck(
    {
      id: 'c',
      kind: 'forbiddenLiterals',
      title: '금지',
      files: [
        'crates/agent-manager-core/src/project_git.rs',
        'crates/agent-manager-core/src/project_overlays.rs',
      ],
      literals: ['--force', 'reset --hard'],
    },
    FILES,
  );
  assert.equal(forbidden.ok, true);

  const violated = evaluateCheck(
    { id: 'd', kind: 'forbiddenLiterals', title: '금지', file: 'AGENTS.md', literals: ['project git adapter'] },
    FILES,
  );
  assert.equal(violated.ok, false);
  assert.match(violated.reason, /금지된 문자열/);
});

test('sliceFnBlock은 다음 함수까지 넘어가지 않는다', () => {
  const block = sliceFnBlock(REMOTE_RS, 'fn is_next_command_block');
  assert.ok(block.includes('push_project_git'));
  assert.ok(!block.includes('switch_project_git_branch'));
  assert.equal(sliceFnBlock(REMOTE_RS, 'fn no_such_thing'), '');
});

const CHECKLIST = {
  version: 1,
  items: [
    {
      id: 'A',
      stage: '1',
      title: '구현도 계약도 된 항목',
      checks: [
        {
          id: 'A.impl',
          kind: 'rustSymbol',
          title: '함수',
          file: 'crates/agent-manager-core/src/project_git.rs',
          symbol: 'commit_project_git',
        },
        {
          id: 'A.ipc',
          kind: 'ipcWrapper',
          title: '래퍼',
          file: 'src/lib/ipcProjects.ts',
          command: 'commit_project_git',
        },
      ],
    },
    {
      id: 'B',
      stage: '2',
      title: '아직 구현되지 않은 항목',
      checks: [
        {
          id: 'B.impl',
          kind: 'rustSymbol',
          title: '함수',
          file: 'crates/agent-manager-core/src/project_overlays.rs',
          symbol: 'apply_project_overlay',
        },
        {
          id: 'B.guard',
          kind: 'requiredLiterals',
          title: '가드',
          file: 'crates/agent-manager-core/src/project_overlays.rs',
          literals: ['git apply --check'],
        },
      ],
    },
    {
      id: 'C',
      stage: '3',
      title: '구현은 됐고 계약이 빠진 항목',
      checks: [
        {
          id: 'C.impl',
          kind: 'rustSymbol',
          title: '함수',
          file: 'crates/agent-manager-core/src/project_git.rs',
          symbol: 'commit_project_git',
        },
        {
          id: 'C.rule',
          kind: 'agentsRule',
          title: 'C19 예외',
          file: 'AGENTS.md',
          name: 'C19',
        },
      ],
    },
  ],
};

test('항목은 가장 앞선 실패 종류 하나로만 센다', () => {
  const result = evaluateChecklist(CHECKLIST, FILES);
  assert.equal(result.totalItems, 3);
  assert.equal(result.passedItems, 1);
  assert.equal(result.totalChecks, 6);
  assert.equal(result.passedChecks, 3);

  const byId = new Map(result.items.map((item) => [item.id, item]));
  assert.equal(classifyItem(byId.get('A')), null);
  // B는 가드도 빠졌지만 구현이 먼저 없다 — 안전규칙위반이 아니라 미구현이다.
  assert.equal(classifyItem(byId.get('B')), '미구현');
  assert.equal(classifyItem(byId.get('C')), '계약누락');

  const kinds = classifyFailureKinds(result);
  assert.deepEqual(kinds, [
    { kind: '미구현', count: 1, items: ['B'] },
    { kind: '계약누락', count: 1, items: ['C'] },
  ]);
});

test('직전 회차에 통과했던 점검이 깨지면 회귀가 다른 종류를 앞선다', () => {
  const result = evaluateChecklist(CHECKLIST, FILES);
  const previous = { ...checkOkMap(result), 'C.rule': true, 'B.impl': true };
  const kinds = classifyFailureKinds(result, previous);
  assert.deepEqual(
    kinds.map((entry) => entry.kind),
    ['회귀'],
  );
  assert.deepEqual(kinds[0].items, ['B', 'C']);
});

test('실패 종류 전후표는 0으로 내려간 종류를 지우지 않는다', () => {
  const before = [
    { kind: '미구현', count: 3, items: ['B', 'D', 'E'] },
    { kind: '계약누락', count: 1, items: ['C'] },
  ];
  const after = [{ kind: '미구현', count: 2, items: ['D', 'E'] }];
  assert.deepEqual(diffFailureKinds(before, after), [
    { kind: '미구현', before: 3, after: 2 },
    { kind: '계약누락', before: 1, after: 0 },
  ]);
});

test('점검표가 좁거나 id가 겹치면 거절한다', () => {
  const problems = validateChecklist(CHECKLIST);
  assert.ok(problems.some((problem) => problem.includes('20개 이상')));

  const duplicated = {
    version: 1,
    items: [CHECKLIST.items[0], { ...CHECKLIST.items[1], id: 'A' }],
  };
  assert.ok(validateChecklist(duplicated).some((problem) => problem.includes('겹친다')));
});

test('러너가 읽을 경로는 점검표에서만 나온다', () => {
  assert.deepEqual(requiredFiles(CHECKLIST), [
    'AGENTS.md',
    'crates/agent-manager-core/src/project_git.rs',
    'crates/agent-manager-core/src/project_overlays.rs',
    'src/lib/ipcProjects.ts',
  ]);
});

test('파일이 아직 없어서 깨진 가드 점검은 위반이 아니라 미구현이다', () => {
  const guardChecklist = {
    version: 1,
    items: [
      {
        id: 'G',
        stage: '4',
        title: '아직 없는 모듈의 가드',
        checks: [
          {
            id: 'G.guard',
            kind: 'requiredLiterals',
            title: '가드',
            category: 'safety',
            file: 'crates/agent-manager-core/src/project_overlays.rs',
            literals: ['git apply --check'],
          },
        ],
      },
      {
        id: 'H',
        stage: '4',
        title: '있는 모듈에서 빠진 가드',
        checks: [
          {
            id: 'H.guard',
            kind: 'requiredLiterals',
            title: '가드',
            category: 'safety',
            file: 'crates/agent-manager-core/src/project_git.rs',
            literals: ['classify_relative_path'],
          },
        ],
      },
    ],
  };
  const result = evaluateChecklist(guardChecklist, FILES);
  const byId = new Map(result.items.map((item) => [item.id, item]));
  assert.equal(byId.get('G').checks[0].missingFile, true);
  assert.equal(classifyItem(byId.get('G')), '미구현');
  // 같은 점검이라도 파일이 있는데 가드가 없는 것은 위반이다.
  assert.equal(byId.get('H').checks[0].missingFile, false);
  assert.equal(classifyItem(byId.get('H')), '안전규칙위반');
});

// testNamed 는 2026-10-03 까지 `fn <이름>(` 문자열만 봤다. 그래서 파수꾼 바로 위에 `#[ignore]`
// 한 줄을 넣어도 탐침은 97/97 녹색을 유지했고(cargo 가 ignored 를 실패로 세지 않으므로 전건도
// 녹색이다), push_project_git 의 호스트 전용 고정이 꺼진 채 모든 관문이 통과했다. 실제로 주입해
// 측정한 결과이고, 이 시험이 그 한 줄을 다시 통과시키지 않게 막는다.
test('testNamed 가 #[ignore] 로 꺼진 Rust 시험을 실패로 센다', () => {
  const file = 'crates/agent-manager-core/src/remote.rs';
  const check = {
    id: 'V1.remote',
    kind: 'testNamed',
    title: '파수꾼 시험',
    file,
    name: 'project_git_c16_split_writes_between_remote_and_host_only',
  };
  const live = `
    #[test]
    fn project_git_c16_split_writes_between_remote_and_host_only() {
        assert!(true);
    }
`;
  assert.equal(evaluateCheck(check, { [file]: live }).ok, true);

  const ignored = live.replace('    #[test]', '    #[test]\n    #[ignore]');
  const result = evaluateCheck(check, { [file]: ignored });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /#\[ignore\]/);
});

// 같은 구멍의 다른 모양 — `#[test]` 없이 이름만 같은 보조 함수. 이름만 보는 규칙에서는
// 시험을 지우고 같은 이름의 헬퍼를 남겨도 통과한다.
test('testNamed 가 #[test] 없는 동명 함수를 시험으로 세지 않는다', () => {
  const file = 'crates/agent-manager-core/src/project_overlays.rs';
  const check = {
    id: 'V4.escape',
    kind: 'testNamed',
    title: '경로 탈출 거절',
    file,
    name: 'project_overlay_c19_rejects_paths_outside_repository',
  };
  const helperOnly = `
    fn project_overlay_c19_rejects_paths_outside_repository() -> bool {
        true
    }
`;
  const result = evaluateCheck(check, { [file]: helperOnly });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /#\[test\]/);
});

// 시험 앞에 설명 주석을 다는 것은 이 저장소의 흔한 모양이다. 특성 줄과 `fn` 사이에 주석이
// 끼었다고 "시험이 아니다"로 세면 멀쩡한 열네 점검이 한꺼번에 빨개진다.
test('testNamed 가 특성 줄과 fn 사이의 주석·빈 줄을 건너뛴다', () => {
  const file = 'crates/agent-manager-core/src/project_git.rs';
  const check = {
    id: 'B7.test',
    kind: 'testNamed',
    title: '수신·송신 분리',
    file,
    name: 'project_branch_comparison_splits_incoming_and_outgoing',
  };
  const commented = `
    #[test]
    // 2026-10-01: 두 점 범위로 재면 내 쪽 커밋이 수신에 섞여 들어온다.

    fn project_branch_comparison_splits_incoming_and_outgoing() {
        assert!(true);
    }
`;
  assert.equal(evaluateCheck(check, { [file]: commented }).ok, true);
});

// 프런트 시험 파일(.mjs)은 Rust 선언 규칙을 적용하지 않는다 — 거기서는 `fn` 도 `#[test]` 도
// 없고 점검표가 시험 제목 문자열을 이름으로 쓴다. 2026-10-04: 이 시험은 원래 name 이
// `readOnly` 한 조각이어도 통과하는 것을 고정하고 있었는데, 그것이 아래 세 시험이 막는 바로
// 그 구멍이었다. "Rust 규칙을 적용하지 않는다"는 의도는 그대로 두고 name 만 제목으로 올렸다.
test('testNamed 는 .mjs 점검에 Rust 선언 규칙을 적용하지 않는다', () => {
  const file = 'src/lib/projectAiaHandoff.test.mjs';
  // 2026-10-04: 이 시험의 fixture 는 원래 name 이 `readOnly`(식별자)였다. .mjs 갈래가 제목
  // 자리를 보도록 조인 뒤로는 그런 name 이 통과하지 않는다 — round-92fd9f3d 가 손으로 고친
  // "name 이 제목이 아니면 아무것도 지키지 못한다"가 이제 구조로 막힌다. 이 시험이 묻는 것은
  // 그것이 아니라 "`fn`·`#[test]` 를 요구하지 않는다"이므로 제목만 실제 모양으로 바꿨다.
  const check = {
    id: 'A4.test',
    kind: 'testNamed',
    title: '읽기 전용',
    file,
    name: 'readOnly 가 기본값이다',
  };
  assert.equal(
    evaluateCheck(check, { [file]: "test('readOnly 가 기본값이다', () => {});" }).ok,
    true,
  );
});

// Rust 쪽 `#[ignore]` 와 같은 구멍의 프런트 쪽 모양이다. 2026-10-04 실측: A2·A4 의 유일한
// 회귀 시험을 `test.skip(…)` 으로, 그리고 `{ skip: true }` 로 각각 꺼도 탐침은 35/35 · 97/97
// 녹색이었다(제목 문자열이 파일에 그대로 남고, node:test 는 건너뛴 시험을 통과 점으로 센다).
// 즉 한 줄로 "AIA 요청에 diff 를 싣지 않는다"와 "분석 모드는 기본 읽기 전용"의 고정이 꺼졌다.
test('testNamed 가 .mjs 시험의 test.skip·it.skip·.todo 를 꺼진 것으로 센다', () => {
  const file = 'src/lib/projectAiaHandoff.test.mjs';
  const check = {
    id: 'A2.test',
    kind: 'testNamed',
    title: 'diff를 싣지 않는다',
    file,
    name: 'diff를 싣지 않는다',
  };
  for (const source of [
    'test.skip("diff를 싣지 않는다", () => {});',
    'it.skip("diff를 싣지 않는다", () => {});',
    'test.todo("diff를 싣지 않는다");',
  ]) {
    const result = evaluateCheck(check, { [file]: source });
    assert.equal(result.ok, false, source);
    assert.match(result.reason ?? '', /skip\/todo/);
  }
  assert.equal(evaluateCheck(check, { [file]: 'test("diff를 싣지 않는다", () => {});' }).ok, true);
});

// node:test 는 제목 뒤 옵션 객체로도 끌 수 있다. 수식어만 보면 이 모양이 그대로 빠져나간다.
test('testNamed 가 .mjs 시험의 옵션 객체 skip·todo 도 꺼진 것으로 센다', () => {
  const file = 'src/lib/projectAiaHandoff.test.mjs';
  const check = { id: 'A2.test', kind: 'testNamed', title: 'x', file, name: '제목' };
  const off = 'test("제목", { skip: true }, () => {});';
  assert.equal(evaluateCheck(check, { [file]: off }).ok, false);
  // `skip: false` 는 끈 것이 아니다.
  assert.equal(evaluateCheck(check, { [file]: 'test("제목", { skip: false }, () => {});' }).ok, true);
  // 본문에 적힌 `skip: true` 는 선언이 아니라 자료다. 거기서 멈추지 않으면 멀쩡한 시험이 빨개진다.
  assert.equal(
    evaluateCheck(check, { [file]: 'test("제목", () => { const o = { skip: true }; });' }).ok,
    true,
  );
  // `.only` 와 `.concurrent` 는 그 시험을 끄지 않는다.
  assert.equal(evaluateCheck(check, { [file]: 'test.concurrent("제목", () => {});' }).ok, true);
});

// 같은 조임이 round-92fd9f3d 가 손으로 고친 자리를 구조로 막는다 — name 이 제목이 아니라
// 식별자면(import 줄이나 다른 단언 안에만 있으면) 그 점검은 아무것도 지키지 못한다.
test('testNamed 가 .mjs 에서 제목 자리가 아닌 일치를 시험으로 세지 않는다', () => {
  const file = 'src/lib/projectBranchTree.test.mjs';
  const check = { id: 'B1.test', kind: 'testNamed', title: 'x', file, name: 'buildBranchTree' };
  const importOnly = [
    'import { buildBranchTree } from "./projectBranchTree.ts";',
    'test("slash 브랜치를 가상 폴더로 그린다", () => { buildBranchTree([]); });',
  ].join('\n');
  const result = evaluateCheck(check, { [file]: importOnly });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /없다/);
});

// 금지 "계열"은 문자열 목록으로 표현되지 않는다. 2026-10-04 실측: O7.forbidden 이 다섯 문자열
// (`"--force"`·`"--hard"`·`"clean"`·`"--amend"`·`"checkout"`)만 보던 때,
// project_overlays.rs 의 git 인수 벡터에 `"--force-with-lease"` 와 `"--rebase=interactive"` 를
// 끼워 넣어도 탐침은 35/35 · 97/97 녹색이었다. `"--force"` 는 뒤의 따옴표까지 포함한 문자열이라
// `"--force-with-lease"` 안에 없고, 대화형 rebase 는 목록에 아예 없었다. 둘 다 C16-4 가
// "제공하지 않는다"고 못박았고 C19-3 이 그 금지를 그대로 물려받는다 — 즉 안전규칙위반을 세는
// 유일한 점검이 금지 명령 두 종류를 못 보고 있었다. 그래서 정규식 목록을 더했다.
test('forbiddenLiterals 가 patterns 로 --force 계열을 잡는다', () => {
  const file = 'crates/agent-manager-core/src/project_overlays.rs';
  const check = {
    id: 'O7.forbidden',
    kind: 'forbiddenLiterals',
    title: '금지 명령',
    file,
    literals: ['"--hard"'],
    patterns: ['"--force[A-Za-z=-]*"'],
  };
  const withLease = 'runner.overlay_write(&["apply", "--force-with-lease"]);';
  const result = evaluateCheck(check, { [file]: withLease });
  assert.equal(result.ok, false);
  assert.match(result.reason, /--force\[A-Za-z=-\]\*/);
  // 문자열 목록만으로는 같은 줄이 통과한다 — 이 시험이 지키는 간극이 바로 그 차이다.
  assert.equal(
    evaluateCheck({ ...check, patterns: undefined }, { [file]: withLease }).ok,
    true,
  );
});

test('forbiddenLiterals 가 대화형 rebase 를 잡는다', () => {
  const file = 'crates/agent-manager-core/src/project_overlays.rs';
  const check = {
    id: 'O7.forbidden',
    kind: 'forbiddenLiterals',
    title: '금지 명령',
    file,
    literals: [],
    patterns: ['"(-i|--interactive)"', '"--rebase=interactive"'],
  };
  assert.equal(
    evaluateCheck(check, { [file]: 'run(&["rebase", "--rebase=interactive"]);' }).ok,
    false,
  );
  assert.equal(evaluateCheck(check, { [file]: 'run(&["rebase", "--continue"]);' }).ok, true);
});

// patterns 만 있고 literals 가 비어도 성립해야 한다. 예전 규칙은 literals 가 비면 바로
// 실패였으므로, 계열만 묻는 점검을 쓸 수 없었다.
test('forbiddenLiterals 는 patterns 만 있어도 성립하고 둘 다 비면 실패한다', () => {
  const file = 'a.rs';
  const only = {
    id: 'x',
    kind: 'forbiddenLiterals',
    title: '금지',
    file,
    patterns: ['"--autostash"'],
  };
  assert.equal(evaluateCheck(only, { [file]: 'fn main() {}' }).ok, true);
  const neither = { id: 'x', kind: 'forbiddenLiterals', title: '금지', file };
  const result = evaluateCheck(neither, { [file]: 'fn main() {}' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /patterns/);
});

// 읽을 수 없는 정규식은 조용히 통과시키지 않는다 — 통과시키면 오타 하나로 금지 계열이 꺼진다.
test('forbiddenLiterals 가 잘못된 정규식을 실패로 센다', () => {
  const file = 'a.rs';
  const check = { id: 'x', kind: 'forbiddenLiterals', title: '금지', file, patterns: ['"--force['] };
  const result = evaluateCheck(check, { [file]: 'fn main() {}' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /정규식/);
});

// requiredLiterals 에는 patterns 가 적용되지 않는다. required 는 "있어야 한다"는 물음이고
// 계열은 "없어야 한다"는 물음에만 뜻이 있다 — 섞으면 한 필드가 두 뜻을 갖는다.
test('requiredLiterals 는 patterns 를 보지 않는다', () => {
  const file = 'a.rs';
  const check = {
    id: 'x',
    kind: 'requiredLiterals',
    title: '필수',
    file,
    patterns: ['"--force"'],
  };
  const result = evaluateCheck(check, { [file]: 'fn main() {}' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /literals가 비었다/);
});

// 제목 따옴표는 이 저장소 안에서도 갈린다(B1 은 쌍따옴표, A2·A4 는 홑따옴표 파일에 섞여 있다).
// 세 종류를 모두 받되 여는 따옴표와 닫는 따옴표가 같은 것만 제목으로 세야 한다 — 짝이 어긋난
// 것까지 받으면 제목 자리 검사가 다시 느슨한 부분 문자열 일치로 돌아간다.
// `describe` 를 함께 받는 이유는 `describe.skip` 이 그 안의 시험을 통째로 끄기 때문이다.
test('testNamed 는 세 따옴표와 describe 를 받고 따옴표 짝이 어긋나면 받지 않는다', () => {
  const file = 'src/lib/projectBranchTree.test.mjs';
  const check = { id: 'B1.test', kind: 'testNamed', title: 'x', file, name: '제목' };
  for (const q of ['"', "'", '`']) {
    assert.equal(evaluateCheck(check, { [file]: `test(${q}제목${q}, () => {});` }).ok, true, q);
  }
  assert.equal(evaluateCheck(check, { [file]: `test("제목', () => {});` }).ok, false);
  assert.equal(evaluateCheck(check, { [file]: 'describe("제목", () => {});' }).ok, true);
  assert.equal(evaluateCheck(check, { [file]: 'describe.skip("제목", () => {});' }).ok, false);
});

// 2026-10-04. 분류표 점검이 **이름이 같은 접두사로 시작하는 다른 함수**를 읽던 자리.
//
// 실측: remote.rs 의 `pub(crate) fn is_write_command(` 바로 위에
// `fn is_write_command_for_actor(` 를 두고, 진짜 분류표에서 `"apply_project_overlay"` 한 줄을
// 지웠다. 탐침은 35/35 · 97/97 녹색을 그대로 냈다 — 작업 트리를 바꾸는 유일한 overlay 명령이
// 변경 명령 분류표에서 빠진 상태가 아홉 개 분류표 점검을 전부 통과한 것이다.
//
// 미끼가 악의여야 하는 것도 아니다. `is_write_command_for_actor` 같은 보조 함수를 분류표 위에
// 적는 흔한 리팩터 한 번이면 같은 일이 벌어진다. 그래서 마커를 `fn <이름>(` 로 못박는다.
const REMOTE_RS_WITH_PREFIX_DECOY = `
fn is_write_command_for_actor(command: &str) -> bool {
    matches!(
        command,
        "apply_project_overlay"
            | "save_project_overlay_set"
    )
}

pub(crate) fn is_write_command(command: &str) -> bool {
    matches!(
        command,
        "save_project_overlay_set"
    )
}
`;

test('분류표 점검은 이름이 접두사로 겹치는 앞선 함수를 읽지 않는다', () => {
  const files = { 'remote.rs': REMOTE_RS_WITH_PREFIX_DECOY };
  // 미끼에만 있고 진짜 분류표에는 없는 명령 — 실패해야 한다.
  const decoyed = evaluateCheck(
    {
      id: 'g1',
      kind: 'remoteWriteGate',
      title: '적용은 변경 명령 분류표에 있다',
      file: 'remote.rs',
      command: 'apply_project_overlay',
    },
    files,
  );
  assert.equal(decoyed.ok, false);
  assert.match(decoyed.reason, /변경 명령 분류표에 없다/);

  // 진짜 분류표에 있는 명령은 그대로 통과한다 — 마커를 좁힌 것이 멀쩡한 점검을 깨지 않는다.
  const real = evaluateCheck(
    {
      id: 'g2',
      kind: 'remoteWriteGate',
      title: '저장은 변경 명령 분류표에 있다',
      file: 'remote.rs',
      command: 'save_project_overlay_set',
    },
    files,
  );
  assert.equal(real.ok, true);
});

// 2026-10-04 실측. remote.rs의 진짜 디스패치 팔 `"snapshot_project_overlay" => {` 을 지우고
// 그 자리에 `// "snapshot_project_overlay" => { … }  // 전용 엔드포인트로 옮김` 한 줄만 남겼더니
// 고치기 전 탐침이 39/39 · 124/124 녹색을 그대로 냈다. 명령이 IPC로 닿지 않아 화면도 AIA도
// overlay 스냅샷을 영영 부르지 못하는 상태가 계약 점검 전부를 통과한 것이다. 같은 주입이
// 고친 뒤에는 38/39 · 123/124 · 회귀 1(O2)로 잡휘다.
//
// 악의를 가정하지 않는다 — 팔을 옮기면서 "여기 있던 것" 자국을 주석으로 남기는 것은 흔한
// 습관이고, 그 한 줄이 remoteDispatch·ipcWrapper·frontendSymbol·rustSymbol·aiaCapability를
// 전부 눈멀게 한다.
test('계약 점검은 주석에만 남은 명령 이름을 살아 있는 계약으로 읽지 않는다', () => {
  const files = {
    'remote.rs': [
      'fn dispatch_project_command(command: &str) -> Result<Value, CoreError> {',
      '    match command {',
      '        // "snapshot_project_overlay" => { … }  // 전용 엔드포인트로 옮김',
      '        "save_project_overlay_set" => {',
      '            to_value(crate::save_project_overlay_set(request)?)',
      '        }',
      '    }',
      '}',
    ].join('\n'),
  };

  const commented = evaluateCheck(
    {
      id: 'd1',
      kind: 'remoteDispatch',
      title: '스냅샷 디스패치',
      file: 'remote.rs',
      command: 'snapshot_project_overlay',
    },
    files,
  );
  assert.equal(commented.ok, false);
  assert.match(commented.reason, /remote 디스패치\(fn dispatch_\*\)에 snapshot_project_overlay이 없다/);

  // 살아 있는 팔은 그대로 통과한다 — 주석을 지우는 것이 멀정한 계약을 깨지 않는다.
  const live = evaluateCheck(
    {
      id: 'd2',
      kind: 'remoteDispatch',
      title: '저장 디스패치',
      file: 'remote.rs',
      command: 'save_project_overlay_set',
    },
    files,
  );
  assert.equal(live.ok, true);
});

// 반대 방향의 오탐. 문자열 안의 `//`를 주석으로 읽으면 살아 있는 코드가 지워져 멀정한
// 계약이 실패로 뒤집힌다. URL은 이 저장소 어디에나 있고, Rust의 raw string과 TS의
// 템플릿 리터럴은 백슬래시·따옴표 규칙이 서로 다르다.
test('주석 제거는 문자열 리터럴 안의 슬래시 두 개를 주석으로 읽지 않는다', () => {
  const rust = [
    'const DOCS: &str = "https://example.test/a";',
    'const RAW: &str = r#"https://example.test/b"#;',
    '"live_command" => {}',
    '// "dead_command" => {}',
  ].join('\n');
  const strippedRust = stripComments(rust, 'crates/agent-manager-core/src/remote.rs');
  assert.ok(strippedRust.includes('https://example.test/a'));
  assert.ok(strippedRust.includes('https://example.test/b'));
  assert.ok(strippedRust.includes('"live_command"'));
  assert.ok(!strippedRust.includes('"dead_command"'));

  const ts = [
    "const url = 'https://example.test/c';",
    'const tpl = `https://example.test/d`;',
    "export const liveWrapper = invoke('save_project_overlay_set');",
    "// export const deadWrapper = invoke('snapshot_project_overlay');",
  ].join('\n');
  const strippedTs = stripComments(ts, 'src/lib/ipcProjects.ts');
  assert.ok(strippedTs.includes('https://example.test/c'));
  assert.ok(strippedTs.includes('https://example.test/d'));
  assert.ok(strippedTs.includes('liveWrapper'));
  assert.ok(!strippedTs.includes('deadWrapper'));

  // 길이를 보존해야 sliceFnBlock의 오프셋이 어긋나지 않는다.
  assert.equal(strippedRust.length, rust.length);
  assert.equal(strippedTs.length, ts.length);
});
// 2026-10-04 실측. `remoteDispatch`가 remote.rs **파일 전체**에서 `"<명령>" =>`를 찾던 자리.
// 진짜 팔을 `"snapshot_project_overlay_MOVED" =>`로 바꿔 그 명령이 IPC로 영영 닿지 못하게
// 만든 뒤 `mod tests` 안에 같은 문자열을 쓰는 보조 함수 하나를 두었더니 탐침이
// 42/42 · 142/142 녹색을 그대로 냈다. 미끼를 일부러 둘 필요도 없다 — remote.rs의 파수꾼
// 시험들이 이미 명령 이름을 문자열로 적고 있다. 그래서 읽을 범위를 `fn dispatch_*` 블록으로
// 좁혔고, 이 시험이 그 좁힘을 고정한다.
test('remoteDispatch 는 시험 모듈의 같은 문자열을 살아 있는 디스패치로 읽지 않는다', () => {
  const files = {
    'remote.rs': [
      'fn dispatch_project_command(command: &str) -> Result<Value, CoreError> {',
      '    match command {',
      '        "save_project_overlay_set" => {',
      '            to_value(crate::save_project_overlay_set(request)?)',
      '        }',
      '    }',
      '}',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    fn decoy(command: &str) -> u8 {',
      '        match command {',
      '            "snapshot_project_overlay" => 1,',
      '            _ => 0,',
      '        }',
      '    }',
      '}',
    ].join('\n'),
  };
  const base = { kind: 'remoteDispatch', title: '디스패치', file: 'remote.rs' };

  const decoyOnly = evaluateCheck({ ...base, id: 'n1', command: 'snapshot_project_overlay' }, files);
  assert.equal(decoyOnly.ok, false);
  assert.match(decoyOnly.reason, /fn dispatch_\*/);

  // 반대 방향. 좁힘이 살아 있는 팔까지 떨어뜨리면 멀쩡한 계약이 실패로 뒤집힌다.
  assert.equal(evaluateCheck({ ...base, id: 'n2', command: 'save_project_overlay_set' }, files).ok, true);
});

// 디스패치 함수가 하나도 없는 파일은 "없다"가 아니라 "읽을 블록이 없다"로 말해야 한다 —
// 둘을 같은 문장으로 적으면 파일을 옮긴 사람이 명령을 지운 줄로 읽는다.
test('remoteDispatch 는 디스패치 블록 자체가 없으면 그 사실을 사유로 말한다', () => {
  const result = evaluateCheck(
    { id: 'n3', kind: 'remoteDispatch', title: '디스패치', file: 'remote.rs', command: 'x' },
    { 'remote.rs': 'fn helper() {}\n' },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /fn dispatch_\* 블록이 없다/);
});

test('sliceDispatchBlocks 는 pub·async 가 붙은 선언도 집고 디스패치 밖은 버린다', () => {
  const text = [
    'fn other_command(command: &str) {',
    '    match command { "outside" => {} }',
    '}',
    'pub(crate) async fn dispatch_session_command(command: &str) {',
    '    match command { "inside" => {} }',
    '}',
  ].join('\n');
  const blocks = sliceDispatchBlocks(text);
  assert.ok(blocks.includes('"inside"'));
  assert.ok(!blocks.includes('"outside"'));
});

// 2026-10-04 실측. `aiaCapability`가 system_mcp.rs **파일 전체**에서 `capability!(등급, "명령"`을
// 찾던 자리. 진짜 등재 줄 `capability!(Execute, "save_project_overlay_set", …)`를 목록에서
// 통째로 지우고 `mod tests` 안에 같은 모양의 상수 하나를 두었더니 탐침이 42/42 · 142/142
// 녹색을 그대로 냈다 — AIA가 그 명령을 영영 볼 수 없는 상태(AGENTS.md 7절)가 계약 점검을
// 통과한 것이다. 그래서 읽을 범위를 `SYSTEM_CAPABILITIES` 목록으로 좁혔고 이 시험이 고정한다.
test("aiaCapability 는 목록 밖의 같은 모양을 살아 있는 등재로 읽지 않는다", () => {
  const files = {
    "system_mcp.rs": [
      "const SYSTEM_CAPABILITIES: &[SystemCapability] = &[",
      '    capability!(Execute, "save_project_overlay_set", {}, "세트 저장"),',
      "];",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    const DECOY: &[SystemCapability] = &[",
      '        capability!(Execute, "snapshot_project_overlay", {}, "미끼"),',
      "    ];",
      "}",
    ].join("\n"),
  };
  const base = {
    kind: "aiaCapability",
    title: "AIA 등재",
    file: "system_mcp.rs",
    access: "Execute",
  };

  const decoyOnly = evaluateCheck({ ...base, id: "c1", command: "snapshot_project_overlay" }, files);
  assert.equal(decoyOnly.ok, false);

  // 반대 방향. 좁힘이 살아 있는 등재까지 떨어뜨리면 멀쩡한 계약이 실패로 뒤집힌다.
  assert.equal(
    evaluateCheck({ ...base, id: "c2", command: "save_project_overlay_set" }, files).ok,
    true,
  );
});

// 목록 자체가 없는 파일은 "등록되지 않았다"가 아니라 "목록이 없다"로 말해야 한다 —
// 둘을 같은 문장으로 적으면 상수 이름을 바꾼 사람이 등재를 지운 줄로 읽는다.
test("aiaCapability 는 SYSTEM_CAPABILITIES 목록 자체가 없으면 그 사실을 사유로 말한다", () => {
  const result = evaluateCheck(
    {
      id: "c3",
      kind: "aiaCapability",
      title: "AIA 등재",
      file: "system_mcp.rs",
      command: "x",
    },
    { "system_mcp.rs": "fn helper() {}\n" },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /SYSTEM_CAPABILITIES 목록이 없다/);
});

// 2026-10-04 실측. `ipcWrapper`가 ipcProjects.ts **파일 전체**에서 `"<명령>"` 문자열 하나를
// 찾던 자리. `snapshotProjectOverlay`가 부르는 이름을 `"snapshot_project_overlay_MOVED"`로
// 바꿔 화면이 그 명령에 영영 닿지 못하게 만든 뒤 파일 맨 위에 옛 이름을 담은 상수 배열
// 한 줄을 두었더니 탐침이 42/42 · 142/142 녹색을 그대로 냈다. 래퍼의 계약은 이름이 어딘가
// 적혀 있는 것이 아니라 그 명령을 부르는 것이므로, 내보낸 함수 안의 `call(...)`만 읽는다.
test("ipcWrapper 는 부르지 않는 이름만 남은 자리를 살아 있는 래퍼로 읽지 않는다", () => {
  const files = {
    "ipcProjects.ts": [
      'export const LEGACY_PROJECT_COMMANDS = ["snapshot_project_overlay"];',
      "",
      "export function snapshotProjectOverlay(request) {",
      // 이름이 블록 **안**에 있으면서 `call`의 인자가 아닌 모양. 범위를 좁히는 것만으로는
      // 걸러지지 않으므로, 여기서는 `call(...)`을 요구하는 쪽이 혼자 일한다.
      '  const legacy = "snapshot_project_overlay";',
      '  return call<ProjectOverlayReceipt>(legacy + "_MOVED", { request });',
      "}",
      "",
      "export function saveProjectOverlaySet(request) {",
      '  return call<ProjectOverlaySets>("save_project_overlay_set", { request });',
      "}",
    ].join("\n"),
  };
  const base = { kind: "ipcWrapper", title: "IPC 래퍼", file: "ipcProjects.ts" };

  const nameOnly = evaluateCheck({ ...base, id: "w1", command: "snapshot_project_overlay" }, files);
  assert.equal(nameOnly.ok, false);
  assert.match(nameOnly.reason, /call로 부르지 않는다/);

  // 반대 방향. 제네릭이 붙은 실제 호출은 통과해야 한다.
  assert.equal(
    evaluateCheck({ ...base, id: "w2", command: "save_project_overlay_set" }, files).ok,
    true,
  );
});

test("sliceCapabilityTable·sliceExportedFnBlocks 는 선언 블록만 집는다", () => {
  const rust = [
    'const OTHER: &str = "outside";',
    "const SYSTEM_CAPABILITIES: &[SystemCapability] = &[",
    '    capability!(Read, "inside", {}, ""),',
    "];",
    'const AFTER: &str = "after";',
  ].join("\n");
  const table = sliceCapabilityTable(rust);
  assert.ok(table.includes('"inside"'));
  assert.ok(!table.includes('"outside"'));
  assert.ok(!table.includes('"after"'));
  assert.equal(sliceCapabilityTable("fn helper() {}\n"), "");

  const ts = [
    'const notExported = ["outside"];',
    "export async function wrapper(request) {",
    '  return call("inside", { request });',
    "}",
    'const trailing = ["after"];',
  ].join("\n");
  const blocks = sliceExportedFnBlocks(ts);
  assert.ok(blocks.includes('"inside"'));
  assert.ok(!blocks.includes('"outside"'));
  assert.ok(!blocks.includes('"after"'));
  assert.equal(sliceExportedFnBlocks("const x = 1;\n"), "");
});

// 2026-10-04 실측. rustSymbol 은 Rust 파일 **전체**를 읽었고 frontendSymbol 은 단순
// 부분 문자열이었다. project_overlays.rs 의 진짜 선언을 `…_MOVED` 로 개명하고 `mod tests`
// 안에 같은 이름의 보조 함수 한 줄을 둔 상태, 그리고 ProjectOverlayPanel 을
// ProjectOverlayPanelV2 로 **개명만** 한 상태 — 미끼를 하나도 두지 않은 쪽 — 둘 다에서
// 탐침이 42/42 · 142/142 녹색을 그대로 냈다. 제품에 그 이름이 더는 없는데 계약 점검이
// 통과한 것이다. rustSymbol 은 점검표 36 갈래 중 20 건으로 가장 많아 사정거리가 가장 넓다.
const OVERLAYS_RS_WITH_TEST_DECOY = `
pub fn exclude_project_overlay_paths_MOVED(
    paths: &[String],
) -> Result<(), CoreError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exclude_project_overlay_paths() {}

    #[test]
    fn t() {}
}
`;

const DECOY_FILES = {
  'crates/agent-manager-core/src/project_overlays.rs': OVERLAYS_RS_WITH_TEST_DECOY,
  'src/components/ProjectOverlayPanel.tsx':
    'export function ProjectOverlayPanelV2({ projectPath }) {\n  return null;\n}\n',
  'src/components/ProjectGitPanel.tsx':
    "const cls = `git-change-path git-change-path-button${selected ? 1 : 0}`;\n",
};

test('rustSymbol은 mod tests 안의 같은 이름을 제품 선언으로 읽지 않는다', () => {
  const decoyed = evaluateCheck(
    {
      id: 'a',
      kind: 'rustSymbol',
      title: '제외',
      file: 'crates/agent-manager-core/src/project_overlays.rs',
      symbol: 'exclude_project_overlay_paths',
    },
    DECOY_FILES,
  );
  assert.equal(decoyed.ok, false);
  assert.match(decoyed.reason, /제품 코드/);

  // 반대 방향 — 제품 쪽 선언이 살아 있으면 시험 모듈이 있어도 통과한다.
  const alive = evaluateCheck(
    {
      id: 'b',
      kind: 'rustSymbol',
      title: '제외',
      file: 'crates/agent-manager-core/src/project_overlays.rs',
      symbol: 'exclude_project_overlay_paths',
    },
    {
      'crates/agent-manager-core/src/project_overlays.rs': OVERLAYS_RS_WITH_TEST_DECOY.replace(
        '_MOVED(',
        '(',
      ),
    },
  );
  assert.equal(alive.ok, true);
});

test('stripTestModules는 cfg(test) 모듈만 지우고 길이를 보존한다', () => {
  const stripped = stripTestModules(OVERLAYS_RS_WITH_TEST_DECOY);
  assert.equal(stripped.length, OVERLAYS_RS_WITH_TEST_DECOY.length);
  assert.ok(stripped.includes('exclude_project_overlay_paths_MOVED'));
  assert.ok(!/fn exclude_project_overlay_paths\(/.test(stripped));

  // `#[cfg(test)]` 뒤에 mod 가 오지 않으면 그 한 줄만 지운다. 블록이 어디서 끝나는지
  // 모르는 채 지우면 살아 있는 제품 코드가 사라진다.
  const attributedFn = '#[cfg(test)]\nfn helper() {}\n\npub fn real() {}\n';
  const out = stripTestModules(attributedFn);
  assert.ok(out.includes('pub fn real()'));
  assert.ok(out.includes('fn helper()'));
});

test('frontendSymbol은 더 긴 이름의 앞머리를 그 이름으로 읽지 않는다', () => {
  const renamed = evaluateCheck(
    {
      id: 'a',
      kind: 'frontendSymbol',
      title: '패널',
      file: 'src/components/ProjectOverlayPanel.tsx',
      symbol: 'ProjectOverlayPanel',
    },
    DECOY_FILES,
  );
  assert.equal(renamed.ok, false);
  assert.match(renamed.reason, /온전한 이름/);

  // 식별자가 아닌 symbol(CSS 클래스)은 뒤에 템플릿 보간 `${` 가 붙어도 통과해야 한다 —
  // `$` 를 경계에서 배제하면 살아 있는 B9.ui 가 오탐으로 뒤집힌다(2026-10-04 실측).
  const cssClass = evaluateCheck(
    {
      id: 'b',
      kind: 'frontendSymbol',
      title: '버튼',
      file: 'src/components/ProjectGitPanel.tsx',
      symbol: 'git-change-path-button',
    },
    DECOY_FILES,
  );
  assert.equal(cssClass.ok, true);
});

// 2026-10-04 실측. requiredLiterals·forbiddenLiterals 만 파일을 날것 그대로 읽고 있었다 —
// 다른 모든 코드 갈래는 needCode(주석 제거)를 지나는데 이 둘만 files[path] 를 그대로 썼다.
// project_overlays.rs 의 되돌림 인수 벡터에서 `"--source=HEAD"` 와 `"--worktree"` 를 빼고
// `"--staged"` 하나로 바꿔도 탐침은 42/42 · 142/142 녹색이었다. 그 둘이 바로 위 문서 주석과
// `mod tests` 의 가드 시험 목록에 같은 모양으로 적혀 있었기 때문이다. 그 상태의 제품은
// 작업 트리를 되돌리지 않고 인덱스만 내리므로 C19-3 이 약속한 되돌림이 통째로 꺼진다.
test('requiredLiterals 는 주석과 mod tests 의 문자열을 살아 있는 가드로 읽지 않는다', () => {
  const file = 'crates/agent-manager-core/src/project_overlays.rs';
  const check = {
    id: 'x',
    kind: 'requiredLiterals',
    title: '되돌림',
    file,
    literals: ['--source=HEAD', '--worktree'],
  };

  const decoyOnly = [
    '/// `--source=HEAD` 는 무엇으로 되돌리는지를 못박고 `--worktree` 는 인덱스를 두고 간다.',
    'fn revert(runner: &GitRunner) {',
    '    runner.run(&["restore", "--staged"]);',
    '}',
    '#[cfg(test)]',
    'mod tests {',
    '    const GUARD: &[&str] = &["--source=HEAD", "--worktree"];',
    '}',
    '',
  ].join('\n');
  const gone = evaluateCheck(check, { [file]: decoyOnly });
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /--source=HEAD/);
  assert.match(gone.reason, /--worktree/);

  // 반대 방향 — 제품 인수 벡터에 살아 있으면 통과한다. 이것이 없으면 "언제나 실패"가 통과한다.
  const alive = evaluateCheck(check, {
    [file]: decoyOnly.replace('"restore", "--staged"', '"restore", "--source=HEAD", "--worktree"'),
  });
  assert.equal(alive.ok, true);
});

// 같은 범위가 금지 쪽에도 적용된다. 주석에 적은 `--force` 는 어떤 git 도 실행하지 않으므로
// 그것으로 붉게 만들면 오탐이고, 그 오탐은 금지 목록을 설명하는 주석을 쓰지 못하게 만든다.
// 다만 제품 인수 벡터에 실제로 들어오면 여전히 잡혀야 한다.
test('forbiddenLiterals 는 주석의 금지 문자열로 붉어지지 않지만 제품 인수는 잡는다', () => {
  const file = 'crates/agent-manager-core/src/project_overlays.rs';
  const check = {
    id: 'x',
    kind: 'forbiddenLiterals',
    title: '금지',
    file,
    literals: ['"--force"'],
    patterns: ['"--force[A-Za-z=-]*"'],
  };

  const commentOnly = [
    '// C16-4 는 "--force" 계열을 제공하지 않는다.',
    'fn revert(runner: &GitRunner) {',
    '    runner.run(&["restore", "--source=HEAD"]);',
    '}',
    '',
  ].join('\n');
  assert.equal(evaluateCheck(check, { [file]: commentOnly }).ok, true);

  const real = commentOnly.replace('"restore",', '"restore", "--force-with-lease",');
  const caught = evaluateCheck(check, { [file]: real });
  assert.equal(caught.ok, false);
  assert.match(caught.reason, /--force/);
});

// AGENTS.md 와 JSON 에는 주석 규칙을 대지 않는다. `https://` 의 두 빗금이 주석 시작으로
// 읽히면 R2.clauses 와 O11.guide 가 살아 있는데도 뒤집힌다.
test('literal 점검은 마크다운과 JSON 을 코드처럼 깎지 않는다', () => {
  const md = 'AGENTS.md';
  const mdCheck = { id: 'x', kind: 'requiredLiterals', title: '예외', file: md, literals: ['C19-1'] };
  assert.equal(
    evaluateCheck(mdCheck, { [md]: '계획 원문은 https://app.notion.com/p/x 이고 C19-1 이 그것을 받는다.' }).ok,
    true,
  );

  const json = 'src/lib/uiGuideTargets.json';
  const jsonCheck = {
    id: 'y',
    kind: 'requiredLiterals',
    title: '안내',
    file: json,
    literals: ['projects.tab.overlay'],
  };
  assert.equal(
    evaluateCheck(jsonCheck, { [json]: '{ "projects.tab.overlay": "https://example.test/a" }' }).ok,
    true,
  );
});
