import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { getProviderTelemetry, getWebAccessStatus, setProviderTelemetryOption, type WebAccessStatus } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { displayPath } from "../lib/displayPath";
import { errorText } from "../lib/errorText";
import type { ProviderTelemetryFile, ProviderTelemetrySnapshot, TelemetryOptionState } from "../types";
import { AppToggle, ErrorBanner, HelpHint, useBusyAction } from "./Shared";

/**
 * 공급자 CLI가 자기 서버로 보내는 사용정보 수집 스위치(C13).
 *
 * 토글은 전부 **"보내지 않음"** 한 방향으로 읽는다. 켜면 수집을 막고, 끄면 그 키를 지워
 * 공급자 기본값으로 되돌린다. 파일에 실제로 적히는 값은 공급자마다 극성이 반대라
 * (Claude는 `DISABLE_*=1`, Gemini는 `usageStatisticsEnabled=false`) 화면이 그 차이를
 * 사용자에게 떠넘기지 않는다.
 *
 * 모델 학습 동의와는 다른 축이다. 학습 동의는 공급자 계정·조직 정책이 정하고 CLI 설정
 * 파일에 자리가 없어 이 화면에서 보이지도 바뀌지도 않는다 — 카드 머리말에 그렇게 적는다.
 */
export function TelemetrySettingsCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const [snapshot, setSnapshot] = useState<ProviderTelemetrySnapshot | null>(null);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const { busy, error, setError, run } = useBusyAction();
  const loadedRef = useRef(false);
  const canWrite = access?.writable === true;

  useEffect(() => {
    if (!active) { loadedRef.current = false; return; }
    if (loadedRef.current) return;
    loadedRef.current = true;
    void (async () => {
      try {
        const [states, writable] = await Promise.all([getProviderTelemetry(), getWebAccessStatus()]);
        setSnapshot(states);
        setAccess(writable);
        setError(null);
      } catch (cause) {
        setError(errorText(cause));
      }
    })();
  }, [active]);

  const toggle = async (option: TelemetryOptionState, blocked: boolean) => {
    if (busy) return;
    await run(option.key, async () => {
      setSnapshot(await setProviderTelemetryOption({ key: option.key, blocked }));
    });
  };

  return (
    <section className="settings-subsection telemetry-settings-section" id="cli-telemetry" data-ui-anchor="settings.telemetry">
      <header>
        <div>
          <strong>
            {text("사용정보 수집", "Usage data collection")}
            <HelpHint
              label={text("모델 학습 동의와의 차이 설명", "How this differs from model training consent")}
              title={text("모델 학습 동의와는 다릅니다", "This is not model training consent")}
            >{text(
              "여기서 끄는 것은 각 CLI가 설정 파일에 적어 두는 사용통계·오류보고 전송 스위치입니다. 대화 내용을 모델 학습에 쓰는지는 공급자 계정과 조직 정책이 정하며 CLI 설정 파일에 자리가 없어 Agent Manager가 읽지도 바꾸지도 못합니다.",
              "These switches are the usage-statistics and error-reporting toggles each CLI stores in its own settings file. Whether your conversations train a model is decided by the provider account and organization policy, which has no entry in the CLI settings file and is neither read nor changed by Agent Manager.",
            )}</HelpHint>
          </strong>
          <small>{text(
            "각 CLI가 자기 공급자로 보내는 사용통계·오류보고를 끕니다. 실행 중인 세션이 아니라 다음에 시작하는 세션부터 반영됩니다.",
            "Stops each CLI from sending usage statistics and error reports to its own provider. Applies to newly started sessions, not ones already running.",
          )}</small>
        </div>
      </header>
      <div className="telemetry-settings-body">
        {error && <ErrorBanner message={error} />}
        {!snapshot && !error && <p className="telemetry-settings-loading">{text("불러오는 중입니다.", "Loading.")}</p>}
        {snapshot?.files.map((file) => (
          <TelemetryProviderBlock
            key={file.provider}
            file={file}
            busy={busy}
            canWrite={canWrite}
            onToggle={toggle}
          />
        ))}
        {snapshot && <p className="telemetry-settings-absent">{text(
          "Antigravity CLI에는 끄고 켤 수 있는 수집 설정이 없습니다.",
          "The Antigravity CLI exposes no collection setting to turn on or off.",
        )}</p>}
      </div>
    </section>
  );
}

