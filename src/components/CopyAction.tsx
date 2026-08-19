import { useEffect, useRef, useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { writeClipboardText } from "../lib/clipboard";
import { useI18n } from "../lib/i18n";

type CopyKind = "response" | "section" | "code";
type CopyState = "idle" | "copying" | "copied" | "failed";

export function CopyAction({
  value,
  kind,
  className = "",
  disabled = false,
}: {
  value: string;
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
    if (disabled || state === "copying" || !value) return;
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    setState("copying");
    try {
      await writeClipboardText(value);
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
