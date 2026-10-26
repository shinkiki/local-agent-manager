/**
 * SSH 연결 서버 편집 상자의 여러 줄 명령 규칙 입력을 규칙 목록으로 바꾼다(C9-13).
 *
 * 백엔드 `validate_command_rules`와 같은 규칙이다 — 앞뒤 공백을 자르고, 빈 줄을 버리고,
 * 이미 나온 줄은 다시 넣지 않는다(처음 나온 순서를 지킨다). 중복을 접지 않으면 저장본과
 * 같은 규칙에 줄 하나를 겹쳐 적기만 해도 "바뀜"으로 보여 아무것도 바꾸지 않는 저장이 열렸다.
 */
export function commandLines(value: string): string[] {
  const seen = new Set<string>();
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) seen.add(trimmed);
  }
  return [...seen];
}
