import type { ExternalPluginView } from "../types";
import { RECORD_TARGETS } from "./aiaOnboardingProblems.ts";

/** V2/V4: 선택 목록과 생성 전 검사가 같은 기록 대상 판정을 사용한다. */
export function availableRecordTargets(
  plugins: readonly Pick<ExternalPluginView, "id" | "displayName" | "url" | "attachable">[],
) {
  return RECORD_TARGETS.filter(({ needles }) => needles.length === 0 || plugins.some((plugin) => {
    if (!plugin.attachable) return false;
    const haystack = `${plugin.id} ${plugin.displayName} ${plugin.url ?? ""}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  }));
}
