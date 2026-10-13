import type { ProviderCliUpdateStatus } from "../types";
import { cliDetected, hasModelCacheCleanupTargets, type CliUpdateBadge } from "./cliUpdateStatus.ts";

// 읽어 둔 CLI 상태 한 건으로 그 공급자의 버튼을 지금 누를 수 있는지, 못 누르면 왜인지
// 정하는 규칙. 상태 한 건을 어떻게 읽는지는 cliUpdateStatus.ts가, 여러 공급자의 상태를
// 모아 상단 알림과 업데이트 구획을 정하는 일은 cliUpdateAlerts.ts가 맡는다. 화면이 창구
// 하나만 알면 되도록 둘 다 여기서 다시 내보낸다.
export { cacheAwaitsNewerCliRelease, cliUpdateBadge } from "./cliUpdateStatus.ts";
export type { CliUpdateBadge };
export { cliUpdateAlert, hasCliUpdateAlert, shouldShowCliUpdatePanel } from "./cliUpdateAlerts.ts";
export type { CliUpdateAlert, CliUpdatePanelActivity } from "./cliUpdateAlerts.ts";

export interface CliActionAccess {
  /**
   * 데스크톱 셸이 없는 서버 단독 기동인지(`/api/access`의 `headless`). 컨테이너 배포에서
   * CLI는 이미지 빌드 시점에 고정되므로 brew·npm 업데이트가 성립하지 않는다 —
   * 돌더라도 다음 컨테이너 재생성에서 이미지 버전으로 되돌아간다. 그래서 헤드리스에서는
   * 업데이트 버튼을 막고 "이미지 재빌드"를 갱신 경로로 안내한다
   * (docs/headless-linux-gaps.md H11).
   */
  headless?: boolean;
  busy?: boolean;
}

/**
 * 이 공급자의 버튼 하나를 지금 누를 수 없게 만드는 것. 확인·업데이트·캐시 정리가 각자
 * 다른 사다리를 보지만 막힘 갈래는 한 벌로 모은다.
 *
 * 예전에는 실행 파일 쪽과 캐시 쪽이 "막힘 갈래 · 누를 수 있는지 · 왜 못 누르는지" 세
 * 조각을 한 벌씩 따로 들고 있었다. 두 벌 모두 같은 두 규칙(막는 것이 없고 다른 작업도
 * 돌지 않아야 누른다 · 원격 쓰기 금지는 같은 문구로 알린다)을 손으로 다시 적고 있어,
 * 한쪽에 갈래를 더하면 나머지가 예전 기준으로 남았다. 갈래는 이 타입에서만 늘리고,
 * 갈래를 문구로 옮기는 일과 "누를 수 있는지"는 각각 아래 한 자리에서만 정한다.
 */
type CliActionBlock =
  | "noExecutable"
  | "checkUnsupported"
  | "updateUnsupported"
  | "cacheUnsupported"
  | "nothingToClear"
  | "headlessImage";

/**
 * 헤드리스 배포에서 CLI를 갱신하는 유일한 경로. 화면의 업데이트 구획과 수동 안내가 같은
 * 문장을 써야 해서 문구를 여기 한 번만 적는다.
 */
export const CLI_HEADLESS_IMAGE_HINT =
  "컨테이너 이미지에 포함된 CLI입니다. 이미지를 다시 빌드해 갱신하세요.";

/**
 * 막힘 갈래를 사용자에게 보일 문구로 옮기는 표. `null`인 갈래는 문구를 내지 않는다 —
 * `nothingToClear`는 막힌 것이 아니라 지울 것이 없을 뿐이라 경고를 붙이면 안 되고,
 * `checkUnsupported`는 확인 버튼이 이 모듈에 사유를 묻지 않고 자기 안내를 직접 단다.
 * 없는 문구를 지어내지 않으려고 두 자리를 비워 둔 것이므로, 갈래를 더할 때 문구가
 * 필요한지부터 이 표에서 정한다.
 */
const CLI_ACTION_BLOCK_REASONS: Record<
  CliActionBlock,
  ((status: ProviderCliUpdateStatus) => string) | null
> = {
  noExecutable: () => "CLI 실행 파일이 탐지되지 않았습니다.",
  checkUnsupported: null,
  updateUnsupported: (status) => status.unsupportedReason ?? "자동 업데이트를 지원하지 않는 설치입니다.",
  cacheUnsupported: (status) =>
    status.modelCacheUnsupportedReason ?? "이 공급자는 자동 캐시 정리를 지원하지 않습니다.",
  nothingToClear: null,
  // 헤드리스(컨테이너) 배포. 갱신 경로가 brew·npm이 아니라 이미지 재빌드다.
  headlessImage: () => CLI_HEADLESS_IMAGE_HINT,
};

/**
 * 실행 파일을 두드리는 작업(확인·업데이트)을 막고 있는 것. 막는 것이 없으면 null.
 * 두 작업이 다른 것은 지원 여부 한 칸과 미지원을 부르는 이름뿐이므로 그 둘만 받는다.
 */
function executableActionBlock(
  status: ProviderCliUpdateStatus,
  supported: boolean,
  unsupported: CliActionBlock,
  access: CliActionAccess,
  headlessBlocks = false,
): CliActionBlock | null {
  if (!cliDetected(status)) return "noExecutable";
  // 헤드리스는 지원 여부보다 앞선다. 컨테이너에서는 설치 출처가 brew든 npm이든 갱신이
  // 이미지 재빌드이므로, 공급자별 미지원 사유 대신 재빌드 안내 하나만 나가야 한다.
  if (headlessBlocks && access.headless === true) return "headlessImage";
  if (!supported) return unsupported;
  return null;
}

