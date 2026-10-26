/**
 * 새 채팅 시작 폼의 접힌 고급 옵션 머리글 요약. 접어 둔 채로도 기본값이 아닌 선택이
 * 보이게, 값이 있는 항목만 `라벨 값`으로 잇고 하나도 없으면 항목 이름 뒤에 "기본값"을 붙인다.
 * 공백만 든 값은 고르지 않은 것으로 본다 — 백엔드도 빈 값을 기본값으로 해석한다.
 */
export function launchAdvancedSummary(
  fields: readonly { key: string; label: string }[],
  extraSettings: Readonly<Record<string, string>>,
): string {
  const chosen = fields
    .map((field) => {
      const value = extraSettings[field.key]?.trim();
      return value ? `${field.label} ${value}` : null;
    })
    .filter((part): part is string => part !== null);
  if (chosen.length > 0) return chosen.join(" · ");
  return `${fields.map((field) => field.label).join(" · ")} 기본값`;
}
