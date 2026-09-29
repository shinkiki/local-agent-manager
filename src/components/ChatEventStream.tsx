/**
 * 실시간 채팅 이벤트를 화면이 그릴 턴·엔트리 상태로 접는 자리.
 *
 * 무엇을 어떻게 그릴지(`ChatConversation`)와 무엇이 들어왔을 때 상태가 어떻게 바뀌는지는
 * 서로 기대는 것이 없는데 한 파일에 섞여 있었다. 접기 규칙만 따로 두면 대화 화면·작업
 * 로그·AIA 팝업이 공유하는 상태 모델을 그리기 코드와 떨어뜨려 읽고 고칠 수 있다.
 */
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  ChatEvent,
  ChatInputFile,
  ChatSessionInfo,
  QueuedChatMessage,
} from "../types";
import {
  updateChatTurnEntries,
  upsertChatTurnState,
  type ChatTimelineTurn,
} from "../lib/chatTimeline";
import type { ChatApprovalPrompt } from "./Shared";

export type ChatEntry =
  | { type: "message"; id: string; role: string; kind: string; text: string; attachments: ChatInputFile[] }
  | { type: "tool"; id: string; name: string; status: string; detail: string; output: string }
  | ({ type: "approval" } & ChatApprovalPrompt)
  | { type: "error"; id: string; text: string };

export type ChatTurn = ChatTimelineTurn<ChatEntry>;
export type ChatActivityEntry = Extract<ChatEntry, { type: "tool" }> | Extract<ChatEntry, { type: "message" }>;

export interface ChatEventTargets {
  activeTurnRef: MutableRefObject<string | null>;
  setTurns: Dispatch<SetStateAction<ChatTurn[]>>;
  setQueue: Dispatch<SetStateAction<QueuedChatMessage[]>>;
  onState: (session: ChatSessionInfo) => void;
  onError: (message: string | null) => void;
  /** 일반 채팅은 새 스트림이 시작되면 지난 요청의 오류를 지우지만 AIA는 연결 수명 동안 유지한다. */
  clearStaleError?: boolean;
}

export function applyChatEvent(event: ChatEvent, targets: ChatEventTargets) {
  const { activeTurnRef, setTurns, setQueue, onState, onError, clearStaleError = true } = targets;
  if (event.type === "replayReset") {
    activeTurnRef.current = null;
    setTurns([]);
    if (clearStaleError) onError(null);
    return;
  }
  if (event.type === "state") {
    onState(event.session);
    return;
  }
  if (event.type === "queue") {
    setQueue(event.items);
    return;
  }
  if (event.type === "turn") {
    if (event.status === "started") {
      activeTurnRef.current = event.id;
      // 새 요청이 시작되면 세션 한도 초과 등 이전 요청의 오류 배너는 더 이상 현재 상태가 아니다.
      if (clearStaleError) onError(null);
    }
    setTurns((current) => upsertChatTurnState(current, event));
    if (event.status !== "started" && activeTurnRef.current === event.id) activeTurnRef.current = null;
    return;
  }

  // 턴 밖에서 온 이벤트도 버리지 않고 "system" 턴에 모은다.
  const turnId = activeTurnRef.current ?? "system";
  const editEntries = (edit: (entries: ChatEntry[]) => ChatEntry[]) => {
    setTurns((current) => updateChatTurnEntries(current, turnId, edit));
  };
  if (event.type === "messageDelta") {
    editEntries((entries) => upsertChatMessage(entries, event));
    return;
  }
  if (event.type === "userInput") {
    editEntries((entries) => appendUserInput(entries, event));
    return;
  }
  if (event.type === "tool") {
    editEntries((entries) => upsertChatTool(entries, event));
    return;
  }
  if (event.type === "approval") {
    editEntries((entries) => upsertChatApproval(entries, event));
    return;
  }
  if (event.type === "approvalResolved") {
    setTurns((current) => current.map((turn) => resolveChatApprovalInTurn(turn, event)));
    return;
  }
  if (event.type === "takenOver") {
    onError("다른 화면에서 이 채팅에 연결되어 이 화면의 실시간 연결이 해제되었습니다.");
    return;
  }
  if (event.type === "error") {
    onError(event.message);
    editEntries((entries) => appendChatError(entries, event.message));
  }
}

