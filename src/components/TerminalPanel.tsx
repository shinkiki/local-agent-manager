import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState, type RefObject } from "react";
import { openExternalUrl } from "../lib/externalUrl";
import { writeClipboardText } from "../lib/clipboard";
import { TerminalHintCollector, hasTerminalHints, hintLinkLabel, type TerminalHints } from "../lib/terminalHints";
import { connectAccountLoginTerminal, connectSetupTerminal, connectSshTerminal, connectTerminal, type TerminalConnection } from "../lib/terminal";
import type { AccountLoginSessionView, CodexLoginMethod, ProviderId, SessionSummary, SshEndpointView, SshKeyView, TerminalEvent, TerminalPhase, TerminalSessionInfo, TerminalSshMode } from "../types";
import { ErrorBanner, NoticeBanner } from "./Shared";
import { errorText } from "../lib/errorText";
import { relayCodexLoginCallback } from "../lib/ipc";
import { useI18n, type UiText } from "../lib/i18n";

import { formatTimeOnly } from "../lib/format";
type TerminalSurfacePhase = TerminalPhase | "idle" | "connecting";

const MOBILE_TERMINAL_QUERY = "(max-width: 760px)";

function accentCursorColor(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent-dark-v").trim();
  return value || "#f0b054";
}


export function TerminalPanel({ session }: { session: SessionSummary }) {
  const { text } = useI18n();
  const blockedReason = session.isSubagent
    ? text("서브에이전트 세션은 1차 터미널 연결 대상이 아닙니다.", "Subagent sessions cannot be connected to primary terminals.")
    : !session.cwd
      ? text("세션에 저장된 작업 경로가 없어 CLI를 재개할 수 없습니다.", "Cannot resume CLI because no working directory is saved for this session.")
      : null;
  return <TerminalSurface
    connect={(cols, rows, onEvent) => connectTerminal({ source: session.source, sessionId: session.id, cols, rows }, onEvent)}
    blockedReason={blockedReason}
    connectLabel={text("CLI에 연결", "Connect to CLI")}
    reconnectLabel={text("다시 연결", "Reconnect")}
    identity={`${session.source} · ${session.id}`}
    footer={text("공식 CLI resume · 연결 해제 후 2분 유지", "Official CLI resume · Retained for 2 minutes after disconnect")}
  />;
}

export function SetupTerminalPanel({ source }: { source: ProviderId }) {
  const { text } = useI18n();
  return <TerminalSurface
    connect={(cols, rows, onEvent) => connectSetupTerminal({ source, cols, rows }, onEvent)}
    connectLabel={text("설정 터미널 열기", "Open setup terminal")}
    reconnectLabel={text("터미널 다시 열기", "Reopen terminal")}
    identity={`${source} · ${text("CLI 설정", "CLI setup")}`}
    footer={text("로그인 셸 · 명령은 사용자가 직접 실행", "Login shell · Commands are executed directly by user")}
    introLines={[
      text("Agent Manager CLI 연결 터미널", "Agent Manager CLI connection terminal"),
      text("아래 가이드의 설치·로그인 명령을 직접 입력하세요.", "Directly enter the install and login commands from the guide below."),
    ]}
    setup
  />;
}

/**
 * SSH 창 둘(직접 접속·공개키 등록)이 같은 전제로 열린다 — 저장된 연결 서버가 있고, 그 서버가
 * 가리키는 키가 ~/.ssh에 남아 있으며 같은 이름의 개인키가 있어야 한다. 두 창이 그 판정과
 * 표시 이름을 따로 계산하고 있었고, 서버 목록의 두 버튼도 같은 조건을 자기 식으로 한 번 더
 * 적어 두어 세 곳이 함께 움직여야 했다. 판정을 여기 한 곳에 두고 못 여는 이유를 그대로 돌려준다.
 *
 * 창은 서버 단위로 열린다. 키 하나를 여러 서버가 함께 쓸 수 있어 지문만으로는 어느 서버인지
 * 정해지지 않기 때문이다. `sshKey`는 서버의 지문으로 키 목록에서 찾은 값이고, 없으면 null이다.
 */
