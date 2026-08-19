import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import { applyThemeMode, loadThemeMode } from "./lib/theme";
import { I18nProvider } from "./lib/i18n";
import { hasTauriRuntime, initializeBackendService } from "./lib/ipc";

applyThemeMode(loadThemeMode());

// 원격 웹(secure context)에서만 PWA 설치를 위해 서비스워커를 등록한다.
// Tauri 웹뷰는 자체 프로토콜이라 등록 대상이 아니다.
if (!hasTauriRuntime() && "serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

void initializeBackendService()
  .then(() => {
    root.render(
      <React.StrictMode>
        <I18nProvider><App /></I18nProvider>
      </React.StrictMode>,
    );
  })
  .catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    root.render(
      <React.StrictMode>
        <main role="alert" className="startup-error">
          <strong>백엔드 서비스 설정을 불러오지 못했습니다.</strong>
          <p>{message}</p>
        </main>
      </React.StrictMode>,
    );
  });
