import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ArchiveX, ChevronDown, ChevronRight, ChevronUp, FileText, Folder, FolderInput, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  attachProjectInstructionDeployment,
  checkProjectInstructionDelete,
  createProjectInstruction,
  deleteProjectInstructionDeployment,
  deleteSharedProjectInstruction,
  detachProjectInstructionDeployment,
  downloadDeployedInstructionLinkedFile,
  getDeployedInstructionLinkedFile,
  getProjectInstructionLibrary,
  getProjectInstructionMigrationPlan,
  importProjectInstruction,
  listInstructionTrash,
  previewProjectInstructionImport,
  publishProjectInstruction,
  purgeInstructionTrash,
  readDeployedInstructionFile,
  readProjectInstructionFile,
  restoreInstructionTrash,
  setProjectInstructionAutoSync,
  setProjectInstructionPlatforms,
  syncProjectInstructionFromDeployment,
  unarchiveSharedProjectInstruction,
  updateProjectInstruction,
} from "../lib/ipc";
import { formatBytes, sourceName, formatDateTime } from "../lib/format";
import { useI18n, type UiText } from "../lib/i18n";
import { runtimeText } from "../lib/i18nRuntime";
import { localDocumentLinks } from "../lib/markdownLinks";
import { displayPath } from "../lib/displayPath";
import { useMenuTranslations } from "../lib/translations";
import type {
  DeployedInstructionFileContent,
  HostPlatform,
  InstructionImportLinkedDoc,
  InstructionImportPreview,
  InstructionPublishReceipt,
  InstructionTrashOverview,
  ProjectInstructionDeployment,
  ProjectInstructionEntry,
  ProjectInstructionLibrary,
  ProviderId,
  SkillOverwritePolicy,
  SystemAutomationSnapshot,
} from "../types";
import { LinkedFilePreview, useLinkedFilePreview } from "./LinkedFilePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { Drawer, EmptyState, ErrorBanner, LoadingState, Modal, SourceBadge, useConfirm, type ConfirmRequest } from "./Shared";
import { FilterAxisBar, filterMatcher, type FilterAxisSpec } from "./FilterAxisBar";
import { OriginalContent } from "./DetailDrawer";
import { BulkMigrationButton, HOST_PLATFORMS, LibraryRowMain, LibraryToolbar, LocationProviderMatrix, PlatformSupportFields, SkillUseToggle, ToggleMatrix, TrashRow, ViewModeTabs, arraysEqual, busyRunner, filterAxes, platformLabel, useAutoSync, useStoredChoice, useTrashGroupSizes, type BusyRunner } from "./SkillLibraryPanel";
import { TranslateResourceButton } from "./TranslationProgress";
import { aiaRuntimeProvider } from "../lib/aiaRuntime";
import { instructionBulkMigrationPrompt } from "../lib/skillTransfer";
import { errorText } from "../lib/errorText";
import { PROVIDER_IDS } from "../lib/providerIds";

/**
 * 배포 위치를 IPC가 받는 `(scope, projectPath)` 한 쌍으로 바꾼다. `scope`가 넓은 문자열
 * 타입이라 호출부마다 `scope === "personal"`을 두 번씩 되풀이해 좁히고 personal일 때
 * `projectPath`를 비우고 있었다. 아홉 자리가 같은 두 줄을 손으로 반복하다 보니 한쪽만
 * 고치면 어긋나는 모양이었다. 판정을 여기 한 곳에 둔다.
 */
function deploymentTarget(source: { scope: string; projectPath: string | null }): {
  scope: "personal" | "project";
  projectPath: string | null;
} {
  return source.scope === "personal"
    ? { scope: "personal", projectPath: null }
    : { scope: "project", projectPath: source.projectPath };
}

interface InstructionPublishSummary {
  succeeded: number;
  linkedWritten: number;
  linkedSkipped: number;
}

/** 게시 영수증의 화면용 개수를 결과·연결 문서까지 한 번만 훑어 집계한다. */
function summarizeInstructionPublish(receipt: InstructionPublishReceipt): InstructionPublishSummary {
  const summary: InstructionPublishSummary = { succeeded: 0, linkedWritten: 0, linkedSkipped: 0 };
  for (const result of receipt.results) {
    if (result.outcome === "published" || result.outcome === "replaced" || result.outcome === "unchanged") {
      summary.succeeded += 1;
    }
    for (const linked of result.linkedResults ?? []) {
      if (linked.outcome === "published" || linked.outcome === "replaced") summary.linkedWritten += 1;
      if (linked.outcome === "skipped") summary.linkedSkipped += 1;
    }
  }
  return summary;
}

/**
 * 공급자별 지침 파일 이름. 여기서 아는 것은 파일 이름 하나뿐이다 — 표시 이름은
 * `format`의 `sourceName`이 정본이고, 새 지침의 처음 내용은 이 이름에서 짓는다.
 * 세 값을 한 표에 나란히 두었더니 표시 이름만 정본과 따로 굳어 갔다.
 */
const INSTRUCTION_FILE_NAMES: Record<ProviderId, string> = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  antigravity: "GEMINI.md",
  // 로컬 공급자는 Codex 하네스를 빌려 쓰므로 같은 AGENTS.md를 읽는다.
  local: "AGENTS.md",
};
/** 게시 위치 select에서 개인 설정을 나타내는 센티널 값. 프로젝트 경로와 겹치지 않는다. */
const PERSONAL_LOCATION = "__personal__";
/** 지침 키의 최대 글자 수. 백엔드 `validate_instruction_key`의 `MAX_INSTRUCTION_KEY_CHARS`와 같다. */
const INSTRUCTION_KEY_MAX = 64;
const INSTRUCTION_MODE_KEY = "agent-manager.instruction-mode.v1";

/**
 * `info`는 개인·프로젝트에 실제로 있는 지침 파일을 그대로 보여주는 읽기 전용
 * 화면이고, `manage`는 공통 원본 보관·게시·동기화를 다루는 통합 관리 화면이다.
 */
const INSTRUCTION_VIEW_MODES = ["info", "manage"] as const;
type InstructionViewMode = (typeof INSTRUCTION_VIEW_MODES)[number];

interface InstructionsViewProps {
  onChanged?: (message: string) => void;
  onRequestAiaPrompt?: (prompt: string) => void;
  /** 설정에서 공통 저장소 경로가 바뀌면 증가한다. 값이 바뀌면 새 경로로 다시 읽는다. */
  repositoryRevision?: number;
  /** 선택 지침의 번역 버튼 상태를 읽고 갱신한다. */
  automation?: SystemAutomationSnapshot | null;
  onAutomationChange?: (snapshot: SystemAutomationSnapshot) => void;
}

/** 스킬·지침 공통 저장소와 프로젝트 지침 원본을 한곳에서 관리한다. */
export function InstructionsView({
  onChanged,
  onRequestAiaPrompt,
  repositoryRevision = 0,
  automation,
  onAutomationChange,
}: InstructionsViewProps) {
  const { text } = useI18n();
  const [library, setLibrary] = useState<ProjectInstructionLibrary | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<InstructionBusyKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [trash, setTrash] = useState<InstructionTrashOverview | null>(null);
  const [mode, setMode] = useStoredChoice<InstructionViewMode>(INSTRUCTION_MODE_KEY, INSTRUCTION_VIEW_MODES, "info");
  // 만들기·가져오기·휴지통은 한 번씩 쓰는 작업이라 목록 아래에 펼쳐 두지 않고 툴바에서 연다.
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  // 목록 새로 고침과 번역 진행 상태 변화 양쪽에서 지침 이름·설명 번역을 다시 읽는다.
  // 둘 다 단조 증가하는 값이라 더해서 변경 감지 키로 쓴다.
  const [translationRevision, setTranslationRevision] = useState(0);
  const translations = useMenuTranslations("instructions", translationRevision + (automation?.revision ?? 0));

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextLibrary, nextTrash] = await Promise.all([
        getProjectInstructionLibrary(),
        listInstructionTrash(),
      ]);
      setLibrary(nextLibrary);
      setTrash(nextTrash);
      setTranslationRevision((current) => current + 1);
      setSelectedKey((current) => (
        current && nextLibrary.entries.some((entry) => entry.key === current)
          ? current
          : nextLibrary.entries[0]?.key ?? null
      ));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  // 설정에서 저장소 경로를 바꾸면 보관 지침 목록이 통째로 달라지므로 다시 읽는다.
  useEffect(() => {
    void refresh();
  }, [refresh, repositoryRevision]);

  const selected = useMemo(
    () => library?.entries.find((entry) => entry.key === selectedKey) ?? null,
    [library, selectedKey],
  );

  // 자동 동기화: 외부 수정이 감지된 지침 중 자동 모드인 항목은 그 버전을 원본에
  // 반영하고 나머지 배포 프로젝트에 재배포한다. 서로 다른 수정이 여러 개면 자동
  // 판단이 불가능하므로 수동(외부 수정 감지 카드)으로 남긴다. 배포 원장에 오른
  // 위치만 본다. 파일 이름이 같을 뿐인 남의 지침을 원본으로 채택하면 안 된다.
  useAutoSync(
    library,
    () => (library?.entries ?? []).flatMap((entry) => {
      if (!entry.autoSync) return [];
      const divergents = entry.deployments.filter((deployment) =>
        deployment.managed && deployment.present && deployment.divergent && !deployment.message);
      if (divergents.length === 0) return [];
      const target = divergents[0];
      return [{
        key: entry.key,
        // 지침 파일이 같아도 연결 문서가 서로 다르면 어느 세트를 채택할지 알 수 없다.
        digests: divergents.map((deployment) => deployment.setDigest ?? deployment.contentDigest ?? ""),
        run: () => syncProjectInstructionFromDeployment({
          key: entry.key,
          ...deploymentTarget(target),
          provider: target.provider,
        }),
        done: text(
          `'${entry.key}' 지침을 자동 동기화했습니다. 이전 원본은 휴지통에 있습니다.`,
          `Auto-synced instruction '${entry.key}'. The previous source is in the trash.`,
        ),
      }];
    }),
    (message) => {
      reportChanged(message);
      return refresh();
    },
    (cause) => setError(errorMessage(cause)),
  );

  // 휴지통을 비우면 남는 게 없으므로 서랍을 닫는다. 툴바 버튼도 같은 조건으로 사라진다.
  useEffect(() => {
    if ((trash?.items.length ?? 0) === 0) setTrashOpen(false);
  }, [trash]);

  const reportChanged = (message: string) => {
    setNotice(message);
    onChanged?.(message);
  };

  // 작업을 실행하는 자식 넷(선택 지침·휴지통·가져오기·만들기)은 모두 같은 다섯 값을
  // 받는다. 호출부마다 다섯 줄을 손으로 적어 두면 한 값을 바꿀 때 네 자리를 함께 고쳐야
  // 하고, 실제로 빠뜨려도 타입이 잡아 줄 뿐 읽는 사람은 넷이 같은 묶음인지 알 수 없었다.
  const childActions: ChildActionProps = { busy, setBusy, setError, reportChanged, refresh };

  if (loading && !library) {
    return <LoadingState label={text("지침 저장소를 읽고 있습니다", "Loading the instruction repository")} />;
  }

  const modeSwitch = (
    <ViewModeTabs
      label={text("지침 화면 모드", "Instruction view mode")}
      modes={[
        { id: "info", label: text("지침정보", "Info") },
        { id: "manage", label: text("지침관리", "Manage") },
      ]}
      current={mode}
      onSelect={setMode}
    />
  );

  if (mode === "info") {
    return (
      <div className="view-stack instructions-view">
        <section className="toolbar-card skill-mode-toolbar">{modeSwitch}</section>
        {error && <ErrorBanner message={error} />}
        {library ? (
          <InstructionInfoPanel
            library={library}
            setBusy={setBusy}
            setError={setError}
            selectInstruction={(key) => { setSelectedKey(key); setMode("manage"); }}
            translatedKeys={new Set(translations.records.keys())}
            automation={automation ?? null}
            onAutomationChange={onAutomationChange}
          />
        ) : (
          <LoadingState label={text("지침 현황을 읽고 있습니다", "Loading instruction state")} />
        )}
        {confirmDialog}
      </div>
    );
  }

  const migrationRequiredCount = (library?.entries ?? [])
    .filter((entry) => !entry.currentPlatformSupported).length;
  const aiaAvailable = Boolean(aiaRuntimeProvider(automation ?? null));
  const importableCount = importableInstructionCount(library);
  const trashCount = trash?.items.length ?? 0;

  return (
    <div className="view-stack instructions-view">
      <section className="toolbar-card skill-mode-toolbar">
        {modeSwitch}
        {onRequestAiaPrompt && (
          <BulkMigrationButton
            aiaAvailable={aiaAvailable}
            count={migrationRequiredCount}
            noneTitle={text("현재 OS에서 변형이 필요한 지침이 없습니다", "No instructions need a variant on this OS")}
            requestTitle={text("AIA에게 미지원 지침 전체의 현재 OS 변형 생성을 요청합니다", "Ask AIA to create current-OS variants for every unsupported instruction")}
            onRequest={() => onRequestAiaPrompt(instructionBulkMigrationPrompt(migrationRequiredCount))}
          />
        )}
      </section>
      {error && <ErrorBanner message={error} />}
      {notice && <p className="settings-storage-note" role="status">{notice}</p>}

      <LibraryToolbar
        title={text("보관 지침", "Archived instructions")}
        summary={library
          ? text(`${library.entries.length}개 · ${library.commonRoot}`, `${library.entries.length} · ${library.commonRoot}`)
          : text("지침 라이브러리를 읽지 못했습니다.", "The instruction library could not be loaded.")}
      >
        <button className="button compact" type="button" disabled={busy !== null} onClick={() => { void refresh(); }}>
          <RefreshCw size={13} aria-hidden="true" />{text("새로 고침", "Refresh")}
        </button>
        <button
          className="button compact"
          type="button"
          disabled={busy !== null || !library || importableCount === 0}
          title={importableCount === 0
            ? text("등록 프로젝트와 개인 설정에 아직 보관하지 않은 지침 파일이 없습니다", "No unarchived instruction files in registered projects or personal settings")
            : text("이미 있는 지침 파일을 공통 원본으로 보관합니다", "Archive existing instruction files as shared sources")}
          onClick={() => setImporting(true)}
        >
          <FolderInput size={13} aria-hidden="true" />{text("지침 가져오기", "Import")}{importableCount > 0 && <small>{importableCount}</small>}
        </button>
        <button className="button primary compact" type="button" disabled={busy !== null} onClick={() => setCreating(true)}>
          <Plus size={13} aria-hidden="true" />{text("새 지침", "New instruction")}
        </button>
        {trashCount > 0 && (
          <button className="button compact" type="button" disabled={busy !== null} onClick={() => setTrashOpen(true)}>
            <Trash2 size={13} aria-hidden="true" />{text("휴지통", "Trash")}<small>{trashCount}</small>
          </button>
        )}
      </LibraryToolbar>

      <section className="settings-card">
        <header>
          <div>
            <span>{text("지침 라이브러리", "Instruction library")}</span>
            <h2>{text("프로젝트 에이전트 지침", "Project agent instructions")}</h2>
          </div>
          <p>{text(
            "프로젝트 목록은 Agent Manager가 확인한 실제 세션 작업 경로를 사용합니다.",
            "The project list uses actual session working directories discovered by Agent Manager.",
          )}</p>
        </header>
        <div className="settings-card-sections">
          <section className="settings-subsection">
            {library && library.entries.length === 0 ? (
              <EmptyState
                title={text("보관된 지침이 없습니다", "No archived instructions")}
                detail={text("위쪽 '새 지침' 버튼으로 만들거나 '지침 가져오기'로 등록 프로젝트의 기존 지침을 보관하세요.", "Use 'New instruction' above, or 'Import' to archive an existing instruction from a registered project.")}
              />
            ) : (
              <div className="skill-library-list">
                {(library?.entries ?? []).map((entry) => (
                  <div className={`skill-library-item${entry.key === selectedKey ? " selected" : ""}`} key={entry.key}>
                    <button
                      className={`skill-library-row${entry.currentPlatformSupported ? "" : " conflict"}`}
                      type="button"
                      aria-pressed={entry.key === selectedKey}
                      onClick={() => setSelectedKey(entry.key)}
                    >
                      <LibraryRowMain
                        path={entry.directory}
                        description={(translations.records.get(entry.key)?.fields.description ?? entry.description) || text("설명이 없습니다.", "No description.")}
                      >
                        <strong data-user-content>{translations.records.get(entry.key)?.fields.name ?? entry.name}</strong>
                        {!entry.currentPlatformSupported && <span className="skill-sync-pill conflict">{text("OS 변형 필요", "OS variant required")}</span>}
                      </LibraryRowMain>
                      <div className="skill-use-matrix">
                        {entry.providers.map((provider) => <SourceBadge source={provider} key={provider} />)}
                      </div>
                    </button>
                  </div>
                ))}
              </div>
            )}
            {selected && (
              <SelectedInstruction
                entry={selected}
                library={library}
                {...childActions}
                onRequestAiaPrompt={onRequestAiaPrompt}
                confirm={confirm}
                translated={Boolean(translations.records.get(selected.key))}
                automation={automation ?? null}
                onAutomationChange={onAutomationChange}
              />
            )}
          </section>

          {library && library.issues.length > 0 && (
            <section className="settings-subsection">
              <header>
                <div>
                  <strong>{text("확인할 항목", "Issues")}</strong>
                  <small>{text(`${library.issues.length}건의 지침 경로 문제`, `${library.issues.length} instruction path issue(s)`)}</small>
                </div>
              </header>
              <div className="detail-card">
                {library.issues.map((issue) => (
                  <ErrorBanner key={`${issue.provider ?? "all"}:${issue.path}:${issue.message}`} message={`${displayPath(issue.path)}\n${issue.message}`} />
                ))}
              </div>
            </section>
          )}
        </div>
      </section>

      {creating && (
        <CreateInstructionModal
          {...childActions}
          selectInstruction={setSelectedKey}
          onClose={() => setCreating(false)}
        />
      )}

      {importing && library && (
        <ImportInstructionModal
          library={library}
          {...childActions}
          selectInstruction={setSelectedKey}
          onClose={() => setImporting(false)}
        />
      )}

      {trashOpen && trash && (
        <InstructionTrashDrawer
          trash={trash}
          {...childActions}
          confirm={confirm}
          onClose={() => setTrashOpen(false)}
        />
      )}
      {confirmDialog}
    </div>
  );
}

