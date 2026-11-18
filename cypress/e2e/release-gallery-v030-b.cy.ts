/// <reference types="cypress" />
import { applyGalleryLanguage, shoot, stubWorkspace, tr, visitDark, widenHeadlessWindow, NOW, MIN, HOUR, DAY, SESSIONS, DASHBOARD, FOLDERS, PROVIDERS_STATUS } from "../support/releaseGalleryFixtures";
import { SKILL_FILTERS_KEY } from "../support/skillLibraryFixtures";

// ---------------------------------------------------------------------------
// 스킬관리 표본

const SKILL_REPO = "/workspace/.agent-manager/resource-repository";
const SKILL_HOMES: Record<string, string> = {
  claude: "/workspace/.claude/skills",
  codex: "/workspace/.codex/skills",
  antigravity: "/workspace/.gemini/config/skills",
  local: "/workspace/.config/opencode/skill",
};
const SKILL_PROJECTS = [
  { path: "/workspace/agent-manager", name: "agent-manager" },
  { path: "/workspace/payments-api", name: "payments-api" },
  { path: "/workspace/mobile-app", name: "mobile-app" },
  { path: "/workspace/docs-site", name: "docs-site" },
];
const PROJECT_SKILL_DIR: Record<string, string> = { claude: ".claude/skills", codex: ".codex/skills", antigravity: ".agents/skills", local: ".opencode/skill" };

type Install = { scope: "personal" | "project"; project?: string; divergence?: "behind" | "edited" };

function skillProvider(provider: string, key: string, installs: Install[]) {
  const views = installs.map((i) => {
    const directory = i.scope === "personal" ? `${SKILL_HOMES[provider]}/${key}` : `/workspace/${i.project}/${PROJECT_SKILL_DIR[provider]}/${key}`;
    return {
      scope: i.scope,
      projectPath: i.project ? `/workspace/${i.project}` : null,
      projectName: i.project ?? null,
      skillId: `${provider}-${key}-${i.project ?? "user"}`,
      directory,
      contentDigest: i.divergence ? "b71e04c9a2f35d68" : "9f3c2a7e41b0d8c5",
      divergent: Boolean(i.divergence),
      divergence: i.divergence ?? null,
      modifiedAtMs: NOW - 3 * DAY,
      readOnly: false,
    };
  });
  const first = views[0];
  return {
    provider,
    status: views.length ? "linked" : "missing",
    scope: first ? first.scope : null,
    origin: null,
    skillId: first?.skillId ?? null,
    path: first ? `${first.directory}/SKILL.md` : null,
    directory: first?.directory ?? null,
    targetDirectory: `${SKILL_HOMES[provider]}/${key}`,
    readOnly: false,
    contentDigest: first ? first.contentDigest : null,
    divergent: views.some((v) => v.divergent),
    divergence: views.find((v) => v.divergence)?.divergence ?? null,
    modifiedAtMs: first ? NOW - 3 * DAY : null,
    note: null,
    installs: views,
  };
}

function skillEntry(
  key: string,
  description: string,
  daysAgo: number,
  providers: Record<string, Install[]>,
  extra: { origin?: { provider: string; scope: string; project?: string }; platforms?: string[]; files?: number } = {},
) {
  const states = ["claude", "codex", "antigravity", "local"].map((p) => skillProvider(p, key, providers[p] ?? []));
  const installed = states.filter((s) => s.installs.length > 0).length;
  return {
    key,
    createdAtMs: NOW - daysAgo * DAY,
    origin: extra.origin
      ? { provider: extra.origin.provider, scope: extra.origin.scope, projectPath: extra.origin.project ? `/workspace/${extra.origin.project}` : null, projectName: extra.origin.project ?? null, archivedAtMs: NOW - daysAgo * DAY }
      : null,
    autoSync: !["db-migration", "code-review", "e2e-harness"].includes(key),
    platforms: extra.platforms ?? [],
    active: true,
    migrationRequired: false,
    activeVariant: null,
    name: key,
    description,
    originKind: "common",
    common: {
      id: `common-${key}`,
      key,
      name: key,
      description,
      path: `${SKILL_REPO}/skills/${key}`,
      directory: key,
      contentDigest: "9f3c2a7e41b0d8c5",
      fileCount: extra.files ?? 3,
      totalBytes: 4_800 + key.length * 911,
      modifiedAtMs: NOW - Math.max(1, daysAgo - 2) * DAY,
    },
    managed: true,
    directoryName: key,
    providers: states,
    linkedCount: installed,
    installedCount: installed,
    missingCount: 4 - installed,
  };
}

const P: Install = { scope: "personal" };
const proj = (project: string, divergence?: "behind" | "edited"): Install => ({ scope: "project", project, divergence });

const SKILL_ENTRIES = [
  skillEntry("release-notes", tr("태그 사이 커밋을 모아 사용자용 릴리스 노트 초안을 한국어·영어로 작성한다.", "Collects commits between tags and drafts user-facing release notes in Korean and English."), 41, {
    claude: [P, proj("agent-manager")], codex: [P], antigravity: [P], local: [P],
  }, { origin: { provider: "claude", scope: "user" }, files: 5 }),
  skillEntry("code-review", tr("변경분을 정확성·회귀·보안 관점으로 검토하고 근거 있는 지적만 남긴다.", "Reviews a diff for correctness, regressions and security, and reports only well-founded findings."), 58, {
    claude: [P, proj("payments-api")], codex: [P, proj("payments-api", "behind")], antigravity: [P],
  }, { origin: { provider: "codex", scope: "user" }, files: 4 }),
  skillEntry("security-check", tr("의존성·비밀값 노출·권한 경계를 점검해 조치 우선순위를 매긴다.", "Audits dependencies, secret exposure and permission boundaries, and ranks what to fix first."), 33, {
    claude: [P], codex: [P, proj("payments-api")],
  }),
  skillEntry("e2e-harness", tr("격리 백엔드와 임시 앱 데이터로 Cypress E2E를 돌리고 실패를 좁힌다.", "Runs Cypress E2E against an isolated backend with throwaway app data and narrows down failures."), 27, {
    claude: [proj("agent-manager")], codex: [proj("agent-manager", "edited"), proj("mobile-app")],
  }, { origin: { provider: "claude", scope: "project", project: "agent-manager" }, files: 7 }),
  skillEntry("db-migration", tr("스키마 변경을 되돌릴 수 있는 단계로 나누고 롤백 절차를 함께 적는다.", "Splits schema changes into reversible steps and writes the rollback procedure alongside."), 19, {
    claude: [proj("payments-api")], codex: [P],
  }, { platforms: ["macos", "linux"] }),
  skillEntry("api-docs", tr("OpenAPI 명세에서 예제 요청·응답이 포함된 레퍼런스 문서를 만든다.", "Generates reference docs with example requests and responses from an OpenAPI spec."), 15, {
    claude: [P], local: [P, proj("docs-site")], antigravity: [proj("docs-site")],
  }, { origin: { provider: "local", scope: "project", project: "docs-site" } }),
  skillEntry("ui-reviewer", tr("스크린샷과 컴포넌트 코드를 대조해 접근성·일관성 문제를 찾는다.", "Compares screenshots against component code to find accessibility and consistency issues."), 9, {
    claude: [P], antigravity: [P, proj("mobile-app")],
  }, { origin: { provider: "antigravity", scope: "user" }, files: 6 }),
  skillEntry("changelog", tr("머지된 PR 제목을 분류해 CHANGELOG.md 항목으로 정리한다.", "Sorts merged PR titles into CHANGELOG.md entries."), 4, {
    claude: [P], codex: [P], local: [P],
  }),
];

