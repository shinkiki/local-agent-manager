/**
 * 팝아웃 창이 화면 조작(안내·질의·클릭)을 메인 창에 넘기는 same-origin 통로.
 *
 * 프로토콜은 네 종류의 메시지로 끝난다 — 팝아웃이 메인을 찾고(`discover`/`main`),
 * 찾은 메인 하나에만 요청을 보내고(`request`), 그 결과를 돌려받는다(`result`).
 * 발견 단계에서 메인을 하나로 좁히므로 클릭이 여러 창에 방송되는 일은 없다.
 *
 * 네 종류가 한 덩어리의 else-if로 붙어 있어, 메시지 하나를 고칠 때 나머지 셋의 수신
 * 조건까지 함께 읽어야 했다. 종류별 처리를 이름 붙인 함수로 가르고, 응답을 기다리는
 * 두 대기(발견·요청)도 각자의 시한과 함께 한 자리씩 차지하게 뒀다.
 */

/** 메인 창을 찾는 데 허용하는 시간. 지나면 메인이 없는 것으로 보고 요청을 접는다. */
const DISCOVERY_TIMEOUT_MS = 1_000;

/**
 * 요청 하나의 응답 시한. 지나면 실패로 접고 메인 지목을 지운다 — 응답이 없는 창은
 * 이미 닫혔을 수 있으므로, 다음 요청은 발견부터 다시 한다.
 */
const REQUEST_TIMEOUT_MS = 15_000;

type BridgeMessage =
  | { type: "discover"; from: string }
  | { type: "main"; to: string; from: string }
  | { type: "request"; from: string; to: string; requestId: string; payload: unknown }
  | { type: "result"; to: string; requestId: string; ok: boolean };

/** 발견·요청 대기자를 한꺼번에 마무리한다. 각 완료 함수가 자기 등록 자리와 시한을 치운다. */
function settleWaiters<T>(waiters: Iterable<(value: T) => void>, value: T): void {
  for (const settle of waiters) settle(value);
}

export function createAiaScreenBridge<T>(
  isMain: boolean,
  handle: (payload: T) => Promise<boolean>,
  channel = new BroadcastChannel("agent-manager.aia-screen.v1"),
) {
  const id = crypto.randomUUID();
  let closed = false;
  let mainId: string | null = null;
  /** 응답을 기다리는 요청의 마무리 함수. 결과·시한·통로 닫힘 중 먼저 오는 것이 부른다. */
  const pending = new Map<string, (value: boolean) => void>();
  /** 발견을 기다리는 대기자. 메인을 찾거나 시한이 지나면 모두 깨운다. */
  const discoveries = new Set<() => void>();

  const post = (message: BridgeMessage) => channel.postMessage(message);

  /** 팝아웃의 발견 요청. 메인 창만 자기 id를 알린다. */
  function receiveDiscover(message: BridgeMessage & { type: "discover" }): void {
    if (isMain) post({ type: "main", to: message.from, from: id });
  }

  /** 메인의 응답. 먼저 답한 창 하나만 상대로 삼고, 기다리던 요청을 모두 깨운다. */
  function receiveMain(message: BridgeMessage & { type: "main" }): void {
    if (message.to !== id || typeof message.from !== "string") return;
    mainId ??= message.from;
    settleWaiters(discoveries, undefined);
  }

  /** 나를 지목한 화면 조작 요청. 메인 창만 실제로 수행하고 결과를 돌려준다. */
  function receiveRequest(message: BridgeMessage & { type: "request" }): void {
    if (!isMain || message.to !== id) return;
    void Promise.resolve()
      .then(() => handle(message.payload as T))
      .catch(() => false)
      .then((ok) => {
        // 통로를 닫은 뒤의 응답은 보내지 않는다. 이미 닫힌 창이 말을 거는 꼴이 된다.
        if (!closed) post({ type: "result", to: message.from, requestId: message.requestId, ok });
      });
  }

  /** 내가 보낸 요청의 결과. 이미 시한이 지나 마무리된 요청이면 남아 있지 않다. */
  function receiveResult(message: BridgeMessage & { type: "result" }): void {
    if (message.to !== id) return;
    pending.get(message.requestId)?.(message.ok === true);
  }

  channel.onmessage = ({ data }) => {
    if (!data || typeof data !== "object") return;
    const message = data as BridgeMessage;
    switch (message.type) {
      case "discover": return receiveDiscover(message);
      case "main": return receiveMain(message);
      case "request": return receiveRequest(message);
      case "result": return receiveResult(message);
    }
  };

  /** 메인 창을 찾는다. 시한이 지나도 깨어나므로, 찾았는지는 `mainId`로 확인한다. */
  function discoverMain(): Promise<void> {
    return new Promise<void>((resolve) => {
      const ready = () => {
        clearTimeout(timer);
        discoveries.delete(ready);
        resolve();
      };
      const timer = setTimeout(ready, DISCOVERY_TIMEOUT_MS);
      discoveries.add(ready);
      post({ type: "discover", from: id });
    });
  }

  /** 지목한 메인에 요청 하나를 보내고 결과를 기다린다. */
  function sendRequest(to: string, payload: T): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const requestId = crypto.randomUUID();
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        mainId = null;
        finish(false);
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, finish);
      post({ type: "request", from: id, to, requestId, payload });
    });
  }

  return {
    async request(payload: T): Promise<boolean> {
      if (closed) return false;
      if (!mainId) await discoverMain();
      if (closed || !mainId) return false;
      return sendRequest(mainId, payload);
    },
    close() {
      closed = true;
      settleWaiters(discoveries, undefined);
      settleWaiters(pending.values(), false);
      channel.close();
    },
  };
}