/**
 * 확인 대화를 먼저 띄우는 작업. 확인 문구를 만드는 동안에는 같은 이름에 `-check`를 붙여
 * 잠가 두므로, 두 단계가 한 이름에서 갈라져 나오도록 이 갈래만 따로 센다.
 */
type InstructionConfirmKind = "matrix" | "sync" | "delete" | "unarchive";

/**
 * 지침 화면이 잠긴 이유. 한 화면의 잠금 표식 하나를 단계 패널 여섯과 서랍 둘, 모달 둘이
 * 나눠 읽는데 값이 `string`이라 `busy === "edit_save"` 같은 빗나간 비교가 타입 검사를
 * 그대로 통과했다 — 버튼이 영영 "저장 중…"으로 바뀌지 않아도 아무 데서도 걸리지 않는다.
 * 쓰는 이름을 한 곳에 세어 두어 잘못된 이름이 컴파일에서 걸리게 한다.
 */
type InstructionBusyKind =
  | InstructionConfirmKind
  | `${InstructionConfirmKind}-check`
  | "publish"
  | "migration"
  | "instruction-platforms"
  | "edit-load"
  | "edit-save"
  | "viewer"
  | "info-viewer"
  | "trash-restore"
  | "trash-purge"
  | "import"
  | "create";

interface ChildActionProps {
  busy: InstructionBusyKind | null;
  setBusy: (value: InstructionBusyKind | null) => void;
  setError: (value: string | null) => void;
  reportChanged: (message: string) => void;
  refresh: () => Promise<void>;
}

/**
 * busy 표시와 오류 표시를 두르는 공통 껍데기. 스킬관리 화면 것과 같은 껍데기라 그쪽 한 벌을
 * 가져다 쓰고, 이 화면만 다른 점(거절을 원문 대신 안내 문장으로 보여 준다)은 인자로 준다.
 */
function instructionBusyRunner(
  setBusy: (value: InstructionBusyKind | null) => void,
  setError: (value: string | null) => void,
): BusyRunner<InstructionBusyKind> {
  return busyRunner<InstructionBusyKind>(setBusy, setError, errorMessage);
}

interface DeploymentLocationRow {
  key: string;
  scope: "personal" | "project";
  projectPath: string | null;
  label: string;
  title: string;
}

/**
 * 위치 목록의 뼈대: 개인 설정 한 줄 + 등록 프로젝트 한 줄씩. 배포 매트릭스·지침정보 묶음·
 * 가져오기 모달이 같은 라벨과 같은 설명을 각자 손으로 적어 두어, 한 곳의 문구를 고치면
 * 나머지 둘이 조용히 갈라졌다. 개인 행의 키만 화면마다 다르므로(게시 select는 경로와
 * 겹치지 않는 센티널을 쓴다) 그것만 인자로 받는다.
 */
function instructionLocationRows(
  projects: readonly string[],
  text: UiText,
  personalKey: string = "personal",
): DeploymentLocationRow[] {
  return [
    {
      key: personalKey,
      scope: "personal",
      projectPath: null,
      label: text("개인 설정", "Personal settings"),
      title: text("공급자 홈 설정 디렉터리(~/.claude, ~/.codex, ~/.gemini)", "Provider home config directories (~/.claude, ~/.codex, ~/.gemini)"),
    },
    ...projects.map((project) => ({
      key: project,
      scope: "project" as const,
      projectPath: project,
      label: lastPathSegment(project),
      title: project,
    })),
  ];
}

/**
 * 배포 매트릭스의 위치 행과 그 보임 상태를 한 곳에 모은 훅. 행 조립·검색어·펼침·고정을
 * 화면 본문에 늘어놓으면 상태 넷과 파생값 넷이 다른 관심사(편집·게시·열람) 사이에 흩어져
 * 어느 것이 어느 것을 되짚는지 읽히지 않았다. 선택이 바뀌면 보임 상태를 스스로 되돌린다.
 */
function useDeploymentLocationRows(
  entry: ProjectInstructionEntry,
  library: ProjectInstructionLibrary | null,
) {
  const { text } = useI18n();
  const [showAllLocations, setShowAllLocations] = useState(false);
  const [locationQuery, setLocationQuery] = useState("");
  // 방금 켜고 끈 위치. 접힌 상태에서 해제했다고 행이 사라지면 되돌릴 수 없으므로 남겨 둔다.
  const [pinnedLocations, setPinnedLocations] = useState<string[]>([]);

  useEffect(() => {
    setShowAllLocations(false);
    setLocationQuery("");
    setPinnedLocations([]);
  }, [entry.key]);

  // 매트릭스 행: 개인 설정 한 행 + 등록 프로젝트들. personal은 공급자별 디렉터리가
  // 달라 행 하나가 셀별로 자기 위치를 해석한다. 세션이 사라져 등록 목록에서 빠졌지만
  // 원장에 남은 위치도 행으로 싣는다. 안 그러면 회수할 방법이 없다.
  const matrixRows = useMemo<DeploymentLocationRow[]>(() => {
    const projects = [...(library?.projects ?? [])];
    for (const deployment of entry.deployments) {
      const path = deployment.projectPath;
      if (deployment.scope === "personal" || !deployment.managed || !path) continue;
      if (!projects.includes(path)) projects.push(path);
    }
    return instructionLocationRows(projects, text);
  }, [library?.projects, entry.deployments, text]);

  const projectRowCount = useMemo(
    () => matrixRows.filter((row) => row.scope === "project").length,
    [matrixRows],
  );

  const deployedProjectPaths = useMemo(() => new Set(
    entry.deployments
      .filter((deployment) => deployment.managed && deployment.present
        && deployment.scope === "project" && deployment.projectPath)
      .map((deployment) => deployment.projectPath as string),
  ), [entry.deployments]);

  // 기본은 개인 설정과 이미 배포된 프로젝트만. 프로젝트가 늘어도 표가 화면을
  // 밀어내지 않게, 나머지는 검색하거나 펼쳤을 때만 나온다.
  const visibleRows = useMemo(() => {
    const query = locationQuery.trim().toLowerCase();
    return matrixRows.filter((row) => {
      if (row.scope === "personal") return true;
      if (query) return row.label.toLowerCase().includes(query) || row.title.toLowerCase().includes(query);
      if (showAllLocations) return true;
      const path = row.projectPath ?? "";
      return deployedProjectPaths.has(path) || pinnedLocations.includes(path);
    });
  }, [matrixRows, locationQuery, showAllLocations, deployedProjectPaths, pinnedLocations]);

  const hiddenRowCount = locationQuery.trim() ? 0 : projectRowCount - (visibleRows.length - 1);

  const pinLocation = useCallback((project: string) => {
    setPinnedLocations((current) => (current.includes(project) ? current : [...current, project]));
  }, []);

  return {
    visibleRows,
    projectRowCount,
    hiddenRowCount,
    locationQuery,
    setLocationQuery,
    showAllLocations,
    setShowAllLocations,
    pinLocation,
  };
}

/** useDeploymentLocationRows가 돌려주는 한 벌. 2단계 패널이 그대로 받아 쓴다. */
type DeploymentLocationRows = ReturnType<typeof useDeploymentLocationRows>;

/** 같은 링크가 여러 위치에서 걸린 것을 한 줄로 묶은 안내. */
interface InstructionLinkNotice {
  href: string;
  reason: string;
  locations: number;
}

/**
 * 지침 원본 편집(5단계)의 상태와 두 동작을 한 자리로 모은 훅. 편집 중 여부·이름·설명·
 * 공급자별 본문·읽어 온 본문·변형 출처 여섯 상태와 열기·저장 두 동작이 배포·게시·열람과
 * 뒤섞여 화면 본문에 흩어져 있어, 어느 상태가 편집 몫인지 읽히지 않았다. 훅으로 옮겨도
 * 상태는 선택 지침 카드에 그대로 남으므로 단계 탭을 옮겨 다녀도 쓰던 초안이 살아 있다
 * (패널 컴포넌트가 상태를 들면 탭을 벗어날 때 초안이 사라진다).
 *
 * 고른 지침이 바뀌면 편집을 닫는다. 예전에는 providers·platforms를 되맞추는 효과가
 * 곁다리로 함께 껐는데, 그 효과는 배열 신원까지 따지느라 조건이 복잡해 편집과 얽힐 이유가
 * 없었다. 여기서는 지침 키만 본다.
 */
function useInstructionSourceEditor(
  entry: ProjectInstructionEntry,
  runBusy: BusyRunner<InstructionBusyKind>,
  refresh: () => Promise<void>,
  reportChanged: (message: string) => void,
) {
  const { text } = useI18n();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry.name);
  const [description, setDescription] = useState(entry.description);
  const [contents, setContents] = useState<Partial<Record<ProviderId, string>>>({});
  // 열 때 읽어 온 본문. 저장할 때 실제로 달라진 공급자만 골라 보내는 기준이다.
  const [loaded, setLoaded] = useState<Partial<Record<ProviderId, string>>>({});
  const [variantSources, setVariantSources] = useState<Partial<Record<ProviderId, HostPlatform>>>({});

  useEffect(() => setEditing(false), [entry.key]);

  const open = async () => {
    await runBusy("edit-load", async () => {
      const files = await Promise.all(entry.providers.map(async (provider) => ({
        provider,
        file: await readProjectInstructionFile(entry.key, provider),
      })));
      const nextContents: Partial<Record<ProviderId, string>> = {};
      const variants: Partial<Record<ProviderId, HostPlatform>> = {};
      for (const { provider, file } of files) {
        nextContents[provider] = file.content;
        if (file.sourceVariant) variants[provider] = file.sourceVariant;
      }
      setContents(nextContents);
      setLoaded(nextContents);
      setVariantSources(variants);
      setName(entry.name);
      setDescription(entry.description);
      setEditing(true);
    });
  };

  const save = async () => {
    const files = entry.providers
      .filter((provider) => (contents[provider] ?? "") !== (loaded[provider] ?? ""))
      .map((provider) => ({ provider, content: contents[provider] ?? "" }));
    const nameChanged = name.trim() !== entry.name;
    const descriptionChanged = description.trim() !== entry.description;
    if (files.length === 0 && !nameChanged && !descriptionChanged) {
      setEditing(false);
      return;
    }
    await runBusy("edit-save", async () => {
      const receipt = await updateProjectInstruction({
        key: entry.key,
        name: nameChanged ? name : null,
        description: descriptionChanged ? description : null,
        files,
        expectedDigest: entry.sourceDigest,
      });
      setEditing(false);
      await refresh();
      reportChanged(text(
        `지침 원본을 저장하고 배포 프로젝트 ${receipt.results.length}곳에 재배포했습니다.`,
        `Saved the instruction source and redeployed to ${receipt.results.length} deployed project(s).`,
      ));
    });
  };

  return {
    editing,
    close: () => setEditing(false),
    name,
    setName,
    description,
    setDescription,
    contents,
    setContents,
    variantSources,
    open,
    save,
  };
}

type InstructionSourceEditor = ReturnType<typeof useInstructionSourceEditor>;

/**
 * 배포 목록의 갈래 넷. 넷 모두 "읽을 수 있는 배포"(파일이 있고 오류 메시지가 없는 것)를
 * 공통 전제로 삼아 원장 등록·외부 수정 여부로만 갈라지므로, 같은 배열을 네 번 훑는 대신
 * 한 순회로 함께 모은다. 배포로 다루는 위치는 원장에 오른 곳뿐이다. 같은 이름의 파일이
 * 있을 뿐인 위치는 이 원본과 비교하지 않으므로 divergent도 서지 않지만, 갈래를 명시해
 * 의도를 남긴다.
 */
function useDeploymentGroups(deployments: ProjectInstructionDeployment[]): {
  presentDeployments: ProjectInstructionDeployment[];
  managedDeployments: ProjectInstructionDeployment[];
  divergentDeployments: ProjectInstructionDeployment[];
  /** 그 위치에 지침 파일은 있는데 이 원본의 배포로는 등록되지 않은 곳. */
  unmanagedDeployments: ProjectInstructionDeployment[];
} {
  return useMemo(() => {
    const present: ProjectInstructionDeployment[] = [];
    const managed: ProjectInstructionDeployment[] = [];
    const divergent: ProjectInstructionDeployment[] = [];
    const unmanaged: ProjectInstructionDeployment[] = [];
    for (const deployment of deployments) {
      if (!deployment.present || deployment.message) continue;
      present.push(deployment);
      if (!deployment.managed) {
        unmanaged.push(deployment);
        continue;
      }
      managed.push(deployment);
      if (deployment.divergent) divergent.push(deployment);
    }
    return {
      presentDeployments: present,
      managedDeployments: managed,
      divergentDeployments: divergent,
      unmanagedDeployments: unmanaged,
    };
  }, [deployments]);
}

/**
 * 3단계 배포 확인의 원문 열람 상태. 고른 배포 파일의 원문을 읽어 두고, 고른 지침이 바뀌면
 * 앞 지침의 원문이 남지 않도록 닫는다.
 */
function useDeployedFileViewer(
  entryKey: string,
  presentDeployments: ProjectInstructionDeployment[],
  runBusy: BusyRunner<InstructionBusyKind>,
): {
  viewerTarget: string;
  viewerContent: DeployedInstructionFileContent | null;
  openViewer: (selection: string) => Promise<void>;
} {
  const [viewerTarget, setViewerTarget] = useState("");
  const [viewerContent, setViewerContent] = useState<DeployedInstructionFileContent | null>(null);

  useEffect(() => {
    setViewerTarget("");
    setViewerContent(null);
  }, [entryKey]);

  const openViewer = async (selection: string) => {
    setViewerTarget(selection);
    setViewerContent(null);
    const deployment = presentDeployments.find((candidate) => deploymentKey(candidate) === selection);
    if (!deployment) return;
    await runBusy("viewer", async () => {
      const target = deploymentTarget(deployment);
      setViewerContent(await readDeployedInstructionFile(target.scope, target.projectPath, deployment.provider));
    });
  };

  return { viewerTarget, viewerContent, openViewer };
}

/**
 * 4단계 자동 반영 체크박스. 체크 상태는 누른 쪽이 이미 안다. 쓰기 왕복 뒤에 목록 재조회까지
 * 기다리면 체크박스가 두 왕복 뒤에야 움직이고, 그 사이 busy로 잠기기까지 한다. 화면을 먼저
 * 바꾸고 재조회는 확정용으로 뒤에서 돌린다. 재조회가 끝나면 목록이 같은 값을 들고 오므로
 * 덧댄 값을 버려, 이후 외부 변경을 그대로 따라간다.
 */
function useInstructionAutoSync(
  entry: ProjectInstructionEntry,
  refresh: () => Promise<void>,
  setError: (value: string | null) => void,
): { autoSyncChecked: boolean; toggleAutoSync: (autoSync: boolean) => void } {
  // 서버 확정 전에 먼저 보여 주기 위한 덧댄 값. 목록이 갱신되면 버린다.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [entry.autoSync]);

  const toggleAutoSync = (autoSync: boolean) => {
    setError(null);
    setOverride(autoSync);
    void setProjectInstructionAutoSync(entry.key, autoSync)
      .then(() => refresh())
      .catch((cause: unknown) => {
        setOverride(null);
        setError(errorMessage(cause));
      });
  };

  return { autoSyncChecked: override ?? entry.autoSync, toggleAutoSync };
}

interface InstructionProcessStep {
  no: number;
  title: string;
  detail: string;
  /** 탭에 붙는 표시. `attention`은 점을 찍고 `muted`는 흐리게 둔다. */
  tone: "" | "attention" | "muted";
}

