import type { ProviderId } from "../types";
import { runtimeLocale, runtimeText } from "./i18nRuntime.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 상대 시간 단위. 한국어는 붙여 쓰고("3분 전"), 영어는 단수·복수를 가른다("3 minutes ago"). */
const RELATIVE_UNITS: readonly [size: number, ko: string, en: string][] = [
  [DAY_MS, "일", "day"],
  [HOUR_MS, "시간", "hour"],
  [MINUTE_MS, "분", "minute"],
];

/**
 * 날짜 표기에 쓸 BCP 47 태그. 한국어 화면만 한국식 날짜를 쓰고, 영어·제3언어는 영어식으로 맞춘다.
 *
 * 로캘 없이 `toLocaleString()`을 부르면 화면 언어가 아니라 **브라우저 기본값**을 따라, 영어
 * 화면에서도 한국어 OS에서는 "오전 3:03"이 나온다. 날짜를 적는 자리는 모두 이 태그를 거친다.
 */
export function dateLocaleTag(locale: string = runtimeLocale().locale): string {
  return locale === "ko" ? "ko-KR" : "en-US";
}

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

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
  for (const [size, ko, en] of RELATIVE_UNITS) {
    if (absolute >= size) {
      const value = Math.floor(absolute / size);
      const unit = `${en}${value === 1 ? "" : "s"}`;
      return future
        ? runtimeText(`${value}${ko} 후`, `in ${value} ${unit}`)
        : runtimeText(`${value}${ko} 전`, `${value} ${unit} ago`);
    }
  }
  return future ? runtimeText("잠시 후", "soon") : runtimeText("방금 전", "just now");
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
  return new Date(timestamp).toLocaleString(dateLocaleTag(), DATE_OPTIONS);
}

/** `new Date(t).toLocaleString()`의 자리. 날짜와 시각을 화면 언어로 적는다. */
export function formatDateTime(timestamp: number | string | Date): string {
  return new Date(timestamp).toLocaleString(dateLocaleTag());
}

/** `new Date(t).toLocaleDateString()`의 자리. */
export function formatDateOnly(timestamp: number | string | Date): string {
  return new Date(timestamp).toLocaleDateString(dateLocaleTag());
}

/** `new Date(t).toLocaleTimeString()`의 자리. */
export function formatTimeOnly(timestamp: number | string | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Date(timestamp).toLocaleTimeString(dateLocaleTag(), options);
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
