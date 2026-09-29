const WINDOWS_EXTENDED_PATH_PREFIX = "\\\\?\\";
const WINDOWS_EXTENDED_UNC_PREFIX = "\\\\?\\UNC\\";

interface WindowsDisplayPrefix {
  stored: string;
  displayed: string;
  caseInsensitive: boolean;
}

/** 더 구체적인 UNC 접두사를 먼저 판정해야 `UNC\\`가 드라이브 경로처럼 남지 않는다. */
const WINDOWS_DISPLAY_PREFIXES: readonly WindowsDisplayPrefix[] = [
  { stored: WINDOWS_EXTENDED_UNC_PREFIX, displayed: "\\\\", caseInsensitive: true },
  { stored: WINDOWS_EXTENDED_PATH_PREFIX, displayed: "", caseInsensitive: false },
];

function hasDisplayPrefix(path: string, prefix: WindowsDisplayPrefix): boolean {
  const candidate = path.slice(0, prefix.stored.length);
  return prefix.caseInsensitive
    ? candidate.toLocaleUpperCase() === prefix.stored
    : candidate === prefix.stored;
}

/**
 * Windows canonical paths may carry the extended-length prefix used for file I/O.
 * Keep the stored path intact and remove that implementation detail only when it
 * is rendered for a person.
 */
export function displayPath(path: string): string {
  for (const prefix of WINDOWS_DISPLAY_PREFIXES) {
    if (hasDisplayPrefix(path, prefix)) {
      return `${prefix.displayed}${path.slice(prefix.stored.length)}`;
    }
  }
  return path;
}
