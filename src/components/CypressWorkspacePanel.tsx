import { Eye, EyeOff, LoaderCircle, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, formatDate } from "../lib/format";
import { useI18n } from "../lib/i18n";
import {
  addCypressWorkspace,
  deleteCypressWorkspaceFile,
  getCypressRegistry,
  getCypressRunStatus,
  getWebAccessStatus,
  installCypressModule,
  listCypressRuns,
  listCypressWorkspaceFiles,
  readCypressEnvFile,
  readCypressWorkspaceFile,
  removeCypressWorkspace,
  runCypressSpec,
  setCypressEnabled,
  writeCypressEnvFile,
  writeCypressWorkspaceFile,
  type WebAccessStatus,
} from "../lib/ipc";
import { failedCypressTests, isSensitiveCypressFile, parseEnvJsonText, specFiles, summarizeCypressRun, validateWorkspaceRelativePath } from "../lib/cypressWorkspace";
import type { CypressRegistry, CypressRunState, CypressRunStatus, CypressWorkspace, CypressWorkspaceFile } from "../types";
import { AppToggle, ErrorBanner, PathField, useConfirm, type ConfirmRequest } from "./Shared";
import { errorText } from "../lib/errorText";

/** 실행 상태 폴링 간격. 스펙 하나가 수십 초는 걸리므로 더 촘촘할 필요가 없다. */
const RUN_POLL_INTERVAL_MS = 2000;

/** 파일 편집기가 처음 여는 파일. 목록에 있는 첫 항목을 고른다. */
const PREFERRED_FIRST_FILES = ["cypress.config.js", "cypress.config.ts", "cypress.config.mjs"];


/** 민감 파일을 숨긴 상태로 보일 때 글자 수만 남기고 `•`로 바꾼다. 줄 구조는 유지한다. */
function maskContent(content: string): string {
  return content.replace(/[^\n]/g, "•");
}

function runStatePill(state: CypressRunState): string {
  switch (state) {
    case "passed": return "skill-sync-pill current";
    case "running": return "skill-sync-pill partial";
    default: return "skill-sync-pill conflict";
  }
}

/** 파일 편집기가 다루는 상태 한 벌. 렌더를 떼어낸 하위 컴포넌트가 이 한 덩어리로 받는다. */
type CypressFileEditor = ReturnType<typeof useCypressFileEditor>;

/**
 * 작업공간 파일 편집기의 상태·읽기·저장을 한 곳에 모은다. 목록·내용·미저장 표시·마스킹 여부·
 * 활성 경로는 늘 함께 움직이는데 이 여덟 조각과 두 개의 읽기 효과가 패널 본문에서 등록·설치·
 * 실행 상태와 뒤섞여 있어, 어디까지가 편집기인지 읽어서는 갈라지지 않았다.
 *
 * 바쁨 표시(`runBusy`)·알림·확인 대화는 패널 전체가 공유하는 것이라 훅이 새로 만들지 않고
 * 인자로 받는다 — 저장·삭제 중에 등록·설치 버튼까지 함께 막히는 지금 동작을 그대로 두려는
 * 것이다. 실행 쪽이 같은 목록에서 스펙을 뽑으므로 `files`는 그대로 내보낸다.
 */
