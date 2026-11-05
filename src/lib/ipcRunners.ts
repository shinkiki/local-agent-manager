/**
 * C21 분산처리 실행기 명령 묶음. 갈라 둔 이유는 `ipcDbConnections.ts` 머리말에 적는다.
 *
 * 변경 명령은 모두 한 줄 단위다 — 실행기 켜짐만 바꾸는 명령, 프로젝트 폴더 한 줄을 더하고
 * 고치고 빼는 명령. 목록을 통째로 보내면 두 화면이 서로 다른 줄을 고칠 때 한쪽 변경이
 * 사라진다. 모든 변경은 새 목록을 돌려준다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type {
  RunnerCheckReceipt,
  RunnerProjectInput,
  RunnersSnapshot,
  SaveRunnerRequest,
} from "../types";
import { call } from "./ipcTransport";

/** 실행기 접속 확인은 SSH 탭의 확인과 같은 상한(연결 10초·전체 20초)을 쓴다. */
const RUNNER_CHECK_TIMEOUT_MS = 30_000;

/** 실행기·보낼 프로젝트 폴더·고를 수 있는 SSH 서버. 키 내용은 어느 필드에도 없다. */
export function listRunners(): Promise<RunnersSnapshot> {
  return call<RunnersSnapshot>("list_runners");
}

/** 실행기 추가·수정. 가리키는 SSH 서버가 있어야 하고 한 서버는 한 번만 실행기가 된다. */
export function saveRunner(runner: SaveRunnerRequest): Promise<RunnersSnapshot> {
  return call<RunnersSnapshot>("save_runner", { runner });
}

/** 실행기 켜짐만 바꾼다. 가리키던 서버가 지워졌어도 된다. */
export function setRunnerEnabled(id: string, enabled: boolean): Promise<RunnersSnapshot> {
  return call<RunnersSnapshot>("set_runner_enabled", { id, enabled });
}

/** 실행기 하나를 지운다. 가리키던 SSH 서버와 키는 그대로다. */
export function deleteRunner(id: string): Promise<RunnersSnapshot> {
  return call<RunnersSnapshot>("delete_runner", { id });
}

/** 프로젝트 폴더 한 줄을 더한다. 폴더는 이 기계에 있는 절대 경로여야 한다. */
export function addRunnerProject(project: RunnerProjectInput): Promise<RunnersSnapshot> {
  return call<RunnersSnapshot>("add_runner_project", { project });
}

/** 프로젝트 폴더 한 줄을 고친다. `project.id`가 고칠 줄이다. */
export function updateRunnerProject(project: RunnerProjectInput): Promise<RunnersSnapshot> {
  return call<RunnersSnapshot>("update_runner_project", { project });
}

/** 프로젝트 폴더 한 줄을 목록에서 뺀다. 폴더 자체는 그대로다. */
export function deleteRunnerProject(id: string): Promise<RunnersSnapshot> {
  return call<RunnersSnapshot>("delete_runner_project", { id });
}

/** 실행기가 가리키는 서버로 한 번 붙어 보는 확인. 원격에서는 아무것도 바꾸지 않는다. */
export function checkRunner(id: string): Promise<RunnerCheckReceipt> {
  return call<RunnerCheckReceipt>("check_runner", { id }, { timeoutMs: RUNNER_CHECK_TIMEOUT_MS });
}