/** 아래 구획이 어떤 순서로 이어지는지 카드 머리에서 먼저 알려 주는 여섯 단계 탭. */
function instructionProcessSteps(
  text: UiText,
  marks: { currentPlatformSupported: boolean; hasReviewSection: boolean; hasDivergent: boolean },
): InstructionProcessStep[] {
  return [
    {
      no: 1,
      title: text("지원 OS 지정", "Set supported OS"),
      detail: text("base 지침을 그대로 쓸 OS를 정합니다.", "Decide which platforms use the base instruction as-is."),
      tone: marks.currentPlatformSupported ? "" : "attention",
    },
    {
      no: 2,
      title: text("위치별 배포", "Deploy by location"),
      detail: text("개인 설정과 프로젝트에 지침 파일을 놓거나 뺍니다.", "Place or remove the file in personal settings and projects."),
      tone: "",
    },
    {
      no: 3,
      title: text("배포 확인", "Review deployments"),
      detail: text("실제로 놓인 파일 원문과 링크 보관 상태를 봅니다.", "Check the deployed file contents and archived link status."),
      tone: marks.hasReviewSection ? "" : "muted",
    },
    {
      no: 4,
      title: text("외부 수정 정리", "Resolve external edits"),
      detail: text("원본과 달라진 배포본을 자동 반영하거나 한 버전을 원본으로 채택합니다.", "Auto-adopt external edits, or make one version the source."),
      tone: marks.hasDivergent ? "attention" : "",
    },
    {
      no: 5,
      title: text("편집", "Edit"),
      detail: text("보관된 원본을 고치고 배포된 위치에 다시 반영합니다.", "Edit the archived source and redeploy it."),
      tone: "",
    },
    {
      no: 6,
      title: text("게시", "Publish"),
      detail: text("아직 배포하지 않은 위치에 지침을 새로 게시합니다.", "Publish the instruction to a location that does not have it yet."),
      tone: "",
    },
  ];
}

/** 6단계 게시 양식이 들고 있는 값. 게시와 OS 메타 저장이 그대로 읽어 요청을 만든다. */
interface InstructionPublishForm {
  projectPath: string;
  providers: ProviderId[];
  overwrite: SkillOverwritePolicy;
  platforms: HostPlatform[];
}

/**
 * 선택 지침을 바꾸는 작업 아홉(게시·배포 토글·원장 등록·수정본 채택·자동 반영 토글·원본
 * 삭제·보관취소·OS 메타 저장·마이그레이션 요청)을 한 곳에 모은 훅.
 *
 * 이 작업들은 선택 지침 카드 한 함수 안에서 화면 상태(단계 탭·편집기·열람기·매트릭스 행)와
 * 뒤섞여 있었다. 셋 다 같은 `entry`를 닫아 두고 있어 어느 것이 서버를 바꾸고 어느 것이
 * 보임만 바꾸는지 읽는 쪽이 세어 봐야 했고, 작업 하나를 고칠 때 400줄을 훑어야 했다.
 * 서버를 바꾸는 갈래만 떼어 내고, 닫혀 있던 값들(양식·확인 대화·매트릭스 고정·배포 수)은
 * 인자로 드러낸다. 화면 상태는 카드에 그대로 남는다.
 */
