/**
 * 화면 안내가 가리킬 요소를 기다린다. 화면은 lazy 로드되고 비활성 화면은 언마운트가 아니라
 * `hidden`으로 숨겨지므로, 요소가 DOM에 있는 것만으로는 부족하고 실제로 크기를 가져야 한다.
 * 탭 전환처럼 다음 커밋에야 나타나는 요소까지 한 루프로 덮기 위해 프레임마다 다시 본다.
 */
import { isElementVisible } from "./uiElements.ts";

export interface VisibleElementProbe {
  query(selector: string): Element | null;
  isVisible(element: Element): boolean;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  now(): number;
}

const browserProbe: VisibleElementProbe = {
  query: (selector) => document.querySelector(selector),
  isVisible: isElementVisible,
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  now: () => performance.now(),
};

export function waitForVisibleElement(
  selector: string,
  timeoutMs = 3000,
  probe: VisibleElementProbe = browserProbe,
): Promise<Element | null> {
  return new Promise((resolve) => {
    const startedAt = probe.now();
    const check = () => {
      const element = probe.query(selector);
      if (element && probe.isVisible(element)) {
        resolve(element);
        return;
      }
      if (probe.now() - startedAt >= timeoutMs) {
        resolve(null);
        return;
      }
      probe.requestFrame(check);
    };
    check();
  });
}
