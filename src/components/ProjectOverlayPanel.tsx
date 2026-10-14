import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Camera, FileText, Layers, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { formatRelative } from "../lib/format";
import { overlayPatchSectionIndex, overlayPatchSections, sectionsJoinToOriginal } from "../lib/overlayPatchSections";
import {
  applyProjectOverlay,
  checkProjectOverlayApply,
  deleteProjectOverlaySet,
  excludeProjectOverlayPaths,
  getProjectGitStatus,
  getProjectOverlayDrift,
  listProjectOverlaySets,
  readProjectOverlayPatch,
  saveProjectOverlaySet,
  snapshotProjectOverlay,
} from "../lib/ipc";
import type {
  ProjectOverlayDrift,
  ProjectOverlayDriftEntry,
  ProjectOverlayPatch,
  ProjectOverlayReceipt,
  ProjectOverlaySet,
  ProjectOverlaySets,
} from "../types";
import { EmptyState, ErrorBanner, LoadingState, NoticeBanner, useBusyAction, useConfirm } from "./Shared";

/**
 * 프로젝트 화면의 overlay 탭(C19). Core·디스패치·게이트·AIA 카탈로그·IPC는 이미 서 있었고
 * 이를 부르는 화면만 없었다 — AIA는 overlay를 쓸 수 있는데 사람은 못 쓰는 상태였다
 * (2026-10-02 회차 보고, 사용자 결정 "점검표에 overlay 화면 항목을 더한다").
 *
 * 이 패널이 내주는 것은 C19-4가 원격 write에서도 허용한 다섯 가지뿐이다 — 세트 목록,
 * 세트 저장, 스냅샷, 적용, 세트 삭제. 되돌릴 수 없는 git 명령은 어느 버튼에도 없다(C16-4).
 * 적용은 `git apply --check`가 먼저 도는 백엔드 계약을 그대로 부르므로, 실패하면 작업 트리는
 * 한 글자도 바뀌지 않고 `overlayNeedsResolution`과 충돌 경로가 영수증으로 돌아온다(C19-3).
 * 그래서 이 화면은 그 결말을 **오류가 아니라 영수증으로** 그린다.
 *
 * 탭이 숨겨져도 패널은 DOM에 남으므로 모든 조회는 `active`에 묶는다(형상관리 탭과 같은 규칙).
 */
