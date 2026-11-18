/// <reference types="cypress" />
// 긴 세션을 열면 본문이 맨 위에 한 번 그려진 뒤 프레임마다 자리를 옮겨(마지막 보낸 메시지로
// 붙이기, 읽던 자리가 나올 때까지 위쪽 턴 펼치기) 글자가 화면을 빠르게 훑고 지나갔다(사용자
// 보고: 어지럽다). 자리를 다 잡을 때까지 본문을 가리고 진행 막대를 세우는지를, 여는 동안
// 프레임마다 스크롤 위치와 가림 여부를 적어 "보이는 채로 움직인 프레임"이 없는지로 본다.

import { transcriptMessageKey } from "../../src/lib/readingAnchor";
import { stoppedChat, stubLiveChat, visitWithFakeChatSocket, type FakeChatSocketHandles } from "../support/chatSessionFixtures";
import type { SessionDetail, SessionSummary, TranscriptItem } from "../../src/types";

const SESSION: SessionSummary = {
  source: "codex",
  id: "qa-placement-veil-session",
  title: "자리 잡기 가림 표본",
  sourceTitle: null,
  project: "/tmp/qa-placement-veil",
  cwd: "/tmp/qa-placement-veil",
  startedAt: 1_757_200_000_000,
  updatedAt: 1_757_200_060_000,
  messageCount: 400,
  tokenTotal: 120,
  tokenUsage: null,
  model: "gpt-5",
  gitBranch: "develop",
  isSubagent: false,
  aiaWorkspace: false,
  archived: false,
  readable: true,
  sizeBytes: 4096,
  filePath: "/tmp/qa-placement-veil/session.jsonl",
  meta: {
    favorite: false,
    hidden: false,
    note: null,
    customTitle: null,
    folderIds: [],
    reasoningEffort: null,
    mode: null,
    approvalMode: null,
    creationAccountId: null,
    boundAccountId: null,
    pinnedAccountId: null,
  },
  lastFailure: null,
};

/** 마운트 창(60턴)을 몇 번 넘길 만큼 긴 대화. 답변은 화면 몇 줄 분량이다. */
const TURNS = 200;
const transcript: TranscriptItem[] = Array.from({ length: TURNS }, (_, turn) => [
  { index: turn * 2, turnId: `turn-${turn}`, role: "user" as const, timestamp: turn * 10 + 1, model: null, typeLabel: null, blocks: [{ kind: "text" as const, text: `질문 ${turn}` }], usage: null },
  { index: turn * 2 + 1, turnId: `turn-${turn}`, role: "assistant" as const, timestamp: turn * 10 + 2, model: null, typeLabel: null, blocks: [{ kind: "text" as const, text: Array.from({ length: 4 }, (__, line) => `답변 ${turn}의 ${line}번째 문단입니다.`).join("\n\n") }], usage: null },
]).flat();

const DETAIL: SessionDetail = { session: SESSION, transcript, truncated: false, skippedLines: 0, unavailableReason: null };

/** 프레임 하나. `anchors`는 본문 위 끝부터 보이는 메시지 몇 개의 화면상 위치(메시지 키 → 본문 위 끝 기준)다. */
interface Frame { top: number | null; placing: boolean; veil: boolean; loadingShown: boolean; anchors: Record<string, number> | null }
type SampledWindow = Cypress.AUTWindow & { __placementFrames?: Frame[]; __placementStop?: boolean; __veilNodes?: Set<Element> };

// 맨 위 하나만 보면, 경계에 걸친 메시지가 1px 보정에 경계를 넘나들 때 다른 메시지로 바뀐 것처럼
// 읽혀 움직임으로 잘못 센다. 보이는 메시지 몇 개를 적어 두고 두 프레임에 함께 있는 것끼리 비교한다.
const ANCHOR_SAMPLE = 4;

