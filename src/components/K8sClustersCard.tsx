import { Boxes, LoaderCircle, Plus, PlugZap, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { checkK8sCluster, getK8sClusters, removeK8sCluster, setK8sCluster, setK8sClusterEnabled } from "../lib/ipc";
import { useI18n } from "../lib/i18n";
import type { DbEnvironment, K8sAuthKind, K8sClusterCheckReceipt, K8sClustersSnapshot, K8sClusterView, SetK8sClusterRequest } from "../types";
import { ErrorBanner, useBusyAction, useConfirm } from "./Shared";
import { errorText } from "../lib/errorText";
import { createLatestGate } from "../lib/latestRequest";

const ENVIRONMENT_LABELS_KO: Record<DbEnvironment, string> = { local: "로컬", dev: "개발", staging: "스테이징", production: "운영" };

/** 자격증명을 넣는 두 가지 길. kubeconfig 는 k3s·kubectl 이 주는 파일을 그대로 붙여 넣는다. */
type CredentialInput = "kubeconfig" | "fields";

interface K8sClusterDraft {
  id: string;
  displayName: string;
  environment: DbEnvironment;
  input: CredentialInput;
  kubeconfig: string;
  context: string;
  server: string;
  caPem: string;
  authKind: K8sAuthKind;
  token: string;
  clientCertificatePem: string;
  clientKeyPem: string;
  namespaces: string;
  note: string;
}

function draftOf(cluster: K8sClusterView | null): K8sClusterDraft {
  return {
    id: cluster?.id ?? "",
    displayName: cluster?.displayName ?? "",
    environment: cluster?.environment ?? "dev",
    // 이미 저장된 클러스터는 자격증명을 다시 넣지 않아도 고칠 수 있게 직접 입력으로 연다.
    input: cluster ? "fields" : "kubeconfig",
    kubeconfig: "",
    context: "",
    server: cluster?.server ?? "",
    caPem: cluster?.caPem ?? "",
    authKind: cluster?.authKind ?? "token",
    token: "",
    clientCertificatePem: "",
    clientKeyPem: "",
    namespaces: cluster?.namespaces.join("\n") ?? "",
    note: cluster?.note ?? "",
  };
}

/** 빈 칸은 "바꾸지 않음"이라 null 로 보낸다. 백엔드는 null 이면 저장된 자격증명을 그대로 둔다. */
function orNull(value: string): string | null {
  return value.trim() === "" ? null : value;
}

function toRequest(draft: K8sClusterDraft): SetK8sClusterRequest {
  // 편집 중 kubeconfig 칸을 비워 두면 "자격증명은 그대로, 나머지만 고침"이다. 그때는 열 때
  // 채워 둔 서버·CA 를 보내야 백엔드가 같은 클러스터로 알아본다.
  const kubeconfig = draft.input === "kubeconfig" && draft.kubeconfig.trim() !== "";
  return {
    id: draft.id,
    displayName: draft.displayName,
    environment: draft.environment,
    kubeconfig: kubeconfig ? orNull(draft.kubeconfig) : null,
    context: kubeconfig ? draft.context.trim() : "",
    server: kubeconfig ? "" : draft.server,
    caPem: kubeconfig ? "" : draft.caPem,
    authKind: draft.authKind,
    token: kubeconfig || draft.authKind !== "token" ? null : orNull(draft.token),
    clientCertificatePem: kubeconfig || draft.authKind !== "clientCertificate" ? null : orNull(draft.clientCertificatePem),
    clientKeyPem: kubeconfig || draft.authKind !== "clientCertificate" ? null : orNull(draft.clientKeyPem),
    namespaces: draft.namespaces.split(/[\s,]+/).filter(Boolean),
    note: draft.note,
  };
}

function isDraftValid(draft: K8sClusterDraft): boolean {
  if (draft.displayName.trim() === "") return false;
  if (draft.input === "kubeconfig") return draft.kubeconfig.trim() !== "" || draft.id !== "";
  return draft.server.trim() !== "";
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label><span>{label}</span>{children}{hint ? <small>{hint}</small> : null}</label>;
}

function CheckReceipt({ receipt }: { receipt: K8sClusterCheckReceipt }) {
  const { text } = useI18n();
  if (!receipt.reachable) return <p className="db-connection-receipt failed">{receipt.message}</p>;
  return (
    <div className="db-connection-receipt ok">
      <p>{text("연결 성공", "Connected")} — {receipt.serverVersion} ({receipt.platform})</p>
      {receipt.nodes.length > 0 && (
        <ul>
          {receipt.nodes.map((node) => (
            <li key={node.name}>
              <code>{node.name}</code> {node.ready ? "Ready" : "NotReady"} · {node.roles.join(",") || "worker"} · {node.architecture} · {node.kubeletVersion}{node.internalIp ? ` · ${node.internalIp}` : ""}
            </li>
          ))}
        </ul>
      )}
      <p>
        {text(`권한(${receipt.accessNamespace}): 규칙 ${receipt.access.length}개`, `Access in ${receipt.accessNamespace}: ${receipt.access.length} rule(s)`)}
      </p>
      {receipt.broadAccess && (
        <p className="db-connection-receipt failed">
          <TriangleAlert size={13} /> {text(
            "이 계정은 모든 리소스를 바꿀 수 있습니다(cluster-admin 수준). 에이전트용으로는 네임스페이스를 좁힌 ServiceAccount 토큰을 권합니다.",
            "This account can change every resource (cluster-admin level). Prefer a namespace-scoped ServiceAccount token for agents.",
          )}
        </p>
      )}
      {/* 노드·권한 조회 중 하나가 실패했을 때만 백엔드가 진단을 싣는다. */}
      {(receipt.nodes.length === 0 || receipt.access.length === 0) && receipt.message && <p>{receipt.message}</p>}
    </div>
  );
}

function ClusterRow({ cluster, receipt, busy, onToggle, onCheck, onEdit, onRemove }: {
  cluster: K8sClusterView;
  receipt: K8sClusterCheckReceipt | null;
  busy: string | null;
  onToggle: () => void;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { text } = useI18n();
  return (
    <article className="db-connection-row" data-environment={cluster.environment}>
      <div className="db-connection-head">
        <strong>{cluster.displayName}</strong>
        <span className={`db-badge db-badge-${cluster.environment}`}>{text(ENVIRONMENT_LABELS_KO[cluster.environment], cluster.environment)}</span>
        <span className="db-badge">{cluster.authKind === "token" ? text("토큰", "Token") : text("클라이언트 인증서", "Client certificate")}</span>
        <span className="db-badge">{text("읽기 전용", "Read only")}</span>
      </div>
      <code className="db-connection-target">{cluster.server}</code>
      <small className="db-connection-meta">
        {cluster.credentialStoredAt ? text("자격증명 저장됨", "Credential stored") : text("자격증명 미저장", "No credential yet")}
        {` · ${cluster.caFingerprint ? `CA ${cluster.caFingerprint.slice(0, 23)}…` : text("OS 기본 CA", "System CA")}`}
        {` · ${cluster.namespaces.length > 0 ? `${text("범위", "Scope")} ${cluster.namespaces.join(", ")}` : text("모든 네임스페이스", "All namespaces")}`}
      </small>
      <div className="db-connection-actions">
        <label className="db-connection-toggle">
          <input type="checkbox" checked={cluster.agentEnabled} disabled={busy !== null} onChange={() => onToggle()} />
          <span>{text("에이전트 사용", "Agent use")}</span>
        </label>
        <button className="button compact" type="button" disabled={busy !== null} onClick={() => onCheck()}>
          {busy === `check:${cluster.id}` ? <LoaderCircle size={13} className="spin" /> : <PlugZap size={13} />}{text("연결 확인", "Check")}
        </button>
        <button className="button compact" type="button" disabled={busy !== null} onClick={() => onEdit()}>{text("편집", "Edit")}</button>
        <button className="button compact danger" type="button" disabled={busy !== null} onClick={() => onRemove()}><Trash2 size={13} />{text("삭제", "Remove")}</button>
      </div>
      {receipt?.id === cluster.id && <CheckReceipt receipt={receipt} />}
    </article>
  );
}

function ClusterEditor({ draft, snapshot, busy, patchDraft, onCancel, onSave }: {
  draft: K8sClusterDraft;
  snapshot: K8sClustersSnapshot;
  busy: string | null;
  patchDraft: (patch: Partial<K8sClusterDraft>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { text } = useI18n();
  const editing = draft.id !== "";
  const keepHint = editing ? text("비워 두면 저장된 값을 그대로 씁니다.", "Leave empty to keep the stored value.") : undefined;
  const input = (key: keyof K8sClusterDraft) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    patchDraft({ [key]: event.target.value } as Partial<K8sClusterDraft>);
  return (
    <div className="db-connection-editor">
      <Field label={text("이름", "Name")}><input value={draft.displayName} maxLength={60} placeholder="OCI k3s" onChange={input("displayName")} /></Field>
      <Field label={text("환경", "Environment")}>
        <select value={draft.environment} onChange={input("environment")}>
          {snapshot.defaults.environments.map((value) => <option key={value} value={value}>{text(ENVIRONMENT_LABELS_KO[value] ?? value, value)}</option>)}
        </select>
      </Field>
      <Field label={text("자격증명 입력", "Credential input")}>
        <select value={draft.input} onChange={input("input")}>
          <option value="kubeconfig">{text("kubeconfig 붙여넣기", "Paste kubeconfig")}</option>
          <option value="fields">{text("API 서버·CA·토큰 직접 입력", "Enter server, CA and token")}</option>
        </select>
      </Field>
      {draft.input === "kubeconfig"
        ? <>
          <Field
            label="kubeconfig"
            hint={text(
              "k3s 는 /etc/rancher/k3s/k3s.yaml 이고, server 주소를 127.0.0.1 대신 이 기기에서 닿는 주소(Tailscale IP 등)로 바꿔 넣으세요. 파일 경로·exec 인증은 받지 않습니다. 원문은 저장하지 않고 서버·CA·자격증명만 뽑아 OS 보안 저장소에 둡니다.",
              "For k3s use /etc/rancher/k3s/k3s.yaml with the server changed from 127.0.0.1 to an address this device can reach. File paths and exec auth are refused. The text is not stored — only the server, CA and credential are kept, the credential in the OS secure store.",
            )}
          >
            <textarea rows={8} value={draft.kubeconfig} spellCheck={false} autoComplete="off" placeholder={editing ? text("새 kubeconfig 로 바꿀 때만 넣으세요", "Only to replace with a new kubeconfig") : "apiVersion: v1\nclusters:\n- cluster:\n    server: https://…:6443"} onChange={input("kubeconfig")} />
          </Field>
          <Field label={text("context (선택)", "Context (optional)")} hint={text("비우면 current-context 를 씁니다.", "Empty uses current-context.")}>
            <input value={draft.context} onChange={input("context")} />
          </Field>
        </>
        : <>
          <Field label={text("API 서버 주소", "API server")}><input value={draft.server} placeholder="https://100.x.y.z:6443" onChange={input("server")} /></Field>
          <Field label={text("CA 인증서(PEM)", "CA certificate (PEM)")} hint={text("비우면 OS 기본 신뢰 저장소를 씁니다.", "Empty uses the system trust store.")}>
            <textarea rows={4} value={draft.caPem} spellCheck={false} onChange={input("caPem")} />
          </Field>
          <Field label={text("인증 방식", "Authentication")}>
            <select value={draft.authKind} onChange={input("authKind")}>
              <option value="token">{text("Bearer 토큰(ServiceAccount)", "Bearer token (ServiceAccount)")}</option>
              <option value="clientCertificate">{text("클라이언트 인증서", "Client certificate")}</option>
            </select>
          </Field>
          {draft.authKind === "token"
            ? <Field label={text("토큰", "Token")} hint={keepHint}><input type="password" autoComplete="new-password" value={draft.token} onChange={input("token")} /></Field>
            : <>
              <Field label={text("클라이언트 인증서(PEM)", "Client certificate (PEM)")} hint={keepHint}><textarea rows={4} spellCheck={false} value={draft.clientCertificatePem} onChange={input("clientCertificatePem")} /></Field>
              <Field label={text("클라이언트 개인키(PEM)", "Client key (PEM)")} hint={keepHint}><textarea rows={4} spellCheck={false} autoComplete="off" value={draft.clientKeyPem} onChange={input("clientKeyPem")} /></Field>
            </>}
        </>}
      <Field label={text("네임스페이스 범위", "Namespace scope")} hint={text("한 줄에 하나. 비우면 모든 네임스페이스를 읽을 수 있습니다.", "One per line. Empty allows every namespace.")}>
        <textarea rows={3} value={draft.namespaces} spellCheck={false} onChange={input("namespaces")} />
      </Field>
      <Field label={text("메모", "Note")}><input value={draft.note} maxLength={200} onChange={input("note")} /></Field>
      <div className="db-connection-editor-actions">
        <button className="button compact" type="button" onClick={() => onCancel()}>{text("취소", "Cancel")}</button>
        <button className="button compact primary" type="button" disabled={!isDraftValid(draft) || busy !== null} onClick={() => onSave()}>{text("저장", "Save")}</button>
      </div>
    </div>
  );
}

/**
 * 애드온의 Kubernetes 탭(C22). 클러스터를 등록하고 에이전트에게 읽기를 열어 주는 자리다.
 *
 * 저장된 토큰·키는 어느 응답으로도 돌아오지 않으므로 입력칸은 언제나 비어 있고, 저장돼
 * 있다는 사실만 표시한다. 지금은 읽기 전용이라 쓰기 모드 칸이 없다.
 */
export function K8sClustersCard({ active }: { active: boolean }) {
  const { text } = useI18n();
  const { confirm, confirmDialog } = useConfirm();
  const [snapshot, setSnapshot] = useState<K8sClustersSnapshot | null>(null);
  const { busy, error, setError, run: runAction } = useBusyAction();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<K8sClusterDraft>(draftOf(null));
  const [receipt, setReceipt] = useState<K8sClusterCheckReceipt | null>(null);
  const loadedRef = useRef(false);
  const patchDraft = (patch: Partial<K8sClusterDraft>) => setDraft((current) => ({ ...current, ...patch }));

  // DbConnectionsCard 와 같은 이유로 마지막에 시작한 요청의 목록만 반영한다.
  const [snapshotGate] = useState(createLatestGate);
  const applyLatest = useCallback(async (request: Promise<K8sClustersSnapshot>) => {
    const isCurrent = snapshotGate.begin();
    const next = await request;
    if (isCurrent()) setSnapshot(next);
  }, [snapshotGate]);

  const load = useCallback(async () => {
    const isCurrent = snapshotGate.begin();
    try {
      const next = await getK8sClusters();
      if (!isCurrent()) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (isCurrent()) setError(errorText(cause));
    }
  }, [snapshotGate]);

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

  const openEditor = (cluster: K8sClusterView | null) => {
    setEditing(cluster ? cluster.id : "new");
    setDraft(draftOf(cluster));
    setReceipt(null);
  };

  const save = () => run("save", async () => {
    await applyLatest(setK8sCluster(toRequest(draft)));
    setEditing(null);
  });

  const toggle = (cluster: K8sClusterView) => run(`toggle:${cluster.id}`, async () => {
    await applyLatest(setK8sClusterEnabled({ id: cluster.id, enabled: !cluster.agentEnabled }));
  });

  const check = (cluster: K8sClusterView) => run(`check:${cluster.id}`, async () => {
    setReceipt(await checkK8sCluster({ id: cluster.id }));
  });

  const remove = (cluster: K8sClusterView) => run(`remove:${cluster.id}`, async () => {
    const ok = await confirm({
      title: text("클러스터를 삭제할까요?", "Remove this cluster?"),
      message: text(
        `${cluster.displayName} 등록과 이 기기에 저장된 토큰·키를 함께 지웁니다. 클러스터 자체는 바뀌지 않습니다.`,
        `Removes ${cluster.displayName} and the token or key stored on this device. The cluster itself is unchanged.`,
      ),
      warning: text("이 기기에 저장된 자격증명은 되돌릴 수 없습니다.", "A credential stored on this device cannot be restored."),
      confirmLabel: text("삭제", "Remove"),
      tone: "danger",
    });
    if (!ok) return;
    await applyLatest(removeK8sCluster({ id: cluster.id }));
    if (editing === cluster.id) setEditing(null);
  });

  return (
    <section className="settings-card db-connections-card" data-ui-anchor="addons.k8s-content">
      <header>
        <div className="plugin-page-title">
          <i><Boxes size={18} aria-hidden="true" /></i>
          <div><span>Kubernetes</span><h2>{text("클러스터 관리", "Clusters")}</h2></div>
        </div>
        <p>{text(
          "k3s·GKE·OKE 같은 클러스터를 등록하면 에이전트가 파드·배포·로그·이벤트를 읽을 수 있습니다. kubeconfig 와 토큰은 에이전트에게 넘어가지 않고 앱이 대신 API 를 부릅니다. Secret 값과 비밀꼴 환경 변수는 가려서 보여 주며, 지금은 읽기만 합니다.",
          "Register a k3s, GKE or OKE cluster and agents can read pods, deployments, logs and events. The kubeconfig and token never reach the agent — the app calls the API on its behalf. Secret values and secret-looking env values are masked. Read only for now.",
        )}</p>
      </header>
      {error && <ErrorBanner message={error} />}
      {snapshot === null
        ? <div className="plugin-loading-state">{!error && <LoaderCircle size={16} className="spin" />}<span>{text("클러스터를 확인하는 중…", "Checking clusters…")}</span></div>
        : <>
          <div className="ssh-key-location">
            <span><strong>{text("등록된 클러스터", "Registered")}</strong><code>{snapshot.clusters.length}</code></span>
            <button className="button compact" type="button" disabled={busy !== null} onClick={() => void load()}><RefreshCw size={13} />{text("새로고침", "Refresh")}</button>
          </div>
          {snapshot.clusters.length === 0
            ? <div className="plugin-empty-state"><i><Boxes size={25} /></i><div><strong>{text("등록된 클러스터가 없습니다", "No clusters yet")}</strong><small>{text("클러스터를 등록하고 에이전트 사용을 켜야 에이전트가 읽을 수 있습니다.", "Register a cluster and turn on agent use before an agent can read it.")}</small></div></div>
            : <div className="plugin-list db-connection-list">
              {snapshot.clusters.map((cluster) => (
                <ClusterRow
                  key={cluster.id}
                  cluster={cluster}
                  receipt={receipt}
                  busy={busy}
                  onToggle={() => void toggle(cluster)}
                  onCheck={() => void check(cluster)}
                  onEdit={() => openEditor(cluster)}
                  onRemove={() => void remove(cluster)}
                />
              ))}
            </div>}
          {snapshot.issues.map((issue) => <p key={issue} className="db-connection-receipt failed">{issue}</p>)}
          {editing === null
            ? <div className="settings-update-body">
              <span className="settings-update-status"><strong>{text("새 클러스터", "New cluster")}</strong><small>{text("kubeconfig 를 붙여 넣거나 API 서버·CA·토큰을 넣고, 에이전트가 읽을 네임스페이스를 정합니다.", "Paste a kubeconfig or enter the server, CA and token, then choose which namespaces agents may read.")}</small></span>
              <button className="button compact primary" type="button" data-ui-anchor="addons.k8s.add" onClick={() => openEditor(null)}><Plus size={13} />{text("클러스터 추가", "Add cluster")}</button>
            </div>
            : <ClusterEditor
              draft={draft}
              snapshot={snapshot}
              busy={busy}
              patchDraft={patchDraft}
              onCancel={() => setEditing(null)}
              onSave={() => void save()}
            />}
        </>}
      {confirmDialog}
    </section>
  );
}
