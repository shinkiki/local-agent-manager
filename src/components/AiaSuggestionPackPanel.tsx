import { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldAlert, Sparkles } from "lucide-react";
import {
  createCommonSkill,
  getAiaSuggestionCatalog,
  getCommonSkillDetail,
  setSystemAutomationSettings,
  updateCommonSkill,
} from "../lib/ipc";
import type { AiaSuggestionCatalog } from "../lib/aiaSuggestions";
import { aiaRuntimeProvider } from "../lib/aiaRuntime";
import { errorText } from "../lib/errorText";
import { useI18n } from "../lib/i18n";
import type { SystemAutomationSnapshot } from "../types";
import { AiaMark, AppToggle, ErrorBanner, HelpHint, LoadingState, useConfirm } from "./Shared";

export interface AiaSuggestionPackPanelProps {
  active: boolean;
  automation?: SystemAutomationSnapshot | null;
  onAutomationChange?: (snapshot: SystemAutomationSnapshot) => void;
  /** 팩을 공통 스킬로 복사하면 스킬 목록과 앱이 들고 있는 제안 카탈로그가 함께 바뀐다. */
  onSkillsChanged?: () => void;
}

/**
 * 설정 → AIA 설정의 선제 제안 화면. 스위치는 원래 이 탭에, 팩을 공통 스킬로 복사·복구하는
 * 카드는 스킬 → 스킬관리에 따로 서 있었고, 둘을 합치느라 애드온 → 자동화로 함께 옮겼다가
 * 다시 이 탭으로 돌아왔다 — 선제 제안은 AIA가 스스로 하는 일이라, AIA를 실행할 에이전트를
 * 고르는 자리 바로 아래가 제자리다. 스위치와 팩 관리·검증 문제 목록은 한자리에 남아, 제안이
 * 뜨지 않을 때 "꺼 둔 것인지 팩이 깨진 것인지"가 한 화면에서 갈린다.
 *
 * 카탈로그는 화면을 실제로 연 뒤에만 읽는다 — 보지 않는 화면에서 제안 팩 검증까지 도는 일을
 * 막는다.
 */
