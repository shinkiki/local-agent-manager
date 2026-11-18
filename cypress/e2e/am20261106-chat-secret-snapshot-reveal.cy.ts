/// <reference types="cypress" />
// C15-1 / V2: synthetic values only; no real secret broker or provider data.
const CHAT = "e2e-secret-snapshot";
const summary = (name: string) => ({ name, purpose: "E2E fixture", source: "user", expiresAt: Date.now() + 3600000 });
const initial = [summary("FIRST"), summary("SECOND")];
const snapshot = (secrets = initial) => ({ chatId: CHAT, secrets, ttlSeconds: 3600 });
const overview = (secrets = initial) => ({
  chats: [{ chatId: CHAT, source: "codex", profile: "standard", cwd: "/tmp/e2e", startedAt: 1, secrets }],
  ttlSeconds: 3600,
});
const eye = (name: string) => cy.get(`.storage-secrets-table button[aria-label="${name} 값 보기"]`);
const revealed = () => cy.get(".storage-secrets-plain");
const show = (name: string) => {
  eye(name).click();
  cy.wait("@readValue");
};
function openSecrets() {
  cy.stubInvoke("list_all_chat_secrets", { body: overview() }).as("listSecrets");
  cy.stubInvoke("list_saved_secrets", { body: { secrets: [] } });
  cy.stubInvoke("read_chat_secret_value", (req) => req.reply({
    body: { chatId: CHAT, name: req.body.name, value: "synthetic-previous" },
  })).as("readValue");
  cy.visitApp();
  // Defer background refreshes without freezing navigation or request timers.
  cy.window().then((win) => {
    const schedule = win.setTimeout.bind(win);
    cy.stub(win, "setTimeout").callsFake((handler, delay, ...args) =>
      schedule(handler, delay === 30_000 ? 3_600_000 : delay, ...args));
  });
  cy.openView("storage");
  cy.anchor("storage.tab.secrets").click();
  cy.wait("@listSecrets");
  eye("FIRST").should("be.visible");
}
function submitEdit() {
  cy.get('button[aria-label="FIRST 수정"]').click();
  cy.get(".storage-secrets-form input[type=password]").type("synthetic-replacement", { log: false });
  cy.get(".storage-secrets-form").submit();
}
describe("C15-1 chat secret snapshot invalidates revealed values", () => {
  beforeEach(openSecrets);
  it("successful edit masks every revealed value and requires a fresh explicit read", () => {
    show("FIRST");
    show("SECOND");
    revealed().should("have.length", 2);
    cy.stubInvoke("set_chat_secret", { body: snapshot() }).as("save");
    submitEdit();
    cy.wait("@save");
    revealed().should("not.exist");
    cy.stubInvoke("read_chat_secret_value", { body: { chatId: CHAT, name: "FIRST", value: "synthetic-replacement" } }).as("readValue");
    show("FIRST");
    revealed().should("have.text", "synthetic-replacement");
  });
  it("removal clears other reveals and a reappearing name stays masked", () => {
    show("FIRST");
    show("SECOND");
    cy.stubInvoke("remove_chat_secret", { body: snapshot([initial[1]]) }).as("remove");
    cy.get('button[aria-label="FIRST 삭제"]').click();
    cy.get('.modal[role="dialog"] .modal-footer button').last().click();
    cy.wait("@remove");
    revealed().should("not.exist");
    cy.get(".storage-secrets-head .storage-secrets-toolbar button").click();
    cy.wait("@listSecrets");
    eye("FIRST").should("have.attr", "aria-pressed", "false");
    revealed().should("not.exist");
  });
  it("a reveal arriving after a successful edit cannot repopulate values", () => {
    let finishRead: (() => void) | undefined;
    cy.get('button[aria-label="FIRST 수정"]').click();
    cy.get(".storage-secrets-form input[type=password]").type("synthetic-replacement", { log: false });
    cy.stubInvoke("read_chat_secret_value", (req) => new Promise<void>((resolve) => {
      finishRead = () => {
        req.reply({ body: { chatId: CHAT, name: "SECOND", value: "synthetic-late" } });
        resolve();
      };
    })).as("lateRead");
    eye("SECOND").click();
    cy.wrap(null).should(() => expect(finishRead).to.be.a("function"));
    cy.stubInvoke("set_chat_secret", { body: snapshot() }).as("save");
    cy.get(".storage-secrets-form").submit();
    cy.wait("@save");
    cy.get(".storage-secrets-form").should("not.exist");
    cy.then(() => finishRead!());
    cy.wait("@lateRead");
    cy.wait(150);
    eye("SECOND").should("have.attr", "aria-pressed", "false");
    revealed().should("not.exist");
  });
  it("failed edit preserves the current explicit reveal", () => {
    show("FIRST");
    cy.stubInvoke("set_chat_secret", { statusCode: 400, body: { message: "synthetic rejection" } }).as("save");
    submitEdit();
    cy.wait("@save");
    cy.get(".storage-secrets-form").should("exist");
    revealed().should("have.text", "synthetic-previous");
  });
});
