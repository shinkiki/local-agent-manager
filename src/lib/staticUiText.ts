export function canonicalSourceText(
  current: string,
  messages: Record<string, string>,
  staticKoreanByEnglish: ReadonlyMap<string, string>,
  registeredKoreanByEnglish: ReadonlyMap<string, string>,
): string {
  const whitespace = current.match(/^(\s*)(.*?)(\s*)$/s);
  const leading = whitespace?.[1] ?? "";
  const core = whitespace?.[2] ?? current;
  const trailing = whitespace?.[3] ?? "";
  // React가 동적 값과 자식 요소 사이에 만든 공백 노드는 번역 대상으로 보지 않는다.
  // 영어에서 빈 문자열인 "개"를 역조회하면 공백이 "개"로 바뀔 수 있다.
  if (!core) return current;
  const staticSource = staticKoreanByEnglish.get(core);
  const registeredSource = registeredKoreanByEnglish.get(core);
  const customSource = Object.entries(messages).find(([, value]) => value === core)?.[0];
  return `${leading}${staticSource ?? registeredSource ?? customSource ?? core}${trailing}`;
}
