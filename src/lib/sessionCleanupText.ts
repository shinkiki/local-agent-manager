import type {
  SessionCleanupReason,
  SessionCleanupPreview,
  SessionCleanupReceipt,
} from "../types";
import { joinSummary, maxByScore } from "./sequence.ts";

/**
 * 자동정리가 받은 숫자를 사람이 읽는 문구로 바꾸는 규칙 — 바이트·건수 표기와 미리보기·
 * 조건 안내·영수증 한 줄.
 *
 * 버튼을 열 수 있는지 가르는 판정(`sessionCleanup.ts`)과 한 파일에 있던 동안에는, 요약
 * 문구 한 줄을 손보러 들어와도 원격 쓰기 권한과 조건 유무를 함께 스크롤해야 했고, 그
 * 반대도 마찬가지였다. 둘은 서로를 부르지 않으므로 파일을 가르면 볼 것도 갈린다.
 *
 * 숫자가 문장 가운데 끼므로 정적 치환 대응표로는 영어를 만들 수 없다. 화면이 지금 언어를
 * 고르는 손잡이(`useI18n().text`)를 넘기고 여기서 언어별로 온전한 문장을 짓는다 — 넘기지
 * 않으면 한국어다. 영어 UI에서 이 세 줄만 한국어로 남아 한 줄 안에 두 언어가 이어붙던 것을
 * 이렇게 닫았다(QA #92).
 * 영수증의 건너뜀 사유(`skippedReasons`)는 백엔드가 만든 한국어 문장이라 그대로 싣는다.
 *
 * 언어를 `AppLocale` 값으로 받아 이 파일 안의 `pick(한국어, 영어)`로 고르던 동안에는,
 * `text(ko, en)` 호출만 읽는 생성 번역 카탈로그가 여기 있는 짝 열두 개를 소스에서 거두지
 * 못했다. 고르는 일을 화면의 손잡이에 넘기면 같은 짝이 그 호출 형태로 소스에 남는다.
 */

/** 한국어·영어 짝에서 지금 로케일의 문구를 고르는 컴포넌트의 `text`. */
type Translate = (ko: string, en: string) => string;

/** 손잡이를 넘기지 않은 부름(단위 시험·서버 쪽)은 한국어를 본다. */
const koText: Translate = (ko) => ko;

/**
 * 문장 조각 만드는 도구 한 벌. 이 파일의 문장 짓는 함수 셋은 모두 조각을 여러 번 만드는데,
 * 조각마다 손잡이를 마지막 인자로 다시 넘기면 한 줄에 같은 이름이 서너 번 나와 정작 무슨
 * 문장을 짓는지가 묻힌다.
 */
type CleanupWords = {
  /**
   * 조건이 맞을 때만 넣는 조각. 맞지 않으면 빈 조각이라 [`joinSummary`]가 걷어낸다.
   *
   * 한 줄 요약을 짓는 두 함수가 조각마다 `조건 && text(한국어, 영어)`를 적고 있었다.
   * 조건과 문구가 한 식에 겹쳐, 줄이 길어지면 어느 괄호가 조건이고 어디부터가 문구인지
   * 눈으로 갈라야 했고, 실제로 두 함수가 같은 규칙을 서로 다른 줄바꿈으로 적었다.
   * 조건을 첫 인자로 받으면 조각 하나가 "언제·무엇" 두 칸으로 나란히 선다.
   */
  when: (include: boolean, value: string) => string;
  /** 건수 표기. */
  count: (count: number) => string;
  /** 건수와 그만큼이 차지하는 크기를 함께 읽어 주는 표기. */
  countWithBytes: (count: number, bytes: number) => string;
};

/**
 * 건수 표기는 세 자리 구분과 단위를 붙이는 자리가 미리보기·조건 안내·영수증에 열 군데
 * 넘게 흩어져 있었다. 한 곳만 `toLocaleString()`을 빠뜨려도 네 자리부터 표기가 어긋나는데,
 * 그 어긋남은 세션이 천 건을 넘겨야 드러나므로 눈으로는 잡히지 않는다.
 *
 * 건수와 크기를 잇는 표기도 미리보기의 두 자리가 같은 두 함수를 같은 순서로 이어 붙이고
 * 있어, 사이 구분을 손보려면 두 곳을 찾아야 했다. 영수증의 `실체 N건 회수 M`은 건수와
 * 크기 사이에 서술어가 끼어 모양이 다르므로 그대로 둔다.
 */
function words(text: Translate): CleanupWords {
  const count = (value: number): string => {
    const digits = value.toLocaleString();
    return text(`${digits}건`, digits);
  };
  return {
    when: (include, value) => (include ? value : ""),
    count,
    countWithBytes: (value, bytes) => `${count(value)} ${formatBytes(bytes)}`,
  };
}

/** 바이트를 사람이 읽는 단위로. 0은 "0B"가 아니라 "없음"으로 말한다. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 소수 첫째 자리까지만 보이고, 딱 떨어지면 ".0"을 달지 않는다.
  const rounded = value >= 100 || unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded.replace(/\.0$/, "")}${units[unit]}`;
}

/**
 * 정리 뒤 목록이 몇 배로 줄어드는지. 스냅숏에서 세션이 차지하는 몫이 압도적이라, 남는
 * 건수 비율이 그대로 적재 비용 비율이 된다. 남는 것이 없으면 배수를 말하지 않는다.
 */
