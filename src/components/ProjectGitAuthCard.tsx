import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../lib/i18n";
import { getProjectGitOverview, listProjectGitRemoteTokens, setProjectGitRemoteToken } from "../lib/ipcProjects";
import { errorText } from "../lib/errorText";
import { displayPath } from "../lib/displayPath";
import { gitRemoteAuthRows, type GitRemoteAuthRow } from "../lib/gitRemoteAuth";
import type { GitOverview, ProjectGitRemoteTokens } from "../types";
import { ErrorBanner } from "./Shared";

/**
 * C16-11. 형상관리 탭의 프로젝트 목록 옆 톱니바퀴가 여는 git 원격 인증 카드. 고른 프로젝트의 HTTPS 원격 호스트마다
 * 저장소 → 비밀정보에 저장해 둔 값 하나를 고른다.
 *
 * 토큰 **값**은 저장된 비밀값(C17)에 있고 여기서는 이름만 오간다. 지정을 비밀값 쪽이 아니라
 * 프로젝트 쪽에 두는 것은 사용자 결정이다(2026-10-20) — 같은 값을 여러 프로젝트가 쓰거나,
 * 같은 호스트라도 프로젝트마다 다른 토큰을 쓰는 선택은 프로젝트를 보는 자리에서 내린다.
 */