function skillAdapter(provider: string, displayName: string) {
  return {
    provider,
    displayName,
    installableRoot: SKILL_HOMES[provider],
    roots: [
      { scope: "user", path: SKILL_HOMES[provider], present: true, readOnly: false, installable: true },
      ...SKILL_PROJECTS.map((p) => ({ scope: "project", path: `${p.path}/${PROJECT_SKILL_DIR[provider]}`, present: true, readOnly: false, installable: true })),
    ],
    supportsCommonSource: true,
    note: null,
  };
}

const SKILL_LIBRARY = {
  schemaVersion: 1,
  commonRoot: `${SKILL_REPO}/skills`,
  commonRootPresent: true,
  currentPlatform: "macos",
  entries: SKILL_ENTRIES,
  adapters: [
    skillAdapter("claude", "Claude Code"),
    skillAdapter("codex", "OpenAI Codex"),
    skillAdapter("antigravity", "Google Antigravity"),
    skillAdapter("local", "Ollama"),
  ],
  projects: SKILL_PROJECTS,
  issues: [],
};

const RELEASE_NOTES_BODY = tr(`---
name: release-notes
description: 태그 사이 커밋을 모아 사용자용 릴리스 노트 초안을 한국어·영어로 작성한다.
---

# 릴리스 노트 작성

1. 직전 태그와 HEAD 사이의 커밋을 \`git log --no-merges\`로 모은다.
2. 사용자에게 보이는 변화만 골라 **새 기능 / 개선 / 수정** 세 묶음으로 나눈다.
3. 내부 리팩터링·테스트 전용 커밋은 제외하고, 호환성 변화는 맨 위에 따로 적는다.
4. 한국어 본문을 먼저 쓰고 같은 구조로 영어 본문을 붙인다.

## 산출물
- \`docs/releases/<버전>.md\`
- GitHub Release 본문 초안
`, `---
name: release-notes
description: Collects commits between tags and drafts user-facing release notes in Korean and English.
---

# Writing release notes

1. Collect the commits between the previous tag and HEAD with \`git log --no-merges\`.
2. Keep only user-visible changes and group them as **New / Improved / Fixed**.
3. Leave out internal refactoring and test-only commits; list compatibility changes separately at the top.
4. Write the Korean notes first, then add English notes with the same structure.

## Outputs
- \`docs/releases/<version>.md\`
- Draft body for the GitHub Release
`);

const RELEASE_NOTES_DETAIL = {
  source: SKILL_ENTRIES[0].common,
  body: RELEASE_NOTES_BODY,
  files: [
    { name: "SKILL.md", relativePath: "SKILL.md", sizeBytes: 1_840, isDirectory: false, children: [] },
    { name: "references", relativePath: "references", sizeBytes: 0, isDirectory: true, children: [
      { name: "style-guide.md", relativePath: "references/style-guide.md", sizeBytes: 2_310, isDirectory: false, children: [] },
      { name: "categories.json", relativePath: "references/categories.json", sizeBytes: 640, isDirectory: false, children: [] },
    ] },
    { name: "scripts", relativePath: "scripts", sizeBytes: 0, isDirectory: true, children: [
      { name: "collect-commits.mjs", relativePath: "scripts/collect-commits.mjs", sizeBytes: 1_120, isDirectory: false, children: [] },
    ] },
  ],
};

// ---------------------------------------------------------------------------
// 지침 표본

const POLICY_REPO = "/workspace/.agent-manager/resource-repository/policies";
const POLICY_FILE: Record<string, string> = { claude: "CLAUDE.md", codex: "AGENTS.md", antigravity: "GEMINI.md" };
const PERSONAL_POLICY_DIR: Record<string, string> = { claude: "/workspace/.claude", codex: "/workspace/.codex", antigravity: "/workspace/.gemini" };

function policyDeployment(provider: string, project: string | null, source: string, state: "ok" | "edited" | "foreign" = "ok", linkedFiles: string[] = []) {
  const projectPath = project ? `/workspace/${project}` : PERSONAL_POLICY_DIR[provider];
  const managed = state !== "foreign";
  return {
    provider,
    scope: project ? "project" : "personal",
    projectPath,
    filePath: `${projectPath}/${POLICY_FILE[provider]}`,
    present: true,
    managed,
    contentDigest: state === "ok" ? source : "4e7a90c1d25b83f6",
    sourceDigest: managed ? source : null,
    divergent: state === "edited",
    linkedFiles,
    linkedMissing: [],
    linkedChanged: [],
    linkedUnarchived: [],
    linkIssues: [],
    setDigest: state === "ok" ? source : "4e7a90c1d25b83f6",
  };
}

function policyEntry(key: string, name: string, description: string, providers: string[], digest: string, deployments: ReturnType<typeof policyDeployment>[], linkedFiles: string[] = []) {
  return {
    key,
    name,
    description,
    directory: `${POLICY_REPO}/${key}`,
    sourceDigest: digest,
    providers,
    platforms: [],
    currentPlatformSupported: true,
    currentPlatformVariant: null,
    autoSync: key !== "mobile-release",
    linkedFiles,
    deployments,
  };
}

const D_TEAM = "a41f0c9e7b2d5816";
const D_PAY = "c93b17e0f4a286d5";
const D_MOBILE = "5d20e8a1c7f49b36";
const D_DOCS = "e1b7a5093d6cf284";
const D_INFRA = "7f3c8e21a90b4d65";
const D_PERSONAL = "b2d4f6081a3c5e79";

