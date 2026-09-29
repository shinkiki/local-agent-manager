# E2E 테스트와 Cypress 자동화

## 1. `npm run test:e2e`

앱 자체의 Cypress E2E 스위트를 격리 백엔드 위에서 돌린다.

```sh
npm run test:e2e                          # 전체 스펙, headless electron
npm run test:e2e -- --spec cypress/e2e/shell.cy.ts
npm run test:e2e -- --summary /tmp/e2e.json   # 결과 JSON + 스크린샷 보존
npm run test:e2e:open                     # Cypress 런너 UI(같은 격리 백엔드)
```

옵션: `--port <n>`(기본 54999), `--server-bin <path>`(기본 `target/debug/agent-manager-server`, 없으면 `cargo build -q -p agent-manager-server`), `--static-dir <dir>`(기본 `dist`, `dist/index.html`이 없으면 `npm run build`), `--timeout-ms`(기본 8분).

### 하네스 동작(`scripts/e2e.mjs`)

- **격리 백엔드**: 운영 백엔드(127.0.0.1:4178)는 건드리지 않는다. `agent-manager-server --port <port> --static-dir <임시>/static --app-data-dir <임시> --shutdown-on-stdin-eof`를 별도 프로세스 그룹으로 띄우고, `GET /api/access`가 `writable: true`를 돌려줄 때까지(250ms 간격, 최대 20초) 기다린다.
- **정적 자원 스냅샷**: `--static-dir`(기본 `dist`)은 그대로 서빙하지 않고 회차 임시 디렉터리 아래 `static/`으로 복사해 그것을 서빙한다. 백엔드는 요청마다 `index.html`을 디스크에서 다시 읽으므로, 같은 워킹트리에서 다른 세션이 `npm run build`(`vite build --emptyOutDir`)로 `dist`를 비우는 순간 루트 문서가 HTTP 500(`정적 파일을 읽지 못했습니다: No such file or directory`)으로 떨어져 `cy.visit`가 간헐적으로 실패했다(qa41). 병렬 회차는 여기에 더해 `npx vite build --outDir /tmp/<회차별>`로 각자 다른 출력 폴더를 쓰는 편이 안전하다.
- **임시 HOME**: 백엔드 자식 프로세스에만 `HOME=<임시 디렉터리>`를 주고 `CLAUDE_SECURESTORAGE_CONFIG_DIR`·`CLAUDE_CONFIG_DIR`·`CODEX_HOME`·`CODEX_SQLITE_HOME`을 지운다. 그래서 CLI 연결·계정·시스템 에이전트가 모두 비어 있는 상태로 시작한다. 이 상태의 `topbar.aia`는 **비활성이 아니다** — `aria-disabled`를 달지 않고, 누르면 설정 → 연결의 시스템 에이전트 자리로 데려간다(`aria-pressed`는 `false` 유지). 시스템 에이전트가 없다는 사유는 그 버튼의 `aria-label`·`title`로 확인한다. Cypress 자체는 사용자 `~/Library/Caches/Cypress`의 바이너리를 쓰므로 하네스 프로세스의 HOME은 바꾸지 않는다.
- **훅 플래그**: `cy.visitApp()`이 `localStorage["agent-manager.e2e-hooks"] = "1"`을 켠 채 앱을 연다. `src/App.tsx`는 이 플래그가 켜진 화면에서만 `window.__agentManagerE2E = { showUiGuide, answerAiaUiQuery, performAiaUiClick }`를 노출한다(`src/lib/e2eHooks.ts`). 같은 origin 스크립트는 이미 DOM 전권이므로 새 권한이 아니라 테스트 편의 경로다. `cy.e2e()`로 접근한다.
- **서비스워커**: `public/sw.js`는 `http://127.0.0.1`도 secure context라 등록된다. 지원 파일(`cypress/support/e2e.ts`)이 매 테스트 전에 등록을 해제하고 `caches`를 모두 비운다.
- **정리**: 백엔드 stdin을 닫아 종료시키고 2초 안에 안 죽으면 프로세스 그룹에 SIGTERM. 전체 제한 시간을 넘기면 Cypress 자손 프로세스까지 SIGKILL. 임시 디렉터리는 삭제하되 `--summary`를 준 경우 스크린샷 폴더는 남긴다. 실패가 하나라도 있으면 exit 1.
- **요약 JSON**(`--summary`): `{ totalPassed, totalFailed, totalPending, totalDuration, runs: [{ spec, tests: [{ title, state, error }], screenshots: [path] }] }`.

