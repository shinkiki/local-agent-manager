import type { ReactNode } from "react";

/**
 * 목록 화면의 필터 축 한 벌. 칩 줄·축 틀·축 줄 묶음과 "고른 값으로 남길지"를 정하는 판정
 * 표가 여기 모여 있다. 스킬관리 패널 안에 있던 것을 옮겼다 — 스킬정보·지침정보 화면이 필터
 * 축을 쓰려고 스킬 라이브러리 모듈을 읽고 있었고, 그러면 화면 하나를 고칠 때 관계없는 목록
 * 화면의 적재까지 따라 들어온다. 이 모듈은 스킬·지침 어느 쪽도 알지 않는다.
 */

/**
 * 필터 한 축의 칩 한 줄. 보관·상태·에이전트·출처 네 축이 라벨과 값만 다르고 활성 표시,
 * 개수 배지, "고른 칩이 아니면서 0건이면 못 누른다" 규칙은 같다. 네 벌로 두면 규칙을
 * 한쪽에서만 고치게 된다. 다른 화면(스킬정보·지침정보)은 이 줄을 직접 쓰지 않고 축 표를
 * 받는 `FilterAxisBar`를 거친다(0건 칩도 눌리게 두려면 `disabled`로 덮어쓴다).
 */
interface FilterChip<V extends string> {
  value: V;
  label: string;
  count: number;
  active: boolean;
  /** 기본 규칙(0건이면서 고른 칩이 아니다)을 덮어써야 하는 칩에만 준다. */
  disabled?: boolean;
  title?: string;
}

export function FilterChipRow<V extends string>({ groupLabel, className, chips, onSelect }: {
  groupLabel: string;
  className?: string;
  chips: FilterChip<V>[];
  onSelect: (value: V) => void;
}) {
  return (
    <div className={className ? `source-tabs ${className}` : "source-tabs"} role="group" aria-label={groupLabel}>
      {chips.map((chip) => (
        <button
          className={chip.active ? "active" : ""}
          type="button"
          key={chip.value}
          aria-pressed={chip.active}
          {...(chip.title === undefined ? {} : { title: chip.title })}
          disabled={chip.disabled ?? (chip.count === 0 && !chip.active)}
          onClick={() => onSelect(chip.value)}
        >
          {chip.label}<small>{chip.count.toLocaleString()}</small>
        </button>
      ))}
    </div>
  );
}

/**
 * 필터 축별 판정 표. 키가 축 이름이고, 값은 그 축에 고른 값으로 항목을 남길지 정한다.
 */
export type FilterAccept<T, F extends object> = { [K in keyof F]: (item: T, value: F[K]) => boolean };

export interface FilterMatcher<T, F extends object> {
  /** 고른 값 전부를 적용해 남는 항목인지 본다. `ignore` 축은 빼고 본다(개수 계산용). */
  matches(item: T, filters: F, ignore?: keyof F | null): boolean;
  /**
   * 주어진 목록과 현재 선택에 대해 "그 축만 이 값으로 바꿨을 때 남는 개수"를 세는 함수를
   * 만든다. 자기 축은 빼고 나머지 필터만 적용하므로 눌러 보지 않아도 칩에 개수가 보인다.
   */
  counter(items: readonly T[], filters: F): <K extends keyof F>(key: K, value: F[K]) => number;
}

/**
 * 필터 축 판정과 축별 개수 세기를 판정 표 한 벌에서 만든다. 스킬 목록과 지침정보 탭이
 * 같은 모양을 각자 적어 두고 있었다 — 축마다 `ignore` 비교를 손으로 늘어놓은 `matches`와,
 * 그 `matches`에 자기 축 판정을 한 번 더 붙인 `countWhere`. 축을 늘릴 때 늘어놓은 줄
 * 하나를 빠뜨리면 그 축이 개수 계산에서 조용히 빠지므로, 축 목록은 판정 표에서만 읽는다.
 */
export function filterMatcher<T, F extends object>(accept: FilterAccept<T, F>): FilterMatcher<T, F> {
  const keys = Object.keys(accept) as (keyof F)[];
  // 축마다 값 타입이 다른 표를 축 이름 변수로 훑으므로, 한 축의 판정으로 좁혀 부른다.
  const acceptAt = <K extends keyof F>(key: K, item: T, value: F[K]): boolean =>
    (accept[key] as (item: T, value: F[K]) => boolean)(item, value);
  const matches = (item: T, filters: F, ignore: keyof F | null = null): boolean =>
    keys.every((key) => key === ignore || acceptAt(key, item, filters[key]));
  return {
    matches,
    counter: (items, filters) => (key, value) =>
      items.filter((item) => matches(item, filters, key) && acceptAt(key, item, value)).length,
  };
}

/** 필터 축 하나를 감싸는 라벨 + 본문 틀. */
export function FilterAxis({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className ? `skill-filter-group ${className}` : "skill-filter-group"}>
      <span className="skill-filter-label">{label}</span>
      {children}
    </div>
  );
}

/**
 * 필터 축 한 줄의 명세. 축 이름(`axis`)은 필터 한 벌의 키이고, 칩은 그 축에 고를 수 있는
 * 값과 이름표다. 개수 배지와 활성 표시는 명세에 적지 않는다 — 고른 필터와 개수 세는 함수에서
 * 나오므로, 적어 두면 두 자리가 어긋난다. 0건 칩도 눌리게 두어야 하는 자리만 `disabled`로
 * 칩 줄의 기본 규칙을 덮어쓴다.
 */
export interface FilterAxisSpec<F extends object, K extends keyof F = keyof F> {
  axis: K;
  label: string;
  groupLabel: string;
  chips: readonly { value: F[K] & string; label: string; title?: string; disabled?: boolean }[];
}

/**
 * 필터 축 여러 줄. 스킬관리·스킬정보·지침정보 세 화면이 축마다
 * `<FilterAxis><FilterChipRow chips={…축마다 손으로 조립…}/></FilterAxis>` 덩어리를 그대로
 * 되풀이해 적고 있었다 — 개수는 자기 축을 뺀 나머지 필터로 세고, 활성은 고른 값과 견주고,
 * 고르면 그 축만 바꾼 필터 한 벌을 돌려준다는 같은 규칙이 여덟 자리에 흩어져 있어 한 축을
 * 더할 때 그중 하나를 빠뜨리기 쉬웠다. 축 표만 주면 그 세 규칙은 여기서 나온다.
 */
export function FilterAxisBar<F extends object>({ axes, filters, countWhere, onChange }: {
  axes: readonly FilterAxisSpec<F>[];
  filters: F;
  /** 그 축만 이 값으로 바꿨을 때 남는 개수. `FilterMatcher.counter`가 그대로 들어맞는다. */
  countWhere: <K extends keyof F>(axis: K, value: F[K]) => number;
  onChange: (filters: F) => void;
}) {
  return (
    <>
      {axes.map((axis) => (
        <FilterAxis label={axis.label} key={String(axis.axis)}>
          <FilterChipRow
            groupLabel={axis.groupLabel}
            chips={axis.chips.map((chip) => ({
              ...chip,
              count: countWhere(axis.axis, chip.value as F[keyof F]),
              active: filters[axis.axis] === chip.value,
            }))}
            onSelect={(value) => onChange({ ...filters, [axis.axis]: value })}
          />
        </FilterAxis>
      ))}
    </>
  );
}