const TEAM_LINKED = ["docs/architecture.md", "docs/testing.md"];
const POLICY_ENTRIES = [
  policyEntry("team-engineering-rules", tr("팀 공통 엔지니어링 규칙", "Team engineering rules"), tr("아키텍처 경계, 보안 불변식, 검증 사다리, 커밋 규칙을 모든 에이전트에 같은 문장으로 전한다.", "Gives every agent the same architecture boundaries, security invariants, verification ladder and commit rules."), ["claude", "codex", "antigravity"], D_TEAM, [
    policyDeployment("claude", "agent-manager", D_TEAM, "ok", TEAM_LINKED),
    policyDeployment("codex", "agent-manager", D_TEAM, "ok", TEAM_LINKED),
    policyDeployment("antigravity", "agent-manager", D_TEAM, "ok", TEAM_LINKED),
    policyDeployment("claude", "design-system", D_TEAM, "ok", TEAM_LINKED),
    policyDeployment("codex", "design-system", D_TEAM, "ok", TEAM_LINKED),
  ], TEAM_LINKED),
  policyEntry("payments-security", tr("결제 도메인 보안 지침", "Payments security guidelines"), tr("카드 정보·멱등성 키·감사 로그를 다루는 코드에서 반드시 지킬 규칙.", "Rules that code handling card data, idempotency keys and audit logs must follow."), ["claude", "codex"], D_PAY, [
    policyDeployment("claude", "payments-api", D_PAY),
    policyDeployment("codex", "payments-api", D_PAY),
  ]),
  policyEntry("mobile-release", tr("모바일 릴리스 체크리스트", "Mobile release checklist"), tr("스토어 제출 전 버전·권한 문구·딥링크·접근성을 점검하는 순서.", "The order for checking versions, permission strings, deep links and accessibility before store submission."), ["codex", "antigravity"], D_MOBILE, [
    policyDeployment("codex", "mobile-app", D_MOBILE, "edited"),
    policyDeployment("antigravity", "mobile-app", D_MOBILE),
  ]),
  policyEntry("docs-style", tr("문서 작성 스타일", "Docs writing style"), tr("용어집, 제목 규칙, 예제 코드 블록 형식을 문서 사이트 기준으로 맞춘다.", "Aligns glossary, heading rules and code-sample formatting with the docs site."), ["claude", "codex"], D_DOCS, [
    policyDeployment("claude", "docs-site", D_DOCS),
    policyDeployment("codex", "docs-site", D_DOCS),
  ]),
  policyEntry("infra-change-policy", tr("인프라 변경 정책", "Infrastructure change policy"), tr("plan 결과를 먼저 보이고, 상태 파일과 운영 워크스페이스는 건드리지 않는다.", "Show the plan output first; never touch state files or production workspaces."), ["codex", "claude"], D_INFRA, [
    policyDeployment("codex", "infra-terraform", D_INFRA),
  ]),
  policyEntry("personal-defaults", tr("개인 기본 응답 규칙", "Personal response defaults"), tr("한국어로 답하고, 추측은 추측이라고 밝히며, 변경 전후를 짧게 요약한다.", "Answer concisely, label guesses as guesses, and summarize before/after for every change."), ["claude", "codex", "antigravity"], D_PERSONAL, [
    policyDeployment("claude", null, D_PERSONAL),
    policyDeployment("codex", null, D_PERSONAL),
    policyDeployment("antigravity", null, D_PERSONAL),
  ]),
];

const POLICY_LIBRARY = {
  schemaVersion: 1,
  commonRoot: POLICY_REPO,
  commonRootPresent: true,
  currentPlatform: "macos",
  projects: ["agent-manager", "payments-api", "mobile-app", "docs-site", "infra-terraform", "design-system"].map((p) => `/workspace/${p}`),
  entries: POLICY_ENTRIES,
  deployments: [
    ...POLICY_ENTRIES.flatMap((e) => e.deployments),
    policyDeployment("antigravity", "docs-site", D_DOCS, "foreign"),
  ],
  issues: [],
};

const TEAM_POLICY_BODY = tr(`# 팀 공통 엔지니어링 규칙

변경을 완료로 보고하기 전에 만족해야 할 조건이다. 조건 ID는 리뷰와 테스트 이름에 그대로 인용한다.

## 1. 아키텍처 경계

| 계층 | 담당 | 하지 말 것 |
| --- | --- | --- |
| \`web/\` | 렌더링, 입력 수집, 타입 있는 API 호출 | 도메인 로직, 파일시스템 직접 접근 |
| \`server/\` | 요청을 코어 호출로 옮기는 얇은 어댑터 | 자체 상태 저장소 |
| \`core/\` | 도메인 모델, 영속화, 프로세스 관리 | 프레임워크 의존 |

## 2. 보안 불변식

- **G1** 비밀값은 OS 보안 저장소에만 둔다. 로그·오류·응답에 싣지 않는다.
- **G2** 셸 문자열을 실행하지 않는다. 승인된 실행 파일에 인자 배열을 넘긴다.
- **G3** 경로는 읽거나 쓰기 전에 정규화하고 허용 루트 안인지 확인한다.

## 3. 검증

가장 좁은 단계부터 오른다. 자세한 기준은 [테스트 가이드](docs/testing.md)와 @docs/architecture.md 를 따른다.
`, `# Team engineering rules

Conditions a change must meet before it is reported complete. Cite the condition IDs in reviews and test names.

## 1. Architecture boundary

| Layer | Owns | Must not |
| --- | --- | --- |
| \`web/\` | rendering, input collection, typed API calls | domain logic, direct filesystem access |
| \`server/\` | thin adapter turning requests into core calls | its own state store |
| \`core/\` | domain models, persistence, process supervision | framework dependencies |

## 2. Security invariants

- **G1** Secrets live only in the OS secure store — never in logs, errors or responses.
- **G2** Never execute a shell string. Pass an argument vector to an approved executable.
- **G3** Canonicalize every path and confirm it is inside an allowed root before reading or writing.

## 3. Verification

Start at the narrowest rung. See the [testing guide](docs/testing.md) and @docs/architecture.md for details.
`);

