import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type Dispatch, type KeyboardEvent, type ReactNode, type SetStateAction } from "react";
import { AlertTriangle, ArchiveX, ArrowUpFromLine, Ban, FileDiff, FileText, FolderInput, History, Link2, Plus, RefreshCw, Send, ShieldAlert, Trash2 } from "lucide-react";
import { DetailInfo } from "./DetailDrawer";
import { FilterAxis, FilterAxisBar, FilterChipRow, type FilterAxisSpec } from "./FilterAxisBar";
import {
  createCommonSkill,
  deleteSharedSkill,
  deleteSkill,
  getCommonSkillDetail,
  getProjectRegistry,
  getSkillMigrationPlan,
  getSkillLibrary,
  importSkillToCommon,
  listSkillTrash,
  publishCommonSkill,
  purgeSkillTrash,
  readCommonSkillFile,
  restoreSkillTrash,
  retryMenuTranslation,
  setSkillAutoSync,
  setSkillPlatforms,
  syncSkillFromInstall,
  unarchiveSharedSkill,
  updateCommonSkill,
} from "../lib/ipc";
import { formatDate, formatDateTime } from "../lib/format";
import { useI18n, type UiText } from "../lib/i18n";
import { useMenuTranslations } from "../lib/translations";
import { errorText } from "../lib/errorText";
import { PROVIDER_IDS } from "../lib/providerIds";
import { excludedProjectPaths } from "../lib/projectRegistry";
import { readStoredText, writeStoredText } from "../lib/storedText";
import { displayPath } from "../lib/displayPath";
import type { ProjectRegistryEntry } from "../types";
import {
  SKILL_AGENT_VALUES,
  SKILL_KIND_VALUES,
  SKILL_STATE_VALUES,
  adapterSummary,
  filterSkillEntries,
  isProjectOriginFilter,
  matchesSkillQuery,
  providerLabel,
  publishHadFailure,
  publishSummary,
  latestSkillVersion,
  skillDescriptionError,
  skillDivergenceHint,
  skillDivergenceLabel,
  skillFilterCounts,
  skillKeyError,
  skillOriginProjects,
  skillProviderStatusLabel,
  skillStatusModifier,
  skillSyncCounts,
  skillSyncLabel,
  skillSyncState,
  sortSkillEntries,
} from "../lib/skillLibrary";
import type {
  SkillAgentFilter,
  SkillDivergentInstall,
  SkillFilterCounts,
  SkillKindFilter,
  SkillLatestVersion,
  SkillLibraryFilters,
  SkillStateFilter,
} from "../lib/skillLibrary";
import type {
  CommonSkillDetail,
  HostPlatform,
  ProviderId,
  SkillDivergence,
  SkillInstallView,
  SkillLibrary,
  SkillLibraryEntry,
  SkillLocation,
  SkillProjectView,
  SkillProviderState,
  SkillTrashItem,
  SkillTrashOverview,
  SystemAutomationSnapshot,
  TranslationMenu,
  TranslationSummary,
} from "../types";
import { MarkdownPreview } from "./MarkdownPreview";
import { AiaMark, Drawer, EmptyState, ErrorBanner, LoadingState, Modal, SourceBadge, useConfirm } from "./Shared";
import type { ConfirmRequest } from "./Shared";
import { SkillInstallDiff } from "./SkillInstallDiff";
import { TranslateResourceButton, TranslationProgress } from "./TranslationProgress";

const LIBRARY_FILTERS_KEY = "agent-manager.skill-library-filters.v1";
/** 지원 OS 선택에 쓰는 값과 그 순서. 스킬·지침 두 화면이 같은 세 줄을 각자 들고 있었다. */
export const HOST_PLATFORMS: HostPlatform[] = ["macos", "windows", "linux"];


/** 스킬의 출처 위치. 프로젝트 출처면 그 프로젝트, 아니면 개인 루트다. */
function originLocation(entry: SkillLibraryEntry): SkillLocation {
  return entry.origin?.scope === "project" && entry.origin.projectPath
    ? { scope: "project", projectPath: entry.origin.projectPath }
    : { scope: "personal" };
}

function isAtLocation(install: SkillInstallView, location: SkillLocation): boolean {
  return location.scope === "project"
    ? install.scope === "project" && install.projectPath === (location.projectPath ?? null)
    : install.scope === "personal";
}

function installAt(state: SkillProviderState, location: SkillLocation): SkillInstallView | undefined {
  return state.installs.find((install) => isAtLocation(install, location));
}

/**
 * 사용자가 관리하는 위치(개인·프로젝트)인지. 번들·시스템 등 그 밖의 scope는 라이브러리가
 * 손대지 않으므로 사용본 집계·가져오기·해제의 공통 전제다.
 */
function isManagedScope(scope: SkillInstallView["scope"] | SkillProviderState["scope"]): boolean {
  return scope === "personal" || scope === "project";
}

/** 한 스킬의 관리 대상 사용본 전부. 공급자 경계는 없애고 설치본만 평평하게 돌려준다. */
function managedInstalls(entry: SkillLibraryEntry): SkillInstallView[] {
  return entry.providers.flatMap((state) => state.installs.filter((install) => isManagedScope(install.scope)));
}

/** 관리 대상 사용본 중 원본과 벌어진 것. 공급자를 함께 물고 나온다. */
function divergentManagedInstalls(entry: SkillLibraryEntry): SkillDivergentInstall[] {
  return entry.providers.flatMap((state) =>
    state.installs
      .filter((install) => install.divergent && isManagedScope(install.scope))
      .map((install) => ({ provider: state.provider, install })));
}

/** 설치본이 놓인 자리. 게시는 자리마다 한 번씩 부른다. */
function installLocation(install: SkillInstallView): SkillLocation {
  return install.scope === "project" && install.projectPath
    ? { scope: "project", projectPath: install.projectPath }
    : { scope: "personal" };
}

/**
 * 보관 원본을 주어진 사용본들 자리에 덮어쓴다. 게시는 자리 하나에 여러 공급자를 받으므로
 * 자리별로 묶어 부른다 — 개인 루트와 프로젝트에 같은 스킬이 걸쳐 있으면 한 번으로는
 * 한쪽만 갱신되고 나머지가 뒤처진 채 남는다.
 */
async function redeployToInstalls(
  key: string,
  targets: readonly { provider: ProviderId; install: SkillInstallView }[],
): Promise<void> {
  const groups = new Map<string, { location: SkillLocation; providers: ProviderId[] }>();
  for (const { provider, install } of targets) {
    const location = installLocation(install);
    const id = `${location.scope}:${location.projectPath ?? ""}`;
    const group = groups.get(id) ?? { location, providers: [] };
    if (!group.providers.includes(provider)) group.providers.push(provider);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    await publishCommonSkill({
      key,
      providers: group.providers,
      overwrite: "replace",
      location: group.location,
    });
  }
}

/** 보관 원본으로 가져올 수 있는 공급자. 코어가 같은 scope 규칙으로 최종 검증한다. */
function importableProvider(entry: SkillLibraryEntry): SkillProviderState | undefined {
  return entry.providers.find((state) => state.skillId && isManagedScope(state.scope));
}

/**
 * 이 스킬의 번역 레코드가 붙을 수 있는 리소스 ID를 우선순위대로 돌려준다. 보관 원본이
 * 있으면 그 ID가 번역의 소유자이고, 없으면 설치본 ID로 찾는다.
 */
function translationCandidates(entry: SkillLibraryEntry): string[] {
  return [entry.common?.id, ...entry.providers.map((state) => state.skillId)]
    .filter((id): id is string => Boolean(id));
}

interface SkillLibraryPanelProps {
  /** 설치본 번역 레코드. 사용본 skillId 또는 보관 원본 ID로 카드에 재사용한다. */
  translations: Map<string, TranslationSummary>;
  /**
   * 이 화면이 지금 보이는지. 목록의 내용은 사용자만 바꾸는 것이 아니라 AIA·예약 회차도
   * 바꾸므로, 화면에 들어올 때마다 다시 읽어야 "만들었다는데 목록에 없다"가 생기지 않는다.
   * 워크플로 화면이 쓰는 것과 같은 계약이다.
   */
  active?: boolean;
  /** 상세 드로어의 번역 버튼 상태를 읽고 갱신한다. */
  automation: SystemAutomationSnapshot | null;
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void;
  /** 사용/보관/삭제로 설치본이 바뀐 뒤 스킬정보 스냅샷을 갱신한다. */
  onInstalledChanged?: () => void;
  /** 현재 OS 변형이 필요한 보관 스킬 수가 바뀌면 알린다. 상위의 일괄 마이그레이션 버튼이 쓴다. */
  onMigrationRequiredCount?: (count: number) => void;
  /** AIA 위임 편집 요청. */
  onRequestAiaPrompt?: (prompt: string) => void;
}

/**
 * 스킬관리 화면. 스킬을 장치별로 설정한 공통 저장소의 `skills` 아래에 보관하고, 에이전트별
 * 사용 여부 체크로 배포·회수를 제어한다. 보관·사용·사용 해제는 오조작을 막기
 * 위해 실행 전에 확인을 받는다(해제된 사용본은 휴지통으로 옮겨져 복구 가능).
 * 삭제는 보관 스킬만
 * 대상으로 하며 원본과 모든 사용본을 한 그룹으로 옮긴다. 내장 스킬(에이전트·
 * 플러그인 소유)은 관리 대상이 아니라 표시하지 않는다 — 조회는 스킬정보 탭이
 * 담당한다. 쓰기 작업은 write 권한이 필요하며 원격 write 모드에서도 허용된다.
 */
