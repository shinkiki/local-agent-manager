import type { SessionFailureKind, SessionLastFailure } from "../types";
import { formatDate } from "./format.ts";

/**
 * 실패 종류별 문장 앞머리. 폴백이 붙은 삼항으로 적으면 종류가 늘어도 컴파일이 통과해 새
 * 종류가 조용히 `error` 문구를 빌려 쓴다. 표로 두면 빠진 키가 컴파일 오류로 선다.
 */
const FAILURE_HEADS: Record<SessionFailureKind, string> = {
  usageLimit: "마지막 요청이 사용량 한도에 걸려 실패했습니다",
  error: "마지막 요청이 오류로 끝났습니다",
};

/**
 * 세션 목록 실패 태그의 설명. 한도 초과와 그 밖의 오류를 문장 앞머리로 가르고, 백엔드가
 * 잘라 보낸 실패 문구와 시각을 덧붙인다.
 */
export function sessionFailureTitle(failure: SessionLastFailure): string {
  const head = FAILURE_HEADS[failure.kind];
  const when = failure.occurredAt ? ` (${formatDate(failure.occurredAt)})` : "";
  const message = failure.message.trim();
  return message ? `${head}${when}\n${message}` : `${head}${when}`;
}
