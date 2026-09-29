import { useSyncExternalStore } from "react";
import { X } from "lucide-react";
import {
  fileDownloadActivities,
  fileDownloadRatio,
  subscribeFileDownloads,
  type FileDownloadActivity,
} from "../lib/fileDownloads";
import { formatBytes } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { cancelFileDownload } from "../lib/ipc";

/**
 * 진행 중인 파일 저장을 한곳에 모아 그린다. 데스크톱 셸에서 문서 파일을 내려받으면
 * 바이트가 Rust에서 곧장 목적지로 흐르므로, 화면에는 버튼이 잠깐 잠기는 것 말고는
 * 아무 일도 일어나지 않는다 — 수 GB짜리 파일이면 그 "잠깐"이 몇 분이라, 무엇이
 * 얼마나 남았는지와 멈출 방법이 없으면 앱이 멈춘 것과 구별되지 않는다.
 *
 * 앱 껍데기에서 한 번만 그린다. 저장을 시작하는 자리(문서 파일, 문서 안 링크)는
 * 여럿이고 화면을 옮겨도 저장은 계속되므로, 시작한 화면에 붙여 두면 그 화면을
 * 떠나는 순간 진행이 사라진다.
 */
export function FileDownloadProgress() {
  const { text } = useI18n();
  const activities = useSyncExternalStore(
    subscribeFileDownloads,
    fileDownloadActivities,
    fileDownloadActivities,
  );
  if (activities.length === 0) return null;

  return (
    <div className="file-download-progress" role="status" aria-live="polite">
      {activities.map((activity) => (
        <FileDownloadRow key={activity.id} activity={activity} />
      ))}
    </div>
  );

  function FileDownloadRow({ activity }: { activity: FileDownloadActivity }) {
    const ratio = fileDownloadRatio(activity);
    const cancelLabel = text("저장 취소", "Cancel download");
    return (
      <div className="file-download-item">
        <div className="file-download-head">
          <strong title={activity.fileName}>{activity.fileName}</strong>
          <button
            className="icon-button compact"
            type="button"
            disabled={activity.cancelling}
            onClick={() => { void cancelFileDownload(activity.id); }}
            aria-label={cancelLabel}
            title={cancelLabel}
          >
            <X size={13} />
          </button>
        </div>
        <div className="progress">
          <span style={ratio === null ? undefined : { width: `${Math.round(ratio * 100)}%` }} />
        </div>
        <small>
          {activity.cancelling
            ? text("저장을 멈추는 중…", "Stopping…")
            : ratio === null
              ? text("저장하는 중…", "Saving…")
              : `${formatBytes(activity.copiedBytes)} / ${formatBytes(activity.totalBytes)} · ${Math.round(ratio * 100)}%`}
        </small>
      </div>
    );
  }
}
