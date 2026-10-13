/**
 * 보관된 overlay patch 본문을 **파일별 구간으로 가르기만** 한다(C19-5 읽기).
 *
 * 왜 필요한가. `apply`가 `overlayNeedsResolution`으로 막히면 영수증에 남는 것은 충돌한
 * 경로 이름뿐이고(C19-3), 사용자가 그 파일에 무엇을 적어 두었는지 알려면 patch 본문을 열어
 * 최대 512KB의 통일 diff에서 그 경로를 눈으로 찾아야 했다. 세트에 파일이 여럿이면 "빼기"와
 * "손으로 다시 적기" 중 무엇을 고를지 판단할 근거가 화면에 없는 셈이다.
 *
 * **본문은 한 글자도 바꾸지 않는다.** OverlayPatchView의 주석이 적어 둔 대로 이 화면의
 * 쓰임은 옮겨 적기라, 색칠·접기·재배치는 원문과 다른 것을 베끼게 만든다. 그래서 여기서
 * 하는 일은 자르는 자리를 **찾는 것**뿐이고, 모든 구간의 `text`를 순서대로 이으면 원문과
 * 바이트까지 같다(`sectionsJoinToOriginal`이 그것을 시험에서 고정한다). 화면은 구간마다
 * 앵커를 달아 그 자리로 스크롤만 한다.
 *
 * 경로는 `diff --git` 줄에서 읽는다. patch는 `git diff --binary --full-index`가 뜬 것이고
 * (C19-1) 그 줄의 두 경로는 같은 파일이므로, `b/` 쪽을 쓴다 — v1은 rename을 거절하므로
 * (C19-3) 양쪽이 갈라지는 경우는 애초에 들어오지 않는다.
 */

export type OverlayPatchSection = {
  /** `diff --git a/<path> b/<path>`에서 읽은 경로. 읽지 못하면 null(머리말 구간). */
  readonly path: string | null;
  /** 원문에서 잘라 온 구간. 이어 붙이면 원문이다. */
  readonly text: string;
};

/** `diff --git a/x b/x` 한 줄에서 경로를 꺼낸다. 읽지 못하면 null. */
function pathOfHeader(line: string): string | null {
  // 경로에 공백이 있으면 git이 따옴표로 감싸므로 그 모양을 먼저 본다.
  const quoted = line.match(/^diff --git "a\/(.*)" "b\/(.+)"$/);
  if (quoted) return quoted[2].length > 0 ? quoted[2] : null;
  const plain = line.match(/^diff --git a\/(.*) b\/(.+)$/);
  if (!plain) return null;
  return plain[2].length > 0 ? plain[2] : null;
}

/**
 * 본문을 파일별 구간으로 가른다. 첫 `diff --git` 앞에 글자가 있으면 그것도 경로 없는
 * 구간 하나로 돌려준다 — 버리면 이어 붙였을 때 원문이 되지 않는다.
 */
export function overlayPatchSections(text: string | null): readonly OverlayPatchSection[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  const sections: OverlayPatchSection[] = [];
  let start = 0;
  let path: string | null = null;
  const push = (end: number) => {
    if (end <= start) return;
    // split이 떼어 낸 개행을 그대로 되살려 잇는다. 마지막 조각 뒤에는 붙이지 않는다.
    const body = lines.slice(start, end).join("\n") + (end < lines.length ? "\n" : "");
    sections.push({ path, text: body });
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("diff --git ")) continue;
    push(i);
    start = i;
    path = pathOfHeader(lines[i]);
  }
  push(lines.length);
  return sections;
}

/** 구간을 모두 이은 것이 원문과 같은가. 화면이 자르기 전에 스스로 확인하는 자리다. */
export function sectionsJoinToOriginal(text: string | null, sections: readonly OverlayPatchSection[]): boolean {
  return sections.map((section) => section.text).join("") === (text ?? "");
}

/**
 * 경로 하나가 들어 있는 구간의 번호. 없으면 -1.
 *
 * 영수증의 충돌 경로는 저장소 최상위 기준 상대 경로이고 `diff --git`의 경로도 같은 기준이라
 * 정확히 일치해야 한다. 접미사 일치로 느슨하게 찾으면 `a/config.ts`를 물었을 때
 * `vendor/a/config.ts`가 잡혀 엉뚱한 자리로 스크롤한다.
 */
export function overlayPatchSectionIndex(sections: readonly OverlayPatchSection[], path: string): number {
  return sections.findIndex((section) => section.path === path);
}
