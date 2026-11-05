import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Copy, Download, FilePlus2, Folder, FolderInput, FolderPlus, PencilLine, Trash2 } from "lucide-react";
import {
  createDocumentEntry,
  deleteDocumentEntry,
  downloadDocumentFile,
  duplicateDocumentEntry,
  listDocumentEntries,
  moveDocumentEntry,
  renameDocumentEntry,
} from "../lib/ipc";
import type { DocRootStatus, DocumentEntry } from "../types";
import { ErrorBanner, LoadingState, Modal, type ConfirmRequest } from "./Shared";
import type { DocumentTreeChange } from "./DocumentTreePane";
import { useContextMenuPopup } from "./contextMenuPopup";
import { errorText } from "../lib/errorText";
import { useI18n } from "../lib/i18n";

/** 우클릭이 가리키는 자리. `entry`가 null이면 등록 폴더 맨 위(루트)다. */
interface DocEntryMenuState {
  entry: DocumentEntry | null;
  x: number;
  y: number;
}

/** 이름 하나를 받는 대화상자 세 가지(이름 변경·새 파일·새 폴더). */
type NameDialogState =
  | { kind: "rename"; entry: DocumentEntry }
  | { kind: "createFile"; parentPath: string }
  | { kind: "createFolder"; parentPath: string };

/** 이동 대화상자가 보는 항목이 사라질 수 있는 폴더 목록 상한. 그 이상은 안내만 한다. */
const MOVE_DIALOG_PAGE = 500;

export interface DocEntryActionsOptions {
  root: DocRootStatus | null;
  /** 지금 열려 있는 문서(이 등록 폴더의 것일 때만)와 그 초안 수정 여부. */
  openPath: string | null;
  dirty: boolean;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  setError: (message: string | null) => void;
  /**
   * `rootId` 폴더의 `from`(파일이거나 폴더)이 `to`로 옮겨졌다. 열린 문서와 상관없이 늘
   * 부른다 — 이동 기록에 남은 옛 경로도 고쳐야 하기 때문이다. 폴더 id를 함께 넘기는 것은
   * 응답을 기다리는 사이 사용자가 다른 등록 폴더로 옮겨 가도 엉뚱한 문서를 건드리지 않게 하려는 것이다.
   */
  onRelocated: (rootId: string, from: string, to: string) => void;
  /** `rootId` 폴더의 `path`(파일이거나 그 아래 전부)가 지워졌다. 마찬가지로 늘 부른다. */
  onRemoved: (rootId: string, path: string) => void;
  /** 루트 메뉴로 파일을 만들었다. 화면은 그 파일을 연다. */
  onCreatedFile: (entry: DocumentEntry) => void;
}

/** `path`가 `base` 자신이거나 그 아래인지. 경로는 언제나 `/`로 잇는다. */
export function isPathWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** 확장자 없이 적은 새 파일 이름은 Markdown 문서로 본다. 파일 화면에서 바로 고칠 수 있는 형식이다. */
function newFileName(input: string): string {
  const name = input.trim();
  return name.includes(".") ? name : `${name}.md`;
}

/**
 * 파일 화면 트리의 우클릭 메뉴 한 벌 — 메뉴 상태, 이름·이동 대화상자, 백엔드 호출, 트리에
 * 알릴 변경 신호. 문서 화면은 열려 있는 문서와 이동 기록이 이 작업과 맞물리는 자리(경로
 * 바뀜·지워짐·새 파일 열기)만 콜백으로 넘기고, 돌려받은 `menu`·`dialogs`를 그린다.
 *
 * 항목 종류에 따라 메뉴가 다르다.
 * - 파일: 이름 변경 · 이동 · 복제 · 다운로드 · 삭제
 * - 폴더: 이름 변경 · 이동 · 하위 폴더 만들기 · 삭제(안에 무언가 있으면 수를 보여 주고 한 번 더 확인)
 * - 루트(빈 자리·선택한 등록 폴더 줄): 파일 만들기 · 폴더 만들기
 */
