import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { STALE_SHELL_MESSAGE, reloadForStaleShell } from "./lib/appReload";
import { applyThemeMode, loadThemeMode } from "./lib/theme";
import { I18nProvider } from "./lib/i18n";
import { hasTauriRuntime, initializeBackendService } from "./lib/ipc";
import { watchKeyboardInset } from "./lib/keyboardInset";
import { errorText } from "./lib/errorText";

applyThemeMode(loadThemeMode());

// 모바일 원격에서 화면 키보드가 바닥의 입력창을 덮지 않도록, 키보드가 가린 높이를 CSS 변수로 흘린다.
watchKeyboardInset();

// 원격 웹(secure context)에서만 PWA 설치를 위해 서비스워커를 등록한다.
// Tauri 웹뷰는 자체 프로토콜이라 등록 대상이 아니다.
if (!hasTauriRuntime() && "serviceWorker" in navigator && window.isSecureContext) {
  // 재배포로 사라진 해시 자산을 옛 셸이 요청하면 서비스워커가 알려 준다. 그 통보를
  // 기다리지 않고 화면이 먼저 깨지는 경우는 ErrorBoundary가 같은 복구를 수행한다.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if ((event.data as { type?: string } | null)?.type === STALE_SHELL_MESSAGE) reloadForStaleShell();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.warn("Failed to register service worker:", error);
    });
  });
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

void initializeBackendService()
  .then(() => {
    root.render(
      <React.StrictMode>
        <I18nProvider><ErrorBoundary label="Agent Manager"><App /></ErrorBoundary></I18nProvider>
      </React.StrictMode>,
    );
  })
  .catch((cause: unknown) => {
    const message = errorText(cause);
    root.render(
      <React.StrictMode>
        <main role="alert" className="startup-error">
          <strong>백엔드 서비스 설정을 불러오지 못했습니다.</strong>
          <p>{message}</p>
        </main>
      </React.StrictMode>,
    );
  });