커스텀 커맨드: `cy.anchor(id)` = `cy.get('[data-ui-anchor="<id>"]')`(AIA 화면 안내 앵커와 같은 이름), `cy.visitApp()`, `cy.e2e()`, `cy.view(id)` = 열려 있는 `[data-view="<id>"]`, `cy.openView(id)` = `nav.<id>`를 눌러 그 화면을 열고 열린 화면을 넘김, `cy.openSettingsTab(tabId)` = 설정 화면을 열고 `settings.tab.<tabId>`를 눌러 활성화, `cy.stubInvoke(command, response?)` = `POST **/api/invoke/<command>` 가로채기.

## 2. Cypress 자동화 작업공간

애드온 → **Cypress** 탭에서 에이전트와 사람이 쓰는 Cypress 작업공간을 관리한다. 기본
작업공간은 없으며, 파일 작성과 실행마다 등록된 작업공간을 명시적으로 선택한다.

### 작업공간

| 실행 방식 | 용도 | 생명주기 |
| --- | --- | --- |
| 표준 실행 | 외부 사이트 또는 프로젝트 자체 개발 서버 QA | 등록한 Cypress 설정과 대상 URL을 그대로 사용 |
| 격리 실행 | 대상 앱을 임시 상태로 띄웠다 지우는 QA(Agent Manager 자체 QA가 그 사례) | 그 프로젝트의 `scripts/e2e.mjs` 하네스가 임시 포트·임시 상태·준비 대기·정리를 관리 |

`작업공간 추가`에서 Cypress 프로젝트 폴더를 등록한다. 스펙·설정이 있는 **폴더**와
`cypress` 패키지가 설치된 **모듈 위치**를 따로 잡을 수 있다. 새 작업공간은 표준 실행으로
시작하며, 아래 하네스 규약을 구현한 프로젝트만 실행 방식을 `격리 실행`으로 바꾼다.

#### 격리 하네스 규약

격리는 앱 종류가 아니라 **생명주기**로 성립한다. 임시 포트로 대상 앱을 띄우고, 상태를 임시본으로
갈아끼우고, 준비를 기다리고, 끝나면 확실히 죽이고 지우는 일은 앱마다 달라 프로젝트만 할 수 있다.
그래서 백엔드는 작업공간 루트의 고정 경로 하나만 부르고 나머지는 그 스크립트에 맡긴다.

- 위치: `<작업공간 루트>/scripts/e2e.mjs`. 심링크가 아닌 일반 파일이어야 하고 루트를 벗어날 수 없다.
- 호출: `node scripts/e2e.mjs --job-stdin`. 인자·환경변수로는 아무것도 넘기지 않는다(C7-3).
- 잡(stdin JSON): `{ spec, summaryPath, screenshotsDir, port, timeoutMs, env, headed, video }`.
  `spec`이 `null`이면 전체 실행이다.
- 책임: `port`로 대상 앱을 띄우고(운영 인스턴스를 쓰지 않는다), 상태 저장 위치를 임시본으로 바꾸고,
  준비될 때까지 기다린 뒤 Cypress를 돌리고, 스크린샷을 `screenshotsDir`에, 요약을 `summaryPath`에
  남기고, 프로세스와 임시 디렉터리를 정리한다.
- 요약 형식은 아래 `--summary`와 같다: `{ totalPassed, totalFailed, totalPending, totalDuration, runs }`.
- 하네스가 없으면 실행을 거절한다. 표준 실행으로 돌리거나 하네스를 추가한다.
- 격리 실행에는 `configFile`을 지정할 수 없고(하네스가 설정을 직접 만든다) 런처로도 열 수 없다.

정적 SPA처럼 서버 상태가 없는 앱은 임시 포트로 정적 서빙만 하면 되고, 로컬 백엔드가 있는 앱은
그 백엔드가 데이터 저장 위치를 인자로 받을 수 있어야 격리가 성립한다. 공유 DB나 원격 개발서버에
붙는 앱은 포트를 바꿔도 상태가 공유되므로 표준 실행이 맞다.

이전 버전의 앱 데이터 기본 작업공간은 등록부에서 제거하고, 기존 스펙은
`<앱 데이터>/cypress-workspace-trash/default-*`로 옮겨 수동 복구할 수 있게 보존한다.

