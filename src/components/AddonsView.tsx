import { Database, KeyRound, Plug } from "lucide-react";
import { useEffect, type ComponentType } from "react";
import { useI18n } from "../lib/i18n";
import type { TabRequest } from "../lib/uiGuide";
import { useStoredChoice } from "./SkillLibraryPanel";
import { BuiltinToolAccess } from "./BuiltinToolAccess";
import { ClaudePluginsCard } from "./ClaudePluginsCard";
import { CypressWorkspacePanel } from "./CypressWorkspacePanel";
import { DbConnectionsCard } from "./DbConnectionsCard";
import { ExternalPluginsCard } from "./ExternalPluginsCard";
import { MermaidPluginPanel } from "./MermaidPluginPanel";
import { SettingsSubTabPanel, SettingsSubTabs, type SettingsSubTab } from "./SettingsSubTabs";
import { SshKeysCard } from "./SshKeysCard";
import { brandMarkIcon } from "./Shared";

export type AddonsTabId = "mcp" | "ssh" | "db" | "cypress" | "mermaid" | "claude";

// 탭 id가 도구 축으로 바뀌어 예전 값(aia·codex)은 되살릴 자리가 없다. 키를 올려 옛 선택이
// 남아 있어도 기본 탭으로 떨어지게 한다. 자동화 탭이 워크플로 화면으로 옮겨 간 뒤에도
// 같은 규칙이 그대로 듣는다 — `automation`이 저장돼 있어도 유효 id가 아니라 기본 탭으로 선다.
const ADDONS_TAB_KEY = "agent-manager.addons-tab.v2";

/** 패널 한 벌이 받는 것. 애드온 탭은 모두 붙는 도구 하나를 다루므로 화면 상태만 받는다. */
export interface AddonsPanelProps {
  active: boolean;
}

interface AddonsTab extends SettingsSubTab<AddonsTabId> {
  tool?: string;
  panel: ComponentType<AddonsPanelProps>;
}

/**
 * 애드온 탭 한 줄이 곧 탭 버튼이자 그 안에 서는 내용이다. 탭 이름·표식과 패널 내용을 따로
 * 두었을 때는 탭 id를 한 탭마다 세 번(탭 표, 패널 id, `active` 판정) 되풀이해 적어야 했고,
 * 새 도구를 더할 때 한 자리를 빠뜨리면 다른 탭의 내용이 서는 식으로 틀어졌다. 한 표로 두면
 * 그 세 자리가 한 줄에서 나온다.
 *
 * 표식 — 상표가 있는 도구는 공식 표식으로 선다(Claude Code·Cypress·Mermaid). 외부 MCP·SSH는
 * 한 서비스가 아니라 갈래라 성격 아이콘 그대로다 — MCP는 공식 표식이 있지만 단색 글리프라
 * `<img>`로는 다크 테마에서 사라져 콘센트를 유지한다.
 *
 * `tool` — 기본도구 카탈로그에 있는 도구만 접근 경로 상세(`BuiltinToolAccess`)를 패널 맨 위에
 * 얹는다. Claude Code는 클로드 전용 라우트라 비운다.
 */
const addonsTabs: readonly AddonsTab[] = [
  { id: "mcp", icon: Plug, ko: "외부 MCP", en: "External MCP", anchor: "addons.tab.mcp", tool: "mcp", panel: ExternalPluginsCard },
  { id: "ssh", icon: KeyRound, ko: "SSH", en: "SSH", anchor: "addons.tab.ssh", tool: "ssh", panel: SshKeysCard },
  { id: "db", icon: Database, ko: "데이터베이스", en: "Database", anchor: "addons.tab.db", tool: "db", panel: DbConnectionsCard },
  { id: "cypress", icon: brandMarkIcon("cypress"), ko: "Cypress", en: "Cypress", anchor: "addons.tab.cypress", tool: "cypress", panel: CypressWorkspacePanel },
  { id: "mermaid", icon: brandMarkIcon("mermaid"), ko: "Mermaid", en: "Mermaid", anchor: "addons.tab.mermaid", tool: "mermaid", panel: MermaidPluginPanel },
  { id: "claude", icon: brandMarkIcon("claude"), ko: "Claude Code", en: "Claude Code", anchor: "addons.tab.claude", panel: ClaudePluginsCard },
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
 * 없앴다. Claude Code 탭은 클로드 전용 라우트를 가진 도구 하나로 같은 줄에 선다. 앱이 스스로
 * 돌리는 것들(회차 목표·온보딩 카드)의 자리였던 자동화 탭은 워크플로 화면의 마지막 탭으로
 * 옮겨 갔다 — 붙는 도구가 아니라 앱이 돌리는 절차라 워크플로와 같은 화면에 선다.
 */
export function AddonsView({ active, tabRequest = null }: {
  active: boolean;
  tabRequest?: TabRequest<AddonsTabId> | null;
}) {
  const { text } = useI18n();
  const [tab, setTab] = useStoredChoice<AddonsTabId>(ADDONS_TAB_KEY, ADDONS_TAB_IDS, "mcp");
  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest, setTab]);
  return (
    <div className="settings-subtab-view addons-view">
      <SettingsSubTabs idPrefix="addons" tabs={addonsTabs} value={tab} onChange={setTab} label={text("애드온 종류", "Add-on type")} />
      {addonsTabs.map((addon) => (
        <AddonPanelSlot addon={addon} selected={tab === addon.id} viewActive={active} key={addon.id} />
      ))}
    </div>
  );
}

/**
 * 탭의 선택 상태는 패널을 보일지 정하고, 화면 활성 상태까지 겹친 `shown`은 패널 내부의
 * 폴링·조회 여부를 정한다. 두 상태를 슬롯 한 곳에서 짝지어 새 탭도 같은 수명 규칙을 쓴다.
 */
function AddonPanelSlot({ addon: { id, tool, panel: Panel }, selected, viewActive }: {
  addon: AddonsTab;
  selected: boolean;
  viewActive: boolean;
}) {
  const shown = viewActive && selected;
  return (
    <SettingsSubTabPanel idPrefix="addons" id={id} active={selected}>
      {tool ? <BuiltinToolAccess toolId={tool} active={shown} /> : null}
      <Panel active={shown} />
    </SettingsSubTabPanel>
  );
}
