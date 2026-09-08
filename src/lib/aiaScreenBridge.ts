/** Same-origin window routing. Discovery selects one main window, so a click is never broadcast. */
export function createAiaScreenBridge<T>(
  isMain: boolean,
  handle: (payload: T) => Promise<boolean>,
  channel = new BroadcastChannel("agent-manager.aia-screen.v1"),
) {
  const id = crypto.randomUUID();
  let closed = false;
  let mainId: string | null = null;
  const pending = new Map<string, (value: boolean) => void>();
  const discoveries = new Set<() => void>();
  channel.onmessage = ({ data }) => {
    if (!data || typeof data !== "object") return;
    if (data.type === "discover" && isMain) {
      channel.postMessage({ type: "main", to: data.from, from: id });
    } else if (data.type === "main" && data.to === id && typeof data.from === "string") {
      mainId ??= data.from;
      for (const ready of discoveries) ready();
    } else if (data.type === "request" && isMain && data.to === id) {
      void Promise.resolve().then(() => handle(data.payload)).catch(() => false).then((ok) => {
        if (!closed) channel.postMessage({ type: "result", to: data.from, requestId: data.requestId, ok });
      });
    } else if (data.type === "result" && data.to === id) {
      pending.get(data.requestId)?.(data.ok === true);
    }
  };
  return {
    async request(payload: T): Promise<boolean> {
      if (closed) return false;
      if (!mainId) {
        await new Promise<void>((resolve) => {
          const ready = () => { clearTimeout(timer); discoveries.delete(ready); resolve(); };
          const timer = setTimeout(ready, 1000);
          discoveries.add(ready);
          channel.postMessage({ type: "discover", from: id });
        });
      }
      if (closed || !mainId) return false;
      return new Promise<boolean>((resolve) => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(() => { mainId = null; finish(false); }, 15_000);
        const finish = (ok: boolean) => { clearTimeout(timer); pending.delete(requestId); resolve(ok); };
        pending.set(requestId, finish);
        channel.postMessage({ type: "request", from: id, to: mainId, requestId, payload });
      });
    },
    close() {
      closed = true;
      for (const ready of discoveries) ready();
      for (const finish of pending.values()) finish(false);
      channel.close();
    },
  };
}