### 런처로 단계별 진행

헤드리스 실행은 스펙을 끝까지 돌리고 결과만 돌려준다. 한 커맨드씩 끊어 보려면 실행 구역의
**런처 열기**를 누른다. Cypress 런처(`cypress open`)가 뜨고, 거기서 스펙을 고르고
`cy.pause()`에서 멈춰 가며 `next`로 진행한다. `창 띄우고 실행`을 켠 헤드리스 실행으로는 이게
안 된다 — `cypress run`은 `cy.pause()`를 무시하고 끝까지 달린다.

- 화면에 고른 스펙은 런처 잡에 실리지 않는다. 스펙 고르기는 런처 안에서 한다. 추가 env는 그대로 넘어간다.
- 창은 앱이 떠 있는 **호스트 화면에** 뜬다. 원격 화면에서도 열 수 있지만 그 창은 보이지 않으므로, 실행 구역의 **중지**로 끊는다.
- 격리 실행도 런처로 연다. 하네스가 임시 포트·앱 데이터·HOME으로 앱을 띄운 채 런처를 열고, 창을 닫으면 같은 정리 경로를 탄다.
- 창을 닫을 때까지 실행이 `running`으로 남고, 닫거나 중지하면 `closed`로 끝난다(통과·실패 판정이 없다).
  그동안 같은 작업공간의 다른 실행은 막힌다. 상한은 8시간이다.
- 영상 저장은 런처에 적용되지 않는다. 스크린샷은 실행 폴더에 그대로 모인다.
- AIA·에이전트에게는 열려 있지 않다. 사람이 눌러 여는 갈래다.

### `cypress.env.json`

- 작업공간 루트의 `cypress.env.json`에 로그인 계정 등 비밀값을 둔다. 앱이 쓰는 파일은 권한 0600으로 만든다.
- AIA와 원격 화면에는 **키 이름만** 보이고 값은 절대 내려가지 않는다. 스펙 안에서는 `Cypress.env("키")`로 읽는다.

### 결과 규약

- 실행마다 `Cypress.env("amRunDir")`에 실행 전용 디렉터리가 들어온다.
- `cy.saveResult("result.json", data)`는 `cy.writeFile(Cypress.env("amRunDir") + "/result.json", data)`와 같다. 구조화된 결과는 이 파일로 남긴다.
- 스크린샷은 평범하게 `cy.screenshot()`. 하네스가 `screenshotsFolder`를 실행 디렉터리로 돌려 놓는다.
- 산출물은 `artifacts/runs/<jobId>/` 아래에 모이고 산출물 화면에서 열 수 있다.

### KB 예시

- 외부 작업공간 폴더: `…/kbfps-hrm/context/cypress`
- Cypress 모듈 위치: `…/kbfps-hrm/ustra-hr-system-thymeleaf`
- Cypress 10 고정. `experimentalSessionAndOrigin`을 켜 두어야 로그인 세션 재사용이 된다(11 이상에서는 이 플래그가 없어 설정이 깨진다).

## 3. 일반 에이전트 세션에서 `npx cypress run`

AIA가 아닌 일반 채팅 세션(Claude·Codex·Antigravity)에서 스펙을 직접 돌릴 수 있는지는 실행설정에 따라 다르다.

| 공급자 · 실행설정 | 가능 여부 | 비고 |
| --- | --- | --- |
| Claude `workspace`(acceptEdits) | 가능 | Bash 호출마다 승인이 뜬다 |
| Claude `fullAccess` | 가능 | 승인 없음 |
| Codex `workspace` | 실패 | 샌드박스 `network_access=false`라 Cypress 바이너리·브라우저가 뜨지 못한다. `onFailure` 승인 정책이면 승인 뒤 재실행된다 |
| Codex `fullAccess` | 가능 | |
| Antigravity `accept-edits` | 가능 | 승인은 CLI 내부에서 처리 |
| AIA(Codex) | 불가 | 대신 `run_cypress_spec` 도구를 쓴다(작업공간·결과 규약은 2절) |

권고:

- 매번 `npx`로 풀지 말고 캐시된 `node_modules/.bin/cypress`를 직접 호출한다.
- `--browser electron`(브라우저 설치 불필요), `--reporter dot`(출력이 짧아 컨텍스트를 아낀다).
- 무인 실행(예약·백그라운드)은 승인 요청이 자동 거절되므로 `fullAccess` 실행설정이 필요하다.
