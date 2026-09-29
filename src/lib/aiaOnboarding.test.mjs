import assert from "node:assert/strict";
import test from "node:test";

import {
  LANE_SKILL_KEY,
  MAX_CONTRACT_INPUT_CHARS,
  MAX_CONTRACT_NAME_CHARS,
  MAX_CONTRACT_REQUIRED_SKILLS,
  PARALLEL_FIELD_KEYS,
  activeActions,
  creationProblems,
  isJiraProjectKey,
  notionDatabaseId,
  buildScheduleInput,
  buildWorkflowContract,
  conditionHolds,
  fillTemplate,
  initialValues,
  cardSteps,
  missingRequired,
  parallelRuns,
  plannedProcedureSkills,
  procedureSkillFiles,
  roundSavePlan,
  selectedProcedureSkillKeys,
  slugify,
  workflowIdProblems,
  supportsParallel,
  visibleFields,
} from "./aiaOnboarding.ts";

const field = (key, extra = {}) => ({
  key,
  label: { ko: key, en: null },
  kind: "text",
  required: false,
  wide: false,
  placeholder: null,
  help: null,
  defaultValue: null,
  options: [],
  min: null,
  max: null,
  visibleWhen: null,
  allowOther: false,
  ...extra,
});

const card = {
  id: "demo",
  icon: "target",
  title: { ko: "데모", en: null },
  summary: { ko: "한 줄", en: null },
  description: null,
  badge: null,
  enabled: true,
  templates: [],
  previewOnly: false,
  steps: [
    {
      id: "one",
      title: { ko: "하나", en: null },
      hint: null,
      fields: [
        field("systemKey"),
        field("projectPath", { required: true, kind: "projectPicker" }),
        field("source", { kind: "select", defaultValue: "markdown" }),
        field("folder", { defaultValue: "docs/milestones", visibleWhen: { field: "source", equals: "markdown" } }),
        field("database", { required: true, visibleWhen: { field: "source", equals: "notion" } }),
      ],
    },
  ],
  actions: [
    { kind: "createDirectory", label: { ko: "폴더", en: null }, path: "{{projectPath}}/{{folder}}", when: { field: "source", equals: "markdown" } },
    {
      kind: "registerWorkflow",
      label: { ko: "워크플로", en: null },
      when: null,
      workflow: {
        id: "{{projectPath}} round",
        displayName: "{{projectPath}} 회차",
        description: "설명",
        message: "지시문 {{folder}}",
        projectPathField: "projectPath",
        requiredSkills: ["demo-round", ""],
      },
    },
  ],
};

test("치환은 선언된 값만 바꾸고 없는 값은 빈 문자열이 된다", () => {
  assert.equal(fillTemplate("{{a}}/{{ b }}-{{missing}}", { a: "x", b: "y" }), "x/y-");
});

test("조건은 등가 비교 하나뿐이고, 조건이 없으면 늘 보인다", () => {
  assert.equal(conditionHolds(null, {}), true);
  assert.equal(conditionHolds({ field: "source", equals: "notion" }, { source: "notion" }), true);
  assert.equal(conditionHolds({ field: "source", equals: "notion" }, { source: "markdown" }), false);
  assert.equal(conditionHolds({ field: "source", equals: "notion" }, {}), false);
});

test("기본값이 시작 상태를 만든다", () => {
  const values = initialValues(card);
  assert.equal(values.folder, "docs/milestones");
  assert.equal(values.projectPath, "");
});

test("숨은 칸은 보이지도 않고 필수로 묻지도 않는다", () => {
  const values = { ...initialValues(card), projectPath: "/repo" };
  const keys = visibleFields(card.steps[0], values).map((item) => item.key);
  assert.deepEqual(keys, ["systemKey", "projectPath", "source", "folder"]);
  // database는 노션을 골랐을 때만 필수다.
  assert.deepEqual(missingRequired(card, values), []);
  assert.deepEqual(
    missingRequired(card, { ...values, source: "notion" }).map((item) => item.key),
    ["database"],
  );
});

test("조건이 맞지 않는 산출물은 실행 목록에서 빠진다", () => {
  const values = { ...initialValues(card), projectPath: "/repo" };
  assert.deepEqual(activeActions(card, values).map((action) => action.kind), ["createDirectory", "registerWorkflow"]);
  assert.deepEqual(
    activeActions(card, { ...values, source: "notion" }).map((action) => action.kind),
    ["registerWorkflow"],
  );
});

test("워크플로 id는 등록이 받는 모양으로 다듬어진다", () => {
  assert.equal(slugify("KB 펀드 Round!!"), "kb-round");
  assert.equal(slugify("--already-ok--"), "already-ok");
});

