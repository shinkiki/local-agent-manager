/// <reference types="cypress" />
// 트리거 옆 알림 미리보기 말풍선(`.aia-attention-bubble`)을 본다. 악센트 색만 보는
// AM-160과 달리 여기서 보는 것은 말풍선이 담는 **내용과 수명**이다.
//
// 1) 긴 요청·응답이 상한(요청 90자·응답 120자) 안쪽 문장 경계에서 끊겨 말줄임표로
//    마무리되는가 — `src/lib/aiaAttention.ts:87`의 `clampBubbleText` 경계.
// 2) 말풍선을 닫으면 같은 알림에는 다시 뜨지 않고 점 세 개 표시로 돌아가는가 —
//    2초 폴링(`src/App.tsx:1235`)이 같은 알림을 계속 실어 와도 되살아나면 안 된다.
// 3) 다음 알림이 오면 다시 뜨는가 — `shouldShowAiaAttentionBubble`이 닫은 키를
//    알림 하나에만 묶어 두는지(`src/lib/aiaAttention.ts:44`).

// 요청 상한 90자. 앞 문장(60자)이 경계이므로 여기까지만 남고 뒤 문장은 잘린다.
const REQUEST_HEAD = "AIA가 방금 끝낸 회차의 요청 문구를 말풍선 첫 줄에 담되 상한을 넘으면 낱말과 문장 경계를 지켜 끊는다.";
const REQUEST_TAIL = "이 뒤쪽 문장은 요청 상한을 넘으므로 잘려 나가야 하며 화면에 남으면 안 된다.";
// 응답 상한 120자. 앞 두 문장(77자)이 경계다.
const RESPONSE_HEAD = "회차 요약을 정리했고 실패한 단계는 없었으며 다음 회차가 이어받을 항목만 남겨 두었습니다. 자세한 내용은 대화를 열어 직접 확인해 주세요.";
const RESPONSE_TAIL = "이 뒤쪽 문장은 응답 상한을 넘으므로 말풍선에 담기지 않아야 하고 잘려 나가야 한다.";

const NEXT_REQUEST = "다음 알림의 요청";
const NEXT_RESPONSE = "다음 알림의 답변은 짧아 그대로 담긴다.";

function aiaAttentionItem(id: string, preview: { request: string; response: string }) {
  return {
    id,
    chatId: "qa-aia-bubble-chat",
    source: "codex",
    providerSessionId: null,
    cwd: "/tmp/am-e2e-aia-bubble",
    resuming: false,
    unattended: false,
    profile: "aia",
    origin: { kind: "aia" },
    kind: "completed",
    title: "AIA 회차 답변",
    detail: null,
    approvalId: null,
    preview,
    createdAt: 1_700_000_000_000,
    read: false,
  };
}

const FIRST = aiaAttentionItem("qa-aia-bubble-1", {
  request: `${REQUEST_HEAD} ${REQUEST_TAIL}`,
  response: `${RESPONSE_HEAD} ${RESPONSE_TAIL}`,
});
const SECOND = aiaAttentionItem("qa-aia-bubble-2", { request: NEXT_REQUEST, response: NEXT_RESPONSE });

describe("AIA 알림 미리보기 말풍선의 경계 절단과 닫은 뒤 수명", () => {
  // 폴링이 돌 때마다 다시 읽히도록 현재 알림을 변수에 담아 응답한다. 값을 통째로
  // 넘기면 테스트 중간에 알림을 갈아 끼울 수 없다.
  let current = FIRST;

  beforeEach(() => {
    current = FIRST;
    cy.stubInvoke("get_system_automation_snapshot", (request) => {
      request.continue((response) => {
        response.body.settings.systemProvider = "codex";
        // 하네스는 호스트 CLI를 그대로 탐지하므로 자동 스키마 재조사가 살아 있다. 그대로
        // 두면 몇 초 뒤 그 요청이 AIA 팝업을 열어(App.tsx:723) 말풍선·점 표시가 함께
        // 사라진다. 이 스펙이 보는 것은 말풍선의 수명이므로 그 경로만 꺼 둔다.
        response.body.settings.catalogAutoDiscovery = false;
      });
    });
    cy.stubInvoke("get_chat_attention_snapshot", (request) => {
      request.reply({ items: [current], unreadCount: 1, pendingCount: 0 });
    }).as("attention");
  });

  it("긴 요청·응답을 문장 경계에서 끊어 담고, 닫으면 같은 알림에는 다시 뜨지 않으며, 다음 알림에는 다시 뜬다", () => {
    // 2d6f4231 이후 AIA 트리거는 이 창이 소유한 대화의 알림만 맡는다. 스텁 대화를 소유 핀으로 심는다.
    cy.visitApp({ "agent-manager.aia-chat.v1": "qa-aia-bubble-chat" });

    // 1) 경계 절단 — 상한을 넘긴 부분은 통째로 사라지고 말줄임표만 남는다.
    cy.get(".aia-attention-bubble").should("be.visible");
    cy.get(".aia-attention-bubble-request").should("have.text", `${REQUEST_HEAD}…`);
    cy.get(".aia-attention-bubble-response").should("have.text", `${RESPONSE_HEAD}…`);
    cy.get(".aia-attention-bubble").should("not.contain.text", "잘려 나가야");
    // 말풍선이 떠 있는 동안에는 점 세 개 표시를 겹쳐 두지 않는다.
    cy.get(".aia-attention-label").should("not.exist");

    // 2) 닫으면 점 세 개로 돌아가고, 폴링이 같은 알림을 다시 실어 와도 되살아나지 않는다.
    cy.get(".aia-attention-bubble").click();
    cy.get(".aia-attention-bubble").should("not.exist");
    cy.get(".aia-attention-label").should("be.visible");
    cy.wait("@attention");
    cy.wait("@attention");
    cy.get(".aia-attention-bubble").should("not.exist");
    cy.get(".aia-attention-label").should("be.visible");
    // 트리거 강조는 알림이 남아 있는 동안 유지된다.
    cy.anchor("topbar.aia").should("have.class", "attention");

    // 3) 다음 알림이 오면 닫은 기억은 그 알림에만 묶여 있으므로 다시 뜬다.
    cy.then(() => { current = SECOND; });
    cy.get(".aia-attention-bubble").should("be.visible");
    cy.get(".aia-attention-bubble-request").should("have.text", NEXT_REQUEST);
    // 상한 안쪽이므로 자르지 않는다.
    cy.get(".aia-attention-bubble-response").should("have.text", NEXT_RESPONSE);
  });
});
