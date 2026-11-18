import { providerAccount, providerState } from "../support/providerAccountFixtures";

/**
 * 설정 → 연결 관리의 등록 계정 행에 붙는 도구 배지(`AccountToolBadges`,
 * src/components/SettingsView.tsx:2362)를 붙잡는다. 이 배지는 `accountToolBadges`
 * (src/lib/accountTools.ts:210)가 계산한 목록을 그대로 그린다 — 같은 서비스가 여러 경로로
 * 잡히면 가장 강한 귀속 근거 하나로 합치고(계정 > 공용 > 미확정), 표시는 계정 > 미확정 > 공용
 * 순으로 세운 뒤 10개에서 잘라 남은 수를 `+N`으로 접는다.
 *
 * 계정 도구 귀속은 단위 시험(src/lib/accountTools.test.mjs)에만 있고 화면으로 확인한 스펙이
 * 없다. 2026-09-17 회차에서 강도 표와 순서 표가 한 표로 합쳐졌는데(4610b866), 두 순위가 서로
 * 다르다는 사실이 화면까지 살아 있는지는 아무도 보지 않았다. 배지가 계정 간 차이를 보여 주는
 * 자리이므로, 한도에 잘릴 때 계정 단위 항목이 먼저 남는지가 이 화면의 쓸모를 가른다.
 *
 * 격리 백엔드에는 계정도 도구도 없으므로 `get_provider_accounts`와 `get_account_tools`를
 * 스텁해 세운다.
 */
const accountId = "codex-tool-badges";
const label = "도구 배지 계정";
const account = providerAccount({
  id: accountId,
  displayName: label,
  label,
  providerDisplayName: "Codex QA",
  providerAccountId: "codex-tool-account",
});
const accounts = { accounts: [account], providers: [providerState()], autoSwitchResume: false, autoSwitchPolicy: "registration", autoSwitchUsageGapPercent: null, resumeAccountPolicy: "activeAccount" };

function tool(overrides: Record<string, unknown>) {
  return {
    id: "t",
    service: "svc",
    label: "도구",
    kind: "mcp",
    attribution: "account",
    configured: true,
    exposed: true,
    access: "verified",
    ...overrides,
  };
}

function stubTools(tools: Record<string, unknown>[]) {
  cy.stubInvoke("get_account_tools", {
    statusCode: 200,
    body: { accounts: [{ accountId, provider: "codex", attributionResolved: true, tools }], homes: [] },
  });
}

function badges() {
  return cy.get(".provider-account-row .provider-account-tools .provider-account-tool").not(".toggle");
}

function openConnections() {
  cy.stubInvoke("get_provider_accounts", { statusCode: 200, body: accounts });
  // 기동 직후의 일괄 사용량 갱신도 같은 스냅샷을 줘야 등록 계정이 0건으로 덮이지 않는다.
  cy.stubInvoke("refresh_provider_account_usages", { statusCode: 200, body: accounts });
  cy.visitApp();
  cy.openSettingsTab("connections");
  cy.get(".provider-account-row").contains("strong", label).should("exist");
}

describe("계정 도구 배지의 합치기·순서·한도", () => {
  it("같은 서비스는 강한 귀속으로 합치고 노출되지 않은 도구는 빼며 계정 > 미확정 > 공용 순으로 세운다", () => {
    stubTools([
      // 같은 서비스가 두 경로로 잡혔다. 강한 쪽(account)만 남아야 한다.
      tool({ id: "notion-shared", service: "notion", label: "노션 공용경로", attribution: "shared" }),
      tool({ id: "notion-account", service: "notion", label: "노션", attribution: "account" }),
      // 노출되지 않은 도구와 서비스 슬러그가 빈 도구는 배지가 되지 않는다.
      tool({ id: "hidden", service: "hidden-svc", label: "숨은 도구", exposed: false }),
      tool({ id: "blank", service: "", label: "슬러그 없는 도구" }),
      // 순서 확인용 — 라벨 사전순과 귀속 순서가 어긋나게 둔다.
      tool({ id: "shared-a", service: "shared-a", label: "가공용", attribution: "shared" }),
      tool({ id: "unverified-b", service: "unverified-b", label: "나미확정", attribution: "unverified" }),
    ]);
    openConnections();

    badges().should("have.length", 3);
    // 합쳐진 뒤 남은 라벨은 계정 귀속 쪽이다.
    badges().eq(0).should("have.attr", "title", "노션").and("not.have.class", "unverified");
    // 라벨 사전순으로는 '가공용'이 앞서지만 귀속 순서가 먼저다.
    badges().eq(1).should("have.attr", "title", "나미확정").and("have.class", "unverified");
    badges().eq(2).should("have.attr", "title", "가공용").and("not.have.class", "unverified");
    cy.get(".provider-account-tools").should("not.contain.text", "노션 공용경로");
    cy.get(".provider-account-tools").should("not.contain.text", "숨은 도구");
    cy.get(".provider-account-tools").should("not.contain.text", "슬러그 없는 도구");
  });

  it("10개를 넘으면 +N으로 접되 계정 단위 항목이 먼저 남고, 상세정보를 켜면 한도가 풀린다", () => {
    const many = [
      tool({ id: "acc-1", service: "acc-1", label: "하계정", attribution: "account" }),
      tool({ id: "unv-1", service: "unv-1", label: "파미확정", attribution: "unverified" }),
      ...Array.from({ length: 11 }, (_, index) => tool({
        id: `sh-${index}`,
        service: `sh-${index}`,
        label: `공용${index}`,
        attribution: "shared",
      })),
    ];
    stubTools(many);
    openConnections();

    // 13개 중 10개만 보이고 나머지는 접힌다.
    badges().should("have.length", 11); // 배지 10 + '+N' 표식 1
    badges().last().should("have.text", "+3").and("have.attr", "title", "외 3개");
    // 한도에 잘려도 계정 단위 항목(계정·미확정)은 맨 앞에 남는다.
    badges().eq(0).should("have.attr", "title", "하계정");
    badges().eq(1).should("have.attr", "title", "파미확정").and("have.class", "unverified");

    // 상세정보를 켜면 한도가 풀려 13개가 모두 뜨고 접힘 표식이 사라진다.
    cy.get(".provider-account-tool.toggle").should("have.attr", "aria-pressed", "false").click();
    cy.get(".provider-account-tool.toggle").should("have.attr", "aria-pressed", "true");
    cy.get(".provider-account-tools").should("have.class", "detailed");
    badges().should("have.length", 13);
    cy.get(".provider-account-tool.more").should("not.exist");
    badges().last().should("contain.text", "공용");

    // 다시 끄면 한도가 돌아온다.
    cy.get(".provider-account-tool.toggle").click();
    badges().should("have.length", 11);
    badges().last().should("have.text", "+3");
  });
});
