/**
 * C16-11. 원격 하나의 인증 판정(`GitRemote.auth`)을 화면의 조건으로 바꾼다.
 *
 * 판정은 백엔드가 네트워크 없이 매긴 것이라 "통과한다"를 보증하지 못한다. 그래서 막는 것은
 * `none` 하나뿐이다 — 이 화면은 자격증명을 묻지 않으므로(C16-3) 그 상태의 push는 반드시
 * `authFailed`로 끝난다. 가져오기·끌어오기는 공개 저장소라면 인증 없이 되므로 막지 않는다.
 */
import type { GitRemote, GitRemoteAuthMethod, ProjectGitRemoteTokenView } from "../types";
import type { UiText } from "./i18nLocale";

/** 이 원격으로의 push를 막아야 하는가. 원격을 모르면 막지 않는다 — 판정할 근거가 없다. */
export function gitPushAuthBlocked(remote: GitRemote | undefined): boolean {
  return remote?.auth?.method === "none";
}

/** 막았거나 막지 않았더라도 알려야 할 때의 한 줄. 알릴 것이 없으면 null. */
export function gitRemoteAuthHint(remote: GitRemote | undefined, text: UiText): string | null {
  if (!remote?.auth || remote.auth.method !== "none") return null;
  const host = remote.auth.host ?? remote.name;
  if (remote.auth.transport === "http") {
    return text(
      `${remote.name}(${host})은 평문 HTTP 원격이라 저장된 토큰을 싣지 않습니다. HTTPS 주소로 바꾸거나 git credential helper를 설정해야 올릴 수 있습니다.`,
      `${remote.name} (${host}) is a plain-HTTP remote, so saved tokens are never sent to it. Switch it to HTTPS or configure a git credential helper to push.`,
    );
  }
  return text(
    `${remote.name}(${host})에 쓸 인증 수단이 없어 올리기를 막았습니다. 형상관리 탭의 프로젝트 목록 옆 톱니바퀴(git 원격 인증)에서 ${host}에 쓸 토큰을 고르세요(토큰 값은 저장소 → 비밀정보에 저장합니다). 공개 저장소라면 원격 확인·받아서 합치기는 그대로 됩니다.`,
    `Push is blocked because there is no way to authenticate to ${remote.name} (${host}). Pick a token for ${host} with the gear next to the project list in Source control (Git remote auth); the token itself is saved under Storage → Secrets. Fetch and pull still work for public repositories.`,
  );
}

/** 형상관리 탭 톱니바퀴의 git 원격 인증 카드 한 줄. */
export interface GitRemoteAuthRow {
  host: string;
  /** 이 호스트를 HTTPS로 가리키는 원격 이름들. 지정만 남고 원격이 사라졌으면 빈 배열이다. */
  remotes: string[];
  /** 이 프로젝트가 이 호스트에 고른 값. 없으면 null. */
  binding: ProjectGitRemoteTokenView | null;
  /** 토큰 없이도 붙을 수단(credential helper·URL 자격증명)이 있으면 그 판정. 없으면 null. */
  otherMethod: Extract<GitRemoteAuthMethod, "credentialHelper" | "urlCredential"> | null;
}

/**
 * C16-11. 카드에 띄울 호스트 목록. 지금 HTTPS 원격의 호스트와 이미 고른 지정의 호스트를
 * 합친다 — 원격이 사라진 뒤에도 지정이 보여야 지울 수 있다. 평문 HTTP 원격은 토큰을 싣지
 * 않으므로 넣지 않는다.
 */
export function gitRemoteAuthRows(remotes: GitRemote[], tokens: ProjectGitRemoteTokenView[]): GitRemoteAuthRow[] {
  const rows = new Map<string, GitRemoteAuthRow>();
  const row = (host: string) => {
    let current = rows.get(host);
    if (!current) {
      current = { host, remotes: [], binding: null, otherMethod: null };
      rows.set(host, current);
    }
    return current;
  };
  for (const remote of remotes) {
    const auth = remote.auth;
    if (!auth) continue;
    // push 주소의 판정과, 가져오기 주소(`pushurl`과 다를 수 있다)의 호스트를 함께 센다.
    if (auth.transport === "https" && auth.host) {
      const current = row(auth.host);
      current.remotes.push(remote.name);
      if (auth.method === "credentialHelper" || auth.method === "urlCredential") current.otherMethod ??= auth.method;
    }
    if (auth.fetchHost && !(auth.transport === "https" && auth.fetchHost === auth.host)) {
      const current = row(auth.fetchHost);
      if (!current.remotes.includes(remote.name)) current.remotes.push(remote.name);
    }
  }
  for (const token of tokens) row(token.host).binding = token;
  return [...rows.values()].sort((a, b) => a.host.localeCompare(b.host));
}
