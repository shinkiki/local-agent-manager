/**
 * Esc로 닫히는 겹침 UI(드로워·모달·팝오버·메뉴)의 순서 관리. 각 컴포넌트가 저마다
 * window에 keydown을 걸면 드로워 위에 뜬 모달에서 Esc를 눌렀을 때 둘 다 닫히므로,
 * 떠 있는 겹을 한 스택에 모아 두고 Esc 한 번이 가장 위 한 겹만 닫게 한다.
 */

/** keydown에서 판단에 쓰는 값만 추린 형태. 테스트에서 DOM 없이 만들 수 있다. */
export type EscapeKeyState = {
  key: string;
  isComposing?: boolean;
  defaultPrevented?: boolean;
};

/**
 * 이 Esc가 겹침 UI를 닫는 신호인지 본다.
 * - `isComposing`: 한글 조합 중의 Esc는 조합 취소라 창을 닫을 신호가 아니다.
 * - `defaultPrevented`: 터미널(xterm)처럼 Esc를 직접 쓰는 위젯이 이미 소비했다.
 */
export function closesTopEscapeLayer(event: EscapeKeyState): boolean {
  return event.key === "Escape" && !event.isComposing && !event.defaultPrevented;
}

export type EscapeLayerStack = {
  /** 새 겹을 맨 위에 올리고, 내릴 때 쓸 함수를 돌려준다. 두 번 불러도 한 번만 내려간다. */
  push: (close: () => void) => () => void;
  /** 가장 위 겹의 닫기 함수. 떠 있는 겹이 없으면 null. */
  top: () => (() => void) | null;
  size: () => number;
};

export function createEscapeLayerStack(): EscapeLayerStack {
  const layers: Array<{ close: () => void }> = [];
  return {
    push(close) {
      const layer = { close };
      layers.push(layer);
      return () => {
        // 중간 겹이 먼저 닫히는 경우가 있으므로 위치를 찾아서 지운다.
        const index = layers.lastIndexOf(layer);
        if (index >= 0) layers.splice(index, 1);
      };
    },
    top: () => layers[layers.length - 1]?.close ?? null,
    size: () => layers.length,
  };
}
