import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import "./App.css";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { STALE_SHELL_MESSAGE, reloadForStaleShell } from "./lib/appReload";
import { applyThemeMode, loadThemeMode } from "./lib/theme";
import { I18nProvider, useI18n } from "./lib/i18n";
import { hasTauriRuntime, initializeBackendService } from "./lib/ipc";
import { watchKeyboardInset } from "./lib/keyboardInset";
import { guardStrayFileDrops } from "./lib/fileDropGuard";
import { errorText } from "./lib/errorText";
import { parseDiagramPopoutId } from "./lib/diagramPopout";
import { DiagramWindow } from "./components/DiagramWindow";
import { parsePopoutRequest } from "./lib/popout";
import { GitDiffWindow } from "./components/GitDiffWindow";

function StartupError({ cause }: { cause: unknown }) {
  const { text } = useI18n();
  return <main role="alert" className="startup-error">
    <strong>{text("백엔드 서비스 설정을 불러오지 못했습니다.", "Could not load the backend service settings.")}</strong>
    <p>{errorText(cause)}</p>
  </main>;
}

applyThemeMode(loadThemeMode());

// 첨부 자리 밖에 놓은 파일이 웹뷰를 그 파일로 데려가 앱 화면을 지우는 것을 막는다.
guardStrayFileDrops();

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

/**
 * 다이어그램 창은 앱 셸보다 먼저 갈라진다. 그림을 그리는 데 백엔드가 필요 없고(원문은 창을
 * 연 화면이 같은 origin의 저장소에 두고 온다), 창마다 백엔드 연결을 하나씩 더 만들 이유도
 * 없다. 백엔드 설정을 못 읽는 상황에서도 이 창은 그대로 뜬다.
 */
const diagramWindowId = parseDiagramPopoutId(window.location.search);
if (diagramWindowId) {
  root.render(
    <React.StrictMode>
      <I18nProvider><ErrorBoundary label="Diagram"><DiagramWindow id={diagramWindowId} /></ErrorBoundary></I18nProvider>
    </React.StrictMode>,
  );
} else {
  // 프로젝트 diff 창은 백엔드가 필요하지만 앱 셸은 필요 없다. 대상은 주소에 있고 내용은
  // 백엔드에서 읽으므로, 백엔드 연결만 마친 뒤 그 화면 하나만 그린다.
  const gitDiffRequest = parsePopoutRequest(window.location.search);
  void initializeBackendService()
    .then(() => {
      root.render(
        <React.StrictMode>
          <I18nProvider>
            <ErrorBoundary label="Agent Manager">
              {gitDiffRequest?.kind === "gitDiff" ? <GitDiffWindow request={gitDiffRequest} /> : <App />}
            </ErrorBoundary>
          </I18nProvider>
        </React.StrictMode>,
      );
    })
    .catch((cause: unknown) => {
      root.render(
        <React.StrictMode>
          <I18nProvider><StartupError cause={cause} /></I18nProvider>
        </React.StrictMode>,
      );
    });
}
