/**
 * 의존성 없는 줄 단위 비교. 스킬 설치본과 보관 원본처럼 크지 않은 텍스트를
 * 화면에 `+`/`-`로 보여주기 위한 것이라 정확한 최소 편집보다 예측 가능한 결과와
 * 상한 있는 비용을 우선한다.
 */

export type DiffLineKind = "same" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1부터 시작하는 이전 쪽 줄 번호. 추가된 줄에는 없다. */
  before?: number;
  /** 1부터 시작하는 이후 쪽 줄 번호. 삭제된 줄에는 없다. */
  after?: number;
}

export type DiffRow = DiffLine | { kind: "skip"; count: number };

/** LCS 표를 채울 최대 셀 수. 넘으면 공통 접두·접미만 접고 가운데는 통째로 바꾼다. */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // 끝 개행은 빈 줄로 세지 않는다. 개행 유무 차이는 마지막 줄 비교에서 드러난다.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 줄 번호가 아직 붙지 않은 비교 결과 한 줄. 어느 구간에서 나왔든 모양이 같다. */
type UnnumberedLine = Pick<DiffLine, "kind" | "text">;

/**
 * 이전 → 이후 방향의 줄 단위 차이. 두 입력이 같으면 전부 same이다.
 *
 * 결과는 세 구간을 이어 붙인 것이다 — 그대로인 앞머리, 실제로 비교한 가운데, 그대로인
 * 꼬리. 세 구간 모두 줄 번호를 붙이는 규칙은 같으므로(`number`) 여기서는 각 구간이
 * 어느 번호에서 시작하는지만 정한다.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const left = splitLines(before);
  const right = splitLines(after);
  const { prefix, suffix } = commonAffixLengths(left, right);
  const middle = middleDiff(
    left.slice(prefix, left.length - suffix),
    right.slice(prefix, right.length - suffix),
  );
  return [
    ...number(sameLines(left.slice(0, prefix)), 0, 0),
    ...number(middle, prefix, prefix),
    ...number(sameLines(left.slice(left.length - suffix)), left.length - suffix, right.length - suffix),
  ];
}

/** 양쪽 끝에서 그대로인 줄 수. 가운데만 비교하면 되도록 먼저 잘라 낸다. */
function commonAffixLengths(left: string[], right: string[]): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  return { prefix, suffix };
}

function sameLines(texts: string[]): UnnumberedLine[] {
  return texts.map((text) => ({ kind: "same", text }));
}

/** 접두·접미를 걷어낸 가운데 구간. 표가 상한을 넘으면 통째로 바꾼 것으로 본다. */
function middleDiff(left: string[], right: string[]): UnnumberedLine[] {
  if (left.length * right.length <= MAX_LCS_CELLS) return lcsDiff(left, right);
  return [
    ...left.map((text): UnnumberedLine => ({ kind: "remove", text })),
    ...right.map((text): UnnumberedLine => ({ kind: "add", text })),
  ];
}

/**
 * 줄 번호를 붙인다. 두 쪽 번호는 각자 자기 쪽에 남는 줄에서만 하나씩 나아가므로,
 * 구간마다 시작 번호만 다르고 세는 규칙은 같다 — 그 규칙을 세 벌로 두면 한쪽만
 * 어긋나도 화면의 줄 번호가 조용히 밀린다.
 */
function number(lines: UnnumberedLine[], startBefore: number, startAfter: number): DiffLine[] {
  let before = startBefore;
  let after = startAfter;
  return lines.map((line) => {
    if (line.kind !== "add") before += 1;
    if (line.kind !== "remove") after += 1;
    return {
      kind: line.kind,
      text: line.text,
      ...(line.kind !== "add" ? { before } : {}),
      ...(line.kind !== "remove" ? { after } : {}),
    };
  });
}

/** 표준 LCS 표로 가운데 구간을 비교한다. 줄 번호는 호출자가 붙인다. */
function lcsDiff(left: string[], right: string[]): UnnumberedLine[] {
  const rows = left.length;
  const cols = right.length;
  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i * width + j] = left[i] === right[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const out: UnnumberedLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      out.push({ kind: "same", text: left[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      out.push({ kind: "remove", text: left[i] });
      i += 1;
    } else {
      out.push({ kind: "add", text: right[j] });
      j += 1;
    }
  }
  while (i < rows) out.push({ kind: "remove", text: left[i++] });
  while (j < cols) out.push({ kind: "add", text: right[j++] });
  return out;
}

/** 변경 주변 `context`줄만 남기고 긴 동일 구간은 `skip` 행으로 접는다. */
export function collapseUnchanged(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep[k] = true;
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) {
        out.push({ kind: "skip", count: skipped });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped += 1;
    }
  });
  if (skipped > 0) out.push({ kind: "skip", count: skipped });
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "remove") removed += 1;
  }
  return { added, removed };
}
