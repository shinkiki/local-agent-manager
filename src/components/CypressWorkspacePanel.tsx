import { Eye, EyeOff, LoaderCircle, Play, Plus, RefreshCw, Search, SquarePen, Square, StepForward, Trash2 } from "lucide-react";
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
  openCypressRunner,
  readCypressEnvFile,
  readCypressWorkspaceFile,
  removeCypressWorkspace,
  runCypressSpec,
  setCypressEnabled,
  setCypressWorkspaceOptions,
  stopCypressRun,
  writeCypressEnvFile,
  writeCypressWorkspaceFile,
  type WebAccessStatus,
} from "../lib/ipc";
import { cypressArtifactLabel, failedCypressTests, filterCypressFilePaths, isMissingCypressFile, isSensitiveCypressFile, parseEnvJsonText, specFiles, summarizeCypressRun, validateWorkspaceRelativePath } from "../lib/cypressWorkspace";
import type {
  CypressExecutionType,
  CypressRegistry,
  CypressRunArtifact,
  CypressRunState,
  CypressRunStatus,
  CypressRunSummary,
  CypressWorkspace,
  CypressWorkspaceFile,
  CypressWorkspaceFileContent,
} from "../types";
import { AppToggle, ErrorBanner, NoticeBanner, PathField, useConfirm, type ConfirmRequest } from "./Shared";
import { errorText } from "../lib/errorText";
import { codeLanguageForPath } from "../lib/codeHighlight";
import { displayPath } from "../lib/displayPath";
import { HighlightedCodeBlock } from "./LinkedFilePreview";
import { MarkdownPreview } from "./MarkdownPreview";

/** 실행 상태 폴링 간격. 스펙 하나가 수십 초는 걸리므로 더 촘촘할 필요가 없다. */
const RUN_POLL_INTERVAL_MS = 2000;

/** 파일 편집기가 처음 여는 파일. 목록에 있는 첫 항목을 고른다. */
const PREFERRED_FIRST_FILES = ["cypress.config.js", "cypress.config.ts", "cypress.config.mjs"];

/**
 * 편집기 상태를 불변으로 갱신하는 조각들. 경로 집합(마스킹·미저장)과 내용 맵은 `useState`
 * 갱신 함수 안에서 새 `Set`·객체를 짓고 한 항목만 넣거나 빼는 같은 네 줄을 여섯 자리에서
 * 되풀이했고, 그중 둘은 같은 일을 다른 모양(즉시 `.add()` 연쇄 대 지역 변수)으로 적고 있어
 * 읽을 때마다 다시 맞춰 봐야 했다. 갱신 함수 자리에 그대로 넣도록 함수를 돌려준다.
 */
const withPath = (path: string) => (current: Set<string>): Set<string> => new Set(current).add(path);

const withoutPaths = (...paths: string[]) => (current: Set<string>): Set<string> => {
  const next = new Set(current);
  for (const path of paths) next.delete(path);
  return next;
};

const withContent = (path: string, content: string) => (current: Record<string, string>): Record<string, string> => ({
  ...current,
  [path]: content,
});

const withoutContent = (path: string) => (current: Record<string, string>): Record<string, string> => {
  const next = { ...current };
  delete next[path];
  return next;
};


/** 민감 파일을 숨긴 상태로 보일 때 글자 수만 남기고 `•`로 바꾼다. 줄 구조는 유지한다. */
function maskContent(content: string): string {
  return content.replace(/[^\n]/g, "•");
}

/** 보기 모드에서 Markdown으로 그릴 파일인지. 나머지는 문법 강조한 코드로 보여 준다. */
function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

function runStatePill(state: CypressRunState): string {
  switch (state) {
    case "passed": return "skill-sync-pill current";
    case "running": return "skill-sync-pill partial";
    // 런처를 닫은 것은 실패가 아니다. 붉은 표시로 남기면 수동 점검마다 오류처럼 쌓인다.
    case "closed": return "skill-sync-pill";
    default: return "skill-sync-pill conflict";
  }
}

/**
 * 쓰기 조작(등록·설치·제거·파일 삭제·저장·중지)의 잠금 한 벌. 무엇 하나가 도는 동안
 * 나머지 버튼도 함께 막히고, 막힌 이유는 권한 쪽일 때만 적는다는 것이 이 패널의 규칙이다.
 *
 * 그 규칙이 `canWrite`·`busy`·`hostOnlyReason` 세 조각으로 흩어진 채 옆칸·머리줄·파일
 * 목록·편집기·실행 칸 다섯 곳에 각각 내려가, 받는 쪽마다 `!canWrite || busy !== null`과
 * `hostOnlyReason ?? undefined`를 다시 적고 있었다. 세 조각을 따로 내려보내면 어느
 * 컴포넌트가 셋 중 둘만 쓰는지 읽어서는 갈라지지 않고, 규칙을 고칠 때 다섯 자리를 모두
 * 찾아야 한다. 판정은 상태를 쥔 훅에서 한 번만 하고, 화면은 그 결과만 받는다.
 */
interface CypressWriteGate {
  /** 쓰기 권한 자체가 있는가. 바쁨과 무관하게 입력창·편집 가능 여부를 정하는 자리가 본다. */
  canWrite: boolean;
  /** 지금 쓰기 조작을 막아야 하는가(권한이 없거나 다른 조작이 도는 중). */
  blocked: boolean;
  /** 권한 때문에 막혔다면 그 이유. 바빠서 잠깐 막힌 것은 적을 이유가 없어 `null`이다. */
  reason: string | null;
}

/** 설치 바쁨 키의 머리. 키를 짓는 자리와 다시 풀어 읽는 자리가 같은 글자를 봐야 한다. */
const INSTALL_BUSY_PREFIX = "install-";

/**
 * 지금 어떤 조작이 도는지 가리키는 바쁨 키. 이 패널은 무엇이 돌든 나머지 버튼을 함께 막고,
 * 버튼 글자만 자기 키일 때 "저장 중…"처럼 바꾼다 — 그래서 키를 짓는 자리(훅 다섯 갈래)와
 * 읽는 자리(버튼 다섯 곳, 설치 중인 작업공간 찾기)가 같은 글자를 봐야 하는데, 양쪽 모두
 * 맨 문자열이라 한쪽에서 한 글자만 어긋나도 타입 검사가 잡지 못했다. 어긋나면 버튼은
 * 막히는데 글자만 그대로여서, 눌리지 않는 버튼이 평소와 똑같이 보인다.
 *
 * 작업공간 id가 붙는 셋은 템플릿 리터럴 타입으로 둔다 — 설치 키는 `busyInstallId`가 다시
 * 풀어 읽는 유일한 키라 머리 글자를 상수 하나로 묶어야 짓는 쪽과 읽는 쪽이 갈라지지 않는다.
 */
type CypressBusyKey =
  | "enabled"
  | "add"
  | "file"
  | "save"
  | "run"
  | "open"
  | "stop"
  | `${typeof INSTALL_BUSY_PREFIX}${string}`
  | `remove-${string}`
  | `options-${string}`;

/**
 * 바쁨 표시를 두른 비동기 실행 한 번. 편집기·실행기 두 훅이 인자로 받는 같은 서명을 제네릭
 * 채로 각자 한 줄씩 펼쳐 적고 있어, 오류 보고 인자를 하나 늘리면 세 자리를 함께 고쳐야 했다.
 */
type CypressRunBusy = <T,>(
  key: CypressBusyKey,
  report: (message: string) => void,
  action: () => Promise<T>,
) => Promise<T | null>;

/**
 * 호스트 전용 조작 버튼이 함께 받아야 하는 잠금·이유 한 쌍. 잠그기만 하고 이유를 빠뜨리면
 * 원격 화면에서는 눌리지 않는 버튼만 남아 왜 막혔는지 알 수 없다.
 */
function writeGateProps(gate: CypressWriteGate): { disabled: boolean; title: string | undefined } {
  return { disabled: gate.blocked, title: gate.reason ?? undefined };
}

/**
 * 훅이 아직 살아 있는지 묻는 문. 편집기 훅과 실행 훅이 폐기 깃발 ref와 그것을 뒤집는
 * 효과를 글자 하나 다르지 않게 각자 세워 두고 있었다 — 같은 장치가 두 벌이면 한쪽만
 * 고쳤을 때 언마운트 뒤 상태를 쓰는 쪽이 조용히 남는다. 깃발은 감추고 읽는 문만 준다.
 */
function useMountedGate(): () => boolean {
  const disposedRef = useRef(false);
  useEffect(() => {
    // StrictMode의 두 번째 마운트처럼 같은 ref가 재사용되는 경우가 있어 진입할 때 되돌린다.
    disposedRef.current = false;
    return () => { disposedRef.current = true; };
  }, []);
  return useCallback(() => !disposedRef.current, []);
}

