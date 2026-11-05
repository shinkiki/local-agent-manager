import type { InstructionPublishReceipt } from "../types";

interface InstructionPublishSummary {
  succeeded: number;
  linkedWritten: number;
  linkedSkipped: number;
}

/** 게시 영수증의 화면용 개수를 결과·연결 문서까지 한 번만 훑어 집계한다. */
export function summarizeInstructionPublish(receipt: InstructionPublishReceipt): InstructionPublishSummary {
  const summary: InstructionPublishSummary = { succeeded: 0, linkedWritten: 0, linkedSkipped: 0 };
  for (const result of receipt.results) {
    if (result.outcome === "published" || result.outcome === "replaced" || result.outcome === "unchanged") {
      summary.succeeded += 1;
    }
    for (const linked of result.linkedResults ?? []) {
      if (linked.outcome === "published" || linked.outcome === "replaced") summary.linkedWritten += 1;
      if (linked.outcome === "skipped") summary.linkedSkipped += 1;
    }
  }
  return summary;
}
