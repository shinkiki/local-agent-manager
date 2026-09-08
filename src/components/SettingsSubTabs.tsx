import type { ComponentType, KeyboardEvent, PropsWithChildren } from "react";
import { useEffect, useRef } from "react";
import { useI18n } from "../lib/i18n";

export interface SettingsSubTab<Id extends string> {
  id: Id;
  /** lucide 아이콘이나 AiaMark처럼 `size`만 받으면 되는 표식. */
  icon: ComponentType<{ size?: number; "aria-hidden"?: "true" }>;
  ko: string;
  en: string;
  /** 탭 버튼의 `data-ui-anchor`. AIA 화면 안내(uiGuideTargets.json)와 E2E가 같은 이름으로 찍는다. */
  anchor: string;
}

const tabElementId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
const panelElementId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

/**
 * 설정 탭 안의 중메뉴(플러그인·애드온). 카드를 한 화면에 쌓지 않고 한 단계 낮은 탭으로
 * 나누며, 좌우 화살표·Home·End 이동과 좁은 화면에서 선택된 탭 끌어오기를 공통으로 맡는다.
 * 패널은 호출 쪽이 같은 `idPrefix`의 `SettingsSubTabPanel`로 그려 aria 연결을 잇는다.
 */
export function SettingsSubTabs<Id extends string>({ idPrefix, tabs, value, onChange, label }: {
  idPrefix: string;
  tabs: readonly SettingsSubTab<Id>[];
  value: Id;
  onChange: (next: Id) => void;
  label: string;
}) {
  const { text } = useI18n();
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const nav = navRef.current;
    const selected = nav?.querySelector<HTMLElement>("button.active");
    if (!nav || !selected) return;
    const left = selected.offsetLeft - 10;
    const right = selected.offsetLeft + selected.offsetWidth + 10 - nav.clientWidth;
    const next = nav.scrollLeft < right ? right : nav.scrollLeft > left ? left : null;
    if (next !== null) nav.scrollTo({ left: Math.max(0, next), behavior: "smooth" });
  }, [value]);

  const move = (event: KeyboardEvent<HTMLButtonElement>, current: Id) => {
    const index = tabs.findIndex((item) => item.id === current);
    const last = tabs.length - 1;
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? last
        : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? (index + 1) % tabs.length
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? (index - 1 + tabs.length) % tabs.length
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex].id;
    onChange(next);
    window.requestAnimationFrame(() => document.getElementById(tabElementId(idPrefix, next))?.focus());
  };

  return (
    <nav className="chat-hub-tabs settings-subtab-nav" ref={navRef} role="tablist" aria-label={label}>
      {tabs.map((item) => (
        <button
          className={value === item.id ? "active" : ""}
          type="button"
          role="tab"
          id={tabElementId(idPrefix, item.id)}
          aria-selected={value === item.id}
          aria-controls={panelElementId(idPrefix, item.id)}
          tabIndex={value === item.id ? 0 : -1}
          data-ui-anchor={item.anchor}
          key={item.id}
          onClick={() => onChange(item.id)}
          onKeyDown={(event) => move(event, item.id)}
        >
          <item.icon size={13} aria-hidden="true" /><span>{text(item.ko, item.en)}</span>
        </button>
      ))}
    </nav>
  );
}

/** 중메뉴 탭 하나에 대응하는 패널. 숨겨진 패널은 DOM에 남되 그려지지 않는다. */
export function SettingsSubTabPanel({ idPrefix, id, active, children }: PropsWithChildren<{ idPrefix: string; id: string; active: boolean }>) {
  return (
    <div id={panelElementId(idPrefix, id)} role="tabpanel" aria-labelledby={tabElementId(idPrefix, id)} hidden={!active}>
      {children}
    </div>
  );
}
