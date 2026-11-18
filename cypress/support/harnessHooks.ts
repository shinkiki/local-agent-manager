/// <reference types="cypress" />
/// <reference path="./index.d.ts" />

// 하네스 백엔드는 http://127.0.0.1 이라 secure context로 잡혀 public/sw.js가 등록된다.
// 셸 캐시가 이전 테스트의 화면을 되돌려 주지 않도록 매 테스트 전에 서비스워커와 캐시를 비운다.
async function clearServiceWorkersAndCaches(): Promise<void> {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ("caches" in window) {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  }
}

beforeEach(() => {
  // 스펙 프레임은 baseUrl과 같은 origin이므로 여기서 지운 등록·캐시가 앱 프레임에도 적용된다.
  cy.wrap(clearServiceWorkersAndCaches(), { log: false });
});

/**
 * 격리 백엔드는 스펙 파일 사이에 살아 있어 한 스펙이 만든 세션 폴더가 다음 스펙의 개수·경계 단정
 * (폴더 0개, 첫째·마지막 폴더)을 깨뜨린다. 스펙 파일마다 끝에서 남은 폴더를 모두 지운다 — 격리 환경에는
 * 세션이 없어 폴더 삭제로 잃는 것이 없다. cy.request는 cy.intercept 스텁을 지나지 않으므로 실제 백엔드에 닿는다.
 *
 * **그래서 격리 백엔드인지 먼저 확인한다.** baseUrl만 사용자의 백엔드로 바꿔 스펙을 돌리면
 * (진단·재현용으로 실제 앱에 붙이는 일이 있다) 이 훅이 사용자가 분류해 둔 세션 폴더를 전부 지우고,
 * `delete_session_folder`는 폴더뿐 아니라 모든 세션의 소속까지 함께 지워 되돌릴 수 없다.
 * 판별은 두 겹이다 — 앱 서비스 포트(기본·구버전)에는 절대 손대지 않고, 세션이 하나라도 색인된
 * 백엔드는 격리 환경이 아니므로 건너뛴다. 건너뛸 때는 이유를 로그로 남긴다.
 */
const APP_SERVICE_PORTS = new Set(["54178", "4178"]);

function isolatedHarnessBackend(sessionCount: number): { ok: boolean; reason?: string } {
  const port = (() => {
    try { return new URL(Cypress.config("baseUrl") ?? "").port; } catch { return ""; }
  })();
  if (APP_SERVICE_PORTS.has(port)) return { ok: false, reason: `앱 서비스 포트(${port})에 붙어 있습니다` };
  if (sessionCount > 0) return { ok: false, reason: `세션 ${sessionCount}건이 색인된 백엔드입니다` };
  return { ok: true };
}

after(() => {
  cy.request({ method: "POST", url: "/api/invoke/get_manager_snapshot", body: {}, failOnStatusCode: false, log: false }).then((response) => {
    const folders: Array<{ id: string }> = Array.isArray(response.body?.folders) ? response.body.folders : [];
    const sessions: unknown[] = Array.isArray(response.body?.sessions) ? response.body.sessions : [];
    if (folders.length === 0) return;
    const harness = isolatedHarnessBackend(sessions.length);
    if (!harness.ok) {
      cy.log(`세션 폴더 정리를 건너뜁니다 — ${harness.reason}`);
      return;
    }
    for (const folder of folders) {
      cy.request({ method: "POST", url: "/api/invoke/delete_session_folder", body: { id: folder.id }, failOnStatusCode: false, log: false });
    }
  });
});
