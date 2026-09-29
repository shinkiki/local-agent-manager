/**
 * 바이트 한 덩이를 사람이 고른 자리에 저장하는 통로 — 이름 다듬기, 저장 대화상자,
 * 그리고 데스크톱·브라우저 두 셸 갈래.
 *
 * 이 갈래는 `ipcLinkedFile.ts`가 들고 있었다. 그쪽은 "링크가 가리키는 파일을 백엔드에서
 * 받아 온다"는 일이라 엔드포인트·요청 봉투·Content-Disposition 되짚기를 함께 가지는데,
 * 저장 갈래는 바이트를 **어디서 얻었는지와 무관**하다. 실제로 다이어그램 내보내기
 * (`diagramImage.ts`)는 백엔드를 전혀 부르지 않으면서도 `ipcLinkedFile`에서
 * `saveBlobAsFile`을 가져다 쓰고 있었다 — 화면에서 만든 그림을 저장하려고 "첨부 내려받기"
 * 모듈에 의존하는 모양이라, 저장 규칙을 고치려면 링크 다운로드 통로부터 읽어야 했다.
 *
 * 두 일이 바뀌는 이유도 다르다. 저쪽은 새 다운로드 입구가 늘 때, 이쪽은 셸이 늘거나
 * 파일 이름 규칙이 바뀔 때다. 갈래만 여기 한 벌 두고, 바이트를 어떻게 구하는지는 부르는
 * 쪽이 계속 정한다.
 */
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { hasNativeShell } from "./backend";

/** 경로 구분자·NUL을 걷어낸 파일 이름. 이름이 남지 않으면 `download`으로 떨어진다. */
export function sanitizeDownloadName(name: string): string {
  const safe = name.replace(/[\\/\0]/g, "_").trim();
  return safe && safe !== "." && safe !== ".." ? safe : "download";
}

/**
 * 저장 대화상자로 목적지를 정한다. 취소하면 null이고, 부르는 쪽은 아무것도 하지 않는다.
 *
 * 네이티브 저장 갈래는 둘이다 — 바이트를 이미 손에 쥔 쪽과 Rust가 곧장 복사하는 쪽.
 * 둘 다 "이름을 다듬어 기본값으로 걸고, 고른 경로와 다듬은 이름을 함께 쓴다"는 같은
 * 순서를 각자 적고 있었다. 한쪽만 이름 다듬기를 고치면 대화상자에 뜨는 기본 이름과
 * 실제로 기록되는 이름이 갈라지므로, 그 순서는 여기 한 벌만 둔다.
 */
export async function chooseDownloadDestination(
  fileName: string,
  title: string,
): Promise<{ destination: string; safeName: string } | null> {
  const safeName = sanitizeDownloadName(fileName);
  const destination = await saveDialog({ title, defaultPath: safeName });
  return destination ? { destination, safeName } : null;
}

/**
 * 데스크톱 저장. 사용자가 대화상자에서 고른 절대 경로에만 쓰고, 경로·심볼릭 링크 검증은
 * Rust Core가 한다(`save_linked_file_download`). 취소하면 아무것도 하지 않고 false.
 *
 * 셸 갈래를 고르는 일은 `saveBlobAsFile`만 한다. 이 함수와 브라우저 쪽 짝은 그 갈래의
 * 양쪽 끝이라 모듈 밖으로 나가지 않는다 — 바깥에서 한쪽만 골라 부르면 그 자리에 셸 판정이
 * 한 벌 더 생긴다.
 */
async function saveBytesToChosenPath(bytes: Uint8Array, fileName: string, title: string): Promise<boolean> {
  const chosen = await chooseDownloadDestination(fileName, title);
  if (!chosen) return false;
  const { destination, safeName } = chosen;
  await invoke<void>("save_downloaded_linked_file", bytes, {
    headers: {
      "x-destination": encodeURIComponent(destination),
      "x-relative-path": encodeURIComponent(safeName),
    },
  });
  return true;
}

/** 브라우저 저장. 셸에 파일 대화상자가 없으므로 Blob 앵커로 내려준다. */
function downloadBlobAsFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = sanitizeDownloadName(fileName);
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * 셸에 맞는 저장 갈래를 고른다. 데스크톱은 대화상자, 브라우저는 다운로드.
 *
 * 링크 파일 다운로드도 화면에서 만든 그림 내보내기도 이 함수를 지난다. 바이트를 어디서
 * 얻었는지는 이 갈래와 무관하고, 갈래가 두 벌 있으면 한쪽만 셸 판정을 고치는 자리가 생긴다.
 */
export async function saveBlobAsFile(blob: Blob, fileName: string, title: string): Promise<void> {
  if (hasNativeShell()) {
    await saveBytesToChosenPath(new Uint8Array(await blob.arrayBuffer()), fileName, title);
    return;
  }
  downloadBlobAsFile(blob, fileName);
}
