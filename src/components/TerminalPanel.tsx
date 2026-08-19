import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { hasTauriRuntime } from "../lib/ipc";
import { connectAccountLoginTerminal, connectSetupTerminal, connectTerminal, type TerminalConnection } from "../lib/terminal";
import type { AccountLoginSessionView, ProviderId, SessionSummary, TerminalEvent, TerminalPhase, TerminalSessionInfo } from "../types";
import { ErrorBanner } from "./Shared";

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

export function AccountLoginTerminalPanel({ login, onCompletionChange }: {
  login: AccountLoginSessionView;
  onCompletionChange: (complete: boolean) => void;
}) {
  return <TerminalSurface
    connect={(cols, rows, onEvent) => connectAccountLoginTerminal({ loginId: login.id, cols, rows }, onEvent)}
    connectLabel="공식 로그인 시작"
    reconnectLabel="로그인 터미널 다시 열기"
    identity={`${login.provider} · 격리 로그인`}
    footer={`${login.environmentVariable} 임시 프로필 · 완료 후 자격증명만 보안 저장소로 이동`}
    introLines={[
      "공급자 공식 CLI 로그인 전용 터미널",
      "브라우저 인증 코드가 표시되면 아래 입력란에 붙여넣어 전송하세요.",
      "CLI가 정상 종료되면 '로그인 완료 저장' 버튼이 활성화됩니다.",
    ]}
    onCompletionChange={onCompletionChange}
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
  const [phase, setPhase] = useState<TerminalPhase | "idle" | "connecting">("idle");
  const phaseRef = useRef<TerminalPhase | "idle" | "connecting">("idle");
  const [error, setError] = useState<string | null>(null);

  const updatePhase = (next: TerminalPhase | "idle" | "connecting") => {
    phaseRef.current = next;
    setPhase(next);
    if (next !== "exited") onCompletionChange?.(false);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: "SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      linkHandler: {
        activate: (_event, url) => {
          void openExternalUrl(url).catch((cause) => {
            setError(cause instanceof Error ? cause.message : String(cause));
          });
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
    const mobileViewport = window.matchMedia("(max-width: 760px)");
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
      if (phaseRef.current === "running") {
        window.requestAnimationFrame(() => mobileInputElementRef.current?.focus());
      }
    };
    updateMobileInputMode();
    mobileViewport.addEventListener("change", updateMobileInputMode);
    xtermInput?.addEventListener("focus", redirectMobileFocus);
    for (const line of introLines) terminal.writeln(`\x1b[90m${line}\x1b[0m`);
    if (introLines.length > 0) terminal.writeln("");
    terminalRef.current = terminal;
    fitRef.current = fit;
    const input = terminal.onData((data) => {
      if (phaseRef.current === "running") connectionRef.current?.input(data);
    });
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        if (!host.isConnected) return;
        try {
          fit.fit();
          connectionRef.current?.resize(clampCols(terminal.cols), clampRows(terminal.rows));
        } catch {
          // The drawer can briefly have zero dimensions while switching tabs.
        }
      });
    });
    observer.observe(host);
    window.requestAnimationFrame(() => fit.fit());

    return () => {
      observer.disconnect();
      input.dispose();
      mobileViewport.removeEventListener("change", updateMobileInputMode);
      xtermInput?.removeEventListener("focus", redirectMobileFocus);
      const connection = connectionRef.current;
      connectionRef.current = null;
      if (connection) void connection.detach();
      terminal.dispose();
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
      if (isMobileTerminalViewport()) {
        window.requestAnimationFrame(() => mobileInputElementRef.current?.focus());
      } else {
        terminal.focus();
      }
    } catch (cause) {
      updatePhase("idle");
      setError(cause instanceof Error ? cause.message : String(cause));
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
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const sendMobileLine = (value = mobileInputElementRef.current?.value ?? "") => {
    const connection = connectionRef.current;
    if (!connection || phaseRef.current !== "running") return;
    const now = performance.now();
    if (now - lastMobileSubmitRef.current < 100) return;
    lastMobileSubmitRef.current = now;
    connection.input(`${value}\r`);
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
        className="mobile-terminal-composer"
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
          placeholder="모바일 터미널 입력"
          aria-label="모바일 터미널 입력"
          disabled={phase !== "running"}
        />
        <button className="button primary" type="submit" disabled={phase !== "running"}>전송</button>
      </form>
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

function clampCols(value: number): number {
  return Math.min(500, Math.max(20, value || 80));
}

function clampRows(value: number): number {
  return Math.min(300, Math.max(5, value || 24));
}

function isMobileTerminalViewport(): boolean {
  return window.matchMedia("(max-width: 760px)").matches;
}

function matchesStopped(phase: TerminalPhase | "idle" | "connecting"): boolean {
  return phase === "stopping" || phase === "exited" || phase === "failed";
}

function isFinished(phase: TerminalPhase | "idle" | "connecting"): boolean {
  return phase === "exited" || phase === "failed";
}

function phaseLabel(phase: TerminalPhase | "idle" | "connecting"): string {
  if (phase === "idle") return "연결 대기";
  if (phase === "connecting") return "연결 중";
  if (phase === "running") return "연결됨";
  if (phase === "detached") return "재연결 대기";
  if (phase === "stopping") return "종료 중";
  if (phase === "exited") return "종료됨";
  return "오류";
}
