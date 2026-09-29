/**
 * 대화창 안에서 찾기(Cmd+F / Ctrl+F)의 판정만 모은 곳.
 *
 * 글자를 칠하고 그 자리로 굴려 주는 일은 DOM 을 쥔 `ChatFindBar` 가 맡고, 여기에는
 * 시험으로 고정할 수 있는 규칙 셋만 둔다 — 단축키인가, 글 조각 어디에 있는가,
 * 다음·이전은 어디인가.
 */

export interface FindShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * 찾기 단축키인가. macOS 는 Cmd+F, Windows·Linux 는 Ctrl+F 라 둘 중 **하나만** 눌린
 * 경우를 받는다. 플랫폼을 따로 묻지 않는 이유는 어느 쪽이든 그 플랫폼에서 실제로
 * 눌리는 조합이 하나뿐이어서다. Alt·Shift 가 섞이면 다른 명령이므로 넘긴다.
 */
export function isFindShortcut(event: FindShortcutEvent): boolean {
  if (event.key.toLowerCase() !== "f") return false;
  if (event.altKey || event.shiftKey) return false;
  return Boolean(event.metaKey) !== Boolean(event.ctrlKey);
}

/** 찾은 자리 하나. `nodeIndex` 는 넘겨받은 글 조각 배열에서의 위치다. */
export interface FindMatch {
  nodeIndex: number;
  start: number;
  end: number;
}

/**
 * 글 조각 목록에서 찾은 자리를 앞에서부터 모은다. 대소문자는 구분하지 않고, 한 조각을
 * 넘어가는 말은 찾지 않는다 — 화면의 한 문단이 여러 조각으로 쪼개져 있어도 낱말 하나는
 * 대개 한 조각 안에 있다.
 *
 * 소문자로 내리면 길이가 달라지는 글자가 있다(터키어 `İ` → `i̇`). 그런 조각에서는 자리
 * 번호가 통째로 밀려 엉뚱한 곳을 칠하게 되므로, 길이가 달라진 조각만 대소문자를 구분해
 * 찾는다.
 */
export function findMatches(texts: readonly string[], query: string): FindMatch[] {
  if (!query.trim()) return [];
  const matches: FindMatch[] = [];
  const loweredQuery = query.toLowerCase();
  texts.forEach((text, nodeIndex) => {
    const lowered = text.toLowerCase();
    const sameLength = lowered.length === text.length;
    const haystack = sameLength ? lowered : text;
    const needle = sameLength ? loweredQuery : query;
    if (!needle) return;
    let from = 0;
    for (;;) {
      const start = haystack.indexOf(needle, from);
      if (start < 0) break;
      matches.push({ nodeIndex, start, end: start + needle.length });
      from = start + needle.length;
    }
  });
  return matches;
}

/**
 * 찾기를 붙일 수 있는 자리 하나의 겹침 정보. 한 문서에 여러 자리(대화 화면과 그 위에 뜬
 * AIA 팝업)가 같이 살아 있고 하이라이트 이름은 문서에 한 벌뿐이라, 단축키는 그중 한 곳만
 * 열어야 한다.
 */
export interface FindSurfaceLayer {
  priority: number;
  /** 지금 실제로 그려져 있는가. 감춰진 화면은 후보가 아니다. */
  available: boolean;
}

/**
 * 단축키를 가져갈 자리의 위치. 보이는 것 중 가장 위(큰 `priority`)를 고르고, 같으면
 * 나중에 등록된 쪽이 이긴다 — 대개 나중에 열린 겹이다. 후보가 없으면 -1.
 */
export function topmostSurfaceIndex(surfaces: readonly FindSurfaceLayer[]): number {
  let best = -1;
  surfaces.forEach((surface, index) => {
    if (!surface.available) return;
    if (best < 0 || surface.priority >= surfaces[best].priority) best = index;
  });
  return best;
}

/** 다음(+1)·이전(-1) 자리. 끝에서는 반대쪽 끝으로 돌아간다. */
export function stepMatchIndex(current: number, total: number, direction: number): number {
  if (total <= 0) return 0;
  return (((current + direction) % total) + total) % total;
}

/**
 * 찾은 자리 수가 바뀐 뒤에도 쓸 수 있는 번호로 맞춘다. 응답이 흘러들어오면 자리 수가
 * 계속 변하므로, 보고 있던 번호가 사라졌을 때 마지막 자리로 물러난다.
 */
export function clampMatchIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(0, index), total - 1);
}
