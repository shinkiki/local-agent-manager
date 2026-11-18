// C17-4/V2: 값은 합성 응답으로만 만들고 지연 응답의 화면 수명을 검증한다.
const metadata = { name: "DEMO_VALUE", purpose: "Synthetic regression fixture", createdAt: 1, updatedAt: 1, lastUsedAt: null, agentEnabled: true };
const card = () => cy.anchor("storage.saved-secrets");
function openSecrets() {
  cy.stubInvoke("list_saved_secrets", { statusCode: 200, body: { secrets: [metadata] } }).as("savedList");
  cy.stubInvoke("list_all_chat_secrets", { statusCode: 200, body: { chats: [], ttlSeconds: 3600 } });
  cy.visitApp();
  cy.openStorageTab("secrets");
  cy.wait("@savedList");
  card().should("contain", "DEMO_VALUE");
}

describe("C17-4: 저장된 비밀값 읽기의 화면 수명", { retries: 0 }, () => {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    it(`현재 화면에서 요청한 값만 보이고 눈 아이콘으로 지울 수 있다 (${width}px)`, () => {
      cy.viewport(width, height);
      openSecrets();
      cy.stubInvoke("read_saved_secret_value", { statusCode: 200, body: { name: metadata.name, value: "synthetic-current-value" } }).as("readValue");
      card().find(".storage-secrets-eye").click();
      cy.wait("@readValue");
      card().find(".storage-secrets-plain").should("have.text", "synthetic-current-value");
      card().find(".storage-secrets-eye").should("have.attr", "aria-pressed", "true").click();
      card().find(".storage-secrets-plain").should("not.exist");
      card().find(".storage-secrets-eye").should("have.attr", "aria-pressed", "false");
    });

    for (const failed of [false, true]) {
      it(`탭을 떠난 뒤 온 ${failed ? "오류를" : "값을"} 숨겨진 화면에 남기지 않는다 (${width}px)`, () => {
        cy.viewport(width, height);
        openSecrets();
        let release!: () => void;
        let started = false;
        const pending = new Cypress.Promise<void>(resolve => { release = resolve; });
        cy.intercept("POST", "**/api/invoke/read_saved_secret_value", req => {
          started = true;
          return pending.then(() => req.reply(failed
            ? { statusCode: 400, body: { message: "Synthetic stale read failure" } }
            : { statusCode: 200, body: { name: metadata.name, value: "synthetic-stale-value" } }));
        }).as("lateValue");
        card().find(".storage-secrets-eye").click();
        cy.wrap(null).should(() => expect(started).to.eq(true));
        cy.anchor("storage.tab.data").click();
        cy.anchor("storage.tab.data").should("have.class", "active");
        cy.window().then(win => new Cypress.Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve))));
        cy.then(() => release());
        cy.wait("@lateValue");
        // finally의 잠금 해제까지 기다려 응답 처리 전의 빈 DOM으로 통과하지 않게 한다.
        card().find(".storage-secrets-eye").should("not.be.disabled");
        card().find(".storage-secrets-plain").should("not.exist");
        card().find(".error-banner").should("not.exist");
      });
    }

    it(`탭에 돌아와 새 목록을 읽은 뒤에도 이전 값 응답을 버린다 (${width}px)`, () => {
      cy.viewport(width, height);
      openSecrets();
      let release!: () => void;
      let started = false;
      const pending = new Cypress.Promise<void>(resolve => { release = resolve; });
      cy.intercept("POST", "**/api/invoke/read_saved_secret_value", req => {
        started = true;
        return pending.then(() => req.reply({ statusCode: 200, body: { name: metadata.name, value: "synthetic-previous-visit" } }));
      }).as("previousValue");
      card().find(".storage-secrets-eye").click();
      cy.wrap(null).should(() => expect(started).to.eq(true));
      cy.anchor("storage.tab.data").click();
      cy.anchor("storage.tab.secrets").click();
      cy.wait("@savedList");
      cy.then(() => release());
      cy.wait("@previousValue");
      card().find(".storage-secrets-eye").should("not.be.disabled");
      card().find(".storage-secrets-plain").should("not.exist");
      card().find(".storage-secrets-eye").should("have.attr", "aria-pressed", "false").and("not.be.disabled");
    });
  }
});
