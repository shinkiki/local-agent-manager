import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ArchiveX, Ban, FileDiff, FolderInput, Link2, Plus, RefreshCw, Send, ShieldAlert, Sparkles, Trash2 } from "lucide-react";
import {
  createCommonSkill,
  deleteSharedSkill,
  deleteSkill,
  getCommonSkillDetail,
  getAiaSuggestionCatalog,
  getProjectRegistry,
  getSkillMigrationPlan,
  getSkillLibrary,
  importSkillToCommon,
  listSkillTrash,
  publishCommonSkill,
  purgeSkillTrash,
  readCommonSkillFile,
  restoreSkillTrash,
  setSkillAutoSync,
  setSkillPlatforms,
  syncSkillFromInstall,
  unarchiveSharedSkill,
  updateCommonSkill,
} from "../lib/ipc";
import type { AiaSuggestionCatalog } from "../lib/aiaSuggestions";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/errorText";
import { excludedProjectPaths } from "../lib/projectRegistry";
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
  skillDescriptionError,
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
  SkillKindFilter,
  SkillLibraryFilters,
  SkillStateFilter,
} from "../lib/skillLibrary";
import type {
  CommonSkillDetail,
  HostPlatform,
  ProviderId,
  SkillInstallView,
  SkillLibrary,
  SkillLibraryEntry,
  SkillLocation,
  SkillProjectView,
  SkillProviderState,
  SkillTrashItem,
  SkillTrashOverview,
  SystemAutomationSnapshot,
  TranslationSummary,
} from "../types";
import { MarkdownPreview } from "./MarkdownPreview";
import { Drawer, EmptyState, ErrorBanner, LoadingState, Modal, SourceBadge, useConfirm } from "./Shared";
import { SkillInstallDiff } from "./SkillInstallDiff";
import { TranslateResourceButton } from "./TranslationProgress";