function policyBody(provider: string, projectPath: string): string {
  const project = projectPath.split("/").pop() ?? "";
  if (project === "payments-api") return tr("# 결제 도메인 보안 지침\n\n- 카드 번호는 토큰으로만 다룬다.\n- 멱등성 키 없이 결제 상태를 바꾸지 않는다.\n- 감사 로그는 추가만 한다.\n", "# Payments security guidelines\n\n- Handle card numbers only as tokens.\n- Never change payment state without an idempotency key.\n- Audit logs are append-only.\n");
  if (project === "mobile-app") return tr("# 모바일 릴리스 체크리스트\n\n1. 버전 코드와 빌드 번호를 올린다.\n2. 권한 문구를 스토어 정책과 대조한다.\n3. 딥링크 라우팅을 실제 기기에서 확인한다.\n", "# Mobile release checklist\n\n1. Bump the version code and build number.\n2. Check permission strings against store policy.\n3. Verify deep-link routing on a real device.\n");
  const title = tr("# 팀 공통 엔지니어링 규칙", "# Team engineering rules");
  return TEAM_POLICY_BODY.replace(title, `${title} (${POLICY_FILE[provider] ?? "AGENTS.md"})`);
}

function stubInstructions(): void {
  cy.stubInvoke("get_project_instruction_library", { statusCode: 200, body: POLICY_LIBRARY });
  cy.stubInvoke("list_instruction_trash", { statusCode: 200, body: { root: "/workspace/.agent-manager/instruction-trash", items: [], totalBytes: 0 } });
  cy.stubInvoke("read_project_instruction_file", (req) => {
    const { key, provider } = req.body as { key: string; provider: string };
    req.reply({ statusCode: 200, body: { key, provider, sourceVariant: null, content: key === "team-engineering-rules" ? TEAM_POLICY_BODY : `# ${key}\n` } });
  });
  cy.stubInvoke("read_deployed_instruction_file", (req) => {
    const b = req.body as { scope?: string; projectPath?: string | null; provider: string; request?: Record<string, string> };
    const r = (b.request ?? b) as { scope: string; projectPath: string; provider: string };
    req.reply({ statusCode: 200, body: { scope: r.scope, projectPath: r.projectPath, provider: r.provider, filePath: `${r.projectPath}/${POLICY_FILE[r.provider]}`, content: policyBody(r.provider, r.projectPath ?? "") } });
  });
}

// ---------------------------------------------------------------------------
// 파일(문서) 표본

const DOC_ROOTS = [
  { id: "root-am", name: tr("agent-manager 설계 문서", "agent-manager design docs"), path: "/workspace/agent-manager/docs", agentData: false, exists: true, restricted: false },
  { id: "root-pay", name: tr("payments-api 운영 노트", "payments-api ops notes"), path: "/workspace/payments-api/docs", agentData: false, exists: true, restricted: false },
  { id: "root-site", name: tr("docs-site 콘텐츠", "docs-site content"), path: "/workspace/docs-site/content", agentData: false, exists: true, restricted: false },
];

function docEntry(parentPath: string, name: string, isDirectory: boolean, sizeBytes = 0, hoursAgo = 30) {
  const relativePath = parentPath ? `${parentPath}/${name}` : name;
  return { name, relativePath, parentPath, sizeBytes, modifiedAt: NOW - hoursAgo * HOUR, isDirectory, previewKind: isDirectory ? null : name.endsWith(".md") ? "markdown" : "text" };
}

const DOC_TREE: Record<string, ReturnType<typeof docEntry>[]> = {
  "": [
    docEntry("", "design", true),
    docEntry("", "milestones", true),
    docEntry("", "runbooks", true),
    docEntry("", "E2E.md", false, 6_420, 50),
    docEntry("", "RELEASING.md", false, 3_980, 26),
    docEntry("", "SECURITY.md", false, 5_210, 140),
  ],
  design: [
    docEntry("design", "backend-architecture.md", false, 12_840, 2),
    docEntry("design", "credential-isolation.md", false, 9_310, 20),
    docEntry("design", "session-catalog.md", false, 7_605, 44),
    docEntry("design", "workflow-pacing.md", false, 8_112, 70),
  ],
  milestones: [
    docEntry("milestones", "v0.3.0.md", false, 4_022, 5),
    docEntry("milestones", "v0.4.0.md", false, 2_714, 12),
  ],
  runbooks: [docEntry("runbooks", "remote-access.md", false, 3_300, 90)],
};

const DESIGN_DOC = tr(`# 백엔드 아키텍처

> 상태: **확정** · 담당: 플랫폼 팀 · 마지막 검토: 2026-09-28

Agent Manager는 하나의 루프백 백엔드가 Core를 감싸고, 데스크톱·브라우저·원격 UI가 모두 같은 타입 있는 HTTP/WebSocket 계약으로 붙는다.

## 요청 흐름

\`\`\`mermaid
flowchart LR
    UI["데스크톱 · 브라우저 UI"] -->|invoke / WebSocket| Server["agent-manager-server"]
    Server -->|쓰기 게이트| Core["agent-manager-core"]
    Core --> Catalog[("세션 카탈로그")]
    Core --> Supervisor["채팅 · 터미널 감독자"]
    Supervisor --> CLI["공급자 CLI"]
\`\`\`

## 계층별 책임

| 계층 | 담당 | 하지 말 것 |
| --- | --- | --- |
| \`src/\` | 렌더링, 입력 수집, IPC 호출 | 도메인 로직 |
| \`agent-manager-server\` | 전송, 인증, 쓰기 게이트 | 도메인 로직 |
| \`agent-manager-core\` | 모델, 파싱, 영속화, 프로세스 감독 | UI 의존 |

## 결정 기록

1. 원격 쓰기는 \`remoteWrite\` 한 곳에서만 결정한다.
2. 공급자 저장소는 읽기 전용으로만 연다.
`, `# Backend architecture

> Status: **Accepted** · Owner: Platform team · Last reviewed: 2026-09-28

Agent Manager wraps Core in a single loopback backend; the desktop, browser and remote UIs all attach through the same typed HTTP/WebSocket contract.

## Request flow

\`\`\`mermaid
flowchart LR
    UI["Desktop · Browser UI"] -->|invoke / WebSocket| Server["agent-manager-server"]
    Server -->|write gate| Core["agent-manager-core"]
    Core --> Catalog[("Session catalog")]
    Core --> Supervisor["Chat · terminal supervisor"]
    Supervisor --> CLI["Provider CLIs"]
\`\`\`

## Responsibilities by layer

| Layer | Owns | Must not |
| --- | --- | --- |
| \`src/\` | rendering, input collection, IPC calls | domain logic |
| \`agent-manager-server\` | transport, auth, write gate | domain logic |
| \`agent-manager-core\` | models, parsing, persistence, process supervision | UI dependencies |

## Decision log

1. Remote writes are decided in one place only: \`remoteWrite\`.
2. Provider stores are opened read-only.
`);