/**
 * 살아 있는 동안에만 결과를 반영하는 비동기 읽기. 파일 내용·실행 상태·접속 권한·등록 목록을
 * 읽는 다섯 자리가 `then`에서 폐기 여부를 묻고 `catch`에서 다시 물어 오류 문구를 적는 같은
 * 두 걸음을 각자 적고 있었다. 폐기 여부를 묻는 방법(훅 수명이냐 효과 한 회차냐)은 자리마다
 * 다르므로 판단은 `alive`로 받고, 반영과 실패 기록의 모양만 한곳에 둔다.
 */
function settleWhileAlive<T>(
  promise: Promise<T>,
  alive: () => boolean,
  apply: (value: T) => void,
  fail: (message: string) => void,
): void {
  void promise
    .then((value) => { if (alive()) apply(value); })
    .catch((cause) => { if (alive()) fail(errorText(cause)); });
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
  runBusy: CypressRunBusy;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  onNotice: (message: string) => void;
}) {
  const { text } = useI18n();
  const [files, setFiles] = useState<CypressWorkspaceFile[] | null>(null);
  /** 목록이 상한에서 끊겼는지. 끊겼으면 안 보이는 파일이 있다고 알리고, 경로로 열게 안내한다. */
  const [truncated, setTruncated] = useState(false);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [maskedPaths, setMaskedPaths] = useState<Set<string>>(new Set());
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [newFileName, setNewFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [revealSensitive, setRevealSensitive] = useState(false);
  /**
   * 파일마다 편집 모드로 열어 두었는지. 값이 없는 파일은 미저장 변경이 있으면 편집으로,
   * 아니면 보기로 연다 — 방금 만든 파일이나 고치다 만 파일을 다시 골랐을 때 입력창이
   * 사라지지 않게 하려는 것이다.
   */
  const [editingPaths, setEditingPaths] = useState<Record<string, boolean>>({});
  const alive = useMountedGate();

  /** 작업공간 전환과 수동 재조회가 공유하는 편집기 초기 상태를 한곳에서 맞춘다. */
  const resetEditorState = useCallback(() => {
    setFiles(null);
    setTruncated(false);
    setContents({});
    setMaskedPaths(new Set());
    setDirtyPaths(new Set());
    setActivePath(null);
    setFileError(null);
    setRevealSensitive(false);
    setEditingPaths({});
  }, []);

  /**
   * 읽어온 파일 한 건을 편집기 상태에 반영한다. 활성 파일을 늦게 읽는 효과와 경로를 입력해
   * 여는 길이 "내용을 적고, 마스킹본이면 그 경로를 표시한다"는 같은 두 걸음을 각자 적고 있어
   * 한쪽만 고치면 어긋나는 자리였다.
   */
  const recordLoadedFile = useCallback((path: string, file: CypressWorkspaceFileContent) => {
    setContents(withContent(path, file.content));
    if (file.masked) setMaskedPaths(withPath(path));
  }, []);

  const loadFiles = useCallback(async (target: CypressWorkspace) => {
    resetEditorState();
    try {
      const listed = await listCypressWorkspaceFiles(target.id);
      if (!alive()) return;
      setFiles(listed.files);
      setTruncated(listed.truncated);
      const first = PREFERRED_FIRST_FILES.find((name) => listed.files.some((file) => file.path === name)) ?? listed.files[0]?.path ?? null;
      setActivePath(first);
    } catch (cause) {
      if (alive()) setFileError(errorText(cause));
    }
  }, [resetEditorState, alive]);

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
    settleWhileAlive(load(), () => !disposed, (file) => recordLoadedFile(path, file), setFileError);
    return () => { disposed = true; };
  }, [workspace?.id, activePath, contents, recordLoadedFile]);

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
  const activeEditing = activePath !== null && (editingPaths[activePath] ?? dirtyPaths.has(activePath));

  const selectFile = (path: string) => {
    setActivePath(path);
    setRevealSensitive(false);
    setFileError(null);
  };

  /**
   * 입력한 경로를 편집기에서 연다. 목록에 없다고 새 파일로 단정하지 않는다 — 목록이 실패했거나
   * 잘렸으면 이미 있는 파일도 목록 밖에 있고, 그걸 빈 내용으로 열면 저장하는 순간 원본이
   * 지워진다. 그래서 먼저 읽어 보고, "파일이 없습니다"일 때만 새 파일로 연다. 그 밖의 실패는
   * 새 파일로 착각하지 않고 그대로 보여 준다.
   */
  const addFile = async () => {
    const name = newFileName.trim().replace(/\\/g, "/");
    const problem = validateWorkspaceRelativePath(name);
    if (problem) {
      setFileError(problem);
      return;
    }
    if (editorPaths.includes(name)) {
      setActivePath(name);
      setNewFileName("");
      setFileError(null);
      return;
    }
    if (!workspace) return;
    setFileError(null);
    try {
      const file = await readCypressWorkspaceFile(workspace.id, name);
      if (!alive()) return;
      // 민감 파일은 여기서 받은 마스킹본을 쓰지 않는다. 활성 경로만 옮기면 내용 로딩 effect가
      // 원문 명령으로 다시 읽는다.
      if (!isSensitiveCypressFile(name)) {
        recordLoadedFile(name, file);
      }
      setActivePath(name);
      setRevealSensitive(false);
      setNewFileName("");
      return;
    } catch (cause) {
      if (!alive()) return;
      const message = errorText(cause);
      if (!isMissingCypressFile(message)) {
        setFileError(message);
        return;
      }
    }
    setContents(withContent(name, ""));
    setDirtyPaths(withPath(name));
    setActivePath(name);
    setNewFileName("");
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
    setContents(withoutContent(path));
    setDirtyPaths(withoutPaths(path));
    if (activePath === path) setActivePath(editorPaths.find((item) => item !== path) ?? null);
  };

  const saveFiles = async () => {
    if (!workspace || dirtyPaths.size === 0) return;
    setFileError(null);
    const saved: string[] = [];
    // 일부만 저장됐을 수 있으니 실패해도 성공한 경로만 dirty에서 뺀다.
    const report = (message: string) => {
      setDirtyPaths(withoutPaths(...saved));
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
      // 저장으로 미저장 표시가 사라져도 보던 모드는 그대로 둔다 — 저장 직후 편집창이 미리보기로
      // 바뀌어 이어 고칠 수 없던 일을 막는다.
      setEditingPaths((current) => {
        const next = { ...current };
        for (const path of saved) next[path] ??= true;
        return next;
      });
      onNotice(text(`파일 ${saved.length}개를 저장했습니다.`, `Saved ${saved.length} file(s).`));
    });
  };

  /** 활성 파일의 본문을 고친다. 편집이 막힌 상태에서는 무시한다(마스킹본·읽기 전용). */
  const editActiveContent = (value: string) => {
    const path = activePath;
    if (!activeEditable || path === null) return;
    setContents(withContent(path, value));
    setDirtyPaths(withPath(path));
  };

  /** 활성 파일의 보기·편집을 뒤집는다. 읽기 전용이면 편집으로 넘어가지 않는다. */
  const toggleActiveEditing = () => {
    const path = activePath;
    if (path === null) return;
    const next = !activeEditing;
    if (next && !activeEditable) return;
    setEditingPaths((current) => ({ ...current, [path]: next }));
  };

  const reload = () => {
    if (workspace) void loadFiles(workspace);
  };

  return {
    files,
    truncated,
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
    activeEditing,
    toggleActiveEditing,
    selectFile,
    addFile,
    removeFile,
    saveFiles,
    editActiveContent,
    reload,
  };
}

/** 실행기가 다루는 상태 한 벌. 패널 본문이 이 한 덩어리로 받는다. */
type CypressRunner = ReturnType<typeof useCypressRunner>;

/**
 * 스펙 실행의 상태·기동·따라보기를 한 곳에 모은다. 스펙 선택·추가 env·실행 오류·입력 안내·
 * 지금 보는 실행·최근 실행 목록은 늘 함께 움직이는데, 이 여섯 조각과 폴링 효과가 패널 본문에서
 * 등록·설치·편집기 상태와 뒤섞여 있어 어디까지가 실행기인지 읽어서는 갈라지지 않았다.
 * 편집기(`useCypressFileEditor`)가 이미 같은 모양으로 나가 있어 그 짝을 맞춘다.
 *
 * 바쁨 표시(`runBusy`)는 패널 전체가 공유하는 것이라 훅이 새로 만들지 않고 인자로 받는다 —
 * 실행을 기동하는 동안 등록·설치 버튼까지 함께 막히는 지금 동작을 그대로 두려는 것이다.
 */