export function sshTerminalTarget(server: SshEndpointView, sshKey: SshKeyView | null, text: UiText = (ko) => ko): { blockedReason: string | null; destination: string } {
  const blockedReason = !sshKey
    ? text("이 서버가 쓰는 키가 ~/.ssh에 없습니다. 서버를 수정해 다른 키를 고르세요.", "The key this server uses is not in ~/.ssh. Edit the server and choose another key.")
    : !sshKey.hasPrivateKey
      ? text("같은 이름의 개인키가 없어 이 키로는 접속할 수 없습니다.", "Cannot connect with this key because no private key with the same name exists.")
      : null;
  return {
    blockedReason,
    destination: `${server.user}@${server.host}:${server.port}`,
  };
}

/** 이 서버로 SSH 창을 열 수 있는지. 열 수 없는 서버에는 버튼 자체를 내지 않는다. */
export function canOpenSshTerminal(server: SshEndpointView, sshKey: SshKeyView | null): boolean {
  return sshTerminalTarget(server, sshKey).blockedReason === null;
}

interface SshTerminalModeSpec {
  connectLabel: string;
  reconnectLabel: string;
  footer: string;
  exitLabel: string;
  introLines: (destination: string, fileName: string) => string[];
}

function getSshTerminalSpec(mode: TerminalSshMode, text: UiText): SshTerminalModeSpec {
  if (mode === "installKey") {
    return {
      connectLabel: text("등록", "Install"),
      reconnectLabel: text("다시 등록", "Re-install"),
      footer: text("공개키를 원격 authorized_keys에 등록 · 비밀번호는 저장되지 않음", "Install public key to remote authorized_keys · Password is not saved"),
      exitLabel: text("창 닫기", "Close window"),
      introLines: (destination, fileName) => [
        `${text("공개키 등록", "Install public key")} · ${destination}`,
        `${fileName}${text("의 공개키를 이 서버의 ~/.ssh/authorized_keys에 적습니다.", "'s public key will be written to ~/.ssh/authorized_keys on this server.")}`,
        text("서버가 비밀번호를 물어보면 여기서 직접 답하세요. 앱은 비밀번호를 받지도 저장하지도 않습니다.", "If the server prompts for a password, respond directly here. The app neither receives nor saves the password."),
        text("이미 같은 줄이 있으면 덧붙이지 않으므로 여러 번 눌러도 결과는 같습니다.", "If the line already exists it will not be appended again, so repeated attempts have the same result."),
      ],
    };
  }
  return {
    connectLabel: text("접속", "Connect"),
    reconnectLabel: text("다시 접속", "Reconnect"),
    footer: text("사용자가 직접 실행하는 원격 셸 · 명령 허용 목록은 적용되지 않음", "Remote shell executed directly by user · Command allowlist does not apply"),
    exitLabel: text("접속 종료", "Disconnect"),
    introLines: (destination) => [
      `${text("SSH 터미널", "SSH terminal")} · ${destination}`,
      text("이 창의 입력은 에이전트가 아니라 사용자가 직접 보내는 것이라 명령 허용 목록이 적용되지 않습니다.", "Input in this window is sent directly by the user rather than an agent, so command allowlists do not apply."),
      text("암호·패스프레이즈나 호스트 키 확인을 물어보면 여기서 직접 답하세요.", "If prompted for password, passphrase, or host key verification, respond directly here."),
    ],
  };
}

/**
 * C9-19. 저장된 연결 서버로 사용자가 직접 붙는 SSH 터미널(또는 C9-20 공개키 등록 터미널).
 *
 * 에이전트 경로와 다른 점이 요점이다. 명령 허용 목록은 적용하지 않고(사용자가 자기 손으로
 * 치는 셸이다), BatchMode를 빼 패스프레이즈·암호·호스트 키 확인 프롬프트가 이 창에 그대로
 * 온다. 그래서 known_hosts에 없던 호스트도 여기서 한 번 답하면 등록된다.
 */
export function SshTerminalPanel({ server, sshKey, mode = "shell" }: { server: SshEndpointView; sshKey: SshKeyView | null; mode?: TerminalSshMode }) {
  const { text } = useI18n();
  const { blockedReason, destination } = sshTerminalTarget(server, sshKey, text);
  const spec = getSshTerminalSpec(mode, text);
  return <TerminalSurface
    connect={(cols, rows, onEvent) => connectSshTerminal(
      { serverId: server.id, cols, rows, ...(mode === "shell" ? {} : { mode }) },
      onEvent,
    )}
    blockedReason={blockedReason}
    connectLabel={spec.connectLabel}
    reconnectLabel={spec.reconnectLabel}
    identity={destination}
    footer={spec.footer}
    exitLabel={spec.exitLabel}
    introLines={spec.introLines(destination, sshKey?.fileName ?? server.fingerprint)}
    setup
  />;
}