function readAnchors(body: HTMLElement | null): Frame["anchors"] {
  if (!body) return null;
  const view = body.getBoundingClientRect();
  const anchors: Record<string, number> = {};
  for (const element of Array.from(body.querySelectorAll<HTMLElement>("[data-message-key]"))) {
    const box = element.getBoundingClientRect();
    if (box.bottom <= view.top || box.top >= view.bottom) continue;
    anchors[element.dataset.messageKey ?? ""] = box.top - view.top;
    if (Object.keys(anchors).length >= ANCHOR_SAMPLE) break;
  }
  return anchors;
}

/** 다음 프레임부터 스크롤 본문(기본은 드로어 본문)의 스크롤 위치와 가림 여부를 프레임마다 적는다. */
function startSampling(bodySelector = ".drawer-body"): void {
  cy.window().then((win: SampledWindow) => {
    win.__placementFrames = [];
    win.__placementStop = false;
    win.__veilNodes = new Set();
    const tick = () => {
      if (win.__placementStop) return;
      const body = win.document.querySelector<HTMLElement>(bodySelector);
      const veilNode = win.document.querySelector(".transcript-placement-veil");
      if (veilNode) win.__veilNodes?.add(veilNode);
      win.__placementFrames?.push({
        top: body ? body.scrollTop : null,
        placing: Boolean(body?.classList.contains("is-placing")),
        veil: Boolean(win.document.querySelector(".transcript-placement-veil")),
        // 막 밖으로 '원문을 읽는 중' 표시가 따로 보였는지. 읽기와 자리 잡기는 한 막으로 이어진다.
        loadingShown: Boolean(win.document.querySelector(`${bodySelector}:not(.is-placing) .state-panel`)),
        anchors: readAnchors(body),
      });
      win.requestAnimationFrame(tick);
    };
    win.requestAnimationFrame(tick);
  });
}

/** 적은 프레임을 거두고, 본문이 보이는 채로 스크롤 위치가 바뀐 프레임 수를 센다. */
function stopSampling(): Cypress.Chainable<{ frames: Frame[]; visibleMoves: number; veiled: number; loadingShown: number; veilNodes: number; moves: string }> {
  return cy.window().then((win: SampledWindow) => {
    win.__placementStop = true;
    const frames = win.__placementFrames ?? [];
    let visibleMoves = 0;
    // 실패했을 때 어느 프레임이 어떻게 움직였는지 단언 메시지에 싣는다.
    const moveLog: string[] = [];
    for (let index = 1; index < frames.length; index += 1) {
      const previous = frames[index - 1];
      const current = frames[index];
      if (current.top === null || previous.top === null) continue;
      // 직전 프레임에 본문이 보였고 지금 프레임도 보이는데 화면 위 끝의 글이 바뀌거나 움직였으면
      // 사용자가 그 움직임을 본다. 위쪽에 턴을 붙이며 스크롤만 보정한 프레임은 글이 제자리라 세지 않는다.
      if (previous.placing || current.placing) continue;
      const shared = Object.keys(previous.anchors ?? {}).filter((key) => key in (current.anchors ?? {}));
      const moved = shared.length === 0
        ? Object.keys(previous.anchors ?? {}).length + Object.keys(current.anchors ?? {}).length > 0
        : shared.some((key) => Math.abs((previous.anchors?.[key] ?? 0) - (current.anchors?.[key] ?? 0)) > 1);
      if (moved) {
        visibleMoves += 1;
        moveLog.push(`#${index}/${frames.length} top ${previous.top}→${current.top} ${JSON.stringify(previous.anchors)}→${JSON.stringify(current.anchors)}`);
      }
    }
    return {
      frames,
      visibleMoves,
      veiled: frames.filter((frame) => frame.placing && frame.veil).length,
      loadingShown: frames.filter((frame) => frame.loadingShown).length,
      // 막이 몇 번 새로 섰는지. 읽기와 자리 잡기 사이에 다시 서면 나타나기 효과가 되풀이돼 깜빡인다.
      veilNodes: win.__veilNodes?.size ?? 0,
      moves: moveLog.join(" | "),
    };
  });
}

function openSession(): void {
  cy.contains(".session-table tbody tr", SESSION.title).click();
  cy.wait("@detail");
}