function useCypressFileEditor({ workspace, canWrite, runBusy, confirm, onNotice }: {
  workspace: CypressWorkspace | null;
  canWrite: boolean;
  runBusy: <T,>(key: string, report: (message: string) => void, action: () => Promise<T>) => Promise<T | null>;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  onNotice: (message: string) => void;
}) {
  const { text } = useI18n();
  const [files, setFiles] = useState<CypressWorkspaceFile[] | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [maskedPaths, setMaskedPaths] = useState<Set<string>>(new Set());
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [revealSensitive, setRevealSensitive] = useState(false);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    return () => { disposedRef.current = true; };
  }, []);

  const loadFiles = useCallback(async (target: CypressWorkspace) => {
    setFiles(null);
    setContents({});
    setMaskedPaths(new Set());
    setDirtyPaths(new Set());
    setActivePath(null);
    setFileError(null);
    setRevealSensitive(false);
    try {
      const list = await listCypressWorkspaceFiles(target.id);
      if (disposedRef.current) return;
      setFiles(list);
      const first = PREFERRED_FIRST_FILES.find((name) => list.some((file) => file.path === name)) ?? list[0]?.path ?? null;
      setActivePath(first);
    } catch (cause) {
      if (!disposedRef.current) setFileError(errorText(cause));
    }
  }, []);

  // 작업공간을 바꾸면 파일 목록을 그 작업공간 기준으로 다시 읽는다.
  useEffect(() => {
    if (!workspace) return;
    void loadFiles(workspace);
  }, [workspace?.id, loadFiles]);

  // 활성 파일의 내용이 없으면 읽어 온다. 민감 파일은 원문 명령을 먼저 쓰고, 원격(403)이면
  // 마스킹본으로 대신 보인다 — 그 경우 편집·저장은 막힌다.
  useEffect(() => {
    if (!workspace || !activePath || contents[activePath] !== undefined) return;
    let disposed = false;
    const workspaceId = workspace.id;
    const path = activePath;
    const load = async () => {
      if (isSensitiveCypressFile(path)) {
        try {
          return await readCypressEnvFile(workspaceId);
        } catch {
          return await readCypressWorkspaceFile(workspaceId, path);
        }
      }
      return readCypressWorkspaceFile(workspaceId, path);
    };
    void load()
      .then((file) => {
        if (disposed) return;
        setContents((current) => ({ ...current, [path]: file.content }));
        if (file.masked) setMaskedPaths((current) => new Set(current).add(path));
      })
      .catch((cause) => { if (!disposed) setFileError(errorText(cause)); });
    return () => { disposed = true; };
  }, [workspace?.id, activePath, contents]);

  const editorPaths = useMemo(() => {
    const listed = (files ?? []).map((file) => file.path);
    // 아직 저장하지 않은 새 파일은 목록에 없으므로 내용 맵에서 보탠다.
    const extra = Object.keys(contents).filter((path) => !listed.includes(path));
    return [...listed, ...extra];
  }, [files, contents]);
  const activeIsSensitive = activePath !== null && isSensitiveCypressFile(activePath);
  const activeIsMasked = activePath !== null && maskedPaths.has(activePath);
  const activeContent = activePath ? contents[activePath] : undefined;
  const activeEditable = activePath !== null && !activeIsMasked && canWrite;

  const selectFile = (path: string) => {
    setActivePath(path);
    setRevealSensitive(false);
    setFileError(null);
  };

  const addFile = () => {
    const name = newFileName.trim().replace(/\\/g, "/");
    const problem = validateWorkspaceRelativePath(name);
    if (problem) {
      setFileError(problem);
      return;
    }
    if (editorPaths.includes(name)) {
      setActivePath(name);
      setNewFileName("");
      return;
    }
    setContents((current) => ({ ...current, [name]: "" }));
    setDirtyPaths((current) => new Set(current).add(name));
    setActivePath(name);
    setNewFileName("");
    setFileError(null);
  };

  const removeFile = async (path: string) => {
    if (!workspace) return;
    const existing = files?.some((file) => file.path === path) ?? false;
    if (existing) {
      const accepted = await confirm({
        title: text("파일 삭제", "Delete file"),
        message: text("작업공간에서 이 파일을 지웁니다. 되돌릴 수 없습니다.", "Deletes this file from the workspace. This cannot be undone."),
        items: [path],
        confirmLabel: text("삭제", "Delete"),
        tone: "danger",
      });
      if (!accepted) return;
      setFileError(null);
      const deleted = await runBusy("file", setFileError, async () => {
        await deleteCypressWorkspaceFile(workspace.id, path);
        setFiles((current) => current?.filter((file) => file.path !== path) ?? current);
        return true;
      });
      if (!deleted) return;
    }
    setContents((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setDirtyPaths((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    if (activePath === path) setActivePath(editorPaths.find((item) => item !== path) ?? null);
  };

  const saveFiles = async () => {
    if (!workspace || dirtyPaths.size === 0) return;
    setFileError(null);
    const saved: string[] = [];
    // 일부만 저장됐을 수 있으니 실패해도 성공한 경로만 dirty에서 뺀다.
    const report = (message: string) => {
      setDirtyPaths((current) => {
        const next = new Set(current);
        for (const path of saved) next.delete(path);
        return next;
      });
      setFileError(message);
    };
    await runBusy("save", report, async () => {
      for (const path of dirtyPaths) {
        if (maskedPaths.has(path)) continue;
        const content = contents[path] ?? "";
        const file = isSensitiveCypressFile(path)
          ? await writeCypressEnvFile(workspace.id, content)
          : await writeCypressWorkspaceFile(workspace.id, path, content);
        saved.push(path);
        setFiles((current) => {
          const list = current ?? [];
          return list.some((item) => item.path === file.path)
            ? list.map((item) => (item.path === file.path ? file : item))
            : [...list, file].sort((a, b) => a.path.localeCompare(b.path));
        });
      }
      setDirtyPaths(new Set());
      onNotice(text(`파일 ${saved.length}개를 저장했습니다.`, `Saved ${saved.length} file(s).`));
    });
  };

  /** 활성 파일의 본문을 고친다. 편집이 막힌 상태에서는 무시한다(마스킹본·읽기 전용). */
  const editActiveContent = (value: string) => {
    const path = activePath;
    if (!activeEditable || path === null) return;
    setContents((current) => ({ ...current, [path]: value }));
    setDirtyPaths((current) => new Set(current).add(path));
  };

  const reload = () => {
    if (workspace) void loadFiles(workspace);
  };

  return {
    files,
    fileError,
    editorPaths,
    activePath,
    dirtyPaths,
    newFileName,
    setNewFileName,
    revealSensitive,
    toggleReveal: () => setRevealSensitive((open) => !open),
    activeIsSensitive,
    activeIsMasked,
    activeContent,
    activeEditable,
    selectFile,
    addFile,
    removeFile,
    saveFiles,
    editActiveContent,
    reload,
  };
}

/**
 * 설정 → 자동화 탭. AIA가 Cypress로 웹 테스트·정보 조회·크롤링·매크로를 돌릴 작업공간을
 * 관리한다. 등록·설치·실행·민감 파일 쓰기는 호스트 전용이므로 원격 접속에서는 버튼을 막고
 * 그 이유를 적는다. 파일 편집기는 스킬 편집기의 마크업·상태 패턴을 따르되 저장은 파일 단위다.
 */
export function CypressWorkspacePanel({ active }: {
  /** 설정 화면이 보이는 동안만 실행 상태를 폴링한다. */
  active: boolean;
}) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [registry, setRegistry] = useState<CypressRegistry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installOutput, setInstallOutput] = useState<string | null>(null);

  // 외부 폴더 등록 폼
  const [formOpen, setFormOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newModuleDir, setNewModuleDir] = useState("");

  // 실행
  const [specChoice, setSpecChoice] = useState("");
  const [envText, setEnvText] = useState("");
  const [runError, setRunError] = useState<string | null>(null);
  const [currentRun, setCurrentRun] = useState<CypressRunStatus | null>(null);
  const [runs, setRuns] = useState<CypressRunStatus[]>([]);
  const disposedRef = useRef(false);

  // 쓰기 권한만 본다. 원격 write 모드면 호스트와 같게 설정·실행할 수 있고(C7, 2026-08-29 결정),
  // 원격 읽기 전용 모드에서는 변경 명령이 403이므로 버튼을 미리 막는다.
  const canWrite = access?.writable === true;
  const hostOnlyReason = access === null
    ? text("접속 권한을 확인하고 있습니다.", "Checking access.")
    : !canWrite
      ? text("원격 편집이 꺼져 있어 변경할 수 없습니다.", "Remote editing is off; changes are disabled.")
      : null;

  useEffect(() => {
    disposedRef.current = false;
    return () => { disposedRef.current = true; };
  }, []);

  useEffect(() => {
    let disposed = false;
    void getWebAccessStatus()
      .then((next) => { if (!disposed) setAccess(next); })
      .catch((cause) => { if (!disposed) setError(errorText(cause)); });
    void getCypressRegistry()
      .then((next) => {
        if (disposed) return;
        setRegistry(next);
        setSelectedId((current) => current ?? next.workspaces[0]?.id ?? null);
      })
      .catch((cause) => { if (!disposed) setError(errorText(cause)); });
    return () => { disposed = true; };
  }, []);

  const selected = useMemo(
    () => registry?.workspaces.find((workspace) => workspace.id === selectedId) ?? null,
    [registry, selectedId],
  );

  const refreshRuns = useCallback(async () => {
    try {
      const list = await listCypressRuns();
      if (!disposedRef.current) setRuns(list);
    } catch {
      // 최근 실행 목록은 보조 정보라 실패해도 패널을 막지 않는다.
    }
  }, []);

  // 작업공간을 바꾸면 실행 상태를 그 작업공간 기준으로 되돌린다. 파일 목록·편집 상태는
  // 편집기 훅이 같은 기준으로 다시 읽는다.
  useEffect(() => {
    if (!selected) return;
    setSpecChoice("");
    setRunError(null);
    setCurrentRun(null);
    void refreshRuns();
  }, [selected?.id, refreshRuns]);

  // 실행 중인 작업은 2초마다 상태를 묻고, 끝나면(또는 화면을 떠나면) 멈춘다.
  useEffect(() => {
    if (!active || !currentRun || currentRun.state !== "running") return;
    const jobId = currentRun.jobId;
    let disposed = false;
    const timer = setInterval(() => {
      void getCypressRunStatus(jobId)
        .then((next) => {
          if (disposed) return;
          setCurrentRun(next);
          if (next.state !== "running") void refreshRuns();
        })
        .catch((cause) => { if (!disposed) setRunError(errorText(cause)); });
    }, RUN_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [active, currentRun?.jobId, currentRun?.state, refreshRuns]);

  /**
   * 바쁨 표시와 실패 처리를 한 벌로 묶는다. 등록 변경·설치·파일 삭제·저장·실행이 모두
   * `setBusy(key)` → 실행 → 실패하면 오류 문구 적기 → `finally setBusy(null)`을 똑같이
   * 되풀이하고, 다르던 것은 오류를 어디에 적느냐(`report`)뿐이었다. 실패는 삼키고 `null`을
   * 돌려주므로 호출부는 결과가 `null`인지로 성공 여부를 본다. 시작 전에 무엇을 비울지는
   * 갈래마다 달라(알림·설치 출력·실행 오류) 호출부에 그대로 남겼다.
   */
  const runBusy = async <T,>(key: string, report: (message: string) => void, action: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    try {
      return await action();
    } catch (cause) {
      report(errorText(cause));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const mutate = (key: string, action: () => Promise<CypressRegistry>) => {
    setError(null);
    setNotice(null);
    return runBusy(key, setError, async () => {
      const next = await action();
      setRegistry(next);
      return next;
    });
  };

  const toggleEnabled = (enabled: boolean) => {
    void mutate("enabled", () => setCypressEnabled(enabled));
  };

  const submitWorkspace = async () => {
    const name = newName.trim();
    const path = newPath.trim();
    if (!name || !path) return;
    const moduleDir = newModuleDir.trim();
    const next = await mutate("add", () => addCypressWorkspace(name, path, moduleDir ? moduleDir : null));
    if (!next) return;
    setNewName("");
    setNewPath("");
    setNewModuleDir("");
    setFormOpen(false);
    const added = next.workspaces.find((workspace) => workspace.path === path);
    if (added) setSelectedId(added.id);
    setNotice(text(`'${name}' 작업공간을 등록했습니다.`, `Registered workspace '${name}'.`));
  };

  const removeWorkspace = async (workspace: CypressWorkspace) => {
    if (workspace.builtin) return;
    const accepted = await confirm({
      title: text("작업공간 제거", "Remove workspace"),
      message: text(
        "등록만 해제합니다. 폴더와 파일은 그대로 남습니다.",
        "Only the registration is removed. The folder and its files stay untouched.",
      ),
      items: [workspace.name, workspace.path],
      confirmLabel: text("제거", "Remove"),
      tone: "danger",
    });
    if (!accepted) return;
    const next = await mutate(`remove-${workspace.id}`, () => removeCypressWorkspace(workspace.id));
    if (next && selectedId === workspace.id) setSelectedId(next.workspaces[0]?.id ?? null);
  };

  const install = async (workspace: CypressWorkspace) => {
    setError(null);
    setNotice(null);
    setInstallOutput(null);
    await runBusy(`install-${workspace.id}`, setError, async () => {
      const receipt = await installCypressModule(workspace.id);
      setRegistry((current) => current
        ? { ...current, workspaces: current.workspaces.map((item) => (item.id === receipt.workspace.id ? receipt.workspace : item)) }
        : current);
      setInstallOutput(receipt.output);
      setNotice(text(
        `'${workspace.name}'에 Cypress ${receipt.workspace.cypressVersion ?? ""}를 설치했습니다.`,
        `Installed Cypress ${receipt.workspace.cypressVersion ?? ""} for '${workspace.name}'.`,
      ));
    });
  };

  // ---- 파일 편집기 ----

  const editor = useCypressFileEditor({ workspace: selected, canWrite, runBusy, confirm, onNotice: setNotice });

  // ---- 실행 ----

  const specs = useMemo(() => specFiles(editor.files ?? []), [editor.files]);
  const canRun = canWrite && selected !== null && selected.moduleReady && registry?.enabled !== false;
  const runBlockedReason = hostOnlyReason
    ?? (!selected?.moduleReady ? text("Cypress 모듈을 먼저 설치하세요.", "Install the Cypress module first.") : null);

  const startRun = async () => {
    if (!selected) return;
    const env = parseEnvJsonText(envText);
    if (env instanceof Error) {
      setRunError(env.message);
      return;
    }
    setRunError(null);
    await runBusy("run", setRunError, async () => {
      const status = await runCypressSpec(selected.id, specChoice || null, Object.keys(env).length > 0 ? env : null);
      setCurrentRun(status);
      void refreshRuns();
    });
  };

  const workspaceRuns = useMemo(
    () => runs.filter((run) => !selected || run.workspaceId === selected.id).slice(0, 10),
    [runs, selected],
  );

  const busyInstallId = busy?.startsWith("install-") ? busy.slice("install-".length) : null;

  return (
    <section className="settings-card cypress-panel" data-ui-anchor="settings.cypress">
      <header>
        <div>
          <span>{text("자동화", "Automation")}</span>
          <h2>{text("Cypress 자동화 작업공간", "Cypress automation workspaces")}</h2>
        </div>
        <p>{text(
          "AIA가 브라우저 자동화 스크립트를 실행할 작업공간을 관리합니다. 설정·환경값·스펙 파일을 여기서 고치고 바로 실행해 볼 수 있습니다.",
          "Manage the workspaces where AIA runs browser automation scripts. Edit config, env, and spec files here and run them right away.",
        )}</p>
      </header>
      <div className="settings-card-sections">
        <section className="settings-subsection">
          <header>
            <div>
              <strong>{text("AIA가 Cypress 자동화를 실행할 수 있음", "AIA may run Cypress automation")}</strong>
              <small>{text(
                "켜면 AIA가 이 작업공간의 스크립트를 승인 후 실행해 결과를 보고합니다. 웹 테스트·정보 조회·크롤링·매크로에 씁니다.",
                "When on, AIA runs scripts from these workspaces after approval and reports the results. Used for web tests, lookups, crawling, and macros.",
              )}</small>
              {hostOnlyReason && <small className="cypress-host-note">{hostOnlyReason}</small>}
            </div>
            <AppToggle
              checked={registry?.enabled ?? false}
              disabled={!canWrite || !registry || busy !== null}
              label={text("AIA가 Cypress 자동화를 실행할 수 있음", "AIA may run Cypress automation")}
              onChange={toggleEnabled}
            />
          </header>
          {error && <div className="cypress-banner"><ErrorBanner message={error} /></div>}
          {notice && <p className="cypress-notice" role="status">{notice}</p>}
        </section>

        <section className="settings-subsection">
          <header>
            <div>
              <strong>{text("작업공간", "Workspaces")}</strong>
              <small>{text("기본 작업공간은 앱이 관리합니다. 외부 폴더를 등록해 기존 Cypress 프로젝트도 쓸 수 있습니다.", "The built-in workspace is managed by the app. Register an external folder to use an existing Cypress project.")}</small>
            </div>
            <button className="button compact" type="button" disabled={!canWrite || busy !== null} title={hostOnlyReason ?? undefined} onClick={() => setFormOpen((open) => !open)}>
              <Plus size={13} aria-hidden="true" />{text("외부 폴더 등록", "Register folder")}
            </button>
          </header>
          {formOpen && (
            <div className="detail-card cypress-form">
              <div className="form-row">
                <label htmlFor="cypress-new-name">{text("이름", "Name")}</label>
                <input id="cypress-new-name" value={newName} onChange={(event) => setNewName(event.target.value)} placeholder={text("예: 사내 포털 테스트", "e.g. Intranet tests")} />
              </div>
              <div className="form-row">
                <label htmlFor="cypress-new-path">{text("폴더", "Folder")}</label>
                <PathField id="cypress-new-path" value={newPath} onChange={setNewPath} placeholder="/path/to/cypress-project" />
              </div>
              <div className="form-row">
                <label htmlFor="cypress-new-module">{text("Cypress 모듈 위치", "Cypress module dir")}</label>
                <div>
                  <PathField id="cypress-new-module" value={newModuleDir} onChange={setNewModuleDir} placeholder={text("(선택) 비우면 폴더 안에 설치", "(optional) leave empty to install inside the folder")} />
                </div>
              </div>
              <div className="form-actions cypress-form-actions">
                <button className="button" type="button" disabled={busy !== null} onClick={() => setFormOpen(false)}>{text("취소", "Cancel")}</button>
                <button className="button primary" type="button" disabled={busy !== null || !newName.trim() || !newPath.trim()} onClick={() => { void submitWorkspace(); }}>
                  {busy === "add" ? text("등록 중…", "Registering…") : text("등록", "Register")}
                </button>
              </div>
            </div>
          )}
          {!registry ? (
            <p className="project-registry-empty">{text("작업공간을 불러오는 중…", "Loading workspaces…")}</p>
          ) : registry.workspaces.length === 0 ? (
            <p className="project-registry-empty">{text("등록된 작업공간이 없습니다.", "No workspaces registered.")}</p>
          ) : (
            <ul className="project-registry-list cypress-workspace-list">
              {registry.workspaces.map((workspace) => {
                const installing = busyInstallId === workspace.id;
                return (
                  <li key={workspace.id} className={`project-registry-row cypress-workspace-row${workspace.id === selectedId ? " selected" : ""}`}>
                    <button type="button" className="project-registry-main cypress-workspace-select" onClick={() => setSelectedId(workspace.id)} aria-pressed={workspace.id === selectedId}>
                      <span className="project-registry-name">
                        <strong data-user-content>{workspace.name}</strong>
                        {workspace.builtin && <span className="skill-sync-pill current">{text("기본", "Built-in")}</span>}
                        {workspace.moduleReady
                          ? <span className="skill-sync-pill">{`Cypress ${workspace.cypressVersion ?? ""}`.trim()}</span>
                          : <span className="skill-sync-pill partial">{text("Cypress 설치 필요", "Cypress not installed")}</span>}
                      </span>
                      <span className="project-registry-path" title={workspace.path} data-user-content>{workspace.path}</span>
                      {workspace.moduleDir && <span className="project-registry-meta"><span>{text("모듈", "Module")}: <code data-user-content>{workspace.moduleDir}</code></span></span>}
                    </button>
                    <div className="cypress-workspace-actions">
                      {!workspace.moduleReady && (
                        <button className="button compact" type="button" disabled={!canWrite || busy !== null} title={hostOnlyReason ?? undefined} onClick={() => { void install(workspace); }}>
                          {installing ? <LoaderCircle size={13} className="spinning" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
                          {installing ? text("설치 중… (최대 15분)", "Installing… (up to 15 min)") : text("설치", "Install")}
                        </button>
                      )}
                      {!workspace.builtin && (
                        <button className="button compact danger" type="button" disabled={!canWrite || busy !== null} title={hostOnlyReason ?? undefined} onClick={() => { void removeWorkspace(workspace); }}>
                          <Trash2 size={13} aria-hidden="true" />{text("제거", "Remove")}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {installOutput && (
            <details className="cypress-details cypress-install-output">
              <summary>{text("설치 출력", "Install output")}</summary>
              <pre data-user-content>{installOutput}</pre>
            </details>
          )}
        </section>

        {selected && (
          <CypressFileEditorSection
            workspace={selected}
            editor={editor}
            canWrite={canWrite}
            busy={busy}
            showReadOnlyNote={!canWrite && access !== null}
          />
        )}

        {selected && (
          <section className="settings-subsection">
            <header>
              <div>
                <strong>{text("실행", "Run")}</strong>
                <small>{text("스펙 하나 또는 전체를 헤드리스로 실행하고 결과·산출물을 확인합니다.", "Run one spec or all of them headlessly and inspect results and artifacts.")}</small>
              </div>
            </header>
            <div className="detail-card">
              {runError && <ErrorBanner message={runError} />}
              <div className="form-row">
                <label htmlFor="cypress-spec">{text("스펙", "Spec")}</label>
                <select id="cypress-spec" value={specChoice} onChange={(event) => setSpecChoice(event.target.value)} data-user-content>
                  <option value="">{text("전체", "All specs")}</option>
                  {specs.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
                </select>
              </div>
              <div className="form-row">
                <label htmlFor="cypress-env">{text("추가 env", "Extra env")}</label>
                <textarea
                  id="cypress-env"
                  value={envText}
                  rows={3}
                  spellCheck={false}
                  data-user-content
                  placeholder={'{ "BASE_URL": "https://example.com" }'}
                  onChange={(event) => setEnvText(event.target.value)}
                />
              </div>
              <div className="form-actions cypress-form-actions">
                {!canRun && (
                  <small className="cypress-muted">
                    {registry && !registry.enabled && canWrite
                      ? text("위 토글이 꺼져 있어도 여기서 직접 실행은 할 수 있습니다.", "Manual runs work here even while the toggle above is off.")
                      : runBlockedReason}
                  </small>
                )}
                <button
                  className="button primary"
                  type="button"
                  disabled={!canWrite || !selected.moduleReady || busy !== null || currentRun?.state === "running"}
                  title={runBlockedReason ?? undefined}
                  onClick={() => { void startRun(); }}
                >
                  {currentRun?.state === "running" ? <LoaderCircle size={13} className="spinning" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                  {busy === "run" ? text("시작 중…", "Starting…") : currentRun?.state === "running" ? text("실행 중…", "Running…") : text("실행", "Run")}
                </button>
              </div>

              {currentRun && <RunResult run={currentRun} />}

              {workspaceRuns.length > 0 && (
                <div className="cypress-recent-runs">
                  <div className="section-title"><h3>{text("최근 실행", "Recent runs")}</h3><span>{text(`${workspaceRuns.length}건`, `${workspaceRuns.length} runs`)}</span></div>
                  <ul>
                    {workspaceRuns.map((run) => (
                      <li key={run.jobId}>
                        <button type="button" className={run.jobId === currentRun?.jobId ? "active" : ""} onClick={() => setCurrentRun(run)}>
                          <span className={runStatePill(run.state)}>{run.state}</span>
                          <span className="cypress-run-summary" data-user-content>{summarizeCypressRun(run)}</span>
                          <time>{formatDate(run.startedAt)}</time>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
      {confirmDialog}
    </section>
  );
}

/**
 * 파일 편집기 화면. 상태는 `useCypressFileEditor`가 들고 있고 여기서는 그 한 덩어리를 그린다.
 * 바쁨 표시(`busy`)는 패널 전체가 공유하므로 그대로 받아 버튼을 막는다.
 */
function CypressFileEditorSection({ workspace, editor, canWrite, busy, showReadOnlyNote }: {
  workspace: CypressWorkspace;
  editor: CypressFileEditor;
  canWrite: boolean;
  busy: string | null;
  /** 접속 권한을 확인한 뒤 읽기 전용으로 판정됐을 때만 그 이유를 적는다. */
  showReadOnlyNote: boolean;
}) {
  const { text } = useI18n();
  const { activePath, activeContent, activeIsSensitive, activeIsMasked, activeEditable } = editor;
  return (
    <section className="settings-subsection">
      <header>
        <div>
          <strong>{text("파일 편집", "Files")}<span className="cypress-selected-name" data-user-content> · {workspace.name}</span></strong>
          <small>{text("cypress.config·cypress.env.json·e2e 스펙을 직접 고칩니다. 저장은 파일 단위로 바로 반영됩니다.", "Edit cypress.config, cypress.env.json, and e2e specs directly. Each save is applied immediately.")}</small>
        </div>
      </header>
      <div className="detail-card">
        {editor.fileError && <ErrorBanner message={editor.fileError} />}
        {editor.files === null && !editor.fileError ? (
          <p className="cypress-muted">{text("파일 목록을 불러오는 중…", "Loading files…")}</p>
        ) : (
          <div className="skill-editor">
            <div className="skill-editor-files">
              {editor.editorPaths.map((path) => (
                <div className={`skill-editor-file${path === activePath ? " active" : ""}`} key={path}>
                  <button type="button" onClick={() => editor.selectFile(path)} data-user-content>
                    {path}{editor.dirtyPaths.has(path) ? " *" : ""}
                  </button>
                  <button type="button" className="skill-editor-remove" title={text("파일 삭제", "Delete file")} disabled={!canWrite || busy !== null} onClick={() => { void editor.removeFile(path); }}>×</button>
                </div>
              ))}
              <div className="skill-editor-add">
                <input
                  value={editor.newFileName}
                  onChange={(event) => editor.setNewFileName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); editor.addFile(); } }}
                  placeholder={text("새 파일 경로 (예: e2e/login.cy.js)", "New file path (e.g. e2e/login.cy.js)")}
                  spellCheck={false}
                  disabled={!canWrite}
                />
                <button className="button compact" type="button" onClick={editor.addFile} disabled={!canWrite || !editor.newFileName.trim()}>{text("추가", "Add")}</button>
              </div>
            </div>
            {activePath === null ? (
              <p className="cypress-muted">{text("편집할 파일을 고르거나 새 파일을 추가하세요.", "Pick a file to edit or add a new one.")}</p>
            ) : (
              <div className="skill-editor-body">
                {activeIsSensitive && (
                  <div className="cypress-sensitive-bar">
                    <span className="skill-sync-pill conflict">{text("민감 파일 · 비밀정보", "Sensitive file · secrets")}</span>
                    {activeIsMasked
                      ? <small>{text("원격 읽기 전용 모드에서는 값이 가려져 보이며 편집·저장할 수 없습니다.", "Values are masked in remote read-only mode; editing and saving are disabled.")}</small>
                      : <small>{text("기본으로 내용을 숨깁니다. 편집하려면 펼치세요.", "Hidden by default. Reveal to edit.")}</small>}
                    <button className="button compact" type="button" onClick={editor.toggleReveal}>
                      {editor.revealSensitive ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
                      {editor.revealSensitive ? text("숨기기", "Hide") : text("내용 표시", "Reveal")}
                    </button>
                  </div>
                )}
                {activeContent === undefined ? (
                  <p className="cypress-muted">{text("파일을 읽는 중…", "Reading file…")}</p>
                ) : activeIsSensitive && !editor.revealSensitive ? (
                  <pre className="cypress-masked-view" aria-label={text("내용 숨김", "Content hidden")}>{maskContent(activeContent)}</pre>
                ) : (
                  <textarea
                    value={activeContent}
                    spellCheck={false}
                    readOnly={!activeEditable}
                    data-user-content
                    onChange={(event) => editor.editActiveContent(event.target.value)}
                  />
                )}
                <div className="form-actions cypress-form-actions">
                  {showReadOnlyNote && <small className="cypress-muted">{text("원격 편집이 꺼져 있어 읽기만 할 수 있습니다.", "Remote editing is off; files are read-only.")}</small>}
                  <button className="button" type="button" disabled={busy !== null} onClick={editor.reload}>
                    <RefreshCw size={13} aria-hidden="true" />{text("다시 읽기", "Reload")}
                  </button>
                  <button className="button primary" type="button" disabled={busy !== null || editor.dirtyPaths.size === 0 || !canWrite} onClick={() => { void editor.saveFiles(); }}>
                    {busy === "save" ? text("저장 중…", "Saving…") : text(`저장${editor.dirtyPaths.size > 0 ? ` (${editor.dirtyPaths.size})` : ""}`, `Save${editor.dirtyPaths.size > 0 ? ` (${editor.dirtyPaths.size})` : ""}`)}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function RunResult({ run }: { run: CypressRunStatus }) {
  const { text } = useI18n();
  const failed = failedCypressTests(run);
  const summary = run.summary;
  return (
    <div className="cypress-run-result" data-state={run.state}>
      <div className="cypress-run-head">
        <span className={runStatePill(run.state)}>{run.state}</span>
        <strong data-user-content>{summarizeCypressRun(run)}</strong>
        {run.state === "running" && <small>{text("2초마다 상태를 확인합니다.", "Checking status every 2 seconds.")}</small>}
      </div>
      {run.message && run.state !== "running" && <p className="cypress-run-message" data-user-content>{run.message}</p>}
      {summary && (
        <div className="cypress-run-counts">
          <span className="skill-sync-pill current">{text(`통과 ${summary.passed}`, `${summary.passed} passed`)}</span>
          <span className={`skill-sync-pill${summary.failed > 0 ? " conflict" : ""}`}>{text(`실패 ${summary.failed}`, `${summary.failed} failed`)}</span>
          <span className={`skill-sync-pill${summary.pending > 0 ? " partial" : ""}`}>{text(`보류 ${summary.pending}`, `${summary.pending} pending`)}</span>
          {summary.screenshots.length > 0 && <span className="skill-sync-pill">{text(`스크린샷 ${summary.screenshots.length}`, `${summary.screenshots.length} screenshots`)}</span>}
        </div>
      )}
      {failed.length > 0 && (
        <ul className="cypress-failed-tests">
          {failed.map(({ spec, test: item }, index) => (
            <li key={`${spec}-${index}`}>
              <strong data-user-content>{item.title}</strong>
              <small data-user-content>{spec}</small>
              {item.error && <pre data-user-content>{item.error}</pre>}
            </li>
          ))}
        </ul>
      )}
      {run.artifacts.length > 0 && (
        <div className="cypress-artifacts">
          <div className="section-title"><h3>{text("산출물", "Artifacts")}</h3><span>{text(`${run.artifacts.length}개`, `${run.artifacts.length} files`)}</span></div>
          <ul>
            {run.artifacts.map((artifact) => (
              <li key={artifact.path}>
                {artifact.content !== null && (artifact.kind === "json" || artifact.kind === "text") ? (
                  <details className="cypress-details">
                    <summary><code data-user-content>{artifact.path}</code> <span>{formatBytes(artifact.sizeBytes)}</span></summary>
                    <pre data-user-content>{artifact.content}</pre>
                  </details>
                ) : (
                  <span className="cypress-artifact-plain"><code data-user-content>{artifact.path}</code> <span>{formatBytes(artifact.sizeBytes)} · {artifact.kind}</span></span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {run.outputTail && (
        <details className="cypress-details">
          <summary>{text("실행 출력(끝부분)", "Output tail")}</summary>
          <pre data-user-content>{run.outputTail}</pre>
        </details>
      )}
    </div>
  );
}
