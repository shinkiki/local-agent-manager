import { useI18n } from "../lib/i18n";
import type { FormEvent, HTMLAttributes, ReactNode } from "react";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { AccountSnapshot, ChatProviderOptions, ChatReasoningOption, ModelOption, ProjectOption, ProviderId, ProviderStatus } from "../types";
import { displayPath } from "../lib/displayPath";
import { accountName, type LaunchAccountChoice } from "../lib/launchAccount";
import { submitComposerOnEnter } from "../lib/composerKeys";
import { EmptyState, ErrorBanner, FileDropOverlay, SourceBadge } from "./Shared";
import { defaultEffortFor, runtimeExtraSettingFields, RuntimeExtraSettings, RuntimeSettings } from "./RuntimeSettings";
import { readHiddenCliConnectionCards, writeHiddenCliConnectionCards } from "./ChatLocalSettings";
import { attachPastedFiles } from "./ChatComposer";
import { AttachmentPicker, type ChatAttachmentDraft } from "./ChatAttachments";
import type { ChatRuntimeDraft } from "./ChatRuntimeDraft";

/**
 * 새 채팅 시작 화면. 시작 폼에서만 읽히는 상태를 쥔 훅 둘과, 그 둘을 끼워 그리는
 * 폼 본체가 여기 있다. 채팅 화면 본체에 두면 대화 중에는 쓰이지 않는 상태와 깊게
 * 접힌 JSX가 1500줄짜리 컴포넌트에 섞인다.
 *
 * 훅의 상태는 훅으로 남겨 채팅 화면에서 부른다. 그려지는 자리(세션이 없고 대화 탭일
 * 때)에 상태까지 내려보내면 대화를 시작했다 멈추는 동안 상태가 풀려, 그냥 닫아 둔 카드와
 * 펼쳐 둔 고급 옵션이 되살아난다. 옮기는 것은 화면이지 수명이 아니다 — 그래서 폼 본체는
 * 제 상태를 하나도 갖지 않고 값과 손잡이만 받는다.
 */

/**
 * CLI가 연결되지 않은 공급자의 연결 안내 카드.
 *
 * QA #68. 화면에서 감춘 목록과 영구히 기억할 목록은 다르다. 예전에는 기억을 켠 카드
 * 하나를 닫을 때 이번 세션에서 그냥 닫아 둔 카드까지 들어 있는 화면 목록을 통째로
 * 저장해, '다시 표시 안 함'을 켠 적 없는 카드가 영구히 사라졌다. 저장할 때는 저장본을
 * 다시 읽어 이 공급자 하나만 더한다.
 */
export function useCliConnectionCards(unavailable: ProviderStatus[], onConnectCli: (provider: ProviderStatus) => void) {
  const [hidden, setHidden] = useState<ProviderId[]>(readHiddenCliConnectionCards);
  const [remember, setRemember] = useState<ProviderId[]>([]);
  const visible = useMemo(
    () => unavailable.filter((provider) => !hidden.includes(provider.provider)),
    [hidden, unavailable],
  );
  const close = (provider: ProviderId) => {
    if (remember.includes(provider)) {
      const remembered = readHiddenCliConnectionCards();
      if (!remembered.includes(provider)) writeHiddenCliConnectionCards([...remembered, provider]);
    }
    setHidden((current) => (current.includes(provider) ? current : [...current, provider]));
  };
  const cliConnectionCards = visible.length === 0 ? null : (
    <div className="chat-cli-connections" aria-label="CLI 연결 필요">
      {visible.map((provider) => <div className="chat-cli-connection-card" key={provider.provider}>
        <button className="chat-cli-connection-main" type="button" onClick={() => onConnectCli(provider)}>
          <SourceBadge source={provider.provider} />
          <span><strong>{provider.displayName}</strong><small>{provider.history.detected ? "채팅은 탐지됨 · CLI 연결 필요" : "CLI 연결 필요"}</small></span>
          <em>연결</em>
        </button>
        <div className="chat-cli-connection-dismiss">
          <label>
            <input
              type="checkbox"
              checked={remember.includes(provider.provider)}
              onChange={(event) => setRemember((current) => event.target.checked
                ? [...current, provider.provider]
                : current.filter((item) => item !== provider.provider))}
            />
            <span>다시 표시 안 함</span>
          </label>
          <button className="chat-cli-connection-close" type="button" aria-label={`${provider.displayName} 연결 카드 닫기`} title="닫기" onClick={() => close(provider.provider)}><X size={14} /></button>
        </div>
      </div>)}
    </div>
  );
  return { cliConnectionCards };
}

