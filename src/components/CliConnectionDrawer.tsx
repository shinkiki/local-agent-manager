import { useState, type ReactNode } from "react";
import { useI18n } from "../lib/i18n";
import { hasTauriRuntime } from "../lib/ipc";
import type { ProviderId, ProviderStatus } from "../types";
import { Drawer, ErrorBanner, NoticeBanner, SourceBadge } from "./Shared";
import { SetupTerminalPanel } from "./TerminalPanel";
import { errorText } from "../lib/errorText";
import { displayPath } from "../lib/displayPath";
import { cliInstallCommand } from "../lib/cliInstallCommand";
import { LocalLlmConnectionCard } from "./LocalLlmConnectionCard";

interface CliConnectionDrawerProps {
  provider: ProviderStatus;
  /** 호스트 OS(`AppStatus.platform`). 설치 명령을 이 플랫폼에 맞춰 고른다. */
  platform: string;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onOpenChat: () => void;
}

interface ProviderGuide {
  /** 설치 안내 문구. 한국어·영어 한 짝으로 두고 화면에서 `text()`로 고른다(QA #38). */
  installDetail: readonly [ko: string, en: string];
  login: string;
  verify: string;
}

const guides: Record<ProviderId, ProviderGuide> = {
  claude: {
    installDetail: [
      "공식 npm 패키지를 설치한 뒤 claude를 처음 실행해 로그인과 계정/요금 온보딩을 완료합니다.",
      "Install the official npm package, then run claude once to finish login and account/billing onboarding.",
    ],
    login: "claude",
    verify: "claude auth status",
  },
  codex: {
    installDetail: [
      "공식 npm 패키지로 Codex CLI를 설치합니다.",
      "Install the Codex CLI from the official npm package.",
    ],
    login: "codex login",
    verify: "codex login status",
  },
  antigravity: {
    installDetail: [
      "Antigravity IDE와 별도인 공식 Antigravity CLI를 설치해 agy 명령을 PATH에 등록합니다.",
      "Install the official Antigravity CLI (separate from the Antigravity IDE) so the agy command is on PATH.",
    ],
    login: "agy",
    verify: "agy --help",
  },
  // 로컬은 위 분기에서 전용 드로어로 빠지므로 이 표를 타지 않는다. `Record<ProviderId, _>`
  // 를 채우려 남겨 두고, 값이 화면에 쓰이는 일은 없다.
  local: {
    installDetail: [
      "로컬 LLM은 별도 CLI가 없습니다.",
      "The local provider has no CLI of its own.",
    ],
    login: "",
    verify: "",
  },
};

/**
 * 설정 → 연결의 CLI 카드가 여는 연결 안내 드로워. 문구는 전부 `text(ko, en)`로 두어 영어
 * UI에서 카탈로그가 덮은 일부만 번역되고 나머지가 한국어로 남는 섞임을 없앤다(QA #38).
 * 주요 지점에는 `data-ui-anchor`를 두어 화면 안내·E2E가 짚을 수 있게 한다.
 */
