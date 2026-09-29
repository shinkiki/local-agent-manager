import { useCallback, useState } from "react";
import { defaultApprovalMode } from "../lib/chatSettings";
import { readChatLaunchSettings } from "./ChatLocalSettings";
import type { ChatApprovalMode, ChatMode, ChatSessionInfo, ProviderId, ReasoningEffort } from "../types";

/**
 * 채팅 화면이 "어떤 실행을 띄울 것인가"로 들고 있는 값 한 묶음. 공급자·계정·작업 폴더와
 * 실행설정 다섯 칸은 각자 useState로 흩어져 있었고, 그 묶음을 통째로 갈아 끼우는 자리가
 * ChatView 본문 세 군데(공급자 전환, 세션 정보 반영, 설정 변경 되돌리기)에 같은 모양으로
 * 펼쳐져 있었다. 어느 한 곳에서 칸 하나를 빠뜨려도 화면은 조용히 어긋난 값으로 요청을
 * 보내므로, 묶음과 그 갈아 끼우기를 여기 한자리에 둔다.
 *
 * 훅은 값을 보관하고 함께 옮기는 일만 한다 — 어떤 값을 골라야 하는지(스키마 정규화, 계정
 * 선택지 정리, 저장소에 되쓰기)는 그대로 호출부의 판단이라 setter를 그대로 내보낸다.
 */

/** 실행 중인 채팅이 들고 있는 실행설정 다섯 칸. 한 벌로 세우고 한 벌로 되돌린다. */
export interface ChatRuntimeSettings {
  mode: ChatMode;
  approvalMode: ChatApprovalMode;
  model: string;
  /** 로컬 공급자의 서빙 연결 id(M7). 빈 값은 기본 연결. */
  localConnectionId?: string;
  reasoningEffort: ReasoningEffort | "";
  extraSettings: Record<string, string>;
}

export function useChatRuntimeDraft(initialSource: ProviderId, initialCwd: string) {
  const [source, setSource] = useState<ProviderId>(initialSource);
  // 빈 값은 "실행 시점 활성 계정"이라는 기본 선택이다. 특정 계정을 고르면 그 계정으로만 실행한다.
  const [launchAccountId, setLaunchAccountId] = useState("");
  const [cwd, setCwd] = useState(initialCwd);
  const [manualCwd, setManualCwd] = useState(false);
  const [model, setModel] = useState(() => readChatLaunchSettings(initialSource).model);
  const [localConnectionId, setLocalConnectionId] = useState(() => readChatLaunchSettings(initialSource).localConnectionId ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">(() => readChatLaunchSettings(initialSource).reasoningEffort);
  const [mode, setMode] = useState<ChatMode>("workspace");
  const [approvalMode, setApprovalMode] = useState<ChatApprovalMode>(defaultApprovalMode(initialSource));
  const [extraSettings, setExtraSettings] = useState<Record<string, string>>({});

  /** 실행설정 다섯 칸을 한 벌로 세운다. 되돌리기도 이 한 벌을 그대로 되먹여 한다. */
  const applySettings = useCallback((settings: ChatRuntimeSettings) => {
    setMode(settings.mode);
    setApprovalMode(settings.approvalMode);
    setModel(settings.model);
    setLocalConnectionId(settings.localConnectionId ?? "");
    setReasoningEffort(settings.reasoningEffort);
    setExtraSettings(settings.extraSettings);
  }, []);

  /** 새 채팅 칸을 다른 공급자 몫으로 바꾼다. 저장해 둔 모델·추론 강도는 공급자마다 따로다. */
  const switchSource = useCallback((nextSource: ProviderId) => {
    setSource(nextSource);
    // 계정은 공급자에 묶여 있으므로 공급자를 바꾸면 기본값(활성 계정)으로 되돌린다.
    setLaunchAccountId("");
    const stored = readChatLaunchSettings(nextSource);
    setApprovalMode(defaultApprovalMode(nextSource));
    setExtraSettings({});
    setModel(stored.model);
    setLocalConnectionId(stored.localConnectionId ?? "");
    setReasoningEffort(stored.reasoningEffort);
  }, []);

  /** 붙은 세션이 보고한 값으로 묶음을 맞춘다. 작업 폴더와 공급자까지 그 세션 것을 따른다. */
  const adoptSessionSettings = useCallback((info: ChatSessionInfo) => {
    setSource(info.source);
    setCwd(info.cwd);
    applySettings({
      mode: info.mode,
      approvalMode: info.approvalMode,
      model: info.model ?? "",
      localConnectionId: info.localConnectionId ?? "",
      reasoningEffort: info.reasoningEffort ?? "",
      extraSettings: info.settings ?? {},
    });
  }, [applySettings]);

  return {
    source,
    launchAccountId,
    setLaunchAccountId,
    cwd,
    setCwd,
    manualCwd,
    setManualCwd,
    model,
    setModel,
    localConnectionId,
    setLocalConnectionId,
    reasoningEffort,
    setReasoningEffort,
    mode,
    setMode,
    approvalMode,
    setApprovalMode,
    extraSettings,
    setExtraSettings,
    applySettings,
    switchSource,
    adoptSessionSettings,
  };
}

/** 묶음을 통째로 넘겨받는 화면(시작 폼)이 칸마다 prop을 늘어놓지 않도록 이름을 붙여 둔다. */
export type ChatRuntimeDraft = ReturnType<typeof useChatRuntimeDraft>;
