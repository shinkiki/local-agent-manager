/**
 * 공급자 CLI 수집 설정(C13) IPC 명령.
 *
 * Claude 플러그인 설정과 파일은 겹치지만(둘 다 `~/.claude/settings.json`) 다루는 키도
 * 화면도 달라 따로 둔다. 이쪽은 세 공급자의 설정 파일을 한 화면에서 나란히 보여 준다.
 */
import type { ProviderTelemetrySnapshot, SetProviderTelemetryOptionRequest } from "../types";
import { call } from "./ipcTransport";

/** Claude·Codex·Gemini CLI의 현재 수집 설정. */
export function getProviderTelemetry(): Promise<ProviderTelemetrySnapshot> {
  return call<ProviderTelemetrySnapshot>("get_provider_telemetry");
}

export function setProviderTelemetryOption(request: SetProviderTelemetryOptionRequest): Promise<ProviderTelemetrySnapshot> {
  return call<ProviderTelemetrySnapshot>("set_provider_telemetry_option", { request });
}