/**
 * C9-20. 서버가 쓰는 키의 공개키를 그 서버의 `authorized_keys`에 한 번 등록하는 창.
 *
 * Windows에는 `ssh-copy-id`가 없어 키를 서버에 올리려면 손으로 옮겨야 했다. 그 한 번을
 * 대신한다. 앱은 비밀번호를 받지도 저장하지도 않는다 — 서버가 물으면 사용자가 이 창에
 * 직접 답하고, 등록이 끝나면 그 뒤로는 키로만 붙는다.
 */
export function SshKeyInstallPanel({ server, sshKey }: { server: SshEndpointView; sshKey: SshKeyView | null }) {
  return <SshTerminalPanel server={server} sshKey={sshKey} mode="installKey" />;
}

export function AccountLoginTerminalPanel({ login, remote, codexMethod, onCompletionChange }: {
  login: AccountLoginSessionView;
  /** 원격 UI 여부. 브라우저 방식 Codex 로그인의 안내가 콜백 붙여넣기 쪽으로 갈린다. */
  remote: boolean;
  /** Codex 로그인 방식. 백엔드가 이 값으로 CLI 인자를 고른다. 다른 공급자는 무시한다. */
  codexMethod: CodexLoginMethod;
  onCompletionChange: (complete: boolean) => void;
}) {
  const { text } = useI18n();
  const method = login.provider === "codex" ? codexMethod : undefined;
  const presentation = accountLoginPresentation(login.provider, remote, method, text);
  // 방식을 바꾸면 표면을 새로 그린다. 앞 표면은 연결을 떼고, 백엔드는 새 방식으로 열 때
  // 앞 방식의 CLI를 끝낸다.
  return <>
  <TerminalSurface
    key={method ?? "default"}
    connect={(cols, rows, onEvent) => connectAccountLoginTerminal({ loginId: login.id, cols, rows, ...(method ? { codexMethod: method } : {}) }, onEvent)}
    connectLabel={text("공식 로그인 시작", "Start official login")}
    reconnectLabel={text("로그인 터미널 다시 열기", "Reopen login terminal")}
    identity={`${login.provider} · ${text("격리 로그인", "Isolated login")}`}
    footer={`${login.environmentVariable} ${text("임시 프로필 · 완료 후 자격증명만 보안 저장소로 이동", "temporary profile · only credentials moved to secure storage after completion")}`}
    introLines={presentation.introLines}
    onCompletionChange={onCompletionChange}
    composerAlwaysVisible
    composerPlaceholder={presentation.composerPlaceholder}
    collectHints
    setup
  />
  {method === "browser" && <CodexCallbackPaste loginId={login.id} remote={remote} />}
  </>;
}

/**
 * 브라우저 방식 Codex 로그인의 콜백 붙여넣기 칸. CLI의 로그인 서버는 백엔드 기기의
 * `127.0.0.1:1455`에만 떠서, 브라우저가 다른 기기에 있으면 승인 뒤 "연결할 수 없음" 화면에서
 * 멈춘다. 그 주소를 받아 백엔드가 로그인 서버에 대신 전달한다. CLI는 터미널 입력으로 코드를
 * 받지 않으므로 위 입력란으로는 끝낼 수 없다.
 */