test("페이싱 계약은 한 건의 start_chat과 회차 봉투 토큰만 쓴다", () => {
  const values = { projectPath: "/repo", source: "markdown", folder: "docs/milestones" };
  const contract = buildWorkflowContract(card.actions[1].workflow, values, { paced: true });

  assert.equal(contract.paced, true);
  assert.equal(contract.steps.length, 1);
  assert.equal(contract.steps[0].operation, "start_chat");
  const chat = contract.steps[0].arguments.request.chat;
  assert.deepEqual(chat.accountId, { $run: "accountId" });
  assert.deepEqual(chat.cwd, { $run: "cwd" });
  assert.equal(chat.unattended, true);
  // 작업 경로와 지시문은 치환된 뒤 계약 입력의 기본값으로 들어간다.
  assert.equal(contract.inputSchema.projectPath.defaultValue, "/repo");
  assert.equal(contract.inputSchema.message.defaultValue, "지시문 docs/milestones");
  assert.equal(contract.inputSchema.projectPath.required, true);
  // 빈 스킬 키는 등록에서 거절되므로 걸러 낸다.
  assert.deepEqual(contract.requiredSkills, ["demo-round"]);
});

test("수동 실행 계약은 봉투 토큰 대신 공급자를 입력으로 받고 무인으로 숨기지 않는다", () => {
  const contract = buildWorkflowContract(card.actions[1].workflow, { projectPath: "/repo" }, { paced: false });

  assert.equal(contract.paced, false);
  const chat = contract.steps[0].arguments.request.chat;
  assert.equal(chat.accountId, null);
  assert.deepEqual(chat.cwd, { $input: "projectPath" });
  assert.deepEqual(chat.source, { $input: "source" });
  assert.equal(chat.unattended, false);
  assert.deepEqual(contract.inputSchema.source.values, ["claude", "codex", "antigravity", "local"]);
  assert.equal(contract.inputSchema.claudeModel, undefined);
});

test("회차는 자동 주기로, 기본은 꺼진 채 등록한다", () => {
  const input = buildScheduleInput("데모 회차", "demo-round", 3, { enabled: false, timezone: "Asia/Seoul" });
  assert.equal(input.enabled, false);
  assert.equal(input.recurrence.frequency, "auto");
  assert.equal(input.recurrence.timezone, "Asia/Seoul");
  assert.deepEqual(input.workflow, {
    workflowId: "demo-round",
    approvedVersion: 3,
    arguments: {},
    pacing: { maxRuns: 1 },
  });
  // 워크플로 회차라 프롬프트·계정·경로는 비어 있다.
  assert.equal(input.prompt, "");
  assert.equal(input.cwd, "");
});

const parallelCard = {
  ...card,
  actions: [
    {
      ...card.actions[1],
      workflow: { ...card.actions[1].workflow, parallel: true },
    },
    {
      kind: "createScheduledRequest",
      label: { ko: "회차", en: null },
      when: null,
      schedule: { name: "{{projectPath}} 회차", enabled: false },
    },
  ],
};

test("병렬을 선언한 카드에만 앱이 병렬 실행 칸을 붙인다", () => {
  assert.equal(supportsParallel(card), false);
  assert.equal(supportsParallel(parallelCard), true);
  assert.equal(cardSteps(card), card.steps);

  const steps = cardSteps(parallelCard);
  const keys = steps[steps.length - 1].fields.map((field) => field.key);
  assert.ok(keys.includes(PARALLEL_FIELD_KEYS.enabled), keys.join(","));
  assert.ok(keys.includes(PARALLEL_FIELD_KEYS.runs), keys.join(","));
});

test("병렬은 기본이 꺼짐이고, 꺼져 있으면 세부 칸도 보이지 않는다", () => {
  const values = initialValues(parallelCard);
  assert.equal(values[PARALLEL_FIELD_KEYS.enabled], "false");
  assert.equal(parallelRuns(values), 1);

  const steps = cardSteps(parallelCard);
  const lastStep = steps[steps.length - 1];
  const shown = visibleFields(lastStep, values).map((field) => field.key);
  assert.ok(shown.includes(PARALLEL_FIELD_KEYS.enabled));
  assert.ok(!shown.includes(PARALLEL_FIELD_KEYS.runs), shown.join(","));

  const on = { ...values, [PARALLEL_FIELD_KEYS.enabled]: "true" };
  const shownOn = visibleFields(lastStep, on).map((field) => field.key);
  assert.ok(shownOn.includes(PARALLEL_FIELD_KEYS.runs), shownOn.join(","));
  assert.equal(parallelRuns(on), 3);
  // 범위를 벗어난 값은 눌러 담는다. 1건은 "병렬 끔"이지 병렬 회차가 아니다.
  assert.equal(parallelRuns({ ...on, [PARALLEL_FIELD_KEYS.runs]: "1" }), 2);
  // 상한은 없다. 실제 동시 건수는 계정 여력이 자른다.
  assert.equal(parallelRuns({ ...on, [PARALLEL_FIELD_KEYS.runs]: "99" }), 99);
});

