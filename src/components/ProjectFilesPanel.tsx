import { useEffect, useMemo, useState } from "react";
import { listProjectEntries, readProjectFile } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { DocumentEntry, ProjectFileView } from "../types";
import { DocumentTreePane, useRequestGeneration, type DocumentTreeSource } from "./DocumentTreePane";
import { ProjectFilePane } from "./ProjectFilePane";
import { EmptyState, ErrorBanner, LoadingState } from "./Shared";

/**
 * 프로젝트 화면의 파일 탭. 문서 화면의 트리 창(`DocumentTreePane`)을 그대로 쓰되 원천만
 * 프로젝트 목록 IPC로 바꾼다. 검색은 없다 — 프로젝트 파일 검색 IPC가 없고, 트리 창은
 * `search`가 없는 원천이면 검색 상자를 그리지 않는다.
 *
 * 부르는 쪽이 프로젝트 경로를 `key`로 주어 프로젝트를 바꾸면 통째로 다시 서므로, 여기서는
 * 선택된 파일과 그 본문만 들고 있다. 트리는 펼칠 때 읽으므로 `active`로 막지 않지만, 화면이
 * 숨어 있는 동안에는 파일 본문을 읽지 않는다 — 탭을 돌아왔을 때 마지막 선택을 그때 읽는다.
 */
export function ProjectFilesPanel({ projectPath, active }: { projectPath: string; active: boolean }) {
  const { text } = useI18n();
  const [selected, setSelected] = useState<DocumentEntry | null>(null);
  const [file, setFile] = useState<ProjectFileView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRequestGeneration();

  const source = useMemo<DocumentTreeSource>(() => ({
    key: projectPath,
    list: (parentPath, cursor, limit) => listProjectEntries({ projectPath, parentPath, cursor, limit }),
    label: text("프로젝트 파일", "Project files"),
  }), [projectPath, text]);

  const selectedPath = selected?.relativePath ?? null;
  useEffect(() => {
    if (!active || selectedPath === null) return;
    // 이미 그 파일을 들고 있으면 다시 읽지 않는다. 탭을 오갈 때마다 같은 본문을 다시
    // 받는 것을 막는다.
    if (file?.relativePath === selectedPath) return;
    const requestId = generation.open();
    setLoading(true);
    setError(null);
    void generation.latest(
      requestId,
      () => readProjectFile({ projectPath, relativePath: selectedPath }),
      {
        onResult: setFile,
        onError: setError,
        onSettled: () => setLoading(false),
      },
    );
  }, [active, file?.relativePath, generation, projectPath, selectedPath]);

  const onSelect = (entry: DocumentEntry) => {
    if (entry.relativePath === selectedPath) return;
    setSelected(entry);
    setFile(null);
    setError(null);
  };

  return (
    <div className="docs-layout project-files-layout">
      <aside className="docs-sidebar">
        <div className="doc-tree-panel">
          <DocumentTreePane source={source} selectedPath={selectedPath} onSelect={onSelect} />
        </div>
      </aside>
      <main className="doc-workspace">
        {error && <ErrorBanner message={error} />}
        {selected === null
          ? <EmptyState title={text("파일을 선택하세요", "Select a file")} detail={text("왼쪽 트리에서 파일을 고르면 읽기 전용으로 보여 줍니다.", "Pick a file in the tree to view it read-only.")} />
          : loading || (file === null && !error)
            ? <LoadingState label={text("파일을 읽고 있습니다", "Reading file")} />
            : file
              ? <ProjectFilePane file={file} />
              : null}
      </main>
    </div>
  );
}
