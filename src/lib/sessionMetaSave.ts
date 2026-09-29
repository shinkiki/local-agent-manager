import type { ProviderId, SessionMeta, SessionMetaPatch } from "../types";
import { patchSessionMeta } from "./ipc";
import { errorText } from "./errorText";
import { optimisticSessionMeta } from "./sessionMeta";

/**
 * 세션 메타 한 벌을 화면에 먼저 올리고 저장한다. 목록 행·드로어·채팅 목록이 같은 네
 * 걸음(오류 비우기 → 낙관 값 적용 → 저장 결과 적용 → 실패하면 이전 값으로 되돌리고 사유
 * 남기기)을 따로 적고 있었는데, 한쪽에서 되돌리기를 빠뜨리거나 순서가 어긋나면 서버가
 * 거절한 값이 화면에만 남는다. 바뀐 값을 어디에 반영할지(`apply`)와 사유를 어디에
 * 남길지(`onError`)만 부르는 쪽이 정하고, 걸음의 순서는 여기 한 벌만 둔다.
 *
 * 낙관 갱신 규칙 자체는 `sessionMeta.ts`에 있다. **그 파일과 합치지 않는다** — 이 봉투는
 * `./ipc`를 불러오므로, 같은 파일에 두면 `node --test`가 `sessionMeta.test.mjs`를 열 때
 * 확장자 없는 `./ipc` 사슬을 풀지 못해 파일 전체가 실패한다(2026-09-18 `554e611d`가 실제로
 * 그렇게 개발선의 프런트 테스트를 깨뜨렸다).
 */
export async function saveSessionMetaPatch(
  source: ProviderId,
  id: string,
  previous: SessionMeta,
  patch: SessionMetaPatch,
  apply: (meta: SessionMeta) => void,
  onError: (message: string | null) => void,
): Promise<void> {
  onError(null);
  apply(optimisticSessionMeta(previous, patch));
  try {
    apply(await patchSessionMeta(source, id, patch));
  } catch (cause) {
    apply(previous);
    onError(errorText(cause));
  }
}