export function ProjectOverlayPanel({ projectPath, active }: {
  projectPath: string;
  active: boolean;
}) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [sets, setSets] = useState<ProjectOverlaySets | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [drift, setDrift] = useState<ProjectOverlayDrift | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ProjectOverlayReceipt | null>(null);
  // 열어 본 patch 본문. 읽기라 `busy`·`run`(변경 토큰)을 쓰지 않는다 — 다른 변경이 도는
  // 중에도 보관된 변경이 무엇인지는 볼 수 있어야 한다(C19-4).
  const [patch, setPatch] = useState<ProjectOverlayPatch | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  // 열자마자 스크롤해 둘 경로. 영수증의 충돌 경로에서 들어올 때만 들어 있다 — 본문을
  // 가공하지 않는 대신 "어디를 보면 되는지"만 화면이 안내하는 자리(C19-5 읽기).
  const [patchFocus, setPatchFocus] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<readonly string[]>([]);
  const { busy, error: actionError, run } = useBusyAction<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 후보 경로는 git status의 추적된 변경에서 온다. C19-3이 v1에서 받는 것은 HEAD에 있는
      // 추적 파일의 unstaged 변경뿐이라, untracked 항목은 애초에 고를 수 없게 둔다 —
      // 거절 사유를 영수증에서 읽게 하는 것보다 고를 수 없는 편이 덜 헷갈린다.
      // drift는 외부 Git 작업(터미널에서의 switch·pull)을 알아차리는 유일한 신호다(C19-3).
      // git을 띄우므로 저장소가 잠겨 있으면 답하지 못하는데, 그때는 세트 목록까지 같이
      // 날리지 않고 drift만 비운다 — 장부는 앱 데이터에만 있어 git 없이도 보여야 한다.
      const [nextSets, status, nextDrift] = await Promise.all([
        listProjectOverlaySets(projectPath),
        getProjectGitStatus(projectPath).catch(() => null),
        getProjectOverlayDrift(projectPath).catch(() => null),
      ]);
      setSets(nextSets);
      setDrift(nextDrift);
      setCandidates(
        status === null
          ? []
          : status.entries
            .filter((entry) => entry.worktreeStatus === "modified" && entry.unmerged === null && !entry.isSubmodule)
            .map((entry) => entry.path),
      );
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  // C20. 로그인한 채널은 모두 데스크톱과 같은 권한이다 — 읽기 전용 원격 모드가 없으므로
  // 화면이 잠그는 조건은 "다른 변경이 돌고 있다" 하나뿐이다.
  const locked = busy !== null;

  // C19-3. 외부 작업으로 기준 HEAD에서 벗어난 세트. 여기서 **자동 적용하지 않는다** —
  // 사람이 터미널에서 무엇을 하던 중인지 앱은 모르고, 그 한가운데 작업 트리를 바꾸는 것은
  // 되돌리기 어려운 종류의 친절이다. 화면이 하는 일은 그 사실을 적고 버튼을 내미는 데까지다.
  const driftedSets = drift === null ? [] : drift.sets.filter((entry) => entry.headMoved);

  const openPatch = (setId: string, focusPath: string | null = null) => {
    setPatchError(null);
    setPatchFocus(focusPath);
    readProjectOverlayPatch({ projectPath, setId })
      .then(setPatch)
      .catch((cause) => setPatchError(cause instanceof Error ? cause.message : String(cause)));
  };

  const act = (token: string, call: () => Promise<ProjectOverlayReceipt>) => {
    void run(token, async () => {
      const next = await call();
      setReceipt(next);
      await refresh();
    });
  };

  if (sets === null && loading) return <div className="git-panel-shell"><LoadingState /></div>;

  return (
    <div className="git-panel-shell overlay-panel-shell">
      {loadError && <ErrorBanner message={loadError} />}
      {actionError && <ErrorBanner message={actionError} />}
      <header className="overlay-hero">
        <div className="overlay-hero-copy">
          <span className="overlay-hero-icon" aria-hidden="true"><Layers size={18} /></span>
          <div>
            <h3>{text("로컬 Overlay", "Local overlay")}</h3>
            <p>
              {text(
                "브랜치마다 다른 로컬 변경을 안전하게 보관하고 필요할 때 다시 적용합니다.",
                "Safely store branch-specific local changes and re-apply them when needed.",
              )}
            </p>
          </div>
        </div>
        <button className="button overlay-refresh" type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} className={loading ? "spinning" : undefined} />
          {loading ? text("확인 중…", "Checking…") : text("새로고침", "Refresh")}
        </button>
      </header>

      <div className="overlay-summary" aria-label={text("Overlay 요약", "Overlay summary")}>
        <div>
          <strong>{candidates.length}</strong>
          <span>{text("담을 수 있는 변경", "Changes available")}</span>
        </div>
        <div>
          <strong>{sets?.sets.length ?? 0}</strong>
          <span>{text("저장한 세트", "Saved sets")}</span>
        </div>
        <p>
          {text(
            "스냅샷은 patch를 저장하고 검증한 뒤에만 작업 트리를 되돌립니다.",
            "Snapshots revert the worktree only after the patch is stored and verified.",
          )}
        </p>
      </div>

      {receipt && (
        <OverlayReceiptBanner
          receipt={receipt}
          locked={locked}
          onViewPatchPath={(setId, path) => openPatch(setId, path)}
          onExclude={(setId, path) => {
            void confirm({
              title: text("이 경로를 세트에서 뺄까요?", "Drop this path from the set?"),
              message: text(
                "그 경로만 세트와 보관한 patch에서 빠지고 나머지 경로의 변경은 남습니다. 덜어내기 전 patch는 앱 소유 휴지통에 보관됩니다.",
                "Only that path leaves the set and the stored patch; every other path keeps its change. The previous patch is kept in the app-owned trash.",
              ),
              confirmLabel: text("빼기", "Drop"),
            }).then((ok) => {
              if (ok) act(`exclude:${setId}`, () => excludeProjectOverlayPaths({ projectPath, setId, paths: [path] }));
            });
          }}
        />
      )}

      {driftedSets.length > 0 && (
        <OverlayDriftBanner
          entries={driftedSets}
          locked={locked}
          onCheck={(setId) => act(`check:${setId}`, () => checkProjectOverlayApply({ projectPath, setId }))}
        />
      )}

      <div className="overlay-workspace">
        <section className="overlay-card overlay-new-set">
          <header className="overlay-card-head">
            <span className="overlay-step">01</span>
            <div>
              <h4>{text("변경 담기", "Capture changes")}</h4>
              <p>{text("추적 중인 파일에서 세트에 보관할 변경을 고릅니다.", "Choose tracked-file changes to keep in this set.")}</p>
            </div>
          </header>
          <div className="overlay-card-body">
            <label className="overlay-name-field">
              <span>{text("세트 이름", "Set name")}</span>
              <input
                type="text"
                value={name}
                data-ui-anchor="projects.overlay.name"
                onChange={(event) => setName(event.target.value)}
                placeholder={text("예: 로컬 디버그 플래그", "e.g. local debug flags")}
              />
            </label>
            <div className="overlay-picker">
              <div className="overlay-picker-head">
                <span>{text("변경 파일", "Changed files")} <strong>{candidates.length}</strong></span>
                {candidates.length > 0 && (
                  <div className="overlay-picker-actions">
                    <button type="button" onClick={() => setPicked(candidates)} disabled={picked.length === candidates.length}>
                      {text("모두 선택", "Select all")}
                    </button>
                    <button type="button" onClick={() => setPicked([])} disabled={picked.length === 0}>
                      {text("선택 해제", "Clear")}
                    </button>
                  </div>
                )}
              </div>
              {candidates.length === 0 ? (
                <EmptyState
                  title={text("담을 변경이 없습니다", "No changes to capture")}
                  detail={text("추적 중인 파일의 저장되지 않은 변경만 overlay에 담을 수 있습니다.", "Only unstaged changes to tracked files can go into an overlay.")}
                />
              ) : (
                <ul className="overlay-candidates">
                  {candidates.map((path) => (
                    <li key={path}>
                      <label>
                        <input
                          type="checkbox"
                          checked={picked.includes(path)}
                          onChange={(event) => setPicked((prev) => (
                            event.target.checked ? [...prev, path] : prev.filter((entry) => entry !== path)
                          ))}
                        />
                        <code>{path}</code>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <footer className="overlay-create-actions">
              <span>{text(`${picked.length}개 선택`, `${picked.length} selected`)}</span>
              <button
                className="button primary"
                type="button"
                data-ui-anchor="projects.overlay.save"
                disabled={locked || name.trim() === "" || picked.length === 0}
                onClick={() => act("save", async () => {
                  const next = await saveProjectOverlaySet({ projectPath, name: name.trim(), paths: [...picked] });
                  setName("");
                  setPicked([]);
                  return next;
                })}
              >
                {busy === "save" ? text("저장 중…", "Saving…") : text("세트 저장", "Save set")}
              </button>
            </footer>
          </div>
        </section>

        <section className="overlay-card overlay-sets">
          <header className="overlay-card-head">
            <span className="overlay-step">02</span>
            <div>
              <h4>{text("보관한 세트", "Saved sets")}</h4>
              <p>{text("스냅샷을 만들고, 적용 가능 여부를 확인한 뒤 다시 적용합니다.", "Snapshot, check compatibility, and re-apply stored changes.")}</p>
            </div>
          </header>
          <div className="overlay-card-body">
            {sets === null || sets.sets.length === 0 ? (
              <EmptyState
                title={text("저장한 overlay 세트가 없습니다", "No overlay sets yet")}
                detail={text("왼쪽에서 이름과 변경 파일을 골라 첫 세트를 만드세요.", "Choose a name and changed files to create your first set.")}
              />
            ) : (
              <ul className="overlay-set-list">
                {sets.sets.map((set) => (
                  <OverlaySetRow
                    key={set.setId}
                    set={set}
                    drifted={driftedSets.some((entry) => entry.setId === set.setId)}
                    locked={locked}
                    busy={busy}
                    onViewPatch={() => openPatch(set.setId)}
                    onCheck={() => act(`check:${set.setId}`, () => checkProjectOverlayApply({ projectPath, setId: set.setId }))}
                    onSnapshot={() => act(`snapshot:${set.setId}`, () => snapshotProjectOverlay({ projectPath, setId: set.setId, trigger: "app" }))}
                    onApply={() => act(`apply:${set.setId}`, () => applyProjectOverlay({ projectPath, setId: set.setId }))}
                    onDelete={() => {
                      void confirm({
                        title: text("세트를 지울까요?", "Delete this set?"),
                        message: text(
                          "앱 소유 휴지통으로 옮깁니다. 작업 트리는 바뀌지 않습니다.",
                          "It moves to the app-owned trash. The worktree is unchanged.",
                        ),
                        confirmLabel: text("삭제", "Delete"),
                      }).then((ok) => {
                        if (ok) act(`delete:${set.setId}`, () => deleteProjectOverlaySet({ projectPath, setId: set.setId }));
                      });
                    }}
                  />
                ))}
              </ul>
            )}
            {sets !== null && sets.unreadable.length > 0 && (
              <NoticeBanner message={text(
                `읽지 못한 세트 폴더가 ${sets.unreadable.length}개 있습니다.`,
                `${sets.unreadable.length} set folder(s) could not be read.`,
              )} />
            )}
          </div>
        </section>
      </div>
      {patchError && <ErrorBanner message={patchError} />}
      {patch && <OverlayPatchView patch={patch} focusPath={patchFocus} onClose={() => { setPatch(null); setPatchFocus(null); }} />}
      {confirmDialog}
    </div>
  );
}

function OverlaySetRow({ set, drifted, locked, busy, onViewPatch, onCheck, onSnapshot, onApply, onDelete }: {
  set: ProjectOverlaySet;
  /** 외부 Git 작업으로 기준 HEAD에서 벗어났는가(C19-3). */
  drifted: boolean;
  locked: boolean;
  busy: string | null;
  /** 보관된 patch 본문 열기. 읽기라 `locked`에 묶이지 않는다(C19-4). */
  onViewPatch: () => void;
  onCheck: () => void;
  onSnapshot: () => void;
  onApply: () => void;
  onDelete: () => void;
}) {
  const { text } = useI18n();
  const stored = set.state !== "registered";
  const stateLabel = set.state === "registered"
    ? text("스냅샷 전", "Not captured")
    : set.state === "stored"
      ? text("보관됨", "Stored")
      : text("적용됨", "Applied");
  return (
    <li className="overlay-set-row" data-overlay-set={set.setId} data-overlay-drift={drifted ? "external" : undefined}>
      <div className="overlay-set-head">
        <strong>{set.name}</strong>
        <span className="badge" data-overlay-state={set.state}>{stateLabel}</span>
        <span className="muted">{formatRelative(set.updatedAt)}</span>
      </div>
      <ul className="overlay-set-paths">
        {set.paths.map((path) => <li key={path}><code>{path}</code></li>)}
      </ul>
      <div className="overlay-set-actions">
        <button className="button" type="button" data-overlay-action="view-patch" disabled={!stored} onClick={onViewPatch}>
          <FileText size={14} />{text("patch 보기", "View patch")}
        </button>
        <button className="button" type="button" data-overlay-action="check" disabled={locked || !stored} onClick={onCheck}>
          {text("적용 검사", "Check")}
        </button>
        <button className="button" type="button" data-overlay-action="snapshot" disabled={locked} onClick={onSnapshot}>
          <Camera size={14} />{busy === `snapshot:${set.setId}` ? text("뜨는 중…", "Capturing…") : text("스냅샷", "Snapshot")}
        </button>
        <button className="button" type="button" data-overlay-action="apply" disabled={locked || !stored} onClick={onApply}>
          <Undo2 size={14} />{text("적용", "Apply")}
        </button>
        <button className="button danger" type="button" data-overlay-action="delete" disabled={locked} onClick={onDelete}>
          <Trash2 size={14} />{text("삭제", "Delete")}
        </button>
      </div>
    </li>
  );
}

/**
 * 외부 Git 작업을 보고 재적용을 내미는 자리(C19-3).
 *
 * 버튼이 "적용"이 아니라 "적용 검사"인 것이 이 배너의 핵심이다. C19-3은 앱이 시작한 Git
 * 작업 뒤에만 자동 검사·적용을 허용하고, 터미널 같은 외부 작업에 대해서는 **검사 결과와
 * 적용 버튼만 내밀라**고 못박았다. 사람이 터미널에서 무엇을 하던 중인지 앱은 모르기 때문에,
 * 그 한가운데 작업 트리를 바꾸면 되돌릴 기준점 자체가 흔들린다. 검사를 거치면 그 결말이
 * 영수증으로 남고(`applicable` 또는 `overlayNeedsResolution`), 적용은 세트 행의 버튼으로
 * 사용자가 따로 누른다.
 */
function OverlayDriftBanner({ entries, locked, onCheck }: {
  entries: readonly ProjectOverlayDriftEntry[];
  locked: boolean;
  onCheck: (setId: string) => void;
}) {
  const { text } = useI18n();
  return (
    <div className="notice-banner overlay-drift" role="note" data-overlay-drift-banner="external">
      <span>
        <AlertTriangle size={14} />
        {text(
          "앱 밖에서 브랜치가 바뀌었습니다. 보관해 둔 overlay가 지금 작업 트리에 들어가 있지 않습니다.",
          "The branch moved outside the app. Your stored overlay is not in the worktree right now.",
        )}
      </span>
      <span className="muted">
        {text(
          "자동으로 적용하지 않습니다 — 먼저 적용할 수 있는지 검사하세요.",
          "Nothing is applied automatically — check first whether it still applies.",
        )}
      </span>
      <ul className="overlay-drift-sets">
        {entries.map((entry) => (
          <li key={entry.setId} data-overlay-drift-set={entry.setId}>
            <strong>{entry.name}</strong>
            {entry.baseHead && <code>{entry.baseHead.slice(0, 8)}</code>}
            <button
              className="button"
              type="button"
              data-overlay-action="drift-check"
              disabled={locked}
              onClick={() => onCheck(entry.setId)}
            >
              {text("적용 검사", "Check")}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 영수증 하나(C19-5). `overlayNeedsResolution`은 실패가 아니라 "아무것도 적용하지 않았다"는
 * 결말이므로 오류 배너가 아니라 여기에 충돌 경로와 함께 적는다. 거절된 경로는 사유와 같이
 * 보인다 — C19-2가 조용한 누락을 금지한 자리다.
 */
function OverlayReceiptBanner({ receipt, locked, onExclude, onViewPatchPath }: {
  receipt: ProjectOverlayReceipt;
  locked: boolean;
  /** 막은 경로를 세트에서 빼는 자리(C19-3). 세트 id를 모르는 영수증에서는 내밀지 않는다. */
  onExclude: (setId: string, path: string) => void;
  /**
   * 막은 경로의 patch 구간을 바로 여는 자리. "빼기"만 내밀면 사용자가 고를 수 있는 것은
   * 그 변경을 버리는 쪽뿐인데, 버리기 전에 무엇을 버리는지는 봐야 한다. 읽기라 `locked`에
   * 묶지 않는다(C19-4).
   */
  onViewPatchPath: (setId: string, path: string) => void;
}) {
  const { text } = useI18n();
  const needsResolution = receipt.outcome === "overlayNeedsResolution";
  // 막은 경로마다 "빼기"를 내미는 이유. 지금까지 사용자에게 남은 길은 충돌한 파일을 손으로
  // 정리하거나 세트를 통째로 버리는 둘뿐이었는데, 버리면 **막지 않은 나머지 경로의 로컬
  // 설정까지** 같이 사라진다. 막는 것은 보통 세트 안의 한 파일이므로, 그 하나만 빼면
  // 나머지는 그대로 적용된다(C19-3 충돌 해결).
  const canExclude = needsResolution && typeof receipt.setId === "string" && receipt.setId !== "";
  return (
    <div className={`notice-banner overlay-receipt${needsResolution ? " overlay-receipt-conflict" : ""}`} role="note" data-overlay-outcome={receipt.outcome}>
      <span>{receipt.message}</span>
      {needsResolution && (
        <span className="muted">
          {text("검사가 실패해 아무것도 적용하지 않았습니다.", "The check failed, so nothing was applied.")}
        </span>
      )}
      {receipt.affected.length > 0 && (
        <ul className="overlay-receipt-paths">
          {receipt.affected.map((path) => (
            <li key={path}>
              <code>{path}</code>
              {canExclude && (
                <button
                  className="button"
                  type="button"
                  data-overlay-action="view-patch-path"
                  onClick={() => onViewPatchPath(receipt.setId as string, path)}
                >
                  {text("patch에서 보기", "Show in patch")}
                </button>
              )}
              {canExclude && (
                <button
                  className="button"
                  type="button"
                  data-overlay-action="exclude"
                  disabled={locked}
                  onClick={() => onExclude(receipt.setId as string, path)}
                >
                  {text("세트에서 빼기", "Drop from set")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {receipt.rejected.length > 0 && (
        <ul className="overlay-receipt-rejected">
          {receipt.rejected.map((entry) => (
            <li key={entry.path}><code>{entry.path}</code> — {entry.reason}</li>
          ))}
        </ul>
      )}
      {receipt.headBefore && (
        <span className="muted">{text("기준 커밋", "Base commit")} {receipt.headBefore.slice(0, 8)}</span>
      )}
    </div>
  );
}

/**
 * 보관된 patch 본문을 그대로 보여 주는 자리(C19-5).
 *
 * 왜 화면에 필요한가. 스냅샷이 끝나면 작업 트리는 HEAD 원본으로 돌아가고, 사용자가 하던
 * 변경의 유일한 사본은 앱 데이터 안의 patch가 된다. `apply`가 `overlayNeedsResolution`으로
 * 막히면 화면에 남는 것은 충돌한 **경로 이름**뿐이라, 그 파일에 무엇을 적어 두었는지는 알
 * 길이 없었다 — patch 파일은 남아 있는데 열 수 없는 상태였고, 그것은 "patch를 잃는 경로는
 * 어디에도 없다"는 C19-5의 약속을 글자로만 지키는 것이다.
 *
 * 본문은 가공하지 않는다. 통일 diff를 색칠하거나 접으면 사용자가 손으로 옮겨 적을 때
 * 원문과 달라질 수 있고, 이 화면의 쓰임이 바로 그 옮겨 적기다.
 *
 * 2026-10-04에 더한 것은 **자르기뿐이고 가공이 아니다.** 세트에 파일이 여럿이고 본문이
 * 수백 KB면 영수증이 말한 충돌 경로를 눈으로 찾아야 했다. 그래서 `overlayPatchSections`로
 * 파일별 구간을 갈라 앵커를 달고 머리에 경로 목록을 두어 그 자리로 스크롤만 한다. 구간을
 * 순서대로 이으면 원문과 바이트까지 같고(`sectionsJoinToOriginal`이 그것을 렌더 직전에
 * 다시 확인한다), 한 글자라도 어긋나면 자르지 않고 통째로 그린다 — 옮겨 적을 원문이
 * 가공된 것보다는 찾기 불편한 편이 낫다.
 */
function OverlayPatchView({ patch, focusPath, onClose }: {
  patch: ProjectOverlayPatch;
  /** 열자마자 스크롤해 둘 경로. 없으면 머리부터 본다. */
  focusPath: string | null;
  onClose: () => void;
}) {
  const { text } = useI18n();
  const sections = overlayPatchSections(patch.text);
  // 자르기가 원문을 손상했으면 자르지 않는다. 이 화면의 계약은 "원문 그대로"가 먼저다.
  const faithful = sections.length > 1 && sectionsJoinToOriginal(patch.text, sections);
  const anchors = useRef(new Map<number, HTMLSpanElement>());
  const focusIndex = focusPath === null ? -1 : overlayPatchSectionIndex(sections, focusPath);

  useEffect(() => {
    if (!faithful || focusIndex < 0) return;
    anchors.current.get(focusIndex)?.scrollIntoView({ block: "start" });
  }, [faithful, focusIndex, patch.setId]);

  return (
    <section className="overlay-patch-view" data-overlay-patch={patch.setId}>
      <div className="overlay-patch-head">
        <strong>{patch.name}</strong>
        {patch.baseHead && <code>{patch.baseHead.slice(0, 8)}</code>}
        <span className="muted">{patch.bytes.toLocaleString()} B</span>
        <button className="button" type="button" data-overlay-action="close-patch" onClick={onClose}>
          {text("닫기", "Close")}
        </button>
      </div>
      {!patch.digestMatches && patch.storedDigest !== null && (
        <NoticeBanner
          message={text(
            "보관 시점과 다른 patch입니다. 이 상태에서는 적용도 거절됩니다.",
            "This patch differs from what was stored; applying it is refused in this state.",
          )}
        />
      )}
      {patch.reason && <NoticeBanner message={patch.reason} />}
      {faithful && (
        <ul className="overlay-patch-index" data-overlay-patch-index={sections.length}>
          {sections.map((section, index) => section.path === null ? null : (
            <li key={`${section.path}:${index}`}>
              <button
                className="button"
                type="button"
                data-overlay-patch-jump={section.path}
                aria-current={index === focusIndex ? "true" : undefined}
                onClick={() => anchors.current.get(index)?.scrollIntoView({ block: "start" })}
              >
                <code>{section.path}</code>
              </button>
            </li>
          ))}
        </ul>
      )}
      {focusPath !== null && faithful && focusIndex < 0 && (
        <NoticeBanner
          message={text(
            `보관한 patch에 ${focusPath} 구간이 없습니다.`,
            `The stored patch has no section for ${focusPath}.`,
          )}
        />
      )}
      {patch.text === null ? (
        <EmptyState title={text("보여 줄 patch 본문이 없습니다", "No patch body to show")} />
      ) : faithful ? (
        <pre className="overlay-patch-body"><code>{sections.map((section, index) => (
          <span
            key={index}
            data-overlay-patch-file={section.path ?? undefined}
            ref={(node) => { if (node) anchors.current.set(index, node); else anchors.current.delete(index); }}
          >{section.text}</span>
        ))}</code></pre>
      ) : (
        <pre className="overlay-patch-body"><code>{patch.text}</code></pre>
      )}
    </section>
  );
}
