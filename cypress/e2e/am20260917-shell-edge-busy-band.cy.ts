/// <reference types="cypress" />
// 창 크롬과 앱을 가르는 셸 상단선(bf5ec0a1·8707dd4e)은 두 겹이다 — 언제나 있는 테두리(::before)와
// AIA·에이전트가 도는 동안에만 떠오르는 놋빛 띠(::after). "도는 중" 판정은
// `aiaBusy || chatAttention.items.some(item => item.kind === "running")`(src/App.tsx:679)이고,
// 그 결과가 `.manager-shell`의 `busy` 클래스로만 나간다(src/App.tsx:823).
// 이 기능이 붙은 뒤 화면으로 확인된 적이 없다. 알림 목록을 2초 폴링 사이에 갈아 끼워
// 띠가 뜨고 걷히는 전이와, running이 아닌 알림에는 뜨지 않는 경계를 본다.
const SHELL = ".manager-shell";

type Kind = "running" | "approval" | "completed" | "failed" | "accountSwitch";

function item(id: string, kind: Kind) {
  return {
    id,
    chatId: `qa-shell-${id}`,
    source: "codex",
    providerSessionId: null,
    cwd: "/tmp/am-e2e-shell-band",
    resuming: false,
    unattended: false,
    profile: "standard",
    origin: null,
    kind,
    title: `셸 상단선 ${kind}`,
    detail: null,
    approvalId: kind === "approval" ? "qa-approval" : null,
    preview: null,
    createdAt: 1_700_000_000_000,
    read: kind !== "approval",
  };
}

function snapshot(items: ReturnType<typeof item>[]) {
  return { items, unreadCount: items.filter((one) => !one.read).length, pendingCount: 0 };
}

/**
 * 폴링 응답을 테스트 중간에 갈아 끼운다. 2초 주기라 바꾼 값은 다음 주기에 화면에 닿는다.
 * 목록 교체는 반드시 `cy.then` 안에서 일어나야 한다 — 밖에 두면 명령 큐를 쌓는 동안 전부
 * 먼저 실행되어 마지막 값만 남고, 전이를 보는 단언이 엉뚱한 상태를 기다린다.
 */
function stubAttention(): { set: (items: ReturnType<typeof item>[]) => void } {
  const state = { items: [] as ReturnType<typeof item>[] };
  cy.stubInvoke("get_chat_attention_snapshot", (request) => {
    request.reply({ statusCode: 200, body: snapshot(state.items) });
  });
  return { set: (items) => { cy.then(() => { state.items = items; }); } };
}

/**
 * 띠(::after)의 계산값을 본다. 클래스만 보면 CSS가 빠져도 통과하므로 실제 그려지는 값까지 본다.
 * 불투명도는 320ms 전환을 거쳐 올라오므로 단언이 다시 시도되어야 한다 — `should` 콜백 안에서
 * 계산값을 다시 읽는다.
 */
function band(assert: (style: CSSStyleDeclaration) => void): void {
  cy.get(SHELL).should(($shell) => {
    assert($shell[0].ownerDocument.defaultView!.getComputedStyle($shell[0], "::after"));
  });
}

describe("셸 상단 경계선 · 작업 중 놋빛 띠", () => {
  it("실행 중 알림이 생기면 띠가 흐르고 그 알림이 걷히면 다시 가라앉는다", () => {
    const attention = stubAttention();
    cy.visitApp();

    // 1) 아무것도 돌지 않을 때: busy가 붙지 않고 띠는 보이지 않는다. 테두리(::before)는 남는다.
    cy.get(SHELL).should("not.have.class", "busy");
    band((style) => {
      expect(style.opacity).to.equal("0");
      expect(style.animationName).to.equal("none");
    });

    // 2) 실행 중 알림이 뜨면 띠가 드러나고 좌우를 오가는 애니메이션이 걸린다.
    attention.set([item("run-1", "running")]);
    cy.get(SHELL).should("have.class", "busy");
    band((style) => {
      expect(style.opacity).to.equal("1");
      expect(style.animationName).to.equal("shell-edge-flow");
      expect(style.animationDirection).to.equal("alternate");
    });

    // 3) 턴이 끝나 같은 id가 completed로 덮이면 도는 중이 아니다 — 알림은 남아도 띠는 걷힌다.
    attention.set([item("run-1", "completed")]);
    cy.get(SHELL).should("not.have.class", "busy");
    band((style) => expect(style.opacity).to.equal("0"));

    // 4) 목록이 통째로 비어도 같은 상태다.
    attention.set([]);
    cy.get(SHELL).should("not.have.class", "busy");
  });

  it("실행 중이 아닌 알림만 쌓여 있으면 띠를 흘리지 않고, 하나라도 실행 중이면 흘린다", () => {
    const attention = stubAttention();
    attention.set([item("ap-1", "approval"), item("fail-1", "failed"), item("sw-1", "accountSwitch")]);
    cy.visitApp();

    // 승인 대기·실패·계정 전환은 사용자가 볼 것이지 도는 중은 아니다.
    cy.get(".topbar").should("be.visible");
    cy.get(SHELL).should("not.have.class", "busy");

    // 그 사이에 실행 중 한 건만 섞여도 띠는 흐른다.
    attention.set([item("ap-1", "approval"), item("run-2", "running"), item("fail-1", "failed")]);
    cy.get(SHELL).should("have.class", "busy");

    // 실행 중만 빠지면 나머지가 그대로 남아도 다시 가라앉는다.
    attention.set([item("ap-1", "approval"), item("fail-1", "failed")]);
    cy.get(SHELL).should("not.have.class", "busy");
  });

  it("띠는 어느 겹보다 위에 남고 클릭을 가로채지 않는다", () => {
    const attention = stubAttention();
    attention.set([item("run-3", "running")]);
    cy.visitApp();
    cy.get(SHELL).should("have.class", "busy");

    // 알림 팝오버(z 120)·드로워의 막보다 위여야 창 가장자리로 읽힌다.
    band((style) => {
      expect(style.zIndex).to.equal("200");
      expect(style.pointerEvents).to.equal("none");
      expect(style.height).to.equal("1px");
    });

    // 1px 선이 상단바를 덮고 있으면 바로 아래 버튼을 못 누른다. 화면 전환이 그대로 되는지 본다.
    cy.openView("settings");
    cy.get(SHELL).should("have.class", "busy");
  });
});
