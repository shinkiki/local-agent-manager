import { useEffect, useRef, useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { writeClipboardText } from "../lib/clipboard";
import { useI18n } from "../lib/i18n";

type CopyKind = "response" | "section" | "code" | "path";
type CopyState = "idle" | "copying" | "copied" | "failed";

export function CopyAction({
  value,
  kind,
  className = "",
  disabled = false,
}: {
  /**
   * 문자열이거나, 누를 때 값을 만드는 함수. 함수형은 렌더 시점에 값을 만들지 않으므로
   * 화면에 눌리지도 않을 복사 대상을 미리 뽑아 두는 비용을 없앤다.
   */
  value: string | (() => string);
  kind: CopyKind;
  className?: string;
  disabled?: boolean;
}) {
  const { text } = useI18n();
  const [state, setState] = useState<CopyState>("idle");
  const resetTimerRef = useRef<number | null>(null);
  const baseLabel = kind === "response"
    ? text("응답 복사", "Copy response")
    : kind === "section"
      ? text("섹션 복사", "Copy section")
      : kind === "path"
        ? text("경로 복사", "Copy path")
        : text("코드 복사", "Copy code");
  const stateLabel = state === "copied"
    ? text("복사됨", "Copied")
    : state === "failed"
      ? text("복사 실패", "Copy failed")
      : state === "copying"
        ? text("복사 중…", "Copying…")
        : baseLabel;
  const disabledLabel = text("응답 완료 후 복사할 수 있습니다.", "You can copy after the response is complete.");

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const copy = async () => {
    if (disabled || state === "copying") return;
    const resolved = typeof value === "function" ? value() : value;
    if (!resolved) return;
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    setState("copying");
    try {
      await writeClipboardText(resolved);
      setState("copied");
    } catch {
      setState("failed");
    }
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null;
      setState("idle");
    }, 1_800);
  };

  const Icon = state === "copied" ? Check : state === "failed" ? TriangleAlert : Copy;
  return (
    <button
      className={`copy-action copy-action-${state}${className ? ` ${className}` : ""}`}
      type="button"
      disabled={disabled || !value || state === "copying"}
      aria-label={disabled ? disabledLabel : stateLabel}
      title={disabled ? disabledLabel : stateLabel}
      onClick={() => void copy()}
    >
      <Icon size={13} aria-hidden="true" />
      <span className="copy-action-label" aria-hidden="true">{stateLabel}</span>
      <span className="copy-action-announcement" role="status" aria-live="polite">{state === "idle" ? "" : stateLabel}</span>
    </button>
  );
}
