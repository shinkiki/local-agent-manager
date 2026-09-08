// Agent Manager Cypress 자동화 작업공간 설정.
// - 스크립트는 e2e/ 아래 *.cy.js, 공통 커맨드는 support/commands.js.
// - 로그인 정보 같은 비밀은 cypress.env.json에 두고 Cypress.env("키")로 읽는다.
// - 실행마다 Agent Manager가 screenshotsFolder/downloadsFolder를 artifacts/runs/<jobId>/ 아래로 바꿔 넘긴다.
const { defineConfig } = require("cypress");

module.exports = defineConfig({
  e2e: {
    specPattern: "e2e/**/*.cy.{js,ts}",
    supportFile: "support/e2e.js",
    fixturesFolder: false,
    video: false,
    screenshotsFolder: "artifacts/screenshots",
    downloadsFolder: "artifacts/downloads",
    trashAssetsBeforeRuns: false,
    defaultCommandTimeout: 10000,
    pageLoadTimeout: 60000,
    chromeWebSecurity: false,
    setupNodeEvents(on, config) {
      return config;
    },
  },
});
