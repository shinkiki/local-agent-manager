import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, PanelLeftClose, PanelLeftOpen, Plus, TriangleAlert, X } from "lucide-react";
import {
  createDoc,
  createDocRoot,
  deleteDocRoot,
  downloadDocumentFile,
  downloadDocLinkedFile,
  getDocumentFile,
  getDocLinkedFile,
  getDocRoots,
  previewDirectoryCreation,
  putDoc,
} from "../lib/ipc";
import type { AccountSnapshot, DocRootStatus, DocumentEntry, DocumentFile, ModelOption, ProviderStatus } from "../types";
import { EmptyState, ErrorBanner, LoadingState, useConfirm, useEscapeToClose, type ConfirmRequest } from "./Shared";
import { useI18n } from "../lib/i18n";
import { runtimeText } from "../lib/i18nRuntime";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";
import { directoryCreationItems, missingDirectoryPath } from "../lib/missingDirectory";
import { readSecondaryPaneOpen, writeSecondaryPaneOpen } from "../lib/secondaryPane";
import { DocumentTreePane, docRootTreeSource, useRequestGeneration } from "./DocumentTreePane";
import { DocumentFilePane, type DocumentFilePaneProps } from "./DocumentFilePane";
import { DocumentAutomationPanel } from "./DocumentAutomationPanel";
import { errorText } from "../lib/errorText";
import { displayPath } from "../lib/displayPath";

const DOC_HISTORY_LIMIT = 100;
const DOC_SIDEBAR_OPEN_KEY = "agent-manager.docs-sidebar";
const SIDEBAR_OVERLAY_QUERY = "(max-width: 760px)";

