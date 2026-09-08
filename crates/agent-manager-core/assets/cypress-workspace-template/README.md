# Agent Manager Cypress 자동화 작업공간

브라우저로 하는 일(웹 테스트, 정보 조회, 크롤링, 매크로)을 Cypress 스크립트로 적어 두고 실행하는 폴더입니다.
설정 → 자동화 탭에서 파일을 편집·실행하고, AIA도 같은 폴더에 스크립트를 쓰고 실행할 수 있습니다.

- `cypress.config.js` — Cypress 설정. 필요하면 `baseUrl` 등을 추가합니다.
- `cypress.env.json` — 로그인 정보 같은 비밀. `Cypress.env("키")`로 읽습니다. 이 파일은 호스트 화면에서만 원문을 볼 수 있고 AIA·원격에는 키 이름만 보입니다.
- `support/commands.js` — 공통 커맨드. `cy.loginWith({...})`, `cy.saveResult(name, data)`.
- `e2e/*.cy.js` — 스크립트. 실행 단위입니다.
- `artifacts/runs/<jobId>/` — 실행마다 생기는 산출물. `cy.saveResult`로 남긴 JSON·텍스트는 결과 화면과 AIA가 내용까지 읽고, 스크린샷은 경로로 회수됩니다.

`node_modules/`(Cypress 모듈)와 `artifacts/`는 편집기 목록에 나오지 않습니다.