test("병렬을 켜면 지시문 앞에 레인 서문이 서고 레인 스킬 의존이 붙는다", () => {
  const values = {
    ...initialValues(parallelCard),
    projectPath: "/repo",
    [PARALLEL_FIELD_KEYS.enabled]: "true",
    [PARALLEL_FIELD_KEYS.runs]: "4",
    [PARALLEL_FIELD_KEYS.devLine]: "private/dev-history",
    [PARALLEL_FIELD_KEYS.landing]: "push",
  };
  const contract = buildWorkflowContract(parallelCard.actions[0].workflow, values, { paced: true });
  const message = contract.inputSchema.message.defaultValue;

  assert.ok(message.startsWith("## 병렬 실행"), message.slice(0, 40));
  assert.ok(message.includes("최대 4건"), message.slice(0, 200));
  assert.ok(message.includes("/repo/.rounds"), message.slice(0, 300));
  assert.ok(message.includes("private/dev-history"), message.slice(0, 300));
  // 절차 자체는 스킬에 있다. 서문은 값만 전한다.
  assert.ok(message.includes(LANE_SKILL_KEY));
  assert.ok(!message.includes("mkdir"), "절차를 서문에 베끼지 않는다");
  // 원래 지시문은 서문 뒤에 그대로 남는다.
  assert.ok(message.includes("지시문 docs/milestones"));
  assert.ok(contract.requiredSkills.includes(LANE_SKILL_KEY));
});

test("병렬이 꺼져 있으면 서문도 레인 의존도 붙지 않는다", () => {
  const values = { ...initialValues(parallelCard), projectPath: "/repo" };
  const contract = buildWorkflowContract(parallelCard.actions[0].workflow, values, { paced: true });
  assert.equal(contract.inputSchema.message.defaultValue, "지시문 docs/milestones");
  assert.ok(!contract.requiredSkills.includes(LANE_SKILL_KEY));
});

test("수동 실행에는 병렬 레인 절차를 붙이지 않는다", () => {
  const values = {
    ...initialValues(parallelCard),
    projectPath: "/repo",
    [PARALLEL_FIELD_KEYS.enabled]: "true",
    [PARALLEL_FIELD_KEYS.runs]: "4",
  };
  const contract = buildWorkflowContract(parallelCard.actions[0].workflow, values, { paced: false });
  assert.equal(contract.inputSchema.message.defaultValue, "지시문 docs/milestones");
  assert.ok(!contract.requiredSkills.includes(LANE_SKILL_KEY));
});

test("회차는 켠 병렬 건수를 그대로 싣는다", () => {
  const input = buildScheduleInput("회차", "demo-round", 1, {
    enabled: false,
    timezone: "Asia/Seoul",
    maxRuns: 4,
  });
  assert.deepEqual(input.workflow.pacing, { maxRuns: 4 });
  // 생략하면 한 건씩이다.
  const single = buildScheduleInput("회차", "demo-round", 1, { enabled: false, timezone: "UTC" });
  assert.deepEqual(single.workflow.pacing, { maxRuns: 1 });
});

const bundledSkills = [
  {
    key: "qa-round",
    description: "번들 QA 절차",
    files: [{ path: "SKILL.md", content: "---\nname: qa-round\ndescription: 번들 QA 절차\n---\n\n# QA 회차\n본문\n" }],
  },
  {
    key: LANE_SKILL_KEY,
    description: "레인 절차",
    files: [{ path: "SKILL.md", content: "---\nname: parallel-round-lanes\ndescription: 레인 절차\n---\n\n# 레인\n" }],
  },
];

const procedureCard = {
  ...card,
  actions: [
    {
      ...card.actions[1],
      workflow: { ...card.actions[1].workflow, id: "{{systemKey}}-qa", procedure: "qa-round", parallel: true },
    },
  ],
};

test("절차 스킬은 워크플로와 같은 이름으로, 프로젝트마다 따로 만들어진다", () => {
  const values = { ...initialValues(procedureCard), projectPath: "/repo", systemKey: "alpha" };
  const planned = plannedProcedureSkills(procedureCard, values, bundledSkills, {
    parallel: false,
    installed: new Set(),
  });
  assert.equal(planned.length, 1);
  // 워크플로 id와 스킬 키가 같아야 "이 회차가 따르는 절차"를 다른 규칙 없이 찾는다.
  const contract = buildWorkflowContract(procedureCard.actions[0].workflow, values, { paced: true });
  assert.equal(planned[0].key, contract.id);
  assert.ok(contract.requiredSkills.includes(contract.id), contract.requiredSkills.join(","));

  // 다른 프로젝트로 다시 돌리면 다른 키가 나온다 — 한 벌을 나눠 쓰지 않는다.
  const other = plannedProcedureSkills(
    procedureCard,
    { ...values, systemKey: "beta" },
    bundledSkills,
    { parallel: false, installed: new Set() },
  );
  assert.notEqual(other[0].key, planned[0].key);
});

test("복사본의 머리말은 한 줄짜리 새 이름·설명으로 바뀐다", () => {
  const files = procedureSkillFiles(bundledSkills[0].files[0].content, "alpha-qa", "알파 QA 회차 절차");
  const body = files[0].content;
  assert.ok(body.startsWith("---\nname: alpha-qa\ndescription: 알파 QA 회차 절차\n---"), body.slice(0, 80));
  // 본문은 그대로 따라온다.
  assert.ok(body.includes("# QA 회차"));
});

