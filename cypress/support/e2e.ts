/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// Cypress가 스펙마다 먼저 읽는 지원 파일(cypress.config.ts의 `supportFile`). 한 파일에 하네스
// 훅과 화면·언어·폴더·스텁 명령이 모두 쌓여 있어, 명령 하나를 찾을 때마다 스크롤을 훑어야 했다.
// 지금은 결이 다른 갈래마다 모듈을 두고 여기서 불러 들이기만 한다 — 이 파일을 읽는 순서가
// 곧 하네스가 세우는 순서다. 명령의 타입 선언은 계속 `index.d.ts` 한 곳에 모여 있다.
//
// 앞쪽 둘은 화면을 가리지 않는 바탕(하네스 훅, 앵커·방문·화면 전환)이고, 뒤쪽은 화면 하나씩
// 맡는 모듈이다. 화면 모듈은 바탕의 `openView`·`anchor` 위에만 서고 서로를 부르지 않는다 —
// 예외는 데이터베이스 탭이 애드온 화면 안에 있어 `openAddonsView`를 쓰는 것 하나뿐이다.
import "./harnessHooks";
import "./appCommands";
import "./addonsCommands";
import "./projectsCommands";
import "./dbConnectionCommands";
import "./sshKeyCommands";
import "./pacingCommands";
import "./instructionCommands";
import "./scheduleCommands";
import "./workflowCommands";
import "./languageCommands";
import "./sessionFolderCommands";
import "./stubCommands";

// 저장값 씨앗을 심는 스펙들이 `../support/e2e`에서 가져가는 키다. 정의는 appCommands가 갖는다.
export { NAVIGATION_PREFERENCES_KEY } from "./appCommands";