const LIBRARY_FILTERS_KEY = "agent-manager.skill-library-filters.v1";
const HOST_PLATFORMS: HostPlatform[] = ["macos", "windows", "linux"];


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
function divergentManagedInstalls(entry: SkillLibraryEntry): { provider: ProviderId; install: SkillInstallView }[] {
  return entry.providers.flatMap((state) =>
    state.installs
      .filter((install) => install.divergent && isManagedScope(install.scope))
      .map((install) => ({ provider: state.provider, install })));
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
export function SkillLibraryPanel({ translations, automation, onAutomationChange, onInstalledChanged, onMigrationRequiredCount, onRequestAiaPrompt }: SkillLibraryPanelProps) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [library, setLibrary] = useState<SkillLibrary | null>(null);
  const [suggestionCatalog, setSuggestionCatalog] = useState<AiaSuggestionCatalog | null>(null);
  // 설정에서 제외한 프로젝트를 출처 칩에서 숨기기 위한 목록. 조회 실패는 칩만 그대로 둔다.
  const [projectRegistry, setProjectRegistry] = useState<ProjectRegistryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<SkillLibraryFilters>(loadLibraryFilters);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<null | "deploy" | "delete" | "import" | "unarchive" | "disable">(null);
  const [useBusy, setUseBusy] = useState<string | null>(null);
  const [bulkDeployOpen, setBulkDeployOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [suggestionPackBusy, setSuggestionPackBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [next, nextSuggestionCatalog, nextRegistry] = await Promise.all([
        getSkillLibrary(),
        getAiaSuggestionCatalog(),
        getProjectRegistry().catch((): ProjectRegistryEntry[] => []),
      ]);
      setLibrary(next);
      setSuggestionCatalog(nextSuggestionCatalog);
      setProjectRegistry(nextRegistry);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    saveLibraryFilters(filters);
  }, [filters]);

  // 스킬관리는 사용자가 다룰 수 있는 스킬만 보여준다. 내장 스킬 제외.
  const managedEntries = useMemo(
    () => (library?.entries ?? []).filter((entry) => entry.managed),
    [library],
  );

  const bundledSuggestionEntry = useMemo(() => {
    const key = suggestionCatalog?.bundledSkill.key;
    return key ? managedEntries.find((entry) => entry.key === key) ?? null : null;
  }, [managedEntries, suggestionCatalog?.bundledSkill.key]);
  const bundledSuggestionIssues = useMemo(() => {
    const key = suggestionCatalog?.bundledSkill.key;
    return key
      ? (suggestionCatalog?.issues ?? []).filter((issue) => issue.skillKey === key)
      : [];
  }, [suggestionCatalog]);

  const installBundledSuggestionSkill = useCallback(async () => {
    const template = suggestionCatalog?.bundledSkill;
    if (!template || suggestionPackBusy) return;
    const existing = bundledSuggestionEntry?.common ?? null;
    const repairing = Boolean(existing);
    const accepted = await confirm({
      title: repairing ? "AIA 제안 팩 복구" : "AIA 제안 팩 복사",
      message: repairing
        ? "현재 공통 스킬의 내용을 앱 기본 제안 팩으로 덮어씁니다. 계속할까요?"
        : "앱 기본 제안 팩을 사용자가 편집할 수 있는 공통 스킬로 복사할까요?",
      confirmLabel: repairing ? "기본값으로 복구" : "공통 스킬로 복사",
      tone: repairing ? "danger" : "default",
    });
    if (!accepted) return;
    setSuggestionPackBusy(true);
    setError(null);
    try {
      const source = existing ?? await createCommonSkill({
        key: template.key,
        name: template.name,
        description: template.description,
      });
      await updateCommonSkill({
        key: template.key,
        files: template.files,
        deletes: [],
        expectedDigest: source.contentDigest,
      });
      setNotice(repairing
        ? "AIA 제안 팩을 앱 기본값으로 복구했습니다."
        : "AIA 제안 팩을 공통 스킬로 복사했습니다.");
      onInstalledChanged?.();
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSuggestionPackBusy(false);
    }
  }, [bundledSuggestionEntry?.common, confirm, onInstalledChanged, refresh, suggestionCatalog?.bundledSkill, suggestionPackBusy]);

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

  // 검색은 필터와 독립된 축이다. 필터 칩 개수도 검색 결과 안에서 세야 화면과 맞는다.
  const searched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return managedEntries.filter((entry) => {
      const translated = entryTranslation(entry);
      return matchesSkillQuery(entry, query)
        || (needle.length > 0 && translated
          ? [translated.name, translated.description]
            .some((value) => typeof value === "string" && value.toLowerCase().includes(needle))
          : false);
    });
  }, [managedEntries, query, entryTranslation]);

  const entries = useMemo(() => sortSkillEntries(filterSkillEntries(searched, filters)), [searched, filters]);

  // 선택은 지금 화면에 보이는 항목 안에서만 유지한다. 새로고침으로 사라진 항목뿐 아니라
  // 필터·검색으로 좁혀져 숨은 항목도 선택에서 빼야, 일괄 작업 바의 개수가 보이는 것과
  // 같고 일괄 삭제가 화면에 없는 스킬까지 대상으로 삼지 않는다(QA #30).
  useEffect(() => {
    setCheckedKeys((current) => {
      const visible = new Set(entries.map((entry) => entry.key));
      const next = new Set([...current].filter((key) => visible.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [entries]);

  const counts = useMemo(() => skillSyncCounts(managedEntries), [managedEntries]);
  // 출처 필터의 프로젝트 칩. 보관 스킬 출처에 등장한 프로젝트만 노출하고, 설정에서 제외한
  // 프로젝트는 숨긴다(출처 표시 자체는 이력이라 항목에 남는다).
  const excludedProjects = useMemo(() => excludedProjectPaths(projectRegistry), [projectRegistry]);
  const originProjects = useMemo(
    () => skillOriginProjects(managedEntries, excludedProjects),
    [managedEntries, excludedProjects],
  );
  const projectOriginSelected = isProjectOriginFilter(filters.origin);
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
    if (!library || !filters.origin.startsWith("project:")) return;
    if (originProjects.some((project) => `project:${project.path}` === filters.origin)) return;
    setFilters((current) => ({ ...current, origin: "project" }));
  }, [library, filters.origin, originProjects]);
  const migrationRequiredCount = useMemo(
    () => managedEntries.filter((entry) => entry.migrationRequired).length,
    [managedEntries],
  );

  useEffect(() => {
    onMigrationRequiredCount?.(migrationRequiredCount);
  }, [migrationRequiredCount, onMigrationRequiredCount]);
  const selected = useMemo(
    () => managedEntries.find((entry) => entry.key === selectedKey) ?? null,
    [managedEntries, selectedKey],
  );
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
    setNotice(summary);
    setCheckedKeys(new Set());
    onInstalledChanged?.();
    void refresh();
  };

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
    setUseBusy(`${entry.key}:${state.provider}:${target.projectPath ?? "personal"}`);
    setError(null);
    try {
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
        setNotice(text(
          `'${entry.key}'을 ${providerLabel(state.provider)}(${where})에서 사용합니다.`,
          `Enabled '${entry.key}' for ${providerLabel(state.provider)} (${where}).`,
        ));
      } else {
        const install = installAt(state, target);
        if (!install) return;
        await deleteSkill(install.skillId);
        setNotice(text(
          `'${entry.key}'을 ${providerLabel(state.provider)}(${where})에서 사용 해제했습니다. 사용본은 휴지통으로 이동했습니다.`,
          `Disabled '${entry.key}' for ${providerLabel(state.provider)} (${where}). The install moved to the trash.`,
        ));
      }
      onInstalledChanged?.();
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setUseBusy(null);
    }
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

  // 자동 동기화: 외부 수정이 감지된 스킬 중 자동 모드인 항목은 그 버전을 원본에
  // 반영하고 전체 재배포한다. 서로 다른 수정이 여러 개면 자동 판단이 불가능하므로
  // 수동(외부 수정 감지 배지)으로 남긴다.
  const autoSyncRunning = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const entry of managedEntries) {
      if (!entry.autoSync || !entry.common) continue;
      const divergents = divergentManagedInstalls(entry).map((item) => item.install);
      if (divergents.length === 0) continue;
      const digests = new Set(divergents.map((install) => install.contentDigest ?? ""));
      if (digests.size !== 1) continue;
      if (autoSyncRunning.current.has(entry.key)) continue;
      autoSyncRunning.current.add(entry.key);
      const target = divergents[0];
      void syncSkillFromInstall(target.skillId)
        .then(() => {
          setNotice(text(
            `'${entry.key}'을 자동 동기화했습니다. 이전 원본은 휴지통에 있습니다.`,
            `Auto-synced '${entry.key}'. The previous source is in the trash.`,
          ));
          onInstalledChanged?.();
          return refresh();
        })
        .catch((cause: unknown) => {
          setError(errorText(cause));
        })
        .finally(() => {
          autoSyncRunning.current.delete(entry.key);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managedEntries]);

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
    busyKind: NonNullable<typeof bulkBusy>,
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
    const archiveNote = archiveFirstNote(checkedEntries, "삭제");
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
      failActionKo: "이동",
      failActionEn: "moved",
    });
  };

  /** 선택 항목을 모든 에이전트에서 사용 해제한다. 사용본은 휴지통으로 이동하고
   * 보관 원본만 남는다. 미보관 항목은 보관을 거쳐 처리하며, 대상과 결과를
   * 확인받은 뒤 실행한다. */
  const runBulkDisable = async () => {
    const archiveNote = archiveFirstNote(checkedEntries, "해제");
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
      failActionKo: "해제",
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
      failActionKo: "보관취소",
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
      failActionKo: "보관",
      failActionEn: "archived",
    });
  };

  /** 선택 항목을 지정 에이전트에서 사용하도록 설정. 미보관 항목은 확인을 거쳐
   * 먼저 보관한 뒤 함께 적용한다. */
  const runBulkDeploy = async (providers: ProviderId[], overwrite: boolean) => {
    setBulkDeployOpen(false);
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
      failActionKo: "적용",
      failActionEn: "enabled",
    });
  };

  if (loading && !library) return <LoadingState label={text("보관 스킬 목록을 읽고 있습니다", "Reading archived skills")} />;

  const bulkImportable = checkedEntries.some((entry) => !entry.common);
  const bulkUnarchivable = checkedEntries.some((entry) => entry.common);
  // 전체선택은 현재 필터·검색 결과만 대상으로 한다. 숨겨진 항목을 몰래 선택에
  // 넣으면 일괄 삭제가 보이는 것보다 넓게 실행되는 사고가 난다. 선택이 하나라도
  // 있으면 전체해제로 동작해 버튼 하나로 선택 상태를 오간다.
  const toggleSelectAll = () => {
    setCheckedKeys((current) =>
      current.size > 0 ? new Set() : new Set(entries.map((entry) => entry.key)),
    );
  };

  return (
    <div className="view-stack">
      {error && <ErrorBanner message={error} />}
      {notice && <div className="skill-library-notice" role="status">{notice}</div>}

      <section className="toolbar-card skill-library-toolbar">
        <div className="skill-library-titlebar">
          <div className="skill-library-summary">
            <strong>{text("보관 스킬", "Archived skills")}</strong>
            <small>
              {text("보관 저장소", "Archive store")} <code>{library?.commonRoot ?? "-"}</code>
              {library && !library.commonRootPresent && ` · ${text("아직 없음", "not created yet")}`}
            </small>
          </div>
        </div>
        <div className="skill-library-toolbar-row">
          <div className="skill-sync-counts">
            {counts.conflict > 0 && <span className="skill-sync-pill conflict">{text("외부 수정 감지", "Externally edited")} {counts.conflict}</span>}
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
        </div>
      </section>

      {suggestionCatalog && <section className="detail-card aia-suggestion-pack-card">
        <div>
          <div className="section-title">
            <h3><Sparkles size={15} aria-hidden="true" /> AIA 선제 제안 팩</h3>
            <span>{suggestionCatalog.definitions.length}개 제안</span>
          </div>
          <p>제안 문구, 명령 초안, 임계값과 재알림 조건을 공통 스킬에서 안전하게 관리합니다.</p>
          <small><code>{suggestionCatalog.bundledSkill.key}</code> · 임의 코드나 도구 호출은 지원하지 않습니다.</small>
        </div>
        <button
          className="button compact"
          type="button"
          disabled={suggestionPackBusy || (Boolean(bundledSuggestionEntry?.common) && bundledSuggestionIssues.length === 0)}
          onClick={() => { void installBundledSuggestionSkill(); }}
        >
          <Sparkles size={13} aria-hidden="true" />
          {suggestionPackBusy
            ? "적용 중…"
            : bundledSuggestionEntry?.common
              ? bundledSuggestionIssues.length > 0 ? "기본 팩으로 복구" : "공통 스킬에 설치됨"
              : "공통 스킬로 복사"}
        </button>
        {suggestionCatalog.issues.length > 0 && <ul className="aia-suggestion-pack-issues">
          {suggestionCatalog.issues.map((issue, index) => <li key={`${issue.skillKey}-${index}`}>
            <ShieldAlert size={12} aria-hidden="true" />
            <code>{issue.skillKey}</code>
            <span>{issue.message}</span>
            {issue.usingLastKnownGood && <small>마지막 정상 팩 사용 중</small>}
          </li>)}
        </ul>}
      </section>}

      <section className="toolbar-card skill-library-filterbar">
        <FilterAxis label={text("보관", "Archive")}>
          <FilterChipRow
            groupLabel={text("보관 여부 필터", "Archive filter")}
            chips={([
              { value: "all", ko: "전체", en: "All" },
              { value: "shared", ko: "보관", en: "Archived" },
              { value: "agent", ko: "미보관", en: "Unarchived" },
            ] as const).map((item) => ({
              value: item.value,
              label: text(item.ko, item.en),
              count: filterCounts.kind[item.value],
              active: filters.kind === item.value,
            }))}
            onSelect={(kind) => setFilters((current) => ({ ...current, kind }))}
          />
        </FilterAxis>
        <FilterAxis label={text("상태", "State")}>
          <FilterChipRow
            groupLabel={text("스킬 상태 필터", "Skill state filter")}
            chips={([
              { value: "all", ko: "전체", en: "All" },
              { value: "conflict", ko: "외부 수정 감지", en: "Externally edited" },
              { value: "undeployed", ko: "미사용", en: "Not in use" },
            ] as const).map((item) => ({
              value: item.value,
              label: text(item.ko, item.en),
              count: filterCounts.state[item.value],
              active: filters.state === item.value,
            }))}
            onSelect={(state) => setFilters((current) => ({ ...current, state }))}
          />
        </FilterAxis>
        <FilterAxis label={text("에이전트", "Agent")}>
          <FilterChipRow
            groupLabel={text("사용 에이전트 필터", "Agent use filter")}
            chips={([
              { value: "all", label: null },
              { value: "claude", label: "Claude" },
              { value: "codex", label: "Codex" },
              { value: "antigravity", label: "Antigravity" },
            ] as const).map((item) => ({
              value: item.value,
              label: item.label ?? text("전체", "All"),
              count: filterCounts.agent[item.value],
              active: filters.agent === item.value,
            }))}
            onSelect={(agent) => setFilters((current) => ({ ...current, agent }))}
          />
        </FilterAxis>
        {/* 출처는 두 단이다. 프로젝트를 고르기 전에는 프로젝트 이름 칩을 내지 않아
            칩 줄이 프로젝트 수만큼 늘어나는 일을 막는다. */}
        <FilterAxis label={text("출처", "Source")} className="skill-origin-filter">
          <div className="skill-origin-filter-body">
            <FilterChipRow
              groupLabel={text("스킬 출처 필터", "Skill source filter")}
              chips={([
                { value: "all", ko: "전체", en: "All" },
                { value: "personal", ko: "개인", en: "Personal" },
                { value: "project", ko: "프로젝트", en: "Project" },
              ] as const).map((item) => ({
                value: item.value,
                label: text(item.ko, item.en),
                count: filterCounts.origin[item.value] ?? 0,
                // 프로젝트 칩은 개별 프로젝트를 고른 동안에도 켜진 것으로 본다.
                active: item.value === "project" ? projectOriginSelected : filters.origin === item.value,
              }))}
              onSelect={(origin) => setFilters((current) => ({ ...current, origin }))}
            />
            {projectOriginSelected && originProjects.length > 0 && (
              <FilterChipRow
                groupLabel={text("프로젝트 선택", "Project filter")}
                className="skill-origin-projects"
                chips={[
                  {
                    value: "project",
                    label: text("전체 프로젝트", "All projects"),
                    count: filterCounts.origin.project ?? 0,
                    active: filters.origin === "project",
                    // 상위 칩에서 이미 프로젝트를 골랐으므로 0건이어도 되돌아갈 길은 남긴다.
                    disabled: false,
                  },
                  ...originProjects.map((project) => ({
                    value: `project:${project.path}`,
                    label: project.name,
                    title: project.path,
                    count: filterCounts.origin[`project:${project.path}`] ?? 0,
                    active: filters.origin === `project:${project.path}`,
                  })),
                ]}
                onSelect={(origin) => setFilters((current) => ({ ...current, origin }))}
              />
            )}
          </div>
        </FilterAxis>
      </section>

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
              if (!await confirmArchiveFirst("사용 설정", "enabled")) return;
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
                <code>{issue.path}</code>
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
          onSubmit={(providers, overwrite) => { void runBulkDeploy(providers, overwrite); }}
        />
      )}

      {trashOpen && (
        <SkillTrashDrawer
          onClose={() => setTrashOpen(false)}
          onChanged={(message) => {
            setNotice(message);
            onInstalledChanged?.();
            void refresh();
          }}
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
          onClose={() => setSelectedKey(null)}
          onChanged={(message) => {
            setNotice(message);
            onInstalledChanged?.();
            void refresh();
          }}
          onRequestAiaPrompt={onRequestAiaPrompt}
        />
      )}

      {confirmDialog}
    </div>
  );
}

