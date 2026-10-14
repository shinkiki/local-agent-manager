import type { ChatEvent } from "../types";
import { createCancelableHandle } from "./cancelableHandle.ts";

interface ChatEventFrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface ChatEventBatch {
  push(event: ChatEvent): void;
  flush(): void;
  dispose(): void;
}

/** 프레임마다 한 번씩 모아 내보내는 스트리밍 조각. 이 종류만 대기열에 쌓인다. */
type ChatMessageDelta = Extract<ChatEvent, { type: "messageDelta" }>;
type ChatToolEvent = Extract<ChatEvent, { type: "tool" }>;
/**
 * 대기열에 쌓이는 두 종류. 메시지 델타와 도구의 이어 붙는 조각(`append`)은 둘 다 한 항목을
 * 여러 번에 나눠 채우는 이벤트라, 조각마다 화면을 다시 그리면 본문 길이에 비례하는 레이아웃
 * 비용이 조각 수만큼 든다 — 45만 자 명령 출력이 흐르는 동안 화면이 멈춘 것이 그 모양이었다.
 */
type PendingChatEvent = ChatMessageDelta | ChatToolEvent;

const browserFrameScheduler: ChatEventFrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

function isPendingEvent(event: ChatEvent): event is PendingChatEvent {
  return event.type === "messageDelta" || (event.type === "tool" && event.append);
}

/**
 * 바로 앞 조각에 이어 붙일 수 있는지. 같은 메시지의 같은 역할·갈래, 또는 같은 도구 카드일
 * 때만 한 조각으로 합쳐야 서로 다른 항목의 본문이 섞이지 않는다.
 */
function continues(last: PendingChatEvent, event: PendingChatEvent): boolean {
  if (last.type === "messageDelta" && event.type === "messageDelta") {
    return last.id === event.id && last.role === event.role && last.kind === event.kind;
  }
  return last.type === "tool" && event.type === "tool" && last.id === event.id;
}

/** 뒤 조각을 앞 조각에 합친다. 합친 결과는 화면이 두 조각을 순서대로 적용한 것과 같다. */
function merge(last: PendingChatEvent, event: PendingChatEvent): void {
  if (last.type === "messageDelta" && event.type === "messageDelta") {
    last.delta += event.delta;
    return;
  }
  if (last.type === "tool" && event.type === "tool") {
    if (event.name) last.name = event.name;
    last.status = event.status;
    if (event.detail != null) last.detail = (last.detail ?? "") + event.detail;
    if (event.output != null) last.output = (last.output ?? "") + event.output;
  }
}

/**
 * 스트리밍 조각을 한 프레임에 한 번 전달한다. 상태·턴 이벤트와 이어 붙지 않는 도구 이벤트는
 * 앞선 조각을 먼저 비운 뒤 즉시 전달해 서버 이벤트 순서를 보존한다.
 */
export function createChatEventBatch(
  onEvent: (event: ChatEvent) => void,
  scheduler: ChatEventFrameScheduler = browserFrameScheduler,
): ChatEventBatch {
  const pending: PendingChatEvent[] = [];
  const frame = createCancelableHandle(
    (run) => scheduler.request(run),
    (handle) => scheduler.cancel(handle),
  );
  let disposed = false;

  const drain = () => {
    const events = pending.splice(0, pending.length);
    for (const event of events) onEvent(event);
  };

  const flush = () => {
    frame.cancel();
    drain();
  };

  /** 조각 하나를 대기열에 얹는다. 바로 앞 조각과 이어지면 새 항목 대신 그 조각을 늘린다. */
  const appendPending = (event: PendingChatEvent) => {
    const last = pending[pending.length - 1];
    if (last && continues(last, event)) {
      merge(last, event);
      return;
    }
    // 원본을 그대로 쌓으면 뒤이어 오는 조각이 호출자의 객체를 고치게 되므로 복사해 둔다.
    pending.push({ ...event });
  };

  return {
    push(event) {
      if (disposed) return;
      if (!isPendingEvent(event)) {
        flush();
        onEvent(event);
        return;
      }
      appendPending(event);
      // 대기열은 다음 프레임에 비운다. 이미 예약돼 있으면 그 예약이 함께 가져간다.
      frame.arm(drain);
    },
    flush,
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
    },
  };
}