function useInstructionMutations({
  entry,
  library,
  form,
  runBusy,
  refresh,
  reportChanged,
  setError,
  confirm,
  pinLocation,
  presentDeploymentCount,
  onRequestAiaPrompt,
}: {
  entry: ProjectInstructionEntry;
  library: ProjectInstructionLibrary | null;
  form: InstructionPublishForm;
  runBusy: BusyRunner<InstructionBusyKind>;
  refresh: () => Promise<void>;
  reportChanged: (message: string) => void;
  setError: (value: string | null) => void;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  pinLocation: (project: string) => void;
  presentDeploymentCount: number;
  onRequestAiaPrompt?: (prompt: string) => void;
}) {
  const { text } = useI18n();

  // personal 행은 공급자마다 디렉터리(projectPath)가 달라 scope로만 찾는다.
  const deploymentAt = (
    scope: "personal" | "project",
    project: string | null,
    provider: ProviderId,
  ): ProjectInstructionDeployment | null =>
    entry.deployments.find((deployment) =>
      deployment.provider === provider
      && deployment.scope === scope
      && (scope === "personal" || deployment.projectPath === project)) ?? null;

  /**
   * "확인받고 → 실행하고 → 목록을 다시 읽고 → 결과를 보고한다"는 네 갈래 작업(배포 제거·
   * 수정본 채택·원본 삭제·보관취소)이 같은 골격을 각자 펼쳐 놓고 있었다. 되풀이되던 순서를
   * 한 곳에 모아, 각 작업은 확인 문구와 실제 호출만 넘긴다.
   *
   * 확인 문구를 만들려면 먼저 서버를 읽어야 하는 작업(삭제 영향 조회)은 `request`에 함수를
   * 넘긴다. 그 조회는 `<kind>-check` 바쁨 상태로 감싸 확인 대화가 뜰 때까지 화면이 잠긴
   * 채로 있게 한다.
   */
  const runConfirmed = async (
    kind: InstructionConfirmKind,
    request: ConfirmRequest | (() => Promise<ConfirmRequest | null>),
    /** 결과값은 쓰지 않는다. 호출을 그대로 넘길 수 있게 반환형만 열어 둔다. */
    action: () => Promise<unknown>,
    done: string,
  ) => {
    if (typeof request === "function") {
      const accepted = await runBusy(`${kind}-check`, async () => {
        const built = await request();
        return built === null ? false : await confirm(built);
      });
      if (!accepted) return;
    } else if (!await confirm(request)) {
      return;
    }
    await runBusy(kind, async () => {
      await action();
      await refresh();
      reportChanged(done);
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await runBusy("publish", async () => {
      const receipt = await publishProjectInstruction({
        key: entry.key,
        scope: form.projectPath === PERSONAL_LOCATION ? "personal" : "project",
        projectPath: form.projectPath === PERSONAL_LOCATION ? null : form.projectPath,
        providers: form.providers,
        overwrite: form.overwrite,
      });
      await refresh();
      const { succeeded, linkedWritten, linkedSkipped } = summarizeInstructionPublish(receipt);
      const skipPart = linkedSkipped > 0
        ? text(`, ${linkedSkipped}개 건너뜀`, `, ${linkedSkipped} skipped`)
        : "";
      const linkedNote = linkedWritten > 0 || linkedSkipped > 0
        ? `${text(` · 연결 문서 ${linkedWritten}개 배포`, ` · ${linkedWritten} linked doc(s) deployed`)}${skipPart}`
        : "";
      reportChanged(text(
        `${entry.name} 지침 게시를 처리했습니다. 성공 ${succeeded}/${receipt.results.length}${linkedNote}`,
        `Processed publishing ${entry.name}. Successful ${succeeded}/${receipt.results.length}${linkedNote}`,
      ));
    });
  };

  /** 배포 매트릭스 토글. 켜면 그 위치에 게시하고 끄면 확인 후 휴지통으로 옮긴다. */
  const toggleDeployment = async (
    scope: "personal" | "project",
    project: string | null,
    provider: ProviderId,
    use: boolean,
  ) => {
    setError(null);
    if (scope === "project" && project) pinLocation(project);
    if (use) {
      await runBusy("matrix", async () => {
        const receipt = await publishProjectInstruction({
          key: entry.key,
          scope,
          projectPath: project,
          providers: [provider],
          overwrite: "fail",
        });
        const failed = receipt.results.find((result) => result.outcome === "skipped"
          || result.outcome === "failed"
          || (result.linkedResults ?? []).some((linked) => linked.outcome === "skipped"));
        if (failed?.message) setError(failed.message);
        await refresh();
      });
      return;
    }
    const deployment = deploymentAt(scope, project, provider);
    if (!deployment) return;
    await runConfirmed(
      "matrix",
      {
        title: text("배포 지침 파일 제거", "Remove deployed instruction file"),
        message: text(
          "이 위치에서 지침 파일을 제거합니다. 파일은 휴지통으로 이동해 복구할 수 있습니다.",
          "Remove the instruction file from this location. The file moves to the trash and can be restored.",
        ),
        items: [deployment.filePath],
        confirmLabel: text("제거", "Remove"),
        tone: "danger",
      },
      () => deleteProjectInstructionDeployment(scope, project, provider),
      text("배포 지침 파일을 휴지통으로 옮겼습니다.", "Moved the deployed instruction file to the trash."),
    );
  };

  /**
   * 배포 원장만 손질한다. 등록하면 그 위치가 이 원본의 배포가 되어 이후 편집이 함께
   * 반영되고, 해제하면 파일은 그대로 남은 채 갱신·회수 대상에서만 빠진다.
   */
  const setDeploymentRegistered = async (
    deployment: ProjectInstructionDeployment,
    registered: boolean,
  ) => {
    await runBusy("matrix", async () => {
      const request = {
        key: entry.key,
        ...deploymentTarget(deployment),
        provider: deployment.provider,
      };
      if (registered) await attachProjectInstructionDeployment(request);
      else await detachProjectInstructionDeployment(request);
      await refresh();
      reportChanged(registered
        ? text("이 위치를 이 지침의 배포로 등록했습니다.", "Registered this location as a deployment of this instruction.")
        : text("배포 등록을 해제했습니다. 파일은 그대로 있습니다.", "Unregistered the deployment. The file is untouched."));
    });
  };

  /** 외부 수정본을 새 원본으로 채택하고 나머지 배포 프로젝트에 재배포한다. */
  const adoptDeployment = async (deployment: ProjectInstructionDeployment) => {
    await runConfirmed(
      "sync",
      {
        title: text("이 버전으로 동기화", "Sync to this version"),
        message: text(
          "이 파일이 공통 원본이 되고 같은 공급자 지침이 배포된 나머지 프로젝트에 재배포됩니다.\n이전 원본은 휴지통으로 이동합니다.",
          "This file becomes the shared source and is redeployed to the other projects using this provider instruction.\nThe previous source moves to the trash.",
        ),
        items: [deployment.filePath],
        confirmLabel: text("동기화", "Sync"),
      },
      async () => {
        await syncProjectInstructionFromDeployment({
          key: entry.key,
          ...deploymentTarget(deployment),
          provider: deployment.provider,
        });
      },
      text(
        "수정본을 원본으로 채택하고 재배포했습니다. 이전 원본은 휴지통에 있습니다.",
        "Adopted the edited file as the source and redeployed. The previous source is in the trash.",
      ),
    );
  };

  const { autoSyncChecked, toggleAutoSync } = useInstructionAutoSync(entry, refresh, setError);

  /** 원본과 원본 내용 그대로인 배포 파일을 확인 후 한 그룹으로 삭제한다. */
  const deleteShared = async () => {
    await runConfirmed(
      "delete",
      async () => {
        const impact = await checkProjectInstructionDelete({ key: entry.key });
        return {
          title: text("지침 원본 삭제", "Delete instruction source"),
          message: text(
            "공통 원본과 원본 내용 그대로인 배포 파일을 휴지통으로 옮깁니다. 그룹 단위로 복구할 수 있습니다.",
            "Move the shared source and matching deployed files to the trash. They can be restored as a group.",
          ),
          items: impact.items.map((item) => item.path),
          warning: impact.warnings.length > 0
            ? text(
              `외부에서 수정된 ${impact.warnings.length}개 파일은 남겨둡니다.`,
              `${impact.warnings.length} externally edited file(s) will be left in place.`,
            )
            : undefined,
          confirmLabel: text("삭제", "Delete"),
          tone: "danger" as const,
        };
      },
      () => deleteSharedProjectInstruction(entry.key),
      text(
        `'${entry.name}' 지침을 휴지통으로 옮겼습니다.`,
        `Moved instruction '${entry.name}' to the trash.`,
      ),
    );
  };

  /** 보관만 취소한다. 배포 파일은 그 자리에 남고 원본만 휴지통으로 간다. */
  const unarchiveShared = async () => {
    const deployedCount = presentDeploymentCount;
    await runConfirmed(
      "unarchive",
      {
        title: text("지침 보관취소", "Unarchive instruction"),
        message: deployedCount > 0
          ? text(
            `'${entry.name}' 지침의 보관을 취소할까요?\n보관 원본만 휴지통으로 가고, 배포된 지침 파일 ${deployedCount}곳과 연결 문서는 그 자리에 남아 '미보관'으로 돌아갑니다.`,
            `Unarchive instruction '${entry.name}'?\nOnly the archived source moves to the trash. The ${deployedCount} deployed file(s) and their linked documents stay in place and return to 'unarchived'.`,
          )
          : text(
            `'${entry.name}' 지침의 보관을 취소할까요?\n배포된 파일이 없어 목록에서 사라집니다. 휴지통에서 되돌릴 수 있습니다.`,
            `Unarchive instruction '${entry.name}'?\nIt has no deployed files, so it disappears from the list. You can restore it from the trash.`,
          ),
        items: [entry.directory],
        confirmLabel: text("보관취소", "Unarchive"),
      },
      () => unarchiveSharedProjectInstruction(entry.key),
      text(
        `'${entry.name}' 지침의 보관을 취소했습니다.`,
        `Unarchived instruction '${entry.name}'.`,
      ),
    );
  };

  const requestMigration = async () => {
    if (!onRequestAiaPrompt || entry.currentPlatformSupported) return;
    await runBusy("migration", async () => {
      const plan = await getProjectInstructionMigrationPlan(entry.key, library?.currentPlatform ?? "macos");
      onRequestAiaPrompt(plan.aiaPrompt);
      reportChanged(text("AIA 입력창에 지침 마이그레이션 요청을 넣었습니다.", "Added the instruction migration request to the AIA composer."));
    });
  };

  const savePlatformMetadata = async () => {
    await runBusy("instruction-platforms", async () => {
      await setProjectInstructionPlatforms({
        key: entry.key,
        platforms: form.platforms,
        expectedDigest: entry.sourceDigest,
      });
      await refresh();
      reportChanged(text(
        "지침 지원 OS 메타데이터를 저장했습니다. 프로젝트 파일은 자동으로 덮어쓰지 않습니다.",
        "Saved instruction OS metadata. Existing project files were not overwritten automatically.",
      ));
    });
  };

  return {
    deploymentAt,
    submit,
    toggleDeployment,
    setDeploymentRegistered,
    adoptDeployment,
    autoSyncChecked,
    toggleAutoSync,
    deleteShared,
    unarchiveShared,
    requestMigration,
    savePlatformMetadata,
  };
}

function SelectedInstruction({
  entry,
  library,
  busy,
  setBusy,
  setError,
  reportChanged,
  refresh,
  onRequestAiaPrompt,
  confirm,
  translated,
  automation,
  onAutomationChange,
}: ChildActionProps & {
  entry: ProjectInstructionEntry;
  library: ProjectInstructionLibrary | null;
  onRequestAiaPrompt?: (prompt: string) => void;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  translated: boolean;
  automation: SystemAutomationSnapshot | null;
  onAutomationChange?: (snapshot: SystemAutomationSnapshot) => void;
}) {
  const { text } = useI18n();
  const runBusy = instructionBusyRunner(setBusy, setError);
  const [projectPath, setProjectPath] = useState<string>(PERSONAL_LOCATION);
  const [providers, setProviders] = useState<ProviderId[]>(entry.providers);
  const [overwrite, setOverwrite] = useState<SkillOverwritePolicy>("fail");
  const [platforms, setPlatforms] = useState<HostPlatform[]>(entry.platforms);
  const [activeStep, setActiveStep] = useState(1);
  const editor = useInstructionSourceEditor(entry, runBusy, refresh, reportChanged);

  // 단계·편집 상태는 고른 지침이 바뀔 때만 처음으로 돌린다. 목록을 다시 읽으면(새로 고침·배포 토글 뒤
  // refresh) 같은 지침이라도 entry와 그 안의 providers·platforms 배열이 새 신원으로 오므로, 배열 신원에
  // 걸어 두면 값이 같아도 효과가 다시 발화해 보고 있던 2단계 배포 매트릭스가 사라진다. 그래서 마지막으로
  // 반영한 값을 기억해 두고, 지침이 같으면 값이 실제로 달라진 축만 따라간다.
  const syncedEntry = useRef<{ key: string; providers: ProviderId[]; platforms: HostPlatform[] } | null>(null);
  useEffect(() => {
    const previous = syncedEntry.current;
    syncedEntry.current = { key: entry.key, providers: entry.providers, platforms: entry.platforms };
    if (!previous || previous.key !== entry.key) {
      setProviders(entry.providers);
      setPlatforms(entry.platforms);
      setActiveStep(1);
      return;
    }
    if (!arraysEqual(previous.providers, entry.providers)) setProviders(entry.providers);
    if (!arraysEqual(previous.platforms, entry.platforms)) setPlatforms(entry.platforms);
  }, [entry.key, entry.platforms, entry.providers]);

  useEffect(() => {
    if (projectPath !== PERSONAL_LOCATION && !library?.projects.includes(projectPath)) {
      setProjectPath(PERSONAL_LOCATION);
    }
  }, [library, projectPath]);

  // 같은 링크가 여러 위치에서 걸리면 한 줄로 묶어 보여준다.
  const linkNotices = useMemo(() => {
    const grouped = new Map<string, { href: string; reason: string; locations: number }>();
    for (const deployment of entry.deployments) {
      for (const issue of deployment.linkIssues ?? []) {
        const key = `${issue.href}\n${issue.reason}`;
        const found = grouped.get(key);
        if (found) found.locations += 1;
        else grouped.set(key, { href: issue.href, reason: issue.reason, locations: 1 });
      }
    }
    return [...grouped.values()];
  }, [entry.deployments]);

  const {
    presentDeployments,
    managedDeployments,
    divergentDeployments,
    unmanagedDeployments,
  } = useDeploymentGroups(entry.deployments);

  const locationRows = useDeploymentLocationRows(entry, library);
  const { pinLocation } = locationRows;

  const { viewerTarget, viewerContent, openViewer } = useDeployedFileViewer(entry.key, presentDeployments, runBusy);

  const {
    deploymentAt,
    submit,
    toggleDeployment,
    setDeploymentRegistered,
    adoptDeployment,
    autoSyncChecked,
    toggleAutoSync,
    deleteShared,
    unarchiveShared,
    requestMigration,
    savePlatformMetadata,
  } = useInstructionMutations({
    entry,
    library,
    form: { projectPath, providers, overwrite, platforms },
    runBusy,
    refresh,
    reportChanged,
    setError,
    confirm,
    pinLocation,
    presentDeploymentCount: presentDeployments.length,
    onRequestAiaPrompt,
  });

  const hasReviewSection = entry.linkedFiles.length > 0 || linkNotices.length > 0 || presentDeployments.length > 0;
  const processSteps = instructionProcessSteps(text, {
    currentPlatformSupported: entry.currentPlatformSupported,
    hasReviewSection,
    hasDivergent: divergentDeployments.length > 0,
  });
  const activeStepInfo = processSteps.find((step) => step.no === activeStep) ?? processSteps[0];
  const currentPlatformLabel = platformLabel(library?.currentPlatform ?? "macos", text);
  const supportedPlatformsLabel = entry.platforms.length > 0
    ? entry.platforms.map((platform) => platformLabel(platform, text)).join(", ")
    : text("전체", "All");

  return (
    <div className="detail-card instruction-manage-card">
      <div className="section-title">
        <h3>{text("선택 지침 관리", "Manage selected instruction")}</h3>
        <div className="section-title-actions">
          {onAutomationChange && (
            <TranslateResourceButton
              menu="instructions"
              resourceId={entry.key}
              translated={translated}
              automation={automation}
              onAutomationChange={onAutomationChange}
            />
          )}
          <button className="button compact" type="button" disabled={busy !== null} onClick={() => { void unarchiveShared(); }} title={text("배포 파일은 남기고 보관 원본만 뺍니다", "Keep the deployed files and remove only the archived source")}>
            <ArchiveX size={13} aria-hidden="true" />{busy === "unarchive" ? text("보관취소 중…", "Unarchiving…") : text("보관취소", "Unarchive")}
          </button>
          <button className="button compact danger-subtle" type="button" disabled={busy !== null} onClick={() => { void deleteShared(); }}>
            <Trash2 size={13} aria-hidden="true" />{busy === "delete" ? text("삭제 중…", "Deleting…") : text("원본 삭제", "Delete source")}
          </button>
        </div>
      </div>
      <p className="prose-copy">{text(
        `현재 OS: ${currentPlatformLabel} · 지원 OS: ${supportedPlatformsLabel}`,
        `Current OS: ${currentPlatformLabel} · Supported OS: ${supportedPlatformsLabel}`,
      )}</p>
      <p className="prose-copy instruction-process-copy">{text(
        "지침 하나는 지원 OS 지정 → 위치별 배포 → 배포 확인 → 외부 수정 정리 → 편집 → 게시 순서로 다룹니다. 아래 탭에서 단계를 고르세요.",
        "One instruction moves through set supported OS → deploy by location → review deployments → resolve external edits → edit → publish. Pick a step in the tabs below.",
      )}</p>
      <div className="instruction-tabs" role="tablist">
        {processSteps.map((step) => (
          <button
            className={`instruction-tab${step.no === activeStep ? " active" : ""}${step.tone ? ` ${step.tone}` : ""}`}
            type="button"
            role="tab"
            id={`instruction-tab-${step.no}`}
            aria-selected={step.no === activeStep}
            aria-controls="instruction-step-panel"
            title={step.detail}
            key={step.no}
            onClick={() => setActiveStep(step.no)}
          >
            <span className="instruction-step-mark">{step.no}</span>
            {step.title}
            {step.tone === "attention" && <span className="instruction-tab-dot" aria-hidden="true" />}
          </button>
        ))}
      </div>
      <div
        className="instruction-step-panel"
        id="instruction-step-panel"
        role="tabpanel"
        aria-labelledby={`instruction-tab-${activeStep}`}
      >
        <p className="instruction-step-lead">
          <strong>{activeStepInfo.title}</strong>
          <span>{activeStepInfo.detail}</span>
        </p>
        {activeStep === 1 && (
          <InstructionPlatformStep
            entry={entry}
            platforms={platforms}
            onPlatformsChange={setPlatforms}
            busy={busy}
            onSave={savePlatformMetadata}
            onRequestMigration={requestMigration}
            migrationAvailable={Boolean(onRequestAiaPrompt)}
          />
        )}
        {activeStep === 2 && (
          <InstructionDeployStep
            entry={entry}
            rows={locationRows}
            busy={busy}
            deploymentAt={deploymentAt}
            onToggleDeployment={toggleDeployment}
            onSetRegistered={setDeploymentRegistered}
            unmanagedDeployments={unmanagedDeployments}
            managedDeployments={managedDeployments}
          />
        )}
        {activeStep === 3 && (
          <InstructionReviewStep
            entry={entry}
            hasReviewSection={hasReviewSection}
            linkNotices={linkNotices}
            presentDeployments={presentDeployments}
            viewerTarget={viewerTarget}
            viewerContent={viewerContent}
            busy={busy}
            onOpenViewer={openViewer}
          />
        )}
        {activeStep === 4 && (
          <InstructionDriftStep
            autoSyncChecked={autoSyncChecked}
            onToggleAutoSync={toggleAutoSync}
            divergentDeployments={divergentDeployments}
            busy={busy}
            onAdopt={adoptDeployment}
          />
        )}
        {activeStep === 5 && <InstructionEditorPanel editor={editor} providers={entry.providers} busy={busy} />}
        {activeStep === 6 && (
          <InstructionPublishStep
            entry={entry}
            library={library}
            projectPath={projectPath}
            onProjectPathChange={setProjectPath}
            providers={providers}
            onProvidersChange={setProviders}
            overwrite={overwrite}
            onOverwriteChange={setOverwrite}
            busy={busy}
            onSubmit={submit}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 1단계: base 지침을 그대로 쓸 OS를 정한다. 고른 OS 집합은 선택 지침 카드가 들고 있어
 * 단계 탭을 옮겨 다녀도 저장 전 선택이 남는다.
 */
function InstructionPlatformStep({ entry, platforms, onPlatformsChange, busy, onSave, onRequestMigration, migrationAvailable }: {
  entry: ProjectInstructionEntry;
  platforms: HostPlatform[];
  onPlatformsChange: (platforms: HostPlatform[]) => void;
  busy: InstructionBusyKind | null;
  onSave: () => Promise<void>;
  onRequestMigration: () => Promise<void>;
  /** AIA 입력창이 없는 화면에서는 변형 만들기 버튼을 누를 수 없다. */
  migrationAvailable: boolean;
}) {
  const { text } = useI18n();
  return (
    <PlatformSupportFields
      description={text(
        "base 지침을 그대로 사용할 OS를 선택하세요. 미선택이면 모든 OS에서 사용하는 portable 지침입니다.",
        "Select platforms that can use the base instruction as-is. No selection means the instruction is portable.",
      )}
      platforms={platforms}
      saved={entry.platforms}
      disabled={busy !== null}
      saving={busy === "instruction-platforms"}
      onPlatformsChange={onPlatformsChange}
      onSave={() => { void onSave(); }}
      migration={entry.currentPlatformSupported ? null : {
        disabled: !migrationAvailable,
        busy: busy === "migration",
        onRequest: () => { void onRequestMigration(); },
      }}
    />
  );
}

/**
 * 2단계: 위치별 배포 매트릭스와 배포 원장 손질. 행 목록·검색·펼침은 useDeploymentLocationRows가
 * 들고 있는 한 벌을 그대로 받아 쓴다.
 */
function InstructionDeployStep({ entry, rows, busy, deploymentAt, onToggleDeployment, onSetRegistered, unmanagedDeployments, managedDeployments }: {
  entry: ProjectInstructionEntry;
  rows: DeploymentLocationRows;
  busy: InstructionBusyKind | null;
  deploymentAt: (scope: "personal" | "project", project: string | null, provider: ProviderId) => ProjectInstructionDeployment | null;
  onToggleDeployment: (scope: "personal" | "project", project: string | null, provider: ProviderId, use: boolean) => Promise<void>;
  onSetRegistered: (deployment: ProjectInstructionDeployment, registered: boolean) => Promise<void>;
  unmanagedDeployments: ProjectInstructionDeployment[];
  managedDeployments: ProjectInstructionDeployment[];
}) {
  const { text } = useI18n();
  const { visibleRows, projectRowCount, hiddenRowCount, locationQuery, setLocationQuery, showAllLocations, setShowAllLocations } = rows;
  return (
    <>
      <p className="prose-copy">{text(
        "개인 설정과 프로젝트별로 지침 파일 배포를 켜고 끕니다. 해제된 파일은 휴지통으로 이동합니다.",
        "Turn instruction file deployment on or off for personal settings and each project. Removed files move to the trash.",
      )}</p>
      <div className="instruction-location-toolbar">
        {projectRowCount > 5 && (
          <input
            className="search-input"
            type="search"
            value={locationQuery}
            placeholder={text("프로젝트 검색", "Search projects")}
            onChange={(event) => setLocationQuery(event.target.value)}
          />
        )}
        {hiddenRowCount > 0 && (
          <button className="button compact" type="button" onClick={() => setShowAllLocations(true)}>
            <ChevronDown size={13} aria-hidden="true" />
            {text(`프로젝트 ${hiddenRowCount}곳 더 보기`, `Show ${hiddenRowCount} more project${hiddenRowCount > 1 ? "s" : ""}`)}
          </button>
        )}
        {showAllLocations && !locationQuery.trim() && (
          <button className="button compact" type="button" onClick={() => setShowAllLocations(false)}>
            <ChevronUp size={13} aria-hidden="true" />
            {text("배포된 곳만 보기", "Show deployed only")}
          </button>
        )}
      </div>
      <LocationProviderMatrix
        locationHeader={text("위치", "Location")}
        columns={entry.providers}
        columnProvider={(provider) => provider}
        rows={visibleRows}
        cell={(row, provider) => {
          const deployment = deploymentAt(row.scope, row.projectPath, provider);
          const blocked = Boolean(deployment?.present && deployment.message);
          // 체크는 "이 원본의 배포로 등록됨"이다. 파일만 있는 위치는 남의
          // 지침일 수 있어 켜진 것으로 보이면 안 된다(해제가 삭제이므로).
          const foreign = Boolean(deployment?.present && !deployment.managed && !blocked);
          return (
            <SkillUseToggle
              used={Boolean(deployment?.managed)}
              foreign={foreign}
              divergent={Boolean(deployment?.divergent) && !blocked}
              disabled={busy !== null || blocked || (!deployment?.present && !entry.currentPlatformSupported)}
              title={deployment?.message
                ?? (foreign
                  ? text(
                    `${deployment?.filePath ?? ""}\n이 위치에 지침 파일이 이미 있지만 이 원본의 배포는 아닙니다. 아래 "등록되지 않은 지침 파일"에서 배포로 등록하세요.`,
                    `${deployment?.filePath ?? ""}\nAn instruction file already exists here but is not a deployment of this source. Register it under "Unregistered instruction files" below.`,
                  )
                  : deployment?.filePath ?? undefined)}
              onChange={(checked) => { void onToggleDeployment(row.scope, row.projectPath, provider, checked); }}
            />
          );
        }}
      />
      {locationQuery.trim() && visibleRows.length === 1 && (
        <p className="prose-copy">{text("검색과 맞는 프로젝트가 없습니다.", "No project matches the search.")}</p>
      )}
      {unmanagedDeployments.length > 0 && (
        <InstructionSection
          title={text("등록되지 않은 지침 파일", "Unregistered instruction files")}
          description={text(
            "아래 위치에는 같은 이름의 지침 파일이 있지만 이 원본의 배포가 아닙니다. 그래서 원본을 편집해도 갱신되지 않고, 외부 수정 감지에도 잡히지 않습니다. 이 파일이 이 지침의 배포라면 등록하세요. 등록 시점의 내용을 기준으로 삼아 다음 편집부터 함께 갱신합니다.",
            "These locations hold a file with the same name that is not a deployment of this source, so editing the source leaves it alone and drift detection ignores it. Register it if it really is this instruction's deployment; the current content becomes the baseline and later edits update it too.",
          )}
        >
          <div className="skill-divergent-list">
            {unmanagedDeployments.map((deployment) => (
              <DeploymentRow deployment={deployment} key={deploymentKey(deployment)}>
                <button className="button compact" type="button" disabled={busy !== null} onClick={() => { void onSetRegistered(deployment, true); }}>
                  <FolderInput size={13} aria-hidden="true" />{text("배포로 등록", "Register")}
                </button>
              </DeploymentRow>
            ))}
          </div>
        </InstructionSection>
      )}
      {managedDeployments.length > 0 && (
        <InstructionSection
          title={text("배포 등록", "Registered deployments")}
          description={text(
            "원본을 편집하면 아래 위치가 함께 갱신되고, 외부 수정 감지도 이 위치들만 봅니다. 등록을 해제하면 파일은 그대로 남고 이후 갱신에서만 빠집니다.",
            "Editing the source updates these locations, and drift detection watches only them. Unregistering leaves the file in place and only stops future updates.",
          )}
        >
          <div className="skill-divergent-list">
            {managedDeployments.map((deployment) => (
              <DeploymentRow deployment={deployment} key={deploymentKey(deployment)}>
                <button className="button compact" type="button" disabled={busy !== null} onClick={() => { void onSetRegistered(deployment, false); }}>
                  {text("등록 해제", "Unregister")}
                </button>
              </DeploymentRow>
            ))}
          </div>
        </InstructionSection>
      )}
    </>
  );
}

/**
 * 3단계: 실제로 놓인 배포 파일 원문과 링크 보관 상태를 확인한다. 읽어 온 원문은 선택 지침
 * 카드가 들고 있어 이 패널은 그리기만 한다.
 */
function InstructionReviewStep({ entry, hasReviewSection, linkNotices, presentDeployments, viewerTarget, viewerContent, busy, onOpenViewer }: {
  entry: ProjectInstructionEntry;
  hasReviewSection: boolean;
  linkNotices: InstructionLinkNotice[];
  presentDeployments: ProjectInstructionDeployment[];
  viewerTarget: string;
  viewerContent: DeployedInstructionFileContent | null;
  busy: InstructionBusyKind | null;
  onOpenViewer: (target: string) => Promise<void>;
}) {
  const { text } = useI18n();
  return (
    <>
      {!hasReviewSection && (
        <p className="prose-copy">{text(
          "아직 배포된 파일이 없어 확인할 내용이 없습니다. 먼저 위치별 배포에서 지침을 배포하세요.",
          "Nothing to review yet because the instruction is not deployed anywhere. Deploy it first under deployments by location.",
        )}</p>
      )}
      {entry.linkedFiles.length > 0 && (
        <InstructionSection
          title={text("함께 보관한 연결 문서", "Archived linked documents")}
          description={text(
            "지침이 가져오기(@경로)와 링크로 함께 읽는 문서입니다. 게시하면 배포 위치의 같은 상대 경로로 함께 갑니다.",
            "Documents the instruction reads through @path imports and links. Publishing copies them to the same relative paths at the target.",
          )}
        >
          <div className="skill-divergent-list">
            {entry.linkedFiles.map((relative) => (
              <div className="skill-divergent-row" key={relative}><code>{relative}</code></div>
            ))}
          </div>
        </InstructionSection>
      )}

      {linkNotices.length > 0 && (
        <InstructionSection
          title={text("보관하지 못한 링크", "Links not archived")}
          description={text(
            "배포된 지침이 참조하지만 함께 보관하지 않은 링크입니다. 위치에 매인 링크(~/, 절대 경로)는 그 위치에서만 뜻이 통하므로 보관하지 않습니다.",
            "Links the deployed instruction references but that are not archived. Location-bound links (~/, absolute paths) only make sense where they are, so they stay out of the archive.",
          )}
        >
          <details className="instruction-link-disclosure">
            <summary>
              <strong>{text(`링크 ${linkNotices.length}개`, `${linkNotices.length} link${linkNotices.length > 1 ? "s" : ""}`)}</strong>
              <span>{text("펼쳐서 전체 목록 보기", "Expand to see the full list")}</span>
            </summary>
            <div className="skill-divergent-list">
              {linkNotices.map((notice) => (
                <div className="skill-divergent-row" key={`${notice.href}\n${notice.reason}`}>
                  <code>{notice.href}</code>
                  <small>{notice.reason}{notice.locations > 1
                    ? text(` · ${notice.locations}곳`, ` · ${notice.locations} locations`)
                    : ""}</small>
                </div>
              ))}
            </div>
          </details>
        </InstructionSection>
      )}

      {presentDeployments.length > 0 && (
        <InstructionSection
          title={text("배포 파일 내용", "Deployed file contents")}
          description={text(
            "개인 설정·프로젝트에 실제로 놓여 있는 지침 파일 원문을 확인합니다.",
            "View the instruction file exactly as it exists in personal settings or a project.",
          )}
        >
          <div className="form-row">
            <label htmlFor="instruction-view-target">{text("파일", "File")}</label>
            <select
              id="instruction-view-target"
              value={viewerTarget}
              onChange={(event) => { void onOpenViewer(event.target.value); }}
              disabled={busy !== null}
            >
              <option value="">{text("선택하세요", "Select a file")}</option>
              {presentDeployments.map((deployment) => (
                <option value={deploymentKey(deployment)} key={deploymentKey(deployment)}>
                  {deploymentLabel(deployment, text)}
                  {deployment.divergent ? text(" · 원본과 다름", " · differs from source") : ""}
                  {!deployment.managed ? text(" · 배포로 등록되지 않음", " · not registered") : ""}
                </option>
              ))}
            </select>
          </div>
          {viewerContent && (
            <div className="form-row">
              <label>{providerFileName(viewerContent.provider)}</label>
              <div>
                {viewerContent.content.trim()
                  ? <>
                    <MarkdownPreview source={viewerContent.content} compact />
                    <OriginalContent>
                      <pre className="markdown-source">{viewerContent.content}</pre>
                    </OriginalContent>
                  </>
                  : <p className="prose-copy">{text("(빈 파일)", "(Empty file)")}</p>}
                <small className="settings-storage-note">{viewerContent.filePath}</small>
              </div>
            </div>
          )}
        </InstructionSection>
      )}
    </>
  );
}

/** 4단계: 외부에서 고쳐져 원본과 달라진 배포본을 자동 반영하거나 한 버전을 원본으로 채택한다. */
function InstructionDriftStep({ autoSyncChecked, onToggleAutoSync, divergentDeployments, busy, onAdopt }: {
  autoSyncChecked: boolean;
  onToggleAutoSync: (autoSync: boolean) => void;
  divergentDeployments: ProjectInstructionDeployment[];
  busy: InstructionBusyKind | null;
  onAdopt: (deployment: ProjectInstructionDeployment) => Promise<void>;
}) {
  const { text } = useI18n();
  return (
    <>
      <p className="prose-copy">{text(
        "배포된 파일을 다른 도구로 고치면 공통 원본과 달라집니다. 자동 반영을 켜 두면 달라진 배포본을 원본으로 그대로 받아들입니다. 여기서 보는 대상은 이 지침의 배포로 등록된 위치뿐입니다(위치별 배포에서 등록합니다).",
        "Editing a deployed file elsewhere makes it differ from the shared source. With auto-adopt on, the changed deployment becomes the new source. Only locations registered as this instruction's deployments are watched (register them under deployments by location).",
      )}</p>
      <div className="skill-use-matrix">
        <label className={`skill-use-toggle skill-auto-toggle${autoSyncChecked ? " used" : ""}`}>
          <input
            type="checkbox"
            checked={autoSyncChecked}
            onChange={(event) => onToggleAutoSync(event.target.checked)}
          />
          {text("외부 수정 자동 반영", "Auto-adopt external edits")}
        </label>
      </div>
      {divergentDeployments.length === 0 && (
        <p className="prose-copy">{text(
          "지금은 원본과 다른 배포 파일이 없습니다. 등록된 배포 위치만 봅니다.",
          "No registered deployment currently differs from the source.",
        )}</p>
      )}
      {divergentDeployments.length > 0 && (
        <InstructionSection
          title={text("외부 수정 감지", "Externally edited")}
          description={text(
            "아래 배포 파일이 공통 원본과 다릅니다. 한 버전을 선택해 동기화하면 그 버전이 원본이 되고 나머지 배포 프로젝트에 재배포됩니다. 이전 원본은 휴지통으로 이동합니다.",
            "These deployed files differ from the shared source. Syncing adopts one version as the source and redeploys to the other projects. The previous source moves to the trash.",
          )}
        >
          <div className="skill-divergent-list">
            {divergentDeployments.map((deployment) => (
              <DeploymentRow deployment={deployment} key={deploymentKey(deployment)}>
                <small>{divergenceReason(deployment, text)}</small>
                <button className="button compact" type="button" disabled={busy !== null} onClick={() => { void onAdopt(deployment); }}>
                  <RefreshCw size={13} aria-hidden="true" />{busy === "sync" ? text("동기화 중…", "Syncing…") : text("이 버전으로 동기화", "Sync to this version")}
                </button>
              </DeploymentRow>
            ))}
          </div>
        </InstructionSection>
      )}
    </>
  );
}

/** 6단계: 아직 배포하지 않은 위치에 지침을 새로 게시하는 폼. */
function InstructionPublishStep({ entry, library, projectPath, onProjectPathChange, providers, onProvidersChange, overwrite, onOverwriteChange, busy, onSubmit }: {
  entry: ProjectInstructionEntry;
  library: ProjectInstructionLibrary | null;
  projectPath: string;
  onProjectPathChange: (path: string) => void;
  providers: ProviderId[];
  onProvidersChange: (providers: ProviderId[]) => void;
  overwrite: SkillOverwritePolicy;
  onOverwriteChange: (policy: SkillOverwritePolicy) => void;
  busy: InstructionBusyKind | null;
  onSubmit: (event: FormEvent) => Promise<void>;
}) {
  const { text } = useI18n();
  return (
    <>
      <form onSubmit={(event) => { void onSubmit(event); }}>
        <div className="form-row">
          <label htmlFor="instruction-publish-project">{text("위치", "Location")}</label>
          <select id="instruction-publish-project" value={projectPath} onChange={(event) => onProjectPathChange(event.target.value)} disabled={busy !== null}>
            <option value={PERSONAL_LOCATION}>{text("개인 설정 (~/.claude · ~/.codex · ~/.gemini)", "Personal settings (~/.claude · ~/.codex · ~/.gemini)")}</option>
            {(library?.projects ?? []).map((path) => <option value={path} key={path}>{displayPath(path)}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label>{text("공급자", "Providers")}</label>
          <ToggleMatrix
            values={entry.providers}
            selected={providers}
            disabled={busy !== null}
            label={sourceName}
            onChange={onProvidersChange}
          />
        </div>
        <div className="form-row">
          <label htmlFor="instruction-overwrite">{text("기존 파일", "Existing files")}</label>
          <select id="instruction-overwrite" value={overwrite} onChange={(event) => onOverwriteChange(event.target.value as SkillOverwritePolicy)} disabled={busy !== null}>
            <option value="fail">{text("덮어쓰지 않음", "Do not overwrite")}</option>
            <option value="replace">{text("원자적으로 교체", "Replace atomically")}</option>
          </select>
        </div>
        <div className="form-actions">
          <button className="button primary" type="submit" disabled={busy !== null || !projectPath || providers.length === 0 || !entry.currentPlatformSupported}>
            {busy === "publish" ? text("게시 중…", "Publishing…") : text("프로젝트에 게시", "Publish to project")}
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * 지침 원본 편집(5단계)의 화면. 편집 상태는 선택 지침 카드가 훅으로 들고 있고, 여기서는
 * 그 값을 그리기만 한다. 편집을 열기 전에는 버튼 한 줄, 연 뒤에는 이름·설명·공급자별 본문
 * 칸이 선다.
 */
function InstructionEditorPanel({ editor, providers, busy }: {
  editor: InstructionSourceEditor;
  providers: ProviderId[];
  busy: InstructionBusyKind | null;
}) {
  const { text } = useI18n();
  if (!editor.editing) {
    return (
      <div className="form-actions">
        <button className="button" type="button" disabled={busy !== null} onClick={() => { void editor.open(); }}>
          {busy === "edit-load" ? text("읽는 중…", "Loading…") : text("직접 편집", "Edit files")}
        </button>
      </div>
    );
  }
  return (
    <div className="skill-editor">
      <div className="form-row">
        <label htmlFor="instruction-edit-name">{text("표시 이름", "Display name")}</label>
        <input id="instruction-edit-name" value={editor.name} onChange={(event) => editor.setName(event.target.value)} disabled={busy !== null} />
      </div>
      <div className="form-row">
        <label htmlFor="instruction-edit-description">{text("설명", "Description")}</label>
        <textarea id="instruction-edit-description" rows={2} value={editor.description} onChange={(event) => editor.setDescription(event.target.value)} disabled={busy !== null} />
      </div>
      {providers.map((provider) => (
        <div className="form-row" key={provider}>
          <label htmlFor={`instruction-edit-${provider}`}>{providerFileName(provider)}</label>
          <div>
            <textarea
              id={`instruction-edit-${provider}`}
              rows={8}
              value={editor.contents[provider] ?? ""}
              onChange={(event) => editor.setContents((current) => ({ ...current, [provider]: event.target.value }))}
              disabled={busy !== null}
            />
            {editor.variantSources[provider] && (
              <small className="settings-storage-note">{text(
                `${platformLabel(editor.variantSources[provider] as HostPlatform, text)} 변형에서 읽었습니다. 저장하면 base 파일에 씁니다.`,
                `Loaded from the ${platformLabel(editor.variantSources[provider] as HostPlatform, text)} variant. Saving writes to the base file.`,
              )}</small>
            )}
          </div>
        </div>
      ))}
      <div className="form-actions">
        <button className="button" type="button" disabled={busy !== null} onClick={editor.close}>
          {text("취소", "Cancel")}
        </button>
        <button className="button primary" type="button" disabled={busy !== null} onClick={() => { void editor.save(); }}>
          {busy === "edit-save" ? text("저장 중…", "Saving…") : text("저장하고 재배포", "Save and redeploy")}
        </button>
      </div>
    </div>
  );
}

/** 지침 휴지통. 배포 파일·원본을 그룹 단위로 복구하거나 영구 삭제한다. */
/**
 * 지침 화면의 절 하나: 제목 한 줄과 설명 문단이다. 배포 목록·연결 문서·보관하지 못한
 * 링크·배포 파일 내용·외부 수정 감지 여섯 자리가 같은 네 줄(`section-title` > `h3`,
 * `prose-copy`)을 손으로 되풀이하고 있어 한쪽 마크업만 바뀌면 절끼리 어긋나는 모양이었다.
 * 절 아래 껍데기는 자리마다 다르므로(`skill-divergent-list`·`details`·`form-row`)
 * 본문은 그대로 받아 넘긴다.
 */
function InstructionSection({ title, description, children }: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <>
      <div className="section-title">
        <h3>{title}</h3>
      </div>
      <p className="prose-copy">{description}</p>
      {children}
    </>
  );
}

/**
 * 배포 한 줄의 머리: 도구 배지 · 개인 표식 · 파일 경로. 등록되지 않은 목록, 등록된 목록,
 * 외부 수정 감지 목록이 이 세 조각을 똑같이 세 벌 적고 있었다. 뒤에 붙는 버튼과 차이
 * 설명만 자리마다 달라 본문으로 받는다. `key`는 목록마다 다를 수 있으니 호출부가 붙인다.
 */
function DeploymentRow({ deployment, children }: {
  deployment: ProjectInstructionDeployment;
  children: ReactNode;
}) {
  const { text } = useI18n();
  return (
    <div className="skill-divergent-row">
      <SourceBadge source={deployment.provider} />
      {deployment.scope === "personal" && <span className="skill-origin-pill">{text("개인", "Personal")}</span>}
      <code>{deployment.filePath}</code>
      {children}
    </div>
  );
}

function InstructionTrashDrawer({
  trash,
  busy,
  setBusy,
  setError,
  reportChanged,
  refresh,
  confirm,
  onClose,
}: ChildActionProps & {
  trash: InstructionTrashOverview;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  onClose: () => void;
}) {
  const { text } = useI18n();
  const runBusy = instructionBusyRunner(setBusy, setError);

  const groupSize = useTrashGroupSizes(trash.items);

  const restore = async (id: string) => {
    await runBusy("trash-restore", async () => {
      const receipt = await restoreInstructionTrash(id);
      await refresh();
      const restored = receipt.results.filter((result) => result.outcome === "restored").length;
      reportChanged(text(
        `휴지통에서 ${restored}개 항목을 복구했습니다.`,
        `Restored ${restored} item(s) from the trash.`,
      ));
    });
  };

  const purge = async (id?: string) => {
    const accepted = await confirm({
      title: id ? text("휴지통 항목 영구 삭제", "Permanently delete trash item") : text("휴지통 비우기", "Empty trash"),
      message: text("영구 삭제한 항목은 복구할 수 없습니다.", "Permanently deleted items cannot be restored."),
      warning: text("이 작업은 되돌릴 수 없습니다.", "This cannot be undone."),
      confirmLabel: text("영구 삭제", "Delete forever"),
      tone: "danger",
    });
    if (!accepted) return;
    await runBusy("trash-purge", async () => {
      const removed = await purgeInstructionTrash(id);
      await refresh();
      reportChanged(text(`휴지통에서 ${removed}개 항목을 영구 삭제했습니다.`, `Permanently deleted ${removed} item(s).`));
    });
  };

  return (
    <Drawer
      title={<><Trash2 size={15} aria-hidden="true" /><span>{text("지침 휴지통", "Instruction trash")}</span></>}
      onClose={onClose}
      actions={
        <button className="button compact" type="button" disabled={busy !== null || trash.items.length === 0} onClick={() => { void purge(); }}>
          <Trash2 size={13} aria-hidden="true" />{text("휴지통 비우기", "Empty trash")}
        </button>
      }
    >
      <p className="prose-copy">{text(
        `${trash.items.length}개 항목. 복구는 함께 삭제된 그룹 전체(공통 원본과 배포 파일)를 원래 경로로 되돌리며, 경로에 새 파일이 있으면 덮어쓰지 않습니다.`,
        `${trash.items.length} item(s). Restore returns the whole deleted group (shared source and deployed files) to its original paths and never overwrites newer files.`,
      )}</p>
      <div className="detail-card skill-trash-list">
        {trash.items.map((item) => (
          <TrashRow
            key={item.id}
            groupSize={groupSize(item)}
            path={item.originalPath}
            actions={<>
              <button className="button compact" type="button" disabled={busy !== null} onClick={() => { void restore(item.id); }}>
                {text("복구", "Restore")}
              </button>
              <button className="button compact danger-subtle" type="button" disabled={busy !== null} onClick={() => { void purge(item.id); }}>
                {text("영구 삭제", "Delete forever")}
              </button>
            </>}
          >
            <strong>{item.name}</strong>
            {item.provider && <SourceBadge source={item.provider} />}
            <small>{item.kind === "directory"
              ? text("공통 원본", "Shared source")
              : item.scope === "personal"
                ? text("개인 배포 파일", "Personal deployed file")
                : text("프로젝트 배포 파일", "Project deployed file")}</small>
            <small>{formatDateTime(item.deletedAtMs)}</small>
          </TrashRow>
        ))}
      </div>
    </Drawer>
  );
}

function deploymentKey(deployment: ProjectInstructionDeployment): string {
  return `${deployment.scope}:${deployment.projectPath}:${deployment.provider}`;
}

function deploymentLabel(
  deployment: ProjectInstructionDeployment,
  text: UiText,
): string {
  const location = deployment.scope === "personal"
    ? text("개인 설정", "Personal settings")
    : lastPathSegment(deployment.projectPath);
  return `${location} · ${providerFileName(deployment.provider)}`;
}

/**
 * 배포 위치가 원본과 어떻게 다른지 한 줄로. 지침은 연결 문서까지 한 세트이므로
 * 지침 파일 수정과 연결 문서 차이를 나눠 보여줘야 어디를 볼지 알 수 있다.
 */
function divergenceReason(
  deployment: ProjectInstructionDeployment,
  text: UiText,
): string {
  const parts: string[] = [];
  if (deployment.contentDigest !== deployment.sourceDigest) {
    parts.push(text("지침 파일 수정", "instruction file edited"));
  }
  const changed = deployment.linkedChanged?.length ?? 0;
  const missing = deployment.linkedMissing?.length ?? 0;
  const unarchived = deployment.linkedUnarchived?.length ?? 0;
  if (changed > 0) parts.push(text(`연결 문서 ${changed}개 수정`, `${changed} linked doc(s) edited`));
  if (missing > 0) parts.push(text(`연결 문서 ${missing}개 없음`, `${missing} linked doc(s) missing`));
  if (unarchived > 0) parts.push(text(`미보관 연결 문서 ${unarchived}개`, `${unarchived} linked doc(s) not archived`));
  return parts.join(" · ");
}

/**
 * 경로의 마지막 조각. 매트릭스 행 라벨과 문서 트리 라벨이 쓰고, 전체 경로는 둘 다 title로
 * 보여준다. 같은 계산이 두 벌 있었고 한쪽만 `/`로 갈라 윈도우 경로에서 통째로 나왔다 —
 * 이 파일의 `deploymentRoot`는 처음부터 두 구분자를 함께 봤으므로 그쪽에 맞춘다.
 */
function lastPathSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

type InfoLocationFilter = "all" | "personal" | "project";
type InfoProviderFilter = "all" | ProviderId;
type InfoStateFilter = "all" | "archived" | "unarchived";

interface InfoFile {
  deployment: ProjectInstructionDeployment;
  /** 파일과 내용까지 일치하는 보관 원본 키. 없으면 미보관 파일이다. */
  matched: string | null;
  /** 이 위치를 관리하는 보관 원본에서 본 배포 상태. 연결 문서 정보가 여기 있다. */
  archived: ProjectInstructionDeployment | null;
}

interface ArchivedInstructionMatch {
  key: string;
  deployment: ProjectInstructionDeployment;
}

/**
 * 실제 배포 위치를 관리하는 보관 원본을 찾는다. 내용까지 일치하는 원본을 우선하고,
 * 모두 갈라졌다면 연결 문서 정보를 보여 줄 첫 원본을 대신 돌려준다.
 */
function archivedInstructionMatch(
  entries: readonly ProjectInstructionEntry[],
  deployment: ProjectInstructionDeployment,
): ArchivedInstructionMatch | null {
  let divergentMatch: ArchivedInstructionMatch | null = null;
  for (const entry of entries) {
    for (const candidate of entry.deployments) {
      if (candidate.provider !== deployment.provider
        || candidate.scope !== deployment.scope
        || candidate.projectPath !== deployment.projectPath
        || !candidate.managed || !candidate.present || candidate.message) continue;
      if (!candidate.divergent) return { key: entry.key, deployment: candidate };
      divergentMatch ??= { key: entry.key, deployment: candidate };
    }
  }
  return divergentMatch;
}

/** 위치 한 줄과 그 아래 설 지침 파일. 트리 컴포넌트가 그대로 받는 모양이다. */
interface InfoGroupRow extends DeploymentLocationRow {
  files: InfoFile[];
}

interface InfoFilters {
  location: InfoLocationFilter;
  provider: InfoProviderFilter;
  state: InfoStateFilter;
}

/**
 * 필터 축 셋의 판정. 남길 파일을 고르는 일과 버튼에 붙는 개수를 세는 일이 같은 조건을
 * 각자 적어 두고 있었다. 조건이 여기 한 벌만 있으면 축을 늘리거나 규칙을 고칠 때 한쪽만
 * 바뀌는 일이 생기지 않는다. 스킬 목록과 같은 조립기를 쓴다.
 */
const INFO_FILTER = filterMatcher<InfoFile, InfoFilters>({
  location: (file, value) => value === "all" || file.deployment.scope === value,
  provider: (file, value) => value === "all" || file.deployment.provider === value,
  state: (file, value) => value === "all"
    || (value === "archived" ? file.matched !== null : file.matched === null),
});

/**
 * 지침정보 탭의 필터 축 셋. 개수 배지·활성 표시·"고르면 그 축만 바꾼다"는 축 줄에서 나오므로
 * 여기에는 이름표와 고를 수 있는 값만 적는다. 세 축 모두 0건 칩도 눌러서 그 축으로 옮겨 갈 수
 * 있어야 하므로 칩 줄의 잠금 규칙은 끈다.
 */
function infoFilterAxes(text: UiText): FilterAxisSpec<InfoFilters>[] {
  return filterAxes<InfoFilters>([
    {
      axis: "location",
      label: text("위치", "Location"),
      groupLabel: text("지침 위치 필터", "Instruction location filter"),
      alwaysEnabled: true,
      chips: [
        { value: "all", label: text("전체", "All") },
        { value: "personal", label: text("개인", "Personal") },
        { value: "project", label: text("프로젝트", "Project") },
      ],
    },
    {
      axis: "provider",
      label: text("공급자", "Provider"),
      groupLabel: text("지침 공급자 필터", "Instruction provider filter"),
      alwaysEnabled: true,
      chips: [
        { value: "all", label: text("전체", "All") },
        ...PROVIDER_IDS.map((provider) => ({ value: provider, label: sourceName(provider) })),
      ],
    },
    {
      axis: "state",
      label: text("보관", "Archive"),
      groupLabel: text("지침 보관 상태 필터", "Instruction archive filter"),
      alwaysEnabled: true,
      chips: [
        { value: "all", label: text("전체", "All") },
        { value: "archived", label: text("보관 일치", "Archived") },
        { value: "unarchived", label: text("미보관", "Unarchived") },
      ],
    },
  ]);
}

/** 지침 파일과 그 문서가 참조하는 연결 문서를 같은 모양으로 다루는 열람 캐시 항목. */
type InstructionDocNode =
  | {
    status: "ready";
    /** 화면에 보여 줄 절대 경로. */
    path: string;
    /** 배포 루트 기준 상대 경로. 지침 파일 자신은 null이다. */
    relativePath: string | null;
    content: string;
    sizeBytes: number | null;
  }
  | { status: "error"; message: string };

interface NeededDocNode {
  id: string;
  deployment: ProjectInstructionDeployment;
  /** 지침 파일에서 이 문서까지 거쳐 온 링크 주소들. 비면 지침 파일 자신이다. */
  trail: string[];
  /** 링크를 만난 문서의 상대 경로. 상대 링크를 그 문서 기준으로 풀게 한다. */
  parentPath: string | null;
}

/** 트리 노드 식별자. 지침 파일 키와 링크 경로를 이어 붙인다. */
function docNodeId(fileKey: string, trail: string[]): string {
  return [fileKey, ...trail].join("\n");
}

/** 지침 파일이 놓인 디렉터리. 연결 문서 절대 경로를 만들 때 쓴다. */
function deploymentRoot(filePath: string): string {
  return filePath.replace(/[\\/][^\\/]*$/, "");
}


/**
 * 지침 정보 화면의 문서 트리 상태. 어떤 노드를 고르고 폈는지, 그 노드의 원문을
 * 언제 읽는지, 읽은 결과를 어디에 담아 두는지를 한곳에서 다룬다. 화면 쪽에는
 * 그리는 일만 남는다.
 */
function useInstructionDocTree(
  filtered: InfoFile[],
  library: ProjectInstructionLibrary,
  setBusy: (value: InstructionBusyKind | null) => void,
  setError: (value: string | null) => void,
) {
  const [selectedFile, setSelectedFile] = useState("");
  const [selectedTrail, setSelectedTrail] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [docs, setDocs] = useState<Record<string, InstructionDocNode>>({});
  const inflight = useRef<Set<string>>(new Set());
  /** 라이브러리가 갱신되면 이전 세대의 응답은 버린다. */
  const generation = useRef(0);

  const selected = filtered.find((file) => deploymentKey(file.deployment) === selectedFile) ?? null;
  const selectedNodeId = docNodeId(selectedFile, selectedTrail);

  // 필터로 선택이 사라지면 첫 파일을 자동 선택해 오른쪽 화면이 비지 않게 한다.
  useEffect(() => {
    if (selected || filtered.length === 0) return;
    const fileKey = deploymentKey(filtered[0].deployment);
    setSelectedFile(fileKey);
    setSelectedTrail([]);
    setExpanded((current) => new Set(current).add(fileKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered.map((file) => deploymentKey(file.deployment)).join("|")]);

  // 라이브러리 지문이 갱신되면 읽어 둔 원문 캐시도 버린다.
  useEffect(() => {
    generation.current += 1;
    setDocs({});
    inflight.current.clear();
  }, [library]);

  // 보고 있거나 펼친 노드만 원문을 읽는다. 자식 목록이 부모 원문에서 나오므로
  // 부모가 준비된 뒤에 자식을 읽게 되고, 결과가 도착할 때마다 한 단계씩 내려간다.
  const needed: NeededDocNode[] = [];
  const collectNeeded = (file: InfoFile, trail: string[], parentPath: string | null) => {
    const fileKey = deploymentKey(file.deployment);
    const id = docNodeId(fileKey, trail);
    const open = expanded.has(id);
    if (!open && id !== selectedNodeId) return;
    needed.push({ id, deployment: file.deployment, trail, parentPath });
    const doc = docs[id];
    if (!open || doc?.status !== "ready") return;
    for (const href of localDocumentLinks(doc.content)) {
      collectNeeded(file, [...trail, href], doc.relativePath);
    }
  };
  for (const file of filtered) collectNeeded(file, [], null);
  const neededKey = needed.map((node) => node.id).join("|");

  useEffect(() => {
    for (const node of needed) {
      if (docs[node.id] || inflight.current.has(node.id)) continue;
      const href = node.trail[node.trail.length - 1] ?? null;
      const { scope, projectPath } = deploymentTarget(node.deployment);
      inflight.current.add(node.id);
      setBusy("info-viewer");
      const requested = generation.current;
      const request = href === null
        ? readDeployedInstructionFile(scope, projectPath, node.deployment.provider)
          .then((content): InstructionDocNode => ({
            status: "ready",
            path: content.filePath,
            relativePath: null,
            content: content.content,
            sizeBytes: null,
          }))
        : getDeployedInstructionLinkedFile(scope, projectPath, node.deployment.provider, node.parentPath, href)
          .then((file): InstructionDocNode => ({
            status: "ready",
            path: `${deploymentRoot(node.deployment.filePath)}/${file.relativePath}`,
            relativePath: file.relativePath,
            content: file.content,
            sizeBytes: file.sizeBytes,
          }));
      void request
        .catch((cause: unknown): InstructionDocNode => {
          // 지침 파일 자체를 못 읽는 것은 화면 전체의 문제이고, 연결 문서 실패는
          // 그 문서가 없거나 열 수 없다는 정보라 노드에만 남긴다.
          if (href === null) setError(errorMessage(cause));
          return { status: "error", message: errorMessage(cause) };
        })
        .then((doc) => {
          if (requested !== generation.current) return;
          inflight.current.delete(node.id);
          setDocs((current) => ({ ...current, [node.id]: doc }));
          if (inflight.current.size === 0) setBusy(null);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededKey, docs]);

  const toggleGroup = (key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  /** 문서를 고르면 그 문서로 오는 경로를 모두 펼쳐 트리에 이동 경로가 남게 한다. */
  const selectNode = (fileKey: string, trail: string[]) => {
    setSelectedFile(fileKey);
    setSelectedTrail(trail);
    setExpanded((current) => {
      const next = new Set(current);
      for (let depth = 0; depth <= trail.length; depth += 1) next.add(docNodeId(fileKey, trail.slice(0, depth)));
      return next;
    });
  };

  /** 보고 있는 문서를 다시 누르면 하위 목록만 접었다 편다. */
  const activateNode = (fileKey: string, trail: string[]) => {
    const id = docNodeId(fileKey, trail);
    if (id !== selectedNodeId) {
      selectNode(fileKey, trail);
      return;
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const downloadSelected = (): Promise<void> => {
    const href = selectedTrail[selectedTrail.length - 1];
    if (!selected || href === undefined) return Promise.resolve();
    const parent = docs[docNodeId(selectedFile, selectedTrail.slice(0, -1))];
    const target = deploymentTarget(selected.deployment);
    return downloadDeployedInstructionLinkedFile(
      target.scope,
      target.projectPath,
      selected.deployment.provider,
      parent?.status === "ready" ? parent.relativePath : null,
      href,
    );
  };

  return {
    docs,
    expanded,
    collapsed,
    selected,
    selectedFile,
    selectedTrail,
    selectedNodeId,
    selectNode,
    activateNode,
    toggleGroup,
    downloadSelected,
  };
}

/**
 * 지침정보 탭. 개인 설정·등록 프로젝트에 실제로 있는 지침 파일을 필터와 함께
 * 왼쪽 트리(위치 → 지침 파일 → 연결 문서)로 보여주고, 고른 문서를 오른쪽에
 * 마크다운과 원문으로 보여준다. 보관 여부와 무관하게 파일시스템이 기준이다.
 * 연결 문서는 부모 문서를 읽어야 목록이 나오므로 펼칠 때 읽는다.
 */
function InstructionInfoPanel({
  library,
  setBusy,
  setError,
  selectInstruction,
  translatedKeys,
  automation,
  onAutomationChange,
}: {
  library: ProjectInstructionLibrary;
  setBusy: (value: InstructionBusyKind | null) => void;
  setError: (value: string | null) => void;
  selectInstruction: (key: string) => void;
  /** 번역이 저장된 보관 원본 키. 버튼 문구를 번역/재번역으로 가른다. */
  translatedKeys: Set<string>;
  automation: SystemAutomationSnapshot | null;
  onAutomationChange?: (snapshot: SystemAutomationSnapshot) => void;
}) {
  const { text } = useI18n();
  const [filters, setFilters] = useState<InfoFilters>({ location: "all", provider: "all", state: "all" });

  const files = useMemo<InfoFile[]>(() => {
    return library.deployments
      .filter((deployment) => deployment.present && !deployment.message)
      .map((deployment) => {
        const archived = archivedInstructionMatch(library.entries, deployment);
        return {
          deployment,
          matched: archived && !archived.deployment.divergent ? archived.key : null,
          archived: archived?.deployment ?? null,
        };
      });
  }, [library]);

  const filtered = files.filter((file) => INFO_FILTER.matches(file, filters));
  /** 그 축만 이 값으로 바꿨을 때 남는 파일 수. 자기 축은 빼고 나머지 필터만 적용한다. */
  const countWhere = INFO_FILTER.counter(files, filters);

  const groups = useMemo<InfoGroupRow[]>(() => {
    const rows = instructionLocationRows(library.projects, text)
      .map((location): InfoGroupRow => ({ ...location, files: [] }));
    for (const file of filtered) {
      const row = rows.find((candidate) => candidate.scope === "personal"
        ? file.deployment.scope === "personal"
        : file.deployment.projectPath === candidate.projectPath);
      row?.files.push(file);
    }
    return rows.filter((row) => row.files.length > 0);
  }, [filtered, library.projects, text]);

  const {
    docs, expanded, collapsed, selected, selectedFile, selectedTrail, selectedNodeId,
    selectNode, activateNode, toggleGroup, downloadSelected,
  } = useInstructionDocTree(filtered, library, setBusy, setError);

  return (
    <>
      <section className="toolbar-card skill-library-filterbar">
        <FilterAxisBar axes={infoFilterAxes(text)} filters={filters} countWhere={countWhere} onChange={setFilters} />
      </section>

      {filtered.length === 0 ? (
        <EmptyState
          title={text("조건에 맞는 지침 파일이 없습니다", "No instruction files match the filters")}
          detail={text("필터를 넓히거나 지침관리 탭에서 지침을 게시하세요.", "Broaden the filters or publish an instruction from the Manage tab.")}
        />
      ) : (
        <div className="instruction-info-layout">
          <InstructionInfoTree
            groups={groups}
            docs={docs}
            expanded={expanded}
            collapsed={collapsed}
            selectedNodeId={selectedNodeId}
            onToggleGroup={toggleGroup}
            onActivate={activateNode}
          />
          <section className="instruction-info-content">
            {!selected ? (
              <EmptyState title={text("왼쪽에서 지침 파일을 선택하세요", "Select an instruction file on the left")} />
            ) : (
              <InstructionInfoDetail
                file={selected}
                doc={docs[selectedNodeId]}
                trail={selectedTrail}
                fileKey={selectedFile}
                translatedKeys={translatedKeys}
                automation={automation}
                onAutomationChange={onAutomationChange}
                onSelectInstruction={selectInstruction}
                onSelectNode={selectNode}
                onDownload={downloadSelected}
              />
            )}
          </section>
        </div>
      )}
    </>
  );
}

/**
 * 지침 파일 트리. 위치 묶음 → 지침 파일 → 연결 문서를 한 축으로 그린다. 연결 문서 가지는
 * 부모 원문에서 목록이 나오므로 자기 자신을 다시 부르는 꼴이 되는데, 이 재귀를 화면 본문
 * 안에 클로저로 두면 트리 그리기와 오른쪽 상세 그리기가 같은 함수 몸통에서 섞였다.
 * 트리에 필요한 것은 캐시·펼침·선택뿐이라 그것만 받는다.
 */
function InstructionInfoTree({ groups, docs, expanded, collapsed, selectedNodeId, onToggleGroup, onActivate }: {
  groups: readonly InfoGroupRow[];
  docs: Record<string, InstructionDocNode>;
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  selectedNodeId: string;
  onToggleGroup: (key: string) => void;
  onActivate: (fileKey: string, trail: string[]) => void;
}) {
  const { text } = useI18n();

  const renderLinks = (file: InfoFile, trail: string[], parent: InstructionDocNode, ancestors: string[]) => {
    if (parent.status !== "ready") return null;
    const fileKey = deploymentKey(file.deployment);
    return localDocumentLinks(parent.content).map((href) => {
      const childTrail = [...trail, href];
      const id = docNodeId(fileKey, childTrail);
      const doc = docs[id];
      const resolved = doc?.status === "ready" ? doc.relativePath : null;
      // 문서끼리 서로를 가리키면 트리가 끝없이 깊어지므로 되돌아가는 가지는 접는다.
      const cyclic = resolved !== null && ancestors.includes(resolved);
      const open = expanded.has(id) && !cyclic;
      const label = resolved ?? href;
      return (
        <div key={id}>
          <button
            className={`tree-row file instruction-link-row${id === selectedNodeId ? " active" : ""}`}
            type="button"
            style={{ paddingLeft: 20 + childTrail.length * 11 }}
            title={doc?.status === "error" ? `${href} — ${doc.message}` : label}
            onClick={() => onActivate(fileKey, childTrail)}
          >
            <span>{cyclic || (doc?.status === "ready" && localDocumentLinks(doc.content).length === 0)
              ? "·"
              : open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
            <strong>{lastPathSegment(label)}</strong>
            {doc?.status === "error" && <em className="instruction-tree-pill">{text("열 수 없음", "Unavailable")}</em>}
            {cyclic && <em className="instruction-tree-pill">{text("순환", "Cycle")}</em>}
          </button>
          {open && doc?.status === "ready"
            && renderLinks(file, childTrail, doc, resolved === null ? ancestors : [...ancestors, resolved])}
        </div>
      );
    });
  };

  return (
    <aside className="instruction-info-tree" aria-label={text("지침 파일 트리", "Instruction file tree")}>
      {groups.map((group) => (
        <div key={group.key}>
          <button className="tree-row" type="button" title={group.title} onClick={() => onToggleGroup(group.key)}>
            <span>{collapsed.has(group.key) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
            <strong>{group.label}</strong>
            <em>{group.files.length}</em>
          </button>
          {!collapsed.has(group.key) && group.files.map((file) => {
            const fileKey = deploymentKey(file.deployment);
            const doc = docs[fileKey];
            const open = expanded.has(fileKey);
            return (
              <div key={fileKey}>
                <button
                  className={`tree-row file${fileKey === selectedNodeId ? " active" : ""}`}
                  type="button"
                  title={file.deployment.filePath}
                  onClick={() => onActivate(fileKey, [])}
                >
                  <span>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
                  <strong>{providerFileName(file.deployment.provider)}</strong>
                  {file.matched
                    ? <em className="instruction-tree-pill archived" title={text(`보관 원본 '${file.matched}'과 일치`, `Matches archived source '${file.matched}'`)}>{file.matched}</em>
                    : <em className="instruction-tree-pill">{text("미보관", "Unarchived")}</em>}
                </button>
                {open && doc && renderLinks(file, [], doc, [])}
              </div>
            );
          })}
        </div>
      ))}
    </aside>
  );
}

/**
 * 고른 지침 문서 한 건의 오른쪽 상세. 머리단의 배지·이동 버튼과 본문의 마크다운·원문
 * 표시가 트리와 한 몸통에 있을 때는 `selected*` 파생값 여섯이 트리 코드 사이에 끼어
 * 어느 것이 어느 쪽을 위한 값인지 흐렸다. 파생은 모두 여기서 고른 문서로부터 만든다.
 */
function InstructionInfoDetail({ file, doc, trail, fileKey, translatedKeys, automation, onAutomationChange, onSelectInstruction, onSelectNode, onDownload }: {
  file: InfoFile;
  doc: InstructionDocNode | undefined;
  trail: string[];
  fileKey: string;
  translatedKeys: Set<string>;
  automation: SystemAutomationSnapshot | null;
  onAutomationChange?: (snapshot: SystemAutomationSnapshot) => void;
  onSelectInstruction: (key: string) => void;
  onSelectNode: (fileKey: string, trail: string[]) => void;
  onDownload: () => Promise<void>;
}) {
  const { text } = useI18n();
  const selectedHref = trail[trail.length - 1] ?? null;
  const archivedLinkedCount = file.archived?.linkedFiles?.length ?? 0;
  // 보관되지 않은 링크. 보관 가능한데 원본에 없는 문서와, 위치에 매여 보관하지
  // 않는 링크를 함께 세어 지침 세트가 어디까지 보관됐는지 알린다.
  const outstandingLinks = [
    ...(file.archived?.linkedUnarchived ?? []),
    ...(file.archived?.linkIssues ?? []).map((issue) => `${issue.href} — ${issue.reason}`),
  ];
  const markdown = doc?.status === "ready"
    && (doc.relativePath === null || /\.(md|markdown|mdx|txt)$/i.test(doc.relativePath));

  return (
    <>
      <header>
        <div>
          <strong>{doc?.status === "ready" && doc.relativePath !== null
            ? doc.relativePath
            : selectedHref ?? providerFileName(file.deployment.provider)}</strong>
          <small>{doc?.status === "ready"
            ? `${doc.path}${doc.sizeBytes === null ? "" : ` · ${formatBytes(doc.sizeBytes)}`}`
            : file.deployment.filePath}</small>
        </div>
        <div className="instruction-info-head-actions">
          <SourceBadge source={file.deployment.provider} />
          {trail.length === 0 && file.deployment.scope === "personal" && <span className="skill-origin-pill">{text("개인", "Personal")}</span>}
          {trail.length === 0 && archivedLinkedCount > 0 && (
            <span className="skill-origin-pill" title={file.archived?.linkedFiles?.join("\n")}>
              {text(`연결 문서 ${archivedLinkedCount}개 보관`, `${archivedLinkedCount} linked doc(s) archived`)}
            </span>
          )}
          {trail.length === 0 && outstandingLinks.length > 0 && (
            <span className="skill-origin-pill" title={outstandingLinks.join("\n")}>
              {text(`보관 안 된 링크 ${outstandingLinks.length}개`, `${outstandingLinks.length} link(s) not archived`)}
            </span>
          )}
          {trail.length === 0 && file.matched && (
            <button className="button compact" type="button" onClick={() => onSelectInstruction(file.matched as string)}>
              {text("보관 원본으로 이동", "Go to archived source")}
            </button>
          )}
          {trail.length === 0 && file.matched && onAutomationChange && (
            <TranslateResourceButton
              menu="instructions"
              resourceId={file.matched}
              translated={translatedKeys.has(file.matched)}
              automation={automation}
              onAutomationChange={onAutomationChange}
            />
          )}
          {trail.length > 0 && (
            <>
              <button className="button compact" type="button" onClick={() => onSelectNode(fileKey, trail.slice(0, -1))}>
                {text("상위 문서", "Parent document")}
              </button>
              <button className="button compact" type="button" disabled={doc?.status !== "ready"} onClick={() => { void onDownload(); }}>
                {text("다운로드", "Download")}
              </button>
            </>
          )}
        </div>
      </header>
      <div className="instruction-info-body">
        {!doc
          ? <LoadingState label={text("문서를 읽고 있습니다", "Reading the document")} />
          : doc.status === "error"
            ? <ErrorBanner message={doc.message} />
            : doc.content.trim()
              ? <>
                {markdown
                  ? <MarkdownPreview
                    source={doc.content}
                    compact
                    linkImports
                    onOpenLocalLink={(href) => onSelectNode(fileKey, [...trail, href])}
                  />
                  : <pre className="markdown-source">{doc.content}</pre>}
                {markdown && (
                  <OriginalContent>
                    <pre className="markdown-source">{doc.content}</pre>
                  </OriginalContent>
                )}
              </>
              : <p className="prose-copy">{text("(빈 파일)", "(Empty file)")}</p>}
      </div>
    </>
  );
}

interface ImportLocationRow {
  key: string;
  label: string;
  title: string;
  files: ProjectInstructionDeployment[];
}

/**
 * 가져올 수 있는 배포 지침을 위치별로 묶는다. 툴바의 개수 표시와 가져오기 모달이 같은
 * 기준을 쓰도록 모듈 수준에 둔다.
 */
function instructionImportLocations(
  library: ProjectInstructionLibrary,
  text: UiText,
): ImportLocationRow[] {
  const candidates = library.deployments.filter((deployment) => deployment.present && !deployment.message);
  return instructionLocationRows(library.projects, text, PERSONAL_LOCATION)
    .map((location) => ({
      key: location.key,
      label: location.label,
      title: location.title,
      files: candidates.filter((candidate) => location.scope === "personal"
        ? candidate.scope === "personal"
        : candidate.scope !== "personal" && candidate.projectPath === location.projectPath),
    }))
    .filter((row) => row.files.length > 0);
}

/**
 * 이미 보관 원본이 관리하는 배포 파일 경로. 다시 가져오면 같은 원본이 둘이 되므로 트리에
 * 표시만 하고 선택 대상에서 뺀다.
 *
 * `entry.deployments`는 공급자 × 위치를 전부 훑은 결과라, 그 원본이 갖지 않은 공급자의
 * 파일이나 아무 상관 없는 프로젝트의 지침 파일도 `present`로 들어온다. 그래서 존재 여부가
 * 아니라 지침 파일 지문이 원본과 같은지로 판정한다(Rust `instruction_file_matches`와 같은
 * 기준). 연결 문서만 달라진 배포본은 지침 파일이 같으므로 그대로 관리 대상으로 남는다.
 */
function archivedDeploymentPaths(library: ProjectInstructionLibrary): Set<string> {
  const paths = new Set<string>();
  for (const entry of library.entries) {
    for (const deployment of entry.deployments) {
      if (!deployment.present || deployment.message) continue;
      if (!deployment.contentDigest || deployment.contentDigest !== deployment.sourceDigest) continue;
      paths.add(deployment.filePath);
    }
  }
  return paths;
}

/** 아직 보관되지 않아 실제로 가져올 수 있는 배포 파일 수. 툴바 버튼 활성 판정에 쓴다. */
function importableInstructionCount(library: ProjectInstructionLibrary | null): number {
  if (!library) return 0;
  const archived = archivedDeploymentPaths(library);
  return library.deployments
    .filter((deployment) => deployment.present && !deployment.message && !archived.has(deployment.filePath))
    .length;
}

/** 체크한 지침의 연결 문서 미리보기 상태. */
interface ImportPreviewState {
  loading: boolean;
  preview: InstructionImportPreview | null;
  error: string | null;
}

/** 트리 한 줄. 어느 문서에서 딸려 왔는지 깊이로 보여준다. */
interface ImportDocRow {
  doc: InstructionImportLinkedDoc;
  depth: number;
}

/**
 * 연결 문서의 링크 관계 색인. `flattenImportDocs`와 `toggleImportDoc`이 각자 같은
 * `source -> 딸린 문서` 맵을 손으로 짜고 있었다. 한쪽만 고치면 트리 순서와 체크 전파가
 * 서로 다른 관계를 보게 되므로 한 벌로 모은다. 부모 맵은 위쪽으로 켜 올릴 때만 쓴다.
 */
interface ImportDocLinks {
  children: Map<string, InstructionImportLinkedDoc[]>;
  parents: Map<string, string>;
}

function importDocLinks(docs: InstructionImportLinkedDoc[]): ImportDocLinks {
  const children = new Map<string, InstructionImportLinkedDoc[]>();
  const parents = new Map<string, string>();
  for (const doc of docs) {
    const bucket = children.get(doc.source);
    if (bucket) bucket.push(doc);
    else children.set(doc.source, [doc]);
    parents.set(doc.relative, doc.source);
  }
  return { children, parents };
}

/**
 * 미리보기가 준 연결 문서를 '링크한 문서 -> 딸린 문서' 트리 순서로 편다. 지침 파일에서
 * 시작해 닿지 못한 문서가 남으면 뒤에 붙여 어느 것도 화면에서 빠지지 않게 한다.
 */
function flattenImportDocs(docs: InstructionImportLinkedDoc[]): ImportDocRow[] {
  const { children } = importDocLinks(docs);
  const rows: ImportDocRow[] = [];
  const seen = new Set<string>();
  const walk = (source: string, depth: number) => {
    for (const doc of children.get(source) ?? []) {
      // 문서끼리 서로 링크해도 한 번만 그린다.
      if (seen.has(doc.relative)) continue;
      seen.add(doc.relative);
      rows.push({ doc, depth });
      walk(doc.relative, depth + 1);
    }
  };
  walk("", 0);
  for (const doc of docs) {
    if (seen.has(doc.relative)) continue;
    seen.add(doc.relative);
    rows.push({ doc, depth: 0 });
  }
  return rows;
}

/**
 * 체크 하나를 뒤집는다. 끄면 그 문서에서 갈라져 나온 문서까지 함께 끄고, 켜면 그 문서로
 * 이어지는 위쪽 문서까지 함께 켠다. 중간이 빠지면 남은 문서를 가리키는 링크가 끊긴다.
 */
function toggleImportDoc(
  docs: InstructionImportLinkedDoc[],
  selected: string[],
  relative: string,
): string[] {
  const { children, parents } = importDocLinks(docs);
  const next = new Set(selected);
  if (next.has(relative)) {
    const pending = [relative];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      if (!next.delete(current)) continue;
      pending.push(...(children.get(current) ?? []).map((doc) => doc.relative));
    }
  } else {
    let current: string | undefined = relative;
    while (current && current.length > 0 && !next.has(current)) {
      next.add(current);
      current = parents.get(current);
    }
  }
  return docs.filter((doc) => next.has(doc.relative)).map((doc) => doc.relative);
}

/** 고른 문서까지 합친 보관 크기. 한도를 넘으면 가져오기가 막히므로 미리 보여준다. */
function selectedImportBytes(preview: InstructionImportPreview, selected: string[]): number {
  const wanted = new Set(selected);
  return preview.linkedDocs
    .filter((doc) => wanted.has(doc.relative))
    .reduce((total, doc) => total + doc.sizeBytes, preview.sizeBytes);
}

/**
 * 등록 프로젝트·개인 설정에 이미 있는 지침 파일을 공통 원본으로 보관한다. 한 건이 실패해도
 * 나머지는 계속 가져오므로, 전부 성공했을 때만 닫고 실패가 있으면 결과를 보여주며 열어 둔다.
 * 지침이 링크로 끌고 오는 문서는 체크하기 전에 미리 훑어 트리로 보여주고, 거기서 고른 문서만
 * 함께 보관한다.
 */
function ImportInstructionModal({
  library,
  busy,
  setBusy,
  setError,
  reportChanged,
  refresh,
  selectInstruction,
  onClose,
}: ChildActionProps & {
  library: ProjectInstructionLibrary;
  selectInstruction: (key: string) => void;
  onClose: () => void;
}) {
  const { text } = useI18n();
  const archivedPaths = useMemo(() => archivedDeploymentPaths(library), [library]);
  const locations = useMemo(() => instructionImportLocations(library, text), [library, text]);

  const [location, setLocation] = useState("");
  const [checked, setChecked] = useState<string[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [results, setResults] = useState<{ path: string; label: string; ok: boolean; message: string }[]>([]);
  // 체크한 지침이 링크로 끌고 오는 문서. 파일 경로별로 한 번만 읽어 두고 다시 쓴다.
  const [previews, setPreviews] = useState<Record<string, ImportPreviewState>>({});
  const [docSelection, setDocSelection] = useState<Record<string, string[]>>({});

  const selectedLocation = locations.find((row) => row.key === location) ?? null;

  // 위치가 사라지거나 아직 고르지 않았으면 첫 위치를 연다.
  useEffect(() => {
    if (locations.length === 0) {
      if (location !== "") setLocation("");
      return;
    }
    if (!locations.some((row) => row.key === location)) setLocation(locations[0].key);
  }, [location, locations]);

  // 위치를 바꾸면 이전 위치의 선택과 결과를 버린다.
  useEffect(() => {
    setChecked([]);
    setResults([]);
  }, [location]);

  /** 연결 문서를 훑어 트리를 채운다. 파일을 쓰지 않는 읽기라 체크할 때 바로 부른다. */
  const loadPreview = async (file: ProjectInstructionDeployment) => {
    const cached = previews[file.filePath];
    if (cached?.loading || cached?.preview) return;
    setPreviews((current) => ({ ...current, [file.filePath]: { loading: true, preview: null, error: null } }));
    try {
      const preview = await previewProjectInstructionImport({
        ...deploymentTarget(file),
        provider: file.provider,
      });
      setPreviews((current) => ({ ...current, [file.filePath]: { loading: false, preview, error: null } }));
      // 지침은 연결 문서까지 한 세트이므로 처음에는 찾은 문서를 모두 고른 상태로 둔다.
      setDocSelection((current) => (file.filePath in current
        ? current
        : { ...current, [file.filePath]: preview.linkedDocs.map((doc) => doc.relative) }));
    } catch (cause) {
      setPreviews((current) => ({
        ...current,
        [file.filePath]: { loading: false, preview: null, error: errorMessage(cause) },
      }));
    }
  };

  const toggleChecked = (file: ProjectInstructionDeployment) => {
    const turningOn = !checked.includes(file.filePath);
    setChecked((current) => toggleValue(current, file.filePath));
    setResults([]);
    if (turningOn) void loadPreview(file);
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!selectedLocation || checked.length === 0) return;
    const targets = selectedLocation.files.filter((file) => checked.includes(file.filePath));
    setBusy("import");
    setError(null);
    setResults([]);
    const outcome: { path: string; label: string; ok: boolean; message: string }[] = [];
    let lastImported: string | null = null;
    for (const target of targets) {
      const label = `${selectedLocation.label} · ${providerFileName(target.provider)}`;
      try {
        // 트리를 아직 못 읽었으면 선택을 비워 보내 링크로 찾은 문서를 전부 보관한다.
        const preview = previews[target.filePath]?.preview ?? null;
        const entry = await importProjectInstruction({
          key: (keys[target.filePath] ?? defaultInstructionKey(selectedLocation.label, target.provider)).trim(),
          ...deploymentTarget(target),
          provider: target.provider,
          name: null,
          description: null,
          linkedFiles: preview
            ? docSelection[target.filePath] ?? preview.linkedDocs.map((doc) => doc.relative)
            : null,
        });
        lastImported = entry.key;
        outcome.push({ path: target.filePath, label, ok: true, message: entry.key });
      } catch (cause) {
        // 한 건이 한도나 링크 문제로 막혀도 나머지 선택은 계속 가져온다.
        outcome.push({ path: target.filePath, label, ok: false, message: errorMessage(cause) });
      }
    }
    setResults(outcome);
    const imported = outcome.filter((item) => item.ok).length;
    if (lastImported) selectInstruction(lastImported);
    setChecked(outcome.filter((item) => !item.ok).map((item) => item.path));
    await refresh();
    setBusy(null);
    if (imported > 0) {
      reportChanged(text(
        `지침 ${imported}/${outcome.length}개를 가져왔습니다.`,
        `Imported ${imported} of ${outcome.length} instruction(s).`,
      ));
    }
    // 실패가 남았으면 어떤 파일이 왜 막혔는지 보여줘야 하므로 닫지 않는다.
    if (imported === outcome.length) onClose();
  };

  const ready = Boolean(selectedLocation) && checked.length > 0;
  return (
    <Modal
      size="wide"
      title={text("기존 지침 가져오기", "Import an existing instruction")}
      onClose={() => { if (busy === null) onClose(); }}
      footer={
        <>
          <button className="button" type="button" onClick={onClose} disabled={busy !== null}>{text("닫기", "Close")}</button>
          <button className="button primary" type="button" disabled={busy !== null || !ready} onClick={() => { void submit(); }}>
            {busy === "import"
              ? text("가져오는 중…", "Importing…")
              : text(`선택한 ${checked.length}개 가져오기`, `Import ${checked.length} selected`)}
          </button>
        </>
      }
    >
      <p className="prose-copy">{text(
        "위치를 고르면 그 위치의 지침 파일을 트리로 보여줍니다. 지침을 체크하면 그 지침이 @경로·링크로 함께 읽는 문서를 트리로 펼쳐 주며, 거기서 고른 문서만 함께 보관합니다.",
        "Pick a location to list its instruction files as a tree. Checking an instruction expands the documents it reads through @path imports and links, and only the ones you keep checked are archived with it.",
      )}</p>
      {locations.length === 0 ? (
        <EmptyState title={text("가져올 기존 지침이 없습니다", "No existing instruction to import")} />
      ) : (
        <form onSubmit={(event) => { void submit(event); }}>
          <div className="form-row">
            <label htmlFor="instruction-import-location">{text("위치", "Location")}</label>
            <select id="instruction-import-location" value={location} onChange={(event) => setLocation(event.target.value)} disabled={busy !== null}>
              {locations.map((row) => (
                <option value={row.key} key={row.key} title={row.title}>{row.label} · {row.files.length}</option>
              ))}
            </select>
          </div>
          {selectedLocation && (
            <div className="instruction-import-tree" role="group" aria-label={text("가져올 지침 선택", "Select instructions to import")}>
              <div className="tree-row" title={selectedLocation.title}>
                <span><Folder size={12} aria-hidden="true" /></span>
                <strong>{selectedLocation.label}</strong>
                <em>{selectedLocation.files.length}</em>
              </div>
              {selectedLocation.files.map((file) => {
                const already = archivedPaths.has(file.filePath);
                const isChecked = checked.includes(file.filePath);
                const result = results.find((item) => item.path === file.filePath);
                return (
                  <div className="instruction-import-node" key={file.filePath}>
                    <label className={`instruction-import-row${already ? " disabled" : ""}`} title={file.filePath}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={busy !== null || already}
                        onChange={() => toggleChecked(file)}
                      />
                      <SourceBadge source={file.provider} />
                      <strong>{providerFileName(file.provider)}</strong>
                      <code>{file.filePath}</code>
                      {already && <em className="instruction-tree-pill archived">{text("보관됨", "Archived")}</em>}
                      {result && (
                        <em className={`instruction-tree-pill${result.ok ? " archived" : ""}`} title={result.message}>
                          {result.ok ? text("가져옴", "Imported") : text("실패", "Failed")}
                        </em>
                      )}
                    </label>
                    {isChecked && (
                      <div className="instruction-import-key">
                        <label htmlFor={`instruction-import-key-${file.filePath}`}>{text("키", "Key")}</label>
                        <input
                          id={`instruction-import-key-${file.filePath}`}
                          value={keys[file.filePath] ?? defaultInstructionKey(selectedLocation.label, file.provider)}
                          onChange={(event) => setKeys((current) => ({ ...current, [file.filePath]: event.target.value }))}
                          disabled={busy !== null}
                        />
                      </div>
                    )}
                    {isChecked && (
                      <ImportLinkedDocs
                        file={file}
                        state={previews[file.filePath] ?? null}
                        selected={docSelection[file.filePath] ?? []}
                        disabled={busy !== null}
                        onToggle={(relative) => {
                          const docs = previews[file.filePath]?.preview?.linkedDocs ?? [];
                          setDocSelection((current) => ({
                            ...current,
                            [file.filePath]: toggleImportDoc(docs, current[file.filePath] ?? [], relative),
                          }));
                          setResults([]);
                        }}
                        onSelectAll={(all) => {
                          const docs = previews[file.filePath]?.preview?.linkedDocs ?? [];
                          setDocSelection((current) => ({
                            ...current,
                            [file.filePath]: all ? docs.map((doc) => doc.relative) : [],
                          }));
                          setResults([]);
                        }}
                      />
                    )}
                    {result && !result.ok && <p className="instruction-import-error" role="alert">{result.message}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </form>
      )}
    </Modal>
  );
}

/**
 * 체크한 지침이 링크로 끌고 오는 문서를 트리로 보여주고 고르게 한다. 지침 하나를 열 때만
 * 읽으므로, 문서가 많은 프로젝트에서도 모달을 여는 순간에는 아무것도 읽지 않는다.
 * 파일명을 누르면 원문을 미리 볼 수 있어, 무엇을 함께 보관하는지 이름만 보고 고르지 않아도 된다.
 */
function ImportLinkedDocs({
  file,
  state,
  selected,
  disabled,
  onToggle,
  onSelectAll,
}: {
  file: ProjectInstructionDeployment;
  state: ImportPreviewState | null;
  selected: string[];
  disabled: boolean;
  onToggle: (relative: string) => void;
  onSelectAll: (all: boolean) => void;
}) {
  const { text } = useI18n();
  const { scope, projectPath } = deploymentTarget(file);
  // 미리보기 안의 링크를 따라가면 기준 문서가 바뀐다. 열기 직전에 기준을 적어 두고
  // 읽기·다운로드가 같은 기준을 쓰게 한다.
  const baseRef = useRef<string | null>(null);
  const loadDoc = useCallback(
    (href: string) => getDeployedInstructionLinkedFile(scope, projectPath, file.provider, baseRef.current, href),
    [file.provider, projectPath, scope],
  );
  const viewer = useLinkedFilePreview(loadDoc);
  const openDoc = (relative: string) => {
    baseRef.current = null;
    viewer.open(relative);
  };
  // 미리보기 안의 로컬 링크는 보고 있는 문서 기준으로 푼다.
  const openLocalLink = (href: string) => {
    baseRef.current = viewer.state?.status === "ready" ? viewer.state.file.relativePath : null;
    viewer.open(href);
  };
  const downloadDoc = (href: string) =>
    downloadDeployedInstructionLinkedFile(scope, projectPath, file.provider, baseRef.current, href);
  const docViewer = viewer.state && (
    <LinkedFilePreview
      state={viewer.state}
      onClose={viewer.close}
      onDownload={downloadDoc}
      linkImports
      onOpenLocalLink={openLocalLink}
    />
  );
  if (!state || state.loading) {
    return <p className="instruction-import-hint">{text("연결 문서를 읽는 중…", "Reading linked documents…")}</p>;
  }
  if (state.error) {
    return <p className="instruction-import-error" role="alert">{state.error}</p>;
  }
  const preview = state.preview;
  if (!preview) return null;
  const rows = flattenImportDocs(preview.linkedDocs);
  const chosen = new Set(selected);
  const bytes = selectedImportBytes(preview, selected);
  const overLimit = bytes > preview.maxTotalBytes;
  // 트리의 뿌리는 지침 파일 자신이다. 연결 문서만 보이면 무엇에 딸린 문서인지도,
  // 정작 가져오는 지침 원문이 무엇인지도 확인할 수 없다.
  const rootName = providerFileName(preview.provider);
  return (
    <div className="instruction-import-docs">
      {preview.linkedDocs.length > 0 && (
        <>
          <div className="instruction-import-docs-head">
            <strong>{text(
              `연결 문서 ${selected.length}/${preview.linkedDocs.length}개`,
              `${selected.length} of ${preview.linkedDocs.length} linked documents`,
            )}</strong>
            <button className="button compact" type="button" disabled={disabled} onClick={() => onSelectAll(true)}>
              {text("모두 선택", "Select all")}
            </button>
            <button className="button compact" type="button" disabled={disabled} onClick={() => onSelectAll(false)}>
              {text("모두 해제", "Clear")}
            </button>
            <small className={overLimit ? "danger" : undefined}>{formatBytes(bytes)}</small>
          </div>
          {overLimit && (
            <p className="instruction-import-error" role="alert">{text(
              `고른 문서까지 ${formatBytes(bytes)}로 지침 한 세트 한도(${formatBytes(preview.maxTotalBytes)})를 넘습니다. 문서를 덜어내세요.`,
              `The selection is ${formatBytes(bytes)}, over the ${formatBytes(preview.maxTotalBytes)} limit for one instruction set. Uncheck some documents.`,
            )}</p>
          )}
        </>
      )}
      {/* 지침 파일은 늘 함께 보관하므로 체크는 켠 채 잠그고, 이름을 눌러 원문을 본다. */}
      <div
        className="instruction-import-doc root"
        style={{ "--import-doc-depth": 0 } as CSSProperties}
        title={preview.filePath}
      >
        <label className="instruction-import-doc-check">
          <input
            type="checkbox"
            checked
            readOnly
            disabled
            aria-label={text(`${rootName}은 항상 함께 보관합니다`, `${rootName} is always archived`)}
          />
        </label>
        <button
          className="instruction-import-doc-open"
          type="button"
          onClick={() => openDoc(rootName)}
          title={text(`${rootName} 내용 보기`, `View ${rootName}`)}
        >
          <FileText size={12} aria-hidden="true" />
          <code>{rootName}</code>
        </button>
        <small>{formatBytes(preview.sizeBytes)}</small>
      </div>
      {preview.linkedDocs.length === 0 && (
        <p className="instruction-import-hint">{text("함께 읽는 문서가 없습니다.", "No linked documents.")}</p>
      )}
      {rows.map(({ doc, depth }) => (
        <div
          className="instruction-import-doc"
          key={doc.relative}
          style={{ "--import-doc-depth": depth + 1 } as CSSProperties}
          title={doc.source
            ? text(`${doc.source} 에서 링크`, `Linked from ${doc.source}`)
            : text("지침 파일에서 링크", "Linked from the instruction file")}
        >
          {/* 줄 전체가 체크 라벨이 아니게 됐으니, 좁은 화면에서도 누를 수 있는 만큼은 라벨로 감싼다. */}
          <label className="instruction-import-doc-check">
            <input
              type="checkbox"
              checked={chosen.has(doc.relative)}
              disabled={disabled}
              aria-label={text(`${doc.relative} 함께 보관`, `Archive ${doc.relative}`)}
              onChange={() => onToggle(doc.relative)}
            />
          </label>
          {/* 이름은 체크가 아니라 원문 열기로 간다. 무엇을 보관하는지 내용으로 확인하게 한다. */}
          <button
            className="instruction-import-doc-open"
            type="button"
            onClick={() => openDoc(doc.relative)}
            title={text(`${doc.relative} 내용 보기`, `View ${doc.relative}`)}
          >
            <FileText size={12} aria-hidden="true" />
            <code>{doc.relative}</code>
          </button>
          <small>{formatBytes(doc.sizeBytes)}</small>
        </div>
      ))}
      {preview.linkIssues.length > 0 && (
        <details className="instruction-import-issues">
          <summary>{text(
            `함께 보관할 수 없는 링크 ${preview.linkIssues.length}개`,
            `${preview.linkIssues.length} link(s) that cannot be archived`,
          )}</summary>
          {preview.linkIssues.map((issue) => (
            <div className="instruction-import-issue" key={`${issue.source}\n${issue.href}\n${issue.reason}`}>
              <code>{issue.href}</code>
              <small>{issue.reason}</small>
            </div>
          ))}
        </details>
      )}
      {docViewer}
    </div>
  );
}

/**
 * 체크한 지침의 기본 키. 위치 이름과 공급자를 합쳐 만들고 지침 키 규칙(영문·숫자·
 * 하이픈·밑줄, 64자)에 맞게 다듬는다. 사용자가 그대로 두면 이 값으로 보관한다.
 */
function defaultInstructionKey(locationLabel: string, provider: ProviderId): string {
  const base = locationLabel
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stem = base.length > 0 ? base : "instruction";
  return `${stem}-${provider}`.slice(0, 64);
}

/**
 * 공통 원본을 새로 만든다. 실패 사유(키 중복·경로 문제)는 모달 뒤에 가리는 페이지 배너가
 * 아니라 모달 안에서 보여주고, 성공했을 때만 닫는다.
 */
function CreateInstructionModal({
  busy,
  setBusy,
  setError,
  reportChanged,
  refresh,
  selectInstruction,
  onClose,
}: ChildActionProps & { selectInstruction: (key: string) => void; onClose: () => void }) {
  const { text } = useI18n();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [providers, setProviders] = useState<ProviderId[]>(["codex"]);
  const [platforms, setPlatforms] = useState<HostPlatform[]>([]);
  const [contents, setContents] = useState<Record<ProviderId, string>>(() => Object.fromEntries(
    PROVIDER_IDS.map((provider) => [provider, initialInstructionBody(provider)]),
  ) as Record<ProviderId, string>);
  const [error, setLocalError] = useState<string | null>(null);

  // 실패는 모달 안에 남겨야 하므로 오류를 로컬 상태로 받되, 화면 위쪽에 이미 떠 있던
  // 오류는 공통 껍데기가 시작할 때 비우는 그 한 번으로 함께 걷는다.
  const runBusy = instructionBusyRunner(setBusy, (value) => {
    setError(null);
    setLocalError(value);
  });

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    await runBusy("create", async () => {
      const entry = await createProjectInstruction({
        key: key.trim(),
        name: name.trim() || key.trim(),
        description: description.trim(),
        platforms,
        files: providers.map((provider) => ({ provider, content: contents[provider] })),
      });
      selectInstruction(entry.key);
      onClose();
      await refresh();
      reportChanged(text(`${entry.name} 지침을 만들었습니다.`, `Created ${entry.name}.`));
    });
  };

  const ready = Boolean(key.trim()) && providers.length > 0 && providers.every((provider) => contents[provider].trim());
  return (
    <Modal
      size="wide"
      title={text("새 지침 만들기", "Create an instruction")}
      onClose={() => { if (busy === null) onClose(); }}
      footer={
        <>
          <button className="button" type="button" onClick={onClose} disabled={busy !== null}>{text("취소", "Cancel")}</button>
          <button className="button primary" type="button" disabled={busy !== null || !ready} onClick={() => { void submit(); }}>
            {busy === "create" ? text("만드는 중…", "Creating…") : text("지침 만들기", "Create instruction")}
          </button>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}
      <p className="prose-copy">{text(
        "공급자별 지침 파일과 지원 OS 메타데이터를 함께 저장합니다. 만들기만 하며, 배포는 목록에서 고른 뒤 6단계 게시에서 합니다.",
        "Stores provider instruction files with supported OS metadata. This only creates the source; publish it from step 6 after selecting it.",
      )}</p>
      <form onSubmit={(event) => { void submit(event); }}>
        <div className="form-row">
          <label htmlFor="instruction-create-key">{text("키", "Key")}</label>
          <input id="instruction-create-key" value={key} onChange={(event) => setKey(event.target.value)} placeholder="team-instruction" disabled={busy !== null} autoFocus maxLength={INSTRUCTION_KEY_MAX} />
          {/* 규칙을 만들기 전에 알린다. 적어 두지 않으면 한글·공백 키를 다 친 뒤에야
              백엔드 거절로 알게 된다(QA #87). 문구는 백엔드 검증과 같은 규칙이다
              (`project_instructions.rs`의 `validate_instruction_key`). */}
          <small>{text(
            `영문·숫자·하이픈·밑줄만, 1~${INSTRUCTION_KEY_MAX}자`,
            `Letters, digits, hyphens and underscores only, 1–${INSTRUCTION_KEY_MAX} characters`,
          )}</small>
        </div>
        <div className="form-row">
          <label htmlFor="instruction-create-name">{text("표시 이름", "Display name")}</label>
          <input id="instruction-create-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={text("비우면 키를 사용합니다", "Defaults to the key")} disabled={busy !== null} />
        </div>
        <div className="form-row">
          <label htmlFor="instruction-create-description">{text("설명", "Description")}</label>
          <textarea id="instruction-create-description" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy !== null} />
        </div>
        <div className="form-row">
          <label>{text("지원 OS", "Supported OS")}</label>
          <div>
            <ToggleMatrix
              values={HOST_PLATFORMS}
              selected={platforms}
              disabled={busy !== null}
              label={(platform) => platformLabel(platform, text)}
              onChange={setPlatforms}
            />
            <small className="settings-storage-note">{text("미선택이면 모든 OS에서 같은 지침을 사용합니다.", "Leave unselected to use the same instruction on every OS.")}</small>
          </div>
        </div>
        <div className="form-row">
          <label>{text("공급자", "Providers")}</label>
          <ToggleMatrix
            values={PROVIDER_IDS}
            selected={providers}
            disabled={busy !== null}
            label={sourceName}
            onChange={setProviders}
          />
        </div>
        {providers.map((provider) => (
          <div className="form-row" key={provider}>
            <label htmlFor={`instruction-content-${provider}`}>{providerFileName(provider)}</label>
            <textarea
              id={`instruction-content-${provider}`}
              rows={8}
              value={contents[provider]}
              onChange={(event) => setContents((current) => ({ ...current, [provider]: event.target.value }))}
              disabled={busy !== null}
            />
          </div>
        ))}
      </form>
    </Modal>
  );
}

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function providerFileName(provider: ProviderId): string {
  return INSTRUCTION_FILE_NAMES[provider];
}

/** 새로 만드는 지침의 처음 내용. 파일 이름을 제목 한 줄로 세운 빈 문서다. */
function initialInstructionBody(provider: ProviderId): string {
  return `# ${providerFileName(provider)}\n`;
}

/** 지침 화면은 `Error`가 아닌 거절을 원문 대신 같은 안내 문장으로 보여 준다. */
function errorMessage(cause: unknown): string {
  return errorText(cause, runtimeText("요청을 처리하지 못했습니다.", "The request could not be completed."));
}