function stubDocs(): void {
  cy.stubInvoke("get_doc_roots", { statusCode: 200, body: DOC_ROOTS });
  cy.stubInvoke("list_document_entries", (req) => {
    const b = req.body as { rootId: string; parentPath?: string | null };
    const entries = b.rootId === "root-am" ? DOC_TREE[b.parentPath ?? ""] ?? [] : [docEntry("", "README.md", false, 2_048, 8), docEntry("", "guides", true)];
    req.reply({ statusCode: 200, body: { entries, nextCursor: null, total: entries.length } });
  });
  cy.stubInvoke("get_document_file", (req) => {
    const b = req.body as { rootId: string; relativePath: string };
    req.reply({ statusCode: 200, body: { rootId: b.rootId, relativePath: b.relativePath, kind: "markdown", content: DESIGN_DOC, modifiedAt: NOW - 2 * HOUR, sizeBytes: 12_840, downloadable: true } });
  });
}

// ---------------------------------------------------------------------------
// 스냅숏에 에이전트·아티팩트를 더한다. stubSnapshot과 같은 필드를 다시 채운다(마지막 가로채기가 이긴다).

function stubSnapshotWith(extra: Record<string, unknown>): void {
  const apply = (body: Record<string, unknown>) => {
    (body.status as Record<string, unknown>).providers = PROVIDERS_STATUS;
    body.dashboard = DASHBOARD;
    body.folders = FOLDERS;
    body.pendingProjects = [];
    Object.assign(body, extra);
  };
  cy.stubInvoke("get_manager_snapshot", (req) => {
    req.continue((res) => {
      const body = res.body as Record<string, unknown>;
      apply(body);
      body.sessions = SESSIONS;
    });
  });
  cy.stubInvoke("get_manager_snapshot_delta", (req) => {
    req.continue((res) => {
      const body = res.body as Record<string, unknown>;
      apply(body);
      if (body.kind === "full") body.sessions = SESSIONS;
      else {
        body.changedSessions = [];
        body.removedSessions = [];
      }
    });
  });
}

function agentDef(name: string, description: string, tools: string[], model: string | null, skills: string[] = [], maxTurns: number | null = null, permissionMode: string | null = null) {
  return { name, description, tools, model, maxTurns, permissionMode, skills, path: `/workspace/.claude/agents/${name}.md` };
}

const AGENTS = [
  agentDef("code-reviewer", tr("변경분을 정확성·회귀·보안 관점으로 검토하고 근거가 있는 지적만 남긴다.", "Reviews a diff for correctness, regressions and security, and reports only well-founded findings."), ["Read", "Grep", "Glob", "Bash"], "opus", ["code-review"], 30, "plan"),
  agentDef("test-writer", tr("바뀐 동작마다 실패하던 테스트를 먼저 쓰고, 통과시키는 최소 수정을 제안한다.", "Writes a failing test for each behavior change first, then proposes the smallest fix that passes."), ["Read", "Edit", "Write", "Bash"], "sonnet", ["e2e-harness"], 40),
  agentDef("security-auditor", tr("비밀값 노출, 셸 문자열 실행, 경로 탈출을 찾아 심각도 순으로 보고한다.", "Finds secret exposure, shell-string execution and path escapes, reported by severity."), ["Read", "Grep", "Glob"], "opus", ["security-check"], 25, "plan"),
  agentDef("migration-planner", tr("스키마 변경을 되돌릴 수 있는 단계로 쪼개고 단계마다 롤백 절차를 붙인다.", "Breaks schema changes into reversible steps with a rollback procedure for each."), ["Read", "Grep", "Write"], "sonnet", ["db-migration"], 20),
  agentDef("docs-writer", tr("공개 API와 설정 항목의 레퍼런스 문서를 예제와 함께 갱신한다.", "Updates reference docs for the public API and settings, with examples."), ["Read", "Edit", "Write", "WebFetch"], "sonnet", ["api-docs"], 30),
  agentDef("ui-reviewer", tr("스크린샷과 컴포넌트 코드를 대조해 접근성·일관성 문제를 찾는다.", "Compares screenshots against component code to find accessibility and consistency issues."), ["Read", "Grep", "Glob", "Bash"], "sonnet", ["ui-reviewer"], 20, "plan"),
  agentDef("release-captain", tr("릴리스 노트, 버전 동기화, 태그 전 점검 목록을 한 번에 준비한다.", "Prepares release notes, version sync and the pre-tag checklist in one pass."), ["Read", "Edit", "Bash", "Grep"], "opus", ["release-notes", "changelog"], 50),
  agentDef("perf-profiler", tr("느린 쿼리와 핫 경로를 측정값으로 좁히고 개선 전후 수치를 남긴다.", "Narrows slow queries and hot paths with measurements and records before/after numbers."), ["Read", "Bash", "Grep"], "sonnet", [], 35),
  agentDef("incident-scribe", tr("장애 대화와 로그에서 타임라인과 후속 조치 목록을 정리한다.", "Builds an incident timeline and follow-up list from chat threads and logs."), ["Read", "Grep", "Write"], "haiku", [], 15),
];

const AGENT_BODY = tr(`당신은 코드 리뷰어다. 변경분만 읽고, 확실한 문제만 지적한다.

## 순서
1. \`git diff\`로 변경 범위를 확인한다.
2. 정확성 → 회귀 → 보안 → 단순화 순서로 본다.
3. 지적마다 파일:줄, 재현 조건, 제안 수정을 적는다.

## 하지 말 것
- 취향 문제를 결함처럼 적지 않는다.
- 변경되지 않은 코드를 다시 설계하자고 하지 않는다.
`, `You are a code reviewer. Read only the diff and point out only definite problems.

## Order
1. Check the scope of the change with \`git diff\`.
2. Look at correctness → regressions → security → simplification, in that order.
3. For each finding, give file:line, how to reproduce, and a suggested fix.

## Don't
- Present matters of taste as defects.
- Propose redesigning code that did not change.
`);

function artifact(conversationId: string, rootName: string, name: string, type: string | null, summary: string, minutesAgo: number, versions: number[], sizeBytes: number) {
  return { conversationId, rootName, name, artifactType: type, summary, updatedAt: NOW - minutesAgo * MIN, version: versions[versions.length - 1] ?? null, versions, sizeBytes };
}