test("이미 있는 스킬은 만들지 않고, 병렬을 켜야 레인 절차가 더해진다", () => {
  const values = { ...initialValues(procedureCard), projectPath: "/repo", systemKey: "alpha" };
  const contract = buildWorkflowContract(procedureCard.actions[0].workflow, values, { paced: true });

  const withLane = plannedProcedureSkills(procedureCard, values, bundledSkills, {
    parallel: true,
    installed: new Set(),
  });
  assert.deepEqual(withLane.map((skill) => skill.key), [contract.id, LANE_SKILL_KEY]);

  // 사용자가 손봤을 수 있는 기존 사본은 건드리지 않는다.
  const skipped = plannedProcedureSkills(procedureCard, values, bundledSkills, {
    parallel: true,
    installed: new Set([contract.id]),
  });
  assert.deepEqual(skipped.map((skill) => skill.key), [LANE_SKILL_KEY]);
});

test("걸러지는 식별자는 등록 전에 막는다 — 다른 프로젝트 워크플로를 덮어쓰기 때문", () => {
  const ok = { ...initialValues(procedureCard), projectPath: "/repo", systemKey: "alpha" };
  assert.deepEqual(workflowIdProblems(procedureCard, ok), []);

  // 한글만 적으면 slugify가 통째로 걸러 다른 프로젝트와 같은 이름이 된다.
  const korean = workflowIdProblems(procedureCard, { ...ok, systemKey: "알파" });
  assert.equal(korean.length, 1);
  assert.ok(korean[0].includes("영소문자"), korean[0]);
  assert.equal(workflowIdProblems(procedureCard, { ...ok, systemKey: "" }).length, 1);
});

test("긴 식별자를 잘라도 끝이 하이픈으로 남지 않는다", () => {
  // 잘라내기를 하이픈 다듬기보다 먼저 하면 64자 경계가 하이픈에 걸려 스킬 키 검증에서
  // 거절된다. 값은 잘리더라도 키로 쓸 수 있는 모양이어야 한다.
  const long = `${"a".repeat(63)}-tail`;
  const slug = slugify(long);
  assert.equal(slug.length <= 64, true);
  assert.ok(!slug.endsWith("-"), slug);
  assert.ok(/^[a-z0-9-]+$/.test(slug), slug);
});

test("치환 자리가 없는 고정 id는 식별자 검사의 대상이 아니다", () => {
  const fixed = {
    ...procedureCard,
    actions: [{
      ...procedureCard.actions[0],
      workflow: { ...procedureCard.actions[0].workflow, id: "fixed-round" },
    }],
  };
  assert.deepEqual(workflowIdProblems(fixed, initialValues(fixed)), []);
});

test("머리말 설명은 YAML이 구조로 읽는 글자 없이 평범한 값으로 다듬는다", () => {
  const body = "---\nname: qa-round\ndescription: 번들\n---\n본문\n";
  const plain = procedureSkillFiles(body, "alpha-qa", "알파 QA 절차")[0].content;
  assert.ok(plain.includes("description: 알파 QA 절차\n"), plain.slice(0, 80));

  // 목록으로 읽히는 첫 글자, 매핑으로 읽히는 콜론, 묶음으로 읽히는 따옴표.
  const risky = procedureSkillFiles(body, "alpha-qa", '[KBF] 펀드: "QA" 절차')[0].content;
  const line = risky.split("\n")[2];
  assert.equal(line, "description: KBF] 펀드· QA 절차");
  assert.equal(risky.split("\n")[3], "---");
  // 앱의 머리말 파서는 따옴표를 떼기만 하고 이스케이프를 되돌리지 않으므로 역슬래시를
  // 남기지 않는다.
  assert.ok(!line.includes("\\"), line);

  // 다듬은 뒤 비면 키를 쓴다 — 설명이 빈 스킬은 배포에서 거절된다.
  const empty = procedureSkillFiles(body, "alpha-qa", "!!!")[0].content;
  assert.ok(empty.includes("description: alpha-qa\n"), empty.slice(0, 80));
});