/**
 * 같은 것을 가리키는 엔트리가 이미 있으면 그 자리를 갱신하고, 없으면 끝에 새로 세운다.
 *
 * 메시지 델타와 도구 진행 보고는 둘 다 한 엔트리를 여러 번에 나눠 채우는 이벤트라 찾기·
 * 추가·자리 교체를 똑같이 지난다. 두 벌로 적어 두면 한쪽만 "없으면 추가" 조건을 고치는
 * 식으로 조용히 어긋난다.
 */
function upsertChatEntry<Entry extends ChatEntry>(
  current: ChatEntry[],
  match: (entry: ChatEntry) => entry is Entry,
  create: () => ChatEntry,
  update: (entry: Entry) => ChatEntry,
): ChatEntry[] {
  const index = current.findIndex(match);
  if (index < 0) return [...current, create()];
  return current.map((entry, entryIndex) => entryIndex === index && match(entry) ? update(entry) : entry);
}

function upsertChatMessage(current: ChatEntry[], event: Extract<ChatEvent, { type: "messageDelta" }>): ChatEntry[] {
  return upsertChatEntry(
    current,
    (entry): entry is Extract<ChatEntry, { type: "message" }> => (
      entry.type === "message" && entry.id === event.id && entry.kind === event.kind
    ),
    () => ({ type: "message", id: event.id, role: event.role, kind: event.kind, text: event.delta, attachments: [] }),
    (entry) => ({ ...entry, text: entry.text + event.delta }),
  );
}

function upsertChatTool(current: ChatEntry[], event: Extract<ChatEvent, { type: "tool" }>): ChatEntry[] {
  return upsertChatEntry(
    current,
    (entry): entry is Extract<ChatEntry, { type: "tool" }> => entry.type === "tool" && entry.id === event.id,
    () => ({ type: "tool", id: event.id, name: event.name, status: event.status, detail: event.detail ?? "", output: event.output ?? "" }),
    (entry) => ({
      ...entry,
      name: event.name || entry.name,
      status: event.status,
      detail: event.append ? entry.detail + (event.detail ?? "") : (event.detail ?? entry.detail),
      output: event.append ? entry.output + (event.output ?? "") : (event.output ?? entry.output),
    }),
  );
}

/** 사용자 입력 메시지를 대화 엔트리에 추가 */
function appendUserInput(entries: ChatEntry[], event: Extract<ChatEvent, { type: "userInput" }>): ChatEntry[] {
  return [
    ...entries,
    { type: "message", id: event.id, role: "user", kind: "message", text: event.text, attachments: event.attachments },
  ];
}

/** 승인 요청을 대화 엔트리에 추가 또는 대체 */
function upsertChatApproval(entries: ChatEntry[], event: Extract<ChatEvent, { type: "approval" }>): ChatEntry[] {
  return [
    ...entries.filter((entry) => entry.type !== "approval" || entry.id !== event.id),
    {
      type: "approval",
      id: event.id,
      kind: event.kind,
      questions: event.questions ?? [],
      title: event.title,
      detail: event.detail ?? "",
      options: event.options,
      interactive: event.interactive,
      needsSecret: event.needsSecret ?? false,
      resolved: null,
      answers: {},
      note: "",
    },
  ];
}

/**
 * 해결된 승인 요청 결정을 해당 턴 엔트리에 반영한다.
 *
 * C9-17-5. 먼저 온 결정이 이긴다. 같은 카드에 해결이 두 번 오는 자리가 있기 때문이다 — 사용자가
 * 답한 1회용 승인에도 만료 시각이 되면 백엔드가 카드를 닫는 해결을 한 번 더 보낸다(만료
 * 카드를 없앨 방법이 없던 문제의 해결책이다). 나중에 온 것으로 덮으면 허용한 카드가
 * "취소했습니다"로 바뀌어, 사용자가 누른 것과 다른 기록이 남는다.
 */
function resolveChatApprovalInTurn(turn: ChatTurn, event: Extract<ChatEvent, { type: "approvalResolved" }>): ChatTurn {
  return {
    ...turn,
    entries: turn.entries.map((entry) => entry.type === "approval" && entry.id === event.id && !entry.resolved
      ? { ...entry, resolved: event.decision, answers: event.answers ?? {}, note: event.note ?? "" }
      : entry),
  };
}

/** 오류 메시지를 새 에러 엔트리로 추가 */
function appendChatError(entries: ChatEntry[], message: string): ChatEntry[] {
  return [
    ...entries,
    { type: "error", id: crypto.randomUUID(), text: message },
  ];
}