function CodexCallbackPaste({ loginId, remote }: { loginId: string; remote: boolean }) {
  const { text } = useI18n();
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "relayed">("idle");
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!draft.trim() || state === "sending") return;
    setState("sending");
    setError(null);
    try {
      await relayCodexLoginCallback(loginId, draft);
      setState("relayed");
    } catch (cause) {
      setError(errorText(cause));
      setState("idle");
    }
  };
  return (
    <div className="account-login-callback-paste" data-testid="codex-login-callback-paste">
      <label htmlFor="codex-login-callback">{remote
        ? text("승인 뒤 브라우저가 127.0.0.1에 연결할 수 없다는 화면에서 멈추면, 그 주소창의 주소를 붙여 넣으세요.", "After approval the browser stops on a page saying it cannot reach 127.0.0.1. Paste the address from its address bar.")
        : text("브라우저가 다른 기기에서 열렸다면, 승인 뒤 멈춘 화면의 주소창 주소를 붙여 넣으세요.", "If the browser opened on another device, paste the address bar from the page it stopped on after approval.")}</label>
      <div className="account-login-callback-row">
        <input
          id="codex-login-callback"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder="http://127.0.0.1:1455/auth/callback?code=…&state=…"
          disabled={state !== "idle"}
          onChange={(event) => { setDraft(event.target.value); setError(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") void submit(); }}
        />
        <button className="button compact primary" type="button" disabled={!draft.trim() || state !== "idle"} onClick={() => void submit()}>
          {state === "sending" ? text("전달 중…", "Sending…") : text("승인 주소 전달", "Send approval address")}
        </button>
      </div>
      {error && <p className="account-login-callback-error" role="alert">{error}</p>}
      {state === "relayed" && <p className="account-login-callback-done" role="status">{text("로그인 CLI가 승인을 받았습니다. CLI가 종료되면 '로그인 완료 저장'이 켜집니다.", "The login CLI accepted the approval. 'Save login' turns on when the CLI exits.")}</p>}
    </div>
  );
}

/**
 * 로그인 창의 갈래. 공급자 하나가 원격 여부에 따라 다른 안내를 쓰므로, 갈래 이름은
 * 공급자가 아니라 "사용자가 무엇을 해야 하는가"로 짓는다.
 */
type AccountLoginGuideKind = "googleConsent" | "pasteCode" | "deviceCode" | "localBrowser" | "pasteCallback";

function accountLoginGuides(text: UiText): Record<AccountLoginGuideKind, string[]> {
  return {
    googleConsent: [
      text("브라우저가 열리면 등록할 구글 계정을 고르고 동의까지 마치세요.", "When the browser opens, select the Google account to register and complete consent."),
      text("이미 다른 구글 계정으로 열려 있으면 선택 화면 없이 그 계정으로 진행될 수 있습니다. 다른 계정을 등록하려면 브라우저에서 계정을 먼저 바꾸세요.", "If already signed into another Google account, it may proceed with that account without a selection screen. To register a different account, switch accounts in the browser first."),
      text("표시된 인증 코드를 60초 안에 아래 입력란에 붙여넣어 전송하세요. 시간을 넘기면 CLI가 끝나므로 취소하고 다시 시작해야 합니다.", "Paste and send the displayed authorization code in the input below within 60 seconds. If time expires, the CLI terminates and you must cancel and start again."),
      text("로그인이 끝나면 이 계정의 사용량이 터미널에 찍히고 '로그인 완료 저장' 버튼이 활성화됩니다.", "When login completes, usage for this account will be printed in the terminal and the 'Save completed login' button will be enabled."),
    ],
    pasteCode: [
      text("브라우저 인증 코드가 표시되면 아래 입력란에 붙여넣어 전송하세요.", "When the browser authorization code is displayed, paste and send it in the input below."),
      text("로그인 CLI는 보안상 입력을 화면에 표시하지 않습니다. 전송한 코드는 회색으로 확인됩니다.", "The login CLI does not display inputs on screen for security. Sent codes are confirmed in gray."),
      text("CLI가 정상 종료되면 '로그인 완료 저장' 버튼이 활성화됩니다.", "When the CLI exits cleanly, the 'Save completed login' button will be enabled."),
    ],
    deviceCode: [
      text("터미널에 표시된 링크를 아무 기기의 브라우저에서 열고, 함께 표시된 일회용 코드를 그 화면에 입력하세요.", "Open the link shown in the terminal in a browser on any device, and enter the displayed one-time code on that screen."),
      text("코드는 브라우저에 입력합니다. 이 터미널에 붙여넣을 필요는 없습니다.", "Enter the code in the browser. You do not need to paste it into this terminal."),
      text("브라우저 인증이 끝나면 CLI가 스스로 종료되고 '로그인 완료 저장' 버튼이 활성화됩니다.", "When browser authentication completes, the CLI will exit on its own and the 'Save completed login' button will be enabled."),
    ],
    pasteCallback: [
      text("터미널에 표시된 링크를 이 기기의 브라우저에서 열고 로그인을 승인하세요.", "Open the link shown in the terminal in this device's browser and approve the login."),
      text("승인 뒤 브라우저는 127.0.0.1에 연결할 수 없다는 화면에서 멈춥니다. 정상입니다 — 그 주소창의 주소를 아래 '승인 주소 전달' 칸에 붙여 넣으세요.", "After approval the browser stops on a page saying it cannot reach 127.0.0.1. That is expected — paste the address from its address bar into the 'Send approval address' field below."),
      text("CLI가 토큰을 받고 종료되면 '로그인 완료 저장' 버튼이 활성화됩니다.", "When the CLI receives the token and exits, the 'Save login' button will be enabled."),
    ],
    localBrowser: [
      text("이 컴퓨터의 브라우저가 열리면 로그인만 마치세요. 터미널에 입력할 코드는 없습니다.", "When the browser on this computer opens, simply complete the login. There is no code to enter in the terminal."),
      text("브라우저가 자동으로 열리지 않으면 터미널에 표시된 주소를 직접 여세요.", "If the browser does not open automatically, open the address shown in the terminal directly."),
      text("인증이 끝나면 CLI가 스스로 종료되고 '로그인 완료 저장' 버튼이 활성화됩니다.", "When authentication completes, the CLI will exit on its own and the 'Save completed login' button will be enabled."),
    ],
  };
}

function accountLoginGuideKind(provider: ProviderId, remote: boolean, codexMethod: CodexLoginMethod | undefined): AccountLoginGuideKind {
  if (provider === "antigravity") return "googleConsent";
  if (provider !== "codex") return "pasteCode";
  // Codex는 고른 방식으로 갈린다. 브라우저 방식은 브라우저가 이 기기에 없을 때 붙여넣기가 필요하다.
  if (codexMethod === "device") return "deviceCode";
  return remote ? "pasteCallback" : "localBrowser";
}

function accountLoginPresentation(provider: ProviderId, remote: boolean, codexMethod: CodexLoginMethod | undefined, text: UiText): {
  introLines: string[];
  composerPlaceholder: string;
} {
  return {
    composerPlaceholder: provider === "codex"
      ? text("터미널 입력", "Terminal input")
      : text("브라우저 인증 코드 붙여넣기", "Paste browser authorization code"),
    introLines: [
      text("공급자 공식 CLI 로그인 전용 터미널", "Dedicated terminal for official provider CLI login"),
      ...accountLoginGuides(text)[accountLoginGuideKind(provider, remote, codexMethod)],
    ],
  };
}

/**
 * 터미널 표면의 xterm 수명주기와 연결 상태를 맡는 훅.
 *
 * TerminalSurface 하나가 xterm 생성·해제, 연결 이벤트 해석, 연결·종료·한 줄 전송, 그리고
 * 툴바·배너·입력란 배치까지 모두 안고 있어 한 함수가 190줄을 넘었다. 상태를 바꾸는 쪽만
 * 여기로 떼면 컴포넌트에는 무엇을 그릴지만 남는다.
 *
 * connectionRef를 그대로 내보내는 것은 의도적이다. 툴바의 "종료" 버튼과 연결 버튼 노출
 * 조건이 렌더 중에 ref를 직접 읽어 판단하고 있고, 그 판정을 상태로 옮기면 다시 그리는
 * 시점이 달라진다. 이 회차는 동작을 그대로 두는 것이 목적이라 읽는 문장도 그대로 둔다.
 */
function useTerminalSurface({ openConnection, introLines, onCompletionChange, composerAlwaysVisible, exitLabel, collectHints }: {
  openConnection: (cols: number, rows: number, onEvent: (event: TerminalEvent) => void) => Promise<TerminalConnection>;
  introLines: string[];
  onCompletionChange?: (complete: boolean) => void;
  composerAlwaysVisible: boolean;
  exitLabel: string;
  /** 출력에서 주소·일회용 코드를 골라 버튼으로 꺼낼지. 로그인 터미널만 켠다. */
  collectHints: boolean;
}) {
  const { text } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connectionRef = useRef<TerminalConnection | null>(null);
  const mobileInputElementRef = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<TerminalSessionInfo | null>(null);
  const [phase, setPhase] = useState<TerminalSurfacePhase>("idle");
  const phaseRef = useRef<TerminalSurfacePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sentFeedback, setSentFeedback] = useState<string | null>(null);
  const [hints, setHints] = useState<TerminalHints | null>(null);
  const hintCollectorRef = useRef<TerminalHintCollector | null>(collectHints ? new TerminalHintCollector() : null);

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
      const { cols, rows } = normalizedTerminalSize(terminal);
      connectionRef.current?.resize(cols, rows);
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
      const bytes = event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data);
      terminalRef.current?.write(bytes);
      const changed = hintCollectorRef.current?.push(bytes);
      if (changed) setHints(changed);
      return;
    }
    if (event.type === "state") {
      setInfo(event.session);
      updatePhase(event.session.state);
      if (event.session.state === "exited") {
        onCompletionChange?.(event.session.exitCode === 0);
      }
      if (event.session.replayTruncated) {
        setError(text("재연결 출력이 8MiB를 넘어 이전 일부가 생략되었습니다.", "Reconnect output exceeded 8 MiB; earlier output was truncated."));
      }
      return;
    }
    if (event.type === "exit") {
      updatePhase("exited");
      onCompletionChange?.(event.code === 0);
      const connection = connectionRef.current;
      connectionRef.current = null;
      if (connection) void connection.detach();
      terminalRef.current?.writeln(`\r\n\x1b[90m[${exitLabel}${event.code === null ? "" : `: ${event.code}`} ]\x1b[0m`);
      return;
    }
    setError(event.message);
    terminalRef.current?.writeln(`\r\n\x1b[31m${event.message}\x1b[0m`);
  };

  const connect = async () => {
    const terminal = terminalRef.current;
    if (!terminal || connectionRef.current) return;
    // 새 연결의 출력만 본다. 다시 연 로그인 CLI는 새 주소·새 코드를 찍는다.
    hintCollectorRef.current?.reset();
    setHints(null);
    setError(null);
    setSentFeedback(null);
    updatePhase("connecting");
    try {
      fitRef.current?.fit();
      const { cols, rows } = normalizedTerminalSize(terminal);
      const connection = await openConnection(cols, rows, handleEvent);
      // 연결을 여는 사이 패널이 닫혔으면 해제 정리는 이미 끝났다. 여기서 ref에 넣으면
      // 아무도 detach하지 않아 백엔드 첨부 소켓이 남으므로 바로 놓는다.
      if (terminalRef.current !== terminal) {
        void connection.detach();
        return;
      }
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
      if (terminalRef.current !== terminal) return;
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

  const sendMobileLine = (value: string) => {
    const connection = connectionRef.current;
    if (!connection || phaseRef.current !== "running") return;
    connection.input(`${value}\r`);
    // 계정 로그인 CLI는 입력을 에코하지 않아 전송이 조용히 사라진 것처럼 보인다.
    // PTY가 아닌 화면에만 로컬 에코를 남겨 무엇이 전송됐는지 보여준다.
    if (composerAlwaysVisible && value) {
      const printable = value.replace(/[\p{Cc}\p{Cf}]/gu, "");
      if (printable) terminalRef.current?.write(`\x1b[2m${printable}\x1b[0m\r\n`);
    }
    setSentFeedback(value || "(Enter)");
  };

  return { hostRef, mobileInputElementRef, connectionRef, info, phase, error, sentFeedback, hints, setError, connect, stop, sendMobileLine };
}

/**
 * 터미널 출력에서 꺼낸 주소·일회용 코드를 버튼으로 보인다. 원격 화면, 특히 모바일에서는
 * xterm 안의 글자를 긁어 복사하기 어렵고 긴 OAuth 주소는 여러 줄로 접혀 보이므로, 여는
 * 것과 복사하는 것을 버튼 한 번으로 끝내게 한다. 출력은 신뢰할 수 없는 데이터라 여는 쪽이
 * http(s)만 받는다(`openExternalUrl`).
 */
function TerminalHintBar({ hints, onError }: { hints: TerminalHints; onError: (message: string) => void }) {
  const { text } = useI18n();
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  const copy = async (value: string) => {
    try {
      await writeClipboardText(value);
      setCopied(value);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(null), 1800);
    } catch (cause) {
      onError(errorText(cause));
    }
  };
  const open = (url: string) => {
    void openExternalUrl(url).catch((cause) => onError(errorText(cause)));
  };

  return (
    <div className="terminal-hints" role="group" aria-label={text("터미널에서 꺼낸 주소와 코드", "Addresses and codes found in the terminal")}>
      {hints.links.map((url) => (
        <div className="terminal-hint" key={`link:${url}`}>
          <span className="terminal-hint-kind">{text("주소", "Link")}</span>
          <code className="terminal-hint-value" title={url}>{hintLinkLabel(url)}</code>
          <button className="button primary" type="button" onClick={() => open(url)}>{text("브라우저에서 열기", "Open in browser")}</button>
          <button className="button" type="button" onClick={() => void copy(url)}>
            {copied === url ? text("복사됨", "Copied") : text("주소 복사", "Copy address")}
          </button>
        </div>
      ))}
      {hints.codes.map((code) => (
        <div className="terminal-hint" key={`code:${code}`}>
          <span className="terminal-hint-kind">{text("일회용 코드", "One-time code")}</span>
          <code className="terminal-hint-value terminal-hint-code">{code}</code>
          <button className="button" type="button" onClick={() => void copy(code)}>
            {copied === code ? text("복사됨", "Copied") : text("코드 복사", "Copy code")}
          </button>
        </div>
      ))}
    </div>
  );
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
  composerPlaceholder,
  exitLabel,
  collectHints = false,
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
  /** 종료 줄에 남길 이름. 공급자 CLI가 아닌 터미널(SSH 셸)은 "CLI"라고 부를 수 없다. */
  exitLabel?: string;
  /** 출력의 주소·일회용 코드를 버튼으로 꺼낸다. 로그인 터미널만 켠다. */
  collectHints?: boolean;
  setup?: boolean;
}) {
  const { text } = useI18n();
  const effectivePlaceholder = composerPlaceholder ?? text("모바일 터미널 입력", "Mobile terminal input");
  const effectiveExitLabel = exitLabel ?? text("CLI 종료", "Exit CLI");
  const { hostRef, mobileInputElementRef, connectionRef, info, phase, error, sentFeedback, hints, setError, connect, stop, sendMobileLine } =
    useTerminalSurface({ openConnection, introLines, onCompletionChange, composerAlwaysVisible, exitLabel: effectiveExitLabel, collectHints });

  const canConnect = (phase === "idle" || isFinished(phase)) && !connectionRef.current && !blockedReason;

  return (
    <section className={`terminal-panel${setup ? " terminal-panel-setup" : ""}`}>
      <header className="terminal-toolbar">
        <div>
          <span className={`terminal-status terminal-status-${phase}`} />
          <strong>{phaseLabel(phase, text)}</strong>
          {info?.reconnectDeadline && phase === "detached" && (
            <small>{formatTimeOnly(info.reconnectDeadline)}{text("까지 재연결 가능", " (reconnect deadline)")}</small>
          )}
        </div>
        <div>
          {canConnect && <button className="button primary" type="button" onClick={connect}>{isFinished(phase) ? reconnectLabel : connectLabel}</button>}
          {phase === "connecting" && <button className="button" type="button" disabled>{text("연결 중…", "Connecting…")}</button>}
          {connectionRef.current && !matchesStopped(phase) && (
            <button className="button danger-subtle" type="button" onClick={stop}>{text("종료", "Stop")}</button>
          )}
        </div>
      </header>
      {blockedReason && <NoticeBanner message={blockedReason} />}
      {error && <ErrorBanner message={error} />}
      {hasTerminalHints(hints) && <TerminalHintBar hints={hints} onError={setError} />}
      <div className="terminal-host" ref={hostRef} />
      <TerminalLineComposer
        inputRef={mobileInputElementRef}
        placeholder={effectivePlaceholder}
        alwaysVisible={composerAlwaysVisible}
        disabled={phase !== "running"}
        onSubmit={sendMobileLine}
      />
      {sentFeedback && <p className="terminal-composer-feedback">{text("전송됨", "Sent")} · <code>{sentFeedback}</code></p>}
      <footer>
        <code>{identity}</code>
        <span>{footer}</span>
      </footer>
    </section>
  );
}