/**
 * 시작 폼의 접이식 고급 옵션. 공급자 스키마가 주는 추가 실행 설정만 담는다.
 * 고를 항목이 하나도 없는 공급자에서는 빈 상자만 남으므로 아무것도 그리지 않는다.
 */
export function useLaunchAdvancedSettings({ source, catalog, recent, extraSettings, onExtraSettingChange }: {
  source: ProviderId;
  catalog: ChatProviderOptions | null;
  recent: ModelOption[];
  extraSettings: Record<string, string>;
  onExtraSettingChange: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const fields = useMemo(() => runtimeExtraSettingFields(catalog, source), [catalog, source]);
  // 접어 둔 고급 옵션에 기본값이 아닌 선택이 남아 있으면 펼치지 않아도 보이게 요약한다.
  const summary = fields
    .map((field) => extraSettings[field.key]?.trim() ? `${field.label} ${extraSettings[field.key]}` : null)
    .filter(Boolean).join(" · ") || `${fields.map((field) => field.label).join(" · ")} 기본값`;
  const launchAdvancedSettings = fields.length === 0 ? null : (
    <section className="chat-launch-advanced">
      <button className="chat-launch-advanced-toggle" type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}고급 옵션<small>{summary}</small>
      </button>
      {open && <div className="chat-launch-advanced-body">
        <RuntimeExtraSettings source={source} catalog={catalog} recent={recent} extraSettings={extraSettings} onExtraSettingChange={onExtraSettingChange} />
      </div>}
    </section>
  );
  return { launchAdvancedSettings };
}

/** 작업 경로 선택 목록에서 "직접 입력"을 고른 항목. 실제 경로와 겹치지 않는 값이면 된다. */
const MANUAL_CWD = "__manual_cwd__";
/** 작업 경로를 비우는 선택. 빈 경로는 백엔드가 앱의 기본 작업공간으로 해석한다. */
const NO_CWD = "";

/**
 * 새 채팅 시작 폼.
 *
 * 값은 전부 위에서 내려온다 — 실행설정 묶음은 `useChatRuntimeDraft`가, 첫 메시지·첨부는
 * 채팅 화면이 쥐고 있다. 여기서 정하는 것은 그 값들을 어떻게 늘어놓느냐뿐이라, 폼이
 * 마운트를 여닫아도 사용자가 고르던 것은 하나도 풀리지 않는다.
 */
