/**
 * 이 장치에 깔린 공급자 CLI 설치본을 다루는 명령 — 버전·설치 출처 조회, 패키지 관리자에
 * 최신 버전 확인, 고정 명령으로 업데이트, 실행 버전과 어긋난 모델 카탈로그 캐시 정리,
 * 그리고 업데이트 전에 먼저 끊어야 하는 실행 중 프로세스 수 조회다.
 *
 * `ipcAccounts.ts`는 이름 그대로 공급자 **계정**을 다루는 곳인데, 그 계정을 실행하는 CLI의
 * 설치본 관리가 함께 얹혀 있었다(그쪽 머리말도 두 축을 함께 든다고 적고 있었다). 둘은
 * 바뀌는 이유가 다르다 — 계정 쪽은 로그인·기본 계정·페일오버 정책·사용량처럼 계정마다
 * 따로 남는 기록이 늘 때 바뀌고, 이쪽은 설치 출처와 업데이트 명령이 공급자마다 달라질 때
 * 바뀐다. 단위도 다르다: 계정 명령은 `accountId` 하나를 받고, 여기 있는 명령은 계정과
 * 무관하게 `provider` 단위로 이 기기 전체에 한 번 듣는다. 한 파일에 있는 동안은 계정 정책
 * 하나를 고칠 때도 설치 출처 판정을 지나야 했다.
 *
 * 실행 중 프로세스 수는 계정이 아니라 이쪽이다. 그 값을 읽는 유일한 이유가 "CLI를 지금
 * 업데이트해도 되는가"이고, 업데이트 흐름과 떨어지면 무엇을 세는 값인지 알 수 없다.
 *
 * `ipc.ts`가 이 파일의 이름을 그대로 다시 내보내므로 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type {
  CliUpdateReceipt,
  ModelCacheCleanupReceipt,
  ProviderCliUpdateStatus,
  ProviderId,
  ProviderRuntimeCounts,
} from "../types";
import { call } from "./ipcTransport";

/** 공급자 CLI 버전과 설치 출처, 모델 캐시 상태. 네트워크 조회 없이 로컬만 확인한다. */
export function getCliUpdateStatus(): Promise<ProviderCliUpdateStatus[]> {
  return call<ProviderCliUpdateStatus[]>("get_cli_update_status");
}

/** 설치 출처의 패키지 관리자에서 최신 버전을 조회한다. 호스트 로컬 UI 전용. */
export function checkProviderCliUpdate(provider: ProviderId): Promise<ProviderCliUpdateStatus> {
  return call<ProviderCliUpdateStatus>("check_provider_cli_update", { provider });
}

/** 종료 확인창에 보여줄 실행 중 관리 채팅·터미널·외부 프로세스 수. */
export function getProviderRuntimeCounts(provider: ProviderId): Promise<ProviderRuntimeCounts> {
  return call<ProviderRuntimeCounts>("get_provider_runtime_counts", { provider });
}

/** 확인된 설치 출처의 고정 명령으로 CLI를 업데이트한다. 호스트 로컬 UI 전용. */
export function updateProviderCli(provider: ProviderId): Promise<CliUpdateReceipt> {
  return call<CliUpdateReceipt>("update_provider_cli", { provider });
}

/** 실행 버전과 기록 버전이 다른 모델 카탈로그 캐시만 정리한다. 호스트 로컬 UI 전용. */
export function clearProviderModelCaches(provider: ProviderId): Promise<ModelCacheCleanupReceipt> {
  return call<ModelCacheCleanupReceipt>("clear_provider_model_caches", { provider });
}
