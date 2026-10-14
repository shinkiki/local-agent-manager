/**
 * 로그인 터미널 출력에서 사람이 옮겨 적어야 하는 것 — 브라우저에서 열 주소와 일회용 코드 —
 * 을 골라낸다.
 *
 * 원격(특히 모바일) 화면에서는 xterm 안의 글자를 긁어 복사하기 어렵고, 긴 OAuth 주소는 글자
 * 폭에 맞춰 여러 줄로 보여 이어 붙이기도 힘들다(2026-10-10 NAS 실측). 그런데 PTY가 보내는
 * **원문**에는 줄바꿈이 없다 — 접힘은 xterm의 표시일 뿐이다. 그래서 화면이 아니라 원문 바이트를
 * 모아 두고 거기서 찾으면 주소가 통째로 잡힌다.
 *
 * 출력은 신뢰할 수 없는 데이터다. 여기서는 http(s) 주소와 코드 모양만 뽑고, 여는 쪽
 * (`openExternalUrl`)이 스킴을 다시 검사한다.
 */

export interface TerminalHints {
  /** 가장 최근에 나온 것이 앞에 온다. */
  links: string[];
  codes: string[];
}

/** 화면에 보일 최대 개수. 로그인 CLI 출력은 짧아 이 이상 쌓이면 재시도 흔적이다. */
const MAX_LINKS = 4;
const MAX_CODES = 3;
/** 원문을 들고 있는 상한. 로그인 출력은 수 KiB라 넉넉하고, 넘치면 앞을 버린다. */
const MAX_BUFFER_CHARS = 64 * 1024;

// CSI(ESC [ … 글자), OSC(ESC ] … BEL/ST), 글자집합 지정(ESC ( x), 캐리지 리턴.
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\r/g;
const URL_PATTERN = /https?:\/\/[^\s<>"'`\u0000-\u001f]+/g;
/** 꼬리에 붙기 쉬운 문장 부호. 주소 자체의 일부인 경우는 드물고, 붙은 채 열면 404가 난다. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
/** Codex 기기 코드 모양(`XXXX-XXXXX`). 주소를 걷어낸 뒤에만 찾아 주소 조각을 코드로 오인하지 않는다. */
const ONE_TIME_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** 뒤에 나온 것을 앞에 두고 중복은 한 번만 남긴다. */
function latestUnique(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = values.length - 1; index >= 0 && result.length < limit; index -= 1) {
    const value = values[index];
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function extractTerminalHints(raw: string): TerminalHints {
  const text = stripAnsi(raw);
  const links: string[] = [];
  const withoutLinks = text.replace(URL_PATTERN, (match) => {
    const url = match.replace(TRAILING_PUNCTUATION, "");
    if (url.length > "https://x".length) links.push(url);
    return " ";
  });
  const codes = withoutLinks.match(ONE_TIME_CODE_PATTERN) ?? [];
  return { links: latestUnique(links, MAX_LINKS), codes: latestUnique(codes, MAX_CODES) };
}

export function sameTerminalHints(a: TerminalHints | null, b: TerminalHints | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.links.join("\n") === b.links.join("\n") && a.codes.join("\n") === b.codes.join("\n");
}

export function hasTerminalHints(hints: TerminalHints | null): hints is TerminalHints {
  return Boolean(hints && (hints.links.length > 0 || hints.codes.length > 0));
}

/**
 * 출력 조각을 이어 붙이며 힌트를 다시 뽑는다. 주소 하나가 두 조각에 걸쳐 올 수 있어 조각
 * 단위로 찾지 않고 모은 원문에서 찾는다. 멀티바이트 글자도 조각 경계에 걸리므로 스트림
 * 디코더를 쓴다.
 */
export class TerminalHintCollector {
  private buffer = "";
  private decoder = new TextDecoder();
  /** 비어 있음도 "지난 값"이다 — 힌트가 없는 출력은 알리지 않는다. */
  private last: TerminalHints = { links: [], codes: [] };

  /** 바뀐 힌트가 있으면 돌려주고, 같으면 null. */
  push(bytes: Uint8Array): TerminalHints | null {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (this.buffer.length > MAX_BUFFER_CHARS) {
      this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER_CHARS);
    }
    const next = extractTerminalHints(this.buffer);
    if (sameTerminalHints(this.last, next)) return null;
    this.last = next;
    return next;
  }

  reset(): void {
    this.buffer = "";
    this.decoder = new TextDecoder();
    this.last = { links: [], codes: [] };
  }
}

/** 버튼 옆에 보일 짧은 이름. 주소 전체는 길어서 호스트만 보인다. */
export function hintLinkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.pathname.length > 1 ? parsed.pathname : "");
  } catch {
    return url;
  }
}
