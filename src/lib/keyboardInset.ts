// 모바일 브라우저의 화면 키보드는 대개 레이아웃 뷰포트를 줄이지 않고 보이는 영역(visual viewport)만
// 덮는다. 이 앱은 html·body·#root를 height:100%로 깔고 채팅 입력창을 그 바닥에 붙이므로, 키보드가
// 올라오면 입력창이 화면 밖이 아니라 "키보드 뒤"에 남아 손댈 수 없게 된다. 여기서는 키보드가 가린
// 높이만 순수 계산으로 뽑아, 화면 쪽에서 그만큼 바닥 여백으로 돌려놓을 수 있게 한다.

export interface ViewportMetrics {
  /** 레이아웃 뷰포트 높이(window.innerHeight). */
  layoutHeight: number;
  /** 키보드·브라우저 크롬을 뺀 실제로 보이는 높이(visualViewport.height). */
  visualHeight: number;
  /** 보이는 영역이 레이아웃 위쪽에서 밀려난 양(visualViewport.offsetTop). */
  offsetTop: number;
  /** 확대 배율(visualViewport.scale). 1보다 크면 손가락 확대라 키보드와 무관하다. */
  scale?: number;
}

export interface KeyboardInsetOptions {
  /** 이 높이 아래는 키보드가 아니라 주소창·툴바가 먹은 높이로 본다. */
  minimum?: number;
}

/**
 * 키보드가 가린 높이를 px로 돌려준다. 브라우저 크롬 때문에 레이아웃과 보이는 높이는 키보드가 없어도
 * 수십 px 어긋나므로, 임계값 아래는 0으로 접어 평상시 화면이 흔들리지 않게 한다.
 */
export function keyboardInset(metrics: ViewportMetrics, options: KeyboardInsetOptions = {}): number {
  const minimum = options.minimum ?? 120;
  if ((metrics.scale ?? 1) > 1.02) return 0;
  const covered = metrics.layoutHeight - metrics.visualHeight - metrics.offsetTop;
  if (!Number.isFinite(covered) || covered < minimum) return 0;
  return Math.min(Math.round(covered), Math.max(Math.round(metrics.layoutHeight), 0));
}

/**
 * 화면 키보드가 가린 높이를 `--keyboard-inset` CSS 변수로 계속 반영한다. 키보드에 맞춰 레이아웃
 * 뷰포트를 줄여 주는 브라우저(viewport meta의 interactive-widget=resizes-content)에서는 잰 값이
 * 0이라 아무 일도 하지 않고, 줄여 주지 않는 브라우저에서만 실제로 여백이 붙는다.
 */
export function watchKeyboardInset(view: Window = window): () => void {
  const viewport = view.visualViewport;
  const target = view.document.documentElement;
  if (!viewport) return () => {};

  let applied = -1;
  const apply = () => {
    const next = keyboardInset({
      layoutHeight: view.innerHeight,
      visualHeight: viewport.height,
      offsetTop: viewport.offsetTop,
      scale: viewport.scale,
    });
    // 스크롤·리사이즈마다 불리므로 값이 그대로면 다시 쓰지 않는다.
    if (applied === next) return;
    applied = next;
    target.style.setProperty("--keyboard-inset", `${next}px`);
  };

  apply();
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  view.addEventListener("resize", apply);
  view.addEventListener("orientationchange", apply);
  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    view.removeEventListener("resize", apply);
    view.removeEventListener("orientationchange", apply);
    target.style.removeProperty("--keyboard-inset");
  };
}