/** 공급자 하나의 설정 파일과 그 안 항목들. */
function TelemetryProviderBlock({ file, busy, canWrite, onToggle }: {
  file: ProviderTelemetryFile;
  busy: string | null;
  canWrite: boolean;
  onToggle: (option: TelemetryOptionState, blocked: boolean) => void;
}) {
  const { text } = useI18n();
  const copy = providerCopy(file.provider, text);
  if (!copy) return null;
  return (
    <article className="telemetry-provider" data-provider={file.provider}>
      <div className="telemetry-provider-head">
        <ShieldCheck size={15} aria-hidden="true" />
        <span className="telemetry-provider-copy">
          <strong>{copy.name}</strong>
          <small>{file.exists
            ? displayPath(file.path)
            : `${displayPath(file.path)} · ${text("아직 없음", "not created yet")}`}</small>
        </span>
      </div>
      {file.parseError && <p className="telemetry-provider-blocked" role="status">{text(
        "설정 파일을 안전하게 읽지 못해 이 공급자의 항목은 바꿀 수 없습니다",
        "This provider is read-only because its settings file could not be read safely",
      )}: {file.parseError}</p>}
      <ul className="telemetry-option-list">
        {file.options.map((option) => (
          <TelemetryOptionRow
            key={option.key}
            option={option}
            busy={busy === option.key}
            canWrite={canWrite}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </article>
  );
}

function TelemetryOptionRow({ option, busy, canWrite, onToggle }: {
  option: TelemetryOptionState;
  busy: boolean;
  canWrite: boolean;
  onToggle: (option: TelemetryOptionState, blocked: boolean) => void;
}) {
  const { text } = useI18n();
  const copy = optionCopy(option.key, text);
  if (!copy) return null;
  // 값이 없으면 공급자 기본값을 따르므로 "막지 않음"과 같은 자리에 선다. 다만 파일에 우리
  // 값이 적혀 있는지와는 다르므로 상태 문구로 구분해 알린다.
  const checked = option.blocked === true;
  const disabled = !canWrite || !option.editable || busy;
  return (
    <li className={`telemetry-option${option.editable ? "" : " locked"}`}>
      <span className="telemetry-option-copy">
        <strong>{copy.name}</strong>
        <small>{copy.detail}</small>
        <code>{copy.wrote}</code>
      </span>
      <span className="telemetry-option-state">
        <em>{option.blocked === null
          ? text("미설정 · 공급자 기본값", "Unset · provider default")
          : option.blocked
            ? text("보내지 않음", "Not sending")
            : text("보냄", "Sending")}</em>
        <AppToggle
          checked={checked}
          disabled={disabled}
          label={copy.toggleLabel}
          onChange={(next) => onToggle(option, next)}
        />
      </span>
      {option.note && <small className="telemetry-option-note">{option.note}{option.current ? ` (${option.current})` : ""}</small>}
    </li>
  );
}

/** 공급자 이름. Gemini는 Agent Manager가 실행을 관리하는 공급자가 아니라는 점을 적는다. */
function providerCopy(provider: string, text: (ko: string, en: string) => string): { name: string } | null {
  switch (provider) {
    case "claude":
      return { name: "Claude Code" };
    case "codex":
      return { name: "Codex" };
    case "gemini":
      return {
        name: text(
          "Gemini CLI (Agent Manager 관리 공급자 아님)",
          "Gemini CLI (not an Agent Manager-managed provider)",
        ),
      };
    default:
      return null;
  }
}

/**
 * 항목별 이름과, 켰을 때 설정 파일에 실제로 적히는 값. 사용자가 파일을 직접 열어 확인할 수
 * 있어야 하므로 화면에서 그 값을 감추지 않는다.
 */
function optionCopy(key: string, text: (ko: string, en: string) => string): {
  name: string;
  detail: string;
  wrote: string;
  toggleLabel: string;
} | null {
  switch (key) {
    case "claude.telemetry":
      return {
        name: text("사용통계", "Usage statistics"),
        detail: text(
          "세션 시작·기능 사용·소요시간 같은 동작 지표를 보냅니다. 프롬프트 본문은 들어가지 않습니다.",
          "Sends behavioral metrics such as session starts, feature use, and durations. Prompt text is not included.",
        ),
        wrote: 'env.DISABLE_TELEMETRY = "1"',
        toggleLabel: text("사용통계 보내지 않기", "Stop sending usage statistics"),
      };
    case "claude.errorReporting":
      return {
        name: text("오류 보고", "Error reporting"),
        detail: text(
          "예외 스택트레이스를 보냅니다. 파일 경로가 섞일 수 있어 사용통계보다 노출 범위가 넓습니다.",
          "Sends exception stack traces, which can embed file paths and so reveal more than usage statistics.",
        ),
        wrote: 'env.DISABLE_ERROR_REPORTING = "1"',
        toggleLabel: text("오류 보고 보내지 않기", "Stop sending error reporting"),
      };
    case "claude.nonessentialTraffic":
      return {
        name: text("비필수 외부 통신 전체", "All non-essential traffic"),
        detail: text(
          "위 둘을 포함해 업데이트 확인·기능 플래그 수신까지 함께 막는 상위 스위치입니다.",
          "The parent switch: also stops update checks and feature-flag fetches on top of the two above.",
        ),
        wrote: 'env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"',
        toggleLabel: text("비필수 외부 통신 전체 보내지 않기", "Stop sending all non-essential traffic"),
      };
    case "codex.telemetry":
      return {
        name: text("사용통계 내보내기", "Usage statistics export"),
        detail: text(
          "OTEL 내보내기를 끕니다. OTLP 수집기를 직접 구성해 두었다면 그 설정을 건드리지 않도록 잠깁니다.",
          "Turns the OTEL exporter off. Locked when you have configured your own OTLP collector, so that setup is left alone.",
        ),
        wrote: '[otel] exporter = "none"',
        toggleLabel: text("사용통계 내보내기 보내지 않기", "Stop sending usage statistics export"),
      };
    case "codex.promptLogging":
      return {
        name: text("프롬프트 본문 기록", "Prompt text logging"),
        detail: text(
          "내보내는 이벤트에 프롬프트 본문을 실을지입니다. 내보내기를 껐다면 이미 나가지 않습니다.",
          "Whether exported events carry the prompt text. Nothing leaves once the exporter is off.",
        ),
        wrote: "[otel] log_user_prompt = false",
        toggleLabel: text("프롬프트 본문 기록 보내지 않기", "Stop sending prompt text logging"),
      };
    case "gemini.usageStatistics":
      return {
        name: text("사용통계", "Usage statistics"),
        detail: text(
          "Gemini CLI의 사용통계 수집입니다. 공급자 기본값은 켜짐입니다.",
          "Gemini CLI usage-statistics collection. The provider default is on.",
        ),
        wrote: "privacy.usageStatisticsEnabled = false",
        toggleLabel: text("사용통계 보내지 않기", "Stop sending usage statistics"),
      };
    case "gemini.telemetry":
      return {
        name: text("텔레메트리 전송", "Telemetry emission"),
        detail: text(
          "OTEL 텔레메트리 전송입니다. 따로 켠 적이 없으면 이미 꺼져 있습니다.",
          "OTEL telemetry emission, already off unless you turned it on.",
        ),
        wrote: "telemetry.enabled = false",
        toggleLabel: text("텔레메트리 전송 보내지 않기", "Stop sending telemetry emission"),
      };
    default:
      return null;
  }
}