const ARTIFACT_GROUPS = [
  { conversationId: "8f2c41d0-6a7e-4b19-9c3d-2e5f7a1b0c84", rootName: "brain", title: tr("온보딩 화면 접근성 점검", "Accessibility pass on onboarding screens"), readable: true, imageCount: 4, artifacts: [
    artifact("8f2c41d0-6a7e-4b19-9c3d-2e5f7a1b0c84", "brain", "task.md", "ARTIFACT_TYPE_TASK", tr("스크린리더 라벨 누락 7곳, 대비 부족 3곳을 찾아 수정 순서를 정했다.", "Found 7 missing screen-reader labels and 3 low-contrast spots, and ordered the fixes."), 55, [1, 2, 3], 3_412),
    artifact("8f2c41d0-6a7e-4b19-9c3d-2e5f7a1b0c84", "brain", "implementation_plan.md", "ARTIFACT_TYPE_IMPLEMENTATION_PLAN", tr("공통 버튼 컴포넌트에 accessibilityLabel을 필수로 두고 화면별 누락을 채운다.", "Make accessibilityLabel required on the shared button component and fill gaps per screen."), 58, [1, 2], 5_870),
    artifact("8f2c41d0-6a7e-4b19-9c3d-2e5f7a1b0c84", "brain", "walkthrough.md", "ARTIFACT_TYPE_WALKTHROUGH", tr("변경 전후 VoiceOver 읽기 순서와 대비 측정값을 스크린샷과 함께 정리했다.", "Before/after VoiceOver reading order and contrast measurements, with screenshots."), 62, [1], 4_205),
  ] },
  { conversationId: "3b9e07a5-12cd-4f60-8a4b-9d1c6e2f5a37", rootName: "brain", title: tr("다국어 문자열 누락 탐지 스크립트", "Script to detect missing i18n strings"), readable: true, imageCount: 0, artifacts: [
    artifact("3b9e07a5-12cd-4f60-8a4b-9d1c6e2f5a37", "brain", "task.md", "ARTIFACT_TYPE_TASK", tr("ko·en·ja 리소스를 비교해 누락 키 42개를 찾는 스크립트를 만든다.", "Build a script that compares ko/en/ja resources and finds the 42 missing keys."), 420, [1, 2], 2_188),
    artifact("3b9e07a5-12cd-4f60-8a4b-9d1c6e2f5a37", "brain", "implementation_plan.md", "ARTIFACT_TYPE_IMPLEMENTATION_PLAN", tr("CI 단계에서 누락 키가 생기면 실패하도록 검사 단계를 추가한다.", "Add a CI check that fails when a key goes missing."), 425, [1], 3_904),
  ] },
  { conversationId: "c6a1f3e8-7d24-4b5a-b0e9-51f8c2d7a693", rootName: "brain", title: tr("푸시 알림 딥링크 설계 검토", "Push-notification deep-link design review"), readable: true, imageCount: 2, artifacts: [
    artifact("c6a1f3e8-7d24-4b5a-b0e9-51f8c2d7a693", "brain", "implementation_plan.md", "ARTIFACT_TYPE_IMPLEMENTATION_PLAN", tr("알림 페이로드의 route를 화이트리스트로 검증하고 앱 시작 경로를 하나로 합친다.", "Validate the payload route against an allowlist and merge the app launch paths into one."), 1_900, [1, 2, 3, 4], 7_031),
    artifact("c6a1f3e8-7d24-4b5a-b0e9-51f8c2d7a693", "brain", "walkthrough.md", "ARTIFACT_TYPE_WALKTHROUGH", tr("콜드 스타트·백그라운드·포그라운드 세 경로에서 라우팅을 확인한 결과.", "Routing verified across cold start, background and foreground."), 1_880, [1], 3_550),
  ] },
  { conversationId: "e40d9b27-5c83-4a1f-96e2-7b3a0c8d1f56", rootName: "brain", title: tr("디자인 토큰 다크 테마 대비 조정", "Dark-theme contrast tuning for design tokens"), readable: true, imageCount: 6, artifacts: [
    artifact("e40d9b27-5c83-4a1f-96e2-7b3a0c8d1f56", "brain", "task.md", "ARTIFACT_TYPE_TASK", tr("텍스트·보더 토큰 18개의 대비를 WCAG AA 기준으로 다시 맞춘다.", "Re-tune 18 text and border tokens to meet WCAG AA contrast."), 3_100, [1, 2], 2_760),
    artifact("e40d9b27-5c83-4a1f-96e2-7b3a0c8d1f56", "brain", "walkthrough.md", "ARTIFACT_TYPE_WALKTHROUGH", tr("조정 전후 대비값 표와 컴포넌트 스냅숏 비교.", "Before/after contrast table and component snapshot comparison."), 3_050, [1], 5_118),
  ] },
  { conversationId: "1d7b5e93-0a4c-4e28-b6f1-8c2e9a3d7f40", rootName: "brain", title: tr("검색 인덱스 증분 갱신 설계", "Incremental search-index update design"), readable: true, imageCount: 1, artifacts: [
    artifact("1d7b5e93-0a4c-4e28-b6f1-8c2e9a3d7f40", "brain", "implementation_plan.md", "ARTIFACT_TYPE_IMPLEMENTATION_PLAN", tr("변경된 문서만 다시 색인하도록 해시 비교 단계를 앞에 둔다.", "Put a hash-comparison step first so only changed documents are re-indexed."), 4_300, [1, 2], 4_644),
    artifact("1d7b5e93-0a4c-4e28-b6f1-8c2e9a3d7f40", "brain", "task.md", "ARTIFACT_TYPE_TASK", tr("색인 시간 14분 → 90초 목표, 회귀 검사 6건 추가.", "Target: indexing from 14 min down to 90 s, plus 6 regression checks."), 4_280, [1], 1_930),
  ] },
  { conversationId: "a58c2f17-9e3b-4d06-8b71-3f4d0e6c9a22", rootName: "brain", title: tr("웹훅 재시도 정책 비교", "Webhook retry policy comparison"), readable: true, imageCount: 0, artifacts: [
    artifact("a58c2f17-9e3b-4d06-8b71-3f4d0e6c9a22", "brain", "walkthrough.md", "ARTIFACT_TYPE_WALKTHROUGH", tr("지수 백오프와 고정 간격의 실패율·지연을 부하 테스트로 비교한 결과.", "Load-test comparison of failure rate and latency: exponential backoff vs fixed interval."), 5_900, [1, 2], 6_210),
    artifact("a58c2f17-9e3b-4d06-8b71-3f4d0e6c9a22", "brain", "task.md", "ARTIFACT_TYPE_TASK", tr("최대 재시도 8회, 지터 20%로 확정하고 알림 기준을 정한다.", "Settle on 8 max retries with 20% jitter and define alert thresholds."), 5_950, [1], 1_402),
  ] },
];

