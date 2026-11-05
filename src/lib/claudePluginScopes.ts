/** 플러그인마다 마지막으로 고른 표시 범위. 프로바이더 설정과 별개인 화면 상태다. */
export type PluginScope = "global" | "project" | "branch";

export const PLUGIN_SCOPES: PluginScope[] = ["global", "project", "branch"];

/** V4: 저장값이 손상되어도 인식 가능한 표시 범위만 복원한다. */
export function parsePluginScopes(stored: string | null): Record<string, PluginScope> {
  try {
    const parsed = JSON.parse(stored || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => PLUGIN_SCOPES.includes(value as PluginScope))) as Record<string, PluginScope>;
  } catch {
    return {};
  }
}
