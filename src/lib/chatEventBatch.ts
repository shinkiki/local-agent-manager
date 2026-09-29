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

const browserFrameScheduler: ChatEventFrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/**
 * 바로 앞 조각에 이어 붙일 수 있는 델타인지. 같은 메시지의 같은 역할·갈래일 때만 한
 * 조각으로 합쳐야 서로 다른 메시지의 본문이 섞이지 않는다.
 */
function continuesDelta(last: ChatMessageDelta, event: ChatMessageDelta): boolean {
  return last.id === event.id && last.role === event.role && last.kind === event.kind;
}

/**
 * 스트리밍 델타를 한 프레임에 한 번 전달한다. 상태·도구·턴 이벤트는
 * 앞선 델타를 먼저 비운 뒤 즉시 전달해 서버 이벤트 순서를 보존한다.
 */
export function createChatEventBatch(
  onEvent: (event: ChatEvent) => void,
  scheduler: ChatEventFrameScheduler = browserFrameScheduler,
): ChatEventBatch {
  const pending: ChatMessageDelta[] = [];
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

  /** 델타 한 조각을 대기열에 얹는다. 바로 앞 조각과 이어지면 새 항목 대신 그 조각을 늘린다. */
  const appendDelta = (event: ChatMessageDelta) => {
    const last = pending[pending.length - 1];
    if (last && continuesDelta(last, event)) {
      last.delta += event.delta;
      return;
    }
    // 원본을 그대로 쌓으면 뒤이어 오는 조각이 호출자의 객체를 고치게 되므로 복사해 둔다.
    pending.push({ ...event });
  };

  return {
    push(event) {
      if (disposed) return;
      if (event.type !== "messageDelta") {
        flush();
        onEvent(event);
        return;
      }
      appendDelta(event);
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
