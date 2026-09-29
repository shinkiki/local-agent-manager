/**
 * 기본도구 카탈로그 조회와, 그 카탈로그가 읽는 값을 바꾼 호출에 씌우는 알림 한 벌.
 *
 * 도구별 명령(DB 연결·SSH 키·외부 플러그인·Cypress)은 각자의 `ipc*` 모듈에 있고, 여기
 * 남는 것은 **그 도구들이 공유하는 것**뿐이다 — 앱이 에이전트에 붙여 주는 도구 전체를
 * 한 번에 읽는 카탈로그와, 사용 스위치를 바꾼 뒤 그 카탈로그를 다시 읽게 하는 신호.
 * 도구가 늘어도 이 파일은 그대로다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다. 바꾼 뒤 알리는 `notifyBuiltinTools`는 신호 쪽(`builtinToolsSignal`)에 있다 —
 * 전송에 기대지 않는 함수라 그래야 시험이 전송 계층 없이 설 수 있다.
 */
import type { AgentBuiltinToolsCatalog } from "../types";
import { call } from "./ipcTransport";

/**
 * 앱이 에이전트에 붙여 주는 기본도구와 에이전트별 접근 경로. 같은 도구도 AIA는 프록시로,
 * 일반 채팅은 직접 MCP나 시스템 스킬로 쓰므로 화면이 그 차이를 그대로 보여 준다.
 */
export function getAgentBuiltinTools(): Promise<AgentBuiltinToolsCatalog> {
  return call<AgentBuiltinToolsCatalog>("get_agent_builtin_tools");
}
