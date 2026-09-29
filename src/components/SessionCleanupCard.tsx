/**
 * 세션 자동정리 카드(`C11`). 설정 → CLI 설정 탭에 있던 것을 저장소 → 데이터 탭으로 옮겼다 —
 * 세션 실체를 회수해 용량을 돌리는 일이라 저장소 수치 아래에 서는 편이 읽힌다.
 *
 * 동작·문구·anchor 이름(`storage.session-cleanup`)만 자리를 옮겼고, 카드 안의 조각 넷과
 * 숫자 입력·조건 행은 설정 화면에서 그대로 가져왔다.
 */
import { Eraser, RefreshCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearSessionCleanupTombstones, getSessionCleanupStatus, getWebAccessStatus, runSessionCleanup, setSessionCleanupPolicy, type WebAccessStatus } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { canClearTombstones, canRunCleanup, cleanupBlockedReason, formatBytes, hasAnyCondition, previewSummary, reasonHint, receiptFailed, receiptSummary, shrinkFactor, type CleanupAccess } from "../lib/sessionCleanup";
import type { SessionCleanupPolicy, SessionCleanupPreview, SessionCleanupReceipt, SessionCleanupStatus } from "../types";
import { AppToggle, ErrorBanner, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";

/*
 * 아래 세 껍데기(`loadWhileMounted`·`useCardTask`·`useLoadOnActiveEntry`)는 SettingsView.tsx의
 * 같은 이름 함수를 그대로 옮겨 적은 것이다. 설정 화면의 다른 카드들이 아직 그쪽 것을 쓰고,
 * 이 카드가 설정 화면 모듈 전체를 끌어오지 않게 하려고 여기 한 벌을 더 둔다. 공용 자리
 * (`src/lib/`)로 걷어 올리는 일은 별도 작업이다.
 */
/**
 * 화면을 떠난 뒤 늦게 도착한 응답은 버리는 조회 한 건.
 *
 * 설정 화면의 카드들은 상태 조회마다 `let disposed = false`를 세우고, then·catch 양쪽에서
 * 그 깃발을 확인하고, effect 정리에서 내리는 껍데기를 똑같이 되풀이했다. 껍데기만 여기로
 * 모은다 — 무엇을 읽고 어디에 적을지, 실패를 어느 자리에 남길지는 부르는 쪽이 그대로 정한다.
 *
 * 돌려주는 함수가 그 깃발을 내리는 정리 함수라 `useEffect`가 그대로 반환하면 된다. 조회를
 * 여러 건 걸었으면 반환받은 함수들을 모아 한 번에 부른다.
 */
function loadWhileMounted<T>(
  fetchStatus: () => Promise<T>,
  apply: (value: T) => void,
  fail?: (message: string) => void,
): () => void {
  let disposed = false;
  void fetchStatus()
    .then((next) => { if (!disposed) apply(next); })
    .catch((cause) => { if (!disposed) fail?.(errorText(cause)); });
  return () => { disposed = true; };
}

/**
 * 설정 화면 카드들의 "한 번에 한 동작" 껍데기 — busy 키를 걸고, 지난 오류·안내를 지우고,
 * 무엇으로 끝나든 busy를 푼다. 라이브러리 저장소·세션 자동정리·CLI 연결 세 카드가 같은 모양을
 * 각자 적어 두고 있었다. 다른 것은 busy 키의 갈래와 실패 문구를 어디에 적느냐뿐이라 껍데기만
 * 여기로 모으고, 그 둘은 부르는 쪽이 정하게 남긴다.
 *
 * 되돌리기 어려운 동작 앞의 확인창도 이 껍데기가 맡는다. 세션 자동정리 셋(켜기·지금 정리·
 * 기록 비우기)과 계정 둘(리셋 크레딧·등록 삭제)이 "묻고, 거절하면 아무것도 하지 않는다"를
 * 각자 `const accepted = await confirm(...)`과 `if (!accepted) return;`으로 적어 두어, 한
 * 자리에서 빠뜨려도 드러나지 않았다. `confirm`에 null을 주면 묻지 않는 것이라, 켤 때만 묻는
 * 자리는 삼항 하나로 방향을 고르면 된다(`useBackendTask`와 같은 모양).
 *
 * `run`은 성공하면 null을, 실패하면 실패 문구를 돌려준다. 확인창에서 거절하면 아무것도 하지
 * 않고 null을 돌려준다 — busy도 걸지 않고 지난 오류·안내도 그대로 둔다. 기본은 실패 문구를
 * 카드의 오류 배너(`error`)에 적고, `quiet`를 켜면 배너를 건드리지 않고 문구만 돌려준다 — 편집 대화상자 안처럼
 * 실패를 다른 자리에 적어야 하는 호출이 쓴다. 성공했을 때 무엇을 적을지는 이 껍데기가 정하지
 * 않는다: 세션 정리 회차처럼 예외 없이 끝나고도 영수증의 실패 건수로 오류를 적어야 하는 작업이
 * 있어, 성패를 대신 판단할 수 없다.
 *
 * 백엔드 서비스 카드의 `useBackendTask`는 한 카드가 네 개를 따로 쥐고 동시에 돌리는 다른
 * 모양이라 여기로 합치지 않는다 — 합치면 포트 저장과 Tailscale 토글이 서로를 잠근다.
 */
function useCardTask<Key extends string>(clearNotice: () => void) {
  const [busy, setBusy] = useState<Key | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    key: Key,
    action: () => Promise<void>,
    options: { quiet?: boolean; confirm?: (() => Promise<boolean>) | null } = {},
  ): Promise<string | null> => {
    if (options.confirm && !(await options.confirm())) return null;
    setBusy(key);
    setError(null);
    clearNotice();
    try {
      await action();
      return null;
    } catch (cause) {
      const message = errorText(cause);
      if (!options.quiet) setError(message);
      return message;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, setError, run };
}

/**
 * 설정 화면은 한 번 열면 언마운트되지 않으므로(App의 `mountedViews`는 누적형) 탭을 벗어났다
 * 돌아올 때마다 한 번씩 다시 읽어야 바뀐 결과가 화면에 반영된다. 모델 카탈로그·세션 자동정리·
 * CLI 업데이트 세 자리가 "활성이 아니면 읽었다는 표시를 풀고, 이미 읽었으면 넘기고, 아니면
 * 표시를 세우고 읽는다"를 각자 적어 두고 있었다. 그 껍데기만 여기로 모은다.
 *
 * `load`가 정리 함수를 돌려주면(예: `loadWhileMounted`) 효과의 정리로 그대로 쓰인다. 함께
 * 넘겨받는 `forget`과 이 훅이 돌려주는 값은 같은 함수로, 부르면 "읽었다"는 표시가 풀려 다음
 * 진입을 기다리지 않고 다시 읽을 수 있다 — 실패한 조회를 읽은 것으로 치지 않으려는 자리가 쓴다.
 * `onLeave`는 화면을 벗어날 때 함께 풀어야 하는 다른 표시가 있는 자리를 위한 것이다.
 *
 * 읽는 함수의 정체성은 일부러 의존성에 넣지 않는다. 표시가 서 있는 동안에는 어차피 다시 읽지
 * 않으므로, 매 렌더 새로 만들어지는 함수를 넣어도 결과가 같다.
 */
function useLoadOnActiveEntry(
  active: boolean,
  load: (forget: () => void) => void | (() => void),
  onLeave?: () => void,
): () => void {
  const loadedRef = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const leaveRef = useRef(onLeave);
  leaveRef.current = onLeave;
  const forget = useCallback(() => { loadedRef.current = false; }, []);
  useEffect(() => {
    if (!active) {
      loadedRef.current = false;
      leaveRef.current?.();
      return undefined;
    }
    if (loadedRef.current) return undefined;
    loadedRef.current = true;
    return loadRef.current(forget) ?? undefined;
  }, [active, forget]);
  return forget;
}

/**
 * 저장된 값을 초깃값으로 삼되 타이핑 중에는 건드리지 않는 숫자 입력.
 *
 * 저장본을 그대로 `value`에 물리면 "300"을 치는 동안 3과 30이 각각 저장되고, 하한에
 * 걸린 중간값이 입력칸을 덮어써 타이핑이 뒤집힌다. 그래서 편집 중에는 글자를 그대로
 * 들고 있다가 포커스를 벗어나거나 Enter를 칠 때 한 번만 올려보낸다.
 */
function CleanupNumberInput({ value, min, max, label, disabled, onCommit }: {
  value: number;
  min: number;
  max?: number;
  label: string;
  disabled: boolean;
  onCommit: (next: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    // 빈 칸이나 범위를 벗어난 값은 저장하지 않고 마지막 저장본으로 되돌린다.
    if (!Number.isFinite(parsed) || draft.trim() === "") return;
    const clamped = Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, Math.trunc(parsed)));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      type="number"
      className="session-cleanup-number"
      min={min}
      max={max}
      value={draft ?? String(value)}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(null);
      }}
    />
  );
}

