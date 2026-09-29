import { useMemo } from "react";
import { degradedScanMessages } from "../lib/catalogHealth";
import { useI18n } from "../lib/i18n";
import type { CatalogHealth, CatalogScanKind } from "../types";

/**
 * "이 목록은 일부 경로를 빼고 만든 것"이라는 안내 한 줄.
 *
 * 응답하지 않는 루트(네트워크 드라이브, 권한 없는 폴더)를 스캔이 건너뛰면 목록은 그 경로의
 * 항목을 빼고 완성된다. 그 사실을 화면이 적지 않으면 사용자는 "정의가 없다"·"산출물이
 * 없다"로 읽는다 — 빈 상태 안내가 탐지 경로만 말하므로 오독을 거든다.
 *
 * 스킬정보 화면만 이 배너를 갖고 있었고, 백엔드가 `agents`·`artifacts` 종류를 실제로 만들어
 * 내려주는데도 받는 화면이 없었다(QA #96). 세 화면이 같은 모양을 쓰도록 여기 한 벌만 둔다.
 * 건너뛴 경로가 없으면 아무것도 그리지 않는다.
 */
export function CatalogHealthBanner({ health, kind }: { health: CatalogHealth | null; kind: CatalogScanKind }) {
  const { text } = useI18n();
  const skippedRoots = useMemo(() => degradedScanMessages(health, kind), [health, kind]);
  if (skippedRoots.length === 0) return null;
  return (
    <div className="catalog-health-banner" role="status">
      <div>
        <strong>{text("일부 경로를 건너뛴 목록입니다", "Some paths were skipped")}</strong>
        <small>{skippedRoots.join(" · ")}</small>
      </div>
    </div>
  );
}
