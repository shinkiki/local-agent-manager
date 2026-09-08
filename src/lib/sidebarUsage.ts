import {
  displayUsageWindows,
  governingUsageWindows,
  nextUsageReset,
  usageLevel,
  usageWindowValueUnavailable,
  type DisplayUsageWindow,
  type UsageLevel,
} from "./accountUsage.ts";
import { formatCountdown } from "./format.ts";
import type { AccountSnapshot, AccountUsageView, ProviderId } from "../types";

export interface SidebarUsageSource {
  key: string;
  provider: ProviderId;
  /**
   * `default`·`home`은 계정 레지스트리에서 온 계정이고, `provider`는 계정을 관리하지
   * 않는 공급자(Antigravity)의 공급자 단위 쿼터다. 이름이 없어 공급자 이름만 쓴다.
   */
  kind: "default" | "home" | "provider";
  displayName: string | null;
  usage: AccountUsageView;
}

/**
 * 좌측 메뉴에 표시할 공급자별 사용량을 고른다. 등록된 기본 계정이 우선이고,
 * 기본 계정이 없으면 공유 CLI 홈에서 신원이 확인된 계정의 사용량을 사용한다.
 *
 * Antigravity는 계정 레지스트리에 없어 스냅샷으로 오지 않으므로 따로 받는다. 보여 줄
 * 창이 있을 때만 한 줄을 차지한다 — 미설치·미로그인·language server 미실행은 이
 * 기기에서 정상인 상태라, 다른 공급자의 카드에 "사용량 확인 오류"를 띄울 이유가 없다.
 */
export function sidebarUsageSources(
  snapshot: AccountSnapshot | null | undefined,
  antigravity: AccountUsageView | null = null,
): SidebarUsageSource[] {
  if (!snapshot) return [];

  const sources: SidebarUsageSource[] = [];
  for (const provider of snapshot.providers) {
    const defaultAccount = snapshot.accounts.find((account) => (
      account.id === provider.activeAccountId && account.provider === provider.provider
    ));
    if (defaultAccount) {
      sources.push({
        key: `account:${defaultAccount.id}`,
        provider: provider.provider,
        kind: "default",
        displayName: defaultAccount.displayName,
        usage: defaultAccount.usage,
      });
      continue;
    }

    if (provider.home.state !== "verified") continue;
    sources.push({
      key: `home:${provider.provider}`,
      provider: provider.provider,
      kind: "home",
      displayName: provider.home.email ?? provider.home.displayName ?? provider.home.providerAccountId,
      usage: provider.home.usage,
    });
  }
  if (antigravity && antigravity.windows.length > 0) {
    sources.push({
      key: "provider:antigravity",
      provider: "antigravity",
      kind: "provider",
      displayName: null,
      usage: antigravity,
    });
  }
  return sources;
}

export interface SidebarUsageWindowMeter {
  label: string;
  /** 0~100으로 다듬어진 소진율. 진행바 너비에 그대로 쓴다. 확인 불가면 0이다. */
  percent: number;
  /** 반올림한 표시 문구("37%"). 확인 불가면 그렇다고 적는다. */
  valueLabel: string;
  /** 눈금 색 단계. 설정 화면 미터와 같은 기준(`usageLevel`)을 쓴다. */
  level: UsageLevel;
  /**
   * 초기화 시각이 지난 뒤 재조회까지 실패해 이 창의 수치를 믿을 수 없는 상태.
   * 설정 화면 미터와 같은 판정(`usageWindowValueUnavailable`)이다.
   */
  unavailable: boolean;
  /**
   * 이 창이 초기화되기까지 남은 시간("4h 16m", "5d 12h"). 초기화 시각이 없거나 이미
   * 지났으면 null이다. 펼친 카드만 쓰고 접힌 줄에는 넣지 않는다 — 한 줄에 계정이
   * 여럿 늘어서는 자리라 창마다 시간을 더 붙이면 수치가 밀려 잘린다.
   */
  resetLabel: string | null;
  ariaLabel: string;
}

export interface SidebarUsageMeter {
  key: string;
  accountLabel: string;
  /** 비어 있으면 보여 줄 수치가 없다는 뜻이다. */
  windows: SidebarUsageWindowMeter[];
  /** 수치가 없을 때 값 자리에 넣을 문구. */
  unavailableValue: string;
  /** 카드 도움말이자 수치 없는 행의 설명. */
  title: string;
}

/** 좌측 메뉴 미터가 쓰는 문구. 로케일 결정은 화면이 하고 이 모듈은 조합만 한다. */
export interface SidebarUsageLabels {
  /** 공급자 표시 이름. 상태 스냅샷에 없으면 공급자 ID를 그대로 준다. */
  providerName: (provider: ProviderId) => string;
  /** 홈 계정 표시 뒤에 붙는 짧은 꼬리표. */
  home: string;
  /** 홈 계정인데 이름을 모를 때 쓰는 이름. */
  homeAccount: string;
  /** 갱신에 실패해 마지막 성공 수치를 그대로 보여 주는 중임을 알리는 문구. */
  stale: string;
  /** 보여 줄 수치가 하나도 없을 때의 창 이름. */
  unavailable: string;
  /** 수치가 없고 마지막 조회가 실패였을 때 값 자리에 넣는 문구. */
  error: string;
  /** 초기화 시각이 지난 뒤 재조회가 실패해 이 창의 수치를 믿을 수 없을 때의 문구. */
  windowUnavailable: string;
  /** 남은 시간("4h 16m")을 읽기 보조 기기가 읽을 문장으로 감싼다. */
  resetsIn: (countdown: string) => string;
}