test("절차를 선언한 계약은 지시문에 그 스킬의 절대 경로를 싣는다", () => {
  // 만들어진 원본은 아직 어느 공급자에도 배포돼 있지 않다. 경로가 없으면 "절차는 X
  // 스킬을 따른다"가 가리킬 대상이 실행 환경에 없다.
  const values = { ...initialValues(procedureCard), projectPath: "/repo", systemKey: "alpha" };
  const contract = buildWorkflowContract(procedureCard.actions[0].workflow, values, {
    paced: true,
    skillsRoot: "/repo-store/skills",
  });
  const message = contract.inputSchema.message.defaultValue;
  // 이름과 경로를 함께 적는다. 이름만으로는 배포되지 않은 원본을 실행 환경이 못 찾고,
  // 이름은 slugify 결과라야 실제 스킬 키와 같다.
  assert.ok(message.includes("alpha-qa 스킬(/repo-store/skills/alpha-qa/SKILL.md)"), message.slice(0, 160));
  // 절차 문장은 앞에 선다. 뒤에 붙이면 팩이 마지막 줄에 둔 "사용자 지정 스킬 우선"을 덮는다.
  assert.ok(message.startsWith("**절차는 "), message.slice(0, 40));
  assert.ok(message.trimEnd().endsWith("지시문 docs/milestones"), message.slice(-40));

  // 절차를 선언하지 않은 계약에는 붙지 않는다.
  const plain = buildWorkflowContract(card.actions[1].workflow, values, {
    paced: true,
    skillsRoot: "/repo-store/skills",
  });
  assert.ok(!plain.inputSchema.message.defaultValue.includes("스킬을 따른다"));
});

test("머리말 설명의 치환 패턴과 이어진 지시자를 흘리지 않는다", () => {
  const body = "---\nname: qa-round\ndescription: 번들\n---\n본문\n";
  // $& · $' 는 치환 패턴이라 문자열로 넘기면 머리말에 본문이 끼어든다.
  const dollars = procedureSkillFiles(body, "alpha-qa", "알파 $& $' 절차")[0].content;
  assert.equal(dollars.split("\n")[2], "description: 알파 $& $ 절차");

  // 지시자가 이어지면 한 덩어리만 걷어서는 여전히 목록으로 읽힌다.
  const chained = procedureSkillFiles(body, "alpha-qa", "- [KBF] 펀드 절차")[0].content;
  assert.equal(chained.split("\n")[2], "description: KBF] 펀드 절차");
});

test("병렬 서문도 레인 절차의 경로를 싣는다", () => {
  const values = {
    ...initialValues(procedureCard),
    projectPath: "/repo",
    systemKey: "alpha",
    [PARALLEL_FIELD_KEYS.enabled]: "true",
  };
  const message = buildWorkflowContract(procedureCard.actions[0].workflow, values, {
    paced: true,
    skillsRoot: "/repo-store/skills",
  }).inputSchema.message.defaultValue;
  assert.ok(
    message.includes(`${LANE_SKILL_KEY} 스킬(/repo-store/skills/${LANE_SKILL_KEY}/SKILL.md)`),
    message.slice(0, 200),
  );
});

test("등록이 거절할 것은 아무것도 만들기 전에 막는다", () => {
  const base = { ...initialValues(procedureCard), projectPath: "/repo", systemKey: "alpha" };
  const options = { paced: true, skillsRoot: "/skills", recordTargets: ["markdown"] };
  assert.deepEqual(creationProblems(procedureCard, base, options), []);

  // 지시문이 계약 입력 한도를 넘으면 등록이 죽는다 — 스킬만 만들어 놓고 죽지 않게 한다.
  const long = { ...base, folder: "x".repeat(MAX_CONTRACT_INPUT_CHARS) };
  const tooLong = creationProblems(procedureCard, long, options);
  assert.equal(tooLong.length, 1);
  assert.ok(tooLong[0].includes("한도"), tooLong[0]);

  // 기록 대상 목록을 읽지 못했으면(null) 그 판정은 건너뛴다.
  const recordCard = {
    ...procedureCard,
    steps: [{
      ...procedureCard.steps[0],
      fields: [...procedureCard.steps[0].fields, field("recordTarget", { kind: "recordTargetPicker" })],
    }],
  };
  const withNotion = { ...base, recordTarget: "notion" };
  assert.equal(creationProblems(recordCard, withNotion, options).length, 1);
  // 목록을 못 읽었으면(null) 고를 수 있는 값인지 확인할 길이 없어 그대로 만들지 않는다.
  assert.equal(creationProblems(recordCard, withNotion, { ...options, recordTargets: null }).length, 1);
});

test("등록의 식별자 규칙과 이름·설명 한도를 사전검사가 그대로 본다", () => {
  const base = { ...initialValues(procedureCard), projectPath: "/repo", systemKey: "alpha" };
  const options = { paced: true, skillsRoot: "/skills", recordTargets: ["markdown"] };

  // 등록은 영소문자로 시작하는 2~64자만 받는다.
  const digit = creationProblems(procedureCard, { ...base, systemKey: "3rd-party" }, options);
  assert.equal(digit.length, 1);
  assert.ok(digit[0].includes("영소문자로 시작"), digit[0]);

  // 계약 이름 한도(120자)도 본다 — 팩 한도(200자)보다 좁다.
  const longName = {
    ...procedureCard,
    actions: [{
      ...procedureCard.actions[0],
      workflow: { ...procedureCard.actions[0].workflow, displayName: "{{systemKey}} 회차" },
    }],
  };
  const over = creationProblems(longName, { ...base, systemKey: "a".repeat(MAX_CONTRACT_NAME_CHARS) }, options);
  assert.ok(over.some((problem) => problem.includes("이름")), over.join(" | "));
});

