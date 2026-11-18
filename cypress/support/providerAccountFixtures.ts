/// <reference types="cypress" />

// 상태바·사이드바 사용량 스펙 넷이 `get_provider_accounts` 응답의 세 덩어리(사용량 4필드·
// 계정 18필드·공급자 상태 6필드와 홈 10필드)를 저마다 통째로 적어 두고 있었다. 계정 하나를
// 세우는 데만 20줄이 들었고 백엔드가 필드를 하나 늘리면 네 곳을 같이 고쳐야 했다. 기본 모양을
// 여기 한 벌만 두고 스펙은 그 시험이 실제로 읽는 값만 덮어쓴다. 스펙이 부르는 세우기 함수와
// 스텁만 밖으로 내보내고, 모양을 적는 타입과 응답을 조립하는 중간 걸음은 모듈 안에 둔다.

interface UsageWindowFixture {
  label: string;
  usedPercent: number;
  resetsAt: number | null;
  modelScoped?: boolean;
}

interface AccountUsageFixture {
  status: string;
  windows: UsageWindowFixture[];
  updatedAt: number | null;
  error: string | null;
}

interface ProviderAccountFixture {
  id: string;
  provider: string;
  displayName: string;
  email: string | null;
  organization: string | null;
  providerAccountId: string;
  label: string | null;
  providerDisplayName: string;
  isActive: boolean;
  disabled: boolean;
  autoSwitch: boolean;
  autoSwitchPriority: number | null;
  authStatus: string;
  usage: AccountUsageFixture;
  note: string | null;
  credentialIsolated: boolean;
  credentialIsolationNote: string | null;
  credentialExpiresAt: number | null;
  runtimeCount: number;
}

interface ProviderHomeFixture {
  state: string;
  email: string | null;
  displayName: string | null;
  providerAccountId: string | null;
  accountId: string | null;
  accessTokenExpiresAt: number | null;
  checkedAt: number | null;
  retryAt: number | null;
  error: string | null;
  usage: AccountUsageFixture;
}

interface ProviderStateFixture {
  provider: string;
  activeAccountId: string | null;
  observedActiveAccountId: string | null;
  runtimeCount: number;
  lastAutoSwitch: unknown;
  home: ProviderHomeFixture;
}

interface ProviderAccountsSnapshotFixture {
  accounts: ProviderAccountFixture[];
  providers: ProviderStateFixture[];
  autoSwitchResume: boolean;
  autoSwitchPolicy: string;
  autoSwitchUsageGapPercent: number | null;
  resumeAccountPolicy: string;
}

/** 창이 없는 정상 사용량. 창을 보는 시험만 `windows`를 넘긴다. */
export function accountUsage(overrides: Partial<AccountUsageFixture> = {}): AccountUsageFixture {
  return { status: "ok", windows: [], updatedAt: 1_700_000_000_000, error: null, ...overrides };
}

/** 등록 계정 하나. 기본은 활성 Codex 계정이고, 사용량은 창 없는 정상 응답이다. */
export function providerAccount(overrides: Partial<ProviderAccountFixture> = {}): ProviderAccountFixture {
  return {
    id: "codex-1",
    provider: "codex",
    displayName: "기본 계정",
    email: null,
    organization: null,
    providerAccountId: "codex-acc",
    label: null,
    providerDisplayName: "기본 계정",
    isActive: true,
    disabled: false,
    autoSwitch: false,
    autoSwitchPriority: null,
    authStatus: "ok",
    usage: accountUsage(),
    note: null,
    credentialIsolated: true,
    credentialIsolationNote: null,
    // 만료를 밝히지 않는 상태가 기본이다. 만료 예고를 보는 스펙만 시각을 넘긴다.
    credentialExpiresAt: null,
    runtimeCount: 0,
    ...overrides,
  };
}

// 홈 자격증명은 이 스펙들이 보는 대상이 아니라 늘 "없음"이다. 홈 사용량 갈래를 보는 시험만
// `home`을 통째로 덮어쓴다.
/** 공급자별 상태. 기본은 홈 자격증명이 없는 Codex다. */
export function providerState(overrides: Partial<ProviderStateFixture> = {}): ProviderStateFixture {
  return {
    provider: "codex",
    activeAccountId: null,
    observedActiveAccountId: null,
    runtimeCount: 0,
    lastAutoSwitch: null,
    home: {
      state: "absent",
      email: null,
      displayName: null,
      providerAccountId: null,
      accountId: null,
      accessTokenExpiresAt: null,
      checkedAt: null,
      retryAt: null,
      error: null,
      usage: accountUsage(),
    },
    ...overrides,
  };
}

/** `get_provider_accounts` 응답 전체. 자동 전환 설정은 어느 스펙도 읽지 않아 고정값이다. */
function providerAccountsSnapshot(
  providers: ProviderStateFixture[],
  accounts: ProviderAccountFixture[] = [],
): ProviderAccountsSnapshotFixture {
  return {
    accounts,
    providers,
    autoSwitchResume: false,
    autoSwitchPolicy: "registration",
    autoSwitchUsageGapPercent: null,
    resumeAccountPolicy: "activeAccount",
  };
}

/** 스냅샷을 세우는 두 걸음(200 응답으로 감싸 스텁)까지 스펙마다 같은 모양이라 함께 둔다. */
export function stubProviderAccounts(
  providers: ProviderStateFixture[],
  accounts: ProviderAccountFixture[] = [],
): void {
  cy.stubInvoke("get_provider_accounts", {
    statusCode: 200,
    body: providerAccountsSnapshot(providers, accounts),
  });
}

// 로컬 LLM은 계정 레지스트리에 없어 상태바가 `get_local_llm_connection`을 따로 읽는다
// (`src/App.tsx:358`). 연결이 켜져 있으면 상태바에 "무제한" 자리가 하나 더 붙으므로,
// 미터 수를 세는 스펙은 그 자리가 없다는 것을 사전조건으로 못박아야 한다. 격리 백엔드는
// 지금 꺼진 연결을 돌려주지만 그것은 기본값이지 이 스펙들이 요구하는 조건이 아니다 —
// `get_antigravity_usage`를 같은 이유로 스텁해 두는 것과 같은 방어다.
/** 연결하지 않은 로컬 LLM. 상태바·설정에 로컬 자리가 생기지 않는다. */
export function stubLocalLlmDisconnected(): void {
  cy.stubInvoke("get_local_llm_connection", {
    statusCode: 200,
    body: { baseUrl: "", defaultModel: "", contextWindow: null, apiKeyConfigured: false, enabled: false },
  });
}
