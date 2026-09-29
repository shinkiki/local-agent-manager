import type { ProviderId } from "../types";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const RELATIVE_UNITS: readonly [number, string][] = [
  [DAY_MS, "일"],
  [HOUR_MS, "시간"],
  [MINUTE_MS, "분"],
];

const DATE_FORMATTER = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const BYTES_PER_UNIT = 1024;
const EMPTY_PLACEHOLDER = "–";

/** 큰 토큰 수의 축약 단위. 큰 임계값부터 골라야 1M이 1000.0K로 표시되지 않는다. */
const TOKEN_UNITS: readonly [threshold: number, suffix: string][] = [
  [1_000_000, "M"],
  [1_000, "K"],
];

/** 지원 공급자와 화면 표시 이름을 타입으로 맞춰 새 공급자가 빠지면 빌드에서 드러나게 한다. */
const SOURCE_NAMES: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  local: "Ollama",
};

export function formatRelative(timestamp: number | null, now: number = Date.now()): string {
  if (!timestamp) return EMPTY_PLACEHOLDER;
  const delta = now - timestamp;
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
  const days = Math.floor(remainingMs / DAY_MS);
  const hours = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return minutes > 0 ? `${minutes}m` : "<1m";
}

export function formatDate(timestamp: number | null): string {
  if (!timestamp) return EMPTY_PLACEHOLDER;
  return DATE_FORMATTER.format(new Date(timestamp));
}

export function formatBytes(value: number | null): string {
  if (value === null) return EMPTY_PLACEHOLDER;
  let size = value;
  let index = 0;
  while (size >= BYTES_PER_UNIT && index < BYTE_UNITS.length - 1) {
    size /= BYTES_PER_UNIT;
    index += 1;
  }
  const digits = size >= 100 || index === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${BYTE_UNITS[index]}`;
}

export function formatTokens(value: number | null): string {
  if (value === null) return EMPTY_PLACEHOLDER;
  for (const [threshold, suffix] of TOKEN_UNITS) {
    if (value >= threshold) return `${(value / threshold).toFixed(1)}${suffix}`;
  }
  return value.toLocaleString();
}

export function sourceName(source: ProviderId): string {
  return SOURCE_NAMES[source];
}
