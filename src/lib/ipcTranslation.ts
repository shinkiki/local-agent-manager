/**
 * 시스템 자동화 설정과 번역(UI 언어·메뉴 번역·리소스 번역) 명령 묶음.
 *
 * `ipc.ts`는 백엔드 명령을 한 줄씩 얹은 700줄짜리 목록이라, 자동화 설정과 번역이
 * 사용량 예산과 채팅 명령 사이에 끼어 있었다. 이 열한 개는 모두 같은
 * `SystemAutomationSnapshot` 한 덩어리를 읽고 되돌려받는 한 묶음이고 번역 화면
 * 하나가 통째로 쓴다. 스킬(`ipcSkills`)·지침(`ipcInstructions`)·문서(`ipcDocuments`)와
 * 같은 규칙으로 따로 낸다.
 *
 * UI 문구 표 자체(`i18nStaticUi`)는 여기 두지 않는다. 그쪽은 백엔드 왕복 없이 화면이
 * 가진 정적 표라 통로가 다르다 — 여기 있는 것은 모두 `call` 한 줄이다.
 */
import type {
  MenuTranslations,
  SystemAutomationSettingsInput,
  SystemAutomationSnapshot,
  SystemLanguageRequest,
  TranslatedDetail,
  TranslationMenu,
} from "../types";
import { call } from "./ipcTransport";

export function getSystemAutomationSnapshot(): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("get_system_automation_snapshot");
}

export function setSystemAutomationSettings(
  request: SystemAutomationSettingsInput,
): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("set_system_automation_settings", { request });
}

export function requestSystemLanguage(
  request: SystemLanguageRequest,
): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("request_system_language", { request });
}

export function retryUiTranslation(): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("retry_ui_translation");
}

export function cancelUiTranslation(): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("cancel_ui_translation");
}

export function getMenuTranslations(menu: TranslationMenu): Promise<MenuTranslations> {
  return call<MenuTranslations>("get_menu_translations", { menu });
}

export function getTranslatedDetail(
  menu: TranslationMenu,
  resourceId: string,
): Promise<TranslatedDetail> {
  return call<TranslatedDetail>("get_translated_detail", { menu, resourceId });
}

export function retryMenuTranslation(menu: TranslationMenu): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("retry_menu_translation", { menu });
}

/** 저장된 번역을 버리고 해당 메뉴를 처음부터 다시 번역한다. */
export function resetMenuTranslation(menu: TranslationMenu): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("reset_menu_translation", { menu });
}

/**
 * 리소스 하나와 그 리소스의 모든 필드를 지금 번역한다. 메뉴 자동번역 토글과 무관하게
 * 동작하고, 이미 번역이 있으면 캐시를 건너뛰고 다시 번역한다.
 */
export function translateResource(
  menu: TranslationMenu,
  resourceId: string,
): Promise<SystemAutomationSnapshot> {
  return call<SystemAutomationSnapshot>("translate_resource", { menu, resourceId });
}