/** 조건 입력 한 줄. 끄면 `null`이 되고, 켜면 마지막 값(없으면 기본값)으로 돌아온다. */
function CleanupConditionRow({ label, hint, value, unit, min, max, fallback, disabled, onChange }: {
  label: string;
  hint: string;
  value: number | null;
  unit: string;
  min: number;
  /** 크게 잡을수록 더 지우는 조건에만 준다. */
  max?: number;
  fallback: number;
  disabled: boolean;
  onChange: (next: number | null) => void;
}) {
  const enabled = value !== null;
  return (
    <div className={`session-cleanup-condition${enabled ? " enabled" : ""}`}>
      <AppToggle
        checked={enabled}
        disabled={disabled}
        label={label}
        onChange={(checked) => onChange(checked ? fallback : null)}
      />
      <span className="session-cleanup-condition-copy">
        <strong>{label}</strong>
        <small className="session-cleanup-hint">{hint}</small>
      </span>
      <span className="session-cleanup-condition-value">
        {value === null
          ? <input type="number" className="session-cleanup-number" value="" disabled aria-label={label} />
          : <CleanupNumberInput value={value} min={min} max={max} label={label} disabled={disabled} onCommit={onChange} />}
        <span className="session-cleanup-unit">{unit}</span>
      </span>
    </div>
  );
}

