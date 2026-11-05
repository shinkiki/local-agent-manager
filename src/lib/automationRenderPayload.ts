import type { SystemAutomationSnapshot, TranslationStatus } from "../types";

// 번역 진행 revision·updatedAt은 백엔드가 스캔할 때마다 새 값을 반환하므로,
// 화면 표시와 번역 재조회에 실제로 영향을 주는 내용만 비교한다.
export function automationRenderPayload(snapshot: SystemAutomationSnapshot): string {
  const stripTime = ({ updatedAt: _updatedAt, ...status }: TranslationStatus) => status;
  const { revision: _revision, uiTranslation, skills, agents, artifacts, ...rest } = snapshot;
  return JSON.stringify({
    ...rest,
    uiTranslation: stripTime(uiTranslation),
    skills: stripTime(skills),
    agents: stripTime(agents),
    artifacts: stripTime(artifacts),
  });
}

