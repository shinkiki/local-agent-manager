/* Agent Manager 원격 웹 서비스워커: 앱 셸 캐싱 담당.
 * /api/ 아래(WebSocket 업그레이드 포함)는 절대 가로채지 않는다. */
const CACHE_NAME = "agent-manager-shell-v2";
const SHELL_URLS = ["/", "/manifest.webmanifest", "/icon.svg"];
/** 자산 404를 만났을 때 창에 보내는 알림. `src/lib/appReload.ts`와 같은 값이어야 한다. */
const STALE_SHELL_MESSAGE = "agent-manager.stale-shell";
/** 느린 터널·재기동 중인 백엔드에서 웹뷰 기본 오류 페이지가 뜨기 전에 캐시로 넘어갈 시간. */
const NAVIGATION_TIMEOUT_MS = 8_000;

self.addEventListener("install", (event) => {
  // 셸 항목 하나가 실패해도 설치는 계속한다. 설치가 실패하면 다음 오프라인
  // 접속에서 캐시된 셸이 없어 웹뷰 기본 오류 페이지가 뜬다.
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(SHELL_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        const existing = windows.find((client) => "focus" in client);
        if (existing) return existing.focus();
        return self.clients.openWindow("/");
      }),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    // Vite가 해시를 붙여 내보내는 불변 파일: 캐시 우선
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(request));
});

/* 앱 셸 탐색은 실패해도 웹뷰 기본 오류 페이지로 넘어가지 않게 한다.
 * 서버 재기동·터널 끊김(502/503/504)이나 응답 지연도 네트워크 실패로 취급해
 * 캐시된 셸, 없으면 자체 재시도 화면을 돌려준다. */
async function networkFirstNavigation(request) {
  try {
    const response = await fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put("/", response.clone());
      return response;
    }
    if (response.status < 500) return response;
  } catch {
    // 아래 대체 경로로 진행한다.
  }
  const cached = await caches.match("/");
  if (cached) return cached;
  return offlineShellResponse();
}

async function fetchWithTimeout(request, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function offlineShellResponse() {
  const body = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Agent Manager</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif;
    background: Canvas; color: CanvasText; }
  main { max-width: 22rem; text-align: center; }
  h1 { font-size: 1.05rem; margin: 0 0 8px; }
  p { margin: 0 0 16px; opacity: 0.75; }
  button { font: inherit; padding: 10px 18px; border-radius: 10px; border: 1px solid currentColor;
    background: transparent; color: inherit; }
</style></head>
<body><main role="alert">
<h1>서버에 연결하지 못했습니다</h1>
<p>Agent Manager 서버가 재기동 중이거나 네트워크가 끊겼습니다. 연결되면 자동으로 다시 시도합니다.</p>
<button type="button" onclick="location.reload()">다시 시도</button>
</main>
<script>
  setTimeout(function () { location.reload(); }, 5000);
  addEventListener("online", function () { location.reload(); });
</script>
</body></html>`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  if (response.ok) {
    cache.put(request, response.clone());
  } else if (response.status === 404) {
    // 재배포로 사라진 해시 자산을 요청했다는 뜻이므로 오래된 앱 셸을 버린다.
    // 그대로 두면 다음 탐색에서도 같은 셸이 나와 계속 깨진 화면을 본다.
    await cache.delete("/");
    // 셸만 버리면 이미 열려 있는 화면은 그대로 깨져 있다. 창에 알려 새 셸을 받게 한다.
    await notifyStaleShell();
  }
  return response;
}

async function notifyStaleShell() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) client.postMessage({ type: STALE_SHELL_MESSAGE });
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}