/**
 * 세션 자동정리 카드(`C11`).
 *
 * 정리는 두 갈래라서 화면도 그렇게 말한다 — 목록에서 내리는 몫과 실체를 회수하는 몫이
 * 같지 않다. 공유 공급자 홈의 원문은 지우지 않으므로 대부분의 세션은 "목록에서만 내림"이
 * 되고, 용량이 실제로 도는 것은 앱 데이터 안에 있는 것뿐이다.
 *
 * 조건별 적중 건수를 미리보기로 함께 보여 준다. 보존 기간처럼 켜 두면 뭔가 하는 줄 알기
 * 쉬운 조건이 있는데, 실제로 몇 건을 잡는지는 데이터마다 다르다.
 */
export function SessionCleanupCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [status, setStatus] = useState<SessionCleanupStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, setError, run: runCleanupTask } = useCardTask<"save" | "run" | "clear">(() => setNotice(null));

  useEffect(() => loadWhileMounted(getWebAccessStatus, setAccess), []);

  const loadStatus = useCallback((forget: () => void) => {
    setError(null);
    return getSessionCleanupStatus()
      .then(setStatus)
      .catch((cause: unknown) => {
        setError(errorText(cause));
        // 실패한 조회는 "읽었다"로 치지 않는다. 그대로 두면 탭을 벗어났다 돌아오기
        // 전까지 다시 시도하지 않아, 한 번 실패한 카드가 계속 비어 있다.
        forget();
      });
  }, []);

  const forgetStatus = useLoadOnActiveEntry(active, (forget) => { void loadStatus(forget); });

  // 조회에 실패하면 카드를 통째로 접지 말고 실패를 말한다. `return null`로 접으면
  // 오류 배너까지 함께 사라져 아무 일도 없었던 화면이 된다.
  if (!status) {
    if (!error) return null;
    return (
      <section className="settings-card session-cleanup-card" data-ui-anchor="storage.session-cleanup">
        <header>
          <div><span>{text("세션", "Sessions")}</span><h2>{text("세션 자동정리", "Automatic session cleanup")}</h2></div>
        </header>
        <div className="settings-update-body">
          <span className="settings-update-status">
            <strong>{text("상태를 읽지 못했습니다", "Could not read the status")}</strong>
          </span>
          <button className="button compact" type="button" onClick={() => void loadStatus(forgetStatus)}>
            <RefreshCw size={13} />{text("다시 시도", "Retry")}
          </button>
        </div>
        <ErrorBanner message={error} />
      </section>
    );
  }
  const { policy, preview } = status;
  const cleanupAccess = { writable: access?.writable === true, busy: busy !== null };
  const locked = !cleanupAccess.writable || busy !== null;
  const blocked = cleanupBlockedReason(status, cleanupAccess);

  /** 작업이 바꾼 결과를 다시 펴는 자리. 정책 저장은 응답 자체가 최신 상태라 여기를 거치지 않는다. */
  const reloadStatus = async () => { setStatus(await getSessionCleanupStatus()); };

  const savePolicy = (next: SessionCleanupPolicy) =>
    runCleanupTask("save", async () => { setStatus(await setSessionCleanupPolicy(next)); });

  // 조건을 고칠 때마다 저장한다. 저장이 미리보기를 다시 계산해 돌려주므로, 켠 조건이 몇
  // 건을 잡는지 그 자리에서 보인다.
  const patchPolicy = (patch: Partial<SessionCleanupPolicy>) => void savePolicy({ ...policy, ...patch });

  // 켜기는 되돌리기 어려운 결정이라 지금 조건이 무엇을 지울지 한 번 보여 준다.
  const toggleEnabled = (enabled: boolean) => runCleanupTask("save", async () => {
    setStatus(await setSessionCleanupPolicy({ ...policy, enabled }));
  }, {
    confirm: enabled ? () => confirm({
      title: text("세션 자동정리를 켤까요?", "Turn on automatic session cleanup?"),
      message: text(
        `지금 조건이라면 ${preview.targetCount.toLocaleString()}건을 정리합니다.\n앞으로 ${policy.intervalHours}시간마다 확인 없이 실행됩니다.`,
        `With the current conditions this would clean ${preview.targetCount.toLocaleString()} sessions.\nIt will then run every ${policy.intervalHours} hours without asking.`,
      ),
      items: [
        text(`실체 회수 ${preview.removableCount.toLocaleString()}건 · ${formatBytes(preview.removableBytes)}`, `${preview.removableCount.toLocaleString()} transcripts reclaimed · ${formatBytes(preview.removableBytes)}`),
        text(`목록에서만 내림 ${(preview.targetCount - preview.removableCount).toLocaleString()}건 (공급자 홈 원문은 그대로)`, `${(preview.targetCount - preview.removableCount).toLocaleString()} hidden from the list only (provider-home transcripts untouched)`),
        text(`보호로 건너뜀 ${preview.protectedCount.toLocaleString()}건`, `${preview.protectedCount.toLocaleString()} protected`),
      ],
      warning: text(
        `지운 실체는 휴지통에 ${policy.trashRetentionDays}일 보관한 뒤 완전 삭제됩니다.`,
        `Removed content stays in the trash for ${policy.trashRetentionDays} days before it is purged.`,
      ),
      confirmLabel: text("자동정리 켜기", "Turn on"),
      tone: "danger",
    }) : null,
  });

  const runNow = () => runCleanupTask("run", async () => {
    const receipt: SessionCleanupReceipt = await runSessionCleanup();
    const summary = receiptSummary(receipt, text);
    // 성패는 예외가 아니라 영수증의 실패 건수로 가른다.
    if (receiptFailed(receipt)) setError(summary);
    else setNotice(summary);
    await reloadStatus();
  }, {
    confirm: () => confirm({
      title: text("지금 정리할까요?", "Clean up now?"),
      message: text(
        `조건에 걸리는 ${preview.targetCount.toLocaleString()}건을 정리합니다.`,
        `This cleans the ${preview.targetCount.toLocaleString()} sessions matching the conditions.`,
      ),
      items: [previewSummary(preview, text)],
      warning: text(
        "공급자 홈의 대화 원문은 삭제하지 않습니다. 목록에서 내린 세션은 정리 기록을 비우면 되돌아옵니다.",
        "Conversation transcripts in provider homes are never deleted. Sessions hidden from the list come back when the cleanup record is cleared.",
      ),
      confirmLabel: text("정리", "Clean up"),
      tone: "danger",
    }),
  });

  const clearTombstones = () => runCleanupTask("clear", async () => {
    const restored = await clearSessionCleanupTombstones();
    setNotice(text(`정리 기록 ${restored.toLocaleString()}건을 비웠습니다.`, `Cleared ${restored.toLocaleString()} cleanup records.`));
    await reloadStatus();
  }, {
    confirm: () => confirm({
      title: text("정리 기록을 비울까요?", "Clear the cleanup record?"),
      message: text(
        `목록에서 내린 ${status.tombstoneCount.toLocaleString()}건이 다음 재조사에서 되돌아옵니다.`,
        `The ${status.tombstoneCount.toLocaleString()} hidden sessions return on the next catalog scan.`,
      ),
      warning: text(
        "휴지통에서 이미 완전 삭제된 실체는 돌아오지 않습니다. 정리할 때 함께 지운 즐겨찾기·메모·폴더 배정도 복구되지 않습니다.",
        "Content already purged from the trash does not come back, and the favorites, notes, and folder assignments removed with each session are not restored either.",
      ),
      confirmLabel: text("기록 비우기", "Clear"),
    }),
  });

  return (
    <section className="settings-card session-cleanup-card" data-ui-anchor="storage.session-cleanup">
      <header>
        <div><span>{text("세션", "Sessions")}</span><h2>{text("세션 자동정리", "Automatic session cleanup")}</h2></div>
        <p>{text(
          "조건에 걸린 세션을 목록에서 내리고, 앱 데이터 안에 있는 실체만 휴지통으로 회수합니다. 공급자 홈의 대화 원문은 읽기만 하며 삭제하지 않습니다.",
          "Sessions matching the conditions are removed from the list, and only content inside the app data directory is moved to the trash. Conversation transcripts in provider homes are read-only and never deleted.",
        )}</p>
      </header>

      <SessionCleanupOverview
        status={status}
        access={cleanupAccess}
        busy={busy}
        blocked={blocked}
        onClearTombstones={() => void clearTombstones()}
        onRunNow={() => void runNow()}
      />

      <SessionCleanupConditions
        policy={policy}
        preview={preview}
        locked={locked}
        onPatch={patchPolicy}
      />

      <SessionCleanupSchedule
        status={status}
        policy={policy}
        locked={locked}
        onPatch={patchPolicy}
        onToggleEnabled={(checked) => void toggleEnabled(checked)}
      />
      {!cleanupAccess.writable && <small className="settings-storage-note">{text("원격 변경이 비활성화되어 있습니다.", "Remote changes are disabled.")}</small>}

      <SessionCleanupReceipts receipts={status.receipts} />

      {notice && <p className="account-action-notice" role="status">{notice}</p>}
      {error && <ErrorBanner message={error} />}
      {confirmDialog}
    </section>
  );
}

