/**
 * 진행 중인 파일 저장의 현황판. 데스크톱 셸에서 문서 파일을 내려받을 때 바이트는
 * 웹뷰를 지나지 않고 Rust가 곧장 목적지로 이어 복사한다(`file_download.rs`). 그래서
 * 화면이 진행을 알 수 있는 길은 Rust가 올려 보내는 보고뿐이고, 그 보고를 받는 자리
 * (`ipcLinkedFile`)와 그리는 자리(`FileDownloadProgress`)가 서로를 모른다.
 *
 * 둘 사이에 컴포넌트 트리를 두지 않은 이유는 내려받기를 시작하는 자리가 문서 화면
 * 하나가 아니기 때문이다. 문서 파일, 문서 안 링크가 각자의 화면에서 시작하므로
 * 현황은 화면 밖 한 곳에 모아 두고, 그리는 쪽은 앱 껍데기에서 한 번만 구독한다.
 */

export interface FileDownloadActivity {
  id: string;
  fileName: string;
  copiedBytes: number;
  /** Rust가 첫 보고를 올리기 전에는 0이다. 그동안은 비율을 그리지 않는다. */
  totalBytes: number;
  /** 취소를 이미 요청했고 아직 멈추지 않은 상태. 같은 요청을 두 번 보내지 않는다. */
  cancelling: boolean;
}

type Listener = (activities: FileDownloadActivity[]) => void;

let activities: FileDownloadActivity[] = [];
const listeners = new Set<Listener>();

function publish(next: FileDownloadActivity[]): void {
  activities = next;
  for (const listener of listeners) listener(activities);
}

/** 현재 목록. 값이 바뀌지 않으면 같은 배열을 돌려준다(`useSyncExternalStore` 규약). */
export function fileDownloadActivities(): FileDownloadActivity[] {
  return activities;
}

export function subscribeFileDownloads(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 이 id를 뺀 목록. 시작(같은 id의 앞선 저장을 밀어낸다)과 종료가 같은 규칙을 쓴다. */
function withoutActivity(id: string): FileDownloadActivity[] {
  return activities.filter((activity) => activity.id !== id);
}

/**
 * 진행 중인 저장 하나의 값만 고쳐 쓴다.
 *
 * 목록에 없는 id는 아무것도 하지 않는다 — 이미 끝난 저장의 늦은 보고는 되살리지 않아야
 * 하고(채널 메시지는 명령이 반환된 뒤에도 한 박자 늦게 도착한다), 내용이 그대로인데도
 * 새 배열을 올리면 `useSyncExternalStore`가 매번 바뀐 것으로 본다. 진행 보고와 취소 표시가
 * 각자 목록을 훑고 있어 그 판정이 한쪽(진행 보고)에만 있었다.
 */
function changeActivity(id: string, change: (activity: FileDownloadActivity) => FileDownloadActivity): void {
  let found = false;
  const next = activities.map((activity) => {
    if (activity.id !== id) return activity;
    found = true;
    return change(activity);
  });
  if (found) publish(next);
}

export function startFileDownload(id: string, fileName: string): void {
  publish([
    ...withoutActivity(id),
    { id, fileName, copiedBytes: 0, totalBytes: 0, cancelling: false },
  ]);
}

export function updateFileDownload(id: string, copiedBytes: number, totalBytes: number): void {
  changeActivity(id, (activity) => ({ ...activity, copiedBytes, totalBytes }));
}

export function markFileDownloadCancelling(id: string): void {
  changeActivity(id, (activity) => ({ ...activity, cancelling: true }));
}

export function finishFileDownload(id: string): void {
  const next = withoutActivity(id);
  if (next.length !== activities.length) publish(next);
}

/** 0~1 사이의 진행 비율. 총량을 아직 모르면 null이고, 화면은 그때 비율을 그리지 않는다. */
export function fileDownloadRatio(activity: FileDownloadActivity): number | null {
  if (activity.totalBytes <= 0) return null;
  return Math.min(1, activity.copiedBytes / activity.totalBytes);
}
