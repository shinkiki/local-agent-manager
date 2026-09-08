export const MAX_AIA_COMMAND_CHARS = 1_000;

/** 모델이 제안한 명령은 실행하지 않고, 안전한 크기의 입력 초안으로만 받아들인다. */
export function aiaCommandText(value: string): string | null {
  const command = value.trim();
  if (!command || [...command].length > MAX_AIA_COMMAND_CHARS) return null;
  return command;
}
