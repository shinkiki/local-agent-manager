/**
 * 정적 UI 카탈로그에 실어 보낼 수 있는 문구인지.
 *
 * 되짚기(`staticUiText`)와는 서로 읽을 것이 없다. 저쪽은 이미 화면에 그려진 값을 받아
 * 한국어 원문으로 되돌리는 일이고, 여기는 아직 보내지 않은 문구 하나가 백엔드의 수용
 * 한계를 지키는지만 본다. 답이 달라지는 이유도 겹치지 않는다 — 저쪽은 역방향 표의 출처가,
 * 여기는 백엔드 `translation.rs`의 검증 규칙이 바뀔 때 달라진다.
 *
 * 백엔드가 카탈로그 문구 하나를 512**바이트**까지만 받고(`validate_ui_catalog`:
 * `key.len() > 512`, `char::is_control`), 제어 문자가 든 문구도 거절한다. 프런트 수집은
 * 500**자**로 잘라 왔는데 한글은 한 자가 3바이트라 170자를 넘는 문단 하나, 또는 줄바꿈이
 * 든 `text()` 키 하나만 렌더돼 있어도 카탈로그 전체가 거절되고 UI 언어를 아예 바꿀 수
 * 없었다(QA #18·#21). 그런 문구는 컴포넌트가 `text()`로 자기 번역을 이미 들고 있어
 * 카탈로그에 실을 이유가 없으므로 여기서 걸러 낸다. 백엔드와 같은 단위(UTF-8 바이트·
 * Unicode Cc)로 재야 한쪽만 통과하는 문구가 생기지 않는다.
 */

const MAX_UI_CATALOG_SOURCE_BYTES = 512;
const uiCatalogEncoder = new TextEncoder();

export function sendableUiCatalogSource(source: string): boolean {
  return source.trim().length > 0
    && !/\p{Cc}/u.test(source)
    && uiCatalogEncoder.encode(source).length <= MAX_UI_CATALOG_SOURCE_BYTES;
}