test("기록 대상을 확인할 수 없으면 만들지 않는다", () => {
  const recordCard = {
    ...procedureCard,
    steps: [{
      ...procedureCard.steps[0],
      fields: [...procedureCard.steps[0].fields, field("recordTarget", { kind: "recordTargetPicker" })],
    }],
  };
  const values = {
    ...initialValues(recordCard),
    projectPath: "/repo",
    systemKey: "alpha",
    recordTarget: "notion",
  };
  // 목록을 못 읽은 채로 두면 화면은 비어 보이는데 값은 남아 노션 회차가 등록된다.
  const unknown = creationProblems(recordCard, values, { paced: true, skillsRoot: "/s", recordTargets: null });
  assert.equal(unknown.length, 1);
  assert.ok(unknown[0].includes("읽지 못해"), unknown[0]);
  // 값이 비어 있으면 확인할 것도 없다.
  assert.deepEqual(
    creationProblems(recordCard, { ...values, recordTarget: "" }, { paced: true, skillsRoot: "/s", recordTargets: null }),
    [],
  );
});

test("플러그인 목록을 못 읽어도 플러그인이 필요 없는 대상은 막지 않는다", () => {
  const recordCard = {
    ...procedureCard,
    steps: [{
      ...procedureCard.steps[0],
      fields: [...procedureCard.steps[0].fields, field("recordTarget", { kind: "recordTargetPicker" })],
    }],
  };
  const base = { ...initialValues(recordCard), projectPath: "/repo", systemKey: "alpha" };
  const blind = { paced: true, skillsRoot: "/s", recordTargets: null };

  // 마크다운은 앱이 스스로 쓴다 — 조회가 계속 실패하는 장치에서도 만들 수 있어야 한다.
  assert.deepEqual(creationProblems(recordCard, { ...base, recordTarget: "markdown" }, blind), []);
  assert.equal(creationProblems(recordCard, { ...base, recordTarget: "notion" }, blind).length, 1);
});

test("계약이 거절할 스킬 의존과 빈 작업 경로도 만들기 전에 본다", () => {
  const base = { ...initialValues(procedureCard), projectPath: "/repo", systemKey: "alpha" };
  const options = { paced: true, skillsRoot: "/s", recordTargets: ["markdown"] };

  // 팩이 적은 의존에 절차 키·레인 키가 더해져 한도를 넘는다.
  const many = {
    ...procedureCard,
    actions: [{
      ...procedureCard.actions[0],
      workflow: {
        ...procedureCard.actions[0].workflow,
        requiredSkills: Array.from({ length: MAX_CONTRACT_REQUIRED_SKILLS }, (_, index) => `extra-${index}`),
      },
    }],
  };
  const over = creationProblems(many, base, options);
  assert.ok(over.some((problem) => problem.includes("한도")), over.join(" | "));

  // 페이싱 계약은 봉투가 이 경로로 런타임을 띄운다 — 비면 회차마다 실패한다.
  const blank = creationProblems(procedureCard, { ...base, projectPath: "" }, options);
  assert.ok(blank.some((problem) => problem.includes("작업 경로")), blank.join(" | "));
  // 수동 실행 계약에는 해당하지 않는다.
  assert.ok(
    !creationProblems(procedureCard, { ...base, projectPath: "" }, { ...options, paced: false })
      .some((problem) => problem.includes("작업 경로")),
  );
});

test("여러 줄 값이 계약의 이름·설명에 들어가도 한 줄로 실린다", () => {
  // 등록은 이름·설명에 제어문자를 받지 않는다. textarea 값이 그대로 가면 절차 스킬을
  // 만든 뒤 등록에서 죽는다.
  const multiline = {
    ...procedureCard,
    actions: [{
      ...procedureCard.actions[0],
      workflow: {
        ...procedureCard.actions[0].workflow,
        displayName: "{{goal}} 회차",
        description: "목표 {{goal}}",
      },
    }],
  };
  const values = {
    ...initialValues(multiline),
    projectPath: "/repo",
    systemKey: "alpha",
    goal: "첫 줄\n둘째 줄\t탭",
  };
  const withGoal = {
    ...multiline.actions[0].workflow,
    message: "지시문\n목표: {{goal}}",
  };
  const contract = buildWorkflowContract(withGoal, values, { paced: true });
  assert.equal(contract.displayName, "첫 줄 둘째 줄 탭 회차");
  assert.equal(contract.description, "목표 첫 줄 둘째 줄 탭");
  // 지시문은 여러 줄 그대로 간다 — 계약 입력은 제어문자를 받는다.
  assert.ok(contract.inputSchema.message.defaultValue.includes("목표: 첫 줄\n둘째 줄"));
});

