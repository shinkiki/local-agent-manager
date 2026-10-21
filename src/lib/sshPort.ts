/**
 * SSH 연결 서버 편집 상자의 포트 입력을 백엔드 요청 값으로 읽는다.
 *
 * `Number.parseInt`로 읽으면 "2222x"는 2222로, "abc"는 `null`(= 백엔드 기본 22)로 접혀
 * 사용자가 적지 않은 포트가 오류 없이 저장됐다. 그래서 숫자만으로 된 1~65535만 받고,
 * 나머지는 `undefined`로 돌려 저장 버튼을 잠그게 한다. 빈 칸은 기본 포트를 뜻한다.
 */
export function parseSshPort(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d{1,5}$/.test(trimmed)) return undefined;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : undefined;
}