export function AiaSuggestionPackPanel({ active, automation = null, onAutomationChange, onSkillsChanged }: AiaSuggestionPackPanelProps) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [catalog, setCatalog] = useState<AiaSuggestionCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 이 화면이 하는 쓰기는 팩 적용과 스위치 저장 둘뿐이라 각각 제 상태만 들고 있다.
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setCatalog(await getAiaSuggestionCatalog());
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  // 실행설정을 함께 편집할 수 있는 시스템 에이전트. 고르지 않았으면 AIA 자체가 꺼져 있어
  // 제안 스위치도 바꿀 것이 없다.
  const systemProvider = aiaRuntimeProvider(automation);

  const saveSuggestionsEnabled = async (next: boolean) => {
    if (!automation || saving) return;
    setSaving(true);
    setError(null);
    try {
      onAutomationChange?.(await setSystemAutomationSettings({ ...automation.settings, aiaSuggestions: next }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const bundledKey = catalog?.bundledSkill.key ?? null;
  const bundledIssues = useMemo(
    () => (catalog?.issues ?? []).filter((issue) => issue.skillKey === bundledKey),
    [catalog, bundledKey],
  );

  const installBundledSuggestionSkill = async () => {
    if (!catalog || applying) return;
    const template = catalog.bundledSkill;
    const repairing = template.installed;
    const accepted = await confirm({
      title: repairing
        ? text("AIA 제안 팩 복구", "Restore the AIA suggestion pack")
        : text("AIA 제안 팩 복사", "Copy the AIA suggestion pack"),
      message: repairing
        ? text(
          "현재 공통 스킬의 내용을 앱 기본 제안 팩으로 덮어씁니다. 계속할까요?",
          "This overwrites the current common skill with the app's default suggestion pack. Continue?",
        )
        : text(
          "앱 기본 제안 팩을 사용자가 편집할 수 있는 공통 스킬로 복사할까요?",
          "Copy the app's default suggestion pack into an editable common skill?",
        ),
      confirmLabel: repairing
        ? text("기본값으로 복구", "Restore defaults")
        : text("공통 스킬로 복사", "Copy to common skills"),
      tone: repairing ? "danger" : "default",
    });
    if (!accepted) return;
    setApplying(true);
    setError(null);
    try {
      // 복구는 이미 있는 공통 원본을 덮어쓰는 것이라 낙관적 잠금에 쓸 지문을 그 자리에서
      // 다시 읽는다. 목록을 들고 있던 예전 자리와 달리 여기서는 지문이 오래된 채 남지 않는다.
      const source = repairing
        ? (await getCommonSkillDetail(template.key)).source
        : await createCommonSkill({
          key: template.key,
          name: template.name,
          description: template.description,
        });
      await updateCommonSkill({
        key: template.key,
        files: template.files,
        deletes: [],
        expectedDigest: source.contentDigest,
      });
      setNotice(repairing
        ? text("AIA 제안 팩을 앱 기본값으로 복구했습니다.", "Restored the AIA suggestion pack to the app defaults.")
        : text("AIA 제안 팩을 공통 스킬로 복사했습니다.", "Copied the AIA suggestion pack into a common skill."));
      onSkillsChanged?.();
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="settings-card aia-suggestion-pack-panel" data-ui-anchor="settings.aia-suggestions">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><AiaMark size={18} /></i>
          <div>
            <span>{text("자동화", "Automation")}</span>
            <h2>{text("AIA 선제 제안", "AIA proactive suggestions")}</h2>
          </div>
        </div>
        <p>{text(
          "앱 상태를 보고 AIA가 먼저 띄우는 제안 카드와 트리거 말풍선입니다. 제안 문구와 명령 초안, 임계값은 여기서 관리하는 제안 팩에서 옵니다.",
          "Cards and trigger bubbles AIA raises on its own from the app state. Their wording, draft commands, and thresholds come from the suggestion pack managed here.",
        )}</p>
      </header>

      <div className="aia-suggestion-pack-body">
        {error && <ErrorBanner message={error} />}
        {notice && <div className="addon-inline-notice" role="status">{notice}</div>}

        <div className="system-setting-group">
          <div className="system-setting-label"><Sparkles size={17} /><span>
            <strong>{text("AIA 선제 제안 팩", "AIA suggestion pack")}<HelpHint
              label={text("AIA 선제 제안 팩 설명", "About the AIA suggestion pack")}
              title={text("AIA 선제 제안 팩", "AIA suggestion pack")}
            >{text("제안 문구와 명령 초안, 임계값은 공통 스킬의 제안 팩에서 옵니다. 끄면 제안만 멈추고 설치한 팩과 아래 관리 카드는 그대로 남습니다.", "Suggestion text, command drafts and thresholds come from the suggestion pack in common skills. Turning it off only stops the suggestions — the installed pack and the card below stay.")}</HelpHint></strong>
            <small>{text("끄면 제안 카드와 트리거 말풍선이 바로 사라집니다.", "Turning it off removes the suggestion cards and trigger bubbles immediately.")}</small>
          </span></div>
          {automation && systemProvider ? (
            <AppToggle
              checked={automation.settings.aiaSuggestions !== false}
              disabled={saving}
              label={text("AIA 선제 제안 팩", "AIA suggestion pack")}
              onChange={(next) => void saveSuggestionsEnabled(next)}
            />
          ) : (
            <small className="aia-suggestion-pack-hint">{text(
              "위에서 시스템 에이전트를 골라야 켤 수 있습니다.",
              "Choose a system agent above to turn this on.",
            )}</small>
          )}
        </div>

        {loading && !catalog
          ? <LoadingState label={text("제안 팩을 읽고 있습니다", "Reading the suggestion pack")} />
          : catalog && <section className="detail-card aia-suggestion-pack-card">
            <div>
              <div className="section-title">
                <h3><Sparkles size={15} aria-hidden="true" /> {text("AIA 선제 제안 팩", "AIA proactive suggestion pack")}</h3>
                <span>{text(`${catalog.definitions.length}개 제안`, `${catalog.definitions.length} suggestions`)}</span>
              </div>
              <p>{text(
                "제안 문구, 명령 초안, 임계값과 재알림 조건을 공통 스킬에서 안전하게 관리합니다.",
                "Manage suggestion wording, draft commands, thresholds, and re-notify rules safely in a common skill.",
              )}</p>
              <small><code>{catalog.bundledSkill.key}</code> · {text(
                "임의 코드나 도구 호출은 지원하지 않습니다.",
                "Arbitrary code and tool calls are not supported.",
              )}</small>
            </div>
            <button
              className="button compact"
              type="button"
              disabled={applying || (catalog.bundledSkill.installed && bundledIssues.length === 0)}
              onClick={() => { void installBundledSuggestionSkill(); }}
            >
              <Sparkles size={13} aria-hidden="true" />
              {applying
                ? text("적용 중…", "Applying…")
                : catalog.bundledSkill.installed
                  ? bundledIssues.length > 0
                    ? text("기본 팩으로 복구", "Restore the default pack")
                    : text("공통 스킬에 설치됨", "Installed as a common skill")
                  : text("공통 스킬로 복사", "Copy to common skills")}
            </button>
            {catalog.issues.length > 0 && <ul className="aia-suggestion-pack-issues">
              {catalog.issues.map((issue, index) => <li key={`${issue.skillKey}-${index}`}>
                <ShieldAlert size={12} aria-hidden="true" />
                <code>{issue.skillKey}</code>
                <span>{issue.message}</span>
                {issue.usingLastKnownGood && <small>{text("마지막 정상 팩 사용 중", "Using the last known good pack")}</small>}
              </li>)}
            </ul>}
          </section>}
      </div>

      {confirmDialog}
    </section>
  );
}