test("숨은 칸을 조건으로 읽어 산출물이 딸려 나오지 않는다", () => {
  // 마크다운을 골랐다가 노션으로 바꾸면 folder 칸은 숨지만 값은 남는다. 그 값을
  // 조건으로 읽으면 노션을 고른 사용자에게 마크다운 폴더를 만들자고 묻게 된다.
  const gated = {
    ...card,
    actions: [
      { ...card.actions[0], when: { field: "folder", equals: "docs/milestones" } },
      card.actions[1],
    ],
  };
  const markdown = { ...initialValues(gated), projectPath: "/repo" };
  assert.deepEqual(activeActions(gated, markdown).map((action) => action.kind), [
    "createDirectory",
    "registerWorkflow",
  ]);

  const notion = { ...markdown, source: "notion" };
  assert.deepEqual(activeActions(gated, notion).map((action) => action.kind), ["registerWorkflow"]);
});

test("레인 서문은 절차가 읽는 값을 모두 이름표로 적는다", () => {
  const values = {
    ...initialValues(procedureCard),
    projectPath: "/repo",
    systemKey: "alpha",
    [PARALLEL_FIELD_KEYS.enabled]: "true",
    [PARALLEL_FIELD_KEYS.runs]: "4",
  };
  const message = buildWorkflowContract(procedureCard.actions[0].workflow, values, {
    paced: true,
    skillsRoot: "/s",
  }).inputSchema.message.defaultValue;
  // 레인 절차가 LANES·POOL·DEV·반영·분할로 찾는 값이 모두 이름표와 함께 있어야 한다.
  for (const label of ["병렬 수", "저장소", "레인 풀", "레인 작업브랜치", "반영 방식", "분할"]) {
    assert.ok(message.includes(`- ${label}: `), `${label} — ${message.slice(0, 300)}`);
  }
});

test("고르는 칸은 목록 밖의 값도 값으로 들고 간다", () => {
  // 화면이 기타 입력을 목록 값과 한 칸에 모으므로, 조립 쪽은 목록 밖 값을 그대로 받는다.
  const otherCard = {
    ...card,
    steps: [{
      ...card.steps[0],
      fields: [
        field("systemKey"),
        field("projectPath", { required: true, kind: "projectPicker" }),
        field("roles", { kind: "multiSelect", allowOther: true, options: [{ value: "관리자", label: { ko: "관리자", en: null } }] }),
      ],
    }],
    actions: [{
      ...card.actions[1],
      workflow: { ...card.actions[1].workflow, id: "{{systemKey}}-qa", message: "역할: {{roles}}" },
    }],
  };
  const values = { ...initialValues(otherCard), systemKey: "alpha", projectPath: "/repo", roles: "관리자,감사담당" };
  const contract = buildWorkflowContract(otherCard.actions[0].workflow, values, { paced: true });
  assert.ok(contract.inputSchema.message.defaultValue.includes("역할: 관리자,감사담당"));
  assert.deepEqual(creationProblems(otherCard, values, { paced: true, skillsRoot: "/s", recordTargets: ["markdown"] }), []);
});

test("붙여넣은 노션 주소에서 데이터베이스 id를 뽑는다", () => {
  const id = "c3420374ee48430f9333d49795c8c8ec";
  // 주소 형태가 여러 가지다. 뷰 id(?v=)에 속지 않아야 한다.
  assert.equal(notionDatabaseId(`https://app.notion.com/p/${id}?pvs=204`), id);
  assert.equal(notionDatabaseId(`https://www.notion.so/team/${id}?v=1234567890abcdef1234567890abcdef`), id);
  assert.equal(notionDatabaseId("c3420374-ee48-430f-9333-d49795c8c8ec"), id);
  // 데이터베이스를 가리키지 않는 값.
  assert.equal(notionDatabaseId("QA Sheets"), null);
  assert.equal(notionDatabaseId("https://www.notion.so/team/QA-Sheets"), null);
});

// 노션 주소는 제목 슬러그 뒤에 id를 붙인다. 하이픈을 떼면 슬러그 꼬리가 id와 한 덩어리로
// 이어지므로, 왼쪽부터 32자를 끊으면 한 칸씩 밀린 값이 나온다 — 32자 16진수라 모양은
// 멀쩡해서 검사도 통과하고, 그 회차가 "데이터베이스를 찾지 못했다"로 끝나서야 드러난다.
test("제목 슬러그 꼬리가 16진수여도 노션 데이터베이스 id는 밀리지 않는다", () => {
  const id = "c3420374ee48430f9333d49795c8c8ec";
  assert.equal(notionDatabaseId(`https://www.notion.so/team/Bug-Fix-Database-${id}`), id);
  assert.equal(notionDatabaseId(`https://www.notion.so/team/Cafe-${id}`), id);
  assert.equal(notionDatabaseId(`https://www.notion.so/team/QA-Sheets-${id}?v=1234567890abcdef1234567890abcdef`), id);
});

test("지라 프로젝트 키는 이슈 키 앞부분 모양만 받는다", () => {
  assert.equal(isJiraProjectKey("QA"), true);
  assert.equal(isJiraProjectKey("PROJ1"), true);
  assert.equal(isJiraProjectKey("Q"), false);
  assert.equal(isJiraProjectKey("qa"), false);
  assert.equal(isJiraProjectKey("QA-123"), false);
});

