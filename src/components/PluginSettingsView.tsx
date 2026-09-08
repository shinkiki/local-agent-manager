import { KeyRound, Plug } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { ExternalPluginsCard } from "./ExternalPluginsCard";
import { SettingsSubTabPanel, SettingsSubTabs, type SettingsSubTab } from "./SettingsSubTabs";
import { SshKeysCard } from "./SshKeysCard";

export type PluginSectionId = "external" | "ssh";

const pluginSections: readonly SettingsSubTab<PluginSectionId>[] = [
  { id: "external", icon: Plug, ko: "외부 MCP", en: "External MCP", anchor: "settings.plugins" },
  { id: "ssh", icon: KeyRound, ko: "SSH", en: "SSH", anchor: "settings.ssh-keys" },
];

/**
 * 설정의 플러그인 종류를 한 화면에 쌓지 않고 한 단계 낮은 중메뉴로 나눈다. Claude Code
 * 플러그인 카드는 에이전트별 부가 기능을 모은 주 메뉴의 애드온 화면(`AddonsView`)으로 옮겼다.
 *
 * 고른 중메뉴는 여기 지역 상태가 아니라 SettingsView가 들고 내려준다. 이 뷰는 상위 설정 탭이
 * 플러그인일 때만 마운트되므로, 지역 상태였을 때는 다른 설정 탭을 다녀오면 언마운트로 초기값
 * (외부 MCP)에 되감겼다(QA #46). 상위 설정 탭과 같이 세션 동안만 남고 새로고침에는 저장하지
 * 않는다(AM-129와 같은 계약).
 */
export function PluginSettingsView({ active, section, onSectionChange: setSection }: {
  active: boolean;
  section: PluginSectionId;
  onSectionChange: (next: PluginSectionId) => void;
}) {
  const { text } = useI18n();
  return (
    <div className="settings-subtab-view plugin-settings-view">
      <SettingsSubTabs idPrefix="plugin" tabs={pluginSections} value={section} onChange={setSection} label={text("플러그인 종류", "Plugin type")} />
      <SettingsSubTabPanel idPrefix="plugin" id="external" active={section === "external"}>
        <ExternalPluginsCard active={active && section === "external"} />
      </SettingsSubTabPanel>
      <SettingsSubTabPanel idPrefix="plugin" id="ssh" active={section === "ssh"}>
        <SshKeysCard active={active && section === "ssh"} />
      </SettingsSubTabPanel>
    </div>
  );
}