export function useDocEntryActions({
  root,
  openPath,
  dirty,
  confirm,
  setError,
  onRelocated,
  onRemoved,
  onCreatedFile,
}: DocEntryActionsOptions) {
  const { text } = useI18n();
  const [menu, setMenu] = useState<DocEntryMenuState | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [moveTarget, setMoveTarget] = useState<DocumentEntry | null>(null);
  const [treeChange, setTreeChange] = useState<DocumentTreeChange | null>(null);
  const revisionRef = useRef(0);

  // 등록 폴더가 바뀌면 떠 있던 메뉴·대화상자는 다른 폴더의 항목을 가리키게 되므로 닫는다.
  const rootId = root?.id ?? null;
  useEffect(() => {
    setMenu(null);
    setNameDialog(null);
    setMoveTarget(null);
  }, [rootId]);

  const notifyTree = (change: Omit<DocumentTreeChange, "revision">) => {
    revisionRef.current += 1;
    setTreeChange({ ...change, revision: revisionRef.current });
  };

  const affectsOpen = (path: string) => openPath !== null && isPathWithin(openPath, path);

  const openMenu = (entry: DocumentEntry | null, x: number, y: number) => {
    if (!root) return;
    setMenu({ entry, x, y });
  };
  const closeMenu = () => setMenu(null);

  /** 메뉴 항목 하나를 고른 뒤. 메뉴를 먼저 닫아 대화상자·확인창이 그 위에 겹치지 않게 한다. */
  const choose = (work: () => void | Promise<void>) => {
    setMenu(null);
    void work();
  };

  const runReported = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const submitName = async (dialog: NameDialogState, name: string) => {
    if (!root) return;
    if (dialog.kind === "rename") {
      const { entry } = dialog;
      if (name.trim() === entry.name) return;
      const renamed = await renameDocumentEntry(root.id, entry.relativePath, name);
      notifyTree({ parents: [entry.parentPath], removed: entry.isDirectory ? [entry.relativePath] : [] });
      onRelocated(root.id, entry.relativePath, renamed.relativePath);
      return;
    }
    if (dialog.kind === "createFolder") {
      await createDocumentEntry(root.id, dialog.parentPath, name, "directory");
      notifyTree({ parents: [dialog.parentPath], expand: dialog.parentPath || undefined });
      return;
    }
    const created = await createDocumentEntry(root.id, dialog.parentPath, newFileName(name), "file");
    notifyTree({ parents: [dialog.parentPath], expand: dialog.parentPath || undefined });
    onCreatedFile(created);
  };

  const submitMove = async (entry: DocumentEntry, targetParentPath: string) => {
    if (!root) return;
    const moved = await moveDocumentEntry(root.id, entry.relativePath, targetParentPath);
    notifyTree({
      parents: [entry.parentPath, targetParentPath],
      removed: entry.isDirectory ? [entry.relativePath] : [],
    });
    onRelocated(root.id, entry.relativePath, moved.relativePath);
  };

  const duplicate = (entry: DocumentEntry) => runReported(async () => {
    if (!root) return;
    await duplicateDocumentEntry(root.id, entry.relativePath);
    notifyTree({ parents: [entry.parentPath] });
  });

  const download = (entry: DocumentEntry) => runReported(async () => {
    if (!root) return;
    await downloadDocumentFile(root.id, entry.relativePath);
  });

  const draftWarning = (path: string) => dirty && affectsOpen(path)
    ? text(" 편집 중인 저장하지 않은 초안도 함께 사라집니다.", " The unsaved draft you are editing is lost too.")
    : "";

  /**
   * 삭제. 파일은 한 번 확인받는다. 폴더는 비어 있으면 바로 지우고, 안에 무언가 있으면(숨김
   * 항목 포함) 백엔드가 지우지 않고 돌려준 수를 보여 주며 한 번 더 확인받는다. 휴지통을
   * 거치지 않으므로 확인창마다 되돌릴 수 없다고 적는다.
   */
  const remove = (entry: DocumentEntry) => runReported(async () => {
    if (!root) return;
    const irreversible = text("휴지통을 거치지 않아 되돌릴 수 없습니다.", "This skips the trash and cannot be undone.");
    if (!entry.isDirectory) {
      const accepted = await confirm({
        title: text("파일 삭제", "Delete file"),
        message: text(`'${entry.name}' 파일을 삭제할까요?`, `Delete the file '${entry.name}'?`),
        items: [entry.relativePath],
        warning: irreversible + draftWarning(entry.relativePath),
        confirmLabel: text("삭제", "Delete"),
        tone: "danger",
      });
      if (!accepted) return;
      await deleteDocumentEntry(root.id, entry.relativePath, false);
    } else {
      const first = await deleteDocumentEntry(root.id, entry.relativePath, false);
      if (!first.deleted) {
        const more = first.truncated ? text(" 이상", "+") : "";
        const accepted = await confirm({
          title: text("폴더와 안의 항목 삭제", "Delete folder and contents"),
          message: text(
            `'${entry.name}' 폴더가 비어 있지 않습니다.\n안에 있는 파일 ${first.files}개${more}, 폴더 ${first.directories}개${more}도 함께 삭제할까요? 화면에 보이지 않는 숨김 항목도 포함한 수입니다.`,
            `The folder '${entry.name}' is not empty.\nAlso delete the ${first.files}${more} files and ${first.directories}${more} folders inside? Hidden items are included in these counts.`,
          ),
          items: [entry.relativePath],
          warning: irreversible + draftWarning(entry.relativePath),
          confirmLabel: text("모두 삭제", "Delete all"),
          tone: "danger",
        });
        if (!accepted) return;
        await deleteDocumentEntry(root.id, entry.relativePath, true);
      }
    }
    notifyTree({ parents: [entry.parentPath], removed: entry.isDirectory ? [entry.relativePath] : [] });
    onRemoved(root.id, entry.relativePath);
  });

  const menuNode = menu && root ? (
    <DocEntryContextMenu
      entry={menu.entry}
      rootName={root.name}
      anchorX={menu.x}
      anchorY={menu.y}
      onClose={closeMenu}
      onRename={(entry) => choose(() => setNameDialog({ kind: "rename", entry }))}
      onMove={(entry) => choose(() => setMoveTarget(entry))}
      onDuplicate={(entry) => choose(() => duplicate(entry))}
      onDownload={(entry) => choose(() => download(entry))}
      onDelete={(entry) => choose(() => remove(entry))}
      onCreateFolder={(parentPath) => choose(() => setNameDialog({ kind: "createFolder", parentPath }))}
      onCreateFile={(parentPath) => choose(() => setNameDialog({ kind: "createFile", parentPath }))}
    />
  ) : null;

  const dialogs = (
    <>
      {nameDialog && root && <DocEntryNameDialog
        dialog={nameDialog}
        onClose={() => setNameDialog(null)}
        onSubmit={(name) => submitName(nameDialog, name)}
      />}
      {moveTarget && root && <DocEntryMoveDialog
        root={root}
        entry={moveTarget}
        onClose={() => setMoveTarget(null)}
        onSubmit={(target) => submitMove(moveTarget, target)}
      />}
    </>
  );

  return { openMenu, treeChange, menu: menuNode, dialogs };
}

