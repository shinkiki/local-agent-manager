/**
 * Cypress 자동화 작업공간 기본도구 명령 묶음. 갈라 둔 이유는 `ipcDbConnections.ts`
 * 머리말에 적는다.
 *
 * 등록·설치·실행·민감 파일 쓰기는 호스트 전용이라 원격 접속에서는 403이 난다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type {
  CypressExecutionType,
  CypressInstallReceipt,
  CypressRegistry,
  CypressRunStatus,
  CypressWorkspaceFile,
  CypressWorkspaceFileContent,
  CypressWorkspaceFileList,
} from "../types";
import { notifyBuiltinTools } from "./builtinToolsSignal";
import { call } from "./ipcTransport";

/** Cypress 모듈 설치는 npm 다운로드·바이너리 설치까지 최대 15분쯤 걸릴 수 있다. */
const CYPRESS_INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

export function getCypressRegistry(): Promise<CypressRegistry> {
  return call<CypressRegistry>("get_cypress_registry");
}

export function setCypressEnabled(enabled: boolean): Promise<CypressRegistry> {
  // 같은 패널의 기본도구 접근 상세가 이 값을 읽는다. 바꾼 자리에서 알려야 한 화면의 두
  // 표시가 어긋나지 않는다(QA #95).
  return notifyBuiltinTools(call<CypressRegistry>("set_cypress_enabled", { enabled }));
}

export function addCypressWorkspace(name: string, path: string, moduleDir: string | null = null): Promise<CypressRegistry> {
  return call<CypressRegistry>("add_cypress_workspace", { name, path, moduleDir });
}

/** 작업공간에 저장하는 실행 옵션. 사람이 눌러 돌리든 에이전트가 돌리든 같은 값이 쓰인다. */
export function setCypressWorkspaceOptions(id: string, recordVideo: boolean, headed: boolean, executionType: CypressExecutionType): Promise<CypressRegistry> {
  return call<CypressRegistry>("set_cypress_workspace_options", { id, recordVideo, headed, executionType });
}

export function removeCypressWorkspace(id: string): Promise<CypressRegistry> {
  return call<CypressRegistry>("remove_cypress_workspace", { id });
}

export function installCypressModule(id: string, version: string | null = null): Promise<CypressInstallReceipt> {
  return call<CypressInstallReceipt>("install_cypress_module", { id, version }, { timeoutMs: CYPRESS_INSTALL_TIMEOUT_MS });
}

export function listCypressWorkspaceFiles(id: string): Promise<CypressWorkspaceFileList> {
  return call<CypressWorkspaceFileList>("list_cypress_workspace_files", { id });
}

/** 민감 파일(cypress.env.json)은 여기서 항상 `masked: true`(값이 "•••"인 JSON)로 온다. 원문은 `readCypressEnvFile`. */
export function readCypressWorkspaceFile(id: string, path: string): Promise<CypressWorkspaceFileContent> {
  return call<CypressWorkspaceFileContent>("read_cypress_workspace_file", { id, path });
}

/** 민감 파일 경로는 거절된다. 그 파일은 `writeCypressEnvFile`로만 쓴다. */
export function writeCypressWorkspaceFile(id: string, path: string, content: string): Promise<CypressWorkspaceFile> {
  return call<CypressWorkspaceFile>("write_cypress_workspace_file", { id, path, content });
}

/** cypress.env.json 원문(호스트 전용). 원격 접속은 403이 나므로 마스킹본을 대신 보인다. */
export function readCypressEnvFile(id: string): Promise<CypressWorkspaceFileContent> {
  return call<CypressWorkspaceFileContent>("read_cypress_env_file", { id });
}

/** cypress.env.json 저장(호스트 전용). */
export function writeCypressEnvFile(id: string, content: string): Promise<CypressWorkspaceFile> {
  return call<CypressWorkspaceFile>("write_cypress_env_file", { id, content });
}

export function deleteCypressWorkspaceFile(id: string, path: string): Promise<null> {
  return call<null>("delete_cypress_workspace_file", { id, path });
}

export function runCypressSpec(id: string, spec: string | null = null, env: Record<string, string> | null = null): Promise<CypressRunStatus> {
  return call<CypressRunStatus>("run_cypress_spec", { id, spec, env });
}

/**
 * Cypress 런처를 띄운다(호스트 전용). 스펙 고르기와 단계별 진행은 런처 안에서 사람이 하므로
 * 스펙은 넘기지 않는다. 창을 닫으면 실행이 `closed`로 끝난다.
 */
export function openCypressRunner(id: string, env: Record<string, string> | null = null): Promise<CypressRunStatus> {
  return call<CypressRunStatus>("open_cypress_runner", { id, env });
}

/** 도는 실행을 끊는다. 런처는 창을 닫는 것과 같은 끝(`closed`)이 된다. */
export function stopCypressRun(jobId: string): Promise<CypressRunStatus> {
  return call<CypressRunStatus>("stop_cypress_run", { jobId });
}

export function getCypressRunStatus(jobId: string): Promise<CypressRunStatus> {
  return call<CypressRunStatus>("get_cypress_run_status", { jobId });
}

/** 최근 실행부터 돌려준다. */
export function listCypressRuns(): Promise<CypressRunStatus[]> {
  return call<CypressRunStatus[]>("list_cypress_runs");
}