/** 새 문서 입력을 다듬고 Markdown 확장자가 없을 때만 붙인다. */
function markdownDocumentPath(input: string): string {
  const path = input.trim();
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

/**
 * 문서 한 건을 가리키는 두 칸. 기록 항목·열려 있는 문서·이동 요청·트리에서 고른 파일이 모두
 * 같은 짝으로 서로를 가리키는데, 그 짝을 넘기는 자리마다 두 인자로 풀어 적고 있었다. 짝을
 * 타입 하나로 세워 부르는 쪽이 이미 들고 있는 값을 그대로 넘기게 한다.
 */
interface DocumentRef {
  rootId: string;
  relativePath: string;
}

/**
 * 두 자리가 같은 문서를 가리키는지. 기록 항목과 열려 있는 문서를 맞춰 보는 자리가 다섯
 * (스크롤 기록·기록 되돌아가기 대조·기록 쌓기·같은 문서로의 이동 건너뛰기·트리에서 보고
 * 있는 파일 다시 고르기)인데, 다섯이 `rootId`와 `relativePath`를 각자 이어 붙여 대조했다.
 * 그중 스크롤 기록 한 자리만 부정형(`!==` 두 번에 `||`)이라 같은 판정이 두 모양으로 남아
 * 있었고, 없는 값을 거르는 방식도 `!entry` 이른 반환·`Boolean(entry && …)`·`?.` 셋으로
 * 갈렸다. 한 함수로 모아 없는 값은 언제나 "다른 문서"로 본다.
 */
function isSameDocument(a: DocumentRef | null | undefined, b: DocumentRef | null | undefined): boolean {
  return Boolean(a && b && a.rootId === b.rootId && a.relativePath === b.relativePath);
}

interface DocHistoryEntry extends DocumentRef {
  scrollTop: number;
}

interface DocHistoryState {
  entries: DocHistoryEntry[];
  index: number;
}

export interface DocsViewProps {
  /** 변경 자동화의 채팅·스킬 액션이 공급자와 실행 계정을 고르는 데 쓴다. */
  providers: ProviderStatus[];
  accounts: AccountSnapshot | null;
  models: ModelOption[];
  onRequestAiaPrompt?: (prompt: string) => void;
}

export function DocsView({ providers, accounts, models, onRequestAiaPrompt }: DocsViewProps) {
  // 섹션 탭 문구와 nav aria-label은 정적 UI 치환기가 속성까지 닿지 않으므로 컴포넌트가 직접 text()로 고른다.
  const { text } = useI18n();
  const [section, setSection] = useState<"files" | "automation">("files");
  const [error, setError] = useState<string | null>(null);
  // 되묻는 자리(초안 이탈·등록 해제·없는 폴더 만들기)는 브라우저 confirm 대신 앱 공용
  // 확인 모달 하나를 나눠 쓴다. 등록부 훅도 같은 모달로 묻도록 confirm을 넘겨 준다.
  const { confirm, confirmDialog } = useConfirm();
  // 열려 있는 문서 네 칸과 그 전이는 폴더 등록부·사이드바·이동 기록과 상태를 나눠 갖지
  // 않으므로 훅 한 벌로 모은다. 되묻기가 초안 수정 여부에 매달려 있어 confirm을 넘겨 준다.
  const {
    doc,
    draft,
    editing,
    dirty,
    setEditing,
    showDocument,
    clearDocument: clearDocumentState,
    changeDraft,
    confirmDiscardDraft,
  } = useDocDraft(confirm);
  // 폴더 목록·선택·등록 폼은 문서 작업대와 상태를 나눠 갖지 않으므로 훅 한 벌로 모은다.
  // 오류만 화면 공용 배너로 올라오므로 setError를 넘겨 준다.
  const { roots, selectedRoot, setSelectedRoot, removeRoot, rootForm } = useDocRootRegistry(setError, confirm);
  const workspaceRef = useRef<HTMLElement>(null);
  // 사이드바 생명주기(열림 보존·좁은 화면 겹침·여닫은 뒤 포커스·Esc 닫기)는 문서 작업대와
  // 상태를 나눠 갖지 않으므로 훅 한 벌로 모은다. 호출 자리는 여기여야 한다 — 훅이 등록하는
  // 포커스 효과가 아래 useDocHistory의 스크롤 복원보다 먼저 돌아야 하기 때문이다.
  const {
    open: sidebarOpen,
    isOverlay: sidebarIsOverlay,
    setVisibility: setSidebarVisibility,
    closeRef: sidebarCloseRef,
    restoreRef: sidebarRestoreRef,
  } = useDocsSidebar();

  const currentDocPath = doc?.relativePath ?? null;

  // 기록을 다루는 자리가 여섯(이동·되돌아가기·생성·폴더 전환·폴더 해제·화살표 버튼)이라
  // 상태·ref·복원 대기 값이 화면 상태와 뒤섞여 있었다. 훅 호출은 사이드바 포커스 효과보다
  // 뒤에 두어야 한다 — 스크롤 복원이 먼저 돌면 뒤이은 포커스가 그 자리를 다시 끌어올린다.
  const history = useDocHistory(workspaceRef, doc);

  // 문서 사이를 옮겨 다니는 다섯 자리와 그 진행 표시·연결 파일 미리보기를 훅 한 벌로 모은다.
  // 호출 자리는 기록 훅 뒤여야 한다 — 이동이 기록 한 벌을 그대로 받아 쓰기 때문이다.
  const {
    navigating,
    linkedFilePreview,
    downloadLinkedFile,
    closeSidebarOverlay,
    clearDocument,
    selectFile,
    moveHistory,
    selectRoot,
    openLinkedDoc,
  } = useDocNavigation({
    doc,
    roots,
    selectedRoot,
    setSelectedRoot,
    history,
    showDocument,
    clearDocumentState,
    confirmDiscardDraft,
    setError,
    sidebarIsOverlay,
    setSidebarVisibility,
  });

  // 파일을 건드리는 세 자리(새 문서·저장·내려받기)와 그 진행 표시·트리 리비전은 이동
  // 기록·사이드바와 상태를 나눠 갖지 않으므로 훅 한 벌로 모은다. 이 훅은 효과를 등록하지
  // 않으므로 호출 자리가 다른 훅들의 효과 순서를 바꾸지 않는다.
  const {
    newDocPath,
    setNewDocPath,
    treeRevision,
    saving,
    downloading,
    createFile,
    save,
    downloadCurrentDoc,
  } = useDocFileActions({
    doc,
    draft,
    selectedRoot,
    history,
    showDocument,
    confirmDiscardDraft,
    setError,
    onNavigated: closeSidebarOverlay,
  });

  // 등록 폴더를 되살리는 버튼은 빈 화면 머리말과 문서 머리말 두 자리에 같은 모양·같은
  // ref로 놓인다. 두 자리는 배타적으로 렌더되므로 ref가 겹치지 않는다. 사이드바가 열려
  // 있으면 어느 자리에도 놓이지 않으므로 아예 만들지 않는다 — 받는 쪽이 '열려 있는가'를
  // 다시 보지 않고 버튼의 유무만 보면 된다.
  const sidebarRestoreButton = sidebarOpen ? null : (
    <DocsSidebarToggle expanded={false} buttonRef={sidebarRestoreRef} onClick={() => setSidebarVisibility(true)} />
  );

  return (
    <div className="docs-layout">
      {sidebarOpen && <DocsSidebar
        closeRef={sidebarCloseRef}
        onClose={() => setSidebarVisibility(false)}
        form={rootForm}
        rootList={{
          roots,
          selectedRoot,
          onSelectRoot: (root) => void selectRoot(root),
          // 해제가 잊어야 하는 화면 쪽 기억(이동 기록·열려 있던 문서)은 등록부가 알 수
          // 없으므로 여기서 넘긴다. 등록부는 되묻기·삭제·목록 갱신까지만 맡는다.
          onRemoveRoot: (root) => void removeRoot(root, () => {
            history.dropRoot(root.id);
            if (selectedRoot?.id === root.id) clearDocument();
          }),
        }}
        newFile={{
          newDocPath,
          saving,
          navigating,
          onNewDocPathChange: setNewDocPath,
          onCreateFile: createFile,
        }}
        tree={{ selectedPath: currentDocPath, revision: treeRevision, onSelect: selectFile }}
      />}
      {sidebarOpen && sidebarIsOverlay && <button className="docs-sidebar-backdrop" type="button" onClick={() => setSidebarVisibility(false)} aria-label={text("등록 폴더 닫기", "Close registered folders")} />}
      <main className="doc-workspace" ref={workspaceRef}>
        <nav className="docs-section-tabs" aria-label={text("문서 메뉴", "Document menu")}><button className={section === "files" ? "active" : ""} type="button" onClick={() => setSection("files")}>{text("탐색", "Browse")}</button><button className={section === "automation" ? "active" : ""} type="button" onClick={() => setSection("automation")}>{text("변경 자동화", "Change automation")}</button></nav>
        {section === "automation" ? <DocumentAutomationPanel roots={roots ?? []} providers={providers} accounts={accounts} models={models} onRequestAiaPrompt={onRequestAiaPrompt} /> : <DocsFilesSection
          error={error}
          restoreButton={sidebarRestoreButton}
          doc={doc}
          pane={{
            draft,
            editing,
            dirty,
            saving,
            downloading,
            onEditingChange: setEditing,
            onDraftChange: changeDraft,
            onSave: save,
            onDownload: downloadCurrentDoc,
            onOpenLocalLink: openLinkedDoc,
          }}
        />}
      </main>
      {doc && section === "files" && <DocHistoryNav
        busy={navigating}
        index={history.state.index}
        count={history.state.entries.length}
        onMove={moveHistory}
      />}
      {linkedFilePreview.state && <LinkedFilePreview state={linkedFilePreview.state} onClose={linkedFilePreview.close} onDownload={downloadLinkedFile} />}
      {confirmDialog}
    </div>
  );
}

/**
 * 탐색 갈래의 본문. 자동화 갈래는 이미 전용 패널 한 벌로 서 있는데 탐색 쪽만 화면 본문의
 * 삼항식 뒤쪽에 조각(`<>…</>`)으로 펼쳐져 있어, 공용 배너·빈 화면 머리말·빈 상태·문서 창
 * 넷의 조건이 사이드바 배치·섹션 탭·기록 화살표와 한 들여쓰기 안에 섞였다. 두 갈래를 같은
 * 높이로 맞춰 화면 본문은 어느 갈래를 언제 그릴지만 정하게 한다.
 *
 * 문서 창으로 그대로 흘러가는 열 칸은 `pane` 한 묶음으로 받는다 — 이름을 여기서 다시
 * 나열하면 칸이 하나 늘 때 호출부·서명·전달 세 자리를 함께 고쳐야 한다. 문서 한 벌만
 * 따로 받는 것은 이 자리가 그 유무로 빈 상태와 갈리기 때문이다.
 */
function DocsFilesSection({
  error,
  restoreButton,
  doc,
  pane,
}: {
  error: string | null;
  /**
   * 사이드바를 되살리는 버튼. 빈 화면 머리말과 문서 머리말 중 한 자리에만 놓이고, 사이드바가
   * 열려 있으면 null이다 — 예전에는 그 판정을 `sidebarOpen` 한 칸으로 따로 받아 아래 두
   * 자리가 같은 `!sidebarOpen`을 각자 적었고, 한쪽만 고치면 머리말은 비어 있는데 자리는
   * 차지하는(또는 그 반대의) 모양이 됐다.
   */
  restoreButton: ReactNode;
  doc: DocumentFile | null;
  pane: Omit<DocumentFilePaneProps, "file" | "headerLeading">;
}) {
  const { text } = useI18n();
  return (
    <>
      {error && <ErrorBanner message={error} />}
      {restoreButton && !doc && <header className="doc-header doc-header-empty">{restoreButton}</header>}
      {!doc ? <EmptyState title={text("파일을 선택하세요", "Select a file")} detail={text("일반 파일을 탐색하고 Markdown과 UTF-8 텍스트를 미리볼 수 있습니다.", "Browse regular files and preview Markdown and UTF-8 text.")} /> : <DocumentFilePane
        file={doc}
        headerLeading={restoreButton}
        {...pane}
      />}
    </>
  );
}

/**
 * 문서 이동 기록 화살표. 앞뒤 두 버튼은 아이콘과 방향, 양 끝에서 꺼지는 조건만 다른데도
 * 같은 여섯 속성을 각자 나열했고, 이름표는 `aria-label`과 `title` 두 자리에 같은 문구를
 * 두 번씩 적어 한 자리만 고치면 읽어 주는 이름과 툴팁이 어긋났다. 기록 상태를 통째로
 * 받지 않고 현재 위치와 개수 두 숫자만 받아, 꺼지는 조건도 이 한 자리에 모은다.
 */
function DocHistoryNav({
  busy,
  index,
  count,
  onMove,
}: {
  /** 이동이 진행 중인 동안은 양쪽 모두 꺼둔다. */
  busy: boolean;
  index: number;
  count: number;
  onMove: (offset: -1 | 1) => void;
}) {
  const { text } = useI18n();
  return (
    <nav className="doc-history-nav" aria-label={text("문서 이동 기록", "Document history")}>
      <DocHistoryButton label={text("이전 문서", "Previous document")} disabled={busy || index <= 0} onClick={() => onMove(-1)}>
        <ArrowLeft size={17} />
      </DocHistoryButton>
      <DocHistoryButton label={text("다음 문서", "Next document")} disabled={busy || index >= count - 1} onClick={() => onMove(1)}>
        <ArrowRight size={17} />
      </DocHistoryButton>
    </nav>
  );
}

/** 기록 화살표 한 칸. 읽어 주는 이름과 툴팁은 언제나 같은 문구다. */
function DocHistoryButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}>{children}</button>
  );
}