interface DocEntryContextMenuProps {
  entry: DocumentEntry | null;
  rootName: string;
  anchorX: number;
  anchorY: number;
  onClose: () => void;
  onRename: (entry: DocumentEntry) => void;
  onMove: (entry: DocumentEntry) => void;
  onDuplicate: (entry: DocumentEntry) => void;
  onDownload: (entry: DocumentEntry) => void;
  onDelete: (entry: DocumentEntry) => void;
  onCreateFolder: (parentPath: string) => void;
  onCreateFile: (parentPath: string) => void;
}

/** 우클릭 메뉴. 파일·폴더·루트마다 항목이 다르고, 지우기는 언제나 구분선 아래 맨 끝에 둔다. */
function DocEntryContextMenu({
  entry,
  rootName,
  anchorX,
  anchorY,
  onClose,
  onRename,
  onMove,
  onDuplicate,
  onDownload,
  onDelete,
  onCreateFolder,
  onCreateFile,
}: DocEntryContextMenuProps) {
  const { text } = useI18n();
  const { menuRef, position, onKeyDown } = useContextMenuPopup(anchorX, anchorY, onClose);
  const item = (label: string, icon: ReactNode, onClick: () => void, className?: string) => (
    <button className={className} type="button" role="menuitem" onClick={onClick}>{icon}{label}</button>
  );

  let items: ReactNode;
  if (entry === null) {
    items = <>
      {item(text("파일 만들기", "New file"), <FilePlus2 size={14} />, () => onCreateFile(""))}
      {item(text("폴더 만들기", "New folder"), <FolderPlus size={14} />, () => onCreateFolder(""))}
    </>;
  } else if (entry.isDirectory) {
    items = <>
      {item(text("이름 변경", "Rename"), <PencilLine size={14} />, () => onRename(entry))}
      {item(text("이동", "Move"), <FolderInput size={14} />, () => onMove(entry))}
      {item(text("하위 폴더 만들기", "New subfolder"), <FolderPlus size={14} />, () => onCreateFolder(entry.relativePath))}
      <div className="doc-entry-menu-separator" />
      {item(text("삭제", "Delete"), <Trash2 size={14} />, () => onDelete(entry), "danger")}
    </>;
  } else {
    items = <>
      {item(text("이름 변경", "Rename"), <PencilLine size={14} />, () => onRename(entry))}
      {item(text("이동", "Move"), <FolderInput size={14} />, () => onMove(entry))}
      {item(text("복제", "Duplicate"), <Copy size={14} />, () => onDuplicate(entry))}
      {item(text("다운로드", "Download"), <Download size={14} />, () => onDownload(entry))}
      <div className="doc-entry-menu-separator" />
      {item(text("삭제", "Delete"), <Trash2 size={14} />, () => onDelete(entry), "danger")}
    </>;
  }

  const title = entry?.name ?? rootName;
  return createPortal(
    <div
      className="doc-entry-menu"
      ref={menuRef}
      role="menu"
      aria-label={text(`${title} 파일 메뉴`, `${title} file actions`)}
      style={{ left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      <header data-user-content>{title}</header>
      {items}
    </div>,
    document.body,
  );
}

/**
 * 이름 하나를 받는 대화상자. 실패해도 닫지 않고 그 자리에 사유를 보여 줘, 같은 이름이
 * 있을 때 고쳐 적고 다시 누를 수 있게 한다. 파일 이름을 바꿀 때는 확장자 앞까지만 골라 둔다.
 */
function DocEntryNameDialog({
  dialog,
  onClose,
  onSubmit,
}: {
  dialog: NameDialogState;
  onClose: () => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const { text } = useI18n();
  const initial = dialog.kind === "rename" ? dialog.entry.name : "";
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    if (dialog.kind === "rename") {
      const dot = dialog.entry.isDirectory ? -1 : initial.lastIndexOf(".");
      input.setSelectionRange(0, dot > 0 ? dot : initial.length);
    }
  }, []);

  const copy = {
    rename: {
      title: dialog.kind === "rename" && dialog.entry.isDirectory ? text("폴더 이름 변경", "Rename folder") : text("파일 이름 변경", "Rename file"),
      confirm: text("변경", "Rename"),
      hint: null,
    },
    createFile: {
      title: text("새 파일", "New file"),
      confirm: text("만들기", "Create"),
      hint: text("확장자를 적지 않으면 Markdown(.md) 문서로 만듭니다.", "Without an extension the file is created as Markdown (.md)."),
    },
    createFolder: {
      title: text("새 폴더", "New folder"),
      confirm: text("만들기", "Create"),
      hint: null,
    },
  }[dialog.kind];
  const location = dialog.kind === "rename" ? dialog.entry.parentPath : dialog.parentPath;

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={copy.title}
      onClose={() => { if (!busy) onClose(); }}
      footer={<>
        <button className="button" type="button" onClick={onClose} disabled={busy}>{text("취소", "Cancel")}</button>
        <button className="button primary" type="button" onClick={() => void submit()} disabled={busy || !name.trim()}>{copy.confirm}</button>
      </>}
    >
      {error && <ErrorBanner message={error} />}
      <div className="doc-entry-name-dialog">
        <small>{text("위치", "Location")}: <code data-user-content>{location || "/"}</code></small>
        <input
          ref={inputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          aria-label={text("이름", "Name")}
          disabled={busy}
        />
        {copy.hint && <small>{copy.hint}</small>}
      </div>
    </Modal>
  );
}

/**
 * 옮길 폴더를 고르는 대화상자. 등록 폴더 맨 위부터 폴더만 한 층씩 내려가며 고른다. 옮기는
 * 항목 자신과 그 아래 폴더는 고를 수 없게 막는다(백엔드도 거절한다). 지금 있는 폴더를
 * 그대로 고르면 아무것도 바뀌지 않으므로 버튼을 끈다.
 */
function DocEntryMoveDialog({
  root,
  entry,
  onClose,
  onSubmit,
}: {
  root: DocRootStatus;
  entry: DocumentEntry;
  onClose: () => void;
  onSubmit: (targetParentPath: string) => Promise<void>;
}) {
  const { text } = useI18n();
  const [path, setPath] = useState("");
  const [folders, setFolders] = useState<DocumentEntry[] | null>(null);
  const [partial, setPartial] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFolders(null);
    setError(null);
    listDocumentEntries(root.id, path, null, MOVE_DIALOG_PAGE).then((page) => {
      if (!alive) return;
      setFolders(page.entries.filter((item) => item.isDirectory));
      setPartial(page.nextCursor !== null);
    }, (cause) => {
      if (!alive) return;
      setFolders([]);
      setError(errorText(cause));
    });
    return () => { alive = false; };
  }, [root.id, path]);

  const blocked = (folder: string) => entry.isDirectory && isPathWithin(folder, entry.relativePath);
  const parentOf = (folder: string) => folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
  const sameFolder = path === entry.parentPath;

  const submit = async () => {
    if (busy || sameFolder || blocked(path)) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(path);
      onClose();
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={text(`'${entry.name}' 이동`, `Move '${entry.name}'`)}
      onClose={() => { if (!busy) onClose(); }}
      footer={<>
        <button className="button" type="button" onClick={onClose} disabled={busy}>{text("취소", "Cancel")}</button>
        <button className="button primary" type="button" onClick={() => void submit()} disabled={busy || sameFolder || blocked(path)}>
          {text("여기로 이동", "Move here")}
        </button>
      </>}
    >
      {error && <ErrorBanner message={error} />}
      <div className="doc-entry-move-dialog">
        <div className="doc-entry-move-path">
          <button className="icon-button" type="button" disabled={path === "" || busy} onClick={() => setPath(parentOf(path))} aria-label={text("상위 폴더", "Parent folder")} title={text("상위 폴더", "Parent folder")}>
            <ArrowUp size={14} />
          </button>
          <code data-user-content>{root.name}{path ? ` / ${path.split("/").join(" / ")}` : ""}</code>
        </div>
        <div className="doc-entry-move-list" role="list">
          {folders === null ? <LoadingState label={text("폴더를 읽고 있습니다", "Loading folders")} /> : null}
          {folders?.length === 0 && !error ? <p className="tree-empty">{text("하위 폴더가 없습니다.", "No subfolders.")}</p> : null}
          {folders?.map((folder) => (
            <button
              key={folder.relativePath}
              type="button"
              role="listitem"
              className="tree-row directory"
              disabled={busy || blocked(folder.relativePath)}
              onClick={() => setPath(folder.relativePath)}
            >
              <Folder size={14} aria-hidden="true" />
              <strong data-user-content>{folder.name}</strong>
            </button>
          ))}
          {partial ? <p className="tree-empty">{text(`폴더가 많아 앞의 ${MOVE_DIALOG_PAGE}개 항목만 보여 줍니다.`, `Only the first ${MOVE_DIALOG_PAGE} items are shown.`)}</p> : null}
        </div>
        {sameFolder ? <small>{text("지금 있는 폴더입니다. 다른 폴더를 고르세요.", "This is the current folder. Pick another one.")}</small> : null}
      </div>
    </Modal>
  );
}
