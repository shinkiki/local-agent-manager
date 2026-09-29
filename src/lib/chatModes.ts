import type {
  ChatApprovalMode,
  ChatMode,
  ChatSettingField,
  ChatSettingOption,
  KnownReasoningEffort,
  ProviderId,
  ReasoningEffort,
} from "../types";
import { runtimeText } from "./i18nRuntime.ts";

// 공급자별 실행 모드·승인 처리·추론 수준 한 벌 — 어떤 선택지가 있고, 누가 고를 수 있고,
// 화면에 어떤 문구로 보이는지. 바뀌는 이유는 CLI가 고를 수 있는 값을 늘리거나 줄일 때뿐이다.
// 스키마가 어디서 왔든(백엔드 카탈로그든 이 표든) 값을 조회·정규화하는 일은 chatSettings.ts가
// 맡는다. 화면들은 창구 하나만 알면 되도록 chatSettings가 여기를 다시 내보낸다.

/**
 * 실행 모드·승인 처리 선택지의 표시 문구를 한 곳에 모은 표. 실행설정 스키마의 선택지와
 * 요약 줄의 짧은 문구가 같은 값을 두 벌로 들고 있어 한쪽만 고치면 어긋났다. `short`는
 * 선택지 문구와 요약 문구가 다른 값에만 둔다.
 */
interface ModeLabel {
  label: string;
  detail: string;
  short?: string;
  /**
   * 이 선택지를 지원하는 공급자. 값이 있으면 그 공급자에서만 고를 수 있고, 나머지
   * 공급자에서는 목록에서 빠진다. `shownDisabled`면 목록에는 남기고 비활성으로 내
   * 왜 못 고르는지 보인다(`label`은 그때 쓰는 공급자 이름).
   */
  onlyFor?: { source: ProviderId; label: string; shownDisabled?: boolean };
}

const CLAUDE_ONLY = { source: "claude", label: "Claude" } as const;
const CODEX_ONLY = { source: "codex", label: "Codex" } as const;

/**
 * 표는 부를 때마다 짓는다. 표시 문구가 현재 언어를 보고 정해지므로 모듈이 적재되는
 * 순간에 굳히면 언어를 바꾼 뒤에도 처음 언어로 남는다.
 */
function modeLabels(): Record<ChatMode, ModeLabel> {
  return {
    plan: { label: runtimeText("읽기 전용", "Read only"), detail: runtimeText("분석·계획만", "Analysis and planning only") },
    workspace: { label: runtimeText("작업공간 쓰기", "Workspace write"), detail: runtimeText("프로젝트 수정", "Edits the project") },
    fullAccess: { label: runtimeText("전체 접근", "Full access"), detail: runtimeText("외부 경로 허용", "Allows paths outside the project") },
    auto: { label: runtimeText("자동 권한", "Auto permissions"), detail: runtimeText("Claude auto 모드", "Claude auto mode"), onlyFor: CLAUDE_ONLY },
    dontAsk: { label: runtimeText("추가 권한 차단", "Block extra permissions"), detail: runtimeText("Claude dontAsk 모드", "Claude dontAsk mode"), onlyFor: CLAUDE_ONLY },
    manual: { label: runtimeText("수동 권한", "Manual permissions"), detail: runtimeText("Claude manual 모드", "Claude manual mode"), onlyFor: CLAUDE_ONLY },
  };
}

function approvalLabels(): Record<ChatApprovalMode, ModeLabel> {
  return {
    manual: { label: runtimeText("직접 승인", "Approve manually"), detail: runtimeText("사용자 확인", "Asks the user") },
    // 자동 검토는 Codex 전용이지만 다른 공급자에서도 왜 못 고르는지 보이도록 남긴다.
    autoReview: { label: runtimeText("자동 검토", "Automatic review"), detail: runtimeText("위험도 판단", "Judges the risk"), onlyFor: { ...CODEX_ONLY, shownDisabled: true } },
    granular: { label: runtimeText("세분화 승인", "Granular approval"), detail: runtimeText("승인 종류별 제어", "Controlled per approval kind"), onlyFor: CODEX_ONLY },
    onFailure: { label: runtimeText("실패 시 승인", "Approve on failure"), detail: runtimeText("샌드박스 실패 후 요청", "Asks after a sandbox failure"), onlyFor: CODEX_ONLY },
    never: { label: runtimeText("승인 없이 실행", "Run without approval"), detail: runtimeText("모드 범위 내", "Within the mode's scope"), short: runtimeText("승인 없음", "No approval") },
  };
}

/** 이 공급자가 고를 수 있는 선택지인지. 표의 전용 표시 한 칸만 본다. */
function modeSupported(entry: ModeLabel, source: ProviderId): boolean {
  return !entry.onlyFor || entry.onlyFor.source === source;
}

/**
 * 공급자가 고를 수 있는 선택지 목록. 화면 순서는 표의 정의 순서이고, 공급자별 차이는
 * 표의 `onlyFor` 한 칸으로만 적는다. 예전에는 전용 목록·비활성 유지 목록·선택지 조립의
 * 특별 취급이 표 밖에 흩어져 있어, 선택지를 하나 늘릴 때 한 곳만 고치면 조용히 어긋났다.
 *
 * 목록에 남길지와 그 줄을 어떤 모양으로 낼지는 같은 한 칸(`onlyFor`)만 보고 정하므로,
 * 거르기와 줄 만들기를 따로 두지 않고 한 번 순회로 끝낸다. 나눠 두었을 때는 호출부마다
 * 표 이름과 공급자를 두 번씩 넘겨야 했고, 거르기 쪽 조건만 고치면 비활성으로 남은 줄이
 * 목록에서 통째로 사라지는 식으로 어긋날 수 있었다.
 */