export function ChatLaunchForm({
  draft, available, accounts, projects, accountChoices, activeAccountId, catalog, recentModels, reasoningOptions,
  cliConnectionCards, advancedSettings, prompt, onPromptChange, attachments, onAddFiles, onRemoveAttachment,
  starting, error, notice, dropOver, dropProps, onSubmit,
}: {
  draft: ChatRuntimeDraft;
  available: ProviderStatus[];
  accounts: AccountSnapshot | null;
  projects: ProjectOption[];
  accountChoices: LaunchAccountChoice[];
  activeAccountId: string | null;
  catalog: ChatProviderOptions | null;
  recentModels: ModelOption[];
  reasoningOptions: ChatReasoningOption[];
  cliConnectionCards: ReactNode;
  advancedSettings: ReactNode;
  prompt: string;
  onPromptChange: (value: string) => void;
  attachments: ChatAttachmentDraft[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (draft: ChatAttachmentDraft) => void;
  starting: boolean;
  error: string | null;
  notice: string | null;
  dropOver: boolean;
  dropProps: HTMLAttributes<HTMLFormElement>;
  onSubmit: (event: FormEvent) => void;
}) {
  const { text } = useI18n();
  const { source, switchSource, cwd, setCwd, manualCwd, setManualCwd, launchAccountId, setLaunchAccountId } = draft;
  const selectedProject = projects.find((project) => project.path === cwd) ?? null;
  // 빈 경로는 "작업 경로 없음" 선택이지 직접 입력이 아니다. 직접 입력은 사용자가 고른 때만.
  const usingManualCwd = manualCwd || (cwd !== NO_CWD && !selectedProject);
  return (
    <section className="chat-launch-layout chat-launch-workspace">
      <article className="chat-launch-card">
      <div className="section-heading"><div><h2>새 CLI 채팅</h2><p>설치된 공급자 CLI를 구조화 채팅으로 시작합니다.</p></div></div>
      {cliConnectionCards}
      {available.length === 0 ? <EmptyState title="연결 가능한 CLI가 없습니다" detail="위 공급자를 선택하면 설치·로그인용 터미널 가이드가 열립니다." /> : (
        <form className="chat-launch-form chat-drop-zone" onSubmit={onSubmit} {...dropProps}>
          {dropOver && <FileDropOverlay />}
          <label><span>공급자</span><select value={source} onChange={(event) => switchSource(event.target.value as ProviderId)}>{available.map((provider) => <option key={provider.provider} value={provider.provider}>{provider.displayName}</option>)}</select></label>
          <label>
            <span>작업 경로</span>
            {projects.length > 0 && <select value={usingManualCwd ? MANUAL_CWD : cwd} onChange={(event) => { const value = event.target.value; setManualCwd(value === MANUAL_CWD); if (value !== MANUAL_CWD) setCwd(value); }}>{projects.map((project) => <option value={project.path} key={project.path}>{displayPath(project.name)} · {displayPath(project.path)}</option>)}<option value={NO_CWD}>{text("작업 경로 없음", "No working path")}</option><option value={MANUAL_CWD}>직접 입력…</option></select>}
            {usingManualCwd ? <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder={text("/absolute/project/path (비우면 작업 경로 없음)", "/absolute/project/path (leave empty for no working path)")} autoFocus={manualCwd} /> : <small className="chat-path-hint">{selectedProject ? `${displayPath(selectedProject.path)} · 세션 ${selectedProject.count}개` : text("프로젝트 없이 앱의 기본 작업공간에서 시작합니다", "Starts in the app's default workspace with no project")}</small>}
          </label>
          {/* 실행 계정은 CLI 프로세스가 뜰 때 고정되어 시작 뒤에는 바꿀 수 없으므로 접지 않고 본문에 둔다.
              접이식 고급 옵션에는 시작 뒤에도 실행 설정 메뉴에서 바꿀 수 있는 추가 스키마 항목만 남긴다. */}
          {accountChoices.length > 0 && <label>
            <span>실행 계정</span>
            <select value={launchAccountId} onChange={(event) => setLaunchAccountId(event.target.value)}>
              <option value="">활성 계정{activeAccountId ? ` · ${accountName(accounts, source, activeAccountId)}` : ""}</option>
              {accountChoices.map((choice) => <option value={choice.id} key={choice.id} disabled={choice.blocked} title={choice.blockedReason ?? undefined}>
                {choice.label}{choice.blocked ? " · 자격증명 격리 불가" : ""}
              </option>)}
            </select>
            {launchAccountId !== "" && <small className="chat-path-hint">이 채팅만 선택한 계정으로 실행합니다. 활성 계정은 그대로 둡니다.</small>}
          </label>}
          <RuntimeSettings
            source={source}
            mode={draft.mode}
            onModeChange={draft.setMode}
            approvalMode={draft.approvalMode}
            onApprovalModeChange={draft.setApprovalMode}
            model={draft.model}
            onModelChange={draft.setModel}
            localConnectionId={draft.localConnectionId}
            onLocalConnectionChange={draft.setLocalConnectionId}
            catalog={catalog}
            recent={recentModels}
            reasoningEffort={draft.reasoningEffort}
            onReasoningChange={draft.setReasoningEffort}
            reasoningOptions={reasoningOptions}
            defaultEffort={defaultEffortFor(catalog, draft.model)}
          />
          {/* 추가 스키마 항목(예비 모델 등)은 아래 고급 옵션의 RuntimeExtraSettings가 맡는다.
              여기에 onExtraSettingChange를 다시 넘기면 같은 항목이 두 번 그려진다. */}
          {advancedSettings}
          <div className="chat-initial-composer"><label><span>첫 메시지 <small>선택</small></span><textarea value={prompt} onChange={(event) => onPromptChange(event.target.value)} onKeyDown={submitComposerOnEnter} onPaste={attachPastedFiles(onAddFiles)} rows={1} placeholder="CLI 연결 직후 보낼 요청" /></label></div>
          {error && <ErrorBanner message={error} />}
          {notice && <ErrorBanner message={notice} />}
          <div className="chat-launch-footer"><AttachmentPicker drafts={attachments} disabled={starting} onAdd={onAddFiles} onRemove={onRemoveAttachment} /><button className="button primary chat-start-button" type="submit" disabled={starting}>{starting ? "CLI 연결 중…" : "새 채팅 시작"}</button></div>
        </form>
      )}
      </article>
    </section>
  );
}