export function shrinkFactor(preview: SessionCleanupPreview): number | null {
  const total = preview.remainingCount + preview.targetCount;
  if (preview.remainingCount <= 0 || total <= 0 || preview.targetCount <= 0) return null;
  return total / preview.remainingCount;
}

/** 미리보기 한 줄. 실체가 회수되는 몫과 목록에서만 내려가는 몫을 갈라 말한다. */
export function previewSummary(preview: SessionCleanupPreview, text: Translate = koText): string {
  const w = words(text);
  if (preview.targetCount === 0 && preview.orphanAttachmentCount === 0) {
    return text("지금 조건에 걸리는 세션이 없습니다.", "No sessions match the current conditions.");
  }
  const tombstoneOnly = preview.targetCount - preview.removableCount;
  const target = w.count(preview.targetCount);
  const removable = w.countWithBytes(preview.removableCount, preview.removableBytes);
  const orphan = w.countWithBytes(preview.orphanAttachmentCount, preview.orphanAttachmentBytes);
  // 대상 세션에 딸린 두 조각은 각자의 건수만 본다. 실체 회수와 목록에서만 내림은 대상
  // 세션을 가른 몫이라(`session_cleanup.rs`가 대상으로 셀 때만 회수 가능 여부를 센다),
  // 대상이 0건이면 둘 다 0건이다 — 바깥에 대상 조건을 한 겹 더 두면 같은 판정을 두 번
  // 적는 것이고, 그 두 겹이 어긋날 때 어느 쪽이 규칙인지 알 수 없게 된다.
  return joinSummary([
    w.when(preview.targetCount > 0, text(`세션 ${target}`, `${target} sessions`)),
    w.when(preview.removableCount > 0, text(`실체 회수 ${removable}`, `reclaims ${removable}`)),
    w.when(
      tombstoneOnly > 0,
      text(
        `목록에서만 내림 ${w.count(tombstoneOnly)}`,
        `list-only removal ${w.count(tombstoneOnly)}`,
      ),
    ),
    w.when(
      preview.orphanAttachmentCount > 0,
      text(`주인 없는 첨부 ${orphan}`, `orphan attachments ${orphan}`),
    ),
  ]);
}

/**
 * 조건별 적중 건수 안내. 0건인 조건은 "지금 데이터에서는 일하지 않는다"고 분명히
 * 말한다 — 보존 기간처럼 켜 두면 뭔가 하는 줄 알기 쉬운 조건이 있다.
 */
export function reasonHint(
  preview: SessionCleanupPreview,
  reason: SessionCleanupReason,
  text: Translate = koText,
): string {
  const w = words(text);
  const hit = preview.byReason.find((item) => item.reason === reason);
  if (!hit || hit.count === 0) {
    return text("현재 데이터에서는 해당되는 세션이 없습니다.", "No sessions match this condition right now.");
  }
  return text(
    `현재 데이터에서 ${w.count(hit.count)}이 해당됩니다.`,
    `${w.count(hit.count)} sessions match right now.`,
  );
}

/**
 * 건너뛴 사유 중 가장 흔한 것. 건수만으로는 남은 세션이 왜 남았는지 알 수 없어 하나를
 * 골라 붙이는데, 사유를 아예 담지 않던 옛 영수증도 있으므로 없을 수 있다.
 */
function topSkippedReason(receipt: SessionCleanupReceipt): string | null {
  const top = maxByScore(receipt.skippedReasons ?? [], (item) => item.count);
  return top?.reason ?? null;
}

/** 영수증 한 줄. 성패는 예외가 아니라 `failedCount`로 가른다. */
export function receiptSummary(receipt: SessionCleanupReceipt, text: Translate = koText): string {
  const w = words(text);
  const skippedReason = receipt.skippedCount > 0 ? topSkippedReason(receipt) : null;
  // 건너뜀 사유만 백엔드가 만든 한국어 문장이라 영어 줄에도 그대로 실린다. 사유 문자열
  // 자체의 번역은 백엔드 계약을 건드리는 별건이다.
  const skippedDetail = skippedReason ? text(`(주로 ${skippedReason})`, ` (mostly: ${skippedReason})`) : "";
  const freed = formatBytes(receipt.bytesFreed);
  const tombstoned = w.count(receipt.tombstonedCount);
  const removed = w.count(receipt.removedCount);
  const skipped = w.count(receipt.skippedCount);
  const failed = w.count(receipt.failedCount);
  const purged = w.count(receipt.trashPurgedCount);
  return joinSummary([
    text(`목록에서 ${tombstoned} 내림`, `removed ${tombstoned} from the list`),
    w.when(
      receipt.removedCount > 0,
      text(`실체 ${removed} 회수 ${freed}`, `reclaimed ${removed} · ${freed}`),
    ),
    w.when(
      receipt.skippedCount > 0,
      text(
        `보호로 건너뜀 ${skipped}${skippedDetail}`,
        `skipped ${skipped} as protected${skippedDetail}`,
      ),
    ),
    w.when(receipt.failedCount > 0, text(`실패 ${failed}`, `${failed} failed`)),
    w.when(
      receipt.trashPurgedCount > 0,
      text(`휴지통 완전삭제 ${purged}`, `purged ${purged} from trash`),
    ),
  ]);
}
