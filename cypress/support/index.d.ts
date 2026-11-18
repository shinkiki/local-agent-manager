import type { RouteHandler } from "cypress/types/net-stubbing";
import type { AgentManagerE2eHooks } from "../../src/lib/e2eHooks";

declare global {
  namespace Cypress {
    interface Chainable {
      /** `[data-ui-anchor="<id>"]` 요소. AIA 화면 안내가 쓰는 앵커와 같은 이름을 쓴다. */
      anchor(id: string): Chainable<JQuery<HTMLElement>>;
      /** E2E 훅 플래그를 켠 채 모든 주 메뉴를 보이게 하여 앱 루트를 연다. `seed`를 주면 앱이 뜨기 전에 localStorage에 함께 심는다(같은 키는 seed가 이긴다). */
      visitApp(seed?: Record<string, string>): Chainable<Cypress.AUTWindow>;
      /** `[data-view="<id>"]` 중 열려 있는 화면. */
      view(id: string): Chainable<JQuery<HTMLElement>>;
      /** `nav.<id>` 내비를 눌러 그 화면을 열고, 열린 화면을 넘긴다. */
      openView(id: string): Chainable<JQuery<HTMLElement>>;
      /** 설정 화면을 열고(`settings.tab.<tabId>`) 탭을 누른 뒤 선택 상태를 넘긴다. */
      openSettingsTab(tabId: string): Chainable<JQuery<HTMLElement>>;
      /** 저장소 화면을 열고(`storage.tab.<tabId>`) 탭을 누른 뒤 선택 상태를 넘긴다. */
      openStorageTab(tabId: string): Chainable<JQuery<HTMLElement>>;
      /** 대시보드를 다녀와 `<id>` 화면을 다시 연다. 떠난 동안 그 화면이 사라진 것도 함께 본다. */
      revisitView(id: string): Chainable<JQuery<HTMLElement>>;
      /** 지침 화면을 열고 모드 탭(`info`·`manage`)을 눌러 눌린 상태를 넘긴다. */
      openInstructionMode(mode: "info" | "manage"): Chainable<JQuery<HTMLElement>>;
      /** 워크플로 화면의 자동화 탭을 열고 온보딩 카드 구획이 그려진 것까지 확인해 넘긴다. */
      openAutomationTab(): Chainable<JQuery<HTMLElement>>;
      /** 워크플로 화면의 페이싱 탭을 열고 사용량 예산 카드가 뜬 것까지 확인해 넘긴다. */
      openPacingTab(): Chainable<JQuery<HTMLElement>>;
      /** 페이싱 요약 카드의 사용 스위치 구획(`workflows.usage-budget.enabled`). 구획 문구를 보는 스펙이 쓴다. */
      pacingControl(): Chainable<JQuery<HTMLElement>>;
      /** 페이싱 사용 스위치. `label`을 주면 그 접근성 이름으로 좁혀 잡는다(다국어 스펙). */
      pacingSwitch(label?: string): Chainable<JQuery<HTMLElement>>;
      /** 워크플로 상세 패널의 액션 버튼(`.workflow-detail-actions .button`)을 이름으로 집는다. */
      workflowAction(label: string): Chainable<JQuery<HTMLElement>>;
      /** 워크플로 상세 패널의 액션 버튼을 화면 안으로 끌어와 누른다. */
      clickWorkflowAction(label: string): Chainable<JQuery<HTMLElement>>;
      /** 워크플로 실행 폼의 `index`번째 입력칸(선언 순서). */
      workflowInput(index: number): Chainable<JQuery<HTMLElement>>;
      /** 목록에서 표시 이름이 `displayName`인 워크플로 카드(`.workflow-card-main`). */
      workflowCard(displayName: string): Chainable<JQuery<HTMLElement>>;
      /** 목록에서 표시 이름이 `displayName`인 워크플로 카드를 눌러 상세를 연다. */
      selectWorkflow(displayName: string): Chainable<JQuery<HTMLElement>>;
      /** 사용량 예산 카드의 '예산 기본값' 모달을 열고 그 모달을 넘긴다. */
      openBudgetDefaultsModal(): Chainable<JQuery<HTMLElement>>;
      /** 열려 있는 예산 기본값 모달에서 `label` 라벨이 감싼 입력칸(input 또는 select). */
      budgetField(label: string): Chainable<JQuery<HTMLElement>>;
      /** 열려 있는 예산 기본값 모달 바닥글의 버튼('저장'·'닫기'). */
      budgetFooterButton(label: string): Chainable<JQuery<HTMLButtonElement>>;
      /** 예산 기본값 모달을 저장하고 모달이 닫힌 것까지 확인한다. */
      saveBudgetDefaults(): Chainable<JQuery<HTMLElement>>;
      /** 페이싱 요약 카드의 스케줄 버튼을 눌러 페이싱 스케줄 모달을 열고 제한 시간대 폼을 넘긴다. 탭 전환은 따로 한다. */
      openPacingScheduleModal(): Chainable<JQuery<HTMLElement>>;
      /** 열려 있는 페이싱 스케줄 모달의 제한 시간대 폼(`.quiet-hours-form`). */
      quietHoursForm(): Chainable<JQuery<HTMLElement>>;
      /** 제한 시간대 사용 스위치(`.app-toggle`). */
      quietHoursToggle(): Chainable<JQuery<HTMLElement>>;
      /** 제한 시간대의 시작·끝 시각 입력칸 둘. */
      quietHoursTimes(): Chainable<JQuery<HTMLInputElement>>;
      /** 요일 고르개 묶음(`.weekday-picker`). 스위치가 꺼지면 이 요소가 disabled가 된다. */
      quietHoursWeekdayPicker(): Chainable<JQuery<HTMLElement>>;
      /** 요일 고르개 안의 체크박스 일곱(월~일 순). */
      quietHoursWeekdays(): Chainable<JQuery<HTMLInputElement>>;
      /** 제한 시간대 폼의 저장 버튼. 잠김 여부를 보는 자리가 많아 누르기까지 묶지 않는다. */
      quietHoursSave(): Chainable<JQuery<HTMLButtonElement>>;
      /** `POST /api/invoke/<command>` 응답을 세운다. 응답을 빼면 가로채기만 건다. */
      stubInvoke(command: string, response?: RouteHandler): Chainable<null>;
      /** App이 window에 설치한 E2E 훅. 설치될 때까지 재시도한다. */
      e2e(): Chainable<AgentManagerE2eHooks>;
      /** `get_manager_snapshot` 응답의 최상위 필드 하나만 갈아 끼운다. 나머지 응답은 실제 백엔드 것을 그대로 쓴다. 함수를 주면 요청마다 다시 읽는다. */
      stubSnapshotField(field: string, value: unknown): Chainable<null>;
      /** 설정 → 언어 탭의 UI 언어 select. 선택자는 언어를 타지 않는 클래스만 쓴다. */
      languageSelect(): Chainable<JQuery<HTMLSelectElement>>;
      /** 언어 탭을 연 뒤 UI 언어를 `value`로 고른다. */
      setLanguage(value: string): Chainable<JQuery<HTMLSelectElement>>;
      /** 애드온 화면의 탭을 누르고 그 탭의 패널이 뜬 것까지 확인해 넘긴다. 화면 열기는 따로 한다. */
      openAddonsTab(tab: string): Chainable<JQuery<HTMLElement>>;
      /** 애드온 화면을 연 뒤 `tab` 탭까지 연다. 같은 화면 안에서 탭만 옮길 때는 `openAddonsTab`을 쓴다. */
      openAddonsView(tab: string): Chainable<JQuery<HTMLElement>>;
      /** 프로젝트 화면의 탭(`files`·`git`·`settings`)을 누르고 `#projects-panel-<tab>`이 뜬 것까지 확인해 넘긴다. 화면 열기는 따로 한다. */
      openProjectsTab(tab: string): Chainable<JQuery<HTMLElement>>;
      /** 프로젝트 화면을 연 뒤 `tab` 탭까지 연다. 같은 화면 안에서 탭만 옮길 때는 `openProjectsTab`을 쓴다. */
      openProjectsView(tab: string): Chainable<JQuery<HTMLElement>>;
      /** 반복 요청 목록의 '새 반복 요청'을 눌러 편집기를 열고 그 편집기를 넘긴다. */
      newScheduleEditor(): Chainable<JQuery<HTMLElement>>;
      /** 채팅 화면의 반복 요청 탭을 열고 새 반복 요청 편집기까지 연다. */
      openScheduleEditor(): Chainable<JQuery<HTMLElement>>;
      /** UI 언어를 한국어로 되돌린다. 영어로 바꾼 스펙이 `after`에서 부른다. */
      restoreLanguage(): Chainable<JQuery<HTMLElement>>;
      /** 세션 폴더 패널의 '최상위 폴더 추가' 버튼. */
      folderAddButton(): Chainable<JQuery<HTMLElement>>;
      /** 폴더 만들기 폼의 이름 입력칸. */
      folderNameInput(): Chainable<JQuery<HTMLElement>>;
      /** 폴더 만들기 폼의 기본(제출) 버튼. */
      folderSubmitButton(): Chainable<JQuery<HTMLElement>>;
      /** 폴더 패널 머리글의 개수 표시. */
      folderCount(): Chainable<JQuery<HTMLElement>>;
      /** 이름이 `name`인 폴더 행(`.folder-entry`). */
      folderEntry(name: string): Chainable<JQuery<HTMLElement>>;
      /** 최상위 폴더를 하나 만들고 그 행이 뜬 것까지 확인해 넘긴다. */
      createFolder(name: string): Chainable<JQuery<HTMLElement>>;
      /** `name` 폴더의 편집 연필을 눌러 편집 행을 열고 그 행을 넘긴다. */
      openFolderEdit(name: string): Chainable<JQuery<HTMLElement>>;
      /** 열려 있는 편집 행을 닫고 사라진 것을 확인한다. */
      closeFolderEdit(): Chainable<JQuery<HTMLElement>>;
      /** 애드온 화면의 데이터베이스 탭을 열고 카드 준비 완료("연결을 확인하는 중…" 없음)까지 확인한다. */
      openDbConnectionsTab(): Chainable<JQuery<HTMLElement>>;
      /** 데이터베이스 새 연결 편집기를 열고 편집기 요소(`.db-connection-editor`)를 넘긴다. */
      openDbConnectionEditor(): Chainable<JQuery<HTMLElement>>;
      /** 열려 있는 데이터베이스 연결 편집기 안에서 `label` 이름의 라벨 요소를 찾는다. */
      dbConnectionField(label: string): Chainable<JQuery<HTMLLabelElement>>;
      /** 데이터베이스 연결 편집기의 동작 버튼(`.db-connection-editor-actions button`)을 이름으로 찾는다. */
      dbConnectionAction(label: string): Chainable<JQuery<HTMLButtonElement>>;
      /** 애드온 화면의 SSH 탭을 열고 카드 준비 완료("SSH 키를 확인하는 중…" 없음)까지 확인한다. */
      openSshKeysTab(): Chainable<JQuery<HTMLElement>>;
      /** SSH 새 키 생성 폼을 열고 폼 요소(`.ssh-key-form`)를 넘긴다. */
      openSshKeyForm(): Chainable<JQuery<HTMLElement>>;
      /** 목록에서 `publicName` 공개키 파일명의 행(`.ssh-key-list .plugin-row`). */
      sshKeyRow(publicName: string): Chainable<JQuery<HTMLElement>>;
      /** SSH 키 생성 폼을 열고 파일명·설명을 입력해 키를 생성하고 목록에 뜬 것을 확인한다. */
      createSshKey(fileBase: string, comment?: string): Chainable<JQuery<HTMLElement>>;
      /** SSH 공개키 `publicName` 행의 삭제 버튼을 누르고 확인 모달에서 삭제까지 마친다. */
      deleteSshKey(publicName: string): Chainable<JQuery<HTMLElement>>;
      /** 연결 서버 목록에서 `label`(이름, 없으면 사용자@주소:포트)의 행(`.ssh-server-list .plugin-row`). */
      sshServerRow(label: string): Chainable<JQuery<HTMLElement>>;
      /** 열려 있는 연결 서버 폼(`scope` 안)의 인증키 선택 상자에서 `publicName` 키를 고른다. */
      selectSshServerKey(scope: string, publicName: string): Chainable<JQuery<HTMLElement>>;
      /** "서버 추가" 폼을 열어 이름·주소·사용자·포트·인증키를 적고 추가한 뒤 목록 행을 넘긴다. */
      addSshServer(server: { name: string; host: string; user: string; port?: string; keyPublicName: string }): Chainable<JQuery<HTMLElement>>;
      /** 연결 서버 `label` 행의 삭제 버튼을 누르고 확인 모달에서 삭제까지 마친다. */
      deleteSshServer(label: string): Chainable<JQuery<HTMLElement>>;
    }
  }
}

export {};
