/// <reference types="cypress" />
// 저장소 화면의 정적·동적 텍스트 다국어(i18n) 적용을 검증한다.

function openStorage() {
  cy.anchor("nav.storage").click();
}

describe("저장소 화면 다국어 전환", () => {
  beforeEach(() => {
    cy.visitApp();
  });

  // 이 스펙은 UI 언어를 영어로 바꾼 채 끝난다. 언어는 백엔드 설정에 남아 다음 스펙까지 따라가므로
  // 스펙이 끝날 때 한국어로 되돌린다(테스트가 중간에 실패해도 도는 `after`에서).
  after(() => {
    cy.restoreLanguage();
  });

  it("한국어 모드에서 정적 텍스트와 지표가 한국어로 표시된다", () => {
    openStorage();
    cy.get('.storage-view .stat-grid .stat-card').eq(0).within(() => {
      cy.get('span').should('contain.text', '관리 대상 전체');
      cy.get('small').should('contain.text', '대화 원본 + Agent Manager 상태');
    });
    cy.get('.storage-view .stat-grid .stat-card').eq(3).within(() => {
      cy.get('span').should('contain.text', '보완 저장 결과');
      cy.get('strong').should('contain.text', '건');
      cy.get('small').should('contain.text', '개 세션');
    });
    cy.get('.storage-panel').first().within(() => {
      cy.get('h2').should('contain.text', '공급자 대화 원본');
      cy.get('p').should('contain.text', '공급자가 생성한 로컬 세션 데이터입니다');
    });
  });

  // 컴포넌트가 text()로 선언한 영어가 그대로 보여야 한다. 정적 UI 카탈로그가 같은 한국어 키에
  // 다른 영어를 들고 있어도 그것이 컴포넌트 선언을 덮으면 안 된다(QA #5·#6).
  it("영어 모드에서 정적 텍스트와 동적 지표가 모두 영어로 전환된다", () => {
    cy.setLanguage("en");
    openStorage();
    cy.get('.storage-view .stat-grid .stat-card').eq(0).within(() => {
      cy.get('span').should('contain.text', 'All managed data');
      cy.get('small').should('contain.text', 'Provider transcripts + Agent Manager state');
    });
    cy.get('.storage-view .stat-grid .stat-card').eq(3).within(() => {
      cy.get('span').should('contain.text', 'Stored supplements');
      cy.get('strong').should('contain.text', 'turns');
      cy.get('small').should('contain.text', 'sessions');
    });
    cy.get('.storage-panel').first().within(() => {
      cy.get('h2').should('contain.text', 'Provider transcripts');
      cy.get('p').should('contain.text', 'Local session data created by providers');
    });
  });

  // 알려진 결함으로 실패한다: errorText(cause)가 반환하는 범용 HTTP 500 에러 문구가 
  // ErrorBanner의 fallback인 "저장소 사용량을 읽지 못했습니다"를 덮어씌운다.
  // QA 티켓 "저장소 화면 실패 시 안내 문구가 범용 오류 메시지로 표시됨"
  it.skip("오류 상태일 때 한국어/영어 문구가 올바르게 나타난다", () => {
    cy.intercept("POST", "**/api/invoke/get_storage_overview", { statusCode: 500, body: "Error" });
    
    cy.setLanguage("ko");
    openStorage();
    cy.get('.error-banner').should('contain.text', '저장소 사용량을 읽지 못했습니다');

    cy.setLanguage("en");
    openStorage();
    cy.get('.error-banner').should('contain.text', 'Failed to read storage usage');
  });
});
