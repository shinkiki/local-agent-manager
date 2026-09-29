/**
 * 화면이 부르는 삭제 명령이 공통으로 싣는 두 값 — 누가 지웠는지(`deletedBy`)와 사용자가
 * 확인창을 지났는지(`confirm`) — 를 한곳에서 정한다.
 *
 * 스킬 세 자리와 지침 세 자리가 같은 짝을 각자 적고 있었다. 값이 문자열 리터럴이라
 * 한 자리만 다르게 적어도 빌드는 통과하고, 휴지통 목록에 남는 행위자 이름이나 확인
 * 여부가 그 명령에서만 달라진다. 실제로 어느 자리가 맞는 값인지는 나머지 다섯 자리를
 * 찾아 비교해야 알 수 있었다.
 *
 * 이 함수는 요청 봉투까지 만들어 돌려준다. `call`의 인자 모양(`{ request }`)이 봉투를
 * 여는 쪽과 채우는 쪽으로 갈라지면, 값은 모았어도 봉투를 빠뜨린 자리가 다시 생긴다.
 *
 * **무엇을 가리키는 값인지는 봉투를 지나도 남는다.** 받는 자리가
 * `Record<string, unknown>`이면 어떤 객체든 통과하므로, 도메인 모듈이 한 벌로 모아 둔
 * ref(`deployedInstructionRef` 등)를 거치지 않고 손으로 조립한 객체를 넘겨도 타입은
 * 지나고 칸을 빠뜨린 사실은 백엔드의 인자 부족으로만 드러난다 — `ipcLinkedFile`이
 * 링크 봉투를 도메인 모듈에 모으며 피한 것과 같은 구멍이다. 그래서 ref 모양을 그대로
 * 나르고, 덧붙는 두 칸만 여기서 더한다.
 */

/** 앱 화면에서 사람이 직접 부른 삭제. 배경 정리·테스트가 부르는 값과 구분된다. */
const USER_DELETE_ACTOR = "user";

/** 행위자 이름까지 실린 봉투 속 요청. 확인 여부는 부르는 쪽 함수가 덧붙인다. */
type UserActorRequest<Ref> = Ref & { deletedBy: typeof USER_DELETE_ACTOR };

/**
 * 삭제가 아니지만 같은 행위자 이름을 싣는 요청. 설치본 채택은 남는 파일을 정리하면서
 * 휴지통 행을 남기므로 `deletedBy`를 함께 보내되, 별도 확인창이 없어 `confirm`은 없다.
 */
export function userActorRequest<Ref extends object>(
  ref: Ref,
): { request: UserActorRequest<Ref> } {
  return { request: { ...ref, deletedBy: USER_DELETE_ACTOR } };
}

/**
 * 사용자가 확인창을 지나 부른 삭제 요청. `ref`는 무엇을 지울지 가리키는 값이다.
 *
 * 행위자 이름을 다시 적지 않고 `userActorRequest`에서 파생시킨다. 두 함수가 같은 봉투를
 * 각자 조립하면 행위자 값을 한쪽만 고치는 자리가 이 파일 안에 다시 생긴다.
 */
export function userConfirmedDeleteRequest<Ref extends object>(
  ref: Ref,
): { request: UserActorRequest<Ref> & { confirm: true } } {
  const { request } = userActorRequest(ref);
  return { request: { ...request, confirm: true } };
}