/**
 * 세션 자동정리 카드의 네 구획(개요·정리 조건·운영 설정·최근 정리)을 그리는 조각들.
 *
 * 카드 하나가 상태 네 칸과 확인창 딸린 동작 셋을 쥐고, 그 아래로 180줄짜리 화면까지 이어
 * 붙어 있어 "무엇을 하는가"와 "어떻게 보이는가"가 한 함수 안에서 섞였다. 그리는 쪽만 아래로
 * 떼면 카드 함수에는 조회·저장·정리 세 동작과 배치만 남는다.
 *
 * 네 조각 모두 상태를 들지 않는다 — 값과 손잡이를 받아 그리기만 하므로, 정책을 고칠 때마다
 * 저장이 되돌려 주는 최신 상태가 그대로 내려온다는 원래 흐름이 달라지지 않는다.
 */
function SessionCleanupOverview({ status, access, busy, blocked, onClearTombstones, onRunNow }: {
  status: SessionCleanupStatus;
  access: CleanupAccess;
  busy: "save" | "run" | "clear" | null;
  /** 지금 정리를 돌릴 수 없는 사유. 없으면 버튼 설명을 그대로 쓴다. */
  blocked: string | null;
  onClearTombstones: () => void;
  onRunNow: () => void;
}) {
  const { text } = useI18n();
  const { preview } = status;
  const factor = shrinkFactor(preview);
  return (
    <div className="session-cleanup-overview">
      <div className="session-cleanup-overview-panel">
        <span className="settings-update-status">
          <strong>{text("현재 세션", "Current sessions")}</strong>
          <small>{text(
            `전체 ${status.sessionCount.toLocaleString()}건 · 목록에서 내린 ${status.tombstoneCount.toLocaleString()}건`,
            `${status.sessionCount.toLocaleString()} total · ${status.tombstoneCount.toLocaleString()} hidden by cleanup`,
          )}</small>
        </span>
        <button
          className="button compact"
          type="button"
          disabled={!canClearTombstones(status, access)}
          title={text("목록에서 내린 세션을 모두 되돌립니다", "Bring every hidden session back")}
          onClick={onClearTombstones}
        ><Undo2 size={13} />{busy === "clear" ? text("되돌리는 중…", "Restoring…") : text("정리 기록 비우기", "Clear record")}</button>
      </div>

      <div className="session-cleanup-overview-panel target">
        <span className="settings-update-status">
          <strong>{text("다음 정리 예상", "Next cleanup estimate")}</strong>
          <small>{previewSummary(preview, text)}</small>
          {factor !== null && <small className="session-cleanup-factor">{text(
            `정리 후 ${preview.remainingCount.toLocaleString()}건 · 목록 ${factor.toFixed(1)}배 축소`,
            `${preview.remainingCount.toLocaleString()} left · list shrinks ${factor.toFixed(1)}×`,
          )}</small>}
        </span>
        <button
          className="button compact danger-subtle"
          type="button"
          disabled={!canRunCleanup(status, access)}
          title={blocked ?? text("지금 한 회차를 돌립니다", "Run one pass now")}
          onClick={onRunNow}
        ><Eraser size={13} />{busy === "run" ? text("정리 중…", "Cleaning…") : text("지금 정리", "Clean up now")}</button>
      </div>
    </div>
  );
}