export function ProjectGitAuthCard({ projectPath, onChanged }: {
  projectPath: string;
  /** 지정이 바뀐 뒤 형상관리 개요를 다시 읽게 한다. */
  onChanged?: () => void;
}) {
  const { text } = useI18n();
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [tokens, setTokens] = useState<ProjectGitRemoteTokens | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 개요 실패는 저장 오류와 따로 든다 — 저장이 오류를 지워도 "읽는 중"으로 되돌아가지 않게.
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [busyHost, setBusyHost] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setOverview(null);
    setTokens(null);
    setError(null);
    setOverviewFailed(false);
    // 개요가 실패해도(저장소가 아님 등) 이미 고른 지정은 보여야 지울 수 있다.
    getProjectGitOverview(projectPath)
      .then((next) => { if (live) setOverview(next); })
      .catch((cause: unknown) => { if (live) { setOverviewFailed(true); setError(errorText(cause)); } });
    listProjectGitRemoteTokens(projectPath)
      .then((next) => { if (live) setTokens(next); })
      .catch((cause: unknown) => { if (live) setError(errorText(cause)); });
    return () => { live = false; };
  }, [projectPath]);

  const rows = useMemo(
    () => gitRemoteAuthRows(overview?.repository?.remotes ?? [], tokens?.tokens ?? []),
    [overview, tokens],
  );

  const save = useCallback(async (host: string, secretName: string | null, username: string) => {
    setBusyHost(host);
    setError(null);
    try {
      setTokens(await setProjectGitRemoteToken({ projectPath, host, secretName, username: username.trim() || null }));
      onChanged?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusyHost(null);
    }
  }, [projectPath, onChanged]);

  return (
    <section className="settings-card project-git-auth" data-ui-anchor="projects.git.remoteAuthCard">
      <header>
        <div>
          <span>{text("git 원격 인증", "Git remote auth")}</span>
          <h2 title={projectPath}>{displayPath(projectPath)}</h2>
        </div>
        <p>{text(
          "이 프로젝트가 HTTPS 원격과 원격 확인·받아서 합치기·올리기를 할 때 쓸 토큰을 호스트마다 고릅니다. 토큰 값은 저장소 → 비밀정보에 저장해 두고 여기서는 이름만 고르며, 값은 그 git 실행의 환경에만 실립니다.",
          "Pick the token this project uses for fetch, pull, and push on each HTTPS remote host. Save the token itself under Storage → Secrets; only its name is chosen here, and the value is passed only to that git run's environment.",
        )}</p>
      </header>
      <div className="settings-card-sections">
        <section className="settings-subsection">
          {error && <ErrorBanner message={error} />}
          {tokens === null || (overview === null && !overviewFailed) ? (
            error === null && <p className="settings-storage-note">{text("원격 정보를 불러오는 중…", "Loading remotes…")}</p>
          ) : rows.length === 0 ? (
            <p className="project-registry-empty">{overview?.repository
              ? text(
                "이 프로젝트에는 HTTPS 원격이 없습니다. SSH 원격은 애드온 → SSH 키의 'git 원격용'으로 인증합니다.",
                "This project has no HTTPS remotes. SSH remotes authenticate with a key marked 'for git remotes' under Add-ons → SSH keys.",
              )
              : text("git 저장소가 아니어서 고를 원격이 없습니다.", "Not a git repository, so there are no remotes to configure.")}</p>
          ) : (
            <>
              {tokens.secretNames.length === 0 && (
                <p className="settings-storage-note">{text(
                  "고를 저장된 비밀값이 없습니다. 저장소 → 비밀정보에서 토큰을 먼저 저장하세요.",
                  "No saved secrets to pick from. Save a token under Storage → Secrets first.",
                )}</p>
              )}
              <ul className="project-registry-list project-git-auth-list">
                {rows.map((row) => (
                  <GitAuthRow
                    key={row.host}
                    row={row}
                    secretNames={tokens.secretNames}
                    defaultUsername={tokens.defaultUsername}
                    busy={busyHost !== null}
                    onSave={save}
                  />
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </section>
  );
}

function GitAuthRow({ row, secretNames, defaultUsername, busy, onSave }: {
  row: GitRemoteAuthRow;
  secretNames: string[];
  defaultUsername: string;
  busy: boolean;
  onSave: (host: string, secretName: string | null, username: string) => void;
}) {
  const { text } = useI18n();
  const savedSecret = row.binding?.secretName ?? "";
  // 기본 이름은 빈칸으로 보인다. 비교도 같은 모양으로 해야 기본 이름을 적어 넣었을 때 바뀐 것이 없다.
  const normalizeUsername = (value: string) => (value.trim() === defaultUsername ? "" : value.trim());
  const savedUsername = row.binding ? normalizeUsername(row.binding.username) : "";
  const [secret, setSecret] = useState(savedSecret);
  const [username, setUsername] = useState(savedUsername);
  // 저장 응답이 오면 화면의 선택을 저장본으로 맞춘다.
  useEffect(() => { setSecret(savedSecret); setUsername(savedUsername); }, [savedSecret, savedUsername]);
  const dirty = secret !== savedSecret || (secret !== "" && normalizeUsername(username) !== savedUsername);
  const missing = row.binding !== null && !row.binding.secretExists;

  const status = missing
    ? text(`고른 값 ${row.binding?.secretName}이(가) 저장소에서 지워져 쓰이지 않습니다`, `The chosen secret ${row.binding?.secretName} was deleted, so it is not used`)
    : row.binding
      ? text("이 값으로 인증합니다", "Authenticates with this secret")
      : row.otherMethod === "credentialHelper"
        ? text("git 자체 자격증명(credential helper·netrc 등)이 있어 고르지 않아도 됩니다", "git already has credentials (credential helper, netrc, …), so picking is optional")
        : row.otherMethod === "urlCredential"
          ? text("원격 주소에 자격증명이 들어 있습니다", "The remote URL carries credentials")
          : text("인증 수단이 없어 올리기가 막힙니다", "No credentials — push is blocked");

  return (
    <li className="project-registry-row project-git-auth-row" data-git-auth-host={row.host}>
      <div className="project-registry-main">
        <div className="project-registry-name">
          <strong>{row.host}</strong>
          {row.remotes.length > 0 && <small className="project-registry-meta">{row.remotes.join(", ")}</small>}
        </div>
        <span className={`project-registry-meta${missing || (!row.binding && row.otherMethod === null) ? " warning" : ""}`}>{status}</span>
      </div>
      <div className="project-git-auth-controls">
        <select
          aria-label={text(`${row.host}에 쓸 저장된 비밀값`, `Saved secret for ${row.host}`)}
          value={secret}
          disabled={busy}
          onChange={(event) => setSecret(event.target.value)}
        >
          <option value="">{text("사용 안 함", "None")}</option>
          {missing && row.binding && <option value={row.binding.secretName}>{text(`${row.binding.secretName} (지워짐)`, `${row.binding.secretName} (deleted)`)}</option>}
          {secretNames.map((name) => <option value={name} key={name}>{name}</option>)}
        </select>
        <input
          className="search-input"
          type="text"
          value={username}
          disabled={busy || secret === ""}
          onChange={(event) => setUsername(event.target.value)}
          placeholder={defaultUsername}
          aria-label={text(`${row.host} 사용자 이름`, `Username for ${row.host}`)}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          className="button compact"
          type="button"
          disabled={busy || !dirty || (missing && secret === savedSecret)}
          onClick={() => onSave(row.host, secret === "" ? null : secret, username)}
        >
          {secret === "" && savedSecret !== "" ? text("해제", "Clear") : text("저장", "Save")}
        </button>
      </div>
    </li>
  );
}