/**
 * 계정 한 줄의 이름. 홈 계정은 등록 계정과 구분되게 꼬리표를 달고, 이름을 모르면
 * 대신 쓸 문구를 받는다. 미터 이름과 각 창의 aria 라벨이 같은 문자열을 써야 하므로
 * 조합은 여기 한 벌만 둔다.
 */
function sidebarAccountLabel(source: SidebarUsageSource, labels: SidebarUsageLabels): string {
  const providerName = labels.providerName(source.provider);
  if (source.kind === "provider") return providerName;
  if (source.kind !== "home") return `${providerName} · ${source.displayName}`;
  if (!source.displayName) return `${providerName} · ${labels.homeAccount}`;
  return `${providerName} · ${source.displayName} (${labels.home})`;
}

/**
 * 창 하나의 눈금. 초기화 시각이 지났는데 재조회가 실패했으면 0%라고 단정할 수 없다.
 * 초기화 직후 새 사용이 있었을 수 있어, 남은 한도가 넉넉하다고 읽히는 0%보다 모른다고
 * 적는 편이 안전하다(설정 화면 미터와 같은 판정).
 */
function sidebarWindowMeter(
  usage: AccountUsageView,
  window: DisplayUsageWindow,
  accountLabel: string,
  labels: SidebarUsageLabels,
  now: number,
): SidebarUsageWindowMeter {
  const unavailable = usageWindowValueUnavailable(usage, window);
  const percent = unavailable ? 0 : window.usedPercent;
  const valueLabel = unavailable ? labels.windowUnavailable : `${Math.round(percent)}%`;
  const resetLabel = window.resetsAt === null ? null : formatCountdown(window.resetsAt - now);
  return {
    label: window.label,
    percent,
    valueLabel,
    level: usageLevel(percent),
    unavailable,
    resetLabel,
    ariaLabel: `${accountLabel} · ${window.label} ${valueLabel}${resetLabel ? ` · ${labels.resetsIn(resetLabel)}` : ""}`,
  };
}

/**
 * 카드 도움말. 보여 줄 창이 없으면 그렇다고 적고, 있으면 창별 수치를 늘어놓는다.
 * 마지막 조회가 실패해 이전 값을 그대로 보여주는 중이라는 사실은 여기에만 덧붙인다.
 */
function sidebarMeterTitle(
  usage: AccountUsageView,
  windows: SidebarUsageWindowMeter[],
  accountLabel: string,
  labels: SidebarUsageLabels,
): string {
  if (windows.length === 0) return `${accountLabel} · ${labels.unavailable}`;
  const values = windows.map((window) => `${window.label} ${window.valueLabel}`).join(" · ");
  const stale = usage.status === "error" && usage.windows.length > 0 ? ` · ${labels.stale}` : "";
  return `${accountLabel} · ${values}${stale}`;
}

/**
 * 카드의 두 표시 방식. `compact`(접기, 기본)는 계정마다 한 줄에 계정 대표 창의 수치만
 * 늘어놓고, `detailed`(펴기)는 모델별 창까지 창마다 진행바를 그린다. 모델별 창은 그 모델을
 * 쓰는 실행에만 걸리는 표시 전용 값이라 접힌 카드에서는 뺀다(`governingUsageWindows`).
 */
export type SidebarUsageDensity = "compact" | "detailed";

/**
 * 좌측 메뉴에 그릴 계정별 미터를 만든다. 라벨 조합·소진율 다듬기·경고 단계 판정을
 * 한자리에 모아 App 셸은 결과를 그리기만 하게 한다. 계정 이름·창 눈금·도움말 문구는
 * 각자 판단 기준이 달라 함수로 나눠 두고, 여기서는 그 셋을 엮기만 한다.
 *
 * 도움말(title)은 밀도와 무관하게 모든 창을 적어, 접힌 카드에서도 마우스를 올리면
 * 모델별 수치까지 읽을 수 있게 한다.
 */
export function sidebarUsageMeters(
  sources: SidebarUsageSource[],
  now: number,
  labels: SidebarUsageLabels,
  density: SidebarUsageDensity = "detailed",
): SidebarUsageMeter[] {
  return sources.map((source) => {
    const accountLabel = sidebarAccountLabel(source, labels);
    const allWindows = displayUsageWindows(source.usage.windows, now);
    const meter = (window: DisplayUsageWindow) => sidebarWindowMeter(source.usage, window, accountLabel, labels, now);
    const detailed = allWindows.map(meter);
    const governing = governingUsageWindows(allWindows);
    // 대표 창이 하나도 없는 계정(모델별 창만 온 경우)은 접어도 창을 감추지 않는다.
    const windows = density === "compact" && governing.length > 0 ? governing.map(meter) : detailed;
    return {
      key: source.key,
      accountLabel,
      windows,
      unavailableValue: source.usage.status === "error" ? labels.error : "—",
      title: sidebarMeterTitle(source.usage, detailed, accountLabel, labels),
    };
  });
}

/** 좌측 메뉴 하단에 알릴, 아직 오지 않은 가장 이른 초기화 시각. */
export function nearestUsageReset(sources: SidebarUsageSource[], now: number): number | null {
  return nextUsageReset(
    sources.flatMap((source) => displayUsageWindows(source.usage.windows, now)),
    now,
  );
}

/**
 * 조회에 실패해도 마지막 성공 수치가 남아 있으면 그 값을 계속 보여준다. 보여줄
 * 값이 아예 없을 때만 실패를 문구로 알린다(설정 화면의 사용량 표시와 같은 규칙).
 */
export function sidebarUsageError(sources: SidebarUsageSource[]): boolean {
  return sources.some((source) => source.usage.status === "error" && source.usage.windows.length === 0);
}
