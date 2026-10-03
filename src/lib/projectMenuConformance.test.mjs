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
  sliceFnBlock,
  validateChecklist,
} from './projectMenuConformance.ts';

// 실제 저장소에서 떼어 온 모양. 맞추기 규칙이 제품 계약과 같은 글을 읽는지 보려고
// 축약하지 않고 같은 형태로 적는다.
const REMOTE_RS = `
        "get_project_git_status" => {
            to_value(crate::get_project_git_status(&request.project_path)?)
        }
        "commit_project_git" => {
            to_value(crate::commit_project_git(request)?)
        }

pub(crate) fn is_write_command(command: &str) -> bool {
    matches!(
        command,
        "commit_project_git"
            | "switch_project_git_branch"
            | "push_project_git"
    )
}

pub(crate) fn is_host_only_command(command: &str) -> bool {
    matches!(command, "push_project_git")
}
`;

const SYSTEM_MCP_RS = `
    capability!(Read, "get_project_git_status", {"request":{}}, "작업 트리 상태"),
    capability!(Execute, "commit_project_git", {"request":{}}, "스테이지된 변경을 커밋"),

    #[test]
    fn project_git_c16_operations_are_exposed_with_expected_access() {}
`;

const FILES = {
  'crates/agent-manager-core/src/remote.rs': REMOTE_RS,
  'crates/agent-manager-core/src/system_mcp.rs': SYSTEM_MCP_RS,
  'crates/agent-manager-core/src/project_git.rs':
    'pub fn commit_project_git() {}\nassert_within_root(&root, &path)?;\n',
  'src/lib/ipcProjects.ts': 'return call("commit_project_git", { request });',
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

test('쓰기 게이트와 호스트 전용은 각자의 블록 안에서만 센다', () => {
  const file = 'crates/agent-manager-core/src/remote.rs';
  assert.equal(
    evaluateCheck({ id: 'a', kind: 'remoteWriteGate', title: '게이트', file, command: 'commit_project_git' }, FILES).ok,
    true,
  );
  // 읽기 명령은 디스패치에는 있지만 쓰기 게이트에는 없어야 한다.
  assert.equal(
    evaluateCheck(
      { id: 'b', kind: 'remoteWriteGate', title: '게이트', file, command: 'get_project_git_status' },
      FILES,
    ).ok,
    false,
  );
  assert.equal(
    evaluateCheck(
      { id: 'c', kind: 'remoteWriteGate', title: '게이트 아님', file, command: 'get_project_git_status', expect: false },
      FILES,
    ).ok,
    true,
  );
  assert.equal(
    evaluateCheck({ id: 'd', kind: 'remoteHostOnly', title: '호스트 전용', file, command: 'push_project_git' }, FILES).ok,
    true,
  );
  // commit은 쓰기 게이트에는 있고 호스트 전용 목록에는 없다. 블록을 안 나누면 여기서 틀린다.
  assert.equal(
    evaluateCheck({ id: 'e', kind: 'remoteHostOnly', title: '호스트 전용', file, command: 'commit_project_git' }, FILES).ok,
    false,
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
  const block = sliceFnBlock(REMOTE_RS, 'fn is_host_only_command');
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
