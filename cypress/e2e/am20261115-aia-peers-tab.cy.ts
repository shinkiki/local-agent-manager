/// <reference types="cypress" />
// 애드온 → AIA 대화 탭(`AiaPeersCard.tsx`, C23)의 세 자리를 본다.
//
// 1) 새 탭이 서고, 격리 백엔드에는 피어가 없고 기능은 꺼져 있다(C23-1 기본 닫힘).
// 2) 평문 http 주소는 저장 전에 백엔드가 거절하고 그 이유가 화면에 선다 — 이 거절은
//    저장소에 닿기 전에 끝나므로 격리 백엔드에서도 돈다.
// 3) 연결 확인 영수증이 상대 기기 이름과 켜짐 여부를 보이고, 교환 목록이 답을 접어 보인다.
//    격리 백엔드에는 상대 기기가 없으므로 목록·확인·교환 응답은 가로챈다.
const PEER = {
  id: "peer-ab12cd34ef56",
  name: "NAS",
  url: "https://nas.tail1234.ts.net",
  agentEnabled: true,
  note: "집",
  updatedAt: 1,
  skillsChanged: true,
};

const SNAPSHOT = {
  schemaVersion: 1,
  policy: { enabled: true, allowLocal: false, maxDepth: 2, maxConcurrent: 1, timeoutMs: 600000, deviceName: "" },
  device: { id: "11111111-2222-3333-4444-555555555555", name: "pc" },
  inboundReady: true,
  peers: [PEER],
  issues: [],
  defaults: { maxDepthMin: 1, maxDepthMax: 4, maxConcurrentMin: 1, maxConcurrentMax: 8, timeoutMsMin: 60000, timeoutMsMax: 1800000 },
};

const EXCHANGE = {
  id: "xchg-0123456789ab",
  direction: "outbound",
  state: "completed",
  peerId: PEER.id,
  peerName: PEER.name,
  device: { id: "66666666-7777-8888-9999-000000000000", name: "NAS" },
  chain: ["11111111-2222-3333-4444-555555555555#-"],
  hop: 1,
  questionPreview: "디스크 남은 용량 알려줘",
  questionDigest: "abc",
  questionChars: 12,
  answer: "NAS 볼륨1 남은 용량은 1.2TB 입니다.",
  truncated: false,
  error: null,
  chatId: null,
  remoteExchangeId: "xchg-remote",
  startedAt: Date.now() - 60000,
  finishedAt: Date.now(),
  skillsRevision: "r2",
  untrusted: true,
};

describe("AIA 대화 애드온 탭", () => {
  it("탭이 서고, 기본은 꺼져 있으며, 평문 http 주소는 저장 전에 거절된다", () => {
    cy.visitApp();
    cy.openAddonsView("peers");
    cy.anchor("addons.peers-content").should("be.visible");
    cy.anchor("addons.peers.policy").find('[role="switch"]').should("have.attr", "aria-checked", "false");
    cy.get('[data-ui-anchor="addons.peers-content"] .plugin-empty-state').should("contain.text", "등록된 피어가 없습니다");

    cy.anchor("addons.peers.add").click();
    cy.anchor("addons.peers.editor").should("be.visible");
    cy.anchor("addons.peers.editor").find("input").first().type("NAS");
    cy.anchor("addons.peers.editor").find("input").eq(1).type("http://nas.tail1234.ts.net");
    cy.contains('[data-ui-anchor="addons.peers.editor"] button', "저장").should("be.enabled").click();

    cy.get('[data-ui-anchor="addons.peers-content"]').should("contain.text", "평문 http");
    cy.get('[data-ui-anchor="addons.peers-content"] .plugin-empty-state').should("exist");
  });

  it("연결 확인 영수증과 교환 목록이 보인다", () => {
    cy.stubInvoke("get_aia_peers", { statusCode: 200, body: SNAPSHOT });
    cy.stubInvoke("list_aia_peer_exchanges", { statusCode: 200, body: [EXCHANGE] });
    cy.stubInvoke("check_aia_peer", {
      statusCode: 200,
      body: {
        id: PEER.id,
        url: PEER.url,
        reachable: true,
        device: { id: "66666666-7777-8888-9999-000000000000", name: "NAS" },
        enabled: true,
        protocolVersion: 1,
        skillsRevision: "r2",
        message: "NAS에 연결했습니다. 홉 상한 2, 응답 대기 600초",
      },
    }).as("check");
    cy.visitApp();
    cy.openAddonsView("peers");
    cy.anchor("addons.peers.policy").find('[role="switch"]').should("have.attr", "aria-checked", "true");
    cy.get('[data-peer-id="peer-ab12cd34ef56"]').should("contain.text", "NAS").and("contain.text", "스킬 변경 있음");
    cy.contains('[data-peer-id="peer-ab12cd34ef56"] button', "연결 확인").click();
    cy.wait("@check");
    cy.get('[data-peer-id="peer-ab12cd34ef56"] .db-connection-receipt.ok')
      .should("contain.text", "NAS에 연결했습니다")
      .and("contain.text", "v1");

    cy.anchor("addons.peers.exchanges").should("contain.text", "디스크 남은 용량").and("contain.text", "완료");
    cy.contains('[data-ui-anchor="addons.peers.exchanges"] button', "답 보기").click();
    cy.get('[data-ui-anchor="addons.peers.exchanges"] .aia-peer-answer').should("contain.text", "1.2TB");
  });
});