describe("긴 세션을 열 때 자리 잡기 동안의 가림", () => {
  beforeEach(() => {
    cy.stubSnapshotField("sessions", [SESSION]);
    cy.stubInvoke("get_session_detail", { statusCode: 200, body: DETAIL, delay: 250 }).as("detail");
    cy.visitApp({ "agent-manager.session-transcript-limit": "all" });
    cy.openView("sessions");
  });

  it("처음 열 때 본문이 보이는 채로 움직이지 않고, 자리를 잡으면 막이 걷힌다", () => {
    startSampling();
    cy.contains(".session-table tbody tr", SESSION.title).click();
    // 원문을 읽는 동안부터 같은 막 하나가 선다('읽는 중' 표시 → 본문 → 자리 맞추기로 갈리지 않는다).
    cy.get(".transcript-placement-veil").should("contain.text", "로딩 중입니다");
    cy.wait("@detail");
    // 막은 자리를 다 잡아서 걷혀야 한다. 상한(6초)이 걷은 것이면 이 단언이 먼저 실패한다(바쁜 NAS 여유 5초).
    cy.get(".transcript-placement-veil", { timeout: 5000 }).should("not.exist");
    cy.get(".drawer-body").should("not.have.class", "is-placing");
    // 늦게 오는 이동까지 거두도록 잠깐 더 적는다.
    cy.wait(600);
    stopSampling().then(({ frames, visibleMoves, moves, veiled, loadingShown, veilNodes }) => {
      cy.log(`frames=${frames.length} veiled=${veiled} visibleMoves=${visibleMoves} loadingShown=${loadingShown} veilNodes=${veilNodes}`);
      expect(loadingShown, "막 밖으로 '원문을 읽는 중' 표시가 보인 프레임").to.equal(0);
      expect(veilNodes, "읽기부터 자리 잡기까지 이어진 막의 수").to.equal(1);
      expect(visibleMoves, `본문이 보이는 채로 움직인 프레임 ${moves}`).to.equal(0);
      expect(veiled, "자리 잡는 동안 막이 선 프레임").to.be.greaterThan(0);
    });
    // 기본 표시 방식(마지막 보낸 메시지부터)대로 마지막 질문이 화면 위쪽에 선다.
    cy.get(`.drawer-body [data-message-key="${transcriptMessageKey((TURNS - 1) * 2)}"]`).should(($message) => {
      const view = Cypress.$(".drawer-body")[0].getBoundingClientRect();
      const top = $message[0].getBoundingClientRect().top - view.top;
      // 대화 끝이라 더 내려갈 수 없으면 화면 아래쪽에 선다. 화면 안에 있기만 하면 된다.
      expect(top, "마지막 질문의 본문 위 끝 기준 위치").to.be.within(-2, view.height - 20);
    });
  });

  it("원문을 받는 동안 막대가 받은 비율을 보이며 차오른다", () => {
    // 흘러가기만 하는 막대는 얼마나 남았는지 알려 주지 않는다(사용자 보고). 원문 응답을 조각으로
    // 나눠 천천히 흘려 보내, 받은 바이트에 따라 막대 값(aria-valuenow)이 실제로 오르는지 본다.
    // cy.intercept 의 전송 늦추기는 본문을 다 모은 뒤 한 번에 보내므로, 창의 fetch 에서 직접 흘린다.
    // 실제 백엔드처럼 압축하고 압축 전 크기를 X-Uncompressed-Length 로 싣는 상황을 흉내 낸다.
    const CHUNKS = 12;
    const seen: number[] = [];
    cy.window().then((win) => {
      const bytes = new TextEncoder().encode(JSON.stringify(DETAIL));
      const realFetch = win.fetch.bind(win);
      win.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).includes("/api/invoke/get_session_detail")) return realFetch(input, init);
        const size = Math.ceil(bytes.length / CHUNKS);
        let sent = 0;
        const body = new win.ReadableStream<Uint8Array>({
          pull(controller) {
            return new Promise<void>((resolve) => win.setTimeout(() => {
              controller.enqueue(bytes.slice(sent, sent + size));
              sent += size;
              if (sent >= bytes.length) controller.close();
              resolve();
            }, 150));
          },
        });
        return new win.Response(body, {
          headers: { "content-type": "application/json", "content-encoding": "gzip", "x-uncompressed-length": String(bytes.length) },
        });
      }) as typeof fetch;
      const read = () => {
        const bar = win.document.querySelector(".transcript-placement-veil [role=progressbar]");
        const value = bar?.getAttribute("aria-valuenow");
        if (value !== null && value !== undefined && seen.at(-1) !== Number(value)) seen.push(Number(value));
        if (!win.document.querySelector(".drawer-body") || bar) win.requestAnimationFrame(read);
      };
      win.requestAnimationFrame(read);
    });
    cy.contains(".session-table tbody tr", SESSION.title).click();
    cy.get(".transcript-placement-veil .progress").should("not.have.class", "is-indeterminate");
    cy.get(".transcript-placement-veil small").invoke("text").should("match", /로딩 중입니다 \d+%/);
    cy.get(".transcript-placement-veil", { timeout: 8000 }).should("not.exist");
    cy.then(() => {
      expect(seen.length, `막대가 거친 값 ${seen.join(",")}`).to.be.greaterThan(3);
      expect(seen.every((value, index) => index === 0 || value > seen[index - 1]), `막대는 뒤로 가지 않는다 ${seen.join(",")}`).to.equal(true);
      // 마지막 조각과 원문 도착이 한 번에 그려지면 100%는 화면에 서지 않고 막이 걷힌다.
      expect(seen.at(-1), `거의 다 받을 때까지 차오른다 ${seen.join(",")}`).to.be.at.least(80);
    });
    cy.get(".drawer-body [data-message-key]").should("have.length.greaterThan", 0);
  });

  it("읽던 자리로 되돌아갈 때 위쪽 턴을 펼치는 동안에도 본문을 가린다", () => {
    openSession();
    cy.get(".drawer-body").should("not.have.class", "is-placing");
    // 마운트 창 밖(앞쪽)까지 올라가 읽던 자리를 남긴다. 위쪽 경계가 보이면 관찰자가 턴을 더 붙이고
    // 보던 자리를 지키므로, 맨 위로 몇 번 올린다. '더 표시' 버튼을 누르면 관찰자가 먼저 붙여 버튼이
    // 바뀌는 사이에 누르기가 빗나간다.
    for (let lift = 0; lift < 4; lift += 1) {
      cy.get(".drawer-body").scrollTo("top");
      cy.wait(300);
    }
    // 화면이 남기는 읽던 자리와 같은 규칙(본문 위 끝 아래로 걸친 첫 메시지)으로 기준을 잡는다.
    cy.get(".drawer-body").then(($body) => {
      const top = $body[0].getBoundingClientRect().top;
      const reading = Array.from($body[0].querySelectorAll<HTMLElement>("[data-message-key]"))
        .find((element) => element.getBoundingClientRect().bottom > top);
      expect(reading, "읽던 자리").to.exist;
      // 앞쪽(마지막 마운트 창 밖) 턴이어야 되돌아갈 때 펼치기가 일어난다.
      expect(Number(reading?.dataset.messageKey?.replace(/\D/g, "")), "읽던 자리 색인").to.be.lessThan((TURNS - 60) * 2);
      cy.wrap(reading?.dataset.messageKey).as("readingKey");
    });
    cy.get("body").type("{esc}");
    cy.get(".drawer-body").should("not.exist");

    startSampling();
    openSession();
    cy.get(".transcript-placement-veil", { timeout: 5000 }).should("not.exist");
    cy.wait(600);
    stopSampling().then(({ visibleMoves, moves, veiled }) => {
      expect(visibleMoves, `본문이 보이는 채로 움직인 프레임 ${moves}`).to.equal(0);
      expect(veiled, "자리 잡는 동안 막이 선 프레임").to.be.greaterThan(0);
    });
    // 읽던 자리(앞쪽 턴)로 돌아와 있다.
    // 읽던 자리는 본문 위 끝에 걸쳐 머리글 아래로 반쯤 들어갈 수 있어 '보임' 대신 위치로 본다.
    cy.get("@readingKey").then((key) => {
      cy.get(`.drawer-body [data-message-key="${String(key)}"]`).should(($message) => {
        const view = Cypress.$(".drawer-body")[0].getBoundingClientRect();
        const box = $message[0].getBoundingClientRect();
        expect(box.bottom, "읽던 자리가 본문 위 끝 아래로 걸친다").to.be.greaterThan(view.top);
        expect(box.top, "읽던 자리가 본문 아래 끝보다 위에 있다").to.be.lessThan(view.bottom);
      });
    });
  });
});

