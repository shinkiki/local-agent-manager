import type { SshEndpointView } from "../types";

export const DEFAULT_FILE_NAME = "id_agent_manager";
export const DEFAULT_COMMENT = "agent-manager";
/** 백엔드가 키 종류 목록을 주지 않을 때(옛 백엔드) 쓰는 기본 종류. */
export const DEFAULT_KEY_TYPE = "ed25519";
export const MAX_NOTE_CHARS = 300;
/** 설명(주석)의 한도. 생성 버튼의 비활성 조건과 입력 한도가 같은 값을 봐야 한다. */
export const MAX_COMMENT_CHARS = 120;

/**
 * SSH 키 카드는 한 번에 한 동작만 돌리고, 지금 도는 동작을 `"갈래:대상"` 문자열 하나로 들고
 * 다닌다. 그 문자열을 만드는 쪽(카드 본문의 `run` 호출)과 읽는 쪽(행·액션 버튼의 스피너
 * 조건)이 서로 떨어져 있어, 양쪽이 같은 리터럴을 각자 손으로 적고 있었다 — 한쪽에서 갈래
 * 이름을 고쳐도 다른 쪽은 조용히 어긋난 채 남는다. 만드는 자리와 읽는 자리를 아래
 * 도우미로 모아, 갈래 이름을 타입이 잡게 한다. 연결 서버 갈래는 서버 구역이 따로 정한다.
 *
 * 판정은 화면 없이 시험할 수 있도록 컴포넌트 밖에 둔다. 카드의 `busy` 토큰은 서버 갈래까지
 * 합친 합집합 타입이라, 여기서는 문자열로 받는다.
 */
export type SshKeyTaskKind = "reveal" | "note" | "passphrase" | "delete";
export type SshKeyTask = `${SshKeyTaskKind}:${string}`;

/** 키 한 건을 대상으로 하는 동작의 표시를 만든다. */
export function keyTask(kind: SshKeyTaskKind, fingerprint: string): SshKeyTask {
  return `${kind}:${fingerprint}`;
}

/** 지금 도는 동작이 이 키의 그 갈래인지. 버튼 하나의 스피너 조건이다. */
export function isKeyTask(busy: string | null, kind: SshKeyTaskKind, fingerprint: string): boolean {
  return busy === keyTask(kind, fingerprint);
}

/** 갈래를 가리지 않고 이 키를 대상으로 무언가 돌고 있는지. 행 전체를 잠그는 조건이다. */
export function isRowBusy(busy: string | null, fingerprint: string): boolean {
  return busy !== null && busy.endsWith(`:${fingerprint}`);
}

/** 이 키 지문을 가리키는 연결 서버만 고른다. 삭제 확인과 행의 서버 목록이 같은 답을 본다. */
export function serversUsingKey(servers: SshEndpointView[] | null | undefined, fingerprint: string): SshEndpointView[] {
  return (servers ?? []).filter((server) => server.fingerprint === fingerprint);
}

export interface SshKeyCreateInput {
  fileName: string;
  comment: string;
  passphraseMismatch: boolean;
  busy: boolean;
}

/** 생성 버튼을 켤 조건. 파일 이름이 비었거나 설명이 한도를 넘거나 암호 확인이 다르면 끈다. */
export function canCreateSshKey({ fileName, comment, passphraseMismatch, busy }: SshKeyCreateInput): boolean {
  return !busy && Boolean(fileName.trim()) && comment.length <= MAX_COMMENT_CHARS && !passphraseMismatch;
}

/** 메모 저장 버튼을 켤 조건. 다듬은 초안이 지금 메모와 같으면 저장할 것이 없다. */
export function canSaveSshKeyNote(draft: string, currentNote: string | null | undefined, rowBusy: boolean): boolean {
  return !rowBusy && draft.trim() !== (currentNote ?? "");
}