function SessionCleanupConditions({ policy, preview, locked, onPatch }: {
  policy: SessionCleanupPolicy;
  preview: SessionCleanupPreview;
  locked: boolean;
  onPatch: (patch: Partial<SessionCleanupPolicy>) => void;
}) {
  const { text } = useI18n();
  return <>
    <div className="session-cleanup-section-heading">
      <strong>{text("정리 조건", "Cleanup rules")}</strong>
      <small>{text("필요한 조건만 켜고 기준값을 지정하세요.", "Enable only the rules you need and set their thresholds.")}</small>
    </div>
    <div className="session-cleanup-condition-groups">
      <section className="session-cleanup-condition-group">
        <header>
          <strong>{text("수량 기준", "Count limits")}</strong>
          <small>{text("대화 유형별로 최신 세션을 남깁니다.", "Keep the newest sessions by conversation type.")}</small>
        </header>
        <div className="session-cleanup-conditions">
          <CleanupConditionRow
            label={text("빈 세션", "Empty sessions")}
            hint={reasonHint(preview, "emptySession", text)}
            value={policy.maxMessageCount}
            unit={text("개 이하", "messages or fewer")}
            min={0}
            max={100}
            fallback={1}
            disabled={locked}
            onChange={(next) => onPatch({ maxMessageCount: next })}
          />
          <CleanupConditionRow
            label={text("사용자 대화 상한", "User conversation cap")}
            hint={`${text("공급자별로 최신 건수만 남깁니다.", "Keeps only the newest per provider.")} ${reasonHint(preview, "providerCap", text)}`}
            value={policy.perProviderCap}
            unit={text("건만 남김", "kept")}
            min={10}
            fallback={400}
            disabled={locked}
            onChange={(next) => onPatch({ perProviderCap: next })}
          />
          <CleanupConditionRow
            label={text("자동 실행 상한", "Automated run cap")}
            hint={`${text("반복 요청·워크플로 세션은 일정마다 따로 셉니다. 사용자 대화를 밀어내지 않습니다.", "Scheduled and workflow sessions are counted per schedule, so they never push out user conversations.")} ${reasonHint(preview, "automationCap", text)}`}
            value={policy.perAutomationCap}
            unit={text("건만 남김(일정별)", "kept per schedule")}
            min={1}
            fallback={30}
            disabled={locked}
            onChange={(next) => onPatch({ perAutomationCap: next })}
          />
        </div>
      </section>

      <section className="session-cleanup-condition-group">
        <header>
          <strong>{text("기간 기준", "Age limits")}</strong>
          <small>{text("오래된 세션과 보관 세션을 먼저 정리합니다.", "Prioritize old and archived sessions.")}</small>
        </header>
        <div className="session-cleanup-conditions">
          <CleanupConditionRow
            label={text("보존 기간", "Retention")}
            hint={reasonHint(preview, "retention", text)}
            value={policy.retentionDays}
            unit={text("일 지난 세션", "days and older")}
            min={1}
            fallback={90}
            disabled={locked}
            onChange={(next) => onPatch({ retentionDays: next })}
          />
          <CleanupConditionRow
            label={text("보관 세션", "Archived sessions")}
            hint={reasonHint(preview, "hiddenAged", text)}
            value={policy.hiddenAfterDays}
            unit={text("일 지나면 우선 정리", "days then cleaned first")}
            min={1}
            fallback={7}
            disabled={locked}
            onChange={(next) => onPatch({ hiddenAfterDays: next })}
          />
        </div>
      </section>
    </div>
  </>;
}

