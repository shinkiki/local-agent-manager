import { openUrl } from "@tauri-apps/plugin-opener";
import { hasNativeShell } from "./backend";

/**
 * 앱 밖의 주소를 셸에 맞게 연다. 네이티브에서는 OS 기본 브라우저로 넘기고, 원격 웹에서는
 * 새 탭으로 연다 — 웹뷰가 그 주소로 **이동해 버리면 앱 화면이 사라진다.**
 *
 * 터미널의 링크와 플러그인 안내 링크가 같은 함수를 각자 한 벌씩 들고 있었다. 이제 다이어그램의
 * 링크까지 세 번째 호출부가 생기므로, 규칙(허용 스킴·셸 분기·팝업 반환값 해석)은 여기 한 벌만 둔다.
 *
 * http(s)만 받는다. 나머지 스킴은 문서·다이어그램 원문이 만들 수 있는 값이라, 무엇을 여는지
 * 사용자가 예측할 수 없는 자리로 넘기지 않는다.
 */
export async function openExternalUrl(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`지원하지 않는 주소 형식입니다: ${url.protocol}`);
  }
  if (hasNativeShell()) {
    await openUrl(url.href);
    return;
  }
  // 모바일 브라우저는 정상적으로 열린 noopener 탭에도 null을 돌려준다. 그 반환값을
  // 팝업 차단의 증거로 쓰면 안 된다.
  window.open(url.href, "_blank", "noopener,noreferrer");
}
