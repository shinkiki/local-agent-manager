/**
 * CLI 연결 드로어 머리글이 말할 상태. CLI가 없을 때 "채팅 기록은 있지만"이라고 말하려면
 * 기록이 실제로 탐지됐어야 한다 — 처음 설치하는 사용자에게 없는 기록을 있다고 말하던 결함.
 */
export type CliConnectHeadline = "found" | "missingWithHistory" | "missing";

export function cliConnectHeadline(cliDetected: boolean, historyDetected: boolean): CliConnectHeadline {
  if (cliDetected) return "found";
  return historyDetected ? "missingWithHistory" : "missing";
}
