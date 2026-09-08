import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { isStaleChunkError, reloadForStaleShell } from "../lib/appReload";
import { useI18n } from "../lib/i18n";

/**
 * 경계가 감싸는 범위. `view`는 화면 하나·서랍 하나라 나머지 메뉴가 살아 있고, `app`은 셸
 * 전체라 실패하면 사이드바·상단바까지 없다. 문구가 이 차이를 모르면 메뉴가 하나도 없는
 * 화면에서 "다른 메뉴는 계속 사용할 수 있습니다"라고 안내하게 된다. 기본값은 `app`이다 —
 * 범위를 밝히지 않은 경계가 더 큰 범위의 문구를 받는 쪽이 사실과 어긋나지 않는다.
 */
export type ErrorBoundaryScope = "app" | "view";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 어느 영역이 실패했는지 알리는 이름. 화면 하나가 죽어도 나머지는 계속 쓸 수 있어야 한다. */
  label?: string;
  scope?: ErrorBoundaryScope;
}

interface ErrorBoundaryState {
  error: Error | null;
  stale: boolean;
}

/**
 * 렌더 예외를 이 경계에서 멈춘다. 경계가 없으면 React가 루트 트리를 통째로 떼어내
 * 화면 전체가 빈 배경만 남고, 사용자는 무엇이 실패했는지도 알 수 없다.
 *
 * 재배포로 lazy 청크가 사라진 경우(`isStaleChunkError`)는 코드 결함이 아니므로 오류를
 * 보여 주는 대신 셸을 새로 받아 온다. 새로고침이 가드에 막히면 안내 화면으로 남는다.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, stale: false };

  static getDerivedStateFromError(cause: unknown): ErrorBoundaryState {
    return { error: cause instanceof Error ? cause : new Error(String(cause)), stale: isStaleChunkError(cause) };
  }

  componentDidCatch(cause: unknown, info: ErrorInfo) {
    // 원격 웹에는 개발자 도구밖에 없다. 어느 컴포넌트에서 끊겼는지 함께 남긴다.
    console.error(`[${this.props.label ?? "화면"}] 렌더에 실패했습니다`, cause, info.componentStack);
    if (isStaleChunkError(cause)) reloadForStaleShell();
  }

  private retry = () => {
    this.setState({ error: null, stale: false });
  };

  private reload = () => {
    window.location.reload();
  };

  render() {
    const { error, stale } = this.state;
    if (!error) return this.props.children;
    return <ErrorFallback
      error={error}
      stale={stale}
      label={this.props.label}
      scope={this.props.scope ?? "app"}
      onRetry={this.retry}
      onReload={this.reload}
    />;
  }
}

/**
 * 브라우저가 이 출처의 저장소 접근을 막은 경우(쿠키·사이트 데이터 전면 차단). 코드 결함이
 * 아니라 지속되는 브라우저 설정이라 다시 시도·새로고침으로는 절대 복구되지 않는다.
 */
function storageBlocked(error: Error): boolean {
  return error.name === "SecurityError";
}

function ErrorFallback({ error, stale, label, scope, onRetry, onReload }: {
  error: Error;
  stale: boolean;
  label: string | undefined;
  scope: ErrorBoundaryScope;
  onRetry: () => void;
  onReload: () => void;
}) {
  const { text } = useI18n();
  const name = label ?? text("화면", "View");
  const wholeApp = scope === "app";
  const blocked = storageBlocked(error);
  const title = stale
    ? text("새 버전이 배포되어 이 화면을 불러올 수 없습니다.", "A new version was deployed and this view could not be loaded.")
    : text(`${name} 화면을 표시하지 못했습니다.`, `Could not display ${name}.`);
  let guidance: string;
  if (stale) {
    guidance = wholeApp
      ? text("새로고침하면 최신 화면을 받아옵니다.", "Reload to fetch the latest version.")
      : text("새로고침하면 최신 화면을 받아옵니다. 다른 메뉴는 계속 사용할 수 있습니다.", "Reload to fetch the latest version. Other menus keep working.");
  } else if (blocked) {
    guidance = text(
      "브라우저가 이 사이트의 저장소(쿠키·사이트 데이터) 접근을 막고 있습니다. 새로고침으로는 해결되지 않으며, 브라우저 설정에서 이 사이트의 쿠키와 사이트 데이터를 허용한 뒤 다시 열어야 합니다.",
      "The browser is blocking this site's storage (cookies and site data). Reloading will not help; allow cookies and site data for this site in the browser settings, then open the app again.",
    );
  } else if (wholeApp) {
    guidance = text(
      "앱 화면을 그리는 중에 오류가 났습니다. 새로고침해도 같은 화면이 반복되면 브라우저 설정이나 확장 프로그램이 원인일 수 있습니다.",
      "The app failed while rendering. If reloading shows the same screen again, a browser setting or extension may be the cause.",
    );
  } else {
    guidance = text("다른 메뉴는 계속 사용할 수 있습니다. 같은 오류가 반복되면 새로고침하세요.", "Other menus keep working. Reload if the error keeps happening.");
  }
  return (
    <div className={`view-error${wholeApp ? " view-error-app" : ""}`} role="alert" data-error-scope={scope}>
      <span className="view-error-mark" aria-hidden="true"><AlertTriangle size={20} strokeWidth={1.7} /></span>
      <strong>{title}</strong>
      <p>{guidance}</p>
      <span className="view-error-detail">{error.message}</span>
      {!blocked && <div className="view-error-actions">
        {!stale && <button type="button" className="button secondary" onClick={onRetry}>{text("다시 시도", "Retry")}</button>}
        <button type="button" className="button secondary" onClick={onReload}><RefreshCw size={13} aria-hidden="true" />{text("새로고침", "Reload")}</button>
      </div>}
    </div>
  );
}
