import type {
  ChatProviderOptions,
  ChatSettingField,
  ChatSettingOption,
  ProviderId,
} from "../types";
import { fallbackSettingFields } from "./chatModes.ts";

import { runtimeCatalogText } from "./i18nRuntime.ts";
// 실행설정 항목 스키마는 백엔드 ChatProviderOptions.settings로 내려오며,
// 카탈로그가 도착하기 전에는 fallbackSettingFields가 같은 내용을 즉시 제공한다.
// 이 모듈은 스키마가 어디서 왔든 항목을 찾고 저장값을 맞추는 일만 한다. 어떤 실행
// 모드·승인 처리·추론 수준이 있고 공급자별로 무엇을 고를 수 있으며 화면에 어떤 문구로
// 보이는지는 chatModes.ts가 정한다.
// 화면들이 창구 하나만 알면 되도록 그 표의 조회 함수는 여기서 다시 내보낸다.
export type { ChatSettingField, ChatSettingOption };
export {
  approvalModeLabel,
  defaultApprovalMode,
  effectiveApprovalMode,
  fallbackSettingFields,
  permissionModeLabel,
  reasoningLabel,
} from "./chatModes.ts";

export function settingFieldsFor(catalog: ChatProviderOptions | null, source: ProviderId): ChatSettingField[] {
  return catalog?.settings?.length ? catalog.settings : fallbackSettingFields(source);
}

export function settingField(fields: ChatSettingField[], key: string): ChatSettingField | null {
  return fields.find((field) => field.key === key) ?? null;
}

export function settingOptions(fields: ChatSettingField[], key: string): ChatSettingOption[] {
  return settingField(fields, key)?.options ?? [];
}

export function settingOptionLabel(fields: ChatSettingField[], key: string, value: string): string | null {
  const label = settingOptions(fields, key).find((option) => option.value === value)?.label;
  return label === undefined ? null : runtimeCatalogText(label);
}

/**
 * 이 값을 지금 고를 수 있는 선택지인지. 스키마에 없는 값과 비활성 선택지는 둘 다 고를 수
 * 없다는 점이 같아, 저장값 정규화와 추가 실행설정 정리가 같은 판정을 따로 들고 있었다.
 */
function isSelectableValue(options: ChatSettingOption[], value: string): boolean {
  return options.some((option) => option.value === value && !option.disabled);
}

/** 비어 있지 않아 저장·비교 대상이 되는 실행설정 값인지. */
function hasSettingValue(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * 저장된 선택값을 최신 스키마에 맞춘다. CLI가 더 이상 받지 않는 선택지는 스키마에서
 * 빠지므로, 예전 버전에서 저장한 값이 남아 있으면 스키마 기본값(없으면 고를 수 있는 첫
 * 선택지)으로 되돌린다. 스키마에 없는 항목은 판단할 근거가 없으니 그대로 둔다.
 */
export function normalizeSettingValue(fields: ChatSettingField[], key: string, value: string): string {
  const field = settingField(fields, key);
  if (!field || field.options.length === 0) return value;
  const options = field.options;
  if (isSelectableValue(options, value)) return value;
  const defaultValue = field.defaultValue;
  if (typeof defaultValue === "string" && isSelectableValue(options, defaultValue)) return defaultValue;
  return (options.find((option) => !option.disabled) ?? options[0]).value;
}

/** 스키마에서 사라진 추가 실행설정 항목과 허용되지 않는 값을 떨어낸다. */
export function normalizeExtraSettings(
  fields: ChatSettingField[],
  settings: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(settings).filter(([key, value]) => {
    const field = settingField(fields, key);
    if (!field || !hasSettingValue(value)) return false;
    return field.kind !== "enum" || isSelectableValue(field.options, value);
  }));
}

/** 비교 대상이 되는 키만 남긴다. 값이 빈 항목은 저장되지 않은 것과 같게 다룬다. */
function comparableSettingKeys(settings: Record<string, string>): string[] {
  return Object.keys(settings).filter((key) => hasSettingValue(settings[key]));
}

/**
 * 두 실행설정 한 벌이 같은 값을 담고 있는지. 화면이 다시 그릴지를 이 판정으로 정하므로
 * 저장·비교 대상이 아닌 빈 값은 양쪽에서 똑같이 뺀 뒤 비교한다.
 *
 * 예전에는 "같은가"를 직접 묻지 않고 양쪽을 키 순으로 정렬한 항목 배열로 편 다음 JSON
 * 문자열 두 벌을 지어 그 문자열을 비교했다. 실제로 필요한 것은 키 순서가 아니라 키마다
 * 값이 같은지인데, 그 뜻을 문자열이 같으면 같다는 우회로 적어 두어 읽는 쪽이 정렬이
 * 비교의 일부인지 직렬화를 맞추려는 보조인지 가릴 수 없었다. 중간 산물(정렬된 배열
 * 두 벌과 문자열 두 벌)도 첫 글자가 다른 흔한 경우까지 매번 끝까지 지어야 했다.
 *
 * 값 비교로 되돌리면 뜻이 그대로 드러나고, 어긋나는 키를 만나는 순간 멈춘다.
 */
export function sameChatSettings(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = comparableSettingKeys(left);
  return leftKeys.length === comparableSettingKeys(right).length
    && leftKeys.every((key) => left[key] === right[key]);
}