export function CliConnectionDrawer({ provider, platform, onClose, onRefresh, onOpenChat }: CliConnectionDrawerProps) {
  const { text } = useI18n();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const guide = guides[provider.provider];
  const install = cliInstallCommand(provider.provider, platform);
  const ready = provider.cli.detected;
  const desktopTerminal = hasTauriRuntime();

  const refresh = async () => {
    setChecking(true);
    setCheckError(null);
    try {
      await onRefresh();
    } catch (cause) {
      setCheckError(errorText(cause));
    } finally {
      setChecking(false);
    }
  };

  // 로컬 공급자는 자기 CLI가 없어 설치·로그인·검증 4단계가 통째로 빈다. 연결 관리의 용무가
  // 곧 서버 주소 등록이므로, 설정 탭을 가리키는 안내 대신 그 카드만 여기서 바로 연다. 카드가
  // 이미 같은 말을 머리글에 달고 있어 요약 문단은 두지 않는다.
  if (provider.provider === "local") {
    return (
      <Drawer title={<><SourceBadge source={provider.provider} /><span>{text(`${provider.displayName} 연결`, `${provider.displayName} connection`)}</span></>} onClose={onClose}>
        <section className="cli-connect-summary" data-ui-anchor="cli-connect.summary">
          <div>
            <strong>{ready
              ? text("하네스를 찾았습니다", "Harness found")
              : text("실행 하네스가 없습니다", "The execution harness is missing")}</strong>
            <p>{text(
              "로컬 모델은 둘이 있어야 돕니다. 도구를 실행하는 하네스와, 모델을 띄우는 서빙 서버입니다.",
              "A local model needs two things: the harness that runs tools, and the server that serves the model.",
            )}</p>
          </div>
          <span className={ready ? "health ready" : "health warning"} data-ui-anchor="cli-connect.status">
            {ready ? text("탐지 완료", "Detected") : text("설치 필요", "Installation required")}
          </span>
        </section>

        <ol className="cli-connect-steps" data-ui-anchor="cli-connect.steps">
          <CliConnectionStep
            number={1}
            state={ready ? "complete" : "active"}
            title={text("실행 하네스 설치", "Install the execution harness")}
            detail={text(
              "셸과 파일 도구를 실제로 돌리는 자리입니다. 계정 로그인은 필요 없습니다 — 모델은 아래 서빙 서버가 맡습니다.",
              "This is what actually runs the shell and file tools. No account login is needed — the model comes from the serving server below.",
            )}
          >
            {install && <Command command={install} />}
          </CliConnectionStep>
          <CliConnectionStep
            number={2}
            state="active"
            title={text("서빙 서버 준비", "Prepare the serving server")}
            detail={text(
              "OpenAI 호환 API를 내주는 서버면 무엇이든 됩니다(Ollama·LM Studio·vLLM 등). 앱은 그 서버의 /v1 경로로만 이야기하므로 어느 것을 쓰든 등록 방법이 같습니다. 모델은 도구 호출을 지원해야 하고, 그림을 보내려면 비전도 있어야 합니다.",
              "Any server that exposes an OpenAI-compatible API works (Ollama, LM Studio, vLLM, and others). The app talks only to its /v1 path, so registration is the same whichever you pick. The model must support tool calls, and vision too if you want to send images.",
            )}
          >
            <Command command="ollama pull gpt-oss:20b" />
          </CliConnectionStep>
          <CliConnectionStep
            number={3}
            state="pending"
            title={text("주소와 모델 등록", "Register the address and model")}
            detail={text(
              "아래 카드에 서버 주소를 적고 검사를 누르면 그 서버가 가진 모델이 목록으로 올라옵니다.",
              "Enter the server address in the card below and run the check — the models that server offers will appear.",
            )}
          />
        </ol>

        <LocalLlmConnectionCard />

        {desktopTerminal ? (
          <SetupTerminalPanel source={provider.provider} />
        ) : (
          <NoticeBanner message={text(
            "설치용 터미널은 데스크톱 앱에서만 열 수 있습니다. 위 명령을 로컬 터미널에서 실행하세요.",
            "The setup terminal opens only in the desktop app. Run the commands above in a local terminal.",
          )} />
        )}

        {checkError && <ErrorBanner message={checkError} />}
        <div className="cli-connect-actions" data-ui-anchor="cli-connect.actions">
          <button className="button" type="button" disabled={checking} onClick={refresh} data-ui-anchor="cli-connect.recheck">
            {checking ? text("검사 중…", "Checking…") : text("하네스 다시 검사", "Check the harness again")}
          </button>
          <button className="button primary" type="button" onClick={onOpenChat} data-ui-anchor="cli-connect.open-chat">{text("채팅으로 이동", "Go to chat")}</button>
        </div>
      </Drawer>
    );
  }

  return (
    <Drawer title={<><SourceBadge source={provider.provider} /><span>{text(`${provider.displayName} CLI 연결`, `${provider.displayName} CLI connection`)}</span></>} onClose={onClose}>
      <section className="cli-connect-summary" data-ui-anchor="cli-connect.summary">
        <div>
          <strong>{ready
            ? text("CLI를 찾았습니다", "CLI found")
            : text("채팅 기록은 있지만 CLI 실행 파일이 없습니다", "Chat history exists, but the CLI executable is missing")}</strong>
          <p>{ready
            ? text("계정 로그인을 확인한 뒤 구조화 채팅을 시작할 수 있습니다.", "Confirm the account login, then you can start structured chats.")
            : desktopTerminal
              ? text("아래 터미널에서 설치와 로그인을 완료한 뒤 다시 검사하세요.", "Finish installing and logging in from the terminal below, then check again.")
              : text("로컬 터미널에서 설치와 로그인을 완료한 뒤 다시 검사하세요.", "Finish installing and logging in from a local terminal, then check again.")}</p>
        </div>
        <span className={ready ? "health ready" : "health warning"} data-ui-anchor="cli-connect.status">{ready ? text("탐지 완료", "Detected") : text("연결 필요", "Connection required")}</span>
      </section>

      <ol className="cli-connect-steps" data-ui-anchor="cli-connect.steps">
        <CliConnectionStep
          number={1}
          state={provider.history.detected ? "complete" : "pending"}
          title={provider.history.detected ? text("기존 채팅 탐지", "Existing chats detected") : text("기존 채팅 없음", "No existing chats")}
          detail={provider.history.path ? displayPath(provider.history.path) : text("CLI 연결과 별개로 새 채팅을 시작할 수 있습니다.", "You can start a new chat regardless of the CLI connection.")}
        />
        <CliConnectionStep
          number={2}
          state={ready ? "complete" : "active"}
          title={text("CLI 설치 및 PATH 등록", "Install the CLI and add it to PATH")}
          detail={text(guide.installDetail[0], guide.installDetail[1])}
        >
          {install && <Command command={install} />}
        </CliConnectionStep>
        <CliConnectionStep
          number={3}
          state={ready ? "active" : "pending"}
          title={text("계정 로그인", "Account login")}
          detail={text("로그인 과정에서 브라우저나 기기 인증 화면이 열릴 수 있습니다.", "A browser or device-authentication screen may open during login.")}
        >
          <Command command={guide.login} plain={provider.provider === "antigravity"} />
        </CliConnectionStep>
        <CliConnectionStep
          number={4}
          state="pending"
          title={text("연결 확인", "Verify the connection")}
          detail={text("검증 명령을 실행한 뒤 Agent Manager에서 다시 검사합니다.", "Run the verification command, then check again from Agent Manager.")}
        >
          <Command command={guide.verify} />
        </CliConnectionStep>
      </ol>

      {desktopTerminal ? (
        <SetupTerminalPanel source={provider.provider} />
      ) : (
        <NoticeBanner message={text(
          "설치·로그인용 터미널은 데스크톱 앱에서만 열 수 있습니다. 위 명령을 로컬 터미널에서 실행하세요.",
          "The setup terminal for installing and logging in opens only in the desktop app. Run the commands above in a local terminal.",
        )} />
      )}

      {checkError && <ErrorBanner message={checkError} />}
      <div className="cli-connect-actions" data-ui-anchor="cli-connect.actions">
        <button className="button" type="button" disabled={checking} onClick={refresh} data-ui-anchor="cli-connect.recheck">{checking ? text("검사 중…", "Checking…") : text("CLI 다시 검사", "Check CLI again")}</button>
        {ready && <button className="button primary" type="button" onClick={onOpenChat} data-ui-anchor="cli-connect.open-chat">{text("채팅으로 이동", "Go to chat")}</button>}
      </div>
      <p className="cli-connect-restart-note">{text(
        "설치 후에도 탐지되지 않으면 Agent Manager를 다시 시작해 새 PATH를 적용하세요.",
        "If the CLI is still not detected after installing, restart Agent Manager to pick up the new PATH.",
      )}</p>
    </Drawer>
  );
}

/** 연결 안내 네 단계가 공유하는 번호·제목·설명 구조. 상태와 추가 명령만 부르는 쪽이 정한다. */
function CliConnectionStep({ number, state, title, detail, children }: {
  number: number;
  state: "complete" | "active" | "pending";
  title: ReactNode;
  detail: ReactNode;
  children?: ReactNode;
}) {
  return <li className={state}><span>{number}</span><div>
    <strong>{title}</strong>
    <p>{detail}</p>
    {children}
  </div></li>;
}

function Command({ command, plain = false }: { command: string; plain?: boolean }) {
  return plain ? <p className="cli-guide-plain">{command}</p> : <code className="cli-guide-command">{command}</code>;
}
