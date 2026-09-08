import { Blocks, LoaderCircle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getClaudeSettingsStates, getProjectRegistry, getWebAccessStatus, setClaudePluginEnabled, type WebAccessStatus } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { ClaudePluginState, ClaudeSettingsSnapshot, ClaudeSettingsWriteScope, ProjectRegistryEntry } from "../types";
import { AppToggle, ErrorBanner } from "./Shared";
import { errorText } from "../lib/errorText";

/**
 * Claude Code 자체 플러그인 설치본과 `enabledPlugins`를 관리한다. Agent Manager가
 * 연결하는 외부 MCP 플러그인 카드와 저장소·수명주기가 다르므로 별도 카드로 둔다.
 */
export function ClaudePluginsCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const [snapshot, setSnapshot] = useState<ClaudeSettingsSnapshot | null>(null);
  const [projects, setProjects] = useState<ProjectRegistryEntry[]>([]);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [access, setAccess] = useState<WebAccessStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const canWrite = access?.writable === true;
  const scope: ClaudeSettingsWriteScope = projectPath ? "project" : "user";

  const load = useCallback(async (selectedProject = projectPath) => {
    try {
      const next = await getClaudeSettingsStates(selectedProject);
      setSnapshot(next);
      setError(null);
      return next;
    } catch (cause) {
      setError(errorText(cause));
      return null;
    }
  }, [projectPath]);

  useEffect(() => {
    if (!active) { loadedRef.current = false; return; }
    if (loadedRef.current) return;
    loadedRef.current = true;
    void Promise.all([
      load(null),
      getProjectRegistry().then((entries) => setProjects(entries.filter((entry) => entry.active && entry.exists))),
      getWebAccessStatus().then(setAccess),
    ]).catch((cause: unknown) => setError(errorText(cause)));
  }, [active, load]);

  const scopeError = useMemo(() => {
    if (!snapshot) return null;
    return (projectPath ? snapshot.scopes.local : snapshot.scopes.user)?.parseError ?? null;
  }, [projectPath, snapshot]);

  const changeProject = (next: string) => {
    const path = next || null;
    setProjectPath(path);
    setSnapshot(null);
    void load(path);
  };

  const run = async (key: string, action: () => Promise<ClaudeSettingsSnapshot>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      setSnapshot(await action());
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const explicitValue = (plugin: ClaudePluginState) => scope === "user"
    ? plugin.values.user
    : plugin.values.local;

  return (
    <section className="settings-card claude-plugins-card" data-ui-anchor="addons.claude-plugins-content">
      <header className="plugin-page-header">
        <div className="plugin-page-title">
          <i><Blocks size={18} aria-hidden="true" /></i>
          <div><span>CLAUDE CODE</span><h2>{text("Claude Code 플러그인", "Claude Code plugins")}</h2></div>
        </div>
        <p>{text(
          "Claude Code에 설치된 플러그인을 켜거나 끕니다. 플러그인을 끄면 그 플러그인에 포함된 스킬도 모두 꺼집니다.",
          "Enable or disable plugins installed in Claude Code. Disabling a plugin also disables every skill it contains.",
        )}</p>
      </header>
      <div className="claude-plugin-scopebar">
        <label>
          <span>{text("적용 범위", "Scope")}</span>
          <select value={projectPath ?? ""} disabled={busy !== null} onChange={(event) => changeProject(event.target.value)}>
            <option value="">{text("전역", "Global")}</option>
            {projects.map((project) => <option value={project.path} key={project.path}>{text(`프로젝트 · ${project.name}`, `Project · ${project.name}`)}</option>)}
          </select>
        </label>
        <small>{projectPath
          ? text("프로젝트 전용 settings.local.json에 저장합니다.", "Saved to the project's settings.local.json.")
          : text("사용자 전역 settings.json에 저장합니다.", "Saved to the user settings.json.")}</small>
      </div>
      {error && <ErrorBanner message={error} />}
      {scopeError && <ErrorBanner message={text(`설정 파일을 읽지 못했습니다: ${scopeError}`, `Could not read a settings file: ${scopeError}`)} />}
      {snapshot === null
        ? <div className="plugin-loading-state"><LoaderCircle size={16} className="spin" /><span>{text("Claude Code 플러그인을 확인하는 중…", "Checking Claude Code plugins…")}</span></div>
        : snapshot.plugins.length === 0
          ? <div className="plugin-empty-state"><i><Blocks size={25} /></i><div><strong>{text("설치된 플러그인이 없습니다", "No plugins installed")}</strong><small>{text("Claude Code 플러그인 설치 레지스트리에서 확인된 항목이 없습니다.", "No entries were found in the Claude Code plugin registry.")}</small></div></div>
          : <div className="plugin-list">
            {snapshot.plugins.map((plugin) => {
              const rowBusy = busy === plugin.pluginId;
              const inherited = explicitValue(plugin) === undefined;
              const overridden = projectPath !== null && (plugin.decidedBy === "project" || plugin.decidedBy === "local");
              return (
                <div className={`plugin-row${plugin.effectiveEnabled ? "" : " plugin-off"}`} key={plugin.pluginId}>
                  <i><Blocks size={17} /></i>
                  <div className="plugin-row-main">
                    <div className="plugin-row-name"><strong>{plugin.name}</strong><code>{plugin.pluginId}</code></div>
                    <small>{plugin.marketplace || text("마켓플레이스 미상", "Unknown marketplace")}{plugin.version ? ` · v${plugin.version}` : ""} · {text(`스킬 ${plugin.skillCount}개`, `${plugin.skillCount} skills`)}</small>
                    <div className="claude-plugin-badges">
                      <span className={`plugin-status ${plugin.effectiveEnabled ? "ok" : "muted"}`}><i />{plugin.effectiveEnabled ? text("사용", "Enabled") : text("사용 안 함", "Disabled")}</span>
                      {inherited && <em>{text("상속", "Inherited")}</em>}
                      {overridden && <em>{text("프로젝트 설정 우선", "Project override")}</em>}
                      {plugin.locked && <em className="locked">{text("사용자 지정·정책 잠금", "Custom or policy locked")}</em>}
                    </div>
                  </div>
                  <div className="plugin-row-actions">
                    {!inherited && <button className="button compact" type="button" disabled={!canWrite || rowBusy || plugin.locked} onClick={() => void run(plugin.pluginId, () => setClaudePluginEnabled({ pluginId: plugin.pluginId, scope, projectPath, enabled: null }))}><RotateCcw size={13} />{text("상속", "Inherit")}</button>}
                    <AppToggle checked={plugin.effectiveEnabled} disabled={!canWrite || rowBusy || plugin.locked || Boolean(scopeError)} label={text(`${plugin.name} 사용`, `${plugin.name} enabled`)} onChange={(enabled) => void run(plugin.pluginId, () => setClaudePluginEnabled({ pluginId: plugin.pluginId, scope, projectPath, enabled }))} />
                  </div>
                </div>
              );
            })}
          </div>}
      <p className="claude-plugin-reload-note">{text(
        "실행 중인 Claude Code 세션에는 /reload-plugins 또는 재시작 후 반영됩니다.",
        "Running Claude Code sessions pick up changes after /reload-plugins or a restart.",
      )}</p>
    </section>
  );
}