/**
 * 필터 한 축의 칩 한 줄. 보관·상태·에이전트·출처 네 축이 라벨과 값만 다르고 활성 표시,
 * 개수 배지, "고른 칩이 아니면서 0건이면 못 누른다" 규칙은 같다. 네 벌로 두면 규칙을
 * 한쪽에서만 고치게 된다.
 */
interface FilterChip<V extends string> {
  value: V;
  label: string;
  count: number;
  active: boolean;
  /** 기본 규칙(0건이면서 고른 칩이 아니다)을 덮어써야 하는 칩에만 준다. */
  disabled?: boolean;
  title?: string;
}

function FilterChipRow<V extends string>({ groupLabel, className, chips, onSelect }: {
  groupLabel: string;
  className?: string;
  chips: FilterChip<V>[];
  onSelect: (value: V) => void;
}) {
  return (
    <div className={className ? `source-tabs ${className}` : "source-tabs"} role="group" aria-label={groupLabel}>
      {chips.map((chip) => (
        <button
          className={chip.active ? "active" : ""}
          type="button"
          key={chip.value}
          aria-pressed={chip.active}
          {...(chip.title === undefined ? {} : { title: chip.title })}
          disabled={chip.disabled ?? (chip.count === 0 && !chip.active)}
          onClick={() => onSelect(chip.value)}
        >
          {chip.label}<small>{chip.count.toLocaleString()}</small>
        </button>
      ))}
    </div>
  );
}

