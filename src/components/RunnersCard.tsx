import { FolderGit2, LoaderCircle, Network, Plus, PlugZap, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PropsWithChildren } from "react";
import {
  addRunnerProject,
  checkRunner,
  deleteRunner,
  deleteRunnerProject,
  listRunners,
  saveRunner,
  setRunnerEnabled,
  updateRunnerProject,
} from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { RunnerCheckReceipt, RunnerProject, RunnerSkipCode, RunnerSshServerOption, RunnersSnapshot, RunnerView } from "../types";
import { ErrorBanner, useBusyAction, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";
import { createLatestGate } from "../lib/latestRequest";
import { parseWholeNumber, wholeNumberWithin } from "../lib/runnerFields";

/** 백엔드 저장 형식(u32)의 끝. 브라우저 자리 상한이 이 값이면 상한이 없다는 뜻이다. */
const U32_MAX = 4_294_967_295;

interface RunnerDraft {
  id: string;
  serverId: string;
  /** 편집하던 실행기가 가리키던 서버가 지워졌는지. 그러면 서버를 다시 골라야 저장된다. */
  serverMissing: boolean;
  name: string;
  slots: string;
  browsers: string;
  enabled: boolean;
  note: string;
}

interface ProjectDraft {
  id: string;
  name: string;
  root: string;
  exclude: string;
}

/** 서버 이름이 없으면 접속 대상을 이름 대신 보인다. SSH 탭과 같은 규칙이다. */
function serverLabel(server: RunnerSshServerOption): string {
  const target = `${server.user ? `${server.user}@` : ""}${server.host}:${server.port}`;
  return server.name ? `${server.name} (${target})` : target;
}

/** 쉼표·줄바꿈으로 적은 제외 폴더를 이름 목록으로. 빈 칸은 버리고 검사는 백엔드가 한다. */
function excludeList(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter((item) => item.length > 0);
}

/** 편집기의 한 칸. 이름표와 보조 설명 자리가 모든 칸에서 같다. */
function Field({ label, hint, children }: PropsWithChildren<{ label: string; hint?: string | false }>) {
  return <label><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

/**
 * 외부 도구가 이 실행기를 쓰는지의 배지. 판정은 백엔드가 CLI 목록과 같은 함수로 내리고
 * (`skipCode`), 화면은 그 갈래에 맞는 문구와 색만 고른다. 자세한 사유는 툴팁으로 둔다.
 */
function RunnerStatusBadge({ code, reason }: { code: RunnerSkipCode | null; reason: string | null }) {
  const { text } = useI18n();
  if (code === null) return <span className="db-badge db-badge-dev">{text("회차가 씀", "Used by rounds")}</span>;
  const badge = (tone: string, label: string) => <span className={`db-badge${tone}`} title={reason ?? undefined}>{label}</span>;
  switch (code) {
    case "disabled": return badge("", text("꺼짐", "Off"));
    case "serverMissing": return badge(" db-badge-production", text("SSH 서버가 지워짐", "SSH server removed"));
    case "agentOff": return badge(" db-badge-staging", text("에이전트 사용이 꺼져 있어 회차가 쓰지 않음", "Agent use is off — rounds skip it"));
    case "keyUnavailable": return badge(" db-badge-staging", text("키를 쓸 수 없어 회차가 쓰지 않음", "Key unavailable — rounds skip it"));
    case "passphraseProtected": return badge(" db-badge-staging", text("암호 걸린 키라 회차가 쓰지 않음", "Passphrase-protected key — rounds skip it"));
    case "inventoryUnavailable": return badge(" db-badge-staging", text("SSH 키 목록을 읽지 못함", "Could not read SSH keys"));
    default: return badge(" db-badge-staging", reason ?? "");
  }
}

/** 목록의 실행기 한 줄. 상태 배지·접속 대상과 네 가지 동작이 여기서 끝난다. */
function RunnerRow({ runner, receipt, busy, onToggle, onCheck, onEdit, onRemove }: {
  runner: RunnerView;
  receipt: RunnerCheckReceipt | undefined;
  busy: string | null;
  onToggle: () => void;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { text } = useI18n();
  return (
    <article className="db-connection-row">
      <div className="db-connection-head">
        <strong>{runner.name}</strong>
        <span className="db-badge">{text(`${runner.slots}자리`, `${runner.slots} slots`)}</span>
        {(runner.browsers ?? 0) > 0 && <span className="db-badge">{text(`브라우저 ${runner.browsers}`, `${runner.browsers} browsers`)}</span>}
        <RunnerStatusBadge code={runner.skipCode} reason={runner.skipReason} />
      </div>
      <code className="db-connection-target">{runner.serverFound
        ? `${runner.user ? `${runner.user}@` : ""}${runner.host}:${runner.port}`
        : runner.serverId}</code>
      {runner.note && <small className="db-connection-meta">{runner.note}</small>}
      <div className="db-connection-actions">
        <label className="db-connection-toggle">
          <input type="checkbox" checked={runner.enabled} disabled={busy !== null} onChange={() => onToggle()} />
          <span>{text("사용", "Enabled")}</span>
        </label>
        <button className="button compact" type="button" disabled={busy !== null || !runner.serverFound} onClick={() => onCheck()}><PlugZap size={13} />{busy === `check:${runner.id}` ? text("확인 중…", "Checking…") : text("접속 확인", "Check")}</button>
        <button className="button compact" type="button" disabled={busy !== null} onClick={() => onEdit()}>{text("편집", "Edit")}</button>
        <button className="button compact danger" type="button" disabled={busy !== null} onClick={() => onRemove()}><Trash2 size={13} />{text("삭제", "Remove")}</button>
      </div>
      {receipt && (
        <p className={`db-connection-receipt${receipt.reachable ? " ok" : " failed"}`}>
          {receipt.reachable
            ? `${text("접속 성공", "Connected")} — ${receipt.destination}`
            : receipt.message}
        </p>
      )}
    </article>
  );
}

/**
 * 애드온의 분산처리 탭. 실행기는 SSH 탭에 이미 등록된 서버를 가리키고 실행기에만 필요한
 * 값(동시 자리 수·켜짐·메모)만 더한다(C21) — 주소·키를 여기서 다시 받지 않는다. 보낼
 * 프로젝트 폴더는 외부 공용 자리 도구가 어느 폴더의 검증 명령을 실행기로 보내도 되는지를
 * 정한다. 앱은 설정만 저장하고, 명령을 보내는 것은 그 도구다.
 *
 * 변경은 모두 한 줄 단위 명령이다(켜짐만, 프로젝트 한 줄만). 화면이 들고 있던 목록 전체를
 * 되보내면 다른 화면이 그 사이 고친 줄을 낡은 값으로 덮는다.
 */
export function RunnersCard({ active, openTab }: { active: boolean; openTab?: (tab: "ssh") => void }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [snapshot, setSnapshot] = useState<RunnersSnapshot | null>(null);
  const { busy, error, setError, run: runAction } = useBusyAction();
  const [draft, setDraft] = useState<RunnerDraft | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft | null>(null);
  const [receipts, setReceipts] = useState<Record<string, RunnerCheckReceipt>>({});
  const loadedRef = useRef(false);

  // 목록을 고치는 응답은 마지막에 시작한 요청 것만 반영한다(DbConnectionsCard와 같은 이유).
  const [snapshotGate] = useState(createLatestGate);
  const applyLatest = useCallback(async (request: Promise<RunnersSnapshot>) => {
    const isCurrent = snapshotGate.begin();
    const next = await request;
    if (isCurrent()) setSnapshot(next);
  }, [snapshotGate]);

  const load = useCallback(async () => {
    const isCurrent = snapshotGate.begin();
    try {
      const next = await listRunners();
      if (!isCurrent()) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (isCurrent()) setError(errorText(cause));
    }
  }, [snapshotGate, setError]);

  useEffect(() => {
    if (!active) { loadedRef.current = false; return; }
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load();
  }, [active, load]);

  const run = async (token: string, action: () => Promise<void>) => {
    if (busy !== null) return;
    await runAction(token, action);
  };

  /** 아직 실행기가 아닌 서버. 편집 중인 실행기는 자기 서버를 계속 고를 수 있다. */
  const freeServers = (snapshot?.sshServers ?? []).filter((server) =>
    !snapshot?.runners.some((runner) => runner.serverId === server.id && runner.id !== draft?.id));

  const openEditor = (runner: RunnerView | null) => {
    if (!snapshot) return;
    setDraft(runner
      ? {
        id: runner.id,
        // 서버가 지워졌으면 빈 선택으로 두어 다시 고르게 한다 — 남은 id로는 저장되지 않는다.
        serverId: runner.serverFound ? runner.serverId : "",
        serverMissing: !runner.serverFound,
        name: runner.name,
        slots: String(runner.slots),
        browsers: String(runner.browsers ?? 0),
        enabled: runner.enabled,
        note: runner.note,
      }
      : {
        id: "",
        serverId: snapshot.sshServers.find((server) => !snapshot.runners.some((runner) => runner.serverId === server.id))?.id ?? "",
        serverMissing: false,
        name: "",
        slots: String(snapshot.defaultSlots),
        browsers: "0",
        enabled: true,
        note: "",
      });
  };

  // 두 숫자 칸은 같은 규칙으로 받는다(runnerFields). `parseInt` 는 `1e1`·`3.5` 를 1·3 으로 받아
  // 사용자가 본 값과 다른 값을 저장했다.
  const slotsValid = (value: string) => snapshot !== null && wholeNumberWithin(value, snapshot.minSlots, snapshot.maxSlots);
  // 화면만 새 판이고 백엔드가 아직 옛 판이면 maxBrowsers 칸이 없다 — 그때는 칸을 숨기고 저장에서 뺀다.
  // 저장 형식의 끝(u32 최대)이면 상한이 없다는 뜻이라 안내를 "0 이상"으로 바꾼다.
  const browsersSupported = snapshot !== null && snapshot.maxBrowsers !== undefined;
  const maxBrowsers = snapshot?.maxBrowsers ?? U32_MAX;
  const browsersUnbounded = maxBrowsers >= U32_MAX;
  const browsersValid = (value: string) => !browsersSupported || wholeNumberWithin(value, 0, maxBrowsers);

  const save = () => run("save", async () => {
    if (!draft) return;
    const slots = parseWholeNumber(draft.slots);
    const browsers = parseWholeNumber(draft.browsers);
    // 저장 버튼이 판정을 통과한 값만 받지만, 값이 아니면 여기서도 보내지 않는다.
    if (slots === null || (browsersSupported && browsers === null)) return;
    await applyLatest(saveRunner({
      id: draft.id || null,
      serverId: draft.serverId,
      name: draft.name.trim(),
      slots,
      ...(browsersSupported && browsers !== null ? { browsers } : {}),
      enabled: draft.enabled,
      note: draft.note.trim(),
    }));
    setDraft(null);
  });

  const toggle = (runner: RunnerView) => run(`toggle:${runner.id}`, async () => {
    await applyLatest(setRunnerEnabled(runner.id, !runner.enabled));
  });

  const check = (runner: RunnerView) => run(`check:${runner.id}`, async () => {
    const receipt = await checkRunner(runner.id);
    setReceipts((current) => ({ ...current, [runner.id]: receipt }));
  });

  const remove = (runner: RunnerView) => run(`remove:${runner.id}`, async () => {
    const ok = await confirm({
      title: text("실행기를 삭제할까요?", "Remove this runner?"),
      message: text(
        `${runner.name} 실행기 설정만 지웁니다. SSH 탭의 서버와 키는 그대로입니다.`,
        `Removes only the ${runner.name} runner settings. The SSH server and key stay as they are.`,
      ),
      confirmLabel: text("삭제", "Remove"),
      tone: "danger",
    });
    if (!ok) return;
    await applyLatest(deleteRunner(runner.id));
    if (draft?.id === runner.id) setDraft(null);
  });

  const openProjectEditor = (project: RunnerProject | null) => {
    setProjectDraft(project
      ? { id: project.id, name: project.name, root: project.root, exclude: project.exclude.join(", ") }
      : { id: "", name: "", root: "", exclude: "" });
  };

  const saveProject = () => run("project-save", async () => {
    if (!projectDraft) return;
    const input = {
      id: projectDraft.id || null,
      name: projectDraft.name.trim(),
      root: projectDraft.root.trim(),
      exclude: excludeList(projectDraft.exclude),
    };
    await applyLatest(projectDraft.id ? updateRunnerProject(input) : addRunnerProject(input));
    setProjectDraft(null);
  });

  const removeProject = (project: RunnerProject) => run(`project-remove:${project.id}`, async () => {
    const ok = await confirm({
      title: text("프로젝트 폴더를 목록에서 뺄까요?", "Remove this project folder?"),
      message: text(
        `${project.name} 폴더의 검증 명령은 더 이상 실행기로 보내지 않습니다. 폴더 자체는 그대로입니다.`,
        `Verification commands from ${project.name} will no longer go to runners. The folder itself is unchanged.`,
      ),
      confirmLabel: text("빼기", "Remove"),
      tone: "danger",
    });
    if (!ok) return;
    await applyLatest(deleteRunnerProject(project.id));
    if (projectDraft?.id === project.id) setProjectDraft(null);
  });

  const selectedServer = snapshot?.sshServers.find((server) => server.id === draft?.serverId) ?? null;
  const serverHint = draft?.serverMissing && !draft.serverId
    ? text("가리키던 SSH 서버가 지워졌습니다. 서버를 다시 고르세요.", "The SSH server this runner pointed at was removed. Pick a server again.")
    : selectedServer !== null && !selectedServer.agentEnabled && text(
      "이 서버는 에이전트 사용이 꺼져 있어 회차가 쓰지 않습니다. SSH 탭에서 켜세요.",
      "Agent use is off for this server, so rounds will skip it. Turn it on in the SSH tab.",
    );

  return (
    <section className="settings-card db-connections-card" data-ui-anchor="addons.runners-content">
      <header>
        <div className="plugin-page-title">
          <i><Network size={18} aria-hidden="true" /></i>
          <div><span>{text("분산처리", "Distributed runners")}</span><h2>{text("실행기", "Runners")}</h2></div>
        </div>
        <p>{text(
          "이 화면은 설정만 저장합니다. 외부 도구(예: 공용 자리 도구)가 이 목록을 읽어, 아래 프로젝트 폴더의 순수 검증 명령(설치·빌드·시험)만 실행기로 보냅니다. 실행기가 꺼져 있거나 닿지 않으면 그 도구가 정한 다른 자리에서 돕니다. 실행기는 SSH 탭에 등록한 서버를 고르고, 그 서버의 에이전트 사용이 켜져 있어야 쓰입니다.",
          "This screen only stores settings. An external tool (for example, the shared slot tool) reads this list and sends only pure verification commands (install, build, test) from the project folders below to runners. If a runner is off or unreachable, the work runs wherever that tool decides instead. A runner is a server registered in the SSH tab, and it is used only while that server's agent use is on.",
        )}</p>
      </header>
      {error && <ErrorBanner message={error} />}
      {snapshot === null
        ? <div className="plugin-loading-state">{!error && <LoaderCircle size={16} className="spin" />}<span>{text("실행기를 확인하는 중…", "Checking runners…")}</span></div>
        : <>
          <div className="ssh-key-location">
            <span><strong>{text("등록된 실행기", "Registered")}</strong><code>{snapshot.runners.length}</code></span>
            <button className="button compact" type="button" disabled={busy !== null} onClick={() => void load()}><RefreshCw size={13} />{text("새로고침", "Refresh")}</button>
          </div>
          {snapshot.runners.length === 0
            ? <div className="plugin-empty-state"><i><Network size={25} /></i><div><strong>{text("등록된 실행기가 없습니다", "No runners yet")}</strong><small>{text("SSH 탭에 등록한 서버를 골라 실행기로 추가합니다.", "Add a server registered in the SSH tab as a runner.")}</small></div></div>
            : <div className="plugin-list db-connection-list">
              {snapshot.runners.map((runner) => (
                <RunnerRow
                  key={runner.id}
                  runner={runner}
                  receipt={receipts[runner.id]}
                  busy={busy}
                  onToggle={() => void toggle(runner)}
                  onCheck={() => void check(runner)}
                  onEdit={() => openEditor(runner)}
                  onRemove={() => void remove(runner)}
                />
              ))}
            </div>}
          {snapshot.issues.map((issue) => <p key={issue} className="db-connection-receipt failed">{issue}</p>)}
          {draft === null
            ? <div className="settings-update-body">
              <span className="settings-update-status">
                <strong>{text("새 실행기", "New runner")}</strong>
                <small>{freeServers.length === 0
                  ? text("먼저 SSH 탭에서 서버를 등록하세요", "Register a server in the SSH tab first")
                  : text("SSH 탭에 등록한 서버를 고르고 동시 자리 수를 정합니다.", "Pick a server from the SSH tab and set how many jobs it runs at once.")}</small>
              </span>
              {freeServers.length === 0
                ? openTab && <button className="button compact" type="button" onClick={() => openTab("ssh")}>{text("SSH 탭 열기", "Open SSH tab")}</button>
                : <button className="button compact primary" type="button" data-ui-anchor="addons.runners.add" disabled={busy !== null} onClick={() => openEditor(null)}><Plus size={13} />{text("실행기 추가", "Add runner")}</button>}
            </div>
            : <div className="db-connection-editor">
              <Field label={text("SSH 서버", "SSH server")} hint={serverHint}>
                <select value={draft.serverId} onChange={(event) => setDraft({ ...draft, serverId: event.target.value })}>
                  {(draft.serverId === "" || freeServers.length === 0) && <option value="">{text("— 서버를 고르세요 —", "— Pick a server —")}</option>}
                  {freeServers.map((server) => <option key={server.id} value={server.id}>{serverLabel(server)}</option>)}
                </select>
              </Field>
              <Field label={text("이름", "Name")} hint={text("영문·숫자·.·_·- 만 씁니다. 비우면 SSH 서버 이름(없으면 호스트)으로 정합니다.", "Letters, digits, . _ - only. Leave empty to use the SSH server name (or its host).")}>
                <input value={draft.name} maxLength={64} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              </Field>
              <Field label={text("동시 자리 수", "Slots")} hint={text(`${snapshot.minSlots}~${snapshot.maxSlots}. 이 실행기에서 한꺼번에 돌릴 작업 수입니다.`, `${snapshot.minSlots}–${snapshot.maxSlots}. How many jobs this runner takes at once.`)}>
                <input type="number" min={snapshot.minSlots} max={snapshot.maxSlots} value={draft.slots} onChange={(event) => setDraft({ ...draft, slots: event.target.value })} />
              </Field>
              {browsersSupported && <Field label={text("브라우저 자리 수", "Browser slots")} hint={browsersUnbounded
                ? text("0 이상. 브라우저 시험(Cypress)을 한꺼번에 돌릴 수입니다. 하나에 메모리 1~2GB쯤 쓰므로 그 기계 메모리에 맞춰 정하세요. Cypress를 설치한 기계만 1 이상으로 두고, 0이면 보내지 않습니다.", "0 or more. How many browser tests (Cypress) run at once. Each uses about 1–2 GB of memory, so size it to the machine. Set 1 or more only on machines with Cypress installed; 0 sends none.")
                : text(`0~${maxBrowsers}. 브라우저 시험(Cypress)을 한꺼번에 돌릴 수입니다. Cypress를 설치한 기계만 1 이상으로 두세요. 0이면 보내지 않습니다.`, `0–${maxBrowsers}. How many browser tests (Cypress) run at once. Set 1 or more only on machines with Cypress installed; 0 sends none.`)}>
                <input type="number" min={0} max={browsersUnbounded ? undefined : maxBrowsers} value={draft.browsers} onChange={(event) => setDraft({ ...draft, browsers: event.target.value })} />
              </Field>}
              <label className="db-connection-toggle">
                <input type="checkbox" checked={draft.enabled} onChange={() => setDraft({ ...draft, enabled: !draft.enabled })} />
                <span>{text("사용", "Enabled")}</span>
              </label>
              <Field label={text("메모", "Note")}>
                <input value={draft.note} maxLength={200} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
              </Field>
              <div className="db-connection-editor-actions">
                <button className="button compact" type="button" onClick={() => setDraft(null)}>{text("취소", "Cancel")}</button>
                <button className="button compact primary" type="button" data-ui-anchor="addons.runners.save" disabled={!draft.serverId || !slotsValid(draft.slots) || !browsersValid(draft.browsers) || busy !== null} onClick={() => void save()}>{text("저장", "Save")}</button>
              </div>
            </div>}

          <div className="ssh-key-location">
            <span><strong>{text("보낼 프로젝트 폴더", "Project folders to send")}</strong><code>{snapshot.projects.length}</code></span>
          </div>
          {snapshot.projects.length === 0
            ? <div className="plugin-empty-state"><i><FolderGit2 size={25} /></i><div><strong>{text("등록된 폴더가 없습니다", "No folders yet")}</strong><small>{text("여기 적은 폴더의 검증 명령만 실행기로 갑니다.", "Only verification commands from folders listed here go to runners.")}</small></div></div>
            : <div className="plugin-list db-connection-list">
              {snapshot.projects.map((project) => (
                <article className="db-connection-row" key={project.id}>
                  <div className="db-connection-head"><strong>{project.name}</strong></div>
                  <code className="db-connection-target">{project.root}</code>
                  {project.exclude.length > 0 && <small className="db-connection-meta">{text("제외", "Excluded")}: {project.exclude.join(", ")}</small>}
                  <div className="db-connection-actions">
                    <button className="button compact" type="button" disabled={busy !== null} onClick={() => openProjectEditor(project)}>{text("편집", "Edit")}</button>
                    <button className="button compact danger" type="button" disabled={busy !== null} onClick={() => void removeProject(project)}><Trash2 size={13} />{text("삭제", "Remove")}</button>
                  </div>
                </article>
              ))}
            </div>}
          {projectDraft === null
            ? <div className="settings-update-body">
              <span className="settings-update-status">
                <strong>{text("새 프로젝트 폴더", "New project folder")}</strong>
                <small>{text("이 기계에 있는 절대 경로 폴더여야 합니다. 홈 자체·자격증명 폴더·앱 데이터(AIA 작업공간 하위 제외)는 쓸 수 없습니다.", "Must be an absolute path to a folder on this machine. Your home itself, credential folders and app data (except under the AIA workspace) are not allowed.")}</small>
              </span>
              <button className="button compact primary" type="button" data-ui-anchor="addons.runners.project-add" disabled={busy !== null} onClick={() => openProjectEditor(null)}><Plus size={13} />{text("폴더 추가", "Add folder")}</button>
            </div>
            : <div className="db-connection-editor">
              <Field label={text("이름", "Name")} hint={text("영문 소문자·숫자·.·_·- 만 씁니다. 예: dead-route-game", "Lowercase letters, digits, . _ - only. e.g. dead-route-game")}>
                <input value={projectDraft.name} maxLength={64} placeholder="dead-route-game" onChange={(event) => setProjectDraft({ ...projectDraft, name: event.target.value })} />
              </Field>
              <Field label={text("폴더 경로", "Folder path")} hint={text("심볼릭 링크는 풀어서 저장합니다.", "Symbolic links are resolved before saving.")}>
                <input value={projectDraft.root} placeholder="/workspace/dead-route-game" onChange={(event) => setProjectDraft({ ...projectDraft, root: event.target.value })} />
              </Field>
              <Field label={text("제외 폴더", "Excluded folders")} hint={text("폴더 바로 아래 이름을 쉼표로 나눠 적습니다. 예: _land", "Names directly under the folder, comma-separated. e.g. _land")}>
                <input value={projectDraft.exclude} placeholder="_land" onChange={(event) => setProjectDraft({ ...projectDraft, exclude: event.target.value })} />
              </Field>
              <div className="db-connection-editor-actions">
                <button className="button compact" type="button" onClick={() => setProjectDraft(null)}>{text("취소", "Cancel")}</button>
                <button className="button compact primary" type="button" disabled={!projectDraft.name.trim() || !projectDraft.root.trim() || busy !== null} onClick={() => void saveProject()}>{text("저장", "Save")}</button>
              </div>
            </div>}
        </>}
      {confirmDialog}
    </section>
  );
}