function useCypressRunner({ workspace, active, runBusy }: {
  workspace: CypressWorkspace | null;
  /** 설정 화면이 보이는 동안만 실행 상태를 폴링한다. */
  active: boolean;
  runBusy: CypressRunBusy;
}) {
  const [specChoice, setSpecChoice] = useState("");
  const [envText, setEnvText] = useState("");
  const [runError, setRunError] = useState<string | null>(null);
  // QA #61. 서버에 보내기도 전에 화면이 걸러낸 입력 오류는 요청 실패가 아니다. 같은
  // runError에 담으면 '요청을 처리하지 못했습니다 · APP_RUNTIME'이 붙어, 한 번도 나간 적
  // 없는 요청이 실패한 것처럼 읽힌다(QA #59에서 갈라 둔 NoticeBanner 정책).
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [currentRun, setCurrentRun] = useState<CypressRunStatus | null>(null);
  const [runs, setRuns] = useState<CypressRunStatus[]>([]);
  const alive = useMountedGate();

  /** 새 실행 흐름을 시작할 때 이전 요청 오류와 입력 안내를 함께 걷는다. */
  const clearRunFeedback = useCallback(() => {
    setRunError(null);
    setRunNotice(null);
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      const list = await listCypressRuns();
      if (alive()) setRuns(list);
    } catch {
      // 최근 실행 목록은 보조 정보라 실패해도 패널을 막지 않는다.
    }
  }, [alive]);

  // 작업공간을 바꾸면 실행 상태를 그 작업공간 기준으로 되돌린다. 파일 목록·편집 상태는
  // 편집기 훅이 같은 기준으로 다시 읽는다.
  useEffect(() => {
    if (!workspace) return;
    setSpecChoice("");
    clearRunFeedback();
    setCurrentRun(null);
    void refreshRuns();
  }, [workspace?.id, clearRunFeedback, refreshRuns]);

  // 실행 중인 작업은 2초마다 상태를 묻고, 끝나면(또는 화면을 떠나면) 멈춘다.
  useEffect(() => {
    if (!active || !currentRun || currentRun.state !== "running") return;
    const jobId = currentRun.jobId;
    let disposed = false;
    const timer = setInterval(() => {
      settleWhileAlive(getCypressRunStatus(jobId), () => !disposed, (next) => {
        setCurrentRun(next);
        if (next.state !== "running") void refreshRuns();
      }, setRunError);
    }, RUN_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [active, currentRun?.jobId, currentRun?.state, refreshRuns]);

  /**
   * 실행과 런처 열기가 함께 쓰는 기동 절차. 추가 env를 읽어 넘기고, 시작한 잡을 따라보기
   * 대상으로 세운다. env 입력 오류는 요청을 보내기 전에 걸러 안내로 돌린다(QA #61).
   */
  const launch = async (key: "run" | "open", run: (target: CypressWorkspace, env: Record<string, string> | null) => Promise<CypressRunStatus>) => {
    if (!workspace) return;
    const env = parseEnvJsonText(envText);
    if (env instanceof Error) {
      setRunError(null);
      setRunNotice(env.message);
      return;
    }
    clearRunFeedback();
    await runBusy(key, setRunError, async () => {
      const status = await run(workspace, Object.keys(env).length > 0 ? env : null);
      setCurrentRun(status);
      void refreshRuns();
    });
  };

  const start = () => launch("run", (target, env) => runCypressSpec(target.id, specChoice || null, env));

  /** Cypress 런처를 띄운다. 스펙 고르기와 단계별 진행은 런처 안에서 사람이 한다. */
  const openRunner = () => launch("open", (target, env) => openCypressRunner(target.id, env));

  /**
   * 도는 실행을 끊는다. 런처 창은 호스트 화면에만 뜨므로 원격에서는 이 버튼이 창을 닫는
   * 유일한 길이다. 중지는 요청만 보내고, 끝난 상태는 평소 폴링이 가져온다.
   */
  const stop = async () => {
    const jobId = currentRun?.jobId;
    if (!jobId) return;
    clearRunFeedback();
    await runBusy("stop", setRunError, async () => {
      const status = await stopCypressRun(jobId);
      setCurrentRun(status);
    });
  };

  const workspaceRuns = useMemo(
    () => runs.filter((run) => !workspace || run.workspaceId === workspace.id).slice(0, 10),
    [runs, workspace],
  );

  return {
    specChoice,
    setSpecChoice,
    envText,
    setEnvText,
    runError,
    runNotice,
    currentRun,
    showRun: setCurrentRun,
    workspaceRuns,
    start,
    openRunner,
    stop,
  };
}

/** 등록 폼이 채우는 세 칸. 저장 전까지만 있는 값이라 `CypressWorkspace`와 따로 둔다. */
interface CypressWorkspaceDraft {
  name: string;
  path: string;
  moduleDir: string;
}

const EMPTY_WORKSPACE_DRAFT: CypressWorkspaceDraft = { name: "", path: "", moduleDir: "" };

/** 등록 폼 한 벌. 패널 본문과 폼이 이 한 덩어리로 주고받는다. */
type CypressWorkspaceForm = ReturnType<typeof useCypressWorkspaceForm>;

/**
 * 작업공간 등록 폼의 여닫힘·초안·초점을 한자리에 모은다. 이 여덟 조각이 레지스트리 훅의
 * 반환에 평평하게 섞여 있어 패널 본문이 등록과 무관한 자리에서도 같은 이름 여덟 개를 받아
 * 넘겨야 했고, 칸을 하나 늘릴 때마다 반환·구조분해 두 줄을 함께 고쳐야 했다.
 */
function useCypressWorkspaceForm() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CypressWorkspaceDraft>(EMPTY_WORKSPACE_DRAFT);
  const nameRef = useRef<HTMLInputElement | null>(null);
  // 등록 버튼은 왼쪽 중메뉴(sticky)에 있고 폼은 오른쪽 위에 열린다. 아래로 내려온 상태에서
  // 누르면 폼이 화면 밖에 열리므로 초점을 옮겨 그 자리로 끌어온다.
  useEffect(() => {
    if (!open) return;
    const input = nameRef.current;
    if (!input) return;
    input.scrollIntoView({ block: "nearest" });
    input.focus({ preventScroll: true });
  }, [open]);

  return {
    open,
    draft,
    nameRef,
    toggle: () => setOpen((current) => !current),
    close: () => setOpen(false),
    edit: (patch: Partial<CypressWorkspaceDraft>) => setDraft((current) => ({ ...current, ...patch })),
    /** 등록에 성공했을 때. 초안을 비우고 폼을 닫는다. */
    reset: () => {
      setDraft(EMPTY_WORKSPACE_DRAFT);
      setOpen(false);
    },
  };
}

/**
 * 작업공간 등록부의 상태·등록·설치를 한 곳에 모은다. 접속 권한·목록·고른 작업공간·알림·
 * 바쁨 표시·등록 폼은 늘 함께 움직이는데, 편집기와 실행기가 이미 훅으로 나간 뒤에도 이
 * 조각들만 패널 본문에 150줄로 남아 있어 화면 코드를 읽으려면 등록 배선을 먼저 지나야 했다.
 * 자매 훅 둘과 같은 모양으로 갈라낸다.
 *
 * 바쁨 표시(`runBusy`)는 세 갈래가 함께 쓰는 것이라 여기서 만들어 내보낸다 — 무엇을 하든
 * 나머지 버튼이 같이 막히는 지금 동작을 그대로 두려는 것이다.
 */
