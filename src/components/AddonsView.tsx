import { Database, KeyRound, Plug } from "lucide-react";
import { useEffect, type ComponentType } from "react";
import { useI18n } from "../lib/i18n";
import type { SystemAutomationSnapshot } from "../types";
import type { TabRequest } from "../lib/uiGuide";
import { useStoredChoice } from "./SkillLibraryPanel";
import { AiaOnboardingCards } from "./AiaOnboardingCards";
import { RoundGoalsPanel } from "./RoundGoalsPanel";
import { BuiltinToolAccess } from "./BuiltinToolAccess";
import { ClaudePluginsCard } from "./ClaudePluginsCard";
import { CypressWorkspacePanel } from "./CypressWorkspacePanel";
import { DbConnectionsCard } from "./DbConnectionsCard";
import { ExternalPluginsCard } from "./ExternalPluginsCard";
import { MermaidPluginPanel } from "./MermaidPluginPanel";
import { SettingsSubTabPanel, SettingsSubTabs, type SettingsSubTab } from "./SettingsSubTabs";
import { SshKeysCard } from "./SshKeysCard";
import { LogoMark, brandMarkIcon } from "./Shared";

export type AddonsTabId = "mcp" | "ssh" | "db" | "cypress" | "mermaid" | "claude" | "automation";

// 탭 id가 도구 축으로 바뀌어 예전 값(aia·codex)은 되살릴 자리가 없다. 키를 올려 옛 선택이
// 남아 있어도 기본 탭으로 떨어지게 한다.
const ADDONS_TAB_KEY = "agent-manager.addons-tab.v2";


/**
 * 자동화 탭의 표식. 다른 탭은 붙는 도구를 가리키지만 자동화는 붙는 도구가 없다 — 에이전트
 * 매니저가 직접 만들어 주는 기능이라 앱의 메인 표식(타륜)으로 선다. 로고는 자기 `role="img"`와
 * 이름을 갖고 있어 그대로 두면 탭 이름이 "Agent Manager 로고 자동화"로 읽히므로, 감싼 자리에서
 * 숨겨 장식으로 둔다. 탭 크기에서는 로고의 놋빛 드롭섀도가 이웃 탭까지 번져 CSS로 걷는다.
 */
function AgentManagerMark({ size }: { size?: number }) {
  return <span className="agent-manager-mark" aria-hidden="true"><LogoMark size={size} /></span>;
}

/**
 * 애드온 탭 한 줄이 곧 탭 버튼이자 그 안에 서는 내용이다. 탭 이름·표식과 패널 내용을 따로
 * 두었을 때는 탭 id를 한 탭마다 세 번(탭 표, 패널 id, `active` 판정) 되풀이해 적어야 했고,
 * 새 도구를 더할 때 한 자리를 빠뜨리면 다른 탭의 내용이 서는 식으로 틀어졌다. 한 표로 두면
 * 그 세 자리가 한 줄에서 나온다.
 *
 * 표식 — 상표가 있는 도구는 공식 표식으로 선다(Claude Code·Cypress·Mermaid). 외부 MCP·SSH는
 * 한 서비스가 아니라 갈래라 성격 아이콘 그대로다 — MCP는 공식 표식이 있지만 단색 글리프라
 * `<img>`로는 다크 테마에서 사라져 콘센트를 유지한다. 자동화는 앱 자신의 표식으로 선다.
 *
 * `tool` — 기본도구 카탈로그에 있는 도구만 접근 경로 상세(`BuiltinToolAccess`)를 패널 맨 위에
 * 얹는다. Claude Code는 클로드 전용 라우트라, 자동화는 붙는 도구가 아니라 비운다.
 */
/**
 * 패널 한 벌이 받는 것. 대부분의 탭은 `active`만 쓰지만 자동화 탭의 온보딩 카드는 앱이 들고
 * 있는 시스템 자동화 스냅숏을 읽고 쓰므로, 그 세 값을 모든 패널에 똑같이 흘려 보낸다 —
 * 자동화 탭만 따로 그리면 탭 표 하나에서 이름·표식·내용이 나온다는 이 파일의 규칙이 깨진다.
 */
export interface AddonsPanelProps {
  active: boolean;
  automation?: SystemAutomationSnapshot | null;
  onAutomationChange?: (snapshot: SystemAutomationSnapshot) => void;
  onSkillsChanged?: () => void;
  /**
   * 적어 둔 요청문 하나로 AIA 대화를 띄운다. 애드온 패널에서 "없으면 AIA에게 만들어
   * 달라고 한다"는 갈래가 열리는 자리다 — 없으면(시스템 에이전트를 고르지 않았으면)
   * 그 버튼은 서지 않는다.
   */
  onRequestAiaPrompt?: (prompt: string) => void;
  /** 로고 새로고침이 올리는 나수. 스스로 다시 읽지 않는 패널이 이 값을 보고 다시 읽는다. */
  refreshNonce?: number;
}

interface AddonsTab extends SettingsSubTab<AddonsTabId> {
  tool?: string;
  panel: ComponentType<AddonsPanelProps>;
}

