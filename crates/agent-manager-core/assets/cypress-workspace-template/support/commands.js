// Agent Manager 자동화 작업공간 공통 커맨드.

// 범용 로그인. 폼 셀렉터와 계정은 스크립트가 넘긴다. 계정 값은 cypress.env.json의 키를
// Cypress.env("키")로 읽어 넘기고, 스크립트 본문에 직접 적지 않는다.
//   cy.loginWith({ path: "/login", userSelector: "#username", passSelector: "#password",
//                  submitSelector: "button[type=submit]", user: Cypress.env("USER"), pass: Cypress.env("PASS") });
Cypress.Commands.add("loginWith", ({ path = "/login", userSelector, passSelector, submitSelector, user, pass, successCheck }) => {
  cy.visit(path);
  cy.get(userSelector).clear().type(user);
  cy.get(passSelector).clear().type(pass, { log: false });
  cy.get(submitSelector).click();
  if (successCheck) successCheck();
  else cy.url({ timeout: 15000 }).should("not.include", path);
});

// 수집 결과 저장. Agent Manager가 실행마다 넘기는 amRunDir(artifacts/runs/<jobId>) 아래에 쓰면
// 실행 결과 산출물로 회수되어 AIA와 설정 화면이 바로 읽는다. JSON·텍스트는 내용까지 회수된다.
Cypress.Commands.add("saveResult", (name, data) => {
  const dir = Cypress.env("amRunDir") || "artifacts/manual";
  const body = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  cy.writeFile(`${dir}/${name}`, body);
});