function useCypressRegistry({ confirm }: {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
}) {
  const { text } = useI18n();
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [registry, setRegistry] = useState<CypressRegistry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<CypressBusyKey | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installOutput, setInstallOutput] = useState<string | null>(null);

  const form = useCypressWorkspaceForm();

  // 쓰기 권한만 본다. 원격 write 모드면 호스트와 같게 설정·실행할 수 있고(C7, 2026-08-29 결정),
  // 원격 읽기 전용 모드에서는 변경 명령이 403이므로 버튼을 미리 막는다.
  const canWrite = access?.writable === true;
  const hostOnlyReason = access === null
    ? text("접속 권한을 확인하고 있습니다.", "Checking access.")
    : !canWrite
      ? text("원격 편집이 꺼져 있어 변경할 수 없습니다.", "Remote editing is off; changes are disabled.")
      : null;

  useEffect(() => {
    let disposed = false;
    const stillHere = () => !disposed;
    settleWhileAlive(getWebAccessStatus(), stillHere, setAccess, setError);
    settleWhileAlive(getCypressRegistry(), stillHere, (next) => {
      setRegistry(next);
      // 실행 대상은 사용자가 목록에서 직접 고른다. 첫 항목을 암묵적으로 선택하지 않는다.
      setSelectedId((current) => current && next.workspaces.some((item) => item.id === current) ? current : null);
    }, setError);
    return () => { disposed = true; };
  }, []);

  const selected = useMemo(
    () => registry?.workspaces.find((workspace) => workspace.id === selectedId) ?? null,
    [registry, selectedId],
  );

  /**
   * 바쁨 표시와 실패 처리를 한 벌로 묶는다. 등록 변경·설치·파일 삭제·저장·실행이 모두
   * `setBusy(key)` → 실행 → 실패하면 오류 문구 적기 → `finally setBusy(null)`을 똑같이
   * 되풀이하고, 다르던 것은 오류를 어디에 적느냐(`report`)뿐이었다. 실패는 삼키고 `null`을
   * 돌려주므로 호출부는 결과가 `null`인지로 성공 여부를 본다. 시작 전에 무엇을 비울지는
   * 갈래마다 달라(알림·설치 출력·실행 오류) 호출부에 그대로 남겼다.
   */
  const runBusy: CypressRunBusy = async (key, report, action) => {
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

  const mutate = (key: CypressBusyKey, action: () => Promise<CypressRegistry>) => {
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
    const name = form.draft.name.trim();
    const path = form.draft.path.trim();
    if (!name || !path) return;
    const moduleDir = form.draft.moduleDir.trim();
    // 백엔드가 경로를 정규화(심볼릭 링크·후행 슬래시)하므로 입력 경로로 못 찾으면 새로 생긴 항목으로 잡는다.
    const registryBefore = new Set((registry?.workspaces ?? []).map((workspace) => workspace.id));
    const next = await mutate("add", () => addCypressWorkspace(name, path, moduleDir ? moduleDir : null));
    if (!next) return;
    form.reset();
    const added = next.workspaces.find((workspace) => workspace.path === path)
      ?? next.workspaces.find((workspace) => !registryBefore.has(workspace.id))
      ?? null;
    if (added) setSelectedId(added.id);
    setNotice(text(`'${name}' 작업공간을 등록했습니다.`, `Registered workspace '${name}'.`));
    // 등록만 하고 끝나면 "설치 필요"인 채로 남아 사용자가 한 번 더 눌러야 했다. 모듈이 없으면
    // 바로 설치까지 이어 붙인다. 설치는 별도 busy 키라 목록 표시와 출력이 그대로 나온다.
    if (added && !added.moduleReady) {
      await install(added, { afterRegister: true });
    }
  };

  const removeWorkspace = async (workspace: CypressWorkspace) => {
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
    if (next && selectedId === workspace.id) setSelectedId(null);
  };

  const install = async (workspace: CypressWorkspace, options: { afterRegister?: boolean } = {}) => {
    setError(null);
    if (!options.afterRegister) setNotice(null);
    setInstallOutput(null);
    await runBusy(`${INSTALL_BUSY_PREFIX}${workspace.id}`, setError, async () => {
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

  /**
   * 작업공간에 저장하는 실행 옵션을 한 필드만 바꿔 보낸다. 실행 요청이 아니라 작업공간에
   * 붙는 값이라, 여기서 켜 두면 에이전트가 돌리는 실행에도 그대로 적용된다.
   */
  const changeRunOptions = (patch: { recordVideo?: boolean; headed?: boolean; executionType?: CypressExecutionType }) => {
    if (!selected) return;
    void mutate(`options-${selected.id}`, () => setCypressWorkspaceOptions(
      selected.id,
      patch.recordVideo ?? selected.recordVideo,
      patch.headed ?? selected.headed,
      patch.executionType ?? selected.executionType,
    ));
  };

  const busyInstallId = busy?.startsWith(INSTALL_BUSY_PREFIX) ? busy.slice(INSTALL_BUSY_PREFIX.length) : null;
  const writeGate: CypressWriteGate = { canWrite, blocked: !canWrite || busy !== null, reason: hostOnlyReason };

  return {
    access, registry, error, notice, setNotice, busy, busyInstallId,
    selectedId, setSelectedId, selected, installOutput, writeGate, runBusy,
    toggleEnabled, form,
    submitWorkspace, removeWorkspace, install, changeRunOptions,
  };
}

/**
 * 애드온 → Cypress 탭. 에이전트가 Cypress로 웹 테스트·정보 조회·크롤링·매크로를 돌릴 작업공간을
 * 관리한다. 등록·설치·실행·민감 파일 쓰기는 호스트 전용이므로 원격 접속에서는 버튼을 막고
 * 그 이유를 적는다. 파일 편집기는 스킬 편집기의 마크업·상태 패턴을 따르되 저장은 파일 단위다.
 */
export function CypressWorkspacePanel({ active }: {
  /** 설정 화면이 보이는 동안만 실행 상태를 폴링한다. */
  active: boolean;
}) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const {
    access, registry, error, notice, setNotice, busy, busyInstallId,
    selectedId, setSelectedId, selected, installOutput, writeGate, runBusy,
    toggleEnabled, form,
    submitWorkspace, removeWorkspace, install, changeRunOptions,
  } = useCypressRegistry({ confirm });

  // ---- 파일 편집기 ----

  const editor = useCypressFileEditor({ workspace: selected, canWrite: writeGate.canWrite, runBusy, confirm, onNotice: setNotice });

  // ---- 실행 ----

  const runner = useCypressRunner({ workspace: selected, active, runBusy });
  const specs = useMemo(() => specFiles(editor.files ?? []), [editor.files]);
  const canRun = writeGate.canWrite && selected !== null && selected.moduleReady && registry?.enabled !== false;
  const runBlockedReason = writeGate.reason
    ?? (!selected?.moduleReady ? text("Cypress 모듈을 먼저 설치하세요.", "Install the Cypress module first.") : null);
  // 토글이 꺼져 있어도 손으로 하는 실행은 막지 않으므로, 그때는 막힌 이유 대신 그 사실을 적는다.
  const runBlockedNote = registry && !registry.enabled && writeGate.canWrite
    ? text("위 토글이 꺼져 있어도 여기서 직접 실행은 할 수 있습니다.", "Manual runs work here even while the toggle above is off.")
    : runBlockedReason;

  // 원격 화면에서도 런처를 연다 — 실행과 같은 권한이고, 창이 호스트에 뜨는 것은 권한
  // 경계가 아니라 알아야 할 사실이다. 막는 대신 어디에 뜨는지 적고, 그 창을 원격에서 끊을
  // 수 있게 중지 버튼을 함께 둔다. 격리 실행도 막지 않는다 — 하네스가 임시 포트·상태로
  // 앱을 띄운 채 런처를 연다.
  const openHint = access?.remote
    ? text("런처 창은 앱이 떠 있는 호스트 화면에 열립니다. 여기서는 보이지 않으며, 중지로 끊을 수 있습니다.", "The launcher window opens on the host running this app. You will not see it here; use Stop to end it.")
    : text("Cypress 런처를 열어 스펙을 고르고 한 단계씩 진행합니다.", "Open the Cypress launcher to pick a spec and step through it.");

  return (
    <section className="settings-card cypress-panel" data-ui-anchor="addons.cypress-content">
      <header>
        <div>
          <span>{text("애드온", "Add-ons")}</span>
          <h2>{text("Cypress 자동화 작업공간", "Cypress automation workspaces")}</h2>
        </div>
        <p>{text(
          "에이전트가 브라우저 자동화 스크립트를 실행할 작업공간을 관리합니다. 설정·환경값·스펙 파일을 여기서 고치고 바로 실행해 볼 수 있습니다.",
          "Manage the workspaces where agents run browser automation scripts. Edit config, env, and spec files here and run them right away.",
        )}</p>
      </header>
      <div className="settings-card-sections">
        <section className="settings-subsection">
          <header>
            <div>
              <strong>{text("에이전트가 Cypress 자동화를 실행할 수 있음", "Agents may run Cypress automation")}</strong>
              <small>{text(
                "켜면 Claude·Codex·Antigravity와 AIA가 등록된 작업공간을 사용할 수 있습니다. 새 채팅부터 도구가 연결되며, 끄면 실행 중 채팅의 호출도 차단됩니다. 웹 테스트·정보 조회·크롤링·매크로에 씁니다.",
                "When on, Claude, Codex, Antigravity, and AIA can use these workspaces. New chats receive the tools; turning this off also blocks calls from existing chats.",
              )}</small>
              {writeGate.reason && <small className="cypress-host-note">{writeGate.reason}</small>}
            </div>
            <AppToggle
              checked={registry?.enabled ?? false}
              disabled={writeGate.blocked || !registry}
              label={text("에이전트가 Cypress 자동화를 실행할 수 있음", "Agents may run Cypress automation")}
              onChange={toggleEnabled}
            />
          </header>
          {error && <div className="cypress-banner"><ErrorBanner message={error} /></div>}
          {notice && <p className="cypress-notice" role="status">{notice}</p>}
        </section>

        <div className="cypress-layout">
          <CypressWorkspaceNav
            registry={registry}
            selectedId={selectedId}
            busyInstallId={busyInstallId}
            gate={writeGate}
            form={form}
            onSelect={setSelectedId}
          />

          <div className="cypress-workspace-main">
            {form.open && <CypressWorkspaceForm form={form} busy={busy} onSubmit={submitWorkspace} />}

            {selected && (
              <CypressWorkspaceDetailHeader
                workspace={selected}
                busyInstallId={busyInstallId}
                gate={writeGate}
                installOutput={installOutput}
                onInstall={install}
                onRemove={removeWorkspace}
              />
            )}

            {selected && (
              <CypressFileEditorSection
                workspace={selected}
                editor={editor}
                gate={writeGate}
                busy={busy}
                showReadOnlyNote={!writeGate.canWrite && access !== null}
              />
            )}

            {selected && (
              <CypressRunSection
                workspace={selected}
                runner={runner}
                specs={specs}
                gate={writeGate}
                busy={busy}
                canRun={canRun}
                runBlockedReason={runBlockedReason}
                runBlockedNote={runBlockedNote}
                openHint={openHint}
                onChangeOptions={changeRunOptions}
              />
            )}
          </div>
        </div>
      </div>
      {confirmDialog}
    </section>
  );
}

/**
 * 작업공간 경로 한 줄. 목록 행과 상세 머리줄이 "줄인 경로를 본문과 title에 함께 적고
 * 사용자 내용으로 표시한다"는 같은 세 가지를 각자 적고 있었다 — `displayPath`를 한쪽에만
 * 씌우거나 `data-user-content`를 빠뜨려도 읽어서는 갈라지지 않는 자리라 한 벌로 모은다.
 */
function CypressWorkspacePath({ path }: { path: string }) {
  const shown = displayPath(path);
  return <span className="project-registry-path" title={shown} data-user-content>{shown}</span>;
}

/** 목록의 작업공간 한 행. 이름 옆 배지로 격리 실행·모듈 상태·실행 옵션을 함께 보인다. */
function CypressWorkspaceRow({ workspace, selected, installing, onSelect }: {
  workspace: CypressWorkspace;
  selected: boolean;
  installing: boolean;
  onSelect: (id: string) => void;
}) {
  const { text } = useI18n();
  return (
    <li className={`cypress-workspace-row${selected ? " selected" : ""}`}>
      <button type="button" className="cypress-workspace-select" onClick={() => onSelect(workspace.id)} aria-pressed={selected}>
        <span className="project-registry-name">
          <strong data-user-content>{workspace.name}</strong>
          {workspace.executionType === "agentManagerIsolated" && <span className="skill-sync-pill current">{text("격리 실행", "Isolated run")}</span>}
          {installing
            ? <span className="skill-sync-pill partial"><LoaderCircle size={11} className="spinning" aria-hidden="true" />{text("설치 중", "Installing")}</span>
            : workspace.moduleReady
              ? <span className="skill-sync-pill">{`Cypress ${workspace.cypressVersion ?? ""}`.trim()}</span>
              : <span className="skill-sync-pill partial">{text("Cypress 설치 필요", "Cypress not installed")}</span>}
          {workspace.recordVideo && <span className="skill-sync-pill">{text("영상 저장", "Video")}</span>}
          {workspace.headed && <span className="skill-sync-pill">{text("창 표시", "Windowed")}</span>}
        </span>
        <CypressWorkspacePath path={workspace.path} />
      </button>
    </li>
  );
}

/**
 * 등록된 작업공간을 고르는 옆칸. 자매 구역(등록 폼·파일 편집기·실행)은 이미 각자 컴포넌트인데
 * 이 목록만 패널 본문에 40줄로 눌러앉아 있어, 본문을 읽어도 어디까지가 옆칸인지 갈라지지
 * 않았다. 상태는 전부 `useCypressRegistry`가 쥐고 있어 여기에는 배치만 있다.
 */
function CypressWorkspaceNav({ registry, selectedId, busyInstallId, gate, form, onSelect }: {
  registry: CypressRegistry | null;
  selectedId: string | null;
  busyInstallId: string | null;
  gate: CypressWriteGate;
  form: CypressWorkspaceForm;
  onSelect: (id: string) => void;
}) {
  const { text } = useI18n();
  return (
    <aside className="cypress-workspace-nav" aria-label={text("작업공간", "Workspaces")}>
      <section className="settings-subsection">
        <header>
          <div>
            <strong>{text("작업공간", "Workspaces")}</strong>
            <small>{text("테스트할 Cypress 프로젝트를 작업공간으로 추가합니다. 실행 전에는 목록에서 대상을 명시적으로 선택해야 합니다.", "Add each Cypress project as a workspace. You must explicitly select a target before running it.")}</small>
          </div>
          <button className="button compact" type="button" {...writeGateProps(gate)} aria-expanded={form.open} onClick={form.toggle}>
            <Plus size={13} aria-hidden="true" />{text("작업공간 추가", "Add workspace")}
          </button>
        </header>
        {!registry ? (
          <p className="project-registry-empty">{text("작업공간을 불러오는 중…", "Loading workspaces…")}</p>
        ) : registry.workspaces.length === 0 ? (
          <p className="project-registry-empty">{text("등록된 작업공간이 없습니다.", "No workspaces registered.")}</p>
        ) : (
          <ul className="cypress-workspace-list" role="list">
            {registry.workspaces.map((workspace) => (
              <CypressWorkspaceRow
                key={workspace.id}
                workspace={workspace}
                selected={workspace.id === selectedId}
                installing={busyInstallId === workspace.id}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}

/**
 * 고른 작업공간의 머리줄. 경로·모듈 위치와 설치·제거 조작, 그리고 방금 돌린 설치 출력을
 * 함께 둔다. 조작은 전부 부모의 함수가 하므로 여기에는 상태가 없다.
 */
function CypressWorkspaceDetailHeader({ workspace, busyInstallId, gate, installOutput, onInstall, onRemove }: {
  workspace: CypressWorkspace;
  busyInstallId: string | null;
  gate: CypressWriteGate;
  installOutput: string | null;
  onInstall: (workspace: CypressWorkspace) => void | Promise<unknown>;
  onRemove: (workspace: CypressWorkspace) => void | Promise<unknown>;
}) {
  const { text } = useI18n();
  const installing = busyInstallId === workspace.id;
  return (
    <section className="settings-subsection cypress-workspace-detail">
      <header>
        <div>
          <strong data-user-content>{workspace.name}</strong>
          <small>
            <CypressWorkspacePath path={workspace.path} />
            {workspace.moduleDir && <span className="project-registry-meta"><span>{text("모듈", "Module")}: <code data-user-content>{displayPath(workspace.moduleDir)}</code></span></span>}
          </small>
        </div>
        <div className="cypress-workspace-actions">
          {!workspace.moduleReady && (
            <button className="button compact" type="button" {...writeGateProps(gate)} onClick={() => { void onInstall(workspace); }}>
              {installing ? <LoaderCircle size={13} className="spinning" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
              {installing ? text("설치 중… (최대 15분)", "Installing… (up to 15 min)") : text("설치", "Install")}
            </button>
          )}
          <button className="button compact danger" type="button" {...writeGateProps(gate)} onClick={() => { void onRemove(workspace); }}>
            <Trash2 size={13} aria-hidden="true" />{text("제거", "Remove")}
          </button>
        </div>
      </header>
      {installOutput && (
        <details className="cypress-details cypress-install-output">
          <summary>{text("설치 출력", "Install output")}</summary>
          <pre data-user-content>{installOutput}</pre>
        </details>
      )}
    </section>
  );
}

/** 작업공간에 저장되는 실행 옵션 한 줄. 설명이 길어 토글만 있는 자리보다 한 단 크게 그린다. */
/** 새 작업공간 등록 폼. 상태는 전부 `useCypressWorkspaceForm`이 쥐고 있어 여기에는 배치만 있다. */
function CypressWorkspaceForm({ form, busy, onSubmit }: {
  form: CypressWorkspaceForm;
  busy: CypressBusyKey | null;
  onSubmit: () => Promise<void>;
}) {
  const { text } = useI18n();
  const { draft } = form;
  return (
    <section className="settings-subsection">
      <header>
        <div>
          <strong>{text("작업공간 추가", "Add workspace")}</strong>
          <small>{text("cypress.config.*가 있으면 그 프로젝트를 그대로 쓰고, 없으면 템플릿을 깔고 Cypress 설치까지 이어서 합니다.", "A folder with cypress.config.* is used as is; otherwise a template is scaffolded and Cypress is installed right after.")}</small>
        </div>
      </header>
      <div className="detail-card cypress-form">
        <div className="form-row">
          <label htmlFor="cypress-new-name">{text("이름", "Name")}</label>
          <input id="cypress-new-name" ref={form.nameRef} value={draft.name} onChange={(event) => form.edit({ name: event.target.value })} placeholder={text("예: 사내 포털 테스트", "e.g. Intranet tests")} />
        </div>
        <div className="form-row">
          <label htmlFor="cypress-new-path">{text("폴더", "Folder")}</label>
          <PathField id="cypress-new-path" value={draft.path} onChange={(path) => form.edit({ path })} placeholder="/path/to/cypress-project" />
        </div>
        <div className="form-row">
          <label htmlFor="cypress-new-module">{text("Cypress 모듈 위치", "Cypress module dir")}</label>
          <div>
            <PathField id="cypress-new-module" value={draft.moduleDir} onChange={(moduleDir) => form.edit({ moduleDir })} placeholder={text("(선택) 비우면 폴더 안에 설치", "(optional) leave empty to install inside the folder")} />
          </div>
        </div>
        <div className="form-actions cypress-form-actions">
          <button className="button" type="button" disabled={busy !== null} onClick={form.close}>{text("취소", "Cancel")}</button>
          <button className="button primary" type="button" disabled={busy !== null || !draft.name.trim() || !draft.path.trim()} onClick={() => { void onSubmit(); }}>
            {busy === "add" ? text("등록 중…", "Registering…") : text("등록", "Register")}
          </button>
        </div>
      </div>
    </section>
  );
}

function CypressRunOption({ title, hint, checked, disabled, onChange }: {
  title: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="cypress-run-option">
      <div>
        <strong>{title}</strong>
        <small>{hint}</small>
      </div>
      <AppToggle checked={checked} disabled={disabled} label={title} onChange={onChange} />
    </div>
  );
}

/**
 * 보기 모드 본문. Markdown은 문서로 그리고 그 밖의 파일은 문법 강조한 코드로 보여 준다.
 * 두 미리보기 모두 앱의 다른 화면(문서 창·링크 미리보기)이 쓰는 것을 그대로 쓴다.
 */
function CypressFileView({ path, content }: { path: string; content: string }) {
  const { text } = useI18n();
  const language = useMemo(() => codeLanguageForPath(path), [path]);

  if (isMarkdownPath(path)) {
    return (
      <div className="cypress-file-view markdown" aria-label={text("문서 미리보기", "Document preview")}>
        <MarkdownPreview source={content} compact />
      </div>
    );
  }

  return (
    <div className="cypress-file-view">
      <HighlightedCodeBlock
        content={content}
        language={language}
        ariaLabel={text("읽기 전용 미리보기", "Read-only preview")}
      />
    </div>
  );
}

/**
 * 편집할 파일을 고르는 왼쪽 칸 — 검색·목록·새 파일 추가. 편집기 구획은 이 칸과 오른쪽 본문
 * 두 덩어리인데, 왼쪽만 쓰는 검색어 상태와 그 파생(보이는 경로·작업공간이 바뀌면 비우기)이
 * 구획 머리에 얹혀 있어 오른쪽 본문을 읽을 때도 함께 읽혔다. 상태를 쓰는 자리로 내린다.
 */
function CypressFilePicker({ workspaceId, editor, gate }: {
  /** 작업공간이 바뀌면 검색어를 비운다. 앞 작업공간의 낱말이 남아 새 목록이 텅 빈 것처럼 보였다. */
  workspaceId: string;
  editor: CypressFileEditor;
  gate: CypressWriteGate;
}) {
  const { text } = useI18n();
  const { activePath } = editor;
  const [query, setQuery] = useState("");
  useEffect(() => { setQuery(""); }, [workspaceId]);
  const visiblePaths = useMemo(
    () => filterCypressFilePaths(editor.editorPaths, query, activePath),
    [editor.editorPaths, query, activePath],
  );
  return (
    <div className="cypress-file-picker">
      <div className="cypress-file-search">
        <Search size={13} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={text("파일 검색", "Search files")}
          aria-label={text("파일 검색", "Search files")}
          spellCheck={false}
        />
        <span>{query.trim()
          ? text(`${visiblePaths.length} / ${editor.editorPaths.length}개`, `${visiblePaths.length} / ${editor.editorPaths.length}`)
          : text(`${editor.editorPaths.length}개`, `${editor.editorPaths.length} files`)}</span>
      </div>
      {visiblePaths.length === 0 ? (
        <p className="cypress-muted">{query.trim()
          ? text("검색과 맞는 파일이 없습니다.", "No file matches the search.")
          : text("작업공간에 파일이 없습니다. 아래에 경로를 적어 새 파일을 만드세요.", "This workspace has no files yet. Type a path below to create one.")}</p>
      ) : (
        <ul className="cypress-file-list">
          {visiblePaths.map((path) => {
            const cut = path.lastIndexOf("/") + 1;
            return (
              <li className={path === activePath ? "active" : ""} key={path}>
                <button type="button" title={path} aria-pressed={path === activePath} onClick={() => editor.selectFile(path)} data-user-content>
                  {cut > 0 && <span className="cypress-file-dir">{path.slice(0, cut)}</span>}
                  <span className="cypress-file-name">{path.slice(cut)}</span>
                  {editor.dirtyPaths.has(path) && <span className="cypress-file-dirty" title={text("저장하지 않은 변경", "Unsaved change")} aria-hidden="true">●</span>}
                </button>
                <button type="button" className="cypress-file-remove" title={text("파일 삭제", "Delete file")} disabled={gate.blocked} onClick={() => { void editor.removeFile(path); }}>×</button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="skill-editor-add cypress-file-add">
        <input
          value={editor.newFileName}
          onChange={(event) => editor.setNewFileName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void editor.addFile(); } }}
          placeholder={text("새 파일 경로 (예: e2e/login.cy.js)", "New file path (e.g. e2e/login.cy.js)")}
          spellCheck={false}
          disabled={!gate.canWrite}
        />
        <button className="button compact" type="button" onClick={() => { void editor.addFile(); }} disabled={!gate.canWrite || !editor.newFileName.trim()}>{text("추가", "Add")}</button>
      </div>
    </div>
  );
}

/**
 * 작업공간에 매인 구역의 머리글. 파일 편집·실행 두 구역이 "제목 옆에 고른 작업공간 이름을
 * 사용자 내용으로 붙이고 그 아래 설명 한 줄을 단다"는 같은 모양을 각자 적고 있었다 —
 * 한쪽에서 `data-user-content`를 빠뜨리거나 구분자를 바꿔도 화면을 나란히 놓기 전에는
 * 갈라진 것이 보이지 않는 자리라 한 벌로 둔다.
 */
function CypressSectionHeader({ title, workspaceName, note }: {
  title: string;
  workspaceName: string;
  note: string;
}) {
  return (
    <header>
      <div>
        <strong>{title}<span className="cypress-selected-name" data-user-content> · {workspaceName}</span></strong>
        <small>{note}</small>
      </div>
    </header>
  );
}

/**
 * 활성 파일 한 줄: 경로·미저장 표시·보기↔편집 전환. 편집이 막힌 까닭(읽기 전용)은 전환
 * 버튼의 설명으로만 드러나므로 잠금과 문구를 한자리에 둔다. 민감 파일은 아래 숨김/표시 줄이
 * 같은 자리를 이미 맡고 있어 전환 버튼을 내주지 않는다.
 */
function CypressActiveFileBar({ path, dirty, sensitive, editing, editable, onToggleEditing }: {
  path: string;
  dirty: boolean;
  sensitive: boolean;
  editing: boolean;
  editable: boolean;
  onToggleEditing: () => void;
}) {
  const { text } = useI18n();
  return (
    <div className="cypress-file-active">
      <code title={path} data-user-content>{path}</code>
      {dirty && <span className="skill-sync-pill partial">{text("저장 안 됨", "Unsaved")}</span>}
      {!sensitive && (
        <button
          className="button compact cypress-file-mode"
          type="button"
          aria-pressed={editing}
          disabled={!editing && !editable}
          title={editing
            ? text("보기 모드로", "Switch to view")
            : editable ? text("편집 모드로", "Switch to edit") : text("읽기 전용이라 편집할 수 없습니다.", "Read-only; editing is disabled.")}
          onClick={onToggleEditing}
        >
          {editing ? <Eye size={13} aria-hidden="true" /> : <SquarePen size={13} aria-hidden="true" />}
          {editing ? text("보기", "View") : text("편집", "Edit")}
        </button>
      )}
    </div>
  );
}

/** 민감 파일임을 알리고 숨김/표시를 뒤집는 줄. 마스킹본이면 편집이 막힌 까닭도 함께 적는다. */
function CypressSensitiveBar({ masked, revealed, onToggleReveal }: {
  masked: boolean;
  revealed: boolean;
  onToggleReveal: () => void;
}) {
  const { text } = useI18n();
  return (
    <div className="cypress-sensitive-bar">
      <span className="skill-sync-pill conflict">{text("민감 파일 · 비밀정보", "Sensitive file · secrets")}</span>
      {masked
        ? <small>{text("원격 읽기 전용 모드에서는 값이 가려져 보이며 편집·저장할 수 없습니다.", "Values are masked in remote read-only mode; editing and saving are disabled.")}</small>
        : <small>{text("기본으로 내용을 숨깁니다. 편집하려면 펼치세요.", "Hidden by default. Reveal to edit.")}</small>}
      <button className="button compact" type="button" onClick={onToggleReveal}>
        {revealed ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
        {revealed ? text("숨기기", "Hide") : text("내용 표시", "Reveal")}
      </button>
    </div>
  );
}

/**
 * 활성 파일의 본문. 아직 못 읽었을 때·가린 민감 파일·편집창·미리보기 네 갈래가 구역 한복판에
 * 삼중 삼항으로 접혀 있어, 어떤 조건에서 무엇이 보이는지 읽으려면 갈래 사이에 낀 20줄짜리
 * JSX를 매번 넘어가야 했다. 갈래를 세우는 일만 여기로 옮겨 조건이 한눈에 보이게 한다.
 */
function CypressActiveFileBody({ path, content, sensitive, revealed, editing, editable, onEdit }: {
  path: string;
  /** 아직 읽지 못한 파일은 `undefined`. */
  content: string | undefined;
  sensitive: boolean;
  revealed: boolean;
  editing: boolean;
  editable: boolean;
  onEdit: (value: string) => void;
}) {
  const { text } = useI18n();
  if (content === undefined) {
    return <p className="cypress-muted">{text("파일을 읽는 중…", "Reading file…")}</p>;
  }
  if (sensitive && !revealed) {
    return <pre className="cypress-masked-view" aria-label={text("내용 숨김", "Content hidden")}>{maskContent(content)}</pre>;
  }
  // 민감 파일은 펼친 순간부터 편집창으로 연다 — 보기 모드가 따로 없어 전환 버튼도 내주지 않는다.
  if (sensitive || editing) {
    return (
      <textarea
        value={content}
        spellCheck={false}
        readOnly={!editable}
        data-user-content
        onChange={(event) => onEdit(event.target.value)}
      />
    );
  }
  return <CypressFileView path={path} content={content} />;
}

/**
 * 파일 편집기 화면. 상태는 `useCypressFileEditor`가 들고 있고 여기서는 그 한 덩어리를 그린다.
 * 바쁨 표시(`busy`)는 패널 전체가 공유하므로 그대로 받아 버튼을 막는다. 활성 파일의 머리줄·
 * 민감 파일 줄·본문 갈래는 이름 있는 조각으로 나가 있고, 여기에는 배치와 저장·다시 읽기만 남는다.
 */
function CypressFileEditorSection({ workspace, editor, gate, busy, showReadOnlyNote }: {
  workspace: CypressWorkspace;
  editor: CypressFileEditor;
  gate: CypressWriteGate;
  busy: CypressBusyKey | null;
  /** 접속 권한을 확인한 뒤 읽기 전용으로 판정됐을 때만 그 이유를 적는다. */
  showReadOnlyNote: boolean;
}) {
  const { text } = useI18n();
  const { activePath, activeContent, activeIsSensitive, activeIsMasked, activeEditable, activeEditing } = editor;
  return (
    <section className="settings-subsection">
      <CypressSectionHeader
        title={text("파일 편집", "Files")}
        workspaceName={workspace.name}
        note={text("cypress.config·cypress.env.json·e2e 스펙을 직접 고칩니다. 저장은 파일 단위로 바로 반영됩니다.", "Edit cypress.config, cypress.env.json, and e2e specs directly. Each save is applied immediately.")}
      />
      <div className="detail-card">
        {editor.fileError && <ErrorBanner message={editor.fileError} />}
        {editor.truncated && (
          <p className="cypress-muted">
            {text(
              "파일이 많아 목록을 일부만 보여 줍니다. 목록에 없는 파일도 위 입력란에 경로를 적으면 그대로 열립니다.",
              "Too many files to list them all. A file missing from the list still opens if you type its path above.",
            )}
          </p>
        )}
        {editor.files === null && !editor.fileError ? (
          <p className="cypress-muted">{text("파일 목록을 불러오는 중…", "Loading files…")}</p>
        ) : (
          <div className="skill-editor cypress-editor">
            <CypressFilePicker workspaceId={workspace.id} editor={editor} gate={gate} />
            {activePath === null ? (
              <p className="cypress-muted">{text("편집할 파일을 고르거나 새 파일을 추가하세요.", "Pick a file to edit or add a new one.")}</p>
            ) : (
              <div className="skill-editor-body">
                <CypressActiveFileBar
                  path={activePath}
                  dirty={editor.dirtyPaths.has(activePath)}
                  sensitive={activeIsSensitive}
                  editing={activeEditing}
                  editable={activeEditable}
                  onToggleEditing={editor.toggleActiveEditing}
                />
                {activeIsSensitive && (
                  <CypressSensitiveBar
                    masked={activeIsMasked}
                    revealed={editor.revealSensitive}
                    onToggleReveal={editor.toggleReveal}
                  />
                )}
                <CypressActiveFileBody
                  path={activePath}
                  content={activeContent}
                  sensitive={activeIsSensitive}
                  revealed={editor.revealSensitive}
                  editing={activeEditing}
                  editable={activeEditable}
                  onEdit={editor.editActiveContent}
                />
                <div className="form-actions cypress-form-actions">
                  {showReadOnlyNote && <small className="cypress-muted">{text("원격 편집이 꺼져 있어 읽기만 할 수 있습니다.", "Remote editing is off; files are read-only.")}</small>}
                  <button className="button" type="button" disabled={busy !== null} onClick={editor.reload}>
                    <RefreshCw size={13} aria-hidden="true" />{text("다시 읽기", "Reload")}
                  </button>
                  <button className="button primary" type="button" disabled={busy !== null || editor.dirtyPaths.size === 0 || !gate.canWrite} onClick={() => { void editor.saveFiles(); }}>
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

/**
 * 스펙 실행 자리. 상태는 `useCypressRunner`가 들고, 무엇을 막을지(권한·설치·지금 도는 실행)는
 * 패널이 판단해 넘긴다 — 같은 판단이 설치·제거 버튼에도 쓰이기 때문이다.
 */
function CypressRunSection({ workspace, runner, specs, gate, busy, canRun, runBlockedReason, runBlockedNote, openHint, onChangeOptions }: {
  workspace: CypressWorkspace;
  runner: CypressRunner;
  specs: CypressWorkspaceFile[];
  gate: CypressWriteGate;
  busy: CypressBusyKey | null;
  canRun: boolean;
  /** 실행 버튼의 툴팁에 적을 막힌 이유. */
  runBlockedReason: string | null;
  /** 버튼 옆에 적을 안내. 막힌 이유이거나, 토글이 꺼졌을 뿐 실행은 된다는 설명이다. */
  runBlockedNote: string | null;
  /** 런처 열기 버튼의 툴팁. 원격 화면에서는 창이 어디에 뜨는지 함께 적는다. */
  openHint: string;
  onChangeOptions: (patch: { recordVideo?: boolean; headed?: boolean; executionType?: CypressExecutionType }) => void;
}) {
  const { text } = useI18n();
  const running = runner.currentRun?.state === "running";
  // 실행 중에는 옵션을 잠근다. 지금 도는 실행에는 반영되지 않아 화면과 실제가 어긋난다.
  const optionsDisabled = gate.blocked || running;
  /**
   * 실행을 새로 띄우는 두 버튼(실행·런처 열기)의 잠금. 쓰기 잠금에 더해 모듈이 깔려 있어야
   * 하고 도는 실행이 없어야 한다는 같은 네 조각을 두 버튼이 글자 그대로 되풀이하고 있었다.
   * 실행 칸의 문구(`runBlockedNote`)가 보는 `canRun`은 토글까지 함께 세는 별개의 판정이라
   * 그대로 두고, 버튼이 실제로 막히는 조건만 여기 한 줄로 세운다.
   */
  const launchDisabled = optionsDisabled || !workspace.moduleReady;
  return (
    <section className="settings-subsection">
      <CypressSectionHeader
        title={text("실행", "Run")}
        workspaceName={workspace.name}
        note={text(
          "스펙 하나 또는 전체를 실행하고 결과·산출물을 확인합니다. 기본은 창 없이(헤드리스) 돕니다. 한 단계씩 끊어 보려면 런처를 여세요.",
          "Run one spec or all of them and inspect results and artifacts. Runs are headless unless you turn the window on. Open the launcher to step through a spec.",
        )}
      />
      <div className="detail-card">
        {runner.runNotice && <NoticeBanner message={runner.runNotice} />}
        {runner.runError && <ErrorBanner message={runner.runError} />}
        <div className="form-row">
          <label htmlFor="cypress-execution-type">{text("실행 방식", "Execution type")}</label>
          <div>
            <select
              id="cypress-execution-type"
              value={workspace.executionType}
              disabled={optionsDisabled}
              onChange={(event) => onChangeOptions({ executionType: event.target.value as CypressExecutionType })}
            >
              <option value="standard">{text("표준 실행", "Standard run")}</option>
              <option value="agentManagerIsolated">{text("격리 실행", "Isolated run")}</option>
            </select>
            <small className="cypress-muted">
              {workspace.executionType === "agentManagerIsolated"
                ? text("이 프로젝트의 scripts/e2e.mjs 하네스가 임시 포트·임시 상태로 앱을 띄웠다 정리합니다. 하네스가 없으면 실행할 때 거절합니다.", "The project's own scripts/e2e.mjs harness starts the app on a temporary port with temporary state and cleans it up. Without that harness the run is refused.")
                : text("등록한 Cypress 설정과 대상 URL을 그대로 사용합니다.", "Uses the registered Cypress configuration and target URL as-is.")}
            </small>
          </div>
        </div>
        <div className="cypress-run-options">
          <CypressRunOption
            title={text("실행 장면 영상 저장", "Record the run as video")}
            hint={text(
              "실행 전체를 영상으로 남겨 산출물에 함께 보여 줍니다. 파일이 커지고 실행도 느려집니다.",
              "Saves the whole run as a video listed with the artifacts. Files get large and runs get slower.",
            )}
            checked={workspace.recordVideo}
            disabled={optionsDisabled}
            onChange={(next) => onChangeOptions({ recordVideo: next })}
          />
          <CypressRunOption
            title={text("브라우저 창 띄우고 실행", "Run with a visible browser window")}
            hint={text(
              "실행 장면을 눈으로 볼 수 있습니다. 창은 이 앱이 떠 있는 호스트 화면에만 나타나므로, 원격 화면이나 무인 회차에서는 켜 두어도 보이지 않습니다.",
              "Lets you watch the run. The window only appears on the host running this app, so it stays invisible from a remote screen or an unattended round.",
            )}
            checked={workspace.headed}
            disabled={optionsDisabled}
            onChange={(next) => onChangeOptions({ headed: next })}
          />
        </div>
        <div className="form-row">
          <label htmlFor="cypress-spec">{text("스펙", "Spec")}</label>
          <select id="cypress-spec" value={runner.specChoice} onChange={(event) => runner.setSpecChoice(event.target.value)} data-user-content>
            <option value="">{text("전체", "All specs")}</option>
            {specs.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="cypress-env">{text("추가 env", "Extra env")}</label>
          <textarea
            id="cypress-env"
            value={runner.envText}
            rows={3}
            spellCheck={false}
            data-user-content
            placeholder={'{ "BASE_URL": "https://example.com" }'}
            onChange={(event) => runner.setEnvText(event.target.value)}
          />
        </div>
        <div className="form-actions cypress-form-actions">
          {!canRun && <small className="cypress-muted">{runBlockedNote}</small>}
          {running && (
            <button
              className="button danger"
              type="button"
              disabled={gate.blocked}
              title={text("도는 실행을 끊습니다. 런처는 창을 닫는 것과 같습니다.", "Ends the live run. For a launcher this is the same as closing its window.")}
              onClick={() => { void runner.stop(); }}
            >
              <Square size={13} aria-hidden="true" />
              {busy === "stop" ? text("중지 중…", "Stopping…") : text("중지", "Stop")}
            </button>
          )}
          <button
            className="button"
            type="button"
            disabled={launchDisabled}
            title={runBlockedReason ?? openHint}
            onClick={() => { void runner.openRunner(); }}
          >
            <StepForward size={13} aria-hidden="true" />
            {busy === "open" ? text("여는 중…", "Opening…") : text("런처 열기", "Open launcher")}
          </button>
          <button
            className="button primary"
            type="button"
            disabled={launchDisabled}
            title={runBlockedReason ?? undefined}
            onClick={() => { void runner.start(); }}
          >
            {running ? <LoaderCircle size={13} className="spinning" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
            {busy === "run" ? text("시작 중…", "Starting…") : running ? text("실행 중…", "Running…") : text("실행", "Run")}
          </button>
        </div>

        {runner.currentRun && <RunResult run={runner.currentRun} />}

        {runner.workspaceRuns.length > 0 && (
          <div className="cypress-recent-runs">
            <div className="section-title"><h3>{text("최근 실행", "Recent runs")}</h3><span>{text(`${runner.workspaceRuns.length}건`, `${runner.workspaceRuns.length} runs`)}</span></div>
            <ul>
              {runner.workspaceRuns.map((run) => (
                <li key={run.jobId}>
                  <button type="button" className={run.jobId === runner.currentRun?.jobId ? "active" : ""} onClick={() => runner.showRun(run)}>
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
  );
}

function RunResult({ run }: { run: CypressRunStatus }) {
  const { text } = useI18n();
  const failed = failedCypressTests(run);
  return (
    <div className="cypress-run-result" data-state={run.state}>
      <div className="cypress-run-head">
        <span className={runStatePill(run.state)}>{run.state}</span>
        <strong data-user-content>{summarizeCypressRun(run)}</strong>
        {run.state === "running" && (
          <small>{run.mode === "open"
            ? text("런처가 열려 있습니다. 스펙을 고르고 cy.pause()로 한 단계씩 진행하세요. 창을 닫으면 끝납니다.", "The launcher is open. Pick a spec and step through it with cy.pause(). Closing the window ends this run.")
            : text("2초마다 상태를 확인합니다.", "Checking status every 2 seconds.")}</small>
        )}
      </div>
      {run.message && run.state !== "running" && <p className="cypress-run-message" data-user-content>{run.message}</p>}
      {run.summary && <CypressRunCounts summary={run.summary} />}
      {failed.length > 0 && <CypressFailedTests failed={failed} />}
      {run.artifacts.length > 0 && <CypressArtifacts artifacts={run.artifacts} jobId={run.jobId} />}
      {run.outputTail && (
        <details className="cypress-details">
          <summary>{text("실행 출력(끝부분)", "Output tail")}</summary>
          <pre data-user-content>{run.outputTail}</pre>
        </details>
      )}
    </div>
  );
}

function CypressRunCounts({ summary }: { summary: CypressRunSummary }) {
  const { text } = useI18n();
  return (
    <div className="cypress-run-counts">
      <span className="skill-sync-pill current">{text(`통과 ${summary.passed}`, `${summary.passed} passed`)}</span>
      <span className={`skill-sync-pill${summary.failed > 0 ? " conflict" : ""}`}>{text(`실패 ${summary.failed}`, `${summary.failed} failed`)}</span>
      <span className={`skill-sync-pill${summary.pending > 0 ? " partial" : ""}`}>{text(`보류 ${summary.pending}`, `${summary.pending} pending`)}</span>
      {summary.screenshots.length > 0 && <span className="skill-sync-pill">{text(`스크린샷 ${summary.screenshots.length}`, `${summary.screenshots.length} screenshots`)}</span>}
    </div>
  );
}

function CypressFailedTests({ failed }: { failed: ReturnType<typeof failedCypressTests> }) {
  return (
    <ul className="cypress-failed-tests">
      {failed.map(({ spec, test: item }, index) => (
        <li key={`${spec}-${index}`}>
          <strong data-user-content>{item.title}</strong>
          <small data-user-content>{spec}</small>
          {item.error && <pre data-user-content>{item.error}</pre>}
        </li>
      ))}
    </ul>
  );
}

function CypressArtifacts({ artifacts, jobId }: { artifacts: CypressRunArtifact[]; jobId: string }) {
  const { text } = useI18n();
  return (
    <div className="cypress-artifacts">
      <div className="section-title"><h3>{text("산출물", "Artifacts")}</h3><span>{text(`${artifacts.length}개`, `${artifacts.length} files`)}</span></div>
      <p className="cypress-artifact-root">{text("작업공간 폴더 기준", "Relative to the workspace folder")} <code data-user-content>{`artifacts/runs/${jobId}/`}</code></p>
      <ul>
        {artifacts.map((artifact) => {
          // 잡 폴더 접두를 뗀 짧은 이름을 보이고, 전체 경로는 툴팁으로 남긴다.
          const label = cypressArtifactLabel(artifact.path);
          return (
            <li key={artifact.path}>
              {artifact.content !== null && (artifact.kind === "json" || artifact.kind === "text") ? (
                <details className="cypress-details">
                  <summary title={artifact.path}><code data-user-content>{label}</code> <span>{formatBytes(artifact.sizeBytes)}</span></summary>
                  <pre data-user-content>{artifact.content}</pre>
                </details>
              ) : (
                <span className="cypress-artifact-plain" title={artifact.path}><code data-user-content>{label}</code> <span>{formatBytes(artifact.sizeBytes)} · {artifact.kind}</span></span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
