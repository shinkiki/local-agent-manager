// 경로 문자열을 판단에 쓰기 전에 늘 거치는 손질 — 구분자 통일, 사람이 적은 값의 앞뒤 공백
// 다듬기, 마지막 조각 뽑기. 백엔드가 내려주는 경로는 운영체제에 따라 `\`와 `/`가 섞여 오므로,
// 어떤 규칙으로 판정하든 그 앞에 이 한 걸음이 놓인다.
//
// 같은 손질이 도메인마다 한 벌씩 다시 적혀 있었다 — Cypress 작업공간 경로는 구분자를 맞춘 뒤
// 마지막 조각을 잘라 쓰고, 강조 표시용 언어 판정은 그 두 걸음을 한 줄에 다시 적었다. 손질
// 자체는 도메인과 무관한 문자열 규칙이라 한 자리에서만 정한다. 이 경로로 무엇을 판단하는지는
// 각 도메인 모듈(cypressWorkspace.ts / cypressRunSummary.ts / codeLanguages.ts)이 계속 맡는다.

/** 윈도우 구분자를 `/`로 맞춘다. 앞뒤 공백은 건드리지 않는다. */
export function normalizePathSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * 앞뒤 공백을 떼고 구분자를 맞춘다. 사람이 입력란에 적었거나 사람이 읽을 자리에서 온 경로가
 * 여기로 온다 — 눈에 보이지 않는 공백 한 칸 때문에 같은 경로가 다른 값으로 갈리지 않게,
 * 판정 전에 이 한 걸음을 먼저 밟는다.
 */
export function cleanPathInput(path: string): string {
  return normalizePathSlashes(path.trim());
}

/** 구분자를 맞춘 경로의 마지막 조각. 구분자가 없으면 경로 전체가 그대로 이름이다. */
export function pathFileName(path: string): string {
  const normalized = normalizePathSlashes(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
