import { useEffect, useMemo } from "react";
import { readStashedDiagram } from "../lib/diagramPopout";
import { useI18n } from "../lib/i18n";
import { usePopoutWindowTitle } from "../lib/popoutWindow";
import { DiagramViewer } from "./DiagramViewer";
import { ErrorBanner } from "./Shared";

/**
 * 다이어그램 전용 창. 앱 셸(사이드바·폴링·백엔드 연결) 없이 이 화면만 뜬다 — 그림을 그리는
 * 데 백엔드가 필요 없고, 창마다 백엔드 연결을 하나씩 더 만들 이유도 없다. 그래서 이 창은
 * `main.tsx`가 App보다 먼저 갈라 띄운다.
 *
 * 원문은 창을 연 화면이 같은 origin의 저장소에 두고 간다(`diagramPopout`). 새로고침해도
 * 저장소에 남아 있어 그림이 그대로 돌아온다.
 */
export function DiagramWindow({ id }: { id: string }) {
  const { text, setLocale } = useI18n();
  const stashed = useMemo(() => readStashedDiagram(window.localStorage, id), [id]);
  usePopoutWindowTitle(text("다이어그램", "Diagram"));

  // 창을 연 화면의 언어를 물려받는다. 이 창은 백엔드를 부르지 않아 설정을 읽을 수 없다.
  useEffect(() => {
    if (stashed) setLocale(stashed.locale);
  }, [setLocale, stashed]);

  return (
    <div className="diagram-window">
      {stashed
        ? <DiagramViewer source={stashed.source} fileName={`diagram-${id}`} />
        : <ErrorBanner message={text(
          "이 창에서 그릴 다이어그램을 찾지 못했습니다. 본 화면에서 다시 열어 주세요.",
          "No diagram was found for this window. Open it again from the main window.",
        )} />}
    </div>
  );
}