describe("채팅을 열 때 위에 붙는 원문을 읽는 동안의 가림", () => {
  // 리플레이 버퍼가 앞부분을 밀어낸 채팅은 세션 파일 원문을 읽어 위에 붙인다. 원문이 오기
  // 전에는 스트림이 비었다가, 오면 맨 위에 그려진 뒤 마지막 보낸 메시지로 옮겨 간다.
  const HISTORY_DETAIL: SessionDetail = { ...DETAIL, session: { ...SESSION, id: "e2e-provider-session" } };

  /** 원문 조회 응답을 받아 리플레이가 잘린 종료 채팅 하나를 띄운다. */
  function visitChat(history: { statusCode: number; body: unknown }): void {
    const chat = stoppedChat({ replayTruncated: true });
    stubLiveChat(chat);
    cy.stubInvoke("get_session_detail", { ...history, delay: 400 }).as("history");
    visitWithFakeChatSocket(chat);
  }

  it("원문을 읽는 동안부터 자리를 잡을 때까지 막 하나로 가린다", () => {
    visitChat({ statusCode: 200, body: HISTORY_DETAIL });
    cy.openView("chat");
    startSampling(".chat-stream");
    cy.get(".chat-runtime-list-item").should("have.length", 1).click();
    cy.get(".chat-stream-shell .transcript-placement-veil").should("contain.text", "로딩 중입니다");
    cy.wait("@history");
    cy.get(".chat-stream-shell .transcript-placement-veil", { timeout: 5000 }).should("not.exist");
    cy.get(".chat-stream").should("not.have.class", "is-placing").and("have.attr", "aria-live", "polite");
    cy.get(".chat-stream .chat-transcript-history").should("exist");
    cy.wait(600);
    stopSampling().then(({ visibleMoves, moves, veilNodes }) => {
      expect(visibleMoves, `스트림이 보이는 채로 움직인 프레임 ${moves}`).to.equal(0);
      expect(veilNodes, "읽기부터 자리 잡기까지 이어진 막의 수").to.equal(1);
    });
    cy.get(`.chat-stream [data-message-key="${transcriptMessageKey((TURNS - 1) * 2)}"]`).should(($message) => {
      const view = Cypress.$(".chat-stream")[0].getBoundingClientRect();
      const top = $message[0].getBoundingClientRect().top - view.top;
      expect(top, "마지막 질문의 스트림 위 끝 기준 위치").to.be.within(-2, view.height - 20);
    });
  });

  it("원문을 읽지 못하면 막을 걷고 오류를 보인다", () => {
    // 읽기가 실패로 끝나도 막이 상한까지 남지 않아야 한다 — 실패가 곧 읽기의 끝이다.
    visitChat({ statusCode: 500, body: { error: "원문을 읽지 못했습니다(시험)" } });
    cy.openView("chat");
    cy.get(".chat-runtime-list-item").should("have.length", 1).click();
    cy.get(".chat-stream-shell .transcript-placement-veil").should("contain.text", "로딩 중입니다");
    cy.wait("@history");
    cy.get(".chat-stream-shell .transcript-placement-veil", { timeout: 3000 }).should("not.exist");
    cy.get(".chat-stream").should("not.have.class", "is-placing");
    cy.contains(".chat-transcript-history", "원문을 읽지 못했습니다").should("be.visible");
  });

  it("지난 턴이 붙기 뒤에 따로 들어와도 다 들어올 때까지 막을 걷지 않는다", () => {
    // 붙기는 첫 상태 이벤트에서 끝나고 리플레이 턴은 그 뒤 소켓 메시지로 들어온다. 그 사이에
    // 막을 걷으면 지난 턴이 맨 위에 그려진 뒤 마지막 보낸 메시지로 옮겨 가는 것이 보인다.
    // 목록은 지금 값(턴 40개, 입력 대기)을 알려 주고, 붙으면 리플레이가 첫 턴 전의 지난 상태(턴 0)부터
    // 되풀이한다. 지금 상태는 지난 턴들 뒤에 온다.
    const REPLAYED = 40;
    const listed = stoppedChat({ state: "ready", turnCount: REPLAYED });
    stubLiveChat(listed);
    visitWithFakeChatSocket({ ...listed, turnCount: 0 });
    cy.openView("chat");
    startSampling(".chat-stream");
    cy.get(".chat-runtime-list-item").should("have.length", 1).click();
    cy.get(".chat-stream-shell .transcript-placement-veil").should("contain.text", "로딩 중입니다");
    cy.wait(300);
    // 이벤트 묶음을 한 번에 밀어 넣는다. 명령 하나에 하나씩 보내면 수백 개가 몇 초씩 걸려 자리
    // 잡기 상한(6초)에 닿는다.
    const emit = (events: object[]) => cy.window().then((win) => {
      const socket = (win as unknown as FakeChatSocketHandles).__qaChatSocket;
      expect(socket, "가짜 채팅 소켓").not.to.equal(null);
      for (const event of events) socket?.dispatchEvent(new win.MessageEvent("message", { data: JSON.stringify(event) }));
    });
    const at = (turn: number) => 1_700_000_001_000 + turn * 1_000;
    // 턴 하나의 시작부. 코어는 턴을 시작하며 늘어난 턴 수와 '응답 중' 상태를 남긴다.
    const startTurn = (turn: number) => [
      { type: "turn", id: `replay-${turn}`, status: "started", timestamp: at(turn) },
      { type: "userInput", id: `replay-user-${turn}`, text: `리플레이 질문 ${turn}`, attachments: [] },
      { type: "state", session: { ...listed, state: "running", turnCount: turn + 1 } },
    ];
    const finishTurn = (turn: number) => [
      { type: "messageDelta", id: `replay-answer-${turn}`, role: "assistant", kind: "text", delta: Array.from({ length: 4 }, (_, line) => `리플레이 답변 ${turn}의 ${line}번째 문단입니다.`).join("\n\n") },
      { type: "turn", id: `replay-${turn}`, status: "completed", timestamp: at(turn) + 500 },
    ];
    emit(Array.from({ length: REPLAYED - 1 }, (_, turn) => [...startTurn(turn), ...finishTurn(turn)]).flat());
    // 마지막 턴이 시작된 순간 턴 수는 이미 목록 값에 닿는다. 답이 오기 전이라 막은 그대로여야 한다.
    emit(startTurn(REPLAYED - 1));
    cy.wait(400);
    cy.get(".chat-stream-shell .transcript-placement-veil").should("exist");
    emit([...finishTurn(REPLAYED - 1), { type: "state", session: listed }]);
    // 마지막 상태가 와서 걷혀야 한다. 넉넉히 기다리면 자리 잡기 상한(6초)이 걷은 것과 구별되지 않는다.
    cy.get(".chat-stream-shell .transcript-placement-veil", { timeout: 2500 }).should("not.exist");
    cy.wait(600);
    stopSampling().then(({ visibleMoves, moves, veilNodes }) => {
      expect(visibleMoves, `스트림이 보이는 채로 움직인 프레임 ${moves}`).to.equal(0);
      expect(veilNodes, "턴을 기다리는 동안부터 이어진 막의 수").to.equal(1);
    });
    cy.get(".chat-stream").contains(`리플레이 질문 ${REPLAYED - 1}`).should(($message) => {
      const view = Cypress.$(".chat-stream")[0].getBoundingClientRect();
      const box = $message[0].getBoundingClientRect();
      expect(box.top - view.top, "마지막 질문의 스트림 위 끝 기준 위치").to.be.within(-2, view.height - 20);
    });
  });
});
