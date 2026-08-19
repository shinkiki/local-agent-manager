import { useState } from "react";
import { hasTauriRuntime } from "../lib/ipc";
import type { ProviderId, ProviderStatus } from "../types";
import { Drawer, ErrorBanner, SourceBadge } from "./Shared";
import { SetupTerminalPanel } from "./TerminalPanel";

interface CliConnectionDrawerProps {
  provider: ProviderStatus;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onOpenChat: () => void;
}

interface ProviderGuide {
  install: string | null;
  installDetail: string;
  login: string;
  verify: string;
}

const guides: Record<ProviderId, ProviderGuide> = {
  claude: {
    install: "npm install -g @anthropic-ai/claude-code",
    installDetail: "공식 npm 패키지를 설치한 뒤 claude를 처음 실행해 로그인과 계정/요금 온보딩을 완료합니다.",
    login: "claude",
    verify: "claude auth status",
  },
  codex: {
    install: "npm install -g @openai/codex",
    installDetail: "공식 npm 패키지로 Codex CLI를 설치합니다.",
    login: "codex login",
    verify: "codex login status",
  },
  antigravity: {
    install: "irm https://antigravity.google/cli/install.ps1 | iex",
    installDetail: "Antigravity IDE와 별도인 공식 Antigravity CLI를 설치해 agy 명령을 PATH에 등록합니다.",
    login: "agy",
    verify: "agy --help",
  },
};

export function CliConnectionDrawer({ provider, onClose, onRefresh, onOpenChat }: CliConnectionDrawerProps) {
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
      setCheckError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  };

  return (
    <Drawer title={<><SourceBadge source={provider.provider} /><span>{provider.displayName} CLI 연결</span></>} onClose={onClose}>
      <section className="cli-connect-summary">
        <div>
          <strong>{ready ? "CLI를 찾았습니다" : "채팅 기록은 있지만 CLI 실행 파일이 없습니다"}</strong>
          <p>{ready
            ? "계정 로그인을 확인한 뒤 구조화 채팅을 시작할 수 있습니다."
            : desktopTerminal
              ? "아래 터미널에서 설치와 로그인을 완료한 뒤 다시 검사하세요."
              : "로컬 터미널에서 설치와 로그인을 완료한 뒤 다시 검사하세요."}</p>
        </div>
        <span className={ready ? "health ready" : "health warning"}>{ready ? "탐지 완료" : "연결 필요"}</span>
      </section>

      <ol className="cli-connect-steps">
        <li className={provider.history.detected ? "complete" : "pending"}><span>1</span><div><strong>{provider.history.detected ? "기존 채팅 탐지" : "기존 채팅 없음"}</strong><p>{provider.history.path ?? "CLI 연결과 별개로 새 채팅을 시작할 수 있습니다."}</p></div></li>
        <li className={ready ? "complete" : "active"}><span>2</span><div><strong>CLI 설치 및 PATH 등록</strong><p>{guide.installDetail}</p>{guide.install && <Command command={guide.install} />}</div></li>
        <li className={ready ? "active" : "pending"}><span>3</span><div><strong>계정 로그인</strong><p>로그인 과정에서 브라우저나 기기 인증 화면이 열릴 수 있습니다.</p><Command command={guide.login} plain={provider.provider === "antigravity"} /></div></li>
        <li className="pending"><span>4</span><div><strong>연결 확인</strong><p>검증 명령을 실행한 뒤 Agent Manager에서 다시 검사합니다.</p><Command command={guide.verify} /></div></li>
      </ol>

      {desktopTerminal ? (
        <SetupTerminalPanel source={provider.provider} />
      ) : (
        <ErrorBanner message="설치·로그인용 터미널은 데스크톱 앱에서만 열 수 있습니다. 위 명령을 로컬 터미널에서 실행하세요." />
      )}

      {checkError && <ErrorBanner message={checkError} />}
      <div className="cli-connect-actions">
        <button className="button" type="button" disabled={checking} onClick={refresh}>{checking ? "검사 중…" : "CLI 다시 검사"}</button>
        {ready && <button className="button primary" type="button" onClick={onOpenChat}>채팅으로 이동</button>}
      </div>
      <p className="cli-connect-restart-note">설치 후에도 탐지되지 않으면 Agent Manager를 다시 시작해 새 PATH를 적용하세요.</p>
    </Drawer>
  );
}

function Command({ command, plain = false }: { command: string; plain?: boolean }) {
  return plain ? <p className="cli-guide-plain">{command}</p> : <code className="cli-guide-command">{command}</code>;
}
