const RELATIVE_UNITS: readonly [number, string][] = [
  [86_400_000, "일"],
  [3_600_000, "시간"],
  [60_000, "분"],
];

const DATE_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatRelative(timestamp: number | null): string {
  if (!timestamp) return "–";
  const delta = Date.now() - timestamp;
  const future = delta < 0;
  const absolute = Math.abs(delta);
  for (const [size, label] of RELATIVE_UNITS) {
    if (absolute >= size) {
      const value = Math.floor(absolute / size);
      return future ? `${value}${label} 후` : `${value}${label} 전`;
    }
  }
  return future ? "잠시 후" : "방금 전";
}

/**
 * 남은 시간을 두 칸으로 줄인 짧은 표기("5d 12h", "4h 16m", "16m"). 사용량 창 옆처럼
 * 폭이 좁은 자리에 쓰므로 큰 단위 둘까지만 적고, 언어와 무관하게 같은 문자열을 쓴다
 * (숫자와 단위 한 글자뿐이라 번역해 봐야 폭만 흔들린다). 이미 지난 시각은 null이다.
 */
export function formatCountdown(remainingMs: number): string | null {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const days = Math.floor(remainingMs / 86_400_000);
  const hours = Math.floor((remainingMs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return minutes > 0 ? `${minutes}m` : "<1m";
}

export function formatDate(timestamp: number | null): string {
  if (!timestamp) return "–";
  return DATE_FORMATTER.format(new Date(timestamp));
}

export function formatBytes(value: number | null): string {
  if (value === null) return "–";
  let size = value;
  let index = 0;
  while (size >= 1024 && index < BYTE_UNITS.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${BYTE_UNITS[index]}`;
}

export function formatTokens(value: number | null): string {
  if (value === null) return "–";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function sourceName(source: string): string {
  if (source === "claude") return "Claude";
  if (source === "codex") return "Codex";
  return "Antigravity";
}
