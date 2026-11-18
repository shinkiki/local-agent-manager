import { defineConfig } from "cypress";

// baseUrl·screenshotsFolder는 scripts/e2e.mjs 하네스가 cypress.run({ config })로 주입한다.
export default defineConfig({
  e2e: {
    specPattern: "cypress/e2e/**/*.cy.ts",
    supportFile: "cypress/support/e2e.ts",
    video: false,
    screenshotOnRunFailure: true,
    defaultCommandTimeout: 8000,
  },
  retries: { runMode: 1, openMode: 0 },
  // 이 스위트는 Cypress.env()를 쓰지 않는다. 켜 두면 15.x가 매 실행마다 보안 경고를 찍는다.
  allowCypressEnv: false,
});
