import { useEffect, useState } from "react";
import { getIndexExclusions, type IndexExclusionReason, type IndexExclusions, type IndexSource } from "../lib/ipcIndex";
import { useI18n } from "../lib/i18n";
import { errorText } from "../lib/errorText";

export function indexExclusionLabel(reason: IndexExclusionReason, text: (ko: string, en: string) => string): string {
  switch (reason) {
    case "hiddenPath": return text("숨김 경로", "Hidden path");
    case "sensitivePath": return text("민감 경로", "Sensitive path");
    case "dependencyOrBuild": return text("의존성·빌드·잠금 파일", "Dependency, build or lock file");
    case "unsupportedType": return text("지원하지 않는 형식", "Unsupported type");
    case "symlink": return text("심볼릭 링크", "Symbolic link");
    case "nonRegular": return text("일반 파일 아님", "Not a regular file");
    case "tooLarge": return text("512KiB 초과", "Over 512 KiB");
    case "binary": return text("바이너리", "Binary");
    case "invalidUtf8": return text("UTF-8 형식 아님", "Not UTF-8");
    case "longLine": return text("한 줄이 4,000바이트 초과", "Line exceeds 4,000 bytes");
    case "credentials": return text("인증정보 패턴 감지", "Credential pattern detected");
    case "credentialLines": return text("인증정보 줄만 제외(파일은 색인, 줄 수)", "Credential lines removed (file indexed, line count)");
  }
}

export function IndexExclusionsPanel({ source, onClose }: { source: IndexSource; onClose: () => void }) {
  const { text } = useI18n();
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<IndexExclusions | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError("");
    void getIndexExclusions(source.id, offset).then((next) => { if (!cancelled) setResult(next); })
      .catch((cause) => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [source.id, source.indexedAt, offset]);
  return <section className="settings-subsection index-addon-exclusions" aria-label={text("색인 제외 사유", "Index exclusions")}>
    <header><div><strong>{text("색인 제외 사유", "Index exclusions")} · {source.name}</strong>
      <small>{text("마지막 색인에서 제외한 경로와 사유입니다. 폴더가 제외되면 그 안은 확인하지 않습니다. 파일 본문은 표시하지 않습니다.", "Paths and reasons from the last index refresh. Excluded folders are not traversed. File contents are not shown.")}</small>
    </div><button type="button" className="button compact" onClick={onClose}>{text("닫기", "Close")}</button></header>
    <div className="index-addon-body">
      {source.exclusionCounts?.length ? <p>{source.exclusionCounts.map((item) => `${indexExclusionLabel(item.reason, text)} ${item.count}`).join(" · ")}</p> : null}
      {error ? <p role="alert">{error}</p> : result === null ? <p role="status">{text("불러오는 중…", "Loading…")}</p> : <>
        {result.items.length === 0 ? <p>{text("제외 기록이 없습니다. 색인을 갱신하면 최신 사유를 확인할 수 있습니다.", "No exclusions recorded. Refresh the index to see current reasons.")}</p> : <table>
          <thead><tr><th scope="col">{text("상대 경로", "Relative path")}</th><th scope="col">{text("제외 사유", "Reason")}</th></tr></thead>
          <tbody>{result.items.map((item, index) => <tr key={`${item.relativePath}:${offset + index}`}><td><code>{item.relativePath}</code></td><td>{indexExclusionLabel(item.reason, text)}</td></tr>)}</tbody>
        </table>}
        <nav aria-label={text("제외 기록 페이지", "Exclusion pages")}>
          <button type="button" className="button compact" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>{text("이전", "Previous")}</button>
          <span>{result.total === 0 ? "0" : `${offset + 1}–${offset + result.items.length}`} / {result.total}</span>
          <button type="button" className="button compact" disabled={result.nextOffset === null} onClick={() => { if (result.nextOffset !== null) setOffset(result.nextOffset); }}>{text("다음", "Next")}</button>
        </nav>
      </>}
    </div>
  </section>;
}
