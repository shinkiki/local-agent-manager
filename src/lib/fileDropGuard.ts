/**
 * 첨부를 받는 자리 밖에 파일을 놓았을 때 웹뷰가 그 파일로 이동하는 것을 막는다.
 *
 * Tauri 창은 `dragDropEnabled: false`로 열린다 — 그래야 웹뷰가 OS 드롭을 가로채지 않고
 * 화면이 HTML 드래그 앤 드롭 이벤트를 받는다(tauri-runtime-wry의 기본 핸들러는 항상
 * true를 돌려주어 드롭을 통째로 삼킨다). 대신 처리되지 않은 드롭은 WKWebView 기본 동작으로
 * 넘어가고, 그 기본 동작은 놓은 파일로 문서를 갈아치우는 것이다. 실제로 대시보드에 파일을
 * 놓으면 앱 화면이 빈 문서로 바뀌어 다시 띄우기 전까지 돌아오지 않았다.
 *
 * 첨부 자리들은 이 리스너보다 먼저(버블 경로 위쪽에서) 이벤트를 받으므로 첨부 동작에는
 * 영향이 없다. 여기서는 남은 드롭의 기본 동작만 지운다 — 화면에 알리지는 않는다. 놓은
 * 자리가 첨부를 받지 않는다는 것은 안내가 뜨지 않는 것으로 이미 드러난다.
 */
function preventStrayFileDrop(event: DragEvent): void {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
}

export function guardStrayFileDrops(target: Pick<Window, "addEventListener"> = window): void {
  // dragover의 기본 동작을 지워야 drop 이벤트가 오고, drop의 기본 동작을 지워야 이동하지 않는다.
  // 파일이 아닌 드래그(글자 선택 등)는 그대로 둔다 — 입력창 사이의 글 옮기기가 막히면 안 된다.
  for (const type of ["dragover", "drop"] as const) {
    target.addEventListener(type, preventStrayFileDrop);
  }
}