/**
 * 터미널 아래에 붙는 한 줄 입력란.
 *
 * TerminalSurface가 xterm 수명주기와 함께 안고 있던 입력란 사정을 여기로 뗀다. 한 줄이
 * 전송되는 길이 세 갈래(폼 submit·Enter 키·insertLineBreak)라 같은 줄이 두 번 나가는 일이
 * 있고, 한글 조합 중의 Enter는 조합 확정이지 전송이 아니다. 그 두 가지를 막는 조합 플래그와
 * 짧은 중복 억제는 입력란 안에서만 쓰이므로 전송 자체를 맡는 쪽(onSubmit)과 섞지 않는다.
 */
function TerminalLineComposer({ inputRef, placeholder, alwaysVisible, disabled, onSubmit }: {
  /** 연결 직후 초점을 옮기는 쪽이 TerminalSurface라 입력 요소 참조는 부르는 쪽이 쥔다. */
  inputRef: RefObject<HTMLInputElement | null>;
  placeholder: string;
  alwaysVisible: boolean;
  disabled: boolean;
  onSubmit: (value: string) => void;
}) {
  const { text } = useI18n();
  const composingRef = useRef(false);
  const lastSubmitRef = useRef(0);
  const submit = (value: string) => {
    const now = performance.now();
    if (now - lastSubmitRef.current < 100) return;
    lastSubmitRef.current = now;
    onSubmit(value);
    if (inputRef.current) inputRef.current.value = "";
  };
  return (
    <form
      className={`mobile-terminal-composer${alwaysVisible ? " terminal-composer-always" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        submit(inputRef.current?.value ?? "");
      }}
    >
      <input
        ref={inputRef}
        type="text"
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onBeforeInput={(event) => {
          const inputType = (event.nativeEvent as InputEvent).inputType;
          if (composingRef.current
            || (inputType !== "insertLineBreak" && inputType !== "insertParagraph")) return;
          event.preventDefault();
          submit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing
            || composingRef.current) return;
          event.preventDefault();
          submit(event.currentTarget.value);
        }}
        inputMode="text"
        enterKeyHint="send"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
      />
      <button className="button primary" type="submit" disabled={disabled}>{text("전송", "Send")}</button>
    </form>
  );
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
 * 모바일 폭에서는 아래 입력줄이 유일한 입력 경로다. 뷰포트가 바뀔 때마다 키 입력과
 * xterm의 숨은 입력창 속성을 거기에 맞추고, 그 숨은 입력창이 포커스를 가져가면
 * 실행 중인 세션에 한해 입력줄로 되돌린다.
 */
function attachMobileInputMode(host: HTMLDivElement, terminal: Terminal, composer: {
  isRunning: () => boolean;
  focusComposer: () => void;
}): () => void {
  const mobileViewport = window.matchMedia(MOBILE_TERMINAL_QUERY);
  const xtermInput = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
  // 키보드만 막고 `disableStdin`은 건드리지 않는다. 그 옵션은 사람이 친 키뿐 아니라 xterm이
  // 스스로 답하는 제어 응답까지 함께 삼킨다. Windows ConPTY는 세션을 열자마자 커서 위치를
  // 묻고(`ESC[6n`) 그 답이 올 때까지 자식 출력을 한 바이트도 내보내지 않으므로, 답이 막히면
  // 모바일 폭에서는 CLI가 멀쩡히 떠 있는데도 터미널이 끝까지 빈 화면으로 남았다
  // (Codex 기기 코드 로그인에서 실측 — 일회용 코드가 영영 뜨지 않는다).
  terminal.attachCustomKeyEventHandler(() => !mobileViewport.matches);
  const updateMobileInputMode = () => {
    const useMobileComposer = mobileViewport.matches;
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

function normalizedTerminalSize({ cols, rows }: Pick<Terminal, "cols" | "rows">): { cols: number; rows: number } {
  return {
    cols: Math.min(500, Math.max(20, cols || 80)),
    rows: Math.min(300, Math.max(5, rows || 24)),
  };
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

function phaseLabel(phase: TerminalSurfacePhase, text: UiText): string {
  if (phase === "idle") return text("연결 대기", "Waiting to connect");
  if (phase === "connecting") return text("연결 중", "Connecting");
  if (phase === "running") return text("연결됨", "Connected");
  if (phase === "detached") return text("재연결 대기", "Waiting to reconnect");
  if (phase === "stopping") return text("종료 중", "Disconnecting");
  if (phase === "exited") return text("종료됨", "Exited");
  return text("오류", "Error");
}
