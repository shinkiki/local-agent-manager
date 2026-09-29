/**
 * 세션 목록 왼쪽의 폴더 창 한 벌. 폴더 트리 그리기, 만들기·이름·색상·위치·순서·숨김
 * 편집, 삭제 확인, 접힘 상태 보관까지 폴더에만 쓰이는 조각이 3500줄짜리 세션 화면 안에
 * 흩어져 있어, 세션 목록·상세를 고치는 사람이 매번 그 사이를 지나가야 했다. 밖에서 쓰는
 * 것은 `SessionFolderSidebar`와 고른 폴더를 가리키는 `FolderFilter`뿐이므로 나머지는
 * 이 모듈 안에 닫아 둔다.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, CircleDashed, Eye, EyeOff, Folder, GripVertical, LayoutGrid, PanelLeftClose, Pencil, Plus, Trash2, X } from "lucide-react";
import {
  createSessionFolder,
  deleteSessionFolder,
  reorderSessionFolder,
  updateSessionFolder,
} from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import {
  canAddChildFolder,
  folderParentOptions,
  folderPathLabel,
  folderSubtreeIds,
  hiddenByFolders,
  hiddenFolderIds,
  recountSessionFolders,
  ROOT_FOLDER_VALUE,
} from "../lib/sessionFolders";
import { useBusyAction } from "./Shared";
import { readStoredText, writeStoredText } from "../lib/storedText";
import type { SessionFolder, SessionSummary } from "../types";

/** 세션 목록이 어느 폴더로 좁혀져 있는지. 폴더 ID 외에 전체·미분류 두 가상 값을 갖는다. */
export type FolderFilter = "all" | "unfiled" | string;

/** 폴더 편집 행이 들고 있는 초안. 저장을 누르기 전까지는 여기에만 쌓이고 목록은 그대로 둔다. */
interface FolderEditDraft {
  id: string;
  name: string;
  color: string;
  /** 상위 폴더 선택 상자의 값. 최상위는 ROOT_FOLDER_VALUE다. */
  parent: string;
}

function folderEditDraft(folder: SessionFolder): FolderEditDraft {
  return {
    id: folder.id,
    name: folder.name,
    color: folder.color,
    parent: folder.parentId ?? ROOT_FOLDER_VALUE,
  };
}

/** 서버가 돌려준 한 폴더만 같은 ID의 기존 항목 자리에 넣는다. */
function replaceSessionFolder(folders: SessionFolder[], updated: SessionFolder): SessionFolder[] {
  return folders.map((folder) => folder.id === updated.id ? updated : folder);
}

/** 폴더 행 하나를 그리는 데 필요한, 형제·자식 관계에서만 나오는 값. */
interface FolderTreeMeta {
  /** 직속 하위 폴더 수. 접기 화살표를 그릴지 정한다. */
  childCount: number;
  first: boolean;
  last: boolean;
}

/**
 * 폴더별 자식 수와 형제 순서를 한 번의 순회로 모은다. 둘 다 같은 목록을 같은 기준(상위 폴더로
 * 묶기)으로 훑던 것이라 따로 돌 이유가 없었다. 목록이 트리 순서로 오므로 같은 상위끼리 모으면
 * 그대로 형제 순서다.
 */
function folderTreeMeta(folders: SessionFolder[]): Map<string, FolderTreeMeta> {
  const siblings = new Map<string, string[]>();
  for (const folder of folders) {
    const key = folder.parentId ?? ROOT_FOLDER_VALUE;
    const bucket = siblings.get(key) ?? [];
    bucket.push(folder.id);
    siblings.set(key, bucket);
  }
  const meta = new Map<string, FolderTreeMeta>();
  for (const bucket of siblings.values()) {
    bucket.forEach((id, index) => meta.set(id, {
      childCount: siblings.get(id)?.length ?? 0,
      first: index === 0,
      last: index === bucket.length - 1,
    }));
  }
  return meta;
}

/** 접힌 폴더의 자손을 걷어낸 목록. 목록이 트리 순서로 오므로 접힌 조상을 만난 폴더부터 아래로 함께 감춘다. */
function foldersOutsideCollapsed(folders: SessionFolder[], collapsed: Set<string>): SessionFolder[] {
  const hiddenParents = new Set<string>();
  return folders.filter((folder) => {
    const parentId = folder.parentId ?? null;
    if (parentId && (hiddenParents.has(parentId) || collapsed.has(parentId))) {
      hiddenParents.add(folder.id);
      return false;
    }
    return true;
  });
}

