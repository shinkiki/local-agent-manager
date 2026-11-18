import { runtimeText } from "./i18nRuntime.ts";

/**
 * 대화 메시지 한 칸의 머리글(역할 이름표).
 *
 * `ChatConversation` 안에 한국어 고정 문자열로 있었다. 같은 파일의 다른 라벨은 모두
 * `runtimeText(ko, en)`인데 이 넷만 영어 짝이 없어, 영어 화면에서는 DOM 치환기가 정적 사전의
 * 메뉴 이름 "Agents"(복수)로 바꿔 에이전트 응답 머리글이 "Agents"로 보였다. 세션 기록 화면의
 * 역할 이름(`SessionTranscript`의 `roleName`)과 같은 영어 짝을 명시한다 — 두 자리의 짝이
 * 갈라지면 같은 대화가 화면마다 다른 이름으로 불린다.
 *
 * 영어 아닌 제3 언어는 한국어 원문을 열쇠로 번역 대응표를 찾으므로, 대응표에 "에이전트"가
 * 메뉴 이름으로만 실려 있으면 그 언어에서는 여전히 메뉴 이름이 보인다. 그것은 대응표의
 * 몫이고, 여기서 고친 것은 영어 짝이다.
 *
 * 앱이 직접 적은 알림(`system`)은 에이전트가 한 말이 아니다. 답 없이 끝난 턴을 알리는 자리가
 * 그것인데, 같은 라벨을 달면 모델이 그렇게 말한 것으로 읽힌다.
 *
 * 부를 때마다 짓는다 — 모듈 적재 때 굳히면 언어를 바꾼 뒤에도 처음 언어로 남는다.
 */
export function chatMessageRoleLabel(role: string, kind: string): string {
  if (kind === "reasoning") return runtimeText("진행 상황", "Progress");
  if (role === "system") return runtimeText("시스템", "System");
  if (role === "user") return runtimeText("사용자", "User");
  return runtimeText("에이전트", "Agent");
}
