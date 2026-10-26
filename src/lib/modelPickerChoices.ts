import type { ChatModelCatalogOption, ChatProviderOptions, ModelOption } from "../types";
import type { UiText } from "./i18nLocale";

function uncataloguedModelOption(model: string, description: string): ChatModelCatalogOption {
  return {
    model,
    displayName: model,
    description,
    isDefault: false,
    defaultReasoningEffort: null,
    supportedReasoningEfforts: [],
  };
}

/**
 * 모델 목록에 무엇을 담을지. 카탈로그 · 최근 사용 · 지금 저장된 값 순으로 합치고, 뒤에 오는
 * 것이 앞선 설명을 덮지 않게 먼저 담긴 항목을 남긴다. 화면 배선과 달리 입력만으로 정해진다.
 */
export function modelPickerChoices(catalog: ChatProviderOptions | null, recent: ModelOption[], value: string, text: UiText) {
  const modelMap = new Map<string, ChatModelCatalogOption>();
  for (const option of catalog?.models ?? []) modelMap.set(option.model, option);
  for (const item of recent) {
    if (!modelMap.has(item.model)) {
      modelMap.set(item.model, uncataloguedModelOption(item.model, text("최근 세션에서 사용한 모델", "Model used in a recent session")));
    }
  }
  // 카탈로그에도 최근 목록에도 없는 값(예: CLI 설정이나 이전 버전에서 직접 입력한 식별자)이
  // 저장돼 있으면 목록에서 사라져 무엇이 선택됐는지 알 수 없다. 목록에 함께 노출한다.
  if (value && !modelMap.has(value)) {
    modelMap.set(value, uncataloguedModelOption(value, text("저장된 모델 식별자", "Saved model identifier")));
  }
  return {
    options: [...modelMap.values()],
    selected: value ? modelMap.get(value) : catalog?.models.find((option) => option.isDefault),
    countByModel: new Map(recent.map((item) => [item.model, item.count])),
  };
}