const WALKTHROUGH_BODY = tr(`# 온보딩 화면 접근성 점검 — 워크스루

## 요약
- 스크린리더 라벨 누락 **7곳**을 채웠다.
- 대비 부족 **3곳**을 디자인 토큰 조정으로 해결했다.

## 변경 전후

| 화면 | 문제 | 조치 | 결과 |
| --- | --- | --- | --- |
| 환영 | 건너뛰기 버튼 라벨 없음 | accessibilityLabel 추가 | ✅ |
| 권한 요청 | 보조 문구 대비 3.1:1 | text.secondary 토큰 상향 | 4.8:1 |
| 프로필 | 이미지 버튼 역할 누락 | role="button" 지정 | ✅ |

## 확인 방법
1. iOS VoiceOver로 환영 → 권한 요청 → 프로필 순서를 읽는다.
2. Android TalkBack으로 같은 경로를 반복한다.
`, `# Onboarding accessibility pass — walkthrough

## Summary
- Filled **7** missing screen-reader labels.
- Fixed **3** low-contrast spots by tuning design tokens.

## Before and after

| Screen | Problem | Fix | Result |
| --- | --- | --- | --- |
| Welcome | Skip button has no label | Added accessibilityLabel | ✅ |
| Permissions | Helper text contrast 3.1:1 | Raised text.secondary token | 4.8:1 |
| Profile | Image button missing role | Set role="button" | ✅ |

## How to verify
1. Read Welcome → Permissions → Profile with iOS VoiceOver.
2. Repeat the same path with Android TalkBack.
`);

const STORAGE_OVERVIEW = {
  sourceTotalBytes: 1_420_000_000,
  managerTotalBytes: 186_400_000,
  totalBytes: 1_606_400_000,
  sourceItems: [
    { id: "claude", label: "Claude Code", description: "/workspace/.claude/projects", sizeBytes: 520_000_000, fileCount: 1_842 },
    { id: "codex", label: "OpenAI Codex", description: "/workspace/.codex/sessions", sizeBytes: 690_000_000, fileCount: 2_311 },
    { id: "antigravity", label: "Google Antigravity", description: "/workspace/.gemini/antigravity-cli", sizeBytes: 140_000_000, fileCount: 412 },
    { id: "local", label: "Ollama", description: "/workspace/.local/share/opencode", sizeBytes: 70_000_000, fileCount: 96 },
  ],
  managerItems: [
    { id: "supplements", label: tr("보완 응답", "Supplemental replies"), description: tr("실행 중 받은 최종 응답", "Final replies captured during runs"), sizeBytes: 38_600_000, fileCount: 1_204 },
    { id: "chat-inputs", label: tr("채팅 첨부", "Chat attachments"), description: tr("대화에 붙인 파일과 이미지", "Files and images attached to chats"), sizeBytes: 92_300_000, fileCount: 318 },
    { id: "scheduler", label: tr("반복 요청", "Recurring requests"), description: tr("일정·실행 이력", "Schedules and run history"), sizeBytes: 4_100_000, fileCount: 12 },
    { id: "translations", label: tr("번역 캐시", "Translation cache"), description: tr("화면·자원 번역 결과", "Screen and resource translations"), sizeBytes: 21_900_000, fileCount: 3 },
    { id: "state", label: tr("앱 상태", "App state"), description: tr("세션 메타데이터·폴더·설정", "Session metadata, folders and settings"), sizeBytes: 29_500_000, fileCount: 27 },
  ],
  supplements: { turnCount: 1_204, sessionCount: 268, sizeBytes: 38_600_000 },
};

const CLEANUP_STATUS = {
  policy: { enabled: true, retentionDays: 90, maxMessageCount: 1, perProviderCap: 400, perAutomationCap: 30, hiddenAfterDays: 7, trashRetentionDays: 14, intervalHours: 24 },
  lastRunAt: NOW - 9 * HOUR,
  nextRunAt: NOW + 15 * HOUR,
  sessionCount: 486,
  tombstoneCount: 212,
  preview: {
    targetCount: 38,
    removableCount: 11,
    removableBytes: 24 * 1024 * 1024,
    protectedCount: 6,
    remainingCount: 448,
    byReason: [
      { reason: "emptySession", label: tr("빈 세션", "Empty sessions"), count: 14 },
      { reason: "providerCap", label: tr("공급자별 상한 초과", "Over per-provider cap"), count: 0 },
      { reason: "automationCap", label: tr("일정별 회차 상한 초과", "Over per-schedule run cap"), count: 17 },
      { reason: "retention", label: tr("보존 기간 경과", "Past retention period"), count: 5 },
      { reason: "hiddenAged", label: tr("보관 후 경과", "Archived and aged"), count: 2 },
    ],
    orphanAttachmentCount: 0,
    orphanAttachmentBytes: 0,
  },
  receipts: [],
};

const SAVED_SECRETS = {
  secrets: [
    { name: "NPM_TOKEN", purpose: tr("비공개 패키지 레지스트리 배포", "Publish to the private package registry"), createdAt: NOW - 30 * DAY, updatedAt: NOW - 30 * DAY, lastUsedAt: NOW - 3 * HOUR, agentEnabled: true },
    { name: "SENTRY_AUTH_TOKEN", purpose: tr("릴리스 소스맵 업로드", "Upload release source maps"), createdAt: NOW - 21 * DAY, updatedAt: NOW - 4 * DAY, lastUsedAt: NOW - 26 * HOUR, agentEnabled: true },
    { name: "STAGING_DB_PASSWORD", purpose: tr("스테이징 DB 마이그레이션 검증", "Verify staging DB migrations"), createdAt: NOW - 12 * DAY, updatedAt: NOW - 12 * DAY, lastUsedAt: NOW - 5 * DAY, agentEnabled: false },
    { name: "STRIPE_TEST_KEY", purpose: tr("결제 API 통합 테스트", "Payments API integration tests"), createdAt: NOW - 8 * DAY, updatedAt: NOW - 8 * DAY, lastUsedAt: NOW - 38 * MIN, agentEnabled: true },
    { name: "FIGMA_TOKEN", purpose: tr("디자인 토큰 내보내기", "Export design tokens"), createdAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY, lastUsedAt: null, agentEnabled: true },
  ],
};

const CHAT_SECRETS = {
  ttlSeconds: 3_600,
  chats: [
    { chatId: "chat-refund", source: "claude", profile: "standard", cwd: "/workspace/payments-api", startedAt: NOW - 40 * MIN, secrets: [
      { name: "STRIPE_TEST_KEY", purpose: tr("결제 API 통합 테스트", "Payments API integration tests"), expiresAt: NOW + 48 * MIN, source: "saved" },
      { name: "WEBHOOK_SIGNING_SECRET", purpose: tr("웹훅 서명 검증 재현", "Reproduce webhook signature checks"), expiresAt: NOW + 31 * MIN, source: "agent" },
    ] },
    { chatId: "chat-release", source: "codex", profile: "standard", cwd: "/workspace/agent-manager", startedAt: NOW - 3 * HOUR, secrets: [
      { name: "NPM_TOKEN", purpose: tr("비공개 패키지 레지스트리 배포", "Publish to the private package registry"), expiresAt: NOW + 22 * MIN, source: "saved" },
    ] },
  ],
};