test("붙여넣기를 잘못하면 아무것도 만들기 전에 막는다", () => {
  const pasteCard = {
    ...card,
    steps: [{
      ...card.steps[0],
      fields: [
        field("systemKey"),
        field("projectPath", { required: true, kind: "projectPicker" }),
        field("notionDatabase", { label: { ko: "노션 데이터베이스", en: null } }),
        field("jiraProject", { label: { ko: "지라 프로젝트 키", en: null } }),
      ],
    }],
    actions: [{ ...card.actions[1], workflow: { ...card.actions[1].workflow, id: "{{systemKey}}-qa" } }],
  };
  const base = { ...initialValues(pasteCard), systemKey: "alpha", projectPath: "/repo" };
  const options = { paced: true, skillsRoot: "/s", recordTargets: ["markdown"] };

  assert.deepEqual(creationProblems(pasteCard, base, options), []);
  const wrong = creationProblems(
    pasteCard,
    { ...base, notionDatabase: "QA 시트", jiraProject: "qa" },
    options,
  );
  assert.equal(wrong.length, 2, wrong.join(" | "));
  assert.ok(wrong[0].includes("노션 데이터베이스 주소가 아닙니다"), wrong[0]);
  assert.ok(wrong[1].includes("대문자로 시작"), wrong[1]);
});

test("같은 워크플로를 도는 회차가 있으면 새로 만들지 않고 그것을 고친다", () => {
  const input = buildScheduleInput("데모 회차", "demo-round", 4, { enabled: false, timezone: "Asia/Seoul", maxRuns: 5 });
  const schedules = [
    { id: "schedule-other", enabled: true, workflow: { workflowId: "다른-회차" } },
    { id: "schedule-demo", enabled: true, workflow: { workflowId: "demo-round" } },
  ];

  const plan = roundSavePlan(schedules, "demo-round", input);
  assert.equal(plan.id, "schedule-demo");
  // 승인 버전과 병렬 수는 이번 화면이 정한 값으로 덮는다. 옛 버전에 고정된 회차가
  // 남는 것이 애초 문제였다.
  assert.equal(plan.input.workflow.approvedVersion, 4);
  assert.deepEqual(plan.input.workflow.pacing, { maxRuns: 5 });
  // 켜짐 여부만은 있던 값을 지킨다 — 마법사를 다시 훑었다고 돌던 회차를 멈추지 않는다.
  assert.equal(plan.input.enabled, true);
});

test("같은 워크플로의 회차가 없으면 새로 만든다", () => {
  const input = buildScheduleInput("데모 회차", "demo-round", 1, { enabled: false, timezone: "Asia/Seoul" });
  const plan = roundSavePlan([{ id: "schedule-other", enabled: true, workflow: { workflowId: "다른-회차" } }], "demo-round", input);
  assert.equal(plan.id, null);
  assert.equal(plan.input, input);
});

test("워크플로를 안 도는 채팅 반복 요청은 회차로 보지 않는다", () => {
  const input = buildScheduleInput("데모 회차", "demo-round", 1, { enabled: false, timezone: "Asia/Seoul" });
  const plan = roundSavePlan([{ id: "schedule-chat", enabled: true, workflow: null }], "demo-round", input);
  assert.equal(plan.id, null);
});

test("a selected procedure skill is an installed workflow dependency", () => {
  const values = { projectPath: "/repo", roundSkill: "team-delivery", qaSkill: "team-qa" };
  const contract = buildWorkflowContract(card.actions[1].workflow, values, { paced: true });

  assert.deepEqual(selectedProcedureSkillKeys(values), ["team-delivery", "team-qa"]);
  assert.ok(contract.requiredSkills.includes("team-delivery"));
  assert.ok(contract.requiredSkills.includes("team-qa"));
});

/**
 * 조각(`#…`)은 주소의 일부가 아니라 그 안의 블록을 가리킨다. 물음표만 떼고 조각을 두면
 * 마지막 16진수 덩어리가 블록 id가 되어, 32자 16진수라 모양은 멀쩡한 **다른 id**가
 * 데이터베이스 id 자리에 실린다 — 회차가 "데이터베이스를 찾지 못했다"로 끝나서야 드러난다.
 */
test("주소에 블록 조각이 붙어 있어도 데이터베이스 id를 뽑는다", () => {
  const id = "c3420374ee48430f9333d49795c8c8ec";
  const block = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(notionDatabaseId(`https://www.notion.so/team/QA-Sheets-${id}#${block}`), id);
  assert.equal(notionDatabaseId(`https://www.notion.so/team/${id}?v=1234567890abcdef1234567890abcdef#${block}`), id);
  // 조각만 16진수인 값은 데이터베이스를 가리키지 않는다.
  assert.equal(notionDatabaseId(`https://www.notion.so/team/QA-Sheets#${block}`), null);
});
