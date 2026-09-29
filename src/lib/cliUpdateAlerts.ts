import type { ProviderCliUpdateStatus, ProviderId } from "../types";
import { cliDetected, hasModelCacheCleanupTargets, versionCheckFailed } from "./cliUpdateStatus.ts";

// 여러 공급자의 CLI 상태를 한데 모아 화면이 무엇을 먼저 알릴지 정하는 규칙 — 상단 알림에
// 어떤 근거가 몇 건 쌓였고, 어느 공급자 카드의 업데이트 구획을 여는지. 버튼 하나를 지금
// 누를 수 있는지(cliUpdate.ts)와는 바뀌는 이유가 다르다. 알림 갈래는 "무엇을 사용자에게
// 먼저 알릴 것인가"라는 화면 구성이 바뀔 때 늘고, 버튼은 원격 권한이나 설치 지원 범위가
// 바뀔 때 손댄다. 또 이쪽만 공급자 여럿을 한꺼번에 보고, 버튼 쪽은 늘 상태 한 건만 본다.
//
// 화면들이 창구 하나만 알면 되도록 cliUpdate.ts가 이 모듈을 다시 내보낸다.

export interface CliUpdateAlert {
  /** 최신 버전이 확인되어 업데이트가 가능한 공급자. */
  updatable: ProviderId[];
  /** 캐시 기록 버전이 실행 버전보다 높아 스키마 불일치가 의심되는 공급자. */
  cacheMismatched: ProviderId[];
  /** 현재 또는 최신 버전을 읽지 못해 업데이트 필요 여부를 판단할 수 없는 공급자. */
  checkFailed: ProviderId[];
}

type CliUpdateAlertReason = keyof CliUpdateAlert;

/**
 * 상단 알림 근거 한 갈래가 무엇을 보고 붙는지. 업데이트 가능, 캐시 스키마 불일치, 버전
 * 확인 실패는 원인과 해결 방법이 다르므로 갈래는 그대로 셋으로 둔다. 다만 분류·유무
 * 판정·공급자별 조회가 저마다 그 셋을 손으로 늘어놓고 있어, 갈래를 하나 더하거나 이름을
 * 고칠 때 한 곳만 손대면 나머지가 조용히 빠졌다(새 갈래가 목록에는 쌓이는데 구획을 여는
 * 판정에는 잡히지 않는 식으로). 갈래 이름은 이 표에서만 정하고 나머지는 표를 훑는다.
 */
const CLI_UPDATE_ALERT_REASONS: Record<CliUpdateAlertReason, (status: ProviderCliUpdateStatus) => boolean> = {
  updatable: (status) => status.updateAvailable,
  cacheMismatched: hasModelCacheCleanupTargets,
  checkFailed: (status) => cliDetected(status) && versionCheckFailed(status),
};

const CLI_UPDATE_ALERT_REASON_KEYS = Object.keys(CLI_UPDATE_ALERT_REASONS) as CliUpdateAlertReason[];

/** 설정 화면 상단 알림 근거. 단일 순회로 분류해 중간 배열 할당을 줄인다. */
export function cliUpdateAlert(statuses: ProviderCliUpdateStatus[]): CliUpdateAlert {
  const alert: CliUpdateAlert = { updatable: [], cacheMismatched: [], checkFailed: [] };
  for (const status of statuses) {
    for (const reason of CLI_UPDATE_ALERT_REASON_KEYS) {
      if (CLI_UPDATE_ALERT_REASONS[reason](status)) alert[reason].push(status.provider);
    }
  }
  return alert;
}

export function hasCliUpdateAlert(alert: CliUpdateAlert): boolean {
  return CLI_UPDATE_ALERT_REASON_KEYS.some((reason) => alert[reason].length > 0);
}

/** 특정 공급자에게 상단 알림 근거 중 하나라도 있는지 확인한다. */
function hasProviderCliUpdateAlert(alert: CliUpdateAlert, provider: ProviderId): boolean {
  return CLI_UPDATE_ALERT_REASON_KEYS.some((reason) => alert[reason].includes(provider));
}

/** 업데이트 구획을 여는 동안 진행 중이거나 남아 있는 작업 상태. */
export interface CliUpdatePanelActivity {
  /** 이 공급자의 확인·업데이트·캐시 정리가 진행 중인지. */
  busy: boolean;
  /** 마지막 작업의 결과 안내나 오류가 아직 남아 있는지. */
  hasMessage: boolean;
  /** 종료 확인창이 열려 있는지. */
  pending: boolean;
}

/**
 * 공급자 카드에 업데이트 구획을 그릴지. 평상시(최신 버전·확인 미지원)에는 접어 두고
 * 상단 알림에 근거가 있는 공급자에서만 알림과 함께 연다. 진행 중인 작업과 방금 끝난
 * 작업의 결과는 알림 근거가 사라진 뒤에도 사용자가 읽을 수 있어야 하므로 함께 남긴다.
 */
export function shouldShowCliUpdatePanel(
  status: ProviderCliUpdateStatus,
  alert: CliUpdateAlert,
  activity: CliUpdatePanelActivity,
): boolean {
  if (activity.busy || activity.hasMessage || activity.pending) return true;
  return hasProviderCliUpdateAlert(alert, status.provider);
}
