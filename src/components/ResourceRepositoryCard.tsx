import { Download, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, type UiText } from "../lib/i18n";
import { aiaRuntimeProvider } from "../lib/aiaRuntime";
import { errorText } from "../lib/errorText";
import { getResourceRepository, setResourceRepository } from "../lib/ipc";
import { repositoryTransferPrompt } from "../lib/skillTransfer";
import type { HostPlatform, ResourceRepositorySettings, SystemAutomationSnapshot } from "../types";
import { AiaMark, ErrorBanner, PathField, useBusyAction } from "./Shared";

/**
 * 스킬·지침 공통 저장소 위치 설정. 지침관리 화면에 있던 카드가 설정 → 라이브러리 탭을 거쳐
 * 저장소 화면의 라이브러리 탭으로 왔다 — 무엇이 어디에 쌓이는지 묻는 사람은 설정이 아니라
 * 저장소 화면을 열기 때문이다. 경로를 바꾸면 스킬·지침 목록이 새 경로를 다시 읽어야 하므로
 * `onChanged`로 알린다.
 */
export function ResourceRepositoryCard({ onChanged, automation, onRequestAiaPrompt }: {
  onChanged?: () => void;
  automation: SystemAutomationSnapshot | null;
  /** 저장소 백업·복구를 AIA 입력창에 위임한다. */
  onRequestAiaPrompt?: (prompt: string) => void;
}) {
  const { text } = useI18n();
  const aiaAvailable = Boolean(aiaRuntimeProvider(automation));
  const [repository, setRepository] = useState<ResourceRepositorySettings | null>(null);
  const [rootPath, setRootPath] = useState("");
  const [migrateExisting, setMigrateExisting] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy: busyKey, error, setError, run } = useBusyAction<"apply">();
  const busy = busyKey !== null;

  // 첫 조회가 실패하면 다시 부르는 길이 없어 '불러오는 중…'이 오류 배너와 함께 계속 남았다.
  // 실패를 상태로 두고, 그때는 '불러오는 중' 대신 다시 불러오기 버튼을 보인다.
  const [loadFailed, setLoadFailed] = useState(false);
  const mounted = useRef(true);
  // StrictMode는 개발 중 마운트를 한 번 해제했다 다시 하므로 다시 마운트될 때 true로 돌려 둔다.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const load = useCallback(() => {
    setLoadFailed(false);
    getResourceRepository()
      .then((settings) => {
        if (!mounted.current) return;
        setError(null);
        setRepository(settings);
        setRootPath(settings.rootPath);
      })
      .catch((cause: unknown) => {
        if (!mounted.current) return;
        setError(errorText(cause));
        setLoadFailed(true);
      });
  }, [setError]);
  useEffect(() => { load(); }, [load]);

  const apply = (useDefault: boolean) => run("apply", async () => {
    setNotice(null);
    const settings = await setResourceRepository({
      rootPath: useDefault ? null : rootPath.trim(),
      migrateExisting,
    });
    setRepository(settings);
    setRootPath(settings.rootPath);
    setNotice(useDefault
      ? text("기본 저장소 경로로 되돌렸습니다.", "Restored the default repository path.")
      : text("라이브러리 경로를 적용했습니다.", "Applied the library path."));
    onChanged?.();
  });

  return (
    <section className="settings-card">
      <header>
        <div>
          <span>{text("라이브러리", "Library")}</span>
          <h2>{text("스킬·프로젝트 지침 저장 위치", "Skill and project instruction storage")}</h2>
        </div>
        <p>{text(
          "스킬 원본과 프로젝트 지침 원본을 보관할 위치입니다. 클라우드 드라이브 폴더로 바꾸면 여러 기기에서 같은 원본을 씁니다.",
          "Where skill and project instruction sources are archived. Point it at a cloud-drive folder to share the same sources across devices.",
        )}</p>
      </header>
      <div className="settings-card-sections">
        <section className="settings-subsection">
          <header>
            <div>
              <strong>{text("현재 장치", "Current device")}</strong>
              <small>{repository ? platformLabel(repository.currentPlatform, text) : "-"}</small>
            </div>
            {repository && (
              <span className={`skill-sync-pill ${repository.custom ? "conflict" : "current"}`}>
                {repository.custom ? text("사용자 지정", "Custom") : text("앱 기본값", "App default")}
              </span>
            )}
          </header>
          {error && <ErrorBanner message={error} />}
          {!repository && loadFailed ? (
            <div className="form-actions">
              <button className="button" type="button" onClick={load}>
                {text("다시 불러오기", "Reload")}
              </button>
            </div>
          ) : !repository ? (
            <p className="settings-storage-note">{text("저장소 설정을 불러오는 중…", "Loading repository settings…")}</p>
          ) : (
            <div className="detail-card">
              <div className="form-row">
                <label htmlFor="resource-repository-path">{text("저장소 경로", "Repository path")}</label>
                <div data-ui-anchor="storage.repository-path">
                  <PathField
                    id="resource-repository-path"
                    value={rootPath}
                    onChange={setRootPath}
                    placeholder={repository.defaultRootPath}
                    disabled={busy}
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="resource-repository-default-path">{text("기본 경로", "Default path")}</label>
                <div>
                  <PathField id="resource-repository-default-path" value={repository.defaultRootPath} />
                </div>
              </div>
              <div className="form-row">
                <label>{text("하위 경로", "Managed folders")}</label>
                <div className="path-field-group">
                  <PathField value={repository.skillsPath} />
                  <PathField value={repository.instructionsPath} />
                </div>
              </div>
              <div className="form-row">
                <label>{text("이전", "Migration")}</label>
                <label className="check-filter">
                  <input
                    type="checkbox"
                    checked={migrateExisting}
                    onChange={(event) => setMigrateExisting(event.target.checked)}
                    disabled={busy}
                  />
                  {text("기존 스킬·지침 원본을 새 경로로 복사", "Copy existing skill and instruction sources to the new path")}
                </label>
              </div>
              <div className="form-actions">
                <button
                  className="button"
                  type="button"
                  disabled={busy || !repository.custom}
                  onClick={() => { void apply(true); }}
                >{text("기본 경로로 복귀", "Restore default")}</button>
                <button
                  className="button primary"
                  type="button"
                  disabled={busy || !rootPath.trim()}
                  onClick={() => { void apply(false); }}
                >{busy ? text("적용 중…", "Applying…") : text("적용", "Apply")}</button>
              </div>
              {notice && <p className="settings-storage-note" role="status">{notice}</p>}
            </div>
          )}
        </section>
        {onRequestAiaPrompt && (
          <section className="settings-subsection">
            <header>
              <div>
                <strong>{text("백업 및 복구", "Backup and restore")}</strong>
                <small>{text(
                  "스킬·지침 원본을 AIA로 백업하거나 복원합니다. 채팅·세션·계정 정보는 포함되지 않습니다.",
                  "Back up or restore skill and instruction sources with AIA. Chats, sessions, and account data are not included.",
                )}</small>
              </div>
              <div className="repository-transfer-buttons">
                <button
                  className="button"
                  type="button"
                  disabled={!aiaAvailable}
                  title={aiaAvailable
                    ? text("AIA에게 라이브러리 백업을 요청합니다", "Ask AIA to back up the library")
                    : text("연결된 시스템 에이전트를 설정하세요", "Configure a connected system agent")}
                  onClick={() => onRequestAiaPrompt(repositoryTransferPrompt("backup"))}
                ><Download size={15} aria-hidden="true" /><AiaMark size={14} />{text("백업", "Back up")}</button>
                <button
                  className="button"
                  type="button"
                  disabled={!aiaAvailable}
                  title={aiaAvailable
                    ? text("AIA에게 라이브러리 복구를 요청합니다", "Ask AIA to restore the library")
                    : text("연결된 시스템 에이전트를 설정하세요", "Configure a connected system agent")}
                  onClick={() => onRequestAiaPrompt(repositoryTransferPrompt("restore"))}
                ><Upload size={15} aria-hidden="true" /><AiaMark size={14} />{text("복구", "Restore")}</button>
              </div>
            </header>
          </section>
        )}
      </div>
    </section>
  );
}

function platformLabel(platform: HostPlatform, text: UiText): string {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  if (platform === "linux") return "Linux";
  return text("알 수 없음", "Unknown");
}
