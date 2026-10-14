/**
 * 좌측 메뉴에 **어느 계정의 사용량을 올릴지** 고르는 자리. 공급자마다 등록된 기본 계정이
 * 우선하고, 없으면 공유 CLI 홈의 검증된 계정으로 내려가며, 계정 레지스트리 밖의
 * Antigravity는 공급자 단위 쿼터로 따로 붙는다.
 *
 * 미터 조립(`sidebarUsage`)과는 서로 읽을 것이 없다. 저쪽은 소스 하나를 받아 이름·눈금·
 * 도움말 문자열을 만드는 일이라 화면에 적을 말과 접기 밀도가 바뀔 때 달라지고, 여기는
 * 계정 스냅샷의 모양만 보고 답이 정해진다 — 기본 계정이 무엇인지, 홈이 검증됐는지,
 * 공급자 쿼터에 창이 있는지. 두 반쪽이 함께 쓰는 것은 `SidebarUsageSource` 한 타입뿐이라
 * 그것을 고르는 쪽이 소유하고 조립하는 쪽이 빌려 쓴다.
 *
 * 한 파일에 두면 홈 계정 폴백 순서를 고치러 들어온 사람이 aria 라벨 조합과 도움말 문구를,
 * 반대로 접힌 줄의 문구를 한 줄 고치러 온 사람이 스냅샷 해석 규칙을 함께 읽게 된다.
 */
import type {
  AccountSnapshot,
  AccountUsageView,
  LocalLlmConnection,
  ProviderId,
} from "../types";

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
  /**
   * 사용량 한도가 없는 공급자. 창이 없는 것이 정상이므로 "확인 불가"가 아니라 "무제한"으로
   * 적는다 — 둘을 같게 그리면 쓸 수 있는 공급자가 고장 난 것처럼 보인다.
   */
  unlimited?: boolean;
}

/**
 * 사용량 한도가 없는 공급자의 상태바 자리. 창이 아니라 "무제한" 한 줄을 세운다.
 * 연결이 꺼져 있거나 주소가 비어 있으면 아예 붙이지 않는다 — 쓸 수 없는 공급자가
 * 상태바만 차지하면 안 된다.
 */
function resolveLocalSource(connection: LocalLlmConnection | null): SidebarUsageSource | null {
  if (!connection?.enabled || connection.baseUrl === "") return null;
  return {
    key: "provider:local",
    provider: "local",
    kind: "provider",
    displayName: null,
    usage: {
      status: "ok",
      windows: [],
      updatedAt: null,
      error: null,
      rateLimited: false,
      retryAt: null,
      resetCredits: null,
      tokenRefreshLimited: false,
    },
    unlimited: true,
  };
}

/**
 * 공급자 스냅샷에서 메뉴에 올릴 사용량 소스를 고른다.
 * 등록된 기본 계정이 우선하고, 기본 계정이 없으면 공유 CLI 홈의 검증된 계정을 쓴다.
 */
function resolveProviderSource(
  provider: AccountSnapshot["providers"][number],
  accounts: AccountSnapshot["accounts"],
): SidebarUsageSource | null {
  const defaultAccount = accounts.find((account) => (
    account.id === provider.activeAccountId && account.provider === provider.provider
  ));
  if (defaultAccount) {
    return {
      key: `account:${defaultAccount.id}`,
      provider: provider.provider,
      kind: "default",
      displayName: defaultAccount.displayName,
      usage: defaultAccount.usage,
    };
  }

  if (provider.home.state !== "verified") return null;
  return {
    key: `home:${provider.provider}`,
    provider: provider.provider,
    kind: "home",
    displayName: provider.home.email ?? provider.home.displayName ?? provider.home.providerAccountId,
    usage: provider.home.usage,
  };
}

/**
 * Antigravity는 계정 레지스트리에 없어 별도 쿼터로 받는다.
 * 표시할 창이 있을 때만 소스로 취급한다.
 */
function resolveAntigravitySource(antigravity: AccountUsageView | null): SidebarUsageSource | null {
  if (!antigravity || antigravity.windows.length === 0) return null;
  return {
    key: "provider:antigravity",
    provider: "antigravity",
    kind: "provider",
    displayName: null,
    usage: antigravity,
  };
}

/**
 * 좌측 메뉴의 공급자별 사용량 소스. 계정 레지스트리 밖에 있는 Antigravity는
 * 별도 쿼터를 받으며, 표시할 창이 있을 때만 추가한다.
 */
export function sidebarUsageSources(
  snapshot: AccountSnapshot | null | undefined,
  antigravity: AccountUsageView | null = null,
  localConnection: LocalLlmConnection | null = null,
): SidebarUsageSource[] {
  if (!snapshot) return [];

  const sources: SidebarUsageSource[] = [];
  for (const provider of snapshot.providers) {
    const source = resolveProviderSource(provider, snapshot.accounts);
    if (source) sources.push(source);
  }
  const antigravityRegistered = sources.some((source) => source.provider === "antigravity");
  const antigravitySource = antigravityRegistered ? null : resolveAntigravitySource(antigravity);
  if (antigravitySource) sources.push(antigravitySource);
  const localSource = resolveLocalSource(localConnection);
  if (localSource) sources.push(localSource);
  return sources;
}
