/**
 * 사용량 예산(정책·소진 알림·계정/소비자 한도·비용 절감) IPC 명령 묶음.
 *
 * `ipc.ts` 중간에 위치하던 예산 관련 명령 6개를 독립된 모듈로 분리한다.
 * `UsageBudgetPanel`을 비롯한 예산 관리 UI 컴포넌트가 사용하는 한 덩어리이며,
 * 다른 `ipc*` 모듈과 동일한 구조로 분리하여 `ipc.ts`의 책임을 줄인다.
 */
import type {
  SavingsDefaults,
  SetUsageBudgetAccountRequest,
  SetUsageBudgetConsumerRequest,
  UsageBudgetDefaults,
  UsageBudgetSnapshot,
} from "../types";
import { call } from "./ipcTransport";

export function getUsageBudget(): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("get_usage_budget");
}

export function setUsageBudgetPolicy(request: UsageBudgetDefaults): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("set_usage_budget_policy", { request });
}

/**
 * 소진 마감 안내를 봤다고 기록해 같은 크레딧으로 다시 알리지 않게 한다. `creditId`를 비우면
 * 기록을 지워 다시 알린다.
 */
export function acknowledgeDrainNotice(accountId: string, creditId: string | null): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("acknowledge_drain_notice", { request: { accountId, creditId } });
}

export function setUsageBudgetAccount(request: SetUsageBudgetAccountRequest): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("set_usage_budget_account", { request });
}

export function setUsageBudgetConsumer(request: SetUsageBudgetConsumerRequest): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("set_usage_budget_consumer", { request });
}

export function setUsageBudgetSavings(request: SavingsDefaults): Promise<UsageBudgetSnapshot> {
  return call<UsageBudgetSnapshot>("set_usage_budget_savings", { request });
}
