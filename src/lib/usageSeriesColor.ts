/**
 * 계정 소진율 그래프의 계열색. 색을 목록에서 고르지 않고 자리 번호로 만든다 — 고정 팔레트는
 * 계정 수가 팔레트 크기를 넘는 순간 뒷자리 계정들이 같은 색으로 서기 때문이다.
 *
 * 색상 24 · 명도 5 · 채도 3 격자에서 "앞자리들이 쓴 색과 OKLab 거리가 가장 먼 색"을 차례로
 * 집는다. 고르는 근거가 앞자리뿐이라 계정이 늘어도 이미 서 있던 계정의 색은 그대로다.
 * 채도는 절댓값이 아니라 그 명도·색상에서 sRGB가 감당하는 최대 채도의 비율로 잡는다 —
 * 절댓값으로 잡으면 색 영역 밖 색이 화면에서 잘리면서 서로 다른 자리가 같은 색이 된다.
 */

/** 테마별 명도 폭. 어두운 패널(#101822)과 밝은 배경(#f2f5f9)이 견디는 범위가 다르다. */
const LIGHTNESS_RANGE = {
  dark: { min: 0.5, max: 0.8 },
  light: { min: 0.38, max: 0.66 },
};
/** 색이 형광으로 튀지 않게 두는 채도 상한. */
const CHROMA_CEILING = 0.19;
/** 회색에 가까워지지 않게 두는 채도 하한 비율. */
const CHROMA_FRACTIONS = [0.5, 0.75, 1];
const HUE_STEPS = 24;
const LIGHTNESS_STEPS = 5;
/**
 * 격자를 다 쓰면 처음 색부터 다시 돈다. 여기를 넘는 계정은 색이 겹친다.
 * 격자를 되돌리는 일은 이 모듈 안에서만 일어나므로 밖으로 내보내지 않는다.
 */
const USAGE_SERIES_LIMIT =HUE_STEPS * LIGHTNESS_STEPS * CHROMA_FRACTIONS.length;

type Lab = { lightness: number; a: number; b: number };

function oklabToLinear({ lightness, a, b }: Lab): [number, number, number] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(lab: Lab): boolean {
  return oklabToLinear(lab).every((channel) => channel >= -1e-4 && channel <= 1.0001);
}

function toLab(lightness: number, chroma: number, hueDegrees: number): Lab {
  const radians = (hueDegrees * Math.PI) / 180;
  return { lightness, a: chroma * Math.cos(radians), b: chroma * Math.sin(radians) };
}

/** 이 명도·색상에서 sRGB가 감당하는 최대 채도. 밖으로 나가면 화면이 잘라 버린다. */
function maxChroma(lightness: number, hueDegrees: number): number {
  let low = 0;
  let high = CHROMA_CEILING;
  if (inGamut(toLab(lightness, high, hueDegrees))) return high;
  for (let step = 0; step < 24; step += 1) {
    const mid = (low + high) / 2;
    if (inGamut(toLab(lightness, mid, hueDegrees))) low = mid;
    else high = mid;
  }
  return low;
}

function toHex(lab: Lab): string {
  const channels = oklabToLinear(lab).map((linear) => {
    const clamped = Math.min(1, Math.max(0, linear));
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(encoded * 255).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function buildGrid(range: { min: number; max: number }): Lab[] {
  const grid: Lab[] = [];
  for (let hueStep = 0; hueStep < HUE_STEPS; hueStep += 1) {
    const hue = (hueStep * 360) / HUE_STEPS;
    for (let lightnessStep = 0; lightnessStep < LIGHTNESS_STEPS; lightnessStep += 1) {
      const lightness = range.min + ((range.max - range.min) * lightnessStep) / (LIGHTNESS_STEPS - 1);
      const ceiling = maxChroma(lightness, hue);
      for (const fraction of CHROMA_FRACTIONS) grid.push(toLab(lightness, ceiling * fraction, hue));
    }
  }
  return grid;
}

function squaredDistance(left: Lab, right: Lab): number {
  return (left.lightness - right.lightness) ** 2 + (left.a - right.a) ** 2 + (left.b - right.b) ** 2;
}

interface SeriesCache {
  grid: Lab[];
  remaining: Set<Lab>;
  picked: Lab[];
  hexes: string[];
}

function createCache(range: { min: number; max: number }): SeriesCache {
  const grid = buildGrid(range);
  const remaining = new Set(grid);
  // 첫 색은 초록 계열의 가장 진한 자리. 계정이 하나뿐인 화면에서도 색이 튀지 않는다.
  const first = grid.reduce((best, lab) => (
    squaredDistance(lab, toLab(0.64, 0.17, 149)) < squaredDistance(best, toLab(0.64, 0.17, 149)) ? lab : best
  ));
  remaining.delete(first);
  return { grid, remaining, picked: [first], hexes: [toHex(first)] };
}

const caches = new Map<"dark" | "light", SeriesCache>();

/** 남은 격자점 중 이미 고른 색들에서 가장 멀리 떨어진 하나를 집는다. */
function pickNext(cache: SeriesCache): void {
  let best: Lab | null = null;
  let bestDistance = -1;
  for (const candidate of cache.remaining) {
    let nearest = Infinity;
    for (const chosen of cache.picked) {
      nearest = Math.min(nearest, squaredDistance(candidate, chosen));
      if (nearest <= bestDistance) break;
    }
    if (nearest > bestDistance) {
      bestDistance = nearest;
      best = candidate;
    }
  }
  if (!best) return;
  cache.remaining.delete(best);
  cache.picked.push(best);
  cache.hexes.push(toHex(best));
}

/** `index`번째 계정의 색. 같은 자리·같은 테마면 항상 같은 색이다. */
export function usageSeriesColor(index: number, dark: boolean): string {
  const theme = dark ? "dark" : "light";
  let cache = caches.get(theme);
  if (!cache) {
    cache = createCache(LIGHTNESS_RANGE[theme]);
    caches.set(theme, cache);
  }
  const slot = ((index % USAGE_SERIES_LIMIT) + USAGE_SERIES_LIMIT) % USAGE_SERIES_LIMIT;
  while (cache.hexes.length <= slot && cache.remaining.size > 0) pickNext(cache);
  return cache.hexes[slot] ?? cache.hexes[0];
}