/** 이 모듈이 판정하는 버튼 셋. 화면이 부르는 이름과 짝이 맞는다. */
type CliAction = "check" | "update" | "clearModelCaches";

/**
 * 작업별로 무엇이 막고 있는지 정하는 사다리. 막는 것이 없으면 null.
 *
 * 세 작업이 저마다 "사다리를 세우고, 그 결과로 누를 수 있는지와 왜 못 누르는지를 낸다"를
 * 서로 다른 모양으로 들고 있었다 — 확인은 사다리를 이름 없이 호출부에 펼쳐 두었고,
 * 업데이트는 두 export 사이에 낀 전용 함수를, 캐시 정리는 또 다른 이름의 전용 함수를 썼다.
 * 사다리에 이름이 붙은 작업만 사유를 낼 수 있어 확인 버튼은 사유 창구가 아예 없고,
 * 작업을 하나 더할 때 세 벌 중 어느 모양을 따를지가 정해져 있지 않았다.
 *
 * 사다리는 이 표에서만 세우고, 그 결과를 "누를 수 있는지"와 "왜 못 누르는지"로 옮기는 일은
 * 아래 두 함수가 한 번씩만 한다. 작업을 더할 때 손댈 곳은 이 표와 갈래 목록뿐이다.
 */
const CLI_ACTION_BLOCKS: Record<
  CliAction,
  (status: ProviderCliUpdateStatus, access: CliActionAccess) => CliActionBlock | null
> = {
  check: (status, access) =>
    executableActionBlock(status, status.checkSupported, "checkUnsupported", access),
  // 확인(읽기)과 캐시 정리(앱 데이터)는 헤드리스에서도 그대로 동작한다. 이미지에 고정된
  // 것은 실행 파일뿐이므로 헤드리스가 막는 작업은 업데이트 하나다.
  update: (status, access) =>
    executableActionBlock(status, status.updateSupported, "updateUnsupported", access, true),
  // 지울 대상이 없는 상태는 막힘과 나란히 두되 문구를 내지 않는 갈래(`nothingToClear`)로
  // 적어, 지울 것이 없을 뿐인 버튼에 경고가 붙지 않게 한다.
  clearModelCaches: (status) => {
    if (status.modelCaches.length === 0) return "cacheUnsupported";
    if (!hasModelCacheCleanupTargets(status)) return "nothingToClear";
    return null;
  },
};

/** 막는 것이 없고 다른 작업이 돌고 있지도 않을 때만 누를 수 있다. */
function cliActionAllowed(
  action: CliAction,
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): boolean {
  return CLI_ACTION_BLOCKS[action](status, access) === null && !access.busy;
}

/** 이 작업을 막고 있는 것의 안내 문구. 막는 것이 없거나 문구를 내지 않는 갈래면 null. */
function cliActionBlockedReason(
  action: CliAction,
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): string | null {
  const block = CLI_ACTION_BLOCKS[action](status, access);
  return block === null ? null : CLI_ACTION_BLOCK_REASONS[block]?.(status) ?? null;
}

/** 최신 버전 확인 버튼을 누를 수 있는지. 원격에서도 write 권한이 있으면 조회한다. */
export function canCheckCliUpdate(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): boolean {
  return cliActionAllowed("check", status, access);
}

export function canRunCliUpdate(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): boolean {
  return cliActionAllowed("update", status, access);
}

/** 업데이트를 실행할 수 없는 이유. 실행 가능하면 null. 막는 것이 무엇인지는 사다리가 정한다. */
export function cliUpdateBlockedReason(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): string | null {
  return cliActionBlockedReason("update", status, access);
}

/**
 * 이 업데이트 사유가 헤드리스(이미지 재빌드) 사유인지. 화면은 이 자리에만 영어 짝을
 * 붙이므로 문구를 문자열로 비교하는 대신 판정을 여기서 한 번만 한다 — 비교로 고르면
 * 문구를 다듬는 순간 안내가 조용히 한국어로 돌아간다.
 */
export function isHeadlessImageUpdateBlock(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): boolean {
  return CLI_ACTION_BLOCKS.update(status, access) === "headlessImage";
}

/**
 * brew·npm 수동 업데이트 안내를 보일지. 헤드리스에서는 갱신 경로가 이미지 재빌드뿐이라
 * 수동 명령을 함께 적으면 서로 다른 두 경로를 동시에 말하게 된다. 판정을 JSX에 두면
 * 시험이 닿지 않아 조건이 사라져도 전부 녹색이므로 여기서 정한다.
 */
export function shouldShowManualUpdateHint(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): boolean {
  return Boolean(status.manualUpdateHint) && access.headless !== true;
}

/** 캐시 정리 버튼을 누를 수 있는지. */
export function canClearModelCaches(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): boolean {
  return cliActionAllowed("clearModelCaches", status, access);
}

/** 캐시 정리를 제공할 수 없는 이유. 제공 가능하거나 할 일이 없을 뿐이면 null. */
export function modelCacheBlockedReason(
  status: ProviderCliUpdateStatus,
  access: CliActionAccess,
): string | null {
  return cliActionBlockedReason("clearModelCaches", status, access);
}

/** 종료 확인이 필요한 대상 수. 0이면 확인창 없이 진행할 수 있다. */
export function runtimeStopConfirmationCount(counts: {
  chatCount: number;
  terminalCount: number;
  externalProcessCount: number;
}): number {
  return counts.chatCount + counts.terminalCount + counts.externalProcessCount;
}
