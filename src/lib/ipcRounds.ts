/**
 * 회차 목표·회차 보고 명령 묶음(M10 목표 카드).
 *
 * 목표는 화면이 적고, 설계 산출물(스킬·워크플로·반복 요청)은 AIA 가 등록한 뒤 목표에 붙인다.
 * 보고는 회차가 남기고 화면은 읽기만 한다 — 결정(`resolveRoundDecision`)만 사람이 적는다.
 */
import type {
  RoundGoal,
  RoundGoalInput,
  RoundGoalPatch,
  RoundReport,
  RoundReportQuery,
} from "../types";
import { call } from "./ipcTransport";

export function getRoundGoals(): Promise<RoundGoal[]> {
  return call<RoundGoal[]>("get_round_goals");
}

export function createRoundGoal(request: RoundGoalInput): Promise<RoundGoal> {
  return call<RoundGoal>("create_round_goal", { request });
}

export function updateRoundGoal(id: string, patch: RoundGoalPatch): Promise<RoundGoal> {
  return call<RoundGoal>("update_round_goal", { request: { id, patch } });
}

export function deleteRoundGoal(id: string): Promise<null> {
  return call<null>("delete_round_goal", { request: { id } });
}

export function listRoundReports(request: RoundReportQuery = {}): Promise<RoundReport[]> {
  return call<RoundReport[]>("list_round_reports", { request });
}

export function getRoundReport(id: string): Promise<RoundReport> {
  return call<RoundReport>("get_round_report", { request: { id } });
}

export function resolveRoundDecision(id: string, index: number, answer: string): Promise<RoundReport> {
  return call<RoundReport>("resolve_round_decision", { request: { id, index, answer } });
}

export function deleteRoundReport(id: string): Promise<null> {
  return call<null>("delete_round_report", { request: { id } });
}
