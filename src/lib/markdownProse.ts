/**
 * 문서에서 "여기는 산문이다"를 가르는 스캐너 — 코드 펜스 안쪽과 인라인 코드를 빼고 남는
 * 조각만 골라 준다.
 *
 * 가져오기 표기를 링크로 바꾸는 규칙(`markdownLinks`)과 한 파일에 있었지만 둘이 바뀌는
 * 이유는 다르다. 링크 쪽은 에이전트·지침이 실제로 쓰는 표기가 늘 때 손대고(`@경로` 토큰의
 * 꼬리 문장부호, 주소 스킴 허용 범위), 여기 있는 것은 "무엇을 원문 그대로 둘 것인가"의
 * 경계라 코드 표기를 놓쳤을 때 손댄다. 링크 토큰 한 줄을 고치러 들어온 사람이 조각
 * 경계의 불변식(조각의 `text`를 이어 붙이면 줄바꿈만 정규화된 원문이 된다)까지 함께 읽을
 * 필요는 없다. 목록과 저장 규칙을 가른 `navigationViews`/`navigationPreferences`,
 * 문법과 덩어리 분할을 가른 `markdownFences`/`markdownChunks`와 같은 경계다.
 *
 * 이 스캐너의 펜스 판정은 `markdownFences`보다 성기다 — 백틱 세 개로 시작하는 줄을 여닫이
 * 토글로만 본다. 두 자리가 다른 이유는 결과가 다르기 때문이다. 미리보기는 펜스마다 언어와
 * 코드 본문을 꺼내 상자로 그려야 해서 마커 종류·길이를 기억해야 하고, 여기서 필요한 것은
 * "이 줄을 산문으로 볼 것인가" 하나뿐이다. 둘을 같은 함수로 묶으려면 이쪽도 마커 상태를
 * 들고 다녀야 하는데, 그렇게 얻는 것은 `~~~` 펜스 안의 `@경로`가 링크로 바뀌지 않는 것뿐이고
 * (지금은 링크가 된다) 그건 동작 변경이다. 성긴 판정이 의도라는 사실만 여기 적어 둔다.
 */

/** 코드 펜스를 여닫는 줄. 여는 줄과 닫는 줄을 같은 규칙으로 본다. */
const FENCE_LINE = /^\s*```/;

/** 문서를 이루는 조각 하나. `prose`가 아닌 조각은 원문 그대로 이어 붙일 몫이다. */
interface DocumentPiece {
  text: string;
  /** 가져오기 표기를 해석해도 되는 산문인지. 코드 펜스 안쪽과 인라인 코드는 false다. */
  prose: boolean;
}

/**
 * 문서를 조각으로 쪼개 나온 순서대로 내놓는다. 코드 펜스 안쪽 줄과 인라인 코드(홀수 번째
 * 백틱 조각)는 `prose: false`로 나오고, 줄바꿈·백틱 같은 구분자도 조각으로 함께 나온다 —
 * 조각의 `text`를 그대로 이어 붙이면 줄바꿈만 정규화된 원문이 된다.
 *
 * 가져오기 표기를 링크로 바꾸는 쪽과 링크를 모으는 쪽이 **같은 스캐너**를 써야 한다.
 * 둘이 갈라지면 화면에는 링크로 그려지는데 보관 세트에는 빠지는 문서(또는 그 반대)가
 * 생긴다. 그래서 조각 경계 규칙은 이 함수 하나에만 있다.
 *
 * 조각을 그대로 내놓기만 하고 문자열을 짓지 않는 이유는 모으기만 하는 호출부다. 예전에는
 * 그쪽도 변환 함수를 거쳐야 해서, 링크 목록 하나를 얻으려고 문서 전체를 새 문자열로 다시
 * 짓고 있었다. 아래 두 진입점이 각자 필요한 만큼만 쓴다.
 */
function* documentPieces(source: string): Generator<DocumentPiece> {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let fenced = false;
  for (const [lineIndex, line] of lines.entries()) {
    if (lineIndex > 0) yield { text: "\n", prose: false };
    if (FENCE_LINE.test(line)) {
      fenced = !fenced;
      yield { text: line, prose: false };
      continue;
    }
    if (fenced) {
      yield { text: line, prose: false };
      continue;
    }
    for (const [index, segment] of line.split("`").entries()) {
      if (index > 0) yield { text: "`", prose: false };
      yield { text: segment, prose: index % 2 === 0 };
    }
  }
}

/** 산문 조각만 바꿔 쓴 문서. 나머지 조각은 원문 그대로 이어 붙인다. */
export function mapProseSegments(source: string, transform: (segment: string) => string): string {
  let result = "";
  for (const piece of documentPieces(source)) {
    result += piece.prose ? transform(piece.text) : piece.text;
  }
  return result;
}

/** 산문 조각을 나온 순서대로 넘겨 준다. 문서를 다시 짓지 않는다. */
export function eachProseSegment(source: string, visit: (segment: string) => void): void {
  for (const piece of documentPieces(source)) {
    if (piece.prose) visit(piece.text);
  }
}
