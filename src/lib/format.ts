export function formatRelative(timestamp: number | null): string {
  if (!timestamp) return "–";
  const delta = Date.now() - timestamp;
  const future = delta < 0;
  const absolute = Math.abs(delta);
  const units: [number, string][] = [
    [86_400_000, "일"],
    [3_600_000, "시간"],
    [60_000, "분"],
  ];
  for (const [size, label] of units) {
    if (absolute >= size) {
      const value = Math.floor(absolute / size);
      return future ? `${value}${label} 후` : `${value}${label} 전`;
    }
  }
  return "방금 전";
}

export function formatDate(timestamp: number | null): string {
  if (!timestamp) return "–";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function formatBytes(value: number | null): string {
  if (value === null) return "–";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
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