/**
 * 폴더 패널의 편집 상태와 변경 절차. 생성·편집 초안, 접힘 상태의 저장, busy·오류 봉투,
 * 그리고 그 봉투를 쓰는 다섯 갈래 변경(생성·저장·숨김·순서·삭제)은 언제나 함께 움직이는데
 * 폴더 목록을 그리는 컴포넌트 안에 섞여 있어, 트리 한 줄을 고치려 해도 그 절차 전부를
 * 지나쳐야 했다. 절차만 이 훅으로 떼어 내 `patchCollapsed`·`expandFolder`·`runFolderAction`
 * 세 봉투를 훅 안에 가두고, 화면에는 손잡이만 내보낸다. 편집 행을 스크롤 안으로 끌어오는
 * 일은 그린 뒤의 DOM을 만지는 화면 몫이라 컴포넌트에 남긴다.
 */
function useSessionFolderEditor(
  folders: SessionFolder[],
  active: FolderFilter,
  onFoldersChanged: (folders: SessionFolder[], deletedFolderIds?: string[]) => void,
  onSelect: (folder: FolderFilter) => void,
) {
  // 폴더를 만들 때 고른 상위 폴더. `null`은 최상위, 여는 중이 아니면 undefined.
  const [creatingParent, setCreatingParent] = useState<string | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#f0b054");
  // 편집 행의 이름·색상·상위 폴더는 늘 같은 폴더 하나를 가리킨다. 칸마다 상태를 따로 두면
  // 편집 대상만 바뀌고 나머지 칸이 이전 폴더 값으로 남는 갈래가 생겨, 한 벌 초안으로 묶는다.
  const [editing, setEditing] = useState<FolderEditDraft | null>(null);
  const editingId = editing?.id ?? null;
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsedFolders);
  const [deleteCandidate, setDeleteCandidate] = useState<SessionFolder | null>(null);
  // 폴더 변경은 한 번에 하나뿐이라 어느 갈래가 도는지 가릴 필요가 없다. 공용 봉투의
  // 토큰은 자리만 채우고, 화면에는 "도는 중"인지만 boolean으로 내린다.
  const { busy: runningFolderAction, error, setError, run } = useBusyAction();
  const busy = runningFolderAction !== null;

  // 접힘 상태를 고치는 세 갈래가 모두 같은 봉투(복사 · 저장 · 반영)를 쓴다. 저장을 갈래마다
  // 되풀이하면 한 곳만 빠져도 다음 실행에서 그 변경이 사라진다. 봉투는 여기 한 벌만 둔다.
  const patchCollapsed = (change: (current: Set<string>) => Set<string> | null) => {
    setCollapsed((current) => {
      const next = change(current);
      if (!next) return current;
      writeCollapsedFolders(next);
      return next;
    });
  };

  const toggleCollapsed = (id: string) => {
    patchCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const expandFolder = (id: string | null) => {
    if (!id) return;
    patchCollapsed((current) => {
      if (!current.has(id)) return null;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const startCreating = (parentId: string | null) => {
    setCreatingParent(parentId);
    setName("");
    setError(null);
  };

  // 폴더 변경 다섯 갈래가 모두 같은 봉투(busy 표시 · 이전 오류 비우기 · 실패 문구 표시)를
  // 쓴다. 봉투는 공용 훅이 들고, 갈래마다 다른 선행 조건은 호출부에 남긴다.
  const runFolderAction = (action: () => Promise<void>) => run("folder", action);

  const createFolder = async () => {
    if (!name.trim() || busy || creatingParent === undefined) return;
    await runFolderAction(async () => {
      const folder = await createSessionFolder(name, color, creatingParent);
      onFoldersChanged([...folders, folder]);
      expandFolder(creatingParent);
      setName("");
      setCreatingParent(undefined);
      onSelect(folder.id);
    });
  };

  const startEditing = (folder: SessionFolder) => {
    setEditing(folderEditDraft(folder));
    setError(null);
  };

  const saveFolder = async (draft: FolderEditDraft) => {
    if (!draft.name.trim() || busy) return;
    await runFolderAction(async () => {
      const parentId = draft.parent === ROOT_FOLDER_VALUE ? null : draft.parent;
      const updated = await updateSessionFolder(draft.id, { name: draft.name, color: draft.color, parentId });
      onFoldersChanged(replaceSessionFolder(folders, updated));
      expandFolder(parentId);
      setEditing(null);
    });
  };

  // 숨김은 폴더를 지우지 않고 전체 목록·상위 폴더 집계에서만 뺀다. 보던 폴더를 그대로
  // 두는 것은 의도한 동작이다 — 숨긴 폴더를 직접 누르는 것이 그 안을 보는 길이다.
  const toggleHidden = async (folder: SessionFolder) => {
    if (busy) return;
    await runFolderAction(async () => {
      const updated = await updateSessionFolder(folder.id, { hidden: !folder.hidden });
      onFoldersChanged(replaceSessionFolder(folders, updated));
    });
  };

  // 순서는 형제 사이에서 한 칸씩 옮긴다. 백엔드가 다시 매긴 목록을 그대로 받아 쓴다.
  const moveFolder = async (folder: SessionFolder, direction: "up" | "down") => {
    if (busy) return;
    await runFolderAction(async () => {
      onFoldersChanged(await reorderSessionFolder(folder.id, direction));
    });
  };

  const removeFolder = async (folder: SessionFolder) => {
    await runFolderAction(async () => {
      const removed = await deleteSessionFolder(folder.id);
      const removedIds = removed.length > 0 ? removed : [folder.id];
      onFoldersChanged(folders.filter((item) => !removedIds.includes(item.id)), removedIds);
      patchCollapsed((current) => new Set([...current].filter((id) => !removedIds.includes(id))));
      if (removedIds.includes(active)) onSelect("all");
      setDeleteCandidate(null);
    });
  };

  return {
    creatingParent, setCreatingParent,
    name, setName,
    color, setColor,
    editing, setEditing, editingId,
    collapsed,
    deleteCandidate, setDeleteCandidate,
    busy, error,
    toggleCollapsed, startCreating, createFolder,
    startEditing, saveFolder, toggleHidden, moveFolder, removeFolder,
  };
}

export function SessionFolderSidebar({
  sessions,
  scopedSessions,
  folders,
  active,
  draggedSession,
  dropTarget,
  onSelect,
  onFoldersChanged,
  onClose,
  closeButtonRef,
}: {
  sessions: SessionSummary[];
  /** 폴더 조건을 뺀 현재 필터 결과. 배지 개수는 목록과 같은 이 기준으로 센다. */
  scopedSessions: SessionSummary[];
  folders: SessionFolder[];
  active: FolderFilter;
  draggedSession: SessionSummary | null;
  dropTarget: string | null;
  onSelect: (folder: FolderFilter) => void;
  onFoldersChanged: (folders: SessionFolder[], deletedFolderIds?: string[]) => void;
  onClose: () => void;
  closeButtonRef: { current: HTMLButtonElement | null };
}) {
  const {
    creatingParent, setCreatingParent,
    name, setName,
    color, setColor,
    editing, setEditing, editingId,
    collapsed,
    deleteCandidate, setDeleteCandidate,
    busy, error,
    toggleCollapsed, startCreating, createFolder,
    startEditing, saveFolder, toggleHidden, moveFolder, removeFolder,
  } = useSessionFolderEditor(folders, active, onFoldersChanged, onSelect);
  const { text } = useI18n();
  // 편집 행은 목록(.folder-list) 안에서 열리는데, 목록 아랫줄 폴더에서는 행이 스크롤 영역
  // 밖으로 자라 안내 푸터 아래에 가린 채 열렸다(QA #44). 행이 그려진 뒤 목록 안으로 끌어온다.
  const editRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (editingId === null) return;
    editRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [editingId]);
  const unfiledCount = scopedSessions.filter((session) => session.meta.folderIds.length === 0).length;
  const unfiledTotal = sessions.filter((session) => session.meta.folderIds.length === 0).length;
  // 전체 세션 배지는 목록과 같은 기준으로 센다. 숨긴 폴더에만 담긴 세션은 목록에서
  // 빠지므로 여기에서도 빠져야 한다.
  const hiddenFolders = useMemo(() => hiddenFolderIds(folders), [folders]);
  const visibleScoped = useMemo(
    () => scopedSessions.filter((session) => !hiddenByFolders(session.meta.folderIds, hiddenFolders)),
    [scopedSessions, hiddenFolders],
  );
  const visibleTotal = useMemo(
    () => sessions.filter((session) => !hiddenByFolders(session.meta.folderIds, hiddenFolders)).length,
    [sessions, hiddenFolders],
  );
  // 폴더 배지도 같은 기준으로 다시 센다. 백엔드 개수는 숨김·보관·서브에이전트까지 포함하므로
  // 필터를 켠 화면에서는 눌러도 비어 있는 개수가 된다.
  const scopedCounts = useMemo(() => {
    const counted = recountSessionFolders(folders, scopedSessions);
    return new Map(counted.map((folder) => [folder.id, folder]));
  }, [folders, scopedSessions]);
  const countHint = (visible: number, total: number) => (
    visible === total
      ? text(`${total}건`, `${total} sessions`)
      : text(`현재 필터로 보이는 ${visible}건 (전체 ${total}건)`, `${visible} visible with current filter (${total} total)`)
  );

  const treeMeta = useMemo(() => folderTreeMeta(folders), [folders]);
  const visibleFolders = useMemo(() => foldersOutsideCollapsed(folders, collapsed), [folders, collapsed]);

  const nestableFolders = useMemo(() => folders.filter(canAddChildFolder), [folders]);
  const editingParentOptions = useMemo(
    () => (editingId ? folderParentOptions(folders, editingId) : []),
    [folders, editingId],
  );


  return (
    <aside className="session-folders" id="session-folders" data-ui-anchor="sessions.folders">
      <header>
        <div><strong>{text("폴더", "Folders")}</strong><span>{folders.length}</span></div>
        <div className="secondary-pane-header-actions"><button className="folder-add-button" type="button" onClick={() => creatingParent === undefined ? startCreating(null) : setCreatingParent(undefined)} title={text("최상위 폴더 추가", "Add top-level folder")} aria-label={text("최상위 폴더 추가", "Add top-level folder")} aria-expanded={creatingParent !== undefined}><Plus size={15} /></button><button ref={closeButtonRef} className="secondary-pane-toggle" type="button" onClick={onClose} aria-label={text("세션 폴더 숨기기", "Hide session folders")} title={text("세션 폴더 숨기기", "Hide session folders")}><PanelLeftClose size={15} /></button></div>
      </header>
      {creatingParent !== undefined && (
        <SessionFolderCreateForm
          color={color}
          name={name}
          creatingParent={creatingParent}
          folders={folders}
          nestableFolders={nestableFolders}
          busy={busy}
          onColorChange={setColor}
          onNameChange={setName}
          onCreatingParentChange={setCreatingParent}
          onCreate={createFolder}
          onCancel={() => setCreatingParent(undefined)}
        />
      )}
      {deleteCandidate && (
        <SessionFolderDeleteConfirm
          folders={folders}
          candidate={deleteCandidate}
          busy={busy}
          onConfirm={() => void removeFolder(deleteCandidate)}
          onCancel={() => setDeleteCandidate(null)}
        />
      )}
      {error && <p className="folder-error">{error}</p>}
      <div className="folder-list">
        <button className={active === "all" ? "folder-filter active" : "folder-filter"} type="button" title={countHint(visibleScoped.length, visibleTotal)} onClick={() => onSelect("all")}>
          <span className="folder-symbol all"><LayoutGrid size={14} strokeWidth={1.8} /></span><strong>{text("전체 세션", "All sessions")}</strong><em>{visibleScoped.length}</em>
        </button>
        <button
          data-folder-drop-id="unfiled"
          className={`${active === "unfiled" ? "folder-filter active" : "folder-filter"}${dropTarget === "unfiled" ? " drop-target" : ""}`}
          type="button"
          title={countHint(unfiledCount, unfiledTotal)}
          onClick={() => onSelect("unfiled")}
        >
          <span className="folder-symbol unfiled"><CircleDashed size={14} /></span><strong>{text("미분류", "Unfiled")}</strong><em>{unfiledCount}</em>
        </button>
        <div className="folder-divider"><span>{text("내 폴더", "My folders")}</span>{draggedSession && <em>{text("여기에 놓아 추가", "Drop here to add")}</em>}</div>
        {visibleFolders.map((folder) => {
          const meta = treeMeta.get(folder.id);
          const scoped = scopedCounts.get(folder.id);
          const sessionCount = scoped?.sessionCount ?? 0;
          const draft = editing?.id === folder.id ? editing : null;
          return draft ? (
            <SessionFolderEditRow
              key={folder.id}
              rowRef={editRowRef}
              folder={folder}
              folders={folders}
              draft={draft}
              meta={meta}
              parentOptions={editingParentOptions}
              busy={busy}
              onDraftChange={setEditing}
              onCancel={() => setEditing(null)}
              onSave={saveFolder}
              onMove={moveFolder}
              onToggleHidden={toggleHidden}
              onAddChild={(parentId) => { setEditing(null); startCreating(parentId); }}
              onDelete={setDeleteCandidate}
            />
          ) : (
            <SessionFolderEntryRow
              key={folder.id}
              folder={folder}
              folders={folders}
              active={active === folder.id}
              dropTarget={dropTarget === folder.id}
              collapsed={collapsed.has(folder.id)}
              childCount={meta?.childCount ?? 0}
              sessionCount={sessionCount}
              nestedSessionCount={(scoped?.totalSessionCount ?? 0) - sessionCount}
              countHint={countHint}
              onToggleCollapsed={toggleCollapsed}
              onSelect={onSelect}
              onStartEditing={startEditing}
            />
          );
        })}
      </div>
      <footer>
        <span><GripVertical size={13} /></span> {text("세션 행을 폴더로 드래그하세요.", "Drag session rows into a folder.")}
      </footer>
    </aside>
  );
}

const SESSION_FOLDER_COLLAPSED_KEY = "agent-manager.session-folders-collapsed";

/** 상위 폴더 선택 상자의 항목. 새 폴더 칸과 편집 행이 같은 표기(경로가 붙은 이름)로 고른다. */
function FolderParentOptions({ folders, options }: { folders: SessionFolder[]; options: SessionFolder[] }) {
  const { text } = useI18n();
  return <>
    <option value={ROOT_FOLDER_VALUE}>{text("최상위", "Top level")}</option>
    {options.map((option) => <option key={option.id} value={option.id}>{folderPathLabel(folders, option.id)}</option>)}
  </>;
}

/** 새 폴더 생성 폼. 색상, 이름, 상위 폴더 선택 및 등록/취소 버튼을 묶는다. */
function SessionFolderCreateForm({
  color,
  name,
  creatingParent,
  folders,
  nestableFolders,
  busy,
  onColorChange,
  onNameChange,
  onCreatingParentChange,
  onCreate,
  onCancel,
}: {
  color: string;
  name: string;
  creatingParent: string | null;
  folders: SessionFolder[];
  nestableFolders: SessionFolder[];
  busy: boolean;
  onColorChange: (color: string) => void;
  onNameChange: (name: string) => void;
  onCreatingParentChange: (parent: string | null) => void;
  onCreate: () => void;
  onCancel: () => void;
}) {
  const { text } = useI18n();
  return (
    <div className="folder-create-form">
      <div>
        <input
          type="color"
          value={color}
          onChange={(event) => onColorChange(event.target.value)}
          aria-label={text("폴더 색상", "Folder color")}
        />
        <input
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && onCreate()}
          placeholder={text("새 폴더 이름", "New folder name")}
          autoFocus
        />
      </div>
      <label className="folder-parent-field">
        <span>{text("상위 폴더", "Parent folder")}</span>
        <select
          value={creatingParent ?? ROOT_FOLDER_VALUE}
          onChange={(event) => onCreatingParentChange(event.target.value === ROOT_FOLDER_VALUE ? null : event.target.value)}
        >
          <FolderParentOptions folders={folders} options={nestableFolders} />
        </select>
      </label>
      <div>
        <button type="button" onClick={onCancel}>{text("취소", "Cancel")}</button>
        <button className="primary" type="button" disabled={!name.trim() || busy} onClick={onCreate}>{text("추가", "Add")}</button>
      </div>
    </div>
  );
}

/** 폴더 삭제 확인 다이얼로그. 하위 폴더 개수 안내와 삭제/취소 조작을 묶는다. */
function SessionFolderDeleteConfirm({
  folders,
  candidate,
  busy,
  onConfirm,
  onCancel,
}: {
  folders: SessionFolder[];
  candidate: SessionFolder;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { text } = useI18n();
  const descendantCount = folderSubtreeIds(folders, candidate.id).size - 1;
  return (
    <div className="folder-delete-confirm" role="alertdialog" aria-label={text("폴더 삭제 확인", "Confirm folder deletion")}>
      <p>
        {text(`'${folderPathLabel(folders, candidate.id)}' 폴더를 삭제할까요?`, `Delete folder '${folderPathLabel(folders, candidate.id)}'?`)}
        {descendantCount > 0 && text(` 하위 폴더 ${descendantCount}개도 함께 삭제됩니다.`, ` ${descendantCount} subfolder(s) will also be deleted.`)}
        {text(" 세션과 원본 대화는 삭제되지 않습니다.", " Sessions and original conversations will not be deleted.")}
      </p>
      <div>
        <button type="button" disabled={busy} onClick={onCancel}>{text("취소", "Cancel")}</button>
        <button className="danger" type="button" disabled={busy} onClick={onConfirm}>
          {busy ? text("삭제 중…", "Deleting…") : text("삭제", "Delete")}
        </button>
      </div>
    </div>
  );
}

/**
 * 편집 중인 폴더 한 줄. 이름·색상·상위 폴더 초안과 순서·숨김·하위 추가·삭제 버튼이 모두
 * 여기에 모인다. 초안은 부모가 들고 있다 — 목록에 편집 행은 한 번에 하나뿐이라 상태를
 * 줄마다 두면 어느 줄이 열려 있는지 목록이 다시 알아내야 한다.
 */
function SessionFolderEditRow({
  rowRef,
  folder,
  folders,
  draft,
  meta,
  parentOptions,
  busy,
  onDraftChange,
  onCancel,
  onSave,
  onMove,
  onToggleHidden,
  onAddChild,
  onDelete,
}: {
  rowRef: RefObject<HTMLDivElement | null>;
  folder: SessionFolder;
  folders: SessionFolder[];
  draft: FolderEditDraft;
  meta: FolderTreeMeta | undefined;
  parentOptions: SessionFolder[];
  busy: boolean;
  onDraftChange: (draft: FolderEditDraft) => void;
  onCancel: () => void;
  onSave: (draft: FolderEditDraft) => void;
  onMove: (folder: SessionFolder, direction: "up" | "down") => void;
  onToggleHidden: (folder: SessionFolder) => void;
  onAddChild: (parentId: string) => void;
  onDelete: (folder: SessionFolder) => void;
}) {
  const { text } = useI18n();
  return (
    <div className="folder-edit-row" ref={rowRef} style={{ "--folder-depth": folder.depth } as CSSProperties}>
      <input type="color" value={draft.color} onChange={(event) => onDraftChange({ ...draft, color: event.target.value })} aria-label={text("폴더 색상", "Folder color")} />
      <input value={draft.name} onChange={(event) => onDraftChange({ ...draft, name: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") void onSave(draft); if (event.key === "Escape") onCancel(); }} autoFocus />
      <button type="button" title={text("저장", "Save")} aria-label={text("이름·색상 저장", "Save name and color")} disabled={busy || !draft.name.trim()} onClick={() => onSave(draft)}><Check size={13} /></button>
      <button type="button" title={text("닫기", "Close")} aria-label={text("폴더 편집 닫기", "Close folder edit")} onClick={onCancel}><X size={13} /></button>
      <select value={draft.parent} onChange={(event) => onDraftChange({ ...draft, parent: event.target.value })} aria-label={text("상위 폴더", "Parent folder")}>
        <FolderParentOptions folders={folders} options={parentOptions} />
      </select>
      <div className="folder-edit-actions">
        <button type="button" title={text("위로 이동", "Move up")} aria-label={text(`${folder.name} 폴더를 위로 이동`, `Move ${folder.name} folder up`)} disabled={busy || !meta || meta.first} onClick={() => void onMove(folder, "up")}><ArrowUp size={12} /></button>
        <button type="button" title={text("아래로 이동", "Move down")} aria-label={text(`${folder.name} 폴더를 아래로 이동`, `Move ${folder.name} folder down`)} disabled={busy || !meta || meta.last} onClick={() => void onMove(folder, "down")}><ArrowDown size={12} /></button>
        <button
          type="button"
          title={folder.hidden ? text("표시 · 전체 세션과 상위 폴더에 다시 넣기", "Show · include back in all sessions and parent folder") : text("숨김 · 전체 세션과 상위 폴더에서 빼고 이 폴더에서만 보기", "Hide · exclude from all sessions and parent folder, show only here")}
          aria-label={folder.hidden ? text(`${folder.name} 폴더 표시`, `Show ${folder.name} folder`) : text(`${folder.name} 폴더 숨김`, `Hide ${folder.name} folder`)}
          aria-pressed={folder.hidden}
          disabled={busy}
          onClick={() => void onToggleHidden(folder)}
        >
          {folder.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
        </button>
        {canAddChildFolder(folder) && <button type="button" title={text("하위 폴더 추가", "Add subfolder")} onClick={() => onAddChild(folder.id)}><Plus size={12} /></button>}
        <button className="danger" type="button" title={text("폴더 삭제", "Delete folder")} onClick={() => onDelete(folder)}><Trash2 size={12} /></button>
      </div>
    </div>
  );
}

/**
 * 목록에 놓인 폴더 한 줄. 세션 배지 개수는 화면 필터를 거친 값이라 폴더가 스스로 셀 수
 * 없고, 접힘·드롭 대상 여부도 목록 전체의 상태라 모두 받아서 그리기만 한다.
 */
function SessionFolderEntryRow({
  folder,
  folders,
  active,
  dropTarget,
  collapsed,
  childCount,
  sessionCount,
  nestedSessionCount,
  countHint,
  onToggleCollapsed,
  onSelect,
  onStartEditing,
}: {
  folder: SessionFolder;
  folders: SessionFolder[];
  active: boolean;
  dropTarget: boolean;
  collapsed: boolean;
  childCount: number;
  sessionCount: number;
  nestedSessionCount: number;
  countHint: (visible: number, total: number) => string;
  onToggleCollapsed: (id: string) => void;
  onSelect: (folder: FolderFilter) => void;
  onStartEditing: (folder: SessionFolder) => void;
}) {
  const { text } = useI18n();
  return (
    <div
      data-folder-drop-id={folder.id}
      className={`${active ? "folder-entry active" : "folder-entry"}${dropTarget ? " drop-target" : ""}${folder.hidden ? " hidden-folder" : ""}`}
      style={{ "--folder-depth": folder.depth } as CSSProperties}
    >
      {childCount > 0 ? (
        <button
          className="folder-twisty"
          type="button"
          aria-expanded={!collapsed}
          title={collapsed ? text(`하위 폴더 ${childCount}개 펼치기`, `Expand ${childCount} subfolder(s)`) : text("하위 폴더 접기", "Collapse subfolders")}
          onClick={() => onToggleCollapsed(folder.id)}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
      ) : <span className="folder-twisty" aria-hidden="true" />}
      <button className="folder-entry-main" type="button" onClick={() => onSelect(folder.id)} title={`${folderPathLabel(folders, folder.id)} · ${countHint(sessionCount, folder.sessionCount)}${folder.hidden ? text(" · 숨긴 폴더 — 전체 세션과 상위 폴더에서 빠집니다", " · Hidden folder — excluded from all sessions and parent folder") : ""}`}>
        <span className="folder-symbol" style={{ "--folder-color": folder.color } as CSSProperties}>{folder.hidden ? <EyeOff size={13} /> : <Folder size={13} fill="currentColor" strokeWidth={0} />}</span>
        <strong>{folder.name}</strong>
        <em>{sessionCount}{nestedSessionCount > 0 && <i title={text(`하위 폴더 세션 ${nestedSessionCount}건`, `${nestedSessionCount} sessions in subfolders`)}>+{nestedSessionCount}</i>}</em>
      </button>
      <div className="folder-entry-actions">
        <button type="button" title={text("폴더 편집 · 이름·색상·위치·순서·숨김·삭제", "Edit folder · name, color, position, order, hidden, delete")} aria-label={text(`${folder.name} 폴더 편집`, `Edit ${folder.name} folder`)} onClick={() => onStartEditing(folder)}><Pencil size={12} /></button>
      </div>
    </div>
  );
}

// 접힘 상태는 화면 편의값이라, 막힌 저장소도 저장값이 없는 것과 같이 본다. 그 예외를
// 삼키는 일은 `storedText`가 한 벌로 맡으므로 여기 남는 것은 목록 모양 해석뿐이다.
function readCollapsedFolders(): Set<string> {
  const stored = readStoredText(SESSION_FOLDER_COLLAPSED_KEY);
  if (!stored) return new Set();
  try {
    const parsed: unknown = JSON.parse(stored);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeCollapsedFolders(collapsed: Set<string>) {
  writeStoredText(SESSION_FOLDER_COLLAPSED_KEY, JSON.stringify([...collapsed]));
}
