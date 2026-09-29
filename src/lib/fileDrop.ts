/**
 * 놓인 항목에서 폴더를 가려낸다.
 *
 * 폴더를 놓으면 브라우저는 그것도 `DataTransfer.files`에 크기 0짜리 `File`로 실어 준다.
 * 파일만 보면 빈 파일과 구분되지 않아 "빈 파일은 첨부할 수 없습니다"라는, 원인이 보이지
 * 않는 안내가 떴다. 폴더인지는 드롭 시점의 `DataTransferItem.webkitGetAsEntry()`로만 알 수
 * 있으므로(파일 고르기·붙여넣기에는 이 정보가 없다) 여기서 한 번에 갈라 둔다.
 *
 * `webkitGetAsEntry`는 드롭 이벤트를 처리하는 동안에만 쓸 수 있다. 비동기로 미룬 뒤 부르면
 * 항목이 이미 비워져 null이 온다.
 */
interface DroppedItemsLike {
  kind: string;
  webkitGetAsEntry?: () => { isDirectory?: boolean; name?: string } | null;
}

interface DroppedFiles<F extends { name: string }> {
  files: F[];
  folderNames: string[];
}

/** 드롭 이벤트가 살아 있는 동안 브라우저 전용 entry에서 폴더 이름만 읽는다. */
function droppedFolderNames(items: Iterable<DroppedItemsLike>): string[] {
  const folderNames: string[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) folderNames.push(entry.name ?? "");
  }
  return folderNames;
}

/** 폴더로 확인된 이름과 같은 항목을 브라우저가 함께 준 파일 목록에서 걷어낸다. */
function withoutDroppedFolders<F extends { name: string }>(
  files: Iterable<F>,
  folderNames: readonly string[],
): F[] {
  const rejected = new Set(folderNames);
  return [...files].filter((file) => !rejected.has(file.name));
}

export function splitDroppedFolders<F extends { name: string }>(
  items: Iterable<DroppedItemsLike>,
  files: Iterable<F>,
): DroppedFiles<F> {
  const folderNames = droppedFolderNames(items);
  return { files: withoutDroppedFolders(files, folderNames), folderNames };
}

/** 폴더를 놓았을 때의 안내. 이름이 있으면 어느 것이 걸렸는지 함께 알린다. */
export function folderDropMessage(folderNames: string[]): string {
  const named = folderNames.filter((name) => name.length > 0);
  if (named.length === 1) return `${named[0]}: 폴더는 첨부할 수 없습니다. 안의 파일을 골라 주세요.`;
  return "폴더는 첨부할 수 없습니다. 안의 파일을 골라 주세요.";
}
