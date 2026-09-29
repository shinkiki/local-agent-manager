import { useEffect, useRef, useState, type ReactNode } from "react";
import { getTranslatedDetail } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/errorText";
import type { TranslatedDetail, TranslationMenu, TranslationSummary } from "../types";
import { ErrorBanner, LoadingState } from "./Shared";

/**
 * 상세 서랍 네 곳(스킬보관함·설치된 스킬·에이전트·산출물)이 함께 쓰는 조각들.
 *
 * 원래는 스킬관리 패널 안에 있었고 나머지 세 화면이 그 패널에서 가져다 썼다. 화면 하나가
 * 다른 화면들의 공용 부품 창고를 겸하면 스킬관리와 무관한 화면이 스킬 라이브러리 모듈
 * 전체를 끌고 오게 되고, 부품을 고칠 때 어디까지가 스킬 화면의 사정인지도 흐려진다.
 * 서랍이라는 하나의 관심사만 담아 여기로 가른다.
 */

/**
 * 드로어가 고른 자원의 원문 상세와 번역 상세를 함께 읽는 비동기 수명주기. 스킬·에이전트·
 * 아티팩트 세 드로어가 같은 골격(둘을 한 번에 받아오고, 고른 대상이 바뀌거나 드로어가 닫힌
 * 뒤 늦게 도착한 응답은 버리고, 실패는 한 줄 오류로 남긴다)을 각자 펼쳐 놓고 있었다.
 * 자원마다 다른 것은 "원문을 무엇으로 읽는가"(`load`)와 "번역 레코드를 무엇으로
 * 찾는가"(`menu`·`resourceId`)뿐이라 그 둘만 받고 나머지는 한 벌로 둔다.
 *
 * `load`는 렌더마다 새 신원으로 오는 클로저라 의존성에 넣으면 매 렌더가 재요청이 된다.
 * 그래서 다시 읽을 시점은 열쇠로만 정하고, 실행할 때 ref로 최신 클로저를 읽는다. 번역 ID와
 * 원문 열쇠가 다른 자원(에이전트는 번역이 경로, 원문이 이름)만 `detailKey`를 따로 준다.
 */
export function useDrawerDetail<D>({ menu, resourceId, detailKey, translated, translationRevision, load }: {
  menu: TranslationMenu;
  resourceId: string;
  /** 원문 요청이 달라지는 지점. 생략하면 `resourceId`를 그대로 쓴다. */
  detailKey?: string;
  translated: TranslationSummary | undefined;
  translationRevision: number;
  load: () => Promise<D>;
}): { detail: D | null; translatedDetail: TranslatedDetail | null; error: string | null } {
  const [detail, setDetail] = useState<D | null>(null);
  const [translatedDetail, setTranslatedDetail] = useState<TranslatedDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const key = detailKey ?? resourceId;
  useEffect(() => {
    let active = true;
    Promise.all([
      loadRef.current(),
      translated ? getTranslatedDetail(menu, resourceId) : Promise.resolve(null),
    ])
      .then(([value, translatedValue]) => { if (active) { setDetail(value); setTranslatedDetail(translatedValue); } })
      .catch((cause: unknown) => active && setError(errorText(cause)));
    return () => { active = false; };
  }, [menu, resourceId, key, translated, translationRevision]);
  return { detail, translatedDetail, error };
}

/**
 * 상세 서랍 본문의 적재 관문. 오류 배너 → 적재 표시 → 본문 순서를 스킬·에이전트·아티팩트
 * 세 서랍이 각자 같은 삼항으로 적어 두는 바람에 "오류가 뜬 뒤에는 적재 표시를 접는다" 같은
 * 세부가 서랍마다 어긋날 수 있었다. 본문은 상세가 실제로 온 뒤에만 그리므로 렌더 프롭으로
 * 받아 `null`이 아닌 상세를 넘긴다.
 */
export function DrawerBody<D>({ detail, error, loadingLabel, children }: {
  detail: D | null;
  error: string | null;
  loadingLabel: string;
  children: (detail: D) => ReactNode;
}) {
  return (
    <>
      {error && <ErrorBanner message={error} />}
      {!detail && !error ? <LoadingState label={loadingLabel} /> : detail && children(detail)}
    </>
  );
}

/**
 * 번역본을 보여 주는 자리에 붙는 "원문 보기" 접기. 다섯 자리가 같은 마크업과 같은 문구를
 * 각자 적고 있어 한쪽만 고치면 표기가 갈렸다. 서랍 안에서는 상세 카드 한 장으로 서고
 * (`card`), 이미 카드 안에 들어가 있는 자리는 접기만 남긴다.
 */
export function OriginalContent({ card = false, children }: { card?: boolean; children: ReactNode }) {
  const { text } = useI18n();
  return (
    <details className={card ? "detail-card original-content" : "original-content"}>
      <summary>{text("원문 보기", "View original")}</summary>
      {children}
    </details>
  );
}

/**
 * 서랍 상세의 "이름 - 값" 한 줄. 스킬보관함·설치된 스킬·에이전트·산출물 네 서랍이 같은
 * 마크업을 `Info`라는 같은 이름으로 각자 들고 있었고, 값 표기만 서랍마다 달랐다 —
 * 고정폭으로 쓸지, 잘린 값을 툴팁으로 마저 보여줄지, 사용자가 쓴 글이라 표시할지.
 * 네 벌로 두면 상세 줄의 마크업이 한쪽에서만 바뀐다. 표기 차이를 옵션으로 받아 한 벌로 둔다.
 *
 * `title` - 전체 값을 툴팁으로 단다. 경로·지문처럼 줄에서 잘리는 값에만 쓴다.
 * `userContent` - 사용자가 쓴 글임을 표시한다(`data-user-content`).
 */
export function DetailInfo({ label, value, mono = false, title = false, userContent = false }: {
  label: string;
  value: string;
  mono?: boolean;
  title?: boolean;
  userContent?: boolean;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={mono ? "mono" : undefined} title={title ? value : undefined} data-user-content={userContent || undefined}>{value}</strong>
    </div>
  );
}
