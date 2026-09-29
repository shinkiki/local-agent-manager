/**
 * 외부 MCP 플러그인 기본도구 명령 묶음. 갈라 둔 이유는 `ipcDbConnections.ts` 머리말에 적는다.
 *
 * 여기 있는 이름은 `ipc.ts`가 그대로 다시 내보낸다. 화면 쪽 import 경로는 예전 그대로
 * `lib/ipc`다.
 */
import type {
  ExternalPluginOAuthStart,
  ExternalPluginView,
  ExternalPluginsSnapshot,
  PluginToolPolicy,
  RegisterExternalPluginRequest,
  UpdateExternalPluginRequest,
} from "../types";
import { notifyBuiltinTools } from "./builtinToolsSignal";
import { call } from "./ipcTransport";

/** 승인 주소를 받기까지. 공급자 서버 왕복 한 번이라 사람을 기다리는 시간은 들어 있지 않다. */
const PLUGIN_OAUTH_BEGIN_TIMEOUT_MS = 60_000;
/** 플러그인 연결 확인은 프록시가 MCP 서버를 새로 띄우고 initialize·tools/list까지 마친다. */
const PLUGIN_VERIFY_TIMEOUT_MS = 150_000;

/** 외부 플러그인(MCP 서버) 목록. 비밀값은 실리지 않는다. */
export function getExternalPlugins(): Promise<ExternalPluginsSnapshot> {
  return call<ExternalPluginsSnapshot>("get_external_plugins");
}

/** 플러그인 등록. 토큰·client_secret은 호스트에서만 보내며 응답에 돌아오지 않는다. */
export function registerExternalPlugin(request: RegisterExternalPluginRequest): Promise<ExternalPluginView> {
  return notifyBuiltinTools(call<ExternalPluginView>("register_external_plugin", { ...request }));
}

/** 플러그인 편집. 주소·인증 방식·client_id·client_secret가 바뀌면 저장된 자격증명과 연결 확인 결과가 초기화된다. */
export function updateExternalPlugin(request: UpdateExternalPluginRequest): Promise<ExternalPluginView> {
  return notifyBuiltinTools(call<ExternalPluginView>("update_external_plugin", { ...request }));
}

export function removeExternalPlugin(id: string): Promise<{ removed: boolean; id: string }> {
  return notifyBuiltinTools(call<{ removed: boolean; id: string }>("remove_external_plugin", { id }));
}

export function setExternalPluginEnabled(id: string, enabled: boolean): Promise<ExternalPluginView> {
  return notifyBuiltinTools(call<ExternalPluginView>("set_external_plugin_enabled", { id, enabled }));
}

/** 도구 하나의 허용/확인/제한. 제한은 다음 요청부터, 허용은 새로 시작하는 채팅부터 듣는다. */
export function setExternalPluginToolPolicy(id: string, tool: string, policy: PluginToolPolicy): Promise<ExternalPluginView> {
  return call<ExternalPluginView>("set_external_plugin_tool_policy", { id, tool, policy });
}

/** 현재 알려진 도구 전체를 한 번의 저장으로 같은 권한에 맞춘다. */
export function setExternalPluginToolPolicies(id: string, policy: PluginToolPolicy): Promise<ExternalPluginView> {
  return call<ExternalPluginView>("set_external_plugin_tool_policies", { id, policy });
}

export function setExternalPluginToken(id: string, token: string): Promise<ExternalPluginView> {
  return notifyBuiltinTools(call<ExternalPluginView>("set_external_plugin_token", { id, token }));
}

/** OAuth 승인 주소를 받는다. 호스트 화면이 브라우저로 열고, 콜백은 백엔드 loopback이 받는다. */
export function beginExternalPluginOAuth(id: string): Promise<ExternalPluginOAuthStart> {
  return call<ExternalPluginOAuthStart>("begin_external_plugin_oauth", { id }, { timeoutMs: PLUGIN_OAUTH_BEGIN_TIMEOUT_MS });
}

export function cancelExternalPluginOAuth(id: string): Promise<ExternalPluginView> {
  return notifyBuiltinTools(call<ExternalPluginView>("cancel_external_plugin_oauth", { id }));
}

/** CLI가 쓰는 프록시 경로로 initialize·tools/list를 실행해 연결과 인증을 확인한다. */
export function verifyExternalPlugin(id: string): Promise<ExternalPluginView> {
  return notifyBuiltinTools(
    call<ExternalPluginView>("verify_external_plugin", { id }, { timeoutMs: PLUGIN_VERIFY_TIMEOUT_MS }),
  );
}
