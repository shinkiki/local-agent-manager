import type { ChatEvent } from "../types";

export interface ChatEventFrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface ChatEventBatch {
  push(event: ChatEvent): void;
  flush(): void;
  dispose(): void;
}

const browserFrameScheduler: ChatEventFrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/**
 * 스트리밍 델타를 한 프레임에 한 번 전달한다. 상태·도구·턴 이벤트는
 * 앞선 델타를 먼저 비운 뒤 즉시 전달해 서버 이벤트 순서를 보존한다.
 */
export function createChatEventBatch(
  onEvent: (event: ChatEvent) => void,
  scheduler: ChatEventFrameScheduler = browserFrameScheduler,
): ChatEventBatch {
  const pending: Extract<ChatEvent, { type: "messageDelta" }>[] = [];
  let scheduledFrame: number | null = null;
  let disposed = false;

  const drain = () => {
    const events = pending.splice(0, pending.length);
    for (const event of events) onEvent(event);
  };

  const flush = () => {
    if (scheduledFrame !== null) {
      scheduler.cancel(scheduledFrame);
      scheduledFrame = null;
    }
    drain();
  };

  return {
    push(event) {
      if (disposed) return;
      if (event.type !== "messageDelta") {
        flush();
        onEvent(event);
        return;
      }

      const last = pending[pending.length - 1];
      if (last && last.id === event.id && last.role === event.role && last.kind === event.kind) {
        last.delta += event.delta;
      } else {
        pending.push({ ...event });
      }
      if (scheduledFrame === null) {
        scheduledFrame = scheduler.request(() => {
          scheduledFrame = null;
          drain();
        });
      }
    },
    flush,
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
    },
  };
}
