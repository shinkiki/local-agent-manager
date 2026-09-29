/** 애드온 폼의 "다른 이름" 한 줄을 목록으로 쪼갠다. 쉼표·줄바꿈으로 나누고 빈 것과 겹치는 것은 뺀다. */
export function splitPluginNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const name = raw.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
