import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { nearestUsageReset, sidebarUsageError, sidebarUsageMeters } from "../lib/sidebarUsage";
import type { SidebarUsageDensity, SidebarUsageMeter, SidebarUsageSource, SidebarUsageWindowMeter } from "../lib/sidebarUsage";
import type { ProviderStatus } from "../types";

/**
 * 미터가 실제로 그릴 창. 창이 하나도 없는 계정도 자리를 비워 두지 않고 "정보 없음" 칸을
 * 같은 모양으로 그리므로, 접힘·펼침 어느 쪽도 이 목록 위에서 그린다.
 */
function statusbarMeterWindows(meter: SidebarUsageMeter, text: (ko: string, en: string) => string): SidebarUsageWindowMeter[] {
  if (meter.windows.length > 0) return meter.windows;
  return [{
    label: text("사용량 정보 없음", "Usage unavailable"),
    valueLabel: meter.unavailableValue,
    ariaLabel: meter.title,
    percent: 0,
    level: "normal",
    unavailable: true,
    resetLabel: null,
  }];
}

/** 창 한 칸의 상태 접미사. 접힘·펼침이 같은 색 단계 기준을 쓰도록 한자리에 둔다. */
function windowModifier(window: SidebarUsageWindowMeter): string {
  if (window.unavailable) return " unavailable";
  return window.level === "normal" ? "" : ` ${window.level}`;
}

/**
 * 접힌 상태바의 창 한 칸. 진행바 없이 창 이름과 수치만 한 줄에 늘어놓는다. 색 단계는 펼친
 * 카드의 수치와 같은 기준을 쓰고, 읽기 보조 기기에는 펼친 카드와 같은 문장을 준다.
 */
function StatusbarUsageValue({ window }: { window: SidebarUsageWindowMeter }) {
  return (
    <span className={`statusbar-usage-pill${windowModifier(window)}`} aria-label={window.ariaLabel}>
      <span className="statusbar-window-label">{window.label}</span>
      <span className="statusbar-usage-value">{window.valueLabel}</span>
    </span>
  );
}

/**
 * 펼친 상태바 카드의 창 한 칸. 창 이름·초기화까지 남은 시간·수치·진행바를 함께 그린다.
 * 남은 시간은 창 이름 옆에 붙여, 같은 소진율이라도 5시간 창과 7일 창 중 어느 쪽이 곧
 * 되돌아오는지를 수치와 나란히 읽게 한다.
 */
function StatusbarUsageWindow({ window }: { window: SidebarUsageWindowMeter }) {
  return (
    <div className={`statusbar-usage-window${windowModifier(window)}`}>
      <span className="statusbar-window-head">
        <span className="statusbar-window-label">{window.label}</span>
        {window.resetLabel && <span className="statusbar-window-reset">{window.resetLabel}</span>}
      </span>
      <span className="statusbar-usage-value">{window.valueLabel}</span>
      <span
        className="statusbar-progress"
        role="progressbar"
        aria-label={window.ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={window.unavailable ? undefined : Math.round(window.percent)}
      ><span style={{ width: `${window.percent}%` }} /></span>
    </div>
  );
}

/**
 * 화면 하단 상태바. 사이드바 폭을 늘리지 않도록 셸 전체 폭의 한 줄로 두고, 접기·펴기는
 * 맨 왼쪽, 새로고침은 맨 오른쪽에 고정한다. 펼치면 줄 위로 계정별 진행바 카드가 열린다.
 *
 * 미터·초기화 시각·오류 판정은 모두 같은 사용량 출처 한 벌에서 나오므로, App 셸이 그 셋을
 * 따로 계산해 넘기는 대신 출처만 받아 여기서 파생한다. 상태바가 무엇을 읽는지가 한 파일에
 * 모여, 표시 규칙을 고칠 때 셸의 렌더 본문을 헤집지 않아도 된다.
 */
export function AppStatusbar({ sources, providers, platform, architecture, density, onDensityChange, refreshing, onRefresh }: {
  sources: SidebarUsageSource[];
  providers: ProviderStatus[];
  platform: string;
  architecture: string;
  density: SidebarUsageDensity;
  onDensityChange: (next: SidebarUsageDensity) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { text } = useI18n();
  const now = Date.now();
  const detailed = density === "detailed";
  const meters = sidebarUsageMeters(sources, now, {
    providerName: (provider) => providers.find((entry) => entry.provider === provider)?.displayName ?? provider,
    home: text("홈", "Home"),
    homeAccount: text("홈 계정", "Home account"),
    stale: text("갱신 실패로 마지막 조회 값", "last successful reading kept"),
    unavailable: text("사용량 정보 없음", "Usage unavailable"),
    error: text("오류", "Error"),
    windowUnavailable: text("확인 불가", "Unknown"),
    resetsIn: (countdown) => text(`${countdown} 뒤 초기화`, `resets in ${countdown}`),
  }, density);
  const nearestReset = nearestUsageReset(sources, now);
  const usageError = sidebarUsageError(sources);
  const densityLabel = detailed
    ? text("사용량 상세정보 접기", "Collapse usage details")
    : text("사용량 상세정보 펴기", "Expand usage details");
  const refreshLabel = text("CLI 연결과 사용량 새로고침", "Refresh CLI connections and usage");

  return (
    <footer className={`app-statusbar ${density}`} aria-label={text("CLI 연결과 사용량 상태바", "CLI connection and usage status bar")}>
      {detailed && meters.length > 0 && <div
        className="statusbar-details"
        id="statusbar-usage-details"
        aria-label={text("기본 또는 홈 계정별 사용량 상세", "Usage details by default or home account")}
      >
        {meters.map((meter) => (
          <div className="statusbar-usage-card" key={meter.key} title={meter.title}>
            <span className="statusbar-usage-label">{meter.accountLabel}</span>
            {statusbarMeterWindows(meter, text).map((window) => <StatusbarUsageWindow key={window.label} window={window} />)}
          </div>
        ))}
      </div>}
      <div className="statusbar-line">
        {meters.length > 0 && <button
          className="icon-button compact statusbar-density"
          type="button"
          aria-expanded={detailed}
          aria-controls="statusbar-usage-details"
          aria-label={densityLabel}
          title={densityLabel}
          onClick={() => onDensityChange(detailed ? "compact" : "detailed")}
        >{detailed ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronUp size={13} aria-hidden="true" />}</button>}
        {!detailed && meters.length > 0 && <div
          className="statusbar-usages"
          aria-label={text("기본 또는 홈 계정별 사용량", "Usage by default or home account")}
        >
          {meters.map((meter) => (
            <span className="statusbar-usage" key={meter.key} title={meter.title}>
              <span className="statusbar-usage-label">{meter.accountLabel}</span>
              {statusbarMeterWindows(meter, text).map((window) => <StatusbarUsageValue key={window.label} window={window} />)}
            </span>
          ))}
        </div>}
        <span className="statusbar-detail">{usageError
          ? text("사용량 확인 오류", "Usage check failed")
          : nearestReset
            ? `${new Date(nearestReset).toLocaleString()} ${text("초기화", "reset")}`
            : `${platform} · ${architecture}`}</span>
        <button
          className={`icon-button compact statusbar-refresh${refreshing ? " busy" : ""}`}
          type="button"
          disabled={refreshing}
          aria-label={refreshLabel}
          title={refreshLabel}
          onClick={onRefresh}
        ><RefreshCw size={13} aria-hidden="true" /></button>
      </div>
    </footer>
  );
}