/** 필터 축 하나를 감싸는 라벨 + 본문 틀. */
function FilterAxis({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className ? `skill-filter-group ${className}` : "skill-filter-group"}>
      <span className="skill-filter-label">{label}</span>
      {children}
    </div>
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
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="skill-library-row-main">
        <div className="skill-library-row-head">
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
              {text(`프로젝트: ${entry.origin.projectName ?? ""}`, `Project: ${entry.origin.projectName ?? ""}`)}
            </span>
          )}
          {state === "conflict" && (
            <span className="skill-sync-pill conflict">{skillSyncLabel(state, text)}</span>
          )}
        </div>
        <p data-user-content>{translated?.description ?? (entry.description || text("설명이 없습니다.", "No description."))}</p>
        <code>{entry.common?.directory ?? entry.providers.find((item) => item.directory)?.directory ?? entry.key}</code>
      </div>
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
              const divergent = Boolean(install?.divergent);
              return (
                <label
                  className={`skill-use-toggle${used ? " used" : ""}${divergent ? " divergent" : ""}`}
                  key={item.provider}
                  title={divergent
                    ? text("원본과 다른 사본이 있습니다", "The install differs from the archived source")
                    : text(
                        used ? "해제하면 출처 위치의 사용본이 휴지통으로 이동합니다" : "체크하면 보관 원본을 출처 위치에 배포합니다",
                        used ? "Unchecking moves the origin-location install to the trash" : "Checking deploys the archived source to the origin location",
                      )}
                >
                  <input
                    type="checkbox"
                    checked={used}
                    disabled={useBusy !== null}
                    onChange={(event) => onToggleUse(item, event.target.checked)}
                  />
                  <span>{providerLabel(item.provider)}</span>
                  {divergent && <AlertTriangle size={10} aria-hidden="true" />}
                </label>
              );
            })}
          {extraCount > 0 && (
            <span className="skill-extra-pill" title={text("출처 외 위치의 사용본. 상세에서 관리합니다.", "Installs outside the origin location. Manage in details.")}>
              +{extraCount}
            </span>
          )}
          <label
            className={`skill-use-toggle skill-auto-toggle${entry.autoSync ? " used" : ""}`}
            title={text(
              "켜면 외부 수정 감지 시 그 버전을 원본에 반영하고 전체 재배포합니다. 서로 다른 수정이 여러 개면 수동으로 남습니다.",
              "When on, an externally edited install is adopted as the source and redeployed everywhere. Multiple different edits stay manual.",
            )}
          >
            <input
              type="checkbox"
              checked={entry.autoSync}
              disabled={useBusy !== null}
              onChange={(event) => onToggleAutoSync(event.target.checked)}
            />
            <span>{text("자동 동기화", "Auto sync")}</span>
          </label>
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
      {state.divergent && <AlertTriangle size={10} aria-hidden="true" />}
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

