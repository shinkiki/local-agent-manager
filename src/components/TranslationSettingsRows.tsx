import { Eraser, RefreshCw } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { AppToggle } from "./Shared";
import type { AppLocale, TranslationMenu, TranslationStatus } from "../types";

/** 자동번역을 켤 수 있는 메뉴. 목록 순서가 화면 순서다. */
export const TRANSLATION_MENUS: TranslationMenu[] = ["instructions", "skills", "agents", "artifacts"];

export function translationMenuLabel(menu: TranslationMenu, text: (ko: string, en: string) => string): string {
  if (menu === "skills") return text("스킬", "Skills");
  if (menu === "agents") return text("에이전트", "Agents");
  if (menu === "artifacts") return text("아티팩트", "Artifacts");
  return text("지침", "Instructions");
}

/**
 * 번역 메뉴 행 안의 확인 상자. 번역 시작과 번역 초기화 두 자리가 문구와 확인 버튼 이름만
 * 다르고 모양이 같아 한 벌로 모은다.
 */
function TranslationConfirmBox({ message, confirmLabel, saving, onCancel, onConfirm }: {
  message: string;
  confirmLabel: string;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { text } = useI18n();
  return <div className="translation-toggle-confirm" role="alert">
    <p>{message}</p>
    <div>
      <button className="button secondary compact" type="button" disabled={saving} onClick={onCancel}>{text("취소", "Cancel")}</button>
      <button className="button primary compact" type="button" disabled={saving} onClick={onConfirm}>{confirmLabel}</button>
    </div>
  </div>;
}

/**
 * 자동번역 메뉴 한 행. 상태 문구와 조작부, 그리고 확인 상자 두 자리를 그린다. 켜고 끄는
 * 판단과 확인 상자를 여는 상태는 모두 부모가 들고 있어, 이 행은 받은 값만 표시한다.
 */
export function TranslationMenuRow({ label, status, enabled, readOnly, saving, confirmReset, confirmStart, errorMessage, onRetry, onRequestReset, onCancelReset, onConfirmReset, onCancelStart, onConfirmStart, onToggle }: {
  label: string;
  status: TranslationStatus;
  enabled: boolean;
  readOnly: boolean;
  saving: boolean;
  confirmReset: boolean;
  confirmStart: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  onRequestReset: () => void;
  onCancelReset: () => void;
  onConfirmReset: () => void;
  onCancelStart: () => void;
  onConfirmStart: () => void;
  onToggle: (next: boolean) => void;
}) {
  const { locale, text } = useI18n();
  return <div className={`translation-toggle-row ${status.phase}${enabled ? " enabled" : ""}`}>
    <div className="translation-toggle-main">
      <span><strong>{label}</strong><small>{translationStatusText(status, locale)}</small></span>
      <div className="translation-toggle-actions">
        {(status.phase === "partial" || status.phase === "error") && <button className="button secondary compact" type="button" disabled={saving || readOnly} onClick={onRetry}><RefreshCw size={13} />{text("재시도", "Retry")}</button>}
        {status.total > 0 && <button className="button secondary compact" type="button" disabled={saving || readOnly} onClick={onRequestReset}><Eraser size={13} />{text("번역 초기화", "Reset translation")}</button>}
        <AppToggle checked={enabled} disabled={saving || readOnly} label={label} onChange={onToggle} />
      </div>
    </div>
    {confirmReset && <TranslationConfirmBox
      message={text("저장된 번역을 모두 지우고 처음부터 다시 번역합니다. 선택한 CLI 사용량이 다시 발생합니다.", "Discards every stored translation and translates from scratch, spending the selected CLI quota again.")}
      confirmLabel={text("번역 초기화", "Reset translation")}
      saving={saving}
      onCancel={onCancelReset}
      onConfirm={onConfirmReset}
    />}
    {confirmStart && <TranslationConfirmBox
      message={text("전체 데이터를 백그라운드에서 번역하며 선택한 CLI 사용량이 발생합니다.", "All data will be translated in the background using the selected CLI quota.")}
      confirmLabel={text("번역 시작", "Start translation")}
      saving={saving}
      onCancel={onCancelStart}
      onConfirm={onConfirmStart}
    />}
    {errorMessage && <p role="alert">{errorMessage}</p>}
    {status.lastError && <p title={status.lastError}>{status.lastError}</p>}
  </div>;
}

export function translationStatusText(status: TranslationStatus, locale: AppLocale): string {
  const labels: Record<string, [string, string]> = {
    disabled: ["목록과 상세 내용을 자동번역합니다", "Translates list and detail content"], queued: ["대기 중", "Queued"], running: ["번역 중", "Translating"],
    complete: ["완료", "Complete"], partial: ["일부 실패", "Partially failed"], paused: ["일시중지", "Paused"], error: ["오류", "Error"],
  };
  const label = labels[status.phase] ?? [status.phase, status.phase];
  const segmentCount = status.segmentTotal > status.total
    ? locale === "ko"
      ? ` · 요청 ${status.segmentCompleted + status.segmentFailed}/${status.segmentTotal}`
      : ` · requests ${status.segmentCompleted + status.segmentFailed}/${status.segmentTotal}`
    : "";
  const fieldCount = status.total > 0
    ? locale === "ko"
      ? ` · 항목 ${status.completed + status.failed}/${status.total}`
      : ` · items ${status.completed + status.failed}/${status.total}`
    : "";
  // 캐시를 재사용한 항목은 이번 실행 대상이 아니므로 따로 표시한다.
  const cachedCount = status.cached > 0
    ? locale === "ko" ? ` · 캐시 재사용 ${status.cached}` : ` · reused ${status.cached}`
    : "";
  return `${label[locale === "ko" ? 0 : 1]}${fieldCount}${cachedCount}${segmentCount}`;
}