function SessionCleanupSchedule({ status, policy, locked, onPatch, onToggleEnabled }: {
  status: SessionCleanupStatus;
  policy: SessionCleanupPolicy;
  locked: boolean;
  onPatch: (patch: Partial<SessionCleanupPolicy>) => void;
  onToggleEnabled: (enabled: boolean) => void;
}) {
  const { text } = useI18n();
  return <>
    <div className="session-cleanup-section-heading">
      <strong>{text("운영 설정", "Schedule and recovery")}</strong>
      <small>{text("실행 주기와 복구 가능 기간을 관리합니다.", "Manage the run interval and recovery window.")}</small>
    </div>
    <div className="session-cleanup-runtime-grid">
      <div className="session-cleanup-runtime-card">
        <span className="settings-update-status">
          <strong>{text("실행 주기", "Interval")}</strong>
          <small>{status.lastRunAt === null
            ? text("아직 실행한 적이 없습니다.", "Has not run yet.")
            : text(`마지막 실행 ${new Date(status.lastRunAt).toLocaleString()}`, `Last run ${new Date(status.lastRunAt).toLocaleString()}`)}</small>
        </span>
        <span className="session-cleanup-condition-value">
          <CleanupNumberInput
            value={policy.intervalHours}
            min={1}
            max={720}
            label={text("실행 주기(시간)", "Interval in hours")}
            disabled={locked}
            onCommit={(next) => onPatch({ intervalHours: next })}
          />
          <span className="session-cleanup-unit">{text("시간마다", "hours")}</span>
        </span>
      </div>

      <div className="session-cleanup-runtime-card">
        <span className="settings-update-status">
          <strong>{text("휴지통 보관", "Trash retention")}</strong>
          <small>{text(
            "기간이 지나기 전에는 회수한 실체를 되돌릴 수 있습니다.",
            "Reclaimed content can be restored until this period ends.",
          )}</small>
        </span>
        <span className="session-cleanup-condition-value">
          <CleanupNumberInput
            value={policy.trashRetentionDays}
            min={1}
            label={text("휴지통 보관 기간(일)", "Trash retention in days")}
            disabled={locked}
            onCommit={(next) => onPatch({ trashRetentionDays: next })}
          />
          <span className="session-cleanup-unit">{text("일", "days")}</span>
        </span>
      </div>

      <div className={`session-cleanup-auto-toggle${policy.enabled ? " enabled" : ""}`}>
        <span>
          <strong>{text("자동 정리", "Automatic cleanup")}</strong>
          <small>{text("확인 없이 설정한 주기마다 정리합니다.", "Runs on the configured interval without asking.")}</small>
        </span>
        <AppToggle
          checked={policy.enabled}
          disabled={locked || !hasAnyCondition(policy)}
          label={text("확인 없이 주기마다 자동으로 정리", "Clean automatically on the interval, without asking")}
          onChange={onToggleEnabled}
        />
      </div>
    </div>
  </>;
}

function SessionCleanupReceipts({ receipts }: { receipts: SessionCleanupReceipt[] }) {
  const { text } = useI18n();
  if (receipts.length === 0) return null;
  return (
    <div className="session-cleanup-receipts">
      <strong>{text("최근 정리", "Recent runs")}</strong>
      <ul>
        {receipts.slice(0, 5).map((receipt) => (
          <li key={receipt.startedAt} className={receiptFailed(receipt) ? "failed" : undefined}>
            <span>{new Date(receipt.startedAt).toLocaleString()}</span>
            <small>{receipt.manual ? text("수동", "Manual") : text("자동", "Automatic")} · {receiptSummary(receipt, text)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
