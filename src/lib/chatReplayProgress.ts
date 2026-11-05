/** 응답이 이어지는 중인 상태. 이 상태의 턴은 아직 답이 다 오지 않았다. */
const RESPONDING_CHAT_STATES = new Set(["running", "waitingApproval"]);

/**
 * 붙은 뒤 되풀이되는 지난 상태(리플레이)가 열기 직전의 목록 값까지 왔는지. 리플레이의 상태는 그때의
 * 턴 수를 싣고 오르기만 한다. 턴 수가 목표를 넘었으면 그 사이 새 턴이 시작된 것이고, 같으면 상태가
 * 목표와 같거나(응답 중인 채팅이면 그 턴이 시작된 자리) 응답이 끝난 상태여야 마지막 턴의 답까지 온
 * 것이다 — 마지막 턴이 시작될 때 이미 턴 수는 목표에 닿지만 상태는 '응답 중'이다.
 */
export function replayReached(progress: { turnCount: number; state: string } | null, target: { turnCount: number; state: string }): boolean {
  if (!progress) return false;
  if (progress.turnCount > target.turnCount) return true;
  // 응답 중이던 채팅이면 같은 턴 수의 상태는 모두 그 턴의 시작부 뒤에 오므로 턴 수만 맞으면 된다
  // ('응답 중'과 '승인 대기'를 오가도, 턴 시작 상태가 버퍼에서 밀려나 없어도).
  return progress.turnCount === target.turnCount
    && (RESPONDING_CHAT_STATES.has(target.state) || !RESPONDING_CHAT_STATES.has(progress.state));
}