describe("gallery b", () => {
  before(() => {
    widenHeadlessWindow();
    applyGalleryLanguage();
  });
  beforeEach(() => {
    cy.viewport(1440, 900);
    stubWorkspace();
  });

  it("skills", () => {
    cy.stubInvoke("get_skill_library", { statusCode: 200, body: SKILL_LIBRARY });
    cy.stubInvoke("get_common_skill_detail", { statusCode: 200, body: RELEASE_NOTES_DETAIL });
    visitDark({ [SKILL_FILTERS_KEY]: JSON.stringify({ kind: "all", state: "all", agent: "all", origin: "all" }) });
    cy.openView("skills");
    cy.get(".skill-mode-tabs button").contains(tr("스킬관리", "Manage")).click();
    cy.get(".skill-library-list .skill-library-item").should("have.length", 8);
    cy.get(".skill-adapter-strip").scrollIntoView({ offset: { top: -12, left: 0 } });
    shoot("skills");
  });

  it("skills-detail", () => {
    cy.stubInvoke("get_skill_library", { statusCode: 200, body: SKILL_LIBRARY });
    cy.stubInvoke("get_common_skill_detail", { statusCode: 200, body: RELEASE_NOTES_DETAIL });
    visitDark({ [SKILL_FILTERS_KEY]: JSON.stringify({ kind: "all", state: "all", agent: "all", origin: "all" }) });
    cy.openView("skills");
    cy.get(".skill-mode-tabs button").contains(tr("스킬관리", "Manage")).click();
    cy.get(".skill-library-list .skill-library-item").should("have.length", 8);
    cy.get(".skill-library-row").contains("release-notes").click();
    cy.get(".drawer").should("be.visible").and("contain.text", tr("릴리스 노트 초안", "release notes"));
    cy.get(".drawer").find("table.skill-location-matrix").should("exist");
    shoot("skills-detail");
  });
  it("instructions", () => {
    stubInstructions();
    visitDark();
    cy.openInstructionMode("manage");
    cy.get(".skill-library-row").should("have.length.at.least", 6);
    cy.get(".skill-library-row").contains(tr("팀 공통 엔지니어링 규칙", "Team engineering rules")).click();
    cy.get('.instruction-tabs [role="tab"]').eq(1).click().should("have.attr", "aria-selected", "true");
    cy.get(".skill-location-matrix").should("be.visible");
    cy.contains(tr("선택 지침 관리", "Manage selected instruction")).scrollIntoView({ offset: { top: -90, left: 0 } });
    shoot("instructions");
  });

  it("instructions-info", () => {
    stubInstructions();
    visitDark();
    cy.openInstructionMode("info");
    cy.contains(tr("팀 공통 엔지니어링 규칙", "Team engineering rules")).should("exist");
    cy.get(".skill-mode-tabs").scrollIntoView({ offset: { top: -40, left: 0 } });
    shoot("instructions-info");
  });
  it("docs", () => {
    stubDocs();
    visitDark();
    cy.openView("docs");
    cy.contains(".root-row", tr("agent-manager 설계 문서", "agent-manager design docs")).click();
    cy.contains(".tree-row.directory", "design").click();
    cy.contains(".tree-row", "backend-architecture.md").click();
    cy.get(".markdown-mermaid-canvas svg", { timeout: 20_000 }).should("have.length", 1);
    shoot("docs");
  });
  it("agents", () => {
    stubSnapshotWith({ agents: AGENTS });
    cy.stubInvoke("get_agent_detail", { statusCode: 200, body: { definition: AGENTS[0], body: AGENT_BODY } });
    visitDark();
    cy.openView("agents");
    cy.get(".agent-grid .agent-card").should("have.length", AGENTS.length);
    shoot("agents");
  });

  it("artifacts", () => {
    stubSnapshotWith({ artifacts: ARTIFACT_GROUPS });
    cy.stubInvoke("get_artifact_detail", { statusCode: 200, body: { artifact: ARTIFACT_GROUPS[0].artifacts[2], content: WALKTHROUGH_BODY } });
    visitDark();
    cy.openView("artifacts");
    cy.get(".artifact-groups .artifact-group").should("have.length", ARTIFACT_GROUPS.length);
    shoot("artifacts");
  });

  it("storage", () => {
    cy.stubInvoke("get_storage_overview", { statusCode: 200, body: STORAGE_OVERVIEW });
    cy.stubInvoke("get_session_cleanup_status", { statusCode: 200, body: CLEANUP_STATUS });
    cy.stubInvoke("list_saved_secrets", { statusCode: 200, body: SAVED_SECRETS });
    cy.stubInvoke("list_all_chat_secrets", { statusCode: 200, body: CHAT_SECRETS });
    visitDark();
    cy.openView("storage");
    cy.get(".storage-view .storage-row").should("have.length", 9);
    // 숨은 비밀정보 탭은 처음 열릴 때까지 읽기 중 표시를 들고 있다. 한 번 열어 채운 뒤 돌아온다.
    cy.anchor("storage.tab.secrets").click();
    cy.contains("SENTRY_AUTH_TOKEN").should("exist");
    cy.anchor("storage.tab.data").click();
    // 탭을 누르면 스크롤이 조금 내려가 있다. 스크롤 컨테이너를 맨 위로 되돌린다.
    cy.get(".storage-screen").then(($el) => {
      for (let node = $el[0].parentElement; node; node = node.parentElement) {
        if (node.scrollTop > 0) node.scrollTop = 0;
      }
    });
    shoot("storage");
  });

  it("storage-secrets", () => {
    cy.stubInvoke("get_storage_overview", { statusCode: 200, body: STORAGE_OVERVIEW });
    cy.stubInvoke("get_session_cleanup_status", { statusCode: 200, body: CLEANUP_STATUS });
    cy.stubInvoke("list_saved_secrets", { statusCode: 200, body: SAVED_SECRETS });
    cy.stubInvoke("list_all_chat_secrets", { statusCode: 200, body: CHAT_SECRETS });
    visitDark();
    cy.openView("storage");
    cy.anchor("storage.tab.secrets").click();
    cy.contains("SENTRY_AUTH_TOKEN").should("exist");
    shoot("storage-secrets");
  });
});
