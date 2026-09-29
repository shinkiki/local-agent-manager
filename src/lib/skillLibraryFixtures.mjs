/**
 * 스킬관리 시험이 함께 쓰는 항목 본. 모듈을 나눠도 항목 한 벌의 모양은 그대로여야
 * 하므로, 시험 파일마다 다시 적지 않고 여기 한 벌만 둔다 — 두 벌이면 `types.ts`에
 * 필드가 하나 늘 때 한쪽만 따라가도 두 시험이 서로 다른 항목을 보게 된다.
 */

export const providerState = (overrides = {}) => ({
  provider: "claude",
  status: "missing",
  installs: [],
  scope: null,
  origin: null,
  skillId: null,
  path: null,
  directory: null,
  targetDirectory: "/home/user/.claude/skills/demo",
  readOnly: false,
  contentDigest: null,
  divergent: false,
  divergence: null,
  modifiedAtMs: null,
  note: null,
  ...overrides,
});

export const commonSource = (overrides = {}) => ({
  id: "skill-1",
  key: "demo",
  name: "demo",
  description: "Demo skill",
  path: "/home/user/.agents/skills/demo/SKILL.md",
  directory: "/home/user/.agents/skills/demo",
  contentDigest: "aaa",
  fileCount: 2,
  totalBytes: 100,
  modifiedAtMs: null,
  ...overrides,
});

export const entry = (overrides = {}) => ({
  key: "demo",
  createdAtMs: null,
  origin: null,
  autoSync: false,
  name: "demo",
  description: "Demo skill",
  originKind: "common",
  common: commonSource(),
  managed: true,
  directoryName: "demo",
  providers: [
    providerState({ provider: "claude", status: "copy", contentDigest: "aaa" }),
    providerState({ provider: "codex", status: "copy", contentDigest: "aaa" }),
    providerState({ provider: "antigravity", status: "unsupported", readOnly: true, targetDirectory: null }),
  ],
  linkedCount: 0,
  installedCount: 2,
  missingCount: 0,
  ...overrides,
});

export const projectOrigin = (path, name) => ({
  provider: "claude",
  scope: "project",
  projectPath: path,
  projectName: name,
  archivedAtMs: null,
});