type SkillDrawerBusy = "import" | "delete" | "unarchive" | "sync" | "save" | "migration" | "platforms";

/**
 * 바쁨 표시·오류 초기화·try-catch-finally 껍데기. 두 서랍의 동작 아홉 벌이 같은 네 줄을
 * 손으로 반복하다 보니 오류 초기화가 빠진 자리와 순서가 다른 자리가 섞여 있었다.
 * 실패하면 null을 돌려주므로 결과를 이어 쓰는 자리는 그대로 이어 쓴다.
 */
function busyRunner<K extends string>(
  setBusy: (value: K | null) => void,
  setError: (value: string | null) => void,
) {
  return async <T,>(kind: K, action: () => Promise<T>): Promise<T | null> => {
    setBusy(kind);
    setError(null);
    try {
      return await action();
    } catch (cause) {
      setError(errorText(cause));
      return null;
    } finally {
      setBusy(null);
    }
  };
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
  // 변경 내용 비교가 펼쳐진 설치본. 한 번에 하나만 펼친다.
  const [compareSkillId, setCompareSkillId] = useState<string | null>(null);
  // 편집기 상태. 파일별 원문을 지연 로드하고 변경분만 저장한다.
  const [editing, setEditing] = useState(false);
  const [editorPaths, setEditorPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState("SKILL.md");
  const [contents, setContents] = useState<Record<string, string>>({});
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
  const [deletePaths, setDeletePaths] = useState<Set<string>>(new Set());
  const [newFileName, setNewFileName] = useState("");
  const [aiaInstruction, setAiaInstruction] = useState("");
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

  /** 스킬 삭제. 보관 원본과 모든 에이전트 사용본을 한 휴지통 그룹으로 옮긴다. */
  const runDelete = async () => {
    if (!entry.common) return;
    const usedCount = managedInstalls(entry).length;
    const proceed = await confirm({
      title: text("스킬 삭제", "Delete skill"),
      message: text(
        `'${entry.name}' 스킬을 삭제할까요?\n원본과 에이전트 사용본 ${usedCount}개가 함께 휴지통으로 이동하며, 휴지통에서 그룹 단위로 복구할 수 있습니다.`,
        `Delete skill '${entry.name}'?\nThe source and ${usedCount} agent install(s) move to the trash together and can be restored as a group.`,
      ),
      confirmLabel: text("삭제", "Delete"),
      tone: "danger",
    });
    if (!proceed) return;
    await runBusy("delete", async () => {
      await deleteSharedSkill(entry.key);
      onChanged(text(`'${entry.key}' 스킬을 휴지통으로 이동했습니다.`, `Moved skill '${entry.key}' to the trash.`));
      onClose();
    });
  };

  /** 보관만 취소. 에이전트 사용본은 그대로 두고 보관 원본만 휴지통으로 옮긴다. */
  const runUnarchive = async () => {
    if (!entry.common) return;
    const usedCount = managedInstalls(entry).length;
    const proceed = await confirm({
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
    });
    if (!proceed) return;
    await runBusy("unarchive", async () => {
      await unarchiveSharedSkill(entry.key);
      onChanged(text(`'${entry.key}' 스킬의 보관을 취소했습니다.`, `Unarchived skill '${entry.key}'.`));
      onClose();
    });
  };

  const runImport = async (skillId: string) => {
    const proceed = await confirm({
      title: text("스킬 보관", "Archive skill"),
      message: text(
        `'${entry.name}' 스킬을 보관 저장소로 보관할까요?\n기존 설치본은 그대로 남아 사용 중으로 표시됩니다.`,
        `Archive skill '${entry.name}' to the archive store?\nThe existing install stays and shows as in use.`,
      ),
      confirmLabel: text("보관", "Archive"),
    });
    if (!proceed) return;
    await runBusy("import", async () => {
      const created = await importSkillToCommon(skillId);
      onChanged(text(`'${created.key}'을 보관했습니다.`, `Archived '${created.key}'.`));
      onClose();
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

  const openEditor = () => {
    if (!detail) return;
    const paths: string[] = [];
    const walk = (nodes: CommonSkillDetail["files"]) => {
      for (const node of nodes) {
        if (node.isDirectory) walk(node.children);
        else paths.push(node.relativePath);
      }
    };
    walk(detail.files);
    if (!paths.includes("SKILL.md")) paths.unshift("SKILL.md");
    setEditorPaths(paths.sort((a, b) => (a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b))));
    setContents({ "SKILL.md": detail.body });
    setDirtyPaths(new Set());
    setDeletePaths(new Set());
    setActivePath("SKILL.md");
    setEditing(true);
  };

  const selectFile = async (path: string) => {
    setActivePath(path);
    if (contents[path] !== undefined) return;
    try {
      const file = await readCommonSkillFile(entry.key, path);
      setContents((current) => ({ ...current, [path]: file.content }));
    } catch (cause) {
      setActionError(errorText(cause));
    }
  };

  const addFile = () => {
    const name = newFileName.trim();
    if (!name || editorPaths.includes(name)) return;
    setEditorPaths((current) => [...current, name]);
    setContents((current) => ({ ...current, [name]: "" }));
    setDirtyPaths((current) => new Set(current).add(name));
    setDeletePaths((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    setActivePath(name);
    setNewFileName("");
  };

  const removeFile = (path: string) => {
    if (path === "SKILL.md") return;
    setDeletePaths((current) => new Set(current).add(path));
    setDirtyPaths((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
    setEditorPaths((current) => current.filter((item) => item !== path));
    if (activePath === path) setActivePath("SKILL.md");
  };

  const saveEdits = async () => {
    const common = entry.common;
    if (!common) return;
    const files = [...dirtyPaths]
      .filter((path) => !deletePaths.has(path))
      .map((path) => ({ path, content: contents[path] ?? "" }));
    const deletes = [...deletePaths];
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

  const requestAiaEdit = () => {
    if (!onRequestAiaPrompt || !entry.common) return;
    const instruction = aiaInstruction.trim();
    if (!instruction) return;
    onRequestAiaPrompt([
      "스킬 보관 원본을 수정해주세요.",
      `대상 디렉터리: ${entry.common.directory}`,
      `요청: ${instruction}`,
      "규칙: 원문 언어와 문체를 유지하고 SKILL.md frontmatter 형식을 깨지 마세요. 대상 디렉터리 밖의 파일은 변경하지 마세요.",
      "완료 후 무엇을 바꿨는지 요약해 주세요. 수정본은 스킬관리 화면에서 확인 후 사용 위치에 재배포됩니다.",
    ].join("\n"));
    setAiaInstruction("");
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

  const locations: { label: string; location: SkillLocation }[] = [
    { label: text("개인", "Personal"), location: { scope: "personal" } },
    ...projects.map((project) => ({
      label: project.name,
      location: { scope: "project" as const, projectPath: project.path },
    })),
  ];
  const matrixProviders = entry.providers.filter((state) => state.status !== "unsupported");
  const divergentInstalls = divergentManagedInstalls(entry);

  return (
    <>
    <Drawer
      title={<>{syncState === "conflict" && <span className="skill-sync-pill conflict">{skillSyncLabel(syncState, text)}</span>}<span data-user-content>{translated?.name ?? entry.name}</span></>}
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
        <Info label={text("이름", "Key")} value={entry.key} />
        <Info label={text("원본", "Origin")} value={entry.common?.directory ?? text("보관 원본 없음", "Not archived")} />
        <Info label={text("출처", "Source")} value={entry.origin
          ? (entry.origin.scope === "project"
            ? `${providerLabel(entry.origin.provider)} · ${entry.origin.projectName ?? entry.origin.projectPath ?? ""}`
            : `${providerLabel(entry.origin.provider)} · ${text("개인", "Personal")}`)
          : text("기록 없음", "Not recorded")} />
        <Info label={text("내용 지문", "Digest")} value={entry.common?.contentDigest.slice(0, 12) ?? "-"} />
        <Info
          label={text("지원 OS", "Supported OS")}
          value={entry.platforms.length > 0 ? entry.platforms.join(", ") : text("전체", "All")}
        />
      </section>

      {entry.common && (
        <section className="detail-card">
          <div className="section-title"><h3>{text("OS 호환성", "OS compatibility")}</h3></div>
          <p className="prose-copy">{text(
            "base 원본을 그대로 사용할 OS를 선택하세요. 아무것도 선택하지 않으면 모든 OS에서 사용하는 portable 스킬입니다.",
            "Select the platforms that can use the base source as-is. No selection means the skill is portable across all platforms.",
          )}</p>
          <div className="skill-use-matrix">
            {HOST_PLATFORMS.map((platform) => (
              <label className={`skill-use-toggle${selectedPlatforms.includes(platform) ? " used" : ""}`} key={platform}>
                <input
                  type="checkbox"
                  checked={selectedPlatforms.includes(platform)}
                  disabled={busy !== null}
                  onChange={() => setSelectedPlatforms((current) => current.includes(platform)
                    ? current.filter((value) => value !== platform)
                    : [...current, platform])}
                />
                {platformName(platform)}
              </label>
            ))}
          </div>
          <div className="form-actions">
            <button
              className="button"
              type="button"
              disabled={busy !== null || arraysEqual(selectedPlatforms, entry.platforms)}
              onClick={() => { void savePlatformMetadata(); }}
            >
              {busy === "platforms" ? text("저장 중…", "Saving…") : text("지원 OS 저장", "Save supported OS")}
            </button>
          </div>
          {entry.migrationRequired && <>
            <p className="prose-copy">{text(
              `현재 OS(${currentPlatform})에서 사용할 변형이 없습니다. AIA가 변환 파일을 만들 수 있지만 생성된 스크립트나 명령은 자동 실행하지 않습니다.`,
              `No variant is available for the current OS (${currentPlatform}). AIA can create converted files, but generated scripts or commands are never run automatically.`,
            )}</p>
            <div className="form-actions">
            <button
              className="button"
              type="button"
              disabled={busy !== null || !onRequestAiaPrompt}
              onClick={() => { void requestPlatformMigration(); }}
            >
              {busy === "migration" ? text("계획 확인 중…", "Loading plan…") : text("AIA로 현재 OS 변형 만들기", "Create current OS variant with AIA")}
            </button>
            </div>
          </>}
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
        <section className="detail-card">
          <div className="section-title"><h3>{text("사용 설정", "Agent use")}</h3></div>
          <p className="prose-copy">{text(
            "위치별로 에이전트 사용 여부를 켜고 끕니다. 해제된 사용본은 휴지통으로 이동합니다.",
            "Turn agent use on or off per location. Disabled installs move to the trash.",
          )}</p>
          <table className="skill-location-matrix">
            <thead>
              <tr>
                <th>{text("위치", "Location")}</th>
                {matrixProviders.map((state) => (
                  <th key={state.provider}>{providerLabel(state.provider)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {locations.map((row) => (
                <tr key={row.location.projectPath ?? "personal"}>
                  <td>{row.label}</td>
                  {matrixProviders.map((state) => {
                    const install = installAt(state, row.location);
                    return (
                      <td key={state.provider}>
                        <label className={`skill-use-toggle${install ? " used" : ""}${install?.divergent ? " divergent" : ""}`}>
                          <input
                            type="checkbox"
                            checked={Boolean(install)}
                            disabled={useBusy !== null || busy !== null}
                            onChange={(event) => onSetUse(state, event.target.checked, row.location)}
                          />
                          {install?.divergent && <AlertTriangle size={10} aria-hidden="true" />}
                        </label>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {entry.common && divergentInstalls.length > 0 && (
        <section className="detail-card">
          <div className="section-title"><h3>{text("외부 수정 감지", "Externally edited")}</h3></div>
          <p className="prose-copy">{text(
            "아래 사용본이 보관 원본과 다릅니다. 한 버전을 선택해 동기화하면 그 버전이 원본이 되고 나머지 위치에 재배포됩니다. 이전 원본은 휴지통으로 이동합니다.",
            "These installs differ from the archived source. Syncing adopts one version as the source and redeploys everywhere else. The previous source moves to the trash.",
          )}</p>
          <div className="skill-divergent-list">
            {divergentInstalls.map(({ provider, install }) => (
              <div className="skill-divergent-item" key={install.skillId}>
                <div className="skill-divergent-row">
                  <SourceBadge source={provider} />
                  <code>{install.directory}</code>
                  <button
                    className={`button compact${compareSkillId === install.skillId ? " active" : ""}`}
                    type="button"
                    aria-expanded={compareSkillId === install.skillId}
                    onClick={() => setCompareSkillId(compareSkillId === install.skillId ? null : install.skillId)}
                  >
                    <FileDiff size={13} aria-hidden="true" />{compareSkillId === install.skillId ? text("변경 내용 닫기", "Hide changes") : text("변경 내용 보기", "Show changes")}
                  </button>
                  <button className="button compact" type="button" disabled={busy !== null || useBusy !== null} onClick={() => { void runSync(install); }}>
                    <RefreshCw size={13} aria-hidden="true" />{busy === "sync" ? text("동기화 중…", "Syncing…") : text("이 버전으로 동기화", "Sync to this version")}
                  </button>
                </div>
                {compareSkillId === install.skillId && (
                  <SkillInstallDiff skillId={install.skillId} refreshKey={install.contentDigest} />
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {entry.common && (
        <section className="detail-card">
          <div className="section-title">
            <h3>{text("편집", "Edit")}</h3>
            {!editing && (
              <button className="button compact" type="button" disabled={!detail || busy !== null} onClick={openEditor}>
                {text("직접 편집", "Edit files")}
              </button>
            )}
          </div>
          {editing && (
            <div className="skill-editor">
              <div className="skill-editor-files">
                {editorPaths.map((path) => (
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
                    setDirtyPaths((current) => new Set(current).add(activePath));
                  }}
                />
                {activePath === "SKILL.md" && translated?.body && (
                  <details className="skill-editor-translation">
                    <summary>{text("한국어 번역 참조", "Korean translation reference")}</summary>
                    <MarkdownPreview source={translated.body} compact />
                  </details>
                )}
                <div className="form-actions">
                  <button className="button" type="button" disabled={busy !== null} onClick={() => setEditing(false)}>{text("취소", "Cancel")}</button>
                  <button className="button primary" type="button" disabled={busy !== null} onClick={() => { void saveEdits(); }}>
                    {busy === "save" ? text("저장 중…", "Saving…") : text("저장 후 재배포", "Save and redeploy")}
                  </button>
                </div>
              </div>
            </div>
          )}
          {onRequestAiaPrompt && (
            <div className="skill-editor-aia">
              <p className="prose-copy">{text(
                "원문이 다른 언어라 직접 고치기 어렵다면, 한국어로 수정 내용을 적어 AIA에게 맡기세요. 원문 언어와 문체를 유지하며 수정합니다.",
                "If the source language is hard to edit directly, describe the change in Korean and delegate it to AIA. It edits while keeping the original language and style.",
              )}</p>
              <textarea
                value={aiaInstruction}
                rows={2}
                placeholder={text("예: 트리거 조건에 ○○ 상황을 추가해줘", "e.g. add the ○○ case to the trigger conditions")}
                onChange={(event) => setAiaInstruction(event.target.value)}
              />
              <div className="form-actions">
                <button className="button compact" type="button" disabled={!aiaInstruction.trim()} onClick={requestAiaEdit}>
                  {text("AIA에게 수정 요청", "Ask AIA to edit")}
                </button>
              </div>
            </div>
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

/** 스킬 휴지통. 삭제·사용 해제·동기화로 옮겨진 실체를 복구하거나 비운다. */
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

  const groupSize = (item: SkillTrashItem) =>
    (overview?.items ?? []).filter((entry) => entry.groupId === item.groupId).length;

  const runRestore = async (item: SkillTrashItem) => {
    await runBusy(item.id, async () => {
      const receipt = await restoreSkillTrash(item.id);
      const restored = receipt.results.filter((result) => result.outcome === "restored").length;
      const skipped = receipt.results.filter((result) => result.outcome === "skipped").length;
      onChanged(text(
        `'${item.key}' 복구: ${restored}개 복원${skipped > 0 ? `, ${skipped}개는 경로가 사용 중이라 건너뜀` : ""}`,
        `Restored '${item.key}': ${restored} item(s)${skipped > 0 ? `, ${skipped} skipped (path occupied)` : ""}`,
      ));
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
              <div className="skill-trash-row" key={item.id}>
                <div className="skill-trash-main">
                  <div className="skill-trash-head">
                    <strong>{item.key}</strong>
                    <span className="scope-pill">{describeLocation(item)}</span>
                    {item.kind === "link" && <span className="scope-pill">{text("링크", "link")}</span>}
                    <small>{new Date(item.deletedAtMs).toLocaleString()}</small>
                    {groupSize(item) > 1 && <small>{text(`그룹 ${groupSize(item)}개 항목`, `group of ${groupSize(item)}`)}</small>}
                  </div>
                  <code>{item.originalPath}</code>
                </div>
                <div className="skill-trash-actions">
                  <button className="button compact" type="button" disabled={busy !== null} onClick={() => { void runRestore(item); }}>
                    {busy === item.id ? text("복구 중…", "Restoring…") : text("복구", "Restore")}
                  </button>
                  <button className="button danger-subtle compact" type="button" disabled={busy !== null} onClick={() => { void runPurge(item); }}>
                    {text("영구 삭제", "Delete")}
                  </button>
                </div>
              </div>
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

function loadLibraryFilters(): SkillLibraryFilters {
  try {
    const stored = JSON.parse(window.localStorage.getItem(LIBRARY_FILTERS_KEY) ?? "null") as Partial<SkillLibraryFilters> | null;
    return {
      kind: SKILL_KIND_VALUES.includes(stored?.kind as SkillKindFilter) ? stored?.kind as SkillKindFilter : "all",
      state: SKILL_STATE_VALUES.includes(stored?.state as SkillStateFilter) ? stored?.state as SkillStateFilter : "all",
      agent: SKILL_AGENT_VALUES.includes(stored?.agent as SkillAgentFilter) ? stored?.agent as SkillAgentFilter : "all",
      origin: typeof stored?.origin === "string"
        && (["all", "personal", "project"].includes(stored.origin) || stored.origin.startsWith("project:"))
        ? stored.origin
        : "all",
    };
  } catch {
    return { kind: "all", state: "all", agent: "all", origin: "all" };
  }
}

function saveLibraryFilters(filters: SkillLibraryFilters): void {
  try {
    window.localStorage.setItem(LIBRARY_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // 저장에 실패해도 현재 실행 중에는 선택한 필터가 유지된다.
  }
}

function platformName(platform: HostPlatform): string {
  switch (platform) {
    case "macos": return "macOS";
    case "windows": return "Windows";
    case "linux": return "Linux";
  }
}

function arraysEqual<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong className="mono" title={value}>{value}</strong></div>;
}
