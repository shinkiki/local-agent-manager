import type { SaveSshServerRequest, SshCommandPolicyDefaults, SshEndpointView, SshKeyView } from "../types";
import { parseSshPort } from "./sshPort.ts";
import { commandLines } from "./sshCommandRules.ts";

export const DEFAULT_SSH_PORT = "22";
/** 서버 이름 한도. 백엔드 `MAX_SERVER_NAME_CHARS`와 같은 값이다. */
export const MAX_SERVER_NAME_CHARS = 80;

export interface ServerDraft {
  name: string;
  host: string;
  port: string;
  user: string;
  fingerprint: string;
  agentEnabled: boolean;
  allowed: string;
  denied: string;
  fileTransferEnabled: boolean;
  transferRoot: string;
  terminalEnabled: boolean;
  unrestrictedCommands: boolean;
  projectGitEnabled: boolean;
}

/**
 * 저장된 서버를 편집 상자의 입력값으로 편다. 새 서버면 22번 포트와 백엔드가 준 기본 명령
 * 정책을 채우고, 접속할 수 있는 첫 키를 미리 골라 둔다 — 빈 정책·빈 키로 열리지 않게 한다.
 */
export function serverDraftOf(server: SshEndpointView | null, defaults: SshCommandPolicyDefaults | null, defaultFingerprint = ""): ServerDraft {
  return {
    name: server?.name ?? "",
    host: server?.host ?? "",
    port: server ? String(server.port) : DEFAULT_SSH_PORT,
    user: server?.user ?? "",
    fingerprint: server?.fingerprint ?? defaultFingerprint,
    agentEnabled: server?.agentEnabled ?? false,
    allowed: (server ? server.allowedCommands : defaults?.allowed ?? []).join("\n"),
    denied: (server ? server.deniedCommands : defaults?.denied ?? []).join("\n"),
    fileTransferEnabled: server?.fileTransferEnabled ?? false,
    transferRoot: server?.transferRoot ?? "",
    terminalEnabled: server?.terminalEnabled ?? false,
    unrestrictedCommands: server?.unrestrictedCommands ?? false,
    projectGitEnabled: server?.projectGitEnabled ?? false,
  };
}

/** 저장본과 같은 값인지. 같으면 저장 버튼을 잠근다. */
export function sameServer(draft: ServerDraft, server: SshEndpointView): boolean {
  const saved = serverDraftOf(server, null);
  return draft.name.trim() === saved.name
    && draft.host.trim() === saved.host
    && draft.port.trim() === saved.port
    && draft.user.trim() === saved.user
    && draft.fingerprint === saved.fingerprint
    && draft.agentEnabled === saved.agentEnabled
    && commandLines(draft.allowed).join("\n") === commandLines(saved.allowed).join("\n")
    && commandLines(draft.denied).join("\n") === commandLines(saved.denied).join("\n")
    && draft.fileTransferEnabled === saved.fileTransferEnabled
    && draft.transferRoot.trim() === saved.transferRoot
    && draft.terminalEnabled === saved.terminalEnabled
    && draft.unrestrictedCommands === saved.unrestrictedCommands
    && draft.projectGitEnabled === saved.projectGitEnabled;
}

/** 주소·사용자·인증키 필수 입력, 포트 형식, 이름 길이, 파일 전송 시의 전송 폴더 입력을 확인한다. */
export function isServerDraftValid(draft: ServerDraft, keys: SshKeyView[]): boolean {
  if (!draft.host.trim() || !draft.user.trim()) return false;
  if (draft.name.trim().length > MAX_SERVER_NAME_CHARS) return false;
  // 백엔드는 ~/.ssh에 없는 지문을 받지 않는다. 키가 사라진 서버는 다른 키를 골라야 저장된다.
  if (!keys.some((key) => key.fingerprint === draft.fingerprint)) return false;
  if (draft.fileTransferEnabled && !draft.transferRoot.trim()) return false;
  return parseSshPort(draft.port) !== undefined;
}

/** 저장 요청. 에이전트 사용에 딸린 세 권한은 에이전트 사용이 꺼지면 함께 꺼서 보낸다. */
export function toSaveServerRequest(id: string | null, draft: ServerDraft): SaveSshServerRequest {
  return {
    id,
    name: draft.name.trim(),
    fingerprint: draft.fingerprint,
    host: draft.host.trim(),
    port: parseSshPort(draft.port) ?? null,
    user: draft.user.trim(),
    agentEnabled: draft.agentEnabled,
    allowedCommands: commandLines(draft.allowed),
    deniedCommands: commandLines(draft.denied),
    fileTransferEnabled: draft.agentEnabled && draft.fileTransferEnabled,
    transferRoot: draft.transferRoot.trim(),
    terminalEnabled: draft.agentEnabled && draft.terminalEnabled,
    unrestrictedCommands: draft.agentEnabled && draft.unrestrictedCommands,
    // 이 토글만 agentEnabled에 곱하지 않는다 — 에이전트 권한이 아니라 사용자 git의 신원이다(C16-10).
    projectGitEnabled: draft.projectGitEnabled,
  };
}