const addonsTabs: readonly AddonsTab[] = [
  { id: "mcp", icon: Plug, ko: "외부 MCP", en: "External MCP", anchor: "addons.tab.mcp", tool: "mcp", panel: ExternalPluginsCard },
  { id: "ssh", icon: KeyRound, ko: "SSH", en: "SSH", anchor: "addons.tab.ssh", tool: "ssh", panel: SshKeysCard },
  { id: "db", icon: Database, ko: "데이터베이스", en: "Database", anchor: "addons.tab.db", tool: "db", panel: DbConnectionsCard },
  { id: "cypress", icon: brandMarkIcon("cypress"), ko: "Cypress", en: "Cypress", anchor: "addons.tab.cypress", tool: "cypress", panel: CypressWorkspacePanel },
  { id: "mermaid", icon: brandMarkIcon("mermaid"), ko: "Mermaid", en: "Mermaid", anchor: "addons.tab.mermaid", tool: "mermaid", panel: MermaidPluginPanel },
  { id: "claude", icon: brandMarkIcon("claude"), ko: "Claude Code", en: "Claude Code", anchor: "addons.tab.claude", panel: ClaudePluginsCard },
  { id: "automation", icon: AgentManagerMark, ko: "자동화", en: "Automation", anchor: "addons.tab.automation", panel: AutomationPanel },
];

/** 저장된 탭 값을 되살릴 때 쓰는 유효 id 집합. 탭 표에서 뽑아 두 곳이 어긋나지 않게 한다. */
const ADDONS_TAB_IDS: readonly AddonsTabId[] = addonsTabs.map((tab) => tab.id);

/**
 * 주 메뉴의 애드온 화면. 에이전트가 아니라 붙는 도구로 탭을 나눈다 — SSH·Cypress·외부 MCP는
 * AIA 전용이 아니라 앱이 모든 에이전트에 붙여 주는 기본도구라, 에이전트별로 갈랐을 때는
 * 어느 탭에 두어도 오분류였다. 대신 도구마다 접힌 상세로 어느 에이전트가 어떤 경로로 쓰는지
 * 보인다(`BuiltinToolAccess`).
 *
 * 앞 네 탭은 설정 → 플러그인 중메뉴에 있던 카드를 동작 그대로 옮겨 온 것이고, 그 설정 탭은
 * 없앴다. Claude Code 탭은 클로드 전용 라우트를 가진 도구 하나로 같은 줄에 선다. 자동화 탭은
 * 앱이 스스로 돌리는 것들의 자리라, 회차 목표와 온보딩 카드가 선다.
 */
export function AddonsView({ active, tabRequest = null, automation = null, onAutomationChange, onSkillsChanged, onRequestAiaPrompt, refreshNonce = 0 }: {
  active: boolean;
  tabRequest?: TabRequest<AddonsTabId> | null;
} & Omit<AddonsPanelProps, "active">) {
  const { text } = useI18n();
  const [tab, setTab] = useStoredChoice<AddonsTabId>(ADDONS_TAB_KEY, ADDONS_TAB_IDS, "mcp");
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest, setTab]);
  return (
    <div className="settings-subtab-view addons-view">
      <SettingsSubTabs idPrefix="addons" tabs={addonsTabs} value={tab} onChange={setTab} label={text("애드온 종류", "Add-on type")} />
      {addonsTabs.map((addon) => (
        <AddonPanelSlot
          addon={addon}
          selected={tab === addon.id}
          viewActive={active}
          automation={automation}
          onAutomationChange={onAutomationChange}
          onSkillsChanged={onSkillsChanged}
          onRequestAiaPrompt={onRequestAiaPrompt}
          refreshNonce={refreshNonce}
          key={addon.id}
        />
      ))}
    </div>
  );
}

/**
 * 탭의 선택 상태는 패널을 보일지 정하고, 화면 활성 상태까지 겹친 `shown`은 패널 내부의
 * 폴링·조회 여부를 정한다. 두 상태를 슬롯 한 곳에서 짝지어 새 탭도 같은 수명 규칙을 쓴다.
 */
function AddonPanelSlot({ addon: { id, tool, panel: Panel }, selected, viewActive, ...panelProps }: {
  addon: AddonsTab;
  selected: boolean;
  viewActive: boolean;
} & Omit<AddonsPanelProps, "active">) {
  const shown = viewActive && selected;
  return (
    <SettingsSubTabPanel idPrefix="addons" id={id} active={selected}>
      {tool ? <BuiltinToolAccess toolId={tool} active={shown} /> : null}
      <Panel {...panelProps} active={shown} />
    </SettingsSubTabPanel>
  );
}

/**
 * 자동화 탭의 내용. 회차 목표가 먼저, 데이터로 오는 온보딩 카드가 그 아래다. 카드는 이 파일이
 * 아니라 온보딩 팩이 정한다(W6). AIA 선제 제안은 AIA 자체를 켜고 끄는 자리인 설정 → AIA
 * 설정으로 옮겨 갔다 — 여기 있을 때는 제안이 뜨지 않는 이유를 두 화면에서 맞춰 봐야 했다.
 */
function AutomationPanel(props: AddonsPanelProps) {
  return <>
    <RoundGoalsPanel onRequestAiaPrompt={props.onRequestAiaPrompt} refreshNonce={props.refreshNonce} />
    <AiaOnboardingCards {...props} />
  </>;
}