export function SkillLibraryPanel({ active = true, translations, automation, onAutomationChange, onInstalledChanged, onMigrationRequiredCount, onRequestAiaPrompt }: SkillLibraryPanelProps) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useStoredFilters(LIBRARY_FILTERS_KEY, parseLibraryFilters);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [bulkDeployOpen, setBulkDeployOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  // 저장소 조회·알림·단건 쓰기는 훅이 들고 있다. 화면은 그 값과 실행만 쓴다.
  const {
    library,
    projectRegistry,
    loading,
    error,
    setError,
    notice,
    setNotice,
    managedEntries,
    useBusy,
    refresh,
    reportChanged,
    setSkillUse,
    toggleAutoSync,
  } = useSkillLibraryStore({ active, confirm, onInstalledChanged });

  const entryTranslation = useCallback(
    (entry: SkillLibraryEntry): Record<string, string> | undefined => {
      // 공유 원본 ID를 먼저 본다. 배포본이 없는 공유 스킬은 원본 ID 레코드만
      // 존재하고, 배포본이 있으면 어느 쪽이든 같은 내용이다.
      for (const id of translationCandidates(entry)) {
        const fields = translations.get(id)?.fields;
        if (fields) return fields;
      }
      return undefined;
    },
    [translations],
  );

  // 목록에 실제로 설 항목과 칩 개수·출처 프로젝트는 훅이 낸다. 화면은 그 결과만 그린다.
  const { entries, counts, originProjects, filterCounts } = useSkillLibraryListing({
    managedEntries,
    entryTranslation,
    query,
    filters,
    setFilters,
    projectRegistry,
    libraryLoaded: library !== null,
    onMigrationRequiredCount,
  });
  const selected = useMemo(
    () => managedEntries.find((entry) => entry.key === selectedKey) ?? null,
    [managedEntries, selectedKey],
  );
  // 일괄 작업 바는 선택 집합·바쁨 표시·다섯 가지 실행이 한 덩어리로 맞물린다. 화면은 그 결과만
  // 쓰므로 훅에서 받아 아래 마크업에 그대로 흘려보낸다.
  const {
    bulkBusy,
    checkedKeys,
    checkedEntries,
    bulkImportable,
    bulkUnarchivable,
    toggleChecked,
    toggleSelectAll,
    confirmArchiveFirst,
    runBulkArchive,
    runBulkUnarchive,
    runBulkDisable,
    runBulkDelete,
    runBulkDeploy,
  } = useSkillBulkActions({
    managedEntries,
    visibleEntries: entries,
    confirm,
    setError,
    reportChanged,
  });



  if (loading && !library) return <LoadingState label={text("보관 스킬 목록을 읽고 있습니다", "Reading archived skills")} />;

  return (
    <div className="view-stack">
      {error && <ErrorBanner message={error} />}
      {notice && <div className="skill-library-notice" role="status">{notice}</div>}

      <LibraryToolbar
        title={text("보관 스킬", "Archived skills")}
        summary={<>
          {text("보관 저장소", "Archive store")} <code>{library?.commonRoot ?? "-"}</code>
          {library && !library.commonRootPresent && ` · ${text("아직 없음", "not created yet")}`}
        </>}
      >
        <div className="skill-sync-counts">
          {counts.conflict > 0 && <span className="skill-sync-pill conflict">{text("외부 수정 감지", "Externally edited")} {counts.conflict}</span>}
          {counts.stale > 0 && <span className="skill-sync-pill stale">{text("뒤처짐", "Out of date")} {counts.stale}</span>}
          <span className="toolbar-count">{text(`${entries.length}개`, `${entries.length} skills`)}</span>
        </div>
        <input
          className="search-input"
          aria-label={text("보관 스킬 검색", "Search archived skills")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={text("이름·경로 검색", "Search name or path")}
        />
        <button className="button compact" type="button" onClick={() => { void refresh(); }} disabled={loading}>
          <RefreshCw size={13} aria-hidden="true" />{text("새로고침", "Refresh")}
        </button>
        <button className="button primary compact" type="button" onClick={() => setCreating(true)}>
          <Plus size={13} aria-hidden="true" />{text("새 보관 스킬", "New archived skill")}
        </button>
        <button className="button compact" type="button" onClick={() => setTrashOpen(true)}>
          <Trash2 size={13} aria-hidden="true" />{text("휴지통", "Trash")}
        </button>
      </LibraryToolbar>

      <SkillLibraryFilterBar
        filters={filters}
        counts={filterCounts}
        originProjects={originProjects}
        onChange={setFilters}
      />

      <section className="toolbar-card skill-bulk-bar">
        <strong>{text(`${checkedKeys.size}개 선택됨`, `${checkedKeys.size} selected`)}</strong>
        <button className="button compact" type="button" disabled={bulkBusy !== null || (checkedKeys.size === 0 && entries.length === 0)} onClick={toggleSelectAll}>
          {checkedKeys.size > 0 ? text("전체해제", "Clear all") : text("전체선택", "Select all")}
        </button>
        <button className="button compact" type="button" disabled={bulkBusy !== null || !bulkImportable} onClick={() => { void runBulkArchive(); }}>
          <FolderInput size={13} aria-hidden="true" />{bulkBusy === "import" ? text("보관 중…", "Archiving…") : text("보관", "Archive")}
        </button>
        <button className="button compact" type="button" disabled={bulkBusy !== null || !bulkUnarchivable} onClick={() => { void runBulkUnarchive(); }}>
          <ArchiveX size={13} aria-hidden="true" />{bulkBusy === "unarchive" ? text("보관취소 중…", "Unarchiving…") : text("보관취소", "Unarchive")}
        </button>
        <button
          className="button compact"
          type="button"
          disabled={bulkBusy !== null || checkedKeys.size === 0}
          onClick={() => {
            void (async () => {
              if (!await confirmArchiveFirst(text("사용 설정", "enable"), "enabled")) return;
              setBulkDeployOpen(true);
            })();
          }}
        >
          <Send size={13} aria-hidden="true" />{bulkBusy === "deploy" ? text("적용 중…", "Enabling…") : text("사용", "Enable")}
        </button>
        <button className="button compact" type="button" disabled={bulkBusy !== null || checkedKeys.size === 0} onClick={() => { void runBulkDisable(); }}>
          <Ban size={13} aria-hidden="true" />{bulkBusy === "disable" ? text("해제 중…", "Disabling…") : text("미사용", "Disable")}
        </button>
        <button className="button danger-subtle compact" type="button" disabled={bulkBusy !== null || checkedKeys.size === 0} onClick={() => { void runBulkDelete(); }}>
          <Trash2 size={13} aria-hidden="true" />{bulkBusy === "delete" ? text("삭제 중…", "Deleting…") : text("삭제", "Delete")}
        </button>
      </section>

      {library && <AdapterStrip library={library} />}

      {library && library.issues.length > 0 && (
        <section className="detail-card skill-library-issues">
          <div className="section-title"><h3>{text("읽지 못한 위치", "Unreadable locations")}</h3><span>{library.issues.length}</span></div>
          <ul>
            {library.issues.map((issue) => (
              <li key={`${issue.provider ?? "common"}-${issue.path}`}>
                <ShieldAlert size={12} aria-hidden="true" />
                <span>{issue.message}</span>
                <code>{displayPath(issue.path)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {entries.length === 0 ? (
        <EmptyState
          title={text("표시할 스킬이 없습니다", "No skills to show")}
          detail={text(
            "새 보관 스킬을 만들거나, 필터·검색 조건을 확인하세요.",
            "Create an archived skill, or check the filters and search query.",
          )}
        />
      ) : (
        <section className="skill-library-list">
          {entries.map((entry) => (
            <div className={`skill-library-item${checkedKeys.has(entry.key) ? " selected" : ""}`} key={entry.key}>
              <SkillLibraryRow
                entry={entry}
                translated={entryTranslation(entry)}
                checked={checkedKeys.has(entry.key)}
                checkDisabled={bulkBusy !== null}
                onCheck={(checked) => toggleChecked(entry.key, checked)}
                useBusy={useBusy}
                onToggleUse={(state, enabled) => { void setSkillUse(entry, state, enabled); }}
                onToggleAutoSync={(autoSync) => toggleAutoSync(entry, autoSync)}
                onOpen={() => setSelectedKey(entry.key)}
              />
            </div>
          ))}
        </section>
      )}

      {creating && (
        <CreateSkillModal
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setNotice(text(`'${key}' 보관 스킬을 만들었습니다.`, `Created archived skill '${key}'.`));
            void refresh();
          }}
        />
      )}

      {bulkDeployOpen && (
        <BulkDeployModal
          library={library}
          count={checkedEntries.length}
          onClose={() => setBulkDeployOpen(false)}
          onSubmit={(providers, overwrite) => {
            setBulkDeployOpen(false);
            void runBulkDeploy(providers, overwrite);
          }}
        />
      )}

      {trashOpen && (
        <SkillTrashDrawer
          onClose={() => setTrashOpen(false)}
          onChanged={(message) => { void reportChanged(message); }}
        />
      )}

      {selected && (
        <SkillLibraryDrawer
          entry={selected}
          translated={entryTranslation(selected)}
          translationId={translationCandidates(selected)[0]}
          automation={automation}
          onAutomationChange={onAutomationChange}
          projects={library?.projects ?? []}
          currentPlatform={library?.currentPlatform ?? "macos"}
          useBusy={useBusy}
          onSetUse={(state, enabled, location) => { void setSkillUse(selected, state, enabled, location); }}
          onToggleAutoSync={(autoSync) => toggleAutoSync(selected, autoSync)}
          onClose={() => setSelectedKey(null)}
          onChanged={(message) => { void reportChanged(message); }}
          onRequestAiaPrompt={onRequestAiaPrompt}
        />
      )}

      {confirmDialog}
    </div>
  );
}

interface SkillLibraryStoreOptions {
  /** 화면이 보이는 동안에만 다시 읽는다. 숨겨진 패널이 저장소를 헛되이 훑지 않게 하는 스위치다. */
  active: boolean;
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** 설치본이 바뀌었음을 상위 화면에 알린다. 스킬관리 밖의 목록이 같이 갱신된다. */
  onInstalledChanged?: () => void;
}

/**
 * 보관 스킬 저장소 한 벌 — 조회와 그 오류·알림, 단건 쓰기(사용 토글·자동 동기화 토글)와
 * 자동 동기화 실행이 화면 본문에 상태 여섯 개와 뒤섞여 240줄을 차지하고 있었다. 도구줄·
 * 필터줄·목록 마크업을 읽으려면 매번 그만큼을 건너뛰어야 했고, 목록(`useSkillLibraryListing`)과
 * 일괄 작업(`useSkillBulkActions`)은 이미 훅으로 나가 있어 남은 절반만 본문에 눌러앉은 꼴이었다.
 * 같은 결로 갈라, 화면은 이 훅이 내주는 값과 실행만 쓴다. 상태도 호출 순서도 옮기기 전 그대로다.
 */
function useSkillLibraryStore({ active, confirm, onInstalledChanged }: SkillLibraryStoreOptions) {
  const { text } = useI18n();
  const [library, setLibrary] = useState<SkillLibrary | null>(null);
  // 설정에서 제외한 프로젝트를 출처 칩에서 숨기기 위한 목록. 조회 실패는 칩만 그대로 둔다.
  const [projectRegistry, setProjectRegistry] = useState<ProjectRegistryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [useBusy, setUseBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [next, nextRegistry] = await Promise.all([
        getSkillLibrary(),
        getProjectRegistry().catch((): ProjectRegistryEntry[] => []),
      ]);
      setLibrary(next);
      setProjectRegistry(nextRegistry);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  // 화면은 한 번 열리면 언마운트되지 않고 `hidden`으로만 가려지므로(App의 ViewPanel),
  // 마운트 한 번만 읽으면 그 뒤로 저장소가 어떻게 바뀌든 목록이 굳는다. 들어올 때마다 읽는다.
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  /**
   * 단건 쓰기의 바쁨 표시·오류 초기화·try 껍데기. 서랍이 쓰던 busyRunner를 본문도 함께 쓴다.
   * 여기의 열쇠는 정해진 이름이 아니라 "어느 스킬의 어느 공급자의 어느 위치"를 가리키는
   * 조합이라(`entry:provider:location`) 타입으로 셀 수 없다. `string`인 것이 의도다.
   */
  const runUse = busyRunner<string>(setUseBusy, setError);

  /**
   * 쓰기가 끝난 뒤의 뒷정리 한 벌 — 알림을 띄우고, 설치본이 바뀌었음을 상위에 알리고, 목록을
   * 다시 읽는다. 제안 팩 적용·사용 토글·자동 동기화·일괄 작업 네 자리가 같은 세 줄을 각자
   * 펼쳐 두는 바람에 순서가 제각각이었다. 한 자리에 모아 두면 새 작업도 이 한 줄만 부른다.
   */
  const reportChanged = async (summary: string) => {
    setNotice(summary);
    onInstalledChanged?.();
    await refresh();
  };

  // 스킬관리는 사용자가 다룰 수 있는 스킬만 보여준다. 내장 스킬 제외.
  const managedEntries = useMemo(
    () => (library?.entries ?? []).filter((entry) => entry.managed),
    [library],
  );

  /** 에이전트 사용 여부 토글. 위치를 지정하지 않으면 스킬의 출처 위치(개인 또는
   * 출처 프로젝트)를 기준으로 배포·회수한다. 체크박스 오조작을 막기 위해
   * 실행 전에 대상 스킬·에이전트·위치를 확인받는다. */
  const setSkillUse = async (
    entry: SkillLibraryEntry,
    state: SkillProviderState,
    enabled: boolean,
    location?: SkillLocation,
  ) => {
    const target = location ?? originLocation(entry);
    const where = target.scope === "project"
      ? (library?.projects.find((project) => project.path === target.projectPath)?.name ?? target.projectPath ?? "")
      : text("개인", "personal");
    const proceed = await confirm(enabled
      ? {
          title: text("스킬 사용 설정", "Enable skill"),
          message: text(
            `'${entry.key}'을 ${providerLabel(state.provider)}(${where})에서 사용할까요?\n보관 원본이 배포됩니다.`,
            `Enable '${entry.key}' for ${providerLabel(state.provider)} (${where})?\nThe archived source will be deployed.`,
          ),
          confirmLabel: text("사용", "Enable"),
        }
      : {
          title: text("스킬 사용 해제", "Disable skill"),
          message: text(
            `'${entry.key}'을 ${providerLabel(state.provider)}(${where})에서 사용 해제할까요?\n사용본은 휴지통으로 이동합니다.`,
            `Disable '${entry.key}' for ${providerLabel(state.provider)} (${where})?\nThe install moves to the trash.`,
          ),
          confirmLabel: text("사용 해제", "Disable"),
          tone: "danger",
        });
    if (!proceed) return;
    await runUse(`${entry.key}:${state.provider}:${target.projectPath ?? "personal"}`, async () => {
      let summary: string;
      if (enabled) {
        let receipt = await publishCommonSkill({ key: entry.key, providers: [state.provider], overwrite: "fail", location: target });
        let result = receipt.results[0];
        if (result?.outcome === "skipped") {
          const replace = await confirm({
            title: text("사용본 덮어쓰기", "Replace install"),
            message: text(
              `${providerLabel(state.provider)}(${where})에 원본과 다른 사본이 있습니다.\n보관 원본으로 덮어쓸까요?`,
              `${providerLabel(state.provider)} (${where}) has a copy that differs from the archived source.\nReplace it with the archived source?`,
            ),
            warning: text("기존 사본의 변경은 사라집니다.", "The existing copy's changes will be lost."),
            confirmLabel: text("덮어쓰기", "Replace"),
            tone: "danger",
          });
          if (!replace) return;
          receipt = await publishCommonSkill({ key: entry.key, providers: [state.provider], overwrite: "replace", location: target });
          result = receipt.results[0];
        }
        if (result?.outcome === "failed") {
          setError(result.message ?? text("사용 설정에 실패했습니다.", "Failed to enable the skill."));
          return;
        }
        summary = text(
          `'${entry.key}'을 ${providerLabel(state.provider)}(${where})에서 사용합니다.`,
          `Enabled '${entry.key}' for ${providerLabel(state.provider)} (${where}).`,
        );
      } else {
        const install = installAt(state, target);
        if (!install) return;
        await deleteSkill(install.skillId);
        summary = text(
          `'${entry.key}'을 ${providerLabel(state.provider)}(${where})에서 사용 해제했습니다. 사용본은 휴지통으로 이동했습니다.`,
          `Disabled '${entry.key}' for ${providerLabel(state.provider)} (${where}). The install moved to the trash.`,
        );
      }
      await reportChanged(summary);
    });
  };

  /**
   * 스킬별 자동 동기화 설정. 체크 상태는 누른 쪽이 이미 안다. 쓰기 왕복 뒤에 목록과 제안
   * 카탈로그를 다시 받는 refresh까지 기다리면 체크박스가 세 왕복 뒤에야 움직인다. 화면을
   * 먼저 바꾸고 요청을 뒤로 보내며, 재조회는 확정용으로 뒤에서 돌린다.
   */
  const toggleAutoSync = (entry: SkillLibraryEntry, autoSync: boolean) => {
    setError(null);
    const previous = library;
    setLibrary((current) => current && {
      ...current,
      entries: current.entries.map((item) => item.key === entry.key ? { ...item, autoSync } : item),
    });
    void setSkillAutoSync(entry.key, autoSync)
      .then(() => refresh())
      .catch((cause: unknown) => {
        setLibrary(previous);
        setError(errorText(cause));
      });
  };

  // 자동 동기화: 자동 모드인 항목의 갈라진 사용본을 방향에 따라 맞춘다. 원본보다 나중에
  // 수정된 사본은 원본으로 채택하고, 뒤처진 사본은 원본을 그 자리에 다시 배포한다.
  // 방향을 가리지 않던 동안에는 뒤처진 사본까지 원본으로 채택해, 배포가 덜 된 스킬이
  // 자동으로 옛 내용까지 되돌아갔다. 서로 다른 수정이 여러 개면 자동 판단이 불가능하므로
  // 수동(외부 수정 감지 배지)으로 남긴다.
  useAutoSync(
    managedEntries,
    () => managedEntries.flatMap((entry): AutoSyncTask[] => {
      if (!entry.autoSync || !entry.common) return [];
      const divergents = divergentManagedInstalls(entry);
      if (divergents.length === 0) return [];
      const edited = divergents.filter(({ install }) => install.divergence !== "behind");
      if (edited.length === 0) {
        return [{
          key: entry.key,
          // 뒤처진 쪽은 원본을 덮어쓸 뿐이라 사본끼리 내용이 달라도 결과가 하나로 모인다.
          digests: [entry.common.contentDigest],
          run: () => redeployToInstalls(entry.key, divergents),
          done: text(
            `'${entry.key}'의 보관 원본을 뒤처진 사용본에 다시 배포했습니다.`,
            `Redeployed the archived source of '${entry.key}' to its out-of-date installs.`,
          ),
        }];
      }
      const target = edited[0].install;
      return [{
        key: entry.key,
        digests: edited.map(({ install }) => install.contentDigest ?? ""),
        run: () => syncSkillFromInstall(target.skillId),
        done: text(
          `'${entry.key}'을 자동 동기화했습니다. 이전 원본은 휴지통에 있습니다.`,
          `Auto-synced '${entry.key}'. The previous source is in the trash.`,
        ),
      }];
    }),
    reportChanged,
    (cause) => setError(errorText(cause)),
  );

  return {
    library,
    projectRegistry,
    loading,
    error,
    setError,
    notice,
    setNotice,
    managedEntries,
    useBusy,
    refresh,
    reportChanged,
    setSkillUse,
    toggleAutoSync,
  };
}


interface SkillLibraryListingOptions {
  /** 스킬관리가 다루는 전체 보관 스킬. 검색·필터는 이 안에서만 고른다. */
  managedEntries: SkillLibraryEntry[];
  /** 번역된 이름·설명을 찾아 주는 조회기. 검색어는 원문과 번역문 어느 쪽에 걸려도 잡힌다. */
  entryTranslation: (entry: SkillLibraryEntry) => Record<string, string> | undefined;
  query: string;
  filters: SkillLibraryFilters;
  setFilters: (update: (current: SkillLibraryFilters) => SkillLibraryFilters) => void;
  /** 출처 칩에서 설정 제외 프로젝트를 숨기는 근거. 조회 실패로 비어 있어도 칩은 그대로 선다. */
  projectRegistry: ProjectRegistryEntry[];
  /** 목록을 한 번이라도 읽었는지. 읽기 전에는 사라진 출처 되돌리기를 하지 않는다. */
  libraryLoaded: boolean;
  onMigrationRequiredCount?: (count: number) => void;
}

/**
 * 화면에 설 목록과 그 곁의 숫자 한 벌 — 검색, 필터·정렬, 동기화 상태 개수, 출처 프로젝트 칩,
 * 축별 칩 개수, 사라진 출처 되돌리기, 변형 필요 개수 통지가 화면 본문에 일곱 개의 `useMemo`와
 * 두 개의 `useEffect`로 펼쳐져 있었다. 그중 `searched`·`excludedProjects`·`originValues`처럼
 * 중간 결과일 뿐인 값까지 본문에 이름을 갖고 있어, 실제로 마크업이 쓰는 넷(`entries` `counts`
 * `originProjects` `filterCounts`)을 가리고 있었다. 그 파생만 이리로 옮겨 본문에는 결과 넷만
 * 남긴다. 계산 순서와 의존성은 옮기기 전 그대로다.
 */
function useSkillLibraryListing({
  managedEntries,
  entryTranslation,
  query,
  filters,
  setFilters,
  projectRegistry,
  libraryLoaded,
  onMigrationRequiredCount,
}: SkillLibraryListingOptions): {
  entries: SkillLibraryEntry[];
  counts: ReturnType<typeof skillSyncCounts>;
  originProjects: ReturnType<typeof skillOriginProjects>;
  filterCounts: SkillFilterCounts;
} {
  // 검색은 필터와 독립된 축이다. 필터 칩 개수도 검색 결과 안에서 세야 화면과 맞는다.
  const searched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return managedEntries.filter((entry) => {
      const translated = entryTranslation(entry);
      return matchesSkillQuery(entry, query)
        || (needle.length > 0 && matchesNeedle([translated?.name, translated?.description], needle));
    });
  }, [managedEntries, query, entryTranslation]);

  const entries = useMemo(() => sortSkillEntries(filterSkillEntries(searched, filters)), [searched, filters]);

  const counts = useMemo(() => skillSyncCounts(managedEntries), [managedEntries]);
  // 출처 필터의 프로젝트 칩. 보관 스킬 출처에 등장한 프로젝트만 노출하고, 설정에서 제외한
  // 프로젝트는 숨긴다(출처 표시 자체는 이력이라 항목에 남는다).
  const excludedProjects = useMemo(() => excludedProjectPaths(projectRegistry), [projectRegistry]);
  const originProjects = useMemo(
    () => skillOriginProjects(managedEntries, excludedProjects),
    [managedEntries, excludedProjects],
  );
  const originValues = useMemo(
    () => ["all", "personal", "project", ...originProjects.map((project) => `project:${project.path}`)],
    [originProjects],
  );
  const filterCounts = useMemo(
    () => skillFilterCounts(searched, filters, originValues),
    [searched, filters, originValues],
  );

  // 저장된 프로젝트 출처가 사라졌으면(그 프로젝트 스킬을 모두 지웠거나 보관을
  // 풀었으면) 아무 것도 안 나오는 필터로 남지 않게 프로젝트 전체로 되돌린다.
  useEffect(() => {
    if (!libraryLoaded || !filters.origin.startsWith("project:")) return;
    if (originProjects.some((project) => `project:${project.path}` === filters.origin)) return;
    setFilters((current) => ({ ...current, origin: "project" }));
  }, [libraryLoaded, filters.origin, originProjects]);
  const migrationRequiredCount = useMemo(
    () => managedEntries.filter((entry) => entry.migrationRequired).length,
    [managedEntries],
  );

  useEffect(() => {
    onMigrationRequiredCount?.(migrationRequiredCount);
  }, [migrationRequiredCount, onMigrationRequiredCount]);

  return { entries, counts, originProjects, filterCounts };
}

interface SkillBulkActionsOptions {
  /** 일괄 작업의 모집단. 화면에서 숨겨져도 선택이 남아 있을 수 있어 전체 보관 스킬을 받는다. */
  managedEntries: SkillLibraryEntry[];
  /** 지금 필터·검색을 통과해 화면에 있는 항목. 전체선택과 선택 정리의 기준이다. */
  visibleEntries: SkillLibraryEntry[];
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  setError: (message: string | null) => void;
  /** 쓰기 뒤 알림·상위 통지·재조회 한 벌. 화면 본문이 쓰는 것과 같은 것을 받는다. */
  reportChanged: (summary: string) => Promise<void>;
}

type BulkKind = "deploy" | "delete" | "import" | "unarchive" | "disable";

/**
 * 일괄 작업 바 한 덩어리 — 선택 집합, 바쁨 표시, 미보관 선행 보관, 실패 집계, 다섯 가지
 * 실행(보관·보관취소·사용·미사용·삭제)이 화면 본문에 그대로 펼쳐져 있었다. 목록·필터·서랍을
 * 읽으려면 이 200여 줄을 매번 건너뛰어야 했으므로, 화면이 실제로 쓰는 값과 실행만 내주는
 * 훅으로 가른다. 상태와 순서는 옮기기 전 그대로다.
 */
function useSkillBulkActions(
  { managedEntries, visibleEntries, confirm, setError, reportChanged }: SkillBulkActionsOptions,
) {
  const { text } = useI18n();
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<BulkKind | null>(null);

  // 선택은 지금 화면에 보이는 항목 안에서만 유지한다. 새로고침으로 사라진 항목뿐 아니라
  // 필터·검색으로 좁혀져 숨은 항목도 선택에서 빼야, 일괄 작업 바의 개수가 보이는 것과
  // 같고 일괄 삭제가 화면에 없는 스킬까지 대상으로 삼지 않는다(QA #30).
  useEffect(() => {
    setCheckedKeys((current) => {
      const visible = new Set(visibleEntries.map((entry) => entry.key));
      const next = new Set([...current].filter((key) => visible.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [visibleEntries]);

  const checkedEntries = useMemo(
    () => managedEntries.filter((entry) => checkedKeys.has(entry.key)),
    [managedEntries, checkedKeys],
  );

  const toggleChecked = (key: string, checked: boolean) => {
    setCheckedKeys((current) => {
      const next = new Set(current);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const finishBulk = (summary: string) => {
    setCheckedKeys(new Set());
    void reportChanged(summary);
  };

  const bulkImportable = checkedEntries.some((entry) => !entry.common);
  const bulkUnarchivable = checkedEntries.some((entry) => entry.common);
  // 전체선택은 현재 필터·검색 결과만 대상으로 한다. 숨겨진 항목을 몰래 선택에
  // 넣으면 일괄 삭제가 보이는 것보다 넓게 실행되는 사고가 난다. 선택이 하나라도
  // 있으면 전체해제로 동작해 버튼 하나로 선택 상태를 오간다.
  const toggleSelectAll = () => {
    setCheckedKeys((current) =>
      current.size > 0 ? new Set() : new Set(visibleEntries.map((entry) => entry.key)),
    );
  };

  /** 미보관 선택 항목을 먼저 보관 처리한다. 사용·미사용·삭제는 보관 스킬을
   * 전제로 하므로, 미보관 항목은 사용자 확인을 거쳐 자동 보관 후 이어서 처리한다.
   * 보관에 실패한 항목의 키를 실패 목록에 남기고 후속 처리에서 제외한다. */
  const archiveFirst = async (targets: SkillLibraryEntry[], failures: string[]): Promise<Set<string>> => {
    const excluded = new Set<string>();
    for (const entry of targets.filter((item) => !item.common)) {
      const importable = importableProvider(entry);
      if (!importable) {
        failures.push(text(`${entry.key}: 보관할 수 있는 설치본이 없습니다`, `${entry.key}: no install to archive`));
        excluded.add(entry.key);
        continue;
      }
      try {
        await importSkillToCommon(importable.skillId as string);
      } catch (cause) {
        failures.push(`${entry.key}: ${errorText(cause)}`);
        excluded.add(entry.key);
      }
    }
    return excluded;
  };

  /** 선택 항목 중 아직 보관되지 않은 개수. 보관 선행이 필요한지 판단하는 기준이다. */
  const unarchivedCount = (targets: SkillLibraryEntry[]) => targets.filter((entry) => !entry.common).length;

  /** 미보관 항목이 섞여 있으면 보관 후 처리한다는 확인을 받는다. */
  const confirmArchiveFirst = async (action: string, actionEn: string): Promise<boolean> => {
    const unarchived = unarchivedCount(checkedEntries);
    if (unarchived === 0) return true;
    return confirm({
      title: text("보관 후 처리", "Archive first"),
      message: text(
        `보관되지 않은 스킬 ${unarchived}개가 있습니다.\n먼저 보관한 뒤 ${action} 처리합니다. 계속할까요?`,
        `${unarchived} selected skill(s) are not archived yet.\nThey will be archived first, then ${actionEn}. Continue?`,
      ),
      confirmLabel: text("계속", "Continue"),
    });
  };

  /** 확인 대화에 덧붙이는 "미보관 항목은 먼저 보관한다" 안내 한 줄. 없으면 빈 문자열. */
  const archiveFirstNote = (targets: SkillLibraryEntry[], action: string) => {
    const unarchived = unarchivedCount(targets);
    if (unarchived === 0) return "";
    return text(
      `\n보관되지 않은 스킬 ${unarchived}개는 먼저 보관한 뒤 ${action}합니다.`,
      `\n${unarchived} unarchived skill(s) will be archived first.`,
    );
  };

  /**
   * 일괄 작업 5벌(삭제·해제·보관취소·보관·배포)의 공통 실행기.
   * 대상 유무 확인과 실행 전 확인 대화, 바쁨 상태 설정, 오류 초기화, 미보관 항목
   * 선보관(옵션), 대상별 실행과 성공/실패 집계, 결과 메시지 조립 및 마무리
   * 처리를 한 곳에서 수행한다.
   */
  const runBulkOperation = async (
    busyKind: BulkKind,
    targets: SkillLibraryEntry[],
    options: {
      archiveFirst?: boolean;
      /** 생략하면 확인 없이 바로 실행한다(이미 별도 모달에서 확인을 받은 배포). */
      confirmWith?: { title: string; message: string; confirmLabel: string; tone?: "danger" };
      worker: (entry: SkillLibraryEntry) => Promise<void>;
      successMessage: (done: number) => string;
      failActionKo: string;
      failActionEn: string;
    },
  ) => {
    if (targets.length === 0) return;
    if (options.confirmWith) {
      const proceed = await confirm({
        title: options.confirmWith.title,
        message: options.confirmWith.message,
        items: targets.map((entry) => entry.key),
        confirmLabel: options.confirmWith.confirmLabel,
        ...(options.confirmWith.tone ? { tone: options.confirmWith.tone } : {}),
      });
      if (!proceed) return;
    }
    setBulkBusy(busyKind);
    setError(null);
    const failures: string[] = [];
    const excluded = options.archiveFirst ? await archiveFirst(targets, failures) : new Set<string>();
    let done = 0;
    for (const entry of targets) {
      if (excluded.has(entry.key)) continue;
      try {
        await options.worker(entry);
        done += 1;
      } catch (cause) {
        failures.push(`${entry.key}: ${errorText(cause)}`);
      }
    }
    setBulkBusy(null);
    finishBulk(
      failures.length === 0
        ? options.successMessage(done)
        : text(
            `${done}개 ${options.failActionKo}, ${failures.length}개 실패: ${failures.join(" / ")}`,
            `${done} ${options.failActionEn}, ${failures.length} failed: ${failures.join(" / ")}`,
          ),
    );
  };

  /** 선택 항목 삭제. 원본과 모든 에이전트 사용본을 한 그룹으로 휴지통에 옮긴다.
   * 미보관 항목은 확인 후 보관을 거쳐 함께 삭제한다. */
  const runBulkDelete = async () => {
    const archiveNote = archiveFirstNote(checkedEntries, text("삭제", "delete"));
    await runBulkOperation("delete", checkedEntries, {
      archiveFirst: true,
      confirmWith: {
        title: text("스킬 삭제", "Delete skills"),
        message: text(
          `스킬 ${checkedEntries.length}개를 삭제할까요?\n원본과 모든 에이전트 사용본이 휴지통으로 이동하며 복구할 수 있습니다.${archiveNote}`,
          `Delete ${checkedEntries.length} skill(s)?\nThe sources and every agent install move to the trash and can be restored.${archiveNote}`,
        ),
        confirmLabel: text("삭제", "Delete"),
        tone: "danger",
      },
      worker: async (entry) => {
        await deleteSharedSkill(entry.key);
      },
      successMessage: (done) => text(`${done}개 스킬을 휴지통으로 이동했습니다.`, `Moved ${done} skill(s) to the trash.`),
      failActionKo: text("이동", "moved"),
      failActionEn: "moved",
    });
  };

  /** 선택 항목을 모든 에이전트에서 사용 해제한다. 사용본은 휴지통으로 이동하고
   * 보관 원본만 남는다. 미보관 항목은 보관을 거쳐 처리하며, 대상과 결과를
   * 확인받은 뒤 실행한다. */
  const runBulkDisable = async () => {
    const archiveNote = archiveFirstNote(checkedEntries, text("해제", "disable"));
    await runBulkOperation("disable", checkedEntries, {
      archiveFirst: true,
      confirmWith: {
        title: text("모든 에이전트에서 사용 해제", "Disable everywhere"),
        message: text(
          `스킬 ${checkedEntries.length}개를 모든 에이전트에서 사용 해제할까요?\n사용본은 휴지통으로 이동하고 보관 원본은 남습니다.${archiveNote}`,
          `Disable ${checkedEntries.length} skill(s) for every agent?\nInstalls move to the trash; the archived sources remain.${archiveNote}`,
        ),
        confirmLabel: text("사용 해제", "Disable"),
        tone: "danger",
      },
      worker: async (entry) => {
        const installs = managedInstalls(entry);
        for (const install of installs) {
          await deleteSkill(install.skillId);
        }
      },
      successMessage: (done) => text(`${done}개 스킬을 모든 위치에서 사용 해제했습니다. 보관 원본은 남아 있습니다.`, `Disabled ${done} skill(s) everywhere. The archived sources remain.`),
      failActionKo: text("해제", "disabled"),
      failActionEn: "disabled",
    });
  };

  /** 선택한 보관 스킬의 보관만 일괄 취소한다. 에이전트 사용본은 그대로 두므로
   * 보관의 정확한 반대이며, 미보관 항목은 대상이 아니다. */
  const runBulkUnarchive = async () => {
    const targets = checkedEntries.filter((entry) => entry.common);
    const orphans = targets.filter((entry) => entry.installedCount === 0).length;
    const orphanNote = orphans > 0
      ? text(`\n사용 중인 에이전트가 없는 ${orphans}개는 목록에서 사라집니다.`, `\n${orphans} skill(s) with no agent install will disappear from the list.`)
      : "";
    await runBulkOperation("unarchive", targets, {
      confirmWith: {
        title: text("스킬 보관취소", "Unarchive skills"),
        message: text(
          `스킬 ${targets.length}개의 보관을 취소할까요?\n보관 원본만 휴지통으로 가고 에이전트 사용본은 그대로 남습니다.${orphanNote}`,
          `Unarchive ${targets.length} skill(s)?\nOnly the archived sources move to the trash; every agent install stays in place.${orphanNote}`,
        ),
        confirmLabel: text("보관취소", "Unarchive"),
      },
      worker: async (entry) => {
        await unarchiveSharedSkill(entry.key);
      },
      successMessage: (done) => text(`${done}개 스킬의 보관을 취소했습니다.`, `Unarchived ${done} skill(s).`),
      failActionKo: text("보관취소", "unarchived"),
      failActionEn: "unarchived",
    });
  };

  /** 선택한 에이전트 스킬을 보관 저장소로 일괄 보관. 이미 보관된 항목은 건너뛴다.
   * 대상 목록을 확인받은 뒤 실행한다. */
  const runBulkArchive = async () => {
    const targets = checkedEntries.filter((entry) => !entry.common);
    await runBulkOperation("import", targets, {
      confirmWith: {
        title: text("스킬 보관", "Archive skills"),
        message: text(
          `스킬 ${targets.length}개를 보관 저장소로 보관할까요?\n기존 설치본은 그대로 남아 사용 중으로 표시됩니다.`,
          `Archive ${targets.length} skill(s) to the archive store?\nExisting installs stay and show as in use.`,
        ),
        confirmLabel: text("보관", "Archive"),
      },
      worker: async (entry) => {
        const importable = importableProvider(entry);
        if (!importable) {
          throw new Error(text("보관할 수 있는 설치본이 없습니다", "no install to archive"));
        }
        await importSkillToCommon(importable.skillId as string);
      },
      successMessage: (done) => text(`${done}개 스킬을 보관했습니다.`, `Archived ${done} skill(s).`),
      failActionKo: text("보관", "archived"),
      failActionEn: "archived",
    });
  };

  /** 선택 항목을 지정 에이전트에서 사용하도록 설정. 미보관 항목은 확인을 거쳐
   * 먼저 보관한 뒤 함께 적용한다. */
  const runBulkDeploy = async (providers: ProviderId[], overwrite: boolean) => {
    await runBulkOperation("deploy", checkedEntries, {
      archiveFirst: true,
      worker: async (entry) => {
        const receipt = await publishCommonSkill({
          key: entry.key,
          providers,
          overwrite: overwrite ? "replace" : "fail",
          location: originLocation(entry),
        });
        if (publishHadFailure(receipt)) {
          throw new Error(publishSummary(receipt, text));
        }
      },
      successMessage: (done) => text(`${done}개 스킬에 사용 설정을 적용했습니다.`, `Enabled ${done} skill(s).`),
      failActionKo: text("적용", "enabled"),
      failActionEn: "enabled",
    });
  };

  return {
    bulkBusy,
    checkedKeys,
    checkedEntries,
    bulkImportable,
    bulkUnarchivable,
    toggleChecked,
    toggleSelectAll,
    confirmArchiveFirst,
    runBulkArchive,
    runBulkUnarchive,
    runBulkDisable,
    runBulkDelete,
    runBulkDeploy,
  };
}

/**
 * 목록 위 도구줄의 껍데기. 설치 스킬·보관 스킬·보관 지침 세 화면이 `toolbar-card
 * skill-library-toolbar` → `skill-library-titlebar` → `skill-library-summary` → `strong`+`small`
 * 이라는 네 겹 골격과 그 아래 `skill-library-toolbar-row` 한 줄을 각자 펼쳐 두고 있었다.
 * 세 벌로 두면 한 화면의 겹 하나만 고쳤을 때 나머지 둘의 여백·줄바꿈이 조용히 갈라진다.
 * 여기서는 껍데기만 그리고, 제목 줄에 무엇을 적을지(`title`·`summary`)와 도구줄에 무엇을
 * 놓을지(`children`)는 화면이 정한다.
 */
export function LibraryToolbar({ title, summary, children }: {
  title: ReactNode;
  summary: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="toolbar-card skill-library-toolbar">
      <div className="skill-library-titlebar">
        <div className="skill-library-summary">
          <strong>{title}</strong>
          <small>{summary}</small>
        </div>
      </div>
      <div className="skill-library-toolbar-row">{children}</div>
    </section>
  );
}

/**
 * 화면 안의 "정보 / 관리" 모드 탭 한 줄. 스킬 화면과 지침 화면이 이름표와 탭 이름만 다르고
 * 활성 표시(`active` 클래스와 `aria-pressed`)·`role="group"` 골격은 같은 마크업을 각자 펼쳐
 * 두고 있었다. 두 벌로 두면 접근성 속성 한쪽만 고치는 일이 생긴다.
 */
export function ViewModeTabs<M extends string>({ label, modes, current, onSelect }: {
  label: string;
  modes: readonly { id: M; label: string }[];
  current: M;
  onSelect: (mode: M) => void;
}) {
  return (
    <div className="skill-mode-tabs" role="group" aria-label={label}>
      {modes.map((mode) => (
        <button
          key={mode.id}
          className={current === mode.id ? "active" : ""}
          type="button"
          aria-pressed={current === mode.id}
          onClick={() => onSelect(mode.id)}
        >{mode.label}</button>
      ))}
    </div>
  );
}

/**
 * AIA에게 현재 OS 변형 생성을 통째로 맡기는 툴바 버튼. 스킬관리와 지침관리가 같은 버튼을
 * 각자 적어 두어, 잠기는 조건(시스템 에이전트 없음 / 변형이 필요한 항목 없음)과 개수 배지가
 * 두 벌로 갈라져 있었다. 갈리는 것은 도움말 문구 둘뿐이라 그것만 받는다.
 */
export function BulkMigrationButton({ aiaAvailable, count, noneTitle, requestTitle, onRequest }: {
  aiaAvailable: boolean;
  /** 현재 OS 변형이 필요한 항목 수. 0이면 누를 수 없고 배지도 서지 않는다. */
  count: number;
  noneTitle: string;
  requestTitle: string;
  onRequest: () => void;
}) {
  const { text } = useI18n();
  return (
    <div className="skill-transfer-buttons">
      <button
        className="button compact"
        type="button"
        disabled={!aiaAvailable || count === 0}
        title={!aiaAvailable
          ? text("연결된 시스템 에이전트를 설정하세요", "Configure a connected system agent")
          : count === 0 ? noneTitle : requestTitle}
        onClick={onRequest}
      ><RefreshCw size={13} aria-hidden="true" /><AiaMark size={13} />{text("일괄 마이그레이션", "Migrate all")}{count > 0 && <small>{count}</small>}</button>
    </div>
  );
}

/**
 * 축 한 줄을 적을 때의 모양. 필터 한 벌의 키마다 그 키에 맞는 명세를 만들어 합집합으로
 * 두므로, `axis`에 적은 키와 칩 값이 서로 맞는지 축 하나 단위로 검사된다.
 */
type FilterAxisDraft<F extends object> = {
  [K in keyof F]: FilterAxisSpec<F, K> & {
    /** 0건 칩도 눌러서 그 축으로 옮겨 갈 수 있어야 하는 축. 칩 줄의 잠금 규칙을 끈다. */
    alwaysEnabled?: boolean;
  };
}[keyof F];

/**
 * 축 표를 `FilterAxisBar`가 받는 모양으로 만든다. 스킬관리·스킬정보·지침정보 세 화면이
 * 축 목록을 적고 나서 똑같이 `as FilterAxisSpec<F>[]`로 통째로 덮어쓰고 있었다 — 축마다
 * 값 타입이 다른 표를 하나의 배열 타입으로 좁히려니 달리 길이 없었지만, 그 덮어쓰기는
 * `axis`에 없는 키를 적거나 그 축에 없는 값을 칩에 적어도 조용히 통과시킨다. 축 하나씩
 * 검사되는 합집합(`FilterAxisDraft`)으로 받아 좁히는 일은 여기 한 자리에서만 한다.
 *
 * 0건 칩 잠금을 끄는 축은 칩마다 `disabled: false`를 되풀이해 적고 있었다. 그 규칙은
 * 칩이 아니라 축의 성질이므로 축에 한 번 적는다.
 */
export function filterAxes<F extends object>(drafts: readonly FilterAxisDraft<F>[]): FilterAxisSpec<F>[] {
  return drafts.map(({ alwaysEnabled, ...axis }) => {
    const spec = axis as FilterAxisSpec<F>;
    return alwaysEnabled
      ? { ...spec, chips: spec.chips.map((chip) => ({ ...chip, disabled: false })) }
      : spec;
  });
}

/**
 * 보관·상태·에이전트 세 축. 축 이름표와 칩 이름만 다르고 개수 배지·활성 표시·"고르면 그 축만
 * 바꾼다" 규칙은 같아서, 세 벌을 손으로 되풀이하면 규칙을 한 축에서만 고치게 된다.
 */
function simpleFilterAxes(text: UiText): FilterAxisSpec<SkillLibraryFilters>[] {
  return filterAxes<SkillLibraryFilters>([
    {
      axis: "kind",
      label: text("보관", "Archive"),
      groupLabel: text("보관 여부 필터", "Archive filter"),
      chips: [
        { value: "all", label: text("전체", "All") },
        { value: "shared", label: text("보관", "Archived") },
        { value: "agent", label: text("미보관", "Unarchived") },
      ],
    },
    {
      axis: "state",
      label: text("상태", "State"),
      groupLabel: text("스킬 상태 필터", "Skill state filter"),
      chips: [
        { value: "all", label: text("전체", "All") },
        { value: "conflict", label: text("외부 수정 감지", "Externally edited") },
        { value: "stale", label: text("뒤처짐", "Out of date") },
        { value: "undeployed", label: text("미사용", "Not in use") },
      ],
    },
    {
      axis: "agent",
      label: text("에이전트", "Agent"),
      groupLabel: text("사용 에이전트 필터", "Agent use filter"),
      chips: [
        { value: "all", label: text("전체", "All") },
        // 로컬 공급자는 Codex 하네스를 빌려 쓰므로 스킬도 Codex 행으로 게시된다. 따로
        // 고를 칩을 두면 언제나 빈 목록이 된다.
        ...PROVIDER_IDS.filter((provider) => provider !== "local")
          .map((provider) => ({ value: provider, label: providerLabel(provider) })),
      ],
    },
  ]);
}

/**
 * 목록 위의 필터 줄. 표로 도는 세 축과, 두 단으로 펼쳐지는 출처 축을 함께 그린다.
 * 고른 값은 부모가 들고 있고 여기서는 바뀐 필터 한 벌만 돌려준다.
 */
function SkillLibraryFilterBar({ filters, counts, originProjects, onChange }: {
  filters: SkillLibraryFilters;
  counts: SkillFilterCounts;
  originProjects: readonly { path: string; name: string }[];
  onChange: (filters: SkillLibraryFilters) => void;
}) {
  const { text } = useI18n();
  const projectOriginSelected = isProjectOriginFilter(filters.origin);
  return (
    <section className="toolbar-card skill-library-filterbar">
      <FilterAxisBar
        axes={simpleFilterAxes(text)}
        filters={filters}
        // 축마다 키 집합이 달라 표 하나로 훑으려면 문자열 키로 읽는다.
        countWhere={(axis, value) => (counts[axis as "kind" | "state" | "agent"] as Record<string, number>)[value as string] ?? 0}
        onChange={onChange}
      />
      {/* 출처는 두 단이다. 프로젝트를 고르기 전에는 프로젝트 이름 칩을 내지 않아
          칩 줄이 프로젝트 수만큼 늘어나는 일을 막는다. */}
      <FilterAxis label={text("출처", "Source")} className="skill-origin-filter">
        <div className="skill-origin-filter-body">
          <FilterChipRow
            groupLabel={text("스킬 출처 필터", "Skill source filter")}
            chips={[
              { value: "all" as const, label: text("전체", "All") },
              { value: "personal" as const, label: text("개인", "Personal") },
              { value: "project" as const, label: text("프로젝트", "Project") },
            ].map((item) => ({
              value: item.value,
              label: item.label,
              count: counts.origin[item.value] ?? 0,
              // 프로젝트 칩은 개별 프로젝트를 고른 동안에도 켜진 것으로 본다.
              active: item.value === "project" ? projectOriginSelected : filters.origin === item.value,
            }))}
            onSelect={(origin) => onChange({ ...filters, origin })}
          />
          {projectOriginSelected && originProjects.length > 0 && (
            <FilterChipRow
              groupLabel={text("프로젝트 선택", "Project filter")}
              className="skill-origin-projects"
              chips={[
                {
                  value: "project",
                  label: text("전체 프로젝트", "All projects"),
                  count: counts.origin.project ?? 0,
                  active: filters.origin === "project",
                  // 상위 칩에서 이미 프로젝트를 골랐으므로 0건이어도 되돌아갈 길은 남긴다.
                  disabled: false,
                },
                ...originProjects.map((project) => ({
                  value: `project:${project.path}`,
                  label: displayPath(project.name),
                  title: displayPath(project.path),
                  count: counts.origin[`project:${project.path}`] ?? 0,
                  active: filters.origin === `project:${project.path}`,
                })),
              ]}
              onSelect={(origin) => onChange({ ...filters, origin })}
            />
          )}
        </div>
      </FilterAxis>
    </section>
  );
}

/** 에이전트 어댑터가 어디에 배포하는지, 왜 못하는지 항상 보여준다. */
function AdapterStrip({ library }: { library: SkillLibrary }) {
  const { text } = useI18n();
  return (
    <section className="skill-adapter-strip">
      {library.adapters.map((adapter) => (
        <div className={`skill-adapter-card${adapter.supportsCommonSource ? "" : " unsupported"}`} key={adapter.provider}>
          <header>
            <SourceBadge source={adapter.provider} />
            <span>{adapter.supportsCommonSource ? text("배포 가능", "Deployable") : text("배포 미지원", "Not deployable")}</span>
          </header>
          <code title={adapterSummary(adapter, text)}>{adapterSummary(adapter, text)}</code>
          <small>
            {text("읽는 위치", "Read roots")} {adapter.roots.filter((root) => root.present).length}/{adapter.roots.length}
          </small>
        </div>
      ))}
    </section>
  );
}

/**
 * 카드 한 줄을 버튼처럼 쓰기 위한 속성 묶음. 줄 안에 체크박스·사용 토글이 들어가는 자리는
 * `<button>`으로 감쌀 수 없어 `div`에 `role="button"`을 주고 Enter·Space를 손으로 받는데,
 * 스킬관리 목록과 설치 스킬 목록이 그 네 줄을 각자 적어 두었다. 한쪽에서만 `preventDefault`가
 * 빠지면 Space가 화면을 스크롤한 뒤 서랍이 열리는 식으로 갈라질 자리라 한 벌로 모은다.
 */
export function rowActivationProps(onActivate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    },
  };
}

/**
 * 라이브러리 목록 한 줄의 왼쪽 본문: 이름줄 + 설명 + 경로 세 층. 스킬관리·설치 스킬·공통
 * 지침 세 목록이 같은 세 층을 각자 펼쳐 두어, 경로를 `displayPath`로 줄이는 것과 설명에
 * `data-user-content`(번역 대상 표식)를 붙이는 것이 자리마다 따로 적혀 있었다 — 한 곳을
 * 고치면 나머지 둘이 조용히 갈라진다.
 *
 * 설명의 대체 문구 규칙은 자리마다 다르다(번역이 빈 문자열일 때 원문을 쓸지 안내 문구로
 * 갈지). 그 판단은 호출부에 남기고 여기서는 이미 정해진 문자열만 받는다.
 */
export function LibraryRowMain({ path, description, children }: {
  path: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="skill-library-row-main">
      <div className="skill-library-row-head">{children}</div>
      <p data-user-content>{description}</p>
      <code>{displayPath(path)}</code>
    </div>
  );
}

function SkillLibraryRow({
  entry,
  translated,
  checked,
  checkDisabled,
  onCheck,
  useBusy,
  onToggleUse,
  onToggleAutoSync,
  onOpen,
}: {
  entry: SkillLibraryEntry;
  translated?: Record<string, string>;
  checked: boolean;
  checkDisabled: boolean;
  onCheck: (checked: boolean) => void;
  useBusy: string | null;
  onToggleUse: (state: SkillProviderState, enabled: boolean) => void;
  onToggleAutoSync: (autoSync: boolean) => void;
  onOpen: () => void;
}) {
  const { text } = useI18n();
  const state = skillSyncState(entry);
  const origin = originLocation(entry);
  // 출처 외 위치에 배포된 사용본 수. 상세(드로어)에서 관리한다.
  const extraCount = entry.common
    ? managedInstalls(entry).filter((install) => !isAtLocation(install, origin)).length
    : 0;
  return (
    // 카드 안에 사용 체크박스가 들어가므로 버튼 중첩을 피해 div로 카드 클릭(상세)을
    // 처리한다. 체크박스 영역은 이벤트를 카드로 올리지 않는다.
    <div
      className={`skill-library-row ${state}${entry.common ? " is-shared" : ""}`}
      {...rowActivationProps(onOpen)}
    >
      <LibraryRowMain
        path={entry.common?.directory ?? entry.providers.find((item) => item.directory)?.directory ?? entry.key}
        description={translated?.description ?? (entry.description || text("설명이 없습니다.", "No description."))}
      >
        <input
          type="checkbox"
          className="skill-bulk-check"
          aria-label={text(`${entry.name} 선택`, `Select ${entry.name}`)}
          checked={checked}
          disabled={checkDisabled}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onCheck(event.target.checked)}
        />
        <strong data-user-content>{translated?.name ?? entry.name}</strong>
        {entry.common && <span className="skill-archived-pill">{text("보관", "Archived")}</span>}
        {entry.migrationRequired && (
          <span className="skill-sync-pill conflict">{text("OS 변형 필요", "OS variant required")}</span>
        )}
        {entry.origin?.scope === "project" && (
          <span className="skill-origin-pill">
            {text(`프로젝트: ${displayPath(entry.origin.projectName ?? "")}`, `Project: ${displayPath(entry.origin.projectName ?? "")}`)}
          </span>
        )}
        {state === "conflict" && (
          <span className="skill-sync-pill conflict">{skillSyncLabel(state, text)}</span>
        )}
      </LibraryRowMain>
      {entry.common ? (
        <div
          className="skill-use-matrix"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {entry.providers
            .filter((item) => item.status !== "unsupported")
            .map((item) => {
              const install = installAt(item, origin);
              const used = Boolean(install);
              return (
                <SkillUseToggle
                  key={item.provider}
                  used={used}
                  divergent={Boolean(install?.divergent)}
                  divergence={install?.divergence ?? null}
                  disabled={useBusy !== null}
                  title={install?.divergent
                    ? skillDivergenceHint(install.divergence, text)
                    : used
                      ? text("해제하면 출처 위치의 사용본이 휴지통으로 이동합니다", "Unchecking moves the origin-location install to the trash")
                      : text("체크하면 보관 원본을 출처 위치에 배포합니다", "Checking deploys the archived source to the origin location")}
                  onChange={(checked) => onToggleUse(item, checked)}
                >
                  <span>{providerLabel(item.provider)}</span>
                </SkillUseToggle>
              );
            })}
          {extraCount > 0 && (
            <span className="skill-extra-pill" title={text("출처 외 위치의 사용본. 상세에서 관리합니다.", "Installs outside the origin location. Manage in details.")}>
              +{extraCount}
            </span>
          )}
          <SkillAutoSyncToggle autoSync={entry.autoSync} disabled={useBusy !== null} onChange={onToggleAutoSync} />
        </div>
      ) : (
        <div className="skill-provider-matrix">
          {entry.providers.map((item) => (
            <ProviderChip key={item.provider} state={item} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 사용본 체크 토글. 목록 행(출처 위치)과 상세 서랍의 위치×에이전트 표가 같은
 * `skill-use-toggle` 라벨을 각자 펼쳐 두다 보니 갈라짐 표시(`divergent` 클래스와 경고
 * 아이콘)가 한쪽에만 붙거나 빠지기 쉬웠다. 라벨 껍데기와 갈라짐 표시를 한 벌로 두고
 * 자리마다 다른 것(설명 문구·안쪽 이름표)만 받는다.
 */
export function SkillUseToggle({ used, divergent, divergence = null, foreign = false, disabled, title, onChange, children }: {
  used: boolean;
  divergent: boolean;
  /**
   * 갈라진 방향. 뒤처진 사본(`behind`)은 원본을 다시 배포하면 끝나는 일이라 경고가 아니라
   * 낡음으로 보여야 한다 — 같은 빨간 경고로 두면 사용자가 그 사본을 새 원본으로 채택한다.
   * 방향을 모르는 자리(지침 배포 매트릭스)는 넘기지 않고 경고 표시를 그대로 쓴다.
   */
  divergence?: SkillDivergence | null;
  /**
   * 그 자리에 실체는 있지만 이 원본의 것은 아닐 때. 켜진 것으로 보이면 안 되므로(해제가
   * 삭제다) `used`와 따로 표시한다. 지침 배포 매트릭스만 쓴다.
   */
  foreign?: boolean;
  disabled: boolean;
  /** 설명 문구. 표 안의 칸처럼 이름표가 따로 서 있는 자리는 생략한다. */
  title?: string;
  onChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  const stale = divergent && divergence === "behind";
  return (
    <label
      className={`skill-use-toggle${used ? " used" : ""}${foreign ? " foreign" : ""}${divergent ? (stale ? " stale" : " divergent") : ""}`}
      title={title}
    >
      <input type="checkbox" checked={used} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      {children}
      {divergent && (stale
        ? <History size={10} aria-hidden="true" />
        : <AlertTriangle size={10} aria-hidden="true" />)}
      {foreign && <FileText size={10} aria-hidden="true" />}
    </label>
  );
}

/**
 * "위치 × 공급자" 표 한 벌. 스킬 사용 설정과 지침 배포 매트릭스가 같은
 * `skill-location-matrix` 표를 각자 펼쳐 두고 있었다 — 첫 열이 위치 이름이고 나머지 열이
 * 공급자 이름표(`providerLabel`)라는 머리 줄, 행마다 공급자 수만큼 칸을 놓는 본문까지
 * 골격이 같아서, 한쪽의 열 구성이나 이름표만 고치면 두 표가 조용히 갈라졌다.
 * 갈리는 것은 열이 무엇을 들고 있는지(스킬은 공급자 상태, 지침은 공급자 id)와 칸 안에
 * 무엇이 서는지뿐이라 그 둘만 받는다.
 */
export function LocationProviderMatrix<R extends { key: string; label: ReactNode; title?: string }, C>({
  locationHeader,
  columns,
  columnProvider,
  rows,
  cell,
}: {
  locationHeader: string;
  columns: readonly C[];
  /** 열 하나가 가리키는 공급자. 열쇠와 이름표가 여기서 함께 나온다. */
  columnProvider: (column: C) => ProviderId;
  rows: readonly R[];
  cell: (row: R, column: C) => ReactNode;
}) {
  return (
    <table className="skill-location-matrix">
      <thead>
        <tr>
          <th>{locationHeader}</th>
          {columns.map((column) => (
            <th key={columnProvider(column)}>{providerLabel(columnProvider(column))}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td title={row.title}>{row.label}</td>
            {columns.map((column) => (
              <td key={columnProvider(column)}>{cell(row, column)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * 자동 동기화 토글. 목록 행과 상세 서랍에 같은 이름표·설명이 두 벌로 있었다. 무엇이
 * 자동으로 일어나는지 설명하는 문구라 한쪽만 고쳐지면 두 자리의 설명이 어긋난다.
 */
function SkillAutoSyncToggle({ autoSync, disabled, onChange }: {
  autoSync: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { text } = useI18n();
  return (
    <label
      className={`skill-use-toggle skill-auto-toggle${autoSync ? " used" : ""}`}
      title={text(
        "켜면 외부 수정 감지 시 그 버전을 원본에 반영하고 전체 재배포합니다. 서로 다른 수정이 여러 개면 수동으로 남습니다.",
        "When on, an externally edited install is adopted as the source and redeployed everywhere. Multiple different edits stay manual.",
      )}
    >
      <input type="checkbox" checked={autoSync} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{text("자동 동기화", "Auto sync")}</span>
    </label>
  );
}

/**
 * 값 목록에서 여럿을 고르는 체크박스 줄. 지원 OS 두 자리(스킬 상세·지침 지원 OS 단계)와
 * 공급자 두 자리(지침 게시·지침 만들기), 지침 만들기의 지원 OS까지 다섯 벌이 같은
 * `skill-use-matrix` 껍데기와 "들어 있으면 빼고 없으면 넣는" 토글을 각자 펼쳐 놓고 있었다.
 * 그중 한 자리는 토글을 손으로 다시 적어(`filter`/스프레드) 나머지와 다른 모양이었다.
 * 껍데기와 토글 규칙을 한 벌로 두고 자리마다 다른 것(값 목록·이름표)만 받는다.
 *
 * 고른 값의 순서에는 뜻이 없다(`arraysEqual`로 비교한다). 새로 고른 값은 뒤에 붙는다.
 */
export function ToggleMatrix<V extends string>({ values, selected, disabled = false, label, onChange }: {
  values: readonly V[];
  selected: readonly V[];
  disabled?: boolean;
  label: (value: V) => string;
  onChange: (next: V[]) => void;
}) {
  return (
    <div className="skill-use-matrix">
      {values.map((value) => (
        <SkillUseToggle
          key={value}
          used={selected.includes(value)}
          divergent={false}
          disabled={disabled}
          onChange={(checked) => onChange(checked
            ? [...selected, value]
            : selected.filter((item) => item !== value))}
        >
          {label(value)}
        </SkillUseToggle>
      ))}
    </div>
  );
}

/**
 * 지원 OS 한 구획: 안내 한 줄 · OS 토글 · 저장 버튼 · (필요하면) 현재 OS 변형 요청 버튼.
 *
 * 스킬 서랍의 "OS 호환성"과 지침 1단계가 같은 네 조각을 각자 적고 있었다. 토글은
 * `ToggleMatrix`로 이미 한 벌이었지만 그 둘레 — 저장 버튼을 언제 잠글지(고른 값이
 * 저장된 값과 같으면), 누르는 동안 어떤 문구를 보일지, 변형 요청 버튼을 어떤 문구로
 * 세울지 — 는 손으로 두 번 적혀 있어 한쪽만 고치면 조용히 갈라졌다. 자리마다 다른 것은
 * 안내 문구와 바깥 껍데기뿐이므로 그 둘만 밖에 남긴다.
 *
 * `saving`·`migrating`을 불리언으로 받는 것은 두 화면의 busy 이름이 서로 다르기
 * 때문이다(`platforms` / `instruction-platforms`). 이름 비교는 각자의 자리에서 한다.
 */
export function PlatformSupportFields({
  description,
  platforms,
  saved,
  disabled,
  saving,
  onPlatformsChange,
  onSave,
  migration = null,
}: {
  description: ReactNode;
  /** 지금 고른 값. 저장 전 초안이다. */
  platforms: HostPlatform[];
  /** 저장돼 있는 값. 고른 값과 같으면 저장 버튼을 잠근다. */
  saved: HostPlatform[];
  disabled: boolean;
  saving: boolean;
  onPlatformsChange: (platforms: HostPlatform[]) => void;
  onSave: () => void;
  /** 현재 OS용 변형이 없어 AIA에 생성을 맡길 수 있을 때만 준다. */
  migration?: { note?: ReactNode; disabled: boolean; busy: boolean; onRequest: () => void } | null;
}) {
  const { text } = useI18n();
  return (
    <>
      <p className="prose-copy">{description}</p>
      <ToggleMatrix
        values={HOST_PLATFORMS}
        selected={platforms}
        disabled={disabled}
        label={(platform) => platformLabel(platform, text)}
        onChange={onPlatformsChange}
      />
      <div className="form-actions">
        <button className="button" type="button" disabled={disabled || arraysEqual(platforms, saved)} onClick={onSave}>
          {saving ? text("저장 중…", "Saving…") : text("지원 OS 저장", "Save supported OS")}
        </button>
      </div>
      {migration && <>
        {migration.note && <p className="prose-copy">{migration.note}</p>}
        <div className="form-actions">
          <button className="button" type="button" disabled={disabled || migration.disabled} onClick={migration.onRequest}>
            {migration.busy ? text("계획 확인 중…", "Loading plan…") : text("AIA로 현재 OS 변형 만들기", "Create current OS variant with AIA")}
          </button>
        </div>
      </>}
    </>
  );
}

function ProviderChip({ state }: { state: SkillProviderState }) {
  const { text } = useI18n();
  const title = [
    providerLabel(state.provider),
    skillProviderStatusLabel(state, text),
    state.directory ?? state.targetDirectory ?? "",
    state.note ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className={`skill-provider-chip ${skillStatusModifier(state)}`} title={title}>
      <em>{providerLabel(state.provider)}</em>
      {state.status === "linked" && <Link2 size={10} aria-hidden="true" />}
      {state.divergent && (state.divergence === "behind"
        ? <History size={10} aria-hidden="true" />
        : <AlertTriangle size={10} aria-hidden="true" />)}
      <b>{skillProviderStatusLabel(state, text)}</b>
    </span>
  );
}

function CreateSkillModal({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const { text } = useI18n();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keyProblem = key.trim() ? skillKeyError(key, text) : null;
  const descriptionProblem = description.trim() ? skillDescriptionError(description, text) : null;
  const ready = !skillKeyError(key, text) && !skillDescriptionError(description, text);

  const submit = async () => {
    setBusy(true);
    try {
      const created = await createCommonSkill({
        key: key.trim(),
        name: name.trim() || null,
        description: description.trim(),
      });
      onCreated(created.key);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={text("새 보관 스킬", "New archived skill")}
      onClose={onClose}
      footer={
        <>
          <button className="button" type="button" onClick={onClose} disabled={busy}>{text("취소", "Cancel")}</button>
          <button className="button primary" type="button" onClick={() => { void submit(); }} disabled={!ready || busy}>
            {busy ? text("만들고 있습니다…", "Creating…") : text("만들기", "Create")}
          </button>
        </>
      }
    >
      {error && <ErrorBanner message={error} />}
      <p className="prose-copy">{text(
        "보관 저장소에 원본만 만듭니다. 에이전트에서 쓰려면 만든 뒤 사용 여부를 켜세요.",
        "This creates the archived source only. Turn on agent use afterwards.",
      )}</p>
      <div className="form-row">
        <label htmlFor="skill-key">{text("이름", "Key")}</label>
        <div>
          <input id="skill-key" value={key} onChange={(event) => setKey(event.target.value)} placeholder="release-notes" autoFocus />
          {keyProblem && <small className="field-problem">{keyProblem}</small>}
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="skill-title">{text("표시 이름", "Display name")}</label>
        <div>
          <input id="skill-title" value={name} onChange={(event) => setName(event.target.value)} placeholder={text("비우면 이름을 그대로 씁니다", "Defaults to the key")} />
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="skill-description">{text("설명", "Description")}</label>
        <div>
          <textarea id="skill-description" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
          {descriptionProblem && <small className="field-problem">{descriptionProblem}</small>}
        </div>
      </div>
    </Modal>
  );
}

/** 일괄 사용 설정 대상 에이전트 선택. 사용 설정이 가능한 에이전트만 노출한다. */
function BulkDeployModal({
  library,
  count,
  onClose,
  onSubmit,
}: {
  library: SkillLibrary | null;
  count: number;
  onClose: () => void;
  onSubmit: (providers: ProviderId[], overwrite: boolean) => void;
}) {
  const { text } = useI18n();
  const deployable = (library?.adapters ?? []).filter((adapter) => adapter.supportsCommonSource);
  const [providers, setProviders] = useState<ProviderId[]>(deployable.map((adapter) => adapter.provider));
  const [overwrite, setOverwrite] = useState(true);

  return (
    <Modal
      title={text("일괄 사용 설정", "Enable for agents")}
      onClose={onClose}
      footer={
        <>
          <button className="button" type="button" onClick={onClose}>{text("취소", "Cancel")}</button>
          <button className="button primary" type="button" disabled={providers.length === 0} onClick={() => onSubmit(providers, overwrite)}>
            <Send size={13} aria-hidden="true" />{text("적용", "Enable")}
          </button>
        </>
      }
    >
      <p className="prose-copy">{text(
        `선택한 스킬 ${count}개를 아래 에이전트에서 사용하도록 설정합니다. 보관되지 않은 스킬은 먼저 보관됩니다.`,
        `Enables ${count} selected skill(s) for the agents below. Unarchived skills are archived first.`,
      )}</p>
      <div className="skill-publish-targets">
        {deployable.map((adapter) => (
          <label className="skill-publish-target" key={adapter.provider}>
            <input
              type="checkbox"
              checked={providers.includes(adapter.provider)}
              onChange={(event) => setProviders((current) => event.target.checked
                ? [...current, adapter.provider]
                : current.filter((item) => item !== adapter.provider))}
            />
            <span>{providerLabel(adapter.provider)}</span>
          </label>
        ))}
        <label className="skill-publish-target">
          <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
          <span>{text("기존 설치본 덮어쓰기", "Replace existing installs")}</span>
          <small>{text("끄면 이미 설치본이 있는 에이전트는 건너뜁니다.", "When off, agents that already have an install are skipped.")}</small>
        </label>
      </div>
    </Modal>
  );
}

type SkillDrawerBusy = "import" | "delete" | "unarchive" | "sync" | "redeploy" | "latest" | "save" | "migration" | "platforms";

/** `busyRunner`가 돌려주는 실행기. 훅 사이로 넘길 때 이 이름으로 받는다. */
export type BusyRunner<K extends string> =
  <T,>(kind: K, action: () => Promise<T>) => Promise<T | null>;

/**
 * 바쁨 표시·오류 초기화·try-catch-finally 껍데기. 두 서랍의 동작 아홉 벌이 같은 네 줄을
 * 손으로 반복하다 보니 오류 초기화가 빠진 자리와 순서가 다른 자리가 섞여 있었다.
 * 실패하면 null을 돌려주므로 결과를 이어 쓰는 자리는 그대로 이어 쓴다.
 *
 * 지침 화면도 같은 껍데기를 따로 들고 있었는데, 그쪽은 `Error`가 아닌 거절을 안내 문장으로
 * 바꿔 보여 준다는 점만 달랐다. 그 한 점을 `formatError`로 받아 두 벌을 한 벌로 모은다.
 */
export function busyRunner<K extends string>(
  setBusy: (value: K | null) => void,
  setError: (value: string | null) => void,
  formatError: (cause: unknown) => string = errorText,
): BusyRunner<K> {
  return async <T,>(kind: K, action: () => Promise<T>): Promise<T | null> => {
    setBusy(kind);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      setError(formatError(cause));
      return null;
    } finally {
      setBusy(null);
    }
  };
}

/** `useAutoSync`가 한 항목에 대해 받아 가는 자동 동기화 회차 하나. */
export interface AutoSyncTask {
  /** 항목 식별자. 같은 항목의 회차가 겹쳐 돌지 않게 하는 열쇠다. */
  key: string;
  /** 감지된 수정본들의 내용 지문. 서로 다른 값이 섞여 있으면 자동 판단을 포기한다. */
  digests: string[];
  /** 실제 채택 호출. */
  run: () => Promise<unknown>;
  /** 성공했을 때 알릴 문장. */
  done: string;
}

/**
 * 자동 동기화 한 벌. 보관 스킬과 공통 지침이 "자동 모드인 항목 중 외부 수정이 감지된 것을
 * 원본으로 채택한다"는 같은 절차를 각자 펼쳐 두고 있었다 — 지문이 하나로 모이는지 보고,
 * 이미 도는 항목을 건너뛰고, 끝나면 잠금을 푸는 세 가지가 두 벌로 적혀 있어 한쪽에서만
 * 규칙이 바뀔 자리였다. 무엇을 채택할지(`collect`)와 결과를 어디에 알릴지만 자리마다 다르다.
 *
 * `onDone`이 돌려주는 약속은 잠금을 풀기 전에 기다린다. 지침 화면은 알린 뒤 목록을 다시
 * 읽는데, 그 재조회가 끝나기 전에 잠금이 풀리면 같은 항목이 곧바로 한 번 더 돌게 된다.
 */
export function useAutoSync(
  trigger: unknown,
  collect: () => AutoSyncTask[],
  onDone: (message: string) => void | Promise<unknown>,
  onError: (cause: unknown) => void,
): void {
  const running = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const task of collect()) {
      if (new Set(task.digests).size !== 1) continue;
      if (running.current.has(task.key)) continue;
      running.current.add(task.key);
      void task.run()
        .then(() => onDone(task.done))
        .catch(onError)
        .finally(() => {
          running.current.delete(task.key);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);
}

function SkillLibraryDrawer({
  entry,
  translated,
  translationId,
  automation,
  onAutomationChange,
  projects,
  currentPlatform,
  useBusy,
  onSetUse,
  onToggleAutoSync,
  onClose,
  onChanged,
  onRequestAiaPrompt,
}: {
  entry: SkillLibraryEntry;
  translated?: Record<string, string>;
  translationId?: string;
  automation: SystemAutomationSnapshot | null;
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void;
  projects: SkillProjectView[];
  currentPlatform: HostPlatform;
  useBusy: string | null;
  onSetUse: (state: SkillProviderState, enabled: boolean, location: SkillLocation) => void;
  onToggleAutoSync: (autoSync: boolean) => void;
  onClose: () => void;
  onChanged: (message: string) => void;
  onRequestAiaPrompt?: (prompt: string) => void;
}) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [detail, setDetail] = useState<CommonSkillDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SkillDrawerBusy | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const runBusy = busyRunner<SkillDrawerBusy>(setBusy, setActionError);
  // 편집기가 열려 있는지만 서랍이 쥔다. 파일 목록·본문·변경 표시는 SkillFileEditor가
  // 열려 있는 동안만 들고 있고, 닫으면 함께 버려진다.
  const [editing, setEditing] = useState(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState<HostPlatform[]>(entry.platforms);

  const syncState = skillSyncState(entry);

  useEffect(() => {
    if (!entry.common) {
      setDetail(null);
      return;
    }
    let active = true;
    getCommonSkillDetail(entry.key)
      .then((value) => { if (active) { setDetail(value); setDetailError(null); } })
      .catch((cause: unknown) => { if (active) setDetailError(errorText(cause)); });
    return () => { active = false; };
  }, [entry.key, entry.common, entry.common?.contentDigest]);

  useEffect(() => {
    setSelectedPlatforms(entry.platforms);
  }, [entry.key, entry.platforms]);

  /**
   * "확인받고 → 실행하고 → 결과를 알리고 → 서랍을 닫는다"는 세 갈래 작업(삭제·보관취소·
   * 보관)이 같은 골격을 각자 펼쳐 놓고 있었다. 되풀이되던 순서를 한 곳에 모아, 각 작업은
   * 확인 문구와 실제 호출만 넘긴다. 알릴 문구는 호출이 끝나야 정해지는 경우(보관은 서버가
   * 돌려준 키를 쓴다)가 있어 `action`의 반환값으로 받는다.
   */
  const runConfirmedClose = async (
    kind: SkillDrawerBusy,
    request: ConfirmRequest,
    action: () => Promise<string>,
  ) => {
    if (!await confirm(request)) return;
    await runBusy(kind, async () => {
      onChanged(await action());
      onClose();
    });
  };

  /** 스킬 삭제. 보관 원본과 모든 에이전트 사용본을 한 휴지통 그룹으로 옮긴다. */
  const runDelete = async () => {
    if (!entry.common) return;
    const usedCount = managedInstalls(entry).length;
    await runConfirmedClose(
      "delete",
      {
        title: text("스킬 삭제", "Delete skill"),
        message: text(
          `'${entry.name}' 스킬을 삭제할까요?\n원본과 에이전트 사용본 ${usedCount}개가 함께 휴지통으로 이동하며, 휴지통에서 그룹 단위로 복구할 수 있습니다.`,
          `Delete skill '${entry.name}'?\nThe source and ${usedCount} agent install(s) move to the trash together and can be restored as a group.`,
        ),
        confirmLabel: text("삭제", "Delete"),
        tone: "danger",
      },
      async () => {
        await deleteSharedSkill(entry.key);
        return text(`'${entry.key}' 스킬을 휴지통으로 이동했습니다.`, `Moved skill '${entry.key}' to the trash.`);
      },
    );
  };

  /** 보관만 취소. 에이전트 사용본은 그대로 두고 보관 원본만 휴지통으로 옮긴다. */
  const runUnarchive = async () => {
    if (!entry.common) return;
    const usedCount = managedInstalls(entry).length;
    await runConfirmedClose(
      "unarchive",
      {
        title: text("스킬 보관취소", "Unarchive skill"),
        message: usedCount > 0
          ? text(
            `'${entry.name}' 스킬의 보관을 취소할까요?\n보관 원본만 휴지통으로 가고, 에이전트 사용본 ${usedCount}개는 그대로 남아 '미보관'으로 돌아갑니다.`,
            `Unarchive skill '${entry.name}'?\nOnly the archived source moves to the trash. Its ${usedCount} agent install(s) stay in place and return to 'unarchived'.`,
          )
          : text(
            `'${entry.name}' 스킬의 보관을 취소할까요?\n사용 중인 에이전트가 없어 목록에서 사라집니다. 휴지통에서 되돌릴 수 있습니다.`,
            `Unarchive skill '${entry.name}'?\nNo agent uses it, so it disappears from the list. You can restore it from the trash.`,
          ),
        confirmLabel: text("보관취소", "Unarchive"),
      },
      async () => {
        await unarchiveSharedSkill(entry.key);
        return text(`'${entry.key}' 스킬의 보관을 취소했습니다.`, `Unarchived skill '${entry.key}'.`);
      },
    );
  };

  const runImport = async (skillId: string) => {
    await runConfirmedClose(
      "import",
      {
        title: text("스킬 보관", "Archive skill"),
        message: text(
          `'${entry.name}' 스킬을 보관 저장소로 보관할까요?\n기존 설치본은 그대로 남아 사용 중으로 표시됩니다.`,
          `Archive skill '${entry.name}' to the archive store?\nThe existing install stays and shows as in use.`,
        ),
        confirmLabel: text("보관", "Archive"),
      },
      async () => {
        const created = await importSkillToCommon(skillId);
        return text(`'${created.key}'을 보관했습니다.`, `Archived '${created.key}'.`);
      },
    );
  };

  /**
   * 뒤처진 사용본 자리에 보관 원본을 다시 배포한다. 채택(`runSync`)과 방향이 반대인
   * 조치라, 사본을 덮는다는 사실과 어느 자리인지를 확인 문구에 그대로 적는다.
   */
  const runRedeploy = async (provider: ProviderId, install: SkillInstallView) => {
    const where = install.projectName ?? install.projectPath ?? text("개인", "personal");
    const proceed = await confirm({
      title: text("원본 배포", "Deploy source"),
      message: text(
        `보관 원본을 ${providerLabel(provider)}(${where})에 다시 배포할까요?`,
        `Redeploy the archived source to ${providerLabel(provider)} (${where})?`,
      ),
      warning: text("그 자리의 사본은 원본 내용으로 덮입니다.", "The copy at that location is replaced by the source."),
      confirmLabel: text("배포", "Deploy"),
      tone: "danger",
    });
    if (!proceed) return;
    await runBusy("redeploy", async () => {
      const receipt = await publishCommonSkill({
        key: entry.key,
        providers: [provider],
        overwrite: "replace",
        location: installLocation(install),
      });
      const failure = receipt.results.find((result) => result.outcome === "failed");
      if (failure) {
        setActionError(failure.message ?? text("배포에 실패했습니다.", "Failed to deploy the source."));
        return;
      }
      onChanged(text(
        `'${entry.key}'의 보관 원본을 ${providerLabel(provider)}(${where})에 배포했습니다.`,
        `Deployed the archived source of '${entry.key}' to ${providerLabel(provider)} (${where}).`,
      ));
    });
  };

  /** 외부에서 수정된 사용본을 새 원본으로 채택하고 나머지 위치에 재배포한다. */
  const runSync = async (install: SkillInstallView) => {
    await runBusy("sync", async () => {
      const receipt = await syncSkillFromInstall(install.skillId);
      onChanged(text(
        `'${entry.key}'을 수정본으로 동기화했습니다. 이전 원본은 휴지통에 있습니다.`,
        `Synced '${entry.key}' to the edited install. The previous source is in the trash.`,
      ));
      void receipt;
    });
  };

  /**
   * 갈라진 자리 전부를 가장 나중에 고쳐진 버전으로 맞춘다. 방향 판정은 사람이 하지 않고
   * 수정 시각이 정하므로(`latestSkillVersion`), 어느 쪽이 이겼는지와 나머지가 어떻게
   * 되는지를 확인 문구에 적어 누르기 전에 보이게 한다.
   */
  const runApplyLatest = async (
    latest: SkillLatestVersion,
    divergents: readonly SkillDivergentInstall[],
  ) => {
    if (latest.kind === "unknown" || divergents.length === 0) return;
    const winner = latest.kind === "source"
      ? text("보관 원본", "the archived source")
      : `${providerLabel(latest.provider)} · ${displayPath(latest.install.directory)}`;
    const proceed = await confirm({
      title: text("최신본으로 통일", "Apply the newest version"),
      message: text(
        `가장 나중에 고쳐진 ${winner}를 기준으로 '${entry.key}'의 갈라진 자리 ${divergents.length}곳을 맞출까요?`,
        `Align ${divergents.length} diverged location(s) of '${entry.key}' with ${winner}, the most recently modified version?`,
      ),
      warning: latest.kind === "source"
        ? text("나머지 사용본의 내용은 원본으로 덮입니다.", "The other installs are replaced by the source.")
        : text(
            "그 사용본이 새 원본이 되고 나머지 자리에 배포됩니다. 이전 원본은 휴지통으로 이동합니다.",
            "That install becomes the new source and is deployed elsewhere. The previous source moves to the trash.",
          ),
      confirmLabel: text("통일", "Apply"),
      tone: "danger",
    });
    if (!proceed) return;
    await runBusy("latest", async () => {
      if (latest.kind === "source") {
        await redeployToInstalls(entry.key, divergents);
        onChanged(text(
          `'${entry.key}'의 갈라진 자리를 보관 원본으로 맞췄습니다.`,
          `Aligned the diverged locations of '${entry.key}' with the archived source.`,
        ));
        return;
      }
      await syncSkillFromInstall(latest.install.skillId);
      onChanged(text(
        `'${entry.key}'을 ${providerLabel(latest.provider)}의 최신 사용본으로 맞췄습니다. 이전 원본은 휴지통에 있습니다.`,
        `Aligned '${entry.key}' with the newest install from ${providerLabel(latest.provider)}. The previous source is in the trash.`,
      ));
    });
  };

  /** 편집기가 모은 변경분을 저장하고 사용 위치에 재배포한다. 바꿀 것이 없으면
   * 요청을 보내지 않고 편집기만 닫는다. */
  const saveEdits = async (files: SkillFileEdit[], deletes: string[]) => {
    const common = entry.common;
    if (!common) return;
    if (files.length === 0 && deletes.length === 0) {
      setEditing(false);
      return;
    }
    await runBusy("save", async () => {
      const receipt = await updateCommonSkill({
        key: entry.key,
        files,
        deletes,
        expectedDigest: common.contentDigest,
      });
      setEditing(false);
      onChanged(text(
        `'${entry.key}'을 저장하고 사용 위치에 재배포했습니다: ${publishSummary(receipt, text) || text("재배포 대상 없음", "no deployments")}`,
        `Saved '${entry.key}' and redeployed: ${publishSummary(receipt, text) || "no deployments"}`,
      ));
    });
  };

  const requestPlatformMigration = async () => {
    if (!onRequestAiaPrompt || !entry.common || !entry.migrationRequired) return;
    await runBusy("migration", async () => {
      const plan = await getSkillMigrationPlan(entry.key, currentPlatform);
      onRequestAiaPrompt(plan.aiaPrompt);
      onChanged(text(
        "AIA 입력창에 현재 OS용 스킬 마이그레이션 요청을 넣었습니다.",
        "Added the current-OS skill migration request to the AIA composer.",
      ));
    });
  };

  const savePlatformMetadata = async () => {
    const common = entry.common;
    if (!common) return;
    await runBusy("platforms", async () => {
      await setSkillPlatforms({
        key: entry.key,
        platforms: selectedPlatforms,
        expectedDigest: common.contentDigest,
      });
      onChanged(text(
        "지원 OS 메타데이터를 저장하고 현재 사용 위치를 다시 확인했습니다.",
        "Saved supported-OS metadata and rechecked current deployments.",
      ));
    });
  };

  const importable = importableProvider(entry);

  const divergentInstalls = divergentManagedInstalls(entry);

  return (
    <>
    <Drawer
      title={<>{(syncState === "conflict" || syncState === "stale") && <span className={`skill-sync-pill ${syncState}`}>{skillSyncLabel(syncState, text)}</span>}<span data-user-content>{translated?.name ?? entry.name}</span></>}
      actions={translationId && (
        <TranslateResourceButton
          menu="skills"
          resourceId={translationId}
          translated={Boolean(translated)}
          automation={automation}
          onAutomationChange={onAutomationChange}
        />
      )}
      onClose={onClose}
    >
      {actionError && <ErrorBanner message={actionError} />}
      {detailError && <ErrorBanner message={detailError} />}

      <section className="detail-card meta-grid">
        <DetailInfo mono title label={text("이름", "Key")} value={entry.key} />
        <DetailInfo mono title label={text("원본", "Origin")} value={entry.common?.directory ? displayPath(entry.common.directory) : text("보관 원본 없음", "Not archived")} />
        <DetailInfo mono title label={text("출처", "Source")} value={entry.origin
          ? (entry.origin.scope === "project"
            ? `${providerLabel(entry.origin.provider)} · ${displayPath(entry.origin.projectName ?? entry.origin.projectPath ?? "")}`
            : `${providerLabel(entry.origin.provider)} · ${text("개인", "Personal")}`)
          : text("기록 없음", "Not recorded")} />
        <DetailInfo mono title label={text("내용 지문", "Digest")} value={entry.common?.contentDigest.slice(0, 12) ?? "-"} />
        <DetailInfo mono title
          label={text("지원 OS", "Supported OS")}
          value={entry.platforms.length > 0 ? entry.platforms.join(", ") : text("전체", "All")}
        />
      </section>

      {entry.common && (
        <section className="detail-card">
          <div className="section-title"><h3>{text("OS 호환성", "OS compatibility")}</h3></div>
          <PlatformSupportFields
            description={text(
              "base 원본을 그대로 사용할 OS를 선택하세요. 아무것도 선택하지 않으면 모든 OS에서 사용하는 portable 스킬입니다.",
              "Select the platforms that can use the base source as-is. No selection means the skill is portable across all platforms.",
            )}
            platforms={selectedPlatforms}
            saved={entry.platforms}
            disabled={busy !== null}
            saving={busy === "platforms"}
            onPlatformsChange={setSelectedPlatforms}
            onSave={() => { void savePlatformMetadata(); }}
            migration={entry.migrationRequired ? {
              note: text(
                `현재 OS(${currentPlatform})에서 사용할 변형이 없습니다. AIA가 변환 파일을 만들 수 있지만 생성된 스크립트나 명령은 자동 실행하지 않습니다.`,
                `No variant is available for the current OS (${currentPlatform}). AIA can create converted files, but generated scripts or commands are never run automatically.`,
              ),
              disabled: !onRequestAiaPrompt,
              busy: busy === "migration",
              onRequest: () => { void requestPlatformMigration(); },
            } : null}
          />
        </section>
      )}

      {translated?.description && (
        <section className="detail-card">
          <div className="section-title"><h3>{text("설명", "Description")}</h3></div>
          <p className="prose-copy" data-user-content>{translated.description}</p>
        </section>
      )}

      {!entry.common && (
        <section className="detail-card">
          <div className="section-title"><h3>{text("스킬보관", "Archive skill")}</h3></div>
          <p className="prose-copy">{importable
            ? text(
                "스킬보관하면 보관 저장소에 원본이 생기고 다른 에이전트·프로젝트에서도 사용 여부로 켤 수 있습니다. 기존 설치본은 그대로 남아 사용 중으로 표시됩니다.",
                "Archiving creates the source in the archive store so other agents and projects can turn it on. The existing install stays and shows as in use.",
              )
            : text(
                "에이전트·플러그인이 소유한 내장 스킬은 보관할 수 없습니다.",
                "Agent- or plugin-owned built-in skills cannot be archived.",
              )}</p>
          {importable && (
            <div className="form-actions">
              <button className="button primary" type="button" disabled={busy !== null} onClick={() => { void runImport(importable.skillId as string); }}>
                <FolderInput size={13} aria-hidden="true" />{busy === "import" ? text("보관 중…", "Archiving…") : text("스킬보관", "Archive skill")}
              </button>
            </div>
          )}
        </section>
      )}

      {entry.common && (
        <SkillLocationMatrixSection
          entry={entry}
          projects={projects}
          useBusy={useBusy}
          busy={busy}
          onSetUse={onSetUse}
          onToggleAutoSync={onToggleAutoSync}
        />
      )}

      {entry.common && divergentInstalls.length > 0 && (
        <SkillDivergentSection
          divergentInstalls={divergentInstalls}
          latest={latestSkillVersion(entry.common.modifiedAtMs, divergentInstalls)}
          onApplyLatest={(latest) => { void runApplyLatest(latest, divergentInstalls); }}
          useBusy={useBusy}
          busy={busy}
          onSync={(install) => { void runSync(install); }}
          onRedeploy={(provider, install) => { void runRedeploy(provider, install); }}
        />
      )}

      {entry.common && (
        <section className="detail-card">
          <div className="section-title">
            <h3>{text("편집", "Edit")}</h3>
            {!editing && (
              <button className="button compact" type="button" disabled={!detail || busy !== null} onClick={() => setEditing(true)}>
                {text("직접 편집", "Edit files")}
              </button>
            )}
          </div>
          {editing && detail && (
            <SkillFileEditor
              skillKey={entry.key}
              detail={detail}
              translatedBody={translated?.body}
              saving={busy === "save"}
              disabled={busy !== null}
              onError={setActionError}
              onCancel={() => setEditing(false)}
              onSave={(files, deletes) => { void saveEdits(files, deletes); }}
            />
          )}
          {onRequestAiaPrompt && entry.common && (
            <SkillAiaEditCard directory={entry.common.directory} onRequestAiaPrompt={onRequestAiaPrompt} />
          )}
        </section>
      )}

      {entry.common && (
        <section className="detail-card">
          <div className="section-title"><h3>{text("보관취소·삭제", "Unarchive or delete")}</h3></div>
          <p className="prose-copy">{text(
            "보관취소는 보관 원본만 휴지통으로 옮기고 에이전트 사용본은 그대로 둡니다. 삭제는 보관 원본과 모든 에이전트 사용본(프로젝트 저장소 포함)을 함께 옮깁니다. 둘 다 휴지통에서 그룹 단위로 복구할 수 있습니다.",
            "Unarchiving moves only the archived source to the trash and leaves every agent install in place. Deleting moves the source and every agent install (including project repositories) together. Both can be restored from the trash as a group.",
          )}</p>
          <div className="form-actions">
            <button className="button" type="button" disabled={busy !== null} onClick={() => { void runUnarchive(); }}>
              <ArchiveX size={13} aria-hidden="true" />{busy === "unarchive" ? text("보관취소 중…", "Unarchiving…") : text("보관취소", "Unarchive")}
            </button>
            <button className="button danger-subtle" type="button" disabled={busy !== null} onClick={() => { void runDelete(); }}>
              <Trash2 size={13} aria-hidden="true" />{busy === "delete" ? text("삭제 중…", "Deleting…") : text("스킬삭제", "Delete skill")}
            </button>
          </div>
        </section>
      )}

      {detail && !editing && (
        <section className="detail-card">
          <div className="section-title"><h3>SKILL.md</h3></div>
          <MarkdownPreview source={detail.body} compact />
        </section>
      )}
    </Drawer>
    {confirmDialog}
    </>
  );
}

/**
 * 보관 스킬의 위치별·에이전트별 사용 설정 표. 개인과 등록 프로젝트 행을 모으고
 * 미지원 에이전트를 뺀 공급자 열을 세워 사용 체크박스 행렬과 자동 동기화 토글을 그린다.
 */
function SkillLocationMatrixSection({
  entry,
  projects,
  useBusy,
  busy,
  onSetUse,
  onToggleAutoSync,
}: {
  entry: SkillLibraryEntry;
  projects: readonly SkillProjectView[];
  useBusy: string | null;
  busy: SkillDrawerBusy | null;
  onSetUse: (state: SkillProviderState, enabled: boolean, location: SkillLocation) => void;
  onToggleAutoSync: (autoSync: boolean) => void;
}) {
  const { text } = useI18n();
  const locations: { key: string; label: string; location: SkillLocation }[] = [
    { key: "personal", label: text("개인", "Personal"), location: { scope: "personal" } },
    ...projects.map((project) => ({
      key: project.path,
      label: project.name,
      location: { scope: "project" as const, projectPath: project.path },
    })),
  ];
  const matrixProviders = entry.providers.filter((state) => state.status !== "unsupported");

  return (
    <section className="detail-card">
      <div className="section-title"><h3>{text("사용 설정", "Agent use")}</h3></div>
      <p className="prose-copy">{text(
        "위치별로 에이전트 사용 여부를 켜고 끕니다. 해제된 사용본은 휴지통으로 이동합니다.",
        "Turn agent use on or off per location. Disabled installs move to the trash.",
      )}</p>
      <LocationProviderMatrix
        locationHeader={text("위치", "Location")}
        columns={matrixProviders}
        columnProvider={(state) => state.provider}
        rows={locations}
        cell={(row, state) => {
          const install = installAt(state, row.location);
          return (
            <SkillUseToggle
              used={Boolean(install)}
              divergent={Boolean(install?.divergent)}
              divergence={install?.divergence ?? null}
              title={install?.divergent ? skillDivergenceHint(install.divergence, text) : undefined}
              disabled={useBusy !== null || busy !== null}
              onChange={(checked) => onSetUse(state, checked, row.location)}
            />
          );
        }}
      />
      <div className="skill-use-matrix">
        <SkillAutoSyncToggle autoSync={entry.autoSync} disabled={useBusy !== null || busy !== null} onChange={onToggleAutoSync} />
      </div>
    </section>
  );
}

/**
 * 보관 원본과 내용이 갈라진 사용본 목록. 각 사본의 차이 비교(열림/닫힘)와 조치 버튼을
 * 서랍 본체와 분리한다.
 *
 * 조치는 방향에 따라 반대다. 예전에는 두 방향을 "외부 수정 감지" 한 이름으로 부르고
 * 버튼도 "이 버전으로 동기화" 하나만 두어서, 배포가 덜 된 뒤처진 사본에도 그 버튼이
 * 유일한 출구로 보였다 — 누르면 옛 사본이 새 원본이 되어 최신 내용이 휴지통으로 갔다.
 * 그래서 뒤처진 사본에는 원본 재배포를 먼저 세우고, 채택 버튼은 그 뒤에 남긴다.
 */
function SkillDivergentSection({
  divergentInstalls,
  useBusy,
  busy,
  latest,
  onSync,
  onRedeploy,
  onApplyLatest,
}: {
  divergentInstalls: readonly SkillDivergentInstall[];
  useBusy: string | null;
  busy: SkillDrawerBusy | null;
  /** 갈라진 자리 중 가장 나중에 고쳐진 쪽. 한 번에 통일할 때의 기준이다. */
  latest: SkillLatestVersion;
  onSync: (install: SkillInstallView) => void;
  onRedeploy: (provider: ProviderId, install: SkillInstallView) => void;
  onApplyLatest: (latest: SkillLatestVersion) => void;
}) {
  const { text } = useI18n();
  const [compareSkillId, setCompareSkillId] = useState<string | null>(null);
  const disabled = busy !== null || useBusy !== null;
  const latestLabel = latest.kind === "install"
    ? `${providerLabel(latest.provider)} ${text("사용본", "install")}`
    : text("보관 원본", "archived source");

  return (
    <section className="detail-card">
      <div className="section-title">
        <h3>{text("원본과 다른 사용본", "Installs differing from the source")}</h3>
        <div className="section-title-actions">
          {/* 자리마다 방향을 읽고 버튼을 고르는 대신, 수정 시각이 정한 최신본으로 한 번에
              맞춘다. 시각을 모르는 자리가 섞이면 고를 근거가 없어 누를 수 없게 둔다. */}
          <button
            className="button compact primary"
            type="button"
            disabled={disabled || latest.kind === "unknown"}
            title={latest.kind === "unknown"
              ? text(
                  "수정 시각을 읽지 못한 자리가 있어 최신본을 고를 수 없습니다. 변경 내용을 보고 직접 정하세요.",
                  "Some locations have no readable modification time, so the newest version cannot be chosen. Compare the changes and decide manually.",
                )
              : text(`기준: ${latestLabel}`, `Basis: ${latestLabel}`)}
            onClick={() => onApplyLatest(latest)}
          >
            <ArrowUpFromLine size={13} aria-hidden="true" />
            {busy === "latest" ? text("맞추는 중…", "Applying…") : text("최신본으로 통일", "Apply the newest")}
          </button>
        </div>
      </div>
      <p className="prose-copy">{text(
        "아래 사용본이 보관 원본과 다릅니다. 뒤처진 사본은 원본을 다시 배포하면 맞춰지고, 원본보다 나중에 수정된 사본은 채택할지 정해야 합니다. 채택하면 그 버전이 원본이 되고 나머지 위치에 재배포되며, 이전 원본은 휴지통으로 이동합니다.",
        "These installs differ from the archived source. An out-of-date copy is fixed by redeploying the source; a copy edited after the source needs a decision. Adopting one makes it the source, redeploys it everywhere else, and moves the previous source to the trash.",
      )}</p>
      <div className="skill-divergent-list">
        {divergentInstalls.map(({ provider, install }) => {
          const stale = install.divergence === "behind";
          return (
          <div className="skill-divergent-item" key={install.skillId}>
            <div className="skill-divergent-row">
              <SourceBadge source={provider} />
              <span className={`skill-sync-pill ${stale ? "stale" : "conflict"}`}>
                {skillDivergenceLabel(install.divergence, text)}
              </span>
              <code>{displayPath(install.directory)}</code>
              <button
                className={`button compact${compareSkillId === install.skillId ? " active" : ""}`}
                type="button"
                aria-expanded={compareSkillId === install.skillId}
                onClick={() => setCompareSkillId(compareSkillId === install.skillId ? null : install.skillId)}
              >
                <FileDiff size={13} aria-hidden="true" />{compareSkillId === install.skillId ? text("변경 내용 닫기", "Hide changes") : text("변경 내용 보기", "Show changes")}
              </button>
              {stale && (
                <button className="button compact primary" type="button" disabled={disabled} onClick={() => onRedeploy(provider, install)}>
                  <Send size={13} aria-hidden="true" />{busy === "redeploy" ? text("배포 중…", "Deploying…") : text("원본 배포", "Deploy source")}
                </button>
              )}
              <button
                className="button compact"
                type="button"
                disabled={disabled}
                title={stale
                  ? text(
                      "뒤처진 사본을 새 원본으로 채택합니다. 더 새로운 원본 내용은 휴지통으로 갑니다.",
                      "Adopts the out-of-date copy as the new source. The newer source content moves to the trash.",
                    )
                  : undefined}
                onClick={() => onSync(install)}
              >
                <RefreshCw size={13} aria-hidden="true" />{busy === "sync" ? text("동기화 중…", "Syncing…") : text("이 버전으로 동기화", "Sync to this version")}
              </button>
            </div>
            <small className="skill-divergent-hint">
              {skillDivergenceHint(install.divergence, text)}
              {install.modifiedAtMs !== null && ` · ${text("사본 수정", "install modified")} ${formatDate(install.modifiedAtMs)}`}
            </small>
            {compareSkillId === install.skillId && (
              <SkillInstallDiff skillId={install.skillId} refreshKey={install.contentDigest} />
            )}
          </div>
          );
        })}
      </div>
    </section>
  );
}

interface SkillFileEdit {
  path: string;
  content: string;
}

/** 보관 원본의 파일 목록을 편집기 탭 순서로 편다. SKILL.md는 없더라도 만들어 맨 앞에 둔다. */
function editorPathsOf(detail: CommonSkillDetail): string[] {
  const paths: string[] = [];
  const walk = (nodes: CommonSkillDetail["files"]) => {
    for (const node of nodes) {
      if (node.isDirectory) walk(node.children);
      else paths.push(node.relativePath);
    }
  };
  walk(detail.files);
  if (!paths.includes("SKILL.md")) paths.unshift("SKILL.md");
  return paths.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)));
}

/** React 상태의 경로 집합을 직접 바꾸지 않고 포함 여부만 바꾼 새 집합을 만든다. */
function withPathMembership(paths: Set<string>, path: string, included: boolean): Set<string> {
  const next = new Set(paths);
  if (included) next.add(path);
  else next.delete(path);
  return next;
}

/**
 * 보관 원본의 파일 편집기. 열려 있는 동안의 탭 목록·지연 로드한 본문·변경/삭제 표시를
 * 이 컴포넌트가 전부 들고, 서랍에는 저장 요청만 넘긴다. 서랍이 편집기 상태 6개를
 * 함께 쥐고 있으면 열기 함수가 그 전부를 초기화해야 하고, 닫을 때 남은 값이 다음 편집에
 * 새어 나올 여지가 생긴다. 닫으면 언마운트되므로 상태는 항상 원본에서 새로 시작한다.
 */
function SkillFileEditor({ skillKey, detail, translatedBody, saving, disabled, onError, onCancel, onSave }: {
  skillKey: string;
  detail: CommonSkillDetail;
  translatedBody?: string;
  saving: boolean;
  disabled: boolean;
  onError: (message: string) => void;
  onCancel: () => void;
  onSave: (files: SkillFileEdit[], deletes: string[]) => void;
}) {
  const { text } = useI18n();
  const [paths, setPaths] = useState<string[]>(() => editorPathsOf(detail));
  const [activePath, setActivePath] = useState("SKILL.md");
  const [contents, setContents] = useState<Record<string, string>>({ "SKILL.md": detail.body });
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [deletePaths, setDeletePaths] = useState<Set<string>>(new Set());
  const [newFileName, setNewFileName] = useState("");

  const selectFile = async (path: string) => {
    setActivePath(path);
    if (contents[path] !== undefined) return;
    try {
      const file = await readCommonSkillFile(skillKey, path);
      setContents((current) => ({ ...current, [path]: file.content }));
    } catch (cause) {
      onError(errorText(cause));
    }
  };

  const addFile = () => {
    const name = newFileName.trim();
    if (!name || paths.includes(name)) return;
    setPaths((current) => [...current, name]);
    setContents((current) => ({ ...current, [name]: "" }));
    setDirtyPaths((current) => withPathMembership(current, name, true));
    setDeletePaths((current) => withPathMembership(current, name, false));
    setActivePath(name);
    setNewFileName("");
  };

  const removeFile = (path: string) => {
    if (path === "SKILL.md") return;
    setDeletePaths((current) => withPathMembership(current, path, true));
    setDirtyPaths((current) => withPathMembership(current, path, false));
    setPaths((current) => current.filter((item) => item !== path));
    if (activePath === path) setActivePath("SKILL.md");
  };

  const submit = () => {
    onSave(
      [...dirtyPaths]
        .filter((path) => !deletePaths.has(path))
        .map((path) => ({ path, content: contents[path] ?? "" })),
      [...deletePaths],
    );
  };

  return (
    <div className="skill-editor">
      <div className="skill-editor-files">
        {paths.map((path) => (
          <div className={`skill-editor-file${path === activePath ? " active" : ""}`} key={path}>
            <button type="button" onClick={() => { void selectFile(path); }}>{path}</button>
            {path !== "SKILL.md" && (
              <button type="button" className="skill-editor-remove" title={text("파일 삭제", "Delete file")} onClick={() => removeFile(path)}>×</button>
            )}
          </div>
        ))}
        <div className="skill-editor-add">
          <input value={newFileName} onChange={(event) => setNewFileName(event.target.value)} placeholder={text("새 파일 경로", "New file path")} />
          <button className="button compact" type="button" onClick={addFile} disabled={!newFileName.trim()}>{text("추가", "Add")}</button>
        </div>
      </div>
      <div className="skill-editor-body">
        <textarea
          value={contents[activePath] ?? ""}
          spellCheck={false}
          onChange={(event) => {
            const value = event.target.value;
            setContents((current) => ({ ...current, [activePath]: value }));
            setDirtyPaths((current) => withPathMembership(current, activePath, true));
          }}
        />
        {activePath === "SKILL.md" && translatedBody && (
          <details className="skill-editor-translation">
            <summary>{text("한국어 번역 참조", "Korean translation reference")}</summary>
            <MarkdownPreview source={translatedBody} compact />
          </details>
        )}
        <div className="form-actions">
          <button className="button" type="button" disabled={disabled} onClick={onCancel}>{text("취소", "Cancel")}</button>
          <button className="button primary" type="button" disabled={disabled} onClick={submit}>
            {saving ? text("저장 중…", "Saving…") : text("저장 후 재배포", "Save and redeploy")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 보관 원본 수정을 AIA에게 맡기는 입력 칸. 작성 중인 지시문은 이 칸만 들고 있다. */
function SkillAiaEditCard({ directory, onRequestAiaPrompt }: {
  directory: string;
  onRequestAiaPrompt: (prompt: string) => void;
}) {
  const { text } = useI18n();
  const [instruction, setInstruction] = useState("");

  const request = () => {
    const trimmed = instruction.trim();
    if (!trimmed) return;
    onRequestAiaPrompt([
      text("스킬 보관 원본을 수정해주세요.", "Please edit the archived skill source."),
      `${text("대상 디렉터리:", "Target directory:")} ${directory}`,
      `${text("요청:", "Request:")} ${trimmed}`,
      text(
        "규칙: 원문 언어와 문체를 유지하고 SKILL.md frontmatter 형식을 깨지 마세요. 대상 디렉터리 밖의 파일은 변경하지 마세요.",
        "Rules: Keep the original language and tone, and do not break the SKILL.md frontmatter format. Do not change files outside the target directory.",
      ),
      text(
        "완료 후 무엇을 바꿨는지 요약해 주세요. 수정본은 스킬관리 화면에서 확인 후 사용 위치에 재배포됩니다.",
        "After completion, summarize what was changed. The modified version will be redeployed to install locations after review in the Skill Manager.",
      ),
    ].join("\n"));
    setInstruction("");
  };

  return (
    <div className="skill-editor-aia">
      <p className="prose-copy">{text(
        "원문이 다른 언어라 직접 고치기 어렵다면, 한국어로 수정 내용을 적어 AIA에게 맡기세요. 원문 언어와 문체를 유지하며 수정합니다.",
        "If the source language is hard to edit directly, describe the change in your own language and delegate it to AIA. It edits while keeping the original language and style.",
      )}</p>
      <textarea
        value={instruction}
        rows={2}
        placeholder={text("예: 트리거 조건에 ○○ 상황을 추가해줘", "e.g. add the ○○ case to the trigger conditions")}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <div className="form-actions">
        <button className="button compact" type="button" disabled={!instruction.trim()} onClick={request}>
          {text("AIA에게 수정 요청", "Ask AIA to edit")}
        </button>
      </div>
    </div>
  );
}

/** 스킬 휴지통. 삭제·사용 해제·동기화로 옮겨진 실체를 복구하거나 비운다. */
/**
 * 같이 지워진 그룹의 크기를 항목마다 돌려준다. 스킬 휴지통과 지침 휴지통은 둘 다 한 번의
 * 삭제가 여러 실체를 한 `groupId`로 묶어 넣고(skill_trash.rs·instruction_trash.rs), 행 하나의
 * '복구'가 같은 그룹의 다른 행까지 되살린다. 그 사실을 알리는 집계가 두 화면에 같은 모양으로
 * 있어 한곳에 둔다. 목록이 아직 없으면(읽는 중) 모든 항목이 0으로 나온다.
 */
export function useTrashGroupSizes<T extends { groupId: string }>(items: readonly T[] | undefined): (item: T) => number {
  const sizes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items ?? []) counts.set(item.groupId, (counts.get(item.groupId) ?? 0) + 1);
    return counts;
  }, [items]);
  return (item) => sizes.get(item.groupId) ?? 0;
}

/**
 * 휴지통 행 하나의 껍데기. 두 휴지통이 같은 `skill-trash-*` 클래스 계층과 같은 그룹 배지를
 * 각자 적고 있었다 — 한쪽 마크업만 손보면 두 화면의 생김새가 조용히 갈라지는 모양이라
 * 껍데기를 여기 두고 머리줄 내용과 단추만 화면이 채운다. 그룹 배지는 항상 머리줄 끝에 선다.
 */
export function TrashRow({ groupSize, path, actions, children }: {
  groupSize: number;
  path: string;
  actions: ReactNode;
  children: ReactNode;
}) {
  const { text } = useI18n();
  return (
    <div className="skill-trash-row">
      <div className="skill-trash-main">
        <div className="skill-trash-head">
          {children}
          {groupSize > 1 && <small>{text(`그룹 ${groupSize}개 항목`, `group of ${groupSize}`)}</small>}
        </div>
        <code>{path}</code>
      </div>
      <div className="skill-trash-actions">{actions}</div>
    </div>
  );
}

function SkillTrashDrawer({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [overview, setOverview] = useState<SkillTrashOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 휴지통의 열쇠는 누른 항목의 id(전체 비우기는 "all")라 정해진 이름으로 셀 수 없다.
  const [busy, setBusy] = useState<string | null>(null);
  const runBusy = busyRunner<string>(setBusy, setError);

  const load = useCallback(async () => {
    try {
      setOverview(await listSkillTrash());
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const groupSize = useTrashGroupSizes(overview?.items);

  const runRestore = async (item: SkillTrashItem) => {
    await runBusy(item.id, async () => {
      const receipt = await restoreSkillTrash(item.id);
      const restored = receipt.results.filter((result) => result.outcome === "restored").length;
      const skipped = receipt.results.filter((result) => result.outcome === "skipped").length;
      const skippedNote = skipped > 0
        ? text(`, ${skipped}개는 경로가 사용 중이라 건너뜀`, `, ${skipped} skipped (path occupied)`)
        : "";
      onChanged(
        text(`'${item.key}' 복구: ${restored}개 복원`, `Restored '${item.key}': ${restored} item(s)`)
        + skippedNote,
      );
      await load();
    });
  };

  const runPurge = async (item: SkillTrashItem | null) => {
    const proceed = await confirm({
      title: item ? text("휴지통 항목 영구 삭제", "Delete permanently") : text("휴지통 비우기", "Empty trash"),
      message: item
        ? text(`'${item.key}' 휴지통 항목을 영구 삭제할까요?`, `Permanently delete '${item.key}' from the trash?`)
        : text("휴지통을 비울까요? 모든 항목이 영구 삭제됩니다.", "Empty the trash? Every item is permanently deleted."),
      warning: text("복구할 수 없습니다.", "This cannot be undone."),
      confirmLabel: text("영구 삭제", "Delete permanently"),
      tone: "danger",
    });
    if (!proceed) return;
    await runBusy(item?.id ?? "all", async () => {
      const removed = await purgeSkillTrash(item?.id);
      onChanged(text(`휴지통에서 ${removed}개 항목을 영구 삭제했습니다.`, `Permanently deleted ${removed} trash item(s).`));
      await load();
    });
  };

  const describeLocation = (item: SkillTrashItem) => {
    if (!item.provider) return text("보관 원본", "Archived source");
    const where = item.scope === "project"
      ? (item.originalPath.split("/").slice(-4, -3)[0] ?? text("프로젝트", "project"))
      : text("개인", "personal");
    return `${providerLabel(item.provider)} · ${where}`;
  };

  return (
    <>
    <Drawer title={<span>{text("스킬 휴지통", "Skill trash")}</span>} onClose={onClose}>
      {error && <ErrorBanner message={error} />}
      <section className="detail-card">
        <div className="section-title">
          <h3>{text("항목", "Items")}</h3>
          <span>{overview ? text(`${overview.items.length}개 · ${(overview.totalBytes / 1024).toFixed(0)}KB`, `${overview.items.length} · ${(overview.totalBytes / 1024).toFixed(0)}KB`) : ""}</span>
        </div>
        <p className="prose-copy">{text(
          "삭제·사용 해제·동기화로 옮겨진 실체입니다. 복구는 함께 삭제된 그룹 전체를 원래 경로로 되돌리며, 경로에 새 항목이 있으면 덮어쓰지 않습니다.",
          "Items moved here by delete, disable, or sync. Restore returns the whole deleted group to its original paths and never overwrites newer items.",
        )}</p>
        {!overview ? (
          <LoadingState label={text("휴지통을 읽고 있습니다", "Reading the trash")} />
        ) : overview.items.length === 0 ? (
          <p className="prose-copy">{text("휴지통이 비어 있습니다.", "The trash is empty.")}</p>
        ) : (
          <div className="skill-trash-list">
            {overview.items.map((item) => (
              <TrashRow
                key={item.id}
                groupSize={groupSize(item)}
                path={item.originalPath}
                actions={<>
                  <button className="button compact" type="button" disabled={busy !== null} onClick={() => { void runRestore(item); }}>
                    {busy === item.id ? text("복구 중…", "Restoring…") : text("복구", "Restore")}
                  </button>
                  <button className="button danger-subtle compact" type="button" disabled={busy !== null} onClick={() => { void runPurge(item); }}>
                    {text("영구 삭제", "Delete")}
                  </button>
                </>}
              >
                <strong>{item.key}</strong>
                <span className="scope-pill">{describeLocation(item)}</span>
                {item.kind === "link" && <span className="scope-pill">{text("링크", "link")}</span>}
                <small>{formatDateTime(item.deletedAtMs)}</small>
              </TrashRow>
            ))}
          </div>
        )}
        {overview && overview.items.length > 0 && (
          <div className="form-actions">
            <button className="button danger-subtle" type="button" disabled={busy !== null} onClick={() => { void runPurge(null); }}>
              <Trash2 size={13} aria-hidden="true" />{text("휴지통 비우기", "Empty trash")}
            </button>
          </div>
        )}
      </section>
    </Drawer>
    {confirmDialog}
    </>
  );
}

/**
 * 저장된 JSON 한 건. 저장소가 막혀 읽지 못한 경우와 저장값이 깨져 해석되지 않는 경우를
 * 저장된 적 없는 것(`null`)으로 같이 본다 — 부르는 쪽은 모르는 값을 이미 기본값으로
 * 되돌리므로, 두 경우를 갈라 봐야 할 이유가 없다. 화면 선택을 기억하는 자리마다
 * `JSON.parse`를 각자 try/catch로 감싸면 그중 한 벌이 빠졌을 때 저장값 하나가 앱 셸을
 * 오류 경계로 떨어뜨리므로, 해석 실패를 삼키는 자리를 여기 한 벌만 둔다.
 */
export function readStoredJson(key: string): unknown {
  const raw = readStoredText(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 저장소에 기억해 두는 낱값 선택 하나(보기 모드처럼 정해진 값 중 하나). 읽을 때 아는 값인지
 * 보고 모르면 기본값으로 떨어지는 규칙과, 고를 때마다 도로 적어 두는 효과가 한 벌로 붙어
 * 다닌다 — 둘을 각 화면이 따로 적으면 키를 올려 예전 선택을 버리려 할 때 한쪽만 고쳐도
 * 조용히 통과한다. 첫 렌더에서 한 번 되적는 것은 이전 모양 그대로다.
 */
export function useStoredChoice<V extends string>(
  key: string,
  values: readonly V[],
  fallback: V,
): [V, Dispatch<SetStateAction<V>>] {
  const [value, setValue] = useState<V>(() => {
    const stored = readStoredText(key);
    return values.includes(stored as V) ? stored as V : fallback;
  });
  useEffect(() => {
    writeStoredText(key, value);
  }, [key, value]);
  return [value, setValue];
}

/**
 * 저장소에 기억해 두는 필터 묶음. 축마다 아는 값이 다르므로 해석은 화면이 준 `parse`에
 * 맡기고, 저장 형식(JSON 한 줄)과 되적는 시점만 여기서 정한다.
 */
export function useStoredFilters<F extends object>(
  key: string,
  parse: (stored: Partial<F> | null) => F,
): [F, Dispatch<SetStateAction<F>>] {
  const [filters, setFilters] = useState<F>(() => parse(readStoredJson(key) as Partial<F> | null));
  useEffect(() => {
    writeStoredText(key, JSON.stringify(filters));
  }, [key, filters]);
  return [filters, setFilters];
}

function parseLibraryFilters(stored: Partial<SkillLibraryFilters> | null): SkillLibraryFilters {
  return {
    kind: SKILL_KIND_VALUES.includes(stored?.kind as SkillKindFilter) ? stored?.kind as SkillKindFilter : "all",
    state: SKILL_STATE_VALUES.includes(stored?.state as SkillStateFilter) ? stored?.state as SkillStateFilter : "all",
    agent: SKILL_AGENT_VALUES.includes(stored?.agent as SkillAgentFilter) ? stored?.agent as SkillAgentFilter : "all",
    origin: typeof stored?.origin === "string"
      && (["all", "personal", "project"].includes(stored.origin) || stored.origin.startsWith("project:"))
      ? stored.origin
      : "all",
  };
}

/**
 * OS 이름 표기. 스킬·지침 두 화면이 같은 세 줄을 각자 들고 있었다. 타입상 세 값뿐이지만
 * 변형 경로에서 온 문자열을 그대로 넘기는 자리가 있어, 모르는 값은 안내 문구로 떨어진다.
 */
export function platformLabel(platform: HostPlatform, text: UiText): string {
  switch (platform) {
    case "macos": return "macOS";
    case "windows": return "Windows";
    case "linux": return "Linux";
    default: return text("알 수 없음", "Unknown");
  }
}

/**
 * 목록 검색어 판정 한 벌. 스킬보관함·설치된 스킬·에이전트·산출물 네 목록이 모두 "원문
 * 필드와 번역 필드를 한 줄에 모아 소문자 부분일치로 본다"는 같은 규칙을 각자 적고 있었고,
 * 비어 있는 값을 거르는 방식만 제각각이었다(`Boolean(value && …)`·`String(value)`·
 * `filter(…is string)`). 셋 다 같은 결과를 내지만 규칙을 손볼 때 고칠 자리가 넷이었다.
 * 목록마다 다른 것은 "무엇을 모으는가"뿐이라 그 배열만 받는다.
 *
 * `needle`은 이미 소문자로 다듬어진 검색어다. 빈 검색어는 호출부가 먼저 걸러 목록을
 * 그대로 돌려주므로 여기서는 다루지 않는다.
 */
export function matchesNeedle(values: readonly (string | null | undefined)[], needle: string): boolean {
  return values.some((value) => typeof value === "string" && value.toLowerCase().includes(needle));
}

/**
 * 메뉴 번역 목록과 그 진행 막대 배선을 한 곳에 모은다. 스킬·에이전트·아티팩트 세 화면이
 * 같은 네 조각(자동번역 켜짐 여부·진행 상태·조회 오류·재시도)을 각자 펼쳐 놓으면서
 * `automation.settings.translations.<메뉴>`와 `automation.<메뉴>` 두 인덱스를 손으로
 * 적고 있었다. 메뉴 이름을 한 자리만 다르게 적어도 다른 메뉴의 진행 막대를 조용히 보여
 * 주는 배선이라, 메뉴 이름을 한 번만 받아 네 조각을 모두 그 이름에서 끌어내게 했다.
 *
 * 지침 화면은 목록 새로 고침까지 번역 조회 키에 더하고 진행 막대를 두지 않아 모양이
 * 다르다. 그대로 두었다.
 */
export function useMenuTranslationBar(
  menu: TranslationMenu,
  automation: SystemAutomationSnapshot | null,
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void,
): {
  records: Map<string, TranslationSummary>;
  progress: ComponentProps<typeof TranslationProgress>;
} {
  const { data, records, error } = useMenuTranslations(menu, automation?.revision ?? 0);
  /**
   * 재시도가 거절된 사유. 조회 오류와 같은 자리(진행 줄의 `error`)에 서지만 소유자가
   * 다르다 — 조회 오류는 메뉴 번역 조회가 들고 재조회마다 다시 판정하는 값이고, 이쪽은
   * 사용자가 누른 한 번의 결과다. 그래서 여기 따로 담고, **다음 재시도를 누를 때 지운다.**
   * 성공 응답에서만 지우면 실패 문구가 다음 실패까지 남아 어느 클릭의 사유인지 흐려진다.
   * 방금 누른 결과가 더 급한 소식이라 조회 오류보다 앞에 세운다(QA #97).
   */
  const [retryError, setRetryError] = useState<string | null>(null);
  return {
    records,
    progress: {
      enabled: Boolean(automation?.settings.translations[menu]),
      status: data?.status ?? automation?.[menu],
      error: retryError ?? error,
      onRetry: () => {
        setRetryError(null);
        void retryMenuTranslation(menu)
          .then(onAutomationChange)
          .catch((cause: unknown) => setRetryError(errorText(cause)));
      },
    },
  };
}

/**
 * 검색 한 칸으로 끝나는 메뉴 목록 화면의 상태 한 벌. 에이전트·아티팩트 화면이 검색어 상태,
 * 소문자·공백 정리한 검색어, 번역 막대, 빈 검색어일 때 원본을 그대로 돌려주는 걸러내기를
 * 각자 같은 모양으로 적고 있었다. 네 줄이 한 세트로만 뜻이 있어 한 줄만 손봐도 나머지가
 * 조용히 어긋나는 자리라 한 훅으로 모은다.
 *
 * `matches`는 메모의 의존성에 들어가므로 모듈 수준 함수처럼 신원이 고정된 것만 넘긴다.
 * 필터 축이 붙은 화면(스킬·지침)은 걸러내기가 검색어 하나로 끝나지 않아 여기 오지 않는다.
 */
export function useMenuSearch<T>(
  menu: TranslationMenu,
  automation: SystemAutomationSnapshot | null,
  onAutomationChange: (snapshot: SystemAutomationSnapshot) => void,
  items: readonly T[],
  matches: (item: T, needle: string, translations: Map<string, TranslationSummary>) => boolean,
): {
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  /** 공백을 털고 소문자로 내린 검색어. 검색으로 0건이 된 것과 원본이 0건인 것을 가르는 데 쓴다. */
  needle: string;
  filtered: readonly T[];
  translations: ReturnType<typeof useMenuTranslationBar>;
} {
  const translations = useMenuTranslationBar(menu, automation, onAutomationChange);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const records = translations.records;
  const filtered = useMemo(
    () => (needle ? items.filter((item) => matches(item, needle, records)) : items),
    [items, needle, records, matches],
  );
  return { query, setQuery, needle, filtered, translations };
}

/**
 * 위 훅과 짝인 도구줄. 번역 진행 막대·검색 칸·개수 표시 순서와 클래스 이름을 두 화면이
 * 각자 적어 두어 한쪽만 손대면 줄 모양이 갈라졌다. 개수 문구는 화면마다 공급자 이름과
 * 단위가 달라 통째로 받는다.
 */
export function MenuSearchToolbar({ progress, query, onQueryChange, placeholder, children }: {
  progress: ComponentProps<typeof TranslationProgress>;
  query: string;
  onQueryChange: (value: string) => void;
  placeholder: string;
  children: ReactNode;
}) {
  return (
    <section className="toolbar-card">
      <TranslationProgress {...progress} />
      <input className="search-input wide" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={placeholder} />
      <span className="toolbar-count">{children}</span>
    </section>
  );
}

/** 순서를 무시한 집합 비교. 지원 OS·공급자 선택처럼 순서에 뜻이 없는 목록에만 쓴다. */
export function arraysEqual<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
