/**
 * Claude Code 플러그인·일반 스킬 설정과 브랜치별 분기 규칙 관련 IPC 명령 묶음.
 *
 * `ipc.ts`에 직접 남아 있던 Claude 설정 상태 조회·수정 및 브랜치 규칙 명령 여섯 자리를
 * 한 모듈로 모은다. 플러그인 설정 뷰(`ClaudePluginsCard`)와 브랜치 규칙 관리가 한 덩어리로
 * 쓰는 영역이며, 다른 `ipc*` 모듈과 같은 방식으로 갈라 `ipc.ts`의 책임을 줄인다.
 */
import type {
  ClaudePluginBranchRulesSnapshot,
  ClaudeSettingsSnapshot,
  RemoveClaudePluginBranchRuleRequest,
  SetClaudePluginBranchRuleRequest,
  SetClaudePluginEnabledRequest,
  SetClaudeSkillOverrideRequest,
} from "../types";
import { call } from "./ipcTransport";

/** Claude Code 플러그인·일반 스킬의 전역/프로젝트 설정과 유효값. */
export function getClaudeSettingsStates(projectPath: string | null = null): Promise<ClaudeSettingsSnapshot> {
  return call<ClaudeSettingsSnapshot>("get_claude_settings_states", { projectPath });
}

export function setClaudePluginEnabled(request: SetClaudePluginEnabledRequest): Promise<ClaudeSettingsSnapshot> {
  return call<ClaudeSettingsSnapshot>("set_claude_plugin_enabled", { request });
}

export function setClaudeSkillOverride(request: SetClaudeSkillOverrideRequest): Promise<ClaudeSettingsSnapshot> {
  return call<ClaudeSettingsSnapshot>("set_claude_skill_override", { request });
}

/**
 * 브랜치별 플러그인 사용 규칙. 설정 파일에는 브랜치 조건을 적을 자리가 없어 앱이 규칙을
 * 들고 있다가 Claude 실행을 띄울 때 그 브랜치의 값으로 바꿔 넘긴다.
 */
export function getClaudePluginBranchRules(): Promise<ClaudePluginBranchRulesSnapshot> {
  return call<ClaudePluginBranchRulesSnapshot>("get_claude_plugin_branch_rules");
}

export function setClaudePluginBranchRule(request: SetClaudePluginBranchRuleRequest): Promise<ClaudePluginBranchRulesSnapshot> {
  return call<ClaudePluginBranchRulesSnapshot>("set_claude_plugin_branch_rule", { request });
}

export function removeClaudePluginBranchRule(request: RemoveClaudePluginBranchRuleRequest): Promise<ClaudePluginBranchRulesSnapshot> {
  return call<ClaudePluginBranchRulesSnapshot>("remove_claude_plugin_branch_rule", { request });
}
