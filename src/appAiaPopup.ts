import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AiaAutoPrompt } from "./components/AiaChatPopup";
import { aiaRuntimeProvider, aiaRuntimeSettings, type AiaRuntimeSettings } from "./lib/aiaRuntime";
import type { PopoutRequest } from "./lib/popout";
import type { ProviderId, SystemAutomationSnapshot } from "./types";

/**
 * AIA 팝업의 수명(열림·마운트·바쁨)과 자동 요청 한 줄기를 한 자리에 모은다.
 *
 * 이 다섯 가지는 서로 맞물려 있는데도 App 본문에서는 상태 선언·콜백·마운트 효과가
 * 화면 조립 사이사이에 흩어져 있었다. 특히 "언제 팝업 번들을 마운트하는가"는
 * 열림·자동 요청·알림 세 갈래가 각자 `setAiaMounted(true)`를 부르는 모양이라, 한 갈래를
 * 고칠 때 나머지를 같이 보지 않으면 규칙이 갈라진다. 열림·자동 요청 두 갈래는 훅 안에서
 * 닫고, 바깥에서만 알 수 있는 알림 갈래는 `keepMounted` 한 손잡이로 받는다.
 */
export interface AiaPopupShell {
  aiaOpen: boolean;
  setAiaOpen: (next: boolean | ((current: boolean) => boolean)) => void;
  aiaMounted: boolean;
  /** 바깥 사정(미확인 알림 등)으로 팝업 번들을 미리 받아 둘 때 부른다. 되돌리지 않는다. */
  keepMounted: () => void;
  aiaBusy: boolean;
  setAiaBusy: (next: boolean) => void;
  aiaTriggerRef: RefObject<HTMLButtonElement | null>;
  aiaAutoPrompt: AiaAutoPrompt | null;
  openAia: () => void;
  requestAiaPrompt: (text: string) => void;
  handleAiaAutoPrompt: (prompt: AiaAutoPrompt) => void;
}

export function useAiaPopupShell({ popoutRequest, automationRef }: {
  popoutRequest: PopoutRequest | null;
  automationRef: RefObject<SystemAutomationSnapshot | null>;
}): AiaPopupShell {
  const aiaPopout = popoutRequest?.kind === "aia";
  const [aiaOpen, setAiaOpen] = useState(aiaPopout);
  const [aiaMounted, setAiaMounted] = useState(aiaPopout);
  // 팝업을 닫아 둔 채 자동 요청이 돌 때도 상단바에서 진행 상황이 보여야 한다.
  const [aiaBusy, setAiaBusy] = useState(false);
  const aiaTriggerRef = useRef<HTMLButtonElement>(null);
  const [aiaAutoPrompt, setAiaAutoPrompt] = useState<AiaAutoPrompt | null>(null);
  const aiaAutoPromptSeq = useRef(0);

  const openAia = useCallback(() => setAiaOpen(true), []);
  const keepMounted = useCallback(() => setAiaMounted(true), []);

  // AIA 팝업을 열고 요청 메시지를 자동 전송한다 (실행설정 스키마 디스커버리 등).
  // 시스템 에이전트를 고르지 않아 AIA가 꺼져 있으면 전달할 런타임이 없으므로 무시한다.
  const requestAiaPrompt = useCallback((text: string) => {
    if (!aiaRuntimeProvider(automationRef.current)) return;
    aiaAutoPromptSeq.current += 1;
    setAiaAutoPrompt({ text, requestId: aiaAutoPromptSeq.current });
    setAiaOpen(true);
  }, [automationRef]);

  // 팝업이 처리했다고 알려 온 요청만 지운다. 그 사이 새 요청이 들어왔다면 그대로 둔다.
  const handleAiaAutoPrompt = useCallback((prompt: AiaAutoPrompt) => {
    setAiaAutoPrompt((current) => current?.requestId === prompt.requestId ? null : current);
  }, []);

  // AIA의 세션 상태는 첫 사용 뒤 계속 보존하되, 사용 전에는 큰 채팅 번들을 내려받지 않는다.
  useEffect(() => {
    if (aiaOpen || aiaAutoPrompt) setAiaMounted(true);
  }, [aiaAutoPrompt, aiaOpen]);

  return {
    aiaOpen,
    setAiaOpen,
    aiaMounted,
    keepMounted,
    aiaBusy,
    setAiaBusy,
    aiaTriggerRef,
    aiaAutoPrompt,
    openAia,
    requestAiaPrompt,
    handleAiaAutoPrompt,
  };
}

/**
 * AIA가 어느 시스템 에이전트로 도는지와 그 실행설정.
 *
 * 자동화 스냅샷은 폴링마다 새 객체로 오므로 저장된 값이 실제로 달라질 때만 새 실행설정을
 * 만든다. AIA 팝업은 이 값이 바뀌는 것을 보고 돌던 대화를 새 설정으로 다시 시작하므로,
 * 여기서 서명 비교를 빼면 팝업이 폴링마다 대화를 버린다.
 */
export function useAiaRuntime(automation: SystemAutomationSnapshot | null): {
  aiaProviderId: ProviderId | null;
  aiaRuntime: AiaRuntimeSettings;
} {
  // AIA는 시스템 설정에서 고른 시스템 에이전트로 실행된다. 고르지 않으면 AIA 기능
  // 전체(트리거·팝업·자동 요청·알림)가 꺼진다. 선택값은 백엔드에 영속되므로 새로고침
  // 뒤에도 자동화 스냅샷 폴링으로 그대로 복원된다.
  const aiaProviderId = aiaRuntimeProvider(automation);
  const aiaRuntimeSignature = JSON.stringify(automation?.settings.systemAgentRuntimes ?? null);
  const aiaRuntime = useMemo(
    // 공급자를 고르지 않으면 AIA 팝업 자체를 그리지 않으므로, 자리만 채우는 기본값이다.
    () => aiaRuntimeSettings(automation?.settings.systemAgentRuntimes, aiaProviderId ?? "codex"),
    [aiaProviderId, aiaRuntimeSignature],
  );
  return { aiaProviderId, aiaRuntime };
}
