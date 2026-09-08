import { useState } from "react";
import { useI18n } from "../lib/i18n";
import { hasTauriRuntime } from "../lib/ipc";
import type { ProviderId, ProviderStatus } from "../types";
import { Drawer, ErrorBanner, SourceBadge } from "./Shared";
import { SetupTerminalPanel } from "./TerminalPanel";
import { errorText } from "../lib/errorText";

interface CliConnectionDrawerProps {
  provider: ProviderStatus;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onOpenChat: () => void;
}

interface ProviderGuide {
  install: string | null;
  /** 설치 안내 문구. 한국어·영어 한 짝으로 두고 화면에서 `text()`로 고른다(QA #38). */
  installDetail: readonly [ko: string, en: string];
  login: string;
  verify: string;
}

const guides: Record<ProviderId, ProviderGuide> = {
  claude: {
    install: "npm install -g @anthropic-ai/claude-code",
    installDetail: [
      "공식 npm 패키지를 설치한 뒤 claude를 처음 실행해 로그인과 계정/요금 온보딩을 완료합니다.",
      "Install the official npm package, then run claude once to finish login and account/billing onboarding.",
    ],
    login: "claude",
    verify: "claude auth status",
  },
  codex: {
    install: "npm install -g @openai/codex",
    installDetail: [
      "공식 npm 패키지로 Codex CLI를 설치합니다.",
      "Install the Codex CLI from the official npm package.",
    ],
    login: "codex login",
    verify: "codex login status",
  },
  antigravity: {
    install: "irm https://antigravity.google/cli/install.ps1 | iex",
    installDetail: [
      "Antigravity IDE와 별도인 공식 Antigravity CLI를 설치해 agy 명령을 PATH에 등록합니다.",
      "Install the official Antigravity CLI (separate from the Antigravity IDE) so the agy command is on PATH.",
    ],
    login: "agy",
    verify: "agy --help",
  },
};

/**
 * 설정 → 연결의 CLI 카드가 여는 연결 안내 드로워. 문구는 전부 `text(ko, en)`로 두어 영어
 * UI에서 카탈로그가 덮은 일부만 번역되고 나머지가 한국어로 남는 섞임을 없앤다(QA #38).
 * 주요 지점에는 `data-ui-anchor`를 두어 화면 안내·E2E가 짚을 수 있게 한다.
 */
export function CliConnectionDrawer({ provider, onClose, onRefresh, onOpenChat }: CliConnectionDrawerProps) {
  const { text } = useI18n();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const guide = guides[provider.provider];
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
        <li className={provider.history.detected ? "complete" : "pending"}><span>1</span><div>
          <strong>{provider.history.detected ? text("기존 채팅 탐지", "Existing chats detected") : text("기존 채팅 없음", "No existing chats")}</strong>
          <p>{provider.history.path ?? text("CLI 연결과 별개로 새 채팅을 시작할 수 있습니다.", "You can start a new chat regardless of the CLI connection.")}</p>
        </div></li>
        <li className={ready ? "complete" : "active"}><span>2</span><div>
          <strong>{text("CLI 설치 및 PATH 등록", "Install the CLI and add it to PATH")}</strong>
          <p>{text(guide.installDetail[0], guide.installDetail[1])}</p>
          {guide.install && <Command command={guide.install} />}
        </div></li>
        <li className={ready ? "active" : "pending"}><span>3</span><div>
          <strong>{text("계정 로그인", "Account login")}</strong>
          <p>{text("로그인 과정에서 브라우저나 기기 인증 화면이 열릴 수 있습니다.", "A browser or device-authentication screen may open during login.")}</p>
          <Command command={guide.login} plain={provider.provider === "antigravity"} />
        </div></li>
        <li className="pending"><span>4</span><div>
          <strong>{text("연결 확인", "Verify the connection")}</strong>
          <p>{text("검증 명령을 실행한 뒤 Agent Manager에서 다시 검사합니다.", "Run the verification command, then check again from Agent Manager.")}</p>
          <Command command={guide.verify} />
        </div></li>
      </ol>

      {desktopTerminal ? (
        <SetupTerminalPanel source={provider.provider} />
      ) : (
        <ErrorBanner message={text(
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

function Command({ command, plain = false }: { command: string; plain?: boolean }) {
  return plain ? <p className="cli-guide-plain">{command}</p> : <code className="cli-guide-command">{command}</code>;
}
