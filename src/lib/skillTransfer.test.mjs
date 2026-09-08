import assert from "node:assert/strict";
import test from "node:test";
import {
  instructionBulkMigrationPrompt,
  isUserSkillCandidate,
  repositoryTransferPrompt,
  skillBulkMigrationPrompt,
} from "./skillTransfer.ts";

test("only personal and project skills are user skill candidates", () => {
  assert.equal(isUserSkillCandidate("personal"), true);
  assert.equal(isUserSkillCandidate("project"), true);
  assert.equal(isUserSkillCandidate("plugin"), false);
  assert.equal(isUserSkillCandidate("system"), false);
  assert.equal(isUserSkillCandidate("builtin"), false);
});

test("backup prompt targets the whole repository and asks before writing", () => {
  const prompt = repositoryTransferPrompt("backup");
  assert.match(prompt, /get_resource_repository/);
  assert.match(prompt, /rootPath/);
  assert.match(prompt, /skillsPath, instructionsPath/);
  assert.match(prompt, /\.agent-manager OS 메타데이터/);
  assert.match(prompt, /지침 원본 하나/);
  assert.match(prompt, /확인 전에는 파일을 생성하거나 변경하지 마세요/);
  assert.match(prompt, /manifest/);
  assert.match(prompt, /비밀값/);
  // 에이전트 스킬 루트와 채팅·계정 데이터는 백업 대상이 아니다.
  assert.match(prompt, /~\/\.claude\/skills, ~\/\.codex\/skills, ~\/\.gemini\/config\/skills/);
  assert.match(prompt, /채팅·계정 데이터/);
});

test("restore prompt requires conflict approval and reminds about redeployment", () => {
  const prompt = repositoryTransferPrompt("restore");
  assert.match(prompt, /skillsPath·instructionsPath 아래로 복원/);
  assert.match(prompt, /기존 보관 원본은 명시적 승인 없이 덮어쓰지 말고/);
  assert.match(prompt, /manifest와 파일 해시를 검증/);
  assert.match(prompt, /사용 여부를/);
  assert.match(prompt, /게시 위치를 다시 켜야/);
});

test("skill bulk migration prompt enumerates via typed APIs and forbids running scripts", () => {
  const prompt = skillBulkMigrationPrompt(4);
  assert.match(prompt, /get_skill_library/);
  assert.match(prompt, /migrationRequired/);
  assert.match(prompt, /스킬은 4개/);
  assert.match(prompt, /get_skill_migration_plan/);
  assert.match(prompt, /save_skill_platform_variant/);
  assert.match(prompt, /SKILL\.md는 제거할 수 없습니다/);
  assert.match(prompt, /자동 실행하지 말고/);
});

test("instruction bulk migration prompt mirrors the skill flow", () => {
  const prompt = instructionBulkMigrationPrompt(2);
  assert.match(prompt, /get_project_instruction_library/);
  assert.match(prompt, /currentPlatformSupported/);
  assert.match(prompt, /지침은 2개/);
  assert.match(prompt, /get_project_instruction_migration_plan/);
  assert.match(prompt, /save_project_instruction_platform_variant/);
  assert.match(prompt, /자동 실행하지 말고/);
});