/**
 * 등록 폴더 사이드바. 폴더 목록·등록 폼·문서 트리는 화면 본문(문서 읽기·편집·이동 기록)과
 * 상태를 나눠 갖지 않고 콜백으로만 이어지므로, 표시 전용 컴포넌트로 떼어 DocsView의 렌더가
 * 문서 작업대만 다루게 한다.
 *
 * 받는 칸은 아래 세 컴포넌트로 그대로 흘러가는 값뿐이었는데, 그 열다섯을 사이드바가 손으로
 * 다시 나열했다. 칸이 하나 늘면 호출부·사이드바 서명·구조분해·그 아래 전달까지 네 자리를
 * 함께 고쳐야 했고, 문서 트리에 넘기던 `doc`은 실제로 쓰는 것이 `relativePath` 한 칸인데도
 * 문서 한 벌이 통째로 내려왔다. 받는 쪽 컴포넌트 단위로 묶어, 사이드바는 묶음을 그대로
 * 넘기고 자기 머리말에 필요한 두 칸(`roots`·`selectedRoot`)만 푼다.
 */
function DocsSidebar({
  closeRef,
  onClose,
  form,
  rootList,
  newFile,
  tree,
}: {
  closeRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  form: DocRootFormState;
  rootList: DocRootListProps;
  newFile: DocNewFileRowProps;
  tree: DocsSidebarTree;
}) {
  const { roots, selectedRoot } = rootList;
  const { text } = useI18n();
  return (
    <aside className="docs-sidebar" id="docs-sidebar" data-ui-anchor="docs.sidebar">
      <div className="docs-sidebar-head">
        <div>
          <strong>등록 폴더</strong>
          <span>{roots?.length ?? 0}개</span>
        </div>
        <div className="secondary-pane-header-actions">
          <button
            className="icon-button"
            type="button"
            onClick={form.toggle}
            aria-label="등록 폴더 추가"
            aria-expanded={form.open}
          >
            <Plus size={16} />
          </button>
          <DocsSidebarToggle expanded buttonRef={closeRef} onClick={onClose} />
        </div>
      </div>
      <DocRootForm form={form} />
      <DocRootList {...rootList} />
      {selectedRoot && (
        <div className="doc-tree-panel">
          <DocNewFileRow {...newFile} />
          {selectedRoot.exists && !selectedRoot.restricted ? (
            <DocumentTreePane
              key={`${selectedRoot.id}:${tree.revision}`}
              source={docRootTreeSource(selectedRoot.id, text("등록 폴더 파일", "Registered folder files"))}
              selectedPath={tree.selectedPath}
              onSelect={tree.onSelect}
            />
          ) : (
            <p className="tree-empty">{text("접근할 수 없는 폴더입니다.", "This folder is not accessible.")}</p>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * 등록 폴더 사이드바를 여닫는 버튼. 숨기기(사이드바 머리말)와 되살리기(본문 머리말) 두
 * 자리가 같은 속성 여섯을 각자 나열했고, 이름표는 `aria-label`과 `title` 두 칸에 같은 문구를
 * 두 번씩 적어 한 칸만 고치면 읽어 주는 이름과 툴팁이 어긋났다 — 기록 화살표는 이미
 * `DocHistoryButton`으로 그 짝을 한 자리에 모아 두었으므로 같은 모양으로 맞춘다. 여닫는
 * 방향 하나만 칸으로 남겨, 두 자리가 다른 모양으로 갈라질 길을 없앤다.
 *
 * 안내 카탈로그가 가리키는 `docs.sidebar`는 사이드바가 접혀 있을 때 되살리기 버튼으로
 * 떨어진다(`lib/uiGuideTargets.json`). 그래서 표시는 되살리기 쪽에만 붙인다 — 열려 있을
 * 때는 사이드바 자신이 같은 표시를 들고 있어 둘이 함께 뜨면 가리키는 자리가 갈린다.
 */
function DocsSidebarToggle({
  expanded,
  buttonRef,
  onClick,
}: {
  /** 지금 사이드바가 열려 있는가. 열려 있으면 숨기기, 접혀 있으면 되살리기다. */
  expanded: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onClick: () => void;
}) {
  const { text } = useI18n();
  const label = expanded
    ? text("등록 폴더 숨기기", "Hide registered folders")
    : text("등록 폴더 보기", "Show registered folders");
  return (
    <button
      ref={buttonRef}
      className="icon-button secondary-pane-toggle"
      type="button"
      data-ui-anchor={expanded ? undefined : "docs.sidebar"}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-expanded={expanded ? undefined : false}
    >{expanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button>
  );
}

/** 등록 폴더 추가 폼. 열려 있을 때만 이름·경로 입력창과 등록 버튼을 렌더링한다. */
function DocRootForm({ form }: { form: DocRootFormState }) {
  const { text } = useI18n();
  if (!form.open) return null;
  return (
    <div className="root-form">
      <input
        value={form.name}
        onChange={(event) => form.setName(event.target.value)}
        placeholder="표시 이름 (선택)"
      />
      <input
        value={form.path}
        onChange={(event) => form.setPath(event.target.value)}
        placeholder="/Users/me/Documents/notes"
      />
      <button
        className="button primary"
        type="button"
        disabled={!form.path.trim()}
        onClick={() => void form.submit()}
      >
        {text("폴더 등록", "Register folder")}
      </button>
    </div>
  );
}

/** 등록 폴더 목록이 받는 한 벌. 사이드바는 이 묶음을 그대로 받아 목록에 넘긴다. */
interface DocRootListProps {
  roots: DocRootStatus[] | null;
  selectedRoot: DocRootStatus | null;
  onSelectRoot: (root: DocRootStatus) => void;
  onRemoveRoot: (root: DocRootStatus) => void;
}

/** 등록 폴더 목록. 로딩·빈 상태와 폴더 행 목록을 다룬다. */
function DocRootList({ roots, selectedRoot, onSelectRoot, onRemoveRoot }: DocRootListProps) {
  const { text } = useI18n();
  if (roots === null) return <LoadingState label={text("등록 폴더 확인 중", "Checking registered folders")} />;
  if (roots.length === 0) {
    return <EmptyState title="등록된 폴더 없음" detail="상단 + 버튼에서 로컬 폴더를 등록하세요." />;
  }

  return (
    <div className="root-list">
      {roots.map((root) => (
        <DocRootRow
          key={root.id}
          root={root}
          active={selectedRoot?.id === root.id}
          onSelectRoot={onSelectRoot}
          onRemoveRoot={onRemoveRoot}
        />
      ))}
    </div>
  );
}

/** 등록 폴더 행. 폴더 존재 여부 아이콘, 이름·경로 표시, 선택 및 제거 조작을 맡는다. */
function DocRootRow({
  root,
  active,
  onSelectRoot,
  onRemoveRoot,
}: {
  root: DocRootStatus;
  active: boolean;
  onSelectRoot: (root: DocRootStatus) => void;
  onRemoveRoot: (root: DocRootStatus) => void;
}) {
  return (
    <div className={active ? "root-row active" : "root-row"}>
      <button type="button" onClick={() => onSelectRoot(root)}>
        {root.exists ? <ChevronDown size={13} /> : <TriangleAlert size={13} />}
        <span>
          <strong>{root.name}</strong>
          <code>{displayPath(root.path)}</code>
        </span>
      </button>
      <button
        className="remove-root"
        type="button"
        onClick={() => onRemoveRoot(root)}
        aria-label="폴더 제거"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** 새 문서 입력 행이 받는 한 벌. 사이드바는 이 묶음을 그대로 받아 행에 넘긴다. */
interface DocNewFileRowProps {
  newDocPath: string;
  saving: boolean;
  navigating: boolean;
  onNewDocPathChange: (value: string) => void;
  onCreateFile: () => void;
}

/** 새 마크다운 문서 파일 생성 경로 입력 행. */
function DocNewFileRow({ newDocPath, saving, navigating, onNewDocPathChange, onCreateFile }: DocNewFileRowProps) {
  return (
    <div className="new-doc-row">
      <input
        value={newDocPath}
        onChange={(event) => onNewDocPathChange(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && !navigating && onCreateFile()}
        placeholder="새문서.md"
      />
      <button
        type="button"
        disabled={saving || navigating || !newDocPath.trim()}
        onClick={onCreateFile}
        aria-label="새 문서 만들기"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}

/**
 * 문서 트리가 사이드바에서 보는 한 벌. 트리 자체는 선택 폴더에서 rootId를 받으므로, 바깥이
 * 넘길 것은 지금 열린 문서 경로·트리 리비전·선택 처리기 셋뿐이다.
 */
interface DocsSidebarTree {
  selectedPath: string | null;
  /** 파일 목록·수정 일시를 다시 읽게 하는 리비전. 트리의 key에 들어간다. */
  revision: number;
  onSelect: (entry: DocumentEntry) => void;
}

/** 등록 폴더 등록 폼 한 벌. 사이드바는 이 묶음만 받아 칸이 늘어도 props가 흔들리지 않는다. */
interface DocRootFormState {
  name: string;
  path: string;
  open: boolean;
  setName: (value: string) => void;
  setPath: (value: string) => void;
  toggle: () => void;
  submit: () => Promise<void>;
}

/**
 * 초안을 버리기 전에 되묻는 물음의 뒷말. 자리마다 문자열을 직접 넘기게 두면 같은 뒷말
 * ("이동할까요?")이 두 자리에 각자 적혀, 한쪽만 고치면 같은 물음이 두 문장으로 갈린다.
 * 뒷말을 이름으로 부르게 해 짝(한국어·영어)이 한 자리에만 있게 한다.
 */
const DISCARD_QUESTIONS = {
  navigate: { ko: "이동할까요?", en: "Navigate anyway?" },
  createFile: { ko: "새 문서를 만들까요?", en: "Create a new document anyway?" },
} as const;

type DiscardQuestion = keyof typeof DISCARD_QUESTIONS;

/**
 * 열려 있는 문서 한 벌. 원본·초안·편집 여부·수정 여부 네 칸은 언제나 함께 움직이는데,
 * 그 전이 네 가지(화면에 올리기·비우기·초안 타이핑·이탈 되묻기)가 화면 본문에서 이동·폴더
 * 등록·사이드바 흐름 사이에 흩어져 있었다. 네 칸을 한 자리에 모아 화면 본문은 어느 문서를
 * 언제 올릴지만 정하게 한다.
 *
 * 되묻기가 이 훅에 함께 있는 것은 물음의 조건이 `dirty` 한 칸이기 때문이다 — 바깥에 두면
 * 그 칸만 다시 내보내야 한다. 물음의 뒷말만 자리마다 다르므로 어느 뒷말인지를 인자로 받는다.
 */
function useDocDraft(confirm: (request: ConfirmRequest) => Promise<boolean>) {
  const { text } = useI18n();
  const [doc, setDoc] = useState<DocumentFile | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);

  // 문서를 화면에 올리는 세 자리(이동·생성·저장)가 같은 네 상태를 같은 순서로 갱신했다.
  // 편집 여부는 자리마다 달라(이동은 읽기, 생성은 편집, 저장은 그대로) 인자로만 받고,
  // 넘기지 않으면 저장처럼 편집 상태를 건드리지 않는다.
  const showDocument = (file: DocumentFile, nextEditing?: boolean) => {
    setDoc(file);
    setDraft(file.content ?? "");
    setDirty(false);
    if (nextEditing !== undefined) setEditing(nextEditing);
  };

  const clearDocument = () => {
    setDoc(null);
    setDraft("");
    setDirty(false);
    setEditing(false);
  };

  /** 초안이 원본과 달라진 순간에만 수정 표시가 켜진다. 되돌려 적으면 다시 꺼진다. */
  const changeDraft = (value: string) => {
    setDraft(value);
    setDirty(value !== (doc?.content ?? ""));
  };

  // 저장하지 않은 초안이 있을 때 되묻는 자리가 넷(문서 이동·폴더 전환·새 문서·기록 이동)이라
  // 조건과 문구 조립이 그만큼 흩어져 있었다.
  const confirmDiscardDraft = async (question: DiscardQuestion) => !dirty || await confirm({
    title: "저장하지 않은 변경",
    message: text(
      `저장하지 않은 변경이 있습니다. ${DISCARD_QUESTIONS[question].ko}`,
      `You have unsaved changes. ${DISCARD_QUESTIONS[question].en}`,
    ),
    warning: text("계속하면 편집 중인 초안은 사라집니다.", "Continuing discards the draft you are editing."),
    confirmLabel: "계속",
    tone: "danger",
  });

  return { doc, draft, editing, dirty, setEditing, showDocument, clearDocument, changeDraft, confirmDiscardDraft };
}

/**
 * 실패를 화면 위쪽 공용 배너 한 자리로 돌리는 한 벌. 문서 화면에서 서버를 부르는 자리는
 * 네 곳(폴더 목록 다시 읽기·폴더 등록 재시도·등록 해제·파일 작업)인데, 넷이 모두 같은
 * 세 줄(`try` → `catch (cause)` → `setError(errorText(cause))`)을 각자 적어 두어 오류
 * 문구를 만드는 방식을 바꾸면 네 자리를 함께 고쳐야 했다. 실패를 삼키고 성공 여부만
 * 돌려주는 것은 예전 네 자리의 동작 그대로다 — 부르는 쪽은 배너가 뜬 뒤 그냥 멈춘다.
 *
 * 진행 표시를 켜고 끄는 일과 부르기 전 배너를 비우는 일은 자리마다 달라 여기 두지 않는다.
 */
async function reportFailure(
  showError: (message: string) => void,
  work: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (cause) {
    showError(errorText(cause));
    return false;
  }
}

/** 이동 기록 훅이 돌려주는 한 벌. 파일 작업 훅은 이 묶음을 그대로 받아 쓴다. */
type DocHistory = ReturnType<typeof useDocHistory>;

interface UseDocFileActionsOptions {
  doc: DocumentFile | null;
  draft: string;
  selectedRoot: DocRootStatus | null;
  history: DocHistory;
  showDocument: (file: DocumentFile, nextEditing?: boolean) => void;
  confirmDiscardDraft: (question: DiscardQuestion) => Promise<boolean>;
  setError: (message: string | null) => void;
  /** 새 문서를 만들어 화면을 옮긴 뒤. 겹쳐 떠 있는 사이드바를 닫는 자리다. */
  onNavigated: () => void;
}

/**
 * 파일을 건드리는 세 자리(새 문서 만들기·저장·내려받기) 한 벌. 셋은 같은 순서(진행 표시
 * 켜기 → 오류 지우기 → 실패 시 오류 표시 → 진행 표시 끄기)를 지나고, 앞의 둘은 끝나고
 * 나면 같은 뒷정리(파일을 다시 읽어 화면에 올리고 트리 리비전을 올리기)까지 함께한다.
 * 그 공통 절차와 진행 표시 두 칸, 새 문서 입력 칸, 트리 리비전이 화면 본문에서 이동·폴더
 * 전환·사이드바 흐름 사이에 흩어져 있어 한자리에 모은다.
 *
 * 이동 기록과 사이드바 닫기는 이 훅이 소유하지 않는다 — 이동 자리도 같은 기록을 쓰므로,
 * 새 문서가 착지할 기준만 `history`로 받고 화면 전환 뒷일은 `onNavigated`로 돌려 준다.
 * 이 훅은 효과를 하나도 등록하지 않아 호출 자리가 다른 훅들의 효과 순서를 바꾸지 않는다.
 */
function useDocFileActions({
  doc,
  draft,
  selectedRoot,
  history,
  showDocument,
  confirmDiscardDraft,
  setError,
  onNavigated,
}: UseDocFileActionsOptions) {
  const [newDocPath, setNewDocPath] = useState("");
  const [treeRevision, setTreeRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // 진행 표시만 자리마다 다르므로 setter를 인자로 받는다.
  const runBusy = async (setBusy: (value: boolean) => void, work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    await reportFailure(setError, work);
    setBusy(false);
  };

  // 문서 저장과 생성 뒤 파일 내용을 다시 읽고 화면과 트리를 동기화한다.
  // 트리는 파일 목록·수정 일시 변경을 반영하기 위해 리비전을 올린다.
  const syncDocumentFile = async (
    target: DocumentRef,
    onLoaded?: (file: DocumentFile) => void,
    nextEditing?: boolean,
  ) => {
    const file = await getDocumentFile(target.rootId, target.relativePath);
    onLoaded?.(file);
    showDocument(file, nextEditing);
    setTreeRevision((current) => current + 1);
    return file;
  };

  const createFile = async () => {
    if (!selectedRoot || !newDocPath.trim()) return;
    if (!(await confirmDiscardDraft("createFile"))) return;
    const historyBeforeNavigation = history.captureScroll();
    await runBusy(setSaving, async () => {
      const path = markdownDocumentPath(newDocPath);
      // QA #65. 만들기는 저장이 아니다. putDoc을 expected=null로 부르면 같은 이름의 문서가
      // 이미 있을 때 아무 확인 없이 본문이 '# 새 문서' 한 줄로 덮여 사라졌다. 생성 전용
      // 입구는 이미 있는 경로를 거절하고, 그 사유를 아래 오류 자리에 그대로 보여 준다.
      const created = await createDoc(selectedRoot.id, path, "# 새 문서\n");
      await syncDocumentFile(created, (file) => {
        history.land(historyBeforeNavigation, file);
      }, true);
      setNewDocPath("");
      onNavigated();
    });
  };

  const save = async () => {
    if (!doc) return;
    await runBusy(setSaving, async () => {
      await putDoc(doc.rootId, doc.relativePath, draft, doc.modifiedAt);
      await syncDocumentFile(doc);
    });
  };

  const downloadCurrentDoc = async () => {
    if (!doc || downloading) return;
    await runBusy(setDownloading, () => downloadDocumentFile(doc.rootId, doc.relativePath));
  };

  return { newDocPath, setNewDocPath, treeRevision, saving, downloading, createFile, save, downloadCurrentDoc };
}

interface UseDocNavigationOptions {
  doc: DocumentFile | null;
  roots: DocRootStatus[] | null;
  selectedRoot: DocRootStatus | null;
  setSelectedRoot: (root: DocRootStatus | null) => void;
  history: DocHistory;
  showDocument: (file: DocumentFile, nextEditing?: boolean) => void;
  /** 열려 있는 문서 네 칸만 비운다. 진행 중인 이동과 연결 미리보기는 이 훅이 함께 끊는다. */
  clearDocumentState: () => void;
  confirmDiscardDraft: (question: DiscardQuestion) => Promise<boolean>;
  setError: (message: string | null) => void;
  sidebarIsOverlay: boolean;
  setSidebarVisibility: (open: boolean) => void;
}

/**
 * 문서 사이를 옮겨 다니는 한 벌(트리에서 고르기·기록 앞뒤·폴더 전환·문서 안 링크 열기)과
 * 그 뒷일(진행 표시, 늦게 온 응답을 버리는 요청번호, 연결 파일 미리보기, 겹쳐 뜬 사이드바
 * 닫기). 다섯 자리가 모두 같은 한 절차(`navigateToDocument`)로 모이는데도 그 절차와 요청번호·
 * 진행 표시가 화면 본문에 펼쳐져 있어, 이동 한 갈래를 고치려면 사이드바·기록·폼 사이에
 * 흩어진 줄을 함께 읽어야 했다. 이미 훅으로 서 있는 초안·등록부·기록·파일 작업 옆에
 * 같은 높이로 세워 화면은 배치와 콜백 연결만 맡는다.
 *
 * 연결 파일 미리보기를 여기 두는 것은 그 열림·닫힘이 곧 이동이기 때문이다 — 링크를 여는
 * 자리가 Markdown이면 문서 이동, 아니면 미리보기로 갈리고, 문서를 비우는 자리는 미리보기도
 * 함께 닫는다. 이 훅은 효과를 하나도 등록하지 않아 호출 자리가 다른 훅들의 효과 순서를
 * 바꾸지 않는다.
 */
function useDocNavigation({
  doc,
  roots,
  selectedRoot,
  setSelectedRoot,
  history,
  showDocument,
  clearDocumentState,
  confirmDiscardDraft,
  setError,
  sidebarIsOverlay,
  setSidebarVisibility,
}: UseDocNavigationOptions) {
  const { text } = useI18n();
  const [navigating, setNavigating] = useState(false);
  // 늦게 도착한 문서 응답을 버리는 요청 세대. 트리 창이 쓰는 것과 같은 한 벌을 그대로 쓴다.
  const navigation = useRequestGeneration();

  const selectedRootId = selectedRoot?.id ?? null;
  const currentDocPath = doc?.relativePath ?? null;
  const loadLinkedFile = useCallback((href: string) => withSelectedDocument(
    selectedRootId,
    currentDocPath,
    (rootId, relativePath) => getDocLinkedFile(rootId, relativePath, href),
  ), [currentDocPath, selectedRootId]);
  const downloadLinkedFile = useCallback((href: string) => withSelectedDocument(
    selectedRootId,
    currentDocPath,
    (rootId, relativePath) => downloadDocLinkedFile(rootId, relativePath, href),
  ), [currentDocPath, selectedRootId]);
  const linkedFilePreview = useLinkedFilePreview(loadLinkedFile);

  // 좁은 화면에서 사이드바는 본문 위에 겹쳐 뜬다. 문서가 바뀌어 착지한 자리(이동·새 문서)는
  // 그 사이드바를 닫는다. 넓은 화면에서는 사이드바가 본문 옆에 있어 그대로 둔다.
  const closeSidebarOverlay = () => { if (sidebarIsOverlay) setSidebarVisibility(false); };

  // 진행 중인 이동 응답을 버리는 표시. 폴더를 바꾸거나 해제할 때 늦게 도착한 문서가
  // 새 선택을 덮어쓰지 않게 한다.
  const cancelNavigation = () => {
    navigation.open();
    setNavigating(false);
  };

  // 문서 선택을 비우는 자리(폴더 전환·폴더 해제)에서 진행 중인 이동·연결 미리보기·문서 상태를
  // 함께 비워, 다른 폴더로 옮기거나 폴더가 사라졌을 때 이전 문서의 초안·수정 여부가 남지 않게 한다.
  const clearDocument = () => {
    cancelNavigation();
    linkedFilePreview.close();
    clearDocumentState();
  };

  const navigateToDocument = async (
    target: DocumentRef,
    historyIndex: number | null = null,
  ) => {
    if (historyIndex === null && isSameDocument(doc, target)) return;
    if (!(await confirmDiscardDraft("navigate"))) return;
    const { rootId, relativePath } = target;
    const targetRoot = roots?.find((root) => root.id === rootId);
    if (!targetRoot) {
      setError(text("등록 폴더를 찾을 수 없습니다.", "That registered folder is gone."));
      return;
    }

    const historyBeforeNavigation = history.captureScroll();
    if (historyIndex !== null && !history.pointsAt(historyBeforeNavigation, historyIndex, target)) return;

    const requestId = navigation.open();
    setNavigating(true);
    setError(null);
    await navigation.latest(requestId, () => getDocumentFile(rootId, relativePath), {
      onResult: (file) => {
        history.land(historyBeforeNavigation, target, historyIndex);
        setSelectedRoot(targetRoot);
        showDocument(file, false);
        closeSidebarOverlay();
      },
      onError: setError,
      onSettled: () => setNavigating(false),
    });
  };

  const selectFile = (entry: DocumentEntry) => {
    if (!selectedRoot) return;
    const target = { rootId: selectedRoot.id, relativePath: entry.relativePath };
    if (sidebarIsOverlay && isSameDocument(doc, target)) {
      setSidebarVisibility(false);
      return;
    }
    void navigateToDocument(target);
  };

  const moveHistory = (offset: -1 | 1) => {
    const target = history.step(offset);
    if (!target) return;
    void navigateToDocument(target.entry, target.index);
  };

  const selectRoot = async (root: DocRootStatus) => {
    if (selectedRoot?.id === root.id) return;
    if (!(await confirmDiscardDraft("navigate"))) return;
    history.captureScroll();
    setSelectedRoot(root);
    clearDocument();
  };

  const openLinkedDoc = (href: string) => {
    if (!doc || !selectedRoot) return;
    const targetPath = parseLinkPath(href);
    if (targetPath && isMarkdownPath(targetPath)) {
      const relativePath = resolveDocLinkPath(selectedRoot.path, doc.relativePath, targetPath);
      if (!relativePath) {
        setError(text(
          "등록 폴더 밖의 Markdown 링크는 열 수 없습니다.",
          "Markdown links outside the registered folder cannot be opened.",
        ));
        return;
      }
      void navigateToDocument({ rootId: doc.rootId, relativePath });
      return;
    }
    linkedFilePreview.open(href);
  };

  return {
    navigating,
    linkedFilePreview,
    downloadLinkedFile,
    closeSidebarOverlay,
    clearDocument,
    selectFile,
    moveHistory,
    selectRoot,
    openLinkedDoc,
  };
}

/**
 * 등록 폴더 등록부. 폴더 목록·현재 선택·등록 폼 세 칸과 그 갱신 절차(다시 읽기·등록)는
 * 문서 읽기·편집·이동 기록과 상태를 나눠 갖지 않으면서도 DocsView 본문에 흩어져 있었다.
 * 훅으로 모아 화면은 목록과 폼을 그리는 일만 맡는다.
 *
 * 오류는 화면 위쪽 공용 배너 한 자리에 모이므로 표시 함수를 인자로 받는다(React setter라
 * 신원이 고정되어 `reloadRoots`도 함께 고정된다). 없는 폴더를 만들지 되묻는 확인도 화면의
 * 공용 모달 하나를 쓰므로 `confirm`을 함께 받는다.
 */
function useDocRootRegistry(
  showError: (message: string | null) => void,
  confirm: (request: ConfirmRequest) => Promise<boolean>,
) {
  const { text } = useI18n();
  const [roots, setRoots] = useState<DocRootStatus[] | null>(null);
  const [selectedRoot, setSelectedRoot] = useState<DocRootStatus | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");

  const reloadRoots = useCallback(async () => {
    await reportFailure(showError, async () => {
      const next = await getDocRoots();
      setRoots(next);
      setSelectedRoot((current) => next.find((root) => root.id === current?.id) ?? next[0] ?? null);
    });
  }, [showError]);

  useEffect(() => { void reloadRoots(); }, [reloadRoots]);

  const submitRoot = async (targetPath: string, createIfMissing = false) => {
    const root = await createDocRoot(name, targetPath, createIfMissing);
    setName("");
    setPath("");
    setFormOpen(false);
    await reloadRoots();
    setSelectedRoot(root);
  };

  // 아직 만들지 않은 폴더를 등록 폴더로 등록하려는 것은 오타만큼이나 흔하다. 없는 경로일
  // 때만 만들지 물어보고, 승인하면 등록이 없는 칸을 함께 만들도록 다시 시도한다. 폴더를
  // 따로 만들지 않고 등록 안에서 만드는 것은 왕복을 한 번으로 줄이려는 것이다 — 예전에는
  // `create_directory`가 호스트 전용이라 원격에서 거절되는 문제까지 함께 피했지만, 지금은
  // 원격 편집 허용 스위치 하나로 통일돼 두 경로 모두 같은 권한을 받는다(C6-6).
  const addRoot = async () => {
    showError(null);
    try {
      await submitRoot(path);
    } catch (cause) {
      const missing = missingDirectoryPath(errorText(cause));
      // 없는 칸이 여럿이면 중간 칸도 새로 생긴다. 승인 전에 생길 것을 모두 보여 준다(C6-4b).
      const plan = missing === null ? null : await previewDirectoryCreation(missing).catch(() => null);
      const items = directoryCreationItems(plan, missing ?? "");
      const accepted = missing !== null && await confirm({
        title: "새 폴더 만들기",
        message: items.length > 1
          ? text(
            "이 경로에 폴더가 없습니다. 아래 폴더를 차례로 만들고 등록할까요?",
            "No folder exists at this path. Create the folders below in order and register it?",
          )
          : text(
            "이 경로에 폴더가 없습니다. 새로운 폴더를 만들고 등록할까요?",
            "No folder exists at this path. Create a new folder and register it?",
          ),
        items,
        confirmLabel: text("만들고 등록", "Create and register"),
      });
      if (!accepted) {
        showError(errorText(cause));
        return;
      }
      await reportFailure(showError, () => submitRoot(missing, true));
    }
  };

  /**
   * 등록 해제. 되묻기·삭제·목록 다시 읽기는 등록과 같은 한 벌이라 여기 둔다. 예전에는 이
   * 하나만 화면 본문에 남아 있어 `reloadRoots`가 그 자리 하나 때문에 바깥으로 나가 있었다.
   *
   * `forget`은 등록부가 모르는 화면 쪽 기억(이동 기록·열려 있던 문서)을 지우는 자리다.
   * 선택이 풀리는 것은 등록부 몫이라 여기서 비우고, 그 뒤 목록을 다시 읽는다 — 다시 읽기가
   * 첫 폴더를 고르므로 순서를 뒤집으면 사라진 폴더가 잠깐 다시 선택된다.
   */
  const removeRoot = async (root: DocRootStatus, forget: () => void) => {
    const accepted = await confirm({
      title: text("등록 폴더 해제", "Unregister folder"),
      message: text(
        `'${root.name}' 등록을 해제할까요?\n원본 폴더와 파일은 삭제되지 않습니다.`,
        `Unregister '${root.name}'?\nThe folder and its files are not deleted.`,
      ),
      items: [root.path],
      confirmLabel: "해제",
    });
    if (!accepted) return;
    await reportFailure(showError, async () => {
      await deleteDocRoot(root.id);
      forget();
      setSelectedRoot((current) => current?.id === root.id ? null : current);
      await reloadRoots();
    });
  };

  const rootForm: DocRootFormState = {
    name,
    path,
    open: formOpen,
    setName,
    setPath,
    toggle: () => setFormOpen((value) => !value),
    submit: addRoot,
  };

  return { roots, selectedRoot, setSelectedRoot, removeRoot, rootForm };
}

/**
 * 문서 폴더 사이드바의 여닫힘. 열림 여부를 화면 밖에 보존하는 일, 좁은 화면에서 본문 위에
 * 겹쳐 뜨는지 판정하는 일, 여닫은 뒤 포커스를 닫기·되살리기 버튼으로 옮기는 일, 겹쳐 떠
 * 있을 때만 Esc로 닫는 일이 한 값(열림)에 매달려 있어 한자리에 모은다.
 *
 * 포커스를 옮길 대상은 `setVisibility`를 부른 쪽이 정해 ref에 적어 두고, 다음 배치(layout)
 * 단계에서 한 번만 소비한다. 첫 렌더처럼 아무도 부르지 않은 경우에는 옮기지 않는다.
 */
function useDocsSidebar() {
  const [open, setOpen] = useState(() => readSecondaryPaneOpen(DOC_SIDEBAR_OPEN_KEY));
  const [isOverlay, setIsOverlay] = useState(() => window.matchMedia(SIDEBAR_OVERLAY_QUERY).matches);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLButtonElement>(null);
  const focusTargetRef = useRef<"close" | "restore" | null>(null);

  const setVisibility = (next: boolean) => {
    focusTargetRef.current = next ? "close" : "restore";
    setOpen(next);
  };

  useEffect(() => writeSecondaryPaneOpen(DOC_SIDEBAR_OPEN_KEY, open), [open]);
  useEffect(() => {
    const query = window.matchMedia(SIDEBAR_OVERLAY_QUERY);
    const sync = () => setIsOverlay(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useLayoutEffect(() => {
    const target = focusTargetRef.current;
    if (!target) return;
    focusTargetRef.current = null;
    if (target === "close") closeRef.current?.focus();
    else restoreRef.current?.focus();
  }, [open]);
  useEscapeToClose(() => setVisibility(false), open && isOverlay);

  return { open, isOverlay, setVisibility, closeRef, restoreRef };
}

/**
 * 문서 이동 기록. 항목 목록과 현재 위치, 되돌아갈 때 복원할 스크롤 위치를 함께 다룬다.
 * 갱신 직후 같은 턴에서 최신 기록을 다시 읽는 자리(연속 이동·폴더 해제)가 있어 상태와
 * ref를 나란히 들고, 둘을 한 번에 바꾸는 `commit`만 안에서 쓴다. 스크롤 복원은 문서가
 * 바뀐 뒤 배치(layout) 단계에서 한 번만 일어나야 하므로 이 훅이 함께 들고 있다.
 */
function useDocHistory(workspaceRef: RefObject<HTMLElement | null>, doc: DocumentFile | null) {
  const [state, setState] = useState<DocHistoryState>({ entries: [], index: -1 });
  const stateRef = useRef<DocHistoryState>({ entries: [], index: -1 });
  const pendingScrollTopRef = useRef<number | null>(null);

  const commit = (next: DocHistoryState) => {
    stateRef.current = next;
    setState(next);
  };

  /**
   * 지금 보고 있는 문서의 스크롤 위치를 기록에 반영하고 그 결과를 돌려준다. 호출부는
   * 반환값을 이동이 끝날 때까지 들고 있다가 `land`에 넘겨, 비동기로 문서를 읽어 오는
   * 사이에 다른 갱신이 끼어들어도 같은 기준에서 이어 쌓게 한다.
   */
  const captureScroll = (): DocHistoryState => {
    const current = stateRef.current;
    const entry = current.entries[current.index];
    if (!entry || !isSameDocument(entry, doc)) return current;
    const scrollTop = workspaceRef.current?.scrollTop ?? entry.scrollTop;
    if (scrollTop === entry.scrollTop) return current;
    const entries = [...current.entries];
    entries[current.index] = { ...entry, scrollTop };
    const next = { entries, index: current.index };
    commit(next);
    return next;
  };

  /** 기록으로 되돌아가는 요청이 지금도 그 자리를 가리키는지. 어긋나면 이동을 시작하지 않는다. */
  const pointsAt = (base: DocHistoryState, index: number, target: DocumentRef): boolean => {
    return isSameDocument(base.entries[index], target);
  };

  /**
   * 문서를 화면에 올리면서 기록을 확정한다. 기록 이동이면 그 자리로 옮기고 저장해 둔
   * 스크롤을, 새 이동·생성이면 항목을 쌓고 맨 위를 복원 대상으로 남긴다.
   */
  const land = (base: DocHistoryState, target: DocumentRef, historyIndex: number | null = null) => {
    const entry = historyIndex === null ? null : base.entries[historyIndex];
    if (historyIndex !== null && entry) {
      commit({ entries: base.entries, index: historyIndex });
      pendingScrollTopRef.current = entry.scrollTop;
      return;
    }
    commit(pushHistoryEntry(base, target));
    pendingScrollTopRef.current = 0;
  };

  /** 기록에서 offset만큼 떨어진 자리. 양 끝을 넘어서면 null이다. */
  const step = (offset: -1 | 1): { index: number; entry: DocHistoryEntry } | null => {
    const index = stateRef.current.index + offset;
    const entry = stateRef.current.entries[index];
    return entry ? { index, entry } : null;
  };

  /** 등록이 풀린 폴더의 항목을 걷어낸다. 현재 위치는 남은 항목 기준으로 다시 센다. */
  const dropRoot = (rootId: string) => {
    commit(dropHistoryRoot(stateRef.current, rootId));
  };

  useLayoutEffect(() => {
    const scrollTop = pendingScrollTopRef.current;
    if (scrollTop === null) return;
    pendingScrollTopRef.current = null;
    workspaceRef.current?.scrollTo({ top: scrollTop, behavior: "auto" });
  }, [doc?.relativePath, doc?.rootId]);

  return { state, captureScroll, pointsAt, land, step, dropRoot };
}

/**
 * 등록이 풀린 폴더의 이동 기록과 현재 위치를 한 번에 다시 만든다. 예전에는 전체 기록과
 * 현재 위치 앞 기록을 따로 걸러 같은 항목을 두 번 판별했다. 원래 배열을 한 번만 훑으며
 * 현재 위치까지 남은 항목 수도 함께 세어, 제거 뒤에도 같은 기록을 가리키게 한다.
 */
function dropHistoryRoot(current: DocHistoryState, rootId: string): DocHistoryState {
  const entries: DocHistoryEntry[] = [];
  let retainedThroughCurrent = 0;
  current.entries.forEach((entry, sourceIndex) => {
    if (entry.rootId === rootId) return;
    entries.push(entry);
    if (sourceIndex <= current.index) retainedThroughCurrent += 1;
  });
  return {
    entries,
    index: Math.min(retainedThroughCurrent - 1, entries.length - 1),
  };
}

// 이동 기록은 현재 위치 뒤를 잘라내고 새 항목을 쌓는다. 같은 문서를 다시 열었을 때는
// 항목을 늘리지 않고 스크롤만 맨 위로 되돌리고, 기록은 최근 DOC_HISTORY_LIMIT개만 남긴다.
function pushHistoryEntry(base: DocHistoryState, target: DocumentRef): DocHistoryState {
  let entries = base.entries.slice(0, base.index + 1);
  const previous = entries[entries.length - 1];
  if (isSameDocument(previous, target)) {
    entries[entries.length - 1] = { ...previous, scrollTop: 0 };
  } else {
    entries.push({ rootId: target.rootId, relativePath: target.relativePath, scrollTop: 0 });
  }
  if (entries.length > DOC_HISTORY_LIMIT) entries = entries.slice(-DOC_HISTORY_LIMIT);
  return { entries, index: entries.length - 1 };
}

// 링크 표기에서 바깥 꺾쇠(`<...>`)를 벗겨낸다.
function stripLinkBrackets(target: string): string {
  const trimmed = target.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
}

// 링크 표기에서 퍼센트 인코딩을 풀고 구분자·쿼리·프래그먼트와 `:12` 같은 줄 번호 꼬리를
// 떼어 경로만 남긴다. 디코드할 수 없는 링크는 비교하지 않고 버린다(null).
function decodeLinkPath(target: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  return decoded.replace(/\\/g, "/").split(/[?#]/, 1)[0].replace(/:\d+$/, "");
}

/** 꺾쇠를 벗기고 디코딩과 쿼리·해시 제거를 거쳐 순수 링크 경로만 추출한다. */
function parseLinkPath(href: string): string | null {
  return decodeLinkPath(stripLinkBrackets(href));
}

function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

/** 연결 문서를 읽거나 내려받기 전에 두 작업이 공유하는 현재 문서 문맥을 확인한다. */
function withSelectedDocument<T>(
  rootId: string | null,
  relativePath: string | null,
  work: (rootId: string, relativePath: string) => Promise<T>,
): Promise<T> {
  // React 문맥 밖의 평범한 함수라 `useI18n`의 `text`를 쓸 수 없다. 같은 언어 선택 규칙을
  // 따르는 `runtimeText`로 짝을 짓는다.
  if (!rootId || !relativePath) return Promise.reject(new Error(runtimeText("파일을 선택하세요.", "Select a file.")));
  return work(rootId, relativePath);
}

/**
 * 경로 세그먼트 배열에서 빈 문자열과 '.'을 건너뛰고 '..'으로 상위 디렉터리를 거슬러 올라간다.
 * 최상위 경로를 벗어나려는 '..'이 나오면 잘못된 상대 경로로 보아 null을 돌려준다.
 */
function normalizePathSegments(segments: string[]): string | null {
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) return null;
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.length > 0 ? normalized.join("/") : null;
}

/**
 * 구문 분석(꺾쇠·퍼센트 인코딩·쿼리·줄 번호)을 거친 링크 경로를 등록 폴더 기준으로 해석한다.
 * 절대 경로는 등록 폴더 접두사를 확인하고, 상대 경로는 현재 문서 위치에 얹어 정규화한다.
 */
function resolveDocLinkPath(rootPath: string, currentPath: string, target: string): string | null {
  const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
  const absolute = target.startsWith("/") || /^[a-z]:\//i.test(target);
  let segments: string[];
  if (absolute) {
    const rootPrefix = `${root}/`;
    if (target.toLowerCase().startsWith(rootPrefix.toLowerCase())) {
      segments = target.slice(rootPrefix.length).split("/");
    } else if (target.startsWith("/")) {
      segments = target.slice(1).split("/");
    } else {
      return null;
    }
  } else {
    segments = [...currentPath.split("/").slice(0, -1), ...target.split("/")];
  }

  return normalizePathSegments(segments);
}
