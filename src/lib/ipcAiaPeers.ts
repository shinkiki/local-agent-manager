/**
 * AIA 대화(피어) 기본도구 명령 묶음(C23). 갈라 둔 이유는 `ipcDbConnections.ts` 머리말에 적는다.
 */
import type {
  AiaPeerCheckReceipt,
  AiaPeerExchangeView,
  AiaPeerRef,
  AiaPeerSkillImportReceipt,
  AiaPeerSkillsView,
  AiaPeersSnapshot,
  AskAiaPeerRequest,
  ImportAiaPeerSkillRequest,
  SetAiaPeerAgentEnabledRequest,
  SetAiaPeerPolicyRequest,
  SetAiaPeerRequest,
} from "../types";
import { notifyBuiltinTools } from "./builtinToolsSignal";
import { call } from "./ipcTransport";

/** 인사 한 번. 닿지 않는 주소는 연결 시간 초과(10초)에서 끝난다. */
const PEER_CHECK_TIMEOUT_MS = 30_000;
/** 스킬 목록·묶음은 상대 기기가 읽어 보내므로 평소보다 길게 둔다. */
const PEER_SKILL_TIMEOUT_MS = 60_000;
/** 교환 회수 한 번이 백엔드에서 기다려 주는 상한(25초)에 왕복 여유를 더한 값. */
const EXCHANGE_WAIT_TIMEOUT_MS = 40_000;

/** 정책·이 기기·등록 피어. 자격증명은 어느 필드에도 없다. */
export function getAiaPeers(): Promise<AiaPeersSnapshot> {
  return call<AiaPeersSnapshot>("get_aia_peers");
}

/** 정책 일부 갱신. 비운 칸은 그대로 둔다. */
export function setAiaPeerPolicy(request: SetAiaPeerPolicyRequest): Promise<AiaPeersSnapshot> {
  return notifyBuiltinTools(call<AiaPeersSnapshot>("set_aia_peer_policy", { request }));
}

/** 피어 저장(등록·편집). 앱 데이터 안의 변경이다. */
export function setAiaPeer(request: SetAiaPeerRequest): Promise<AiaPeersSnapshot> {
  return notifyBuiltinTools(call<AiaPeersSnapshot>("set_aia_peer", { request }));
}

export function removeAiaPeer(request: AiaPeerRef): Promise<AiaPeersSnapshot> {
  return notifyBuiltinTools(call<AiaPeersSnapshot>("remove_aia_peer", { request }));
}

export function setAiaPeerAgentEnabled(request: SetAiaPeerAgentEnabledRequest): Promise<AiaPeersSnapshot> {
  return notifyBuiltinTools(call<AiaPeersSnapshot>("set_aia_peer_agent_enabled", { request }));
}

/** 상대에 인사해 닿는지 본다. 상대에는 아무것도 남지 않는다. */
export function checkAiaPeer(request: AiaPeerRef): Promise<AiaPeerCheckReceipt> {
  return call<AiaPeerCheckReceipt>("check_aia_peer", { request }, { timeoutMs: PEER_CHECK_TIMEOUT_MS });
}

/** 질문을 보낸다. 즉시 running 교환이 돌아오고 답은 `getAiaPeerExchange`로 회수한다. */
export function askAiaPeer(request: AskAiaPeerRequest): Promise<AiaPeerExchangeView> {
  return call<AiaPeerExchangeView>("ask_aia_peer", { request });
}

/** 교환 하나. `waitMs` 동안 결과를 기다렸다가 돌려준다(최대 25초). */
export function getAiaPeerExchange(id: string, waitMs: number): Promise<AiaPeerExchangeView> {
  return call<AiaPeerExchangeView>("get_aia_peer_exchange", { id, waitMs }, { timeoutMs: EXCHANGE_WAIT_TIMEOUT_MS });
}

export function listAiaPeerExchanges(limit: number): Promise<AiaPeerExchangeView[]> {
  return call<AiaPeerExchangeView[]>("list_aia_peer_exchanges", { request: { limit } });
}

/** 상대 기기의 공통 스킬 목록에 내 사본 대비 상태를 붙여 받는다. 동기화는 하지 않는다. */
export function listAiaPeerSkills(peerId: string): Promise<AiaPeerSkillsView> {
  return call<AiaPeerSkillsView>("list_aia_peer_skills", { request: { peerId } }, { timeoutMs: PEER_SKILL_TIMEOUT_MS });
}

/** 상대의 스킬 하나를 내 공통 저장소로 가져온다. 내 사본이 다르면 overwrite 가 있어야 덮는다. */
export function importAiaPeerSkill(request: ImportAiaPeerSkillRequest): Promise<AiaPeerSkillImportReceipt> {
  return call<AiaPeerSkillImportReceipt>("import_aia_peer_skill", { request }, { timeoutMs: PEER_SKILL_TIMEOUT_MS });
}
