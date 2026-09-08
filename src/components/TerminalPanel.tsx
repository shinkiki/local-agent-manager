import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { hasTauriRuntime } from "../lib/ipc";
import { connectAccountLoginTerminal, connectSetupTerminal, connectTerminal, type TerminalConnection } from "../lib/terminal";
import type { AccountLoginSessionView, ProviderId, SessionSummary, TerminalEvent, TerminalPhase, TerminalSessionInfo } from "../types";
import { ErrorBanner } from "./Shared";
import { errorText } from "../lib/errorText";

type TerminalSurfacePhase = TerminalPhase | "idle" | "connecting";

const MOBILE_TERMINAL_QUERY = "(max-width: 760px)";

function accentCursorColor(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent-dark-v").trim();
  return value || "#f0b054";
}


export function TerminalPanel({ session }: { session: SessionSummary }) {
  const blockedReason = session.isSubagent
    ? "서브에이전트 세션은 1차 터미널 연결 대상이 아닙니다."
    : !session.cwd
      ? "세션에 저장된 작업 경로가 없어 CLI를 재개할 수 없습니다."
      : null;
  return <TerminalSurface
    connect={(cols, rows, onEvent) => connectTerminal({ source: session.source, sessionId: session.id, cols, rows }, onEvent)}
    blockedReason={blockedReason}
    connectLabel="CLI에 연결"
    reconnectLabel="다시 연결"
    identity={`${session.source} · ${session.id}`}
    footer="공식 CLI resume · 연결 해제 후 2분 유지"
  />;
}

export function SetupTerminalPanel({ source }: { source: ProviderId }) {
  return <TerminalSurface
    connect={(cols, rows, onEvent) => connectSetupTerminal({ source, cols, rows }, onEvent)}
    connectLabel="설정 터미널 열기"
    reconnectLabel="터미널 다시 열기"
    identity={`${source} · CLI 설정`}
    footer="로그인 셸 · 명령은 사용자가 직접 실행"
    introLines={[
      "Agent Manager CLI 연결 터미널",
      "아래 가이드의 설치·로그인 명령을 직접 입력하세요.",
    ]}
    setup
  />;
}

export function AccountLoginTerminalPanel({ login, remote, onCompletionChange }: {
  login: AccountLoginSessionView;
  /** 원격 UI 여부. 백엔드가 같은 판정으로 로그인 CLI 인자를 고르므로 안내도 여기에 맞춘다. */
  remote: boolean;
  onCompletionChange: (complete: boolean) => void;
}) {
  /** 원격 Codex만 device 코드 방식이라 코드를 브라우저에 넣는다. */
  const deviceCode = login.provider === "codex" && remote;
  /** 로컬 Codex는 loopback 콜백이라 브라우저가 알아서 끝낸다. 터미널에 넣을 코드가 없다. */
  const browserCallback = login.provider === "codex" && !remote;
  return <TerminalSurface
    connect={(cols, rows, onEvent) => connectAccountLoginTerminal({ loginId: login.id, cols, rows }, onEvent)}
    connectLabel="공식 로그인 시작"
    reconnectLabel="로그인 터미널 다시 열기"
    identity={`${login.provider} · 격리 로그인`}
    footer={`${login.environmentVariable} 임시 프로필 · 완료 후 자격증명만 보안 저장소로 이동`}
    introLines={deviceCode ? [
      "공급자 공식 CLI 로그인 전용 터미널",
      "터미널에 표시된 링크를 아무 기기의 브라우저에서 열고, 함께 표시된 일회용 코드를 그 화면에 입력하세요.",
      "코드는 브라우저에 입력합니다. 이 터미널에 붙여넣을 필요는 없습니다.",
      "브라우저 인증이 끝나면 CLI가 스스로 종료되고 '로그인 완료 저장' 버튼이 활성화됩니다.",
    ] : browserCallback ? [
      "공급자 공식 CLI 로그인 전용 터미널",
      "이 컴퓨터의 브라우저가 열리면 로그인만 마치세요. 터미널에 입력할 코드는 없습니다.",
      "브라우저가 자동으로 열리지 않으면 터미널에 표시된 주소를 직접 여세요.",
      "인증이 끝나면 CLI가 스스로 종료되고 '로그인 완료 저장' 버튼이 활성화됩니다.",
    ] : [
      "공급자 공식 CLI 로그인 전용 터미널",
      "브라우저 인증 코드가 표시되면 아래 입력란에 붙여넣어 전송하세요.",
      "로그인 CLI는 보안상 입력을 화면에 표시하지 않습니다. 전송한 코드는 회색으로 확인됩니다.",
      "CLI가 정상 종료되면 '로그인 완료 저장' 버튼이 활성화됩니다.",
    ]}
    onCompletionChange={onCompletionChange}
    composerAlwaysVisible
    composerPlaceholder={login.provider === "codex" ? "터미널 입력" : "브라우저 인증 코드 붙여넣기"}
    setup
  />;
}

