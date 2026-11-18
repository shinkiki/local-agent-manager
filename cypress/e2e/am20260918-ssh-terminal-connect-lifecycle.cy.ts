/// <reference types="cypress" />
// 원격접근: 설정 → 애드온 → SSH → 연결 서버 → 서버 줄 [터미널] → 접속.
//
// AM-364(am20260916-ssh-key-install-branch)는 같은 창을 열기만 하고 "접속은 누르지
// 않는다"고 스스로 범위를 그었고, AM-37·AM-247 등 다른 SSH 시나리오도 키 생성·연결 서버
// 편집·연결 확인 영수증까지다. 그래서 TerminalSurface의 접속 수명주기 — 연결 대기 →
// 연결 중 → 끝난 상태 → 다시 접속 — 를 화면에서 본 회차가 없다.
//
// 2026-09-18(c9a04e5c)이 이 화면의 단계 판정을 손으로 적던 네 덩어리에서 문자열 열거형
// 매크로 한 벌로 모았다(src/components/TerminalPanel.tsx:594 matchesStopped, :598
// isFinished, :602 phaseLabel). 그 셋이 어긋나면 종료된 터미널에 종료 버튼이 남거나
// 접속 버튼이 사라져 창을 닫았다 다시 여는 것 말고는 되살릴 길이 없어진다.
//
// 닿지 않는 포트(127.0.0.1:1)로 붙는다. 진짜 원격 서버를 쓰지 않으면서 ssh가 스스로
// 끝까지 가는 유일한 방법이고, 결과가 성공이든 실패든 "끝난 터미널"의 도구줄 규칙은 같다.
const HOST = "127.0.0.1";
const UNREACHABLE_PORT = "1";

const terminal = () => cy.get(".ssh-key-terminal .terminal-panel");
const statusLabel = (options?: Partial<Cypress.Timeoutable>) =>
  terminal().find(".terminal-toolbar strong", options);
const composerInput = () => terminal().find(".mobile-terminal-composer input");
const terminalBody = (options?: Partial<Cypress.Timeoutable>) =>
  terminal().find(".terminal-host", options);

describe("SSH 터미널 창의 접속 수명주기와 끝난 뒤의 도구줄", () => {
  const base = `am-qa-term-${Date.now()}`;
  const pub = `${base}.pub`;
  const serverName = `qa-term-${Date.now()}`;

  it("열자마자는 연결 대기이고, 접속이 끝나면 '다시 접속'으로 되살릴 수 있다", () => {
    cy.visitApp();
    cy.anchor("nav.sessions").should("be.visible");
    cy.openSshKeysTab();
    cy.createSshKey(base, "ssh-terminal-lifecycle-test");

    // 닿지 않는 포트를 연결 서버로 적어 둔다. 접속은 시작되지만 셸까지는 가지 않는다.
    // 창은 서버 단위로 열린다 — 키 하나를 여러 서버가 함께 쓸 수 있어서다.
    cy.addSshServer({ name: serverName, host: HOST, user: "qauser", port: UNREACHABLE_PORT, keyPublicName: pub });
    cy.sshServerRow(serverName).as("row");

    cy.get("@row").contains("button", /^터미널$/).click();
    terminal().should("be.visible");

    // 1) 아직 아무것도 붙지 않은 창. 상태는 '연결 대기'이고 점도 같은 단계를 가리킨다.
    statusLabel().should("have.text", "연결 대기");
    terminal().find(".terminal-status").should("have.class", "terminal-status-idle");

    // 2) 붙지 않았으니 시작 수단만 있고 종료는 없다. 라벨은 첫 접속 문구다.
    terminal().contains("button", /^접속$/).should("be.visible").and("not.be.disabled");
    terminal().contains("button", /^다시 접속$/).should("not.exist");
    terminal().contains("button", /^종료$/).should("not.exist");

    // 3) 입력줄은 붙기 전에는 잠겨 있다. 안 붙은 창에 친 줄이 조용히 사라지면 안 된다.
    composerInput().should("be.disabled");
    terminal().contains(".mobile-terminal-composer button", "전송").should("be.disabled");

    // 4) 접속을 누른다. ssh는 소켓까지는 붙어 세션이 성립하므로 오류 배너가 아니라
    //    '종료됨'으로 끝난다 — 연결 거절은 ssh 자신이 본문에 적고 255로 빠진다.
    terminal().contains("button", /^접속$/).click();
    statusLabel({ timeout: 20_000 }).should("have.text", "종료됨");
    terminal().find(".terminal-status").should("have.class", "terminal-status-exited");

    // 5) 끝난 터미널의 도구줄. 종료 버튼은 사라지고, 되살릴 수단 하나만 남으며 라벨은
    //    첫 접속이 아니라 '다시 접속'이다. 이 셋이 어긋나면 창을 닫았다 여는 것 말고는
    //    되살릴 길이 없다(matchesStopped·isFinished·phaseLabel, TerminalPanel.tsx:594).
    terminal().contains("button", /^종료$/).should("not.exist");
    terminal().find(".terminal-toolbar button").should("have.length", 1);
    terminal().contains("button", /^다시 접속$/).should("be.visible").and("not.be.disabled");

    // 6) 붙지 못했으므로 입력줄은 여전히 잠겨 있다.
    composerInput().should("be.disabled");

    // 7) 끝난 사유는 본문에 남는다. ssh가 적은 거절 줄과 화면이 붙인 종료 줄 둘 다 있고,
    //    이 갈래는 앱이 잡은 오류가 아니므로 오류 배너는 뜨지 않는다.
    terminalBody().should("contain.text", "Connection refused");
    terminalBody().should("contain.text", "접속 종료");
    terminal().find(".error-banner").should("not.exist");

    // 8) 한 번 끝난 창이 잠겨 버리지 않는다. 같은 버튼으로 두 번째 시도가 돌고 그 결과가
    //    앞 출력을 지우지 않고 같은 버퍼에 쌓인다(재연결 출력이 이어 붙는 창이다).
    terminal().contains("button", /^다시 접속$/).click();
    terminalBody({ timeout: 20_000 }).invoke("text").should((body: string) => {
      expect((body.match(/Connection refused/g) ?? []).length, "두 번째 시도의 출력이 이어 붙는다")
        .to.be.at.least(2);
    });

    // 9) 두 번째 시도도 같은 자리로 되돌아온다.
    statusLabel().should("have.text", "종료됨");
    terminal().find(".terminal-toolbar button").should("have.length", 1).and("not.be.disabled");
    composerInput().should("be.disabled");

    // 10) 창을 닫으면 터미널이 사라지고 서버 줄의 버튼 라벨이 되돌아온다.
    cy.get("@row").contains("button", "터미널 닫기").click();
    cy.get(".ssh-key-terminal").should("not.exist");
    cy.get("@row").contains("button", /^터미널$/).should("be.visible");

    cy.deleteSshServer(serverName);
    cy.deleteSshKey(pub);
  });
});