function modeOptions<Key extends string>(
  table: Record<Key, ModeLabel>,
  source: ProviderId,
): ChatSettingOption[] {
  const options: ChatSettingOption[] = [];
  for (const [key, entry] of Object.entries(table) as [Key, ModeLabel][]) {
    const supported = modeSupported(entry, source);
    const { label, detail, onlyFor } = entry;
    // 전용 선택지는 기본적으로 목록에서 빼고, `shownDisabled`인 것만 비활성으로 남겨
    // 왜 못 고르는지 공급자 이름으로 알린다.
    if (!onlyFor?.shownDisabled) {
      if (supported) options.push({ value: key, label, detail });
      continue;
    }
    options.push({ value: key, label, detail: supported ? detail : runtimeText(`${onlyFor.label} 전용`, `${onlyFor.label} only`), disabled: !supported });
  }
  return options;
}

/** 내장 선택형 실행설정 한 칸을 만든다. 공통 `enum` 표시는 이 경계에서만 붙인다. */
function enumSettingField(field: Omit<ChatSettingField, "kind">): ChatSettingField {
  return { ...field, kind: "enum" };
}

/**
 * 카탈로그가 도착하기 전에 쓰는 내장 실행설정 스키마. 백엔드
 * `ChatProviderOptions.settings`와 같은 항목을 같은 순서로 낸다.
 */
export function fallbackSettingFields(source: ProviderId): ChatSettingField[] {
  const fields: ChatSettingField[] = [
    enumSettingField({
      key: "mode",
      label: runtimeText("실행 모드", "Run mode"),
      detail: runtimeText("권한 범위", "Permission scope"),
      defaultValue: "workspace",
      options: modeOptions(modeLabels(), source),
    }),
  ];
  // Antigravity CLI는 print 모드에 대화형 승인 연결이 없어 승인 처리 값이 실행에
  // 쓰이지 않는다. 백엔드 스키마와 같게, 카탈로그가 오기 전에도 항목을 내지 않는다.
  if (source !== "antigravity") {
    fields.push(enumSettingField({
      key: "approvalMode",
      label: runtimeText("승인 처리", "Approval handling"),
      detail: runtimeText("명령 · 파일 · 추가 권한", "Commands · files · extra permissions"),
      defaultValue: defaultApprovalMode(source),
      options: modeOptions(approvalLabels(), source),
    }));
  }
  return fields;
}

export function defaultApprovalMode(source: ProviderId): ChatApprovalMode {
  return source === "codex" ? "autoReview" : "manual";
}

/** 이 공급자에서 고를 수 없는 승인 처리는 직접 승인으로 되돌린다. 표에 없는 값은 그대로 둔다. */
export function effectiveApprovalMode(source: ProviderId, mode: ChatApprovalMode): ChatApprovalMode {
  const entry = approvalLabels()[mode] as ModeLabel | undefined;
  return entry && !modeSupported(entry, source) ? "manual" : mode;
}

/**
 * 표에서 요약용 문구를 꺼낸다. 저장된 값이 표에 없을 수 있으므로(예전 버전에서 저장한 값)
 * 조회 결과를 없을 수 있는 것으로 다루고, 없으면 호출부가 정한 문구로 대신한다.
 */
function modeLabelText<Key extends string>(
  table: Record<Key, ModeLabel>,
  key: Key,
  fallback: string,
): string {
  const entry = table[key] as ModeLabel | undefined;
  return entry?.short ?? entry?.label ?? fallback;
}

export function approvalModeLabel(mode: ChatApprovalMode): string {
  return modeLabelText(approvalLabels(), mode, runtimeText("승인 없음", "No approval"));
}

export function permissionModeLabel(mode: ChatMode): string {
  const table = modeLabels();
  return modeLabelText(table, mode, table.workspace.label);
}

/**
 * 추론 수준의 표시 문구. 모드·승인 처리와 같은 이유로(CLI가 고를 수 있는 값을 늘리거나
 * 줄일 때) 손대는 표인데 혼자 실행설정 조회 모듈에 남아 있었다. 그 모듈은 스키마가 어디서
 * 왔든 항목을 찾고 저장값을 맞추는 일만 한다고 적어 두고도 표시 문구 표 하나를 들고 있었고,
 * 나머지 문구는 이미 여기서 가져다 다시 내보내고 있었다 — 문구를 찾는 사람이 두 자리를
 * 뒤져야 하는 상태였다.
 */
function reasoningLabels(): Record<KnownReasoningEffort, string> {
  return {
    none: runtimeText("없음", "None"),
    minimal: runtimeText("최소", "Minimal"),
    low: runtimeText("낮음", "Low"),
    medium: runtimeText("보통", "Medium"),
    high: runtimeText("높음", "High"),
    xhigh: runtimeText("매우 높음", "Very high"),
    max: runtimeText("최대", "Max"),
    ultra: runtimeText("울트라", "Ultra"),
  };
}

/**
 * 추론 수준 표시 문구. CLI가 새로 추가한 수준은 내장 문구가 없으므로 이름을 그대로 보여준다.
 * 모르는 값을 마지막 내장 문구로 떨어뜨리면 다른 수준으로 잘못 표시된다.
 */
export function reasoningLabel(effort: ReasoningEffort): string {
  return reasoningLabels()[effort as KnownReasoningEffort] ?? effort;
}