function TerminalSurface({
  connect: openConnection,
  blockedReason = null,
  connectLabel,
  reconnectLabel,
  identity,
  footer,
  introLines = [],
  onCompletionChange,
  composerAlwaysVisible = false,
  composerPlaceholder = "모바일 터미널 입력",
  setup = false,
}: {
  connect: (cols: number, rows: number, onEvent: (event: TerminalEvent) => void) => Promise<TerminalConnection>;
  blockedReason?: string | null;
  connectLabel: string;
  reconnectLabel: string;
  identity: string;
  footer: string;
  introLines?: string[];
  onCompletionChange?: (complete: boolean) => void;
  /** 계정 로그인처럼 CLI가 입력을 에코하지 않는 터미널은 데스크톱에서도 입력란이 유일한 피드백 경로다. */
  composerAlwaysVisible?: boolean;
  composerPlaceholder?: string;
  setup?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const mobileInputElementRef = useRef<HTMLInputElement>(null);
  const mobileComposingRef = useRef(false);
  const lastMobileSubmitRef = useRef(0);
  const [info, setInfo] = useState<TerminalSessionInfo | null>(null);
  const [phase, setPhase] = useState<TerminalSurfacePhase>("idle");
  const phaseRef = useRef<TerminalSurfacePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sentFeedback, setSentFeedback] = useState<string | null>(null);

  const updatePhase = (next: TerminalSurfacePhase) => {
    phaseRef.current = next;
    setPhase(next);
    if (next !== "exited") onCompletionChange?.(false);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { terminal, fit, dispose: disposeTerminal } = openSurfaceTerminal(host, {
      introLines,
      onLinkError: (cause) => setError(errorText(cause)),
    });
    terminalRef.current = terminal;
    fitRef.current = fit;
    const detachMobileInputMode = attachMobileInputMode(host, terminal, {
      isRunning: () => phaseRef.current === "running",
      focusComposer: () => mobileInputElementRef.current?.focus(),
    });
    const input = terminal.onData((data) => {
      if (phaseRef.current === "running") connectionRef.current?.input(data);
    });
    const detachAutoFit = attachAutoFit(host, fit, () => {
      connectionRef.current?.resize(clampCols(terminal.cols), clampRows(terminal.rows));
    });

    return () => {
      detachAutoFit();
      input.dispose();
      detachMobileInputMode();
      const connection = connectionRef.current;
      connectionRef.current = null;
      if (connection) void connection.detach();
      disposeTerminal();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  const handleEvent = (event: TerminalEvent) => {
    if (event.type === "output") {
      terminalRef.current?.write(
        event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data),
      );
      return;
    }
    if (event.type === "state") {
      setInfo(event.session);
      updatePhase(event.session.state);
      if (event.session.state === "exited") {
        onCompletionChange?.(event.session.exitCode === 0);
      }
      if (event.session.replayTruncated) {
        setError("재연결 출력이 8MiB를 넘어 이전 일부가 생략되었습니다.");
      }
      return;
    }
    if (event.type === "exit") {
      updatePhase("exited");
      onCompletionChange?.(event.code === 0);
      const connection = connectionRef.current;
      connectionRef.current = null;
      if (connection) void connection.detach();
      terminalRef.current?.writeln(`\r\n\x1b[90m[CLI 종료${event.code === null ? "" : `: ${event.code}`} ]\x1b[0m`);
      return;
    }
    setError(event.message);
    terminalRef.current?.writeln(`\r\n\x1b[31m${event.message}\x1b[0m`);
  };

  const connect = async () => {
    const terminal = terminalRef.current;
    if (!terminal || connectionRef.current) return;
    setError(null);
    setSentFeedback(null);
    updatePhase("connecting");
    try {
      fitRef.current?.fit();
      const connection = await openConnection(clampCols(terminal.cols), clampRows(terminal.rows), handleEvent);
      setInfo(connection.info);
      updatePhase(connection.info.state);
      if (isFinished(connection.info.state)) {
        await connection.detach();
      } else {
        connectionRef.current = connection;
      }
      if (isMobileTerminalViewport() || composerAlwaysVisible) {
        window.requestAnimationFrame(() => mobileInputElementRef.current?.focus());
      } else {
        terminal.focus();
      }
    } catch (cause) {
      updatePhase("idle");
      setError(errorText(cause));
    }
  };

  const stop = async () => {
    const connection = connectionRef.current;
    if (!connection) return;
    setError(null);
    updatePhase("stopping");
    try {
      await connection.stop();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const sendMobileLine = (value = mobileInputElementRef.current?.value ?? "") => {
    const connection = connectionRef.current;
    if (!connection || phaseRef.current !== "running") return;
    const now = performance.now();
    if (now - lastMobileSubmitRef.current < 100) return;
    lastMobileSubmitRef.current = now;
    connection.input(`${value}\r`);
    // 계정 로그인 CLI는 입력을 에코하지 않아 전송이 조용히 사라진 것처럼 보인다.
    // PTY가 아닌 화면에만 로컬 에코를 남겨 무엇이 전송됐는지 보여준다.
    if (composerAlwaysVisible && value) {
      const printable = value.replace(/[\p{Cc}\p{Cf}]/gu, "");
      if (printable) terminalRef.current?.write(`\x1b[2m${printable}\x1b[0m\r\n`);
    }
    setSentFeedback(value || "(Enter)");
    if (mobileInputElementRef.current) mobileInputElementRef.current.value = "";
  };

  const canConnect = (phase === "idle" || isFinished(phase)) && !connectionRef.current && !blockedReason;

  return (
    <section className={`terminal-panel${setup ? " terminal-panel-setup" : ""}`}>
      <header className="terminal-toolbar">
        <div>
          <span className={`terminal-status terminal-status-${phase}`} />
          <strong>{phaseLabel(phase)}</strong>
          {info?.reconnectDeadline && phase === "detached" && (
            <small>{new Date(info.reconnectDeadline).toLocaleTimeString()}까지 재연결 가능</small>
          )}
        </div>
        <div>
          {canConnect && <button className="button primary" type="button" onClick={connect}>{isFinished(phase) ? reconnectLabel : connectLabel}</button>}
          {phase === "connecting" && <button className="button" type="button" disabled>연결 중…</button>}
          {connectionRef.current && !matchesStopped(phase) && (
            <button className="button danger-subtle" type="button" onClick={stop}>종료</button>
          )}
        </div>
      </header>
      {blockedReason && <ErrorBanner message={blockedReason} />}
      {error && <ErrorBanner message={error} />}
      <div className="terminal-host" ref={hostRef} />
      <form
        className={`mobile-terminal-composer${composerAlwaysVisible ? " terminal-composer-always" : ""}`}
        onSubmit={(event) => {
          event.preventDefault();
          sendMobileLine();
        }}
      >
        <input
          ref={mobileInputElementRef}
          type="text"
          onCompositionStart={() => { mobileComposingRef.current = true; }}
          onCompositionEnd={() => {
            mobileComposingRef.current = false;
          }}
          onBeforeInput={(event) => {
            const inputType = (event.nativeEvent as InputEvent).inputType;
            if (mobileComposingRef.current
              || (inputType !== "insertLineBreak" && inputType !== "insertParagraph")) return;
            event.preventDefault();
            sendMobileLine(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing
              || mobileComposingRef.current) return;
            event.preventDefault();
            sendMobileLine(event.currentTarget.value);
          }}
          inputMode="text"
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={composerPlaceholder}
          aria-label={composerPlaceholder}
          disabled={phase !== "running"}
        />
        <button className="button primary" type="submit" disabled={phase !== "running"}>전송</button>
      </form>
      {sentFeedback && <p className="terminal-composer-feedback">전송됨 · <code>{sentFeedback}</code></p>}
      <footer>
        <code>{identity}</code>
        <span>{footer}</span>
      </footer>
    </section>
  );
}

async function openExternalUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Unsupported terminal link protocol: ${url.protocol}`);
  }
  if (hasTauriRuntime()) {
    await openUrl(url.href);
    return;
  }
  // Mobile browsers can return null for a successfully opened noopener tab.
  // Do not treat that return value as proof that the popup was blocked.
  window.open(url.href, "_blank", "noopener,noreferrer");
}

/** xterm 인스턴스를 host에 붙이고 시작 안내 줄까지 찍은 뒤, 해제 수단과 함께 돌려준다. */
function openSurfaceTerminal(host: HTMLDivElement, options: {
  introLines: string[];
  onLinkError: (cause: unknown) => void;
}): { terminal: Terminal; fit: FitAddon; dispose: () => void } {
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: "SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.25,
    scrollback: 5_000,
    linkHandler: {
      activate: (_event, url) => {
        void openExternalUrl(url).catch(options.onLinkError);
      },
    },
    theme: {
      background: "#070c12",
      foreground: "#d4dee9",
      cursor: accentCursorColor(),
      selectionBackground: "#31506b99",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  for (const line of options.introLines) terminal.writeln(`\x1b[90m${line}\x1b[0m`);
  if (options.introLines.length > 0) terminal.writeln("");
  return { terminal, fit, dispose: () => terminal.dispose() };
}

/**
 * 모바일 폭에서는 아래 입력줄이 유일한 입력 경로다. 뷰포트가 바뀔 때마다 stdin과
 * xterm의 숨은 입력창 속성을 거기에 맞추고, 그 숨은 입력창이 포커스를 가져가면
 * 실행 중인 세션에 한해 입력줄로 되돌린다.
 */
function attachMobileInputMode(host: HTMLDivElement, terminal: Terminal, composer: {
  isRunning: () => boolean;
  focusComposer: () => void;
}): () => void {
  const mobileViewport = window.matchMedia(MOBILE_TERMINAL_QUERY);
  const xtermInput = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  const updateMobileInputMode = () => {
    const useMobileComposer = mobileViewport.matches;
    terminal.options.disableStdin = useMobileComposer;
    if (!xtermInput) return;
    xtermInput.readOnly = useMobileComposer;
    xtermInput.tabIndex = useMobileComposer ? -1 : 0;
    if (useMobileComposer) xtermInput.setAttribute("inputmode", "none");
    else xtermInput.removeAttribute("inputmode");
  };
  const redirectMobileFocus = () => {
    if (!mobileViewport.matches) return;
    xtermInput?.blur();
    if (composer.isRunning()) {
      window.requestAnimationFrame(() => composer.focusComposer());
    }
  };
  updateMobileInputMode();
  mobileViewport.addEventListener("change", updateMobileInputMode);
  xtermInput?.addEventListener("focus", redirectMobileFocus);
  return () => {
    mobileViewport.removeEventListener("change", updateMobileInputMode);
    xtermInput?.removeEventListener("focus", redirectMobileFocus);
  };
}

/** 표면 크기가 바뀔 때마다 xterm을 다시 맞추고 맞춰진 칸 수를 PTY에 알린다. */
function attachAutoFit(host: HTMLDivElement, fit: FitAddon, onFitted: () => void): () => void {
  const observer = new ResizeObserver(() => {
    window.requestAnimationFrame(() => {
      if (!host.isConnected) return;
      try {
        fit.fit();
        onFitted();
      } catch {
        // The drawer can briefly have zero dimensions while switching tabs.
      }
    });
  });
  observer.observe(host);
  window.requestAnimationFrame(() => fit.fit());
  return () => observer.disconnect();
}

function clampCols(value: number): number {
  return Math.min(500, Math.max(20, value || 80));
}

function clampRows(value: number): number {
  return Math.min(300, Math.max(5, value || 24));
}

function isMobileTerminalViewport(): boolean {
  return window.matchMedia(MOBILE_TERMINAL_QUERY).matches;
}

function matchesStopped(phase: TerminalSurfacePhase): boolean {
  return phase === "stopping" || phase === "exited" || phase === "failed";
}

function isFinished(phase: TerminalSurfacePhase): boolean {
  return phase === "exited" || phase === "failed";
}

function phaseLabel(phase: TerminalSurfacePhase): string {
  if (phase === "idle") return "연결 대기";
  if (phase === "connecting") return "연결 중";
  if (phase === "running") return "연결됨";
  if (phase === "detached") return "재연결 대기";
  if (phase === "stopping") return "종료 중";
  if (phase === "exited") return "종료됨";
  return "오류";
}
